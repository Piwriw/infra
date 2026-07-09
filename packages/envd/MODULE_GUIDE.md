# envd 模块详解

> 运行在每个 Firecracker microVM 内部的守护进程，是 SDK 与 guest 内核之间唯一的信使。

**仓库路径**：`packages/envd/`
**默认端口**：`49983`（HTTP / Connect-RPC）
**当前版本**：`0.6.3`（`pkg/version.go`，行为变更必须 bump）
**架构层级**：envd 守护进程层（`layer:envd`，107 个节点）

---

## 1. 定位与职责

`envd` 是 E2B 沙箱中运行在 Firecracker VM **内部** 的常驻 daemon。SDK 调用「在沙箱里执行命令 / 读写文件 / 转发端口」等能力时，最终都被翻译成对 `envd` 的 RPC。

它解决的核心问题：

1. **进程管理** —— 在 VM 内启动 / 列举 / 信号 / 流式获取输出任意进程（含 PTY）。
2. **文件系统** —— 跨用户的 stat / ls / mkdir / mv / rm / watch 操作。
3. **文件上传下载** —— HTTP multipart 与 raw body 上传、gzip 编码下载。
4. **沙箱生命周期** —— `/init` 注入环境变量、安装 CA、挂载 NFS、校正时间、解冻 cgroup。
5. **资源治理** —— 基于 cgroup v2 对 user / pty / socat 进程做 CPU / memory / io 限制与 freeze / unfreeze。
6. **可观测性** —— 通过 MMDS 拉取配置后，将结构化日志通过 HTTP 推送到 Orchestrator。
7. **端口自动转发** —— 周期扫描 127.0.0.1 上的 LISTEN 端口，并通过 `socat` 转发到 gateway IP。

`envd` 是整个 E2B 链路中最贴近 guest 的一层：上游是 Orchestrator（`packages/orchestrator`）和 client-proxy，下游是 Linux 内核 / Firecracker MMDS（`169.254.169.254`）。

---

## 2. 启动流程（main.go）

入口：`packages/envd/main.go:139`（`main`）→ `run`（`:159`）。

```
main → parseFlags → run
  ├─ os.MkdirAll(/run/e2b, 0o755)                  # 沙箱元数据目录
  ├─ execcontext.Defaults{User: "root", EnvVars}    # 默认执行上下文
  ├─ 写入 /run/e2b/.E2B_SANDBOX 标记是否 Firecracker
  ├─ go host.PollForMMDSOpts(...)                   # 后台轮询 MMDS（仅 FC）
  ├─ logs.NewLogger(...)                            # 装配 zerolog + HTTP exporter
  ├─ chi.NewRouter()
  │    ├─ filesystemRpc.Handle(...)                 # 挂载 Filesystem Connect-RPC
  │    ├─ processRpc.Handle(... cgroupManager)      # 挂载 Process Connect-RPC
  │    └─ api.HandlerFromMux(service, m)            # 挂载 OpenAPI HTTP handlers
  │         ↳ authn.NewMiddleware(AuthenticateUsername)
  │         ↳ service.WithAuthorization(...)        # 包裹 access token 校验
  │         ↳ withCORS(...)                         # 包裹 CORS（含 Connect 暴露头）
  ├─ createCgroupManager()                          # cgroup v2 资源池
  ├─ http.Server{Addr: "0.0.0.0:49983", IdleTimeout: 640s}
  ├─ go portForwarder.StartForwarding(ctx)          # 端口转发循环
  ├─ go portScanner.ScanAndBroadcast()              # /proc/net/tcp 周期扫描
  └─ s.ListenAndServe()
```

### 命令行 flags

| flag | 默认 | 用途 |
|---|---|---|
| `-isnotfc` | `false` | 非 Firecracker 模式：跳过 MMDS 轮询与 HTTP 日志导出 |
| `-version` | — | 打印 `pkg.Version` 后退出 |
| `-commit` | — | 打印编译时 commit SHA 后退出 |
| `-port` | `49983` | HTTP 监听端口 |
| `-cgroup-root` | `/sys/fs/cgroup` | cgroup v2 挂载点 |
| `-no-cgroups` | `false` | 禁用 cgroup（使用 `NoopManager`） |
| `-verbose` | `false` | 日志额外输出到 stdout |

### 资源预留策略（`createCgroupManager`）

`main.go:237` 读取主机内存后，预留 `min(MemTotal/8, 128 MiB)`，将剩余部分作为 user/pty 的 `memory.max`：

| cgroup | cpu.weight | io.weight | memory |
|---|---|---|---|
| `ptys`  | 200 | default 50 | `high = max`, `max = MemTotal - reserve` |
| `socats` | 150 | default 50 | `min = 5 MiB`, `low = 8 MiB` |
| `user`  | 50  | default 10 | `high = max`, `max = MemTotal - reserve` |

`system` 类型不进入独立 cgroup，留在 envd 根 cgroup，因此不受 freeze 影响。

---

## 3. 整体架构

```
                                ┌────────────────────────────────────────┐
                                │              envd (PID 1-ish)          │
                                │      0.0.0.0:49983  chi.Router         │
                                │                                        │
   SDK / Orchestrator  ──────►  │  ┌─────────────┐  ┌────────────────┐   │
   (HTTP+Connect-RPC)           │  │ Filesystem  │  │   Process      │   │
                                │  │ Service     │  │   Service      │   │
                                │  │ (Connect)   │  │   (Connect)    │   │
                                │  └──────┬──────┘  └────────┬───────┘   │
                                │         │                  │           │
                                │  ┌──────┴──────────────────┴───────┐   │
                                │  │       permissions / api          │   │
                                │  │  (Basic Auth + AccessToken HMAC) │   │
                                │  └──────────────────────────────────┘   │
                                │                                        │
                                │  ┌──────────────────────────────────┐   │
                                │  │   cgroups.Manager (v2 / Noop)    │   │
                                │  │   pty / user / socat / system    │   │
                                │  └──────────────────────────────────┘   │
                                │                                        │
                                │  ┌────────────┐  ┌────────────────┐    │
                                │  │ port fwd   │  │ host (mmds/    │    │
                                │  │ (socat)    │  │  metrics/cacert)│   │
                                │  └─────┬──────┘  └────────┬───────┘    │
                                └────────┼──────────────────┼────────────┘
                                         │                  │
                                  socat►169.254.0.21   HTTP►169.254.169.254
                                                            (Firecracker MMDS)
```

---

## 4. 目录结构

```
packages/envd/
├── main.go                 # 入口；装配 chi router、cgroup、端口转发
├── pkg/version.go          # Version 常量（每次行为变更必须 bump）
├── debug.Dockerfile        # 本地调试镜像（含 Delve）
├── Makefile                # build / start-docker / generate / test
├── go.mod / go.sum
├── spec/
│   ├── envd.yaml           # OpenAPI 3.0 spec（HTTP 端点）
│   ├── process/process.proto
│   ├── filesystem/filesystem.proto
│   ├── buf.gen.yaml / buf.gen.shared.yaml
│   └── generate.go         # go:generate 入口
└── internal/
    ├── api/                # OpenAPI HTTP handlers（/init /freeze /files ...）
    ├── execcontext/        # 默认 user / workdir 解析
    ├── host/               # MMDS 客户端、主机指标、CA 证书、iptables pin
    ├── logs/               # zerolog + HTTP exporter + 拦截器 + ratelimit
    ├── permissions/        # Basic Auth、路径展开、用户查找、keepalive
    ├── port/               # 端口扫描 + socat 转发
    ├── services/
    │   ├── cgroups/        # cgroup v2 / Noop Manager
    │   ├── filesystem/     # Filesystem Connect-RPC 实现
    │   ├── process/        # Process Connect-RPC 实现 + Handler
    │   ├── legacy/         # 兼容旧版 connect-python SDK 的拦截器
    │   └── spec/           # protoc 生成的 Go 代码（*.pb.go / *.connect.go）
    └── utils/              # AtomicMax、EnvVars、Map、CustomPart、rfsnotify
```

---

## 5. 服务契约

### 5.1 HTTP / OpenAPI 端点（`spec/envd.yaml`）

由 `oapi-codegen` 生成 `internal/api/api.gen.go`，挂在 chi 路由上。所有端点都支持可选的 `AccessTokenAuth`。

| 方法 & 路径 | 处理器 | 用途 |
|---|---|---|
| `GET  /health` | `GetHealth` | 返回 `204 No Content` |
| `GET  /metrics` | `GetMetrics` | 返回 CPU / 内存 / 磁盘指标 JSON |
| `POST /init` | `PostInit` | 注入 env、设置时钟、挂载 NFS、解冻 cgroup、写入 hyperloop hosts |
| `POST /freeze` | `PostFreeze` | 冻结 user/pty cgroup（pause 前调用） |
| `POST /unfreeze` | `PostUnfreeze` | 解冻（**仅** pause 失败回滚路径使用） |
| `GET  /envs` | `GetEnvs` | 返回当前沙箱环境变量 |
| `POST /files` | `PostFiles` | 上传文件（multipart / raw，支持 gzip、xattr metadata） |
| `GET  /files` | `GetFiles` | 下载文件 / 目录（支持 gzip、Content-Disposition） |
| `POST /files/compose` | `PostFilesCompose` | 原子化合并多个源到目标路径 |

### 5.2 Process Connect-RPC（`spec/process/process.proto`）

服务 `process.Process`：

| RPC | 类型 | 用途 |
|---|---|---|
| `Start` | server stream | 启动进程，流式返回 `Start → Data* → End` 事件（含 KeepAlive） |
| `Connect` | server stream | 订阅已存在进程（按 pid 或 tag 选择）的事件流 |
| `List` | unary | 返回全部运行中进程的 `ProcessInfo` |
| `Update` | unary | 调整 PTY 尺寸 |
| `SendInput` | unary | 一次性写入 stdin / PTY |
| `StreamInput` | client stream | 客户端流式写入 stdin |
| `SendSignal` | unary | 发送 SIGTERM / SIGKILL |
| `CloseStdin` | unary | 关闭非 PTY 进程的 stdin（PTY 用 `0x04`） |

`ProcessSelector` 支持 `pid` 或 `tag` 两种寻址。`ProcessEvent` 是 oneof：`Start | Data(stdout/stderr/pty) | End(exit_code, exited, status, error) | KeepAlive`。

### 5.3 Filesystem Connect-RPC（`spec/filesystem/filesystem.proto`）

服务 `filesystem.Filesystem`：

| RPC | 类型 | 用途 |
|---|---|---|
| `Stat` | unary | 返回 `EntryInfo`（含 mode、owner、xattr metadata） |
| `MakeDir` | unary | 创建目录 |
| `Move` | unary | 移动 / 重命名 |
| `ListDir` | unary | 列举目录（支持 depth） |
| `Remove` | unary | 删除 |
| `WatchDir` | server stream | 推送 `Create/Write/Remove/Rename/Chmod` 事件流 |
| `CreateWatcher` | unary | 创建具名 watcher，返回 `watcher_id` |
| `GetWatcherEvents` | unary | 拉取该 watcher 累积的事件 |
| `RemoveWatcher` | unary | 删除 watcher |

`EntryInfo.metadata` 暴露 `user.e2b.*` xattr（前缀被剥离）。`WatchDir` 不允许监听网络挂载（NFS）。

---

## 6. 核心子系统

### 6.1 MMDS 客户端（`internal/host/mmds.go`）

Firecracker MicroVM Metadata Service 是宿主与 guest 之间的带外通道，固定地址 `169.254.169.254`。

`PollForMMDSOpts` 每 50ms 轮询一次：

1. `PUT /latest/api/token` —— 携带 `X-metadata-token-ttl-seconds: 60`，换取一次性 token。
2. `GET /` —— 携带 `X-metadata-token`，解析得到 `MMDSOpts`：

```go
type MMDSOpts struct {
    SandboxID            string // instanceID
    TemplateID           string // envID
    LogsCollectorAddress string // 日志收集器地址
    AccessTokenHash      string // 用于校验 /init 请求
}
```

3. 把 `E2B_SANDBOX_ID` / `E2B_TEMPLATE_ID` 写入环境变量与 `/run/e2b/.E2B_SANDBOX_ID` 文件。
4. 将 opts 推到 `mmdsChan`，触发 HTTP 日志导出器启动。

**自愈机制**（`init.go:76` `checkMMDSHash`）：当 MMDS GET 失败（可能是用户态 iptables PREROUTING/OUTPUT 规则覆盖了我们的 RETURN 规则），调用 `host.PinMMDSRoute` 在 nat 表的 PREROUTING/OUTPUT 第 1 位重插 RETURN 规则后重试。失败日志通过 `pinMMDSWarnLimit`（10 秒令牌桶）限流，避免 `/init` 重试风暴淹没日志。

### 6.2 cgroup v2 管理（`internal/services/cgroups/`）

`iface.go` 定义抽象：

```go
type Manager interface {
    GetFileDescriptor(procType ProcessType) (int, bool)
    Freeze(procType ProcessType) error
    Unfreeze(procType ProcessType) error
    Close() error
}
```

实现：

| 文件 | 平台 | 说明 |
|---|---|---|
| `cgroup2.go` | linux | 真正的 cgroup v2 实现：statfs 校验 `CGROUP2_SUPER_MAGIC`，建目录、写属性、open 目录拿 fd |
| `cgroup2_stub.go` | 非 linux | 保留 API 形状的空实现 |
| `noop.go` | 全平台 | `--no-cgroups` 时使用，全部 no-op |
| `cgroup2_test.go` | linux | 属性往返、freeze/unfreeze 集成测试 |

**关键设计：cgroup 文件描述符**

`Cgroup2Manager.GetFileDescriptor` 返回每个 `ProcessType` 的目录 fd。当 `handler` 启动子进程时，通过 `clone3(CLONE_INTO_CGROUP)` 把进程直接附加到目标 cgroup（见 `handler/cgroupfd_linux.go`），避免了传统的「fork → 写 cgroup.procs」竞态。

### 6.3 进程执行（`internal/services/process/`）

`service.go:19` 维护线程安全的 `utils.Map[uint32, *handler.Handler]`，支持按 `pid` 或 `tag` 查找。

`handler/handler.go:45` 是进程执行核心，职责：

- 构建 `exec.Cmd`，**内部** 包装 `oom_score_adj` / `ionice` / `nice`（用户看到的命令不含这些）。
- 支持 PTY（`creack/pty`）与普通 stdout/stderr 管道，分块读（stdout 32 KiB / pty 16 KiB）。
- 关联到对应 cgroup（PTY → `ptys`，普通 → `user`）。
- 提供 `DataEvent` / `EndEvent` 两个 `MultiplexedChannel`，支持多订阅者扇出（见下文）。
- 维护 `stdoutBytes / stderrBytes / ptyBytes` 原子计数（流量统计）。

**`Start` RPC 流程**（`start.go:23`）：

```
1. permissions.GetAuthUser  → 解析目标系统用户
2. determineTimeoutFromHeader（Connect-Timeout-Ms 头）
3. handler.New(...) 构造 Handler（注意：用 context.Background，避免请求 cancel 杀进程）
4. Fork 三个 channel: start / data / end
5. proc.Start(timeout) → pid
6. s.processes.Store(pid, proc)
7. 循环 select:
     - keepaliveTicker.C → 发 KeepAlive
     - ctx.Done           → cancel
     - start/data/end     → 流式 Send
8. 进程退出后从 Map 删除
```

**`MultiplexedChannel`（`handler/multiplex.go`）**：单源 `Source` channel 扇出给所有 `Fork()` 订阅者，每个订阅者都能完整接收事件副本。订阅者取消（`done` channel）不会阻塞扇出循环，由 `sync.Once` 保护。

### 6.4 文件系统服务（`internal/services/filesystem/`）

`service.go:21` `Handle` 在 chi mux 上挂载 Connect handler，拦截器链：

```
connect.WithInterceptors(
    logs.NewUnaryLogInterceptor(l),   // 操作 ID + 访问日志
    legacy.Convert(),                  // 旧版 connect-python UA 触发的字段转换
)
```

子模块：

- `dir.go` —— `ListDir` / `MakeDir`，含符号链接与递归遍历。
- `move.go` —— `Move`，跨用户移动并保留权限。
- `remove.go` —— `Remove`。
- `stat.go` —— `Stat`，返回 `EntryInfo`（含 xattr metadata）。
- `watch.go` —— `WatchDir` 服务端流，基于 `e2b-dev/fsnotify`，含 KeepAlive 与网络挂载保护。
- `watch_sync.go` —— 同步版 watcher：`CreateWatcher` / `GetWatcherEvents` / `RemoveWatcher`，管理 `watchers` Map。
- `utils.go` —— 网络挂载检测、条目信息构造、事件转换。

### 6.5 沙箱生命周期（`internal/api/init.go`）

`/init` 是被 Orchestrator 反复 hammer 的端点（重试循环），核心逻辑：

```go
PostInit(w, r):
  1. 读 body，反序列化 PostInitJSONBody
  2. defer memguard.WipeBytes(body)        # 安全擦除请求体
  3. defer initRequest.AccessToken.Destroy() # 销毁令牌副本
  4. initLock.Acquire(1)                    # 串行化 /init
  5. validateInitAccessToken(ctx, token)    # 三选一: 现有 token / MMDS hash / 首次
  6. defer unfreezeUserCgroups(ctx, logger) # 无论是否过期都解冻
  7. if timestamp 较新 → SetData(...)
  8. 异步: host.PollForMMDSOpts(...)        # 刷新 MMDS 缓存
```

**令牌校验顺序**（`validateInitAccessToken`）：

1. 现有 token 等于请求 token → 通过（快速路径）。
2. 否则查 MMDS hash：
   - MMDS hash == hash(token) → 通过。
   - MMDS hash == hash("") 且请求未带 token → 通过（token 重置授权）。
   - 现有 token 与 MMDS hash 都不存在 → 首次安装，通过。
   - 其它 → `ErrAccessTokenMismatch`（401）。

**`SetData`** 依次执行：

- 校正系统时钟（`shouldSetSystemTime`：过去 50ms 或未来 5s 之外才调整）。
- 替换用户环境变量（保留 internal 条目）。
- 安装 / 清除 access token。
- 启动 hyperloop setup（重写 `/etc/hosts` 中的 `events.e2b.local`）。
- 设置默认 user / workdir。
- 安装 CA bundle。
- 挂载 NFS 卷。

**NFS 挂载**（`setupNFS`）：

- `isMountingNFS` atomic CAS 防止并发挂载。
- `mountedPaths sync.Map[path]lifecycleID`：仅在 lifecycle 变化时重挂。
- 每个卷并行 `unmount → mount`，使用 `findmnt` 检测是否已挂。
- mount 选项（`nfsOptions`）：`sync, rsize/wsize=1MiB, proto=tcp, port=2049, nfsvers=3, noacl, noac, lookupcache=none`。
- 超时 10 秒；强制 `umount --force` 失败回退到 `umount --lazy`。

**`PostFreeze` / `PostUnfreeze`**：

- `userCgroupsToFreeze = [ProcessTypeUser, ProcessTypePTY]`。
- `freezeLock` 串行化 /freeze、/unfreeze、/init 延迟解冻三者的 cgroup 扫描。
- /freeze 用请求 ctx 获取锁；unfreeze 路径用 `context.WithoutCancel` 保证 HTTP 客户端取消后仍完成。

### 6.6 安全令牌（`internal/api/secure_token.go`）

`SecureToken` 包装 `memguard.LockedBuffer`：

- 内存锁定（不可 swap）、guard page 保护、销毁时安全清零。
- `UnmarshalJSON` 直接解析 JSON 字符串到 secure buffer，解析完立即擦除输入字节。
- `EqualsSecure` 使用 `EqualTo`（底层 `subtle.ConstantTimeCompare`）做常量时间比较。
- `TakeFrom` 转移 buffer 所有权，避免字节拷贝。

`SecureToken` 用于：

- access token（/init 注入、/files 等端点校验）。
- `auth.go` 中 HMAC 签名密钥（保护 init / post-init 调用）。

### 6.7 端口自动转发（`internal/port/`）

`Scanner`（`scan.go:12`）周期（默认 1s）调用 `gopsutil/v4/net.Connections("tcp")`，广播给所有 subscriber。

`Forwarder`（`forward.go:40`）订阅 `Scanner`，过滤条件 `IPs=[127.0.0.1, localhost, ::1]` + `State=LISTEN`：

```
对每次扫描结果：
  1. 现有转发端口的 state 全部置 DELETE
  2. 遍历扫描结果，命中已有 → 标 FORWARD；新增 → 启动 socat
  3. 剩下仍为 DELETE 的端口 → 杀进程组
```

`socat` 命令：

```
socat -d -d -d TCP4-LISTEN:<port>,bind=169.254.0.21,reuseaddr,fork TCP<family>:localhost:<port>
```

- 源 IP 固定 `169.254.0.21`（gateway）。
- `Setpgid: true` 把 socat 放到独立进程组，便于 `kill(-pgid, SIGKILL)`。
- 通过 `applyCgroupFD` 把 socat 子进程附加到 `socats` cgroup（受 CPU / io / memory 限制）。

### 6.8 日志与可观测性（`internal/logs/`）

`logger.go:15` `NewLogger`：

- 框架：`zerolog`，时间字段 `timestamp`，精度 RFC3339Nano。
- Level：`DebugLevel`。
- 输出：`io.MultiWriter` 组合
  - FC 模式：`HTTPExporter`（推到 Orchestrator 日志收集器）。
  - `-verbose` 模式：`os.Stdout`。

`exporter/exporter.go:25` `HTTPExporter`：

- 监听 `mmdsChan`，收到 opts 后启动后台 flush goroutine（`sync.Once` 保证只启一次）。
- 累积日志到 `logs [][]byte` + `bufferedBytes`，达到阈值（默认 8 MiB）或收到 trigger 时 POST 到 collector。
- 单行上限 192 KiB（低于 Loki 默认 256 KiB `max_line_size`），超限丢弃并限速告警。
- 三个 `rateLimitedLogger`：JSON 错误、发送错误、超限日志，全部以 1 分钟为底限速。

`logs/interceptor.go`：

- `AssignOperationID()` 为每个请求分配唯一 ID。
- Unary 与 Streaming 拦截器记录访问日志。

`logs/ratelimit/ratelimit.go`：令牌桶限流器，抑制高频重复日志。

### 6.9 主机指标（`internal/host/metrics.go`）

`GetMetrics()` 返回：

```go
type Metrics struct {
    Timestamp      int64
    CPUCount       uint32
    CPUUsedPercent float32
    MemTotal, MemUsed, MemCache uint64  // bytes
    MemTotalMiB, MemUsedMiB     uint64  // deprecated
    DiskUsed, DiskTotal         uint64
}
```

通过 `gopsutil/v4` 读取 mem / cpu，`unix.Statfs` 读取磁盘。`/metrics` 端点直接 JSON 输出。

### 6.10 CA 证书注入（`internal/host/cacerts.go`）

`CACertInstaller.Install(ctx, pemBundle)`：

- 解析 PEM bundle（可能含多个证书）。
- 追加到系统 CA 捆绑包（去重）。
- 支持重启恢复、并发安全。
- 测试覆盖首次安装、相同证书、不同证书、重启恢复等场景。

### 6.11 权限与用户（`internal/permissions/`）

- `authenticate.go:14` `AuthenticateUsername` —— Connect-RPC 认证拦截器：解析 Basic Auth username → `user.User` 注入 ctx。未提供 username 时返回 nil（端点可选择是否需要）。
- `user.go` —— `GetUser(username)` 包装 `os/user.Lookup`，解析 UID/GID。
- `path.go:30` `ExpandAndResolve` —— 展开 `~`、解析相对路径为绝对路径（基于 user.HomeDir）。
- `keepalive.go` —— 为长连接 RPC 流（WatchDir、Start、Connect）生成 KeepAlive ticker；header 可重置周期。

### 6.12 Legacy 兼容（`internal/services/legacy/`）

为旧版 `connect-python` SDK 保留的兼容层：

- `interceptor.go` —— 检测 User-Agent，仅对旧 SDK 触发转换。
- `conversion.go` —— 字段格式归一化（如时间戳格式、枚举值名称）。
- `stream.go` —— 适配 `connect.StreamingHandlerConn` 到旧版流接口。
- `legacyfilesystem.pb.go` / `legacyprocess.pb.go` —— 由旧版 proto 生成的消息类型。

### 6.13 工具集（`internal/utils/`）

| 文件 | 类型 | 用途 |
|---|---|---|
| `atomic.go` | `AtomicMax` | 互斥锁保护下仅在更大时更新 int64（跟踪实时最大值） |
| `envvars.go` | `EnvVars` | 区分 `internal`（系统）/ `user` 条目的并发安全 map，internal 不可被用户覆写 |
| `map.go` | `Map[K,V]` | 基于 `sync.Map` 的泛型类型安全包装 |
| `multipart.go` | `CustomPart` | 扩展 `multipart.Part.FileName` 返回含路径的完整文件名 |
| `rfsnotify.go` | `FsnotifyPath` | 递归监听时附加 fsnotify 内部约定的 `...` 后缀 |

---

## 7. 关键交互流程

### 7.1 沙箱冷启动

```
Orchestrator 启动 FC VM
  └─ envd 作为 init 启动
       ├─ PollForMMDSOpts 轮询 → 拿到 sandboxID/templateID/logAddr/tokenHash
       ├─ logger 启动 HTTP exporter（等 mmdsChan 触发）
       └─ ListenAndServe :49983

Orchestrator POST /init  (accessToken + envVars + defaultUser + ...)
  └─ envd:
       ├─ validateInitAccessToken (MMDS hash 匹配 → 首次安装)
       ├─ SetData:
       │    ├─ setSystemTime(timestamp)
       │    ├─ ReplaceUserVars(envVars)
       │    ├─ accessToken.TakeFrom(...)
       │    ├─ Install caBundle
       │    └─ setupNFS(volumeMounts)
       └─ defer unfreezeUserCgroups (user + pty)
```

### 7.2 SDK 执行命令

```
SDK ──Connect-RPC──► Process.Start(cmd, args, envs, cwd, pty?)
  └─ envd:
       ├─ GetAuthUser → user.User (UID/GID)
       ├─ handler.New(...) → exec.Cmd 包装 nice/ionice/oom_score_adj
       ├─ proc.Start(timeout)
       │    ├─ clone3(CLONE_INTO_CGROUP, cgroupFD=pty|user)
       │    └─ goroutine: 读 stdout/stderr/pty → DataEvent channel
       ├─ stream Send: Start{pid} → Data* → End{exit_code}
       │    （穿插 KeepAlive）
       └─ 进程退出 → processes.Delete(pid)
```

### 7.3 沙箱 pause/resume

```
Orchestrator 准备 pause:
  POST /freeze
    └─ envd: freezeLock.Acquire → 冻结 user + pty cgroup → 204

Orchestrator: Firecracker CreateSnapshot

Orchestrator resume:
  Orchestrator: Firecracker ResumeSnapshot
  POST /init (含新 accessToken + timestamp)
    └─ envd:
         ├─ validateInitAccessToken (MMDS hash 由 Orchestrator 在 Resume 时写入)
         ├─ defer unfreezeUserCgroups (user + pty 解冻)
         └─ SetData (替换 token、envVars，重挂 NFS 如 lifecycle 变化)

如果 pause 失败需要回滚:
  POST /unfreeze
    └─ envd: 直接解冻（绕过 /init 路径）
```

### 7.4 文件上传

```
SDK POST /files  (multipart 或 raw body)
  Headers: X-Metadata-<key>: <value>  →  user.e2b.<key> xattr
  └─ envd:
       ├─ 解析 Authorization (HMAC 签名 或 access token)
       ├─ extractMetadataHeaders
       ├─ processFile:
       │    ├─ EnsureDirs(parent, uid, gid)
       │    ├─ Chown(path, uid, gid)
       │    ├─ OpenFile(O_WRONLY|O_CREATE|O_TRUNC)
       │    ├─ （可选）gzip 解压
       │    └─ setxattr user.e2b.<key>
       └─ 200 / 4xx
```

---

## 8. 版本管理

`pkg/version.go`：

```go
package pkg

const Version = "0.6.3"
```

**规则**（README 强调）：任何**行为变更**（代码改动、依赖更新）必须 bump version。纯注释 / 文档变更不需要。

Orchestrator 在创建沙箱时会将 envd 版本与 template 要求版本对比，决定是否需要重新打包 rootfs。`main.go` 的 `-version` flag 也用于构建管线验证。

---

## 9. 构建与开发

### 关键 Makefile 目标

| 目标 | 用途 |
|---|---|
| `make build` | `CGO_ENABLED=0 GOOS=linux GOARCH=$BUILD_ARCH go build -trimpath`，产出 `bin/envd` |
| `make build-debug` | `CGO_ENABLED=1 -race -gcflags="-N -l"`，用于 Delve |
| `make start-docker` | 构建 + 构建 debug Docker 镜像 + `docker run -p 49983 -p 2345 ...` |
| `make build-and-upload` | 构建 + 上传到 GCS `gs://<proj>-fc-env-pipeline/envd[.<sha>]` |
| `make upload ENVD_UPLOAD_MODE=versioned` | 带版本上传（保留旧版用于回滚） |
| `make promote ENVD_COMMIT_SHA=<sha>` | 将特定版本提升为 `envd`（latest） |
| `make generate` | `go generate ./...`（oapi-codegen + protoc） |
| `make test` | `go test -race -v ./...` |

### 本地调试

```bash
make start-docker
# envd 监听 0.0.0.0:49983，Delve 在 2345
# SDK 端：E2B_DEBUG=true 或 create_sandbox(debug=true)
```

`-isnotfc` flag 跳过 MMDS 轮询与 HTTP 日志导出，让 envd 能在普通容器/VM 中跑起来。

### 代码生成

| 工具 | 输入 | 输出 |
|---|---|---|
| `oapi-codegen` | `spec/envd.yaml` | `internal/api/api.gen.go`（chi server + types） |
| `protoc-gen-go` | `spec/process/process.proto` | `internal/services/spec/process/process.pb.go` |
| `protoc-gen-go` | `spec/filesystem/filesystem.proto` | `internal/services/spec/filesystem/filesystem.pb.go` |
| `protoc-gen-connect-go` | 同上 | `*.connect.go`（客户端 / 服务端桩） |
| `mockery` | `filesystemconnect` 接口 | `internal/services/spec/filesystem/filesystemconnect/mocks/mocks.go` |

---

## 10. 跨平台支持

envd 必须能在 Linux/Firecracker 内运行，同时允许在 macOS 上编译/测试。大量 `*_linux.go` / `*_other.go` 文件实现这一目标：

| 文件对 | Linux 行为 | 非 Linux 行为 |
|---|---|---|
| `clock_linux.go` / `clock_other.go` | `settimeofday` syscall | 警告并不修改时钟 |
| `mmds_route_linux.go` / `mmds_route_other.go` | `iptables` 规则 pin | no-op |
| `forward_cgroupfd_linux.go` / `_other.go` | 设置 `SysProcAttr.CgroupFD` | no-op |
| `cgroupfd_linux.go` / `_other.go` | `clone3(CLONE_INTO_CGROUP)` | no-op |
| `cgroup2.go` / `cgroup2_stub.go` | 真实 cgroup v2 | 占位 |

---

## 11. 安全要点

1. **AccessToken 三层校验**：现有 token → MMDS hash → 首次安装，防止重放与未授权访问。
2. **SecureToken**：所有令牌用 `memguard.LockedBuffer` 存储，销毁时清零；JSON 解析后立即擦除输入。
3. **HMAC 签名**：`auth.go` 对 `/init` 等敏感调用做签名校验，签名密钥来自 SecureToken。
4. **请求体擦除**：`/init` 的 body 在解析后 `defer memguard.WipeBytes(body)`。
5. **路径权限**：`permissions.ExpandAndResolve` 强制所有用户态路径解析到绝对路径；`EnsureDirs` 用目标用户的 UID/GID 创建父目录。
6. **cgroup 隔离**：用户进程、PTY、socat 各自独立 cgroup，CPU/io/memory 受限；envd 自身留在根 cgroup 不被 freeze。
7. **MMDS 路由自愈**：用户态 iptables 规则覆盖 MMDS 路由时自动重插，避免令牌校验失效。

---

## 12. 性能与可靠性

- **HTTP 服务器**：`ReadTimeout=0, WriteTimeout=0, IdleTimeout=640s` —— 不设读写超时，因为长连接由 sandbox 关闭 + keepalive close 终止。
- **进程 Map**：`utils.Map` 基于 `sync.Map`，无锁读路径。
- **MultiplexedChannel**：单源扇出多订阅者，订阅者慢/取消不阻塞生产者。
- **日志限流**：MMDS pin 失败、exporter 错误、超限日志全部走令牌桶，防止日志洪水。
- **NFS 挂载**：`isMountingNFS` CAS + `mountedPaths` lifecycle 追踪，避免重复挂载；`umount --force` → `--lazy` 回退。
- **/init 串行化**：`initLock semaphore.Weighted(1)`，避免并发 /init 竞争资源。
- **后台 goroutine 使用 `context.WithoutCancel`**：unfreeze、NFS umount 等关键清理工作不被 HTTP 客户端取消影响。

---

## 13. 在仓库中的位置

- **上游**：被 `packages/orchestrator`（FC VM 启动时配置 MMDS、调用 `/init`、pause/resume 时调用 `/freeze`/`/unfreeze`）与 `packages/client-proxy`（路由 SDK 请求）依赖。
- **下游**：Linux 内核（syscall、cgroup v2、netlink、iptables）、Firecracker MMDS、`socat`、`mount.nfs`。
- **共享代码**：依赖 `packages/shared/pkg/keys`（HMAC 哈希）、`packages/shared/pkg/filesystem`（路径工具）、`packages/shared/pkg/smap`（并发 map）。
- **构建管线**：`packages/fc-versions/` 决定 Firecracker 版本；envd 二进制被打包进 template rootfs，上传到 GCS 由 Orchestrator 拉取。

---

## 14. 快速链接

| 想了解 | 看 |
|---|---|
| 启动装配 | `main.go:159` `run` |
| HTTP API 列表 | `spec/envd.yaml` |
| Process RPC 列表 | `spec/process/process.proto` |
| Filesystem RPC 列表 | `spec/filesystem/filesystem.proto` |
| `/init` 全流程 | `internal/api/init.go:115` `PostInit` |
| 令牌校验 | `internal/api/init.go:46` `validateInitAccessToken` |
| cgroup 抽象 | `internal/services/cgroups/iface.go` |
| 进程执行核心 | `internal/services/process/handler/handler.go:45` `Handler` |
| MMDS 轮询 | `internal/host/mmds.go:132` `PollForMMDSOpts` |
| 端口转发 | `internal/port/forward.go:73` `StartForwarding` |
| 日志导出 | `internal/logs/exporter/exporter.go:41` `NewHTTPLogsExporter` |
| 版本号 | `pkg/version.go` |

---

## 15. 进程 Handler 生命周期与多订阅者扇出

`internal/services/process/handler/handler.go:92` `New` 是 envd 进程执行的真正核心。一个 `Handler` 实例的生命周期严格分四个阶段：**构造 → 启动 → 输出扇出 → 终结**。

### 15.1 构造阶段（`New`）

```
1. 计算 userCmd（日志用） = cmd + args
2. 计算 niceDelta = defaultNice(0) - currentNice()
   └─ currentNice 读 /proc/self 并把 "20 - prio" 还原成 nice
3. oomWrapperScript =
     echo 100 > /proc/$$/oom_score_adj &&
     exec /usr/bin/ionice -c 2 -n 4 /usr/bin/nice -n <delta> "${@}"
4. cmd := exec.CommandContext(procCtx, "/bin/sh", "-c", oomWrapperScript, "--", userCmd, args...)
   └─ procCtx = context.Background()（或基于 timeout 的派生 ctx）
5. 解析 UID/GID + 补充组（user.GroupIds）
6. cgroupFD, ok := cgroupManager.GetFileDescriptor(getProcType(req))
   └─ ProcType 选择规则见下表
7. SysProcAttr.Credential = {Uid, Gid, Groups}
8. applyCgroupFD(SysProcAttr, cgroupFD, ok)  # Linux only：设 CgroupFD + UseCgroupFD
9. ExpandAndResolve(cwd, user, defaults.Workdir) → 检查存在性 → cmd.Dir
10. 拼 env：PATH/HOME/USER/LOGNAME + defaults.EnvVars.All() + req.Envs（后者覆盖前者）
11. 创建 DataEvent MultiplexedChannel（buffer=64）
12. 创建 EndEvent MultiplexedChannel（buffer=0）
13. 启动 1~3 个读循环 goroutine（pty 或 stdout+stderr，见 §15.3）
14. 启动终结合 goroutine：outWg.Wait() → close(DataEvent.Source) → outCancel()
```

**`getProcType` 路由表**（`handler.go:340`）：

| 条件 | ProcessType | 关联 cgroup |
|---|---|---|
| `tag == "_system"` | System | （不创建独立 cgroup，envd 自身） |
| `req.Pty != nil` | PTY | `ptys` |
| 其它 | User | `user` |

**关键不变量**：`/bin/sh` 是包装命令的真实入口，用户看到的命令字符串（`userCmd`）只用于日志和错误信息。这意味着进程树深度 ≥ 2：envd → sh -c 'oom/ionice/nice wrapper' → 用户的 cmd。`p.cmd.Process.Pid` 是 sh 的 pid，不是用户 cmd 的 pid。

### 15.2 oom/ionice/nice 包装脚本

```sh
echo 100 > /proc/$$/oom_score_adj &&
exec /usr/bin/ionice -c 2 -n 4 /usr/bin/nice -n <delta> "${@}"
```

设计意图：

- `oom_score_adj = 100`：让用户进程优先被 OOM killer 选中，保护 envd 自身。
- `ionice -c 2 -n 4`：best-effort class，nice 等级 4（中位）—— 既不饿死用户 IO，也不和 envd 抢。
- `nice -n <delta>`：**相对**当前 envd 的 nice 调整，因为 envd 自身的 nice 不一定是 0（FC VM 启动时由 cgroup cpu.weight 决定）。
- `exec`：替换 sh 镜像，避免 sh 留下僵尸；用户 cmd 的 pid 仍是 sh 的 pid。

### 15.3 三路读循环（差异表）

| 维度 | PTY 模式 | stdout 模式 | stderr 模式 |
|---|---|---|---|
| 数据源 | `pty.StartWithSize` 返回的 tty *os.File | `cmd.StdoutPipe()` | `cmd.StderrPipe()` |
| chunk 大小 | 16 KiB (`ptyChunkSize`) | 32 KiB (`stdChunkSize`) | 32 KiB |
| EOF 信号 | `io.EOF` 或 `syscall.EIO`（PTY 关闭语义） | `io.EOF` | `io.EOF` |
| ProcessEvent_Data oneof | `Pty` | `Stdout` | `Stderr` |
| 字节计数 | `ptyBytes` | `stdoutBytes` | `stderrBytes` |

**`slices.Clone(readBuf[:n])` 是必须的**：`readBuf` 在下一次循环被复用，如果直接把切片塞进 channel，下游订阅者会看到被覆盖的数据。

**`HasSubscribers()` 短路**：在送入 Source channel 之前先检查订阅者，避免 PTY 长跑命令（如 `tail -f`）在无人订阅时无意义地 clone 字节。

### 15.4 MultiplexedChannel 扇出协议（`handler/multiplex.go`）

```
NewMultiplexedChannel(buf) → 启动 run() goroutine
                              ↓
   Source <- v  ─────────►  for v := range Source:
                              RLock()
                              subs := m.channels  // 取快照
                              RUnlock()
                              for each s in subs:
                                if s.isCancelled(): continue
                                select {
                                  case s.ch <- v:
                                  case <-s.done:
                                }
                            exited.Store(true)
                            Lock()
                            for each s: s.cancel(); close(s.ch)
                            m.channels = nil
```

**关键设计**：

- **`remove` 用 `slices.Concat` 而非 slice 删除**：构建新底层数组，让 `run()` 持有的快照迭代器保持合法。这是无锁读路径与并发删除共存的关键。
- **`cancel` 用 `sync.Once`**：订阅者可以多次调用 cancel（如 defer cancel + 显式 cancel）而不 panic。
- **`Fork` 双重检查 exited**：fast path 用 atomic load，进锁后再检查一次，覆盖 run() 在两者之间退出的竞态。
- **`Source` 关闭即终结**：所有订阅者 channel 都被关闭，下游 `for range` 自然退出。
- **buffer=0 vs buffer=N**：DataEvent 用 buffer=64（容忍突发输出），EndEvent 用 buffer=0（强制立刻交付，否则说明订阅者已死）。

### 15.5 Start RPC 流程（`start.go:23`）

```
handleStart(ctx, req, stream):
  ctx, cancel := context.WithCancelCause(ctx)
  defer cancel(nil)

  u           = permissions.GetAuthUser(ctx, defaults.User)
  timeout     = determineTimeoutFromHeader("Connect-Timeout-Ms")

  procCtx, cancelProc = context.Background() 或 WithTimeout(背景, timeout)
                       └─ 关键：基于背景 ctx，避免请求 cancel 杀进程

  proc := handler.New(procCtx, u, req.Msg, ..., cancelProc)

  startCh := NewMultiplexedChannel[Start](0)  # 本地 Start 事件多路复用
  defer close(startCh.Source)

  start, startCancel := startCh.Fork()       defer startCancel()
  data,  dataCancel  := proc.DataEvent.Fork() defer dataCancel()
  end,   endCancel   := proc.EndEvent.Fork()  defer endCancel()

  go sender():  # 真正向 stream 发送事件的 goroutine
    select {
      case <-ctx.Done(): cancel(ctx.Err()); return
      case event := <-start:
        stream.Send(Start{event})
        keepaliveTicker, resetKeepalive = GetKeepAliveTicker(req)
        defer keepaliveTicker.Stop()
        for {
          select {
            case <-keepaliveTicker.C: stream.Send(KeepAlive); (reset? no)
            case <-ctx.Done(): cancel(ctx.Err()); return
            case event, ok := <-data:
              if !ok: break dataLoop
              stream.Send(Data{event})
              resetKeepalive()      # 有真实数据，重置 keepalive 周期
          }
        }
      case event := <-end: stream.Send(End{event})
    }

  pid := proc.Start(timeout)               # 真正 exec（PTY 已在 New 中启动）
  s.processes.Store(pid, proc)
  start <- Start{Pid: pid}                  # 喂给本地 startCh，触发 sender 退出 select

  go proc.Wait()  # defer processes.Delete(pid)

  <-exitChan       # 等 sender goroutine 结束（避免 stream 提前关闭导致 envd panic）
  return ctx.Err()
```

**关键不变量**：

1. **`context.WithCancelCause`**：失败路径通过 `cancel(connect.NewError(...))` 把结构化错误传给 `ctx.Err()`，最终作为 RPC 错误返回。
2. **`procCtx` 永远基于 `context.Background()`**：客户端断开（`ctx.Done()`）不会杀进程；只有 `requestTimeout` 到期或显式 `SendSignal(SIGKILL/SIGTERM)` 才会。
3. **`<-exitChan` 阻塞**：保证 sender goroutine 完成所有 `stream.Send` 后 RPC 才返回，否则 Connect-RPC 关闭 stream 时会 panic。
4. **进程退出清理异步**：`go proc.Wait()` + `defer processes.Delete(pid)`，确保 `cmd.Wait()` 不阻塞 RPC 返回。
5. **Start 事件先入队，再 `proc.Start`**：通过让 sender goroutine 先阻塞在 `case event := <-start`，避免启动竞态（pid 还没拿到就尝试 Send）。

### 15.6 Wait 协议（`handler.go:447`）

```go
func (p *Handler) Wait() {
  <-p.outCtx.Done()       // 等 3 路读循环全结束 → 终结合关闭 Source
  err := p.cmd.Wait()     // 收割 sh 进程
  p.tty.Close()           // PTY 资源清理
  // 构造 End 事件（含 ExitCode/Exited/Status/Error）
  p.EndEvent.Source <- event
  // 写日志：stdout_bytes / stderr_bytes / pty_bytes
  p.cancel()              // 调用 cancelProc，触发 procCtx 取消（清理 timeout 资源）
}
```

**为什么 `<-outCtx.Done()` 在 `cmd.Wait()` 之前**：所有 stdout/stderr/pty 读循环退出后（管道关闭），我们才调 `cmd.Wait()`。否则 `cmd.Wait()` 会关闭管道，读循环拿到 EOF 后的最后一次 `Read` 可能 race。

**`p.cancel()` 在 End 事件之后**：注释明确指出，cancel 顺序在 Wait + EndEvent 之后，确保 cancel 不会影响命令执行或返回的事件内容。

---

## 16. cgroup v2 与 freeze 语义深度

`internal/services/cgroups/` 是 envd 资源治理的核心。设计上追求**最小开销、零竞态、跨平台可编译**。

### 16.1 cgroup v2 校验（防 v1 假阳）

```go
var st unix.Statfs_t
unix.Statfs(rootPath, &st)
if st.Type != unix.CGROUP2_SUPER_MAGIC {
  return nil, fmt.Errorf("not a cgroup2 filesystem (type=0x%x)", st.Type)
}
```

**为什么必须 statfs**：cgroup v1 上 `/sys/fs/cgroup` 是 tmpfs，`MkdirAll` + `Open` 会"成功"返回，但拿到的 fd 在 `clone3(CLONE_INTO_CGROUP)` 时会被内核以 `EBADF` 拒绝。这种 silent corruption 比 hard failure 更难调试。

### 16.2 创建 + 拿 fd 流程（`createCgroup`）

```
1. os.MkdirAll(fullPath, 0o755)
2. for name, value := range properties:
     f := os.OpenFile(path, O_WRONLY|O_TRUNC, 0)  # 关键：不用 O_CREATE
     f.WriteString(value)
     └─ 错误处理：ErrNotExist / ErrPermission → 跳过（控制器未启用）
                  其它 → 收集到 errs
3. unix.Open(fullPath, O_RDONLY, 0) → fd
```

**`writeCgroupProp` 不用 `O_CREATE` 的原因**：如果误进入 tmpfs fallback，`O_CREATE` 会静默创建一个普通文件假装成功；不用 `O_CREATE` 则会因文件不存在而失败，让问题暴露。

**属性不存在的容错**：cgroupfs 中某些属性（如 `io.weight`）需要先在 `subtree_control` 启用控制器才存在；在受限环境（如 FC VM 内）可能不可用，跳过即可。

### 16.3 文件描述符 + CLONE_INTO_CGROUP

`GetFileDescriptor(procType)` 返回 `unix.Open(cgroupPath, O_RDONLY, 0)` 拿到的 fd。这个 fd 通过 `applyCgroupFD` 写入 `SysProcAttr.CgroupFD` + `UseCgroupFD=true`，最终由 Go runtime 在 `clone3` 系统调用中传给内核。

**vs 旧式 fork → 写 cgroup.procs**：

| 维度 | CLONE_INTO_CGROUP | 旧式 fork + 写 procs |
|---|---|---|
| 竞态窗口 | 零（原子） | fork 与写 procs 之间存在窗口 |
| 早期资源计费 | 子进程从第一个指令起就在 cgroup | 第一个指令可能在 root cgroup |
| cgroup v2 eBPF | 正常工作 | 可能错过早期事件 |
| Go runtime 支持 | 1.22+ 的 `SysProcAttr.CgroupFD` | 全版本 |

### 16.4 Freeze / Unfreeze 语义

```go
// Freeze 写 cgroup.freeze = "1"
// Unfreeze 写 cgroup.freeze = "0"
// 文件存在性由 cgroup v2 子系统保证，不需要 O_CREATE
```

**`PostFreeze` 的 best-effort 语义**：循环 `userCgroupsToFreeze`，即使某一个 `Freeze` 失败也继续尝试下一个，最后用 `errors.Join` 汇总。这样在 cgroup 部分损坏的情况下，仍能冻结尽可能多的进程。

### 16.5 Close 协议

```go
for procType, fd := range c.cgroupFDs {
  unix.Close(fd)
  delete(c.cgroupFDs, procType)  // 关闭即从 map 移除，避免重复 close
}
return errors.Join(errs...)
```

**Close 是幂等的**：第二次调用时 map 已空，循环不执行。这对 envd 的优雅关闭至关重要（多个 goroutine 可能同时触发 Close）。

---

## 17. /init 状态机与令牌校验矩阵

`/init` 是 envd 中逻辑最复杂的端点。它必须同时满足：

- **串行化**：避免并发 /init 互相覆盖资源。
- **幂等**：Orchestrator 在 retry loop 中会反复调用。
- **安全**：过期/重放的请求不能解冻 cgroup。
- **资源安全**：请求体含 access token，必须擦除。
- **可恢复**：失败时不能留下半挂状态。

### 17.1 PostInit 完整时序

```
PostInit(w, r):
  defer r.Body.Close()
  ctx := r.Context()
  operationID := logs.AssignOperationID()
  logger := a.logger.With().Str("operationID", operationID).Logger()

  body := io.ReadAll(r.Body)
  defer memguard.WipeBytes(body)              # 安全擦除 body

  if len(body) > 0:
    json.Unmarshal(body, &initRequest)
    defer initRequest.AccessToken.Destroy()   # 安全销毁请求 token

    if !initLock.Acquire(ctx, 1):              # 串行化
      return 503

    defer initLock.Release(1)

    err := validateInitAccessToken(ctx, initRequest.AccessToken)
    if err != nil:
      writeInitError(w, err)                   # ← 注意：此处 return 前没有 unfreeze defer
      return                                   #   安全：未授权请求不能解冻

    defer unfreezeUserCgroups(ctx, logger)     # 每次都解冻（无论 timestamp 是否更新）

    if timestamp == nil || lastSetTime.SetToGreater(timestamp.UnixNano()):
      SetData(ctx, logger, initRequest)        # 仅在请求更新时执行

  go func():                                   # 异步刷新 MMDS（60s timeout）
    ctx, cancel := context.WithTimeout(背景, 60s)
    defer cancel()
    host.PollForMMDSOpts(ctx, mmdsChan, defaults.EnvVars)

  w.WriteHeader(204)
```

**defer 顺序的关键不变量**：

1. `WipeBytes(body)` 在最外层，确保所有路径都执行。
2. `Destroy()` 在 unmarshal 之后注册，覆盖所有早期 return 路径。
3. `initLock.Acquire/Release` 在一起，保证锁配对。
4. **`validateInitAccessToken` 在 `unfreezeUserCgroups` defer 之前**：未授权请求不会触发解冻 defer（因为它根本没注册），这是防重放攻击的关键。
5. `unfreezeUserCgroups` 使用 `context.WithoutCancel(ctx)`，HTTP 客户端取消后仍完成解冻。

### 17.2 令牌校验决策矩阵（`validateInitAccessToken`）

| `accessToken` 已设 | request token 已设 | MMDS hash 存在 | MMDS hash == hash(req) | MMDS hash == hash("") | 决策 |
|---|---|---|---|---|---|
| ✓ | ✓ | * | accessToken == req | * | **通过**（fast path） |
| * | * | ✓ | ✓ | * | **通过**（MMDS 匹配） |
| ✗ | * | ✗ | * | * | **通过**（首次安装） |
| * | ✗ | ✓ | * | ✓ | **通过**（token 重置授权） |
| ✓ | ✓ | ✓ | ✗ | ✗ | `ErrAccessTokenMismatch` (401) |
| * | ✗ | ✓ | * | ✗ | `ErrAccessTokenResetNotAuthorized` (401) |
| ✗ | ✓ | ✗ | * | * | `ErrAccessTokenMismatch` (401) |

**MMDS hash 三种值的意义**：

- `hash(token)`：Orchestrator 在 Resume 时把新 token 的 hash 写入 MMDS，要求 /init 携带对应 token。
- `hash("")`：Orchestrator 显式授权 token 清空（清空 access token 也需要授权）。
- `""`（空字符串）：MMDS 未配置或不可达，不授予任何权限。

### 17.3 MMDS 自愈流程（`checkMMDSHash`）

```
mmdsHash, err := mmdsClient.GetAccessTokenHash(ctx)
if err != nil:
  # 用户态 iptables PREROUTING/OUTPUT redirect 可能 shadow 我们的 RETURN 规则
  if pinErr := host.PinMMDSRoute(ctx); pinErr != nil:
    if ok, suppressed := pinMMDSWarnLimit.Allow():  # 10s 令牌桶
      logger.Warn("failed to pin MMDS iptables route", suppressed)
  mmdsHash, err = mmdsClient.GetAccessTokenHash(ctx)  # 重试一次
```

**为什么限速 warn**：Orchestrator 的 /init 是无限重试循环，如果 MMDS 持久损坏，每秒可能数十次失败。`pinMMDSWarnLimit = ratelimit.New(10 * time.Second)` 把告警降到每 10 秒一次，附带累计 suppressed 计数。

### 17.4 SetData 8 步（顺序敏感）

```
1. setSystemTime(timestamp)
   └─ shouldSetSystemTime: |now - timestamp| > 50ms 且 timestamp 不在未来 5s 之外
   └─ 失败仅 log，不返回错误（容忍时钟同步）

2. defaults.EnvVars.ReplaceUserVars(envVars)
   └─ 保留 internal 条目（如 E2B_SANDBOX_ID），仅替换 user 条目

3. accessToken:
   - if request.IsSet(): TakeFrom（转移所有权，无字节拷贝）
   - elif existing.IsSet(): Destroy（清空）

4. if HyperloopIP != nil: go SetupHyperloop(ip)  # 异步，不阻塞

5. if DefaultUser != "": defaults.User = user

6. if DefaultWorkdir != "": defaults.Workdir = workdir

7. if CaBundle != "": caCertInstaller.Install(ctx, pemBundle)
   └─ 失败返回错误（CA 是关键安全组件）

8. if VolumeMounts != nil: setupNFS(ctx, lifecycleID, mounts)
   └─ 失败返回错误（NFS 是关键功能）
```

**`shouldSetSystemTime` 算法**：

```go
diff := sandboxTime.Sub(hostTime)
return diff > 50*time.Millisecond || diff < -5*time.Second
```

- 过去 50ms 内：宿主机与沙箱时间基本一致，跳过 settimeofday（避免无谓 syscall）。
- 未来 5s 内：可能是网络延迟导致的合理偏差，跳过。
- 其它：调用 `settimeofday`（Linux）/ 警告（其它平台）。

### 17.5 错误码映射（`writeInitError`）

| 错误 | HTTP |
|---|---|
| `ErrAccessTokenMismatch` | 401 |
| `ErrAccessTokenResetNotAuthorized` | 401 |
| `setupNFS` 失败 | 400 |
| `caCertInstaller.Install` 失败 | 400 |
| `json.Unmarshal` 失败 | 400 |
| `initLock.Acquire` 失败 | 503 |

---

## 18. 端口转发状态机深度

`internal/port/` 实现"用户在沙箱内 listen 端口 → 自动通过 gateway IP 暴露"的能力。

### 18.1 Scanner pub-sub 模型（`scan.go`）

```
Scanner { period = 1s }
  ├─ scanTicker.C → gopsutil/net.Connections("tcp") → broadcast
  └─ subscribers map[id]*ScannerSubscriber
       └─ filter { IPs, State }
       └─ Messages chan []*Process

每个 subscriber 有自己的 filter 和 buffered Messages channel。
ScannerSubscriber 通过 AddSubscriber/Unsubscribe 动态管理。
```

**`ScanAndBroadcast` 流程**：

```
for {
  select {
    case <-s.stopCh: return
    case <-scanTicker.C:
      procs := net.Connections("tcp")
      for sub in subscribers:
        filtered := applyFilter(procs, sub.filter)
        select {
          case sub.Messages <- filtered:
          default:  # 慢消费者丢弃（保护 scanner）
        }
  }
}
```

### 18.2 Forwarder 三态状态机

每次扫描结果触发一次状态机演化：

```
┌─────────────────────────────────────────────────────────┐
│ 初始: ports map 为空                                      │
└─────────────────────────────────────────────────────────┘
                          ↓ 收到扫描结果
┌─────────────────────────────────────────────────────────┐
│ Phase 1: 把所有现有 ports 标 DELETE                       │
│   for v := range ports: v.state = DELETE                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Phase 2: 遍历扫描结果                                      │
│   key = fmt.Sprintf("%d-%d", pid, port)                  │
│   if key in ports:                                       │
│     ports[key].state = FORWARD  # 救回                   │
│   else:                                                   │
│     ports[key] = &PortToForward{state: FORWARD}          │
│     startPortForwarding(...)  # 启动 socat                │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Phase 3: 清理仍为 DELETE 的                                │
│   for v := range ports:                                  │
│     if v.state == DELETE:                                │
│       stopPortForwarding(v)  # kill -pgid                │
│       (不立即 delete map key，留给下次 Phase 2 检查)        │
└─────────────────────────────────────────────────────────┘
```

**key 的不变量**：`"pid-port"` 复合键保证：

- 同一进程监听多端口 → 各自独立转发。
- 不同进程监听同端口 → 区分（理论上不会发生，但 socat fork 模式可能产生子进程）。
- 进程崩掉后另一进程复用同端口 → 视为新条目（pid 不同）。

### 18.3 socat 命令与进程组管理

```
socat -d -d -d TCP4-LISTEN:<port>,bind=169.254.0.21,reuseaddr,fork TCP<family>:localhost:<port>
```

| 选项 | 作用 |
|---|---|
| `-d -d -d` | 最大诊断输出 |
| `bind=169.254.0.21` | 固定源 IP（gateway），不绑 0.0.0.0 避免冲突 |
| `reuseaddr` | 快速重启（避免 TIME_WAIT 阻塞） |
| `fork` | 每个连接 fork 子进程（并发支持） |

**进程组 SIGKILL**：

```go
cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
// ...
syscall.Kill(-p.socat.Process.Pid, syscall.SIGKILL)  # 负号 = 进程组
```

`socat fork` 模式下子进程会处理实际连接，单纯 kill 父 socat 会留下孤儿。`Setpgid: true` 让 socat 成为新进程组 leader，`kill(-pgid)` 一举收割所有 fork 出的子进程。

**cgroupFD 关联**：通过 `applyCgroupFD(SysProcAttr, cgroupFD, ok)` 把 socat 父进程（及其 fork 出的所有子进程，因 cgroup v2 默认继承）放入 `socats` cgroup，受 CPU/io/memory 限制。

### 18.4 `PortStateDelete` 不立即删除 map

代码注释明确：`p.socat = nil` 在 `stopPortForwarding` 内通过 defer 设置，但 map key 保留。这样下一轮扫描如果发现端口"重新"出现（实际是同一个 pid+port），不会再次启动 socat（仍走 `val.state = FORWARD` 分支）。直到下一次 Phase 3 检查时如果还是 DELETE，再次调 stopPortForwarding（幂等：`p.socat == nil` 直接 return）。

---

## 19. 日志流水线深度（HTTPExporter）

`internal/logs/exporter/exporter.go` 是 envd 日志的最终汇聚点。

### 19.1 启动协议（`sync.Once` 保护）

```
NewHTTPLogsExporter(ctx, mmdsChan)
  ├─ 创建空 exporter，triggers = chan struct{}{buffer=1}
  └─ go listenForMMDSOptsAndStart(ctx, mmdsChan)

listenForMMDSOptsAndStart:
  for {
    select {
      case <-ctx.Done(): return
      case opts, ok := <-mmdsChan:
        if !ok: return
        mmdsOpts.Store(opts)
        startOnce.Do(func(): go start(ctx))  # 只启动一次 flush loop
    }
  }
```

**为什么需要 `startOnce`**：MMDS opts 可能在生命周期内更新多次（虽然实际只在 Resume 时更新一次），但 flush loop 只能有一个，否则会出现两个 goroutine 抢 `w.logLock`。

### 19.2 flush loop（`start`）

```
for {
  select {
    case <-ctx.Done(): return
    case <-triggers:                          # buffer=1，多次触发合并
  }

  logs := getAllLogs()                         # 取走全部 + 重置 bufferedBytes
  if len(logs) == 0: continue
  opts := mmdsOpts.Load()
  if opts == nil: continue                     # MMDS 还没准备好

  for logLine in logs:
    logLineWithOpts, err := opts.AddOptsToJSON(logLine)
    if err != nil: jsonErrLog.log(err); continue
    if err := sendInstanceLogs(ctx, logLineWithOpts, opts.LogsCollectorAddress):
      sendErrLog.log(err); continue
}
```

**`AddOptsToJSON` 注入字段**：每条日志在发送前被注入 `sandbox_id` / `template_id`，方便 collector 索引到正确的沙箱。

**HTTP client 配置**：

```go
http.Client{
  Timeout:   10 * time.Second,
  Transport: &http.Transport{DisableKeepAlives: true},
}
```

`DisableKeepAlives: true` 的原因：每次 POST 后关闭连接，避免在长时间运行的沙箱中累积半开连接（FC VM 网络栈对连接表大小敏感）。

### 19.3 写入协议（`Write` + `addLogs`）

```
Write(logs []byte) (int, error):
  if len(logs) > maxLogLineBytes (192 KiB):
    oversizedLog.log(maxLogLineBytes)
    return len(logs), nil  # 静默丢弃，Loki 反正会拒

  logsCopy := make([]byte, len(logs))
  copy(logsCopy, logs)
  go addLogs(logsCopy)  # 异步，避免阻塞 zerolog
  return len(logs), nil

addLogs(logs):
  logLock.Lock()
  defer logLock.Unlock()

  # 容量保护：超过 maxBufferedBytes (8 MiB) 时驱逐最旧
  for bufferedBytes + len(logs) > maxBufferedBytes && len(logs) > 0:
    bufferedBytes -= len(logs[0])
    logs[0] = nil  # 帮助 GC
    logs = logs[1:]

  bufferedBytes += len(logs)
  logs = append(logs, logs)

  resumeProcessing()  # 触发 flush loop
```

**`Write` 同步拷贝 + 异步入队**：zerolog 调用 Write 时持有自己的锁，同步拷贝字节避免数据竞争，然后异步 addLogs 避免阻塞日志产生方。

### 19.4 容量保护的驱逐策略

`for ... && len(logs) > 0` 循环：

- 当 collector 不可达或产生速率 > 发送速率时，队列会膨胀。
- 驱逐最旧条目直到能容纳新条目。
- `len(logs) > 0` 兜底：如果连一条都放不下（极端情况），不进入死循环。
- 注释明确：**保持队列有界比保留旧日志更重要**。

### 19.5 三路 rate-limited logger

| logger | 触发条件 | floor |
|---|---|---|
| `jsonErrLog` | `AddOptsToJSON` 失败（极少见，基本是 zerolog 输出非 JSON） | 1 分钟 |
| `sendErrLog` | HTTP POST 失败（网络故障、collector 5xx） | 1 分钟 |
| `oversizedLog` | 单行 > 192 KiB（用户日志洪水） | 1 分钟 |

每个 logger 独立计数 suppressed，下次 emit 时附带累计计数（如 "error sending instance logs (suppressed 47 times)"），便于诊断。

### 19.6 令牌桶限速器（`ratelimit.Limiter`）

```go
Allow() (bool, int64):
  last := lastLogged.Load()
  if last != nil && time.Since(*last) <= floor:
    suppressed.Add(1)
    return false, 0
  now := time.Now()
  if !lastLogged.CompareAndSwap(last, &now):
    suppressed.Add(1)
    return false, 0
  return true, suppressed.Swap(0)  # 原子取出并清零
```

**lock-free 实现**：完全基于 atomic，无 mutex。`CompareAndSwap` 处理两个并发 caller 同时通过 `time.Since` 检查的竞态——只有一个能成功 swap，另一个走 suppressed 路径。

**`Swap(0)` 取出计数**：emit 时原子取出累计 suppressed 计数并清零，下次重新开始计数。

---

## 20. 并发模型与锁分类

| 锁类型 | 字段/实例 | 保护对象 | 临界区操作 |
|---|---|---|---|
| `semaphore.Weighted(1)` | `API.initLock` | /init 串行化 | Acquire(1) / Release(1) |
| `semaphore.Weighted(1)` | `API.freezeLock` | freeze/unfreeze/defer unfreeze 串行化 | Acquire(1) / Release(1) |
| `sync.Mutex` | `HTTPExporter.logLock` | logs slice + bufferedBytes | addLogs / getAllLogs |
| `sync.Mutex` | `Handler.stdinMu` | stdin pipe 写入 | WriteStdin / CloseStdin |
| `sync.RWMutex` | `MultiplexedChannel.mu` | channels slice | Fork / remove / HasSubscribers |
| `sync.Once` | `HTTPExporter.startOnce` | flush loop 单次启动 | start goroutine |
| `sync.Once` | `subscriber.once` | subscriber cancel 幂等 | cancel() |
| `atomic.Bool` | `MultiplexedChannel.exited` | run goroutine 退出标志 | Fork fast-path 检查 |
| `atomic.Bool` | `API.isMountingNFS` | NFS 挂载互斥 | CompareAndSwap(false, true) |
| `atomic.Int64` | `Limiter.suppressed` | suppressed 计数 | Add / Swap |
| `atomic.Int64` | `Handler.stdoutBytes/stderrBytes/ptyBytes` | 流量统计 | Add |
| `atomic.Pointer[MMDSOpts]` | `HTTPExporter.mmdsOpts` | MMDS opts 缓存 | Store / Load |
| `atomic.Pointer[time.Time]` | `Limiter.lastLogged` | 上次 emit 时间 | CompareAndSwap |
| `sync.Map` | `API.mountedPaths` | path → lifecycleID | Load / Store / Delete |
| `utils.Map[uint32, *Handler]` | `Service.processes` | pid → Handler | Store / Load / Delete |
| `utils.Map[K,V]` | `EnvVars.user/internal` | env vars | Replace / All |

### 20.1 无锁读路径

- `Handler.Pid()` / `userCommand()`：纯字段读取，无锁。
- `MultiplexedChannel.HasSubscribers()`：仅 RLock，与 Fork 并发安全。
- `Service.processes.Load(pid)`：基于 `sync.Map.Load`，无锁。
- `HTTPExporter.mmdsOpts.Load()`：atomic.Pointer 读取。

### 20.2 `context.WithoutCancel` 的三个用途

| 用途 | 文件 | 原因 |
|---|---|---|
| `PostUnfreeze` acquire | `init.go:296` | Orchestrator pause 失败回滚时可能已取消 HTTP ctx，但解冻必须完成 |
| `unfreezeUserCgroups` | `init.go:323` | /init 延迟解冻的 defer 不应受请求 ctx 取消影响 |
| NFS umount | `init.go`（setupNFS 内部） | umount 是清理操作，必须完成 |

### 20.3 锁获取顺序（防死锁）

在 /init 路径中可能同时持有：

1. `initLock`（外层，请求级）
2. `freezeLock`（unfreezeUserCgroups 内部）

`PostFreeze`/`PostUnfreeze` 不获取 `initLock`，所以没有反向获取的情况。锁顺序单向：`initLock → freezeLock`，不会死锁。

### 20.4 pub-sub 模型

| 模型 | 生产者 | 消费者 |
|---|---|---|
| Scanner → Forwarder | `ScanAndBroadcast` goroutine | `Forwarder` 单订阅者 |
| MMDSChan → HTTPExporter | `PollForMMDSOpts` | `listenForMMDSOptsAndStart` 单消费者 |
| MultiplexedChannel | 三路读循环 | N 个 Fork 订阅者 |
| triggers chan | `addLogs` | `start` flush loop |

所有 channel 都是单生产者或单消费者，避免多生产者竞争。

---

## 21. 跨平台 syscall 桥接

envd 必须在 Linux/Firecracker 内运行，同时允许 macOS 开发机上 `go build` + `go test`。每个 Linux-only syscall 都通过 build tag 文件对实现：

| 文件对（Linux / 其它） | Linux 真实行为 | 非 Linux 行为 | 调用方 |
|---|---|---|---|
| `clock_linux.go` / `clock_other.go` | `settimeofday` syscall | 警告并不修改时钟 | `setSystemTime` |
| `mmds_route_linux.go` / `mmds_route_other.go` | iptables 规则 pin | no-op | `host.PinMMDSRoute` |
| `forward_cgroupfd_linux.go` / `forward_cgroupfd_other.go` | 设置 `SysProcAttr.CgroupFD` | no-op | `port.startPortForwarding` |
| `cgroupfd_linux.go` / `cgroupfd_other.go` | 设置 `SysProcAttr.CgroupFD` | no-op | `handler.New` |
| `cgroup2.go` / `cgroup2_stub.go` | 真实 cgroup v2 | 空实现 | `cgroups.NewCgroup2Manager` |

### 21.1 Linux 关键 syscall 列表

| syscall | 用途 | 文件 |
|---|---|---|
| `unix.Statfs` + `CGROUP2_SUPER_MAGIC` | cgroup v2 校验 | `cgroup2.go` |
| `unix.Open` | 拿 cgroup 目录 fd | `cgroup2.go` |
| `unix.Close` | 释放 cgroup fd | `cgroup2.go` |
| `clone3(CLONE_INTO_CGROUP)` | 把进程原子地放入 cgroup | Go runtime（通过 `SysProcAttr.CgroupFD`） |
| `settimeofday` | 设置系统时钟 | `clock_linux.go` |
| `syscall.Getpriority` / `Setpriority` | nice 值 | `handler.go` |
| `syscall.Kill(-pgid, SIGKILL)` | 进程组 SIGKILL | `port/forward.go` |
| `syscall.Signal` | 进程信号 | `handler.go` |
| `unix.Statfs` (磁盘) | 磁盘指标 | `host/metrics.go` |
| `exec.Command("iptables", ...)` | MMDS 路由 pin | `mmds_route_linux.go` |
| `exec.Command("mount", "...")
exec.Command("umount", ...)` | NFS 挂载/卸载 | `api/init.go` |
| `exec.Command("findmnt", ...)` | 检测挂载状态 | `api/init.go` |

### 21.2 非 Linux 平台的语义保证

`cgroup2_stub.go` 保留 API 形状但所有方法返回 stub 数据或 no-op。这意味着：

- **单元测试在 macOS 上可运行**：Mock 化的 cgroupManager 通过接口注入。
- **集成测试必须 Linux**：真正调用 `clone3`、`settimeofday` 的测试用 `//go:build linux` 守门。
- **生产环境校验在启动时**：`main.go` 通过 `isNotFC` flag 跳过 MMDS 轮询，但 cgroup 创建失败会 fatal。

---

## 22. 代码组织约定

### 22.1 build tag 规范

所有 Linux-only 文件首行：

```go
//go:build linux
```

对应 stub：

```go
//go:build !linux
```

不允许在普通文件中通过 `runtime.GOOS == "linux"` 分支处理（除极少数情况），保持编译时校验。

### 22.2 zerolog 时间字段约定

| 字段名 | 类型 | 含义 |
|---|---|---|
| `timestamp` | string (RFC3339Nano) | 事件时间 |
| `operationID` | string | 请求级追踪 ID（由 `logs.AssignOperationID` 分配） |
| `event_type` | string | 事件类型（如 `process_start` / `process_end`） |

`logger.With().Str(string(logs.OperationIDKey), operationID).Logger()` 是请求级 logger 的标准构造方式，所有该请求的日志自动带 operationID。

### 22.3 错误 wrapping

envd 使用 `errors.Join` 和 `%w` 包装错误：

```go
return fmt.Errorf("failed to setup NFS volumes: %w", err)
return errors.Join(errs...)  // 多 cgroup freeze 失败汇总
```

包装链保持 sentinel 错误可达：

```go
case errors.Is(err, ErrAccessTokenMismatch), errors.Is(err, ErrAccessTokenResetNotAuthorized):
    w.WriteHeader(http.StatusUnauthorized)
```

### 22.4 nolint 注释约定

代码中存在 `//nolint:contextcheck // TODO: fix this later` 这类注释，标记已知问题：

- `procCtx` 用 `context.Background()` 是有意为之（避免请求 cancel 杀进程），但 linter 检测不到语义。
- `go func() { ... } //nolint:contextcheck` 标记异步 goroutine 中重新派生 ctx 的地方。

这些不是真正的"待修复"，更多是"已评估的权衡"。

### 22.5 测试约定

| 测试类型 | 位置 | 守门 |
|---|---|---|
| 单元测试 | `*_test.go` 同目录 | 全平台可运行 |
| Linux-only 测试 | `*_linux_test.go` | `//go:build linux` |
| 集成测试 | `packages/envd/integration/`（如有） | Linux only |
| Mock 生成 | `mockery` | `internal/services/spec/filesystem/filesystemconnect/mocks/` |

测试用 `testify/assert` + `testify/require`，race detector 默认开启（`make test` = `go test -race -v ./...`）。

### 22.6 "为什么"注释规范

envd 的注释大多解释**为什么**而非**做什么**：

```go
// Wrap in a shell that resets oom_score_adj, ioprio (ionice best-effort/4), and nice.
// User command string for logging (without the internal wrapper details).
niceDelta := defaultNice - currentNice()
```

而不是：

```go
// Create the command and compute nice delta  ← 这是做什么，没用
```

例外：复杂的状态机（如 `Forwarder.StartForwarding`）会有 phase 注释解释每个循环的目的，这属于"为什么这么分阶段"。

### 22.7 命名约定

| 前缀/后缀 | 含义 | 示例 |
|---|---|---|
| `ProcessType*` | cgroup 类型枚举 | `ProcessTypeUser` / `ProcessTypePTY` / `ProcessTypeSocat` / `ProcessTypeSystem` |
| `PortState*` | 端口转发状态枚举 | `PortStateForward` / `PortStateDelete` |
| `ErrAccessToken*` | /init 令牌 sentinel 错误 | `ErrAccessTokenMismatch` |
| `max*` / `default*` | 常量 | `maxLogLineBytes` / `defaultGatewayIP` |
| `*_linux.go` / `*_other.go` | 平台特定实现 | `clock_linux.go` |

私有字段使用驼峰（如 `cgroupFDs`、`mmdsOpts`），公开 API 使用 PascalCase（如 `HTTPExporter.Write`）。
