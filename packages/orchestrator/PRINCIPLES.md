# Orchestrator 模块原理

> E2B 沙箱能力的「中心节点」：每个 orchestrator 进程在一台 GCP VM 上运行，负责拉起、暂停、恢复、销毁数百个 Firecracker microVM，并把它们暴露给上游 API 与 client-proxy。

**仓库路径**：`packages/orchestrator/`
**主入口**：`main.go`（Linux-only，需 root）
**默认端口**：`GRPCPort`（gRPC + HTTP/1 cmux 复用）、`ProxyPort`（sandbox 反向代理）、`PortmapperPort` / `NFSProxyPort`（持久卷）、`HyperloopProxyPort`（事件流）
**架构层级**：Orchestrator 调度层（`layer:orchestrator`，314 个图节点，279 个文件，~1777 个图节点）

---

## 1. 一句话定位

orchestrator 是把 **Firecracker + Linux 内核能力（cgroup v2 / netns / NBD / userfaultfd / nftables / iptables）+ 远端存储（GCS / Local）+ 控制平面（Consul / Redis / LaunchDarkly / ClickHouse）** 编织成一个**带状态机的沙箱生命周期管理器**。SDK 的"在沙箱里跑命令"经过 API → orchestrator → Firecracker + envd 才落地。

它解决的核心问题：

1. **沙箱生命周期** —— Create / Pause / Resume / Delete / Checkpoint，附 6 态状态机。
2. **秒级冷启动** —— 基于 userfaultfd 按需分页 + 模板缓存 + 跨节点 P2P 块传输。
3. **写时复制存储** —— 每个 sandbox 拿到一份只读模板 rootfs + 本地 NBD 写盘 + 块级 dedup。
4. **网络隔离** —— 每沙箱独立 netns + veth/vpeer + nftables 防火墙 + 可选 egress 域名/CIDR 策略。
5. **资源治理** —— cgroup v2 统计 CPU / 内存峰值；信号量限制并发启动数。
6. **持久卷** —— NFS-over-Unix-socket proxy + portmapper 让 VM 内可挂载跨沙箱持久化的 volume。
7. **流量路由** —— 反向代理把 `:port` 流量按 sandbox id 转发到对应 VM。
8. **可观测性** —— OTLP 三件套（trace/metric/log）+ ClickHouse 事件 + Redis pub/sub。

---

## 2. 进程拓扑

```
packages/orchestrator/main.go           // linux-only 入口
   └── factories.Run(opts)              // 阻塞直至关闭
        ├── cfg.Parse()                  // 解析环境变量 → cfg.Config
        ├── ensureDirs()                 // 创建 7 个缓存目录
        ├── 文件锁 OrchestratorLockPath    // 防止崩溃后双开
        ├── telemetry.New(...)            // OTEL client（含 logs provider）
        ├── logger 替换全局 + sandbox logger（internal/external）
        ├── sandbox.NewSandboxesMap()     // 共享 sandbox 字典（pub-sub）
        ├── featureflags.NewClient()      // LaunchDarkly
        ├── storage.GetStorageProvider()  // GCS 或 Local
        ├── redisClient + peerRegistry    // 跨节点 P2P 路由表
        ├── template.NewCache(...)        // 模板缓存（核心）
        ├── eventsService                 // 多目标事件分发（ClickHouse + Redis）
        ├── cgroup.NewManager()           // 根 cgroup
        ├── metrics.NewSandboxObserver()  // OTLP 周期采集
        ├── metrics.NewHostMetrics()      // gopsutil 主机采样
        ├── proxy.NewSandboxProxy()       // 反向代理
        ├── EgressFactory(deps)           // tcpfirewall.New（出口防火墙）
        ├── nbd.NewDevicePool()           // NBD 设备池
        ├── network.NewPool()             // netns slot 池（Consul KV）
        ├── sandbox.NewFactory()          // ⭐ 沙箱工厂（依赖注入容器）
        ├── chrooted.NewBuilder() + volumes.New()  // NFS 卷
        ├── server.New(...)               // ⭐ gRPC Server 聚合
        ├── hyperloopserver.NewHyperloopServer()
        ├── nfsproxy + portmapper         // 持久卷代理（仅当配置了 VolumeMounts）
        ├── grpcServer 注册：
        │     • SandboxService  (Create/Update/List/Delete/Pause/Checkpoint/ListCachedBuilds)
        │     • VolumeService   (CreateVolume/ListDir/GetFile/CreateFile/...)
        │     • ChunkService    (GetBuildFileSize/ReadAtBuildSeekable/GetBuildBlob/...)
        │     • TemplateService (TemplateCreate/TemplateBuildStatus/...)
        │     • InfoService     (ServiceInfo / ServiceStatusOverride)
        │     • grpc_health_v1
        ├── cmux Server（同端口复用 gRPC 与 HTTP/1）
        ├── httpServer（/health + /upload）
        ├── pprof Server（独立 goroutine）
        └── 等待 sigterm/sigint → drain 阶段 → 反向 closer 链 → GracefulStop
```

**关键设计：依赖注入 + 反向 closer 链**
- `Deps` 结构把共享基础设施（Config/Tel/MeterProvider/Logger/Sandboxes/FeatureFlags）打包给 edition-specific 工厂。
- `closers []closer` 是后进先出的清理链；每个服务在启动时注册 closer，关闭时 `slices.Reverse` 后逐个调用，确保依赖顺序正确。
- `errgroup.Group` 包装所有长跑服务；任一服务返回非 `serviceDoneError` 错误就触发整体关闭。

---

## 3. gRPC 契约（5 个 proto）

### 3.1 `orchestrator.proto` — SandboxService（核心）

```protobuf
service SandboxService {
  rpc Create(SandboxCreateRequest) returns (SandboxCreateResponse);
  rpc Update(SandboxUpdateRequest) returns (google.protobuf.Empty);
  rpc List(google.protobuf.Empty) returns (SandboxListResponse);
  rpc Delete(SandboxDeleteRequest) returns (google.protobuf.Empty);
  rpc Pause(SandboxPauseRequest) returns (SandboxPauseResponse);
  rpc Checkpoint(SandboxCheckpointRequest) returns (SandboxCheckpointResponse);
  rpc ListCachedBuilds(google.protobuf.Empty) returns (SandboxListCachedBuildsResponse);
}
```

`SandboxConfig` 字段（部分）：`template_id / build_id / kernel_version / firecracker_version / huge_pages / sandbox_id / env_vars / metadata / envd_version / vcpu / ram_mb / team_id / max_sandbox_length / total_disk_size_mb / snapshot / base_template_id / auto_pause / envd_access_token / execution_id / allow_internet_access / network / volumeMounts / auto_resume`。

`SchedulingMetadata`（在 Create/Pause/Checkpoint 响应里）告诉 API 每个沙箱引用了哪些 build 层、各层的字节数、被丢弃的轻量层数量 —— 用于把跨节点的存储热度反馈回调度层。

### 3.2 `chunks.proto` — ChunkService（节点间 P2P）

```protobuf
service ChunkService {
  rpc GetBuildFileSize(GetBuildFileSizeRequest) returns (GetBuildFileSizeResponse);
  rpc GetBuildFileExists(GetBuildFileExistsRequest) returns (GetBuildFileExistsResponse);
  rpc ReadAtBuildSeekable(ReadAtBuildSeekableRequest) returns (stream ReadAtBuildSeekableResponse);
  rpc GetBuildBlob(GetBuildBlobRequest) returns (stream GetBuildBlobResponse);
}
```

每个响应都附带 `PeerAvailability { not_available, use_storage }`：当本节点缓存没有该 build 时，调用方应该回退到远端对象存储。这是**热恢复路径绕过 GCS** 的关键。

### 3.3 `info.proto` — InfoService（节点自描述）

```protobuf
enum ServiceInfoStatus { Healthy=0; Draining=1; Unhealthy=2; Standby=3; }
enum ServiceInfoRole { TemplateBuilder=0; Orchestrator=1; }

service InfoService {
  rpc ServiceInfo(Empty) returns (ServiceInfoResponse);
  rpc ServiceStatusOverride(ServiceStatusChangeRequest) returns (Empty);
}
```

`ServiceInfoResponse` 包含 node_id、版本、commit、状态、角色、MachineInfo（CPU arch/family/model/flags）以及一系列 metric_*（运行沙箱数、CPU、内存、磁盘）。调度器通过此 RPC 做节点选择。

### 3.4 `template-manager.proto` — TemplateService（构建侧）

由 `pkg/template/server` 实现，提供 `TemplateCreate / TemplateBuildStatus / TemplateBuildDelete / InitLayerFileUpload`。这部分负责把用户定义的 Dockerfile / from-template / from-image 转化为可启动的 rootfs 快照。

### 3.5 `volume.proto` — VolumeService（持久卷文件操作）

`CreateVolume / DeleteVolume / CreateDir / ListDir / CreateFile(stream) / GetFile(stream) / DeletePath / StatPath / UpdatePath` —— 让 API 层可以管理持久卷里的文件，orchestrator 通过 chrooted 文件系统抽象在 host 上直接操作。

---

## 4. Sandbox 生命周期状态机

```
                  ┌──────────────┐
   Create ───────▶│   Creating   │
                  └──────┬───────┘
                         │ WaitForEnvd 成功
                         ▼
            ┌── keep_alive ──────┐
            │                    │ timeout / evict
   resume   │   ┌────────────┐   │
   ┌────────┴───┤   Running  ├───┘
   │   Paused   │            │
   │ (snapshot) └─────┬──────┘
   └────────────┬─────┘
                │ Delete / error
                ▼
        ┌────────────────┐
        │ Killing / Dead │
        └────────────────┘
```

完整流程详见 `docs/sandbox-lifecycle.md`。orchestrator 的职责是把每个状态迁移**原子化**：先校验前置条件、再执行、最后通过 `Cleanup` 注册回滚。

---

## 5. 核心子系统原理

### 5.1 Sandbox Factory（`pkg/sandbox/sandbox.go`）

```go
type Factory struct {
    Sandboxes         *Map                // 全局 sandbox 字典（pub-sub）
    config            cfg.BuilderConfig
    networkPool       *network.Pool       // netns 槽位
    devicePool        *nbd.DevicePool     // /dev/nbd 设备
    featureFlags      *featureflags.Client
    hostStatsDelivery hoststats.Delivery  // ClickHouse 上报
    cgroupManager     cgroup.Manager
    egressProxy       network.EgressProxy
}
```

`Sandbox` 结构（`sandbox.go:235`）组合：
- `*Resources` —— network slot、cgroup handle、FC process
- `*Metadata` —— startedAt / endAt（带 RWMutex）
- `LifecycleID` —— **每次 FC 进程启动都变**，与稳定的 `ExecutionID` 区分
- `config / files / cleanup / featureFlags / process / cgroupHandle / Template / Checks / hostStatsCollector`
- `exit *utils.ErrorOnce` —— 多生产者单消费者错误汇聚
- `stop utils.Lazy[error]` —— 一次性 stop 操作

**两个核心方法**：

`CreateSandbox`（`:345`）冷启动模板 → 顺序：
1. `getNetworkSlot` —— 从池里要一个 netns slot（promise 模式）
2. `template.Files().NewSandboxFiles(sandboxID)` —— 生成 sandbox-local 文件路径
3. `template.Rootfs()` → `rootfs.NewNBDProvider` 或 `NewDirectProvider`（看是否有 cache path）
4. `template.Memfile()` —— 内存模板（用于 UFFD）
5. `preBootFn` —— 给 template-manager 一个机会在 boot 前改 rootfs
6. `createCgroup` —— 通过 cgroupManager 创建沙箱根 cgroup
7. `fc.NewProcess` —— 配置 Firecracker 进程（API socket、drives、MMDS、kernel args）
8. （后续：UFFD 启动、FC 启动、envd /init、注册到 Sandboxes Map）

`ResumeSandbox`（`:598`）从快照恢复 → 共享大量 CreateSandbox 的资源初始化逻辑，但 FC 用 `LoadSnapshot` 而非 `Boot`。

**关键不变量**：`Cleanup`（`cleanup.go`）是一个延迟回调队列，分 `cleanup` + `priorityCleanup` 两档；任一步失败时 `cleanup.Run(ctx)` 按 LIFO 回滚已注册的资源（NBD、cgroup、netns slot、socket file）。`sync.Once` 保证只 Run 一次，Run 之后 Add 立即同步执行。

### 5.2 块设备子系统（`pkg/sandbox/block/`）

这是 E2B 性能优化的核心战场。

#### `Cache`（`cache.go`，~825 行）

按 `blockSize`（通常 4 KiB）对齐的 mmap 文件缓存：

```go
type Cache struct {
    filePath  string
    size      int64
    blockSize int64
    mmap      *mmap.MMap
    mu        sync.RWMutex
    tracker   *Tracker       // 脏块位图（RoaringBitmap）
    dirtyFile bool
    closed    atomic.Bool
}
```

能力：
- **Dedup** —— 在 fetch window / promoted frames / per-block budget 约束下，与父级 build 的块对比，相同则用引用替代拷贝（`dedup.go`）。
- **Dirty 回写** —— `tracker` 维护脏块位图；`ExportToDiff` 把脏块导出为差分。
- **零块路由** —— 全零块映射到 `Empty`（`empty.go`），无需分配存储，是 hole-punch 的基础。
- **OOM 退避** —— `oomMinBackoff + oomMaxJitter`，避免 mmap 写入触发 OOM 时直接 crash。

#### `Local`（`local.go`）

基于 `os.File` 的 `ReadAt / WriteAt / Slice / Header`，是 `ReadonlyDevice` 与 `Device` 的最薄包装。

#### `Empty`（`empty.go`）

全零块设备，读返回零字节，不分配存储。dedup 与 hole-punch 的终点。

#### `Memfd`（与 UFFD 联动）

通过 `memfd_create` 创建匿名内存文件，被 Firecracker 用作内存 backend；与 UFFD 配合实现按需分页。

#### `Device / Slicer / FramedReader` 接口（`device.go`）

统一的 I/O 抽象，让上层 nbd / rootfs / template 模块能在不同后端（local / memfd / remote peer / GCS）之间切换。

#### `Cache.ExportToDiff` 流程（`cache.go:109`）

Pause 时把脏块导出成差分文件：

1. `unix.SyncFileRange(src, 0, size, SYNC_FILE_RANGE_WRITE)` —— 提前标记写回（best-effort，失败仅 warn）。
2. `tracker.Export()` 同时返回 `dirty` 与 `empty` 两个 `roaring.Bitmap`：
   - `dirty` —— 实际有数据变更的块（导出为 diff payload）。
   - `empty` —— 全零块（不导出字节，恢复时映射到 `Empty`）。
3. 遍历 `BitsetRanges(dirty, blockSize)`，对每个 range 调 `unix.CopyFileRange`：
   - **XFS**：自动走 reflink（CoW，秒级）。
   - **其它 FS / EXDEV / EOPNOTSUPP / ENOSYS**：切换 fallback，用 `io.Copy` + `SectionReader` 读 memfd。
4. 处理短写：内核可能在 `MAX_RW_COUNT` 处截断，外层 loop 直到 `remaining == 0`。
5. 上报 `copy_ms / total_size_bytes / dirty_size_bytes / empty_size_bytes / total_ranges` 到当前 trace span。

#### Tracker：双位图不变量

`Tracker` 维护两个 roaring bitmap，关系：

- `dirty ⊨ 实际有数据` —— 被 NBD write 命中。
- `empty ⊨ 该块被写过零` —— 被 NBD trim/write-zero 命中，或被 `Empty` 模板替换。
- `dirty ∩ empty = ∅` —— 写入真实数据时清除 empty；写入零时清除 dirty。

`dedupDrain`（`cache.go:208`）从 memfd 把"页面级 dirty"重新打包成块对齐文件，用于 memfile dedup 路径，避免 dedup 输出与 chunker 还原粒度不一致。

### 5.3 NBD 设备层（`pkg/sandbox/nbd/`）

每个 sandbox 的「磁盘」其实是一个本地 `/dev/nbdX` 设备，由 orchestrator 通过 NBD 协议喂食。

- `pool.go` —— 全局 NBD 设备池（受 `nbds_max` 内核参数限制），支持超时与无限重试。
- `dispatch.go` —— NBD 协议分发器，把 read/write/trim 等命令路由到 `Provider`。
- `path_direct.go` —— `DirectPathMount`：用 `io_uring/dispatcher` 直接读 `ReadonlyDevice`，支持 SOCKS 代理（用于跨节点 P2P）。
- `devicehelper.go` / `mounthelper.go` —— 分配与挂载辅助。

**写时复制流程**：
```
sandbox 写 → /dev/nbdX → dispatch → block.Cache
                                         │
                          ┌──────────────┼──────────────┐
                          ▼              ▼              ▼
                      mmap 文件      父级块        Empty(零块)
                      (本次脏块)    (去重引用)     (hole punch)
```

### 5.4 UFFD 按需分页（`pkg/sandbox/uffd/`）

userfaultfd 是 Linux 提供的"用户态缺页处理"机制。E2B 用它把"一次性把整个 rootfs 装入内存"变成"按需从远端拉取"。

- `uffd.go:38` `Uffd` —— UFFD server，监听 Unix socket 等 Firecracker 连接。
- `fd.go` —— 封装 `userfaultd` ioctl：`uffdio_api / range / register / copy / zero / write_protect`。
- `memory/` —— 内存 backend 抽象。
- `memory_backend.go` —— 多种实现选择（memfd / file / remote）。
- `prefetch/` —— **预取**：根据历史访问模式（`MemoryPrefetchMapping`）在 boot 前批量触发热页 fault，避免 cold-start 抖动。
- `userfaultfd/` —— 跨进程 uffd 测试工具（fork 子进程做 helper）。
- `barriers.go` —— 跨进程 fault barrier 同步原语（用于确定性并发测试）。
- `deferred.go` —— `deferredFaults`：按地址去重 fault，read 可升级为 write fault，减少重复处理。
- `counter_reporter.go` —— 周期输出 fault / copy / write-protect 计数到日志。

**关键 metric**（`sandbox.go:60-65`）：
- `orchestrator.sandbox.uffd.startup.pages`
- `orchestrator.sandbox.uffd.startup.source_pages`
- `orchestrator.sandbox.uffd.startup.bytes`

通过 `start_type = "create" | "resume"` 区分冷启动与热恢复。

#### UFFD ↔ Firecracker 握手协议（`uffd.go:121` `handle`）

```
1. uffd.lis.Accept() ← Firecracker 主动连过来（FC 启动时 uffd socket 被作为内存 backend 指定）
2. 读 Unix 消息：
   - regionMappingsBuf（JSON 编码的 []memory.Region，最多 1 KiB）
   - fdBuf（CMSG 辅助数据，含 1 或 2 个 fd）
3. 解析 cmsg → fds[0] = uffd 文件描述符，fds[1] = memfd（新版 FC 才有）
4. memory.NewMapping(regions) → userfaultfd.NewUserfaultfdFromFd(...)
5. u.handler.SetValue(uffd) ← unblock 所有 Prefault waiter
6. close(u.readyCh) ← 通知 uffd ready
7. uffd.Serve(ctx, fdExit) ← 进入 fault 处理循环，直到 fdExit.SignalExit()
```

**generation 标记**：`memfile.Header().Metadata.Generation` 是 pause/resume 周期计数，被注入到每次 fault 的 metric attribute，让延迟可以按 snapshot chain 深度切片（链深的快照 fault 会更慢）。

#### `DiffMetadata` 同步点（`uffd.go:250`）

`DiffMetadata(ctx, fc)` **只能在 `Pause + CreateSnapshot` 之后调用**：

1. `handler.ExportPageStates()` —— settle 所有 in-flight UFFD worker，导出当前 `(zero, empty)` 位图（zero = write-protect 装好的页，empty = 已 zero-copy 装入的页）。
2. `fc.DirtyMemory(ctx, pageSize)` —— 通过 FC API 拉取 WP-async pagemap，得到 `diff.Dirty`。
3. `empty.AndNot(diff.Dirty)` —— **关键不变量**：先 zero-install 后 write 的页同时出现在两个位图里，dirty 必须胜出（否则恢复时该页会被错误映射为 empty）。
4. 返回 `header.DiffMetadata{ BlockSize, Dirty, Empty }`，给 `pauseProcessMemory` 用。

`Settle` 的目的：防止 Zero→Write 装页操作插在两次采样之间、同时逃过两个位图。

### 5.5 模板缓存与跨节点 P2P（`pkg/sandbox/template/`）

`Cache`（`cache.go:51`）：

```go
type Cache struct {
    config        cfg.Config
    flags         *featureflags.Client
    cache         *ttlcache.Cache[string, Template]  // 25 小时 TTL
    persistence   storage.StorageProvider            // GCS / Local
    buildStore    *build.DiffStore
    blockMetrics  blockmetrics.Metrics
    rootCachePath string
    peers         peerclient.Resolver                // P2P 路由
    extendMu      sync.Mutex
}
```

设计要点：
- TTL 25 小时 + 1 小时 buffer（大于沙箱最大生命期，避免缓存驱逐活跃模板）。
- `OnEviction` 调用 `template.Close()` 与 `peers.Purge(key)` —— 释放 mmap、注销 P2P 路由。
- `hitsMetric` / `missesMetric` —— 命中率监控。

#### `Template` 抽象（`template/template.go`）

把 memfile / rootfs / snapfile 统一抽象为 `Template.Close()`，让上层不感知具体后端。

#### Peer-to-Peer 块传输

`peerclient/`（peer 客户端） + `template/file.go`（peer server 端的流式发送器）：

1. orchestrator A 想读 build X 的某个块。
2. 通过 `peerclient.Resolver`（基于 Redis 的全局注册表）找到 orchestrator B 有缓存。
3. 通过 gRPC `ChunkService.ReadAtBuildSeekable` 从 B 流式拉取。
4. 若 B 同时正在上传到 GCS，B 会在响应里设 `use_storage=true`，让 A 直接走 GCS。
5. 若 B 没有该 build，响应 `not_available=true`，A 回退到 GCS。

`header.go` 处理 V4 header（强制标记 in-flight 位）；`header_metrics.go` 记录 header 形状指标用于优化。

#### 构建上传：V3 vs V4 协议对比

`build_upload.go` 根据 `MemfileDiffDedupFlag` 选择 V3 或 V4 上传协议。两者都把 memfile / rootfs diff、snapfile、metadata 并发上传到 GCS（用 `errgroup`），但细节不同：

| 维度 | V3 (`build_upload_v3.go`) | V4 (`build_upload_v4.go`) |
|---|---|---|
| 头协议 | `finalizeV3(h)` 旧版 header 序列化 | framed + checksum，强标 in-flight 位 |
| 数据上传 | `storage.UploadFramed` + 无压缩 | `storage.UploadFramed` + `WithCompressConfig + WithChecksumSHA256` |
| 祖先链 | 不合并 | **合并祖先 metadata**：把父级 build 的引用计入新 header |
| 校验 | 无 | SHA-256 checksum 端到端校验 |
| 适用 | 兼容老 FC 版本 | 新部署默认 |

V4 的 `uploadFramed` 还会传 `seekableTypeFor(fileType)`，让下游 reader 知道这是 seekable diff（可用 `ReadAtBuildSeekable` 范围读），不是 blob。

#### Snapshot 与异步 header 解析（`snapshot.go` + `sandbox.go:1184`）

`Snapshot` 结构持有：

```go
type Snapshot struct {
    MemfileDiff, RootfsDiff  build.Diff
    MemfileDiffHeader        *DiffHeader   // SetOnce[*header.Header]
    RootfsDiffHeader         *DiffHeader
    Snapfile, Metafile       template.File
    BuildID                  uuid.UUID
    SchedulingMetadata       *orchestrator.SchedulingMetadata
    MemfileBlockSize         uint64
    RootfsBlockSize          uint64
    cleanup                  *Cleanup
}
```

`MemfileDiffHeader` 是 `utils.SetOnce[*header.Header]`，**故意异步**：`pauseProcessMemory` 在 goroutine 里跑 memfd-dedup compare，`Pause` 本身不阻塞等待结果。`Upload.runV3`/`runV4` 在另一个 errgroup 里 `MemfileDiffHeader.WaitWithContext`，所以 dedup 慢不阻塞 snapshot 返回、但会阻塞上传。

`MemfileBlockSize` / `RootfsBlockSize` 同步捕获的原因（注释解释）：dedup 路径输出的 `Diff.BlockSize()` 是页面粒度，与 restore 时 chunker 读取的块粒度不匹配 —— 压缩校验需要原始块大小，不能等 header 异步解析。

#### 调度元数据：chainLimit 与最轻层丢弃（`pkg/scheduling/metadata.go`）

`SchedulingMetadata` 通过 `scheduling.FromHeaders` 构建，把每个 artifact 引用过的所有 build ID（祖先链 + 当前层）报告给 API：

- `chainLimit = 128`：每 artifact 最多 128 个 build ID。
- `pinned(id, base, build)`：base（根层）与 build（当前层）**永远保留**，不可丢弃。
- 超过 cap 时按 `bytesByID[id]` **从轻到重**排序丢弃（"lightest first"），让最有热度的链路优先匹配节点。
- 列表最终按 UUID 字符串排序 —— 顺序无意义，但稳定可比较。

这给 API 层的 placement 算法（BestOfK）提供"哪个节点已经有最多祖先层缓存"的输入，最大化 cache 命中率。

### 5.6 网络隔离（`pkg/sandbox/network/`）

每个 sandbox 拿到一个独立 netns，内含 veth/vpeer 对、IP、MAC、TAP、防火墙规则。

- `pool.go` —— 全局 slot 池，预热 `NewSlotsPoolSize` 个，复用 `ReusedSlotsPoolSize` 个。
- `slot.go` —— 单沙箱网络视图：`NamespaceID / VethName / VpeerName / VpeerIP / VrtMask / TAPName / 防火墙`。
- `network.go:21` `Slot.CreateNetwork` —— `runtime.LockOSThread` → `netns.NewNamed` → 建 veth → 配 IP → 写 iptables/转发规则。
- `firewall.go` —— 基于 `nftables` 的入站/出站规则、IP 集合、用户 CIDR 黑白名单。
- `egressproxy.go` —— `EgressProxy` 接口（由 `pkg/tcpfirewall` 实现），用于 slot 创建/删除时挂钩出口流量。
- Storage 三态：
  - `storage_kv.go` —— Consul KV，跨节点协调（生产）。
  - `storage_local.go` —— 本地文件，单机模式。
  - `storage_memory.go` —— 进程内 map，测试用。

### 5.7 Firecracker 进程管理（`pkg/sandbox/fc/`）

- `process.go` —— `Process` 类型，封装 Firecracker 子进程的生命周期（`exec.Cmd` + API socket + metrics FIFO + 日志 pipe）。
- `client.go` —— Firecracker REST API 客户端：`putGuestDrive / putMmds / startVM / balloon / memory / loadSnapshot / createSnapshot`。
- `config.go` —— 解析 Firecracker 二进制路径与 host 内核路径（arch 前缀优先，legacy 回退）。
- `script_builder.go` —— 动态构建 FC 启动脚本（kernel_args、drive 配置等）。
- `kernel_args.go` —— `KernelArgs` 类型，把 map 序列化为排序稳定的 boot 参数字符串。
- `memory.go` —— `MemoryInfo / DirtyMemory / ExportMemory`，监控 dirty page 平衡（snapshot 前用）。
- `fc_metrics.go` —— 解析 metrics FIFO 的 JSON 行，上报 net/block/balloon 维度。
- `fph_gates.go` —— 根据 FC 版本字符串判断是否支持 free-page-hinting / memfd。
- `drain_balloon_test.go` —— free-page-hint 轮询的快速重试测试。

**日志降噪**：`fcLogFilter`（`process.go:47`）抑制 Firecracker 周期性的 `FlushMetrics` 请求/响应日志对，因为 FC API server 单线程保证了它们总是相邻。

### 5.8 envd 通信（`pkg/sandbox/envd.go`）

`Sandbox.doRequestWithInfiniteRetries`（`:40`）—— **无限重试**直到 ctx done 的 `/init` 调用：

```go
jsonBody := &envd.PostInitJSONBody{
    LifecycleID:    s.LifecycleID,
    EnvVars:        s.Config.Envd.Vars,
    HyperloopIP:    s.config.NetworkConfig.OrchestratorInSandboxIPAddress,
    AccessToken:    utils.DerefOrDefault(s.Config.Envd.AccessToken, ""),
    DefaultUser:    ...,
    DefaultWorkdir: ...,
    VolumeMounts:   s.convertMounts(s.Config.VolumeMounts),
    CaBundle:       s.CABundle,
}
```

每次循环：刷新 `Timestamp` → 序列化 → 带 `X-Access-Token` 头 → 发请求；失败后 sleep `loopDelay=5ms` 重试。

辅助方法：
- `callEnvdFreeze` / `callEnvdUnfreeze` —— 调用 envd 的 `/freeze` / `/unfreeze` 端点（直接操作 cgroup，不走 Process.Start）。
- `WaitForEnvd`（`:1488`）—— 等待 envd /health 就绪，记录 uffd startup metric（仅第一次记录，避免后续 init 把累积 fault 算进去）。
- `envd_process.go` —— 通过 gRPC 在 envd 上启动用户 shell / system shell。

#### Pre-pause reclaim 流程（`reclaim.go`）

`bestEffortReclaim` 在 `Pause` 主路径里**非阻塞**执行：

1. **可选 freeze**（`featureflags.FreezeUserCgroupFlag`）—— 通过 envd `/freeze` 冻结 user cgroup，2 秒超时（`freezeTimeout`），与 reclaim 共享脚本超时独立。
2. **reclaim 脚本**（`buildReclaimScript`）—— 把四条命令串成一个 `sh -c`：

| 步骤 | 命令 | LD flag 控制（默认禁用） |
|---|---|---|
| fstrim | `fstrim -av` | `cfg.Fstrim` |
| sync | `sync` | `cfg.Sync` |
| drop caches | `echo 3 > /proc/sys/vm/drop_caches` | `cfg.DropCaches` |
| compact memory | `echo 1 > /proc/sys/vm/compact_memory` | `cfg.CompactMemory` |

每条命令用 `timeout -s KILL <cap>s` 单独限时，整体 = `sum(caps) + 500ms slack`（`reclaimOuterSlack` 覆盖 shell 启动 + envd 往返开销）。任一步骤 `rc != 0` 仅记录 warn，**绝不阻塞 pause**。

3. 通过 `StartEnvdSystemShell(ctx, "/bin/sh", ["-c", script], "root", timeout)` 在 sandbox 里执行，stream 退出码非 0 仅告警。
4. cleanup 注册 `bestEffortUnfreeze` —— Pause 失败时（沙箱还活着）必须解冻，否则会留下永久冻住的活沙箱。`context.WithoutCancel` 防止 cleanup 路径的 ctx 已被取消。

#### envd 版本门控（`reclaim.go:114`）

`envdSupportsCgroupFreeze` 用 `utils.IsGTEVersion(envd.Version, MinEnvdVersionForCgroupFreeze)` 判断：

- 老版 envd 没有 `/freeze` / `/unfreeze` 端点，调用会 404。
- 版本字符串解析失败时**返回 false**（绝不"意外调到不支持的端点"）。
- 失败 → 直接走 shell-based freeze（兼容老版本沙箱）。

### 5.9 NFS Proxy（`pkg/nfsproxy/`）

为 VM 内的持久卷提供 NFS-over-TCP 入口。

- `proxy.go` —— `Proxy` 组合 `chroot NFSHandler` 与 `cacheHandler`，按配置叠加四层装饰：tracing / metrics / logging / recovery。
- `chroot/nfs.go` —— 核心 `NFSHandler`：根据请求路径解析 sandbox/volume，挂载对应的 chroot 视图。
- `chroot/fs.go` —— chrooted `billy.Filesystem`，强制所有 FS 操作限制在挂载点内（防越界）。
- `chroot/fs_failed.go` —— mount 失败时退化的 Filesystem，所有操作返回挂载错误（防 nil panic）。
- `portmap/`（`pkg/portmap`）—— RFC 1057 portmap 协议实现，注册 NFS 端口（2049）。

**装饰器栈**（ onion 模式）：
```
recovery → logging → metrics → tracing → chroot → billy.Filesystem
```
每层用 `Wrap*` 函数包装下一层，单元测试覆盖每一层。

### 5.10 出口防火墙（`pkg/tcpfirewall/`）

- `proxy.go` —— 入口：按 HTTP/TLS/其他协议分别监听，按 sandbox egress 规则代理到上游。
- `handlers.go` —— 按协议检查域名/CIDR 规则，通过透明代理重定向。
- `metrics.go` —— Prometheus 指标：连接数、错误、决策分布、活跃连接、连接时长。
- `listener.go` —— 瞬时 accept 错误时退避重试的 `net.Listener` 包装。

由 `main.go:defaultEgressFactory` 注入，作为 `EgressSetup.Proxy` 提供给网络池做 slot 创建/删除时的挂钩。

### 5.11 Sandbox 反向代理（`pkg/proxy/`）

`SandboxProxy`（`proxy.go:39`）把外部 SDK 请求路由到正确 sandbox：

- 从 URL 解析 sandbox id + port（`getTargetFromRequest`）。
- 查 `sandboxes.Get(sandboxId)` 找到目标。
- 校验 ingress `trafficAccessToken`（非 envd 流量必校验）。
- 用连接池（`pool.Destination`）转发，5 次重试覆盖 envd 端口转发延迟。
- `connlimit` 限制每沙箱并发连接（受 `featureflags.SandboxMaxIncomingConnections` 控制）。
- idle timeout 620s（> GCP LB 600s，避免竞态）。

`SandboxProxy` 实现 `sandbox.MapSubscriber`，自动同步沙箱字典变更。

### 5.12 服务发现与调度（`pkg/service/`、`pkg/scheduling/`）

- `service/service_info.go` —— `InfoService` 实现，返回 `ServiceInfoResponse`（节点身份、CPU/内存、MachineInfo）。
- `service/main.go` —— 通过 `/proc/cpuinfo` 探测 CPU 系列/型号/特性/架构，用于节点池匹配（同一 template 的 build 必须在相同 CPU family 上 resume，否则 SIGILL）。
- `scheduling/metadata.go` —— 从 gRPC metadata headers 解析节点身份与 pin 状态，作为调度决策输入。

### 5.13 健康检查（`pkg/healthcheck/`）+ `Sandbox.Checks`（`checks.go`）

`/health` HTTP 端点聚合两类信息：
1. 节点级 —— `ServiceInfoStatus`（Healthy/Draining/Unhealthy/Standby）。
2. 沙箱级 —— `Checks` goroutine 周期通过 envd 查询每个沙箱状态，上报 OTEL/Loki。

`Checks.Start` / `Checks.Stop` 严格时序处理（`checks_test.go` 验证 Stop 早于 Start 时不启动循环）。

#### Checks 竞态处理（`checks.go:26`）

短命沙箱（创建后立刻 Stop）会触发"Stop 在 Start 之前被调度"的竞态。Checks 用三层保护：

```go
type Checks struct {
    sandbox  *Sandbox
    mu       sync.Mutex
    cancelCtx context.CancelCauseFunc  // Start 时才赋值
    stopped  bool                       // Stop 跑过就置位
    healthy  atomic.Bool
    UseClickhouseMetrics bool
}
```

- `Start` 加锁后先看 `stopped`，若为 true 直接 return（不进入 `logHealth` 死循环）。
- `Stop` 设 `stopped=true`，若 `cancelCtx != nil` 则取消（`ErrChecksStopped` 作为 cause）。
- `healthy.CompareAndSwap(true, false)` —— **边沿触发**，仅在状态翻转时上报，避免 20s 周期上报的洪水。

#### HostStatsCollector：saturating 防溢出（`hoststats_collector.go:74`）

```go
func saturatingSub(a, b uint64) uint64 {
    if a < b {
        return 0
    }
    return a - b
}
```

cgroup 计数器在 sandbox resume / cgroup 迁移后可能"重置"（base 跳变）。直接 `a - b` 在 uint64 下会环绕到巨大值，污染差分指标。`saturatingSub` 把这种情况钳到 0。采样间隔最少 100ms（构造时强制提升），避免高频 cgroup 读取拖垮请求路径。

### 5.14 metrics（`pkg/metrics/`）

- `host.go` —— `HostMetrics`：gopsutil 周期采样 CPU/内存/磁盘，**无锁读取接口**避免请求路径阻塞。
- `sandboxes.go` —— `SandboxObserver`：通过 OTLP exporter 周期收集 sandbox 维度指标，支持按 envd 版本能力门控（不同版本暴露不同字段）。

### 5.15 事件分发（`pkg/events/`）

`EventsService` —— 多目标 fan-out：

```go
sbxEventsDeliveryTargets = append(
    sbxEventsDeliveryClickhouse,  // 主目标
    sbxEventsDeliveryClickhouse2, // 备用 / 多 endpoint
    sbxEventsDeliveryRedis,       // pub/sub 给 client-proxy
)
```

每个目标独立 batcher 与连接池，慢/失败 endpoint 不阻塞其它。

### 5.16 配置（`pkg/cfg/model.go`）

`cfg.Config` 涵盖：路径（`DefaultCacheDir / OrchestratorBaseDir / SandboxDir / SharedChunkCacheDir`）、端口（`GRPCPort / ProxyPort / PortmapperPort / NFSProxyPort / HyperloopProxyPort`）、存储（GCS / Local）、ClickHouse（多 endpoint，主备隔离）、Redis、LaunchDarkly、NodeLabels、NetworkConfig、CgroupRoot 等。

`GetServices(config)` 决定进程扮演的角色（Orchestrator、TemplateBuilder、TemplateManager），同二进制可同时承担多个角色。

### 5.17 chrooted 文件系统（`pkg/chrooted/`）

- `chroot.go` —— chrooted FS 抽象。
- `mountns.go` —— Linux mount namespace 工具，在临时 ns 内挂载文件系统。
- `fs.go / change.go / builder.go` —— 文件操作薄包装。
- 给 `pkg/volumes`（VolumeService）与 `pkg/nfsproxy` 提供"沙箱 root 视图"，所有写操作严格限制在挂载点内。

### 5.18 Hyperloop Server（`pkg/hyperloopserver/`）

- `server.go` —— Gin HTTP server + H2C（HTTP/2 cleartext），启用请求大小限制与 oapi 请求校验。
- `handlers/logs.go` —— `/logs` 转发日志查询请求到沙箱。
- `handlers/me.go` —— `/me` 返回节点信息。
- 提供给 VM 内 envd 通过 hyperloop（vsock-like）回调宿主，把 sandbox 内部日志/事件流出去。

### 5.19 本地上传（`pkg/localupload/`）

仅 `STORAGE_PROVIDER=Local` 模式启用：

- HMAC 签名 token + 过期时间校验。
- 路径穿越（`..`）检测。
- 临时文件 + 原子 rename 实现安全写入。
- 给 template-manager 的本地构建产物上传提供端点。

---

## 6. 关键交互流程

### 6.1 冷启动 Create（`pkg/server/sandboxes.go:Create`）

```
API → gRPC SandboxService.Create
  ├─ ctx 60s timeout
  ├─ tracing: sandbox-create span
  ├─ LD context: sandbox + team + version
  ├─ 检查 MaxSandboxesPerNode → ResourceExhausted 拒绝
  ├─ 若 snapshot=true (resume) → waitForAcquire (startingSandboxes 信号量)
  ├─ templateCache.GetOrCreate(ctx, buildID, kernelVersion, fcVersion, ...)
  │    └─ 若本地缓存 miss → 从 GCS 或 peer 拉取 → 注册 mmap
  ├─ sandboxFactory.CreateSandbox / ResumeSandbox（见 5.1）
  │    ├─ getNetworkSlot → netns + veth + nftables
  │    ├─ template.Rootfs → NBD Provider 启动（写盘走 block.Cache）
  │    ├─ template.Memfile → UFFD server 启动
  │    ├─ createCgroup → cgroup v2 子组
  │    ├─ fc.NewProcess → FC 子进程 + API socket
  │    ├─ fc.Start → 加载内核 + drives + MMDS
  │    ├─ uffd 处理 FC 内存 fault（按需从模板拉页）
  │    ├─ WaitForEnvd → /health 轮询
  │    └─ envd /init（无限重试）→ 注入 env/token/CA/NFS mounts
  ├─ 记录 sandboxCreateDuration（按 resume=true/false 标签）
  └─ 返回 {client_id, scheduling_metadata}
```

### 6.2 Pause / Checkpoint

```
API → SandboxService.Pause
  ├─ Sandbox.Pause(ctx)
  │    ├─ reclaim(ctx)（best-effort，不阻塞 pause）:
  │    │    - envd /freeze（冻 cgroup user/pty）
  │    │    - fstrim 释放未用块
  │    │    - sync; drop_caches; compact_memory
  │    ├─ fc.CreateSnapshot:
  │    │    - 拉取 dirty memory（balloon + memory metrics）
  │    │    - diff rootfs via block.Cache.ExportToDiff
  │    │    - 写 memfile diff + snapfile + metadata
  │    ├─ build_upload.Upload（V3 或 V4 由 LD flag 决定）
  │    │    - 上传到 GCS
  │    │    - 注册到 peerRegistry（Redis 中标记本节点有缓存）
  │    └─ 返回 SchedulingMetadata
  ├─ Cleanup.Run()（LIFO）:
  │    - 释放 NBD 设备
  │    - 删除 cgroup
  │    - 归还 network slot
  │    - 删 socket 文件
  └─ Sandboxes.Map.Delete(sandboxID) → 通知订阅者（SandboxProxy）
```

### 6.3 Resume

```
API → SandboxService.Create(snapshot=true)
  ├─ 找 build → templateCache.GetOrCreate（可能命中本地或 peer）
  ├─ sandboxFactory.ResumeSandbox
  │    ├─ 共享 CreateSandbox 的资源初始化
  │    ├─ fc.LoadSnapshot（替代 Boot）
  │    │    - memfile backend 接到 UFFD
  │    │    - rootfs NBD 拉远端 diff
  │    └─ envd /init（带新 lifecycleID 触发 NFS remount + cgroup unfreeze）
  └─ 返回新的 SchedulingMetadata
```

### 6.4 Delete

```
API → SandboxService.Delete(kill_reason)
  ├─ Sandbox.Stop → doStop
  │    ├─ 停 Checks goroutine
  │    ├─ 杀 FC 进程
  │    └─ Cleanup.Run()
  ├─ sandboxKilledCounter.Record(kill_reason=...)
  └─ Sandboxes.Map.Delete → 广播
```

### 6.5 跨节点 P2P 块获取

```
orchestrator A 收到 Create 请求，本地模板缓存 miss
  ├─ templateCache 尝试 peerResolver.Resolve(buildID)
  │    → Redis 注册表查到 orchestrator B 声明有缓存
  ├─ gRPC ChunkService.ReadAtBuildSeekable(B)
  │    └─ B 流式回传 + PeerAvailability
  ├─ 若 use_storage=true → 切到 GCS 直读
  └─ 若 not_available=true → 回退 GCS
```

---

## 7. 关键设计模式

| 模式 | 文件 | 用途 |
|---|---|---|
| 依赖注入容器 | `pkg/factories/run.go` `Deps` | 共享基础设施打包给 edition-specific 工厂 |
| 反向 closer 链 | `pkg/factories/run.go` `closers` | 后进先出关闭，保证依赖顺序 |
| Promise | `getNetworkSlot` `ipsPromise.Wait` | 异步资源获取不阻塞主流程 |
| 延迟回调队列 | `pkg/sandbox/cleanup.go` `Cleanup` | 任一步失败时 LIFO 回滚 |
| ErrorOnce | `utils.ErrorOnce` | 多生产者单消费者错误汇聚 |
| Lazy | `utils.Lazy[T]` | 一次性资源初始化 |
| SetOnce | `utils.SetOnce[T]` | 单次赋值（UFFD handler / fdExit） |
| Map pub-sub | `pkg/sandbox/map.go` | 沙箱字典变更广播给订阅者 |
| TTL Cache | `ttlcache/v3` | 模板缓存 25h、uploaded builds 1h |
| AdjustableSemaphore | `utils.AdjustableSemaphore` | 运行时调整并发限制（LD flag） |
| Onion 装饰器 | `pkg/nfsproxy/{tracing,metrics,logging,recovery}` | 每层职责单一，叠加组合 |
| cmux 端口复用 | `pkg/factories/cmux.go` | 同 TCP 端口同时服务 gRPC + HTTP |
| 多目标 fan-out | `pkg/events/events.go` | 事件多端投递，独立 batcher |
| Promise + Callback | `template.Files` `peerclient.Resolver` | 远端数据按需拉取 |
| 状态机 + 不变量 | `Sandbox.Pause/Resume` | 每个状态迁移先校验前置条件 |

---

## 8. 跨平台与 Linux-only

整个 `packages/orchestrator` 几乎全部带 `//go:build linux`，因为依赖：

| 依赖 | 用途 |
|---|---|
| cgroup v2 | 资源隔离与统计 |
| netns + veth + nftables | 网络隔离 |
| NBD（`/dev/nbdX`） | 块设备暴露给 FC |
| userfaultfd | 按需分页 |
| memfd_create | 匿名内存文件 |
| mmap + fallocate（hole punch） | 块缓存与零块 |
| io_uring | NBD 直读路径性能 |
| iptables | MMDS 路由 pin（envd 共享） |
| nsenter | 进入 sandbox 命名空间 |
| `/proc/cpuinfo` | CPU 探测（同 family 才能跨节点 resume） |
| `/proc/net/*` | 网络诊断 |
| `exec` Firecracker | microVM 进程 |

仅在 macOS 上能编译的部分：`pkg/cfg`（配置解析）、`pkg/template/metadata`（纯结构）、mocks、`pkg/version`。

---

## 9. 性能优化关键点

1. **UFFD 按需分页** —— 沙箱秒级冷启动，无需把整个 rootfs 装入内存。
2. **预取（prefetch）** —— 基于历史 `MemoryPrefetchMapping` 在 boot 前批量触发热页 fault。
3. **块级 dedup** —— 与父级 build 对比，相同块用引用替代拷贝；fetch window / budget 限制避免抖动。
4. **零块路由** —— 全零块映射到 `Empty`，hole-punch 节省存储与传输。
5. **跨节点 P2P** —— 同 region 内 peer 间直传，绕开 GCS 带宽与延迟。
6. **mmap 缓存** —— 块缓存走 mmap，避免用户态拷贝；OOM 时退避重试。
7. **io_uring NBD** —— DirectPathMount 用 io_uring dispatcher 提升吞吐。
8. **连接池** —— SandboxProxy 复用 HTTP 连接，5 次重试覆盖 envd 端口转发延迟。
9. **无锁指标** —— HostMetrics 后台采样，请求路径直接读缓存。
10. **Lazy 初始化** —— uffd handler / fdExit 用 SetOnce 避免锁竞争。
11. **可调整信号量** —— MaxStartingInstancesPerNode 通过 LD flag 30s 刷新，无需重启。
12. **fcLogFilter** —— 抑制周期 FlushMetrics 日志，减少 Loki 写入压力。
13. **多 ClickHouse endpoint 隔离** —— 每 endpoint 独立 driver + batcher，慢目标不阻塞快目标。

---

## 10. 可观测性

- **Trace** —— OTEL，每个 RPC 一个 span；`tracer.Start(ctx, "create sandbox")` 等。
- **Metric** —— OTEL meter，注册到 `github.com/e2b-dev/infra/packages/orchestrator/...` 命名空间；关键 metric：
  - `orchestrator.sandbox.create.duration`
  - `orchestrator.sandbox.killed.counter`
  - `orchestrator.sandbox.count`
  - `orchestrator.sandbox.uffd.startup.{pages,source_pages,bytes}`
  - `orchestrator.templates.cache.{hits,misses}`
  - `orchestrator.status` (gauge, by status/version/commit)
  - `orchestrator.{cpu,memory,disk}.allocated`
- **Log** —— Zap + OTEL core；分两套 sandbox logger（internal 给开发看，external 通过 hyperloop 给用户看）。
- **ClickHouse** —— 沙箱事件、host stats 周期上报。
- **pprof** —— 独立 goroutine 提供 `/debug/pprof/`，端口由 `telemetry.PprofPort()` 决定。
- **Channelz** —— gRPC 内部诊断（`e2bgrpc.StartChannelzSampler`）。
- **`/health` HTTP** —— 节点级健康（Healthy/Draining/Unhealthy/Standby）。
- **grpc_health_v1** —— 标准 gRPC 健康协议。

---

## 11. 构建、命令、运行

### 必备前置（Linux host）

```bash
modprobe nbd nbds_max=4096
# 关闭 NBD 设备的 inotify
echo 'ACTION=="add|change", KERNEL=="nbd*", OPTIONS:="nowatch"' \
  > /etc/udev/rules.d/97-nbd-device.rules
udevadm control --reload-rules && udevadm trigger

# HugeTLB 页（用于 huge_pages 模板）
echo 1024 | sudo tee /proc/sys/vm/nr_hugepages
```

### Makefile 目标

| 目标 | 用途 |
|---|---|
| `make build` | Docker 构建（`COMMIT_SHA` 注入） |
| `make build-local` | 本地构建（下载 busybox） |
| `make generate` | `go generate ./...`（proto + mocks） |
| `make run-local` | 本地启动 orchestrator |
| `make run-debug` | 带 race detector |

### CLI 子命令（`cmd/`）

| 命令 | 用途 |
|---|---|
| `create-build` | 从 Dockerfile / from-template / from-image 构建模板 rootfs |
| `copy-build` | 在 GCS bucket 之间复制 build 产物 |
| `inspect-build` | 检视 build 产物（块映射、frame map、压缩统计），输出表格/JSON/热力图 |
| `mount-build-rootfs` | 把 build 的 rootfs 挂到本地路径调试 |
| `resume-build` | 从 build 恢复一个交互 shell，含 FPH prefetch 基准 |
| `show-build-diff` | 展示 build 之间的字节级差异 |
| `clean-nfs-cache` | 清理 NFS 缓存目录 |
| `hammer-file` | GCS 范围读基准（顺序 + 随机），输出 Mermaid 甘特图 |
| `simulate-gcs-traffic` | GCS 流量模拟器，多场景实验 |
| `simulate-nfs-traffic` | NFS 流量模拟器 |
| `smoketest` | 端到端冒烟测试 |
| `dummy-orchestrator` | 假 orchestrator 用于集成测试 |

---

## 12. 在仓库中的位置

- **上游**：
  - `packages/api/internal/orchestrator/` —— gRPC 客户端 + 节点发现 + 放置算法 + 驱逐。
  - `packages/client-proxy/` —— 通过 Consul 找到 orchestrator，路由用户流量。
- **下游**：
  - `packages/envd/` —— 每个 VM 内的守护进程，orchestrator 调用其 `/init /freeze /unfreeze /health`。
  - Linux 内核 —— cgroup v2 / netns / NBD / userfaultfd / nftables / memfd。
  - Firecracker —— microVM 进程。
  - GCS / Local FS —— 模板与快照对象存储。
- **共享代码**：
  - `packages/shared/pkg/grpc/orchestrator/`、`orchestrator-info/`、`template-manager/` —— proto 生成代码。
  - `packages/shared/pkg/storage/` —— 存储抽象（template/build cache、local upload）。
  - `packages/shared/pkg/featureflags/` —— LaunchDarkly 客户端。
  - `packages/shared/pkg/telemetry/`、`logger/`、`proxy/`、`connlimit/` —— 可观测性与反向代理基础设施。
  - `packages/clickhouse/pkg/` —— 事件与 host stats 投递。

---

## 13. 快速链接

| 想了解 | 看 |
|---|---|
| 进程入口与装配 | `main.go` → `pkg/factories/run.go:124` `Run` |
| gRPC 服务聚合 | `pkg/server/main.go:82` `New` |
| Sandbox 创建 | `pkg/sandbox/sandbox.go:345` `Factory.CreateSandbox` |
| Sandbox 恢复 | `pkg/sandbox/sandbox.go:598` `Factory.ResumeSandbox` |
| Sandbox 暂停 | `pkg/sandbox/sandbox.go:1078` `Sandbox.Pause` |
| envd /init 调用 | `pkg/sandbox/envd.go:40` `doRequestWithInfiniteRetries` |
| 块缓存 | `pkg/sandbox/block/cache.go:51` `Cache` |
| 块去重规划 | `pkg/sandbox/block/dedup.go` |
| UFFD server | `pkg/sandbox/uffd/uffd.go:38` `Uffd` |
| NBD 设备池 | `pkg/sandbox/nbd/pool.go` |
| 模板缓存 | `pkg/sandbox/template/cache.go:51` `Cache` |
| Peer 客户端 | `pkg/sandbox/template/peerclient/` |
| ChunkService handlers | `pkg/server/chunks.go` |
| SandboxService handlers | `pkg/server/sandboxes.go:61` `Create` |
| 网络命名空间创建 | `pkg/sandbox/network/network.go:21` `Slot.CreateNetwork` |
| Firecracker 进程 | `pkg/sandbox/fc/process.go` |
| FC REST 客户端 | `pkg/sandbox/fc/client.go` |
| Sandbox 反向代理 | `pkg/proxy/proxy.go:39` `SandboxProxy` |
| TCP 出口防火墙 | `pkg/tcpfirewall/proxy.go` |
| NFS Proxy | `pkg/nfsproxy/proxy.go` |
| chrooted FS | `pkg/chrooted/chroot.go` |
| Hyperloop Server | `pkg/hyperloopserver/server.go` |
| 服务发现 | `pkg/service/service_info.go` |
| 健康检查 | `pkg/healthcheck/healthcheck.go` |
| 主机指标 | `pkg/metrics/host.go` `HostMetrics` |
| 沙箱指标观察器 | `pkg/metrics/sandboxes.go` `SandboxObserver` |
| 配置模型 | `pkg/cfg/model.go` |
| Cleanup 回调队列 | `pkg/sandbox/cleanup.go` |
| 沙箱字典 pub-sub | `pkg/sandbox/map.go` |
| Sandbox 生命周期（外部文档） | `docs/sandbox-lifecycle.md` |

---

## 14. 错误处理与失败恢复

orchestrator 处理的是有状态、有副作用（FC 进程、cgroup、netns、socket 文件）的资源，错误恢复路径决定整体可靠性。

### 14.1 三层错误传播

| 层 | 工具 | 行为 |
|---|---|---|
| 单次操作 | `defer handleSpanError(span, &e)` | 把 error 写入 trace span 的 `status = ERROR`，便于 Jaeger 检索 |
| 多生产者汇聚 | `utils.ErrorOnce` | 第一个 error 被保留，后续 Set 返回 false；`Error()` 返回首个错误 |
| 多步骤清理 | `errors.Join(errs...)` | 不丢失任一步的错误，给上层判断"部分失败" |
| 一次性赋值 | `utils.SetOnce[T]` / `utils.Lazy[T]` | 配合 `SetError` 解阻塞所有 waiter |

### 14.2 失败回滚路径

**`Factory.CreateSandbox` 失败**：
```go
cleanup := NewCleanup()
defer func() {
    if e != nil {
        cleanupErr := cleanup.Run(ctx)        // LIFO 回滚已注册资源
        e = errors.Join(e, cleanupErr)
        handleSpanError(execSpan, &e)
        execSpan.End()
    }
}()
```
每一步资源获取后立即 `cleanup.Add`/`AddPriority`：sandbox files → rootfs provider → cgroup → FC process → uffd socket。失败时按 LIFO 顺序释放。

**`Sandbox.Pause` 失败**：
- 整个流程也包在 `cleanup` 里，但有一条特殊 cleanup：`bestEffortUnfreeze`。
- reclaim 阶段已经冻结了 user cgroup；若 pause 失败而沙箱仍存活，必须解冻。
- 解冻用 `context.WithoutCancel(ctx)` —— cleanup 路径的 parent ctx 可能已经被取消，但解冻必须完成。

**`Upload.runV3/V4` 部分失败**：
- 用 `errgroup.WithContext`，任一上传失败立刻取消其它。
- 已经上传到 GCS 的对象保留（下次 pause 可能复用），不主动删除。

### 14.3 UFFD 错误解除

```go
// uffd.go:104
if handleErr != nil {
    u.handler.SetError(handleErr)
}
```
UFFD 启动失败时调 `SetError` 而不是 `SetValue`，让所有 `Prefault waiter` 立刻收到错误，而不是死等。`readyOnce.Do(close(readyCh))` 保证 ready 总会被触发（成功或失败），防止 `WaitForEnvd` 永久阻塞。

### 14.4 进程级关闭

`factories.Run` 的关闭分两阶段：

1. **Drain 阶段**：收到 SIGTERM/SIGINT 或某服务返回非 `serviceDoneError` 错误。
   - 把 `ServiceInfoStatus` 改为 `Draining`（若原为 Healthy/Standby）。
   - 等 15 秒让 Consul 传播（非 local 模式）。
   - `tmpl.Wait(closeCtx)` 等 template manager 把进行中的 build 完成。
2. **Close 阶段**：`slices.Reverse(closers)` 后逐个调用。
   - `config.ForceStop=true` 时取消 closeCtx，closer 内部需自己处理"快速退出"。
   - 任一 closer 失败 → `success = false` → 进程 exit 1。

### 14.5 文件锁防双开

```go
// factories/run.go:183
if info, err := os.Stat(fileLockName); err == nil {
    log.Fatalf("Orchestrator was already started at %s, exiting", info.ModTime())
}
f, _ := os.Create(fileLockName)
defer os.Remove(fileLockName)  // 仅 success=true 时移除
```
崩溃后 lock file 残留 → 重启 fatal。运维需手动 `rm` 后才能启动。`ForceStop=true` 模式跳过这个检查。

---

## 15. 并发模型与锁

orchestrator 是高并发进程：每个 sandbox 至少有 NBD 读 goroutine、UFFD handler 线程、Checks 周期、HostStatsCollector、SandboxProxy 连接、envd HTTP 客户端。锁策略直接影响吞吐。

### 15.1 锁分类

| 类型 | 用途 | 文件 |
|---|---|---|
| `sync.RWMutex` | Sandbox.Config.Network 读写（egress/ingress 可热更新） | `sandbox.go:118/126` |
| `sync.Mutex` | Cleanup 回调队列、Checks 状态、EnvVars map | `cleanup.go` / `checks.go` |
| `sync.Once` | Cleanup.Run 触发、Checks.readyCh 关闭 | `cleanup.go:71` |
| `sync.Once` + `atomic.Pointer` | UFFD handler/memfd 单次赋值 | `uffd.go:46` |
| `atomic.Bool` | Cache.closed、Checks.healthy | `cache.go:59` / `checks.go:37` |
| `atomic.Pointer[T]` | MMDSOpts、HTTPExporter.mmdsOpts | envd 侧 |
| `atomic.Int64` | Handler stdout/stderr/pty bytes 流量统计 | `envd/handler.go` |
| `ttlcache` 内部锁 | 模板缓存并发访问 | `template/cache.go` |
| `sync.Map` | Sandboxes.Map（沙箱字典） | `sandbox/map.go` |
| `semaphore.Weighted` | startingSandboxes / initLock / freezeLock | `server/main.go` / envd |
| `utils.AdjustableSemaphore` | MaxStartingInstancesPerNode 动态调整 | `server/main.go:55` |

### 15.2 无锁读取路径

**关键性能设计**：请求路径上的指标读取**无锁**。

- `HostMetrics` —— 后台 goroutine 周期采样，`GetCPUMetrics()` 直接读原子缓存值。
- `Handler.stdoutBytes` 等 —— `atomic.Int64`，goroutine 间无竞争。
- `Sandboxes.Map` —— `sync.Map` 提供 `Load/Range` 无锁读。

避免在请求路径上做 cgroup stat、CPU 采样、JSON 序列化等昂贵操作。

### 15.3 Map pub-sub（`pkg/sandbox/map.go`）

`SandboxesMap` 暴露 `Subscribe() MapSubscriber` 接口，`SandboxProxy` 实现该接口：

- 沙箱 Create/Delete 时 → Map 内部 notify 所有 subscriber。
- SandboxProxy 收到通知 → 更新连接池目标列表。
- 单向通信，无回压（subscriber 慢不会阻塞 Map）。

### 15.4 AdjustableSemaphore（`server/main.go:208`）

`refreshStartingSandboxesLimit` goroutine 每 30 秒重读 LaunchDarkly flag：

```go
limit := s.featureFlags.IntFlag(ctx, featureflags.MaxStartingInstancesPerNode)
s.startingSandboxes.SetLimit(int64(limit))
```

无需重启进程就能调整并发启动数。`SetLimit` 是非阻塞的，会唤醒等待的 goroutine。

---

## 16. 调度亲和性与跨节点匹配

调度（placement）发生在 API 层，但 orchestrator 通过 `SchedulingMetadata` 与 `InfoService` 提供决策输入。

### 16.1 affinity 信号

API 在 `Create(snapshot=true)` 请求时已知：

- `memfile_build_ids / rootfs_build_ids` —— 该 sandbox 的所有祖先 build。
- `memfile_build_bytes / rootfs_build_bytes` —— 每个 build 的引用字节数。
- `memfile_base_build_id / rootfs_base_build_id` —— 根层（每个沙箱共享）。

调用 `InfoService.ServiceInfo` 拿到候选节点列表，再调 `ListCachedBuilds` 看每节点已缓存哪些 build。

### 16.2 评分算法（BestOfK）

API 层的 BestOfK（`packages/api/internal/orchestrator/placement/`）：
1. 随机抽 K 个候选节点。
2. 算每个节点的"匹配字节"= ∑(build_ids ∩ cached_builds) × bytes。
3. 选最高分；并列时按 CPU/内存余量、节点标签（同 CPU family）打破平局。
4. 同时通过 Redis Lua 脚本原子预留 CPU/内存配额（防并发超卖）。

### 16.3 CPU family 一致性（`pkg/service/main.go`）

通过 `/proc/cpuinfo` 探测 `cpu_family / cpu_model / cpu_flags`，注册到 `MachineInfo`。**同一 template 的 build 必须在相同 CPU family 上 resume**：

- 不同 family（如 Intel Skylake vs AMD Zen）指令集差异 → guest kernel 在 restore 时遇到 unsupported instruction → SIGILL。
- placement 用 `labels: ["cpu-family-6"]` 之类的节点标签做硬过滤。

### 16.4 chainLimit=128 与最轻层丢弃

详见 §5.5 「调度元数据」小节。链路深时丢弃轻量层，让 API 的评分算法集中考虑"最热的祖先层"在哪里。

---

## 17. Pause 完整流程深度图（`sandbox.go:1078`）

把第 6.2 节的时序展开：

```
Sandbox.Pause(ctx, templateMetadata, useCase)
  │
  ├─ cleanup := NewCleanup()                 ← defer:失败时回滚
  │
  ├─ s.Checks.Stop()                         ← 停 20s 健康循环
  │
  ├─ bestEffortReclaim(ctx):                 ← best-effort,不阻塞
  │    ├─ (可选) bestEffortFreeze            ← envd /freeze (2s 超时)
  │    └─ StartEnvdSystemShell("fstrim; sync; drop_caches; compact_memory")
  │       ↑ 每个 step 用 `timeout -s KILL <cap>` 单独限时
  │
  │   cleanup.Add(bestEffortUnfreeze)        ← Pause 失败时必须解冻
  │
  ├─ DrainBalloon(drainCtx)                  ← free-page-hinting drain
  │    (LD flag 控制,0=禁用)
  │
  ├─ s.process.Pause(ctx)                    ← FC API: Pause
  │
  ├─ s.process.FlushMetrics(ctx)             ← best-effort,_ = 忽略错误
  │
  ├─ snapfile := NewLocalFileLink(cachePath) ← 不 close,返回给上层
  │
  ├─ s.process.CreateSnapshot(ctx, snapfile) ← FC API: CreateSnapshot
  │
  ├─ memfileDiffMetadata := memory.DiffMetadata(ctx, fc):
  │    ├─ handler.ExportPageStates()         ← settle UFFD workers
  │    └─ fc.DirtyMemory(pageSize)           ← 拉 WP-async pagemap
  │       empty.AndNot(dirty)                ← dirty 胜出
  │
  ├─ pauseProcessMemory(...):                ← memfile diff
  │    ├─ fc.ExportMemory(dirty, ..., dedupBudget, empty, metaOut)
  │    │    └─ CopyOnWrite XFS / fallback
  │    ├─ build.NewLocalDiffFromCache(cache)
  │    └─ go func() { headerOut.SetResult(metaOut.Wait() ...) }
  │       ↑ 异步解析 dedup header
  │
  ├─ pauseProcessRootfs(...):                ← rootfs diff (同步)
  │    └─ RootfsDiffCreator → io.Writer
  │
  ├─ schedulingMetadata := scheduling.FromHeaders(buildID, memHeader, rootfsHeader, newMemfileBytes)
  │                                                       ↑ chainLimit=128
  │
  ├─ metadataFileLink := NewLocalFileLink(cacheMetadata)
  ├─ m.ToFile(metadataFileLink.Path())       ← 模板元数据 JSON
  │
  └─ return &Snapshot{...}

后续(Upload):
  ├─ Upload.runV3 或 runV4(由 LD flag)
  │    ├─ errgroup 并发上传 memfile/rootfs/snap/meta/header
  │    └─ MemfileDiffHeader.WaitWithContext ← 等异步 header
  └─ 失败/成功都通知 templateCache / peerRegistry
```

**关键延迟优化**：
- `Pause` 在 `pauseProcessMemory` 启动 dedup goroutine 后**立刻返回**，不等 memfd compare 完成。
- 上传流程的 `MemfileDiffHeader.WaitWithContext` 才真正阻塞等 dedup 结果。
- API 收到 `Pause` 响应后就能调度别的事（更新 DB、通知 client），dedup 与上传在后台跑。

---

## 18. 内存管理与一致性

### 18.1 三种内存 backend

| Backend | 用途 | 实现 |
|---|---|---|
| `memfd_create` | FC guest 物理内存（匿名，可 seal） | `block.Memfd`，被 uffd handler 持有 |
| `mmap.MapRegion` | 块缓存文件映射 | `block.Cache`，RDWR 模式 |
| 普通文件 `os.File` | 模板 rootfs、snapfile | `block.Local` |

### 18.2 hugepages

`SandboxConfig.HugePages = true` 时：
- memfd 用 `MAP_HUGETLB` flag 创建，2 MiB 页。
- 需要 host 预留 HugeTLB 页：`echo N > /proc/sys/vm/nr_hugepages`。
- 优势：减少 TLB miss，提升大内存沙箱性能。
- 缺点：内存碎片化时分配失败率高，需要 idle page 支持。

### 18.3 free-page-hinting（FPH）

`fph_gates.go` 根据 FC 版本字符串判断是否支持 FPH（FC ≥ v1.14）：
- guest 内核主动告诉 hypervisor "这页我没用"。
- snapshot 时这些页被排除，减少 diff 体积。
- `DrainBalloon` 在 pause 前主动轮询，确保所有 hint 都已处理。
- `drain_balloon_test.go` 验证快速重试场景。

### 18.4 内存一致性不变量

| 场景 | 不变量 |
|---|---|
| 同步快照 | `empty.AndNot(dirty)` —— dirty 胜出，防止 zero-install 后 write 的页丢失 |
| UFFD Settle | fault worker 全部 quiesce 后才采样 dirty pagemap |
| memfd 后台拷贝 | `MemfdBackgroundCopyFlag` 开启时，dedup 与 fault 处理并行，但仍保证最终一致 |
| dedup budget | `MaxFetchWindowsPerBlock / MaxPromotedParentPagesPerBlock / ...` 限制单块 fetch 次数，防止抖动 |

### 18.5 OOM 处理

`block.Cache` 的 mmap 写入可能触发 OOM：

```go
const (
    oomMinBackoff = 100 * time.Millisecond
    oomMaxJitter  = 100 * time.Millisecond
)
```

- 写失败时识别 OOM 错误，`sleep(oomMinBackoff + rand(oomMaxJitter))` 后重试。
- 随机化 jitter 防止多 sandbox 同时重试引发 thundering herd。
- 最终失败 → 返回 error → 触发 sandbox Pause 失败 → cleanup。

---

## 19. 代码组织约定

### 19.1 build tag `//go:build linux`

整个 `pkg/sandbox/` 与几乎所有 `pkg/*` 都用 linux build tag。在 macOS 上能编译的只有：
- `pkg/cfg/`（纯结构 + env 解析）
- `pkg/template/metadata`（纯序列化）
- `pkg/version/`
- 部分 mocks

### 19.2 tracing 与 metric 命名

每个包顶部：
```go
var tracer = otel.Tracer("github.com/e2b-dev/infra/packages/orchestrator/pkg/sandbox")
var meter  = otel.Meter("github.com/e2b-dev/infra/packages/orchestrator/pkg/sandbox")
```

metric 名遵循 `orchestrator.<subsystem>.<verb>.<noun>`：
- `orchestrator.sandbox.create.duration`
- `orchestrator.sandbox.killed.counter`
- `orchestrator.templates.cache.hits`
- `orchestrator.uffd.startup.pages`

### 19.3 错误包装

`fmt.Errorf("... : %w", err)` 链式包装，让 `errors.Is` / `errors.As` 能在调用栈任何位置匹配。常用 sentinel：

- `ErrChecksStopped`（checks.go）
- `ErrCacheClosed`（block/cache.go）
- `ErrTokenNotSet / ErrTokenEmpty`（envd 侧）

### 19.4 注释纪律

代码中大量"为什么"注释（不是"做什么"），例如：

```go
// /init is hammered by the orchestrator's infinite retry loop, so a
// persistent pin failure would otherwise flood the log.
var pinMMDSWarnLimit = ratelimit.New(10 * time.Second)
```

这类注释解释**不变量的来源**（某个上游行为）、**乍看奇怪的设计的真实原因**，是阅读代码的关键索引。


