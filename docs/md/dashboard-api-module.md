# Dashboard API 模块深入解析

> 范围: `packages/dashboard-api/` 与 `spec/openapi-dashboard.yml`。本文解释 Dashboard API 为什么独立于主 API、请求怎样完成 OIDC/team 鉴权、用户与团队怎样 provision，以及 build/template/sandbox 历史数据从哪里读取。
>
> 先记住一句话: **Dashboard API 是面向登录用户的控制台聚合层，不负责调度 sandbox，也不直接管理 Firecracker。**

## 一、模块定位

仓库中容易混淆的两个 HTTP 服务是:

| 服务 | 主要调用方 | 主要凭证 | 核心职责 |
| --- | --- | --- | --- |
| `packages/api` | SDK、CLI、内部服务 | API key、access token、OIDC、admin token | sandbox/template/volume 的运行时控制面 |
| `packages/dashboard-api` | Web dashboard、内部管理流程 | OIDC bearer + team header，或 admin token | 用户、团队、成员、控制台列表和历史详情 |

Dashboard API 默认监听 `3010`，OpenAPI 当前包含 23 个 path、25 个 operation。它的当前 handler 主要读取 PostgreSQL/Auth DB，并访问 Ory 与 billing 服务；ClickHouse client 已完成装配但尚未被这 25 个 operation 直接调用。它也不会绕过主 API 去直接调用 orchestrator。

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
      +----> Auth DB primary / optional read replica
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
| Auth DB | public user、OIDC linkage、team membership、tier/limit | 未配置专用 DSN 时回退到业务 PostgreSQL |
| Auth DB read replica | 可承受延迟的 auth 读取 | identity linkage 的关键写后读路径仍使用 primary |
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

### 3.1 三种认证器

Dashboard API 只装配:

| scheme | 输入 | 注入结果 |
| --- | --- | --- |
| `AdminApiKeyAuth` | `X-Admin-Token` | admin 身份 |
| `AuthProviderBearerAuth` | `Authorization: Bearer ...` | internal user ID |
| `AuthProviderTeamAuth` | `X-Team-ID` | team info 与 limits |

它不接受普通 API key 或 access token。原因是 Dashboard API 面向已经通过浏览器身份提供方登录的用户，不是 SDK 数据面入口。

同一个 security object 内的两个 scheme 是 AND 关系。例如:

```yaml
security:
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
```

表示 bearer 与 team header 都必须成功，不是二选一。

## 四、端点分组与数据源

| 领域 | 路径 | 主要数据源 |
| --- | --- | --- |
| health | `GET /health` | 无 |
| builds | `GET /builds`、`/builds/statuses`、`/builds/{build_id}` | 业务 PostgreSQL |
| sandbox history | `GET /sandboxes/{sandboxID}/record` | 业务 PostgreSQL |
| current user/team | `GET/POST /teams`、`GET /teams/resolve` | Auth DB + identity directory |
| team mutation | `PATCH /teams/{teamID}` | PostgreSQL/Auth DB |
| members | `GET/POST /teams/{teamID}/members`、`DELETE .../{userId}` | PostgreSQL/Auth DB + Ory |
| admin identity | `/admin/users/*`、`/admin/user-profiles/*` | Auth DB + Ory |
| admin team bootstrap | `POST /admin/teams/bootstrap` | Auth DB + billing |
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
