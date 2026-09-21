# 07. Envd

`envd` 是运行在每个 microVM 内的 guest agent：它在一个 HTTP listener 上提供初始化、文件和进程接口，并把只监听 localhost 的用户端口暴露给 VM 网卡。

## 2026.30 变动

> ⓘ 本节逐项对照 tag `2026.30` 核实，行号一律以 2026.30 为准。

### 版本号

| 项 | 2026.29 | 2026.30 |
| --- | --- | --- |
| [`packages/envd/pkg/version.go`](../../packages/envd/pkg/version.go) | `Version = "0.6.10"` | `Version = "0.8.0"`（带 `// x-release-please-version` 注解） |

0.6.10 → 0.8.0 之间还经历了 0.6.11 → 0.6.12 → 0.6.13 → 0.7.0 四轮 bump，每一轮都对应行为变更（`version.go` 的注释要求"任何行为变更都必须 bump"）。完整链条见 [envd-package.md §1.3](../envd-package.md)。

### 新增能力

| 能力 | 主要位置 | 说明 |
| --- | --- | --- |
| **在线热升级（handover 协议）** | `packages/envd/spec/upgrade/handover.proto`、`internal/services/process/upgrade.go` | orchestrator 调 `POST /upgrade`；envd 冻结 workload 后把 `HandoverState` 序列化到 tmpfs `/run/e2b/envd-handover.pb`，再以**同一个 PID** `execve` 到 `/usr/bin/envd.next`，新镜像带 `--resume-handover` 启动，重新接管进程、watcher、NFS mount ledger 与端口转发 |
| **层级化 cgroup freeze/thaw** | `internal/services/cgroups/freeze.go`、`internal/services/cgroups/hierarchy.go` | 从"按 `ProcessType` 写单点 `cgroup.freeze`"升级为按 cgroup 树遍历：冻结 allowlist 之外的全部子树，thaw 时反向遍历并区分"自己请求的冻结"与"guest 自己冻结的" |
| **freeze 审计与内存保护上报** | `internal/api/init.go`、`internal/services/cgroups/memory.go` | `/init` 新增 5 个响应头：`X-Envd-Version`、`X-Envd-Handover`、`X-Envd-Freeze-Audit`、`X-Envd-Defaults`、`X-Envd-Memory` |
| **进程退出保留缓存** | `internal/services/process/service.go` | 已退出进程的 `EndEvent` 保留 30 秒，让晚到的 `Connect` 也能补拿退出码 |
| **`x-internal` 控制面标记** | `packages/envd/spec/envd.yaml` | 6 条 orchestrator 控制面路径标 `x-internal: true`，orchestrator 侧据此生成 sandbox proxy 的拒绝列表 |

### 变更

| 项 | 2026.29 | 2026.30 |
| --- | --- | --- |
| `POST /freeze` | 无参数，恒返回 204 | 接受 `mode` / `maxCgroups` / `maxWaitMs` 查询参数；带 `maxWaitMs` 时返回 200 + `FreezeResult`，否则仍 204 |
| `cgroups.Manager` 接口 | `Freeze` / `Unfreeze` / `GetFileDescriptor` / `Close` | 新增 `Frozen(ProcessType) (bool, error)`；另拆出 `PathManager` 接口（`Root` / `PathOf` / `ChildrenOf` / `FreezeAt` / `UnfreezeAt` / `FrozenAt` / `FreezeRequestedAt`） |
| `ProcessType` 取值 | `"system"` / `"user"` / `"PTY"` / `"socat"` | `"system"` / `"user"` / `"pty"` / `"socat"`（PTY 改为小写） |
| `logs.NewLogger` | `(ctx, isFC, verbose, mmdsChan)` | `(verbose, writers ...io.Writer)`，exporter 的构造移到 `main.go` |
| `process.Handle` | `(server, l, defaults)` | `(server, l, defaults, workloadFreezer)` |
| `api.New` | `(l, defaults, mmdsChan, isNotFC, cgroupManager)` | `(l, defaults, mmdsChan, isNotFC, workloadFreezer, logFlushers ...LogFlusher)` |
| `internal/port/scanSubscriber.go` | 文件名 | 重命名为 `internal/port/scan_subscriber.go` |

### 未变

- 监听端口仍是 `0.0.0.0:49983`（`main.go:39` 的 `defaultPort`）。
- `spec/process/process.proto` 与 `spec/filesystem/filesystem.proto` **都没有改动**：没有新增 RPC，也没有新增字段。
- 新增的 `spec/upgrade/handover.proto` **只定义 message，不定义 service**，所以 2026.30 没有新增 Connect RPC service。

> ⚠️ "离线替换 envd"（`envd-offline-upgrade-target` flag + 在 jailed 环境用 `debugfs` 改写 `/usr/bin/envd`）是 **orchestrator 侧**行为，不在 envd 进程内实现，因此本文不展开；细节见 [snapshots.md §7.4](../snapshots.md)。

## 1. 系统位置

```text
SDK / Browser
      |
client-proxy -> orchestrator proxy
                         |
                         | VM IP:49983
                         v
                 +----------------+
                 |      envd      |
                 | HTTP + Connect |
                 +---+--------+---+
                     |        |
                 processes  filesystem

orchestrator ---------- POST /init, /freeze, /fsfreeze, /upgrade
```

- envd 与用户 workload 位于同一 guest OS，但用 cgroup 把 user、PTY、socat 与系统进程分开。
- 外部 SDK 通过常规 sandbox 流量链访问 49983；orchestrator 也可直接通过 VM host IP 调它。
- 它不决定 sandbox 放在哪台节点，也不负责 Firecracker 生命周期。
- 它把 VM 内部状态转换为稳定的 HTTP/Connect 契约，避免 SDK 直接依赖 guest shell 细节。
- `POST /init`、`/freeze`、`/unfreeze`、`/collapse`、`/fsfreeze`、`/fsthaw` 在 spec 里标了 `x-internal: true`，属于 orchestrator 控制面，经 sandbox 公网 URL 到达的请求会被 proxy 拒绝。

## 2. 启动/装配

`packages/envd/main.go` 的 `run()`（行 175）完成全部装配：

1. 创建 `/run/e2b`，写入 `.E2B_SANDBOX`，并设置系统环境变量 `E2B_SANDBOX`。
2. Firecracker 模式下启动 MMDS 配置轮询；本地 `--isnotfc` 模式跳过该步骤。
3. 创建共享的默认用户、工作目录与线程安全环境变量集合。
4. 在 chi router 上挂载 Filesystem 与 Process Connect handler。
5. 创建 cgroup v2 manager（`createCgroupManager`，行 460）；显式禁用或初始化失败时使用 no-op manager。
6. 构造 `WorkloadFreezer`（行 225）并安装 thaw watchdog（行 229）。
7. 创建 OpenAPI `API`，把 generated routes 挂到同一个 router。
8. 若本次是热升级后的新镜像（`--resume-handover`，行 68），从 `/run/e2b/envd-handover.pb` 恢复进程/watcher/mount/forward，并武装一个 60 秒的兜底 thaw（行 298）。
9. 注册 `POST /upgrade`（行 402），这是唯一不经 OpenAPI spec 的直挂路由。
10. 最外层安装用户名解析、access-token middleware 与 CORS。
11. 在 `0.0.0.0:49983` 启动 HTTP server。
12. 每秒扫描 listening TCP socket，并为 localhost-only 端口维护 socat forwarder。

server 的 read/write timeout 为零，长流由 sandbox 关闭和 keepalive 机制终止；idle timeout 为 640 秒（`main.go:36`）。

## 3. 核心机制与关键对象

### `/init` 是 guest readiness 协议

orchestrator 循环请求 `/init`，请求体包含 lifecycle ID、host 时间、环境变量、envd access token、默认用户/工作目录、CA bundle、hyperloop IP 与 NFS mounts。envd 返回 204 后，orchestrator 才把 sandbox 标记为 running。

`PostInit` 用 semaphore 串行化初始化，并用单调的 `lastSetTime` 跳过旧请求；即使请求时间戳过旧，授权成功后仍会执行 cgroup thaw，以完成 resume thaw。

2026.30 起 `PostInit` 还会回写 5 个响应头，把 envd 自己的运行时判断暴露给 orchestrator：`X-Envd-Version`（`pkg.Version`）、`X-Envd-Handover`（本次是不是热升级后的第一次 `/init`）、`X-Envd-Freeze-Audit`（cgroup 树上仍被冻结的路径采样）、`X-Envd-Defaults`（实际生效的默认用户/工作目录）、`X-Envd-Memory`（cgroup 内存保护配置）。

### 两层 access-token 保护

- 常规 endpoint 由 `WithAuthorization` 对 `X-Access-Token` 做比较。
- `/init` 被通用 middleware 排除，但在 handler 内把请求 token 与现有 token 或 Firecracker MMDS 中的 token hash 比较。
- `GET/POST /files` 允许 header token 或签名 URL，因此也在通用排除表中。
- token 存在 `SecureToken` 的 memguard locked buffer 中，替换和销毁会清零旧内存。
- 热升级后的新镜像在第一次 `/init` 之前**故意 fail closed**：只有 `GET /health` 与 `POST /init` 放行（`handoverPreInitAllowedPaths`），其余请求一律 401，避免新镜像在还没拿到 token 的窗口里被调用。

### Process service

Connect service 提供 `Start`、`Connect`、`List`、`Update`、`StreamInput`、`SendInput`、`SendSignal` 和 `CloseStdin`。每个 `handler.Handler` 包装一个 `exec.Cmd`，支持 PTY、stdout/stderr fan-out、tag/PID 选择器与 cgroup FD 注入。

> ⚠️ 2026.30 起进程退出后会**保留**一段时间的终态事件（`terminatedRetentionTTL = 30s`）：`Connect` 若在进程刚退出后才订阅，仍能补拿到 `EndEvent` 与退出码，而不是只看到"进程不存在"。进程启动失败也不再统一报 `InvalidArgument`，而是按 errno 映射（`EAGAIN`/`ENOMEM`/`EMFILE`/`ENFILE`/`ENOSPC` → `ResourceExhausted`，超时 → `DeadlineExceeded`）。

### 热升级（handover）

`POST /upgrade` 接收一个替换用二进制（只允许写到 `/usr/bin/envd.next`）。outgoing envd 先把用户 cgroup 冻结，再把 `HandoverState` 序列化到 `/run/e2b/envd-handover.pb`，然后用 `execve` 原地换成新镜像——**PID 不变**，所以子进程、socat、NFS mount 和 listener fd 全部存活。新镜像读回 blob，重新接管这些对象。

跨版本兼容靠 proto 里的 `schema` 字段：写方只写"能表达当前内容的最低 schema"，读方在 `schema > handoverSchema` 时直接拒绝（`execve` 之后没有回退路径，宁可失败也不误读）。当前上限是 3。

### Filesystem service

Connect service 提供 stat、mkdir、move、list、remove，以及流式和轮询两套 watch。HTTP `/files` 负责内容上传/下载，`/files/compose` 负责在 guest 内组合分片。

### Localhost 端口转发

Scanner 查找 `127.0.0.1`、`localhost`、`::1` 上的 LISTEN socket。每个新 `(pid, port)` 启动：

```text
socat TCP4-LISTEN:<port>,bind=169.254.0.21,fork
   -> TCP4/TCP6:localhost:<port>
```

这样 orchestrator proxy 仍可按原端口连接 VM 的 eth0 地址；端口消失后对应进程组会被终止。

> ⚠️ 2026.30 起 `PortToForward` 记录 `socatPid`，停止转发时按这个 pid 精确回收，而不是按进程组盲杀；热升级后新镜像也能凭 blob 里的 `socat_pid` **重新认领**已经在跑的 socat，而不是再 spawn 一个重复的。

## 4. 主请求或数据流

### sandbox 启动或恢复

```text
Firecracker boot/resume
  -> systemd 启动 envd（若上次是热升级，则带 --resume-handover）
  -> orchestrator POST /init（连接失败则快速重试）
  -> envd 校验现有 token / MMDS hash
  -> 更新时间、env vars、token、默认执行上下文
  -> 安装 CA、配置 hyperloop、按 lifecycle 重挂 NFS
  -> 回写 X-Envd-* 诊断头，置 initialized
  -> defer thaw（user + pty 子树）
  -> 204 No Content
  -> orchestrator MarkRunning
```

### 用户执行命令

```text
SDK -> 49983 /process.Process/Start
    -> AuthenticateUsername
    -> Process Service
    -> handler 创建 exec.Cmd + cgroup + optional PTY
    -> StartEvent
    -> DataEvent(stdout/stderr/pty)*
    -> EndEvent(exit code)
```

### 暂停协作

```text
orchestrator -> POST /freeze       冻结用户 cgroup 子树（可带 maxWaitMs 等待真正冻结完成）
             -> POST /fsfreeze     filesystem-only 时冻结并 flush rootfs
             -> Firecracker pause/snapshot

失败回滚     -> /unfreeze 或 /fsthaw
正常恢复     -> /init 的 deferred thaw
```

旧 envd 不支持 `/fsfreeze` 时，orchestrator 会通过 Process service 运行强制 `sync`，不是由 envd 自动降级。

> ⚠️ 2026.30 的 `/freeze` 不再只写 `user` / `ptys` 两个 `cgroup.freeze`，而是**按 cgroup 树遍历**：冻结 envd 自身祖先链之外的全部子树，并跳过一张 liveness allowlist（`init.scope`、`systemd-journald`、`rpcbind`、`rpc-statd`、`socats`），否则连"用来解冻的控制面"本身都会被冻住。写 `cgroup.freeze` 只是"请求冻结"，真正的冻结完成要看 `cgroup.events` 的 `frozen` 字段，所以 2026.30 加了 2ms 间隔的 settle 轮询。
>
> 反过来，thaw 时必须**保留 guest 自己冻结的 cgroup**（例如容器运行时写 `cgroup.freeze` 实现的 `docker pause`），所以冻结前会把 guest 的既有冻结状态记进 `guest_frozen_cgroups`，thaw 时跳过它们。
>
> 另外还有一层兜底：如果一次 freeze 之后迟迟没有对应的 thaw（比如 pause 中途失败），watchdog 会在 10 分钟后主动解冻，避免 sandbox 永久卡死。

## 5. 设计不变量与故障边界

- `/init` 的 204 是 sandbox 可路由的 readiness barrier，不只是配置写入成功日志。
- 未授权的 `/init` 不能触发 thaw；授权检查必须先于 thaw defer。
- 新 lifecycle 的 NFS 初始化会先卸载旧 mount，再以 NFSv3、TCP、同步写和禁用缓存的参数重挂。
- freeze 不包含 socat 与 envd 自身，控制面必须在 workload 冻结时仍可响应。
- filesystem freeze 是一致性要求；失败必须让 filesystem-only pause 失败，不能继续生成可能丢写的 rootfs。
- cgroup manager 初始化失败会降级为 no-op，envd 仍能服务，但 freeze、隔离与资源归类语义随之消失。
- localhost forwarder 最多有约一次扫描周期加 socat 启动延迟；orchestrator proxy 用连接重试吸收该窗口。
- Process stream 的生命周期属于 guest 进程；sandbox pause/delete 或 VM 退出会从更底层中断连接。
- envd 的 access token 与业务 ingress traffic token 是两套凭据，不能互相替代。
- 热升级的兼容契约是单向的：读方拒绝"比自己新"的 schema 并放弃升级，而不是猜测字段布局；`execve` 之后没有回退路径。
- handover blob 落在 tmpfs（`/run/e2b/envd-handover.pb`），不跨 VM 重启存活；它不是持久化格式，只是同一次进程镜像替换的交接单。
- thaw 的默认方向是"宁可多解冻"：`guest_frozen_cgroups` 记录丢失时，thaw 会清掉它看到的一切冻结状态，绝不让 guest 卡在冻结里。

## 6. 与其他组件边界

| 相邻组件 | envd 负责 | 对方负责 |
| --- | --- | --- |
| orchestrator | guest readiness、freeze、文件与进程控制 | VM、snapshot、网络槽、host 资源回收 |
| client-proxy | 在 49983 终止 envd API 请求 | 找节点并逐层转发 HTTP 流量 |
| SDK | 实现 Connect/HTTP 服务语义 | 构造用户、token、stream 与文件请求 |
| Firecracker MMDS | 读取 token hash 和运行配置 | 由 orchestrator 在启动/恢复时写入元数据 |
| NFS proxy | 在 guest 内挂载和维护 mount | 在 host 上提供隔离后的 NFSv3 服务 |
| 用户进程 | 启动、连接、输入、信号和 cgroup 归类 | 实际业务逻辑与监听端口 |

## 7. 源码阅读顺序

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | `packages/envd/main.go` | 看同一 listener 上的完整装配 |
| 2 | `packages/envd/spec/envd.yaml` | 看 HTTP 控制面与鉴权声明 |
| 3 | `packages/envd/internal/api/init.go` | 看 readiness、MMDS token、NFS 与 thaw |
| 4 | `packages/envd/internal/api/auth.go` | 看通用 token 与签名文件接口的边界 |
| 5 | `packages/envd/spec/process/process.proto` | 看进程协议与流方向 |
| 6 | `packages/envd/internal/services/process/service.go` | 看 Process handler 注册与索引 |
| 7 | `packages/envd/internal/services/process/handler/handler.go` | 看 exec、PTY、cgroup 与输出 fan-out |
| 8 | `packages/envd/spec/filesystem/filesystem.proto` | 看文件与 watcher 契约 |
| 9 | `packages/envd/internal/port/forward.go` | 看 localhost 到 eth0 的 socat 桥接 |
| 10 | `packages/envd/internal/services/cgroups/cgroup2.go` | 看 freeze 与进程分类的内核接口 |
| 11 | `packages/envd/internal/services/cgroups/freeze.go` | 看层级化 freeze/thaw、settle 轮询与 thaw watchdog |
| 12 | `packages/envd/internal/services/cgroups/hierarchy.go` | 看 allowlist、祖先链与 cgroup 树遍历 |
| 13 | `packages/envd/spec/upgrade/handover.proto` | 看热升级的兼容契约（schema + 全部被交接的对象） |
| 14 | `packages/envd/internal/services/process/upgrade.go` | 看 outgoing 侧的冻结、序列化与 `execve` |
| 15 | `packages/envd/internal/services/process/handler/readopt.go` | 看 incoming 侧如何重新认领子进程与 fd |

## 8. 相关深挖

- [Envd 模块详解](../envd-module.md)
- [Envd API 模块详解](../envd-api-module.md)
- [Envd Package 原理](../envd-package.md)
- [Sandbox 流量路由详解](../sandbox-traffic-routing.md)
- [Sandbox 生命周期详解](../sandbox-lifecycle.md)

---

**已同步至 2026.30**（对照 tag `2026.30` 核实；2026.29 的行号差异在正文中以"行 N（2026.30；2026.29 为 M）"标出）。
