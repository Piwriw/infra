# Orchestrator 模块深度剖析

> 源码路径: [packages/orchestrator/](../../packages/orchestrator/)
> 旧版文档: [docs/orchestrator-module.md](../orchestrator-module.md)(828 行, 仍保留作为快速参考)
> 升级重点: 实测行号、新增配置项/Feature Flag 全表、gRPC 全端点签名、生命周期三态机、Pause/Checkpoint 数据流、优雅关闭四阶段、新增 prefetch harvest 路径、cgroup v2、cmux 多路复用、UFFD/Memfd 加速、AWS 兼容、`MaxStartingInstancesPerNode`、network slot 三 IP 分配、NBD/block/streaming chunk 完整栈

---

## 目录

0. [一句话定位](#0-一句话定位)
1. [模块在整体架构中的位置](#1-模块在整体架构中的位置)
2. [目录结构与职责](#2-目录结构与职责)
3. [启动流程](#3-启动流程-maingo--factoriesrun--run)
4. [配置体系](#4-配置体系)
5. [gRPC 接口全景](#5-grpc-接口全景)
6. [沙箱核心状态机](#6-沙箱核心状态机-pkgsandboxsandboxgo-1838-行)
7. [Firecracker 子系统](#7-firecracker-子系统-pkg-sandbox-fc-)
8. [块设备与 NBD 协议](#8-块设备与-nbd-协议)
9. [网络子系统](#9-网络子系统-pkgsandboxnetwork-2340-行)
10. [模板缓存与 P2P](#10-模板缓存与-p2p-pkg-sandbox-template-)
11. [cgroup 资源管控](#11-cgroup-资源管控-pkg-sandbox-cgroup-)
12. [Pause / Checkpoint 数据流](#12-pause--checkpoint-数据流)
13. [优雅关闭与 Drain](#13-优雅关闭与-drain)
14. [Feature Flags 全表](#14-feature-flags-全表)
15. [代码文件索引](#15-代码文件索引)
16. [设计要点与历史](#16-设计要点与历史)
17. [FAQ](#17-faq)
18. [附录](#18-附录)

---

## 0. 一句话定位

**Orchestrator = E2B 的 Linux 宿主机上的 Firecracker microVM 编排器**, 通过 gRPC 接收 API 层的沙箱生命周期请求, 负责 **VM 启停 / 暂停恢复 / 网络命名空间 / NBD 块设备 / 模板缓存 / 出入站流量控制 / 模板构建** 的全链路管理。它是 **VM 资源** 与 **API 调用** 之间的唯一桥梁, 强依赖 Linux 内核特性 (KVM / nbd / netns / cgroup v2 / iptables / veth / userfaultfd / unshare), `//go:build linux` 锁定平台。

---

## 1. 模块在整体架构中的位置

```
                   ┌──────────────────────────────────────┐
   user/SDK ──────▶│   API (Gin REST, packages/api/)      │
                   └────────────┬─────────────────────────┘
                                │ gRPC: SandboxService.Create/Update/...
                                ▼
   ┌────────────────────────────────────────────────────────────────┐
   │   Orchestrator (packages/orchestrator/)  ◀── 本文档主题          │
   │                                                                │
   │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
   │  │ gRPC server  │  │ sandbox.Map  │  │ Template Cache     │    │
   │  │ (Sandbox /   │  │ 3 索引:      │  │ + P2P peerclient   │    │
   │  │  Volume /    │  │ live/        │  │ + peerResolver     │    │
   │  │  Chunk /     │  │ lifecycles/  │  │ + Redis registry   │    │
   │  │  Template /  │  │ network      │  │                    │    │
   │  │  Info)       │  │              │  │                    │    │
   │  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘    │
   │         │                 │                   │                │
   │  ┌──────▼─────────────────▼───────────────────▼──────────────┐ │
   │  │       Sandbox (sandbox.go 1838 行) - VM 生命周期状态机      │ │
   │  └──────┬───────────┬─────────────┬──────────┬─────────────┬──┘ │
   │         │           │             │          │             │    │
   │   ┌─────▼─────┐ ┌───▼────┐  ┌─────▼─────┐ ┌──▼─────────┐ ┌▼──┐ │
   │   │ fc/       │ │ nbd/   │  │ network/  │ │ template/  │ │uffd│ │
   │   │ FC client │ │ dispatch│ │ veth+netns│ │ 多级缓存    │ │延迟│ │
   │   │ + process │ │ + pool │  │ + firewall│ │ + dedup     │ │分页│ │
   │   │ 2278 行   │ │ 1385 行│  │ 2340 行   │ │ 3313 行    │ │303 │ │
   │   └───────────┘ └────────┘  └───────────┘ └────────────┘ └───┘ │
   └────────────────────────────────────────────────────────────────┘
                                │ Connect RPC: ProcessService / FilesystemService
                                ▼
                          ┌──────────────┐
                          │ Envd (VM 内) │
                          └──────────────┘
```

**两条独立通道**:

| 通道 | 协议 | 用途 |
|------|------|------|
| 控制 | gRPC → FC REST (Unix Socket) → Connect RPC | 管理生命周期 |
| 数据 | NBD (TCP/Unix) / Direct-path (splice) / P2P (HTTP) | 拉模板、收发流量 |

---

## 2. 目录结构与职责

```
packages/orchestrator/
├── main.go                 # 56 行 - 进程入口
├── generate.go             # 占位 build tag
├── Makefile                # build/build-debug/build-template/run-* 目标
├── Dockerfile              # 多阶段 builder + scratch 镜像
│
├── benchmarks/             # 基准测试
│
├── cmd/                    # 一次性运维 CLI (非生产入口)
│   ├── clean-nfs-cache/    # NFS 缓存清理 (含 cleaner/scan/delete)
│   ├── copy-build/         # 拷贝 build 制品
│   ├── create-build/       # 手动触发 build
│   ├── dummy-orchestrator/ # 本地 mock orchestrator (集成测试用)
│   ├── hammer-file/        # I/O 压测工具
│   ├── inspect-build/      # 检查 build 制品 (validate/render_*)
│   ├── mount-build-rootfs/ # 挂载 build rootfs
│   ├── resume-build/       # 恢复 build (含 fph benchmark/gdb 调试)
│   ├── show-build-diff/    # 显示 build diff
│   ├── simulate-gcs-traffic/  # GCS 流量模拟
│   ├── simulate-nfs-traffic/  # NFS 流量模拟
│   └── smoketest/          # 端到端冒烟测试
│
└── pkg/                    # 业务实现
    ├── factories/          # 启动工厂 (1082 行核心 run.go)
    │   ├── run.go          # Run(opts) - 装载 30+ 子系统
    │   ├── cmux.go         # 39 行 - cmux 多路复用 (gRPC + HTTP 同端口)
    │   ├── http.go         # 9 行 - 通用 HTTP server 工厂
    │   └── featureflags_context.go  # 27 行 - LD context provider
    │
    ├── server/             # gRPC server 实现 (356 行 main + 1104 行 sandboxes)
    │   ├── main.go         # Server 聚合 + startingSandboxes 信号量
    │   ├── sandboxes.go    # 7 个 SandboxService 端点
    │   ├── chunks.go       # ChunkService (GetBuildFileSize/ReadAtBuildSeekable/GetBuildBlob)
    │   ├── template_cache.go # ListCachedBuilds
    │   ├── prefetch_harvest.go # 374 行 - Pause 后 warm-resume 收集 page-fault trace
    │   └── upload_retry.go # 上传重试策略
    │
    ├── sandbox/            # ⭐ 沙箱核心
    │   ├── sandbox.go      # 1838 行 - Sandbox/Factory + Create/Resume/Reboot
    │   ├── map.go          # 268 行 - 3 索引沙箱路由表
    │   ├── snapshot.go     # 63 行 - Snapshot 数据结构
    │   ├── diffcreator.go  # 24 行 - rootfs diff 构造接口
    │   ├── cleanup.go      # 124 行 - 顺序清理栈
    │   ├── reclaim.go      # 395 行 - 暂停前的 fstrim/sync/drop_caches/compact
    │   ├── envd.go         # 336 行 - envd HTTP 客户端 (freeze/fsfreeze/collapse)
    │   ├── envd_process.go # 70 行
    │   ├── checks.go       # 128 行 - 健康检查循环 (20s 间隔)
    │   ├── health.go       # 49 行
    │   ├── hoststats.go    # 48 行
    │   ├── hoststats_collector.go # 178 行
    │   ├── metrics.go      # 69 行
    │   ├── reboot.go       # 156 行 - filesystem-only 快照的冷启动恢复
    │   ├── uploads.go      # 236 行 - 异步上传管理 + Redis pub/sub
    │   ├── build_upload.go # 245 行 - v1 上传协议
    │   ├── build_upload_v3.go # 166 行 - v3 协议
    │   ├── build_upload_v4.go # 189 行 - v4 协议 (当前)
    │   ├── upload_metrics.go # 上传指标
    │   ├── cgroup/         # 569 行 manager.go + noop/reclaim - cgroup v2
    │   ├── block/          # 717 行 cache.go + 488 行 dedup.go + 427 行 memfd.go + ...
    │   ├── build/          # 385 行 cache.go + 482 行 storage_diff.go + 361 行 build.go
    │   ├── fc/             # 544 行 client.go + 828 行 process.go + 434 行 fc_metrics.go
    │   ├── nbd/            # 518 行 dispatch.go + 424 行 pool.go + 352 行 path_direct.go
    │   ├── network/        # 441 行 network.go + 415 行 pool.go + 420 行 slot.go + 473 行 firewall.go
    │   ├── template/       # 351 行 cache.go + 344 行 storage_template.go + peerclient/(~700 行)
    │   ├── uffd/           # 303 行 uffd.go + memory/ + prefetch/ + userfaultfd/ + fdexit/
    │   ├── rootfs/         # rootfs.Provider (NBD vs Direct)
    │   ├── socket/         # 29 行 - FC Unix socket 路径
    │   ├── envd/           # envd Connect RPC client
    │   └── artifact/       # 7 行 - artifact 名称常量
    │
    ├── cfg/                # 配置模型
    │   ├── model.go        # 206 行 - Config + BuilderConfig + Parse
    │   └── service.go      # 81 行 - ServiceType (orchestrator / template-manager)
    │
    ├── template/           # template-manager 模式
    │   ├── build/          # 构建流水线 (~8263 行) phases/{base,user,optimize,finalize}
    │   ├── cache/          # build_cache.go - buildID → 状态/日志
    │   ├── constants/      # service name
    │   ├── metadata/       # 8263 行 模板元信息 (含 IsFilesystemOnly/MarkFilesystemOnly)
    │   ├── server/         # TemplateManager gRPC 实现
    │   └── template/       # 模板辅助
    │
    ├── volumes/            # 卷服务 (gRPC VolumeService)
    ├── chrooted/           # chroot 沙箱 (本地 build 用)
    ├── tcpfirewall/        # TCP 防火墙 (默认 EgressFactory)
    ├── proxy/              # 入站代理 (用户 → VM 流量)
    ├── portmap/            # RPC 端口映射 (NFS proxy 用)
    ├── hyperloopserver/    # 内部传输 (VM 间通信)
    ├── nfsproxy/           # NFS 代理 (持久卷挂载, 含 chroot/logged/metrics/tracing/recovery)
    ├── events/             # 沙箱事件流抽象
    ├── healthcheck/        # 健康检查 handler
    ├── localupload/        # 本地上传 handler (template-manager 用)
    ├── metrics/            # 356 行 - host/sandbox 指标
    ├── dummyserver/        # 集成测试用 mock
    ├── service/            # 146 行 ServiceInfo + 89 行 InfoService + machineinfo
    ├── startupreclaim/     # 启动时清理上次残留的 netns/cgroup
    ├── scheduling/         # 调度元数据 (BestOfK)
    └── version/            # 版本号
```

**重要纠正** (与旧版文档差异):

| 项 | 旧版 | 实际 |
|----|------|------|
| 业务代码根 | `internal/` | `pkg/` (CLAUDE.md 也已过时) |
| run.go 行数 | 1000+ | 1082 行 |
| sandbox.go 行数 | 未给出 | 1838 行 |
| FC client.go | 未给行数 | 544 行 |
| network.go | 未给行数 | 441 行 |
| 入口可定制点 | "EgressFactory" | 也叫 `Options.EgressFactory` |

---

## 3. 启动流程 (`main.go` → `factories.Run` → `run`)

### 3.1 入口: [packages/orchestrator/main.go](../../packages/orchestrator/main.go) (56 行)

```go
//go:build linux

func main() {
    applyTestFlagOverrides()  // 测试环境变量 → LD flag 覆盖

    factories.Run(factories.Options{
        Version:       version.Version,
        CommitSHA:     commitSHA,
        EgressFactory: defaultEgressFactory,  // 默认 tcpfirewall.New
    })
}

func applyTestFlagOverrides() {
    // TESTS_MEMFILE_DIFF_DEDUP_MODE=best_effort|direct_io → MemfileDiffDedupFlag
    // TESTS_DISABLE_MEMFD=true → UseMemFdFlag=false
}

func defaultEgressFactory(_ context.Context, deps *factories.Deps) (*factories.EgressSetup, error) {
    fw := tcpfirewall.New(deps.Logger, deps.Config.NetworkConfig, deps.Sandboxes, deps.MeterProvider, deps.FeatureFlags)
    return &factories.EgressSetup{Proxy: fw, Start: fw.Start, Close: fw.Close}, nil
}
```

**main.go 只做 3 件事**: 测试 flag 覆盖、注入 EgressFactory、委托给 `factories.Run`。

### 3.2 启动工厂: [packages/orchestrator/pkg/factories/run.go](../../packages/orchestrator/pkg/factories/run.go) (1082 行)

`Run(opts Options) bool` 是整个进程**最复杂的函数**, 按严格依赖拓扑装配 30+ 子系统。

#### 阶段 1: 基础 (run.go:127-281)

```go
config, err := cfg.Parse()              // 解析 ~50 个环境变量
ensureDirs(config)                       // mkdir 8 个缓存目录
acquireOrchestratorLock(OrchestratorLockPath)  // /orchestrator.lock flock (单实例锁)
machineInfo, _ := machineinfo.Detect()   // CPU 平台检测 (placement 匹配)
serviceInfo := service.NewInfoContainer(nodeID, version, commitSHA, serviceInstanceID, machineInfo, config)
```

**单实例锁** (run.go:175-228):
- `flock.TryLock()` 失败时读 lock 文件中的 PID 报告"another instance is running with pid X"
- 锁文件路径默认 `/orchestrator.lock`, 可通过 `ORCHESTRATOR_LOCK_PATH` 覆盖
- 仅在 `!env.IsDevelopment() && usesSandboxRuntime` 时启用
- 干净退出时 `os.Remove(OrchestratorLockPath)` 以兼容旧版基于 stat 的释放机制

#### 阶段 2: 基础设施 (run.go:297-373)

```go
tel, err := telemetry.New(ctx, nodeID, serviceName, commitSHA, version, serviceInstanceID, ...)
tel.StartRuntimeInstrumentation()  // Go runtime metrics

globalLogger := utils.Must(logger.NewLogger(...))
sbxLoggerExternal := sbxlogger.NewLogger(...)  // 给用户看的沙箱日志
sbxLoggerInternal := sbxlogger.NewLogger(...)  // 给内部用的沙箱日志
sbxlogger.SetSandboxLoggerExternal(sbxLoggerExternal)
sbxlogger.SetSandboxLoggerInternal(sbxLoggerInternal)
```

#### 阶段 3: 数据后端 (run.go:410-631)

```go
featureFlags, _ := featureflags.NewClient()
limiter, _ := limit.New(ctx, featureFlags)  // GCP 并发上传限流
persistence, _ := storage.GetStorageProvider(ctx, storage.TemplateStorageConfig.WithLimiter(limiter))
blockMetrics, _ := blockmetrics.NewMetrics(tel.MeterProvider)

redisClient, _ := sharedFactories.NewRedisClient(ctx, ...)
peerRegistry := peerclient.NewRedisRegistry(redisClient, *nodeAddress)
peerResolver := peerclient.NewResolver(peerRegistry, *nodeAddress)
templateCache, _ := template.NewCache(config, featureFlags, persistence, blockMetrics, peerResolver)

// ClickHouse: 主端点 + 多附加端点 (sandbox events + hoststats delivery)
// Redis Streams: 第二条事件投递链
// cgroupManager.Initialize() → 在 /sys/fs/cgroup/e2b 下建根
```

**多 ClickHouse 端点** (run.go:511-598): `CLICKHOUSE_CONNECTION_STRINGS` (分号分隔) 中除主端点外的所有端点会被独立 driver + delivery 隔离, 一个慢端点不影响其他; 重复 DSN 被 `AdditionalClickhouseEndpoints()` 去重并 log。

#### 阶段 4: 网络与代理 (run.go:640-716)

```go
sandboxProxy, _ := proxy.NewSandboxProxy(tel.MeterProvider, config.ProxyPort, sandboxes, featureFlags)
egressSetup, _ := opts.EgressFactory(ctx, deps)  // 默认 tcpfirewall

// startupreclaim: 清理上次崩溃留下的 ns-* 命名空间
if usesSandboxRuntime && !config.DisableStartupReclaim {
    startupreclaim.Run(ctx, startupreclaim.Config{...})
}

devicePool, _ := nbd.NewDevicePool(config.NBDPoolSize)  // 默认 64
devicePool.Populate(ctx)

slotStorage, _ := newStorage(ctx, nodeID, config.NetworkConfig, egressSetup.Proxy)
networkPool := network.NewPool(network.NewSlotsPoolSize, network.ReusedSlotsPoolSize, slotStorage, config.NetworkConfig)
networkPool.Populate(ctx)
```

**NewPool 参数** (network/pool.go:130):
- `NewSlotsPoolSize = 32` (新 slot channel 容量 31)
- `ReusedSlotsPoolSize = 100` (复用 slot channel 容量 100)

#### 阶段 5: 业务服务 (run.go:718-782)

```go
sandboxFactory := sandbox.NewFactory(config.BuilderConfig, networkPool, devicePool, featureFlags, hostStatsDelivery, cgroupManager, egressSetup.Proxy, sandboxes)
builder := chrooted.NewBuilder(config)
volumeService := volumes.New(config, builder)
uploads := sandbox.NewUploads(templateCache, persistence, peerResolver, redisClient)

orchestratorService, _ := server.New(ctx, server.ServiceConfig{
    Config, SandboxFactory, Tel, NetworkPool, DevicePool, TemplateCache,
    Info: serviceInfo, Proxy: sandboxProxy, Persistence, FeatureFlags,
    SbxEventsService: eventsService, PeerRegistry, Uploads,
})

// NFS proxy (条件启动): 仅当 len(config.PersistentVolumeMounts) > 0
//   - portmapper 端口默认 5012
//   - nfs proxy 端口默认 5011
// hyperloopserver: 监听 HyperloopProxyPort 默认 5010
```

#### 阶段 6: gRPC + cmux (run.go:799-920)

```go
grpcServer := e2bgrpc.NewGRPCServer(tel, e2bgrpc.WithSandboxResumeMetrics())
orchestrator.RegisterSandboxServiceServer(grpcServer, orchestratorService)
orchestrator.RegisterVolumeServiceServer(grpcServer, volumeService)
orchestrator.RegisterChunkServiceServer(grpcServer, orchestratorService)
// 条件: services.RunsTemplateManager()
templatemanager.RegisterTemplateServiceServer(grpcServer, tmpl)
orchestratorinfo.RegisterInfoServiceServer(grpcServer, infoService)
grpc_health_v1.RegisterHealthServer(grpcServer, grpcHealth)

cmuxServer, _ := NewCMUXServer(ctx, config.GRPCPort, tel.MeterProvider)  // 默认 5008
httpListener := cmuxServer.Match(cmux.HTTP1Fast())  // /health, /upload
grpcListener := cmuxServer.Match(cmux.Any())        // gRPC 流量
// ⚠️ 必须在 Serve() 之前完成所有 Match(), 否则数据竞争

startService("grpc server", func() error { return grpcServer.Serve(grpcListener) })
startService("http server", func() error { return httpServer.Serve(httpListener) })
```

**HTTP 路由** (run.go:888-893):
- `GET /health` → `healthcheck.CreateHandler()` (基于 `serviceInfo.GetStatus()`)
- `POST /upload` → `localupload.Handler` (仅 template-manager + 本地存储模式)

#### 阶段 7: 等待关闭 (run.go:922-985)

```go
select {
case <-sig.Done():         // SIGINT/SIGTERM/SIGUSR1
case serviceErr := <-serviceError:  // 任一服务异常退出
}

closeCtx, cancelCloseCtx := context.WithCancel(context.Background())
if config.ForceStop { cancelCloseCtx() }  // 强制关闭跳过等待

// 1. Mark Draining (15s 传播时间)
if status := serviceInfo.GetStatus().Status; status == Healthy || status == Standby {
    serviceInfo.SetStatus(ctx, Draining)
    if !env.IsLocal() { time.Sleep(15 * time.Second) }
}

// 2. 等 template-manager drain
if tmpl != nil { tmpl.Wait(closeCtx) }

// 3. 等所有沙箱退出 (除非 ForceStop)
if !config.ForceStop {
    orchestratorService.DrainSandboxes(closeCtx)
}

// 4. 反向关闭所有 closer
slices.Reverse(closers)
for _, closer := range closers { closer.close(closeCtx) }

// 5. 等 errgroup 退出
g.Wait()
```

### 3.3 关键设计: `Deps` + `EgressFactory`

```go
type Deps struct {
    Config        cfg.Config
    Tel           *telemetry.Client
    MeterProvider metric.MeterProvider
    Logger        logger.Logger
    Sandboxes     *sandbox.Map           // 全进程唯一的沙箱路由表
    FeatureFlags  *featureflags.Client
}

type EgressFactory func(ctx context.Context, deps *Deps) (*EgressSetup, error)
```

`EgressFactory` 是**唯一可定制点**——`dummy-orchestrator` (集成测试) 和不同发行版可注入不同实现, 主流程代码不变。

---

## 4. 配置体系

### 4.1 [packages/orchestrator/pkg/cfg/model.go](../../packages/orchestrator/pkg/cfg/model.go) (206 行)

#### `BuilderConfig` (cfg/model.go:23-41) - 模板构建 + 沙箱运行共享

| 字段 | 环境变量 | 默认 | 说明 |
|------|---------|------|------|
| `DomainName` | `DOMAIN_NAME` | `""` | 用于构造 sandbox host |
| `FirecrackerVersionsDir` | `FIRECRACKER_VERSIONS_DIR` | `/fc-versions` | FC 二进制版本目录 |
| `BusyboxVersion` | `BUSYBOX_VERSION` | `1.36.1` | |
| `HostBusyboxDir` | `HOST_BUSYBOX_DIR` | `/fc-busybox` | |
| `HostEnvdPath` | `HOST_ENVD_PATH` | `/fc-envd/envd` | envd 二进制路径 |
| `HostKernelsDir` | `HOST_KERNELS_DIR` | `/fc-kernels` | 内核目录 |
| `OrchestratorBaseDir` | `ORCHESTRATOR_BASE_PATH` | `/orchestrator` | |
| `SandboxDir` | `SANDBOX_DIR` | `/fc-vm` | 单沙箱运行时数据 |
| `SharedChunkCacheDir` | `SHARED_CHUNK_CACHE_PATH` | `""` | 跨沙箱共享 chunk |
| `TemplatesDir` | `TEMPLATES_DIR` | `${ORCHESTRATOR_BASE_PATH}/build-templates` | |
| `DefaultCacheDir` | `DEFAULT_CACHE_DIR` | `${ORCHESTRATOR_BASE_PATH}/build` | build 缓存 |
| `Provider` | `PROVIDER` | `gcp` | `gcp` 或 `aws` |
| `StorageConfig` | 嵌套 | | 对象存储配置由 shared storage provider 解析 |
| `NetworkConfig` | 嵌套 | | 见 [网络配置](#网络配置-networkpoolgo60-87) |

#### `Config` (cfg/model.go:79-107) - Orchestrator 运行时

| 字段 | 环境变量 | 默认 | 说明 |
|------|---------|------|------|
| `ClickhouseConnectionString` | `CLICKHOUSE_CONNECTION_STRING` | `""` | 主 CH 端点 |
| `ClickhouseConnectionStrings` | `CLICKHOUSE_CONNECTION_STRINGS` | `[]` | 分号分隔, 多端点 |
| `DisableStartupReclaim` | `DISABLE_STARTUP_RECLAIM` | `false` | 跳过 netns 回收 |
| `ForceStop` | `FORCE_STOP` | `false` | 不等沙箱 drain |
| `GRPCPort` | `GRPC_PORT` | `5008` | gRPC + HTTP (cmux) |
| `LaunchDarklyAPIKey` | `LAUNCH_DARKLY_API_KEY` | `""` | |
| `LocalUploadBaseURL` | `LOCAL_UPLOAD_BASE_URL` | `""` | 本地上传 base |
| `NodeIP` | `NODE_IP` | `localhost` | P2P 注册用 |
| `NodeLabels` | `NODE_LABELS` | `[]` | 逗号分隔, 调度标签 |
| `OrchestratorLockPath` | `ORCHESTRATOR_LOCK_PATH` | `/orchestrator.lock` | 单实例 flock |
| `NFSProxyLogging` | `NFS_PROXY_LOGGING` | `false` | |
| `NFSProxyTracing` | `NFS_PROXY_TRACING` | `false` | |
| `NFSProxyMetrics` | `NFS_PROXY_METRICS` | `true` | |
| `NFSProxyRecordHandleCalls` | `NFS_PROXY_RECORD_HANDLE_CALLS` | `false` | |
| `NFSProxyRecordStatCalls` | `NFS_PROXY_RECORD_STAT_CALLS` | `false` | |
| `NFSProxyLogLevel` | `NFS_PROXY_LOG_LEVEL` | `info` | |
| `ProxyPort` | `PROXY_PORT` | `5007` | 入站 HTTP 代理 |
| `RedisClusterURL` | `REDIS_CLUSTER_URL` | `""` | |
| `RedisTLSCABase64` | `REDIS_TLS_CA_BASE64` | `""` | |
| `RedisURL` | `REDIS_URL` | `""` | |
| `RedisPoolSize` | `REDIS_POOL_SIZE` | `5` | |
| `RedisMinIdleConns` | `REDIS_MIN_IDLE_CONNS` | `2` | |
| `NBDPoolSize` | `NBD_POOL_SIZE` | `64` | /dev/nbdX 池 |
| `Services` | `ORCHESTRATOR_SERVICES` | `orchestrator` | 逗号分隔, 可加 `template-manager` |
| `PersistentVolumeMounts` | `PERSISTENT_VOLUME_MOUNTS` | `map{}` | name → path |

#### 网络配置 (network/pool.go:60-87)

| 字段 | 环境变量 | 默认 | 说明 |
|------|---------|------|------|
| `OrchestratorInSandboxIPAddress` | `SANDBOX_ORCHESTRATOR_IP` | `192.0.2.1` | 沙箱看到的 orchestrator IP |
| `HyperloopProxyPort` | `SANDBOX_HYPERLOOP_PROXY_PORT` | `5010` | |
| `NFSProxyPort` | `SANDBOX_NFS_PROXY_PORT` | `5011` | |
| `PortmapperPort` | `SANDBOX_PORTMAPPER_PORT` | `5012` | |
| `UseLocalNamespaceStorage` | `USE_LOCAL_NAMESPACE_STORAGE` | `false` | 用本地 storage 替代 Consul KV |
| `AllowSandboxInternalCIDRs` | `ALLOW_SANDBOX_INTERNAL_CIDRS` | `""` | 逗号分隔, 私网段白名单 |
| `SandboxTCPFirewallHTTPPort` | `SANDBOX_TCP_FIREWALL_HTTP_PORT` | `5016` | |
| `SandboxTCPFirewallTLSPort` | `SANDBOX_TCP_FIREWALL_TLS_PORT` | `5017` | |
| `SandboxTCPFirewallOtherPort` | `SANDBOX_TCP_FIREWALL_OTHER_PORT` | `5018` | |
| `SandboxEgressDSCP` | `SANDBOX_EGRESS_DSCP` | `0` | 0..63, CS1=8 是 Scavenger |

#### Service 选择 (cfg/service.go)

```go
type ServiceType string  // "orchestrator" | "template-manager" | "orch-unknown"

// GetServiceName([]) → "orchestrator"
// GetServiceName([orchestrator, template-manager]) → "orchestrator_template-manager"
// UsesSandboxRuntime() = RunsOrchestrator() || RunsTemplateManager()
```

### 4.2 Nomad 部署: [iac/modules/job-orchestrator/jobs/orchestrator.hcl](../../iac/modules/job-orchestrator/jobs/orchestrator.hcl) (94 行)

```hcl
job "orchestrator-${latest_orchestrator_job_id}" {
  type      = "system"     # 每节点一份
  node_pool = "${node_pool}"
  priority  = 91

  group "client-orchestrator" {
    network {
      port "orchestrator"        { static = "${port}" }        # 5008
      port "orchestrator-proxy"  { static = "${proxy_port}" }  # 5007
    }

    service {
      name     = "orchestrator"
      port     = "${port}"
      provider = "nomad"
      check {
        type = "http"  path = "/health"  interval = "20s"  timeout = "5s"
      }
    }

    task "start" {
      driver = "raw_exec"  # 直接在 host 跑 (需要 root + KVM + nbd)
      restart { attempts = 0 }  # 不重启, 由 Nomad reschedule

      resources { memory = 1024  memory_max = -1 }  # 不限内存上限

      env {
        NODE_ID     = "$${node.unique.name}"
        NODE_IP     = "$${attr.unique.network.ip-address}"
        NODE_LABELS = "$${meta.node_labels}"
        GRPC_PORT   = "${port}"
        PROXY_PORT  = "${proxy_port}"
        # ... job_env_vars (来自 Terraform var)
      }

      config {
        command = "/bin/bash"
        args    = ["-c", "chmod +x local/orchestrator && local/orchestrator"]
      }

      artifact {
        source      = "${artifact_source}"  # gcs::https://... 或 s3::https://...
        destination = "local/orchestrator"
        mode        = "file"
      }
    }
  }
}
```

**`latest_orchestrator_job_id`** (terraform main.tf): `random_id.orchestrator_job.hex` 8 字节随机 ID, 触发条件为 orchestrator 二进制 checksum 或 job 模板变化; 用于约束 + 滚动升级 (`constraint { attribute = "$${meta.orchestrator_job_version}" value = "${latest_orchestrator_job_id}" }`)。

**GCP 默认值** (iac/provider-gcp/variables.tf):
- `orchestrator_node_pool = "default"`
- `orchestrator_port = 5008`
- `orchestrator_proxy_port = 5007`
- `orchestrator_enabled = true` (设为 false 跳过部署而不删除模块)

---

## 5. gRPC 接口全景

定义在 `packages/shared/pkg/grpc/orchestrator/orchestrator.proto`, 实现在 `pkg/server/sandboxes.go` (1104 行)。

### 5.1 `SandboxService` (7 个 RPC)

| RPC | 实现位置 | 入参 | 出参 | 用途 |
|-----|---------|------|------|------|
| `Create` | sandboxes.go:75 | `SandboxCreateRequest` | `SandboxCreateResponse` | 创建/恢复沙箱 (含 cold/reboot) |
| `Update` | sandboxes.go:338 | `SandboxUpdateRequest` | `emptypb.Empty` | 更新 end_time / egress |
| `List` | sandboxes.go:460 | `emptypb.Empty` | `SandboxListResponse` | 列出本节点沙箱 |
| `Delete` | sandboxes.go:491 | `SandboxDeleteRequest` | `emptypb.Empty` | 销毁 |
| `Pause` | sandboxes.go:599 | `SandboxPauseRequest` | `SandboxPauseResponse` | 暂停 + 生成 snapshot |
| `Checkpoint` | sandboxes.go:699 | `SandboxCheckpointRequest` | `SandboxCheckpointResponse` | 检查点 (写 build, 不删 VM) |
| `ListCachedBuilds` | template_cache.go:14 | `emptypb.Empty` | `SandboxListCachedBuildsResponse` | 节点模板缓存查询 |

### 5.2 关键常量 (sandboxes.go:44-72)

```go
const (
    requestTimeout          = 60 * time.Second  // 单个 RPC 上限
    acquireTimeout          = 15 * time.Second  // 等待 starting semaphore (snapshot resume)
    uploadTimeout           = 20 * time.Minute  // 单次上传尝试上限
    uploadTotalBudget       = 2 * time.Hour     // 整体重试窗口
    redisPeerKeyTTL         = uploadTotalBudget + 2*time.Minute  // 2h2m
    uploadRetryInitialBackoff = 5 * time.Second
    uploadRetryMaxBackoff     = 2 * time.Minute
    uploadRetryBackoffMultiplier = 2
    executionEventDataKey    = "execution"
    killReasonUnknown        = "unknown"
)
```

### 5.3 `Create` 端点 (sandboxes.go:75-336) - 详解

```go
func (s *Server) Create(ctx, req) (_ *SandboxCreateResponse, createErr error) {
    ctx, cancel := context.WithTimeoutCause(ctx, requestTimeout, errors.New("request timed out"))
    defer cancel()

    isResume := req.GetSandbox().GetSnapshot()  // 是否从 snapshot 恢复
    // ...

    // 1. 容量检查
    maxRunningSandboxesPerNode := s.featureFlags.IntFlag(ctx, featureflags.MaxSandboxesPerNode)  // 默认 200
    if s.sandboxFactory.Sandboxes.Count() >= maxRunningSandboxesPerNode {
        return nil, status.Errorf(codes.ResourceExhausted, "max number of running sandboxes on node reached (%d)", ...)
    }

    // 2. 并发启动限流 (MaxStartingInstancesPerNode 默认 3)
    if req.GetSandbox().GetSnapshot() {
        err := s.waitForAcquire(ctx)  // 阻塞等, 最多 acquireTimeout
    } else {
        acquired := s.startingSandboxes.TryAcquire(1)  // 非阻塞, 失败立即返回
        if !acquired { return nil, status.Errorf(codes.ResourceExhausted, "too many sandboxes starting") }
    }
    defer s.startingSandboxes.Release(1)

    // 3. BYOP egress proxy 检查
    if req.GetSandbox().GetNetwork().GetEgress().GetEgressProxyAddress() != "" {
        if !s.featureFlags.BoolFlag(ctx, featureflags.BYOPProxyEnabledFlag) { ... PermissionDenied }
        if !s.sandboxFactory.EgressProxy().SupportsBYOP() { ... Unimplemented }
    }

    // 4. 拿模板
    template, err := s.templateCache.GetTemplate(ctx, req.GetSandbox().GetBuildId(), req.GetSandbox().GetSnapshot(), false, ...)

    // 5. 解析 FC 版本 (支持 LaunchDarkly 覆盖)
    resolvedFCVersion := featureflags.ResolveFirecrackerVersion(ctx, s.featureFlags, req.GetSandbox().GetFirecrackerVersion())

    // 6. 路径分支: filesystem-only snapshot → RebootSandbox; 否则 → ResumeSandbox
    meta, _ := template.Metadata()
    var sbx *sandbox.Sandbox
    if meta.IsFilesystemOnly() {
        sbx, err = s.sandboxFactory.RebootSandbox(ctx, template, config, runtime, req.GetEndTime().AsTime(), req.GetSandbox())
    } else {
        sbx, err = s.sandboxFactory.ResumeSandbox(ctx, template, config, runtime, req.GetStartTime().AsTime(), req.GetEndTime().AsTime(), req.GetSandbox())
    }
    // ...

    s.setupSandboxLifecycle(ctx, sbx)  // 设置 endAt, 定时器, 监控

    // 7. 事件 (Redis Streams + ClickHouse 双投递)
    eventType := events.SandboxCreatedEventPair
    if isResume { eventType = events.SandboxResumedEventPair }
    go s.sbxEventsService.Publish(context.WithoutCancel(ctx), teamID, events.SandboxEvent{...})

    return &SandboxCreateResponse{...}, nil
}
```

### 5.4 `VolumeService` / `ChunkService` / `InfoService` / `TemplateService`

- **VolumeService** (`pkg/volumes/`): create/delete/file/path/dir 操作, 支持持久卷
- **ChunkService** (`pkg/server/chunks.go` 186 行): 块级数据访问
  - `GetBuildFileSize` / `GetBuildFileExists`
  - `ReadAtBuildSeekable` (streaming)
  - `GetBuildBlob` (streaming)
- **InfoService** (`pkg/service/`): 节点元信息、沙箱列表、CPU/内存使用
- **TemplateService** (`pkg/template/server/`): 仅在 `services.RunsTemplateManager()` 时注册

### 5.5 健康检查

**gRPC 标准 health** (run.go:841-842):
```go
grpcHealth := health.NewServer()
grpc_health_v1.RegisterHealthServer(grpcServer, grpcHealth)
```

**HTTP health** (run.go:883-889): `GET /health` → `serviceInfo.GetStatus()`:
- `Healthy` (默认初始)
- `Standby` (等待分配)
- `Draining` (退出中, 不接受新沙箱)
- `Unhealthy`

---

## 6. 沙箱核心状态机 ([pkg/sandbox/sandbox.go](../../packages/orchestrator/pkg/sandbox/sandbox.go)) (1838 行)

### 6.1 顶层结构 (sandbox.go:89-311)

```go
type Config struct {
    BaseTemplateID string
    Vcpu, RamMB, TotalDiskSizeMB int64
    HugePages, FreePageReporting, FreePageHinting bool
    Envd EnvdMetadata
    FirecrackerConfig fc.Config
    SkipEnvdWait bool  // 仅 gdb 调试用
    VolumeMounts []VolumeMountConfig
    MaxSandboxLengthHours int64
    mu      *sync.RWMutex
    Network *orchestrator.SandboxNetworkConfig
}

type Sandbox struct {
    *Resources  // Slot, rootfs, memory
    *Metadata   // Config, Runtime, startedAt, endAt

    LifecycleID string  // 每次 FC 进程唯一, 与 ExecutionID 区分

    config  cfg.BuilderConfig
    files   *storage.SandboxFiles
    cleanup *Cleanup
    sandboxes *Map
    featureFlags *featureflags.Client
    process      *fc.Process
    cgroupHandle *cgroup.CgroupHandle
    Template template.Template
    Checks *Checks
    hostStatsCollector *HostStatsCollector

    APIStoredConfig *orchestrator.SandboxConfig  // Deprecated
    CABundle string
    exit *utils.ErrorOnce
    stop utils.Lazy[error]
    startupStatsOnce sync.Once
    skipStartupMetrics bool
}

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

### 6.2 三种启动路径

| 方法 | 用途 | 入口 |
|------|------|------|
| `CreateSandbox` (sandbox.go:396) | 从模板 build 冷启动 (新建 VM) | 仅 build 沙箱用 |
| `ResumeSandbox` (sandbox.go:698) | 从 memory snapshot 恢复 | 生产主路径 |
| `RebootSandbox` (reboot.go:39) | 从 filesystem-only snapshot 冷启动 | fs-only 快照恢复 |

**`StartType` 枚举** (sandbox.go:62-68):
```go
const (
    StartTypeCreate StartType = "create"  // 冷启动 (template build)
    StartTypeResume StartType = "resume"  // 从 memory snapshot 恢复 (主路径)
    StartTypeReboot StartType = "reboot"  // 从 fs-only snapshot 冷启动
)
```

### 6.3 `ResumeSandbox` 并发资源初始化 (sandbox.go:698-900)

```
1. 三个 Promise 并发启动:
   ├── uffdPromise: 加载 memfile, 创建 uffd.Uffd (含 Unix socket)
   ├── ipsPromise: networkPool.Acquire → veth slot
   └── overlayPromise: 模板 rootfs → NBDProvider
   (memoryPromise 依赖 uffdPromise, serveMemory 把 memfd mmap 进 FC)

2. 可选: prefetch goroutine (sandbox.go:751-790)
   如果 meta.Prefetch.Memory != nil → prefetch.New(...).Start(execCtx)
   在 uffd 就绪后开始按 prefetch mapping 异步 page-in

3. 等所有 Promise 完成

4. cgroup 创建 (createCgroup → /sys/fs/cgroup/e2b/sandbox-<cgroupName>)

5. fcHandle := fc.NewProcess(...)
   → unshare -m → bash -c <startScript> 启动 firecracker 二进制
   → API socket 在 files.SandboxFirecrackerSocketPath()

6. fcHandle.Resume(...)
   - loadSnapshot(snapfilePath, uffdSocket)  → FC 通过 uffd 拉 memfile
   - 等 uffd ready chan
   - resumeVM()

7. s.WaitForEnvd() → 等 envd Connect RPC 就绪 (默认 10s)

8. s.initEnvd(startType=resume) → POST /init (env_vars, sandbox_id, ...)

9. sandboxes.MarkRunning(ctx, sbx)
   → live[sandboxID] = sbx
   → lifecycles[sandboxID/lifecycleID] = sbx
   → trigger OnInsert subscribers (proxy 等)
```

### 6.4 Sandbox 方法 (sandbox.go)

| 方法 | 行号 | 用途 |
|------|------|------|
| `Wait` | 1122 | 等 FC 进程退出 |
| `Close` | 1126 | 跑 cleanup + MarkStopped |
| `Stop` | 1141 | 幂等杀沙箱 (Lazy init) |
| `doStop` | 1148 | Checks.Stop + FC.Stop + cgroup.Kill + uffd.Stop |
| `Shutdown` | 1185 | 暂停 + 丢弃 snapshot + Close (用于资源回收) |
| `Pause` | 1253 | 暂停 + 生成 snapshot, 返回 *Snapshot |
| `processMemorySnapshot` | 1456 | 创建 memfile + rootfs diff |
| `FlushAndReadBalloonMetrics` | 1515 | balloon 指标 |
| `MemoryPrefetchData` | 1520 | 给 harvest 用 |
| `WaitForExit` | 1719 | 等 FC 进程退出 (区别于 WaitForEnvd) |
| `WaitForEnvd` | 1740 | 等 envd HTTP /health 就绪 |

### 6.5 沙箱路由表 `Map` ([pkg/sandbox/map.go](../../packages/orchestrator/pkg/sandbox/map.go), 268 行)

**三个独立索引** (map.go:28-58):

```go
type Map struct {
    live       *smap.Map[*Sandbox]  // sandboxID → Sandbox (运行中)
    lifecycles *smap.Map[*Sandbox]  // sandboxID/lifecycleID → Sandbox (含清理中)
    network    *smap.Map[*Sandbox]  // IP → Sandbox (供 GetByHostPort)

    lifecycleMu      sync.Mutex
    lifecycleChanged chan struct{}  // WaitLifecycles 用
    subs     []MapSubscriber
    subsLock sync.RWMutex
}
```

**不变量**: `live ⊆ lifecycles`, `MarkRunning` 同时插入两者。

**关键方法**:
- `MarkRunning(ctx, sbx)` (map.go:172) - 插入 live + lifecycles, 触发 `OnInsert`
- `MarkStopping(ctx, sandboxID, lifecycleID)` (map.go:197) - 仅从 live 移除, 保留 lifecycles
- `MarkStopped(ctx, sbx)` (map.go:223) - 从 lifecycles 移除, 通知 `WaitLifecycles`
- `GetByHostPort(hostPort)` (map.go:132) - 由 proxy 调用, 通过 IP 查
- `AssignNetwork(ctx, sbx)` (map.go:147) - 注册 IP → Sandbox
- `NetworkReleased(ctx, ip)` (map.go:243) - 移除 IP, 触发 `OnNetworkRelease`
- `WaitLifecycles(ctx)` (map.go:111) - 阻塞直到所有 lifecycles 清理完

**订阅者接口** (map.go:21-26):
```go
type MapSubscriber interface {
    OnInsert(ctx context.Context, sandbox *Sandbox)
    OnNetworkRelease(ctx context.Context, sbx *Sandbox)
}
```

订阅者: `proxy.SandboxProxy` (路由表)、`tcpfirewall` (egress 规则)、`metrics.Observer` (OTEL gauge)。

---

## 7. Firecracker 子系统 ([pkg/sandbox/fc/](../../packages/orchestrator/pkg/sandbox/fc/))

### 7.1 [client.go](../../packages/orchestrator/pkg/sandbox/fc/client.go) (544 行) - FC REST API 客户端

封装 Firecracker Unix Socket REST API:

| 方法 | 行号 | 对应 FC API | 用途 |
|------|------|------------|------|
| `loadSnapshot` | 42 | `PUT /snapshot/load` | 从 memfile+snapfile 恢复 |
| `resumeVM` | 94 | `PUT /vm/resume` | 恢复已暂停 VM |
| `pauseVM` | 114 | `PUT /vm/pause` | 暂停 VM |
| `createSnapshot` | 131 | `PUT /snapshot/create` | 生成 snapshot |
| `setMmds` | 151 | `PUT /mmds` | 注入元数据 (env vars, access token hash) |
| `flushMetrics` | 168 | `PUT /metrics` + 读 FIFO | 拉取 FC 内部指标 |
| `setMetrics` | 185 | `PUT /metrics` | 配置 metrics FIFO 路径 |
| `setBootSource` | 201 | `PUT /boot-source` | 内核 + cmdline |
| `setRootfsDrive` | 215 | `PUT /drives/rootfs` | rootfs 块设备 |
| `buildTokenBucket` | 242 | - | TokenBucket 辅助 |
| `buildRateLimiter` | 262 | - | RateLimiter 辅助 (网络/磁盘限速) |
| `setTxRateLimit` | 277 | `PATCH /network-interfaces/{iface}` | 网络限速 |
| `setDriveRateLimit` | 304 | `PATCH /drives/{drive}` | 磁盘限速 |
| `setNetworkInterface` | 327 | `PUT /network-interfaces/{id}` | 绑定 tap |
| `setMachineConfig` | 361 | `PUT /machine-config` | vCPU / 内存 / hugepages |
| `setEntropyDevice` | 398 | `PUT /entropy` | virtio-rng |
| `startVM` | 420 | `POST /actions` (InstanceStart) | 启动 |
| `installBalloon` | 440 | `PUT /balloon` | virtio-balloon (FPH/FPR) |
| `startBalloonHinting` | 465 | - | 触发 hinting |
| `describeBalloonHinting` | 486 | - | 查 hinting 状态 |
| `memoryMapping` | 499 | `GET /memory-migration` | 内存映射 |
| `memoryInfo` | 512 | - | DiffMetadata |
| `dirtyMemory` | 529 | - | 脏页统计 |

**MMDS 元数据** (sandbox/fc/mmds.go, 12 行): 包含 `SandboxID`, `TemplateID`, `LogsCollectorAddress`, `AccessTokenHash` (访问 token 的 SHA256)。

### 7.2 [process.go](../../packages/orchestrator/pkg/sandbox/fc/process.go) (828 行) - FC 进程管理

```go
type Process struct {
    Versions Config
    cmd *exec.Cmd
    config                cfg.BuilderConfig
    firecrackerSocketPath string
    metricsPath           string
    slot           *network.Slot
    rootfsProvider rootfs.Provider
    rootfsPath, kernelPath string
    files          *storage.SandboxFiles
    Exit *utils.ErrorOnce
    client *apiClient
    balloonAccum atomic.Pointer[BalloonMetricsSnapshot]
}
```

**关键设计 - unshare + nsenter** (process.go:195-202):
```go
cmd := exec.CommandContext(execCtx,
    "unshare", "-m", "--",  // 新 mount namespace
    "bash", "-c", startScript.Value,
)
cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}  // 新 session
```

每个沙箱一个独立 FC 进程, 用 mount namespace 隔离 rootfs 链接, 便于 cgroup 隔离和快速清理。

**核心方法**:

| 方法 | 行号 | 用途 |
|------|------|------|
| `NewProcess` | 159 | 构造 Process, 准备 startScript |
| `configure` | 227 | 启动 FC 进程 + 等 API socket 就绪 |
| `Create` | 319 | 冷启动 (setBootSource/RootfsDrive/NetworkInterface/MachineConfig/startVM) |
| `Resume` | 513 | 从 snapshot 恢复 (loadSnapshot + resumeVM) |
| `Pid` | 669 | FC 进程 PID |
| `Stop` | 677 | 发 SIGTERM + 等 exit |
| `Pause` | 749 | PUT /vm/pause |
| `DrainBalloon` | 762 | 等待 FPH 完成 |
| `CreateSnapshot` | 823 | PUT /snapshot/create |

**`ext4RootFlags = "discard"`** (process.go:86): ext4 mount flags, 启用 TRIM 让释放的块不进入 snapshot diff。**绝不** 包含 `noload` - fs-only 快照恢复依赖 journal 重放。

**`Create` 步骤** (process.go:319-511):
1. `/dev/null` 软链到 rootfs link 路径(占位)
2. `p.configure(...)` 启动 FC 进程
3. `startMetricsReader` goroutine (在 setMetrics 之前)
4. `setMetrics(metricsPath)` 配置 FIFO
5. 拼装 KernelArgs (含 `ip`, `init`, `rootflags`, `quiet`, `panic=1`, `reboot=k`)
6. `setBootSource(kernelArgs, kernelPath)`
7. 真实 rootfs 路径软链
8. `setRootfsDrive(rootfsPath, ioEngine, rateLimiter)`
9. `setNetworkInterface(vpeer, tapName, tapMAC, txRateLimiter)`
10. `setMachineConfig(vCPU, memoryMB, hugePages)`
11. `setEntropyDevice()` (virtio-rng)
12. 条件: `installBalloon(freePageReporting, freePageHinting)`
13. 条件: `setMmds(...)` (仅 AccessToken 非空时, 即 cold boot)
14. `startVM()`

### 7.3 [fc_metrics.go](../../packages/orchestrator/pkg/sandbox/fc/fc_metrics.go) (434 行)

FC 输出的 metrics FIFO 解析:
- `fcLogFilter` (process.go:46) 过滤掉每几秒一次的 `FlushMetrics` 噪音
- `BalloonMetricsSnapshot` 累积 balloon 统计 (FC 的 SharedIncMetric 每次 flush 重置)
- `pollFphDone` (process.go:802) 等 first-page-hit drain

### 7.4 Kernel Args 与版本管理

**默认版本** (packages/shared/pkg/featureflags/flags.go:461-478):
```go
const (
    DefaultKernelVersion           = "vmlinux-6.1.158"
    DefaultFirecrackerV1_10Version = "v1.10.1_30cbb07"
    DefaultFirecrackerV1_12Version = "v1.12.1_210cbac"
    DefaultFirecrackerV1_14Version = "v1.14.1_431f1fc"
    DefaultFirecrackerVersion      = DefaultFirecrackerV1_14Version
)

FirecrackerVersionMap = map[string]string{
    "v1.10": "v1.10.1_30cbb07",
    "v1.12": "v1.12.1_210cbac",
    "v1.14": "v1.14.1_431f1fc",
}
```

`featureflags.ResolveFirecrackerVersion` 允许 LaunchDarkly 按沙箱上下文覆盖 FC 版本, 用于金丝雀升级。

---

## 8. 块设备与 NBD 协议

### 8.1 [pkg/sandbox/nbd/dispatch.go](../../packages/orchestrator/pkg/sandbox/nbd/dispatch.go) (518 行) - NBD Wire Protocol

VM 内 FC 进程通过 NBD 协议访问 host 上的块设备。dispatcher 处理:

> 下表 `NBD_CMD_*` 是 [NBD 协议规范](https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md) 定义的命令名; `处理函数` 是本仓库的 Go 实现。`DISC`/`FLUSH`/`TRIM` 在当前实现中无独立处理路径。

| NBD 命令 (协议规范) | 处理函数 | 行号 | 用途 |
|---------|---------|------|------|
| `NBD_CMD_READ` | `cmdRead` | 287 | 读 |
| `NBD_CMD_WRITE` | `cmdWrite` | 374 | 写 |
| `NBD_CMD_WRITE_ZEROES` | `cmdWriteZeroes` | 450 | 写零 (TRIM 优化) |
| `NBD_CMD_DISC` | - | - | 断开 |
| `NBD_CMD_FLUSH` | - | - | flush |
| `NBD_CMD_TRIM` | - | - | TRIM |

**`NBDAsyncWriteZeroesFlag`** (flags.go:297-303): 启用后 WRITE_ZEROES/TRIM 在 goroutine 中处理, 避免阻塞读循环导致 kernel NBD 超时。

### 8.2 [pool.go](../../packages/orchestrator/pkg/sandbox/nbd/pool.go) (424 行) - /dev/nbdX 池

```go
const (
    waitOnNBDError                = 50 * time.Millisecond
    devicePoolCloseReleaseTimeout = 10 * time.Minute
    sysBlockDir                   = "/sys/block"
)

type DevicePool struct { ... }

var (
    ErrNBDModuleNotLoaded = errors.New("NBD module not loaded")
    ErrClosed             = errors.New("cannot read from a closed pool")
)

// NewDevicePool(maxSlotsReady int) - 默认 maxSlotsReady=NBDPoolSize=64
// Populate: 预热 maxSlotsReady 个设备
// GetDevice(ctx) DeviceSlot - 获取
// release(ctx, idx) - 释放
```

`/dev/nbdX` 总数受内核 module 参数限制 (默认 16~256), DevicePool 预热并复用避免每次 `Create` 都 open/close。`NBDConnectionsPerDevice` (默认 1) 控制每设备的 socket 连接数。

### 8.3 [path_direct.go](../../packages/orchestrator/pkg/sandbox/nbd/path_direct.go) (352 行) - 零拷贝直读

**性能关键路径**——绕过 NBD 用户态协议, 直接 splice/sendfile 把模板文件发到 VM 内核 page cache, 避免双重拷贝。

```go
const (
    // /sys/block/nbdX
)

func NewDirectPathMount(b block.Device, devicePool *DevicePool, featureFlags *featureflags.Client, opts ...MountOption) *DirectPathMount

// Open: 绑定 /dev/nbdX 到 b (block.Device)
// Close: 解绑
// WithIOTimeout / WithDeadconnTimeout 可调
```

### 8.4 [pkg/sandbox/block/](../../packages/orchestrator/pkg/sandbox/block/) - 块缓存与去重

| 文件 | 行号 | 用途 |
|------|------|------|
| `cache.go` | 717 | 内容寻址块缓存 |
| `dedup.go` | 488 | 4 KiB 页去重 (against base memfile) |
| `memfd.go` | 427 | memfd 内存映射 (替代 process_vm_readv) |
| `streaming_chunk.go` | 400 | 流式 chunk 读取 |
| `fetch_session.go` | 170 | fetch 会话复用 |
| `prefetch_tracker.go` | 101 | 预取追踪 |
| `overlay.go` | 101 | overlay 块设备 |
| `iov.go` | 76 | iovec |
| `local.go` | 129 | 本地文件 |
| `range.go` | 58 | 范围 |
| `device.go` | 67 | Device 接口 |
| `tracker.go` | 117 | tracker |
| `empty.go` | 76 | 空设备 |

**`MemfileDiffDedupFlag`** (JSON): 控制 4 KiB 页 dedup 行为
```json
{
  "enabled": false,
  "bestEffort": false,        // 跳过未缓存块
  "directIO": false,           // O_DIRECT 打开 dedup 输出
  "maxFetchWindowsPerBlock": 0,
  "maxPromotedParentPagesPerBlock": 0,
  "maxPagesPerPromotedFrame": 0,
  "blockFaultPct": 0,
  "fetchRunWindowPages": 0
}
```

**`UseMemFdFlag`** (默认 true): 让 FC 用 memfd backing, 通过 UFFD socket 传 fd, 直接 mmap 而非 `process_vm_readv`。

**`MemfdBackgroundCopyFlag`** (默认 true): 后台 goroutine 把 memfd 流式写入 snapshot cache, 让 Pause 在 diff metadata 写完后立即返回。

---

## 9. 网络子系统 ([pkg/sandbox/network/](../../packages/orchestrator/pkg/sandbox/network/)) (2340 行)

### 9.1 [slot.go](../../packages/orchestrator/pkg/sandbox/network/slot.go) (420 行) - 单个网络 slot

**三 IP 分配** (slot.go:46-59):
```
For each slot, we allocate three IP addresses:
- Host IP - 用于 host 访问 sandbox (host mask /32)
- Vpeer IP + Veth IP - 沙箱与 host 通信 (vrt mask /31, 每 slot 2 个 IP)

Host default namespace creates a /16 CIDR block:
  Slot with Idx 1 → 10.11.0.1, Idx 2 → 10.11.0.2, ...
  (host mask /32, 每 slot 1 IP)

Vrt addresses 从 /31 CIDR (默认 10.12.0.0/16):
  Vpeer = 第一个 IP, Veth = 第二个 IP
  (每 slot 2 个 IP, /31 CIDR)
```

**常量** (slot.go:26-38):
```go
const (
    defaultHostNetworkCIDR = "10.11.0.0/16"  // 可通过 SANDBOXES_HOST_NETWORK_CIDR 覆盖
    defaultVrtNetworkCIDR  = "10.12.0.0/16"  // 可通过 SANDBOXES_VRT_NETWORK_CIDR 覆盖
    hostMask               = 32
    vrtMask                = 31
    vrtAddressPerSlot      = 1 << (32 - vrtMask)  // 2
    tapMask                = 30
    tapInterfaceName       = "tap0"
    tapIp                  = "169.254.0.22"
    tapMAC                 = "02:FC:00:00:00:05"
)
```

**Slot 字段** (slot.go:60-86): `Key`, `Idx`, `Firewall`, `vPeerIp`, `vEthIp`, `vrtMask`, `tapIp`, `HostIP`, `hostNet`, `hostCIDR`, `hyperloopPort`, `egressProxy`, `config`。

**关键方法**:
- `VpeerName() = "eth0"` (slot.go:150) - 沙箱内看到的网卡名
- `VethName() = "veth-{idx}"` (slot.go:162) - host 端
- `NamespaceIP() = "169.254.0.21"` (slot.go:186)
- `NamespaceID() = "ns-{idx}"` (slot.go:190)
- `TapName() = "tap0"` (slot.go:194)
- `ConfigureInternet(ctx, network)` (slot.go:251) - 应用 egress/ingress 规则
- `UpdateInternet(ctx, egress)` (slot.go:287)
- `DenyEgress(ctx)` (slot.go:320) - 全部拒绝 (resume 前隔离)
- `ResetInternet(ctx)` (slot.go:351)

### 9.2 [network.go](../../packages/orchestrator/pkg/sandbox/network/network.go) (441 行) - veth + netns

**`CreateNetwork` (network.go:78)** 步骤:
1. `runtime.LockOSThread()` 防线程切换
2. 保存 host netns
3. 检查 stale namespace → 若存在则 `RemoveNetwork` 回收
4. `netns.NewNamed(s.NamespaceID())` 创建沙箱命名空间 `ns-{idx}`
5. 创建 veth pair: `veth-{idx}` (host) + `eth0` (sandbox, peer)
6. `vpeer` 设 UP, 配 vpeer IP
7. 把 `veth` 移回 host netns
8. 切回 host netns
9. 配置 veth + tap
10. 设置路由
11. iptables NAT

**幂等清理** (network.go:30-76): `ignoreExpectedAbsent` 包装器, 让"已不存在"的错误不传播。

**`RemoveNetwork` (network.go:352)**: 反向销毁, 处理 race condition。

### 9.3 [pool.go](../../packages/orchestrator/pkg/sandbox/network/pool.go) (415 行) - 双 channel slot 池

```go
type Pool struct {
    config Config
    done     chan struct{}
    doneOnce sync.Once
    closeMu sync.RWMutex
    closed  bool
    newSlots    chan *Slot  // 容量 NewSlotsPoolSize-1 = 31
    reusedSlots chan *Slot  // 容量 ReusedSlotsPoolSize = 100
    returnsWG sync.WaitGroup
    slotStorage Storage
}

const (
    NewSlotsPoolSize    = 32
    ReusedSlotsPoolSize = 100
    ReturnDelay = 3 * time.Second  // 让 inflight 请求 drain, 减少复用抖动
)
```

**复用机制**: 删除沙箱时 veth 不立即销毁, 而是 `ReturnAsync(ctx, slot, ..., returnDelay=ReturnDelay)` 放回 reusedSlots; 下次 `Get(ctx)` 优先取回, 避免反复配 iptables。

**Populate (pool.go:160)** 后台 goroutine 持续填满 newSlots channel 直到容量上限。

**metrics**: `orchestrator.network.slots_pool.new/reused/acquired/returned/released` 5 个 OTEL counter。

### 9.4 [firewall.go](../../packages/orchestrator/pkg/sandbox/network/firewall.go) (473 行) - nftables 防火墙

```go
const tableName = "slot-firewall"  // nft 表名

type Firewall struct { ... }

func NewFirewall(tapIf, orchestratorInternalIP string, extraAllowedCIDRs []string) (_ *Firewall, err error)
func (fw *Firewall) ApplyRules(ctx, byop bool, allowedCIDRs, deniedCIDRs []string) error
func (fw *Firewall) DenyEgress(ctx) error
func (fw *Firewall) Close() error
```

基于 `google/nftables` 包, 在 nft 表 `slot-firewall` 上为每个 tap 接口生成规则链。规则:
- 接受 established/related 连接
- 接受 allowed CIDRs
- 拒绝 denied CIDRs (默认私网段 10.0.0.0/8, 172.16.0.0/12 等)
- 接受 orchestrator internal IP (`192.0.2.1`)
- BYOP 模式: 切换到外部代理

### 9.5 Storage 三实现

| 实现 | 文件 | 用途 |
|------|------|------|
| `StorageLocal` | storage_local.go (222 行) | 本地 dev 用, 扫描 `/var/run/netns` |
| `StorageKV` | storage_kv.go (156 行) | Consul KV 协调多节点 |
| `StorageMemory` | storage_memory.go (59 行) | 测试用 |

**`newStorage` (run.go:1076)**:
```go
func newStorage(ctx, nodeID, config, egressProxy) (network.Storage, error) {
    if env.IsDevelopment() || config.UseLocalNamespaceStorage {
        return network.NewStorageLocal(ctx, config, egressProxy)
    }
    return network.NewStorageKV(nodeID, config, egressProxy)
}
```

`NetNamespacesDir = "/var/run/netns"` (storage_local.go:31)。

### 9.6 Egress 与 Ingress

| 方向 | 实现 | 配置 |
|------|------|------|
| Egress (出站) | `tcpfirewall.New(...)` (默认 EgressFactory) | 端口 5016/5017/5018 (HTTP/TLS/Other), DSCP 标记 |
| Ingress (入站) | `proxy.NewSandboxProxy(...)` | 端口 5007, 通过沙箱 IP 路由 |

`SandboxTCPFirewallHTTPPort/TLSPort/OtherPort` 三端口分离避免 server-first 协议 (如 SSH) 的检测阻塞。

`EgressProxy` 接口 (egressproxy.go, 43 行):
```go
type EgressProxy interface {
    SupportsBYOP() bool
    // ...
}
```

---

## 10. 模板缓存与 P2P ([pkg/sandbox/template/](../../packages/orchestrator/pkg/sandbox/template/))

### 10.1 [cache.go](../../packages/orchestrator/pkg/sandbox/template/cache.go) (351 行) - 多级缓存

```go
const (
    templateExpiration       = 25 * time.Hour  // 比 max sandbox lifetime 长
    templateExpirationBuffer = 1 * time.Hour
    buildCacheTTL            = 25 * time.Hour
    buildCacheDelayEviction  = 60 * time.Second
)

type Cache struct {
    config        cfg.Config
    flags         *featureflags.Client
    cache         *ttlcache.Cache[string, Template]
    persistence   storage.StorageProvider
    buildStore    *build.DiffStore
    blockMetrics  blockmetrics.Metrics
    rootCachePath string
    peers         peerclient.Resolver
    extendMu      sync.Mutex
}
```

**OnEviction 回调** (cache.go:77): 模板被驱逐时 `peers.Purge(item.Key())` + `template.Close(ctx)` 清理本地文件。

**`cleanDir(config.DefaultCacheDir)`** (cache.go:89): 启动时清理旧 build 缓存目录, 避免陈旧数据。

**层级**:
```
1. 内存 ttlcache (25h TTL)        ← 最快
2. 本地磁盘 (memfile/rootfs)      ← SandboxCacheDir
3. P2P peer (Redis 注册)          ← 二进制直拉
4. NFS 共享存储                    ← GCP Filestore
5. GCS / S3 远端                   ← 冷备, 异步上传
```

### 10.2 [peerclient/](../../packages/orchestrator/pkg/sandbox/template/peerclient/) - P2P 客户端

| 文件 | 行号 | 用途 |
|------|------|------|
| `registry.go` | 65 | Redis 注册中心 (`SADD` 节点列表) |
| `resolver.go` | 192 | 给定 templateID 返回 peer 列表 |
| `storage.go` | 317 | 远端存储抽象 |
| `blob.go` | 189 | blob 流式下载 |
| `seekable.go` | 205 | seekable 流式下载 |

**Redis 注册** (run.go:454-457):
```go
peerRegistry := peerclient.NopRegistry()
peerResolver := peerclient.NopResolver()
if nodeAddress := config.NodeAddress(); redisClient != nil && nodeAddress != nil {
    peerRegistry = peerclient.NewRedisRegistry(redisClient, *nodeAddress)
    peerResolver = peerclient.NewResolver(peerRegistry, *nodeAddress)
}
```

`NodeAddress()` 返回 `nil` 当 `NodeIP == "localhost"`, 即本地开发时不启用 P2P。

**`PeerToPeerChunkTransferFlag`** (默认 false): 总开关。
**`PeerToPeerAsyncCheckpointFlag`** (默认 false): Checkpoint 时 fire-and-forget 上传, 仅在 P2P 启用后才安全。

### 10.3 [peerserver/](../../packages/orchestrator/pkg/sandbox/template/peerserver/) - P2P 服务端

| 文件 | 行号 | 用途 |
|------|------|------|
| `peerserver.go` | 46 | 入口 |
| `file.go` | 111 | 文件服务 |
| `seekable.go` | 60 | seekable 服务 |
| `header.go` | 55 | header 服务 |
| `metadata.go` | 43 | metadata 服务 |
| `resolve.go` | 64 | 解析 |

### 10.4 [storage_template.go](../../packages/orchestrator/pkg/sandbox/template/storage_template.go) (344 行)

```go
type storageTemplate struct {
    paths storage.CachePaths
    memfile  *utils.SetOnce[block.ReadonlyDevice]
    rootfs   *utils.SetOnce[block.ReadonlyDevice]
    snapfile *utils.SetOnce[File]
    metafile *utils.SetOnce[File]
    memfileHeader *utils.SetOnce[*header.Header]
    rootfsHeader  *utils.SetOnce[*header.Header]
    localSnapfile File
    localMetafile File
    metrics     blockmetrics.Metrics
    persistence storage.StorageProvider
}

// Fetch: 并行拉取 memfile/rootfs/snapfile/metafile
//   - 优先用 localSnapfile/localMetafile (Pause 后立即复用)
//   - 否则从 persistence (GCS/S3) 拉
```

### 10.5 `pkg/template/build/` (8263 行) - template-manager 构建流水线

仅在 `services.RunsTemplateManager()` 时启用。包含:

- `phases/base/` (397 行 builder + 260 行 provision + 64 行 hash + 83 行 files)
- `phases/user/` (81 行 builder + 20 行 hash)
- `phases/optimize/` (270 行 builder + 56 行 prefetch)
- `phases/finalize/` (350 行 builder + 118 行 configure + 86 行 ready)
- `phases/steps/` (250 行 builder + 55 行 factory)
- `core/rootfs/` (282 行 rootfs + 70 行 templates)
- `core/oci/` (501 行 oci + 85 行 layer_file + auth/)
- `core/filesystem/` (390 行 ext4)
- `core/envd/` (18 行)
- `storage/cache/`、`storage/paths/`

---

## 11. cgroup 资源管控 ([pkg/sandbox/cgroup/](../../packages/orchestrator/pkg/sandbox/cgroup/))

### 11.1 [manager.go](../../packages/orchestrator/pkg/sandbox/cgroup/manager.go) (569 行)

```go
const (
    cgroupV2MountPoint = "/sys/fs/cgroup"
    RootCgroupPath     = cgroupV2MountPoint + "/e2b"
    NoCgroupFD         = -1
    cgroupKillTimeout      = 2 * time.Second
    cgroupKillPollInterval = 100 * time.Millisecond
)

type CgroupHandle struct {
    cgroupName     string
    path           string
    file           *os.File  // cgroup dir FD
    memoryPeakFile *os.File  // memory.peak FD
    manager        *managerImpl
    removed        bool
    noop           bool
}

// 生命周期: Create → GetFD → cmd.Start() → ReleaseCgroupFD → GetStats (循环) → Remove
```

**cgroup 树**:
```
/sys/fs/cgroup/e2b                ← RootCgroupPath
   ├── orchestrator-<pid>          ← 进程自身
   ├── sandbox-<cgroupName>        ← 每沙箱一个
   │    ├── firecracker            ← FC 进程
   │    ├── envd
   │    └── uffd
```

**关键设计 - CgroupFD** (manager.go GetFD/ReleaseCgroupFD):
- `cmd.Start()` 前调用 `GetFD()` 拿 cgroup dir FD
- `SysProcAttr.CgroupFD` 让内核在 clone 时**原子**地把新进程放入 cgroup
- `cmd.Start()` 后立即 `ReleaseCgroupFD()` (内核已经 placed)
- `memory.peak` FD 故意保留, 因为 per-FD reset 机制要求同一个 FD

### 11.2 [noop.go](../../packages/orchestrator/pkg/sandbox/cgroup/noop.go) (36 行)

`NoopManager` 测试用, 不创建真实 cgroup。

### 11.3 [reclaim.go](../../packages/orchestrator/pkg/sandbox/cgroup/reclaim.go) (35 行)

cgroup 级别的回收辅助。

---

## 12. Pause / Checkpoint 数据流

### 12.1 [reclaim.go](../../packages/orchestrator/pkg/sandbox/reclaim.go) (395 行) - 暂停前的回收

**`buildReclaimScript` (reclaim.go:50)** 根据 `ReclaimConfigFlag` 拼装:
```bash
rc=0; \
timeout -s KILL %.3f sh -c "fstrim -av" >/dev/null 2>&1 || rc=$?; \
timeout -s KILL %.3f sh -c "sync" >/dev/null 2>&1 || rc=$?; \
timeout -s KILL %.3f sh -c "echo 3 > /proc/sys/vm/drop_caches" >/dev/null 2>&1 || rc=$?; \
timeout -s KILL %.3f sh -c "echo 1 > /proc/sys/vm/compact_memory" >/dev/null 2>&1 || rc=$?; \
exit $rc
```

四步 cap 来自 `ReclaimConfig`:
- `Fstrim` - TRIM 释放块
- `Sync` - fsync dirty page cache
- `DropCaches` - 清页缓存
- `CompactMemory` - 内存碎片整理

**超时常量** (reclaim.go:23-46):
```go
const (
    reclaimOuterSlack           = 500 * time.Millisecond  // shell 启动 + envd 往返
    freezeTimeout               = 2 * time.Second
    syncMinTimeout              = 5 * time.Second
    syncMaxTimeout              = 2 * time.Minute
    syncFlushFloorBytesPerSec   = 50 * 1024 * 1024  // 50 MiB/s 悲观底线
)
```

**`bestEffortReclaim` (reclaim.go:83)** 顺序:
1. `FreezeUserCgroupFlag` (LD, 默认 dev=true) → `bestEffortFreeze`
2. `CollapseEnvdHeapFlag` (LD, 默认 false) → `bestEffortCollapse`
3. 运行 reclaim script via envd

**`guestPrepareFsForPause` (reclaim.go:168)** - **强制**的 pre-pause fsync (filesystem-only 快照必需, 因为 FC 不 flush guest page cache, 没有 memory snapshot 保存它)。

### 12.2 `Sandbox.Pause` 流程 (sandbox.go:1253-1455)

```
1. cleanup := NewCleanup() defer 错误时回滚
2. cachePaths := storage.Paths{BuildID: m.Template.BuildID}.Cache(s.config.StorageConfig)
3. s.Checks.Stop()  // 停健康检查
4. s.bestEffortReclaim(ctx)  // LD-driven fstrim/sync/drop_caches/compact_memory
   cleanup.Add(bestEffortUnfreeze)  // 失败时解冻

5. if filesystemSnapshot:
   s.guestPrepareFsForPause(ctx, cleanup)  // 强制 fsync
   m.Prefetch = nil  // memfile 不持久, prefetch 失效

6. m = m.MarkFilesystemOnly(filesystemSnapshot)  // 元信息标记

7. if FPH timeout > 0:
   s.process.DrainBalloon(ctx, timeout)  // 等 free-page-hinting drain

8. s.process.Pause(ctx)  // PUT /vm/pause
9. s.process.FlushMetrics(ctx)  // 非阻塞 flush

10. snapfile := template.NewLocalFileLink(cachePaths.CacheSnapfile())
11. s.process.CreateSnapshot(ctx, snapfile.Path())  // PUT /snapshot/create

12. memorySnapshot := s.processMemorySnapshot(ctx, buildID)
    - memfile diff + rootfs diff
    - 应用 MemfileDiffDedupFlag

13. return &Snapshot{Snapfile, MemfileHeader, MemfileDiff, RootfsHeader, RootfsDiff, ...}, nil
```

### 12.3 `Server.Pause` (sandboxes.go:599-697)

```go
func (s *Server) Pause(ctx, in) (*SandboxPauseResponse, error) {
    sbx, ok := s.sandboxFactory.Sandboxes.Get(in.GetSandboxId())
    // ...
    s.sandboxFactory.Sandboxes.MarkStopping(ctx, sbx.Runtime.SandboxID, sbx.LifecycleID)
    defer s.stopSandboxAsync(context.WithoutCancel(ctx), sbx)

    // 同步: 生成 snapshot + 本地缓存
    res, err := s.snapshotAndCacheSandbox(ctx, sbx, in.GetBuildId(), ...)

    // 异步: 上传到 GCS/S3
    s.uploadSnapshotAsync(ctx, sbx, res)

    // 异步: prefetch harvest (仅 memory snapshot)
    if !in.GetFilesystemOnly() {
        s.harvestResumePrefetchAsync(ctx, sbx, res, in.GetBuildId(), res.objectMetadata)
    }

    // 事件
    go s.sbxEventsService.Publish(...)
    return &SandboxPauseResponse{...}, nil
}
```

### 12.4 [prefetch_harvest.go](../../packages/orchestrator/pkg/server/prefetch_harvest.go) (374 行)

**`PauseResumePrefetchHarvestFlag`** (默认 false): Pause 后做 throwaway warm-resume 收集 page-fault trace。

**`PauseResumePrefetchConsumeFlag`** (默认 false): 是否把 trace 写入 snapshot metadata (供下次 resume 重放)。默认关闭——先观察 harvest 行为再启用 consume。

**`PauseResumePrefetchHarvestTimeoutMsFlag`** (默认 15000): warm resume slot 持有上限。

```go
const (
    minHarvestTimeoutMs = 1000
    harvestReapTimeout  = 60 * time.Second
)

func (s *Server) harvestResumePrefetchAsync(ctx, sbx, res, buildID, metadata)
//   → 启动 throwaway sandbox, envd /init, workload frozen, egress denied
//   → 收集 page-fault trace
//   → 持久化为 prefetch mapping (当 Consume flag on)
```

### 12.5 [uploads.go](../../packages/orchestrator/pkg/sandbox/uploads.go) (236 行) - 异步上传

```go
const (
    futureTTL         = 3 * time.Hour     // 必须 > uploadTotalBudget=2h
    refreshHeaderBudget = 2 * time.Hour
    uploadDoneChannelPrefix = "orchestrator.upload.done."  // + buildID
)

type Uploads struct {
    tc          templateLookup
    persistence storage.StorageProvider
    p2p         peerclient.Resolver
    redis       redis.UniversalClient
    futures *ttlcache.Cache[uuid.UUID, *utils.ErrorOnce]
}
```

**跨 orchestrator 协调**: 上传完成时 Redis pub/sub 通知 (`uploadDoneChannelPrefix + buildID`), 其他 orchestrator 在 `Wait` 内订阅 + poll remote storage。空 payload = 成功, 非空 = 上传错误。

---

## 13. 优雅关闭与 Drain

### 13.1 四阶段关闭 (run.go:922-985)

```
阶段 1: 接收信号 / 服务错误
   sig.Done() 或 serviceError → 进入 shutdown

阶段 2: 标记 Draining
   serviceInfo.SetStatus(ctx, ServiceInfoStatus_Draining)
   sleep 15s 让消费者感知 (skip if env.IsLocal())
   → Nomad service discovery 不再路由新请求

阶段 3: 等待 drain
   - tmpl.Wait(closeCtx)  // template-manager drain
   - orchestratorService.DrainSandboxes(closeCtx)  // 等所有沙箱退出
     (除非 ForceStop=true 跳过)

阶段 4: 反向关闭 closer
   slices.Reverse(closers)
   for closer in closers: closer.close(closeCtx)

阶段 5: 等 errgroup
   g.Wait()  // 等所有 goroutine
```

### 13.2 [server/main.go](../../packages/orchestrator/pkg/server/main.go) (356 行) - drain 细节

**常量** (main.go:36-61):
```go
const (
    uploadedBuildsTTL = 1 * time.Hour
    startingSandboxesLimitRefreshInterval = 30 * time.Second  // 重读 LD flag
    uploadDrainLogInterval  = 10 * time.Second
    sandboxDrainPollInterval = 5 * time.Second
)

func sandboxDrainLogInterval(elapsed time.Duration) time.Duration {
    switch {
    case elapsed < time.Minute:    return 5 * time.Second
    case elapsed < time.Hour:      return time.Minute
    default:                       return 15 * time.Minute
    }
}
```

**`Server.Close` (main.go:233)**:
1. `close(s.done)` (closeOnce)
2. 等 in-flight uploads: `s.uploadsWG.Wait()` (可被 ctx cancel 中断)
3. `drainUploads` 周期 log 进度
4. `s.uploadedBuilds.Stop()` (ttlcache)

**`DrainSandboxes` (main.go:292)**:
- 每 `sandboxDrainPollInterval=5s` 检查 `sandboxes.Count()`
- 直到 0 才进入 `waitSandboxLifecycles` 等所有 lifecycles 清理完
- ctx cancel 时返回错误

**`refreshStartingSandboxesLimit` (main.go:336)** 后台 goroutine 每 30s 重读 `MaxStartingInstancesPerNode` flag, 调整信号量上限。

### 13.3 [healthcheck/](../../packages/orchestrator/pkg/healthcheck/) - HTTP /health handler

```go
// GET /health 返回 200 当 status == Healthy
//   返回 503 当 status == Draining / Unhealthy
//   让 Nomad service discovery 自动摘除
```

### 13.4 Nomad kill_timeout

orchestrator 二进制由 Nomad `raw_exec` 启动, 无 kill_timeout 配置 (与 client-proxy 不同), 默认 Nomad SIGTERM→SIGKILL 间隔 5s。但 orch 进程在阶段 3 等待沙箱 drain 时可能很久, 由 `closeCtx` 控制; `ForceStop=true` 时立即 cancel closeCtx 跳过等待。

---

## 14. Feature Flags 全表

> 所有 flag 在 [packages/shared/pkg/featureflags/flags.go](../../packages/shared/pkg/featureflags/flags.go) 定义, LaunchDarkly 后台必须注册同名 key。

### 14.1 BoolFlag

| Flag Key | 默认 | 用途 |
|----------|------|------|
| `use-nfs-for-snapshots` | dev=true | snapshot 用 NFS |
| `use-nfs-for-templates` | dev=true | template 用 NFS |
| `write-to-cache-on-writes` | false | 写时同步写 cache |
| `use-nfs-for-building-templates` | dev=true | build template 用 NFS |
| `create-storage-cache-spans` | dev=true | 创建 storage cache span |
| `orch-accepts-combined-host` | false | orchestrator 接受 combined host (client-proxy 用) |
| `storage-soft-delete-check` | false | 读 soft-delete tombstone |
| `storage-soft-delete-enforce` | false | 强制 soft-delete fail closed |
| `use-memfd` | true | FC guest memory 用 memfd backing |
| `memfd-background-copy` | true | 后台流式 copy memfd → snapshot cache |
| `peer-to-peer-chunk-transfer` | false | P2P chunk 路由总开关 |
| `peer-to-peer-async-checkpoint` | false | Checkpoint fire-and-forget (需 P2P on) |
| `can-use-persistent-volumes` | dev=true | 启用持久卷 |
| `sandbox-label-based-scheduling` | false | 基于 label 调度 |
| `sandbox-placement-optimistic-resource-accounting` | false | 乐观资源核算 |
| `free-page-reporting` | false | virtio-balloon FPR |
| `freeze-user-cgroup` | dev=true | Pause 前冻结 user cgroup |
| `collapse-envd-heap` | false | Pause 前 collapse envd heap 到 hugepages |
| `volume-fallback-to-unmatched-nodes` | true | 卷调度回退到未标签节点 (过渡) |
| `sandbox-volume-label-based-scheduling` | false | 基于卷类型 label 调度 |
| `network-transform-rules` | dev=true | 网络规则转换 |
| `byop-proxy-enabled` | dev=true | BYOP egress proxy |
| `v4-header-for-uncompressed` | false | 强制 V4 header (uncompressed) |
| `header-v5-write` | false | Pause 写 V5 headers |
| `resume-origin-node-remap` | false | 重新指向 snapshot origin_node_id |
| `expiration-index-healer` | true | API Redis 过期索引 healer |
| `disable-e2b-access-token-provisioning` | false | 停止发放 sk_e2b_ token |
| `nbd-async-write-zeroes` | false | NBD WRITE_ZEROES 异步处理 |
| `pause-resume-prefetch-harvest` | false | Pause 后 warm-resume 收集 trace |
| `pause-resume-prefetch-consume` | false | 把 trace 写入 metadata |

### 14.2 IntFlag

| Flag Key | 默认 | 用途 |
|----------|------|------|
| `max-sandboxes-per-node` | 200 | 节点最大沙箱数 |
| `gcloud-concurrent-upload-limit` | 8 | GCS/AWS 并发上传 |
| `gcloud-max-tasks` | 16 | 最大上传任务 |
| `clickhouse-batcher-max-batch-size` | 100 | CH batch 大小 |
| `clickhouse-batcher-max-delay` | 1000 | CH batch 延迟 (ms) |
| `clickhouse-batcher-queue-size` | 1000 | CH 队列 |
| `best-of-k-sample-size` | 3 | BestOfK K |
| `best-of-k-max-overcommit` | 400 | BestOfK R (400%=4) |
| `best-of-k-alpha` | 50 | BestOfK alpha (0.5) |
| `envd-init-request-timeout-milliseconds` | 50 | envd /init 超时 |
| `envd-timeout-milliseconds` | ENVD_TIMEOUT 或 10000 | envd 等待超时 |
| `guest-sync-timeout-milliseconds` | 0 | fs-only pause guest-sync 超时 |
| `max-cache-writer-concurrency` | 10 | cache 写并发 |
| `build-cache-max-usage-percentage` | 85 | build cache 磁盘用量 |
| `build-provision-version` | 0 | build provision 版本 |
| `nbd-connections-per-device` | 1 | NBD socket 数 |
| `memory-prefetch-max-fetch-workers` | 16 | 预取 fetch worker |
| `memory-prefetch-max-copy-workers` | 8 | 预取 copy worker |
| `pause-resume-prefetch-harvest-timeout-ms` | 15000 | warm resume 持有上限 |
| `tcpfirewall-max-connections-per-sandbox` | -1 | TCP 防火墙连接数 (-1=无限) |
| `sandbox-max-incoming-connections` | -1 | 沙箱 HTTP 代理连接数 |
| `build-base-rootfs-size-limit-mb` | 25000 | base rootfs 大小上限 |
| `minimum-autoresume-timeout` | 300 | auto-resume 最小超时 (秒) |
| `build-reserved-disk-space-mb` | 256 | build root 保留磁盘 |
| `max-starting-instances-per-node` | 3 | 并发启动沙箱数 |
| `max-concurrent-evictions` | 256 | 并发驱逐数 |
| `max-concurrent-snapshot-upserts` | 0 | snapshot upsert 限流 (0=无限) |
| `max-concurrent-sandbox-list-queries` | 0 | sandbox list 限流 |
| `max-concurrent-snapshot-build-queries` | 0 | snapshot build 限流 |
| `min-chunker-read-size-kb` | 16 | chunker 最小读 |
| `max-parallel-build-read-segments` | 1 | 并行 build 读段 |
| `collapse-envd-heap-timeout-ms` | 10000 | envd heap collapse 超时 |

### 14.3 JSONFlag

| Flag Key | 默认 | 用途 |
|----------|------|------|
| `clean-nfs-cache` | null | NFS cache 清理配置 |
| `rate-limit-config` | null | 按 team/route 覆盖速率限制 |
| `memfile-diff-dedup` | 见 [§8.4](#84-pkgsandboxblock---块缓存与去重) | memfile diff 去重配置 |
| `guest-pause-reclaim` | null | `ReclaimConfig` (sync/drop_caches/compact_memory/fstrim 超时) |
| `free-page-hinting-config` | null | FPH 配置 + pause/build drain 超时 |

### 14.4 StringFlag

(orchestrator 未直接使用)

### 14.5 常量

```go
const (
    DefaultKernelVersion           = "vmlinux-6.1.158"
    DefaultFirecrackerV1_10Version = "v1.10.1_30cbb07"
    DefaultFirecrackerV1_12Version = "v1.12.1_210cbac"
    DefaultFirecrackerV1_14Version = "v1.14.1_431f1fc"
    DefaultFirecrackerVersion      = DefaultFirecrackerV1_14Version
)

FirecrackerVersionMap = {
    "v1.10": "v1.10.1_30cbb07",
    "v1.12": "v1.12.1_210cbac",
    "v1.14": "v1.14.1_431f1fc",
}
```

### 14.6 LD Context Kinds

| Kind | 属性 | 用途 |
|------|------|------|
| `sandbox` | template-id, kernel-version, firecracker-version, envd-version, sandbox-type | 沙箱级定向 |
| `team` | - | 团队级 |
| `user` | - | 用户级 |
| `cluster` | - | 集群级 |
| `deployment` | - | 部署级 |
| `tier` | - | 服务层级 |
| `service` | - | 服务名 |
| `template` | - | 模板级 |
| `volume` | - | 卷级 |
| `compress-file-type` | - | 压缩文件类型 |
| `compress-use-case` | - | 压缩用例 |

---

## 15. 代码文件索引

### 入口与启动
- [packages/orchestrator/main.go](../../packages/orchestrator/main.go) (56 行) - 进程入口
- [packages/orchestrator/pkg/factories/run.go](../../packages/orchestrator/pkg/factories/run.go) (1082 行) - 启动工厂
- [packages/orchestrator/pkg/factories/cmux.go](../../packages/orchestrator/pkg/factories/cmux.go) (39 行) - cmux 多路复用
- [packages/orchestrator/pkg/factories/http.go](../../packages/orchestrator/pkg/factories/http.go) (9 行) - HTTP server 工厂
- [packages/orchestrator/pkg/factories/featureflags_context.go](../../packages/orchestrator/pkg/factories/featureflags_context.go) (27 行) - LD context provider

### 配置
- [packages/orchestrator/pkg/cfg/model.go](../../packages/orchestrator/pkg/cfg/model.go) (206 行) - Config + BuilderConfig + Parse
- [packages/orchestrator/pkg/cfg/service.go](../../packages/orchestrator/pkg/cfg/service.go) (81 行) - ServiceType 解析

### gRPC 服务
- [packages/orchestrator/pkg/server/main.go](../../packages/orchestrator/pkg/server/main.go) (356 行) - Server 聚合 + Close + DrainSandboxes
- [packages/orchestrator/pkg/server/sandboxes.go](../../packages/orchestrator/pkg/server/sandboxes.go) (1104 行) - 7 个 SandboxService 端点
- [packages/orchestrator/pkg/server/chunks.go](../../packages/orchestrator/pkg/server/chunks.go) (186 行) - ChunkService
- [packages/orchestrator/pkg/server/template_cache.go](../../packages/orchestrator/pkg/server/template_cache.go) (30 行) - ListCachedBuilds
- [packages/orchestrator/pkg/server/prefetch_harvest.go](../../packages/orchestrator/pkg/server/prefetch_harvest.go) (374 行) - warm-resume harvest
- [packages/orchestrator/pkg/server/upload_retry.go](../../packages/orchestrator/pkg/server/upload_retry.go) (44 行) - 上传重试策略
- [packages/orchestrator/pkg/server/utils.go](../../packages/orchestrator/pkg/server/utils.go) (29 行) - 辅助

### 沙箱核心
- [packages/orchestrator/pkg/sandbox/sandbox.go](../../packages/orchestrator/pkg/sandbox/sandbox.go) (1838 行) - Sandbox + Factory (Create/Resume)
- [packages/orchestrator/pkg/sandbox/reboot.go](../../packages/orchestrator/pkg/sandbox/reboot.go) (156 行) - RebootSandbox (fs-only)
- [packages/orchestrator/pkg/sandbox/map.go](../../packages/orchestrator/pkg/sandbox/map.go) (268 行) - 3 索引沙箱路由表
- [packages/orchestrator/pkg/sandbox/snapshot.go](../../packages/orchestrator/pkg/sandbox/snapshot.go) (63 行) - Snapshot 数据
- [packages/orchestrator/pkg/sandbox/diffcreator.go](../../packages/orchestrator/pkg/sandbox/diffcreator.go) (24 行) - rootfs diff creator
- [packages/orchestrator/pkg/sandbox/cleanup.go](../../packages/orchestrator/pkg/sandbox/cleanup.go) (124 行) - 顺序清理栈
- [packages/orchestrator/pkg/sandbox/reclaim.go](../../packages/orchestrator/pkg/sandbox/reclaim.go) (395 行) - pre-pause fstrim/sync/drop_caches
- [packages/orchestrator/pkg/sandbox/envd.go](../../packages/orchestrator/pkg/sandbox/envd.go) (336 行) - envd HTTP 客户端
- [packages/orchestrator/pkg/sandbox/envd_process.go](../../packages/orchestrator/pkg/sandbox/envd_process.go) (70 行)
- [packages/orchestrator/pkg/sandbox/checks.go](../../packages/orchestrator/pkg/sandbox/checks.go) (128 行) - 健康检查
- [packages/orchestrator/pkg/sandbox/health.go](../../packages/orchestrator/pkg/sandbox/health.go) (49 行)
- [packages/orchestrator/pkg/sandbox/hoststats.go](../../packages/orchestrator/pkg/sandbox/hoststats.go) (48 行)
- [packages/orchestrator/pkg/sandbox/hoststats_collector.go](../../packages/orchestrator/pkg/sandbox/hoststats_collector.go) (178 行)
- [packages/orchestrator/pkg/sandbox/metrics.go](../../packages/orchestrator/pkg/sandbox/metrics.go) (69 行)
- [packages/orchestrator/pkg/sandbox/uploads.go](../../packages/orchestrator/pkg/sandbox/uploads.go) (236 行) - 异步上传 + Redis pub/sub
- [packages/orchestrator/pkg/sandbox/build_upload.go](../../packages/orchestrator/pkg/sandbox/build_upload.go) (245 行) - v1 上传协议
- [packages/orchestrator/pkg/sandbox/build_upload_v3.go](../../packages/orchestrator/pkg/sandbox/build_upload_v3.go) (166 行) - v3 协议
- [packages/orchestrator/pkg/sandbox/build_upload_v4.go](../../packages/orchestrator/pkg/sandbox/build_upload_v4.go) (189 行) - v4 协议 (当前)

### Firecracker
- [packages/orchestrator/pkg/sandbox/fc/client.go](../../packages/orchestrator/pkg/sandbox/fc/client.go) (544 行) - FC REST API
- [packages/orchestrator/pkg/sandbox/fc/process.go](../../packages/orchestrator/pkg/sandbox/fc/process.go) (828 行) - FC 进程管理
- [packages/orchestrator/pkg/sandbox/fc/config.go](../../packages/orchestrator/pkg/sandbox/fc/config.go) (80 行) - FC 版本路径
- [packages/orchestrator/pkg/sandbox/fc/fc_metrics.go](../../packages/orchestrator/pkg/sandbox/fc/fc_metrics.go) (434 行) - metrics FIFO 解析
- [packages/orchestrator/pkg/sandbox/fc/memory.go](../../packages/orchestrator/pkg/sandbox/fc/memory.go) (157 行) - balloon 内存
- [packages/orchestrator/pkg/sandbox/fc/mmds.go](../../packages/orchestrator/pkg/sandbox/fc/mmds.go) (12 行) - MMDS 元数据
- [packages/orchestrator/pkg/sandbox/fc/script_builder.go](../../packages/orchestrator/pkg/sandbox/fc/script_builder.go) (169 行) - 启动脚本生成
- [packages/orchestrator/pkg/sandbox/fc/kernel_args.go](../../packages/orchestrator/pkg/sandbox/fc/kernel_args.go) (25 行) - 内核命令行
- [packages/orchestrator/pkg/sandbox/fc/fph_gates.go](../../packages/orchestrator/pkg/sandbox/fc/fph_gates.go) (29 行) - FPH 限流

### 块设备与 NBD
- [packages/orchestrator/pkg/sandbox/nbd/dispatch.go](../../packages/orchestrator/pkg/sandbox/nbd/dispatch.go) (518 行) - NBD wire protocol
- [packages/orchestrator/pkg/sandbox/nbd/pool.go](../../packages/orchestrator/pkg/sandbox/nbd/pool.go) (424 行) - /dev/nbdX 池
- [packages/orchestrator/pkg/sandbox/nbd/path_direct.go](../../packages/orchestrator/pkg/sandbox/nbd/path_direct.go) (352 行) - 零拷贝直读
- [packages/orchestrator/pkg/sandbox/nbd/devicehelper.go](../../packages/orchestrator/pkg/sandbox/nbd/devicehelper.go) (70 行)
- [packages/orchestrator/pkg/sandbox/nbd/mounthelper.go](../../packages/orchestrator/pkg/sandbox/nbd/mounthelper.go) (49 行)
- [packages/orchestrator/pkg/sandbox/nbd/reclaim.go](../../packages/orchestrator/pkg/sandbox/nbd/reclaim.go) (32 行)
- [packages/orchestrator/pkg/sandbox/block/cache.go](../../packages/orchestrator/pkg/sandbox/block/cache.go) (717 行) - 块缓存
- [packages/orchestrator/pkg/sandbox/block/dedup.go](../../packages/orchestrator/pkg/sandbox/block/dedup.go) (488 行) - 去重
- [packages/orchestrator/pkg/sandbox/block/memfd.go](../../packages/orchestrator/pkg/sandbox/block/memfd.go) (427 行) - memfd backing
- [packages/orchestrator/pkg/sandbox/block/streaming_chunk.go](../../packages/orchestrator/pkg/sandbox/block/streaming_chunk.go) (400 行) - 流式 chunk
- [packages/orchestrator/pkg/sandbox/block/fetch_session.go](../../packages/orchestrator/pkg/sandbox/block/fetch_session.go) (170 行) - fetch 会话
- [packages/orchestrator/pkg/sandbox/block/prefetch_tracker.go](../../packages/orchestrator/pkg/sandbox/block/prefetch_tracker.go) (101 行)
- [packages/orchestrator/pkg/sandbox/block/overlay.go](../../packages/orchestrator/pkg/sandbox/block/overlay.go) (101 行)
- [packages/orchestrator/pkg/sandbox/block/local.go](../../packages/orchestrator/pkg/sandbox/block/local.go) (129 行)
- [packages/orchestrator/pkg/sandbox/block/iov.go](../../packages/orchestrator/pkg/sandbox/block/iov.go) (76 行)
- [packages/orchestrator/pkg/sandbox/block/empty.go](../../packages/orchestrator/pkg/sandbox/block/empty.go) (76 行)
- [packages/orchestrator/pkg/sandbox/block/range.go](../../packages/orchestrator/pkg/sandbox/block/range.go) (58 行)
- [packages/orchestrator/pkg/sandbox/block/device.go](../../packages/orchestrator/pkg/sandbox/block/device.go) (67 行)
- [packages/orchestrator/pkg/sandbox/block/tracker.go](../../packages/orchestrator/pkg/sandbox/block/tracker.go) (117 行)

### 网络
- [packages/orchestrator/pkg/sandbox/network/network.go](../../packages/orchestrator/pkg/sandbox/network/network.go) (441 行) - veth + netns
- [packages/orchestrator/pkg/sandbox/network/pool.go](../../packages/orchestrator/pkg/sandbox/network/pool.go) (415 行) - slot 池
- [packages/orchestrator/pkg/sandbox/network/slot.go](../../packages/orchestrator/pkg/sandbox/network/slot.go) (420 行) - 单 slot
- [packages/orchestrator/pkg/sandbox/network/firewall.go](../../packages/orchestrator/pkg/sandbox/network/firewall.go) (473 行) - nftables 防火墙
- [packages/orchestrator/pkg/sandbox/network/storage_local.go](../../packages/orchestrator/pkg/sandbox/network/storage_local.go) (222 行) - 本地 storage
- [packages/orchestrator/pkg/sandbox/network/storage_kv.go](../../packages/orchestrator/pkg/sandbox/network/storage_kv.go) (156 行) - Consul KV
- [packages/orchestrator/pkg/sandbox/network/storage_memory.go](../../packages/orchestrator/pkg/sandbox/network/storage_memory.go) (59 行) - 内存 (测试)
- [packages/orchestrator/pkg/sandbox/network/storage.go](../../packages/orchestrator/pkg/sandbox/network/storage.go) (12 行) - 接口
- [packages/orchestrator/pkg/sandbox/network/host.go](../../packages/orchestrator/pkg/sandbox/network/host.go) (57 行)
- [packages/orchestrator/pkg/sandbox/network/egressproxy.go](../../packages/orchestrator/pkg/sandbox/network/egressproxy.go) (43 行) - EgressProxy 接口
- [packages/orchestrator/pkg/sandbox/network/reclaim.go](../../packages/orchestrator/pkg/sandbox/network/reclaim.go) (42 行)

### 模板
- [packages/orchestrator/pkg/sandbox/template/cache.go](../../packages/orchestrator/pkg/sandbox/template/cache.go) (351 行) - 多级缓存
- [packages/orchestrator/pkg/sandbox/template/storage_template.go](../../packages/orchestrator/pkg/sandbox/template/storage_template.go) (344 行) - 存储模板
- [packages/orchestrator/pkg/sandbox/template/storage.go](../../packages/orchestrator/pkg/sandbox/template/storage.go) (161 行)
- [packages/orchestrator/pkg/sandbox/template/storage_file.go](../../packages/orchestrator/pkg/sandbox/template/storage_file.go) (54 行)
- [packages/orchestrator/pkg/sandbox/template/template.go](../../packages/orchestrator/pkg/sandbox/template/template.go) (71 行) - Template 接口
- [packages/orchestrator/pkg/sandbox/template/mask_template.go](../../packages/orchestrator/pkg/sandbox/template/mask_template.go) (80 行)
- [packages/orchestrator/pkg/sandbox/template/local_template.go](../../packages/orchestrator/pkg/sandbox/template/local_template.go) (62 行)
- [packages/orchestrator/pkg/sandbox/template/local_file.go](../../packages/orchestrator/pkg/sandbox/template/local_file.go) (27 行)
- [packages/orchestrator/pkg/sandbox/template/header_metrics.go](../../packages/orchestrator/pkg/sandbox/template/header_metrics.go) (97 行)
- [packages/orchestrator/pkg/sandbox/template/file.go](../../packages/orchestrator/pkg/sandbox/template/file.go) (8 行)
- [packages/orchestrator/pkg/sandbox/template/peerclient/registry.go](../../packages/orchestrator/pkg/sandbox/template/peerclient/registry.go) (65 行) - Redis 注册
- [packages/orchestrator/pkg/sandbox/template/peerclient/resolver.go](../../packages/orchestrator/pkg/sandbox/template/peerclient/resolver.go) (192 行) - peer 解析
- [packages/orchestrator/pkg/sandbox/template/peerclient/storage.go](../../packages/orchestrator/pkg/sandbox/template/peerclient/storage.go) (317 行)
- [packages/orchestrator/pkg/sandbox/template/peerclient/blob.go](../../packages/orchestrator/pkg/sandbox/template/peerclient/blob.go) (189 行)
- [packages/orchestrator/pkg/sandbox/template/peerclient/seekable.go](../../packages/orchestrator/pkg/sandbox/template/peerclient/seekable.go) (205 行)
- [packages/orchestrator/pkg/sandbox/template/peerserver/peerserver.go](../../packages/orchestrator/pkg/sandbox/template/peerserver/peerserver.go) (46 行)
- [packages/orchestrator/pkg/sandbox/template/peerserver/file.go](../../packages/orchestrator/pkg/sandbox/template/peerserver/file.go) (111 行)
- [packages/orchestrator/pkg/sandbox/template/peerserver/seekable.go](../../packages/orchestrator/pkg/sandbox/template/peerserver/seekable.go) (60 行)
- [packages/orchestrator/pkg/sandbox/template/peerserver/header.go](../../packages/orchestrator/pkg/sandbox/template/peerserver/header.go) (55 行)
- [packages/orchestrator/pkg/sandbox/template/peerserver/resolve.go](../../packages/orchestrator/pkg/sandbox/template/peerserver/resolve.go) (64 行)
- [packages/orchestrator/pkg/sandbox/template/peerserver/metadata.go](../../packages/orchestrator/pkg/sandbox/template/peerserver/metadata.go) (43 行)

### UFFD
- [packages/orchestrator/pkg/sandbox/uffd/uffd.go](../../packages/orchestrator/pkg/sandbox/uffd/uffd.go) (303 行)
- [packages/orchestrator/pkg/sandbox/uffd/noop.go](../../packages/orchestrator/pkg/sandbox/uffd/noop.go) (96 行)
- [packages/orchestrator/pkg/sandbox/uffd/memory_backend.go](../../packages/orchestrator/pkg/sandbox/uffd/memory_backend.go) (30 行)

### cgroup
- [packages/orchestrator/pkg/sandbox/cgroup/manager.go](../../packages/orchestrator/pkg/sandbox/cgroup/manager.go) (569 行)
- [packages/orchestrator/pkg/sandbox/cgroup/noop.go](../../packages/orchestrator/pkg/sandbox/cgroup/noop.go) (36 行)
- [packages/orchestrator/pkg/sandbox/cgroup/reclaim.go](../../packages/orchestrator/pkg/sandbox/cgroup/reclaim.go) (35 行)

### 服务/辅助
- [packages/orchestrator/pkg/service/service_info.go](../../packages/orchestrator/pkg/service/service_info.go) (146 行) - ServiceInfo + 状态机
- [packages/orchestrator/pkg/service/info.go](../../packages/orchestrator/pkg/service/info.go) (89 行) - InfoService gRPC
- [packages/orchestrator/pkg/service/machineinfo/](../../packages/orchestrator/pkg/service/machineinfo/) - CPU 平台检测
- [packages/orchestrator/pkg/startupreclaim/](../../packages/orchestrator/pkg/startupreclaim/) - 启动时清理
- [packages/orchestrator/pkg/scheduling/](../../packages/orchestrator/pkg/scheduling/) - 调度元数据
- [packages/orchestrator/pkg/proxy/](../../packages/orchestrator/pkg/proxy/) - 入站代理
- [packages/orchestrator/pkg/tcpfirewall/](../../packages/orchestrator/pkg/tcpfirewall/) - 出站防火墙
- [packages/orchestrator/pkg/portmap/](../../packages/orchestrator/pkg/portmap/) - RPC 端口映射
- [packages/orchestrator/pkg/hyperloopserver/](../../packages/orchestrator/pkg/hyperloopserver/) - 内部传输
- [packages/orchestrator/pkg/nfsproxy/](../../packages/orchestrator/pkg/nfsproxy/) - NFS 代理
- [packages/orchestrator/pkg/volumes/](../../packages/orchestrator/pkg/volumes/) - 卷服务
- [packages/orchestrator/pkg/chrooted/](../../packages/orchestrator/pkg/chrooted/) - chroot 沙箱
- [packages/orchestrator/pkg/events/](../../packages/orchestrator/pkg/events/) - 事件流抽象
- [packages/orchestrator/pkg/healthcheck/](../../packages/orchestrator/pkg/healthcheck/) - HTTP health handler
- [packages/orchestrator/pkg/localupload/](../../packages/orchestrator/pkg/localupload/) - 本地上传
- [packages/orchestrator/pkg/metrics/](../../packages/orchestrator/pkg/metrics/) - host/sandbox 指标
- [packages/orchestrator/pkg/template/server/](../../packages/orchestrator/pkg/template/server/) - template-manager gRPC
- [packages/orchestrator/pkg/template/build/](../../packages/orchestrator/pkg/template/build/) - 构建流水线 (8263 行)

### IaC
- [iac/modules/job-orchestrator/main.tf](../../iac/modules/job-orchestrator/main.tf) (55 行) - Terraform 模块
- [iac/modules/job-orchestrator/variables.tf](../../iac/modules/job-orchestrator/variables.tf) (31 行) - 变量
- [iac/modules/job-orchestrator/jobs/orchestrator.hcl](../../iac/modules/job-orchestrator/jobs/orchestrator.hcl) (94 行) - Nomad job

---

## 16. 设计要点与历史

### 16.1 单进程单锁 (run.go:175-261)

`flock` 防止同主机跑两个 sandbox-runtime orchestrator。lock 文件存 PID, 冲突时报"another instance is running with pid X"。`kernel` 在进程崩溃时自动释放 flock, 所以这是个**安全网**而非强约束。开发模式跳过。

### 16.2 cmux 多路复用 (run.go:845-863)

一个 TCP 端口 (5008) 同时承载 gRPC + HTTP/1:
- HTTP: `/health` (健康), `/upload` (本地上传)
- gRPC: SandboxService / VolumeService / ChunkService / TemplateService / InfoService

避免监听多端口, 简化防火墙规则。**必须在 Serve() 之前完成所有 Match()**, 否则数据竞争。

### 16.3 沙箱路由表三索引 (map.go)

`live` / `lifecycles` / `network` 三个 smap 独立管理:
- **live**: sandboxID → Sandbox (MarkRunning → MarkStopping)
- **lifecycles**: sandboxID/lifecycleID → Sandbox (MarkRunning → MarkStopped, 含清理中)
- **network**: IP → Sandbox (AssignNetwork → NetworkReleased)

**为何分离**: checkpoint/resume 时旧 lifecycle 还在清理, 新 lifecycle 已 live (同 sandboxID)。一个 sandboxID 可能对应多个 lifecycle 条目。

### 16.4 LifecycleID vs ExecutionID vs SandboxID

| ID | 范围 | 何时变 |
|----|------|--------|
| `SandboxID` | 用户可见 | 永不变 (除非新沙箱) |
| `ExecutionID` | 用户可见 | checkpoint/resume 时保持 |
| `LifecycleID` | 内部 | 每次 FC 进程重启都变 (UUID) |

`LifecycleID` 用于 map evict guard + proxy 连接池, 防止旧 lifecycle 干扰新 lifecycle。

### 16.5 多级缓存

```
                ┌────────────┐
                │  ttlcache  │  ← 内存最快, 25h TTL
                │  (per-pod) │
                └─────┬──────┘
                      │ miss
                ┌─────▼──────┐
                │ 本地磁盘   │  ← SandboxCacheDir / SnapshotCacheDir
                │ memfile/   │    / TemplateCacheDir
                │ rootfs     │
                └─────┬──────┘
                      │ miss
                ┌─────▼──────┐
                │ P2P peer   │  ← Redis 注册, HTTP 二进制直拉
                │ (同集群)   │
                └─────┬──────┘
                      │ miss
                ┌─────▼──────┐
                │ NFS 共享   │  ← GCP Filestore
                └─────┬──────┘
                      │ miss
                ┌─────▼──────┐
                │ GCS / S3   │  ← 远端冷备, 异步上传
                └────────────┘
```

95%+ 的沙箱创建在前两级完成。

### 16.6 UFFD + Memfd 加速

**`UseMemFdFlag`** (默认 true): FC 用 memfd backing guest memory, 通过 UFFD socket 传 fd, orchestrator 直接 mmap。比旧版 `process_vm_readv` 快很多。

**`MemfdBackgroundCopyFlag`** (默认 true): 后台 goroutine 流式 copy memfd → snapshot cache, 让 Pause 在 diff metadata 写完后立即返回, 不等完整 copy。

### 16.7 模板 Memfile Diff Dedup

`MemfileDiffDedupFlag` (JSON) 对 memfile diff 做 4 KiB 页去重 against base memfile。`bestEffort` 跳过未缓存块, `directIO` 用 O_DIRECT 打开 dedup 输出。剩余 keys 控制 fetch 预算防止 defrag 过度。

### 16.8 Pause-Resume Prefetch Harvest

新机制 (默认关): Pause 后做 throwaway warm-resume:
1. 用本地缓存 snapshot 启一个临时沙箱 (egress denied, workload frozen)
2. envd `/init` 触发 page fault
3. 记录 fault trace
4. 转换为 prefetch mapping
5. 写入 snapshot metadata (当 `PauseResumePrefetchConsumeFlag` on)
6. 下次 customer resume 时按 mapping 预取

**`PauseResumePrefetchHarvestTimeoutMsFlag`** (默认 15s) 限制 slot 持有时间。

### 16.9 Network Slot 三 IP 分配

每 slot 占用:
- 1 个 Host IP (host /16 网段, /32 mask)
- 2 个 Vrt IP (vpeer+veth, /31 网段)

默认 `10.11.0.0/16` (host) + `10.12.0.0/16` (vrt) 支持 ~65k slot, 远超单节点上限。

### 16.10 Starting Sandboxes 信号量

`MaxStartingInstancesPerNode` (默认 3, IntFlag) 限制并发启动。`Server.refreshStartingSandboxesLimit` 每 30s 重读 LD flag, 用 `utils.AdjustableSemaphore.SetLimit` 动态调整。

Snapshot resume 用阻塞 `waitForAcquire` (15s timeout), cold create 用非阻塞 `TryAcquire`。

### 16.11 多 ClickHouse 端点

`CLICKHOUSE_CONNECTION_STRINGS` (分号分隔) 支持多 CH 端点, 主端点 fatal, 附加端点 best-effort。每端点独立 driver + delivery + batcher, 一个慢端点不阻塞其他。

### 16.12 Linux-Only

`//go:build linux` 锁定平台。强依赖:
- KVM (`/dev/kvm`)
- NBD module (`/dev/nbdX`)
- TUN (`/dev/net/tun`)
- cgroup v2 mount (`/sys/fs/cgroup`)
- iptables / nftables
- veth / netns
- userfaultfd
- unshare / nsenter

不能在 macOS 上跑。本地开发用 Linux VM 或 `cmd/dummy-orchestrator` (集成测试 mock)。

---

## 17. FAQ

**Q1: Orchestrator 必须 root 吗?**
是的。Firecracker 需要 `/dev/kvm`, nbd / netns / iptables / cgroup 都需要 `CAP_SYS_ADMIN`。Nomad job 用 `driver = "raw_exec"` 直接以 host root 跑。

**Q2: 一个节点能跑多少沙箱?**
默认 `max-sandboxes-per-node = 200` (IntFlag, LD 可调)。受 RAM / CPU / NBD 设备数 (`NBDPoolSize=64`) 综合限制。

**Q3: 一个沙箱占用多少 IP?**
3 个: 1 host IP + 2 vrt IP (vpeer+veth)。默认 /16 网段支持 ~65k slot。

**Q4: 沙箱日志怎么走?**
两条独立链路:
- `sbxLoggerExternal`: 用户可见 (经过 `LogsCollectorAddress`)
- `sbxLoggerInternal`: 内部可见 (OTEL LogsProvider)

envd 通过 MMDS 拿到 `LogsCollectorAddress = http://192.0.2.1/logs` (orchestrator in-sandbox IP) 后, 把日志 POST 到 orchestrator, orchestrator 转发到 collector。

**Q5: 沙箱怎么找到模板数据?**
五级回退: 内存 ttlcache → 本地磁盘 → P2P peer (Redis 注册) → NFS → GCS/S3。本地 miss 时优先 P2P, 同集群其他节点有就拉过来。

**Q6: Pause 和 Checkpoint 区别?**
- **Pause**: 暂停 + 写 snapshot, **不删 VM** (Pause 后还可能 resume)。
- **Checkpoint**: 暂停 + 写 build, **写完不删 VM** 但通常配合 Delete 用, 用于把当前状态固化为新 build。

实现上 `Pause` 走 `snapshotAndCacheSandbox` + `uploadSnapshotAsync`, `Checkpoint` 多了 build_id 注册到 template manager 的步骤。

**Q7: filesystem-only snapshot 怎么恢复?**
通过 `RebootSandbox` 冷启动 (reboot.go:39):
- 检查 `meta.IsFilesystemOnly()` (安全门, memory snapshot 不能 reboot - rootfs 可能缺 page cache 中的写)
- 不恢复 RAM, 只挂 rootfs
- 冷启动 systemd + envd (60s 超时, 比 memory resume 长)

**Q8: 单实例锁失败怎么办?**
`acquireOrchestratorLock` 失败时 fatal exit, 报告 PID。flock 在崩溃时由内核自动释放, 所以"locked"状态意味着真有活进程。开发模式 (`env.IsDevelopment()`) 跳过。

**Q9: 节点 drain 时已有沙箱怎么办?**
`DrainSandboxes(closeCtx)` 每 5s 检查 `sandboxes.Count()`, 等到 0 才继续。日志频率随时间衰减 (5s → 1min → 15min)。`ForceStop=true` 时跳过等待立即关闭。

**Q10: Network slot 复用机制?**
沙箱 Delete 时, veth/netns 不立即销毁, 而是放回 `reusedSlots` channel (容量 100)。下次 `Pool.Get` 优先取回 reused, 避免 iptables 反复配置。`ReturnDelay=3s` 让 inflight 请求 drain。

**Q11: 跨 orchestrator 上传协调怎么做?**
`Uploads` 使用 Redis pub/sub channel `orchestrator.upload.done.<buildID>`:
- 上传完成 publish 空消息 (成功) 或错误消息
- 其他 orchestrator 在 `Wait(buildID)` 内订阅 + poll remote storage
- `refreshHeaderBudget=2h` 必须覆盖父上传重试窗口

**Q12: 启动多久能 ready 一个沙箱?**
- Cold boot (CreateSandbox, 仅 build 用): 数十秒 (含 systemd 启动)
- Memory resume (生产主路径): <1s (UFFD 延迟分页)
- Reboot (fs-only): 60s (cold boot from snapshot rootfs)

`envd-timeout-milliseconds` (默认 10000) 控制 memory resume 的 envd 等待。

---

## 18. 附录

### 18.1 关键 proto 契约 (摘自 orchestrator.proto)

```protobuf
service SandboxService {
  rpc Create(SandboxCreateRequest)  returns (SandboxCreateResponse);
  rpc Update(SandboxUpdateRequest)  returns (google.protobuf.Empty);
  rpc List(google.protobuf.Empty)   returns (SandboxListResponse);
  rpc Delete(SandboxDeleteRequest)  returns (google.protobuf.Empty);
  rpc Pause(SandboxPauseRequest)    returns (SandboxPauseResponse);
  rpc Checkpoint(SandboxCheckpointRequest) returns (SandboxCheckpointResponse);
  rpc ListCachedBuilds(google.protobuf.Empty) returns (SandboxListCachedBuildsResponse);
}

service ChunkService {
  rpc GetBuildFileSize(GetBuildFileSizeRequest) returns (GetBuildFileSizeResponse);
  rpc GetBuildFileExists(GetBuildFileExistsRequest) returns (GetBuildFileExistsResponse);
  rpc ReadAtBuildSeekable(ReadAtBuildSeekableRequest) returns (stream ReadAtBuildSeekableResponse);
  rpc GetBuildBlob(GetBuildBlobRequest) returns (stream GetBuildBlobResponse);
}

service VolumeService { /* create/delete/file/path/dir */ }
service TemplateService { /* template-manager 模式 */ }
service InfoService { /* 节点信息 */ }
```

### 18.2 关键 metrics

**Server** (`orchestrator.server.*`):
- `orchestrator.sandbox.create.duration` (histogram, ms, attr: `sandbox.resume`)
- `orchestrator.sandbox.killed` (counter, attr: `kill_reason`)
- `orchestrator.snapshot.upload.failed` (counter)
- `orchestrator.sandbox.count` (up-down counter)
- `orchestrator.status` (gauge, attr: status/version/commit)
- `orchestrator.cpu.allocated` / `orchestrator.memory.allocated` / `orchestrator.disk.allocated` (gauge)

**Sandbox** (`orchestrator.sandbox.*`):
- `envd.init.calls` (counter)
- `wait.for.envd.duration` / `envd.collapse.duration` / `guest.sync.duration` (histogram)
- `envd.collapse.chunks` (counter)
- `uffd.startup.pages` / `uffd.startup.source.pages` / `uffd.startup.bytes` (histogram)

**Network** (`orchestrator.network.*`):
- `slots_pool.new` / `slots_pool.reused` (up-down counter)
- `slots_pool.acquired` / `slots_pool.returned` / `slots_pool.released` (counter)

**Template** (`orchestrator.templates.*`):
- `cache.hits` / `cache.misses` (counter)

### 18.3 关键环境变量速查

| 变量 | 默认 | 用途 |
|------|------|------|
| `ORCHESTRATOR_SERVICES` | `orchestrator` | 逗号分隔, 加 `template-manager` |
| `NODE_IP` | `localhost` | P2P 注册 (localhost 禁用 P2P) |
| `NODE_LABELS` | `""` | 逗号分隔调度标签 |
| `GRPC_PORT` | `5008` | gRPC + HTTP (cmux) |
| `PROXY_PORT` | `5007` | 入站 HTTP 代理 |
| `NBD_POOL_SIZE` | `64` | /dev/nbdX 池 |
| `CLICKHOUSE_CONNECTION_STRING` | `""` | 主 CH 端点 |
| `CLICKHOUSE_CONNECTION_STRINGS` | `""` | 分号分隔多端点 |
| `REDIS_URL` / `REDIS_CLUSTER_URL` | `""` | Redis 连接 |
| `ORCHESTRATOR_LOCK_PATH` | `/orchestrator.lock` | 单实例 flock |
| `FORCE_STOP` | `false` | 跳过 drain |
| `DISABLE_STARTUP_RECLAIM` | `false` | 跳过启动清理 |
| `USE_LOCAL_NAMESPACE_STORAGE` | `false` | 用本地 storage 替代 Consul KV |
| `LAUNCH_DARKLY_API_KEY` | `""` | LD key (空 = 离线 fallback) |
| `PROVIDER` | `gcp` | `gcp` 或 `aws` |
| `PERSISTENT_VOLUME_MOUNTS` | `map{}` | name → path (启用 NFS proxy) |
| `ENVD_TIMEOUT` | `10s` | envd 等待超时 (Go duration)

### 18.4 健康检查端点

- `GET /health` (HTTP, cmux 端口 5008) → 200/503 based on ServiceInfoStatus
- gRPC `grpc.health.v1.Health/Check` → 标准 gRPC health 协议
- Nomad service check: HTTP `/health`, 20s 间隔, 5s 超时

### 18.5 与其他模块的契约

| 上游 | 接口 | 用途 |
|------|------|------|
| [API](api-module.md) | gRPC SandboxService | 7 个生命周期 RPC |
| [API](api-module.md) | gRPC VolumeService | 卷管理 |
| [API](api-module.md) | gRPC ChunkService | 块级数据 |
| [API](api-module.md) | gRPC TemplateService | 模板构建 (template-manager 模式) |
| [Client Proxy](client-proxy-module.md) | HTTP 5007 | 入站流量转发 |

| 下游 | 接口 | 用途 |
|------|------|------|
| [Envd](../envd-module.md) | Connect RPC (in-VM) | 进程/文件 API |
| Firecracker | Unix Socket REST | VM 控制 |
| GCS/S3 | HTTPS | 模板存储 |
| Redis | RESP | P2P 注册 + 事件流 |
| ClickHouse | HTTP | 指标/事件持久化 |
| LaunchDarkly | HTTPS | Feature Flags |
| Consul | HTTP | 网络 slot KV (多节点协调) |
| PostgreSQL | - | **不直连** (由 API 层负责) |

### 18.6 进一步阅读

- [旧版文档](../orchestrator-module.md) - 828 行的精简版, 仍可作为快速参考
- _sandbox-lifecycle.md_ - 沙箱生命周期专题(待写)
- _sandbox-management.md_ - 沙箱管理(待写)
- _snapshots.md_ - Snapshot 机制(待写)
- _template-module.md_ - 模板系统(待写)
- _volumes.md_ - 持久卷(待写)
- _node-module.md_ - 节点管理(待写)
- [envd-module.md](../envd-module.md) - VM 内守护进程
- [CLAUDE.md](../../CLAUDE.md) - "Firecracker & VM Management" 章节
