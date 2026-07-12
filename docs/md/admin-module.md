# E2B Admin(管理面)模块详解

> 模块定位:为 E2B 内部服务与运维操作提供"绕过用户身份"的特权通道,核心是 `X-Admin-Token` 鉴权;特权端点(`/admin/**` 与 `/nodes/**`)用 path param 拿 teamID,普通端点则用 `X-Admin-Token` + `X-Team-ID` AND 组合作为内部服务代调通道。
>
> 适用代码范围:
> - `packages/api/internal/handlers/admin*.go`
> - `packages/api/internal/orchestrator/admin.go`
> - `packages/api/internal/team/apikeys.go`
> - `packages/auth/pkg/auth/middleware.go` 中的 `NewAdminApiKeyAuthenticator` / `NewAdminTeamAuthenticator`
> - `spec/openapi.yml` 中所有 `tags: [admin]` 的端点

## 目录

- [一、概述](#一概述)
  - [1.1 admin 是什么](#11-admin-是什么)
  - [1.2 关键定位:两件不同的事](#12-关键定位两件不同的事)
  - [1.3 关键心智模型](#13-关键心智模型)
  - [1.4 整体架构](#14-整体架构)
- [二、核心概念](#二核心概念)
  - [2.1 Admin Token](#21-admin-token)
  - [2.2 AdminTeamAuth:配对的 Team 上下文(用于非 admin 端点的内部服务通道)](#22-adminteamauth配对的-team-上下文用于非-admin-端点的内部服务通道)
  - [2.3 三类特权操作](#23-三类特权操作)
  - [2.4 与普通认证的关系:它是"第五种"凭证](#24-与普通认证的关系它是第五种凭证)
- [三、整体架构](#三整体架构)
  - [3.1 装配序列(api 服务)](#31-装配序列api-服务)
  - [3.2 依赖图](#32-依赖图)
  - [3.3 数据流总览](#33-数据流总览)
- [四、认证深入](#四认证深入)
  - [4.1 AdminApiKeyAuth 验证流程](#41-adminapikeyauth-验证流程)
  - [4.2 AdminTeamAuth 验证流程(用于非 admin 端点的代调通道)](#42-adminteamauth-验证流程用于非-admin-端点的代调通道)
  - [4.3 字母序命名的奥秘](#43-字母序命名的奥秘)
  - [4.4 跨端点复用:为什么几乎所有端点都接受 admin auth](#44-跨端点复用为什么几乎所有端点都接受-admin-auth)
- [五、7 个端点逐一解析](#五7-个端点逐一解析)
  - [5.1 GET /nodes — 列出所有节点](#51-get-nodes--列出所有节点)
  - [5.2 GET /nodes/{nodeID} — 节点详情](#52-get-nodesnodeid--节点详情)
  - [5.3 POST /nodes/{nodeID} — 节点状态覆盖](#53-post-nodesnodeid--节点状态覆盖)
  - [5.4 POST /admin/teams/{teamID}/sandboxes/kill — 批量杀团队沙箱](#54-post-adminteamsbyteamidsandboxeskill--批量杀团队沙箱)
  - [5.5 POST /admin/teams/{teamID}/builds/cancel — 批量取消团队构建](#55-post-adminteamsbyteamidbuildscancel--批量取消团队构建)
  - [5.6 POST /admin/teams/{teamID}/api-keys — 创建团队 API Key](#56-post-adminteamsbyteamidapi-keys--创建团队-api-key)
  - [5.7 DELETE /admin/teams/{teamID}/api-keys/{apiKeyID} — 删除团队 API Key](#57-delete-adminteamsbyteamidapi-keysapikeyid--删除团队-api-key)
- [六、关键流程时序图](#六关键流程时序图)
  - [6.1 批量杀团队沙箱](#61-批量杀团队沙箱)
  - [6.2 批量取消团队构建](#62-批量取消团队构建)
  - [6.3 创建团队 API Key(admin 路径)](#63-创建团队-api-keyadmin-路径)
- [七、数据模型](#七数据模型)
  - [7.1 涉及的表](#71-涉及的表)
  - [7.2 sqlc 查询](#72-sqlc-查询)
  - [7.3 关键 SQL:`GetCancellableTemplateBuildsByTeam`](#73-关键-sqlgetcancellabletemplatebuildsbyteam)
- [八、并发与限流](#八并发与限流)
  - [8.1 errgroup SetLimit(10)](#81-errgroup-setlimit10)
  - [8.2 失败容忍:单个失败不阻塞整体](#82-失败容忍单个失败不阻塞整体)
  - [8.3 原子计数器:killedCount / failedCount](#83-原子计数器killedcount--failedcount)
- [九、与 Orchestrator 的交互](#九与-orchestrator-的交互)
  - [9.1 Node 数据来源:本地缓存 + gRPC 心跳](#91-node-数据来源本地缓存--grpc-心跳)
  - [9.2 RemoveSandbox 调用链](#92-removesandbox-调用链)
  - [9.3 gRPC ServiceStatusOverride](#93-grpc-servicestatusoverride)
- [十、配置与环境变量](#十配置与环境变量)
- [十一、Feature Flags](#十一feature-flags)
- [十二、关键代码文件索引](#十二关键代码文件索引)
- [十三、设计要点与权衡](#十三设计要点与权衡)
- [十四、常见问题与排查](#十四常见问题与排查)
- [附录 A:端点速查表](#附录-a端点速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录-b错误码与-http-状态映射)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

### 1.1 admin 是什么

`admin` 不是 E2B 暴露给终端用户的功能模块,而是面向**内部服务**(如 dashboard-api、计费、运维脚本、客服工具)的"特权操作面"。它解决两类需求:

1. **以服务身份代替用户身份调 API**。例如 dashboard-api 想列出某个 team 的所有沙箱,但它本身没有 user 身份,只有"我是 E2B 后台"这一信息。
2. **执行用户路径无法触达的运维操作**。例如批量杀掉某个 team 的所有沙箱、强制取消所有正在跑的构建、把某个节点标记为 draining。

OpenAPI 里 `tags: [admin]` 的端点共 **7 个**,全部要求 `AdminApiKeyAuth`(`X-Admin-Token` 头):

| 路径 | 方法 | 功能 |
| --- | --- | --- |
| `/nodes` | GET | 列出集群内所有 orchestrator 节点 |
| `/nodes/{nodeID}` | GET | 节点详情 |
| `/nodes/{nodeID}` | POST | 覆盖节点状态(ready/draining/...) |
| `/admin/teams/{teamID}/sandboxes/kill` | POST | 批量杀团队沙箱 |
| `/admin/teams/{teamID}/builds/cancel` | POST | 批量取消团队构建 |
| `/admin/teams/{teamID}/api-keys` | POST | 为团队创建 API Key |
| `/admin/teams/{teamID}/api-keys/{apiKeyID}` | DELETE | 删除团队的某把 API Key |

### 1.2 关键定位:两件不同的事

`admin` 在代码里其实同时承担两个语义,务必分清:

| 语义 | 体现位置 | 说明 |
| --- | --- | --- |
| **特权端点** | `/nodes/**`, `/admin/teams/**` | 只能由 admin token 调用,普通用户凭证(包括 OIDC、API Key、Access Token)一概拒绝 |
| **特权鉴权方案** | `AdminApiKeyAuth` / `AdminTeamAuth` | 作为 OpenAPI security scheme,被广泛复用在**几乎所有其他端点**作为"内部服务调用"通道 |

也就是说,"用 admin 凭证调用 `/sandboxes`" 这种事是合法且常见的——例如 dashboard-api 用 admin token 代用户查沙箱。**这不是漏洞,是设计**。

### 1.3 关键心智模型

理解 admin 模块只需记住五句话:

1. **Token 是全局静态的**。一个集群一个 `ADMIN_TOKEN`,所有 admin 请求共享。
2. **特权端点用 path param 拿 teamID**。`/admin/teams/{teamID}/...` 不读 `X-Team-ID`,teamID 在 URL 里,handler 自己调 `GetTeamByID`。
3. **非 admin 端点用 `X-Team-ID` 兜底**。`/sandboxes` 等用户端点接受 `{AdminApiKeyAuth, AdminTeamAuth}` AND 组合,作为内部服务代调通道。
4. **字母序决定执行顺序**。`AdminApiKeyAuth` 在 `AdminTeamAuth` 之前,所以 token 先验证、team 上下文后填——避免无 token 的请求打 DB。
5. **运维操作走 errgroup 并发,失败不回滚**。批量杀沙箱 100 个里失败 3 个,API 会返回 `failedCount: 3`,剩下的照样杀完。

### 1.4 整体架构

```
                  ┌──────────────────────────────────┐
                  │  内部服务 (dashboard-api / CLI /  │
                  │  计费 / 客服工具 / 运维脚本)      │
                  └──────────────┬───────────────────┘
                                 │
                                 │  调 /admin/teams/{id}/...:
                                 │    X-Admin-Token: <ADMIN_TOKEN>
                                 │    teamID 在 path 里
                                 │
                                 │  调 /sandboxes 等用户端点(代调):
                                 │    X-Admin-Token: <ADMIN_TOKEN>
                                 │    X-Team-ID:     <teamUUID>
                                 ▼
        ┌────────────────────────────────────────────────────┐
        │                API (Gin + oapi-codegen)            │
        │  ┌────────────────────────────────────────────┐    │
        │  │ AdminApiKeyAuthenticator                   │    │
        │  │  subtle.ConstantTimeCompare(token, ADMIN)  │    │
        │  └────────────────────────────────────────────┘    │
        │  ┌────────────────────────────────────────────┐    │
        │  │ AdminTeamAuthenticator                    │    │
        │  │  GetTeamFromAdminToken(teamID)            │    │
        │  │  → authService.GetTeamByID → Team         │    │
        │  └────────────────────────────────────────────┘    │
        │                                                  │
        │  handlers/admin*.go:                              │
        │   - GetNodes / GetNodesNodeID / PostNodesNodeID   │
        │   - PostAdminTeamsTeamIDSandboxesKill             │
        │   - PostAdminTeamsTeamIDBuildsCancel              │
        │   - PostAdminTeamsTeamIDApiKeys                   │
        │   - DeleteAdminTeamsTeamIDApiKeysApiKeyID         │
        └────────────┬──────────────┬─────────────┬─────────┘
                     │              │             │
                     ▼              ▼             ▼
              ┌──────────┐  ┌────────────┐  ┌────────────┐
              │  Orch.   │  │  Template  │  │  Auth DB   │
              │ (gRPC)   │  │  Manager   │  │ (PgSQL)    │
              │          │  │  (gRPC)    │  │            │
              └──────────┘  └────────────┘  └────────────┘
```

---

## 二、核心概念

### 2.1 Admin Token

- **来源**:启动时通过 `ADMIN_TOKEN` 环境变量注入(`packages/api/internal/cfg/model.go:30`),不会落库,不与任何 team 绑定。
- **形式**:任意字符串。生产环境由部署流水线随机生成并通过 GCP Secrets Manager 注入容器。
- **比较方式**:`crypto/subtle.ConstantTimeCompare`,**常量时间比较**防时序攻击(`packages/auth/pkg/auth/middleware.go:120`)。
- **失效条件**:进程重启且环境变量改了才失效。线上轮换需要重新部署。
- **可见服务**:`api`(`main.go:195`)和 `dashboard-api`(`main.go:238`)都装载同一个 token;这两个服务必须共享 token,否则跨服务调用会失败。

```go
// packages/auth/pkg/auth/middleware.go:118
func adminValidationFunction(adminToken string) func(...) (struct{}, *APIError) {
    return func(_ context.Context, _ *gin.Context, token string) (struct{}, *APIError) {
        if subtle.ConstantTimeCompare([]byte(token), []byte(adminToken)) != 1 {
            return struct{}{}, &APIError{
                Code: http.StatusUnauthorized,
                Err:  errors.New("invalid access token"),
                ClientMsg: "Invalid Access token.",
            }
        }
        return struct{}{}, nil
    }
}
```

注意返回的 `struct{}`——admin token 验证不向 ctx 注入任何身份信息,因为它代表的不是某个用户/团队,而是"后台"这个抽象主体。

### 2.2 AdminTeamAuth:配对的 Team 上下文(用于非 admin 端点的内部服务通道)

> ⚠️ **关键澄清**:`AdminTeamAuth` **不用于** `/admin/teams/{teamID}/...` 这类特权端点。那些端点的 `teamID` 来自 **path param**,handler 内部自己调 `authService.GetTeamByID`。
>
> `AdminTeamAuth` 只在**非 admin 端点**(如 `/sandboxes`、`/templates`、`/volumes`)作为"内部服务代调"的 admin 兜底通道时使用——它和 `AdminApiKeyAuth` 以 AND 组合出现,允许 dashboard-api 等内部服务用 admin token + 指定 teamID 代用户调 API。详见 [4.4](#44-跨端点复用为什么几乎所有端点都接受-admin-auth)。

`AdminTeamAuth` security scheme 的定义:

- **Header**:`X-Team-ID`(字符串形式的 UUID)
- **验证函数**:`APIStore.GetTeamFromAdminToken`(`packages/api/internal/handlers/store.go:417`)
- **行为**:解析 UUID → 调 `authService.GetTeamByID` → 返回 `*types.Team`,注入 ctx
- **错误映射**:
  - UUID 解析失败 → `400 Invalid team ID`
  - Team 不存在 → `404 Team not found`
  - Team 是 `banned` → `403 Team is banned`(由 `TeamForbiddenError` 表达)
  - 其他 DB 错误 → `500 Backend authentication failed`

```go
// packages/api/internal/handlers/store.go:417
func (a *APIStore) GetTeamFromAdminToken(ctx context.Context, _ *gin.Context, teamID string) (*types.Team, *api.APIError) {
    teamUUID, err := uuid.Parse(teamID)
    if err != nil { /* 400 */ }

    team, err := a.authService.GetTeamByID(ctx, teamUUID)
    if err != nil {
        var forbiddenErr *sharedauth.TeamForbiddenError
        if errors.As(err, &forbiddenErr) { /* 403 */ }
        if dberrors.IsNotFoundError(err) { /* 404 */ }
        return nil, /* 500 */
    }
    if team == nil { /* 404 */ }
    return team, nil
}
```

> ⚠️ 注意 `GetTeamFromAdminToken` **不检查 `blocked` 状态**——只检查 `banned`。`blocked` 检查是 handler 内部主动做的(详见 [5.6](#56-post-adminteamsbyteamidapi-keys--创建-team-api-key))。

### 2.3 三类特权操作

| 类别 | 端点 | 作用 |
| --- | --- | --- |
| **集群运维** | `/nodes`, `/nodes/{id}`(GET) | 查看集群节点状态:CPU 架构、沙箱数、版本、健康度 |
| **集群运维** | `/nodes/{id}`(POST) | 覆盖节点状态:`ready` / `draining` / `unhealthy` / `standby` |
| **Team 资源清理** | `/admin/teams/{id}/sandboxes/kill` | 一键杀光某 team 所有运行中的沙箱(客服处理"卡死"工单常用) |
| **Team 资源清理** | `/admin/teams/{id}/builds/cancel` | 一键取消某 team 所有 pending/in_progress 的 template build |
| **Team 凭证管理** | `/admin/teams/{id}/api-keys`(POST/DELETE) | 为 team 创建/删除 API Key,internal service workflow 用 |

### 2.4 与普通认证的关系:它是"第五种"凭证

E2B 共有 6 个 OpenAPI security scheme,`admin` 占 2 个:

| Scheme | Header | 谁用 | 提供方 |
| --- | --- | --- | --- |
| `ApiKeyAuth` | `X-API-Key: e2b_...` | 终端用户 | `/api-keys` |
| `AccessTokenAuth` | `Authorization: Bearer sk_e2b_...` | 终端用户(CLI) | `/access-tokens` |
| `AuthProviderBearerAuth` | `Authorization: Bearer <JWT>` | OIDC 登录用户 | IdP |
| `AuthProviderTeamAuth` | `X-Team-Id: <uuid>` | OIDC 登录用户(指定 team) | IdP |
| **`AdminApiKeyAuth`** | `X-Admin-Token: <token>` | **内部服务** | `ADMIN_TOKEN` env |
| **`AdminTeamAuth`** | `X-Team-ID: <uuid>` | **内部服务**(指定 team) | 直接传 UUID |

`AdminApiKeyAuth + AdminTeamAuth` 这一对是"内部服务调 API"的统一通道,详见 [4.4](#44-跨端点复用为什么几乎所有端点都接受-admin-auth)。

---

## 三、整体架构

### 3.1 装配序列(api 服务)

`packages/api/main.go` 在启动时把 6 个 authenticator 全部塞进 `CreateAuthenticationFunc`:

```go
// packages/api/main.go:189-199
AuthenticationFunc := auth.CreateAuthenticationFunc(
    []auth.Authenticator{
        auth.NewApiKeyAuthenticator(apiStore.GetTeamFromAPIKey),
        auth.NewAccessTokenAuthenticator(apiStore.GetUserFromAccessToken),
        auth.NewAuthProviderBearerAuthenticator(apiStore.GetUserIDFromAuthProviderToken),
        auth.NewAuthProviderTeamAuthenticator(apiStore.GetTeamFromAuthProviderToken),
        auth.NewAdminApiKeyAuthenticator(config.AdminToken),               // ← admin 第 5 个
        auth.NewAdminTeamAuthenticator(apiStore.GetTeamFromAdminToken),    // ← admin 第 6 个
    },
    metricsMiddleware.SetProcessingStartTime,
)
```

随后注入到 oapi-codegen 的中间件里:

```go
// packages/api/main.go:203-218
r.Use(
    limits.RequestSizeLimiter(maxUploadLimit),
    middleware.OapiRequestValidatorWithOptions(swagger,
        &middleware.Options{
            // ...
            Options: openapi3filter.Options{
                AuthenticationFunc: AuthenticationFunc,
                // ...
            },
        }),
)
```

### 3.2 依赖图

每个 admin handler 都挂在 `APIStore` 上,依赖四个外部组件:

```
APIStore
├── orchestrator  (packages/api/internal/orchestrator.Orchestrator)
│   └── AdminNodes / AdminNodeDetail / GetNode / GetSandboxes / RemoveSandbox
├── templateManager (gRPC client → template-manager 服务)
│   └── DeleteBuild / SetStatus
├── authService   (packages/auth/pkg/auth.Service)
│   └── GetTeamByID / InvalidateTeamCache
└── authDB        (packages/db/pkg/auth.Client)
    └── Write.CreateTeamAPIKey / Write.DeleteTeamAPIKey (经 team.CreateAPIKey 封装)
```

### 3.3 数据流总览

```
HTTP 请求
   │
   ▼
Gin middleware (oapi-codegen)
   │
   ├── 校验 path/query/body/schema
   │
   ▼
AuthenticationFunc (按 scheme 顺序逐个试)
   │
   ├── AdminApiKeyAuthenticator    →  ConstantTimeCompare(token, ADMIN_TOKEN)
   ├── AdminTeamAuthenticator      →  GetTeamFromAdminToken(teamID)  → Team
   │
   ▼
Handler (admin*.go)
   │
   ├── 直接操作:orchestrator / templateManager / authDB
   │
   ▼
JSON 响应 / Status Code
```

---

## 四、认证深入

### 4.1 AdminApiKeyAuth 验证流程

```
请求进入
   │
   ▼
OpenAPI filter 解析 security: [{AdminApiKeyAuth: []}]
   │
   ▼
找到 NewAdminApiKeyAuthenticator 实例
   │
   ▼
commonAuthenticator.Authenticate
   │
   ├── 读取 header "X-Admin-Token"
   ├── (无 prefix 校验,直接拿整串)
   │
   ▼
adminValidationFunction(token)
   │
   ├── subtle.ConstantTimeCompare(token, ADMIN_TOKEN)
   │
   ├── 相等 → 返回 (struct{}{}, nil)   ← 注:不写任何信息到 ctx
   └── 不等 → 返回 401 "Invalid Access token."
```

**关键细节**:
- 不写 ctx。`setContextFunc` 是 nil,所以 handler 里 `GetTeam(c)` 拿不到 team——这正是为什么 `/nodes`、`/admin/teams/{teamID}/...` 这种端点要从 path param 拿 teamID。
- 不会触发 `telemetry.ReportEvent("api key validated")`,因为 admin 路径不需要那个埋点。

### 4.2 AdminTeamAuth 验证流程(用于非 admin 端点的代调通道)

```
请求进入(例如 GET /sandboxes,内部服务代调)
   │
   ▼
security: [{AdminApiKeyAuth: [], AdminTeamAuth: []}]   ← 注意是同一组的 AND
   │
   ▼
按声明顺序遍历 authenticator:
   1. AdminApiKeyAuthenticator   → ConstantTimeCompare
   2. AdminTeamAuthenticator     → GetTeamFromAdminToken(teamID)
   │
   ▼
GetTeamFromAdminToken:
   ├── uuid.Parse(teamID)                → 失败:400
   ├── authService.GetTeamByID(teamUUID)
   │     ├── TeamForbiddenError          → 403 (banned)
   │     ├── NotFoundError               → 404
   │     ├── 其他错误                    → 500
   │     └── team == nil                 → 404
   └── setTeamInfo(ginCtx, team)         ← 注入 ctx,后续 handler 可用
```

**关键细节**:
- `AdminTeamAuth` 单独使用没意义,因为它只是"读 team",没有任何身份校验。
- 实际生效的场景是 **非 admin 端点** 的 `[{AdminApiKeyAuth, AdminTeamAuth}]` AND 组合:OpenAPI filter 要求两个都通过。
- `/admin/teams/{teamID}/...` 这类特权端点**不使用** `AdminTeamAuth`——它们只用 `AdminApiKeyAuth`,teamID 来自 path param,handler 内部直接调 `authService.GetTeamByID` 拿 team。
- 这就是为什么 admin 端点的 path 一定带 `teamID`,而普通团队端点(`/sandboxes`、`/templates`)走 ctx 取 team。

### 4.3 字母序命名的奥秘

`spec/openapi.yml:33-34` 有一段关键注释:

```yaml
# AdminApiKeyAuth / AdminTeamAuth: alphabetical names ensure token
# validation runs before team context population.
AdminApiKeyAuth:
  type: apiKey
  in: header
  name: X-Admin-Token
AdminTeamAuth:
  type: apiKey
  in: header
  name: X-Team-ID
```

原因在于 `CreateAuthenticationFunc` 是**按 slice 顺序**遍历 authenticator 的(详见 `packages/auth/pkg/auth/middleware.go:CreateAuthenticationFunc`),而 OpenAPI filter 处理 `[{A, B}]` 这种 AND 组合时,会按 scheme 在 spec 里的字母序依次校验。

- 字母序:`A`dminApiKeyAuth < `A`dminTeamAuth(`K` < `T`)
- 所以 token 先校验、team 后校验

**为什么这很重要?**
- 如果反过来,先 `GetTeamFromAdminToken` 会做一次 DB 查询。
- 任何匿名攻击者随便发个请求就会打一次 DB。
- 字母序保证:token 不对就立刻 401,根本到不了 DB 层。

这是非常隐蔽但很重要的防御设计。

### 4.4 跨端点复用:为什么几乎所有端点都接受 admin auth

跑一遍 spec 会发现,几乎所有**非 admin 端点**的 `security` 段都包含 `{AdminApiKeyAuth, AdminTeamAuth}` 作为最后一个备选:

```yaml
# 示例:GET /sandboxes
security:
  - ApiKeyAuth: []
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
  - AdminApiKeyAuth: []      # ← 内部服务调用通道
    AdminTeamAuth: []
```

这是 **e2b 内部服务调 API 的标准通道**。`dashboard-api` 想代用户读沙箱列表,流程是:

1. 用户登录 dashboard-api(走 OIDC)
2. dashboard-api 拿到 `teamID`(从自己的 DB)
3. dashboard-api 用 `X-Admin-Token: <ADMIN_TOKEN>` + `X-Team-ID: <teamID>` 调 `api` 服务的 `/sandboxes`
4. api 服务校验通过,返回数据

**对比两种 admin auth 使用场景**:

| 场景 | security 形式 | teamID 来源 | 涉及的 authenticator |
| --- | --- | --- | --- |
| 调用 `/admin/teams/{teamID}/...` 特权端点 | `[AdminApiKeyAuth]` | path param | 只用 AdminApiKeyAuth |
| 调用 `/nodes` 等节点端点 | `[AdminApiKeyAuth]` | 不需要 team | 只用 AdminApiKeyAuth |
| 内部服务代调 `/sandboxes` 等用户端点 | `[..., {AdminApiKeyAuth, AdminTeamAuth}]` | `X-Team-ID` header | AdminApiKeyAuth + AdminTeamAuth AND 组合 |

**真正"admin 独占"的端点**(security 里只有 admin)只是少数:
- `/nodes`(GET)
- `/nodes/{nodeID}`(GET/POST)
- `/admin/teams/{teamID}/sandboxes/kill`(POST)
- `/admin/teams/{teamID}/builds/cancel`(POST)
- `/admin/teams/{teamID}/api-keys`(POST)
- `/admin/teams/{teamID}/api-keys/{apiKeyID}`(DELETE)

其余端点的 admin auth 都是"备选方案"。

---

## 五、7 个端点逐一解析

### 5.1 GET /nodes — 列出所有节点

**Handler**:`APIStore.GetNodes` (`packages/api/internal/handlers/admin.go:17`)

**流程**:

```go
func (a *APIStore) GetNodes(c *gin.Context, params api.GetNodesParams) {
    clusterID := clusters.WithClusterFallback(params.ClusterID)
    result, err := a.orchestrator.AdminNodes(clusterID)
    // ...
    c.JSON(http.StatusOK, result)
}
```

1. `WithClusterFallback` 把 nil clusterID 转成 `consts.LocalClusterID`(`packages/shared/pkg/clusters/cluster.go:9`),即默认查本地集群。
2. `Orchestrator.AdminNodes(clusterID)` 遍历内存中的 `o.nodes.Items()`,过滤 clusterID,装配成 `[]*api.Node`。
3. 按 `node.ID` 字典序排序,稳定输出。
4. 失败一律 500。

**返回字段**(参考 `Node` schema, `spec/openapi.yml:1622`):

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `id`, `serviceInstanceID`, `clusterID` | node 自身 | 节点身份 |
| `status`, `statusChangedAt` | `node.StatusInfo()` | `ready`/`draining`/`connecting`/`unhealthy`/`standby` |
| `machineInfo` | `node.MachineInfo()` | CPU 架构/family/model/modelName |
| `sandboxCount` | `node.Metrics()` | 当前运行的沙箱数 |
| `metrics` | `node.GetAPIMetric()` | CPU/内存使用率等 |
| `createSuccesses`, `createFails` | `node.PlacementMetrics()` | 沙箱创建成功/失败计数 |
| `sandboxStartingCount` | `node.PlacementMetrics()` | 正在启动的沙箱数 |
| `version`, `commit` | `node.Metadata()` | orchestrator 二进制的版本号和 commit hash |

### 5.2 GET /nodes/{nodeID} — 节点详情

**Handler**:`APIStore.GetNodesNodeID` (`admin.go:30`)

**与 5.1 的差异**:
- 路径参数多一个 `nodeID`。
- 调用 `AdminNodeDetail(clusterID, nodeID)`,内部用 `o.GetNode(clusterID, nodeID)` 精确查找。
- 找不到返回 **404**(用 `errors.Is(err, orchestrator.ErrNodeNotFound)` 判断),其他错误 500。
- 返回 `NodeDetail`,比 `Node` 多 `cachedBuilds` 字段(缓存了哪些 template rootfs)。

### 5.3 POST /nodes/{nodeID} — 节点状态覆盖

**Handler**:`APIStore.PostNodesNodeID` (`admin.go:49`)

**作用**:强制把节点状态改成 `ready` / `draining` / `unhealthy` / `standby`。典型用例:
- 客服怀疑某节点不健康 → 强制 `unhealthy`,等流量切走后重启。
- 节点要下线维护 → 强制 `draining`,等已有沙箱跑完。

**流程**:

```go
body, err := ginutils.ParseBody[api.PostNodesNodeIDJSONRequestBody](ctx, c)
clusterID := clusters.WithClusterFallback(body.ClusterID)
node := a.orchestrator.GetNode(clusterID, nodeId)
if node == nil { c.Status(http.StatusNotFound); return }

err = node.SendStatusChange(ctx, body.Status)
// 成功:204 No Content
```

**`SendStatusChange` 内部**(`packages/api/internal/orchestrator/nodemanager/status.go:75`):

```go
func (n *Node) SendStatusChange(ctx context.Context, s api.NodeStatus) error {
    nodeStatus, ok := ApiNodeToOrchestratorStateMapper[s]
    if !ok { return fmt.Errorf("unknown service info status: %s", s) }

    client, ctx := n.GetClient(ctx)
    _, err := client.Info.ServiceStatusOverride(ctx,
        &orchestratorinfo.ServiceStatusChangeRequest{ServiceStatus: nodeStatus})
    return err
}
```

- 通过 gRPC 调用 orchestrator 的 `ServiceStatusOverride` 接口。
- 注意:**API 进程不直接改本地状态**,而是通知远端 orchestrator 进程——orchestrator 收到后再更新自己的状态机并广播。
- API 进程的 node 缓存会在下一次心跳/状态广播时同步。

**状态映射**(从 OpenAPI enum 到 orchestrator gRPC enum):
- `ready` → 节点恢复,可接受新沙箱
- `draining` → 不接受新沙箱,等已有沙箱结束
- `connecting` → 节点正在连接(通常是刚启动)
- `unhealthy` → 健康检查失败,流量切走
- `standby` → 待机状态,可恢复为 ready

### 5.4 POST /admin/teams/{teamID}/sandboxes/kill — 批量杀团队沙箱

**Handler**:`APIStore.PostAdminTeamsTeamIDSandboxesKill` (`admin_kill_team_sandboxes.go:17`)

**用例**:
- 客服工单:"我的沙箱卡住了 / 我欠费了想立刻停掉"
- 安全审计:某 team 异常,需要立刻回收资源
- 自动化:计费系统检测到 team 超额,触发清理

**完整流程**(简化版伪代码):

```go
func PostAdminTeamsTeamIDSandboxesKill(c, teamID) {
    // 1) 先失效一次缓存,确保拿到最新的 team 状态
    a.authService.InvalidateTeamCache(ctx, teamID)

    // 2) 拉取该 team 所有 Running 沙箱
    sandboxes, err := a.orchestrator.GetSandboxes(ctx, teamID, []sandbox.State{sandbox.StateRunning})

    // 3) 并发杀,errgroup 限流 10
    wg := errgroup.Group{}
    wg.SetLimit(10)
    for _, sbx := range sandboxes {
        wg.Go(func() error {
            err := a.orchestrator.RemoveSandbox(ctx, sbx.TeamID, sbx.SandboxID, sandbox.RemoveOpts{
                Action: sandbox.StateActionKill,
                Reason: sandbox.KillReasonAdmin,    // ← 关键:kill_reason = "admin"
            })
            if err != nil { failedCount.Add(1) } else { killedCount.Add(1) }
            return nil  // ← 永不返回错误,errgroup 不会因为单个失败而 cancel 其他
        })
    }
    wg.Wait()

    // 4) 再失效一次缓存,确保后续请求重新检查 team 状态
    a.authService.InvalidateTeamCache(ctx, teamID)

    // 5) 返回计数
    c.JSON(http.StatusOK, api.AdminSandboxKillResult{
        KilledCount: int(killedCount.Load()),
        FailedCount:  int(failedCount.Load()),
    })
}
```

**关键设计点**:

| 点 | 说明 |
| --- | --- |
| **前后各 invalidate cache 一次** | 前一次保证拿到最新 team 状态(可能刚 banned);后一次保证下次请求重新检查 |
| **kill_reason = "admin"** | 在 `sandbox/sandboxtypes/states.go:55`,用于事后审计区分"用户主动 kill" vs "admin kill" vs "超时" |
| **errgroup.SetLimit(10)** | 防止大型 team(几百个沙箱)一次性打爆 orchestrator |
| **永不返回错误** | `wg.Go` 的闭包总是 `return nil`,失败只增加计数,不 cancel 整组 |
| **返回 200 即使部分失败** | 用 `failedCount` 字段表达,而不是 HTTP 状态码 |

**返回**:`AdminSandboxKillResult { killedCount, failedCount }`

### 5.5 POST /admin/teams/{teamID}/builds/cancel — 批量取消团队构建

**Handler**:`APIStore.PostAdminTeamsTeamIDBuildsCancel` (`admin_cancel_team_builds.go:19`)

**用例**:同 5.4,但针对 template build 而非 sandbox。

**完整流程**:

```go
// 1) 找出该 team 24h 内所有可取消的 build
builds, err := a.sqlcDB.GetCancellableTemplateBuildsByTeam(ctx, teamID)

// 2) 并发取消,errgroup 限流 10
for _, b := range builds {
    wg.Go(func() error {
        // 2a) 如果 build 正在某节点跑,先调 templateManager.DeleteBuild 停止它
        if b.ClusterNodeID != nil {
            err := a.templateManager.DeleteBuild(ctx, buildID, templateID, clusterID, *b.ClusterNodeID)
            if err != nil { failedCount.Add(1); return nil }
        }

        // 2b) 把 build 状态设为 failed,reason = "cancelled by admin"
        err := a.templateManager.SetStatus(ctx, buildID, dbtypes.BuildStatusGroupFailed,
            &templatemanagergrpc.TemplateBuildStatusReason{Message: "cancelled by admin"})
        if err != nil { failedCount.Add(1) } else { cancelledCount.Add(1) }
        return nil
    })
}
wg.Wait()

// 3) 返回计数
c.JSON(http.StatusOK, api.AdminBuildCancelResult{...})
```

**关键点**:
- 用 `sqlcDB.GetCancellableTemplateBuildsByTeam` 查 24h 内的 `active_template_builds`(详见 [7.3](#73-关键-sqlgetcancellabletemplatebuildsbyteam))。
- **两步取消**:先 `DeleteBuild`(在节点上停止实际工作),再 `SetStatus`(在 DB 里把状态改成 failed)。两步都成功才算取消,任一失败计入 `failedCount`。
- `BuildStatusGroupFailed` 是 build 的终态分组之一。
- 注意**没有 invalidate team cache**:与 kill sandboxes 不同,这里 team cache 不影响 build 状态。

### 5.6 POST /admin/teams/{teamID}/api-keys — 创建团队 API Key

**Handler**:`APIStore.PostAdminTeamsTeamIDApiKeys` (`admin_api_keys.go:19`)

**用例**:dashboard-api 给新注册的 team 自动创建第一把 API Key;客服代用户重置 API Key。

**完整流程**:

```go
body, err := ginutils.ParseBody[api.NewTeamAPIKey](ctx, c)

// 1) 取 team 信息(此处会触发 banned 检查)
teamInfo, err := a.authService.GetTeamByID(ctx, teamID)
if err != nil {
    if TeamForbiddenError → 403
    if NotFound → 404
    // ...
}
if teamInfo == nil → 404

// 2) 主动检查 blocked 状态
if err := sharedauth.CheckTeamBlocked(teamInfo); err != nil {
    return 403 (err.Error())  // ← "team is blocked: <reason>"
}

// 3) 调 team.CreateAPIKey 创建(注意:createdBy = nil)
apiKey, err := team.CreateAPIKey(ctx, a.authDB, teamID, nil, body.Name)

// 4) 返回(含明文 key,只在这一次响应里出现)
c.JSON(http.StatusCreated, api.CreatedTeamAPIKey{
    Id:   apiKey.ID,
    Name: apiKey.Name,
    Key:  apiKey.RawAPIKey,
    Mask: api.IdentifierMaskingDetails{
        Prefix:            apiKey.ApiKeyPrefix,
        ValueLength:       int(apiKey.ApiKeyLength),
        MaskedValuePrefix: apiKey.ApiKeyMaskPrefix,
        MaskedValueSuffix: apiKey.ApiKeyMaskSuffix,
    },
    CreatedBy: nil,
    CreatedAt: apiKey.CreatedAt,
    LastUsed:  apiKey.LastUsed,
})
```

**关键点**:

1. **`createdBy` 强制为 nil**:`team.CreateAPIKey(ctx, a.authDB, teamID, nil, body.Name)` 的第 4 个参数是 `createdBy`,admin 路径传 nil 表示"无创建者"。这与 `/api-keys`(用户自建)路径不同——后者会填 `userID`。
   - 测试 `TestPostAdminTeamsTeamIDApiKeysCreatesTeamKey` 显式断言 `body.CreatedBy == nil`(代码:`if body.CreatedBy != nil { t.Fatalf(...) }`),守护这个行为。
2. **明文 key 只返回一次**:`RawAPIKey` 是明文(`e2b_...`),数据库只存 hash。Mask 字段供前端展示(`e2b_****abcd`)。
3. **blocked 检查在 handler 里,不在中间件**:因为 `GetTeamFromAdminToken` 只检查 banned,blocked 检查需要 handler 显式调 `CheckTeamBlocked`。
   - 测试 `TestPostAdminTeamsTeamIDApiKeysRejectsBlockedTeam` / `RejectsBannedTeam` 都覆盖。

**底层 `team.CreateAPIKey`**(`packages/api/internal/team/apikeys.go:21`):

```go
func CreateAPIKey(ctx, authDB, teamID, createdBy *uuid.UUID, name string) (CreateAPIKeyResponse, error) {
    teamApiKey, err := keys.GenerateKey(keys.ApiKeyPrefix)        // 生成 e2b_... 前缀的随机 key
    apiKey, err := authDB.Write.CreateTeamAPIKey(ctx, authqueries.CreateTeamAPIKeyParams{
        TeamID:           teamID,
        CreatedBy:        createdBy,
        ApiKeyHash:       teamApiKey.HashedValue,                 // 存储 hash
        ApiKeyPrefix:     teamApiKey.Masked.Prefix,
        ApiKeyLength:     int32(teamApiKey.Masked.ValueLength),
        ApiKeyMaskPrefix: teamApiKey.Masked.MaskedValuePrefix,
        ApiKeyMaskSuffix: teamApiKey.Masked.MaskedValueSuffix,
        Name:             name,
    })
    return CreateAPIKeyResponse{
        TeamApiKey: &apiKey,
        RawAPIKey:  teamApiKey.PrefixedRawValue,                   // 一次性返回明文
    }, nil
}
```

### 5.7 DELETE /admin/teams/{teamID}/api-keys/{apiKeyID} — 删除团队 API Key

**Handler**:`APIStore.DeleteAdminTeamsTeamIDApiKeysApiKeyID` (`admin_api_keys.go:82`)

**用例**:客服代用户撤销泄漏的 API Key;自动化删除过期 key。

**流程**:

```go
apiKeyUUID, err := uuid.Parse(apiKeyID)   // ← 失败 400
deleted, err := team.DeleteAPIKey(ctx, a.authDB, teamID, apiKeyUUID)
if !deleted { 404 "API key not found" }
c.Status(http.StatusNoContent)
```

**底层 `team.DeleteAPIKey`**(`packages/api/internal/team/apikeys.go:51`):

```go
func DeleteAPIKey(ctx, authDB, teamID, apiKeyID) (bool, error) {
    ids, err := authDB.Write.DeleteTeamAPIKey(ctx, authqueries.DeleteTeamAPIKeyParams{
        ID:     apiKeyID,
        TeamID: teamID,    // ← 关键:WHERE id = $1 AND team_id = $2
    })
    return len(ids) > 0, nil
}
```

- DELETE SQL 同时按 `id` 和 `team_id` 过滤,**防止跨 team 删除**。
- 返回是否真的删了(`deleted` 布尔),用于决定 404 vs 204。

---

## 六、关键流程时序图

### 6.1 批量杀团队沙箱

```
内部服务           API (admin handler)         Orchestrator            Sandbox gRPC
   │                    │                          │                       │
   │ POST /admin/teams/{teamID}/sandboxes/kill    │                       │
   │   X-Admin-Token:  │                          │                       │
   ├───────────────────>│                          │                       │
   │ (teamID 在 path 里)│                          │                       │
   │                    │                          │                       │
   │                    ├── InvalidateTeamCache ───>│ (Redis DEL)          │
   │                    │                          │                       │
   │                    ├── GetSandboxes(teamID, [Running]) ──>│          │
   │                    │<───────────────────────── sandboxes[]            │
   │                    │                          │                       │
   │                    │ for each sbx (errgroup limit=10):                │
   │                    │   ├── RemoveSandbox ─────>│                      │
   │                    │   │                      ├── SandboxDelete ─────>│
   │                    │   │                      │<──────────────────────│
   │                    │   │<─────────────────────┘                       │
   │                    │                          │                       │
   │                    ├── InvalidateTeamCache ───>│ (Redis DEL)          │
   │                    │                          │                       │
   │                    ├── 200 OK                 │                       │
   │                    │   {killedCount, failedCount}                     │
   │<───────────────────┤                          │                       │
```

### 6.2 批量取消团队构建

```
内部服务           API (admin handler)         Template Manager         DB
   │                    │                          │                    │
   │ POST /admin/.../builds/cancel                │                    │
   ├───────────────────>│                          │                    │
   │                    │                          │                    │
   │                    ├── GetCancellableTemplateBuildsByTeam(teamID)──>│
   │                    │<──────────────────────── builds[] <────────────│
   │                    │                          │                    │
   │                    │ for each build (errgroup limit=10):           │
   │                    │   ├── if ClusterNodeID != nil:                │
   │                    │   │   ├── DeleteBuild ──>│                    │
   │                    │   │   │<─────────────────┘                    │
   │                    │   ├── SetStatus(Failed, "cancelled by admin")─>│
   │                    │   │                                  <─────────│
   │                    │                          │                    │
   │                    ├── 200 OK                                       │
   │                    │   {cancelledCount, failedCount}                │
   │<───────────────────┤                          │                    │
```

### 6.3 创建团队 API Key(admin 路径)

```
内部服务           API (admin handler)         authService           Auth DB
   │                    │                          │                    │
   │ POST /admin/.../api-keys                    │                    │
   │   { "name": "..." }│                        │                    │
   ├───────────────────>│                          │                    │
   │                    │                          │                    │
   │                    ├── GetTeamByID(teamID) ──>│                    │
   │                    │                          ├── (cache?) ───────>│
   │                    │                          │<───────────────────│
   │                    │<───────────────────────── team                │
   │                    │                          │                    │
   │                    ├── CheckTeamBlocked(team) (本地检查)           │
   │                    │   (banned → 403)                             │
   │                    │   (blocked → 403)                           │
   │                    │                          │                    │
   │                    ├── team.CreateAPIKey(teamID, createdBy=nil, name)│
   │                    │   ├── keys.GenerateKey() (本地)               │
   │                    │   ├── Write.CreateTeamAPIKey ──────────────────>│
   │                    │   │                                  <─────────│
   │                    │<── {RawAPIKey, TeamApiKey}                   │
   │                    │                          │                    │
   │                    ├── 201 Created            │                    │
   │                    │   {id, name, key, mask, createdBy: nil}     │
   │<───────────────────┤                          │                    │
```

---

## 七、数据模型

### 7.1 涉及的表

| 表 | 用途 | 写入 / 读取 |
| --- | --- | --- |
| `teams` | team 主表,banned 状态来源 | 读 |
| `team_api_keys` | team 的 API Key(hash + mask) | 写(POST/DELETE)、读(验证时) |
| `active_template_builds` | 24h 内活跃的 template build 视图 | 读(cancel 时) |
| `env_builds` | build 实体 | 读(build_id → template_id 映射) |
| `envs` | template 实体 | 读(cluster_id) |
| `nodes` | orchestrator 节点(部分集群)| 读 + gRPC 实时数据 |
| `sandboxes` | sandbox 实体 | 读 + 通过 orchestrator 实时数据 |

### 7.2 sqlc 查询

admin 模块直接用的查询:

| 查询 | 文件 | 用途 |
| --- | --- | --- |
| `GetCancellableTemplateBuildsByTeam` | `packages/db/queries/builds/get_inprogress_builds.sql:22` | cancel builds 时拉 team 的活跃构建 |
| `CreateTeamAPIKey` | `packages/db/pkg/auth/queries/`(自动生成) | 创建 API Key |
| `DeleteTeamAPIKey` | 同上 | 删除 API Key(WHERE id AND team_id) |

### 7.3 关键 SQL:`GetCancellableTemplateBuildsByTeam`

```sql
-- name: GetCancellableTemplateBuildsByTeam :many
-- Relies on active_template_builds table (migration 20260305130000).
SELECT atb.build_id, atb.template_id, e.cluster_id, b.cluster_node_id
FROM public.active_template_builds atb
JOIN public.env_builds b ON b.id = atb.build_id
JOIN public.envs e ON e.id = atb.template_id
WHERE atb.team_id = $1
  AND atb.created_at > NOW() - INTERVAL '1 day'
ORDER BY atb.build_id;
```

**关键点**:
- 依赖 `active_template_builds` 视图表(migration `20260305130000`)。
- 时间窗口 **24 小时**——超过 24h 的 build 即使还在跑也不在结果里(实际上这种"跑超 24h"的 build 几乎肯定是僵尸,会被其他清理流程处理)。
- 返回 `cluster_node_id` 是关键:它告诉 admin 这个 build 是否真的在某节点上跑(只有 pending 的 build 没有 node)。
- JOIN `envs`(template 表)是为了拿 `cluster_id`——做 gRPC 调用需要知道目标集群。

---

## 八、并发与限流

### 8.1 errgroup SetLimit(10)

两个批量操作(kill sandboxes / cancel builds)都用同一个模式:

```go
wg := errgroup.Group{}
wg.SetLimit(10)

for _, item := range items {
    wg.Go(func() error {
        // 单个操作
        return nil   // 永不返回错误
    })
}
wg.Wait()
```

**为什么是 10?**
- 太小(1):大型 team(几百个沙箱)清理时间过长,客服等待时间长。
- 太大(无限制):一次性给 orchestrator / template-manager 发几百个 gRPC,可能打爆它们的 worker pool。
- **10 是经验值**:既能在合理时间内完成 100+ 资源的清理,又不会压垮下游。

### 8.2 失败容忍:单个失败不阻塞整体

`wg.Go` 的闭包**总是返回 nil**。这有两层含义:

1. errgroup 不会因为某个失败而 cancel 整组(否则一个失败就停,大型 team 永远清不干净)。
2. 失败的项被记录在 `failedCount` 里,返回给调用方决定是否重试。

这是一种**最佳努力(best-effort)清理**语义,符合运维场景:杀掉 100 个里 97 个就是 97% 成功,剩下的 3 个可以单独排查或下次再杀。

### 8.3 原子计数器:killedCount / failedCount

```go
killedCount := atomic.Int64{}
failedCount := atomic.Int64{}
```

- 用 `atomic` 而非 mutex,因为只增不减、读少写多,原子操作更快。
- 读时用 `.Load()`,返回时转 `int` 放进 JSON。

---

## 九、与 Orchestrator 的交互

### 9.1 Node 数据来源:本地缓存 + gRPC 心跳

`Orchestrator.AdminNodes` 直接遍历 `o.nodes.Items()`——这是 API 进程内存里维护的 Node 列表。

**这些 Node 数据怎么来的?**
- 每个 orchestrator 实例启动后会向 API 注册(gRPC `RegisterNode`)。
- 之后定期心跳上报:`StatusInfo`、`Metrics`、`PlacementMetrics`、`MachineInfo`。
- API 进程的 `nodemanager.Node` 缓存这些数据。

所以 `GET /nodes` 不会真的去调远端 orchestrator,而是返回 API 进程的最新缓存。**这意味着**:
- 如果 API 进程刚重启,缓存可能是空的(直到第一次心跳)。
- 数据可能有几秒延迟(取决于心跳间隔)。

### 9.2 RemoveSandbox 调用链

`PostAdminTeamsTeamIDSandboxesKill` 调 `Orchestrator.RemoveSandbox`,后者是一个比较复杂的链路:

```
RemoveSandbox(teamID, sandboxID, opts)
   │
   ▼
sandboxStore.StartRemoving
   │  ← 状态机:TransitionExpires/TransitionKill
   │  ← 如果沙箱已经在 killing,这里会返回 alreadyDone=true
   ▼
removeSandboxFromNode
   │
   ├── getOrConnectNode(clusterID, nodeID)  ← 拿到 node 的 gRPC client
   │
   ├── routingCatalog.DeleteSandbox         ← 从路由表删(Nomad 节点才做)
   │
   └── killSandboxOnNode                    ← gRPC SandboxDelete
       │
       └── client.Sandbox.Delete(SandboxDeleteRequest{
               SandboxId:  ...,
               KillReason: "admin",   ← 透传到 orchestrator,记到审计日志
           })
```

注意 `killSandboxOnNode` 即使远端返回 NotFound 也不当失败(说明沙箱已经没了):

```go
st, ok := status.FromError(err)
if ok && st.Code() == codes.NotFound {
    logger.L().Info(ctx, "Sandbox not found during kill", ...)
}
```

### 9.3 gRPC ServiceStatusOverride

`POST /nodes/{nodeID}` 调 `node.SendStatusChange`,后者发 gRPC 给 orchestrator:

```protobuf
// 简化示意
service NodeInfo {
    rpc ServiceStatusOverride(ServiceStatusChangeRequest) returns (ServiceStatusChangeResponse);
}

message ServiceStatusChangeRequest {
    ServiceStatus service_status = 1;  // READY / DRAINING / UNHEALTHY / STANDBY
}
```

**为什么 API 不直接改本地缓存?**
- 因为状态机的权威来源是 orchestrator 进程本身。
- 如果 API 强改缓存,下次心跳又会被 orchestrator 覆盖。
- 通过 gRPC 通知,让 orchestrator 自己更新状态机,然后广播给所有 API 实例。

---

## 十、配置与环境变量

| 变量 | 文件 | 说明 |
| --- | --- | --- |
| `ADMIN_TOKEN` | `packages/api/internal/cfg/model.go:30` | admin token 全局共享,所有 admin 请求都用它 |

> ⚠️ `ADMIN_TOKEN` 是**唯一**的 admin 配置项。其他参数(限流值、清理窗口等)都是代码硬编码。

**部署侧**:
- 生产环境由 GCP Secrets Manager 注入容器环境变量。
- 轮换流程:生成新 token → 更新 Secret → 滚动重启 api / dashboard-api → 通知所有依赖 admin token 的内部服务同步更新。

---

## 十一、Feature Flags

admin 模块**当前不挂任何 LaunchDarkly feature flag**。原因:
- admin 操作都是低频高权限的运维动作,不需要灰度。
- 增加	flag 反而会让审计变得困难(攻击者若开了某个 flag 可能绕过限制)。

---

## 十二、关键代码文件索引

### 12.1 handlers(`packages/api/internal/handlers/`)

| 文件 | 主要函数 |
| --- | --- |
| `admin.go` | `GetNodes`, `GetNodesNodeID`, `PostNodesNodeID` |
| `admin_api_keys.go` | `PostAdminTeamsTeamIDApiKeys`, `DeleteAdminTeamsTeamIDApiKeysApiKeyID` |
| `admin_cancel_team_builds.go` | `PostAdminTeamsTeamIDBuildsCancel` |
| `admin_kill_team_sandboxes.go` | `PostAdminTeamsTeamIDSandboxesKill` |
| `admin_api_keys_test.go` | 7 个测试覆盖创建/删除的 happy path 与各种拒绝场景 |
| `store.go:417` | `GetTeamFromAdminToken` |

### 12.2 orchestrator(`packages/api/internal/orchestrator/`)

| 文件 | 主要函数 |
| --- | --- |
| `admin.go` | `AdminNodes`, `AdminNodeDetail` |
| `delete_instance.go` | `RemoveSandbox`, `removeSandboxFromNode`, `killSandboxOnNode` |
| `client.go:121` | `GetNode` |
| `list_instances.go:12` | `GetSandboxes` |
| `orchestrator.go:38` | `ErrNodeNotFound` |
| `nodemanager/status.go:75` | `Node.SendStatusChange` |

### 12.3 team(`packages/api/internal/team/`)

| 文件 | 主要函数 |
| --- | --- |
| `apikeys.go` | `CreateAPIKey`, `DeleteAPIKey` |

### 12.4 auth(`packages/auth/pkg/auth/`)

| 文件 | 主要函数 |
| --- | --- |
| `middleware.go:118` | `adminValidationFunction` |
| `middleware.go:189` | `NewAdminApiKeyAuthenticator` |
| `middleware.go:205` | `NewAdminTeamAuthenticator` |
| `consts.go:8` | `HeaderAdminToken = "X-Admin-Token"` |
| `service.go:261` | `authService.InvalidateTeamCache` |

### 12.5 db(`packages/db/`)

| 文件 | 内容 |
| --- | --- |
| `queries/builds/get_inprogress_builds.sql:22` | `GetCancellableTemplateBuildsByTeam` SQL |
| `queries/get_inprogress_builds.sql.go:14` | sqlc 生成的 Go 代码 |
| `pkg/auth/queries/`(自动生成) | `CreateTeamAPIKey`, `DeleteTeamAPIKey` |

### 12.6 OpenAPI spec

| 位置 | 内容 |
| --- | --- |
| `spec/openapi.yml:33-42` | `AdminApiKeyAuth`, `AdminTeamAuth` 定义 |
| `spec/openapi.yml:2006-2026` | `/teams`(非 admin,但接受 admin auth) |
| `spec/openapi.yml:2028+` | `/teams/{teamID}/metrics`(同上) |
| `spec/openapi.yml:3366-3568` | 7 个 admin tag 端点 |
| `spec/openapi.yml:1486-1503` | `NodeStatus` enum |
| `spec/openapi.yml:1505-1514` | `NodeStatusChange` schema |
| `spec/openapi.yml:1622+` | `Node` schema |
| `spec/openapi.yml:1680+` | `NodeDetail` schema |
| `spec/openapi.yml:871-893` | `AdminSandboxKillResult`, `AdminBuildCancelResult` schema |

---

## 十三、设计要点与权衡

### 13.1 为什么 admin token 是全局静态、不落库?

- **简单**:启动即用,不需要 DB 查询,不需要缓存失效逻辑。
- **审计清晰**:日志里看到 `X-Admin-Token` 验证通过,就一定是某个持有该 token 的内部服务发的,不存在"哪个 admin 用户"的歧义。
- **轮换成本可接受**:全局一个 token,轮换时只需重启几个服务。

**代价**:无法做到"撤销某个 admin 服务的凭证"——任何拿到 token 的服务都有完整权限。生产环境通过 Secrets Manager 的访问控制来约束哪些服务能拿到 token。

### 13.2 为什么用 `subtle.ConstantTimeCompare`?

防止**时序攻击**。如果用 `==` 比较,攻击者可以逐字符尝试,通过响应时间差异推断正确字符。`ConstantTimeCompare` 无论结果是否相等,耗时相同。

由于 admin token 是高权限凭证,这里必须用常量时间比较。普通 API Key 走的是 hash 比较(`bcrypt` 之类),本身就有常量时间性质,所以那边不需要额外处理。

### 13.3 为什么 `AdminApiKeyAuth` 命名要按字母序?

详见 [4.3](#43-字母序命名的奥秘)。简而言之:OpenAPI filter 处理 AND 组合时按 spec 里的字段顺序,而 spec 解析时按字母序。`AdminApiKeyAuth` < `AdminTeamAuth` 保证 token 校验(快、纯内存)在 team 查询(慢、要访问 DB / Redis)之前。

### 13.4 为什么几乎所有端点都接受 admin auth?

`/sandboxes`、`/templates`、`/volumes` 这些"用户端点"的 security 段里都有 `{AdminApiKeyAuth, AdminTeamAuth}` 作为最后一个备选。原因:

- **dashboard-api 等内部服务需要代用户调 API**。它们没有用户凭证,只有 admin token。
- **如果不开这个口子,内部服务要么硬编码一个用户凭证(更不安全),要么走完全不同的代码路径(维护成本高)**。
- 复用同一套 handler 保证业务逻辑一致,不会出现"用户路径做了 X 检查、admin 路径漏了 X 检查"。

**代价**:攻击面变大——一旦 admin token 泄漏,所有端点都暴露。生产环境通过以下手段缓解:
- token 仅通过 Secrets Manager 分发给受控服务。
- 网络层隔离:admin 端点只在内部网络可达(具体由 Nomad / 网络策略保证)。
- 审计日志:所有 admin 请求都被 telemetry 记录。

### 13.5 为什么 `PostAdminTeamsTeamIDApiKeys` 把 `createdBy` 设为 nil?

- admin 路径没有"用户"概念,无法填 user ID。
- 如果硬填某个固定 user ID(比如"系统账户"),会污染 `created_by` 字段的语义。
- nil 是最诚实的表达:"这把 key 是 admin 操作创建的,没有具体创建者"。

测试 `TestPostAdminTeamsTeamIDApiKeysCreatesTeamKey` 显式断言 `CreatedBy == nil`,防止后续误改。

### 13.6 为什么 kill sandboxes 前后各 invalidate cache 一次?

```go
a.authService.InvalidateTeamCache(ctx, teamID)   // ← 前
sandboxes := a.orchestrator.GetSandboxes(...)
// ... kill ...
a.authService.InvalidateTeamCache(ctx, teamID)   // ← 后
```

**前一次**:确保拿到最新的 team 状态。如果 team 刚被 banned,缓存里可能还是旧状态,影响后续判断(虽然 kill 本身不检查 banned,但日志和埋点会用最新状态)。

**后一次**:为后续该 team 的请求做准备。kill 完后 team 的资源占用变了,缓存的统计信息需要失效,让下一次该 team 的 API 请求重新从 DB 读最新状态。

### 13.7 为什么 errgroup SetLimit(10),失败不返回错误?

详见 [8.1](#81-errgroup-setlimit10) 和 [8.2](#82-失败容忍单个失败不阻塞整体)。核心:**最佳努力清理**,大型 team 不被单个失败卡住。

### 13.8 为什么 `GetTeamFromAdminToken` 不检查 blocked?

- `banned` 是硬性拒绝(team 已被禁用),由 `GetTeamByID` 内部抛 `TeamForbiddenError`。
- `blocked` 是软性限制(team 暂时受限,可能因为超额、合规审查等),需要 handler 根据业务决定是否拒绝。

`GetTeamFromAdminToken` 是 `AdminTeamAuth` 的验证函数,**只用于非 admin 端点的内部服务代调通道**(例如 dashboard-api 用 admin token 代调 `/sandboxes`)。它本身**不用于** `/admin/teams/{teamID}/...` 系列端点。

为什么不在这里检查 blocked?
- 不同端点对 blocked 的容忍度不同:
  - **kill sandboxes** 即使 blocked 也要执行(就是要清理资源)。
  - **create API key** 不能给 blocked team 加新凭证。
  - **list / get 类操作**通常允许(读不改变状态)。
- 在通用入口强加 blocked 检查会强迫所有调用方都先 unblock,过度限制。
- 所以策略是:`GetTeamFromAdminToken` 只挡硬性 `banned`,blocked 由具体 handler 显式调 `CheckTeamBlocked` 决定。

`/admin/teams/{teamID}/...` 端点的 handler 也不通过 `GetTeamFromAdminToken`——它们从 path param 拿到 teamID 后直接调 `authService.GetTeamByID`。这两个路径共享底层 `GetTeamByID` 的 banned 行为。

### 13.9 为什么 `DeleteAPIKey` 同时按 `id` 和 `team_id` 过滤?

```go
authDB.Write.DeleteTeamAPIKey(ctx, authqueries.DeleteTeamAPIKeyParams{
    ID:     apiKeyID,
    TeamID: teamID,    // ← 关键
})
```

**防止跨 team 删除**。即使攻击者构造请求 `/admin/teams/{teamA}/api-keys/{teamB的apiKeyID}`,SQL 也不会匹配(`team_id != teamA`)。

虽然 admin token 已经验证了身份,但**纵深防御**原则:多一层 SQL 级别的过滤不会出错。

### 13.10 为什么 `/nodes` 不属于 `/admin/`?

- 历史原因:`/nodes` 早期就是 admin-only,但路径没放在 `/admin/` 下。
- 语义上 `/nodes` 是"集群视图",`/admin/teams/...` 是"team 运维"。前者不涉及具体 team。
- 改路径会破坏向后兼容(所有依赖 `/nodes` 的内部工具都要改)。

两者都 `tags: [admin]`,只是路径前缀不同。

---

## 十四、常见问题与排查

### Q1: 内部服务调 API 拿到 401 "Invalid Access token."

**可能原因**:
1. `X-Admin-Token` 没传或值不对。检查内部服务的环境变量是否与 api 服务的 `ADMIN_TOKEN` 一致。
2. Header 名拼错(必须正好是 `X-Admin-Token`,大小写敏感虽然 HTTP header 名本身不敏感,但 oapi-codegen 的某些行为可能受影响)。
3. token 在 Secret 里带了换行/空格——用 `echo -n` 生成。

**排查**:
```bash
# 在 api 服务的 pod 里看 env
kubectl exec -it <api-pod> -- env | grep ADMIN_TOKEN

# 在内部服务里看 env
kubectl exec -it <internal-svc> -- env | grep ADMIN_TOKEN
# 两者必须完全一致
```

### Q2: admin kill sandboxes 返回 `failedCount: N`,N 个沙箱没杀掉

**可能原因**:
1. 节点已经挂了,gRPC 调不通——`RemoveSandbox` 会返回 error,被记为 failed。
2. 沙箱已经过期(同时有 cleanup goroutine 在跑),状态竞争——这种实际上沙箱已经没了,但 admin 路径不知道。
3. orchestrator 暂时性故障(高负载、GC 等)。

**排查**:
1. 在 Grafana 找 `kill_reason="admin"` 的日志,看具体哪个 sandbox 失败、错误是什么。
2. 用 `GET /nodes/{nodeID}` 看节点状态——如果是 `unhealthy` / `connecting`,gRPC 调用必然失败。
3. 重试:大多数 transient 故障重试就能成功。

### Q3: admin cancel builds 返回 `failedCount: N`

**原因类似 Q2**。注意 cancel 的两步:
- `DeleteBuild` 失败(节点上调不通 / build 进程已退出)
- `SetStatus` 失败(DB 短暂不可用 / 状态机不允许从当前状态转 Failed)

**排查**:看 template-manager 日志,搜 buildID。

### Q4: POST /admin/teams/{id}/api-keys 拿到 403 "team is blocked: <reason>"

**说明**:`CheckTeamBlocked` 检查到 team 处于 blocked 状态。这通常是业务限制(如计费违约、安全审查)。

**排查**:
- 查 DB `teams.is_blocked` 字段。
- 看是哪个机制把它 blocked(计费系统?客服手动?)。

**绕过**:不能绕过。如果想强制创建,先 unblock。

### Q5: POST /admin/teams/{id}/api-keys 拿到 403 "team is banned"

**说明**:team 已被永久禁用(`teams.is_banned = true`)。这通常是严重违规才会触发。

**排查**:与 Q4 类似,但 banned 几乎不会自动解除。

### Q6: GET /nodes 返回空数组,但实际集群有节点

**可能原因**:
1. `clusterID` 不对。请求里没传 `?clusterID=...` 时,会 fallback 到 `consts.LocalClusterID`。如果你的集群 ID 不是 local,需要显式传。
2. API 进程刚重启,还没收到节点心跳。等 30s 再试。
3. 节点状态是 `connecting`(尚未注册完成),但仍会出现在 `o.nodes.Items()` 里——这点要确认。

**排查**:
```bash
# 在 api pod 里看节点注册日志
kubectl logs <api-pod> | grep "node registered\|node deregistered"
```

### Q7: POST /nodes/{nodeID} 返回 500 "Failed to send status change"

**可能原因**:
1. gRPC 调不通——节点挂了或网络问题。
2. 节点存在但 `Info` service 没起来(orchestrator 进程异常)。

**排查**:
- 用 `GET /nodes/{nodeID}` 看节点 status:如果是 `connecting` / `unhealthy`,先解决节点问题。
- 直接到节点机器上 `grpcurl` 测试 Info service。

### Q8: 不同 internal 服务用不同 token 会有什么问题?

**说明**:这是允许的——只要每个服务自己的 token 与 api 服务的 `ADMIN_TOKEN` 一致就行。但如果两个服务用不同 token,只有与 api 一致的能成功,其他都会 401。

**最佳实践**:整个集群共用一个 `ADMIN_TOKEN`,通过 Secret 分发。

### Q9: 如何审计 admin 操作?

admin 操作没有专门的审计表,但所有 handler 都调 `telemetry.ReportCriticalError` / `logger.L().Info` 并带 `teamID`、`sandboxID` 等字段。在 Grafana Loki 里搜:

```logql
{service="api"} |= "Admin" | json
```

或按 span 在 Tempo 里找 `cancel admin-team-builds` / `admin-kill-team-sandboxes` 等 trace。

### Q10: 为什么 `/teams/{teamID}/metrics` 也接受 admin auth 但 `tags: [auth]` 而不是 `[admin]`?

- 它是**用户端点**(普通 team 凭证也能调),只是额外允许 admin 兜底。
- `tags` 反映**功能分类**(metrics 属于 auth/team 管理),不是鉴权方式。
- 所以 `tags: [auth]` + `security: [..., {AdminApiKeyAuth, AdminTeamAuth}]` 是合理的。

---

## 附录 A:端点速查表

### A.1 7 个 admin 端点

| 端点 | 方法 | 鉴权 | 功能 | Handler |
| --- | --- | --- | --- | --- |
| `/nodes` | GET | AdminApiKeyAuth | 列出集群节点 | `GetNodes` |
| `/nodes/{nodeID}` | GET | AdminApiKeyAuth | 节点详情 | `GetNodesNodeID` |
| `/nodes/{nodeID}` | POST | AdminApiKeyAuth | 覆盖节点状态 | `PostNodesNodeID` |
| `/admin/teams/{teamID}/sandboxes/kill` | POST | AdminApiKeyAuth(+ path param teamID) | 批量杀沙箱 | `PostAdminTeamsTeamIDSandboxesKill` |
| `/admin/teams/{teamID}/builds/cancel` | POST | AdminApiKeyAuth(+ path param teamID) | 批量取消构建 | `PostAdminTeamsTeamIDBuildsCancel` |
| `/admin/teams/{teamID}/api-keys` | POST | AdminApiKeyAuth(+ path param teamID) | 创建团队 API Key | `PostAdminTeamsTeamIDApiKeys` |
| `/admin/teams/{teamID}/api-keys/{apiKeyID}` | DELETE | AdminApiKeyAuth(+ path param teamID) | 删除团队 API Key | `DeleteAdminTeamsTeamIDApiKeysApiKeyID` |

### A.2 NodeStatus 枚举

| 值 | 含义 |
| --- | --- |
| `ready` | 节点健康,可接受新沙箱 |
| `draining` | 准备下线,不再接受新沙箱,等已有沙箱结束 |
| `connecting` | 节点启动中,正在建立连接 |
| `unhealthy` | 健康检查失败,流量切走 |
| `standby` | 待机,不主动服务,可恢复为 ready |

### A.3 KillReason 枚举(完整)

| 值 | 来源 | 含义 |
| --- | --- | --- |
| `unknown` | `KillReasonUnknown` | 默认/未指定 |
| `request` | `KillReasonRequest` | 用户主动请求 kill |
| `timeout` | `KillReasonTimeout` | 沙箱超时 |
| `admin` | `KillReasonAdmin` | **admin 路径触发**(本文档场景) |
| `orphaned` | `KillReasonOrphaned` | 父进程消失,自动回收 |
| `base_template_missing` | `KillReasonBaseTemplateMissing` | pause 时发现 base template 已删,降级为 kill |

---

## 附录 B:错误码与 HTTP 状态映射

| 场景 | HTTP | 说明 |
| --- | --- | --- |
| Admin token 不对 | 401 | "Invalid Access token." |
| Team UUID 格式错 | 400 | "Invalid team ID" |
| Team 不存在 | 404 | "Team not found" |
| Team banned | 403 | "team is banned" |
| Team blocked(create API key 时) | 403 | "team is blocked: <reason>" |
| Node 不存在 | 404 | (空 body) |
| API Key 不存在(delete 时) | 404 | "API key not found" |
| Body 解析失败 | 400 | "Error when parsing request: ..." |
| gRPC 调用失败 | 500 | "Error when ..." |
| DB 错误 | 500 | "Error when ..." |
| 成功(GET) | 200 | JSON 响应 |
| 成功(POST create) | 201 | JSON 响应(含创建的资源) |
| 成功(DELETE) | 204 | 无 body |
| 成功(POST status change) | 204 | 无 body |
| 成功(POST batch) | 200 | JSON 响应(含 count) |

---

## 附录 C:术语表

| 术语 | 含义 |
| --- | --- |
| **Admin Token** | 全局静态密钥,通过 `ADMIN_TOKEN` env 注入,所有 admin 请求共享 |
| **AdminApiKeyAuth** | OpenAPI security scheme,读 `X-Admin-Token` header |
| **AdminTeamAuth** | OpenAPI security scheme,读 `X-Team-ID` header,验证 team 存在性 |
| **特权端点** | 只接受 admin auth 的端点(`/nodes/**`、`/admin/teams/**`) |
| **内部服务调用通道** | admin auth 作为用户端点的备选鉴权方式,供 dashboard-api 等内部服务使用 |
| **banned** | team 被永久禁用(`teams.is_banned`),`GetTeamByID` 抛 `TeamForbiddenError` |
| **blocked** | team 暂时受限(`teams.is_blocked`),handler 用 `CheckTeamBlocked` 检查 |
| **active_template_builds** | DB 视图表,24h 内活跃的 template build |
| **draining** | 节点状态:准备下线,等已有沙箱结束 |
| **kill_reason="admin"** | 审计标记:这个沙箱是被 admin 路径杀的,而非用户主动 / 超时 / orphaned |
| **errgroup.SetLimit(10)** | 批量操作并发上限,经验值,平衡速度与下游压力 |
| **ConstantTimeCompare** | 常量时间比较,防时序攻击,admin token 校验专用 |
| **GetTeamFromAdminToken** | `AdminTeamAuth` 的验证函数,位于 `handlers/store.go:417` |
| **ServiceStatusOverride** | gRPC 接口,API 用它通知 orchestrator 覆盖节点状态 |
| **createdBy=nil** | admin 创建的 API Key 无具体用户,体现在 DB `team_api_keys.created_by` 为 NULL |
