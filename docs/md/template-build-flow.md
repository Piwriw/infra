# 模板构建流程(Template Build Flow)

> 范围:从用户发起 `POST /v3/templates` 到 orchestrator 上 Firecracker rootfs 落盘、再到 CLI 拉取构建日志的端到端流程。涉及 `packages/api/internal/handlers/template_*.go`、`packages/api/internal/template/register_build.go`、`packages/api/internal/template-manager/`、`packages/db/queries/builds/*.sql`、`packages/shared/pkg/grpc/template-manager/` 与 `packages/shared/pkg/templates/versions.go`。
>
> 本文聚焦「请求 → 注册 → 触发 → 同步状态 → 终态」这一条主链路。模板表/别名的 schema、缓存策略、orchestrator 内部 rootfs 构建细节分别见 `database-schema.md`、`template-module.md`、`template-cache-module.md`(待写)与 `orchestrator-module.md`。

## 目录

- [一、概述](#一概述)
- [二、构建状态机](#二构建状态机)
- [三、API 端点全景](#三api-端点全景)
- [四、v1/v2/v3 演变与弃用时间线](#四v1v2v3-演变与弃用时间线)
- [五、`RegisterBuild`:只落库的「注册」阶段](#五registerbuild只落库的注册阶段)
- [六、`PostV3Templates`:两阶段构建的入口](#六postv3templates两阶段构建的入口)
- [七、`PostV2TemplatesTemplateIDBuildsBuildID`:真正触发构建](#七postv2templatestemplateidbuildsbuildid真正触发构建)
- [八、`TemplateManager`:CP 侧的 gRPC 编排器](#八templatemanagercp-侧的-grpc-编排器)
- [九、`CreateTemplate`:一次 gRPC 调用 + 状态推进](#九createtemplate一次-grpc-调用--状态推进)
- [十、后台状态同步:`BuildStatusSync` 与定时巡检](#十后台状态同步buildstatussync-与定时巡检)
- [十一、并发构建控制:`CheckAndCancelConcurrentBuilds`](#十一并发构建控制checkandcancelconcurrentbuilds)
- [十二、构建状态与日志查询](#十二构建状态与日志查询)
- [十三、别名 / 标签 / 命名空间解析](#十三别名--标签--命名空间解析)
- [十四、SDK 版本检测与模板版本选择](#十四sdk-版本检测与模板版本选择)
- [十五、管理员批量取消](#十五管理员批量取消)
- [十六、关键时序图](#十六关键时序图)
- [十七、配置项与 feature flags](#十七配置项与-feature-flags)
- [十八、关键代码文件索引](#十八关键代码文件索引)
- [十九、设计要点与权衡](#十九设计要点与权衡)
- [二十、常见问题与排查](#二十常见问题与排查)
- [附录 A:`env_builds` 状态映射](#附录-aenv_builds-状态映射)
- [附录 B:关键 SQL 查询](#附录-b关键-sql-查询)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

「模板构建」是 E2B 把用户提交的 Dockerfile / 镜像 / 模板引用,变成一个可启动的 Firecracker rootfs 快照的过程。整个流程横跨三个进程:

```
   SDK / CLI                    Control Plane API                  Orchestrator (template-manager)
  ─────────                    ──────────────────                  ───────────────────────────────
   POST /v3/templates  ─────►  PostV3Templates
                                └─► requestTemplateBuild
                                     └─► template.RegisterBuild      (仅 DB 写入,返回 buildID)
                                          │
   POST /v2/templates/{tid}/builds/{bid} ─►  PostV2TemplatesTemplateIDBuildsBuildID
                                              ├─► CheckAndCancelConcurrentBuilds
                                              ├─► GetAvailableBuildClient            ──┐
                                              ├─► UpdateTemplateBuild (写 ClusterNodeID)│
                                              └─► templateManager.CreateTemplate       │
                                                     └─► TemplateCreate (gRPC) ──────────┘
                                                                                          │
                                                          ┌───────────────────────────────┘
                                                          ▼
                                                  firecracker / nbd / rootfs
                                                          │
                                                          ▼
                                                  TemplateBuildStatusResponse (轮询)
                                                          │
   GET .../builds/{bid}/status  ─────►  GetTemplatesTemplateIDBuildsBuildIDStatus
   GET .../builds/{bid}/logs    ─────►  GetTemplatesTemplateIDBuildsBuildIDLogs
```

**三种「构建源」**(在 v2/v3 trigger 阶段区分):

| 源 | 字段 | 含义 |
|---|---|---|
| FromImage | `body.FromImage` | 从 Docker Hub / registry 拉一个公共/私有镜像作为 base |
| FromTemplate | `body.FromTemplate` | 从另一个已存在的模板(可跨 team,支持 promoted)派生 |
| Steps(隐式) | `body.Steps` | 与 FromImage/FromTemplate 配合,在 base 之上执行一系列 step(详见 OpenAPI `TemplateStep`)|

**三个进程各自的工作**:

| 进程 | 职责 |
|---|---|
| SDK / CLI | 选择 API 版本(v1/v2/v3)、传 dockerfile 或 fromImage、轮询 status、消费 logs |
| CP API | 鉴权 → 落库(`RegisterBuild`) → 选择 builder 节点 → gRPC 触发 → 后台轮询 → 暴露 status/logs HTTP |
| Orchestrator (`template-manager` gRPC 服务) | 拉/构建 rootfs、上传到 GCS、维护 build cache、回报状态 |

### 与其他文档的边界

| 主题 | 文档 |
|---|---|
| 模板表 schema、别名、公共/私有 | `database-schema.md`、`template-module.md` |
| 模板缓存(读路径) | `template-cache-module.md`(待写) |
| 多集群路由与 builder 节点选择 | `clusters-module.md` |
| Orchestrator 内部 rootfs 构建 | `orchestrator-module.md` |
| **端到端构建流程** | **本文** |

---

## 二、构建状态机

构建状态在数据库中由两列承载:``env_builds.status``(原始写入值)与 `status_group`(计算列,用于读端比较)。完整定义在 `packages/db/pkg/types/types.go:141-168`:

```go
type BuildStatus string
const (
    BuildStatusPending      BuildStatus = "pending"
    BuildStatusWaiting      BuildStatus = "waiting"
    BuildStatusBuilding     BuildStatus = "building"
    BuildStatusSnapshotting BuildStatus = "snapshotting"
    BuildStatusUploaded     BuildStatus = "uploaded"
    BuildStatusSuccess      BuildStatus = "success"
    BuildStatusFailed       BuildStatus = "failed"
)

type BuildStatusGroup string
const (
    BuildStatusGroupPending    BuildStatusGroup = "pending"
    BuildStatusGroupInProgress BuildStatusGroup = "in_progress"
    BuildStatusGroupReady      BuildStatusGroup = "ready"
    BuildStatusGroupFailed     BuildStatusGroup = "failed"
)
```

### 状态流转图

```
                          ┌──────────────────────┐
   CreateTemplateBuild    │                      │
   (DB INSERT)            │   waiting (pending)  │  ←── RegisterBuild 创建的初值
                         ─►│  status_group =     │
                          │  "pending"           │
                          └──────────┬───────────┘
                                     │
                       PostV2...Builds/BuildID 触发
                       (CreateTemplate 成功后)
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │   building           │
                          │  status_group =      │
                          │  "in_progress"       │
                          └──────────┬───────────┘
                                     │
                       BuildStatusSync 轮询 gRPC
                                     │
                ┌────────────────────┴────────────────────┐
                │                                         │
                ▼                                         ▼
        ┌──────────────┐                          ┌──────────────┐
        │  uploaded    │                          │   failed     │
        │ status_group │                          │ status_group │
        │  = "ready"   │                          │  = "failed"  │
        └──────────────┘                          └──────────────┘
        (SetFinished)                              (SetStatus Failed)
```

> **注:**数据库列同时存在 `pending` 和 `waiting` 两个原始值,前者来自新代码路径(注释在 `register_build.go:215` 的 `TODO(ENG-3469)`),后者是当前 `CreateTemplateBuild` 实际写入的值(`register_build.go:221`)。`status_group` 计算列把两者都归一到 `BuildStatusGroupPending`,因此读端只看 group,从不直接比较原始 status。

### 状态查询的 4 个出口(对应 OpenAPI)

| 出口 | 处理器 | 源 |
|---|---|---|
| CLI status 轮询 | `GetTemplatesTemplateIDBuildsBuildIDStatus`(`template_build_status.go:28-147`)| `templateBuildsCache` → DB |
| CLI logs 分页 | `GetTemplatesTemplateIDBuildsBuildIDLogs`(`template_build_logs.go:19-106`)| `cluster.GetResources().GetBuildLogs` |
| 后台同步 | `BuildStatusSync`(`template_status.go:24-83`)| gRPC `TemplateBuildStatus` |
| 定时巡检 | `BuildsStatusPeriodicalSync`(`template_manager.go:80-109`)| DB → gRPC |

### 状态映射 API ↔ DB

`getCorrespondingTemplateBuildStatus`(`template_build_status.go:149-164`)把 group 翻译成 OpenAPI 暴露给 CLI 的 `TemplateBuildStatus` 枚举(`api.gen.go:206-209`):

| `BuildStatusGroup`(DB) | `TemplateBuildStatus`(API) |
|---|---|
| `pending` | `waiting` |
| `in_progress` | `building` |
| `ready` | `ready` |
| `failed` | `error` |
| 其它(未知) | `building` + warn 日志 |

---

## 三、API 端点全景

OpenAPI 中与「模板构建」直接相关的端点(spec/openapi.yml):

| 路径 | 方法 | 处理器 | OpenAPI 行 |
|---|---|---|---|
| `/v3/templates` | POST | `PostV3Templates` | 2736 |
| `/v2/templates` | POST (deprecated) | `PostV2Templates`(`deprecated_template_request_build_v2.go`)| 2813 |
| `/templates` | POST (deprecated) | `PostTemplates`(`deprecated_template_request_build.go:25`)| 2882 |
| `/templates/{templateID}` | POST (deprecated) | `PostTemplatesTemplateID`(`deprecated_template_request_build.go:77`)| 2945 |
| `/templates/{templateID}/builds/{buildID}` | POST (deprecated) | `PostTemplatesTemplateIDBuildsBuildID`(`deprecated_template_start_build.go:79`)| 3050 |
| `/v2/templates/{templateID}/builds/{buildID}` | POST | `PostV2TemplatesTemplateIDBuildsBuildID`(`template_start_build_v2.go:40`)| 3071 |
| `/templates/{templateID}/builds/{buildID}/status` | GET | `GetTemplatesTemplateIDBuildsBuildIDStatus`(`template_build_status.go:28`)| 3133 |
| `/templates/{templateID}/builds/{buildID}/logs` | GET | `GetTemplatesTemplateIDBuildsBuildIDLogs`(`template_build_logs.go:19`)| 3183 |
| `/admin/teams/{teamID}/builds/cancel` | POST | `PostAdminTeamsTeamIDBuildsCancel`(`admin_cancel_team_builds.go:19`)| 3476 |

### 安全方案矩阵

不同端点接受的安全方案不同(v1 trigger 不接受 ApiKeyAuth,因为 v1 要求 access token 上传镜像):

| 端点 | 接受的 security scheme |
|---|---|
| `POST /v3/templates` | `ApiKeyAuth` / `AuthProviderBearerAuth + AuthProviderTeamAuth` / `AdminApiKeyAuth + AdminTeamAuth` |
| `POST /v2/templates/{tid}/builds/{bid}` | 同上 |
| `POST /templates/{tid}/builds/{bid}` (v1) | **`AccessTokenAuth` / `AuthProviderBearerAuth + AuthProviderTeamAuth`**(不接受 ApiKeyAuth)|
| `GET .../status`、`.../logs` | 同 `/v2/templates/.../builds/...`(支持全部 4 种组合)|

---

## 四、v1/v2/v3 演变与弃用时间线

E2B 的模板构建 API 经历了三代演变,每一代都对应一种「构建源」的演进:

### v1(`PostTemplates` / `PostTemplatesTemplateID` / `PostTemplatesTemplateIDBuildsBuildID`)

**特征**:
- 请求体携带完整 `Dockerfile` 字符串(`api.gen.go:1217`:必填)
- 两步流程:第一步 `POST /templates` 或 `POST /templates/{tid}` 创建/重建;第二步 `POST /templates/{tid}/builds/{bid}` 触发实际构建(用户必须先把镜像推到 registry)
- 仅支持 access token 鉴权(用户身份),不接受 API key
- 版本号固定写为 `templates.TemplateV1Version` = `"v1.0.0"`(`deprecated_template_request_build.go:209`)
- 触发时强制 `forceRebuild = true`、`fromImage = ""`(`deprecated_template_start_build.go:201-202`)
- Posthog 事件用 `CreateAnalyticsUserEvent`(同时上报 userID 与 teamID)

**为什么弃用**:用户必须先 docker push 再调 trigger,体验差;Dockerfile 字段是裸文本,无法表达 multi-stage、私有 registry 等。

### v2(`PostV2Templates` + `PostV2TemplatesTemplateIDBuildsBuildID`)

**特征**:
- 把请求拆成两次:`POST /v2/templates` 拿到 `(templateID, buildID)`(已弃用,见 `deprecated_template_request_build_v2.go`),再 `POST /v2/templates/{tid}/builds/{bid}` 携带 `TemplateBuildStartV2` 触发
- 触发请求体支持 `FromImage`、`FromTemplate`、`Steps`、`FromImageRegistry`(`api.gen.go:1271-1291`)
- 鉴权扩展到 ApiKeyAuth / AdminApiKeyAuth
- 版本号由 SDK User-Agent 决定(`userAgentToTemplateVersion`,`template_start_build_v2.go:208-245`)

### v3(`PostV3Templates`)

**特征**(当前推荐):
- 单一端点 `POST /v3/templates`,只做「注册」(`template.RegisterBuild`),不立即触发构建
- 请求体 `TemplateBuildRequestV3`(`api.gen.go:1248-1269`):`Name`(支持 `name:tag` 语法)、`Tags`、`CpuCount`、`MemoryMB`、可选 `Alias`(向前兼容)
- 调用方拿到 `(templateID, buildID)` 后,自行通过 `POST /v2/templates/{tid}/builds/{bid}` 触发(携带 `FromImage`/`FromTemplate`/`Steps`)
- 版本号固定为 `templates.TemplateV2LatestVersion` = `"v2.1.0"`(`template_request_build_v3.go:132`)
- Posthog 事件用 `CreateAnalyticsTeamEvent`(只关心 teamID)

### 弃用标记位置

- `POST /v2/templates`(POST)在 OpenAPI 中标记 `deprecated: true`(`spec/openapi.yml:2816`)
- `POST /templates`、`POST /templates/{tid}` 在 OpenAPI 中标记 `deprecated: true`(同上)
- `POST /templates/{tid}/builds/{bid}` 在 OpenAPI 中标记 `deprecated: true`(同上)
- `TemplateBuildRequestV3.Alias` 字段在生成代码中标记 `Deprecated`(`api.gen.go:1251`),`Name` 是新写法

### 表 4-1:三代 API 对照

| 维度 | v1 | v2 | v3 |
|---|---|---|---|
| 入口端点 | `/templates`、`/templates/{tid}` | `/v2/templates`、`/v2/templates/{tid}/builds/{bid}` | `/v3/templates` + `/v2/.../builds/{bid}` |
| 构建源 | Dockerfile 字符串 | FromImage/FromTemplate/Steps | 注册阶段无,触发阶段同 v2 |
| 模板版本 | `v1.0.0` | UA 解析(JS/Python SDK ≥ 2.3.0 → `v2.1.0`,否则 `v2.0.0`) | `v2.1.0` |
| 鉴权 | AccessTokenAuth + AuthProvider | + ApiKeyAuth + AdminApiKeyAuth | 同 v2 trigger |
| 触发模式 | 两步(注册带 Dockerfile + 手动触发) | 显式两步 | 显式两步(注册与触发分离) |
| Posthog 事件 | `submitted environment build request`、`built environment`(UserEvent) | `submitted environment build request`(注册)、`built environment`(触发,均为 TeamEvent)| `submitted environment build request`(注册,TeamEvent)|

---

## 五、`RegisterBuild`:只落库的「注册」阶段

`template.RegisterBuild`(`packages/api/internal/template/register_build.go:58-401`)是 v1/v2/v3 都会走的「注册」核心:它**只写 DB**,不触发任何 gRPC。它的工作流程是一个完整事务,失败会整体回滚。

### 5.1 入参

```go
// register_build.go:28-48
type RegisterBuildData struct {
    ClusterID  uuid.UUID
    TemplateID api.TemplateID
    UserID     *uuid.UUID        // v1 携带,v2/v3 为 nil
    Team       *types.Team
    Dockerfile string             // v1 用,v2/v3 为空
    Alias      *string
    Tags       []string
    StartCmd   *string
    ReadyCmd   *string
    CpuCount   *int32
    MemoryMB   *int32
    Version    string

    // TODO(ENG-3852): Remove once the template manager resolves the kernel and firecracker versions itself.
    KernelVersion      string  // Deprecated
    FirecrackerVersion string  // Deprecated
}
```

### 5.2 事务步骤(8 步)

`RegisterBuild` 在 `db.WithTx` 内按顺序执行以下步骤,任意一步失败都触发 `defer tx.Rollback`:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  RegisterBuild Transaction                              │
│                                                                         │
│  1. GetInProgressTemplateBuildsByTeam  (并发上限检查)                   │
│       └─► otherBuildCount >= Team.Limits.BuildConcurrency              │
│             ? return 429                                                │
│                                                                         │
│  2. uuid.NewRandom() 生成 buildID                                       │
│                                                                         │
│  3. team.LimitResources(team.Limits, CpuCount, MemoryMB)                │
│       └─► 校验 cpu/ram 配额                                             │
│                                                                         │
│  4. CreateOrUpdateTemplate                                              │
│       └─► 软删除的模板会返回 NotFound(不可重建)                        │
│                                                                         │
│  5. InvalidateUnstartedTemplateBuilds                                   │
│       └─► 把同 template + 同 tags 的 pending 构建标记 failed            │
│                                                                         │
│  6. CreateTemplateBuild                                                 │
│       └─► INSERT env_builds (status=waiting, kernel/fc version seeded)  │
│                                                                         │
│  7. 别名分支(仅当 data.Alias != nil)                                  │
│       ├─► CheckAliasConflictsWithTemplateID  (跨 team 冲突)             │
│       ├─► CheckAliasExistsInNamespace        (同 namespace 已有)        │
│       │     ├─► NotFound → DeleteOtherTemplateAliases + CreateTemplateAlias
│       │     └─► found 但归属不同 template → 403                         │
│       └─► templateCache.InvalidateAlias                                 │
│                                                                         │
│  8. CreateTemplateBuildAssignment(每个 tag 一行)                       │
│     + CreateActiveTemplateBuild                                         │
│       └─► 写入 active_template_builds 用于并发限制                      │
│                                                                         │
│  tx.Commit()                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.3 并发限制的「软」实现

注释明确写道(`register_build.go:73-74`):

> This is a simple implementation of concurrency limit. It does not guarantee that the limit is not exceeded...

`GetInProgressTemplateBuildsByTeam`(`builds/get_inprogress_builds.sql`)查询条件:

```sql
SELECT COUNT(*) as build_count
FROM public.active_template_builds atb
WHERE atb.team_id = sqlc.arg(team_id)::uuid
  AND atb.created_at > NOW() - INTERVAL '1 day'
  AND NOT (
    atb.template_id = sqlc.arg(exclude_template_id)::text
    AND atb.tags && sqlc.arg(exclude_tags)::text[]
  );
```

- 时间窗口:1 天(`INTERVAL '1 day'`)
- 排除自身:同一 template + 同 tags 集合的构建不算并发(允许同 tag 重建)
- 数据源:`active_template_builds` 表(由 migration `20260305130000` 引入)

### 5.4 别名冲突规则

别名检查在事务内有**两层**,顺序很重要:先查全局(`CheckAliasConflictsWithTemplateID`,alias 维度),再查 namespace 维度(`CheckAliasExistsInNamespace`,(alias, namespace) 维度)。

| 检查顺序 | 命中条件 | 行为 |
|---|---|---|
| ① 全局冲突(`:252-272`)| alias 被任意其他 template(无论 team)占用 | 返回 `409 Conflict` |
| ② 同 namespace 未命中(`:274-277`,NotFound)| (alias, namespace) 不存在 | 删除当前模板的旧别名 + 创建新别名(`:289-319`)|
| ② 同 namespace 命中且是当前模板(`:325`)| `aliasDB.EnvID == data.TemplateID` | 直接复用,不创建新行 |
| ② 同 namespace 命中但非当前模板(`:325-332`)| (alias, namespace) 被同 team 其他模板占用 | 返回 `403 Forbidden` |

注意:① 是 alias 维度的全局检查(因为 `aliases` 表上 alias 列本身有唯一性约束);② 是 (alias, namespace) 维度。两层都通过才能继续。

`id.ExtractAlias`(`register_build.go:248`)会剥掉 namespace 前缀;`id.WithNamespace`(`register_build.go:250`)在写回 `names` 时加上当前 team 的 slug。

### 5.5 出参

```go
// register_build.go:50-56
type RegisterBuildResponse struct {
    TemplateID string
    BuildID    string
    Aliases    []string   // 已剥 namespace
    Names      []string   // 带 namespace(team slug 前缀)
    Tags       []string
}
```

注意:`Aliases` 是不带 namespace 的纯 alias(用于显示),`Names` 是 `slug/alias` 形式(用于唯一索引)。

---

## 六、`PostV3Templates`:两阶段构建的入口

`PostV3Templates`(`template_request_build_v3.go:24-39`)只是 `requestTemplateBuild` 的薄包装。真正的逻辑在 `requestTemplateBuild`(`:41-170`)。

### 6.1 主流程

```
PostV3Templates
  ├─► ginutils.ParseBody[TemplateBuildRequestV3]
  └─► requestTemplateBuild
       ├─► GetTeam                            // 取 team + limits(走缓存)
       ├─► 解析 input:body.Name ?? body.Alias // Alias 是 deprecated 兜底
       ├─► id.ParseName(input)                // 拆 "name:tag"
       ├─► id.ValidateNamespaceMatchesTeam    // 校验 namespace 前缀
       ├─► 合并 tags:name 中的 tag + body.Tags
       ├─► id.ValidateAndDeduplicateTags
       ├─► templateCache.ResolveAliasWithMetadata
       │     ├─► 命中且 team 一致 → 复用 templateID(更新)
       │     ├─► 命中但跨 team → 允许在自家 namespace 建同名
       │     └─► NotFound → 生成新 templateID
       ├─► featureFlags.StringFlag(BuildFirecrackerVersion / BuildKernelVersion)
       ├─► template.RegisterBuild             // 落库
       ├─► templateCache.InvalidateAlias      // 防止 stale NotFound
       └─► Posthog: "submitted environment build request"
```

### 6.2 关键细节

- **`body.Name` 优先,`body.Alias` 兜底**(`:55-66`):兼容旧 SDK,但 `Alias` 在 OpenAPI 中已标 deprecated
- **`id.ParseName` 解析 `name:tag`**(`:68`):如果 `input` 是 `"my-tmpl:v1"`,则 `identifier = "my-tmpl"`、`tag = "v1"`;之后 tag 被自动 prepend 到 `allTags`(`:83-85`)
- **namespace 校验**(`:76-80`):如果 `identifier` 形如 `team-slug/my-tmpl`,要求 slug 匹配当前 team
- **跨 team 别名复用**(`:101-108`):如果 alias 命中其他 team 的模板(常见于 promoted template),当前 team 仍可在自己的 namespace 建同名新模板
- **firecracker/kernel 版本是 deprecated 字段**(`:118-122`):TODO(ENG-3852)注明 orchestrator 会自己解析,这里只是 backwards compat
- **Posthog 事件**(`:154-159`):事件名固定为 `"submitted environment build request"`,携带 environment、build_id、alias、tags

### 6.3 返回值

```go
// template_request_build_v3.go:162-169
&api.TemplateRequestResponseV3{
    TemplateID: template.TemplateID,
    BuildID:    template.BuildID,
    Aliases:    template.Aliases,
    Names:      template.Names,
    Tags:       template.Tags,
    Public:     public,    // 仅当复用已有模板时为 true
}
```

HTTP 状态码 `202 Accepted`(`:37`):表示请求被接受,但实际构建尚未开始——调用方必须再调一次 `/v2/templates/{tid}/builds/{bid}` 才会触发。

---

## 七、`PostV2TemplatesTemplateIDBuildsBuildID`:真正触发构建

这是 v2/v3 流程中「真正干活」的端点(`template_start_build_v2.go:40-204`)。

### 7.1 流程概览

```
PostV2TemplatesTemplateIDBuildsBuildID(templateID, buildID)
  ├─► ParseBody[TemplateBuildStartV2]
  ├─► uuid.Parse(buildID)
  ├─► GetTemplateBuildWithTemplate          // 校验 build 存在 + 取 team
  ├─► GetTeam                               // 鉴权
  ├─► 检查 team.ID == templateBuildDB.ActiveEnv.TeamID
  ├─► featureflags.AddToContext(TemplateContext)
  ├─► CheckAndCancelConcurrentBuilds        // 同 template 的 in_progress 全部取消
  ├─► 校验 build.StatusGroup == Pending     // 只有 pending 能触发
  ├─► json.Marshal(dockerfileStore{FromImage, FromTemplate, Steps})
  │     // 3 字段打包成 JSON 存到 env_builds.dockerfile
  ├─► userAgentToTemplateVersion            // 决定模板版本
  ├─► templateManager.GetAvailableBuildClient(clusterID)
  │     // 选 builder 节点(支持 BuildNodeInfo feature flag)
  ├─► UpdateTemplateBuild                   // 写 ClusterNodeID + MachineInfo
  ├─► templateManager.CreateTemplate        // gRPC 触发
  ├─► Posthog: "built environment" (TeamEvent)
  └─► 202 Accepted
```

### 7.2 `dockerfileStore`:三源序列化

`template_start_build_v2.go:33-37`:

```go
type dockerfileStore struct {
    FromImage    *string             `json:"from_image"`
    FromTemplate *string             `json:"from_template"`
    Steps        *[]api.TemplateStep `json:"steps"`
}
```

这三个字段被一起序列化为 JSON,存到 `env_builds.dockerfile` 列。该列在 v1 时代真的存的是 Dockerfile 文本,v2 之后变成「构建源」的结构化描述。**字段名仍然叫 dockerfile**,但语义已变——这是历史包袱。

### 7.3 只允许 pending 状态触发

`template_start_build_v2.go:110-115`:

```go
if build.StatusGroup != types.BuildStatusGroupPending {
    a.sendAPIStoreError(c, http.StatusBadRequest, "build is not in waiting state")
    ...
}
```

如果 buildID 已经被触发过(state → in_progress)、或已完成、或已失败,这个端点会直接 400。

### 7.4 选节点:`GetAvailableBuildClient`

`templateManager.GetAvailableBuildClient`(`template_manager.go:111-140`)的逻辑:

1. 从 `clusters.Pool` 取出当前 cluster
2. 把 clusterID 注入 feature flag context(`featureflags.ClusterContext(clusterID)`)
3. 读 `BuildNodeInfo` JSON flag(`flags.go:486`)
4. 调 `cluster.GetAvailableTemplateBuilder(ctx, nodeInfo)`
5. 如果指定 nodeInfo 没有可用 builder → fallback 到 `machineinfo.MachineInfo{}`(任意 builder),并打 warn 日志

### 7.5 写 `ClusterNodeID` 和 `MachineInfo`

`UpdateTemplateBuild`(`template_start_build_v2.go:146-157`)把 builder 节点信息写入 `env_builds`:

| 字段 | 来源 |
|---|---|
| `ClusterNodeID` | `builderNode.NodeID` |
| `CpuArchitecture` | `machineInfo.CPUArchitecture` |
| `CpuFamily` | `machineInfo.CPUFamily` |
| `CpuModel` | `machineInfo.CPUModel` |
| `CpuModelName` | `machineInfo.CPUModelName` |
| `CpuFlags` | `machineInfo.CPUFlags` |
| `StartCmd` / `ReadyCmd` | body |
| `Dockerfile` | 序列化后的 dockerfileStore JSON |

这一步把「构建在哪个节点跑」固化到 DB,后续 `BuildStatusSync`、`DeleteBuild`、日志查询都依赖它。

---

## 八、`TemplateManager`:CP 侧的 gRPC 编排器

`TemplateManager`(`template_manager.go:36-45`)是 API 进程里负责所有 template-manager gRPC 调用的封装:

```go
type TemplateManager struct {
    clusters      *clusters.Pool
    lock          sync.Mutex
    processing    map[uuid.UUID]processingBuilds    // 防止同一 buildID 并发同步
    buildCache    *templatecache.TemplatesBuildCache
    templateCache *templatecache.TemplateCache
    sqlcDB        *sqlcdb.Client
    featureFlags  *featureflags.Client
}
```

### 8.1 关键方法

| 方法 | 位置 | 用途 |
|---|---|---|
| `New` | `:59-78` | 构造函数 |
| `BuildsStatusPeriodicalSync` | `:80-109` | 每分钟巡检所有 pending/in_progress 构建 |
| `GetAvailableBuildClient` | `:111-140` | 选 builder 节点(支持 BuildNodeInfo) |
| `GetClusterResources` | `:142-149` | 取 ClusterResource(metrics/logs 访问器)|
| `GetClusterBuildClient` | `:151-163` | 取指定 nodeID 上的 gRPC client |
| `DeleteBuild` | `:165-204` | 取消一个 build(带 orchestrator fallback) |
| `DeleteBuilds` | `:206-215` | 批量 DeleteBuild |
| `GetStatus` | `:217-229` | gRPC `TemplateBuildStatus` |
| `CreateTemplate` | `create_template.go:37-204` | gRPC `TemplateCreate` + 状态推进 |
| `BuildStatusSync` | `template_status.go:24-83` | 单个 build 的状态轮询主循环 |
| `SetStatus` | `template_status.go:270-308` | 写状态(终态走 `FailTemplateBuildAndDeactivate`)|
| `SetFinished` | `template_status.go:310-325` | 走 `FinishTemplateBuild`,带 kernel/fc 版本回写 |

### 8.2 `processing` map:防止并发同步

```go
// template_status.go:255-268
func (tm *TemplateManager) createInProcessingQueue(buildID uuid.UUID, templateID string) bool {
    tm.lock.Lock()
    defer tm.lock.Unlock()

    _, exists := tm.processing[buildID]
    if exists {
        return true   // 已在处理,跳过
    }
    tm.processing[buildID] = processingBuilds{templateID: templateID}
    return false
}
```

`BuildsStatusPeriodicalSync`(每分钟)和 `CreateTemplate` 启动的后台 goroutine(立即)都会调 `BuildStatusSync`。如果没有这个去重,两个来源同时跑同一个 buildID 时会并发轮询,既浪费 gRPC 调用又会让 DB 状态闪烁。

### 8.3 `DeleteBuild` 的 orchestrator fallback

`template_manager.go:165-204` 有一个有趣的 fallback:如果 `GetClusterBuildClient(clusterID, nodeID)` 失败(比如节点已下线),会尝试 `GetAvailableBuildClient`(任一可用 builder)继续 delete 调用。注释说:

> nodeID can be an orchestrator ID, if the build corresponds to a snapshot. We may want to improve this later by adding the Delete method to Orchestrator as well.

说明 `nodeID` 字段在某些历史场景下可能存的是 orchestrator ID 而不是 builder ID。

---

## 九、`CreateTemplate`:一次 gRPC 调用 + 状态推进

`TemplateManager.CreateTemplate`(`create_template.go:37-204`)是「真正启动构建」的核心。

### 9.1 defer 机制:任何错误都标 Failed

```go
// create_template.go:66-84
defer func() {
    if e == nil {
        return
    }
    telemetry.ReportCriticalError(ctx, "build failed", e, ...)
    err := tm.SetStatus(
        ctx, buildID, types.BuildStatusGroupFailed,
        &templatemanagergrpc.TemplateBuildStatusReason{
            Message: fmt.Sprintf("error when building env: %s", e),
        },
    )
    if err != nil {
        e = errors.Join(e, fmt.Errorf("failed to set build status to failed: %w", err))
    }
}()
```

这是命名返回值 `(e error)` 的妙用:无论哪一步 panic/return error,都会被这个 defer 兜底,把状态置为 Failed。保证不会出现「构建挂了但 DB 还显示 building」的悬挂状态。

### 9.2 gRPC `TemplateConfig` 组装

`create_template.go:114-129`:

```go
template := &templatemanagergrpc.TemplateConfig{
    TeamID:             teamID.String(),
    TemplateID:         templateID,
    BuildID:            buildID.String(),
    VCpuCount:          int32(vCpuCount),
    MemoryMB:           int32(memoryMB),
    DiskSizeMB:         int32(diskSizeMB),
    KernelVersion:      kernelVersion,      // deprecated
    FirecrackerVersion: firecrackerVersion, // deprecated
    HugePages:          features.HasHugePages(),
    StartCommand:       startCmd,
    ReadyCommand:       readyCmd,
    Force:              force,
    Steps:              convertTemplateSteps(steps),
    FromImageRegistry:  imageRegistry,
}
```

`HugePages` 来自 `fcversion.New(firecrackerVersion).HasHugePages()`(`:86-89`):基于 fc 版本判断是否支持 hugepages。这是 fc 版本相关特性的开关,比如较新的 fc 版本需要 hugepages 才能正确分配内存。

### 9.3 `setTemplateSource`:FromImage vs FromTemplate

`create_template.go:289-349` 处理三种情形:

| 条件 | 行为 |
|---|---|
| 同时指定 FromImage + FromTemplate | `errors.New("cannot specify both fromImage and fromTemplate")` |
| 都不指定 | `errors.New("must specify either fromImage or fromTemplate")`(v1 走 FromImage="")|
| 仅 FromTemplate | 解析 → `ResolveAliasWithMetadata` → `templateCache.Get` → 填 `FromTemplateConfig{Alias, BuildID}` |
| 仅 FromImage | 直接填 `FromImage: *fromImage` |

`FromTemplate` 解析有一个特殊错误类型 `FromTemplateError`(`create_template.go:24-35`),用于把 alias 解析失败转化为「base step 失败」(`:140-148`):

```go
err = tm.SetStatus(ctx, buildID, types.BuildStatusGroupFailed,
    &templatemanagergrpc.TemplateBuildStatusReason{
        Message: err.Error(),
        Step:    new("base"),    // ← 把 fromTemplate 解析失败归到 "base" step
    })
```

这样 CLI 看到的就是「base step 失败」,而不是 CP API 内部错误。

### 9.4 gRPC 调用 + 状态推进

```go
// create_template.go:156-167
_, err = client.Template.TemplateCreate(
    ctx, &templatemanagergrpc.TemplateCreateRequest{
        Template:   template,
        CacheScope: new(teamID.String()),
        Version:    &version,
    },
)
err = utils.UnwrapGRPCError(err)
```

成功后:

```go
// create_template.go:172-180
err = tm.SetStatus(ctx, buildID, types.BuildStatusGroupInProgress, nil)
```

**注释提醒**(`:170-171`):必须**先**触发 gRPC 构建再置 InProgress,否则定时同步任务可能在 template-manager 还没建好 build cache 时就开始查状态,导致构建直接失败。

### 9.5 后台 goroutine:立即跑一次同步

```go
// create_template.go:184-201
go func(ctx context.Context) {
    ctx, span := tracer.Start(ctx, "template-background-build-env")
    defer span.End()

    l := logger.L().With(logger.WithBuildID(buildID.String()), logger.WithTemplateID(templateID))

    err := tm.BuildStatusSync(ctx, buildID, templateID, clusterID, &nodeID)
    if err != nil {
        l.Error(ctx, "error syncing build status", zap.Error(err))
    }

    telemetry.ReportEvent(ctx, "build status sync completed")

    invalidatedKeys := tm.templateCache.InvalidateAllTags(context.WithoutCancel(ctx), templateID)
    telemetry.ReportEvent(ctx, "invalidated template cache", attribute.StringSlice("invalidated_keys", invalidatedKeys))
}(context.WithoutCancel(ctx))
```

不等到下一分钟定时巡检,立刻开始轮询。`context.WithoutCancel` 保证即使 HTTP 请求返回了,后台 goroutine 仍能继续跑(否则客户端断开连接就会杀掉构建同步)。

构建结束后顺手 invalidate 该 template 的所有 tag 缓存——这样后续 `templateCache.Get` 会读到新 build。

### 9.6 `convertImageRegistry`:三种 registry 凭证

`create_template.go:229-286` 把 OpenAPI union 类型转成 gRPC:

| OpenAPI 类型 | gRPC 类型 | 字段 |
|---|---|---|
| `AWSRegistry` | `FromImageRegistry_Aws` | `AwsAccessKeyId`, `AwsSecretAccessKey`, `AwsRegion` |
| `GCPRegistry` | `FromImageRegistry_Gcp` | `ServiceAccountJson` |
| `GeneralRegistry` | `FromImageRegistry_General` | `Username`, `Password` |

---

## 十、后台状态同步:`BuildStatusSync` 与定时巡检

### 10.1 `BuildsStatusPeriodicalSync`:每分钟巡检

`template_manager.go:80-109`:

```go
const syncInterval = time.Minute * 1   // :56

func (tm *TemplateManager) BuildsStatusPeriodicalSync(ctx context.Context) {
    ticker := time.NewTicker(syncInterval)
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            dbCtx, dbxCtxCancel := context.WithTimeout(ctx, 5*time.Second)
            buildsRunning, err := tm.sqlcDB.GetInProgressTemplateBuilds(dbCtx)
            // ...
            for _, b := range buildsRunning {
                go func(b queries.GetInProgressTemplateBuildsRow) {
                    err := tm.BuildStatusSync(ctx, b.EnvBuild.ID, b.ActiveEnv.ID,
                        clustersshared.WithClusterFallback(b.TeamClusterID),
                        b.EnvBuild.ClusterNodeID)
                    // ...
                }(b)
            }
        }
    }
}
```

特点:
- 每分钟 fire 一次
- DB 查询有 5 秒超时
- 每个构建启动独立 goroutine 同步(并发)
- `GetInProgressTemplateBuilds`(`builds/get_inprogress_builds.sql`)SELECT 所有 `status_group IN ('pending', 'in_progress')` 的构建

### 10.2 `BuildStatusSync`:单个构建的同步

`template_status.go:24-83`:

```go
var (
    buildTimeout             = time.Hour        // 整体构建超时
    syncWaitingStateDeadline = time.Minute * 40 // waiting 状态超时
)
```

流程:

```
BuildStatusSync(buildID, templateID, clusterID, nodeID)
  ├─► createInProcessingQueue(buildID)
  │     └─► 已在处理 → return nil
  ├─► defer removeFromProcessingQueue
  ├─► GetTemplateBuildWithTemplate           // 读当前状态
  ├─► if StatusGroup == Pending:
  │     ├─► if time.Since(CreatedAt) > 40m:
  │     │     └─► SetStatus Failed ("build is in waiting state for too long")
  │     └─► else return nil                  // 等下次同步
  ├─► if nodeID == nil → error               // 应该已分配
  ├─► 构造 PollBuildStatus
  └─► ctx with 1h timeout → checker.poll(ctx)
```

### 10.3 `PollBuildStatus.poll`:每秒轮询

`template_status.go:104-143`:

```go
func (c *PollBuildStatus) poll(ctx context.Context) {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            // 1 小时超时,标记 Failed
            c.client.SetStatus(ctx, c.buildID, types.BuildStatusGroupFailed,
                &templatemanagergrpc.TemplateBuildStatusReason{
                    Message: fmt.Sprintf("build status polling timed out. Maximum build time is %s.", buildTimeout),
                })
            return
        case <-ticker.C:
            buildCompleted, err := c.checkBuildStatus(ctx)
            // 出错或完成都退出
            if err != nil || buildCompleted {
                return
            }
        }
    }
}
```

`checkBuildStatus`(`:223-247`)带 10 次重试(初始 100ms、上限 1s):

```go
retrier := retry.NewRetrier(10, 100*time.Millisecond, time.Second)
err := retrier.RunContext(ctx, c.setStatus)
```

**重试仅针对 `context.DeadlineExceeded`**(`template_status.go:163-169`):其他任何错误都被包装成 `terminalError`(`retry.Stop`),立刻终止整个轮询循环并标 Failed。这是为了避免在节点临时不可达时把构建错误地判死。

### 10.4 状态分发

`dispatchBasedOnStatus`(`:183-221`)处理 gRPC 返回:

| gRPC 状态 | 行为 |
|---|---|
| `TemplateBuildState_Failed` | `SetStatus(Failed)` + return true(完成)|
| `TemplateBuildState_Completed` | `SetFinished(rootfsSize, envdVersion, kernelVersion, firecrackerVersion)` + return true |
| 其它(Building 等)| debug 日志 + return false(继续轮询)|

### 10.5 `SetStatus` vs `SetFinished`

两个写入路径**走不同的 SQL**:

**`SetStatus`**(`template_status.go:270-308`):
- 终态(Ready/Failed):`FailTemplateBuildAndDeactivate`(同时从 `active_template_builds` 删)
- 非终态:`UpdateEnvBuildStatus`

**`SetFinished`**(`template_status.go:310-325`):
- 走 `FinishTemplateBuild`(`builds/finish_template_build.sql`)
- SQL 巧妙之处:用 `WITH deactivated AS (DELETE FROM active_template_builds ...)` + `UPDATE env_builds` 在同一语句里完成,避免 race condition
- kernel/fc 版本用 `COALESCE(NULLIF(@kernel_version::text, ''), kernel_version)` 回写——如果 template-manager 没填(老版本),保留 CP API 注册时 seed 的值

---

## 十一、并发构建控制:`CheckAndCancelConcurrentBuilds`

`deprecated_template_start_build.go:31-76`:

```go
func (a *APIStore) CheckAndCancelConcurrentBuilds(
    ctx context.Context, templateID api.TemplateID,
    buildID uuid.UUID, teamClusterID uuid.UUID,
) error {
    concurrentBuilds, err := a.sqlcDB.GetConcurrentTemplateBuilds(ctx, queries.GetConcurrentTemplateBuildsParams{
        TemplateID:     templateID,
        CurrentBuildID: buildID,
    })
    // ...
    if len(concurrentBuilds) > 0 {
        concurrentRunningBuilds := utils.Filter(concurrentBuilds, func(b queries.EnvBuild) bool {
            return b.StatusGroup == dbtypes.BuildStatusGroupInProgress
        })
        // 为每个 in_progress 构造 DeleteBuild 请求
        buildIDs := make([]templatemanager.DeleteBuild, 0, len(concurrentRunningBuilds))
        for _, b := range concurrentRunningBuilds {
            if b.ClusterNodeID == nil {
                continue
            }
            buildIDs = append(buildIDs, templatemanager.DeleteBuild{
                TemplateID: templateID,
                BuildID:    b.ID,
                ClusterID:  teamClusterID,
                NodeID:     *b.ClusterNodeID,
            })
        }
        // 调 templateManager.DeleteBuilds 取消
        deleteJobErr := a.templateManager.DeleteBuilds(ctx, buildIDs)
        // ...
    }
    return nil
}
```

### 11.1 与 RegisterBuild 并发限制的区别

| 机制 | 作用层 | 触发时机 | 行为 |
|---|---|---|---|
| `GetInProgressTemplateBuildsByTeam` | RegisterBuild(注册)| 注册新 build 之前 | 返回 429,拒绝注册 |
| `CheckAndCancelConcurrentBuilds` | Trigger(触发)| 触发新 build 之前 | **取消**同 template 同 tag 的旧 in_progress build |

前者是「软并发上限」(team 维度,排除自身 template+tags),后者是「同 template 同 tag 互斥」。

### 11.2 SQL 与代码的两段式过滤

注意 SQL 本身**同时返回 pending 和 in_progress**(`status_group IN ('pending', 'in_progress')`),随后代码再用 `utils.Filter` 把 `in_progress` 挑出来送给 `DeleteBuilds`(`deprecated_template_start_build.go:43-46`)。也就是说:
- pending 的旧 build **不会被 gRPC 取消**(它们的 `ClusterNodeID` 还可能是 nil)
- 只有已经开始构建(`in_progress`)的旧 build 才会被通知到 orchestrator 停止

这与「同 template 同 tag 互斥」的最终行为一致:对尚未触发的 pending build,靠 `RegisterBuild` 的 `InvalidateUnstartedTemplateBuilds`(`register_build.go:196-202`)在注册阶段就标 failed,不需要 trigger 阶段再取消。

### 11.3 `GetConcurrentTemplateBuilds` SQL

```sql
-- builds/get_concurrent_template_builds.sql
SELECT DISTINCT eb.* FROM env_build_assignments eba
JOIN env_builds eb ON eb.id = eba.build_id
WHERE
    eba.env_id = @template_id
    AND eb.status_group IN ('pending', 'in_progress')
    AND eb.id != @current_build_id
    AND eba.tag IN (
        SELECT tag FROM env_build_assignments
        WHERE build_id = @current_build_id AND env_id = @template_id
    );
```

关键点:通过 `env_build_assignments` 表 JOIN,只查**同 template + 同 tag 集合**的构建。如果新 build 是 `my-tmpl:v1`,旧 build 是 `my-tmpl:v2`,互不干扰。

---

## 十二、构建状态与日志查询

### 12.1 `GetTemplatesTemplateIDBuildsBuildIDStatus`

`template_build_status.go:28-147`,CLI 用得最多。

**关键常量**:`maxLogEntriesPerRequest = int32(100)`(`:25`)

**主流程**:

```
GetTemplatesTemplateIDBuildsBuildIDStatus
  ├─► uuid.Parse(buildID)
  ├─► templateBuildsCache.Get(buildUUID, templateID)
  ├─► GetTeam + 校验 team.ID == buildInfo.TeamID
  ├─► if buildInfo.BuildStatus == Pending:
  │     └─► 提前返回 {status: "waiting", logs: []}  // 没开始,不查日志
  ├─► 准备 result{TemplateID, BuildID, Status, Reason}
  ├─► 计算 legacyLogs:
  │     cv = DerefOrDefault(buildInfo.Version, TemplateV1Version)
  │     legacyLogs = IsSmallerVersion(cv, TemplateV2BetaVersion)
  │       // 即 cv < "v2.0.0"
  ├─► 取 cluster + GetResources()
  ├─► limit = min(params.Limit, 100)
  ├─► cluster.GetResources().GetBuildLogs(..., apiToLogLevel(params.Level), nil, Forward, nil)
  ├─► 双格式填充:
  │     if legacyLogs: lgs += "[ts] msg\n"        // 旧格式
  │     logEntries += getAPILogEntry(entry)        // 新格式
  ├─► if result.Reason.Step != nil:
  │     result.Reason.LogEntries = filterStepLogs(logEntries, step, Warn)
  └─► 200 OK
```

**legacyLogs 兼容**:v1 模板(`cv < "v2.0.0"`)需要同时返回 `Logs` 字符串数组(老格式)和 `LogEntries` 结构化数组(新格式)。v2+ 模板只填 `LogEntries`。

**`filterStepLogs`**(`:178-182`):如果构建失败时有 reason.step 字段,把日志过滤为只剩该 step 且级别 ≥ Warn 的条目,方便 CLI 直接高亮「失败的 step」。

### 12.2 `GetTemplatesTemplateIDBuildsBuildIDLogs`

`template_build_logs.go:19-106`,纯日志分页(不分页状态):

```
GetTemplatesTemplateIDBuildsBuildIDLogs
  ├─► uuid.Parse(buildID)
  ├─► templateBuildsCache.Get
  ├─► GetTeam + 鉴权
  ├─► if Pending: 提前返回空
  ├─► 取 cluster
  ├─► limit = min(params.Limit, 100)
  ├─► direction = Forward / Backward
  ├─► cursor = time.UnixMilli(params.Cursor)
  ├─► cluster.GetResources().GetBuildLogs(..., level, cursor, direction, params.Source)
  │     // 注意:status 端点用 offset,logs 端点用 cursor
  └─► 200 OK {logs: [...]}
```

**两个端点的关键差异**:

| 维度 | `/status` | `/logs` |
|---|---|---|
| 分页机制 | `logsOffset`(int32 偏移量) | `cursor`(Unix 毫秒时间戳) |
| 返回字段 | `LogEntries` + `Logs`(legacy) + `Status` + `Reason` | 仅 `Logs` |
| 特殊处理 | Pending 提前返回 `TemplateBuildStatusWaiting` | Pending 提前返回空数组 |
| 过滤 | `filterStepLogs` 高亮失败 step | 不做 step 过滤 |
| 上限 | 100 | 100 |

---

## 十三、别名 / 标签 / 命名空间解析

`id.ParseName`(`packages/shared/pkg/id/`)是模板构建中反复出现的解析函数:

### 13.1 输入格式

```
"my-template"           → identifier="my-template", tag=nil
"my-template:v1"        → identifier="my-template", tag="v1"
"team-slug/my-template" → identifier="team-slug/my-template", tag=nil
"team-slug/my-tmpl:v2"  → identifier="team-slug/my-tmpl", tag="v2"
```

### 13.2 派生函数

| 函数 | 用途 |
|---|---|
| `id.ParseName(input)` | 拆 `name:tag` |
| `id.ExtractAlias(identifier)` | 剥掉 `namespace/` 前缀,返回纯 alias |
| `id.WithNamespace(slug, alias)` | 反向组合 `slug/alias`(写 `names` 字段)|
| `id.ValidateNamespaceMatchesTeam(identifier, slug)` | 校验 namespace 前缀(如果有)等于当前 team slug |
| `id.ValidateAndDeduplicateTags(tags)` | 标签去重 + 校验 |
| `id.DefaultTag` | 没传 tag 时使用的默认值(常见是 `"default"`)|

### 13.3 在 RegisterBuild 中的使用

`register_build.go:244-336` 别名分支:

```go
alias := id.ExtractAlias(*data.Alias)        // "team-slug/x" → "x"
aliases = append(aliases, alias)             // 存不带 namespace
names = append(names, id.WithNamespace(data.Team.Slug, alias))  // 存 "team-slug/x"
```

注意:DB 列同时存在 `aliases.alias`(纯 alias)和 `aliases.namespace`(team slug),唯一索引是 `(alias, namespace)` 组合。这就是为什么跨 team 可以有同名 alias。

---

## 十四、SDK 版本检测与模板版本选择

### 14.1 常量(`packages/shared/pkg/templates/versions.go`)

```go
const (
    TemplateV2LatestVersion = "v2.1.0"

    TemplateV2ReleaseVersion = "v2.1.0"
    TemplateV2BetaVersion    = "v2.0.0"

    TemplateV1Version = "v1.0.0"
)

const (
    SDKTemplateReleaseVersion = "2.3.0"   // JS/Python SDK 必须达到此版本才能用 v2.1.0
)
```

### 14.2 `userAgentToTemplateVersion`

`template_start_build_v2.go:208-245`:

```go
const (
    jsSDKPrefix     = "e2b-js-sdk/"
    pythonSDKPrefix = "e2b-python-sdk/"
)

func userAgentToTemplateVersion(ctx context.Context, logger logger.Logger, userAgent string) (string, error) {
    version := templates.TemplateV2LatestVersion   // 默认 v2.1.0

    for agent := range strings.FieldsSeq(userAgent) {
        switch {
        case strings.HasPrefix(agent, jsSDKPrefix):
            sdk := strings.TrimPrefix(agent, jsSDKPrefix)
            ok, err := utils.IsGTEVersion(sdk, templates.SDKTemplateReleaseVersion)
            if err != nil {
                return "", fmt.Errorf("parsing JS SDK version: %w", err)
            }
            if !ok {
                version = templates.TemplateV2BetaVersion  // 降级到 v2.0.0
            }
            return version, nil

        case strings.HasPrefix(agent, pythonSDKPrefix):
            sdk := strings.TrimPrefix(agent, pythonSDKPrefix)
            ok, err := utils.IsGTEVersion(sdk, templates.SDKTemplateReleaseVersion)
            // 同上
            return version, nil
        }
    }

    logger.Debug(ctx, "Unrecognized user agent, defaulting to the latest template version", ...)
    return version, nil
}
```

### 14.3 版本选择规则

| 客户端 | UA 检测 | 模板版本 |
|---|---|---|
| JS SDK ≥ 2.3.0 | `e2b-js-sdk/2.3.0` | `v2.1.0`(Latest) |
| JS SDK < 2.3.0 | `e2b-js-sdk/2.1.0` | `v2.0.0`(Beta) |
| Python SDK ≥ 2.3.0 | `e2b-python-sdk/2.3.0` | `v2.1.0` |
| Python SDK < 2.3.0 | `e2b-python-sdk/2.0.0` | `v2.0.0` |
| 无 SDK UA(curl 等)| 不识别 | `v2.1.0`(Latest)+ Debug 日志 |
| v1 入口 | 写死 | `v1.0.0`(`deprecated_template_request_build.go:209`)|
| v3 入口 | 不读 UA | `v2.1.0`(`template_request_build_v3.go:132`)|

`utils.IsGTEVersion(sdk, "2.3.0")` 用 semver 比较,确保 `2.3.1`、`2.4.0`、`3.0.0` 都判 true。

---

## 十五、管理员批量取消

`admin_cancel_team_builds.go:19-106` 是一个 admin-only 端点,用于一键取消 team 的所有可取消构建。

### 15.1 流程

```
PostAdminTeamsTeamIDBuildsCancel(teamID)
  ├─► GetCancellableTemplateBuildsByTeam(teamID)
  │     // SELECT FROM active_template_builds WHERE team_id=$1 AND created_at > NOW() - 1d
  ├─► errgroup.SetLimit(10)        // 并发上限 10
  ├─► for each build:
  │     wg.Go(func() error {
  │         if b.ClusterNodeID != nil:
  │             deleteErr = templateManager.DeleteBuild(buildID, templateID, clusterID, *b.ClusterNodeID)
  │             if deleteErr: failedCount++; return nil
  │         templateManager.SetStatus(buildID, Failed, "cancelled by admin")
  │         if err: failedCount++
  │         else: cancelledCount++
  │         return nil
  │     })
  ├─► wg.Wait()
  └─► 200 OK {CancelledCount, FailedCount}
```

### 15.2 关键细节

- **并发上限 10**(`:42`):避免一次取消几百个构建时把 template-manager 压垮
- **`atomic.Int64` 计数器**(`:38-39`):errgroup 内部并发安全
- **errgroup 但不返回错误**(`:45` 每个 goroutine 都 `return nil`):不希望单个失败影响其他构建的取消
- **状态原因固定** `"cancelled by admin"`(`:66`):写到 `env_builds.reason` 列,方便审计

### 15.3 `GetCancellableTemplateBuildsByTeam` SQL

```sql
-- builds/get_inprogress_builds.sql
SELECT atb.build_id, atb.template_id, e.cluster_id, b.cluster_node_id
FROM public.active_template_builds atb
JOIN public.env_builds b ON b.id = atb.build_id
JOIN public.envs e ON e.id = atb.template_id
WHERE atb.team_id = $1
  AND atb.created_at > NOW() - INTERVAL '1 day'
ORDER BY atb.build_id;
```

时间窗口 1 天:不取消超过 1 天的旧构建(那些应该已经因 `syncWaitingStateDeadline` 自然 fail 了)。

---

## 十六、关键时序图

### 16.1 v3 完整构建时序

```
  SDK / CLI                CP API                     TemplateManager           Orchestrator
  ────────                 ──────                     ────────────────          ────────────
  POST /v3/templates
  {name: "x:v1"}     ──►   PostV3Templates
                            ├─ GetTeam
                            ├─ ParseName("x:v1")
                            ├─ ResolveAliasWithMetadata
                            ├─ RegisterBuild (DB tx)
                            │  ├─ CreateOrUpdateTemplate
                            │  ├─ InvalidateUnstartedTemplateBuilds
                            │  ├─ CreateTemplateBuild (status=waiting)
                            │  ├─ CreateTemplateAlias
                            │  ├─ CreateTemplateBuildAssignment
                            │  └─ CreateActiveTemplateBuild
                            ├─ InvalidateAlias (cache)
                            └─ Posthog event
  ◄──   202 {buildID, templateID}

  POST /v2/templates/{tid}/builds/{bid}
  {fromImage: "ubuntu:22.04"}  ─►  PostV2TemplatesTemplateIDBuildsBuildID
                                    ├─ GetTemplateBuildWithTemplate
                                    ├─ CheckAndCancelConcurrentBuilds
                                    │   └─ (可能有旧构建被取消)
                                    ├─ GetAvailableBuildClient
                                    ├─ UpdateTemplateBuild (写 ClusterNodeID)
                                    └─ CreateTemplate              ──►
                                                          ├─ fcversion.New
                                                          ├─ setTemplateSource
                                                          ├─ gRPC TemplateCreate  ──►  开始构建 rootfs
                                                          ├─ SetStatus(InProgress)
                                                          └─ go BuildStatusSync
  ◄──   202                                                  │
                                                              │ 每秒 poll
                                                              ▼
  GET .../status  ────────►  GetTemplatesTemplateIDBuildsBuildIDStatus
                              └─ templateBuildsCache.Get      │
  ◄──   200 {status:building, logs:[...]}                    │
                                                              │ ... 多次轮询 ...
                                                              ▼
                                                        gRPC status: Completed
                                                              │
                                                        SetFinished
                                                          ├─ FinishTemplateBuild SQL
                                                          └─ DELETE FROM active_template_builds
                                                              │
  GET .../status  ────────►                                  │
  ◄──   200 {status:ready}
```

### 16.2 失败 + 取消并发构建时序

```
build #1 (in_progress)            build #2 (注册)
        │                              │
        │                      PostV3Templates
        │                              │
        │                      RegisterBuild (status=waiting)
        │                              │
        │                  POST /v2/.../builds/{bid2}
        │                              │
        │                  CheckAndCancelConcurrentBuilds
        │                              │
        │   ◄──── DeleteBuilds([bid1]) ─┤
        │                              │
   gRPC TemplateBuildDelete              │
   停止 rootfs 构建                      │
   释放资源                              │
        │                              │
   SetStatus(Failed)                    │
   "cancelled by ..."                   │
        │                              │
        ▼                          CreateTemplate (build #2)
   status=failed                       │
                                       ▼
                                  status=in_progress
```

### 16.3 waiting 超时清理时序

```
build (status=waiting, CreatedAt = T0)

  T0+1m    BuildsStatusPeriodicalSync
            ├─ BuildStatusSync
            └─ StatusGroup==Pending && time.Since(CreatedAt) < 40m
               → return nil(等下次同步)

  T0+40m   BuildsStatusPeriodicalSync
            ├─ BuildStatusSync
            └─ time.Since(CreatedAt) > 40m
               → SetStatus Failed ("build is in waiting state for too long")
               → return error
```

---

## 十七、配置项与 feature flags

### 17.1 Feature flags(`packages/shared/pkg/featureflags/flags.go`)

| Flag | 类型 | 默认值 | 行号 | 用途 |
|---|---|---|---|---|
| `BuildFirecrackerVersion` | string | `DEFAULT_FIRECRACKER_VERSION` env | `:482` | RegisterBuild 时 seed 到 env_builds.firecracker_version |
| `BuildKernelVersion` | string | `DEFAULT_KERNEL_VERSION` env | `:483` | RegisterBuild 时 seed 到 env_builds.kernel_version |
| `BuildNodeInfo` | JSON | `ldvalue.Null()` | `:486` | 指定偏好的 builder 节点机器配置(CPU arch/family 等)|

> 注:`BuildFirecrackerVersion`/`BuildKernelVersion` 标记为 `Deprecated`,见 `register_build.go:42-47` 的 TODO(ENG-3852)。orchestrator 自己解析版本,并通过 `TemplateBuildMetadata` 回报实际使用的版本。

### 17.2 Team 配额(`auth/pkg/types/limits.go`)

```go
type TeamLimits struct {
    SandboxConcurrency int64
    BuildConcurrency   int64
    MaxLengthHours     int64

    MaxVcpu  int64
    MaxRamMb int64
    DiskMb   int64

    EventsTTLDays int64
}
```

`TeamLimits` 是 `auth/types.Team.Limits` 字段的类型(指针)。`BuildConcurrency` 来自 `tier.concurrent_template_builds + addons.extra_concurrent_template_builds`(见 migration `20251011200438_create_addons_table.sql:38`),通过 `GetTeam` → team cache → DB 加载,在 `RegisterBuild` 中作为软并发上限(`register_build.go:88-99`)。

### 17.3 常量

| 常量 | 值 | 文件 | 用途 |
|---|---|---|---|
| `syncInterval` | `1 * time.Minute` | `template_manager.go:56` | BuildsStatusPeriodicalSync 周期 |
| `buildTimeout` | `1 * time.Hour` | `template_status.go:20` | 单个 build 构建超时 |
| `syncWaitingStateDeadline` | `40 * time.Minute` | `template_status.go:21` | waiting 状态超时 |
| `maxLogEntriesPerRequest` | `100` | `template_build_status.go:25` | 单次 logs 响应上限 |
| Posthog 事件名 | `"submitted environment build request"` | `template_request_build_v3.go:154` | v3 Posthog 事件 |
| Posthog 事件名 | `"built environment"` | `template_start_build_v2.go:189` | v2 trigger Posthog 事件 |

---

## 十八、关键代码文件索引

| 文件 | 关键符号 | 行号 |
|---|---|---|
| `packages/api/internal/handlers/template_request_build_v3.go` | `PostV3Templates`, `requestTemplateBuild` | `:24`, `:41` |
| `packages/api/internal/handlers/template_start_build_v2.go` | `PostV2TemplatesTemplateIDBuildsBuildID`, `userAgentToTemplateVersion`, `dockerfileStore` | `:40`, `:208`, `:33` |
| `packages/api/internal/handlers/template_build_status.go` | `GetTemplatesTemplateIDBuildsBuildIDStatus`, `getCorrespondingTemplateBuildStatus`, `filterStepLogs`, `maxLogEntriesPerRequest` | `:28`, `:149`, `:178`, `:25` |
| `packages/api/internal/handlers/template_build_logs.go` | `GetTemplatesTemplateIDBuildsBuildIDLogs` | `:19` |
| `packages/api/internal/handlers/deprecated_template_request_build.go` | `PostTemplates`, `PostTemplatesTemplateID`, `buildTemplate` | `:25`, `:77`, `:156` |
| `packages/api/internal/handlers/deprecated_template_start_build.go` | `CheckAndCancelConcurrentBuilds`, `PostTemplatesTemplateIDBuildsBuildID` | `:31`, `:79` |
| `packages/api/internal/handlers/admin_cancel_team_builds.go` | `PostAdminTeamsTeamIDBuildsCancel` | `:19` |
| `packages/api/internal/template/register_build.go` | `RegisterBuildData`, `RegisterBuildResponse`, `RegisterBuild` | `:28`, `:50`, `:58` |
| `packages/api/internal/template-manager/template_manager.go` | `TemplateManager`, `New`, `BuildsStatusPeriodicalSync`, `GetAvailableBuildClient`, `GetClusterResources`, `GetClusterBuildClient`, `DeleteBuild`, `DeleteBuilds`, `GetStatus` | `:36`, `:59`, `:80`, `:111`, `:142`, `:151`, `:165`, `:206`, `:217` |
| `packages/api/internal/template-manager/create_template.go` | `CreateTemplate`, `convertTemplateSteps`, `convertImageRegistry`, `setTemplateSource`, `FromTemplateError` | `:37`, `:206`, `:229`, `:289`, `:24` |
| `packages/api/internal/template-manager/template_status.go` | `BuildStatusSync`, `PollBuildStatus`, `SetStatus`, `SetFinished`, `buildTimeout`, `syncWaitingStateDeadline` | `:24`, `:91`, `:270`, `:310`, `:20-21` |
| `packages/shared/pkg/templates/versions.go` | `TemplateV1Version`, `TemplateV2LatestVersion`, `TemplateV2BetaVersion`, `SDKTemplateReleaseVersion` | `:9`, `:4`, `:7`, `:13` |
| `packages/db/pkg/types/types.go` | `BuildStatus*`, `BuildStatusGroup*` | `:143-168` |
| `packages/db/queries/builds/get_concurrent_template_builds.sql` | `GetConcurrentTemplateBuilds` | — |
| `packages/db/queries/builds/get_inprogress_builds.sql` | `GetInProgressTemplateBuilds`, `GetInProgressTemplateBuildsByTeam`, `GetCancellableTemplateBuildsByTeam` | — |
| `packages/db/queries/builds/active_template_builds.sql` | `CreateActiveTemplateBuild`, `DeleteActiveTemplateBuild` | — |
| `packages/db/queries/builds/finish_template_build.sql` | `FinishTemplateBuild`(含 `active_template_builds` 删除)| — |
| `packages/shared/pkg/grpc/template-manager/` | gRPC stub:`TemplateCreate`, `TemplateBuildDelete`, `TemplateBuildStatus` | — |
| `spec/openapi.yml` | 端点定义 | `/v3/templates:2736`, `/v2/templates/{tid}/builds/{bid}:3071`, `/templates/{tid}/builds/{bid}/status:3133`, `/templates/{tid}/builds/{bid}/logs:3183`, `/admin/teams/{tid}/builds/cancel:3476` |

---

## 十九、设计要点与权衡

### 19.1 为什么把「注册」和「触发」拆开?

**注册**(`POST /v3/templates`)只落 DB,不分配节点、不调 gRPC;**触发**(`POST /v2/.../builds/{bid}`)才真正选节点 + 启动构建。这样设计的好处:

1. **CP API 不会卡在 orchestrator 慢响应上**:注册几毫秒就返回
2. **客户端可以重试触发**:`buildID` 已经存在,触发失败可以再调一次(前提是状态仍是 pending)
3. **允许「先创建模板再慢慢配 dockerfile」**:CI 流水线可以先 reserve 一个 templateID,稍后再来触发

代价:调用方必须发两次请求。SDK 通常把这层复杂性隐藏掉。

### 19.2 为什么后台 goroutine 用 `context.WithoutCancel`?

`create_template.go:201` 把 `ctx` 包成 `context.WithoutCancel(ctx)` 再传给 goroutine。原因是:HTTP 请求返回后,gin 会 cancel 掉 `c.Request.Context()`;如果不 detach,后台的 `BuildStatusSync` 会立刻退出,导致构建状态永远不被同步。

### 19.3 为什么 `processing` map 是必须的?

`BuildStatusSync` 会被两个来源并发调用:
- `CreateTemplate` 启动的后台 goroutine(`create_template.go:190`,立即触发)
- `BuildsStatusPeriodicalSync`(`template_manager.go:99`,每分钟巡检)

如果没有去重,这两条路径在同一 buildID 上可能同时跑轮询循环,导致:
- gRPC `TemplateBuildStatus` 调用次数翻倍
- DB `SetStatus` 竞争(虽然 SQL 是幂等的,但日志会乱)
- 信号量浪费

`processing` map 用 `sync.Mutex` 保护,简单有效。

### 19.4 为什么用 `active_template_builds` 表而不是直接 COUNT(env_builds)?

`GetInProgressTemplateBuildsByTeam` 查的是 `active_template_builds`,而不是 `env_builds WHERE status_group IN (...)`。原因:
- `env_builds` 表很大(每次构建一行),COUNT 慢
- `active_template_builds` 只保留当前活跃构建,行数少
- 终态构建会通过 `FailTemplateBuildAndDeactivate` / `FinishTemplateBuild` 的 `DELETE FROM active_template_builds` 自动清理

### 19.5 为什么 `FinishTemplateBuild` 用 `WITH deactivated AS (DELETE ...)`?

`builds/finish_template_build.sql`:

```sql
WITH deactivated AS (
    DELETE FROM public.active_template_builds WHERE build_id = @build_id
)
UPDATE "public"."env_builds"
SET finished_at = NOW(), ...
WHERE id = @build_id;
```

CTE + DELETE + UPDATE 在同一语句里:这是为了**原子性**。如果分两条 SQL,可能出现「active_template_builds 已删但 env_builds 还显示 building」的中间状态,此时若 `BuildsStatusPeriodicalSync` 触发,会误判这个 build 已不在 active 集合中。

### 19.6 为什么 template 版本号要在 CP API 决定,而不是 orchestrator?

TODO(ENG-3852)的注释(`register_build.go:42-47`)说得很清楚:这是个历史包袱。当前流程是 CP API 把 `TemplateV2LatestVersion` 通过 gRPC 传给 orchestrator;目标是 orchestrator 自己解析(通过 `BuildFirecrackerVersion`/`BuildKernelVersion` feature flag)并回报实际使用的版本。

### 19.7 为什么 v1 不接受 ApiKeyAuth?

`POST /templates/{tid}/builds/{bid}`(v1)只接受 `AccessTokenAuth` + `AuthProviderBearerAuth`,不接受 `ApiKeyAuth`(`spec/openapi.yml:3056-3059`)。代码中没有注释明确说明动机——这只是 v1 时代「仅支持 user-scoped 鉴权」的历史实现(v1 handler 内部用 `auth.MustGetUserID(c)`,且 Posthog 发的是 `CreateAnalyticsUserEvent`)。v2 之后鉴权扩展到 ApiKeyAuth + AdminApiKeyAuth,但代码并未把这一变化和具体的业务约束(如「docker push 需要 access token」)挂钩。

---

## 二十、常见问题与排查

### Q1:为什么我注册成功,但 trigger 时报「build is not in waiting state」?

`template_start_build_v2.go:110-115` 在 trigger 时检查 `build.StatusGroup == Pending`,如果不是就 400。可能原因:
- 同一 buildID 已经被触发过(状态已变成 in_progress)
- `BuildsStatusPeriodicalSync` 已经把它推进到 in_progress(罕见,通常 pending 持续不超过 1 分钟)
- 之前的 `BuildStatusSync` 在 40 分钟后把它 fail 了

排查:`SELECT id, status, status_group, created_at FROM env_builds WHERE id = '<buildID>'`。

### Q2:为什么注册时返回 429?

`RegisterBuild` 检查 `otherBuildCount >= Team.Limits.BuildConcurrency`(`register_build.go:88-99`)。计算规则:
- 查 `active_template_builds` 中 `team_id = me`、`created_at > NOW() - 1d`
- 排除同 template + 同 tags 的部分
- 如果 count ≥ `team_limits.concurrent_template_builds`,429

排查:`SELECT COUNT(*) FROM active_template_builds WHERE team_id='<team>' AND created_at > NOW() - INTERVAL '1 day'`。

### Q3:为什么 `GET .../status` 返回 200 但 logs 是空?

`template_build_status.go:70-82`:如果 `buildInfo.BuildStatus == Pending`,直接返回空 logs + status=`waiting`,**不查 cluster**。可能原因:
- 注册了但还没触发(没调 `POST /v2/.../builds/{bid}`)
- 触发了但还没被 `BuildStatusSync` 推进到 in_progress(通常 1 秒内)

### Q4:为什么管理员的批量取消有时 `FailedCount > 0`?

`admin_cancel_team_builds.go` 的 errgroup 中,如果 `templateManager.DeleteBuild` 失败(节点不可达)或 `SetStatus` 失败(DB 错误),`failedCount++`。但即使失败,也不会阻塞其他构建的取消——errgroup 中每个 goroutine 都 `return nil`。排查:看 logger 中的 `"Failed to delete build on node"` 和 `"Failed to set build status to failed"` 错误日志。

### Q5:为什么构建停在了 `building` 状态超过 1 小时?

`buildTimeout = time.Hour`(`template_status.go:20`)。理论上 `PollBuildStatus.poll` 在 ctx done 时会 `SetStatus Failed`。如果状态真的卡住,可能原因:
- `BuildStatusSync` 因为 `processing` map 已存在而跳过(map 没被清理,极端情况)
- `SetStatus` 本身 DB 写入失败
- gRPC 调用全部超时但 retrier 把错误吞了(罕见)

排查:看 `template-manager` 的日志搜索 `buildID`,确认是否仍在 polling。

### Q6:跨 team 用同一个 alias 行不行?

**全局层面不行**。`register_build.go:252-272` 的 `CheckAliasConflictsWithTemplateID` 检查的是 alias 全局唯一(被任意其他 template 占用就 409)。`aliases` 表的 alias 列本身有唯一性约束,所以两个 team 不能用相同的 alias。

但是 v3 入口的 `template_request_build_v3.go:101-108` 有一个**前置分支**:如果 alias 命中其他 team 的模板(常见于 promoted template),当前 team 仍可以选择**新的 templateID** 在自己的 namespace 建一个新模板——但这个新模板必须用**不同的 alias**。RegisterBuild 阶段不会再走到这个分支,因为 v3 在调用前就已经生成了新的 templateID。

唯一能「复用 alias」的场景是 `aliasDB.EnvID == data.TemplateID`(`:325`):同一个 template 多次 build 自然复用同一个 alias。

### Q7:`dockerfileStore` 的 JSON 是什么格式?

`template_start_build_v2.go:33-37`:

```json
{
  "from_image": "ubuntu:22.04",
  "from_template": null,
  "steps": null
}
```

或:

```json
{
  "from_image": null,
  "from_template": "base-tmpl:v1",
  "steps": [
    {"type": "RUN", "args": ["apt-get", "update"], ...}
  ]
}
```

这个 JSON 存到 `env_builds.dockerfile` 列(列名是历史遗留,v1 时代真的存 Dockerfile 文本)。

### Q8:`PostTemplates`(v1)和 `PostV3Templates` 的本质区别?

两者都是「两步走」(注册 + 触发),区别在注册阶段携带什么:

- **v1 `POST /templates`**:注册时必须携带完整 Dockerfile 文本(`TemplateBuildRequest.Dockerfile string` 必填,`api.gen.go:1217`);后续通过 `POST /templates/{tid}/builds/{bid}` 触发
- **v3 `POST /v3/templates`**:注册时只携带 `Name/Tags/CpuCount/MemoryMB`(**不携带构建源**);构建源(FromImage/FromTemplate/Steps)推迟到 `POST /v2/templates/{tid}/builds/{bid}` 触发阶段才提交

另一个差异是版本号:v1 写死 `TemplateV1Version`(`deprecated_template_request_build.go:209`),v3 写死 `TemplateV2LatestVersion`(`template_request_build_v3.go:132`)。

### Q9:`BuildNodeInfo` feature flag 是干什么的?

`template_manager.go:120-122`:

```go
nodeInfoJSON := tm.featureFlags.JSONFlag(ctx, featureflags.BuildNodeInfo)
nodeInfo := machineinfo.FromLDValue(ctx, nodeInfoJSON)
builder, err := cluster.GetAvailableTemplateBuilder(ctx, nodeInfo)
```

允许通过 LaunchDarkly 指定「优先选择某种 CPU 架构/Family/Model 的 builder 节点」。比如新引入 ARM builder 时,可以渐进迁移:让特定 cluster 的 build 都走 ARM,验证兼容性后再全量切换。如果指定 nodeInfo 没有匹配的 builder,fallback 到任意 builder(`:128`)。

### Q10:`StatusGroup` 和 `Status` 字段什么关系?

数据库列:
- `env_builds.status`:原始值,如 `waiting`/`building`/`uploaded`/`failed`/`snapshotting`/`success`
- `env_builds.status_group`:计算列,把 `status` 归一到 4 个 group:`pending`/`in_progress`/`ready`/`failed`

代码里几乎只读 `status_group`,只在 `CreateTemplateBuild` 写入时指定 `status=waiting`(`register_build.go:221`)。

---

## 附录 A:`env_builds` 状态映射

### A.1 `BuildStatus`(写端)→ `BuildStatusGroup`(读端)

| `BuildStatus`(原始) | `BuildStatusGroup`(归一) | 出现场景 |
|---|---|---|
| `pending` | `pending` | 新代码 TODO(ENG-3469)未启用 |
| `waiting` | `pending` | `CreateTemplateBuild` 初值 |
| `building` | `in_progress` | `SetStatus(InProgress)` |
| `snapshotting` | `in_progress` | orchestrator 内部状态 |
| `uploaded` | `ready` | `SetFinished` 写入 |
| `success` | `ready` | 历史值,新代码用 `uploaded` |
| `failed` | `failed` | `SetStatus(Failed)` |

### A.2 `BuildStatusGroup`(DB)→ `TemplateBuildStatus`(API)

| `BuildStatusGroup` | `TemplateBuildStatus` | HTTP 状态码 |
|---|---|---|
| `pending` | `waiting` | 200 |
| `in_progress` | `building` | 200 |
| `ready` | `ready` | 200 |
| `failed` | `error` | 200 |
| 未知 | `building`(默认) | 200 |

### A.3 终态判定

`types.BuildStatusGroup.IsTerminal()`(`types.go:166-168`):

```go
func (g BuildStatusGroup) IsTerminal() bool {
    return g == BuildStatusGroupReady || g == BuildStatusGroupFailed
}
```

终态写入走 `FailTemplateBuildAndDeactivate`(同时删 `active_template_builds`),非终态走 `UpdateEnvBuildStatus`。

---

## 附录 B:关键 SQL 查询

### B.1 `GetConcurrentTemplateBuilds`

```sql
-- packages/db/queries/builds/get_concurrent_template_builds.sql
-- name: GetConcurrentTemplateBuilds :many
SELECT DISTINCT eb.* FROM env_build_assignments eba
JOIN env_builds eb ON eb.id = eba.build_id
WHERE
    eba.env_id = @template_id
    AND eb.status_group IN ('pending', 'in_progress')
    AND eb.id != @current_build_id
    AND eba.tag IN (
        SELECT tag FROM env_build_assignments
        WHERE build_id = @current_build_id AND env_id = @template_id
    );
```

### B.2 `GetInProgressTemplateBuilds`(用于定时巡检)

```sql
-- packages/db/queries/builds/get_inprogress_builds.sql
-- name: GetInProgressTemplateBuilds :many
SELECT DISTINCT ON (b.id) t.cluster_id AS team_cluster_id, sqlc.embed(e), sqlc.embed(b)
FROM public.env_builds b
JOIN public.env_build_assignments eba ON eba.build_id = b.id
JOIN public.active_envs e ON e.id = eba.env_id
JOIN public.teams t ON e.team_id = t.id
WHERE b.status_group IN ('pending', 'in_progress')
  AND e.source = 'template'
ORDER BY b.id, b.created_at DESC;
```

### B.3 `GetInProgressTemplateBuildsByTeam`(用于软并发上限)

```sql
-- name: GetInProgressTemplateBuildsByTeam :one
-- Relies on active_template_builds table (migration 20260305130000).
SELECT COUNT(*) as build_count
FROM public.active_template_builds atb
WHERE atb.team_id = sqlc.arg(team_id)::uuid
  AND atb.created_at > NOW() - INTERVAL '1 day'
  AND NOT (
    atb.template_id = sqlc.arg(exclude_template_id)::text
    AND atb.tags && sqlc.arg(exclude_tags)::text[]
  );
```

### B.4 `GetCancellableTemplateBuildsByTeam`(管理员批量取消)

```sql
-- name: GetCancellableTemplateBuildsByTeam :many
SELECT atb.build_id, atb.template_id, e.cluster_id, b.cluster_node_id
FROM public.active_template_builds atb
JOIN public.env_builds b ON b.id = atb.build_id
JOIN public.envs e ON e.id = atb.template_id
WHERE atb.team_id = $1
  AND atb.created_at > NOW() - INTERVAL '1 day'
ORDER BY atb.build_id;
```

### B.5 `CreateActiveTemplateBuild` / `DeleteActiveTemplateBuild`

```sql
-- packages/db/queries/builds/active_template_builds.sql
-- name: CreateActiveTemplateBuild :exec
INSERT INTO public.active_template_builds (
    build_id, team_id, template_id, tags
) VALUES (
    @build_id, @team_id, @template_id, @tags::text[]
);

-- name: DeleteActiveTemplateBuild :exec
DELETE FROM public.active_template_builds WHERE build_id = @build_id;
```

### B.6 `FinishTemplateBuild`(原子完成 + 移除 active)

```sql
-- packages/db/queries/builds/finish_template_build.sql
-- name: FinishTemplateBuild :exec
WITH deactivated AS (
    DELETE FROM public.active_template_builds WHERE build_id = @build_id
)
UPDATE "public"."env_builds"
SET
    finished_at = NOW(),
    total_disk_size_mb = @total_disk_size_mb,
    status = @status,
    envd_version = @envd_version,
    kernel_version = COALESCE(NULLIF(@kernel_version::text, ''), kernel_version),
    firecracker_version = COALESCE(NULLIF(@firecracker_version::text, ''), firecracker_version)
WHERE id = @build_id;
```

注意 `COALESCE(NULLIF(@x::text, ''), x)`:如果 template-manager 没填版本(老版本兼容),保留 CP API 注册时 seed 的原值,不会被空字符串覆盖。

---

## 附录 C:术语表

| 术语 | 含义 |
|---|---|
| **template / env** | 同义,都指「模板」。代码中表名是 `envs`,API 中是 `template`,本文交替使用 |
| **build / env_build** | 一次构建,对应 `env_builds` 表一行 |
| **templateID** | 模板 ID(`envs.id`,text),全局唯一 |
| **buildID** | 构建 ID(`env_builds.id`,uuid),每次构建独立 |
| **alias** | 模板的人类可读名,如 `"my-tmpl"`(不带 namespace) |
| **name** | 带命名空间的 alias,如 `"team-slug/my-tmpl"`,用于唯一索引 |
| **tag** | 模板的版本标签,如 `"v1"`、`"dev"`、`"default"` |
| **namespace** | team slug,用于 alias 隔离 |
| **status / status_group** | 原始状态值 / 归一化状态(详见附录 A) |
| **pending / waiting** | DB 原始 status 都归一到 `BuildStatusGroupPending` |
| **in_progress** | `BuildStatusGroupInProgress`,正在构建 |
| **ready / uploaded** | DB 原始 `uploaded`/`success` 归一到 `BuildStatusGroupReady` |
| **failed** | 终态,构建失败 |
| **building** | 既指原始 `status='building'`,也指 API `TemplateBuildStatusBuilding` |
| **active_template_builds** | 当前活跃构建的"小表",用于快速 COUNT 并发数 |
| **env_build_assignments** | build 与 template 的 tag 关联表(一个 build 可关联多个 tag) |
| **template-manager** | orchestrator 进程内的 gRPC 服务,负责实际 rootfs 构建 |
| **TemplateManager**(CP API 内) | CP API 中调用 template-manager gRPC 的客户端封装 |
| **RegisterBuild** | 「注册」阶段,只写 DB,不触发 gRPC |
| **CreateTemplate** | 「触发」阶段,调 gRPC `TemplateCreate`,启动实际构建 |
| **BuildStatusSync** | 后台轮询某个 build 的状态,直到终态 |
| **BuildsStatusPeriodicalSync** | 每分钟巡检所有 active builds 的后台任务 |
| **CheckAndCancelConcurrentBuilds** | 触发前取消同 template + 同 tag 的旧 in_progress build |
| **FromImage / FromTemplate / Steps** | 三种「构建源」(base 镜像 / base 模板 / 步骤数组) |
| **FromImageRegistry** | 私有 registry 凭证(AWS/GCP/General 三种) |
| **dockerfileStore** | v2 trigger 中序列化的构建源 JSON,存到 `env_builds.dockerfile` 列 |
| **BuildNodeInfo** | feature flag,指定偏好的 builder 节点机器配置 |
| **SDKTemplateReleaseVersion** | `"2.3.0"`,JS/Python SDK 必须达到此版本才能用 `v2.1.0` 模板 |
| **TemplateV1/V2Latest/V2Beta** | 模板版本:`v1.0.0` / `v2.1.0` / `v2.0.0` |
| **PollBuildStatus** | `BuildStatusSync` 内部的每秒轮询器 |
| **buildTimeout** | 单 build 构建超时(1 小时) |
| **syncWaitingStateDeadline** | waiting 状态超时(40 分钟,超时则 fail) |
| **FailTemplateBuildAndDeactivate** | 终态写入 + 从 active_template_builds 删除 |
| **FinishTemplateBuild** | ready 终态写入 + 删除 active + 回写 kernel/fc 版本 |
