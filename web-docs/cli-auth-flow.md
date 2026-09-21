# CLI 登录与凭证签发流程

> 范围:用户通过 CLI(`e2b` 命令行)登录 E2B、获得可用于 SDK 调用的凭证的完整流程。涉及 `GET /teams`、OIDC JWT 验证、以及 gin context 中 `userID` / `teamInfo` 的注入机制。
>
> 本文聚焦「人 → 凭证」的链路。机器(M2M)直接用 API key 调用的路径已在 `api-keys-module.md` 中讨论。
>
> ⛔ **2026.30 重大变动**:`sk_e2b_` access token 已被整体删除(端点、security scheme、DB 表与函数、feature flag、`auth.PrefixAccessToken`、`keys.AccessTokenPrefix` 全部移除)。CLI 现在**只能用 API key(`E2B_API_KEY`)或用户 JWT 认证**。本文中所有涉及 access token 的段落均已就地标注为历史,变动清单见 [十五、2026.30 变动速览](#十五202630-变动速览)。
>
> 行号约定:所有 `file:line` 均按 tag `2026.30` 核对;与 2026.29 不同处写作「行 N(2026.30;2026.29 为 M)」。

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
- [十五、2026.30 变动速览](#十五202630-变动速览)
- [附录 A:凭证类型速查表](#附录-a凭证类型速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录-b错误码与-http-状态映射)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

E2B 的 API 接受两种**面向用户**的凭证(详见 `auth-module.md`):API key(`e2b_...`)、auth provider JWT。**前者机器友好、可长期保存;后者是短期 OIDC JWT,直接来自用户登录的 auth provider**。

⛔ **第三种凭证 access token(`sk_e2b_...`)在 2026.30 已被彻底删除**,不再是可选项。删掉的东西包括:OpenAPI 的 `AccessTokenAuth` scheme、`packages/api/internal/handlers/accesstoken.go`、`authService.ValidateAccessToken`、`keys.AccessTokenPrefix`、`auth.PrefixAccessToken`、`packages/db/pkg/auth/sql_queries/access_token/` 整个目录、`public.access_tokens` 表与 `public.generate_access_token()` 函数、以及两个 feature flag。详见 [十五、2026.30 变动速览](#十五202630-变动速览)。

**人类用户** 的典型路径是:
1. 通过浏览器跳转到 auth provider 登录,获得 JWT
2. 把 JWT 放进 `Authorization: Bearer <jwt>` 头
3. 调用 API——API 验证 JWT 并把 `userID` 注入 gin context
4. 调用 `GET /teams`,**用 JWT 换取更稳定的凭证**(per-team API key)
5. CLI 把 API key 写进本地配置,后续调用走机器凭证路径

`GET /teams` 是**唯一不接受 API key 的人类登录端点**。它在 OpenAPI 中的 security 只有一个(`spec/openapi.yml:2356-2357`,2026.29 为 `2044-2046`,当时是 `AccessTokenAuth` + `AuthProviderBearerAuth` 两个):

- `GET /teams`:`AuthProviderBearerAuth`(用户 JWT)

也就是说,API key 完全不能调 `GET /teams`(access token 曾经可以,但已删除)。这就把"team 列表 + 自动 API key 签发"限制在人类登录链路内。

> ⚠️ **容易搞错**:`GET /teams` 也**不接受** `AdminJWTAuth`(服务 JWT)。2026.30 新增的 `AdminJWTAuth` 虽然同样是 `Authorization: Bearer` 头,但它只在 `spec/openapi.yml` 中与 `AdminTeamAuth`(`X-Team-ID`)成对出现(48 处全部是 AND 组),而 `/teams` 的 security 块里没有它。

### 与其他文档的边界

| 主题 | 文档 |
|---|---|
| 各凭证的内部验证 | `auth-module.md` |
| API key 的 CRUD | `api-keys-module.md` |
| ⛔ Access token(已退役) | `access-tokens-module.md` |
| OIDC 验证底层(`internal/token/` 包) | `auth-module.md` 第五节 |
| **CLI 登录流程本身、`GET /teams` 自动签发 API key** | **本文** |

---

## 二、三种凭证类型回顾

| 凭证 | HTTP 头 | 前缀 | gin context 注入 | security scheme |
|---|---|---|---|---|
| API key | `X-API-Key: e2b_...` | `e2b_` | `*types.Team` | `ApiKeyAuth` |
| ⛔ Access token | `Authorization: Bearer sk_e2b_...` | `sk_e2b_` | `uuid.UUID`(userID) | ⛔ `AccessTokenAuth`(已删除) |
| Auth provider JWT | `Authorization: Bearer <jwt>` | (无固定前缀) | `uuid.UUID`(userID) | `AuthProviderBearerAuth` |
| 服务 JWT(2026.30 新增) | `Authorization: Bearer <service-jwt>` | (无固定前缀) | `string`(service issuer) | `AdminJWTAuth` |

**关键区别**:
- **API key 直接绑定 team**:验证时一次 DB/cache 查询返回完整的 team 数据,后续请求不需要再带 team 信息
- **Auth provider JWT 只绑定 user**:验证后只拿到 userID,handler 还需要从请求参数(`/teams/{teamID}`)或 `X-Team-ID` 头里恢复 team 上下文
- **生命周期**:JWT 短期(通常几分钟到一小时,由 auth provider `exp` claim 决定);API key 在 DB 层不设过期,持久有效直到用户删除

### 2.1（2026.30 变动）access token 相关的类型与构造已全部消失

以下内容在 2026.30 已不存在,读到旧资料时不要再引用:

| 2026.29 存在的东西 | 2026.30 状态 |
|---|---|
| `CreateAccessTokenParams`(`packages/db/pkg/auth/queries/create_access_token.sql.go:39-48`) | ⛔ 文件删除 |
| `accesstoken.go:49-58`(该类型的构造调用) | ⛔ 文件删除 |
| `keys.AccessTokenPrefix = "sk_e2b_"`(`packages/shared/pkg/keys/constants.go:5`) | ⛔ 删除;2026.30 的 `constants.go` 只剩 `ApiKeyPrefix = "e2b_"`(行 3) |
| `auth.PrefixAccessToken`(`packages/auth/pkg/auth/consts.go:12`) | ⛔ 删除(见 §11.2) |

### 凭证之间的转换

```
JWT (短期)             GET /teams        API key (长期,per-team)
   │                      │                      ▲
   └──────────────────────┴──────────────────────┘
                          │
                    机器调用 SDK
                          │
                          ▼
```

人类用户用 JWT 换取长期 API key,SDK/CLI 后续就走机器路径。⛔ 2026.29 图中那条 `POST /access-tokens → access token` 的支路在 2026.30 已不存在(该端点现在无条件返回 410 Gone,见 §4.4)。

---

## 三、CLI 登录完整流程(端到端)

> ⛔ **下面这张图是 2026.29 的历史流程**。图中的第 5–7 步(`POST /access-tokens`、把 `sk_e2b_...` 写进 `~/.e2b/.env`、用 `Authorization: Bearer sk_e2b_...` 调 SDK)在 2026.30 已全部失效——该端点现在无条件返回 410 Gone,CLI 也不再持有 access token。2026.30 的实际流程见 [§9.3](#93-202630-变动cli-登录的实际链路)。

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

> ⛔ **2026.30:整个端点与 handler 已删除。** 本节以下内容(4.1–4.3)描述的是 **2026.29** 的行为,保留作为历史参考。`packages/api/internal/handlers/accesstoken.go`(及其 `_test.go`)已删除,OpenAPI 里 `/access-tokens`、`/access-tokens/{accessTokenID}`、`AccessTokenAuth` scheme、`NewAccessToken` / `CreatedAccessToken` schema、`410` response 组件全部消失。当前行为见 §4.4。

`accesstoken.go:20-79` 是入口(2026.29)。该端点在 OpenAPI 中已标记为 `deprecated: true`,但代码仍然工作。

### 4.1 主干流程(⛔ 2026.29 历史)

```
1. 取 userID(MustGetUserID — 必须有 AuthProvider JWT)
2. 检查 DisableE2BAccessTokenProvisioningFlag:
   - 若开启 → 410 Gone,提示用 API key
3. ParseBody[NewAccessToken](必填 name)
4. keys.GenerateKey(AccessTokenPrefix)  ← 生成 sk_e2b_... 前缀的 token
5. authDB.Write.CreateAccessToken(写入 hash、prefix、length、mask、name)
6. 返回 201 + CreatedAccessToken{Token:PrefixedRawValue, Mask:IdentifierMaskingDetails}
```

### 4.2 关键代码(⛔ 2026.29 历史)

```go
// accesstoken.go:23-29
userID := auth.MustGetUserID(c)

if a.featureFlags.BoolFlag(ctx, featureflags.DisableE2BAccessTokenProvisioningFlag, featureflags.UserContext(userID.String())) {
    a.sendAPIStoreError(c, http.StatusGone, "Creating new access tokens is disabled. E2B_ACCESS_TOKEN is deprecated; use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation")
    return
}
```

**为什么按 userID 而不是全局检查 flag?** LaunchDarkly 支持按 user 维度灰度——可以先把一部分用户的 access token 创建禁用,观察是否有问题,再全量推开。`UserContext(userID.String())`(`accesstoken.go:25` 的 `BoolFlag` 调用参数)是为 LD 提供的 user 维度上下文。

### 4.3 响应中的 mask 信息(⛔ 2026.29 历史)

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

### 4.4（2026.30 变动）端点现在的行为:无条件 410 Gone

删除端点时没有简单地让它从路由表消失,而是**注册了一个显式的 410 处理器**,并且**刻意放在 OpenAPI validator 中间件之前**:

```go
// packages/api/main.go:166-173
// Access tokens are removed. Registered before the OpenAPI validator
// middleware (which rejects paths missing from the spec) so old clients
// get a clear 410 instead of a 404.
accessTokensGone := func(c *gin.Context) {
    apierrors.SendAPIStoreError(c, http.StatusGone, "E2B_ACCESS_TOKEN is deprecated and no longer supported. Use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation")
}
r.POST("/access-tokens", accessTokensGone)
r.DELETE("/access-tokens/:accessTokenID", accessTokensGone)
```

要点:

- `packages/api/main.go:172`(POST)与 `:173`(DELETE)是唯一的注册点。两个方法共用同一个 handler,所以错误消息完全一致。
- 注册顺序在 `packages/api/main.go:190` 起的 `r.Use(...OapiRequestValidatorWithOptions...)` **之前**——因为 `/access-tokens` 已不在 `spec/openapi.yml` 中,validator 会以 404 拒绝未在 spec 里的路径。先注册 410 才能让旧客户端看到有意义的迁移提示。
- 错误消息是**精确字符串**,未做任何格式化:`E2B_ACCESS_TOKEN is deprecated and no longer supported. Use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation`
- 走的是 `apierrors.SendAPIStoreError`(`packages/shared/pkg/apierrors/apierrors.go:26-28`),响应体是 `{"code": 410, "message": "..."}`。

> ⚠️ 与 2026.29 的关键差别:2026.29 的 410 是 **feature flag 驱动的**(只有被 LD 灰度的用户才拿到 410,消息是 `Creating new access tokens is disabled. ...`);2026.30 的 410 是**无条件的**,消息也换成了 `E2B_ACCESS_TOKEN is deprecated and no longer supported. ...`。两者的措辞不同,排查时不要混用。

**相关提交**:`458031191` "feat(api): remove deprecated E2B access token auth"(2026-08-23)、`25d454329` "chore(auth): remove legacy access token remnants"(2026-09-05)。

---

## 五、`GET /teams`:列出团队并自动签发 API key

`teams.go:14-47` 是入口(行号与 2026.29 相同)。这个端点 **既查询又写**——这是个不同寻常的设计。

> **2026.30 变动**:`GET /teams` 的**业务逻辑一行未改**,仍是 CLI 自动签发 API key 的入口(2026.29 里它是两个入口之一)。唯一的代码差异是读连接的使用方式——`teams.go:19` 从 `a.authDB.Read.GetTeamsWithUsersTeams(ctx, userID)`(2026.29)变成 `a.authDB.GetTeamsWithUsersTeams(ctx, userID)`,因为 auth DB 客户端的读写分离被移除了(见 §11.4)。

### 5.1 主干流程

```
1. 取 userID(MustGetUserID)
2. authDB.GetTeamsWithUsersTeams(userID) → 查询用户的所有 team
   (2026.29 为 authDB.Read.GetTeamsWithUsersTeams)
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

`team.CreateAPIKey`(`packages/api/internal/team/apikeys.go:22-50`;2026.29 为 `:21-49`,整体下移 1 行,因为 import 块多了一行):

```go
func CreateAPIKey(ctx context.Context, authDB *authdb.Client, teamID uuid.UUID, createdBy *uuid.UUID, name string) (CreateAPIKeyResponse, error) {
    teamApiKey, err := keys.GenerateKey(keys.ApiKeyPrefix)  // 生成 e2b_... 前缀
    if err != nil { ... }

    apiKey, err := authDB.CreateTeamAPIKey(ctx, authqueries.CreateTeamAPIKeyParams{  // 2026.30;2026.29 为 authDB.Write.CreateTeamAPIKey
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

`auth.go:33-82` 不是 REST 端点,而是一个 **共享辅助函数**——许多 handler 用它从请求中恢复 team 上下文。它解决了一个核心问题:**当用户用 JWT 调用时,API 怎么知道操作哪个 team?**

> **2026.30 变动**:函数签名与行号全部未变(`GetTeam` 在 `auth.go:33-82`、`findTeam` 在 `:84-107`、`Deprecated` 注释在 `:36-37`、`applyTeamAccessCheck` 在 `:21-31`)。整个文件的唯一差异是一句注释:`auth.go:132` 从 `// For access token auth: only template ID lookup ...`(2026.29)改成 `// For user bearer auth: only template ID lookup ...`(2026.30)。⚠️ `applyTeamAccessCheck` **没有**新增对 service JWT(`AdminJWTAuth`)的处理。

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

API 把验证委托给 `authService`。`handlers/store.go:538-543`(2026.29 为 `:418-423`)上的 `GetUserIDFromAuthProviderToken` 是 `AuthProviderBearerAuth` security scheme 的 validation function:

```go
// handlers/store.go:538-543
func (a *APIStore) GetUserIDFromAuthProviderToken(ctx context.Context, ginCtx *gin.Context, token string) (uuid.UUID, *api.APIError) {
    ctx, span := tracer.Start(ctx, "get user id from auth provider token")
    defer span.End()

    return a.authService.ValidateAuthProviderToken(ctx, ginCtx, token)
}
```

`authService.ValidateAuthProviderToken`(`packages/auth/pkg/auth/internal/service/service.go:149-159`;2026.29 为 `packages/auth/pkg/auth/service.go:174-184`):

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

`identity_lookup.go:20` 定义了缓存 TTL(2026.30 路径为 `packages/auth/pkg/auth/internal/service/identity_lookup.go:20`;2026.29 为 `packages/auth/pkg/auth/identity_lookup.go:20`,行号相同):

```go
const identityCacheTTL = 1 * time.Minute
```

`(iss, sub) → userID` 映射缓存 1 分钟,**只缓存成功结果**(`identity_lookup.go:16-19` 注释):

> // Newly provisioned users can sign in immediately and transient db errors don't get pinned.

如果缓存错误结果,新创建的用户要等 1 分钟才能登录——这违背了「注册后立即可用」的体验。所以只有"确认存在"的映射才缓存。

### 7.3（2026.30 新增）三种 verifier 与 Admin JWT

2026.30 把原先单一的 `Verifier` 拆成**三种**类型,统一放在 `packages/auth/pkg/auth/internal/token/provider.go`:

| 类型 | 定义位置 | 找 key 的方式 | 返回 | 是否有 identity 映射 |
|---|---|---|---|---|
| `JWKSVerifier` | `internal/token/jwks_verifier.go:26` | issuer 的常规 JWKS 路径(**不做 OIDC discovery**) | `jwt.MapClaims` | 否 |
| `OIDCVerifier` | `internal/token/provider.go:59-61` | OIDC discovery | `oidc.TokenIdentity` | 否 |
| `LinkedOIDCVerifier` | `internal/token/provider.go:69-73` | OIDC discovery | `uuid.UUID`(内部 user) | 是(持有 `IdentityLookup`) |

- `LinkedOIDCVerifier` 就是 **2026.29 的 `Verifier`**,`authService` 用的仍是它。
- 构造函数:`NewOIDCVerifier`(`provider.go:78`)、`NewLinkedOIDCVerifier`(`provider.go:84`)。
- ⚠️ `NewLinkedOIDCVerifier` **只在「配置了 issuer 但 lookup 为 nil」时才报错**(`provider.go:89-91`)。配置里一个 issuer 都没有时返回 `(nil, nil)`——`nil` verifier 在运行期拒绝一切,而不是启动失败。这是刻意的:未配置 auth provider 是受支持的状态。
- `JWKSVerifier` 由 `NewJWKSVerifier`(`internal/token/jwks_verifier.go:35`)构造,底层用 `jwks.NewVerifierFromIssuerJWKS`(`internal/token/jwks/verifier.go:79`),后者在 `:80` 显式清空 `DiscoveryURL`——**这是它和 OIDC 路径最本质的区别**。
- `httpTimeout = 10 * time.Second`(`internal/token/jwks/verifier.go:22`;2026.29 叫 `oidcHTTPTimeout`,同样 10 秒)。

**Admin JWT 的接线**(`AdminJWTAuth` security scheme,`spec/openapi.yml:31`):

```go
// packages/api/main.go:437
adminJWTVerifier, err := auth.NewJWKSVerifier(ctx, config.AdminAuthProvider, http.DefaultClient)
```

- 配置来自 `ADMIN_AUTH_PROVIDER_CONFIG`(`packages/api/internal/cfg/model.go:136`,类型 `sharedauth.ProviderConfig`;相邻的 `AUTH_PROVIDER_CONFIG` 在 `:135`)。
- 解析失败 → `packages/api/main.go:437-442` 记录日志并 `return 1`(启动失败)。但**配置为空不是失败**:`packages/api/main.go:443-445` 只打一条 Warn(`ADMIN_AUTH_PROVIDER_CONFIG is not configured; admin JWT requests will return 401`)然后继续。
- 注册点在 `packages/api/main.go:182`,位于 `:176-186` 的 authenticator 切片里(2026.30 共 **6** 个;2026.29 共 6 个,在 `:191-196`,其中 `NewAccessTokenAuthenticator` 已被 `NewAdminJWTAuthenticator` 取代)。
- ⚠️ `NewAdminJWTAuthenticator`(`internal/middleware/middleware.go:263`)**没有对 verifier 做 nil 检查**。安全性来自 `JWKSVerifier.Verify` 对 nil receiver 的处理(`internal/token/jwks_verifier.go:58`):

  ```go
  if v == nil || len(v.verifiers) == 0 {
      return nil, errors.New("service token verifier is not configured")
  }
  ```

- 验证通过后,注入 gin context 的是 **issuer 字符串**而非 userID:`setContextFunc: authcontext.SetServiceIssuer`(`internal/middleware/middleware.go:282`),通过 `auth.GetServiceIssuer(c)`(`packages/auth/pkg/auth/gin.go:31`)读取。失败时的客户端消息固定为 `Invalid service token.`(`internal/middleware/middleware.go:273`、`:283`)。
- ⚠️ `jwksClockSkew = 30 * time.Second`(`internal/token/jwks_verifier.go:18`)通过 `jwks.WithParserOptions(jwt.WithLeeway(jwksClockSkew))`(`:44`)生效,**只作用于 Admin 的 `JWKSVerifier`,不作用于用户 JWT 的 `OIDCVerifier`**。

### 7.4（2026.30 变动）空 `audiences` 从「非法」变成「合法」

`688657215` "feat(auth): allow issuers without configured audiences"(2026-09-02)改变了配置校验:

```go
// internal/token/jwks/audience.go:30-37  validateAudienceMatchPolicy
if len(audiences) == 0 {
    if policy != "" {
        return errors.New("audienceMatchPolicy must be empty when audiences are not configured")
    }
    return nil
}
```

- 2026.30:空 `audiences` 是**合法配置**,并且真的跳过 `aud` 校验。
- 2026.29(`packages/auth/pkg/auth/oidc/audience.go:31-33`):空 `audiences` 直接报 `audiences must contain at least one entry`——**因此 2026.29 代码里「空 audiences ⇒ 不校验 aud」那条分支是死代码,永远走不到**。这是读旧代码时最容易看错的地方。
- `MatchAll` 至今仍被拒绝,只接受 `MatchAny` 或空(`audience.go:18-22`)。

---

## 八、gin context 中的 userID / teamInfo

`gin.go` 提供 6 个核心函数:

| 函数 | 用途 |
|---|---|
| `GetUserID(c) (uuid.UUID, bool)` | handler 读取(可失败) |
| `MustGetUserID(c) uuid.UUID` | handler 读取(失败 panic) |
| `MustGetTeamID(c) uuid.UUID` | 直接取 team UUID |
| `MustGetTeamInfo(c) *types.Team` | team 版本(失败 panic) |
| `GetTeamInfo(c) (*types.Team, bool)` | team 版本(可失败) |
| `GetServiceIssuer(c) (string, bool)` | **2026.30 新增**,读取 service JWT 的 issuer |

> **2026.30 变动**:public 的 `packages/auth/pkg/auth/gin.go` 现在只有 **33 行**,全部是**转发函数**(转发给 `internal/authcontext`)。写入用的 `setUserID` / `setTeamInfo` 已**不再从 public 包导出**——测试里用 `SetUserIDForTest` / `SetTeamInfoForTest`(`packages/auth/pkg/auth/testing.go:14`、`:21`),生产代码里 middleware 直接调 `authcontext.SetUserID` / `authcontext.SetTeamInfo`。⚠️ 不要再用 `auth.setUserID` 这个私有名字(2026.29 的 `gin.go:15`),它在 2026.30 不存在于该文件。

### 8.1 注入路径

| Middleware | 2026.30 行号 | 注入字段 |
|---|---|---|
| `NewApiKeyAuthenticator` | `internal/middleware/middleware.go:221` | `teamInfo`(因为 API key 直接绑定 team) |
| ⛔ `NewAccessTokenAuthenticator` | ⛔ 已删除 | (2026.29 注入 `userID`) |
| `NewAuthProviderBearerAuthenticator` | `internal/middleware/middleware.go:236` | `userID` |
| `NewAuthProviderTeamAuthenticator` | `internal/middleware/middleware.go:250` | `teamInfo`(配合 `X-Team-ID` 头) |
| `NewAdminJWTAuthenticator`(2026.30 新增) | `internal/middleware/middleware.go:263` | `serviceIssuer`(字符串) |
| `NewAdminApiKeyAuthenticator` | `internal/middleware/middleware.go:288` | **不注入任何东西** ⚠️ 它的 `commonAuthenticator[struct{}]`(`:292-301`)没设 `setContextFunc`,只做 `X-Admin-Token` 的常量时间比对 |
| `NewAdminTeamAuthenticator` | `internal/middleware/middleware.go:304` | `teamInfo` |

其余工厂:`NewAuthenticator[T]` 在 `internal/middleware/middleware.go:206`(**2026.30 新增**,供本包未命名的 scheme 使用),`CreateAuthenticationFunc` 在 `:324`。

上面各工厂在 2026.29 `packages/auth/pkg/auth/middleware.go` 中的行号依次为 `:133`(ApiKey)、`:147`(AccessToken,⛔ 已删)、`:162`(AuthProviderBearer)、`:176`(AuthProviderTeam)、—(AdminJWT 不存在)、`:189`(AdminApiKey)、`:205`(AdminTeam);`CreateAuthenticationFunc` 在 `:225`。

### 8.2 context key 常量

```go
// packages/auth/pkg/auth/internal/authcontext/context.go:10-14
const (
    teamContextKey          = "team"
    userIDContextKey        = "user_id"
    serviceIssuerContextKey = "service_issuer"
)
```

(2026.29 在 `packages/auth/pkg/auth/gin.go:10-13`,只有前两个 key;`serviceIssuerContextKey` 是 2026.30 新增。)

直接用字符串。简单但需要约定——所有 handler 都通过 `auth.GetUserID` / `auth.GetTeamInfo` 读取,不能直接用 `c.Get("user_id")`(虽然技术上可以)。

### 8.3（2026.30 变动）security 失败状态的覆盖保护

`internal/middleware/middleware.go:73` 新增了一个 context key:

```go
const authFailureStatusContextKey = "e2b.auth.middleware.failure_status"
```

它的作用是:当多个 security alternative 都被尝试时,避免后来的 authenticator 把已经写下的 401 覆盖掉。

```go
// internal/middleware/middleware.go:106-111
if _, hasAuthenticationFailure := ginCtx.Get(authFailureStatusContextKey); !hasAuthenticationFailure {
    ginCtx.Status(http.StatusUnauthorized)
    ginCtx.Set(authFailureStatusContextKey, struct{}{})
}
```

⚠️ **保护是不完整的**:它只覆盖「header 缺失/格式错误」这条分支。校验失败分支(`internal/middleware/middleware.go:128-129`)仍然**无条件**写入:

```go
ginCtx.Status(validationError.Code)
ginCtx.Set(authFailureStatusContextKey, struct{}{})
```

所以一个后执行的 403(例如 team 被 ban)仍可能覆盖前面写下的 401。读到这条时要清楚它**不是**一个完整的优先级仲裁机制。

相关提交:`62e67d48f`(引入该 key)、`84362fc62`(2026-08-24,为格式错误的 API key 引入独立的 401 消息 `malformedError`——见 `internal/middleware/middleware.go:55` 字段与 `:42` 的 `ErrMalformedAPIKey`)。

---

## 九、关键流程时序图

### 9.1 完整 CLI 登录(`e2b auth login` → JWT 换取 access token + API key)(⛔ 2026.29 历史)

> ⛔ 下面这张图第 1–2 步和第 3 步的 `Bearer sk_e2b_...` 在 2026.30 均已失效。实际链路见 §9.3。

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

### 9.3（2026.30 变动）CLI 登录的实际链路

```
CLI              API                      Auth DB            Auth Provider
  │                │                          │                    │
  │ 1. GET /teams  │                          │                    │
  │    Bearer <JWT>(来自 OIDC)                │                    │
  │───────────────>│                          │                    │
  │                │ ValidateAuthProviderToken│                    │
  │                │   ↓                      │                    │
  │                │ LinkedOIDCVerifier.Verify│                    │
  │                │   ↓ (iss, sub) lookup    │                    │
  │                │ GetUserIdentity──────────>│  (identity_lookup) │
  │                │ <──────────── userID      │                    │
  │                │ authcontext.SetUserID    │                    │
  │                │                          │                    │
  │                │ GetTeamsWithUsersTeams───>│                    │
  │                │ <─────────── rows         │                    │
  │                │ (per team) CreateAPIKey──>│ (签发新 API key)   │
  │                │ <──────────── apiKey      │                    │
  │ 2. 200 + [{TeamID, Name, ApiKey: e2b_...}]│                    │
  │<───────────────│                          │                    │
  │                │                          │                    │
  │ 3. 写入 ~/.e2b/.env                        │                    │
  │    E2B_API_KEY=e2b_...                    │                    │
  │                                          │                    │
  │ 4. 后续 SDK 调用(§9.2 的 API key 路径)  │                    │
```

与 9.1 的差别:**只有 `GET /teams` 一步**,没有 `POST /access-tokens`,没有 `sk_e2b_`。`E2B_ACCESS_TOKEN` 这个环境变量不再被 API 接受。

### 9.4（2026.30 新增）服务间调用(Admin JWT)

`AdminJWTAuth` 只在 `spec/openapi.yml` 里与 `AdminTeamAuth`(`X-Team-ID`)**成对**出现(48 处,全部是 AND 组),所以:

```
服务 A               API
  │                   │
  │ GET /teams/{teamID}/metrics
  │ Authorization: Bearer <service-jwt>     ← AdminJWTAuth
  │ X-Team-ID: <team-uuid>                  ← AdminTeamAuth(必需!)
  │──────────────────>│
  │                   │ NewAdminJWTAuth... → JWKSVerifier.Verify(issuer JWKS, 不做 discovery)
  │                   │   → authcontext.SetServiceIssuer(c, issuer)
  │                   │ NewAdminTeamAuthenticator → GetTeamFromAdminToken(apiStore)
  │                   │   → authcontext.SetTeamInfo(c, team)
  │ 200 + metrics     │
  │<──────────────────│
```

⚠️ 只带 `Authorization` 而不带 `X-Team-ID` 会失败——这两个 scheme 是 AND 关系,不是 OR。这与 `ApiKeyAuth` 那种「一个头就够」的模式完全不同。

---

## 十、Feature Flag 与废弃路径

> ⛔ **2026.30 整节已失效。** 本节描述的两个 flag 都已从代码中删除,`packages/shared/pkg/featureflags/flags.go` 中不再有任何 `disable-e2b-access-token-*`。`POST /access-tokens` 现在是**无条件** 410,与 LaunchDarkly 无关。以下内容保留作为 2026.29 的历史记录。

### 10.1 `DisableE2BAccessTokenProvisioningFlag`(⛔ 2026.29 历史)

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

### 10.2 为什么不直接删除端点?(⛔ 2026.29 历史)

API 的兼容性承诺:已发布的端点不能直接 410。**先标 deprecated → 用 flag 灰度禁用 → 长期监控使用率 → 最终下线** 是标准做法。`POST /access-tokens` 在 2026.29 处于「灰度禁用」阶段。

> **2026.30 结局**:这条迁移路径走完了。端点被**真正删除**,但仍然注册了一个显式的 410 handler(见 §4.4)以给出清晰的迁移提示——所以对旧客户端而言"不能直接 410"的兼容性承诺依然被遵守。

### 10.3 其他相关 flag

CLI 登录链路没有其他 feature flag。`GetTeams` 与 `CreateAPIKey` 是无条件执行的——只要用户能通过 JWT 验证,就能拿到 API key。

### 10.4（2026.30 变动）被删除的两个 flag

| flag | 2026.29 位置 | 2026.30 |
|---|---|---|
| `disable-e2b-access-token-provisioning` | `packages/shared/pkg/featureflags/flags.go:226` | ⛔ 删除 |
| `disable-e2b-access-token-auth` | `packages/shared/pkg/featureflags/flags.go:234` | ⛔ 删除 |

⚠️ 第二个 flag(`disable-e2b-access-token-auth`)在 2026.29 里其实有**两个**消费点:`packages/api/internal/handlers/store.go:407`(在 `GetUserFromAccessToken` 里)和 `packages/docker-reverse-proxy/internal/handlers/token.go:55`。`packages/docker-reverse-proxy/` 整个目录在 2026.30 也已退役。

---

## 十一、配置

### 11.1 环境变量

| 变量 | 作用 |
|---|---|
| `AUTH_PROVIDER_CONFIG` | JSON,描述 OIDC 颁发者(详见 `packages/auth/pkg/auth/internal/token/provider_config_parse.go:14-26`;2026.29 为 `packages/auth/pkg/auth/provider_config_parse.go:13-25`)。空字符串或字面值 `"null"` 都视为未配置。定义在 `packages/api/internal/cfg/model.go:135`(2026.29 为 `:105`) |
| `ADMIN_AUTH_PROVIDER_CONFIG` | **2026.30 新增**。同样的 JSON 结构,用于 `AdminJWTAuth`(服务 JWT)。定义在 `packages/api/internal/cfg/model.go:136` |
| `AUTH_DB_CONNECTION_STRING` | auth DB 连接串(JWT → userID 查询走这里)。定义在 `packages/api/internal/cfg/model.go:107`(2026.29 为 `:84`) |
| `LAUNCHDARKLY_SDK_KEY` | LaunchDarkly(2026.29 用于 `DisableE2BAccessTokenProvisioningFlag` 灰度;⛔ 该 flag 已删除) |

> ⚠️ **原文有个错误,现已修正**:auth DB 的环境变量是 **`AUTH_DB_CONNECTION_STRING`**,不是 `AUTH_DB_POSTGRES_CONNECTION_STRING`(后者从来不存在)。`POSTGRES_CONNECTION_STRING` 是**主 API DB** 的连接串;只有当 `AUTH_DB_CONNECTION_STRING` 为空时,`packages/api/internal/cfg/model.go:287-288` 才会把它回退用作 auth DB 的 DSN。

`ParseProviderConfig` 的错误消息在 2026.30 也改了:`fmt.Errorf("parse AUTH_PROVIDER_CONFIG: %w", err)`(2026.29)→ `fmt.Errorf("parse auth provider config: %w", err)`(2026.30,`provider_config_parse.go:22`)。因为它现在同时服务 `AUTH_PROVIDER_CONFIG` 和 `ADMIN_AUTH_PROVIDER_CONFIG`,不能再把变量名写死在消息里。

### 11.2 头部常量(`packages/auth/pkg/auth/consts.go`,2026.30 共 13 行)

| 常量 | 行号(2026.30) | 值 |
|---|---|---|
| `HeaderAPIKey` | `:5` | `"X-API-Key"` |
| `HeaderAuthorization` | `:6` | `"Authorization"` |
| `HeaderTeamID` | `:7` | `"X-Team-ID"` |
| `HeaderAdminToken` | `:8` | `"X-Admin-Token"` |
| `PrefixAPIKey` | `:11` | `"e2b_"` |
| ⛔ `PrefixAccessToken` | ⛔ 已删除 | (2026.29 为 `"sk_e2b_"`,在 `:12`) |
| `PrefixBearer` | `:12`(2026.29 为 `:13`) | `"Bearer "` |

> ⚠️ 2026.29 的 `consts.go` 是 14 行,2026.30 是 13 行——少的那一行正是 `PrefixAccessToken`。同时注意 `HeaderTeamID` 的**值是 `X-Team-ID`(大写 ID)**,虽然 `internal/middleware/middleware.go:249` 的注释里写成了 `X-Team-Id`(小写 d),以常量值为准。

### 11.3 Identity 缓存 TTL

`identityCacheTTL = 1 * time.Minute`(`packages/auth/pkg/auth/internal/service/identity_lookup.go:20`;2026.29 路径为 `packages/auth/pkg/auth/identity_lookup.go:20`,行号相同)——硬编码,不可配。缓存是**进程内内存**(`cache.NewMemoryCache`,`packages/auth/pkg/auth/internal/service/identity_lookup.go:67`),**不是 Redis**,所以多副本部署时各副本各自缓存。

### 11.4（2026.30 变动）auth DB 客户端的读写分离被移除

2026.29 的 `packages/db/pkg/auth/client.go` 有独立的读/写句柄:

```go
type Client struct {
    Read      *authqueries.Queries
    Write     *authqueries.Queries
    writeConn *pgxpool.Pool
    readConn  *pgxpool.Pool
}
func NewClient(ctx context.Context, databaseURL, replicaURL string, options ...pool.Option) (*Client, error)
```

2026.30 收敛为单一句柄,并新增事务辅助:

```go
// packages/db/pkg/auth/client.go:16-20
type Client struct {
    *authqueries.Queries
    conn *pgxpool.Pool
}
// :22
func NewClient(ctx context.Context, databaseURL string, options ...pool.Option) (*Client, error)
// :38
func (db *Client) WithTx(ctx context.Context) (*authqueries.Queries, pgx.Tx, error)
```

影响:

- 所有调用点从 `authDB.Read.X()` / `authDB.Write.X()` 改为 `authDB.X()`(例如 `teams.go:19`、`apikeys.go:30`)。
- 环境变量 **`AUTH_DB_READ_REPLICA_CONNECTION_STRING` 被删除**:api 侧在 2026.29 `packages/api/internal/cfg/model.go:85`,dashboard-api 侧在 2026.29 `packages/dashboard-api/internal/cfg/model.go:21`。
- 构造点:`packages/api/internal/handlers/store.go:238-240`(2026.29 为 `:99-101`)、`packages/dashboard-api/main.go:137-139`。dashboard-api 里 `sharedauth.NewJWKSVerifier(ctx, config.AdminAuthProvider, authClient)` 在 `packages/dashboard-api/main.go:251`。

> ⚠️ `packages/db/pkg/auth/sql_queries/user_identities/` 与 `sql_queries/teams/get_team.sql` 在两个 tag 之间**逐字节未变**——所以 identity lookup 的 SQL 行为没有变化,变的只是连接管理。

### 11.5（2026.30 新增）错误体里的 `error_code`

`packages/shared/pkg/apierrors/apierrors.go:32-44` 的 `SendAPIError` 现在会在 `APIError.ErrorCode` 非空时(`:18` 的字段)往 JSON body 里加一个 `error_code` 字段:

```go
body := gin.H{"code": int32(apiErr.Code), "message": apiErr.ClientMsg}
if apiErr.ErrorCode != "" {
    body["error_code"] = apiErr.ErrorCode
}
```

- 取值集合是**开放**的;`packages/api/internal/api/api.gen.go:417` 列出的初始值是 `sandbox_capacity_unavailable`、`sandbox_placement_timeout`、`sandbox_no_compatible_node`、`sandbox_create_failed`、`internal_server_error`。
- ⚠️ **auth 模块自己从不设置 `ErrorCode`**。所以本文附录 B 里所有 401/403/410 的响应体**只有 `code` 和 `message`,没有 `error_code`**。排查时不要去找它。
- 2026.29 的 `SendAPIStoreError` 是内联实现的(`apierrors.go:23-28`),body 里只有 `code`/`message`,没有 `error_code` 这个概念。

---

## 十二、关键代码文件索引

| 文件 | 主要导出 | 说明 |
|---|---|---|
| `packages/api/internal/handlers/teams.go` | `GetTeams` | `GET /teams` + 自动签发 API key(2026.30 唯一入口) |
| ⛔ `packages/api/internal/handlers/accesstoken.go` | ⛔ 已删除 | 2026.29 的 Access token CRUD |
| `packages/api/internal/handlers/auth.go` | `GetTeam`、`findTeam`、`getUserTeams`、`resolveTemplateAndTeam` | 共享辅助函数 |
| `packages/api/internal/team/apikeys.go` | `CreateAPIKey`(`:22`)、`DeleteAPIKey`(`:52`)、`CreateAPIKeyResponse` | API key 生成 helper |
| `packages/api/main.go` | `NewGinServer`(`:101`)、410 handler(`:166-173`)、authenticator 注册(`:176-186`) | 端点与认证接线 |
| `packages/auth/pkg/auth/middleware.go` | `NewApiKeyAuthenticator`、`NewAuthProviderBearerAuthenticator`、`NewAuthProviderTeamAuthenticator`、`NewAdminJWTAuthenticator`、`NewAdminApiKeyAuthenticator`、`NewAdminTeamAuthenticator`、`CreateAuthenticationFunc`(共 58 行,全部转发) | authenticator 工厂的 public 转发层 |
| `packages/auth/pkg/auth/internal/middleware/middleware.go` | 同上各工厂的真实实现(`:206`、`:221`、`:236`、`:250`、`:263`、`:288`、`:304`、`:324`) | 347 行 |
| `packages/auth/pkg/auth/service.go` | `Service`(类型别名)、`NewAuthService`(25 行) | 转发层 |
| `packages/auth/pkg/auth/internal/service/service.go` | `ValidateAPIKey`、`ValidateAuthProviderToken`、`ValidateAuthProviderTeam` | 315 行;⛔ `ValidateAccessToken` 已删 |
| `packages/auth/pkg/auth/gin.go` | `GetUserID`、`MustGetUserID`、`MustGetTeamInfo`、`MustGetTeamID`、`GetTeamInfo`、`GetServiceIssuer`(33 行,全部转发) | gin context 读取 helper |
| `packages/auth/pkg/auth/internal/authcontext/context.go` | `SetUserID`(`:16`)、`GetUserID`(`:20`)、`SetTeamInfo`(`:33`)、`GetTeamInfo`(`:50`)、`SetServiceIssuer`(`:71`)、`GetServiceIssuer`(`:75`) | 77 行 |
| `packages/auth/pkg/auth/consts.go` | `HeaderAPIKey`、`PrefixAPIKey` 等(13 行) | 头部与前缀常量;⛔ `PrefixAccessToken` 已删 |
| `packages/auth/pkg/auth/token.go` | `ProviderConfig`、`JWKSVerifier`、`OIDCVerifier`、`LinkedOIDCVerifier`、`ParseProviderConfig`、`NewJWKSVerifier`、`NewOIDCVerifier`、`NewLinkedOIDCVerifier`、`NewOIDCIssuerVerifier`(99 行) | **2026.30 新增**的统一转发层(2026.29 的 `verifier.go` 已不存在) |
| `packages/auth/pkg/auth/internal/token/provider.go` | `ProviderConfig`(`:17`)、`OIDCVerifier`(`:59`)、`LinkedOIDCVerifier`(`:69`)、`NewOIDCVerifier`(`:78`)、`NewLinkedOIDCVerifier`(`:84`) | 209 行 |
| `packages/auth/pkg/auth/internal/token/jwks_verifier.go` | `JWKSVerifier`(`:26`)、`NewJWKSVerifier`(`:35`)、`Verify`(`:57`)、`jwksClockSkew`(`:18`) | 75 行;**2026.30 新增** |
| `packages/auth/pkg/auth/internal/token/jwks/verifier.go` | `NewVerifier`(`:52`)、`NewVerifierFromIssuerJWKS`(`:79`)、`httpTimeout`(`:22`) | 345 行 |
| `packages/auth/pkg/auth/internal/token/jwks/audience.go` | `AudienceMatchAny`(`:21`)、`validateAudienceMatchPolicy`(`:30`) | 108 行 |
| `packages/auth/pkg/auth/internal/token/oidc/oidc.go` | `IdentityLookup`、`Verifier`、`NewVerifier`、`TokenIdentity` | 147 行 |
| `packages/auth/pkg/auth/internal/service/identity_lookup.go` | `authIdentityLookup`、`cachingIdentityLookup`、`identityCacheTTL`(`:20`) | 84 行;`(iss, sub) → userID` 查询 + 缓存 |
| `packages/auth/pkg/auth/internal/token/provider_config_parse.go` | `ParseProviderConfig`(`:14`) | 26 行;解析 `AUTH_PROVIDER_CONFIG` / `ADMIN_AUTH_PROVIDER_CONFIG` |
| `packages/auth/pkg/auth/security.go` | `SecurityErrPrefix`(`:13`)、`ForbiddenErrPrefix`(`:14`)、`BlockedErrPrefix`(`:15`)、`ProcessSecurityErrors`(`:24`) | 52 行;**2026.30 新增** |
| `packages/shared/pkg/keys` | `GenerateKey`、`ApiKeyPrefix`(`constants.go:3`) | 凭证生成;⛔ `AccessTokenPrefix` 已删 |
| `packages/shared/pkg/apierrors/apierrors.go` | `SendAPIStoreError`(`:26`)、`SendAPIError`(`:32`)、`APIError.ErrorCode`(`:18`) | 统一错误响应 |
| ⛔ `packages/shared/pkg/featureflags/flags.go` | ⛔ `DisableE2BAccessTokenProvisioningFlag`(`:226`)、`DisableE2BAccessTokenAuthFlag`(`:234`)已删 | 2026.29 的弃用 flag |
| ⛔ `packages/auth/pkg/tests/sign_token.go` | ⛔ 整个目录已删除 | 2026.29 的 `SignTestToken`,零引用 |
| `spec/openapi.yml` | `/teams`(行 2351,security 在 2356-2357)、`AdminJWTAuth` scheme(行 31) | OpenAPI 规范;⛔ `/access-tokens`(2026.29 行 3651)、`/access-tokens/{accessTokenID}`(2026.29 行 3679)、`AccessTokenAuth`(2026.29 行 15)、`410` response 组件均已删除 |

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
Authenticator interface(internal/middleware/middleware.go:58-62;2026.29 为 middleware.go:34-37)
        ↓
commonAuthenticator[T] 泛型实现(internal/middleware/middleware.go:64-71;2026.29 为 :40-46)
        ↓
validationFunc 注入(由 `APIStore` 上的方法提供,定义在 `handlers/store.go`,
                    如 `GetTeamFromAPIKey` / `GetUserIDFromAuthProviderToken` / `GetTeamFromAdminToken`,
                    内部委托给 `authService.Validate*`)
        ↓
setContextFunc 注入 gin context(internal/middleware/middleware.go:141-143;2026.29 为 :106-108)
```

**为什么用泛型**?不同凭证的 validation 返回类型不同(API key → `*types.Team`,auth provider JWT → `uuid.UUID`,service JWT → `string`)。泛型让类型在编译期就一致,避免 `interface{}` + type assert 的运行时开销。

⛔ 2026.29 的 `GetUserFromAccessToken` 已从 `APIStore` 删除(它曾在 `handlers/store.go:396`)。

### 13.3 Identity 缓存只缓存命中

`packages/auth/pkg/auth/internal/service/identity_lookup.go:59-69`(2026.29 为 `identity_lookup.go:59-69`,行号相同)的 `cachingIdentityLookup` 只缓存成功结果。原因:**新用户登录不能延迟**。如果缓存"用户不存在",刚注册的用户要等 TTL(1 分钟)过期才能登录——这是糟糕的体验。

代价:对未注册用户的查询会绕过缓存,可能被滥用做 DoS。但 OIDC JWT 验证本身就有签名校验,所以攻击者必须先有合法 JWT——门槛够高。

### 13.4 `GetTeam` 标 deprecated 但不能删

`auth.go:36-37` 的注释:

> // Deprecated: use API Token authentication instead.

设计意图是:**新代码用 API key,不需要 GetTeam 的"从 userID 反查 team"逻辑**。但 JWT 路径还需要它。这是一个 **逐步迁移** 的例子——鼓励新代码用 API key,但旧路径继续支持。

> **2026.30 变动**:这一节在 2026.30 更成立了——`GetTeam` 的"非 API key"分支现在**只剩 auth provider JWT 一条路径**(access token 已删除)。所以 `auth.go:42-75` 里那个 `auth.GetUserID(c)` 分支的输入集合缩小了,但代码本身未改。

### 13.5 弃用路径用 LD flag 而非版本号(⛔ 2026.29 历史)

`POST /access-tokens` 的弃用用 `DisableE2BAccessTokenProvisioningFlag`(按 user 维度)而非 API 版本(v2)。原因:
- 弃用是 **行为变化**,不是接口变化——v2 通常用于 schema 改变
- 按 user 灰度可以让一部分用户先迁移,观察问题
- 版本号会让 SDK 同时维护两个端点,成本高

> **2026.30 结局**:这条策略走完了全流程——flag 阶段结束后端点被真正删除。但**兼容性承诺仍被遵守**:删除时保留了显式的 410 handler(§4.4),而不是让路径静默变成 404。这是"先 flag 灰度、再删除"这一策略的完整闭环。

### 13.6（2026.30 新增）错误优先级的集中仲裁

2026.30 把"多个 security scheme 都失败时,该给客户端看哪一条错误"的逻辑从 `packages/api/internal/utils/error.go` 抽到了 `packages/auth/pkg/auth/security.go`:

```go
// packages/auth/pkg/auth/security.go:24-51
func ProcessSecurityErrors(e *openapi3filter.SecurityRequirementsError) error {
    // 1) 先扫一遍:forbidden / blocked 的 team 判定无条件胜出(不论它在第几个)
    // 2) 否则选第一个「调用方真正尝试过」的 scheme 的错误(跳过 ErrNoAuthHeader)
    // 3) 一个都没尝试 → 取第一个 group 的错误
}
```

调用点在 `packages/api/internal/utils/error.go:133`(`MultiErrorHandler` 的 `*openapi3filter.SecurityRequirementsError` 分支)。

- 三个前缀常量:`SecurityErrPrefix`(`packages/auth/pkg/auth/security.go:13`)、`ForbiddenErrPrefix`(`:14`)、`BlockedErrPrefix`(`:15`)。`packages/api/internal/utils/error.go:98` 用 `SecurityErrPrefix` 做 `strings.CutPrefix` 来决定响应状态码。
- ⚠️ **forbidden / blocked 的 team 状态不是 2026.30 的新东西**——2026.29 的 `processCustomErrors`(`packages/api/internal/utils/error.go:120-147`)已有相同意图。变的是**代码位置**(移入 auth 包,可被其他服务复用)和**判定顺序**:
  - 2026.29:在同一个循环里边跳过 `ErrNoAuthHeader` 边检查 forbidden/blocked,遇到第一个非跳过错误就 `break`。因此一个**排在后面的** forbidden 错误其实赢不了。
  - 2026.30:forbidden/blocked 是**独立的完整预扫描**(`security.go:30-40`),不论位置都能胜出;之后才做「第一个真正尝试过的 scheme」选择。
  - 另一个小改进:2026.29 在 `e.Errors` 为空时会 `unwrapped[0]` panic;2026.30 显式返回错误(`security.go:26-28`)。
- ⚠️ 错误消息会被拼上前缀再返回给客户端,所以响应里的 `message` 形如 `error in openapi3filter.SecurityRequirementsError: security requirements failed: ...`,而不是原始的 `Invalid API key...`。排查时要剥掉前缀。

---

## 十四、常见问题与排查

### Q1:`e2b auth login` 之后,API key 列表里有几十个 "CLI login/configure"

每次 `e2b auth login` 都会调 `GET /teams`,而 `GET /teams` **无条件** 创建新 API key。频繁登录会累积。**处理**:
- 在 dashboard 上批量删除旧 key
- 或调 `DELETE /api-keys/{apiKeyID}`
- 长期方案:CLI 应该缓存第一次拿到的 key,后续登录复用

### Q2:`POST /access-tokens` 返回 410 Gone

**2026.30 起这是必然结果,不再是灰度**。端点和 handler 都已删除,`packages/api/main.go:172-173` 注册了无条件的 410。响应消息是:

```
E2B_ACCESS_TOKEN is deprecated and no longer supported. Use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation
```

**处理**:改用 API key(`E2B_API_KEY`,前缀 `e2b_`)或用户 JWT。⛔ 2026.29 那个「LD flag 按 user 灰度」的解释已作废——不要再让用户去找 `disable-e2b-access-token-provisioning`。

> ⚠️ 注意 2026.29 与 2026.30 的 410 消息**措辞不同**:旧的是 `Creating new access tokens is disabled. E2B_ACCESS_TOKEN is deprecated; ...`(中间是分号),新的是 `E2B_ACCESS_TOKEN is deprecated and no longer supported. ...`。按消息内容可以判断客户端打到的是哪个版本。

### Q3:`Invalid auth provider token.` 错误

JWT 验证失败。常见原因:
- JWT 过期(检查 `exp` claim)
- `AUTH_PROVIDER_CONFIG` 没配或配错
- 用户的 auth provider issuer 没在 config 里(检查 `iss` claim)
- auth DB 里没有该用户的 identity 行(`(iss, sub)` 不匹配)
- **2026.30 新增可能**:issuer 配了 `audiences` 但 token 的 `aud` 不匹配(见 §7.4);或反过来,配置里 `audiences` 为空——这现在是合法的,会**跳过** `aud` 校验

**排查**:看 trace 中的 `auth.scheme` 和 `auth.reason` 事件,会给出具体原因。

> ⚠️ 如果客户端拿到的是 `Invalid service token.` 而不是 `Invalid auth provider token.`,那是 **`AdminJWTAuth`** 路径的失败(`internal/middleware/middleware.go:273`、`:283`),和用户 JWT 是两条独立的链路。

### Q4:`Default team not found`

用户调 `GetTeam` 时没指定 teamID,且没有任何 team 标记为 `IsDefault`。**处理**:
- 客户端显式指定 `teamID`
- 或在 dashboard 上把某个 team 设为 default

### Q5:`You don't have access to any teams`

用户的 account 没有关联任何 team。**处理**:接受邀请或创建 team。这是 `getUserTeams` 返回空数组时抛的(`auth.go:119-125`,行号与 2026.29 相同)。

### Q6:`X-Team-ID` 头的作用?

当用 JWT 调需要 team 上下文的端点时,`X-Team-ID` 头告诉 API "我要操作哪个 team"。比如 `/sandboxes`(POST 创建)如果用 JWT 调用,必须带 `X-Team-ID`。`NewAuthProviderTeamAuthenticator`(`internal/middleware/middleware.go:250-260`;2026.29 为 `middleware.go:176-186`)负责验证。

2026.30 新增的 `AdminJWTAuth` 也依赖它:OpenAPI 里 `AdminJWTAuth` **总是**与 `AdminTeamAuth`(`X-Team-ID`)成对出现(48 处,全部是 AND 组),所以服务间调用必须同时带 `Authorization: Bearer <service-jwt>` **和** `X-Team-ID`。见 §9.4。

> ⚠️ 走 `AdminJWTAuth` 时 `X-Team-ID` 必须是合法 UUID:`GetTeamFromAdminToken`(`packages/api/internal/handlers/store.go:552`)在 `:556` 直接 `uuid.Parse(teamID)`,失败返回 **400 `Invalid team ID`**。而 `AuthProviderTeamAuth` 路径(`ValidateAuthProviderTeam`,`internal/service/service.go:188`)不解析 UUID,直接把字符串用于 cache key 与 DB 查询——所以两条路径对同一个头的校验强度不同。

### Q7:`GET /teams` 调用之后,有些 team 没返回 `ApiKey`

这不应该发生——代码对每个 team 都调 `CreateAPIKey`。如果某个 team 失败,**整个请求返回 500**(`teams.go:31-36`),不会有部分成功。如果客户端看到部分响应,可能是网络中断后的截断。

### Q8:多个 OIDC 颁发者怎么配?

`AUTH_PROVIDER_CONFIG` 是 JSON,`jwt` 字段是数组(2026.30 在 `packages/auth/pkg/auth/internal/token/provider.go:18`;2026.29 在 `verifier.go:17`)。

> ⚠️ **原文的 JSON 示例是错的,现已修正**:`issuer` 不是字符串而是**对象**,而且从来没有 `jwks_url` 这个字段。真实结构(2026.29 与 2026.30 一致,定义在 `internal/token/jwks/config.go:22-33`;2026.29 为 `oidc/config.go`):

```json
{
  "jwt": [
    {
      "issuer": {
        "url": "https://auth0.example/",
        "discoveryURL": "",
        "audiences": [],
        "audienceMatchPolicy": ""
      },
      "cacheDuration": "5m"
    },
    {
      "issuer": { "url": "https://okta.example/" },
      "cacheDuration": "5m"
    }
  ]
}
```

字段含义:

| 字段 | JSON key | 说明 |
|---|---|---|
| `Issuer.URL` | `url` | issuer URL。必须通过 `validateHTTPSURL` / `validateIssuerURL` 校验(loopback 例外) |
| `Issuer.DiscoveryURL` | `discoveryURL` | 可选。留空时按 `defaultDiscoveryPath`(`/.well-known/openid-configuration`)推导。**`NewVerifierFromIssuerJWKS` 会强制清空它**(`internal/token/jwks/verifier.go:80`),改用 `defaultJWKSPath = "/.well-known/jwks.json"`(`jwks/config.go:18`,拼接逻辑在 `verifier.go:86`) |
| `Issuer.Audiences` | `audiences` | 2026.30 起**可以为空**(见 §7.4) |
| `Issuer.AudienceMatchPolicy` | `audienceMatchPolicy` | 只接受 `"MatchAny"` 或空 |
| `Config.CacheDuration` | `cacheDuration` | Go duration 字符串,默认 `5m`(`jwks/config.go:14`)。自定义 `UnmarshalJSON` 负责解析(`config.go:36-59`) |

`LinkedOIDCVerifier.Verify`(`packages/auth/pkg/auth/internal/token/provider.go:182`)按顺序尝试每个 strategy,返回第一个成功的。

> **2026.30 变动**:`jwt` 字段的声明从 `verifier.go:17` 移到 `packages/auth/pkg/auth/internal/token/provider.go:18`(`JWT []jwks.Config \`json:"jwt"\``),`Verify` 方法从 `verifier.go:98` 移到 `provider.go:182`。JSON 结构本身**未变**,`AUTH_PROVIDER_CONFIG` 与 `ADMIN_AUTH_PROVIDER_CONFIG` 共用这个结构。⚠️ 配置示例里的字段名请以 `jwks.Config` / `jwks.Issuer` 的 struct tag 为准(`internal/token/jwks/config.go:22-33`),没有 `jwks_url` 这种字段。

### Q9:为什么 `identityCacheTTL = 1 * time.Minute`?

硬编码,不可配。设计权衡:
- 太长:新用户注册后要等才能登录
- 太短:缓存几乎无效,每次 JWT 验证都打 DB
- 1 分钟是经验值——足够让 burst 请求共享缓存,又不至于让新用户等待

> ⚠️ 缓存是**进程内内存**,不是 Redis。多副本部署时每个副本各自缓存 1 分钟,所以「删除 identity 后立即生效」是不保证的。

### Q10:CLI 自动签发的 API key 会过期吗?

不会。`CreateTeamAPIKeyParams` 定义于 `packages/db/pkg/auth/queries/create_team_api_key.sql.go:40-49`,无 expiration 字段;`team/apikeys.go:30-39`(2026.29 为 `:29-38`)是该类型的构造调用,**不设置 expiration**。**这些 key 是持久的**,直到用户删除。这是另一个为什么 Q1 会累积的原因。

### Q11（2026.30 新增）客户端拿到 `You are not authenticated`

`GetTeam` 的兜底分支(`auth.go:77-81`)。意思是 gin context 里**既没有 `teamInfo` 也没有 `userID`**——通常是 security scheme 校验通过但 `setContextFunc` 没跑,或者请求落到了一个只靠 `GetTeam` 恢复上下文的路径上。⚠️ 它**不是** 401 的通用文案:API key 无效时看到的是 `Invalid API key, ...`。

### Q12（2026.30 新增）服务 JWT 报 `Invalid service token.`

`AdminJWTAuth` 路径失败(`internal/middleware/middleware.go:273`、`:283`)。排查顺序:
1. `ADMIN_AUTH_PROVIDER_CONFIG` 配了吗?没配时启动日志里只有一条 Warn(`packages/api/main.go:444`),所有 admin JWT 请求都会 401。
2. `X-Team-ID` 带了吗?`AdminJWTAuth` 与 `AdminTeamAuth` 是 AND 关系,缺一不可(§9.4)。
3. 时间偏差:service token 很短命,`JWKSVerifier` 有 30 秒 leeway(`jwksClockSkew`),超出即拒。
4. `iss` 是否在配置的 issuer 列表里——`JWKSVerifier` **不做 OIDC discovery**,只按 issuer 的常规 JWKS 路径取 key,不会去交叉验证 discovery 文档里声明的 issuer。

---

## 十五、2026.30 变动速览

### 15.1 一句话总结

`sk_e2b_` access token 被整体删除;`packages/auth` 的实现全部移入 `internal/**`(public 层变成转发层);新增服务间认证 `AdminJWTAuth` / `ADMIN_AUTH_PROVIDER_CONFIG`;auth DB 客户端的读写分离被移除;空 `audiences` 变成合法配置。**CLI 侧唯一的实质影响是:登录后只拿 API key,不再有 access token。**

### 15.2 ⛔ 删除清单(access token)

| 被删对象 | 2026.29 位置 |
|---|---|
| `AccessTokenAuth` security scheme | `spec/openapi.yml:15`(13 处引用) |
| `/access-tokens`、`/access-tokens/{accessTokenID}` | `spec/openapi.yml:3651`、`:3679`;`410` response 组件与 `access-tokens` tag 一并删除 |
| `NewAccessToken`、`CreatedAccessToken` schema | `spec/openapi.yml` |
| `packages/api/internal/handlers/accesstoken.go` + `_test.go` | — |
| `APIStore.GetUserFromAccessToken` | `packages/api/internal/handlers/store.go:396` |
| `authService.ValidateAccessToken` | `packages/auth/pkg/auth/service.go:140`(接口成员在 `:34`) |
| `NewAccessTokenAuthenticator` | `packages/auth/pkg/auth/middleware.go:147` |
| `auth.PrefixAccessToken = "sk_e2b_"` | `packages/auth/pkg/auth/consts.go:12` |
| `keys.AccessTokenPrefix = "sk_e2b_"` | `packages/shared/pkg/keys/constants.go:5` |
| `packages/db/pkg/auth/sql_queries/access_token/`(3 个文件) | `create_access_token.sql`、`delete_access_token.sql`、`get_user_id_from_access_token.sql` |
| 生成的 sqlc 代码 | `packages/db/pkg/auth/queries/{create_access_token,delete_access_token,get_user_id_from_access_token}.sql.go`;`models.go` 里的 `AccessToken` struct(-17 行) |
| `public.access_tokens` 表、`public.generate_access_token()` 函数 | 迁移 `packages/db/migrations/20260823120000_drop_access_tokens.sql`(`-- +goose Down` 段会重建两者) |
| `disable-e2b-access-token-provisioning`、`disable-e2b-access-token-auth` | `packages/shared/pkg/featureflags/flags.go:226`、`:234` |
| `AUTH_DB_READ_REPLICA_CONNECTION_STRING` | api `cfg/model.go:85`、dashboard-api `cfg/model.go:21` |
| `packages/auth/pkg/tests/sign_token.go`(`SignTestToken`) | ⚠️ 整个 `packages/auth/pkg/tests/` 目录删除,**零引用**。如果本地测试脚本还在 import 它,会编译失败 |
| `iac/`(172 文件 → 0)、根 `self-host.md` | 提交 `8a1c48884406b909f64c1239c808d0bc1cbf05bf`(Tomas Virgl, 2026-09-09)。⚠️ `packages/nomad-nodepool-apm/`(10 文件 → 12)**仍然存在**,不要一并当作已删除 |
| `packages/docker-reverse-proxy/`(19 → 0) | ⚠️ **另一个提交**:`d153bbe9d1e2ccd5e087d7c1dece5b8974175b54`(Jakub Rojko, 2026-08-06, `chore(docker-reverse-proxy): remove deprecated service`)。比 `iac/` 退役早一个月 |

### 15.3 ✅ 新增清单

| 新增对象 | 位置 |
|---|---|
| `AdminJWTAuth` security scheme(`type: http` / `scheme: bearer` / `bearerFormat: JWT`) | `spec/openapi.yml:31`;在 `security:` 中总是与 `AdminTeamAuth` 成对(48 处 AND 组) |
| `ADMIN_AUTH_PROVIDER_CONFIG` | `packages/api/internal/cfg/model.go:136` |
| `NewAdminJWTAuthenticator` | `internal/middleware/middleware.go:263`;public 转发在 `packages/auth/pkg/auth/middleware.go:44` |
| `NewJWKSVerifier` / `JWKSVerifier` | `internal/token/jwks_verifier.go:35` / `:26` |
| `NewVerifierFromIssuerJWKS`(不做 discovery) | `internal/token/jwks/verifier.go:79` |
| `OIDCVerifier` / `LinkedOIDCVerifier` 拆分 | `internal/token/provider.go:59-61` / `:69-73` |
| `internal/authcontext` 包 + `serviceIssuerContextKey` | `internal/authcontext/context.go:10-14` |
| `authcontext.SetServiceIssuer` / `GetServiceIssuer` | `internal/authcontext/context.go:71` / `:75`;public 的 `GetServiceIssuer` 在 `packages/auth/pkg/auth/gin.go:31` |
| `packages/auth/pkg/auth/security.go`(`ProcessSecurityErrors`) | 提交 `c09b59246` |
| `authFailureStatusContextKey` | `internal/middleware/middleware.go:73`,守卫在 `:108-111` |
| `ErrMalformedAPIKey` / `malformedError` | `internal/middleware/middleware.go:42` / `:55`(提交 `84362fc62`,2026-08-24) |
| `WithTx`(auth DB 事务) | `packages/db/pkg/auth/client.go:38` |
| `error_code` 错误体字段 | `packages/shared/pkg/apierrors/apierrors.go:18`、`:39-41` |
| `packages/api/main.go` 的 410 handler | `:166-173` |
| 空 `audiences` 合法化 | 提交 `688657215`(2026-09-02);`internal/token/jwks/audience.go:30-37` |

### 15.4 ⚠️ 最容易搞错的五件事

1. **`AdminJWTAuth` 不能单独使用**——必须同时带 `X-Team-ID`(AND 关系),这与 `ApiKeyAuth` 的「一个头就够」完全不同。
2. **`GET /teams` 不接受任何 admin/service 凭证**,只接受 `AuthProviderBearerAuth`(`spec/openapi.yml:2356-2357`)。
3. **auth DB 的 env 是 `AUTH_DB_CONNECTION_STRING`**,不是 `AUTH_DB_POSTGRES_CONNECTION_STRING`(原文写错了)。
4. **`jwksClockSkew` 的 30 秒 leeway 只作用于 Admin 的 `JWKSVerifier`**,用户 JWT 的 `OIDCVerifier` 没有。
5. **`Invalid Access token.` 是 `X-Admin-Token` 失败的消息**,与已删除的 access token 无关(§附录 B)。

### 15.5 对 CLI 读者的净影响

| 2026.29 的 CLI 行为 | 2026.30 |
|---|---|
| `e2b auth login` → `POST /access-tokens` 拿 `sk_e2b_...` | ⛔ 410 Gone |
| 把 `E2B_ACCESS_TOKEN` 写进 `~/.e2b/.env` | ⛔ API 不再接受该凭证 |
| `GET /teams` → 自动签发 per-team API key | ✅ 不变 |
| 用 `E2B_API_KEY` 调 SDK | ✅ 不变 |
| 用用户 JWT 调 API(短期) | ✅ 不变,仍是 `AuthProviderBearerAuth` |

⚠️ **无法核实**:CLI 自身的仓库不在本仓库内,所以「CLI 是否已经停止请求 `POST /access-tokens`」「CLI 是否仍会读 `~/.e2b/.env` 里的 `E2B_ACCESS_TOKEN`」这两点我无法从代码验证,只能从 API 侧断言该端点已返回 410。

---

## 附录 A:凭证类型速查表

| 维度 | API key | ⛔ Access token | Auth provider JWT | 服务 JWT(2026.30 新增) |
|---|---|---|---|---|
| 头部 | `X-API-Key` | `Authorization: Bearer` | `Authorization: Bearer` | `Authorization: Bearer` + `X-Team-ID`(AND) |
| 前缀 | `e2b_` | `sk_e2b_` | (无) | (无) |
| 绑定 | team | user | user | 服务(issuer) |
| 注入 context | `teamInfo` | `userID` | `userID` | `serviceIssuer`(`string`) |
| 生命周期 | 持久(到删除,代码无 expiration) | — | 短期(由 auth provider `exp` 决定) | 短期(leeway 30s) |
| 创建入口 | `POST /api-keys` / `GET /teams` | ⛔ `POST /access-tokens` 已删(410) | 外部 auth provider | 外部服务 |
| 典型场景 | SDK / 服务账号 | ⛔ 已退役 | CLI 登录瞬间 | 服务间调用 |
| Security scheme | `ApiKeyAuth` | ⛔ `AccessTokenAuth`(已删) | `AuthProviderBearerAuth` | `AdminJWTAuth` |
| 配置 env | — | — | `AUTH_PROVIDER_CONFIG` | `ADMIN_AUTH_PROVIDER_CONFIG` |

---

## 附录 B:错误码与 HTTP 状态映射

| HTTP | 触发场景 | 典型消息(2026.30) |
|---|---|---|
| 401 | 用户 JWT 无效/过期 | `Invalid auth provider token.` |
| 401 | API key 无效 | `Invalid API key, please visit https://docs.e2b.dev/api-key for more information.` |
| 401 | API key 格式错误(前缀不对) | `API key is malformed: expected the "e2b_" prefix, visit https://docs.e2b.dev/api-key for more information` |
| 401 | 服务 JWT 无效 | `Invalid service token.` |
| 401 | `X-Admin-Token` 无效 | `Invalid Access token.`(⚠️ 遗留文案,见下) |
| 401 | 未认证(无任何凭证) | `You are not authenticated` |
| 403 | team access 检查失败(banned/blocked) | `team forbidden: ...` / `team blocked: ...`(见下) |
| 403 | 用户不属于任何 team | `You don't have access to any teams` |
| 403 | 跨 team 访问 | `You are not allowed to access this team` |
| 410 | 调 `POST /access-tokens` / `DELETE /access-tokens/{id}` | `E2B_ACCESS_TOKEN is deprecated and no longer supported. Use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation` |
| 400 | `X-Team-ID` 不是合法 UUID(Admin 路径) | `Invalid team ID` |
| 500 | DB 写入失败(API key 创建) | `Error when creating team API key` |
| 500 | `Default team not found` | `Default team not found` |

⚠️ **本附录的三点注意事项**:

1. **auth 模块从不设置 `ErrorCode`**,所以以上所有响应体只有 `{"code": N, "message": "..."}`,**没有 `error_code` 字段**(见 §11.5)。
2. 所有经过 OpenAPI security 校验失败的消息都会**被前缀包裹**,最终形如 `error in openapi3filter.SecurityRequirementsError: security requirements failed: Invalid API key, ...`(`SecurityErrPrefix` 在 `packages/auth/pkg/auth/security.go:13`,拼接在 `security.go:51`)。forbidden/blocked 的前缀分别是 `team forbidden: ` / `team blocked: `(`security.go:14-15`)。
3. ⚠️ **`Invalid Access token.` 是遗留文案**:它现在是 **`AdminApiKeyAuth`(`X-Admin-Token` 头)校验失败**的消息(`internal/middleware/middleware.go:159`、`:299`),和已删除的 `sk_e2b_` access token 毫无关系。2026.29 里这个字符串同样存在(在 `middleware.go:124`、`:200`)。看到它不要以为是 access token 还在生效。

⛔ **已从本附录删除的两行(2026.29 的写法,且当时就是错的)**:

| 2026.29 原文 | 问题 |
|---|---|
| 401 · access token 无效 · ``Invalid Access token, try to login again by running `e2b auth login`.`` | 这条消息**从来不是** access token 校验失败的消息。2026.29 的 `ValidateAccessToken`(`packages/auth/pkg/auth/service.go:140`)实际返回的是 `Invalid access token format` 或 `Cannot get the user for the given access token`。原文引用的那句 `Invalid Access token, try to login again by running \`e2b auth login\`.` 是 2026.29 `middleware.go:157` 上 `NewAccessTokenAuthenticator` 的 `errorMessage`,它只在 **header 缺失/格式错误**时作为包装文案出现,不是「access token 无效」的语义。 |
| 410 · access token 创建被 flag 关闭 · `Creating new access tokens is disabled. ...` | 2026.30 已改为无条件 410,消息也变了(见上表)。 |

> 另注:API key 的文档 URL 在 2026.30 从 `https://e2b.dev/docs/api-key`(2026.29 `middleware.go:142`)改成了 `https://docs.e2b.dev/api-key`(2026.30 `internal/middleware/middleware.go:231`)。按消息里的域名也能判断版本。

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
| ⛔ **Access token** | E2B 自管的较长期凭证(`sk_e2b_`),绑定 user。**2026.30 已整体删除** |
| **Service JWT** | 2026.30 新增。服务间凭证,走 `AdminJWTAuth`,必须配合 `X-Team-ID` |
| **Default team** | 用户标记为默认的 team,`GetTeam` 在未指定 teamID 时使用 |
| **Identity lookup** | `(iss, sub) → userID` 的查询,JWT 验证的关键步骤 |
| **Singleflight** | 同 key 并发查询合并为一次底层调用的模式(`cachingIdentityLookup` 用到) |
| **Mask** | 凭证的可识别但不可反推的部分(如 `e2b_***abc`),用于 UI 展示。⛔ 原文举的 `sk_e2b_***abc` 例子已随 access token 删除 |
| **JWKS** | JSON Web Key Set。`JWKSVerifier` 只按 issuer 的 `/.well-known/jwks.json` 取 key,不做 OIDC discovery |
| **internal 转发层** | 2026.30 起 `packages/auth/pkg/auth/*.go` 只做类型别名与函数转发,实现全在 `pkg/auth/internal/**` |

---

> 文档版本:已同步至 **2026.30**(tag `2026.30`,提交 `f32ee8a2a50052f32e3632ceb451111a98dd5104`,翻译于 2026-09-20)。本文所有 `file:line` 均以 tag `2026.30` 为准;凡与 2026.29 不同处,写作「行 N(2026.30;2026.29 为 M)」。2026.30 的变动清单见 [十五、2026.30 变动速览](#十五202630-变动速览)。
>
> ⚠️ 本文涉及 `packages/auth/pkg/auth/**` 的路径在 2026.30 已大量迁移到 `packages/auth/pkg/auth/internal/**`(public 层只剩转发)。引用旧路径前请先对照 §十五。
