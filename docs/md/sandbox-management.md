# Sandbox 管理详解

> 本文聚焦 E2B Orchestrator 中 **sandbox 的"管理面"**（lifecycle、注册表、健康检查、清理、回收、gRPC 接口、优雅关闭）。如需创建/暂停/恢复的状态机时序，请配合阅读 `docs/sandbox-lifecycle.md`。
>
> 代码位置：`packages/orchestrator/pkg/sandbox/`、`packages/orchestrator/pkg/server/`、`packages/orchestrator/pkg/scheduling/`、`packages/orchestrator/pkg/startupreclaim/`。

---

## 1. 总体架构

Orchestrator 进程对 sandbox 的管理是一个**多层级、长生命周期、异步清理**的状态机。从入口到底层资源可以划分为五层：

```
┌────────────────────────────────────────────────────────────────────┐
│  gRPC 服务层  (pkg/server/sandboxes.go)                             │
│  Create / Update / Delete / List / Pause / Checkpoint               │
│  ─ 入口鉴权 + 信号量 (MaxSandboxesPerNode, MaxStartingInstances)    │
│  ─ 异步上传 + peer-to-peer chunk transfer + 事件发布                │
└──────────────┬─────────────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────────────┐
│  Sandbox 工厂  (pkg/sandbox/sandbox.go)                             │
│  Factory.CreateSandbox / ResumeSandbox / RebootSandbox              │
│  ─ 并发初始化:网络 slot + rootfs overlay + uffd + cgroup             │
│  ─ Cleanup 链:error 时按 LIFO 回滚;成功后挂上 Close                  │
└──────────────┬─────────────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────────────┐
│  Sandbox 实例 (sandbox.go,1838 行)                                   │
│  Wait / Close / Stop / Pause / Shutdown / WaitForEnvd / WaitForExit  │
└──────────────┬─────────────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────────────┐
│  注册表 Map  (pkg/sandbox/map.go)                                    │
│  live / lifecycles / network 三索引;Subscriber 通知                  │
└──────────────┬─────────────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────────────┐
│  资源层 (fc.Process / nbd.DevicePool / network.Pool / cgroup)        │
│  + 监控/健康检查 (Checks / hostStatsCollector)                       │
└────────────────────────────────────────────────────────────────────┘
```

每一层都遵循**"先注册、后启动、错误必清理"**的原则,通过 `Cleanup` 链保证不会泄漏资源。

---

## 2. 核心数据结构

### 2.1 `Config` — sandbox 静态配置

定义在 `packages/orchestrator/pkg/sandbox/sandbox.go:89`。

| 字段 | 含义 |
| --- | --- |
| `BaseTemplateID` | 兼容 v1 rootfs 路径格式,新版本可空 |
| `Vcpu` / `RamMB` | guest CPU 与内存规格 |
| `TotalDiskSizeMB` | 仅用于指标,不影响实际分配 |
| `HugePages` / `FreePageReporting` / `FreePageHinting` | 内存优化开关 |
| `Envd` | `EnvdMetadata`:启动 envd 所需的 vars / default user / workdir / access token / version |
| `FirecrackerConfig` | 内核版本 + Firecracker 版本 |
| `SkipEnvdWait` | gdb 调试路径专用,跳过 envd 就绪等待 |
| `VolumeMounts` | 持久化卷挂载 (`VolumeMountConfig{ID,Name,Path,Type}`) |
| `MaxSandboxLengthHours` | 单 sandbox 最大存活时长(小时) |
| `Network` | `*orchestrator.SandboxNetworkConfig`,内部有 `mu sync.RWMutex` 保护 Egress/Ingress 并发更新 |

> `NewConfig(c Config)` 会把 `nil Network` 归一化为空结构,因此 `Config.Network` 在合法 Config 中**永不为 nil**。Egress/Ingress 必须通过 `GetNetworkEgress / SetNetworkEgress / GetNetworkIngress` 读写,以保证线程安全。

### 2.2 `RuntimeMetadata` — 运行时身份

```go
type RuntimeMetadata struct {
    TemplateID  string
    SandboxID   string
    ExecutionID string  // 跨 checkpoint 稳定,API/路由/分析共用
    TeamID      string  // best-effort,不可用于关键决策
    BuildID     string
    SandboxType SandboxType  // "sandbox" | "build"
}
```

- `ExecutionID` 对外稳定;`LifecycleID` (见下) 对内每次 FC 进程重启都换。
- `SandboxType` 用于区分普通 sandbox 和模板构建 sandbox,会影响 LaunchDarkly 上下文与指标打点。

### 2.3 `Sandbox` 结构体

定义在 `sandbox.go:260`,组合了 `Resources` 与 `Metadata`,并持有所有运行时句柄:

| 字段 | 作用 |
| --- | --- |
| `LifecycleID` | 单次 FC 生命周期 UUID。用于 Map 的驱逐保护和 proxy 连接池。**每次 Resume/Reboot 都换新的** |
| `config / files / cleanup` | 构建配置、沙箱文件路径、清理链 |
| `sandboxes *Map` | 反向引用注册表,以便 Close 时同步状态 |
| `featureFlags *featureflags.Client` | LaunchDarkly 客户端 |
| `process *fc.Process` | Firecracker 进程句柄 |
| `cgroupHandle *cgroup.CgroupHandle` | cgroup v2 句柄,用于资源核算与强制 kill |
| `Template template.Template` | 当前使用的模板(rootfs/memfile/snapfile/metadata 提供者) |
| `Checks *Checks` | 健康检查循环 |
| `hostStatsCollector *HostStatsCollector` | 主机侧 cgroup CPU/Mem/IO 采样 |
| `APIStoredConfig *orchestrator.SandboxConfig` | **deprecated**;用于 API 重启时恢复配置 |
| `CABundle string` | 出口代理用的 CA |
| `exit *utils.ErrorOnce` | 单次错误写入,Wait 返回它 |
| `stop utils.Lazy[error]` | 让 `Stop` 幂等:多次调用只真正执行一次 |
| `startupStatsOnce sync.Once` | 保证 uffd 启动指标只在第一次 WaitForEnvd 上报 |
| `skipStartupMetrics bool` | throwaway resume 不污染客户 KPI |

### 2.4 `Factory` — 沙箱工厂

```go
type Factory struct {
    Sandboxes         *Map
    config            cfg.BuilderConfig
    networkPool       *network.Pool
    devicePool        *nbd.DevicePool
    featureFlags      *featureflags.Client
    hostStatsDelivery hoststats.Delivery
    cgroupManager     cgroup.Manager
    egressProxy       network.EgressProxy
}
```

工厂持有所有节点级共享资源池。三个核心方法:

1. `CreateSandbox` — 冷启动(模板 build 路径)
2. `ResumeSandbox` — 从 snapshot 恢复(运行时常见路径)
3. `RebootSandbox` — 从 fs-only snapshot 冷启动

---

## 3. Sandbox 工厂与生命周期

### 3.1 `CreateSandbox` — 冷启动

`Factory.CreateSandbox` (`sandbox.go:396`) 流程:

```
┌─ getNetworkSlot (并发 promise)               拿到网络 IP/Slot
├─ template.Files().NewSandboxFiles(...)        准备本地文件
├─ rootfs.NewNBDProvider / NewDirectProvider    构建 rootfs 后端
├─ memfile / memfileSize                        取模板内存文件
├─ ipsPromise.Wait()                            阻塞等网络就绪
├─ (可选) preBootFn                             预启动钩子
├─ createCgroup                                 cgroup v2 + dir FD
├─ fc.NewProcess                                拉 FC socket
├─ featureflags 取 throttle 配置 (TCP / Block)
├─ resources / metadata 组装
├─ Sandbox 结构体实例化
├─ Sandboxes.AssignNetwork / AddPriority(Stop)  注册 + 兜底停止
├─ initializeHostStatsCollector                 启动主机采样
├─ fcHandle.Create(vcpu, ram, hugepages, ...)   发 FC CreateVMM
├─ NewChecks(sbx)
├─ cleanup.AddPriority(sbx.Stop)                再次保证停止
├─ goroutine: 等 FC Exit → sbx.Stop → exit.SetError
└─ Sandboxes.MarkRunning (除非 WithDeferredMarkRunning)
```

**关键选项 `WithDeferredMarkRunning`**:让 `CreateSandbox` 不立即 `MarkRunning`,留给调用者在 envd 就绪后再标记。`RebootSandbox` 用它确保冷启动期间不会被路由命中。

**Cleanup 链兜底**:整个函数用 `defer func()` 在出错时执行 `cleanup.Run(ctx)`,把已注册的所有清理函数按 LIFO 跑一遍,再加入错误返回。

### 3.2 `ResumeSandbox` — 从 snapshot 恢复

`Factory.ResumeSandbox` (`sandbox.go:698`) 是**生产环境最常见的路径**。和 Create 的差异在于:

- 不构建 rootfs overlay 后直接 boot,而是先准备好 **uffd socket** 给 FC 做用户态缺页处理
- 启动 **prefetcher**(如 metadata 中有 prefetch mapping),让热页提前从源拉到本地
- 三个 promise 并发:**uffd / overlay / memory**
- `ropts.denyEgress` 时,在 Resume 之前先 `ips.DenyEgress`,防止 envd 初始化时偷跑流量
- `ropts.skipLiveRegistration` 时,跳过 `MarkRunning` 与 `Checks.Start`,**这种 throwaway 不计入节点分配、不发布指标**(用于 prefetch harvest)

Resume 成功的关键节点:
```go
fcHandle.Resume(uffdStartCtx, ..., fcUffd.Ready(), ..., useMemfd, ...)
sbx.WaitForEnvd(ctx, StartTypeResume, envdTimeout)  // 关键 KPI
f.Sandboxes.MarkRunning(ctx, sbx)
go sbx.Checks.Start(execCtx)
```

**ResumeOption**:
- `WithDenyEgress()` — Resume 前禁止网络出口
- `WithoutLiveRegistration()` — 不进 live 注册表、不开健康检查、不打启动指标
- `ThrowawayResumeOptions()` — 上面两者的组合,专用于 pause-resume prefetch harvest

### 3.3 `RebootSandbox` — 从 fs-only snapshot 冷启动

`Factory.RebootSandbox` (`reboot.go:39`):

**安全闸**:`meta.IsFilesystemOnly()` 必须为 true。memory snapshot 的 rootfs 可能缺失只存在于 guest page cache 的写入,冷启动会造成磁盘不一致,直接拒绝。

冷启动特征:
- `block.NewEmpty(RamMB)` 造一个空 memfile(仅用于 `NoopMemory` sizing)
- `template.NewMaskTemplate(t, WithMemfile(memfile))` 替换原模板的 memfile
- 走 `CreateSandbox` + `WithDeferredMarkRunning`
- 因为是 systemd 启动,需要把 default user/workdir 通过 `/init` 重传(内存里没东西了)
- `rebootEnvdTimeout = 60s`(冷启动比内存恢复慢)
- 使用 `KvmClock` (envd ≥ 0.2.11)、`IoEngineSync`(防止下次 pause 时有未落盘的异步写)

### 3.4 停止与关闭

三个相关方法容易混淆:

| 方法 | 作用 | 是否幂等 |
| --- | --- | --- |
| `Stop(ctx)` | 杀 FC 进程 + kill cgroup + 停 uffd | ✅ 通过 `utils.Lazy[error]` |
| `Close(ctx)` | 跑完整 Cleanup 链 + `Map.MarkStopped` | 调一次 |
| `Shutdown(ctx)` | 用于"温柔停":先 Pause + 写 snapshot,再 `Close` | — |
| `Wait(ctx)` | 等待 `exit` 信号(FC 退出/Stop 完成) | — |
| `WaitForExit(ctx)` | 在 `Wait` 之上加 `endAt` 超时 | — |

`doStop` (`sandbox.go:1148`) 的固定顺序:
1. `s.Checks.Stop()` — 先停健康检查,避免竞争上报 unhealthy
2. `s.process.Stop(ctx)` — 杀 FC
3. `s.cgroupHandle.Kill(ctx)` — 兜底杀 cgroup 内所有进程
4. 等 `s.process.Exit.Done()` 或 `ctx.Done()`
5. `s.Resources.memory.Stop()` — 停 uffd(memory backend)

> **重要**:`Stop` 只做"杀进程";`Close` 才会真正释放网络 slot、cgroup、文件、 unregister from Map。所以**每次成功 Create/Resume 后,最终都必须 `Close`**,否则会泄漏 slot 和 IP。

---

## 4. 三索引沙箱映射 `Map`

`packages/orchestrator/pkg/sandbox/map.go` 维护三个独立的 smap:

| 索引 | key | value | 生命周期 | 用途 |
| --- | --- | --- | --- | --- |
| `live` | `sandboxID` | `*Sandbox` | `MarkRunning` → `MarkStopping` | API/proxy 查询(`Get/Items/Count`) |
| `lifecycles` | `sandboxID/lifecycleID` | `*Sandbox` | `MarkRunning` → `MarkStopped` (Close) | shutdown 等待清理完毕 |
| `network` | host IP | `*Sandbox` | `AssignNetwork` → `NetworkReleased` | `GetByHostPort` 反查 |

**不变量**:`live ⊆ lifecycles`。`MarkRunning` 同时插入两者;`MarkStopping` 只删 live;`MarkStopped` (在 Close 里) 才删 lifecycles。

**为什么 lifecycles 独立**:checkpoint/resume 期间,旧 lifecycle 可能还在清理 cgroup/网络,新 lifecycle 同 sandboxID 已经 live。`live` 只能看到新者,但 shutdown 必须等所有 lifecycle 清理完才能退出,所以需要独立索引。

### 4.1 状态机

三个索引独立维护,触发条件:

```
              live              lifecycles           network
              ────              ───────────          ───────
[初始]        ∅                   ∅                    ∅

AssignNetwork ───────────────────────────────────────▶ 插入
              │                                       
MarkRunning  插入 ─────────────▶ 插入                  
              │                                       
              │ (OnInsert 通知订阅者)                  
              │                                       
MarkStopping 删除(lifecycleID                            
              │ 必须匹配)                               
              │                                       
              │                       NetworkReleased ─▶ 删除
              │                       (cleanup 钩子)     (OnNetworkRelease)
              │                                       
MarkStopped  ∅                    删除(Close 中)       
                                    ▼
                              WaitLifecycles 解除阻塞
```

要点:
- `MarkRunning` 触发 `OnInsert`;`NetworkReleased` 触发 `OnNetworkRelease`。
- `MarkStopping` 不删 network,只删 live;network 由 cleanup 注册的 `NetworkReleased` 异步删。
- `MarkStopped` 在 `Sandbox.Close` 里调用,删 lifecycles;这是 shutdown `WaitLifecycles` 等待的最后一个信号。

### 4.2 关键 API

```go
MarkRunning(ctx, sbx)                       // 插入 live + lifecycles,触发 OnInsert
MarkStopping(ctx, sandboxID, lifecycleID)   // 删除 live(必须 lifecycleID 匹配)
MarkStopped(ctx, sbx)                       // 删除 lifecycles
AssignNetwork(ctx, sbx)                     // 插入 network
NetworkReleased(ctx, ip)                    // 删除 network,触发 OnNetworkRelease
Get(sandboxID)                              // 查 live
GetByHostPort(hostPort)                     // 查 network(从 "ip:port" 解析)
Items() / Count()                           // 遍历/计数 live
LifecycleItems()                            // 遍历 lifecycles
WaitLifecycles(ctx)                         // 关闭时等待所有 lifecycle 退出
Subscribe(MapSubscriber)                    // 订阅 OnInsert / OnNetworkRelease
```

`MarkStopping` 用 `RemoveCb` + lifecycleID 比较,**避免错误地停止新 lifecycle**:同 sandboxID 但不同 LifecycleID 时,删除被拒绝。

### 4.3 `MapSubscriber` 接口

```go
type MapSubscriber interface {
    OnInsert(ctx context.Context, sandbox *Sandbox)         // sandbox 进入 live
    OnNetworkRelease(ctx context.Context, sbx *Sandbox)     // network slot 释放
}
```

订阅者回调**同步执行**在状态变更的 goroutine 上,必须非阻塞。

---

## 5. 健康检查 `Checks`

`packages/orchestrator/pkg/sandbox/checks.go` + `health.go`。

```go
const (
    healthCheckInterval = 20 * time.Second
    healthCheckTimeout  = 100 * time.Millisecond
)
```

实现要点:

- **默认值**:sandbox 创建即认为健康(`healthy.Store(true)`),只有状态翻转才打日志。
- **请求**:`GET http://<slot-ip>:49983/health`,期待 `204 No Content`。端口来自 `consts.DefaultEnvdServerPort`。
- **HTTP 客户端**:全局 `sandboxHttpClient`,**禁用 keep-alive**(避免与 envd 短暂进程争用 socket)、超时 10s。
- **状态翻转**:`healthy.CompareAndSwap(true, false)` / `(false, true)` 保证每次翻转只上报一次。
- **强制上报**:`Healthcheck(ctx, alwaysReport=true)` 用于 Delete 前的最后一次探活,无论是否翻转都打日志,便于审计。
- **并发安全**:`cancelCtx` 与 `stopped` 标志配合,解决"sandbox 在 Start goroutine 调度前就 Stop"导致的泄漏。

`Checks.Stop()` 通过 `cancelCtx(ErrChecksStopped)` 取消整个 health 循环;`Start` 在持锁后再次检查 `stopped`,避免错过 Stop。

---

## 6. Cleanup 链

`packages/orchestrator/pkg/sandbox/cleanup.go` 实现了**幂等、有序、与请求 ctx 解耦**的清理。

```go
type Cleanup struct {
    cleanup         []func(ctx context.Context) error  // 普通
    priorityCleanup []func(ctx context.Context) error  // 高优先级
    error           error
    once            sync.Once
    hasRun          atomic.Bool
    mu              sync.Mutex
}
```

行为:

1. **注册**:`Add(ctx, f)` / `AddPriority(ctx, f)` / `AddNoContext(ctx, f)()`。
2. **执行顺序**:`Run` 先逆序跑 `priorityCleanup`,再逆序跑 `cleanup`(LIFO)。
3. **幂等**:`sync.Once` 保证 `Run` 只跑一次。
4. **脱钩 ctx**:`Run` 内部用 `context.WithoutCancel(ctx)`,即使请求 ctx 已取消,清理仍会执行(否则会泄漏 cgroup、FC 进程、网络 slot)。
5. **迟来注册**:`hasRun=true` 后再 `Add`,会**立即用 `WithoutCancel` 执行**并打错误日志(防止丢失必要的清理)。

典型注册顺序(`CreateSandbox` 中,**注册顺序**而非执行顺序):

```
1. cleanupFiles                (普通) — 删 socket / cache
2. rootfsProvider.Close        (普通)
3. cgroupHandle.Remove         (普通)
4. MarkStopping (via cleanup)  (普通) — 从 live 移除
5. hostStatsCollector.Stop     (普通)
6. sbx.Stop                    (优先) — 先杀 FC
```

**实际执行顺序是逆序(LIFO)**:`Run` 先逆序跑 `priorityCleanup`(只有 `sbx.Stop`),再逆序跑 `cleanup`(`hostStatsCollector.Stop` → `MarkStopping` → `cgroupHandle.Remove` → `rootfsProvider.Close` → `cleanupFiles`)。

`AddPriority(sbx.Stop)` 用意:Close 时必须**先杀 FC**,否则后续资源(cgroup/network)释放会和 FC 仍持有它们产生竞争。

---

## 7. Pause 之前的资源回收 reclaim

`packages/orchestrator/pkg/sandbox/reclaim.go` 处理 pause 前对 guest 的"瘦身",分两类:

### 7.1 `bestEffortReclaim` — 启动可选、失败非致命

执行链(全部由 LaunchDarkly `ReclaimConfigFlag`(key `guest-pause-reclaim`)控制,默认禁用):

```
bestEffortFreeze        (envd /freeze,    freezeTimeout=2s)
bestEffortCollapse      (envd /collapse,  按 LD flag 超时)
buildReclaimScript:
   timeout -s KILL %.3f sh -c "fstrim -av"
   timeout -s KILL %.3f sh -c "sync"
   timeout -s KILL %.3f sh -c "echo 3 > /proc/sys/vm/drop_caches"
   timeout -s KILL %.3f sh -c "echo 1 > /proc/sys/vm/compact_memory"
```

每个 step 都用 `timeout -s KILL` 单独设上限,失败仅设 `rc` 不中断后续。

### 7.2 `guestPrepareFsForPause` — **强制**,失败必拒

针对**fs-only pause**(没有内存 snapshot,page cache 会丢):

```go
if envdSupportsFsFreeze {
    callEnvdFsfreeze(ctx, timeout)   // FIFREEZE 已经 sync,无需重复
    cleanup.Add(bestEffortFsthaw)    // pause 失败时回 thaw,避免活 VM 永久冻结
} else {
    guestSync(ctx, timeout)          // 退化方案
}
```

**超时推导 `ramScaledSyncTimeout`**:
```
dirty page cache 上限 ≈ guest RAM
flush 吞吐下限 = 50 MiB/s  (syncFlushFloorBytesPerSec)
deadline = RAM / 50MiBps,clamp 到 [5s, 2m]
```

**`GuestSyncTimeoutMs` LD flag** 设置正值时优先使用,覆盖 RAM 推导。

### 7.3 envd 能力探测

```go
envdSupportsCgroupFreeze(ctx)   // envd ≥ MinEnvdVersionForCgroupFreeze
envdSupportsFsFreeze(ctx)       // envd ≥ MinEnvdVersionForFsFreeze
envdSupportsHeapCollapse(ctx)   // envd ≥ MinEnvdVersionForHeapCollapse
```

版本解析失败统一返回 `false`,**永远不会调用不支持的端点**。

### 7.4 `Pause` 的完整清理兜底

`Sandbox.Pause` (`sandbox.go:1253`) 的清理兜底非常细致:

- `bestEffortReclaim` 之后注册 `bestEffortUnfreeze` 到 cleanup(失败路径用)
- fs-only 路径注册 `bestEffortFsthaw` 到 cleanup(同上)
- `process.Pause` 之后调 `FlushMetrics`(非阻塞,牺牲精度换 pause 延迟)
- snapshot 成功后,冻结状态进入 snapshot;失败则 thaw

---

## 8. gRPC 服务层 `Server`

`packages/orchestrator/pkg/server/sandboxes.go` 实现 `orchestrator.SandboxServiceServer`,是 API/外部调用方与 orchestrator 之间的唯一入口。

### 8.1 入口闸门

| 闸门 | 来源 | 行为 |
| --- | --- | --- |
| `MaxSandboxesPerNode` | LD flag | `Count() >= max` → `ResourceExhausted` |
| `MaxStartingInstancesPerNode` | LD flag,30s 刷新 | `startingSandboxes` AdjustableSemaphore,`TryAcquire` / `waitForAcquire` |
| BYOP egress proxy | `BYOPProxyEnabledFlag` + `SupportsBYOP()` | 缺一就 `PermissionDenied` / `Unimplemented` |

`startingSandboxes` 是 `utils.AdjustableSemaphore`,可以在运行时通过 `refreshStartingSandboxesLimit` 协程动态调整大小,无需重启。

`waitForAcquire` 用于 snapshot resume / checkpoint(重操作,并发量受限更严),`TryAcquire` 用于普通 create(快操作)。

### 8.2 `Create` 流程

```
1. ctx 超时 60s
2. 取模板(templateCache.GetTemplate,支持 snapshot)
3. 解析 FC 版本(LD ResolveFirecrackerVersion)
4. NewConfig + RuntimeMetadata
5. 读取 meta.IsFilesystemOnly()
   ├─ true  → RebootSandbox
   └─ false → ResumeSandbox
6. setupSandboxLifecycle (起 goroutine 等 sbx.Wait → Close)
7. template.SchedulingMetadata (如果实现)
8. 异步发 events.SandboxCreatedEventPair / SandboxResumedEventPair
9. 返回 {ClientId, SchedulingMetadata}
```

**`storage.ErrObjectNotExist`** 单独识别为 `FailedPrecondition`,提示 API "snapshot 数据还没上传完"。

### 8.3 `Update`

更新EndTime / Egress,**所有变更原子化**(`utils.ApplyAllOrNone`):

```go
updates = append(updates,
    setEndTime,    // sbx.SetEndAt
    updateEgress,  // sbx.Slot.UpdateInternet + Config.SetNetworkEgress
)
utils.ApplyAllOrNone(ctx, updates)  // 任一失败则全部回滚
```

每个 update 返回 `applyFunc + rollbackFunc`,确保 egress 失败时EndTime 也回滚。

### 8.4 `Delete`

```
1. Get sandbox;not found → NotFound
2. MarkStopping (排除 live 查询,保留 network 反查)
3. Healthcheck(alwaysReport=true) — 最后一次审计
4. go sbx.Stop (异步,不阻塞 gRPC 返回)
5. publish SandboxKilledEventPair + recordSandboxKill
```

### 8.5 `Pause` 与 `Checkpoint`

两者都调用 `snapshotAndCacheSandbox`,差异:

| 维度 | Pause | Checkpoint |
| --- | --- | --- |
| `filesystemOnly` 选项 | 由请求 `in.GetFilesystemOnly()` 决定 | 强制 `false`(总取完整内存快照) |
| 后续动作 | 异步上传 + 异步 prefetch harvest | 立即用新 build ID Resume 一个新 lifecycle(同 sandboxID + 同 ExecutionID) |
| sandbox 是否还在 | 否(被停止) | 老 lifecycle 停止,新 lifecycle 接替 |
| 同步性 | 总是异步上传 | `PeerToPeerAsyncCheckpointFlag` 决定;默认同步等 upload |
| 事件 | `SandboxPausedEventPair` | `SandboxCheckpointedEvent` |

`snapshotAndCacheSandbox` 的产物 `snapshotResult`:

```go
type snapshotResult struct {
    meta               metadata.Template
    schedulingMetadata *orchestrator.SchedulingMetadata
    upload             *sandbox.Upload
    completeUpload     func(ctx, uploadErr)  // Finish + ttlcache.Set + peerRegistry.Unregister
    objectMetadata    storage.ObjectMetadata
}
```

### 8.6 上传重试

`uploadSnapshotAsync` 用 `retry.Do` + `defaultUploadRetryPolicy()`:

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `uploadTimeout` | 20 min | 单次尝试上限 |
| `uploadTotalBudget` | 2 hour | 整体重试上限 |
| `redisPeerKeyTTL` | 2h2m | peer 路由 key TTL(覆盖整个重试窗口) |
| `uploadRetryInitialBackoff` | 5 s | 首次重试等待 |
| `uploadRetryMaxBackoff` | 2 min | 退避上限 |
| `uploadRetryBackoffMultiplier` | 2 | 指数增长 |

`isRetryableUploadErr` 决定哪些错误可重试。

### 8.7 P2P chunk transfer

- `peerRegistry.Register(buildID, redisPeerKeyTTL)` — 把本节点注册为该 build 的 chunk 提供者
- `uploadedBuilds` TTL cache(1h)记录"已上传完"的 build,只有 `uploadErr == nil` 才标记
- `PeerToPeerChunkTransferFlag` 总开关;`PeerToPeerAsyncCheckpointFlag` 控制是否同步等 upload

### 8.8 `setupSandboxLifecycle`

```go
go func() {
    waitErr := sbx.Wait(ctx)
    cleanupErr := sbx.Close(ctx)
    closeErr := s.proxy.RemoveFromPool(sbx.LifecycleID)
    sbxlogger.E(sbx).Info(ctx, "Sandbox stopped")
}()
```

这是**保证不泄漏的核心兜底**:每个 sandbox 在被创建后,都有一个独立的 goroutine 等它退出,然后跑 Close + 清 proxy 连接池。**无论 sandbox 是被 Delete 杀、被 evict、TTL 到期还是自己崩溃,这条路径都会跑。**

---

## 9. 优雅关闭与 Drain

`packages/orchestrator/pkg/server/main.go`。

### 9.1 `Server.Close` — 进程退出

```go
func (s *Server) Close(ctx context.Context) error {
    close(s.done)              // 停止后台 ticker
    s.drainUploads(ctx, ...)   // 等待所有异步上传完成
    s.uploadedBuilds.Stop()
}
```

`drainUploads`:
- `uploadsInFlight == 0` 直接返回
- 否则每 10s (`uploadDrainLogInterval`) 打一条进度
- ctx 取消则放弃等待(强制退出)

### 9.2 `DrainSandboxes` — 节点排空

Nomad/部署系统在终止前调用的"温柔排空":

```go
for {
    if remaining := Count(); remaining == 0 {
        return waitSandboxLifecycles(ctx)   // 等所有 lifecycle 清理
    }
    select {
    case <-ctx.Done(): return ctx.Err()
    case <-ticker.C (5s):
        log("waiting for sandbox drain", remaining, elapsed)
    }
}
```

`elapsed` 越长日志越稀疏(<1min 每 5s,<1h 每分钟,≥1h 每 15min),避免长时间 drain 刷屏。

> `DrainSandboxes` **不拒绝新 sandbox 启动**;admission gating 由上层(Nomad job 健康检查、流量切走)负责。

### 9.3 `refreshStartingSandboxesLimit`

```go
ticker := 30s
limit := featureFlags.IntFlag(MaxStartingInstancesPerNode)
startingSandboxes.SetLimit(limit)
```

让运维通过 LD flag 调整节点最大并发启动数,无需重新部署。

---

## 10. 调度元数据 `SchedulingMetadata`

`packages/orchestrator/pkg/scheduling/metadata.go`。

```go
func FromHeaders(
    buildID uuid.UUID,
    memfileHeader, rootfsHeader *header.Header,
    newMemfileBytes uint64,
) *orchestrator.SchedulingMetadata
```

返回每个 artifact(rootfs / memfile)的:

- `BaseBuildId` / `MemfileBaseBuildId` — 链路根
- `BuildId` — 当前层
- `*BuildIds` / `*BuildBytes` — 引用到的所有 build 及其字节数(已去重)
- `*DroppedBuilds` — 超过 `chainLimit=128` 后丢弃了多少层

调度器(API 层)拿到这些信息后做**节点亲和性**:让有相关 build chunks 缓存的节点优先接收这个 sandbox,resume 时可以走 P2P chunk transfer 而不是回源。

`artifactBuilds` 算法:
1. `h.Mapping.BytesByBuild()` 取 header 中所有 build 引用
2. 注入 `base` 和 `build`(0 / `injectBuildBytes`)
3. 超过 `chainLimit` 时按"pinned 优先、字节多优先、UUID 字典序"排序后截断
4. 最终再按 UUID 字典序输出(顺序对亲和性匹配无意义)

---

## 11. 启动时回收 `startupreclaim`

`packages/orchestrator/pkg/startupreclaim/reclaim.go`。

Orchestrator 进程崩溃/重启后,本地会留下**残留资源**:firecracker 进程、NBD 设备、network namespace、cgroup、缓存文件。这个包负责清理:

| 资源 | 清理方式 |
| --- | --- |
| `firecracker` | 扫描 `/proc`,kill 残余 FC 进程 |
| `nbd` | 释放 `/dev/nbdX` 设备 |
| `network` | 清 netns、iptables 规则 |
| `cgroup` | 删除残留 cgroup 目录 |
| `file` | 删除 cache 目录下的孤儿文件 |

特点:
- **best-effort**:每个 reclaimer 返回 `(reclaimed, failed)`,失败不致命,只记 metric
- **指标**:`orchestrator.startup_reclaim.reclaimed` / `.failed`(按 `resource_type` 标签)
- **顺序(关键)**:`firecracker → nbd → network → cgroup → file`。源码注释明确指出顺序很重要:必须先 kill FC VMM,才能安全拆除它们持有的 network slot,否则会死锁/竞争

---

## 12. 关键并发与不变量小结

### 12.1 并发原语

| 位置 | 原语 | 保护对象 |
| --- | --- | --- |
| `Config.mu` | `sync.RWMutex` | `Network.Egress` / `Network.Ingress` |
| `Metadata.rwmu` | `sync.RWMutex` | `startedAt` / `endAt` |
| `Map.lifecycleMu` | `sync.Mutex` + `chan struct{}` | `lifecycles` + 通知 |
| `Map.subsLock` | `sync.RWMutex` | 订阅者列表 |
| `Cleanup.mu` | `sync.Mutex` | cleanup 切片 |
| `Cleanup.once` | `sync.Once` | `Run` 幂等 |
| `Cleanup.hasRun` | `atomic.Bool` | 迟来注册检测 |
| `Checks.mu` | `sync.Mutex` | `cancelCtx` 与 `stopped` 一致性 |
| `Checks.healthy` | `atomic.Bool` | 健康状态 CAS |
| `Sandbox.stop` | `utils.Lazy[error]` | `Stop` 幂等 |
| `Sandbox.startupStatsOnce` | `sync.Once` | uffd 启动指标只发一次 |

### 12.2 关键不变量

1. `live ⊆ lifecycles` —— `MarkRunning` 同时插入两者,`MarkStopped` 必须在 `MarkStopping` 之后。
2. `Config.Network` 永不为 nil —— `NewConfig` 保证。
3. `Stop` 幂等 —— 任意次数调用等价于一次。
4. `Close` 必须在 `Create/Resume/Reboot` 成功后调用 —— 否则泄漏 slot/IP。
5. `MarkStopping` 用 lifecycleID 比较 —— 不会误删新 lifecycle。
6. throwaway resume (`WithoutLiveRegistration`) —— 不进 live、不计 Count、不开 Checks、不打 KPI;但 network 仍注册(teardown 对称)。
7. fs-only snapshot 必须 `guestPrepareFsForPause` —— 否则丢 page cache 写入。
8. Reboot 仅对 fs-only snapshot 安全 —— memory snapshot 冷启动会磁盘不一致。

### 12.3 错误传播

- `exit *utils.ErrorOnce`:Sandbox 整个生命周期只保存第一个错误
- `Cleanup.Run`:用 `errors.Join` 聚合所有清理错误返回
- gRPC handler:把底层 error 包成 `status.Errorf(codes.X, ...)`,关键错误同时 `telemetry.ReportCriticalError`

---

## 13. 调试与运维 hook 速查

| 想做的事 | 关注点 |
| --- | --- |
| 看一个 sandbox 为什么不健康 | `Checks.Healthcheck` 日志 + `sbxlogger.Healthcheck(Fail/Success/Report*)` |
| 看 sandbox 创建耗时 | `orchestrator.sandbox.create.duration` histogram,标签 `sandbox.resume=true/false` |
| 看节点资源占用 | `OrchestratorCpuAllocatedGaugeName` / `MemoryAllocated` / `DiskAllocated`,基于 `Items()` 聚合 |
| 看节点排空进度 | `DrainSandboxes` / `drainUploads` 的进度日志 |
| 看 snapshot 上传失败 | `uploadFailedCounter` + `sbxlogger "snapshot upload did not durably land"` |
| 调整并发启动数 | LD flag `MaxStartingInstancesPerNode`(30s 内生效) |
| 调整最大运行数 | LD flag `MaxSandboxesPerNode`(立即生效,只影响新创建) |
| 关闭 P2P chunk | LD flag `PeerToPeerChunkTransferFlag` |
| 切换异步/同步 checkpoint 上传 | LD flag `PeerToPeerAsyncCheckpointFlag` |
| 控制 pause 前 reclaim | LD flag `ReclaimConfigFlag`(key `guest-pause-reclaim`,返回 `ReclaimConfig` 结构体;Fstrim/Sync/DropCaches/CompactMemory 每项独立毫秒上限) |
| 控制 fsfreeze/sync 超时 | LD flag `GuestSyncTimeoutMs`(正值覆盖 RAM 推导) |
| 控制 FPH drain | LD flag `FreePageHintingTimeout`(按 use case 字符串) |
| 控制 memfile diff dedup | LD flag `MemfileDiffDedupFlag`(JSON:enabled/bestEffort/directIO/budget) |

---

## 14. 文件索引

| 路径 | 行数 | 职责 |
| --- | --- | --- |
| `packages/orchestrator/pkg/sandbox/sandbox.go` | 1838 | Sandbox/Factory/Metadata/Create/Resume/Reboot/Pause/Stop |
| `packages/orchestrator/pkg/sandbox/map.go` | 268 | 三索引 Map + Subscriber |
| `packages/orchestrator/pkg/sandbox/checks.go` | 128 | 健康检查循环 |
| `packages/orchestrator/pkg/sandbox/health.go` | 49 | `/health` 请求实现 |
| `packages/orchestrator/pkg/sandbox/cleanup.go` | 124 | Cleanup 链 |
| `packages/orchestrator/pkg/sandbox/reclaim.go` | 395 | pause 前 reclaim + fsfreeze/sync |
| `packages/orchestrator/pkg/sandbox/reboot.go` | 156 | fs-only 冷启动 |
| `packages/orchestrator/pkg/sandbox/envd.go` | 336 | envd HTTP API 调用(init/sync/freeze/collapse) |
| `packages/orchestrator/pkg/server/sandboxes.go` | 1104 | gRPC handler Create/Update/Delete/List/Pause/Checkpoint |
| `packages/orchestrator/pkg/server/main.go` | 356 | Server 结构、metric、Drain/Close |
| `packages/orchestrator/pkg/server/template_cache.go` | 30 | 模板缓存包装 |
| `packages/orchestrator/pkg/server/upload_retry.go` | — | 上传重试策略 |
| `packages/orchestrator/pkg/server/prefetch_harvest.go` | — | pause 后预热采收 |
| `packages/orchestrator/pkg/scheduling/metadata.go` | 130+ | `SchedulingMetadata` 推导 |
| `packages/orchestrator/pkg/startupreclaim/reclaim.go` | 200+ | 启动时清理残留资源 |
| `packages/orchestrator/pkg/startupreclaim/firecracker.go` | — | 残留 FC 进程清理 |
