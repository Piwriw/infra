# Envd 模块详细介绍

> **来源**: 基于 `.understand-anything/knowledge-graph.json` 自动生成  
> **架构层**: `layer:vm-daemon`（VM 守护进程层），共 106 个 envd 节点  
> **总规模**: 361 个知识图谱节点 / 954 条边（涉及 envd）

## 📌 模块定位

`packages/envd/` 是 E2B 平台中**运行在每个 Firecracker microVM 内部**的守护进程，是 sandbox 与外部世界（orchestrator + client-proxy）通信的核心中介。它在 VM 启动时被拉起，对外暴露：

- **HTTP/h2c REST API**（基于 OpenAPI 生成的 chi 路由）
- **Connect-RPC gRPC 服务**（filesystem + process 两个服务）

主要职责：

1. **沙箱初始化**：在 sandbox 启动时同步时间、加载 CA 证书、挂载 NFS volume、设置默认用户/工作目录
2. **文件系统操作**：目录 CRUD、文件上传/下载、移动、监视目录变更
3. **进程管理**：在 sandbox 内执行用户命令流式返回 stdout/stderr
4. **端口转发**：将 sandbox 内部 TCP 端口通过 cgroup 转发到宿主机供 client-proxy 代理
5. **指标暴露**：CPU/内存/磁盘等 cgroup 统计
6. **cgroup 资源控制**：freeze/unfreeze 用户进程（与 orchestrator 的 pause/resume 协调）

## 🏗️ 顶层结构

```
packages/envd/
├── main.go                  # 守护进程主入口 (300 行)
├── pkg/
│   └── version.go          # 版本常量
├── spec/                   # OpenAPI + Protobuf 契约
│   ├── envd.yaml           # OpenAPI 3.0 HTTP 规范
│   ├── buf.gen.yaml        # protoc 生成配置
│   ├── buf.gen.shared.yaml
│   ├── generate.go
│   ├── filesystem/
│   │   └── filesystem.proto
│   └── process/
│       └── process.proto
├── internal/
│   ├── api/                # HTTP API 层（oapi-codegen 生成）
│   ├── host/               # 主机资源管理（MMDS、CA 证书、指标）
│   ├── logs/               # 日志导出
│   ├── permissions/        # 用户认证与路径权限
│   ├── port/               # 端口扫描与转发
│   ├── services/           # Connect-RPC 服务
│   │   ├── process/        # 进程执行服务
│   │   ├── filesystem/     # 文件系统服务
│   │   ├── cgroups/        # cgroup 抽象
│   │   ├── spec/           # 新版协议 protobuf
│   │   └── legacy/         # 旧版协议兼容层
│   ├── execcontext/        # 执行上下文默认值
│   ├── utils/              # 通用工具
│   └── ...
├── debug.Dockerfile        # Delve 调试镜像
├── Dockerfile
├── Makefile
├── README.md
├── go.mod
└── go.sum
```

## 🔌 HTTP API（`internal/api/`）

envd 的 HTTP API 由 oapi-codegen 从 `spec/envd.yaml` 生成，基于 **chi 路由器**。主要端点：

| 端点 | 用途 | 文件 |
|---|---|---|
| `GET /health` | 健康检查（无认证，返回 204） | `init.go` |
| `GET /metrics` | CPU/内存/磁盘指标 | `init.go` |
| `POST /init` | 沙盒初始化（time sync、env vars、CA bundle、volume mount） | `init.go` |
| `POST /freeze` | 冻结 user/pty/socat cgroups | `init.go` |
| `POST /unfreeze` | 解冻 cgroups | `init.go` |
| `GET /envs` | 获取当前环境变量 | `envs.go` |
| `GET /files` | 下载文件（支持签名过期） | `download.go` |
| `POST /files` | 上传文件（multipart 或原始 body） | `upload.go` |
| `POST /files/compose` | 零拷贝拼接多个源文件 | `compose.go` |

**关键模块**：

- **`auth.go`**：HMAC 签名中间件 `WithAuthorization`，验证 access token，支持白名单路径
- **`secure_token.go`**：用 `memguard` 加密内存中的敏感 token，支持线程安全访问与显式销毁
- **`store.go`**：`API` 主结构，聚合 cgroup 管理器、MMDS 客户端、访问令牌、CA 证书安装器
- **`encoding.go`**：HTTP 内容编码（gzip/deflate）解析与协商
- **`clock_linux.go` / `clock_other.go`**：通过 build tag 实现 `setSystemTime` 跨平台
- **`init.go` (571 行)**：核心初始化逻辑——令牌验证、MMDS 哈希查询、SetData、NFS 挂载决策、freeze/unfreeze

## 🛠️ gRPC 服务（`internal/services/`）

### Process 服务（`internal/services/process/`）

新版 Connect-RPC 进程服务，提供 8 个 RPC：

| RPC | 文件 | 作用 |
|---|---|---|
| `Start` | `start.go` | 创建进程，包装 `exec.Cmd`，返回 ServerStream |
| `Connect` | `connect.go` | 连接到已存在进程的 DataEvent/EndEvent 流 |
| `List` | `list.go` | 列出运行中所有进程 |
| `Update` | `update.go` | 调整 PTY winsize |
| `SendInput` | `input.go` | 写入 stdin（区分 PTY 与普通 stdin） |
| `StreamInput` | `input.go` | client-streaming 持续写入 |
| `CloseStdin` | `input.go` | 关闭 stdin |
| `SendSignal` | `signal.go` | 仅支持 SIGTERM/SIGKILL |

**核心 — `process.Handler`（`handler/handler.go`，487 行）**：

`Handler` 是单进程执行包装体，职责包括：
- 构造 `exec.Cmd`（含 oom_score_adj/ionice/nice 包装）
- 凭证切换（uid/gid）
- **cgroup v2 文件描述符注入**（`cgroupfd_linux.go`）：通过 `SysProcAttr.CgroupFD` 让新进程直接归入指定 cgroup
- PTY/stdout/stderr 多路读取
- stdin/tty 写入
- 信号发送
- Wait 退出事件发布

**`MultiplexedChannel`（`handler/multiplex.go`）**：

泛型 fan-out 通道包装器。内部 Source 单写多读，通过 `RWMutex` 维护订阅者切片 + `exited` 标志，cancel 通过 done channel 实现非阻塞移除。已被遗弃的订阅者不会阻塞 fan-out，Source 关闭时所有订阅者 channel 一并关闭。

### Filesystem 服务（`internal/services/filesystem/`）

新版 Connect-RPC 文件系统服务：

- `dir.go` — ListDir/MakeDir（处理符号链接、相对路径、权限校验）
- `move.go` — Move/Rename（跨目录、跨设备、符号链接）
- `stat.go` — Stat（size/mode/owner/modify-time）
- `remove.go` — Remove（文件/目录/符号链接，含权限校验）
- `watch.go` — fsnotify 单路径目录监听
- `watch_sync.go` — 多 watcher 管理器（create/get/remove 三 RPC）
- `utils.go` — NFS/FUSE 挂载点检测、EntryInfo 构造
- `service.go` — Connect-RPC Handler 注册入口

### Cgroups 服务（`internal/services/cgroups/`）

- **`iface.go`**：抽象接口 `Freeze/Unfreeze/Close/GetFileDescriptor`
- **`cgroup2.go`**：Linux 实现——创建 cgroup、设置 freezer/procs
- **`cgroup2_stub.go`**：非 Linux 平台的 stub（no-op）
- **`noop.go`**：禁用 cgroup 时的回退实现

### Legacy 兼容层（`internal/services/legacy/`）

用于支持**旧版 connect-python Python SDK**：

- `legacyfilesystem.pb.go` / `legacyprocess.pb.go` — 旧版 protobuf
- `conversion.go` — 字段映射器
- `interceptor.go` — Connect-RPC 拦截器
- `stream.go` — 流式连接适配器 `streamConverter`
- `interceptor_test.go` — 通过 user-agent 嗅探（`connect-python`）决定是否转换

`spec/buf.gen.yaml` 与 `spec/buf.gen.shared.yaml` 配置双目标：
- `internal/services/spec` — envd 内部使用
- `packages/shared/pkg/grpc/envd` — 供其他服务（如 orchestrator）跨包引用

## 🌐 主机层服务（`internal/host/`）

### MMDS 客户端（MicroVM Metadata Service）

- **`mmds.go`**：实现 MMDS 客户端（基于 Firecracker 的 metadata 服务），提供 access token 哈希查询与轮询监听
- **`mmds_route_linux.go`**：通过 iptables 将 MMDS 流量固定到 169.254.169.254
- **`mmds_route_other.go`**：非 Linux 平台占位

### CA 证书安装器（`cacerts.go`）

异步监听 MMDS 配置变化，维护：
- 系统 CA bundle
- 本地应用证书目录
- 重启感知
- 并发安全

### 指标采集（`metrics.go`）

提供：
- `Metrics` 结构：CPU/内存/磁盘使用量与限制
- `diskSpace`：从 `statfs` 系统调用读取
- cgroup 文件读取函数

## 📝 日志系统（`internal/logs/`）

- **`logger.go`**：构造全局 zap logger，根据环境配置 dev/prod 模式，集成 OTEL exporter
- **`interceptor.go`**：gRPC 客户端/服务端日志拦截器（unary + stream），自动注入 operation ID 与 request ID
- **`exporter/exporter.go`**：HTTP 批量推送日志到 orchestrator，监听 MMDS 配置变化
- **`exporter/rate_limited_logger.go`**：限流日志记录器，避免高频错误日志爆炸
- **`ratelimit/ratelimit.go`**：token-bucket 速率限制器

## 🔐 权限与路径（`internal/permissions/`）

- **`authenticate.go`**：判断用户身份（root vs user）
- **`user.go`**：UID 字符串 ↔ uint32/int
- **`path.go`**：展开 `~`、解析相对路径、枚举子路径、确保父目录
- **`keepalive.go`**：长连接保活 ticker

## 🔌 端口子系统（`internal/port/`）

- **`scan.go`**：周期性扫描 sandbox 内部已监听端口，订阅者机制广播
- **`scanSubscriber.go`**：将扫描结果投递到目标 channel
- **`scanfilter.go`**：决定哪些端口需要被转发
- **`forward.go`**：端口转发器（sandbox 内 → 宿主机，配合 hyperloop）
- **`forward_cgroupfd_linux.go` / `forward_cgroupfd_other.go`**：build-tag 桩实现

## 🧰 工具与运行时上下文（`internal/utils/` + `internal/execcontext/`）

- **`envvars.go`**：线程安全的环境变量 Map，区分 system（内部不可覆盖）与 user 条目
- **`atomic.go`**：`AtomicMax`（仅在新值更大时更新）
- **`map.go`**：泛型 `Map[K, V]`（基于 sync.Map）
- **`multipart.go`**：`CustomPart` 包装 multipart.Part，保留子目录路径
- **`rfsnotify.go`**：fsnotify 路径辅助（递归选项追加 `...`）
- **`execcontext/context.go`**：`Defaults`（默认工作目录/用户名）

## 🚀 主入口 `main.go`（300 行）

`run()` 函数流程：

1. 解析 CLI flags
2. 构造 zap logger
3. 创建 cgroup v2 管理器（`createCgroupManager`）
4. 启动 HTTP/h2c 服务器
5. 挂载 filesystem + process gRPC 路由
6. 初始化端口转发器 + MMDS 配置轮询
7. 构建进程池（PTY/socat/user）
8. `withCORS` 中间件

## 🔁 关键调用流

### 沙箱启动时

```
orchestrator ──POST /init──> envd API
                                │
                                ▼
                       init.go: PostInit
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
        envd.initSandbox   CA bundle     NFS volume
   (token validate, sync     install        mount
    time, MMDS hash, ...)
                                ▼
                       envd 处于就绪态,client-proxy 可连
```

### 用户执行命令时

```
client ──gRPC Start──> envd process.Start
                              │
                              ▼
                    process.Handler 构造
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
        exec.Cmd (uid)  PTY/stdio  cgroup FD 注入
                              │
                              ▼
                  ServerStream ──DataEvent──> client
                              │
                  (stdout/stderr 实时多路复用)
                              │
                              ▼
                        Wait → EndEvent
```

### 暂停 / 恢复时

```
orchestrator pauseSandbox
        │
        ▼
envd POST /freeze  ──> cgroups.cgroup2.Freeze
        │
        ▼
Firecracker CreateSnapshot → GCS
        │
        ▼
cgroup FD 释放
        │
        ▼
VM 销毁（但 envd 进程已死）

--- 恢复时 ---

orchestrator ResumeSandbox
        │
        ▼
新 VM 启动 + 新 envd 进程
        │
        ▼
envd POST /unfreeze (异常回滚路径)
正常恢复由 /init 的延迟 unfreeze 完成
```

## 🎯 关键设计模式

1. **双协议兼容**：同时支持新版 Connect-RPC（spec/）和旧版 Python SDK（legacy/），通过 user-agent 嗅探自动切换
2. **Build-tag 平台分支**：`cgroupfd_linux.go` / `cgroupfd_other.go` 等配合 `cgroup2.go` / `cgroup2_stub.go` 实现跨平台
3. **memguard 敏感数据保护**：`SecureToken` 用加密内存 buffer 而非普通字符串
4. **泛型并发原语**：`MultiplexedChannel[T]` 实现安全的 fan-out，`Map[K, V]` 包装 sync.Map
5. **流式响应**：所有进程/文件系统 RPC 使用 Connect-RPC 的 ServerStream/ClientStream/BidiStream
6. **幂等回调清理**：`cleanup.Run()` 用 sync.Once 保证只执行一次
7. **cgroup 资源隔离**：通过 `SysProcAttr.CgroupFD` 把新进程直接归入指定 cgroup（Linux only）

## 📦 依赖与外部集成

envd 通过以下方式与外部通信：

- **gRPC**：`packages/shared/pkg/grpc/envd` 共享给 orchestrator（SandboxService 调用）
- **MMDS**：从 Firecracker 读取 metadata
- **HTTP API**：与 client-proxy 直连
- **日志 HTTP 推送**：envd → orchestrator（通过 MMDS 配置获取 endpoint）

## 🔍 关键文件速查

| 文件 | 行数 | 角色 |
|---|---|---|
| `main.go` | 300 | 守护进程入口 |
| `internal/api/api.gen.go` | 756 | oapi-codegen 生成的 chi 路由 |
| `internal/api/init.go` | 571 | 沙箱初始化（init/freeze/unfreeze） |
| `internal/api/secure_token.go` | 212 | memguard 加密 token |
| `internal/services/process/handler/handler.go` | 487 | 单进程执行核心 |
| `internal/services/filesystem/watch.go` | 151 | fsnotify 包装 |
| `internal/services/filesystem/watch_sync.go` | 205 | 多 watcher 管理 |
| `internal/services/cgroups/cgroup2.go` | 180 | Linux cgroup v2 管理器 |
| `internal/host/mmds.go` | 195 | MMDS 客户端 |
| `internal/host/cacerts.go` | 209 | CA 证书安装器 |
| `internal/logs/exporter/exporter.go` | 191 | HTTP 日志导出 |
| `internal/port/forward.go` | 224 | 端口转发器 |
| `spec/envd.yaml` | 432 | OpenAPI 3.0 契约 |
| `spec/filesystem/filesystem.proto` | 135 | 新版 Filesystem 协议 |
| `spec/process/process.proto` | 171 | 新版 Process 协议 |
| `internal/services/legacy/conversion.go` | 208 | 旧协议字段映射 |

## 🚢 部署与调试

- **`Dockerfile`**：标准多阶段 Go 构建
- **`debug.Dockerfile`**：集成 Delve，暴露 40000 端口用于远程 attach 调试
- **Makefile**：包含 `init / upload / build / build-debug / start-docker / build-and-upload / generate / test / lint` 9 个步骤
- **`go.mod`**：`go 1.26.3`，依赖 `connectrpc/connect`、`modelcontextprotocol/go-sdk`、`creack/pty` 等
- **`buf.gen.shared.yaml`**：把 envd proto 生成到 `packages/shared/pkg/grpc/envd` 供其他服务消费
- **`buf.gen.yaml`**：把 envd proto 生成到 `internal/services/spec` 供自身使用

## 📋 总结

envd 是一个**多协议、多平台、多职责**的 VM 内部守护进程，核心价值是：

- 在每个 sandbox 内**作为唯一可信代理**，对 orchestrator 和 client-proxy 暴露细粒度操作
- 通过 **cgroup v2 + MMDS + memguard** 三大基础设施提供资源隔离、动态配置、安全内存
- **新/旧协议双栈** 兼容 Python SDK 与现代 Connect-RPC 客户端
- **流式响应** 与 **fan-out 多路复用** 让客户端实时观察 sandbox 内进程状态

理解 envd 是掌握 E2B sandbox 完整生命周期的关键——它既是 sandbox 启动的"引导程序"，也是 orchestrator 协调 pause/resume 的"被控端"，更是 client-proxy 与用户进程之间的"桥梁"。

---

> **生成信息**: 本文档由 `/understand-anything:understand-chat` 技能基于 `E2B Infrastructure` 知识图谱（commit `a7455d100`）自动生成，共引用 361 个 envd 节点、954 条边、106 个 vm-daemon 层节点。
