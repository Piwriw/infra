# E2B API 服务详解

> 本文档详细描述 E2B Infrastructure 中 **API 服务**(`packages/api/`)的设计、架构、数据模型、完整请求生命周期、鉴权、缓存、与 Orchestrator / ClickHouse / Redis 的交互,以及部署与运维细节。
>
> 适用于希望理解 E2B 对外 REST/gRPC 接口层如何工作、如何排障、如何扩展的工程师。
>
> **相关文档**:
> - [`template-module.md`](template-module.md) — Template 模版系统(build 触发、缓存、状态同步)
> - [`sandbox-management.md`](sandbox-management.md) — Sandbox 管理面(生命周期、状态机)
> - [`node-module.md`](node-module.md) — 节点/集群、服务发现、调度
> - [`volumes.md`](volumes.md) — 持久化卷
> - [`snapshots.md`](snapshots.md) — Pause/Resume 与 snapshot
> - [`database-schema.md`](database-schema.md) — 数据库 schema 与 sqlc

---

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、数据模型](#三数据模型)
- [四、架构与组件](#四架构与组件)
- [五、HTTP 请求生命周期](#五http-请求生命周期)
- [六、关键流程时序图](#六关键流程时序图)
- [七、存储与缓存机制](#七存储与缓存机制)
- [八、REST 接口完整索引](#八rest-接口完整索引)
- [九、gRPC 接口](#九grpc-接口)
- [十、配置与环境变量](#十配置与环境变量)
- [十一、Feature Flags](#十一feature-flags)
- [十二、关键代码文件索引](#十二关键代码文件索引)
- [十三、设计要点与演进历史](#十三设计要点与演进历史)
- [十四、常见问题排查](#十四常见问题排查)
- [十五、附录](#十五附录)

---

## 一、概述

### 1.1 服务定位

API 服务是 E2B 对外的"前门"。客户端 SDK(Python / JS / Go 等)发起的所有控制面请求都先到这里:

- **REST API**(默认端口 80 / 本地 3000):sandbox 增删改查、template 构建、volume 管理、metrics 查询、auth 等。
- **Edge gRPC**(默认端口 5109):由 edge / client-proxy 通过 OIDC JWT 反向调用,主要承接 sandbox auto-resume。
- **Internal gRPC**(默认端口 5009):供同 VPC 内的内部服务(client-proxy、dashboard-api 等)直接调用,跳过 OIDC。

API 自身 **不直接运行 sandbox**。它是控制面编排层,把 sandbox 的实际启停、调度、模板构建交给:

- **Orchestrator**(每个 Nomad/K8s node 一个):通过 gRPC 调用,负责 sandbox 生命周期与 Firecracker microVM。
- **Template Manager / Template Builder**:远程集群的构建节点,负责 template rootfs/cache 构建。
- **ClickHouse**:sandbox/team 维度的 metrics 与最大并发统计。
- **PostgreSQL**:业务持久化(template、sandbox snapshot、volume、team 等)。
- **Auth DB**(可读写分离):team、user、API key、access token、OIDC identity。
- **Redis**:多级缓存、限流、sandbox 状态镜像、资源预约、路由表。
- **Loki**(本地集群) / **Edge HTTP API**(远程集群):sandbox 日志查询。

### 1.2 在仓库中的位置

| 项 | 路径 |
| --- | --- |
| 模块根 | [`packages/api/`](../../packages/api/) |
| 入口 | [`packages/api/main.go`](../../packages/api/main.go) (628 行) |
| Go module | [`packages/api/go.mod`](../../packages/api/go.mod) — 独立 module |
| Dockerfile | [`packages/api/Dockerfile`](../../packages/api/Dockerfile) |
| Docker bake | [`packages/api/docker-bake.hcl`](../../packages/api/docker-bake.hcl) |
| air 热重载 | [`packages/api/.air.toml`](../../packages/api/.air.toml) |
| Makefile | [`packages/api/Makefile`](../../packages/api/Makefile) |
| OpenAPI 生成产物 | [`packages/api/internal/api/api.gen.go`](../../packages/api/internal/api/api.gen.go) (14049 行) |
| Nomad job 模板 | [`iac/modules/job-api/jobs/api.hcl`](../../iac/modules/job-api/jobs/api.hcl) |

E2B 后端是 **多 Go module** 结构,`packages/{api,shared,db,clickhouse,auth}` 各自独立,通过 `replace` / `local path` 互相依赖,在 Docker 构建时被合并到同一构建上下文。

### 1.3 服务名与版本

- `serviceName = "orchestration-api"`([`main.go:55`](../../packages/api/main.go))
- `serviceVersion = "1.0.0"`
- `commitSHA`、`expectedMigrationTimestamp`:通过 `-ldflags -X=` 在构建时注入(详见 §5.3)

### 1.4 端口与运行模式

| 用途 | 默认端口 | 配置项 | 说明 |
| --- | --- | --- | --- |
| HTTP API | 80(本地 `make run` 用 3000) | CLI flag `-port` | 对外 REST 入口,Traefik 用 `web` entrypoint |
| Internal gRPC | 5009 | `API_INTERNAL_GRPC_PORT` | 给 client-proxy 等内部服务 |
| Edge gRPC | 5109 | `API_EDGE_GRPC_PORT` | 对外,Traefik 用 `h2c` |
| pprof | 6060(仅 `127.0.0.1`) | `PPROF_PORT` | 必须只绑定 loopback |

---

## 二、核心概念

### 2.1 三种鉴权主体

E2B API 同时支持四种"我是谁"的证明方式,每种绑定一个 OpenAPI security scheme(详见 §4.1):

| Scheme | Header | 谁用 | 解析后 ctx 里的信息 |
| --- | --- | --- | --- |
| `ApiKeyAuth` | `X-API-Key: e2b_...` | 主流 SDK、CLI | `team`(单 team) |
| `AccessTokenAuth` ⚠️ | `Authorization: Bearer sk_e2b_...` | 旧 SDK,**Deprecated** | `user_id` |
| `AuthProviderBearerAuth` + `AuthProviderTeamAuth` | `Authorization: Bearer <OIDC JWT>` + `X-Team-Id: <teamID>` | 第三方 IdP(Clerk / Auth0 / 自建 OIDC) | `user_id` + `team`(显式指定) |
| `AdminApiKeyAuth` + `AdminTeamAuth` | `X-Admin-Token: <token>` + `X-Team-Id: <teamID>` | E2B 内部 admin 接口 | admin 上下文 + `team` |

> **Access Token 即将下线**:flag `disable-e2b-access-token-provisioning` 一旦打开,`POST /access-tokens` 返回 410 Gone。新集成应该走 API Key 或 OIDC。

### 2.2 Team 是计费和限流的根

无论用哪种鉴权,最终都会落到一个 **Team** 上:

- 每个资源(sandbox、template、volume、api-key)都属于一个 team。
- 限流 key:`ratelimit:<teamID>:<route>`(§7.5)。
- Feature Flags 上下文:team + tier + cluster 都被注入 LaunchDarkly context(§11.2)。
- Metrics 查询都按 teamID 过滤。

### 2.3 Sandbox 的两种"状态源"

API 看到的 sandbox 状态来自 **两个数据源** 的合并:

1. **Orchestrator 实时上报**(Redis):正在运行的 sandbox,通过 `sandbox/storage/redis` 同步。
2. **PostgreSQL 中的 snapshot 记录**:已 pause 的 sandbox(本质是最后一次 snapshot)。

`GET /sandboxes` 一次返回两类 sandbox 的合并视图(详见 §6.4)。

### 2.4 Template / Build / Snapshot / Volume 的关系

- **Template**:用户构建出的可启动模版(`env` 表行)。
- **Build**:Template 的一次构建产物(`env_build` 表行),有状态 `building / ready / error / ...`。
- **Snapshot**:从运行中的 sandbox 创建的新 template(从 sandbox 视角看是"暂停点",从 template 视角看是"派生模版")。详见 [`snapshots.md`](snapshots.md)。
- **Volume**:跨 sandbox 生命周期的持久化卷。详见 [`volumes.md`](volumes.md)。

API 是这些资源在控制面的统一入口。

---

## 三、数据模型

API 自身 **不定义 schema**,所有持久化由 [`packages/db/`](../../packages/db/) 负责(详见 [`database-schema.md`](database-schema.md))。本节只列出 API **读写** 的核心模型。

### 3.1 业务 DB(PostgreSQL,主连接池)

由 `packages/db/client` 提供,底层是 `pgxpool`。配置:

| 配置 | 默认 | 来源 |
| --- | --- | --- |
| Max open connections | 40 | `DB_MAX_OPEN_CONNECTIONS` |
| Min idle connections | 5 | `DB_MIN_IDLE_CONNECTIONS` |
| Connection max lifetime | 30 min ± 10 min jitter | `packages/db/pkg/pool` |

主要表 / 模型(从 sqlc 生成的 model 名推断):

- `Env`(template)、`EnvBuild`、`EnvAlias`、`EnvTag`
- `TemplateBuildAssignment`
- `Snapshot`
- `Volume`
- `Cluster`

主要 sqlc 查询(在 [`packages/db/queries/`](../../packages/db/queries/)):

- `get_team_template.sql.go`、`get_team_templates.sql.go`
- `get_snapshots_with_cursor.sql.go`(分页 cursor)
- `get_template.sql.go`、`get_template_by_id.sql.go`
- `get_template_with_build_by_tag.sql.go`、`get_template_with_builds.sql.go`
- `create_template.sql.go`、`update_template.sql.go`、`delete_template.sql.go`
- `create_new_snapshot.sql.go`、`update_snapshot_origin_node.sql.go`
- `upsert_alias.sql.go`、`exists_template_snapshots.sql.go`
- `get_inprogress_builds.sql.go`、`update_template_build_status.sql.go`、`finish_template_build.sql.go`
- `get_active_clusters.sql.go`、`get_exclusive_builds_for_template_deletion.sql.go`

### 3.2 Auth DB(可读写分离)

由 [`packages/db/pkg/auth/client.go`](../../packages/db/pkg/auth/client.go) 提供,内含 `Read *authqueries.Queries` + `Write *authqueries.Queries`,分别绑定读副本和主库。`Write` 仅用于"必须读主库"的场景(OIDC 首次绑定、API key 写入等)。

| 配置 | 默认 | 来源 |
| --- | --- | --- |
| 主库 DSN | `POSTGRES_CONNECTION_STRING`(空时复用业务 DSN) | `AUTH_DB_CONNECTION_STRING` |
| 读副本 DSN | — | `AUTH_DB_READ_REPLICA_CONNECTION_STRING` |
| Max open / min idle | 20 / 5 | `AUTH_DB_MAX_OPEN_CONNECTIONS` / `AUTH_DB_MIN_IDLE_CONNECTIONS` |

主要表 / 模型:

- `public_user` — 用户主表
- `public_identity` — `(issuer, subject) → user_id` 映射(OIDC)
- `team`、`team_limit`
- `team_api_key`
- `access_token`

主要 sqlc 查询(在 [`packages/db/pkg/auth/queries/`](../../packages/db/pkg/auth/queries/)):

- `get_team.sql.go`(按 hashed API key)、`get_team_api_key_hashes.sql.go`
- `get_user_id_from_access_token.sql.go`
- `get_user_identities_*.sql.go`
- `upsert_public_user.sql.go`

### 3.3 ClickHouse(只读)

由 [`packages/clickhouse/pkg/clickhouse.go`](../../packages/clickhouse/pkg/clickhouse.go) 提供 `Clickhouse` interface:

```go
type Clickhouse interface {
    QuerySandboxTimeRange(ctx, sandboxID, teamID) (start, end time.Time, err error)
    QuerySandboxMetrics(ctx, sandboxID, teamID, start, end, step) ([]Metrics, error)
    QueryLatestMetrics(ctx, sandboxIDs, teamID) ([]Metrics, error)
    QueryTeamMetrics(ctx, teamID, start, end, step) ([]TeamMetrics, error)
    QueryMaxStartRateTeamMetrics(...) (MaxTeamMetric, error)
    QueryMaxConcurrentTeamMetrics(...) (MaxTeamMetric, error)
    Close(ctx) error
}
```

驱动:`clickhouse-go/v2`,默认 `MaxOpenConns=10`、`MaxIdleConns=3`。

**关键设计:Switching client**。`clickhouse.NewSwitchingClient(...)` 允许通过 LD flag `clickhouse-read-endpoint` 在不重启的情况下把读流量从一个 CH cluster 切到另一个:

- flag 为空 → 用 singular DSN(`CLICKHOUSE_CONNECTION_STRING`)
- flag 为 `"0"` / `"1"` / ... → 用 `CLICKHOUSE_CONNECTION_STRINGS`(分号分隔)的第 i 个
- 允许 `WithAllowNoopDefault(true)`:flag 与 DSN 都没配时返回 noop client,服务能启动但 metrics 查询返空

### 3.4 运行时模型(OpenAPI 生成)

所有对外暴露的 DTO 都由 `oapi-codegen` 从 [`spec/openapi.yml`](../../spec/openapi.yml) 自动生成,位于 [`packages/api/internal/api/api.gen.go`](../../packages/api/internal/api/api.gen.go) (14049 行)。核心 model:

| 类型 | 出现位置 | 用途 |
| --- | --- | --- |
| `NewSandbox` | `POST /sandboxes` body | 创建 sandbox 请求 |
| `Sandbox`、`SandboxDetail` | `GET /sandboxes/{id}` response | sandbox 详情 |
| `ListedSandbox` | `GET /sandboxes` response | 列表项 |
| `Template` | `GET /templates/{id}` response | template |
| `TemplateBuild`、`TemplateBuildRequestV3` | build 相关 | 构建 DTO |
| `Volume` | `GET /volumes/{id}` response | volume |
| `Node`、`NodeDetail` | `GET /nodes` response | orchestrator 节点 |
| `Team`、`TeamAPIKey` | auth/team 相关 | |
| `SandboxMetric`、`TeamMetric`、`MaxTeamMetric` | metrics 相关 | |
| `FromImageRegistry` | build DTO | discriminator union,有 `AsAWSRegistry`/`AsGCPRegistry`/`AsGeneralRegistry` |

枚举(均为 string):`SandboxState`、`TemplateBuildStatus`、`NodeStatus`、`LogLevel`、`LogsDirection`、`LogsSource`、`SandboxOnTimeout`、`GetTeamsTeamIDMetricsMaxParamsMetric`。

---

## 四、架构与组件

### 4.1 总体架构

```
                      客户端 SDK / 浏览器
                             │
                             ▼
                       ┌──────────┐
                       │ Traefik  │  (Nomad / K8s ingress)
                       └────┬─────┘
                            │ HTTP (web) + gRPC (h2c)
                            ▼
┌──────────────────────────────────────────────────────────┐
│                     API 服务(packages/api)               │
│                                                            │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Gin HTTP│  │ Internal │  │  Edge    │  │  pprof   │    │
│  │ Server  │  │  gRPC    │  │  gRPC    │  │ Server   │    │
│  │ :80     │  │ :5009    │  │ :5109    │  │ :6060    │    │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └──────────┘    │
│       │            │              │                         │
│       └────────────┴──────────────┘                         │
│                    │                                        │
│                    ▼                                        │
│            ┌──────────────────┐                             │
│            │   APIStore       │  ← "上帝对象",实现全部     │
│            │ (handlers/store) │     ServerInterface 方法    │
│            └────┬─────────────┘                             │
│                 │                                            │
│       ┌─────────┼──────────────────────────────┐            │
│       ▼         ▼                              ▼            │
│  ┌─────────┐ ┌──────────┐  ┌──────────────┐ ┌────────┐     │
│  │ Orchestr│ │ Template │  │   Cluster    │ │ Click  │     │
│  │ ator    │ │ Manager  │  │    Pool      │ │ House  │     │
│  │ Client  │ │          │  │              │ │Switcher│     │
│  └────┬────┘ └────┬─────┘  └──────┬───────┘ └────────┘     │
│       │           │               │                         │
│       ▼           ▼               ▼                         │
│  ┌─────────┐ ┌──────────┐  ┌──────────────┐                 │
│  │ sqlcDB  │ │  authDB  │  │  Redis       │                 │
│  │ (pool)  │ │ R/W split│  │  (cache/     │                 │
│  │         │ │          │  │  rate/pubsub)│                 │
│  └─────────┘ └──────────┘  └──────────────┘                 │
└──────────────────────────────────────────────────────────┘
        │                              │
        ▼ gRPC                         ▼
  ┌──────────────┐              ┌──────────────┐
  │ Orchestrator │              │   LaunchDarkly│
  │   Nodes      │              │  (Feature    │
  │ (per-node)   │              │   Flags)     │
  └──────────────┘              └──────────────┘
```

### 4.2 APIStore — 控制面的"上帝对象"

文件:[`packages/api/internal/handlers/store.go`](../../packages/api/internal/handlers/store.go) (513 行)

`APIStore` 实现生成的 `api.ServerInterface`(编译期断言 `var _ api.ServerInterface = (*APIStore)(nil)`,行 65),把所有 REST handler 方法挂在同一个结构上:

```go
type APIStore struct {
    Healthy               atomic.Bool
    config                cfg.Config
    posthog               *analyticscollector.PosthogClient
    Telemetry             *telemetry.Client
    orchestrator          *orchestrator.Orchestrator
    templateManager       *template_manager.TemplateManager
    sqlcDB                *sqlcdb.Client
    authDB                *authdb.Client
    redisClient           redis.UniversalClient
    templateCache         *templatecache.TemplateCache
    templateBuildsCache   *templatecache.TemplatesBuildCache
    snapshotCache         *snapshotcache.SnapshotCache
    authService           sharedauth.Service
    templateSpawnCounter  *utils.TemplateSpawnCounter
    clickhouseStore       clickhouse.Clickhouse
    accessTokenGenerator  *sandbox.AccessTokenGenerator
    featureFlags          *featureflags.Client
    clusters              *clusters.Pool
    snapshotUpsertSem     *sharedutils.AdjustableSemaphore
    sandboxListSem        *sharedutils.AdjustableSemaphore
    snapshotBuildQuerySem *sharedutils.AdjustableSemaphore
}
```

构造函数 `NewAPIStore`(行 91-292)依次初始化这些依赖,启动若干后台 goroutine(详见 §5.2)。`Close`(行 294-345)按相反顺序关闭。

**为什么是单一大对象而不是分层?** 因为 OpenAPI 生成的 `ServerInterface` 是一个 interface,必须有单一类型实现它全部方法。把 handler 与共享依赖放在同一对象上是最直接的做法。代码里也有少量 helper(`auth.go`、`sandbox.go` 等)挂在 `*APIStore` 上以共享私有方法。

### 4.3 启动顺序

入口 `run()`([`main.go:267`](../../packages/api/main.go)),按时间顺序:

1. 顶层 ctx 派生(带 cancel)。
2. CLI flag `-port`(默认 80)。
3. 生成 `serviceInstanceID = uuid.New().String()` 和 `nodeID = env.GetNodeID()`(`NODE_ID` 环境变量,Nomad 注入 `node.unique.id`,缺失即 fatal)。
4. **Telemetry 初始化**:`telemetry.New(...)`(`OTEL_COLLECTOR_GRPC_ENDPOINT` 未设时返 NoopClient)。
5. `e2bgrpc.StartChannelzSampler(ctx)` — 启动 gRPC Channelz 采样。
6. **Logger 初始化**:主 logger + sandbox external/internal logger 各一份(`sbxlogger.SetSandboxLoggerExternal/Internal`)。
7. `tel.StartRuntimeInstrumentation()` — Go runtime metrics。
8. 解析 `expectedMigrationTimestamp`(ldflags 注入的字符串 → int64,失败设 0)。
9. `cfg.Parse()`(详见 §10)。
10. **Migration 校验**:`sqlcdb.CheckMigrationVersion(ctx, PostgresConnectionString, expectedMigration)` — 实际 DB migration 版本与构建期望不一致就 fatal。
11. `api.GetSwagger()` — 从 `api.gen.go` 嵌入的 spec 加载 kin-openapi `T`。
12. **Redis**:`factories.NewRedisClient(...)`。
13. **Feature Flags**:`featureflags.NewClient()`(LaunchDarkly);`SetServiceName` / `SetDeploymentName` 给 LD context 加服务/部署维度。
14. **APIStore**:`handlers.NewAPIStore(...)`。这里会启动 §4.4 列出的若干后台 goroutine。
15. **Internal gRPC server**(默认 :5009):`handlers.NewSandboxService(apiStore, false, nil)`,不强制 OIDC。
16. **Edge gRPC server**(默认 :5109):`oauth.NewVerifier(ctx, ClientProxyOIDCIssuerURL)`;`oauth.Configured(...)` false 时只 warn 不 fatal,但所有 edge gRPC 请求都会被拒。`handlers.NewSandboxService(apiStore, true, verifier)`。
17. **HTTP Gin server**:`NewGinServer(...)`。
18. **信号 + graceful shutdown** 配置(详见 §5.4)。
19. **pprof server**:`telemetry.NewPprofServer()` 绑定 `127.0.0.1:6060`。
20. 三个 server(HTTP、internal gRPC、edge gRPC)并行 `wg.Go` 起在 `errgroup.WaitGroup`。
21. `wg.Wait()` → `cleanup()` → 返回 exit code。

### 4.4 APIStore 启动的后台 goroutine

| Goroutine | 文件 | 作用 |
| --- | --- | --- |
| `updateDBThrottleLimits` | `store.go:358` | 每 30s 读 LD flag 调整 3 个 `AdjustableSemaphore` 的 limit(`MaxConcurrentSnapshotUpserts` 等),无需重启限流 |
| 健康轮询 | `store.go:274-289` | 每 5ms 检查 `orch.NodeCount() != 0`,首次满足时 `Healthy.Store(true)`(行 283),让 `/health` 返 200 |
| `templateManager.BuildsStatusPeriodicalSync` | `template_manager.go:80` | 每分钟拉 `GetInProgressTemplateBuilds`,对每个 build 去 builder node 同步状态 |
| `templateSpawnCounter` flush | `utils/counter.go` | 每分钟把 in-memory template spawn 计数 flush 到 DB |
| `redisStorage.Start` | `sandbox/storage/redis` | 监听 sandbox 状态变化(通过 pub/sub 推送) |
| `clusters.Pool` 同步 | `clusters/cluster.go:288` | 每个 cluster 周期性 `SyncInstances(ctx)` |

### 4.5 gin 中间件链

`NewGinServer`([`main.go:101`](../../packages/api/main.go))构建的中间件链(自顶向下):

| # | 中间件 | 来源 | 作用 |
| --- | --- | --- | --- |
| 1 | `gin.Recovery()` | gin | panic 恢复(代码里出现两次,第二次冗余) |
| 2 | `otel tracing` | [`packages/shared/pkg/middleware/otel/tracing/`](../../packages/shared/pkg/middleware/otel/tracing/) | OpenTelemetry tracing,`ExcludeRoutes` 跳过 `/health`、`/sandboxes/:sandboxID/refreshes` 等高频路由 |
| 3 | `otel metrics` | [`packages/shared/pkg/middleware/otel/metrics/`](../../packages/shared/pkg/middleware/otel/metrics/) | OTel metrics,`IncludeRoutes` 只覆盖 sandbox 核心路由 |
| 4 | `LoggingMiddleware` | [`packages/shared/pkg/middleware/logging.go`](../../packages/shared/pkg/middleware/logging.go) | zap 结构化访问日志,带 `Skipper` 跳过 health/refreshes/logs/status |
| 5 | `gin.Recovery()`(冗余) | gin | |
| 6 | `RequestTimeout(70s)` | [`packages/shared/pkg/middleware/timeout.go`](../../packages/shared/pkg/middleware/timeout.go) | 通过 `context.WithTimeoutCause` 把 deadline 注入 `r.Context()`,返回 `ErrRequestTimeout` 让 logging middleware 区分 408 vs 499 |
| 7 | `cors.New(corsConfig)` | `gin-contrib/cors` | `AllowAllOrigins=true`,AllowHeaders 含 `Authorization`、`X-API-Key`、`X-Team-Id`、`X-Admin-Token` 及 SDK 元信息头(`browser`、`lang`、`lang_version`、`package_version` 等) |
| 8 | `limits.RequestSizeLimiter(16 MiB)` | `github.com/gin-contrib/size`(在 `main.go:22` 别名为 `limits`) | 上传体积上限 |
| 9 | `OapiRequestValidatorWithOptions` | `oapi-codegen/gin-middleware` | **核心**:每个请求按 spec 校验 path/query/body,security 校验时调用 `AuthenticationFunc` |
| 10 | `InitLaunchDarklyContext` | [`packages/api/internal/middleware/launchdarkly.go`](../../packages/api/internal/middleware/launchdarkly.go) | 把 team/user/cluster/tier 注入 LD context |
| 11 | `ratelimit.Middleware` | [`packages/api/internal/middleware/ratelimit/ratelimit.go`](../../packages/api/internal/middleware/ratelimit/ratelimit.go) | Redis 限流,FailOpen |
| 12 | `EnforceBlockedTeam` | [`packages/api/internal/middleware/blocked_team.go`](../../packages/api/internal/middleware/blocked_team.go) | 拒绝被封禁 team 走写入路由(只读白名单放行) |
| 13 | `RegisterHandlersWithOptions(apiStore)` | oapi-codegen 生成 | 路由绑定,`ErrorHandler = utils.ErrorHandler` |

最后 `httpserver.ConfigureH2C(s)`([`packages/shared/pkg/httpserver/h2c.go`](../../packages/shared/pkg/httpserver/h2c.go))开启 clear-text HTTP/2,Traefik 用 h2c 协议路由 grpc-api。

> **为什么 auth 不是独立 gin middleware?** 因为 oapi-codegen 的 validator middleware 在 security 校验阶段调用 `AuthenticationFunc`,这里把 6 个 `Authenticator` 串起来(§5.2)。这样 spec 改了 security scheme,代码自动跟着改,不用维护两套。

### 4.6 服务发现(Discovery)

`APIStore` 内部的 `orchestrator.Orchestrator` 不直接持有 orchestrator 地址,而是通过 `discovery.Discovery` interface 动态列出当前活跃的 orchestrator 节点:

```go
// packages/api/internal/orchestrator/discovery/discovery.go:62
type Discovery interface {
    ListNodes(ctx context.Context) ([]Node, error)
}
```

实现:

| 实现 | 文件 | 适用场景 |
| --- | --- | --- |
| `NewNomad(nomadClient, serviceNames)` | [`discovery/nomad.go`](../../packages/api/internal/orchestrator/discovery/nomad.go) | 默认;通过 Nomad HTTP API `/v1/service/<name>` 列服务注册项 |
| `NewNomadNodePool(nomadClient, "default")` | [`discovery/nomad_node_pool.go`](../../packages/api/internal/orchestrator/discovery/nomad_node_pool.go) | Legacy fallback;列 ready Nomad nodes,假设每个都跑 orchestrator |
| `NewMerged(primary, fallback)` | [`discovery/merged.go`](../../packages/api/internal/orchestrator/discovery/merged.go) | 按 ShortID 去重,primary 胜出 |
| `NewKubernetes(k8sClient, namespace, labelSelector)` | [`discovery/kubernetes.go`](../../packages/api/internal/orchestrator/discovery/kubernetes.go) | K8s 部署;列 DaemonSet pods 取 `status.HostIP`(host_network) |
| `NewLocal(address)` | [`discovery/local.go`](../../packages/api/internal/orchestrator/discovery/local.go) | 本地开发,单一静态地址 |

由 `cfg.ServiceDiscoveryProvider` 决定走哪个:

- `nomad`(默认)→ `NewNomad` + 可选 `NewMerged(NewNomadNodePool)`(flag `NOMAD_ORCHESTRATOR_LEGACY_DISCOVERY_ENABLED`,默认 true)
- `kubernetes` → `NewKubernetes`
- `local` → `NewLocal`(`LOCAL_ORCHESTRATOR_ADDRESS` 默认 `127.0.0.1:5008`)

### 4.7 节点连接管理(nodemanager)

文件:[`packages/api/internal/orchestrator/client.go`](../../packages/api/internal/orchestrator/client.go)

API 不为每个 node 长期持有 gRPC 连接,而是按需 `getOrConnectNode(ctx, clusterID, nodeID)`:

- `connectToNode(ctx, discovered)`(行 20)— `singleflight.Group`(`connectGroup`)按 `NomadNodeShortID` 去重,内部 `nodemanager.New(...)` 建 gRPC 连接。
- `connectToClusterNode(ctx, cluster, instance)`(行 46)— 集群版本,key 是 `scopedNodeID(clusterID, nodeID)`。
- `getOrConnectNode(ctx, clusterID, nodeID)`(行 142)— cache miss 时按需 discovery + connect。
- `scopedNodeID(clusterID, nodeID)`(行 89)— **本地** cluster 用纯 `nodeID`,**远端** cluster 用 `<clusterID>-<nodeID>`,避免跨 cluster 重名。

> **关键设计**:`connectGroup` 和 `discoveryGroup` 必须分开。否则 cluster node 路径下外层 `discoveryGroup.Do` 的 key 和内层 `connectGroup.Do` 的 key 相同,nested `Do` 会死锁。

`getOrConnectNode` 注释明确处理两类 gap:

- 本地 instance map 同步延迟(0–5s for clusters,0–20s for Nomad)
- promotion 到 `o.nodes` 的延迟(0–20s)

### 4.8 调度(Placement)

文件:[`packages/api/internal/orchestrator/placement/`](../../packages/api/internal/orchestrator/placement/)

- `placement.BestOfK`([`placement_best_of_K.go`](../../packages/api/internal/orchestrator/placement/placement_best_of_K.go)) — best-of-K sampling 调度。
- 配置(从 LD flag 30s 重读一次):
  ```go
  type BestOfKConfig struct {
      R     float64  // max overcommit ratio, BestOfKMaxOvercommit / 100
      K     int      // sample size, BestOfKSampleSize
      Alpha float64  // 当前用量权重, BestOfKAlpha / 100
  }
  ```
- 过滤器:`cpu_compatibility.go`(CPU 型号兼容)、`label_compatibility.go`(label 调度)。

默认值:K=3、MaxOvercommit=400%(4×)、Alpha=50%。详见 §11.3。

### 4.9 clusters.Pool(本地 + 远端集群)

文件:[`packages/api/internal/clusters/`](../../packages/api/internal/clusters/)

- `Pool` 管理多个 cluster(本地 + 远端 edge 集群)。
- 每个 cluster 有 `instances *smap.Map[*Instance]`,同时含 orchestrator 和 template-builder 角色。
- `Cluster.SyncInstances(ctx)`([`cluster.go:288`](../../packages/api/internal/clusters/cluster.go))周期性同步。
- `Cluster.GetResources()`([`cluster.go:281`](../../packages/api/internal/clusters/cluster.go))返回 `ClusterResource`(metrics / logs / build logs 查询接口)。
- **本地 cluster**(`newLocalCluster`):Loki 查日志,CH 查 metrics。
- **远端 cluster**(`newRemoteCluster`):走 edge HTTP API。

> **关键抽象**:ClickHouse / Loki 不会直接被 sandbox 级 handler 用,而是先经过 `clusters.ClusterResource` 抽象,由 cluster 决定走本地 CH / Loki 还是远端 edge API。这让"多 region 部署"成为可能。

---

## 五、HTTP 请求生命周期

### 5.1 超时与 shutdown 预算

文件:[`main.go:54-94`](../../packages/api/main.go)

```go
const (
    maxReadHeaderTimeout      = 5 * time.Second
    maxReadTimeout            = 10 * time.Second
    maxWriteTimeout           = 75 * time.Second
    requestTimeout            = 70 * time.Second
    idleTimeout               = 620 * time.Second

    shutdownDrainWait         = 15 * time.Second
    shutdownTimeout           = requestTimeout + 5*time.Second  // 75s
    pprofShutdownTimeout      = 5 * time.Second
)
```

**几个关键约束**:

1. **`requestTimeout` 必须 < `maxWriteTimeout`**。Go 的 `http.Server.WriteTimeout` 不会取消 `r.Context()`([golang/go#59602](https://github.com/golang/go/issues/59602)),所以代码里另用 `sharedmiddleware.RequestTimeout(requestTimeout)` middleware,通过 `context.WithTimeoutCause` 把 deadline 注入 `r.Context()`。Handler 里所有 `c.Request.Context()` 的阻塞调用都会被这个 deadline 取消。

2. **`idleTimeout = 620s` 故意大于 GCP LB 的 600s upstream keepalive**,避免 race condition(LB 还想复用连接,server 已关闭)。

3. **Nomad `kill_timeout = 150s`** 严格等于 shutdown budget:
   ```
   shutdownDrainWait 15s + shutdownTimeout 75s + cleanup 30s + slack ≈ 150s
   ```
   任何延长都要同步改 [`iac/modules/job-api/jobs/api.hcl`](../../iac/modules/job-api/jobs/api.hcl)。

4. **`BaseContext` 必须用根 ctx**([`main.go:254-260`](../../packages/api/main.go))。否则 serve goroutine 退出会 cancel 所有 in-flight 请求的父 ctx,这与 graceful shutdown 的目的相违。

### 5.2 鉴权流程

OpenAPI validator middleware(`OapiRequestValidatorWithOptions`)在校验完 path/query/body 后,会按 spec 的 `security` 字段调用 `AuthenticationFunc`。`AuthenticationFunc` 由 [`packages/auth/pkg/auth/middleware.go`](../../packages/auth/pkg/auth/middleware.go) 的 `CreateAuthenticationFunc` 构造:

```go
// main.go:189-199
AuthenticationFunc := auth.CreateAuthenticationFunc(
    []auth.Authenticator{
        auth.NewApiKeyAuthenticator(apiStore.GetTeamFromAPIKey),
        auth.NewAccessTokenAuthenticator(apiStore.GetUserFromAccessToken),
        auth.NewAuthProviderBearerAuthenticator(apiStore.GetUserIDFromAuthProviderToken),
        auth.NewAuthProviderTeamAuthenticator(apiStore.GetTeamFromAuthProviderToken),
        auth.NewAdminApiKeyAuthenticator(config.AdminToken),
        auth.NewAdminTeamAuthenticator(apiStore.GetTeamFromAdminToken),
    },
    metricsMiddleware.SetProcessingStartTime,  // preAuthHook,用来测 auth 延迟
)
```

每个 `Authenticator` 实现:

```go
type Authenticator interface {
    Authenticate(ctx context.Context, ginCtx *gin.Context, input openapi3.AuthenticationInput) error
    SecuritySchemeName() string
}
```

kin-openapi 的校验顺序:**在一个 security requirement 内按 scheme 名字字母序校验**。spec 里的命名故意让 token 先于 team context 校验:

| 字母序 | 前 | 后 | 效果 |
| --- | --- | --- | --- |
| Bearer | `AdminApiKeyAuth` | `AdminTeamAuth` | admin token 先校验,team 后查 |
| Bearer | `AuthProviderBearerAuth` | `AuthProviderTeamAuth` | OIDC JWT 先解析出 userID,再查 team |

> **关键设计**:这样在没 token 的情况下不会做无谓的 team 查询,直接 401。spec 注释([`spec/openapi.yml:23-34`](../../spec/openapi.yml))和测试 `TestAdminTeamAuthSchemeOrder`([`packages/api/internal/api/spec_test.go`](../../packages/api/internal/api/spec_test.go))共同守护这个不变量。

**Header 缺失时的处理**([`middleware.go:75-79`](../../packages/auth/pkg/auth/middleware.go)):

```go
if headerValue == "" {
    ginCtx.Status(http.StatusUnauthorized)
    return ..., err
}
```

主动写 401 status,这样 oapi-codegen 的 `ErrorHandler` 里 `max(writer.status, fallbackStatusCode)` 会把 400 改成 401(防 validator 默认 fallback 把 401 吞成 400)。

### 5.3 五种鉴权路径详解

#### 5.3.1 API Key(`ApiKeyAuth`)

Header:`X-API-Key: e2b_<base62>`

流程:
1. `NewApiKeyAuthenticator` 剥掉 `e2b_` 前缀。
2. 调 `apiStore.GetTeamFromAPIKey` → `authService.ValidateAPIKey`([`packages/auth/pkg/auth/service.go:93`](../../packages/auth/pkg/auth/service.go))。
3. `keys.VerifyKey(keys.ApiKeyPrefix, apiKey)` 校验格式并算 hash。
4. `teamCache.GetOrSet(ctx, hashedKey, func { store.GetTeamByHashedAPIKey })` — Redis 5min TTL + 1min 后台 refresh 的两级缓存(详见 §7.1)。
5. 命中后向 telemetry 写 `WithMaskedAPIKey` 和 `WithTeamID`,向 gin ctx 写 `team` key。

#### 5.3.2 Access Token(`AccessTokenAuth`,**Deprecated**)

Header:`Authorization: Bearer sk_e2b_<base62>`

流程:
1. `NewAccessTokenAuthenticator` 剥掉 `Bearer ` 前缀,校验 `sk_e2b_` 前缀。
2. 调 `apiStore.GetUserFromAccessToken` → `authService.ValidateAccessToken`([`service.go:140`](../../packages/auth/pkg/auth/service.go))。
3. `keys.VerifyKey(keys.AccessTokenPrefix, accessToken)` 算 hash。
4. **不走缓存**,直接 `store.GetUserIDByHashedAccessToken`。原因:access token 即将废弃,加缓存意义不大。
5. handler 内部再用 `GetTeam(ctx, c, teamID)` → `dbapi.GetTeamsByUser` → `findTeam` 在用户所属 teams 里查找(无 teamID 时返回 default team)。

#### 5.3.3 OIDC JWT(`AuthProviderBearerAuth` + `AuthProviderTeamAuth`)

Headers:`Authorization: Bearer <JWT>` + `X-Team-Id: <teamID>`

流程:
1. `NewAuthProviderBearerAuthenticator` 剥 `Bearer `,无前缀校验。
2. 调 `apiStore.GetUserIDFromAuthProviderToken` → `authService.ValidateAuthProviderToken`([`service.go:174`](../../packages/auth/pkg/auth/service.go))。
3. `Verifier.Verify(ctx, token)` — 多 strategy 聚合,第一个成功即返回([`packages/auth/pkg/auth/verifier.go`](../../packages/auth/pkg/auth/verifier.go))。
4. 配置:`AUTH_PROVIDER_CONFIG` 环境变量(JSON `{"jwt": [oidc.Config]}`)。无 JWT issuer 时 `Verifier` 返 `(nil, nil)` — **合法配置**,但所有 `ValidateAuthProviderToken` 一律 401。
5. oidc strategy 从 `(iss, sub)` 查 identity → userID。Identity lookup 带 1 min TTL in-process 缓存,只缓存成功结果(避免新用户被锁)。
6. 向 gin ctx 写 `user_id`。
7. 然后到 `NewAuthProviderTeamAuthenticator`(`X-Team-Id`):
   - 调 `apiStore.GetTeamFromAuthProviderToken` → `authService.ValidateAuthProviderTeam`([`service.go:213`](../../packages/auth/pkg/auth/service.go))。
   - 从 ctx 取 userID(由 Bearer 那步写入),`teamCache.GetOrSet(ctx, teamMemberCacheKey(userID, teamID), ...)` 验证用户在该 team。
   - 向 gin ctx 写 `team`。

#### 5.3.4 Admin(`AdminApiKeyAuth` + `AdminTeamAuth`)

Headers:`X-Admin-Token: <token>` + `X-Team-Id: <teamID>`

流程:
1. `NewAdminApiKeyAuthenticator`(`middleware.go`)用 `subtle.ConstantTimeCompare(token, config.AdminToken)` 比较 — 防 timing attack。
2. 通过后到 `NewAdminTeamAuthenticator`:`apiStore.GetTeamFromAdminToken` → `authService.GetTeamByID(teamID)`,带 5min Redis 缓存。
3. 向 gin ctx 写 `team`(任意 team,因为 admin 已通过)。

> **已知脏代码**:[`store.go:417`](../../packages/api/internal/handlers/store.go) 和 [`store.go:466`](../../packages/api/internal/handlers/store.go) **重复定义了 `GetTeamFromAdminToken`**,两份代码完全相同。这是已知 merge 事故,文档单独标注以提醒读者。

### 5.4 Graceful Shutdown

`main.go` 的关闭顺序:

1. `signalCtx`(SIGTERM / SIGINT) 或 `serveErrCtx`(任一 serve goroutine 失败)触发。
2. **第一步**:`apiStore.Healthy.Store(false)` → `/health` 立即返 503。
3. **第二步**:非 local 环境等 `shutdownDrainWait = 15s`,给 GCP LB 时间把该 backend 摘掉。
4. **第三步**:并行
   - HTTP server `Shutdown(ctx, 75s)`
   - 两个 gRPC server `GracefulStopWithTimeout(75s)`(超时 fallback 到 `Stop()`)
5. **第四步**:pprof server `Shutdown(5s)`。
6. **第五步**:`cleanup()` 串行关闭 posthog / DB / Redis / cache / featureFlags。

`GracefulStopWithTimeout` 在 [`packages/shared/pkg/grpc/shutdown.go`](../../packages/shared/pkg/grpc/shutdown.go):独立 goroutine 跑 `GracefulStop()`,超时后 `Stop()`,防止 stuck stream 阻塞 Nomad 的 `kill_timeout`。

### 5.5 Migration 版本校验

启动早期(`run()` 步骤 10):

```go
sqlcdb.CheckMigrationVersion(ctx, config.PostgresConnectionString, expectedMigration)
```

`expectedMigrationTimestamp` 在构建时通过 `scripts/get-latest-migration.sh` 取最新 migration 时间戳,ldflags 注入到 `main.expectedMigrationTimestamp`。运行时比对实际 DB migration 版本,不一致就 fatal。

这防止"API 跑在过新/过旧的 schema 上"——例如代码引用了 schema 已删的字段,或代码不知道的新字段。

### 5.6 健康检查

- HTTP 路由 `GET /health` → `APIStore.GetHealth`([`store.go:379`](../../packages/api/internal/handlers/store.go)):
  ```go
  if a.Healthy.Load() { c.String(200, "Health check successful"); return }
  c.String(503, "Service is unavailable")
  ```
- `Healthy atomic.Bool`:启动时 false,等首个 orchestrator node 接入后置 true(§4.4 健康轮询)。shutdown 第一步置 false。
- Nomad service check:`/health` 每 3s 一次,timeout 3s(见 [`iac/modules/job-api/jobs/api.hcl:56-63`](../../iac/modules/job-api/jobs/api.hcl))。

---

## 六、关键流程时序图

### 6.1 `POST /sandboxes`(创建 sandbox)

```
Client                API                     Orchestrator          Redis         PostgreSQL
  │                    │                          │                   │                │
  │ POST /sandboxes    │                          │                   │                │
  │ X-API-Key: e2b_... │                          │                   │                │
  ├───────────────────►│                          │                   │                │
  │                    │                          │                   │                │
  │                    │ OapiRequestValidator     │                   │                │
  │                    │  → AuthenticationFunc    │                   │                │
  │                    │  → ApiKeyAuthenticator   │                   │                │
  │                    │  → ValidateAPIKey ───────┼───────────────────┼───────────────►│
  │                    │  ← team { cached? }      │                   │  (cache miss)  │
  │                    │                          │                   │◄───────────────┤
  │                    │ InitLaunchDarklyContext  │                   │                │
  │                    │ ratelimit.Middleware ────┼───────────────────►│                │
  │                    │ EnforceBlockedTeam       │                   │                │
  │                    │                          │                   │                │
  │                    │ PostSandboxes handler    │                   │                │
  │                    │  templateCache.Get ──────┼───────────────────►│                │
  │                    │  ← template+build        │                   │                │
  │                    │  startSandboxInternal    │                   │                │
  │                    │  orchestrator.CreateSandbox                  │                │
  │                    │   placement.BestOfK      │                   │                │
  │                    │   → 选 node ─────────────┤                   │                │
  │                    │   node.GetClient().Sandbox.SandboxCreate ───►│                │
  │                    │                          │   VM 启动         │                │
  │                    │                          │   snapshot 恢复   │                │
  │                    │                          ◄───────────────────┤                │
  │                    │  sandbox storage 写 Redis ──────────────────►│                │
  │                    │  sandbox catalog 写路由表 ──────────────────►│                │
  │                    │  ← Sandbox{SandboxID, ClientID, ...}         │                │
  │                    │                          │                   │                │
  │  200 OK            │                          │                   │                │
  │  {sandboxID, ...}  │                          │                   │                │
  │◄───────────────────┤                          │                   │                │
```

### 6.2 `POST /sandboxes/{id}/pause`

```
Client            API                     Orchestrator          Redis         PostgreSQL
  │                │                          │                   │                │
  │ POST .../pause │                          │                   │                │
  ├───────────────►│                          │                   │                │
  │                │ auth (as above)          │                   │                │
  │                │ snapshotCache.Invalidate │                   │                │
  │                │ orchestrator.RemoveSandbox(Action=Pause) ────►                │
  │                │                          │ SandboxPause gRPC │                │
  │                │                          │ snapshotInstance  │                │
  │                │                          │ throttledUpsert ──┼───────────────►│
  │                │                          │                   │   upsert       │
  │                │                          │                   │   snapshot row │
  │                │                          ◄───────────────────┼────────────────┤
  │                │ snapshotCache.Invalidate │                   │                │
  │  200 OK        │                          │                   │                │
  │◄───────────────┤                          │                   │                │
```

> `snapshotUpsertSem` AdjustableSemaphore(§7.4)在 Pause 路径上参与限流,DB 写入并发受 LD flag `max-concurrent-snapshot-upserts` 控制。

### 6.3 gRPC `ResumeSandbox`(client-proxy 触发的 auto-resume)

```
Client        Client-Proxy            API Edge gRPC            Orchestrator
  │                │                       │                        │
  │ connect to sbx │                       │                        │
  ├───────────────►│                       │                        │
  │                │ 发现 sandbox 不在路由表                        │
  │                │ ResumeSandbox (OIDC JWT) ─────────────────────►│
  │                │                       │                        │
  │                │                       │ Verify OIDC claims     │
  │                │                       │ scope=sandbox.lifecycle│
  │                │                       │                        │
  │                │                       │ 取 snapshot            │
  │                │                       │ 验证 team              │
  │                │                       │ 检查 blocked           │
  │                │                       │                        │
  │                │                       │ HandleExistingSandbox  │
  │                │                       │   AutoResume           │
  │                │                       │  ├─ 已运行? → 返 IP    │
  │                │                       │  └─ 否则 startSandbox  │
  │                │                       │     Internal (resume)─►│
  │                │                       │                        │ VM 恢复
  │                │                       │ ◄──────────────────────┤
  │                │ ◄─────────────────────┤ {orchestrator IP}      │
  │                │                       │                        │
  │  reconnect     │                       │                        │
  │◄───────────────┤                       │                        │
```

实现:[`packages/api/internal/handlers/proxy_grpc.go:127`](../../packages/api/internal/handlers/proxy_grpc.go) 的 `SandboxService.ResumeSandbox`。

### 6.4 `GET /sandboxes`(合并 running + paused)

```
GET /sandboxes?team_id=...
  │
  ▼
sandboxes_list.go: GetSandboxes
  │
  ├──► orchestrator.GetSandboxes(ctx, teamID, states)
  │     ├── list_instances.go: 合并两个数据源
  │     │     ├──► running sandboxes from sandbox.Store (Redis 同步)
  │     │     └──► paused snapshots from DB
  │     │            └── throttledGetSnapshots (sandboxListSem 限流)
  │     │                  └── queries.GetSnapshotsWithCursor
  │     │
  │     └── 合并、按 startedAt 排序、按 cursor 分页
  │
  └──► JSON response
```

---

## 七、存储与缓存机制

### 7.1 Auth team cache

文件:[`packages/auth/pkg/auth/cache.go`](../../packages/auth/pkg/auth/cache.go)

```go
const (
    authInfoExpiration       = 5 * time.Minute
    refreshInterval          = 1 * time.Minute
    refreshTimeout           = 30 * time.Second
    authCacheRedisPrefix     = "auth:team"
)
```

底层 `cache.NewRedisCache`([`packages/shared/pkg/cache/redis.go`](../../packages/shared/pkg/cache/redis.go))提供"两级缓存 + 分布式锁 + 后台刷新":

- Redis 命中 → 返回。
- Miss → 抢分布式锁(`bsm/redislock`)→ DB callback → 回填 Redis → 释放锁。
- 后台每 1 min 异步 refresh(避免热点 key 过期雪崩)。

Key 设计:

| 路径 | Key |
| --- | --- |
| API key | `auth:team:<hashed-api-key>` |
| teamID | `auth:team:team-<teamID>` |
| user-team | `auth:team:<userID>-<teamID>` |

失效:
- `InvalidateTeamCache(teamID)` — 先查 team 的所有 API key hash,逐个 invalidate。
- `InvalidateTeamMemberCache(userID, teamID)` — 直接删 `auth:team:<userID>-<teamID>`。

### 7.2 Template cache

文件:[`packages/api/internal/cache/templates/cache.go`](../../packages/api/internal/cache/templates/cache.go)

```go
const (
    templateCacheTTL             = 5 * time.Minute
    templateCacheRefreshInterval = 1 * time.Minute
    templateCacheKeyPrefix       = "template:info"
)

// key 形如 template:info:{templateID}:tag
// Redis hash tag {} 让同 template 的所有 tag 落同一 slot(Redis Cluster 友好)
func buildCacheKey(templateID, tag string) string {
    return fmt.Sprintf("{%s}:%s", templateID, tag)
}
```

封装:
- `TemplateCache` — template + build by `(templateID, tag)`
- `AliasCache`([`alias_cache.go`](../../packages/api/internal/cache/templates/alias_cache.go))— alias → templateID
- `TemplateMetadataCache` — public flag 等
- `TemplatesBuildCache` — build 状态

失效:`InvalidateAllTags(templateID)`、`InvalidateAliasesByTemplateID(templateID)`。

### 7.3 Snapshot cache

文件:[`packages/api/internal/cache/snapshots/snapshot_cache.go`](../../packages/api/internal/cache/snapshots/snapshot_cache.go)

```go
const (
    snapshotCacheTTL             = 5 * time.Minute
    snapshotCacheRefreshInterval = 1 * time.Minute
    snapshotCacheKeyPrefix       = "snapshot:last"
)
```

缓存"某 sandbox 最后一次 snapshot"——pause / connect / resume / kill 都读它。带 `NotFound` sentinel 防穿透(避免反复查 DB 的不存在的 sandbox)。

### 7.4 Sandbox 状态存储与限流信号量

#### 7.4.1 Redis sandbox storage

[`packages/api/internal/sandbox/storage/redis/`](../../packages/api/internal/sandbox/storage/redis/):

```go
redisbackend.NewStorage(redisClient, tel.MeterProvider, featureFlags)
```

把活跃 sandbox 列表存 Redis,被 orchestrator 同步上报。启动后 `go redisStorage.Start(ctx)` 处理 pub/sub 通知。

#### 7.4.2 Reservations

[`packages/api/internal/sandbox/reservations/redis/`](../../packages/api/internal/sandbox/reservations/redis/):

```go
redisreservations.NewReservationStorage(redisClient, redisStorage.Notifier())
```

Sandbox 资源预留(placement 时占坑),防止并发 create 抢同一 node 同一资源。

#### 7.4.3 Routing catalog

[`packages/shared/pkg/sandbox-catalog/`](../../packages/shared/pkg/sandbox-catalog/):

```go
e2bcatalog.NewRedisSandboxCatalog(redisClient)
```

`sandbox → node` 路由表,client-proxy 查 sandbox 落点。

#### 7.4.4 三个 AdjustableSemaphore

```go
snapshotUpsertSem        // 限流 pause 时 snapshot upsert 并发
sandboxListSem           // 限流 GET /sandboxes 查 DB
snapshotBuildQuerySem    // 限流 snapshot build 查询
```

每个 semaphore 初始值都来自 LD flag(`MaxConcurrentSnapshotUpserts` / `MaxConcurrentSandboxListQueries` / `MaxConcurrentSnapshotBuildQueries`,默认 0 = 不限)。每 30s 由 `updateDBThrottleLimits` goroutine 重读 flag,调 `SetLimit`,无需重启。

### 7.5 Rate Limit

文件:[`packages/api/internal/middleware/ratelimit/ratelimit.go`](../../packages/api/internal/middleware/ratelimit/ratelimit.go)

```go
limiter := ratelimit.NewLimiter(redisClient)  // github.com/go-redis/redis_rate/v10
r.Use(ratelimit.Middleware(limiter, ratelimit.Config{FailOpen: true}, ff))
```

**关键设计**:

- 限流配置 **完全由 LD flag `rate-limit-config` 驱动**(JSON)。**没有 code-level 默认值**。flag 为 null 时,所有请求直接通过。
- Key:`ratelimit:<teamID>:<route>`,route 是 gin 的 `c.FullPath()`(例如 `/sandboxes/:sandboxID/pause`)。
- 行为:
  - 未鉴权请求跳过(team 未知)。
  - Redis 错误时 FailOpen(放行,不返 500)。
  - 命中返回 429,带 `Retry-After`、`RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset` 头。

flag 示例:

```json
{
  "/sandboxes/": {"rate": 50, "burst": 100, "period_s": 1},
  "/sandboxes/:sandboxID/pause": {"rate": 10, "burst": 20, "period_s": 60}
}
```

### 7.6 Redis 客户端工厂

文件:[`packages/shared/pkg/factories/redis.go`](../../packages/shared/pkg/factories/redis.go)

```go
factories.NewRedisClient(ctx, factories.RedisConfig{...})
```

支持的部署模式:

| 配置 | 用途 |
| --- | --- |
| `REDIS_URL` | 单实例 |
| `REDIS_CLUSTER_URL` | 集群(GCP Memorystore 用 Cluster Client) |
| `REDIS_TLS_CA_BASE64` | base64 编码的 CA cert |
| `REDIS_POOL_SIZE`(默认 40) | pool size |

连接生命周期:30 min max lifetime + ±10 min jitter,避免突发批量回收。

---

## 八、REST 接口完整索引

### 8.1 全部 endpoint(36 个 path 模板)

源自 [`spec/openapi.yml`](../../spec/openapi.yml) 行 1996–3782。每个 path 上的 method 与对应 handler 方法在 [`api.gen.go:11391+`](../../packages/api/internal/api/api.gen.go) 的 `ServerInterface` interface 注释里(`(GET /path)` / `(POST /path)`)。

```
GET    /health
GET    /teams
GET    /teams/{teamID}/metrics
GET    /teams/{teamID}/metrics/max

GET    /sandboxes
POST   /sandboxes
GET    /v2/sandboxes                         # V2 列表(分页 cursor)
GET    /sandboxes/metrics

GET    /sandboxes/{sandboxID}/logs
GET    /v2/sandboxes/{sandboxID}/logs
DELETE /sandboxes/{sandboxID}
GET    /sandboxes/{sandboxID}
GET    /sandboxes/{sandboxID}/metrics

POST   /sandboxes/{sandboxID}/pause
POST   /sandboxes/{sandboxID}/resume
POST   /sandboxes/{sandboxID}/connect
POST   /sandboxes/{sandboxID}/timeout
PUT    /sandboxes/{sandboxID}/network
POST   /sandboxes/{sandboxID}/refreshes
POST   /sandboxes/{sandboxID}/snapshots

GET    /snapshots

POST   /v3/templates                         # 最新构建入口
POST   /v2/templates
GET    /templates/{templateID}/files/{hash}
GET    /templates
POST   /templates                            # deprecated
GET    /templates/{templateID}
DELETE /templates/{templateID}
PATCH  /templates/{templateID}
POST   /templates/{templateID}               # deprecated
POST   /templates/{templateID}/builds/{buildID}          # deprecated
GET    /templates/{templateID}/builds/{buildID}/status
GET    /templates/{templateID}/builds/{buildID}/logs
POST   /v2/templates/{templateID}/builds/{buildID}
PATCH  /v2/templates/{templateID}

GET    /templates/tags
POST   /templates/tags
DELETE /templates/tags
GET    /templates/{templateID}/tags

GET    /templates/aliases/{alias}

GET    /nodes
GET    /nodes/{nodeID}
POST   /nodes/{nodeID}

POST   /admin/teams/{teamID}/sandboxes/kill
POST   /admin/teams/{teamID}/builds/cancel
POST   /admin/teams/{teamID}/api-keys
DELETE /admin/teams/{teamID}/api-keys/{apiKeyID}

POST   /access-tokens
DELETE /access-tokens/{accessTokenID}

GET    /api-keys
POST   /api-keys
DELETE /api-keys/{apiKeyID}
PATCH  /api-keys/{apiKeyID}

GET    /volumes
POST   /volumes
DELETE /volumes/{volumeID}
GET    /volumes/{volumeID}
```

### 8.2 Handler 文件 → endpoint 对照

所有 handler 文件在 [`packages/api/internal/handlers/`](../../packages/api/internal/handlers/),方法挂在 `*APIStore` 上。

| 文件 | 函数 | Endpoint |
| --- | --- | --- |
| `store.go` | `NewAPIStore`、`Close`、`GetHealth`、`GetTeamFromAPIKey` 等 | `/health` + auth 回调 |
| `auth.go` | `GetTeam`、`resolveTemplateAndTeam`、`applyTeamAccessCheck`、`getUserTeams`、`findTeam` | helper(被多处调用) |
| `accesstoken.go` | `PostAccessTokens`、`DeleteAccessTokensAccessTokenID` | `POST /access-tokens`、`DELETE /access-tokens/{accessTokenID}` |
| `apikey.go` | `GetApiKeys`、`PostApiKeys`、`PatchApiKeysApiKeyID`、`DeleteApiKeysApiKeyID` | `/api-keys` 系列 |
| `admin.go` | `GetNodes`、`GetNodesNodeID`、`PostNodesNodeID` | `/nodes` 系列 |
| `admin_api_keys.go` | `PostAdminTeamsTeamIDApiKeys`、`DeleteAdminTeamsTeamIDApiKeysApiKeyID` | admin 管理 team API key |
| `admin_cancel_team_builds.go` | `PostAdminTeamsTeamIDBuildsCancel` | admin 取消 team builds |
| `admin_kill_team_sandboxes.go` | `PostAdminTeamsTeamIDSandboxesKill` | admin 批量 kill team sandboxes |
| `sandbox.go` | `startSandbox`、`startSandboxInternal`、`buildCreationMetadata` | helper |
| `sandbox_create.go` | `PostSandboxes` | `POST /sandboxes` |
| `sandbox_get.go` | `GetSandboxesSandboxID`、`sandboxLifecycleToAPI`、`dbNetworkConfigToAPI` | `GET /sandboxes/{sandboxID}` |
| `sandbox_kill.go` | `DeleteSandboxesSandboxID`、`deleteSnapshot`、`throttledGetSnapshotBuilds` | `DELETE /sandboxes/{sandboxID}` |
| `sandbox_connect.go` | `PostSandboxesSandboxIDConnect` | `POST /sandboxes/{sandboxID}/connect` |
| `sandbox_pause.go` | `PostSandboxesSandboxIDPause`、`pauseHandleNotRunningSandbox` | `POST /sandboxes/{sandboxID}/pause` |
| `sandbox_resume.go` | `PostSandboxesSandboxIDResume` | `POST /sandboxes/{sandboxID}/resume` |
| `sandbox_refresh.go` | `PostSandboxesSandboxIDRefreshes` | `POST /sandboxes/{sandboxID}/refreshes` |
| `sandbox_timeout.go` | `PostSandboxesSandboxIDTimeout` | `POST /sandboxes/{sandboxID}/timeout` |
| `sandbox_network_update.go` | `PutSandboxesSandboxIDNetwork` | `PUT /sandboxes/{sandboxID}/network` |
| `sandbox_logs.go` | `GetSandboxesSandboxIDLogs`、`GetV2SandboxesSandboxIDLogs`、`getSandboxLogs` | sandbox 日志(V1 + V2) |
| `sandbox_metrics.go` | `GetSandboxesSandboxIDMetrics` | `GET /sandboxes/{sandboxID}/metrics` |
| `sandboxes_list.go` | `GetSandboxes`、`getPausedSandboxes` | `GET /sandboxes` |
| `sandboxes_list_metrics.go` | `getSandboxesMetrics`、`GetSandboxesMetrics` | `GET /sandboxes/metrics` |
| `snapshot_template_create.go` | `PostSandboxesSandboxIDSnapshots` | `POST /sandboxes/{sandboxID}/snapshots` |
| `snapshot_template_list.go` | `GetSnapshots` | `GET /snapshots` |
| `teams.go` | `GetTeams` | `GET /teams` |
| `team_metrics.go` | `GetTeamsTeamIDMetrics` | `GET /teams/{teamID}/metrics` |
| `team_metrics_max.go` | `GetTeamsTeamIDMetricsMax` | `GET /teams/{teamID}/metrics/max` |
| `template_alias.go` | `GetTemplatesAliasesAlias` | `GET /templates/aliases/{alias}` |
| `template_build_logs.go` | `GetTemplatesTemplateIDBuildsBuildIDLogs` | build 日志 |
| `template_build_status.go` | `GetTemplatesTemplateIDBuildsBuildIDStatus`、`getCorrespondingTemplateBuildStatus`、`getAPIReason`、`filterStepLogs`、`getAPILogEntry`、`apiToLogLevel` | build status |
| `template_delete.go` | `DeleteTemplatesTemplateID`、`softDeleteTemplate` | `DELETE /templates/{templateID}` |
| `template_get.go` | `GetTemplatesTemplateID` | `GET /templates/{templateID}` |
| `template_layer_files_upload.go` | `GetTemplatesTemplateIDFilesHash` | layer 文件上传预检 |
| `template_tags.go` | `PostTemplatesTags`、`DeleteTemplatesTags`、`GetTemplatesTemplateIDTags` | 模板标签管理 |
| `template_update.go` | `PatchTemplatesTemplateID`、`PatchV2TemplatesTemplateID`、`updateTemplate`、`createBackwardCompatibleAlias` | `PATCH /templates/{templateID}` |
| `template_request_build_v3.go` | `PostV3Templates`、`requestTemplateBuild` | `POST /v3/templates`(最新) |
| `templates_list.go` | `GetTemplates` | `GET /templates`(V1,deprecated) |
| `templates_list_v2.go` | `GetV2Templates` | `GET /v2/templates` |
| `deprecated_template_request_build.go` | `PostTemplates`、`PostTemplatesTemplateID`、`buildTemplate` | `POST /templates`、`POST /templates/{templateID}`(deprecated) |
| `deprecated_template_request_build_v2.go` | `PostV2Templates` | `POST /v2/templates`(deprecated,body 复用) |
| `deprecated_template_start_build.go` | `CheckAndCancelConcurrentBuilds`、`PostTemplatesTemplateIDBuildsBuildID` | `POST /templates/{templateID}/builds/{buildID}` |
| `template_start_build_v2.go` | `PostV2TemplatesTemplateIDBuildsBuildID`、`userAgentToTemplateVersion` | `POST /v2/templates/{templateID}/builds/{buildID}` |
| `timeout_helper.go` | `calculateTimeoutSeconds`、`calculateAutoResumeTimeout` | helper |
| `volume_create.go` | `PostVolumes`、`getVolumeType`、`isValidVolumeName`、`createVolume` | `POST /volumes` |
| `volume_delete.go` | `DeleteVolumesVolumeID`、`deleteVolume` | `DELETE /volumes/{volumeID}` |
| `volume_get.go` | `GetVolumesVolumeID` | `GET /volumes/{volumeID}` |
| `volume_token.go` | `generateVolumeContentToken` | helper(volume content JWT 签发) |
| `volume_util.go` | `executeOnOrchestratorByClusterID` 等 | helper |
| `volumes_list.go` | `GetVolumes` | `GET /volumes` |
| `proxy_grpc.go` | `SandboxService.ResumeSandbox` 等、`NewSandboxService` | gRPC(不是 REST) |

### 8.3 OpenAPI 生成

spec:[`spec/openapi.yml`](../../spec/openapi.yml)(3817 行)。

生成配置 [`packages/api/internal/api/cfg.yaml`](../../packages/api/internal/api/cfg.yaml):

```yaml
package: api
output: api.gen.go
generate:
  client: true          # 同时生成 Client / ClientInterface(用于 SDK / 测试)
  gin-server: true      # 用 gin 作为 server 框架
  embedded-spec: true   # 把 spec 内容 embed 进 .gen.go(运行时 GetSwagger())
  models: true          # 生成所有 schema 类型
```

触发方式([`packages/api/internal/api/generate.go`](../../packages/api/internal/api/generate.go)):

```go
//go:generate go tool github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen -config ./cfg.yaml ../../../../spec/openapi.yml
```

`make generate` 后产物是单文件 [`api.gen.go`](../../packages/api/internal/api/api.gen.go)(14049 行)。

### 8.4 错误响应统一格式

文件:[`packages/shared/pkg/apierrors/apierrors.go`](../../packages/shared/pkg/apierrors/apierrors.go)

```go
type APIError struct {
    Err       error
    ClientMsg string
    Code      int
}

func SendAPIStoreError(c *gin.Context, code int, message string) {
    c.Error(errors.New(message))           // 写到 gin ctx,会被 logging middleware 捕获
    c.JSON(code, gin.H{"code": int32(code), "message": message})
}
```

OpenAPI validator 的错误走 `utils.ErrorHandler`([`packages/api/internal/utils/error.go:24`](../../packages/api/internal/utils/error.go))和 `utils.MultiErrorHandler`(行 95):

- `openapi3.MultiError` 拆开逐个处理。
- 识别 `TeamForbiddenError`、`TeamBlockedError` 等业务错误。
- `max(writer.status, fallbackStatusCode)` 防止已 401 的响应被 oapi-codegen 默认 400 fallback 覆盖。

### 8.5 Blocked team 白名单

文件:[`packages/api/internal/middleware/blocked_team.go`](../../packages/api/internal/middleware/blocked_team.go)

被 block 的 team 不能走写入路由,但以下只读路径放行(按 method + gin route pattern `c.FullPath()` 组织):

- **GET**:`/api-keys`、`/sandboxes`、`/sandboxes/metrics`、`/sandboxes/:sandboxID`(及子路径)、`/snapshots`、`/teams/:teamID/metrics`(含 `/max`)、`/templates` 列表/详情/build logs/status、`/v2/sandboxes`、`/v2/templates`、`/volumes` 等。
- **DELETE**:`/sandboxes/:sandboxID`、`/templates/:templateID`、`/templates/tags`、`/volumes/:volumeID`、`/api-keys/:apiKeyID`。

实现:`auth.EnforceBlockedTeam(allowlist)`([`packages/auth/pkg/auth/team_middleware.go:59`](../../packages/auth/pkg/auth/team_middleware.go))。无 team 在 ctx 的请求(admin / access-token 路径)直接 `c.Next()`。

`CheckTeamAccessForRoute(c, team)` 用作"延迟解析 team"路径的复检([`handlers/auth.go:21`](../../packages/api/internal/handlers/auth.go))。

---

## 九、gRPC 接口

API 同时是 gRPC server(被 client-proxy 调用)和 gRPC client(调用 orchestrator / template-manager)。

### 9.1 gRPC server 端

构造:`e2bgrpc.NewGRPCServer(tel)`([`packages/shared/pkg/grpc/server.go:33`](../../packages/shared/pkg/grpc/server.go))装好 `otelgrpc` stats handler、keepalive、recovery、logging interceptor。

两个 listener:

| Server | 端口 | 强制 OIDC | 实现 |
| --- | --- | --- | --- |
| Internal | 5009 | 否 | `handlers.NewSandboxService(apiStore, false, nil)` |
| Edge | 5109 | 是 | `handlers.NewSandboxService(apiStore, true, clientProxyOAuthVerifier)` |

注册的服务:`proxygrpc.SandboxServiceServer`,实现是 [`handlers/proxy_grpc.go`](../../packages/api/internal/handlers/proxy_grpc.go) 的 `SandboxService`。

主要方法(以 `ResumeSandbox` 为例):

```go
func (s *SandboxService) ResumeSandbox(ctx, req) (*Resp, error) {
    // 1. 验证 OIDC claims(scope = sandbox.lifecycle)
    // 2. 取 snapshot
    // 3. 验证 team
    // 4. 检查 blocked
    // 5. HandleExistingSandboxAutoResume
    //    - 若已在运行:直接返 orchestrator IP
    //    - 否则:startSandboxInternal 走 resume 路径
    // 6. 返回 orchestrator IP
}
```

### 9.2 gRPC client 端(调 orchestrator)

文件:[`packages/api/internal/orchestrator/orchestrator.go`](../../packages/api/internal/orchestrator/orchestrator.go)

`Orchestrator` 结构(行 45-84):

```go
type Orchestrator struct {
    httpClient         *http.Client                  // node 健康检查
    nodeDiscovery      discovery.Discovery           // 列出运行中的 orchestrator 实例
    sandboxStore       *sandbox.Store                // 本地 sandbox 状态镜像
    nodes              *smap.Map[*nodemanager.Node]  // 已连接的 node pool
    placementAlgorithm *placement.BestOfK            // 调度算法
    featureFlagsClient *featureflags.Client
    analytics          *analyticscollector.Analytics
    posthogClient      *analyticscollector.PosthogClient
    routingCatalog     e2bcatalog.SandboxesCatalog
    sqlcDB             *sqlcdb.Client
    tel                *telemetry.Client
    clusters           *clusters.Pool
    connectGroup       singleflight.Group            // 同 node 并发连接去重
    discoveryGroup     singleflight.Group            // 同 node 并发发现去重
    // ...
}
```

主要方法(分布在不同文件):

| 方法 | 文件 | 入口 handler |
| --- | --- | --- |
| `CreateSandbox` | `create_instance.go` | `PostSandboxes` |
| `RemoveSandbox(Action=Kill)` | `delete_instance.go` | `DeleteSandboxesSandboxID` |
| `RemoveSandbox(Action=Pause)` | `delete_instance.go` → `pause_instance.go` | `PostSandboxesSandboxIDPause` |
| `GetSandbox` | `get_instance.go` | `GetSandboxesSandboxID` |
| `GetSandboxes` | `list_instances.go` | `GetSandboxes` |
| `KeepAliveFor` | `keep_alive.go` | `PostSandboxesSandboxIDRefreshes` / `.../Timeout` |
| `HandleExistingSandboxAutoResume` | `autoresume.go` | gRPC `ResumeSandbox` |

**Sandbox 启动路径**(`create_instance.go`):
1. handler `PostSandboxes` → `startSandbox` → `startSandboxInternal` → `a.orchestrator.CreateSandbox(ctx, sandboxID, executionID, team, getSandboxData, startTime, endTime, timeout, isResume, creationMeta)`。
2. `CreateSandbox` 内部:placement 选 node → 构造 `orchestrator.SandboxCreateRequest`(含 egress / network / volume mounts / envd access token)→ `node.GetClient().Sandbox.SandboxCreate(ctx, req)`。

**Sandbox 暂停路径**(`pause_instance.go`):
1. handler `PostSandboxesSandboxIDPause` → `a.orchestrator.RemoveSandbox(ctx, teamID, sandboxID, RemoveOpts{Action: sandbox.StateActionPause})`。
2. 内部分发到 `pauseSandbox`(行 32)→ gRPC `SandboxPause` → `snapshotInstance`(行 89)→ `throttledUpsertSnapshot`(经 `snapshotUpsertSem`)→ DB upsert → `snapshotCache.Invalidate`。
3. 命中"已在 pausing"等过渡态返回 `PauseQueueExhaustedError`。

### 9.3 gRPC client 端(调 template-manager)

文件:[`packages/api/internal/template-manager/template_manager.go`](../../packages/api/internal/template-manager/template_manager.go)

不直接持有 gRPC conn,而是通过 `clusters.Pool` 拿 cluster → `cluster.GetAvailableTemplateBuilder(ctx, machineInfo)` → `instance.GetClient().Template`(`GRPCClient.Template`,[`clusters/client.go:18`](../../packages/api/internal/clusters/client.go))。

主要调用:

| 入口 | 流程 |
| --- | --- |
| `PostV3Templates` | `template.RegisterBuild`(写 DB),实际 build gRPC 调用在 `PostV2TemplatesTemplateIDBuildsBuildID` |
| `PostV2TemplatesTemplateIDBuildsBuildID` | gRPC `TemplateStartBuild` 到 builder node |
| `template_layer_files_upload.go` | gRPC layer 文件预检 / 上传 |
| `tm.BuildsStatusPeriodicalSync`(后台) | 每分钟拉 `GetInProgressTemplateBuilds`,对每个 build 调 `BuildStatusSync` |

---

## 十、配置与环境变量

### 10.1 配置文件位置

| 文件 | 内容 |
| --- | --- |
| [`packages/api/internal/cfg/model.go`](../../packages/api/internal/cfg/model.go) | env var → struct 的解析(用 `caarlos0/env/v11`) |
| `.env.template` | 仓库内未找到(只有 [`tests/.env.template`](../../tests/.env.template) 一行 `E2B_API_KEY=`,与 API 运行配置无关) |
| `.env.{prod,staging,dev}` | 被 gitignore,通过 Terraform → GCP/AWS Secret Manager → Nomad env 注入 |
| [`iac/modules/job-api/jobs/api.hcl`](../../iac/modules/job-api/jobs/api.hcl) | Nomad job 模板,`env` stanza 注入运行时变量 |

### 10.2 环境变量完整清单

#### 通用 / 鉴权

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_TOKEN` | — | Admin token,用于 `AdminApiKeyAuth` |
| `AUTH_PROVIDER_CONFIG` | — | JSON,`{"jwt": [oidc.Config]}`,见 §5.3.3 |
| `SANDBOX_ACCESS_TOKEN_HASH_SEED` | — | sandbox access token hash seed |

#### 数据库

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `POSTGRES_CONNECTION_STRING` | (required,notEmpty) | 主业务 DB DSN |
| `DB_MAX_OPEN_CONNECTIONS` | 40 | pgxpool max |
| `DB_MIN_IDLE_CONNECTIONS` | 5 | pgxpool min idle |
| `AUTH_DB_CONNECTION_STRING` | (空 → 复用 `POSTGRES_CONNECTION_STRING`) | auth DB 主库 |
| `AUTH_DB_READ_REPLICA_CONNECTION_STRING` | — | auth DB 读副本 |
| `AUTH_DB_MIN_IDLE_CONNECTIONS` | 5 | |
| `AUTH_DB_MAX_OPEN_CONNECTIONS` | 20 | |

#### ClickHouse

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `CLICKHOUSE_CONNECTION_STRING` | — | 单 DSN,空时切换 client 退化为 noop |
| `CLICKHOUSE_CONNECTION_STRINGS` | — | `;` 分隔,被 LD flag `clickhouse-read-endpoint` 索引 |

#### Redis

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `REDIS_URL` | — | 单实例 |
| `REDIS_CLUSTER_URL` | — | 集群(优先) |
| `REDIS_TLS_CA_BASE64` | — | base64 CA cert |
| `REDIS_POOL_SIZE` | 40 | pool size |

#### Loki

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `LOKI_URL` | (required) | Loki query endpoint |
| `LOKI_USER` | — | |
| `LOKI_PASSWORD` | — | |

#### 服务发现

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `SERVICE_DISCOVERY_PROVIDER` | `nomad` | `nomad` / `kubernetes` / `local` |
| `NOMAD_ADDRESS` | `http://localhost:4646` | |
| `NOMAD_TOKEN` | — | |
| `NOMAD_ORCHESTRATOR_SERVICE_NAMES` | `orchestrator` | `,` 分割 |
| `NOMAD_ORCHESTRATOR_LEGACY_DISCOVERY_ENABLED` | `true` | 是否合并 legacy node-pool discovery |
| `LOCAL_ORCHESTRATOR_ADDRESS` | `127.0.0.1:5008` | 仅 `local` 模式 |
| `K8S_NAMESPACE` | `default` | |
| `K8S_ORCHESTRATOR_POD_LABEL_SELECTOR` | `app.kubernetes.io/name=orchestrator` | |
| `K8S_TEMPLATE_MANAGER_POD_LABEL_SELECTOR` | `app.kubernetes.io/name=template-manager` | |

#### gRPC / Edge

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `API_INTERNAL_GRPC_PORT` | 5009 | internal gRPC |
| `API_EDGE_GRPC_PORT` | 5109 | edge gRPC(对外,OIDC) |
| `CLIENT_PROXY_OIDC_ISSUER_URL` | — | client-proxy OIDC issuer,空则全部 edge gRPC 请求被拒 |

#### Volumes Token

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `VOLUME_TOKEN_ENABLED` | `true` | 关掉后允许缺其他 `VOLUME_TOKEN_*` |
| `VOLUME_TOKEN_ISSUER` | — | JWT issuer |
| `VOLUME_TOKEN_SIGNING_METHOD` | — | 如 `ES256`、`RS256`、`HS256`、`EdDSA` |
| `VOLUME_TOKEN_SIGNING_KEY` | — | 格式 `<TYPE>:base64(<PEM>)`,如 `ECDSA:LS0t...` |
| `VOLUME_TOKEN_SIGNING_KEY_NAME` | — | key name(用于 kid header) |
| `VOLUME_TOKEN_DURATION` | `1h` | token TTL |
| `DEFAULT_PERSISTENT_VOLUME_TYPE` | — | 后备 volume 类型(flag `default-persistent-volume-type` 优先) |

#### 其他

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `ANALYTICS_COLLECTOR_API_TOKEN` | — | analytics gRPC API key |
| `ANALYTICS_COLLECTOR_HOST` | — | analytics gRPC host |
| `POSTHOG_API_KEY` | — | Posthog |
| `DOMAIN_NAME` | — | 部署域名,作为 LD deployment context |
| `LAUNCH_DARKLY_API_KEY` | — | 缺则用 offline test data |
| `OTEL_COLLECTOR_GRPC_ENDPOINT` | — | 缺则 telemetry 走 noop |
| `NODE_ID` | (required) | Nomad 注入 `$${node.unique.id}` |
| `ENVIRONMENT` | `prod` | `local`/`dev`/`prod`,影响部分 flag 默认值 |
| `E2B_DEBUG` | `false` | 调试模式 |
| `PPROF_PORT` | 6060 | |
| `ENVD_TIMEOUT` | 10s | 仅作为 `envd-timeout-milliseconds` flag 的 fallback |
| `DEFAULT_FIRECRACKER_VERSION` | — | 同上,作为 `build-firecracker-version` fallback |
| `DEFAULT_KERNEL_VERSION` | — | 同上 |
| `LOGS_COLLECTOR_ADDRESS` | — | sandbox 日志 collector |

### 10.3 cfg.Parse 逻辑

[`cfg/model.go:240`](../../packages/api/internal/cfg/model.go):

- 用 `caarlos0/env/v11` 的 `ParseAsWithOptions`,带自定义 parser FuncMap:
  - `auth.ProviderConfig` — JSON 解析。
  - `JWTSigningKey` — 解析 `<TYPE>:base64(<PEM>)`,支持 ECDSA / RSA / HMAC / ED25519。
  - `jwt.SigningMethod` — 按 name 从 jwt 库查。
- 后处理:`AuthDBConnectionString` 缺省时复用 `PostgresConnectionString`。
- 校验 `SERVICE_DISCOVERY_PROVIDER` 必须是 `nomad` / `kubernetes` / `local` 之一,否则返 `FailureError{Condition: FailureConditionInvalidServiceDiscoveryProvider}`。
- 校验 `VolumesToken.validate()`:启用时必须四件套齐全(Issuer / SigningMethod / SigningKey / SigningKeyName)。

---

## 十一、Feature Flags

### 11.1 LaunchDarkly 客户端

文件:[`packages/shared/pkg/featureflags/client.go`](../../packages/shared/pkg/featureflags/client.go)

- `NewClient()`(行 58):`LAUNCH_DARKLY_API_KEY` 设了用真 LD;否则用 `ldtestdata.dataSource()`(offline 测试数据源,默认 fallback 值)。**本地开发零配置就能跑。**
- 类型:`BoolFlag`、`IntFlag`、`JSONFlag`、`StringFlag`。
- 自动注入 context:`deploymentName`(`SetDeploymentName`)、`serviceName`(`SetServiceName`)、`RegisterContextProvider` 注册的 provider。
- `WatchJSONFlag`(行 121)— 订阅 flag 变化,实时响应。

LD context kinds(在 [`flags.go`](../../packages/shared/pkg/featureflags/flags.go)):`sandbox`、`team`、`user`、`cluster`、`deployment`、`tier`、`service`、`template`、`volume`、`compress-file-type`、`compress-use-case`。

### 11.2 Context 注入(API 侧)

文件:[`packages/api/internal/middleware/launchdarkly.go`](../../packages/api/internal/middleware/launchdarkly.go)

中间件 `InitLaunchDarklyContext`:

1. 从 gin ctx 取 team → `featureflags.TeamContextWithName(team.ID, team.Name)` + `ClusterContext(realClusterID)` + `TierContext(team.Tier, team.Tier)`,合成 multi-context。
2. 从 gin ctx 取 userID → `UserContext(userID.String())`。
3. 调 `featureflags.AddToContext(ctx, contexts...)` 把 LD context 塞进 `ctx`。

**必须**在 auth 之后、handler 之前运行。否则 ctx 里没 team 信息。

### 11.3 主要 flag 列表

文件:[`packages/shared/pkg/featureflags/flags.go`](../../packages/shared/pkg/featureflags/flags.go)

#### Bool flags(节选)

| Flag | 默认 | 用途 |
| --- | --- | --- |
| `use-nfs-for-snapshots` / `use-nfs-for-templates` / `use-nfs-for-building-templates` | false | storage backend 选择 |
| `write-to-cache-on-writes` | false | 写时缓存 |
| `create-storage-cache-spans` | false | storage cache tracing |
| `orch-accepts-combined-host` | false | orchestrator 接受合并 host |
| `storage-soft-delete-check` / `storage-soft-delete-enforce` | false / false | soft delete |
| `use-memfd` / `memfd-background-copy` | false / false | memfd 支持 |
| `peer-to-peer-chunk-transfer` / `peer-to-peer-async-checkpoint` | false / false | P2P |
| `can-use-persistent-volumes` | false | 持久化卷 |
| `sandbox-label-based-scheduling` / `sandbox-volume-label-based-scheduling` | false / false | label 调度 |
| `sandbox-placement-optimistic-resource-accounting` | false | 乐观资源计费 |
| `free-page-reporting` / `collapse-envd-heap` | false / false | 内存优化 |
| `network-transform-rules` | false | 网络规则转换 |
| `byop-proxy-enabled` | false | BYOP |
| `resume-origin-node-remap` | false | resume 时重映射到 origin node |
| `expiration-index-healer` | **true** | 过期索引自愈 |
| `disable-e2b-access-token-provisioning` | false | 启用后 `POST /access-tokens` 返 410 Gone |
| `clickhouse-write-fanout` | false | CH 写扇出 |
| `header-v5-write` / `v4-header-for-uncompressed` | false / false | header 版本 |
| `freeze-user-cgroup` | false | 冻结用户 cgroup |
| `pause-resume-prefetch-harvest` / `pause-resume-prefetch-consume` | false / false | pause/resume 预取 |
| `nbd-async-write-zeroes` | false | NBD 异步写零 |

#### Int flags(节选)

| Flag | 默认 | 用途 |
| --- | --- | --- |
| `max-sandboxes-per-node` | 200 | 每 node sandbox 上限 |
| `gcloud-concurrent-upload-limit` | 8 | GCS 并发上传 |
| `gcloud-max-tasks` | 16 | GCS 任务数 |
| `clickhouse-batcher-max-batch-size` / `-max-delay` / `-queue-size` | | CH batcher |
| `best-of-k-sample-size` | 3 | K |
| `best-of-k-max-overcommit` | 400 | R = 4× |
| `best-of-k-alpha` | 50 | α = 0.5 |
| `envd-init-request-timeout-milliseconds` | 50 | envd 初始化超时 |
| `envd-timeout-milliseconds` | 10000(fallback `ENVD_TIMEOUT`) | envd 超时 |
| `guest-sync-timeout-milliseconds` | | guest sync 超时 |
| `max-cache-writer-concurrency` | 10 | cache writer 并发 |
| `build-cache-max-usage-percentage` | 85 | build cache 用量 |
| `build-provision-version` | | provision 版本 |
| `nbd-connections-per-device` | 1 | NBD 连接数 |
| `memory-prefetch-max-fetch-workers` / `-max-copy-workers` | 16 / 8 | 内存预取 |
| `pause-resume-prefetch-harvest-timeout-ms` | 15000 | 预取 harvest 超时 |
| `tcpfirewall-max-connections-per-sandbox` | -1(不限) | TCP firewall |
| `sandbox-max-incoming-connections` | -1(不限) | 入连接数 |
| `build-base-rootfs-size-limit-mb` | 25000 | base rootfs 大小 |
| `minimum-autoresume-timeout` | 300 | auto resume 最小超时 |
| `build-reserved-disk-space-mb` | 256 | 预留磁盘 |
| `max-starting-instances-per-node` | 3 | 每 node starting 上限 |
| `max-concurrent-evictions` | 256 | eviction 并发 |
| `max-concurrent-snapshot-upserts` / `-sandbox-list-queries` / `-snapshot-build-queries` | 0(不限) | 三个 AdjustableSemaphore |
| `min-chunker-read-size-kb` | 16 | chunker 读 |
| `max-parallel-build-read-segments` | 1 | 并发 build 读 |
| `collapse-envd-heap-timeout-ms` | 10000 | envd heap collapse 超时 |

#### String flags

| Flag | 默认 | 用途 |
| --- | --- | --- |
| `build-firecracker-version` | `DEFAULT_FIRECRACKER_VERSION` env,否则 `v1.14.1_431f1fc` | Firecracker 版本 |
| `build-kernel-version` | `vmlinux-6.1.158` | 内核版本 |
| `build-io-engine` | `Sync` | IO 引擎 |
| `default-persistent-volume-type` | (空) | 后备 volume 类型 |
| `clickhouse-read-endpoint` | (空) | CH 切换 endpoint |

#### JSON flags

| Flag | 用途 |
| --- | --- |
| `clean-nfs-cache` | NFS cache 清理 |
| `rate-limit-config` | 见 §7.5 |
| `memfile-diff-dedup` | memfile diff 去重 |
| `compress-config` | 压缩配置 |
| `tcpfirewall-egress-throttle-config` | TCP firewall egress |
| `block-drive-throttle-config` | block drive throttle |
| `tracked-templates-for-metrics` | 限制 metric cardinality |
| `guest-pause-reclaim` | guest pause 回收 |
| `free-page-hinting-config` | free page hinting |
| `firecracker-versions` | version alias map |
| `preferred-build-node` | 优先 build node |

---

## 十二、关键代码文件索引

按目录组织,所有路径相对仓库根。

### 12.1 入口与配置

| 文件 | 主节 |
| --- | --- |
| [`packages/api/main.go`](../../packages/api/main.go) | §1, §4.3, §5.1 |
| [`packages/api/Makefile`](../../packages/api/Makefile) | §1.4, §5.5 |
| [`packages/api/Dockerfile`](../../packages/api/Dockerfile) | §13.3 |
| [`packages/api/docker-bake.hcl`](../../packages/api/docker-bake.hcl) | §13.3 |
| [`packages/api/.air.toml`](../../packages/api/.air.toml) | §1.4 |
| [`packages/api/internal/cfg/model.go`](../../packages/api/internal/cfg/model.go) | §10 |

### 12.2 OpenAPI 生成

| 文件 | 主节 |
| --- | --- |
| [`packages/api/internal/api/api.gen.go`](../../packages/api/internal/api/api.gen.go) | §3.4, §8.3 |
| [`packages/api/internal/api/cfg.yaml`](../../packages/api/internal/api/cfg.yaml) | §8.3 |
| [`packages/api/internal/api/generate.go`](../../packages/api/internal/api/generate.go) | §8.3 |
| [`packages/api/internal/api/error.go`](../../packages/api/internal/api/error.go) | §8.4 |
| [`packages/api/internal/api/spec_test.go`](../../packages/api/internal/api/spec_test.go) | §5.2 |
| [`spec/openapi.yml`](../../spec/openapi.yml) | §8.3 |

### 12.3 Handler 层

| 文件 | 主节 |
| --- | --- |
| [`packages/api/internal/handlers/store.go`](../../packages/api/internal/handlers/store.go) | §4.2 |
| [`packages/api/internal/handlers/auth.go`](../../packages/api/internal/handlers/auth.go) | §8.2 |
| [`packages/api/internal/handlers/apikey.go`](../../packages/api/internal/handlers/apikey.go) | §8.2 |
| [`packages/api/internal/handlers/accesstoken.go`](../../packages/api/internal/handlers/accesstoken.go) | §8.2 |
| [`packages/api/internal/handlers/admin*.go`](../../packages/api/internal/handlers/) | §8.2 |
| [`packages/api/internal/handlers/sandbox*.go`](../../packages/api/internal/handlers/) | §8.2, §9.2 |
| [`packages/api/internal/handlers/sandboxes_list.go`](../../packages/api/internal/handlers/sandboxes_list.go) | §8.2, §9.2 |
| [`packages/api/internal/handlers/snapshot_template_*.go`](../../packages/api/internal/handlers/) | §8.2 |
| [`packages/api/internal/handlers/template*.go`](../../packages/api/internal/handlers/) | §8.2 |
| [`packages/api/internal/handlers/volume*.go`](../../packages/api/internal/handlers/) | §8.2 |
| [`packages/api/internal/handlers/teams.go`](../../packages/api/internal/handlers/teams.go) | §8.2 |
| [`packages/api/internal/handlers/team_metrics*.go`](../../packages/api/internal/handlers/) | §8.2 |
| [`packages/api/internal/handlers/proxy_grpc.go`](../../packages/api/internal/handlers/proxy_grpc.go) | §9.1 |

### 12.4 中间件

| 文件 | 主节 |
| --- | --- |
| [`packages/api/internal/middleware/blocked_team.go`](../../packages/api/internal/middleware/blocked_team.go) | §8.5 |
| [`packages/api/internal/middleware/launchdarkly.go`](../../packages/api/internal/middleware/launchdarkly.go) | §11.2 |
| [`packages/api/internal/middleware/ratelimit/ratelimit.go`](../../packages/api/internal/middleware/ratelimit/ratelimit.go) | §7.5 |
| [`packages/api/internal/oauth/oauth.go`](../../packages/api/internal/oauth/oauth.go) | §9.1 |

### 12.5 Orchestrator 客户端

| 文件 | 主节 |
| --- | --- |
| [`packages/api/internal/orchestrator/orchestrator.go`](../../packages/api/internal/orchestrator/orchestrator.go) | §9.2 |
| [`packages/api/internal/orchestrator/client.go`](../../packages/api/internal/orchestrator/client.go) | §4.7 |
| [`packages/api/internal/orchestrator/discovery/discovery.go`](../../packages/api/internal/orchestrator/discovery/discovery.go) | §4.6 |
| [`packages/api/internal/orchestrator/discovery/nomad.go`](../../packages/api/internal/orchestrator/discovery/nomad.go) | §4.6 |
| [`packages/api/internal/orchestrator/discovery/nomad_node_pool.go`](../../packages/api/internal/orchestrator/discovery/nomad_node_pool.go) | §4.6 |
| [`packages/api/internal/orchestrator/discovery/kubernetes.go`](../../packages/api/internal/orchestrator/discovery/kubernetes.go) | §4.6 |
| [`packages/api/internal/orchestrator/discovery/local.go`](../../packages/api/internal/orchestrator/discovery/local.go) | §4.6 |
| [`packages/api/internal/orchestrator/discovery/merged.go`](../../packages/api/internal/orchestrator/discovery/merged.go) | §4.6 |
| [`packages/api/internal/orchestrator/placement/placement_best_of_K.go`](../../packages/api/internal/orchestrator/placement/placement_best_of_K.go) | §4.8 |
| [`packages/api/internal/orchestrator/placement/cpu_compatibility.go`](../../packages/api/internal/orchestrator/placement/cpu_compatibility.go) | §4.8 |
| [`packages/api/internal/orchestrator/placement/label_compatibility.go`](../../packages/api/internal/orchestrator/placement/label_compatibility.go) | §4.8 |
| [`packages/api/internal/orchestrator/create_instance.go`](../../packages/api/internal/orchestrator/create_instance.go) | §9.2 |
| [`packages/api/internal/orchestrator/delete_instance.go`](../../packages/api/internal/orchestrator/delete_instance.go) | §9.2 |
| [`packages/api/internal/orchestrator/pause_instance.go`](../../packages/api/internal/orchestrator/pause_instance.go) | §9.2 |
| [`packages/api/internal/orchestrator/keep_alive.go`](../../packages/api/internal/orchestrator/keep_alive.go) | §9.2 |
| [`packages/api/internal/orchestrator/autoresume.go`](../../packages/api/internal/orchestrator/autoresume.go) | §9.2 |
| [`packages/api/internal/orchestrator/list_instances.go`](../../packages/api/internal/orchestrator/list_instances.go) | §9.2 |

### 12.6 集群与 template-manager

| 文件 | 主节 |
| --- | --- |
| [`packages/api/internal/clusters/client.go`](../../packages/api/internal/clusters/client.go) | §9.3 |
| [`packages/api/internal/clusters/cluster.go`](../../packages/api/internal/clusters/cluster.go) | §4.9 |
| [`packages/api/internal/clusters/instance.go`](../../packages/api/internal/clusters/instance.go) | §4.9 |
| [`packages/api/internal/clusters/resources.go`](../../packages/api/internal/clusters/resources.go) | §4.9 |
| [`packages/api/internal/template-manager/template_manager.go`](../../packages/api/internal/template-manager/template_manager.go) | §9.3 |

### 12.7 缓存与 Redis

| 文件 | 主节 |
| --- | --- |
| [`packages/api/internal/cache/templates/cache.go`](../../packages/api/internal/cache/templates/cache.go) | §7.2 |
| [`packages/api/internal/cache/templates/alias_cache.go`](../../packages/api/internal/cache/templates/alias_cache.go) | §7.2 |
| [`packages/api/internal/cache/snapshots/snapshot_cache.go`](../../packages/api/internal/cache/snapshots/snapshot_cache.go) | §7.3 |
| [`packages/api/internal/sandbox/storage/redis/`](../../packages/api/internal/sandbox/storage/redis/) | §7.4.1 |
| [`packages/api/internal/sandbox/reservations/redis/`](../../packages/api/internal/sandbox/reservations/redis/) | §7.4.2 |
| [`packages/shared/pkg/cache/redis.go`](../../packages/shared/pkg/cache/redis.go) | §7.1 |
| [`packages/shared/pkg/factories/redis.go`](../../packages/shared/pkg/factories/redis.go) | §7.6 |
| [`packages/shared/pkg/sandbox-catalog/`](../../packages/shared/pkg/sandbox-catalog/) | §7.4.3 |

### 12.8 Auth 包

| 文件 | 主节 |
| --- | --- |
| [`packages/auth/pkg/auth/consts.go`](../../packages/auth/pkg/auth/consts.go) | §5.2 |
| [`packages/auth/pkg/auth/gin.go`](../../packages/auth/pkg/auth/gin.go) | §5.2 |
| [`packages/auth/pkg/auth/middleware.go`](../../packages/auth/pkg/auth/middleware.go) | §5.2 |
| [`packages/auth/pkg/auth/service.go`](../../packages/auth/pkg/auth/service.go) | §5.3 |
| [`packages/auth/pkg/auth/verifier.go`](../../packages/auth/pkg/auth/verifier.go) | §5.3.3 |
| [`packages/auth/pkg/auth/cache.go`](../../packages/auth/pkg/auth/cache.go) | §7.1 |
| [`packages/auth/pkg/auth/identity_lookup.go`](../../packages/auth/pkg/auth/identity_lookup.go) | §5.3.3 |
| [`packages/auth/pkg/auth/team_middleware.go`](../../packages/auth/pkg/auth/team_middleware.go) | §8.5 |
| [`packages/auth/pkg/auth/oidc/`](../../packages/auth/pkg/auth/oidc/) | §5.3.3 |
| [`packages/auth/pkg/types/teams.go`](../../packages/auth/pkg/types/teams.go) | §3.4 |

### 12.9 DB / ClickHouse

| 文件 | 主节 |
| --- | --- |
| [`packages/db/client/client.go`](../../packages/db/client/client.go) | §3.1 |
| [`packages/db/pkg/auth/client.go`](../../packages/db/pkg/auth/client.go) | §3.2 |
| [`packages/db/pkg/pool/`](../../packages/db/pkg/pool/) | §3.1 |
| [`packages/db/queries/`](../../packages/db/queries/) | §3.1 |
| [`packages/db/pkg/auth/queries/`](../../packages/db/pkg/auth/queries/) | §3.2 |
| [`packages/db/pkg/dberrors/dberrors.go`](../../packages/db/pkg/dberrors/dberrors.go) | §8.4 |
| [`packages/clickhouse/pkg/clickhouse.go`](../../packages/clickhouse/pkg/clickhouse.go) | §3.3 |
| [`packages/clickhouse/pkg/switcher.go`](../../packages/clickhouse/pkg/switcher.go) | §3.3 |

### 12.10 Telemetry / 日志 / pprof

| 文件 | 主节 |
| --- | --- |
| [`packages/shared/pkg/telemetry/main.go`](../../packages/shared/pkg/telemetry/main.go) | §15.3 |
| [`packages/shared/pkg/telemetry/pprof.go`](../../packages/shared/pkg/telemetry/pprof.go) | §15.4 |
| [`packages/shared/pkg/telemetry/tracing.go`](../../packages/shared/pkg/telemetry/tracing.go) | §15.3 |
| [`packages/shared/pkg/telemetry/fields.go`](../../packages/shared/pkg/telemetry/fields.go) | §15.3 |
| [`packages/shared/pkg/logger/logger.go`](../../packages/shared/pkg/logger/logger.go) | §15.3 |
| [`packages/shared/pkg/logger/sandbox/`](../../packages/shared/pkg/logger/sandbox/) | §15.3 |
| [`packages/shared/pkg/env/env.go`](../../packages/shared/pkg/env/env.go) | §4.3 |

### 12.11 部署

| 文件 | 主节 |
| --- | --- |
| [`iac/modules/job-api/main.tf`](../../iac/modules/job-api/main.tf) | §13.2 |
| [`iac/modules/job-api/variables.tf`](../../iac/modules/job-api/variables.tf) | §13.2 |
| [`iac/modules/job-api/jobs/api.hcl`](../../iac/modules/job-api/jobs/api.hcl) | §13.1 |
| [`iac/provider-gcp/nomad/main.tf`](../../iac/provider-gcp/nomad/main.tf) | §13.2 |
| [`iac/provider-gcp/variables.tf`](../../iac/provider-gcp/variables.tf) | §13.2 |
| [`iac/provider-aws/nomad/main.tf`](../../iac/provider-aws/nomad/main.tf) | §13.2 |
| [`iac/provider-aws/nomad/variables.tf`](../../iac/provider-aws/nomad/variables.tf) | §13.2 |

### 12.12 测试

| 文件 | 主节 |
| --- | --- |
| [`packages/api/internal/handlers/*_test.go`](../../packages/api/internal/handlers/) | §15.2 |
| [`packages/api/internal/api/spec_test.go`](../../packages/api/internal/api/spec_test.go) | §5.2 |
| [`packages/api/internal/handlers/mocks/`](../../packages/api/internal/handlers/mocks/) | §15.2 |
| [`tests/integration/Makefile`](../../tests/integration/Makefile) | §15.2 |
| [`tests/integration/internal/setup/`](../../tests/integration/internal/setup/) | §15.2 |
| [`tests/integration/internal/tests/api/`](../../tests/integration/internal/tests/api/) | §15.2 |

---

## 十三、设计要点与演进历史

### 13.1 设计要点(必读)

1. **`requestTimeout` vs `WriteTimeout`**([`main.go:64-68`](../../packages/api/main.go)):Go 的 `http.Server.WriteTimeout` 不会取消 `r.Context()`([golang/go#59602](https://github.com/golang/go/issues/59602)),必须额外用 middleware 注入 deadline。
2. **`shutdownDrainWait = 15s` + LB drain**:关停时先让 `/health` 返 503、等 15s,再开始 Shutdown,给 GCP LB 时间摘掉 backend。
3. **`BaseContext` 必须用根 ctx**([`main.go:254-260`](../../packages/api/main.go)):否则 serve goroutine 退出会 cancel 所有 in-flight 请求。
4. **spec 里 security scheme 名按字母序决定校验顺序**:token 先校验、team 后查。详见 §5.2。
5. **Auth header 缺失主动 `c.Status(401)`**:让 oapi-codegen 的 `max(writer.status, fallback)` 把 400 改成 401。
6. **API key 缓存 5min TTL + 1min refresh**,但 access token **不缓存**(因为它即将废弃)。
7. **三个 `AdjustableSemaphore` + 30s 周期 sync flag**:不重启即可调 DB 限流。
8. **`connectGroup` vs `discoveryGroup` 必须分开**(orchestrator.go 行 73-83):cluster node 路径下 nested `Do` 同 key 会死锁。
9. **`scopedNodeID` 区分 local/remote cluster**:local 用纯 `nodeID`,remote 用 `<clusterID>-<nodeID>`,避免跨 cluster 重名。
10. **`r.UseRawPath = true`**([`main.go:111`](../../packages/api/main.go)):让 `%2F` 在路径参数里不被切分,template ID 含 `team-slug/my-template` 时必须。
11. **ClickHouse switching client + LD flag**:不重启在两个 CH cluster 间漂移读流量。
12. **pprof `init()` wrap `DefaultServeMux`**([`pprof.go:12`](../../packages/shared/pkg/telemetry/pprof.go)):防第三方库 init 注册 pprof 暴露。
13. **`store.go:417` 和 `:466` 重复定义 `GetTeamFromAdminToken`**:已知脏代码(merge 事故),待清理。
14. **Nomad `kill_timeout = 150s`** 精确等于 shutdown budget(15s drain + 75s shutdown + 30s cleanup + slack)。
15. **`api-grpc` 兼容性 service 别名**([`api.hcl:107-119`](../../iac/modules/job-api/jobs/api.hcl)):#2470 重命名后老 client-proxy 还用旧名,等清理。
16. **`min_healthy_time = 120s`**([`api.hcl:137`](../../iac/modules/job-api/jobs/api.hcl)):GCP LB 直接路由到 MIG node,新 canary node ~60s 才被 admit,短值会零 backend 503。
17. **`/health` 由 `apiStore.Healthy` 控制,启动时 false**,要等到至少一个 orchestrator node 接入才置 true。
18. **`expectedMigrationTimestamp` ldflags 注入 + CheckMigrationVersion**:防止 API 跑在过新/过旧 DB schema 上。
19. **HTTP/2 over H2C**:`httpserver.ConfigureH2C(s)` 必开,Traefik 用 h2c 协议路由 grpc-api。
20. **Rate limit 完全 LD flag 驱动,无 code-level 默认**:flag null = 完全不限流;FailOpen = Redis 挂了放行。

### 13.2 演进历史线索

- **从 ent → sqlc**:仓库**实际不用 ent ORM**,而是用 sqlc 从 SQL 生成类型安全查询。文档要求里偶尔提到的"ent ORM (packages/shared/pkg/db/)"是过时信息。
- **Access Token 即将下线**:flag `disable-e2b-access-token-provisioning` 启用后 `POST /access-tokens` 返 410 Gone。新集成应走 API Key 或 OIDC。详见 [`docs/api-changes-2026.16-2026.28.md`](../api-changes-2026.16-2026.28.md)。
- **Template build API 版本演化**:`POST /templates` → `POST /v2/templates` → `POST /v3/templates`(当前推荐)。`deprecated_template_request_build*.go` 系列保留向后兼容。
- **Service discovery 多实现**:从早期 Nomad-only → 新增 Kubernetes / Local,以及 NomadNodePool legacy fallback 与 NewMerged 合并。
- **`api-grpc` service alias**:Issue #2470 把 service 重命名后,旧 client-proxy 仍用旧名,等清理。

### 13.3 部署细节

#### 13.3.1 Nomad job 结构

文件:[`iac/modules/job-api/jobs/api.hcl`](../../iac/modules/job-api/jobs/api.hcl)

```hcl
job "api" {
  node_pool = "${node_pool}"
  priority  = 90

  group "api-service" {
    count = ${count_instances}

    restart {
      interval  = "5s"
      attempts  = 1
      delay     = "5s"
      mode      = "delay"
    }

    network {
      port "api" { static = "${port_number}" }                  # 80
      port "api_internal_grpc" { static = "${api_internal_grpc_port}" }  # 5009
      port "grpc_api" {}                                        # 动态(edge gRPC 5109 容器内绑定)
      # port "scheduling-block" { static = 40234 }              # 可选,prevent_colocation
    }

    constraint { operator = "distinct_hosts", value = "true" }

    # 四个 service 块:api / api-internal-grpc / grpc-api / api-grpc(兼容别名)
    service "api" {
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.api.entrypoints=web",
        "traefik.http.routers.api.rule=HostRegexp(`api.{domain:.+}`)",
        "priority=500",
      ]
      check {
        type     = "http"
        path     = "/health"
        interval = "3s"
        timeout  = "3s"
      }
    }

    update {  # 可选,count > 1 时启用
      max_parallel      = 1
      canary            = 1
      min_healthy_time  = "120s"     # GCP LB admit 新 MIG node ~60s
      healthy_deadline  = "10800s"
      progress_deadline = "10801s"
      auto_promote      = true
      auto_revert       = true
    }

    task "start" {
      kill_timeout = "150s"
      kill_signal  = "SIGTERM"

      resources {
        memory_max = ${memory_mb * 2}
        memory     = ${memory_mb}
        cpu        = ${cpu_count * 1000}   # MHz
      }

      env {
        NODE_ID           = "$${node.unique.id}"
        API_EDGE_GRPC_PORT = "$${NOMAD_PORT_grpc_api}"
        # ... job_env_vars map
      }

      config {
        network_mode = "host"
        image        = "${api_docker_image}"
        ports        = ["${port_name}", "grpc_api"]
        args         = ["--port", "${port_number}"]
      }
    }

    task "db-migrator" {
      lifecycle {
        hook = "prestart"
        sidecar = false   # 跑完就退
      }
      # ... DB migration
    }
  }
}
```

#### 13.3.2 Terraform 调用

模块入口:[`iac/modules/job-api/main.tf`](../../iac/modules/job-api/main.tf)(行 13-31),`templatefile` 渲染 `jobs/api.hcl`。

GCP 调用([`iac/provider-gcp/nomad/main.tf:59-79`](../../iac/provider-gcp/nomad/main.tf)):

```hcl
module "api" {
  source              = "../../modules/job-api"
  update_stanza       = var.api_machine_count > 1
  node_pool           = var.api_node_pool
  prevent_colocation  = var.api_machine_count > 2
  count_instances     = var.api_server_count
  memory_mb           = var.api_resources_memory_mb
  cpu_count           = var.api_resources_cpu_count
  port_name           = var.api_port.name
  port_number         = var.api_port.port
  api_internal_grpc_port = var.api_internal_grpc_port
  # ...
}
```

GCP 变量([`iac/provider-gcp/variables.tf:54-72`](../../iac/provider-gcp/variables.tf)):
- `api_server_count`(行 54)
- `api_resources_cpu_count`(行 59)
- `api_resources_memory_mb`(行 64)
- `api_machine_count`(行 111)— 用于决定 `update_stanza` 和 `prevent_colocation`。

AWS 调用([`iac/provider-aws/nomad/main.tf:101-119`](../../iac/provider-aws/nomad/main.tf)):

```hcl
module "api" {
  source              = "../../modules/job-api"
  update_stanza       = var.api_cluster_size > 1
  prevent_colocation  = var.api_cluster_size > 2
  count_instances     = var.api_cluster_size
  memory_mb           = var.api_memory_mb
  cpu_count           = var.api_cpu_count
  port_name           = "api"
  port_number         = var.api_port
  api_internal_grpc_port = var.api_internal_grpc_port
  # ...
}
```

AWS 变量([`iac/provider-aws/nomad/variables.tf`](../../iac/provider-aws/nomad/variables.tf)):
- `api_cluster_size`(行 39)
- `api_node_pool`(行 26)
- `api_port`(行 153,默认 80)
- `api_internal_grpc_port`(行 158,默认 5009)
- `api_memory_mb`(行 175,默认 512)
- `api_cpu_count`(行 180,默认 1)

#### 13.3.3 Docker bake

文件:[`packages/api/docker-bake.hcl`](../../packages/api/docker-bake.hcl):

- 两个 target:`api`(主二进制)+ `db-migrator`(DB 迁移器),并行构建。
- 平台 `linux/amd64`。
- tag:`${REGISTRY_PREFIX}/api` + `:${COMMIT_SHA}` 后缀。
- `REGISTRY_PREFIX` 在 Makefile 按 PROVIDER 选(AWS = ECR,GCP = Artifact Registry)。

---

## 十四、常见问题排查

### 14.1 启动失败

| 症状 | 可能原因 | 排查 |
| --- | --- | --- |
| `NODE_ID is required` fatal | Nomad 未注入 `node.unique.id`(本地开发漏配) | 设置 `NODE_ID=$(uuidgen)` 或 `make run`(Makefile 自动注入) |
| `migration version mismatch` fatal | 代码期望的 migration 与 DB 实际不一致 | 跑 `db-migrator` sidecar;或检查 `expectedMigrationTimestamp` ldflags |
| `/health` 一直返 503 | 没有任何 orchestrator node 接入 | 检查 `SERVICE_DISCOVERY_PROVIDER`、`NOMAD_ORCHESTRATOR_SERVICE_NAMES`;`Nomad UI → Services → orchestrator` |
| edge gRPC 全部 401 | `CLIENT_PROXY_OIDC_ISSUER_URL` 未配 | 启动日志会有 warn,配 issuer URL 重启 |

### 14.2 限流 / 429

| 症状 | 排查 |
| --- | --- |
| 客户端收到 429,但不知道是哪条规则 | 检查 LaunchDarkly `rate-limit-config` flag;key 是 `ratelimit:<teamID>:<route>` |
| Redis 故障期间出现流量突增 | `FailOpen=true`,Redis 挂时放行,这是设计行为 |
| 想完全关闭限流 | `rate-limit-config` flag 设为 `null` |

### 14.3 Auth 异常

| 症状 | 可能原因 |
| --- | --- |
| 401 但 token 看起来正确 | header 缺失被 `c.Status(401)` 主动拒;或 `e2b_` 前缀缺失 |
| OIDC JWT 路径每次都查 DB | identity lookup 缓存只缓存成功结果,新用户每次 miss 是正常 |
| API key 5 min 内权限变更不生效 | 5 min TTL + 1 min refresh,变更后调 `InvalidateTeamCache` 立即清 |
| 改 team 后旧 token 仍能访问 | access token 不走缓存(参见 §5.3.2),只能等 token 过期或主动 revoke |

### 14.4 Sandbox / Template 操作失败

| 症状 | 可能原因 |
| --- | --- |
| `POST /sandboxes` 503 / 500 | 没有可用 orchestrator node;或 `placement.BestOfK` 找不到满足 CPU/label 兼容的 node |
| `POST /sandboxes/{id}/pause` 返 `PauseQueueExhaustedError` | sandbox 已在 pausing 过渡态 |
| `GET /sandboxes` 返空但 sandbox 应该存在 | sandbox 已 pause 但 DB snapshot 还没 upsert(`snapshotUpsertSem` 排队中);或 `sandboxListSem` 限流 |
| template build 状态长时间 `building` | `templateManager.BuildsStatusPeriodicalSync` 还没跑到下一分钟;或 builder node 失联 |

### 14.5 ClickHouse 查询异常

| 症状 | 可能原因 |
| --- | --- |
| metrics 全部返空 | LD flag `clickhouse-read-endpoint` 指向不存在的 index;或 `CLICKHOUSE_CONNECTION_STRING` 未配,退化为 noop |
| 查询超时 | `MaxOpenConns=10` 打满;查看是否有大范围 query |
| DSN 出现在日志里 | 错误,`EndpointFromDSN` 应只提取 host:port — 提 issue |

### 14.6 Graceful Shutdown 异常

| 症状 | 可能原因 |
| --- | --- |
| Nomad 强杀 task,日志被截断 | `kill_timeout = 150s` 不够用,shutdown 阶段卡住;查 `GracefulStop` 是否超时 |
| shutdown 后 LB 仍把流量打到死实例 | `shutdownDrainWait = 15s` 太短(GCP LB admit 慢),考虑延长 |

---

## 十五、附录

### 15.1 术语表

| 术语 | 含义 |
| --- | --- |
| **APIStore** | `packages/api/internal/handlers/store.go` 的"上帝对象",实现 `api.ServerInterface` |
| **Edge gRPC** | 对外 gRPC(5109),由 client-proxy 通过 OIDC JWT 反向调用 |
| **Internal gRPC** | 内部 gRPC(5009),同 VPC 服务直接调用,跳过 OIDC |
| **Authenticator** | 单个 security scheme 的鉴权器,实现 `Authenticate(ctx, ginCtx, input) error` |
| **APIStore.Healthy** | `atomic.Bool`,启动时 false,首个 orchestrator 接入后 true,shutdown 时立即 false |
| **BestOfK** | 调度算法:随机采样 K 个 node,按 R/α 加权选最优 |
| **scopedNodeID** | 本地 cluster 用 `nodeID`,远端 cluster 用 `<clusterID>-<nodeID>`,防跨 cluster 重名 |
| **SwitchingClient** | ClickHouse 切换 client,LD flag 控制读 DSN |
| **ClusterResource** | 多区域抽象层,本地走 CH/Loki,远端走 edge HTTP API |
| **expectedMigrationTimestamp** | 构建时 ldflags 注入,运行时校验 DB migration 版本 |

### 15.2 测试入口

#### 单元测试

主要在 [`packages/api/internal/handlers/*_test.go`](../../packages/api/internal/handlers/):

- `accesstoken_test.go`
- `admin_api_keys_test.go`
- `proxy_grpc_test.go`
- `sandbox_create_test.go`(33KB,最大)
- `template_alias_test.go`
- `template_start_build_v2_test.go`
- `timeout_helper_test.go`
- `volume_get_test.go`
- `volume_test.go`
- `volume_util_test.go`

其他目录测试:

- `internal/cache/templates/*_test.go`、`internal/cache/snapshots/*_test.go`
- `internal/orchestrator/`(`placement_*`、`cpu_compatibility_*`、`label_compatibility_*`、`evict_test.go`、`client_test.go`、`create_instance_test.go`、`create_instance_events_test.go`、`autoresume_test.go`、`keep_alive_test.go`、`routing_test.go`、`analytics_test.go`)
- `internal/clusters/discovery/*_test.go`、`internal/clusters/resources_test.go`
- `internal/team/limits_test.go`
- `internal/db/snapshots_test.go`
- `internal/utils/*_test.go`
- `internal/oauth/oauth_test.go`
- `internal/middleware/ratelimit/ratelimit_test.go`
- `internal/api/spec_test.go`

handler 测试用 [`mocks/`](../../packages/api/internal/handlers/mocks/) 子目录的生成 mock(`mockery`,配置 [`../../.mockery.yaml`](../../.mockery.yaml))。

运行:

```bash
# 单包
cd packages/api && go test -race -v ./internal/handlers

# 单测
cd packages/api && go test -race -v -run TestCreateSandbox ./internal/handlers
```

#### Integration tests

位置:[`tests/integration/`](../../tests/integration/)(独立 Go module,有 `go.mod`)。

结构:
- `seed.go` — 测试数据 seeding
- `internal/main_test.go` — 入口
- `internal/setup/` — `api_client.go`、`db_client.go`、`envd_client.go`、`orchestrator_client.go`、`constants.go`
- `internal/tests/api/` — `health_test.go`、`apikey_test.go`、`sandboxes/`、`templates/`、`volumes/`、`metrics/`
- `internal/tests/team_test.go`
- `internal/tests/envd/`、`internal/tests/orchestrator/`、`internal/tests/proxies/`

Makefile:[`tests/integration/Makefile`](../../tests/integration/Makefile):

```bash
make seed                    # 跑 seed.go
make test                    # 全量
make test/<path>             # 单目录,例如 make test/api/sandboxes
```

依赖大量 `TESTS_*` 环境变量(`TESTS_API_SERVER_URL`、`TESTS_E2B_API_KEY`、`TESTS_SANDBOX_TEMPLATE_ID` 等)。

### 15.3 Telemetry & 日志接入点

**Telemetry Client**([`packages/shared/pkg/telemetry/main.go`](../../packages/shared/pkg/telemetry/main.go)):

```go
telemetry.New(ctx, nodeID, serviceName, serviceCommit, serviceVersion, serviceInstanceID, additional...) (*Client, error)
```

- `OTEL_COLLECTOR_GRPC_ENDPOINT` 设了才有真实 exporter,否则 NoopClient。
- 包含:`MetricExporter` / `MeterProvider` / `SpanExporter` / `TracerProvider` / `TracePropagator` / `LogsProvider`。
- Histogram aggregation 用 base2 exponential bucket(MaxSize=160, MaxScale=20)。
- metric export period 15s。

**常用 attribute 构造器**([`packages/shared/pkg/telemetry/fields.go`](../../packages/shared/pkg/telemetry/fields.go)):

- `WithSandboxID`、`WithTemplateID`、`WithBuildID`、`WithNodeID`、`WithTeamID`、`WithUserID`、`WithClusterID`、`WithMaskedAPIKey`

**Logger**([`packages/shared/pkg/logger/logger.go`](../../packages/shared/pkg/logger/logger.go)):

```go
NewLogger(LoggerConfig{ServiceName, IsInternal, IsDebug, Cores: [OTELCore], EnableConsole})
```

- `GetOTELCore(provider, serviceName)` 把 zap core 接到 OTEL logs exporter,日志走 OTLP 到 collector。
- 全局 `L()` 返回 `*TracedLogger`,`ReplaceGlobals(ctx, l)` 替换。
- Sandbox logger 拆 internal/external 两个,业务日志按可见性分流(external 给客户看,internal 只给 E2B 内部)。

### 15.4 pprof 接入点

文件:[`packages/shared/pkg/telemetry/pprof.go`](../../packages/shared/pkg/telemetry/pprof.go)

**关键安全设计**:`init()` 函数(行 12)wrap `http.DefaultServeMux`,**屏蔽 `/debug/pprof*` 路径**——防止任何第三方库通过 init 注册 pprof 后意外暴露。

```go
NewPprofServer()   // 绑定 127.0.0.1:<PprofPort()>,只本地可访问
NewPprofMux()      // 显式只注册 5 个 pprof handler,不复用 DefaultServeMux
PprofPort()        // PPROF_PORT 环境变量覆盖,默认 6060
```

Makefile profiler target:

```bash
make metric=heap interval=90 profiler
# 等价于 go tool pprof -http :9991 http://localhost:6060/debug/pprof/heap?seconds=90&timeout=120
```

main.go 启动:

```go
pprofServer := telemetry.NewPprofServer()
wg.Go(func() { pprofServer.ListenAndServe() })
// shutdown: pprofShutdownTimeout = 5s
```

### 15.5 错误条件常量

`cfg.Parse` 校验失败时返回的 `FailureError{Condition}`,常用 `Condition`:

- `FailureConditionInvalidServiceDiscoveryProvider` — `SERVICE_DISCOVERY_PROVIDER` 非 nomad/kubernetes/local
- `FailureConditionInvalidVolumesTokenConfig` — `VOLUME_TOKEN_ENABLED=true` 但四件套不齐

### 15.6 相关文档

- [`template-module.md`](template-module.md) — Template 模版系统
- [`sandbox-management.md`](sandbox-management.md) — Sandbox 管理
- [`node-module.md`](node-module.md) — 节点/集群、服务发现、调度
- [`volumes.md`](volumes.md) — 持久化卷
- [`snapshots.md`](snapshots.md) — Pause/Resume 与 snapshot
- [`database-schema.md`](database-schema.md) — 数据库 schema
- [`../api-changes-2026.16-2026.28.md`](../api-changes-2026.16-2026.28.md) — API 变更摘要
- [`../sandbox-lifecycle.md`](../sandbox-lifecycle.md) — Sandbox 生命周期(老文档)
- [`../orchestrator-module.md`](../orchestrator-module.md) — Orchestrator 模块(老文档)
- [`../envd-module.md`](../envd-module.md) / [`../envd-package.md`](../envd-package.md) — envd 模块(老文档)
- [`../MODULE_GUIDE.md`](../MODULE_GUIDE.md) — 模块导览

---

> 文档版本:2026-07-11。基于 `learn/brain` 分支代码,涵盖 `packages/api/` 全部子系统。后续 API 演进(`POST /v4/templates` 等)请同步更新 §8、§13.2。
