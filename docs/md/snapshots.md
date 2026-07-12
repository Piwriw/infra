# E2B 快照(Snapshot)系统全景

> 范围:从 HTTP API、数据库、orchestrator gRPC、Firecracker、envd 全链路梳理"快照"功能。
> 数据来源:代码与迁移文件,2026-07-10 校对。
> 配套文档:数据库字段见 [`database-schema.md`](./database-schema.md),sandbox 创建/模板拉取见 `sandbox-lifecycle.md` / `template-module.md`。

---

## 目录

- [1. 概念总览](#1-概念总览)
- [2. API 端点](#2-api-端点)
- [3. 数据库层](#3-数据库层)
- [4. 业务流程](#4-业务流程)
- [5. API 层(orchestrator 客户端)](#5-api-层orchestrator-客户端)
- [6. Orchestrator 层(gRPC 服务端)](#6-orchestrator-层grpc-服务端)
- [7. Firecracker 与 envd 协作](#7-firecracker-与-envd-协作)
- [8. 缓存与并发控制](#8-缓存与并发控制)
- [9. 配置项与 Feature Flags](#9-配置项与-feature-flags)
- [10. 关键文件清单](#10-关键文件清单)

---

## 1. 概念总览

E2B 的"快照"在四个层次上有不同语义,理解清楚再读代码:

| 概念 | 含义 | 生命周期 |
| --- | --- | --- |
| **Pause(暂停)** | 把运行中 sandbox 的内存 + 磁盘状态持久化 | sandbox 进入 `paused` 状态,后续可 resume |
| **Snapshot row(快照记录)** | `snapshots` 表中的一行,记录一次 pause 的元数据 | 跟随 sandbox,直到 sandbox 被删除 |
| **Snapshot template(快照模板)** | 把某次 pause 提升为**可被反复 spawn** 的模板 | 独立持久化,在 `snapshot_templates` 表 + `envs.source='snapshot_template'` |
| **Checkpoint(检查点)** | Pause + 立即 resume + 提升为快照模板的组合操作 | 原沙箱继续运行,另存为快照模板 |

### 1.1 两种快照数据模式

| 模式 | 字段标识 | 持久化内容 | Resume 行为 |
| --- | --- | --- | --- |
| **Memory snapshot**(默认) | `filesystem_only = false` | memfile(内存 diff)+ rootfs diff + snapfile(VM 状态) | 通过 uffd 按需加载内存页,**完整恢复**内存 |
| **Filesystem-only snapshot** | `filesystem_only = true` | 只 rootfs diff(无 memfile / snapfile) | 冷启动 reboot,**内存丢失** |

Memory snapshot 是默认路径。Filesystem-only 用于:auto-pause 优化成本、不需要内存状态的快照。

### 1.2 状态机

```
Running ──pause──→ Snapshotting ──┐
                                  ↓
                                  Paused ──resume──→ Running

Running ──checkpoint──→ Snapshotting ──→ Running(原沙箱恢复)
                            │
                            └──→ Snapshot Template(独立 env,可被 spawn)
```

> 沙箱状态管理在 `packages/api/internal/sandbox/store.go`,动作集合为 `StateActionPause` / `StateActionSnapshot` / `StateActionKill`(`packages/api/internal/sandbox/aliases.go:58-60` re-export 自 `db/types`)。**没有 `StateActionResume`** — Resume 不走状态机,而是直接复用 sandbox 创建路径(`CreateSandbox` with `isResume=true`)。

---

## 2. API 端点

来源:`spec/openapi.yml`

| 方法 | 路径 | Handler | 作用 |
| --- | --- | --- | --- |
| POST | `/sandboxes/{sandboxID}/pause` | `PostSandboxesSandboxIDPause` | 暂停 sandbox(默认 memory snapshot) |
| POST | `/sandboxes/{sandboxID}/snapshots` | `PostSandboxesSandboxIDSnapshots` | **创建快照模板**(checkpoint 语义) |
| POST | `/sandboxes/{sandboxID}/resume` | `PostSandboxesSandboxIDResume` | 显式 resume(deprecated,新代码用 connect) |
| POST | `/sandboxes/{sandboxID}/connect` | `PostSandboxesSandboxIDConnect` | 自动 resume:已暂停则 resume,运行中只返回详情 |
| GET | `/snapshots` | `GetSnapshots` | 列出团队快照模板(分页,支持按 sandboxID/name 过滤) |
| DELETE | `/sandboxes/{sandboxID}` | `DeleteSandboxesSandboxID` | 删除 sandbox(同步软删除其快照模板) |

### 2.1 创建快照模板的请求/响应

**请求** `POST /sandboxes/{sandboxID}/snapshots`:
```json
{
  "name": "my-team/my-snapshot:v1"  // 可选;格式 [namespace/]alias[:tag]
}
```

**响应** `201 Created`:
```json
{
  "snapshot_id": "my-team/my-snapshot:v1",
  "names": ["my-team/my-snapshot"]
}
```

- 若 `name` 省略:返回 `snapshot_id` 为纯 env ID + 默认 tag,`names` 为空数组
- 若 `name` 指定且 alias 已属于本团队:**复用现有 template**(只追加新 build assignment)
- 若 `name` 指定且 alias 不存在或属于其他团队:**新建** env + alias

### 2.2 列表游标分页

`GET /snapshots` 用游标分页:

```
GET /snapshots?limit=100&next_token=<base64>
              &sandboxID=<filter>
              &name=<filter, e.g. "my-team/my-snapshot:v1">
```

游标由 `(created_at DESC, id DESC)` 组成,默认 limit 100,最大 100。

---

## 3. 数据库层

### 3.1 涉及的表

| 表 | 角色 |
| --- | --- |
| [`snapshots`](./database-schema.md#snapshots) | 每次 pause/checkpoint 一行,记录 sandbox 暂停状态 |
| [`snapshot_templates`](./database-schema.md#snapshot_templates) | 提升为可复用模板的快照,以 `env_id` 为主键 |
| [`envs`](./database-schema.md#envs) | 快照模板会创建一个 `source='snapshot_template'` 的新 env;Pause 创建 `source='snapshot'` 的 env |
| [`env_builds`](./database-schema.md#env_builds) | 每次 pause 创建一个新 build,**从源 build 复制 CPU info** |
| [`env_build_assignments`](./database-schema.md#env_build_assignments) | link env 与 build,带 tag |

### 3.2 关键 SQL 查询

源文件:`packages/db/queries/snapshots/*.sql`,通过 sqlc 生成 Go 代码。

#### `UpsertSnapshot`(`create_new_snapshot.sql`)

最复杂的查询。一次完成 4 件事:

1. **`new_template` CTE**:首次 pause 时 INSERT 一行到 `envs`(`source='snapshot'`);若 sandbox 已有快照则跳过(WHERE NOT EXISTS)
2. **`snapshot` CTE**:INSERT/UPDATE `snapshots` 表(`ON CONFLICT (sandbox_id) DO UPDATE` — 同一 sandbox 的多次 pause 只更新,不重复)
3. **`new_build` CTE**:INSERT 新 `env_builds` 行,**用 scalar subquery 从 source build 复制 5 个 CPU 字段**:
   ```sql
   cpu_architecture = (SELECT eb.cpu_architecture FROM env_builds eb WHERE eb.id = @source_build_id),
   cpu_family       = (SELECT eb.cpu_family       FROM env_builds eb WHERE eb.id = @source_build_id),
   ...
   ```
   **为什么**:把快照的 CPU 兼容性**绑定到源 build 而不是执行 pause 的节点**,跨 CPU 代际的 pause/resume 才能匹配。
4. **`build_assignment` CTE**:显式 INSERT `env_build_assignments(env_id, build_id, tag='default')`

返回 `(build_id, template_id)`,供 API 层继续 checkpoint。

#### `GetLastSnapshot`(`get_last_snapshot.sql`)

按 `sandbox_id` 取最近一次成功快照,JOIN 4 张表:

```sql
snapshots s
  JOIN active_envs e ON e.id = s.env_id                      -- 跳过软删除 env
  JOIN LATERAL (
    -- 取 status_group='ready' 的最新 build assignment
    SELECT eba.build_id FROM env_build_assignments eba
    JOIN env_builds eb ON eb.id = eba.build_id
                      AND eb.status_group = 'ready'
    WHERE eba.env_id = s.env_id AND eba.tag = 'default'
    ORDER BY eba.created_at DESC LIMIT 1
  ) latest_eba ON TRUE
  JOIN env_builds eb ON eb.id = latest_eba.build_id
  LEFT JOIN LATERAL (
    -- 聚合 base_env 的所有 alias
    SELECT ARRAY_AGG(...) AS aliases, ARRAY_AGG(...) AS names
    FROM env_aliases WHERE env_id = s.base_env_id
  ) ea ON TRUE
```

> **关键**:`status_group='ready'` 过滤掉失败的 build;只取 `tag='default'` 的最新分配。

#### `CreateSnapshotTemplateEnv`(`create_snapshot_template_env.sql`)

把一次 pause **提升**为独立的快照模板:

1. INSERT 新 env(`source='snapshot_template'`)— 注意 source 是 `'snapshot_template'` 不是 `'snapshot'`
2. INSERT 到 `snapshot_templates` 表(`env_id` 作 PK)
3. INSERT `env_build_assignments` 关联 env 与 build(用 `tag` 参数,默认 `'default'`)

#### `ListTeamSnapshotTemplates`(`list_team_snapshot_templates.sql`)

团队级游标分页查询:

```sql
WHERE e.team_id = @team_id
  AND e.source = 'snapshot_template'              -- 只列快照模板
  AND (@sandbox_id IS NULL OR st.sandbox_id = @sandbox_id)
  AND (@env_id IS NULL OR e.id = @env_id)         -- name 解析后的 env
  AND (e.created_at, e.id) < (@cursor_time, @cursor_id)
ORDER BY e.created_at DESC, e.id DESC
LIMIT @page_limit
```

LATERAL 子查询取**最新 ready build**(支持 tag 过滤);如果该 snapshot 没有匹配 tag 的 ready build,这个 snapshot 不会出现在结果中。

#### `GetSnapshotBuilds`(`get_snapshot_builds.sql`)

按 sandbox_id 列出所有 build_id 与对应 cluster_node_id。Kill sandbox 时用,定位需要清理的节点。

#### `UpdateSnapshotOriginNode`(`update_snapshot_origin_node.sql`)

在 resume 成功后(`create_instance.go:448`),如果实际调度的节点不是原 `origin_node_id`,把这个 snapshot 的 origin 改成新的 warmed node。**目的**:下次 resume 优先用已经 cache warm 的节点。受 `ResumeOriginNodeRemapFlag` 控制。

### 3.3 触发器联动

| 触发器 | 何时影响快照 |
| --- | --- |
| `trg_sync_env_source_on_snapshot`(snapshots AFTER INSERT) | 新快照插入时,自动把父 env 标记为 `source='snapshot'` |
| `trg_snapshots_fix_json_null_metadata`(snapshots BEFORE INSERT/UPDATE) | 把 SQL NULL / JSON null 规整为 `'{}'::jsonb`,保证 `metadata` 字段始终可读 |

### 3.4 `snapshots` 关键字段语义

| 字段 | 何时设置 | 用途 |
| --- | --- | --- |
| `sandbox_id` UNIQUE | 首次 pause | 同一 sandbox 只允许一条记录(后续 pause 走 ON CONFLICT UPDATE) |
| `env_id` | 首次 pause(同时创建 `source='snapshot'` 的 env) | 暂存 env,resume 时引用其 builds |
| `base_env_id` | 每次 pause | 父模板 env(原始 sandbox 的 base template) |
| `origin_node_id` | 每次 pause(更新) | 实际执行 pause 的 orchestrator 节点 |
| `auto_pause` | pause 时 | 是否由自动暂停触发(影响计费/恢复策略) |
| `config jsonb` | pause 时 | 完整的 sandbox 重启配置:`{Network, AutoResume, VolumeMounts, FilesystemOnly, AutoPauseFilesystemOnly}` |
| `metadata jsonb` | pause 时 | 用户自定义 KV |
| `sandbox_started_at` | pause 时 | 原 sandbox 启动时间(用于列表排序/计费) |
| `team_id` NOT NULL | pause 时 | 团队归属(resume 时权限校验) |
| `env_secure` | pause 时 | 是否禁用 envd 通信安全 |

### 3.5 API 端 DB 包装

`packages/api/internal/db/snapshots.go` 提供两个薄包装:

- `GetSnapshotBuilds(ctx, db, teamID, sandboxID) (SnapshotBuilds, error)`:展开 sqlc 返回的 left join 结果,过滤 NULL build 行,返回 `ErrSnapshotNotFound` sentinel

---

## 4. 业务流程

### 4.1 Pause 流程(HTTP `/pause` → DB → gRPC → FC)

> 注意:HTTP handler 不直接调 `PauseSandbox`。Pause 复用了 sandbox 的统一删除入口 `RemoveSandbox`,通过 `Action=Pause` 参数分发到内部 `pauseSandbox` 方法(`delete_instance.go:174`)。这样 Pause/Kill/Snapshot 共用同一套状态机和清理逻辑。

```
Client POST /sandboxes/{id}/pause
   │
   ▼
API: PostSandboxesSandboxIDPause (handlers/sandbox_pause.go)
   │  ├─ 鉴权
   │  ├─ ParseOptionalBody → filesystemOnly = (body.Memory != nil && !*body.Memory)
   │  └─ pause.LogInitiated()
   ▼
API: orchestrator.RemoveSandbox(Action=StateActionPause, FilesystemOnly)
   │  ├─ sandboxStore.StartRemoving()  ──→ 状态机 Running → Pausing(独占 transition key)
   │  └─ removeSandboxFromNode()       ──→ switch Action:
   ▼
API: pauseSandbox (orchestrator/pause_instance.go:32)  ← 仅 Action=Pause 走这条分支
   │  ├─ throttledUpsertSnapshot()  ──→ DB: UpsertSnapshot (新建 env+build 或更新 snapshot)
   │  ├─ snapshotInstance()         ──→ gRPC: SandboxService.Pause
   │  ├─ UpdateEnvBuildStatus(Success)
   │  └─ snapshotCache.Invalidate(sandboxID)
   ▼
Orchestrator gRPC: Server.Pause (server/sandboxes.go:599)
   │  ├─ MarkStopping (并发保护)
   │  ├─ snapshotAndCacheSandbox(origin=Pause, filesystemOnly=req)
   │  │    ├─ sbx.Pause()           ──→ Firecracker CreateSnapshot + 内存后处理
   │  │    └─ templateCache.AddSnapshot()  ──→ 本地 cache 加入新 snapshot
   │  ├─ uploadSnapshotAsync()       ──→ 后台异步上传到 GCS(Pause 始终异步)
   │  ├─ harvestResumePrefetchAsync() ──→ 后台预热(可选,仅 memory snapshot)
   │  ├─ defer stopSandboxAsync()    ──→ 异步停止原沙箱
   │  └─ publishSandboxEvent(Paused)
   ▼
返回 SandboxPauseResponse { SchedulingMetadata }
```

### 4.2 Checkpoint 流程(HTTP `/snapshots` → 创建快照模板 + resume)

```
Client POST /sandboxes/{id}/snapshots
   │
   ▼
API: PostSandboxesSandboxIDSnapshots (handlers/snapshot_template_create.go)
   │  ├─ 解析 name → (alias, namespace, tag)
   │  ├─ templateCache.ResolveAlias() ──→ 是否已有此 alias(若本团队已有 → opts.ExistingTemplateID)
   │  ├─ CheckEnvdVersionForSnapshot() ──→ envd 版本兼容检查
   │  └─ orchestrator.CreateSnapshotTemplate(opts)
   ▼
API: orchestrator.CreateSnapshotTemplate (orchestrator/snapshot_template.go)
   │  ├─ sandboxStore.StartRemoving(StateActionSnapshot) ──→ 状态机 Running → Snapshotting
   │  ├─ throttledUpsertSnapshot()  ──→ DB: UpsertSnapshot(强制 filesystemOnly=false)
   │  ├─ resolveOrCreateSnapshotTemplate():
   │  │    ├─ 已有 template → CreateTemplateBuildAssignment(tag)
   │  │    └─ 新建 → CreateSnapshotTemplateEnv() + CreateTemplateAlias()
   │  ├─ gRPC: SandboxService.Checkpoint
   │  ├─ UpdateEnvBuildStatus(Uploaded)
   │  └─ snapshotCache.Invalidate(sandboxID)
   ▼
Orchestrator gRPC: Server.Checkpoint (server/sandboxes.go:699)
   │  ├─ CheckEnvdVersionForSnapshot() (再次校验)
   │  ├─ waitForAcquire (starting semaphore)
   │  ├─ MarkStopping
   │  ├─ snapshotAndCacheSandbox(origin=SnapshotTemplate, filesystemOnly=false)
   │  │    └─ 永远 false —— filesystem-only checkpoint 不支持(resume-in-place 需要 reboot,语义不成立)
   │  ├─ templateCache.GetTemplate(build_id, isSnapshot=true)
   │  ├─ sandboxFactory.ResumeSandbox(keep ExecutionID, fresh LifecycleID)
   │  ├─ MemoryPrefetchData() ──→ 收集预热映射
   │  ├─ templateCache.UpdateMetadata(加 prefetch mapping)
   │  └─ 上传:
   │       ├─ PeerToPeerAsyncCheckpointFlag=on → uploadSnapshotAsync (异步)
   │       └─ off → res.upload.Run(uploadTimeout) 同步等待
   ▼
publishSandboxEvent(Checkpointed)
   │
   ▼
（回到 HTTP handler, PostSandboxesSandboxIDSnapshots 的收尾)
   │  ├─ 若新建了 alias: templateCache.InvalidateAlias(namespace, alias)
   │  └─ templateCache.Invalidate(template_id, &tag)        ← 这一步在 handler,不在 orchestrator
   ▼
返回 201 SnapshotInfo { snapshot_id, names }
```

> **关键差别**:Checkpoint 比 Pause 多了"立即 resume 原沙箱(保留 ExecutionID)"和"创建快照模板 env"两步。原沙箱不会进入 paused 状态,在 Checkpoint 成功后保持 Running。

### 4.3 Resume 流程(HTTP `/connect` / `/resume` → 复用 Create 路径)

> 关键事实:**API 层没有 `ResumeSandbox` 方法**。Resume 走的是 sandbox 创建的同一套代码,只是把 `isResume=true` 传进去,让 `CreateSandbox` 把 snapshot 数据塞到 gRPC 请求里。Orchestrator 端的 `SandboxService.Create` 看到 `req.Sandbox.Snapshot != nil` 就走 snapshot-resume 分支。
>
> `/connect` 是首选入口(deprecated 的 `/resume` 行为基本一致,差别仅在 `/connect` 会先重试 `KeepAliveFor` 几轮)。两条路径最终都调 `startSandbox(snapshot=true)`。

```
Client POST /sandboxes/{id}/connect   (或 /resume)
   │
   ▼
API: PostSandboxesSandboxIDConnect (handlers/sandbox_connect.go)
   │  └─ 最多 maxConnectRetries=3 次循环:
   │     ├─ orchestrator.KeepAliveFor(sandboxID)  ──→ 命中 Running 沙箱 → 直接返回 200
   │     ├─ ErrNotFound → 跳出循环,进入 resume 分支
   │     └─ NotRunning → WaitForStateChange 后重试
   ▼
（若未命中运行中沙箱）
   │  ├─ snapshotCache.Get(sandboxID)  ──→ 拿到最近 snapshot(build_id / origin_node_id / config)
   │  └─ 校验 lastSnapshot.Snapshot.TeamID == teamID
   ▼
API: startSandbox(..., isResume=true, buildResumeSandboxData)
   │  └─ buildResumeSandboxData:从 snapshotCache 取 build/snap,构造 SandboxMetadata,
   │     关键字段:NodeID = snap.OriginNodeID(优先钉到 pause 时的节点,本地 cache 命中率高)
   ▼
API: orchestrator.CreateSandbox(isResume=true) (orchestrator/create_instance.go:135)
   │  ├─ 调度:优先 OriginNodeID,失败 fallback
   │  ├─ sandboxStore.Start()  ──→ 创建 store 条目
   │  └─ gRPC: SandboxService.Create(Sandbox.Snapshot = &SnapshotData{...})
   ▼
Orchestrator gRPC: Server.Create (server/sandboxes.go)
   │  ├─ waitForAcquire (starting semaphore;15s 超时)
   │  ├─ if req.Sandbox.Snapshot != nil:
   │  │    ├─ templateCache.GetTemplate(build_id, isSnapshot=true)
   │  │    │    ├─ useNFSCache (SnapshotFeatureFlag)
   │  │    │    ├─ peerclient.NewRoutingProvider() ──→ Redis 解析,优先从 peer 节点拉 chunk
   │  │    │    └─ getTemplateWithFetch() ──→ 异步 Fetch 模板数据
   │  │    └─ sandboxFactory.ResumeSandbox()  ──→ FC LoadSnapshot + uffd 等待 ready
   │  └─ else: 走常规 cold-start 分支
```

> **附注**:`GetSnapshotBuilds` 不出现在 Resume 路径上。它只服务于 **kill sandbox 时的级联清理**(见 §4.5),用来找出所有持有该 sandbox build 的节点,以便逐个清理。

### 4.4 Auto-resume(无显式请求)

由 client-proxy 在收到任意流量时,通过 gRPC 触发 API 上的 `SandboxService.ResumeSandbox`(`proxy_grpc.go:127`)。这是 **gRPC 入口**(不是 HTTP),用 client-proxy 自己的 OAuth scope 鉴权。

```
Client traffic → client-proxy → gRPC SandboxService.ResumeSandbox
   │
   ▼
SandboxService.ResumeSandbox (proxy_grpc.go:127)
   │  ├─ requireEdgeClientProxyAuth(校验 client-proxy OAuth)
   │  ├─ getAutoResumeSnapshot(sandboxID)        (proxy_grpc.go:99)
   │  │    ├─ snapshotCache.Get(sandboxID)
   │  │    ├─ Policy != Any           ──→ NotFound("auto-resume disabled")
   │  │    └─ Config.FilesystemOnly   ──→ FailedPrecondition("must be resumed explicitly")
   │  ├─ authService.GetTeamByID / oauth.RequireOrgClaims / CheckTeamBlocked
   │  ├─ orchestrator.GetSandbox(sandboxID) ──→ 若沙箱仍在 store:
   │  │    └─ HandleExistingSandboxAutoResume(等 1 分钟预算)─→ 若 handled 直接返回节点 IP
   │  ├─ 计算 timeout(max(AutoResume 配置, MinAutoResumeTimeoutSeconds flag))
   │  ├─ 校验 envd access token / traffic access token(secure / private ingress)
   │  └─ api.startSandboxInternal(..., isResume=true, buildResumeSandboxData(sandboxID, nil))
       │                                    ↑ autoPause override = nil(继承快照原值)
       ▼
       （与 §4.3 后半段复用同一链路:startSandboxInternal → orchestrator.CreateSandbox
        → gRPC SandboxService.Create(snapshot=true) → ResumeSandbox）
```

> **差别于 `/connect`**:`/connect` 先做 `KeepAliveFor` 重试 3 次(沙箱可能在 transitioning);auto-resume 跳过这一步,改为单次 `HandleExistingSandboxAutoResume`(等 transition 完成,预算 1 分钟),失败就直接进入 resume 流程。

### 4.5 Kill 流程的快照级联清理

`DELETE /sandboxes/{id}` 不只杀沙箱,还会清理快照遗留:

```
Client DELETE /sandboxes/{id}
   │
   ▼
API: DeleteSandboxesSandboxID (handlers/sandbox_kill.go:39)
   │  ├─ orchestrator.RemoveSandbox(Action=Kill)        ──→ 杀掉运行中沙箱(若在)
   │  └─ deleteSnapshot(ctx, sandboxID, teamID)         ──→ 即使沙箱已不在,也要清快照
   ▼
deleteSnapshot (sandbox_kill.go:21)
   │  ├─ throttledGetSnapshotBuilds() (sandbox_kill.go:107)
   │  │    └─ db.GetSnapshotBuilds()  ──→ 列出该 sandbox 的 template_id + 所有 build_id+node_id
   │  ├─ softDeleteTemplate(templateID)                 ──→ DB 软删 env + 返回 alias keys
   │  ├─ templateCache.InvalidateAllTags(templateID)
   │  ├─ templateCache.InvalidateAliasesByTemplateID(...)
   │  └─ snapshotCache.Invalidate(sandboxID)
```

> 这才是 `GetSnapshotBuilds` 的真正用途:仅用于 kill 清理,不参与 resume。

---

## 5. API 层(orchestrator 客户端)

### 5.1 关键文件

| 文件 | 角色 |
| --- | --- |
| `packages/api/internal/orchestrator/snapshot_template.go` | `CreateSnapshotTemplate` — checkpoint orchestrator 入口 |
| `packages/api/internal/orchestrator/pause_instance.go` | 内部 `pauseSandbox`(L32) + `buildUpsertSnapshotParams` + `throttledUpsertSnapshot`(L173) |
| `packages/api/internal/orchestrator/delete_instance.go` | `RemoveSandbox`(分发 Pause/Kill/Snapshot)+ `removeSandboxFromNode`(switch Action) |
| `packages/api/internal/cache/snapshots/snapshot_cache.go` | Redis 缓存最近一次 pause |
| `packages/api/internal/db/snapshots.go` | sqlc 包装(`GetSnapshotBuilds` — 仅 kill 用) |
| `packages/api/internal/handlers/sandbox_pause.go` | HTTP `/sandboxes/{id}/pause` |
| `packages/api/internal/handlers/snapshot_template_create.go` | HTTP `/sandboxes/{id}/snapshots` + handler 层的 `templateCache.Invalidate` |
| `packages/api/internal/handlers/snapshot_template_list.go` | HTTP `GET /snapshots` |
| `packages/api/internal/handlers/sandbox_connect.go` | HTTP `/sandboxes/{id}/connect`(KeepAlive + resume fallback) |
| `packages/api/internal/handlers/sandbox_resume.go` | HTTP `/sandboxes/{id}/resume`(deprecated)+ `buildResumeSandboxData` |
| `packages/api/internal/handlers/sandbox_kill.go` | `deleteSnapshot`(kill sandbox 时级联清理)+ `throttledGetSnapshotBuilds` |
| `packages/api/internal/handlers/proxy_grpc.go` | gRPC `SandboxService.ResumeSandbox`(auto-resume 入口,L127)+ `getAutoResumeSnapshot`(L99) |

### 5.2 `SnapshotCache` 设计

`packages/api/internal/cache/snapshots/snapshot_cache.go`:

- **存储**:Redis,key 前缀 `snapshot:last:<sandboxID>`
- **TTL**:5 分钟
- **后台刷新**:1 分钟(被动 TTL + 主动刷新,典型 cache-aside 模式)
- **负缓存**:用 sentinel `&SnapshotInfo{NotFound: true}` 缓存"不存在",避免反复查 DB
- **缓存内容**:`SnapshotInfo{ Aliases, Names, Snapshot, EnvBuild }` — 已经 JOIN 了 alias/build,避免热点 sandbox 反复查 DB

**失效时机**:
- Pause 成功后:`Invalidate(sandboxID)`(下次读会从 DB 取最新)
- Checkpoint 成功后:同上
- Kill sandbox 时:同上(由 `deleteSnapshot` 调用)

### 5.3 关键并发保护

`pause_instance.go:173`:

```go
func (o *Orchestrator) throttledUpsertSnapshot(...) {
    if err := o.snapshotUpsertSem.Acquire(ctx, 1); err != nil { ... }
    defer o.snapshotUpsertSem.Release(1)
    return o.sqlcDB.UpsertSnapshot(ctx, params)
}
```

**为什么**:UpsertSnapshot 是一个写多张表的复杂事务,加全局信号量防止 DB 连接被打爆。`updateDBThrottleLimits`(store.go)动态调整这个信号量的容量。

### 5.4 状态机保护

`CreateSnapshotTemplate` 用 `StartRemoving(StateActionSnapshot)` + `sync.Once finishSnapshotting`:

- 进入 `Snapshotting` 状态后,**其他状态变更被阻塞**(kill、pause、resume 都需先等当前 snapshotting 完成)
- 成功 → 回到 `Running`
- 失败 → 留在 `Snapshotting`,允许直接转 `Killing`(避免死锁)

---

## 6. Orchestrator 层(gRPC 服务端)

### 6.1 gRPC 接口

`packages/orchestrator/orchestrator.proto`:

```protobuf
service SandboxService {
  rpc Pause(SandboxPauseRequest)     returns (SandboxPauseResponse);
  rpc Checkpoint(SandboxCheckpointRequest) returns (SandboxCheckpointResponse);
  // 还有 Create / Update / List / Delete / ListCachedBuilds
}

message SandboxPauseRequest {
  string sandbox_id = 1;
  string template_id = 2;
  string build_id = 3;
  bool filesystem_only = 4;  // 默认 false = memory snapshot
}

message SandboxCheckpointRequest {
  string sandbox_id = 1;
  string build_id = 3;
  map<string,string> metadata = 4;  // 存储对象 metadata,如 template_id
}
```

> Checkpoint **没有** `filesystem_only` 字段:总是 memory snapshot(原因见 4.2)。

### 6.2 关键文件

| 文件 | 角色 |
| --- | --- |
| `packages/orchestrator/pkg/server/sandboxes.go` | gRPC 入口:`Server.Pause`(599)/ `Server.Checkpoint`(699)/ 公共 `snapshotAndCacheSandbox`(907) |
| `packages/orchestrator/pkg/sandbox/sandbox.go` | `Sandbox.Pause()`(1253,实例方法) + `Factory.ResumeSandbox()`(698,工厂方法,**接收者是 Factory 不是 Sandbox**) |
| `packages/orchestrator/pkg/sandbox/snapshot.go` | `Snapshot` 结构体定义 |
| `packages/orchestrator/pkg/sandbox/snapshot_metrics.go` | diff/dedup 度量 |
| `packages/orchestrator/pkg/sandbox/fc/client.go` | `loadSnapshot` / `createSnapshot`(Firecracker API 封装) |
| `packages/orchestrator/pkg/sandbox/fc/process.go` | `CreateSnapshot`(调用自定义 FC 的 disk flush + snapfile 生成) |
| `packages/orchestrator/pkg/server/upload_retry.go` | 上传 GCS 的指数退避重试 |
| `packages/orchestrator/pkg/server/prefetch_harvest.go` | `prefetchHarvester`(预热映射收集) |

### 6.3 `Snapshot` 结构体

`packages/orchestrator/pkg/sandbox/snapshot.go:29`:

```go
type Snapshot struct {
    MemorySnapshot     MemorySnapshot   // memfile diff + header + block size;fs-only 时 NoDiff
    RootfsDiff         build.Diff       // rootfs 增量
    RootfsDiffHeader   *DiffHeader
    Snapfile           template.File    // FC VM 状态文件;fs-only 不上传
    Metafile           template.File    // 元数据(给 resume 用)
    BuildID            uuid.UUID
    SchedulingMetadata *orchestrator.SchedulingMetadata
    FilesystemSnapshot bool             // pause 时的决策,无法从 diff 形状推断
    RootfsBlockSize    uint64
    cleanup            *Cleanup
}
```

### 6.4 `Pause()` 函数的步骤

`sandbox.go:1253` 一句话总结:**freeze guest → flush disk → FC createSnapshot → 后处理内存 diff → 返回**。

详细步骤:

1. **预清理(可选)**:`bestEffortReclaim(ctx)` — 调 envd 做 `fstrim/sync/drop_caches/compact_memory`,LD flag 控制
2. **fs-only 特殊处理**:`guestPrepareFsForPause` 强制冻结文件系统(FC 不刷 page cache,必须显式做)
3. **balloon drain**(可选):`DrainBalloon` 释放 free-page-hinting 的页面
4. **VM pause**:`process.Pause(ctx)` — 暂停 FC 进程
5. **flush metrics**:best-effort
6. **创建 snapfile**:`CreateSnapshot(ctx, snapfile.Path())` — FC API,同时 drain+flush virtio disk
7. **memory 后处理**:`processMemorySnapshot(ctx, buildID)` — 计算 dirty pages diff
8. **填 MemorySnapshot 与 Rootfs diff**:返回 `Snapshot`

### 6.5 上传策略

上传策略因入口而异 — **Pause 始终异步**,**Checkpoint 看 flag**:

| 入口 | 模式 | 触发条件 | 行为 |
| --- | --- | --- | --- |
| **Pause**(`Server.Pause`) | 异步 | 总是 | `uploadSnapshotAsync` 后台执行,gRPC 立即返回 |
| **Checkpoint**(`Server.Checkpoint`) | 异步 | `PeerToPeerAsyncCheckpointFlag = on` | `uploadSnapshotAsync` 后台执行,API 立即返回;peer 节点可在 2 小时窗口内拉 chunk |
| **Checkpoint**(`Server.Checkpoint`) | 同步 | flag = off(默认) | `res.upload.Run(uploadTimeout)` 阻塞 ≤20 分钟,失败会 tear down 已 resume 的沙箱 |

> Pause 选异步是因为 client 不依赖上传完成就拿到响应;Checkpoint 选同步(默认)是为了保证 returned sandbox 一定可被未来 pause/resume。

**重试预算**:
- `uploadTimeout = 20 min`(单次)
- `uploadTotalBudget = 2 hours`(总窗口)
- `uploadRetryInitialBackoff = 5 s`,`uploadRetryMaxBackoff = 2 min`,`multiplier = 2`(指数退避)
- `redisPeerKeyTTL = 2h2min`(peer 路由 key,覆盖整个重试窗口)

---

## 7. Firecracker 与 envd 协作

### 7.1 Firecracker API 调用

`packages/orchestrator/pkg/sandbox/fc/client.go`:

```go
// 恢复时调用 FC 的 LoadSnapshot
loadSnapshot(ctx, uffdSocketPath, uffdReady, snapfile, useMemfd):
    c.client.Operations.LoadSnapshot(&operations.LoadSnapshotParams{
        Body: &models.SnapshotLoadParams{
            ResumeVM:            false,    // 不立即 resume VM,等 uffd ready
            EnableDiffSnapshots: false,
            MemBackend: &models.MemoryBackend{
                BackendType: Uffd,
                BackendPath: &uffdSocketPath,
                UseMemfd:    useMemfd,
            },
            SnapshotPath: &snapfilePath,
        },
    })
    <-uffdReady  // 等 uffd server 准备好处理缺页
```

`packages/shared/pkg/fc/models/snapshot_load_params.go` / `snapshot_create_params.go` 是 FC OpenAPI 客户端的生成代码。

### 7.2 envd 的 fsfreeze

`packages/envd/internal/services/fsfreeze/fsfreeze_linux.go`:

- `Freeze()`(L29-47):调 Linux `FS_IOC_FIFREEZE` ioctl 冻结文件系统
- `Thaw()`(L49-67):调 `FS_IOC_FITHAW` 解冻

业务流程中,`bestEffortReclaim` 与 `guestPrepareFsForPause` 会通过 envd 的 fsfreeze 服务冻结/解冻用户 cgroup,确保 pause 时磁盘状态一致。

### 7.3 envd 版本检查

`packages/shared/pkg/utils/version.go:38`:

```go
func CheckEnvdVersionForSnapshot(envdVersion string) error
```

旧 envd 不支持 fsfreeze / memory snapshot 协议。两次校验:HTTP handler 入口 + Checkpoint gRPC handler 入口。

---

## 8. 缓存与并发控制

### 8.1 三级缓存全景

```
┌─────────────────────────────────────────────────────────────┐
│ API 层                                                       │
│  ├─ snapshotCache (Redis, 5min TTL)    ← sandboxID → snapshot │
│  └─ templateCache  (Redis, 多级)       ← alias/template_id    │
├─────────────────────────────────────────────────────────────┤
│ Orchestrator 层                                              │
│  └─ templateCache (本地 ttlcache)       ← buildID → Snapshot │
│     ├─ NFS local cache (可选)                                 │
│     └─ peer routing (可选,Redis 解析源节点)                   │
├─────────────────────────────────────────────────────────────┤
│ Storage 层                                                   │
│  └─ GCS memfile + rootfs + snapfile                          │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 snapshotCache 失效场景

| 触发 | 动作 |
| --- | --- |
| Pause 成功 | `Invalidate(sandboxID)` |
| Checkpoint 成功 | `Invalidate(sandboxID)` |
| Kill sandbox | `Invalidate(sandboxID)`(`deleteSnapshot` 调用) |

> 注意:Checkpoint 同时 `Invalidate(templateCache, template_id, &tag)` — 因为新增了 build assignment,template cache 的旧数据失效。

### 8.3 templateCache.AddSnapshot

orchestrator 端 `packages/orchestrator/pkg/sandbox/template/cache.go:219` 把刚 pause 出来的 snapshot 注册到本地 cache:

- 同时注册 memfile diff、rootfs diff、snapfile、metafile
- 后续 resume 同 buildID 时**直接命中**,无需走 GCS

`ListCachedBuilds` gRPC 暴露 cache 内容,供调度器选节点时参考。

### 8.4 并发信号量

| 信号量 | 位置 | 用途 |
| --- | --- | --- |
| `snapshotUpsertSem` | API orchestrator | 限制同时 `UpsertSnapshot` 数(防 DB 过载) |
| `startingSandboxes` | Orchestrator server | 限制同时启动(非 snapshot)的 sandbox 数 |
| `waitForAcquire` | Orchestrator server | 限制同时 snapshot resume 的 sandbox 数(15s 超时) |
| `snapshotUpsertSem` 容量 | `updateDBThrottleLimits` 动态调整 | 根据集群规模调优 |

---

## 9. 配置项与 Feature Flags

### 9.1 Feature Flags(LaunchDarkly)

| Flag | 影响 |
| --- | --- |
| `PeerToPeerAsyncCheckpointFlag` | Checkpoint 上传同步/异步切换 |
| `PeerToPeerChunkTransferFlag` | 启用模板数据的 peer-to-peer 路由 |
| `SnapshotFeatureFlag` | 启用 NFS 本地 cache(snapshot 走自己的 path) |
| `TemplateFeatureFlag` | 启用 NFS 本地 cache(template) |
| `FreePageHintingTimeout`(按 use case) | balloon drain 超时;0 = 禁用 |
| 预清理 chain | LD 控制每个 reclaim 步骤的预算(默认 0 = 全禁用) |

### 9.2 关键常量(orchestrator)

`packages/orchestrator/pkg/server/sandboxes.go:44-72`:

```go
requestTimeout              = 60 * time.Second
acquireTimeout              = 15 * time.Second  // snapshot resume 等信号量
uploadTimeout               = 20 * time.Minute   // 单次上传
uploadTotalBudget           = 2 * time.Hour      // 总上传预算
redisPeerKeyTTL             = uploadTotalBudget + 2*time.Minute
uploadRetryInitialBackoff   = 5 * time.Second
uploadRetryMaxBackoff       = 2 * time.Minute
uploadRetryBackoffMultiplier = 2
```

### 9.3 snapshotCache 常量

`packages/api/internal/cache/snapshots/snapshot_cache.go:18`:

```go
snapshotCacheTTL             = 5 * time.Minute
snapshotCacheRefreshInterval = 1 * time.Minute
snapshotCacheKeyPrefix       = "snapshot:last"
```

---

## 10. 关键文件清单

### API 层

```
packages/api/internal/
├── handlers/
│   ├── snapshot_template_create.go     ← POST /sandboxes/{id}/snapshots (+ handler 层 templateCache.Invalidate)
│   ├── snapshot_template_list.go       ← GET /snapshots
│   ├── sandbox_pause.go                ← POST /sandboxes/{id}/pause (调用 RemoveSandbox)
│   ├── sandbox_resume.go               ← POST /sandboxes/{id}/resume (deprecated) + buildResumeSandboxData
│   ├── sandbox_connect.go              ← POST /sandboxes/{id}/connect (KeepAlive + resume fallback)
│   ├── sandbox_kill.go                 ← DELETE /sandboxes/{id} (级联清快照 + throttledGetSnapshotBuilds)
│   ├── proxy_grpc.go                   ← gRPC SandboxService.ResumeSandbox (auto-resume 入口)
│   └── sandboxes_list.go               ← snapshotsToPaginatedSandboxes
├── orchestrator/
│   ├── snapshot_template.go            ← CreateSnapshotTemplate (Checkpoint orchestrator 入口)
│   ├── pause_instance.go               ← 内部 pauseSandbox + throttledUpsertSnapshot + buildUpsertSnapshotParams
│   ├── delete_instance.go              ← RemoveSandbox(Pause/Kill/Snapshot 统一入口)+ removeSandboxFromNode
│   └── orchestrator.go                 ← SnapshotCacheInvalidator
├── cache/snapshots/
│   └── snapshot_cache.go               ← Redis 缓存 (snapshot:last:<sandboxID>, TTL 5m)
└── db/
    └── snapshots.go                    ← GetSnapshotBuilds 包装(仅 kill 用)
```

### Orchestrator 层

```
packages/orchestrator/pkg/
├── server/
│   ├── sandboxes.go                    ← Pause + Checkpoint + snapshotAndCacheSandbox
│   ├── upload_retry.go                 ← GCS 上传重试
│   └── prefetch_harvest.go             ← 预热映射收集
├── sandbox/
│   ├── sandbox.go                      ← Sandbox.Pause() (1253) + Factory.ResumeSandbox() (698)
│   ├── snapshot.go                     ← Snapshot 数据结构
│   ├── snapshot_metrics.go             ← diff/dedup 度量
│   ├── template/cache.go               ← AddSnapshot(本地缓存)
│   ├── uploads.go                      ← Uploads 抽象
│   └── fc/
│       ├── client.go                   ← Firecracker loadSnapshot/createSnapshot
│       └── process.go                  ← CreateSnapshot(自定义 FC disk flush)
└── orchestrator.proto                  ← gRPC 接口定义
```

### 数据库层

```
packages/db/
├── queries/
│   ├── snapshots/
│   │   ├── create_new_snapshot.sql             ← UpsertSnapshot
│   │   ├── create_snapshot_template_env.sql    ← CreateSnapshotTemplateEnv
│   │   ├── get_last_snapshot.sql               ← GetLastSnapshot
│   │   ├── get_snapshot_builds.sql             ← GetSnapshotBuilds
│   │   ├── list_team_snapshot_templates.sql    ← ListTeamSnapshotTemplates
│   │   └── update_snapshot_origin_node.sql     ← UpdateSnapshotOriginNode
│   ├── models.go                                ← Snapshot model
│   └── ...
└── migrations/
    ├── 20241213142106_create_snapshots.sql
    ├── 20250206105106_add_snapshot_constraints.sql
    ├── 20250404151700_add_snapshots_sbx_started_at.sql
    ├── 20250409113306_add_envd_secured_to_snapshot.sql
    ├── 20250708135401_snapshot_pause_node_id.sql
    ├── 20250818114512_auto_pause.sql
    ├── 20250824185634_snapshot_node_not_nullable.sql
    ├── 20250923094021_add_team_id_to_snapshots.sql
    ├── 20251009170758_unique_snapshots.sql              ← sandbox_id UNIQUE
    ├── 20251030130958_add_env_index_to_snapshots.sql
    ├── 20251106172810_add_config_to_snapshots.sql       ← config jsonb
    ├── 20260211120000_add_snapshot_templates.sql
    ├── 20260228120000_snapshot_template_origin_node.sql
    ├── 20260310120000_add_snapshots_metadata_gin_index.sql
    ├── 20260312120000_fix_snapshots_jsonb_null_metadata.sql
    ├── 20260313120000_fix_snapshots_created_at.sql
    └── 20260314120000_fix_snapshots_metadata_sql_null_trigger.sql
```

### Envd 层

```
packages/envd/internal/
├── api/fsfreeze.go                      ← Connect RPC 接口
└── services/fsfreeze/
    └── fsfreeze_linux.go                ← Freeze / Thaw ioctl 实现
```

### 测试

```
tests/integration/internal/tests/api/sandboxes/
├── snapshot_template_test.go            ← 端到端快照模板测试
└── sandbox_rapid_pause_resume_test.go   ← 快速 pause/resume 链测试

packages/db/pkg/tests/snapshots/
├── snapshot_latest_assignment_test.go   ← GetLastSnapshot 单元测试
└── upsert_snapshot_test.go              ← UpsertSnapshot 单元测试

tests/periodic-test/snapshot-and-resume.ts  ← 周期性回归测试
```

---

## 附录:常见疑问

**Q1: Pause 和 Checkpoint 区别?**
Pause 让 sandbox 进入 paused 状态(后续可 resume,但没有独立模板);Checkpoint 是"pause + 立即 resume 原沙箱 + 把这次 snapshot 提升为可被 spawn 的模板",**原沙箱继续运行**。

**Q2: 为什么 `env_builds.env_id` 无 FK?**
详见 [`database-schema.md` § 8.4](./database-schema.md#84-env--build-多对多去-fk-的反范式)。snapshot 流程也复用此设计:`CreateTemplateBuildAssignment` 显式写 `env_build_assignments`,触发器回填 `env_builds.env_id`。

**Q3: 同一 sandbox 多次 pause 怎么办?**
`snapshots.sandbox_id` 是 UNIQUE 的。`UpsertSnapshot` 用 `ON CONFLICT (sandbox_id) DO UPDATE`:首次创建 env+snapshot+build;后续只更新 snapshot 字段(metadata/origin_node_id/config)+ 新建一个 build。

**Q4: filesystem-only pause 为什么不能 auto-resume?**
Filesystem-only 没有 memfile + snapfile,resume 必须冷启动 reboot,内存状态丢失。`getAutoResumeSnapshot`(`proxy_grpc.go:99`)显式拒绝这种场景(`FailedPrecondition`),要求 caller 用 `/connect` 或 `/resume` 显式触发(显式路径允许 reboot)。

**Q5: 快照的 CPU 兼容性怎么保证?**
Pause 时新建的 build **从 source build 复制 5 个 CPU 字段**(architecture/family/model/model_name/flags),而不是用执行 pause 的节点的 CPU 信息。这样 resume 时调度器用源 build 的 CPU spec 找兼容节点,跨代际 pause/resume 也能匹配。详见 `buildUpsertSnapshotParams` 与 `create_new_snapshot.sql`。
