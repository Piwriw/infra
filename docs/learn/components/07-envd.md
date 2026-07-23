# 07. Envd

`envd` 是运行在每个 microVM 内的 guest agent：它在一个 HTTP listener 上提供初始化、文件和进程接口，并把只监听 localhost 的用户端口暴露给 VM 网卡。

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

orchestrator ---------- POST /init, /freeze, /fsfreeze
```

- envd 与用户 workload 位于同一 guest OS，但用 cgroup 把 user、PTY、socat 与系统进程分开。
- 外部 SDK 通过常规 sandbox 流量链访问 49983；orchestrator 也可直接通过 VM host IP 调它。
- 它不决定 sandbox 放在哪台节点，也不负责 Firecracker 生命周期。
- 它把 VM 内部状态转换为稳定的 HTTP/Connect 契约，避免 SDK 直接依赖 guest shell 细节。

## 2. 启动/装配

`packages/envd/main.go` 的 `run()` 完成全部装配：

1. 创建 `/run/e2b`，写入 `.E2B_SANDBOX`，并设置系统环境变量 `E2B_SANDBOX`。
2. Firecracker 模式下启动 MMDS 配置轮询；本地 `--isnotfc` 模式跳过该步骤。
3. 创建共享的默认用户、工作目录与线程安全环境变量集合。
4. 在 chi router 上挂载 Filesystem 与 Process Connect handler。
5. 创建 cgroup v2 manager；显式禁用或初始化失败时使用 no-op manager。
6. 创建 OpenAPI `API`，把 generated routes 挂到同一个 router。
7. 最外层安装用户名解析、access-token middleware 与 CORS。
8. 在 `0.0.0.0:49983` 启动 HTTP server。
9. 每秒扫描 listening TCP socket，并为 localhost-only 端口维护 socat forwarder。

server 的 read/write timeout 为零，长流由 sandbox 关闭和 keepalive 机制终止；idle timeout 为 640 秒。

## 3. 核心机制与关键对象

### `/init` 是 guest readiness 协议

orchestrator 循环请求 `/init`，请求体包含 lifecycle ID、host 时间、环境变量、envd access token、默认用户/工作目录、CA bundle、hyperloop IP 与 NFS mounts。envd 返回 204 后，orchestrator 才把 sandbox 标记为 running。

`PostInit` 用 semaphore 串行化初始化，并用单调的 `lastSetTime` 跳过旧请求；即使请求时间戳过旧，授权成功后仍会执行 cgroup unfreeze，以完成 resume thaw。

### 两层 access-token 保护

- 常规 endpoint 由 `WithAuthorization` 对 `X-Access-Token` 做比较。
- `/init` 被通用 middleware 排除，但在 handler 内把请求 token 与现有 token 或 Firecracker MMDS 中的 token hash 比较。
- `GET/POST /files` 允许 header token 或签名 URL，因此也在通用排除表中。
- token 存在 `SecureToken` 的 memguard locked buffer 中，替换和销毁会清零旧内存。

### Process service

Connect service 提供 `Start`、`Connect`、`List`、`Update`、`StreamInput`、`SendInput`、`SendSignal` 和 `CloseStdin`。每个 `handler.Handler` 包装一个 `exec.Cmd`，支持 PTY、stdout/stderr fan-out、tag/PID 选择器与 cgroup FD 注入。

### Filesystem service

Connect service 提供 stat、mkdir、move、list、remove，以及流式和轮询两套 watch。HTTP `/files` 负责内容上传/下载，`/files/compose` 负责在 guest 内组合分片。

### Localhost 端口转发

Scanner 查找 `127.0.0.1`、`localhost`、`::1` 上的 LISTEN socket。每个新 `(pid, port)` 启动：

```text
socat TCP4-LISTEN:<port>,bind=169.254.0.21,fork
   -> TCP4/TCP6:localhost:<port>
```

这样 orchestrator proxy 仍可按原端口连接 VM 的 eth0 地址；端口消失后对应进程组会被终止。

## 4. 主请求或数据流

### sandbox 启动或恢复

```text
Firecracker boot/resume
  -> systemd 启动 envd
  -> orchestrator POST /init（连接失败则快速重试）
  -> envd 校验现有 token / MMDS hash
  -> 更新时间、env vars、token、默认执行上下文
  -> 安装 CA、配置 hyperloop、按 lifecycle 重挂 NFS
  -> defer unfreeze user + PTY cgroups
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
orchestrator -> POST /freeze       冻结 user/PTY cgroup（可选、best effort）
             -> POST /fsfreeze     filesystem-only 时冻结并 flush rootfs
             -> Firecracker pause/snapshot

失败回滚     -> /unfreeze 或 /fsthaw
正常恢复     -> /init 的 deferred unfreeze
```

旧 envd 不支持 `/fsfreeze` 时，orchestrator 会通过 Process service 运行强制 `sync`，不是由 envd 自动降级。

## 5. 设计不变量与故障边界

- `/init` 的 204 是 sandbox 可路由的 readiness barrier，不只是配置写入成功日志。
- 未授权的 `/init` 不能触发 unfreeze；授权检查必须先于 thaw defer。
- 新 lifecycle 的 NFS 初始化会先卸载旧 mount，再以 NFSv3、TCP、同步写和禁用缓存的参数重挂。
- user/PTY freeze 不包含 socat 与 envd 自身，控制面必须在 workload 冻结时仍可响应。
- filesystem freeze 是一致性要求；失败必须让 filesystem-only pause 失败，不能继续生成可能丢写的 rootfs。
- cgroup manager 初始化失败会降级为 no-op，envd 仍能服务，但 freeze、隔离与资源归类语义随之消失。
- localhost forwarder 最多有约一次扫描周期加 socat 启动延迟；orchestrator proxy 用连接重试吸收该窗口。
- Process stream 的生命周期属于 guest 进程；sandbox pause/delete 或 VM 退出会从更底层中断连接。
- envd 的 access token 与业务 ingress traffic token 是两套凭据，不能互相替代。

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

## 8. 相关深挖

- [Envd 模块详解](../../md/envd-module.md)
- [Envd API 模块详解](../../md/envd-api-module.md)
- [Envd Package 原理](../../envd-package.md)
- [Envd 另一版模块索引](../../envd-module.md)
- [Sandbox 流量路由详解](../../md/sandbox-traffic-routing.md)
- [Sandbox 生命周期详解](../../md/sandbox-lifecycle.md)
