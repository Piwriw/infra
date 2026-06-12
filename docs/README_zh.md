# Client-Proxy 详解

> 本文档基于 E2B Infra 仓库 `packages/client-proxy/` 目录下的源码与 `.understand-anything/knowledge-graph.json` 知识图谱撰写，全面解析 client-proxy 的设计原理、运行流程、关键模块及与上下游组件的协作方式。

---

## 1. 定位与职责

E2B 是一个基于 Firecracker microVM 提供 AI 代码沙盒执行环境的云平台。沙盒 (sandbox) 运行在 orchestrator 节点上，但 SDK/客户端并不是直接与 orchestrator 通信，而是统一打到边缘的 **client-proxy**。

**client-proxy 是一个无状态的反向 HTTP 代理**，其核心职责：

1. **请求路由 (Routing)**：从 HTTP `Host` 头或 `E2b-Sandbox-Id` / `E2b-Sandbox-Port` 头中解析出 `sandboxId` 与 `port`，定位到该 sandbox 实际所在的 orchestrator 节点 IP。
2. **目录查询 (Catalog Lookup)**：在 Redis sandbox-catalog 中查找 `sandboxId → OrchestratorIP` 映射。
3. **自动唤醒 (Auto Resume)**：当 catalog 缺失（即 sandbox 处于 paused 状态）时，按 feature flag 通过 gRPC 调用 API 的 `SandboxService.ResumeSandbox` 唤醒 sandbox，再继续转发。
4. **流式透传**：将客户端的 HTTP/HTTPS 流量直接 reverse-proxy 到目标 orchestrator:5007（即 orchestrator-proxy 端口）。
5. **健康状态与优雅关停**：暴露 `/healthy` 端点，并实现 `Draining → Unhealthy` 两阶段 graceful shutdown。

在仓库的总架构中位置：

```
Client SDK ──► Client-Proxy (HTTP 反向代理 + Auto-Resume) ──► Orchestrator-Proxy (5007) ──► Envd (49983) inside microVM
                              │
                              ├── Redis sandbox-catalog (查 orchestrator IP)
                              └── gRPC SandboxService (唤醒 paused sandbox)
```

---

## 2. 目录结构

```
packages/client-proxy/
├── Dockerfile                       # 多阶段构建 (golang:alpine → alpine)
├── Makefile                         # build / run-local / test 等
├── go.mod / go.sum                  # 依赖 shared pkg（无外部业务依赖）
├── main.go                          # 入口：组装 telemetry/redis/catalog/proxy + 生命周期管理
└── internal/
    ├── cfg/
    │   ├── model.go                 # Config 结构体 + caarlos0/env 解析
    │   └── model_test.go
    ├── info.go                      # ServiceHealth 状态机 (Healthy/Draining/Unhealthy) + ServiceInfo
    ├── info_test.go
    └── proxy/
        ├── proxy.go                 # NewClientProxy：构造 reverseproxy 与连接池，注册 OTEL metrics
        ├── proxy_test.go
        ├── paused_resumer.go        # PausedSandboxResumer 接口 (Init, Resume)
        ├── paused_sandbox_resumer_grpc.go
        │                            # grpcPausedSandboxResumer：gRPC 实现
        ├── paused_sandbox_resumer_grpc_test.go
        ├── grpc_resume_auth.go      # gRPC 鉴权策略：no-op 或 OAuth2 client-credentials
        └── grpc_resume_auth_test.go
```

代码体量不大（约 1k 行业务代码），但通过组合 `packages/shared/pkg/proxy`、`packages/shared/pkg/sandbox-catalog`、`packages/shared/pkg/grpc/proxy`、`packages/shared/pkg/featureflags` 等共享库实现了完整的边缘代理能力。

---

## 3. 配置（Configuration）

`internal/cfg/model.go` 使用 `caarlos0/env/v11` 从环境变量加载：

| 环境变量 | 用途 | 默认值 |
|---|---|---|
| `HEALTH_PORT` | 健康检查服务端口 | `3003` |
| `PROXY_PORT` | 反向代理监听端口 | `3002` |
| `REDIS_URL` / `REDIS_CLUSTER_URL` / `REDIS_TLS_CA_BASE64` | Redis catalog 连接配置 | — |
| `REDIS_POOL_SIZE` | Redis 连接池大小 | `40` |
| `API_INTERNAL_GRPC_ADDRESS` | **集群内** gRPC API 地址（明文） | 空 |
| `API_EDGE_GRPC_ADDRESS` | **公网边缘** gRPC API 地址（启用 TLS） | 空 |
| `API_EDGE_GRPC_OAUTH_CLIENT_ID` / `…_SECRET` / `…_TOKEN_URL` | 边缘 gRPC OAuth2 client-credentials 凭证 | — |

**关键分支**（见 `main.go:134-145`）：

- 若 `API_INTERNAL_GRPC_ADDRESS` 已配置 → 走 **集群内网明文 gRPC**（`useTLS = false`）。
- 否则若 `API_EDGE_GRPC_ADDRESS` 已配置 → 走 **公网边缘 TLS + OAuth2 gRPC**。
- 两个都没配 → `pausedSandboxResumer = nil`，关闭 auto-resume（`main.go:157` 会打印警告）。

---

## 4. 启动与运行时装配

`main.go` 的 `run()` 启动顺序：

1. **`cfg.Parse()`** — 读取环境变量。
2. **Telemetry** — `telemetry.New(...)` 创建 OTEL meter/logs provider。
3. **Logger** — 用 `logger.NewLogger` + OTEL core 构造 zap logger，注入全局。
4. **Feature Flags** — `featureflags.NewClient()` 创建 LaunchDarkly 客户端（offline store + context）。
5. **Redis** — `factories.NewRedisClient(...)` 构造 UniversalClient（支持单点/集群/TLS）。
6. **Catalog** — `e2bcatalog.NewRedisSandboxCatalog(redisClient)`。
7. **ServiceInfo** — 初始状态为 `Healthy`。
8. **PausedSandboxResumer** — 根据配置构造 `grpcPausedSandboxResumer` 或 `nil`。
9. **ClientProxy** — `NewClientProxy(meter, serviceName, port, catalog, resumer, flags)`。
10. **HTTP 健康检查** — 简单 `http.HandlerFunc`，非 `Healthy` 即返回 503。
11. **三个 goroutine**（`sync.WaitGroup`）：
    - `trafficProxy.ListenAndServe(ctx)`
    - `healthServer.ListenAndServe()`
    - **信号处理 goroutine** — 监听 `SIGTERM/SIGINT`，触发 graceful shutdown。

---

## 5. 请求处理流程

### 5.1 入口与 Host 解析

每一次 HTTP 请求进入 `reverseproxy.Proxy` 后，会调用 `NewClientProxy` 中注册的 `getTargetFromRequest` 回调（`proxy.go:152-219`）：

1. **`reverseproxy.GetTargetFromRequest()`**（见 `shared/pkg/proxy/host.go`）按以下顺序解析 sandbox：
   - 若 `Host` 是 `localhost` / IP / `sandbox.*` 共享域名，优先看 header：
     - `E2b-Sandbox-Id` + `E2b-Sandbox-Port`
   - 否则按 `Host` 解析：`{port}-{sandboxId}.{sharedDomain}`。
   - 再用 `id.ValidateSandboxID` 校验 ID 格式。
2. **从请求中读出 access token 头**（`proxy.go:161-162`）：
   - `e2b-traffic-access-token`（traffic 鉴权）
   - `X-Access-Token`（envd HTTP 鉴权头，原样转发）
3. **catalog 解析** — `catalogResolution(ctx, ...)`（见下文）。
4. 构造目标 URL：`http://{orchestratorIP}:5007`（`orchestratorProxyPort = 5007`），写到 `pool.Destination`。
5. **`clientProxyMaskRequestHost`** — 按 feature flag 决定是否把 `Host` 改写为 `{port}-{sandboxId}.{sharedDomain}`（`proxy.go:65-74`）：
   - `OrchAcceptsCombinedHostFlag = false`（默认）→ 当原 host 是 `sandbox.*` 共享域时，返回一个新的 `orchestratorHost`，让下游 orchestrator-proxy 看到组合域名。
   - 该 flag 开启时 → 返回 `nil`，表示保留原 host。

`reverseproxy.Proxy` 的 `handler` 还会根据 `getDestination` 返回的错误类型返回对应的 HTTP 状态 + 错误页模板（`shared/pkg/proxy/handler.go`）：

| 错误类型 | 行为 |
|---|---|
| `MissingHeaderError` | 400 |
| `ErrInvalidHost` | 400 |
| `ErrInvalidSandboxID` | 400 |
| `InvalidSandboxPortError` | 400 |
| `SandboxNotFoundError` | 渲染「sandbox not found」模板 |
| `SandboxResumePermissionDeniedError` | 渲染「resume denied」模板 |
| `SandboxStillTransitioningError` | 渲染「still transitioning」模板 |
| `SandboxResourceExhaustedError` | 渲染「team limit reached」模板 |
| `MissingTrafficAccessTokenError` | 渲染「missing access token」模板 |
| `InvalidTrafficAccessTokenError` | 渲染「invalid access token」模板 |
| 其他 | 500 + 错误信息 |

### 5.2 Catalog 解析（catalogResolution）

`proxy.go:76-95` 的逻辑：

```
1. c.GetSandbox(ctx, sandboxId)
   ├─ 成功 → 返回 OrchestratorIP
   └─ ErrSandboxNotFound
        └─ handlePausedSandbox(...)         // 见 §6
              ├─ autoResumeSucceeded        → 返回新 IP
              └─ 其他结果                    → ErrNodeNotFound
   └─ 其他错误                                → 包装返回
```

`RedisSandboxCatalog.GetSandbox`（`shared/pkg/sandbox-catalog/catalog_redis.go`）：

- key 格式：`sandbox:catalog:{sandboxId}`
- 1 秒超时（`catalogRedisTimeout`）
- 用 JSON 序列化 `SandboxInfo { OrchestratorID, OrchestratorIP, ExecutionID, StartedAt, MaxLengthInHours }`
- 命中失败时区分 `redis.Nil`（包装为 `ErrSandboxNotFound`）与真实错误。

返回的 IP 经 `normalizeNodeIP` 处理：去掉空白，空字符串触发 `ErrNodeRouteUnavailable`，从而产生 503 错误页。

### 5.3 Reverse Proxy 行为

`shared/pkg/proxy/proxy.go` 提供的 `Proxy` 是一个内嵌 `http.Server` 的结构：

- **连接池**：`pool.ProxyPool`，最大客户端连接数 `maxClientConns = 16384`，超过 `idleTimeout` 的连接会被驱逐。
- **重试次数**：`ClientProxyRetries = 1`（`proxy.go:42-44`）。比 sandbox-proxy（`SandboxProxyRetries = 5`）少，因为客户端侧的端口转发延迟由 orchestrator-proxy 处理。
- **Idle Timeout**：`idleTimeout = 610 * time.Second`（`proxy.go:28-35`），大于 GCP LB 的 600s 上游空闲超时，避免竞争关闭。
- **下游 IdleTimeout**：`idleTimeout + 10s`，比上游长，防止服务端关闭后客户端复用报错。
- **H2C**：`httpserver.ConfigureH2C` 启用 cleartext HTTP/2。
- **可观测连接计数**：`tracking.NewListener` 维护 `currentServerConnsCounter`，由 OTEL observable counter 暴露。

---

## 6. Paused Sandbox Auto-Resume

这是 client-proxy 的「黑魔法」：当 Redis 中找不到 sandbox（说明它在 paused 状态）时，可以透明地让后端 API 唤醒它，再返回新的 orchestrator IP，整个流程对客户端透明。

### 6.1 接口契约

`paused_resumer.go`：

```go
type PausedSandboxResumer interface {
    Init(ctx context.Context)
    Resume(ctx context.Context, sandboxId string, sandboxPort uint64,
           trafficAccessToken string, envdAccessToken string) (string, error)
}
```

### 6.2 gRPC 实现（`paused_sandbox_resumer_grpc.go`）

- 客户端通过 `grpc.NewClient(address, transportCreds, otelgrpc.NewClientHandler())` 创建。
- `useTLS = true` 时使用 TLS 1.2+，否则 insecure（仅集群内网）。
- `proxygrpc.NewSandboxServiceClient(conn)` 拿到 `SandboxServiceClient`。
- `Init` 仅调用 `e2bgrpc.ObserveConnection(ctx, conn, "api-resumer")` 启动 gRPC Channelz 采样。
- `Resume` 流程：
  1. 用 `metadata.AppendToOutgoingContext` 注入：
     - `e2b-sandbox-request-port = {sandboxPort}`
     - `e2b-traffic-access-token = {trafficAccessToken}`（非空时）
     - `e2b-envd-access-token = {envdAccessToken}`（非空时）
  2. 调 `c.auth.authorize(ctx)` 注入 OAuth2 bearer（如启用）。
  3. 调 `client.ResumeSandbox(ctx, &SandboxResumeRequest{SandboxId: …})`。
  4. 返回 `resp.GetOrchestratorIp()`。

`SandboxService` 的 proto 定义在 `shared/pkg/grpc/proxy/proxy.proto`：

```proto
service SandboxService {
  rpc ResumeSandbox(SandboxResumeRequest) returns (SandboxResumeResponse);
}

message SandboxResumeRequest { string sandbox_id = 1; }
message SandboxResumeResponse { string orchestrator_ip = 1; }
```

### 6.3 鉴权（`grpc_resume_auth.go`）

`grpcResumeAuth` 是一个简单的两态策略：

- **`noopGrpcResumeAuth`**：未配置 OAuth 时使用，`authorize` 透传 ctx。
- **`oauthGrpcResumeAuth`**：使用 `golang.org/x/oauth2/clientcredentials.Config`，scope 固定为 `sandboxes:lifecycle`（`ScopeSandboxLifecycle`），通过 `TokenSource` 懒加载 token 并以 `authorization: Bearer …` 注入 metadata。

`GRPCOAuthConfig.Enabled()` 检测三个字段是否至少有一个非空；`newGrpcResumeAuth` 进一步要求若启用则必须三个都齐全。

### 6.4 Resume 结果映射（`handlePausedSandbox`）

`proxy.go:97-143` 详细处理：

| gRPC 状态码 | 行为 |
|---|---|
| `PermissionDenied` | 返回 `SandboxResumePermissionDeniedError`（前端模板） |
| `NotFound` | 返回 `autoResumeNotAllowed`，调用方继续返回 404 |
| `FailedPrecondition` + 消息 = `"sandbox is still transitioning"` | 返回 `SandboxStillTransitioningError`（重试中） |
| `ResourceExhausted` | 返回 `SandboxResourceExhaustedError`（团队额度耗尽） |
| 其他错误 | 返回 `autoResumeErrored` + 原错误 |
| 成功 | 规范化 IP 后返回 `autoResumeSucceeded` |

### 6.5 启停控制

`catalogResolution` → `handlePausedSandbox` 的两个早期返回：

- **`pausedChecker == nil`** → `autoResumeNotAllowed`（未配置 `API_*_GRPC_ADDRESS`）。
- **`featureFlags.SandboxAutoResumeFlag = false`** → 同一结果。
  - Flag 默认值在 `featureflags/flags.go`：`env.IsDevelopment()` —— 本地开发默认开，生产环境默认关，由 LaunchDarkly 动态下发。
  - 同时支持 sandbox 级 context（`featureflags.SandboxContext(sandboxId)`）做单沙盒灰度。

---

## 7. Host 掩码 / 组合 Host

`clientProxyMaskRequestHost`（`proxy.go:65-74`）的核心：

```go
domain, sharedHost := reverseproxy.SandboxSharedHostDomain(host)
if !sharedHost || featureFlags.BoolFlag(ctx, OrchAcceptsCombinedHostFlag) {
    return nil   // 不改写
}
orchestratorHost := fmt.Sprintf("%d-%s.%s", port, sandboxID, domain)
return &orchestratorHost
```

- `sandbox.*` 共享域（`sandboxSharedHostSubdomain = "sandbox."`）的请求 → 把 `Host` 改写成 `{port}-{sandboxID}.{domain}`，以便下游 orchestrator-proxy 能从 `Host` 拿到路由信息。
- 新版 orchestrator-proxy 能直接读 `Destination` 头而不再依赖组合 host，所以 `OrchAcceptsCombinedHostFlag` 打开后就跳过改写。

这与 `shared/pkg/proxy/host.go` 中的解析逻辑互为正反：解析从组合 host 拆出 port+sandboxId；改写则把二者重新拼回 host。

---

## 8. 可观测性（OpenTelemetry）

`NewClientProxy` 末尾注册 3 个 ObservableUpDownCounter：

| Counter 名 | 含义 |
|---|---|
| `ClientProxyPoolConnectionsMeterCounterName` | 当前活跃的总池连接数（`proxy.CurrentPoolConnections()`） |
| `ClientProxyPoolSizeMeterCounterName` | 当前池大小（`proxy.CurrentPoolSize()`） |
| `ClientProxyServerConnectionsMeterCounterName` | 当前服务端侧连接数（`proxy.CurrentServerConnections()`） |

`reverseproxy.Proxy` 的 `tracking.NewListener` 在 Accept/Close 时增减 `currentServerConnsCounter`；`pool` 内部维护另外两个计数。

gRPC resumer 还启用了 `otelgrpc.NewClientHandler()`，让 gRPC 元数据（耗时、状态码、消息大小）自动上报到 OTEL。

每次请求都会构造一个带 `ProxyRequestFields` 的 `*zap.Logger`，把 `sandbox_id` / `port` / `target_hostname` / `target_port` 注入后续所有日志。

---

## 9. 健康状态与优雅关停

`internal/info.go` 定义的 `ServiceInfo`：

- 状态机：`Healthy → Draining → Unhealthy`。
- `sync.RWMutex` 保护读写，状态变更时打日志。
- `GetStatus()` 在健康检查 handler 中决定返回 200 还是 503。

`main.go:243-302` 的 **Draining → Unhealthy 两阶段** 关停：

```
SIGTERM/SIGINT
  ├─ SetStatus(Draining)         // 健康检查开始返回 503
  ├─ Sleep shutdownDrainingWait (15s)   // 让上游 LB / Consul 感知，不再发新流量
  ├─ trafficProxy.Shutdown(24h ctx)     // 等活跃请求完成
  ├─ SetStatus(Unhealthy)        // 显式标记 unhealthy
  ├─ Sleep shutdownUnhealthyWait (15s)  // 让健康检查管理方确认
  ├─ healthServer.Shutdown(5s)
  └─ 关闭 closers:
      - featureFlagsClient
      - catalog (Redis)
      - pausedSandboxResumer (gRPC conn)
```

两段等待（各 15s）的目的是让客户端的负载均衡器或服务发现（Consul）有充足时间把本节点移出健康池，避免新连接打到正在关停的节点。

---

## 10. 测试矩阵

仓库内对 client-proxy 的测试覆盖非常充分（知识图谱记录了 6 个 `tested_by` 边）：

| 测试文件 | 覆盖范围 |
|---|---|
| `internal/cfg/model_test.go` | `Parse` 的默认值、环境变量覆盖、非法整数报错 |
| `internal/info_test.go` | `ServiceInfo` 的零值、读写、幂等性、50 goroutine 并发 |
| `internal/proxy/grpc_resume_auth_test.go` | `noop`/`oauth` 两种 auth、`httptest` 验证 scope 请求参数 |
| `internal/proxy/paused_sandbox_resumer_grpc_test.go` | 10 个测试，使用 `bufconn` 搭建 in-process gRPC：空地址/OAuth 错误/明文与 TLS 构造、Resume metadata 透传、空 token 省略、服务器错误、鉴权错误短路、Init/Close |
| `internal/proxy/proxy_test.go` | catalog 命中/未命中/空 IP、Host 掩码、`handlePausedSandbox` 各分支（权限拒绝/找不到/资源耗尽/transitioning）、`NewClientProxy` 构造、handler 错误、metric 重复注册、连接池访问器 |

测试中用 `bufconn` 实现 in-process gRPC，避免网络依赖。

---

## 11. 关键设计权衡

1. **无状态 + Redis** — client-proxy 不持久化 sandbox → orchestrator 映射，每次请求查 Redis。配合 Redis 高可用实现水平扩展。代价：Redis 故障 → 所有 catalog 失败（降级为 auto-resume）。

2. **Auto-Resume 透明化** — 客户端无需感知 paused 状态，对外保持稳定的 HTTP 语义。代价：唤醒延迟叠加到首包时延，靠 `SandboxStillTransitioning` 错误页提示用户重试。

3. **TLS 分层** — `API_INTERNAL_GRPC_ADDRESS`（明文）+ `API_EDGE_GRPC_ADDRESS`（TLS+OAuth）并存，让 client-proxy 部署在集群内/集群外都有合适的安全姿势。

4. **Feature Flag 双层控制** — `SandboxAutoResumeFlag` + sandbox-level context；`OrchAcceptsCombinedHostFlag` 用于平滑切换 host 头格式。两者都把发布风险收口到 LaunchDarkly。

5. **两阶段 shutdown** — `Draining → Unhealthy` 各 15s 是经验值，给 LB / 服务发现留足反应时间，避免雪崩。

6. **Idle Timeout = 610s** — 略大于 GCP LB 的 600s，避免上游主动关闭后 client 复用时 RST。文档注释里写明了原因。

7. **重试次数 = 1** — 客户端侧的端口转发延迟由 orchestrator-proxy 内部的 5 次重试吸收，client-proxy 不再重复放大。

8. **错误页模板 vs JSON 错误** — sandbox 找不到等用户语义错误用 `template/*.go` 渲染 HTML 友好页面，因为浏览器/SDK 都会访问；底层 5xx 用 `http.Error` 简单返回。

---

## 12. 与上下游的接口契约

### 上游（入站）
- **HTTP/HTTPS 客户端**（`@e2b/sdk`、`@e2b/desktop`、浏览器直接访问）
- 路径：任意（client-proxy 是透传代理）
- 路由信息编码在 `Host` 头（`{port}-{sandboxId}.{sharedDomain}`）或 `E2b-Sandbox-Id` + `E2b-Sandbox-Port` 头

### 下游（出站）
- **Orchestrator-Proxy :5007**（`orchestratorProxyPort`）— 透传 sandbox 内用户进程的 HTTP
- **Redis**（`sandbox:catalog:{sandboxId}`）— sandbox 元数据
- **API gRPC**（`ResumeSandbox`）— 唤醒 paused sandbox
- **Consul**（间接）— 服务注册由 Nomad job 负责

### 元数据头（`shared/pkg/grpc/proxy/metadata.go`）
| 常量 | 用途 |
|---|---|
| `MetadataTrafficAccessToken = "e2b-traffic-access-token"` | traffic 鉴权令牌 |
| `MetadataEnvdHTTPAccessToken = "X-Access-Token"` | envd HTTP 头（与外部一致） |
| `MetadataEnvdAccessToken = "e2b-envd-access-token"` | envd gRPC 鉴权令牌 |
| `MetadataSandboxRequestPort = "e2b-sandbox-request-port"` | 标识目标端口 |
| `MetadataAuthorization = "authorization"` | OAuth2 bearer |
| `ScopeSandboxLifecycle = "sandboxes:lifecycle"` | OAuth2 scope |

---

## 13. 总结

`client-proxy` 用约 1k 行业务代码 + 共享库实现了：

- **统一入口**：所有 sandbox HTTP 流量的唯一入口，屏蔽 orchestrator 调度细节。
- **目录解析**：Redis catalog 的零状态读取 + 缺失时的 auto-resume 闭环。
- **协议透传**：不做应用层解析，直接 reverse-proxy 字节流。
- **安全灵活**：内网明文 / 边缘 TLS+OAuth 双模式，Feature Flag 细粒度控制。
- **可观测**：OTEL 三个连接池 counter + gRPC stats handler + 结构化 zap 日志。
- **可运维**：两阶段 graceful shutdown + 健康检查 endpoint。

它是 E2B 边缘最简单却又最关键的组件之一 —— 没有它，客户端就要直面 orchestrator 的动态调度；有了它，E2B 才能把「sandbox 就是 {id}.e2b.dev」这一简洁心智模型保持下去。
