# Orchestrator 模块详细指南

> Orchestrator 是 E2B 平台的核心服务，负责 Firecracker microVM 的全生命周期管理——从创建、恢复快照、暂停（打快照）到销毁。它通过 gRPC 对外暴露服务，底层管理网络、存储、内存分页等复杂子系统。

---

## 目录

- [1. 入口与启动](#1-入口与启动)
- [2. 命令行工具 (cmd/)](#2-命令行工具-cmd)
- [3. 配置模块 (pkg/cfg)](#3-配置模块-pkgcfg)
- [4. Sandbox 核心 (pkg/sandbox)](#4-sandbox-核心-pkgsandbox)
  - [4.1 根包——沙箱生命周期](#41-根包沙箱生命周期)
  - [4.2 Block——块设备抽象与缓存](#42-block块设备抽象与缓存)
  - [4.3 Cgroup——Linux Cgroup v2 管理](#43-cgrouplinux-cgroup-v2-管理)
  - [4.4 Envd——客户机代理通信类型](#44-envd客户机代理通信类型)
  - [4.5 FC——Firecracker 进程管理](#45-fc-firecracker-进程管理)
  - [4.6 NBD——网络块设备](#46-nbd网络块设备)
  - [4.7 Network——网络命名空间与 Slot 管理](#47-network网络命名空间与-slot-管理)
  - [4.8 Rootfs——根文件系统提供者](#48-rootfs根文件系统提供者)
  - [4.9 Socket——Socket 等待工具](#49-socket等待工具)
  - [4.10 Template——模板缓存与存储](#410-template模板缓存与存储)
  - [4.11 UFFD——Userfaultfd 内存后端](#411-uffduserfaultfd-内存后端)
  - [4.12 Build——构建产物管理](#412-build构建产物管理)
- [5. gRPC 服务端 (pkg/server)](#5-grpc-服务端-pkgserver)
- [6. NFS 代理 (pkg/nfsproxy)](#6-nfs-代理-pkgnfsproxy)
- [7. TCP 防火墙 (pkg/tcpfirewall)](#7-tcp-防火墙-pkgtcpfirewall)
- [8. 沙箱反向代理 (pkg/proxy)](#8-沙箱反向代理-pkgproxy)
- [9. 网络出口代理与工厂 (pkg/factories)](#9-网络出口代理与工厂-pkgfactories)
- [10. Hyperloop 服务 (pkg/hyperloopserver)](#10-hyperloop-服务-pkghyperloopserver)
- [11. 其他支持模块](#11-其他支持模块)
- [12. 架构总览图](#12-架构总览图)
- [13. 核心接口总览](#13-核心接口总览)
- [14. 端到端数据流](#14-端到端数据流)
  - [14.1 沙箱创建（从快照恢复）](#141-沙箱创建从快照恢复)
  - [14.2 沙箱暂停（打快照）](#142-沙箱暂停打快照)
  - [14.3 缺页处理（UFFD 读取路径）](#143-缺页处理uffd-读取路径)
  - [14.4 NFS 卷访问](#144-nfs-卷访问)
  - [14.5 出口流量过滤](#145-出口流量过滤)
- [15. Feature Flags 参考](#15-feature-flags-参考)
- [16. 环境变量参考](#16-环境变量参考)

---

## 1. 入口与启动

### `main.go`

Orchestrator 的入口点（仅限 Linux，`//go:build linux`）。

**职责：**
- 调用 `factories.Run()` 启动整个服务，传入版本信息和 `EgressFactory` 回调
- `applyTestFlagOverrides()` 从测试环境变量读取配置覆盖（如 `TESTS_MEMFILE_DIFF_DEDUP_MODE`、`TESTS_USE_MEMFD`）
- `defaultEgressFactory()` 创建 `tcpfirewall.TCPFirewall` 作为沙箱的网络出口代理

**关键依赖：** `pkg/factories`、`pkg/tcpfirewall`、`pkg/version`、`shared/featureflags`

### `pkg/factories/run.go`——服务运行时核心

这是 orchestrator 真正的启动引擎。

**核心类型：**
| 类型 | 说明 |
|------|------|
| `Options` | 启动选项：`Version`、`CommitSHA`、`EgressFactory` |
| `Deps` | 共享基础设施：Config、MeterProvider、Logger、Sandbox Map、FeatureFlags |
| `EgressSetup` | 出口代理设置结果：Proxy 实现 + 可选 Start/Close 生命周期钩子 |
| `closer` | 命名清理函数，关闭时按注册的逆序执行 |

**启动流程 (`run()`)：**
1. 初始化遥测（OpenTelemetry）、日志（Zap）
2. 加载 Feature Flags（LaunchDarkly）
3. 连接 Redis、ClickHouse
4. 初始化模板缓存（Template Cache）
5. 初始化 NBD 设备池
6. 初始化网络池（Network Pool）
7. 创建 Sandbox 工厂
8. 启动 NFS 代理（端口映射 + NFS 服务）
9. 启动 Hyperloop HTTP 服务
10. 启动 gRPC 服务（通过 cmux 复用 HTTP + gRPC）
11. 启动沙箱反向代理
12. 注册健康检查 + pprof
13. 等待关闭信号，执行 drain 和有序清理

---

## 2. 命令行工具 (cmd/)

`cmd/` 下包含多个独立的 CLI 工具，用于构建、调试和基准测试。

| 命令 | 目的 |
|------|------|
| **create-build** | 从头或增量创建模板构建。启动 FC VM → 执行 setup 命令 → 暂停/快照 → 上传产物 |
| **resume-build** | 从快照恢复沙箱。支持交互模式、命令模式、暂停模式、基准测试、预取优化、Shell 模式 |
| **inspect-build** | 检查构建产物（反序列化打印 header 元数据、block 映射、数据块状态）。有新版仪表盘和旧版 header dump 两种模式 |
| **copy-build** | 在存储位置间复制构建产物（memfile/rootfs headers、数据文件、snapfile、metadata）。CRC32C 校验跳过已存在文件 |
| **show-build-diff** | 对比两个构建，显示 base 映射、diff 映射和合并结果。支持 ASCII 可视化 |
| **mount-build-rootfs** | 将构建的 rootfs 挂载为 NBD 设备进行本地检查。支持完整性验证（`e2fsck`） |
| **hammer-file** | GCS 读取性能基准测试工具，顺序/并行（10并发）4MB 分块读取，生成 Mermaid 甘特图 |
| **simulate-gcs-traffic** | 全面的 GCS 性能基准测试，组合实验参数（并发度、分块大小、读取方法等），输出 CSV |
| **simulate-nfs-traffic** | NFS (Google Cloud Filestore) 读取性能基准测试。发现 NFS 挂载上的 4MB 文件，组合实验参数（并发度 8/16/32、read-ahead、sysctl 参数等），采集 NFS RPC 统计，输出 CSV 和 Filestore 元数据 |
| **smoketest** | 烟雾测试：验证所有 Firecracker 版本的完整启动-恢复-销毁流程 |
| **benchmarks/** | 并发恢复基准测试。测量不同并发级别下的恢复延迟（P50/P95/P99），报告聚合统计 |
| **internal/cmdutil** | CLI 共享工具函数：日志抑制、header 信息获取、文件大小计算、产物路径等 |

---

## 3. 配置模块 (pkg/cfg)

### `pkg/cfg/model.go`

定义 orchestrator 的所有配置类型和解析逻辑。

**核心类型：**
| 类型 | 说明 |
|------|------|
| `BuilderConfig` | 构建器和 orchestrator 共享的基础配置：域名、envd 超时、FC/busybox/kernel 路径、基础目录、存储配置、网络配置 |
| `Config` | 完整配置（嵌入 BuilderConfig）：ClickHouse 连接串、gRPC 端口、LaunchDarkly API Key、Node IP/标签、NFS 代理设置、代理端口、Redis 配置、NBD 池大小、服务列表、持久卷挂载、锁文件路径等 |

**关键函数：**
- `Parse() (Config, error)` — 从环境变量解析完整配置（使用 `caarlos0/env`），解析相对路径为绝对路径
- `ParseBuilder() (BuilderConfig, error)` — 仅解析构建器子集配置
- `Config.AdditionalClickhouseEndpoints()` — 返回去重的额外 ClickHouse 端点
- `Config.NodeAddress()` — 返回 `host:port` 字符串

### `pkg/cfg/service.go`

定义服务类型枚举和多角色支持。

| 类型 | 说明 |
|------|------|
| `ServiceType` | 字符串枚举：`Orchestrator`、`TemplateManager`、`UnknownService` |

- `ParseServiceType()` — 大小写不敏感的服务类型解析
- `GetServices()` — 解析 `ORCHESTRATOR_SERVICES` 环境变量为服务类型列表
- `GetServiceName()` — 拼接服务名用于日志/遥测

---

## 4. Sandbox 核心 (pkg/sandbox)

这是 orchestrator 最核心、最大的模块，管理 Firecracker microVM 的全生命周期。

### 4.1 根包——沙箱生命周期

**关键文件：**

| 文件 | 说明 |
|------|------|
| `sandbox.go` | 核心类型定义：`Sandbox`、`Factory`、`Config`、`Resources`、`Metadata`、`RuntimeMetadata` |
| `checks.go` | 健康检查循环控制器（20s 轮询 envd `/health`） |
| `cleanup.go` | 清理任务协调器：优先级任务 + 普通任务，一次性执行，错误聚合 |
| `snapshot.go` | 快照逻辑：暂停 FC VM → 导出内存 diff → 导出 rootfs diff |
| `diffcreator.go` | Diff 导出抽象，实现 `process(ctx, out)` 接口 |
| `map.go` | `Map` — 线程安全的运行中沙箱注册表（IP→沙箱索引 + 订阅者通知） |
| `metrics.go` | 沙箱级 OpenTelemetry 指标收集 |
| `hoststats.go` / `hoststats_collector.go` | 主机统计：周期性 cgroup CPU/内存采样，推送到 ClickHouse |
| `reclaim.go` | 沙箱回收逻辑（fstrim/drop_caches） |
| `envd.go` / `envd_process.go` | 与 envd 客户机代理的通信（初始化、进程管理） |
| `uploads.go` | 上传管理器：跨节点协调（Redis pub/sub）+ 进行中上传表 |
| `build_upload.go` / `build_upload_v3.go` / `build_upload_v4.go` | V3/V4 版上传实现 |

**核心类型（详细字段）：**

**`Config` 结构体：**
```go
type Config struct {
    BaseTemplateID        string                     // 仅用于 v1 rootfs 路径格式
    Vcpu                  int64
    RamMB                 int64
    TotalDiskSizeMB       int64                      // 可选，仅用于指标
    HugePages             bool
    FreePageReporting     bool
    FreePageHinting       bool
    Envd                  EnvdMetadata
    FirecrackerConfig     fc.Config
    VolumeMounts          []VolumeMountConfig
    MaxSandboxLengthHours int64
    mu                    *sync.RWMutex              // 保护 Network 子字段
    Network               *orchestrator.SandboxNetworkConfig
}
```

**`Sandbox` 结构体：**
```go
type Sandbox struct {
    *Resources                         // Slot + rootfs Provider + memory Backend
    *Metadata                          // Config + Runtime + startedAt/endAt
    LifecycleID       string           // 每次 VM 启动唯一，pause/resume 时改变
    config            cfg.BuilderConfig
    files             *storage.SandboxFiles
    cleanup           *Cleanup         // 延迟清理栈
    featureFlags      *featureflags.Client
    process           *fc.Process
    cgroupHandle      *cgroup.CgroupHandle
    Template          template.Template
    Checks            *Checks          // 健康检查（20s 间隔 envd /health）
    hostStatsCollector *HostStatsCollector
    APIStoredConfig   *orchestrator.SandboxConfig  // Deprecated
    CABundle          string
    exit              *utils.ErrorOnce // 单次退出错误
    stop              utils.Lazy[error] // 幂等停止
    startupStatsOnce  sync.Once
}
```

**`Factory` 结构体：**
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

**`Snapshot` 结构体：**
```go
type Snapshot struct {
    MemfileDiff        build.Diff
    MemfileDiffHeader  *utils.SetOnce[*header.Header]  // write-once
    RootfsDiff         build.Diff
    RootfsDiffHeader   *utils.SetOnce[*header.Header]  // write-once
    Snapfile           template.File
    Metafile           template.File
    BuildID            uuid.UUID
    SchedulingMetadata *orchestrator.SchedulingMetadata
    MemfileBlockSize   uint64          // Pause 时同步捕获
    RootfsBlockSize    uint64          // Pause 时同步捕获
    cleanup            *Cleanup
}
```

**核心生命周期（详细签名）：**

1. **`Factory.CreateSandbox(ctx, config *Config, runtime RuntimeMetadata, template template.Template, sandboxTimeout time.Duration, rootfsCachePath string, processOptions fc.ProcessOptions, apiConfigToStore *SandboxConfig, preBootFn PreBootFn) (*Sandbox, error)`**
   - `PreBootFn`：`func(ctx, rootfsPath) error` — rootfs 就绪后、FC 启动前的可选回调
   - `rootfsCachePath == ""` → 使用 `rootfs.NewNBDProvider`；否则 `rootfs.NewDirectProvider`
   - 错误路径通过 deferred `cleanup.Run(ctx)` 清理资源

2. **`Factory.ResumeSandbox(ctx, t template.Template, config *Config, runtime RuntimeMetadata, startedAt, endAt time.Time, apiConfigToStore *SandboxConfig) (*Sandbox, error)`**
   - 使用 Promise 并行初始化 UFFD、网络 slot、rootfs overlay 和内存服务
   - 支持 `prefetch.New(...)` 当 `meta.Prefetch.Memory` 非空时
   - `useMemfd` 由 FC 版本和 Feature Flag 决定

3. **`Sandbox.Pause(ctx, m metadata.Template, useCase SnapshotUseCase) (*Snapshot, error)`**
   - 前置步骤：best-effort guest 回收、balloon drain（超时按 useCase 配置）
   - 暂停 FC VM → `CreateSnapshot` → 从 `memory.DiffMetadata` 获取 diff 元数据
   - 后处理：`pauseProcessMemory`（memfile diff）+ `pauseProcessRootfs`（rootfs diff）
   - 去重由 `MemfileDiffDedupFlag` 控制，参数：`enabled`、`bestEffort`、`directIO`、`maxFetchWindowsPerBlock`、`maxPromotedParentPagesPerBlock`、`maxPagesPerPromotedFrame`、`blockFaultPct`、`fetchRunWindowPages`
   - memfile diff header 在 goroutine 中异步解析（`Pause` 在 memfd-dedup 比较完成前返回）

4. **`Sandbox.Stop(ctx) error`** — SIGTERM + 10s SIGKILL。`utils.Lazy[error]` 保证幂等

5. **`Sandbox.Shutdown(ctx) error`** — Pause + 丢弃快照 + Close

**Map 通知机制：**
- `MapSubscriber` 接口：`OnInsert(ctx, *Sandbox)` 和 `OnNetworkRelease(ctx, *Sandbox)`
- TCP 防火墙和沙箱代理是主要订阅者，用于在网络事件时添加/删除 iptables 规则

### 4.2 Block——块设备抽象与缓存

提供块设备抽象层，用于内存（memfile）和磁盘（rootfs）数据管理。

**核心类型：**

| 类型 | 说明 |
|------|------|
| `ReadonlyDevice` | 接口：ReadAt、Size、Close、Slice、BlockSize、Header、SwapHeader |
| `Device` | 扩展 ReadonlyDevice，增加 WriteAt 和 WriteZeroesAt |
| `Cache` | mmap 支持的文件缓存，块级跟踪（dirty/zero/not-present） |
| `Overlay` | Copy-on-write 设备：有缓存读缓存，否则回退到基础设备 |
| `Chunker` | 流式分块获取器，用于压缩/帧数据的并发读取解析 |

**`Cache` 结构体详细字段：**
```go
type Cache struct {
    filePath   string          // 底层文件路径
    size       int64           // 总大小
    blockSize  int64           // 块大小
    mmap       *mmap.MMap      // 内存映射
    mu         sync.RWMutex    // 保护并发读写
    tracker    *Tracker        // 块状态跟踪（Dirty/Zero/NotPresent）
    dirtyFile  bool            // 是否为脏文件模式
    closed     atomic.Bool     // 关闭标记
}
```

**`Cache` 关键方法签名：**

| 方法 | 签名 | 说明 |
|------|------|------|
| `NewCache` | `(size, blockSize int64, filePath string, dirtyFile bool) (*Cache, error)` | 创建稀疏文件 + mmap |
| `NewCacheFromProcessMemory` | `(ctx context.Context, blockSize int64, filePath string, pid int, ranges []Range) (*Cache, error)` | 通过 `process_vm_readv` 从远程进程读取页面 |
| `Dedup` | `(ctx, base ReadonlyDevice, dirty *roaring.Bitmap, blockSize int64, outPath string, bestEffort, directIO bool, budget DedupBudget) (*Cache, *header.DiffMetadata, error)` | 4KiB 页级去重 |
| `ExportToDiff` | `(ctx, out *os.File) (*header.DiffMetadata, error)` | 使用 `copy_file_range` 导出脏范围 |
| `WriteAt` | `(b []byte, off int64) (int, error)` | 写入（零检测 + punch hole） |
| `WriteZeroesAt` | `(off, length int64) (int, error)` | 打洞 + 标记 Zero |
| `Slice` | `(off, length int64) ([]byte, error)` | 返回 mmap 切片（检查 `isCached`） |
| `Close` | `() error` | unmap + 删除文件 |

**`NewCacheFromProcessMemory` 实现细节：**
- 预切分范围：`splitOversizedRanges(rs, getAlignedMaxRwCount(blockSize))`
- 使用 `unix.ProcessVMReadv(pid, local, remote, 0)` 批量读取
- `EAGAIN`/`EINTR` 自动重试
- `ENOMEM`（内存压力）：退避 `100ms + random(100ms)` 后重试

**`Dedup` 去重流程：**
1. 构建 `packed` 映射（绝对偏移 → packed 偏移）
2. `dedupCompare`：逐页比较脏页与基础设备，分类为 same/different
3. `dedupDrain`：将不同页写入新 cache 文件
4. 返回 `Cache`（PageSize 粒度）+ `DiffMetadata{Dirty, Empty, BlockSize: PageSize}`

**`ExportToDiff` 实现：**
- `unix.SyncFileRange(src, 0, size, SYNC_FILE_RANGE_WRITE)`（best-effort）
- 优先 `unix.CopyFileRange`（ reflink 感知），`EXDEV`/`EOPNOTSUPP`/`ENOSYS` 回退 `io.Copy`
- 按 `BitsetRanges(dirty, blockSize)` 迭代脏范围

**`Overlay` 结构体详细字段：**
```go
type Overlay struct {
    device       ReadonlyDevice     // 只读基础设备
    cache        *Cache             // 可写缓存
    cacheEjected atomic.Bool        // 缓存是否已弹出
    blockSize    int64
}
```

- `ReadAt`：先查缓存 → `BytesNotAvailableError` → 回退到基础设备
- `EjectCache() (*Cache, error)`：`CompareAndSwap` 原子弹出，二次调用返回错误
- `Close`：缓存已弹出时跳过关闭

**`Chunker` 结构体详细字段：**
```go
type Chunker struct {
    cache        *Cache
    metrics      metrics.Metrics
    fetchTimeout time.Duration     // 默认 60s
    featureFlags *featureflags.Client
    size         int64
    fetchMu      sync.Mutex
    fetchSessions []*fetchSession
}
```

**`Chunker.Slice(ctx, off, length, upstream, ft)` 实现细节：**
1. 快速路径：`cache.Slice` → 已缓存直接返回
2. `BytesNotAvailableError`：迭代范围跨的 chunk，对每个调用 `fetch`
3. 获取后用 `cache.sliceDirect`（跳过 `isCached` 检查）

**`fetch` 流程：**
- `locateChunk` 定位 chunk（压缩用 `ft.LocateUncompressed`，非压缩按 `MemoryChunkSize` 对齐）
- 获取或创建 `fetchSession` → `registerAndWait` 等待每个块
- `runFetch` 在后台 goroutine 中执行（带 `fetchTimeout`），按 `max(blockSize, MinChunkerReadSizeKB*1024)` 批量读取

**`DedupBudget` 结构体：**
```go
type DedupBudget struct {
    MaxFetchWindowsPerBlock        int
    MaxPromotedParentPagesPerBlock int
    MaxPagesPerPromotedFrame       int
    BlockFaultPct                  int
    FetchRunWindowPages            int
}
```

### 4.3 Cgroup——Linux Cgroup v2 管理

为每个沙箱创建和管理 cgroup v2，用于资源核算（CPU、内存）。支持通过 `CLONE_INTO_CGROUP` 原子放置进程。

**常量：**
- `cgroupV2MountPoint` = `/sys/fs/cgroup`
- `RootCgroupPath` = `/sys/fs/cgroup/e2b`
- `NoCgroupFD` = `-1`（无/released FD 哨兵）

| 类型 | 说明 |
|------|------|
| `Manager`（接口） | `Initialize(ctx)` 创建根 cgroup 并启用 cpu+memory 控制器；`Create(ctx, name)` 返回 `CgroupHandle` |
| `CgroupHandle` | 单个沙箱 cgroup。持有 cgroup 目录 FD（用于 `SysProcAttr.CgroupFD`）、`memory.peak` FD（用于区间峰值采样）和清理生命周期 |
| `Stats` | `CPUUsageUsec`、`CPUUserUsec`、`CPUSystemUsec`、`MemoryUsageBytes`、`MemoryPeakBytes` |
| `noopManager` | 无操作实现，用于 CLI 工具/测试。`GetFD()` 返回 `NoCgroupFD`，`GetStats()` 返回 `(nil, nil)` |

**CgroupHandle 生命周期：** `Create` → `GetFD()` → `cmd.Start()` → `ReleaseCgroupFD()` → `GetStats()`（重复）→ `Remove()`

**关键函数：**
- `NewManager()` — 验证 cgroups v2 可用性
- `CgroupHandle.GetStats()` — 读取 `cpu.stat`（usage/user/system usec）、`memory.current`、`memory.peak`（带 per-FD 重置）
- `CgroupHandle.Remove()` — 关闭 FD + 删除 cgroup 目录。EBUSY 时回退到 `cgroup.kill`，最多重试 2s
- `NewNoopManager()` — 无操作实现

### 4.4 Envd——客户机代理通信类型

envd 运行在每个 Firecracker VM 内部，此包包含从 envd OpenAPI spec (`envd/spec/envd.yaml`) **代码生成**的类型。仅生成模型（无服务端存根或客户端）。

**关键生成类型：**

| 类型 | 说明 |
|------|------|
| `PostInitJSONBody` | 发送到 envd `/init` 的 JSON body：`AccessToken`、`CaBundle`、`DefaultUser`、`DefaultWorkdir`、`EnvVars`、`HyperloopIP`、`LifecycleID`、`Timestamp`、`VolumeMounts` |
| `SecureToken` | access token 字符串的类型别名 |
| `VolumeMount` | `NfsTarget` + `Path`（客户机内挂载路径） |
| `Metrics` | 资源使用指标：`CpuCount`、`CpuUsedPct`、`DiskTotal`、`DiskUsed`、`MemCache`、`MemTotal`、`MemUsed`、`Ts` |
| `ComposeRequest` | 文件拼接：`Destination`、`SourcePaths[]`、`Username` |
| `EntryInfo` | 文件元数据：`Name`、`Path`、`Type`、`Metadata` map |
| `GetFilesParams` / `PostFilesParams` | 文件操作参数：`Path`、`Username`、`Signature`、`SignatureExpiration` |
| `PostFilesMultipartBody` | 通过 multipart form 上传文件 |

### 4.5 FC——Firecracker 进程管理

管理 Firecracker microVM 进程：启动、配置、快照恢复、暂停、内存导出和指标收集。

**核心类型：**

**`Process` 结构体：**
```go
type Process struct {
    Versions              Config
    cmd                   *exec.Cmd
    config                cfg.BuilderConfig
    firecrackerSocketPath string
    metricsPath           string
    slot                  *network.Slot
    rootfsProvider        rootfs.Provider
    rootfsPath            string
    kernelPath            string
    files                 *storage.SandboxFiles
    Exit                  *utils.ErrorOnce
    client                *apiClient
    balloonAccum          atomic.Pointer[BalloonMetricsSnapshot]
}
```

**`ProcessOptions` 结构体：**
```go
type ProcessOptions struct {
    IoEngine            *string   // IO 引擎
    InitScriptPath      string    // init 脚本路径
    KernelLogs          bool      // 内核日志
    SystemdToKernelLogs bool      // systemd → 内核日志
    KvmClock            bool      // KVM 时钟
    Stdout              io.Writer
    Stderr              io.Writer
}
```

**`RateLimiterConfig` / `TokenBucketConfig`：**
```go
type TokenBucketConfig struct {
    BucketSize   int64  // < 0 禁用
    OneTimeBurst int64
    RefillTimeMs int64
}
type RateLimiterConfig struct {
    Ops       TokenBucketConfig
    Bandwidth TokenBucketConfig
}
```

**`Process.Create()` 详细签名：**
```go
func (p *Process) Create(
    ctx context.Context,
    sbxMetadata sbxlogger.LoggerMetadata,
    vCPUCount int64, memoryMB int64,
    hugePages bool, freePageReporting bool, freePageHinting bool,
    options ProcessOptions,
    txRateLimit RateLimiterConfig, driveRateLimit RateLimiterConfig,
    cgroupFD int,
) error
```
**执行顺序：**
1. `configure()`：启动 FC 进程（`unshare -m`），设置日志（`fcLogFilter` 过滤 FlushMetrics 噪音），创建 metrics FIFO
2. 内核参数：`quiet loglevel=1 init=<path> ipv4/ipv6 配置 panic=1 reboot=k pci=off rootflags=discard`
3. API 调用链：`setMetrics` → `setBootSource` → symlink rootfs → `setRootfsDrive` → `setNetworkInterface` → `setMachineConfig` → `setEntropyDevice` → [可选] `installBalloon` → `startVM`
4. 失败时 join 错误与 `Stop(ctx)`

**`Process.Resume()` 详细签名：**
```go
func (p *Process) Resume(
    ctx context.Context,
    sbxMetadata sbxlogger.SandboxMetadata,
    uffdSocketPath string,
    snapfile template.File,
    uffdReady chan struct{},
    accessToken *string,
    cgroupFD int,
    useMemfd bool,
    txRateLimit RateLimiterConfig, driveRateLimit RateLimiterConfig,
) error
```
**三路并行（errgroup）：** configure FC / 等待 UFFD socket / symlink rootfs
**API 调用链：** `setMetrics` → `loadSnapshot`（含 uffdSocketPath/snapfile/uffdReady/useMemfd）→ `setTxRateLimit` → `setDriveRateLimit` → `resumeVM` → `setMmds`
**MMDS 元数据：** SandboxID、TemplateID、LogsCollectorAddress、AccessTokenHash

**`Process.Stop()` 实现：**
1. 移除 metrics FIFO
2. 检查 `Exit.Done()` 是否已退出
3. 发送 SIGTERM
4. 后台 goroutine 等待 10s → 仍在运行 → SIGKILL

**`Process.DrainBalloon()` 实现：**
- 触发 free-page-hinting run
- 指数退避轮询（5ms 初始，50ms 最大）等待 `freePageHintDone == 1`

### 4.6 NBD——网络块设备

提供 NBD 连接，使客户机的 rootfs 驱动通过内核 NBD 驱动由主机提供服务。

**`Dispatch` 结构体：**
```go
type Dispatch struct {
    fp               io.ReadWriter     // socket 连接
    responseHeader   []byte            // 预分配的响应头（含 NBDResponseMagic）
    writeLock        sync.Mutex        // 序列化写操作
    prov             Provider          // 底层块设备
    provName         string
    pendingResponses sync.WaitGroup
    shuttingDown     bool
    shuttingDownLock sync.Mutex
    fatal            chan error        // 致命错误通道
}
```

**NBD Wire Protocol 常量：**

| 常量 | 值 | 说明 |
|------|-----|------|
| `NBDRequestMagic` | `0x25609513` | 请求魔数 |
| `NBDResponseMagic` | `0x67446698` | 响应魔数 |
| `NBDCmdRead` | `0` | 读命令 |
| `NBDCmdWrite` | `1` | 写命令 |
| `NBDCmdDisconnect` | `2` | 断开 |
| `NBDCmdFlush` | `3` | 刷新（不支持） |
| `NBDCmdTrim` | `4` | Trim |
| `NBDCmdWriteZeroes` | `6` | 写零 |
| `dispatchBufferSize` | `4 MiB` | 读缓冲区大小 |
| `dispatchMaxWriteBufferSize` | `32 MiB` | 写缓冲区上限 |

**`Request` 结构体（28 字节 big-endian）：**
```go
type Request struct {
    Magic  uint32   // 0x25609513
    Flags  uint16
    Type   uint16   // NBD 命令类型
    Handle uint64   // 请求句柄
    From   uint64   // 偏移量
    Length uint32   // 长度
}
```

**`Dispatch.Handle(ctx) error` — 主循环：**
1. 使用 buffer pool（4MB 缓冲区）
2. 读取 28 字节请求头，验证 `NBDRequestMagic`
3. 按命令类型分发：
   - `Disconnect` → 返回 nil
   - `Flush` → 返回 "not supported" 错误
   - `Read` → `cmdRead`（异步 goroutine）
   - `Write` → 读取数据（最大 32MB）→ `cmdWrite`（异步 goroutine）
   - `WriteZeroes/Trim` → `cmdWriteZeroes`（同步，开销小）
4. 每次迭代检查 `fatal` 通道和 `ctx.Done()`

**`cmdRead` 异步模式：**
- goroutine 中调用 `prov.ReadAt`
- 后端失败 → 写入错误响应（error=1），保持 dispatch 存活
- 写入响应错误升级到 `fatal`

**`Provider` 接口：**
```go
type Provider interface {
    ReadAt(ctx context.Context, p []byte, off int64) (int, error)
    Size(ctx context.Context) (int64, error)
    io.WriterAt
    WriteZeroesAt(off, length int64) (int, error)
}
```

### 4.7 Network——网络命名空间与 Slot 管理

使用 Linux namespace、veth pair、tap 设备、iptables NAT 和 nftables 防火墙管理每个沙箱的网络隔离。

**网络拓扑常量：**

| 常量 | 值 | 说明 |
|------|-----|------|
| `defaultHostNetworkCIDR` | `10.11.0.0/16` | 主机侧网络 CIDR（可通过 `SANDBOXES_HOST_NETWORK_CIDR` 覆盖） |
| `defaultVrtNetworkCIDR` | `10.12.0.0/16` | 虚拟网络 CIDR（可通过 `SANDBOXES_VRT_NETWORK_CIDR` 覆盖） |
| `vrtMask` | `31` | 每个虚拟子网 2 个 IP（vpeer + veth） |
| `tapMask` | `30` | Tap 子网掩码 |
| `tapInterfaceName` | `"tap0"` | FC 使用 tap 设备名 |
| `tapIp` | `"169.254.0.22"` | Tap IP 地址 |
| `tapMAC` | `"02:FC:00:00:00:05"` | FC MAC 地址 |

**`Slot` 结构体：**
```go
type Slot struct {
    Key                string         // 唯一标识
    Idx                int            // 槽索引
    Firewall           *Firewall      // nftables 防火墙
    firewallCustomRules atomic.Bool
    vPeerIp           net.IP          // 客户机 eth0 IP
    vEthIp            net.IP          // 主机侧 veth IP
    vrtMask           net.IPMask
    tapIp             net.IP
    tapMask           net.IPMask
    HostIP            net.IP          // 主机可达 IP
    hostNet           *net.IPNet
    hostCIDR          string
    hyperloopPort     string
    egressProxy       EgressProxy
    config            Config
}
```

**IP 计算规则：**
- `vEthIp` = `vrtNetworkCIDR` 基地址 + `idx * 2`
- `vPeerIp` = 基地址 + `idx * 2 + 1`
- `HostIP` = `hostNetworkCIDR` 基地址 + `idx`

**`NewSlot(key, idx, config, egressProxy) (*Slot, error)`**
- 验证 `idx` 在范围 `[1, vrtSlotsSize)` 内
- `GetVrtSlotsSize()` = `(totalIPs / 2) - 2`

**`CreateNetwork(ctx) error` — 完整网络栈创建：**
1. 锁定 OS 线程
2. 创建命名 namespace（`ns-<idx>`）
3. 创建 veth pair（`veth-<idx>` + `eth0`），移动 veth 到主机 namespace
4. 在 namespace 内创建 tap 设备（`tap0`）
5. 设置 loopback、默认路由（via vEthIp）
6. 添加 NAT 规则（SNAT/DNAT）在 namespace 和 host IP 之间
7. 初始化 firewall
8. 添加主机路由：host → vPeerIp → HostNet
9. 添加 iptables 转发规则、masquerade、hyperloop 端口重定向、NFS proxy/portmapper 重定向
10. 调用 `egressProxy.OnSlotCreate`

**`RemoveNetwork() error` — 完整拆除：**
- 防火墙 → 转发规则 → postrouting → 路由 → veth 设备 → namespace

**访问方法：**
- `VpeerName()` = `"eth0"`
- `VethName()` = `"veth-<idx>"`
- `NamespaceIP()` = `"169.254.0.21"`
- `NamespaceID()` = `"ns-<idx>"`

### 4.8 Rootfs——根文件系统提供者

为 Firecracker VM 提供根文件系统。两种策略：NBD（用于运行中沙箱）和 Direct mmap（用于构建）。

**`Provider` 接口：**
- `Start(ctx) error` — 启动文件系统服务
- `Close(ctx) error` — 关闭并清理资源
- `Path() (string, error)` — 返回设备/文件路径（可能阻塞等待就绪）
- `ExportDiff(ctx, out, closeSandbox) (*DiffMetadata, error)` — 导出脏块 diff，可选关闭沙箱

**`NBDProvider`** — Copy-on-Write NBD 模式（运行中沙箱）
- 创建 `block.Overlay`（只读基础 + 可写缓存）+ `nbd.DirectPathMount`
- `Start()` — 打开 NBD 挂载，设置 ready 路径为 `/dev/nbdX`
- `ExportDiff()` — 弹出缓存 → 并发停止沙箱 → 等待操作完成 → 导出缓存 diff
- `Close()` — sync 设备（`ioctl BLKFLSBUF`）→ 关闭 NBD 挂载 → 信号完成
- `Path()` — 阻塞等待 `Start()` 完成的 `SetOnce`

**`DirectProvider`** — 直接 mmap 模式（构建过程）
- 在构造函数中直接创建并 mmap 文件为 read-write
- `Start()` — 无操作（构造时已就绪）
- `ExportDiff()` — 设置 closed 标志 → unmap → 并发停止沙箱 → 逐块扫描 mmap 文件 → 馈入 DiffMetadataBuilder
- `Path()` — 立即返回文件路径（总是就绪）

### 4.9 Socket——等待工具

轮询 Unix socket 文件出现的简单工具，用于等待 FC 和 UFFD socket 就绪。

- `Wait(ctx, socketPath) error` — 以 10ms 间隔轮询 `os.Stat`，直到文件存在或上下文取消

### 4.10 Template——模板缓存与存储

管理模板数据（memfile、rootfs、snapfile、metadata），具有 TTL 缓存、后台存储获取、构建 diff 存储、NFS 缓存和 P2P 分块传输。

**核心类型：**

| 类型 | 说明 |
|------|------|
| `Template`（接口） | `Files()`、`Memfile()`、`Rootfs()`、`Snapfile()`、`Metadata()`、`Close()` |
| `Cache` | TTL 模板缓存。处理从存储获取、NFS 缓存包装、P2P 路由、构建 diff 存储和缓存驱逐 |
| `File`（接口） | `Close()` + `Path()` |
| `LocalFileLink` | 文件支持的模板产物（snapfile、metafile） |

**P2P 子系统：**

| 子包 | 说明 |
|------|------|
| `peerclient/` | P2P 分块传输客户端。`Resolver` 解析哪个 peer 服务给定的 build ID；`RoutingProvider` 将读取路由到适当的 peer |
| `peerserver/` | P2P 分块传输服务端。通过 HTTP 提供模板数据，包括 header 解析、可寻址数据服务和元数据 |

### 4.11 UFFD——Userfaultfd 内存后端

通过 Linux `userfaultfd` 机制管理客户机内存。FC 从快照恢复时，客户机内存按需提供服务：缺页由 UFFD 处理程序捕获，从模板 memfile 读取页面并安装到客户机地址空间。

**`Uffd` 结构体：**
```go
type Uffd struct {
    exit       *utils.ErrorOnce
    readyCh    chan struct{}         // 就绪信号
    readyOnce  sync.Once
    lis        *net.UnixListener
    socketPath string
    memfile    block.ReadonlyDevice  // 模板内存文件
    memfd      atomic.Pointer[block.Memfd]
    handler    utils.SetOnce[*userfaultfd.Userfaultfd]
    fdExit     utils.SetOnce[*fdexit.FdExit]
}
```

**`Uffd.Start(ctx, sandboxId) error` — 启动流程：**
1. 监听 Unix socket，chmod `0o777`
2. 创建 `fdexit.FdExit`
3. 启动 goroutine 调用 `handle()`

**`Uffd.handle(ctx, sandboxId, fdExit)` — 连接处理：**
1. 设置 10s deadline
2. Accept 连接
3. 读取 JSON region mappings + FDs（通过 `ReadMsgUnix`）
4. 验证：1 个 control message、至少 1 个 FD
5. 创建 `memory.NewMapping(regions)`
6. 从 memfile header 提取 generation 用于指标标记
7. 创建 `userfaultfd.NewUserfaultfdFromFd(fds[0], ...)`
8. 第二个 FD 包装为 `block.Memfd`
9. 设置 handler 值、关闭 `readyCh`、调用 `Serve()`

**`Uffd.DiffMetadata(ctx, f *fc.Process)` — diff 元数据获取：**
- **必须在** sandbox 暂停和 snapshot 端点调用后调用
- 从 handler 导出页面状态（settles in-flight workers）
- 获取脏内存 `f.DirtyMemory(ctx, handler.PageSize())`
- 空 bitmap = `handler.ExportPageStates()` 减去 `diff.Dirty`

**`Userfaultfd` 核心结构体：**
```go
type Userfaultfd struct {
    fd              Fd
    src             PageReader
    ma              *memory.Mapping
    pageSize        uintptr
    pageTracker     *block.Tracker
    settleRequests  sync.RWMutex
    readSerial      sync.Mutex
    prefetchTracker *block.PrefetchTracker
    defaultCopyMode CULong
    wg              errgroup.Group
    wakeupPipe      [2]int
    servedPages       atomic.Int64
    servedSourcePages atomic.Int64
    servedBytes       atomic.Int64
    genBucket         generationBucket
}
```

**`Serve(ctx, fdExit) error` — 主循环：**
- Poll 3 个 FD：uffd fd、fdExit reader、wakeup pipe
- 处理事件类型：`UFFD_EVENT_PAGEFAULT` 和 `UFFD_EVENT_REMOVE`
- REMOVE → 映射地址到偏移 → 设置 tracker `Zero` 范围
- Pagefault 在工作器 goroutine 中处理（限制 `maxRequestsInProgress = 4096`）

**`faultPage(ctx, addr, offset, accessType, source, onFailure)` — 缺页处理：**

| 路径 | 条件 | 操作 |
|------|------|------|
| 零填充（4K 读） | tracker 标记 Zero | `UFFDIO_ZEROPAGE` + `UFFDIO_WRITEPROTECT` + wake |
| 零填充（4K 写） | tracker 标记 Zero | `UFFDIO_ZEROPAGE`（with wake） |
| 零填充（hugepage） | tracker 标记 Zero | `UFFDIO_COPY` with `EmptyHugePage` |
| 源读取 | tracker 标记 NotPresent | 从 PageReader 读取，重试最多 3 次（50ms-500ms 指数退避 + jitter） |

**错误映射：**
- `EEXIST` → `faultAlreadyPresent`
- `ESRCH` → `faultDiscarded`
- `EAGAIN` → `faultDeferred`（推入延迟队列，信号 wakeup pipe）

**关键常量：**

| 常量 | 值 | 说明 |
|------|-----|------|
| `maxRequestsInProgress` | `4096` | 最大并发缺页处理 |
| `sliceMaxRetries` | `3` | 源读取最大重试 |
| `sliceRetryBaseDelay` | `50ms` | 重试基础延迟 |
| `sliceRetryMaxDelay` | `500ms` | 重试最大延迟 |
| `uffdMsgListenerTimeout` | `10s` | socket accept 超时 |

### 4.12 Build——构建产物管理

`pkg/sandbox/build/` 是沙箱读取路径上的核心数据层。它管理由多层祖先构建（ancestor builds）组成的快照数据，将字节范围读取分解为跨构建的扇出读取，支持 P2P 路由、压缩和磁盘空间感知驱逐。

**`File` 结构体：**
```go
type File struct {
    header      atomic.Pointer[header.Header]  // 原子可替换 header
    store       *DiffStore
    fileType    DiffType
    persistence storage.StorageProvider
    metrics     blockmetrics.Metrics
}
```

**`File.ReadAt(ctx, p, off) (int, error)` — 核心读取：**
1. 重试循环：plan → 执行 → `CacheClosedError` 时重新 plan
2. 成功时记录扇出指标
3. 字节数不足时返回 `io.EOF`

**`planRead(ctx, p, off)` 实现细节：**
- 每次读取的内联 Diff 缓存：`buildCacheSize = 16`（避免 TTL cache 互斥锁）
- 遍历 `h.GetShiftedMapping(ctx, off+n)`
  - `uuid.Nil` 区域：`clear()` 零填充
  - 零长度映射：EOF
- 返回 `[]readSegment{dstOff, srcOff, length, diff, ft}`

**`readSegments(ctx, p, segments, maxParallel)` 实现：**
- `maxParallel > 1 && len(segments) > 1` 时使用 `errgroup` 限制并发
- 遇到 `PeerTransitionedError`：等待 `RetryAfter` → 刷新 diff 源 → 重试一次
- `int64(n) != s.length` → `io.ErrUnexpectedEOF`

**`File.Slice(ctx, off, length)` — 零拷贝路径：**
- 单映射：直接 `diff.Slice`（零拷贝）
- 多映射：回退 `ReadAt`

**`createDiff(ctx, buildID)` — Diff 创建逻辑：**

| 条件 | 行为 |
|------|------|
| Header 有 Builds 条目 | 使用其 size 和 compression type |
| V4+ 无条目，peer-active | 打开 upstream，询问 peer 获取 size |
| V4+ 无条目，非 peer | 刷新祖先 header，用正确压缩打开 upstream |
| Pre-V4 | 使用 `UncompressedFullFrameTable` |

**`readSegment` 内部结构：**
```go
type readSegment struct {
    dstOff int           // 目标 buffer 偏移
    srcOff int64         // 源偏移
    length int64         // 长度
    diff   Diff          // 数据源
    ft     *storage.FrameTable  // 帧表（可选压缩）
}
```

---

## 5. gRPC 服务端 (pkg/server)

主要的 gRPC 服务器，实现 `SandboxService`、`ChunkService`，并通过 `VolumeService` 和 `InfoService` 提供卷管理和节点信息。

### Server 结构体

| 字段 | 类型 | 说明 |
|------|------|------|
| `config` | `cfg.Config` | 节点级配置 |
| `sandboxFactory` | `*sandbox.Factory` | 沙箱创建和管理 |
| `info` | `*service.ServiceInfo` | 节点身份（client ID、版本、commit、状态） |
| `proxy` | `*proxy.SandboxProxy` | 流量路由到沙箱 |
| `networkPool` | `*network.Pool` | 网络资源池 |
| `templateCache` | `*template.Cache` | 本地模板/rootfs 快照缓存 |
| `devicePool` | `*nbd.DevicePool` | NBD 设备池 |
| `persistence` | `storage.StorageProvider` | 远程存储（GCS 等）用于上传快照 |
| `featureFlags` | `*featureflags.Client` | LaunchDarkly Feature Flag 客户端 |
| `sbxEventsService` | `*events.EventsService` | Webhook 事件发布 |
| `startingSandboxes` | `*utils.AdjustableSemaphore` | 并发沙箱启动/恢复限制 |
| `peerRegistry` | `peerclient.Registry` | P2P 分块传输注册表 |
| `uploadedBuilds` | `*ttlcache.Cache` | 已完成上传的构建追踪（1h TTL） |
| `uploads` | `*sandbox.Uploads` | 快照上传跟踪管理器 |
| `sandboxCreateDuration` | `metric.Int64Histogram` | 创建延迟直方图 |
| `sandboxKilledCounter` | `metric.Int64Counter` | kill 计数器 |

### 注册的 OTel 指标

| 指标 | 类型 | 说明 |
|------|------|------|
| `sandboxCreateDuration` | Int64Histogram | 创建/恢复延迟，tag `sandbox.resume` |
| `sandboxKilledCounter` | Int64Counter | kill 计数，tag `kill_reason` |
| `sandboxCount` | Observable UpDownCounter | 当前运行沙箱数 |
| `statusGauge` | Int64Gauge | 节点状态（始终=1），tag `status`/`version`/`commit` |
| `cpuAllocatedGauge` | Int64Gauge | 已分配 vCPU 总数 |
| `memoryAllocatedGauge` | Int64Gauge | 已分配内存总字节数 |
| `diskAllocatedGauge` | Int64Gauge | 已分配磁盘总字节数 |

### RPC 方法详解

**常量：** `requestTimeout`=60s、`acquireTimeout`=15s、`uploadTimeout`=20min

#### `Create(ctx, *SandboxCreateRequest)`

从快照恢复沙箱（核心创建路径）。

**完整流程：**
1. 60s 请求超时 + tracing span `"sandbox-create"`
2. **Feature Flag 上下文设置**：sandbox + team + version kind
3. **节点容量检查**：读取 `MaxSandboxesPerNode`，超过返回 `ResourceExhausted`
4. **启动信号量**：快照恢复走阻塞获取（15s 超时），非快照走非阻塞 `TryAcquire`
5. **模板解析**：`templateCache.GetTemplate(buildID, snapshot)`
6. **卷挂载解析**：验证每个 volume ID 是有效 UUID
7. **FC 版本解析**：通过 Feature Flag 确定版本
8. **沙箱恢复**：`sandboxFactory.ResumeSandbox(template, config, runtime, ...)`
9. **后台生命周期管理**：`setupSandboxLifecycle` goroutine（等待退出→清理→移除代理连接）
10. **提取调度元数据** + 发布 `SandboxCreatedEventPair` 或 `SandboxResumedEventPair` 事件

#### `Update(ctx, *SandboxUpdateRequest)`

更新沙箱结束时间和/或出口规则。**原子操作**：所有更新要么全部成功要么全部回滚。

#### `Delete(ctx, *SandboxDeleteRequest)`

终止沙箱。流程：查找沙箱 → `MarkStopping` → 收集健康指标 → **异步停止**（fire-and-forget）→ 记录 kill 原因 + 发布 `SandboxKilledEventPair` 事件

#### `Pause(ctx, *SandboxPauseRequest)`

打快照并异步上传。

**完整流程：**
1. `MarkStopping` 排除旧沙箱
2. `snapshotAndCacheSandbox`：读取模板元数据 → `sbx.Pause` → 添加到本地缓存 → 创建 `Upload` → 注册 P2P
3. `uploadSnapshotAsync`：后台 20min 超时上传 → `completeUpload` → 标记已上传 → 取消 P2P 注册
4. 发布 `SandboxPausedEventPair` 事件

#### `Checkpoint(ctx, *SandboxCheckpointRequest)`

快照 + 恢复新沙箱 + 上传。最复杂的 RPC。

**完整流程：**
1. **envd 版本检查**：太旧则返回 `FailedPrecondition`
2. **获取启动信号量**（阻塞，15s 超时）
3. `snapshotAndCacheSandbox` 打快照并缓存
4. **恢复新沙箱**：相同 sandbox ID + execution ID，但新的 lifecycle ID
5. **收集预取数据**：从新沙箱获取内存缺页数据 → 转换为预取映射 → 更新模板元数据
6. **上传（Feature Flag 控制）**：
   - `PeerToPeerAsyncCheckpointFlag`=true：异步上传（立即返回，peer 可在传输中拉取）
   - 同步模式：内联上传（20min 超时），失败则终止新沙箱并返回 `Internal`
7. 发布 `SandboxCheckpointedEvent` 事件

### Chunk Streaming RPCs

四个 P2P 分块流式 RPC，共享模式：先检查 `uploadedBuilds` 缓存（已上传则返回 `UseStorage`），否则从本地模板缓存解析数据源。

| 方法 | 类型 | 说明 |
|------|------|------|
| `ReadAtBuildSeekable` | Streaming | 从指定偏移量流式读取构建文件。验证 offset/length >= 0 |
| `GetBuildBlob` | Streaming | 流式传输整个构建 blob |
| `GetBuildFileSize` | Unary | 返回构建文件大小 |
| `GetBuildFileExists` | Unary | 检查构建文件是否存在 |

### ListCachedBuilds

列出模板缓存中的所有构建，返回 build ID + TTL 过期时间。

---

## 6. NFS 代理 (pkg/nfsproxy)

NFS v3 代理服务器，允许沙箱通过 NFS 挂载持久卷。拦截 NFS mount 请求，通过源 IP 识别调用沙箱，解析卷的 chrooted 文件系统。

### 中间件装饰器栈

`NewProxy` 按以下顺序组装处理器链（从内到外）：

```
chroot.NFSHandler         ← 核心：沙箱 IP → 卷文件系统映射
  → helpers.CachingHandler  ← 1024 条目文件句柄缓存（拦截 ToHandle/FromHandle/InvalidateHandle）
    → tracing.WrapWithTracing   ← [可选] OTel span 包装
      → metrics.WrapWithMetrics  ← [可选] 指标计数
        → logged.WrapWithLogging   ← [可选] 请求日志
          → recovery.WrapWithRecovery  ← [始终] panic 恢复
```

### NFSHandler——核心处理流程

**Mount 流程（NFS MOUNT 过程）：**
1. **沙箱查找**：`sandboxes.GetByHostPort(remoteAddr)` 通过源 IP 查找沙箱
2. **路径验证**：请求的 `Dirpath` 必须匹配 `^/[^/]+$`（单个路径段如 `/volume_name`）
3. **卷解析**：提取 volumeName，遍历 `sbx.Config.VolumeMounts` 匹配卷名
4. **团队/卷 ID 验证**：解析 TeamID 为 UUID，验证 VolumeID 非 nil
5. **Chroot 创建**：`builder.Chroot(ctx, volumeType, teamID, volumeID)` 创建隔离文件系统
6. **生命周期跟踪**：将 chroot 添加到 `chrootsByLifecycleID[lifecycleID]`

**OnNetworkRelease**：沙箱网络释放时，关闭该生命周期的所有 chroot，增量计数器，清理映射。

**FSStat**：返回 nil（默认 1<<62 值），卷对外显示为几乎无限大小。

**Handle 方法**：ToHandle/FromHandle/InvalidateHandle/HandleLimit 全部 panic（因为 CachingHandler 在外层拦截了这些调用）。

### chroot 子包——文件系统安全边界

| 类型 | 说明 |
|------|------|
| `wrappedFS` | `billy.Filesystem` 实现，委托所有操作到 `*chrooted.Chrooted`。**`Chroot()` 始终返回 `os.ErrPermission`**——防止 NFS 客户端逃逸出沙箱 |
| `wrappedFile` | `billy.File` 实现，委托到 `*os.File`。`Lock/Unlock` 使用 `unix.Flock` |
| `wrappedChange` | `billy.Change` 实现，委托 Chmod/Chown/Lchown/Chtimes 到 chrooted |

### 连接级跟踪

`connWithSpan` 在每个 NFS 连接上创建 OTel span，OnConnect/OnDisconnect 管理生命周期。

---

## 7. TCP 防火墙 (pkg/tcpfirewall)

TCP 出口防火墙/代理，通过 iptables NAT REDIRECT 拦截沙箱出站流量，执行域名白名单、CIDR allow/deny 规则和 DNS rebinding 防护。

### 架构

三个独立端口处理不同流量类别，避免协议检测死锁（如 SSH 是 server-first 协议，检测 client hello 会阻塞）：

```
沙箱出站 → iptables DNAT REDIRECT → 三端口防火墙代理
  ├── httpPort (原 port 80 流量) → domainHandler (HTTP Host header)
  │                            └─ fallback → cidrOnlyHandler
  ├── tlsPort  (原 port 443 流量) → domainHandler (TLS SNI)
  │                            └─ fallback → cidrOnlyHandler
  └── otherPort (所有其他端口) → cidrOnlyHandler (无协议检测)
```

### Start() 启动流程

1. 创建 `tcpproxy.Proxy`
2. 自定义 `ListenFunc`：每个 listener 包装为 `resilientListener`（重试 EMFILE/ENFILE/EAGAIN/ECONNABORTED，100ms 间隔）
3. 注册三组路由规则
4. 启动后台 goroutine 在 context 取消时关闭代理
5. 阻塞运行 `proxy.Run()`

### 连接处理流程

每个连接的 `HandleConn`：
1. 获取原始连接（`tcpproxy.UnderlyingConn`）
2. 按源地址查找沙箱
3. **连接限制检查**：`limiter.TryAcquire(limiterKey, maxLimit)`，超限则关闭
4. **获取原始目的地**：`getOriginalDst(rawConn)` 通过 `SO_ORIGINAL_DST` syscall 获取 DNAT 前的 IP:port
5. 调用处理器函数，defer 释放限制器槽位

### 出口策略引擎 (`isEgressAllowed`)

**判定优先级：**
1. 无出口配置 → 允许所有
2. **Allowed domains** → 域名匹配 → 允许（`MatchTypeDomain`）
3. **Allowed CIDRs** → IP 在允许范围内 → 允许（`MatchTypeCIDR`）
4. **Denied CIDRs** → IP 在拒绝范围内 → 拒绝
5. **Default** → 允许

**域名匹配规则（`matchDomain`）：**
- 空模式永不匹配
- `*` 匹配所有
- `*.example.com` 匹配 `example.com` 的任何子域名
- 大小写不敏感精确匹配

### DNS Rebinding 防护

`proxyWithIPVerification` 在 TCP `connect()` 前验证解析后的 IP：

1. 自定义 `DialContext`：创建带 `ControlContext` 回调的 `net.Dialer`
2. `ControlContext` 在 DNS 解析后、`connect()` 前触发
3. 检查解析 IP 是否在 `DeniedSandboxCIDRs`（内网/私有地址段）
4. 如果在内网范围 → 阻止连接，记录指标
5. 保留 Happy Eyeballs (RFC 8305) 多 IP 回退能力

### iptables 集成

- `OnSlotCreate` — 每个网络 slot 添加三条 NAT PREROUTING 规则（port 80→httpPort、443→tlsPort、其他→otherPort）
- `OnSlotDelete` — 删除对应规则
- `OnNetworkRelease` — 移除限制器条目

### getOriginalDst 实现

通过 Linux 内核 API 获取 DNAT 前的原始目的地：
1. 获取 `*net.TCPConn` 的原始 FD
2. 在 `rawConn.Control` 回调中：`syscall.SYS_GETSOCKOPT` + `SOL_IP` + level 80 (`SO_ORIGINAL_DST`)
3. 解析 `sockaddr_in`：地址族 + 大端端口 + IPv4 地址

---

## 8. 沙箱反向代理 (pkg/proxy)

反向 TCP 代理，根据请求中的沙箱 ID 将外部 HTTP 流量路由到沙箱。

### 路由逻辑

`NewSandboxProxy` 构造一个 `reverseproxy.Proxy`，路由函数：
1. 从 HTTP 请求提取 `sandboxId` 和 `port`
2. 在沙箱 Map 中查找沙箱，未找到返回 `ErrSandboxNotFound`
3. **Access token 验证**：非 envd 端口通过常量时间比较验证 `e2b-traffic-access-token` header
4. 可选 **host masking**（替换端口占位符）
5. 构造目标 URL `http://<hostIP>:<port>`
6. 返回 `pool.Destination` 键为 `LifecycleID`（而非 sandbox ID），避免跨 pause/resume 的连接复用 bug

### 连接限制

- Feature Flag `SandboxMaxIncomingConnections` 控制每沙箱最大入站连接数
- 超限时关闭新连接并记录 `connectionsBlocked` 计数器

### 关键配置

| 参数 | 值 | 原因 |
|------|-----|------|
| Idle timeout | 620s | 高于 GCP LB 的 600s 上游空闲超时，避免竞态 |
| Retries | 5 | 处理沙箱 envd 端口转发延迟 |
| Disable keepalives | true | 沙箱内部服务器可能不可预测重启，同主机通信开销极小 |

### OTel 指标

| 指标 | 类型 | 说明 |
|------|------|------|
| `connectionsPerSandbox` | Int64Histogram | 获取连接时记录当前连接数 |
| `connectionDuration` | Int64Histogram | 连接释放时记录持续时间（ms） |
| `connectionsBlocked` | Int64Counter | 因连接限制被拒的次数 |

### 生命周期

- `OnNetworkRelease` — 移除按 LifecycleID 键入的限制器条目
- `RemoveFromPool(connectionKey)` — 移除指定键的池化连接
- `Close` vs `Shutdown` — context 取消时硬关闭，否则优雅关闭

---

## 9. 网络出口代理与工厂 (pkg/factories)

| 文件 | 说明 |
|------|------|
| `run.go` | 主 `Run()` 函数：启动全流程，管理生命周期 |
| `cmux.go` | cmux 多路复用器工厂（在单个 TCP 端口上复用 gRPC 和 HTTP） |
| `http.go` | 基础 HTTP 服务器工厂 |

---

## 10. Hyperloop 服务 (pkg/hyperloopserver)

内部 HTTP API 服务器，供沙箱与 orchestrator 通信。

| 端点 | 说明 |
|------|------|
| `GET /me` | 通过源 IP 识别调用沙箱，返回沙箱 ID |
| `POST /logs` | 转发沙箱日志到外部收集器。验证沙箱 ID，覆盖 instance/env/team ID 防伪造 |

使用 OpenAPI 生成的 Gin 服务器，256 MiB 上传限制。

---

## 11. 其他支持模块

### pkg/chrooted

chrooted 文件系统抽象，基于隔离的 Linux mount namespace。为每个卷创建专用 mount namespace，在 namespace 内通过 goroutine-locked OS 线程执行所有文件系统操作，确保沙箱隔离的文件访问不影响主机。

**核心类型：**
- **`Chrooted`** — 持有 `ActualRoot string`（真实文件路径）、`Metadata map[string]string`、`ns *mountNS`。所有操作通过 `act(fn)` 分发到 namespace 请求通道
- **`Builder`** — 包装 `cfg.Config`。`BuildVolumePath(type, teamID, volID)` 构造路径 `<volumeTypeRoot>/team-<teamID>/vol-<volumeID>`；`Chroot(ctx, type, teamID, volID)` 解析路径并 chroot
- **`mountNS`** — 底层 mount namespace 封装。每个实例拥有一个永久锁定的 goroutine+OS 线程，通过 `reqCh` 通道序列化所有操作

**chroot 流程（`Chroot` 函数）：**
1. 通过 `tempMountNS()` 创建新的临时 mount namespace：
   - 锁定调用者 OS 线程 → 启动新 goroutine 并锁定自己的 OS 线程
   - 新 goroutine 调用 `unix.Unshare(CLONE_NEWNS)` 创建隔离 mount namespace
   - 打开新 namespace 句柄，设置请求通道，进入 select 循环
2. 在 namespace 内执行 chroot：
   - 标记 `/` 为 `MS_SLAVE|MS_REC`（阻止挂载事件传播）
   - Bind-mount 目标路径到自身
   - 最多 10 次尝试 `pivot_root`（创建随机 `.old-root.<random>` 临时目录）
   - 卸载旧 root，清理临时目录
3. 返回 `Chrooted` 实例

**支持的文件系统操作**（全部通过 `act()` 在 namespace 内执行）：
Create、Open、OpenFile、Stat、Lstat、ReadDir、Mkdir、MkdirAll、Rename、Remove、RemoveAll、Symlink、Readlink、EvalSymlinks、GetEntry、TempFile、Join、Chmod、Chown、Lchown、Chtimes

**安全限制：** `Chroot()` 方法始终返回错误 `"chroot not supported"`——防止在已 chroot 的环境中再次 chroot 逃逸

**遥测：** `orchestrator.chroot.request.latency` 直方图记录请求在通道中的等待延迟（微秒）

### pkg/events

沙箱事件发布服务，将验证后的事件扇出分发到多个投递目标（ClickHouse、Redis Streams）。

**`EventsService`** 持有 `[]events.Delivery[events.SandboxEvent]` 切片：
- `Publish(ctx, teamID, event)` — 验证事件（必须有 version、type、sandbox_id、sandbox_team_id、timestamp）→ 并行分发到所有目标 → 每个目标独立记录错误但不短路
- `Close(ctx)` — 并行关闭所有目标，聚合错误

### pkg/healthcheck

暴露 HTTP `/health` 端点，报告 orchestrator 节点健康状态。

**状态映射：** `ServiceInfoStatus` → `e2bHealth.Status`：
- 正常 → `Healthy`
- Draining → `Draining`
- 其他 → `Unhealthy`

### pkg/localupload

本地文件上传 HTTP PUT 处理器，用于本地存储模式。

**请求验证流程：**
1. 仅接受 PUT 方法
2. 解析 `path`、`expires`、`token` 查询参数
3. HMAC token 验证（防篡改）
4. 过期检查
5. 路径遍历防护（验证路径在 basePath 内）
6. 创建父目录 → 写入临时文件 → 原子重命名到最终路径

### pkg/metrics

两个独立的指标子系统：

**HostMetrics** — 后台主机资源采样器
- 10s 间隔采样 CPU（使用百分比、核心数）、内存（已用/总字节）、磁盘（挂载点、设备、文件系统类型、已用/总/百分比）
- `RWMutex` 保护的快照，请求路径上非阻塞读取
- 数据来源：`gopsutil`

**SandboxObserver** — 每沙箱指标收集
- 独立 OTel MeterProvider（delta temporality 用于 gauge）
- Observable callback 轮询每个沙箱的 envd agent 获取 CPU/内存/磁盘/缓存指标
- 检查时钟漂移，超阈值时记录警告

### pkg/portmap

RPC 端口映射器（RFC 1057 / portmap 协议），供 NFS 客户端发现 NFS 和 mountd 服务端口。

**安全设计：** `PMAPPROC_SET` 和 `PMAPPROC_UNSET` 有意返回 false——防止攻击者注册恶意端口映射。

**中间件栈：** logging → panic recovery

**注册：** `RegisterPort(ctx, port)` 注册 NFS3 和 mountd 服务到指定 TCP 端口。

### pkg/scheduling

从模板构建 header 生成调度/亲和性元数据。

**`FromHeaders(buildID, memfileHeader, rootfsHeader, newMemfileBytes)`** 核心逻辑：
1. 从 memfile 和 rootfs header 提取 `BytesByBuild()` 映射
2. 确保基础构建和当前构建始终存在
3. 如果构建链超过 128 个（`chainLimit`），按优先级修剪：
   - **始终保留**：基础构建（base）和当前构建（build）—— `pinned()`
   - **优先修剪**：字节数最少的层（最轻）
   - 记录被修剪的数量（`MemfileDroppedBuilds`/`RootfsDroppedBuilds`）
4. 按 UUID 字符串排序确保输出确定性
5. 返回 `SchedulingMetadata` proto（build IDs + 字节数 + dropped 数）

### pkg/service

InfoService gRPC 实现，报告 orchestrator 节点状态和指标。

| 类型 | 说明 |
|------|------|
| `Server` | 实现 `UnimplementedInfoServiceServer`。`ServiceInfo()` 返回节点 ID、版本、启动时间、角色、标签、机器信息、已分配资源、运行中沙箱数、主机指标 |
| `ServiceInfo` | 可变容器：`ClientId`、`ServiceId`、`SourceVersion`、`SourceCommit`、`Startup`、`Roles`、`Labels`、`MachineInfo`、线程安全 `status` |
| `MachineInfo` | CPU 检测：`Family`、`Model`、`ModelName`、`Flags`、`Arch`（ARM64 有回退值） |

### pkg/template/metadata

模板元数据的序列化/反序列化，定义模板构建的完整元数据结构。

**核心类型：**

| 类型 | 说明 |
|------|------|
| `Template` | 顶层结构：`Version`(2)、`TemplateMetadata`(BuildID/KernelVersion/FCVersion)、`Context`(User/WorkDir/EnvVars)、`Start`(StartCmd/ReadyCmd/Context)、`FromTemplate`(Alias/BuildID)、`FromImage`、`Prefetch` |
| `TemplateMetadata` | 构建标识：`BuildID`、`KernelVersion`、`FirecrackerVersion` |
| `MemoryPrefetchMapping` | 有序块索引 + 访问类型（r/w/p）+ 块大小 |
| `AccessType` | 枚举：`"r"`（读）、`"w"`（写）、`"p"`（预取） |
| `Prefetch` | 包装 `*MemoryPrefetchMapping` |
| `Context` | `User`、`WorkDir`、`EnvVars` |
| `Start` | `StartCmd`、`ReadyCmd`、`Context` |

**不可变拷贝方法：**
- `BasedOn(ft)` — 基于 ft 创建新版本模板，设置 `FromTemplate`
- `NewVersionTemplate(metadata)` — 新构建 ID，继承上下文和启动命令
- `SameVersionTemplate(metadata)` — 相同版本，更新元数据
- `WithPrefetch(prefetch)` — 附加预取映射

**序列化：** JSON 格式。版本 <= 1 的旧格式优雅降级为 `{Version: 1}`。

**`PrefetchEntriesToMapping(entries, blockSize)`** — 按 `Order` 排序原始预取块条目，转换为 `MemoryPrefetchMapping`。

**`UploadMetadata(ctx, persistence, template, objectMetadata)`** — 将模板元数据 JSON 上传到远程存储（GCS），支持附加存储对象元数据。

### pkg/parsing.go

`TryParseUUID(id string) (uuid.UUID, bool)` — 安全解析 UUID，失败或 `uuid.Nil` 返回 false。

---

## 12. 架构总览图

```
                         ┌─────────────────────┐
                         │    gRPC Server      │
                         │  (pkg/server)       │
                         │                     │
                         │ SandboxService      │
                         │ ChunkService        │
                         │ VolumeService       │
                         │ InfoService         │
                         └────────┬────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
                    ▼             ▼             ▼
            ┌───────────┐ ┌───────────┐ ┌──────────────┐
            │  Sandbox   │ │ Template  │ │   Events     │
            │  Factory   │ │  Cache    │ │  Service     │
            │            │ │           │ │              │
            │ Create     │ │ Get       │ │ Publish      │
            │ Resume     │ │ Evict     │ │ Close        │
            │ Pause      │ │ P2P share │ │              │
            │ Stop       │ │           │ │              │
            └─────┬──────┘ └─────┬─────┘ └──────────────┘
                  │              │
     ┌────────────┼──────────────┼────────────────┐
     │            │              │                │
     ▼            ▼              ▼                ▼
┌─────────┐ ┌─────────┐  ┌───────────┐   ┌───────────┐
│   FC    │ │ Network │  │  Block    │   │   UFFD    │
│Process  │ │  Pool   │  │  Device   │   │  Memory   │
│         │ │         │  │  Stack    │   │  Backend  │
│ Create  │ │ Slot    │  │           │   │           │
│ Resume  │ │ Firewall│  │ Cache     │   │ Userfaultfd│
│ Pause   │ │ NAT     │  │ Overlay   │   │ Prefetch  │
│ Stop    │ │ Egress  │  │ Memfd     │   │ Mapping   │
└────┬────┘ └────┬────┘  │ Tracker   │   └───────────┘
     │           │       │ Chunker   │
     │           │       └─────┬─────┘
     │           │             │
     ▼           ▼             ▼
┌─────────┐ ┌─────────┐  ┌───────────┐
│  Rootfs │ │  NBD    │  │  Cgroup   │
│Provider │ │  Pool   │  │  Manager  │
│         │ │         │  │           │
│ NBD     │ │Dispatch │  │ Create    │
│ Direct  │ │DirectMnt│  │ Stats     │
└─────────┘ └─────────┘  └───────────┘


   外部服务：
   ┌──────────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐
   │ TCP Firewall │  │   NFS    │  │ Hyperloop │  │ Sandbox  │
   │ (Egress)     │  │  Proxy   │  │  Server   │  │  Proxy   │
   │              │  │          │  │  (/me,    │  │          │
   │ Domain/CIDR │  │ Volumes  │  │  /logs)   │  │ Routing  │
   │ Filtering   │  │ via NFS  │  │           │  │ by ID    │
   └──────────────┘  └──────────┘  └───────────┘  └──────────┘
```

---

## 13. 核心接口总览

Orchestrator 通过接口实现模块间解耦。以下是所有关键接口及其实现：

### 接口层次

```
block.Slicer (Slice, BlockSize)
  └── block.ReadonlyDevice (ReadAt, Size, Close, Header, SwapHeader)
        └── block.Device (WriteAt, WriteZeroesAt)

block.FramedReader    ── 帧感知读取 (ReadAt with FrameTable)
block.FramedSlicer    ── 帧感知切片 (Slice with FrameTable)
block.CachePeeker     ── 缓存存在性检查 (IsCached)
block.DiffSource      ── Diff 层读取 (ReadAt, Slice, Size, Path)

nbd.Provider          ≈  block.Device (ReadAt + Size + WriterAt + WriteZeroesAt)
                        ↑ 由 *block.Overlay 满足
```

### 接口→实现映射

| 接口 | 方法 | 实现 |
|------|------|------|
| **`block.ReadonlyDevice`** | ReadAt, Size, Close, Slice, BlockSize, Header, SwapHeader | `*Local`（本地文件）、`*Empty`（零填充） |
| **`block.Device`** | + WriteAt, WriteZeroesAt | `*Overlay`（COW）、`*Cache` |
| **`block.DiffSource`** | ReadAt, Slice, Size, FileSize, BlockSize, Path, Close | `*Cache`、`*MemfdCache` |
| **`nbd.Provider`** | ReadAt, Size, WriteAt, WriteZeroesAt | `*block.Overlay` |
| **`rootfs.Provider`** | Start, Close, Path, ExportDiff | `*NBDProvider`（NBD 模式）、`*DirectProvider`（mmap 模式） |
| **`uffd.MemoryBackend`** | DiffMetadata, PrefetchData, Prefault, Start, Stop, Ready, Exit, Memfd, ServeStats | `*Uffd`（真实）、`*NoopMemory`（空操作） |
| **`network.Storage`** | Acquire, Release | `*StorageMemory`、`*StorageLocal`、`*StorageKV` |
| **`network.EgressProxy`** | OnSlotCreate, OnSlotDelete, CABundle | `*tcpfirewall.Proxy`、`*NoopEgressProxy` |
| **`template.Template`** | Files, Memfile, Rootfs, Snapfile, Metadata, UpdateMetadata, Close | `*LocalTemplate`、`*MaskTemplate` |
| **`template.File`** | Path, Close | `*storageFile`、`NoopFile` |
| **`build.Diff`** | Close, ReadAt, Slice + CacheKey, CachePath, Size, FileSize, BlockSize, RefreshSource | `*StorageDiff`（远程）、`*localDiff`（本地）、`*NoDiff`（空） |
| **`sandbox.MapSubscriber`** | OnInsert, OnNetworkRelease | `*proxy.SandboxProxy`、`*tcpfirewall.Proxy` |
| **`cgroup.Manager`** | Initialize, Create | `*managerImpl`（真实）、`*noopManager`（空操作） |

---

## 14. 端到端数据流

### 14.1 沙箱创建（从快照恢复）

```
gRPC Create()
  │
  ├─1. 检查节点容量 (MaxSandboxesPerNode)
  ├─2. 获取启动信号量 (MaxStartingInstancesPerNode)
  │
  ├─3. Template Cache 查找/获取
  │     │
  │     ├─ 本地缓存命中 → 直接返回
  │     ├─ 本地缓存未命中 → 从 GCS 获取
  │     │     ├─ 并行获取 memfile + rootfs + snapfile + metadata
  │     │     └─ P2P: 检查 peer 节点是否已有数据
  │     └─ NFS 缓存包装（如启用）
  │
  ├─4. Network Pool 获取 Slot
  │     ├─ Acquire IP 地址 (Storage: memory/local/KV)
  │     ├─ 创建 namespace + veth pair + tap + NAT + firewall
  │     └─ TCP Firewall 注册 iptables 规则
  │
  ├─5. Rootfs Provider 设置 (NBD 模式)
  │     ├─ NBD DevicePool 获取设备
  │     ├─ 创建 block.Overlay (readonly base + writable cache)
  │     └─ DirectPathMount 连接 NBD
  │
  ├─6. UFFD 内存后端启动
  │     ├─ 等待 FC 连接 Unix socket
  │     ├─ 接收 UFFD FD + 内存区域映射
  │     ├─ 启动 Userfaultfd.Serve() 轮询循环
  │     └─ 可选: Prefetcher 两阶段预取
  │
  ├─7. FC Process 恢复
  │     ├─ 加载快照 (通过 UFFD socket)
  │     ├─ 应用速率限制
  │     ├─ 恢复 VM
  │     └─ 设置 MMDS 元数据
  │
  ├─8. 等待 envd 初始化
  │     ├─ HTTP POST /init (无限重试)
  │     └─ 记录 UFFD 启动指标
  │
  └─9. 注册到 Map + 发布事件
        ├─ MarkRunning → 通知 OnInsert 订阅者
        ├─ AssignNetwork → IP 索引
        └─ 发布 SandboxResumedEventPair
```

### 14.2 沙箱暂停（打快照）

```
gRPC Pause()
  │
  ├─1. MarkStopping → 排除旧沙箱
  │
  ├─2. Sandbox.Pause()
  │     │
  │     ├─ 停止健康检查
  │     │
  │     ├─ Best-effort 回收
  │     │     ├─ [可选] Freeze user cgroup
  │     │     ├─ fstrim -av (回收未使用磁盘块)
  │     │     ├─ sync
  │     │     ├─ echo 3 > /proc/sys/vm/drop_caches
  │     │     └─ echo 1 > /proc/sys/vm/compact_memory
  │     │
  │     ├─ [可选] Drain balloon (free page hinting)
  │     │
  │     ├─ FC Process.Pause() → VM 暂停
  │     │
  │     ├─ FC Process.CreateSnapshot() → 创建 snapfile
  │     │
  │     ├─ 内存 diff 导出
  │     │     ├─ ExportMemory → Cache
  │     │     ├─ [可选] Memfd 后台拷贝
  │     │     ├─ [可选] 4KiB 页级去重 (DedupBudget)
  │     │     └─ Cache.ExportToDiff → memfile diff 文件
  │     │
  │     └─ Rootfs diff 导出
  │           ├─ NBD: eject cache → 停止沙箱 → 导出脏块
  │           └─ Direct: 扫描 mmap 文件 → DiffMetadata
  │
  ├─3. 本地缓存 → Template Cache 添加
  │
  ├─4. 异步上传到远程存储
  │     ├─ Upload (V3 或 V4 路径)
  │     ├─ [可选] 压缩
  │     ├─ 注册 P2P (上传期间 peer 可拉取)
  │     ├─ 完成后标记 uploadedBuilds
  │     └─ 取消 P2P 注册
  │
  └─5. 发布 SandboxPausedEventPair 事件
```

### 14.3 缺页处理（UFFD 读取路径）

```
VM 访问未映射内存页 → 缺页异常
  │
  ├─ Linux 内核 userfaultfd 机制捕获
  │
  ├─ Userfaultfd.Serve() 主循环收到事件
  │
  ├─ faultPage() 缺页处理
  │     ├─ 检查页面是否应为零页 → UFFDIO_ZEROPAGE
  │     └─ 非零页 → 从 PageReader 读取
  │           │
  │           └─ build.File.ReadAt()
  │                 │
  │                 ├─ planRead(): 遍历 header 映射表
  │                 │     └─ 分解为 readSegment[] (每个引用一个祖先构建)
  │                 │
  │                 ├─ getBuild(): DiffStore 缓存查找/创建
  │                 │     └─ StorageDiff: 解析压缩类型 → 打开上游
  │                 │
  │                 └─ readSegments(): 并行读取 [可选]
  │                       ├─ block.Chunker 本地缓存
  │                       ├─ 远程存储范围读取
  │                       └─ [可选] P2P peer 路由
  │
  ├─ UFFDIO_COPY 安装页面到客户机地址空间
  │
  └─ 返回，VM 继续执行
```

### 14.4 NFS 卷访问

```
沙箱内 mount -t nfs <host>:<export> /mnt/volume
  │
  ├─ Portmapper 查询 NFS/mountd 端口
  │     └─ portmap.Server → 返回注册的端口
  │
  ├─ NFS MOUNT 请求
  │     └─ NFSHandler.Mount()
  │           ├─ 通过源 IP 查找沙箱
  │           ├─ 验证挂载路径 (/volume_name)
  │           ├─ 匹配 VolumeMounts 中的卷
  │           └─ Builder.Chroot() → 创建隔离文件系统
  │                 ├─ 新 mount namespace (goroutine-locked OS 线程)
  │                 ├─ pivot_root 到卷目录
  │                 └─ 返回 wrappedFS (billy.Filesystem)
  │
  ├─ NFS 文件操作
  │     ├─ READ/WRITE → wrappedFS → chrooted → namespace 内执行
  │     ├─ SETATTR → wrappedChange → chrooted
  │     └─ 中间件栈: recovery → logging → metrics → tracing → caching
  │
  └─ 沙箱关闭时 OnNetworkRelease → 关闭所有 chroot
```

### 14.5 出口流量过滤

```
沙箱进程 → connect(dest:80)
  │
  ├─ iptables DNAT REDIRECT → httpPort (防火墙代理)
  │
  ├─ connectionHandler.HandleConn()
  │     ├─ getOriginalDst() → 获取 DNAT 前的 dest IP:port
  │     ├─ 查找沙箱 → 连接限制检查
  │     └─ 路由到处理器
  │
  ├─ domainHandler (HTTP Host header 可用)
  │     ├─ 提取 hostname
  │     ├─ isEgressAllowed() 策略判定
  │     │     ├─ allowed domains 匹配 → 允许
  │     │     ├─ allowed CIDRs 匹配 → 允许
  │     │     ├─ denied CIDRs 匹配 → 拒绝
  │     │     └─ default → 允许
  │     │
  │     ├─ [允许] proxyWithIPVerification()
  │     │     ├─ DNS 解析 hostname
  │     │     ├─ ControlContext: 检查解析 IP 不在内网范围
  │     │     └─ TCP connect → 双向代理
  │     └─ [拒绝] 关闭连接 + 记录指标
  │
  └─ 连接关闭 → 释放限制器槽位
```

---

## 15. Feature Flags 参考

所有 Feature Flags 通过 LaunchDarkly 管理。当 `LAUNCH_DARKLY_API_KEY` 未设置时使用离线测试数据。

### Bool Flags

| Flag | LD Key | 默认值 | 用途 |
|------|--------|--------|------|
| `MetricsWriteFlag` | `sandbox-metrics-write` | `true` | 控制 Pause/Resume 时是否写入沙箱指标到 ClickHouse |
| `SnapshotFeatureFlag` | `use-nfs-for-snapshots` | dev | 启用 NFS 支持的快照缓存 |
| `TemplateFeatureFlag` | `use-nfs-for-templates` | dev | 启用 NFS 支持的模板缓存 |
| `UseMemFdFlag` | `use-memfd` | `false` | 通过 UFFD socket 传递 memfd 支撑客户机内存 |
| `MemfdBackgroundCopyFlag` | `memfd-background-copy` | `false` | Pause 期间后台流式拷贝 memfd 到快照缓存 |
| `PeerToPeerChunkTransferFlag` | `peer-to-peer-chunk-transfer` | `false` | 启用跨节点 P2P 分块传输 |
| `PeerToPeerAsyncCheckpointFlag` | `peer-to-peer-async-checkpoint` | `false` | Checkpoint 异步上传（需 P2P 启用） |
| `FreePageReportingFlag` | `free-page-reporting` | `false` | 模板创建时启用 FC free page reporting |
| `FreezeUserCgroupFlag` | `freeze-user-cgroup` | dev | Pause 回收时冻结用户 cgroup |
| `ExecutionMetricsOnWebhooksFlag` | `execution-metrics-on-webhooks` | `false` | Webhook 中包含执行指标（已废弃） |
| `V4HeaderForUncompressedFlag` | `v4-header-for-uncompressed` | `false` | 未压缩上传强制 V4 header 布局 |
| `HeaderV5WriteFlag` | `header-v5-write` | `false` | Pause 输出 V5 header（取代 V4） |

### Int Flags

| Flag | LD Key | 默认值 | 用途 |
|------|--------|--------|------|
| `MaxSandboxesPerNode` | `max-sandboxes-per-node` | `200` | 每节点最大并发沙箱数 |
| `MaxStartingInstancesPerNode` | `max-starting-instances-per-node` | `3` | 每节点并发启动/恢复限制 |
| `EnvdInitTimeoutMilliseconds` | `envd-init-request-timeout-milliseconds` | `50` | envd init 请求超时（ms） |
| `BuildCacheMaxUsagePercentage` | `build-cache-max-usage-percentage` | `85` | 构建缓存磁盘使用率阈值（%） |
| `NBDConnectionsPerDevice` | `nbd-connections-per-device` | `1` | 每 NBD 设备的 socket 连接数 |
| `MemoryPrefetchMaxFetchWorkers` | `memory-prefetch-max-fetch-workers` | `16` | 内存预取最大并行获取工作器 |
| `MemoryPrefetchMaxCopyWorkers` | `memory-prefetch-max-copy-workers` | `8` | 内存预取最大并行拷贝工作器 |
| `TCPFirewallMaxConnectionsPerSandbox` | `tcpfirewall-max-connections-per-sandbox` | `-1` | 每沙箱 TCP 防火墙最大连接数 |
| `SandboxMaxIncomingConnections` | `sandbox-max-incoming-connections` | `-1` | 每沙箱 HTTP 代理最大连接数 |
| `MaxParallelBuildReadSegments` | `max-parallel-build-read-segments` | `1` | 单次碎片化构建读取的最大并行段数 |
| `MinChunkerReadSizeKB` | `min-chunker-read-size-kb` | `16` | 流式分块器最小读取批次大小（KB） |

### JSON Flags

| Flag | LD Key | 用途 |
|------|--------|------|
| `MemfileDiffDedupFlag` | `memfile-diff-dedup` | 4KiB 页级 memfile diff 去重配置 |
| `ReclaimConfigFlag` | `guest-pause-reclaim` | Pause 前回收链的每步超时配置 |
| `FreePageHintingConfig` | `free-page-hinting-config` | virtio-balloon free-page-hinting 和 drain 超时 |
| `CompressConfigFlag` | `compress-config` | 模板构建压缩设置 |
| `TCPFirewallEgressThrottleConfig` | `tcpfirewall-egress-throttle-config` | 每沙箱出口令牌桶限速 |
| `BlockDriveThrottleConfig` | `block-drive-throttle-config` | 每沙箱块设备令牌桶限速 |

---

## 16. 环境变量参考

### BuilderConfig（构建器和 orchestrator 共享）

| 环境变量 | 类型 | 默认值 | 说明 |
|----------|------|--------|------|
| `DOMAIN_NAME` | string | `""` | 构建环境域名 |
| `ENVD_TIMEOUT` | duration | `10s` | envd 操作超时 |
| `FIRECRACKER_VERSIONS_DIR` | string | `/fc-versions` | FC 二进制文件目录 |
| `BUSYBOX_VERSION` | string | `1.36.1` | Busybox 版本 |
| `HOST_BUSYBOX_DIR` | string | `/fc-busybox` | 主机 busybox 目录 |
| `HOST_ENVD_PATH` | string | `/fc-envd/envd` | envd 二进制文件路径 |
| `HOST_KERNELS_DIR` | string | `/fc-kernels` | 内核镜像目录 |
| `ORCHESTRATOR_BASE_PATH` | string | `/orchestrator` | 基础数据目录 |
| `SANDBOX_DIR` | string | `/fc-vm` | 沙箱 VM 文件目录 |
| `SHARED_CHUNK_CACHE_PATH` | string | (必填) | 共享分块缓存路径 |
| `TEMPLATES_DIR` | string | `${BASE}/build-templates` | 构建模板目录 |
| `DEFAULT_CACHE_DIR` | string | `${BASE}/build` | 默认缓存目录 |
| `PROVIDER` | string | `"gcp"` | 云提供商 |

### Config（完整 orchestrator，扩展 BuilderConfig）

| 环境变量 | 类型 | 默认值 | 说明 |
|----------|------|--------|------|
| `CLICKHOUSE_CONNECTION_STRING` | string | `""` | 主 ClickHouse 连接串 |
| `CLICKHOUSE_CONNECTION_STRINGS` | []string | `nil` | 额外 ClickHouse 端点（分号分隔） |
| `FORCE_STOP` | bool | `false` | 关闭时强制停止 |
| `GRPC_PORT` | uint16 | `5008` | gRPC 服务端口 |
| `LAUNCH_DARKLY_API_KEY` | string | `""` | LaunchDarkly API Key（空则离线模式） |
| `LOCAL_UPLOAD_BASE_URL` | string | `""` | 本地上传基础 URL |
| `NODE_IP` | string | `"localhost"` | 节点 IP（集群注册用） |
| `NODE_LABELS` | []string | `nil` | 节点标签（逗号分隔） |
| `ORCHESTRATOR_LOCK_PATH` | string | `/orchestrator.lock` | 锁文件路径 |
| `NFS_PROXY_LOGGING` | bool | `false` | NFS 代理日志 |
| `NFS_PROXY_TRACING` | bool | `false` | NFS 代理追踪 |
| `NFS_PROXY_METRICS` | bool | `true` | NFS 代理指标 |
| `NFS_PROXY_LOG_LEVEL` | string | `"info"` | NFS 代理日志级别 |
| `PROXY_PORT` | uint16 | `5007` | HTTP 代理端口 |
| `REDIS_CLUSTER_URL` | string | `""` | Redis 集群 URL |
| `REDIS_URL` | string | `""` | Redis 单机 URL |
| `NBD_POOL_SIZE` | int | `64` | NBD 设备池大小 |
| `ORCHESTRATOR_SERVICES` | []string | `"orchestrator"` | 运行的服务列表 |
| `PERSISTENT_VOLUME_MOUNTS` | map | `nil` | 持久卷挂载映射 |

---

> 本文档基于 `.understand-anything/knowledge-graph.json` 知识图谱和源代码分析生成。
> 覆盖 `packages/orchestrator/` 下全部约 170 个源文件、65+ 个核心类型、30+ 个接口定义。
