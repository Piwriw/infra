# API 控制面

`packages/api` 是项目的核心控制面入口：它认证租户、校验请求、编排 Sandbox 与 Template 生命周期，但不在本进程中运行虚拟机或执行模板构建。

## 0. 2026.30 变动速览

这一版对 API 控制面动了四块，读下面的正文前先建立预期：

| 变动 | 一句话 | 详见 |
| --- | --- | --- |
| **Access Token 完全退役** | 用户级 `sk_e2b_` token 的 REST 路径已从 spec 删除，`POST /access-tokens` 与 `DELETE /access-tokens/:accessTokenID` 改为无条件返回 **410 Gone** | §2、§5 |
| **认证器从 4 个变 6 个** | 新增 `AdminJWTAuthenticator`（校验配置的 admin JWKS）与 `AdminTeamAuthenticator`；`accessTokenGenerator` 仍在 `APIStore` 里，但 REST 路径已无 | §2、§3 |
| **Project Secrets** | 新增 `/secrets` 与 `/secrets/{secretID}` 两个端点，全部响应带 `Cache-Control: no-store` | §2、§5 |
| **服务发现收敛** | `SERVICE_DISCOVERY_PROVIDER` 现在有 4 个合法值，新增 `nomad+kubernetes`；实现从 API 包内迁到 `packages/shared/pkg/servicediscovery/` | §2 |
| **Sandbox workload identity** | `SandboxConfig.iam.tokens` 可声明具名 workload token（`audience` + `tokenType`），API 不签发凭证、也不投递进沙箱 | §4 |
| **CORS 显式白名单** | 新增 `customMiddleware.CORS()`，响应头暴露面由 `exposedResponseHeaders` 显式控制 | §5 |

> ⚠️ **`APIStore.Healthy` 只反映"发现了至少一个 node"**，不反映 DB / Redis / ClickHouse 是否可用。所以控制面依赖全挂但节点还在时，`/health` 依然返回 200。不要把它当成完整健康检查。

## 1. 系统位置

API 同时暴露三类入口：

- HTTP REST：由 [`spec/openapi.yml`](../../../spec/openapi.yml) 定义，Gin 路由由 `oapi-codegen` 生成。
- Internal gRPC：供可信内部网络调用 `SandboxService`。
- Edge gRPC：供 client-proxy 触发自动恢复，额外校验 OIDC scope 与组织声明。

它位于 SDK、Dashboard 等调用方与执行面之间：

```text
SDK / internal service / client-proxy
                 |
                 v
       REST + internal/edge gRPC
            packages/api
       /        |         \
PostgreSQL    Redis      ClickHouse/Loki
       \        |         /
       orchestrator nodes + template builders
```

HTTP handler 只负责协议转换和业务校验。真正的运行时调度在 `internal/orchestrator`，模板构建协调在 `internal/template-manager`，远端集群抽象在 `internal/clusters`。

## 2. 启动/装配

入口是 [`packages/api/main.go`](../../../packages/api/main.go)，启动顺序决定了服务何时可接流量：

1. 初始化 telemetry、日志和运行时指标。
2. 解析环境配置，并确认 PostgreSQL migration 版本不低于构建期要求。
3. 创建 Redis 与 LaunchDarkly 客户端。
4. 构造 admin JWT verifier（`auth.NewJWKSVerifier`，`main.go:437`）；JWKS 拉取失败**不致命**，只打 warn（`main.go:443`），随后 `NewAdminJWTAuthenticator` 拿到的就是 nil verifier。
5. `handlers.NewAPIStore` 装配主 DB、Auth DB、ClickHouse、PostHog、Loki、secrets 连接和缓存。
6. 根据 `SERVICE_DISCOVERY_PROVIDER` 选择 orchestrator discovery（见下表）。
7. 创建 `clusters.Pool`、`Orchestrator`、`auth.Service` 和 `TemplateManager`。
8. 加载 OpenAPI，安装认证、schema 校验、限流和 blocked-team 中间件，再注册生成路由。
9. 分别启动 HTTP、internal gRPC、edge gRPC 和 pprof server。

`SERVICE_DISCOVERY_PROVIDER` 的 4 个合法取值（[`cfg/model.go:19-30`](../../../packages/api/internal/cfg/model.go)）：

| 值 | 解析结果 |
| --- | --- |
| `nomad`（默认） | `nomad.NewServices` + 可选 `NewMerged(nomad.NewNodePool(client, "default"))`（`NOMAD_ORCHESTRATOR_LEGACY_DISCOVERY_ENABLED`，默认 true） |
| `kubernetes` | `kube.NewPods`，nodes 与 template-builders 两个 label selector |
| `nomad+kubernetes` | **2026.30 新增**：两个面各自 `NewMerged(nomadPlane, kubePlane)`，Nomad 为 primary（冲突时 Nomad 条目胜出） |
| `local` | `NewLocal`（`LOCAL_ORCHESTRATOR_ADDRESS` 默认 `127.0.0.1:5008`），两个面指向同一地址 |

> ⚠️ 只有**显式设置** `SERVICE_DISCOVERY_PROVIDER` 时才用它；未设置时本地环境 → `local`，否则 → `nomad`。代码注释说明了原因——运维必须能显式声明 provider，猜测会掩盖配置错误。非法值走 `FailureConditionInvalidServiceDiscoveryProvider`。

`APIStore.Healthy` 初始为 false；只有发现至少一个 orchestrator node 后才变为 true。关闭时先让健康检查返回 503，再并行 drain HTTP 和两个 gRPC server，最后关闭底层客户端。

HTTP 中间件的安装顺序（[`main.go:101-213`](../../../packages/api/main.go)），顺序本身是语义的一部分：

```text
gin.Recovery()
  -> customMiddleware.NoStoreSecrets()      # 2026.30 新增，必须最先，否则可能已经写出响应
  -> otel tracing (ExcludeRoutes) / metrics (IncludeRoutes) / Logging / Recovery / RequestTimeout
  -> customMiddleware.CORS()                # 2026.30 新增
  -> /access-tokens 的 410 兜底 handler      # 2026.30 新增，必须早于 OpenAPI validator
  -> OpenAPI validator（内含 AuthenticationFunc，6 个 authenticator）
  -> customMiddleware.InitLaunchDarklyContext
  -> ratelimit.Middleware                   # 仅 connect / resume，受 feature flag 门控
  -> customMiddleware.EnforceBlockedTeam()
  -> 生成路由 handler
```

> ⚠️ **`/access-tokens` 的 410 兜底必须注册在 OpenAPI validator 之前。** validator 会拒绝 spec 里不存在的 path；如果顺序反了，老客户端拿到的是 404 而不是语义明确的 410。这也是这两个 handler 不放在 `api.RegisterHandlersWithOptions` 里的原因。
>
> ⚠️ 这个兜底 handler **不做任何认证**——它是故意的，因为路径已经没有任何有效用途，返回 410 不需要知道调用方是谁。

## 3. 核心机制与关键对象

| 对象 | 职责 | 关键状态 |
| --- | --- | --- |
| `handlers.APIStore` | 实现生成的 `api.ServerInterface`，集中持有所有依赖 | DB、缓存、orchestrator、template manager |
| `auth.Service` | API Key、OIDC Bearer、Admin API Key / Admin JWT 与 team 解析（**2026.30：Access Token 已移出**） | Gin 中的 `user_id`、`team` |
| `orchestrator.Orchestrator` | 节点发现、调度、创建、暂停、恢复和删除 Sandbox | node pool、placement、sandbox store |
| `sandbox.Store` | 包装 Redis 状态、并发预约与状态迁移 | running/transitioning Sandbox |
| `placement.BestOfK` | 按 CPU 兼容性、标签和负载选择节点 | 动态 LaunchDarkly 参数 |
| `template_manager.TemplateManager` | 选择 builder、发起 gRPC build、轮询并落库状态 | processing builds、build cache |
| `clusters.Pool` | 统一本地与远端 cluster 的 builder、日志、指标访问 | cluster/instance discovery |
| `secretsManagement`（**2026.30 新增**） | Project secret 的读写；API 侧只回传 metadata，任何响应都不含 secret 值 | secret metadata、`secretsConn` |
| routing publisher（**2026.30 重构**） | 把 sandbox 路由发布/撤销到 Redis routing catalog，替代原先 per-Release goroutine 的发布路径 | catalog 发布队列 |
| template/snapshot cache | 缓存 alias、metadata、build 和 snapshot 查询 | Redis cache key 与显式失效 |

> ⚠️ `APIStore` 里**仍然保留 `accessTokenGenerator` 字段**（2026.30），尽管 access token 的 REST 路径已经删干净。它现在是遗留字段，看到它不要以为签发还在。
>
> ⚠️ `secretsConn == nil` **不是错误状态**。secrets 后端未配置时该字段就是 nil，相关端点走的是"未启用"分支，不是"故障"分支。

存储职责不能互换：PostgreSQL 保存模板、构建、快照和卷等持久状态；Redis 是运行中 Sandbox、预约和路由目录的共享状态；ClickHouse 提供历史指标；Loki 或远端 edge HTTP 提供日志。

HTTP 中间件顺序同样是业务逻辑的一部分：OpenAPI 认证先把 team 写入 Gin context，随后 LaunchDarkly、按 team 限流和 blocked-team 检查才能得到正确主体。

## 4. 主请求或数据流

### 创建 Sandbox

```text
POST /sandboxes
  -> OpenAPI auth 得到 team + limits
  -> handler 解析 template 名称/tag
  -> TemplateCache 解析 alias，并取可见的 ready build
  -> 校验 timeout、网络、secure envd、volume mounts、iam.tokens
  -> Orchestrator.CreateSandbox
       -> Redis reservation 原子检查 team 并发上限
       -> 组装 SandboxCreateRequest（含 SandboxConfig.iam）
       -> BestOfK 过滤 CPU/label/status 并选择 node
       -> node.Sandbox.Create gRPC
       -> Redis sandbox storage 写入运行态
       -> Nomad/local: API callback 写 Redis routing catalog
       -> remote: gRPC metadata 携带 catalog create event
  -> 异步增加 template spawn count 和发送 analytics
  -> 201 Sandbox
```

同一个 Sandbox ID 的并发启动会共享 reservation 结果；超限在调用节点前返回 429。节点创建成功但 Redis 落库失败时，API 会异步杀掉刚创建的 Sandbox，避免执行面孤儿。

### Sandbox workload identity（2026.30 新增）

`SandboxConfig` 新增可选的 `iam` 字段（[`spec/openapi.yml:945-966`](../../../spec/openapi.yml)）：

```yaml
SandboxIam:
  tokens:                     # SandboxIamTokens：按调用方自取的名字索引
    <tokenName>:
      audience: <string>      # 原样存储，不做规范化
      tokenType: <string>     # 两个字段都是 required
```

- `tokens` **非空且校验通过**才启用 workload identity；空 map 等于不启用。
- identity 本身由 **orchestrator** 从沙箱已有的权威标识（team / sandbox / execution / template ID）推导——API **不签发任何凭证，也不往沙箱里投递任何东西**。
- 定义随 `SandboxConfig.iam` 传给 orchestrator，并持久化到两处：运行态（Redis running-sandbox）与暂停快照态（Postgres），因此能扛过 pause/resume 和 orchestrator 重同步。
- **fork 会开启一个新的 workload，不继承原沙箱的 iam 定义。**
- 基于文件的投递方式在**准入阶段就被拒绝**。

### Project Secrets（2026.30 新增）

新增两个端点：`GET /secrets`（分页，返回 `X-Next-Token`）与 `GET /secrets/{secretID}`（按 ID 或 name 查询，返回 metadata）。两者都支持 `ApiKeyAuth`、`AuthProviderBearerAuth`+`AuthProviderTeamAuth`、`AdminApiKeyAuth`+`AdminTeamAuth`、`AdminJWTAuth`+`AdminTeamAuth` 四种安全组合。

> ⚠️ **任何 secrets 响应都不携带 secret 值**，只有 metadata。并且所有响应都由 `NoStoreSecrets` 中间件强制 `Cache-Control: no-store`——这是"无论哪一层应答都不可缓存"的要求，所以该中间件被放在中间件链的最前面。

### 创建并启动 Template Build

```text
POST /v3/templates
  -> 校验 team、namespace、alias、tags
  -> PostgreSQL 注册 env + env_build + assignments
     原始 status=waiting，触发器归一化 status_group=pending
  -> 返回 templateID/buildID

POST /v2/templates/{templateID}/builds/{buildID}
  -> 验证 build 属于当前 team 且仍为 pending
  -> 选择目标 cluster 的 healthy template builder
  -> PostgreSQL 记录 builder 与 machine info
  -> TemplateService.TemplateCreate gRPC
  -> DB 原始 status 写 building，触发器归一化 status_group=in_progress
  -> 后台轮询 TemplateBuildStatus
  -> 完成后原始 status 写 uploaded/failed，status_group 归一化为 ready/failed
  -> 写入产物 metadata，并失效缓存
```

注册和启动是两个阶段；不要把“已经有 build ID”理解成“构建已经在 builder 上执行”。

### Pause 与 Resume

Pause 先通过 Redis 状态迁移取得唯一操作权，在 PostgreSQL 预写 `snapshotting` 的 snapshot/build 记录，再让所在 node 生成 snapshot；成功后更新 build 终态并完成运行态移除。Resume 则从 snapshot cache/DB 重建创建参数，优先回原 node，之后复用同一条 `CreateSandbox` 调度链。

## 5. 设计不变量与故障边界

- 所有公开 DTO 和安全组合以 OpenAPI 为准；修改 handler 而不修改 spec 不会产生新路由。
- team 是资源归属、配额、限流和 feature flag context 的共同边界。
- banned team 在认证查询时拒绝；blocked team 在认证之后按服务级 allowlist 拒绝变更操作。
- 运行中 Sandbox 的共享真相在 Redis，不在 PostgreSQL；暂停后的 durable 真相在 snapshot 表。
- 只有成功创建 node 资源且成功写入 Redis store 后，请求才算创建成功。
- Sandbox 并发配额通过 Redis reservation 覆盖“已运行 + 正在创建”，不能只数当前列表。
- Template build 新状态机以 `status_group` 统一判断：`waiting|pending -> pending`、`building|in_progress|snapshotting -> in_progress`、`uploaded|ready|success -> ready`，其他值归为 `failed`。少量兼容 Dashboard/snapshot 查询仍直接读取原始 `status`，不能假设所有读侧都已迁移。
- HTTP request timeout 为 70 秒，server write timeout 为 75 秒；长操作必须在预算内结束或显式转后台。
- edge gRPC 的 auto-resume 必须通过 client-proxy OIDC、scope、org 及私有流量 token 检查；internal gRPC 不执行这组 edge 身份检查。
- 服务发现为空时 HTTP listener 仍可能已启动，但 `/health` 保持 503，创建请求也没有可放置节点。
- **（2026.30）Access Token 只剩 410**：`POST /access-tokens` 与 `DELETE /access-tokens/:accessTokenID` 在 spec 中已不存在，任何调用都无条件得到 410 Gone，且该兜底不做认证。
- **（2026.30）secrets 响应永不可缓存**：`NoStoreSecrets` 是中间件链的第一个，先于任何可能写响应的中间件。
- **（2026.30）新增的响应头必须显式加进 CORS 白名单**：`customMiddleware.CORS()` 用 `exposedResponseHeaders` 白名单控制浏览器可见的响应头。新加一个自定义响应头而不更新这个列表，**curl 测不出来**，只有浏览器会看不到。
- **（2026.30）API 不签发 workload identity 凭证**：`iam.tokens` 只是定义，identity 由 orchestrator 从沙箱已有的权威 ID 推导；API 既不生成凭证也不投递进沙箱，基于文件的投递在准入阶段被拒。
- **（2026.30）fork 不继承 iam 定义**：fork 是一个新 workload。

## 6. 与其他组件边界

- 与 `packages/auth`：API 负责选择本服务支持的 authenticator（2026.30 为 6 个）；auth 包负责凭证验证、team 查询和 context 写入。**2026.30 起 `packages/auth` 整体 `internal/` 化**，不再对外暴露原先的公开包路径，只保留 `sharedauth.NewAuthService` 这类入口。
- 与 `packages/db`：API 只调用 sqlc client；schema、migration、事务原语和 DB 类型归 DB 包。
- 与 `packages/shared/pkg/servicediscovery`：**2026.30 新增的边界**。服务发现实现原先分散在 `packages/api/internal/clusters/discovery/` 与 `packages/api/internal/orchestrator/discovery/` 两套，这一版全部删除并收敛到这个共享包。API 只做 provider 选择与装配。
- 与 `packages/dashboard-api`：两者共享 auth 与 DB，但 Dashboard 面向账户、团队和历史展示；Sandbox 生命周期由本组件负责。
- 与 orchestrator：API 决定租户权限、配额和目标节点，orchestrator node 负责 VM、网络、snapshot 和 volume 的实际执行。
- 与 template manager：API 持有 build 状态机和 DB 记录，builder 负责产物构建并通过 gRPC 报告状态与 metadata。
- 与 client-proxy：Nomad/local 节点由 API callback 写删 Redis 路由；remote 节点通过 gRPC metadata 传 catalog event。catalog miss 时 client-proxy 可经 edge gRPC 请求 auto-resume。

> ⚠️ **`packages/shared/pkg/servicediscovery/provider/` 在 2026.30 没有任何调用方。** 整个 `servicediscovery` 目录是 2026.30 新建的（2026.29 完全不存在），`provider` 子包是这次收敛时一并搬过来的、留给后续服务接线的入口，当前 `git grep "servicediscovery/provider"` 返回空。看到它别以为 API 在用它——API 走的是 `handlers/store.go` 自己的 switch。
>
> ⚠️ 另有一处容易混：`packages/shared/pkg/clusters/discovery/nomad.go` 是 **`Allocation` 列举器**，不是 `Discoverer` 抽象，两者不要当成一回事。

## 7. 源码阅读顺序

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | [`packages/api/main.go`](../../../packages/api/main.go) | 入口、依赖装配、中间件和三个 server |
| 2 | [`packages/api/internal/handlers/store.go`](../../../packages/api/internal/handlers/store.go) | `APIStore` 的完整依赖图 |
| 3 | [`spec/openapi.yml`](../../../spec/openapi.yml) | 路由、DTO、安全组合和兼容接口 |
| 4 | [`packages/api/internal/handlers/sandbox_create.go`](../../../packages/api/internal/handlers/sandbox_create.go) | 一次创建请求的校验与参数转换 |
| 5 | [`packages/api/internal/handlers/sandbox.go`](../../../packages/api/internal/handlers/sandbox.go) | handler 到 orchestrator 的公共入口 |
| 6 | [`packages/api/internal/orchestrator/create_instance.go`](../../../packages/api/internal/orchestrator/create_instance.go) | reservation、placement、gRPC 与落 Redis |
| 7 | [`packages/api/internal/orchestrator/orchestrator.go`](../../../packages/api/internal/orchestrator/orchestrator.go) | Redis store、路由目录和后台同步 |
| 8 | [`packages/api/internal/orchestrator/placement/placement.go`](../../../packages/api/internal/orchestrator/placement/placement.go) | 多节点尝试与错误边界 |
| 9 | [`packages/api/internal/handlers/template_start_build_v2.go`](../../../packages/api/internal/handlers/template_start_build_v2.go) | build 启动链 |
| 10 | [`packages/api/internal/template-manager/create_template.go`](../../../packages/api/internal/template-manager/create_template.go) | builder gRPC 与状态同步 |
| 11 | [`packages/api/internal/handlers/proxy_grpc.go`](../../../packages/api/internal/handlers/proxy_grpc.go) | edge auto-resume 的鉴权与恢复 |
| 12 | [`packages/api/internal/middleware/cors.go`](../../../packages/api/internal/middleware/cors.go) | **2026.30 新增**：请求头与响应头白名单 |
| 13 | [`packages/shared/pkg/servicediscovery/servicediscovery.go`](../../../packages/shared/pkg/servicediscovery/servicediscovery.go) | **2026.30 新增**：`Instance` / `Discoverer` / `NoSync` 抽象 |

## 8. 相关深挖

- [API 服务全景](../api-module.md)
- [Sandbox REST API](../sandbox-api-module.md)
- [Sandbox 生命周期](../sandbox-lifecycle.md)
- [Orchestrator](../orchestrator-module.md)
- [Template 构建链](../template-build-flow.md)
- [Auto-Resume](../auto-resume-module.md)
- [流量路由](../sandbox-traffic-routing.md)
- [Volume](../volumes.md)
- [认证子系统](../auth-module.md)
- [Access Token 退役档案](../access-tokens-module.md)

---

*已同步至 **2026.30**。本文引用的所有 `file:line` 均以 tag `2026.30` 为准；与 2026.29 行号不同的地方已在正文中并列标注。*
