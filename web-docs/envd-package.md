# `packages/envd/` 原理详解

> 本文梳理 E2B 平台 **沙箱内 daemon**（envd）的完整工作原理、protobuf 契约、运行模式与核心子系统。所有结论基于仓库源码与 `.understand-anything/knowledge-graph.json`。

## 2026.30 变动

> ⓘ 本节逐项对照 tag `2026.30` 核实；正文中的行号一律以 2026.30 为准，与 2026.29 不同处标为"行 N（2026.30；2026.29 为 M）"。

### 1. 版本号：0.6.10 → 0.8.0

`packages/envd/pkg/version.go` 在两个 tag 之间涨了 5 个版本，每一次都对应真实的行为变更（`version.go` 的约定是"任何行为变更都必须 bump"）：

| 版本 | 日期 | 触发 commit | 行为变更 |
| --- | --- | --- | --- |
| 0.6.10 | — | （2026.29 基线） | — |
| 0.6.11 | 2026-07-24 | `fix(envd): replace time.Sleep with ticker in ScanAndBroadcast for prompt shutdown` | 端口扫描循环从 `time.Sleep` 改为 `time.NewTicker` + `select scanExit`，让 shutdown 能立刻打断扫描 |
| 0.6.12 | 2026-07-28 | `feat(orch): live-upgrade envd inside a running sandbox at resume` | **在线热升级（handover 协议）** |
| 0.6.13 | 2026-07-29 | `Bump version from 0.6.12 to 0.6.13` | 收尾修补 |
| 0.7.0 | 2026-08-24 | `feat(envd): freeze the customer's cgroups before a pause, not only our own` | **层级化 freeze/thaw**；`feat(envd): wait for the pre-pause freeze to stop the workload`（settle 轮询）；`feat(orch): forbid envd's private endpoints in the sandbox proxy`（`x-internal`） |
| 0.8.0 | 2026-09-07 | `feat(envd): name versioned uploads and promotes by release version` | 版本化上传改用 release version 命名；另有 `flush logs before pause snapshots`、`report process-start resource exhaustion as resource_exhausted`、`stop counting a vanished cgroup as a freeze or thaw failure`、`orch: re-send a sandbox's default user` 等修复 |

> ⓘ 从 0.6.13 起版本号改由 **release-please** 驱动：`version.go` 的常量行带上 `// x-release-please-version` 注解，`packages/envd/CHANGELOG.md` 由 release-please 自动维护。同一时期还引入了 `ENVD_VERSION` / `UPLOAD_VERSION`（`Makefile`），版本化上传对象名从 `envd.<7 位 commit sha>` 改成 `envd.v<release version>`。

### 2. 新增能力

| 能力 | 主要文件 | 说明 |
| --- | --- | --- |
| **handover 协议** | `spec/upgrade/handover.proto`、`internal/services/process/upgrade.go`、`internal/services/process/handler/readopt.go` | orchestrator 调 `POST /upgrade`；outgoing envd 冻结 workload → 序列化 `HandoverState` 到 `/run/e2b/envd-handover.pb` → **同 PID** `execve` 到 `/usr/bin/envd.next`；incoming envd 带 `--resume-handover` 读回 blob，重新认领子进程、watcher、NFS mount ledger 与 socat |
| **层级化 cgroup freeze/thaw** | `internal/services/cgroups/freeze.go`、`hierarchy.go` | `WorkloadFreezer` 按 cgroup 树遍历，冻结 allowlist 之外的全部子树；settle 轮询等 `cgroup.events`；thaw 时保留 guest 自己冻结的 cgroup；另加 10 分钟 thaw watchdog |
| **内存保护上报** | `internal/services/cgroups/memory.go` | 读取 `memory.max` / `memory.high` / `memory.min` / `memory.low`，经 `/init` 的 `X-Envd-Memory` 头回给 orchestrator |
| **进程退出保留缓存** | `internal/services/process/service.go` | `terminatedRetentionTTL = 30s`，晚到的 `Connect` 也能补拿 `EndEvent` |
| **`x-internal` 控制面标记** | `spec/envd.yaml` | 6 条 orchestrator 控制面路径标 `x-internal: true`，orchestrator 由 `gen_internal_routes.go` 生成拒绝列表 |

### 3. 接口与签名变更

| 项 | 2026.29 | 2026.30 |
| --- | --- | --- |
| `POST /freeze` | 无参数，恒 204 | 接受 `mode` / `maxCgroups` / `maxWaitMs`；带 `maxWaitMs` 时返回 200 + `FreezeResult` |
| `POST /upgrade` | ⛔ 不存在 | 新增（**不在 OpenAPI spec 里**，直挂在 chi mux 上） |
| `/init` 响应头 | 无 | 新增 `X-Envd-Version`、`X-Envd-Handover`、`X-Envd-Freeze-Audit`、`X-Envd-Defaults`、`X-Envd-Memory` |
| `cgroups.Manager` | `GetFileDescriptor` / `Freeze` / `Unfreeze` / `Close` | 新增 `Frozen(ProcessType) (bool, error)`；新增 `PathManager` 接口 |
| `ProcessType` 常量值 | `"PTY"` / `"Socat"` / `"User"` | `"pty"` / `"socat"` / `"user"`（全小写），另有 `"system"` |
| `logs.NewLogger` | `(ctx, isNotFC, verbose, mmdsChan)` | `(verbose, writers ...io.Writer)`；exporter 构造移到 `main.go` |
| `process.Handle` | `(m, l, defaults)` | `(m, l, defaults, workloadFreezer)` |
| `filesystem.Handle` | 无返回值 | 返回 `Service` |
| `api.New` | `(l, defaults, mmdsChan, isNotFC, cgroupManager)` | `(l, defaults, mmdsChan, isNotFC, workloadFreezer, logFlushers ...LogFlusher)` |
| `port.Forwarder.AddSubscriber` | `AddSubscriber(id, filter, logger)` | `AddSubscriber(id, filter)` |
| `port.Scanner.Processes` / `Unsubscribe` | 存在 | ⛔ 删除；改为 `AddSubscriber` + `Signal(proc, exit <-chan struct{})` |
| `internal/port/scanSubscriber.go` | 文件名 | 重命名为 `internal/port/scan_subscriber.go` |
| `internal/api/init.go` 的 `userCgroupsToFreeze` | 存在 | ⛔ 删除（冻结范围改由 `WorkloadFreezer` 决定） |
| `main.go` 的 `defaultUser` 常量 | `"root"` | ⛔ 删除，改用 `execcontext.BuiltinDefaultUser` |

### 4. 没有变的东西

- 监听端口仍是 `49983`（`main.go:39`），`IdleTimeout` 仍是 640s（`main.go:36`）。
- `spec/process/process.proto`、`spec/filesystem/filesystem.proto` **一行未改**：没有新 RPC、没有新字段、没有改字段号。
- `spec/upgrade/handover.proto` **只定义 message，不定义 service**，所以 2026.30 没有新增 Connect RPC service；`packages/shared/pkg/grpc/envd/upgrade/handover.pb.go` 是纯 message 产物，没有 `*connect` 子包。
- `buf.gen.yaml` / `buf.gen.shared.yaml` 未改动（生成按目录递归，新 proto 自动被带上）。

> ⚠️ "离线替换 envd"（`envd-offline-upgrade-target` flag，冷启动前在 jailed 环境用 `debugfs` 改写 `/usr/bin/envd`）**不是 envd 进程内的能力**，是 orchestrator 侧行为，因此本文不展开；见 [snapshots.md §7.4](./snapshots.md)。

## 1. 背景与定位

### 1.1 它是什么

**envd**（environment daemon）是 **运行在每个 Firecracker microVM 内部** 的一个常驻进程。它对外暴露一组 Connect/gRPC 接口，让 SDK / client-proxy 能远程启动进程、读写文件、监听目录变更。它是 **"用户与沙箱的边界"**——SDK 的所有 `commands.run`、`files.read` 等调用最终都打到 envd。

```
SDK ──HTTP/gRPC──► client-proxy ──► orchestrator-proxy (5007) ──► envd (49983) [in VM]
                                                                    │
                                                                    ├── 启动用户进程 (fork+exec+pty)
                                                                    ├── 文件系统操作 (stat/read/write/list/move/remove)
                                                                    ├── 目录监听 (fsnotify)
                                                                    ├── MMDS 探测 (169.254.169.254)
                                                                    ├── 端口自动转发 (socat + gopsutil)
                                                                    └── cgroup v2 资源管控
```

### 1.2 它在 VM 里的位置

- **运行身份**：root（需要 setuid、cgroup 操作、iptables pin MMDS）
- **默认端口**：`49983`（可被 `--port` 覆盖）
- **HTTP/2 cleartext**：通过 `httpserver.ConfigureH2C` 启用（虽然没用）
- **CORS**：全放开（`AllowedOrigins: *`），因为它只接受来自 client-proxy 的内网调用
- **不关连接**：`ReadTimeout: 0 / WriteTimeout: 0`——长连接靠 sandbox 销毁来断
- **IdleTimeout**：`640s`（`idleTimeout`），必须大于上游 orchestrator-proxy 的 idle timeout

### 1.3 版本机制（`pkg/version.go`）

```go
package pkg

const Version = "0.8.0" // x-release-please-version
```

> ⓘ 2026.29 时这里是 `const Version = "0.6.1"`（已过时）→ 实际为 `"0.6.10"`；2026.30 为 `"0.8.0"`，并带上了 `// x-release-please-version` 注解。

`pkg.Version` 是个 **不参与运行时常量**，但 **参与构建时常量**。CLAUDE.md 明确：

> The envd version in `pkg/version.go` must be bumped on every behavioral change (not comments/docs-only changes)

- 通过 `envd --version` / `envd --commit` 查询。
- 模板构建期 `e2b template build` 会读取这个 version 决定模板缓存键——**版本不一致意味着 envd 行为变了，缓存的镜像不能用**。
- 这是一个 **不可绕过的强约束**——任何改了 envd 行为的 PR 都必须 bump。
- 2026.30 起版本号由 **release-please** 维护：注解 `// x-release-please-version` 让 release-please 自动改写这一行，并在 `packages/envd/CHANGELOG.md` 累积条目。`Makefile` 也从 `pkg/version.go` 里 `sed` 出 `VERSION`，用于给上传产物命名（`envd.v<version>`，替代旧的 `envd.<7 位 sha>`）。

## 2. 目录结构

```
packages/envd/
├── go.mod                       # 独立 module（connectrpc、chi、zerolog、pty、cgroups）
├── go.sum
├── Makefile                     # build / generate / start-docker / promote
├── debug.Dockerfile             # 调试镜像
├── CHANGELOG.md                 # 【2026.30 新增】release-please 自动维护
├── main.go                      # 入口：flag 解析、MMDS 轮询、路由、HTTP server
├── pkg/
│   └── version.go               # Version 常量（带 // x-release-please-version）
├── spec/                        # Protobuf 契约（手工写，buf codegen）
│   ├── process/process.proto    # 进程管理（Start/Connect/SendInput/SendSignal/...）
│   ├── filesystem/filesystem.proto  # 文件系统（Stat/MakeDir/Move/List/Remove/Watch）
│   ├── upgrade/handover.proto   # 【2026.30 新增】热升级交接 blob（只有 message，无 service）
│   ├── envd.yaml                # OpenAPI 3.0 spec（REST）
│   ├── buf.gen.yaml             # buf codegen 配置（产出 Connect handlers）
│   ├── buf.gen.shared.yaml      # 产出到 shared/pkg/grpc/envd/（SDK 用的客户端 stub）
│   └── generate.go              # `go generate` 入口
└── internal/
    ├── api/                     # OpenAPI/JSON-HTTP 接口（v1 老接口，保留向后兼容）
    │   ├── api.gen.go           # oapi-codegen 生成的 type
    │   ├── store.go             # API struct + 健康检查
    │   ├── auth.go              # access token + 签名校验
    │   ├── init.go              # /init（orchestrator 推送配置）+ freeze/unfreeze + 诊断头
    │   ├── mounts_handover.go   # 【2026.30 新增】NFS mount ledger 的导出/导入
    │   ├── upload.go / download.go / compose.go  # 旧版文件操作
    │   └── secure_token.go      # memguard 保护的内存
    ├── execcontext/             # 进程执行的默认上下文（BuiltinDefaultUser = "root"）
    ├── host/                    # 与 VM 宿主交互：MMDS / metrics / CA 证书
    │   ├── mmds.go              # 169.254.169.254 轮询
    │   ├── mmds_route_linux.go  # iptables 自愈（pin MMDS 路由）
    │   └── metrics.go           # CPU/Mem/Disk 采集
    ├── logs/                    # zerolog + OTel 风格的日志
    ├── permissions/             # 权限与路径处理
    │   ├── authenticate.go      # Basic Auth → user.User
    │   ├── user.go              # UID/GID 解析
    │   ├── path.go              # ~ 展开、相对路径解析
    │   └── keepalive.go         # Keepalive-Ping-Interval 头解析
    ├── port/                    # 自动端口转发
    │   ├── scan.go              # 周期扫描 LISTEN 端口（ticker + scanExit）
    │   ├── scanfilter.go        # 过滤 127.0.0.1/localhost/::1
    │   ├── scan_subscriber.go   # pub-sub 模型（2026.29 名为 scanSubscriber.go）
    │   ├── forward.go           # 启动 socat 转发到 eth0 IP（记录 socatPid）
    │   └── forward_reap_linux.go # 【2026.30 新增】按 pid 回收 socat
    ├── services/
    │   ├── cgroups/             # cgroup v2 资源管理
    │   │   ├── iface.go         # Manager + PathManager 接口、ProcessType
    │   │   ├── cgroup2.go       # 真实现（linux build tag）
    │   │   ├── cgroup2_stub.go  # stub（非 linux）
    │   │   ├── freeze.go        # 【2026.30 新增】WorkloadFreezer：层级 freeze/thaw + watchdog
    │   │   ├── hierarchy.go     # 【2026.30 新增】cgroup 树遍历、allowlist、审计
    │   │   ├── memory.go        # 【2026.30 新增】读 memory.max/high/min/low
    │   │   └── noop.go          # --no-cgroups 用的空实现
    │   ├── filesystem/          # Filesystem service（Connect）
    │   │   ├── service.go       # Service struct + Handle 注册
    │   │   ├── stat.go / dir.go / move.go / remove.go
    │   │   ├── watch.go         # WatchDir（流式）
    │   │   ├── watch_sync.go    # CreateWatcher / GetWatcherEvents / RemoveWatcher（轮询）
    │   │   └── watch_handover.go # 【2026.30 新增】watcher 集合的导出/重挂
    │   ├── process/             # Process service（Connect）
    │   │   ├── service.go       # Service struct + Handle 注册 + getProcess 选择器
    │   │   ├── start.go         # Start（server stream）
    │   │   ├── connect.go       # Connect（订阅已存在进程，含终态缓存回放）
    │   │   ├── list.go / signal.go / update.go
    │   │   ├── input.go         # SendInput / StreamInput / CloseStdin
    │   │   ├── upgrade.go       # 【2026.30 新增】outgoing 侧：冻结→序列化→execve
    │   │   ├── dup3_linux.go    # 【2026.30 新增】跨 execve 的 fd 搬迁
    │   │   ├── start_test.go
    │   │   └── handler/         # 单进程的 Handler
    │   │       ├── handler.go   # fork+exec+pty 封装
    │   │       ├── multiplex.go # MultiplexedChannel 泛型 fan-out
    │   │       ├── readopt.go   # 【2026.30 新增】incoming 侧：重新认领子进程
    │   │       ├── pidfd_linux.go # 【2026.30 新增】pidfd_open 精确收尸
    │   │       └── start_error.go # 【2026.30 新增】errno → Connect 错误码映射
    │   ├── legacy/              # 老版本 SDK 兼容
    │   │   ├── interceptor.go   # ConversionInterceptor
    │   │   └── stream.go        # 协议差异补偿
    │   └── spec/                # buf codegen 出的 Go 桩（不直读）
    └── utils/                   # EnvVars、AtomicMax、multipart
```

## 3. 启动流程（`main.go`）

```
main()
  ├─ parseFlags()                 # --port, --cgroup-root, --no-cgroups, --verbose, --isnotfc,
  │                               #   --resume-handover, --version, --commit
  ├─ if --version: 打印 pkg.Version
  ├─ if --commit:  打印 commitSHA
  └─ run()
        ├─ ctx, cancel := WithCancel(Background)
        ├─ defaults := execcontext.Defaults{User: BuiltinDefaultUser, EnvVars}
        ├─ 写 /run/e2b/.E2B_SANDBOX 标记文件
        ├─ 启动 PollForMMDSOpts goroutine（如果不是 isnotfc）
        ├─ logs.NewLogger(verbose, logWriters...)
        ├─ chi.NewRouter()
        ├─ filesystem.Handle(m, ...)
        ├─ createCgroupManager() → Manager（三种实现之一）
        ├─ workloadFreezer := cgroups.NewWorkloadFreezer(cgroupManager)
        ├─ workloadFreezer.SetThawWatchdog(DefaultThawWatchdogWindow, ...)
        ├─ process.Handle(m, ..., defaults, workloadFreezer)
        ├─ if --resume-handover: ResumeFromHandover(...) 重挂 watcher/mount/forward
        ├─ api.New(..., workloadFreezer, logFlusher)
        ├─ if --resume-handover: 武装 60s 兜底 thaw（time.AfterFunc）
        ├─ m.Post("/upgrade", ...)   ← 唯一不经 OpenAPI spec 的路由
        ├─ service.WithAuthorization(authn.Wrap(api.HandlerFromMux(service, m)))
        ├─ http.Server{ReadTimeout=0, WriteTimeout=0, IdleTimeout=640s}
        ├─ portScanner := NewScanner(1s) → 后台 ScanAndBroadcast()
        ├─ portForwarder := NewForwarder(...) → 后台 StartForwarding()
        │    └─ if --resume-handover: ImportForwards(...) 认领已在跑的 socat
        └─ server.ListenAndServe()
```

### 3.1 关键 flag

| flag | 默认 | 含义 |
| --- | --- | --- |
| `--isnotfc` | false | 非 Firecracker 模式（本地 dev 跑 docker 容器用），跳过 MMDS 轮询和 HTTP log exporter |
| `--port` | 49983 | 监听端口 |
| `--cgroup-root` | `/sys/fs/cgroup` | cgroup 挂载点（测试时改） |
| `--no-cgroups` | false | 关闭 cgroup，用 NoopManager 兜底 |
| `--verbose` | false | 日志也写到 stdout |
| `--resume-handover` | false | 【2026.30 新增】本次启动是热升级后的新镜像，需从 `/run/e2b/envd-handover.pb` 恢复世界 |

### 3.2 三种 cgroup 管理器

`createCgroupManager()` 顺序回退：

1. **`--no-cgroups`** → `NoopManager`（无 cgroup 控制）
2. **`NewCgroup2Manager(opts...)`** → `Cgroup2Manager`（生产路径）
3. **失败** → 打印 "falling back to no-op cgroup manager"，返回 `NoopManager`

`Cgroup2Manager` 在 `createCgroups` 时会先 `unix.Statfs(cgroup_root)` 检查 **cgroup v2 magic**（`CGROUP2_SUPER_MAGIC`）——cgroup v1 系统会直接拒绝，避免 tmpfs 上的"伪 cgroup"。

## 4. Protobuf 契约（`spec/`）

### 4.1 `process.proto`

```proto
service Process {
    rpc List(ListRequest) returns (ListResponse);
    rpc Connect(ConnectRequest) returns (stream ConnectResponse);   // server stream
    rpc Start(StartRequest) returns (stream StartResponse);         // server stream
    rpc Update(UpdateRequest) returns (UpdateResponse);
    rpc StreamInput(stream StreamInputRequest) returns (StreamInputResponse);  // client stream
    rpc SendInput(SendInputRequest) returns (SendInputResponse);
    rpc SendSignal(SendSignalRequest) returns (SendSignalResponse);
    rpc CloseStdin(CloseStdinRequest) returns (CloseStdinResponse);
}
```

- **`Start`（server stream）**：发起新进程，把 `StartEvent(pid)` / `DataEvent{stdout|stderr|pty}` / `EndEvent(exit_code)` / `KeepAlive` 推流给客户端。
- **`Connect`（server stream）**：订阅一个已存在的进程（`pid` 或 `tag` 选择器），从当前位置开始接收 Data/End 事件。
- **`StreamInput`（client stream）**：批量推送输入（`Start` / `Data` / `Keepalive`）保证顺序。
- **`SendInput`（unary）**：单条 stdin 或 pty 字节。
- **`CloseStdin`**：EOF（**非 PTY 模式专用**；PTY 用 `Ctrl+D` 0x04）。
- **`SendSignal`**：SIGTERM(15) / SIGKILL(9)。
- **`Update`**：调整 PTY 尺寸。

`ProcessSelector` 用 `oneof` 支持 `pid` 或 `tag`——SDK 通常用 `tag` 而不是 `pid`（pid 在不同进程间不可预测，tag 是用户起的别名）。

### 4.2 `filesystem.proto`

```proto
service Filesystem {
  rpc Stat(StatRequest) returns (StatResponse);
  rpc MakeDir(MakeDirRequest) returns (MakeDirResponse);
  rpc Move(MoveRequest) returns (MoveResponse);
  rpc ListDir(ListDirRequest) returns (ListDirResponse);
  rpc Remove(RemoveRequest) returns (RemoveResponse);

  rpc WatchDir(WatchDirRequest) returns (stream WatchDirResponse);     // 流式

  // 轮询版本
  rpc CreateWatcher(CreateWatcherRequest) returns (CreateWatcherResponse);
  rpc GetWatcherEvents(GetWatcherEventsRequest) returns (GetWatcherEventsResponse);
  rpc RemoveWatcher(RemoveWatcherRequest) returns (RemoveWatcherResponse);
}
```

- **流式 vs 轮询两套 watch**：流式（`WatchDir`）给 gRPC 长连接场景；轮询（`CreateWatcher` + `GetWatcherEvents`）给短连接/HTTP 场景。两者共享同一个 `FileWatcher` 内核，区别在传输层。
- **`EntryInfo`** 包含 `name / path / type / size / mode / permissions / owner / group / modified_time / symlink_target`，其中 `symlink_target` 在 2025 年后通过 `optional` 字段加入。
- **`EventType`**：`CREATE / WRITE / REMOVE / RENAME / CHMOD`——一个 fsnotify 事件可能对应多个 type（例如 SAVE 触发 `CREATE`+`WRITE`+`CHMOD`）。

### 4.3 兼容旧 SDK（`internal/services/legacy/`）

```go
const brokenUserAgent = "connect-python"
const notifyHeader    = "X-E2B-Legacy-SDK"

func shouldHideChanges(request, response http.Header) bool {
    if request.Get("user-agent") != brokenUserAgent { return false }
    response.Set(notifyHeader, "true")
    return true
}
```

- 当 `User-Agent: connect-python` 时，**所有响应**都套一层 `ConversionInterceptor`。
- 这个 Python SDK 历史上对某些字段不兼容（典型：枚举值大小写、可选字段缺失），`legacy/stream.go` 的 `streamConverter` 在 wire 层做转换。
- 标记 `X-E2B-Legacy-SDK: true` 让上游可以识别这些是被"美化过"的旧协议响应。

### 4.4 `upgrade/handover.proto`（【2026.30 新增】）

这个文件**不是给 SDK 用的 RPC 契约**，而是 envd 自己两个镜像之间的兼容契约：

```proto
package upgrade;

// 只有 message，没有 service —— 不生成 Connect stub。
message HandoverState {
  uint32 schema = 1;                              // 兼容版本号
  string from_ver = 2;                            // 交接方的 envd 版本
  repeated HandoverProc    processes = 3;         // 存活子进程（fd 编号随之交接）
  repeated HandoverExit    terminated = 4;        // 尚未被 drain 的终态事件
  repeated HandoverWatcher watchers = 5;          // 活跃的 CreateWatcher 集合
  repeated MountEntry      mounts = 6;            // NFS mount ledger（path → lifecycle）
  repeated ForwardedPort   forwards = 7;          // 活跃 socat
  repeated string          guest_frozen_cgroups = 8;  // guest 自己冻结的 cgroup
  HandoverDefaults         defaults = 9;          // 默认 user / workdir
}
```

| 字段 | 为什么必须交接 |
| --- | --- |
| `processes[].stdout_fd` / `stderr_fd` / `stdin_fd` / `tty_fd` | fd **编号**在 `execve` 后依然有效（内核对象跟着 fd table 走），所以只要把编号传过去、CLOEXEC 清掉即可 |
| `processes[].tag` | tag 不在 `/proc` 里，丢了就**不可重建**（`has_tag` 用来区分"空 tag"与"没有 tag"） |
| `terminated` | 保留缓存里的退出码不能因为换镜像而丢 |
| `watchers` | 按元数据**重新武装** fsnotify，而不是搬 inotify fd |
| `mounts` | 内核 mount 在 `execve` 后仍存活，带上 ledger 就能识别"同 lifecycle 的挂载点"而跳过卸载重挂（避免 ESTALE） |
| `forwards` | socat 子进程同样存活，带上 `socat_pid` 就能**重新认领**而不是再 spawn 一个 |
| `guest_frozen_cgroups` | thaw 必须**跳过** guest 自己冻结的 cgroup（例如 `docker pause`）；丢失时退化为"全部解冻"，这是刻意的降级方向 |
| `defaults` | 让新镜像从 blob 里恢复默认 user/workdir，不必依赖 orchestrator 在升级后补发 `/init` |

**schema 纪律**（`internal/services/process/upgrade.go`）：

```go
const handoverSchema = handoverSchemaDefaults   // 当前上限 = 3

const (
    handoverSchemaBase        = 1  // 到 forwarded ports 为止
    handoverSchemaGuestFrozen = 2  // + guest_frozen_cgroups
    handoverSchemaDefaults    = 3  // + defaults
)
```

- 写方用 `schemaFor()` 挑**能表达当前内容的最低 schema**——老 envd 读到新 blob 时不会因为多出来的默认值字段而困惑。
- 读方在 `schema > handoverSchema` 时**直接拒绝**，不做任何猜测。因为读发生在 `execve` 之后，没有"回退到旧二进制"的路径，误读比失败更糟。
- 关掉 handover 的 flag 就是回滚手段。

## 5. 进程管理（`internal/services/process/`）

### 5.1 整体结构

```
process.Service
  ├─ processes  : Map[uint32 → *handler.Handler]   // 活跃进程表
  ├─ terminated : Map[uint32 → *retainedExit]      // 【2026.30 新增】终态保留缓存（TTL 30s）
  ├─ snapshotMu : sync.RWMutex                     // 【2026.30 新增】与热升级快照互斥
  ├─ defaults   : *execcontext.Defaults
  ├─ cgroupManager   : cgroups.Manager
  ├─ workloadFreezer : *cgroups.WorkloadFreezer    // 【2026.30 新增】与 HTTP API 共用一个锁
  ├─ handoverMaxWait : time.Duration               // 【2026.30 新增】= cgroups.HandoverMaxWait
  └─ Handle(server) → server.Mount("/process.v1.Process/", NewProcessHandler(...))
```

> ⚠️ `snapshotMu` 的读锁在 **fork 之前** 就拿住，一直持到 `processes.Store` 完成。否则热升级在 `Upgrade` 拿写锁做快照时，可能刚好有一个"已经 fork 出来但还没登记"的子进程——它会活过 `execve`，却没有任何 handler 接管，既连不上也收不了尸。

`getProcess(selector)` 用 `oneof` 分派到 map 查 pid 或遍历 map 查 tag。

### 5.2 单进程 `Handler`（`handler/handler.go`）

每个进程一个 `Handler`，关键字段：

```go
type Handler struct {
    Config *rpc.ProcessConfig
    logger *zerolog.Logger
    Tag    *string
    cmd    *exec.Cmd
    tty    *os.File                    // PTY master fd
    cancel context.CancelFunc
    outCtx context.Context
    outCancel context.CancelFunc
    stdinMu sync.Mutex
    stdin   io.WriteCloser

    stdoutBytes, stderrBytes, ptyBytes atomic.Int64  // 累计输出字节

    DataEvent *MultiplexedChannel[rpc.ProcessEvent_Data]
    EndEvent  *MultiplexedChannel[rpc.ProcessEvent_End]

    // --- 【2026.30 新增】live-upgrade handover ---
    pid       uint32                 // Start 时就记下来，cmd 为 nil（re-adopted）时仍可查
    cgType    cgroups.ProcessType    // 子进程所在的 cgroup 类型
    readopted bool                   // 是否由新镜像重新认领
    stdoutF, stderrF, stdinF *os.File // 原始 pipe fd，跨 execve 交接
    deadlineMu sync.Mutex
    deadline   time.Time             // 进程超时 deadline（零值 = 无超时）
    readoptTimeout time.Duration     // 跨升级携带的剩余超时
    thawed     chan struct{}         // 解冻信号，carried kill-timer 等它
    OnExit     func(*rpc.ProcessEvent_EndEvent)  // 退出回调，供保留缓存使用
}
```

新增方法：`CgType()`、`Deadline()`、`setDeadline()`、`HandoverFds()`；`Pid()` 在 `cmd == nil` 时回落到保存的 `p.pid`；`SendSignal` 在 `cmd == nil` 时走 `syscall.Kill(int(p.pid), signal)`。

构造时的关键步骤（`New(...)`）：

1. **OOM 防护包装**：
   ```go
   niceDelta := defaultNice - currentNice()
   oomWrapperScript := fmt.Sprintf(
       `echo %d > /proc/$$/oom_score_adj && exec %s"${@}"`,
       defaultOomScore,
       ioniceNicePrefix(defaultIoClass, defaultIoPrio, niceDelta, exec.LookPath))
   cmd := exec.CommandContext(ctx, "/bin/sh", "-c", wrapperArgs...)
   ```
   实际进程用 `sh -c '... exec ...'` 启动，**在子进程入口处**：
   - 设 `oom_score_adj=100`（OOM-killer 优先选它而不是 envd 本身）
   - `ionice -c 2 -n 4`：best-effort IO 调度类、优先级 4（低）
   - `nice -n 0`：归一化 nice

   > ⚠️ 2026.30 起 `ionice` / `nice` 的**绝对路径不再写死**：`ioniceNicePrefix`（`handler.go:173`）用 `exec.LookPath` 找二进制，找不到就**整段省略**。之前的写死 `/usr/bin/ionice` 在 Alpine、UBI 这类精简/非标准镜像里不存在，会让包装脚本直接以 127 退出——用户命令根本没跑。现在这些镜像只是失去 IO/nice 调优，命令照常执行。

2. **UID/GID 切换**：
   ```go
   cmd.SysProcAttr = &syscall.SysProcAttr{
       Credential: &syscall.Credential{Uid: uid, Gid: gid, Groups: groups},
   }
   ```
   把进程的 uid/gid 设成 `permissions.GetAuthUser(ctx).*user.User` 解析出的值（含 supplementary groups）。

3. **cgroup fd 注入**：
   ```go
   cgroupFD, ok := cgroupManager.GetFileDescriptor(getProcType(req))
   applyCgroupFD(cmd.SysProcAttr, cgroupFD, ok)
   ```
   把 cgroup 路径的 fd 通过 `SysProcAttr` 传给 `clone3(CLONE_INTO_CGROUP)`，**子进程一启动就在指定 cgroup**。

4. **CWD 解析**：
   ```go
   resolvedPath, _ := permissions.ExpandAndResolve(req.GetProcess().GetCwd(), user, defaults.Workdir)
   if _, err := os.Stat(resolvedPath); errors.Is(err, os.ErrNotExist) {
       return ..., "cwd does not exist"
   }
   cmd.Dir = resolvedPath
   ```

5. **PTY 申请**（可选）：
   ```go
   tty, tty2, _ := pty.Open()  // master (envd) / slave (child)
   cmd.Slave = tty2
   ```
   如果 `req.PTY != nil`，`tty` 是 master，挂在子进程的 stdin/stdout/stderr 上，envd 通过 `tty` 写输入 / 读合并输出（pty 模式不分 stdout/stderr）。

### 5.3 流式事件多路复用 `MultiplexedChannel[T]`

```go
type MultiplexedChannel[T any] struct {
    Source chan T
    mu       sync.RWMutex
    channels []*subscriber[T]   // 所有订阅者
    exited   atomic.Bool
}
type subscriber[T any] struct {
    ch   chan T
    done chan struct{}
    once sync.Once
}
```

`Fork()` 注册一个订阅者，拿到一个独立的接收 channel。`run()` 协程从 `Source` 读，每个值扇出到所有未 cancelled 的订阅者。

- **慢消费者不会卡住生产**：扇出用 `select { case sub.ch <- v: case <-sub.done: }`。
- **订阅者取消幂等**：`sync.Once` 保护 `close(done)`。
- **关闭顺序**：`Source` 关闭 → `run` 退出 → 加锁 `cancel` 所有订阅者 + `close` 它们的 `ch` → 触发上层 `for range` 自然退出。
- **双检 exited**：`Fork` 快路径后必须重检（防止在 `Fork` 进入锁前 `run` 已经退出）。

被 `Start` 用法：

```go
start, startCancel := startMultiplexer.Fork()  // 一份给 Start 推 start 事件
data,   dataCancel   := proc.DataEvent.Fork()  // 一份给 Start 推 stdout/stderr/pty
end,    endCancel    := proc.EndEvent.Fork()   // 一份给 Start 推 exit
defer { startCancel(); dataCancel(); endCancel() }
```

虽然 Start 看起来"独占"了三个 channel，但用 MultiplexedChannel 而不是裸 chan 是为了将来 Connect 也能挂上同一进程的事件流。

### 5.4 `Start` 时序

```
SDK                  envd Service.Start         process.Handler
 │                        │                          │
 │ StartRequest{cmd,pty,tag,stdin}                  │
 │ ──────────────────────►│                          │
 │                        │ snapshotMu.RLock()   ← 【2026.30】先上锁再 fork
 │                        │ determineTimeoutFromHeader("Connect-Timeout-Ms")
 │                        │ handler.New(...)
 │                        │ ─────────────────────────►│
 │                        │                           ├─ oom-wrapper 构造
 │                        │                           ├─ cgroupFD 准备
 │                        │                           ├─ cred.Uid/Gid 设置
 │                        │                           ├─ CWD resolve
 │                        │                           └─ DataEvent/EndEvent 准备
 │                        │ ◄── *Handler ─────────────│
 │                        │ proc.OnExit = finalizeTermination  ← 【2026.30】
 │                        │ NewMultiplexedChannel[Start]
 │                        │ proc.Start(requestTimeout)
 │                        │ ─────────────────────────►│
 │                        │                           ├─ (PTY: pty.Start)
 │                        │                           ├─ exec.Command.Start
 │                        │                           └─ goroutine: copy cmd.Stdout/Stderr → DataEvent
 │                        │ 失败 → StartErrorCode(err) 映射错误码  ← 【2026.30】
 │ ◄── StartResponse{Start{pid: N}} ────│
 │                        │ s.processes.Store(N, proc); s.terminated.Delete(N)
 │                        │ snapshotMu.RUnlock()
 │                        │ start <- StartEvent{pid:N}    // bootstrap startMultiplexer
 │                        │                              │
 │ for {                  │                              │
 │   ← StartResponse{Data{stdout|stderr|pty}}            │
 │   ← StartResponse{KeepAlive}                          │
 │ }                    │                              │
 │ process exits        │                              │
 │ ◄── StartResponse{End{exit_code, status, error}} ───│
 │                        │ finalizeTermination → terminated.Store(pid, ...) 保留 30s
 │                        │（回收 goroutine 不再直接从 processes 里删）
```

> 注意：`proc.Start` 内部还做 `pty.InheritSize`、把 master fd 包装成 `*os.File` 存到 `Handler.tty`。
>
> ⚠️ 2026.30 起**回收 goroutine 不再负责从 `processes` 里删除表项**——删除改由 `finalizeTermination` 在 `OnExit` 回调里做，同时把终态写进 `terminated` 缓存。这样"从活跃表移除"和"终态可被查询"是一个原子动作，不会出现既不在活跃表、也查不到退出码的空窗。`terminated` 用 `CompareAndDelete(pid, old)` 清理，避免 pid 复用后误删新进程的记录。

### 5.5 输入侧

`SendInput`（unary）单次发；`StreamInput`（client stream）持续发：

```go
switch req.GetEvent().(type) {
case *rpc.StreamInputRequest_Start:  // 绑定 process selector
case *rpc.StreamInputRequest_Data:    // 实际数据
case *rpc.StreamInputRequest_Keepalive:
}
```

`StreamInput` 用 client stream 是为了 **保证多帧输入的顺序**——HTTP/2 多路复用下，多个 unary 不能保证先后。

`CloseStdin` 关闭子进程 stdin pipe，**对 PTY 进程无效**（PTY 没单独的 stdin pipe，EOF 用 `Ctrl+D` 0x04 写进 tty 实现）。

### 5.6 Keepalive

服务端 `Start` 在 Data 流中插入 `KeepAlive` 帧：

```go
case <-keepaliveTicker.C:
    stream.Send(&StartResponse{Event: &ProcessEvent{Event: &ProcessEvent_Keepalive{}}})
```

间隔由客户端通过 `Keepalive-Ping-Interval` header 指定（默认 90s）。`getKeepAliveTicker` 同时返回一个 `resetKeepalive()` 闭包，**每次发 Data 帧时调用重置 ticker**——保持有数据流动时不发空心跳，连接静默时才发。

## 6. 文件系统服务（`internal/services/filesystem/`）

`Service` 是个轻量包装：

```go
type Service struct {
    logger   *zerolog.Logger
    watchers *utils.Map[string, *FileWatcher]   // 内部 watcher 表
    defaults *execcontext.Defaults
    watchersMu *sync.Mutex                       // 【2026.30 新增】
}
```

`Handle(mux, ...)` 把 service 注册到 `/filesystem.v1.Filesystem/`，并接 `legacy.Convert()` interceptor 兼容老 SDK。

> ⚠️ 2026.30 起 `Handle` **返回 `Service`**（2026.29 无返回值），`Service` 增加 `watchersMu *sync.Mutex`，`CreateWatcher` / `RemoveWatcher` / `GetWatcherEvents` 都要先拿它。原因是热升级要导出一份"活跃 watcher 集合"的一致性快照——没有这把锁，导出可能撞上并发的创建/删除。
>
> 同时 `FileWatcher` 增加了 `WatchPath` / `Recursive` / `IncludeEntryInfo` 三个字段：交接时必须按元数据**重新武装** fsnotify，而不是搬 inotify fd（`watch_handover.go` 的 `ExportWatchers` / `ExportWatchersHold` / `ImportWatchers`）。

### 6.1 普通文件操作

- `Stat(path)` → `EntryInfo`（含 symlink_target、modified_time）。
- `MakeDir(path)` → 用 `os.MkdirAll` 递归建 + chown 到调用方 uid/gid。
- `ListDir(path, depth)` → 递归 BFS，构造 `[]EntryInfo`。
- `Move(source, destination)` → 跨目录 rename。
- `Remove(path)` → `os.RemoveAll`（含目录）。

所有路径先过 `permissions.ExpandAndResolve(path, user, defaults.Workdir)`：
1. 补 `~` 为 homedir
2. 相对路径 → homedir 为根
3. `filepath.Abs` 解析 `..` 等

### 6.2 文件监听两套接口

**流式版本** `WatchDir(path, recursive) returns stream WatchDirResponse`：
- 服务端 `fsnotify` 监听目录。
- 每个事件 → `FilesystemEvent{name, type}` 推流。
- 客户端断开 → `fw.Close()` 调 `fsnotify.Watcher.Close()`。

**轮询版本** `CreateWatcher` / `GetWatcherEvents` / `RemoveWatcher`：
- `CreateWatcher` → 返回 `watcher_id`（前缀 `w` + 随机 ID），同时启动 fsnotify goroutine 把事件累积到 `FileWatcher.Events` 切片。
- `GetWatcherEvents` → 取走并清空切片（drain 模式）。
- `RemoveWatcher` → 停 fsnotify、删除表项。

> 拒绝监控网络挂载点：`IsPathOnNetworkMount(watchPath)` 命中则 400 错误。

## 7. MMDS 与元数据获取（`internal/host/mmds.go`）

### 7.1 什么是 MMDS

Firecracker 把 **VM 级别的元数据**（sandbox ID、template ID、access token hash、log collector 地址）通过 **MMDS**（Microvm Metadata Service）暴露——本质是 VM 内部 `http://169.254.169.254/`，由 host 拦截并响应。envd 启动时 **不知道** 这些信息，所以**主动轮询**。

### 7.2 轮询流程

```go
ticker := time.NewTicker(50 * time.Millisecond)
for {
    select {
    case <-ctx.Done():
        return
    case <-ticker.C:
        token, _ := getMMDSToken(ctx, client)        // PUT /latest/api/token, X-metadata-token-ttl-seconds: 60
        opts, _ := getMMDSOpts(ctx, client, token)   // GET /, X-metadata-token: <token>
        // opts: {instanceID, envID, address, accessTokenHash}
        envVars.Store("E2B_SANDBOX_ID", opts.SandboxID)
        envVars.Store("E2B_TEMPLATE_ID", opts.TemplateID)
        os.WriteFile("/run/e2b/.E2B_SANDBOX_ID", ...)
        os.WriteFile("/run/e2b/.E2B_TEMPLATE_ID", ...)
        if opts.LogsCollectorAddress != "" {
            mmdsChan <- opts    // 通知 logs 包
        }
        return  // 拿到一次就退出
    }
}
```

- **50ms 一次**直到成功（Firecracker 启动早期 MMDS 可能没准备好）。
- **HTTP client 关闭 keepalive** + **10s 超时**——MMDS 不可用时不卡住。
- **持久化到 `/run/e2b/`** + **写进 EnvVars**——其他模块（cgroup 命名、host 文件等）从这两个数据源拿。

### 7.3 MMDS 路由自愈（`mmds_route_linux.go`）

```go
if err := host.PinMMDSRoute(ctx); err != nil {
    // 失败限速：10 秒最多警告 1 次
}
```

- VM 内 `169.254.169.254` 必须走到 host 的 MMDS 端点，**不能**被用户态的 PREROUTING/OUTPUT 规则劫持。
- envd 在 init 时往 `iptables nat` 表的 PREROUTING/OUTPUT 链 `position 1` 钉死 RETURN 规则。
- 如果检测到 MMDS 调用失败（iptables 已被用户改），**重新 pin 一次**。失败日志用 `ratelimit.New(10s)` 限速避免刷屏。

## 8. cgroup 资源管控（`internal/services/cgroups/`）

### 8.1 四种进程类型

```go
const (
    ProcessTypePTY    ProcessType = "pty"
    ProcessTypeUser   ProcessType = "user"
    ProcessTypeSocat  ProcessType = "socat"
    // ProcessTypeSystem 留在 envd 的根 cgroup，所以不受 freeze 影响。
    ProcessTypeSystem ProcessType = "system"
)
```

> ⓘ 2026.29 时这几个常量是 `"PTY"` / `"User"` / `"Socat"`（首字母大写），2026.30 全部改成小写，并显式补上 `ProcessTypeSystem`。这些字符串会写进 proto 的 `HandoverProc.cg_type`，所以大小写是跨版本契约的一部分。

每种类型对应不同 cgroup 资源限额（见 `main.go` 的 `opts`）：

| ProcessType | cpu.weight | io.weight | memory.high/max | memory.min/low |
| --- | --- | --- | --- | --- |
| **pty** | 200 | default 50 | memoryMax = `MemTotal - min(MemTotal/8, 128MB)` | — |
| **socat**（端口转发） | 150 | default 50 | — | 5MB / 8MB |
| **user**（用户进程） | 50 | default 10 | 与 pty 相同 | — |

要点：
- **pty 比 user 优先级高**：交互式命令响应优先于后台计算。
- **socat 拿 memory.low 8MB 保护**：端口转发不能饿死。
- **`memory.high = memory.max`**：避免 throttle 长时间延迟，触发直接 OOM-kill。
- **`MaxMemoryReserved = min(MemTotal/8, 128MB)`**：给 host kernel 留 buffer。
- 2026.30 新增 `memory.go`：`ReadMemoryProtection` 读回 `memory.max` / `memory.high` / `memory.min` / `memory.low`，经 `/init` 的 `X-Envd-Memory` 头回给 orchestrator，让 host 侧知道 guest 实际生效的保护值（而不是只知道自己写下去的配置）。

### 8.2 实现机制

```go
fd, _ := unix.Open(fullPath, unix.O_RDONLY, 0)
```

- 用 `clone3(CLONE_INTO_CGROUP)` 需要一个 cgroup 目录的 fd。
- envd 启动时**提前打开**三个 cgroup 目录的 fd（在 main 里），存到 `Cgroup2Manager.cgroupFDs`。
- `Handler.New` 时调 `cgroupManager.GetFileDescriptor(getProcType(req))` 取出对应 fd 喂给 `cmd.SysProcAttr`。
- 2026.30 起 `Cgroup2Manager` 还实现了 `PathManager`（`Root` / `PathOf` / `ChildrenOf` / `FreezeAt` / `UnfreezeAt` / `FrozenAt` / `FreezeRequestedAt`），让层级遍历能按**绝对路径**操作那些不属于任何 `ProcessType` 的 cgroup。
  > ⚠️ `Root()` 返回 `filepath.Clean(rootPath)`。因为 `filepath.Rel` 是纯文本运算，配置里多一个尾斜杠或 `.` 就会让"相对位置判定"全部落空——allowlist 会把所有路径都归为"未知"。清理放在这里，而不是依赖调用方怎么拼这个路径。

### 8.3 `Freeze` / `Unfreeze`（单点接口，仍然保留）

```go
func (c Cgroup2Manager) Freeze(procType ProcessType) error   { return c.setFreezeState(procType, "1") }
func (c Cgroup2Manager) Unfreeze(procType ProcessType) error { return c.setFreezeState(procType, "0") }

func (c Cgroup2Manager) setFreezeState(procType ProcessType, value string) error {
    return writeCgroupProp(filepath.Join(path, "cgroup.freeze"), value)
}

// Frozen 读的是 cgroup.events 的 frozen 字段（已落定状态），不是 cgroup.freeze。
func (c Cgroup2Manager) Frozen(procType ProcessType) (bool, error)
```

> ⚠️ **写 `cgroup.freeze` 只是"请求"冻结**。内核在每个任务的下一个信号投递点才真正停它，所以处于不可中断等待的任务会继续 runnable 直到那个等待返回。需要"workload 确实停了"的调用方必须轮询 `Frozen`，不能假设写完就完事。
>
> 另外 `Frozen` 报的是**状态**，不是"我们那次写有没有生效"：guest 自己冻结的 cgroup 读出来同样是 frozen。
>
> `ErrFrozenUnobservable` 是第三种答案：manager 根本没有 cgroup 可读（no-op manager / 非 Linux stub）。它和 `(false, nil)`（"这个 cgroup 存在且还没冻结"）**刻意区分**——前者没有可等的对象，调用方不该为它烧掉等待预算。

### 8.4 【2026.30 新增】`WorkloadFreezer`：层级化 freeze / thaw

文件：`internal/services/cgroups/freeze.go`（1270 行）

2026.29 的 freeze 只覆盖 envd 自己创建的两三个 cgroup（`user` / `ptys`），而**用户 workload 的子孙 cgroup**（容器运行时、嵌套服务自己建的）完全没被冻——snapshot 出来就是不一致的。2026.30 改成按 **cgroup 树**操作：

```go
type FreezeMode string

const (
    ModeLegacy    FreezeMode = "legacy"     // 只冻 envd 自己的静态 cgroup
    ModeHierarchy FreezeMode = "hierarchy"  // 沿 cgroup 树遍历
)
```

关键设计：

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `WorkloadProcessTypes` | `freeze.go:18` | 参与冻结的静态类型（`user` + `pty`） |
| `livenessAllowlist` | `hierarchy.go:46` | 永不冻结：`init.scope`、`systemd-journald.service`、`rpcbind.service`、`rpcbind.socket`、`rpc-statd.service`、`socats` |
| `AncestorChain` / `DescendSet` | `hierarchy.go:95` / `134` | 遍历时冻结的是"envd 祖先链的补集"；allowlist 项的**祖先**也要进 `DescendSet`，因为冻结是层级生效的 |
| `freezePollInterval = 2ms` | `freeze.go:133` | settle 轮询间隔 |
| `DefaultFreezeMaxCgroups = 512` / `DefaultThawMaxCgroups = 8192` | `freeze.go:92` / `80` | 遍历上限，超了记 `Truncated` |
| `DefaultThawWatchdogWindow = 10 * time.Minute` | `freeze.go:64` | 一次 freeze 之后迟迟没有 thaw 时的兜底解冻 |
| `HandoverMaxWait = 2 * time.Second` | `freeze.go:143` | 热升级前等 workload 静止的预算 |

> ⚠️ **冻结是层级生效的**，这是最容易搞错的一点：冻结一个 cgroup 会连带冻结它的全部子孙，但**不会**影响它的祖先。所以"不冻 systemd-journald"这个要求，实际表达成"把 journald 的祖先链排除在遍历之外"，而不是简单地跳过 journald 一个目录。
>
> ⚠️ **thaw 用的是 `cgroup.freeze` 而不是 `cgroup.events`**。`cgroup.events` 的 `frozen=1` 在"只有祖先被冻"时也会为真，照它逐个解冻既错误（祖先还锁着）又徒劳。`cgroup.freeze` 读回来的是"谁在这里写过冻结"，正好是需要撤销的那个集合。

`FreezeResult` 的字段把一次遍历的完整账目摊开：

```go
type FreezeResult struct {
    Mode           FreezeMode
    Requested      int  // 写了 cgroup.freeze=1 的
    Frozen         int  // 轮询确认已落定的
    NotFrozen      int  // 请求了但没落定
    PreFrozen      int  // 我们动手前就已经是冻结的
    Failed         int  // 确实失败（不含 vanished）
    Vanished       int  // 遍历期间被移除的
    VanishedPaths  []string
    Unobservable   int
    ScanFailed     int
    Visited        int
    Allowlisted    int
    Truncated      bool
    SweepDuration  time.Duration
    WaitDuration   time.Duration
}
```

`AllFrozen()` 的定义是 `NotFrozen == 0 && Failed == 0`——**刻意不看 `Vanished`**：一个在遍历中途被移除的 cgroup 已经不构成"还在跑的 workload"，把它算成失败会让 orchestrator 无谓地放弃一次本来可以成功的 pause。

`ThawResult` 对称：`Visited` / `Thawed` / `Failed` / `Truncated` / `Preserved`（guest 自己冻的，跳过）/ `Discovered`。

`vanished(err)` 只认 **`ENOENT` 与 `ENODEV`** 两个 errno：

```
remove, then open           -> ENOENT
open, then remove, then use -> ENODEV
```

第二个是 cgroupfs 特有的（普通文件 unlink 后仍可读），所以这个判定没法在 tmpfs 上复现。刻意不写成"任何 error"——`Failed` 是有人要据此决策的计数，宽到能吞掉 vanished 的谓词也会吞掉真正的失败。

### 8.5 【2026.30 新增】guest 自己冻结的 cgroup

`GuestFrozenPaths` / `SetGuestFrozenPaths`（`freeze.go:877` / `903`）与 `ScanGuestFrozen`（`hierarchy.go:423`）记录"在 envd 动手之前就已经被 guest 冻上的 cgroup"。典型场景是容器运行时用 `cgroup.freeze` 实现 `docker pause`。

resume 时 thaw **必须跳过**这些——把它们解冻等于把用户刻意挂起的进程重新跑起来。这份记录会随 `HandoverState.guest_frozen_cgroups` 跨热升级传递（因为记录它的进程镜像可能已经被换掉了）。

> ⚠️ 记录丢失时的降级方向是"**宁可多解冻**"：`guest_frozen_cgroups` 缺失或为空时，thaw 会清掉它看到的一切冻结状态。宁可让一个本该暂停的容器恢复运行，也不能让整个 guest 卡在冻结里。

### 8.6 【2026.30 新增】thaw watchdog

`SetThawWatchdog(window, cb)`（`freeze.go:219`）武装一个看门狗：一次 freeze 之后如果窗口内没有等到对应的 thaw（比如 pause 流程在中途失败），watchdog 会主动解冻并回调。`armWatchdog` / `disarmWatchdog` / `thawForWatchdog` 分别是武装、解除、兜底解冻。

热升级路径上还有第二层兜底：新镜像启动后武装一个 `handoverFallbackThawTimeout = 60 * time.Second`（`main.go:47`）的定时器，如果 orchestrator 的 `/init` 一直没来，就主动解冻，避免升级失败把 sandbox 冻死。

### 8.7 `freezeLock` 去哪了

> ⛔ 2026.29 的 `API.freezeLock`（`semaphore.Weighted(1)`）与 `API.cgroupManager` 字段在 2026.30 被删除。串行化改由 `WorkloadFreezer` 内部的锁承担，且它与 `process.Service` **共用同一个实例**（`process.Service.workloadFreezer`），所以"热升级前的冻结"和"pause 前的冻结"不会互相插队。
>
> ⛔ `internal/api/init.go` 的 `userCgroupsToFreeze` 变量也一并删除——冻结范围不再是硬编码的两个类型，而由遍历决定。

## 9. 自动端口转发（`internal/port/`）

### 9.1 为什么需要它

E2B VM 内网络：
- `eth0` IP 是 `169.254.0.21`（gateway 模式）
- 用户进程监听 `127.0.0.1:<port>`（loopback，VM 内部可达）
- **从 VM 外部想访问这个端口**——需要 socat 把 eth0:port 转到 127.0.0.1:port

### 9.2 扫描器

```go
ticker := time.NewTicker(s.period)
defer ticker.Stop()

for {
    processes, _ := net.Connections("tcp")        // gopsutil
    for _, sub := range s.subs.Items() {
        // 传 scanExit，让"停止消费的订阅者"不能把本循环永久停在 send 上
        sub.Signal(processes, s.scanExit)
    }
    select {
    case <-s.scanExit: return
    case <-ticker.C:
    }
}
```

- 1s 周期扫一次 LISTEN socket（`net.Connections("tcp")`）。
- pub-sub：所有 `ScannerSubscriber` 都收到同一份连接列表。
- **Filter**：`IPs in [127.0.0.1, localhost, ::1]` + `State == LISTEN`。

> ⓘ 2026.29 这里用的是 `time.Sleep(s.period)` + `select { case <-s.scanExit: ... default: }`，**shutdown 时最多要等满一个周期**（0.6.11 的修复项）。2026.30 改成 `time.NewTicker` + `select`，`Destroy()` 关掉 `scanExit` 后立刻返回。
>
> ⛔ `Scanner.Processes` channel 与 `Unsubscribe` 方法在 2026.30 被删除；`AddSubscriber(id, filter)` 不再接收 logger 参数。`ScannerSubscriber` 也去掉了 `ID()` / `Destroy()`，`Signal(proc, exit)` 增加了 `exit` 分支——`Messages` 是无缓冲 channel，没有这个分支的话，接收方一旦停止消费，扫描循环就会永久阻塞在 send 上。

### 9.3 转发器

```go
cmd := exec.CommandContext(ctx, "socat", "-d", "-d", "-d",
    fmt.Sprintf("TCP4-LISTEN:%v,bind=%s,reuseaddr,fork", p.port, "169.254.0.21"),
    fmt.Sprintf("TCP%d:localhost:%v", p.family, p.port),
)
```

- 每次发现新监听端口，spawn 一个 socat。
- socat 进程放在 `ProcessTypeSocat` cgroup 里（拿 memory.low 8MB 保护）。
- 增量算法：
  - 每次扫描时把所有 `ports[key]` 标 `DELETE`。
  - 当前还在 LISTEN 的 → 标 `FORWARD`（保留 socat）。
  - 扫描结束后仍是 `DELETE` 的 → kill。
- 旧端口复用：`pid + port` 作 key；socat 已存在则只更新状态。

> ⚠️ 2026.30 起 `PortToForward` 多了一个 `socatPid`（`socatPID()`，`forward.go:49`），`Forwarder` 多了 `mu sync.Mutex`。停止转发时按**记录下来的 pid** 精确回收 socat（`forward_reap_linux.go`），而不是按进程组盲杀——后者在热升级之后可能误伤被新镜像认领过的进程。
>
> 同时新增 `ExportForwards()` / `ExportForwardsHold()` / `ImportForwards(forwards)`：热升级时把活跃 socat 集合序列化进 `HandoverState.forwards`，新镜像按 `socat_pid` **重新认领**已经在跑的子进程，而不是再 spawn 一个重复的 listener。

## 10. 认证与权限（`internal/permissions/`）

### 10.1 Basic Auth 解析

`AuthenticateUsername`：

```go
username, _, ok := req.BasicAuth()
if !ok { return nil, nil }  // 没传不报错,后续 GetAuthUser 兜底
u, _ := user.Lookup(username)  // 走 /etc/passwd
return u, nil
```

`authn.Middleware` 把 `*user.User` 塞进 ctx 上下文。

`GetAuthUser` 兜底：

```go
u, ok := authn.GetInfo(ctx).(*user.User)
if !ok {
    username, _ := execcontext.ResolveDefaultUsername(nil, defaultUser)
    u, _ = user.Lookup(username)  // 用 defaults.User（root）
}
```

### 10.2 Access Token 与签名（`api/auth.go`）

`SecureToken` 用 `memguard` 把 token 存在加密的内存区里：

```go
type SecureToken struct {
    buffer *memguard.LockedBuffer
}
func (t *SecureToken) Destroy()  // wipe
func (t *SecureToken) TakeFrom(other *SecureToken)  // 移交所有权
func (t *SecureToken) Equals(other string) bool      // 短时间对比,避免长时间持有明文
```

`WithAuthorization` middleware：

```go
if a.accessToken.IsSet() {
    authHeader := req.Header.Get("X-Access-Token")
    if !a.accessToken.Equals(authHeader) && !allowedPath {
        return 401
    }
}
```

`authExcludedPaths` 列出 **不需要 token 就能访问的端点**：`/health`、`GET /files`、`POST /files`、`POST /init`（`/init` 走 MMDS hash 校验而非 token）。

> ⚠️ 2026.30 起 `WithAuthorization` 从"先查排除表、再比 token"改成 `switch`，并在**热升级后的初始化窗口内 fail closed**：
>
> ```go
> var handoverPreInitAllowedPaths = map[string]struct{}{"GET/health": {}, "POST/init": {}}
>
> if a.handover != nil && !a.initialized.Load() {
>     if _, ok := handoverPreInitAllowedPaths[r.Method+"/"+r.URL.Path]; !ok {
>         jsonError(w, "envd not initialized", http.StatusUnauthorized)
>         return
>     }
> }
> ```
>
> 新镜像的 token 是从 handover blob 或 orchestrator 的 `/init` 里拿的，在拿到之前它**没有可信身份**。这个窗口里除了 `/health` 和 `/init`，其他一律 401——注意 **`/files` 也不放行**（它在常规 `authExcludedPaths` 里是豁免的）。`initialized` 是在 `PostInit` 完成 `SetData` **之后**才置位的。

### 10.3 路径签名

`/files` 系列端点支持 **URL 签名**（避免 long-lived token 出现在 URL）：

```
GET /files?path=foo.txt&username=alice&signature=v1_<sha256>&signature_expiration=1234567890
```

校验逻辑（`validateSigning`）：

```
if accessToken.IsSet() == false  → skip
if X-Access-Token header present  → 校验 token (等同 WithAuthorization)
else:
  signature = v1_sha256(path + ":" + op + ":" + username + ":" + token + ":" + expiration)
  对比签名 + 检查 expiration
```

`generateSignature` 用 `keys.NewSHA256Hashing()`，结果用 `v1_` 前缀（暗示 v1 协议）。

### 10.4 `/init` MMDS hash 校验（`api/init.go`）

`validateInitAccessToken` 三态校验：

```go
switch {
case matchesMMDS:                            return nil
case !a.accessToken.IsSet() && !mmdsExists:  return nil   // 首次设置
case !requestTokenSet:                        return ErrAccessTokenResetNotAuthorized
default:                                      return ErrAccessTokenMismatch
}
```

- **MMDS hash == hash(token)**：合法 init。
- **MMDS hash == hash("")**（orchestrator 显式给空 token 授权）：允许重置。
- **MMDS hash == ""**：未配置 MMDS → 拒绝除首次外的所有 init。

> 这是**关键安全门**：任何持有 `X-Access-Token` 但不知道 MMDS hash 的客户端，**无法重置** envd 的 access token（无法发起 init）。

## 11. `/init` 端点（`api/init.go`）

orchestrator 在 sandbox 启动时 POST 大量配置到 envd：

```go
type PostInitJSONBody struct {
    AccessToken      *SecureToken
    EnvVars          *map[string]string
    Timestamp        *time.Time         // 系统时间同步
    DefaultUser      *string
    DefaultWorkdir   *string
    CaBundle         *string            // PEM CA 证书
    HyperloopIP      *string            // events 服务的 IP
    VolumeMounts     *[]VolumeMount     // NFS 卷
    LifecycleID      *string            // 用于 NFS 重复挂载判断
}
```

`SetData` 处理流程：

1. **系统时间同步**（`setSystemTime`）——把 VM 时钟拨到 `data.Timestamp`。用 `clock_linux.go`（`settimeofday` syscall）vs `clock_other.go`（stub）。
2. **设置 env vars** → 替换 `defaults.EnvVars`。
3. **设置 access token** → `accessToken.TakeFrom(data.AccessToken)`（**所有权转移**，避免原对象 Destroy 时清空）。
4. **设置 default user / workdir**。
5. **安装 CA 证书** → `caCertInstaller.Install`（写到 `/usr/local/share/ca-certificates/` 然后跑 `update-ca-certificates`）。
6. **挂载 NFS 卷** → 见 §12。
7. **设置 Hyperloop hosts** → `events.e2b.local` 写到 `/etc/hosts`。

最后 **defer 一次 thaw**——保证每次 init 都会解冻（即使 SetData 失败）。2026.30 起这不再是"逐个 `ProcessType` 调 `Unfreeze`"，而是走 `workloadFreezer.Unfreeze`，因此会沿 cgroup 树把 guest 之外的一切冻结状态清掉，并保留 `guest_frozen_cgroups` 里记的那些。

并发控制：
- `initLock semaphore.Weighted(1)`：init 全局串行（orchestrator 的 retry loop 会重发）。
- `lastSetTime utils.AtomicMax`：记录最后应用过的 timestamp，**只接受时间戳严格递增的 init**（防 replay）。
- **每个 init 都会执行 thaw**，即使 init 数据被 timestamp 拒绝——这样 pause→resume 后不需要额外调 unfreeze。

### 11.1 【2026.30 新增】`/init` 的五个诊断响应头

`PostInit` 在写 204 之前会把 envd 自己的运行时判断回给 orchestrator：

| 响应头 | 常量 | 内容 |
| --- | --- | --- |
| `X-Envd-Version` | — | `pkg.Version`（当前二进制版本） |
| `X-Envd-Handover` | — | 本次是不是热升级后的第一次 `/init`，以及交接结果（`handoverResult` 的 JSON：`failed` / `procs` / `procs_failed` / `retained` / `retained_failed` / `watchers` / `watchers_failed`） |
| `X-Envd-Freeze-Audit` | `freezeAuditHeader`（`init.go:126`） | `auditFrozenSet` 沿 cgroup 树采样到的仍被冻结的路径 |
| `X-Envd-Defaults` | `defaultsHeader`（`init.go:147`） | `reportEffectiveDefaults`：实际生效的默认 user / workdir |
| `X-Envd-Memory` | `memoryHeader`（`init.go:176`） | `reportMemoryProtection`：cgroup 上实际生效的 `memory.max` / `high` / `min` / `low` |

> ⚠️ `SetData` 现在还会把 `a.defaults.UserDelivered = true`。这个字段是**来源标记**而不是值比较——它回答的是"orchestrator 到底有没有把默认用户发过来过"，因为空串和"没发"在值上无法区分。热升级后新镜像如果发现 orchestrator 没补发，就沿用 blob 里的 `HandoverDefaults`。
>
> ⚠️ 2026.30 起 pause 前会**先 flush 日志再冻结**：`PostFreeze` 调 `logFlusher.FlushAndPurge(ctx)`，把还在内存里的日志行推到 collector 之后才冻 cgroup。否则 snapshot 里的日志缓冲会连同 workload 一起被冻住，直到 resume 才可能发出去（甚至丢失）。`api/store.go` 为此新增了 `LogFlusher` 接口与 `NewNoopLogFlusher()`。

## 12. NFS 卷挂载（`api/init.go`）

```
mount -v -t nfs -o fg,hard,sync,rsize=1048576,wsize=1048576,mountproto=tcp,mountport=2049,proto=tcp,port=2049,nfsvers=3,noacl,noac,lookupcache=none <target> <path>
```

挂载选项（`nfsOptions` 常量）：
- `rsize/wsize=1MB`：大块 IO
- `noac, lookupcache=none`：**禁用客户端缓存**，确保 pause→resume 切换 lifecycle 时数据一致
- `nfsvers=3`：NFS v3（v4 引入了状态机，pause/resume 复杂）
- `fg,hard`：失败重试
- `sync`：写同步（避免 sandbox 突然死掉时数据丢失）

**Lifecycle-aware remount**（`shouldRemountNFS`）：

| 之前 | 现在 | 行为 |
| --- | --- | --- |
| 未挂载 | 任意 | 挂载 |
| `lifecycle_a` | `lifecycle_a` | 跳过（同一 lifecycle 已挂） |
| `lifecycle_a` | `lifecycle_b` | **重新挂载**（pause→resume 后 lifecycle 变了） |
| `lifecycle_a` | `""` | 重新挂载（lifecycle 显式清空） |
| `""` | `""` | 跳过（避免 init 重试循环里无限 mount） |

用 `sync.Map` `mountedPaths` 跟踪 `path → lifecycleID`：

```go
a.mountedPaths.Store(volume.Path, requestLifecycleID)
```

并发：每个 `init` 用 `isMountingNFS atomic.Bool` 抢占，**多 init 不会并发 mount 同一组**。多 volume 间用 `errgroup` 并行。

## 13. 服务端 OpenAPI/JSON 接口（`internal/api/`）

envd 早期是 JSON-HTTP（oapi-codegen 生成），保留向后兼容。Connect/gRPC 是新一代接口。两者共用同一 `API` struct。

### 13.1 端点

spec 文件 `spec/envd.yaml` 在 2026.30 是 649 行（2026.29 为 524 行）。

| 方法 | 路径 | 用途 | 鉴权 | `x-internal` |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | 健康探针 | 公开 | — |
| `GET` | `/metrics` | 资源指标（CPU/Mem/Disk） | token | — |
| `POST` | `/init` | 接收 orchestrator 配置 | **MMDS hash 校验** | ✓ |
| `POST` | `/freeze` | pause 前 freeze cgroup 树 | token | ✓ |
| `POST` | `/unfreeze` | 撤销 freeze | token | ✓ |
| `POST` | `/collapse` | THP 内存整理 | token | ✓ |
| `POST` | `/fsfreeze` | FIFREEZE rootfs | token | ✓ |
| `POST` | `/fsthaw` | FITHAW rootfs | token | ✓ |
| `GET` | `/files` | 下载文件 | token 或签名 | — |
| `POST` | `/files` | 上传文件（multipart 或 raw octet-stream） | token 或签名 | — |
| `POST` | `/files/compose` | 零拷贝拼接 | token | — |
| `GET` | `/envs` | 列环境变量 | token | — |
| `POST` | `/upgrade` | 【2026.30 新增】接收替换用 envd 二进制并原地 `execve` | token | ⚠️ 见下 |

> ⚠️ **`POST /upgrade` 不在 `spec/envd.yaml` 里**。它直接注册在 chi mux 上（`main.go:402`），因此不经过生成的 spec handler，也就**无法用 `x-internal` 标记**。orchestrator 侧只能把它手工列进 `packages/orchestrator/pkg/sandbox/envd/internal_routes.go` 的 `unspecifiedInternalPaths`，否则 sandbox proxy 不会拒绝它——`routes_test.go` 里有一段注释专门记录这个教训："`/upgrade` 就是这样一路跑到生产的"。
>
> 其余 6 条控制面路由的 `x-internal: true` 标记由 `gen_internal_routes.go` 解析 spec 后生成 `internal_routes.gen.go` 的 `specInternalPaths`。新增控制面路由的正确做法是**写进 spec**，而不是往 `unspecifiedInternalPaths` 里加。

### 13.1.1 `POST /freeze` 的参数与返回（2026.30）

```
POST /freeze?mode=hierarchy&maxCgroups=512&maxWaitMs=2000
```

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `mode` | `legacy` / `hierarchy` | 遍历模式；缺省用默认模式 |
| `maxCgroups` | int | 遍历上限 |
| `maxWaitMs` | int64 | 等待 workload 真正静止的预算 |

- **不传 `maxWaitMs`**：保持 2026.29 的语义，返回 `204 No Content`。
- **传了 `maxWaitMs`**：返回 `200` + `FreezeResult` JSON，把 `requested` / `frozen` / `notFrozen` / `failed` / `vanished` / `truncated` 等计数交给调用方。

对应的生成代码：`api.gen.go` 的 `PostFreeze` 签名从 `(w, r)` 变成 `(w, r, params PostFreezeParams)`，新增 `PostFreezeParams{Mode *PostFreezeParamsMode, MaxCgroups *int, MaxWaitMs *int64}` 与 `FreezeResult` model（`api.gen.go:132`）。`api.gen.go` 在 2026.30 是 962 行（2026.29 为 876 行），`ServerInterface` 从行 251 移到行 358。

`PostFiles` 接受两种 Content-Type：
- `multipart/form-data`：每 part 一个文件
- `application/octet-stream`：纯 body 写到 `params.Path`（单文件高效上传）

`GetFiles` 支持 `Accept-Encoding: gzip` 自动 gzip，并保留 `Range` / `If-Modified-Since` / `If-None-Match` / `If-Range` 等 HTTP 缓存语义（gzip 模式下强制 `identity`）。

### 13.2 路径处理一致性

`download.go` / `upload.go` / `compose.go` 都先调 `permissions.ExpandAndResolve`：

```go
resolvedPath, _ := permissions.ExpandAndResolve(path, u, a.defaults.Workdir)
```

→ `~` 展开 → 相对路径以 homedir 为根 → `filepath.Abs` 解析 `..`。
这样无论用户传 `/etc/passwd`、`~/foo.txt`、`../foo.txt` 都得到一致路径。

## 14. 安全令牌存储（`api/secure_token.go`）

`SecureToken` 用 `github.com/awnumar/memguard` 保护内存中的 token：

```go
type SecureToken struct {
    buffer *memguard.LockedBuffer
}
```

- **EncryptedBuffer**：page-locked + 加密，进程 core dump 不会泄露明文。
- **`Destroy()` 抹除**：`memguard.WipeBytes`，使用完立即清理。
- **`TakeFrom(other)` 移交所有权**：避免原对象误销毁。
- **`Equals(s string) bool`**：仅短时间解密对比，不导出明文。
- **`Bytes()` 配合 `defer memguard.WipeBytes`**：调用方负责抹擦。

`/init` 请求 body 也用 `defer memguard.WipeBytes(body)` 抹擦。

## 15. 启动期默认环境（`internal/execcontext/`）

```go
// BuiltinDefaultUser 是编译进来的兜底默认用户。
const BuiltinDefaultUser = "root"

type Defaults struct {
    User    string
    Workdir *string
    EnvVars *utils.EnvVars

    // UserDelivered 记录 orchestrator 是否已经把默认用户发过来过。
    // 这是「来源」标记，不是值比较：空串和「没发过」在值上无法区分。
    UserDelivered bool   // 【2026.30 新增】
}
```

- `User`：默认 `BuiltinDefaultUser`（`"root"`，`/init` 可改）。
- `Workdir`：可空。
- `EnvVars`：内部 map，每次 `Store` 写一次，**用户进程通过 `os.Getenv` 看到**。
- `UserDelivered`：热升级后新镜像判断"要不要沿用 blob 里的 `HandoverDefaults`"的依据。

> ⓘ 2026.29 时默认用户是 `main.go` 里的 `const defaultUser = "root"`，2026.30 删掉了这个常量，改由 `execcontext.BuiltinDefaultUser` 提供。

`ResolveDefaultUsername`、`ResolveDefaultWorkdir` 等工具函数保证 nil/空有合理 fallback。

## 16. 完整调用流

### 16.1 启动 sandbox

```
orchestrator                                       envd (in VM)
   │                                                  │
   │ 1. POST /init {AccessToken, EnvVars, ...}        │
   │ ────────────────────────────────────────────────►│
   │                                                  ├─ validateInitAccessToken
   │                                                  │  (MMDS hash 校验)
   │                                                  ├─ SetData
   │                                                  │  ├─ setSystemTime
   │                                                  │  ├─ EnvVars.ReplaceUserVars
   │                                                  │  ├─ accessToken.TakeFrom
   │                                                  │  ├─ caCertInstaller.Install
   │                                                  │  └─ setupNFS
   │                                                  ├─ defaults.UserDelivered = true
   │                                                  ├─ initialized.Store(true)   ← 关闭 fail-closed 窗口
   │                                                  ├─ defer workloadFreezer.Unfreeze(...)
   │                                                  │  (Background ctx 防止 ctx 取消影响)
   │ ◄──── 204 + X-Envd-Version/Handover/Freeze-Audit/Defaults/Memory ──│
   │                                                  ├─ go PollForMMDSOpts (10s timeout)
```

### 16.2 SDK 跑命令

```
SDK  ─HTTP─► client-proxy ─► orchestrator-proxy ─► envd
                                                    │
                                                    ├─ ProcessService.Start
                                                    │   ├─ determineTimeoutFromHeader
                                                    │   ├─ handler.New
                                                    │   │   ├─ oom wrapper script
                                                    │   │   ├─ cgroupFD (CLONE_INTO_CGROUP)
                                                    │   │   ├─ Uid/Gid/Groups
                                                    │   │   ├─ CWD resolve
                                                    │   │   └─ PTY setup (optional)
                                                    │   ├─ Fork DataEvent/EndEvent
                                                    │   ├─ proc.Start
                                                    │   │   └─ cmd.Start → fork+exec
                                                    │   └─ stream Send(Start{pid})
                                                    │
                                                    ├─ goroutine: copy cmd.Stdout → DataEvent
                                                    ├─ goroutine: copy cmd.Stderr → DataEvent
                                                    └─ keepalive ticker (90s)
```

### 16.3 用户开 8080 端口

```
sdk 启动 python -m http.server 8080
   │ 用户进程 listen 127.0.0.1:8080
   ▼
gopsutil net.Connections("tcp")  ───► Scanner.ScanAndBroadcast (1s 周期)
   │
   ▼
Forwarder.StartForwarding
   │ new key "1234-8080"
   │ spawn socat: TCP4-LISTEN:8080,bind=169.254.0.21,reuseaddr,fork TCP4:localhost:8080
   │   └─ in cgroup "socats"
   ▼
外部 client  ──HTTP──► 169.254.0.21:8080 ──socat──► 127.0.0.1:8080 ──► python
```

### 16.4 【2026.30 新增】在线热升级（handover）

```
orchestrator                        envd (旧镜像)                 envd (新镜像, 同 PID)
   │                                    │                              │
   │ 1. POST /upgrade {new bin}         │                              │
   │ ──────────────────────────────────►│                              │
   │                                    ├─ 写 /usr/bin/envd.next
   │                                    ├─ workloadFreezer.Freeze(user+pty, HandoverMaxWait)
   │                                    ├─ 快照进程表（snapshotMu 写锁）
   │                                    ├─ dup3 搬迁 fd 到 fdBase=200+i*5
   │                                    ├─ 序列化 HandoverState → /run/e2b/envd-handover.pb
   │                                    └─ syscall.Exec(self, ["--resume-handover"])
   │                                                                    │
   │                                                                    ├─ ResumeFromHandover()
   │                                                                    │  ├─ Readopt() 认领子进程 + pidfd 收尸
   │                                                                    │  ├─ ImportWatchers() 重挂 watcher
   │                                                                    │  ├─ ImportMounts() 恢复 mount ledger
   │                                                                    │  ├─ ImportForwards() 认领 socat
   │                                                                    │  └─ SetGuestFrozenPaths()
   │                                                                    ├─ 武装 60s 兜底 thaw
   │ ◄── 200 + handover 结果 ───────────────────────────────────────────│
   │                                                                    │
   │ 2. POST /init（重新下发 user / env / token）                        │
   │ ──────────────────────────────────────────────────────────────────►│
   │                                                                    ├─ 关闭 fail-closed 窗口
   │                                                                    └─ thaw（保留 guest 冻结项）
```

**fd 搬迁**（`internal/services/process/dup3_linux.go`）：`dupKeep` + `dup3` 在 `syscall.ForkLock` 下执行，清掉 CLOEXEC，把每个进程的 stdout/stderr/stdin/tty 固定到 `fdBase + i*5`（`fdBase = 200`，`upgrade.go:98`）。选 200 是因为要高于新 runtime 自己会用到的 fd 号，避免撞车。

**为什么必须是同 PID 的 `execve`**：子进程、socat、NFS mount、listener socket 全都挂在当前进程的 fd table / 进程树上。换一个 PID 就意味着一整套"重新接管"的复杂度，而 `execve` 只换代码段，内核对象原封不动。

## 17. 关键设计要点

1. **Connect/gRPC + JSON-HTTP 双协议**。Connect 走 `process.v1.Process/Start`，JSON-HTTP 走 `/files`。**生成代码统一**（buf → Connect → `services/spec/`）。老 SDK 通过 `legacy.Convert()` 拦截器在 wire 层转换。
2. **multiplexed event channel**。一个进程的 Data/End 事件用 `MultiplexedChannel[T]` fan-out，**支持 `Start` 和 `Connect` 同时挂**。任意消费者断开不会拖死生产者。
3. **OOM 防护移到子进程**。`oom_score_adj=100` + `ionice` + `nice` 全在 `sh -c` wrapper 里做，envd 自己用 nice 0 防止被反噬。
4. **CLONE_INTO_CGROUP**。envd 提前 `unix.Open()` cgroup 目录的 fd，在 `exec.Command` 时通过 `SysProcAttr` 喂给 `clone3(CLONE_INTO_CGROUP)`，**子进程一启动就在指定 cgroup**，避免 fork→set cgroup 之间的窗口期。
5. **MMDS 轮询 50ms 间隔**。Firecracker 启动早期 MMDS 没准备好，envd 不停重试直到拿到第一个响应后退出。**单次成功即结束**——MMDS hash 后续通过 `/init` 协议传输。
6. **MMDS 路由自愈**。iptables 被用户态改掉 → 169.254.169.254 走不到 host → envd 重 pin RETURN 规则到 PREROUTING/OUTPUT 链 position 1。**警告限速 10s 一次** 避免刷屏。
7. **NFS `noac, lookupcache=none`**。禁用客户端缓存 → pause→resume 切换 lifecycle 时挂载点能立刻看到新数据。
8. **Lifecycle-aware remount**。`sync.Map[path → lifecycleID]` 跟踪，**同 lifecycle 跳过 mount、跨 lifecycle 重新 mount**。`"" → ""` 跳过避免 init 重试循环里死循环 mount。
9. **`/init` 总是 defer unfreeze**。即使 SetData 失败也会 thaw cgroup——pause→resume 路径不依赖额外调 `/unfreeze`。
10. **`/init` 总是 defer wipe body**。`memguard.WipeBytes(body)` + `AccessToken.Destroy()` 防止 token 残留在内存。
11. **`SecureToken.Equals()` 不导出明文**。短时间解密对比 → 立即销毁 buffer，**避免 `==` 比较泄露**。
12. **路径签名 `v1_` 前缀**。暗示协议版本，未来升级为 `v2_` 时有 wire-level 区分。
13. **port forwarder 增量算法**。`pid+port` 为 key，新监听 → spawn socat，消失 → kill socat。**不重复 spawn 已存在的转发**。
14. **socat 进 `ProcessTypeSocat` cgroup**。`memory.low=8MB` 保护，端口转发不会因 user 进程吃掉所有内存而饿死。
15. **Keepalive 仅在静默时发**。每次 Data 帧 `ticker.Reset()`，**有数据时不发空心跳**——避免对低延迟命令的干扰。
16. **错误码统一**。Connect 错误码（`CodeNotFound` / `CodeUnauthenticated` / `CodeInvalidArgument`）和 HTTP 状态码（401/403/404）一一对应，跨协议栈语义一致。2026.30 补上 `CodeResourceExhausted`：`StartErrorCode`（`handler/start_error.go`）把 `EAGAIN` / `ENOMEM` / `EMFILE` / `ENFILE` / `ENOSPC` 映射过去，`DeadlineExceeded` 与 `Canceled` 各归其位，其余才落到 `CodeInvalidArgument`——之前"启动失败"一律是参数错误，调用方无法区分"你的命令有问题"和"这台机器资源不够"。
17. **backward compatibility 优先**。`ConnectStreamInput` 是 client stream（新）但保留 `SendInput` unary（旧）。`CreateWatcher/GetWatcherEvents`（新轮询）和 `WatchDir`（旧流式）并存。
18. **【2026.30】热升级靠"同 PID `execve`"，不靠重启进程**。fd 编号、子进程、socat、mount、listener 全都随 fd table 存活，新镜像只是换了代码段。代价是**读方必须拒绝比自己新的 schema**——`execve` 之后没有回退路径，误读比失败更糟。
19. **【2026.30】freeze 的语义是"按树"而不是"按类型"**。冻结一个 cgroup 会连带冻结全部子孙但**不影响祖先**，所以 allowlist 的表达方式是"排除 allowlist 项的祖先链"，不是"跳过 allowlist 项本身"。
20. **【2026.30】thaw 的方向是"宁可多解冻"**。`guest_frozen_cgroups` 记录丢失时，thaw 清掉一切它看到的冻结状态。让一个本该暂停的容器多跑一会儿，远好过让整个 guest 卡死。
21. **【2026.30】`/upgrade` 是唯一没有 spec 的路由**，所以它必须手工登记到 orchestrator 的 `unspecifiedInternalPaths`。这是"spec 之外的直挂路由对 proxy 不可见"的已知代价，`routes_test.go` 用一个测试强制声明这类路由。

## 18. 关键文件速查表

| 主题 | 文件 | 作用 |
| --- | --- | --- |
| 版本 | `packages/envd/pkg/version.go` | `Version` 常量（构建时 bake，带 `// x-release-please-version`） |
| 变更日志 | `packages/envd/CHANGELOG.md` | 【2026.30 新增】release-please 维护 |
| 入口 | `packages/envd/main.go` | flag、MMDS 轮询启动、cgroup 创建、HTTP server、`POST /upgrade` |
| 进程 proto | `packages/envd/spec/process/process.proto` | Process 服务契约（2026.30 未改） |
| 文件 proto | `packages/envd/spec/filesystem/filesystem.proto` | Filesystem 服务契约（2026.30 未改） |
| 交接 proto | `packages/envd/spec/upgrade/handover.proto` | 【2026.30 新增】热升级交接 blob（无 service） |
| 进程实现 | `packages/envd/internal/services/process/service.go` | Service struct + Handle + getProcess + 终态保留缓存 |
| 单进程 | `packages/envd/internal/services/process/handler/handler.go` | fork+exec+pty+cgroup 封装 |
| 事件多路复用 | `packages/envd/internal/services/process/handler/multiplex.go` | MultiplexedChannel[T] 泛型 fan-out |
| Start 时序 | `packages/envd/internal/services/process/start.go` | 启进程、拼流、keepalive、snapshotMu |
| 输入 | `packages/envd/internal/services/process/input.go` | SendInput / StreamInput / CloseStdin |
| 热升级 outgoing | `packages/envd/internal/services/process/upgrade.go` | 【2026.30 新增】冻结 → 序列化 → `execve` |
| 热升级 incoming | `packages/envd/internal/services/process/handler/readopt.go` | 【2026.30 新增】重新认领子进程 + pidfd 收尸 |
| fd 搬迁 | `packages/envd/internal/services/process/dup3_linux.go` | 【2026.30 新增】跨 `execve` 保 fd |
| 启动错误映射 | `packages/envd/internal/services/process/handler/start_error.go` | 【2026.30 新增】errno → Connect 错误码 |
| 文件实现 | `packages/envd/internal/services/filesystem/service.go` | Service + Handle（返回 Service） |
| 文件监听 | `packages/envd/internal/services/filesystem/watch_sync.go` | CreateWatcher / GetWatcherEvents / RemoveWatcher |
| watcher 交接 | `packages/envd/internal/services/filesystem/watch_handover.go` | 【2026.30 新增】ExportWatchers / ImportWatchers |
| MMDS | `packages/envd/internal/host/mmds.go` | 50ms 轮询 + 持久化 + log 转发 |
| MMDS 自愈 | `packages/envd/internal/host/mmds_route_linux.go` | iptables pin 169.254.169.254 |
| cgroup 接口 | `packages/envd/internal/services/cgroups/iface.go` | Manager + PathManager + ProcessType |
| cgroup v2 | `packages/envd/internal/services/cgroups/cgroup2.go` | Cgroup2Manager 真实现（含 PathManager） |
| 层级 freeze | `packages/envd/internal/services/cgroups/freeze.go` | 【2026.30 新增】WorkloadFreezer + watchdog |
| cgroup 树遍历 | `packages/envd/internal/services/cgroups/hierarchy.go` | 【2026.30 新增】allowlist / 祖先链 / 审计 |
| 内存保护 | `packages/envd/internal/services/cgroups/memory.go` | 【2026.30 新增】读 memory.max/high/min/low |
| 端口扫描 | `packages/envd/internal/port/scan.go` | gopsutil + pub-sub（ticker + scanExit） |
| 端口转发 | `packages/envd/internal/port/forward.go` | socat 增量算法 + socatPid + Export/Import |
| socat 回收 | `packages/envd/internal/port/forward_reap_linux.go` | 【2026.30 新增】按 pid 精确回收 |
| 权限 | `packages/envd/internal/permissions/authenticate.go` | Basic Auth → *user.User |
| 路径 | `packages/envd/internal/permissions/path.go` | ~ 展开、相对路径解析、目录创建 |
| Keepalive | `packages/envd/internal/permissions/keepalive.go` | Keepalive-Ping-Interval 头解析 |
| 旧 SDK | `packages/envd/internal/services/legacy/interceptor.go` | `connect-python` 兼容层 |
| API 状态 | `packages/envd/internal/api/store.go` | API struct + New + Health + Metrics + LogFlusher |
| Access Token | `packages/envd/internal/api/auth.go` | WithAuthorization + 路径签名 + handover fail-closed |
| Secure Token | `packages/envd/internal/api/secure_token.go` | memguard 包装的 token |
| Init | `packages/envd/internal/api/init.go` | /init 处理 + NFS 挂载 + 诊断头 + freeze/thaw |
| mount 交接 | `packages/envd/internal/api/mounts_handover.go` | 【2026.30 新增】ExportMounts / ImportMounts |
| 上传/下载 | `packages/envd/internal/api/{upload,download}.go` | multipart + raw octet-stream + gzip |
| 默认上下文 | `packages/envd/internal/execcontext/context.go` | Defaults（user/workdir/envvars）+ BuiltinDefaultUser |
| 工具 | `packages/envd/internal/utils/atomic.go` | AtomicMax（init timestamp 严格递增） |
| 工具 | `packages/envd/internal/utils/map.go` | 【2026.30】新增 `CompareAndDelete` |

---

**已同步至 2026.30**（对照 tag `2026.30` 逐项核实；2026.29 的行号差异在正文中以"行 N（2026.30；2026.29 为 M）"标出）。
