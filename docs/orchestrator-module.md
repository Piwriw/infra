# `packages/orchestrator/` 模块原理详解

> 本文档基于 `packages/orchestrator/` 的源码与 `.understand-anything/knowledge-graph.json` 知识图谱整理, 描述 E2B 平台中 **核心编排层** (layer:core-orchestrator) 的工作原理、模块结构、运行时数据流和关键设计取舍。

---

## 0. 一句话定位

**Orchestrator = Firecracker microVM 编排器**, 通过 **gRPC** 接受 API 层的沙箱请求, 负责在 **Linux 宿主机** 上完成 **VM 生命周期 (创建/启动/暂停/恢复/销毁)、网络命名空间、NBD 块设备、模板缓存、出入站流量控制、模板构建** 的全链路管理。它是 E2B 平台中 **VM 资源** 与 **API 调用** 之间的唯一桥梁。

> 知识图谱出处: `document:README.md` + `tour:step5` "Orchestrator 入口:VM 编排进程启动"

---

## 1. 模块在整体架构中的位置

```
                   ┌──────────────────────────────────┐
   user/SDK ──────▶│   API (Gin REST, packages/api/) │
                   └────────────┬─────────────────────┘
                                │ gRPC: SandboxService
                                ▼
   ┌────────────────────────────────────────────────────────────┐
   │   Orchestrator (packages/orchestrator/)  ◀── 本文档主题     │
   │                                                            │
   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
   │  │ gRPC server  │  │ sandbox.Map  │  │ Template Cache   │  │
   │  │ (Sandbox /   │  │ 沙箱路由表   │  │ + P2P peerclient │  │
   │  │  Volume /    │  │              │  │                  │  │
   │  │  Chunk /     │  │              │  │                  │  │
   │  │  Template)   │  │              │  │                  │  │
   │  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
   │         │                 │                   │            │
   │  ┌──────▼─────────────────▼───────────────────▼──────────┐ │
   │  │       Sandbox (sandbox.go) — VM 生命周期状态机         │ │
   │  └──────┬───────────┬─────────────┬──────────┬────────────┘ │
   │         │           │             │          │              │
   │   ┌─────▼─────┐ ┌───▼────┐  ┌─────▼─────┐ ┌──▼───────────┐  │
   │   │ fc/       │ │ nbd/   │  │ network/  │ │ template/    │  │
   │   │ Firecracker│ │ 块设备  │  │ veth+netns│ │ 模板+cache   │  │
   │   │ 客户端     │ │ 协议    │  │ + 防火墙   │ │ + P2P        │  │
   │   └───────────┘ └────────┘  └───────────┘ └──────────────┘  │
   └────────────────────────────────────────────────────────────┘
                                │ gRPC: ProcessService / FilesystemService
                                ▼
                          ┌──────────────┐
                          │ Envd (VM 内) │
                          └──────────────┘
```

来源: `tour:step5~8` + `layer:core-orchestrator` (429 节点)

---

## 2. 目录结构与职责

> 注意: 仓库根 `CLAUDE.md` 中描述的 `internal/sandbox/` 路径**已过时**。当前真实结构是 `pkg/`, 下面是按**职责**重新梳理的目录树。

```
packages/orchestrator/
├── main.go                 # 进程入口: 解析 flag + 调用 factories.Run
├── Makefile                # build/build-debug/build-template/run-* 目标
├── Dockerfile              # 多阶段 builder + scratch/alpine 镜像
│
├── cmd/                    # 一次性运维 CLI (非生产入口)
│   ├── clean-nfs-cache/    # NFS 缓存清理 (cleaner/scan/delete)
│   ├── copy-build/         # 拷贝 build 制品
│   ├── create-build/       # 手动触发 build
│   ├── dummy-orchestrator/ # 本地 mock orchestrator (集成测试)
│   ├── hammer-file/        # I/O 压测工具
│   ├── inspect-build/      # 检查 build 制品
│   ├── mount-build-rootfs/ # 挂载 build 的 rootfs
│   ├── resume-build/       # 恢复 build (含 fph benchmark)
│   ├── show-build-diff/    # 显示 build diff
│   ├── simulate-gcs-traffic/  # GCS 流量模拟
│   ├── simulate-nfs-traffic/  # NFS 流量模拟
│   └── smoketest/          # 端到端冒烟测试
│
└── pkg/                    # 业务实现 (≈ 100+ 文件)
    ├── factories/          # 启动工厂
    │   ├── run.go          # Run(opts) — 装载所有子系统, 阻塞至 shutdown
    │   ├── cmux.go         # cmux 多路复用器 (gRPC + HTTP 同一端口)
    │   └── http.go         # 通用 HTTP server 工厂
    │
    ├── server/             # gRPC server 实现
    │   ├── main.go         # Server 聚合 (New/Close/refreshStartingSandboxesLimit)
    │   ├── sandboxes.go    # Create/Update/List/Delete/Pause/Checkpoint 全套
    │   ├── template_cache.go # ListCachedBuilds 端点
    │   ├── chunks.go       # 块级数据接口
    │   └── utils.go
    │
    ├── sandbox/            # ⭐ 沙箱核心 (fan-out 136, 几乎被所有编排模块引用)
    │   ├── sandbox.go      # Sandbox 状态机 + Factory
    │   ├── snapshot.go     # Pause 时的 snapshot 生成
    │   ├── diffcreator.go  # memfile / rootfs diff 构造
    │   ├── cleanup.go      # 资源回收
    │   ├── reclaim.go      # 自动驱逐策略
    │   ├── envd.go         # envd 启动/连接
    │   ├── envd_process.go # envd 子进程封装
    │   ├── uploads.go      # 异步上传 build/snapshot
    │   ├── build_upload*.go # 4 代 build 上传协议
    │   ├── checks.go       # 健康检查
    │   ├── health.go       # 探活
    │   ├── hoststats.go    # 主机采样
    │   ├── map.go          # 线程安全的 sandbox 路由表
    │   ├── metrics.go      # 沙箱级 Prometheus 指标
    │   ├── cgroup/         # cgroup v2 资源管控
    │   ├── block/          # 块缓存 + metrics
    │   │
    │   ├── fc/             # Firecracker 集成
    │   │   ├── client.go       # 与 FC Unix socket 的全部 RPC
    │   │   ├── process.go      # FC 子进程 + unshare/nsenter
    │   │   ├── config.go       # VM 配置 + 内核/FC 二进制路径
    │   │   ├── kernel_args.go  # 内核命令行拼装
    │   │   ├── memory.go       # balloon 内存弹性
    │   │   ├── mmds.go         # MMDS 元数据注入
    │   │   ├── script_builder.go  # 环境初始化脚本生成
    │   │   └── fph_gates.go    # first-page-hit 限流门
    │   │
    │   ├── nbd/            # Network Block Device 协议
    │   │   ├── dispatch.go    # NBD wire-format dispatcher
    │   │   ├── devicehelper.go# /dev/nbdX 设备管理
    │   │   ├── mounthelper.go # 挂载辅助
    │   │   ├── path_direct.go # 零拷贝直读路径
    │   │   ├── pool.go        # 块设备池化
    │   │   └── testutils/
    │   │
    │   ├── network/        # 沙箱网络
    │   │   ├── network.go     # CreateNetwork/RemoveNetwork (veth+netns)
    │   │   ├── pool.go        # veth slot 池 (新+复用)
    │   │   ├── slot.go        # 单个 veth slot
    │   │   ├── storage.go     # Storage 抽象
    │   │   ├── storage_*.go   # local/memory/kv 三种 storage
    │   │   ├── firewall.go    # 网络防火墙
    │   │   ├── egressproxy.go # 出站代理
    │   │   └── host.go        # 宿主侧 host 网络
    │   │
    │   ├── template/       # 沙箱模板 (与 cfg 模板不同, 这里指 VM 内存/块资源)
    │   │   ├── template.go    # Template 接口
    │   │   ├── cache.go       # TTL 缓存 + P2P 拉取
    │   │   ├── file.go        # 文件抽象
    │   │   ├── local_file.go  # 本地文件实现
    │   │   ├── local_template.go
    │   │   ├── mask_template.go
    │   │   ├── storage*.go
    │   │   ├── peerclient/    # P2P 客户端 (blob/seekable/storage/registry/resolver)
    │   │   └── peerserver/
    │   │
    │   └── uffd/           # userfaultfd 处理 (延迟分页)
    │
    ├── cfg/                # 配置模型
    │   ├── model.go        # Config/BuilderConfig 数据结构 + Parse
    │   ├── model_test.go
    │   └── service.go      # 服务名解析 (orchestrator / template-manager / build)
    │
    ├── template/           # 模板服务 (template-manager 模式)
    │   ├── constants/      # service name 常量
    │   ├── server/         # TemplateManager gRPC 实现
    │   │   ├── main.go
    │   │   ├── create_template.go
    │   │   ├── delete_template.go
    │   │   ├── upload_layer_files_template.go
    │   │   └── template_status.go
    │   └── cache/
    │       └── build_cache.go   # buildID → 状态/日志/结果 内存缓存
    │
    ├── volumes/            # 卷挂载服务 (gRPC VolumeService 实现)
    │   ├── service.go
    │   ├── volume_*.go     # create/delete
    │   ├── file_*.go       # create/get
    │   ├── path_*.go       # stat/update/delete
    │   └── dir_*.go
    │
    ├── chrooted/           # chroot 沙箱 (用于本地 build 等场景)
    │   ├── builder.go
    │   ├── chroot.go
    │   ├── mountns.go
    │   └── fs.go / change.go
    │
    ├── tcpfirewall/        # TCP 防火墙 (入站流量控制)
    │   ├── listener.go
    │   ├── proxy.go
    │   └── handlers.go
    │
    ├── proxy/              # 沙箱代理 (用户→VM 的流量入口)
    │   ├── proxy.go
    │   └── metrics.go
    │
    ├── portmap/            # 端口映射
    │
    ├── hyperloopserver/    # Hyperloop (内部传输) 服务
    │
    ├── nfsproxy/           # NFS 代理 (持久卷挂载)
    │   ├── proxy.go
    │   ├── chroot/         # chroot 包装
    │   ├── logged/         # 日志包装
    │   ├── metrics/        # 指标包装
    │   ├── tracing/        # trace 包装
    │   ├── recovery/       # 错误恢复
    │   ├── mocks/
    │   └── cfg/
    │
    ├── events/             # 沙箱事件流抽象
    ├── healthcheck/        # 健康检查
    ├── localupload/        # 本地上传 handler (template-manager 用)
    ├── metrics/            # host / sandbox 指标
    ├── dummyserver/        # 集成测试用 mock
    ├── service/            # ServiceInfo + machineinfo
    └── version/            # 版本号
```

---

## 3. 启动流程 (`main.go` → `factories.Run` → `run`)

### 3.1 入口 (`main.go`)

```go
//go:build linux
func main() {
    applyTestFlagOverrides()                 // 测试环境变量 → LaunchDarkly flag 覆盖
    factories.Run(factories.Options{
        Version:       version.Version,
        CommitSHA:     commitSHA,
        EgressFactory: defaultEgressFactory,  // 默认用 tcpfirewall
    })
}
```

`main.go` 故意**只做 3 件事**:
1. 通过环境变量压测标志覆盖 (TESTS_MEMFILE_DIFF_DEDUP_MODE, TESTS_USE_MEMFD)
2. 注入 `EgressFactory` (出站代理实现, 默认是 `tcpfirewall`)
3. 委托给 `factories.Run`

**这种 "main 只是壳" 的设计便于测试和不同发行版定制**(例如 `dummy-orchestrator` 用不同的 `EgressFactory`)。

### 3.2 启动工厂 (`factories/run.go`)

`Run()` 是整个进程**最复杂的函数**, 1000+ 行, 它按严格顺序装配 30+ 子系统。

#### 启动顺序 (按依赖拓扑)

```
阶段 1: 基础
   cfg.Parse()                            # 解析环境变量
   ensureDirs()                           # mkdir 缓存目录
   fileLock 检查                          # 防止重复启动
   ctx + signal                           # SIGINT/SIGTERM/SIGUSR1 优雅退出
   machineinfo.Detect()                   # 检测 CPU 架构 (placement 用)
   service.NewInfoContainer()             # 进程级元信息

阶段 2: 基础设施
   telemetry.New()                        # OTEL client (traces/metrics/logs 三件套)
   logger.NewLogger() + ReplaceGlobals    # Zap + OTEL core
   sbxlogger (沙箱专用 logger, internal + external 双链路)

阶段 3: 数据后端
   featureflags.NewClient()               # LaunchDarkly
   limit.New()                            # GCP 并发上传限流
   storage.GetStorageProvider()           # GCS/S3 模板存储
   sharedFactories.NewRedisClient()       # Redis (P2P 注册 + 事件流)
   blockmetrics.NewMetrics()              # 块缓存指标

阶段 4: 模板子系统
   peerclient.NewRedisRegistry/Resolver   # 节点 P2P 发现
   template.NewCache().Start()            # 模板缓存 + TTL 续期 + P2P 拉取
   clickhouse (可选): sandbox events + hoststats delivery
   cgroupManager.Initialize()             # 初始化根 cgroup
   Redis streams: sandbox events 第二条投递链
   metrics.NewSandboxObserver()           # 沙箱观察器 (OTEL gauge)
   hostMetrics.Start()                    # 后台 CPU 采样

阶段 5: 网络与代理
   proxy.NewSandboxProxy()                # 用户→沙箱的 HTTP 代理
   opts.EgressFactory(ctx, deps)          # 出站代理 (默认 tcpfirewall)
   nbd.NewDevicePool().Populate()         # 预热 /dev/nbdX 设备池
   network.NewPool().Populate()           # 预热 veth slot 池

阶段 6: 业务服务
   sandbox.NewFactory()                   # 沙箱构造工厂
   chrooted.NewBuilder()                  # chroot 构造器
   volumes.New()                          # 卷服务
   sandbox.NewUploads()                   # 异步上传管理
   server.New()                           # 聚合 gRPC server

阶段 7: 条件启动
   nfsproxy (仅当配置了 PersistentVolumeMounts)
   hyperloopserver                        # 内部传输
   template-manager (如果 services 包含)
   info service (InfoService)
   grpcHealth                             # 标准健康检查

阶段 8: 网络层
   cmuxServer := NewCMUXServer()          # cmux 复用器
   httpListener = cmux.Match(HTTP1Fast()) # 匹配 HTTP/1
   grpcListener = cmux.Match(Any())       # 匹配 gRPC
   阻塞服务, 等待 ctx cancel
```

#### 关键设计: 依赖注入的 `Deps`

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

`EgressFactory` 是**唯一的可定制点**——它接收完整的 `Deps`, 可以构建**任何基于沙箱路由表的代理实现**。这让 E2B 在自托管/企业版本中能注入自定义网络策略, 而不必改主进程代码。

#### 关键设计: 优雅退出

```go
var closers []closer                       // 按添加顺序
defer func(g *errgroup.Group) {            // 进程退出时:
    err := g.Wait()                        // 1. 等所有 errgroup 协程结束
    if err != nil { success = false }      // 2. 任意失败 → exit 1
}(&g)
```

**`closers` 不在 defer 里执行, 而是在 process 退出后由 errgroup 负责反向**——保证 shutdown 顺序与启动顺序严格相反。

### 3.3 多协议复用: cmux

```go
cmuxServer := NewCMUXServer(ctx, config.GRPCPort, tel.MeterProvider)
httpListener := cmuxServer.Match(cmux.HTTP1Fast())  // 客户端→沙箱的 HTTP
grpcListener := cmuxServer.Match(cmux.Any())         # gRPC 入口
// ⚠️ 必须在 Serve() 之前完成所有 Match(), 否则数据竞争
```

**一个 TCP 端口同时承载 gRPC + HTTP/1**——`SandboxService` 用 gRPC, 用户的 `Client-Proxy` 用 HTTP 转发流量到沙箱, 避免监听多个端口。

---

## 4. 核心状态机: `pkg/sandbox/sandbox.go`

> 知识图谱: `file:packages/orchestrator/pkg/sandbox/sandbox.go` — fan-out 136, 是整个编排层引用次数最多的文件。

### 4.1 顶层数据结构

```go
type Sandbox struct {                // VM 沙箱实例
    Config     Config
    Metadata   Metadata
    Runtime    RuntimeInfo
    Volume     volume.Volume
    Slot       network.Slot
    Checks     *Checks
    Files      *Files
    // ... 内部状态机
}

type Factory struct { ... }          // 沙箱工厂 (依赖注入所有池)
func NewFactory(cfg, networkPool, devicePool, ...) *Factory
func (f *Factory) CreateSandbox(ctx, config) (*Sandbox, error)
func (f *Factory) ResumeSandbox(ctx, config) (*Sandbox, error)
```

### 4.2 生命周期端点 (gRPC)

定义在 `packages/shared/pkg/grpc/orchestrator/orchestrator.proto`, 实现在 `pkg/server/sandboxes.go`:

| gRPC 方法 | 行为 | sandbox.go 触发 |
|-----------|------|-----------------|
| `Create` | 创建并启动 VM, 返回 `client_id` | `Factory.CreateSandbox` |
| `Update` | 就地更新 end_time / egress 规则 | `Sandbox.SetEndAt` / `SetNetworkEgress` |
| `List` | 列出本节点所有运行中沙箱 | 遍历 `sandbox.Map` |
| `Delete` | 销毁 VM, 释放资源 | `Sandbox.Close` |
| `Pause` | 暂停 (生成 memfile/rootfs diff) | `snapshotAndCacheSandbox` |
| `Checkpoint` | 检查点 (不删除, 写 build) | 同上 |
| `ListCachedBuilds` | 列出节点缓存的 build | `templateCache` |

### 4.3 `CreateSandbox` 内部流程

```
1. 解析 SandboxConfig (template_id, build_id, kernel_version, vcpu, ram_mb, ...)
2. 资源预占:
   networkPool.Acquire(ctx)    # 拿 veth slot (IP + tap 端)
   devicePool.Acquire(ctx)     # 拿 /dev/nbdX
3. templateCache.GetOrStartFetch(templateID, buildID)  # 模板/构建产物
4. 创建 FC VM (fc/process.go):
   unshare+nsenter 启动 firecracker 二进制
   把 rootfs memfile 通过 NBD 接到 /dev/nbdX
   注入 MMDS 元数据
   setBootSource / setRootfsDrive
5. startEnvd (envd.go)  # 启动 VM 内的 envd 守护进程, Connect RPC
6. checks (checks.go)     # 等待 envd 就绪 / 探活
7. 注册到 sandbox.Map    # 后续流量通过 client_id 路由到这里
8. 启动 hoststats_collector  # 后台采集 host 资源
```

### 4.4 `Pause` / `Checkpoint` 流程

```
1. drain_balloon: 让 FC 把内存还回 host (memory.go)
2. CreateSnapshot (FC API): 生成 memfile + rootfs diff
3. diffcreator: 计算 dedup 后的 diff, 应用 feature flag (MemfileDiffDedupFlag)
4. uploads.Go(): 异步上传到 GCS, 同时写本地 cache
5. 写 SchedulingMetadata (含祖先 build 列表与字节数) 到响应
6. Pause 不删 VM, Checkpoint 同 Pause 但写 build
```

---

## 5. 子系统深读

### 5.1 Firecracker 集成 (`pkg/sandbox/fc/`)

#### `client.go` — 与 FC 的全部交互

> 知识图谱: `tags: ['firecracker','api-client','snapshot','metrics','rate-limit','memory']` complexity: complex

封装了 Firecracker 的全部 REST API (通过 Unix Domain Socket):

| 方法 | 作用 |
|------|------|
| `LoadSnapshot` | 从 memfile 恢复 VM |
| `ResumeVM` | 恢复暂停的 VM |
| `PauseVM` | 暂停 VM |
| `CreateSnapshot` | 生成 memfile + virtio-snapshot |
| `SetMmds` | 注入元数据 (env vars, team info) |
| `FlushMetrics` | 拉取 FC 内部指标 |
| `SetBootSource` | 配置内核 / initrd |
| `SetRootfsDrive` | 挂载 rootfs 块设备 |
| `SetNetworkInterface` | 绑定 tap 端 |
| `SetBalloon` | 配置 balloon 内存弹性 |
| `GetDirtyMemory` | 内存脏页统计 (用于 snapshot 决策) |

`fph_gates.go` 实现 **first-page-hit 限流门**——防止刚启动的 VM 在第一页 PTE 命中时导致 host page cache 抖动。

#### `process.go` — FC 进程管理

```go
// 用 unshare+nsenter 把 FC 进程放到独立 mount/pid/net namespace
// 每个沙箱一个 FC 进程, 便于 cgroup 隔离和快速清理
cmd := exec.CommandContext(ctx, fcBinary, "--api-sock", sockPath)
cmd.SysProcAttr = &syscall.SysProcAttr{...}
```

`uffd` (userfaultfd) 在此被集成, 用于**延迟分页**——VM 的 page fault 触发后, 模板缓存再异步把数据 page-in, 显著加速启动。

### 5.2 块设备子系统 (`pkg/sandbox/nbd/` + `pkg/sandbox/block/`)

#### NBD wire-protocol dispatcher (`dispatch.go`)

VM 内部 FC 进程通过 NBD 协议访问 host 上的块设备。dispatcher 处理:
- `NBD_CMD_READ` / `NBD_CMD_WRITE` — 读写
- `NBD_CMD_DISC` — 断开
- `NBD_CMD_FLUSH` — flush
- `NBD_CMD_TRIM` / `NBD_CMD_WRITE_ZEROES` — 优化

#### `path_direct.go` — 零拷贝直读

`path_direct` 是**性能关键路径**——绕过 NBD 用户态协议, 直接 splice/sendfile 把模板文件发到 VM 的内核 page cache, 避免双重拷贝。

#### `pool.go` — 设备池化

`/dev/nbdX` 数量是有限的 (默认 16~256)。`DevicePool` 预热并复用设备, 避免每次 `Create` 都 open/close。

#### `block/cache.go` — 块级去重

模板 rootfs 通常有大量重复块, 这里做 **内容寻址 (content-addressable) 去重 + 流式预取**。当多个沙箱共享同一 template 时, 物理上只读一次。

### 5.3 网络子系统 (`pkg/sandbox/network/`)

#### `network.go` — veth + netns

```go
func CreateNetwork(ctx, slot, hostIP, sandboxIP) error {
    // 1. 创建 veth pair: 一端在 host (tap 模式), 一端进沙箱 netns
    // 2. 给两端配 IP
    // 3. 配置路由: 沙箱的默认网关指向 host 端
    // 4. 配置 iptables: NAT 沙箱出网流量 (egress)
}
```

#### `pool.go` — slot 池

```go
type Pool struct {
    newSlots    chan *Slot     // 全新 veth (从 OS 申请)
    reusedSlots chan *Slot     // 复用 (从 storage 恢复)
}
```

**复用机制**: 删除沙箱时 veth 不立即销毁, 而是放回 `reusedSlots`; 下次创建时优先取回, 避免反复配置 iptables。

#### `egressproxy.go` + `tcpfirewall/`

- **Egress (出站)**: 由 `EgressFactory` 注入, 默认用 `tcpfirewall` 拦截, 按 `SandboxNetworkEgressConfig` 过滤域名/CIDR。
- **Ingress (入站)**: 用户→沙箱的流量由 `pkg/proxy/proxy.go` 转发, 根据 `client_id` 查到目标 `Sandbox.Slot` 后转发到对应 veth。

### 5.4 模板子系统 (`pkg/sandbox/template/` + `pkg/template/`)

> 注意: `pkg/sandbox/template/` 是**沙箱运行时**用的模板资源 (memfile/rootfs/snapfile), `pkg/template/` 是 **template-manager 模式** 用的服务。

#### `cache.go` — 多级缓存

```go
type Cache struct { ... }
func (c *Cache) GetTemplate(templateID, buildID) (Template, error)  // L1 内存 (ttlcache)
func (c *Cache) AddSnapshot(buildID, snap)                          // 写本地
func (c *Cache) fetchFromPeer(addr, templateID)                     // P2P 拉取
func (c *Cache) fetchFromNFS()                                      // NFS 兜底
```

**层级**: 内存 (ttlcache) → 本地磁盘 → P2P peer (Redis 注册) → NFS 共享存储 → GCS (远端冷备)。

#### `peerclient/` — P2P 客户端

- `registry.go` — Redis 注册中心, 节点上线时 `SADD` 自己
- `resolver.go` — 给定 templateID, 返回持有它的 peer 列表
- `blob.go` / `seekable.go` — 远端块流式下载
- `storage.go` — 把远端存储抽象为 `Storage` 接口

### 5.5 cgroup 资源管控 (`pkg/sandbox/cgroup/`)

与 envd 的 cgroup 不同, orchestrator 这层是**节点级**的: 把整台 host 的 cgroup 树用作多沙箱之间的资源分配。

```
RootCgroupPath
   ├── orchestrator-<pid>            # 进程自身
   ├── sandbox-<sandbox_id>          # 每沙箱一个分支
   │    ├── firecracker              # FC 进程
   │    ├── envd
   │    └── uffd
```

`cgroup/manager.go` 创建/销毁这些 cgroup, `Initialize()` 在启动时被调用。

---

## 6. 数据流: 一次完整沙箱创建

下面跟踪 `SandboxService.Create` 请求的全链路:

```
[API]  HTTP POST /sandboxes
   │
   │ gin handler → APIStore.CreateSandbox
   │ → orchestrator client.Create (gRPC)
   ▼
[Orchestrator]
   1. server/sandboxes.go:Create 接收 SandboxCreateRequest
   2. checks: 配额 / team 限制 / feature flag
   3. sandbox.Factory.CreateSandbox:
       a) networkPool.Acquire → veth slot + IP
       b) devicePool.Acquire  → /dev/nbdX
       c) templateCache.GetOrStartFetch(templateID, buildID)
          → P2P 拉取 / NFS 兜底 / GCS 下载
       d) fc/process.go: spawnFirecracker
          - unshare(NEWNS|NEWNET|NEWPID) → nsenter
          - 把 rootfs memfile mmap 进 FC 进程
          - 把 /dev/nbdX 挂到 FC 的 virtio block
          - API socket 创建在 /run/fc-<id>.sock
       e) fc/client.go: 配置 VM
          - PUT /boot-source  (kernel + cmdline)
          - PUT /drives/rootfs (path=/dev/nbdX, readonly=取决于 pause)
          - PUT /network/eth0   (iface_id=tap<slot>)
          - PUT /machine/config (vcpu, mem, hugepages)
          - PUT /mmds           (env vars, metadata, alias)
          - PUT /actions        (InstanceStart)
       f) sandbox/envd.go: startEnvd
          - 通过 FC console/serial 与 envd 握手
          - 等待 envd Connect RPC 就绪 (health check)
       g) sandbox.Map.Register(sandboxID, sbx)
       h) hoststats_collector.Start
       i) checks.All() 通过
   4. 返回 SandboxCreateResponse { client_id, scheduling_metadata }
   ▼
[API]  写 ClickHouse 事件流 (Redis Streams + ClickHouse 双投递)
   返回 HTTP 201 { sandboxID, clientID }
   ▼
[SDK / 用户]  通过 clientID 连接 → client-proxy → orchestrator:proxy → tap → VM
```

---

## 7. 关键设计模式与权衡

### 7.1 启动的"纯函数化"(`factories.Run`)

**问题**: 1000+ 行的启动函数, 30+ 子系统, 顺序敏感。

**方案**: 
- `Run(opts Options)` 接收外部注入 (`EgressFactory`)
- 所有子系统**按依赖拓扑**严格顺序创建
- `closers []closer` 显式注册, shutdown 走 `errgroup`
- `Deps` 结构体作为子系统间的**显式契约**

**收益**: 可单测、可替换发行版、可视化启动图 (上面 3.2 节的列表就是从源码逆推的)。

### 7.2 "沙箱路由表"作为编排核心

`sandbox.Map` 是**整个进程的真理来源**——所有代理、流量、监控都从这里查。

| 调用方 | 用途 |
|-------|------|
| `pkg/proxy/proxy.go` | 用户→沙箱的入站 HTTP |
| `pkg/tcpfirewall/proxy.go` | 出站过滤需要知道沙箱的元数据 |
| `pkg/server/sandboxes.go:List` | API 层 List 接口 |
| `pkg/metrics/sandboxes.go` | OTEL Gauge 采集 |
| `pkg/hyperloopserver` | 内部传输寻址 |

**单一真理源** + **并发安全读写** (`sync.Map` 包装) 是高并发编排的关键。

### 7.3 Firecracker / Orchestrator / Envd 的三层关系

```
┌──────────────────────────────────────────────────────────┐
│                       Orchestrator                       │
│   - 拥有 FC 进程 (unshare+nsenter 起)                    │
│   - 拥有 NBD 设备、veth slot                              │
│   - 通过 FC Unix socket REST API 控制 VM 启停            │
│   - 通过 envd (in-VM) Connect RPC 与用户代码交互          │
└────────────────┬──────────────────────────┬──────────────┘
                 │                          │
                 ▼                          ▼
        ┌────────────────┐         ┌────────────────┐
        │  Firecracker   │         │      Envd      │
        │  (VMM)         │         │  (in-VM daemon)│
        │  - KVM 虚拟化  │         │  - process API │
        │  - virtio 设备  │         │  - filesystem  │
        │  - API socket  │         │  - ports/inspt │
        └────────────────┘         └────────────────┘
```

**Orchestrator 不在 VM 内部**——它通过两条链路管理 VM:
1. **控制平面**: FC 的 Unix REST API (管 CPU/内存/块设备)
2. **数据平面**: envd 的 Connect RPC (管进程/文件)

### 7.4 多级缓存的模板系统

```
                ┌────────────┐
                │  ttlcache  │  ← 内存最快, 易失
                │  (per-pod) │
                └─────┬──────┘
                      │ miss
                ┌─────▼──────┐
                │ 本地磁盘   │  ← /var/cache/e2b/templates
                │ memfile/   │
                │ rootfs     │
                └─────┬──────┘
                      │ miss
                ┌─────▼──────┐
                │ P2P peer   │  ← Redis 注册, 二进制直拉
                │ (同集群)   │
                └─────┬──────┘
                      │ miss
                ┌─────▼──────┐
                │ NFS 共享   │  ← Filestore (GCP)
                └─────┬──────┘
                      │ miss
                ┌─────▼──────┐
                │ GCS 远端   │  ← 冷备, 异步上传
                └────────────┘
```

每一级都失败才往下走——**95% 的沙箱创建在前两级就完成了**。

### 7.5 优雅退出 (`errgroup` + 显式 closers)

```go
var g errgroup.Group
var closers []closer
// 启动时 g.Go(...) 收集, closers 顺序追加
// 退出时:
defer g.Wait()                 // 1. 等所有服务返回
// closers 在 Run() 末尾被 reverse 调用  // 2. 反向关闭
```

**严格反向顺序**保证: 网络监听先关 → 沙箱先停 → 模板缓存后关 → logger 最后 flush。

### 7.6 Linux-only (`//go:build linux`)

```go
//go:build linux
package main
```

Orchestrator 强依赖 Linux 内核特性: KVM, nbd, netns, cgroup v2, iptables, veth, userfaultfd, unshare. **不能在 macOS 上跑**。本地开发要么用 Linux VM, 要么用 `cmd/dummy-orchestrator` (集成测试用 mock)。

---

## 8. 与上下游的契约

### 8.1 上游: API (`packages/api/`)

通过 gRPC 调用, **7 个 RPC**:

| RPC | 用途 |
|-----|------|
| `SandboxService.Create` | 创建沙箱 |
| `SandboxService.Update` | 更新 end_time / egress |
| `SandboxService.List` | 列出本节点沙箱 |
| `SandboxService.Delete` | 销毁 |
| `SandboxService.Pause` | 暂停 (用于长任务) |
| `SandboxService.Checkpoint` | 检查点 (写 build) |
| `SandboxService.ListCachedBuilds` | 节点模板查询 |
| `VolumeService.*` | 卷挂载管理 |
| `ChunkService.*` | 块级数据 |
| `TemplateService.*` (template-manager 模式) | 模板构建 |
| `InfoService.*` | 节点元信息 |

### 8.2 下游: Envd (`packages/envd/`)

在 VM 内部, 通过 Connect RPC 暴露:
- `ProcessService` — Start/Wait/Signal/List
- `FilesystemService` — Read/Write/Stat/List

Orchestrator 的 `sandbox/envd.go` 是**唯一**与 envd 对话的客户端。

### 8.3 基础设施依赖

| 依赖 | 用途 |
|------|------|
| Firecracker (`fc-versions/`) | VMM 二进制 |
| Linux KVM | 硬件虚拟化 |
| `/dev/nbdX` | 块设备 |
| `/dev/net/tun`, `/dev/kvm` | 网络/TUN, KVM |
| cgroup v2 mount | 资源管控 |
| iptables | NAT / 防火墙 |
| GCS / NFS | 模板存储 |
| Redis | P2P 注册, 事件流 |
| ClickHouse | 指标/事件持久化 |
| LaunchDarkly | feature flags |
| PostgreSQL | API 层, **不直连** |
| Nomad | 进程调度 (由 API 层调用) |

---

## 9. 关键 proto 契约 (摘自 `orchestrator.proto`)

```protobuf
service SandboxService {
  rpc Create(SandboxCreateRequest)  returns (SandboxCreateResponse);
  rpc Update(SandboxUpdateRequest)  returns (SchedulingMetadata);
  rpc List(SandboxListRequest)      returns (SandboxListResponse);
  rpc Delete(SandboxDeleteRequest)  returns (SchedulingMetadata);
  rpc Pause(SandboxPauseRequest)    returns (SandboxPauseResponse);
  rpc Checkpoint(SandboxCheckpointRequest) returns (SandboxCheckpointResponse);
  rpc ListCachedBuilds(SandboxListCachedBuildsRequest) returns (SandboxListCachedBuildsResponse);
}

message SandboxConfig {
  string template_id = 1;
  string build_id = 2;
  string kernel_version = 3;
  string firecracker_version = 4;
  bool hugepages = 5;
  string sandbox_id = 6;
  map<string, string> env_vars = 7;
  map<string, string> metadata = 8;
  string alias = 9;
  string envd_version = 10;
  uint32 vcpu = 11;
  uint32 ram_mb = 12;
  string team_id = 13;
  int64  max_sandbox_length = 14;
  SandboxAutoResumeConfig auto_resume = 15;
  repeated SandboxVolumeMount volume_mounts = 16;
  SandboxNetworkConfig network = 17;
}
```

完整定义在 `packages/shared/pkg/grpc/orchestrator/orchestrator.pb.go` (由 `protoc` 自动生成)。

---

## 10. 一图概览: 从 API 调用到用户代码执行

```
┌──────────┐    ┌────────┐    ┌──────────────┐    ┌────────┐    ┌────────────┐
│   SDK    │───▶│  API   │───▶│ Orchestrator │───▶│   FC   │───▶│   envd     │───▶ 用户代码
│ (Python) │    │  Gin   │gRPC │ pkg/sandbox  │REST│        │RPC │ pkg/services│
└──────────┘    └────────┘    └──────┬───────┘    └────┬───┘    └────────────┘
                                     │                 │
                                     │ NBD            │ KVM
                                     │ template/cache  │
                                     ▼                 ▼
                                ┌─────────┐       ┌────────┐
                                │ GCS/NFS │       │  KVM   │
                                │ 模板存储 │       │  vCPUs │
                                └─────────┘       └────────┘
```

**两条独立通道**:
- **控制** (粗箭头): gRPC → REST → RPC, 管理生命周期
- **数据** (细箭头): NBD 拉模板、tap 收流量、FC 调度 vCPU

---

## 11. 参考知识图谱节点

| 节点 ID | 摘要 |
|--------|------|
| `file:packages/orchestrator/main.go` | 进程入口 |
| `file:packages/orchestrator/pkg/factories/run.go` | 启动工厂, 复杂度: complex |
| `file:packages/orchestrator/pkg/server/sandboxes.go` | gRPC 7 个端点实现 |
| `file:packages/orchestrator/pkg/sandbox/sandbox.go` | 沙箱核心, fan-out 136 |
| `file:packages/orchestrator/pkg/sandbox/fc/client.go` | FC API 客户端 |
| `file:packages/orchestrator/pkg/sandbox/fc/process.go` | FC 进程 + uffd 集成 |
| `file:packages/orchestrator/pkg/sandbox/nbd/dispatch.go` | NBD wire protocol |
| `file:packages/orchestrator/pkg/sandbox/network/network.go` | veth + netns |
| `file:packages/orchestrator/pkg/sandbox/network/pool.go` | veth slot 池 |
| `file:packages/orchestrator/pkg/sandbox/template/cache.go` | 多级模板缓存 |
| `file:packages/orchestrator/pkg/cfg/model.go` | 配置模型 |
| `endpoint:packages/orchestrator/orchestrator.proto:SandboxService.Create` | 创建端点 |
| `layer:core-orchestrator` | 编排层 (429 节点) |
| `tour:step5` ~ `tour:step8` | Tour 第 5-8 步专门讲解本模块 |

---

## 12. 进一步阅读

- `tour:step9` — Envd (VM 内守护进程) 与本模块的协作
- `tour:step10` — 共享库 `packages/shared/pkg/fc/client/firecracker_client.go` (FC 官方版客户端)
- `tour:step12` — Terraform 部署 Nomad 集群
- `document:CLAUDE.md` 章节 **"Firecracker & VM Management"** + **"Observability"**
- `document:self-host.md` 自托管路径
