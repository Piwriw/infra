# E2B Access Tokens(用户级 Access Token)模块详解

> 模块定位:**已 deprecated** 的用户级凭证 CRUD。曾经是 SDK 的主要鉴权方式,现在让位给 team 级 API Key(`X-API-Key`)。本文档解释 deprecated 流程的完整语义、410 返回条件,以及为什么 DELETE 仍然保留。
>
> **核心特征**:
> - 用户级(`user_id` 绑定),不是 team 级
> - 前缀 `sk_e2b_`(区别于 API Key 的 `e2b_`)
> - 只支持 POST(创建)+ DELETE(删除),**没有 GET / PATCH**
> - POST 在 LaunchDarkly flag 开启时返 `410 Gone`,引导用户迁移到 API Key
>
> 适用代码范围:
> - `packages/api/internal/handlers/accesstoken.go` — 2 个 handler
> - `packages/api/internal/handlers/accesstoken_test.go` — 410 流程测试
> - `packages/db/pkg/auth/sql_queries/access_token/` — 3 个 sqlc 查询
> - `packages/shared/pkg/keys/` — Key 生成、hash、mask 工具(与 api-keys 共用)
> - `packages/shared/pkg/featureflags/flags.go:226` — `DisableE2BAccessTokenProvisioningFlag`
> - `spec/openapi.yml` 中 `tags: [access-tokens]` 的端点

## 目录

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

## 一、概述

### 1.1 access-tokens 是什么

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

**两层 deprecated 信号**:
1. **静态层**(spec):`deprecated: true` — Swagger UI / 文档生成器会标灰,提醒客户端不要再用。
2. **运行时层**(代码):LaunchDarkly flag `disable-e2b-access-token-provisioning` 默认 `false`。开启后 POST 立即返 `410 Gone` + 迁移指引。

这种"spec 标 deprecated + flag 灰度"的双层设计,既能给文档读者信号,又能在生产环境按需"硬关"。

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

### 9.1 核心标志

| Flag | 默认 | 范围 | 影响 |
| --- | --- | --- | --- |
| `disable-e2b-access-token-provisioning` | `false` | LaunchDarkly,bool,支持按 user 灰度 | POST /access-tokens 返 410 Gone |

定义在 `packages/shared/pkg/featureflags/flags.go:226`:

```go
DisableE2BAccessTokenProvisioningFlag = NewBoolFlag("disable-e2b-access-token-provisioning", false)
```

调用方式(`accesstoken.go:25`):

```go
a.featureFlags.BoolFlag(ctx, featureflags.DisableE2BAccessTokenProvisioningFlag, featureflags.UserContext(userID.String()))
```

`UserContext(userID.String())` 让 LaunchDarkly 能按 user 维度做灰度(例如先对内部 dogfood 用户开启,再按比例放量)。

### 9.2 灰度策略推荐

| 阶段 | 目标 | flag 设置 |
| --- | --- | --- |
| 1. 内部测试 | 验证 410 流程不破坏旧 SDK | 对 `@e2b.dev` 邮箱后缀开启 |
| 2. 早期通知 | 给 dashboard 加迁移提示 | 全量 false,但 SDK 检测到 deprecated header 时主动提示 |
| 3. 灰度关闭 | 5-10% 用户 | 按用户 hash 百分比 |
| 4. 全量关闭 | 所有人 | 全量 true |
| 5. 代码下线 | 移除端点 | 删除 spec 里 `/access-tokens` POST 端点,删除 handler |

**注意**:DELETE 端点**不要**在同时下线。要给用户至少一个清理周期(建议 6 个月+)让他们删除旧 token,否则 `access_tokens` 表里会留下永久垃圾。

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
| `packages/shared/pkg/featureflags/flags.go:226` | `DisableE2BAccessTokenProvisioningFlag` 定义 |

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

### Q1: SDK 报 410 Gone,怎么办?

**说明**:`disable-e2b-access-token-provisioning` flag 对当前 user 开启了。

**处理**:
1. 升级 SDK 到最新版(新版本默认用 `E2B_API_KEY`)。
2. 通过 dashboard 创建 team API Key(`e2b_` 前缀)。
3. 把 API Key 配置到 SDK 的 `E2B_API_KEY` 环境变量。
4. 旧的 access token 还能用(只要没删除),但建议清理。

迁移指引见响应里的链接:`https://e2b.dev/docs/migration/access-token-deprecation`。

### Q2: 用户报告"创建 token 时看到明文,刷新后就找不到了"

**说明**:同 api-keys,这是设计行为。明文 token 只在 POST 响应里出现一次。**而且 access-tokens 没有 GET 端点**,所以**完全无法找回**。

**处理**:
- 提示用户在创建时立刻保存。
- 如果丢失,只能删除重建(但在 flag 开启后重建也会 410)。

### Q3: 用户问"我有把 access token,但忘了是哪把,怎么知道?"

**说明**:由于**没有 GET 列表端点**,无法查询。

**处理**:
- 用户只能凭**创建时的 mask**(前 2 + 后 4 字符)手动对比。
- 实在找不到,可以**全部删除**(需要 dashboard 提供批量删除接口,或直接联系 support)。
- 但更推荐:**直接迁到 API Key**,access token 会随 deprecated 一起下线。

### Q4: 删除时返 404 "id not found"

**可能原因**:
1. accessTokenID 不是合法 UUID → 实际返 400。
2. accessTokenID 合法,但**不属于当前 user** → SQL `WHERE id AND user_id` 不匹配,返 NotFound。
3. accessTokenID 已被删除(重复删除)→ 同样 NotFound。

**排查**:
```sql
SELECT user_id FROM access_tokens WHERE id = '<accessTokenID>';
-- 对比当前 userID
```

### Q5: 用户报告"用 access token 调 API 拿到 401 'Invalid access token format'"

**说明**:`keys.VerifyKey` 在 prefix 检查或 hex 解码失败时返回此错误。

**常见原因**:
- Token 没带 `sk_e2b_` 前缀(用户复制时漏了)。
- Token 中间有非 hex 字符。
- 用户传的是 API Key(`e2b_` 前缀)但放到了 `Authorization: Bearer` 头里(prefix 不匹配)。

### Q6: 用户报告"用 access token 调 API 拿到 401 'Cannot get the user for the given access token'"

**说明**:`VerifyKey` 成功(格式 OK)但 DB 里查不到这个 hash。

**常见原因**:
1. Token 已被删除(access token 删除立即生效,无缓存窗口)。
2. Token 来自其他环境(staging 的 token 用到 prod)。
3. user 已被删除(`ON DELETE CASCADE` 会连带删除 access_tokens 行)。

**排查**:
```sql
SELECT * FROM access_tokens WHERE access_token_hash = '<hashedToken>';
-- 注意:hash 是 $sha256$ + 43 base64 形式
```

### Q7: 内部服务能否用 admin token 代用户创建 access token?

**不能**。POST /access-tokens 不接受任何 admin auth(详见 [11.2](#112-为什么-post-不接受-admin-兜底))。也没有 admin 路径的 `/admin/users/{userID}/access-tokens` 端点。

如果确实需要服务间凭证,应该用 API Key 走 admin 路径创建。

### Q8: flag 开启后,DELETE 是否也会返 410?

**不会**。DELETE 完全不受 `disable-e2b-access-token-provisioning` flag 影响。即使用户不能创建,也能正常删除已有的旧 token(详见 [11.3](#113-为什么-delete-不受-deprecated-flag-影响))。

### Q9: 如何审计 access token 的使用情况?

- **创建/删除**:telemetry 在 error 路径有埋点;happy path 没有(对比 api-keys 也没有)。
- **使用**(每次鉴权):`ValidateAccessToken` 里 `telemetry.SetAttributes(... WithMaskedAccessToken ...)` 会把 mask 上报。在 Grafana 里按 maskedAccessToken 聚合可以看到使用情况。
- **DB 查询**:`SELECT user_id, created_at, name FROM access_tokens WHERE user_id = '...'`(注意不能查 hash,不能查明文)。

### Q10: flag 全量开启后,什么时候真正下线代码?

**建议路径**:
1. flag 全量开启后,观察 1-3 个月,确认旧 SDK 流量降到接近 0。
2. 删除 spec 里的 POST /access-tokens 端点。
3. 等 OpenAPI 客户端都更新后(再观察 1-2 个月),删除 handler。
4. DELETE 端点保留更久(至少 6 个月),给用户清理时间。
5. 最终通过 migration 把 `access_tokens` 表 DROP(但要保留 user_id 的外键约束,直到确认没有代码引用)。

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

| 场景 | HTTP | 说明 |
| --- | --- | --- |
| Body 解析失败 | 400 | "Error when parsing request: ..." |
| accessTokenID 不是 UUID | 400 | "Error when parsing access token ID: ..." |
| 未鉴权 | 401 | (由中间件返回) |
| POST 时 flag 开启 | **410** | "Creating new access tokens is disabled. E2B_ACCESS_TOKEN is deprecated; use an API key (E2B_API_KEY) instead. See https://e2b.dev/docs/migration/access-token-deprecation" |
| DELETE 找不到 | 404 | "id not found" |
| DB 错误 | 500 | "Error when ..." |
| 成功(POST) | 201 | JSON(含明文 token) |
| 成功(DELETE) | 204 | 无 body |

---

## 附录 C:术语表

| 术语 | 含义 |
| --- | --- |
| **Access Token** | 用户级凭证(已废弃),前缀 `sk_e2b_`,47 字符,作 `Authorization: Bearer` 头 |
| **API Key** | 团队级凭证(active),前缀 `e2b_`,44 字符,作 `X-API-Key` 头 |
| **明文 / PrefixedRawValue** | token 的完整形式,只在 POST 响应里出现一次 |
| **Hash** | `$sha256$` + 43 字符 base64(总 51),落 DB + 验证用 |
| **Mask** | 固定窗口(前 2 + 后 4),用于 UI 展示 |
| **`access_tokens` 表** | user 级 token 的存储,uuid PK + hash UNIQUE |
| **`team_api_keys` 表** | team 级 key 的存储(对照) |
| **deprecated flag** | `disable-e2b-access-token-provisioning`,LaunchDarkly 控,按 user 灰度 |
| **410 Gone** | POST 在 flag 开启时返回,引导用户迁移到 API Key |
| **`DisableE2BAccessTokenProvisioningFlag`** | feature flag 定义,见 `packages/shared/pkg/featureflags/flags.go:226` |
| **`UserContext`** | LaunchDarkly 的 user 维度上下文,支持按 userID 灰度 |
| **触发器(已废弃)** | 早期 `generate_access_token_trigger`,新 user 注册自动生成 token,2025-08-25 移除 |
| **`authDB.Read`** | 读副本(用于 GetUserIDFromAccessToken) |
| **`authDB.Write`** | 主库(用于 Create/DeleteAccessToken) |
| **没有缓存** | access token 验证每次直查 DB,删除立即生效(对比 api-keys 5 分钟 TTL) |
