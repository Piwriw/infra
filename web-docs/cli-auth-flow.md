# CLI 登录与凭证签发流程

> 范围:用户通过 CLI(`e2b` 命令行)登录 E2B、获得可用于 SDK 调用的凭证(API key 或 access token)的完整流程。涉及 `POST /access-tokens`、`GET /teams`、OIDC JWT 验证、以及 gin context 中 `userID` / `teamInfo` 的注入机制。
>
> 本文聚焦「人 → 凭证」的链路。机器(M2M)直接用 API key 调用的路径已在 `api-keys-module.md` 中讨论。

## 目录

- [一、概述](#一概述)
- [二、三种凭证类型回顾](#二三种凭证类型回顾)
- [三、CLI 登录完整流程(端到端)](#三cli-登录完整流程端到端)
- [四、`POST /access-tokens`:颁发 access token](#四post-access-tokens颁发-access-token)
- [五、`GET /teams`:列出团队并自动签发 API key](#五get-teams列出团队并自动签发-api-key)
- [六、`GetTeam` 辅助函数与跨 team 访问](#六getteam-辅助函数与跨-team-访问)
- [七、AuthProvider JWT 验证深入](#七authprovider-jwt-验证深入)
- [八、gin context 中的 userID / teamInfo](#八gin-context-中的-userid--teaminfo)
- [九、关键流程时序图](#九关键流程时序图)
- [十、Feature Flag 与废弃路径](#十feature-flag-与废弃路径)
- [十一、配置](#十一配置)
- [十二、关键代码文件索引](#十二关键代码文件索引)
- [十三、设计要点与权衡](#十三设计要点与权衡)
- [十四、常见问题与排查](#十四常见问题与排查)
- [附录 A:凭证类型速查表](#附录-a凭证类型速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录-b错误码与-http-状态映射)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

E2B 的 API 接受三种凭证(详见 `auth-module.md`):API key(`e2b_...`)、access token(`sk_e2b_...`)、auth provider JWT。**前两种是机器友好、可长期保存的;最后一种是短期 OIDC JWT,直接来自用户登录的 auth provider**。

**人类用户** 的典型路径是:
1. 通过浏览器跳转到 auth provider 登录,获得 JWT
2. 把 JWT 放进 `Authorization: Bearer <jwt>` 头
3. 调用 API——API 验证 JWT 并把 `userID` 注入 gin context
4. 调用 `GET /teams` 或 `POST /access-tokens`,**用 JWT 换取更稳定的凭证**(API key 或 access token)
5. CLI 把稳定凭证写进本地配置,后续调用走机器凭证路径

`POST /access-tokens` 与 `GET /teams` 是 **两个不接受 API key 的端点**。两者在 OpenAPI 中的 security scheme 略有差异(`spec/openapi.yml:2011-2013` 与 `3578-3579`):

- `POST /access-tokens`:仅 `AuthProviderBearerAuth`(JWT)
- `GET /teams`:`AuthProviderBearerAuth`(JWT)**或** `AccessTokenAuth`(access token)——用 access token 也能调

也就是说,机器凭证里只有 access token 能调 `GET /teams`,API key 完全不能。这就把"team 列表 + 自动 API key 签发"限制在人类登录链路内。

### 与其他文档的边界

| 主题 | 文档 |
|---|---|
| 三种凭证的内部验证 | `auth-module.md` |
| API key 的 CRUD | `api-keys-module.md` |
| Access token 的 CRUD | `access-tokens-module.md` |
| OIDC 验证底层(`oidc` 包) | `auth-module.md` 第五节 |
| **CLI 登录流程本身、`GET /teams` 自动签发 API key** | **本文** |

---

## 二、三种凭证类型回顾

| 凭证 | HTTP 头 | 前缀 | gin context 注入 | security scheme |
|---|---|---|---|---|
| API key | `X-API-Key: e2b_...` | `e2b_` | `*types.Team` | `ApiKeyAuth` |
| Access token | `Authorization: Bearer sk_e2b_...` | `sk_e2b_` | `uuid.UUID`(userID) | `AccessTokenAuth` |
| Auth provider JWT | `Authorization: Bearer <jwt>` | (无固定前缀) | `uuid.UUID`(userID) | `AuthProviderBearerAuth` |

**关键区别**:
- **API key 直接绑定 team**:验证时一次 DB/cache 查询返回完整的 team 数据,后续请求不需要再带 team 信息
- **Access token 与 JWT 都只绑定 user**:验证后只拿到 userID,handler 还需要从请求参数(`/teams/{teamID}`)或 `X-Team-ID` 头里恢复 team 上下文
- **生命周期**:JWT 短期(通常几分钟到一小时,由 auth provider `exp` claim 决定);access token 与 API key 在 DB 层都不设过期(`CreateAccessTokenParams` 类型定义在 `packages/db/pkg/auth/queries/create_access_token.sql.go:39-48`,无 expiration 字段;`accesstoken.go:49-58` 是该类型的构造调用),两者都持久有效直到用户删除——区别在于 access token 已整体进入弃用路径

### 凭证之间的转换

```
JWT (短期)             GET /teams        API key (长期,per-team)
   │                      │                      ▲
   │                      └──────────────────────┤
   │                                             │
   │   POST /access-tokens                       │
   │                      │                      │
   └──────────────────────┼─→ access token ──────┘
                                                  │
                              机器调用 SDK          │
                                                  │
                              ────────────────────►
```

人类用户用 JWT 换取长期凭证,SDK/CLI 后续就走机器路径。

---

## 三、CLI 登录完整流程(端到端)

```
┌─────────┐                ┌─────────┐            ┌──────────────┐
│  CLI    │                │ Browser │            │ Auth Provider│
│ (e2b)   │                │ (默认浏览器)│         │ (OIDC)       │
└────┬────┘                └────┬────┘            └──────┬───────┘
     │                          │                        │
     │ 1. e2b auth login        │                        │
     │ 启动本地 HTTP server      │                        │
     │ 打开浏览器到授权 URL       │                        │
     │─────────────────────────►│                        │
     │                          │ 2. 用户登录             │
     │                          │ ──────────────────────►│
     │                          │ 3. redirect 带 code/JWT │
     │                          │ ◄──────────────────────│
     │ 4. CLI 收到回调(获取 JWT)│                        │
     │ ◄────────────────────────│                        │
     │                          │                        │
     │ 5. POST /access-tokens                            │
     │    Authorization: Bearer <JWT>                    │
     │ ─────────────────────────────────────────────────►│ (跳到 API)
     │                                                  ▼
     │                                  ┌──────────────────────┐
     │                                  │ API                  │
     │                                  │ - ValidateJWT        │
     │                                  │ - CreateAccessToken  │
     │                                  │   (写入 auth DB)     │
     │                                  │ ──────────────►      │
     │ 6. 返回 access token             │ ◄──────────────      │
     │ ◄────────────────────────────────│                      │
     │                                                          │
     │ 7. 写入 ~/.e2b/.env(e2b_access_token)                   │
     │                                                          │
     │ 8. 后续 SDK 调用                                          │
     │    Authorization: Bearer sk_e2b_...                      │
     │ ────────────────────────────────────────────────────────►│
```

**注意**:不同 CLI 实现可能略有差异——有些直接在 `e2b auth login` 调 `GET /teams` 自动选默认 team 并签发 API key,有些则要求用户先 `e2b team list`。本文聚焦 **API 层** 的契约,不规定 CLI 的具体 UX。

---

## 四、`POST /access-tokens`:颁发 access token

`accesstoken.go:20-79` 是入口。该端点在 OpenAPI 中已标记为 `deprecated: true`,但代码仍然工作。

### 4.1 主干流程

```
1. 取 userID(MustGetUserID — 必须有 AuthProvider JWT)
2. 检查 DisableE2BAccessTokenProvisioningFlag:
   - 若开启 → 410 Gone,提示用 API key
3. ParseBody[NewAccessToken](必填 name)
4. keys.GenerateKey(AccessTokenPrefix)  ← 生成 sk_e2b_... 前缀的 token
5. authDB.Write.CreateAccessToken(写入 hash、prefix、length、mask、name)
6. 返回 201 + CreatedAccessToken{Token:PrefixedRawValue, Mask:IdentifierMaskingDetails}
```

### 4.2 关键代码

```go
// accesstoken.go:23-29
userID := auth.MustGetUserID(c)

if a.featureFlags.BoolFlag(ctx, featureflags.DisableE2BAccessTokenProvisioningFlag, featureflags.UserContext(userID.String())) {
    a.sendAPIStoreError(c, http.StatusGone, "Creating new access tokens is disabled. E2B_ACCESS_TOKEN is deprecated; use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation")
    return
}
```

**为什么按 userID 而不是全局检查 flag?** LaunchDarkly 支持按 user 维度灰度——可以先把一部分用户的 access token 创建禁用,观察是否有问题,再全量推开。`UserContext(userID.String())`(`accesstoken.go:25` 的 `BoolFlag` 调用参数)是为 LD 提供的 user 维度上下文。

### 4.3 响应中的 mask 信息

```go
// accesstoken.go:67-78
c.JSON(http.StatusCreated, api.CreatedAccessToken{
    Id:    accessTokenDB.ID,
    Token: accessToken.PrefixedRawValue,  // 唯一一次返回明文
    Mask: api.IdentifierMaskingDetails{
        Prefix:            accessTokenDB.AccessTokenPrefix,
        ValueLength:       int(accessTokenDB.AccessTokenLength),
        MaskedValuePrefix: accessTokenDB.AccessTokenMaskPrefix,
        MaskedValueSuffix: accessTokenDB.AccessTokenMaskSuffix,
    },
    ...
})
```

明文 token `PrefixedRawValue` 只在创建时返回一次。后续 list 端点只暴露 mask 信息(`sk_e2b_***abc`),用于让用户在 UI 上辨认"这是哪个 token"。

---

## 五、`GET /teams`:列出团队并自动签发 API key

`teams.go:14-47` 是入口。这个端点 **既查询又写**——这是个不同寻常的设计。

### 5.1 主干流程

```
1. 取 userID(MustGetUserID)
2. authDB.Read.GetTeamsWithUsersTeams(userID) → 查询用户的所有 team
3. 对每个 team:
   - team.CreateAPIKey(team.ID, &userID, "CLI login/configure")
   - 把 RawAPIKey 放进响应
4. 返回 200 + []Team{TeamID, Name, ApiKey, IsDefault}
```

### 5.2 关键代码

```go
// teams.go:30-36
apiKey, err := team.CreateAPIKey(ctx, a.authDB, row.Team.ID, &userID, "CLI login/configure")
if err != nil {
    telemetry.ReportCriticalError(ctx, "error when creating team API key", err)
    a.sendAPIStoreError(c, http.StatusInternalServerError, "Error when creating team API key")
    return
}
```

`team.CreateAPIKey`(`packages/api/internal/team/apikeys.go:21-49`):

```go
func CreateAPIKey(ctx context.Context, authDB *authdb.Client, teamID uuid.UUID, createdBy *uuid.UUID, name string) (CreateAPIKeyResponse, error) {
    teamApiKey, err := keys.GenerateKey(keys.ApiKeyPrefix)  // 生成 e2b_... 前缀
    if err != nil { ... }

    apiKey, err := authDB.Write.CreateTeamAPIKey(ctx, authqueries.CreateTeamAPIKeyParams{
        TeamID:           teamID,
        CreatedBy:        createdBy,
        ApiKeyHash:       teamApiKey.HashedValue,
        ApiKeyPrefix:     teamApiKey.Masked.Prefix,
        ApiKeyLength:     int32(teamApiKey.Masked.ValueLength),
        ApiKeyMaskPrefix: teamApiKey.Masked.MaskedValuePrefix,
        ApiKeyMaskSuffix: teamApiKey.Masked.MaskedValueSuffix,
        Name:             name,
    })
    ...
    return CreateAPIKeyResponse{
        TeamApiKey: &apiKey,
        RawAPIKey:  teamApiKey.PrefixedRawValue,
    }, nil
}
```

### 5.3 为什么每次都创建新 API key?

这是本文的核心问题。注释 `teams.go:29` 的解释是:

> // We create a new API key for the CLI and backwards compatibility with API Keys hashing

**两个原因**:

1. **向后兼容**:旧客户端期望 `GET /teams` 的响应里有 `api_key` 字段,且能直接用于调用
2. **CLI 配置简化**:用户每次跑 `e2b login` 都拿到一个 API key,直接写进 `~/.e2b/.env` 即可用——无需额外步骤

但代价是:**每次 `e2b login` 都会在 team 里留下一个 API key**。如果用户频繁登录,API key 列表会膨胀。代码上没有自动清理——需要用户在 dashboard 手动删除或调 `DELETE /api-keys/{apiKeyID}`。

> 命名约定:`"CLI login/configure"` 是固定字符串,用作所有自动签发的 API key 的 `name`。这便于用户在 dashboard 上辨认「这是 CLI 自动生成的」。

---

## 六、`GetTeam` 辅助函数与跨 team 访问

`auth.go:33-82` 不是 REST 端点,而是一个 **共享辅助函数**——许多 handler 用它从请求中恢复 team 上下文。它解决了一个核心问题:**当用户用 access token 或 JWT 调用时,API 怎么知道操作哪个 team?**

### 6.1 流程

```go
// auth.go:33-82(简化)
func (a *APIStore) GetTeam(ctx, c, teamID *string) (*types.Team, *api.APIError) {
    // 优先:如果 auth middleware 已经注入 teamInfo(走 API key 路径)
    if team, ok := auth.GetTeamInfo(c); ok {
        return team, nil
    }

    // 否则:用 userID 查所有 team,再按 teamID 选(或选 default)
    if userID, ok := auth.GetUserID(c); ok {
        teams, apiErr := a.getUserTeams(ctx, userID)
        ...
        team, err := findTeam(teams, teamID)
        ...
        // 即便找到了,还要再做 team access 检查(防止 banned/blocked)
        if apiErr := applyTeamAccessCheck(c, team); apiErr != nil {
            return nil, apiErr
        }
        return team, nil
    }

    return nil, &api.APIError{Code: 401, ...}
}
```

### 6.2 `findTeam` 的选择逻辑

```go
// auth.go:84-107
func findTeam(teams []*types.TeamWithDefault, teamID *string) (*types.Team, error) {
    if teamID != nil {
        // 显式指定 teamID:精确匹配
        teamUUID, err := uuid.Parse(*teamID)
        ...
        for _, t := range teams {
            if t.Team.ID == teamUUID {
                return t.Team, nil
            }
        }
        return nil, fmt.Errorf("team '%s' not found", *teamID)
    }

    // 未指定:选 default team
    for _, t := range teams {
        if t.IsDefault {
            return t.Team, nil
        }
    }
    return nil, errors.New("default team not found")
}
```

### 6.3 注释里的「deprecated」

```go
// auth.go:36-37
// Deprecated: use API Token authentication instead.
teamID *string,
```

`teamID` 参数和整个 `GetTeam` 函数被标记为 deprecated。设计意图是:**新代码应该走 API key 路径**——API key 自动绑定 team,不需要这层复杂逻辑。但 access token 与 JWT 路径还需要支持,所以函数本身不能删。

---

## 七、AuthProvider JWT 验证深入

`auth-module.md` 第五节已讨论过大体流程。这里只补充 CLI 流程相关的要点。

### 7.1 验证入口

API 把验证委托给 `authService`。`handlers/store.go:403-408` 上的 `GetUserIDFromAuthProviderToken` 是 `AuthProviderBearerAuth` security scheme 的 validation function:

```go
// handlers/store.go:403-408
func (a *APIStore) GetUserIDFromAuthProviderToken(ctx context.Context, ginCtx *gin.Context, token string) (uuid.UUID, *api.APIError) {
    ctx, span := tracer.Start(ctx, "get user id from auth provider token")
    defer span.End()

    return a.authService.ValidateAuthProviderToken(ctx, ginCtx, token)
}
```

`authService.ValidateAuthProviderToken`(`service.go:174-184`):

```go
func (s *authService) ValidateAuthProviderToken(ctx, ginCtx, token) (uuid.UUID, *APIError) {
    if s.authProviderVerifier == nil {
        return uuid.UUID{}, &APIError{
            Err:       errors.New("auth provider is not configured"),
            ClientMsg: "Backend authentication failed",
            Code:      http.StatusUnauthorized,
        }
    }
    return s.validateJWTWithProvider(ctx, ginCtx, s.authProviderVerifier, token, "auth provider")
}
```

**关键**:`authProviderVerifier == nil` 时所有 JWT 验证都失败。这是一个 **可选功能**——通过 `AUTH_PROVIDER_CONFIG` 环境变量控制。

### 7.2 Identity 缓存

`identity_lookup.go:20` 定义了缓存 TTL:

```go
const identityCacheTTL = 1 * time.Minute
```

`(iss, sub) → userID` 映射缓存 1 分钟,**只缓存成功结果**(`identity_lookup.go:18-19` 注释):

> // Newly provisioned users can sign in immediately and transient db errors don't get pinned.

如果缓存错误结果,新创建的用户要等 1 分钟才能登录——这违背了「注册后立即可用」的体验。所以只有"确认存在"的映射才缓存。

---

## 八、gin context 中的 userID / teamInfo

`gin.go` 提供 4 个核心函数:

| 函数 | 用途 |
|---|---|
| `setUserID(c, userID)` | middleware 注入 |
| `GetUserID(c) (uuid.UUID, bool)` | handler 读取(可失败) |
| `MustGetUserID(c) uuid.UUID` | handler 读取(失败 panic) |
| `setTeamInfo(c, team)` / `GetTeamInfo(c)` / `MustGetTeamInfo(c)` | 同上,team 版本 |

### 8.1 注入路径

| Middleware | 注入字段 |
|---|---|
| `NewApiKeyAuthenticator` | `teamInfo`(因为 API key 直接绑定 team) |
| `NewAccessTokenAuthenticator` | `userID` |
| `NewAuthProviderBearerAuthenticator` | `userID` |
| `NewAuthProviderTeamAuthenticator` | `teamInfo`(配合 `X-Team-ID` 头) |

### 8.2 context key 常量

```go
// gin.go:11-13
const (
    teamContextKey   = "team"
    userIDContextKey = "user_id"
)
```

直接用字符串。简单但需要约定——所有 handler 都通过 `auth.GetUserID` / `auth.GetTeamInfo` 读取,不能直接用 `c.Get("user_id")`(虽然技术上可以)。

---

## 九、关键流程时序图

### 9.1 完整 CLI 登录(`e2b auth login` → JWT 换取 access token + API key)

```
CLI              API                      Auth DB            Auth Provider
  │                │                          │                    │
  │ 1. POST /access-tokens                    │                    │
  │    Bearer <JWT>(来自 OIDC)                │                    │
  │───────────────>│                          │                    │
  │                │ ValidateAuthProviderToken│                    │
  │                │   ↓                      │                    │
  │                │ Verifier.Verify          │                    │
  │                │   ↓ (iss, sub) lookup    │                    │
  │                │ GetUserIdentity──────────>│                    │
  │                │ <──────────── userID      │                    │
  │                │ setUserID(c, userID)     │                    │
  │                │                          │                    │
  │                │ PostAccessTokens         │                    │
  │                │ GenerateKey(sk_e2b_)     │                    │
  │                │ CreateAccessToken────────>│                    │
  │                │ <─────────── row          │                    │
  │ 2. 201 + access_token                     │                    │
  │    (sk_e2b_***...)                        │                    │
  │<───────────────│                          │                    │
  │                │                          │                    │
  │ 3. GET /teams  │                          │                    │
  │    Bearer sk_e2b_...                      │                    │
  │───────────────>│                          │                    │
  │                │ ValidateAccessToken      │                    │
  │                │ GetUserIDByHashedAccessToken                  │
  │                │──────────────────────────>│                    │
  │                │ <─────────── userID      │                    │
  │                │ GetTeamsWithUsersTeams───>│                    │
  │                │ <─────────── rows         │                    │
  │                │ (per team) CreateAPIKey──>│ (签发新 API key)   │
  │                │ <──────────── apiKey      │                    │
  │ 4. 200 + [{TeamID, Name, ApiKey: e2b_...}]│                    │
  │<───────────────│                          │                    │
  │                │                          │                    │
  │ 5. 写入 ~/.e2b/.env                        │                    │
  │    E2B_ACCESS_TOKEN=sk_e2b_...            │                    │
  │    E2B_API_KEY=e2b_...(从 GET /teams)    │                    │
```

### 9.2 后续机器调用(API key 路径)

```
SDK              API                      Auth DB
  │                │                        │
  │ POST /sandboxes │                       │
  │ X-API-Key: e2b_...                     │
  │───────────────>│                        │
  │                │ ValidateAPIKey         │
  │                │ teamCache.GetOrSet     │
  │                │   ↓ miss               │
  │                │ GetTeamByHashedAPIKey─>│
  │                │ <────────── team       │
  │                │ setTeamInfo(c, team)   │
  │                │                        │
  │                │ PostSandboxes          │
  │                │ ...                    │
  │ 201 + Sandbox  │                        │
  │<───────────────│                        │
```

注意:机器调用走 `ApiKeyAuth` 路径,team 直接从 API key 解析——**完全跳过 GetTeam 辅助函数**。这就是 `GetTeam` 注释里说"Deprecated: use API Token authentication instead"的原因。

---

## 十、Feature Flag 与废弃路径

### 10.1 `DisableE2BAccessTokenProvisioningFlag`

```go
// packages/shared/pkg/featureflags/flags.go:222-226
// DisableE2BAccessTokenProvisioningFlag stops POST /access-tokens from issuing
// new E2B access tokens. Existing tokens remain valid until they expire or are
// deleted by the user.
DisableE2BAccessTokenProvisioningFlag = NewBoolFlag("disable-e2b-access-token-provisioning", false)
```

**关闭效果**:OpenAPI 标了 `deprecated: true` 之外,代码层面用 LD flag 控制实际的禁用——可以按 user 灰度。关闭后:
- `POST /access-tokens` → 410 Gone
- 已签发的 token 仍然有效(直到用户删除或过期)
- 客户端会看到提示消息,引导迁移到 API key

### 10.2 为什么不直接删除端点?

API 的兼容性承诺:已发布的端点不能直接 410。**先标 deprecated → 用 flag 灰度禁用 → 长期监控使用率 → 最终下线** 是标准做法。`POST /access-tokens` 当前在「灰度禁用」阶段。

### 10.3 其他相关 flag

CLI 登录链路没有其他 feature flag。`GetTeams` 与 `CreateAPIKey` 是无条件执行的——只要用户能通过 JWT 验证,就能拿到 API key。

---

## 十一、配置

### 11.1 环境变量

| 变量 | 作用 |
|---|---|
| `AUTH_PROVIDER_CONFIG` | JSON,描述 OIDC 颁发者(详见 `provider_config_parse.go:9-22`)。空字符串或字面值 `"null"` 都视为未配置 |
| `AUTH_DB_POSTGRES_CONNECTION_STRING` | auth DB 连接串(JWT → userID 查询走这里) |
| `LAUNCHDARKLY_SDK_KEY` | LaunchDarkly(用于 `DisableE2BAccessTokenProvisioningFlag` 灰度) |

### 11.2 头部常量(`consts.go:5-13`)

| 常量 | 值 |
|---|---|
| `HeaderAPIKey` | `"X-API-Key"` |
| `HeaderAuthorization` | `"Authorization"` |
| `HeaderTeamID` | `"X-Team-ID"` |
| `HeaderAdminToken` | `"X-Admin-Token"` |
| `PrefixAPIKey` | `"e2b_"` |
| `PrefixAccessToken` | `"sk_e2b_"` |
| `PrefixBearer` | `"Bearer "` |

### 11.3 Identity 缓存 TTL

`identityCacheTTL = 1 * time.Minute`(`identity_lookup.go:20`)——硬编码,不可配。

---

## 十二、关键代码文件索引

| 文件 | 主要导出 | 说明 |
|---|---|---|
| `packages/api/internal/handlers/teams.go` | `GetTeams` | `GET /teams` + 自动签发 API key |
| `packages/api/internal/handlers/accesstoken.go` | `PostAccessTokens`、`DeleteAccessTokensAccessTokenID` | Access token CRUD |
| `packages/api/internal/handlers/auth.go` | `GetTeam`、`findTeam`、`getUserTeams`、`resolveTemplateAndTeam` | 共享辅助函数 |
| `packages/api/internal/team/apikeys.go` | `CreateAPIKey`、`DeleteAPIKey`、`CreateAPIKeyResponse` | API key 生成 helper |
| `packages/auth/pkg/auth/middleware.go` | `NewApiKeyAuthenticator`、`NewAccessTokenAuthenticator`、`NewAuthProviderBearerAuthenticator`、`NewAuthProviderTeamAuthenticator` | 各 security scheme 的 authenticator 工厂 |
| `packages/auth/pkg/auth/service.go` | `ValidateAPIKey`、`ValidateAccessToken`、`ValidateAuthProviderToken`、`ValidateAuthProviderTeam` | 三种凭证的验证 service |
| `packages/auth/pkg/auth/gin.go` | `GetUserID`、`MustGetUserID`、`GetTeamInfo`、`MustGetTeamInfo` | gin context 读取 helper |
| `packages/auth/pkg/auth/consts.go` | `HeaderAPIKey`、`PrefixAPIKey`、`PrefixAccessToken` 等 | 头部与前缀常量 |
| `packages/auth/pkg/auth/verifier.go` | `Verifier`、`ProviderConfig`、`NewVerifier` | OIDC JWT 验证器 |
| `packages/auth/pkg/auth/identity_lookup.go` | `authIdentityLookup`、`cachingIdentityLookup` | `(iss, sub) → userID` 查询 + 缓存 |
| `packages/auth/pkg/auth/provider_config_parse.go` | `ParseProviderConfig` | 解析 `AUTH_PROVIDER_CONFIG` env |
| `packages/shared/pkg/keys` | `GenerateKey`、`ApiKeyPrefix`、`AccessTokenPrefix` | 凭证生成 |
| `packages/shared/pkg/featureflags/flags.go` | `DisableE2BAccessTokenProvisioningFlag` | 弃用 flag(行 226) |
| `spec/openapi.yml` | `/teams`(行 2006)、`/access-tokens`(行 3572)、`/access-tokens/{accessTokenID}`(行 3600) | OpenAPI 规范 |

---

## 十三、设计要点与权衡

### 13.1 为什么 `GET /teams` 会写 DB?

REST 的"GET 不应有副作用"是个常见 best practice,但这里违反了。原因:

- **CLI UX 优先**:用户登录后期望"开箱即用",`e2b login` 之后立刻能 `e2b sandbox spawn`。如果 GET /teams 只读,CLI 还要再 POST /api-keys 创建一个,UX 多一步
- **幂等性妥协**:每次 GET 都创建新 key,所以**不是幂等的**。但返回的 team 列表是幂等的——副作用只是多了一个 API key 行
- **替代方案**:CLI 自己调 POST /api-keys(更"正确"但 UX 差);或 cookie-based session(不适合 CLI)

代码用 `name = "CLI login/configure"` 标记这些自动生成的 key,让用户在 dashboard 上能识别。

### 13.2 三层 authenticator 链

```
oapi-codegen security scheme
        ↓
Authenticator interface(middleware.go:34-37)
        ↓
commonAuthenticator[T] 泛型实现(middleware.go:40-46)
        ↓
validationFunc 注入(由 `APIStore` 上的方法提供,定义在 `handlers/store.go`,
                    如 `GetTeamFromAPIKey` / `GetUserFromAccessToken` / `GetUserIDFromAuthProviderToken`,
                    内部委托给 `authService.Validate*`)
        ↓
setContextFunc 注入 gin context(middleware.go:106-108)
```

**为什么用泛型**?不同凭证的 validation 返回类型不同(API key → `*Team`,access token → `uuid.UUID`)。泛型让类型在编译期就一致,避免 `interface{}` + type assert 的运行时开销。

### 13.3 Identity 缓存只缓存命中

`identity_lookup.go:59-69` 的 `cachingIdentityLookup` 只缓存成功结果。原因:**新用户登录不能延迟**。如果缓存"用户不存在",刚注册的用户要等 TTL(1 分钟)过期才能登录——这是糟糕的体验。

代价:对未注册用户的查询会绕过缓存,可能被滥用做 DoS。但 OIDC JWT 验证本身就有签名校验,所以攻击者必须先有合法 JWT——门槛够高。

### 13.4 `GetTeam` 标 deprecated 但不能删

`auth.go:36-37` 的注释:

> // Deprecated: use API Token authentication instead.

设计意图是:**新代码用 API key,不需要 GetTeam 的"从 userID 反查 team"逻辑**。但 access token + JWT 路径还需要它。这是一个 **逐步迁移** 的例子——鼓励新代码用 API key,但旧路径继续支持。

### 13.5 弃用路径用 LD flag 而非版本号

`POST /access-tokens` 的弃用用 `DisableE2BAccessTokenProvisioningFlag`(按 user 维度)而非 API 版本(v2)。原因:
- 弃用是 **行为变化**,不是接口变化——v2 通常用于 schema 改变
- 按 user 灰度可以让一部分用户先迁移,观察问题
- 版本号会让 SDK 同时维护两个端点,成本高

---

## 十四、常见问题与排查

### Q1:`e2b auth login` 之后,API key 列表里有几十个 "CLI login/configure"

每次 `e2b auth login` 都会调 `GET /teams`,而 `GET /teams` **无条件** 创建新 API key。频繁登录会累积。**处理**:
- 在 dashboard 上批量删除旧 key
- 或调 `DELETE /api-keys/{apiKeyID}`
- 长期方案:CLI 应该缓存第一次拿到的 key,后续登录复用

### Q2:`POST /access-tokens` 返回 410 Gone

用户的 `DisableE2BAccessTokenProvisioningFlag` 被开启(LD 上按 user 灰度)。**处理**:迁移到 API key。文档链接在错误消息里:`https://e2b.dev/docs/migration/access-token-deprecation`。

### Q3:`Invalid auth provider token.` 错误

JWT 验证失败。常见原因:
- JWT 过期(检查 `exp` claim)
- `AUTH_PROVIDER_CONFIG` 没配或配错
- 用户的 auth provider issuer 没在 config 里(检查 `iss` claim)
- auth DB 里没有该用户的 identity 行(`(iss, sub)` 不匹配)

**排查**:看 trace 中的 `auth.scheme` 和 `auth.reason` 事件,会给出具体原因。

### Q4:`Default team not found`

用户调 `GetTeam` 时没指定 teamID,且没有任何 team 标记为 `IsDefault`。**处理**:
- 客户端显式指定 `teamID`
- 或在 dashboard 上把某个 team 设为 default

### Q5:`You don't have access to any teams`

用户的 account 没有关联任何 team。**处理**:接受邀请或创建 team。这是 `getUserTeams` 返回空数组时抛的(`auth.go:119-125`)。

### Q6:`X-Team-ID` 头的作用?

当用 access token 或 JWT 调需要 team 上下文的端点时,`X-Team-ID` 头告诉 API "我要操作哪个 team"。比如 `/sandboxes`(POST 创建)如果用 JWT 调用,必须带 `X-Team-ID`。`NewAuthProviderTeamAuthenticator`(`middleware.go:176-186`)负责验证。

### Q7:`GET /teams` 调用之后,有些 team 没返回 `ApiKey`

这不应该发生——代码对每个 team 都调 `CreateAPIKey`。如果某个 team 失败,**整个请求返回 500**(`teams.go:31-36`),不会有部分成功。如果客户端看到部分响应,可能是网络中断后的截断。

### Q8:多个 OIDC 颁发者怎么配?

`AUTH_PROVIDER_CONFIG` 是 JSON,`jwt` 字段是数组(`verifier.go:17`):

```json
{
  "jwt": [
    {"issuer": "https://auth0.example/", "jwks_url": "..."},
    {"issuer": "https://okta.example/", "jwks_url": "..."}
  ]
}
```

`Verifier.Verify`(`verifier.go:98`)按顺序尝试每个 strategy,返回第一个成功的。

### Q9:为什么 `identityCacheTTL = 1 * time.Minute`?

硬编码,不可配。设计权衡:
- 太长:新用户注册后要等才能登录
- 太短:缓存几乎无效,每次 JWT 验证都打 DB
- 1 分钟是经验值——足够让 burst 请求共享缓存,又不至于让新用户等待

### Q10:CLI 自动签发的 API key 会过期吗?

不会。`CreateTeamAPIKeyParams` 定义于 `packages/db/pkg/auth/queries/create_team_api_key.sql.go:40-49`,无 expiration 字段;`team/apikeys.go:29-38` 是该类型的构造调用,**不设置 expiration**。**这些 key 是持久的**,直到用户删除。这是另一个为什么 Q1 会累积的原因。

---

## 附录 A:凭证类型速查表

| 维度 | API key | Access token | Auth provider JWT |
|---|---|---|---|
| 头部 | `X-API-Key` | `Authorization: Bearer` | `Authorization: Bearer` |
| 前缀 | `e2b_` | `sk_e2b_` | (无) |
| 绑定 | team | user | user |
| 注入 context | `teamInfo` | `userID` | `userID` |
| 生命周期 | 持久(到删除,代码无 expiration) | 持久(到删除,代码无 expiration;已弃用) | 短期(由 auth provider `exp` 决定) |
| 创建入口 | `POST /api-keys` / `GET /teams` | `POST /access-tokens` | 外部 auth provider |
| 典型场景 | SDK / 服务账号 | 旧 CLI 弃用中 | CLI 登录瞬间 |
| Security scheme | `ApiKeyAuth` | `AccessTokenAuth` | `AuthProviderBearerAuth` |

---

## 附录 B:错误码与 HTTP 状态映射

| HTTP | 触发场景 | 典型消息 |
|---|---|---|
| 401 | JWT 无效/过期 | `Invalid auth provider token.` |
| 401 | access token 无效 | ``Invalid Access token, try to login again by running `e2b auth login`.`` |
| 401 | API key 无效 | `Invalid API key, please visit https://e2b.dev/docs/api-key for more information.` |
| 401 | 未认证(无任何凭证) | `You are not authenticated` |
| 403 | team access 检查失败(banned/blocked) | (具体原因) |
| 403 | 用户不属于任何 team | `You don't have access to any teams` |
| 403 | 跨 team 访问 | `You are not allowed to access this team` |
| 410 | access token 创建被 flag 关闭 | `Creating new access tokens is disabled. ...` |
| 500 | DB 写入失败(API key/access token 创建) | `Error when creating team API key` / `Error when creating access token` |
| 500 | `Default team not found` | `Default team not found` |

---

## 附录 C:术语表

| 术语 | 含义 |
|---|---|
| **CLI** | E2B 命令行工具(`e2b` 命令) |
| **Auth provider** | 外部 OIDC 兼容的身份提供者(Auth0、Okta、Keycloak 等) |
| **JWT** | JSON Web Token,auth provider 颁发的短期凭证 |
| **OIDC** | OpenID Connect,基于 OAuth 2.0 的身份层 |
| **`(iss, sub)`** | JWT 的 issuer 与 subject 联合主键,唯一标识一个用户身份 |
| **API key** | E2B 自管的长期凭证,绑定单个 team |
| **Access token** | E2B 自管的较长期凭证,绑定 user(已弃用) |
| **Default team** | 用户标记为默认的 team,`GetTeam` 在未指定 teamID 时使用 |
| **Identity lookup** | `(iss, sub) → userID` 的查询,JWT 验证的关键步骤 |
| **Singleflight** | 同 key 并发查询合并为一次底层调用的模式(`cachingIdentityLookup` 用到) |
| **Mask** | 凭证的可识别但不可反推的部分(如 `sk_e2b_***abc`),用于 UI 展示 |
