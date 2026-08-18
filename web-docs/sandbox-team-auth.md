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
│    packages/api/main.go:189-199                            │
│    按 OpenAPI security scheme 分发到 6 个认证器之一        │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 2. commonAuthenticator[T]                                  │
│    packages/auth/pkg/auth/middleware.go:67                 │
│    提取 header → validationFunc 校验 → setContextFunc 注入 │
└───────────────────────────────────────────────────────────┘
        │  校验成功
        ▼
┌───────────────────────────────────────────────────────────┐
│ 3. gin context 注入                                        │
│    packages/auth/pkg/auth/gin.go                           │
│    key "team" → *types.Team   /   key "user_id" → uuid     │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ 4. 认证后中间件链(按序)                                   │
│    main.go:221-231                                         │
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

`packages/api/main.go:189-199` 用 `auth.CreateAuthenticationFunc` 装配 6 个认证器:

```go
AuthenticationFunc := auth.CreateAuthenticationFunc(
    []auth.Authenticator{
        auth.NewApiKeyAuthenticator(apiStore.GetTeamFromAPIKey),          // main.go:191
        auth.NewAccessTokenAuthenticator(apiStore.GetUserFromAccessToken), // main.go:192
        auth.NewAuthProviderBearerAuthenticator(apiStore.GetUserIDFromAuthProviderToken), // main.go:193
        auth.NewAuthProviderTeamAuthenticator(apiStore.GetTeamFromAuthProviderToken),     // main.go:194
        auth.NewAdminApiKeyAuthenticator(config.AdminToken),              // main.go:195
        auth.NewAdminTeamAuthenticator(apiStore.GetTeamFromAdminToken),   // main.go:196
    },
    metricsMiddleware.SetProcessingStartTime,
)
```

`CreateAuthenticationFunc`(`packages/auth/pkg/auth/middleware.go:225-248`)按 `input.SecuritySchemeName` 匹配认证器——每个请求只走一个认证器,哪个 scheme 命中由 OpenAPI spec 中路由的 `security` 声明决定。

### 2.1 六种认证器对照表

| 认证器 | Scheme | Header | 校验函数 | context 写入 |
|---|---|---|---|---|
| `NewApiKeyAuthenticator` | `ApiKeyAuth` | `X-API-Key`(前缀 `e2b_`) | `GetTeamFromAPIKey` → `ValidateAPIKey` | `"team"` |
| `NewAccessTokenAuthenticator` | `AccessTokenAuth` | `Authorization: Bearer sk_e2b_` | `GetUserFromAccessToken` | `"user_id"` |
| `NewAuthProviderBearerAuthenticator` | `AuthProviderBearerAuth` | `Authorization: Bearer`(OIDC JWT) | `GetUserIDFromAuthProviderToken` | `"user_id"` |
| `NewAuthProviderTeamAuthenticator` | `AuthProviderTeamAuth` | `X-Team-Id` | `GetTeamFromAuthProviderToken` | `"team"` |
| `NewAdminApiKeyAuthenticator` | `AdminApiKeyAuth` | `X-Admin-Token` | 常量时间比对 | 无 |
| `NewAdminTeamAuthenticator` | `AdminTeamAuth` | `X-Team-ID` | `GetTeamFromAdminToken` | `"team"` |

**关键区分:把 team 写入 context 的有三条路**(API Key、AuthProviderTeam、AdminTeam),而 **AccessToken 与 AuthProviderBearer 只写 userID**。后两条路的 handler 需要 team 时,必须走「userID → 查用户所有 team → 选默认/匹配 teamID」的 deprecated 解析路径(见第十一章)。

### 2.2 认证器的泛型骨架

`commonAuthenticator[T]`(`middleware.go:40-46`)把三类 team 型认证器统一为同一模板:

```go
type commonAuthenticator[T any] struct {
    schemeName     string
    header         headerKey
    validationFunc func(ctx context.Context, ginCtx *gin.Context, token string) (T, *APIError)
    setContextFunc func(ginCtx *gin.Context, value T)
    errorMessage   string
}
```

`Authenticate`(`middleware.go:67-111`)的三步流水线:

1. **提取** `getHeaderKeysFromRequest`(:49)— header 缺失 → `ErrNoAuthHeader`;前缀不符 → `ErrInvalidAuthHeader`。失败时先 `ginCtx.Status(401)` stamp 状态码,保证所有 scheme 都失败时最终返回 401 而不是 400。
2. **校验** `validationFunc` — 即 `authService.Validate*`(下一节)。失败时若底层错误是 `*TeamForbiddenError`(banned team),原样上抛;否则包装成带 `errorMessage` 的普通错误。
3. **注入** `setContextFunc`(:106-108)— team 型认证器全部指向 `setTeamInfo`。

### 2.3 team 型认证器的验证路径

**路径 A:API Key → 单步直达 team**(`service.go:93` `ValidateAPIKey`)

```
X-API-Key: e2b_xxx
    → keys.VerifyKey 校验格式
    → hashed key 查 teamCache(Redis,TTL=5min,cache.go:14)→ miss 时查 authStore
    → authStore.GetTeamByHashedAPIKey(auth_store.go:29)
        · 走 Read replica 查 team + tier + limits(auth_store.go:33)
        · CheckTeamBanned 在此层强制(auth_store.go:38)→ banned 直接失败
        · 异步 goroutine 更新 last_time_used(auth_store.go:42-49,不阻塞请求)
    → 返回 *types.Team → setTeamInfo
```

**路径 B:OIDC 两段式:先用户、后 team**(`service.go:213` `ValidateAuthProviderTeam`)

```
Authorization: Bearer <OIDC JWT>   → AuthProviderBearerAuth → "user_id" 写入 context
X-Team-Id: <team-uuid>             → AuthProviderTeamAuth   → 校验 team
    ValidateAuthProviderTeam:
        1. 从 gin context 读 userID(service.go:214,依赖前一个 scheme 已成功)
        2. 按 (userID, teamID) 查 teamCache → GetTeamByIDAndUserID(auth_store.go:74)
           SQL 按 team_id + user_id(成员关系)过滤 → 非成员直接查不到 → 403
        3. CheckTeamBanned 同样强制
        4. 返回 team → setTeamInfo
```

> **不变量**:`ValidateAuthProviderTeam` 绝不信任请求头里自带的 teamID——它必须和 context 中已认证的 userID 一起命中 team 成员关系才通过。这保证了「先证明你是谁,再证明你属于这个 team」的顺序。
>
> 缓存 key 为 `"{userID}-{teamID}"`(`service.go:276-278` `teamMemberCacheKey`),成员关系变更时通过 `InvalidateTeamMemberCache`(`service.go:256`)失效。

**路径 C:admin 旁路**(`store.go:432` `GetTeamFromAdminToken`)

```
X-Team-ID: <team-uuid>(+ X-Admin-Token 或 admin scheme)
    → 直接 parse teamID → authService.GetTeamByID
    → 不校验成员关系,只查 team 是否存在 + CheckTeamBanned
```

### 2.4 写入与读取

`packages/auth/pkg/auth/gin.go`:

```go
const (
    teamContextKey   = "team"     // gin.go:11
    userIDContextKey = "user_id"  // gin.go:12
)

func setTeamInfo(c *gin.Context, t *types.Team) { c.Set("team", t) }          // gin.go:32
func GetTeamInfo(c *gin.Context) (*types.Team, bool)  { ... }                 // gin.go:49
func MustGetTeamInfo(c *gin.Context) *types.Team     { panic if absent }      // gin.go:36
func MustGetTeamID(c *gin.Context) uuid.UUID         { MustGetTeamInfo().ID } // gin.go:45
```

两个 context key 是**字符串字面量**,与 `sandbox_create.go:65` 的 `c.Set("teamID", teamInfo.Team.ID.String())`(字符串型,供日志/telemetry 使用)不是一回事——handler 取 team 一律走 `auth.GetTeamInfo`,不要被那个字符串 key 迷惑。

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

`TeamLimits`(`packages/auth/pkg/types/limits.go:3-13`)——sandbox 域直接消费的字段:

| 字段 | sandbox 域用途 |
|---|---|
| `MaxLengthHours` | connect/resume/fork 的 timeout 上限校验 |
| `SandboxConcurrency` | 创建时的 reservation 上限、fork 的 count 上限 |
| `MaxVcpu` / `MaxRamMb` / `DiskMb` | 资源规格校验 |
| `BuildConcurrency` / `EventsTTLDays` | 模板构建域(本文不展开) |

`newTeamLimits`(`teams.go:17-29`)从 `authqueries.TeamLimit` 行构造。**所有 limits 都来自 auth DB 的 team 查询**——即认证器校验成功后 limits 已经在内存里,handler 零额外查询。

---

## 四、sandbox handler 的取用模式

sandbox 域的所有 handler 统一两种取法,不存在第三种:

```go
teamInfo := auth.MustGetTeamInfo(c)  // 需要 limits、slug、cluster 等完整信息时
teamID   := auth.MustGetTeamID(c)    // 只需要 ID 做归属校验/寻址时
```

| Handler | 取用 | 行号 |
|---|---|---|
| `PostSandboxes`(create) | `MustGetTeamInfo` | sandbox_create.go:63 |
| `GetSandboxesSandboxID`(get) | `MustGetTeamInfo` | sandbox_get.go:97 |
| `PostSandboxesSandboxIDConnect` | `MustGetTeamInfo` | sandbox_connect.go:28 |
| `PostSandboxesSandboxIDPause` | `MustGetTeamID` | sandbox_pause.go:30 |
| `PostSandboxesSandboxIDResume` | `MustGetTeamInfo` | sandbox_resume.go:32 |
| `PostSandboxesSandboxIDFork` | `MustGetTeamInfo` | sandbox_fork.go:41 |
| `DeleteSandboxesSandboxID`(kill) | `MustGetTeamID` | sandbox_kill.go:53 |
| `PostSandboxesSandboxIDTimeout` | `MustGetTeamID` | sandbox_timeout.go:33 |
| `GetSandboxes` / `GetV2Sandboxes`(list) | `MustGetTeamInfo` | sandboxes_list.go:102,137 |
| `GetSandboxesSandboxIDLogs` / Metrics | `MustGetTeamInfo` | sandbox_logs.go:33,62 / sandbox_metrics.go:28 |

**模式规律**:凡是需要做**配额校验**(timeout vs MaxLengthHours)或**构造新资源**(create/fork 要传整个 team 给 orchestrator)的端点,取 `MustGetTeamInfo`;只做**操作与归属校验**的端点(pause/kill/timeout)取 `MustGetTeamID`。

---

## 五、端点逐一深入:team-id 在每个 sandbox 端点中的角色

### 5.1 POST /sandboxes(创建)

`sandbox_create.go:59-131`,team-id 的五个使用点:

```go
teamInfo := auth.MustGetTeamInfo(c)                       // :63
c.Set("teamID", teamInfo.Team.ID.String())                // :65 —— 字符串型,供日志上下文

clusterID := clusters.WithClusterFallback(teamInfo.Team.ClusterID)  // :90 —— 按 team 的 cluster 亲和路由
aliasInfo, err := a.templateCache.ResolveAlias(ctx, identifier, teamInfo.Team.Slug) // :91 —— 以 team slug 解析模板别名
env, build, err := a.templateCache.Get(ctx, aliasInfo.TemplateID, tag, teamInfo.Team.ID, clusterID) // :100 —— 以 teamID 取模板 build
    // 失败时用 aliasInfo.TeamID == teamInfo.Team.ID 决定错误消息是否泄露模板存在性(:102)
```

接着 `:157` 校验 timeout 上限:

```go
if timeout > time.Duration(teamInfo.Limits.MaxLengthHours)*time.Hour {
    a.sendAPIStoreError(c, http.StatusBadRequest, fmt.Sprintf("Timeout cannot be greater than %d hours", teamInfo.Limits.MaxLengthHours))
```

后续整个 `teamInfo`(含 Limits)被传入 `a.orchestrator.CreateSandbox(ctx, ..., teamInfo, ...)`,由 orchestrator 客户端做并发 reservation(见第八章)。

**与 team 相关的后续校验**:

- `convertAPIVolumesToOrchestratorVolumes`(:424)→ `getDBVolumesMap(ctx, sqlClient, teamID, ...)`(:504)——volume 查询**直接按 teamID 过滤 SQL**(`TeamID: teamID` 参数),volume 不属于本 team 时根本查不到,属于「查询即校验」模式。
- `validateNetworkConfig`(:629)→ `validateNetworkRules`(:713)——feature flag 以 `featureflags.TeamContext(teamID.String())` 做 team 级灰度(:718),非灰度 team 用 transform rules 直接 400。

### 5.2 GET /sandboxes/{id}(查询)

`sandbox_get.go:94-199`,「先查后验」的标准范式:

```go
teamInfo := auth.MustGetTeamInfo(c)   // :97
team := teamInfo.Team

// 按 team.ClusterID 解析 sandbox 域名(:110-120,team 级 cluster 亲和)

// ① 先查运行中的 sandbox(orchestrator 内存态)
sbx, err := a.orchestrator.GetSandbox(ctx, team.ID, sandboxId)  // :123
if err == nil {
    // ② 后验归属
    if sbx.TeamID != team.ID {                                  // :126
        // → 404(不是 403!见第十二章)
        return
    }
    ...
}

// ③ 查快照(ClickHouse 持久态)
lastSnapshot, err := a.snapshotCache.Get(ctx, sandboxId)        // :179
// ④ 后验归属
if lastSnapshot.Snapshot.TeamID != team.ID {                    // :194
    // → 404
    return
}
```

**两条数据源,两次归属校验**:运行态 sandbox 在 orchestrator 内存(以 teamID 分片索引),持久态快照在 ClickHouse。get 端点必须覆盖两条路。

### 5.3 POST /sandboxes/{id}/connect(连接或恢复)

`sandbox_connect.go:24-160`,最复杂的一个:

```go
teamInfo := auth.MustGetTeamInfo(c)   // :28

if timeout > time.Duration(teamInfo.Limits.MaxLengthHours)*time.Hour {  // :46 —— 配额
    ...
}

teamID := teamInfo.Team.ID   // :52

// ① 重试 3 次:orchestrator.KeepAliveFor(ctx, teamID, sandboxID, timeout, false)  // :67
//    以 teamID 定位 sandbox;ErrNotFound → 落入恢复路径
//    NotRunningError → WaitForStateChange(ctx, teamID, sandboxID)(:103)后重试

// ② 恢复路径:查快照
lastSnapshot, err := a.snapshotCache.Get(ctx, sandboxID)   // :119
if lastSnapshot.Snapshot.TeamID != teamID {                // :134 —— 归属校验
    // → 404
}

// ③ 用整个 teamInfo 重建 sandbox(:154-160)
sbx, createErr := a.startSandbox(ctx, sandboxID, timeout, teamInfo, ...)
```

### 5.4 POST /sandboxes/{id}/pause(暂停)

`sandbox_pause.go:28-100`:

```go
teamID := auth.MustGetTeamID(c)   // :30 —— 只取 ID

err = a.orchestrator.RemoveSandbox(ctx, teamID, sandboxID, sandbox.RemoveOpts{Action: sandbox.StateActionPause, ...})  // :60

// 不在运行态 → 快照归属校验
apiErr := pauseHandleNotRunningSandbox(ctx, a.snapshotCache, sandboxID, teamID)  // :67
//    内部:sandbox_pause.go:96-100 snap.Snapshot.TeamID != teamID → 404
```

### 5.5 POST /sandboxes/{id}/resume(恢复)

`sandbox_resume.go:31-159`,与 connect 同构:

- `:62` — MaxLengthHours 配额校验
- `:70` — `orchestrator.GetSandbox(ctx, teamID, sandboxId)`
- `:72` — **运行态归属校验** `sandboxData.TeamID != teamID` → 404
- `:82` — `WaitForStateChange(ctx, teamID, sandboxID)`
- `:142` — **快照归属校验** `lastSnapshot.Snapshot.TeamID != teamID` → 404

### 5.6 POST /sandboxes/{id}/fork(派生)

`sandbox_fork.go:41-168`,同时消费 team 的 limits 和 ID:

```go
teamInfo := auth.MustGetTeamInfo(c)   // :41
teamID := teamInfo.Team.ID            // :42

if forkTimeout > time.Duration(teamInfo.Limits.MaxLengthHours)*time.Hour {  // :68 —— 配额
if int64(forkCount) >= teamInfo.Limits.SandboxConcurrency {                  // :94 —— fork 数量不得超过并发上限
    // → 400 "Count must be lower than the maximum number of concurrent sandboxes"
}

original, err := a.orchestrator.GetSandbox(ctx, teamID, sandboxID)  // :100 —— 以 teamID 寻址
err = a.orchestrator.CheckpointSandbox(ctx, teamID, sandboxID)      // :124 —— 以 teamID 寻址
```

### 5.7 DELETE /sandboxes/{id}(销毁)

`sandbox_kill.go:53-113`:

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

`sandboxes_list.go:102-222`:

```go
teamInfo := auth.MustGetTeamInfo(c)   // :102 / :137
team := teamInfo.Team

a.posthog.IdentifyAnalyticsTeam(ctx, team.ID.String(), team.Name)   // :105 —— team 维度分析
sandboxes, err := a.orchestrator.GetSandboxes(ctx, team.ID, ...)     // :117 —— 只列本 team
pausedSandboxList, err := a.getPausedSandboxes(ctx, team.ID, ...)    // :222 —— 快照按 teamID 过滤(内部 SQL 带 TeamID,见 :35-54)
```

列表端点**不需要 post-fetch 归属校验**:查询本身就是按 teamID 过滤的(见第六章模式三)。

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

用于 **orchestrator 内存态** 与 **snapshotCache** 的查询(get :126、connect :134、pause :100、resume :72/:142)。

**为什么必须后验**:orchestrator 与 ClickHouse 的查询接口目前不接收 teamID 过滤参数(见 `sandbox_get.go:178`、`sandbox_connect.go:118`、`sandbox_pause.go:97`、`sandbox_resume.go:123` 的同一处 TODO):

```go
// TODO: ENG-3544 scope GetLastSnapshot query by teamID to avoid post-fetch ownership check.
```

即现状是**先按 sandboxID 全局查、再在 API 层比对 TeamID**。这不安全吗?不——API 层比对是可靠的:只要比对发生在返回数据之前,越权请求只能拿到 404。TODO 的目标是**减少无效查询**(性能/爆炸半径),不是补安全洞。

**不变量**:所有「先查后验」路径,**校验失败一律返回 404 而非 403**——向攻击者隐藏资源存在性(见第十二章)。

### 模式二:查询即校验(按 teamID 过滤 SQL)

```go
getDBVolumesMap(ctx, sqlClient, teamID, volumeMounts)   // sandbox_create.go:504,SQL 带 TeamID: teamID
GetSnapshotBuilds(ctx, a.sqlcDB, teamID, sandboxID)     // sandbox_kill.go:113
getPausedSandboxes(ctx, team.ID, ...)                   // sandboxes_list.go:222(内部 queries 带 teamID)
```

用于 **API 直连 PostgreSQL/ClickHouse 的查询**。查询条件里带上 teamID,资源不属于本 team 时直接查不到,天然不存在「越权读到再丢弃」的窗口。

**权衡**:模式二更安全(无窗口)、更省(不查无谓数据),但要求查询接口支持 teamID 参数;模式一依赖调用方自觉后验,一旦有 handler 忘了比对就是真实越权漏洞。**写新 handler 时,能走模式二就不要走模式一**。

### 模式三:模板可见性(公开/私有)

`sandbox_create.go:100-105`:

```go
env, build, err := a.templateCache.Get(ctx, aliasInfo.TemplateID, tag, teamInfo.Team.ID, clusterID)
if err != nil {
    visible := aliasInfo.TeamID == teamInfo.Team.ID   // :102 —— 私有模板:只对 owner team 可见
    if metadata, mErr := a.templateCache.GetMetadata(ctx, aliasInfo.TemplateID); mErr == nil {
        visible = visible || metadata.Public            // :104 —— 公开模板:所有人可见
    }
    // visible 决定错误消息是否暴露模板信息
}
```

不是硬校验,而是**错误信息泄露控制**:模板存在但不属于本 team 时,错误消息按 `visible` 区分「模板不存在」与「模板不可用」,防止通过报错差异枚举私有模板。

---

## 七、team 状态裁决:banned 与 blocked

两个状态在不同层裁决,时序也不同:

### 7.1 banned —— 认证时强制(`auth_store.go`)

`CheckTeamBanned`(`packages/auth/pkg/auth/team_state.go:13-19`)定义在**共享 auth store 内部**,三条 team 查询路径(`GetTeamByHashedAPIKey` :38、`GetTeamByID` :65、`GetTeamByIDAndUserID` :91)全部强制调用:

```go
func CheckTeamBanned(team authqueries.Team) error {
    if team.IsBanned {
        return &TeamForbiddenError{Message: "team is banned"}
    }
    return nil
}
```

- banned team **在认证阶段就被拒绝**,根本到不了 sandbox handler。
- `TeamForbiddenError` 在 `commonAuthenticator.Authenticate`(`middleware.go:96-99`)被特殊识别,直接上抛(不包装),最终映射 403。
- **生效延迟**:teamCache TTL 5 分钟(`cache.go:14`)——ban 一个 team 后,已缓存的 API key 最长 5 分钟内仍可通过认证。要立即生效需 `InvalidateTeamCache`(`service.go:261`,同时清 team key 与所有 API key hash 缓存)。

### 7.2 blocked —— 中间件裁决 + allowlist(`team_middleware.go` / `blocked_team.go`)

`CheckTeamBlocked`(`team_state.go:28-39`)返回 `TeamBlockedError`,但它**不在 store 层强制执行**——由各服务的中间件在认证后按路由决定:

```go
// packages/auth/pkg/auth/team_middleware.go:59
func EnforceBlockedTeam(allowlist BlockedTeamAllowlist) gin.HandlerFunc {
    return func(c *gin.Context) {
        team, ok := GetTeamInfo(c)
        if !ok || team == nil {
            c.Next()          // admin / access-token 路径无 team → 短路放行
            return
        }
        if err := CheckBlockedTeamForRoute(c, team, allowlist); err != nil {
            // 403 + Abort
        }
        c.Next()
    }
}
```

API 服务的 allowlist(`packages/api/internal/middleware/blocked_team.go:15-45`):

| 方法 | sandbox 相关放行路由 |
|---|---|
| GET | `/sandboxes`、`/sandboxes/metrics`、`/sandboxes/:sandboxID`、`/sandboxes/:sandboxID/logs`、`/sandboxes/:sandboxID/metrics`、`/v2/sandboxes`、`/v2/sandboxes/:sandboxID/logs` |
| DELETE | `/sandboxes/:sandboxID` |
| 其余(sandbox 域) | **不放行** —— create/connect/resume/pause/fork/timeout 全部 403 |

**设计动机**:blocked team 被允许「读和删」(清理资源、导出数据),但不允许「创建和运行」(新增计费资源)。所以 GET 全家桶与 DELETE 在 allowlist,其余全部拒绝。

> **不变量(中间件顺序)**:`EnforceBlockedTeam` 在 `main.go:231` 注册,位于 oapi-codegen 认证(:203)、ratelimit(:226)之后、handler 之前。**必须跑在认证之后**——它依赖 context 里的 team;也**必须跑在 handler 之前**——handler 自身不做 blocked 检查(个别 deprecated 路径除外,见 11.1 的 `applyTeamAccessCheck`)。

---

## 八、team limits 的执行点

### 8.1 timeout 上限(API 层内联校验)

| 端点 | 校验 | 行号 |
|---|---|---|
| create | `timeout > Limits.MaxLengthHours h → 400` | sandbox_create.go:157 |
| connect | 同上 | sandbox_connect.go:46 |
| resume | 同上 | sandbox_resume.go:62 |
| fork | 同上 | sandbox_fork.go:68 |

### 8.2 并发上限(orchestrator 客户端 + reservation)

`packages/api/internal/orchestrator/create_instance.go:153-160`:

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

`sandbox_fork.go:94` — `forkCount >= Limits.SandboxConcurrency → 400`(复用并发上限作为 fork 数量的天花板)。

---

## 九、team-id 向下游的传播

sandbox handler 里 teamID 有四个流向:

### 9.1 orchestrator gRPC(第一公民参数)

所有 orchestrator 客户端方法都以 `teamID` 为首参——orchestrator 内部按 team 分片索引:

| API 调用 | 端点 | 行号 |
|---|---|---|
| `GetSandbox(ctx, team.ID, sandboxId)` | get / resume / fork | sandbox_get.go:123、sandbox_resume.go:70、sandbox_fork.go:100 |
| `GetSandboxes(ctx, team.ID, states)` | list | sandboxes_list.go:117 |
| `KeepAliveFor(ctx, teamID, sandboxID, timeout, ...)` | connect / timeout | sandbox_connect.go:67、sandbox_timeout.go:52 |
| `RemoveSandbox(ctx, teamID, sandboxID, opts)` | pause / kill | sandbox_pause.go:60、sandbox_kill.go:64 |
| `CheckpointSandbox(ctx, teamID, sandboxID)` | fork | sandbox_fork.go:124 |
| `WaitForStateChange(ctx, teamID, sandboxID)` | connect / resume | sandbox_connect.go:103、sandbox_resume.go:82 |
| `CreateSandbox(ctx, ..., team *Team, ...)` | create / resume / connect / fork | 整个 team(含 Limits)传入 |

### 9.2 snapshotCache / PostgreSQL(过滤条件)

- `snapshotCache.Get(ctx, sandboxId)` — 现状不按 team 过滤,靠 post-fetch 比对(ENG-3544 待改)
- `GetSnapshotBuilds(ctx, sqlcDB, teamID, sandboxID)`(sandbox_kill.go:113)、`getPausedSandboxes(ctx, team.ID, ...)`(sandboxes_list.go:222)— SQL 级过滤

### 9.3 telemetry / 日志

- 错误上报:`telemetry.WithTeamID(teamID.String())`(connect :84/:107/:128、get :127 等)——trace 按 team 关联
- 日志:`logger.WithTeamID(...)`(ratelimit :93、main.go:150 日志上下文)
- sandbox 结构日志:`sbxlogger.E(&sbxlogger.SandboxMetadata{SandboxID, TemplateID, TeamID})`(create :128、connect :148、fork :152、resume :152)

### 9.4 posthog 分析

`sandboxes_list.go:105,140` — `IdentifyAnalyticsTeam(team.ID, team.Name)` + team 维度事件。

---

## 十、认证后的中间件链

`main.go:203-231` 的注册顺序即执行顺序,其中三个环节与 team 直接相关:

```
① oapi-codegen 校验 + AuthenticationFunc   (:203)  ← team 在此注入
② InitLaunchDarklyContext                   (:221)  ← 读 GetTeamInfo/GetUserID 构建 LD 上下文
③ ratelimit.Middleware                      (:226)  ← per-team 限流
④ customMiddleware.EnforceBlockedTeam()     (:231)  ← blocked 裁决
⑤ api.RegisterHandlersWithOptions           (:234)  ← sandbox handler
```

### 10.1 LaunchDarkly 上下文

`packages/api/internal/middleware/launchdarkly.go:32,41` — 同时读 `GetUserID` 与 `GetTeamInfo`,构建 LD evaluation context。**这意味着所有 feature flag 都可以按 team/user 灰度**,sandbox 域直接用到它的例子:`validateNetworkRules`(`sandbox_create.go:718`)的 `featureflags.TeamContext(teamID.String())`。

### 10.2 per-team 限流

`packages/api/internal/middleware/ratelimit/ratelimit.go:73-104`:

```go
team, ok := auth.GetTeamInfo(c)
if !ok {
    c.Next()          // 无 team(admin/access-token)→ 跳过限流
    return
}
limit, ok := resolveLimit(ctx, ff, route)   // 按路由从 LD flag 解析限额
if !ok { c.Next(); return }                 // 路由未配置 → 不限流

key := redis_utils.CreateKey(rateLimitPefix, teamID, route)  // :104 —— 限流 key = teamID + 路由
res, err := limiter.Allow(ctx, key, limit)   // Redis 令牌桶;Redis 故障 FailOpen(:226 Config{FailOpen: true})
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

### 11.2 access token 的废弃闸门

`store.go:396-416` `GetUserFromAccessToken`:

```go
if a.featureFlags.BoolFlag(ctx, featureflags.DisableE2BAccessTokenAuthFlag, featureflags.UserContext(userID.String())) {
    // → 401 "E2B_ACCESS_TOKEN is deprecated ... Use an API key (E2B_API_KEY) instead"
}
```

flag 在**验证成功后**再评估——按 userID 灰度关闭 access token 认证,是迁移到「一切 sandbox 路由都走 team 型认证」的中间态闸门。

### 11.3 admin 旁路(team 型)

`store.go:432-479` `GetTeamFromAdminToken`(配 `AdminTeamAuth` / `X-Team-ID`):

- parse teamID → `authService.GetTeamByID`(cache + store,含 CheckTeamBanned)
- **不校验成员关系**——admin 以任意 team 身份操作
- `AdminApiKeyAuth`(`X-Admin-Token`)则完全不写 team,供纯 admin 端点(如 `/admin/teams/{teamID}/sandboxes/kill`,`admin_kill_team_sandboxes.go`)使用

---

## 十二、不变量与安全设计

1. **`MustGet*` panic 是安全网而非炸弹**:sandbox handler 全部使用 `MustGetTeamInfo`/`MustGetTeamID`。若未来有人在未声明 team 型 security scheme 的路由上挂 sandbox handler,请求会 panic → `gin.Recovery()` 兜底 500。宁可 500 也不静默放行。写新路由时务必在 `spec/openapi.yml` 声明正确的 security。

2. **归属校验失败 = 404,不是 403**:所有 post-fetch ownership check(get/connect/pause/resume)失败时返回 `utils.SandboxNotFoundMsg(id)`。理由:403 会向攻击者泄露「这个 sandboxID 存在,只是不属于你」,404 让越权探测与不存在的 sandbox 无法区分。

3. **ban 在认证层、block 在路由层**:banned 是「整个 team 的一切请求都拒」(认证期 403,任何服务任何端点);blocked 是「允许读和删、禁止创建和运行」(按路由 allowlist 精细放行)。两者语义不同,不要在 handler 里混用。

4. **两条 team 获取链互斥**:handler 要么拿到认证器注入的 team(标准路径),要么走 `GetTeam` 晚解析(deprecated 路径),且晚解析路径必须自行调用 `applyTeamAccessCheck` 补 blocked 检查——这是目前唯一绕开 `EnforceBlockedTeam` 的通道,改动 `GetTeam` 时务必保留该调用。

5. **teamCache 是 team-id 认证的失效窗口**:TTL 5min + 后台刷新(`cache.go:14-15`)。ban/改限额/改成员关系后,已缓存身份最长 5 分钟不感知。运营操作(ban team、踢成员)必须配套 `InvalidateTeamCache` / `InvalidateTeamMemberCache`。

6. **创建类动作的双重闸门**:create/connect/resume/fork 同时受「中间件 blocked 拦截」与「handler 内 MaxLengthHours/SandboxConcurrency 校验」约束;blocked team 即使有已缓存的认证也过不了创建端点(allowlist 不含任何 sandbox 创建路由)。

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
  │                    │   │   miss → GetTeamByHashedAPIKey(Read replica)      │
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

| 关注点 | 位置 |
|---|---|
| 认证器装配(6 种) | `packages/api/main.go:189-199` |
| 认证器骨架 / header 提取 / 注入 | `packages/auth/pkg/auth/middleware.go:40-111` |
| API Key 认证器定义 | `middleware.go:133` |
| AuthProviderTeam 认证器定义 | `middleware.go:176` |
| AdminTeam 认证器定义 | `middleware.go:205` |
| context key 与存取 | `packages/auth/pkg/auth/gin.go:10-51` |
| `ValidateAPIKey` | `packages/auth/pkg/auth/service.go:93` |
| `ValidateAuthProviderTeam`(两段式) | `service.go:213` |
| store 层(读副本 + ban + 异步 last_used) | `packages/auth/pkg/auth/auth_store.go:29-98` |
| `CheckTeamBanned` / `CheckTeamBlocked` | `packages/auth/pkg/auth/team_state.go:13-39` |
| `EnforceBlockedTeam` 中间件 | `packages/auth/pkg/auth/team_middleware.go:59-77` |
| API 服务 allowlist | `packages/api/internal/middleware/blocked_team.go:15-45` |
| `Team` / `TeamLimits` 类型 | `packages/auth/pkg/types/teams.go:7-45`、`limits.go:3-13` |
| teamCache TTL(5min) | `packages/auth/pkg/auth/cache.go:14` |
| `GetTeam`(deprecated teamID 参数) | `packages/api/internal/handlers/auth.go:33-128` |
| `GetTeamFromAdminToken` | `packages/api/internal/handlers/store.go:432-479` |
| access token 废弃闸门 | `store.go:396-416` |
| create:team 使用点 | `packages/api/internal/handlers/sandbox_create.go:63-131,157` |
| get:运行态/持久态双重归属校验 | `sandbox_get.go:97-199` |
| connect:KeepAlive + 快照校验 | `sandbox_connect.go:28-160` |
| pause / kill:RemoveSandbox(teamID) | `sandbox_pause.go:30-100`、`sandbox_kill.go:53-113` |
| resume / fork:limits + 归属 | `sandbox_resume.go:32-159`、`sandbox_fork.go:41-168` |
| 并发 reservation(429) | `packages/api/internal/orchestrator/create_instance.go:153-160` |
| per-team 限流 | `packages/api/internal/middleware/ratelimit/ratelimit.go:73-104` |
| ENG-3544(快照查询按 team 过滤) | `sandbox_get.go:178`、`sandbox_connect.go:118`、`sandbox_pause.go:97`、`sandbox_resume.go:123` |
