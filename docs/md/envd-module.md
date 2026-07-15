# E2B envd(in-VM daemon)详解

> 本文档详细描述 E2B Infrastructure 中 **envd** 子系统的设计、架构、接口、生命周期与关键实现。
>
> envd 是每个 E2B Firecracker microVM 内必驻的"代理进程",承担进程管理、文件系统操作、端口转发、日志收集、cgroup 管理等职责,是 SDK 与 sandbox 内部世界交互的桥梁。
>
> **相关文档**:
> - [`template-module.md`](template-module.md) — Template 模版系统(envd 自身的版本与 template 绑定)
> - [`sandbox-management.md`](sandbox-management.md) — Sandbox 管理(orchestrator 通过 gRPC 调 envd)
> - [`snapshots.md`](snapshots.md) — Snapshot / pause / resume(envd 配合 freeze/collapse)
> - [`orchestrator-module.md`](orchestrator-module.md) — Orchestrator(对 envd 的反向调用)

---

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、启动流程与架构](#三启动流程与架构)
- [四、Connect RPC 服务](#四connect-rpc-服务)
- [五、REST API 与 OpenAPI](#五rest-api-与-openapi)
- [六、权限与安全模型](#六权限与安全模型)
- [七、进程管理](#七进程管理)
- [八、端口转发](#八端口转发)
- [九、cgroups 资源隔离](#九cgroups-资源隔离)
- [十、MMDS — 与 Firecracker 通信](#十mmds--与-firecracker-通信)
- [十一、日志、指标与可观测性](#十一日志指标与可观测性)
- [十二、`/init` 的完整生命周期](#十二init-的完整生命周期)
- [十三、pause / resume 配合](#十三pause--resume-配合)
- [十四、Legacy SDK 兼容](#十四legacy-sdk-兼容)
- [十五、Proto 与代码生成](#十五proto-与代码生成)
- [十六、配置、Flag 与环境变量](#十六配置flag-与环境变量)
- [十七、关键代码文件索引](#十七关键代码文件索引)
- [十八、设计要点与权衡](#十八设计要点与权衡)
- [十九、常见问题与排查](#十九常见问题与排查)
- [附录 A:REST 端点速查](#附录arest-端点速查)
- [附录 B:Connect RPC 速查](#附录bconnect-rpc-速查)
- [附录 C:术语表](#附录c术语表)

---

## 一、概述

### 1.1 envd 是什么

envd 是 **每个 E2B Firecracker microVM 内必驻的代理进程**,运行在 microVM 的 guest 内(不是 host),由 `template-manager` 在 build template 时打包进 rootfs,并由 `orchestrator` 通过 Firecracker `boot-source` 的 init 机制启动。

它的核心职责:

| 职责 | 实现位置 |
|------|---------|
| **进程管理**(start/list/signal/input) | `internal/services/process/` |
| **文件系统操作**(stat/mkdir/move/remove/watch) | `internal/services/filesystem/` |
| **REST 文件上传/下载** | `internal/api/upload.go`、`download.go` |
| **端口转发**(将外部访问映射到 in-VM 进程) | `internal/port/` |
| **cgroup 资源隔离与 freeze/unfreeze** | `internal/services/cgroups/` |
| **日志/指标导出**(出 VM 到 Loki) | `internal/logs/exporter/` |
| **MMDS 元数据读取** | `internal/host/mmds.go` |
| **CA 证书注入** | `internal/host/cacerts.go` |
| **环境变量管理** | `internal/utils/envvars.go` |

### 1.2 关键定位

```
┌─────────────────────────────────────────────────────────────┐
│ Host(orchestrator 节点)                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Firecracker microVM                                  │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │ Linux guest(rootfs)                         │    │   │
│  │  │                                              │    │   │
│  │  │  ┌────────────────────────────────────────┐ │    │   │
│  │  │  │ envd(本文件描述的对象)                │ │    │   │
│  │  │  │  - 监听 0.0.0.0:49983                  │ │    │   │
│  │  │  │  - Connect RPC + REST                  │ │    │   │
│  │  │  │  - 进程/FS/端口/cgroup 全在它手里     │ │    │   │
│  │  │  └────────────┬───────────────────────────┘ │    │   │
│  │  │               │                              │    │   │
│  │  │  ┌────────────▼─────────┐  ┌──────────────┐ │    │   │
│  │  │  │ 用户进程(由 envd 启)│  │ socat(由 envd)│ │    │   │
│  │  │  └──────────────────────┘  └──────────────┘ │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  169.254.169.254 ← MMDS(只对 guest 可见,envd 读它)        │
└─────────────────────────────────────────────────────────────┘
        ▲
        │ HTTP / Connect-RPC
        │
┌───────┴────────┐
│ SDK / 用户     │  ←→ orchestrator proxy ←→ envd:49983
└────────────────┘
```

### 1.3 关键心智模型

> envd 的设计有 **三个反直觉的点**,先理解这三点能省去后续 80% 的困惑:
>
> 1. **双协议并存**:envd 同时暴露 **Connect RPC**(基于 HTTP/2,SDK 走它做高性能流式调用)和 **REST/OpenAPI**(基于 HTTP/1.1 + chi router,SDK 走它做文件上传下载等)。两者共享同一个 TCP 端口 49983,通过 `Content-Type` 路由。
>
> 2. **envd 没有持久化**:所有状态(access token、env vars、默认用户)都在内存里。microVM pause → resume 后,状态从 MMDS 重新拉,然后由 `/init` 重新设置。所以 `/init` 是幂等的、可被多次调用的"重新初始化"入口。
>
> 3. **端口转发是动态的**:用户进程启动后监听任意端口,envd 的 scanner 每秒扫一次 listening sockets,自动为每个新端口 spawn 一个 socat 把外部流量桥接进来。**没有事先注册的端口映射表**。

### 1.4 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│ main.go(入口)                                                  │
│  ├─ flag 解析(isNotFC、port、cgroup-root、no-cgroups、verbose)│
│  ├─ 构造 execcontext.Defaults{User: "root", EnvVars}             │
│  ├─ 启动 host.PollForMMDSOpts goroutine(50ms 轮询 MMDS)        │
│  ├─ 创建 zerolog Logger + HTTPLogsExporter                      │
│  ├─ 创建 chi.Router,挂载:                                      │
│  │   ├─ filesystemRpc.Handle(FilesystemService)                 │
│  │   ├─ processRpc.Handle(ProcessService)                       │
│  │   ├─ api.HandlerFrommux(REST OpenAPI handlers)               │
│  │   └─ authn middleware + CORS + WithAuthorization             │
│  ├─ 启动 port.Scanner(1s 扫描 listening sockets)              │
│  ├─ 启动 port.Forwarder(为每个端口 spawn socat)               │
│  └─ http.Server.ListenAndServe(:49983)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、核心概念

### 2.1 Connect RPC

[Connect](https://connectrpc.com/) 是 Buf 出品的 RPC 框架,基于 HTTP/2,既能跑在 gRPC wire protocol 上也能跑在 Connect 自己的 JSON-over-HTTP 协议上。envd 用它来给 SDK 提供高性能的流式接口(尤其是 `process.start` 的 stdout/stderr 流)。

envd 的两个 Connect 服务:

| Service | 文件 | 主要 RPC |
|---------|------|---------|
| `Process` | `spec/process/process.proto` | `Start`(server stream)、`List`、`Connect`(server stream)、`Update`、`SendInput`、`StreamInput`(client stream)、`CloseStdin`、`SendSignal` |
| `Filesystem` | `spec/filesystem/filesystem.proto` | `Stat`、`MakeDir`、`Move`、`ListDir`、`Remove`、`WatchDir`(server stream)、`CreateWatcher`、`GetWatcherEvents`、`RemoveWatcher` |

### 2.2 MMDS(MicroVM Metadata Service)

Firecracker 内置的元数据服务,只对 guest 可见,固定地址 `169.254.169.254`(模仿 AWS EC2 metadata service)。

orchestrator 在 sandbox 启动时通过 Firecracker API 把元数据塞进 MMDS,envd 通过 HTTP GET 读取。envd 关心的字段:

| 字段 | 用途 |
|------|------|
| `SandboxID` | 当前 sandbox 的 ID,注入到 env var `E2B_SANDBOX_ID` |
| `TemplateID` | 当前 template 的 ID,注入到 env var `E2B_TEMPLATE_ID` |
| `LogsCollectorAddress` | 日志收集器(Loki/otel collector)的 HTTP 地址 |
| `AccessTokenHash` | access token 的 SHA-256 hash,用于 `/init` 验证 |

详见 [`internal/host/mmds.go:34`](../../packages/envd/internal/host/mmds.go)。

### 2.3 Access Token

envd 启动时**没有** access token(任何客户端都能连)。SDK 调用 `/init` 时通过 body 传一个 token,envd 把它存进内存(`SecureToken`,基于 `memguard.LockedBuffer`),之后所有需要鉴权的请求都要带 `X-Access-Token: <token>` header。

token 的设计要点:

- **常量时间比较**(`memguard.LockedBuffer.EqualTo`),防时序攻击
- **mlock 锁内存**,防 swap 泄露
- **不持久化**,microVM 重启后由 `/init` 重设
- **支持 hash 重置**:orchestrator 通过 MMDS 写一个特殊的 hash 表示 "下次 `/init` 接受任何新 token"

### 2.4 ProcessType(cgroup 归类)

envd 把自己 spawn 出来的进程分成 4 类,每类放进独立的 cgroup,目的是 **pause 时只 freeze 用户进程,不 freeze socat 这类系统组件**:

| ProcessType | 用途 | 是否参与 freeze |
|-------------|------|-----------------|
| `system` | envd 内部进程(tag=`_system`),例如 CA 证书安装 | ✗ |
| `user` | 普通用户进程(非 PTY) | ✓ |
| `pty` | PTY 进程(交互式) | ✓ |
| `socat` | socat 端口转发进程 | ✗ |

详见 [`internal/services/cgroups/iface.go`](../../packages/envd/internal/services/cgroups/iface.go)。

### 2.5 工作目录、默认用户、env vars

envd 启动时的默认值:

| 项 | 默认值 | 来源 |
|----|--------|------|
| `User` | `"root"` | `main.go:43 defaultUser` |
| `EnvVars` | 由 build 时打包 + MMDS 注入 | `utils.EnvVars` |
| `Workdir` | (空) → 用户 home | `execcontext.go:15 ResolveDefaultWorkdir` |
| `Port` | `49983` | `main.go:37 defaultPort` |

这些值会被 SDK 通过 `/init` 覆盖。

---

## 三、启动流程与架构

### 3.1 main.go 启动序列

文件:[`packages/envd/main.go`](../../packages/envd/main.go)

```
1. flag.Parse()
       │
       ├─ isNotFC      (非 Firecracker 环境,本地测试用)
       ├─ port         (默认 49983)
       ├─ cgroupRoot   (默认 /sys/fs/cgroup)
       ├─ noCgroups    (禁用 cgroup)
       └─ verbose      (打印日志到 stdout)
       │
       ▼
2. 构造 execcontext.Defaults{User: "root", EnvVars: NewEnvVars()}
       │
       ▼
3. 写 /run/e2b 目录 + .E2B_SANDBOX 标记文件
   (main.go:163-175)
       │
       ▼
4. 启动 MMDS 轮询 goroutine(仅 !isNotFC)
   go host.PollForMMDSOpts(ctx, mmdsChan)
   (main.go:178-181)
       │
       ▼
5. 创建 zerolog Logger
   logs.NewLogger(isFC, mmdsChan, verbose)
   (main.go:183)
       │
       ▼
6. 创建 chi.Router,withCORS + authn + WithAuthorization
   (main.go:185, 115-137)
       │
       ▼
7. 挂载 Connect RPC 服务
   ├─ filesystemRpc.Handle(...)
   └─ processRpc.Handle(..., cgroupManager)
   (main.go:188-200)
       │
       ▼
8. 挂载 REST API(api.HandlerFromMux)
   (main.go:202-204)
       │
       ▼
9. 创建 cgroupManager
   createCgroupManager()  (无参,通过 host.GetMetrics() 读内存)
   (main.go:191, 237-298)
   ├─ 查询 host 内存,预留 1/8(≤128MB)
   ├─ 为 ptys/socats/user 三类各创建 cgroup
   └─ 失败时回退 NoopManager
       │
       ▼
10. 启动端口扫描器和转发器
    go scanner.ScanAndBroadcast()    (1s 轮询)
    go forwarder.StartForwarding()
    (main.go:220-227)
       │
       ▼
11. http.Server{IdleTimeout: 640s}.ListenAndServe(":49983")
    (main.go:206-229)
```

### 3.2 关键常量

文件:[`main.go:33-49`](../../packages/envd/main.go)

```go
const (
    idleTimeout = 640 * time.Second  // 下游 idle 应大于上游(orchestrator proxy)
    maxAge      = 2 * time.Hour      // CORS 预检缓存

    defaultPort = 49983              // envd 监听端口

    portScannerInterval = 1000 * time.Millisecond  // 端口扫描周期

    defaultUser = "root"             // 默认用户

    kilobyte = 1024
    megabyte = 1024 * kilobyte
)
```

### 3.3 路由层的中间件栈

```
HTTP Request
    │
    ▼
withCORS                                (main.go:115)
    │ rs/cors:AllowedOrigins=["*"]
    │ ExposedHeaders: Location, Cache-Control, X-Content-Type-Options + connect 的 list
    │ MaxAge: 2h
    ▼
service.WithAuthorization(...)          (api/auth.go:33)
    │ 如果 accessToken 已设:
    │   1. 检查 path 是否在 authExcludedPaths
    │   2. 否则要求 X-Access-Token 头匹配
    │   3. /files 走 HMAC 签名
    ▼
authn.NewMiddleware(AuthenticateUsername)  (permissions/authenticate.go)
    │ HTTP Basic Auth 的 username → 解析为 unix user
    │ 无 auth info → 默认 root
    ▼
chi handler
    │
    ├─ Connect RPC 路径(/process.Service/...)
    └─ REST OpenAPI 路径(/init, /files, ...)
```

### 3.4 为什么要 IdleTimeout = 640s

注释:[`main.go:33`](../../packages/envd/main.go)

> Downstream timeout should be greater than upstream (in orchestrator proxy).

orchestrator 的 sandbox 流量 proxy 默认 idle timeout 是 600s。envd 设 640s 确保客户端不会先关连接造成奇怪的 EOF。**ReadTimeout 和 WriteTimeout 都是 0**(无限制),因为 Connect RPC 的长流(进程 stdout、filesystem watch)会持续很久。

---

## 四、Connect RPC 服务

### 4.1 ProcessService

文件:[`packages/envd/internal/services/process/service.go`](../../packages/envd/internal/services/process/service.go)

#### RPC 列表

| RPC | 类型 | 用途 |
|-----|------|------|
| `Start` | server stream | 启动进程,持续推送 `ProcessEvent`(Start/Data/End/Keepalive) |
| `List` | unary | 列出 envd 跟踪的所有进程 |
| `Connect` | server stream | 附加到一个已有进程,推送后续事件(用于多个客户端订阅同一进程) |
| `Update` | unary | resize PTY(`ResizeTty{Rows, Cols}`) |
| `SendInput` | unary | 发送一次性 stdin 数据 |
| `StreamInput` | client stream | 流式发送 stdin(ordered) |
| `CloseStdin` | unary | 关闭 stdin(对非 PTY 进程发 EOF) |
| `SendSignal` | unary | 发送信号(SIGTERM=15, SIGKILL=9) |

#### ProcessEvent 类型

文件:[`spec/process/process.proto`](../../packages/envd/spec/process/process.proto)

```protobuf
message ProcessEvent {
  oneof event {
    StartEvent   start      = 1;  // 进程启动(pid)
    DataEvent    data       = 2;  // stdout/stderr/pty 数据
    EndEvent     end        = 3;  // 进程结束(exit_code, status)
    KeepAlive    keepalive  = 4;  // 心跳
  }
}
```

#### Start 流程

文件:[`internal/services/process/start.go`](../../packages/envd/internal/services/process/start.go)

```
client.Start(StartRequest{process, pty?, tag?, stdin?})
       │
       ▼
1. 读 Connect-Timeout-Ms header(默认无超时)
   (start.go:196)
       │
       ▼
2. handler.New(...)
   ├─ 包装命令为 /bin/sh -c
   │   预设 oom_score_adj=100、ionice -c2 -n4、nice
   │   (handler/handler.go:105-108)
   ├─ 设置 SysProcAttr.Credential(uid/gid/groups)
   ├─ applyCgroupFD(把进程放进 cgroup)
   └─ 如果 PTY:creack/pty 启动;否则 stdout/stderr pipe(32KiB chunk)
       │
       ▼
3. 启动 keepalive ticker
   permissions.GetKeepAliveTicker
   (从 Keepalive-Ping-Interval header 读,默认 90s)
       │
       ▼
4. 推送 StartEvent{pid}
       │
       ▼
5. 后台 goroutine 读 stdout/stderr/pty
   每读到数据 → 推送 DataEvent + reset keepalive ticker
   (start.go:142)
       │
       ▼
6. 进程退出 → 推送 EndEvent{exit_code, status}
```

#### handler 的进程归类

文件:[`internal/services/process/handler/handler.go:340`](../../packages/envd/internal/services/process/handler/handler.go)

```go
// 注意:是包级函数,不是 Handler 方法;接收 *StartRequest 而非 Handler。
// 通过请求中的 tag / pty 字段判定 cgroup 归类。
func getProcType(req *rpc.StartRequest) cgroups.ProcessType {
    if req != nil && req.GetTag() == systemTag {  // systemTag = "_system"
        return cgroups.ProcessTypeSystem
    }
    if req != nil && req.GetPty() != nil {
        return cgroups.ProcessTypePTY
    }
    return cgroups.ProcessTypeUser
}
```

#### Multiplexing(Start + Connect 共享订阅)

文件:[`internal/services/process/handler/multiplex.go`](../../packages/envd/internal/services/process/handler/multiplex.go)

`MultiplexedChannel[T]` 是个 fan-out 广播:一个 Source 写入,多个 `Fork()` 订阅者各自独立消费。每个订阅者有独立的 `done` channel,某个订阅者取消不会阻塞 fan-out。

**用途**:`Start` RPC 启动进程后,events 通过 multiplex 广播。后续的 `Connect` RPC 用同一个 pid 订阅,可以收到未来的 Data/End 事件。

```
Process stdout ──► MultiplexedChannel[DataEvent]
                         │
                         ├─ Fork() ──► Start RPC stream
                         ├─ Fork() ──► Connect RPC stream (client A)
                         └─ Fork() ──► Connect RPC stream (client B)
```

### 4.2 FilesystemService

文件:[`packages/envd/internal/services/filesystem/service.go`](../../packages/envd/internal/services/filesystem/service.go)

#### RPC 列表

| RPC | 类型 | 用途 |
|-----|------|------|
| `Stat` | unary | `StatRequest{path}` → `EntryInfo` |
| `MakeDir` | unary | `EnsureDirs`(递归创建+chown) |
| `ListDir` | unary | 深度受限遍历,symlink 解析 |
| `Move` | unary | `os.Rename` + 父目录 EnsureDirs |
| `Remove` | unary | `os.RemoveAll` |
| `WatchDir` | server stream | **流式** watch,通过 fsnotify 推送事件 |
| `CreateWatcher` | unary | **非流式** watch:创建返回 watcher_id |
| `GetWatcherEvents` | unary | 拉取累积的事件(清空缓冲) |
| `RemoveWatcher` | unary | 关闭 watcher |

#### WatchDir vs watch_sync

| 维度 | `WatchDir`(流式) | `watch_sync`(非流式) |
|------|-------------------|----------------------|
| 客户端 | HTTP/2 长连接 | 短连接 + 轮询 |
| 事件传递 | 推送到 stream | 缓冲在 `FileWatcher.Events`,客户端拉取 |
| 超时风险 | 长连接可能被 proxy/超时中断 | 每次调用是短请求,无超时风险 |
| 适用场景 | SDK 长连接、稳定的网络 | 不稳定网络、需要轮询 |
| 实现 | `watch.go` | `watch_sync.go` |

`watch_sync` 的设计目的是避免某些 HTTP/2 proxy 在长连接 idle 时关闭连接,导致 stream watch 失败。

### 4.3 Memory Collapse

文件:[`packages/envd/internal/services/memory/`](../../packages/envd/internal/services/memory/)

#### 作用

envd 在运行中累积了大量 Go heap 的 anonymous 内存页(4KiB)。Pause → resume 时,这些页都要从 snapshot 恢复,page fault 数量爆炸。

`CollapseSelf` 把这些散落的 4KiB 页 **合并成 2MiB transparent huge pages (THP)**,减少 resume 时的 page fault。

#### 实现

文件:[`internal/services/memory/collapse_linux.go`](../../packages/envd/internal/services/memory/collapse_linux.go)

```go
// 1. 解析 /proc/self/maps 拿到 anon RW 区域
// 2. 对每个区域:
//    a. MADV_HUGEPAGE(标记为"想要 THP")
//    b. 对每个 2MiB 窗口 MADV_COLLAPSE(立即合并)
// 3. 通过 /proc/self/smaps_rollup 的 AnonHugePages 差值统计成功率
```

`Stats` 结构(`collapse.go:18`)记录:`Regions`、`Chunks`、`Collapsed`、`AlreadyHuge`、`Skipped`。

非 Linux 平台是 no-op(`collapse_other.go`)。

### 4.4 fsfreeze

文件:[`packages/envd/internal/services/fsfreeze/`](../../packages/envd/internal/services/fsfreeze/)

#### 作用

orchestrator 做 **filesystem-only pause**(只保留 rootfs,丢内存)时,需要确保 rootfs 在磁盘上一致。fsfreeze 通过 Linux ioctl `FIFREEZE`/`FITHAW` 暂停/恢复文件系统的写入。

#### 实现

文件:[`internal/services/fsfreeze/fsfreeze_linux.go:17-67`](../../packages/envd/internal/services/fsfreeze/fsfreeze_linux.go)

```go
// 注意:常量是小写未导出的 fiFreeze/fiThaw(_IOWR('X', 119/120, int))。
// FIFREEZE/FITHAW 忽略 ioctl 参数,所以 IoctlSetInt 传 0 即可。
const (
    fiFreeze = 0xC0045877
    fiThaw   = 0xC0045878
)

// Freeze:EBUSY(已冻结)视为成功(幂等)
// Thaw:EINVAL(未冻结)视为成功(幂等)
```

REST 端点:`POST /fsfreeze`、`POST /fsthaw`,作用在 rootfs mountpoint `/`。

### 4.5 Legacy SDK 兼容

文件:[`packages/envd/internal/services/legacy/`](../../packages/envd/internal/services/legacy/)

#### 背景

早期 connect-python SDK 的 UserAgent 标识错误,导致无法正确反序列化新 proto 字段(尤其 `EntryInfo` 新增的 size/mode/permissions/owner/group 等)。

#### 实现

- `interceptor.go:15`:检查 `User-Agent == "connect-python"`,设置 `X-E2B-Legacy-SDK: true`
- `conversion.go:21`:对设置了 legacy flag 的响应,只保留 `EntryInfo` 的 `Name/Type/Path` 字段,丢弃其他
- `stream.go`:对 streaming handler conn 的 `Send` 包装转换

**注意**:这是给**老 SDK** 的兜底,新 SDK 不会触发。

---

## 五、REST API 与 OpenAPI

### 5.1 OpenAPI spec 与代码生成

- spec 文件:[`packages/envd/spec/envd.yaml`](../../packages/envd/spec/envd.yaml)(524 行,OpenAPI 3.0.0)
- 代码生成配置:[`packages/envd/internal/api/cfg.yaml`](../../packages/envd/internal/api/cfg.yaml)
- 代码生成入口:[`packages/envd/internal/api/generate.go:3`](../../packages/envd/internal/api/generate.go)(`//go:generate oapi-codegen`)
- 生成产物:[`packages/envd/internal/api/api.gen.go`](../../packages/envd/internal/api/api.gen.go)

cfg.yaml 关键配置:

```yaml
output: api.gen.go
generate:
  models: true
  chi-server: true
  client: false
```

### 5.2 完整端点列表

文件:[`internal/api/api.gen.go:838-873`](../../packages/envd/internal/api/api.gen.go)

| Method | Path | Handler | 鉴权 |
|--------|------|---------|------|
| `POST` | `/init` | `PostInit` | 特殊(MMDS hash) |
| `GET` | `/health` | `GetHealth` | 豁免 |
| `GET` | `/envs` | `GetEnvs` | 需要 token |
| `GET` | `/files` | `GetFiles` | HMAC 签名 |
| `POST` | `/files` | `PostFiles` | HMAC 签名 |
| `POST` | `/files/compose` | `PostFilesCompose` | 需要 token |
| `GET` | `/metrics` | `GetMetrics` | 需要 token |
| `POST` | `/collapse` | `PostCollapse` | 需要 token |
| `POST` | `/freeze` | `PostFreeze` | 需要 token |
| `POST` | `/unfreeze` | `PostUnfreeze` | 需要 token |
| `POST` | `/fsfreeze` | `PostFsfreeze` | 需要 token |
| `POST` | `/fsthaw` | `PostFsthaw` | 需要 token |

### 5.3 关键端点详解

#### POST /init

详见 [§十二](#十二init-的完整生命周期)。

#### GET /files(下载)

文件:[`internal/api/download.go`](../../packages/envd/internal/api/download.go)

```
GET /files?path=...
    │
    ├─ Accept-Encoding 含 gzip?
    │   YES → 流式 gzip 写出(151-170)
    │   NO  → http.ServeContent(支持 Range, 172)
    │
    ├─ 如果有 Range / If-Modified-Since / If-None-Match / If-Range
    │   强制 EncodingIdentity(gzip 会破坏 Range 语义)
    │
    └─ 设置:
       Vary: Accept-Encoding
       Content-Disposition: inline
       返回 200 / 206 Partial Content / 304 Not Modified
```

#### POST /files(上传)

文件:[`internal/api/upload.go`](../../packages/envd/internal/api/upload.go)

支持两种 Content-Type:

1. **`application/octet-stream`**:整个 body 是文件内容,`?path=` 指定目标
2. **`multipart/form-data`**:每个 part 是一个文件,文件名从 `Content-Disposition: filename` 拿(**保留相对路径**,不是 `filepath.Base`),如果没有 `?path=` 就用 part 自带的相对路径

写入逻辑(`processFile`):

```
1. EnsureDirs(父目录)
2. 如果目标文件已存在,先 chown 给目标 uid/gid
   (避免改写别人的 inode)
3. O_WRONLY|O_CREATE|O_TRUNC 打开
   (原地截断写,不是 atomic rename)
4. file.ReadFrom(part)
5. filesystem.WriteMetadata(user.e2b.* xattrs)
6. ENOSPC → 507 Insufficient Storage
```

> **注**:`/files` 不用 atomic rename,因为 SDK 期望文件路径稳定(覆盖即写)。需要 atomic 语义的用 `/files/compose`。

#### POST /files/compose

文件:[`internal/api/compose.go`](../../packages/envd/internal/api/compose.go)

将多个源文件 **零拷贝拼接** (`copy_file_range` syscall) 到一个目标文件,完成后删除源文件。

```
sources: [src1, src2, src3]
dest: dst
    │
    ▼
1. 校验:src != dest、所有 src 都是 regular file
2. 创建临时文件 <dest>.e2b-compose.<uuid>.tmp
3. chown 临时文件
4. for each src:
       destFile.ReadFrom(srcFile)
       (内核态 copy_file_range,零拷贝)
5. os.Rename(tmp, dest)   ← 原子替换
6. 删除所有 src 文件
```

适用场景:大日志/数据文件的追加式拼接,避免 read+write 用户态拷贝。

#### POST /collapse

调用 `memory.CollapseSelf` 触发内存整理。详见 [§4.3](#43-memory-collapse)。

返回:`CollapseResult{Regions, Chunks, Collapsed, AlreadyHuge, Skipped, ElapsedMs}`。

#### POST /freeze / /unfreeze

freeze `user` 和 `pty` 两类 cgroup(不 freeze `system`/`socat`)。配合 pause/resume 用,详见 [§十三](#十三pause--resume-配合)。

#### POST /fsfreeze / /fsthaw

在 rootfs mountpoint `/` 上调用 `FIFREEZE`/`FITHAW` ioctl。详见 [§4.4](#44-fsfreeze)。

#### GET /metrics

返回 `host.GetMetrics()` JSON:

```json
{
  "cpu_count": 2,
  "cpu_used_percent": 12.34,
  "memory_total_bytes": 536870912,
  "memory_used_bytes": 134217728,
  "memory_cache_bytes": 67108864,
  "disk_used_bytes": 1234567890,
  "disk_total_bytes": 42949672960
}
```

#### GET /envs

返回当前所有 env vars(包括 internal 和 user)。详见 [§2.5](#25-工作目录默认用户env-vars) 和 `utils/envvars.go`。

#### GET /health

返回 204 No Content。orchestrator 通过它做 liveness 检查。

---

## 六、权限与安全模型

### 6.1 三层鉴权

envd 的鉴权分三层,按请求类型走不同路径:

```
请求进来
    │
    ▼
1. 路径豁免?
   ├─ GET /health            → 直接放行
   ├─ POST /init             → 走 MMDS hash 验证
   ├─ GET/POST /files        → 走 HMAC 签名验证
   └─ 其他                   → 走 X-Access-Token
       │
       ▼
2. X-Access-Token 匹配?
   ├─ 是 → 放行
   └─ 否 → 401
```

### 6.2 Access Token(SecureToken)

文件:[`internal/api/secure_token.go`](../../packages/envd/internal/api/secure_token.go)

#### 数据结构

```go
type SecureToken struct {
    mu     sync.RWMutex
    buffer *memguard.LockedBuffer  // mlock + guard pages + 销毁时清零
}
```

#### 安全特性

- **mlock**:物理内存锁定,不会 swap 到磁盘
- **guard pages**:前后各一页保护,缓冲区溢出难以读到
- **零化销毁**:`Destroy()` 显式清零内存
- **常量时间比较**:`Equals` 用 `memguard.LockedBuffer.EqualTo`,不泄露时序信息
- **Move 语义**:`TakeFrom(other)` 把 buffer 从 other 移到 self,不复制

#### 反序列化

`UnmarshalJSON` (`secure_token.go:53-92`):

```go
// 1. 解析 JSON 字符串
// 2. 拒绝包含反斜杠转义的(token 是 hex,不该有 \)
// 3. 把 bytes 装进 LockedBuffer
// 4. WipeBytes(原始输入) ← 擦掉 JSON 里的明文
```

#### 持久性

token **只在内存**。microVM pause → resume 后:

1. 内存被 snapshot 恢复 → token 仍在 ✓
2. 但如果是 cold boot(从 rootfs 启动)→ token 丢失
3. `/init` 通过 MMDS hash(`AccessTokenHash`)重新认证,接受新 token

### 6.3 HMAC 签名(/files 专用)

文件:[`internal/api/auth.go:55-129`](../../packages/envd/internal/api/auth.go)

#### 签名串构造

```
signature_string = path + ":" + operation + ":" + username + ":" + accessToken
                   + (":" + expiration if set)

operation ∈ {"read", "write"}
   ├─ GET  /files → "read"
   └─ POST /files → "write"

signature = "v1_" + sha256_base64_raw_std(signature_string)
            # base64.RawStdEncoding (无 padding),不是 hex
            # 实现:hasher.HashWithoutPrefix → packages/shared/pkg/keys/sha256.go:26-30
```

#### 客户端用法

```
GET /files?path=/data/log.txt&signature=v1_<hex>&signature_expiration=1735900000
```

envd 重新计算签名串(用自己持有的 token),比对。如果带 `signature_expiration` 还会检查过期。

#### 为什么 /files 用签名而不用 token

- **预签名 URL**:SDK 可以为单次下载/上传生成签名 URL,客户端(浏览器)无需 token 即可访问
- **过期控制**:`signature_expiration` 让 URL 自动失效
- **路径限定**:签名串包含 path,无法用于其他路径

### 6.4 用户解析(permissions)

文件:[`packages/envd/internal/permissions/`](../../packages/envd/internal/permissions/)

#### AuthenticateUsername

`authenticate.go:14` 实现 Connect-RPC 的 `authn.Authenticator` 接口:

```go
// 注意:req 是 authn.Request 值类型(非指针)
func AuthenticateUsername(_ context.Context, req authn.Request) (any, error) {
    // 1. 从 HTTP Basic Auth 拿 username(password 不验证)
    // 2. permissions.GetUser(username) — 封装 user.Lookup
    // 3. 找不到 → authn.Errorf 报错
    // 4. 找到 → 把 *user.User 返回(authn 中间件塞进 ctx)
    // 5. 无 Basic Auth → 返回 (nil, nil)(后续 GetAuthUser 兜底)
}
```

#### GetAuthUser

`authenticate.go:30`:

```go
// 注意:第 2 个参数是 defaultUser string,不是整个 Defaults;返回值带 error。
func GetAuthUser(ctx context.Context, defaultUser string) (*user.User, error) {
    // 1. 从 ctx 取 AuthenticateUsername 设的 *user.User
    // 2. 没有则用 execcontext.ResolveDefaultUsername(nil, defaultUser)
    // 3. 默认 "root"(由 main.go 的 defaults.User 传入)
}
```

#### 路径解析

`path.go:30 ExpandAndResolve`:

```go
func ExpandAndResolve(path string, user *user.User, defaultPath *string) (string, error) {
    // 1. execcontext.ResolveDefaultWorkdir(path, defaultPath) — 处理空 path
    // 2. expand():开头 ~ → user.HomeDir
    // 3. 已是绝对路径 → 直接返回
    // 4. 否则 filepath.Join(home, path) + filepath.Abs
}
```

> **注**:envd **没有 chroot**。路径限制靠 **用户查找 + cwd 解析**,不是 filesystem jail。所有 RPC 都以解析后的 unix user 身份执行,文件系统权限靠 Unix DAC。

### 6.5 keepalive

文件:[`internal/permissions/keepalive.go`](../../packages/envd/internal/permissions/keepalive.go)

#### 用途

Connect RPC 的 stream(尤其是 `process.start` 的 stdout 流)可能长时间无数据。客户端需要心跳确认 stream 还活着。

#### 实现

```go
// 注意:是泛型函数,接收 *connect.Request[T](不是 ctx)。
const defaultKeepAliveInterval = 90 * time.Second

func GetKeepAliveTicker[T any](req *connect.Request[T]) (*time.Ticker, func()) {
    // 1. 读 Keepalive-Ping-Interval header(秒),Atoi 失败 → 默认 90s
    // 2. time.NewTicker(interval)
    // 3. 返回 reset 函数:每次有数据事件时调用,ticker.Reset(interval)
}
```

`process.start` 每次推送 DataEvent 都会 reset ticker(`start.go:142`),所以 idle 时才会触发 Keepalive 推送。

---

## 七、进程管理

### 7.1 进程启动完整流程

文件:[`internal/services/process/handler/handler.go`](../../packages/envd/internal/services/process/handler/handler.go)

```
ProcessService.Start(StartRequest)
       │
       ▼
1. 解析用户
   GetAuthUser(ctx) → *user.User
       │
       ▼
2. 解析 cwd
   ExpandAndResolve(process.Cwd, user)
       │
       ▼
3. 包装命令
   cmd := "/bin/sh -c '<原始命令>'"
   预设:
     echo 100 > /proc/self/oom_score_adj  (优先被 OOM kill)
     ionice -c2 -n4                       (低 IO 优先级)
     nice                                (低 CPU 优先级)
   (handler.go:105-108)
       │
       ▼
4. exec.Cmd 设置
   ├─ Cmd、Args、Env(merge defaults + user)
   ├─ Dir = resolved cwd
   ├─ SysProcAttr.Credential{Uid, Gid, Groups}
   ├─ SysProcAttr.Setpgid = true          (独立进程组,便于 kill)
   └─ applyCgroupFD(cgroupManager, type)  (CLONE_INTO_CGROUP)
       │
       ▼
5. 启动
   ├─ PTY 模式:creack/pty.Start(cmd)
   └─ 非 PTY:cmd.Start() + stdout/stderr pipe(32KiB chunk)
       │
       ▼
6. 注册到 utils.Map[pid → *Handler]
       │
       ▼
7. 启动 goroutine:
   for {
     select {
     case data := <-stdoutPipe: 推送 DataEvent + reset keepalive
     case <-keepaliveTicker.C:  推送 KeepAlive
     case err := <-waitCh:      推送 EndEvent{exit_code} + cleanup
     }
   }
```

### 7.2 cgroupFD(CLONE_INTO_CGROUP)

文件:[`internal/services/process/handler/cgroupfd_linux.go`](../../packages/envd/internal/services/process/handler/cgroupfd_linux.go)

```go
// 注意:接收 *syscall.SysProcAttr 而非 *exec.Cmd,带 use bool 参数。
// 调用方(cgroupManager.GetFileDescriptor 返回 (fd, ok))决定是否启用。
func applyCgroupFD(attr *syscall.SysProcAttr, fd int, use bool) {
    attr.CgroupFD = fd
    attr.UseCgroupFD = use
}
```

`CgroupFD` 是 cgroup 目录的 file descriptor(open with `O_RDONLY`)。内核 `clone3` 系统调用支持 `CLONE_INTO_CGROUP` flag,**在 fork 的瞬间**就把新进程放进指定 cgroup,避免启动瞬间跑偏。

`fd, ok` 由 `cgroupManager.GetFileDescriptor(processType)` 返回(成功时 `ok=true`),每个 ProcessType 一个打开的 FD。

### 7.3 进程信号

文件:[`internal/services/process/signal.go`](../../packages/envd/internal/services/process/signal.go)

```go
var signal syscall.Signal
switch req.Msg.GetSignal() {
case rpc.Signal_SIGNAL_SIGKILL: signal = syscall.SIGKILL
case rpc.Signal_SIGNAL_SIGTERM: signal = syscall.SIGTERM
default: return connect.NewError(connect.CodeUnimplemented, ...)
}

err = handler.SendSignal(signal)  // → p.cmd.Process.Signal(signal)
```

envd 通过 `(*os.Process).Signal` 发送(不是 `syscall.Kill(pid, ...)`),因为 handler 已持有 `*exec.Cmd`,直接用其 `Process` 字段。其他信号(非 SIGTERM/SIGKILL)返回 `CodeUnimplemented`。

### 7.4 进程输入(stdin)

三种方式:

| RPC | 用途 |
|-----|------|
| `SendInput` | unary,一次性发数据 |
| `StreamInput` | client stream,流式(有序) |
| `CloseStdin` | unary,关闭 stdin(对非 PTY 进程发 EOF) |

PTY 进程的 stdin 是双向的(同一个 fd),`CloseStdin` 对 PTY 无意义。

### 7.5 PTY resize

`Update` RPC 调用 `ResizeTty(Winsize{Rows, Cols})`,通过 ioctl `TIOCSWINSZ` 通知 PTY 内核窗口大小变了。非 PTY 进程会忽略。

---

## 八、端口转发

### 8.1 设计原理

E2B sandbox 没有事先注册的端口映射。用户进程在 VM 内监听任意端口,envd **动态发现**并为每个 listening port 自动 spawn 一个 socat 把外部流量桥接进来。

### 8.2 Scanner(端口扫描器)

文件:[`internal/port/scan.go`](../../packages/envd/internal/port/scan.go)

```go
type Scanner struct {
    Processes chan net.ConnectionStat   // 兼容旧接口
    scanExit  chan struct{}             // Destroy() 时关闭,用于退出循环
    subs      *smap.Map[*ScannerSubscriber]  // 并发安全的订阅者表(不是 slice)
    period    time.Duration
}

// 注意:不接收 ctx,通过 s.scanExit 退出。
func (s *Scanner) ScanAndBroadcast() {
    for {
        processes, _ := net.Connections("tcp")  // gopsutil,IPv4+IPv6
        for _, sub := range s.subs.Items() {
            sub.Signal(processes)
        }
        select {
        case <-s.scanExit: return
        default: time.Sleep(s.period)  // 1s
        }
    }
}
```

`net.Connections("tcp")` 返回所有 TCP 连接(IPv4 + IPv6),每秒一次。

### 8.3 Filter

文件:[`internal/port/scanfilter.go`](../../packages/envd/internal/port/scanfilter.go)

```go
type ScannerFilter struct {
    IPs    []string  // ["127.0.0.1", "localhost", "::1"]
    State  string    // "LISTEN"
}

func (sf *ScannerFilter) Matches(proc net.ConnectionStat) bool {
    // 1. proc.Laddr.IP ∈ sf.IPs
    // 2. proc.Status == sf.State
}
```

**只关注 loopback 上的 LISTEN socket**。原因:

- envd 自己监听 `0.0.0.0:49983`,不在 loopback,自然被过滤掉
- socat 自己监听 `169.254.0.21:<port>`(gateway IP),也不在 loopback

所以 Forwarder 看到的 listening socket **都是用户进程**。

### 8.4 Forwarder

文件:[`internal/port/forward.go`](../../packages/envd/internal/port/forward.go)

#### 数据结构

```go
type Forwarder struct {
    logger            *zerolog.Logger
    cgroupManager     cgroups.Manager
    ports             map[string]*PortToForward  // key: "<pid>-<port>"
    scannerSubscriber *ScannerSubscriber
    sourceIP          net.IP                    // 默认 169.254.0.21
}

type PortToForward struct {
    socat  *exec.Cmd    // socat 进程
    pid    int32        // 用户进程 pid
    family uint32       // 4 / 6
    state  PortState    // FORWARD / DELETE
    port   uint32       // 监听端口
}
```

#### 主循环

`StartForwarding` (`forward.go:73-139`):

```
for {
    conns := <-subscriber.Messages
    // 1. 标记所有现有 entry 为 DELETE
    // 2. 对每个 listening conn(filter 后):
    //    - 如果已存在 → 标记为 FORWARD
    //    - 如果新 → 创建 PortToForward,startPortForwarding
    // 3. 所有仍是 DELETE 的 → stopPortForwarding(kill -9 进程组)
}
```

#### startPortForwarding

`forward.go:141-187`:

```go
cmd := exec.CommandContext(ctx,
    "socat", "-d", "-d", "-d",
    fmt.Sprintf("TCP4-LISTEN:%v,bind=%s,reuseaddr,fork", p.port, f.sourceIP.To4()),
    fmt.Sprintf("TCP%d:localhost:%v", p.family, p.port),
)

cgroupFD, ok := f.cgroupManager.GetFileDescriptor(cgroups.ProcessTypeSocat)
cmd.SysProcAttr = &syscall.SysProcAttr{
    Setpgid: true,                    // 独立进程组,便于 kill
}
applyCgroupFD(cmd.SysProcAttr, cgroupFD, ok)  // 仅当 ok=true 才启用 CLONE_INTO_CGROUP
```

#### 为什么用 socat

- **稳定**:socat 是几十年验证过的网络工具
- **`fork` 模式**:每个新连接 fork 一个子进程处理,主进程持续监听
- **资源归因**:socat 整体被放进 `socats` cgroup,CPU/内存消耗可计量、可限制

#### gateway IP `169.254.0.21`

`forward.go:28`:

```go
var defaultGatewayIP = net.IPv4(169, 254, 0, 21)
```

这是 microVM 内的 link-local gateway IP,**orchestrator 的 client-proxy 把外部流量 DNAT 到这个 IP**。socat 监听这个 IP 上的端口,把流量桥接到 loopback 上的用户进程。

### 8.5 端口映射的生命周期

```
T0: 用户进程启动,listen 127.0.0.1:8080
T0+1s: scanner 发现 → Forwarder 创建 socat
        socat TCP4-LISTEN:8080,bind=169.254.0.21 → localhost:8080
T0+1.5s: 外部访问 sandbox:8080
        client-proxy → DNAT 到 169.254.0.21:8080
        socat accept → fork 子进程 → 转发到 127.0.0.1:8080
T1: 用户进程关闭
T1+1s: scanner 发现端口没了 → Forwarder kill -9 socat 进程组
```

---

## 九、cgroups 资源隔离

### 9.1 cgroup v2

envd **只支持 cgroup v2**(`cgroup2.go`),非 Linux 平台用 stub(`cgroup2_stub.go`),`--no-cgroups` flag 或初始化失败时用 `noop.go`。

#### 检测

`cgroup2.go:65`:

```go
var stat unix.Statfs_t
unix.Statfs("/sys/fs/cgroup", &stat)
if stat.Type != unix.CGROUP2_SUPER_MAGIC {
    return nil, errors.New("not cgroup v2")
}
```

### 9.2 Manager 接口

文件:[`internal/services/cgroups/iface.go`](../../packages/envd/internal/services/cgroups/iface.go)

```go
type Manager interface {
    // 注意:返回 (fd, bool) 而非 (int, error) — bool 表示该 type 是否配置了 cgroup
    GetFileDescriptor(procType ProcessType) (int, bool)
    // Freeze/Unfreeze 都带 ProcessType 参数(sandbox pause 时只冻 user+pty,不动 socat)
    Freeze(procType ProcessType) error
    Unfreeze(procType ProcessType) error
    Close() error
}
```

`GetFileDescriptor(type)` 返回 type 对应 cgroup 目录的只读 fd + 是否启用的 bool,用于 `CLONE_INTO_CGROUP`。

### 9.3 三类 cgroup 配置

文件:[`main.go:266-285`](../../packages/envd/main.go)

| ProcessType | 路径 | 配置 |
|-------------|------|------|
| `ProcessTypePTY` | `ptys` | `cpu.weight=200`、`io.weight=default 50`、`memory.high=memoryHigh`、`memory.max=memoryMax` |
| `ProcessTypeSocat` | `socats` | `cpu.weight=150`、`io.weight=default 50`、`memory.min=5MB`、`memory.low=8MB` |
| `ProcessTypeUser` | `user` | `memory.high=memoryHigh`、`memory.max=memoryMax`、`cpu.weight=50`、`io.weight=default 10` |

其中 `memoryHigh = memoryMax = MemTotal - maxReserved`(两者相同,意图是 OOM-kill 立即触发,不等 throttling 回收)。

`ProcessTypeSystem` 不在 opts 中 — envd 自己留在根 cgroup `/sys/fs/cgroup/e2b`,`system` tag 进程跟随 envd,所以不受 freeze 影响。

### 9.4 资源预留

文件:[`main.go:237-298 createCgroupManager`](../../packages/envd/main.go)

```go
// 1. 通过 host.GetMetrics() 查询内存(不是 mem.VirtualMemory())
metrics, err := host.GetMetrics()
// 2. 预留 1/8(不超过 128MB)
maxMemoryReserved := min(metrics.MemTotal/8, uint64(128)*megabyte)
// 3. user/ptys 都配置:memory.max = memory.high = MemTotal - maxMemoryReserved
memoryMax := metrics.MemTotal - maxMemoryReserved
memoryHigh := memoryMax
```

意思是:envd + 用户进程最多用 7/8 内存,留 1/8 给 socat + kernel + page cache。

### 9.5 Freeze / Unfreeze

文件:[`internal/services/cgroups/cgroup2.go:153-168`](../../packages/envd/internal/services/cgroups/cgroup2.go)

```go
// 注意:带 procType 参数;实际通过 setFreezeState → writeCgroupProp 写 cgroup.freeze 文件。
func (c Cgroup2Manager) Freeze(procType ProcessType) error {
    return c.setFreezeState(procType, "1")
}
func (c Cgroup2Manager) Unfreeze(procType ProcessType) error {
    return c.setFreezeState(procType, "0")
}
func (c Cgroup2Manager) setFreezeState(procType ProcessType, value string) error {
    path, ok := c.cgroupPaths[procType]
    if !ok { return fmt.Errorf("unknown process type: %s", procType) }
    return writeCgroupProp(filepath.Join(path, "cgroup.freeze"), value)
}
```

cgroup v2 freeze 把 cgroup 内所有任务瞬间暂停(不可调度、不消耗 CPU),但内存保留。这是 pause 操作的关键 — 不需要 stop 进程,恢复时 thaw 即可。

### 9.6 应用场景

| 场景 | 调用 |
|------|------|
| **pause(snapshot)** | `POST /freeze` → freeze user + ptys cgroup |
| **resume** | `POST /init` 的 defer → unfreeze user + ptys cgroup |
| **filesystem-only pause** | `POST /fsfreeze` + freeze + collapse + 内存丢弃 |

---

## 十、MMDS — 与 Firecracker 通信

### 10.1 MMDS 协议

文件:[`internal/host/mmds.go`](../../packages/envd/internal/host/mmds.go)

Firecracker MMDS 模仿 AWS EC2 metadata service,固定地址 `169.254.169.254`。但加了 token 机制(防 SSRF):

```
PUT http://169.254.169.254/latest/api/token
    → 返回 token(60s TTL)

GET http://169.254.169.254
    X-metadata-token: <token>
    → 返回 metadata JSON
```

### 10.2 PollForMMDSOpts

文件:[`mmds.go:132-195`](../../packages/envd/internal/host/mmds.go)

```go
// 注意:函数有第 3 个参数 envVars *utils.EnvVars(不是 os.Setenv)。
// 顺序:token → opts → Store env vars → 写文件 → 检查 LogsCollectorAddress → 发 channel。
func PollForMMDSOpts(ctx context.Context, mmdsChan chan<- *MMDSOpts, envVars *utils.EnvVars) {
    ticker := time.NewTicker(50 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done(): return
        case <-ticker.C:
            token, err := getMMDSToken(...)
            opts, err := getMMDSOpts(..., token)
            // (任何错误都记 lastErr 并 continue)

            // 先注入 env vars(无论是否有 LogsCollectorAddress)
            envVars.Store("E2B_SANDBOX_ID", opts.SandboxID)
            envVars.Store("E2B_TEMPLATE_ID", opts.TemplateID)
            // 写 /run/e2b/.E2B_SANDBOX_ID 和 .E2B_TEMPLATE_ID 文件

            if opts.LogsCollectorAddress != "" {
                select {
                case mmdsChan <- opts:
                case <-ctx.Done(): return
                }
            }
            return  // 拿到 opts 就退出,无论是否发了 channel
        }
    }
}
```

### 10.3 MMDSOpts 数据结构

`mmds.go:34-39`:

```go
// 注意:JSON tag 与字段名差异较大(由 Firecracker MMDS JSON schema 决定)
type MMDSOpts struct {
    SandboxID            string `json:"instanceID"`
    TemplateID           string `json:"envID"`
    LogsCollectorAddress string `json:"address"`
    AccessTokenHash      string `json:"accessTokenHash"`
}
```

### 10.4 PinMMDSRoute(iptables 自愈)

文件:[`internal/host/mmds_route_linux.go`](../../packages/envd/internal/host/mmds_route_linux.go)

```go
func PinMMDSRoute() {
    // 每秒检查一次
    // 用 iptables -w 5 -t nat 确保:
    //   - PREROUTING 第 1 条:RETURN 169.254.169.254:80
    //   - OUTPUT 第 1 条:RETURN 169.254.169.254:80
    // 如果被破坏 → 重新插入
}
```

#### 为什么需要

orchestrator 的网络代理可能插入 iptables 规则,意外阻断 MMDS 路径。envd 自愈机制确保 MMDS 一直可达。

非 Linux 平台是 no-op。

### 10.5 /init 用 MMDS hash 验证

文件:[`internal/api/init.go:76-113 checkMMDSHash`](../../packages/envd/internal/api/init.go)

```go
// orchestrator 在 resume 前把新 token 的 hash 写进 MMDS
// envd /init 时:
//   if body.token 的 hash == MMDS hash → 接受
//   if body.token == 已存的 token → 接受(幂等)
//   if hash("") → 接受任何 token(重置场景)
//   else → 拒绝
```

这是 resume 场景的关键 — sandbox memory 被 snapshot 替换,内存里的旧 token 可能已过期,orchestrator 通过 MMDS 通知 envd 接受新 token。

---

## 十一、日志、指标与可观测性

### 11.1 日志架构

```
envd 进程内:
   zerolog Logger
       │
       ├─ io.MultiWriter
       │   ├─ HTTPLogsExporter(只 isFC 时启用)
       │   │   └─ HTTP POST → LogsCollectorAddress (Loki)
       │   └─ os.Stdout(只 --verbose 时启用)
       │
       └─ 每条 log:
           - 时间戳(RFC3339Nano)
           - level(Debug 起步)
           - 注入 MMDS opts(SandboxID, TemplateID)
```

### 11.2 HTTPLogsExporter

文件:[`internal/logs/exporter/exporter.go`](../../packages/envd/internal/logs/exporter/exporter.go)

#### 关键常量

```go
const (
    maxLogLineBytes    = 192 * 1024  // 单行上限(Loke 默认 256K)
    maxBufferedBytes   = 8 * 1024 * 1024  // 缓冲上限 8MB
)
```

#### 数据流

```
zerolog.Write(logLine)
    │
    ▼
1. 长度检查:超过 192KiB → 丢弃
    │
    ▼
2. 加到 logs [][]byte(加锁)
    │
    ▼
3. 缓冲超限:如果 bufferedBytes + len > 8MB
   丢弃最老的行
    │
    ▼
4. triggers <- struct{}{}(信号触发发送)
    │
    ▼
5. send goroutine:
   - opts.AddOptsToJSON(注入 sandbox_id, env_id)
   - HTTP POST 到 LogsCollectorAddress
   - 超时 10s,DisableKeepAlives: true
   - 失败 → rate-limited log(避免无限重试)
```

### 11.3 Rate Limiter

文件:[`internal/logs/ratelimit/ratelimit.go`](../../packages/envd/internal/logs/ratelimit/ratelimit.go)

```go
type Limiter struct {
    floor      time.Duration
    lastLogged atomic.Pointer[time.Time]  // 上次发射时间(注意是 lastLogged,非 lastEmit)
    suppressed atomic.Int64               // 自上次发射以来被压制的次数
}

func (l *Limiter) Allow() (bool, int64) {
    // 距上次发射 > floor → CAS 替换 lastLogged,返回 (true, Swap(0))
    // 否则 → suppressed++,返回 (false, 0)
}
```

#### 用法

- HTTPLogsExporter 错误:`floor = 1 minute`(每分钟最多一条)
- MMDS pin 警告:`floor = 10 seconds`

### 11.4 RPC 拦截器

文件:[`internal/logs/interceptor.go`](../../packages/envd/internal/logs/interceptor.go)

Connect RPC 拦截器,记录每次 RPC 的:

- method 名(美化 `service.Method`)
- operation_id(原子递增)
- request 摘要
- response/error code

支持三种 RPC 类型:

- `NewUnaryLogInterceptor`(unary)
- `LogServerStreamWithoutEvents`(server stream,不记每个 event)
- `LogClientStreamWithoutEvents`(client stream)

### 11.5 Metrics

文件:[`internal/host/metrics.go`](../../packages/envd/internal/host/metrics.go)

```go
type Metrics struct {
    Timestamp      int64   `json:"ts"`           // Unix UTC

    CPUCount       uint32  `json:"cpu_count"`    // cpu.Counts(true)
    CPUUsedPercent float32 `json:"cpu_used_pct"` // cpu.Percent,保留 2 位小数

    MemTotal       uint64  `json:"mem_total"`    // mem.VirtualMemory().Total(bytes)
    MemUsed        uint64  `json:"mem_used"`     // .Used
    MemCache       uint64  `json:"mem_cache"`    // .Cached

    DiskUsed       uint64  `json:"disk_used"`    // unix.Statfs("/").Bfree
    DiskTotal      uint64  `json:"disk_total"`

    // Deprecated(待 orchestrator 移除 E2B-2998 后删除)
    MemTotalMiB    uint64  `json:"mem_total_mib"`
    MemUsedMiB     uint64  `json:"mem_used_mib"`
}
```

通过 `GET /metrics` 暴露,orchestrator 周期拉取用于调度决策。

---

## 十二、`/init` 的完整生命周期

### 12.1 为什么 `/init` 最复杂

`/init` 是 SDK 调用的第一个端点,负责"告诉 envd 这个 sandbox 的配置"。它必须:

- **幂等**:可以重复调用(orchestrator resume 后会重 init)
- **防重放**:恶意的旧 init 请求不能覆盖新状态
- **支持 hash 重置**:orchestrator 通过 MMDS 通知"接受新 token"
- **触发清理**:init 完成后 thaw pause 时冻结的 cgroup
- **配置一切**:env vars、user、workdir、CA、NFS、clock

### 12.2 完整流程

文件:[`internal/api/init.go:115 PostInit`](../../packages/envd/internal/api/init.go)

```
POST /init { User, EnvVars, Workdir, Access Token, ... }
       │
       ▼
1. memguard.WipeBytes(body)(返回时擦明文,init.go:127)
       │
       ▼
2. 获取 initLock(1-slot semaphore,store.go:72)
   保证全局只一个 init 在跑
       │
       ▼
3. defer unfreezeUserCgroups(ctx)(总 thaw,init.go:168)
   即使本次 init 失败,也确保 pause 后能 thaw
       │
       ▼
4. validateInitAccessToken:
   ├─ body.Token == 已存 token → OK
   ├─ body.Token 的 hash == MMDS hash → OK
   ├─ MMDS hash == hash("") → OK(重置)
   └─ 否则 → 401
       │
       ▼
5. lastSetTime.SetToGreater(initRequest.Timestamp.UnixNano())
   防重放:时间戳必须单调递增
       │
       ▼
6. SetData(条件性):
   ├─ 设置系统时钟(若漂移 > 50ms 落后 / > 5s 提前)
   ├─ EnvVars.ReplaceUserVars(替换 user env vars)
   ├─ accessToken.TakeFrom(token)
   ├─ SetupHyperloop(改 /etc/hosts 指向 hyperloop)
   ├─ DefaultUser / DefaultWorkdir
   ├─ CACertInstaller.Install(若有 CA cert)
   └─ setupNFS(挂载 NFS volumes, 10s 超时)
       │
       ▼
7. 异步:host.PollForMMDSOpts(60s 超时)
   重新拉 MMDS,确保 env vars 最新
       │
       ▼
8. 204 No Content
```

### 12.3 关键设计:为什么 init 是 defer unfreeze

```
T0: sandbox 运行中
T1: pause → POST /freeze(user/ptys cgroup 冻结)
T2: snapshot → 内存 dump
T3: (一段时间后)resume → orchestrator 恢复内存
T4: 内存里的进程状态还是"冻结中"
T5: SDK 调 POST /init → defer unfreeze → 进程恢复执行
```

如果在 init 主体逻辑之前发生 panic / 错误返回,defer 仍会执行 unfreeze,避免 sandbox 卡死。

### 12.4 SetData 详解

文件:[`init.go:191-245`](../../packages/envd/internal/api/init.go)

```go
// 注意:接收 PostInitJSONBody(SDK 传入),不是自定义 InitRequest;
// 每个 KV 字段都是 *string / *map 的可选指针,需要 nil 检查。
func (a *API) SetData(ctx context.Context, logger zerolog.Logger, data PostInitJSONBody) error {
    // 1. 系统时钟校正(data.Timestamp 是 *time.Time)
    if data.Timestamp != nil && shouldSetSystemTime(time.Now(), *data.Timestamp) {
        setSystemTime(*data.Timestamp)
    }

    // 2. 替换 user env vars(*data.EnvVars 是 map)
    if data.EnvVars != nil {
        a.defaults.EnvVars.ReplaceUserVars(*data.EnvVars)
    }

    // 3. 设置 access token(move 语义);若新 token 未设且旧的已设 → Destroy 清空
    if data.AccessToken.IsSet() {
        a.accessToken.TakeFrom(data.AccessToken)
    } else if a.accessToken.IsSet() {
        a.accessToken.Destroy()
    }

    // 4. SetupHyperloop(改 /etc/hosts,让 events.e2b.local 指向 hyperloop IP)
    //    异步:go a.SetupHyperloop(*data.HyperloopIP)
    //    内部设 E2B_EVENTS_ADDRESS env var

    // 5. 默认用户/工作目录(字段名是 DefaultUser / DefaultWorkdir,带空串检查)
    if data.DefaultUser != nil && *data.DefaultUser != "" {
        a.defaults.User = *data.DefaultUser
    }
    if data.DefaultWorkdir != nil && *data.DefaultWorkdir != "" {
        a.defaults.Workdir = data.DefaultWorkdir  // *string 类型
    }

    // 6. CA 证书(data.CaBundle,字段名非 CACert)
    if data.CaBundle != nil && *data.CaBundle != "" {
        a.caCertInstaller.Install(ctx, *data.CaBundle)
    }

    // 7. NFS 挂载(*data.VolumeMounts + data.LifecycleID)
    if data.VolumeMounts != nil {
        a.setupNFS(ctx, logger, data.LifecycleID, *data.VolumeMounts)
    }

    return nil
}
```

### 12.5 shouldSetSystemTime

文件:[`init.go:38-41, 572`](../../packages/envd/internal/api/init.go)

```go
// 实际常量名(注意与"drift"不同):
const (
    maxTimeInPast   = 50 * time.Millisecond   // sandbox 落后 host 上限
    maxTimeInFuture = 5 * time.Second         // sandbox 提前 host 上限
)

// 参数顺序:(sandboxTime, hostTime) — 注意 sandboxTime 在前
func shouldSetSystemTime(sandboxTime, hostTime time.Time) bool {
    return sandboxTime.Before(hostTime.Add(-maxTimeInPast)) ||
           sandboxTime.After(hostTime.Add(maxTimeInFuture))
}
```

#### 为什么这么宽松

- 落后 50ms 内:影响很小,不调
- 提前 5s 内:可能 init 请求刚发出,network latency 解释,不调
- 超过这些阈值:用 SDK 的时钟强行覆盖(`setSystemTime` → `unix.ClockSettime`)

---

## 十三、pause / resume 配合

### 13.1 完整 pause 流程

```
orchestrator 决定 pause sandbox
       │
       ▼
1. POST /freeze → envd
   envd: cgroupManager.Freeze(user + ptys)
   → 用户进程瞬间冻结
       │
       ▼
2. POST /fsfreeze(只 filesystem-only pause)
   envd: FIFREEZE on "/" → 文件系统 quiesced
       │
       ▼
3. POST /collapse(envd 自身内存整理)
   envd: MADV_COLLAPSE → anon pages 合并成 THP
       │
       ▼
4. orchestrator 通过 Firecracker API 触发 snapshot
   ├─ Full snapshot:内存 + rootfs → 上传 GCS
   └─ Filesystem-only snapshot:只 rootfs(内存丢弃)
```

### 13.2 完整 resume 流程

```
orchestrator 决定 resume sandbox
       │
       ▼
1. 通过 Firecracker API load snapshot
   ├─ 内存恢复(envd 进程状态恢复)
   └─ rootfs 恢复(或复用)
       │
       ▼
2. 内存里 envd 还停在 "Frozen" 状态
   (上次 pause 时 freeze 了 cgroup)
       │
       ▼
3. orchestrator 通过 MMDS 写新 AccessTokenHash
   (告诉 envd "下次 /init 接受这个 token")
       │
       ▼
4. SDK 调 POST /init with new token
       │
       ▼
5. envd PostInit:
   ├─ checkMMDSHash 验证新 token
   ├─ SetData 配置新 env vars / user / workdir
   └─ defer unfreezeUserCgroups → 进程恢复执行!
```

### 13.3 关键不变量

- **进程不死**:pause 只 freeze,不 kill。Resume 后进程从被冻结的瞬间继续执行
- **token 可重置**:MMDS hash 机制让 orchestrator 能在 resume 后强制换 token
- **状态从内存恢复**:envd 不依赖磁盘持久化,所有状态(memory + MMDS)
- **/init 是必经**:resume 后必须有一次 /init,否则 cgroup 还冻着

---

## 十四、Legacy SDK 兼容

### 14.1 背景

早期 connect-python SDK 的 UserAgent 标识错误(`brokenUserAgent`,`legacy/interceptor.go:11`),导致 server 端发的某些 proto 字段(尤其 `EntryInfo` 新增的 `size/mode/permissions/owner/group`)无法被反序列化。

### 14.2 兜底机制

文件:[`internal/services/legacy/`](../../packages/envd/internal/services/legacy/)

```
请求进来
    │
    ▼
interceptor.go:15
   if User-Agent == "connect-python"(broken):
       set X-E2B-Legacy-SDK: true
    │
    ▼
conversion.go(init at line 57):
   注册 converter,对 FilesystemService 的响应做转换
    │
    ▼
对于 MoveResponse/ListDirResponse/MakeDirResponse/
    RemoveResponse/StatResponse/WatchDirResponse/
    CreateWatcherResponse/GetWatcherEventsResponse:
   只保留 EntryInfo{Name, Type, Path}
   丢弃其他字段
    │
    ▼
stream.go:
   StreamingHandlerConn.Send 包装,流式响应同样转换
```

### 14.3 为什么不直接升级 SDK

- 客户 SDK 在用户环境(本地、CI)运行,升级周期长
- 老 SDK 已经在 production 用了很久,直接断兼容影响大
- 兜底机制让 server 同时支持新旧 SDK,平滑过渡

---

## 十五、Proto 与代码生成

### 15.1 文件结构

```
packages/envd/spec/
├── envd.yaml                          # OpenAPI 3.0 spec(REST)
├── buf.gen.yaml                       # Connect RPC 生成配置(envd-local)
├── buf.gen.shared.yaml                # Connect RPC 生成配置(shared with SDK)
├── generate.go                        # //go:generate 入口
├── process/
│   └── process.proto                  # Process service proto
└── filesystem/
    └── filesystem.proto               # Filesystem service proto
```

### 15.2 生成产物

```
packages/envd/internal/services/spec/
├── filesystem/
│   ├── filesystem.pb.go              # proto 生成的 message types
│   └── filesystemconnect/
│       ├── filesystem.connect.go     # Connect RPC client/server stubs
│       └── mocks/
│           └── mocks.go              # 自动生成的 mock(用于测试)
└── process/
    ├── process.pb.go
    └── processconnect/
        ├── process.connect.go
        └── mocks/
            └── mocks.go

packages/shared/pkg/grpc/envd/        # 给 SDK / orchestrator 用
└── (同上结构)
```

### 15.3 两份生成配置

- `buf.gen.yaml`:输出 envd 内部用(`internal/services/spec/`)
- `buf.gen.shared.yaml`:输出 shared 包(`packages/shared/pkg/grpc/envd/`),给 orchestrator 和 SDK 用

`spec/generate.go:3-4`:

```go
//go:generate buf generate --template buf.gen.yaml
//go:generate buf generate --template buf.gen.shared.yaml
```

### 15.4 修改 proto 的流程

1. 编辑 `spec/process/process.proto` 或 `spec/filesystem/filesystem.proto`
2. 运行 `make generate`(在 packages/envd/)
3. 两份生成代码自动更新
4. **重要**:`pkg/version.go` 的 `Version` 必须 bump — orchestrator 检查版本兼容性

### 15.5 version 的重要性

文件:[`packages/envd/pkg/version.go`](../../packages/envd/pkg/version.go)

```go
const Version = "0.6.8"
```

- envd 的 `ServiceInfoResponse` 不上报 version(那是 orchestrator 的事)
- 但 template metadata 记录 `EnvdVersion`
- orchestrator 启动 sandbox 时,根据 template 的 `EnvdVersion` 选择兼容的 envd 二进制
- **bump 规则**:任何 proto 字段、RPC、行为变化都要 bump;纯注释/文档变更不需要

---

## 十六、配置、Flag 与环境变量

### 16.1 命令行 flags

文件:[`main.go:62-113 parseFlags`](../../packages/envd/main.go)

| Flag | 默认 | 用途 |
|------|------|------|
| `-isnotfc` | `false` | 非 Firecracker 环境(本地测试),跳过 MMDS poll 和 log exporter |
| `-port` | `49983` | 监听端口 |
| `-cgroup-root` | `/sys/fs/cgroup` | cgroup v2 根目录 |
| `-no-cgroups` | `false` | 禁用 cgroup(用 NoopManager) |
| `-verbose` | `false` | 日志同时输出到 stdout |
| `-version` | (print) | 打印 version 退出 |
| `-commit` | (print) | 打印 commit SHA 退出 |

### 16.2 环境变量(envd 进程视角)

envd 通过 MMDS 拿到后注入的:

| Env Var | 来源 | 用途 |
|---------|------|------|
| `E2B_SANDBOX_ID` | MMDS | 当前 sandbox ID |
| `E2B_TEMPLATE_ID` | MMDS | 当前 template ID |
| `E2B_EVENTS_ADDRESS` | `/init` SetupHyperloop | events endpoint |

envd 自己使用的:

| Env Var | 用途 |
|---------|------|
| `E2B_SANDBOX` | 标记自己是 sandbox 环境(写 `/run/e2b/.E2B_SANDBOX`) |

envd 注入给用户进程的:

- 所有 SDK 通过 `/init` 传的 `EnvVars`
- envd internal 的(不可被用户覆盖)

### 16.3 文件系统位置

| 路径 | 用途 |
|------|------|
| `/run/e2b/` | envd 运行时目录 |
| `/run/e2b/.E2B_SANDBOX` | sandbox 标记文件 |
| `/run/e2b/.E2B_SANDBOX_ID` | sandbox ID 持久化 |
| `/run/e2b/.E2B_TEMPLATE_ID` | template ID 持久化 |
| `/sys/fs/cgroup/e2b/` | envd 管理的 cgroup 根 |
| `/sys/fs/cgroup/e2b/ptys/` | PTY 进程 cgroup |
| `/sys/fs/cgroup/e2b/socats/` | socat 进程 cgroup |
| `/sys/fs/cgroup/e2b/user/` | 用户进程 cgroup |
| `/etc/ssl/certs/ca-certificates.crt` | CA 证书 bundle(tmpfs bind-mount) |
| `/usr/local/share/ca-certificates/e2b-ca.crt` | envd 安装的 CA 证书 |

### 16.4 HTTP Headers(envd 识别的)

| Header | 用途 |
|--------|------|
| `X-Access-Token` | access token 鉴权 |
| `Authorization: Basic <base64>` | 用户名(unix user)解析 |
| `Keepalive-Ping-Interval` | Connect RPC keepalive 周期(秒) |
| `Connect-Timeout-Ms` | process.start 的超时(毫秒) |
| `User-Agent` | 检测 legacy SDK |
| `X-E2B-Legacy-SDK` | 内部标记(legacy 兜底) |
| `X-Metadata-<key>` | `/files` 上传时写入 xattr |
| `Accept-Encoding` | gzip 协商 |
| `signature`, `signature_expiration` | `/files` HMAC 签名 |

---

## 十七、关键代码文件索引

### 17.1 入口与主流程

| 文件 | 作用 |
|------|------|
| [`main.go`](../../packages/envd/main.go) | 入口、flag 解析、所有组件装配 |
| [`pkg/version.go`](../../packages/envd/pkg/version.go) | version 常量(必须 bump) |
| [`internal/execcontext/context.go`](../../packages/envd/internal/execcontext/context.go) | `Defaults{User, EnvVars, Workdir}` + path/user 解析 |

### 17.2 Connect RPC 服务

| 文件 | 作用 |
|------|------|
| [`internal/services/process/service.go`](../../packages/envd/internal/services/process/service.go) | `ProcessService` 主体 |
| [`internal/services/process/start.go`](../../packages/envd/internal/services/process/start.go) | `Start` RPC(最重要的流式 RPC) |
| [`internal/services/process/list.go`](../../packages/envd/internal/services/process/list.go) | `List` RPC |
| [`internal/services/process/connect.go`](../../packages/envd/internal/services/process/connect.go) | `Connect` RPC(订阅已有进程) |
| [`internal/services/process/update.go`](../../packages/envd/internal/services/process/update.go) | `Update` RPC(PTY resize) |
| [`internal/services/process/signal.go`](../../packages/envd/internal/services/process/signal.go) | `SendSignal` RPC |
| [`internal/services/process/input.go`](../../packages/envd/internal/services/process/input.go) | `SendInput`/`StreamInput`/`CloseStdin` |
| [`internal/services/process/handler/handler.go`](../../packages/envd/internal/services/process/handler/handler.go) | 进程 wrapper(命令包装、cgroup、PTY) |
| [`internal/services/process/handler/multiplex.go`](../../packages/envd/internal/services/process/handler/multiplex.go) | fan-out 广播(Start+Connect 共享订阅) |
| [`internal/services/process/handler/cgroupfd_linux.go`](../../packages/envd/internal/services/process/handler/cgroupfd_linux.go) | `CLONE_INTO_CGROUP` 设置 |
| [`internal/services/filesystem/service.go`](../../packages/envd/internal/services/filesystem/service.go) | `FilesystemService` 主体 |
| [`internal/services/filesystem/stat.go`](../../packages/envd/internal/services/filesystem/stat.go) | `Stat` |
| [`internal/services/filesystem/dir.go`](../../packages/envd/internal/services/filesystem/dir.go) | `MakeDir`/`ListDir`/`EnsureDirs` |
| [`internal/services/filesystem/move.go`](../../packages/envd/internal/services/filesystem/move.go) | `Move` |
| [`internal/services/filesystem/remove.go`](../../packages/envd/internal/services/filesystem/remove.go) | `Remove` |
| [`internal/services/filesystem/watch.go`](../../packages/envd/internal/services/filesystem/watch.go) | `WatchDir`(流式 watch) |
| [`internal/services/filesystem/watch_sync.go`](../../packages/envd/internal/services/filesystem/watch_sync.go) | `CreateWatcher`/`GetWatcherEvents`/`RemoveWatcher`(非流式) |
| [`internal/services/filesystem/utils.go`](../../packages/envd/internal/services/filesystem/utils.go) | 共用工具 |

### 17.3 内存与文件系统操作

| 文件 | 作用 |
|------|------|
| [`internal/services/memory/collapse.go`](../../packages/envd/internal/services/memory/collapse.go) | THP collapse `Stats` |
| [`internal/services/memory/collapse_linux.go`](../../packages/envd/internal/services/memory/collapse_linux.go) | `CollapseSelf`(`MADV_COLLAPSE`) |
| [`internal/services/fsfreeze/fsfreeze.go`](../../packages/envd/internal/services/fsfreeze/fsfreeze.go) | `Freezer` interface |
| [`internal/services/fsfreeze/fsfreeze_linux.go`](../../packages/envd/internal/services/fsfreeze/fsfreeze_linux.go) | `FIFREEZE`/`FITHAW` ioctl |

### 17.4 Legacy 兼容

| 文件 | 作用 |
|------|------|
| [`internal/services/legacy/interceptor.go`](../../packages/envd/internal/services/legacy/interceptor.go) | 检测 brokenUserAgent |
| [`internal/services/legacy/conversion.go`](../../packages/envd/internal/services/legacy/conversion.go) | 注册 EntryInfo 转换器 |
| [`internal/services/legacy/stream.go`](../../packages/envd/internal/services/legacy/stream.go) | streaming Send 包装 |

### 17.5 cgroups

| 文件 | 作用 |
|------|------|
| [`internal/services/cgroups/iface.go`](../../packages/envd/internal/services/cgroups/iface.go) | `Manager` interface + `ProcessType` 枚举 |
| [`internal/services/cgroups/cgroup2.go`](../../packages/envd/internal/services/cgroups/cgroup2.go) | Linux cgroup v2 实现 |
| [`internal/services/cgroups/cgroup2_stub.go`](../../packages/envd/internal/services/cgroups/cgroup2_stub.go) | 非 Linux stub |
| [`internal/services/cgroups/noop.go`](../../packages/envd/internal/services/cgroups/noop.go) | no-op fallback |

### 17.6 REST API 层

| 文件 | 作用 |
|------|------|
| [`internal/api/store.go`](../../packages/envd/internal/api/store.go) | `API` server struct + `New` + `GetHealth`/`GetMetrics` |
| [`internal/api/init.go`](../../packages/envd/internal/api/init.go) | `POST /init`(最复杂)+ freeze/unfreeze + SetData |
| [`internal/api/auth.go`](../../packages/envd/internal/api/auth.go) | `WithAuthorization` middleware + HMAC 签名 |
| [`internal/api/secure_token.go`](../../packages/envd/internal/api/secure_token.go) | `SecureToken`(memguard) |
| [`internal/api/upload.go`](../../packages/envd/internal/api/upload.go) | `POST /files` |
| [`internal/api/download.go`](../../packages/envd/internal/api/download.go) | `GET /files`(支持 Range) |
| [`internal/api/compose.go`](../../packages/envd/internal/api/compose.go) | `POST /files/compose`(零拷贝拼接) |
| [`internal/api/envs.go`](../../packages/envd/internal/api/envs.go) | `GET /envs` |
| [`internal/api/collapse.go`](../../packages/envd/internal/api/collapse.go) | `POST /collapse` |
| [`internal/api/fsfreeze.go`](../../packages/envd/internal/api/fsfreeze.go) | `POST /fsfreeze`/`fsthaw` |
| [`internal/api/encoding.go`](../../packages/envd/internal/api/encoding.go) | gzip 协商 |
| [`internal/api/error.go`](../../packages/envd/internal/api/error.go) | JSON 错误响应 |
| [`internal/api/clock_linux.go`](../../packages/envd/internal/api/clock_linux.go) | `setSystemTime` |
| [`internal/api/api.gen.go`](../../packages/envd/internal/api/api.gen.go) | OpenAPI 生成的 chi 路由 |

### 17.7 端口转发

| 文件 | 作用 |
|------|------|
| [`internal/port/scan.go`](../../packages/envd/internal/port/scan.go) | `Scanner`(gopsutil) |
| [`internal/port/scanSubscriber.go`](../../packages/envd/internal/port/scanSubscriber.go) | `ScannerSubscriber` |
| [`internal/port/scanfilter.go`](../../packages/envd/internal/port/scanfilter.go) | `ScannerFilter`(loopback LISTEN) |
| [`internal/port/forward.go`](../../packages/envd/internal/port/forward.go) | `Forwarder`(socat per port) |
| [`internal/port/forward_cgroupfd_linux.go`](../../packages/envd/internal/port/forward_cgroupfd_linux.go) | socat 归入 cgroup |

### 17.8 host 交互

| 文件 | 作用 |
|------|------|
| [`internal/host/mmds.go`](../../packages/envd/internal/host/mmds.go) | MMDS 协议 + `PollForMMDSOpts` |
| [`internal/host/mmds_route_linux.go`](../../packages/envd/internal/host/mmds_route_linux.go) | `PinMMDSRoute`(iptables 自愈) |
| [`internal/host/metrics.go`](../../packages/envd/internal/host/metrics.go) | `GetMetrics`(CPU/mem/disk) |
| [`internal/host/cacerts.go`](../../packages/envd/internal/host/cacerts.go) | CA 证书注入 |

### 17.9 权限与日志

| 文件 | 作用 |
|------|------|
| [`internal/permissions/authenticate.go`](../../packages/envd/internal/permissions/authenticate.go) | Connect-RPC authn + `GetAuthUser` |
| [`internal/permissions/user.go`](../../packages/envd/internal/permissions/user.go) | unix user 解析 |
| [`internal/permissions/path.go`](../../packages/envd/internal/permissions/path.go) | `ExpandAndResolve` + `EnsureDirs` |
| [`internal/permissions/keepalive.go`](../../packages/envd/internal/permissions/keepalive.go) | Connect RPC keepalive |
| [`internal/logs/logger.go`](../../packages/envd/internal/logs/logger.go) | zerolog logger 构造 |
| [`internal/logs/interceptor.go`](../../packages/envd/internal/logs/interceptor.go) | RPC log 拦截器 |
| [`internal/logs/exporter/exporter.go`](../../packages/envd/internal/logs/exporter/exporter.go) | HTTP log exporter |
| [`internal/logs/exporter/rate_limited_logger.go`](../../packages/envd/internal/logs/exporter/rate_limited_logger.go) | rate-limited log wrapper |
| [`internal/logs/ratelimit/ratelimit.go`](../../packages/envd/internal/logs/ratelimit/ratelimit.go) | 通用 rate limiter |

### 17.10 utils

| 文件 | 作用 |
|------|------|
| [`internal/utils/envvars.go`](../../packages/envd/internal/utils/envvars.go) | `EnvVars`(internal vs user) |
| [`internal/utils/multipart.go`](../../packages/envd/internal/utils/multipart.go) | `CustomPart`(保留相对路径) |
| [`internal/utils/atomic.go`](../../packages/envd/internal/utils/atomic.go) | `AtomicMax`(防重放) |
| [`internal/utils/map.go`](../../packages/envd/internal/utils/map.go) | generic typed `Map[K,V]` |
| [`internal/utils/rfsnotify.go`](../../packages/envd/internal/utils/rfsnotify.go) | 递归 fsnotify 路径 |

### 17.11 spec(代码生成)

| 文件 | 作用 |
|------|------|
| [`spec/process/process.proto`](../../packages/envd/spec/process/process.proto) | Process service proto |
| [`spec/filesystem/filesystem.proto`](../../packages/envd/spec/filesystem/filesystem.proto) | Filesystem service proto |
| [`spec/envd.yaml`](../../packages/envd/spec/envd.yaml) | OpenAPI 3.0 spec(REST) |
| [`spec/buf.gen.yaml`](../../packages/envd/spec/buf.gen.yaml) | Connect RPC 生成配置(local) |
| [`spec/buf.gen.shared.yaml`](../../packages/envd/spec/buf.gen.shared.yaml) | Connect RPC 生成配置(shared) |
| [`spec/generate.go`](../../packages/envd/spec/generate.go) | `//go:generate` 入口 |

---

## 十八、设计要点与权衡

### 18.1 为什么同时支持 Connect RPC 和 REST

**Connect RPC 的优势**:
- HTTP/2 多路复用,流式接口高效
- 强类型 proto,客户端 SDK 类型安全
- 双向流(`StreamInput`)

**REST/OpenAPI 的优势**:
- 浏览器原生支持(预签名 URL 直接给浏览器)
- curl/Postman 友好
- 文件上传 multipart 标准化
- 跨语言客户端无需 proto 编译

**结论**:**性能敏感的进程/FS 操作走 Connect,文件上传/下载/管理走 REST**,各取所长。

### 18.2 为什么用 memguard 锁 token

access token 是 SDK ↔ sandbox 的唯一凭证。如果 token 泄露:
- 攻击者可以读/写 sandbox 内文件
- 可以执行任意进程
- 可以窃取用户数据

memguard 提供:
- **mlock**:不被 swap 到磁盘(防止 swap 文件分析)
- **guard pages**:缓冲区溢出前后页保护
- **零化销毁**:内存释放时清零
- **常量时间比较**:防时序攻击

这是 defense in depth,即使 sandbox 内其他代码有漏洞也尽量保护 token。

### 18.3 为什么端口转发用 socat

**直接做代理(Go 实现)的问题**:
- 每个连接一个 goroutine,大量连接时调度开销大
- Go 的 net 包对 TCP 边缘情况处理不如 socat 成熟
- 资源归因难(代理跑在 envd 进程内,cgroup 归 envd)

**socat 的优势**:
- C 语言几十年验证,稳定可靠
- `fork` 模式:每连接一个进程,cgroup 可控
- 单独进程,被 cgroup 隔离(`socats`)
- 可以独立 kill -9 不影响 envd

**代价**:每端口一个 socat 进程,资源消耗略高。但 sandbox 通常端口数有限(几个到几十个),可接受。

### 18.4 为什么用 cgroup v2 而不是 v1

- **统一层级**:v1 多层级导致进程归属混乱,v2 单一层级清晰
- **`CLONE_INTO_CGROUP`**:v2 独有,fork 瞬间归位 cgroup,无窗口期
- **`cgroup.freeze`**:v2 简单写文件即可 freeze,v1 要分别操作 freezer 子系统
- **新特性**:psi、io.max 等只在 v2

代价:旧内核(<4.5)不支持。但 E2B 用的 Firecracker microVM 内核是新的(5.x+),没问题。

### 18.5 为什么 memory collapse 在 envd 而不是 host

**对象**:envd 的 anon heap(Go runtime 分配的)
**目的**:减少 pause → resume 时的 page fault

如果在 host 做(host 不在 sandbox 内):
- 无法访问 guest 物理内存布局
- 无法做 `MADV_COLLAPSE`(这是 guest 内 syscall)

在 envd 内做:
- envd 知道自己的 heap 区域
- 可以解析 `/proc/self/maps`
- `MADV_COLLAPSE` 直接影响 guest 物理页

代价:envd 启动时多花几十毫秒整理(只在 pause 前调用,不影响热路径)。

### 18.6 为什么 `/init` 不存"已初始化"标记

**常规设计**:第一次 init 设置 flag,后续 init 直接拒绝。
**envd 设计**:**幂等 + 防重放**,可以重复 init。

#### 为什么这么设计

- **resume 场景**:每次 resume 都是一次新的 /init,但要更新 token / env vars
- **SDK 重连**:SDK 重启后可能重新 init
- **网络重试**:HTTP 重试不应该被卡

#### 怎么防恶意重放

- **时间戳单调**:`lastSetTime.SetToGreater(timestamp.UnixNano())`
- **MMDS hash 验证**:orchestrator 通过 MMDS 控制"接受哪些 token"
- **defer unfreeze**:即使老 init 没更新状态,也确保进程不卡

### 18.7 为什么 watch 有两套

**`WatchDir`(流式)的问题**:
- HTTP/2 长连接
- 某些 proxy(client-proxy)在 idle 时关闭连接
- 客户端必须重新建立 watch

**`watch_sync`(非流式)的优势**:
- 每次 `GetWatcherEvents` 是短请求
- 事件在 envd 内缓冲,客户端拉取
- 容忍 proxy 超时

**代价**:
- 实时性差(取决于客户端轮询频率)
- 事件缓冲可能在 `GetWatcherEvents` 前丢失(有上限)

**策略**:让客户端选,根据网络环境用合适的 API。

### 18.8 为什么 `PostFiles` 不用 atomic rename

**`/files` 设计目标**:覆盖写,路径稳定。

如果用 atomic rename(写到临时文件再 rename):
- inode 变了 → 客户端持有的 fd 失效
- 其他进程通过路径打开会看到旧文件(直到 rename 完成)
- 不能修改已存在文件的部分内容

`/files` 用 `O_WRONLY|O_CREATE|O_TRUNC`:
- 原地截断写
- inode 不变
- 客户端可以在上传过程中 read(看到部分内容)

代价:并发上传同一 path 会乱(后写覆盖),但 SDK 通常不会这么用。

需要 atomic 语义的用 `/files/compose`。

---

## 十九、常见问题与排查

### 19.1 sandbox 启动后 SDK 连不上

**症状**:SDK 调 `/init` 超时

**排查**:

1. 检查 envd 是否启动:`curl http://<sandbox-ip>:49983/health`(应返回 204)
2. 检查 MMDS 是否可达(在 sandbox 内):`curl -H "X-metadata-token: ..." http://169.254.169.254`
3. 看 envd 日志(`stdout` 或 Loki):是否有 MMDS poll 失败
4. 检查 orchestrator 是否正确配置了 Firecracker MMDS

### 19.2 进程启动失败

**症状**:`process.start` RPC 报错

**排查**:

1. 检查 unix user 是否存在:`/etc/passwd` 里有 SDK 传的 user 吗?
2. 检查 cwd 是否存在:用户传的 cwd 路径有效吗?
3. 检查命令本身:在 sandbox 内手动跑一次
4. 看 envd log:启动失败会写日志

### 19.3 端口转发不工作

**症状**:外部访问 sandbox 端口连不上

**排查**:

1. 在 sandbox 内确认进程在 listen:`netstat -tlnp | grep <port>`
2. 检查是否监听在 loopback(`127.0.0.1` 或 `::1`):scanner 只扫 loopback
3. 检查 socat 是否启动:`ps aux | grep socat`
4. 检查 cgroup:如果 cgroup 满了 socat 可能 spawn 失败

### 19.4 `/init` 返回 401

**症状**:SDK 调 `/init` 被拒

**排查**:

1. 检查 body 里的 token 是否正确
2. 检查 MMDS 里的 `AccessTokenHash` 是否匹配
3. 如果是 resume 场景,确认 orchestrator 在 resume 前写了正确的 hash 到 MMDS
4. 看 envd log:`checkMMDSHash` 失败会写日志

### 19.5 sandbox resume 后进程卡住

**症状**:resume 后用户进程不响应

**排查**:

1. 检查 `/init` 是否被调用:resume 后 SDK 必须调 `/init` 触发 unfreeze
2. 检查 cgroup.freeze 状态:`cat /sys/fs/cgroup/e2b/user/cgroup.freeze`(应为 0)
3. 如果是 1,手动调 `POST /unfreeze`
4. 看 envd log:`unfreezeUserCgroups` 是否执行

### 19.6 文件上传失败

**症状**:`POST /files` 报 507 或其他错误

**排查**:

1. 检查磁盘空间:507 = ENOSPC
2. 检查路径权限:envd 以 SDK 传的 user 身份写,该 user 对目录有写权限吗?
3. 检查路径是否存在:EnsureDirs 创建父目录失败?
4. 检查 multipart 格式:`Content-Disposition: filename` 是否带相对路径?

### 19.7 日志收集不到

**症状**:Loki 里看不到 sandbox 日志

**排查**:

1. 检查 MMDS `LogsCollectorAddress` 是否设置(在 sandbox 内 curl MMDS)
2. 检查 envd 是否能 reach collector:`curl <address>` 测试
3. 看 envd log:HTTPLogsExporter 失败会有 rate-limited 错误
4. 检查 collector 是否运行(otel-collector 或 Loki)

### 19.8 PTY resize 不生效

**症状**:`Update` RPC 后终端大小没变

**排查**:

1. 确认进程是 PTY 启动的(`StartRequest` 带了 `pty`)
2. 检查 winsize 是否合理:`Rows/Cols` 都是正数?
3. 检查 ioctl 是否成功:envd log 可能有 `TIOCSWINSZ` 错误

---

## 附录 A:REST 端点速查

| Method | Path | 鉴权 | 用途 |
|--------|------|------|------|
| `POST` | `/init` | MMDS hash | 配置 sandbox(user/env/token/NFS/clock) |
| `GET` | `/health` | 豁免 | 健康检查 |
| `GET` | `/envs` | token | 列环境变量 |
| `GET` | `/files?path=` | HMAC | 下载文件(支持 Range/gzip) |
| `POST` | `/files` | HMAC | 上传文件(octet-stream 或 multipart) |
| `POST` | `/files/compose` | token | 零拷贝拼接多个文件 |
| `GET` | `/metrics` | token | CPU/mem/disk 指标 |
| `POST` | `/collapse` | token | 内存 THP 整理 |
| `POST` | `/freeze` | token | freeze user+ptys cgroup |
| `POST` | `/unfreeze` | token | unfreeze user+ptys cgroup |
| `POST` | `/fsfreeze` | token | FIFREEZE rootfs |
| `POST` | `/fsthaw` | token | FITHAW rootfs |

---

## 附录 B:Connect RPC 速查

### Process Service

| RPC | 类型 | 用途 |
|-----|------|------|
| `Start` | server stream | 启动进程,推送 ProcessEvent |
| `List` | unary | 列出跟踪的进程 |
| `Connect` | server stream | 订阅已有进程事件 |
| `Update` | unary | PTY resize |
| `SendInput` | unary | 一次性 stdin |
| `StreamInput` | client stream | 流式 stdin |
| `CloseStdin` | unary | 关闭 stdin |
| `SendSignal` | unary | SIGTERM/SIGKILL |

### Filesystem Service

| RPC | 类型 | 用途 |
|-----|------|------|
| `Stat` | unary | 文件元信息 |
| `MakeDir` | unary | 递归创建 |
| `ListDir` | unary | 列目录 |
| `Move` | unary | rename |
| `Remove` | unary | 删除 |
| `WatchDir` | server stream | 流式 watch |
| `CreateWatcher` | unary | 创建非流式 watcher |
| `GetWatcherEvents` | unary | 拉取累积事件 |
| `RemoveWatcher` | unary | 关闭 watcher |

---

## 附录 C:术语表

| 术语 | 含义 |
|------|------|
| envd | E2B 的 in-VM daemon,跑在每个 Firecracker microVM 内 |
| Connect RPC | Buf 出品的 HTTP/2 RPC 框架 |
| MMDS | Firecracker MicroVM Metadata Service,固定地址 169.254.169.254 |
| SecureToken | 基于 memguard 的 access token 容器 |
| ProcessType | cgroup 归类(system/user/pty/socat) |
| CLONE_INTO_CGROUP | Linux clone3 flag,fork 瞬间归位 cgroup |
| THP | Transparent Huge Pages,2MiB 大页 |
| MADV_COLLAPSE | Linux madvise 标志,立即合并小页为 THP |
| FIFREEZE / FITHAW | Linux ioctl,冻结/解冻文件系统 |
| cgroup v2 | Linux cgroup 第二版,统一层级 |
| fsnotify | Go 的文件系统事件库,inotify 封装 |
| socat | 网络转发工具,envd 用它做端口转发 |
| memguard | Go 的安全内存库,mlock + guard pages |
| hyperloop | sandbox 内部 events 通道 |
| `/init` | SDK 调用的初始化端点,配置 sandbox |
| pause / resume | sandbox 快照暂停 / 恢复 |
| Legacy SDK | 早期 connect-python SDK,需要 proto 字段裁剪兜底 |
| Keepalive | Connect RPC 心跳,防止 idle stream 被关 |

---

**文档版本**:基于代码库 HEAD(2026-07-11)

**维护**:如有疑问或发现文档过期,请对照 [`packages/envd/`](../../packages/envd/) 的最新代码核对。
