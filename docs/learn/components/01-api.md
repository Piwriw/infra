# API 控制面

`packages/api` 是项目的核心控制面入口：它认证租户、校验请求、编排 Sandbox 与 Template 生命周期，但不在本进程中运行虚拟机或执行模板构建。

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
4. `handlers.NewAPIStore` 装配主 DB、Auth DB、ClickHouse、PostHog、Loki 和缓存。
5. 根据 `SERVICE_DISCOVERY_PROVIDER` 选择 Nomad、Kubernetes 或本地 orchestrator discovery。
6. 创建 `clusters.Pool`、`Orchestrator`、`auth.Service` 和 `TemplateManager`。
7. 加载 OpenAPI，安装认证、schema 校验、限流和 blocked-team 中间件，再注册生成路由。
8. 分别启动 HTTP、internal gRPC、edge gRPC 和 pprof server。

`APIStore.Healthy` 初始为 false；只有发现至少一个 orchestrator node 后才变为 true。关闭时先让健康检查返回 503，再并行 drain HTTP 和两个 gRPC server，最后关闭底层客户端。

## 3. 核心机制与关键对象

| 对象 | 职责 | 关键状态 |
| --- | --- | --- |
| `handlers.APIStore` | 实现生成的 `api.ServerInterface`，集中持有所有依赖 | DB、缓存、orchestrator、template manager |
| `auth.Service` | API Key、Access Token、OIDC 与 team 解析 | Gin 中的 `user_id`、`team` |
| `orchestrator.Orchestrator` | 节点发现、调度、创建、暂停、恢复和删除 Sandbox | node pool、placement、sandbox store |
| `sandbox.Store` | 包装 Redis 状态、并发预约与状态迁移 | running/transitioning Sandbox |
| `placement.BestOfK` | 按 CPU 兼容性、标签和负载选择节点 | 动态 LaunchDarkly 参数 |
| `template_manager.TemplateManager` | 选择 builder、发起 gRPC build、轮询并落库状态 | processing builds、build cache |
| `clusters.Pool` | 统一本地与远端 cluster 的 builder、日志、指标访问 | cluster/instance discovery |
| template/snapshot cache | 缓存 alias、metadata、build 和 snapshot 查询 | Redis cache key 与显式失效 |

存储职责不能互换：PostgreSQL 保存模板、构建、快照和卷等持久状态；Redis 是运行中 Sandbox、预约和路由目录的共享状态；ClickHouse 提供历史指标；Loki 或远端 edge HTTP 提供日志。

HTTP 中间件顺序同样是业务逻辑的一部分：OpenAPI 认证先把 team 写入 Gin context，随后 LaunchDarkly、按 team 限流和 blocked-team 检查才能得到正确主体。

## 4. 主请求或数据流

### 创建 Sandbox

```text
POST /sandboxes
  -> OpenAPI auth 得到 team + limits
  -> handler 解析 template 名称/tag
  -> TemplateCache 解析 alias，并取可见的 ready build
  -> 校验 timeout、网络、secure envd、volume mounts
  -> Orchestrator.CreateSandbox
       -> Redis reservation 原子检查 team 并发上限
       -> 组装 SandboxCreateRequest
       -> BestOfK 过滤 CPU/label/status 并选择 node
       -> node.Sandbox.Create gRPC
       -> Redis sandbox storage 写入运行态
       -> Nomad/local: API callback 写 Redis routing catalog
       -> remote: gRPC metadata 携带 catalog create event
  -> 异步增加 template spawn count 和发送 analytics
  -> 201 Sandbox
```

同一个 Sandbox ID 的并发启动会共享 reservation 结果；超限在调用节点前返回 429。节点创建成功但 Redis 落库失败时，API 会异步杀掉刚创建的 Sandbox，避免执行面孤儿。

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

## 6. 与其他组件边界

- 与 `packages/auth`：API 负责选择本服务支持的 authenticator；auth 包负责凭证验证、team 查询和 context 写入。
- 与 `packages/db`：API 只调用 sqlc client；schema、migration、事务原语和 DB 类型归 DB 包。
- 与 `packages/dashboard-api`：两者共享 auth 与 DB，但 Dashboard 面向账户、团队和历史展示；Sandbox 生命周期由本组件负责。
- 与 orchestrator：API 决定租户权限、配额和目标节点，orchestrator node 负责 VM、网络、snapshot 和 volume 的实际执行。
- 与 template manager：API 持有 build 状态机和 DB 记录，builder 负责产物构建并通过 gRPC 报告状态与 metadata。
- 与 client-proxy：Nomad/local 节点由 API callback 写删 Redis 路由；remote 节点通过 gRPC metadata 传 catalog event。catalog miss 时 client-proxy 可经 edge gRPC 请求 auto-resume。

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

## 8. 相关深挖

- [API 服务全景](../../md/api-module.md)
- [Sandbox REST API](../../md/sandbox-api-module.md)
- [Sandbox 生命周期](../../md/sandbox-lifecycle.md)
- [Orchestrator](../../md/orchestrator-module.md)
- [Template 构建链](../../md/template-build-flow.md)
- [Auto-Resume](../../md/auto-resume-module.md)
- [流量路由](../../md/sandbox-traffic-routing.md)
- [Volume](../../md/volumes.md)
