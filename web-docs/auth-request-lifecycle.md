# Auth 请求生命周期:从一个 HTTP 请求抵达 handler 那一刻说起

> 本文是一份**以"请求生命周期"为线索的深度剖析**,跟随一个 HTTP 请求从 TCP 接入、穿过 Gin 中间件、被 oapi-codegen 分发、经 `commonAuthenticator` 提取 header、调用 `authService.Validate*`、走双层缓存、读写分离、状态裁决,最终把 `*types.Team` 或 `uuid.UUID` 注入 gin context 的全过程。
>>
> 已有的 4 篇 auth 文档各有定位:
>>
> - [`auth-module.md`](./auth-module.md) — 子系统**总览**(概念、组件清单、配置项)
> - [`cli-auth-flow.md`](./cli-auth-flow.md) — CLI 登录的**用户视角流程**(凭证签发与切换)
> - [`api-keys-module.md`](./api-keys-module.md) — API Key 的 **CRUD 与生命周期**
> - [`access-tokens-module.md`](./access-tokens-module.md) — Access Token 的 **CRUD 与废弃路径**
>
> 本文的差异化视角:**工程师视角的请求生命周期**。不介绍概念,而是直接展示"请求穿过每一层时实际发生了什么"——每一层都附真实代码切片 + 行号 + 不变量 + 设计动机。读完本文,你应该能在脑中清晰画出任意 auth 请求的执行序列,并预测任何代码改动的影响面。

## 目录

- [一、为什么需要"请求生命周期"视角](#一为什么需要请求生命周期视角)
- [二、全景图:9 层 pipeline](#二全景图9-层-pipeline)
- [三、第 0 层:服务启动与装配](#三第-0-层服务启动与装配)
- [四、第 1 层:Gin 路由 + oapi-codegen 中间件](#四第-1-层gin-路由--oapi-codegen-中间件)
- [五、第 2 层:SecurityScheme 分发](#五第-2-层securityscheme-分发)
- [六、第 3 层:Header 提取与规范化](#六第-3-层header-提取与规范化)
- [七、第 4 层:凭证验证(4 条路径)](#七第-4-层凭证验证4-条路径)
- [八、第 5 层:缓存层(双层)](#八第-5-层缓存层双层)
- [九、第 6 层:Store 与读写分离](#九第-6-层store-与读写分离)
- [十、第 7 层:Team 状态裁决](#十第-7-层team-状态裁决)
- [十一、第 8 层:Gin Context 注入](#十一第-8-层gin-context-注入)
- [十二、第 9 层:Handler 读取身份](#十二第-9-层handler-读取身份)
- [十三、状态码 stamp:为什么是 401 而不是 400](#十三状态码-stamp为什么是-401-而不是-400)
- [十四、并发模型与降级路径](#十四并发模型与降级路径)
- [十五、可观测性:trace、attribute、event](#十五可观测性traceattributeevent)
- [十六、不变量与威胁模型](#十六不变量与威胁模型)
- [十七、端到端实战:3 个真实请求跟踪](#十七端到端实战3-个真实请求跟踪)
- [十八、写新 handler 时的反模式与陷阱](#十八写新-handler-时的反模式与陷阱)
- [附录:关键代码路径速查](#附录关键代码路径速查)

---

## 一、为什么需要"请求生命周期"视角

`auth` 子系统的总览文档已经把组件铺开讲了一遍。但当你真正面对这些问题时,总览不够用:

- "用户报告 `POST /sandboxes` 返 401,但 header 看起来没问题——是哪一层把它拒了?"
- "我给 team 加了 `is_blocked = TRUE`,多久生效?如果有人正在用 cached API key 调用呢?"
- "OIDC issuer 切换的零停服迁移中,旧 token 和新 token 的执行路径在哪里分叉?"
- "Redis 故障时,API Key 验证是降级到 DB 还是直接 5xx?"
- "为什么有时候看到 401 是 `Invalid API key format`,有时候是 `Cannot get the team for the given API key`?这两种失败差在哪一层?"

这些问题有一个共同点:**它们问的是"在请求生命周期中的哪一步"**。一旦你能把请求画成一条 pipeline,答案就自然浮现。

本文的核心交付物是一张 9 层 pipeline 图,以及每一层的代码切片、不变量、失败行为、并发模型。读完之后,上面 5 个问题你应该都能直接回答。

---

## 二、全景图:9 层 pipeline

```
   HTTP 请求抵达
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 0. 服务启动装配                                           │
│    packages/api/main.go:189                              │
│    NewAuthService(...) + CreateAuthenticationFunc(...)    │
└───────────────────────────────────────────────────────────┘
        │ (启动时一次性装配,运行期常驻)
        ▼
┌───────────────────────────────────────────────────────────┐
│ 1. Gin 路由 + oapi-codegen 中间件                          │
│    spec/openapi.yml 的 security 声明 → 中间件链            │
│    middleware.OapiRequestValidatorWithOptions             │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 2. SecurityScheme 分发                                    │
│    middleware.go:225 CreateAuthenticationFunc             │
│    按 input.SecuritySchemeName 找匹配的 Authenticator      │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 3. Header 提取与规范化                                    │
│    middleware.go:49 getHeaderKeysFromRequest             │
│    4 分支:缺失/前缀不符/去 Bearer/直接返回                 │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 4. 凭证验证(4 条路径分叉)                                 │
│    service.go: ValidateAPIKey / ValidateAccessToken /     │
│    ValidateAuthProviderToken / ValidateAuthProviderTeam   │
└───────────────────────────────────────────────────────────┘
        │                       │
        ▼                       ▼
┌─────────────────────┐ ┌──────────────────────────────────┐
│ 5a. teamCache(Redis)│ │ 5b. identityCache(进程内)        │
│   TTL=5min+后台刷新  │ │   TTL=1min,只缓存成功            │
└─────────────────────┘ └──────────────────────────────────┘
        │                       │
        ▼                       ▼
┌───────────────────────────────────────────────────────────┐
│ 6. Store 层(authStoreImpl)                                │
│    auth_store.go                                          │
│    Read 走 replica / Write 走 primary                     │
│    CheckTeamBanned 在此层强制                             │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 7. Team 状态裁决(banned 在 store 内,blocked 在中间件)    │
│    team_state.go / team_middleware.go                     │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 8. Gin Context 注入                                      │
│    gin.go: setTeamInfo / setUserID                        │
│    key 是字符串 "team" / "user_id"                         │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 9. Handler 读取身份                                       │
│    MustGetTeamInfo(c) / MustGetUserID(c)                  │
│    handler 业务逻辑开始                                   │
└───────────────────────────────────────────────────────────┘
```

后面每一章展开一层。

---

## 三、第 0 层:服务启动装配

请求抵达之前,**第 0 层的工作**已经在服务启动时一次性完成:把 `authService`、`authenticators`、`oapi-codegen` 中间件串起来。运行期 pipeline 不再改动这些。

### 3.1 装配入口

`packages/api/main.go:189` 一段装配代码做了两件事:

```go
AuthenticationFunc := auth.CreateAuthenticationFunc(
    []auth.Authenticator{
        auth.NewApiKeyAuthenticator(apiStore.GetTeamFromAPIKey),
        auth.NewAccessTokenAuthenticator(apiStore.GetUserFromAccessToken),
        auth.NewAuthProviderBearerAuthenticator(apiStore.GetUserIDFromAuthProviderToken),
        auth.NewAuthProviderTeamAuthenticator(apiStore.GetTeamFromAuthProviderToken),
        auth.NewAdminApiKeyAuthenticator(config.AdminToken),
        auth.NewAdminTeamAuthenticator(apiStore.GetTeamFromAdminToken),
    },
    metricsMiddleware.SetProcessingStartTime, // preAuthHook
)
```

每个 `NewXxxAuthenticator` 工厂返回的都是同一个泛型结构 `commonAuthenticator[T]`,只是 `T` 不同:

| 工厂 | T | 验证函数(由 apiStore 提供) |
|------|---|----------------------------|
| `NewApiKeyAuthenticator` | `*types.Team` | `apiStore.GetTeamFromAPIKey` |
| `NewAccessTokenAuthenticator` | `uuid.UUID` | `apiStore.GetUserFromAccessToken` |
| `NewAuthProviderBearerAuthenticator` | `uuid.UUID` | `apiStore.GetUserIDFromAuthProviderToken` |
| `NewAuthProviderTeamAuthenticator` | `*types.Team` | `apiStore.GetTeamFromAuthProviderToken` |
| `NewAdminApiKeyAuthenticator` | `struct{}` | 内嵌的 `subtle.ConstantTimeCompare` |
| `NewAdminTeamAuthenticator` | `*types.Team` | `apiStore.GetTeamFromAdminToken` |

这 6 个 Authenticator 共享 `Authenticate` 方法,差异只在三个维度:`headerKey`(从哪个 header 读、用什么前缀校验)、`validationFunc`(怎么把 token 翻译成身份)、`setContextFunc`(把身份塞进 gin context 的哪个 key)。

### 3.2 `authService` 的内部装配

`apiStore.GetTeamFromAPIKey` 等函数只是 thin wrapper,内部都调到 `authService.Validate*`。`authService` 的结构(`packages/auth/pkg/auth/service.go:44`):

```go
type authService struct {
    store                authStore          // 包了 *authdb.Client
    teamCache            *authCache         // Redis 包装
    authProviderVerifier *Verifier          // 可能为 nil
}
```

`NewAuthService`(`service.go:58`)按 5 步装配:

```go
cache := newAuthCache(redisClient)              // 1. Redis cache
store := newAuthStore(authDB)                    // 2. DB store
identityLookup := newAuthIdentityLookup(authDB.Write) // 3. 身份查询(强制走 Write 池)
v, err := NewVerifier(ctx, providerConfig, httpClient, identityLookup) // 4. OIDC 验证器
return &authService{
    store:                store,                // 5. 组合
    teamCache:            cache,
    authProviderVerifier: v,
}, nil
```

第 3 步的注释(`service.go:77-79`)说明了一个关键不变量:

> OIDC bootstrap writes identity rows on the primary immediately before the next authenticated request; using the read replica here races replication lag.

—— OIDC 第一次登录时,`dashboard-api` 会立刻往 primary 写一行 `user_identities`,紧接着用同一个 JWT 调 api。如果走 read replica,replication lag 会让身份查询失败。所以**身份查询强制走 Write 池**。

### 3.3 第 0 层的不变量

| 不变量 | 守护机制 |
|--------|---------|
| `redisClient != nil` | `NewAuthService` 显式检查,空则报错(`service.go:65`) |
| `authDB != nil` | 同上(`service.go:68`) |
| `httpClient != nil` | 同上(`service.go:71`) |
| `authProviderVerifier == nil` 是合法状态 | 当 `AUTH_PROVIDER_CONFIG` 为空时,`NewVerifier` 返回 `(nil, nil)`(`verifier.go:64`),`ValidateAuthProviderToken` 会立刻返 401 |

最后一条是反直觉的:**"没有 OIDC 提供商"是合法配置,不是错误**。api 服务可以纯靠 API Key + Access Token + Admin Token 工作,完全不接 OIDC。这是 self-hosting 场景的一等公民支持。

### 3.4 dashboard-api 的精简装配

`packages/dashboard-api/main.go:191-243` 装配的是 **3 个 Authenticator** 而非 6 个:

```go
AuthenticationFunc := auth.CreateAuthenticationFunc(
    []auth.Authenticator{
        auth.NewAdminApiKeyAuthenticator(config.AdminToken),
        auth.NewAuthProviderBearerAuthenticator(dashboardStore.GetUserIDFromAuthProviderToken),
        auth.NewAuthProviderTeamAuthenticator(dashboardStore.GetTeamFromAuthProviderToken),
    },
    nil,
)
```

dashboard-api **不接受 API Key 或 Access Token**——因为它是面向人类用户的(通过浏览器 OIDC 登录)。这就是同一个 `auth` 包被不同服务复用的方式:装配时挑选需要的 Authenticator 即可。

---

## 四、第 1 层:Gin 路由 + oapi-codegen 中间件

请求进入运行期 pipeline。Gin 把请求派给匹配的路由 handler 之前,先跑一长串中间件。`oapi-codegen` 自动生成的中间件做两件事:

1. **schema 校验**:请求 body / query / path param 是否符合 OpenAPI spec。
2. **security 校验**:这个端点声明的 `security:` 字段,有没有被满足。

### 4.1 OpenAPI 的 security 声明

`spec/openapi.yml` 里 `/sandboxes` 的 POST 端点声明(简化):

```yaml
paths:
  /sandboxes:
    post:
      security:
        - ApiKeyAuth: []
        - AccessTokenAuth: []
        - AuthProviderBearerAuth: []
          AuthProviderTeamAuth: []
```

这是一个 **list of lists**。语义是:

- 外层是 OR:任一组满足即可。
- 内层是 AND:组内所有 scheme 都要满足。

所以上面的语义是:**"ApiKeyAuth 满足,或 AccessTokenAuth 满足,或 (AuthProviderBearerAuth 和 AuthProviderTeamAuth 同时满足)"**。

### 4.2 oapi-codegen 如何遍历

`oapi-codegen` 中间件会**按顺序**尝试每一组。每组里又**按顺序**调用每个 scheme 的 `AuthenticationFunc`(就是我们装配时返回的那个函数)。

- 任一组里**所有 scheme** 都通过 → 整体通过,跳过剩余组。
- 任一组里**任一 scheme** 失败 → 这一组失败,记录失败 code,继续尝试下一组。
- 所有组都失败 → 取所有失败 code 的 **max** 作为最终 HTTP 状态码。

最后一条是 `middleware.go:75-78` 注释的关键:

```go
// stamp 401 so the ErrorHandler's max(writer, 400) resolves to 401
// when every security group fails. without this, auth failures become 400s.
ginCtx.Status(http.StatusUnauthorized)
```

如果没有显式 `ginCtx.Status(401)`,默认状态是 200,但 schema 校验失败会把它降到 400。最终 `max(400, ...) = 400`,用户看到的就是 **400 Bad Request**——这会误导客户端以为是参数问题,实际是认证问题。所以**每次失败必须显式 stamp 401/403**,让 `max()` 拿到正确的 code。

### 4.3 第 1 层的不变量

| 不变量 | 说明 |
|--------|------|
| 一个端点可以有多个 security 组(OR 关系) | OpenAPI spec 决定 |
| 一组内可以有多个 scheme(AND 关系) | OpenAPI spec 决定 |
| 失败时取所有失败 code 的 max | oapi-codegen 的 ErrorHandler 实现 |
| 显式 stamp 状态码是 Authenticator 的责任 | 否则会被降级到 400 |

---

## 五、第 2 层:SecurityScheme 分发

oapi-codegen 调到我们注册的 `AuthenticationFunc` 时,会传一个 `*openapi3filter.AuthenticationInput`,里面有 `SecuritySchemeName`——就是 spec 里写的 `ApiKeyAuth` / `AccessTokenAuth` / 等等。

### 5.1 分发逻辑

`middleware.go:225` 的 `CreateAuthenticationFunc`:

```go
return func(ctx context.Context, input *openapi3filter.AuthenticationInput) error {
    ginCtx := middleware.GetGinContext(ctx)   // 1. 从 ctx 拿 ginCtx

    if preAuthHook != nil {
        preAuthHook(ginCtx)                   // 2. preAuthHook(api 服务用它打 timestamp)
    }

    ctx, span := tracer.Start(ginCtx.Request.Context(), "authenticate") // 3. 起 OTel span
    defer span.End()

    for _, validator := range authenticators { // 4. 线性查找匹配的 Authenticator
        if input.SecuritySchemeName == validator.SecuritySchemeName() {
            return validator.Authenticate(ctx, ginCtx, input)
        }
    }

    return fmt.Errorf("invalid security scheme name '%s'", input.SecuritySchemeName) // 5. 没找到 = 配置错误
}
```

注意第 4 步是**线性查找**——authenticators 列表只有 6 项,常数时间。但顺序仍影响可读性,所以装配时按"用户面凭证 → 内部凭证"的顺序排列。

### 5.2 配置错误的兜底

第 5 步是"spec 里写了一个没装配的 scheme"——这是 **服务端配置错误**,不是客户端错误。返回的 error 会被 oapi-codegen 直接抛给 Gin,error handler 通常会返 500。客户端无法通过修改请求来修复这个错误。

### 5.3 preAuthHook 的用途

api 服务的 preAuthHook 是 `metricsMiddleware.SetProcessingStartTime`——在 auth 之前打一个 timestamp,用于后续计算 "auth 耗时" 和 "总耗时"。这个 hook 必须在 auth 之前跑,因为 auth 本身的耗时也要算进 "处理时间"。

dashboard-api 不需要这个,所以传 `nil`。

---

## 六、第 3 层:Header 提取与规范化

匹配到 Authenticator 后,进入 `commonAuthenticator[T].Authenticate`(`middleware.go:67`)。第一步是从请求里把凭证字符串抠出来:

### 6.1 提取逻辑(全 4 个分支)

`middleware.go:49` 的 `getHeaderKeysFromRequest`:

```go
func (a *commonAuthenticator[T]) getHeaderKeysFromRequest(req *http.Request) (string, error) {
    key := req.Header.Get(a.header.name)         // 分支 1:header 缺失
    if key == "" {
        return "", ErrNoAuthHeader
    }

    if a.header.removePrefix != "" {              // 分支 2:去外层前缀(如 "Bearer ")
        key = strings.TrimSpace(strings.TrimPrefix(key, a.header.removePrefix))
    }

    if a.header.prefix != "" && !strings.HasPrefix(key, a.header.prefix) {
        return "", ErrInvalidAuthHeader           // 分支 3:前缀不符
    }

    return key, nil                               // 分支 4:成功
}
```

四个分支对应四种失败/成功状态:

| 分支 | 触发条件 | 返回 |
|------|---------|------|
| 1 | header 整个缺失 | `ErrNoAuthHeader` |
| 2 | header 存在但要去掉外层前缀(如 `Bearer `) | (无错,继续) |
| 3 | header 存在但前缀不符(如不是 `e2b_` 开头) | `ErrInvalidAuthHeader` |
| 4 | 一切正常 | `(key, nil)` |

### 6.2 每个 Authenticator 的 headerKey 配置

| Authenticator | header.name | header.prefix | header.removePrefix |
|--------------|-------------|---------------|---------------------|
| ApiKeyAuth | `X-API-Key` | `e2b_` | (空) |
| AccessTokenAuth | `Authorization` | `sk_e2b_` | `Bearer ` |
| AuthProviderBearerAuth | `Authorization` | (空) | `Bearer ` |
| AuthProviderTeamAuth | `X-Team-ID` | (空) | (空) |
| AdminApiKeyAuth | `X-Admin-Token` | (空) | (空) |
| AdminTeamAuth | `X-Team-ID` | (空) | (空) |

注意几个细节:

- **`AccessTokenAuth` 同时用了 prefix 和 removePrefix**:先把 `Bearer ` 去掉,再校验剩下的是不是 `sk_e2b_` 开头。所以一个有效的 access token header 长这样:`Authorization: Bearer sk_e2b_xxxx`。
- **`AuthProviderBearerAuth` 只用 removePrefix**:去掉 `Bearer ` 后,剩下的就是 JWT 本体,没有固定前缀(JWT 总是以 `eyJ` 开头,但代码不强制)。
- **`AuthProviderTeamAuth` 和 `AdminTeamAuth` 都用 `X-Team-ID`**:这俩 header 名一样,意味着同一个请求可能被分发到两条路径——具体走哪条,由 spec 里写的 scheme name 决定。

### 6.3 失败时的 telemetry

`middleware.go:67-80` 在 header 提取失败时,**不直接返回错误**,先做两件事:

```go
telemetry.ReportEvent(ctx, "auth scheme skipped",
    attribute.String("auth.scheme", a.schemeName),
    attribute.String("auth.reason", err.Error()),
)

ginCtx.Status(http.StatusUnauthorized)

return err
```

`telemetry.ReportEvent` 把"这个 scheme 被跳过了,原因是 X"记录到当前 trace span。这对调试极其有用——比如用户报告 401,你能在 trace 里直接看到"ApiKeyAuth skipped: authorization header is missing",立刻知道用户传错了 header 名。

`ginCtx.Status(401)` 是 §4.2 提到的状态码 stamp。

### 6.4 第 3 层的不变量

| 不变量 | 说明 |
|--------|------|
| Header 名大小写不敏感 | `req.Header.Get` 内部做了 canonical 化(`http.CanonicalHeaderKey`) |
| `removePrefix` 是 `strings.TrimPrefix`,不是必须存在 | 即便 header 没有 `Bearer ` 前缀,也不会报错,只是返回原值 |
| `prefix` 是**强校验** | 不匹配直接返 `ErrInvalidAuthHeader` |
| 成功时返回的 key **包含 prefix**(如 `e2b_xxxx`) | 后续 `keys.VerifyKey` 会再去 prefix |

---

## 七、第 4 层:凭证验证(4 条路径)

提取到 token 字符串后,调 `validationFunc`。每个 Authenticator 的 validationFunc 都是 `apiStore` 上的方法,内部统一委托给 `authService.Validate*`。这一层是 4 条分叉路径。

### 7.1 路径 A:`ValidateAPIKey`(API Key 验证)

`service.go:93`:

```go
func (s *authService) ValidateAPIKey(ctx, ginCtx, apiKey string) (*types.Team, *APIError) {
    hashedKey, err := keys.VerifyKey(keys.ApiKeyPrefix, apiKey)  // 1. 格式校验 + hash
    if err != nil {
        return nil, &APIError{Code: 401, ClientMsg: "Invalid API key format", ...}
    }

    result, err := s.teamCache.GetOrSet(ctx, hashedKey, func(ctx, key string) (*types.Team, error) {
        return s.store.GetTeamByHashedAPIKey(ctx, key)            // 2. 走 Redis 缓存
    })
    if err != nil {
        var forbiddenErr *TeamForbiddenError
        if errors.As(err, &forbiddenErr) {                       // 3. banned → 403
            return nil, &APIError{Code: 403, ...}
        }
        return nil, &APIError{Code: 401, ...}                     // 4. 其他 → 401
    }

    telemetry.SetAttributes(ginCtx.Request.Context(),
        telemetry.WithMaskedAPIKey(keys.MaskToken(keys.ApiKeyPrefix, apiKey)),
        telemetry.WithTeamID(result.TeamID()),
    )

    return result, nil
}
```

四步:格式校验 → 缓存查询 → 错误分类 → telemetry。

**关键设计**:DB 错误(非 banned)统一返 401,不是 500。理由:暴露 500 会泄露 DB 状态,401 让客户端以为是凭证问题更安全。代价是真正的 DB 故障会被误诊为"凭证问题",但 trace 里有完整错误,运维能看到真实原因。

### 7.2 路径 B:`ValidateAccessToken`(Access Token 验证)

`service.go:140`:

```go
func (s *authService) ValidateAccessToken(ctx, ginCtx, accessToken string) (uuid.UUID, *APIError) {
    hashedToken, err := keys.VerifyKey(keys.AccessTokenPrefix, accessToken)
    if err != nil {
        return uuid.UUID{}, &APIError{Code: 401, ClientMsg: "Invalid access token format", ...}
    }

    userID, err := s.store.GetUserIDByHashedAccessToken(ctx, hashedToken) // ← 不走缓存!
    if err != nil {
        return uuid.UUID{}, &APIError{Code: 401, ...}
    }
    // ...
    return userID, nil
}
```

跟路径 A 的关键差异:**完全不走缓存**。每次请求都打 DB。

为什么?详见 [`auth-module.md` 13.7](./auth-module.md#137-为什么-validateaccesstoken-不缓存)。简而言之:access token 失效要求高(用户 logout 要立刻生效),Redis 缓存的 5min TTL 太长。

代价:DB QPS 更高,但 access token 已在 deprecated 路径上,QPS 会自然下降。

### 7.3 路径 C:`ValidateAuthProviderToken`(OIDC JWT 验证)

`service.go:174`:

```go
func (s *authService) ValidateAuthProviderToken(ctx, ginCtx, token string) (uuid.UUID, *APIError) {
    if s.authProviderVerifier == nil {                            // 1. feature flag off
        return uuid.UUID{}, &APIError{
            Err:       errors.New("auth provider is not configured"),
            ClientMsg: "Backend authentication failed",           // ← 注意:不暴露细节
            Code:      http.StatusUnauthorized,
        }
    }

    return s.validateJWTWithProvider(ctx, ginCtx, s.authProviderVerifier, token, "auth provider")
}
```

注意第 1 步:即便 `authProviderVerifier == nil`(没配 OIDC),也返 **401** 而非 503/501。这是有意的——前端拿到 401 会引导用户重登,拿到 5xx 会无限重试。`ClientMsg` 也是统一的 "Backend authentication failed",不暴露"未配置"这个内部细节。

`validateJWTWithProvider`(`service.go:186`)的核心:

```go
userID, _, err := v.Verify(ctx, token)
if err != nil {
    return uuid.UUID{}, &APIError{Code: 401, ...}
}

if userID == uuid.Nil {                                          // 关键:验签通过 ≠ 认证通过
    return uuid.UUID{}, &APIError{
        Err: fmt.Errorf("%s token user claim is missing...", ...),
        Code: 401,
    }
}
```

`v.Verify` 内部做了 6 件事(详见 [`auth-module.md` 第五节](./auth-module.md#五oidc-jwt-验证深入)):

1. 用 JWKS 里的 RSA 公钥验 RS256 签名。
2. 校验 `exp` 必须存在(`WithExpirationRequired`)。
3. 校验 `iss` 等于配置值。
4. 校验 `aud` 与配置取交集。
5. 提取 `iss` / `sub`。
6. 查 `user_identities` 表把 `(iss, sub)` 翻译成内部 `user_id`。

第 6 步是关键:**JWT 验签通过 ≠ 认证通过**。`(iss, sub)` 必须在身份表里有对应行,才算认证成功。这意味着:

- 第一次登录的用户即便 token 有效也会被拒 → 上游 `dashboard-api` 必须先做 `upsert_public_identity` provision。
- 用户被 deactivate 后,直接删 `user_identities` 那行就够了——所有现有 token 立刻失效,即便它们还没到 exp。

### 7.4 路径 D:`ValidateAuthProviderTeam`(OIDC + team 组合)

dashboard-api 的常见流程是**两步认证**:

1. **第一步**(由 `AuthProviderBearerAuth` 触发):`Authorization: Bearer <jwt>` → 走路径 C → 拿到 `user_id`,塞进 ginCtx。
2. **第二步**(由 `AuthProviderTeamAuth` 触发):`X-Team-Id: <uuid>` → 走路径 D → 验证 user **真的属于** 这个 team。

路径 D 的代码(`service.go:213`):

```go
func (s *authService) ValidateAuthProviderTeam(ctx, ginCtx, teamID string) (*types.Team, *APIError) {
    userID, ok := GetUserID(ginCtx)                              // 1. 从 ginCtx 拿 userID
    if !ok {
        return nil, &APIError{Code: 500, ...}                    // ← 配置错误:第一步没跑
    }

    cacheKey := teamMemberCacheKey(userID, teamID)               // 2. 构造 cache key

    result, err := s.teamCache.GetOrSet(ctx, cacheKey, func(...) {
        return s.store.GetTeamByIDAndUserID(ctx, userID, teamID) // 3. (userID, teamID) join 查询
    })
    // ... 错误处理 ...
}
```

第 1 步:从 ginCtx 拿 `userID`。如果第一步(`AuthProviderBearerAuth`)没跑过,这里会失败,返 **500**(不是 401——因为这是配置错误,spec 不该让 `AuthProviderTeamAuth` 单独出现)。

第 3 步:DB 查询是 `GetTeamWithTierByTeamAndUser`,通过 `users_teams` 表 join 验证成员关系。

### 7.5 第 4 层的失败状态码矩阵

| 失败原因 | HTTP | 典型 ClientMsg |
|---------|------|---------------|
| API Key 格式错(前缀不符、非 hex) | 401 | `Invalid API key format` |
| API Key DB 查不到 | 401 | `Cannot get the team for the given API key` |
| API Key 对应 team banned | 403 | `team is banned` |
| Access Token 格式错 | 401 | `Invalid access token format` |
| Access Token DB 查不到 | 401 | `Cannot get the user for the given access token` |
| OIDC verifier 未配置 | 401 | `Backend authentication failed` |
| JWT 验签失败 / aud 不符 / 过期 | 401 | `Backend authentication failed` |
| JWT 有效但身份表无对应行 | 401 | `Backend authentication failed` |
| `AuthProviderTeamAuth` 单独出现(无前置 Bearer) | 500 | `Backend authentication failed` |
| Admin Token 不匹配 | 401 | `Invalid Access token.` |

---

## 八、第 5 层:缓存层(双层)

凭证验证里有两条缓存路径,设计上**故意不同构**。

### 8.1 第一层:Redis teamCache

`packages/auth/pkg/auth/cache.go`:

```go
const (
    authInfoExpiration   = 5 * time.Minute  // Redis TTL
    refreshInterval      = 1 * time.Minute  // 后台刷新间隔(超过这个 age 就触发刷新)
    refreshTimeout       = 30 * time.Second // 单次刷新超时
    authCacheRedisPrefix = "auth:team"      // Redis key 前缀
)
```

模式:**cache-aside + 后台异步刷新 + 分布式锁**。流程:

```
请求 ──▶ authCache.GetOrSet(key, cb)
         │
         ├─ Redis GET auth:team:<key>
         │   ├─ hit ──▶ 检查 age:
         │   │           ├─ age < 1min  ──▶ 直接返回(快路径,0 额外 IO)
         │   │           └─ age ≥ 1min  ──▶ 异步刷新(singleflight + 分布式锁)
         │   │                              ──▶ 同时返回旧值(不阻塞请求)
         │   └─ miss ──▶ 加锁 ──▶ cb() [DB 查询] ──▶ Redis SET
         │                                              └─ 释放锁
         └─
```

被 `ValidateAPIKey`、`ValidateAuthProviderTeam`、`GetTeamByID` 三处复用。**同一个 Redis cache** 跨所有 api pod 共享。

三个关键设计:

1. **跨 pod 共享**:同一个 team 被多个 api pod 请求时,只命中一个 pod 的 DB 查询,其他 pod 直接读 Redis。
2. **后台刷新不阻塞响应**:cache 过 1min 后,请求**立即返回旧数据**,同时 singleflight 在后台刷新——下次请求就能拿到新数据。
3. **分布式锁**:RedisLocker 防止 N 个 pod 同时 miss 缓存时打 N 次 DB。锁的 TTL = `RefreshTimeout + 2*RedisTimeout` 自动计算。

### 8.2 第二层:进程内 identityCache

`packages/auth/pkg/auth/identity_lookup.go:20`:

```go
const identityCacheTTL = 1 * time.Minute
```

OIDC 身份**不进 Redis**,只在本进程内存:

```go
type cachingIdentityLookup struct {
    delegate oidc.IdentityLookup
    cache    *cache.MemoryCache[uuid.UUID]
}

func (l *cachingIdentityLookup) GetUserIdentity(ctx, iss, sub string) (uuid.UUID, error) {
    return l.cache.GetOrSet(ctx, identityCacheKey(iss, sub), func(ctx, _ string) (uuid.UUID, error) {
        return l.delegate.GetUserIdentity(ctx, iss, sub)
    })
}
```

三个关键设计:

1. **只缓存成功结果**(`identity_lookup.go:18-19` 注释):
   > Newly provisioned users can sign in immediately and transient db errors don't get pinned.

   如果缓存错误结果,新创建的用户要等 1 分钟才能登录。所以只有"确认存在"的映射才缓存。

2. **singleflight**:`cache.MemoryCache` 内部用 `singleflight.Group` 把并发同 key 的 miss 合并成一次 DB 查询。

3. **key 用 NUL 字节分隔**(`identity_lookup.go:73`):
   ```go
   func identityCacheKey(iss, sub string) string {
       return iss + "\x00" + sub
   }
   ```
   NUL 字节确保无论 iss/sub 里有什么字符,key 都是 unambiguous 的——比如 `iss="a", sub="\x00b"` 和 `iss="a\x00", sub="b"` 是不同的身份。

### 8.3 双层对比

| 维度 | teamCache(Redis) | identityCache(进程内) |
|------|-------------------|----------------------|
| 数据大小 | 中(team + limits,几百字节) | 小(一个 uuid) |
| 共享范围 | 跨所有 api pod | 单 pod |
| TTL | 5min(后台 1min 刷新) | 1min |
| 失效方式 | `Invalidate`(主动) + TTL(被动) | 仅 TTL |
| 缓存 miss 时 | 走 DB | 走 DB |
| 缓存 hit 时 | 直接返回(0 IO) | 直接返回(0 IO) |
| 故障影响 | Redis 挂 → 所有 pod 同时回退到 DB | 单 pod 内存挂只影响本 pod |
| 是否缓存失败 | 否(避免 banned 状态被钉死) | 否(避免新用户登录被钉死) |
| 安全敏感度 | 低(配置数据) | 高(身份是否有效) |

### 8.4 为什么身份缓存故意不进 Redis

详见 [`auth-module.md` 13.1](./auth-module.md#131-为什么-team-缓存走-redis身份缓存不走)。简而言之:

- **故障隔离**:Redis 出问题时,JWT 验证还能靠 DB + JWKS 独立工作,降级路径更短。
- **爆炸半径**:内存缓存挂掉只影响一个 pod。
- **缓存值很小**(一个 uuid),内存占用可忽略,不值得引入 Redis 网络 round-trip。

---

## 九、第 6 层:Store 与读写分离

cache miss 时调到 `authStoreImpl`(`packages/auth/pkg/auth/auth_store.go`)。这一层是 DB 之上的薄封装,核心两件事:**读写分离** 和 **banned 强制检查**。

### 9.1 Client 的读写分离

`packages/db/pkg/auth/client.go`:

```go
type Client struct {
    Read      *authqueries.Queries  // 走 read replica 池
    Write     *authqueries.Queries  // 走 primary 池
    writeConn *pgxpool.Pool
    readConn  *pgxpool.Pool
}
```

`authStoreImpl` 里的所有"读"走 `s.authDB.Read.*`,而 `UpdateLastTimeUsed` 走 `s.authDB.Write.*`。

### 9.2 GetTeamByHashedAPIKey 的 4 步

`auth_store.go:29`:

```go
func (s *authStoreImpl) GetTeamByHashedAPIKey(ctx context.Context, hashedKey string) (*types.Team, error) {
    ctx, span := tracer.Start(ctx, "get team auth")
    defer span.End()

    result, err := s.authDB.Read.GetTeamWithTierByAPIKey(ctx, hashedKey)  // 1. Read 池查询
    if err != nil {
        return nil, fmt.Errorf("failed to get team from API key: %w", err)
    }

    if err := CheckTeamBanned(result.Team); err != nil {                 // 2. banned 检查
        return nil, err
    }

    go func() {                                                          // 3. 异步 UpdateLastTimeUsed
        ctx := context.WithoutCancel(ctx)
        updateErr := s.authDB.Write.UpdateLastTimeUsed(ctx, hashedKey)   //    Write 池
        if updateErr != nil {
            logger.L().Error(ctx, "failed to update last time used", zap.Error(updateErr))
        }
    }()

    team := types.NewTeam(&result.Team, &result.TeamLimit)               // 4. 组装 *types.Team

    return team, nil
}
```

四步:读 → banned 检查 → 异步写 → 组装。

第 3 步的 `context.WithoutCancel(ctx)` 是关键——`UpdateLastTimeUsed` 不影响响应,可以慢慢写。但默认的 `ctx` 会在请求结束时被 cancel,导致这次写入也被取消。`WithoutCancel` 拿到一个独立的、不会被请求生命周期影响的 context。

代价:服务关闭时可能丢失最近几秒的 update。但 `last_time_used` 不要求强一致,这个权衡是划算。

### 9.3 SQL:join 三张表

`packages/db/pkg/auth/sql_queries/teams/get_team.sql`:

```sql
-- name: GetTeamWithTierByAPIKey :one
SELECT sqlc.embed(t), sqlc.embed(tl)
FROM "public"."team_api_keys" tak
JOIN "public"."teams" t ON tak.team_id = t.id
JOIN "public"."team_limits" tl on tl.id = t.id
WHERE tak.team_id = t.id
  AND tak.api_key_hash = $1;
```

每次 API Key 验证都 join 三张表:`team_api_keys` ⨝ `teams` ⨝ `team_limits`。理由:**每次都把 limits 一起带回来**,handler 直接 `team.Limits.MaxVcpu` 拿到配额,避免再查一次 DB。

### 9.4 第 6 层的不变量

| 不变量 | 说明 |
|--------|------|
| 所有"读"操作走 `s.authDB.Read` | read replica 水平扩展 |
| `UpdateLastTimeUsed` 走 `s.authDB.Write`(异步) | 避免阻塞响应 |
| `CheckTeamBanned` 在 store 层强制 | 不依赖 handler 记得检查 |
| OIDC 身份查询走 `authDB.Write` | 跳过 replication lag,详见 §3.2 |

---

## 十、第 7 层:Team 状态裁决

E2B 有两种 team 状态:banned(永久封禁)和 blocked(临时封禁)。它们在不同层检查。

### 10.1 banned vs blocked 对比

| 维度 | banned | blocked |
|------|--------|---------|
| 字段 | `teams.is_banned` | `teams.is_blocked` + `teams.blocked_reason` |
| 错误类型 | `*TeamForbiddenError` | `*TeamBlockedError` |
| 检查位置 | store 层(`CheckTeamBanned`) | 中间件(`EnforceBlockedTeam`) |
| 检查时机 | 早(每次 store 查询) | 晚(auth 通过、handler 之前) |
| 是否有白名单 | 否 | 是(`BlockedTeamAllowlist`) |
| HTTP | 403 | 403 |
| 典型场景 | 永久封禁(欺诈、违规) | 临时封禁(欠费、额度耗尽) |

### 10.2 banned:在 store 层强制

`team_state.go:13`:

```go
func CheckTeamBanned(team authqueries.Team) error {
    if team.IsBanned {
        return &TeamForbiddenError{Message: "team is banned"}
    }
    return nil
}
```

`authStoreImpl` 的每个查询(`GetTeamByHashedAPIKey`、`GetTeamByID`、`GetTeamByIDAndUserID`)都调它。这意味着:**banned team 在 store 层就过不去**,任何调用 `ValidateAPIKey`、`GetTeamByID`、`ValidateAuthProviderTeam` 的入口都会拿到 `TeamForbiddenError`。

设计意图:**banned 是终态,不需要例外**——任何路径都不该让 banned team 通过。所以放在最深的、最不可避免的层。

### 10.3 blocked:在中间件层带白名单

`team_state.go:28`:

```go
func CheckTeamBlocked(team *types.Team) error {
    if team == nil || team.Team == nil || !team.IsBlocked {
        return nil                                                  // ← admin / access-token 路径没 team,noop
    }

    msg := "team is blocked"
    if team.BlockedReason != nil && *team.BlockedReason != "" {
        msg = fmt.Sprintf("%s: %s", msg, *team.BlockedReason)
    }
    return &TeamBlockedError{Message: msg}
}
```

注意它接 `*types.Team`(指针),允许 nil。这样 handler 可以无脑调用,不用先做 nil-check。

`EnforceBlockedTeam` 中间件(`team_middleware.go:59`):

```go
func EnforceBlockedTeam(allowlist BlockedTeamAllowlist) gin.HandlerFunc {
    return func(c *gin.Context) {
        team, ok := GetTeamInfo(c)
        if !ok || team == nil {
            c.Next()
            return
        }
        if err := CheckBlockedTeamForRoute(c, team, allowlist); err != nil {
            apierrors.SendAPIStoreError(c, http.StatusForbidden, err.Error())
            c.Abort()
            return
        }
        c.Next()
    }
}
```

为什么不在 store 层?因为 blocked **有白名单**——blocked team 能登录、能看自己的 team 列表、能缴费,只是不能新建 sandbox / build template。store 层不知道当前请求是哪个路由,做不到白名单。

### 10.4 BlockedTeamAllowlist

`team_middleware.go:14`:

```go
type BlockedTeamAllowlist map[string]map[string]struct{}
//                    key=HTTP method    key=gin route pattern(c.FullPath())
```

dashboard-api 的典型白名单(伪代码):

```go
blockedTeamAllowlist := auth.BlockedTeamAllowlist{
    http.MethodGet: {
        "/api/teams":          {}, // 看自己的 team 列表
        "/api/teams/{teamID}": {}, // 看 team 详情(才能看到 blocked_reason)
        "/api/billing":        {}, // 看账单(去缴费)
    },
    http.MethodPost: {
        "/api/teams/{teamID}/upgrade": {}, // 升级 tier
    },
}
```

设计意图:**blocked team 还能自助解封**(缴费、升级),不需要联系客服。

### 10.5 CheckTeamAccess:handler 主动检查

api 服务大多不用 `EnforceBlockedTeam` 中间件,而是**按需在 handler 里调** `CheckTeamAccess`(`team_middleware.go:45`):

```go
func CheckTeamAccess(c *gin.Context, team *types.Team, allowlist BlockedTeamAllowlist) error {
    if team == nil || team.Team == nil {
        return nil
    }
    if err := CheckTeamBanned(*team.Team); err != nil {
        return err
    }
    return CheckBlockedTeamForRoute(c, team, allowlist)
}
```

这是"我不开中间件,但在这个 handler 里要主动检查"的入口。典型用在创建 sandbox / build template 等关键资源操作的 handler。

---

## 十一、第 8 层:Gin Context 注入

凭证验证通过后,要把结果塞进 gin context,让 handler 能拿到。

### 11.1 注入函数

`packages/auth/pkg/auth/gin.go`:

```go
const (
    teamContextKey   = "team"
    userIDContextKey = "user_id"
)

func setUserID(c *gin.Context, userID uuid.UUID) {
    setInGinContext(c, userIDContextKey, userID)
}

func setTeamInfo(c *gin.Context, t *types.Team) {
    setInGinContext(c, teamContextKey, t)
}
```

直接用字符串作 key。简单但需要约定——所有 handler 都通过 `auth.GetUserID` / `auth.GetTeamInfo` 读取,不能直接 `c.Get("user_id")`(虽然技术上可以)。

### 11.2 谁调用 setter

`commonAuthenticator.Authenticate` 的最后一步(`middleware.go:106`):

```go
if a.setContextFunc != nil {
    a.setContextFunc(ginCtx, result)
}
```

`setContextFunc` 在每个 Authenticator 工厂里指定:

| Authenticator | setContextFunc |
|--------------|----------------|
| ApiKeyAuth | `setTeamInfo` |
| AccessTokenAuth | `setUserID` |
| AuthProviderBearerAuth | `setUserID` |
| AuthProviderTeamAuth | `setTeamInfo` |
| AdminApiKeyAuth | nil(无 setter) |
| AdminTeamAuth | `setTeamInfo` |

`AdminApiKeyAuth` 没有 setter——因为 admin token 不绑定具体身份,通过验证就够,setContextFunc 为 nil。`Authenticate` 里有 nil 检查,跳过 setter。

### 11.3 注入路径与凭证类型

| 凭证 | 注入字段 | handler 拿到 |
|------|---------|-------------|
| API Key | `team` | `*types.Team` |
| Access Token | `user_id` | `uuid.UUID` |
| OIDC JWT(单独) | `user_id` | `uuid.UUID` |
| OIDC JWT + X-Team-ID | `team`(覆盖) | `*types.Team` |
| Admin Token | (无) | (无) |
| Admin Token + X-Team-ID | `team` | `*types.Team` |

注意第 4 行:**OIDC JWT 流程会注入两次**——第一步 Bearer 验证注入 `user_id`,第二步 X-Team-ID 验证注入 `team`。最后 handler 拿到的是 team,但 user_id 也还在 context 里。

### 11.4 getter 的容错

`gin.go:19`:

```go
func GetUserID(c *gin.Context) (uuid.UUID, bool) {
    return getFromGinContextSafely[uuid.UUID](c, userIDContextKey)
}

func getFromGinContextSafely[T any](c *gin.Context, contextKey string) (T, bool) {
    var t T
    val, ok := c.Get(contextKey)
    if !ok {
        return t, false
    }
    t, ok = val.(T)
    return t, ok
}
```

类型断言用泛型,如果存进去的类型和取出来的类型不匹配,返回 `(零值, false)` 而不是 panic。这让 handler 能 graceful 处理"context 里没这个 key"的情况。

但 `MustGetUserID`(`gin.go:23`)就 panic:

```go
func MustGetUserID(c *gin.Context) uuid.UUID {
    userID, ok := GetUserID(c)
    if !ok {
        panic("user id not found in context")
    }
    return userID
}
```

设计意图:**`Must*` 是"我相信这一定有"的强断言**。如果走到 panic,说明 spec 配置错了(端点声明了某种 auth 但 handler 假设另一种)——这种错误应该尽早暴露,不是 graceful 处理。

---

## 十二、第 9 层:Handler 读取身份

最后,handler 业务逻辑开始。它从 gin context 拿身份的方式有 4 个变体:

```go
// 拿 team
team := auth.MustGetTeamInfo(c)         // 强断言,失败 panic
team, ok := auth.GetTeamInfo(c)         // 容错,ok=false 时自行处理
teamID := auth.MustGetTeamID(c)         // 等价于 MustGetTeamInfo(c).Team.ID

// 拿 user
userID := auth.MustGetUserID(c)         // 强断言
userID, ok := auth.GetUserID(c)         // 容错
```

绝大多数 handler 用 `Must*` 版本——因为 spec 声明的 auth 已经保证了 context 里有相应的值。

### 12.1 一个真实的 handler 起手式

```go
func (a *APIStore) PostSandboxes(c *gin.Context) {
    ctx := c.Request.Context()

    team := auth.MustGetTeamInfo(c)        // ← 第 9 层入口
    teamID := team.TeamID()
    limits := team.Limits                  // ← 第 6 层 join 出来的 limits

    // ... 业务逻辑 ...
}
```

到这里,9 层 pipeline 走完。请求从 TCP 字节流变成了"一个有身份、有 team、有 limits 的 handler 调用"。

---

## 十三、状态码 stamp:为什么是 401 而不是 400

这是整个 pipeline 最微妙的设计点之一,值得单独一章。

### 13.1 问题背景

`oapi-codegen` 的 ErrorHandler 在所有 security 组都失败时,会取**所有失败 code 的最大值**作为最终 HTTP 状态码。这个设计的初衷是:如果一个组返 401、另一个组返 403,取 max 得到 403,符合"更严重的错误优先"的语义。

但有个 trap:**如果 Authenticator 没显式设置状态码,Gin 默认是 200**。`schema 校验失败` 又会把 200 降到 400。最终 `max(400, 400) = 400`,用户看到 `400 Bad Request`——这会误导客户端以为是参数问题。

### 13.2 解决方案:每次失败都 stamp

`middleware.go:67-80`:

```go
key, err := a.getHeaderKeysFromRequest(req)
if err != nil {
    telemetry.ReportEvent(ctx, "auth scheme skipped", ...)
    ginCtx.Status(http.StatusUnauthorized)             // ← 关键:显式 stamp 401
    return err
}
```

`middleware.go:94`:

```go
result, validationError := a.validationFunc(ctx, ginCtx, key)
if validationError != nil {
    // ...
    ginCtx.Status(validationError.Code)                // ← 关键:显式 stamp validationError.Code
    // ...
}
```

每次失败都显式 `ginCtx.Status(...)`,把当前 status 设到 401 / 403。ErrorHandler 的 `max()` 就能拿到正确的值。

### 13.3 一个具体的例子

假设端点声明:

```yaml
security:
  - ApiKeyAuth: []
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
```

请求带的 header 不对(既没 `X-API-Key` 也没 `Authorization`)。会发生:

1. oapi-codegen 尝试第 1 组 `[ApiKeyAuth]`:
   - `ApiKeyAuth.Authenticate` → `getHeaderKeysFromRequest` 返 `ErrNoAuthHeader`。
   - `ginCtx.Status(401)`。
   - 返 error。
2. oapi-codegen 尝试第 2 组 `[AuthProviderBearerAuth, AuthProviderTeamAuth]`:
   - `AuthProviderBearerAuth.Authenticate` → 同上,返 `ErrNoAuthHeader`。
   - `ginCtx.Status(401)`(覆盖前一个 401,值不变)。
   - 返 error,这组失败。
3. 所有组失败,ErrorHandler 调 `max(401, 401) = 401`。
4. 客户端收到 **401 Unauthorized**。

如果代码忘了 stamp 401,会发生:

1. 第 1 组失败,默认 status 是 200。
2. schema 校验在 security 之前可能跑过,把 status 降到 400。
3. 第 2 组失败,同样。
4. ErrorHandler `max(400, 400) = 400`。
5. 客户端收到 **400 Bad Request**——误导。

这就是注释 `middleware.go:75-78` 强调的点。

---

## 十四、并发模型与降级路径

请求生命周期中,多个并发请求同时进入 pipeline 是常态。这一章讲并发与故障下的行为。

### 14.1 并发下的缓存行为

**Redis teamCache**:

- 多个 pod 同时 miss 同一个 key → 分布式锁保证只有一个 pod 查 DB,其他 pod 等锁释放后读 Redis。
- 同一个 pod 内多个 goroutine 同时 miss → `singleflight.Group` 合并成一次 DB 查询。

**进程内 identityCache**:

- 跨 pod 不共享:每个 pod 各自查一次 DB(但 1min TTL 内只查一次)。
- 同 pod 并发:`singleflight.Group` 合并。

### 14.2 Redis 故障时的降级

`authCache.GetOrSet` 内部:`Redis GET` 失败时,**视同 cache miss**,直接走 callback 查 DB。流程:

```
请求 ──▶ authCache.GetOrSet
         │
         ├─ Redis GET ──▶ 网络错误
         │
         ▼ 视同 miss
         cb() [DB 查询]
         │
         ▼
         Redis SET ──▶ 网络错误(忽略)
         │
         ▼
         返回 DB 结果
```

降级策略:**Redis 故障不阻塞请求**,但 DB 压力会瞬间上升(没有 cache 挡)。生产环境 Redis 故障时,DB QPS 可能飙升 10-100 倍,需要 DB 有足够容量。

### 14.3 DB 故障时的行为

- `authStoreImpl` 的查询失败 → 包装成 error 返回。
- `ValidateAPIKey` 把 error 分类:非 banned 错误统一返 401(`service.go:108-120`)。
- 客户端看到 401,但 trace 里有完整错误。

**注意**:这意味着 DB 故障会被客户端误诊为"凭证问题"。trace 是唯一的真实信息来源。运维监控必须基于 trace 而非 HTTP 状态码。

### 14.4 OIDC issuer 故障时的行为

启动时:`NewVerifier` 同步 fetch discovery doc,失败则服务起不来。

运行时:JWKS 后台刷新(默认 5min 一次)失败 → keyfunc 内部重试,期间用旧 JWKS。如果旧 JWKS 也过期了(issuer 长时间不可用),新 token 验证会失败,旧 token 仍能用(只要还在 JWKS 里)。

### 14.5 异步 UpdateLastTimeUsed 的并发安全

`auth_store.go:42-49` 的 `go func() { ... }`:

```go
go func() {
    ctx := context.WithoutCancel(ctx)
    updateErr := s.authDB.Write.UpdateLastTimeUsed(ctx, hashedKey)
    if updateErr != nil {
        logger.L().Error(ctx, "failed to update last time used", zap.Error(updateErr))
    }
}()
```

- **不阻塞响应**:goroutine 启动后立即返回。
- **不取消**:`context.WithoutCancel(ctx)` 让这次写入不受请求 ctx 影响。
- **失败只记日志**:不重试,不上报 telemetry(因为 `last_time_used` 不重要)。
- **可能丢**:服务关闭时 SIGTERM 后,正在跑的 goroutine 可能在进程退出前没写完。

并发:同一个 API key 的多次请求可能同时触发多个 UpdateLastTimeUsed goroutine。SQL 是 `UPDATE ... SET last_used = NOW() WHERE hash = $1`,并发写不会有冲突——最后一次写获胜,且都是 `NOW()`,差异可忽略。

---

## 十五、可观测性:trace、attribute、event

整条 pipeline 都埋了 OpenTelemetry,这是排查 401 问题的主要信息源。

### 15.1 Span 结构

每个请求至少有这些 span:

```
processing(api 服务)
└── authenticate                                ← middleware.go:236 起
    └── get team auth                           ← auth_store.go:30 起(仅 API Key 路径)
        └── (SQL query span,by db library)
```

### 15.2 Telemetry events

`middleware.go` 里有 3 个关键 event:

```go
telemetry.ReportEvent(ctx, "auth scheme skipped",          // header 提取失败
    attribute.String("auth.scheme", a.schemeName),
    attribute.String("auth.reason", err.Error()),
)

telemetry.ReportEvent(ctx, "api key extracted")            // header 提取成功

telemetry.ReportEvent(ctx, "api key validated")            // 凭证验证成功
```

`telemetry.ReportError` 在 validation 失败时:

```go
telemetry.ReportError(ctx,
    "validation error",
    validationError.Err,
    attribute.String("error.message", a.errorMessage),
    attribute.Int("http.status_code", validationError.Code),
    attribute.String("http.status_text", http.StatusText(validationError.Code)),
)
```

### 15.3 Attributes stamp 到 span

`service.go:124-127`:

```go
telemetry.SetAttributes(ginCtx.Request.Context(),
    telemetry.WithMaskedAPIKey(keys.MaskToken(keys.ApiKeyPrefix, apiKey)),
    telemetry.WithTeamID(result.TeamID()),
)
```

每个成功的请求都会把**脱敏后的 API key**(只露前 2 + 后 4 字符)+ teamID stamp 到 span。这意味着在 Grafana / Tempo 里,你可以用 `teamID=xxx` 过滤所有该 team 的请求,或用 `maskedAPIKey=e2b_a1...wxyz` 找到特定 key 的所有调用。

### 15.4 排查 401 的标准流程

1. 拿到 trace ID(通常客户端会在响应 header 或 error 里带)。
2. 在 Grafana / Tempo 打开 trace。
3. 看 `authenticate` span 的 events:
   - `auth scheme skipped` + `auth.reason` → 知道 header 哪里不对。
   - `api key extracted` 但没有 `api key validated` → 知道 header 提取 OK,验证失败。
4. 看 `authenticate` span 的 error:有 error message 和 status code。
5. 如果是 OIDC 路径,看 `validateJWTWithProvider` 的 sub-span,里面有 JWKS 验签、iss 校验等步骤的详细信息。

---

## 十六、不变量与威胁模型

这一章总结 pipeline 各层"必须成立"的不变量,以及对应的威胁防御。

### 16.1 不变量清单

| 层 | 不变量 | 守护机制 |
|----|--------|---------|
| 0 | `authProviderVerifier == nil` 是合法配置 | `NewVerifier` 返回 `(nil, nil)` |
| 3 | Header 缺失/前缀不符 → stamp 401 | `middleware.go:77` |
| 3 | `removePrefix` 不强制存在(`TrimPrefix`) | `strings.TrimPrefix` 行为 |
| 3 | `prefix` 强制存在(`HasPrefix`) | `middleware.go:59` |
| 4 | API Key 格式校验在缓存之前 | `service.go:94` |
| 4 | DB 错误统一返 401(非 500) | `service.go:108-120` |
| 4 | JWT 验签通过 ≠ 认证通过 | `service.go:196-202` |
| 4 | `AuthProviderTeamAuth` 单独出现 → 500 | `service.go:215-221` |
| 5 | teamCache 跨 pod 共享 | Redis |
| 5 | identityCache 不缓存失败 | `identity_lookup.go:18-19` 注释 |
| 5 | identityCache 不进 Redis | 故障隔离 |
| 6 | 所有读走 `authDB.Read` | `authStoreImpl` 实现 |
| 6 | `UpdateLastTimeUsed` 走 `authDB.Write` + 异步 | `auth_store.go:42-49` |
| 6 | OIDC 身份查询走 `authDB.Write` | `service.go:79` |
| 7 | banned 在 store 层强制 | `auth_store.go:38, 65, 91` |
| 7 | blocked 在中间件层 + 白名单 | `team_middleware.go:59` |
| 8 | OIDC JWT 流程注入两次(user_id + team) | `middleware.go:106-108` |
| 9 | `MustGet*` 失败 panic,尽早暴露配置错误 | `gin.go:23, 36` |

### 16.2 威胁模型

| 威胁 | 防御 |
|------|------|
| **时序攻击 admin token** | `subtle.ConstantTimeCompare`(`middleware.go:120`) |
| **暴力枚举 API Key** | API Key 是 20 字节随机(160 bit),穷举不可行;DB 错误返 401 不暴露差异 |
| **伪造 JWT** | RS256 签名 + JWKS 公钥校验 |
| **JWT 重放(跨 issuer)** | `WithIssuer(配置值)` 强制校验 iss |
| **JWT 跨 audience 重放** | `validateAudience` 取交集 |
| **JWT 永久有效** | `WithExpirationRequired` 强制 exp |
| **撤销的 JWT 仍能用** | `(iss, sub)` 在身份表里删行即可,1min 内 identityCache 过期 |
| **DB 拖垮(缓存击穿)** | Redis 分布式锁 + 进程内 singleflight |
| **Redis 故障** | 自动降级到 DB(`authCache.GetOrSet` 内部) |
| **banned team 绕过** | store 层强制,无例外 |
| **blocked team 撞墙** | 白名单允许自助解封路径 |
| **OIDC 复制时延赛跑** | 身份查询强制走 `authDB.Write`(`service.go:79`) |
| **Admin token 长度泄露** | 常量时间比较,不暴露长度差异 |
| **API Key 在日志/telemetry 泄露** | `MaskToken` 只露前 2 + 后 4 字符 |
| **配置错误(spec 写了未装配的 scheme)** | 启动后第一次请求就 500,尽早暴露 |

### 16.3 已知限制(非防御的)

| 限制 | 说明 |
|------|------|
| API Key 删除后短期仍可用 | teamCache TTL 5min,期间缓存命中,详见 [`api-keys-module.md` 8.3](./api-keys-module.md#83-删除后缓存如何失效) |
| Access Token 不缓存 → DB QPS 高 | 故意不缓存,详见 §8.3 |
| `last_time_used` 可能丢 | 异步写,服务关闭时丢失最后几秒 |
| OIDC JWKS 短暂过期 | issuer 故障期间,新 token 验证失败,旧 token 仍能用 |

---

## 十七、端到端实战:3 个真实请求跟踪

把前面所有章节串起来,用 3 个真实场景验证理解。

### 17.1 场景 A:SDK 用 API Key 创建 sandbox

请求:

```http
POST /sandboxes HTTP/1.1
Host: api.e2b.dev
X-API-Key: e2b_a1b2c3d4e5f6...wxyz
Content-Type: application/json

{"templateID": "base"}}
```

执行序列:

```
1.   TCP 接入,Gin 找到 POST /sandboxes 路由
2.   oapi-codegen 中间件跑起来
3.   spec 声明 security:[ApiKeyAuth] OR [AccessTokenAuth] OR [BearerAuth + TeamAuth]
4.   尝试第 1 组 [ApiKeyAuth]:
     a. SecuritySchemeName == "ApiKeyAuth" → 匹配 ApiKeyAuthenticator
     b. getHeaderKeysFromRequest:
        - header.name = "X-API-Key",值 = "e2b_a1b2c3d4..."
        - prefix = "e2b_",HasPrefix 通过
        - 返回 ("e2b_a1b2c3d4...", nil)
     c. validationFunc = apiStore.GetTeamFromAPIKey → authService.ValidateAPIKey:
        - keys.VerifyKey("e2b_", "e2b_a1b2c3d4...") → 去 prefix → hex.DecodeString → SHA256
          → hashedKey = "$sha256$<43 字符 base64>"
        - teamCache.GetOrSet(hashedKey, cb):
          - Redis GET auth:team:$sha256$... → 假设 hit,且 age = 30s(< 1min)
          - 直接返回缓存的 *types.Team
        - telemetry.SetAttributes(maskedAPIKey="e2b_a1...wxyz", teamID=...)
        - 返回 (team, nil)
     d. setContextFunc = setTeamInfo:
        - ginCtx.Set("team", team)
     e. 返回 nil(成功)
5.   第 1 组通过,跳过其他组
6.   handler PostSandboxes 执行:
     - team := auth.MustGetTeamInfo(c)
     - limits := team.Limits
     - ... 业务逻辑 ...
7.   返回 201 + sandbox 信息
```

总耗时:**1 次 Redis GET**(cache hit)+ 业务逻辑。无 DB 查询。

### 17.2 场景 B:dashboard-api 用 OIDC JWT 查 team 详情

请求:

```http
GET /api/teams/123e4567-e89b-12d3-a456-426614174000 HTTP/1.1
Host: dashboard.e2b.dev
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
X-Team-Id: 123e4567-e89b-12d3-a456-426614174000
```

执行序列:

```
1.   Gin 找到 GET /api/teams/:teamID 路由
2.   oapi-codegen 中间件
3.   spec 声明 security:[BearerAuth + TeamAuth] AND
4.   尝试唯一一组 [AuthProviderBearerAuth, AuthProviderTeamAuth]:
     
     Step 1: AuthProviderBearerAuth
     a. SecuritySchemeName == "AuthProviderBearerAuth" → 匹配
     b. getHeaderKeysFromRequest:
        - header.name = "Authorization",值 = "Bearer eyJhbGc..."
        - removePrefix = "Bearer ",去掉 → "eyJhbGc..."
        - prefix = ""(AuthProviderBearerAuth 不校验前缀)
        - 返回 ("eyJhbGc...", nil)
     c. validationFunc = GetUserIDFromAuthProviderToken → authService.ValidateAuthProviderToken:
        - authProviderVerifier != nil(假设 OIDC 已配置)
        - validateJWTWithProvider:
          - v.Verify(ctx, "eyJhbGc..."):
            - jwt.ParseWithClaims:JWKS 验签 OK,exp OK,iss OK
            - validateAudience:aud 在配置中,OK
            - 提取 iss = "https://auth.e2b.dev", sub = "user-abc"
            - identityLookup.GetUserIdentity(iss, sub):
              - cache.GetOrSet("https://auth.e2b.dev\x00user-abc", cb):
                - 假设 miss
                - cb → authDB.Write.GetUserIdentity → user_id = uuid
                - 缓存 1min
              - 返回 user_id
            - 返回 (user_id, claims, nil)
          - userID != uuid.Nil,OK
        - telemetry.SetAttributes(userID=...)
        - 返回 (user_id, nil)
     d. setContextFunc = setUserID:
        - ginCtx.Set("user_id", user_id)
     e. 返回 nil(成功)
     
     Step 2: AuthProviderTeamAuth(同一组的第二个 scheme)
     a. SecuritySchemeName == "AuthProviderTeamAuth" → 匹配
     b. getHeaderKeysFromRequest:
        - header.name = "X-Team-ID",值 = "123e4567-..."
        - prefix = "",removePrefix = ""
        - 返回 ("123e4567-...", nil)
     c. validationFunc = GetTeamFromAuthProviderToken → authService.ValidateAuthProviderTeam:
        - userID := GetUserID(ginCtx) → 拿到 Step 1 注入的 user_id
        - cacheKey = "user-uuid-123e4567-..."
        - teamCache.GetOrSet(cacheKey, cb):
          - 假设 miss
          - cb → store.GetTeamByIDAndUserID:
            - authDB.Read.GetTeamWithTierByTeamAndUser(ID, UserID):
              - JOIN teams ⨝ users_teams ⨝ team_limits
              - WHERE user_id = $1 AND team_id = $2
              - 验证成员关系
            - CheckTeamBanned(team) → OK
          - 返回 *types.Team
        - telemetry.SetAttributes(userID=..., teamID=...)
        - 返回 (team, nil)
     d. setContextFunc = setTeamInfo:
        - ginCtx.Set("team", team)
     e. 返回 nil(成功)
     
5.   整组通过
6.   EnforceBlockedTeam 中间件:
     - GetTeamInfo(c) → team
     - CheckBlockedTeamForRoute:
       - team.IsBlocked? 假设 false
       - 返回 nil
     - c.Next()
7.   handler GetTeam 执行:
     - team := auth.MustGetTeamInfo(c)
     - 返回 team 详情
8.   返回 200 + JSON
```

总耗时:**1 次进程内 cache miss → 1 次 DB Write 池查询**(身份)+ **1 次 Redis miss → 1 次 DB Read 池查询**(team)。第二次同一 user 调用 → 身份 cache 命中,team cache 也命中,**0 次 DB 查询**。

### 17.3 场景 C:运维用 Admin Token 触发 team cache 失效

请求:

```http
POST /admin/teams/123e4567-.../invalidate-cache HTTP/1.1
Host: api.e2b.dev
X-Admin-Token: <configured admin token>
X-Team-ID: 123e4567-e89b-12d3-a456-426614174000
```

执行序列:

```
1.   Gin 找到 POST /admin/teams/:teamID/invalidate-cache 路由
2.   spec 声明 security:[AdminApiKeyAuth + AdminTeamAuth] AND
3.   尝试唯一一组:
     
     Step 1: AdminApiKeyAuth
     a. 匹配 AdminApiKeyAuthenticator
     b. getHeaderKeysFromRequest:
        - header.name = "X-Admin-Token"
        - prefix = "",removePrefix = ""
        - 返回 (<token>, nil)
     c. validationFunc = adminValidationFunction(adminToken):
        - subtle.ConstantTimeCompare([]byte(token), []byte(configured)) == 1
        - 返回 (struct{}{}, nil)
     d. setContextFunc = nil,跳过
     e. 返回 nil
     
     Step 2: AdminTeamAuth
     a. 匹配 AdminTeamAuthenticator
     b. getHeaderKeysFromRequest:
        - header.name = "X-Team-ID"
        - 返回 ("123e4567-...", nil)
     c. validationFunc = GetTeamFromAdminToken → 走类似 ValidateAuthProviderTeam 的流程
        - 不需要 userID(因为是 admin 路径)
        - 直接 store.GetTeamByID(teamID)
        - 注:具体实现见 handlers/store.go 的 GetTeamFromAdminToken
     d. setContextFunc = setTeamInfo
     e. 返回 nil
     
4.   通过
5.   handler 执行:
     - authService.InvalidateTeamCache(ctx, teamID)
       - teamCache.Invalidate("team-123e4567-...")
       - hashes := store.GetTeamAPIKeyHashes(ctx, teamID)  ← 查所有 API key hash
       - for each hash: teamCache.Invalidate(hash)
     - 返回 200
6.   下一次该 team 的请求 → cache miss → 走 DB → 拿到最新状态
```

注意 Step 2 的 `AdminTeamAuth` 走的是 `store.GetTeamByID`(不带 userID 校验),不是 `GetTeamByIDAndUserID`——因为 admin 路径不需要验证成员关系,admin 已经有"代任何 team 操作"的权限。这就是 admin 路径和 OIDC 路径的关键差异。

---

## 十八、写新 handler 时的反模式与陷阱

把前 17 章的知识浓缩成可操作的"该做"和"不该做"。

### 18.1 该做

| 该做 | 原因 |
|------|------|
| 用 `auth.MustGetTeamInfo(c)` / `auth.MustGetUserID(c)` 拿身份 | spec 已保证 context 里有值;失败 = 配置错误,应尽早 panic |
| 在创建/修改资源的 handler 里调 `auth.CheckTeamAccess(c, team, allowlist)` | banned 检查是 store 层自动的,blocked 检查不是——handler 要主动 |
| 在改 team 配置后调 `authService.InvalidateTeamCache(ctx, teamID)` | 否则 5min 内其他请求还看到旧数据 |
| 改成员关系后调 `authService.InvalidateTeamMemberCache(ctx, userID, teamID)` | 否则 5min 内该 user 还以为自己在/不在 team |
| 用 `auth.GetTeamInfo` / `auth.GetUserID`(非 Must 版)处理 optional 身份 | 容错,不 panic |
| 用 `auth.MustGetTeamID(c).Team.ID` 而不是 `c.Get("team")` | 后者没类型断言,拿到的是 `any`,容易写错 |

### 18.2 不该做

| 不该做 | 后果 |
|--------|------|
| 在 handler 里直接 `c.Set("user_id", ...)` | 绕过 auth 包,key 写错 / 类型错都不会被发现 |
| 假设 `auth.GetTeamInfo(c)` 一定返回 team(非空 ok) | admin/access-token 路径上没 team,直接 .Team.ID 会 nil panic |
| 在 handler 里调 `authDB.Read.GetTeam(...)` 直接查 team | 绕过 cache,且没过 banned 检查 |
| 修改 team 后忘记 `InvalidateTeamCache` | 用户看到旧数据 5min |
| 在 spec 里给端点配 `security: []`(空数组) | 等价于"无 auth",所有人可访问 |
| 在 spec 里写未装配的 scheme 名 | 启动后第一次请求就 500 |
| 在 spec 里把 `AuthProviderTeamAuth` 单独使用(无 `AuthProviderBearerAuth` 前置) | `ValidateAuthProviderTeam` 找不到 userID,返 500 |
| 在 spec 里把 `AdminTeamAuth` 单独使用(无 `AdminApiKeyAuth` 前置) | 等价于"任何人传 X-Team-ID 就能通过",严重安全漏洞 |
| 用 `c.GetHeader("X-API-Key")` 自己读 header | 绕过前缀校验、telemetry、状态码 stamp |

### 18.3 一个反模式实例

❌ **错误代码**:

```go
func (a *APIStore) MyHandler(c *gin.Context) {
    apiKey := c.GetHeader("X-API-Key")           // ← 绕过 auth,没验证
    teamID := c.Query("team_id")                  // ← 从 query 拿 teamID,任何客户端可伪造
    
    team, err := a.authDB.Read.GetTeamByID(c, teamID)  // ← 绕过 cache,没过 banned 检查
    if err != nil {
        c.JSON(500, gin.H{"error": "team not found"})
        return
    }
    
    // 用 team 做事...
}
```

问题:

1. 绕过 auth 中间件 → 任何人都能调这个端点(假设 spec 没声明 security)。
2. `teamID` 从 query 拿 → 客户端可传任意 teamID,跨 team 越权。
3. 直接 `authDB.Read` → 绕过 cache,DB 压力大。
4. 没过 banned 检查 → banned team 能用这个端点。

✅ **正确写法**:

```go
func (a *APIStore) MyHandler(c *gin.Context) {
    team := auth.MustGetTeamInfo(c)              // ← 从 context 拿,已被 auth 验证过
    teamID := team.Team.ID()                      // ← 从 team 拿,客户端无法伪造
    
    // 用 team 做事...
}
```

只需两行。spec 里声明 `security: [ApiKeyAuth]`,auth 中间件帮你做完所有事。

### 18.4 spec 声明模板

最常见的几种 spec 声明:

```yaml
# 1. 仅 API Key(机器调用,最严格)
security:
  - ApiKeyAuth: []

# 2. API Key 或 Access Token(SDK 兼容旧版)
security:
  - ApiKeyAuth: []
  - AccessTokenAuth: []

# 3. 三选一(SDK 全兼容)
security:
  - ApiKeyAuth: []
  - AccessTokenAuth: []
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []

# 4. 仅 OIDC(dashboard 类端点)
security:
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []

# 5. Admin 路径(运维专用)
security:
  - AdminApiKeyAuth: []
    AdminTeamAuth: []

# 6. Admin 或用户 OIDC(混合)
security:
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
  - AdminApiKeyAuth: []
    AdminTeamAuth: []
```

模板 6 在 dashboard-api 很常见——同一个端点既允许用户访问自己的 team,也允许 admin 代任何 team 操作。

---

## 附录:关键代码路径速查

按"我想知道 X 在哪"组织。

| 想找什么 | 文件:行 |
|---------|--------|
| Authenticator 接口定义 | `packages/auth/pkg/auth/middleware.go:34` |
| `commonAuthenticator` 模板 | `packages/auth/pkg/auth/middleware.go:40` |
| 6 个 `NewXxxAuthenticator` 工厂 | `packages/auth/pkg/auth/middleware.go:132-222` |
| Header 提取逻辑 | `packages/auth/pkg/auth/middleware.go:49` |
| 状态码 stamp 逻辑 | `packages/auth/pkg/auth/middleware.go:75-77, 94` |
| 分发函数 | `packages/auth/pkg/auth/middleware.go:225` |
| Admin token 常量时间比较 | `packages/auth/pkg/auth/middleware.go:120` |
| `ValidateAPIKey` | `packages/auth/pkg/auth/service.go:93` |
| `ValidateAccessToken` | `packages/auth/pkg/auth/service.go:140` |
| `ValidateAuthProviderToken` | `packages/auth/pkg/auth/service.go:174` |
| `ValidateAuthProviderTeam` | `packages/auth/pkg/auth/service.go:213` |
| `InvalidateTeamCache` | `packages/auth/pkg/auth/service.go:261` |
| `InvalidateTeamMemberCache` | `packages/auth/pkg/auth/service.go:256` |
| `teamCache` 配置 | `packages/auth/pkg/auth/cache.go:13-19` |
| `identityCacheTTL` | `packages/auth/pkg/auth/identity_lookup.go:20` |
| `identityCacheKey`(NUL 分隔) | `packages/auth/pkg/auth/identity_lookup.go:73` |
| `GetTeamByHashedAPIKey` | `packages/auth/pkg/auth/auth_store.go:29` |
| 异步 UpdateLastTimeUsed | `packages/auth/pkg/auth/auth_store.go:42-49` |
| `CheckTeamBanned` | `packages/auth/pkg/auth/team_state.go:13` |
| `CheckTeamBlocked` | `packages/auth/pkg/auth/team_state.go:28` |
| `EnforceBlockedTeam` 中间件 | `packages/auth/pkg/auth/team_middleware.go:59` |
| `BlockedTeamAllowlist` | `packages/auth/pkg/auth/team_middleware.go:14` |
| `CheckTeamAccess` | `packages/auth/pkg/auth/team_middleware.go:45` |
| gin context key 常量 | `packages/auth/pkg/auth/gin.go:11-13` |
| `setUserID` / `setTeamInfo` | `packages/auth/pkg/auth/gin.go:15, 32` |
| `GetUserID` / `GetTeamInfo` | `packages/auth/pkg/auth/gin.go:19, 49` |
| `MustGetUserID` / `MustGetTeamInfo` | `packages/auth/pkg/auth/gin.go:23, 36` |
| Header / Prefix 常量 | `packages/auth/pkg/auth/consts.go:5-13` |
| `TeamForbiddenError` / `TeamBlockedError` | `packages/auth/pkg/auth/error.go:9, 18` |
| api 服务装配(6 个 Authenticator) | `packages/api/main.go:189` |
| dashboard-api 装配(3 个) | `packages/dashboard-api/main.go:191-243` |

---

> **结语**:这份文档把 auth 请求生命周期拆成了 9 层 pipeline,每一层都展开了代码切片、不变量、并发模型、降级路径。读完之后,你应该能在脑中清晰画出任意 auth 请求的执行序列,并预测任何代码改动的影响面。
>
> 如果你看完发现某个细节有疑问,或者实际遇到了文档没覆盖的场景,欢迎补充。这份文档的目标是成为"看完就能 debug 任意 auth 问题"的参考,所以场景越全越好。
