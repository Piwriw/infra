# Auth 认证库

`packages/auth` 是被 API 服务复用的认证与租户上下文库：它验证凭证、解析内部用户、装载 team 与配额，并统一执行 banned/blocked 状态规则。

## 0. 2026.30 变动速览

这一版对 auth 包做了**结构上的重整**，功能面则换掉了一个 scheme：

| 变动 | 说明 |
| --- | --- |
| **`pkg/auth` 变成纯门面** | 实现全部下沉到 `pkg/auth/internal/{authcontext,middleware,service,team,token}/`；`pkg/auth/*.go` 只剩类型别名与薄包装。原先从 `pkg/auth` 直接引用的内部符号（`oidc.Verifier`、`authStore`、`cache` 等）路径全部变了 |
| **`AccessTokenAuth` scheme 删除** | spec 中已不存在（`grep -c AccessTokenAuth spec/openapi.yml` = 0）。取而代之的是 **`AdminJWTAuth`**（`type: http`、`scheme: bearer`、`bearerFormat: JWT`） |
| **认证器仍是 6 个，但成员换了** | `NewAccessTokenAuthenticator` 消失，新增 `NewAdminJWTAuthenticator(*JWKSVerifier)`。另新增一个泛型 `NewAuthenticator[T]` 给"本包不具名的 scheme"用 |
| **三类 verifier 被明确成一条轴** | `JWKSVerifier` / `OIDCVerifier` / `LinkedOIDCVerifier`，逐层叠加。选低一层是"调用方需要什么"的决定，**不是 token 校验被削弱** |
| **Auth DB 不再分读写副本** | `authdb.Client` 不再有 `Read` / `Write` 两个字段，也不再接受 replica URL；直接内嵌 `*authqueries.Queries` |
| **`GetServiceIssuer` 进入 context API** | 新增 `auth.GetServiceIssuer(c)`，配合 service JWT 使用 |
| **新增公开的 `ProcessSecurityErrors`** | 把 `openapi3filter.SecurityRequirementsError` 归约成一个面向客户端的错误 |

> ⚠️ **`NewJWKSVerifier` 在配置里没有 issuer 时返回 `nil`，而 `nil` verifier 拒绝一切。** 这是刻意的：admin JWT 路径要么校验成功，要么一律拒绝，不存在"没配就放行"。API 侧 JWKS 拉取失败也不致命（只 warn），结果就是 admin JWT 认证全部 401——而不是静默通过。

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

> ⚠️ **"六种"这个数字在 2026.30 没变，但成员换了一个**：2026.29 的第六个是 Access Token，2026.30 换成了 Admin JWT。数数字不足以发现这次变更。

## 2. 启动/装配

核心工厂是 [`packages/auth/pkg/auth/service.go`](../../../packages/auth/pkg/auth/service.go) 中的 `NewAuthService`：

1. 校验 Redis、Auth DB 与 HTTP client 均已提供。
2. 创建 Redis-backed team cache。
3. 用 Auth DB client 创建 `authStore`。
4. 用 Auth DB 创建 OIDC identity lookup。
5. 根据 `AUTH_PROVIDER_CONFIG` 为每个 issuer 执行 discovery，并建立 JWKS verifier。
6. 返回 `authService`。

如果未配置 issuer，服务可以正常启动，API Key 仍可使用；任何 Auth Provider JWT 验证都会明确返回 401。

> ⚠️ **2026.30 起 `pkg/auth/service.go` 只有 25 行**——它只是一个门面，把 `Service` / `authService` 做成类型别名、把 `NewAuthService` 转发给 `internal/service`：
>
> ```go
> type Service = internalauthservice.Service
> type authService = internalauthservice.AuthService
>
> func NewAuthService(...) (*authService, error) {
>     return internalauthservice.NewAuthService(ctx, redisClient, authDB, providerConfig, httpClient)
> }
> ```
>
> 真正要读的实现是 [`packages/auth/pkg/auth/internal/service/service.go`](../../../packages/auth/pkg/auth/internal/service/service.go)。同样的门面结构也适用于 `middleware.go`（58 行）、`token.go`（99 行）、`team.go`（22 行）、`gin.go`（33 行）。

宿主随后创建 `Authenticator` 列表并传给 `CreateAuthenticationFunc`。该函数按 OpenAPI 给出的 security scheme 名称分发，并将认证结果写入 Gin context。

## 3. 核心机制与关键对象

| 对象 | 职责 | 数据源 |
| --- | --- | --- |
| `Service` / `authService` | 对外稳定接口与认证编排（门面在 `pkg/auth/service.go`，实现在 `internal/service/`） | cache、store、verifier |
| `authStoreImpl` | 把认证查询映射到 sqlc，并检查 banned | Auth DB queries（**2026.30 不再分 Read/Write**） |
| `authCache` | 缓存 API key、team ID、user-team membership 对应的完整 team | Redis，TTL 5 分钟 |
| `LinkedOIDCVerifier` | 跨所有 issuer 验证并**解析到内部 user** | provider config + discovery + identity lookup |
| `OIDCVerifier` | 跨所有 issuer 验证并**只报告 token 断言**，不关联任何 user | provider config + discovery |
| `JWKSVerifier` | 只从 issuer 的 JWKS 路径取密钥验签，**不做 OIDC discovery** | provider config + JWKS |
| `oidc.Verifier` | 单 issuer 校验签名、exp、issuer、audience，并解析 iss/sub | discovery + JWKS |
| `authIdentityLookup` | 将 `(iss, sub)` 映射为内部 `public.users.id` | Auth DB + 1 分钟内存缓存 |
| `commonAuthenticator` | 提取 header、调用 validation、写 Gin context | OpenAPI security input |
| `ProcessSecurityErrors` | **2026.30 新增公开 API**：把 security requirements 失败归约成单个客户端错误 | `openapi3filter` 错误组 |
| `types.Team` | 聚合 team 行与 `team_limits` | Auth DB query |
| blocked-team middleware | 在认证后按 method/path allowlist 拒绝 blocked team | Gin route + team context |

### 三类 verifier 是一条轴，不是三个选项

[`packages/auth/pkg/auth/token.go`](../../../packages/auth/pkg/auth/token.go) 的注释把三者说得很清楚：

| Verifier | 密钥从哪来 | 结果带到哪 |
| --- | --- | --- |
| `JWKSVerifier` | issuer 的 JWKS 路径，**没有 discovery 文档** | 只到 claims |
| `OIDCVerifier` | OIDC discovery | token 自己断言的内容 |
| `LinkedOIDCVerifier` | 同 `OIDCVerifier` | 再解析成内部 user |

> ⚠️ **选低一层是"调用方需要什么"的决定，不是 token 校验被削弱。** discovery 与 issuer 校验在两个 OIDC 层级上完全一致。
>
> ⚠️ `JWKSVerifier` **不适合**身份提供商签发的 token：它既不取 discovery 文档，也不交叉核对文档里声明的 issuer。它适合的是**对等服务签发的 token**（没有 discovery 可做）——这正是 admin JWT 的用法。
>
> ⚠️ `OIDCVerifier`（不关联 user 的那个）存在的理由是注册流程：调用方必须在该 subject 成为本地 user **之前**读出它。反过来"给 linked verifier 一个永远答 not-found 的 lookup"会让 not-found 变成一个合法值，任何漏掉的检查都会变成"认证通过的匿名者"。
>
> ⚠️ `NewLinkedOIDCVerifier` 在配置里没有 JWT issuer 时返回 `(nil, nil)`；**nil verifier 拒绝所有验证尝试**。

凭证与认证结果如下：

| Scheme | Header | 验证结果 |
| --- | --- | --- |
| `ApiKeyAuth` | `X-API-Key: e2b_...` | team + limits |
| `AuthProviderBearerAuth` | `Authorization: Bearer <JWT>` | user ID |
| `AuthProviderTeamAuth` | `X-Team-ID: <uuid>` | user 所属的 team + limits |
| `AdminApiKeyAuth` | `X-Admin-Token` | admin token 验证成功 |
| `AdminJWTAuth` | `Authorization: Bearer <JWT>` | **2026.30 新增**：对等服务签发的 service JWT，经 `JWKSVerifier` 校验 |
| `AdminTeamAuth` | `X-Team-ID` | admin 代调时的 team + limits |

> ⛔ **`AccessTokenAuth`（`Authorization: Bearer sk_e2b_...`）在 2026.30 已从 spec 中完全删除。** 用户级 access token 的签发、验证与清理代码都已移除，`access_tokens` 表也被 migration 删掉。详见 [Access Token 退役档案](../access-tokens-module.md)。
>
> ⚠️ scheme 命名里的字母序是有意的：`AuthProviderBearerAuth` 排在 `AuthProviderTeamAuth` 前、`AdminApiKeyAuth` 排在 `AdminTeamAuth` 前，确保 **token 校验先于 team 上下文填充**。`AdminJWTAuth` 插在 `AdminApiKeyAuth` 与 `AdminTeamAuth` 之间也遵循同一规则。

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

### Admin service JWT（2026.30 新增）

这是第二条 admin 认证路径，和 admin token 并列：

```text
Authorization: Bearer <service JWT>
  -> AdminJWTAuth scheme
  -> NewAdminJWTAuthenticator(adminJWTVerifier)
  -> JWKSVerifier 按 issuer 从 JWKS 路径取密钥
       -> 校验签名 / exp / iss / aud
  -> auth.GetServiceIssuer(c) 可读出签发方
  -> Gin context（无 user_id、无 team）
```

- API 侧在 `main.go` 用 `auth.NewJWKSVerifier`（`main.go:437`）构造 verifier；**JWKS 拉取失败只打 warn，不阻断启动**（`main.go:443`），后果是这条路径全部 401。
- `NewJWKSVerifier` 在配置里没有 issuer 时返回 `nil`，**nil verifier 拒绝一切**。
- 用 `JWKSVerifier` 而不是 `OIDCVerifier` 是刻意的：签发方是对等服务，没有 discovery 文档可取。

> ⚠️ 不要把它和 `AuthProviderBearerAuth` 混：后者是**身份提供商**签发给用户的 token，会解析成内部 `user_id`；`AdminJWTAuth` 是**对等服务**签发的，只证明"调用方是可信服务"，不产生 user 上下文。两者都走 `Authorization: Bearer`，靠 operation 的 `security` 数组区分。

### 认证失败如何归约成一个错误（2026.30 新增）

一个 operation 可以声明多个 security requirement（数组之间是 OR，同一数组内是 AND）。全部失败时 `openapi3filter` 给出的是 `SecurityRequirementsError` 错误组，`auth.ProcessSecurityErrors` 负责挑出唯一一个面向客户端的错误：

1. **forbidden 或 blocked team 的判定胜出，无论它排在组里哪个位置。** 理由很直接：那个 team 已经认证通过了，它的状态就是答案。
2. 否则，取**调用方真正尝试过的第一个 scheme**（不匹配 `ErrNoAuthHeader` 的那个）。匹配 `ErrNoAuthHeader` 意味着该 scheme 的 header 压根没发。
3. 一个都没尝试，就取第一组的错误。

错误文本带固定前缀，宿主的错误处理器靠前缀选状态码：`SecurityErrPrefix`、`ForbiddenErrPrefix`、`BlockedErrPrefix`（[`packages/auth/pkg/auth/security.go`](../../../packages/auth/pkg/auth/security.go)）。

## 5. 设计不变量与故障边界

- 原始 API Key 不用于 DB 查询；先由 `shared/pkg/keys` 校验格式并 hash。
- API Key 绑定 team，Auth Provider JWT 先绑定 user；不要混淆主体层级。**Admin service JWT 两者都不绑定**——它只证明调用方是可信服务。
- `(oidc_iss, oidc_sub)` 才是外部身份唯一键，JWT 中的 `sub` 单独不全局唯一。
- identity 内存缓存只缓存成功结果；not found 与暂时性 DB 错误不会被固定一分钟。
- banned 在所有 team lookup 的 store 层拒绝，因此无法被 route allowlist 绕过。
- blocked 不等于 banned；blocked 在宿主服务的路由中间件检查，并允许服务定义只读/清理白名单。
- user-team membership 变更后必须调用 `InvalidateTeamMemberCache`。
- team、tier 或 API key 变化后应调用 `InvalidateTeamCache`，它删除 team-ID key 与该 team 的 API-key hash keys，但不会删除 `userID-teamID` membership key；成员关系变化必须走上一条逐项失效，否则 JWT + team 路径要等待后台 refresh。
- Auth Provider verifier 启动时同步读取 discovery；issuer、JWKS URL 或网络错误会阻止服务装配。
- Header 解析与 scheme 名称必须和 OpenAPI 完全一致，否则认证函数会拒绝未知 scheme。
- **（2026.30）nil verifier 拒绝一切。** `NewJWKSVerifier` / `NewLinkedOIDCVerifier` 在配置未声明 issuer 时返回 `nil`，这个 nil 是"全拒"而不是"全通"。看到 `verifier == nil` 的判空分支不要理解成放行。
- **（2026.30）admin JWT 的 JWKS 拉取失败不阻断启动。** API 只打 warn，结果是该路径全部 401。可用性上这是"少一条认证路径"，安全上不构成降级。
- **（2026.30）`authdb.Client` 只有一条连接池。** 不再有 `Read` / `Write` 之分，也不再接受 replica URL（`NewClient(ctx, databaseURL, options...)`）。原先"identity lookup 固定走 primary 以免读到未复制的身份"这条不变量的前提已不存在——**所有查询都走同一条池**。
- **（2026.30）`AccessTokenAuth` 的验证路径已整体删除。** 不是被 flag 挡住，而是代码不存在了；老 token 无法通过任何方式认证。

## 6. 与其他组件边界

- 与 `packages/api`：auth 提供验证原语；API 决定哪些 REST/gRPC 入口需要哪种主体以及 blocked allowlist。
- 与 `packages/dashboard-api`：Dashboard 负责用户 bootstrap、membership 写入和 cache invalidation；auth 负责后续 JWT 与 membership 验证。
- 与 `packages/db`：auth 只依赖 `packages/db/pkg/auth` 的 sqlc client（`authdb.Client`），不定义表或 migration。**2026.30 起该 client 不再有读写副本之分**，`authdb.Client` 直接内嵌 `*authqueries.Queries`，调用点从 `authDB.Read.X` / `authDB.Write.X` 统一成 `authDB.X`。
- 与外部 OIDC：auth 只消费标准 discovery、JWKS 和 claims；创建 OIDC 用户、维护 profile 不属于本包。
- 与 Redis：auth cache 共享给多个服务实例；Redis 不保存原始 secret，也不是用户/team 的持久真相。
- 与 OpenAPI：authenticator 是 scheme 的实现，operation security 才是授权入口的声明。

## 7. 源码阅读顺序

> ⚠️ **2026.30 的路径几乎全变了。** 实现从 `pkg/auth/` 下沉到 `pkg/auth/internal/`，公开文件只剩门面。按 2026.29 的路径去找 `auth_store.go`、`cache.go`、`verifier.go`、`oidc/oidc.go`、`identity_lookup.go`、`team_state.go`、`team_middleware.go` 都会 404。

| 顺序 | 文件（2026.30） | 阅读目标 |
| --- | --- | --- |
| 1 | [`pkg/auth/service.go`](../../../packages/auth/pkg/auth/service.go) | 25 行门面，看公开面边界 |
| 2 | [`pkg/auth/internal/service/service.go`](../../../packages/auth/pkg/auth/internal/service/service.go) | `Service` API、四条验证路径与缓存失效 |
| 3 | [`pkg/auth/middleware.go`](../../../packages/auth/pkg/auth/middleware.go) + [`internal/middleware/middleware.go`](../../../packages/auth/pkg/auth/internal/middleware/middleware.go) | Header 提取、六种 authenticator 和 OpenAPI 分发 |
| 4 | [`pkg/auth/token.go`](../../../packages/auth/pkg/auth/token.go) | 三类 verifier 的那条轴 |
| 5 | [`pkg/auth/internal/token/jwks/verifier.go`](../../../packages/auth/pkg/auth/internal/token/jwks/verifier.go) | JWKS 路径验签（admin JWT 用） |
| 6 | [`pkg/auth/internal/token/oidc/oidc.go`](../../../packages/auth/pkg/auth/internal/token/oidc/oidc.go) | discovery、JWKS、claims 与 identity lookup |
| 7 | [`pkg/auth/gin.go`](../../../packages/auth/pkg/auth/gin.go) + [`internal/authcontext/context.go`](../../../packages/auth/pkg/auth/internal/authcontext/context.go) | user/team/service issuer 如何进入 Gin context |
| 8 | [`pkg/auth/internal/service/store.go`](../../../packages/auth/pkg/auth/internal/service/store.go) | Auth DB 查询、banned 检查与 last-used 写入 |
| 9 | [`pkg/auth/internal/service/cache.go`](../../../packages/auth/pkg/auth/internal/service/cache.go) | Redis key 空间、TTL 与 refresh |
| 10 | [`pkg/auth/internal/service/identity_lookup.go`](../../../packages/auth/pkg/auth/internal/service/identity_lookup.go) | 只缓存成功结果 |
| 11 | [`pkg/auth/internal/team/state.go`](../../../packages/auth/pkg/auth/internal/team/state.go) | banned 与 blocked 的差异 |
| 12 | [`pkg/auth/internal/team/middleware.go`](../../../packages/auth/pkg/auth/internal/team/middleware.go) | route allowlist 语义 |
| 13 | [`pkg/auth/security.go`](../../../packages/auth/pkg/auth/security.go) | `ProcessSecurityErrors` 的三条归约规则 |
| 14 | [`pkg/auth/consts.go`](../../../packages/auth/pkg/auth/consts.go) | Header 名与 token 前缀常量 |
| 15 | [`pkg/types/teams.go`](../../../packages/auth/pkg/types/teams.go) | team 与 limits 聚合模型 |

> ⚠️ `pkg/auth/consts.go` 里定义了 `HeaderAPIKey` / `HeaderAuthorization` / `HeaderTeamID` / `HeaderAdminToken` 与 `PrefixAPIKey` / `PrefixBearer`。**新加 header 时应该改这里，而不是散落字面量。**

## 8. 相关深挖

- [Auth 子系统](../auth-module.md)
- [CLI 登录链路](../cli-auth-flow.md)
- [API Keys](../api-keys-module.md)
- [Access Token 退役档案](../access-tokens-module.md)
- [Admin 认证面](../admin-module.md)
- [Auth 请求生命周期](../auth-request-lifecycle.md)
- [数据库 Schema](../database-schema.md)

---

*已同步至 **2026.30**。本文引用的所有路径与行为均以 tag `2026.30` 为准。*
