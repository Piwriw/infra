# E2B API Keys(用户/团队 API Key 管理)模块详解

> 模块定位:面向终端用户的团队级 API Key 凭证 CRUD。用户通过 OIDC 登录后,在 dashboard 或 CLI 创建/列出/重命名/删除 team API Key;创建出来的 Key 用作 `X-API-Key` 调所有业务端点。
>
> 与 admin 模块的 `/admin/teams/{teamID}/api-keys` 共用底层 `team.CreateAPIKey` / `team.DeleteAPIKey`,但鉴权链路、`createdBy` 语义、错误返回都不同。
>
> 适用代码范围:
> - `packages/api/internal/handlers/apikey.go` — 4 个 handler
> - `packages/api/internal/team/apikeys.go` — 共享的 `CreateAPIKey` / `DeleteAPIKey`
> - `packages/shared/pkg/keys/` — Key 生成、hash、mask 工具
> - `packages/db/pkg/auth/sql_queries/api_keys/` — 5 个 sqlc 查询
> - `spec/openapi.yml` 中 `tags: [api-keys]` 的端点

## 目录

- [一、概述](#一概述)
  - [1.1 api-keys 是什么](#11-api-keys-是什么)
  - [1.2 关键定位:与 admin 路径的对照](#12-关键定位与-admin-路径的对照)
  - [1.3 关键心智模型](#13-关键心智模型)
  - [1.4 整体架构](#14-整体架构)
- [二、核心概念](#二核心概念)
  - [2.1 API Key 的三层表示](#21-api-key-的三层表示)
  - [2.2 Hash 策略:SHA256,不是 bcrypt](#22-hash-策略sha256不是-bcrypt)
  - [2.3 Mask 策略:固定窗口](#23-mask-策略固定窗口)
  - [2.4 Team 绑定 + 可选 CreatedBy](#24-team-绑定--可选-createdby)
  - [2.5 与 access token 的对照](#25-与-access-token-的对照)
- [三、整体架构](#三整体架构)
  - [3.1 装配序列](#31-装配序列)
  - [3.2 依赖图](#32-依赖图)
  - [3.3 数据流总览](#33-数据流总览)
- [四、4 个端点逐一解析](#四4-个端点逐一解析)
  - [4.1 GET /api-keys — 列出当前 team 的所有 Key](#41-get-api-keys--列出当前-team-的所有-key)
  - [4.2 POST /api-keys — 创建新 Key](#42-post-api-keys--创建新-key)
  - [4.3 PATCH /api-keys/{apiKeyID} — 重命名 Key](#43-patch-api-keysapikeyid--重命名-key)
  - [4.4 DELETE /api-keys/{apiKeyID} — 删除 Key](#44-delete-api-keysapikeyid--删除-key)
- [五、关键流程时序图](#五关键流程时序图)
  - [5.1 创建 API Key](#51-创建-api-key)
  - [5.2 列出 + 删除](#52-列出--删除)
- [六、keys 包深入](#六keys-包深入)
  - [6.1 GenerateKey 的完整产物](#61-generatekey-的完整产物)
  - [6.2 MaskKey 的窗口规则](#62-maskkey-的窗口规则)
  - [6.3 VerifyKey:验证时的反向操作](#63-verifykey验证时的反向操作)
  - [6.4 MaskToken:日志安全辅助](#64-masktoken日志安全辅助)
- [七、数据模型](#七数据模型)
  - [7.1 `team_api_keys` 表结构](#71-team_api_keys-表结构)
  - [7.2 sqlc 查询](#72-sqlc-查询)
- [八、与 auth 验证链路的闭环](#八与-auth-验证链路的闭环)
  - [8.1 创建后,API Key 怎么被验证](#81-创建后api-key-怎么被验证)
  - [8.2 last_used 异步更新](#82-last_used-异步更新)
  - [8.3 删除后,缓存如何失效](#83-删除后缓存如何失效)
- [九、配置与 Feature Flag](#九配置与-feature-flag)
- [十、关键代码文件索引](#十关键代码文件索引)
- [十一、设计要点与权衡](#十一设计要点与权衡)
- [十二、常见问题与排查](#十二常见问题与排查)
- [附录 A:端点速查表](#附录-a端点速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录-b错误码与-http-状态映射)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

### 1.1 api-keys 是什么

`api-keys` 是终端用户管理 **team 级 API Key** 的接口。OpenAPI 里 `tags: [api-keys]` 的端点共 **4 个**:

| 路径 | 方法 | 功能 | Handler |
| --- | --- | --- | --- |
| `/api-keys` | GET | 列出当前 team 的所有 API Key | `GetApiKeys` |
| `/api-keys` | POST | 创建新 API Key(返回明文一次) | `PostApiKeys` |
| `/api-keys/{apiKeyID}` | PATCH | 重命名 API Key | `PatchApiKeysApiKeyID` |
| `/api-keys/{apiKeyID}` | DELETE | 删除 API Key | `DeleteApiKeysApiKeyID` |

**典型调用方**:dashboard 前端(用户登录后管理自己的 Key)、CLI(`e2b keys create` 等命令)。

### 1.2 关键定位:与 admin 路径的对照

E2B 有两条创建/删除 team API Key 的路径,**底层共用 `team.CreateAPIKey` / `team.DeleteAPIKey`**,但鉴权方式和语义不同:

| 维度 | `/api-keys`(本文档) | `/admin/teams/{teamID}/api-keys`(admin 模块) |
| --- | --- | --- |
| 鉴权 | OIDC JWT(`AuthProviderBearerAuth + AuthProviderTeamAuth`) | `X-Admin-Token` |
| 调用方 | 终端用户(经 dashboard/CLI) | 内部服务(dashboard-api、客服工具) |
| team 上下文 | 从 ctx 拿(`MustGetTeamID`)— 由 OIDC 链路写入 | 从 path param 拿 |
| `createdBy` | 当前 user ID(非 nil) | nil |
| blocked team | 不能创建(handler 主动检查) | 不能创建(handler 主动检查) |
| 底层调用 | `team.CreateAPIKey(ctx, authDB, teamID, &userID, name)` | `team.CreateAPIKey(ctx, authDB, teamID, nil, name)` |

### 1.3 关键心智模型

理解 api-keys 模块只需记住五句话:

1. **明文只在响应里出现一次**。POST 创建后,数据库只存 SHA256 hash,无法反推。
2. **Mask 是固定窗口**:前 2 字符 + 后 4 字符,中间用 `*` 展示(UI 自行渲染)。
3. **Team 绑定**。一把 Key 只属于一个 team,SQL 用 `WHERE id AND team_id` 双重过滤防越权。
4. **创建后立即可用**。无需传播等待——验证路径走的是 hash 直接查 DB,且失败不缓存。
5. **删除后异步失效**。team 缓存有 5 分钟左右的 TTL,短期内 Key 仍可能用(详见 [8.3](#83-删除后缓存如何失效))。

### 1.4 整体架构

```
                  ┌──────────────────────────────────┐
                  │  终端用户(dashboard / CLI)      │
                  │  OIDC 登录 → JWT                  │
                  └──────────────┬───────────────────┘
                                 │
                                 │  Authorization: Bearer <JWT>
                                 │  X-Team-Id:     <teamUUID>
                                 │
                                 │  操作 /api-keys:
                                 │    GET / POST / PATCH / DELETE
                                 ▼
        ┌────────────────────────────────────────────────────┐
        │                API (Gin + oapi-codegen)            │
        │                                                  │
        │  1. AuthProviderBearerAuth → 解 JWT → userID      │
        │  2. AuthProviderTeamAuth   → 查 team → 注入 ctx   │
        │                                                  │
        │  handlers/apikey.go:                              │
        │   - GetApiKeys     → authDB.Read.GetTeamAPIKeysWithCreator │
        │   - PostApiKeys    → team.CreateAPIKey(teamID, &userID, name) │
        │   - PatchApiKeys   → authDB.Write.UpdateTeamApiKey │
        │   - DeleteApiKeys  → team.DeleteAPIKey(teamID, apiKeyID) │
        └────────────┬─────────────────────────────────────┘
                     │
                     ▼
              ┌──────────────────┐
              │  Auth DB (PgSQL) │
              │  team_api_keys 表 │
              └──────────────────┘
```

---

## 二、核心概念

### 2.1 API Key 的三层表示

一把 API Key 在系统里有三种存在形式:

| 形式 | 字段 | 示例 | 何处出现 |
| --- | --- | --- | --- |
| **明文(PrefixedRawValue)** | `Key.PrefixedRawValue` | `e2b_a1b2c3d4e5f6...`(共 44 字符) | 创建时返回,**仅此一次** |
| **Hash** | `Key.HashedValue` + DB `api_key_hash` | `$sha256$<43 字符 base64>`(总 51 字符) | DB 唯一索引、缓存 key、验证时比对 |
| **Mask** | `Key.Masked` | `{Prefix: "e2b_", ValueLength: 40, MaskedValuePrefix: "a1", MaskedValueSuffix: "wxyz"}` | 列表响应、日志、telemetry |

**关键不变量**:
- 明文从不落库。`team_api_keys` 表里只有 hash 和 mask 字段。
- Hash 是单向的(SHA256),拿到 hash 也推不出明文。
- Mask 字段不足以重建明文(只有前 2 + 后 4 共 6 字符),只用于 UI 展示。

### 2.2 Hash 策略:SHA256,不是 bcrypt

```go
// packages/shared/pkg/keys/key.go:18
var hasher Hasher = NewSHA256Hashing()
```

`hasher.Hash(keyBytes)` 的实现(`packages/shared/pkg/keys/sha256.go`):

```go
type Sha256Hashing struct{}

func NewSHA256Hashing() *Sha256Hashing {
    return &Sha256Hashing{}
}

func (h *Sha256Hashing) Hash(key []byte) string {
    hashBytes := sha256.Sum256(key)
    hash64 := base64.RawStdEncoding.EncodeToString(hashBytes[:])
    return fmt.Sprintf("$sha256$%s", hash64)
}
```

输出格式:`$sha256$` + 43 字符 base64(RawStdEncoding,无 padding),总长 51 字符。前缀 `$sha256$` 标识算法,便于将来支持多算法共存。

**为什么不用 bcrypt / argon2**?

| 维度 | SHA256 | bcrypt/argon2 |
| --- | --- | --- |
| 速度 | 极快(微秒级) | 慢(毫秒级,故意慢) |
| 抗暴力破解 | 弱(对短密码不安全) | 强 |
| 适用场景 | **高熵随机 token** | **低熵人类密码** |
| 确定性 | 是(同输入同输出,可做 UNIQUE 索引) | 否(有 salt,每次不同) |

API Key 是 20 字节随机(hex 编码后 40 字符),**熵足够高**(160 bit),不需要 bcrypt 的"慢"来对抗暴力破解。SHA256 足够,且能直接做 DB 索引(bcrypt 每次结果不同,因为有 salt)。

> 历史背景:`packages/shared/pkg/keys/hmac_sha256.go` 里有 `HMACSha256Hashing`,但目前未默认启用。HMAC 主要用于将来可能需要服务端密钥参与的场景(防止 DB 泄漏后 hash 直接可用)。

### 2.3 Mask 策略:固定窗口

Mask 是 **前 2 字符 + 后 4 字符**,中间字符不暴露。具体规则在 `keys.MaskKey`:

```go
// packages/shared/pkg/keys/key.go:33-64
const (
    identifierValueSuffixLength = 4
    identifierValuePrefixLength = 2
    keyLength = 20
)

func MaskKey(prefix, value string) (MaskedIdentifier, error) {
    valueLength := len(value)
    suffixOffset := valueLength - identifierValueSuffixLength  // 40 - 4 = 36
    prefixOffset := identifierValuePrefixLength                 // 2

    if suffixOffset < 0 { /* error: 太短 */ }
    if suffixOffset == 0 { /* error: 恰好等于后缀长度,会暴露整个 key */ }
    if prefixOffset > suffixOffset { prefixOffset = suffixOffset }

    maskPrefix := value[:prefixOffset]      // 前 2 字符
    maskSuffix := value[suffixOffset:]      // 后 4 字符

    return MaskedIdentifier{
        Prefix:            prefix,            // "e2b_"
        ValueLength:       valueLength,       // 40
        MaskedValuePrefix: maskPrefix,        // "a1"
        MaskedValueSuffix: maskSuffix,        // "wxyz"
    }, nil
}
```

**两个边界检查**很关键:
- `suffixOffset < 0`:value 比后缀(4 字符)还短,没法 mask。
- `suffixOffset == 0`:value 恰好等于后缀长度——此时 `value[:0] + value[0:]` 等于 value 本身,**会暴露整个 key**,所以必须拒绝。

`keyLength = 20`(字节数)→ hex 后是 40 字符 → mask 后 UI 可以渲染成 `e2b_a1****************************wxyz`(中间星号数量 = 40 - 2 - 4 = 34)。

### 2.4 Team 绑定 + 可选 CreatedBy

```sql
-- team_api_keys 表的核心字段
team_id        uuid   NOT NULL,    -- 必须,绑定到 team
created_by     uuid,               -- 可选,创建者 user ID(admin 路径为 NULL)
api_key_hash   text   UNIQUE,      -- 唯一索引
...
```

- `team_id` 必填。一把 Key 只属于一个 team。
- `created_by` 可选:
  - 用户路径(`/api-keys`):填当前 `userID`
  - admin 路径(`/admin/teams/{id}/api-keys`):填 NULL(无具体创建者)
- `api_key_hash` 是 UNIQUE 索引,允许 O(1) 验证。

### 2.5 与 access token 的对照

| 维度 | API Key | Access Token |
| --- | --- | --- |
| 前缀 | `e2b_` | `sk_e2b_` |
| 绑定 | team | user |
| 状态 | **active** | **deprecated**(flag 控制是否还能创建) |
| 用法 | `X-API-Key` 头 | `Authorization: Bearer` |
| 创建端点 | `POST /api-keys` | `POST /access-tokens`(`deprecated: true`) |
| 删除端点 | `DELETE /api-keys/{id}` | `DELETE /access-tokens/{id}` |
| List / Update | 有 | 无(只有 create + delete) |

详见独立的 access-tokens 模块文档。

---

## 三、整体架构

### 3.1 装配序列

`api-keys` 端点不需要专门的装配——它们由 `APIStore` 直接挂载,共享全局的 OpenAPI 中间件。

实际路由注册发生在 oapi-codegen 生成的 `RegisterHandlers` 函数里(自动生成的代码),大致等价于:

```go
r.GET   ("/api-keys",                middleware → apiStore.GetApiKeys)
r.POST  ("/api-keys",                middleware → apiStore.PostApiKeys)
r.PATCH ("/api-keys/:apiKeyID",      middleware → apiStore.PatchApiKeysApiKeyID)
r.DELETE("/api-keys/:apiKeyID",      middleware → apiStore.DeleteApiKeysApiKeyID)
```

中间件链:
1. `limits.RequestSizeLimiter` — body 大小限制
2. `middleware.OapiRequestValidatorWithOptions` — schema 校验 + 鉴权

### 3.2 依赖图

```
APIStore
├── authDB   (packages/db/pkg/auth.Client)
│   ├── Read.GetTeamAPIKeysWithCreator
│   └── Write.CreateTeamAPIKey / UpdateTeamApiKey / DeleteTeamAPIKey
│       (后者两个由 team.CreateAPIKey / team.DeleteAPIKey 包装)
├── authService (仅间接,通过 ctx 拿 team)
└── featureFlags (本模块未直接使用,但访问 token 模块用了)
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
   ├── AuthProviderTeamAuth   验证 → setTeamInfo(ctx, team)
   │
   ▼
Handler (apikey.go)
   │
   ├── teamID := auth.MustGetTeamID(c)       ← 直接从 ctx 拿
   ├── userID := auth.MustGetUserID(c)        ← POST 时用
   │
   ├── 调 authDB.Read.* / authDB.Write.* / team.*
   │
   ▼
JSON 响应(创建时含明文 key,列表时只有 mask)
```

---

## 四、4 个端点逐一解析

### 4.1 GET /api-keys — 列出当前 team 的所有 Key

**Handler**:`APIStore.GetApiKeys` (`packages/api/internal/handlers/apikey.go:67`)

**鉴权**(OpenAPI spec):
```yaml
security:
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
  - AdminApiKeyAuth: []
    AdminTeamAuth: []
```
普通用户走第一组(OIDC),内部服务走第二组(admin 兜底)。

**流程**:

```go
teamID := auth.MustGetTeamID(c)
apiKeysDB, err := a.authDB.Read.GetTeamAPIKeysWithCreator(ctx, teamID)
// ...
teamAPIKeys := make([]api.TeamAPIKey, len(apiKeysDB))
for i, apiKey := range apiKeysDB {
    var createdBy *api.TeamUser
    if apiKey.CreatedByID != nil {
        createdBy = &api.TeamUser{Email: nil, Id: *apiKey.CreatedByID}
    }
    teamAPIKeys[i] = api.TeamAPIKey{
        Id:        apiKey.ID,
        Name:      apiKey.Name,
        Mask:      api.IdentifierMaskingDetails{...},
        CreatedAt: apiKey.CreatedAt,
        CreatedBy: createdBy,
        LastUsed:  apiKey.LastUsed,
    }
}
c.JSON(http.StatusOK, teamAPIKeys)
```

**关键点**:
- 用 `authDB.Read`(读副本),走 `GetTeamAPIKeysWithCreator` SQL。
- **响应里没有 hash,没有明文,只有 mask 字段**——前端用 mask 渲染 `e2b_a1****wxyz`。
- `createdBy.Email` 始终是 `nil`(SQL 没联表查 users 表,只返回 `created_by_id`)。前端要展示 email 需另外查。
- `LastUsed` 可能为 `nil`(从未使用过的 Key)。
- 失败时返回 `500` + "Error when getting team API keys",用 `c.String` 而非 `sendAPIStoreError`(细节差异,无大影响)。

### 4.2 POST /api-keys — 创建新 Key

**Handler**:`APIStore.PostApiKeys` (`apikey.go:138`)

**鉴权**:
```yaml
security:
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
```
注意:**没有 admin 兜底**。admin 路径走单独的 `POST /admin/teams/{teamID}/api-keys`。

**流程**:

```go
userID := auth.MustGetUserID(c)
teamID := auth.MustGetTeamID(c)

body, err := ginutils.ParseBody[api.NewTeamAPIKey](ctx, c)   // {name: "..."}

apiKey, err := team.CreateAPIKey(ctx, a.authDB, teamID, &userID, body.Name)
//                                                                  ^^^^^^^^
//                                                       注意:&userID(非 nil)

c.JSON(http.StatusCreated, api.CreatedTeamAPIKey{
    Id:        apiKey.ID,
    Name:      apiKey.Name,
    Key:       apiKey.RawAPIKey,    // ← 明文!仅此一次
    Mask:      api.IdentifierMaskingDetails{...},
    CreatedBy: &api.TeamUser{Id: userID, Email: nil},
    CreatedAt: apiKey.CreatedAt,
    LastUsed:  apiKey.LastUsed,
})
```

**关键点**:

1. **`createdBy = &userID`**:区别于 admin 路径的 nil。这是用户路径的标志。
2. **`Key` 字段返回明文**:`apiKey.RawAPIKey`(`e2b_...` 44 字符)。前端必须立刻保存,**刷新页面后就再也拿不到了**。
3. **不主动检查 blocked**:与 admin 路径不同。这里假设 OIDC 登录链路通过意味着 team 状态正常。
4. **不缓存**:Key 直接写 DB,下次请求验证时如果 cache miss 会查 DB,所以创建后立即可用。
5. **底层 `team.CreateAPIKey`** 详见 [6.1](#61-generatekey-的完整产物)。

**底层 `team.CreateAPIKey`**(`packages/api/internal/team/apikeys.go:21`):

```go
func CreateAPIKey(ctx context.Context, authDB *authdb.Client, teamID uuid.UUID, createdBy *uuid.UUID, name string) (CreateAPIKeyResponse, error) {
    teamApiKey, err := keys.GenerateKey(keys.ApiKeyPrefix)         // 1. 本地生成
    if err != nil { /* ... */ }

    apiKey, err := authDB.Write.CreateTeamAPIKey(ctx, authqueries.CreateTeamAPIKeyParams{
        TeamID:           teamID,
        CreatedBy:        createdBy,
        ApiKeyHash:       teamApiKey.HashedValue,
        ApiKeyPrefix:     teamApiKey.Masked.Prefix,
        ApiKeyLength:     int32(teamApiKey.Masked.ValueLength),
        ApiKeyMaskPrefix: teamApiKey.Masked.MaskedValuePrefix,
        ApiKeyMaskSuffix: teamApiKey.Masked.MaskedValueSuffix,
        Name:             name,
    })                                                             // 2. 落库
    if err != nil { /* ... */ }

    return CreateAPIKeyResponse{
        TeamApiKey: &apiKey,
        RawAPIKey:  teamApiKey.PrefixedRawValue,                    // 3. 一次性返回
    }, nil
}
```

### 4.3 PATCH /api-keys/{apiKeyID} — 重命名 Key

**Handler**:`APIStore.PatchApiKeysApiKeyID` (`apikey.go:22`)

**鉴权**:同 GET(支持 admin 兜底)。

**注意**:只能改 `name`,不能改 Key 本身。改 Key 的唯一方法是 delete + create。

**流程**:

```go
body, err := ginutils.ParseBody[api.UpdateTeamAPIKey](ctx, c)
apiKeyIDParsed, err := uuid.Parse(apiKeyID)
teamID := auth.MustGetTeamID(c)

now := time.Now()
_, err = a.authDB.Write.UpdateTeamApiKey(ctx, authqueries.UpdateTeamApiKeyParams{
    Name:      body.Name,
    UpdatedAt: &now,
    ID:        apiKeyIDParsed,
    TeamID:    teamID,            // ← 关键:WHERE id AND team_id
})
if dberrors.IsNotFoundError(err) {
    c.String(http.StatusNotFound, "id not found")
    return
}
// ...
c.Status(http.StatusAccepted)    // 注意:202,不是 200
```

**关键点**:
- SQL 用 `WHERE id = $1 AND team_id = $2`,**防跨 team 修改**(即使构造请求 `/api-keys/{别人 team 的 id}`,也匹配不到)。
- 成功返回 **202 Accepted**(代码 `c.Status(http.StatusAccepted)`)。注意 OpenAPI spec 声明的是 200(`spec/openapi.yml:3686`),这是 spec 与实现的已知不一致——以代码为准。
- 失败返回 404(找不到)或 500(DB 错误)。
- 响应 body 为空(只 status code)。

### 4.4 DELETE /api-keys/{apiKeyID} — 删除 Key

**Handler**:`APIStore.DeleteApiKeysApiKeyID` (`apikey.go:107`)

**鉴权**:同 GET。

**流程**:

```go
apiKeyIDParsed, err := uuid.Parse(apiKeyID)
teamID := auth.MustGetTeamID(c)

deleted, err := team.DeleteAPIKey(ctx, a.authDB, teamID, apiKeyIDParsed)
if !deleted {
    c.String(http.StatusNotFound, "id not found")
    return
}
c.Status(http.StatusNoContent)
```

**底层 `team.DeleteAPIKey`**(`packages/api/internal/team/apikeys.go:51`):

```go
func DeleteAPIKey(ctx, authDB, teamID, apiKeyID) (bool, error) {
    ids, err := authDB.Write.DeleteTeamAPIKey(ctx, authqueries.DeleteTeamAPIKeyParams{
        ID:     apiKeyID,
        TeamID: teamID,    // ← WHERE id AND team_id
    })
    return len(ids) > 0, nil
}
```

**关键点**:
- 同样用 `WHERE id AND team_id` 双重过滤。
- 返回 `deleted bool` 用于决定 404 还是 204。
- 删除后**不主动清缓存**——auth 模块的 team cache 有自己的 TTL,短期(约 5 分钟)内 Key 可能仍能用。详见 [8.3](#83-删除后缓存如何失效)。

---

## 五、关键流程时序图

### 5.1 创建 API Key

```
用户              dashboard / CLI           API (PostApiKeys)         Auth DB
 │                     │                          │                       │
 │ 1. 登录(OIDC)      │                          │                       │
 │<───────────────────>│                          │                       │
 │                     │                          │                       │
 │ 2. 创建 key         │                          │                       │
 │   "my-CI-key"       │                          │                       │
 ├────────────────────>│                          │                       │
 │                     │                          │                       │
 │                     │ 3. POST /api-keys        │                       │
 │                     │   Authorization: Bearer  │                       │
 │                     │   X-Team-Id: <uuid>      │                       │
 │                     │   {"name":"my-CI-key"}   │                       │
 │                     ├─────────────────────────>│                       │
 │                     │                          │                       │
 │                     │                          │ 4. keys.GenerateKey() │
 │                     │                          │   (本地:rand+SHA256)  │
 │                     │                          │                       │
 │                     │                          │ 5. Write.CreateTeamAPIKey
 │                     │                          ├──────────────────────>│
 │                     │                          │                  INSERT
 │                     │                          │<──────────────────────┤
 │                     │                          │                       │
 │                     │ 6. 201 Created           │                       │
 │                     │   {                      │                       │
 │                     │     id, name,            │                       │
 │                     │     key:"e2b_...",       │ ← 明文!仅此一次      │
 │                     │     mask:{...},          │                       │
 │                     │     createdBy:{id}       │                       │
 │                     │   }                      │                       │
 │                     │<─────────────────────────┤                       │
 │                     │                          │                       │
 │ 7. 显示明文 key      │                          │                       │
 │   "请保存,后将不再可见"│                          │                       │
 │<────────────────────┤                          │                       │
```

### 5.2 列出 + 删除

```
用户           dashboard / CLI        API                   Auth DB
 │                    │                  │                       │
 │ 列表               │                  │                       │
 ├───────────────────>│                  │                       │
 │                    │ GET /api-keys    │                       │
 │                    ├─────────────────>│                       │
 │                    │                  │ Read.GetTeamAPIKeysWithCreator
 │                    │                  ├──────────────────────>│
 │                    │                  │<──────────────────────┤
 │                    │                  │  (无 hash, 无明文)    │
 │                    │ 200 OK           │                       │
 │                    │  [{id, name,     │                       │
 │                    │    mask,          │                       │
 │                    │    createdBy,     │                       │
 │                    │    lastUsed},...] │                       │
 │                    │<─────────────────┤                       │
 │ 渲染列表            │                  │                       │
 │ e2b_a1****wxyz     │                  │                       │
 │<───────────────────┤                  │                       │
 │                    │                  │                       │
 │ 删除第二把          │                  │                       │
 ├───────────────────>│                  │                       │
 │                    │ DELETE /api-keys/{id}                    │
 │                    ├─────────────────>│                       │
 │                    │                  │ Write.DeleteTeamAPIKey │
 │                    │                  │  WHERE id AND team_id │
 │                    │                  ├──────────────────────>│
 │                    │                  │<──────────────────────┤
 │                    │ 204 No Content   │                       │
 │                    │<─────────────────┤                       │
```

---

## 六、keys 包深入

### 6.1 GenerateKey 的完整产物

`packages/shared/pkg/keys/key.go:66`:

```go
const keyLength = 20  // 字节数

func GenerateKey(prefix string) (Key, error) {
    keyBytes := make([]byte, keyLength)
    _, err := rand.Read(keyBytes)                        // 1. 20 字节随机(crypto/rand)
    if err != nil { return Key{}, err }

    generatedIdentifier := hex.EncodeToString(keyBytes)  // 2. hex → 40 字符

    mask, err := MaskKey(prefix, generatedIdentifier)    // 3. 计算 mask
    if err != nil { return Key{}, err }

    return Key{
        PrefixedRawValue: prefix + generatedIdentifier,  // "e2b_" + 40 字符 = 44 字符
        HashedValue:      hasher.Hash(keyBytes),         // SHA256 → $sha256$ + 43 字符 base64(共 51)
        Masked:           mask,
    }, nil
}
```

**返回的 `Key` 结构**:

| 字段 | 值示例 | 长度 | 用途 |
| --- | --- | --- | --- |
| `PrefixedRawValue` | `e2b_a1b2...wxyz` | 44 | 返回给用户一次 |
| `HashedValue` | `$sha256$<43 字符 base64>` | 51 | 落库 `api_key_hash` |
| `Masked.Prefix` | `e2b_` | 4 | UI 展示前缀 |
| `Masked.ValueLength` | `40` | - | UI 知道中间画几个星号 |
| `Masked.MaskedValuePrefix` | `a1` | 2 | UI 展示前 2 字符 |
| `Masked.MaskedValueSuffix` | `wxyz` | 4 | UI 展示后 4 字符 |

### 6.2 MaskKey 的窗口规则

详见 [2.3 Mask 策略](#23-mask-策略固定窗口)。

边界值:
- value 长度 < 4:返回 error(无法 mask 后缀)
- value 长度 = 4:返回 error(恰好等于后缀长度,会暴露整个 key)
- value 长度 = 5:prefixOffset 被 cap 到 1(避免和 suffix 重叠)
- value 长度 ≥ 6:正常 mask(prefix=2, suffix=4)

API key 的 value 是 40 字符,远超阈值。

### 6.3 VerifyKey:验证时的反向操作

`packages/shared/pkg/keys/key.go:100`:

```go
func VerifyKey(prefix string, key string) (string, error) {
    if !strings.HasPrefix(key, prefix) {
        return "", errors.New("invalid key prefix")
    }

    keyValue := key[len(prefix):]               // 去前缀
    keyBytes, err := hex.DecodeString(keyValue)  // hex → bytes
    if err != nil {
        return "", errors.New("invalid key")
    }

    return hasher.Hash(keyBytes), nil             // 重新 hash,与 DB 比对
}
```

**调用方**:`auth.ValidateAPIKey`(`packages/auth/pkg/auth/service.go:93`)

```go
hashedKey, err := keys.VerifyKey(keys.ApiKeyPrefix, apiKey)
// ...
result, err := s.teamCache.GetOrSet(ctx, hashedKey, func(...) {
    return s.store.GetTeamByHashedAPIKey(ctx, key)
})
```

**关键细节**:
- `VerifyKey` 本身**不查 DB**,只做格式校验和 hash 计算。
- 真正的 DB 查询在 `GetTeamByHashedAPIKey` 里,以 hash 为查询条件。
- 如果 hash 不存在于 DB,会返回 NotFound 错误,转 401。

### 6.4 MaskToken:日志安全辅助

`packages/shared/pkg/keys/key.go:90`:

```go
func MaskToken(prefix, token string) string {
    tokenWithoutPrefix := strings.TrimPrefix(token, prefix)
    masked, err := MaskKey(prefix, tokenWithoutPrefix)
    if err != nil {
        return "invalid_token_format"
    }
    return fmt.Sprintf("%s%s...%s",
        masked.Prefix,
        masked.MaskedValuePrefix,
        masked.MaskedValueSuffix)
}
```

**用途**:telemetry 埋点时把明文 token 转成 `e2b_a1...wxyz` 形式,避免明文进日志。

`auth.ValidateAPIKey` 里的用法:

```go
telemetry.SetAttributes(ginCtx.Request.Context(),
    telemetry.WithMaskedAPIKey(keys.MaskToken(keys.ApiKeyPrefix, apiKey)),
    // ...
)
```

---

## 七、数据模型

### 7.1 `team_api_keys` 表结构

完整字段(经过多次 migration 演化):

| 字段 | 类型 | 说明 | 来源 migration |
| --- | --- | --- | --- |
| `id` | uuid (PK) | API Key 记录 ID(注意:**不是 key 本身**) | `20241121225404_add_team_api_key_id.sql` |
| `team_id` | uuid (FK → teams) | 所属 team | `20231124185944_create_schemas_and_tables.sql`(建表) |
| `created_by` | uuid (FK → users, nullable) | 创建者 user ID | `20241120222814_add_team_api_key_metadata.sql` |
| `name` | text | 用户起的别名 | `20241120222814_add_team_api_key_metadata.sql` |
| `created_at` | timestamptz | 创建时间 | `20231124185944_create_schemas_and_tables.sql`(建表) |
| `updated_at` | timestamptz (nullable) | 修改时间(PATCH 时更新) | `20241120222814_add_team_api_key_metadata.sql` |
| `last_used` | timestamptz (nullable) | 最后一次用来鉴权的时间(异步更新) | `20241120222814_add_team_api_key_metadata.sql` |
| `api_key_hash` | text (UNIQUE) | `$sha256$<base64>`,51 字符 | `20250211160814_add_token_hashes.sql` |
| `api_key_prefix` | varchar(10) | `"e2b_"` | `20250606204750_optimize_hashed_key_schema.sql` |
| `api_key_length` | integer | 40 | `20250606204750_optimize_hashed_key_schema.sql` |
| `api_key_mask_prefix` | varchar(5) | 前 2 字符 | `20250606204750_optimize_hashed_key_schema.sql` |
| `api_key_mask_suffix` | varchar(5) | 后 4 字符 | `20250606204750_optimize_hashed_key_schema.sql` |

**演化历史**:
1. **2023-11-24** (`20231124185944_create_schemas_and_tables.sql`):建表,只有 3 个字段——`api_key` varchar(44) 作 PK(明文)、`created_at`、`team_id`。
2. **2024-11-20** (`20241120222814_add_team_api_key_metadata.sql`):加 `updated_at`、`name`、`last_used`、`created_by`(FK → auth.users)。
3. **2024-11-21** (`20241121225404_add_team_api_key_id.sql`):加 `id` uuid,把 PK 从 `api_key` 改成 `id`,并对 `api_key` 建 UNIQUE 索引。
4. **2025-02-11** (`20250211160814_add_token_hashes.sql`):加 `api_key_hash` UNIQUE 和 `api_key_mask`(开始**逐步从明文迁移到 hash**)。
5. **2025-06-06** (`20250606204750_optimize_hashed_key_schema.sql`):把单一的 `api_key_mask` 拆成 4 个字段(prefix/length/mask_prefix/mask_suffix),匹配 OpenAPI 的 `IdentifierMaskingDetails` schema。
6. **2025-08-25 ~ 2025-09-10**:多个 migration 做清理工作——为已有 key 反向计算 hash(`20250825102800_hash_existing_keys.sql`)、移除默认生成的 key(`20250825100000_remove_default_keys.sql`)、最终移除 `api_key` 明文列(`20250910124212_remove_raw_keys.sql`)。

> **演化要点**:这张表经历了"明文存 → 加 hash 并行 → 完全去掉明文"的三阶段迁移,跨度近两年。现在新代码完全不依赖 `api_key` 列(已删除)。

### 7.2 sqlc 查询

`packages/db/pkg/auth/sql_queries/api_keys/`:

| 查询 | 文件 | 用途 |
| --- | --- | --- |
| `CreateTeamAPIKey` | `create_team_api_key.sql` | INSERT 新 Key,RETURNING * |
| `GetTeamAPIKeysWithCreator` | `get_api_keys.sql` | SELECT team 的所有 Key(含 created_by_id) |
| `UpdateTeamApiKey` | `update_team_api_key.sql` | UPDATE name + updated_at |
| `DeleteTeamAPIKey` | `delete_team_api_key.sql` | DELETE WHERE id AND team_id,RETURNING id |
| `UpdateLastTimeUsed` | `update_last_time_used.sql` | UPDATE last_used WHERE hash = $1 |
| `GetTeamAPIKeyHashes` | `get_team_api_key_hashes.sql` | SELECT team 所有 hash(用于缓存失效) |

所有查询都用 `:one` 或 `:many` 或 `:exec` sqlc 模式,生成的 Go 代码在 `packages/db/pkg/auth/queries/`。

---

## 八、与 auth 验证链路的闭环

### 8.1 创建后,API Key 怎么被验证

完整闭环(`packages/auth/pkg/auth/service.go:93`):

```
用户请求 GET /sandboxes
   │
   │  X-API-Key: e2b_a1b2...wxyz
   ▼
ApiKeyAuthenticator.Authenticate
   │
   ▼
APIStore.GetTeamFromAPIKey(apiKey)
   │
   ▼
authService.ValidateAPIKey(apiKey)
   │
   ├── 1. keys.VerifyKey("e2b_", apiKey)
   │      → 检查 prefix、hex decode、SHA256 hash
   │      → 失败:401 "Invalid API key format"
   │
   ├── 2. teamCache.GetOrSet(hashedKey, lookup)
   │      │
   │      ├── 缓存命中 → 返回 team(快)
   │      │
   │      └── 缓存未命中 → store.GetTeamByHashedAPIKey(hashedKey)
   │                        │
   │                        ├── DB 查询(用 hash 作 WHERE)
   │                        ├── CheckTeamBanned(team)
   │                        ├── 异步 UpdateLastTimeUsed(hashedKey)
   │                        └── 返回 team
   │
   └── 3. telemetry.SetAttributes(maskedAPIKey, teamID)
```

**关键细节**:
- `teamCache` 的 key 就是 `hashedKey` 本身——所以一把 Key 验证一次后,后续请求直接走缓存。
- 缓存内容是 `*types.Team`,包含 team 的所有信息(banned、tier 等)。
- 失败的验证**不缓存**(否则攻击者可以构造大量无效 Key 撞库)。

### 8.2 last_used 异步更新

`packages/auth/pkg/auth/auth_store.go:42-50`:

```go
result, err := s.authDB.Read.GetTeamWithTierByAPIKey(ctx, hashedKey)
// ...

go func() {
    // 用独立 context,避免请求结束后被 cancel
    ctx := context.WithoutCancel(ctx)
    updateErr := s.authDB.Write.UpdateLastTimeUsed(ctx, hashedKey)
    if updateErr != nil {
        logger.L().Error(ctx, "failed to update last time used", zap.Error(updateErr))
    }
}()
```

**设计要点**:
- **异步**:不阻塞请求,DB 写延迟不影响 API 响应时间。
- **独立 context**:`context.WithoutCancel(ctx)` 防止请求 ctx 取消后写失败。
- **失败只记日志**:last_used 不影响功能,丢了无所谓。
- **每次都写**:不做去重 / 限流,所以高 QPS 的 Key 会频繁写 DB(可优化空间)。

### 8.3 删除后,缓存如何失效

**短回答**:不主动失效。

**详细分析**:

DELETE `/api-keys/{id}` 后:
1. DB 里这把 Key 已经 DELETE。
2. 但 `teamCache` 里以 hash 为 key 的 `*types.Team` 条目**还在**(默认 TTL 5 分钟,`authInfoExpiration`,见 `packages/auth/pkg/auth/cache.go:14`)。
3. 在缓存过期前,用这把 Key 调 API **仍会成功**——因为缓存命中,根本不查 DB。

**为什么不主动清缓存**?
- 主动清需要拿到 hash,但 DELETE 端点只接收 `id`(UUID),要做一次 DB 查询才能拿到 hash。
- 增加复杂度,且 5 分钟 TTL 已经足够短。
- 安全敏感场景应该轮换整个 `ADMIN_TOKEN` / 用户重新登录。

**生产实践**:
- 如果某把 Key 泄漏需要立刻失效,**不能只 DELETE**。
- 应该用 admin 路径的 `POST /admin/teams/{teamID}/sandboxes/kill` 等运维手段强制清理,或者用 `authService.InvalidateTeamCache(teamID)`(见 admin-module.md 的 [13.6](./admin-module.md#136-为什么-kill-sandboxes-前后各-invalidate-cache-一次))清整个 team 的缓存。

---

## 九、配置与 Feature Flag

`api-keys` 模块本身**不直接挂任何 feature flag**,但相关的认证链路有以下 flag:

| Flag | 默认 | 影响范围 | 说明 |
| --- | --- | --- | --- |
| `disable-e2b-access-token-provisioning` | false | access token(非本模块) | POST /access-tokens 打开时返回 410 |

**环境变量**:
- `api-keys` 模块本身无专用 env。
- 但整个认证链路依赖 `auth-service` 的 env(详见 auth-module.md 第十一章)。

---

## 十、关键代码文件索引

### 10.1 handlers(`packages/api/internal/handlers/`)

| 文件 | 主要函数 |
| --- | --- |
| `apikey.go:22` | `PatchApiKeysApiKeyID` |
| `apikey.go:67` | `GetApiKeys` |
| `apikey.go:107` | `DeleteApiKeysApiKeyID` |
| `apikey.go:138` | `PostApiKeys` |
| `store.go:389` | `GetTeamFromAPIKey`(间接被 auth 调) |

### 10.2 team(`packages/api/internal/team/`)

| 文件 | 函数 |
| --- | --- |
| `apikeys.go:21` | `CreateAPIKey`(与 admin 路径共用) |
| `apikeys.go:51` | `DeleteAPIKey`(与 admin 路径共用) |

### 10.3 keys 包(`packages/shared/pkg/keys/`)

| 文件 | 主要 API |
| --- | --- |
| `constants.go` | `ApiKeyPrefix = "e2b_"`,`AccessTokenPrefix = "sk_e2b_"` |
| `key.go:18` | `hasher = NewSHA256Hashing()`(默认 hasher) |
| `key.go:33` | `MaskKey(prefix, value)` |
| `key.go:66` | `GenerateKey(prefix)` |
| `key.go:90` | `MaskToken(prefix, token)` |
| `key.go:100` | `VerifyKey(prefix, key)` |
| `sha256.go` | `SHA256Hashing.Hash()` |
| `hmac_sha256.go` | `HMACSha256Hashing`(可选,目前未默认启用) |

### 10.4 auth 验证链路(`packages/auth/pkg/auth/`)

| 文件 | 主要函数 |
| --- | --- |
| `service.go:93` | `ValidateAPIKey` |
| `service.go:140` | `ValidateAccessToken`(对照) |
| `auth_store.go:29-54` | `GetTeamByHashedAPIKey` + 异步 UpdateLastTimeUsed |
| `auth_store.go:104` | `GetTeamAPIKeyHashes`(缓存失效用) |
| `service.go:261` | `InvalidateTeamCache` |
| `middleware.go:133` | `NewApiKeyAuthenticator` |
| `gin.go:45` | `MustGetTeamID` |
| `gin.go:23` | `MustGetUserID` |

### 10.5 DB(`packages/db/`)

| 文件 | 查询 |
| --- | --- |
| `pkg/auth/sql_queries/api_keys/create_team_api_key.sql` | `CreateTeamAPIKey :one` |
| `pkg/auth/sql_queries/api_keys/get_api_keys.sql` | `GetTeamAPIKeysWithCreator :many` |
| `pkg/auth/sql_queries/api_keys/update_team_api_key.sql` | `UpdateTeamApiKey :one` |
| `pkg/auth/sql_queries/api_keys/delete_team_api_key.sql` | `DeleteTeamAPIKey :many` |
| `pkg/auth/sql_queries/api_keys/update_last_time_used.sql` | `UpdateLastTimeUsed :exec` |
| `pkg/auth/sql_queries/api_keys/get_team_api_key_hashes.sql` | `GetTeamAPIKeyHashes :many` |
| `migrations/20231124185944_create_schemas_and_tables.sql` | 建表 |
| `migrations/20250211160814_add_token_hashes.sql` | 加 hash |
| `migrations/20250606204750_optimize_hashed_key_schema.sql` | 拆 mask |

### 10.6 OpenAPI spec

| 位置 | 内容 |
| --- | --- |
| `spec/openapi.yml:3619` | `/api-keys` GET/POST 定义 |
| `spec/openapi.yml:3667` | `/api-keys/{apiKeyID}` PATCH/DELETE 定义 |
| `spec/openapi.yml:1772` | `TeamAPIKey` schema |
| `spec/openapi.yml:1802` | `CreatedTeamAPIKey` schema |
| `spec/openapi.yml:1836` | `NewTeamAPIKey` schema |
| `spec/openapi.yml:1844` | `UpdateTeamAPIKey` schema |
| `spec/openapi.yml:1926` | `IdentifierMaskingDetails` schema |

---

## 十一、设计要点与权衡

### 11.1 为什么用 SHA256 而不是 bcrypt?

详见 [2.2](#22-hash-策略sha256不是-bcrypt)。简而言之:**API Key 是高熵随机串(160 bit),不需要 bcrypt 的"慢"**,且 SHA256 是确定性的,可以直接做 DB 索引。

### 11.2 为什么明文只返回一次?

- **降低泄漏面**:DB 不存明文,即使 DB 全量泄漏,攻击者也拿不到可用的 Key。
- **UI/CLI 必须立刻保存**:这是行业标准设计(GitHub PAT、AWS secret key 都是这样)。
- **不提供"读取明文"接口**:即使是创建者本人,丢了一把 Key 也只能重置。

### 11.3 为什么 mask 用固定窗口(2 + 4),而不是百分比?

- 固定窗口让 UI 渲染逻辑稳定:无论 key 多长,前 2 后 4,中间星号。
- 百分比会导致短 key 暴露过多、长 key 暴露过少。
- 2 + 4 = 6 字符暴露,对 40 字符的 key 来说足够识别(用户能认出"是我的 Key"),又不足以重建。

### 11.4 为什么 PATCH 只能改 name?

- **改 name 是无害操作**:不影响 Key 本身的鉴权能力。
- **不允许"改 Key"**:Key 一旦生成,hash 就固定。要"换 Key"必须 delete + create(新的 hash、新的 mask)。
- **不允许改 team_id**:跨 team 转移 Key 没有业务场景,且容易出错。
- **不允许改 created_by**:历史信息,改了破坏审计。
- **不允许改 created_at/last_used**:这些是系统字段。

### 11.5 为什么 DELETE 用 `WHERE id AND team_id`?

详见 admin-module.md 的 [13.9](./admin-module.md#139-为什么-deleteapikey-同时按-id-和-team_id-过滤)。简而言之:**防跨 team 删除**,纵深防御。

### 11.6 为什么创建后不主动清缓存,删除后也不主动清?

详见 [8.3](#83-删除后缓存如何失效)。简而言之:
- 创建后不需要清(新 hash 在缓存里没有,会自然 miss → 查 DB)。
- 删除后清缓存代价高(要先查 hash)。
- 5 分钟 TTL 已经足够短,业务可接受。
- 安全敏感场景应直接 invalidateTeamCache(teamID) 整体清。

### 11.7 为什么 POST `/api-keys` 不接受 admin auth?

```yaml
# OpenAPI: POST /api-keys
security:
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
# 注意:没有 AdminApiKeyAuth + AdminTeamAuth 备选
```

对比 GET / PATCH / DELETE 都有 admin 兜底。

原因:
- **创建 API Key 是高权限操作**。如果允许 admin 代调,容易出现"内部服务用 admin token 创建 Key,但没人记得是谁创建的"。
- **admin 路径有自己的 POST /admin/teams/{teamID}/api-keys**:那里 `createdBy = nil`,明确标记"无创建者"。
- 两条路径职责分离,不会混淆审计语义。

### 11.8 为什么 GetApiKeys 不返回 email?

```go
createdBy = &api.TeamUser{Email: nil, Id: *apiKey.CreatedByID}
```

`SQL GetTeamAPIKeysWithCreator` 实际只 SELECT 了 `created_by_id`,没有 JOIN `auth.users` 表。原因:
- email 字段在 `auth` schema(api_keys 在 public schema),跨 schema JOIN 性能差。
- 列表场景下不需要 email,UI 拿 ID 已经够用。
- 想看 email 可以单独调 `/users/{id}` 或 dashboard 的 user 接口。

### 11.9 为什么 PATCH 返回 202 而不是 200?

- **202 Accepted** 语义上是"请求已接受,但未必完成"。
- 在 PATCH 场景下,虽然 DB 写是同步的,但 202 暗示"修改已提交,可能还在传播到缓存/读副本"。
- 这是 HTTP 习惯做法,不影响功能。

### 11.10 为什么 `createdBy` 是指针(可空)而不是 UUID?

```go
type TeamAPIKey struct {
    CreatedBy *TeamUser `json:"createdBy"`  // 指针
    // ...
}
```

- 区分"未设置"(admin 创建,nil)和"零值"(理论上 user ID 不会是零 UUID,但指针更明确)。
- JSON 序列化时,nil 指针渲染成 `null`,前端能区分"无创建者"和"创建者信息未加载"。

---

## 十二、常见问题与排查

### Q1: 用户报告"创建后看到 key,刷新页面就找不到了"

**说明**:这是设计行为。明文 key 只在 POST 响应里出现一次。

**处理**:
- 提示用户在创建时立刻保存到密码管理器。
- 如果丢失,**只能删除重建**——系统无法找回明文。

### Q2: 用户报告"明明删了 key,但 CI 还在用,几分钟后才失效"

**说明**:auth 模块的 team cache(详见 [8.3](#83-删除后缓存如何失效))有约 5 分钟 TTL(`authInfoExpiration`)。在缓存过期前,这把 key 仍能通过验证。

**处理**:
- 等待约 5 分钟。
- **要立刻失效**的话:用 admin token 调 `POST /admin/teams/{teamID}/sandboxes/kill`(虽然这是杀沙箱,但前置会调 `InvalidateTeamCache`)。或者直接调内部 `authService.InvalidateTeamCache(teamID)` 接口。

### Q3: PATCH 返回 404 "id not found"

**可能原因**:
1. apiKeyID 不是合法 UUID → 实际上会先返回 400。
2. apiKeyID 合法,但**不属于当前 team** → SQL `WHERE id AND team_id` 不匹配,返回 NotFound。

**排查**:
```sql
SELECT team_id FROM team_api_keys WHERE id = '<apiKeyID>';
-- 对比用户当前 teamID
```

### Q4: 创建时返回 500 "Error when creating team API key"

**可能原因**:
1. **hash 冲突**——`api_key_hash` 是 UNIQUE,理论上 20 字节随机碰撞概率约 1/2^160,实际不会发生。但如果发生,DB 会返回 UNIQUE 违约。
2. **DB 写失败**(连接断、磁盘满)。
3. **外键违约**——team_id 不存在(理论上 OIDC 登录保证不会发生)。

**排查**:看 API 日志,搜 "error when creating team API key"。

### Q5: 用户报告"用 key 调 API 拿到 401 'Invalid API key format'"

**说明**:`keys.VerifyKey` 在 prefix 检查或 hex 解码失败时返回此错误。

**常见原因**:
- Key 没带 `e2b_` 前缀(用户复制时漏了)。
- Key 中间有非 hex 字符(被截断或加了空格/换行)。
- 用户传的是 mask 形式(`e2b_a1****wxyz`)而不是真 key。

**排查**:让用户检查 key 长度(应该是 44 字符:`e2b_` + 40 hex)。

### Q6: 用户报告"用 key 调 API 拿到 401 'Cannot get the team for the given API key'"

**说明**:`VerifyKey` 成功(格式 OK)但 DB 里查不到这个 hash。

**常见原因**:
1. Key 已被删除(但缓存已过期)。
2. Key 来自其他环境(staging 的 key 用到 prod)。
3. DB 主从复制延迟(刚创建,读副本还没同步)。

**排查**:
```sql
SELECT * FROM team_api_keys WHERE api_key_hash = '<hashedKey>';
```

### Q7: 列表里某把 key 的 `lastUsed` 是 null

**说明**:这把 key 从创建后**从未被用来调过 API**。

**排查**:
- 检查使用方是否真的在调 API(CI 可能用了别的 key)。
- 如果用户报告"我明明在用",检查 key 是否过期或 team 是否被 banned。

### Q8: 用户问"能不能改 key 的值(旋转 secret)?"

**回答**:不能。PATCH 只能改 name。**要"旋转"必须**:
1. 创建新 key(POST)。
2. 把新 key 部署到所有使用方。
3. 验证新 key 工作。
4. 删除旧 key(DELETE)。

这是行业标准做法,避免"旋转期间的歧义"。

### Q9: 内部服务能否用 admin token 调 POST /api-keys 代用户创建?

**不能**。POST /api-keys 不接受 admin auth(详见 [11.7](#117-为什么-post-api-keys-不接受-admin-auth))。

**替代**:调 `POST /admin/teams/{teamID}/api-keys`(admin 路径)。注意:
- `createdBy` 会是 nil(无创建者)。
- 同样会校验 blocked 状态。

### Q10: 如何审计 API Key 的创建/删除?

- **创建/删除**:`telemetry.ReportCriticalError` 在 error 路径有埋点,但 happy path 没有。需要查 DB 的 `created_at` / `updated_at` / 是否存在。
- **使用**(每次鉴权):telemetry 带上 `maskedAPIKey`,在 Grafana 里按 maskedAPIKey 聚合可以看到使用情况。

---

## 附录 A:端点速查表

### A.1 4 个 api-keys 端点

| 端点 | 方法 | 鉴权 | 成功 | 失败常见码 |
| --- | --- | --- | --- | --- |
| `/api-keys` | GET | OIDC / admin | 200 + `[TeamAPIKey]` | 401, 500 |
| `/api-keys` | POST | OIDC only(**无 admin**) | 201 + `CreatedTeamAPIKey` | 400, 401, 500 |
| `/api-keys/{apiKeyID}` | PATCH | OIDC / admin | 202(无 body) | 400, 401, 404, 500 |
| `/api-keys/{apiKeyID}` | DELETE | OIDC / admin | 204(无 body) | 400, 401, 404, 500 |

### A.2 Key 生命周期状态机

```
   (用户)创建             (用户)删除           (审计/缓存)
       │                      │                     │
       ▼                      ▼                     ▼
   ┌────────┐  ──────────>  ┌────────┐  ──────>  ┌────────┐
   │ active │               │deleted │           │ cached │
   │  (DB)  │               │ (gone) │           │(5 min) │
   └────────┘               └────────┘           └────────┘
       │                                              │
       │ 每次鉴权                                       │ TTL 到期
       ▼                                              ▼
   update last_used                               cache miss
   (异步)                                         → 查 DB → 401
```

### A.3 字段映射:Key 结构 → DB → API 响应

| `Key` 结构字段 | DB 字段 | API 响应字段 | 出现位置 |
| --- | --- | --- | --- |
| `PrefixedRawValue` | (不存) | `CreatedTeamAPIKey.key` | POST 响应(一次) |
| `HashedValue` | `api_key_hash` | (不返回) | DB / cache key |
| `Masked.Prefix` | `api_key_prefix` | `Mask.prefix` | 列表 + POST 响应 |
| `Masked.ValueLength` | `api_key_length` | `Mask.valueLength` | 列表 + POST 响应 |
| `Masked.MaskedValuePrefix` | `api_key_mask_prefix` | `Mask.maskedValuePrefix` | 列表 + POST 响应 |
| `Masked.MaskedValueSuffix` | `api_key_mask_suffix` | `Mask.maskedValueSuffix` | 列表 + POST 响应 |
| (UUID) | `id` | `id` | 列表 + POST 响应 |
| (用户输入) | `name` | `name` | 列表 + POST 响应 |
| (系统) | `created_at` | `createdAt` | 列表 + POST 响应 |
| (系统,异步) | `last_used` | `lastUsed` | 列表(nullable) |
| (ctx userID) | `created_by` | `createdBy.id` | 列表(nullable) |

---

## 附录 B:错误码与 HTTP 状态映射

| 场景 | HTTP | 说明 |
| --- | --- | --- |
| Body 解析失败 | 400 | "Error when parsing request: ..." |
| apiKeyID 不是 UUID | 400 | "Error when parsing API key ID: ..." |
| 未鉴权 | 401 | (由中间件返回) |
| PATCH 找不到 | 404 | "id not found" |
| DELETE 找不到 | 404 | "id not found" |
| DB 错误 | 500 | "Error when ..." |
| 成功(GET) | 200 | JSON 数组 |
| 成功(POST) | 201 | JSON(含明文 key) |
| 成功(PATCH) | 202 | 无 body |
| 成功(DELETE) | 204 | 无 body |

---

## 附录 C:术语表

| 术语 | 含义 |
| --- | --- |
| **API Key** | 团队级凭证,前缀 `e2b_`,44 字符,作 `X-API-Key` 头 |
| **Access Token** | 用户级凭证(已废弃),前缀 `sk_e2b_`,作 `Authorization: Bearer` |
| **明文 / PrefixedRawValue** | key 的完整形式,只在 POST 响应里出现一次 |
| **Hash** | `$sha256$` + 43 字符 base64(总 51),落库 + 缓存 key |
| **Mask** | 固定窗口(前 2 + 后 4),用于 UI 展示 |
| **`team_api_keys` 表** | team 级 key 的存储,uuid PK + hash UNIQUE |
| **`access_tokens` 表** | user 级 token 的存储(对照) |
| **createdBy** | 创建者 user ID。用户路径填,admin 路径为 nil |
| **last_used** | 最后一次鉴权时间,异步更新,可为 null |
| **team cache** | auth 模块的 Redis 缓存,key 是 hashedKey,value 是 Team |
| **VerifyKey** | 验证函数:prefix 检查 + hex decode + SHA256 |
| **GenerateKey** | 生成函数:20 字节随机 + hex + SHA256 + mask |
| **MaskToken** | 日志辅助:把明文转成 `e2b_a1...wxyz` |
| **`authDB.Read`** | 读副本(用于 GetTeamAPIKeysWithCreator) |
| **`authDB.Write`** | 主库(用于 Create/Update/Delete) |
| **PatchApiKeys 不接受 admin** | POST 路径无 admin 兜底,代调必须走 admin 路径 |
