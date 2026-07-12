# E2B auth(认证子系统)详解

> 本文档详细描述 E2B Infrastructure 中 **`packages/auth`** 子系统的设计、架构、接口、生命周期与关键实现。
>
> `auth` 包是所有 E2B 对外服务(api、dashboard-api、未来可能的新服务)的**认证底座**,统一处理 API Key、AccessToken、OIDC JWT、Admin Token 四类凭证的解析、验证、缓存与 team 状态裁决。它本身**不是服务**(没有 main.go、没有监听端口),而是一个被各服务 import 并组装到 Gin 中间件链上的库。
>
> **相关文档**:
> - [`api-module.md`](api-module.md) — API 服务(`auth` 的最大调用方)
> - [`database-schema.md`](database-schema.md) — teams / team_api_keys / access_tokens / user_identities 表结构
> - [`envd-module.md`](envd-module.md) — envd 内的 in-VM token(`/init` 那一套不走 `auth` 包,但概念相关)
> - [`sandbox-management.md`](sandbox-management.md) — Sandbox 创建时如何拿到 team

---

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、整体架构](#三整体架构)
- [四、三种凭证的验证生命周期](#四三种凭证的验证生命周期)
- [五、OIDC JWT 验证深入](#五oidc-jwt-验证深入)
- [六、双层缓存机制](#六双层缓存机制)
- [七、OpenAPI 安全方案分发器](#七openid-安全方案分发器)
- [八、Team 状态:banned vs blocked](#八team-状态banned-vs-blocked)
- [九、数据模型](#九数据模型)
- [十、典型时序图](#十典型时序图)
- [十一、配置与 Feature Flag](#十一配置与-feature-flag)
- [十二、关键代码文件索引](#十二关键代码文件索引)
- [十三、设计要点与权衡](#十三设计要点与权衡)
- [十四、常见问题与排查](#十四常见问题与排查)
- [附录 A:认证方案速查表](#附录a认证方案速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录b错误码与-http-状态映射)
- [附录 C:术语表](#附录c术语表)

---

## 一、概述

### 1.1 auth 是什么

`packages/auth` 是一个**纯库**,负责把 HTTP 请求中的凭证(API Key / Access Token / OIDC JWT / Admin Token)翻译成可用的内部身份(`types.Team` 或 `uuid.UUID` user ID),并把这个身份塞进 Gin context,供下游 handler 使用。

它的核心职责:

| 职责 | 实现位置 |
|------|---------|
| **解析 HTTP header**(X-API-Key、Authorization、X-Team-ID、X-Admin-Token) | `middleware.go` |
| **凭证格式校验**(前缀、长度、hex 合法性) | `service.go` + `keys.VerifyKey` |
| **DB 查询**:把 hash → team / user | `auth_store.go` |
| **Redis 缓存**:team 信息 5 分钟 TTL,后台刷新 | `cache.go` |
| **OIDC JWT 验证**:发现文档、JWKS、签名、aud、iss、sub | `oidc/oidc.go` |
| **OIDC 身份内存缓存**:(iss, sub) → user_id,1 分钟 TTL | `identity_lookup.go` |
| **Team 状态裁决**:banned → 403 Forbidden,blocked → 403 但有路由白名单 | `team_state.go` + `team_middleware.go` |
| **Gin context 注入/读取**:`SetTeamInfo`、`GetUserID` 等 | `gin.go` |

### 1.2 关键定位

```
                          ┌─────────────────────────────────────┐
   外部 HTTP 请求 ───────▶│ Gin middleware(oapi-codegen)        │
   (带凭证)               │   ↓                                  │
                          │ CreateAuthenticationFunc(...)        │
                          │   ↓ dispatch by SecuritySchemeName   │
                          │ commonAuthenticator.Authenticate(...)│
                          │   ↓                                  │
                          │  解析 header → 调 service.Validate*  │
                          │   ↓                                  │
                          │ ┌─────────────────────────────────┐ │
                          │ │ authService                     │ │
                          │ │  ├─ keys.VerifyKey(prefix, key)│ │
                          │ │  ├─ authCache.GetOrSet(...)     │ │  ──▶ Redis(auth:team:*)
                          │ │  │   └─ store.GetTeamBy*(...)   │ │  ──▶ PostgreSQL(read replica)
                          │ │  └─ authProviderVerifier.Verify │ │
                          │ │      ├─ jwt.ParseWithClaims     │ │
                          │ │      ├─ keyfunc(JWKS)            │ │  ──▶ OIDC issuer HTTPS
                          │ │      └─ identityLookup           │ │  ──▶ PostgreSQL(write primary)
                          │ └─────────────────────────────────┘ │
                          │   ↓                                  │
                          │ SetTeamInfo / SetUserID(ginCtx)     │
                          └────────────┬────────────────────────┘
                                       │
                                       ▼
                                 handler 拿到身份
```

### 1.3 关键心智模型

> 想读懂 `auth` 包,先抓住 **四个反直觉点**:
>
> 1. **没有任何 main.go,只有 export**。`auth` 是一个被 import 的库。各服务在自己的 `main.go` 里 `sharedauth.NewAuthService(...)` 装配,然后传一个 `[]Authenticator` 给 `oapi-codegen` 的中间件。所以同一个 `auth` 包既能给 api 服务用(完整 4 种凭证),也能给 dashboard-api 用(只 3 种)。
>
> 2. **JWT 的开关是 Feature Flag**。当环境变量 `AUTH_PROVIDER_CONFIG` 为空 / `null` 时,`NewVerifier` 返回 `(nil, nil)`——**这是合法配置**。此时 `ValidateAuthProviderToken` 会对所有 JWT 直接返回 401。换言之,"没有 OIDC 提供商" 是一等公民的配置,不是错误。
>
> 3. **读写分离到 token 级别**。`authStore` 的所有"读"(查 team)都走 `authDB.Read`(read replica 池);但 `UpdateLastTimeUsed`(API Key 最近使用时间)走 `authDB.Write`(primary 池),而且**异步 fire-and-forget**,不阻塞响应。OIDC 身份查询也走 `Write` 池(避免 bootstrap 时 replication lag 丢身份)。
>
> 4. **banned 和 blocked 是两件事**。banned 永久拒绝(`TeamForbiddenError`,403,在 `store` 层早返回);blocked 是"软封"——大部分路由拒绝(`TeamBlockedError`,403),但白名单路由(如用户自己查看自己的 team)允许通过。blocked 的检查不在 store 层,而在 **handler 入口处的中间件**(`EnforceBlockedTeam`)里。

### 1.4 整体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│ packages/auth/pkg/auth/                                               │
│                                                                       │
│  service.go         ← authService:对外接口 Service                    │
│    ├─ store         ← authStore 接口(由 authStoreImpl 实现)         │
│    ├─ teamCache     ← authCache(Redis,5min TTL + 1min 后台刷新)    │
│    └─ authProviderVerifier ← *Verifier(可能为 nil)                  │
│                                                                       │
│  middleware.go      ← commonAuthenticator[T] + 6 个 NewXxxAuthenticator│
│  verifier.go        ← Verifier:多 OIDC issuer 聚合                    │
│  identity_lookup.go ← (iss,sub)→user_id 的内存缓存(1min TTL)      │
│  auth_store.go      ← authStoreImpl:DB 查询 + 异步 last_time_used 更新│
│  cache.go           ← authCache:Redis 包装                            │
│  team_state.go      ← CheckTeamBanned / CheckTeamBlocked              │
│  team_middleware.go ← EnforceBlockedTeam 中间件 + 白名单              │
│  gin.go             ← GetUserID / GetTeamInfo / MustGetTeamID         │
│  consts.go          ← HeaderXxx / PrefixXxx 常量                      │
│  error.go           ← APIError 别名 + TeamForbiddenError/BlockedError │
│  provider_config_parse.go ← ParseProviderConfig(env → ProviderConfig)│
│  testing.go         ← SetUserIDForTest / SetTeamInfoForTest           │
│                                                                       │
│  oidc/                                                                  │
│    oidc.go          ← 单 issuer 验证:discovery + JWKS + jwt.Parse   │
│    config.go        ← Config/Issuer,JSON 反序列化 + Validate          │
│    audience.go      ← AudienceMatchPolicy + validateAudience          │
│    testserver.go    ← 测试用 TLS OIDC mock                            │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 二、核心概念

### 2.1 三种对外凭证

`auth` 包认识三种"用户面"凭证:

| 凭证 | Header | 前缀 | 谁用 | DB 落点 |
|------|--------|------|------|---------|
| **API Key** | `X-API-Key` | `e2b_` | SDK / CI 调用 api 服务 | `public.team_api_keys.api_key_hash` |
| **Access Token** | `Authorization: Bearer sk_e2b_...` | `sk_e2b_` | SDK 用户登录后 | `public.access_tokens.access_token_hash` |
| **OIDC JWT** | `Authorization: Bearer <jwt>` | (无固定前缀) | dashboard-api 转发用户登录 | `public.user_identities (oidc_iss, oidc_sub)` |

外加两种"内部面"凭证:

| 凭证 | Header | 谁用 | 怎么校验 |
|------|--------|------|----------|
| **Admin API Key** | `X-Admin-Token` | E2B 内部运维 | `subtle.ConstantTimeCompare` 与配置的 `AdminToken` |
| **Admin Team ID** | `X-Team-ID` | 内部运维代某 team 操作 | 跟普通 team 查询一样走 DB,但用 `AdminTeamAuth` 方案 |

### 2.2 凭证 hash 策略

**API Key / Access Token**:服务端只存 hash,不存原值。

```
e2b_<40 字符 hex>          ← 原值(用户持有,44 字符 = 4 前缀 + 40 hex)
   ↓ keys.VerifyKey(prefix, key)
   ↓ 去 prefix → hex.DecodeString → 拿回 20 字节随机
   ↓ SHA-256(20 字节) → 32 字节 hash
   ↓ base64.RawStdEncoding → 43 字符 base64
   ↓ 加前缀
$sha256$<43 字符 base64>   ← 存进 DB 的 hash(总长 51 字符)
```

详见 [`packages/shared/pkg/keys/key.go:100`](../../packages/shared/pkg/keys/key.go) 的 `VerifyKey` 和 [`sha256.go`](../../packages/shared/pkg/keys/sha256.go) 的 SHA-256 实现(`$sha256$<base64>` 格式,不是裸 hex)。

**OIDC JWT**:不存原值也不存 hash。身份是 `(iss, sub)` 二元组,存在 `public.user_identities` 表。每次验证都重新跑发现 + JWKS + 验签,然后查身份表把 OIDC subject 翻译成内部 `user_id`。

### 2.3 ProviderConfig 与 Feature Flag

OIDC 验证通过环境变量 `AUTH_PROVIDER_CONFIG` 配置(JSON):

```json
{
  "jwt": [
    {
      "issuer": {
        "url": "https://auth.example.com",
        "audiences": ["e2b-dashboard"],
        "audienceMatchPolicy": "MatchAny"
      },
      "cacheDuration": "5m"
    }
  ]
}
```

- **空字符串 / `"null"` / 缺省**:`ParseProviderConfig` 返回零值 `ProviderConfig{}`,`enabled()` 返回 false,`NewVerifier` 返回 `(nil, nil)`。**JWT 验证被禁用,其他凭证不受影响**。
- **非空**:走 JSON 反序列化 → `normalize`(填默认值)→ `validate`(校验 URL、audiences)→ `oidc.NewVerifier`(同步拉 discovery doc + JWKS)。

详见 [`verifier.go:64`](../../packages/auth/pkg/auth/verifier.go) 的 `NewVerifier` 与 [`provider_config_parse.go:13`](../../packages/auth/pkg/auth/provider_config_parse.go) 的 `ParseProviderConfig`。

### 2.4 Verifier 聚合器

`Verifier` 是个**多 issuer 聚合器**:可以同时配置多个 OIDC 提供商(例如同时支持 Auth0 和 Ory),`Verify` 顺序尝试,任何一个签发并匹配身份的就返回。

```go
type Verifier struct {
    strategies []strategy  // 每个 strategy 是一个 oidc.Verifier
}
```

`strategy` 接口签:

```go
type strategy interface {
    Verify(ctx context.Context, tokenString string) (uuid.UUID, jwt.MapClaims, error)
}
```

`Verify` 的迭代规则:任一 strategy 报错就累计到 `errs`,只有 `userID != uuid.Nil` 的成功才返回;全部失败时用 `errors.Join` 把所有错误合并。详见 [`verifier.go:98`](../../packages/auth/pkg/auth/verifier.go)。

### 2.5 Team 是什么

`types.Team` 是 `authqueries.Team`(sqlc 生成的 DB 行)+ `TeamLimits`(配额)的组合:

```go
type Team struct {
    *authqueries.Team  // ID, Name, Tier, IsBanned, IsBlocked, BlockedReason, ...
    Limits *TeamLimits // SandboxConcurrency, BuildConcurrency, MaxVcpu, ...
}
```

handler 里几乎所有的"哪个 team 在调","这个 team 的配额是多少",都来自 `MustGetTeamInfo(c).Limits` 这种调用。

`TeamLimits` 字段(见 [`types/limits.go`](../../packages/auth/pkg/types/limits.go)):

| 字段 | 含义 |
|------|------|
| `SandboxConcurrency` | 同时运行的 sandbox 数上限 |
| `BuildConcurrency` | 同时进行的 template build 数上限 |
| `MaxLengthHours` | sandbox 最长存活时间(小时) |
| `MaxVcpu` | 每 sandbox 最大 vCPU |
| `MaxRamMb` | 每 sandbox 最大内存(MB) |
| `DiskMb` | team 磁盘配额(MB) |
| `EventsTTLDays` | 事件流保留天数 |

---

## 三、整体架构

### 3.1 装配序列(api 服务为例)

文件:[`packages/api/main.go:189`](../../packages/api/main.go)

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
    metricsMiddleware.SetProcessingStartTime, // preAuthHook,在 auth 之前 stamp 开始时间
)
```

dashboard-api 装配更精简(只 3 个:`AdminApiKeyAuth` + `AuthProviderBearerAuth` + `AuthProviderTeamAuth`,因为 dashboard 只接受用户 JWT 而不接受 API Key / Access Token):见 [`packages/dashboard-api/main.go:236`](../../packages/dashboard-api/main.go)。

### 3.2 service.go 的依赖图

```go
// packages/auth/pkg/auth/service.go:44
type authService struct {
    store                authStore          // ← authStoreImpl,包了 authDB
    teamCache            *authCache         // ← Redis 包装
    authProviderVerifier *Verifier          // ← 可能 nil(feature flag off)
}
```

`NewAuthService` 做了 5 件事:

1. 检查 `redisClient`、`authDB`、`httpClient` 都非 nil。
2. `newAuthCache(redisClient)` — 起 Redis cache。
3. `newAuthStore(authDB)` — 起 DB store。
4. `newAuthIdentityLookup(authDB.Write)` — OIDC 身份查询(走 Write 池),内部自带 1min 内存缓存。
5. `NewVerifier(ctx, providerConfig, httpClient, identityLookup)` — 起 JWT 验证器(可能返回 nil,nil)。

注意第 4 步的注释([`service.go:77-79`](../../packages/auth/pkg/auth/service.go)):

> OIDC bootstrap writes identity rows on the primary immediately before the next authenticated request; using the read replica here races replication lag.

——第一次 OIDC 登录时,`dashboard-api` 会立刻往 primary 写一行 `user_identities`,紧接着用 JWT 调 API。如果走 read replica,replication lag 可能让这行还没同步过来,身份查询会失败。所以**身份查询强制走 Write 池**。

### 3.3 数据流总览

```
                      ┌─────────────────────────────────────────┐
   ValidateAPIKey     │ keys.VerifyKey → hash                   │
                      │  ↓                                       │
                      │ authCache.GetOrSet(hashedKey, ...)       │
                      │  ↓ cache miss                           │
                      │ store.GetTeamByHashedAPIKey(hashedKey)   │
                      │  ↓                                       │
                      │   ├─ CheckTeamBanned(team) ← 403 if banned│
                      │   └─ go async: Write.UpdateLastTimeUsed  │
                      │  ↓                                       │
                      │ types.NewTeam(team, limit)               │
                      └─────────────────────────────────────────┘

   ValidateAccessToken┌─────────────────────────────────────────┐
                      │ keys.VerifyKey → hash                   │
                      │  ↓                                       │
                      │ store.GetUserIDByHashedAccessToken(hash)│
                      │  ↓ (no cache, every request hits DB)    │
                      │ user_id (uuid.UUID)                      │
                      └─────────────────────────────────────────┘

   ValidateAuthProviderToken                                          ┌─────┐
                      ┌─────────────────────────────────────────┐    │ nil │ → 401
                      │ if authProviderVerifier == nil           │    └─────┘
                      │  ↓ not nil                                │
                      │ Verifier.Verify(ctx, token)               │
                      │  ↓ iterate strategies                     │
                      │   oidc.Verifier.Verify:                   │
                      │     1. jwt.ParseWithClaims(JWKS keys)     │
                      │     2. validateAudience(claims, auds)     │
                      │     3. extract iss / sub                  │
                      │     4. identityLookup.GetUserIdentity     │
                      │        ↓ cache (1min in-memory)           │
                      │        authDB.Write.GetUserIdentity       │
                      │  ↓                                       │
                      │ user_id (uuid.UUID)                       │
                      └─────────────────────────────────────────┘

   ValidateAuthProviderTeam                                          
                      ┌─────────────────────────────────────────┐
                      │ userID ← GetUserID(ginCtx)               │
                      │  ↓                                       │
                      │ cacheKey = userID + "-" + teamID         │
                      │ authCache.GetOrSet(cacheKey, ...)         │
                      │  ↓ cache miss                           │
                      │ store.GetTeamByIDAndUserID(userID, teamID)│
                      │  ↓                                       │
                      │   CheckTeamBanned ← 403 if banned        │
                      │  ↓                                       │
                      │ types.NewTeam(team, limit)               │
                      └─────────────────────────────────────────┘
```

---

## 四、三种凭证的验证生命周期

### 4.1 API Key

入口:`authService.ValidateAPIKey`([`service.go:93`](../../packages/auth/pkg/auth/service.go))。

```go
hashedKey, err := keys.VerifyKey(keys.ApiKeyPrefix, apiKey)
//                              ^^^^^^^^^^^^^^^^ 必须以 "e2b_" 开头
//                                  ↓ hex.DecodeString + SHA-256
```

格式错误 → `APIError{Code: 401, ClientMsg: "Invalid API key format"}`。

格式 OK 后走 `authCache.GetOrSet(hashedKey, cb)`,cb 是 `store.GetTeamByHashedAPIKey`。

DB 查询(`GetTeamWithTierByAPIKey`)join 三张表:`team_api_keys` ⨝ `teams` ⨝ `team_limits`。返回前再走 `CheckTeamBanned`,banned team 抛 `TeamForbiddenError`。

banned 之外的 DB 错误 → 401(注意不是 500,理由:暴露 500 会泄露 DB 状态,401 让客户端以为是凭证问题更安全)。

成功后异步触发(详见 [`auth_store.go:42`](../../packages/auth/pkg/auth/auth_store.go)):

```go
go func() {
    ctx := context.WithoutCancel(ctx)
    s.authDB.Write.UpdateLastTimeUsed(ctx, hashedKey)
}()
```

`WithoutCancel` 是为了**不让请求结束时的 ctx cancel 把这次写入也取消**——`UpdateLastTimeUsed` 不影响响应,可以慢慢写。

最后通过 `telemetry.SetAttributes` 把脱敏后的 API key(`MaskToken`,只露前 2 + 后 4 字符)和 teamID stamp 到 span。

### 4.2 Access Token

入口:`authService.ValidateAccessToken`([`service.go:140`](../../packages/auth/pkg/auth/service.go))。

```go
hashedToken, err := keys.VerifyKey(keys.AccessTokenPrefix, accessToken)
//                                  ^^^^^^^^^^^^^^^^^^^^^^ 必须以 "sk_e2b_" 开头
```

跟 API Key 一样:格式校验 → hash → DB 查 `access_tokens` 表 → 拿到 `user_id`。

**注意两点不同**:

1. **不缓存**。每次请求都查 DB。理由:access token 通常代表"人",数量级远高于 team,缓存收益小但失效风险大(用户 logout 后 token 该立刻失效)。
2. **没有 banned/blocked 检查**。user 没有"被封"的概念;只有 team 才有。blocked 检查发生在拿到 team 之后(handler 层)。

### 4.3 OIDC JWT

入口:`authService.ValidateAuthProviderToken`([`service.go:174`](../../packages/auth/pkg/auth/service.go))。

```go
if s.authProviderVerifier == nil {
    return uuid.UUID{}, &APIError{
        Err:       errors.New("auth provider is not configured"),
        ClientMsg: "Backend authentication failed",
        Code:      http.StatusUnauthorized,
    }
}
```

注意:即便 `feature flag` 关掉了 JWT,这个 error 依然是 **401**,不是 503/501。这是有意的——前端拿到 401 就会引导用户重登,但拿到 5xx 会无限重试。

接着走 `validateJWTWithProvider`:

```go
userID, _, err := v.Verify(ctx, token)
//                    ↓
//                  任一 strategy 成功就返回
```

`userID == uuid.Nil` 也算失败(策略返回了成功但身份表里没这行,意味着 token 有效但用户没被 provision)。

stamp telemetry,完事。

### 4.4 OIDC JWT + Team 组合

dashboard-api 的常见流程:**两步认证**。

1. 第一步:`Authorization: Bearer <jwt>` → `ValidateAuthProviderToken` → 拿到 `user_id`,塞进 ginCtx。
2. 第二步:`X-Team-Id: <uuid>` → `ValidateAuthProviderTeam` → 用 `(user_id, team_id)` 走 `GetTeamByIDAndUserID`,确认这个 user **真的属于这个 team**。

第二步的 cache key 是 `fmt.Sprintf("%s-%s", userID, strings.ToLower(teamID))`(见 [`service.go:276`](../../packages/auth/pkg/auth/service.go)),意味着**同一 user 切换 team 时是不同的 cache entry**——这点很重要,因为 user 在多 team 间切换是 dashboard 的核心流程。

### 4.5 Admin Token

最朴素:在 `adminValidationFunction` 里用 `subtle.ConstantTimeCompare` 比对(见 [`middleware.go:118`](../../packages/auth/pkg/auth/middleware.go)):

```go
if subtle.ConstantTimeCompare([]byte(token), []byte(adminToken)) != 1 {
    return struct{}{}, &APIError{Code: 401, ...}
}
```

**常量时间比较**,防时序攻击。Admin Token 来自服务启动时的配置(`config.AdminToken`),不走 DB,不缓存。

`AdminTeamAuth` 是另一种形态:header 是 `X-Team-ID`,验证函数是 `apiStore.GetTeamFromAdminToken`——意味着 Admin 也得真的有一个 team 才能操作,只是绕开了 user 维度的归属检查。

---

## 五、OIDC JWT 验证深入

### 5.1 单 issuer Verifier 结构

```go
// packages/auth/pkg/auth/oidc/oidc.go:37
type Verifier struct {
    keyfunc       keyfunc.Keyfunc       // JWKS 后端 + 自动刷新
    audiences     []string              // 配置的 aud 白名单
    parserOptions []jwt.ParserOption    // 强制校验 exp、iss
    identities    IdentityLookup        // (iss, sub) → user_id
}
```

### 5.2 启动序列

`NewVerifier`([`oidc.go:54`](../../packages/auth/pkg/auth/oidc/oidc.go))做的事:

1. 检查 `httpClient`、`identities`、`entry.Issuer.URL` 都非空。
2. 算出 `discoveryURL`:优先 `entry.Issuer.DiscoveryURL`,否则 `<issuer URL> + /.well-known/openid-configuration`。
3. `validateHTTPSURL(discoveryURL, ...)` — 必须 https,例外是 loopback host(`localhost` / `127.0.0.1` / `[::1]`,本地开发用)。
4. **同步** fetch discovery document(失败立刻返回错误,服务起不来)。
5. 校验 discovery doc 的 `issuer` 字段必须等于配置的 `entry.Issuer.URL`(防 DNS rebinding / 中间人篡改)。
6. 校验 `jwks_uri` 也是 https。
7. `jwkset.NewStorageFromHTTP(jwks_uri, ...)` — 起 JWKS 后台刷新(`RefreshInterval = entry.CacheDuration`,默认 5min)。
8. `keyfunc.New(...)` — 包一层 jwt 库要的接口。
9. 返回 `*Verifier`,内含 `parserOptions`:`jwt.WithExpirationRequired()` + `jwt.WithIssuer(entry.Issuer.URL)`。

注意第 4 步是**同步**的——服务启动慢一点,但启动完成后所有 JWT 验证都是离线的(只查内存中的 JWKS + DB 身份表)。

### 5.3 验证序列

`Verify`([`oidc.go:118`](../../packages/auth/pkg/auth/oidc/oidc.go)):

```go
token, err := jwt.ParseWithClaims(tokenString, claims,
    func(token *jwt.Token) (any, error) {
        return v.keyfunc.KeyfuncCtx(ctx)(token)  // 从 JWKS 找 kid 对应的公钥
    },
    v.parserOptions...,  // 含 WithExpirationRequired() + WithIssuer(<issuer URL>)
)
```

序列:

1. **解析 + 签名验证**:用 JWKS 里的 RSA 公钥验 RS256 签名。kid 不在 JWKS 时,keyfunc 会触发一次同步 fetch(若后台刷新过期了)。
2. **exp 必须存在**:`WithExpirationRequired`。永久 token 直接拒。
3. **iss 必须等于配置值**:防 token 跨 issuer 重放。
4. **aud 校验**(`validateAudience`):token 的 `aud` claim 与配置 `audiences` 取交集,只要有一个匹配就过。空配置(`audiences == nil`)视为"不校验 aud"。
5. **iss / sub claim 提取**:`claimString` 兼容 `string`、`[]string`、`[]any` 三种 JSON 编码。
6. **身份查询**:`identities.GetUserIdentity(ctx, iss, sub)` — 在 `public.user_identities` 表里 PK 是 `(oidc_iss, oidc_sub)`,这是 O(1) 索引查询。

注意第 6 步的微妙:**JWT 验签通过不等于认证通过**。只有 (iss, sub) 在身份表里有对应行,才能拿到 `user_id`。这意味着:

- 第一次登录的用户即使 token 有效也会被拒 → 上游 `dashboard-api` 必须先做一次 `upsert_public_identity` provision 才能 login。
- 用户被 deactivate 后,直接删 `user_identities` 那行就够了——所有现有 token 立刻失效,即便它们还没到 exp。

### 5.4 audience 策略

`AudienceMatchPolicy` 当前只有 `MatchAny`(空字符串等价于 MatchAny)。语义:**配置的 audiences 中至少有一个出现在 token 的 aud claim 里**。

校验规则(见 [`audience.go:30`](../../packages/auth/pkg/auth/oidc/audience.go)):

- audiences 必须非空。
- 多个 audiences 时,policy 必须是 `MatchAny`(Kubernetes apiserver 的同款规则)。
- 单个 audience 时,policy 可以空或 `MatchAny`。

这套规则是**前向兼容**:留出未来加 `MatchAll` 等策略的空间。

### 5.5 URL 校验细节

OIDC 的 issuer URL 校验抄的是 **Kubernetes apiserver** 的规则([`oidc.go:242`](../../packages/auth/pkg/auth/oidc/oidc.go)):

- 必须 https,例外是 loopback host(本地开发)。
- 不能带 userinfo(`https://user:pass@...` 拒)。
- 不能带 query string。
- 不能带 fragment。
- **故意不 DNS 解析**(防 TOCTOU):只匹配字面 `localhost` / `127.0.0.0/8` / `::1`。

### 5.6 身份查询缓存

`cachingIdentityLookup`([`identity_lookup.go:59`](../../packages/auth/pkg/auth/identity_lookup.go))包了一层 in-memory cache:

```go
const identityCacheTTL = 1 * time.Minute
```

- **只缓存成功结果**。`ErrIdentityNotFound` 和其他错误**不缓存**——理由:新 provision 的用户要能立刻登录,transient DB 错误不该被钉死。
- **singleflight**:`cache.MemoryCache` 内部用 `singleflight.Group` 把并发同 key 的 miss 合并成一次 DB 查询。
- key 用 `iss + "\x00" + sub`,NUL 字节确保无论 iss/sub 里有什么字符,key 都是 unambiguous 的。

---

## 六、双层缓存机制

### 6.1 第一层:Redis(team 数据)

文件:[`cache.go`](../../packages/auth/pkg/auth/cache.go)。

```go
const (
    authInfoExpiration   = 5 * time.Minute  // Redis TTL
    refreshInterval      = 1 * time.Minute  // 后台刷新间隔
    refreshTimeout       = 30 * time.Second // 后台刷新超时
    authCacheRedisPrefix = "auth:team"      // Redis key 前缀
)
```

**模式**:cache-aside + 后台异步刷新 + 分布式锁。

```
请求 ──▶ authCache.GetOrSet(key, cb)
         │
         ├─ Redis GET auth:team:<key>
         │   ├─ hit ──▶ 检查 age:
         │   │           ├─ age < 1min  ──▶ 直接返回(快路径)
         │   │           └─ age ≥ 1min  ──▶ 异步刷新(singleflight + 分布式锁)
         │   │                              ──▶ 同时返回旧值(不阻塞请求)
         │   └─ miss ──▶ 加锁 ──▶ cb() [DB 查询] ──▶ Redis SET
         │                                              └─ 释放锁
         └─
```

**关键设计**:

- **跨 pod 共享**:同一个 team 被多个 api pod 请求时,只命中一个 pod 的 DB 查询,其他 pod 直接读 Redis。
- **后台刷新不阻塞响应**:cache 过 1min 后,请求**立即返回旧数据**,同时 singleflight 在后台刷新——下次请求就能拿到新数据。
- **分布式锁**(可选):`RedisLocker` 防止 N 个 pod 同时 miss 缓存时打 N 次 DB。`LockTTL = RefreshTimeout + 2*RedisTimeout` 自动计算。

### 6.2 第二层:内存(OIDC 身份)

文件:[`identity_lookup.go`](../../packages/auth/pkg/auth/identity_lookup.go)。

OIDC 身份**不进 Redis**,只在本进程内存里:

- TTL 1 分钟(比 team 缓存短,因为身份是敏感数据,用户被 disable 要尽快生效)。
- 只缓存成功结果(见 §5.6)。
- 不分布到其他 pod:每个 pod 各自查一次 DB——但因为有 `singleflight` + 1min TTL,QPS 高时实际每 (pod, iss, sub) 组合每分钟只查一次。

**为什么不分到 Redis?** 主要理由是**安全**:

- 身份缓存意味着"这个 JWT 现在有效",集中到 Redis 后,Redis 故障 / 慢查询会拖垮所有 JWT 验证。
- 内存缓存挂掉只影响一个 pod,其他 pod 不受影响。
- 而且 user_id 是 uuid,缓存值很小,内存占用可以忽略。

### 6.3 缓存失效

`authService` 暴露两个失效方法:

```go
InvalidateTeamMemberCache(ctx, userID, teamID)  // 移除 user-team 维度的 cache
InvalidateTeamCache(ctx, teamID) error           // 移除 teamID + 该 team 所有 API key hash 的 cache
```

`InvalidateTeamCache` 的实现([`service.go:261`](../../packages/auth/pkg/auth/service.go)):

```go
s.teamCache.Invalidate(ctx, teamCacheKey(teamID))  // 删 "team-<uuid>"

hashes, err := s.store.GetTeamAPIKeyHashes(ctx, teamID)  // 拿所有 api key hash
for _, hash := range hashes {
    s.teamCache.Invalidate(ctx, hash)  // 逐个删
}
```

为什么删两遍?因为同一个 team 可能通过多种 key 被访问:

- 通过 `teamID` 直接查(例如 `GetTeamByID` 走的就是 `teamCacheKey(teamID)`,见 [`service.go:134`](../../packages/auth/pkg/auth/service.go))。
- 通过 API Key hash 查(`ValidateAPIKey`)。

只删一个,另一个还会返回旧数据。

> 注意:`ValidateAuthProviderTeam` 走的是另一个 key —— `teamMemberCacheKey(userID, teamID)`,因为它要验证 user-team 成员关系。那个 key 由 `InvalidateTeamMemberCache` 失效,不在 `InvalidateTeamCache` 范围内。

调用方:任何"修改了 team 或它的 api keys"的 handler。例如 team 改名、tier 升降、添加/删除 API Key、用户被加入/移出 team。

---

## 七、OpenAPI 安全方案分发器

### 7.1 Authenticator 接口

```go
// middleware.go:34
type Authenticator interface {
    Authenticate(ctx context.Context, ginCtx *gin.Context,
                 input *openapi3filter.AuthenticationInput) error
    SecuritySchemeName() string
}
```

`oapi-codegen` 生成的 Gin 中间件在每个标注了 `security:` 的端点上,会按 OpenAPI spec 里写的方案名(比如 `ApiKeyAuth`)调用注册的 Authenticator。

### 7.2 commonAuthenticator 模板

`auth` 包用泛型把 6 个 Authenticator 抽象成一个 `commonAuthenticator[T]`:

```go
// middleware.go:40
type commonAuthenticator[T any] struct {
    schemeName     string        // "ApiKeyAuth" 等
    header         headerKey     // {name, prefix, removePrefix}
    validationFunc func(...) (T, *APIError)
    setContextFunc func(*gin.Context, T)  // setTeamInfo / setUserID
    errorMessage   string         // 失败时给前端的提示
}
```

这就是为啥所有 Authenticator 长得几乎一样——它们只是在「header 名 / 前缀 / 验证函数 / context setter」这 4 个维度上有区别。

### 7.3 6 个内置 Authenticator

| 构造函数 | schemeName | header | prefix | 验证函数签名 | setter |
|---------|------------|--------|--------|--------------|--------|
| `NewApiKeyAuthenticator` | `ApiKeyAuth` | `X-API-Key` | `e2b_` | `→ *types.Team` | `setTeamInfo` |
| `NewAccessTokenAuthenticator` | `AccessTokenAuth` | `Authorization` | `sk_e2b_` (strip `Bearer `) | `→ uuid.UUID` | `setUserID` |
| `NewAuthProviderBearerAuthenticator` | `AuthProviderBearerAuth` | `Authorization` (strip `Bearer `) | (无) | `→ uuid.UUID` | `setUserID` |
| `NewAuthProviderTeamAuthenticator` | `AuthProviderTeamAuth` | `X-Team-ID` | (无) | `→ *types.Team` | `setTeamInfo` |
| `NewAdminApiKeyAuthenticator` | `AdminApiKeyAuth` | `X-Admin-Token` | (无) | 内嵌常量比较 | (无) |
| `NewAdminTeamAuthenticator` | `AdminTeamAuth` | `X-Team-ID` | (无) | `→ *types.Team` | `setTeamInfo` |

### 7.4 创建分发函数

```go
// middleware.go:225
func CreateAuthenticationFunc(
    authenticators []Authenticator,
    preAuthHook func(*gin.Context),  // 可选,api 服务不用
) openapi3filter.AuthenticationFunc
```

返回的 `AuthenticationFunc` 被 `oapi-codegen` 中间件调用,逻辑:

1. 取出 ginCtx(`middleware.GetGinContext(ctx)`)。
2. 跑 `preAuthHook`(如果非 nil)。
3. 起 OpenTelemetry span。
4. 按 `input.SecuritySchemeName` 找匹配的 Authenticator。
5. 找不到 → 返回 `fmt.Errorf("invalid security scheme name '%s'", ...)`(配置错误,500)。
6. 找到 → 调 `Authenticate`,处理结果。

### 7.5 Authenticate 的工作流

```go
// middleware.go:67
func (a *commonAuthenticator[T]) Authenticate(...) error {
    key, err := a.getHeaderKeysFromRequest(req)  // 提取 header
    if err != nil {
        // 没头 / 头格式错 → 立刻 stamp 401
        ginCtx.Status(http.StatusUnauthorized)
        return err
    }
    
    result, validationError := a.validationFunc(ctx, ginCtx, key)
    if validationError != nil {
        // 业务验证失败(401 / 403 都可能)
        ginCtx.Status(validationError.Code)
        // 关键!如果是 TeamForbiddenError,直接透传 err
        var forbiddenError *TeamForbiddenError
        if errors.As(validationError.Err, &forbiddenError) {
            return validationError.Err
        }
        // 否则拼装一个用户友好的 message
        return fmt.Errorf("%s\n%s", a.errorMessage, validationError.ClientMsg)
    }
    
    if a.setContextFunc != nil {
        a.setContextFunc(ginCtx, result)  // 把 team/userID 塞进 ginCtx
    }
    return nil
}
```

**为什么要 `ginCtx.Status(401)`?** 注释里写得很清楚:

> stamp 401 so the ErrorHandler's max(writer, 400) resolves to 401 when every security group fails. without this, auth failures become 400s.

OpenAPI 的 security 可以是 `[[schemeA, schemeB], [schemeC]]` 这种嵌套数组,意思是 "schemeA 或 schemeB 满足,或者 schemeC 满足"。oapi-codegen 的 ErrorHandler 取所有失败 code 的最大值。如果这里不 stamp 401,默认就是 400(BadRequest),用户拿到的就是 400 而不是 401——很迷惑。所以**显式 stamp 401 让 max() 取到 401**。

---

## 八、Team 状态:banned vs blocked

### 8.1 两种状态对比

| 维度 | banned | blocked |
|------|--------|---------|
| 字段 | `teams.is_banned` | `teams.is_blocked` + `teams.blocked_reason` |
| 错误类型 | `*TeamForbiddenError` | `*TeamBlockedError` |
| 检查位置 | `authStoreImpl` 内(每次查询都过) | `EnforceBlockedTeam` 中间件(handler 入口) |
| 检查时机 | 早(store 层) | 晚(auth 已通过、handler 之前) |
| 是否有白名单 | 否 | 是(`BlockedTeamAllowlist`) |
| HTTP | 403 | 403 |
| 典型场景 | 永久封禁(欺诈、违规) | 临时封禁(欠费、额度耗尽) |

### 8.2 banned 在哪查

`CheckTeamBanned`([`team_state.go:13`](../../packages/auth/pkg/auth/team_state.go))在 `authStoreImpl` 的每个查询里都被调用:

```go
// auth_store.go:38 (GetTeamByHashedAPIKey 内)
if err := CheckTeamBanned(result.Team); err != nil {
    return nil, err  // banned → 直接抛 TeamForbiddenError
}
```

这意味着:**banned team 的 API Key / teamID 在 store 层就过不去**,任何调用 `ValidateAPIKey`、`GetTeamByID`、`ValidateAuthProviderTeam` 的入口都会拿到 `TeamForbiddenError`。然后 `ValidateAPIKey` 把它包成 `APIError{Code: 403}`(`service.go:108`)。

设计意图:banned 是终态,不需要例外——任何路径都不该让 banned team 通过。

### 8.3 blocked 在哪查

`CheckTeamBlocked`([`team_state.go:28`](../../packages/auth/pkg/auth/team_state.go))**不在 store 里调**,而是一个公开 API,handler 或中间件自己决定要不要查。

```go
func CheckTeamBlocked(team *types.Team) error {
    if team == nil || team.Team == nil || !team.IsBlocked {
        return nil
    }
    msg := "team is blocked"
    if team.BlockedReason != nil && *team.BlockedReason != "" {
        msg = fmt.Sprintf("%s: %s", msg, *team.BlockedReason)
    }
    return &TeamBlockedError{Message: msg}
}
```

注意它接 `*types.Team`(指针),允许 nil:`admin / access-token` 路径上没有 team,这个函数直接返回 nil,noop。这样 handler 可以无脑调用。

### 8.4 EnforceBlockedTeam 中间件

```go
// team_middleware.go:59
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

逻辑:

1. 从 ginCtx 取 team(没 team 就放行,因为可能这路由不需要 team)。
2. `CheckBlockedTeamForRoute`:blocked + 不在白名单 → 错误。
3. 有错 → 403 + abort。

### 8.5 BlockedTeamAllowlist

```go
// team_middleware.go:14
type BlockedTeamAllowlist map[string]map[string]struct{}
//                    key=HTTP method    key=gin route pattern(c.FullPath())
```

例如 dashboard-api 的白名单(伪代码):

```go
blockedTeamAllowlist := auth.BlockedTeamAllowlist{
    http.MethodGet: {
        "/api/teams":                  {}, // 看自己的 team 列表
        "/api/teams/{teamID}":         {}, // 看 team 详情(才能看到 blocked_reason)
        "/api/billing":                {}, // 看账单(去缴费)
    },
    http.MethodPost: {
        "/api/teams/{teamID}/upgrade": {}, // 升级 tier
    },
}
```

设计意图:blocked team **能登录、能看自己、能缴费**,但不能新建 sandbox / build template。

### 8.6 `CheckTeamAccess`(handler 主动检查)

```go
// team_middleware.go:45
func CheckTeamAccess(c *gin.Context, team *types.Team, allowlist BlockedTeamAllowlist) error
```

这是给"不开 `EnforceBlockedTeam` 中间件,但在某个 handler 里要主动检查"的场景用的(api 服务大多走这个模式,因为不是所有路由都需要 blocked 检查)。

---

## 九、数据模型

### 9.1 涉及的表

| 表 | 主要字段 | 用途 |
|----|---------|------|
| `public.teams` | `id, name, tier, is_banned, is_blocked, blocked_reason, slug, cluster_id` | team 主表 |
| `public.team_api_keys` | `team_id, api_key_hash, api_key_prefix, last_used` | API Key 存储 |
| `public.access_tokens` | `user_id, access_token_hash, created_at` | Access Token 存储 |
| `public.users_teams` | `user_id, team_id, is_default` | user-team 多对多 |
| `public.team_limits` | `id, concurrent_sandboxes, max_vcpu, max_ram_mb, ...` | team 配额 |
| `public.user_identities` | `oidc_iss, oidc_sub, user_id` | OIDC 身份映射 |

### 9.2 sqlc 查询

文件 [`packages/db/pkg/auth/sql_queries/teams/get_team.sql`](../../packages/db/pkg/auth/sql_queries/teams/get_team.sql):

```sql
-- name: GetTeamWithTierByAPIKey :one
SELECT sqlc.embed(t), sqlc.embed(tl)
FROM "public"."team_api_keys" tak
JOIN "public"."teams" t ON tak.team_id = t.id
JOIN "public"."team_limits" tl on tl.id = t.id
WHERE tak.team_id = t.id
  AND tak.api_key_hash = $1;

-- name: GetTeamWithTierByTeamAndUser :one
SELECT sqlc.embed(t), sqlc.embed(tl)
FROM "public"."teams" t
JOIN "public"."users_teams" ut ON ut.team_id = t.id
JOIN "public"."team_limits" tl on tl.id = t.id
WHERE ut.user_id = $1 AND t.id = $2;

-- name: GetTeamWithTierByTeamID :one
SELECT sqlc.embed(t), sqlc.embed(tl)
FROM "public"."teams" t
JOIN "public"."team_limits" tl on tl.id = t.id
WHERE t.id = $1;
```

注意三个查询都 join `team_limits`——理由:每次验证都把 limits 一起带回来,handler 直接 `team.Limits.MaxVcpu` 拿到配额,避免再查一次 DB。

### 9.3 user_identities 表

```sql
CREATE TABLE public.user_identities (
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    oidc_iss text NOT NULL,
    oidc_sub text NOT NULL,
    user_id uuid NOT NULL,
    PRIMARY KEY (oidc_iss, oidc_sub),
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
```

PK 是 `(oidc_iss, oidc_sub)`——OIDC 标准:issuer + subject 全局唯一标识一个用户。

### 9.4 Client 读写分离

文件 [`packages/db/pkg/auth/client.go`](../../packages/db/pkg/auth/client.go):

```go
type Client struct {
    Read      *authqueries.Queries  // 走 read replica
    Write     *authqueries.Queries  // 走 primary
    writeConn *pgxpool.Pool
    readConn  *pgxpool.Pool
}
```

`NewClient(ctx, databaseURL, replicaURL, ...)`:

- 总是建 primary 连接池。
- 如果 `replicaURL != ""`,再建一个 replica 连接池,`Read` 走它。
- 如果没传 replicaURL,`Read` 就是 primary(`readPool := writePool`)。

`authStoreImpl` 里的所有"读"走 `s.authDB.Read.*`,而 `UpdateLastTimeUsed` 走 `s.authDB.Write.*`——这个区分是为了:

- 读多写少,replica 水平扩展容易。
- 写走 primary,避免 replication lag 导致"刚改的 team 配置查不到"。

---

## 十、典型时序图

### 10.1 API Key 验证(api 服务)

```
SDK                      api(Gin)                authService              Redis              PostgreSQL
 │                          │                         │                      │                     │
 │─ POST /sandboxes         │                         │                      │                     │
 │  X-API-Key: e2b_xxxx     │                         │                      │                     │
 │─────────────────────────▶│                         │                      │                     │
 │                          │                         │                      │                     │
 │                          │ oapi-codegen middleware │                      │                     │
 │                          │   找 ApiKeyAuth handler │                      │                     │
 │                          │─ Authenticate ─────────▶│                      │                     │
 │                          │                         │                      │                     │
 │                          │                         │ keys.VerifyKey(...)  │                     │
 │                          │                         │ → hash               │                     │
 │                          │                         │                      │                     │
 │                          │                         │─ GET auth:team:hash ─▶│                     │
 │                          │                         │◀──── miss ───────────│                     │
 │                          │                         │                      │                     │
 │                          │                         │─ GetTeamWithTierByAPIKey ─────────────────▶│
 │                          │                         │◀────── team + limits ─────────────────────│
 │                          │                         │                      │                     │
 │                          │                         │ CheckTeamBanned      │                     │
 │                          │                         │                      │                     │
 │                          │                         │─ SET auth:team:hash ─▶│                     │
 │                          │                         │   (TTL 5min)         │                     │
 │                          │                         │                      │                     │
 │                          │                         │ go UpdateLastTimeUsed (async, Write pool)─▶│
 │                          │                         │                      │                     │
 │                          │                         │ setTeamInfo(ginCtx)  │                     │
 │                          │◀──────── nil (ok) ──────│                      │                     │
 │                          │                         │                      │                     │
 │                          │ handler runs (ginCtx has team)                 │                     │
 │◀──── 200 + body ─────────│                         │                      │                     │
```

### 10.2 OIDC JWT 验证(dashboard-api,首次登录)

```
User                dashboard-api              auth.Verifier           OIDC issuer          PostgreSQL
 │                       │                          │                       │                     │
 │─ POST /api/x          │                          │                       │                     │
 │  Authorization: Bearer <jwt>                     │                       │                     │
 │  X-Team-Id: <uuid>    │                          │                       │                     │
 │──────────────────────▶│                          │                       │                     │
 │                       │                          │                       │                     │
 │                       │ step 1: AuthProviderBearerAuth                  │                     │
 │                       │─ ValidateAuthProviderToken ─────▶│               │                     │
 │                       │                          │ jwt.ParseWithClaims  │                     │
 │                       │                          │   用 JWKS(已缓存)   │                     │
 │                       │                          │ aud / iss / exp OK   │                     │
 │                       │                          │                       │                     │
 │                       │                          │ identityLookup       │                     │
 │                       │                          │   (iss, sub) ──────────────────────────────▶│
 │                       │                          │◀────── user_id ────────────────────────────│
 │                       │                          │                       │                     │
 │                       │                          │ setUserID(ginCtx)    │                     │
 │                       │◀──────── user_id ────────│                       │                     │
 │                       │                          │                       │                     │
 │                       │ step 2: AuthProviderTeamAuth                     │                     │
 │                       │─ ValidateAuthProviderTeam ──────▶│               │                     │
 │                       │                          │ GetUserID(ginCtx)    │                     │
 │                       │                          │   → user_id           │                     │
 │                       │                          │                       │                     │
 │                       │                          │ authCache.GetOrSet   │                     │
 │                       │                          │   key=user_id-team_id │                     │
 │                       │                          │─ GET ────────────────▶│                     │
 │                       │                          │◀──── miss ───────────│                     │
 │                       │                          │                       │                     │
 │                       │                          │ GetTeamByIDAndUserID ─────────────────────▶│
 │                       │                          │◀──── team + limits ────────────────────────│
 │                       │                          │                       │                     │
 │                       │                          │ CheckTeamBanned      │                     │
 │                       │                          │                       │                     │
 │                       │                          │ setTeamInfo           │                     │
 │                       │◀───────── team ──────────│                       │                     │
 │                       │                          │                       │                     │
 │                       │ EnforceBlockedTeam       │                       │                     │
 │                       │   team not blocked → pass│                       │                     │
 │                       │                          │                       │                     │
 │                       │ handler runs             │                       │                     │
 │◀──── 200 ─────────────│                          │                       │                     │
```

### 10.3 banned team 拒绝路径

```
SDK                      api                      authService              store
 │                       │                          │                       │
 │─ POST /sandboxes      │                          │                       │
 │  X-API-Key: e2b_xxxx  │                          │                       │
 │──────────────────────▶│                          │                       │
 │                       │─ Authenticate ──────────▶│                       │
 │                       │                          │─ GetTeamByHashedAPIKey─▶│
 │                       │                          │                       │
 │                       │                          │                       │ CheckTeamBanned
 │                       │                          │                       │   team.is_banned=true
 │                       │                          │◀──── *TeamForbiddenError │
 │                       │                          │                       │
 │                       │                          │ wrap → APIError{403} │
 │                       │◀──────── err ────────────│                       │
 │                       │                          │                       │
 │                       │ ginCtx.Status(403)       │                       │
 │◀──── 403 Forbidden ───│                          │                       │
```

---

## 十一、配置与 Feature Flag

### 11.1 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `AUTH_PROVIDER_CONFIG` | (空) | OIDC 配置 JSON,空 / `null` 时 JWT 验证被禁用 |
| `ADMIN_TOKEN` | (必填) | admin 接口的 token |
| `POSTGRES_CONNECTION_STRING` | (必填) | primary PostgreSQL DSN |
| `AUTH_DB_READ_REPLICA_CONNECTION_STRING` | (空) | auth DB read replica DSN,空时 Read 走 primary |
| `REDIS_URL` | (必填) | team cache 用(也支持 `REDIS_CLUSTER_URL` / `REDIS_TLS_CA_BASE64`) |

### 11.2 AUTH_PROVIDER_CONFIG 示例

最简(单 issuer):

```json
{
  "jwt": [
    {
      "issuer": {
        "url": "https://auth.e2b.dev",
        "audiences": ["e2b-dashboard"]
      }
    }
  ]
}
```

完整(显式 discovery、自定义 cache、多 issuer):

```json
{
  "jwt": [
    {
      "issuer": {
        "url": "https://auth.e2b.dev",
        "discoveryURL": "https://auth.e2b.dev/.well-known/openid-configuration",
        "audiences": ["e2b-dashboard", "e2b-cli"],
        "audienceMatchPolicy": "MatchAny"
      },
      "cacheDuration": "10m"
    },
    {
      "issuer": {
        "url": "https://auth.staging.e2b.dev",
        "audiences": ["e2b-dashboard-staging"]
      },
      "cacheDuration": "5m"
    }
  ]
}
```

### 11.3 Feature Flag 行为矩阵

| `AUTH_PROVIDER_CONFIG` | `NewVerifier` 返回 | `ValidateAuthProviderToken` 行为 |
|------------------------|---------------------|----------------------------------|
| 空 / `"null"` / unset | `(nil, nil)` | 总是 401 "auth provider is not configured" |
| 单 issuer | `(*Verifier, nil)` | 正常验证 |
| 多 issuer | `(*Verifier, nil)` | 顺序尝试,任一通过即可 |
| JSON 解析失败 | `(nil, err)` | 服务起不来 |

### 11.4 cache 参数

| 常量 | 值 | 位置 |
|------|-----|------|
| `authInfoExpiration` | 5 分钟 | Redis TTL(team cache) |
| `refreshInterval` | 1 分钟 | 后台刷新间隔 |
| `refreshTimeout` | 30 秒 | 单次刷新超时 |
| `identityCacheTTL` | 1 分钟 | 内存 TTL(OIDC 身份) |
| `defaultCacheDuration`(OIDC) | 5 分钟 | JWKS 后台刷新默认间隔 |
| `oidcHTTPTimeout` | 10 秒 | discovery / JWKS HTTP 超时 |

---

## 十二、关键代码文件索引

> 所有路径相对仓库根。

### 12.1 packages/auth/pkg/auth

| 文件 | 行数 | 主要 export |
|------|------|------------|
| [`service.go`](../../packages/auth/pkg/auth/service.go) | 287 | `Service`、`authService`、`NewAuthService`、`ValidateAPIKey`、`ValidateAccessToken`、`ValidateAuthProviderToken`、`ValidateAuthProviderTeam`、`GetTeamByID`、`InvalidateTeamCache`、`InvalidateTeamMemberCache` |
| [`middleware.go`](../../packages/auth/pkg/auth/middleware.go) | 248 | `Authenticator`、`commonAuthenticator`、`NewApiKeyAuthenticator`、`NewAccessTokenAuthenticator`、`NewAuthProviderBearerAuthenticator`、`NewAuthProviderTeamAuthenticator`、`NewAdminApiKeyAuthenticator`、`NewAdminTeamAuthenticator`、`CreateAuthenticationFunc` |
| [`verifier.go`](../../packages/auth/pkg/auth/verifier.go) | 125 | `ProviderConfig`、`Verifier`、`NewVerifier`、`Verifier.Verify` |
| [`auth_store.go`](../../packages/auth/pkg/auth/auth_store.go) | 106 | `authStore`、`authStoreImpl`、`newAuthStore` |
| [`identity_lookup.go`](../../packages/auth/pkg/auth/identity_lookup.go) | 84 | `identityCacheTTL`、`authIdentityLookup`、`cachingIdentityLookup`、`newAuthIdentityLookup` |
| [`team_middleware.go`](../../packages/auth/pkg/auth/team_middleware.go) | 77 | `BlockedTeamAllowlist`、`CheckBlockedTeamForRoute`、`CheckTeamAccess`、`EnforceBlockedTeam` |
| [`gin.go`](../../packages/auth/pkg/auth/gin.go) | 68 | `setUserID`、`GetUserID`、`MustGetUserID`、`setTeamInfo`、`GetTeamInfo`、`MustGetTeamInfo`、`MustGetTeamID` |
| [`cache.go`](../../packages/auth/pkg/auth/cache.go) | 52 | `authInfoExpiration`、`refreshInterval`、`refreshTimeout`、`authCacheRedisPrefix`、`authCache`、`newAuthCache` |
| [`team_state.go`](../../packages/auth/pkg/auth/team_state.go) | 39 | `CheckTeamBanned`、`CheckTeamBlocked` |
| [`error.go`](../../packages/auth/pkg/auth/error.go) | 24 | `APIError`、`TeamForbiddenError`、`TeamBlockedError` |
| [`provider_config_parse.go`](../../packages/auth/pkg/auth/provider_config_parse.go) | 25 | `ParseProviderConfig` |
| [`consts.go`](../../packages/auth/pkg/auth/consts.go) | 14 | `HeaderAPIKey`、`HeaderAuthorization`、`HeaderTeamID`、`HeaderAdminToken`、`PrefixAPIKey`、`PrefixAccessToken`、`PrefixBearer` |
| [`testing.go`](../../packages/auth/pkg/auth/testing.go) | 24 | `SetUserIDForTest`、`SetTeamInfoForTest` |

### 12.2 packages/auth/pkg/auth/oidc

| 文件 | 行数 | 主要 export |
|------|------|------------|
| [`oidc.go`](../../packages/auth/pkg/auth/oidc/oidc.go) | 310 | `ErrIdentityNotFound`、`IdentityLookup`、`Verifier`、`NewVerifier`、`Verify`、`validateURL`、`isLoopbackHost` |
| [`config.go`](../../packages/auth/pkg/auth/oidc/config.go) | 98 | `Config`、`Issuer`、`defaultCacheDuration`、`defaultDiscoveryPath`、`Normalized`、`Validate` |
| [`audience.go`](../../packages/auth/pkg/auth/oidc/audience.go) | 104 | `AudienceMatchPolicy`、`AudienceMatchAny`、`validateAudience`、`extractAudiences` |
| [`testserver.go`](../../packages/auth/pkg/auth/oidc/testserver.go) | 52 | `NewTestServer`(测试用 TLS OIDC mock) |

### 12.3 packages/auth/pkg/types

| 文件 | 行数 | 主要 export |
|------|------|------------|
| [`teams.go`](../../packages/auth/pkg/types/teams.go) | 45 | `Team`、`TeamID()`、`NewTeam`、`TeamWithDefault` |
| [`limits.go`](../../packages/auth/pkg/types/limits.go) | 13 | `TeamLimits`(7 个配额字段) |

### 12.4 packages/auth/pkg/tests

| 文件 | 行数 | 主要 export |
|------|------|------------|
| [`sign_token.go`](../../packages/auth/pkg/tests/sign_token.go) | 27 | `SignTestToken`(HS256 测试 token) |

### 12.5 调用方

| 文件 | 用法 |
|------|------|
| [`packages/api/main.go:189`](../../packages/api/main.go) | `CreateAuthenticationFunc` 注册 6 个 Authenticator |
| [`packages/api/internal/handlers/store.go:232`](../../packages/api/internal/handlers/store.go) | `NewAuthService(...)` 装配 |
| [`packages/api/internal/cfg/model.go:105`](../../packages/api/internal/cfg/model.go) | `AuthProvider auth.ProviderConfig env:"AUTH_PROVIDER_CONFIG"` |
| [`packages/dashboard-api/main.go:191-243`](../../packages/dashboard-api/main.go) | 装配 authService + 3 个 Authenticator + `EnforceBlockedTeam` |
| [`packages/dashboard-api/internal/middleware/blocked_team.go:34`](../../packages/dashboard-api/internal/middleware/blocked_team.go) | 包装 `auth.EnforceBlockedTeam(blockedTeamAllowlist)` |

---

## 十三、设计要点与权衡

### 13.1 为什么 team 缓存走 Redis,身份缓存不走?

| 维度 | team cache (Redis) | identity cache (内存) |
|------|-------------------|----------------------|
| 数据大小 | 中(team + limits,几百字节) | 小(一个 uuid) |
| 共享需求 | 高(所有 pod 都查 team) | 低(每个 pod 独立查能接受) |
| 失效复杂度 | 高(api key 变更要广播到所有 pod) | 低(user 被禁,1min 自动过期) |
| 故障影响面 | Redis 挂 → 所有 pod 同时回退到 DB(可接受) | 内存缓存挂只影响本 pod |
| 缓存值敏感度 | 低(就是配置数据) | 高(身份是否有效) |

身份缓存留在内存,故意不引入 Redis 依赖:Redis 出问题时,JWT 验证还能靠 DB + JWKS 独立工作,降级路径更短。

### 13.2 为什么身份查询走 Write 池?

`newAuthIdentityLookup(authDB.Write)` 而不是 `authDB.Read`——理由:**OIDC bootstrap 的复制时延赛跑**。

典型场景:

1. 用户第一次登录 → dashboard-api 调 `upsert_public_identity` 在 primary 写一行。
2. dashboard-api 紧接着用同一个 JWT 调 api 服务。
3. api 服务的 `ValidateAuthProviderToken` 查 `user_identities`。

如果第 3 步走 read replica,而 replica 还没同步过来(典型 lag 100ms-1s),用户就拿不到 user_id,401。这会让"第一次登录"几乎必然失败。

**强制走 Write 池**:绕开 replication lag。

### 13.3 为什么 UpdateLastTimeUsed 是异步?

`authStoreImpl.GetTeamByHashedAPIKey` 里(见 [`auth_store.go:42`](../../packages/auth/pkg/auth/auth_store.go)):

```go
go func() {
    ctx := context.WithoutCancel(ctx)
    updateErr := s.authDB.Write.UpdateLastTimeUsed(ctx, hashedKey)
}()
```

理由:

- `last_time_used` 是给运营/审计看的,不影响响应。
- 写 primary 会增加 5-50ms 延迟,API Key 验证是热路径(每个请求都过),累加起来很可观。
- `WithoutCancel`:即便 client 断开连接,异步 goroutine 也能把这次写入完成——避免"用户重试 N 次,DB 永远记不下最后一次时间"。

代价:服务关闭时可能丢失最近几秒的 update。但 `last_time_used` 不要求强一致,这个权衡是划算。

### 13.4 为什么 banned 在 store 层,blocked 在中间件?

- **banned**:终态,任何路径都不能通过,包括 admin 查询。store 层是最深的、最不可避免的层——放这里保证"零遗漏"。
- **blocked**:有白名单(登录、缴费、看自己),需要在路由维度区分。store 层做不到(它不知道当前请求是哪个路由),所以必须放在能拿到 ginCtx 的中间件层。

代价:如果某个 handler 直接用 `apiStore.GetTeamByID(ctx, teamID)` 拿 team,然后忘了走 blocked 检查,blocked team 就能绕过——但这种情况很罕见,因为 blocked 检查是 handler 模板的一部分。

### 13.5 为什么 Verifier 是聚合器而不是单实例?

`Verifier.strategies []strategy` 而不是 `strategy`——理由:**多 OIDC issuer 平滑迁移**。

迁移场景:从 Auth0 切到 Ory。如果只支持单 issuer,切换需要"停服 → 改配置 → 重启"——所有现有 token 立刻失效。多 issuer 支持:

```
Phase 1: 配置 [Auth0]
Phase 2: 配置 [Auth0, Ory] ← 老 token 还能用,新 token 也能用
Phase 3: 等 Auth0 token 自然过期
Phase 4: 配置 [Ory]
```

零停服迁移。

### 13.6 为什么常量时间比较 admin token?

```go
subtle.ConstantTimeCompare([]byte(token), []byte(adminToken))
```

理由:防时序攻击。如果用 `==`,攻击者可以通过测量响应时间逐字节猜 admin token(每猜对一字节,响应慢几纳秒)。`subtle.ConstantTimeCompare` 总是用同样时间返回。

API Key / Access Token 不需要这个,因为它们的"原值"有 20 字节随机(hex 编码 40 字符),即便有时序差,猜中也得 2^160 次尝试——远超算力。Admin token 是人工配置的,可能短或弱,所以走常量时间。

### 13.7 为什么 ValidateAccessToken 不缓存?

`ValidateAccessToken` 每次都查 DB([`service.go:150`](../../packages/auth/pkg/auth/service.go)),不像 `ValidateAPIKey` 走 Redis。理由:

- Access token 数量级远高于 team(每个 user 多个 token,每个 team 多个 user)。
- Access token 通常代表"人",失效要求高:用户 logout / 改密码 / token revoke 后,要立刻失效。Redis 缓存的 5min TTL 太长,会让被撤销的 token 仍然有效 5 分钟。
- API Key 是 CI / 长期凭据,失效频率低,缓存收益大。

如果未来 access token 也需要缓存,可以加 30 秒级别的短 TTL cache,但目前 QPS 还没到必须优化的程度。

### 13.8 为什么 cache key 用 `userID-teamID` 而不是 `teamID`?

`ValidateAuthProviderTeam` 的 cache key:

```go
cacheKey := teamMemberCacheKey(userID, teamID)
//          = fmt.Sprintf("%s-%s", userID, strings.ToLower(teamID))
```

理由:**通过 (userID, teamID) join 查询**(`GetTeamByIDAndUserID`),不只是 teamID。这个查询验证 user 是 team 的成员。如果只缓存 teamID,就丢了"成员关系"——加 user 进 team 后,缓存还会返回"非成员"的旧值。

`InvalidateTeamMemberCache(userID, teamID)` 在成员关系变更时被调用,精确失效这一行。

---

## 十四、常见问题与排查

### Q1: 用户用 OIDC 登录,但拿到 401 "Backend authentication failed"

**排查清单**:

1. **`AUTH_PROVIDER_CONFIG` 是否配置**?空 / `null` 会禁用 JWT。
2. **discovery doc 能拉到吗**?服务启动时会同步拉,启动失败日志里会有 `fetch OIDC discovery document`。
3. **JWKS 能拉到吗**?同上,启动日志会有 `create OIDC JWKS storage`。
4. **`iss` claim 是否等于配置的 `issuer.url`**?JWT 解码后看 payload。
5. **`aud` claim 是否在配置的 `audiences` 里**?`audiences` 空配置才不校验。
6. **(iss, sub) 在 `user_identities` 表里吗**?dashboard-api 是否完成了 provision?

### Q2: banned team 调 API 拿到 403 "team is banned"

这是预期行为。如果想解封:

```sql
UPDATE public.teams SET is_banned = FALSE WHERE id = '...';
```

注意:解封后要等 5 分钟(team cache TTL)或者主动调 `InvalidateTeamCache`。

### Q3: blocked team 拿到 403 "team is blocked: <reason>"

`blocked_reason` 字段会出现在错误消息里,直接展示给用户。如果想允许某条路由被 blocked team 访问,加到 `BlockedTeamAllowlist`。

### Q4: 服务启动失败 "fetch OIDC discovery document"

**典型原因**:

- issuer URL 错误(404)。
- 网络/DNS 不通。
- 自签证书(测试环境)→ 配置 `httpClient` 信任证书,或者用 `discoveryURL` 指向本地 mirror。
- issuer URL 不是 https(且不是 loopback)→ `validateHTTPSURL` 拒绝。

### Q5: `Verifier.Verify` 慢

**根因**:JWKS 没缓存住,每次都拉。

排查:

- 检查 `cacheDuration` 是否设得太短。
- 检查 OIDC issuer 的 `Cache-Control` header。
- keyfunc 内部 cache miss 会同步 fetch,看日志是否有频繁的 JWKS HTTP 请求。

### Q6: API Key 缓存失效后没立刻生效

**根因**:`InvalidateTeamCache` 只删当前 pod 的 Redis cache,但其他 pod 的 in-memory identity cache 不受影响。

不对——team cache 在 Redis,不在内存。失效后下一次请求 force miss Redis → DB。所以这个问题应该是 Redis TTL 还没到,或者 `InvalidateTeamCache` 没被调用。

排查:

- 看代码:`Update*` handler 是否调了 `InvalidateTeamCache`?
- Redis 里手动 `DEL auth:team:<teamID>` 和 `DEL auth:team:<hash>`(多个 hash)。
- 等 5 分钟自然过期。

### Q7: 多个 OIDC issuer 时,哪个 strategy 先跑?

`NewVerifier` 里:

```go
for i, entry := range normalized.JWT {
    s, err := oidc.NewVerifier(...)
    strategies = append(strategies, s)
}
```

`Verify` 按配置顺序迭代。所以配置数组里的顺序就是优先级。如果两个 issuer 都能验同一个 token(罕见),排前面的胜出。

### Q8: Access Token 通过但 API Key 不行(或反之)

这是不同 team 的 banned/blocked 状态。检查 `public.teams.is_banned` / `is_blocked`。

### Q9: dashboard-api 能登但 api 服务不能调

dashboard-api 用 `AuthProviderBearerAuth` + `AuthProviderTeamAuth`,api 服务用 6 个 Authenticator。检查 api 服务的请求 header:

- `X-API-Key` 还是 `Authorization: Bearer ...`?
- Bearer 是 `sk_e2b_...` 还是 JWT?
- 走 JWT 时有没有同时带 `X-Team-Id`?

### Q10: 如何本地测试 OIDC?

`oidc/testserver.go` 的 `NewTestServer` 启动一个 TLS mock OIDC 服务:

```go
server := oidc.NewTestServer(t, publicKey, keyID, "https://test-issuer")
// 配置 AUTH_PROVIDER_CONFIG 指向 server.URL
// 用 SignTestToken(t, secret, "user-sub") 生成 JWT
```

注意 `discoveryIssuer` 参数可以和 `server.URL` 不同——用来测 issuer 与 discovery URL 不一致的场景。

---

## 附录 A:认证方案速查表

### A.1 Header 与凭证映射

| 方案 | 必填 header | 凭证示例 | 前缀 | 谁用 |
|------|------------|---------|------|------|
| `ApiKeyAuth` | `X-API-Key` | `e2b_xxxx...` | `e2b_` | SDK / CI |
| `AccessTokenAuth` | `Authorization` | `Bearer sk_e2b_xxxx...` | `sk_e2b_` (strip `Bearer `) | SDK 登录后 |
| `AuthProviderBearerAuth` | `Authorization` | `Bearer <jwt>` | (无) | dashboard-api |
| `AuthProviderTeamAuth` | `X-Team-ID` | `<team-uuid>` | (无) | dashboard-api(配合 Bearer) |
| `AdminApiKeyAuth` | `X-Admin-Token` | `<configured>` | (无) | E2B 运维 |
| `AdminTeamAuth` | `X-Team-ID` | `<team-uuid>` | (无) | E2B 运维(代某 team) |

### A.2 OpenAPI spec 示例

```yaml
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
    AccessTokenAuth:
      type: http
      scheme: bearer
      bearerFormat: sk_e2b_
    AuthProviderBearerAuth:
      type: http
      scheme: bearer
    AuthProviderTeamAuth:
      type: apiKey
      in: header
      name: X-Team-Id
    AdminApiKeyAuth:
      type: apiKey
      in: header
      name: X-Admin-Token
    AdminTeamAuth:
      type: apiKey
      in: header
      name: X-Team-Id

paths:
  /sandboxes:
    post:
      security:
        - ApiKeyAuth: []
        - AccessTokenAuth: []
        - AuthProviderBearerAuth: []
          AuthProviderTeamAuth: []
```

### A.3 安全组语义

OpenAPI 的 `security` 字段是嵌套数组:

```yaml
security:
  - A: []
  - B: []
    C: []
```

意思是 "A 满足,或者 (B 和 C 都满足)"。`oapi-codegen` 中间件会依次尝试每组,任一组完整通过就放行;都失败时取所有失败 code 的 max。

---

## 附录 B:错误码与 HTTP 状态映射

| 场景 | 错误类型 | HTTP | ClientMsg |
|------|---------|------|-----------|
| header 缺失 | `ErrNoAuthHeader` | 401 | (透传) |
| header 前缀错 | `ErrInvalidAuthHeader` | 401 | (透传) |
| API Key 格式错 | `APIError{401}` | 401 | Invalid API key format |
| API Key DB 查不到 | `APIError{401}` | 401 | Cannot get the team for the given API key |
| Access Token 格式错 | `APIError{401}` | 401 | Invalid access token format |
| Access Token DB 查不到 | `APIError{401}` | 401 | Cannot get the user for the given access token |
| JWT 配置关闭 | `APIError{401}` | 401 | Backend authentication failed |
| JWT 验签失败 | `APIError{401}` | 401 | Backend authentication failed |
| JWT aud 不匹配 | `APIError{401}` | 401 | Backend authentication failed |
| JWT 身份表无对应行 | `APIError{401}` | 401 | Backend authentication failed |
| team banned | `APIError{403}` | 403 | team is banned |
| team blocked(在中间件) | `TeamBlockedError` | 403 | team is blocked: <reason> |
| team blocked(handler 主动检查) | `TeamBlockedError` | 403 | team is blocked: <reason> |
| Admin token 错 | `APIError{401}` | 401 | Invalid Access token. |
| ginCtx 没 user_id(配置错误) | `APIError{500}` | 500 | Backend authentication failed |
| 配置错误的 scheme | `fmt.Errorf` | 500(默认) | invalid security scheme name |

---

## 附录 C:术语表

| 术语 | 含义 |
|------|------|
| **API Key** | 长期凭据,`e2b_` 前缀,代表 team,存 `team_api_keys` |
| **Access Token** | 用户凭据,`sk_e2b_` 前缀,代表 user,存 `access_tokens` |
| **OIDC** | OpenID Connect,基于 OAuth 2.0 的身份层 |
| **JWT** | JSON Web Token,自包含的 token 格式 |
| **JWKS** | JSON Web Key Set,OIDC issuer 公开的公钥集合 |
| **discovery document** | `/.well-known/openid-configuration`,OIDC issuer 的元数据 |
| **issuer (iss)** | JWT 签发者的 URL,唯一标识一个 OIDC 提供商 |
| **subject (sub)** | 用户在 OIDC 提供商处的唯一 ID |
| **audience (aud)** | JWT 的目标受众,标识这个 token 是给谁用的 |
| **claim** | JWT payload 里的字段,如 `iss`、`sub`、`aud`、`exp` |
| **team** | E2B 的计费/资源单位,一个组织或个人 |
| **banned** | team 永久禁用,所有路径都拒绝 |
| **blocked** | team 临时禁用,白名单路由允许通过 |
| **tier** | team 的套餐等级,决定配额 |
| **IdentityLookup** | `(iss, sub) → user_id` 的查询接口 |
| **Verifier** | 多 OIDC issuer 聚合器,顺序尝试 |
| **Authenticator** | OpenAPI 安全方案分发器接口 |
| **singleflight** | 合并并发同 key 的请求,只发一次底层调用 |
| **cache-aside** | 读时先查缓存,miss 再查 DB 然后回填 |
| **read replica** | PostgreSQL 的只读副本,用于水平扩展读 |
| **feature flag** | 通过环境变量开关的功能,这里指 `AUTH_PROVIDER_CONFIG` |
