# 03. `checks.go` / `health.go` / `metrics.go` / `hoststats*.go` 健康与统计

> 路径: `packages/orchestrator/pkg/sandbox/`
> 职责: 周期性检查 envd 是否存活、采集 sandbox 级指标、把 cgroup 资源采样投递到 ClickHouse。

---

## 1. `Checks` —— 健康检查调度器

### 1.1 字段

```go
type Checks struct {
    sandbox *Sandbox
    mu        sync.Mutex
    cancelCtx context.CancelCauseFunc
    stopped   bool                  // 标记 Stop 是否跑过
    healthy   atomic.Bool
    UseClickhouseMetrics bool
}
```

### 1.2 关键设计

#### 1.2.1 启动/停止的竞态

`Checks.Start` 在独立 goroutine 跑(`go sbx.Checks.Start(execCtx)`),但 `Stop` 可能在 Start 还没调度前就调用。`stopped` 标志就是为这种 race 设计的:

```go
func (c *Checks) Start(ctx context.Context) {
    c.mu.Lock()
    if c.stopped {
        c.mu.Unlock()
        return                       // Stop 已先跑,直接退出,不留泄漏的 health loop
    }
    ctx, c.cancelCtx = context.WithCancelCause(ctx)
    c.mu.Unlock()
    c.logHealth(ctx)
}
```

#### 1.2.2 状态变迁用 atomic.Bool + CompareAndSwap

```go
ok, err := c.getHealth(ctx, healthCheckTimeout)
if !ok && c.healthy.CompareAndSwap(true, false) {
    // 状态 healthy → unhealthy,记一次失败事件
    sbxlogger.E(c.sandbox).Healthcheck(ctx, sbxlogger.Fail)
}
if ok && c.healthy.CompareAndSwap(false, true) {
    // 状态 unhealthy → healthy,记一次恢复事件
    sbxlogger.E(c.sandbox).Healthcheck(ctx, sbxlogger.Success)
}
```

这样健康变迁事件在 ClickHouse 里**只记一次**(每次状态变化记一次),避免每 20s 一条。

#### 1.2.3 间隔与超时

```go
const (
    healthCheckInterval = 20 * time.Second
    healthCheckTimeout  = 100 * time.Millisecond
)
```

注意 timeout 远小于 interval,这是给 `getHealth` 自己 ——
- 用一个独立 timeout 包裹每次 HTTP 请求(每次新 context)。
- `startupStatsOnce` 保证在 `WaitForEnvd` 第一次成功后才把"envd 已就绪"的 metrics 计入,后续 Checks 不会让 startup 看起来更长。

### 1.3 `Checks.Stop`

只调 `c.cancelCtx(ErrChecksStopped)`,**不**等待 logHealth 退出。`logHealth` 的循环会自己看到 `ctx.Done()` 退出。

### 1.4 关联

- `Checks.Start` 由 `Factory.ResumeSandbox` 末尾的 `go sbx.Checks.Start(execCtx)` 调度。
- `Checks.Stop` 出现在:
  1. `Pause` 路径:`s.Checks.Stop()` → `process.Pause` → snapshot,避免 snapshot 期间误报 unhealthy。
  2. `Shutdown` 路径(同上)。
  3. `doStop` 路径:最先做,避免 FC 死后 healthcheck 报假阳性。

---

## 2. `health.go` —— 单次 HTTP /health 探测

```go
address := fmt.Sprintf("http://%s:%d/health", c.sandbox.Slot.HostIPString(), consts.DefaultEnvdServerPort)
request, _ := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
response, _ := sandboxHttpClient.Do(request)
...
if response.StatusCode != http.StatusNoContent { return false, ... }
return true, nil
```

- envd 端口 `consts.DefaultEnvdServerPort`(见 `packages/shared/pkg/consts`)。
- 期望 204 NoContent,任何其他状态码视为 unhealthy。
- Body 必须读完再关闭(`io.Copy(io.Discard, response.Body)`),否则 keep-alive TCP 连接不复用。
- `sandboxHttpClient` 是顶层 `sandbox.go` 声明的共享 HTTP 客户端,带 OTEL transport,10s 总超时,无 keep-alive。

---

## 3. `metrics.go` —— 拉 envd 暴露的 /metrics 端点

```go
type Metrics struct {
    Timestamp int64  `json:"ts"`
    CPUCount int64   `json:"cpu_count"`
    CPUUsedPercent float64 `json:"cpu_used_pct"`
    MemTotal, MemUsed, MemCache int64
    DiskUsed, DiskTotal int64
    // Deprecated:
    MemTotalMiB, MemUsedMiB int64
}
```

`GetMetrics(ctx, timeout)`:
- 同 /health 模式,带 `X-Access-Token`(若配置)。
- 期望 200,反序列化 JSON。

> 注意 `Checks` 的 20s 周期**不**调用 /metrics。`/metrics` 是给 API 层的"用户态指标"用的(展示给 client 用),而 host stats 是后台主动推到 ClickHouse。

---

## 4. `hoststats.go` + `hoststats_collector.go` —— 后台 cgroup 采样

### 4.1 入口 `initializeHostStatsCollector`

```go
func initializeHostStatsCollector(ctx, sbx, runtime, config, hostStatsDelivery, samplingInterval)
```

- 解析 `runtime.TeamID` 为 `uuid.UUID`(解析失败用零值,warn)。
- 装配 `HostStatsCollector`:
  ```go
  collector := NewHostStatsCollector(
      HostStatsMetadata{...},
      hostStatsDelivery,
      samplingInterval,
      sbx.cgroupHandle.GetStats,   // cgroupStats 是 closure
  )
  sbx.hostStatsCollector = collector
  go collector.Start(ctx)
  ```
- `samplingInterval` 由 LD flag `HostStatsSamplingInterval` 决定(毫秒),最低 100ms 硬限。

### 4.2 `HostStatsCollector`

```go
type HostStatsCollector struct {
    metadata HostStatsMetadata
    delivery hoststats.Delivery
    samplingInterval time.Duration
    cgroupStats CgroupStatsFunc
    prev hoststats.SandboxHostStat  // 上一次样本(用于算 delta)
    stopCh, stoppedCh chan struct{}
    stopOnce sync.Once
}
```

### 4.3 关键设计

#### 4.3.1 零基线优先入队

`Start` 入口会立刻 push 一行 `prev.Timestamp` 时刻的零基线(全部计数为 0,只填 metadata),这样:
- 第一次真实 tick 算 delta 时不会丢失"启动到第一次 tick 之间"的累计。
- 如果 delivery 是 ClickHouse 之类的下游,有完整的"启动-第一次采样"序列。

#### 4.3.2 饱和小减

```go
func saturatingSub(a, b uint64) uint64 {
    if a < b { return 0 }
    return a - b
}
```

cgroup 计数在 resume 后会重置(新 cgroup 或被换出),无符号减会下溢成超大值。`saturatingSub` 保证不会脏数据。

#### 4.3.3 Stop 时取最后一帧

`Stop` 用 `stopOnce.Do` 关 `stopCh`,等 `stoppedCh`,**然后**取一次 final sample(此时 cgroup 还在):

```go
func (h *HostStatsCollector) Stop(ctx context.Context) {
    h.stopOnce.Do(func() {
        close(h.stopCh)
        <-h.stoppedCh
        if err := h.CollectSample(ctx); err != nil {
            logger.L().Error(ctx, "failed to collect final host stats sample", ...)
        }
    })
}
```

为什么不直接交给 Start 的 `defer`?——Start 的 ctx 可能已被 cancel。`Stop(ctx)` 接收一个独立 ctx(由调用方传),可能是 `Cleanup` 的 `context.WithoutCancel(ctx)`,所以最后一帧能采到。

### 4.4 与 sandbox 生命周期绑定

- `Create`/`Resume` 在构造 sandbox 后 `initializeHostStatsCollector`。
- `Cleanup` 注册 `sbx.hostStatsCollector.Stop(ctx)` —— 在 cgroup 还在时跑最后一帧。
- 错误只 log,不 fail 沙箱关闭。

---

## 5. 与其他模块的关系

```
sandbox.go CreateSandbox / ResumeSandbox
  └─ initializeHostStatsCollector
        └─ collector.Start(go routine)
              └─ CollectSample → delivery.Push (ClickHouse)

Sandbox.Pause (暂停前)
  └─ bestEffortReclaim (会 flush drop_caches,影响 cgroup memory)
  └─ Checks.Stop
  └─ process.Pause / DrainBalloon

Sandbox.doStop (运行时停)
  └─ Checks.Stop             ← 先停,避免假阳性
  └─ process.Stop
  └─ memory.Stop
  └─ cleanup.Run(包含 hostStatsCollector.Stop)
```

---

## 6. 常见误解

- `Checks` 看到的 "unhealthy" 不一定意味着 sandbox 死掉 —— 网络瞬时抖动也会被记。线上要结合 `process.Exit.Done()` 和 `exit.Error()` 判断。
- `hostStatsCollector` 的 `samplingInterval` 100ms 下限是写死的,即使 LD flag 给 0 也会被 clamp。
- `Checks` 失败时把错误 `zap.Error(err)` 出来,但 ClickHouse 事件类型是 `sbxlogger.Fail`/`Success`(看 sbxlogger 的实现)。
