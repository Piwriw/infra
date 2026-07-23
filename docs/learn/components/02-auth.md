# Auth 认证库

`packages/auth` 是被 API 服务复用的认证与租户上下文库：它验证凭证、解析内部用户、装载 team 与配额，并统一执行 banned/blocked 状态规则。

## 1. 系统位置

Auth 没有 `main.go`，不监听端口，也不拥有 HTTP 路由。宿主服务把它接入 `oapi-codegen` 的 OpenAPI request validator：

```text
OpenAPI security scheme
          |
          v
CreateAuthenticationFunc
          |
          +-- header authenticator
          +-- auth.Service validation
          +-- Redis / Auth DB / OIDC JWKS
          |
          v
Gin context: user_id and/or team
```

`packages/api` 注册六种 authenticator；`packages/dashboard-api` 只注册 Admin、AuthProviderBearer 和 AuthProviderTeam。最终允许哪些凭证由每条 OpenAPI operation 的 `security` 数组决定，而不是 auth 包自行决定。

## 2. 启动/装配

核心工厂是 [`packages/auth/pkg/auth/service.go`](../../../packages/auth/pkg/auth/service.go) 中的 `NewAuthService`：

1. 校验 Redis、Auth DB 与 HTTP client 均已提供。
2. 创建 Redis-backed team cache。
3. 用 Auth DB client 创建 `authStore`。
4. 用 primary 的 `authDB.Write` 创建 OIDC identity lookup。
5. 根据 `AUTH_PROVIDER_CONFIG` 为每个 issuer 执行 discovery，并建立 JWKS verifier。
6. 返回实现公开 `Service` interface 的私有 `authService`。

如果未配置 issuer，服务可以正常启动，API Key 与 Access Token 仍可使用；任何 Auth Provider JWT 验证都会明确返回 401。

宿主随后创建 `Authenticator` 列表并传给 `CreateAuthenticationFunc`。该函数按 OpenAPI 给出的 security scheme 名称分发，并将认证结果写入 Gin context。

## 3. 核心机制与关键对象

| 对象 | 职责 | 数据源 |
| --- | --- | --- |
| `Service` / `authService` | 对外稳定接口与认证编排 | cache、store、verifier |
| `authStoreImpl` | 把认证查询映射到 sqlc，并检查 banned | Auth DB read/write queries |
| `authCache` | 缓存 API key、team ID、user-team membership 对应的完整 team | Redis，TTL 5 分钟 |
| `Verifier` | 依次尝试多个 OIDC issuer strategy | provider config |
| `oidc.Verifier` | 校验签名、exp、issuer、audience，并解析 iss/sub | discovery + JWKS |
| `authIdentityLookup` | 将 `(iss, sub)` 映射为内部 `public.users.id` | primary DB + 1 分钟内存缓存 |
| `commonAuthenticator` | 提取 header、调用 validation、写 Gin context | OpenAPI security input |
| `types.Team` | 聚合 team 行与 `team_limits` | Auth DB query |
| blocked-team middleware | 在认证后按 method/path allowlist 拒绝 blocked team | Gin route + team context |

凭证与认证结果如下：

| Scheme | Header | 验证结果 |
| --- | --- | --- |
| `ApiKeyAuth` | `X-API-Key: e2b_...` | team + limits |
| `AccessTokenAuth` | `Authorization: Bearer sk_e2b_...` | user ID |
| `AuthProviderBearerAuth` | `Authorization: Bearer <JWT>` | user ID |
| `AuthProviderTeamAuth` | `X-Team-ID: <uuid>` | user 所属的 team + limits |
| `AdminApiKeyAuth` | `X-Admin-Token` | admin token 验证成功 |
| `AdminTeamAuth` | `X-Team-ID` | admin 代调时的 team + limits |

## 4. 主请求或数据流

### API Key

```text
X-API-Key
  -> commonAuthenticator 检查 e2b_ 前缀
  -> keys.VerifyKey 校验格式并计算 hash
  -> Redis auth:team cache
       cache miss -> authDB.Read.GetTeamWithTierByAPIKey
                  -> CheckTeamBanned
                  -> 异步 authDB.Write.UpdateLastTimeUsed
  -> types.Team(team + limits)
  -> Gin context[team]
```

缓存值是完整 team 与配额，不是“认证通过”布尔值。因此 tier、blocked 等字段变更后必须失效相关 key，不能只更新数据库。

### OIDC JWT + Team

```text
Authorization: Bearer JWT
  -> issuer strategy 校验 discovery/JWKS 签名、exp、iss、aud
  -> 提取 (iss, sub)
  -> 1 分钟成功结果内存缓存
       miss -> authDB.Write.GetUserIdentity
  -> Gin context[user_id]

X-Team-ID
  -> 从 Gin context 读取 user_id
  -> Redis key: userID-teamID
       miss -> authDB.Read.GetTeamWithTierByTeamAndUser
  -> CheckTeamBanned
  -> Gin context[team]
```

OpenAPI 中两个 scheme 位于同一个 security requirement 时是 AND 关系。Bearer 必须先成功写入 `user_id`，team authenticator 才能验证 membership。

### Admin

Admin token 不落库，使用常量时间比较。需要 team 上下文的普通资源端点会把 `AdminApiKeyAuth` 与 `AdminTeamAuth` 组合；纯 admin endpoint 通常只验证 admin token。

## 5. 设计不变量与故障边界

- 原始 API Key 与 Access Token 不用于 DB 查询；先由 `shared/pkg/keys` 校验格式并 hash。
- API Key 绑定 team，Access Token 和 Auth Provider JWT 先绑定 user；不要混淆主体层级。
- `(oidc_iss, oidc_sub)` 才是外部身份唯一键，JWT 中的 `sub` 单独不全局唯一。
- identity lookup 固定走 primary，因为 bootstrap 刚写入的身份可能尚未复制到 read replica。
- identity 内存缓存只缓存成功结果；not found 与暂时性 DB 错误不会被固定一分钟。
- banned 在所有 team lookup 的 store 层拒绝，因此无法被 route allowlist 绕过。
- blocked 不等于 banned；blocked 在宿主服务的路由中间件检查，并允许服务定义只读/清理白名单。
- user-team membership 变更后必须调用 `InvalidateTeamMemberCache`。
- team、tier 或 API key 变化后应调用 `InvalidateTeamCache`，它删除 team-ID key 与该 team 的 API-key hash keys，但不会删除 `userID-teamID` membership key；成员关系变化必须走上一条逐项失效，否则 JWT + team 路径要等待后台 refresh。
- Access Token 验证不缓存，每次都查询 Auth DB。
- Auth Provider verifier 启动时同步读取 discovery；issuer、JWKS URL 或网络错误会阻止服务装配。
- Header 解析与 scheme 名称必须和 OpenAPI 完全一致，否则认证函数会拒绝未知 scheme。

## 6. 与其他组件边界

- 与 `packages/api`：auth 提供验证原语；API 决定哪些 REST/gRPC 入口需要哪种主体以及 blocked allowlist。
- 与 `packages/dashboard-api`：Dashboard 负责用户 bootstrap、membership 写入和 cache invalidation；auth 负责后续 JWT 与 membership 验证。
- 与 `packages/db`：auth 只依赖 `pkg/auth` sqlc client，不定义表或 migration。
- 与外部 OIDC：auth 只消费标准 discovery、JWKS 和 claims；创建 OIDC 用户、维护 profile 不属于本包。
- 与 Redis：auth cache 共享给多个服务实例；Redis 不保存原始 secret，也不是用户/team 的持久真相。
- 与 OpenAPI：authenticator 是 scheme 的实现，operation security 才是授权入口的声明。

## 7. 源码阅读顺序

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | [`packages/auth/pkg/auth/service.go`](../../../packages/auth/pkg/auth/service.go) | `Service` API、四条验证路径与缓存失效 |
| 2 | [`packages/auth/pkg/auth/middleware.go`](../../../packages/auth/pkg/auth/middleware.go) | Header 提取、六种 authenticator 和 OpenAPI 分发 |
| 3 | [`packages/auth/pkg/auth/gin.go`](../../../packages/auth/pkg/auth/gin.go) | user/team 如何进入 Gin context |
| 4 | [`packages/auth/pkg/auth/auth_store.go`](../../../packages/auth/pkg/auth/auth_store.go) | Auth DB 查询、banned 检查与 last-used 写入 |
| 5 | [`packages/auth/pkg/auth/cache.go`](../../../packages/auth/pkg/auth/cache.go) | Redis key 空间、TTL 与 refresh |
| 6 | [`packages/auth/pkg/auth/verifier.go`](../../../packages/auth/pkg/auth/verifier.go) | 多 issuer strategy 聚合 |
| 7 | [`packages/auth/pkg/auth/oidc/oidc.go`](../../../packages/auth/pkg/auth/oidc/oidc.go) | discovery、JWKS、claims 与 identity lookup |
| 8 | [`packages/auth/pkg/auth/identity_lookup.go`](../../../packages/auth/pkg/auth/identity_lookup.go) | primary 查询和只缓存成功结果 |
| 9 | [`packages/auth/pkg/auth/team_state.go`](../../../packages/auth/pkg/auth/team_state.go) | banned 与 blocked 的差异 |
| 10 | [`packages/auth/pkg/auth/team_middleware.go`](../../../packages/auth/pkg/auth/team_middleware.go) | route allowlist 语义 |
| 11 | [`packages/auth/pkg/types/teams.go`](../../../packages/auth/pkg/types/teams.go) | team 与 limits 聚合模型 |

## 8. 相关深挖

- [Auth 子系统](../../md/auth-module.md)
- [CLI 登录链路](../../md/cli-auth-flow.md)
- [API Keys](../../md/api-keys-module.md)
- [Access Tokens](../../md/access-tokens-module.md)
- [Admin 认证面](../../md/admin-module.md)
- [数据库 Schema](../../md/database-schema.md)
