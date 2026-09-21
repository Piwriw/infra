# Sandbox 基于 Team-ID 的认证详解

> 本文聚焦 **sandbox 资源端点的 team-id 认证**:一个请求如何通过认证器把 `*types.Team` 注入 gin context,sandbox handler 如何取出 `team.ID` 做模板/快照/sandbox 的归属校验、执行 team 级配额限制,以及 team 状态(banned/blocked)在哪些层被裁决。
>
> 与已有文档的边界:
>
> - [`auth-request-lifecycle.md`](./auth-request-lifecycle.md) — **通用** auth pipeline 的 9 层请求生命周期(所有端点共享)
> - [`auth-module.md`](./auth-module.md) — auth 子系统**总览**(组件、配置)
> - [`sandbox-api-module.md`](./sandbox-api-module.md) — sandbox 端点的**业务逻辑**(本文不重复讲状态机、ID 格式、启动语义)
>
> 本文的差异化视角:**team-id 这条线如何在 sandbox 域内贯穿始终**——从认证器注入,到 handler 取用,到归属校验的三种模式,到配额执行点,到 team 状态裁决,到下游传播。读完本文,你应该能回答:"如果我改动了 team 认证的某一层,sandbox 的哪些行为会受影响?"

## 目录

- [一、全景图:team-id 的完整链路](#一全景图team-id-的完整链路)
- [二、认证器装配:谁能把 team 放进 context](#二认证器装配谁能把-team-放进-context)
- [三、`*types.Team` 结构:数据行 + 限制](#三typesteam-结构数据行--限制)
- [四、sandbox handler 的取用模式](#四sandbox-handler-的取用模式)
- [五、端点逐一深入:team-id 在每个 sandbox 端点中的角色](#五端点逐一深入team-id-在每个-sandbox-端点中的角色)
- [六、归属校验的三种模式](#六归属校验的三种模式)
- [七、team 状态裁决:banned 与 blocked](#七team-状态裁决banned-与-blocked)
- [八、team limits 的执行点](#八team-limits-的执行点)
- [九、team-id 向下游的传播](#九team-id-向下游的传播)
- [十、认证后的中间件链](#十认证后的中间件链)
- [十一、特殊路径:deprecated teamID 参数与 admin 旁路](#十一特殊路径deprecated-teamid-参数与-admin-旁路)
- [十二、不变量与安全设计](#十二不变量与安全设计)
- [十三、端到端时序图:POST /sandboxes](#十三端到端时序图post-sandboxes)
- [附录:关键代码路径速查](#附录关键代码路径速查)

---

## 一、全景图:team-id 的完整链路

```
   HTTP 请求(POST /sandboxes、GET /sandboxes/{id}、connect、pause……)
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 1. oapi-codegen 中间件 + AuthenticationFunc                │
│    packages/api/main.go:176-186                            │
│    按 OpenAPI security scheme 分发到 6 个认证器之一        │
│    (2026.29 为 5 个;AccessToken 认证器已删除)              │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 2. commonAuthenticator[T]                                  │
│    packages/auth/pkg/auth/internal/middleware/             │
│        middleware.go:98                                    │
│    提取 header → validationFunc 校验 → setContextFunc 注入 │
└───────────────────────────────────────────────────────────┘
        │  校验成功
        ▼
┌───────────────────────────────────────────────────────────┐
│ 3. gin context 注入                                        │
│    packages/auth/pkg/auth/internal/authcontext/context.go  │
│    (公共层 packages/auth/pkg/auth/gin.go 只是再导出转发)   │
│    key "team" → *types.Team   /   key "user_id" → uuid     │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 4. 认证后中间件链(按序)                                   │
│    main.go:208-218                                         │
│    InitLaunchDarklyContext → ratelimit(per-team) →         │
│    EnforceBlockedTeam(blocked 裁决,ban 在 store 层已做)   │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 5. sandbox handler                                         │
│    auth.MustGetTeamInfo(c) / auth.MustGetTeamID(c)         │
│    team.ID / team.Slug / team.Limits.* 四处使用:          │
│    · 归属校验(模板/snapshot/sandbox)                      │
│    · 配额限制(MaxLengthHours、SandboxConcurrency)          │
│    · 资源寻址(以 teamID 为 key 查 orchestrator/snapshot)  │
│    · 下游传播(orchestrator gRPC、telemetry、posthog)      │
└───────────────────────────────────────────────────────────┘
```

**核心不变量**:sandbox 域内所有 handler 都假设 `"team"` context key 已存在且类型正确——取不到就 panic(`MustGet*`)。这个假设由「路由级 security scheme + 中间件顺序」保证:凡是声明了 team 型认证方案的路由,在进入 handler 前一定已完成注入。

---

## 二、认证器装配:谁能把 team 放进 context

`packages/api/main.go:176-186` 用 `auth.CreateAuthenticationFunc` 装配 6 个认证器:

```go
AuthenticationFunc := auth.CreateAuthenticationFunc(
    []auth.Authenticator{
        auth.NewApiKeyAuthenticator(apiStore.GetTeamFromAPIKey),          // main.go:178
        auth.NewAuthProviderBearerAuthenticator(apiStore.GetUserIDFromAuthProviderToken), // main.go:179
        auth.NewAuthProviderTeamAuthenticator(apiStore.GetTeamFromAuthProviderToken),     // main.go:180
        auth.NewAdminApiKeyAuthenticator(config.AdminToken),              // main.go:181
        auth.NewAdminJWTAuthenticator(adminJWTVerifier),                  // main.go:182 —— 2026.30 新增
        auth.NewAdminTeamAuthenticator(apiStore.GetTeamFromAdminToken),   // main.go:183
    },
    metricsMiddleware.SetProcessingStartTime,
)
```

`CreateAuthenticationFunc`(`packages/auth/pkg/auth/internal/middleware/middleware.go:324-347`;2026.29 为 `packages/auth/pkg/auth/middleware.go:225-248`)按 `input.SecuritySchemeName` 匹配认证器——每个请求只走一个认证器,哪个 scheme 命中由 OpenAPI spec 中路由的 `security` 声明决定。

> ⚠️ 认证器数量仍为 6,但**成分变了**:2026.29 的 `NewAccessTokenAuthenticator` 被删除,新增 `NewAdminJWTAuthenticator`(`main.go:182`)。2026.29 的 5 个认证器位于 `main.go:189-197`。

### 2.1 六种认证器对照表

| 认证器 | Scheme | Header | 校验函数 | context 写入 |
|---|---|---|---|---|
| `NewApiKeyAuthenticator` | `ApiKeyAuth` | `X-API-Key`(前缀 `e2b_`) | `GetTeamFromAPIKey` → `ValidateAPIKey` | `"team"` |
| ⛔ ~~`NewAccessTokenAuthenticator`~~ | ⛔ ~~`AccessTokenAuth`~~ | ⛔ ~~`Authorization: Bearer sk_e2b_`~~ | ⛔ ~~`GetUserFromAccessToken`~~ | ⛔ ~~`"user_id"`~~ |
| `NewAuthProviderBearerAuthenticator` | `AuthProviderBearerAuth` | `Authorization: Bearer`(OIDC JWT) | `GetUserIDFromAuthProviderToken` | `"user_id"` |
| `NewAuthProviderTeamAuthenticator` | `AuthProviderTeamAuth` | `X-Team-Id` | `GetTeamFromAuthProviderToken` | `"team"` |
| `NewAdminApiKeyAuthenticator` | `AdminApiKeyAuth` | `X-Admin-Token` | 常量时间比对 | 无 |
| `NewAdminJWTAuthenticator` | `AdminJWTAuth` | `Authorization: Bearer`(Service JWT) | `JWKSVerifier.Verify` | `"service_issuer"` |
| `NewAdminTeamAuthenticator` | `AdminTeamAuth` | `X-Team-ID` | `GetTeamFromAdminToken` | `"team"` |

**关键区分:把 team 写入 context 的有三条路**(API Key、AuthProviderTeam、AdminTeam),而 **AuthProviderBearer 只写 userID**。这条路的 handler 需要 team 时,必须走「userID → 查用户所有 team → 选默认/匹配 teamID」的 deprecated 解析路径(见第十一章)。

> ⚠️ 上表按**行数**是 7 行,按**当前生效的认证器**是 6 个——AccessToken 行已在 2026.30 整行删除(见 11.2)。
>
> ⚠️ `AdminJWTAuth` 有两种出现形态,别只看一种:**48 处**与 `AdminTeamAuth` 组成同一个 AND 组(`spec/openapi.yml:2383-2384` 等),此时 service JWT 请求**必须同时带 `Authorization: Bearer <service-jwt>` 和 `X-Team-ID`**;另**13 处**与 `AdminApiKeyAuth` 并列成两个 OR 分支,这些端点(见 §2.6 表)上根本没有 `AdminTeamAuth`,team/cluster 身份来自 path 参数。

### 2.2 认证器的泛型骨架

`commonAuthenticator[T]`(`internal/middleware/middleware.go:65-71`;2026.29 `middleware.go:40-46`)把三类 team 型认证器统一为同一模板:

```go
type commonAuthenticator[T any] struct {
    schemeName     string
    header         headerKey
    validationFunc func(ctx context.Context, ginCtx *gin.Context, token string) (T, *APIError)
    setContextFunc func(ginCtx *gin.Context, value T)
    errorMessage   string
}
```

`Authenticate`(`middleware.go:98-146`;2026.29 `middleware.go:67-111`)的三步流水线:

1. **提取** `getHeaderKeysFromRequest`(:76)— header 缺失 → `ErrNoAuthHeader`;前缀不符 → `ErrInvalidAuthHeader`(若该 scheme 独占该 header 且设置了 `malformedError`,则返回更具体的错误,见 2.5)。失败时先 `ginCtx.Status(401)` stamp 状态码,保证所有 scheme 都失败时最终返回 401 而不是 400。
2. **校验** `validationFunc` — 即 `authService.Validate*`(下一节)。失败时若底层错误是 `*ForbiddenError`(banned team),原样上抛;否则包装成带 `errorMessage` 的普通错误。
3. **注入** `setContextFunc`(:141-143)— team 型认证器全部指向 `authcontext.SetTeamInfo`。

### 2.3 team 型认证器的验证路径

**路径 A:API Key → 单步直达 team**(`internal/service/service.go:97` `ValidateAPIKey`;2026.29 `service.go:93`)

```
X-API-Key: e2b_xxx
    → keys.VerifyKey 校验格式
    → hashed key 查 teamCache(Redis,TTL=5min,internal/service/cache.go:14)→ miss 时查 authStore
    → authStore.GetTeamByHashedAPIKey(internal/service/store.go:30)
        · 查 team + tier + limits(store.go:38,单连接——2026.30 起不再区分读写副本)
        · CheckTeamBanned 在此层强制(store.go:43)→ banned 直接失败
        · 异步 goroutine 更新 last_time_used(store.go:47-54,不阻塞请求)
    → 返回 *types.Team → setTeamInfo
```

**路径 B:OIDC 两段式:先用户、后 team**(`internal/service/service.go:188` `ValidateAuthProviderTeam`;2026.29 `service.go:213`)

```
Authorization: Bearer <OIDC JWT>   → AuthProviderBearerAuth → "user_id" 写入 context
X-Team-Id: <team-uuid>             → AuthProviderTeamAuth   → 校验 team
    ValidateAuthProviderTeam:
        1. 从 gin context 读 userID(service.go:189,依赖前一个 scheme 已成功)
        2. 按 (userID, teamID) 查 teamCache → GetTeamByIDAndUserID(store.go:79)
           SQL 按 team_id + user_id(成员关系)过滤 → 非成员直接查不到 → 403
        3. CheckTeamBanned 同样强制
        4. 返回 team → setTeamInfo
```

> **不变量**:`ValidateAuthProviderTeam` 绝不信任请求头里自带的 teamID——它必须和 context 中已认证的 userID 一起命中 team 成员关系才通过。这保证了「先证明你是谁,再证明你属于这个 team」的顺序。
>
> 缓存 key 为 `"{userID}-{teamID}"`(`internal/service/service.go:304-306` `teamMemberCacheKey`;2026.29 `service.go:276-278`),成员关系变更时通过 `InvalidateTeamMemberCache`(`service.go:235`;2026.29 `service.go:256`)失效。

**路径 C:admin 旁路**(`packages/api/internal/handlers/store.go:552` `GetTeamFromAdminToken`;2026.29 `store.go:432`)

```
X-Team-ID: <team-uuid>(+ X-Admin-Token 或 AdminJWTAuth scheme)
    → 直接 parse teamID → authService.GetTeamByID
    → 不校验成员关系,只查 team 是否存在 + CheckTeamBanned
```

### 2.4 写入与读取

`packages/auth/pkg/auth/internal/authcontext/context.go`(2026.30 新增包;2026.29 为 `packages/auth/pkg/auth/gin.go`):

```go
const (
    teamContextKey          = "team"            // authcontext/context.go:11
    userIDContextKey        = "user_id"         // authcontext/context.go:12
    serviceIssuerContextKey = "service_issuer"  // authcontext/context.go:13 —— 2026.30 新增
)

func SetTeamInfo(c *gin.Context, t *types.Team)       { ... }   // context.go:33
func GetTeamInfo(c *gin.Context) (*types.Team, bool)  { ... }   // context.go:50
func MustGetTeamInfo(c *gin.Context) *types.Team      { panic if absent }  // context.go:37
func MustGetTeamID(c *gin.Context) uuid.UUID          { ... }   // context.go:46
func SetServiceIssuer(c *gin.Context, issuer string)  { ... }   // context.go:71 —— 2026.30 新增
func GetServiceIssuer(c *gin.Context) (string, bool)  { ... }   // context.go:75 —— 2026.30 新增
```

公共层 `packages/auth/pkg/auth/gin.go` 只有 6 个转发函数(`:11` `GetUserID`、`:15` `MustGetUserID`、`:19` `MustGetTeamInfo`、`:23` `MustGetTeamID`、`:27` `GetTeamInfo`、`:31` `GetServiceIssuer`),handler 侧的调用形式 `auth.MustGetTeamInfo(c)` **完全不变**。

两个 context key 是**字符串字面量**,与 `sandbox_create.go:72` 的 `c.Set("teamID", teamInfo.Team.ID.String())`(字符串型,供日志/telemetry 使用)不是一回事——handler 取 team 一律走 `auth.GetTeamInfo`,不要被那个字符串 key 迷惑。

### 2.5（2026.30 变动）包结构重组:实现移入 `internal/`,公共层变为再导出

2026.30 把 `packages/auth/pkg/auth/*.go` 的全部实现搬进 `packages/auth/pkg/auth/internal/**`,公共目录只保留**类型别名 + 转发函数**。这不是行为变更,但**所有 `file:line` 引用都变了**——阅读本文时请认准 2026.30 的路径。

路径映射(2026.29 → 2026.30):

| 2026.29 | 2026.30 |
|---|---|
| `auth_store.go` | `internal/service/store.go` |
| `cache.go` | `internal/service/cache.go` |
| `identity_lookup.go` | `internal/service/identity_lookup.go` |
| `service.go`(实现) | `internal/service/service.go` |
| `middleware.go`(实现) | `internal/middleware/middleware.go` |
| `verifier.go` | `internal/token/provider.go` |
| `provider_config_parse.go` | `internal/token/provider_config_parse.go` |
| `oidc/` | `internal/token/jwks/`(验签)+ `internal/token/oidc/`(身份) |
| `team_state.go` | `internal/team/state.go` |
| `team_middleware.go` | `internal/team/middleware.go` |
| `gin.go`(实现) | `internal/authcontext/context.go`(新包) |
| ⛔ `packages/auth/pkg/tests/sign_token.go` | 整个目录删除 |

公共层各文件行数(2026.30):`token.go` 99、`middleware.go` 58、`security.go` 52、`gin.go` 33、`service.go` 25、`testing.go` 25、`team.go` 22、`error.go` 15、`consts.go` 13。

> ⚠️ **跨服务调用方看到的 API 不变,但 `Service` 变成了接口别名**:`auth.Service = internalauthservice.Service`(`packages/auth/pkg/auth/service.go:13`),`auth.NewAuthService(ctx, redisClient, authDB, providerConfig, httpClient)`(`service.go:17-24`)仍是 5 参签名。API 侧 `packages/api/internal/handlers/store.go:344` 以别名 `sharedauth` 导入,所以源码里写的是 `sharedauth.NewAuthService(...)`(2026.29 为 `store.go:232`);dashboard-api 在 `packages/dashboard-api/main.go:194`(2026.29 `:193`)。

### 2.6（2026.30 新增）AdminJWTAuth:Service JWT 认证

2026.30 引入 security scheme `AdminJWTAuth`(`spec/openapi.yml:31`):

```yaml
AdminJWTAuth:
  type: http
  scheme: bearer
  bearerFormat: JWT
```

它用于「**服务对服务**」调用:调用方持有一个由对端服务签发的 JWT,而不是 E2B 的 admin token 或 API key。它在各路由的 `security:` 块中共出现 **61 次,但分成两种形态**:

| 形态 | 数量 | 写法 | 用在哪 |
| --- | --- | --- | --- |
| **与 `AdminTeamAuth` 同组**(AND) | 48 | `- AdminJWTAuth: []`<br>`  AdminTeamAuth: []` | 面向用户的端点(sandboxes、secrets 等),既要服务身份又要 team 上下文 |
| **与 `AdminApiKeyAuth` 并列**(OR) | 13 | `- AdminApiKeyAuth: []`<br>`- AdminJWTAuth: []` | 纯 admin 端点,见下表 |

```yaml
# 形态一:同一个 AND 组(spec/openapi.yml:2383-2384)
- AdminJWTAuth: []
  AdminTeamAuth: []     # ← team 归属由 X-Team-ID 决定

# 形态二:两个并列的 OR 分支 —— 这些端点上根本没有 AdminTeamAuth
- AdminApiKeyAuth: []
- AdminJWTAuth: []       # ← 身份完全由 service JWT 承担
```

> ⚠️ **形态二里没有 `AdminTeamAuth`,team 归属来自 path 参数。** 这 13 个端点是:

| 路径 | 说明 |
| --- | --- |
| `GET /nodes` | 列节点 |
| `GET /nodes/{nodeID}` | 节点详情 |
| `POST /nodes/{nodeID}` | 覆盖节点状态 |
| `POST /admin/teams/{teamID}/sandboxes/kill` | team 来自 path |
| `GET /admin/sandboxes/running-counts` | **2026.30 新增端点** |
| `POST /admin/teams/{teamID}/builds/cancel` | team 来自 path |
| `POST /admin/teams/{teamID}/api-keys` | team 来自 path |
| `DELETE /admin/teams/{teamID}/api-keys/{apiKeyID}` | team 来自 path |
| `GET /clusters/{clusterID}/rigs` | **2026.30 新增** |
| `GET /clusters/{clusterID}/rigs/{rigID}/capacity` | **2026.30 新增** |
| `POST /clusters/{clusterID}/rigs/{rigID}/instances` | **2026.30 新增** |
| `DELETE /clusters/{clusterID}/rigs/instances/{instanceID}` | **2026.30 新增** |
| `GET /clusters/{clusterID}/rigs/{rigID}/errors` | **2026.30 新增** |

实现(`packages/auth/pkg/auth/internal/middleware/middleware.go:263-285`):

```go
func NewAdminJWTAuthenticator(verifier *token.JWKSVerifier) Authenticator {
    return &commonAuthenticator[string]{
        schemeName: "AdminJWTAuth",
        header:     headerKey{name: HeaderAuthorization, removePrefix: PrefixBearer},
        validationFunc: func(ctx context.Context, _ *gin.Context, token string) (string, *APIError) {
            claims, err := verifier.Verify(ctx, token)      // :271
            ...
            issuer, err := claims.GetIssuer()               // :275
            return issuer, nil
        },
        setContextFunc: authcontext.SetServiceIssuer,       // :282
        errorMessage:   "Invalid service token.",
    }
}
```

> ⚠️ **构造器不做 nil 检查**(`middleware.go:263`)。安全性来自 `JWKSVerifier.Verify` 的 nil-receiver 处理:`packages/auth/pkg/auth/internal/token/jwks_verifier.go:58` 有 `if v == nil || len(v.verifiers) == 0 { return nil, errors.New("service token verifier is not configured") }`。所以「没配 `ADMIN_AUTH_PROVIDER_CONFIG`」= 一切 service JWT 请求 401,而不是启动失败或 panic。

配置与启动:

- 环境变量 `ADMIN_AUTH_PROVIDER_CONFIG` — `packages/api/internal/cfg/model.go:136`(类型 `sharedauth.ProviderConfig`);相邻的 `AUTH_PROVIDER_CONFIG` 在 `:135`。dashboard-api 对应 `packages/dashboard-api/internal/cfg/model.go:19`。
- 构造 verifier:`auth.NewJWKSVerifier(ctx, config.AdminAuthProvider, http.DefaultClient)` — `packages/api/main.go:437`;dashboard-api 为 `packages/dashboard-api/main.go:251`。
- `packages/api/main.go:443-445`:verifier 为 nil 时**只打 Warn 并继续**——`"ADMIN_AUTH_PROVIDER_CONFIG is not configured; admin JWT requests will return 401"`。JSON 解析失败才 `main.go:437-442` 记日志并 `return 1`。
- `NewGinServer` 新增了 `adminJWTVerifier *auth.JWKSVerifier` 参数(`packages/api/main.go:101`),调用点 `main.go:473`。
- 认证器**无条件注册**(`packages/api/main.go:182`),不按配置开关。

时钟容差:`jwksClockSkew = 30 * time.Second`(`internal/token/jwks_verifier.go:18`),通过 `jwks.WithParserOptions(jwt.WithLeeway(jwksClockSkew))` 应用(`:44`)。service token 生命周期短,不设 leeway 会因轻微时钟偏差拒绝合法 token。

**三种 verifier 的层次**(`internal/token/provider.go`,公共别名见 `packages/auth/pkg/auth/token.go:39,62,92`):

| 类型 | 定位 | 行号 |
|---|---|---|
| `JWKSVerifier` | 只从 issuer 的 JWKS 路径取密钥,**不做 OIDC discovery**,不做身份映射 | `internal/token/jwks_verifier.go:26` |
| `OIDCVerifier` | discovery + claims,返回 `TokenIdentity`,**不映射**到内部用户 | `internal/token/provider.go:59-61` |
| `LinkedOIDCVerifier` | 前者 + `IdentityLookup`,即 2026.29 的 `Verifier` | `internal/token/provider.go:69-73` |

`NewVerifierFromIssuerJWKS`(无 discovery)在 `internal/token/jwks/verifier.go:79`,并在 `:80` 显式清空 `DiscoveryURL`;HTTP 超时 `httpTimeout = 10 * time.Second`(`internal/token/jwks/verifier.go:22`;2026.29 为 `oidcHTTPTimeout` at `oidc/oidc.go:23`)。

> ⚠️ `NewLinkedOIDCVerifier` 只在「配了 issuer 但 lookup 为 nil」时报错(`internal/token/provider.go:89-91`);配置为空时返回 `(nil, nil)`——「未配置 auth provider」是受支持的状态,不是启动失败。

### 2.7（2026.30 新增）ProcessSecurityErrors:安全需求错误的统一选择

2026.29 里「从一组失败的 security scheme 中挑出唯一给客户端看的错误」的逻辑写死在 `packages/api/internal/utils/error.go:120-147` 的 `processCustomErrors` 里。2026.30 把它上移到 auth 包:`packages/auth/pkg/auth/security.go:24` `ProcessSecurityErrors`,前缀常量也一并导出:

```go
const (
    SecurityErrPrefix  = "error in openapi3filter.SecurityRequirementsError: security requirements failed: " // security.go:13
    ForbiddenErrPrefix = "team forbidden: "  // security.go:14
    BlockedErrPrefix   = "team blocked: "    // security.go:15
)
```

选择规则(`security.go:24-52`):

1. 先整组扫描——**banned / blocked 的判定无论排在哪个位置都优先胜出**,分别返回 `ForbiddenErrPrefix` / `BlockedErrPrefix` 前缀。
2. 否则取**调用方真正尝试过的第一个 scheme** 的错误(跳过匹配 `ErrNoAuthHeader` 的项,因为那代表该 scheme 的 header 根本没发)。
3. 一个都没尝试过时,取第一个错误。

调用方:`packages/api/internal/utils/error.go:133`(替换了原 `processCustomErrors`),前缀判断在 `:83`(403)与 `:98`(保留原状态码)。

> ⚠️ 前缀常量从 `packages/api/internal/utils/error.go:18-22` 的**未导出** const(`securityErrPrefix` 等)变成了 `packages/auth/pkg/auth/security.go` 的**导出** const,名字也从驼峰改成了 `SecurityErrPrefix` 这类形式。跨服务复用同一套判定时,`packages/auth` 是唯一真源。


---

## 三、`*types.Team` 结构:数据行 + 限制

`packages/auth/pkg/types/teams.go:7-15`:

```go
type Team struct {
    *authqueries.Team   // DB 行:ID、Slug、Name、ClusterID、IsBanned、IsBlocked、BlockedReason……
    Limits *TeamLimits
}

func (t *Team) TeamID() string { return t.Team.ID.String() }
```

`TeamLimits`(`packages/auth/pkg/types/limits.go:3-16`;2026.29 为 `:3-13`)——sandbox 域直接消费的字段:

| 字段 | sandbox 域用途 |
|---|---|
| `MaxLengthHours` | create/connect/resume/fork 的 timeout 上限校验 |
| `SandboxConcurrency` | 创建时的 reservation 上限、fork 的 count 上限 |
| `MaxVcpu` / `MaxRamMb` / `DiskMb` | 资源规格校验 |
| `BuildConcurrency` / `EventsTTLDays` | 模板构建域(本文不展开) |
| `DefaultFreeDiskSizeMb` / `MaxFreeDiskSizeMb` | 免费磁盘配额(2026.30 新增字段) |

`newTeamLimits`(`teams.go:17-32`;2026.29 `teams.go:17-29`)从 `authqueries.TeamLimit` 行构造。**所有 limits 都来自 auth DB 的 team 查询**——即认证器校验成功后 limits 已经在内存里,handler 零额外查询。

> ⚠️ 2026.30 把 `newTeamLimits` 里的一堆 `int64(...)` 显式转换去掉了(DB 生成代码的字段类型已统一为 `int64`),并新增两个免费磁盘字段。对 sandbox 域的语义没有影响。

---

## 四、sandbox handler 的取用模式

sandbox 域的所有 handler 统一两种取法,不存在第三种:

```go
teamInfo := auth.MustGetTeamInfo(c)  // 需要 limits、slug、cluster 等完整信息时
teamID   := auth.MustGetTeamID(c)    // 只需要 ID 做归属校验/寻址时
```

| Handler | 取用 | 行号(2026.30;2026.29 见括注) |
|---|---|---|
| `PostSandboxes`(create) | `MustGetTeamInfo` | sandbox_create.go:70(2026.29 为 `:63`) |
| `GetSandboxesSandboxID`(get) | `MustGetTeamInfo` | sandbox_get.go:100(2026.29 为 `:97`) |
| `PostSandboxesSandboxIDConnect` | `MustGetTeamInfo` | sandbox_connect.go:46(2026.29 为 `:28`) |
| `PostSandboxesSandboxIDPause` | `MustGetTeamID` | sandbox_pause.go:49(2026.29 为 `:30`) |
| `PostSandboxesSandboxIDResume` | `MustGetTeamInfo` | sandbox_resume.go:51(2026.29 为 `:32`) |
| `PostSandboxesSandboxIDFork` | `MustGetTeamInfo` | sandbox_fork.go:40(2026.29 为 `:41`) |
| `DeleteSandboxesSandboxID`(kill) | `MustGetTeamID` | sandbox_kill.go:53(未变) |
| `PostSandboxesSandboxIDTimeout` | `MustGetTeamID` | sandbox_timeout.go:33(未变) |
| `GetSandboxes` / `GetV2Sandboxes`(list) | `MustGetTeamInfo` | sandboxes_list.go:211,246(2026.29 为 `:102,137`) |
| `GetSandboxesSandboxIDLogs` / Metrics | `MustGetTeamInfo` | sandbox_logs.go:33,62 / sandbox_metrics.go:28(均未变) |

> ⚠️ sandbox handler 在 2026.30 普遍被重排(新增 trace/日志/校验辅助函数),**行号普遍右移**。本文所有 sandbox handler 行号均以 2026.30 为准并标注了 2026.29 的值。

**模式规律**:凡是需要做**配额校验**(timeout vs MaxLengthHours)或**构造新资源**(create/fork 要传整个 team 给 orchestrator)的端点,取 `MustGetTeamInfo`;只做**操作与归属校验**的端点(pause/kill/timeout)取 `MustGetTeamID`。

---

## 五、端点逐一深入:team-id 在每个 sandbox 端点中的角色

### 5.1 POST /sandboxes(创建)

`sandbox_create.go:66-371`(2026.29 为 `:59-131` 的头部区段),team-id 的五个使用点:

```go
teamInfo := auth.MustGetTeamInfo(c)                       // :70 —— 2026.29 为 :63
c.Set("teamID", teamInfo.Team.ID.String())                // :72 —— 字符串型,供日志上下文

clusterID := clusters.WithClusterFallback(teamInfo.Team.ClusterID)  // :97 —— 按 team 的 cluster 亲和路由
aliasInfo, err := a.templateCache.ResolveAlias(ctx, identifier, teamInfo.Team.Slug) // :98 —— 以 team slug 解析模板别名
env, build, err := a.templateCache.Get(ctx, aliasInfo.TemplateID, tag, teamInfo.Team.ID, clusterID) // :107 —— 以 teamID 取模板 build
    // 失败时用 aliasInfo.TeamID == teamInfo.Team.ID 决定错误消息是否泄露模板存在性(:109)
```

接着 `:160` 校验 timeout 上限(2026.29 为 `:157` 的内联比较):

```go
timeout, apiErr := validateAndParseTimeout(body.Timeout, teamInfo.Limits.MaxLengthHours)  // :160
```

后续整个 `teamInfo`(含 Limits)被传入 `a.startSandbox(...)`(`:340`,内部走 `a.orchestrator.CreateSandbox`),由 orchestrator 客户端做并发 reservation(见第八章)。

> ⚠️ 2026.30 起 timeout 校验被抽成 `validateAndParseTimeout`(`packages/api/internal/handlers/timeout_helper.go:18-39`),create/connect/resume/fork 共用同一实现。**`Timeout cannot be greater than %d hours` 这条错误字符串没变**,但语义有细微差异:新版在 `rawTimeout != nil` 且 `<= 0` 时先返回 `"Timeout must be greater than 0"`,旧版会落到同一句 MaxLengthHours 提示。connect 端点(`sandbox_connect.go:64`)仍保留旧的内联比较写法。

**与 team 相关的后续校验**:

- `convertAPIVolumesToOrchestratorVolumes`(`:502`,调用点 `:290`;2026.29 `:424`)→ `getDBVolumesMap(ctx, sqlClient, teamID, ...)`(`:582`,调用点 `:520`;2026.29 `:504`)——volume 查询**直接按 teamID 过滤 SQL**(`TeamID: teamID` 参数),volume 不属于本 team 时根本查不到,属于「查询即校验」模式。
- `validateNetworkConfig`(`:707`,调用点 `:235`;2026.29 `:629`)→ `validateNetworkRules`(`:828`;2026.29 `:713`)——feature flag 以 `featureflags.TeamContext(teamID.String())` 做 team 级灰度(`:833`;2026.29 `:718`),非灰度 team 用 transform rules 直接 400。2026.30 起 `validateNetworkConfig`/`validateNetworkRules` 多了一个 `maxDomains int` 参数。

### 5.2 GET /sandboxes/{id}(查询)

`sandbox_get.go:97-271`(2026.29 为 `:94-199`),「先查后验」的标准范式:

```go
teamInfo := auth.MustGetTeamInfo(c)   // :100 —— 2026.29 为 :97
team := teamInfo.Team

// 按 team.ClusterID 解析 sandbox 域名(:112-123,team 级 cluster 亲和)

// ① 先查运行中的 sandbox(orchestrator 内存态)
sbx, err := a.orchestrator.GetSandbox(ctx, team.ID, sandboxId)  // :126 —— 2026.29 为 :123
if err == nil {
    // ② 后验归属
    if sbx.TeamID != team.ID {                                  // :129 —— 2026.29 为 :126
        // → 404(不是 403!见第十二章)
        return
    }
    ...
}

// ③ 查快照(ClickHouse 持久态)
lastSnapshot, err := a.snapshotCache.Get(ctx, sandboxId)        // :182 —— 2026.29 为 :179
// ④ 后验归属
if lastSnapshot.Snapshot.TeamID != team.ID {                    // :197 —— 2026.29 为 :194
    // → 404
    return
}
```

**两条数据源,两次归属校验**:运行态 sandbox 在 orchestrator 内存(以 teamID 分片索引),持久态快照在 ClickHouse。get 端点必须覆盖两条路。

### 5.3 POST /sandboxes/{id}/connect(连接或恢复)

`sandbox_connect.go:42-200`(2026.29 为 `:24-160`),最复杂的一个:

```go
teamInfo := auth.MustGetTeamInfo(c)   // :46 —— 2026.29 为 :28

if timeout > time.Duration(teamInfo.Limits.MaxLengthHours)*time.Hour {  // :64 —— 配额(2026.29 为 :46)
    ...
}

teamID := teamInfo.Team.ID   // :70 —— 2026.29 为 :52

// ① 重试 3 次:orchestrator.KeepAliveFor(ctx, teamID, sandboxID, timeout, false)  // :85(2026.29 :67)
//    以 teamID 定位 sandbox;ErrNotFound → 落入恢复路径
//    NotRunningError → WaitForStateChange(ctx, teamID, sandboxID)(:121;2026.29 :103)后重试

// ② 恢复路径:查快照
lastSnapshot, err := a.snapshotCache.Get(ctx, sandboxID)   // :137(2026.29 :119)
if lastSnapshot.Snapshot.TeamID != teamID {                // :152 —— 归属校验(2026.29 :134)
    // → 404
}

// ③ 用整个 teamInfo 重建 sandbox(:181-191)
sbx, createErr := a.startSandbox(ctx, sandboxID, timeout, teamInfo, ...)
```

### 5.4 POST /sandboxes/{id}/pause(暂停)

`sandbox_pause.go:45-128`(2026.29 为 `:28-100`):

```go
teamID := auth.MustGetTeamID(c)   // :49 —— 只取 ID(2026.29 为 :30)

err = a.orchestrator.RemoveSandbox(ctx, teamID, sandboxID, sandbox.RemoveOpts{Action: sandbox.StateActionPause, ...})  // :88(2026.29 :60)

// 不在运行态 → 快照归属校验
apiErr := pauseHandleNotRunningSandbox(ctx, a.snapshotCache, sandboxID, teamID)  // :95(2026.29 :67)
//    内部:sandbox_pause.go:134 snap.Snapshot.TeamID != teamID → 404(2026.29 :96-100)
```

> ⚠️ 2026.30 的 pause 端点新增了「node 忙」分支:orchestrator 返回 `PauseQueueExhaustedError` 时映射 `503` + `"Sandbox '%s' cannot be paused right now because its node is busy, please retry"`(`sandbox_pause.go:113-115`)。这与 team 认证无关,但会改变客户端在 blocked/限流场景下的观察结果。

### 5.5 POST /sandboxes/{id}/resume(恢复)

`sandbox_resume.go:47-213`(2026.29 为 `:31-159`),与 connect 同构:

- `:78` — MaxLengthHours 配额校验(改用 `validateAndParseTimeout`;2026.29 为 `:62` 的内联比较)
- `:88` — `orchestrator.GetSandbox(ctx, teamID, sandboxId)`(2026.29 `:70`)
- `:90` — **运行态归属校验** `sandboxData.TeamID != teamID` → 404(2026.29 `:72`)
- `:100` — `WaitForStateChange(ctx, teamID, sandboxID)`(2026.29 `:82`)
- `:172` — **快照归属校验** `lastSnapshot.Snapshot.TeamID != teamID` → 404(2026.29 `:142`)

### 5.6 POST /sandboxes/{id}/fork(派生)

`sandbox_fork.go:37-186`(2026.29 为 `:41-168`),同时消费 team 的 limits 和 ID:

```go
teamInfo := auth.MustGetTeamInfo(c)   // :40 —— 2026.29 为 :41
teamID := teamInfo.Team.ID            // :41 —— 2026.29 为 :42

forkTimeout, apiErr := validateAndParseTimeout(body.Timeout, teamInfo.Limits.MaxLengthHours)  // :63 —— 配额(2026.29 :68)
if int64(forkCount) >= teamInfo.Limits.SandboxConcurrency {                  // :89 —— 2026.29 :94
    // → 400 "Count must be lower than the maximum number of concurrent sandboxes (N)"
}

original, err := a.orchestrator.GetSandbox(ctx, teamID, sandboxID)  // :95 —— 以 teamID 寻址(2026.29 :100)
err = a.orchestrator.CheckpointSandbox(ctx, teamID, sandboxID)      // :119 —— 以 teamID 寻址(2026.29 :124)
```

> ⚠️ fork 有三道闸门,只有第二道来自 team limits:`forkCount < 1` → `"Count must be at least 1"`(`:75-79`)、`forkCount > maxForkCount`(`:81-85`,`maxForkCount = 100` 定义在 `:29`)、`forkCount >= Limits.SandboxConcurrency` → `"Count must be lower than the maximum number of concurrent sandboxes (N)"`(`:89-93`)。三道闸门在 2026.29 就已存在(`:80-98`),2026.30 只是行号右移。

### 5.7 DELETE /sandboxes/{id}(销毁)

`sandbox_kill.go:39-104`(2026.29 为 `:53-113`,行号未变):

```go
teamID := auth.MustGetTeamID(c)   // :53

err = a.orchestrator.RemoveSandbox(ctx, teamID, sandboxID, sandbox.RemoveOpts{Action: sandbox.StateActionKill, ...})  // :64

// 清理持久态:deleteSnapshot → throttledGetSnapshotBuilds(ctx, teamID, sandboxID)  // :107
//    内部 SQL 按 teamID + sandboxID 过滤(:113 GetSnapshotBuilds)
//    → softDeleteTemplate(ctx, teamID, snapshot.TemplateID)(:27)
```

### 5.8 POST /sandboxes/{id}/timeout(续期)

`sandbox_timeout.go:33-52`:只取 ID,`KeepAliveFor(ctx, teamID, sandboxID, duration, true)`——teamID 用于定位 sandbox,续期本身不产生新的归属问题。

### 5.9 GET /sandboxes、GET /v2/sandboxes(列表)

`sandboxes_list.go:207-240`(GetSandboxes)与 `:242-403`(GetV2Sandboxes);2026.29 分别为 `:98-131` / `:133-246`:

```go
teamInfo := auth.MustGetTeamInfo(c)   // :211 / :246 —— 2026.29 为 :102 / :137
team := teamInfo.Team

a.posthog.IdentifyAnalyticsTeam(ctx, team.ID.String(), team.Name)   // :214 / :249 —— 2026.29 为 :105 / :140
sandboxes, err := a.orchestrator.GetSandboxes(ctx, team.ID, ...)     // :226 —— 只列本 team(2026.29 :117)
pausedSandboxList, err := a.getPausedSandboxes(ctx, team.ID, ...)    // :378 —— 2026.29 为 :222
//    getPausedSandboxes 定义在 :138,内部 SQL 带 TeamID(:162)
```

列表端点**不需要 post-fetch 归属校验**:查询本身就是按 teamID 过滤的(见第六章模式三)。

> ⚠️ 2026.30 的 `getPausedSandboxes` 签名从 5 个参数扩到 10 个(`:138-149`),新增 `runningSandboxesIDs`、`order`、`startedAfter`、`templateID`。为了避开 `NOT (sandbox_id = ANY(array))` 在大数组下 40s+ 的查询,它改成**多取 `queryLimit + len(runningSandboxesIDs)` 行再在内存里剔除**(`:155-158`)。teamID 仍然是 SQL 过滤条件(`:162`),归属语义不变。

### 5.10 logs / metrics

`sandbox_logs.go:33,62`、`sandbox_metrics.go:28`:取 `MustGetTeamInfo` 后仅用于**寻址与 telemetry 附加**(`WithTeamID(...)`)——日志与指标查询同样以 teamID 过滤。

---

## 六、归属校验的三种模式

sandbox 域中,「确认资源属于当前 team」有三种实现方式,对应三种安全强度:

### 模式一:post-fetch ownership check(先查后验)

```go
sbx, err := a.orchestrator.GetSandbox(ctx, team.ID, sandboxId)
if sbx.TeamID != team.ID { /* 404 */ }
```

用于 **orchestrator 内存态** 与 **snapshotCache** 的查询(get :129、connect :152、pause :134、resume :90/:172;2026.29 分别为 :126、:134、:100、:72/:142)。

**为什么必须后验**:orchestrator 与 ClickHouse 的查询接口目前不接收 teamID 过滤参数(见 `sandbox_get.go:181`、`sandbox_connect.go:136`、`sandbox_pause.go:131`、`sandbox_resume.go:153` 的同一处 TODO;2026.29 分别为 `:178`、`:118`、`:97`、`:123`):

```go
// TODO: ENG-3544 scope GetLastSnapshot query by teamID to avoid post-fetch ownership check.
```

即现状是**先按 sandboxID 全局查、再在 API 层比对 TeamID**。这不安全吗?不——API 层比对是可靠的:只要比对发生在返回数据之前,越权请求只能拿到 404。TODO 的目标是**减少无效查询**(性能/爆炸半径),不是补安全洞。

**不变量**:所有「先查后验」路径,**校验失败一律返回 404 而非 403**——向攻击者隐藏资源存在性(见第十二章)。

### 模式二:查询即校验(按 teamID 过滤 SQL)

```go
getDBVolumesMap(ctx, sqlClient, teamID, volumeMounts)   // sandbox_create.go:582,SQL 带 TeamID: teamID
GetSnapshotBuilds(ctx, a.sqlcDB, teamID, sandboxID)     // sandbox_kill.go:113
getPausedSandboxes(ctx, team.ID, ...)                   // sandboxes_list.go:378(内部 queries 带 teamID)
```

用于 **API 直连 PostgreSQL/ClickHouse 的查询**。查询条件里带上 teamID,资源不属于本 team 时直接查不到,天然不存在「越权读到再丢弃」的窗口。

**权衡**:模式二更安全(无窗口)、更省(不查无谓数据),但要求查询接口支持 teamID 参数;模式一依赖调用方自觉后验,一旦有 handler 忘了比对就是真实越权漏洞。**写新 handler 时,能走模式二就不要走模式一**。

### 模式三:模板可见性(公开/私有)

`sandbox_create.go:107-124`(2026.29 为 `:100-105`):

```go
env, build, err := a.templateCache.Get(ctx, aliasInfo.TemplateID, tag, teamInfo.Team.ID, clusterID)  // :107
if err != nil {
    visible := aliasInfo.TeamID == teamInfo.Team.ID   // :109 —— 私有模板:只对 owner team 可见
    if metadata, mErr := a.templateCache.GetMetadata(ctx, aliasInfo.TemplateID); mErr == nil {
        visible = visible || metadata.Public            // :111 —— 公开模板:所有人可见
    }
    // visible 决定错误消息是否暴露模板信息
}
```

不是硬校验,而是**错误信息泄露控制**:模板存在但不属于本 team 时,错误消息按 `visible` 区分「模板不存在」与「模板不可用」,防止通过报错差异枚举私有模板。

---

## 七、team 状态裁决:banned 与 blocked

两个状态在不同层裁决,时序也不同:

### 7.1 banned —— 认证时强制(`internal/team/state.go`)

`CheckTeamBanned`(`packages/auth/pkg/auth/internal/team/state.go:13-19`;2026.29 为 `packages/auth/pkg/auth/team_state.go:13-19`)定义在**共享 auth store 内部**,三条 team 查询路径(`internal/service/store.go` 的 `GetTeamByHashedAPIKey` :43、`GetTeamByID` :70、`GetTeamByIDAndUserID` :96;2026.29 为 `auth_store.go` 的 `:38`、`:65`、`:91`)全部强制调用:

```go
func CheckTeamBanned(team authqueries.Team) error {
    if team.IsBanned {
        return &ForbiddenError{Message: "team is banned"}
    }
    return nil
}
```

- banned team **在认证阶段就被拒绝**,根本到不了 sandbox handler。
- `*ForbiddenError` 在 `commonAuthenticator.Authenticate`(`internal/middleware/middleware.go:131-134`;2026.29 为 `middleware.go:96-99` 的 `*TeamForbiddenError`)被特殊识别,直接上抛(不包装),最终映射 403。
- **生效延迟**:teamCache TTL 5 分钟(`internal/service/cache.go:14`)——ban 一个 team 后,已缓存的 API key 最长 5 分钟内仍可通过认证。要立即生效需 `InvalidateTeamCache`(`internal/service/service.go:258`;2026.29 `service.go:261`,同时清 team key、所有 API key hash 缓存**与全部成员 key**)。

### 7.2 blocked —— 中间件裁决 + allowlist(`internal/team/middleware.go` / `blocked_team.go`)

`CheckTeamBlocked`(`internal/team/state.go:26-37`;2026.29 `team_state.go:28-39`)返回 `BlockedError`,但它**不在 store 层强制执行**——由各服务的中间件在认证后按路由决定:

```go
// packages/auth/pkg/auth/internal/team/middleware.go:60
func EnforceBlockedTeam(allowlist BlockedTeamAllowlist) gin.HandlerFunc {
    return func(c *gin.Context) {
        team, ok := authcontext.GetTeamInfo(c)   // :62 —— 2026.29 是裸的 GetTeamInfo(c)
        if !ok || team == nil {
            c.Next()          // admin / user-bearer-only 路径无 team → 短路放行
            return
        }
        if err := CheckBlockedTeamForRoute(c, team, allowlist); err != nil {
            // 403 + Abort
        }
        c.Next()
    }
}
```

API 服务的 allowlist(`packages/api/internal/middleware/blocked_team.go:15-47`;2026.29 `:15-45`):

| 方法 | sandbox 相关放行路由 |
|---|---|
| GET | `/sandboxes`、`/sandboxes/metrics`、`/sandboxes/:sandboxID`、`/sandboxes/:sandboxID/logs`、`/sandboxes/:sandboxID/metrics`、`/v2/sandboxes`、`/v2/sandboxes/:sandboxID/logs` |
| DELETE | `/sandboxes/:sandboxID` |
| 其余(sandbox 域) | **不放行** —— create/connect/resume/pause/fork/timeout 全部 403 |

**设计动机**:blocked team 被允许「读和删」(清理资源、导出数据),但不允许「创建和运行」(新增计费资源)。所以 GET 全家桶与 DELETE 在 allowlist,其余全部拒绝。

> **不变量(中间件顺序)**:`EnforceBlockedTeam` 在 `main.go:218` 注册(2026.29 为 `:231`),位于 oapi-codegen 认证(`:190`;2026.29 `:203`)、ratelimit(`:213`;2026.29 `:226`)之后、handler 之前。**必须跑在认证之后**——它依赖 context 里的 team;也**必须跑在 handler 之前**——handler 自身不做 blocked 检查(个别 deprecated 路径除外,见 11.1 的 `applyTeamAccessCheck`)。

### 7.3（2026.30 变动）banned/blocked 的类型重命名、路径迁移与 allowlist 增补

> ⚠️ **banned 与 blocked 在 2026.29 就已并存,语义完全相同**——2026.30 **没有**新增这两个状态,也没有改变它们的判定规则。变的是下面三件事。

**(1) 错误类型改名**(旧名保留为公共别名,源码层面不破坏调用方):

| 2026.29 | 2026.30 | 公共别名 |
|---|---|---|
| `TeamForbiddenError` | `internal/team/error.go:3` `ForbiddenError` | `packages/auth/pkg/auth/error.go:12` `TeamForbiddenError = internalauthteam.ForbiddenError` |
| `TeamBlockedError` | `internal/team/error.go:11` `BlockedError` | `packages/auth/pkg/auth/error.go:15` `TeamBlockedError = internalauthteam.BlockedError` |

> ⚠️ **不存在 `auth.ForbiddenError` 这个别名**。公共层只有带 `Team` 前缀的那两个(`packages/auth/pkg/auth/error.go:12,15`)。internal 代码里写的是不带前缀的 `internalauthteam.ForbiddenError` / `internalauthteam.BlockedError`。混用会编译失败。

**(2) 文件迁移**:`team_state.go` → `internal/team/state.go`,`team_middleware.go` → `internal/team/middleware.go`。公共层 `packages/auth/pkg/auth/team.go` 只保留 3 个转发(`:10` `BlockedTeamAllowlist` 别名、`:12` `CheckTeamBlocked`、`:16` `CheckTeamAccess`、`:20` `EnforceBlockedTeam`)。

**(3) allowlist 增补**:API 服务新增 `GET /secrets`、`GET /secrets/:secretID`(`blocked_team.go:23-24`),注释也从 `"Admin and access-token-only routes are omitted"` 改成 `"Admin and user-bearer-only routes are omitted"`(`:12-14`)——因为 access token 已整体删除。dashboard-api 侧新增 `GET /teams/:teamID/limits`、`GET /teams/:teamID/status`(`packages/dashboard-api/internal/middleware/blocked_team.go:20,22`)。

> ⚠️ **`CheckTeamAccess` 先判 banned、后判 allowlist**(`internal/team/middleware.go:46-56`),这意味着**一个既 banned 又 blocked 的 team 会绕过 allowlist 直接被拒**(banned 优先,根本不会走到 allowlist 判定)。这个顺序在 2026.29(`team_middleware.go:45-55`)就已如此,**不是** 2026.30 的改动。
>
> `CheckTeamAccess` 只被 deprecated 的晚解析路径调用(见 11.1),`EnforceBlockedTeam` 走的是 `CheckBlockedTeamForRoute`(`internal/team/middleware.go:31`),后者**不含** banned 判定——banned 已在 store 层拦掉了。

---

## 八、team limits 的执行点

### 8.1 timeout 上限(API 层内联校验)

2026.30 起 create/resume/fork 统一走 `validateAndParseTimeout`(`packages/api/internal/handlers/timeout_helper.go:18-39`),connect 仍是内联比较:

| 端点 | 校验 | 行号(2026.30;2026.29) |
|---|---|---|
| create | `validateAndParseTimeout(body.Timeout, Limits.MaxLengthHours) → 400` | sandbox_create.go:160(2026.29 `:157` 内联) |
| connect | `timeout > Limits.MaxLengthHours h → 400`(内联) | sandbox_connect.go:64(2026.29 `:46`) |
| resume | `validateAndParseTimeout(body.Timeout, Limits.MaxLengthHours) → 400` | sandbox_resume.go:78(2026.29 `:62` 内联) |
| fork | `validateAndParseTimeout(body.Timeout, Limits.MaxLengthHours) → 400` | sandbox_fork.go:63(2026.29 `:68` 内联) |

> ⚠️ 错误字符串 `"Timeout cannot be greater than %d hours"` 未变,但新版实现(`timeout_helper.go:30-34`)只在 `rawTimeout != nil` 时比较上限,并且先对 `<= 0` 返回 `"Timeout must be greater than 0"`(`:24`)。旧版内联代码对 `body.Timeout != nil` 且为负数的输入会报 MaxLengthHours 而非「必须大于 0」。

### 8.2 并发上限(orchestrator 客户端 + reservation)

`packages/api/internal/orchestrator/create_instance.go:194-209`(2026.29 为 `:153-169`):

```go
totalConcurrentInstances := team.Limits.SandboxConcurrency

finishStart, waitForStart, err := o.sandboxStore.Reserve(ctx, team.Team.ID, sandboxID, int(totalConcurrentInstances))
if err != nil {
    var limitErr *sandbox.LimitExceededError
    if errors.As(err, &limitErr) {
        // → 429 "you have reached the maximum number of concurrent E2B sandboxes (N)"
    }
}
```

`CreateSandbox` 接收**整个 `*types.Team`**(不是 teamID),并发上限在 Redis reservation 层原子执行。注意 create 与 connect/resume 的恢复路径都汇聚到 `CreateSandbox`,所以**任何「起新 sandbox」的动作都受并发上限约束**。

### 8.3 fork 数量上限(API 层内联)

`sandbox_fork.go:89`(2026.29 为 `:94`)— `forkCount >= Limits.SandboxConcurrency → 400`(复用并发上限作为 fork 数量的天花板)。

---

## 九、team-id 向下游的传播

sandbox handler 里 teamID 有四个流向:

### 9.1 orchestrator gRPC(第一公民参数)

所有 orchestrator 客户端方法都以 `teamID` 为首参——orchestrator 内部按 team 分片索引:

| API 调用 | 端点 | 行号(2026.30;2026.29) |
|---|---|---|
| `GetSandbox(ctx, team.ID, sandboxId)` | get / resume / fork | sandbox_get.go:126、sandbox_resume.go:88、sandbox_fork.go:95(2026.29 `:123`、`:70`、`:100`) |
| `GetSandboxes(ctx, team.ID, states)` | list | sandboxes_list.go:226、:331(2026.29 `:117`、`:182`) |
| `KeepAliveFor(ctx, teamID, sandboxID, timeout, ...)` | connect / timeout | sandbox_connect.go:85、sandbox_timeout.go:52(2026.29 `:67`、`:52`) |
| `RemoveSandbox(ctx, teamID, sandboxID, opts)` | pause / kill | sandbox_pause.go:88、sandbox_kill.go:64(2026.29 `:60`、`:64`) |
| `CheckpointSandbox(ctx, teamID, sandboxID)` | fork | sandbox_fork.go:119(2026.29 `:124`) |
| `WaitForStateChange(ctx, teamID, sandboxID)` | connect / resume | sandbox_connect.go:121、sandbox_resume.go:100(2026.29 `:103`、`:82`) |
| `CreateSandbox(ctx, ..., team *Team, ...)` | create / resume / connect / fork | 整个 team(含 Limits)传入 |

### 9.2 snapshotCache / PostgreSQL(过滤条件)

- `snapshotCache.Get(ctx, sandboxId)` — 现状不按 team 过滤,靠 post-fetch 比对(ENG-3544 待改)
- `GetSnapshotBuilds(ctx, sqlcDB, teamID, sandboxID)`(sandbox_kill.go:113)、`getPausedSandboxes(ctx, team.ID, ...)`(sandboxes_list.go:378,定义 `:138`,SQL 的 `TeamID` 参数在 `:162`)— SQL 级过滤

### 9.3 telemetry / 日志

- 错误上报:`telemetry.WithTeamID(teamID.String())`(connect :102/:125/:146、resume :109/:145/:165、get :130/:198 等)——trace 按 team 关联
- 日志:`logger.WithTeamID(...)`(ratelimit :101、`main.go:154` 日志上下文)
- sandbox 结构日志:`sbxlogger.E(&sbxlogger.SandboxMetadata{SandboxID, TemplateID, TeamID})`(create :135、connect :175、fork :144、resume :188;2026.29 分别为 :128、:148、:152、:152)

### 9.4 posthog 分析

`sandboxes_list.go:214,249`(2026.29 `:105,140`)— `IdentifyAnalyticsTeam(team.ID, team.Name)` + team 维度事件。

---

## 十、认证后的中间件链

`main.go:190-221`(2026.29 为 `:203-231`)的注册顺序即执行顺序,其中三个环节与 team 直接相关:

```
① oapi-codegen 校验 + AuthenticationFunc   (:190)  ← team 在此注入(2026.29 :203)
② InitLaunchDarklyContext                   (:208)  ← 读 GetTeamInfo/GetUserID 构建 LD 上下文(2026.29 :221)
③ ratelimit.Middleware                      (:213)  ← per-team 限流(2026.29 :226)
④ customMiddleware.EnforceBlockedTeam()     (:218)  ← blocked 裁决(2026.29 :231)
⑤ api.RegisterHandlersWithOptions           (:221)  ← sandbox handler(2026.29 :234)
```

> ⚠️ 2026.30 在认证之前插入了两处与 team 无关但会改变观测结果的东西:`r.UseRawPath = true`(`main.go:111`,让 path 参数中的 `%2F` 不被当作分隔符)与 `customMiddleware.NoStoreSecrets()`(`main.go:117`)。后者**必须最先执行**——它在任何可能写响应的东西之前给 secrets 响应打上不可缓存头。

### 10.1 LaunchDarkly 上下文

`packages/api/internal/middleware/launchdarkly.go:32,41` — 同时读 `GetUserID` 与 `GetTeamInfo`,构建 LD evaluation context。**这意味着所有 feature flag 都可以按 team/user 灰度**,sandbox 域直接用到它的例子:`validateNetworkRules`(`sandbox_create.go:833`;2026.29 `:718`)的 `featureflags.TeamContext(teamID.String())`。

### 10.2 per-team 限流

`packages/api/internal/middleware/ratelimit/ratelimit.go:75-108`(`Middleware` 本体为 `:75-151`;本文件 2026.29→2026.30 未改动,文中旧引用的 `:73-104` 从来就不准——`Middleware` 实际从 `:75` 开始):

```go
team, ok := auth.GetTeamInfo(c)   // :80
if !ok {
    c.Next()          // 无 team(admin / user-bearer-only)→ 跳过限流
    return
}
limit, ok := resolveLimit(ctx, ff, route)   // :91 按路由从 LD flag 解析限额
if !ok { c.Next(); return }                 // 路由未配置 → 不限流

key := redis_utils.CreateKey(rateLimitPefix, teamID, route)  // :107 —— 限流 key = teamID + 路由
res, err := limiter.Allow(ctx, key, limit)   // :108 Redis 令牌桶;Redis 故障 FailOpen(:112 cfg.FailOpen,由 main.go:213 传入 Config{FailOpen: true})
```

限流粒度是 **team × 路由**,只对配置了限额的路由生效(当前覆盖 connect/resume 等热点)。

---

## 十一、特殊路径:deprecated teamID 参数与 admin 旁路

### 11.1 `GetTeam(ctx, c, teamID *string)` —— 带 teamID 参数的旧路径

`packages/api/internal/handlers/auth.go:33-82`,用于 **access token / OIDC bearer(只写了 userID、没有 team)**的路由:

```go
if team, ok := auth.GetTeamInfo(c); ok {   // :42 —— 认证器已注入 team → 直接返回
    return team, nil
}

if userID, ok := auth.GetUserID(c); ok {   // :46 —— 只有 userID → 手动解析
    teams, apiErr := a.getUserTeams(ctx, userID)      // :47 —— 查用户所有 team
    team, err := findTeam(teams, teamID)              // :52 —— 匹配显式 teamID 或默认 team
    // 不匹配 → 403 "You are not allowed to access this team"
    // 匹配后还要 applyTeamAccessCheck(:70)→ CheckTeamAccessForRoute(banned+blocked)
    return team, nil
}
// 两者都没有 → 401
```

`findTeam`(`auth.go:84-107`):显式 teamID 参数(老 OpenAPI 定义中的 query/path 参数)按 UUID 匹配;nil 时取 `IsDefault` team。

> 这条路径上的 `applyTeamAccessCheck`(`auth.go:21-31`)**补做了中间件没做的 blocked 检查**——因为它绕过了「认证器注入 team → EnforceBlockedTeam」的标准链路,team 是 handler 内晚解析出来的。这也是为什么中间件 `EnforceBlockedTeam` 遇到「无 team 的 context」选择放行而不是拒绝:晚解析路径自己负责校验。

### 11.2（2026.30 变动）access token 已整体删除 ⛔

2026.29 里 access token(`sk_e2b_` 前缀)还活着,只是被一个 feature flag 闸门按 userID 灰度关停。**2026.30 把它连代码带表一起删了**。以下东西在 2026.30 已不存在:

| 已删除 | 2026.29 位置 |
|---|---|
| security scheme `AccessTokenAuth` | `spec/openapi.yml` 中 13 处(2026.30 为 0 处) |
| 端点 `POST /access-tokens`、`DELETE /access-tokens/{accessTokenID}` | `spec/openapi.yml:3651,3679` |
| handler 文件 | `packages/api/internal/handlers/accesstoken.go` |
| `APIStore.GetUserFromAccessToken` | `packages/api/internal/handlers/store.go:396` |
| `AuthService.ValidateAccessToken` | `packages/auth/pkg/auth/service.go:140` |
| `auth.NewAccessTokenAuthenticator` | `packages/auth/pkg/auth/middleware.go:147` |
| `keys.AccessTokenPrefix`(值 `sk_e2b_`) | `packages/shared/pkg/keys/constants.go:5` |
| `auth.PrefixAccessToken` | `packages/auth/pkg/auth/consts.go:12` |
| SQL 查询目录 | `packages/db/pkg/auth/sql_queries/access_token/`(3 个文件) |
| 生成代码 | `packages/db/pkg/auth/queries/{create,delete,get_user_id_from}_access_token.sql.go` |
| 表 / 函数 | `public.access_tokens`、`public.generate_access_token()` |
| feature flag | `disable-e2b-access-token-provisioning` / `disable-e2b-access-token-auth` |
| 测试辅助 | `packages/auth/pkg/tests/sign_token.go`(`SignTestToken`,整目录删除) |

**迁移兼容**:`packages/api/main.go:169-173` 注册了两个**无条件**的 410 处理器:

```go
accessTokensGone := func(c *gin.Context) {
    apierrors.SendAPIStoreError(c, http.StatusGone, "E2B_ACCESS_TOKEN is deprecated and no longer supported. Use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation")
}
r.POST("/access-tokens", accessTokensGone)                 // main.go:172
r.DELETE("/access-tokens/:accessTokenID", accessTokensGone) // main.go:173
```

> ⚠️ 这两个路由注册在 **OpenAPI validator 中间件之前**(validator 在 `main.go:190` 才 `r.Use`)。spec 里已经没有 `/access-tokens` 了,若注册在 validator 之后,老客户端会收到 404 而不是可读的 410。改这个顺序会让迁移提示消失。
>
> ⚠️ 被删的不只是「创建 access token」——**认证本身也没了**。旧客户端拿 `Authorization: Bearer sk_e2b_...` 调 sandbox 端点,现在会落到 `AuthProviderBearerAuth` 的 `ErrInvalidAuthHeader`,与「header 格式不对」无法区分。

数据库侧:`packages/db/migrations/20260823120000_drop_access_tokens.sql` 执行 `DROP TABLE IF EXISTS public.access_tokens;` 与 `DROP FUNCTION IF EXISTS public.generate_access_token();`。

### 11.3 admin 旁路(team 型)

`packages/api/internal/handlers/store.go:552-599`(2026.29 为 `store.go:432-479`)`GetTeamFromAdminToken`(配 `AdminTeamAuth` / `X-Team-ID`):

- parse teamID → `authService.GetTeamByID`(cache + store,含 CheckTeamBanned)
- **不校验成员关系**——admin 以任意 team 身份操作
- 错误映射:`*sharedauth.TeamForbiddenError` → 403;`dberrors.IsNotFoundError` 或 `team == nil` → 404 `"Team not found"`;其余 → 500
- `AdminApiKeyAuth`(`X-Admin-Token`)则完全不写 team,供纯 admin 端点(如 `/admin/teams/{teamID}/sandboxes/kill`,`admin_kill_team_sandboxes.go`)使用
- 2026.30 起 `AdminJWTAuth` 也可与 `AdminTeamAuth` 配对走这条路(见 2.6):JWT 只证明调用方身份,team 仍由 `X-Team-ID` 决定

### 11.4（2026.30 变动）认证器的失败状态码保护与 malformed API key

两个小改动会影响客户端看到的 401/403 文案与状态码:

**(1) `authFailureStatusContextKey` 守卫**(commit `62e67d48f`)——`internal/middleware/middleware.go:73` 定义 key,`:108-111` 在「header 缺失/格式不对」分支里加了 `if _, hasAuthenticationFailure := ginCtx.Get(...); !hasAuthenticationFailure` 判断,只 stamp 一次 401。目的:一组 security alternatives 里第一个失败的 scheme 决定状态码,后到的 scheme 不再覆盖。

> ⚠️ **这个保护只覆盖「header 缺失/格式不对」分支**。校验错误分支(`:128-129`)仍然**无条件** `ginCtx.Status(validationError.Code)` + `Set(...)`,所以**后面一个 scheme 的 403 仍可能覆盖前面一个的 401**。看到 403 不代表所有 scheme 都返回 403。

**(2) `malformedError`**(commit `84362fc62`)——`headerKey` 新增字段(`internal/middleware/middleware.go:55`),`getHeaderKeysFromRequest` 在「token 存在但前缀不对」时优先返回它(`:87-89`)。目前只有 API Key 认证器设置了它(`:227`),值为 `ErrMalformedAPIKey`(`:42`):

```
API key is malformed: expected the "e2b_" prefix, visit https://docs.e2b.dev/api-key for more information
```

> ⚠️ 注释里明确写了**只有独占某个 header 的 scheme 才该设 `malformedError`**(`:51-54`);共享 header(如 `Authorization`)必须保留通用的 `ErrInvalidAuthHeader`,否则会抢走另一个 scheme 的 token。

### 11.5（2026.30 变动）读写分离已移除

2026.29 的 auth DB 客户端区分读写副本:

```go
// 2026.29 packages/db/pkg/auth/client.go:21-28
type Client struct {
    Read      *authqueries.Queries
    Write     *authqueries.Queries
    writeConn *pgxpool.Pool
    readConn  *pgxpool.Pool
}
func NewClient(ctx context.Context, databaseURL, replicaURL string, options ...pool.Option) (*Client, error)
```

调用方一律写成 `authDB.Read.X()` / `authDB.Write.X()`。2026.30 收敛为单连接:

```go
// 2026.30 packages/db/pkg/auth/client.go:16-22
type Client struct {
    *authqueries.Queries
    conn *pgxpool.Pool
}
func NewClient(ctx context.Context, databaseURL string, options ...pool.Option) (*Client, error)
```

- 调用点全部改为 `authDB.X()`;`authDB.Queries` 可直接传给 `oidc.IdentityLookup`(`internal/service/service.go:83`)。
- 环境变量 `AUTH_DB_READ_REPLICA_CONNECTION_STRING` **已删除**——API 侧在 `packages/api/internal/cfg/model.go`(2026.29 `:85`),dashboard-api 侧在 `packages/dashboard-api/internal/cfg/model.go`(2026.29 `:21`)。
- 同时删掉了 `replica` 常量与 `packages/db/pkg/types`(`types.DBTX`)的使用。
- `WithTx(ctx)` 在 2026.29 就已存在(`client.go:64`),只是内部从 `db.Write.WithTx(tx)` 改成 `db.Queries.WithTx(tx)`。

API 侧构造点:`packages/api/internal/handlers/store.go:238-243`(2026.29 `:99-101`,当时第二个参数是 replica DSN);dashboard-api:`packages/dashboard-api/main.go:137-141`。

> ⚠️ `internal/service/store.go:34-37` 仍保留着那条解释「为什么删除 API key 的失效不能走读副本」的注释——它现在描述的是一个**已经不存在**的选择,保留下来是为了说明「为什么不加回读副本」。别把它当成当前代码在走读副本。

---

## 十二、不变量与安全设计

1. **`MustGet*` panic 是安全网而非炸弹**:sandbox handler 全部使用 `MustGetTeamInfo`/`MustGetTeamID`。若未来有人在未声明 team 型 security scheme 的路由上挂 sandbox handler,请求会 panic → `gin.Recovery()` 兜底 500。宁可 500 也不静默放行。写新路由时务必在 `spec/openapi.yml` 声明正确的 security。

2. **归属校验失败 = 404,不是 403**:所有 post-fetch ownership check(get/connect/pause/resume)失败时返回 `utils.SandboxNotFoundMsg(id)`。理由:403 会向攻击者泄露「这个 sandboxID 存在,只是不属于你」,404 让越权探测与不存在的 sandbox 无法区分。

3. **ban 在认证层、block 在路由层**:banned 是「整个 team 的一切请求都拒」(认证期 403,任何服务任何端点);blocked 是「允许读和删、禁止创建和运行」(按路由 allowlist 精细放行)。两者语义不同,不要在 handler 里混用。(两个状态在 2026.29 就已并存——2026.30 只改了文件名与错误类型名,见 7.3。)

4. **两条 team 获取链互斥**:handler 要么拿到认证器注入的 team(标准路径),要么走 `GetTeam` 晚解析(deprecated 路径),且晚解析路径必须自行调用 `applyTeamAccessCheck` 补 banned+blocked 检查——这是目前唯一绕开 `EnforceBlockedTeam` 的通道,改动 `GetTeam` 时务必保留该调用。2026.30 起 access token 已删除,这条晚解析路径**只剩 AuthProviderBearer(OIDC)一个入口**(见 11.2)。

5. **teamCache 是 team-id 认证的失效窗口**:TTL 5min + 后台刷新(`internal/service/cache.go:14-15`;`refreshInterval` 1min、`refreshTimeout` 30s、`invalidateTimeout` 45s)。ban/改限额/改成员关系后,已缓存身份最长 5 分钟不感知。运营操作(ban team、踢成员)必须配套 `InvalidateTeamCache` / `InvalidateTeamMemberCache`。

6. **创建类动作的双重闸门**:create/connect/resume/fork 同时受「中间件 blocked 拦截」与「handler 内 MaxLengthHours/SandboxConcurrency 校验」约束;blocked team 即使有已缓存的认证也过不了创建端点(allowlist 不含任何 sandbox 创建路由)。

7. **认证失败的状态码不唯一**:一组 security alternatives 中,`authFailureStatusContextKey` 守卫只保证「header 缺失」分支不重复 stamp 401(`internal/middleware/middleware.go:108-111`);校验错误分支仍会无条件覆盖状态码(`:128-129`)。因此同一请求在 `AdminJWTAuth + AdminTeamAuth` 这类 AND 组下,最终状态码取决于**最后一个**写状态码的认证器。排错时不要假设「401 = 全都没尝试,403 = 全都拒绝」。

---

## 十三、端到端时序图:POST /sandboxes

```
Client                API(gin)                    AuthService/Store         Orchestrator
  │  X-API-Key: e2b_…  │                                │                       │
  ├───────────────────►│                                │                       │
  │                    │ oapi-codegen: scheme=ApiKeyAuth│                       │
  │                    │ commonAuthenticator.Authenticate                       │
  │                    ├───────────────────────────────►│                       │
  │                    │   ValidateAPIKey               │                       │
  │                    │   ├ VerifyKey 格式校验          │                       │
  │                    │   ├ teamCache(Redis 5min TTL)  │                       │
  │                    │   │   miss → GetTeamByHashedAPIKey(单连接,2026.30 起)│
  │                    │   │       ├ CheckTeamBanned ── banned? 403 终止        │
  │                    │   │       └ async UpdateLastTimeUsed                   │
  │                    │◄───────────────────────────────┤                       │
  │                    │ setTeamInfo(c, team)           │                       │
  │                    │ InitLaunchDarklyContext(team)  │                       │
  │                    │ ratelimit: key=teamID+/sandboxes (未配置则跳过)        │
  │                    │ EnforceBlockedTeam: blocked? 且路由不在 allowlist → 403│
  │                    │ PostSandboxes                  │                       │
  │                    │  ├ MustGetTeamInfo(c)          │                       │
  │                    │  ├ ResolveAlias(identifier, team.Slug)                 │
  │                    │  ├ templateCache.Get(templateID, tag, team.ID, cluster)│
  │                    │  │    └ 失败→按 aliasInfo.TeamID==team.ID 控错误泄露    │
  │                    │  ├ timeout > Limits.MaxLengthHours → 400               │
  │                    │  ├ volumes: SQL 按 teamID 过滤 │                       │
  │                    │  ├ network rules: LD TeamContext(teamID) 灰度          │
  │                    │  └ CreateSandbox(ctx, sandboxID, …, team, …)           │
  │                    ├───────────────────────────────────────────────────────►│
  │                    │      Reserve(team.ID, sandboxID, Limits.SandboxConcurrency)
  │                    │      ├ 超限 → 429                                       │
  │                    │      └ 通过 → 调度 VM                                    │
  │◄───────────────────┤                                │                       │
  │  201 + Sandbox     │                                │                       │
```

---

## 附录:关键代码路径速查

| 关注点 | 位置(2026.30) |
|---|---|
| 认证器装配(6 种) | `packages/api/main.go:176-186`(2026.29 `:189-199`) |
| 认证器骨架 / header 提取 / 注入 | `packages/auth/pkg/auth/internal/middleware/middleware.go:65-146`(2026.29 `middleware.go:40-111`) |
| API Key 认证器定义 | `internal/middleware/middleware.go:221`(2026.29 `middleware.go:133`) |
| AuthProviderTeam 认证器定义 | `internal/middleware/middleware.go:250`(2026.29 `middleware.go:176`) |
| AdminJWT 认证器定义 | `internal/middleware/middleware.go:263`(2026.30 新增) |
| AdminTeam 认证器定义 | `internal/middleware/middleware.go:304`(2026.29 `middleware.go:205`) |
| `CreateAuthenticationFunc` | `internal/middleware/middleware.go:324-347`(2026.29 `middleware.go:225-248`) |
| context key 与存取 | `packages/auth/pkg/auth/internal/authcontext/context.go:10-77`(2026.29 `gin.go:10-51`) |
| 公共再导出层 | `packages/auth/pkg/auth/{gin,middleware,service,team,error,token,security}.go`(2026.30 新增) |
| `ValidateAPIKey` | `internal/service/service.go:97`(2026.29 `service.go:93`) |
| `ValidateAuthProviderTeam`(两段式) | `internal/service/service.go:188`(2026.29 `service.go:213`) |
| store 层(单连接 + ban + 异步 last_used) | `internal/service/store.go:30-111`(2026.29 `auth_store.go:29-98`) |
| `CheckTeamBanned` / `CheckTeamBlocked` | `internal/team/state.go:13-37`(2026.29 `team_state.go:13-39`) |
| `EnforceBlockedTeam` 中间件 | `internal/team/middleware.go:60-78`(2026.29 `team_middleware.go:59-77`) |
| `ProcessSecurityErrors` + 前缀常量 | `packages/auth/pkg/auth/security.go:13-52`(2026.30 新增) |
| API 服务 allowlist | `packages/api/internal/middleware/blocked_team.go:15-47`(2026.29 `:15-45`) |
| dashboard-api allowlist | `packages/dashboard-api/internal/middleware/blocked_team.go:14-32` |
| `Team` / `TeamLimits` 类型 | `packages/auth/pkg/types/teams.go:7-48`、`limits.go:3-16` |
| teamCache TTL(5min) | `internal/service/cache.go:14-23`(2026.29 `cache.go:14-18`) |
| `GetTeam`(deprecated teamID 参数) | `packages/api/internal/handlers/auth.go:33-82`、`findTeam` `:84-107`、`applyTeamAccessCheck` `:21-31` |
| `GetTeamFromAdminToken` | `packages/api/internal/handlers/store.go:552-599`(2026.29 `:432-479`) |
| access token 410 兼容处理器 | `packages/api/main.go:169-173`(2026.30 新增) |
| ⛔ access token 废弃闸门 | 已删除(2026.29 `store.go:396-416`) |
| create:team 使用点 | `sandbox_create.go:70,72,97,98,107,160,290,502,520,582,707,828,833` |
| get:运行态/持久态双重归属校验 | `sandbox_get.go:97-271`(校验点 `:129`、`:197`) |
| connect:KeepAlive + 快照校验 | `sandbox_connect.go:42-200`(校验点 `:152`) |
| pause / kill:RemoveSandbox(teamID) | `sandbox_pause.go:45-128`、`sandbox_kill.go:39-104` |
| resume / fork:limits + 归属 | `sandbox_resume.go:47-213`、`sandbox_fork.go:37-186` |
| timeout 校验辅助 | `packages/api/internal/handlers/timeout_helper.go:18-39`(2026.30 新增) |
| 并发 reservation(429) | `packages/api/internal/orchestrator/create_instance.go:194-209`(2026.29 `:153-169`) |
| per-team 限流 | `packages/api/internal/middleware/ratelimit/ratelimit.go:75-108` |
| ENG-3544(快照查询按 team 过滤) | `sandbox_get.go:181`、`sandbox_connect.go:136`、`sandbox_pause.go:131`、`sandbox_resume.go:153`(2026.29 `:178`、`:118`、`:97`、`:123`) |

---

> **版本说明**:本文所有 `file:line` 引用均以 git tag **2026.30** 为准,并在与 2026.29 不同的地方用「(2026.30;2026.29 为 M)」标注旧值。已同步至 2026.30。
