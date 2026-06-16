# 01. `sandbox.go` 顶层入口

> 路径: `packages/orchestrator/pkg/sandbox/sandbox.go`
> 职责: 定义 `Factory` / `Sandbox` / `Config` / `Resources` / `RuntimeMetadata`,把 fc 进程、rootfs、uffd、网络、cgroup、template、checks 粘合成一个完整沙箱生命周期。

---

## 1. 核心类型

### 1.1 `Config` — 静态配置

```go
type Config struct {
    BaseTemplateID string
    Vcpu, RamMB int64
    TotalDiskSizeMB int64
    HugePages, FreePageReporting, FreePageHinting bool
    Envd EnvdMetadata                // envd 的 env vars、user、workdir、accessToken、version
    FirecrackerConfig fc.Config      // 内核/FC 版本
    VolumeMounts []VolumeMountConfig
    MaxSandboxLengthHours int64
    mu      *sync.RWMutex            // 保护 Network 的可变子字段
    Network *orchestrator.SandboxNetworkConfig
}
```

要点:
- `Network` 永不为 nil(`NewConfig` 会把 nil 替换为零值)。
- `mu` 保护 Egress/Ingress 的并发读写。
- `GetNetworkEgress/SetNetworkEgress` 提供线程安全访问。

### 1.2 `RuntimeMetadata` — 运行时元数据

```go
type RuntimeMetadata struct {
    TemplateID, SandboxID, ExecutionID, TeamID, BuildID string
    SandboxType SandboxType                              // "sandbox" | "build"
}
```

`TeamID` 注释明确:不可靠(不保证有),不要用于判定逻辑,只能用于日志/指标 tag。

### 1.3 `Resources` — 沙箱关键资源

```go
type Resources struct {
    Slot   *network.Slot       // 网络命名空间
    rootfs rootfs.Provider     // rootfs 暴露方式
    memory uffd.MemoryBackend  // memfile 后端
}
```

`Sandbox` 通过组合获得这些资源(其他部分在子文档展开)。

### 1.4 `Sandbox` — 沙箱实例

```go
type Sandbox struct {
    *Resources
    *Metadata
    LifecycleID string                  // 每次启 FC 进程都换新
    config  cfg.BuilderConfig
    files   *storage.SandboxFiles      // sandbox 的 socket/cache 路径
    cleanup *Cleanup
    featureFlags *featureflags.Client
    process *fc.Process
    cgroupHandle *cgroup.CgroupHandle
    Template template.Template
    Checks  *Checks
    hostStatsCollector *HostStatsCollector
    APIStoredConfig *orchestrator.SandboxConfig  // 兼容 API 重启
    CABundle string
    exit    *utils.ErrorOnce
    stop    utils.Lazy[error]         // Stop 幂等
    startupStatsOnce sync.Once
}
```

**关键约定**:
- `LifecycleID` 与 `ExecutionID` 不同,每次 `Create/Resume` 都生成新 UUID。
  - API 用 `ExecutionID` 做 checkpoint 标识,跨 resume 保持不变。
  - orchestrator 内部用 `LifecycleID` 守卫 `Map` 的 markStopping/eviction。
- `stop` 是 `utils.Lazy[error]`,保证多协程并发 `Stop` 只跑一次底层逻辑。
- `startupStatsOnce` 保证 UFFD startup 指标只记第一次 `WaitForEnvd`(避免 envd-binary swap 时被重复记录)。

---

## 2. `Factory` — 创建器

```go
type Factory struct {
    Sandboxes    *Map                  // 共享 sandbox map
    config       cfg.BuilderConfig
    networkPool  *network.Pool
    devicePool   *nbd.DevicePool
    featureFlags *featureflags.Client
    hostStatsDelivery hoststats.Delivery
    cgroupManager cgroup.Manager
    egressProxy  network.EgressProxy
}
```

`NewFactory` 很简单:就是把上述依赖装在一起,不做任何 IO/启动。

`Factory` 上有两个核心方法:
- `CreateSandbox` — 冷启动(无 snapshot)
- `ResumeSandbox` — 从 snapshot 恢复(快路径,走 UFFD)

---

## 3. `CreateSandbox` 流程详解

```go
func (f *Factory) CreateSandbox(
    ctx context.Context,
    config *Config,
    runtime RuntimeMetadata,
    template template.Template,
    sandboxTimeout time.Duration,
    rootfsCachePath string,
    processOptions fc.ProcessOptions,
    apiConfigToStore *orchestrator.SandboxConfig,
    preBootFn PreBootFn,
) (s *Sandbox, e error)
```

**执行步骤**(以注释"// ==== END of resources initialization ===="为分界):

1. **执行 ctx & span**: `tracer.Start("create sandbox")`,`startExecutionSpan` 派生一个不随请求 ctx 取消的 execCtx(给 fc 进程 / 异步导出用)。
2. **Cleanup 注册 + 失败时自动回滚**: 失败后 `cleanup.Run` 会回收前面所有资源。
3. **网络 slot** (异步 promise):`getNetworkSlot` 把"获取 slot + 注册回收"装成一个 `utils.Promise`,失败时 cleanup 会异步归还。
4. **sandbox 文件**: `template.Files().NewSandboxFiles(runtime.SandboxID)`,cleanup 注册 `cleanupFiles` 删 socket/link。
5. **rootfs**:
   - `template.Rootfs()` 拿只读 rootfs header。
   - `rootfsCachePath == ""` → 走 `NewNBDProvider`(把 base rootfs 作为只读底层,本地 mmap 文件作为 COW 覆盖,通过 NBD 内核设备暴露给 FC)。
   - 否则 → 走 `NewDirectProvider`(直接把 base rootfs mmap 到目标路径,所有块标 dirty)。
6. **memfile 大小**: `template.Memfile(ctx).Size(ctx)`。
7. **PreBootHook**(可选):拿到 `rootfsProvider.Path()` 后,允许在 FC 启动前对 host 端 fs 做修改(例如 build 流程)。
8. **cgroup**: `createCgroup` → `cgroupManager.Create` → 返回 `*CgroupHandle` 和 FD;FC 用 `SysProcAttr.CgroupFD` 注入。
9. **fc.NewProcess**: 生成启动脚本,准备 `*Process` 但未启动。
10. **特征开关 → rate limit**: TCP 出口 + 块设备限速。
11. **Resources / Metadata 装配**:
    - `memory` 用 `uffd.NewNoopMemory(memfileSize, fcPageSize)`(冷启动不需要 UFFD,FC 自己管理内存)。
    - `fcPageSize` 根据 `HugePages` 选 4KiB 或 2MiB(影响 UFFD 的页大小)。
    - `Metadata` 内部 `startedAt = time.Now()`,`endAt = now + sandboxTimeout`。
12. **Map 注册**:`f.Sandboxes.AssignNetwork` 注册 IP 索引;cleanup 注册 `MarkStopping` 守卫(lifecycleID 匹配才删)。
13. **HostStats 采集器**:`initializeHostStatsCollector`,cleanup 注册 stop。
14. **fc.Create**:依次配置 boot source、rootfs drive、network interface、machine config、entropy、balloon,最后 `startVM`。
15. **Checks 启动**:`NewChecks`,cleanup 注册 `Stop` 优先级(确保先停 Checks 再停 FC)。
16. **异步等 fc 退出**: `go fcHandle.Exit.Wait()` 完成后调 `sandbox.Stop` 并把错误塞到 `exit`。
17. **MarkRunning**:`f.Sandboxes.MarkRunning` 触发 `OnInsert` 订阅者(比如 client-proxy)。

### 3.1 资源初始化拓扑图

```
                          CreateSandbox
                                │
        ┌──────────────┬────────┼────────┬──────────────┐
        ▼              ▼        ▼        ▼              ▼
   network slot    rootfs    memfile   cgroup        fc.Process
   (promise)      provider    size     handle         (not yet started)
        │              │        │        │              │
        └──── 等待 ───┴────────┴────────┴── 同步 ──┐   │
                                                    ▼
                                       fc.Create 同步完成
                                                    │
                                                    ▼
                                          Checks 启动 + 退订 cleanup
                                                    │
                                                    ▼
                                            sandbox 暴露给调用方
```

---

## 4. `ResumeSandbox` 流程详解

```go
func (f *Factory) ResumeSandbox(
    ctx context.Context,
    t template.Template,
    config *Config,
    runtime RuntimeMetadata,
    startedAt, endAt time.Time,
    apiConfigToStore *orchestrator.SandboxConfig,
) (s *Sandbox, e error)
```

**与 `Create` 的核心差异**:

| 阶段 | Create | Resume |
|------|--------|--------|
| rootfs 暴露 | NBD / Direct | NBD(同上) |
| memory 后端 | `NoopMemory` | `Uffd`(`uffd.New`) |
| 启动 FC | `fc.Create` 配全设备 | `fc.Resume(uffdSocket, snapfile, ...)` |
| 等 envd | 同 | 同(但会触发 `startupStatsOnce`) |
| Prefetch | 否 | 若 `meta.Prefetch.Memory` 非空则启动 `prefetch.New` |

**`Uffd` 三件并行 promise**(以下三个任务同时跑):

1. `uffdPromise`: 监听 `SandboxUffdSocketPath`,等 FC 连接后接收 region mappings + uffd fd(可能还有 memfd fd)。
2. `overlayPromise`: 创建 NBD overlay。
3. `memoryPromise`: 等 `uffdPromise` → `fcUffd.Start` → 注册 cleanup `Stop`。
4. (旁路)`prefetch goroutine`: 若 prefetch mapping 存在,等 `uffdPromise` 就绪后启动 `prefetch.New` 做主动预取。

之后:
- 创建 cgroup。
- 创建 fc process + `fcHandle.Resume`:
  - `configure`(启进程 + cgroup FD 注入 + wait for socket)
  - 并发等 uffd socket、rootfs path、rootfs symlink(`errgroup`)
  - `setMetrics` → `loadSnapshot(uffdSocket, uffdReady, snapfile, useMemfd)`
  - 设置 TX + 驱动 rate limit(总是发 PATCH 覆盖 snapshot 持久化的 limit)
  - `resumeVM` → `setMmds`(access token hash + logs collector address)
- `WaitForEnvd(ctx, StartTypeResume, f.config.EnvdTimeout)`:
  - 失败:进程退出会取消 ctx。
  - 成功:记 startup 指标(只在第一次)。
- `MarkRunning` + 启 `Checks`。

---

## 5. `Pause` 流程详解

```go
func (s *Sandbox) Pause(ctx, m metadata.Template, useCase SnapshotUseCase) (*Snapshot, error)
```

这是数据流最复杂的一步。核心顺序:

1. `Cleanup` 准备 + 失败时整体回滚。
2. **bestEffortReclaim**(可选,LD 开关):
   - 选配 `bestEffortFreeze`(调 envd `/freeze` 冻结 user/pty cgroup)。
   - 用 `StartEnvdSystemShell` 跑 fstrim/sync/drop_caches/compact_memory,每步有 per-step timeout。
   - 失败不阻塞,只 warn。
3. **DrainBalloon**(可选,按 `useCase` 超时):触发 FC free-page-hinting,等 `FREE_PAGE_HINT_DONE`。
4. **`process.Pause`**(FC PATCH state=Paused)。
5. `process.FlushMetrics` —— best-effort,不阻塞。
6. `process.CreateSnapshot(snapfile)`。
7. **获取两份 DiffMetadata**:
   - memfile: `Resources.memory.DiffMetadata`:
     - 走 UFFD → `handler.ExportPageStates()` + `process.DirtyMemory` 合并。
     - 走 Noop → `FC /memory` 拿到 Resident+Empty bitmap。
   - rootfs: `s.rootfs`(NBD overlay)的 `ExportDiff` 会等 cleanup 回调(关 FC 后),然后从 cache 导出。
8. `pauseProcessMemory`:
   - `ExportMemory` 走 memfd(若有)+ 选配 dedup,落 `.dedup` 缓存。
   - 异步 goroutine 计算 dedup 的 diff header(`metaOut` 是 `SetOnce`)。
9. `pauseProcessRootfs`:
   - `rootfsDiffFile.CloseToDiff` 把临时文件转为 `build.Diff`。
   - 同步算 `ToDiffHeader`。
10. **scheduling 元数据**: `scheduling.FromHeaders(buildID, originalMemfile, rootfs, newMemfileBytes)`。`newMemfileBytes` 是 dirty block 数 × 块大小(预 dedup 上界),rootfs 走同步精确值。
11. 落 `metadata.json`(template metadata)到 cache。
12. 返回 `*Snapshot`:
    ```go
    type Snapshot struct {
        MemfileDiff       build.Diff
        MemfileDiffHeader *DiffHeader            // SetOnce[*header.Header]
        RootfsDiff        build.Diff
        RootfsDiffHeader  *DiffHeader
        Snapfile          template.File
        Metafile          template.File
        BuildID           uuid.UUID
        SchedulingMetadata *orchestrator.SchedulingMetadata
        MemfileBlockSize  uint64                 // 同步缓存
        RootfsBlockSize   uint64
        cleanup *Cleanup
    }
    ```

### 5.1 dedup 路径与非 dedup 路径差异

- 非 dedup:header 同步算,`MemfileDiffHeader` 用 `NewResolvedDiffHeader` 立即设值。
- memfd-dedup:header 异步算,goroutine 完成后 `SetValue` —— Pause 函数不等待,直接返回。

这意味着 `runV4` 中 `Wait` header 时需要 `WaitWithContext`。

---

## 6. `Stop` 与 `Shutdown`

### 6.1 `Stop` —— 运行时停止

```go
func (s *Sandbox) Stop(ctx context.Context) error {
    return s.stop.GetOrInit(func() error { return s.doStop(ctx) })
}
```

`doStop`:
1. `Checks.Stop`(必须先停,否则它会一直探活触发假阳性)。
2. `process.Stop` → SIGTERM → 10s → SIGKILL。
3. 等待 `process.Exit.Done()`(FC 进程已死)。
4. `memory.Stop` → `uffd.fdExit.SignalExit()`。
5. 收集所有错误 join 返回。

### 6.2 `Shutdown` —— pause + snapshot 化收尾

```go
func (s *Sandbox) Shutdown(ctx) error
```

- 停 Checks。
- `process.Pause`。
- 拿新 buildID 的 cache paths,创建一个 `LocalFileLink`(指向 /dev/null),用作 snapfile。
- `process.CreateSnapshot`。
- `s.Close(ctx)` → 触发所有 cleanup。

**注意**:FC API 不支持 `memfile_path=nil`,所以一定要提供 snapfile 路径(即使为 /dev/null)。

---

## 7. `Wait` / `WaitForExit` / `WaitForEnvd`

### 7.1 `Wait` —— 等退出

```go
func (s *Sandbox) Wait(ctx) error { return s.exit.WaitWithContext(ctx) }
```

`exit` 在 cleanup goroutine 里 `SetError` 触发。

### 7.2 `WaitForExit` —— 等到 endAt 或 ctx

`select` 在 `time.After(GetEndAt())` / `ctx.Done()` / `s.exit.Done()` 三者之一。

### 7.3 `WaitForEnvd` —— 启动时等待 envd 初始化

```go
func (s *Sandbox) WaitForEnvd(ctx, startType string, timeout time.Duration) error
```

实现要点:
- `initEnvd` 内部无限重试 `POST /init`,`loopDelay = 5ms`。
- 外层 `select` 监听 `time.After(timeout)`、`ctx.Done()`、`process.Exit.Done()`,任一触发就取消 `initEnvd` 的 ctx。
- **defer** 记录 `waitForEnvdDurationHistogram` + **一次性**记录 UFFD startup 指标。
- 成功时 `SetStartedAt(time.Now())`。

---

## 8. `Stop` 与 `cleanup` 的协作

`Stop` 不直接 cleanup —— 它触发 `doStop` 关 FC 与 uffd,cleanup 由 `Close` 走。

```
外部 Close
   │
   └─ cleanup.Run(ctx)  ── LIFO + priority 顺序:
        ├─ priority[0] = sandbox.Stop  (checks, FC, uffd)
        ├─ ...                     (host stats stop)
        ├─ cgroup.Remove
        ├─ NBD Close
        ├─ markStopping (LifecycleID 守卫)
        └─ cleanupFiles (rm socket/link)
```

`AddPriority` 给 `Stop` 用的目的是:Stop 必须在其他清理之前(否则 e.g. uffd 已关还要 stats,语义错乱)。

---

## 9. `Map.MarkRunning` / `MarkStopping` 的双 map 设计

`Map` 内部:
- `live *smap.Map[*Sandbox]`:按 `SandboxID` 索引,`Get/Items/Count` 走它。
- `network *smap.Map[*Sandbox]`:按 `HostIP` 索引,`GetByHostPort` 走它。

`MarkStopping` 用 lifecycleID 守卫的原因:
- 同一 `SandboxID` 短时内可能被 resume 多次(快速 pause/resume 链路)。
- 如果旧 instance 还在 cleanup,新 instance 已经 MarkRunning,旧 cleanup 误删 live map 的新 entry 会很糟。

---

## 10. 关联模块(后续文档展开)

- `Checks`、`Cleanup`、`Map` → `02-cleanup-reclaim-map.md`
- 暂停相关指标 → `04-snapshot-and-uploads.md`
- `fc.Process` 细节 → `05-fc.md`
- `rootfs.Provider`、`uffd.MemoryBackend` → `06-block.md` / `07-nbd.md` / `08-uffd.md` / `09-cgroup-network-rootfs.md`
