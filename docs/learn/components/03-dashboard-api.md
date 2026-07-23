# Dashboard API

`packages/dashboard-api` 是面向 Web Dashboard 的账户与资源展示控制面：它直接读取共享 PostgreSQL，管理用户、团队和成员关系，并把身份资料与计费开通连接到 Ory 和 Billing。

## 1. 系统位置

Dashboard API 是独立 Go 服务，默认监听 3010，契约来自 [`spec/openapi-dashboard.yml`](../../../spec/openapi-dashboard.yml)。它覆盖：

- build 列表、状态与详情；
- Sandbox 历史 record；
- team 列表、创建、解析、更新和成员管理；
- template 列表、默认模板、详情、tag 与 assignment 浏览；
- admin 用户/team bootstrap、profile 查询与用户删除。

它不是 `packages/api` 的 HTTP 代理。当前 handler 直接通过 core/dashboard/auth sqlc 查询共享 PostgreSQL，外加 Ory profile API 与 Billing provisioning API；它不负责 Sandbox create/pause/resume 或 Template build 执行。

```text
Web Dashboard / auth hook / internal admin
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
3. 创建共享 DB client 和支持 read replica 的 Auth DB client。
4. 创建 LaunchDarkly 与 ClickHouse switching client。
5. 创建 Redis client，并据此装配共享 `auth.Service`。
6. 根据 Billing URL/token 创建 HTTP sink 或 noop sink。
7. 用 Ory SDK endpoint、project token、issuer 和 Auth DB resolver 创建 profile provider。
8. 构造 `handlers.APIStore`，加载 Dashboard OpenAPI 并注册生成路由。
9. 安装 request timeout、OpenAPI auth 和 blocked-team middleware，再启动 HTTP server。

本服务只注册三种 authenticator：`AdminApiKeyAuth`、`AuthProviderBearerAuth` 和 `AuthProviderTeamAuth`。它不接受 E2B API Key 或旧 Access Token。

ClickHouse client 会在启动时创建并放入 `APIStore`，但当前 Dashboard handler 没有调用它；当前资源展示主路径仍是 PostgreSQL。

## 3. 核心机制与关键对象

| 对象 | 职责 | 主要依赖 |
| --- | --- | --- |
| `handlers.APIStore` | 实现 Dashboard `ServerInterface` | core DB、Auth DB、auth、Ory、Billing |
| `db.Client` | build、Sandbox record、成员等 core 查询 | `packages/db/queries` |
| `db.Client.Dashboard` | Dashboard 专用 team/template 投影 | `pkg/dashboard/queries` |
| `authdb.Client` | 用户、identity、team 生命周期和 membership 写入 | primary/read replica |
| `auth.Service` | JWT、team membership 验证与缓存失效 | Redis + Auth DB |
| `teamprovision.TeamProvisionSink` | 新 team 的 Billing 开通 | retrying HTTP 或 noop |
| `userprofile.Provider` | Ory identity 与内部 user UUID 之间的 profile 投影 | Ory API + identity queries |

Dashboard 查询刻意返回“界面投影”，不是数据库原始行。例如 template 列表把 `active_envs`、默认 tag 的 ready build、aliases 和 `env_defaults` 合成 `TeamTemplate`；build 列表把原始 build status group 映射为 Dashboard 状态与消息。

Team 认证仍是两段式：Bearer JWT 先得到内部 user ID，随后 `X-Team-ID` 验证 membership 并装载 team limits。需要 path 中 team ID 的 handler 还会再次检查 path 与已认证 team 一致。

## 4. 主请求或数据流

### 浏览 Team Templates

```text
GET /templates + Bearer JWT + X-Team-ID
  -> AuthProviderBearerAuth: (iss, sub) -> internal user_id
  -> AuthProviderTeamAuth: user_id + team_id -> team + limits
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

- Dashboard 的用户主体必须来自 Auth Provider JWT；API Key 不能用于登录 Dashboard API。
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

## 6. 与其他组件边界

- 与 `packages/api`：共享资源数据模型，但本服务不调度 VM；生命周期请求应进入 API 控制面。
- 与 `packages/auth`：Dashboard 写用户/team/membership，auth 负责后续 JWT 与 membership 认证；写后由 Dashboard 触发缓存失效。
- 与 `packages/db`：大多数读取直达 core queries 或 `Client.Dashboard`，team 生命周期写入使用 `authdb.Write`。
- 与 Ory：Ory 保存 email、name、picture、provider 等 profile；PostgreSQL 保存 canonical user UUID 与 `(iss, sub)` 映射。
- 与 Billing：Dashboard 发送 team provision 事件；Billing 失败的补偿策略由创建场景决定。
- 与 ClickHouse：client 已装配但当前 handler 未使用，不能据此推断 Dashboard 指标来自 ClickHouse。

## 7. 源码阅读顺序

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | [`packages/dashboard-api/main.go`](../../../packages/dashboard-api/main.go) | 服务依赖、认证与 HTTP 生命周期 |
| 2 | [`spec/openapi-dashboard.yml`](../../../spec/openapi-dashboard.yml) | 完整 endpoint 与 security 契约 |
| 3 | [`packages/dashboard-api/internal/handlers/store.go`](../../../packages/dashboard-api/internal/handlers/store.go) | `APIStore` 的组件边界 |
| 4 | [`packages/dashboard-api/internal/handlers/templates_list.go`](../../../packages/dashboard-api/internal/handlers/templates_list.go) | Dashboard 投影、筛选和游标分页 |
| 5 | [`packages/dashboard-api/internal/handlers/builds_list.go`](../../../packages/dashboard-api/internal/handlers/builds_list.go) | build 查询与 status 映射 |
| 6 | [`packages/dashboard-api/internal/handlers/team_creation.go`](../../../packages/dashboard-api/internal/handlers/team_creation.go) | 用户发起的 team 创建入口 |
| 7 | [`packages/dashboard-api/internal/handlers/utils_team_provisioning.go`](../../../packages/dashboard-api/internal/handlers/utils_team_provisioning.go) | bootstrap、锁、事务与补偿 |
| 8 | [`packages/dashboard-api/internal/handlers/team_members.go`](../../../packages/dashboard-api/internal/handlers/team_members.go) | membership 权限与 cache invalidation |
| 9 | [`packages/dashboard-api/internal/userprofile/ory.go`](../../../packages/dashboard-api/internal/userprofile/ory.go) | Ory profile/identity 适配 |
| 10 | [`packages/dashboard-api/internal/teamprovision/http_sink.go`](../../../packages/dashboard-api/internal/teamprovision/http_sink.go) | Billing retry 与错误映射 |
| 11 | [`packages/db/pkg/dashboard/sql_queries`](../../../packages/db/pkg/dashboard/sql_queries) | 页面投影实际执行的 SQL |

## 8. 相关深挖

- [Auth 子系统](../../md/auth-module.md)
- [数据库 Schema](../../md/database-schema.md)
- [Template Tags](../../md/template-tags-module.md)
- [API 控制面](../../md/api-module.md)
- [API Keys](../../md/api-keys-module.md)
- [Admin 认证面](../../md/admin-module.md)
