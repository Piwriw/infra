# Dashboard API

`packages/dashboard-api` 是面向 Web Dashboard 的账户与资源展示控制面：它直接读取共享 PostgreSQL，管理用户、团队和成员关系，并把身份资料与计费开通连接到 Ory 和 Billing。

> **2026.30 变动**：见下方 §0。本文所有 `file:line` 均以 tag `2026.30` 为准；与 2026.29 行号不同处写作「行 N（2026.30；2026.29 为 M）」。

## 0. 2026.30 变动

### 0.1 契约规模与鉴权

| 项目 | 2026.29 | 2026.30 |
| --- | --- | --- |
| path | 23 | 37 |
| operation | 25 | 45 |
| securityScheme | 3 | 5 |
| tag | builds / sandboxes / teams / templates | 新增 `control-plane-management` |
| schema | — | 新增 13 个 |

`spec/openapi-dashboard.yml` 在 2026.30 为 **+935 / −51**，**没有任何 path 被删除或改名**——全部是新增 path 与既有 path 的 security 扩展。

新增两个 securityScheme：

| scheme | 形态 | 用途 |
| --- | --- | --- |
| `ApiKeyAuth` | `X-API-Key` header | 让 E2B API Key 也能读 build / template 列表 |
| `AdminJWTAuth` | `Authorization: Bearer`（service JWT） | 管理面，与 `X-Admin-Token` 并列 |

⚠️ 2026.29 的文档在这里写的是「只注册三种 authenticator」（`AdminApiKeyAuth`、`AuthProviderBearerAuth`、`AuthProviderTeamAuth`）。2026.30 增至 **5 个** —— `main.go:262` 的 `CreateAuthenticationFunc` 现在注册：

```text
main.go:264  NewApiKeyAuthenticator             -> X-API-Key
main.go:265  NewAdminApiKeyAuthenticator        -> X-Admin-Token
main.go:266  NewAdminJWTAuthenticator           -> service JWT（ADMIN_AUTH_PROVIDER_CONFIG）
main.go:267  NewAuthProviderBearerAuthenticator -> Authorization: Bearer
main.go:268  NewAuthProviderTeamAuthenticator   -> X-Team-ID
```

16 个既有 operation 的 security 被扩展（**都是「增加一种可选凭证」，没有收窄**）：

| 既有 operation | 2026.29 | 2026.30 |
| --- | --- | --- |
| `GET /builds`、`/builds/statuses`、`/builds/{build_id}` | Bearer + Team | `ApiKeyAuth` **或** Bearer + Team |
| `GET /templates`、`/templates/{templateID}` 及 4 个 tag 子路由 | Bearer + Team | `ApiKeyAuth` **或** Bearer + Team |
| `GET /templates/defaults` | Bearer | `ApiKeyAuth` **或** Bearer |
| 6 个 `/admin/**`（bootstrap、profile、用户删除） | `AdminApiKeyAuth` | `AdminApiKeyAuth` **或** `AdminJWTAuth` |

### 0.2 新增 path（14 个 path / 20 个 operation）

行号按 tag `2026.30` 的 `spec/openapi-dashboard.yml` 核对（path 行 / method 行）。

| method | path | 行（2026.30） | 鉴权 | 说明 |
| --- | --- | --- | --- | --- |
| `POST` | `/admin/clusters` | 1731 / 1732 | AdminKey **或** AdminJWT | 创建 cluster，配置不可变；可选 `cluster_id` 做幂等创建 → `201` |
| `DELETE` | `/admin/clusters/{clusterID}` | 1761 / 1762 | AdminKey **或** AdminJWT | 删除无引用 cluster；同事务释放软删除环境引用、保留环境与 build 历史；重复删除成功 → `204` |
| `GET` | `/v1/management/clusters/{clusterID}/destroy-readiness` | 1783 / 1784 | AdminJWT | 该 cluster 是否仍有 active template / snapshot → `204`；有则 `409` |
| `GET` | `/admin/teams/{teamID}/cluster` | 1809 / 1810 | AdminKey **或** AdminJWT | 读 team 的 cluster 分配，**不返回 cluster 凭证** → `200` |
| `PUT` | `/admin/teams/{teamID}/cluster` | 1809 / 1834 | AdminKey **或** AdminJWT | 把 team 指向已存在的 cluster；`preserve_existing=true` 时仅在未分配或已指向同一 cluster 时生效 → `204` |
| `DELETE` | `/admin/teams/{teamID}/cluster/{clusterID}` | 1865 / 1866 | AdminKey **或** AdminJWT | 仅在未分配或正指向该 cluster 时清空 → `204` |
| `PUT` | `/admin/teams/{teamID}/ban` | 1892 / 1893 | AdminKey **或** AdminJWT | 封禁 team，使其 API Key 停止通过鉴权；幂等，**不打断运行中的负载** → `204` |
| `DELETE` | `/admin/teams/{teamID}/ban` | 1892 / 1911 | AdminKey **或** AdminJWT | 解封；幂等 → `204` |
| `PUT` | `/admin/teams/{teamID}/block` | 1930 / 1931 | AdminKey **或** AdminJWT | 带 `reason`（1~1000 字符）封堵，使其无法再启动 sandbox / build；幂等且重复调用**替换** reason → `204` |
| `DELETE` | `/admin/teams/{teamID}/block` | 1930 / 1957 | AdminKey **或** AdminJWT | 解除封堵并清空 reason；幂等 → `204` |
| `GET` | `/teams/{teamID}/status` | 2137 / 2138 | Bearer + Team **或** AdminKey **或** AdminJWT | 返回 `isBlocked` / `isBanned` / `blockedReason`；team 凭证只能读自己所属 team → `200` |
| `GET` | `/teams/{teamID}/limits` | 2163 / 2164 | Bearer + Team **或** AdminKey **或** AdminJWT | 返回原始 `tier` 与已解析的生效 limits → `200` |
| `PUT` | `/v1/management/projects/{projectID}` | 2466 / 2469 | AdminJWT | 创建或对账 project（全量语句，非 patch）→ `200` / `201`；另有 `501` |
| `DELETE` | `/v1/management/projects/{projectID}` | 2466 / 2504 | AdminJWT | ⚠️ 契约声明但**每个 control plane 都回 `501`**，见 §0.4 |
| `PUT` | `/v1/management/projects/{projectID}/members/{userID}` | 2528 / 2532 | AdminJWT | 应用「一个带 revision 的成员投影」；旧 revision 或重复请求被接受但不改状态 → `204` |
| `PUT` | `/v1/management/projects/{projectID}/limits` | 2561 / 2564 | AdminJWT | 对账 project 生效 limits；每个字段都是绝对值，本侧不做算术 → `204`；可能 `501` |
| `PUT` | `/v1/management/clusters/{clusterID}` | 2590 / 2593 | AdminJWT | 注册 cluster → `204` |
| `DELETE` | `/v1/management/clusters/{clusterID}` | 2590 / 2616 | AdminJWT | 删除无引用 cluster → `204` |
| `PUT` | `/v1/management/projects/{projectID}/cluster/{clusterID}` | 2633 / 2637 | AdminJWT | 把 cluster 分配给 project → `204` |
| `DELETE` | `/v1/management/projects/{projectID}/cluster/{clusterID}` | 2633 / 2656 | AdminJWT | 解除该分配 → `204` |

新增的 `components.parameters` 为 `clusterID`、`projectID`、`userID`；新增 `components.responses` 为 `412` 与 `501`。

新增 schema（13 个）：`AdminClusterCreateRequest`、`AdminClusterCreateResponse`、`AdminTeamBlockRequest`、`AdminTeamClusterAssignmentRequest`、`AdminTeamClusterAssignmentResponse`、`ManagementClusterRegistrationRequest`、`ManagementProject`、`ManagementProjectLimits`、`ManagementProjectMemberApplyRequest`、`ManagementProjectMemberIdentity`、`ManagementProjectUpsertRequest`、`TeamLimitsResponse`、`TeamStatusResponse`。

### 0.3 术语迁移：team → project（进行中）

`/v1/management/**` 这组新路由用 `projectID`，而同一份 spec 里的数据面路由仍用 `teamID`。2026.30 的迁移是**并行的两套命名，不是重命名**：

- 管理面：`projects` / `projectID`，`operationId` 前缀 `management*`（如 `managementUpsertProject`）。
- 数据面：`/teams/**` 与 `teamID` 原样保留，新增的 `GET /teams/{teamID}/status`、`/limits` 也仍用 team 命名。
- ⚠️ 同时新增 `internal/middleware/legacy_team_mutations.go`：在 LaunchDarkly flag `disable-legacy-team-mutations` 打开时，`RejectRoutes` 会把 9 条**旧 team 变更路由**拦成 **`412`**（`StatusPreconditionFailed`），message 为 `Legacy team mutations are no longer available. Use the workspace API.`。被拦的 9 条（`legacy_team_mutations.go:16-24`）是 `POST /teams`、`PATCH /teams/:teamID`、`POST|DELETE /teams/:teamID/members[/:userId]`、`POST /admin/users/bootstrap`、`DELETE /admin/users/:userId`、`POST /admin/teams/bootstrap`、`PUT|DELETE /admin/teams/:teamID/cluster[/:clusterID]`。这就是新 `412` response 的来源。

### 0.4 ⚠️ 声明但不实现的 operation

`DELETE /v1/management/projects/{projectID}` 在 spec 里声明为 `204`，但 `internal/handlers/management_project_delete.go` 直接调 `sendNotImplemented`，返回 **`501`**。这不是漏实现，而是刻意决定：`envs` / `snapshots` / `volumes` 以 `ON DELETE NO ACTION` 引用 team，template 删除只写 `deleted_at`，任何建过 template 的 project 都会钉住其 team 行；释放它需要杀掉 sandbox、取消 build、回收已存储 artifact，而这需要本进程不具备的 orchestrator 连接。因此 `PUT .../limits` 也保留了 `501` 作为可能响应。

### 0.5 版本号与目录结构

| 项目 | 2026.29 | 2026.30 |
| --- | --- | --- |
| `packages/dashboard-api/CHANGELOG.md` | **不存在** | 顶部 `## 0.7.0 (2026-09-06)` |
| 文件数 | 75 | 112 |
| 顶层新增 | — | `CHANGELOG.md`、`main_test.go`、`management_readiness_test.go` |
| 新 package | — | `internal/management/`（`project.go`、`members.go`、`limits.go`、`service.go`） |

⚠️ 反直觉：`packages/dashboard-api/` **在 2026.29 上没有任何已发布版本**——该目录当时已有 75 个文件，但 `CHANGELOG.md` 尚不存在，release-please 也未接管它。所以「0.0.1 → 0.7.0」这个跨度虽然真实，起点 0.0.1 **不是 2026.29 的状态**，而是 2026.29→2026.30 窗口内的第一次发版（2026-07-30）。窗口内共 8 次发版：0.0.1 → 0.1.0 → 0.2.0 → 0.3.0 → 0.3.1 → 0.4.0 → 0.5.0 → 0.6.0 → 0.7.0。

同时 **`AUTH_DB_READ_REPLICA_CONNECTION_STRING` 被删除**（`internal/cfg/model.go`：2026.29 行 21 → 2026.30 无此字段），`authdb.Client` 不再有 read replica 概念；新增 `ADMIN_AUTH_PROVIDER_CONFIG`（`model.go:19`）与 `REDIS_TLS_ENABLED` / `REDIS_PASSWORD`（`model.go:26-27`）。

### 0.6 ⛔ 部署链路已失效

`iac/` 在 2026.30 被整体删除（172 文件 → 0，提交 `8a1c48884406b909f64c1239c808d0bc1cbf05bf`，2026-09-09，`chore(deploy): retire Nomad-based deployment ahead of a new deploy path`），根 `self-host.md` 同时删除。本文 §2 提到的 Nomad 部署链、以及 [`dashboard-api-module.md`](../dashboard-api-module.md) §16.2 里的 `iac/provider-gcp/dashboard-api.tf` → `iac/modules/job-dashboard-api/main.tf` 全部失效，保留为历史档案。**该包在 2026.30 已不再由本仓库的 IaC 部署。** 注意 `packages/nomad-nodepool-apm/` 仍然存在（2026.29 的 10 文件 → 2026.30 的 12 文件）。

## 1. 系统位置

Dashboard API 是独立 Go 服务，默认监听 3010（`internal/cfg/model.go:13`），契约来自 [`spec/openapi-dashboard.yml`](../../../spec/openapi-dashboard.yml)，2026.30 含 **37 个 path / 45 个 operation**（2026.29 为 23 / 25）。它覆盖：

- build 列表、状态与详情；
- Sandbox 历史 record；
- team 列表、创建、解析、更新、成员管理，以及 2026.30 新增的 `GET /teams/{teamID}/status` 与 `/limits`；
- template 列表、默认模板、详情、tag 与 assignment 浏览；
- admin 用户/team bootstrap、profile 查询与用户删除；
- 2026.30 新增：admin cluster 注册/删除与 team↔cluster 分配、team ban/block、以及 `/v1/management/**` 管理面（project 对账、成员投影、limits、cluster 分配）。

它不是 `packages/api` 的 HTTP 代理。当前 handler 直接通过 core/dashboard/auth sqlc 查询共享 PostgreSQL，外加 Ory profile API 与 Billing provisioning API；它不负责 Sandbox create/pause/resume 或 Template build 执行。

```text
Web Dashboard / auth hook / internal admin / control-plane management
                 |
                 v
         packages/dashboard-api
        /          |            \
PostgreSQL       Ory API       Billing API
 core/dashboard   profiles     team provision
 + auth queries
```

## 2. 启动/装配

入口是 [`packages/dashboard-api/main.go`](../../../packages/dashboard-api/main.go)：

1. 初始化 telemetry 与结构化日志。
2. 解析配置，并校验主数据库 migration 版本。
3. 创建共享 DB client 与 Auth DB client。⛔ 2026.29 的 read replica client 已删除：`AUTH_DB_READ_REPLICA_CONNECTION_STRING` 在 2026.30 不再是配置项（`internal/cfg/model.go` 行 21 在 2026.29，2026.30 无此字段）。
4. 创建 LaunchDarkly 与 ClickHouse switching client。
5. 创建 Redis client，并据此装配共享 `auth.Service`。
6. 用 `ADMIN_AUTH_PROVIDER_CONFIG` 构造 admin JWKS verifier（`main.go:251`），供 2026.30 新增的 `AdminJWTAuth` 使用。
7. 根据 Billing URL/token 创建 HTTP sink 或 noop sink。
8. 用 Ory SDK endpoint、project token、issuer 和 Auth DB resolver 创建 profile provider（`internal/identity/`）。
9. 构造 `handlers.APIStore`，加载 Dashboard OpenAPI 并注册生成路由。
10. 安装 request timeout、OpenAPI auth、legacy-mutation 门控和 blocked-team middleware，再启动 HTTP server。

2026.30 注册 **5 个** authenticator（`main.go:264-268`）：`ApiKeyAuth`、`AdminApiKeyAuth`、`AdminJWTAuth`、`AuthProviderBearerAuth`、`AuthProviderTeamAuth`。⚠️ 2026.29 只有后三个。旧 Access Token 仍然不接受（该表已在 2026.30 从数据库删除）。

middleware 安装顺序（`main.go:385-386`）：`DisableLegacyTeamMutations` 先于 `EnforceBlockedTeam`，两者都在 OpenAPI validator 之后。前者在 feature flag 打开时把旧 team 变更路由拦成 `412`，见 §0.3。

ClickHouse client 会在启动时创建并放入 `APIStore`，但当前 Dashboard handler 没有调用它；当前资源展示主路径仍是 PostgreSQL。

## 3. 核心机制与关键对象

| 对象 | 职责 | 主要依赖 |
| --- | --- | --- |
| `handlers.APIStore` | 实现 Dashboard `ServerInterface` | core DB、Auth DB、auth、Ory、Billing、`management.Service` |
| `db.Client` | build、Sandbox record、成员等 core 查询 | `packages/db/queries` |
| `db.Client.Dashboard` | Dashboard 专用 team/template 投影 | `packages/db/pkg/dashboard/queries` |
| `authdb.Client` | 用户、identity、team 生命周期和 membership 写入 | `packages/db/pkg/auth`；⛔ read replica 已在 2026.30 移除 |
| `auth.Service` | JWT、team membership 验证与缓存失效 | Redis + Auth DB |
| `teamprovision.TeamProvisionSink` | 新 team 的 Billing 开通 | retrying HTTP 或 noop |
| `identity.Provider` | Ory identity 与内部 user UUID 之间的 profile 投影 | Ory API + identity queries |
| `management.Service`（2026.30 新增） | `/v1/management/**` 的状态变更，位于 handler 之外以便脱离 gin 测试 | auth DB（membership/投影）+ 业务 DB（`project_limits` 与 `team_limits` 视图） |

⚠️ `management.Service` 刻意持有**两个** DB client（`internal/management/service.go`）：membership 与投影走 auth 池，limits 走主池。两者不共享事务——两条连接串分别配置，不要求指向同一数据库。写操作自己负责失效其写入所影响的缓存，并以 sentinel error（如 `ErrProjectNotFound`、`ErrInvalidProjectLimits`）而非数据库错误上报失败。

⚠️ 旧文档写的 `userprofile.Provider` 与 `internal/userprofile/ory.go` 在 2026.29 与 2026.30 **都不存在**：profile/Ory 适配实际在 `internal/identity/`（`ory.go`、`service.go`、`directory.go`、`linkage.go`）。

Dashboard 查询刻意返回“界面投影”，不是数据库原始行。例如 template 列表把 `active_envs`、默认 tag 的 ready build、aliases 和 `env_defaults` 合成 `TeamTemplate`；build 列表把原始 build status group 映射为 Dashboard 状态与消息。

Team 认证仍是两段式：Bearer JWT 先得到内部 user ID，随后 `X-Team-ID` 验证 membership 并装载 team limits。需要 path 中 team ID 的 handler 还会再次检查 path 与已认证 team 一致。

## 4. 主请求或数据流

### 浏览 Team Templates

```text
GET /templates + Bearer JWT + X-Team-ID（2026.30 起也可用 X-API-Key）
  -> AuthProviderBearerAuth: (iss, sub) -> internal user_id
     或 ApiKeyAuth: X-API-Key -> team（二选一，OR 关系）
  -> AuthProviderTeamAuth: user_id + team_id -> team + limits
  -> DisableLegacyTeamMutations（只拦变更路由，GET 不受影响）
  -> blocked-team allowlist 允许只读请求
  -> handler 解析 sort/filter/search/cursor
  -> db.Dashboard.ListTeamTemplatesBy...
       -> team 的 public.active_envs(source=template)
       -> 无 dedicated cluster 时合并 env_defaults
       -> lateral join aliases
       -> default tag 最新 ready build
  -> 生成 sort|value|id next cursor
  -> TeamTemplatesResponse
```

⚠️ `ApiKeyAuth` 与 `AuthProviderBearerAuth + AuthProviderTeamAuth` 在 spec 里是 **两个并列的 security object（OR）**，不是同一个 object 里的 scheme（AND）。因此走 API Key 时不需要 `X-Team-ID`，team 身份直接由 key 解析得到；走 JWT 时两者都必需。这一区别是 2026.30 新增的，容易误读成「多了一种必填凭证」。

### 首次 OIDC 用户 Bootstrap

```text
POST /admin/users/bootstrap + X-Admin-Token
  -> 校验 issuer 必须等于配置的 Ory issuer
  -> Auth DB transaction
       -> 查询/创建 (iss, sub) identity
       -> upsert public.users
       -> 锁定 public user，串行化并发 bootstrap
       -> 已有 default team: 直接复用
       -> 否则创建 base_v1 team + default membership
       -> commit
  -> 请求 Billing provision
  -> 把 canonical public user UUID 回填到 Ory external_id
  -> 返回 team ID + slug
```

Identity 已被另一个并发请求抢先创建时，代码采用数据库返回的 canonical user ID，并删除本请求产生的 orphan candidate user。

### 用户主动创建额外 Team

```text
POST /teams
  -> JWT 得到 user_id
  -> Ory 读取用户 email/profile
  -> Auth DB transaction + FOR UPDATE user lock
  -> 检查 team 数量与 banned team
  -> 创建 team + 非默认 membership
  -> commit
  -> Billing provision
       failure -> 5 秒补偿窗口内删除刚创建的 team
  -> 返回 team ID + slug
```

## 5. 设计不变量与故障边界

- Dashboard 的用户主体必须来自 Auth Provider JWT；API Key 不能用于登录 Dashboard API（2026.30 起 `ApiKeyAuth` 只对 build / template 的只读列表开放，不覆盖任何变更接口）。
- team-scoped operation 必须同时通过 JWT 和 `X-Team-ID` membership 验证。
- 带 `{teamID}` 的成员/更新接口还必须满足 path team ID 等于认证 team ID。
- OIDC bootstrap 只接受配置的 Ory issuer，避免写入 profile provider 无法解析的 identity。
- 用户和 identity 的创建、default team 检查及 membership 写入位于同一 Auth DB transaction。
- `LockPublicUserForUpdate` 让“用户还没有 membership”时的并发 team/bootstrap 也能串行化。
- 默认 team member 不能删除，team 的最后一个 member 也不能删除；删除前会锁定成员集合。
- membership 新增或删除成功后必须失效 `userID-teamID` auth cache。
- 额外 team 的 Billing provision 失败会补偿删除 team；默认 signup team 先持久化，再以可重试方式发 Billing 事件。
- blocked team 可读取 build、template、record 和 member 列表，但 team/member 变更不在 allowlist。
- Template 查询以 `active_envs` 排除软删除项，并只把 ready build 暴露为可用版本。
- Sandbox record 来自 `billing.sandbox_logs` 与 snapshot/template/cluster 的联接，不代表当前运行态。
- Ory 或 Billing 是同步外部依赖；超时或返回错误会直接影响 profile、成员和 team provisioning 请求。
- HTTP request timeout 为 70 秒，write timeout 为 75 秒；Billing sink 自身总预算为 30 秒并最多尝试三次。
- ⚠️ 2026.30 新增：`ban` 与 `block` 是**两种独立状态**（`TeamStatusResponse.isBanned` / `isBlocked`）。ban 让 team 的 API Key 停止通过鉴权但**不打断运行中的负载**；block 让它无法再启动 sandbox / build 并记录 `reason`。两者都幂等，且都可被 `GET /teams/{teamID}/status` 读到。
- ⚠️ 2026.30 新增：cluster 删除是**两阶段**的——先 `destroy-readiness` 或 `DELETE` 确认无 active template / snapshot 且所有 team 分配已解除，才能删。软删除的历史与 team 分配**不**阻塞该检查，重复删除视为成功。`GET /v1/management/clusters/{clusterID}/destroy-readiness` 本身是只读探测，不会阻止后续再创建 template。
- ⚠️ 2026.30 新增：`/v1/management/**` 的 project 变更是**全量对账语句**，不是 patch。`ManagementProjectUpsertRequest` 每次推送都带全部属性；tier 不在其中（创建时由本侧默认值决定，之后任何 push 都不会改动它，limits 单独走 `upsertProjectLimits` 且优先级更高）。member 与 limits 都带 `revision`，**旧 revision 或重复请求被接受但不改状态**（幂等靠 revision 比较，不靠报错）。

## 6. 与其他组件边界

- 与 `packages/api`：共享资源数据模型，但本服务不调度 VM；生命周期请求应进入 API 控制面。
- 与 `packages/auth`：Dashboard 写用户/team/membership，auth 负责后续 JWT 与 membership 认证；写后由 Dashboard 触发缓存失效。⚠️ 该包的公开路径 `packages/auth/pkg/auth` 在 2026.30 **仍然存在**，不要按「整体 internal 化」理解——2026.30 的变化是把它**自己的**内部包收进 `packages/auth/pkg/auth/internal/`（2026.29 时 `pkg/auth` 下是 `oidc/`，2026.30 变成 `internal/`），并把 `pkg/tests` 移走。dashboard-api 与 `main.go` 的 import 路径没有变。
- 与 `packages/db`：大多数读取直达 core queries 或 `Client.Dashboard`，team 生命周期写入使用 `authdb.Client`（即 `packages/db/pkg/auth`）。
- 与 Ory：Ory 保存 email、name、picture、provider 等 profile；PostgreSQL 保存 canonical user UUID 与 `(iss, sub)` 映射。
- 与 Billing：Dashboard 发送 team provision 事件；Billing 失败的补偿策略由创建场景决定。
- 与 ClickHouse：client 已装配但当前 handler 未使用，不能据此推断 Dashboard 指标来自 ClickHouse。
- 与 IaC / 部署：⛔ 见 §0.6，本服务在 2026.30 已不再由本仓库的 IaC 部署。

## 7. 源码阅读顺序

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | [`packages/dashboard-api/main.go:262`](../../../packages/dashboard-api/main.go) | 服务依赖、5 个 authenticator 与 HTTP 生命周期 |
| 2 | [`spec/openapi-dashboard.yml`](../../../spec/openapi-dashboard.yml) | 完整 endpoint 与 security 契约（37 path / 45 operation） |
| 3 | [`packages/dashboard-api/internal/handlers/store.go`](../../../packages/dashboard-api/internal/handlers/store.go) | `APIStore` 的组件边界 |
| 4 | [`packages/dashboard-api/internal/handlers/templates_list.go`](../../../packages/dashboard-api/internal/handlers/templates_list.go) | Dashboard 投影、筛选和游标分页 |
| 5 | [`packages/dashboard-api/internal/handlers/builds_list.go`](../../../packages/dashboard-api/internal/handlers/builds_list.go) | build 查询与 status 映射 |
| 6 | [`packages/dashboard-api/internal/handlers/team_creation.go`](../../../packages/dashboard-api/internal/handlers/team_creation.go) | 用户发起的 team 创建入口 |
| 7 | [`packages/dashboard-api/internal/handlers/utils_provisioning.go`](../../../packages/dashboard-api/internal/handlers/utils_provisioning.go) | bootstrap、锁、事务与补偿 |
| 8 | [`packages/dashboard-api/internal/handlers/team_members.go`](../../../packages/dashboard-api/internal/handlers/team_members.go) | membership 权限与 cache invalidation |
| 9 | [`packages/dashboard-api/internal/identity/ory.go`](../../../packages/dashboard-api/internal/identity/ory.go) | Ory profile/identity 适配 |
| 10 | [`packages/dashboard-api/internal/teamprovision/http_sink.go`](../../../packages/dashboard-api/internal/teamprovision/http_sink.go) | Billing retry 与错误映射 |
| 11 | [`packages/dashboard-api/internal/management/service.go`](../../../packages/dashboard-api/internal/management/service.go) | 2026.30 新增：`/v1/management/**` 的状态变更与 sentinel error |
| 12 | [`packages/dashboard-api/internal/middleware/legacy_team_mutations.go:15`](../../../packages/dashboard-api/internal/middleware/legacy_team_mutations.go) | 2026.30 新增：旧 team 变更路由的 `412` 门控 |
| 13 | [`packages/db/pkg/dashboard/sql_queries`](../../../packages/db/pkg/dashboard/sql_queries) | 页面投影实际执行的 SQL |

⚠️ 第 7 行旧文档写的是 `internal/handlers/utils_team_provisioning.go`，第 9 行写的是 `internal/userprofile/ory.go`——**这两个路径在 2026.29 与 2026.30 都不存在**（`git cat-file -e` 两处均 fatal）。正确路径为上表所列的 `utils_provisioning.go` 与 `internal/identity/ory.go`。注意 `packages/db/pkg/dashboard/` 下同时有 `queries/` 与 `sql_queries/` 两个目录。

## 8. 相关深挖

- [Auth 子系统](../auth-module.md)
- [数据库 Schema](../database-schema.md)
- [Template Tags](../template-tags-module.md)
- [API 控制面](../api-module.md)
- [API Keys](../api-keys-module.md)
- [Admin 认证面](../admin-module.md)
- [Dashboard API 模块深入解析](../dashboard-api-module.md)

---

> **文档版本**：已同步至 **2026.30**（tag `2026.30`，提交 `f32ee8a2a50052f32e3632ceb451111a98dd5104`）。§0 描述 2026.30 的变动；§1 ~ §7 已按 2026.30 修正路径与行号，与 2026.29 不同处已并列标注。§0.6 所述 `iac/**` 路径已随该目录整体删除而失效。
