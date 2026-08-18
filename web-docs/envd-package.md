# `packages/envd/` 原理详解

> 本文梳理 E2B 平台 **沙箱内 daemon**（envd）的完整工作原理、protobuf 契约、运行模式与核心子系统。所有结论基于仓库源码与 `.understand-anything/knowledge-graph.json`。

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
const Version = "0.6.1"
```

`pkg.Version` 是个 **不参与运行时常量**，但 **参与构建时常量**。CLAUDE.md 明确：

> The envd version in `pkg/version.go` must be bumped on every behavioral change (not comments/docs-only changes)

- 通过 `envd --version` / `envd --commit` 查询。
- 模板构建期 `e2b template build` 会读取这个 version 决定模板缓存键——**版本不一致意味着 envd 行为变了，缓存的镜像不能用**。
- 这是一个 **不可绕过的强约束**——任何改了 envd 行为的 PR 都必须 bump。

## 2. 目录结构

```
packages/envd/
├── go.mod                       # 独立 module（connectrpc、chi、zerolog、pty、cgroups）
├── go.sum
├── Makefile                     # build / generate / start-docker
├── debug.Dockerfile             # 调试镜像
├── main.go                      # 入口：flag 解析、MMDS 轮询、路由、HTTP server
├── pkg/
│   └── version.go               # Version 常量
├── spec/                        # Protobuf 契约（手工写，buf codegen）
│   ├── process/process.proto    # 进程管理（Start/Connect/SendInput/SendSignal/...）
│   ├── filesystem/filesystem.proto  # 文件系统（Stat/MakeDir/Move/List/Remove/Watch）
│   ├── envd.yaml                # buf 工作区
│   ├── buf.gen.yaml             # buf codegen 配置（产出 Connect handlers）
│   ├── buf.gen.shared.yaml      # 产出到 shared/pkg/grpc/envd/（SDK 用的客户端 stub）
│   └── generate.go              # `go generate` 入口
└── internal/
    ├── api/                     # OpenAPI/JSON-HTTP 接口（v1 老接口，保留向后兼容）
    │   ├── api.gen.go           # oapi-codegen 生成的 type
    │   ├── store.go             # API struct + 健康检查
    │   ├── auth.go              # access token + 签名校验
    │   ├── init.go              # /init（orchestrator 推送配置）
    │   ├── upload.go / download.go / compose.go  # 旧版文件操作
    │   └── secure_token.go      # memguard 保护的内存
    ├── execcontext/             # 进程执行的默认上下文
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
    │   ├── scan.go              # 周期扫描 LISTEN 端口
    │   ├── scanfilter.go        # 过滤 127.0.0.1/localhost/::1
    │   ├── forward.go           # 启动 socat 转发到 eth0 IP
    │   └── scanSubscriber.go    # pub-sub 模型
    ├── services/
    │   ├── cgroups/             # cgroup v2 资源管理
    │   │   ├── iface.go         # Manager 接口
    │   │   ├── cgroup2.go       # 真实现（linux build tag）
    │   │   ├── cgroup2_stub.go  # stub（非 linux）
    │   │   └── noop.go          # --no-cgroups 用的空实现
    │   ├── filesystem/          # Filesystem service（Connect）
    │   │   ├── service.go       # Service struct + Handle 注册
    │   │   ├── stat.go / dir.go / move.go / remove.go
    │   │   ├── watch.go         # WatchDir（流式）
    │   │   └── watch_sync.go    # CreateWatcher / GetWatcherEvents / RemoveWatcher（轮询）
    │   ├── process/             # Process service（Connect）
    │   │   ├── service.go       # Service struct + Handle 注册 + getProcess 选择器
    │   │   ├── start.go         # Start（server stream）
    │   │   ├── connect.go       # Connect（订阅已存在进程）
    │   │   ├── list.go / signal.go / update.go
    │   │   ├── input.go         # SendInput / StreamInput / CloseStdin
    │   │   ├── start_test.go
    │   │   └── handler/         # 单进程的 Handler
    │   │       ├── handler.go   # fork+exec+pty 封装
    │   │       └── multiplex.go # MultiplexedChannel 泛型 fan-out
    │   ├── legacy/              # 老版本 SDK 兼容
    │   │   ├── interceptor.go   # ConversionInterceptor
    │   │   └── stream.go        # 协议差异补偿
    │   └── spec/                # buf codegen 出的 Go 桩（不直读）
    └── utils/                   # EnvVars、AtomicMax、multipart
```

## 3. 启动流程（`main.go`）

```
main()
  ├─ parseFlags()                 # --port, --cgroup-root, --no-cgroups, --verbose, --isnotfc, --version, --commit
  ├─ if --version: 打印 pkg.Version
  ├─ if --commit:  打印 commitSHA
  └─ run()
        ├─ ctx, cancel := WithCancel(Background)
        ├─ defaults := execcontext.Defaults{User: "root", EnvVars}
        ├─ 写 /run/e2b/.E2B_SANDBOX 标记文件
        ├─ 启动 PollForMMDSOpts goroutine（如果不是 isnotfc）
        ├─ logs.NewLogger(ctx, isNotFC, verbose, mmdsChan)
        ├─ chi.NewRouter()
        ├─ filesystem.Handle(m, ...)
        ├─ createCgroupManager() → Manager（三种实现之一）
        ├─ process.Handle(m, ..., cgroupManager)
        ├─ api.New(...) + service.WithAuthorization(authn.Wrap(handler))
        ├─ http.Server{ReadTimeout=0, WriteTimeout=0, IdleTimeout=640s}
        ├─ portScanner := NewScanner(1s) → 后台 ScanAndBroadcast()
        ├─ portForwarder := NewForwarder(...) → 后台 StartForwarding()
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

## 5. 进程管理（`internal/services/process/`）

### 5.1 整体结构

```
process.Service
  ├─ processes  : Map[uint32 → *handler.Handler]   // 进程表
  ├─ defaults   : *execcontext.Defaults
  ├─ cgroupManager : cgroups.Manager
  └─ Handle(server) → server.Mount("/process.v1.Process/", NewProcessHandler(...))
```

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
    stdinMu sync.Mutex
    stdin   io.WriteCloser

    stdoutBytes, stderrBytes, ptyBytes atomic.Int64  // 累计输出字节

    DataEvent *MultiplexedChannel[rpc.ProcessEvent_Data]
    EndEvent  *MultiplexedChannel[rpc.ProcessEvent_End]
}
```

构造时的关键步骤（`New(...)`）：

1. **OOM 防护包装**：
   ```go
   niceDelta := defaultNice - currentNice()
   oomWrapperScript := fmt.Sprintf(
       `echo %d > /proc/$$/oom_score_adj && exec /usr/bin/ionice -c 2 -n 4 /usr/bin/nice -n %d "${@}"`,
       defaultOomScore, niceDelta)
   cmd := exec.CommandContext(ctx, "/bin/sh", "-c", oomWrapperScript, "--", req.GetProcess().GetCmd()... )
   ```
   实际进程用 `sh -c '... exec ...'` 启动，**在子进程入口处**：
   - 设 `oom_score_adj=100`（OOM-killer 优先选它而不是 envd 本身）
   - `ionice -c 2 -n 4`：best-effort IO 调度类、优先级 4（低）
   - `nice -n 0`：归一化 nice

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
 │                        │ determineTimeoutFromHeader("Connect-Timeout-Ms")
 │                        │ handler.New(...)
 │                        │ ─────────────────────────►│
 │                        │                           ├─ oom-wrapper 构造
 │                        │                           ├─ cgroupFD 准备
 │                        │                           ├─ cred.Uid/Gid 设置
 │                        │                           ├─ CWD resolve
 │                        │                           └─ DataEvent/EndEvent 准备
 │                        │ ◄── *Handler ─────────────│
 │                        │ NewMultiplexedChannel[Start]
 │                        │ proc.Start(requestTimeout)
 │                        │ ─────────────────────────►│
 │                        │                           ├─ (PTY: pty.Start)
 │                        │                           ├─ exec.Command.Start
 │                        │                           └─ goroutine: copy cmd.Stdout/Stderr → DataEvent
 │ ◄── StartResponse{Start{pid: N}} ────│
 │                        │ s.processes.Store(N, proc)
 │                        │ start <- StartEvent{pid:N}    // bootstrap startMultiplexer
 │                        │                              │
 │ for {                  │                              │
 │   ← StartResponse{Data{stdout|stderr|pty}}            │
 │   ← StartResponse{KeepAlive}                          │
 │ }                    │                              │
 │ process exits        │                              │
 │ ◄── StartResponse{End{exit_code, status, error}} ───│
 │ processes.Delete(pid) │                              │
```

> 注意：`proc.Start` 内部还做 `pty.InheritSize`、把 master fd 包装成 `*os.File` 存到 `Handler.tty`。

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
}
```

`Handle(mux, ...)` 把 service 注册到 `/filesystem.v1.Filesystem/`，并接 `legacy.Convert()` interceptor 兼容老 SDK。

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

### 8.1 三种进程类型

```go
const (
    ProcessTypePTY   ProcessType = "PTY"
    ProcessTypeSocat ProcessType = "Socat"
    ProcessTypeUser  ProcessType = "User"
)
```

每种类型对应不同 cgroup 资源限额（见 `main.go` 的 `opts`）：

| ProcessType | cpu.weight | io.weight | memory.high/max | memory.min/low |
| --- | --- | --- | --- | --- |
| **PTY** | 200 | default 50 | memoryMax = `MemTotal - min(MemTotal/8, 128MB)` | — |
| **Socat**（端口转发） | 150 | default 50 | — | 5MB / 8MB |
| **User**（用户进程） | 50 | default 10 | 与 PTY 相同 | — |

要点：
- **PTY 比 User 优先级高**：交互式命令响应优先于后台计算。
- **Socat 拿 memory.low 8MB 保护**：端口转发不能饿死。
- **`memory.high = memory.max`**：避免 throttle 长时间延迟，触发直接 OOM-kill。
- **`MaxMemoryReserved = min(MemTotal/8, 128MB)`**：给 host kernel 留 buffer。

### 8.2 实现机制

```go
fd, _ := unix.Open(fullPath, unix.O_RDONLY, 0)
```

- 用 `clone3(CLONE_INTO_CGROUP)` 需要一个 cgroup 目录的 fd。
- envd 启动时**提前打开**三个 cgroup 目录的 fd（在 main 里），存到 `Cgroup2Manager.cgroupFDs`。
- `Handler.New` 时调 `cgroupManager.GetFileDescriptor(getProcType(req))` 取出对应 fd 喂给 `cmd.SysProcAttr`。

### 8.3 `Freeze` / `Unfreeze`

```go
func (c Cgroup2Manager) Freeze(procType ProcessType) error   { return c.setFreezeState(procType, "1") }
func (c Cgroup2Manager) Unfreeze(procType ProcessType) error { return c.setFreezeState(procType, "0") }

func (c Cgroup2Manager) setFreezeState(procType ProcessType, value string) error {
    return writeCgroupProp(filepath.Join(path, "cgroup.freeze"), value)
}
```

- 写 `cgroup.freeze` 文件触发 kernel freeze/thaw。
- 配套 `freezeLock` semaphore（`semaphore.Weighted(1)`）——**串行化** PostFreeze / PostUnfreeze / init deferred unfreeze。
- `PostFreeze` 在 sandbox pause 前由 orchestrator 调用；`/init` 启动时**defer 一次 unfreeze** 让 resume 后进程能跑。

## 9. 自动端口转发（`internal/port/`）

### 9.1 为什么需要它

E2B VM 内网络：
- `eth0` IP 是 `169.254.0.21`（gateway 模式）
- 用户进程监听 `127.0.0.1:<port>`（loopback，VM 内部可达）
- **从 VM 外部想访问这个端口**——需要 socat 把 eth0:port 转到 127.0.0.1:port

### 9.2 扫描器

```go
period := 1000 * time.Millisecond
for {
    processes, _ := net.Connections("tcp")        // gopsutil
    for _, sub := range s.subs.Items() {
        sub.Signal(processes)
    }
    select {
    case <-s.scanExit: return
    default: time.Sleep(s.period)
    }
}
```

- 1s 周期扫一次 LISTEN socket（`net.Connections("tcp")`）。
- pub-sub：所有 `ScannerSubscriber` 都收到同一份连接列表。
- **Filter**：`IPs in [127.0.0.1, localhost, ::1]` + `State == LISTEN`。

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

最后 **defer 一次 unfreeze user/pty/socat cgroups**——保证每次 init 都会 thaw（即使 SetData 失败）。

并发控制：
- `initLock semaphore.Weighted(1)`：init 全局串行（orchestrator 的 retry loop 会重发）。
- `lastSetTime utils.AtomicMax`：记录最后应用过的 timestamp，**只接受时间戳严格递增的 init**（防 replay）。
- **每个 init 都会执行 unfreeze**（`defer a.unfreezeUserCgroups(ctx, logger)`），即使 init 数据被 timestamp 拒绝——这样 pause→resume 后不需要额外调 unfreeze。

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

### 13.1 端点（`api.gen.go` 推断）

| 方法 | 路径 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| `GET` | `/health` | 健康探针 | 公开 |
| `GET` | `/metrics` | 资源指标（CPU/Mem/Disk） | 公开（VM 内网） |
| `POST` | `/init` | 接收 orchestrator 配置 | **MMDS hash 校验** |
| `POST` | `/freeze` | pause 前 freeze cgroup | 公开（VM 内网） |
| `POST` | `/unfreeze` | 撤销 freeze | 公开（VM 内网） |
| `GET` | `/files` | 下载文件 | token 或签名 |
| `POST` | `/files` | 上传文件（multipart 或 raw octet-stream） | token 或签名 |

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
type Defaults struct {
    User    string
    Workdir *string
    EnvVars *utils.EnvVars
}
```

- `User`：默认 `root`（`/init` 可改）。
- `Workdir`：可空。
- `EnvVars`：内部 map，每次 `Store` 写一次，**用户进程通过 `os.Getenv` 看到**。

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
   │                                                  ├─ defer unfreezeUserCgroups
   │                                                  │  (Background ctx 防止 ctx 取消影响)
   │ ◄──── 204 ──────────────────────────────────────│
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
16. **错误码统一**。Connect 错误码（`CodeNotFound` / `CodeUnauthenticated` / `CodeInvalidArgument`）和 HTTP 状态码（401/403/404）一一对应，跨协议栈语义一致。
17. **backward compatibility 优先**。`ConnectStreamInput` 是 client stream（新）但保留 `SendInput` unary（旧）。`CreateWatcher/GetWatcherEvents`（新轮询）和 `WatchDir`（旧流式）并存。

## 18. 关键文件速查表

| 主题 | 文件 | 作用 |
| --- | --- | --- |
| 版本 | `packages/envd/pkg/version.go` | `Version` 常量（构建时 bake） |
| 入口 | `packages/envd/main.go` | flag、MMDS 轮询启动、cgroup 创建、HTTP server |
| 进程 proto | `packages/envd/spec/process/process.proto` | Process 服务契约 |
| 文件 proto | `packages/envd/spec/filesystem/filesystem.proto` | Filesystem 服务契约 |
| 进程实现 | `packages/envd/internal/services/process/service.go` | Service struct + Handle + getProcess |
| 单进程 | `packages/envd/internal/services/process/handler/handler.go` | fork+exec+pty+cgroup 封装 |
| 事件多路复用 | `packages/envd/internal/services/process/handler/multiplex.go` | MultiplexedChannel[T] 泛型 fan-out |
| Start 时序 | `packages/envd/internal/services/process/start.go` | 启进程、拼流、keepalive |
| 输入 | `packages/envd/internal/services/process/input.go` | SendInput / StreamInput / CloseStdin |
| 文件实现 | `packages/envd/internal/services/filesystem/service.go` | Service + Handle |
| 文件监听 | `packages/envd/internal/services/filesystem/watch_sync.go` | CreateWatcher / GetWatcherEvents / RemoveWatcher |
| MMDS | `packages/envd/internal/host/mmds.go` | 50ms 轮询 + 持久化 + log 转发 |
| MMDS 自愈 | `packages/envd/internal/host/mmds_route_linux.go` | iptables pin 169.254.169.254 |
| cgroup 接口 | `packages/envd/internal/services/cgroups/iface.go` | Manager |
| cgroup v2 | `packages/envd/internal/services/cgroups/cgroup2.go` | Cgroup2Manager 真实现 |
| 端口扫描 | `packages/envd/internal/port/scan.go` | gopsutil + pub-sub |
| 端口转发 | `packages/envd/internal/port/forward.go` | socat 增量算法 |
| 权限 | `packages/envd/internal/permissions/authenticate.go` | Basic Auth → *user.User |
| 路径 | `packages/envd/internal/permissions/path.go` | ~ 展开、相对路径解析、目录创建 |
| Keepalive | `packages/envd/internal/permissions/keepalive.go` | Keepalive-Ping-Interval 头解析 |
| 旧 SDK | `packages/envd/internal/services/legacy/interceptor.go` | `connect-python` 兼容层 |
| API 状态 | `packages/envd/internal/api/store.go` | API struct + New + Health + Metrics |
| Access Token | `packages/envd/internal/api/auth.go` | WithAuthorization + 路径签名 |
| Secure Token | `packages/envd/internal/api/secure_token.go` | memguard 包装的 token |
| Init | `packages/envd/internal/api/init.go` | /init 处理 + NFS 挂载 + freeze/unfreeze |
| 上传/下载 | `packages/envd/internal/api/{upload,download}.go` | multipart + raw octet-stream + gzip |
| 默认上下文 | `packages/envd/internal/execcontext/context.go` | Defaults（user/workdir/envvars） |
| 工具 | `packages/envd/internal/utils/atomic.go` | AtomicMax（init timestamp 严格递增） |
