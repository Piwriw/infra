# E2B 快照(Snapshot)系统全景

> 范围:从 HTTP API、数据库、orchestrator gRPC、Firecracker、envd 全链路梳理"快照"功能。
> 数据来源:代码与迁移文件,已同步至 2026.30(2026-09-10)。行号均按 tag `2026.30` 核对。
> 配套文档:数据库字段见 [`database-schema.md`](./database-schema.md),sandbox 创建/模板拉取见 `sandbox-lifecycle.md` / `template-module.md`。

---

## 目录

- [1. 概念总览](#1-概念总览)
  - [1.1 两种快照数据模式](#11-两种快照数据模式)
  - [1.2 `memory` 参数(2026.30 新增语义)](#12-memory-参数202630-新增语义)
  - [1.3 状态机](#13-状态机)
- [2. API 端点](#2-api-端点)
- [3. 数据库层](#3-数据库层)
- [4. 业务流程](#4-业务流程)
  - [4.2.0 两条 checkpoint 路径(2026.30 新增)](#420-两条-checkpoint-路径202630-新增)
- [5. API 层(orchestrator 客户端)](#5-api-层orchestrator-客户端)
- [6. Orchestrator 层(gRPC 服务端)](#6-orchestrator-层grpc-服务端)
- [7. Firecracker 与 envd 协作](#7-firecracker-与-envd-协作)
  - [7.4 两条 envd 升级路径](#74-202630-新增两条-envd-升级路径)
  - [7.5 冷启动前的文件系统恢复](#75-202630-新增冷启动前的文件系统恢复)
- [8. 缓存与并发控制](#8-缓存与并发控制)
- [9. 配置项与 Feature Flags](#9-配置项与-feature-flags)
- [10. 关键文件清单](#10-关键文件清单)

---

## 1. 概念总览

E2B 的"快照"在五个层次上有不同语义,理解清楚再读代码:

| 概念 | 含义 | 生命周期 |
| --- | --- | --- |
| **Pause(暂停)** | 把运行中 sandbox 的内存 + 磁盘状态持久化 | sandbox 进入 `paused` 状态,后续可 resume |
| **Snapshot row(快照记录)** | `snapshots` 表中的一行,记录最新 pause/checkpoint 的元数据 | 跟随 sandbox,直到 sandbox 被删除 |
| **Snapshot template(快照模板)** | 把某次 snapshot 提升为**可被反复 spawn** 的模板 | 独立持久化,在 `snapshot_templates` 表 + `envs.source='snapshot_template'` |
| **Checkpoint(检查点)** | Orchestrator 的 full-memory snapshot + 原地 resume 操作 | 原 sandbox 保持 ID、execution ID、expiration 与 Running 状态;是否创建模板由上层调用者决定 |
| **Fork(派生)** | checkpoint 一次,再从同一不可变 snapshot 启动一个或多个新 ID | 原 sandbox 继续运行,副本各自独立运行;不创建 snapshot template |

### 1.1 两种快照数据模式

| 模式 | 字段标识 | 持久化内容 | Resume 行为 |
| --- | --- | --- | --- |
| **Memory snapshot**(默认) | `filesystem_only = false` | memfile(内存 diff)+ rootfs diff + snapfile(VM 状态) | 通过 uffd 按需加载内存页,**完整恢复**内存 |
| **Filesystem-only snapshot** | `filesystem_only = true` | 只 rootfs diff(无 memfile / snapfile) | 冷启动 reboot,**内存丢失** |

Memory snapshot 是默认路径。Filesystem-only 用于:auto-pause 优化成本、不需要内存状态的快照。

### 1.2 `memory` 参数(2026.30 新增语义)

2026.30 把"要不要内存"这件事从**单向开关**改成了**双向能力**,三个端点上各有对应字段:

| 端点 | 字段 | 语义 |
| --- | --- | --- |
| `POST /sandboxes/{id}/pause` | `SandboxPauseRequest.memory`(默认 `true`) | `false` = 只持久化文件系统,resume 时冷启动 reboot |
| `POST /sandboxes/{id}/connect` | `ConnectSandbox.memory` | `false` 且沙箱已暂停 = 只从磁盘状态恢复 |
| `POST /sandboxes/{id}/resume` | `ResumedSandbox.memory` | 同上 |

三条描述里有一段措辞值得注意:**"A no-op for snapshots that contain no memory"** —— 对一个本来就是 fs-only 的快照传 `memory: false` 不报错,只是没有额外效果。以及 **"Rejected with an error in environments where this capability is not enabled, never silently downgraded to a memory restore"** —— 能力未开启时是**报错**,不是悄悄退回内存恢复。对应 flag 为 `fs-only-resume-api`(默认 `false`)。

磁盘状态的语义是 **crash-recovery 语义**:pause 前未 flush 的写入可能丢失。

orchestrator 侧的对应字段是 `SandboxConfig.filesystem_boot`(optional bool,proto field 4)。它的注释明确约束了方向:**"The request can only widen toward the no-memory path — it can never force a memory restore of a snapshot that has none."** 即请求只能朝"不要内存"的方向放宽,不能反向要求把无内存的快照恢复出内存。回显字段是 `SandboxCreateResponse.filesystem_boot_applied`(field 3),缺失表示对端 orchestrator 早于 `filesystem_boot` 存在,因此**缺失 ≠ false**。

### 1.3 状态机

```
Running ──pause──→ Snapshotting ──┐
                                  ↓
                                  Paused ──resume──→ Running

Running ──checkpoint──→ Snapshotting ──→ Running(原沙箱恢复)
                            │
                            ├── /snapshots ──→ Snapshot Template(独立 env,可被 spawn)
                            └── /fork ───────→ N 个新 Sandbox ID(不创建 template)
```

> 沙箱状态管理在 `packages/api/internal/sandbox/store.go`,动作集合为 `StateActionPause` / `StateActionSnapshot` / `StateActionKill`(`packages/api/internal/sandbox/aliases.go:58-60` re-export 自 `db/types`)。**没有 `StateActionResume`** — Resume 不走状态机,而是直接复用 sandbox 创建路径(`CreateSandbox` with `isResume=true`)。

---

## 2. API 端点

来源:`spec/openapi.yml`

| 方法 | 路径 | Handler | 作用 |
| --- | --- | --- | --- |
| POST | `/sandboxes/{sandboxID}/pause` | `PostSandboxesSandboxIDPause` | 暂停 sandbox(默认 memory snapshot;`memory:false` 走 fs-only) |
| POST | `/sandboxes/{sandboxID}/snapshots` | `PostSandboxesSandboxIDSnapshots` | **创建快照模板**(checkpoint 语义) |
| POST | `/sandboxes/{sandboxID}/fork` | `PostSandboxesSandboxIDFork` | checkpoint 一次,从该快照并行启动 1..100 个新 sandbox |
| POST | `/sandboxes/{sandboxID}/resume` | `PostSandboxesSandboxIDResume` | 显式 resume(deprecated,新代码用 connect;接受 `memory`) |
| POST | `/sandboxes/{sandboxID}/connect` | `PostSandboxesSandboxIDConnect` | 自动 resume:已暂停则 resume,运行中只返回详情(接受 `memory`) |
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

在 resume 成功后(`create_instance.go:540`),如果实际调度的节点不是原 `origin_node_id`,把这个 snapshot 的 origin 改成新的 warmed node。**目的**:下次 resume 优先用已经 cache warm 的节点。受 `ResumeOriginNodeRemapFlag` 控制。

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

> 注意:HTTP handler 不直接调 `PauseSandbox`。Pause 复用了 sandbox 的统一删除入口 `RemoveSandbox`,通过 `Action=Pause` 参数分发到内部 `pauseSandbox` 方法(`delete_instance.go:254`)。这样 Pause/Kill/Snapshot 共用同一套状态机和清理逻辑。

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
API: pauseSandbox (orchestrator/pause_instance.go:29)  ← 仅 Action=Pause 走这条分支
   │  ├─ throttledUpsertSnapshot()  ──→ DB: UpsertSnapshot (新建 env+build 或更新 snapshot)
   │  ├─ snapshotInstance()         ──→ gRPC: SandboxService.Pause
   │  ├─ UpdateEnvBuildStatus(Success)
   │  └─ snapshotCache.Invalidate(sandboxID)
   ▼
Orchestrator gRPC: Server.Pause (server/sandboxes.go:820)
   │  ├─ s.info.TrackWork()          ──→ 登记 outstanding_work(见 §6.6)
   │  ├─ 按 sandbox/template/kernel/FC/envd 维度构造 LD context
   │  ├─ 【2026.30 新增】admission 预检(flag pause-admission-grace-milliseconds ≥ 0)
   │  │    └─ sbx.AwaitSnapshotAdmission(grace, memorySnapshot=!filesystemOnly)
   │  │         ├─ Ready / ReadyAfterWait  ──→ 继续
   │  │         ├─ Refused + ErrSnapshotAdmissionPending
   │  │         │    └─ 返回 ResourceExhausted "node is busy persisting sandbox ..."
   │  │         │       (可重试;此时尚未执行任何破坏性步骤)
   │  │         └─ LatchedError ──→ 记为 latchedErr,延后到杀进程路径
   │  ├─ MarkStopping (并发保护)
   │  ├─ EnsurePausable() / latchedErr
   │  │    └─ 失败 ──→ 不再拒绝,而是立即 kill + emitSandboxKilled(seal-failed)
   │  │       (原因见下方注记)
   │  ├─ SetStopReason(Paused)       ──→ 必须在 snapshot 之前设,否则会被读成 crash
   │  ├─ deferRootfsExport = flag defer-rootfs-export
   │  ├─ snapshotAndCacheSandbox(origin=Pause, filesystemOnly=req, deferRootfsExport)
   │  │    ├─ sbx.Pause()           ──→ Firecracker CreateSnapshot + 内存后处理
   │  │    └─ templateCache.AddSnapshot()  ──→ 本地 cache 加入新 snapshot
   │  ├─ uploadSnapshotAsync()       ──→ 后台异步上传到 GCS(Pause 始终异步)
   │  ├─ harvestResumePrefetchAsync() ──→ 后台预热(仅 memory snapshot;fs-only 直接跳过)
   │  ├─ defer stopSandboxAsync()    ──→ 异步停止原沙箱
   │  └─ publishSandboxEvent(Paused)
   ▼
返回 SandboxPauseResponse { SchedulingMetadata }
```

> **为什么 seal 失败要 kill 而不是拒绝**:注释写得很直接——拒绝**并不能保住**这个 sandbox。API 侧的 pause 链路在这条 RPC 返回前就已经删掉了路由记录,并且无论 RPC 结果如何都会移除 store 记录;于是被拒绝的 pause 会留下一个活着的 VM,由 orphan reconciler 在约 20 秒后杀掉,停止原因被记成 `orphaned` 而不是真正的 seal 失败。在请求内 kill 能让 API 的记录与事实一致,并把真实原因写进错误和 stop reason。
>
> **admission 预检的定位**:它是**破坏性步骤之前**的前置检查,针对"父 memfile header 还在 dedup"这一具体状态。返回值语义见 `SnapshotAdmissionOutcome`(`packages/orchestrator/pkg/sandbox/sandbox.go:3631`):`ready`(未等待即准入)、`ready_after_wait`(在宽限期内等到 header 变持久)、`refused`(宽限期耗尽仍在 dedup)、`latched_error`(已闩定的 seal 失败,意味着不可能再有效持久化)。宽限期由 `pause-admission-grace-milliseconds` 控制,默认 `-1` 表示**整个预检关闭**。

> **defer-rootfs-export 的取舍**:pause 本质是一次 suspend,在后续 resume 之前没有任何人读 diff(而 resume 本来就要等上传)。所以把 rootfs 的 reflink 挪出 pause 关键路径是安全的。仅 NBD provider 支持,其他情况回落到同步导出。

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
Orchestrator gRPC: Server.Checkpoint (server/sandboxes.go:998)
   │  ├─ s.info.TrackWork()
   │  ├─ CheckEnvdVersionForSnapshot() (再次校验)
   │  ├─ 【2026.30 新增】admission 预检(与 Pause 同一 flag,但 memorySnapshot 恒为 true)
   │  │    ├─ Refused  ──→ ResourceExhausted(可重试)
   │  │    └─ LatchedError ──→ FailedPrecondition "sandbox cannot be persisted"
   │  │       (与 Pause 不同:Pause 会 kill,Checkpoint 直接拒绝——见下)
   │  ├─ waitForAcquire (starting semaphore;预检排在它之前,避免宽限期占住 start slot)
   │  ├─ inPlace = sbx.UseSyncWP() && InPlaceCheckpointFlag && FC release 支持
   │  │    ├─ true  ──→ checkpointInPlace()      (sandboxes.go:1188)
   │  │    └─ false ──→ checkpointResumeFresh()  (sandboxes.go:1271)
   │  │       (旧 FC 走 resume-fresh 优雅降级,不报错)
   │  ├─ snapshotAndCacheSandbox(origin=SnapshotTemplate, filesystemOnly=false)
   │  │    └─ 永远 false —— filesystem-only checkpoint 不支持(resume-in-place 需要 reboot,语义不成立)
   │  ├─ templateCache.GetTemplate(build_id, isSnapshot=true)
   │  ├─ MemoryPrefetchData() ──→ 收集预热映射
   │  ├─ templateCache.UpdateMetadata(加 prefetch mapping)
   │  └─ runCheckpointUpload():
   │       ├─ PeerToPeerAsyncCheckpointFlag=on 且非 deferred → uploadSnapshotAsync (异步)
   │       └─ 否则 → res.upload.Run(uploadTimeout) 同步等待
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

> **关键差别**:Orchestrator Checkpoint 比 Pause 多了"立即 resume 原沙箱(保留 ExecutionID)";`/snapshots` 的 API 编排再额外创建或关联 snapshot template env。原沙箱不会进入 paused 状态,在 Checkpoint 成功后保持 Running。

#### 4.2.0 两条 checkpoint 路径(2026.30 新增)

2026.30 把 Checkpoint 拆成两条互斥路径,由三个条件共同决定走哪条:

```go
inPlace := sbx.UseSyncWP() &&
    featureFlags.BoolFlag(ctx, featureflags.InPlaceCheckpointFlag) &&
    firecrackerSupports(ctx, sbx, "in-place checkpoint", (*fcversion.Info).HasInPlaceCheckpoint)
```

| 路径 | 函数 | 做什么 | 前提 |
| --- | --- | --- | --- |
| **in-place** | `checkpointInPlace`(`sandboxes.go:1188`) | pause → snapshot → **resume 同一个 FC 进程**,不停机 | 三个条件全部满足 |
| **resume-fresh** | `checkpointResumeFresh`(`sandboxes.go:1271`) | 旧路径:snapshot 后重新 load snapshot 起一个新 FC 进程 | 默认路径 |

**in-place 为什么要求 `use_sync_wp`**:它**跳过了**重新加载 snapshot 的那一步,而正是那一步会重新武装写保护。于是跨多次 checkpoint 的脏页追踪只能依赖 sync-WP serve loop。缺了它,追踪器漏掉一次写入就会损坏快照——这就是 `sync-wp-tracker-dirty` 这个独立 flag 存在的原因。

**FC release 契约**:in-place 还要求运行的 Firecracker release 包含该特性(`e2b` releases ≥ `0.2.0`,CoW 内存窗口驱动 balloon 的 free-page-reporting pause API)。不满足时**不报错**,而是退回 resume-fresh——注释明确说这是"graceful degrade rather than erroring"。

**两条路径的上传失败语义不同**(`runCheckpointUpload`,`sandboxes.go:1111`):
- in-place 传 `FailedPrecondition`,且 `onUploadFailure` 为 `nil`——沙箱还活着且健康,API 应当把它恢复成 Running,而不是杀掉;
- resume-fresh 传 `Internal`,其失败闭包会拆掉刚 resume 出来的沙箱,所以 kill 描述的是事实。

另外,当 `PeerToPeerAsyncCheckpointFlag` 为 on **且** `res.memoryExportDeferred` 为真时,不能直接异步返回——一个 deferred(CoW 窗口)内存导出在函数返回后**仍可能失败**,窗口被取消会留下"控制面相信存在、但背后没有产物"的 build 记录。`Snapshot.WaitMemorySealed` 就是这道闸门(见 §6.3)。

#### 4.2.1 Fork 流程(HTTP `/fork` → checkpoint 一次 → 并行创建新 ID)

```
Client POST /sandboxes/{id}/fork {timeout?, count?}
   │
   ▼
API: PostSandboxesSandboxIDFork (handlers/sandbox_fork.go)
   │  ├─ count 默认 1,范围 1..100,且 count < 团队 sandbox concurrency
   │  ├─ 只接受 Running sandbox;paused 返回 409,不存在/跨团队返回 404
   │  └─ CheckEnvdVersionForSnapshot()
   ▼
API: orchestrator.CheckpointSandbox (orchestrator/checkpoint_instance.go)
   │  ├─ StartRemoving(StateActionSnapshot) → Running → Snapshotting
   │  ├─ throttledUpsertSnapshot() → 刷新原 sandbox 的 snapshot row/build
   │  ├─ gRPC SandboxService.Checkpoint → full-memory snapshot + same-ID resume
   │  ├─ UpdateEnvBuildStatus(Success)
   │  └─ snapshotCache.Invalidate(sandboxID)
   ▼
API: 对同一 immutable snapshot 并行调用 startSandbox(new sandboxID, isResume=true) × count
   │
   └─ 201 []SandboxForkResult:每项独立包含 sandbox 或 error
```

Fork 与 `/snapshots` 共用底层 checkpoint,但数据库副作用不同:Fork 只更新原 sandbox 的 `snapshots` 行并复用它启动新 ID,**不调用** `resolveOrCreateSnapshotTemplate`,也不会新增 `snapshot_templates` 或可复用的 template alias。非 201 响应表示 checkpoint 前失败,没有任何 fork 被尝试;201 后仍需逐项检查部分失败。

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
API: orchestrator.CreateSandbox(isResume=true) (orchestrator/create_instance.go:177)
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
| `packages/api/internal/orchestrator/checkpoint_instance.go` | `CheckpointSandbox` — fork 使用的原地 checkpoint,只刷新 sandbox snapshot row |
| `packages/api/internal/orchestrator/pause_instance.go` | 内部 `pauseSandbox`(L32) + `buildUpsertSnapshotParams` + `throttledUpsertSnapshot`(L173) |
| `packages/api/internal/orchestrator/delete_instance.go` | `RemoveSandbox`(分发 Pause/Kill/Snapshot)+ `removeSandboxFromNode`(switch Action) |
| `packages/api/internal/cache/snapshots/snapshot_cache.go` | Redis 缓存最近一次 pause |
| `packages/api/internal/db/snapshots.go` | sqlc 包装(`GetSnapshotBuilds` — 仅 kill 用) |
| `packages/api/internal/handlers/sandbox_pause.go` | HTTP `/sandboxes/{id}/pause` |
| `packages/api/internal/handlers/sandbox_fork.go` | HTTP `/sandboxes/{id}/fork` + 并行 fork 结果聚合 |
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
- Fork 的 checkpoint 成功后:同上,确保新 sandbox 读取刚写入的 snapshot
- Kill sandbox 时:同上(由 `deleteSnapshot` 调用)

### 5.3 关键并发保护

`pause_instance.go:177`:

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
  rpc Create(SandboxCreateRequest) returns (SandboxCreateResponse);
  rpc Update(SandboxUpdateRequest) returns (google.protobuf.Empty);
  rpc List(google.protobuf.Empty) returns (SandboxListResponse);
  rpc Delete(SandboxDeleteRequest) returns (google.protobuf.Empty);
  rpc Pause(SandboxPauseRequest) returns (SandboxPauseResponse);
  rpc Checkpoint(SandboxCheckpointRequest) returns (SandboxCheckpointResponse);
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

message SandboxPauseResponse     { SchedulingMetadata scheduling_metadata = 1; }
message SandboxCheckpointResponse { SchedulingMetadata scheduling_metadata = 1; }
```

> Checkpoint **没有** `filesystem_only` 字段:总是 memory snapshot(原因见 4.2)。
>
> ⚠️ **`ListCachedBuilds` 已于 2026.30 退役**:该 RPC 与 `CachedBuildInfo` 消息从 `orchestrator.proto` 中删除,`SandboxService` 现在只有上列 6 个 RPC。原先它把 orchestrator 本地 template cache 的内容暴露给调度器参考,该职责已由别的机制承担(节点侧缓存由 `pkg/sandbox/template/cache.go` 管理,调度不再依赖这个 RPC)。
>
> **`SandboxStatus` 新增 `ShuttingDown = 4`** 终态,与快照无关但同批进入 proto:`MarkStopping` 之后节点进入该状态,不可逆,`/health` 仍返回 200 并带 `draining` 标记。

### 6.2 关键文件

| 文件 | 角色 |
| --- | --- |
| `packages/orchestrator/pkg/server/sandboxes.go` | gRPC 入口:`Server.Pause`(820)/ `Server.Checkpoint`(998)/ `checkpointInPlace`(1188)/ `checkpointResumeFresh`(1271)/ `runCheckpointUpload`(1111)/ 公共 `snapshotAndCacheSandbox`(1468) |
| `packages/orchestrator/pkg/sandbox/sandbox.go` | `Sandbox.Pause()`(1942,实例方法) + `Factory.ResumeSandbox()`(1207,工厂方法,**接收者是 Factory 不是 Sandbox**)+ `EnsurePausable()`(3596)/ `AwaitSnapshotAdmission()`(3669)/ `UseSyncWP()`(513) |
| `packages/orchestrator/pkg/sandbox/snapshot.go` | `Snapshot` 结构体定义 + `WaitMemorySealed()` |
| `packages/orchestrator/pkg/sandbox/snapshot_metrics.go` | diff/dedup 度量 |
| `packages/orchestrator/pkg/sandbox/fc/client.go` | `loadSnapshot` / `createSnapshot`(Firecracker API 封装) |
| `packages/orchestrator/pkg/sandbox/fc/process.go` | `CreateSnapshot`(839,调用自定义 FC 的 disk flush + snapfile 生成) |
| `packages/orchestrator/pkg/server/upload_retry.go` | 上传 GCS 的指数退避重试 |
| `packages/orchestrator/pkg/server/prefetch_harvest.go` | `prefetchHarvester`(预热映射收集) |
| `packages/orchestrator/pkg/sandbox/resume_prefetch.go` | 【2026.30 新增】resume 预热消费侧 |
| `packages/orchestrator/pkg/sandbox/envd_memory.go` | 【2026.30 新增】envd 内存相关(heap collapse 等) |
| `packages/orchestrator/pkg/sandbox/envd.go` | envd 调用层:`CallEnvdUpgrade`(273)等 |
| `packages/orchestrator/pkg/sandbox/envdbin/` | 【2026.30 新增】节点本地 envd 二进制缓存 |

> ⚠️ **`packages/orchestrator/pkg/server/template_cache.go` 已于 2026.30 删除**——本文旧版本曾引用它。当前 template cache 只存在于 `pkg/sandbox/template/cache.go`。

### 6.3 `Snapshot` 结构体

`packages/orchestrator/pkg/sandbox/snapshot.go:33`:

```go
type Snapshot struct {
    MemorySnapshot     MemorySnapshot   // memfile diff + header + block size;fs-only 时 NoDiff
    RootfsDiff         build.Diff       // rootfs 增量
    RootfsDiffHeader   *DiffHeader      // 类型别名 utils.SetOnce[*header.Header]
    Snapfile           template.File    // FC VM 状态文件;fs-only 不上传
    Metafile           template.File    // 元数据(给 resume 用)
    BuildID            uuid.UUID
    SchedulingMetadata *orchestrator.SchedulingMetadata

    // 2026.30 新增:true 表示内存导出走了 deferred(CoW 窗口)路径——
    // memfile diff 是 promise-backed 的,Pause 返回后仍可能失败。
    MemoryExportDeferred bool

    FilesystemSnapshot bool             // pause 时的决策,无法从 diff 形状推断
    RootfsBlockSize    uint64
    cleanup            *Cleanup
}
```

两处值得单独说:

**`RootfsDiffHeader` 是 `*DiffHeader` 而不是 `*header.Header`。** `DiffHeader = utils.SetOnce[*header.Header]`,即一个"将来会有值"的 future。原因是 memfd-dedup 路径从 goroutine 里解析这个 header,而 `Pause` 需要在 compare 完成**之前**就能返回。只有这一个路径需要异步解析,其余路径都用 `NewResolvedDiffHeader(h)` 立刻填好。

**`FilesystemSnapshot` 不能从 diff 形状推断。** 一个内存快照如果脏页为零,memfile 同样是 `NoDiff`,但它**仍然需要上传 snapfile**。所以这是 pause 时刻的决策记录,而不是可以从产物反推的属性。

**`WaitMemorySealed(ctx)`** 是 deferred 导出的闸门:`MemoryExportDeferred` 为假或没有 `waitSealed` 时立刻返回 nil;否则阻塞到 CoW 窗口落定并返回其结果。返回 nil 之后,memfile diff 的字节已经存在于本地 cache,此时对这个快照做异步上传,其持久性保证与"内存被同步拷贝"的快照完全一致。注释点明了它的作用域:**artifact-less-build-record 这一危险在 sweep 时结束,而不是在上传时结束。**

### 6.4 `Pause()` 函数的步骤

`sandbox.go:1942` 一句话总结:**等前一次 seal → 停健康检查 → freeze guest → flush disk → FC createSnapshot → 后处理内存 diff → 返回**。

详细步骤:

0. **【2026.30 新增】等前一次 seal(无条件,且排在最前)**:
   - `waitForRootfsSeal(ctx)`:序列化到一个**仍在运行**的后台 seal——它来自这个 sandbox 上一次 in-place 快照。那次 fold 会让可写 COW cache 重新变成完整 diff,而本次导出依赖这一点。
   - `waitForMemorySeal(ctx)`:序列化到上一次 in-place 快照遗留的 CoW 内存捕获窗口。
   - 两处都强调 **UNCONDITIONAL**:seal/window 状态挂在长生命周期的 `Sandbox` 上,所以一次普通的 autopause 也可能撞上前一次 in-place checkpoint 留下的窗口——它的脏页读数会和 tracker 的 rebaseline 竞争。
   - 位置**必须最先**:在这里等待(guest 尚未冻结)可以把超时的 reflink+fold 挡在 guest-frozen 窗口之外;而一个已闩定的 seal 错误能让本次 pause 在沙箱**完好无损**时中止。
1. **停健康检查**:`s.Checks.Stop()` — 在暂停 VM 之前
2. **预清理(可选)**:`bestEffortReclaim(ctx)` — 调 envd 做 `fstrim/sync/drop_caches/compact_memory`,每步预算由 LD flag 驱动,默认全 0 即整条链关闭。非致命。
   - 注意:**reclaim 会冻结用户 cgroup**。如果 pause/snapshot 失败,沙箱仍是活的,所以 cleanup 在**错误路径**上会 `bestEffortUnfreeze`,避免留下一个永久冻结的活 VM;成功路径则保留冻结状态,让它持久化进快照。
3. **fs-only 特殊处理**:`guestPrepareFsForPause` 强制冻结文件系统(FC 不刷 page cache,且没有内存快照能保住它,所以这步是**强制**的,不同于上面 best-effort 的 reclaim)。返回的 `frozen` 记录是否真的用 `FIFREEZE` 完成(而非退化成普通 sync)。
4. **写元数据标记**:`m.MarkFilesystemOnly(...)` + `m.MarkFsQuiesced(filesystemSnapshot && frozen)`。两者都进快照自己的 metadata,让 resume 路径**从快照自身的 metadata** 决定 reboot 还是内存恢复。`MarkFilesystemOnly` **无条件设置**——这样对一个先前 reboot 过的 fs-only 沙箱做内存 pause 时,能正确清掉旧标记。`fs_quiesced` 的持久化让后续功能可以安全判定"这个快照可以冷启动/改写而不需要 journal 修复"。
5. **balloon drain**(可选):`DrainBalloon` 释放 free-page-hinting 的页面,避免把 guest 已视为空闲的页捕获进快照。按 use case 设超时,0 = 禁用。
6. **VM pause**:`process.Pause(ctx)` — 暂停 FC 进程
7. **flush metrics**:best-effort
8. **创建 snapfile**:`CreateSnapshot(ctx, snapfile.Path())` — FC API,同时 drain+flush virtio disk
9. **memory 后处理**:`processMemorySnapshot(ctx, buildID)` — 计算 dirty pages diff
10. **填 MemorySnapshot 与 Rootfs diff**:返回 `Snapshot`

> **in-place 的 pre-arm 规则**:in-place checkpoint 要求 VM 无论如何都要回来,而且被停掉的健康检查必须重启,否则这个还活着的沙箱会永久失去 checks。所以 resume 的注册放在 FC pause **之前**,并且**在每种结局上都执行**——一次往返失败的 pause 可能已经在 FC 侧落地了,而对一个从未暂停过的 VM 做 resume 是幂等空操作。

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

业务流程中,`bestEffortReclaim` 与 `guestPrepareFsForPause` 会通过 envd 的 fsfreeze 服务冻结/解冻 cgroup,确保 pause 时磁盘状态一致。

**2026.30 的 cgroup 冻结范围变化**:冻结目标从"只冻结我们自己的 cgroup"扩展为**冻结客户 workload 的 cgroup**——否则客户进程在冻结窗口内仍可能写入,rootfs 就不是一致状态。相关控制:

| Flag | 默认 | 作用 |
| --- | --- | --- |
| `freeze-user-cgroup` | `env.IsDevelopment()` | 冻结用户 cgroup |
| `freeze-user-cgroup-timeout-ms` | `2000` | 单次冻结超时 |
| `freeze-guest-hierarchy` | `false` | 冻结整棵 cgroup 层级 |
| `freeze-guest-hierarchy-max-cgroups` | `512` | 层级冻结的 cgroup 数上限 |
| `fsfreeze-via-exec` | `false` | 通过 exec 走 fsfreeze |

同时,**socat 不再跨 pause/resume 冻结**——它是宿主侧的转发进程,冻结它既不能提升磁盘一致性,又会让 pause 窗口内的连接处理停摆。

### 7.3 envd 版本检查

`packages/shared/pkg/utils/version.go`:

```go
func CheckEnvdVersionForSnapshot(envdVersion string) error
```

旧 envd 不支持 fsfreeze / memory snapshot 协议。两次校验:HTTP handler 入口 + Checkpoint gRPC handler 入口。

### 7.4 【2026.30 新增】两条 envd 升级路径

2026.30 引入了在沙箱生命周期内替换 envd 二进制的两条路径,都不需要重建模板:

| 路径 | 触发 | 机制 | Flag |
| --- | --- | --- | --- |
| **在线热升级** | 沙箱运行中 | `POST /upgrade`,**同一个 PID** 用 `syscall.Exec` 换掉进程镜像 | `envd-upgrade-target` |
| **离线 rootfs 替换** | 冷启动前 | 在 jailed 环境里用 `debugfs` 直接改写 `/usr/bin/envd` | `envd-offline-upgrade-target` |

两个 flag 的取值都是 `"off"` 表示关闭(默认),否则是一个版本目标。

在线路径的调用入口是 `Sandbox.CallEnvdUpgrade`(`packages/orchestrator/pkg/sandbox/envd.go:273`),返回 `execConfirmed bool`。判定失败是否可重试用 `isUpgradeDeliveryFailure`(同文件 `:343`)。握手结果与 `X-Envd-Handover` 响应头相关,定义在新的 `packages/envd/spec/upgrade/handover.proto`。

节点侧还有一层缓存:**`envd-binary-cache`**(默认跟随 `ENVD_BINARY_CACHE` 环境变量,未设时取 `env.IsDevelopment()`)把 envd 二进制缓存在节点本地,避免每次升级都重新拉取。相关文件:`packages/orchestrator/pkg/sandbox/envdbin/`。

> 注意:`POST /upgrade` **不在** `packages/envd/spec/envd.yaml` 里。它只在 orchestrator 的 `pkg/sandbox/envd` 中与那些标了 `x-internal: true` 的路由并列存在,因此不会出现在 envd 的 OpenAPI 契约中,也不会被 sandbox proxy 的拒绝列表自动覆盖。

### 7.5 【2026.30 新增】冷启动前的文件系统恢复

fs-only 快照恢复时,rootfs 是崩溃一致(crash-consistent)状态,可能带有未回放的 journal。2026.30 在**冷启动之前**加了一道可选的文件系统恢复:

- Flag:`preboot-fs-recovery`(默认 `false`)
- 机制:在 jailed 环境里执行 `e2fsck -p -E journal_only`
- 与 `fs_quiesced` 的关系:`MarkFsQuiesced` 持久化的标记正是让后续功能能够**安全判定"这个快照可以冷启动/改写而不需要 journal 修复"**的依据。也就是说,一个 quiesced 过的快照可以跳过恢复;没 quiesced 过的才需要。

相关测试:`packages/orchestrator/pkg/sandbox/fs_recover_preboot_test.go`、`reboot_gate_test.go`、`reboot_offline_gate_test.go`、`reboot_offline_upgrade_test.go`。

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

orchestrator 端 `packages/orchestrator/pkg/sandbox/template/cache.go:221` 把刚 pause 出来的 snapshot 注册到本地 cache:

- 同时注册 memfile diff、rootfs diff、snapfile、metafile
- 后续 resume 同 buildID 时**直接命中**,无需走 GCS

> ⚠️ **`ListCachedBuilds` 已于 2026.30 退役**:该 RPC 连同 `CachedBuildInfo` 消息从 `orchestrator.proto` 删除。本地 cache 的内容不再通过 gRPC 暴露给调度器。

### 8.4 并发信号量

| 信号量 | 位置 | 用途 |
| --- | --- | --- |
| `snapshotUpsertSem` | API orchestrator | 限制同时 `UpsertSnapshot` 数(防 DB 过载) |
| `startingSandboxes` | Orchestrator server | 限制同时启动(非 snapshot)的 sandbox 数 |
| `waitForAcquire` | Orchestrator server | 限制同时 snapshot resume 的 sandbox 数(15s 超时) |
| `snapshotUpsertSem` 容量 | `updateDBThrottleLimits`(`packages/api/internal/handlers/store.go`)动态调整 | 根据集群规模调优 |

**2026.30 的变化**:容量上限现在由 feature flag 提供,而不再只是硬编码的集群规模推导。`store.go:321` 构造时用 `featureflags.MaxConcurrentSnapshotUpserts`(`max-concurrent-snapshot-upserts`,默认 `0` = 交给 `dbThrottleLimit` 推导),`store.go:509` 在刷新时重新读取。同批还有 `max-concurrent-snapshot-build-queries`(限制 `GetSnapshotBuilds`,如 sandbox delete 路径)与 `max-concurrent-sandbox-list-queries`(限制 `GetSnapshotsWithCursor`)。

---

## 9. 配置项与 Feature Flags

### 9.1 Feature Flags(LaunchDarkly)

| Flag | 默认 | 影响 |
| --- | --- | --- |
| `peer-to-peer-async-checkpoint` | `false` | Checkpoint 上传同步/异步切换 |
| `peer-to-peer-chunk-transfer` | `false` | 启用模板数据的 peer-to-peer 路由 |
| `use-nfs-for-snapshots` | `env.IsDevelopment()` | 启用 NFS 本地 cache(snapshot 走自己的 path) |
| `use-nfs-for-templates` | `env.IsDevelopment()` | 启用 NFS 本地 cache(template) |
| `FreePageHintingTimeout`(按 use case) | — | balloon drain 超时;0 = 禁用 |
| 预清理 chain | — | LD 控制每个 reclaim 步骤的预算(默认 0 = 全禁用) |

**2026.30 新增的快照相关 flag**:

| Flag | 默认 | 影响 |
| --- | --- | --- |
| `in-place-checkpoint` | `false` | 启用 in-place checkpoint(还需 `use_sync_wp` 与 FC release 支持,见 §4.2.0) |
| `defer-rootfs-export` | `false` | 把 rootfs reflink 挪出 pause 关键路径(仅 NBD provider) |
| `defer-memory-export` | `false` | in-place checkpoint 的 CoW 内存窗口导出 |
| `preboot-fs-recovery` | `false` | 冷启动前跑 jailed `e2fsck -p -E journal_only` |
| `pause-admission-grace-milliseconds` | `-1` | snapshot-admission 预检宽限期;**负值 = 整个预检关闭** |
| `pause-refusal-restore` | `false` | 拒绝 pause 时把沙箱恢复回 Running |
| `auto-pause-overstay-budget-milliseconds` | `120000` | 过期 auto-pause 沙箱被节点拒绝后,evictor 继续重试内存快照的时长;超预算则退化为 fs-only 快照 |
| `fs-only-resume-api` | `false` | 开启 `memory:false` 的显式 resume 能力 |
| `fs-only-resume-cpu-model` | `""` | 把 fs-only resume 限制到单一 CPU model |
| `use-sync-wp` | `false` | FC `use_sync_wp`,in-place checkpoint 的前提 |
| `sync-wp-tracker-dirty` | `false` | 脏页追踪器 |
| `memfd-background-copy` | `true` | 把 memfd 流式写入快照 cache |
| `memfd-dedup-inflight-serve` | `false` | dedup 进行中即对外提供读取 |
| `envd-upgrade-target` | `"off"` | 在线 envd 热升级目标版本 |
| `envd-offline-upgrade-target` | `"off"` | 离线 rootfs 替换目标版本 |
| `envd-binary-cache` | `env.IsDevelopment()` | 节点本地 envd 二进制缓存 |
| `freeze-user-cgroup` | `env.IsDevelopment()` | 冻结客户 workload 的 cgroup |
| `freeze-guest-hierarchy` | `false` | 冻结整棵 cgroup 层级 |
| `max-concurrent-snapshot-upserts` | `0` | 覆盖 `UpsertSnapshot` 并发上限(0 = 交给 `dbThrottleLimit` 推导) |
| `max-concurrent-snapshot-build-queries` | `0` | 限制 `GetSnapshotBuilds` 并发 |
| `max-concurrent-sandbox-list-queries` | `0` | 限制 `GetSnapshotsWithCursor` 并发 |
| `free-page-reporting` | `false` | FC balloon free-page-reporting(in-place CoW 窗口依赖它) |
| `storage-soft-delete-check` / `storage-soft-delete-enforce` | `false` | 快照产物的软删除校验与强制执行 |
| `expiration-index-healer` | `true` | 过期索引修复 |

### 9.2 关键常量(orchestrator)

`packages/orchestrator/pkg/server/sandboxes.go:51-73`:

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

`packages/api/internal/cache/snapshots/snapshot_cache.go:19`:

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
│   ├── sandbox_fork.go                 ← POST /sandboxes/{id}/fork (checkpoint 一次 + 并行创建新 ID)
│   ├── sandbox_resume.go               ← POST /sandboxes/{id}/resume (deprecated) + buildResumeSandboxData
│   ├── sandbox_connect.go              ← POST /sandboxes/{id}/connect (KeepAlive + resume fallback)
│   ├── sandbox_kill.go                 ← DELETE /sandboxes/{id} (级联清快照 + throttledGetSnapshotBuilds)
│   ├── proxy_grpc.go                   ← gRPC SandboxService.ResumeSandbox (auto-resume 入口)
│   └── sandboxes_list.go               ← snapshotsToPaginatedSandboxes
├── orchestrator/
│   ├── snapshot_template.go            ← CreateSnapshotTemplate (Checkpoint orchestrator 入口)
│   ├── checkpoint_instance.go          ← CheckpointSandbox (Fork 的原地 checkpoint)
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
│   ├── sandboxes.go                    ← Pause(820) + Checkpoint(998) + checkpointInPlace(1188)
│   │                                      + checkpointResumeFresh(1271) + snapshotAndCacheSandbox(1468)
│   ├── upload_retry.go                 ← GCS 上传重试
│   └── prefetch_harvest.go             ← 预热映射收集
├── sandbox/
│   ├── sandbox.go                      ← Sandbox.Pause() (1942) + Factory.ResumeSandbox() (1207)
│   │                                      + EnsurePausable() (3596) + AwaitSnapshotAdmission() (3669)
│   ├── snapshot.go                     ← Snapshot 数据结构 + WaitMemorySealed()
│   ├── snapshot_metrics.go             ← diff/dedup 度量
│   ├── resume_prefetch.go              ← 【2026.30 新增】resume 预热消费侧
│   ├── envd.go                         ← envd 调用层(CallEnvdUpgrade 273)
│   ├── envd_memory.go                  ← 【2026.30 新增】envd 内存相关
│   ├── envdbin/                        ← 【2026.30 新增】节点本地 envd 二进制缓存
│   ├── template/cache.go               ← AddSnapshot(221,本地缓存)
│   ├── uploads.go                      ← Uploads 抽象
│   └── fc/
│       ├── client.go                   ← Firecracker loadSnapshot/createSnapshot
│       └── process.go                  ← CreateSnapshot(839,自定义 FC disk flush)
└── orchestrator.proto                  ← gRPC 接口定义(6 个 RPC,ListCachedBuilds 已删)
```

> ⚠️ 本文 2026.29 版本列出的 `server/template_cache.go` **在 2026.30 已不存在**。template cache 的唯一实现是 `pkg/sandbox/template/cache.go`。

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
├── sandbox_fork_test.go                 ← fork 参数、状态、并发和部分成功测试
└── sandbox_rapid_pause_resume_test.go   ← 快速 pause/resume 链测试

packages/db/pkg/tests/snapshots/
├── snapshot_latest_assignment_test.go   ← GetLastSnapshot 单元测试
└── upsert_snapshot_test.go              ← UpsertSnapshot 单元测试

tests/periodic-test/snapshot-and-resume.ts  ← 周期性回归测试
```

---

## 附录:常见疑问

**Q1: Pause 和 Checkpoint 区别?**
Pause 让 sandbox 进入 paused 状态(后续可 resume,但没有独立模板);Checkpoint 是"full-memory snapshot + 立即原地 resume",**原 sandbox 继续运行**。`/snapshots` 会在 checkpoint 外再创建或关联可复用模板,而 `/fork` 只刷新原 sandbox 的 snapshot row 并从中创建新 ID。

**Q2: 为什么 `env_builds.env_id` 无 FK?**
详见 [`database-schema.md` § 8.4](./database-schema.md#84-env--build-多对多去-fk-的反范式)。snapshot 流程也复用此设计:`CreateTemplateBuildAssignment` 显式写 `env_build_assignments`,触发器回填 `env_builds.env_id`。

**Q3: 同一 sandbox 多次 pause 怎么办?**
`snapshots.sandbox_id` 是 UNIQUE 的。`UpsertSnapshot` 用 `ON CONFLICT (sandbox_id) DO UPDATE`:首次创建 env+snapshot+build;后续只更新 snapshot 字段(metadata/origin_node_id/config)+ 新建一个 build。

**Q4: filesystem-only pause 为什么不能 auto-resume?**
Filesystem-only 没有 memfile + snapfile,resume 必须冷启动 reboot,内存状态丢失。`getAutoResumeSnapshot`(`proxy_grpc.go:99`)显式拒绝这种场景(`FailedPrecondition`),要求 caller 用 `/connect` 或 `/resume` 显式触发(显式路径允许 reboot)。

**Q4b: 2026.30 之后 `memory: false` 和 fs-only pause 是什么关系?**
两件不同的事,不要混为一谈:

- `POST /pause` 的 `memory: false` 决定**快照本身要不要内存**——写进去的就是 fs-only 快照;
- `/connect` 和 `/resume` 的 `memory: false` 决定**怎么恢复一个快照**——如果这个快照本来就含内存,请求可以选择只从磁盘状态恢复(冷启动),忽略并且**不修改、不删除**快照里的内存。

第二个方向只能"朝无内存放宽",不能反过来要求把无内存的快照恢复出内存(proto 注释的措辞:`can only widen toward the no-memory path`)。对一个本来就没有内存的快照传 `memory: false` 是 **no-op**,不报错。能力未开启时是**报错**而非静默降级成内存恢复。

**Q5: 快照的 CPU 兼容性怎么保证?**
Pause 时新建的 build **从 source build 复制 5 个 CPU 字段**(architecture/family/model/model_name/flags),而不是用执行 pause 的节点的 CPU 信息。这样 resume 时调度器用源 build 的 CPU spec 找兼容节点,跨代际 pause/resume 也能匹配。详见 `buildUpsertSnapshotParams` 与 `create_new_snapshot.sql`。

**Q6: 为什么 pause 被拒绝之后,沙箱反而被杀了?**
这是 2026.30 一个反直觉但刻意的设计。当 seal 已经闩定失败(或 admission 预检发现父 memfile dedup 永久失败)时,orchestrator **不返回拒绝**,而是在请求内 kill 并返回 `Internal`,错误文案里带上真实原因。理由:API 侧的 pause 链路在这条 RPC 返回之前就已经删除了路由记录,并且无论 RPC 结果如何都会移除 store 记录。所以"拒绝"根本保不住这个沙箱——它只会留下一个活着的 VM,由 orphan reconciler 在约 20 秒后杀掉,停止原因记成 `orphaned`。在请求内 kill 能让 API 的记录与事实一致。

注意 Checkpoint 的策略**不同**:同样遇到 latched error,Checkpoint 直接返回 `FailedPrecondition` 拒绝。原因是注释里那句 "Unlike Pause, nothing downstream re-checks a latched seal" —— Checkpoint 路径下游没有第二次检查。

**Q7: `Snapshotting` 之后为什么还要等前一次的 seal?**
因为 in-place checkpoint 会在同一个 `Sandbox` 对象上留下长生命周期的后台工作:rootfs 的 reflink+fold,以及 CoW 内存捕获窗口。这些状态不随一次 pause 结束而消失,所以一次**普通的 autopause** 也可能撞上前一次 in-place checkpoint 遗留的窗口。`Pause` 开头无条件等这两个 seal,并且放在最前面,就是为了(a)把超时的工作挡在 guest-frozen 窗口之外,(b)让闩定错误在沙箱还完好时中止。

---

> **版本说明**:已同步至 **2026.30**。本文所有 `file:line` 行号均以 tag `2026.30` 为准;与 2026.29 有差异处已并列标注。2026.30 的关键变动:`ListCachedBuilds` RPC 退役(§8)、快照容量上限改由 feature flag 提供(§9)、`resume_prefetch.go`/`envd_memory.go`/`envdbin/` 新增(§10)、`memory: false` 与 fs-only pause 的关系(附录 Q4b)。离线 envd 替换见 §7.4。
