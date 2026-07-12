# Sandbox API 模块详解

> 范围:`packages/api/internal/handlers/` 中所有以 `sandbox` 为资源根的 REST 端点,以及一个 admin 批量 kill 端点。本文不深入 orchestrator 内部的 Firecracker/vm 部署细节——那是 `sandbox-management.md` 的内容——而是聚焦于 **API 层(HTTP 入口、请求/响应模型、校验、与 orchestrator 的边界)**。
>
> 阅读建议:先看「四、端点全景图」建立全局视图,再按需深入具体章节。

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、整体架构](#三整体架构)
- [四、端点全景图](#四端点全景图)
- [五、创建 Sandbox:PostSandboxes 深入解析](#五创建-sandboxpostsandboxes-深入解析)
- [六、生命周期端点(Pause / Resume / Refresh / Timeout / Connect)](#六生命周期端点pause--resume--refresh--timeout--connect)
- [七、查询端点(List / Get / Logs / Metrics)](#七查询端点list--get--logs--metrics)
- [八、网络与 Volume 配置](#八网络与-volume-配置)
- [九、Admin 与 Snapshot 端点](#九admin-与-snapshot-端点)
- [十、关键流程时序图](#十关键流程时序图)
- [十一、配置与 Feature Flag](#十一配置与-feature-flag)
- [十二、关键代码文件索引](#十二关键代码文件索引)
- [十三、设计要点与权衡](#十三设计要点与权衡)
- [十四、常见问题与排查](#十四常见问题与排查)
- [附录 A:端点速查表](#附录-a端点速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录-b错误码与-http-状态映射)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

Sandbox 是 E2B 平台的核心资源对象:一个由 Firecracker microVM 提供的隔离执行环境。从 REST 视角看,它的生命周期由 `packages/api/internal/handlers/sandbox_*.go` 中的一系列 `APIStore` 方法驱动:

- **创建/恢复**:`POST /sandboxes`、`POST /sandboxes/{id}/resume`、`POST /sandboxes/{id}/connect`
- **状态查询**:`GET /sandboxes`、`GET /v2/sandboxes`、`GET /sandboxes/{id}`
- **生命周期管理**:`POST /sandboxes/{id}/pause`、`POST /sandboxes/{id}/refreshes`、`POST /sandboxes/{id}/timeout`、`DELETE /sandboxes/{id}`
- **网络更新**:`PUT /sandboxes/{id}/network`
- **可观测性**:`GET /sandboxes/{id}/logs`、`GET /sandboxes/{id}/metrics`、`GET /sandboxes/metrics`
- **快照创建**:`POST /sandboxes/{id}/snapshots`
- **Admin 批量**:`POST /admin/teams/{teamID}/sandboxes/kill`

这一层是 **HTTP ↔ 业务逻辑的翻译层**:解析请求、做输入校验(模板引用、网络规则、envd 版本、配额)、调度的元数据(trace、telemetry)、把请求转发到 `orchestrator`(运行中的 sandbox)或 `snapshotCache`(已暂停的 sandbox),再把内部模型翻译回 OpenAPI 响应。**业务核心的 vm 控制**——比如调度、网络命名空间、NBD——都在 orchestrator,本文只点到为止。

### 与其他文档的边界

| 主题 | 文档 |
|---|---|
| API 整体(端口、middleware、OpenAPI 生成) | `api-module.md` |
| Auth/APIKey/AccessToken 验证 | `auth-module.md`、`api-keys-module.md`、`access-tokens-module.md` |
| Orchestrator 内部(vm 调度、reclaim、三索引映射) | `sandbox-management.md`、`orchestrator-module.md` |
| Snapshot/Template 持久化与缓存 | `snapshots.md`、`template-module.md` |
| 团队级配额与计费 | `team-metrics-module.md` |
| **Sandbox API 端点本身** | **本文** |

---

## 二、核心概念

### 2.1 Sandbox 状态机

E2B 区分 **内部状态**(`sandbox.State`,orchestrator 视角)与 **API 状态**(`api.SandboxState`,OpenAPI 暴露给客户端)。

#### 内部状态(`packages/api/internal/sandbox/sandboxtypes/states.go`)

| 状态 | 含义 | API 层含义 |
|---|---|---|
| `StateRunning` | 正在运行,可接受连接 | `GET` 返回 sandbox,`KeepAliveFor` 可延长 |
| `StatePausing` | 正在转为 paused(快照进行中) | `resume` 等待状态变化,`pause` 视为 already-paused |
| `StateKilling` | 正在被销毁 | 大多数端点返回 404 或 409 |
| `StateSnapshotting` | 正在生成快照模板(管理员/用户主动) | `resume` 返回 409 |

#### API 状态(对外暴露)

| `api.SandboxState` | 来源 | 含义 |
|---|---|---|
| `api.Running` | 内部 `StateRunning` | 用户可使用 |
| `api.Paused` | (a) 内部 `StatePausing` 或 (b) 完全落盘到 ClickHouse `snapshots` 表 | "不可用但可恢复" |

**关键**:`api.Paused` 是 **用户视角的"不可用但可恢复"**,它在内部对应两种状态:
- (a) sandbox 仍在 orchestrator 内存中,但正在 `StatePausing`(`instanceInfoToPaginatedSandboxes`,`sandboxes_list.go:313` 把它映成 `api.Paused`)
- (b) sandbox 已彻底离开 orchestrator 内存,只在 ClickHouse `snapshots` 表中存有行(`snapshotsToPaginatedSandboxes`,`sandboxes_list.go:285` 也返回 `api.Paused`)

情况 (b) 才是真正"冷"的 sandbox,API 层用「`orchestrator.GetSandbox` 失败 + `snapshotCache.Get` 命中」推断其存在。

### 2.2 SandboxID 格式

- **完整 ID**:`"i" + id.Generate()`,其中 `id.Generate()`(`packages/shared/pkg/id/id.go:28-30`)是 `uniuri.NewLenChars(uniuri.UUIDLen, caseInsensitiveAlphabet)`——一个 **随机小写字母数字串**(UUID 长度,但不是 ULID,无时间排序语义)。前缀 `i` 由 `InstanceIDPrefix` 常量提供(`sandbox_create.go:44`)。
- **校验**:`utils.ShortID`(`packages/api/internal/utils/split.go:10-26`)允许两种输入——纯 sandboxID,或 `sandboxID-executionID` 复合形式(以 `-` 分隔,最多两段)。它会用 `id.ValidateSandboxID`(regex `^[a-z0-9]+$`)校验 sandboxID 部分。
- **入参规整**:绝大多数端点先调 `utils.ShortID(sandboxID)` 抽取真正的 sandboxID,失败返回 `400 Invalid sandbox ID`。

### 2.3 三种"启动"语义

API 层有三个看起来相似的入口,但语义截然不同:

| 入口 | 何时调用 | 是否新建 sandboxID | 起点 |
|---|---|---|---|
| `POST /sandboxes` | 全新创建 | **是**(`i` + 随机串) | 模板 build(rootfs + kernel) |
| `POST /sandboxes/{id}/resume` | 用户主动恢复已暂停的 sandbox | 否(沿用旧 ID) | 快照(memory 或 filesystem) |
| `POST /sandboxes/{id}/connect` | "用法像 KeepAlive,实在不行就帮我恢复" | 否 | 优先 Running;否则走 resume 流程 |

`connect` 与 `resume` 的关键差别在于 `connect` 默认 **不强制恢复**:它会先尝试 `KeepAliveFor`(只延长生命),只有当 sandbox 真的不存在时才退化为 resume。`resume` 则是用户明确表达"我要它跑起来"。

### 2.4 三类超时

| 名称 | 含义 | 默认值/上限 |
|---|---|---|
| `timeout`(请求体) | sandbox 单次运行时长,到期触发 `autoPause`(若开启)或 kill | `SandboxTimeoutDefault = 15 * time.Second`(`sandboxtypes/states.go:90`);上限 `teamInfo.Limits.MaxLengthHours` 小时 |
| `MinAutoResumeTimeoutSeconds`(LD flag) | `autoResume` 的最小保留时长,低于此值会被向上修正 | feature flag |
| `MaxLengthHours` | 团队级硬上限 | 团队配置 |

### 2.5 `autoPause` / `autoPauseFilesystemOnly` / `autoResume` 三件套

- **`autoPause`**(默认 `false`,`AutoPauseDefault`):timeout 到期时是否生成快照而非 kill。
- **`autoPauseMemory`**(默认 `true`):为 `true` 时拍完整 memory snapshot;为 `false` 时仅拍 filesystem 快照(`autoPauseFilesystemOnly = true`)。
- **`autoResume`**(`SandboxAutoResumeConfig`): traffic-driven 自动恢复策略,`Enabled=true` 时允许任意流量触发自动恢复。

三者间有两条强校验:

1. `autoPauseFilesystemOnly && !autoPause` → `400 autoPauseMemory=false only applies when autoPause is true.`(`sandbox_create.go:173-177`)
2. `autoPauseFilesystemOnly && autoResume.Policy == Any` → `400 ... cannot be auto-resumed by traffic and must be resumed explicitly.`(`sandbox_create.go:181-185`)——filesystem-only 快照没有内存状态,**只能** 显式 `resume` 或 `connect`,不允许 traffic-driven 自动恢复。

### 2.6 Feature Flag 门槛

| 能力 | Feature Flag | envd 最低版本 | 常量 |
|---|---|---|---|
| Secure envd access | — | `0.2.0` | `minEnvdVersionForSecureFlag`(`sandbox_create.go:46`) |
| Network transform rules | `NetworkTransformRulesFlag` | `0.5.13` | `minEnvdVersionForNetworkRules`(`sandbox_create.go:399`) |
| Persistent volumes | `PersistentVolumesFlag` | `0.5.14` | `minEnvdVersionForVolumes`(`sandbox_create.go:401`) |
| Egress proxy (BYOP) | `BYOPProxyEnabledFlag` | — | — |

`checkEnvdVersionRequirement`(`sandbox_create.go:407-422`)是统一入口:版本为空 → `errNoEnvdVersion`;无法解析 → 包装错误;低于最低 → 包装 `featureErr`。

---

## 三、整体架构

```
            ┌──────────────────────────── HTTP 请求 ────────────────────────────┐
            │                                                                    │
            ▼                                                                    │
   ┌─────────────────────┐                                                      │
   │  gin + middleware   │  ← auth 校验(见 auth-module.md)、trace、log         │
   └─────────┬───────────┘                                                      │
             │                                                                    │
             ▼                                                                    │
   ┌─────────────────────┐    解析 → 校验 → 翻译                                 │
   │  APIStore handler   │  (sandbox_create.go / sandbox_pause.go / ...)        │
   └─────────┬───────────┘                                                      │
             │                                                                    │
   ┌─────────┴────────────────────────────────────────────┐                     │
   │                                                      │                     │
   ▼                                                      ▼                     │
┌──────────────────────┐                    ┌────────────────────────┐         │
│ orchestrator         │                    │ snapshotCache          │         │
│ (Running sandbox)    │                    │ (Paused sandbox)       │         │
│ - GetSandbox         │                    │ - Get(sandboxID)       │         │
│ - KeepAliveFor       │                    │ - 来自 ClickHouse      │         │
│ - RemoveSandbox      │                    │   snapshots 表         │         │
│   (Action: Pause/    │                    │                        │         │
│    Kill)             │                    │                        │         │
│ - CreateSandbox      │                    │                        │         │
│ - WaitForStateChange │                    │                        │         │
└──────────┬───────────┘                    └────────────────────────┘         │
           │                                                                 │
           ▼                                                                 │
   ┌─────────────────────┐                                                  │
   │  gRPC → nomad 上的   │  ← 见 orchestrator-module.md / sandbox-management │
   │  orchestrator 实例   │                                                  │
   └─────────────────────┘                                                  │
                                                                            │
   ┌─────────────────────┐     ┌────────────────────────┐                   │
   │  clusters.Resources │ ──▶ │ Local 或 Remote(转发到   │                   │
   │  (logs/metrics)     │     │  边缘 cluster)          │                   │
   └─────────────────────┘     └────────────────────────┘                   │
                                                                            │
   └────────────────────────────────────────────────────────────────────────┘
```

### 3.1 APIStore 的依赖

`sandbox_*` handler 全部是 `*APIStore` 的方法,所以它们共享同一组依赖:

| 字段 | 用途 | 在 sandbox handler 中的使用 |
|---|---|---|
| `orchestrator` | gRPC client 池 | 创建/查找/移除运行中的 sandbox |
| `snapshotCache` | 已暂停 sandbox 的快照缓存 | resume/connect/get/pause 走的 fallback 路径 |
| `templateCache` | 模板/别名解析 | `PostSandboxes` 解析 `templateID` |
| `featureFlags` | LaunchDarkly client | 网络规则/volumes/egress proxy 的开关 |
| `sqlcDB` | PostgreSQL | volumes 查询、snapshot 持久化 |
| `posthog` | 分析事件 | 创建带网络规则的 sandbox 时上报 |
| `accessTokenGenerator` | envd access token 生成 | secure 模式 |
| `authService` | 团队缓存失效 | admin kill 在前后两次失效缓存 |
| `templateSpawnCounter` | 模板 spawn 计数 | 启动成功后异步 +1 |

### 3.2 通用前置/收尾模式

绝大多数 handler 遵循同一套模板:

1. `ctx := c.Request.Context()`
2. 从 gin context 取 `teamInfo`(`auth.MustGetTeamInfo(c)`)或 `teamID`(`auth.MustGetTeamID(c)`)
3. 起 trace span,把 `traceID` 塞回 gin context(供错误响应中间件读取)
4. 调 `utils.ShortID(sandboxID)` 规整 ID
5. 业务逻辑
6. 通过 `a.sendAPIStoreError(c, code, msg)` 或 `c.JSON(...)` 返回

---

## 四、端点全景图

| # | 方法 | 路径 | Handler(`*APIStore` 方法) | 文件:行 | 简述 |
|---|---|---|---|---|---|
| 1 | POST | `/sandboxes` | `PostSandboxes` | `sandbox_create.go:59` | 创建新 sandbox |
| 2 | GET | `/sandboxes` | `GetSandboxes` | `sandboxes_list.go:98` | 列出(v1,无分页) |
| 3 | GET | `/v2/sandboxes` | `GetV2Sandboxes` | `sandboxes_list.go:133` | 列出(v2,游标分页) |
| 4 | GET | `/sandboxes/{sandboxID}` | `GetSandboxesSandboxID` | `sandbox_get.go:94` | 查询单个 |
| 5 | DELETE | `/sandboxes/{sandboxID}` | `DeleteSandboxesSandboxID` | `sandbox_kill.go:39` | Kill |
| 6 | POST | `/sandboxes/{sandboxID}/pause` | `PostSandboxesSandboxIDPause` | `sandbox_pause.go:26` | 暂停(可选 filesystem-only) |
| 7 | POST | `/sandboxes/{sandboxID}/resume` | `PostSandboxesSandboxIDResume` | `sandbox_resume.go:28` | 主动恢复 |
| 8 | POST | `/sandboxes/{sandboxID}/connect` | `PostSandboxesSandboxIDConnect` | `sandbox_connect.go:24` | KeepAlive,失败则恢复 |
| 9 | POST | `/sandboxes/{sandboxID}/refreshes` | `PostSandboxesSandboxIDRefreshes` | `sandbox_refresh.go:18` | 刷新(不延长总寿命) |
| 10 | POST | `/sandboxes/{sandboxID}/timeout` | `PostSandboxesSandboxIDTimeout` | `sandbox_timeout.go:17` | 修改 timeout(可延长) |
| 11 | PUT | `/sandboxes/{sandboxID}/network` | `PutSandboxesSandboxIDNetwork` | `sandbox_network_update.go:21` | 更新网络配置 |
| 12 | GET | `/sandboxes/{sandboxID}/logs` | `GetSandboxesSandboxIDLogs` | `sandbox_logs.go:22` | 日志(v1) |
| 13 | GET | `/v2/sandboxes/{sandboxID}/logs` | `GetV2SandboxesSandboxIDLogs` | `sandbox_logs.go:51` | 日志(v2,游标 + 方向) |
| 14 | GET | `/sandboxes/{sandboxID}/metrics` | `GetSandboxesSandboxIDMetrics` | `sandbox_metrics.go:16` | 单 sandbox 指标 |
| 15 | GET | `/sandboxes/metrics` | `GetSandboxesMetrics` | `sandboxes_list_metrics.go:68` | 批量指标(最多 100) |
| 16 | POST | `/sandboxes/{sandboxID}/snapshots` | `PostSandboxesSandboxIDSnapshots` | `snapshot_template_create.go:25` | 从 sandbox 派生新模板 |
| 17 | POST | `/admin/teams/{teamID}/sandboxes/kill` | `PostAdminTeamsTeamIDSandboxesKill` | `admin_kill_team_sandboxes.go:17` | Admin:批量 kill |

> 本文按功能聚类讲解(创建 → 生命周期 → 查询 → 网络 → admin/snapshot),而不是逐条流水账。

---

## 五、创建 Sandbox:`PostSandboxes` 深入解析

`POST /sandboxes`(`sandbox_create.go:59-337`)是整个模块最复杂的 handler,流程如下:

### 5.1 主干流程

```
1. 取 teamInfo;塞 teamID/traceID 到 gin context
2. ParseBody[PostSandboxesJSONRequestBody]
3. id.ParseName(body.TemplateID) → (identifier, tag, err)
4. clusterID = clusters.WithClusterFallback(teamInfo.Team.ClusterID)
5. templateCache.ResolveAlias(ctx, identifier, teamInfo.Team.Slug) → aliasInfo
6. templateCache.Get(ctx, aliasInfo.TemplateID, tag, teamInfo.Team.ID, clusterID) → env, build
   - 失败时考虑可见性(团队私有/公开),返回对应 4xx
7. 计算 sandboxID = "i" + id.Generate()
8. 计算 autoPause / autoPauseFilesystemOnly / envVars / mcp / metadata / apiVolumeMounts
9. 计算 timeout(默认 15s,不可超过 teamInfo.Limits.MaxLengthHours 小时)
10. 计算 autoResume(若启用),用 feature flag 修正最小 timeout
11. 强校验两条组合规则:
    - `autoPauseFilesystemOnly && !autoPause` → 400(filesystem-only 无意义)
    - `autoPauseFilesystemOnly && autoResume.Policy == Any` → 400(不能 traffic 自动恢复)
12. 处理 secure flag(若 body.Secure == true)→ 生成 envdAccessToken
13. 处理 network 配置(若 body.Network != nil):
    - validateNetworkConfig
    - 转换为 types.SandboxNetworkConfig
    - 处理 egressProxy(BYOPProxyEnabledFlag)
    - 若禁用公共入口 → 必须有 envdAccessToken
14. convertAPIVolumesToOrchestratorVolumes(featureFlags + DB 查询 + 校验)
15. 组装 getSandboxData 闭包(返回 apiorch.SandboxMetadata)
16. startSandbox(ctx, sandboxID, timeout, teamInfo, getSandboxData, headers, isResume=false, mcp)
17. 若有网络转换规则 → 上报 posthog 分析事件
18. c.JSON(201, &sbx)
```

### 5.2 模板引用解析(`id.ParseName`)

`body.TemplateID` 支持三种形式:

- 裸 ID: `<uuid>`
- 命名空间/别名: `<teamSlug>/<alias>`
- 带标签: `<identifier>:<tag>`

`id.ParseName`(`sandbox_create.go:82`)把三者拆为 `(identifier, tag)`。`templateCache.ResolveAlias` 再把 alias 形式解析回真正的 templateID。**这种"宽松输入 + 集中解析"是 E2B API 的统一风格**——同样的逻辑也出现在 `PostSandboxesSandboxIDSnapshots`(`snapshot_template_create.go:64`)。

### 5.3 别名归属校验

`templateCache.Get` 失败时,handler 不直接抛错,而是先做"可见性"判定(`sandbox_create.go:101-116`):

- `aliasInfo.TeamID == teamInfo.Team.ID`:本团队
- 否则查 `templateCache.GetMetadata(...).Public`:公开模板

据此构造 `templatecache.TemplateRef{Identifier, Visible}` 并由 `ref.APIError(err)` 给出对应的 4xx(本团队 NotFound vs 跨团队 Forbidden)。

### 5.4 网络/Secure 强约束

```go
// sandbox_create.go:251-255
if !sharedUtils.DerefOrDefault(network.Ingress.AllowPublicAccess, types.AllowPublicAccessDefault) && envdAccessToken == nil {
    a.sendAPIStoreError(c, http.StatusBadRequest,
        "You cannot create a sandbox without public access unless you enable secure envd access via 'secure' flag.")
    return
}
```

设计意图:**私有 sandbox 必须开启 secure envd**——否则用户会创建出"看起来私有但其实任何人都能从 sandbox 内部拿到入口"的实例。这是把 "secure by default" 编码进 API 校验。

### 5.5 鉴权 / 配额信号

- 团队信息从 gin context 取,**所有 sandbox 端点都假定已经过 auth middleware**。
- `teamInfo.Limits.MaxLengthHours` 是团队级硬上限,被 `timeout` 校验消费。

---

## 六、生命周期端点(Pause / Resume / Refresh / Timeout / Connect)

### 6.1 Pause:`POST /sandboxes/{id}/pause`(`sandbox_pause.go`)

**特殊点 1**:请求体是可选的。`ginutils.ParseOptionalBody` 容忍空 body 与 chunked 传输(`Content-Length: -1`):

```go
// sandbox_pause.go:50-56
body, bindErr := ginutils.ParseOptionalBody[api.PostSandboxesSandboxIDPauseJSONRequestBody](ctx, c)
...
filesystemOnly := body.Memory != nil && !*body.Memory
```

**特殊点 2**:有完整的审计日志,通过 `pause.LogInitiated/LogSuccess/LogSkipped/LogFailure`。`SkipReason` 区分 `AlreadyPaused`、`NotFound`。

**特殊点 3**:四种结果分支(对应 `RemoveSandbox` 的返回值):

| `RemoveSandbox` 结果 | HTTP | 日志 |
|---|---|---|
| `nil` | 204 | `LogSuccess` |
| `ErrSandboxNotFound` | 委托给 `pauseHandleNotRunningSandbox`(返回 404 或 409) | `LogSkipped(AlreadyPaused)` 或 `LogSkipped(NotFound)` |
| `*InvalidStateTransitionError` | 409(说明当前状态不允许) | `LogFailure` |
| 其他 | 500 | `LogFailure` + `telemetry.ReportError` |

`pauseHandleNotRunningSandbox`(`sandbox_pause.go:96-132`)的实现:查 `snapshotCache.Get(sandboxID)`,命中且 teamID 匹配 → 409 already-paused;否则 NotFound/500。**这里有一个 TODO(`ENG-3544`)**:`snapshotCache.Get` 没按 teamID 过滤,只能在拿到 snapshot 后做后置归属校验。

### 6.2 Resume:`POST /sandboxes/{id}/resume`(`sandbox_resume.go`)

不同于 Pause 的"传入 Action 让 orchestrator 决定",Resume 是 **客户端驱动** 的——它的本质是「用同一个 sandboxID 走 startSandbox」。

完整状态机:

```
GetSandbox(teamID, sandboxID)
├─ err == nil (running)
│   ├─ TeamID 不匹配 → 404
│   ├─ StatePausing     → WaitForStateChange(等它变 Paused 完毕) → 落到 fallback
│   ├─ StateKilling     → 404
│   ├─ StateSnapshotting → 409
│   ├─ StateRunning     → 409 "already running"
│   └─ default          → 500 "unknown state"
└─ err != nil (不在 orchestrator)
    ↓
snapshotCache.Get(sandboxID)
├─ 命中 + teamID 匹配 → startSandbox(isResume=true, buildResumeSandboxData(...))
├─ ErrSnapshotNotFound → 404
└─ 其他 → 500
```

`buildResumeSandboxData`(`sandbox_resume.go:192-258`)返回一个 `SandboxDataFetcher` 闭包,这个闭包 **在 sandbox 锁内** 被调用——确保读取 snapshot 数据时不被并发修改打断。它还做了:

- 继承 `snap.Config.Network` / `AutoResume` / `VolumeMounts` / `AutoPauseFilesystemOnly`(注意:**filesystemOnly 不能在 resume 时被 override**,注释见 :230-233)
- `autoPauseOverride` 允许覆盖 `snap.AutoPause`
- 若 `snap.EnvSecure` 为真,重新生成 envd access token
- 设置 `NodeID = snap.OriginNodeID`(亲和性:倾向于原节点)

### 6.3 Connect:`POST /sandboxes/{id}/connect`(`sandbox_connect.go`)

Connect 是 Resume 的"懒人版":**先尝试 KeepAlive,失败再恢复**。

```
for attempt := range maxConnectRetries {  // = 3
    sbx, apiErr := orchestrator.KeepAliveFor(teamID, sandboxID, timeout, /*extend=*/ false)
    ├─ apiErr.Err == sandbox.ErrNotFound → break (走快照恢复)
    ├─ apiErr.Err 不是 *NotRunningError → 透传错误
    └─ NotRunningError.State == StateKilling → 409 "changing state"
       否则 WaitForStateChange 后重试
}
↓ (break 后)
snapshotCache.Get(sandboxID) → 走 startSandbox(isResume=true) 同 resume 流程
```

**Connect 与 Resume 的关键区别**:

| 维度 | `resume` | `connect` |
|---|---|---|
| 调用 `KeepAliveFor` | 否 | **是**(默认路径) |
| 主要意图 | "我要让它跑起来" | "用法像 KeepAlive,实在不行就帮我恢复" |
| 重试 | 不重试 | 最多 3 次等待状态变化 |
| Filesystem-only snapshot | 走通用 resume 路径(`buildResumeSandboxData` 读 `snap.Config.AutoPauseFilesystemOnly`) | 走通用 resume 路径(同上) |

`sandbox_connect.go:141-146` 有一段重要注释:filesystem-only snapshot 通过 **cold boot from rootfs** 恢复(reboot 而非 memory-resume),orchestrator 根据 snapshot 元数据自动选择。**`connect` 是允许 filesystem-only 恢复的入口**——而 `autoResume`(任意流量触发)拒绝它。

### 6.4 Refresh / Timeout

两者都通过 `orchestrator.KeepAliveFor` 实现(`keep_alive.go:19`),差别在第五个参数 `allowShorter`(签名:`KeepAliveFor(ctx, teamID, sandboxID, duration, allowShorter)`):

| 端点 | `allowShorter` | 含义 |
|---|---|---|
| `POST /refreshes` | **`false`** | 只许延长:若新 endTime 比当前 `sbx.EndTime` 早,直接 return 不修改(代码:`if !allowShorter && endTime.Before(sbx.EndTime)`) |
| `POST /timeout` | **`true`** | 允许 endTime 任意变化(可缩短或延长);负数 timeout 在 `sandbox_timeout.go:46-50` 被归零(立即终止) |

`refreshes` 还有一条强制下限:若低于 `SandboxTimeoutDefault` 则被向上修正为默认值(`sandbox_refresh.go`)。

### 6.5 Kill:`DELETE /sandboxes/{sandboxID}`(`sandbox_kill.go`)

```go
err := a.orchestrator.RemoveSandbox(ctx, teamID, sandboxID, sandbox.RemoveOpts{
    Action: sandbox.StateActionKill,
    Reason: sandbox.KillReasonRequest,
})
```

实际逻辑是 **kill running + 删 snapshot 两步都尝试**,任一成功即返回 204:

| `RemoveSandbox` 结果 | 处理 |
|---|---|
| `nil` | `killedOrRemoved = true`,继续走 deleteSnapshot |
| `ErrSandboxNotFound` | 不算错误,继续走 deleteSnapshot |
| `ErrSandboxOperationFailed` 或其他 | 立即返回 500 |

接着 **无条件** 调用 `deleteSnapshot`(`sandbox_kill.go:21-37`):

- `deleteSnapshot` 通过 `throttledGetSnapshotBuilds`(由 `snapshotBuildQuerySem` 限流)拿到快照元数据
- 调 `softDeleteTemplate` 软删模板
- 失效 `templateCache` 与 `snapshotCache` 中相关条目

最终:`killedOrRemoved` 为 true → 204;否则(两个步骤都未找到)→ 404。

> 设计意图:DELETE 是 **彻底清除**——既要终止运行中的 vm,也要清理已 paused 的快照与派生模板。这是把"用户视角的删除"翻译成"系统视角的多处清理"。

---

## 七、查询端点(List / Get / Logs / Metrics)

### 7.1 列表:`GET /sandboxes` 与 `GET /v2/sandboxes`(`sandboxes_list.go`)

```go
// sandboxes_list.go:28-30
sandboxesDefaultLimit = int32(100)
sandboxesMaxLimit     = int32(100)
```

**v1(`GetSandboxes`,`:98`)**:简单——只取 `StateRunning` 的 sandbox,**不含 paused**,不做分页,直接返回排序后的列表。

**v2(`GetV2Sandboxes`,`:133`)**:三个核心差异:

1. **状态过滤**:`orchestrator.GetSandboxes` 同时取 `StateRunning` 与 `StatePausing`(`:182`),再在内存中分流;`StatePausing` 也对外以 `api.Paused` 暴露
2. **合并 paused**:`getPausedSandboxes` 通过 `throttledGetSnapshots` 拉 ClickHouse 中的快照,与运行中列表合并
3. **游标分页**:`utils.NewPagination` + `X-Total-Running` 响应头(只反映 Running 数量,在 cursor/limit 应用前设置,`:204`)

`throttledGetSnapshots`(`:362-369`)用 `a.sandboxListSem` 信号量限流,**原因是**:单个团队的快照可能很多,而 ClickHouse 查询是相对昂贵的下游操作——并发太多会拖慢整个集群。`sandboxListSem` 字段在 `APIStore` 上定义,所有 list 请求共享同一上限。

### 7.2 单个:`GET /sandboxes/{sandboxID}`(`sandbox_get.go`)

```
GetSandbox(teamID, sandboxID) (优先尝试运行中)
├─ 命中
│   ├─ TeamID 不匹配 → 404 (安全:不暴露他人 sandbox 存在性)
│   ├─ StatePausing → state = api.Paused,返回 200
│   ├─ StateKilling → 404
│   └─ 其他(StateRunning 等)→ state = api.Running,返回 200
└─ 未命中 → snapshotCache.Get(sandboxID)
    ├─ TeamID 不匹配 → 404
    ├─ 命中 + teamID 匹配 → 返回 paused sandbox(state = api.Paused)
    ├─ ErrSnapshotNotFound → 404
    └─ 其他错误 → 500
```

辅助函数 `sandboxLifecycleToAPI`(`sandbox_get.go:22-32`)、`dbNetworkConfigToAPI`(`:34-92`)负责内部模型 → OpenAPI 模型的转换。注意 `dbNetworkConfigToAPI` **故意不返回 egress proxy 的 password**(`:78` 注释),避免凭证经由 GET 泄漏。

### 7.3 日志:`GET /sandboxes/{id}/logs` 与 v2(`sandbox_logs.go`)

v1(`GetSandboxesSandboxIDLogs` :22)和 v2(`GetV2SandboxesSandboxIDLogs` :51)的差异:

- **v2 增加游标 + 方向参数**:可以向前/向后翻页
- 两者都用 `clusters.LogQueryWindow` 计算实际查询时间范围

转发路径:`clusters.Resources` 抽象,本地用 Loki,远端走边缘 HTTP 转发(见 `resources_remote.go`)。这部分细节在 `client-proxy-module.md` / `orchestrator-module.md` 里有更详细的讨论。

### 7.4 指标:`GET /sandboxes/{id}/metrics` 与批量(`sandbox_metrics.go`、`sandboxes_list_metrics.go`)

- 单个:`GetSandboxesSandboxIDMetrics`(`sandbox_metrics.go:16`)走 `clusters.Resources.GetSandboxMetrics`
- 批量:`getSandboxesMetrics`(`sandboxes_list_metrics.go:23-66`)遍历调用,**硬上限 `maxSandboxMetricsCount = 100`**(`:21`)

```go
// sandboxes_list_metrics.go:82-84
a.posthog.IdentifyAnalyticsTeam(ctx, team.ID.String(), team.Name)
properties := a.posthog.GetPackageToPosthogProperties(&c.Request.Header)
a.posthog.CreateAnalyticsTeamEvent(ctx, team.ID.String(), "listed running instances with metrics", properties)
```

批量端点会向 Posthog 上报 `listed running instances with metrics` 事件,用于观察实际使用模式。

指标语义、`CalculateStep` 步长算法等已在 `team-metrics-module.md` 详述,本文不重复。

---

## 八、网络与 Volume 配置

### 8.1 网络配置校验(`validateNetworkConfig` / `validateEgressRules` / `validateNetworkRules`)

`validateNetworkConfig`(`sandbox_create.go:629-670`)顺序:

1. `MaskRequestHost` 域名规范化(`idna.Display.ToASCII`),必须是 ASCII
2. `validateEgressRules`:
   - `denyOut` 每项必须是合法 IP/CIDR(不允许域名)
   - `allowOut` 解析为 `addresses + domains`(`sandbox_network.ParseAddressesAndDomains`)
   - **当 `allowOut` 包含域名时,`denyOut` 必须包含 `0.0.0.0/0`(即 `AllInternetTrafficCIDR`)**——否则报 `ErrMsgDomainsRequireBlockAll`(`:49`)
3. `validateNetworkRules`(对 domain→rules 映射):
   - feature flag `NetworkTransformRulesFlag` 检查
   - envd 版本 ≥ `0.5.13`
   - 全局上限 `maxNetworkRuleDomains = 10`
   - 每个 domain `maxNetworkRuleTransformsPerDomain = 1`
   - 每个 rule 最多 `maxNetworkRuleHeadersPerRule = 20` 个 header
   - header name/value 长度与字符集校验(`httpguts.ValidHeaderFieldName` / `ValidHeaderFieldValue`)

> 当 `allowOut` 含域名时,代码强制要求 `denyOut` 包含 `0.0.0.0/0`。这是 API 层的硬约束,代码本身没有说明原因——一个直观解释是:既然用户特意允许某些域名,就需要"封死其他出口"才能让白名单有意义;否则任何出站流量都通,allow 域名就没作用。但 **真正的执行顺序由 sandbox 内部的网络栈决定**,API 层只做前置校验。

### 8.2 网络更新:`PUT /sandboxes/{sandboxID}/network`(`sandbox_network_update.go`)

```go
// sandbox_network_update.go:21
func (a *APIStore) PutSandboxesSandboxIDNetwork(c *gin.Context, sandboxID string)
```

校验路径与创建时 **略有不同**:不调用 wrapper `validateNetworkConfig`(创建时用),而是 **直接调用两个子函数**:

1. `validateEgressRules(allowOut, denyOut)`——同样要求"含域名时必须 deny ALL_TRAFFIC"
2. 若 `body.Rules != nil`:`GetSandbox` 拿到 sandbox 信息 → 用其 `EnvdVersion` 调 `validateNetworkRules`(feature flag + 版本 + 数量限制)

接着 `apiRulesToDBRules` 转换 → `orchestrator.UpdateSandboxNetworkConfig` 下发到 sandbox 的 network namespace。

Egress proxy 走与创建时相同的 `BYOPProxyEnabledFlag` + `ValidateEgressProxy` 路径,但错误消息说 `egressProxy` 而非 `network.egressProxy`(更新场景下字段在顶层)。

若有 rules 更新,会上报 `"sandbox with network transform rules updated"` Posthog 事件(与创建时的 `"...created"` 对应)。

### 8.3 Volume 挂载(`convertAPIVolumesToOrchestratorVolumes`)

完整校验链(`sandbox_create.go:424-486`):

1. 数量为 0 → 直接返回空切片(注释:「only b/c you should never return (nil, nil)」)
2. `featureflags.PersistentVolumesFlag` 关闭 → `ErrVolumeMountsDisabled`
3. envd 版本 ≥ `0.5.14`,否则 `errVolumesNotSupported` 或 `errNoEnvdVersion`
4. `getDBVolumesMap`:按名字批量查 `sqlcDB.GetVolumesByName`(必须属于本团队)
5. 逐项校验:
   - `isValidMountPath`:绝对路径、Clean 后等价、不能含 `..`/`.`
   - 同路径不能重复使用
6. 任一无效 → `InvalidVolumeMountsError`(汇总所有错误,**不是 fail-fast**)

`InvalidVolumeMountsError.Error()` 的输出格式:

```
invalid mounts:
	- volume mount #0: volume 'foo' not found
	- volume mount #1: path must be absolute
```

设计意图:**让用户在一次请求里看到所有错误**,而不是改一个 retry 一个。

---

## 九、Admin 与 Snapshot 端点

### 9.1 Admin 批量 Kill:`POST /admin/teams/{teamID}/sandboxes/kill`(`admin_kill_team_sandboxes.go`)

```
1. InvalidateTeamCache(teamID)  ← 先失效 auth/team 缓存
2. GetSandboxes(teamID, [StateRunning])  ← 只杀 running
3. errgroup.SetLimit(10) 并发 RemoveSandbox(Action=Kill, Reason=KillReasonAdmin)
4. 等待所有完成,统计 killed/failed
5. InvalidateTeamCache(teamID)  ← 再失效一次
6. 返回 AdminSandboxKillResult{KilledCount, FailedCount}
```

**关于两次 `InvalidateTeamCache`**:这是 `authService` 上的方法(见 `auth-module.md`),它失效的是 **auth 团队缓存**——即 `teamID → team 数据` 和 `哈希 API key → team 数据` 这两类映射。它 **不影响** sandbox 列表本身(sandbox 列表是直接查 orchestrator + ClickHouse 的)。

两次调用的意图:
- **第一次**(before GetSandboxes):防御性。Admin kill 通常发生在团队被禁用、欠费、安全事件等场景——确保后续操作拿到的团队状态是最新的(防止缓存里残留"团队仍可用",使后续步骤判断错误)
- **第二次**(after 所有 kill 完成):让该团队的客户端在下一次请求时强制走 DB 重新校验团队状态。如果 admin kill 伴随着团队状态变更(如 banned),客户端的 API key 会在下一次请求时被拒绝

并发上限 10(`errgroup.SetLimit(10)`)是为了避免一次性把 orchestrator 打爆——一个团队可能同时有几百个 sandbox。

### 9.2 从 Sandbox 创建快照模板:`POST /sandboxes/{sandboxID}/snapshots`(`snapshot_template_create.go`)

```
1. 解析 teamInfo, sandboxID规整化
2. ParseBody[PostSandboxesSandboxIDSnapshotsJSONRequestBody]
3. body.Name(可选)解析:
   - id.ParseName → identifier + tag
   - ValidateNamespaceMatchesTeam(identifier, teamInfo.Slug)
   - templateCache.ResolveAlias → 若已有同团队别名,复用 templateID
4. GetSandbox(teamID, sandboxID) 验证存在
5. CheckEnvdVersionForSnapshot(sbx.EnvdVersion) ← 版本检查
6. CreateSnapshotTemplate(teamID, sandboxID, opts)
   - ErrNotFound → 404
   - *InvalidStateTransitionError → 409 (不能在 X 状态下快照)
7. templateCache.InvalidateAlias + Invalidate (失效缓存)
8. 返回 SnapshotInfo{SnapshotID, Names} (201)
```

此端点是「从运行中 sandbox 派生新模板」的入口,通常配合 CI/CD 或调试工作流使用。它返回的 `SnapshotID` 可以直接用作后续 `POST /sandboxes` 的 `templateID`。

---

## 十、关键流程时序图

### 10.1 创建 sandbox(简化)

```
Client          APIStore           templateCache      orchestrator        DB
  │                │                    │                  │              │
  │ POST /sandboxes│                    │                  │              │
  │───────────────>│                    │                  │              │
  │                │ ParseBody          │                  │              │
  │                │ id.ParseName       │                  │              │
  │                │ ResolveAlias───────>                  │              │
  │                │<───────────────────                    │              │
  │                │ Get───────────────                     │              │
  │                │<────────────── env,build               │              │
  │                │ 校验 autoPause/secure/network/volumes  │              │
  │                │ startSandbox                                               │
  │                │ CreateSandbox──────────────────────────>              │
  │                │                                  gRPC→Nomad: launch VM│
  │                │<────────────────── sbx                                  │
  │                │ 落盘 sandbox 行(状态=Running)─────────────────────────>│
  │ 201 + Sandbox  │                                                            │
  │<───────────────│                                                            │
```

### 10.2 Resume 冷启动(已 paused)

```
Client            APIStore            snapshotCache       orchestrator
  │                  │                     │                    │
  │ POST /resume     │                     │                    │
  │─────────────────>│                     │                    │
  │                  │ GetSandbox───────────────────────────────>│
  │                  │<───────────────── ErrNotFound             │
  │                  │ Get(sandboxID)───────>                    │
  │                  │<──────────────── snap+build               │
  │                  │ 校验 TeamID 匹配                          │
  │                  │ startSandbox(isResume=true,                │
  │                  │   buildResumeSandboxData)                  │
  │                  │   ↑ 闭包在 sandbox 锁内读取 snap            │
  │                  │ CreateSandbox(isResume=true)──────────────>│
  │                  │                                  cold-boot │
  │                  │<────────────────── sbx                    │
  │ 201 + Sandbox    │                                            │
  │<─────────────────│                                            │
```

### 10.3 Connect 的双路径

```
                    ┌── KeepAliveFor 成功 ── 返回 200 + Sandbox
PostSandboxesSandboxIDConnect
                    └── KeepAliveFor 返回 ErrNotFound
                          ↓
                        重试循环 (max 3, WaitForStateChange)
                          ↓ 仍失败
                        snapshotCache.Get → startSandbox(isResume=true)
                          ↓
                        返回 201 + Sandbox
```

### 10.4 Admin 批量 Kill

```
AdminClient   APIStore                      orchestrator
  │             │                              │
  │ POST        │                              │
  │ /admin/...  │                              │
  │────────────>│                              │
  │             │ InvalidateTeamCache           │
  │             │ GetSandboxes(teamID, Running) │
  │             │──────────────────────────────>│
  │             │<──────────────────────── list│
  │             │ errgroup.SetLimit(10)         │
  │             │ for each sbx:                 │
  │             │   RemoveSandbox(Kill, Admin)─>│
  │             │ <等待>                        │
  │             │ InvalidateTeamCache           │
  │ 200 + counts│                              │
  │<────────────│                              │
```

---

## 十一、配置与 Feature Flag

### 11.1 行为常量(`sandbox_create.go:43-57`)

| 常量 | 值 | 用途 |
|---|---|---|
| `InstanceIDPrefix` | `"i"` | sandbox ID 前缀 |
| `minEnvdVersionForSecureFlag` | `"0.2.0"` | secure 模式最低 envd 版本 |
| `maxNetworkRuleDomains` | `10` | 每个 sandbox 网络规则域名总数上限 |
| `maxNetworkRuleTransformsPerDomain` | `1` | 每域名 transform 上限 |
| `maxNetworkRuleDomainLen` | `128` | 域名长度上限 |
| `maxNetworkRuleHeaderNameLen` | `64` | header 名长度上限 |
| `maxNetworkRuleHeaderValueLen` | `2048` | header 值长度上限 |
| `maxNetworkRuleHeadersPerRule` | `20` | 每条规则 header 上限 |

### 11.2 跨文件常量

| 常量 | 位置 | 值 |
|---|---|---|
| `SandboxTimeoutDefault` | `sandboxtypes/states.go:90` | `15 * time.Second` |
| `AutoPauseDefault` | `sandboxtypes/states.go:92` | `false` |
| `sandboxesDefaultLimit` / `sandboxesMaxLimit` | `sandboxes_list.go:28-30` | `100` / `100` |
| `maxConnectRetries` | `sandbox_connect.go:64` | `3` |
| `maxSandboxMetricsCount` | `sandboxes_list_metrics.go:21` | `100` |
| `minEnvdVersionForNetworkRules` | `sandbox_create.go:399` | `"0.5.13"` |
| `minEnvdVersionForVolumes` | `sandbox_create.go:401` | `"0.5.14"` |

### 11.3 Feature Flag

| Flag | 控制 | 默认影响 |
|---|---|---|
| `NetworkTransformRulesFlag` | 网络转换规则(`network.rules`)可用性 | 关闭时该功能 400 拒绝 |
| `PersistentVolumesFlag` | Volume 挂载(`volumeMounts`)可用性 | 关闭时 400 拒绝 |
| `BYOPProxyEnabledFlag` | `network.egressProxy` 可用性 | 关闭时 403 拒绝 |
| `MinAutoResumeTimeoutSeconds` | `autoResume.Timeout` 的最小值 | 数值类型,被 `IntFlag` 读取 |

---

## 十二、关键代码文件索引

| 文件 | 主要导出 | 说明 |
|---|---|---|
| `packages/api/internal/handlers/sandbox_create.go` | `PostSandboxes`、`validateNetworkConfig`、`validateEgressRules`、`validateNetworkRules`、`convertAPIVolumesToOrchestratorVolumes`、`checkEnvdVersionRequirement`、`getEnvdAccessToken`、`buildAutoResumeConfig` | 创建 sandbox 与全部校验逻辑(843 行,本模块最大文件) |
| `packages/api/internal/handlers/sandbox.go` | `startSandbox`、`startSandboxInternal`、`buildCreationMetadata` | 共用的启动入口 |
| `packages/api/internal/handlers/sandbox_get.go` | `GetSandboxesSandboxID`、`sandboxLifecycleToAPI`、`dbNetworkConfigToAPI` | 单个查询与状态映射 |
| `packages/api/internal/handlers/sandbox_kill.go` | `DeleteSandboxesSandboxID`、`deleteSnapshot` | Kill |
| `packages/api/internal/handlers/sandbox_pause.go` | `PostSandboxesSandboxIDPause`、`pauseHandleNotRunningSandbox` | Pause + 审计日志 |
| `packages/api/internal/handlers/sandbox_resume.go` | `PostSandboxesSandboxIDResume`、`buildResumeSandboxData`、`convertDatabaseMountsToOrchestratorMounts` | Resume |
| `packages/api/internal/handlers/sandbox_connect.go` | `PostSandboxesSandboxIDConnect` | Connect 双路径 |
| `packages/api/internal/handlers/sandbox_refresh.go` | `PostSandboxesSandboxIDRefreshes` | Refresh |
| `packages/api/internal/handlers/sandbox_timeout.go` | `PostSandboxesSandboxIDTimeout` | Timeout 修改 |
| `packages/api/internal/handlers/sandbox_network_update.go` | `PutSandboxesSandboxIDNetwork` | 运行时网络更新 |
| `packages/api/internal/handlers/sandbox_logs.go` | `GetSandboxesSandboxIDLogs`、`GetV2SandboxesSandboxIDLogs` | 日志查询 |
| `packages/api/internal/handlers/sandbox_metrics.go` | `GetSandboxesSandboxIDMetrics` | 单 sandbox 指标 |
| `packages/api/internal/handlers/sandboxes_list.go` | `GetSandboxes`、`GetV2Sandboxes`、`getPausedSandboxes`、`snapshotsToPaginatedSandboxes` | 列表 |
| `packages/api/internal/handlers/sandboxes_list_metrics.go` | `GetSandboxesMetrics`、`getSandboxesMetrics` | 批量指标 |
| `packages/api/internal/handlers/snapshot_template_create.go` | `PostSandboxesSandboxIDSnapshots` | 从 sandbox 派生模板 |
| `packages/api/internal/handlers/admin_kill_team_sandboxes.go` | `PostAdminTeamsTeamIDSandboxesKill` | Admin 批量 kill |
| `packages/api/internal/sandbox/sandboxtypes/states.go` | `SandboxTimeoutDefault`、`AutoPauseDefault`、状态枚举 | 常量 |
| `packages/api/internal/utils/messages.go` | `SandboxNotFoundMsg`、`SandboxChangingStateMsg` | 错误消息模板 |
| `spec/openapi.yml` | 路径 `/sandboxes*`、`/v2/sandboxes*`、`/admin/teams/{teamID}/sandboxes/kill` | OpenAPI 规范 |

---

## 十三、设计要点与权衡

### 13.1「Optional Body」与 chunked 请求

`sandbox_pause.go` 用 `ginutils.ParseOptionalBody` 而非 `c.ShouldBindJSON`,因为旧客户端发 pause 时不带 body。`oapi-codegen` 生成的 `*JSONRequestBody` 强类型在此与「宽容空 body」组合得很好——但代价是 **OpenAPI spec 必须把 body 标为可选**(`PostSandboxesSandboxIDPauseJSONRequestBody` 全部字段都是 pointer)。如果未来要新增必填字段,需要同时:
- 修改 OpenAPI spec 让字段 required
- 改用 `ParseBody`(强制存在)
- 处理客户端兼容性

### 13.2「闭包内查数据」避免 TOCTOU

`buildResumeSandboxData` 返回 `SandboxDataFetcher`,**这个闭包在 sandbox 锁内被调用**(`sandbox_resume.go:192-258`)。如果直接在 handler 里查 `snapshotCache.Get` 然后把结果传进去,会引入 TOCTOU 窗口:在「查询」与「锁内启动」之间,snapshot 可能被并发的 kill 或新 pause 修改。把读取放进锁内是更安全的设计。

### 13.3「软私有 sandbox」的强约束

`network.Ingress.AllowPublicAccess == false → 必须 secure envd`(`sandbox_create.go:251-255`)是个**前端不显式表达、但 API 强制**的约束。设计哲学是:**安全配置不能被"忘掉"**。如果用户想"私有"又不开启 secure,等于让 sandbox 内部进程可以从外部随意访问——这违背了"私有"的语义。

### 13.4「错误聚合」而非 fail-fast

`convertAPIVolumesToOrchestratorVolumes` 在循环中收集所有 invalid mount,最后一次返回。这与「域名规则校验」(`validateNetworkRules`)的 fail-fast 风格形成对比。原因可能是:
- Volume 错误是 **本地配置错误**(用户视角,可一次性修)
- 网络规则错误更复杂,后续校验依赖前置(比如 envd 版本)

### 13.5 v1 / v2 共存

`GET /sandboxes` 与 `GET /v2/sandboxes`、`GET /logs` 与 `GET /v2/logs` 都同时存在。v2 引入游标分页与 paused 状态合并,v1 仍保留——典型原因是已有 SDK 与客户端依赖 v1 行为(简单列表,无分页)。这是常见的 **API 演进策略**:新功能在 v2,v1 进入维护模式,等客户端迁移完毕后再废弃。

### 13.6 Admin 端点的双缓存失效

`PostAdminTeamsTeamIDSandboxesKill` 在操作前后各调一次 `InvalidateTeamCache`(`admin_kill_team_sandboxes.go:22, 84`)。注意这里失效的是 **auth/team 缓存**(`teamID → 团队数据`、`哈希 API key → 团队数据`),不是 sandbox 列表缓存。两次调用的目的都是 **强制下一次客户端请求重新走 DB 校验团队状态**——典型的 admin 触发场景是团队被禁用/欠费,需要让客户端的后续请求立即看到状态变化,而不是继续吃缓存里"团队仍可用"的旧值。

### 13.7 Posthog 上报位点

代码中至少有这些 Posthog 事件埋点:

| 事件名 | 触发位点 | 用途 |
|---|---|---|
| `listed sandboxes` | `GetSandboxes` / `GetV2Sandboxes` | 列表请求的产品使用统计 |
| `listed running instances with metrics` | `GetSandboxesMetrics` | 批量指标查询的使用情况 |
| `sandbox with network transform rules created` | `PostSandboxes`(仅当 `network.rules` 非空) | 高级功能采用度 |
| `sandbox with network transform rules updated` | `PutSandboxesSandboxIDNetwork`(仅当 rules 非空) | 同上,运行时变更 |

埋点选择反映 **产品决策需要**:列表与高级功能采用度是产品分析关注点,而单个 sandbox 的 CRUD 不上报(频次高、信号低)。这不是单纯的"成本权衡",而是 **信号/噪声比** 的考虑。

---

## 十四、常见问题与排查

### Q1:`POST /sandboxes` 返回 400 `autoPauseMemory=false only applies when autoPause is true`

`autoPauseMemory: false` 表示"timeout 时拍 filesystem-only 快照"。但 filesystem-only 快照只有在 `autoPause: true` 时才会发生——`autoPause: false` 时 timeout 直接 kill,根本不会拍快照,`autoPauseMemory` 字段毫无意义。**修复**:同时设置 `autoPause: true`。

### Q2:`POST /sandboxes` 返回 400 `... cannot be auto-resumed by traffic`

`autoPauseMemory: false` 产生的是 filesystem-only 快照,**没有内存状态**,无法被 traffic 自动恢复(必须有客户端主动 connect)。所以 `autoResume.enabled: true` 与 `autoPauseMemory: false` 互斥。**修复**:要么改 `autoPauseMemory: true`,要么去掉 `autoResume`。

### Q3:`POST /sandboxes` 返回 400 `When specifying allowed domains in allow out, you must include 'ALL_TRAFFIC' in deny out to block all other traffic.`

当 `allowOut` 含域名时,API 强制要求 `denyOut` 包含 `0.0.0.0/0`(常量 `sandbox_network.AllInternetTrafficCIDR`,等价字面量 `"ALL_TRAFFIC"`)。这条规则在 `sandbox_create.go:699-707` 校验;`Err` 字段是 `"allow out contains domains but deny out is missing 0.0.0.0/0 (ALL_TRAFFIC)"`(仅日志可见),返回给客户端的 `ClientMsg` 是上面那段更友好的版本。直观理解是:**如果不同时封死其他出口,允许域名就没有意义**——出站流量会从其他路径流出,allow 名单形同虚设。**修复**:`network.denyOut` 加上 `"0.0.0.0/0"` 或 `"ALL_TRAFFIC"`。

### Q4:`POST /sandboxes/{id}/pause` 返回 409 already-paused

这意味着 sandbox 已经 **完全 paused**:它已离开 orchestrator 内存(`RemoveSandbox` 返回 `ErrSandboxNotFound`),但 `snapshotCache.Get` 命中 ClickHouse 中的快照行,且 teamID 匹配。**处理**:幂等——把它当成功即可(状态符合预期)。

### Q5:`POST /sandboxes/{id}/resume` 返回 409 `Sandbox snapshot is currently being created`

Sandbox 处于 `StateSnapshotting`(正在生成快照模板)。这种状态下不能 resume,因为内存正在被外部进程读取。**处理**:等待几十秒后重试,或用 `connect` 替代(它的重试循环会等待状态变化)。

### Q6:`POST /sandboxes/{id}/connect` 返回 404

走完 3 次重试,`snapshotCache` 也没找到该 sandbox 的快照。原因可能是:sandbox 从未暂停过(纯运行实例被 kill)、或 teamID 不匹配(他人 sandbox)。**排查**:核对 sandboxID 与团队,检查 ClickHouse `snapshots` 表是否真有该行。

### Q7:`PUT /sandboxes/{id}/network` 返回 400 `Network transform rules are not available for your team`

团队未启用 `NetworkTransformRulesFlag`。**处理**:联系平台方开通,或在创建时不带 `network.rules`。

### Q8:`POST /sandboxes` 返回 400 `Volume mounts are not enabled`

`featureflags.PersistentVolumesFlag` 在该团队关闭。注意:`ErrVolumeMountsDisabled` 与 `errVolumesNotSupported`(envd 版本太低)是不同的错误——前者是团队开关,后者是 build 版本。

### Q9:`GET /v2/sandboxes` 返回的 `X-Total-Running` 头不准确

这个头只反映 **当前运行中** sandbox 的总数(`GetSandboxes(... Running)`),不含已暂停的。如果客户端期望"含 paused",需要把暂停列表也拉一次相加。

### Q10:Admin kill 返回 `failed: N>0`

并发上限 10 内的某些 `RemoveSandbox` 调用失败。日志里会有 `Failed to kill sandbox` 项,带 `sandboxID` 与 `kill_reason=admin`。常见原因:orchestrator 节点临时不可达、或 sandbox 在请求过程中刚好自然终止。**处理**:重试,或忽略——失败的多半是已经死掉的实例。

### Q11:`POST /sandboxes/{id}/snapshots` 返回 404

`GetSandbox(teamID, sandboxID)` 找不到运行中实例。此端点 **只对运行中 sandbox 生效**——它依赖运行中 vm 的内存与磁盘状态来派生新模板。paused sandbox 已经是快照,要派生模板需要先 resume。**处理**:先 `POST /resume` 让 sandbox 跑起来,再调 snapshots。

### Q12:发送不带 `i` 前缀的 sandboxID 会怎样?

`InstanceIDPrefix = "i"`,完整 sandboxID 形如 `i<随机串>`。若客户端只发送 `<随机串>`(漏掉 `i`):

- `utils.ShortID` 的 regex `^[a-z0-9]+$` **不会拒绝**——任何小写字母数字串都通过
- 但 orchestrator 与 `snapshotCache` 用 **完整带前缀的 ID** 作为键,所以查找会失败,返回 404

**结论**:服务端不主动补全前缀,客户端必须使用完整形式。

---

## 附录 A:端点速查表

| 方法 | 路径 | 请求体 | 成功响应 | 关键参数 |
|---|---|---|---|---|
| POST | `/sandboxes` | `PostSandboxesJSONRequestBody` | 201 `Sandbox` | `templateID`、`timeout`、`autoPause`、`network`、`secure` |
| GET | `/sandboxes` | — | 200 `[]Sandbox` | `pagination`、`status` |
| GET | `/v2/sandboxes` | — | 200 + `X-Total-Running` | `cursor`、`limit` |
| GET | `/sandboxes/{sandboxID}` | — | 200 `Sandbox` | — |
| DELETE | `/sandboxes/{sandboxID}` | — | 204 | — |
| POST | `/sandboxes/{sandboxID}/pause` | optional(`memory`) | 204 | — |
| POST | `/sandboxes/{sandboxID}/resume` | `PostSandboxesSandboxIDResumeJSONRequestBody` | 201 `Sandbox` | `timeout`、`autoPause` override |
| POST | `/sandboxes/{sandboxID}/connect` | `PostSandboxesSandboxIDConnectJSONRequestBody` | 200/201 `Sandbox` | `timeout` |
| POST | `/sandboxes/{sandboxID}/refreshes` | — | 204 | — |
| POST | `/sandboxes/{sandboxID}/timeout` | `PostSandboxesSandboxIDTimeoutJSONRequestBody` | 204 | `timeout`(秒) |
| PUT | `/sandboxes/{sandboxID}/network` | `PutSandboxesSandboxIDNetworkJSONRequestBody` | 204 | — |
| GET | `/sandboxes/{sandboxID}/logs` | — | 200 stream/json | `limit`、`start`、`end` |
| GET | `/v2/sandboxes/{sandboxID}/logs` | — | 200 + cursor | `cursor`、`direction` |
| GET | `/sandboxes/{sandboxID}/metrics` | — | 200 `[]SandboxMetric` | `start`、`end` |
| GET | `/sandboxes/metrics` | — | 200 `[]SandboxMetric` | `sandboxIDs[]`、`start`、`end`(最多 100 个 ID) |
| POST | `/sandboxes/{sandboxID}/snapshots` | `PostSandboxesSandboxIDSnapshotsJSONRequestBody` | 201 `SnapshotInfo` | `name`(可选) |
| POST | `/admin/teams/{teamID}/sandboxes/kill` | — | 200 `AdminSandboxKillResult` | — |

---

## 附录 B:错误码与 HTTP 状态映射

| HTTP | 触发场景 | 典型消息 |
|---|---|---|
| 400 | 请求体无法解析 / 模板引用非法 / 校验失败 | `Error when parsing request: ...`、`Invalid template reference` |
| 400 | `autoPauseMemory=false && !autoPause` | `autoPauseMemory=false only applies when autoPause is true.` |
| 400 | filesystem-only + autoResume 冲突 | `... cannot be auto-resumed by traffic ...` |
| 400 | 网络规则违反 | `When specifying allowed domains in allow out, you must include 'ALL_TRAFFIC' in deny out to block all other traffic.`、`Rule domain "..." is not a valid domain name` |
| 400 | envd 版本过低 | `... template must be rebuilt. Template envd version is X, must be at least Y` |
| 400 | timeout 超限 | `Timeout cannot be greater than N hours` |
| 400 | 无效 sandboxID | `Invalid sandbox ID` |
| 400 | Volume 错误 | `volume mounts are not enabled`、`volume 'foo' not found`、`path must be absolute` |
| 401 | auth 缺失/失败 | (由 auth middleware 返回) |
| 403 | BYOPProxy 未启用 | `Egress proxy (network.egressProxy) is not enabled for this team.` |
| 403 | team 不允许 transform rules | `Network transform rules are not available for your team.` |
| 404 | sandbox/快照不存在或 team 不匹配 | `The sandbox was not found. Please ensure the sandbox ID is correct.`(`SandboxNotFoundMsg`) |
| 409 | 状态转换非法 | `Sandbox 'X' cannot be paused while in 'Y' state`(`InvalidStateTransitionError`)、`already paused`、`already running` |
| 500 | orchestrator 不可达 / 内部错误 | `Error pausing sandbox`、`Error when getting snapshot` |
| 502/504 | 上游(Loki/边缘集群)超时 | (透传) |

---

## 附录 C:术语表

| 术语 | 含义 |
|---|---|
| **Sandbox** | 一个 Firecracker microVM 实例,E2B 的核心资源 |
| **Template** | sandbox 的"镜像"(rootfs + kernel + firecracker 版本),由 build 派生 |
| **Build** | 模板的一次构建产物,带 envd 版本与各类元数据 |
| **Snapshot** | sandbox 的某个时间点的可恢复状态(内存态或文件系统态) |
| **Memory snapshot** | 含内存的快照,可热恢复(restore) |
| **Filesystem-only snapshot** | 仅文件系统的快照,只能 cold boot(reboot) |
| **envd** | sandbox 内运行的守护进程(Connect RPC),负责进程/文件管理 |
| **autoPause** | timeout 到期时是否生成快照而非 kill |
| **autoResume** | 流量到达时是否自动恢复已 paused 的 sandbox |
| **KeepAliveFor** | orchestrator 提供的"延长/刷新 sandbox 生命"的接口,有 `extend` 参数区分两种语义 |
| **StateRunning / Pausing / Killing / Snapshotting** | sandbox 在 orchestrator 内存索引中的状态 |
| **Paused** | sandbox 不在 orchestrator,但 ClickHouse 有 snapshot 行 |
| **Cold boot** | 从 rootfs 重新启动 sandbox(filesystem-only 快照的恢复路径) |
| **Memory resume** | 从 memory snapshot 直接恢复 RAM(快但要求 hypervisor 配合) |
| **Transform rule** | 按 domain 重写 HTTP header 的网络规则(请求路由前置转换) |
| **Egress proxy (BYOP)** | sandbox 出站流量经过用户自建代理 |
| **Secure envd** | sandbox 内 envd 强制要求 access token,屏蔽匿名访问 |
| **CLI / SDK** | 调用这些 API 的客户端层 |
| **Edge cluster** | 区域性集群(client-proxy 路由目标),与控制面集群对应 |
