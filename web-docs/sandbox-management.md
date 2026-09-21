# Sandbox 管理详解

> 本文聚焦 E2B Orchestrator 中 **sandbox 的"管理面"**（lifecycle、注册表、健康检查、清理、回收、gRPC 接口、优雅关闭）。如需创建/暂停/恢复的状态机时序，请配合阅读 `sandbox-lifecycle.md`。
>
> 代码位置：`packages/orchestrator/pkg/sandbox/`、`packages/orchestrator/pkg/server/`、`packages/orchestrator/pkg/scheduling/`、`packages/orchestrator/pkg/startupreclaim/`。
>
> 数据来源：代码，**已同步至 2026.30**。行号均按 tag `2026.30` 核对；与 2026.29 不同的地方标注为「行 N（2026.30；2026.29 为 M）」。

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
│  Sandbox 实例 (sandbox.go,4221 行;2026.29 为 1904 行)                │
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

定义在 `packages/orchestrator/pkg/sandbox/sandbox.go:116`（2026.29 为 `:89`）。

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

定义在 `sandbox.go:354`（2026.29 为 `:260`）,组合了 `Resources` 与 `Metadata`,并持有所有运行时句柄:

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

#### 2026.30 变动:`Sandbox` 大幅扩容

`Sandbox` 结构体在 2026.30 新增了大量字段,集中在三条线上:

**1. 原地 checkpoint(in-place checkpoint)的状态机**

| 新字段 | 位置 | 作用 |
|---|---|---|
| `inPlaceCheckpointInFlight atomic.Bool` | `sandbox.go` | 排除同一 sandbox 的并发原地 checkpoint。原地 checkpoint 期间 sandbox **保持 live 且可被路由**(不做 `MarkStopping`),所以没有别的东西阻止第二个 Checkpoint RPC 与 `Pause`/`CreateSnapshot`/`ResumeInPlace` 竞争同一个 FC 进程 |
| `useSyncWP bool` | 同上 | 记录本次 resume 是否用了同步 userfault write-protect(`use_sync_wp`)。**只有它为真时**,page tracker 才能充当 pause 时的 dirty 来源。resume 期间写一次、发布后只读(通过 `UseSyncWP()` 读) |
| `inPlaceExportedDirty *roaring.Bitmap` | 同上 | 累积本 FC 生命周期内所有原地内存 checkpoint 导出的页。原地 diff 始终以**原始模板 header** 为父,所以每次导出必须是累积的 |
| `memSealMu sync.Mutex` / `memSealDone *utils.SetOnce[struct{}]` | 同上 | 保护 / 等待最近一次原地后台 CoW 内存捕获完成 |
| `rootfsSealMu sync.Mutex` / `rootfsSealDone *utils.SetOnce[struct{}]` | 同上 | 保护 / 等待最近一次原地后台 rootfs seal(swap + reflink + fold)。后续原地 checkpoint 会等它,确保可写 COW cache 是完整 diff |
| `fprPauseGen atomic.Uint64` | 同上 | 计数本 sandbox 的 free-page-reporting pause。脱离的 FPR-resume 重试循环捕获自己所属的 generation,一旦更新的窗口再次暂停 reporting 就停止 |
| `inPlaceStateFlipTimeout`(常量) | `sandbox.go` | `40 * time.Second`,限制原地 checkpoint 的 FC pause/resume 调用。**必须超过 FC 自身内部的 30s vcpu-ack 期限**,否则 Go 侧超时只说明 FC 已放弃这次翻转,而不代表我们在放弃一个仍在 FC 串行 API 循环里进行的调用 |

配套方法:`BeginInPlaceCheckpoint()`(`:494`,CAS 语义——返回 false 表示已有一次在跑,调用方必须拒绝)/ `EndInPlaceCheckpoint()` / `UseSyncWP()`。

**2. envd 活版本与升级握手**

| 新字段 | 作用 |
|---|---|
| `liveEnvdVersion atomic.Pointer[string]` | 运行中 envd 在最近一次 `/init` 响应里报告的版本(`X-Envd-Version`)。resume 时的升级触发用这个**地面真值**,而不是模板 built-with 版本(后者在活升级中永远不变) |
| `handoverResult atomic.Pointer[EnvdHandoverResult]` | 运行中 envd 在 `/init` 的 `X-Envd-Handover` 头里报告的活升级交接结果 |
| `envdMemory atomic.Pointer[EnvdMemoryProtection]` | envd 在 cgroup 链上报告的 memory protection(`X-Envd-Memory`) |
| `envdReportedDefaults atomic.Pointer[EnvdEffectiveDefaults]` | envd 报告的 `X-Envd-Defaults`。**nil 是能力信号而非空值**——只有能把 exec context 跨交接带过去的 envd 才会发这个头 |
| `envdWorkdirWithheld bool` | metadata 里声明的 default workdir **没有被重新下发**,只存在于运行中 envd 的内存里。**只有 memory-resume 路径会设置它**;filesystem-only 冷启动会重建并下发记录的 workdir,所以零值在那里才是正确的 |

**3. 停止原因与执行时长**

新增 `StopReason` 类型(metric label,取值集合小而封闭):

| 值 | 含义 |
|---|---|
| `killed` | Delete 以及 orchestrator 在操作把 sandbox 弄成不可用后自己做的拆除 |
| `paused` | 因 pause 而停 |
| `checkpointing` | 因 checkpoint 而停 |
| `crashed` | **"没有记录到原因"**——没有任何人要求它停,它还是挂了 |

配套方法:`SetStoppedAt`(首次调用生效;pause 会先挂起 VM 再快照上传,那段尾巴不算运行时间)、`SetStopReason`(**必须在触发 stop 之前调用**,否则 stop 会赢得竞争、这次执行会被读成 crash;首次调用生效)、`GetStopReason`(无记录时返回 `StopReasonCrashed`)、`ExecutionDuration`(从可服务到停止执行;start/stop 任一未知或顺序颠倒时返回 false)。

另外 `Metadata` 新增 `rwmu sync.RWMutex` 保护 `startedAt` / `endAt` / `stoppedAt` / `stopReason`,以及 `LifecycleStartedAt`(标记生命周期开始的主机时间戳)。

> ⚠️ `RuntimeMetadata` 新增了两个方法:`LogFields() []zap.Field` 与 `Logger() logger.Logger`。注意 `Sandbox.log()` 的注释特别强调:它**不是** `LoggerMetadata`——后者喂给的是独立的、**客户可见**的 sandbox 日志流。

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

`Factory.CreateSandbox` (`sandbox.go:859`;2026.29 为 `:396`) 流程:

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

`Factory.ResumeSandbox` (`sandbox.go:1207`;2026.29 为 `:698`) 是**生产环境最常见的路径**。和 Create 的差异在于:

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

`Factory.RebootSandbox` (`reboot.go:76`;2026.29 为 `:39`):

**安全闸**(`reboot.go:110`,判据函数在 `:63-64`):

```go
func rebootAllowed(meta metadata.Template, requestFilesystemBoot bool) bool {
    return meta.IsFilesystemOnly() || requestFilesystemBoot
}
```

> ⚠️ **本文档此前写错了。** 旧版本说的是「`meta.IsFilesystemOnly()` 必须为 true」——这在 2026.29 是准确的(`2026.29` 的 `reboot.go:63` 就是裸的 `if !meta.IsFilesystemOnly() { return ... }`),但 2026.30 引入了 `requestFilesystemBoot` 参数后就不再完整:memory-inclusive 的 snapshot 在调用方**显式要求 filesystem boot** 时也会被允许冷启动,代价是接受 rootfs 的 crash-recovery 语义。

拒绝时的错误串(`:111`)逐字:

```
refusing to reboot build %s: not a filesystem-only snapshot and the request did not demand a filesystem boot
```

代码注释(`:102-105`)解释了原因:memory snapshot 的 rootfs 可能缺失只存在于 guest page cache 的写入(那些写入在 memory resume 时才被恢复),所以冷启动它**充其量只能提供 crash-consistent 的磁盘**。

`RebootSandbox` 的签名也变长了(`:76-89`):新增 `requestFilesystemBoot bool`(`:84`)与 `recordRecovery func(rootfs.RecoverOutcome)`(`:87`,nil 会被替换成空函数,`resume-build` 这类工具不配 create metric 所以不传)。

冷启动特征:
- `block.NewEmpty(RamMB)` 造一个空 memfile(仅用于 `NoopMemory` sizing)
- `template.NewMaskTemplate(t, WithMemfile(memfile))` 替换原模板的 memfile
- 走 `CreateSandbox` + `WithDeferredMarkRunning`
- 因为是 systemd 启动,需要把 default user/workdir 通过 `/init` 重传(内存里没东西了)
- `rebootEnvdTimeout = 60s`(`:43`;2026.29 为 `:30`),冷启动比内存恢复慢
- 使用 `KvmClock` (envd ≥ 0.2.11)、`IoEngineSync`(防止下次 pause 时有未落盘的异步写)

**2026.30 新增的启动前处理**:

| 项 | 位置 | 说明 |
|---|---|---|
| `sandbox.filesystem_boot_requested` 属性 | `:201` | 打到 span 上,便于区分"真的 fs-only"与"显式要求冷启动" |
| `f.fsRecoverPreBoot(...)` | `:208` | 每次未在 pause 时冻结(`fs_quiesced` 缺失/为 false)的 rootfs 冷启动前,跑一次 jailed 文件系统恢复 |
| `decideOfflineSwap` | `:289` | 决定是否离线换 rootfs |
| `chainPreBoot` | `:326` | 把多个 `PreBootFn` 串起来 |
| `resolveOfflineTarget` | `:458` | 解析离线目标 |
| `envdOfflineUpgradePreBoot` | `:493` | 冷启动时离线升级 envd 二进制 |

整个文件从 157 行涨到 692 行,主要就是这套 pre-boot 恢复 / 离线升级机制。

### 3.4 停止与关闭

三个相关方法容易混淆:

| 方法 | 作用 | 是否幂等 |
| --- | --- | --- |
| `Stop(ctx)` | 杀 FC 进程 + kill cgroup + 停 uffd | ✅ 通过 `utils.Lazy[error]` |
| `Close(ctx)` | 跑完整 Cleanup 链 + `Map.MarkStopped` | 调一次 |
| `Shutdown(ctx)` | 用于"温柔停":先 Pause + 写 snapshot,再 `Close` | — |
| `Wait(ctx)` | 等待 `exit` 信号(FC 退出/Stop 完成) | — |
| `WaitForExit(ctx)` | 在 `Wait` 之上加 `endAt` 超时 | — |

`doStop` (`sandbox.go:1809`;2026.29 为 `:1148`) 的固定顺序:
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

`Sandbox.Pause` (`sandbox.go:1942`;2026.29 为 `:1253`) 的清理兜底非常细致:

- `bestEffortReclaim` 之后注册 `bestEffortUnfreeze` 到 cleanup(失败路径用)
- fs-only 路径注册 `bestEffortFsthaw` 到 cleanup(同上)
- `process.Pause` 之后调 `FlushMetrics`(非阻塞,牺牲精度换 pause 延迟)
- snapshot 成功后,冻结状态进入 snapshot;失败则 thaw

#### 2026.30 变动:快照准入前置检查(snapshot-admission pre-flight)

新增的准入判定(`packages/orchestrator/pkg/sandbox/sandbox.go:3630-3735`):

```go
type SnapshotAdmissionOutcome string

const (
    SnapshotAdmissionReady           SnapshotAdmissionOutcome = "ready"
    SnapshotAdmissionReadyAfterWait  SnapshotAdmissionOutcome = "ready_after_wait"
    SnapshotAdmissionRefused         SnapshotAdmissionOutcome = "refused"
    SnapshotAdmissionLatchedError    SnapshotAdmissionOutcome = "latched_error"
)

var ErrSnapshotAdmissionPending = errors.New("parent memfile header is still deduplicating")

func (s *Sandbox) AwaitSnapshotAdmission(ctx context.Context, grace time.Duration, memorySnapshot bool) (SnapshotAdmissionOutcome, time.Duration, error)
```

语义:在**任何破坏性步骤之前**先检查父 memfile header 是否还在去重(dedup)。若在宽限期内完成则 `ready_after_wait`,否则 `refused` + `ErrSnapshotAdmissionPending`(可重试)。

调用点在 `server/sandboxes.go` 的 `Pause`(`:871-891`),由 LD 整型 flag `PauseAdmissionGraceMs`(`pause-admission-grace-milliseconds`,默认 `-1`)控制——**只有 `graceMs >= 0` 时才启用**:

```go
if graceMs := s.featureFlags.IntFlag(ctx, featureflags.PauseAdmissionGraceMs); graceMs >= 0 {
    outcome, waited, admitErr := sbx.AwaitSnapshotAdmission(ctx, time.Duration(graceMs)*time.Millisecond, !in.GetFilesystemOnly())
    s.recordPauseAdmission(ctx, "pause", outcome, waited)
    ...
}
```

拒绝时返回 `ResourceExhausted` + `node is busy persisting sandbox '%s', please retry`(`:881`)——这正是 API 层 `PauseQueueExhaustedError` → 503 的来源。

> ⚠️ **顺序很关键**:准入检查在 `MarkStopping`(`:893`)**之前**。注释(`:871-872`)说明了原因——如果先 `MarkStopping` 再拒绝,sandbox 会被从 live 注册表摘掉,而 API 的 pause 链已经删除了路由条目,结果就是一个孤儿 VM,约 20 秒后被 orphan reconciler 以 `orphaned` 之名杀掉,而不是以真实原因。三类结果的处理:
> - `ErrSnapshotAdmissionPending` → 直接 `ResourceExhausted` 返回,sandbox **完全未被触碰**
> - `admitErr != nil && outcome == ""` → 调用方 context 在等待中途结束,什么都没决定,原样返回 context 错误
> - 其他 `admitErr` → **永久性**,latch 到 `latchedErr`,走下面的 kill 路径

**相关指标**:

| 指标名 | 位置 | 标签 |
|---|---|---|
| `orchestrator.sandbox.pause_admission` | `meters.go:58` | `outcome`(ready / ready_after_wait / refused / latched_error)、`rpc`(pause / checkpoint) |
| `orchestrator.sandbox.pause_admission.wait.duration` | `meters.go:393` | `outcome`——**只采样真正等待过的两种结果** |
| `orchestrator.sandbox.checkpoint` | `meters.go:62` | `in_place`、`success` |
| `orchestrator.sandbox.pause.duration` | `meters.go:342` | — |

记录函数 `recordPauseAdmission`(`server/sandboxes.go:804-818`)有一条重要行为:`outcome == ""` 时**什么都不记**——因为没有任何决定被做出。

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
1. ctx 超时 requestTimeout = 60s (:51, :133)
2. 取模板(templateCache.GetTemplate,支持 snapshot)
3. 解析 FC 版本 resolvedFCVersion = featureflags.ResolveFirecrackerVersion(...)   (:251)
4. NewConfig(FirecrackerConfig.FirecrackerVersion = resolvedFCVersion) + RuntimeMetadata
5. 读模板元数据 → fsOnly = meta.IsFilesystemOnly() (:299)
                 filesystemBooted = filesystemBoot(meta, req) (:300)
6. 分流
   ├─ filesystemBooted → RebootSandbox(..., requestFilesystemBoot=req.GetFilesystemBoot(), recordRecovery) (:304)
   └─ 否则            → ResumeSandbox(..., WithDeferredLiveRegistration()) (:319)
7. setupSandboxLifecycle (起 goroutine 等 sbx.Wait → Close)
8. template.SchedulingMetadata (如果实现)
9. 异步发 events.SandboxCreatedEventPair / SandboxResumedEventPair
10. 返回 {ClientId, SchedulingMetadata, FilesystemBootApplied, ResolvedFirecrackerVersion}
```

**`storage.ErrObjectNotExist`** 单独识别为 `FailedPrecondition`,提示 API "snapshot 数据还没上传完"。

#### 2026.30 变动:`filesystemBoot` 取代裸的 `IsFilesystemOnly()` 判据

分流条件不再是 `meta.IsFilesystemOnly()`,而是新函数(`server/sandboxes.go:97-99`):

```go
// filesystemBoot reports whether a snapshot resumes by cold-booting (rebooting)
// from its rootfs instead of restoring memory: when the artifact has no memory
// to restore, or when the request demands a cold boot of one that does.
// The request can only widen toward the no-memory path — it can never force a
// memory restore of a snapshot that has none.
func filesystemBoot(meta metadata.Template, req *orchestrator.SandboxCreateRequest) bool {
    return meta.IsFilesystemOnly() || req.GetFilesystemBoot()
}
```

> ⚠️ **单向性**:请求里的 `filesystem_boot` 只能把结果**推向"无内存"一侧**,永远无法把本身就没有内存的 snapshot 强行变成 memory restore。这是刻意的不对称。

**响应新增两个字段**(`:418-427`):

| 字段 | 位置 | 含义 |
|---|---|---|
| `FilesystemBootApplied` | `:421` | 本次 create 实际是否走了冷启动路径。**与请求里的 `filesystem_boot` 不一定相同**——一个 fs-only snapshot 即使请求没提也会是 true |
| `ResolvedFirecrackerVersion` | `:426` | 该 sandbox 实际运行的 FC 版本,**为其生命周期冻结**。注释解释了为什么必须回显:API 把它存下来,好让版本门槛特性精确地以**运行中的二进制**为准,而不是重新解析 flag——flag 一旦变动就会与这个冻结值漂移 |

**新增能力判定 helper**(`server/sandboxes.go:101-123`):

```go
func firecrackerSupports(ctx context.Context, sbx *sandbox.Sandbox, feature string, has func(*fcversion.Info) bool) bool
```

要点:
- 版本来自 `sbx.Config.FirecrackerConfig.FirecrackerVersion`,**在 resume 时就固定了**,所以对一个运行中的 sandbox 答案不会变
- 版本无法解析时**失败关闭**(fail closed)——版本门槛特性绝不允许在一个超出发布契约的 build 上启用
- 两条日志分别区分"无法解析"与"版本早于该特性"

**`deferMarkRunning` 已改为 defer-live-registration**:两条分支都传 `true` / `WithDeferredLiveRegistration()`,注释(`:308-311`、`:314-316`)说明原因——要推迟到 resume 时 envd 升级的 post-`/init` 之后才让 sandbox 可路由,否则它会在 pre-init 的鉴权窗口内被命中。之后通过 `markSandboxLive` 提升。

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
| 后续动作 | 异步上传 + 异步 prefetch harvest | **原地**:同一 FC 进程 pause→snapshot→resume;**resume-fresh**:用新 build ID Resume 一个新 lifecycle(同 sandboxID + 同 ExecutionID) |
| sandbox 是否还在 | 否(被停止) | 原地路径:**是**(不做 `MarkStopping`,保持 live 可路由);resume-fresh 路径:老 lifecycle 停止,新 lifecycle 接替 |
| 同步性 | 总是异步上传 | `PeerToPeerAsyncCheckpointFlag` 决定;默认同步等 upload |
| 事件 | `SandboxPausedEventPair` | `SandboxCheckpointedEvent` |

#### 2026.30 变动:原地 checkpoint(in-place checkpoint)

`Checkpoint` 在 2026.30 分成两条路径,分流判据在 `server/sandboxes.go:1079-1081`:

```go
inPlace := sbx.UseSyncWP() &&
    s.featureFlags.BoolFlag(ctx, featureflags.InPlaceCheckpointFlag) &&
    firecrackerSupports(ctx, sbx, "in-place checkpoint", (*fcversion.Info).HasInPlaceCheckpoint)

if inPlace {
    res, err = s.checkpointInPlace(ctx, sbx, in)      // :1188
} else {
    res, err = s.checkpointResumeFresh(ctx, sbx, in)  // :1271
}
```

**三个条件缺一不可**:

1. `sbx.UseSyncWP()` — 该 sandbox 是用同步 userfault write-protect(`use_sync_wp`)resume 的
2. `InPlaceCheckpointFlag`(`in-place-checkpoint`,默认 false)
3. `firecrackerSupports(..., HasInPlaceCheckpoint)` — 运行中的 FC 版本契约包含该能力(e2b releases ≥ 0.2.0,CoW memory window 驱动 balloon free-page-reporting pause API)

注释(`:1070-1078`)说明了为什么条件 1 是必须的:原地 checkpoint **跳过了重新加载 snapshot 时重新武装 write-protection 的那一步**,所以跨多次 checkpoint 的 dirty 追踪依赖 sync-WP serve loop。**其余情况一律走 resume-fresh,老 FC 优雅降级而不是报错。**

| 对比项 | `checkpointInPlace` | `checkpointResumeFresh` |
|---|---|---|
| 位置 | `:1188` | `:1271` |
| `MarkStopping` | **无**(注释 `:1175-1190`:这正是不做它的原因,否则 API 的后续调用找不到 sandbox) | 有(`:1279`) |
| FC 进程 | 同一个,原地 pause → snapshot → resume | 新进程 |
| 并发保护 | `Sandbox.BeginInPlaceCheckpoint()`(`sandbox.go:494`,CAS)排除同一 sandbox 的并发原地 checkpoint | 不需要 |
| 失败模式 | pause 失败由 cleanup resume 兜住;**resume 失败是致命步骤**(`killReasonResumeFailed`) | 见 `:1359-1390` 的兜底 `MarkStopping` |

**新增指标**(`:1093-1096`):

```go
s.sandboxCheckpointCounter.Add(ctx, 1, metric.WithAttributes(
    attribute.Bool("in_place", inPlace),
    attribute.Bool("success", err == nil),
))
```

指标名 `orchestrator.sandbox.checkpoint`(`meters.go:62`),注释(`:1091-1092`)说它是原地相关 duration histogram 的**分母**——用来回答"多少比例的 checkpoint 走了原地、成功率如何"。

**Checkpoint 也有准入前置检查**(`:1041-1060`),与 Pause 同一套,但有两处关键差异:

- `memorySnapshot` 参数硬编码为 `true`——**checkpoint 在两条路径上都总是取完整内存快照**
- 顺序放在 `waitForAcquire` **之前**(注释 `:1042-1043`),这样宽限等待期间不会占着 start slot
- latch 错误的处理**不同于 Pause**:Pause 会 latch 后走 kill 路径,Checkpoint 直接返回 `FailedPrecondition` + `sandbox '%s' cannot be persisted: %s`(`:1058`),注释(`:1055`)解释:"与 Pause 不同,下游没有任何地方会重新检查 latched seal"

**新增的 kill 原因**(`server/sandboxes.go:79-89`):

| 常量 | 值 | 含义 |
|---|---|---|
| `killReasonSealFailed` | `"seal_failed"` | pause 路径上对一个**永远无法再被有效持久化**的 sandbox 做的 kill(用 `:928`) |
| `killReasonResumeFailed` | `"resume_failed"` | pause 失败本身可由 cleanup resume 兜住,所以**resume 失败永远是致命步骤**;完整链条在 joined error 里 |

> ⚠️ `killReasonSealFailed` 这段代码(`:902-931`)的注释值得一读:pause 拒绝**并不能保住** sandbox——API 的 pause 链已经删除了路由条目,并且无论 RPC 结果如何都会移除 store 记录,所以一次被拒绝的 pause 会留下一个孤儿 VM,约 20 秒后被 orphan reconciler 以 `orphaned` 之名杀掉。**在请求内 kill 才能让 API 的记录与现实一致**,并把真实原因写进 error 和 stop reason。

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
| `Metadata.rwmu` | `sync.RWMutex` | `startedAt` / `endAt` / `stoppedAt` / `stopReason`(2026.30 扩展) |
| `Map.lifecycleMu` | `sync.Mutex` + `chan struct{}` | `lifecycles` + 通知 |
| `Map.subsLock` | `sync.RWMutex` | 订阅者列表 |
| `Cleanup.mu` | `sync.Mutex` | cleanup 切片 |
| `Cleanup.once` | `sync.Once` | `Run` 幂等 |
| `Cleanup.hasRun` | `atomic.Bool` | 迟来注册检测 |
| `Checks.mu` | `sync.Mutex` | `cancelCtx` 与 `stopped` 一致性 |
| `Checks.healthy` | `atomic.Bool` | 健康状态 CAS |
| `Sandbox.stop` | `utils.Lazy[error]` | `Stop` 幂等 |
| `Sandbox.startupStatsOnce` | `sync.Once` | uffd 启动指标只发一次 |
| `Sandbox.inPlaceCheckpointInFlight` | `atomic.Bool`(CAS) | 排除并发原地 checkpoint(2026.30 新增) |
| `Sandbox.memSealMu` | `sync.Mutex` | `memSealDone` / `inPlaceExportedDirty`(2026.30 新增) |
| `Sandbox.rootfsSealMu` | `sync.Mutex` | `rootfsSealDone`(2026.30 新增) |
| `Sandbox.fprPauseGen` | `atomic.Uint64` | FPR pause 代际,防止迟到的 resume 撤销新窗口(2026.30 新增) |
| `Sandbox.startupRecorded` | `atomic.Bool`(CAS) | **所有** first-WaitForEnvd 记录只做一次(2026.30 新增) |
| `Sandbox.liveEnvdVersion` / `handoverResult` / `envdMemory` / `envdReportedDefaults` | `atomic.Pointer[T]` | envd 活状态报告(2026.30 新增) |

> 2026.30 的 `startupRecorded`(`atomic.Bool`,CAS)取代了原先只用 `sync.Once` 的做法,注释解释了原因:后续的 `WaitForEnvd`(升级后的就绪复检、模板构建里的 envd 二进制替换 + 重启)会重跑 `/init` 以重新捕获状态,**但绝不能重复记录这些指标**——`ServeStats()` 是生命周期累计的,duration/counter 会把 resume KPI 记两次,而 `SetStartedAt` 会用更晚的时间覆盖真实启动时间。

### 12.2 关键不变量

1. `live ⊆ lifecycles` —— `MarkRunning` 同时插入两者,`MarkStopped` 必须在 `MarkStopping` 之后。
2. `Config.Network` 永不为 nil —— `NewConfig` 保证。
3. `Stop` 幂等 —— 任意次数调用等价于一次。
4. `Close` 必须在 `Create/Resume/Reboot` 成功后调用 —— 否则泄漏 slot/IP。
5. `MarkStopping` 用 lifecycleID 比较 —— 不会误删新 lifecycle。
6. throwaway resume (`WithoutLiveRegistration`) —— 不进 live、不计 Count、不开 Checks、不打 KPI;但 network 仍注册(teardown 对称)。
7. fs-only snapshot 必须 `guestPrepareFsForPause` —— 否则丢 page cache 写入。
8. Reboot 仅在两种情况之一成立时安全 —— snapshot 标记为 fs-only,**或**请求显式要求 filesystem boot(此时接受 crash-recovery 语义)。memory snapshot 冷启动会磁盘不一致。判据函数 `rebootAllowed`(`reboot.go:63-64`)/ `filesystemBoot`(`server/sandboxes.go:97-99`)。
9. **(2026.30)** 原地 checkpoint 必须同时满足 `UseSyncWP()` + `InPlaceCheckpointFlag` + FC 版本支持,且同一 sandbox 同时只允许一次(`BeginInPlaceCheckpoint` 的 CAS)。
10. **(2026.30)** 快照准入检查必须在 `MarkStopping` **之前** —— 否则被拒绝的 pause 会留下孤儿 VM,以 `orphaned` 而非真实原因被回收。
11. **(2026.30)** `filesystem_boot` 是单向的 —— 只能把结果推向"无内存"一侧,不能把无内存的 snapshot 强行变成 memory restore。
12. **(2026.30)** FC 版本门槛一律 **fail closed** —— 版本无法解析时拒绝启用特性(`firecrackerSupports`)。

> ⚠️ 不变量 8 此前写作「Reboot 仅对 fs-only snapshot 安全」。这在 2026.29 成立,但 2026.30 引入 `filesystem_boot` 需求后不再完整——见 §3.3。

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
| 看 checkpoint 走的是哪条路径 | 指标 `orchestrator.sandbox.checkpoint`,标签 `in_place` / `success` |
| 看 pause 准入排队情况 | 指标 `orchestrator.sandbox.pause_admission`(标签 `outcome` / `rpc`)与 `orchestrator.sandbox.pause_admission.wait.duration` |
| 看 sandbox 为什么停了 | `sbx.GetStopReason()`(标签值 `killed` / `paused` / `checkpointing` / `crashed`),配合指标 `orchestrator.sandbox.execution.duration` |
| 调整 pause 准入宽限 | LD flag `PauseAdmissionGraceMs`(**负值表示关闭该检查**,默认 `-1`) |

### 13.1 代理层:内部 envd 路由被拒绝(2026.30 新增,安全相关)

**这是一处安全修复,不是普通重构。**

`packages/orchestrator/pkg/proxy/proxy.go:86-88` 新增了拒绝逻辑:

```go
if !isNonEnvdTraffic && envd.IsInternalPath(r.URL.Path) {
    return nil, reverseproxy.NewErrInternalRoute(sandboxId, r.URL.Path)
}
```

**它防的是什么**:envd 暴露了一组 `/init`、`/freeze`、`/unfreeze`、`/fsfreeze`、`/fsthaw`、`/collapse`、`/upgrade` 这类**内部控制端点**。这些端点原本可以由 sandbox 外部的普通 HTTP 流量经由 proxy 打到 envd 上——也就是说,任何能访问 sandbox 公共入口的人都能冻结/解冻 guest 文件系统、触发 collapse 或 upgrade。2026.30 起,这类路径在 **proxy 层**被直接拒绝。

支撑代码:

| 文件 | 内容 |
|---|---|
| `packages/orchestrator/pkg/sandbox/envd/internal_routes.go:53` | `IsInternalPath`(注释在 `:33-52`)。**方法无关**(不区分 GET/POST),基于 `path.Clean`,并且**必须接收已解码的 `URL.Path`**(绝不能传 `RawPath` / `EscapedPath()` / `RequestURI`) |
| `packages/orchestrator/pkg/sandbox/envd/internal_routes.gen.go` | 生成表:`specInternalPaths = ["/collapse","/freeze","/fsfreeze","/fsthaw","/init","/unfreeze"]`、`unspecifiedInternalPaths = ["/upgrade"]` |
| `packages/orchestrator/pkg/sandbox/envd/gen_internal_routes.go` | 生成器,读取 `packages/envd/spec/envd.yaml` 中标记 `x-internal: true` 的路径(`:41,106,170,185,202,217`) |
| `packages/shared/pkg/proxy/errors.go:108` | `NewErrInternalRoute`;`InternalRouteError` 结构体在 `:103-106`,错误串在 `:115-117`:`internal route is not reachable through the proxy` |
| `packages/shared/pkg/proxy/handler.go:128-135` | handler 侧接入点:先 `Warn` 记日志(`internal route requested through the proxy`),再交给 `template.NewInternalRouteError` 渲染响应 |
| `packages/shared/pkg/proxy/template/internal_route.go:35` | `NewInternalRouteError(host, path)`,决定"404 但仍能自我解释"的响应形态 |

> ⚠️ **几个值得注意的设计点**:
> 1. **拒绝发生在 sandbox 查找之前**(`proxy.go:83-85` 注释)——所以返回的是一个**不泄漏任何信息**的响应:无论被寻址的 sandbox 是否在本节点上,答案都一样,回复里不含"这里有哪些 sandbox"的任何线索。
> 2. 判据里带了 `!isNonEnvdTraffic` 前置条件,即**只对路由到 envd 的流量生效**;非 envd 流量(例如直连 sandbox 内其他端口)不受此检查约束。
> 3. **为什么必须拒绝**(`proxy.go:80-81` 注释):envd 自己的 access-token 检查会允许 sandbox 的属主**把自己的 guest 卡死或重新镜像**,而 `/init` 干脆**完全豁免**了那个检查。
> 4. **方法无关是刻意的**(`internal_routes.go:38-40`):envd 对已知路径的错误方法返回 **405 而不是 404**,这就确认了该路由存在;而且以后往控制路由上新增的方法也会因此漏过去。
> 5. **`path.Clean` 让答案成为 envd 实际路由结果的超集**(`internal_routes.go:46-52`):envd 的路由器在转义路径与解码路径不同时匹配转义路径,而两者不同恰好意味着它不是该路径的规范编码——所以路由器只可能通过"解码路径正是该路由、且逐字拼写"的请求到达控制路由。Clean 只是把它放宽:`/init/`、`//init`、`/files/../init` 在这里就被拒,尽管 envd 自己会给它们 404。
> 6. **不接收未解码路径**(`internal_routes.go:42-44`):函数不做百分号解码,传入仍是转义的路径会**重新打开它本要堵上的那个绕过**。
>
> 另外,生成表里 `/upgrade` 落在 `unspecifiedInternalPaths` 而非 `specInternalPaths`——它同样被拒,但不在 envd 规范的显式清单里。

---

## 14. 文件索引

行数口径:`git show 2026.30:<path> | wc -l`;括号内为 2026.29 的对照值。

| 路径 | 行数 | 职责 |
| --- | --- | --- |
| `packages/orchestrator/pkg/sandbox/sandbox.go` | 4221(2026.29: 1904) | Sandbox/Factory/Metadata/Create/Resume/Reboot/Pause/Stop;2026.30 新增原地 checkpoint、envd 活状态、StopReason、快照准入 |
| `packages/orchestrator/pkg/sandbox/map.go` | 270(268) | 三索引 Map + Subscriber |
| `packages/orchestrator/pkg/sandbox/checks.go` | 128(128) | 健康检查循环 |
| `packages/orchestrator/pkg/sandbox/health.go` | 49(49) | `/health` 请求实现 |
| `packages/orchestrator/pkg/sandbox/cleanup.go` | 125(124) | Cleanup 链 |
| `packages/orchestrator/pkg/sandbox/reclaim.go` | 752(2026.29: 395) | pause 前 reclaim + fsfreeze/sync |
| `packages/orchestrator/pkg/sandbox/reboot.go` | 692(157) | fs-only 冷启动;2026.30 新增 pre-boot 文件系统恢复与离线 envd 升级 |
| `packages/orchestrator/pkg/sandbox/envd.go` | 887(2026.29: 336) | envd HTTP API 调用(init/sync/freeze/collapse) |
| `packages/orchestrator/pkg/sandbox/envd/internal_routes.go` | — | **2026.30 新增**,`IsInternalPath`(`:53`) |
| `packages/orchestrator/pkg/sandbox/envd/internal_routes.gen.go` | — | **2026.30 新增**,从 `envd.yaml` 的 `x-internal` 生成 |
| `packages/orchestrator/pkg/sandbox/admission_test.go` | 244 | **2026.30 新增**,快照准入的测试 |
| `packages/orchestrator/pkg/server/sandboxes.go` | 2241(1111) | gRPC handler Create/Update/Delete/List/Pause/Checkpoint;2026.30 新增 `filesystemBoot`、`firecrackerSupports`、`checkpointInPlace`、准入前置检查 |
| `packages/orchestrator/pkg/server/main.go` | 427(356) | Server 结构、metric、Drain/Close |
| ~~`packages/orchestrator/pkg/server/template_cache.go`~~ | ⛔ 已删除 | **2026.30 不再存在**(2026.29 为 30 行)。引用该文件的旧文档内容均已失效 |
| `packages/orchestrator/pkg/server/upload_retry.go` | 46(44) | 上传重试策略 |
| `packages/orchestrator/pkg/server/prefetch_harvest.go` | 465(374) | pause 后预热采收 |
| `packages/orchestrator/pkg/scheduling/metadata.go` | 110(110) | `SchedulingMetadata` 推导 |
| `packages/orchestrator/pkg/startupreclaim/reclaim.go` | 170(165) | 启动时清理残留资源 |
| `packages/orchestrator/pkg/startupreclaim/firecracker.go` | 112(112) | 残留 FC 进程清理 |
| `packages/orchestrator/pkg/proxy/proxy.go` | 256(205) | **安全相关**:`:86-88` 拒绝经由 proxy 到达 envd 内部路由 |
| `packages/shared/pkg/proxy/errors.go` | — | `InternalRouteError`(`:103-117`) |
| `packages/shared/pkg/proxy/handler.go` | — | 内部路由错误的 handler 接入(`:128-135`) |
| `packages/shared/pkg/proxy/template/internal_route.go` | — | `NewInternalRouteError`(`:35`) |

> ⛔ **`pkg/server/template_cache.go` 在 2026.30 被删除。** 它在 2026.29 只有 30 行(一个模板缓存包装),2026.30 已不在仓库中。任何指向它的行号引用都必须改写。
