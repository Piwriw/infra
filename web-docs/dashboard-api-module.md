# Dashboard API 模块深入解析

> 范围: `packages/dashboard-api/` 与 `spec/openapi-dashboard.yml`。本文解释 Dashboard API 为什么独立于主 API、请求怎样完成 OIDC/team 鉴权、用户与团队怎样 provision，以及 build/template/sandbox 历史数据从哪里读取。
>
> 先记住一句话: **Dashboard API 是面向登录用户的控制台聚合层，不负责调度 sandbox，也不直接管理 Firecracker。**
>
> **本文已同步至 tag `2026.30`**（提交 `f32ee8a2a50052f32e3632ceb451111a98dd5104`）。所有行号均按 `2026.30` 核对；与 2026.29 不同处写作「行 N（2026.30；2026.29 为 M）」。2026.30 的变动清单见 §零。

## 零、2026.30 变动速览

### 零.1 版本号: 0.0.1 → 0.7.0

⚠️ **反直觉: 起点 0.0.1 不是 2026.29 的状态。** `packages/dashboard-api/` 在 tag `2026.29` 上**没有任何已发布版本** —— `git show 2026.29:packages/dashboard-api/CHANGELOG.md` 直接报 `fatal: path ... does not exist`，release-please 当时尚未接管该目录。该目录在 2026.29 已有 75 个文件，只是还没有版本号。

证据在 release-please 自己的配置里。2026.29 的 `release-please-config.json` 的 `packages` 只列了 **3 个**包 —— `packages/docker-reverse-proxy`、`packages/client-proxy`、`packages/clickhouse`（后者 `component` 名为 `clickhouse-migrator`）——**没有 `packages/dashboard-api`**；`.release-please-manifest.json` 同样只有这 3 项，都是 `0.0.1`。而配置里 `"initial-version": "0.0.1"` 正好解释了为什么 dashboard-api 的第一次发版是 **0.0.1** 而不是 1.0.0。

ⓘ 到 2026.30，`.release-please-config.json`、`.release-please-manifest.json`、`.github/workflows/release-please.yml` **三个文件都已不在本仓库**（`git ls-tree 2026.30 | grep release-please` 为空）—— 发布流程已移出本仓库，见 [`RELEASING.md`](./RELEASING.md)。所以 dashboard-api 的 0.7.0 是从外部 monorepo 侧发出来的，本仓库只留下 `CHANGELOG.md` 作为产物。

因此「0.0.1 → 0.7.0」这个跨度虽然真实，**整个区间都落在 2026.29→2026.30 之间**。窗口内共 **8 次 release-please 发版**：

| 版本 | 日期 | 该版主要内容 |
| --- | --- | --- |
| 0.0.1 | 2026-07-30 | release-please 首次接管（`chore(main): release dashboard-api 0.0.1` #3471） |
| 0.1.0 | 2026-07-31 | 集群注册 API（#3475）、workspace admin API foundations（#3314） |
| 0.2.0 | 2026-08-17 | versioned project member projection、`project_limits` 表、`upsertProjectLimits`、project limits revision 栅栏、batch member sync |
| 0.3.0 | 2026-09-01 | 大版本: 认证化 cluster 管理、team access status、legacy team mutation 门控、E2B access token 退役 + `access_tokens` 表删除、TypeID 编码、PostgreSQL session primitives、Redis 密码/TLS、`RejectRoutes` 移入 shared |
| 0.3.1 | 2026-09-01 | 仅澄清版本对齐，无功能变更 |
| 0.4.0 | 2026-09-01 | `GET /teams/{teamID}/limits` |
| 0.5.0 | 2026-09-02 | service JWT 认证（`AdminJWTAuth`）、maximum free disk limits 桥接 |
| 0.6.0 | 2026-09-04 | admin team ban / block |
| 0.7.0 | 2026-09-06 | cluster teardown readiness 检查 + 保留环境与 build 历史 |

ⓘ 2026.30 的 `CHANGELOG.md` 顶部即 `## 0.7.0 (2026-09-06)`，底部为 `## 0.0.1 (2026-07-30)`。注意 **0.0.1 与 0.1.0 两节的 feature 列表完全相同** —— 这是 release-please 首次接管时的回填，不是「0.1.0 没做任何事」。版本号序列里也没有 0.0.2/0.0.3 之类，0.0.1 之后直接跳 0.1.0。

### 零.2 契约规模

| 项目 | 2026.29 | 2026.30 |
| --- | --- | --- |
| path | 23 | **37** |
| operation | 25 | **45** |
| securityScheme | 3 | **5** |
| `components.schemas` | — | 新增 13 个，删除 0 个 |
| `components.parameters` | — | 新增 `clusterID`、`projectID`、`userID` |
| `components.responses` | — | 新增 `412`、`501` |
| tag | builds / sandboxes / teams / templates | 新增 `control-plane-management` |

`git diff --stat 2026.29 2026.30 -- spec/openapi-dashboard.yml` = **+935 / −51**。⚠️ **没有任何 path 被删除或改名** —— 全部是新增 path 与既有 path 的 security 扩展。所以本文 §四、§十三的旧矩阵不是「错了」，而是「不完整」。

### 零.3 新增 path 全表（14 个 path / 20 个 operation）

行号为 tag `2026.30` 的 `spec/openapi-dashboard.yml` 中 **path 行 / method 行**。

| method | path | 行（2026.30） | 鉴权 | 说明 |
| --- | --- | --- | --- | --- |
| `POST` | `/admin/clusters` | 1731 / 1732 | AdminKey **或** AdminJWT | 创建 cluster；配置不可变。可选 `cluster_id` 做幂等创建，复用时要求不可变配置完全一致 → `201` / `409` |
| `DELETE` | `/admin/clusters/{clusterID}` | 1761 / 1762 | AdminKey **或** AdminJWT | 删除无引用 cluster；同事务释放软删除的环境引用、保留环境与 build 历史；重复删除成功 → `204` |
| `GET` | `/v1/management/clusters/{clusterID}/destroy-readiness` | 1783 / 1784 | AdminJWT | 该 cluster 是否仍有 active template / snapshot。软删除历史与 team 分配**不**阻塞。cluster 不存在也算成功 → `204`；有引用则 `409` |
| `GET` | `/admin/teams/{teamID}/cluster` | 1809 / 1810 | AdminKey **或** AdminJWT | 读 team 的 cluster 分配，**不暴露 cluster 凭证** → `200` |
| `PUT` | `/admin/teams/{teamID}/cluster` | 1809 / 1834 | AdminKey **或** AdminJWT | 把 team 指向已存在 cluster；`preserve_existing=true`（默认 false）时仅在未分配或已指向同一 cluster 时生效 → `204` / `412` |
| `DELETE` | `/admin/teams/{teamID}/cluster/{clusterID}` | 1865 / 1866 | AdminKey **或** AdminJWT | 仅在未分配或正指向该 cluster 时清空 → `204` / `412` |
| `PUT` | `/admin/teams/{teamID}/ban` | 1892 / 1893 | AdminKey **或** AdminJWT | 封禁 team，使其 API Key 停止通过鉴权；幂等，**不打断运行中的负载** → `204` |
| `DELETE` | `/admin/teams/{teamID}/ban` | 1892 / 1911 | AdminKey **或** AdminJWT | 解封；幂等 → `204` |
| `PUT` | `/admin/teams/{teamID}/block` | 1930 / 1931 | AdminKey **或** AdminJWT | 带 `reason`（`AdminTeamBlockRequest`，1~1000 字符）封堵，使其无法再启动 sandbox / build；幂等，重复调用**替换** reason → `204` |
| `DELETE` | `/admin/teams/{teamID}/block` | 1930 / 1957 | AdminKey **或** AdminJWT | 解除封堵并清空 reason；幂等 → `204` |
| `GET` | `/teams/{teamID}/status` | 2137 / 2138 | Bearer + Team **或** AdminKey **或** AdminJWT | 返回 `isBlocked` / `isBanned` / `blockedReason`；team 凭证只能读自己所属 team → `200` |
| `GET` | `/teams/{teamID}/limits` | 2163 / 2164 | Bearer + Team **或** AdminKey **或** AdminJWT | 返回原始 `tier`（不做 catalog plan 归一化）与已解析的生效 limits → `200` |
| `PUT` | `/v1/management/projects/{projectID}` | 2466 / 2469 | AdminJWT | 创建或对账 project（**全量语句，不是 patch**）→ `200`（对账）/ `201`（新建）/ `501` |
| `DELETE` | `/v1/management/projects/{projectID}` | 2466 / 2504 | AdminJWT | ⚠️ 契约声明 `204`，**实际每个 control plane 都回 `501`**，见 §零.6 |
| `PUT` | `/v1/management/projects/{projectID}/members/{userID}` | 2528 / 2532 | AdminJWT | 应用「一个带 revision 的成员投影」；旧 revision 或重复请求**被接受但不改状态** → `204` |
| `PUT` | `/v1/management/projects/{projectID}/limits` | 2561 / 2564 | AdminJWT | 对账生效 limits；每个字段都是绝对值，本侧**不做算术** → `204` / `501` |
| `PUT` | `/v1/management/clusters/{clusterID}` | 2590 / 2593 | AdminJWT | 注册 cluster → `204` / `409` |
| `DELETE` | `/v1/management/clusters/{clusterID}` | 2590 / 2616 | AdminJWT | 删除无引用 cluster → `204` / `409` |
| `PUT` | `/v1/management/projects/{projectID}/cluster/{clusterID}` | 2633 / 2637 | AdminJWT | 把 cluster 分配给 project → `204` |
| `DELETE` | `/v1/management/projects/{projectID}/cluster/{clusterID}` | 2633 / 2656 | AdminJWT | 解除该分配 → `204` |

### 零.4 既有 operation 的 security 扩展（16 个，**全部是放宽**）

⚠️ 这 16 处**没有一处收窄**权限，都是「增加一种可选凭证」。读法上最大的坑是 **OR 与 AND 的区别**：

| 既有 operation | 2026.29 | 2026.30 |
| --- | --- | --- |
| `GET /builds`、`/builds/statuses`、`/builds/{build_id}` | `AuthProviderBearerAuth` + `AuthProviderTeamAuth`（同一 object，AND） | `ApiKeyAuth` **或** Bearer + Team |
| `GET /templates`、`/templates/{templateID}`、`/templates/{templateID}/tags/{groups,count,exists}`、`/templates/{templateID}/tags/{tag}/assignments` | Bearer + Team | `ApiKeyAuth` **或** Bearer + Team |
| `GET /templates/defaults` | `AuthProviderBearerAuth` | `ApiKeyAuth` **或** Bearer |
| `POST /admin/users/bootstrap`、`POST /admin/teams/bootstrap`、`POST /admin/user-profiles/resolve`、`POST /admin/user-profiles/by-email`、`GET /admin/user-profiles/{userId}`、`DELETE /admin/users/{userId}` | `AdminApiKeyAuth` | `AdminApiKeyAuth` **或** `AdminJWTAuth` |

注意 `GET /sandboxes/{sandboxID}/record` **不在**这张表里：它在 2026.30 仍然只接受 Bearer + Team。

### 零.5 术语迁移: team → project（进行中）

2026.30 的迁移是**两套命名并行**，不是重命名：

- 管理面（新）: `/v1/management/**` 用 `projectID`，`operationId` 前缀 `management*`（`managementUpsertProject`、`managementApplyProjectMember`、`managementUpsertProjectLimits`、`managementRegisterCluster`、`managementDeleteCluster`、`managementAssignProjectCluster`、`managementDetachProjectCluster`、`managementClusterDestroyReadiness`、`managementDeleteProject`）。
- 数据面（旧）: `/teams/**` 与 `teamID` **原样保留**；2026.30 新增的 `GET /teams/{teamID}/status` 与 `/limits` 也仍然用 team 命名。
- ⚠️ 同时新增 `internal/middleware/legacy_team_mutations.go`：LaunchDarkly flag `disable-legacy-team-mutations` 打开时，`RejectRoutes` 把 9 条**旧 team 变更路由**拦成 **`412`**（`StatusPreconditionFailed`），message 为 `Legacy team mutations are no longer available. Use the workspace API.`，rejection reason 为 `legacy_team_mutations_disabled`。被拦的 9 条（`legacy_team_mutations.go:16-24`）:

```text
POST   /teams
PATCH  /teams/:teamID
POST   /teams/:teamID/members
DELETE /teams/:teamID/members/:userId
POST   /admin/users/bootstrap
DELETE /admin/users/:userId
POST   /admin/teams/bootstrap
PUT    /admin/teams/:teamID/cluster
DELETE /admin/teams/:teamID/cluster/:clusterID
```

这就是新 `components.responses.412` 的来源。注意它**只拦变更**：`GET /teams/{teamID}/members` 不在列表里，所以 412 不代表整个 `/teams/**` 被关停。

### 零.6 ⚠️ 声明但不实现的 operation

`DELETE /v1/management/projects/{projectID}` 在 spec 里声明 `204`，但 `internal/handlers/management_project_delete.go` 直接调 `sendNotImplemented`，返回 **`501`**。这不是漏实现，而是刻意决定：`envs` / `snapshots` / `volumes` 以 `ON DELETE NO ACTION` 引用 team，而 template 删除只写 `deleted_at`，所以任何建过 template 的 project 都会钉住它的 team 行。释放它需要杀掉 sandbox、取消 build、回收已存储 artifact —— 这些都要用本进程不具备的 orchestrator 连接。代码注释明确把选择留给后续（网关转发 / 移到 api 服务 / 异步对账）。

因此 `PUT .../limits` 也保留了 `501` 作为可能响应。**调用方在 2026.30 不应依赖 project 删除。**

### 零.7 目录与包结构变化

| 项目 | 2026.29 | 2026.30 |
| --- | --- | --- |
| 文件数 | 75 | 112 |
| 顶层新增 | — | `CHANGELOG.md`、`main_test.go`、`management_readiness_test.go` |
| 新 package | — | `internal/management/`（`project.go`、`members.go`、`limits.go`、`service.go`） |
| 新 handler | — | `management_project_upsert.go`、`management_project_delete.go`、`management_project_members.go`、`management_project_limits.go`、`management_project_cluster.go`、`management_cluster_destroy_readiness.go`、`team_status.go`、`team_limits.go`、`admin_team_cluster.go`、`admin_team_access.go` |
| 新 middleware | — | `legacy_team_mutations.go` |
| 新 utils | — | `utils_management.go`（含 `sendNotImplemented`） |

⚠️ `internal/management/` 的注释说明了它为什么独立成包：这些状态变更要**脱离 gin 也能被调用**（「what these operations get wrong is never the HTTP」），并且各自负责失效自己写入所影响的缓存，以 sentinel error 而非数据库错误上报失败。`Service` 刻意持有**两个** DB client（`internal/management/service.go`）: membership 与投影走 auth 池，limits 走主池（`project_limits` 与读它的 `team_limits` 视图在那里）。**两者不共享事务** —— 两条连接串分别配置，不要求指向同一数据库。

### 零.8 ⛔ 部署链路已失效（`iac/` 整体删除）

`iac/` 在 2026.30 被**整体删除**（2026.29 的 **172 个文件 → 2026.30 的 0 个文件**），提交 `8a1c48884406b909f64c1239c808d0bc1cbf05bf`（2026-09-09，subject `chore(deploy): retire Nomad-based deployment ahead of a new deploy path`），根目录 `self-host.md` 同时删除。

**该包在 2026.30 已不再由本仓库的 IaC 部署。** 本文 §16.2「Nomad 与 GCP wiring」与 §十八索引里的 `iac/**` 条目全部失效，**保留为历史档案，不逐条删除**。同时失效的还有 §16.1 表格中「Nomad 会覆盖为 `$NOMAD_PORT_api`」的注解。

ⓘ 仍然存在、**不要误删**的相邻包: `packages/nomad-nodepool-apm/`（2026.29 的 10 文件 → 2026.30 的 **12** 文件，是新增而非删除）。同样在 2026.30 整体删除的还有 `packages/docker-reverse-proxy/`（19 文件 → 0），但那是另一个服务，与本文无关。

### 零.9 其他影响本文的改动

| 改动 | 影响本文哪里 |
| --- | --- |
| ⛔ `AUTH_DB_READ_REPLICA_CONNECTION_STRING` 删除（`internal/cfg/model.go` 行 21 → 2026.30 无此字段） | §2.1 依赖表、§16.1 配置表 |
| 新增 `ADMIN_AUTH_PROVIDER_CONFIG`（`model.go:19`） | §16.1 配置表；`AdminJWTAuth` 的 JWKS 来源 |
| 新增 `REDIS_TLS_ENABLED` / `REDIS_PASSWORD`（`model.go:26-27`） | §16.1 配置表 |
| `AdminJWTAuth`（service JWT）与 `ApiKeyAuth`（`X-API-Key`）两个新 scheme | §3.1 认证器表、§13.1 operation 分类 |
| ⛔ `access_tokens` 表删除 + E2B access token 认证移除 | §3.1 「不接受 access token」的措辞仍然成立，但原因从「不装配」变成「表已不存在」 |
| blocked-team allowlist 新增 `/teams/:teamID/limits` 与 `/teams/:teamID/status`（`internal/middleware/blocked_team.go:20,22`） | §13.3 |
| 新增 `packages/auth/pkg/auth/internal/`（ⓘ 见下） | §十八索引里 `packages/auth/pkg/auth` 的链接**仍然有效** |

⚠️ **不要按「`packages/auth/` 整体 internal 化」理解**：该包的公开路径 `packages/auth/pkg/auth` 在 2026.30 **依然存在**，dashboard-api 的 import 也没变。2026.30 的真实变化是把它**自己的**内部包收进 `packages/auth/pkg/auth/internal/`（2026.29 时 `pkg/auth` 下是 `oidc/`，2026.30 变成 `internal/`），并把 `packages/auth/pkg/tests` 移走。`packages/auth/` 顶层在 2026.29 与 2026.30 都只有 `go.mod`、`go.sum`、`pkg/`，**从来没有 `internal/` 目录**。

## 一、模块定位

仓库中容易混淆的两个 HTTP 服务是:

| 服务 | 主要调用方 | 主要凭证 | 核心职责 |
| --- | --- | --- | --- |
| `packages/api` | SDK、CLI、内部服务 | API key、access token、OIDC、admin token | sandbox/template/volume 的运行时控制面 |
| `packages/dashboard-api` | Web dashboard、内部管理流程 | OIDC bearer + team header，或 admin token | 用户、团队、成员、控制台列表和历史详情 |

Dashboard API 默认监听 `3010`（`internal/cfg/model.go:13`），OpenAPI 当前包含 **37 个 path、45 个 operation**（2026.29 为 23 个 path、25 个 operation；见 §零.2）。它的当前 handler 主要读取 PostgreSQL/Auth DB，并访问 Ory 与 billing 服务；ClickHouse client 已完成装配但尚未被这 45 个 operation 直接调用。它也不会绕过主 API 去直接调用 orchestrator。

```text
Browser / Dashboard
        |
        | OIDC bearer + optional X-Team-ID
        v
+---------------------------+
| dashboard-api :3010       |
| Gin + OpenAPI validator   |
|                           |
| handlers                  |
|  |- teams / members       |
|  |- builds / templates    |
|  `- sandbox record        |
+-----+------+------+-------+
      |      |      |
      |      |      `----------> Billing team provision API
      |      `-----------------> Ory identity directory
      |
      +----> PostgreSQL business DB
      +----> Auth DB (⛔ 2026.29 时另有 optional read replica)
      +----> Redis auth cache
      `----> ClickHouse switching client (已装配，当前 handler 未查询)
```

相关阅读:

- [auth-module.md](./auth-module.md):共享鉴权包、JWT 校验和 Redis 缓存。
- [database-schema.md](./database-schema.md):`users`、`user_identities`、`teams`、`users_teams` 等表。
- [template-build-flow.md](./template-build-flow.md):build 真正创建与执行的主链路。
- [team-metrics-module.md](./team-metrics-module.md):主 API 的 metrics 查询。

## 二、启动与依赖装配

入口是 `packages/dashboard-api/main.go`。启动顺序本身就是排障顺序:

1. 创建 telemetry client 和结构化 logger。
2. 解析环境变量，并验证 Redis、Ory 等必需配置。
3. 检查 PostgreSQL migration timestamp。
4. 创建业务 PostgreSQL client。
5. 创建 Auth DB client，包含写连接与可选读副本。
6. 创建 LaunchDarkly、ClickHouse switching client 和 Redis client。
7. 用 Redis + Auth DB + provider config 装配共享 `auth.Service`。
8. 根据 `ORY_SDK_URL` 与 JWT issuer 配置装配 identity service。
9. 根据 billing URL/token 选择 HTTP sink 或 noop sink。
10. 加载 OpenAPI，注册认证函数、中间件和 generated handlers。

### 2.1 依赖的职责边界

| 依赖 | Dashboard API 用途 | 关键行为 |
| --- | --- | --- |
| 业务 PostgreSQL | builds、templates、sandbox records、部分 team 查询 | 启动前检查 migration version |
| Auth DB | public user、OIDC linkage、team membership、tier/limit | 未配置专用 DSN 时回退到业务 PostgreSQL（`model.go:85-86`） |
| ⛔ Auth DB read replica | — | **2026.30 已删除**：`AUTH_DB_READ_REPLICA_CONNECTION_STRING` 不再是配置项（`internal/cfg/model.go` 行 21 在 2026.29，2026.30 无此字段），`authdb.Client` 不再有 read replica 概念 |
| Redis | JWT/team 鉴权缓存 | 至少配置 `REDIS_URL` 或 `REDIS_CLUSTER_URL` |
| Ory | identity profile、email 搜索、organization、external ID | admin SDK token 必需 |
| ClickHouse | 已注入 `APIStore` 的预留分析读取边界 | 当前 handler 未调用；默认 DSN 可为空并退化为 noop client |
| LaunchDarkly | ClickHouse endpoint 切换等运行时策略 | endpoint 可在请求之间切换 |
| Billing | 新 team 的计费侧 provision | 两项配置都空时使用 noop sink |

### 2.2 HTTP server 的边界

关键超时如下:

| 项目 | 值 |
| --- | --- |
| `ReadHeaderTimeout` | 5s |
| `ReadTimeout` | 10s |
| `WriteTimeout` | 75s |
| request middleware timeout | 70s |
| `IdleTimeout` | 620s |
| graceful shutdown | 30s |

`WriteTimeout` 比 request timeout 多 5 秒，让 middleware 先取消业务上下文，server 仍有时间把错误响应写回客户端。

## 三、请求中间件链

中间件顺序决定了错误在哪一层产生:

```text
request
  -> gin.Recovery
  -> CORS
  -> tracing (排除 /health)
  -> HTTP metrics (排除 /health)
  -> structured access log
  -> 70s request timeout
  -> OpenAPI request validator + authentication
  -> blocked-team enforcement
  -> generated route wrapper
  -> APIStore handler
```

OpenAPI validator 不只做 schema 校验，还根据 operation 的 `security` 声明调用对应 Authenticator。因此某个 handler 能否执行，首先由 spec 决定，而不是由 handler 内部临时判断。

### 3.1 五种认证器

⚠️ 2026.29 时这里是「三种认证器」，2026.30 增至 **5 个**。装配点在 `main.go:262-269`：

| scheme | 输入 | 注入结果 | 2026.30 |
| --- | --- | --- | --- |
| `ApiKeyAuth` | `X-API-Key` | team（由 key 直接解析） | 新增，仅用于 build / template 只读列表 |
| `AdminApiKeyAuth` | `X-Admin-Token` | admin 身份 | 既有 |
| `AdminJWTAuth` | `Authorization: Bearer`（service JWT，JWKS 来自 `ADMIN_AUTH_PROVIDER_CONFIG`） | admin 身份 | 新增，与 `AdminApiKeyAuth` 并列 |
| `AuthProviderBearerAuth` | `Authorization: Bearer ...` | internal user ID | 既有 |
| `AuthProviderTeamAuth` | `X-Team-ID` | team info 与 limits | 既有 |

对应的 authenticator 构造顺序（`main.go:264-268`）:

```text
main.go:264  NewApiKeyAuthenticator(apiStore.GetTeamFromAPIKey)
main.go:265  NewAdminApiKeyAuthenticator(config.AdminToken)
main.go:266  NewAdminJWTAuthenticator(adminVerifier)
main.go:267  NewAuthProviderBearerAuthenticator(apiStore.GetUserIDFromAuthProviderToken)
main.go:268  NewAuthProviderTeamAuthenticator(apiStore.GetTeamFromAuthProviderToken)
```

admin JWT verifier 在 `main.go:251` 用 `sharedauth.NewJWKSVerifier(ctx, config.AdminAuthProvider, authClient)` 构造。

ⓘ 它仍然不接受旧 Access Token，但 2026.30 的原因变了：`access_tokens` 表本身已被删除（0.3.0），不再是「装配了但不给用」。`ApiKeyAuth` 的加入也不代表 API Key 能登录 Dashboard —— 它只对 **10 个只读 operation** 开放（3 个 build 读接口 + 7 个 template 读接口，含 `/templates/defaults`，见 §零.4），**不覆盖任何变更接口**，也不覆盖 `GET /sandboxes/{sandboxID}/record`。

**AND 与 OR 的区别是本节最容易读错的地方。** 同一个 security object 内的多个 scheme 是 AND；数组里的多个 object 之间是 OR。

```yaml
security:
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
```

表示 bearer 与 team header 都必须成功，不是二选一。而 2026.30 新增的读接口是:

```yaml
security:
  - ApiKeyAuth: []                 # 单独一条路：只带 X-API-Key 即可
  - AuthProviderBearerAuth: []     # 另一条路：Bearer + X-Team-ID 一起
    AuthProviderTeamAuth: []
```

两条路**任选其一**。因此走 API Key 时**不需要** `X-Team-ID`，team 身份由 key 直接解析；只有走 JWT 那条路才两者都必需。把它误读成「多了一种必填凭证」会得出完全相反的排障结论。

## 四、端点分组与数据源

| 领域 | 路径 | 主要数据源 |
| --- | --- | --- |
| health | `GET /health` | 无 |
| builds | `GET /builds`、`/builds/statuses`、`/builds/{build_id}` | 业务 PostgreSQL |
| sandbox history | `GET /sandboxes/{sandboxID}/record` | 业务 PostgreSQL |
| current user/team | `GET/POST /teams`、`GET /teams/resolve` | Auth DB + identity directory |
| team mutation | `PATCH /teams/{teamID}` | PostgreSQL/Auth DB |
| members | `GET/POST /teams/{teamID}/members`、`DELETE .../{userId}` | PostgreSQL/Auth DB + Ory |
| team access status（2026.30） | `GET /teams/{teamID}/status` | Auth DB |
| team limits（2026.30） | `GET /teams/{teamID}/limits` | 业务 PostgreSQL（`team_limits` 视图 + `project_limits`） |
| admin identity | `/admin/users/*`、`/admin/user-profiles/*` | Auth DB + Ory |
| admin team bootstrap | `POST /admin/teams/bootstrap` | Auth DB + billing |
| admin team 状态（2026.30） | `PUT/DELETE /admin/teams/{teamID}/ban`、`PUT/DELETE /admin/teams/{teamID}/block` | Auth DB |
| admin cluster（2026.30） | `POST /admin/clusters`、`DELETE /admin/clusters/{clusterID}`、`GET/PUT /admin/teams/{teamID}/cluster`、`DELETE .../cluster/{clusterID}` | 业务 PostgreSQL + Auth DB |
| management 面（2026.30） | `/v1/management/projects/*`、`/v1/management/clusters/*` | 业务 PostgreSQL + Auth DB（见 §零.7） |
| templates | `GET /templates*` | 业务 PostgreSQL |
| template tags | `GET /templates/{templateID}/tags/*` | 业务 PostgreSQL |

一个很重要的边界是: `/sandboxes/{id}/record` 返回的是历史记录和 retention 状态，不是实时 sandbox 状态。实时创建、暂停、恢复和 kill 属于主 API。

## 五、Identity 层

`internal/identity/` 把两个完全不同的数据源统一成一个用户视图:

```text
Auth DB public.user_identities       Ory identity directory
(issuer, subject) <-> user_id        subject -> email/name/org/providers
             \                         /
              \                       /
               +---- identity.Service
```

### 5.1 issuer 解析

`ResolveOryIssuer` 的规则是:

1. `AUTH_PROVIDER_CONFIG` 没有 JWT issuer 时，回退到 `ORY_SDK_URL`。
2. 只有一个唯一 issuer 时直接使用。
3. 有多个 issuer 时，解析 `ORY_SDK_URL` host，并找 host 相同的 issuer。
4. 无唯一匹配时启动失败。

这防止服务拿一个 Ory project 的 subject 去另一个 identity directory 查询。

### 5.2 linkage 与 directory 不能互相替代

- linkage 只知道 `(issuer, subject) <-> internal user_id`。
- directory 只知道 subject 对应的 profile、organization 和 credential providers。
- 业务 handler 通常先从 linkage 找 subject，再批量查 directory。

Ory 的 ID filter 单次最多 500 个，因此 `ListIdentities` 按 500 分批。设置 `external_id` 使用 JSON Patch `add`，因为它既能创建缺失字段，也能覆盖已有字段，适合 bootstrap 重试。

### 5.3 SSO organization 不变量

`UserOrganizationID` 会遍历用户关联的 identity。如果同一个 internal user 最终解析出两个不同的非空 organization ID，操作失败，而不是随便选择一个。这条检查保护了后续 SSO team 邀请与自动加入逻辑。

## 六、用户与团队 Provisioning

`internal/provisioning/` 把“数据库建 team”“建立 membership”“身份回填”“计费 provision”组合成受约束的工作流。

### 6.1 首次 OIDC bootstrap

```text
OIDC identity
  -> resolve profile / organization
  -> upsert public user + identity linkage
  -> BEGIN auth transaction
       |- existing default team? return it
       |- SSO org? auto-join every sso_auto_join team
       `- otherwise create base_v1 team + default membership
  -> COMMIT
  -> request billing provision
  -> backfill Ory external_id = internal user ID
```

几个非直觉点:

- SSO organization 必须至少有一个 auto-join team，否则返回 `403`，提示组织 SSO 尚未配置完整。
- SSO 用户可能一次加入多个 auto-join team，但响应以第一个 team 作为 landing team。
- 已存在且创建不足 30 秒的 default team 会再次尝试 billing provision，用于恢复刚提交后出现的短暂失败。
- 新 default team 已提交后，billing 错误不会删除 team；代码优先保证用户 bootstrap 的数据库状态存在。
- Ory external ID 回填失败会让请求报错，但下次 bootstrap 可以幂等恢复。

### 6.2 用户主动创建额外 team

主动创建和默认 team 的失败语义不同:

1. 先拒绝 SSO-managed 用户。
2. upsert public user，并 `FOR UPDATE` 锁住该用户。
3. 锁定查询其 team 与 tier，串行化并发创建请求。
4. base 用户最多 3 个 team；拥有任意非 base tier 时最多 10 个。
5. 在事务内创建 team 和 non-default membership，然后提交。
6. 调 billing provision；失败时用独立 5 秒上下文删除刚创建的 team。

这里的删除属于补偿事务，不是数据库事务回滚，因为 billing 调用发生在 commit 之后。如果 billing 失败且删除也失败，错误会同时包含 provision 与 delete 两部分。

### 6.3 Billing sink 配置

| 配置状态 | 行为 |
| --- | --- |
| URL 与 token 都空 | noop sink，允许服务启动 |
| 只配置其中一项 | 启动失败 |
| 两项都配置 | `POST /internal/teams/provision` |

HTTP sink 总预算 30 秒，最多 3 次尝试，单次 client timeout 为 10 秒；错误响应 body 最多读取 2 KiB。`429`、`503` 等响应走带抖动的退避。

## 七、Team Member 的一致性保护

成员 handler 有三类保护。

### 7.1 path team 必须等于 auth team

`requireAuthedTeamMatchesPath` 比较 path 中的 `teamID` 与中间件注入的 team ID。不匹配直接 `403`。不能只依赖“用户属于某个 team”，因为请求可能把 path 改成另一个 UUID。

### 7.2 SSO 邀请限制

向 SSO team 添加成员时，invitee 从 Ory 解析出的 organization ID 必须与 team 的 `sso_organization_id` 相同。email 查到 0 个用户返回 `404`；查到多个 internal profile 返回 `409`，避免把邀请随机绑定给其中一个。

### 7.3 删除成员的并发控制

删除在事务中执行:

```text
BEGIN
  -> LockTeamMembersForUpdate(teamID)
  -> load target relation
  -> reject default member
  -> reject when locked member count <= 1
  -> delete membership
COMMIT
  -> invalidate (userID, teamID) auth cache
```

如果不先锁整个成员集合，两个并发删除都可能在检查时看到“还有两个人”，最终把团队删空。

添加或删除完成后都调用 `InvalidateTeamMemberCache`。否则 DB 已更新，Redis 中旧 membership 仍可能继续授权。

## 八、列表与游标设计

Dashboard 页面需要稳定翻页，因此多处使用 keyset cursor，而不是 SQL offset。

### 8.1 Builds

- 默认 50，最小归一为 1，最大 100。
- cursor 格式: `{created_at RFC3339Nano}|{build UUID}`。
- 首次查询使用当前 UTC 时间 + 最大 UUID 作为上界。
- 查询 `limit + 1` 行判断 `hasMore`，再裁掉多余行。
- 过滤值会依次尝试 build UUID、非 UUID template ID、template alias。
- build status 先映射为 DB status group，再映射回 Dashboard 的稳定状态。

`created_at` 可能相同，所以必须带 UUID 作为第二排序键。只用 timestamp 会在页边界重复或漏行。

### 8.2 Templates 与 tags

| 列表 | 默认/最大 | cursor 关键点 |
| --- | --- | --- |
| templates | 50 / 100 | `{sort}|{value}|{templateID}`，cursor 必须与当前 sort 相同 |
| tag groups | 25 / 100 | `{sort}|{latestAt}|{tag}`，tag 搜索限 64 个 `[a-z0-9._-]` 字符 |
| tag assignments | 50 / 100 | `{assignedAt}|{assignmentUUID}` |
| assignments per group | 6 / 25 | 控制 group 内嵌样本数量 |

较新的 template/tag assignment DESC cursor 使用远未来时间而不是 `time.Now()` 作为上界，避免应用与数据库时钟偏差让刚插入的行永久漏出分页链。build 列表仍使用 `time.Now().UTC()` 作为首屏上界；理解并修改分页代码时要注意这项历史差异。

## 九、Sandbox Record 与 Retention

`GET /sandboxes/{sandboxID}/record` 以 `(team_id, sandbox_id)` 查 PostgreSQL，因此“记录不存在”和“属于其他 team”都返回同一个 `404`，不会泄露资源存在性。

响应中有两个不同的过期判断:

| 字段 | 窗口 | 数据含义 |
| --- | --- | --- |
| `retentionExpired` | 固定 7 天 | metrics 与 logs |
| `eventsRetentionExpired` | team limit，默认 7 天，最大 365 天 | lifecycle events |

这两个字段只是根据 `stopped_at` 计算 UI 提示，不会在请求时查询 Loki 或 ClickHouse 来验证数据是否真的存在。

代码还把 PostgreSQL `42P01` undefined-table 当作 `404`。这让尚未部署 sandbox record 表的旧环境保持可用，但排障时要特别检查 migration，而不要只认为 sandbox ID 错了。

## 十、错误语义与排查

| 现象 | 首要检查 |
| --- | --- |
| 服务启动即退出 | migration timestamp、Redis 至少一项、Ory URL/token、billing 配置是否成对 |
| bearer 有效但返回 401 | `(iss, sub)` 是否已写入 `public.user_identities`，issuer 是否匹配 Ory host |
| team path 返回 403 | `X-Team-ID` 是否与 path UUID 完全一致 |
| 新用户 bootstrap 403 | Ory organization 是否存在 `sso_auto_join=true` team |
| 创建 team 后返回 billing 错误 | 检查 billing `/internal/teams/provision`，再确认补偿删除是否成功 |
| 成员添加后仍无权限 | `InvalidateTeamMemberCache` 是否执行，Redis 是否可用 |
| sandbox record 404 | 同时检查 team ownership、record migration 和 `42P01` 日志 |
| ⚠️ 旧 team 变更路由返回 **412**（2026.30 新增） | **不是鉴权失败**：`disable-legacy-team-mutations` flag 已打开，`RejectRoutes` 在 handler 之前就拦下了。查 rejection reason `legacy_team_mutations_disabled`，并改走 `/v1/management/**`。见 §零.5 |
| ⚠️ project 删除返回 **501**（2026.30 新增） | **不是 bug**：`DELETE /v1/management/projects/{projectID}` 是刻意不实现的，见 §零.6。不要重试 |
| ⚠️ 只带 `X-API-Key` 访问 `GET /sandboxes/{id}/record` 返回 401（2026.30） | 该接口**未**加入 `ApiKeyAuth`，仍只接受 Bearer + `X-Team-ID`。见 §零.4 |
| ClickHouse 未配置 | 允许使用 noop default；当前 Dashboard operation 不直接查询 ClickHouse |

日志和 trace 中优先按 `team.id`、`user.id`、`sandbox.id`、`build.id` 关联。OpenAPI 校验错误发生在 handler 之前，因此 handler 自己的业务日志可能完全不存在。

## 十一、源码阅读路线

建议按这个顺序阅读:

1. `spec/openapi-dashboard.yml`:先看公开契约与每个 operation 的 security。
2. `packages/dashboard-api/main.go`:看依赖和 middleware 装配。
3. `internal/handlers/store.go`:看 `APIStore` 持有哪些边界依赖。
4. `internal/identity/issuer.go`、`linkage.go`、`ory.go`:理解 internal user 与外部身份的拼接。
5. `internal/provisioning/bootstrap.go`、`sso.go`、`team.go`:理解事务与外部补偿。
6. `internal/handlers/team_members.go`:看 authz、SSO 与并发约束如何落在 handler。
7. `internal/handlers/builds_list.go` 和 `utils_*cursor*.go`:学习 keyset pagination。

关键文件索引:

| 文件 | 关注点 |
| --- | --- |
| `packages/dashboard-api/main.go` | 服务装配、中间件、HTTP timeout |
| `packages/dashboard-api/internal/cfg/model.go` | 环境变量与启动校验 |
| `packages/dashboard-api/internal/handlers/store.go` | handler 依赖容器 |
| `packages/dashboard-api/internal/identity/service.go` | 多 issuer directory 聚合 |
| `packages/dashboard-api/internal/identity/ory.go` | Ory 查询、分批与 external ID patch |
| `packages/dashboard-api/internal/provisioning/team.go` | team limit、事务、billing 补偿 |
| `packages/dashboard-api/internal/teamprovision/http_sink.go` | retry、timeout、错误映射 |
| `packages/dashboard-api/internal/handlers/team_members.go` | 成员一致性与缓存失效 |
| `packages/dashboard-api/internal/handlers/sandbox_record.go` | 历史记录与 retention |
| `packages/dashboard-api/internal/handlers/builds_list.go` | build filter 与双键 cursor |

## 十二、掌握程度自检

读完源码后应能独立回答:

1. 为什么 `/teams/{teamID}/members` 既要 OpenAPI team auth，又要比较 path team？
2. 为什么默认 team 的 billing 失败策略与额外 team 不同？
3. Ory profile 与 `public.user_identities` 分别保存什么，缺一会怎样？
4. 为什么删除成员要锁整个 team 的 membership 集合？
5. 为什么 build cursor 必须同时包含 timestamp 和 UUID？
6. 为什么 sandbox record 的两个 retention 字段不能合并？

## 十三、端点契约与权限矩阵

OpenAPI 文件是 Dashboard API 的第一道授权边界。认证函数只会为 operation 声明的 scheme 提供凭证；因此新增 handler 时，必须同时修改 spec、生成代码和测试，不能只在 handler 内部“顺手”检查 header。

### 13.1 operation 分类

⚠️ 2026.29 时这里是「三类 operation」，2026.30 变为 **5 类**（新增「API Key 可读级」与「management 级」）。

| operation 类别 | 路径 | security | 是否需要 `X-Team-ID` | blocked team 行为 |
| --- | --- | --- | --- | --- |
| 健康检查 | `GET /health` | 无 | 否 | 不经过 team middleware |
| 用户级 | `GET/POST /teams`、`GET /teams/resolve` | Bearer | 否 | 不受 team 状态影响 |
| 用户级 + API Key（2026.30） | `GET /templates/defaults` | `ApiKeyAuth` **或** Bearer | 否 | 不受 team 状态影响 |
| 团队级 | sandbox record、`PATCH /teams/{teamID}`、members | Bearer + Team | 是 | 只有 allowlist 中的 GET 可读 |
| 团队级 + API Key（2026.30） | builds、templates 与 tags、`GET /teams/{teamID}/status`、`/limits` | `ApiKeyAuth` **或** Bearer + Team（`/status`、`/limits` 另加 Admin 两条） | 走 JWT 时是；走 API Key 时否 | 只有 allowlist 中的 GET 可读 |
| 管理级 | `/admin/users/*`、`/admin/teams/bootstrap`、`/admin/user-profiles/*`、`/admin/clusters`、`/admin/teams/{teamID}/{cluster,ban,block}` | `AdminApiKeyAuth` **或** `AdminJWTAuth` | 否 | 不受 team 状态影响 |
| management 级（2026.30） | `/v1/management/projects/*`、`/v1/management/clusters/*` | `AdminJWTAuth`（**仅此一种**） | 否 | 不受 team 状态影响 |

⚠️ 注意最后一行的差异：`/v1/management/**` **只接受 service JWT**，不接受 `X-Admin-Token`。而 `/admin/**` 两者皆可。这一不对称容易被忽略，排查 401 时值得先确认用的是哪一种 admin 凭证。

这里的“Bearer + Team”是同一个 security object 中的两个 scheme，必须同时通过。Bearer 认证把 token 映射成 internal user ID，Team 认证再用该 user ID 验证 `X-Team-ID` 成员关系。仅携带一个 header 时，OpenAPI 层会在 handler 之前返回 `401` 或 `403`。

ⓘ 走 `ApiKeyAuth` 那条路时不需要 `X-Team-ID` —— 见 §3.1 的 AND/OR 说明。

### 13.2 团队级请求的两次授权

团队级 operation 仍然需要 handler 比较 path 参数，形成两层防线:

```text
Authorization + X-Team-ID
        |
        v
auth.Service.ValidateAuthProviderTeam
  |- user ID 已由 Bearer authenticator 注入 context
  |- Redis team-member cache 命中则复用
  `- cache miss -> Auth DB membership 查询 -> 写入 cache
        |
        v
handler.requireAuthedTeamMatchesPath
  `- path teamID != context teamID -> 403
        |
        v
handler 使用 auth.MustGetTeamID / auth.MustGetTeamInfo
```

这样即使某个用户同时属于多个 team，也不能把合法的 `X-Team-ID` 身份与另一个 path UUID 拼接使用。成员增删、team 更新等变更操作还会清理对应缓存；只读查询不会改变 membership 快照。

### 13.3 blocked team 的读写分界

`EnforceBlockedTeam` 位于 OpenAPI validator 之后，所以它只会看到已经通过认证、且 context 中有 team 的请求。⚠️ 2026.30 起它前面还多了 `DisableLegacyTeamMutations`（`main.go:385-386`），后者只拦变更路由，不影响 allowlist 判定。

当前 GET allowlist 为（`internal/middleware/blocked_team.go:14-31`，共 **15** 条；2026.29 为 13 条）:

```text
/builds                                        blocked_team.go:16
/builds/statuses                               blocked_team.go:17
/builds/:build_id                              blocked_team.go:18
/sandboxes/:sandboxID/record                   blocked_team.go:19
/teams/:teamID/limits                           blocked_team.go:20   <- 2026.30 新增
/teams/:teamID/members                         blocked_team.go:21
/teams/:teamID/status                           blocked_team.go:22   <- 2026.30 新增
/teams/resolve                                 blocked_team.go:23
/templates                                     blocked_team.go:24
/templates/defaults                            blocked_team.go:25
/templates/:templateID                         blocked_team.go:26
/templates/:templateID/tags/count              blocked_team.go:27
/templates/:templateID/tags/exists             blocked_team.go:28
/templates/:templateID/tags/groups             blocked_team.go:29
/templates/:templateID/tags/:tag/assignments   blocked_team.go:30
```

ⓘ allowlist 的定义已移到共享包：`blockedTeamAllowlist` 现在是 `auth.BlockedTeamAllowlist` 类型（`blocked_team.go:14`），`EnforceBlockedTeam` 由 `auth.EnforceBlockedTeam(blockedTeamAllowlist)` 提供（`blocked_team.go:37`）。2026.30 的 `feat(shared): move RejectRoutes middleware to the shared package` 把这两个 middleware 的实现挪到了 shared，dashboard-api 侧只剩 allowlist 常量。

⚠️ 值得注意的不对称：`/teams/{teamID}/limits` 与 `/status` 被加进 allowlist，意味着 **blocked team 可以读到自己的封堵状态和 limits** —— 这是刻意的，否则 dashboard 无法向被封用户解释原因。但同组的 `GET /teams/{teamID}` 并不存在，`/teams/{teamID}/members` 是既有条目。

因此 blocked team 仍可加载 dashboard 所需的历史数据和成员列表，但不能 `PATCH /teams/{teamID}`、添加或删除成员，也不能通过用户级 `POST /teams` 绕过限制。allowlist 是按 HTTP method 和 Gin 路由模板匹配的；添加新读接口时要明确决定是否加入，而不是把所有 GET 自动放行。

### 13.4 错误响应形状

业务 handler 通过 `sendAPIStoreError` 统一返回:

```json
{
  "code": 403,
  "message": "Team path parameter does not match authenticated team"
}
```

`code` 是整数 HTTP status，`message` 是给 dashboard 显示或记录的文本。OpenAPI validator 的 schema 错误也使用相同形状，因此客户端不应依赖某一个 handler 的额外字段。常见状态含义如下:

| 状态 | 产生层 | 典型原因 |
| --- | --- | --- |
| `400` | validator 或 handler | body、cursor、tag、limit、build ID 列表不合法 |
| `401` | authentication function | token 缺失、过期、issuer 不匹配 |
| `403` | team auth、blocked middleware、SSO policy | 非成员、blocked team 写操作、SSO 用户创建 team |
| `404` | DB 查询或 identity service | 资源不存在、无 team ownership、未知用户 |
| `409` | identity/admin workflow、cluster/project 冲突 | email 映射到多个 profile、删除用户仍有 FK 引用、slug 已被占用、cluster 仍有 active template / snapshot |
| `412`（2026.30） | `DisableLegacyTeamMutations` 或 `preserve_existing` | legacy team 变更路由被 flag 拦下；或 team 已指向别的 cluster 而请求要求保留既有分配。⚠️ 两者共用同一个 `components.responses.412`，但该组件的 description 只写了 `Legacy team mutations are disabled` —— cluster 分配那条路的 412 语义要读 endpoint 自己的 description |
| `501`（2026.30） | `sendNotImplemented` | 只有 `DELETE /v1/management/projects/{projectID}`（以及 `PUT .../limits` 的可能返回）；**刻意的**，见 §零.6 |
| `502/503/504` | billing sink 或上游 | billing 返回不可读响应、服务不可用、超时 |
| `500` | handler 或依赖 | SQL、Ory、Redis、迁移等未分类错误 |

OpenAPI 验证失败时不会进入 handler，因此排查 `400` 时应先看 request schema、operationId 和生成路由，再看业务日志。`sendProvisioningError` 会保留合法的 `ProvisionError.StatusCode`；普通 error 则转换为 `500`，避免把内部错误细节暴露给客户端。

## 十四、代表性请求调用链

下面的链路按源码中的边界依赖排列，适合在 trace 或日志中逐段核对。每个 handler 都从 `c.Request.Context()` 继承 70 秒 request timeout；SQL、Redis 和 Ory 调用如果超过该上下文，会在响应前返回错误。

### 14.1 列出 team builds

```text
GET /builds?limit=50&cursor=...
  -> OpenAPI: Bearer AND Team
  -> AuthProviderBearerAuth -> user UUID
  -> AuthProviderTeamAuth -> team membership / limits
  -> EnforceBlockedTeam
  -> handlers.GetBuilds
       |- normalize limit to [1, 100]
       |- parse created_at|build UUID cursor
       |- map dashboard statuses to DB status groups
       |- choose query by build UUID / template ID / alias filter
       `- query business PostgreSQL with team_id and limit + 1
  -> map DB status/reason to building|failed|success
  -> return nextCursor from last row
```

SQL 查询同时约束 `team_id`，只关联当前有效的 template assignment 和未软删除 template。过滤值若能解析成 UUID，会先按 build ID 查询；没有命中时，非 UUID 值依次尝试 template ID 和 alias。这个顺序让 template ID 为 UUID 的历史数据仍能按 build ID 语义处理。

`/builds/statuses` 不做分页，但 OpenAPI 和 handler 都把 build ID 数量限制在 100；查询仍带 team 条件，返回结果可能少于请求的 ID 数量，客户端应按返回 ID 建索引而不是按输入顺序补空记录。`/builds/{build_id}` 找不到或不属于当前 team 时统一返回 `404`，避免泄露 build 所属关系。

### 14.2 列出 templates 与默认模板

```text
GET /templates?sort=updated_at_desc&public=true&search=python
  -> team auth + path-free team context
  -> handlers.GetTemplates
       |- team.ClusterID == nil -> includeDefaults = true
       |- parse sort and sort-tagged cursor
       |- normalize limit to [1, 100]
       `- dashboard DB query (team templates UNION optional env_defaults)
  -> latest ready default-tag build supplies build/status fields
  -> return template projection + next cursor
```

默认模板不是复制到每个 team 的行。当 team 没有专用 cluster 时，列表查询将全局 `env_defaults` 合并到 team template projection；有专用 cluster 的 team 则不把全局默认模板混入列表。`public` 过滤值在 SQL 中编码为 all/true/false 三种状态，search 对名称、alias 和 template ID 做不区分大小写的子串匹配。

`GET /templates/defaults` 是用户级 endpoint，不需要 `X-Team-ID`，它直接读取默认环境以及 alias。若页面已经选定 team，仍应使用 `/templates` 获取 team 视角的列表，以免把 cluster 条件丢掉。单个 `/templates/{templateID}` 和 tags endpoints 是团队级，并通过 active team/source template 约束访问。

### 14.3 首次用户 bootstrap

admin 面向 OIDC callback 或内部同步流程调用 `POST /admin/users/bootstrap`，请求本身只接受 admin token。它不是普通用户的自助 endpoint，原因是它需要可信的 issuer、subject 和 email 组合，并负责创建数据库锚点:

```text
POST /admin/users/bootstrap
  -> trim issuer / subject / email
  -> identity.IdentityOrganizationID
  -> BEGIN Auth DB transaction
       |- lookup (issuer, subject)
       |- upsert public user
       |- upsert public.user_identities
       |- if duplicate canonical user differs: delete orphan candidate
       |- lock canonical user FOR UPDATE
       |- existing default team -> commit and maybe retry billing (<30s)
       |- SSO org -> enroll all auto-join teams
       `- otherwise create base_v1 team + default membership
  -> COMMIT
  -> default team: fire billing provision
  -> SetIdentityExternalID via Ory JSON Patch add
  -> return team ID + slug
```

事务只保护 Auth DB 行；Ory 和 billing 都是 commit 之后的外部动作。默认 team 的 billing 失败不会删除刚创建的 team，下一次 bootstrap 在 30 秒窗口内会再次尝试；external ID 回填失败会让这次请求报错，但不会撤销已提交的 team。

SSO 用户不会创建 default team，而是在同一个事务中加入所有 `sso_auto_join` team。没有任何可加入的 team 时返回 `403`，这不是“用户没有权限”的泛化错误，而是组织 SSO 尚未完成配置的信号。

### 14.4 创建额外 team

`POST /teams` 只需要 Bearer，因为新 team 尚未有可携带的 team header。handler 从 context 取得 user ID，再委托 provisioning service:

```text
POST /teams
  -> parse body and trim name
  -> identity.UserOrganizationID
       `- non-empty org -> 403 (SSO-managed)
  -> identity.ProfilesByUserID -> billing email / creator profile
  -> BEGIN Auth DB transaction
       |- upsert public user
       |- lock public user FOR UPDATE
       |- GetTeams...ForUpdate -> count + banned check
       |- create base_v1 team
       |- create non-default membership (added_by = user)
       `- COMMIT
  -> billing POST /internal/teams/provision
  -> failure -> detached 5s DeleteTeamByID compensation
  -> return team ID + slug
```

锁 user 行和带 `FOR UPDATE` 的 team 查询是同一事务的一部分，因此两个并发创建不会都通过“当前 team 数量低于上限”的检查。base tier 限制为 3 个 team；用户只要拥有一个非 base tier，就使用 10 个 team 的上限。已 banned 的 team 关系会让创建被拒绝，即使数量尚未达到上限。

Billing 成功后才向客户端返回成功。补偿删除使用不受客户端断开影响的 detached context；如果 billing 和删除都失败，响应 message 会保留两段错误，日志中应同时按 team ID 检查 billing 与 DB 删除结果。

### 14.5 添加 team member

```text
POST /teams/{teamID}/members
  -> Bearer + X-Team-ID -> blocked check
  -> requireAuthedTeamMatchesPath
  -> parse invitee email
  -> identity.FindProfilesByEmail
       |- search every configured issuer
       |- join Ory subject to public.user_identities
       |- 0 profiles -> 404
       `- >1 profiles -> 409 (handler refuses ambiguity)
  -> if team has sso_organization_id:
       invitee organization must equal team organization, else 400
  -> Auth DB primary: upsert invitee public user anchor
  -> business DB: insert membership (unique conflict -> 400)
  -> invalidate invitee/team Redis membership cache
```

邀请流程不会把 Ory 中“存在但没有 linkage”的 identity 猜测为内部用户。只有能通过 `(issuer, subject)` 映射到 internal user 的 profile 才能进入 membership。对同一个 email 跨多个 issuer 返回多个 internal profile 时，调用方应先解决账号合并或选择问题，再重试。

Auth DB anchor 和业务 DB membership 不在同一个跨库事务中。anchor 写成功而 membership 写失败时，可能留下一个没有 team 关系的 public user；这不会授予访问权限，但排查时不要把该孤立 anchor 误认为 membership 已经成功。

删除成员的链路与添加相反，先锁整个 team membership 集合，再检查目标不是 default member 且剩余数量大于 1，删除成功后清理 `(userID, teamID)` cache。这个锁不能缩小为目标 membership 行，否则两个并发删除仍可能同时通过“不能删最后一人”的检查。

### 14.6 admin 删除用户

```text
DELETE /admin/users/{userId}
  -> AdminApiKeyAuth (constant-time token compare)
  -> identity.PrepareDeleteUser
       `- collect all issuer/subject targets before DB mutation
  -> Auth DB DeletePublicUser
       |- FK violation -> 409; IdP untouched
       `- success -> DB rows gone
  -> detached cleanup context (30s)
  -> delete each IdP identity, up to 3 attempts
  -> 204 on complete; 500 warning if IdP cleanup still fails
```

先准备 IdP target、再删除 DB 行，避免 DB 删除成功后才发现没有目标可清理。反过来先删 IdP 会在 DB 失败时留下无法登录但仍有业务关系的孤儿。DB 删除成功而 IdP 重试失败时，客户端收到明确警告；这不是可安全自动重试整个 delete 的普通 500，运维应根据 user ID 手动核对 IdP。

## 十五、数据一致性与存储边界

### 15.1 Business DB 与 Auth DB

Dashboard API 使用两个 `*Client`:

| client | 数据 | 事务/读写规则 |
| --- | --- | --- |
| `db.Client` | build、active env、template assignment、sandbox record、dashboard template/tag projection | 启动时按 expected migration timestamp 检查；列表和详情按 team 过滤 |
| `authdb.Client` | public user、identity linkage、team、membership、tier、blocked / banned 状态 | 单一 primary 连接；⛔ 2026.29 的「可选 read replica 仅用于可承受延迟的读取」已在 2026.30 随 `AUTH_DB_READ_REPLICA_CONNECTION_STRING` 一起删除。未配置 `AUTH_DB_CONNECTION_STRING` 时回退到业务连接串（`model.go:85-86`） |
| `management.Service`（2026.30） | project 对账、成员投影、limits、cluster 分配 | 持有 `authdb.Client` + `db.Client` **两个** client；**不跨库事务**，见 §零.7 |

两套 DB 不共享一个跨库事务。创建 team 的 Auth DB commit 与 billing HTTP 请求之间、bootstrap 的 Auth DB commit 与 Ory patch 之间都存在短暂不一致窗口。文档、重试和排障必须把它们当作 saga 步骤，而不是宣称“原子完成”。

### 15.2 SQL projection 的稳定性

build/template/tag 查询把数据库内部状态映射为 dashboard 稳定模型:

- build status 先按 DB status group 聚合，再映射为 `building`、`failed`、`success`；reason 只在失败状态变成 `statusMessage`。
- build 列表只取当前 active environment 的 assignment，soft-deleted template 不参与展示；详情和列表都带 team 条件。
- template 详情显示最新 default-tag build 的状态，以及 alias/name；没有 ready build 时字段保持为空，不把旧的失败 build 假装成可用版本。
- tag count、exists、groups、assignments 只连接 ready build。历史 assignment 行存在不代表 tag 对 dashboard 可见。
- tag group 查询使用 window function 限制每组内嵌 assignment 数量，再在外层按 tag 分页；`assignmentLimit` 不会改变 tag group 总数的 keyset 边界。

这种 projection 让页面不需要理解构建表的全部状态，但也意味着“数据库有行”与“API 返回行”不是一回事。遇到模板或 tag 缺失时，应检查 template soft delete、assignment active 标志和 build ready 状态，而不是只查主键。

### 15.3 sandbox record 的兼容行为

`get_sandbox_record.sql` 从 billing `sandbox_logs` 按 `(team_id, sandbox_id)` 读取，可选关联 snapshot/base env、cluster domain 和第一个 alias。它不会访问 ClickHouse，也不会调用 orchestrator。若数据库返回 PostgreSQL `42P01`，handler 将 undefined-table 当作 `404`，以兼容尚未部署 record migration 的旧环境；因此“所有 sandbox record 都 404”时，migration 版本比 sandbox ID 更值得先查。

`retentionExpired` 与 `eventsRetentionExpired` 由 `stopped_at` 加固定或 team limit 计算。它们是 UI 的保留期提示，不是对 Loki、metrics 存储或 ClickHouse 的在线探测。不要因为字段为 false 就推断日志数据一定存在，也不要为了验证字段再新增慢的外部查询。

### 15.4 ClickHouse 与 feature flag

`main.go` 仍然创建 `clickhouse.NewSwitchingClient` 并放进 `APIStore`，切换策略由 LaunchDarkly feature flag 控制，且 `WithAllowNoopDefault(true)` 允许连接串为空。当前 **45** 个 operation（2026.29 为 25 个）没有直接调用该字段；因此:

1. ClickHouse DSN 缺失不会阻止当前 dashboard build/template/team 读操作启动。
2. ClickHouse client 初始化失败仍会让进程退出，因为依赖装配失败会被视为启动错误。
3. 后续新增分析 endpoint 时，必须明确它是可选 noop 还是强依赖，并更新配置、health 语义和本页边界。

这一区分很重要：`CLICKHOUSE_CONNECTION_STRING` 出现在部署环境并不等于当前 API 请求会读取 ClickHouse。

### 15.5 Redis cache 的可见性窗口

team auth 的 Redis key 以 user + team 组合定位。membership 变更成功后 handler 立即调用 invalidation；如果 Redis 不可用，SQL 状态仍然是新值，但后续请求可能在缓存 TTL 内得到旧授权结果，具体行为取决于共享 auth 包对 cache error 的处理。排查“成员已添加但仍 403”时需同时查看 DB commit、invalidation 日志和 Redis 连通性，不能只重试浏览器请求。

## 十六、配置、部署与运行观测

### 16.1 配置清单

`cfg.Parse` 先解析 env，再执行跨字段校验。以下表按“缺失时是否阻止启动”区分:

| 环境变量 | 必填/默认 | 运行时用途 |
| --- | --- | --- |
| `PORT` | 默认 `3010`（`model.go:13`） | HTTP listen address；⛔ 2026.29 时 Nomad 会覆盖为 `$NOMAD_PORT_api`，但 Nomad 部署路径已在 2026.30 退役（见 §零.8） |
| `POSTGRES_CONNECTION_STRING` | 必填且非空 | 业务 DB 和默认 Auth DB DSN |
| `AUTH_DB_CONNECTION_STRING` | 可选，默认业务 DSN（`model.go:85-86`） | Auth DB |
| ⛔ `AUTH_DB_READ_REPLICA_CONNECTION_STRING` | — | **2026.30 已删除**（`model.go` 行 21 在 2026.29） |
| `ADMIN_TOKEN` | 必填且非空 | admin routes，比较时使用 constant-time compare |
| `AUTH_PROVIDER_CONFIG` | 可选格式配置 | 用户侧 JWT issuer、JWKS 和 provider metadata |
| `ADMIN_AUTH_PROVIDER_CONFIG`（2026.30） | 可选格式配置（`model.go:19`） | **admin 侧** service JWT 的 JWKS 来源，喂给 `AdminJWTAuth` |
| `ORY_SDK_URL` | 必填 | Ory admin SDK endpoint |
| `ORY_PROJECT_API_TOKEN` | 必填 | Ory admin API token；不会放在 client 全局 header |
| `REDIS_URL` / `REDIS_CLUSTER_URL` | 至少一项 | auth token 与 team cache |
| `REDIS_TLS_CA_BASE64` | 可选 | Redis TLS CA |
| `REDIS_TLS_ENABLED`（2026.30） | 可选（`model.go:26`） | 显式开启 TLS，不再靠 CA 是否存在推断 |
| `REDIS_PASSWORD`（2026.30） | 可选（`model.go:27`） | Redis 密码认证 |
| `CLICKHOUSE_CONNECTION_STRING` | 可选 | switching client 默认 endpoint |
| `CLICKHOUSE_CONNECTION_STRINGS` | 可选，`;` 分隔 | switching client 候选 endpoints |
| `BILLING_SERVER_URL` / `BILLING_SERVER_API_TOKEN` | 要么都空，要么都非空 | team provision HTTP sink；都空时 noop |
| `DOMAIN_NAME` | 默认空 | LaunchDarkly deployment name |

Redis 两个连接变量都空时，解析错误会带 `config_failure_condition=missing_redis_connection`；Ory URL 或 token 缺失分别是 `missing_ory_sdk_url`、`missing_ory_project_api_token`（三个 failure condition 常量定义在 `model.go:40-43`，Ory URL 的必填检查在 `model.go:101-102`）。billing 只配置一项时不是 noop，而是 sink 初始化失败；这能避免“看似成功但未计费”的 silent misconfiguration。

⚠️ `ADMIN_AUTH_PROVIDER_CONFIG` 与 `AUTH_PROVIDER_CONFIG` 是**两个独立**的 provider 配置：前者给 `AdminJWTAuth`（`main.go:251` 的 `NewJWKSVerifier`），后者给用户侧 `AuthProviderBearerAuth`。把 service JWT 配进 `AUTH_PROVIDER_CONFIG` 不会让 `/v1/management/**` 通过鉴权。

### 16.2 ⛔ Nomad 与 GCP wiring（历史档案，2026.30 起失效）

> **⛔ 本节描述的部署链路在 2026.30 已全部失效。** `iac/` 目录被整体删除（172 文件 → 0，提交 `8a1c48884406b909f64c1239c808d0bc1cbf05bf`），下列 `iac/**` 路径与相对链接均已不存在。**该包在 2026.30 已不再由本仓库的 IaC 部署。** 保留本节是为了说明 2026.29 及以前它是怎么被部署的，不逐条删除链接。详见 §零.8。

2026.29 及以前的部署链路为:

```text
iac/provider-gcp/dashboard-api.tf
  -> Secret Manager / shared locals 组成 dashboard_api_env_vars
  -> iac/modules/job-dashboard-api/main.tf
  -> jobs/dashboard-api.hcl
  -> Nomad Docker task (host network)
```

`provider-gcp/dashboard-api.tf` 把 admin token、Postgres DSN、Redis、Ory、billing 和 telemetry 地址写入 job env；jobspec 只渲染非空值。`AUTH_PROVIDER_CONFIG` 的 JSON 会在 Terraform 层预转义双引号，因为 jobspec 模板把每个值放在 HCL 字符串中。

⛔ 2026.29 及以前的 Nomad job 关键运行参数（**以下全部随 `iac/` 失效**）:

| 项目 | 2026.29 值/规则 |
| --- | --- |
| service | `dashboard-api`，Traefik rule 为 `HostRegexp( dashboard-api.{domain} )` |
| port | dynamic `api`，容器 env `PORT=$NOMAD_PORT_api` |
| network | Docker host network |
| health | `GET /health`，每 3s 检查，3s timeout |
| resources | module 默认 512 MB、1 CPU；`memory_max` 为 memory 的 2 倍 |
| restart | 5s interval 内最多 1 次，delay 5s |
| shutdown | SIGTERM，kill timeout 30s |
| rolling update | 可选 canary=1，healthy deadline 900s，progress deadline 901s |

⛔ 镜像当时由 `iac/modules/job-dashboard-api/Dockerfile` 从仓库根目录多阶段构建。2026.30 起该文件已不存在，构建定义回到包内 [`packages/dashboard-api/Dockerfile`](../packages/dashboard-api/Dockerfile)。Makefile 的 `build` 仍会嵌入 commit SHA 和 expected migration timestamp；服务启动时用后者检查业务 DB 版本。ⓘ 这段排障经验在 2026.30 之后仍成立，只是「jobspec image」这个对照项换成了新部署路径的镜像标签。

### 16.3 health、trace、metrics、log

`GET /health` 只返回 `Health check successful`，不探测 PostgreSQL、Redis、Ory、billing 或 ClickHouse。它适合进程存活和服务注册探活（⛔ 2026.29 时是 Nomad service registration），不代表所有依赖可用。

可观测性装配顺序为:

```text
telemetry.New
  -> OTEL logger core
  -> tracing middleware (skip /health)
  -> metrics middleware (skip /health)
  -> structured access log (skip /health)
  -> handler telemetry events / attributes
```

请求日志会尽量附带 `team.id`；handler 和 provisioning flow 还会写 `user.id`、`build.id`、`template.id`、`sandbox.id` 等属性。billing sink 使用 `team.provision.*` event 和 HTTP status/duration attributes；出现 502/503/504 时应先按 team ID 和 operation 过滤，而不是只看网关 access log。

middleware request timeout 为 70s，HTTP server write timeout 为 75s。billing sink 在自己的 30s 总预算内最多 3 次尝试，每次 HTTP client timeout 10s，并对 429/503 和 transport error 重试。若请求耗时接近 70s，优先检查 SQL/Ory/Redis 或 downstream retries；不要把 HTTP server 的 75s 误认为 billing 单次请求上限。

### 16.4 graceful shutdown

收到 SIGTERM/SIGINT 后，`waitForServiceStop` 停止接受新请求，server 用不受原 request cancel 影响的 30s shutdown context 调用 `http.Server.Shutdown`。随后依次关闭 telemetry、业务/Auth DB、feature flags、ClickHouse、Redis、auth service 等客户端。外部 HTTP 请求若在 shutdown 前已经进入 handler，会按照 70s request context 或 30s server shutdown deadline 结束；因此部署滚动更新期间不应把长时间 provisioning 当作可无限延迟的后台任务。

## 十七、验证地图与变更检查清单

### 17.1 已有测试应覆盖的风险

| 风险 | 推荐先看 |
| --- | --- |
| static `/admin/users/bootstrap` 与 `/admin/users/{userId}` 路由冲突 | `packages/dashboard-api/internal/api/route_conflict_test.go` |
| env 缺失、Redis/Ory failure condition、billing 成对校验 | `packages/dashboard-api/internal/cfg/*_test.go`、`internal/teamprovision/*_test.go` |
| 多 issuer、500 batch、external ID patch、profile 冲突 | `packages/dashboard-api/internal/identity/*_test.go` |
| default team、SSO auto-join、并发 team limit | `packages/dashboard-api/internal/provisioning/*_test.go` |
| invite 组织约束、重复成员、删最后成员、cache invalidation | `packages/dashboard-api/internal/handlers/team_handlers_test.go` |
| admin bootstrap/delete/profile 的 404/409/IdP cleanup 语义 | `packages/dashboard-api/internal/handlers/admin_*_test.go` |
| build/template/sandbox/tag keyset 边界和 ready 过滤 | `packages/dashboard-api/internal/handlers/*_test.go`、`packages/db/pkg/dashboard/*_test.go` |
| **2026.30** `/v1/management/**` 契约、members、limits、cluster 分配、upsert | `packages/dashboard-api/internal/handlers/management_contract_test.go`、`management_members_test.go`、`management_project_limits_test.go`、`management_project_upsert_test.go`、`management_project_cluster_test.go`、`management_cluster_destroy_readiness_test.go` |
| **2026.30** project 状态变更的 sentinel error 与缓存失效 | `packages/dashboard-api/internal/management/*_test.go` |
| **2026.30** team ban / block / cluster 分配的 admin 语义 | `packages/dashboard-api/internal/handlers/admin_team_ban_test.go`、`admin_team_block_test.go`、`admin_team_cluster_test.go` |
| **2026.30** team status / limits 响应 | `packages/dashboard-api/internal/handlers/team_status_test.go`、`team_limits_test.go` |
| **2026.30** legacy mutation 门控与 blocked allowlist | `packages/dashboard-api/internal/middleware/legacy_team_mutations_test.go`、`blocked_team_test.go` |
| **2026.30** 端到端就绪（含 migration / 依赖装配） | `packages/dashboard-api/main_test.go`、`management_readiness_test.go` |

仓库 Makefile 的默认 `test` 运行 `go test -race -v ./...`。涉及 team lock、Redis cache 或外部 provisioning 的改动应保留 race test；只改 Markdown 时无需运行全量 Go 测试，但可用 `git diff --check` 检查格式。

### 17.2 新增 endpoint 的最小变更面

新增 Dashboard operation 时按以下顺序检查:

1. 在 [`spec/openapi-dashboard.yml`](../spec/openapi-dashboard.yml) 声明 path、request/response schema 和准确的 security object。⚠️ 先想清楚是**加一个 OR 分支**（如 2026.30 的 `ApiKeyAuth`）还是在**同一 object 里加一个 AND scheme**——两者语义相反。
2. 重新生成 [`packages/dashboard-api/internal/api`](../packages/dashboard-api/internal/api) 代码，并运行 route conflict test。
3. 在对应 handler 中使用 `c.Request.Context()`、`auth.MustGetTeamID` 或 `auth.GetTeamInfo`，不要从 header 重新解析身份。
4. 若是 team path，调用 `requireAuthedTeamMatchesPath`；若是 blocked team 可读操作，显式更新 `blockedTeamAllowlist`（`internal/middleware/blocked_team.go:14`）。
5. 选择正确 DB client；不要把 Auth DB membership 与业务 DB template 查询放进一个假设存在的跨库事务。
6. 需要 Ory 或 billing 时，定义超时、重试和失败后的补偿语义，并把状态映射到 `sendProvisioningError` 或统一 API error shape。
7. ⚠️ 如果这个 operation 属于管理面，判断它应进 `/admin/**`（`AdminApiKeyAuth` 或 `AdminJWTAuth` 皆可）还是 `/v1/management/**`（**只有 `AdminJWTAuth`**），并确认它不会被 `DisableLegacyTeamMutations` 的 9 条模板误伤。
8. 为 team、user、resource ID 添加 telemetry attributes，并更新本页的端点矩阵、数据源和 architecture 说明。

### 17.3 修改现有 endpoint 的回归问题

重点回归以下行为:

- 调整 OpenAPI security 时，确认 user-only endpoint 不会意外要求 `X-Team-ID`，team endpoint 不会变成 Bearer-only，且新增的 OR 分支没有把某个变更接口意外放开给 `ApiKeyAuth`。
- 修改 SQL projection 时，继续保留 `team_id` 条件、active assignment 条件和 ready build 条件；它们是访问控制的一部分，不只是展示过滤。
- 修改 cursor 时，保持 sort 字段和 tie-breaker ID 同时编码，并拒绝与当前 sort 不匹配的 cursor。
- 修改 team/member mutation 时，验证事务锁覆盖范围和 Redis invalidation 顺序；只改 SQL 不足以保证授权实时性。
- 修改 bootstrap 顺序时，重新评估 DB、billing、Ory 三个外部副作用的补偿策略，特别是 default team 与 additional team 的不同语义。
- ⚠️ 修改 `legacyTeamMutationRoutes`（`internal/middleware/legacy_team_mutations.go:15-25`）时，注意它按 Gin 路由模板匹配，**只拦变更**；把某个 GET 误加进去会让 dashboard 在 flag 打开后直接 412。
- ⚠️ 修改 `/v1/management/**` 的 revision 语义时，保持「旧 revision 被接受但不改状态」这一幂等约定，不要改成报错。
- 修改部署 env 时，确认 Secret Manager 中 URL/token 成对存在，并检查 `PORT`、migration timestamp、health check 与 service port 一致。⛔ 2026.30 起 Nomad/Traefik 已不再是本仓库的部署路径，见 §零.8。

### 17.4 端到端排障顺序

当 dashboard 页面出现连续失败时，按边界由外到内排查:

```text
1. 入口/服务发现是否指向正确 dashboard-api instance（2026.30 起不再是 Traefik/Nomad）
2. /health 是否正常，启动日志 commit_sha / migration 是否匹配
3. OpenAPI 请求是否带正确 method、path、body、Authorization、X-Team-ID 或 X-API-Key
4. 是否被 legacy-mutation 门控（412）或 authentication / blocked middleware 在 handler 前拒绝
5. Redis team cache 与 Auth DB membership 是否一致
6. business DB migration、team-scoped SQL、ready/active 条件是否满足
7. Ory issuer/subject/profile 或 billing retry 是否失败
8. 是否存在跨 DB commit 后的预期补偿窗口，而非单纯“数据丢失”
```

这条顺序能把“客户端没带 team header”“blocked team 被禁止写入”“migration 未部署”“billing 失败已触发补偿”等看似相同的页面错误区分开来。

## 十八、源码与配置交叉索引

为了让后续维护者可以从文档直接跳到实现，下面的索引补充部署和查询边界:

| 主题 | 源码/配置 |
| --- | --- |
| HTTP 入口、timeout、middleware、依赖装配 | [`packages/dashboard-api/main.go`](../packages/dashboard-api/main.go)（authenticator 装配在 `main.go:262-269`） |
| env 解析和 failure condition | [`packages/dashboard-api/internal/cfg/model.go`](../packages/dashboard-api/internal/cfg/model.go) |
| APIStore 依赖容器与 health | [`packages/dashboard-api/internal/handlers/store.go`](../packages/dashboard-api/internal/handlers/store.go) |
| OpenAPI operation/security/response | [`spec/openapi-dashboard.yml`](../spec/openapi-dashboard.yml)（37 path / 45 operation） |
| blocked team allowlist | [`packages/dashboard-api/internal/middleware/blocked_team.go:14`](../packages/dashboard-api/internal/middleware/blocked_team.go) |
| ⭐ legacy team mutation 门控（412） | [`packages/dashboard-api/internal/middleware/legacy_team_mutations.go:15`](../packages/dashboard-api/internal/middleware/legacy_team_mutations.go) |
| ⭐ `/v1/management/**` 状态变更与 sentinel error | [`packages/dashboard-api/internal/management/service.go`](../packages/dashboard-api/internal/management/service.go) |
| ⭐ management handler（含 501 的刻意实现） | [`packages/dashboard-api/internal/handlers/utils_management.go`](../packages/dashboard-api/internal/handlers/utils_management.go)、[`management_project_delete.go`](../packages/dashboard-api/internal/handlers/management_project_delete.go) |
| ⭐ team status / limits handler | [`packages/dashboard-api/internal/handlers/team_status.go`](../packages/dashboard-api/internal/handlers/team_status.go)、[`team_limits.go`](../packages/dashboard-api/internal/handlers/team_limits.go) |
| ⭐ admin cluster 与 team 分配 | [`packages/dashboard-api/internal/handlers/admin_team_cluster.go`](../packages/dashboard-api/internal/handlers/admin_team_cluster.go) |
| Bearer/team/API key/admin authenticator | [`packages/auth/pkg/auth`](../packages/auth/pkg/auth)（ⓘ 2026.30 该公开路径**仍然存在**；其内部包被收进 `pkg/auth/internal/`，见 §零.9） |
| Identity issuer、linkage、Ory directory | [`packages/dashboard-api/internal/identity`](../packages/dashboard-api/internal/identity) |
| OIDC/default/SSO/additional team workflow | [`packages/dashboard-api/internal/provisioning`](../packages/dashboard-api/internal/provisioning) |
| Billing HTTP sink、retry、status mapping | [`packages/dashboard-api/internal/teamprovision/http_sink.go`](../packages/dashboard-api/internal/teamprovision/http_sink.go) |
| Team/member handler 和 cache invalidation | [`packages/dashboard-api/internal/handlers/team_members.go`](../packages/dashboard-api/internal/handlers/team_members.go) |
| Build pagination and status map | [`packages/dashboard-api/internal/handlers/builds_list.go`](../packages/dashboard-api/internal/handlers/builds_list.go) |
| Template/tag dashboard queries | [`packages/db/pkg/dashboard/queries`](../packages/db/pkg/dashboard/queries) |
| Sandbox record query | [`packages/db/queries/sandboxes/get_sandbox_record.sql`](../packages/db/queries/sandboxes/get_sandbox_record.sql) |
| Dashboard migration (`env_defaults`, profile picture) | [`packages/db/pkg/dashboard/migrations/20260316130000_dashboard_add_env_defaults_and_team_profile_picture.sql`](../packages/db/pkg/dashboard/migrations/20260316130000_dashboard_add_env_defaults_and_team_profile_picture.sql) |
| ⛔ Nomad job and health check | [`iac/modules/job-dashboard-api/jobs/dashboard-api.hcl`](../iac/modules/job-dashboard-api/jobs/dashboard-api.hcl) —— **链接已失效**，`iac/` 在 2026.30 整体删除 |
| ⛔ GCP Secret Manager/env wiring | [`iac/provider-gcp/dashboard-api.tf`](../iac/provider-gcp/dashboard-api.tf) —— **链接已失效**，同上 |

这些链接使用 `web-docs` 目录的相对路径；文档页面若被静态站点复制到其他根目录，应保留相同的 `../packages`、`../spec` 层级，避免源码索引在发布后失效。⛔ 最后两行的 `../iac` 层级在 2026.30 已不存在，保留为历史档案（见 §零.8）。

---

> **文档版本**: 已同步至 **2026.30**（tag `2026.30`，提交 `f32ee8a2a50052f32e3632ceb451111a98dd5104`）。本文所有 `file:line` 均以 tag `2026.30` 为准；与 2026.29 有差异处已并列标注。2026.30 的变动清单见 [§零](#零202630-变动速览)。§16.2 的 `iac/**` 部署链路在 2026.30 已整体失效。
