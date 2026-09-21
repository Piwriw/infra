# E2B Access Tokens(用户级 Access Token)模块详解

> ## ⛔ 模块已于 2026.30 完全退役
>
> **本模块当前不存在。** 2026.30 完成了弃用的最后一步:spec 删掉 path、DB `DROP TABLE`、handler 删除、feature flag 删除、认证器删除。本文档从"deprecated 流程说明"转为**历史档案 + 迁移指引**。
>
> **今天应该用什么:**
>
> | 场景 | 用什么 |
> | --- | --- |
> | SDK / CLI 调 E2B API | team 级 API Key,`X-API-Key: e2b_...` |
> | 浏览器 / 用户交互式登录 | OIDC bearer(`AuthProviderBearerAuth`) |
> | 内部服务调管理面 | Admin API Key 或 Admin JWT |
>
> **还在用 `E2B_ACCESS_TOKEN` 的集成会拿到什么:** `POST /access-tokens` 与 `DELETE /access-tokens/:id` 现在返回 **`410 Gone`**(见 §零.2)。其他任何带 `Authorization: Bearer sk_e2b_...` 的请求会在认证阶段直接失败——spec 里已无 `AccessTokenAuth` scheme。
>
> 迁移指引:https://e2b.dev/docs/migration/access-token-deprecation
>
> ---
>
> **本文档的结构**:
> - **§零** — 2026.30 退役了什么,怎么迁移(只有这节描述当前状态)
> - **§一 ~ §十二 + 附录** — **历史档案**,描述 2026.29 及之前的实现。其中的代码路径、行号、flag 名都已不存在,保留是为了理解弃用期为什么这样设计。

---

## 零、2026.30 退役总结

### 零.1 被删除的清单

| 类别 | 2026.29 存在 | 2026.30 状态 |
| --- | --- | --- |
| OpenAPI path | `POST /access-tokens`、`DELETE /access-tokens/{accessTokenID}` | **从 spec 删除** |
| OpenAPI security scheme | `AccessTokenAuth`(12 处 `security:` 引用) | **全部删除** |
| Handler | `packages/api/internal/handlers/accesstoken.go` | **文件删除**(含 `accesstoken_test.go`) |
| Handler 方法 | `APIStore.GetUserFromAccessToken` | **删除** |
| 认证器 | `auth.NewAccessTokenAuthenticator(...)` | **从 `main.go` 的 authenticator 链删除** |
| 认证器数量 | 6 个 | 6 个(删 1 加 1:新增 `NewAdminJWTAuthenticator`) |
| Feature flag | `disable-e2b-access-token-provisioning`、`disable-e2b-access-token-auth` | **两个 flag 定义都删除** |
| sqlc 查询 | `create_access_token.sql.go`、`delete_access_token.sql.go`、`get_user_id_from_access_token.sql.go` | **全部删除** |
| DB 表 | `public.access_tokens` | **`DROP TABLE`** |
| DB 函数 | `public.generate_access_token()` | **`DROP FUNCTION`** |

对应迁移:[`packages/db/migrations/20260823120000_drop_access_tokens.sql`](../packages/db/migrations/20260823120000_drop_access_tokens.sql)

```sql
-- +goose Up

-- E2B user access tokens (sk_e2b_) are removed: nothing issues, validates,
-- or purges them anymore. The remaining rows are hashes of revoked
-- credentials.
DROP TABLE IF EXISTS public.access_tokens;
DROP FUNCTION IF EXISTS public.generate_access_token();
```

> ⚠️ **这条迁移是不可逆的数据删除**。`Down` 段虽然重建了表和函数,但**行数据不会回来**——drop 前的 `access_token_hash` 已丢失。注释里说得很直接:留下的只是"已吊销凭证的哈希"。如果某个环境还没跑这条迁移,别指望能回滚出数据。
>
> ⚠️ 同一窗口还有一条**无关的**清理:[`20260727041400_drop_duplicate_access_tokens_hash_index.sql`](../packages/db/migrations/20260727041400_drop_duplicate_access_tokens_hash_index.sql) 只是删掉重复的唯一索引(`idx_access_tokens_access_token_hash` 与 UNIQUE 约束自带的索引重复),用 `DROP INDEX CONCURRENTLY` + `statement_timeout` 控制锁等待。这条在 2026.30 之前就已合入,不要和退役迁移混淆。

### 零.2 410 兜底:为什么旧客户端拿到的是 410 而不是 404

handler 删掉后,path 也从 spec 里消失了。但 oapi-codegen 的 validator middleware 对 **spec 中不存在的 path 会返回 404** —— 对还在用旧 SDK 的调用方来说,404 看起来像"路径打错了",而不是"这个功能被移除了"。

所以 [`main.go:166-173`](../packages/api/main.go) 在 validator **之前**手工注册了两个兜底路由:

```go
// Access tokens are removed. Registered before the OpenAPI validator
// middleware (which rejects paths missing from the spec) so old clients
// get a clear 410 instead of a 404.
accessTokensGone := func(c *gin.Context) {
    apierrors.SendAPIStoreError(c, http.StatusGone, "E2B_ACCESS_TOKEN is deprecated and no longer supported. Use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation")
}
r.POST("/access-tokens", accessTokensGone)
r.DELETE("/access-tokens/:accessTokenID", accessTokensGone)
```

> ⚠️ **注册顺序是这段代码的全部要点**。Gin 的 `r.Use(...)` 与路由注册都在 `NewGinServer` 里,但 `OapiRequestValidatorWithOptions` 是作为**全局 middleware** 挂上去的,它在请求进入时会先按 spec 校验 path。这两条 `r.POST` / `r.DELETE` 必须写在 `r.Use(...)` **之前**才能抢到——实际上它们就在 `r.Use(customMiddleware.CORS())` 后面、`AuthenticationFunc` 构造之前(`main.go:164-173`)。
>
> ⚠️ 兜底路由**不做任何鉴权**。任何人 POST 到这个 path 都会拿到 410,不需要凭证。这是有意的:410 不泄露任何信息,也没必要为已删除的功能浪费一次 auth 查询。

### 零.3 弃用时间线(完整轨迹)

| 阶段 | 版本 | 动作 |
| --- | --- | --- |
| 引入弃用标记 | 2026.16–2026.28 | `POST /access-tokens` 标 `deprecated: true`,新增 410 响应定义;引入 `disable-e2b-access-token-provisioning`(控制签发)与 `disable-e2b-access-token-auth`(控制接收)两个 LD flag;`AccessTokenAuth` scheme 加 deprecated 说明 |
| 索引清理 | 2026.29 之前 | `20260727041400` 删除重复唯一索引 |
| **完全退役** | **2026.30** | 见 §零.1 |

> 2026.16→2026.28 的弃用细节见 [`api-changes-2026.16-2026.28.md` §1.2](./api-changes-2026.16-2026.28.md)。当时的设计是"flag 门控的渐进式弃用",现在回头看:两个 flag 最后**没有经历"逐步开启"**——直接在 2026.30 连 flag 带功能一起删了。

## 目录

- [零、2026.30 退役总结](#零202630-退役总结) ← **只有这节描述当前状态**
  - [零.1 被删除的清单](#零1-被删除的清单)
  - [零.2 410 兜底:为什么旧客户端拿到的是 410 而不是 404](#零2-410-兜底为什么旧客户端拿到的是-410-而不是-404)
  - [零.3 弃用时间线(完整轨迹)](#零3-弃用时间线完整轨迹)
- [一、概述](#一概述)
  - [1.1 access-tokens 是什么](#11-access-tokens-是什么)
  - [1.2 关键定位:与 api-keys 的对照](#12-关键定位与-api-keys-的对照)
  - [1.3 关键心智模型](#13-关键心智模型)
  - [1.4 整体架构](#14-整体架构)
- [二、核心概念](#二核心概念)
  - [2.1 Access Token 的三层表示](#21-access-token-的三层表示)
  - [2.2 Hash 策略:与 api-keys 共用 SHA256](#22-hash-策略与-api-keys-共用-sha256)
  - [2.3 Mask 策略:与 api-keys 共用](#23-mask-策略与-api-keys-共用)
  - [2.4 User 绑定(非 team)](#24-user-绑定非-team)
  - [2.5 Deprecated 语义与 410 Gone](#25-deprecated-语义与-410-gone)
- [三、整体架构](#三整体架构)
  - [3.1 装配序列](#31-装配序列)
  - [3.2 依赖图](#32-依赖图)
  - [3.3 数据流总览](#33-数据流总览)
- [四、2 个端点逐一解析](#四2-个端点逐一解析)
  - [4.1 POST /access-tokens — 创建(deprecated,可能返 410)](#41-post-access-tokens--创建deprecated可能返-410)
  - [4.2 DELETE /access-tokens/{accessTokenID} — 删除](#42-delete-access-tokensaccesstokenid--删除)
- [五、关键流程时序图](#五关键流程时序图)
  - [5.1 创建(happy path)](#51-创建happy-path)
  - [5.2 创建(flag 开启 → 410)](#52-创建flag-开启--410)
  - [5.3 删除](#53-删除)
- [六、keys 包复用说明](#六keys-包复用说明)
- [七、数据模型](#七数据模型)
  - [7.1 `access_tokens` 表结构](#71-access_tokens-表结构)
  - [7.2 sqlc 查询](#72-sqlc-查询)
- [八、与 auth 验证链路的闭环](#八与-auth-验证链路的闭环)
  - [8.1 验证路径:为什么 access token 走的是另一条路](#81-验证路径为什么-access-token-走的是另一条路)
  - [8.2 没有 last_used 更新(与 api-keys 的差异)](#82-没有-last_used-更新与-api-keys-的差异)
  - [8.3 删除后如何失效](#83-删除后如何失效)
- [九、配置与 Feature Flag](#九配置与-feature-flag)
- [十、关键代码文件索引](#十关键代码文件索引)
- [十一、设计要点与权衡](#十一设计要点与权衡)
- [十二、常见问题与排查](#十二常见问题与排查)
- [附录 A:端点速查表](#附录-a端点速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录-b错误码与-http-状态映射)
- [附录 C:术语表](#附录-c术语表)

---

> # 📜 以下为历史档案(§一 ~ §十二 + 附录)
>
> **这些章节描述的是 2026.29 及之前的实现,不是当前代码。** 其中的 handler 路径、sqlc 查询、flag 名、行号、DB 表都已在 2026.30 删除(清单见 [§零.1](#零1-被删除的清单))。
>
> 保留它们的理由:理解一个模块**为什么**要这样设计(为什么 410 而不是 404、为什么没有 GET、为什么验证不缓存),比记住它现在不存在更有价值——将来下线别的功能时会遇到同样的问题。
>
> **要查当前状态,看 [§零](#零202630-退役总结)。要查排障,看 [§十二](#十二常见问题与排查)(已按当前状态重写)。**

---

## 一、概述

### 1.1 access-tokens 是什么

> ⓘ **历史**:本节描述 2026.29 的状态。该模块已于 2026.30 完全退役。

`access-tokens` 是**用户级**鉴权凭证的管理接口,在 OpenAPI 里标记为 `tags: [access-tokens]`,共 **2 个端点**:

| 路径 | 方法 | 功能 | Handler | 状态 |
| --- | --- | --- | --- | --- |
| `/access-tokens` | POST | 创建新 access token | `PostAccessTokens` | **deprecated**(spec 标 `deprecated: true`) |
| `/access-tokens/{accessTokenID}` | DELETE | 删除 access token | `DeleteAccessTokensAccessTokenID` | 正常 |

> **缺失的端点**(对比 api-keys):
> - **没有 GET**:无法列出已存在的 access token。
> - **没有 PATCH**:无法重命名。

**典型调用方**:旧版 SDK(`e2b-python-sdk` < 某版本)、旧 CLI。新版 SDK 已迁移到 API Key。

### 1.2 关键定位:与 api-keys 的对照

| 维度 | `/access-tokens`(本文档) | `/api-keys`(对照) |
| --- | --- | --- |
| 凭证绑定 | **user** | **team** |
| 前缀 | `sk_e2b_`(7 字符) | `e2b_`(4 字符) |
| 用法 | `Authorization: Bearer sk_e2b_...` | `X-API-Key: e2b_...` |
| 鉴权(管理端点) | `AuthProviderBearerAuth` only | `AuthProviderBearerAuth + AuthProviderTeamAuth`(OIDC 链),部分有 admin 兜底 |
| 端点数 | 2(POST + DELETE) | 4(GET + POST + PATCH + DELETE) |
| 状态 | **deprecated**(flag 开启 → 410) | active |
| WHERE 过滤 | `WHERE id AND user_id` | `WHERE id AND team_id` |
| `created_by` 字段 | 无(本身就是 user_id 主属性) | 有(可空,admin 路径填 nil) |
| `last_used` 字段 | **无** | 有(异步更新) |
| 缓存 | **无** auth 模块缓存(每次直查 DB) | teamCache(5 分钟 TTL) |

底层共用 `keys.GenerateKey` / `keys.VerifyKey`(`packages/shared/pkg/keys/`),只是 prefix 不同。

### 1.3 关键心智模型

理解 access-tokens 模块只需记住五句话:

1. **用户级**,不是 team 级。一把 token 只属于一个 user,但**调业务 API 时会落到 user 的 default team**(由 SDK 解析)。
2. **Deprecated**。LaunchDarkly flag `disable-e2b-access-token-provisioning` 开启时,POST 返 `410 Gone` 并提示用户改用 `E2B_API_KEY`。
3. **明文只在响应里出现一次**(同 api-keys)。DB 只存 SHA256 hash。
4. **DELETE 不受 deprecated 影响**。即使用户不能创建,也能删除已有的旧 token,避免遗留垃圾。
5. **没有 GET / PATCH**。用户创建后看到明文 token 必须立刻保存,否则只能通过 mask 字段对比删除。

### 1.4 整体架构

```
                  ┌──────────────────────────────────┐
                  │  旧版 SDK / CLI                   │
                  │  OIDC 登录 → JWT                  │
                  └──────────────┬───────────────────┘
                                 │
                                 │  Authorization: Bearer <JWT>
                                 │
                                 │  操作 /access-tokens:
                                 │    POST   (创建,可能 410)
                                 │    DELETE (按 ID 删除)
                                 ▼
        ┌────────────────────────────────────────────────────┐
        │                API (Gin + oapi-codegen)            │
        │                                                  │
        │  AuthProviderBearerAuth → 解 JWT → userID         │
        │                                                  │
        │  handlers/accesstoken.go:                         │
        │   - PostAccessTokens                              │
        │     ├── 检查 DisableE2BAccessTokenProvisioningFlag│
        │     │   ↑ true → 410 Gone + 迁移指引              │
        │     ├── keys.GenerateKey("sk_e2b_")               │
        │     └── authDB.Write.CreateAccessToken             │
        │   - DeleteAccessTokensAccessTokenID               │
        │     └── authDB.Write.DeleteAccessToken             │
        │         (WHERE id AND user_id)                    │
        └────────────┬─────────────────────────────────────┘
                     │
                     ▼
              ┌──────────────────┐
              │  Auth DB (PgSQL) │
              │  access_tokens   │
              └──────────────────┘
```

---

## 二、核心概念

### 2.1 Access Token 的三层表示

与 api-keys 完全同构,只是 prefix 不同:

| 形式 | 字段 | 示例 | 何处出现 |
| --- | --- | --- | --- |
| **明文(PrefixedRawValue)** | `Key.PrefixedRawValue` | `sk_e2b_a1b2c3d4e5f6...`(共 47 字符) | 创建时返回,**仅此一次** |
| **Hash** | `Key.HashedValue` + DB `access_token_hash` | `$sha256$<43 字符 base64>`(总 51 字符) | DB UNIQUE 索引、验证时比对 |
| **Mask** | `Key.Masked` | `{Prefix: "sk_e2b_", Length: 40, MaskPrefix: "a1", MaskSuffix: "wxyz"}` | POST 响应(无 GET,所以无列表场景) |

**长度计算**:
- `keyLength = 20`(字节数,见 `packages/shared/pkg/keys/key.go:15`)
- hex 编码后 40 字符
- 加 prefix `sk_e2b_`(7 字符)= **47 字符**(明文总长)

### 2.2 Hash 策略:与 api-keys 共用 SHA256

详见 [api-keys-module.md 的 2.2 节](./api-keys-module.md#22-hash-策略sha256不是-bcrypt)。完全一样的实现(`packages/shared/pkg/keys/sha256.go`):

```go
func (h *Sha256Hashing) Hash(key []byte) string {
    hashBytes := sha256.Sum256(key)
    hash64 := base64.RawStdEncoding.EncodeToString(hashBytes[:])
    return fmt.Sprintf("$sha256$%s", hash64)
}
```

api-keys 和 access-tokens 共用同一个 hasher(实例化在 `keys/key.go:18` 的 `var hasher Hasher = NewSHA256Hashing()`)。区别只在生成时传入的 prefix 不同。

### 2.3 Mask 策略:与 api-keys 共用

完全同构,详见 [api-keys-module.md 的 2.3 节](./api-keys-module.md#23-mask-策略固定窗口)。前 2 字符 + 后 4 字符,中间字符不暴露。

### 2.4 User 绑定(非 team)

```sql
-- access_tokens 表的核心字段
user_id            uuid   NOT NULL,    -- 必须,绑定到 user
access_token_hash  text   UNIQUE,      -- 唯一索引
-- 没有 created_by(对比 team_api_keys 表)
-- 没有 team_id
```

- `user_id` 必填。一把 token 只属于一个 user。
- **没有 `team_id`**:token 本身不绑定 team。但 SDK 用 token 调业务 API 时,auth 链路会查 user 的 default team 并注入到 ctx。
- **没有 `created_by`**:`user_id` 本身就是创建者,不需要单独字段。

### 2.5 Deprecated 语义与 410 Gone

OpenAPI spec(`spec/openapi.yml:3572`)显式标记:

```yaml
/access-tokens:
  post:
    summary: Create access token
    description: Create a new access token. Deprecated; use an API key (E2B_API_KEY) instead.
    deprecated: true   # ← OpenAPI 工具会在文档里显示 "Deprecated" 徽章
    tags: [access-tokens]
    ...
    responses:
      "201": ...
      "410":              # ← spec 里声明了 410,但代码用 feature flag 控制
        $ref: "#/components/responses/410"
```

**三层 deprecated / cutover 信号**:
1. **静态层**(spec):`deprecated: true` — Swagger UI / 文档生成器会标灰,提醒客户端不要再用。
2. **停止签发**:`disable-e2b-access-token-provisioning` 默认 `false`。开启后只有 `POST /access-tokens` 立即返 `410 Gone`,已有 token 仍可能被接受。
3. **停止认证**:`disable-e2b-access-token-auth` 默认 `false`。开启后 API 和 docker-reverse-proxy 的 V1 build docker login 都拒绝已有 `sk_e2b_` token。

两个运行时 flag 都按 user 灰度,把 issuance/provisioning 与 acceptance/auth 分开:可以先阻止新 token 增长,观察迁移情况,最后再关闭旧 token 的实际使用。

---

## 三、整体架构

### 3.1 装配序列

`access-tokens` 端点不需要专门的装配,由 `APIStore` 直接挂载,共享全局 OpenAPI 中间件。路由注册发生在 oapi-codegen 生成的 `RegisterHandlers` 里:

```go
r.POST  ("/access-tokens",                middleware → apiStore.PostAccessTokens)
r.DELETE("/access-tokens/:accessTokenID", middleware → apiStore.DeleteAccessTokensAccessTokenID)
```

中间件链:
1. `limits.RequestSizeLimiter` — body 大小限制
2. `middleware.OapiRequestValidatorWithOptions` — schema 校验 + 鉴权(只用 `AuthProviderBearerAuth`)

### 3.2 依赖图

```
APIStore
├── authDB   (packages/db/pkg/auth.Client)
│   ├── Write.CreateAccessToken
│   └── Write.DeleteAccessToken
├── featureFlags (LaunchDarkly client)
│   └── BoolFlag(DisableE2BAccessTokenProvisioningFlag, UserContext(userID))
└── authService (仅间接,通过 ctx 拿 userID)
```

### 3.3 数据流总览

```
HTTP 请求
   │
   ▼
Gin 中间件
   │
   ├── schema 校验
   ├── AuthProviderBearerAuth 验证 → setUserID(ctx, userID)
   │                            (注意:没有 AuthProviderTeamAuth)
   ▼
Handler (accesstoken.go)
   │
   ├── POST:
   │    ├── userID := auth.MustGetUserID(c)
   │    ├── 检查 DisableE2BAccessTokenProvisioningFlag
   │    │   └── true → 410 Gone + 迁移指引
   │    ├── keys.GenerateKey("sk_e2b_")
   │    └── authDB.Write.CreateAccessToken
   │
   └── DELETE:
        ├── userID := auth.MustGetUserID(c)
        ├── parse accessTokenID (UUID)
        └── authDB.Write.DeleteAccessToken
            └── WHERE id AND user_id
```

---

## 四、2 个端点逐一解析

### 4.1 POST /access-tokens — 创建(deprecated,可能返 410)

**Handler**:`APIStore.PostAccessTokens` (`packages/api/internal/handlers/accesstoken.go:20`)

**鉴权**:

```yaml
security:
  - AuthProviderBearerAuth: []
```

注意:**只有 OIDC**,**没有 admin 兜底**(对比 GET /api-keys 有 admin 兜底)。原因:access token 严格绑定 user,内部服务不应该代用户创建。

**流程**(`accesstoken.go:20-79`):

```go
userID := auth.MustGetUserID(c)

// 1. 检查 deprecated flag — 关键的 deprecated 实施
if a.featureFlags.BoolFlag(ctx, featureflags.DisableE2BAccessTokenProvisioningFlag, featureflags.UserContext(userID.String())) {
    a.sendAPIStoreError(c, http.StatusGone,
        "Creating new access tokens is disabled. E2B_ACCESS_TOKEN is deprecated; "+
        "use an API key (E2B_API_KEY) instead. "+
        "See https://e2b.dev/docs/migration/access-token-deprecation")
    return
}

body, err := ginutils.ParseBody[api.NewAccessToken](ctx, c)   // {name: "..."}
// ...

// 2. 本地生成 token(与 api-keys 完全同构)
accessToken, err := keys.GenerateKey(keys.AccessTokenPrefix)  // "sk_e2b_"
// ...

// 3. 落库
accessTokenDB, err := a.authDB.Write.CreateAccessToken(ctx, authqueries.CreateAccessTokenParams{
    ID:                    uuid.New(),                        // ← 显式生成 UUID(api-keys 用 DB 默认)
    UserID:                userID,
    AccessTokenHash:       accessToken.HashedValue,
    AccessTokenPrefix:     accessToken.Masked.Prefix,
    AccessTokenLength:     int32(accessToken.Masked.ValueLength),
    AccessTokenMaskPrefix: accessToken.Masked.MaskedValuePrefix,
    AccessTokenMaskSuffix: accessToken.Masked.MaskedValueSuffix,
    Name:                  body.Name,
})
// ...

// 4. 一次性返回明文
c.JSON(http.StatusCreated, api.CreatedAccessToken{
    Id:    accessTokenDB.ID,
    Token: accessToken.PrefixedRawValue,    // ← 明文!仅此一次
    Mask:  api.IdentifierMaskingDetails{...},
    Name:  accessTokenDB.Name,
    CreatedAt: accessTokenDB.CreatedAt,
})
```

**关键点**:

1. **flag 检查在 body 解析之前**:即使 body 不合法,只要 flag 开启就立即返 410,不浪费 parsing。
2. **flag 按 user 维度**:`featureflags.UserContext(userID.String())` — LaunchDarkly 支持按用户分批灰度(先内部用户、再 10%、再全量)。
3. **显式 `uuid.New()`**:对比 api-keys 用 DB 默认(`DEFAULT gen_random_uuid()`),这里在应用层生成。两种都行,主要差异是历史代码演化(api-keys 写得更早)。
4. **`Token` 字段返回明文**:`accessToken.PrefixedRawValue`(`sk_e2b_...` 47 字符)。**仅此一次**,与 api-keys 一致。
5. **没有 telemetry.SetAttributes(maskedAccessToken)**:对比 `ValidateAccessToken` 里有埋点,这里**没有**——创建时不上报 mask,只有后续鉴权时才上报。这是为了避免创建事件和鉴权事件混淆。
6. **不检查 blocked**:对比 admin 路径的 POST /api-keys 会主动检查 team blocked,这里完全不查 team,所以也不涉及 blocked。

**响应**:`201 Created` + JSON body,或在 flag 开启时 `410 Gone` + 错误消息。

### 4.2 DELETE /access-tokens/{accessTokenID} — 删除

**Handler**:`APIStore.DeleteAccessTokensAccessTokenID` (`accesstoken.go:81`)

**鉴权**:`AuthProviderBearerAuth` only(同 POST)。

**关键设计**:**不受 deprecated flag 影响**。即使用户不能创建新 token,也能删除已有的旧 token,避免遗留不可清理的凭证。

**流程**(`accesstoken.go:81-112`):

```go
userID := auth.MustGetUserID(c)

accessTokenIDParsed, err := uuid.Parse(accessTokenID)
if err != nil {
    // 400 "Error when parsing access token ID"
}

_, err = a.authDB.Write.DeleteAccessToken(ctx, authqueries.DeleteAccessTokenParams{
    ID:     accessTokenIDParsed,
    UserID: userID,           // ← WHERE id AND user_id
})
if dberrors.IsNotFoundError(err) {
    c.String(http.StatusNotFound, "id not found")
    return
} else if err != nil {
    // 500
}

c.Status(http.StatusNoContent)
```

**关键点**:
- SQL 用 `WHERE id AND user_id`,**防跨 user 删除**(纵深防御,即使构造请求 `/access-tokens/{别人的 token id}` 也匹配不到)。
- **找不到返 404**(不是 204),让客户端能区分"已删除"和"不存在"。
- 成功返 `204 No Content`,无 body。

---

## 五、关键流程时序图

### 5.1 创建(happy path)

```
旧版 SDK          API (PostAccessTokens)         Auth DB
   │                     │                          │
   │ 1. 登录(OIDC)       │                          │
   │<───────────────────>│                          │
   │                     │                          │
   │ 2. 创建 token        │                          │
   │   "my-token"        │                          │
   ├────────────────────>│                          │
   │                     │                          │
   │                     │ 3. 检查 DisableFlag       │
   │                     │   (LaunchDarkly)          │
   │                     │   flag=false(允许)        │
   │                     │                          │
   │                     │ 4. keys.GenerateKey()    │
   │                     │   (sk_e2b_ + 40 字符)    │
   │                     │                          │
   │                     │ 5. Write.CreateAccessToken│
   │                     ├─────────────────────────>│
   │                     │                     INSERT
   │                     │<─────────────────────────┤
   │                     │                          │
   │ 6. 201 Created      │                          │
   │   {                 │                          │
   │     id, name,       │                          │
   │     token:"sk_e2b_..", ← 明文!仅此一次       │
   │     mask:{...}      │                          │
   │   }                 │                          │
   │<────────────────────┤                          │
```

### 5.2 创建(flag 开启 → 410)

```
旧版 SDK          API (PostAccessTokens)         LaunchDarkly
   │                     │                          │
   │ POST /access-tokens │                          │
   ├────────────────────>│                          │
   │                     │                          │
   │                     │ 1. BoolFlag(DisableFlag, │
   │                     │       UserContext(userID))│
   │                     ├─────────────────────────>│
   │                     │                          │
   │                     │       true (flag 开启)   │
   │                     │<─────────────────────────┤
   │                     │                          │
   │ 2. 410 Gone         │                          │
   │   "E2B_ACCESS_TOKEN  │                          │
   │    is deprecated;   │                          │
   │    use E2B_API_KEY  │                          │
   │    instead. See ..."│                          │
   │<────────────────────┤                          │
   │                     │                          │
   │ 3. SDK 报错          │                          │
   │   指引用户迁移       │                          │
```

### 5.3 删除

```
用户              dashboard / CLI        API                   Auth DB
 │                    │                  │                       │
 │ 删除某把 token     │                  │                       │
 ├───────────────────>│                  │                       │
 │                    │ DELETE /access-tokens/{id}               │
 │                    │   Authorization: Bearer <JWT>            │
 │                    ├─────────────────>│                       │
 │                    │                  │ 解析 userID from JWT  │
 │                    │                  │                       │
 │                    │                  │ Write.DeleteAccessToken│
 │                    │                  │  WHERE id AND user_id │
 │                    │                  ├──────────────────────>│
 │                    │                  │<──────────────────────┤
 │                    │                  │  (1 行删除 或 0 行)   │
 │                    │                  │                       │
 │                    │ 204 No Content   │                       │
 │                    │  (或 404 找不到) │                       │
 │                    │<─────────────────┤                       │
```

---

## 六、keys 包复用说明

access-tokens **完全复用** api-keys 的 keys 包,没有任何独立的 key 处理逻辑。

| 共用 API | 入口 | 差异点 |
| --- | --- | --- |
| `keys.GenerateKey(prefix)` | `keys/key.go:66` | 入参 `prefix` 不同:`keys.ApiKeyPrefix` vs `keys.AccessTokenPrefix` |
| `keys.MaskKey(prefix, value)` | `keys/key.go:34` | 无差异(纯函数) |
| `keys.VerifyKey(prefix, key)` | `keys/key.go:100` | 入参 `prefix` 不同 |
| `keys.MaskToken(prefix, token)` | `keys/key.go:90` | 入参 `prefix` 不同 |
| `keys.SHA256Hashing.Hash()` | `keys/sha256.go:15` | 无差异(全局单例) |

prefix 常量定义(`packages/shared/pkg/keys/constants.go`):

```go
const (
    ApiKeyPrefix      = "e2b_"
    AccessTokenPrefix = "sk_e2b_"
)
```

详细的 keys 包实现说明见 [api-keys-module.md 第六章](./api-keys-module.md#六keys-包深入)。

---

## 七、数据模型

### 7.1 `access_tokens` 表结构

完整字段(经过多次 migration 演化):

| 字段 | 类型 | 说明 | 来源 migration |
| --- | --- | --- | --- |
| `id` | uuid (PK, NOT NULL) | token 记录 ID | `20250211160814_add_token_hashes.sql`(加,默认 gen_random_uuid())+ `20250910072612_access_tokens_id_non_nullable.sql`(改 NOT NULL) |
| `user_id` | uuid (FK → auth.users) | 所属 user,**CASCADE 删除** | `20231124185944_create_schemas_and_tables.sql`(建表) |
| `access_token_hash` | text (UNIQUE) | `$sha256$<43 base64>`,51 字符 | `20250211160814_add_token_hashes.sql` + `20250825102440_add_hash_indexes.sql`(加 UNIQUE 索引) |
| `access_token_prefix` | varchar(10) | `"sk_e2b_"` | `20250606204750_optimize_hashed_key_schema.sql` |
| `access_token_length` | integer | 40 | `20250606204750_optimize_hashed_key_schema.sql` |
| `access_token_mask_prefix` | varchar(5) | 前 2 字符 | `20250606204750_optimize_hashed_key_schema.sql` |
| `access_token_mask_suffix` | varchar(5) | 后 4 字符 | `20250606204750_optimize_hashed_key_schema.sql` |
| `name` | text | 用户起的别名(默认 `'Unnamed Access Token'`) | `20250211160814_add_token_hashes.sql` |
| `created_at` | timestamptz | 创建时间 | `20231124185944_create_schemas_and_tables.sql`(建表) |
| ~~`access_token`~~ | ~~text~~ | ~~明文,早期主键~~ | `20250910124212_remove_raw_keys.sql`(DROP) |

**演化历史**(跨度近 2 年,与 team_api_keys 同构):
1. **2023-11-24**:建表,3 字段(`access_token` text PK, `user_id`, `created_at`)。
2. **2023-12-20**(`20231220094836_create_triggers_and_policies.sql`):添加 `generate_access_token_trigger`,在新 user 注册时**自动生成**一把 access token。这是早期"零配置开箱即用"的设计。
3. **2025-02-11**(`20250211160814_add_token_hashes.sql`):开始**并行迁移到 hash**。加 `id`、`access_token_hash`、`access_token_mask`、`name`。
4. **2025-06-06**:拆 `access_token_mask` 为 4 字段(与 team_api_keys 同步演化)。
5. **2025-08-25**(`20250825102440_add_hash_indexes.sql`):为 hash 加 UNIQUE 索引(快速验证);同日的 `20250825100000_remove_default_keys.sql` 移除触发器,新 user 不再自动获得 token。
6. **2025-09-10**(3 个连续迁移):主键从 `access_token` 改为 `id`,允许 `access_token` NULL,最终 `id` 设为 NOT NULL,DROP `access_token` 列。

> **与 team_api_keys 的对照**:两张表几乎同步演化,差异是 access_tokens 没有 `team_id` / `created_by` / `last_used` / `updated_at`。

### 7.2 sqlc 查询

`packages/db/pkg/auth/sql_queries/access_token/`:

| 查询 | 文件 | 类型 | 用途 |
| --- | --- | --- | --- |
| `CreateAccessToken` | `create_access_token.sql` | `:one` | INSERT 新 token,RETURNING * |
| `DeleteAccessToken` | `delete_access_token.sql` | `:one` | DELETE WHERE id AND user_id,RETURNING id |
| `GetUserIDFromAccessToken` | `get_user_id_from_access_token.sql` | `:one` | 验证路径用:SELECT user_id WHERE hash = $1 |

**对比 api-keys**:api-keys 有 6 个查询(含 `UpdateTeamApiKey` / `UpdateLastTimeUsed` / `GetTeamAPIKeyHashes`),access-tokens 只有 3 个——因为没有 PATCH、没有 last_used 更新、没有缓存失效需要 hash 列表。

---

## 八、与 auth 验证链路的闭环

### 8.1 验证路径:为什么 access token 走的是另一条路

创建出 access token 后,SDK 用它调业务 API 时走的是 **`AccessTokenAuth` 安全方案**,而不是 `ApiKeyAuth`。

完整验证路径(`packages/auth/pkg/auth/service.go:140` 的 `ValidateAccessToken`):

```
SDK 请求 GET /sandboxes
   │
   │  Authorization: Bearer sk_e2b_a1b2...wxyz
   ▼
AccessTokenAuthenticator.Authenticate
   │
   ▼
APIStore.GetUserFromAccessToken(accessToken)
   │
   ▼
authService.ValidateAccessToken(accessToken)
   │
   ├── 1. keys.VerifyKey("sk_e2b_", accessToken)
   │      → 检查 prefix、hex decode、SHA256 hash
   │      → 失败:401 "Invalid access token format"
   │
   ├── 2. store.GetUserIDByHashedAccessToken(hashedToken)
   │      │
   │      └── authDB.Read.GetUserIDFromAccessToken
   │            (直接查 DB,无 cache!)
   │            → 失败:401 "Cannot get the user for the given access token"
   │
   └── 3. telemetry.SetAttributes(maskedAccessToken, userID)
```

APIStore 在 token 格式和 DB 记录校验成功、拿到 `userID` **之后**,才用 `UserContext(userID)` 评估 `disable-e2b-access-token-auth`。flag 开启时返回 401 和 API key 迁移提示。先验证再评估是按用户灰度的必要条件,也避免用未认证输入构造 LaunchDarkly user context。

V1 template build 的 docker login 还会经过 `packages/docker-reverse-proxy`:Basic Auth 中用户名是 `_e2b_access_token`,password 是 `sk_e2b_` token。Proxy 同样先从 DB 验证 token 并取得 userID,再评估相同 flag;关闭时返回 403 和相同迁移指引。因此 auth cutover 同时覆盖业务 API 与旧 Docker registry 登录链路。

**与 api-keys 验证路径的关键差异**:

| 维度 | API Key 验证 | Access Token 验证 |
| --- | --- | --- |
| 缓存 | teamCache(5 分钟 TTL) | **无缓存,每次直查 DB** |
| 返回 | `*types.Team`(完整 team 信息) | `uuid.UUID`(只 userID) |
| 后续步骤 | 直接可用 | 还要查 user 的 default team |
| 异步副作用 | UpdateLastTimeUsed | **无** |

**为什么 access token 不缓存**?

历史原因:access token 是"过渡期"凭证,等所有用户迁到 API Key 后会下线。投资做缓存不划算。直接查 DB 的代价是每次请求多 1 个 SQL,但 LaunchDarkly flag 在生产逐步开启 410 后,QPS 会自然下降。

### 8.2 没有 last_used 更新(与 api-keys 的差异)

api-keys 的 `GetTeamByHashedAPIKey` 会异步 `UpdateLastTimeUsed`,而 access token 的 `GetUserIDFromAccessToken` 只是简单 SELECT,**不更新任何字段**。

access_tokens 表也没有 `last_used` 列(见 7.1 表结构对比)。

**原因**:
- last_used 主要给 dashboard 展示用,但 access token 没有 GET 端点,所以 UI 也不展示。
- deprecated 之后投这部分功能没意义。

### 8.3 删除后如何失效

**短答案**:**立即失效**(因为没缓存)。

DELETE `/access-tokens/{id}` 后:
1. DB 里这把 token 已经 DELETE。
2. 由于 `GetUserIDFromAccessToken` 每次直查 DB(无缓存),下一次用这把 token 调 API **立即返 401**。

**对比 api-keys**:api-keys 因为有 5 分钟 TTL 的 teamCache,删除后短期内仍可用。access-tokens 反而**更严格**(无缓存 = 立即失效)。

---

## 九、配置与 Feature Flag

> ⛔ **本节描述的两个 flag 已在 2026.30 删除。** 当前代码里 `packages/shared/pkg/featureflags/flags.go` 已无任何匹配 `access.token` 的定义。保留本节是为了说明弃用期是怎么设计的。

### 9.1 核心标志(历史)

| Flag | 默认 | 范围 | 影响 | 2026.30 |
| --- | --- | --- | --- | --- |
| `disable-e2b-access-token-provisioning` | `false` | LaunchDarkly,bool,支持按 user 灰度 | POST /access-tokens 返 410 Gone | **已删除** |
| `disable-e2b-access-token-auth` | `false` | LaunchDarkly,bool,支持按 user 灰度 | API 拒绝 access token(401);docker-reverse-proxy 拒绝 V1 build docker login(403) | **已删除** |

曾定义在 `packages/shared/pkg/featureflags/flags.go:226`(2026.29 行号):

```go
DisableE2BAccessTokenProvisioningFlag = NewBoolFlag("disable-e2b-access-token-provisioning", false)
DisableE2BAccessTokenAuthFlag = NewBoolFlag("disable-e2b-access-token-auth", false)
```

调用方式曾为(`accesstoken.go:25`):

```go
a.featureFlags.BoolFlag(ctx, featureflags.DisableE2BAccessTokenProvisioningFlag, featureflags.UserContext(userID.String()))
```

`UserContext(userID.String())` 让 LaunchDarkly 能按 user 维度做灰度(例如先对内部 dogfood 用户开启,再按比例放量)。

### 9.2 灰度策略(设计文档,实际未采用)

| 阶段 | 目标 | flag 设置 |
| --- | --- | --- |
| 1. 内部测试 | 验证 410 流程不破坏旧 SDK | 对 `@e2b.dev` 邮箱后缀开启 |
| 2. 早期通知 | 给 dashboard 加迁移提示 | 全量 false,但 SDK 检测到 deprecated header 时主动提示 |
| 3. 停止签发 | 5-10% → 全量用户 | 灰度再全量开启 provisioning flag,POST 返回 410 |
| 4. 停止认证 | 已迁移用户 → 全量用户 | 灰度再全量开启 auth flag,API/docker login 拒绝旧 token |
| 5. 代码下线 | 移除端点与验证链路 | 删除 spec POST、handler 和旧 token authenticators |

**注意**:DELETE 端点**不要**在同时下线。要给用户至少一个清理周期(建议 6 个月+)让他们删除旧 token,否则 `access_tokens` 表里会留下永久垃圾。

> ⚠️ **这张表是当初的设计建议,不是实际执行记录。** 2026.30 实际是**一次性全删**——没有灰度放量、没有 DELETE 保留期、表直接 drop。详见 [§零.3](#零3-弃用时间线完整轨迹) 和 [Q9](#q9弃用期建议的分五步下线路径实际是怎么走的)。

### 9.3 环境变量

`access-tokens` 模块本身无专用 env。整个 feature flag 系统的 env(LaunchDarkly SDK key 等)详见 auth-module.md。

---

## 十、关键代码文件索引

### 10.1 handlers(`packages/api/internal/handlers/`)

| 文件 | 主要函数 |
| --- | --- |
| `accesstoken.go:20` | `PostAccessTokens`(含 410 检查) |
| `accesstoken.go:81` | `DeleteAccessTokensAccessTokenID` |
| `accesstoken_test.go:18` | `TestPostAccessTokensRejectsWhenIssuanceDisabled` |
| `store.go:396` | `GetUserFromAccessToken`(间接被 auth 链路调) |

### 10.2 keys 包(与 api-keys 共用,详见 [api-keys-module.md 10.3](./api-keys-module.md#103-keys-包packagessharedpkgkeys))

| 文件 | 主要 API |
| --- | --- |
| `constants.go:4-5` | `ApiKeyPrefix = "e2b_"`, `AccessTokenPrefix = "sk_e2b_"` |
| `key.go:66` | `GenerateKey(prefix)` |
| `key.go:100` | `VerifyKey(prefix, key)` |

### 10.3 auth 验证链路(`packages/auth/pkg/auth/`)

| 文件 | 主要函数 |
| --- | --- |
| `service.go:140` | `ValidateAccessToken` |
| `auth_store.go:100-102` | `GetUserIDByHashedAccessToken` |
| `middleware.go:147` | `NewAccessTokenAuthenticator`(`AccessTokenAuth` 安全方案) |
| `gin.go:23` | `MustGetUserID` |

**Docker V1 build 登录链路**:

| 文件 | 主要函数 |
| --- | --- |
| `packages/docker-reverse-proxy/internal/handlers/token.go` | `GetToken`:验证 token → 按 user 评估 auth flag → 签发 registry token |
| `packages/docker-reverse-proxy/internal/auth/validate.go` | `ValidateAccessToken`:校验格式并从 DB 返回 owning userID |

### 10.4 DB(`packages/db/`)

| 文件 | 查询 |
| --- | --- |
| `pkg/auth/sql_queries/access_token/create_access_token.sql` | `CreateAccessToken :one` |
| `pkg/auth/sql_queries/access_token/delete_access_token.sql` | `DeleteAccessToken :one` |
| `pkg/auth/sql_queries/access_token/get_user_id_from_access_token.sql` | `GetUserIDFromAccessToken :one` |
| `migrations/20231124185944_create_schemas_and_tables.sql:82-90` | 建表 |
| `migrations/20231220094836_create_triggers_and_policies.sql:66-86` | 自动生成触发器(已废弃) |
| `migrations/20250211160814_add_token_hashes.sql` | 加 hash + id |
| `migrations/20250606204750_optimize_hashed_key_schema.sql` | 拆 mask |
| `migrations/20250825100000_remove_default_keys.sql` | 移除自动生成触发器 |
| `migrations/20250910072612_access_tokens_id_non_nullable.sql` | id NOT NULL |
| `migrations/20250910124212_remove_raw_keys.sql` | DROP access_token 明文列 |

### 10.5 feature flags

| 文件 | 内容 |
| --- | --- |
| `packages/shared/pkg/featureflags/flags.go` | `DisableE2BAccessTokenProvisioningFlag`、`DisableE2BAccessTokenAuthFlag` 定义 |

### 10.6 OpenAPI spec

| 位置 | 内容 |
| --- | --- |
| `spec/openapi.yml:3572` | `/access-tokens` POST 定义(`deprecated: true`) |
| `spec/openapi.yml:3600` | `/access-tokens/{accessTokenID}` DELETE 定义 |
| `spec/openapi.yml:1764` | `NewAccessToken` schema(请求 body) |
| `spec/openapi.yml:1739` | `CreatedAccessToken` schema(响应) |

---

## 十一、设计要点与权衡

### 11.1 为什么用 spec `deprecated: true` + 运行时 410 的双层设计?

- **spec 标记**给静态读者(Swagger UI、文档生成器、客户端代码生成器)信号。一些工具会自动生成 deprecation 警告。
- **运行时 410**给已经部署的旧客户端一个**软着陆**:SDK 拿到 410 后可以提示用户"请迁移到 E2B_API_KEY",而不是直接崩。
- 如果只靠 spec,旧 SDK 不会知道要迁移;如果只靠运行时返 410,新 SDK 在 dev 阶段就感受不到 deprecated 信号。

### 11.2 为什么 POST 不接受 admin 兜底?

对比 GET /api-keys 有 `AdminApiKeyAuth + AdminTeamAuth` 兜底,POST /access-tokens **完全不允许 admin 代调**。

原因:
- access token 严格绑定 user,内部服务不应该代用户创建凭证。
- 没有合理的运维场景需要"代用户创建 access token"。如果需要服务间认证,应该用专门的 service account 或 API Key。

### 11.3 为什么 DELETE 不受 deprecated flag 影响?

- 用户可能有很多旧 token 残留,DELETE 是清理手段。
- 如果 DELETE 也返 410,用户无法清理,`access_tokens` 表会一直膨胀。
- DELETE 不引入新凭证,不破坏 deprecated 的初衷。

### 11.4 为什么没有 GET / PATCH?

- **没有 GET**:历史设计选择。dashboard 早期靠创建时返回的 mask 字段做展示,不需要列表。
- **没有 PATCH**:access token 没有"改名"的业务场景(改名不影响鉴权能力,但也没价值)。
- 现在补这两个端点更没意义——既然 deprecated,只会下线,不会扩展。

### 11.5 为什么 access token 验证不缓存(对比 api-keys 缓存)?

详见 [8.1](#81-验证路径为什么-access-token-走的是另一条路)。简而言之:
- 历史原因:access token 是过渡期凭证,投资做缓存不划算。
- 反向好处:删除后**立即生效**(对比 api-keys 有 5 分钟 TTL 的窗口)。
- 当前 QPS 在 flag 灰度过程中自然下降,无缓存也能扛。

### 11.6 为什么在应用层生成 UUID(`uuid.New()`),而不是让 DB 默认生成?

对比 api-keys 让 DB 用 `DEFAULT gen_random_uuid()`,access token 在 `accesstoken.go:50` 显式 `uuid.New()`:

```go
accessTokenDB, err := a.authDB.Write.CreateAccessToken(ctx, authqueries.CreateAccessTokenParams{
    ID:     uuid.New(),   // ← 显式
    UserID: userID,
    ...
})
```

**这是历史代码,不是有意设计**。两种方式效果相同。理论上可以统一(让 DB 默认生成),但 deprecated 状态下不值得改。

### 11.7 为什么不直接下线端点,而要保留 410 返回?

- 已部署的旧 SDK 会持续发请求到 `/access-tokens`。
- 直接下线(404 或路由不存在)会让 SDK 抛 UnknownError,用户体验差。
- 返 410 + 迁移指引,SDK 可以识别"这个端点永久废弃"并给出明确提示。

### 11.8 为什么 flag 按 user 维度,而不是全量?

`featureflags.UserContext(userID.String())` 让 LaunchDarkly 能:
- 先对内部员工开启(测试 410 流程对真实 SDK 的影响)。
- 再对 5%、10%、50% 用户开启(观察支持工单是否上升)。
- 最后全量。

如果只支持全量开关,任何一步出问题都要回滚,影响所有用户。

---

## 十二、常见问题与排查

> ⚠️ **本章问题按"当前状态"重写。** 原来的 Q1/Q2/Q3/Q4/Q5/Q6/Q8/Q10/Q11 描述的是弃用期的 flag 行为,那些 flag 和路径都已不存在。下面按"现在遇到这个问题该怎么查"来写;历史行为的解释在对应小节的 ⓘ 里保留。

### Q1:SDK 报 410 Gone,怎么办?

**说明**:**这不是 flag 门控,是硬删除**。`POST /access-tokens` 与 `DELETE /access-tokens/:id` 现在无条件返回 410([§零.2](#零2-410-兜底为什么旧客户端拿到的是-410-而不是-404))。

**处理**:
1. 升级 SDK 到最新版(新版本默认用 `E2B_API_KEY`)。
2. 通过 dashboard 创建 team API Key(`e2b_` 前缀)。
3. 把 API Key 配置到 SDK 的 `E2B_API_KEY` 环境变量。
4. **不要试图删旧 token** —— DELETE 也是 410,而且表已经 drop 了,没有可删的行。

迁移指引见响应里的链接:`https://e2b.dev/docs/migration/access-token-deprecation`。

> ⓘ 弃用期(2026.16–2026.29)这个 410 由 `disable-e2b-access-token-provisioning` 控制,且 DELETE 不受影响。2026.30 起两个 flag 一起删掉了。

### Q2:旧 access token 现在还能用来调 API 吗?

**不能**。`AccessTokenAuth` security scheme 已从 spec 删除,`NewAccessTokenAuthenticator` 也已从 authenticator 链删除([§零.1](#零1-被删除的清单))。带 `Authorization: Bearer sk_e2b_...` 的请求在认证阶段就失败。

> ⓘ 和弃用期的区别:当时 `disable-e2b-access-token-auth=false` 的旧 token 还能用;现在是**认证器不存在了**,不是"被 flag 拒绝"。

### Q3:用户问"我有把 access token,但忘了是哪把,怎么知道?"

**说明**:这个问题现在**没有意义**了——`access_tokens` 表已 drop,行的 hash 也没了([§零.1](#零1-被删除的清单)的 ⚠️)。**无法查、无法恢复、也不需要再清理**。

**处理**:直接让用户改用 API Key。如果用户手上有明文 token 需要确认是否还有效,答案是"已全部失效"。

> ⓘ 历史:该模块从来没有 GET 列表端点,用户只能凭创建时的 mask(前 2 + 后 4 字符)手动对比。

### Q4:查询 access_tokens 表报 `relation "public.access_tokens" does not exist`

**说明**:这是**预期行为**,不是故障。表已在 [`20260823120000_drop_access_tokens.sql`](../packages/db/migrations/20260823120000_drop_access_tokens.sql) 中 drop。

**排查**:
```sql
-- 确认迁移已执行
SELECT version_id, is_applied FROM goose_db_version
WHERE version_id = 20260823120000;
```

如果迁移**未**执行(比如某个环境还没部署 2026.30),表还在,但代码已不再读写它。

> ⚠️ **迁移执行前不要跑 `Down`**。Down 只重建空表结构,数据不会回来。

### Q5:用户报告"用 access token 调 API 拿到 401"

**说明**:现在是**认证器不存在**,所以报错形态和弃用期不同——不再有 `Invalid access token format` / `Cannot get the user for the given access token` 这两种专属文案。

**处理**:确认调用方用的是 `X-API-Key: e2b_...`(team 级)或 OIDC bearer。如果请求头还是 `Authorization: Bearer sk_e2b_...`,那就是没迁移。

> ⓘ 历史错误文案:`keys.VerifyKey` 的 prefix/hex 校验失败 → `Invalid access token format`;格式 OK 但 DB 查不到 hash → `Cannot get the user for the given access token`。

### Q6:内部服务能否用 admin token 代用户创建 access token?

**不能**,而且现在**任何身份都不能** —— 端点已删除([§零.1](#零1-被删除的清单))。

如果确实需要服务间凭证,用 team API Key,或走 admin 路径 `/admin/teams/{teamID}/api-keys`。

### Q7:如何审计遗留 access token 的使用情况?

**说明**:2026.30 之后**无法审计** —— 使用侧的埋点(`ValidateAccessToken` 里的 `WithMaskedAccessToken`)随认证器一起删除了。

**处理**:
- 需要**历史**使用数据的话,只能翻 2026.30 部署前的 Grafana 面板(按 `maskedAccessToken` 聚合)。
- 需要**当前**使用数据的话,改看 API Key 的埋点。

### Q8:V1 template build 的 docker login 返回 403 和迁移提示

`docker-reverse-proxy` 已成功验证 token 并得到 userID,但该用户命中了 `disable-e2b-access-token-auth`。这不是 registry scope 或密码格式错误;改用 `E2B_API_KEY`,并检查 API 侧同一用户的 access-token 请求是否也已返回 401。

> ⚠️ 这条路径依赖 `disable-e2b-access-token-auth` flag,该 flag 已在 2026.30 删除。**2026.30 之后不会再出现这个 403**——registry 侧已不再接受 `sk_e2b_` 凭证。

### Q9:弃用期建议的"分五步下线"路径,实际是怎么走的?

原文档在 Q10 给了一条渐进路径(全量开 flag → 删 spec → 删 handler → 延后删 DELETE → 最后 drop 表)。**实际执行比这个激进**:2026.30 一次性删掉了 spec path、handler、flag、认证器和 DB 表,DELETE 也没有额外保留期。

**教训**(如果将来再做类似下线):
- 保留 410 兜底是对的 —— 它让旧客户端拿到可读的错误而不是 404。
- 但"两个 flag 逐步开启"这套灰度机制最终没有被用上,增加了维护面却没有换来观测窗口。
- DELETE 延后保留在**这个**案例里没必要,因为表都 drop 了,留着 DELETE 也无行可删。

---

## 附录 A:端点速查表

### A.1 2 个 access-tokens 端点

| 端点 | 方法 | 鉴权 | 成功 | 失败常见码 |
| --- | --- | --- | --- | --- |
| `/access-tokens` | POST(**deprecated**) | OIDC only | 201 + `CreatedAccessToken` | 400, 401, **410**(flag 开启), 500 |
| `/access-tokens/{accessTokenID}` | DELETE | OIDC only | 204(无 body) | 400, 401, 404, 500 |

### A.2 Token 生命周期状态机

```
   (旧 SDK)创建             (用户/触发器)删除
       │                          │
       ▼                          ▼
   ┌────────┐  ──────────>  ┌────────┐
   │ active │               │deleted │
   │  (DB)  │               │ (gone) │
   └────────┘               └────────┘
       │
       │ POST 在 flag 开启时返 410
       │ (不再有新 active 进入)
       ▼
   存量逐步清理 → 表最终 DROP
```

### A.3 字段映射:Key 结构 → DB → API 响应

| `Key` 结构字段 | DB 字段 | API 响应字段 | 出现位置 |
| --- | --- | --- | --- |
| `PrefixedRawValue` | (不存) | `CreatedAccessToken.token` | POST 响应(一次) |
| `HashedValue` | `access_token_hash` | (不返回) | DB / 验证用 |
| `Masked.Prefix` | `access_token_prefix` | `Mask.prefix` | POST 响应 |
| `Masked.ValueLength` | `access_token_length` | `Mask.valueLength` | POST 响应 |
| `Masked.MaskedValuePrefix` | `access_token_mask_prefix` | `Mask.maskedValuePrefix` | POST 响应 |
| `Masked.MaskedValueSuffix` | `access_token_mask_suffix` | `Mask.maskedValueSuffix` | POST 响应 |
| (UUID,应用层生成) | `id` | `id` | POST 响应 |
| (用户输入) | `name` | `name` | POST 响应 |
| (ctx userID) | `user_id` | (不返回,自己知道) | DB |
| (系统) | `created_at` | `createdAt` | POST 响应 |

---

## 附录 B:错误码与 HTTP 状态映射

> ⛔ **本表是历史映射(2026.29)。** 当前只有一种情况:两条 path 恒返 410,其余场景都不存在。

| 场景 | HTTP | 说明 | 2026.30 |
| --- | --- | --- | --- |
| Body 解析失败 | 400 | "Error when parsing request: ..." | 不适用 |
| accessTokenID 不是 UUID | 400 | "Error when parsing access token ID: ..." | 不适用 |
| 未鉴权 | 401 | (由中间件返回) | 不适用(410 不鉴权) |
| POST 时 flag 开启 | **410** | "Creating new access tokens is disabled. E2B_ACCESS_TOKEN is deprecated; use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation" | **恒 410** |
| DELETE 任意情况 | — | — | **恒 410** |
| API 认证时 auth flag 开启 | **401** | Token 已验证,但不再接受;返回 API key 迁移提示 | 认证器已删除 |
| docker-reverse-proxy 认证时 auth flag 开启 | **403** | V1 build docker login 被拒绝,返回 API key 迁移提示 | flag 已删除 |
| DELETE 找不到 | 404 | "id not found" | 不适用 |
| DB 错误 | 500 | "Error when ..." | 不适用(无 DB 访问) |
| 成功(POST) | 201 | JSON(含明文 token) | 不可能发生 |
| 成功(DELETE) | 204 | 无 body | 不可能发生 |

> ⚠️ 2026.30 的 410 文案**比弃用期短**:去掉了 "Creating new access tokens is disabled." 前缀,直接是 `E2B_ACCESS_TOKEN is deprecated and no longer supported. Use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation`。断言错误信息文本的测试需要同步更新。

---

## 附录 C:术语表

| 术语 | 含义 | 现状(2026.30) |
| --- | --- | --- |
| **Access Token** | 用户级凭证,前缀 `sk_e2b_`,47 字符,作 `Authorization: Bearer` 头 | ⛔ **已退役**,所有形态失效 |
| **API Key** | 团队级凭证(active),前缀 `e2b_`,44 字符,作 `X-API-Key` 头 | ✅ 唯一推荐的机器凭证 |
| **明文 / PrefixedRawValue** | token 的完整形式,只在 POST 响应里出现一次 | 历史 |
| **Hash** | `$sha256$` + 43 字符 base64(总 51),落 DB + 验证用 | 表已 drop,hash 已丢失 |
| **Mask** | 固定窗口(前 2 + 后 4),用于 UI 展示 | 历史 |
| **`access_tokens` 表** | user 级 token 的存储,uuid PK + hash UNIQUE | ⛔ **已 `DROP TABLE`** |
| **`generate_access_token()`** | 生成 `sk_e2b_` + 40 hex 的 plpgsql 函数 | ⛔ **已 `DROP FUNCTION`** |
| **`team_api_keys` 表** | team 级 key 的存储(对照) | ✅ active |
| **provisioning flag** | `disable-e2b-access-token-provisioning`,只停止创建新 token,按 user 灰度 | ⛔ 已删除 |
| **auth flag** | `disable-e2b-access-token-auth`,停止 API 与 docker-reverse-proxy 接受已有 token,按 user 灰度 | ⛔ 已删除 |
| **410 Gone** | POST 在 flag 开启时返回,引导用户迁移到 API Key | ✅ 现在是**无条件**返回 |
| **`AccessTokenAuth`** | OpenAPI security scheme(12 处引用) | ⛔ 已从 spec 删除 |
| **`NewAccessTokenAuthenticator`** | shared auth 里的认证器实现 | ⛔ 已从 authenticator 链删除 |
| **`GetUserFromAccessToken`** | `APIStore` 上的验证方法 | ⛔ 已删除 |
| **`UserContext`** | LaunchDarkly 的 user 维度上下文,支持按 userID 灰度 | ✅ 通用机制,仍存在 |
| **触发器(已废弃)** | 早期 `generate_access_token_trigger`,新 user 注册自动生成 token,2025-08-25 移除 | 更早的历史 |
| **`authDB.Read` / `authDB.Write`** | 读副本 / 主库(曾用于 access token 的读与写) | 不再有 access token 相关用途 |
| **没有缓存** | access token 验证每次直查 DB,删除立即生效(对比 api-keys 5 分钟 TTL) | 历史 |

---

> 文档版本:已同步至 **2026.30**。模块状态:**已退役**。
>
> - 描述当前状态的部分:[§零](#零202630-退役总结)、[§十二](#十二常见问题与排查)
> - 历史档案部分:[§一](#一概述) ~ [§十一](#十一设计要点与权衡) + 附录(标注 ⓘ / ⛔ 处)
> - 相关文档:[api-module.md](./api-module.md)(§2.1 鉴权主体、§5.3.5 已删除的 access token 路径、§8.4.1 secrets)、[api-keys-module.md](./api-keys-module.md)(替代方案)、[api-changes-2026.16-2026.28.md](./api-changes-2026.16-2026.28.md)(弃用起点)
