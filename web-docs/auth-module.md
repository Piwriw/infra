# E2B auth(认证子系统)详解

> 本文档详细描述 E2B Infrastructure 中 **`packages/auth`** 子系统的设计、架构、接口、生命周期与关键实现。
>
> `auth` 包是所有 E2B 对外服务(api、dashboard-api、未来可能的新服务)的**认证底座**,统一处理 API Key、OIDC JWT、Admin Token、Service JWT 四类凭证的解析、验证、缓存与 team 状态裁决。它本身**不是服务**(没有 main.go、没有监听端口),而是一个被各服务 import 并组装到 Gin 中间件链上的库。
>
> **相关文档**:
> - [`api-module.md`](api-module.md) — API 服务(`auth` 的最大调用方)
> - [`database-schema.md`](database-schema.md) — teams / team_api_keys / user_identities 表结构
> - [`envd-module.md`](envd-module.md) — envd 内的 in-VM token(`/init` 那一套不走 `auth` 包,但概念相关)
> - [`sandbox-management.md`](sandbox-management.md) — Sandbox 创建时如何拿到 team
> - [`access-tokens-module.md`](access-tokens-module.md) — Access Token 的历史与 2026.30 退役(本文只保留追溯性引用)
>
> 数据来源:代码与迁移文件,已同步至 **2026.30**(2026-09-10)。行号均按 tag `2026.30` 核对;凡与 2026.29 不同处,写作「行 N(2026.30;2026.29 为 M)」。

---

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、整体架构](#三整体架构)
- [四、四种凭证的验证生命周期](#四四种凭证的验证生命周期)
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

`packages/auth` 是一个**纯库**,负责把 HTTP 请求中的凭证(API Key / OIDC JWT / Admin Token / Service JWT)翻译成可用的内部身份(`types.Team` 或 `uuid.UUID` user ID),并把这个身份塞进 Gin context,供下游 handler 使用。

它的核心职责:

| 职责 | 实现位置(tag `2026.30`) |
|------|---------|
| **解析 HTTP header**(X-API-Key、Authorization、X-Team-ID、X-Admin-Token) | `internal/middleware/middleware.go` |
| **凭证格式校验**(前缀、长度、hex 合法性) | `internal/service/service.go` + `keys.VerifyKey` |
| **DB 查询**:把 hash → team / user | `internal/service/store.go` |
| **Redis 缓存**:team 信息 5 分钟 TTL,后台刷新 | `internal/service/cache.go` |
| **OIDC JWT 验证**:发现文档、JWKS、签名、aud、iss、sub | `internal/token/oidc/oidc.go` |
| **Service JWT 验证**:仅 JWKS,无 discovery(2026.30 新增) | `internal/token/jwks_verifier.go` + `internal/token/jwks/verifier.go` |
| **OIDC 身份内存缓存**:(iss, sub) → user_id,1 分钟 TTL | `internal/service/identity_lookup.go` |
| **Team 状态裁决**:banned → 403(无条件),blocked → 403 但有路由白名单 | `internal/team/state.go` + `internal/team/middleware.go` |
| **Gin context 注入/读取**:`SetTeamInfo`、`GetUserID` 等 | `internal/authcontext/context.go`(经 `gin.go` 重导出) |

> ⚠️ **2026.30 起这些实现文件全部迁到 `packages/auth/pkg/auth/internal/**` 下**。`packages/auth/pkg/auth/*.go` 只剩下一层很薄的**公开重导出**(type alias + 转发函数),行数从每个 100~300 行缩到 15~99 行。见 [§12.1](#121-packagesauthpkgauthtag公开重导出层202630-重写)。

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
                          │ │  │   └─ store.GetTeamBy*(...)   │ │  ──▶ PostgreSQL(单一池)
                          │ │  └─ authProviderVerifier.Verify │ │
                          │ │      ├─ jwt.ParseWithClaims     │ │
                          │ │      ├─ keyfunc(JWKS)            │ │  ──▶ OIDC issuer HTTPS
                          │ │      └─ identityLookup           │ │  ──▶ PostgreSQL(同一池)
                          │ └─────────────────────────────────┘ │
                          │   ↓                                  │
                          │ SetTeamInfo / SetUserID(ginCtx)     │
                          └────────────┬────────────────────────┘
                                       │
                                       ▼
                                 handler 拿到身份
```

### 1.3 关键心智模型

> 想读懂 `auth` 包,先抓住 **五个反直觉点**:
>
> 1. **没有任何 main.go,只有 export**。`auth` 是一个被 import 的库。各服务在自己的 `main.go` 里 `sharedauth.NewAuthService(...)` 装配,然后传一个 `[]Authenticator` 给 `oapi-codegen` 的中间件。所以同一个 `auth` 包既能给 api 服务用(完整 6 种凭证),也能给 dashboard-api 用(只 4 种)。**2026.30 起 `packages/auth/pkg/auth/*.go` 只剩重导出**,真正的实现在 `internal/` 子包里。
>
> 2. **JWT 的开关是 Feature Flag**。当环境变量 `AUTH_PROVIDER_CONFIG` 为空 / `null` 时,`NewVerifier` 返回 `(nil, nil)`——**这是合法配置**。此时 `ValidateAuthProviderToken` 会对所有 JWT 直接返回 401。换言之,"没有 OIDC 提供商" 是一等公民的配置,不是错误。
>
> 3. **banned 和 blocked 是两件事,且 banned 无视白名单**。banned 永久拒绝(`TeamForbiddenError`,403,在 `store` 层早返回);blocked 是"软封"——大部分路由拒绝(`TeamBlockedError`,403),但白名单路由(如用户自己查看自己的 team)允许通过。blocked 的检查不在 store 层,而在 **handler 入口处的中间件**(`EnforceBlockedTeam`)里。`CheckTeamAccess`([`internal/team/middleware.go:46`](../packages/auth/pkg/auth/internal/team/middleware.go))的判定顺序是**先 banned、后 blocked**:banned team 在读到白名单之前就已经返回错误。
>
> 4. **Admin 面现在有两条并存的认证路径**(2026.30 新增第二条)。旧的 `AdminApiKeyAuth`(`X-Admin-Token` 静态 token,`subtle.ConstantTimeCompare`)保留;新增的 `AdminJWTAuth`(`Authorization: Bearer <service JWT>`)按 issuer 的 JWKS 验签,产出的主体是一个 **issuer 字符串**,既不是 user 也不是 team。
>
> 5. **不再有读写分离**(2026.30 删除)。`authDB.Read` / `authDB.Write` 两个池子已合并成单一的 `authDB.Queries`,`AUTH_DB_READ_REPLICA_CONNECTION_STRING` 环境变量一并删除。原先"身份查询必须走 primary 以躲开 replication lag"的顾虑随之消失——因为已经没有 replica 了。

### 1.4 整体架构

```
┌───────────────────────────────────────────────────────────────────────┐
│ packages/auth/pkg/auth/  ← 公开层(全部是重导出 / 转发,无实现)     │
│                                                                       │
│  service.go   (25 行)  Service / authService 别名 + NewAuthService 转发│
│  middleware.go(58 行)  7 个 NewXxxAuthenticator + CreateAuthenticationFunc│
│  token.go     (99 行)  ProviderConfig / JWKSVerifier / OIDCVerifier / │
│                        LinkedOIDCVerifier / NewJWKSVerifier 等别名    │
│  team.go      (22 行)  BlockedTeamAllowlist / CheckTeamBlocked /      │
│                        CheckTeamAccess / EnforceBlockedTeam           │
│  security.go  (52 行)  ProcessSecurityErrors + 三个错误前缀常量       │
│  gin.go       (33 行)  GetUserID / GetTeamInfo / GetServiceIssuer 等  │
│  error.go     (15 行)  APIError / TeamForbiddenError / TeamBlockedError│
│  consts.go    (13 行)  HeaderXxx / PrefixXxx 常量                     │
│  testing.go   (25 行)  SetUserIDForTest / SetTeamInfoForTest          │
│                                                                       │
│ internal/                                                             │
│  middleware/middleware.go (347) ← commonAuthenticator[T] + 7 个构造函数│
│  authcontext/context.go   (77)  ← gin context key 与读写             │
│  team/middleware.go       (78)  ← EnforceBlockedTeam + 白名单         │
│  team/state.go            (37)  ← CheckTeamBanned / CheckTeamBlocked  │
│  team/error.go            (17)  ← ForbiddenError / BlockedError       │
│  service/service.go       (315) ← AuthService:对外接口 Service        │
│  service/store.go         (111) ← authStoreImpl:DB 查询 + 异步 last_used│
│  service/cache.go         (59)  ← authCache:Redis 包装                │
│  service/identity_lookup.go(84) ← (iss,sub)→user_id 内存缓存(1min)│
│  token/provider.go        (209) ← ProviderConfig + OIDCVerifier /     │
│                                   LinkedOIDCVerifier                  │
│  token/jwks_verifier.go   (75)  ← JWKSVerifier(多 issuer 聚合)      │
│  token/provider_config_parse.go(26) ← ParseProviderConfig             │
│  token/oidc/oidc.go       (147) ← 单 issuer 验证 + IdentityLookup     │
│  token/jwks/verifier.go   (345) ← JWKS-only 单 issuer 验证            │
│  token/jwks/config.go     (99)  ← Config/Issuer + Validate            │
│  token/jwks/audience.go   (108) ← AudienceMatchPolicy                 │
│  token/jwks/testserver.go (53)  ← 测试用 TLS OIDC mock                │
└───────────────────────────────────────────────────────────────────────┘
```

> ⚠️ 旧路径对照:`auth_store.go`→`internal/service/store.go`;`cache.go`→`internal/service/cache.go`;`identity_lookup.go`→`internal/service/identity_lookup.go`;`service.go`(实现部分)→`internal/service/service.go`;`middleware.go`(实现部分)→`internal/middleware/middleware.go`;`verifier.go`→`internal/token/provider.go`;`provider_config_parse.go`→`internal/token/provider_config_parse.go`;`oidc/`→`internal/token/jwks/`(验签部分)+ `internal/token/oidc/`(身份部分);`team_state.go`→`internal/team/state.go`;`team_middleware.go`→`internal/team/middleware.go`;`gin.go`(实现部分)→`internal/authcontext/context.go`。

### 1.5 2026.30 变动总览

| 类别 | 变动 | 影响章节 |
|------|------|---------|
| **包结构** | `pkg/auth/*.go` 的全部实现下沉到 `internal/**`;顶层只剩 type alias 与转发函数 | §1.1 §1.4 §12 |
| **新增凭证** | `AdminJWTAuth`(`Authorization: Bearer <service JWT>`),由 `ADMIN_AUTH_PROVIDER_CONFIG` 驱动 | §2.6 §4.6 §5.7 §7.3 |
| **删除凭证** | ⛔ `AccessTokenAuth`(`sk_e2b_`)彻底退役:scheme、handler、DB 表、前缀常量、两个 feature flag 全删 | §4.2 §9.1 §11.1 附录 A |
| **错误类型改名** | 内部实现里 `TeamForbiddenError`/`TeamBlockedError` 改名为 `ForbiddenError`/`BlockedError`;公开层保留旧名作为 alias | §8.1 §8.2 §8.3 附录 B |
| **删除读写分离** | `authDB.Read`/`authDB.Write` 合并为 `authDB.Queries`;`AUTH_DB_READ_REPLICA_CONNECTION_STRING` 删除 | §1.3 §3.2 §9.4 §13.2 |
| **新增能力** | `InvalidateAPIKeyCache`、`Service.Close`、导出的 `AuthService` 类型(顺带新增内部查询 `GetTeamMemberIDs`,只服务于 `InvalidateTeamMemberCache`,不是公开 API) | §12.1 |
| **测试辅助删除** | ⛔ `packages/auth/pkg/tests/sign_token.go`(`SignTestToken`)整个目录删除 | §12.4 |
| **Team 状态语义澄清** | banned 无视 allowlist;blocked 走 allowlist。`CheckTeamAccess` 的判定顺序是"先 banned 后 blocked" | §8.1 §8.6 |
| **TeamLimits 扩字段** | 新增 `DefaultFreeDiskSizeMb` / `MaxFreeDiskSizeMb` | §2.5 |
| **错误体扩字段** | `APIError.ErrorCode` → 响应体 `error_code`(非封闭集合) | 附录 B |

---

## 二、核心概念

### 2.1 两种对外凭证

`auth` 包认识两种"用户面"凭证:

| 凭证 | Header | 前缀 | 谁用 | DB 落点 |
|------|--------|------|------|---------|
| **API Key** | `X-API-Key` | `e2b_` | SDK / CI 调用 api 服务 | `public.team_api_keys.api_key_hash` |
| **OIDC JWT** | `Authorization: Bearer <jwt>` | (无固定前缀) | dashboard-api 转发用户登录 | `public.user_identities (oidc_iss, oidc_sub)` |

> ⛔ **第三种"用户面"凭证 `Access Token`(`sk_e2b_` 前缀、绑定 `user_id`)已于 2026.30 彻底删除**:scheme `AccessTokenAuth` 从 spec 移除、`handlers/accesstoken.go` 删除、`public.access_tokens` 表由迁移 `20260823120000_drop_access_tokens.sql` DROP、常量 `keys.AccessTokenPrefix` 与 `auth.PrefixAccessToken` 一并删除。完整历史见 [`access-tokens-module.md`](access-tokens-module.md)。

外加三种"内部面"凭证:

| 凭证 | Header | 谁用 | 怎么校验 |
|------|--------|------|----------|
| **Admin API Key** | `X-Admin-Token` | E2B 内部运维 | `subtle.ConstantTimeCompare` 与配置的 `AdminToken` |
| **Admin Team ID** | `X-Team-ID` | 内部运维代某 team 操作 | 跟普通 team 查询一样走 DB,但用 `AdminTeamAuth` 方案 |
| **Service JWT**(2026.30 新增) | `Authorization: Bearer <service JWT>` | 内部服务间调用(如 dashboard-api 的 management 面) | 按 issuer 的 JWKS 验签(`AdminJWTAuth` 方案),产出 issuer 字符串 |

### 2.2 凭证 hash 策略

**API Key**:服务端只存 hash,不存原值。

```
e2b_<40 字符 hex>          ← 原值(用户持有,44 字符 = 4 前缀 + 40 hex)
   ↓ keys.VerifyKey(prefix, key)
   ↓ 去 prefix → hex.DecodeString → 拿回 20 字节随机
   ↓ SHA-256(20 字节) → 32 字节 hash
   ↓ base64.RawStdEncoding → 43 字符 base64
   ↓ 加前缀
$sha256$<43 字符 base64>   ← 存进 DB 的 hash(总长 51 字符)
```

详见 [`packages/shared/pkg/keys/key.go:100`](../packages/shared/pkg/keys/key.go) 的 `VerifyKey` 和 [`sha256.go`](../packages/shared/pkg/keys/sha256.go) 的 SHA-256 实现(`$sha256$<base64>` 格式,不是裸 hex)。**`AccessTokenPrefix` 已于 2026.30 从 `packages/shared/pkg/keys/constants.go` 删除**——现在 keys 包只认 `ApiKeyPrefix`。

**OIDC JWT**:不存原值也不存 hash。身份是 `(iss, sub)` 二元组,存在 `public.user_identities` 表。每次验证都重新跑发现 + JWKS + 验签,然后查身份表把 OIDC subject 翻译成内部 `user_id`。

**Service JWT(2026.30 新增)**:同样不落库。它是"对端服务签发、用 issuer 公开的 JWKS 验签"的一次性凭据,验完只取 `iss` claim 作为主体名,不做任何身份映射。

### 2.3 ProviderConfig 与 Feature Flag

OIDC 验证通过环境变量 `AUTH_PROVIDER_CONFIG` 配置(JSON);2026.30 新增的 `ADMIN_AUTH_PROVIDER_CONFIG` 复用**同一个 JSON 结构**:

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

详见 [`internal/token/provider.go:78`](../packages/auth/pkg/auth/internal/token/provider.go) 的 `NewOIDCVerifier` 与 [`internal/token/provider_config_parse.go`](../packages/auth/pkg/auth/internal/token/provider_config_parse.go) 的 `ParseProviderConfig`(2026.29 时分别在 `verifier.go:64` 与 `provider_config_parse.go:13`)。

> ⚠️ **`ADMIN_AUTH_PROVIDER_CONFIG` 未配置不是启动失败**。`NewJWKSVerifier` 在配置里没有任何 issuer 时返回 `(nil, nil)`;`packages/api/main.go:443` 只打一行 WARN(`ADMIN_AUTH_PROVIDER_CONFIG is not configured; admin JWT requests will return 401`)然后继续启动。**该路径的请求一律 401,不会静默降级成 `AdminApiKeyAuth` 校验**。

### 2.4 Verifier 家族(2026.30 重写)

2026.29 只有一个 `Verifier`(OIDC 验签 + 身份映射二合一)。2026.30 把它拆成**三个逐层加能力的类型**,放在一条轴上:

| 类型 | 密钥来源 | 产出 | 定义位置 |
|------|---------|------|---------|
| `JWKSVerifier` | issuer 的 `/.well-known/jwks.json`(无 discovery) | `jwt.MapClaims` | [`internal/token/jwks_verifier.go:26`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go) |
| `OIDCVerifier` | OIDC discovery 文档给出的 `jwks_uri` | `(uuid.UUID, claims)` / `TokenIdentity` | [`internal/token/provider.go:59`](../packages/auth/pkg/auth/internal/token/provider.go) |
| `LinkedOIDCVerifier` | 同上 | 上一行 + 解析到内部 `user_id` | [`internal/token/provider.go:69`](../packages/auth/pkg/auth/internal/token/provider.go) |

三个类型都是**多 issuer 聚合器**:`strategies`/`verifiers` 切片顺序尝试,任一成功即返回,全部失败用 `errors.Join` 合并错误。

- `JWKSVerifier.Verify`([`jwks_verifier.go:57`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go)):遍历 `verifiers`,返回**第一个验签成功的 claims**。verifier 为 nil 或没有 issuer 时返回 `service token verifier is not configured`。
- `LinkedOIDCVerifier` 与 `OIDCVerifier` 是**两个类型而非一个 flag**:不带 identity lookup 的 verifier 干脆没有 `Verify` 可调,能力在传参处就可见,而不是等请求打进来才发现。`NewLinkedOIDCVerifier` 在"配置了 JWT issuer 但 lookup 为 nil"时直接返回错误([`provider.go:89-91`](../packages/auth/pkg/auth/internal/token/provider.go)),避免把 not-found 变成一个"已认证的 nobody"。

> ⚠️ 旧的 `auth.Verifier` 这个名字**在 2026.30 已不存在**。旧代码 `type Verifier struct { strategies []strategy }` 现在对应 `OIDCVerifier`;公开层通过 [`token.go`](../packages/auth/pkg/auth/token.go) 重导出 `ProviderConfig`、`JWKSVerifier`、`OIDCVerifier`、`LinkedOIDCVerifier`、`NewJWKSVerifier`、`NewOIDCVerifier`、`NewLinkedOIDCVerifier`、`JWTConfig`、`JWTIssuer`、`AudienceMatchPolicy`。

### 2.5 Team 是什么

`types.Team` 是 `authqueries.Team`(sqlc 生成的 DB 行)+ `TeamLimits`(配额)的组合:

```go
type Team struct {
    *authqueries.Team  // ID, Name, Tier, IsBanned, IsBlocked, BlockedReason, ...
    Limits *TeamLimits // SandboxConcurrency, BuildConcurrency, MaxVcpu, ...
}
```

handler 里几乎所有的"哪个 team 在调","这个 team 的配额是多少",都来自 `MustGetTeamInfo(c).Limits` 这种调用。

`TeamLimits` 字段(见 [`types/limits.go`](../packages/auth/pkg/types/limits.go)):

| 字段 | 含义 |
|------|------|
| `SandboxConcurrency` | 同时运行的 sandbox 数上限 |
| `BuildConcurrency` | 同时进行的 template build 数上限 |
| `MaxLengthHours` | sandbox 最长存活时间(小时) |
| `MaxVcpu` | 每 sandbox 最大 vCPU |
| `MaxRamMb` | 每 sandbox 最大内存(MB) |
| `DiskMb` | team 磁盘配额(MB) |
| `EventsTTLDays` | 事件流保留天数 |
| `DefaultFreeDiskSizeMb` | **2026.30 新增**:free disk 默认大小(MB) |
| `MaxFreeDiskSizeMb` | **2026.30 新增**:free disk 上限(MB) |

> ⚠️ **2026.30 起 `TeamLimits` 的字段类型直接取 sqlc 生成的类型**,不再做 `int64(...)` 显式转换([`types/teams.go:17-32`](../packages/auth/pkg/types/teams.go))。这是上游 `team_limits` 列类型统一的结果;字段名与语义未变。

---

## 三、整体架构

### 3.1 装配序列(api 服务为例)

文件:[`packages/api/main.go:176-184`](../packages/api/main.go)(2026.29 为 `main.go:189-197`)

```go
AuthenticationFunc := auth.CreateAuthenticationFunc(
    []auth.Authenticator{
        auth.NewApiKeyAuthenticator(apiStore.GetTeamFromAPIKey),
        auth.NewAuthProviderBearerAuthenticator(apiStore.GetUserIDFromAuthProviderToken),
        auth.NewAuthProviderTeamAuthenticator(apiStore.GetTeamFromAuthProviderToken),
        auth.NewAdminApiKeyAuthenticator(config.AdminToken),
        auth.NewAdminJWTAuthenticator(adminJWTVerifier),          // 2026.30 新增
        auth.NewAdminTeamAuthenticator(apiStore.GetTeamFromAdminToken),
    },
    metricsMiddleware.SetProcessingStartTime, // preAuthHook,在 auth 之前 stamp 开始时间
)
```

与 2026.29 的差别只有两处:⛔ `auth.NewAccessTokenAuthenticator(apiStore.GetUserFromAccessToken)` 删除;✅ `auth.NewAdminJWTAuthenticator(adminJWTVerifier)` 插入在 `AdminApiKeyAuth` 与 `AdminTeamAuth` 之间。**这个位置不是随意的**——`adminJWTVerifier` 在 `main.go:437` 由 `auth.NewJWKSVerifier(ctx, config.AdminAuthProvider, http.DefaultClient)` 构造,早于 `NewGinServer` 调用(`main.go:473`)完成。

`NewGinServer` 因此多了一个参数:`adminJWTVerifier *auth.JWKSVerifier`([`main.go:101`](../packages/api/main.go))。

dashboard-api 装配(2026.30,见 [`packages/dashboard-api/main.go`](../packages/dashboard-api/main.go))现在也是 4 个:`ApiKeyAuth` + `AdminApiKeyAuth` + `AdminJWTAuth` + `AuthProviderBearerAuth` + `AuthProviderTeamAuth`(2026.29 只有后 3 个;2026.30 补上了 API Key 与两条 admin 路径)。

### 3.2 service.go 的依赖图

```go
// packages/auth/pkg/auth/internal/service/service.go:50 (tag 2026.30)
type AuthService struct {
    store                authStore                  // ← authStoreImpl,包了 authDB
    teamCache            *authCache                 // ← Redis 包装
    authProviderVerifier *token.LinkedOIDCVerifier  // ← 可能 nil(feature flag off)
}
```

`NewAuthService`([`internal/service/service.go:62`](../packages/auth/pkg/auth/internal/service/service.go))做了 5 件事:

1. 检查 `redisClient`、`authDB`、`httpClient` 都非 nil。
2. `newAuthCache(redisClient)` — 起 Redis cache。
3. `newAuthStore(authDB)` — 起 DB store。
4. `newAuthIdentityLookup(authDB.Queries)` — OIDC 身份查询,内部自带 1min 内存缓存。
5. `token.NewLinkedOIDCVerifier(ctx, providerConfig, httpClient, identityLookup)` — 起 JWT 验证器(可能返回 nil,nil)。

注意第 4 步的注释([`service.go:62-63`](../packages/auth/pkg/auth/internal/service/service.go)):

> OIDC bootstrap writes identity rows on the primary immediately before the next authenticated request; using the read replica here races replication lag.

——第一次 OIDC 登录时,`dashboard-api` 会立刻往 primary 写一行 `user_identities`,紧接着用 JWT 调 API。如果走 read replica,replication lag 可能让这行还没同步过来,身份查询会失败。

> ⚠️ **2026.30 起 `authDB` 已没有 Read/Write 之分**,这个注释是**历史遗留**——`authDB.Queries` 就是唯一连接池。注释保留是因为它记录了"为什么当初不缓存/不分离"的推理,但现在的答案已经退化成"没有 replica 可用"。

`Service` 接口([`service.go:38-48`](../packages/auth/pkg/auth/internal/service/service.go))在 2026.30 的成员:`ValidateAPIKey`、`ValidateAuthProviderToken`、`ValidateAuthProviderTeam`、`GetTeamByID`、`InvalidateTeamMemberCache`、`InvalidateTeamCache`、`InvalidateAPIKeyCache`、`Close`。**`ValidateAccessToken` 已从接口中删除。**

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
                      │   └─ go async: UpdateLastTimeUsed        │
                      │  ↓                                       │
                      │ types.NewTeam(team, limit)               │
                      └─────────────────────────────────────────┘

   ⛔ ValidateAccessToken —— 2026.30 已删除,整个分支不存在

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
                      │        authDB.Queries.GetUserIdentity      │
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

## 四、四种凭证的验证生命周期

### 4.1 API Key

入口:`authService.ValidateAPIKey`([`internal/service/service.go:97`](../packages/auth/pkg/auth/internal/service/service.go);2026.29 为 `service.go:93`)。

```go
hashedKey, err := keys.VerifyKey(keys.ApiKeyPrefix, apiKey)
//                              ^^^^^^^^^^^^^^^^ 必须以 "e2b_" 开头
//                                  ↓ hex.DecodeString + SHA-256
```

格式错误 → `APIError{Code: 401, ClientMsg: "Invalid API key format"}`。

格式 OK 后走 `authCache.GetOrSet(hashedKey, cb)`,cb 是 `store.GetTeamByHashedAPIKey`。

DB 查询(`GetTeamWithTierByAPIKey`)join 三张表:`team_api_keys` ⨝ `teams` ⨝ `team_limits`。返回前再走 `CheckTeamBanned`,banned team 抛 `TeamForbiddenError`。

banned 之外的 DB 错误 → 401(注意不是 500,理由:暴露 500 会泄露 DB 状态,401 让客户端以为是凭证问题更安全)。

> ⚠️ **`CheckTeamBanned` 抛的是内部包的 `*internalauthteam.ForbiddenError`**,公开层把它 alias 成 `auth.TeamForbiddenError`([`error.go:12`](../packages/auth/pkg/auth/error.go))。`ValidateAPIKey` 用 `errors.As` 匹配这个类型,命中就包成 `APIError{Code: 403}`。

成功后异步触发(详见 [`internal/service/store.go:43-52`](../packages/auth/pkg/auth/internal/service/store.go);2026.29 为 `auth_store.go:42`):

```go
// packages/auth/pkg/auth/internal/service/store.go:43 (tag 2026.30)
if err := internalauthteam.CheckTeamBanned(result.Team); err != nil {
    return nil, err
}
...
go func() {
    ctx := context.WithoutCancel(ctx)
    updateErr := s.authDB.UpdateLastTimeUsed(ctx, hashedKey)   // 2026.29 为 s.authDB.Write.*
}()
```

`WithoutCancel` 是为了**不让请求结束时的 ctx cancel 把这次写入也取消**——`UpdateLastTimeUsed` 不影响响应,可以慢慢写。

最后通过 `telemetry.SetAttributes` 把脱敏后的 API key(`MaskToken`,只露前 2 + 后 4 字符)和 teamID stamp 到 span。

### 4.2 Access Token —— ⛔ 已于 2026.30 删除

> ⚠️ 本节保留仅为让旧引用可回溯。2026.30 起:
> - scheme `AccessTokenAuth` 从 `spec/openapi.yml` 删除(2026.29 时它在 `spec/openapi.yml:15`,被 12 处 `security:` 块引用);
> - `packages/api/internal/handlers/accesstoken.go` 与它的 `_test.go` 删除;
> - `APIStore.GetUserFromAccessToken` 删除;
> - `packages/db/pkg/auth/queries/{create,delete}_access_token.sql.go` 与 `get_user_id_from_access_token.sql.go` 删除,`packages/db/pkg/auth/sql_queries/access_token/` 整个目录删除;
> - 表 `public.access_tokens` 与函数 `public.generate_access_token()` 由迁移 [`20260823120000_drop_access_tokens.sql`](../packages/db/migrations/20260823120000_drop_access_tokens.sql) DROP;
> - feature flag `disable-e2b-access-token-provisioning` / `disable-e2b-access-token-auth` 从 `packages/shared/pkg/featureflags/flags.go` 删除;
> - `keys.AccessTokenPrefix`(`sk_e2b_`)与 `auth.PrefixAccessToken` 删除。

旧行为(2026.29)回顾:入口 `authService.ValidateAccessToken`(`service.go:140`),`keys.VerifyKey(keys.AccessTokenPrefix, ...)` → hash → DB 查 `access_tokens` → `user_id`。**不缓存**(每次查 DB),**没有 banned/blocked 检查**(user 没有"被封"概念)。

**旧客户端的兜底**:`packages/api/main.go:166-173` 在 OpenAPI 校验中间件**之前**注册了两个无条件 410 路由:

```go
// packages/api/main.go:169-173 (tag 2026.30)
// Access tokens are removed. Registered before the OpenAPI validator
// middleware (which rejects paths missing from the spec) so old clients
// get a clear 410 instead of a 404.
accessTokensGone := func(c *gin.Context) {
    apierrors.SendAPIStoreError(c, http.StatusGone, "E2B_ACCESS_TOKEN is deprecated and no longer supported. Use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation")
}
r.POST("/access-tokens", accessTokensGone)
r.DELETE("/access-tokens/:accessTokenID", accessTokensGone)
```

> ⚠️ **顺序是刻意的**:oapi-codegen 的校验中间件会拒绝 spec 里不存在的 path(404)。把兜底路由注册在它**之前**,老客户端才会拿到 **410 Gone** 而不是 404。

### 4.3 OIDC JWT

入口:`authService.ValidateAuthProviderToken`([`internal/service/service.go:149`](../packages/auth/pkg/auth/internal/service/service.go);2026.29 为 `service.go:174`)。

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

接着走 `validateJWTWithProvider`([`service.go:161`](../packages/auth/pkg/auth/internal/service/service.go)):

```go
userID, _, err := v.Verify(ctx, token)
//                    ↓
//                  任一 strategy 成功就返回
```

`userID == uuid.Nil` 也算失败(策略返回了成功但身份表里没这行,意味着 token 有效但用户没被 provision)。

stamp telemetry,完事。

> ⚠️ 注意 `authProviderVerifier` 的类型在 2026.30 是 `*token.LinkedOIDCVerifier`(2026.29 是 `*Verifier`)。它**必须**带 identity lookup——`NewAuthService` 走的是 `token.NewLinkedOIDCVerifier`([`service.go:65`](../packages/auth/pkg/auth/internal/service/service.go))。

### 4.4 OIDC JWT + Team 组合

dashboard-api 的常见流程:**两步认证**。

1. 第一步:`Authorization: Bearer <jwt>` → `ValidateAuthProviderToken` → 拿到 `user_id`,塞进 ginCtx。
2. 第二步:`X-Team-Id: <uuid>` → `ValidateAuthProviderTeam` → 用 `(user_id, team_id)` 走 `GetTeamByIDAndUserID`,确认这个 user **真的属于这个 team**。

第二步的 cache key 是 `teamMemberCacheKey(userID, teamID)` = `fmt.Sprintf("%s-%s", userID, strings.ToLower(teamID))`(见 [`internal/service/service.go:304`](../packages/auth/pkg/auth/internal/service/service.go);2026.29 为 `service.go:276`),意味着**同一 user 切换 team 时是不同的 cache entry**——这点很重要,因为 user 在多 team 间切换是 dashboard 的核心流程。

### 4.5 Admin Token

最朴素:在 `adminValidationFunction` 里用 `subtle.ConstantTimeCompare` 比对(见 [`internal/middleware/middleware.go:153`](../packages/auth/pkg/auth/internal/middleware/middleware.go);2026.29 为 `middleware.go:118`):

```go
if subtle.ConstantTimeCompare([]byte(token), []byte(adminToken)) != 1 {
    return struct{}{}, &APIError{Code: 401, ...}
}
```

**常量时间比较**,防时序攻击。Admin Token 来自服务启动时的配置(`config.AdminToken`),不走 DB,不缓存。

`AdminTeamAuth` 是另一种形态:header 是 `X-Team-ID`,验证函数是 `apiStore.GetTeamFromAdminToken`——意味着 Admin 也得真的有一个 team 才能操作,只是绕开了 user 维度的归属检查。

### 4.6 Service JWT(`AdminJWTAuth`,2026.30 新增)

入口:[`internal/middleware/middleware.go:263`](../packages/auth/pkg/auth/internal/middleware/middleware.go) 的 `NewAdminJWTAuthenticator`。与前面所有凭证都不同——它**不查 DB、不查 Redis、不看 team**:

```go
// packages/auth/pkg/auth/internal/middleware/middleware.go:263 (tag 2026.30)
func NewAdminJWTAuthenticator(verifier *token.JWKSVerifier) Authenticator {
    return &commonAuthenticator[string]{
        schemeName: "AdminJWTAuth",
        header: headerKey{
            name:         HeaderAuthorization,
            removePrefix: PrefixBearer,
        },
        validationFunc: func(ctx context.Context, _ *gin.Context, token string) (string, *APIError) {
            claims, err := verifier.Verify(ctx, token)
            if err != nil {
                return "", &APIError{Code: http.StatusUnauthorized, Err: err, ClientMsg: "Invalid service token."}
            }
            issuer, err := claims.GetIssuer()
            if err != nil {
                return "", &APIError{Code: http.StatusUnauthorized, Err: err, ClientMsg: "Invalid service token."}
            }
            return issuer, nil
        },
        setContextFunc: authcontext.SetServiceIssuer,
        errorMessage:   "Invalid service token.",
    }
}
```

要点:

1. **产出的是 issuer 字符串**(`claims.GetIssuer()`),不是 `uuid.UUID`、也不是 `*types.Team`。它被塞进 gin context 的 `service_issuer` key([`authcontext/context.go:71`](../packages/auth/pkg/auth/internal/authcontext/context.go)),用 `auth.GetServiceIssuer(c)` 读取。**它不建立任何 team 上下文**——所以 admin JWT 路由必须再叠一个 `AdminTeamAuth` 才有 team。
2. header 是 `Authorization` + strip `Bearer `,与 `AuthProviderBearerAuth` **共用同一个 header**。两者靠 `securitySchemeName` 区分,而不是靠 header 前缀——一个请求带 Bearer 时,具体走哪条由 spec 里该 path 的 `security:` 声明决定。
3. 失败文案统一是 `Invalid service token.`(HTTP 401),与 `AdminApiKeyAuth` 的 `Invalid Access token.` 区分开。
4. `verifier` 为 nil(即 `ADMIN_AUTH_PROVIDER_CONFIG` 未配置)时,`JWKSVerifier.Verify` 直接返回 `service token verifier is not configured`,被包成 401。

**配置形状**:与 `AUTH_PROVIDER_CONFIG` 完全同构([`internal/token/provider.go:17`](../packages/auth/pkg/auth/internal/token/provider.go)):

```json
{ "jwt": [ { "issuer": { "url": "https://...", "audiences": ["..."] }, "cacheDuration": "5m" } ] }
```

详见 [§5.7](#57-jwksverifier202630-新增)。

---

## 五、OIDC JWT 验证深入

### 5.1 单 issuer Verifier 结构

> ⚠️ **2026.30 起本节讲的"单 issuer Verifier"分裂成两个类型**,不要再按一个类型理解:
>
> - **验签层** `jwks.Verifier`([`internal/token/jwks/verifier.go:35`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go)):只做 discovery + JWKS + 验签 + aud,产出 `jwt.MapClaims`。它**不知道 user 的存在**。
> - **身份层** `oidc.Verifier`([`internal/token/oidc/oidc.go:41`](../packages/auth/pkg/auth/internal/token/oidc/oidc.go)):包一个 `jwks.Verifier` 再加 `identities IdentityLookup`,产出 `(uuid.UUID, claims)`。

```go
// packages/auth/pkg/auth/internal/token/jwks/verifier.go:35 (tag 2026.30)
type Verifier struct {
    keyfunc       keyfunc.Keyfunc       // JWKS 后端 + 自动刷新
    storage       jwkset.Storage        // 同一份存储,用于读出可用签名算法
    audiences     []string              // 配置的 aud 白名单
    parserOptions []jwt.ParserOption    // 强制校验 exp、iss
}
```

```go
// packages/auth/pkg/auth/internal/token/oidc/oidc.go:41 (tag 2026.30)
type Verifier struct {
    verifier   *jwks.Verifier   // 验签层(组合,不是继承)
    identities IdentityLookup   // (iss, sub) → user_id
}
```

`oidc.Verifier` 有两个构造函数:`NewVerifier`(要求 identities 非 nil)与 `NewIdentityVerifier`([`oidc.go:63`](../packages/auth/pkg/auth/internal/token/oidc/oidc.go),不解析身份、只报告 token 声称的身份)。`provider.newStrategy`([`provider.go:128`](../packages/auth/pkg/auth/internal/token/provider.go))按 identities 是否为 nil 在两者间选择。

### 5.2 启动序列

`jwks.NewVerifier`([`internal/token/jwks/verifier.go:52`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go);2026.29 为 `oidc/oidc.go:54`)做的事:

1. 检查 `httpClient`、`identities`、`entry.Issuer.URL` 都非空。
2. 算出 `discoveryURL`:优先 `entry.Issuer.DiscoveryURL`,否则 `<issuer URL> + /.well-known/openid-configuration`。
3. `validateHTTPSURL(discoveryURL, ...)` — 必须 https,例外是 loopback host(`localhost` / `127.0.0.1` / `[::1]`,本地开发用)。
4. **同步** fetch discovery document(失败立刻返回错误,服务起不来)。
5. 校验 discovery doc 的 `issuer` 字段必须等于配置的 `entry.Issuer.URL`(防 DNS rebinding / 中间人篡改)。
6. 校验 `jwks_uri` 也是 https。
7. `jwkset.NewStorageFromHTTP(jwks_uri, ...)` — 起 JWKS 后台刷新(`RefreshInterval = entry.CacheDuration`,默认 5min)。
8. `keyfunc.New(...)` — 包一层 jwt 库要的接口。
9. 返回 `*Verifier`,内含 `parserOptions`:`jwt.WithExpirationRequired()` + `jwt.WithIssuer(entry.Issuer.URL)`([`verifier.go:130-133`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go))。
10. **2026.30 新增一步**:`validMethodsFromStorage(ctx, storage)`([`verifier.go:148`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go))在启动时就把 JWKS 里的 key 读一遍,校验每个 key 都带 `alg` 且算法属于 RSA / RSASSA-PSS / ECDSA / Ed25519 之一;不满足直接启动失败(`JWKS key %q uses unsupported signing algorithm %q`)。同一次检查也在每次 `Verify` 里重跑,结果作为 `jwt.WithValidMethods(...)` 传入——**把"允许的签名算法"收敛成"这个 issuer 实际发布的算法",而不是库的默认全集**。

注意第 4 步是**同步**的——服务启动慢一点,但启动完成后所有 JWT 验证都是离线的(只查内存中的 JWKS + DB 身份表)。

### 5.3 验证序列

`Verify`([`internal/token/jwks/verifier.go:185`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go);2026.29 为 `oidc/oidc.go:118`):

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
4. **aud 校验**(`validateAudience`):token 的 `aud` claim 与配置 `audiences` 取交集,只要有一个匹配就过。空配置(`audiences == nil`)视为"不校验 aud"。**这条路径在 2026.30 才真正可达**——见 [§5.4](#54-audience-策略)。
5. **iss / sub claim 提取**:`claimString`([`oidc.go:122`](../packages/auth/pkg/auth/internal/token/oidc/oidc.go))兼容 `string`、`[]string`、`[]any` 三种 JSON 编码。这一步在**身份层**(`oidc.Verifier.Verify`),不在验签层。
6. **身份查询**:`identities.GetUserIdentity(ctx, iss, sub)`([`oidc.go:93`](../packages/auth/pkg/auth/internal/token/oidc/oidc.go))— 在 `public.user_identities` 表里 PK 是 `(oidc_iss, oidc_sub)`,这是 O(1) 索引查询。

注意第 6 步的微妙:**JWT 验签通过不等于认证通过**。只有 (iss, sub) 在身份表里有对应行,才能拿到 `user_id`。这意味着:

- 第一次登录的用户即使 token 有效也会被拒 → 上游 `dashboard-api` 必须先做一次 `upsert_public_identity` provision 才能 login。
- 用户被 deactivate 后,直接删 `user_identities` 那行就够了——所有现有 token 立刻失效,即便它们还没到 exp。

### 5.4 audience 策略

`AudienceMatchPolicy` 当前只有 `MatchAny`(空字符串等价于 MatchAny)。语义:**配置的 audiences 中至少有一个出现在 token 的 aud claim 里**。

校验规则(见 [`internal/token/jwks/audience.go:30`](../packages/auth/pkg/auth/internal/token/jwks/audience.go);2026.29 为 `oidc/audience.go:30`):

- **audiences 可以为空**(2026.30 变动):此时 `audienceMatchPolicy` 必须为空,且 audience 匹配被**禁用**;`validateAudience` 对空列表直接返回 nil。
- 多个 audiences 时,policy 必须是 `MatchAny`(Kubernetes apiserver 的同款规则)。
- 单个 audience 时,policy 可以空或 `MatchAny`。

这套规则是**前向兼容**:留出未来加 `MatchAll` 等策略的空间。

> ⚠️ **2026.30 之前,缺 audience 会让整个 issuer 失效**。2026.29 的 `validateAudienceMatchPolicy` 在 `len(audiences) == 0` 时返回 `audiences must contain at least one entry`,即"不配 audience"根本不是合法配置——所以当时文档里写的"空配置 = 不校验 aud"是一条**不可达**的分支。2026.30 把它改成合法配置(并新增 `audienceMatchPolicy must be empty when audiences are not configured` 这条新约束),service JWT 这类"对端服务签发、没有 audience 概念"的 token 才能复用同一套 config。

### 5.5 URL 校验细节

OIDC 的 issuer URL 校验抄的是 **Kubernetes apiserver** 的规则([`internal/token/jwks/verifier.go:277`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go);2026.29 为 `oidc/oidc.go:242`):

- 必须 https,例外是 loopback host(本地开发)。
- 不能带 userinfo(`https://user:pass@...` 拒)。
- 不能带 query string。
- 不能带 fragment。
- **故意不 DNS 解析**(防 TOCTOU):只匹配字面 `localhost` / `127.0.0.0/8` / `::1`。

### 5.6 身份查询缓存

`cachingIdentityLookup`([`internal/service/identity_lookup.go:59`](../packages/auth/pkg/auth/internal/service/identity_lookup.go);2026.29 为 `identity_lookup.go:59`)包了一层 in-memory cache:

```go
const identityCacheTTL = 1 * time.Minute
```

- **只缓存成功结果**。`ErrIdentityNotFound` 和其他错误**不缓存**——理由:新 provision 的用户要能立刻登录,transient DB 错误不该被钉死。
- **singleflight**:`cache.MemoryCache` 内部用 `singleflight.Group` 把并发同 key 的 miss 合并成一次 DB 查询。
- key 用 `iss + "\x00" + sub`,NUL 字节确保无论 iss/sub 里有什么字符,key 都是 unambiguous 的。

### 5.7 JWKSVerifier(2026.30 新增)

`JWKSVerifier` 是**专为 service JWT 造的第三类 verifier**([`internal/token/jwks_verifier.go`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go))。它与 `OIDCVerifier` 的差别只有一处,但这一处决定了它的适用边界:

| 维度 | `JWKSVerifier` | `OIDCVerifier` |
|------|----------------|----------------|
| 密钥来源 | `<issuer.url> + /.well-known/jwks.json`(约定路径) | discovery 文档里的 `jwks_uri` |
| discovery 文档 | **完全不拉** | 同步拉,并交叉校验 `issuer` 字段 |
| 适用对象 | **对端服务签发的 token**(没有 discovery 可做) | 身份提供商签发的 token |
| 产出 | `jwt.MapClaims` | `(uuid.UUID, claims)` |

> ⚠️ 注释里写得很直白:它 **not suited to one from an identity provider**——因为它既不拉 discovery,也不交叉校验 discovery 里声明的 issuer。给 IdP token 用它等于少了一层防护。

**构造**([`jwks_verifier.go:35`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go)):

```go
func NewJWKSVerifier(ctx context.Context, config ProviderConfig, httpClient *http.Client) (*JWKSVerifier, error) {
    normalized := config.normalize()
    if !normalized.enabled() {          // 配置里没有 issuer
        return nil, nil                 // ← nil 是"合法状态",不是错误
    }
    verifiers := make([]*jwks.Verifier, 0, len(normalized.JWT))
    for i, entry := range normalized.JWT {
        verifier, err := jwks.NewVerifierFromIssuerJWKS(ctx, entry, httpClient,
            jwks.WithParserOptions(jwt.WithLeeway(jwksClockSkew)),   // 30s 时钟偏移容忍
        )
        ...
    }
    return &JWKSVerifier{verifiers: verifiers}, nil
}
```

要点:

1. **`NewVerifierFromIssuerJWKS` 强制清空 `Issuer.DiscoveryURL`**([`jwks/verifier.go:80`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go))——即使配置里写了 discoveryURL 也会被忽略,只走 `<issuer.url>/.well-known/jwks.json`。
2. **`jwksClockSkew = 30s`**([`jwks_verifier.go:18`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go)):`jwt.WithLeeway(30*time.Second)`。service token 生命周期短,时钟稍微不同步就会误拒一个其实还合法的 token。
3. **验签时校验的 claims 与 OIDC 路径一致**:`jwt.WithExpirationRequired()`(exp 必须有)+ `jwt.WithIssuer(entry.Issuer.URL)`(iss 必须等于配置值)+ `jwt.WithValidMethods(...)`(算法必须在该 issuer 发布的 JWKS 里出现过)+ `validateAudience`。**没有 `nbf` 强制、没有 sub 校验。**
4. **issuer URL 校验规则不变**:https(loopback 例外)、无 userinfo、无 query、无 fragment。
5. `Verify`([`jwks_verifier.go:57`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go))遍历所有 issuer 取**第一个验签成功**的 claims;`v == nil` 或 issuer 列表为空时返回 `service token verifier is not configured`。

**消费方**:目前只有 `AdminJWTAuth` 用它(见 [§4.6](#46-service-jwtadminjwtauth202630-新增))。api 服务在 [`main.go:437`](../packages/api/main.go) 构造,dashboard-api 在 [`main.go:251`](../packages/dashboard-api/main.go) 构造——**两处都用同一个 `ADMIN_AUTH_PROVIDER_CONFIG`**。

---

## 六、双层缓存机制

### 6.1 第一层:Redis(team 数据)

文件:[`internal/service/cache.go`](../packages/auth/pkg/auth/internal/service/cache.go)(2026.29 为 `cache.go`)。

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

文件:[`internal/service/identity_lookup.go`](../packages/auth/pkg/auth/internal/service/identity_lookup.go)(2026.29 为 `pkg/auth/identity_lookup.go`)。

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

`InvalidateTeamCache` 的实现([`internal/service/service.go:258`](../packages/auth/pkg/auth/internal/service/service.go);2026.29 为 `service.go:261`):

```go
s.teamCache.Invalidate(ctx, teamCacheKey(teamID))  // 删 "team-<uuid>"

hashes, err := s.store.GetTeamAPIKeyHashes(ctx, teamID)  // 拿所有 api key hash
for _, hash := range hashes {
    s.teamCache.Invalidate(ctx, hash)  // 逐个删
}
```

为什么删两遍?因为同一个 team 可能通过多种 key 被访问:

- 通过 `teamID` 直接查(例如 `GetTeamByID` 走的就是 `teamCacheKey(teamID)`,见 [`internal/service/service.go:137-141`](../packages/auth/pkg/auth/internal/service/service.go);`teamCacheKey` 定义在 `:308`。2026.29 为 `service.go:134` / `:280`)。
- 通过 API Key hash 查(`ValidateAPIKey`)。

只删一个,另一个还会返回旧数据。

> 注意:`ValidateAuthProviderTeam` 走的是另一个 key —— `teamMemberCacheKey(userID, teamID)`,因为它要验证 user-team 成员关系。那个 key 由 `InvalidateTeamMemberCache` 失效,不在 `InvalidateTeamCache` 范围内。

调用方:任何"修改了 team 或它的 api keys"的 handler。例如 team 改名、tier 升降、添加/删除 API Key、用户被加入/移出 team。

---

## 七、OpenAPI 安全方案分发器

### 7.1 Authenticator 接口

```go
// packages/auth/pkg/auth/internal/middleware/middleware.go:59 (tag 2026.30)
type Authenticator interface {
    Authenticate(ctx context.Context, ginCtx *gin.Context,
                 input *openapi3filter.AuthenticationInput) error
    SecuritySchemeName() string
}
```

`oapi-codegen` 生成的 Gin 中间件在每个标注了 `security:` 的端点上,会按 OpenAPI spec 里写的方案名(比如 `ApiKeyAuth`)调用注册的 Authenticator。

### 7.2 commonAuthenticator 模板

`auth` 包用泛型把 7 个 Authenticator 抽象成一个 `commonAuthenticator[T]`:

```go
// packages/auth/pkg/auth/internal/middleware/middleware.go:65 (tag 2026.30)
type commonAuthenticator[T any] struct {
    schemeName     string        // "ApiKeyAuth" 等
    header         headerKey     // {name, prefix, removePrefix, malformedError}
    validationFunc func(...) (T, *APIError)
    setContextFunc func(*gin.Context, T)  // SetTeamInfo / SetUserID / SetServiceIssuer
    errorMessage   string         // 失败时给前端的提示
}
```

这就是为啥所有 Authenticator 长得几乎一样——它们只是在「header 名 / 前缀 / 验证函数 / context setter」这 4 个维度上有区别。

> ⚠️ 2026.30 给 `headerKey` 加了第 4 个字段 `malformedError`([`middleware.go:46-56`](../packages/auth/pkg/auth/internal/middleware/middleware.go)):当 token 存在但缺前缀时返回**这个**错误而不是通用的 `ErrInvalidAuthHeader`。**只有独占某个 header 的方案才该设置它**——共用 header 的方案必须保留通用错误,否则另一个方案就没机会认领这个 token。目前只有 `ApiKeyAuth` 设了(`ErrMalformedAPIKey`,提示用户去看 `https://docs.e2b.dev/api-key`)。

### 7.3 7 个内置 Authenticator

| 构造函数 | schemeName | header | prefix | 验证函数签名 | setter |
|---------|------------|--------|--------|--------------|--------|
| `NewApiKeyAuthenticator` | `ApiKeyAuth` | `X-API-Key` | `e2b_`(缺失→`ErrMalformedAPIKey`) | `→ *types.Team` | `SetTeamInfo` |
| ⛔ `NewAccessTokenAuthenticator` | `AccessTokenAuth` | `Authorization` | `sk_e2b_` (strip `Bearer `) | `→ uuid.UUID` | `SetUserID` |
| `NewAuthProviderBearerAuthenticator` | `AuthProviderBearerAuth` | `Authorization` (strip `Bearer `) | (无) | `→ uuid.UUID` | `SetUserID` |
| `NewAuthProviderTeamAuthenticator` | `AuthProviderTeamAuth` | `X-Team-ID` | (无) | `→ *types.Team` | `SetTeamInfo` |
| `NewAdminApiKeyAuthenticator` | `AdminApiKeyAuth` | `X-Admin-Token` | (无) | 内嵌常量比较 | (无) |
| `NewAdminJWTAuthenticator`(2026.30 新增) | `AdminJWTAuth` | `Authorization` (strip `Bearer `) | (无) | `→ string`(issuer) | `SetServiceIssuer` |
| `NewAdminTeamAuthenticator` | `AdminTeamAuth` | `X-Team-ID` | (无) | `→ *types.Team` | `SetTeamInfo` |

第 2 行的 `NewAccessTokenAuthenticator` **已于 2026.30 删除**,保留在此仅为对照。构造函数各自的位置:[`middleware.go:221`](../packages/auth/pkg/auth/internal/middleware/middleware.go)(ApiKey)、[:236](../packages/auth/pkg/auth/internal/middleware/middleware.go)(Bearer)、[:250](../packages/auth/pkg/auth/internal/middleware/middleware.go)(AuthProviderTeam)、[:263](../packages/auth/pkg/auth/internal/middleware/middleware.go)(AdminJWT)、[:288](../packages/auth/pkg/auth/internal/middleware/middleware.go)(AdminApiKey)、[:304](../packages/auth/pkg/auth/internal/middleware/middleware.go)(AdminTeam)。

此外还有一个**通用构造函数** `NewAuthenticator[T](AuthenticatorConfig[T])`([`middleware.go:206`](../packages/auth/pkg/auth/internal/middleware/middleware.go)),给"自己定义 scheme 名"的服务用(如 envd 之外的第三方集成):`SchemeName` / `Header` / `RequiredPrefix` / `StrippedPrefix` / `Validate` / `SetContext` / `ErrorMessage` 七个字段全部显式传入。不加它,这类服务会各自重写 header 处理与 401 stamp 逻辑,最后长出一个"名字不同、行为也微妙不同"的方案。

### 7.4 创建分发函数

```go
// packages/auth/pkg/auth/internal/middleware/middleware.go:324 (tag 2026.30)
func CreateAuthenticationFunc(
    authenticators []Authenticator,
    preAuthHook func(*gin.Context),  // 可选
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
// packages/auth/pkg/auth/internal/middleware/middleware.go:98 (tag 2026.30)
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
        // 关键!如果是 ForbiddenError(banned team),直接透传 err
        var forbiddenError *internalauthteam.ForbiddenError
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

> ⚠️ **2026.30 起 401 只 stamp 一次**。新增的 `authFailureStatusContextKey`(`e2b.auth.middleware.failure_status`,[`middleware.go:73`](../packages/auth/pkg/auth/internal/middleware/middleware.go))让"已经记录过一次认证失败"这件事变得可查:只有当这个 key 还不存在时,才把状态码写成 401 并打上标记([`middleware.go:108-111`](../packages/auth/pkg/auth/internal/middleware/middleware.go))。
>
> 2026.29 的行为是**无条件 `ginCtx.Status(http.StatusUnauthorized)`**,后跑的方案会覆盖先跑方案留下的状态码。2026.30 把"缺 header 的兜底 401"改成**只在前面的方案还没记录过认证失败时才写**。

⚠️ 注意这个保护**只覆盖"header 缺失/格式错"这条分支**。业务验证失败那条分支([`middleware.go:128-129`](../packages/auth/pkg/auth/internal/middleware/middleware.go))仍然是**无条件 `ginCtx.Status(validationError.Code)`**——它只是顺手打上标记,供后面缺 header 的方案参考。所以"最早的真实失败胜出"只在 401-vs-401 之间成立;一个后跑的方案给出 403 仍会覆盖前面的 401。

---

## 八、Team 状态:banned vs blocked

### 8.1 两种状态对比

| 维度 | banned | blocked |
|------|--------|---------|
| 字段 | `teams.is_banned` | `teams.is_blocked` + `teams.blocked_reason` |
| 错误类型(实现) | `*internalauthteam.ForbiddenError` | `*internalauthteam.BlockedError` |
| 错误类型(公开别名) | `*auth.TeamForbiddenError` | `*auth.TeamBlockedError` |
| 定义位置 | 实现 `internal/team/error.go:3`;别名 `error.go:12` | 实现 `internal/team/error.go:11`;别名 `error.go:15` |
| 检查位置 | `authStoreImpl` 内(每次查询都过) | `EnforceBlockedTeam` 中间件(handler 入口) |
| 检查时机 | 早(store 层) | 晚(auth 已通过、handler 之前) |
| 是否有白名单 | 否 | 是(`BlockedTeamAllowlist`) |
| HTTP | 403 | 403 |
| 典型场景 | 永久封禁(欺诈、违规) | 临时封禁(欠费、额度耗尽) |

⚠️ 这两种状态**在 2026.29 就已存在**,语义也完全一致(`CheckTeamBanned` 在 2026.29 的 `team_state.go:13`,`CheckTeamBlocked` 在 `:28`)。2026.30 的变动只有两点:(1) 文件从 `pkg/auth/team_state.go`、`team_middleware.go` 搬进 `pkg/auth/internal/team/`;(2) 错误类型从 `TeamForbiddenError` / `TeamBlockedError` 改名为 `ForbiddenError` / `BlockedError`。**不要**把"新增 banned 状态"写进 2026.30 的变动清单。

⚠️ 容易踩的点(2026.29 起就是这样,不是 2026.30 新增):`CheckTeamAccess` 会**先查 banned、再查 blocked**([`internal/team/middleware.go:46-56`](../packages/auth/pkg/auth/internal/team/middleware.go);2026.29 为 `team_middleware.go:45-55`)。所以 banned team **绕过白名单**——即便路由在白名单里,只要 `is_banned` 为真就一律 403。白名单只对 blocked 生效。

### 8.2 banned 在哪查

`CheckTeamBanned`([`internal/team/state.go:13`](../packages/auth/pkg/auth/internal/team/state.go);2026.29 为 `pkg/auth/team_state.go:13`)在 `authStoreImpl` 的每个查询里都被调用:

```go
// internal/service/store.go:43 (GetTeamByHashedAPIKey 内)
if err := internalauthteam.CheckTeamBanned(result.Team); err != nil {
    return nil, err  // banned → 直接抛 *internalauthteam.ForbiddenError
}
```

这意味着:**banned team 的 API Key / teamID 在 store 层就过不去**,任何调用 `ValidateAPIKey`、`GetTeamByID`、`ValidateAuthProviderToken` 的入口都会拿到 `*ForbiddenError`。然后 `ValidateAPIKey` 用 `errors.As` 把它挑出来包成 `APIError{Code: 403}`([`internal/service/service.go:110-118`](../packages/auth/pkg/auth/internal/service/service.go);2026.29 为 `service.go:108` 附近的同一逻辑)。

设计意图:banned 是终态,不需要例外——任何路径都不该让 banned team 通过。

### 8.3 blocked 在哪查

`CheckTeamBlocked`([`internal/team/state.go:26`](../packages/auth/pkg/auth/internal/team/state.go);2026.29 为 `team_state.go:28`)**不在 store 里调**,而是一个公开 API,handler 或中间件自己决定要不要查。

```go
func CheckTeamBlocked(team *types.Team) error {
    if team == nil || team.Team == nil || !team.IsBlocked {
        return nil
    }
    msg := "team is blocked"
    if team.BlockedReason != nil && *team.BlockedReason != "" {
        msg = fmt.Sprintf("%s: %s", msg, *team.BlockedReason)
    }
    return &BlockedError{Message: msg}   // 2026.29 为 &TeamBlockedError{...}
}
```

注意它接 `*types.Team`(指针),允许 nil:Admin Token / Service JWT 路径上没有 team,这个函数直接返回 nil,noop。这样 handler 可以无脑调用。

⚠️ 2026.29 的源码注释里写的是 "admin / access-token paths have no team";2026.30 因为 Access Token 已被删除,注释改成了 "Handlers without team context are allowed through"([`internal/team/state.go:25`](../packages/auth/pkg/auth/internal/team/state.go))。

### 8.4 EnforceBlockedTeam 中间件

```go
// internal/team/middleware.go:60(2026.29 为 team_middleware.go:59)
func EnforceBlockedTeam(allowlist BlockedTeamAllowlist) gin.HandlerFunc {
    return func(c *gin.Context) {
        team, ok := authcontext.GetTeamInfo(c)   // 2026.29 为裸 GetTeamInfo(c)
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
// internal/team/middleware.go:15(2026.29 为 team_middleware.go:14)
type BlockedTeamAllowlist map[string]map[string]struct{}
//                    key=HTTP method    key=gin route pattern(c.FullPath())
```

公开层用类型别名原样导出([`pkg/auth/team.go:10`](../packages/auth/pkg/auth/team.go)):`type BlockedTeamAllowlist = internalauthteam.BlockedTeamAllowlist`——所以调用方写 `auth.BlockedTeamAllowlist` 完全不受搬迁影响。

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
// internal/team/middleware.go:46(2026.29 为 team_middleware.go:45)
func CheckTeamAccess(c *gin.Context, team *types.Team, allowlist BlockedTeamAllowlist) error
```

这是给"不开 `EnforceBlockedTeam` 中间件,但在某个 handler 里要主动检查"的场景用的(api 服务大多走这个模式,因为不是所有路由都需要 blocked 检查)。公开层是一个转发函数([`pkg/auth/team.go:16`](../packages/auth/pkg/auth/team.go))。

⚠️ api 服务在 2026.29 起就有一层包装:`internal/middleware/blocked_team.go` 的 `CheckTeamAccessForRoute`(2026.30 为 `:57`;2026.29 为 `:55`)把 `CheckTeamAccess` 和 api 自己的 `blockedTeamAllowlist` 绑在一起。2026.30 对这个文件只有 4 行改动:白名单新增 `GET /secrets` 与 `GET /secrets/:secretID`,以及注释里 "access-token-only routes" 改成 "user-bearer-only routes"(Access Token 已删)。

---

## 九、数据模型

### 9.1 涉及的表

| 表 | 主要字段 | 用途 |
|----|---------|------|
| `public.teams` | `id, name, tier, is_banned, is_blocked, blocked_reason, slug, cluster_id` | team 主表 |
| `public.team_api_keys` | `team_id, api_key_hash, api_key_prefix, last_used` | API Key 存储 |
| `public.users_teams` | `user_id, team_id, is_default` | user-team 多对多 |
| `public.team_limits` | `id, concurrent_sandboxes, max_vcpu, max_ram_mb, ...` | team 配额 |
| `public.user_identities` | `oidc_iss, oidc_sub, user_id` | OIDC 身份映射 |

⛔ **2026.30 删除**:`public.access_tokens` 表(原字段 `id, user_id, created_at, access_token_hash, name, access_token_prefix, access_token_length, access_token_mask_prefix, access_token_mask_suffix`)和函数 `public.generate_access_token()` 一并 drop,迁移文件 [`packages/db/migrations/20260823120000_drop_access_tokens.sql`](../packages/db/migrations/20260823120000_drop_access_tokens.sql)。迁移里的注释解释了理由:已经没有任何代码签发、校验或清理 `sk_e2b_` token,表里剩下的只是已吊销凭证的 hash。`-- +goose Down` 段保留了完整的重建语句,可回滚。

### 9.2 sqlc 查询

文件 [`packages/db/pkg/auth/sql_queries/teams/get_team.sql`](../packages/db/pkg/auth/sql_queries/teams/get_team.sql):

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

⚠️ 这个文件 2026.29 → 2026.30 **逐字节未变**(除上文 3 个之外还有 `GetAutoJoinTeamsBySSOOrganizationID`、`GetTeamsWithUsersTeamsWithTier` 两个查询,也是 2026.29 就有的)。sqlc 目录层面的变动是:

- ⛔ 删除 `sql_queries/access_token/` 整个目录(3 个文件:`create_access_token.sql`、`delete_access_token.sql`、`get_user_id_from_access_token.sql`),对应的生成代码 `pkg/auth/queries/{create,delete,get_user_id_from}_access_token.sql.go` 也一并删除。
- 新增 4 个 team 相关查询文件:`teams/get_team_member_ids.sql`、`teams/project_member_projections.sql`、`teams/team_management.sql`、`teams/team_membership_sync.sql`(team → project 术语迁移 + 管理面,见 §14 相关说明)。
- `pkg/auth/queries/models.go` 里删掉了 AccessToken 结构体(-17 行)。

`sql_queries/` 的路径本身没变——仍然是 [`packages/db/pkg/auth/sql_queries/`](../packages/db/pkg/auth/sql_queries/)(2026.29 相同),`auth-module` 引用的 `packages/db/pkg/auth/queries/` 生成目录也没搬。

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

### 9.4 Client 读写分离 —— ⛔ 已于 2026.30 移除

2026.29 的 [`packages/db/pkg/auth/client.go`](../packages/db/pkg/auth/client.go) 是双池结构:

```go
// 2026.29
type Client struct {
    Read      *authqueries.Queries  // 走 read replica
    Write     *authqueries.Queries  // 走 primary
    writeConn *pgxpool.Pool
    readConn  *pgxpool.Pool
}

func NewClient(ctx context.Context, databaseURL, replicaURL string, options ...pool.Option) (*Client, error)
```

`NewClient` 总是建 primary 连接池;如果 `replicaURL` 非空(经 `strings.TrimSpace` 判断)再建一个 replica 连接池给 `Read` 用,否则 `readPool := writePool`。

2026.30 改成单池:

```go
// 2026.30
type Client struct {
    *authqueries.Queries

    conn *pgxpool.Pool
}

func NewClient(ctx context.Context, databaseURL string, options ...pool.Option) (*Client, error)
```

- 内嵌 `*authqueries.Queries`(而不是暴露 `Read` / `Write` 两个字段),所以调用点从 `authDB.Read.GetUserIdentity(...)` / `authDB.Write.*` 一律变成 `authDB.GetUserIdentity(...)`(见 §3.3)。
- `NewClient` **丢掉了第二个参数 `replicaURL`**,`poolName = "auth"`、`replica = "replica"` 这个常量组也只剩 `poolName`。
- 新增 `WithTx(ctx)` 返回 `(*authqueries.Queries, pgx.Tx, error)`,给事务用。
- 环境变量 `AUTH_DB_READ_REPLICA_CONNECTION_STRING` 在 api 与 dashboard-api 的 config 里都已删除。
- 依赖 `packages/db/pkg/types`(提供 `types.DBTX`)的那段 replica 分支代码整体消失。

⚠️ 2026.29 的 `authStoreImpl` 曾经刻意让 `GetTeamByHashedAPIKey` 走 primary:源码注释写着读 replica 会与复制延迟竞争、可能把一个刚被删除的 API Key 重新缓存整个 TTL。单池化之后这个区分自然消失——**所有查询都走同一个池**。2026.30 的 [`internal/service/store.go:34-37`](../packages/auth/pkg/auth/internal/service/store.go) 保留了这段解释性注释,只是不再需要选池。

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
 │                          │                         │ go UpdateLastTimeUsed (async, 同一池) ────▶│
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
 │                       │                          │◀── *ForbiddenError ───│
 │                       │                          │    (banned)          │
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
| `AUTH_PROVIDER_CONFIG` | (空) | OIDC 配置 JSON,空 / `null` 时 **用户** JWT 验证被禁用 |
| `ADMIN_AUTH_PROVIDER_CONFIG`(2026.30 新增) | (空) | Admin JWT 的 OIDC 配置 JSON,喂给 `NewJWKSVerifier`;空时 admin JWT 一律 401 |
| `ADMIN_TOKEN` | (空 / dashboard-api 必填) | admin 接口的静态 token |
| `AUTH_DB_CONNECTION_STRING` | (空) | **auth DB** 的 PostgreSQL DSN,`authdb.NewClient` 用它 |
| `POSTGRES_CONNECTION_STRING` | (必填) | 主(非 auth)PostgreSQL DSN,与 auth 模块无关 |
| `REDIS_URL` | (必填) | team cache 用(也支持 `REDIS_CLUSTER_URL` / `REDIS_TLS_CA_BASE64`) |

⛔ **2026.30 删除**:`AUTH_DB_READ_REPLICA_CONNECTION_STRING`(2026.29 时 api 在 [`packages/api/internal/cfg/model.go:85`](../packages/api/internal/cfg/model.go),dashboard-api 也有同名变量)。auth DB 单池化后不再需要(见 §9.4)。

⚠️ 文档此前把 auth DB 的 DSN 写成 `POSTGRES_CONNECTION_STRING`,**这在 2026.29 就不对**——2026.29 的 [`packages/api/internal/handlers/store.go:99-101`](../packages/api/internal/handlers/store.go) 传给 `authdb.NewClient` 的第一个参数就是 `config.AuthDBConnectionString`(`AUTH_DB_CONNECTION_STRING`);2026.30 为 `store.go:238-240`,dashboard-api 为 `main.go:137-139`,两个 tag 都是同一个变量。`POSTGRES_CONNECTION_STRING` 是主库(handler store 用),两者不同。

⚠️ 变量名是 `ADMIN_AUTH_PROVIDER_CONFIG` 而非 `ADMIN_AUTH_PROVIDER`。api 侧定义在 [`packages/api/internal/cfg/model.go:136`](../packages/api/internal/cfg/model.go),类型与 `AUTH_PROVIDER_CONFIG` 相同的 `sharedauth.ProviderConfig`。

⛔ 2026.30 同时删除了 `AUTH_DB_READ_REPLICA_CONNECTION_STRING` 相关的 `strings`/`types.DBTX` 依赖(见 §9.4)。

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

### 11.3 配置行为矩阵

用户 JWT(`AUTH_PROVIDER_CONFIG` → `NewVerifier` → `LinkedOIDCVerifier`):

| `AUTH_PROVIDER_CONFIG` | `NewVerifier` 返回 | `ValidateAuthProviderToken` 行为 |
|------------------------|---------------------|----------------------------------|
| 空 / `"null"` / unset | `(nil, nil)` | 总是 401 "auth provider is not configured" |
| 单 issuer | `(*LinkedOIDCVerifier, nil)` | 正常验证 |
| 多 issuer | `(*LinkedOIDCVerifier, nil)` | 顺序尝试,任一通过即可 |
| JSON 解析失败 | `(nil, err)` | 服务起不来 |

Admin JWT(2026.30 新增;`ADMIN_AUTH_PROVIDER_CONFIG` → `NewJWKSVerifier` → `JWKSVerifier`):

| `ADMIN_AUTH_PROVIDER_CONFIG` | `NewJWKSVerifier` 返回 | 行为 |
|------------------------------|------------------------|------|
| 空 / unset | `(nil, nil)` | 进程**正常启动**(`main.go:443-445` 只打一条 Warn);authenticator **照常注册**,但每次 `Verify` 都返回 `service token verifier is not configured` → 401 "Invalid service token." |
| 配置了 issuer | `(*JWKSVerifier, nil)` | 验证 `iss` / `exp` / `aud` / 签名方法,命中即 `SetServiceIssuer` |
| JSON 解析失败 | `(nil, err)` | 服务起不来(`main.go:437-442` 记日志后 `return 1`) |

⚠️ 两个容易搞错的地方:

1. **nil verifier 不会 panic,也不会"跳过注册"**。[`packages/api/main.go:182`](../packages/api/main.go) 无条件调用 `auth.NewAdminJWTAuthenticator(adminJWTVerifier)`,哪怕 `adminJWTVerifier` 是 nil;之所以安全,是因为 [`internal/token/jwks_verifier.go:58`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go) 的 `Verify` 显式处理了 nil 接收者:`if v == nil || len(v.verifiers) == 0 { return nil, errors.New("service token verifier is not configured") }`。所以空配置下 `AdminJWTAuth` 方案**存在但永远失败**。
2. **`NewVerifier` 与 `NewJWKSVerifier` 的空配置返回值形状相同(`(nil, nil)`),但下游处理不同**:用户 JWT 由 `ValidateAuthProviderToken` 显式转成 401 "Backend authentication failed";Admin JWT 由 `Verify` 自己返回错误,再被包成 401 "Invalid service token."。

### 11.4 cache 与超时参数

| 常量 | 值 | 2026.30 位置 | 2026.29 位置 |
|------|-----|--------------|--------------|
| `authInfoExpiration` | 5 分钟 | `internal/service/cache.go:14` | `cache.go:14` |
| `refreshInterval` | 1 分钟 | `internal/service/cache.go:15` | `cache.go:15` |
| `refreshTimeout` | 30 秒 | `internal/service/cache.go:16` | `cache.go:16` |
| `identityCacheTTL` | 1 分钟 | `internal/service/identity_lookup.go:20` | `identity_lookup.go:20` |
| `defaultCacheDuration` | 5 分钟 | `internal/token/jwks/config.go:14` | `oidc/config.go:14` |
| `httpTimeout` | 10 秒 | `internal/token/jwks/verifier.go:22` | `oidc/oidc.go:23`(名称为 `oidcHTTPTimeout`) |
| `jwksClockSkew`(2026.30 新增) | 30 秒 | `internal/token/jwks_verifier.go:18` | — |

⚠️ 2026.30 把 OIDC discovery / JWKS 的 HTTP 超时常量从 `oidcHTTPTimeout` **改名为 `httpTimeout`**,值不变(10 秒),但位置从 `oidc/oidc.go` 移到 `internal/token/jwks/verifier.go`。写"`oidcHTTPTimeout`"在 2026.30 的代码里是搜不到的。

⚠️ `jwksClockSkew = 30s` 只作用于 **Admin JWT 的 `JWKSVerifier`**(通过 `jwks.WithParserOptions(jwt.WithLeeway(jwksClockSkew))` 注入,`internal/token/jwks_verifier.go:44`),**不作用于**用户 JWT 的 `OIDCVerifier`——后者走 `jwks.Verifier` 的默认 parser options。源码注释解释了为什么需要它:Service Token 生命周期短,时钟稍有不齐就会把合法 token 判为过期。

---

## 十二、关键代码文件索引

> 所有路径相对仓库根。

### 12.1 packages/auth/pkg/auth(公开重导出层,2026.30 重写)

2026.30 起这一层只做三件事:type alias、转发函数、常量。**所有实现都在 `internal/**`**,见下面的第二张表。行数因此从 2026.29 的 24~287 缩到 13~99。

| 文件 | 行数 | 主要 export |
|------|------|------------|
| [`token.go`](../packages/auth/pkg/auth/token.go) | 99 | `ProviderConfig`、`JWTConfig`、`JWTIssuer`、`AudienceMatchPolicy`、`AudienceMatchAny`、`JWKSVerifier`、`NewJWKSVerifier`、`OIDCVerifier`、`NewOIDCVerifier`、`LinkedOIDCVerifier`、`NewLinkedOIDCVerifier`、`OIDCIssuerVerifier`、`NewOIDCIssuerVerifier`、`IdentityLookup`、`TokenIdentity`、`ErrIdentityNotFound`、`ParseProviderConfig` |
| [`middleware.go`](../packages/auth/pkg/auth/middleware.go) | 58 | `Authenticator`、`AuthenticatorConfig[T]`、`NewAuthenticator[T]`、`NewApiKeyAuthenticator`、`NewAuthProviderBearerAuthenticator`、`NewAuthProviderTeamAuthenticator`、`NewAdminJWTAuthenticator`、`NewAdminApiKeyAuthenticator`、`NewAdminTeamAuthenticator`、`CreateAuthenticationFunc`、`ErrNoAuthHeader` 等 |
| [`security.go`](../packages/auth/pkg/auth/security.go) | 52 | `SecurityErrPrefix`、`ForbiddenErrPrefix`、`BlockedErrPrefix`、`ProcessSecurityErrors` |
| [`gin.go`](../packages/auth/pkg/auth/gin.go) | 33 | `GetUserID`、`MustGetUserID`、`GetTeamInfo`、`MustGetTeamInfo`、`MustGetTeamID`、`GetServiceIssuer` |
| [`service.go`](../packages/auth/pkg/auth/service.go) | 25 | `Service`、`authService`、`NewAuthService` |
| [`testing.go`](../packages/auth/pkg/auth/testing.go) | 25 | `SetUserIDForTest`、`SetTeamInfoForTest` |
| [`team.go`](../packages/auth/pkg/auth/team.go) | 22 | `BlockedTeamAllowlist`、`CheckTeamBlocked`、`CheckTeamAccess`、`EnforceBlockedTeam` |
| [`error.go`](../packages/auth/pkg/auth/error.go) | 15 | `APIError`、`TeamForbiddenError`、`TeamBlockedError`(后两个是 alias) |
| [`consts.go`](../packages/auth/pkg/auth/consts.go) | 13 | `HeaderAPIKey`、`HeaderAuthorization`、`HeaderTeamID`、`HeaderAdminToken`、`PrefixAPIKey`、`PrefixBearer` |

⛔ 2026.29 存在但 2026.30 已不在这一层的文件:`verifier.go`(125)、`auth_store.go`(106)、`identity_lookup.go`(84)、`team_middleware.go`(77)、`cache.go`(52)、`team_state.go`(39)、`provider_config_parse.go`(25)——全部迁入 `internal/**`。
⛔ `consts.go` 里的 `PrefixAccessToken`(值 `sk_e2b_`)已删除,只剩 `PrefixAPIKey`(`e2b_`)和 `PrefixBearer`(`Bearer `)。

`internal/**` 实现文件(同属 `packages/auth/pkg/auth` 包路径下,但 `internal` 前缀使外部模块无法直接 import):

| 文件 | 行数 | 主要 export |
|------|------|------------|
| [`internal/middleware/middleware.go`](../packages/auth/pkg/auth/internal/middleware/middleware.go) | 347 | `Authenticator`、`AuthenticatorConfig[T]`、`NewAuthenticator[T]`、`commonAuthenticator[T]`、7 个构造函数、`CreateAuthenticationFunc`、`authFailureStatusContextKey`、`malformedError` |
| [`internal/service/service.go`](../packages/auth/pkg/auth/internal/service/service.go) | 315 | `authStore`、`Service`、`AuthService`、`NewAuthService`、`ValidateAPIKey`、`ValidateAuthProviderToken`、`ValidateAuthProviderTeam`、`GetTeamByID`、`InvalidateTeamCache`、`InvalidateTeamMemberCache`、`InvalidateAPIKeyCache`、`Close`、`teamMemberCacheKey`、`teamCacheKey` |
| [`internal/service/store.go`](../packages/auth/pkg/auth/internal/service/store.go) | 111 | `authStore`、`authStoreImpl`、`newAuthStore`、`GetTeamMemberIDs` |
| [`internal/service/identity_lookup.go`](../packages/auth/pkg/auth/internal/service/identity_lookup.go) | 84 | `identityCacheTTL`、`authIdentityLookup`、`cachingIdentityLookup`、`newAuthIdentityLookup` |
| [`internal/service/cache.go`](../packages/auth/pkg/auth/internal/service/cache.go) | 59 | `authInfoExpiration`、`refreshInterval`、`refreshTimeout`、`invalidateTimeout`、`authCache`、`newAuthCache` |
| [`internal/team/middleware.go`](../packages/auth/pkg/auth/internal/team/middleware.go) | 78 | `BlockedTeamAllowlist`、`Allows`、`CheckBlockedTeamForRoute`、`CheckTeamAccess`、`EnforceBlockedTeam` |
| [`internal/team/state.go`](../packages/auth/pkg/auth/internal/team/state.go) | 37 | `CheckTeamBanned`、`CheckTeamBlocked` |
| [`internal/team/error.go`](../packages/auth/pkg/auth/internal/team/error.go) | 17 | `ForbiddenError`、`BlockedError` |
| [`internal/authcontext/context.go`](../packages/auth/pkg/auth/internal/authcontext/context.go) | 77 | `SetUserID`、`GetUserID`、`MustGetUserID`、`SetTeamInfo`、`GetTeamInfo`、`MustGetTeamInfo`、`MustGetTeamID`、`SetServiceIssuer`、`GetServiceIssuer` |
| `internal/token/**` | — | 见 §12.2 |

⚠️ `authcontext` 是 2026.30 新增的包。2026.29 的 `gin.go` 里那些 `setUserID` / `setTeamInfo` / `getFromGinContextSafely` 内部函数(68 行)现在拆成两半:实现进 `internal/authcontext/context.go`,公开层 `gin.go` 只留 6 个转发函数。

### 12.2 packages/auth/pkg/auth/internal/token(原 oidc/,2026.30 重写)

2026.29 的 `pkg/auth/oidc/` 目录被拆成三个文件族:`internal/token/jwks/`(纯 JWKS 校验,可脱离 OIDC)、`internal/token/oidc/`(discovery + claims 校验)、`internal/token/`(把两者组合成三个 verifier)。

| 文件 | 行数 | 主要 export |
|------|------|------------|
| [`internal/token/jwks/verifier.go`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go) | 345 | `Verifier`、`NewVerifier`、`NewVerifierFromIssuerJWKS`、`Verify`、`httpTimeout`、`validMethodsFromStorage` |
| [`internal/token/jwks/config.go`](../packages/auth/pkg/auth/internal/token/jwks/config.go) | 99 | `Config`、`Issuer`、`defaultCacheDuration`、`defaultDiscoveryPath`、`Normalized`、`Validate` |
| [`internal/token/jwks/audience.go`](../packages/auth/pkg/auth/internal/token/jwks/audience.go) | 108 | `AudienceMatchPolicy`、`AudienceMatchAny`、`validateAudience`、`extractAudiences` |
| [`internal/token/jwks/testserver.go`](../packages/auth/pkg/auth/internal/token/jwks/testserver.go) | 53 | `NewTestServer`(测试用 TLS OIDC mock) |
| [`internal/token/oidc/oidc.go`](../packages/auth/pkg/auth/internal/token/oidc/oidc.go) | 147 | `ErrIdentityNotFound`、`IdentityLookup`、`Verifier`、`NewVerifier`、`TokenIdentity` |
| [`internal/token/provider.go`](../packages/auth/pkg/auth/internal/token/provider.go) | 209 | `ProviderConfig`、`JWKSVerifier`、`NewJWKSVerifier`、`OIDCVerifier`、`NewOIDCVerifier`、`LinkedOIDCVerifier`、`NewLinkedOIDCVerifier` |
| [`internal/token/jwks_verifier.go`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go) | 75 | `JWKSVerifier`、`NewJWKSVerifier`、`Verify`、`jwksClockSkew` |
| [`internal/token/provider_config_parse.go`](../packages/auth/pkg/auth/internal/token/provider_config_parse.go) | 26 | `ParseProviderConfig` |

⚠️ 行数对照(2026.29 → 2026.30):`oidc/oidc.go` 310 → 拆成 `oidc/oidc.go` 147 + `jwks/verifier.go` 345;`oidc/config.go` 98 → `jwks/config.go` 99;`oidc/audience.go` 104 → `jwks/audience.go` 108;`oidc/testserver.go` 52 → `jwks/testserver.go` 53;`verifier.go` 125 → `token/provider.go` 209(新增 `OIDCVerifier` / `JWKSVerifier` 两层)。

### 12.3 packages/auth/pkg/types

| 文件 | 行数(2026.30;2026.29) | 主要 export |
|------|------------------------|------------|
| [`teams.go`](../packages/auth/pkg/types/teams.go) | 48(45) | `Team`、`TeamID()`、`NewTeam`、`TeamWithDefault` |
| [`limits.go`](../packages/auth/pkg/types/limits.go) | 16(13) | `TeamLimits`(含 2026.30 新增的 `DefaultFreeDiskSizeMb` / `MaxFreeDiskSizeMb`) |

### 12.4 packages/auth/pkg/tests —— ⛔ 2026.30 删除

| 文件 | 2026.29 行数 | 主要 export |
|------|-------------|------------|
| ~~`sign_token.go`~~ | 27 | ~~`SignTestToken`(HS256 测试 token)~~ |

⚠️ 整个 `packages/auth/pkg/tests/` 目录在 2026.30 已不存在,`SignTestToken` 在 2026.30 全仓库**零引用**。写测试时不要再 import 这个包。

### 12.5 调用方

| 文件 | 用法 |
|------|------|
| [`packages/api/main.go:176-186`](../packages/api/main.go) | `CreateAuthenticationFunc` 注册 **6 个** Authenticator(2026.29 为 `:189-197`,**也是 6 个**) |
| [`packages/api/main.go:101`](../packages/api/main.go) | `NewGinServer` 新增参数 `adminJWTVerifier *auth.JWKSVerifier` |
| [`packages/api/main.go:437`](../packages/api/main.go) | `auth.NewJWKSVerifier(ctx, config.AdminAuthProvider, http.DefaultClient)` |
| [`packages/api/main.go:182`](../packages/api/main.go) | `auth.NewAdminJWTAuthenticator(adminJWTVerifier)` —— **无条件注册**,nil 也注册 |
| [`packages/api/internal/handlers/store.go:238-240`](../packages/api/internal/handlers/store.go) | `authdb.NewClient(ctx, config.AuthDBConnectionString, ...)`(2026.29 为 `:99-101`,多传一个 replica DSN) |
| [`packages/api/internal/handlers/store.go:344`](../packages/api/internal/handlers/store.go) | `sharedauth.NewAuthService(ctx, redisClient, authDB, config.AuthProvider, authClient)`(2026.29 为 `store.go:232`) |
| [`packages/api/internal/cfg/model.go:135-136`](../packages/api/internal/cfg/model.go) | `AuthProvider` + `AdminAuthProvider`(`AUTH_PROVIDER_CONFIG` / `ADMIN_AUTH_PROVIDER_CONFIG`) |
| [`packages/dashboard-api/main.go:137-139`](../packages/dashboard-api/main.go) | `authdb.NewClient(ctx, config.AuthDBConnectionString, ...)` |
| [`packages/dashboard-api/main.go:194`](../packages/dashboard-api/main.go) | `sharedauth.NewAuthService(...)` 装配(2026.29 为 `:193`) |
| [`packages/dashboard-api/main.go:251`](../packages/dashboard-api/main.go) | `sharedauth.NewJWKSVerifier(ctx, config.AdminAuthProvider, authClient)` |
| [`packages/dashboard-api/main.go:266`](../packages/dashboard-api/main.go) | `sharedauth.NewAdminJWTAuthenticator(adminVerifier)` |
| [`packages/dashboard-api/main.go:386`](../packages/dashboard-api/main.go) | `r.Use(dashboardmiddleware.EnforceBlockedTeam())` |
| [`packages/dashboard-api/internal/middleware/blocked_team.go:14`](../packages/dashboard-api/internal/middleware/blocked_team.go) | `blockedTeamAllowlist` 变量 |
| [`packages/dashboard-api/internal/middleware/blocked_team.go:36-38`](../packages/dashboard-api/internal/middleware/blocked_team.go) | `EnforceBlockedTeam()` 包装 `auth.EnforceBlockedTeam(blockedTeamAllowlist)`(2026.29 为 `:34`) |
| [`packages/api/internal/middleware/blocked_team.go:57`](../packages/api/internal/middleware/blocked_team.go) | `CheckTeamAccessForRoute` 包装 `auth.CheckTeamAccess` |

⚠️ 两个调用方都把这个包 **alias 成 `sharedauth`** 来 import(因为 api / dashboard-api 内部也各自有一个叫 `auth` 的东西),所以源码里看到的是 `sharedauth.NewAuthService` / `sharedauth.NewJWKSVerifier`,不是 `auth.NewAuthService`。

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

### 13.2 为什么身份查询走 Write 池? —— ⛔ 2026.30 起问题本身消失

> 本节描述的是 **2026.29** 的设计;2026.30 移除读写分离后已无 `Read` / `Write` 之分(见 §9.4),内容保留作为历史。

2026.29 的 `newAuthIdentityLookup(authDB.Write)` 而不是 `authDB.Read`——理由:**OIDC bootstrap 的复制时延赛跑**。

典型场景:

1. 用户第一次登录 → dashboard-api 调 `upsert_public_identity` 在 primary 写一行。
2. dashboard-api 紧接着用同一个 JWT 调 api 服务。
3. api 服务的 `ValidateAuthProviderToken` 查 `user_identities`。

如果第 3 步走 read replica,而 replica 还没同步过来(典型 lag 100ms-1s),用户就拿不到 user_id,401。这会让"第一次登录"几乎必然失败。

**强制走 Write 池**:绕开 replication lag。

⚠️ 2026.30 单池化后这类"选池"决策全部不存在。但要注意 [`internal/service/store.go:34-37`](../packages/auth/pkg/auth/internal/service/store.go) 保留了一条相关注释:API Key 的读取刻意不做 read-after-write 的妥协——单池下这不再需要论证。

### 13.3 为什么 UpdateLastTimeUsed 是异步?

`authStoreImpl.GetTeamByHashedAPIKey` 里(见 [`internal/service/store.go:47-54`](../packages/auth/pkg/auth/internal/service/store.go);2026.29 为 `auth_store.go:42`):

```go
go func() {
    ctx := context.WithoutCancel(ctx)
    updateErr := s.authDB.UpdateLastTimeUsed(ctx, hashedKey)   // 2026.29 为 s.authDB.Write.UpdateLastTimeUsed
}()
```

理由:

- `last_time_used` 是给运营/审计看的,不影响响应。
- 写 DB 会增加 5-50ms 延迟,API Key 验证是热路径(每个请求都过),累加起来很可观。
- `WithoutCancel`:即便 client 断开连接,异步 goroutine 也能把这次写入完成——避免"用户重试 N 次,DB 永远记不下最后一次时间"。

代价:服务关闭时可能丢失最近几秒的 update。但 `last_time_used` 不要求强一致,这个权衡是划算。

### 13.4 为什么 banned 在 store 层,blocked 在中间件?

- **banned**:终态,任何路径都不能通过,包括 admin 查询。store 层是最深的、最不可避免的层——放这里保证"零遗漏"。
- **blocked**:有白名单(登录、缴费、看自己),需要在路由维度区分。store 层做不到(它不知道当前请求是哪个路由),所以必须放在能拿到 ginCtx 的中间件层。

代价:如果某个 handler 直接用 `apiStore.GetTeamByID(ctx, teamID)` 拿 team,然后忘了走 blocked 检查,blocked team 就能绕过——但这种情况很罕见,因为 blocked 检查是 handler 模板的一部分。

### 13.5 为什么 Verifier 是聚合器而不是单实例?

`OIDCVerifier.strategies []strategy` 而不是 `strategy`([`internal/token/provider.go:59-61`](../packages/auth/pkg/auth/internal/token/provider.go);2026.29 是 `Verifier.strategies`,`verifier.go:54-55`)——理由:**多 OIDC issuer 平滑迁移**。

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

API Key 不需要这个,因为它的"原值"有 20 字节随机(hex 编码 40 字符),即便有时序差,猜中也得 2^160 次尝试——远超算力。Admin token 是人工配置的,可能短或弱,所以走常量时间。

⚠️ 2026.29 这里还并列提到 Access Token。它已在 2026.30 删除,不再是需要考虑的对象。

### 13.7 为什么 ValidateAccessToken 不缓存? —— ⛔ 2026.30 起该方法已删除

> 本节描述的是 **2026.29** 的设计;`ValidateAccessToken` 在 2026.30 已从 `Service` 接口与实现中整体移除(见 §4.2),内容保留作为历史。

2026.29 的 `ValidateAccessToken` 每次都查 DB(`service.go:150`),不像 `ValidateAPIKey` 走 Redis。理由:

- Access token 数量级远高于 team(每个 user 多个 token,每个 team 多个 user)。
- Access token 通常代表"人",失效要求高:用户 logout / 改密码 / token revoke 后,要立刻失效。Redis 缓存的 5min TTL 太长,会让被撤销的 token 仍然有效 5 分钟。
- API Key 是 CI / 长期凭据,失效频率低,缓存收益大。

如果未来 access token 也需要缓存,可以加 30 秒级别的短 TTL cache,但目前 QPS 还没到必须优化的程度。

⚠️ 注意 2026.30 仍然保留了"按需失效"的思路,只是对象换成了 API Key:`InvalidateAPIKeyCache(hashedKey)`([`internal/service/service.go:294`](../packages/auth/pkg/auth/internal/service/service.go))在 API Key 被删除时精确失效单条 Redis 缓存,而 `InvalidateTeamCache` / `InvalidateTeamMemberCache` 分别失效 team 维度与 (user, team) 维度。

### 13.8 为什么 cache key 用 `userID-teamID` 而不是 `teamID`?

`ValidateAuthProviderTeam` 的 cache key([`internal/service/service.go:304`](../packages/auth/pkg/auth/internal/service/service.go);2026.29 为 `service.go:276`):

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
2. **discovery doc 能拉到吗**?服务启动时会同步拉,启动失败日志里会有 `fetch OIDC discovery document at <url>`([`internal/token/jwks/verifier.go:65`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go);2026.29 为 `oidc/oidc.go:74`,字符串相同)。
3. **JWKS 能拉到吗**?同上,2026.30 的启动日志是 `create JWKS storage`([`verifier.go:115`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go));⚠️ **2026.29 的字符串是 `create OIDC JWKS storage`**(`oidc/oidc.go:92`),多一个 `OIDC`,按新字符串搜旧日志会搜不到。
4. **`iss` claim 是否等于配置的 `issuer.url`**?JWT 解码后看 payload。
5. **`aud` claim 是否在配置的 `audiences` 里**?⚠️ **2026.29 与 2026.30 在这一点上语义不同**:2026.29 的"`audiences` 为空则不校验 aud"是一条**实际不可达**的分支(空 `audiences` 会在配置校验阶段就被拒),2026.30 起空 `audiences` 是**合法配置且真的不校验 aud**(见 §5.4)。
6. **(iss, sub) 在 `user_identities` 表里吗**?dashboard-api 是否完成了 provision?

### Q2: banned team 调 API 拿到 403 "team is banned"

这是预期行为。如果想解封:

```sql
UPDATE public.teams SET is_banned = FALSE WHERE id = '...';
```

注意:解封后要等 5 分钟(team cache TTL)或者主动调 `InvalidateTeamCache`。

### Q3: blocked team 拿到 403 "team is blocked: <reason>"

`blocked_reason` 字段会出现在错误消息里,直接展示给用户。如果想允许某条路由被 blocked team 访问,加到 `BlockedTeamAllowlist`。

### Q4: 服务启动失败 "fetch OIDC discovery document at ..."

**典型原因**:

- issuer URL 错误(404)。
- 网络/DNS 不通。
- 自签证书(测试环境)→ 配置 `httpClient` 信任证书,或者用 `discoveryURL` 指向本地 mirror。
- issuer URL 不是 https(且不是 loopback)→ `validateHTTPSURL` 拒绝([`internal/token/jwks/verifier.go:255`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go);2026.29 为 `oidc/oidc.go` 内同名函数)。

⚠️ 另一个高频但不在上面的原因:**discovery document 里的 `issuer` 与配置的 `issuer.url` 不一致**。2026.30 的报错是 `discovery document issuer %q does not match configured issuer %q`([`verifier.go:69`](../packages/auth/pkg/auth/internal/token/jwks/verifier.go);2026.29 为 `oidc/oidc.go:78`)。

⚠️ 2026.30 新增的 Admin JWT 走的是 `NewVerifierFromIssuerJWKS`,**完全不拉 discovery document**,所以 `ADMIN_AUTH_PROVIDER_CONFIG` 配错时不会出现这条错误,而是直接 401。

### Q5: `OIDCVerifier.Verify` 慢

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

`newOIDCVerifier` 里([`internal/token/provider.go:110-117`](../packages/auth/pkg/auth/internal/token/provider.go);2026.29 为 `verifier.go:73-84`):

```go
for i, entry := range normalized.JWT {
    s, err := newStrategy(ctx, entry, oidcHTTPClient, identities)
    strategies = append(strategies, s)
}
```

`Verify` 按配置顺序迭代。所以配置数组里的顺序就是优先级。如果两个 issuer 都能验同一个 token(罕见),排前面的胜出。

同样的"顺序即优先级 + 第一个成功即返回"也适用于 2026.30 新增的 `JWKSVerifier`(Admin JWT):[`internal/token/jwks_verifier.go:63-72`](../packages/auth/pkg/auth/internal/token/jwks_verifier.go)。

### Q8: Access Token 通过但 API Key 不行(或反之) —— ⛔ 2026.30 起不再适用

> 本节描述的是 **2026.29** 的场景;Access Token 已在 2026.30 删除(见 §4.2),不再存在"两种凭证表现不一致"的排查路径。

2026.29 下这通常是不同 team 的 banned/blocked 状态。检查 `public.teams.is_banned` / `is_blocked`。

⚠️ 2026.30 下如果出现"同一个 team 的 API Key 时好时坏",方向应转向 **Redis team cache**:`InvalidateTeamCache` / `InvalidateAPIKeyCache` 是否在 key 变更时被调用(见 Q6)。

### Q9: dashboard-api 能登但 api 服务不能调

dashboard-api 用 `AuthProviderBearerAuth` + `AuthProviderTeamAuth`(2026.30 又多了 `AdminJWTAuth`,见 §4.6),api 服务用 **6 个** Authenticator。⚠️ 2026.29 **也是 6 个**——2026.30 是「`NewAccessTokenAuthenticator` 被 `NewAdminJWTAuthenticator` 顶掉」,总数不变,不是净增。检查 api 服务的请求 header:

- `X-API-Key` 还是 `Authorization: Bearer ...`?
- Bearer 是 JWT 还是别的?⛔ 2026.30 起不再有 `sk_e2b_` 这种可能。
- 走 JWT 时有没有同时带 `X-Team-Id`?
- 是不是把 **Service JWT 当成用户 JWT** 用了?两者都是 `Authorization: Bearer <jwt>`,但用户 JWT 需要 `(iss, sub)` 在 `user_identities` 里有行,Service JWT 只看 `iss`/`exp`/`aud`/签名(见 §5.7)。

### Q10: 如何本地测试 OIDC?

2026.30 的 [`internal/token/jwks/testserver.go`](../packages/auth/pkg/auth/internal/token/jwks/testserver.go) 的 `NewTestServer` 启动一个 TLS mock OIDC 服务(2026.29 为 `oidc/testserver.go`):

```go
server := jwks.NewTestServer(t, publicKey, keyID, "https://test-issuer")
// 配置 AUTH_PROVIDER_CONFIG 指向 server.URL
```

注意 `discoveryIssuer` 参数可以和 `server.URL` 不同——用来测 issuer 与 discovery URL 不一致的场景。

⛔ **2026.30 起不能再照抄 `SignTestToken`**:它所在的 `packages/auth/pkg/tests/` 目录已整体删除(见 §12.4),2026.30 全仓库零引用。测试里需要签 JWT 请用 `github.com/golang-jwt/jwt/v5` 直接签,或参考 `internal/token/jwks/verifier_test.go` 的做法。

---

## 附录 A:认证方案速查表

### A.1 Header 与凭证映射

| 方案 | 必填 header | 凭证示例 | 前缀 | 谁用 |
|------|------------|---------|------|------|
| `ApiKeyAuth` | `X-API-Key` | `e2b_xxxx...` | `e2b_` | SDK / CI |
| `AuthProviderBearerAuth` | `Authorization` | `Bearer <user-jwt>` | (无) | dashboard-api |
| `AuthProviderTeamAuth` | `X-Team-ID` | `<team-uuid>` | (无) | dashboard-api(配合 Bearer) |
| `AdminApiKeyAuth` | `X-Admin-Token` | `<configured>` | (无) | E2B 运维 |
| `AdminJWTAuth`(2026.30 新增) | `Authorization` | `Bearer <service-jwt>` | (无) | 服务间调用(management plane → data plane) |
| `AdminTeamAuth` | `X-Team-ID` | `<team-uuid>` | (无) | E2B 运维(代某 team) |
| ~~`AccessTokenAuth`~~ | ~~`Authorization`~~ | ~~`Bearer sk_e2b_xxxx...`~~ | ~~`sk_e2b_`~~ | ⛔ 2026.30 删除 |

⚠️ `AuthProviderBearerAuth` 与 `AdminJWTAuth` **都是 `Authorization: Bearer`**,schema 层面无法区分,只能靠 JWT 内容:`AdminJWTAuth` 走 `JWKSVerifier`(只验 `iss`/`exp`/`aud`/签名,不看 `sub`),`AuthProviderBearerAuth` 走 `LinkedOIDCVerifier`(还要把 `(iss, sub)` 查成内部 `user_id`)。

⚠️ **两层的排序规则不一样**,别混为一谈(源码:`kin-openapi@v0.139.0/openapi3filter/validate_request.go`):

| 层级 | 规则 | 源码依据 |
| --- | --- | --- |
| **组间(OR)** | 按 `security:` **数组的书写顺序**依次尝试,第一个整组通过的胜出 | `ValidateSecurityRequirements` 里 `for _, sr := range srs`(`:402`) |
| **组内(AND)** | 把该组的 scheme 名**按字母序排序**后依次校验 | `validateSecurityRequirement` 里 `names` 收集后 `slices.Sort(names)`(`:420-424`) |

所以 spec 里那句 `# AdminApiKeyAuth / AdminTeamAuth: alphabetical names ensure token validation runs before team context population.` 是**准确**的——它说的是**组内**顺序。而组间谁先谁后,完全取决于你在 `security:` 里怎么写。

以 `/teams/{teamID}/metrics` 为例([`spec/openapi.yml:2377-2384`](../spec/openapi.yml)):

```yaml
security:
  - ApiKeyAuth: []
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
  - AdminApiKeyAuth: []
    AdminTeamAuth: []
  - AdminJWTAuth: []
    AdminTeamAuth: []
```

⚠️ 注意最后一组是 **AND**:`AdminJWTAuth` 在 spec 里**从不单独出现**(48 处使用全部与 `AdminTeamAuth` 成组),所以走 Service JWT 的请求**必须同时带 `Authorization: Bearer <service-jwt>` 和 `X-Team-ID`**,否则该组无法完整通过。

### A.2 OpenAPI spec 示例

2026.30 的实际定义([`spec/openapi.yml:10-33`](../spec/openapi.yml)):

```yaml
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
    AuthProviderBearerAuth:
      type: http
      scheme: bearer
      bearerFormat: access_token
    AuthProviderTeamAuth:
      type: apiKey
      in: header
      name: X-Team-ID
    AdminApiKeyAuth:
      type: apiKey
      in: header
      name: X-Admin-Token
    AdminJWTAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    AdminTeamAuth:
      type: apiKey
      in: header
      name: X-Team-ID

paths:
  /sandboxes:
    post:
      security:
        - ApiKeyAuth: []
        - AuthProviderBearerAuth: []
          AuthProviderTeamAuth: []
```

⚠️ 2026.29 的差异:(1) 多一个 `AccessTokenAuth`(`type: http` / `scheme: bearer` / **`bearerFormat: access_token`** / 带 `description` 标注 deprecated),13 处引用,2026.30 全部删除;(2) 没有 `AdminJWTAuth`;(3) `AuthProviderTeamAuth` 的 header 名在 spec 里是 **`X-Team-ID`**(全大写 `ID`),不是 `X-Team-Id`;(4) 老文档此处把 `AccessTokenAuth.bearerFormat` 写成 `sk_e2b_`,**这在 2026.29 就是错的**——`sk_e2b_` 是 token 前缀,不是 spec 里的 `bearerFormat`。

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
| JWT 配置关闭(用户 JWT) | `APIError{401}` | 401 | Backend authentication failed |
| JWT 验签失败 | `APIError{401}` | 401 | Backend authentication failed |
| JWT aud 不匹配 | `APIError{401}` | 401 | Backend authentication failed |
| JWT 身份表无对应行 | `APIError{401}` | 401 | Backend authentication failed |
| Service JWT 验证器未配置 | `APIError{401}` | 401 | Invalid service token. |
| Service JWT 验签失败 / `iss` 缺失 | `APIError{401}` | 401 | Invalid service token. |
| team banned | `APIError{403}` | 403 | team is banned |
| team blocked(在中间件) | `*auth.TeamBlockedError` | 403 | team is blocked: <reason> |
| team blocked(handler 主动检查) | `*auth.TeamBlockedError` | 403 | team is blocked: <reason> |
| Admin token 错 | `APIError{401}` | 401 | Invalid Access token. |
| ginCtx 没 user_id(配置错误) | `APIError{500}` | 500 | Backend authentication failed |
| 配置错误的 scheme | `fmt.Errorf` | 500(默认) | invalid security scheme name |
| ~~Access Token 格式错~~ | ⛔ 2026.30 删除 | — | ~~Invalid access token format~~ |
| ~~Access Token DB 查不到~~ | ⛔ 2026.30 删除 | — | ~~Cannot get the user for the given access token~~ |

⚠️ 响应体形状([`packages/shared/pkg/apierrors/apierrors.go:32-44`](../packages/shared/pkg/apierrors/apierrors.go)):

```go
body := gin.H{"code": int32(apiErr.Code), "message": apiErr.ClientMsg}
if apiErr.ErrorCode != "" {
    body["error_code"] = apiErr.ErrorCode   // 2026.30 新增
}
```

`error_code` 是**可选的机器可读语义码**,**非封闭集合**。OpenAPI 里给出的初始取值是 `sandbox_capacity_unavailable`、`sandbox_placement_timeout`、`sandbox_no_compatible_node`、`sandbox_create_failed`、`internal_server_error`([`packages/api/internal/api/api.gen.go:417`](../packages/api/internal/api/api.gen.go))。⚠️ **auth 模块本身不产出任何 `error_code`**——2026.30 全仓库搜索 `ErrorCode:` 赋值,命中全在 api 的 sandbox / orchestrator 侧。没有 `ErrorCode` 时该字段**不出现在 body 里**(不是空字符串)。

⚠️ 错误类型名:公开层是 `auth.TeamForbiddenError` / `auth.TeamBlockedError`(type alias),实现层是 `internal/team.ForbiddenError` / `internal/team.BlockedError`。2026.29 这两个名字都直接在 `pkg/auth` 下定义,且没有 `internal` 版本。

---

## 附录 C:术语表

| 术语 | 含义 |
|------|------|
| **API Key** | 长期凭据,`e2b_` 前缀,代表 team,存 `team_api_keys` |
| ~~**Access Token**~~ | ⛔ 用户凭据,`sk_e2b_` 前缀,代表 user,存 `access_tokens`;2026.30 连同表和函数一并删除 |
| **Service JWT** | 2026.30 新增的第三种内部凭证,`AdminJWTAuth` 方案使用,`ADMIN_AUTH_PROVIDER_CONFIG` 驱动,只验 `iss`/`exp`/`aud`/签名 |
| **OIDC** | OpenID Connect,基于 OAuth 2.0 的身份层 |
| **JWT** | JSON Web Token,自包含的 token 格式 |
| **JWKS** | JSON Web Key Set,OIDC issuer 公开的公钥集合 |
| **discovery document** | `/.well-known/openid-configuration`,OIDC issuer 的元数据 |
| **issuer (iss)** | JWT 签发者的 URL,唯一标识一个 OIDC 提供商 |
| **subject (sub)** | 用户在 OIDC 提供商处的唯一 ID |
| **audience (aud)** | JWT 的目标受众,标识这个 token 是给谁用的 |
| **claim** | JWT payload 里的字段,如 `iss`、`sub`、`aud`、`exp` |
| **team** | E2B 的计费/资源单位,一个组织或个人 |
| **banned** | team 永久禁用,所有路径都拒绝(2026.29 起即有) |
| **blocked** | team 临时禁用,白名单路由允许通过(2026.29 起即有) |
| **tier** | team 的套餐等级,决定配额 |
| **IdentityLookup** | `(iss, sub) → user_id` 的查询接口 |
| **JWKSVerifier** | 2026.30 新增:只走 issuer 的 JWKS,不拉 discovery、不做身份映射 |
| **OIDCVerifier** | 2026.30 新增:discovery + claims 校验,返回 token 自己声称的身份,不做映射 |
| **LinkedOIDCVerifier** | `OIDCVerifier` + `IdentityLookup`,即 2026.29 的 `Verifier` |
| ~~**Verifier**~~ | 2026.29 的多 issuer 聚合器;2026.30 拆成上面三个类型,公开别名 `OIDCIssuerVerifier` 指单 issuer 的 `oidc.Verifier` |
| **Authenticator** | OpenAPI 安全方案分发器接口 |
| **singleflight** | 合并并发同 key 的请求,只发一次底层调用 |
| **cache-aside** | 读时先查缓存,miss 再查 DB 然后回填 |
| ~~**read replica**~~ | ⛔ 2026.30 起 auth DB 不再读写分离(见 §9.4) |
| **feature flag** | 通过环境变量开关的功能,这里指 `AUTH_PROVIDER_CONFIG` / `ADMIN_AUTH_PROVIDER_CONFIG` |
