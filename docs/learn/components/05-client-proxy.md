# 05. Client Proxy

`client-proxy` 是 sandbox 公网流量的数据面入口：它从请求中解析 sandbox 与端口，借助 Redis catalog 找到承载节点，并把流量转给该节点的 orchestrator ingress proxy。

## 1. 系统位置

```text
SDK / Browser
      |
      | HTTP、Connect、WebSocket，Host 中携带 port + sandbox ID
      v
client-proxy :3002
      |
      | Redis sandbox catalog -> OrchestratorIP
      v
orchestrator ingress proxy :5007
      |
      v
microVM IP : requested port
```

- 它是边缘路由器，不创建 Firecracker VM，也不直接连接 VM。
- 它读取 `sandbox:catalog:<sandboxID>`，catalog value 给出 `OrchestratorIP`、execution ID 和过期信息。
- catalog 命中时，请求固定发往 `http://<OrchestratorIP>:5007`；原始 sandbox 端口继续编码在 Host 或路由头中。
- catalog miss 时，它可以调用 API 的 `proxy.SandboxService/ResumeSandbox` 触发 auto-resume。
- `client-proxy` 自身只透传 access token，不拥有授权策略。catalog 命中时由 orchestrator ingress 校验 private traffic token；catalog miss 时 API 会在恢复 private sandbox 前校验 traffic token，envd 请求则校验 envd token。

## 2. 启动/装配

入口是 `packages/client-proxy/main.go` 的 `run()`：

1. 从环境变量解析 `PROXY_PORT`、`HEALTH_PORT`、Redis 和 API gRPC 地址。
2. 初始化 telemetry、日志、feature flag client 和 Redis client。
3. 用 Redis client 构造 `RedisSandboxCatalog`。
4. 优先使用 `API_INTERNAL_GRPC_ADDRESS` 创建明文内网 resumer。
5. 内网地址为空时，改用 `API_EDGE_GRPC_ADDRESS`，启用 TLS，并按配置使用 client-credentials OAuth。
6. 调用 `NewClientProxy(...)` 构造共享反向代理。
7. 在 `:3002` 启动流量服务，在 `:3003` 启动独立健康检查服务。

关闭时服务先进入 draining，等待依赖方停止发新流量，再优雅关闭流量 listener；随后标记 unhealthy、关闭健康服务和 Redis/gRPC 连接。

## 3. 核心机制与关键对象

### 请求目标解析

`shared/pkg/proxy.GetTargetFromRequest()` 支持两种输入：

- 常规域名：左侧 label 是 `<port>-<sandboxID>`，例如 `3000-i123.example.test`。
- 本地、IP 或 `sandbox.<domain>` 共享主机：可以用 `E2b-Sandbox-Id` 与 `E2b-Sandbox-Port` 两个 header。

解析后还会调用 `id.ValidateSandboxID`；无效 host、端口和 sandbox ID 在代理前直接变成 400。

### Redis sandbox catalog

`RedisSandboxCatalog.GetSandbox` 给每次查询设置 1 秒超时。Redis `Nil` 被规范化为 `ErrSandboxNotFound`，只有这个错误会进入 auto-resume；Redis 故障不会被误判成“已暂停”。

### PausedSandboxResumer

`grpcPausedSandboxResumer` 把原请求上下文中的信息变成 gRPC metadata：

- `e2b-sandbox-request-port`
- `e2b-traffic-access-token`
- `e2b-envd-access-token`
- 边缘模式下的 `authorization: Bearer ...`

API 返回的是恢复后可路由的 orchestrator IP，而不是 VM IP。

### 共享反向代理与连接池

`shared/pkg/proxy.Proxy` 统一承载 client-proxy 和 orchestrator proxy。client-proxy 使用一个固定 connection key，允许复用到节点的 HTTP keep-alive 连接；真正按 sandbox lifecycle 隔离连接池的是下一跳 orchestrator。

## 4. 主请求或数据流

### catalog 命中

```text
request
  -> GetTargetFromRequest
  -> catalog.GetSandbox(sandboxID)
  -> OrchestratorIP
  -> Destination(http://OrchestratorIP:5007)
  -> reverse proxy
  -> orchestrator proxy 再解析同一 sandboxID/port
```

共享主机模式下，旧版 orchestrator 不能理解共享 Host 时，client-proxy 会临时改成 `<port>-<sandboxID>.<domain>`；原 Host 放入 `X-Forwarded-Host`。

### catalog miss 与 auto-resume

```text
catalog.GetSandbox -> ErrSandboxNotFound
          |
          v
PausedSandboxResumer.Resume
          |
          | gRPC + request port + access tokens
          v
API ResumeSandbox
          |
          | 调度并恢复 sandbox，返回 orchestrator IP
          v
当前请求直接转发到该 IP:5007
```

`PermissionDenied`、`FailedPrecondition`、`ResourceExhausted` 分别映射为专门的用户错误；`NotFound` 表示不允许或不存在，最终仍表现为 sandbox not found。

## 5. 设计不变量与故障边界

- Host/header 只决定逻辑目标；client-proxy 绝不把请求端口当作节点监听端口，节点入口恒为 5007。
- 只有明确的 catalog not found 才触发恢复，Redis 超时或反序列化失败不会创建第二个 sandbox。
- 未配置 API gRPC 地址时，catalog miss 直接失败，正常 catalog 路由不受影响。
- auto-resume 成功响应必须带非空 orchestrator IP；空值被视为不可路由。
- client-proxy 只转发 access token，不拥有 sandbox ingress 授权策略。
- 到 orchestrator 的连接只尝试一次；VM 内 localhost 端口转发的短暂延迟由下一跳的五次重试吸收。
- 下游 idle timeout 是 620 秒，上游连接池是 610 秒，避免客户端复用刚被上游回收的连接。
- health 状态仅用于流量摘除；它不证明 Redis、API gRPC 或任意 sandbox 当前可用。

## 6. 与其他组件边界

| 相邻组件 | client-proxy 负责 | 对方负责 |
| --- | --- | --- |
| 外部 LB / SDK | 接收已编码路由目标的 HTTP 流量 | TLS 终止、域名与请求构造 |
| Redis catalog | 查询 sandbox 到节点的映射 | Nomad/local 由 API callback 写删；remote 由 gRPC metadata catalog event 发布/删除 |
| API auto-resume | 发起一次恢复请求并解释 gRPC 状态 | 鉴权、状态机、调度、调用 orchestrator |
| orchestrator proxy | 选择节点并转发到 `:5007` | 校验 traffic token、查 live map、连接 VM |
| envd | 透传发往 49983 的请求和 envd token | 文件/进程 RPC 与 envd 自身鉴权 |

## 7. 源码阅读顺序

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | `packages/client-proxy/main.go` | 看依赖装配、两个 listener 与关闭流程 |
| 2 | `packages/client-proxy/internal/cfg/model.go` | 看端口、Redis、内外 API gRPC 配置 |
| 3 | `packages/client-proxy/internal/proxy/proxy.go` | 看 catalog 命中、miss 与目标节点构造 |
| 4 | `packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go` | 看 auto-resume metadata 和返回值 |
| 5 | `packages/client-proxy/internal/proxy/grpc_resume_auth.go` | 看 edge OAuth client-credentials |
| 6 | `packages/shared/pkg/proxy/host.go` | 看 Host/header 的精确解析规则 |
| 7 | `packages/shared/pkg/proxy/handler.go` | 看错误映射和连接限流入口 |
| 8 | `packages/shared/pkg/proxy/pool/client.go` | 看 Rewrite、Host masking、重试和连接跟踪 |
| 9 | `packages/shared/pkg/sandbox-catalog/catalog_redis.go` | 看 Redis key、超时和错误语义 |

## 8. 相关深挖

- [Client Proxy 模块详解](../../md/client-proxy-module.md)
- [Sandbox 流量路由详解](../../md/sandbox-traffic-routing.md)
- [Auto-Resume 模块详解](../../md/auto-resume-module.md)
- [Sandbox 生命周期详解](../../md/sandbox-lifecycle.md)
