# 02. `cleanup.go` / `reclaim.go` / `map.go` 沙箱基础组件

> 路径: `packages/orchestrator/pkg/sandbox/`
> 职责: 沙箱的清理钩子、暂停前资源回收、live + network 双索引表。

---

## 1. `cleanup.go` — 清理链

### 1.1 数据结构

```go
type Cleanup struct {
    cleanup         []func(ctx context.Context) error  // 普通钩子
    priorityCleanup []func(ctx context.Context) error  // 优先级钩子
    error           error
    once            sync.Once
    hasRun          atomic.Bool
    mu              sync.Mutex
}
```

- `once` 保证 `Run` 只跑一次(对 `Cleanup` 整体幂等)。
- `hasRun` 用 atomic 让新加进来的钩子立即在 `Run` 之后被调,不会丢失。
- 顺序:**先 priority(后进先出),再普通(后进先出)**。

### 1.2 接口

```go
func NewCleanup() *Cleanup
func (c *Cleanup) Add(ctx, f func(ctx) error)
func (c *Cleanup) AddNoContext(ctx, f func() error)  // 包成 ctx 形式
func (c *Cleanup) AddPriority(ctx, f func(ctx) error)
func (c *Cleanup) Run(ctx) error
```

### 1.3 关键设计

- **`Add` 在 cleanup 跑过之后**:如果 `hasRun.Load() == true`,直接用 `context.WithoutCancel(ctx)` 同步跑该函数并 warn log。
- **`Run` 用 `context.WithoutCancel`** 把 ctx 剥离,避免父 ctx 取消导致清理自己被中断。
- **错误聚合**:所有错误 `errors.Join` 到 `c.error`,`Run` 一次性返回。

### 1.4 典型用法(在 `CreateSandbox` 中)

```go
cleanup := NewCleanup()
defer func() {
    if e != nil {
        cleanupErr := cleanup.Run(ctx)  // 失败时统一回滚
        e = errors.Join(e, cleanupErr)
    }
}()

lifecycleID := uuid.NewString()
ipsPromise := getNetworkSlot(ctx, f.networkPool, cleanup, config.Network, ...)
sandboxFiles := template.Files().NewSandboxFiles(runtime.SandboxID)
cleanup.Add(ctx, cleanupFiles(f.config, sandboxFiles))
...
```

注意 `Add` 顺序 = LIFO 反转执行,所以先 `Add` 的会**最后**执行。priority 反之——`AddPriority` 的先于 `Add` 执行。

### 1.5 辅助函数

```go
func cleanupFiles(config cfg.BuilderConfig, files *storage.SandboxFiles) func(ctx) error
```

清理三类文件:
- `SandboxFirecrackerSocketPath`
- `SandboxUffdSocketPath`
- `SandboxCacheRootfsLinkPath`

---

## 2. `reclaim.go` — 暂停前的最佳努力回收

### 2.1 触发点

`Sandbox.Pause` 入口处会调用 `s.bestEffortReclaim(ctx)`,在 `process.Pause` 之前。

### 2.2 配置

通过 `featureflags.GetReclaimConfig(ctx, s.featureFlags, ...)` 拿到每个步骤的 cap,默认 0 关闭:

| 步骤 | 字段 | 命令 |
|------|------|------|
| fstrim | `cfg.Fstrim` | `fstrim -av` |
| sync | `cfg.Sync` | `sync` |
| drop_caches | `cfg.DropCaches` | `echo 3 > /proc/sys/vm/drop_caches` |
| compact_memory | `cfg.CompactMemory` | `echo 1 > /proc/sys/vm/compact_memory` |

### 2.3 `buildReclaimScript`

```go
func (s *Sandbox) buildReclaimScript(cfg featureflags.ReclaimConfig) (string, time.Duration)
```

- 每个 cap < 1ms 的步骤被跳过(因为 `timeout 0.000` 会被 GNU timeout 当作无 timeout)。
- 全部跳过时返回 `("", 0)`,Pause 会直接退出。
- 拼成 `rc=0; timeout X fstrim ...; ...; exit $rc` 形式,通过 `StartEnvdSystemShell` 跑。
- 总超时 = 各步骤 cap 之和 + `reclaimOuterSlack`(500ms,涵盖 shell 启动 + envd round-trip)。

### 2.4 `bestEffortFreeze` / `bestEffortUnfreeze`

- 通过 `envdSupportsCgroupFreeze` 校验 `envd >= MinEnvdVersionForCgroupFreeze`。
- 用 `callEnvdFreeze` / `callEnvdUnfreeze` 调 `POST /freeze` / `/unfreeze`(`envd.go:callEnvdCgroupOp`)。
- `freezeTimeout = 2s`,独立于 reclaim shell 预算。
- **unfreeze 不在成功路径调用**(resume 时 `/init` 的 defer 会做);它只在 Pause 错误清理时用(`cleanup.Add` 注册),保证失败的 pause 不会留下永久冻结的 live VM。

### 2.5 关键设计取舍

- **fstrim 后 ext4 才发 TRIM**(`Sandbox.Create` 把 `rootflags=discard` 加进 kernel args),snapshot 之前回收,确保 diff 不包含已 free 的块。
- **顺序:fstrim → sync → drop_caches → compact_memory** —— 先回报文件系统,再让 page cache 和 slab 收缩,最后给匿名页一个机会。
- **失败不阻塞**:脚本非 0 退出、envd 流错误,都只 warn。

---

## 3. `map.go` — 沙箱索引

### 3.1 双 map 设计

```go
type Map struct {
    live    *smap.Map[*Sandbox]  // key: SandboxID
    network *smap.Map[*Sandbox]  // key: HostIP

    subs     []MapSubscriber
    subsLock sync.RWMutex
}
```

| 操作 | 走哪个 map | 用途 |
|------|-----------|------|
| `Get(id)` | live | `Get(sandboxID)` |
| `Items()` | live | 全量列举 |
| `Count()` | live | live 数量 |
| `GetByHostPort(ip:port)` | network | 网络入口按源 IP 找 sandbox |
| `AssignNetwork(sbx)` | network | 注册 IP,触发 `OnInsert` 是不触发的 |
| `MarkRunning(sbx)` | live | 暴露给上层 + 触发 `OnInsert` |
| `MarkStopping(id, lifecycleID)` | live | lifecycleID 守卫,真删 live |
| `NetworkReleased(ip)` | network | 异步通知,触发 `OnNetworkRelease` |

### 3.2 订阅者

```go
type MapSubscriber interface {
    OnInsert(ctx context.Context, sandbox *Sandbox)
    OnNetworkRelease(ctx context.Context, sbx *Sandbox)
}
```

- `Subscribe` append 到 `subs`,锁住 `subsLock`。
- `trigger` 在 RLock 下调用所有订阅者(订阅者必须非阻塞;长任务自己 dispatch)。

`OnNetworkRelease` 的常见用法:client-proxy 清掉它的 IP 路由缓存。

### 3.3 lifecycleID 守卫

```go
func (m *Map) MarkStopping(ctx, sandboxID, lifecycleID string) bool {
    stopped := false
    m.live.RemoveCb(sandboxID, func(_ string, sbx *Sandbox, exists bool) bool {
        if !exists { return false }
        if sbx.LifecycleID != lifecycleID { return false }  // 守卫
        stopped = true
        return true
    })
    return stopped
}
```

**为什么需要?** 同 SandboxID 短时内可能 resume 多次,旧 instance 的 cleanup goroutine 调 MarkStopping 时不能误删新 instance。

### 3.4 关联

- `Map.AssignNetwork` 在 `CreateSandbox`/`ResumeSandbox` 末尾 `MarkRunning` **之前**调用 —— 关键设计:先把 IP 挂上去,这样 `MarkRunning` 触发的 `OnInsert` 与 `network.Get(ip)` 看到一致状态。
- `MarkStopping` 在 cleanup 链注册,但真正在 cleanup.Run 时才执行(可以等异步资源先回收)。

---

## 4. 与本目录其他模块的协作

```
              CreateSandbox
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
   Map.AssignNetwork   cleanup.Add(...)  ┐
        │                     │           │  全部注册
        │             cleanup.AddPriority(sb.Stop) │
        │                     │           │
        ▼                     ▼           │
   f.Sandboxes.MarkRunning  (异步跑 FC)    │
                                   ...    │
                                          ▼
                                失败时:cleanup.Run 回滚
                                成功时:Close() 时 cleanup.Run
```

`reclaim` 只在 `Pause` 路径走,Cleanup 在所有路径(Cleanup、Stop、Close)都用,Map 单独服务于 client-proxy / API handler 的查询。
