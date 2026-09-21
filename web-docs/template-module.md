# E2B Template 模版系统详解

> 本文档详细描述 E2B Infrastructure 中 **Template(模版)** 子系统的设计、架构、数据模型、生命周期与关键实现。
>
> 适用于希望深入理解 template 系统的开发者,以及需要在此基础上做二次开发或排查问题的工程师。

---

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、数据模型](#三数据模型)
- [四、命名规范与标识符](#四命名规范与标识符)
- [五、版本体系](#五版本体系)
- [六、系统架构与组件](#六系统架构与组件)
- [七、Template 完整生命周期](#七template-完整生命周期)
- [八、Template Build 构建流程](#八template-build-构建流程)
- [九、Sandbox 启动如何使用 Template](#九sandbox-启动如何使用-template)
- [十、Alias 别名解析机制](#十alias-别名解析机制)
- [十一、存储结构](#十一存储结构)
- [十二、多层缓存体系](#十二多层缓存体系)
- [十三、gRPC 接口规范](#十三grpc-接口规范)
- [十四、并发限制与资源管理](#十四并发限制与资源管理)
- [十五、配置与环境变量](#十五配置与环境变量)
- [十六、Feature Flags](#十六feature-flags)
- [十七、关键代码文件索引](#十七关键代码文件索引)
- [十八、设计要点与演进历史](#十八设计要点与演进历史)
- [十九、常见问题与排查](#十九常见问题与排查)

---

## 一、概述

### 1.1 Template 是什么

在 E2B 中,**Template(模版)** 是 "沙盒镜像规格" 的抽象。一个 Template 定义了:

- 一个稳定的标识符(template ID 或 alias)
- 归属某个 Team
- 一组构建(Builds),每个 Build 对应一份 rootfs / memfile / snapfile / metadata 文件,可用于启动一个或多个沙盒(Sandbox)

简单理解:**Template = 可复用的沙盒镜像规格**。Sandbox 必须基于某个 Template 的某个 Build 才能启动。

### 1.2 Template 在 E2B 中的角色

```
┌────────────┐    创建     ┌──────────────┐    构建     ┌─────────────────┐
│  User SDK  │ ─────────▶ │  Template    │ ─────────▶ │  Template Build │
│  / CLI     │            │  (envs 表)   │            │  (env_builds 表)│
└────────────┘            └──────────────┘            └─────────────────┘
                                                                │
                                                                │ 产物上传
                                                                ▼
                                                        ┌──────────────┐
                                                        │  GCS Bucket  │
                                                        │  fc-templates│
                                                        └──────────────┘
                                                                │
                                                                │ 启动时拉取
                                                                ▼
┌────────────┐   启动沙盒   ┌──────────────┐   通知    ┌──────────────────┐
│  User SDK  │ ─────────▶  │  API Server  │ ───────▶ │   Orchestrator   │
└────────────┘             └──────────────┘           │ (Firecracker VM) │
                                                      └──────────────────┘
                                                                │
                                                                ▼
                                                       ┌─────────────────┐
                                                       │   Sandbox 实例  │
                                                       │ (基于 Build 启动)│
                                                       └─────────────────┘
```

### 1.3 命名历史包袱(重要)

阅读代码前必须了解:

| 代码层 | 命名 | 说明 |
|--------|------|------|
| **数据库层** | `envs` / `env_builds` / `env_aliases` | 早期叫 "environment",后改名 template 但表名未改 |
| **应用层** | `template` / `template build` / `template alias` | 对外统一的命名 |
| **`envs.source` 列** | `'template'` / `'snapshot'` / `'snapshot_template'` | 区分三种来源 |

因此在 DB migration、SQL 查询、ent schema 里看到 `env*` 命名时,要意识到它实际上就是 template。

---

## 二、核心概念

### 2.1 Template(模版)

- **定义**:沙盒镜像规格的抽象
- **DB 表**:`public.envs`(`source IN ('template', 'snapshot_template')`)
- **唯一标识**:template ID(20 字符随机串,由 `id.Generate()` 生成)
- **归属**:某个 Team(`team_id`)
- **可见性**:public(对其他 team 可见)或 private
- **状态**:软删除(`deleted_at` 字段),视图 `active_envs` 自动过滤已删除的

### 2.2 Template Build(模版构建)

- **定义**:Template 的一次具体构建,产物是一组 GCS 文件(rootfs、memfile、snapfile、metadata)
- **DB 表**:`public.env_builds`
- **唯一标识**:build ID(UUID)
- **关系**:一个 Template 可以有多个 Build(通过 `env_build_assignments` 多对多关联)

#### Build 状态机

Build 有两套状态值:

**原始状态(`env_builds.status` 列)**:

Go 代码中定义的常量(见 [`packages/db/pkg/types/types.go:145-153`](../packages/db/pkg/types/types.go) `BuildStatus*`):

| 状态 | 含义 |
|------|------|
| `pending` | 等待开始 |
| `waiting` | 等待(兼容旧值,当前 v3 默认写入这个) |
| `building` | 构建中 |
| `snapshotting` | 快照中 |
| `uploaded` | 已上传(build 完成时写入) |
| `success` | 成功(兼容旧值) |
| `failed` | 失败 |

> **注意**:`status_group` 触发器的 CASE 表达式(见 [18.8 节](#188-status_group-触发器))还覆盖了 `'in_progress'` 和 `'ready'` 两个值,但 Go 常量 `BuildStatus*` 并未定义它们 — 应用层实际写入的是 `waiting`/`building`/`snapshotting`/`uploaded` 这些值。触发器包含 `'in_progress'`/`'ready'` 是为了向前兼容未来可能的 status 值迁移。

**归一化状态组(`env_builds.status_group` 列)**:

由数据库触发器自动维护(见 migration `20260210120002_add_status_group_column.sql`):

```sql
CASE
  WHEN status IN ('pending','waiting')         THEN 'pending'
  WHEN status IN ('in_progress','building','snapshotting') THEN 'in_progress'
  WHEN status IN ('ready','uploaded','success') THEN 'ready'
  ELSE 'failed'
END
```

| status_group | 包含的 status 值 | `IsTerminal()` |
|--------------|------------------|----------------|
| `pending` | pending, waiting | false |
| `in_progress` | in_progress, building, snapshotting | false |
| `ready` | ready, uploaded, success | **true** |
| `failed` | 其他 | **true** |

> **代码约定**:读操作都用 `status_group`,写操作用具体 `status`。这是为了向后兼容老 status 值仍可读,同时简化消费者逻辑。

### 2.3 Template Alias(模版别名)

- **定义**:Template 的可读名字,对用户友好
- **DB 表**:`public.env_aliases`
- **格式**:`namespace/alias:tag`(各部分均可选)
- **用途**:让用户用 `my-team/python-env:prod` 引用 Template,而不是用随机 ID

#### 别名命名规范

详见 [`packages/shared/pkg/id/id.go`](../packages/shared/pkg/id/id.go):

```
格式:    [namespace/]alias[:tag]
分隔符:  namespace = "/"   tag = ":"
默认 tag: "default"

正则:
  identifier (alias/namespace): ^[a-z0-9-_]+$
  tag:                         ^[a-z0-9-_.]+$

约束:
  - tag 不能是 UUID(防止和 build_id 冲突)
  - alias/namespace 必须小写
  - 自动 trim + lowercase
```

示例:

| 输入 | namespace | alias | tag |
|------|-----------|-------|-----|
| `my-team/python-env:prod` | `my-team` | `python-env` | `prod` |
| `python-env` | (nil) | `python-env` | `default` |
| `python-env:staging` | (nil) | `python-env` | `staging` |
| `my-team/python-env` | `my-team` | `python-env` | `default` |

### 2.4 Template Tag(模版标签)

- **定义**:给 Build 加的"标记",让同一个 Template 下可以有多个同时 active 的 Build
- **DB 表**:`public.env_build_assignments`(M-N 关系表)
- **引入版本**:migration `20251218160000_allow_m_n_builds_with_tags.sql`

#### Tag 的关键不变量

1. 每个 build 至少有一个 `default` tag(在 build 注册时自动加)
2. 同一个 template 下,每个 tag 对应"最新一次"的 build(由 `created_at DESC LIMIT 1` 决定)
3. tag 不能是 UUID
4. `default` tag 不能被删除

#### 为什么需要 Tag

历史上一个 template 只能有一个 active build,重新 build 会覆盖旧的。引入 tag 后:

```
Template: my-python-env
  ├── tag "prod"     → Build A (稳定版本)
  ├── tag "staging"  → Build B (预发布版本)
  └── tag "dev"      → Build C (开发版本)
```

不同 tag 的 build 共存,用户可以按 tag 选择启动哪个版本。

### 2.5 Snapshot(快照)

- **定义**:对**正在运行的 Sandbox** 做的运行时持久化,记录内存(memfile)、文件系统(rootfs)、CPU 状态(snapfile)
- **DB 表**:`public.snapshots`
- **用途**:让 Sandbox 可以暂停(Pause)和恢复(Resume),节省成本

### 2.6 Snapshot Template(快照模版)

- **定义**:从运行中的 Sandbox 创建的"持久化 Template"
- **DB 表**:`public.envs`(source = `'snapshot_template'`)+ `public.snapshot_templates`(元信息)
- **用途**:让用户把当前 Sandbox 的状态保存为可复用的 Template

#### 三种 source 的区别

| `envs.source` | 含义 | 生命周期 | 创建方式 |
|---------------|------|----------|----------|
| `'template'` | 普通 Template | 长期 | 通过 build 流程 |
| `'snapshot'` | 暂停的 Sandbox 快照 | 短期(对应某个 sandbox) | Sandbox pause |
| `'snapshot_template'` | 持久化的快照模版 | 长期 | 从运行 sandbox 创建 |

### 2.7 概念之间的关系

```
                    ┌─────────────────────────────┐
                    │          Team               │
                    │   (teams.id = team_id)      │
                    └────────────┬────────────────┘
                                 │ 1:N
                                 ▼
                    ┌─────────────────────────────┐
                    │       Template (envs)       │
                    │  source='template'          │
                    │  或 'snapshot_template'     │
                    └──┬────────┬────────┬────────┘
                       │ 1:N    │ 1:N    │ 1:N
            ┌──────────┘        │        └──────────┐
            ▼                   ▼                   ▼
   ┌─────────────────┐  ┌───────────────┐  ┌──────────────────┐
   │ Template Alias  │  │ Template Build│  │ Snapshot         │
   │ (env_aliases)   │  │ (env_builds)  │  │ (snapshots)      │
   │                 │  │               │  │                  │
   │ namespace/alias │  │ status        │  │ source='snapshot'│
   └─────────────────┘  └───────┬───────┘  └──────────────────┘
                                │ N:N
                                ▼
                        ┌───────────────────────┐
                        │ env_build_assignments │
                        │ (tag 关联)            │
                        │                       │
                        │ tag = "default"       │
                        │ tag = "prod"          │
                        │ tag = "dev"           │
                        └───────────────────────┘
```

---

## 三、数据模型

### 3.1 数据库表总览

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `envs` | Template 主体 | id, team_id, source, public, build_count, spawn_count, deleted_at |
| `env_builds` | Build 记录 | id, status, status_group, kernel_version, firecracker_version, envd_version |
| `env_build_assignments` | Template ↔ Build M:N | env_id, build_id, tag |
| `env_aliases` | 别名 | id(uuid), alias, namespace, env_id |
| `active_template_builds` | 并发限制追踪 | build_id, team_id, template_id, tags |
| `snapshots` | Sandbox 快照 | id, env_id, sandbox_id, base_env_id |
| `snapshot_templates` | 快照模版元信息 | env_id, sandbox_id, origin_node_id, build_id |
| `tiers` | 套餐(含并发限制) | concurrent_template_builds |

### 3.2 `public.envs`(Template 主体表)

最早来源:[`20231124185944_create_schemas_and_tables.sql`](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql),后续多个 migration 演进。

| 字段 | 类型 | 含义 | 来源 migration |
|------|------|------|----------------|
| `id` | text PK | template ID(`id.Generate()` 20 字符) | 初始 |
| `created_at` | timestamptz | 创建时间 | 初始 |
| `updated_at` | timestamptz | 更新时间(每次 build 自动更新) | 初始 |
| `deleted_at` | timestamptz NULL | 软删除时间 | `20260628120000_add_env_deleted_at.sql` |
| `public` | boolean | 是否对外公开 | 初始 |
| `build_count` | integer | 构建次数 | 初始 |
| `spawn_count` | bigint | 沙盒启动次数 | 初始 |
| `last_spawned_at` | timestamptz NULL | 最近一次沙盒启动时间 | 初始 |
| `team_id` | uuid FK→teams | 归属 team | 初始 |
| `created_by` | uuid NULL | 创建者 user ID | `20241127174604_add_env_creator.sql` |
| `cluster_id` | uuid NULL FK→clusters | 所属集群 | `20250624001048_cluster_for_templates.sql` |
| `source` | text NOT NULL DEFAULT 'template' | 来源类型 | `20260210120001_add_env_and_build_source_columns.sql` |

**视图 `public.active_envs`**(migration `20260628120000`):

```sql
-- 等同于
SELECT * FROM envs WHERE deleted_at IS NULL;
```

这是绝大多数读操作的入口,自动过滤已删除的 template。

### 3.3 `public.env_builds`(Build 表)

最早来源:[`20240315165236_create_env_builds.sql`](../packages/db/migrations/20240315165236_create_env_builds.sql)。

| 字段 | 类型 | 含义 |
|------|------|------|
| `id` | uuid PK | build ID |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 更新时间 |
| `finished_at` | timestamptz NULL | 完成时间 |
| `status` | text | Build 原始状态(见 [2.2](#22-template-build模版构建)) |
| `status_group` | text NOT NULL | 归一化状态组(触发器自动维护) |
| `reason` | jsonb NULL | 失败原因 `{message, step}` |
| `dockerfile` | text NULL | Dockerfile 内容(v2 build 用) |
| `start_cmd` | text NULL | 沙盒启动时执行的命令 |
| `ready_cmd` | text NULL | 沙盒"就绪"判定命令 |
| `vcpu` | bigint | CPU 核数 |
| `ram_mb` | bigint | 内存 MB |
| `free_disk_size_mb` | bigint NOT NULL | **build 后要求的 rootfs 空闲空间(MiB)**,2026.30 起由 `team.LimitFreeDiskSize` 按配额解析后写入(见 §7.2 Step 5) |
| `total_disk_size_mb` | bigint NULL | 实际磁盘大小 |
| `kernel_version` | text | 内核版本(默认 `vmlinux-5.10.186`) |
| `firecracker_version` | text | Firecracker 版本 |
| `envd_version` | text NULL | envd 版本 |
| `team_id` | uuid NULL | team ID(`20260218120000`) |
| `cluster_node_id` | text NULL | 执行 build 的 node ID |
| `version` | text NULL | template schema 版本(`v1.0.0`/`v2.0.0`/`v2.1.0`) |
| `cpu_architecture` | text NULL | CPU 架构 |
| `cpu_family` | text NULL | CPU family |
| `cpu_model` | text NULL | CPU model |
| `cpu_model_name` | text NULL | CPU model 名称 |
| `cpu_flags` | text[] NULL | CPU flags |

### 3.4 `public.env_build_assignments`(Template ↔ Build 多对多)

来源:[`20251218160000_allow_m_n_builds_with_tags.sql`](../packages/db/migrations/20251218160000_allow_m_n_builds_with_tags.sql)。

| 字段 | 类型 | 含义 |
|------|------|------|
| `id` | uuid PK | |
| `env_id` | text FK→envs | template ID |
| `build_id` | uuid FK→env_builds | build ID |
| `tag` | text | 标签(如 `default`、`prod`) |
| `source` | text DEFAULT 'app' | `app` / `trigger` / `migration`(过渡用) |
| `created_at` | timestamptz | |

**索引**:

- `uq_legacy_assignments (env_id, build_id, tag) WHERE source IN ('trigger', 'migration')` — 部分唯一索引
- `idx_env_build_assignments_env_tag_created (env_id, tag, created_at DESC)` — 主要查询索引
- `idx_env_build_assignments_env_build (env_id, build_id)`

> **演进说明**:此表一开始通过触发器从 `env_builds.env_id` 自动同步(migration `20251218160000`),后来在 `20260204172712_remove_build_assignment_triggers.sql` 移除了所有同步触发器,改为应用层直接管理,并保留了一个 `backfill_env_id_from_assignment()` 触发器(反向 backfill)。

### 3.5 `public.active_template_builds`(并发限制追踪)

来源:[`20260305130000_create_active_template_builds.sql`](../packages/db/migrations/20260305130000_create_active_template_builds.sql)。

| 字段 | 类型 | 含义 |
|------|------|------|
| `build_id` | uuid PK | |
| `team_id` | uuid NOT NULL | |
| `template_id` | text NOT NULL | |
| `tags` | text[] NOT NULL | |
| `created_at` | timestamptz DEFAULT NOW() | |

**索引**:`idx_active_template_builds_team_created_at (team_id, created_at DESC)`

**外键**:migration `20260413120000_active_template_builds_fk_envs.sql` 加了 `FK template_id → envs(id) ON DELETE CASCADE`,删除 template 时自动清理。

### 3.6 `public.env_aliases`(别名表)

| 字段 | 类型 | 含义 |
|------|------|------|
| `id` | uuid PK | `20260127120000_add_env_aliases_uuid_pkey.sql` 把 PK 从 alias 改为 UUID |
| `alias` | text NOT NULL | |
| `namespace` | text NULL | `20260121175430_add_env_aliases_namespace.sql` 引入 |
| `env_id` | text FK→envs | |
| `is_renamable` | boolean | |

**唯一约束**:`(alias, namespace) NULLS NOT DISTINCT` — namespace 为 NULL 时也按唯一处理。

### 3.7 `public.snapshots`(Snapshot 表)

来源:[`20241213142106_create_snapshots.sql`](../packages/db/migrations/20241213142106_create_snapshots.sql)。

| 字段 | 类型 | 含义 |
|------|------|------|
| `id` | uuid PK DEFAULT gen_random_uuid() | |
| `created_at` | timestamptz NULL | |
| `env_id` | text FK→envs ON DELETE CASCADE | |
| `sandbox_id` | text NOT NULL UNIQUE | |
| `metadata` | jsonb NULL | |
| `base_env_id` | text NOT NULL | 基础 template |
| `team_id` | uuid | `20250923094021` |
| `sandbox_started_at` | timestamptz | `20250404151700`(用于计费) |
| `env_secure` | boolean | `20250409113306` |
| `allow_internet_access` | boolean | |
| `origin_node_id` | text | 快照来源 node |
| `auto_pause` | boolean | `20250818114512_auto_pause.sql` |
| `config` | jsonb NULL | `PausedSandboxConfig`,`20251106172810` |

### 3.8 `public.snapshot_templates`(Snapshot Template 元信息)

来源:[`20260211120000_add_snapshot_templates.sql`](../packages/db/migrations/20260211120000_add_snapshot_templates.sql) + [`20260228120000_snapshot_template_origin_node.sql`](../packages/db/migrations/20260228120000_snapshot_template_origin_node.sql)。

```sql
CREATE TABLE snapshot_templates (
    env_id text NOT NULL PRIMARY KEY REFERENCES envs(id) ON DELETE CASCADE,
    sandbox_id text NOT NULL,
    created_at timestamptz DEFAULT now(),
    origin_node_id TEXT,
    build_id UUID
);
```

### 3.9 `public.tiers`(套餐表)

migration `20250901161352_add_concurrent_template_builds_to_tier.sql` 加了:

```sql
ALTER TABLE tiers
  ADD COLUMN concurrent_template_builds bigint NOT NULL DEFAULT 20;
```

用于限制 team 的并发 build 数。

**2026.30 新增:磁盘配额列(两个 migration)**

| migration | 新增列 | 说明 |
|-----------|--------|------|
| [`20260714091414_add_template_disk_entitlements.sql`](../packages/db/migrations/20260714091414_add_template_disk_entitlements.sql) | `tiers.default_free_disk_size_mb`、`tiers.max_disk_size_mb`、`addons.extra_max_disk_size_mb` | 回填 `default_free_disk_size_mb = disk_mb`、`max_disk_size_mb = disk_mb + 25000`;`default_free_disk_size_mb` 与 `max_disk_size_mb` 加 `NOT NULL` + CHECK(`>= 0`、`> 0`、`default <= max`) |
| [`20260826075153_add_free_disk_limit_columns.sql`](../packages/db/migrations/20260826075153_add_free_disk_limit_columns.sql) | `tiers.max_free_disk_size_mb`、`addons.extra_max_free_disk_size_mb`、`project_limits.max_free_disk_size_mb` | 这三个列**保持 nullable**——应用层双写部署完成前,旧读写方仍可能省略它们;并 `CREATE OR REPLACE VIEW team_limits` 追加 `max_free_disk_size_mb` |

> ⚠️ 第二个 migration 里 `team_limits` 视图同时输出 `max_disk_size_mb` 和 `max_free_disk_size_mb`,**两者取的是同一个表达式**(`COALESCE(pl.max_disk_size_mb, tier.max_disk_size_mb + a.extra_max_disk_size_mb)`)。`max_free_disk_size_mb` 是"更清晰的名字",旧列在兼容期仍权威。视图列只能追加不能删,所以 Down 迁移必须 `DROP VIEW` 再重建。

> ⚠️ **`disk_mb` 与 `max_disk_size_mb` 不是同一件事**:`disk_mb` 是历史的总盘上限列,`max_disk_size_mb` 是"逻辑 rootfs 在加 addon 之前的天花板";`default_free_disk_size_mb` 才是**默认的 build 后空闲空间目标**,和 §8.3.1 的 `FreeDiskSizeMB` 直接对应。team 侧的有效值通过 `team_limits` 视图计算。

### 3.10 ER 关系图

```
┌──────────┐       ┌──────────────────┐       ┌────────────────────┐
│  teams   │ 1   N │      envs        │ 1   N │   env_aliases      │
│ ────────│◀──────│ id (PK)          │──────▶│ env_id (FK)        │
│ id (PK)  │       │ team_id (FK)     │       │ (alias, namespace) │
│ ...      │       │ source           │       │        UNIQUE      │
└──────────┘       │ deleted_at       │       └────────────────────┘
                   └────────┬─────────┘
                            │ 1:N (through assignments)
                            ▼
                   ┌────────────────────┐        ┌────────────────────────┐
                   │ env_builds         │ N    M │ env_build_assignments  │
                   │ ─────────────      │◀──────▶│ ────────────────────── │
                   │ id (PK)            │        │ env_id (FK)            │
                   │ status / group     │        │ build_id (FK)          │
                   │ kernel_version     │        │ tag                    │
                   │ firecracker_version│        │ source                 │
                   │ envd_version       │        └────────────────────────┘
                   │ team_id            │
                   │ cluster_node_id    │        ┌────────────────────────┐
                   │ version            │        │ active_template_builds │
                   └────────────────────┘        │ ────────────────────── │
                                                 │ build_id (PK)          │
                                                 │ team_id                │
                                                 │ template_id (FK)       │
                                                 │ tags[]                 │
                                                 └────────────────────────┘

┌─────────────────┐       ┌──────────────────────┐
│   snapshots     │ 1   N │  snapshot_templates  │
│ ─────────────── │◀──────│ env_id (PK, FK)      │
│ env_id (FK)     │       │ sandbox_id           │
│ sandbox_id (UQ) │       │ origin_node_id       │
│ base_env_id     │       │ build_id             │
└─────────────────┘       └──────────────────────┘
```

---

## 四、命名规范与标识符

### 4.1 Template ID

- 由 [`id.Generate()`](../packages/shared/pkg/id/id.go) 生成
- 20 字符随机串(`uniuri.UUIDLen = 20`),小写字母 + 数字(`[a-z0-9]`,见 `packages/shared/pkg/id/id.go:16,28`)
- 基于 `dchest/uniuri` 库,长度同 UUID

```go
// packages/shared/pkg/id/id.go:28
func Generate() string {
    return uniuri.NewLenChars(uniuri.UUIDLen, caseInsensitiveAlphabet)
}
```

### 4.2 Build ID

- 标准 UUID v4
- 由数据库或应用层生成

### 4.3 完整名称解析

完整名称格式:`[namespace/]alias[:tag]`

解析函数:[`id.ParseName`](../packages/shared/pkg/id/id.go)

```go
func ParseName(input string) (identifier string, tag *string, err error)
```

**解析规则**:

1. 用 `:` 切出 tag 部分(可选)
2. 用 `/` 切出 namespace 部分(可选)
3. 校验 tag(不能是 UUID,匹配 `^[a-z0-9-_.]+$`)
4. 校验 namespace(匹配 `^[a-z0-9-_]+$`)
5. 校验 alias(匹配 `^[a-z0-9-_]+$`)
6. 自动 lowercase + trim
7. tag = `"default"` 时返回 `nil`(使用默认值)

**Namespace 校验**:[`ValidateNamespaceMatchesTeam`](../packages/shared/pkg/id/id.go) 确保 namespace 必须等于 team slug,防止越权:

```go
func ValidateNamespaceMatchesTeam(identifier, teamSlug string) error {
    namespace, _ := SplitIdentifier(identifier)
    if namespace != nil && *namespace != teamSlug {
        return fmt.Errorf("namespace '%s' must match your team '%s'", *namespace, teamSlug)
    }
    return nil
}
```

### 4.4 Tag 校验

```go
// packages/shared/pkg/id/id.go:50
func validateTag(tag string) (string, error) {
    cleanedTag, err := cleanAndValidate(tag, "tag", tagRegex)
    if err != nil {
        return "", err
    }
    // Prevent tags from being a UUID
    _, err = uuid.Parse(cleanedTag)
    if err == nil {
        return "", errors.New("tag cannot be a UUID")
    }
    return cleanedTag, nil
}
```

**Tag 去重**:[`ValidateAndDeduplicateTags`](../packages/shared/pkg/id/id.go) 用 map 去重,返回无序的去重列表。

---

## 五、版本体系

### 5.1 Template Schema 版本

定义在 [`packages/shared/pkg/templates/versions.go`](../packages/shared/pkg/templates/versions.go):

```go
const (
    TemplateV2LatestVersion   = "v2.1.0"
    TemplateV2ReleaseVersion  = "v2.1.0"
    TemplateV2BetaVersion     = "v2.0.0"
    TemplateV1Version         = "v1.0.0"
)

const (
    SDKTemplateReleaseVersion = "2.3.0"
)
```

### 5.2 版本差异

| 版本 | 特性 | 说明 |
|------|------|------|
| `v1.0.0` | 仅支持 Dockerfile | 老式 build,只能用 Dockerfile 定义 image |
| `v2.0.0` (beta) | 引入 `from_image` / `from_template` / `steps` | 更灵活的构建方式 |
| `v2.1.0` (release/latest) | 当前推荐版本 | 在 v2.0.0 基础上完善 |

### 5.3 版本决定 Build 流程

build 时根据 `version` 字段决定走哪个流程:

- **v1**:只能用 `dockerfile`,build 过程相对简单
- **v2+**:支持 `from_image` / `from_template` / `steps`,每个 step 是一个可缓存的 layer

### 5.4 SDK 版本

`SDKTemplateReleaseVersion = "2.3.0"` 用于 SDK 兼容性检查。

### 5.5 Firecracker / Kernel / Envd 版本

这些版本不写在 `versions.go`,而是通过 feature flag 控制:

- `BuildFirecrackerVersion`(`build-firecracker-version`,[`flags.go:743`](../packages/shared/pkg/featureflags/flags.go))— build 用的 Firecracker 版本
- `BuildKernelVersion`(`build-kernel-version`,[`flags.go:744`](../packages/shared/pkg/featureflags/flags.go))— build 用的 kernel 版本
- `BuildEnvdVersion`(`build-envd-version`,2026.30 新增,[`flags.go:756`](../packages/shared/pkg/featureflags/flags.go))— build 烘进 rootfs 的 envd 二进制
- `BuildIoEngine`(`build-io-engine`,[`flags.go:757`](../packages/shared/pkg/featureflags/flags.go))— 默认 `Sync`

默认值(运行时,见 [`packages/shared/pkg/featureflags/flags.go`](../packages/shared/pkg/featureflags/flags.go)):

| 项 | 默认值 | 常量 / 行号(2026.30) |
|----|--------|----------------------|
| Kernel | `vmlinux-6.1.158` | `DefaultKernelVersion`,[:705](../packages/shared/pkg/featureflags/flags.go)(2026.29 为 :473) |
| Firecracker | `v1.14-0.2.0` | `DefaultFirecrackerVersion`,[:731](../packages/shared/pkg/featureflags/flags.go)(2026.29 为 :482) |
| envd | `promoted` | `DefaultEnvdVersion`,[:712](../packages/shared/pkg/featureflags/flags.go)(2026.30 新增) |

> ⚠️ **Firecracker 默认版本在 2026.30 换了 release line**。2026.29 时 `DefaultFirecrackerVersion = DefaultFirecrackerV1_14Version = "v1.14.1_431f1fc"`;2026.30 改成 `DefaultFirecrackerVersion = DefaultFirecrackerV1_14_0Version = "v1.14-0.2.0"`([`flags.go:726,731`](../packages/shared/pkg/featureflags/flags.go))。**已存在的 build 仍在自己那条 line 内解析**(`FirecrackerVersionMap` 的 `key == LDKey(value)` 不变量禁止跨 line 漂移),跨 line 升级只能由运维通过 `firecracker-versions` flag 显式做。

> ⚠️ `DefaultEnvdVersion = "promoted"` 表示"用节点本地已晋升的二进制"(`HOST_ENVD_PATH`)——也就是所有 build 一直以来的行为。因此没有 LaunchDarkly 的部署(dev、self-host)行为不变。只有显式 pin 一个具体版本 id 才会去取 staged 二进制。

**envd 二进制的解析**(2026.30 新增,[`build/core/envd/resolve.go`](../packages/orchestrator/pkg/template/build/core/envd/resolve.go)):

`ResolveBuildBinary(ctx, target, hostEnvdPath)`([`resolve.go:34`](../packages/orchestrator/pkg/template/build/core/envd/resolve.go))的规则:

1. `target` 为空或 `"promoted"` → 直接用 `hostEnvdPath`。
2. 否则 `target` 必须匹配 `buildVersionRe = ^[a-zA-Z0-9][a-zA-Z0-9.-]*$`([`resolve.go:16`](../packages/orchestrator/pkg/template/build/core/envd/resolve.go)),然后依次尝试两种 staged 布局:flat 的 `envd.<target>` 兄弟文件,和 release bucket 的 `<target>/envd` 目录。
3. **promoted 二进制只有在它烘进去的版本就等于 `target` 时才被接受**(比较时去掉前导 `v`,[`resolve.go:58`](../packages/orchestrator/pkg/template/build/core/envd/resolve.go));否则 **build 直接失败**。

> ⚠️ 这是刻意的 fail-fast:feature gate 是按"烘进去的版本"来分流的,静默替换成别的 envd 会导致 gate 误判。错误文案形如 `build-envd-version target %q is not staged under %q (tried %v), and the promoted binary is v%s, not the target`。

> 注:数据库列(`env_builds.kernel_version` 等)在 `20240315165236_create_env_builds.sql` 中的 DEFAULT 仍是 `vmlinux-5.10.186` / `v1.7.0-dev_8bb88311`,但那只是历史遗留的 schema 默认,运行时实际使用上面的 feature flag 默认值。

具体版本定义见 [`packages/fc-versions/`](../packages/fc-versions/)。

---

## 六、系统架构与组件

### 6.1 整体架构

```
                    ┌─────────────────────────────────────────┐
                    │              User / SDK                  │
                    └──────────────┬──────────────────────────┘
                                   │ REST API
                                   ▼
                    ┌─────────────────────────────────────────┐
                    │           API Server (Gin)               │
                    │           packages/api                   │
                    │                                          │
                    │  ┌─────────────┐  ┌──────────────────┐  │
                    │  │  Handlers   │  │ Template Cache   │  │
                    │  │ (REST 端点) │  │ (Redis, 5min)    │  │
                    │  └──────┬──────┘  └──────────────────┘  │
                    │         │                                │
                    │  ┌──────▼────────────────────────────┐  │
                    │  │ template.RegisterBuild (DB 事务)  │  │
                    │  └──────┬────────────────────────────┘  │
                    │         │                                │
                    │  ┌──────▼────────────────────────────┐  │
                    │  │ template-manager client            │  │
                    │  │ (gRPC client + 状态轮询)           │  │
                    │  └──────┬────────────────────────────┘  │
                    └─────────┼───────────────────────────────┘
                              │ gRPC
                   ┌──────────┴───────────┐
                   │                      │
                   ▼                      ▼
    ┌──────────────────────┐   ┌──────────────────────────────┐
    │  template-manager    │   │       orchestrator           │
    │     gRPC Service     │   │       gRPC Service            │
    │  (build 流程)        │   │   (sandbox 生命周期)         │
    │                      │   │                              │
    │ packages/orchestrator│   │ packages/orchestrator        │
    │   /pkg/template/     │   │   /pkg/server/               │
    │                      │   │                              │
    │ ┌──────────────────┐ │   │ ┌──────────────────────────┐ │
    │ │   Builder        │ │   │ │  sbxtemplate.Cache       │ │
    │ │ (build 流程)     │ │   │ │  (本地文件缓存, 25h)    │ │
    │ └────────┬─────────┘ │   │ └────────────┬─────────────┘ │
    │          │           │   │              │               │
    │ ┌────────▼─────────┐ │   │ ┌────────────▼─────────────┐ │
    │ │ Firecracker VM   │ │   │ │  Firecracker VM          │ │
    │ │ (build 用)       │ │   │ │  (sandbox 用)            │ │
    │ └────────┬─────────┘ │   │ └──────────────────────────┘ │
    └──────────┼───────────┘   └──────────────────────────────┘
               │
               │ 上传 build 产物
               ▼
    ┌──────────────────────────┐
    │   GCS Bucket              │
    │   fc-templates            │
    │                           │
    │   {buildID}/              │
    │     memfile               │
    │     rootfs.ext4           │
    │     snapfile              │
    │     metadata.json         │
    └──────────────────────────┘
```

### 6.2 各组件职责详解

#### 6.2.1 `packages/shared/pkg/templates/`

**职责**:存放 template schema 版本常量。

**唯一文件**:[`versions.go`](../packages/shared/pkg/templates/versions.go) — 见 [第五节](#五版本体系)。

#### 6.2.2 `packages/api/internal/template/`

**职责**:API 端的 template "build 注册" 逻辑(DB 层)。

**核心文件**:[`register_build.go`](../packages/api/internal/template/register_build.go)

**核心函数 `RegisterBuild`** 的事务结构(见 [`register_build.go`](../packages/api/internal/template/register_build.go)):

**事务外(预检查)**:

0. 检查 team 的并发 build 上限(`GetInProgressTemplateBuildsByTeam`,排除当前 template + tags,见 [第十四节](#十四并发限制与资源管理))
1. 生成 build ID(`uuid.NewRandom()`)
2. 资源限制校验(`team.LimitResources`)

**事务内(6 步原子操作 + commit)**:

1. `CreateOrUpdateTemplate`(插入或更新 `envs` 行,`build_count++`;软删除的 template 不能重建)
2. `InvalidateUnstartedTemplateBuilds`(把同 tag 下还没启动的旧 build 标记为 failed)
3. `CreateTemplateBuild`(插入新的 `env_builds` 行,初始状态 `waiting`)
4. 处理 alias(CheckAliasConflictsWithTemplateID → DeleteOtherTemplateAliases → CreateTemplateAlias)
5. 为每个 tag `CreateTemplateBuildAssignment`(循环)
6. `CreateActiveTemplateBuild`(并发追踪)

最后 `tx.Commit` 提交事务。

> **注意**:这个文件是 template build 生命周期的"起点"。它只把 build 写入 DB(状态 `waiting`),真正的构建由 template-manager gRPC 异步执行。并发检查在事务外(无锁,近似实现,见 [14.4 节](#144-并发限制的近似实现))。

#### 6.2.3 `packages/api/internal/template-manager/`

**职责**:API 端的 template-manager gRPC 客户端封装。

**与 `internal/template/` 的区别**:
- `internal/template/` — DB 层 build 注册
- `internal/template-manager/` — gRPC 层 build 调度

**关键文件**:

| 文件 | 作用 |
|------|------|
| [`template_manager.go`](../packages/api/internal/template-manager/template_manager.go) | `TemplateManager` 类型,管理 cluster pool、build cache、template cache |
| [`create_template.go`](../packages/api/internal/template-manager/create_template.go) | `CreateTemplate` 方法,调用 gRPC `TemplateCreate` |
| [`template_status.go`](../packages/api/internal/template-manager/template_status.go) | `PollBuildStatus` 轮询 build 状态 |
| [`upload_template_layer_files.go`](../packages/api/internal/template-manager/upload_template_layer_files.go) | `InitLayerFileUpload`,获取 layer file 上传 URL |

#### 6.2.4 `packages/orchestrator/pkg/template/`

**职责**:orchestrator 端的 template 构建逻辑(template-manager gRPC 服务的服务端实现)。

**子目录**:

| 子目录 | 职责 |
|--------|------|
| `build/` | 核心构建逻辑(builder.go、phases/、commands/、layer/ 等) |
| `build/core/envd/` | **2026.30 新增**:`build-envd-version` 目标二进制的解析(`resolve.go`) |
| `build/phases/base/distro/` | **2026.30 新增**:distro 感知的 base image provisioning(见 §8.3) |
| `cache/` | `BuildCache`(短期 build 状态缓存,TTL 10 分钟) |
| `constants/` | 服务名常量 |
| `metadata/` | `metadata.json` 的数据结构 |
| `server/` | gRPC 服务端入口 |
| `template/` | template 删除函数 |

> ⛔ **2026.30 删除了 `build/utils/utils.go`**。该文件只有一个 `GetFileHash`,在 2026.29 就已经没有任何调用方(死代码)。

**关键文件**:

- [`build/builder.go`](../packages/orchestrator/pkg/template/build/builder.go) — `Builder.Build` 方法,完整 build 流程;phase 编排在 `runBuild` 的 [`builder.go:427-450`](../packages/orchestrator/pkg/template/build/builder.go)
- [`build/result.go`](../packages/orchestrator/pkg/template/build/result.go) — **2026.30 新增**:`ClassifyBuildResult`([:18](../packages/orchestrator/pkg/template/build/result.go))把 build 结果分成三类——`success`(无错且有 result)、`user_error`(错误链里有 `PhaseBuildError`,即用户命令/脚本/拉镜像失败或 build 级取消超时)、`internal_error`(其余)。这是**"到底是谁的错"唯一做判断的地方**;结果同时用作 `template_build_result_total` 的 `result` label 和 span 上的 `build.result` 属性(调用点 [`builder.go:151-152`](../packages/orchestrator/pkg/template/build/builder.go),span 属性 [`builder.go:163-165`](../packages/orchestrator/pkg/template/build/builder.go))
- [`server/main.go`](../packages/orchestrator/pkg/template/server/main.go) — `ServerStore` 初始化
- [`server/create_template.go`](../packages/orchestrator/pkg/template/server/create_template.go) — gRPC `TemplateCreate` 实现;2026.30 起用 `ServiceInfo.TrackWork()`([`create_template.go:43,177`](../packages/orchestrator/pkg/template/server/create_template.go))登记未完成工作

#### 6.2.5 `packages/orchestrator/pkg/sandbox/template/`

**职责**:沙盒启动时使用的 template 缓存层。

**关键文件**:

| 文件 | 作用 |
|------|------|
| [`cache.go`](../packages/orchestrator/pkg/sandbox/template/cache.go) | `Cache` 类型(TTL 25 小时),`GetTemplate` / `AddSnapshot` / `Invalidate` |
| [`template.go`](../packages/orchestrator/pkg/sandbox/template/template.go) | `Template` interface |
| [`storage_template.go`](../packages/orchestrator/pkg/sandbox/template/storage_template.go) | `storageTemplate` 实现,异步 fetch memfile/rootfs/snapfile/metadata |
| [`storage.go`](../packages/orchestrator/pkg/sandbox/template/storage.go) | `Storage` 类型,封装 memfile/rootfs 的块设备读 |
| [`storage_file.go`](../packages/orchestrator/pkg/sandbox/template/storage_file.go) | `storageFile`,用于 snapfile/metadata 这种整文件对象 |

#### 6.2.6 `packages/orchestrator/pkg/server/template_cache.go` — ⛔ 已于 2026.30 删除

> ⛔ **整个文件连同它实现的 RPC 一起在 2026.30 退役**。删除范围:
>
> - 文件 `packages/orchestrator/pkg/server/template_cache.go` 本身;
> - `orchestrator.proto` 里的 `rpc ListCachedBuilds(google.protobuf.Empty) returns (SandboxListCachedBuildsResponse)`(2026.29 在 [`orchestrator.proto:217`](../packages/orchestrator/orchestrator.proto))与消息 `CachedBuildInfo` / `SandboxListCachedBuildsResponse`(2026.29 在 `:200`、`:205`);
> - gRPC handler 与 dummyserver 中的对应实现。
>
> 2026.30 的 `service SandboxService`([`orchestrator.proto:258-264`](../packages/orchestrator/orchestrator.proto))只剩 6 个 RPC:`Create`、`Update`、`List`、`Delete`、`Pause`、`Checkpoint`。节点侧的"我缓存了什么"信息改由 `ServiceInfo.OutstandingWork()` 等带内信号承载(见 [node-module.md](./node-module.md))。
>
> **本文旧版本曾把 `ListCachedBuilds` 描述为"给调度器参考的节点缓存视图"。该职责从未真正被调度器消费**——调度只看 `cachedBuilds` 之外的信号。template cache 本身仍然存在,唯一实现是 [`pkg/sandbox/template/cache.go`](../packages/orchestrator/pkg/sandbox/template/cache.go)(见 §6.2.5、§12.3)。

#### 6.2.7 `packages/shared/pkg/grpc/template-manager/`

**职责**:template-manager gRPC 服务的 Go stub 代码(proto 自动生成)。

**关键文件**:
- [`template-manager.pb.go`](../packages/shared/pkg/grpc/template-manager/template-manager.pb.go) — proto 生成的 message 类型
- [`template-manager_grpc.pb.go`](../packages/shared/pkg/grpc/template-manager/template-manager_grpc.pb.go) — gRPC client/server stub

#### 6.2.8 `packages/shared/pkg/proxy/template/`

**职责**:**与 template 系统无关**。这是 HTTP 代理(client-proxy)的错误页面渲染。目录名 `template` 实际是 Go 标准库 `html/template` 的语义,不是 E2B template。

#### 6.2.9 `packages/api/internal/cache/templates/`

**职责**:API 端的 template 元信息 Redis 缓存层。

**四层缓存**(详见 [第十二节](#十二多层缓存体系)):

| 缓存 | 文件 | 用途 | TTL |
|------|------|------|-----|
| AliasCache | [`alias_cache.go`](../packages/api/internal/cache/templates/alias_cache.go) | `namespace/alias → {templateID, teamID}` | 5 min |
| TemplateCache | [`cache.go`](../packages/api/internal/cache/templates/cache.go) | `{templateID}:{tag} → TemplateInfo` | 5 min |
| TemplatesBuildCache | [`template_build.go`](../packages/api/internal/cache/templates/template_build.go) | `buildID → BuildInfo` | 5 min |
| TemplateMetadataCache | [`template_metadata_cache.go`](../packages/api/internal/cache/templates/template_metadata_cache.go) | `templateID → {Public, ClusterID}` | 5 min |

#### 6.2.10 `packages/api/internal/constants/templates.go`

**职责**:template 相关的资源限制常量。

```go
// packages/api/internal/constants/templates.go
const (
    MinTemplateCPU        = int64(1)
    MaxTemplateCPU        = int64(32)
    MinTemplateMemory     = int64(128)
    DefaultTemplateCPU    = int64(2)
    DefaultTemplateMemory = int64(1024)
)
```

---

## 七、Template 完整生命周期

### 7.1 生命周期总览

```
        ┌───────────┐
        │  Created  │  ← POST /v3/templates
        └─────┬─────┘
              │
              ▼
        ┌───────────┐
        │  Building │  ← template-manager gRPC 异步执行
        └─────┬─────┘
              │
    ┌─────────┼─────────┐
    │         │         │
    ▼         ▼         ▼
┌──────┐ ┌──────┐ ┌──────────┐
│Ready │ │Failed│ │Building..│
└──┬───┘ └──────┘ └──────────┘
   │
   │ 启动 Sandbox
   ▼
┌───────────┐
│  In Use   │  ← Sandbox 启动时拉取 template 文件
└─────┬─────┘
      │
      │ DELETE /templates/{id}
      ▼
┌───────────┐
│  Deleted  │  ← 软删除 (deleted_at)
└───────────┘
```

### 7.2 创建 Template 的完整流程

**入口**:`POST /v3/templates`

**Handler**:[`packages/api/internal/handlers/template_request_build_v3.go`](../packages/api/internal/handlers/template_request_build_v3.go)

**步骤**:

#### Step 1: 请求解析

解析 `TemplateBuildRequestV3` body,从 body 拿 name/alias/tags/cpu/memory 等。**2026.30 新增 `minFreeDiskMb`**(见 [`spec/openapi.yml:1531`](../spec/openapi.yml) → `MinFreeDiskMb` schema 在 [`:389-398`](../spec/openapi.yml)),它映射到 `RegisterBuildData.MinFreeDiskMb *int32`([`register_build.go:48`](../packages/api/internal/template/register_build.go))。

#### Step 2: Team 鉴权 + limit 检查

```go
team, limits := a.GetTeam(ctx, c, body.TeamID)
```

#### Step 3: 名字解析

```go
identifier, tag, err := id.ParseName(input)
// 校验 namespace 必须等于 team slug
err = id.ValidateNamespaceMatchesTeam(identifier, team.Slug)
// 合并请求 body 里的 tags 和 name 里的 tag
// 默认 tag 是 "default"
```

#### Step 4: Alias 解析

```go
templateID, err := templateCache.ResolveAliasWithMetadata(identifier, team.Slug)
```

三种结果:
- **已存在且属于本 team** → 复用 templateID,走"更新"路径
- **已存在但不属于本 team(或 public)** → team 可在自己的 namespace 下创建新 template
- **不存在** → 创建新 template

#### Step 5: DB 事务 + Build 注册

```go
err = template.RegisterBuild(ctx, a.templateCache, a.sqlcDB, buildReq)
```

`RegisterBuild` 的事务结构:并发检查在事务外,事务内 6 步原子操作(详见 [6.2.2](#622-packagesapiinternaltemplate))。

> ⚠️ **2026.30 起,`minFreeDiskMb` 的配额校验发生在并发检查和事务之前**([`register_build.go:91-113`](../packages/api/internal/template/register_build.go))。`team.LimitFreeDiskSize(team.Limits, minFreeDiskMb)`([`free_disk.go:16`](../packages/api/internal/team/free_disk.go))的规则:
>
> - `nil` → 用 team 的 `DefaultFreeDiskSizeMb`;
> - **显式 `0` 是合法值**,表示"不要额外增长",必须原样保留 0(所以任何地方都不能把 0 当"未设置");
> - 负数 → 400 `Minimum free disk can't be negative`;
> - 超过 `MaxFreeDiskSizeMb` → 400 `Minimum free disk can't be higher than %d MiB (if you need to increase this limit, please contact support)`。
>
> 解析结果写进 `env_builds.free_disk_size_mb`([`register_build.go:295`](../packages/api/internal/template/register_build.go) 的 `FreeDiskSizeMb: freeDiskSizeMB`),并打上 `build.free_disk.default_mb` / `max_mb` / `requested_mb` / `mb` 四个 span 属性。

#### Step 6: 缓存失效

```go
templateCache.InvalidateAlias(...)
```

#### Step 7: 返回响应

```go
return TemplateRequestResponseV3{
    templateID,
    buildID,
    aliases,
    names,
    tags,
    public,
}
```

### 7.3 删除 Template 的完整流程

**入口**:`DELETE /templates/{templateID}`

**Handler**:[`packages/api/internal/handlers/template_delete.go`](../packages/api/internal/handlers/template_delete.go)

**步骤**:

#### Step 1: 解析 template ID 或 alias

```go
templateID, err := id.ParseName(input)
```

#### Step 2: 解析 template 和 team

```go
template, team := a.resolveTemplate(ctx, templateID)
```

#### Step 3: 检查是否有运行中的 sandbox

```go
sandboxes := a.orchestrator.GetSandboxes(ctx, team.ID, [Running, Pausing, Snapshotting])
if len(sandboxes) > 0 {
    return 400 // 拒绝删除
}
```

#### Step 4: 检查是否有 snapshot 依赖

```go
exists := sqlcDB.ExistsTemplateSnapshots(templateID)
if exists {
    return 400 // 拒绝删除
}
```

#### Step 5: 软删除(DB 事务)

`softDeleteTemplate` 在一个 DB 事务里:

```sql
-- 1. 软删除 template
UPDATE envs SET deleted_at = NOW()
  WHERE id = @template_id AND team_id = @team_id AND deleted_at IS NULL;

-- 2. 释放别名(真删,让名字可复用)
DELETE FROM env_aliases WHERE env_id = @template_id;

-- 3. 清理并发追踪
DELETE FROM active_template_builds WHERE template_id = @template_id;
```

#### Step 6: 缓存失效

```go
templateCache.InvalidateAllTags(templateID)
templateCache.InvalidateAliasesByTemplateID(templateID, aliasKeys)
```

> **注意**:软删除只设置 `deleted_at`,行还在。`active_envs` 视图会过滤掉已删除的 env。GCS 上的 build 文件不会被自动清理,需要通过 `TemplateBuildDelete` RPC 单独清理。

---

## 八、Template Build 构建流程

### 8.1 Build 触发方式

Build 的触发有两种路径:

1. **v3 同步路径**:`POST /v3/templates` → `RegisterBuild`(DB)→ API 端继续调用 `template-manager.CreateTemplate`(gRPC)
2. **v1/v2 异步路径**(deprecated):handler 直接调用 `template-manager.CreateTemplate`

无论哪种路径,真正的 build 都在 template-manager gRPC 服务上异步执行。

### 8.2 Build 完整时序

```
[User SDK/CLI]
       │
       │ POST /v3/templates {name: "team-x/python:prod", fromImage: "..."}
       ▼
[API Server (packages/api)]
       │
       ├─ RegisterBuild (packages/api/internal/template/register_build.go)
       │    │
       │    ├─ [事务外] 并发检查 GetInProgressTemplateBuildsByTeam
       │    │    (排除当前 template + tags,近似实现,无锁)
       │    │
       │    ├─ [DB TX]
       │    │    ├─ CreateOrUpdateTemplate → envs (source='template')
       │    │    ├─ InvalidateUnstartedTemplateBuilds
       │    │    │    → 标记同 tag 下旧 pending build 为 failed
       │    │    ├─ CreateTemplateBuild → env_builds (status='waiting')
       │    │    ├─ 处理 alias (CheckConflicts → DeleteOld → Create)
       │    │    │    → env_aliases (namespace=team-slug)
       │    │    ├─ CreateTemplateBuildAssignment → env_build_assignments
       │    │    │    (每个 tag 一条记录,自动加 'default' tag)
       │    │    └─ CreateActiveTemplateBuild → active_template_builds
       │    │
       │    └─ [commit]
       │
       ├─ template-manager.CreateTemplate
       │    │  (packages/api/internal/template-manager/create_template.go)
       │    │
       │    ├─ GetClusterBuildClient(clusterID, nodeID)
       │    │    → 选择合适的 build node
       │    │
       │    └─ gRPC TemplateCreate(TemplateConfig)  ─────────┐
       │                                                      │
       │                                                      ▼
       │                              [template-manager gRPC (orchestrator)]
       │                                  packages/orchestrator/pkg/template/server
       │
       │                                  ├─ TemplateCreate (server/create_template.go)
       │                                  │    │
       │                                  │    ├─ buildCache.Create(teamID, buildID, logs)
       │                                  │    │    (登记 build 状态,供 TemplateBuildStatus 查询)
       │                                  │    │
       │                                  │    └─ go builder.Build(...)  ←────── 异步
       │                                  │
       │                                  └─ builder.Build (template/build/builder.go)
       │                                       │
       │                                       ├─ Phase: base
       │                                       │    ├─ 拉 Docker 镜像
       │                                       │    ├─ 注入 init/envd/systemd 文件
       │                                       │    ├─ 提取 ext4 rootfs
       │                                       │    ├─ FC VM 启动(BusyBox init)
       │                                       │    ├─ provisioning 脚本(装 systemd)
       │                                       │    └─ 上传 rootfs + header 到 GCS
       │                                       │
       │                                       ├─ Phase: user (v2+)
       │                                       │    └─ 创建默认用户
       │                                       │
       │                                       ├─ Phase: steps[] (用户的自定义 step)
       │                                       │    └─ 每个 step 一个 layer,缓存复用
       │                                       │
       │                                       ├─ Phase: resize-disk (flag 开启)
       │                                       │    └─ 离线保证 rootfs 目标空闲空间
       │                                       │
       │                                       ├─ Phase: finalize (postProcessing)
       │                                       │    ├─ 配置脚本(swap、user、permissions)
       │                                       │    └─ start cmd + ready cmd
       │                                       │
       │                                       ├─ Phase: optimize
       │                                       │    └─ 计算 prefetch mapping,优化启动
       │                                       │
       │                                       └─ Snapshot + 上传最终 layer 到 GCS
       │                                            (rootfs.ext4, memfile, snapfile, metadata.json)
       │
       ├─ SetStatus(buildID, "in_progress")  ← 立即更新 DB
       │
       └─ go BuildStatusSync(...)  ─────────── 周期同步 ──────┐
                                                                 │
                                                                 ▼
                                       [PollBuildStatus (template_status.go)]
                                            │
                                            ├─ 每 1s 轮询 TemplateBuildStatus gRPC
                                            │
                                            └─ 拿到 Completed:
                                                 ├─ SetFinished(buildID, rootfsSize,
                                                 │     envdVersion, kernelVersion, firecrackerVersion)
                                                 │    → SQL FinishTemplateBuild:
                                                 │      - DELETE FROM active_template_builds
                                                 │      - UPDATE env_builds SET status='uploaded',
                                                 │        kernel_version=..., firecracker_version=...
                                                 │
                                                 └─ templateCache.InvalidateAllTags(templateID)
                                                      (让后续请求看到新的 ready build)
```

### 8.3 Build Phases 详解

Builder.Build 的工作流(见 [`builder.go`](../packages/orchestrator/pkg/template/build/builder.go) 注释):

```
1. 拉取 Docker 镜像
2. 注入 init/hostname/dns/envd 配置文件层
3. 提取 ext4 文件系统
4. 用 BusyBox 启动 FC VM,跑 provisioning 脚本(装 systemd)
5. 用 systemd 重启 FC VM,等 envd ready
6. 跑 template 的 steps/layers
7. 可选离线扩容 rootfs,保证 `DiskSizeMB` 指定的目标空闲空间
8. 跑配置脚本 + start cmd + ready cmd
9. 快照(snapshot)
10. 上传 template(以及未上传的 layers)到远端存储
```

**Phases 编排**(见 `builder.go` 的 `runBuild`,2026.30 在 [`builder.go:427-450`](../packages/orchestrator/pkg/template/build/builder.go)):

| Phase | 说明 | 输出 |
|-------|------|------|
| `base` | 基础镜像处理 + 装 systemd + envd(**2026.30 起 distro 感知**,见 §8.3.1) | rootfs layer |
| `user` | 创建默认用户(v2+) | user layer |
| `steps[]` | 用户的自定义 step(每个 step 一个 layer) | step layers |
| `resize-disk` | flag 开启时在 user steps 后离线扩容 ext4 rootfs,使其接近 **`FreeDiskSizeMB`** 指定的目标空闲 MiB | filesystem-only resize layer(可能是 empty diff) |
| `finalize` (postProcessing) | 配置脚本(swap、user、permissions)+ start cmd + ready cmd | finalize layer |
| `optimize` | 计算 prefetch mapping,优化启动 | optimize layer + 最终 snapshot |

每个 phase 都是独立的 builder,跑完把自己的 layer 上传到配置的远端存储。Layer 是内容寻址的(content-addressed),所以相同的 step 不会重复构建。

`resize-disk` 受 `build-ensure-free-disk-space`([`flags.go:385`](../packages/shared/pkg/featureflags/flags.go);2026.29 在 :237)控制,顺序固定为 `base → user → steps → resize-disk → finalize → optimize`。它把静止的 COW rootfs 通过 NBD 暴露,回放 ext4 journal 并按 block group 统计空闲块;不足时依次执行 `e2fsck → resize2fs → e2fsck`,最后只导出变化 block。无需扩容时仍产出可缓存的 empty-diff artifact。该 layer 标为 filesystem-only,因此后续 `finalize` 会 cold boot。缓存 hash 包含 source hash、`resize-disk` 和磁盘目标([`ensurefreedisk/builder.go:80`](../packages/orchestrator/pkg/template/build/phases/ensurefreedisk/builder.go)),扩容及 `e2fsck` 也有独立 trace span。

构建 step 的目录 `COPY` 遵循 Docker 合并语义:复制到已存在目录时合并内容并覆盖同名文件,保留目标目录及已存在子目录的 metadata。实现使用 tar pipe,并通过 `--keep-directory-symlink` 正确处理 usrmerge 一类的目标目录 symlink;文件和 symlink source 仍移动到精确目标路径。

#### 8.3.1 `DiskSizeMB` 与 `FreeDiskSizeMB` 的分工(2026.30 变动)

> ⚠️ **2026.30 把"build 期目标空闲空间"从 `diskSizeMB` 里拆了出来**。旧文档说"`DiskSizeMB` 不是最终磁盘总大小,而是目标空闲空间"——这在 2026.29 是对的,但 2026.30 起这句话只描述 `FreeDiskSizeMB`。

| 字段 | proto | 归属 | 含义 |
|------|-------|------|------|
| `diskSizeMB` | [`template-manager.proto:68`](../packages/orchestrator/template-manager.proto) | `config.Config.DiskSizeMB`([`config/config.go:41`](../packages/orchestrator/pkg/template/build/config/config.go)) | **base phase** 的扩容目标(仍在用,[`core/rootfs/rootfs.go:197`](../packages/orchestrator/pkg/template/build/core/rootfs/rootfs.go)、[`phases/base/provision.go:227`](../packages/orchestrator/pkg/template/build/phases/base/provision.go)) |
| `freeDiskSizeMB` | [`template-manager.proto:93`](../packages/orchestrator/template-manager.proto) | `config.Config.FreeDiskSizeMB`([`config/config.go:45`](../packages/orchestrator/pkg/template/build/config/config.go)) | **`resize-disk` phase** 的目标空闲空间([`ensurefreedisk/builder.go:163`](../packages/orchestrator/pkg/template/build/phases/ensurefreedisk/builder.go)) |

proto 里 `freeDiskSizeMB` 是 `optional int32 = 17`,注释写明:**滚动升级期间可以缺席;缺席时 template-manager 退回用 `diskSizeMB` 当 post-build 空闲空间目标**([`template-manager.proto:91-92`](../packages/orchestrator/template-manager.proto))。回退逻辑在 [`server/create_template.go:248-253`](../packages/orchestrator/pkg/template/server/create_template.go) 的 `resolveFreeDiskSizeMB`:

```go
func resolveFreeDiskSizeMB(cfg *templatemanager.TemplateConfig) int64 {
    if cfg.FreeDiskSizeMB != nil {
        return int64(cfg.GetFreeDiskSizeMB())
    }
    return int64(cfg.GetDiskSizeMB())
}
```

> ⚠️ 注意 `freeDiskSizeMB` 用 `optional`,所以 **`0` 是一个合法且有意义的值**(显式要求"不扩" ),与"未设置"可区分。`resolveFreeDiskSizeMB` 的单元测试 [`server/template_status_test.go:27-34`](../packages/orchestrator/pkg/template/server/template_status_test.go) 专门覆盖了这一点:传 `&zero` 得到 `0`,传 `nil` 得到 `diskSizeMB`。

#### 8.3.2 distro 感知的 base image provisioning(2026.30 新增)

2026.29 之前 base phase 假定 base image 是 Debian/Ubuntu 系(用 `apt-get` 装包、用 systemd 做 init)。2026.30 引入 [`build/phases/base/distro/`](../packages/orchestrator/pkg/template/build/phases/base/distro/),把"这是哪个发行版"变成 provisioning 的第一步:

- [`distro.go`](../packages/orchestrator/pkg/template/build/phases/base/distro/distro.go) 定义 `Profile`(`:33`)与 `Profiles`(`:49`),覆盖 debian / rhel / arch / alpine / nixos;`Version = "1"`(`:18`),`Fingerprint()`(`:22`)把整个 profile 表折成一个 hash key,**profile 表一改所有 base layer 的缓存自动失效**。
- 选择逻辑由 `ShellSelector()`([`:202`](../packages/orchestrator/pkg/template/build/phases/base/distro/distro.go))生成的 shell 片段执行:读 `/etc/os-release` 的 `ID`;未知 id 再逐个试 `ID_LIKE` 的 token。
- **`RejectedIDs = []string{"rhel", "ol", "amzn"}`**([`:193`](../packages/orchestrator/pkg/template/build/phases/base/distro/distro.go)):这些 id 的 `ID_LIKE` 指向 fedora,但内核/工具链差异使它们不能按 fedora 处理,所以**显式拒绝而不是被 ID_LIKE 兜住**。`SupportedIDs()`([`:180`](../packages/orchestrator/pkg/template/build/phases/base/distro/distro.go))是官方支持列表。
- 通过 `ID_LIKE` 猜中时**只发 warning 不算成功**([`:264`](../packages/orchestrator/pkg/template/build/phases/base/distro/distro.go)):`[provision] WARNING: base image distribution ID='...' is not officially supported; provisioning it as '...' from ID_LIKE. This is best effort and untested.`;既不在 `RejectedIDs` 也不匹配任何 profile、或镜像没有 `/etc/os-release`,**直接 exit 1**。
- 结果写进 `/usr/local/share/e2b/distro.env`([`provision.sh:44`](../packages/orchestrator/pkg/template/build/phases/base/provision.sh))。
- 选择器接到 build 流程:[`phases/base/files.go:52`](../packages/orchestrator/pkg/template/build/phases/base/files.go) 的 `DistroSelector: distro.ShellSelector()`;并进入 base layer 的缓存 hash([`phases/base/hash.go:45`](../packages/orchestrator/pkg/template/build/phases/base/hash.go))。

**init system 也 distro 化**([`distro/init.go`](../packages/orchestrator/pkg/template/build/phases/base/distro/init.go)):`InitSystem` 有 `systemd` / `openrc` / `nixos` 三个值([`:13-17`](../packages/orchestrator/pkg/template/build/phases/base/distro/init.go)),`initSetup` map([`:23`](../packages/orchestrator/pkg/template/build/phases/base/distro/init.go))给出每个 init system 对应的 provisioning 片段——Alpine 走 busybox init → OpenRC,用烘进去的 `/etc/init.d/envd`;NixOS 用**预制 base image**(见 [`distro/nixos-base-image/`](../packages/orchestrator/pkg/template/build/phases/base/distro/nixos-base-image/):`README.md`、`build.sh`、`configuration.nix`),provisioning 只负责摘掉烘进去的 systemd drop-in,因为它是声明式配置的。

#### 8.3.3 envd 内存保护(2026.30 新增)

`build-envd-memory-protection`([`flags.go:493`](../packages/shared/pkg/featureflags/flags.go),默认 false)开启后,base phase 会往 rootfs 写一个 systemd drop-in,给 `system.slice` 里的 envd 申请内存下限,避免客户 workload 把 envd 挤到 OOM:

- 模板文件 [`core/rootfs/files/system.slice.d-envd.conf.tpl`](../packages/orchestrator/pkg/template/build/core/rootfs/files/system.slice.d-envd.conf.tpl) 渲染出 `/etc/systemd/system/system.slice.d/10-e2b-envd.conf`,内容 `[Slice] MemoryMin={{ .EnvdMemoryMinMiB }}M` / `MemoryLow={{ .EnvdMemoryLowMiB }}M`,整段被 `{{- if .EnvdMemoryProtection -}}` 包住。
- 两个阈值是常量([`core/rootfs/templates.go:78-79`](../packages/orchestrator/pkg/template/build/core/rootfs/templates.go)):`EnvdMemoryMinMiB = 128`、`EnvdMemoryLowMiB = 256`;渲染开关见 [`templates.go:82-83`](../packages/orchestrator/pkg/template/build/core/rootfs/templates.go),数据来源是 `BuildContext.EnvdMemoryProtection`([`buildcontext/context.go:31-34`](../packages/orchestrator/pkg/template/build/buildcontext/context.go))。
- **它也进 base layer 的缓存 hash**([`phases/base/hash.go:96,147-148`](../packages/orchestrator/pkg/template/build/phases/base/hash.go)):hash key 里带上 `EnvdMemoryMinMiB:EnvdMemoryLowMiB`,所以调阈值会正确触发 base layer 重建,而不是复用旧 layer。

> ⚠️ **cgroup v2 的保护是自顶向下授予的**。envd 自己 cgroup 的 `memory.min` 再大,只要它上层某一级的 `memory.min` 是 0,保护就不会落地。运行期由 envd 通过 `X-Envd-Memory` 头上报 `EnvdMemoryProtection{Request, Low, Floor, Partial}`([`pkg/sandbox/envd_memory.go:21,32-46`](../packages/orchestrator/pkg/sandbox/envd_memory.go)),orchestrator 据此把 sandbox 分成 `protected` / `unprotected` / `unknown` 三个 cohort([`envd_memory.go:58-65,77-81`](../packages/orchestrator/pkg/sandbox/envd_memory.go)):**`Floor > 0` 判 protected(优先于 `Partial`),`Partial` 判 unknown,其余判 unprotected**。用三值而不是布尔,是为了不让"读不到"被误算成"没有保护"。详见 [snapshots.md](./snapshots.md) 与 [sandbox-lifecycle.md](./sandbox-lifecycle.md)。

#### 8.3.4 guest kernel cmdline 按 team 注入(2026.30 新增)

`build-kernel-cmdline-args`([`flags.go:777`](../packages/shared/pkg/featureflags/flags.go),默认空)让某个 team 的 template build 在内核命令行上追加一段参数,形如 `psi=1` 或 `psi=1 nokaslr`([`flags.go:759-776`](../packages/shared/pkg/featureflags/flags.go))。**没被 flag 命中的 team 命令行逐字节不变**;加参数是一次 flag 编辑,不需要改 orchestrator、也不需要部署。

解析与校验在 [`pkg/sandbox/fc/kernel_args.go`](../packages/orchestrator/pkg/sandbox/fc/kernel_args.go):

- `type KernelArgs map[string]string`([`:12`](../packages/orchestrator/pkg/sandbox/fc/kernel_args.go))。
- `ParseCmdlineArgs`([`:46`](../packages/orchestrator/pkg/sandbox/fc/kernel_args.go))**按内核的方式解析**:空白分隔参数、第一个 `=` 分隔 name 与 value、没有 `=` 的参数 value 为空。
- `ValidateCmdlineArgs`([`:71`](../packages/orchestrator/pkg/sandbox/fc/kernel_args.go))对照 `reservedCmdlineParams`([`:24-35`](../packages/orchestrator/pkg/sandbox/fc/kernel_args.go))——`init`、`clocksource`、`root`、`ip`、`console`、`rootflags`、`panic`、`reboot`、`loglevel`、`quiet`——**只要碰了保留参数,整段 fragment 被拒绝并退回默认命令行,而不是让 build 失败**。
- 最终命令行由 `buildKernelArgs`([`:84`](../packages/orchestrator/pkg/sandbox/fc/kernel_args.go))组装,**overlay 最后应用并再次校验**([`:129-132`](../packages/orchestrator/pkg/sandbox/fc/kernel_args.go))。

> ⚠️ 解析后的参数会记进 template 的 metadata,**filesystem-only 快照冷启动时会重放**。所以快照永远按它被构建时的命令行启动,即使这个 flag 之后改了。

#### 8.3.5 ext4 htree dir_index(2026.30 新增)

`build-ext4-dir-index`([`flags.go:390`](../packages/shared/pkg/featureflags/flags.go),默认 false)接线在 [`core/rootfs/rootfs.go:169`](../packages/orchestrator/pkg/template/build/core/rootfs/rootfs.go) 的 `DirIndex: r.featureFlags.BoolFlag(ctx, featureflags.BuildExt4DirIndex)`,最终落到 [`core/filesystem/ext4.go:52-53,81`](../packages/orchestrator/pkg/template/build/core/filesystem/ext4.go) 的 `MakeOptions.DirIndex`。

> ⚠️ **语义是反的,别按直觉读**:`mkfs.ext4` **默认就会**建 htree 目录索引,这个 flag 是"**保留**它"。所以 **flag 为 false(默认)时会主动把 htree 索引剥掉**([`ext4.go:81`](../packages/orchestrator/pkg/template/build/core/filesystem/ext4.go) 的 `if !opts.DirIndex`),true 才是维持 mkfs 的原有行为。

> ⚠️ 它在 **mkfs 时读取**,只影响翻转之后新建的 rootfs 镜像;已经建好的镜像不会变。特性一旦烘进文件系统也不能在运行期关掉。两侧行为由 [`core/filesystem/ext4_test.go:22-31`](../packages/orchestrator/pkg/template/build/core/filesystem/ext4_test.go) 的 `TestMakeDirIndex` 钉住。

### 8.4 Build 状态同步

**入口**:[`packages/api/internal/template-manager/template_status.go`](../packages/api/internal/template-manager/template_status.go)

**`BuildStatusSync`**:

- 调用 template-manager gRPC 的 `TemplateBuildStatus`
- 用 `PollBuildStatus` 每 1 秒轮询,最长 1 小时(`buildTimeout`)
- 如果 build 处于 `pending` 超过 40 分钟(`syncWaitingStateDeadline`)则自动失败

**状态分发**:

| gRPC 返回状态 | DB 更新 |
|---------------|---------|
| `Failed` | `SetStatus(ctx, buildID, Failed, reason)` |
| `Completed` | `SetFinished(...)` — 更新 total_disk_size_mb、envd/kernel/firecracker 版本 |

**`SetFinished` SQL**(见 [`finish_template_build.sql`](../packages/db/queries/builds/finish_template_build.sql)):

```sql
-- name: FinishTemplateBuild :exec
-- 用 CTE 同时做 2 件事:
-- 1. 删除 active_template_builds 行(并发限制释放)
-- 2. 更新 env_builds 状态
WITH deactivated AS (
    DELETE FROM public.active_template_builds WHERE build_id = @build_id
)
UPDATE "public"."env_builds"
SET
    finished_at = NOW(),
    total_disk_size_mb = @total_disk_size_mb,
    status = @status,
    envd_version = @envd_version,
    -- NULLIF + COALESCE 保护:模板管理器不回填时保留原值
    kernel_version = COALESCE(NULLIF(@kernel_version::text, ''), kernel_version),
    firecracker_version = COALESCE(NULLIF(@firecracker_version::text, ''), firecracker_version)
WHERE id = @build_id;
```

> 注意 `status` 是参数化传入(由调用方决定 `'uploaded'`/`'ready'` 等),不是硬编码;旧模板管理器不回填 kernel/firecracker 版本时,通过 `NULLIF + COALESCE` 保留原值不被清空。

---

## 九、Sandbox 启动如何使用 Template

### 9.1 Sandbox 创建入口

**orchestrator gRPC `Sandbox.Create`**:

文件:[`packages/orchestrator/pkg/server/sandboxes.go`](../packages/orchestrator/pkg/server/sandboxes.go)

### 9.2 Sandbox 启动流程

#### Step 1: 获取 Template

```go
// packages/orchestrator/pkg/server/sandboxes.go:164
template, err := s.templateCache.GetTemplate(
    ctx,
    req.GetSandbox().GetBuildId(),       // buildID 是关键
    req.GetSandbox().GetSnapshot(),
    false,
    sbxtemplate.GetTemplateOpts{
        MaxSandboxLengthHours: req.GetSandbox().GetMaxSandboxLength(),
    },
)
```

#### Step 2: 读取 metadata

```go
meta, err := template.Metadata()
// 判断是 filesystem-only snapshot 还是 memory snapshot
```

#### Step 3: 启动沙盒

```go
if meta.FilesystemOnly {
    // filesystem-only snapshot → 冷启动
    sandbox, err := s.sandboxFactory.RebootSandbox(...)
} else {
    // 否则 → 从内存快照恢复
    sandbox, err := s.sandboxFactory.ResumeSandbox(...)
}
```

**两种启动方式**:

| 方式 | 适用场景 | 原理 |
|------|----------|------|
| `RebootSandbox` | filesystem-only snapshot / 普通 template | 冷启动,加载 rootfs,运行 init |
| `ResumeSandbox` | memory snapshot | 热恢复,加载 memfile + snapfile,恢复到暂停前状态 |

### 9.3 templateCache 内部

文件:[`packages/orchestrator/pkg/sandbox/template/cache.go`](../packages/orchestrator/pkg/sandbox/template/cache.go)

**`GetTemplate` 流程**:

1. 用 `buildID` 作为 cache key 查本地缓存
2. **cache hit** → 直接返回(后台异步刷新文件)
3. **cache miss** →
   - 决定 storage backend(GCS 直读 / NFS cache / peer-to-peer)
   - `newTemplateFromStorage(...)` 创建 `storageTemplate`
   - 启动后台 goroutine `tmpl.Fetch(...)` 异步拉文件

### 9.4 Fetch 过程

文件:[`storage_template.go`](../packages/orchestrator/pkg/sandbox/template/storage_template.go)

**并发拉取 4 类文件**:

```
┌─────────────────────────────────────────────────┐
│                Fetch (并发)                      │
├─────────────┬─────────────┬──────────┬──────────┤
│  snapfile   │  metadata   │ memfile  │ rootfs   │
│  (整文件)   │  (JSON)     │ (block)  │ (block)  │
└─────────────┴─────────────┴──────────┴──────────┘
                                    │
                                    ▼
                            ┌──────────────────┐
                            │  Storage         │
                            │  (块设备读)      │
                            │                  │
                            │ memfile: 2MiB    │
                            │ rootfs:  4KiB    │
                            └──────────────────┘
```

**关键细节**:

- 每个 memfile/rootfs 都通过 `NewStorage` 建立 block-level 随机读接口
- 支持"老式无 header"的 fallback(memfile blocksize = 2MiB,rootfs = 4KiB)
- 支持压缩格式(.zstd / .lz4)

### 9.5 Firecracker VM 启动

在 `sandbox.Factory.ResumeSandbox` / `RebootSandbox` 中:

- 把 **memfile** 作为 VM 内存
- 把 **rootfs** 作为根文件系统
- 把 **snapfile** 作为 CPU 状态
- 启动 FC VM,等待 envd 就绪

### 9.6 Sandbox 请求关键参数

`SandboxCreateRequest` 里的关键字段:

| 字段 | 用途 |
|------|------|
| `buildId` | 直接指定用哪个 build(关键) |
| `templateId` | 仅用于元信息(日志、metrics) |
| `snapshot` | 是否从快照恢复 |
| `kernelVersion` | 决定 VM 配置 |
| `firecrackerVersion` | 决定 VM 配置 |
| `envdVersion` | 决定 in-VM daemon 版本 |
| `vcpu` / `ramMb` / `totalDiskSizeMb` | 资源规格 |
| `hugePages` | 是否启用大页(由 firecracker 版本决定) |
| `baseTemplateId` | 基础 template(for snapshot resume) |
| `network` | 网络配置(egress、ingress、BYOP) |
| `volumeMounts` | 持久卷挂载 |

---

## 十、Alias 别名解析机制

### 10.1 完整解析链

用户请求 `my-team/python-env:prod`:

```
1. handler 调用 id.ParseName("my-team/python-env:prod")
   → identifier = "my-team/python-env"
   → tag = "prod"

2. handler 调用 templateCache.ResolveAliasWithMetadata(identifier, team.Slug)
   → 内部调 AliasCache.Resolve(identifier, team.Slug)

3. AliasCache.Resolve 逻辑:
   ├─ 显式 namespace("my-team")?
   │   └─ YES → 直接按 (alias=python-env, namespace=my-team) 查 DB
   │           无 fallback
   │
   └─ 裸 alias?
       ├─ 先按 team namespace 查 (alias=python-env, namespace=team-slug)
       ├─ 失败再按 NULL namespace 查 (promoted/public template)
       └─ 仍失败 → 尝试按 template ID 直接查

4. 拿到 templateID

5. handler 调用 templateCache.Get(ctx, templateID, tag, teamID, clusterID)
   → 内部构造 cache key "{templateID}:prod"
   → cache miss → 执行 SQL GetTemplateWithBuildByTag

6. SQL 查询(见 packages/db/queries/templates/get_template_with_build_by_tag.sql):
   SELECT ... FROM active_envs e
   JOIN env_build_assignments eba ON eba.env_id = e.id
     AND (eba.tag = COALESCE(@tag, 'default') OR eba.build_id = try_cast_uuid(@tag))
   JOIN env_builds eb ON eb.id = eba.build_id AND eb.status_group = 'ready'
   WHERE e.id = @template_id
     AND e.source IN ('template', 'snapshot_template')
   ORDER BY eba.created_at DESC LIMIT 1

7. 返回 (template, build)
   → 调用方用 build.ID 启动 sandbox 或做后续操作
```

### 10.2 Alias 解析的三种结果

| 场景 | 行为 |
|------|------|
| 显式 namespace | 直接按 namespace 查找,**无 fallback** |
| 裸 alias,team namespace 有 | 按 team namespace 查找 |
| 裸 alias,team namespace 没有 | fallback 到 NULL namespace(public template) |
| 仍找不到 | fallback 到按 template ID 直接查找 |

### 10.3 Tag 的双重含义(巧妙设计)

注意 SQL 中的这一行:

```sql
AND (eba.tag = COALESCE(@tag, 'default') OR eba.build_id = try_cast_uuid(@tag))
```

这意味着 `tag` 参数也可以是 build_id(UUID),通过 `try_cast_uuid` 兼容。所以用户可以用:

- `my-team/python-env:prod` → 按 tag `prod` 查
- `my-team/python-env:<build-uuid>` → 直接按 build_id 查

### 10.4 Alias Cache 失效

| 场景 | 失效操作 |
|------|----------|
| alias 创建/删除 | `AliasCache.Invalidate(alias, namespace)` |
| template 删除 | `AliasCache.InvalidateAliasesByTemplateID(templateID, aliasKeys)` |

---

## 十一、存储结构

### 11.1 Template 存储配置

首选 `TEMPLATE_STORAGE_URL`,它对 template storage 角色是权威配置,可独立于 build cache 选择 provider 和 destination:

- `gs://bucket`
- `s3://bucket?endpoint=http://host:port&s3ForcePathStyle=true&region=us-east-1`
- `file:///absolute/path`
- `file:relative/path`

bucket URL 只允许 bucket,不支持 key prefix;未知 query 参数直接报错。URL 不接收 credentials:GCS 使用 ADC/Workload Identity,S3 使用 AWS 环境凭据。未设置 URL 时仍兼容 `STORAGE_PROVIDER`、`TEMPLATE_BUCKET_NAME`、`LOCAL_TEMPLATE_STORAGE_BASE_PATH` 和 `S3_USE_PATH_STYLE`,并将旧配置转换为同一个 URL 解析流程。

- GCP 生产:`{bucket_prefix}fc-templates`(见 `iac/provider-gcp/init/buckets.tf`)
- 本地开发:用 `LOCAL_TEMPLATE_STORAGE_BASE_PATH`

> ⛔ **`iac/**` 整个目录已在 2026.30 删除**(提交 `8a1c4888`,"retire Nomad-based deployment ahead of a new deploy path"):2026.29 有 172 个文件,2026.30 为 0。同批删除的还有根目录 `self-host.md`,以及根 `Makefile` 里的全部 Terraform/Nomad 目标。⚠️ **但 `packages/docker-reverse-proxy/`(19 → 0 个文件)不属于这一批**——它由更早的独立提交 `d153bbe9d`(Jakub Rojko, 2026-08-06, `chore(docker-reverse-proxy): remove deprecated service`)删除,与 `iac/` 退役相差一个月。**注意 `packages/nomad-nodepool-apm/` 仍然存在**(2026.29 的 10 个文件在 2026.30 变成 12 个),不要跟着一起写死。本文凡是引用 `iac/**` 的地方都只是**历史档案**,链接已不可点。

### 11.2 目录结构

```
gs://fc-templates/
  └── {buildID}/                            ← 每个 build 一个目录
      ├── memfile                           ← VM 内存镜像(block device)
      ├── memfile.header                    ← memfile 的 block header sidecar
      ├── memfile.zstd                      ← (可选)zstd 压缩版本
      ├── memfile.lz4                       ← (可选)lz4 压缩版本
      ├── rootfs.ext4                       ← ext4 根文件系统(block device)
      ├── rootfs.ext4.header                ← rootfs 的 block header sidecar
      ├── snapfile                          ← VM CPU/设备状态序列化(整文件)
      ├── metadata.json                     ← template metadata(JSON)
      └── (layer files during build)        ← build 过程中的中间 layer
```

### 11.3 路径构造

定义在 [`packages/shared/pkg/storage/paths.go`](../packages/shared/pkg/storage/paths.go):

```go
// 文件名常量
const (
    MemfileName  = "memfile"
    RootfsName   = "rootfs.ext4"
    SnapfileName = "snapfile"
    MetadataName = "metadata.json"
    HeaderSuffix = ".header"
)

// Paths 类型
type Paths struct {
    BuildID string
}

func (p Paths) Memfile() string          { return fmt.Sprintf("%s/%s", p.BuildID, MemfileName) }
func (p Paths) MemfileHeader() string    { return p.HeaderFile(MemfileName) }
func (p Paths) Rootfs() string           { return fmt.Sprintf("%s/%s", p.BuildID, RootfsName) }
func (p Paths) RootfsHeader() string     { return p.HeaderFile(RootfsName) }
func (p Paths) Snapfile() string         { return fmt.Sprintf("%s/%s", p.BuildID, SnapfileName) }
func (p Paths) Metadata() string         { return fmt.Sprintf("%s/%s", p.BuildID, MetadataName) }
```

### 11.4 文件类型说明

| 文件 | 类型 | 块大小 | 用途 |
|------|------|--------|------|
| `memfile` | block device | 通常 2MiB(hugepage) | VM 内存镜像 |
| `rootfs.ext4` | block device | 4KiB | ext4 根文件系统 |
| `snapfile` | 整文件 | — | VM CPU/设备状态序列化 |
| `metadata.json` | JSON | — | template 元信息 |
| `*.header` | sidecar | — | block header(块大小、build ID、size) |

### 11.5 metadata.json 结构

定义在 [`packages/orchestrator/pkg/template/metadata/template_metadata.go`](../packages/orchestrator/pkg/template/metadata/template_metadata.go):

```json
{
  "version": 2,
  "template": {
    "build_id": "...",
    "kernel_version": "vmlinux-6.1.158",
    "firecracker_version": "v1.14.1_431f1fc"
  },
  "context": {
    "user": "root",
    "workdir": "/code",
    "env_vars": {"PATH": "..."}
  },
  "start": {
    "start_command": "...",
    "ready_command": "...",
    "context": {...}
  },
  "from_image": "ubuntu:22.04",
  "from_template": {"alias": "...", "build_id": "..."},
  "prefetch": {
    "memory": {
      "indices": [...],
      "access_types": [...],
      "block_size": 2097152
    }
  },
  "filesystem_only": false
}
```

### 11.6 压缩支持

代码中的压缩相关函数(见 `paths.go`):

```go
var knownCompressionSuffixes = []string{
    CompressionLZ4.Suffix(),   // ".lz4"
    CompressionZstd.Suffix(),  // ".zstd"
}

// StripCompression: "memfile.zstd" → "memfile"
// compressionType:  "memfile.zstd" → CompressionZstd
```

**压缩路径**:

- `MemfileCompressed(ct)` = `{buildID}/memfile{suffix}`
- `RootfsCompressed(ct)` = `{buildID}/rootfs.ext4{suffix}`

---

## 十二、多层缓存体系

### 12.1 缓存层总览

E2B template 系统有 **多层缓存**,分布在 API 和 orchestrator:

| 缓存层 | 位置 | 类型 | TTL | 用途 |
|--------|------|------|-----|------|
| **AliasCache** | API(Redis) | `namespace/alias → {templateID, teamID}` | 5 min | 加速 alias 解析 |
| **TemplateCache** | API(Redis) | `{templateID}:{tag} → Template+Build` | 5 min | 加速 template+build 查询 |
| **TemplatesBuildCache** | API(Redis) | `buildID → BuildInfo` | 5 min | 加速 build 状态查询 |
| **TemplateMetadataCache** | API(Redis) | `templateID → {Public, ClusterID}` | 5 min | 加速 metadata 查询 |
| **sbxtemplate.Cache** | Orchestrator(内存) | `buildID → Template(文件)` | 25 hours | 避免重复从 GCS 拉 |
| **BuildCache** | template-manager(内存) | `buildID → BuildInfo(状态)` | 10 min | 跟踪进行中的 build |
| **Build DiffStore** | Orchestrator(磁盘) | `chunk key → diff` | 25 hours | 避免重复拉相同 chunk |

### 12.2 API 端 Redis 缓存

#### 12.2.1 AliasCache

**文件**:[`packages/api/internal/cache/templates/alias_cache.go`](../packages/api/internal/cache/templates/alias_cache.go)

**Resolve 方法**(见第 71-97 行,真实签名):

```go
func (c *AliasCache) Resolve(
    ctx context.Context,
    identifier string,
    namespaceFallback string,
) (*AliasInfo, error) {
    namespace, alias := id.SplitIdentifier(identifier)

    if namespace != nil {
        // 显式 namespace → 直接按 namespace 查找,无 fallback
        return c.lookup(ctx, namespace, alias)
    }

    // 裸 alias → 先按 team namespace(namespaceFallback)查
    info, err := c.lookup(ctx, &namespaceFallback, alias)
    if err == nil {
        return info, nil
    }

    // 失败 fallback 到 NULL namespace(promoted/public template)
    if errors.Is(err, ErrTemplateNotFound) {
        return c.lookup(ctx, nil, alias)
    }

    return nil, err
}
```

**template ID fallback** 不在 `Resolve` 里,而在 `fetchFromDB`(行 134-185)里:当 alias 查询失败且 namespace 为 nil(裸 alias)时,会尝试用 alias 当作 template ID 直接查 `GetTemplateById`。所以 [10.1 节](#101-完整解析链)说的"仍失败 → 尝试按 template ID 直接查"发生在 `fetchFromDB` 层。

**缓存策略**:
- 正向命中和负向命中(tombstone)都缓存,避免重复 DB 查询
- 同时按 template ID 建一份缓存(`cacheByTemplateID`),供 `LookupByID` 使用

#### 12.2.2 TemplateCache

**文件**:[`packages/api/internal/cache/templates/cache.go`](../packages/api/internal/cache/templates/cache.go)

**Cache Key 设计**:

```
key = "{templateID}:{tag}"
```

`{}` 是 Redis Cluster 的 hash tag,保证同一 template 的所有 key 落在同一 slot,从而支持 `DeleteByPrefix` 的原子批量删除(`InvalidateAllTags`)。

#### 12.2.3 缓存刷新策略

所有 API 缓存都使用 `cache.RedisCache[T]`(在 [`packages/shared/pkg/cache`](../packages/shared/pkg/cache)):

- TTL = 5 分钟
- refresh interval = 1 分钟(后台刷新)
- 支持 TTL + 后台 refresh,避免缓存雪崩

### 12.3 Orchestrator 端 sbxtemplate.Cache

**文件**:[`packages/orchestrator/pkg/sandbox/template/cache.go`](../packages/orchestrator/pkg/sandbox/template/cache.go)

**策略**:

- 用 `jellydator/ttlcache/v3`
- TTL = `templateExpiration = 25 小时`(必须大于沙盒最大生命周期)
- 缓存 key 是 `buildID`
- eviction 回调:关闭 template 的所有 fd,清理 peerclient

### 12.4 NFS Cache 加速(可选)

由 feature flag 控制:

- `TemplateFeatureFlag` / `SnapshotFeatureFlag` 开启时,template 文件先经过本地 NFS cache
- `storage.WrapInNFSCache` 包装 StorageProvider
- 压缩 frame 的写入并发受 `max-cache-writer-concurrency` 限制(2026.30 起,[`flags.go:472`](../packages/shared/pkg/featureflags/flags.go),`MaxCacheWriterConcurrencyFlag = NewIntFlag("max-cache-writer-concurrency", 10)`;2026.29 在 :298)。默认 10 个并发 writer。

### 12.5 Build Diff Store

**作用**:缓存 memfile/rootfs 的"diff chunks",避免重复拉取相同块。

- TTL = 25 小时
- eviction 延迟 = 60 秒
- 文件:[`packages/orchestrator/pkg/sandbox/build/cache.go`](../packages/orchestrator/pkg/sandbox/build/cache.go)(`DiffStore` struct 定义在 L42)

**2026.30 新增:延迟 seal 的 rootfs/memfile diff**([`build/deferred_diff.go`](../packages/orchestrator/pkg/sandbox/build/deferred_diff.go))。`NewDeferredDiff`([`:40`](../packages/orchestrator/pkg/sandbox/build/deferred_diff.go))返回一个 `deferredDiff{cacheKey, blockSize, inner}`,把真正的 seal(落盘/封存)推迟到第一次真正需要读它的时候;`sealed()`([`:60`](../packages/orchestrator/pkg/sandbox/build/deferred_diff.go))查询状态。底层是一个 `utils.SetOnce[Diff]`——**seal 只可能成功一次**,重复 seal 是 no-op。seal 失败时返回 `ErrDeferredSealFailed`([`:18`](../packages/orchestrator/pkg/sandbox/build/deferred_diff.go),文案 `deferred rootfs seal failed`)。

消费点:memfile 在 [`sandbox.go:2757`](../packages/orchestrator/pkg/sandbox/sandbox.go),rootfs 在 [`sandbox.go:3410`](../packages/orchestrator/pkg/sandbox/sandbox.go);是否启用由 `defer-rootfs-export`(`DeferRootfsExportFlag`,2026.30 新增,[`flags.go:275`](../packages/shared/pkg/featureflags/flags.go),默认 false)控制,读取点在 [`pkg/server/sandboxes.go:943`](../packages/orchestrator/pkg/server/sandboxes.go) 与 [`:1206`](../packages/orchestrator/pkg/server/sandboxes.go)(`deferRootfsExport := s.featureFlags.BoolFlag(ctx, featureflags.DeferRootfsExportFlag)`)。

> ⚠️ **deferred 的价值在于把"必须先落盘才能返回"的窗口变成 CoW 窗口**:在 seal 真正发生之前,guest 仍在写自己的 COW,所以快照看到的是**seal 那一刻**的一致状态,而不是 pause 请求那一刻的状态。这正是 [snapshots.md](./snapshots.md) §4.2.0 里两条 checkpoint 路径的区别所在。细节见 [artifact-storage-cache.md](./artifact-storage-cache.md)。

### 12.6 Peer-to-Peer Chunk Transfer

由 feature flag `PeerToPeerChunkTransferFlag` 控制:

- 开启时,orchestrator 之间直接传 chunk
- 通过 Redis 注册每个 buildID 的"拥有者 node"
- 见 [`peerclient/`](../packages/orchestrator/pkg/sandbox/template/peerclient/) 和 [`peerserver/`](../packages/orchestrator/pkg/sandbox/template/peerserver/)

**2026.30 新增:chunk 分片逻辑抽到公共文件** [`peerserver/chunk.go`](../packages/orchestrator/pkg/sandbox/template/peerserver/chunk.go)。此前 `file.go`、`header.go`、`metadata.go` 各自内联一份分片 writer;现在统一为:

- `sendChunkSize = 1 << 20`(1 MiB,[`chunk.go:9`](../packages/orchestrator/pkg/sandbox/template/peerserver/chunk.go))——单次 `Sender.Send` 的 payload 上界(gRPC 自己有 message size 限制)。
- `sendChunked(sender, data)`([`:14`](../packages/orchestrator/pkg/sandbox/template/peerserver/chunk.go)):把整块 data 按 1 MiB 切片发出去。
- `chunkWriter`([`:31`](../packages/orchestrator/pkg/sandbox/template/peerserver/chunk.go)):`Write`([`:36`](../packages/orchestrator/pkg/sandbox/template/peerserver/chunk.go))攒够 1 MiB 就发一次,`flush`([`:56`](../packages/orchestrator/pkg/sandbox/template/peerserver/chunk.go))由调用方负责把尾巴发完。

消费方是 [`file.go:62`](../packages/orchestrator/pkg/sandbox/template/peerserver/file.go)、[`header.go:70`](../packages/orchestrator/pkg/sandbox/template/peerserver/header.go)、[`metadata.go:42`](../packages/orchestrator/pkg/sandbox/template/peerserver/metadata.go)。

> ⚠️ **`file.go` 没有被删除**,它只是失去了内联的 `chunkWriter`。把"新增 `chunk.go`"读成"替换掉 `file.go`"是错的。

### 12.7 缓存失效时机

| 场景 | 失效操作 |
|------|----------|
| build 完成/失败 | `TemplatesBuildCache.Invalidate(buildID)` + `TemplateCache.InvalidateAllTags(templateID)` |
| alias 创建/删除 | `AliasCache.Invalidate` |
| template 更新(public 变更) | `TemplateCache.InvalidateAllTags` + `TemplateMetadataCache.Invalidate` |
| template 删除 | 全部失效 |

---

## 十三、gRPC 接口规范

### 13.1 template-manager gRPC 服务

**Proto 定义**:[`packages/orchestrator/template-manager.proto`](../packages/orchestrator/template-manager.proto)

**服务定义**:

```protobuf
service TemplateService {
  // 发起 template build
  rpc TemplateCreate (TemplateCreateRequest) returns (google.protobuf.Empty);

  // 查询 build 状态 + 日志
  rpc TemplateBuildStatus (TemplateStatusRequest) returns (TemplateBuildStatusResponse);

  // 删除 build 的所有存储文件
  rpc TemplateBuildDelete (TemplateBuildDeleteRequest) returns (google.protobuf.Empty);

  // 初始化 layer file 上传(返回签名 URL)
  rpc InitLayerFileUpload (InitLayerFileUploadRequest) returns (InitLayerFileUploadResponse);
}
```

### 13.2 主要 Message 类型

#### TemplateConfig / TemplateCreateRequest

`TemplateCreateRequest` 包含 `TemplateConfig` + 可选 `cacheScope` + `version`。`TemplateConfig` 的字段(见 [`template-manager.proto:62-94`](../packages/orchestrator/template-manager.proto);2026.29 为 `62-90`):

| 字段 | 类型 | 说明 |
|------|------|------|
| `templateID` | string | template ID |
| `buildID` | string | build ID |
| `memoryMB` | int32 | 内存 MB |
| `vCpuCount` | int32 | CPU 核数 |
| `diskSizeMB` | int32 | **base phase** 的扩容目标;2026.30 起还兼作 `freeDiskSizeMB` 缺席时的回退值 |
| `freeDiskSizeMB` | optional int32 | **(2026.30 新增,field 17)** `resize-disk` phase 的目标 rootfs 空闲空间(MiB),不是总磁盘大小;缺席时回退到 `diskSizeMB`(见 §8.3.1) |
| `kernelVersion` | string | *(deprecated)* 内核版本,template-manager 自行决定 |
| `firecrackerVersion` | string | *(deprecated)* Firecracker 版本,同上 |
| `startCommand` | string | 启动命令 |
| `readyCommand` | string | 就绪命令 |
| `hugePages` | bool | *(deprecated)* hugePages,从 firecracker 版本派生 |
| `force` | optional bool | 强制重建 |
| `steps` | repeated TemplateStep | 自定义 step(v2) |
| `fromImage` | string | 基础镜像(v2,oneof source) |
| `fromTemplate` | FromTemplateConfig | 基础 template(v2,oneof source) |
| `fromImageRegistry` | optional FromImageRegistry | 私有 registry 认证 |
| `teamID` | string | team ID |

`TemplateStep`:`{type, args[], optional force, optional filesHash}`

`FromImageRegistry` 是 oneof:`AWSRegistry` / `GCPRegistry` / `GeneralRegistry`

#### TemplateBuildStatusResponse

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | TemplateBuildState enum | `Building` (0) / `Failed` (1) / `Completed` (2) |
| `metadata` | TemplateBuildMetadata | build 完成时返回的元信息 |
| `logEntries` | repeated TemplateBuildLogEntry | 日志条目 |
| `reason` | optional TemplateBuildStatusReason | 失败原因 `{message, optional step}` |

#### TemplateBuildMetadata

build 完成时返回(见 proto 第 132-149 行;2026.29 为第 128-139 行):

| 字段 | 类型 | 说明 |
|------|------|------|
| `rootfsSizeKey` | int32 | rootfs 大小 |
| `envdVersionKey` | string | envd 版本 |
| `kernelVersion` | string | 实际使用的 kernel 版本(API 持久化到 env_builds) |
| `firecrackerVersion` | string | 实际使用的 Firecracker 版本 |
| `schedulingMetadata` | SchedulingMetadata | 调度元信息(CPU 亲和性等,与 orchestrator 共享格式) |

### 13.3 orchestrator gRPC 服务(与 template 相关)

orchestrator gRPC 服务(端口通常 5008)的 `SandboxService` 在 2026.30 只剩 6 个 RPC([`orchestrator.proto:258-264`](../packages/orchestrator/orchestrator.proto)):

| RPC | 用途 |
|-----|------|
| `Sandbox.Create` | 创建沙盒(消费 template) |
| `Sandbox.Update` | 更新沙盒配置 |
| `Sandbox.List` | 列出本节点沙盒 |
| `Sandbox.Delete` | 删除沙盒 |
| `Sandbox.Pause` | 暂停沙盒 |
| `Sandbox.Checkpoint` | 快照/checkpoint |

> ⛔ **`Sandbox.ListCachedBuilds` 已于 2026.30 删除**(连同 `CachedBuildInfo` 与 `SandboxListCachedBuildsResponse` 消息)。详见 §6.2.6。

### 13.4 服务交互关系

```
┌─────────┐                ┌─────────────────┐    ┌──────────────┐
│   API   │ ──Template────▶│ template-manager│    │ orchestrator │
│         │    Create()    │   (build)       │    │  (sandbox)   │
│         │                │                 │    │              │
│         │ ──Template────▶│                 │    │              │
│         │    Status()    │                 │    │              │
│         │                └─────────────────┘    └──────────────┘
│         │                                             ▲
│         │ ──Sandbox.Create()─────────────────────────┤
│         │                                             │
└─────────┘                                             │
                                                        │
                       共享 sbxtemplate.Cache ◀─────────┘
                       (build 完成后,build node 自己缓存)
```

**重要**:template-manager server 和 orchestrator server 都跑在 orchestrator 进程里,通过 `sbxtemplate.Cache` 共享 template 文件缓存。这意味着 build 完成后,build node 自己已经把 template 缓存好了,可以立即启动 sandbox(优化路径)。

---

## 十四、并发限制与资源管理

### 14.1 并发 Build 限制

**限制值**:来自 `Team.Limits.BuildConcurrency`(底层由 tier 决定,`tiers.concurrent_template_builds` 默认 20,见 migration `20250901161352`)。

**检查逻辑**(见 [`register_build.go:75-99`](../packages/api/internal/template/register_build.go)):

```go
// 排除当前 template + tags(避免自己阻塞自己的重建)
otherBuildCount, err := db.GetInProgressTemplateBuildsByTeam(ctx, queries.GetInProgressTemplateBuildsByTeamParams{
    TeamID:            data.Team.ID,
    ExcludeTemplateID: data.TemplateID,
    ExcludeTags:       tags,
})
if err != nil { ... }

totalConcurrentTemplateBuilds := data.Team.Limits.BuildConcurrency
if otherBuildCount >= totalConcurrentTemplateBuilds {
    return &api.APIError{
        Code:      http.StatusTooManyRequests,  // 429
        ClientMsg: "you have reached the maximum number of concurrent template builds...",
    }
}
```

**重要说明**(`register_build.go:73-74` 注释):

> This is a simple implementation of concurrency limit. It does not guarantee that the limit is not exceeded, but it should be good enough for now.

通过查询 `active_template_builds` 表 count(无锁),所以高并发下可能短暂超限。注意检查在**事务外**,见 [14.4 节](#144-并发限制的近似实现)。

### 14.2 资源限制常量

定义在 [`packages/api/internal/constants/templates.go`](../packages/api/internal/constants/templates.go):

```go
const (
    MinTemplateCPU        = int64(1)
    MaxTemplateCPU        = int64(32)
    MinTemplateMemory     = int64(128)    // MB
    DefaultTemplateCPU    = int64(2)
    DefaultTemplateMemory = int64(1024)   // MB
)
```

### 14.3 active_template_builds 表的作用

此表用于:

1. **并发限制**:`SELECT count(*) FROM active_template_builds WHERE team_id = @team_id`
2. **build 完成时清理**:`DELETE FROM active_template_builds WHERE build_id = @build_id`
3. **template 删除时级联清理**:`ON DELETE CASCADE` 自动清理

### 14.4 并发限制的近似实现

并发检查**在事务外**执行,事务内才插入。完整时序:

```sql
-- [事务外] 1. 查 count(无锁,排除当前 template + tags)
SELECT count(*) FROM active_template_builds
  WHERE team_id = @team_id
    AND template_id != @exclude_template_id
    AND NOT (tags && @exclude_tags);  -- tags 数组不重叠

-- 如果 count >= limit → 直接返回 429,不进入事务

-- [事务内] 2. 插入新 build(见 6.2.2 事务结构)
BEGIN;
  -- CreateOrUpdateTemplate / CreateTemplateBuild / ...
  INSERT INTO active_template_builds (build_id, team_id, template_id, tags)
    VALUES (...);
COMMIT;
```

由于检查无锁,两个并发请求可能都通过 check,然后都进入事务插入。这是 "at-most-once" 的近似实现 — 对低并发的场景足够。

---

## 十五、配置与环境变量

### 15.1 核心 Environment Variables

| 变量名 | 用途 | 默认值 |
|--------|------|--------|
| `TEMPLATE_STORAGE_URL` | Template storage 的 provider 与 destination;设置后覆盖该角色的旧配置 | 未设置时走旧配置 |
| `BUILD_CACHE_STORAGE_URL` | Build cache storage 的 provider 与 destination,可与 template storage 不同 | 未设置时走旧配置 |
| `TEMPLATE_BUCKET_NAME` | 旧式 template cloud bucket 名 | provider 为云存储且未设置 URL 时必填 |
| `BUILD_CACHE_BUCKET_NAME` | 旧式 build cache bucket 名 | provider 为云存储时必填 |
| `LOCAL_TEMPLATE_STORAGE_BASE_PATH` | 本地存储根目录(本地开发) | `/tmp/templates` |
| `LOCAL_BUILD_CACHE_STORAGE_BASE_PATH` | 旧式本地 build cache 根目录 | `/tmp/build-cache` |
| `STORAGE_PROVIDER` | 存储后端类型 | `GCPBucket` |
| `S3_USE_PATH_STYLE` | 旧式 S3 path-style 开关 | `false` |
| `TEMPLATE_CACHE_DIR` | orchestrator 本地 template cache 目录 | 配置文件 |
| `BUILD_CLUSTERS_CONFIG` | build cluster 配置(JSON) | 无(必填) |
| `CLIENT_CLUSTERS_CONFIG` | client(sandbox)cluster 配置(JSON) | 无(必填) |

**可选 storage provider**:
- `GCPBucket` (默认)
- `AWSBucket`
- `Local`

### 15.2 IaC 配置

> ⛔ **本节内容自 2026.30 起已是历史档案**。`iac/` 目录在 2026.30 被整体删除(2026.29 有 172 个文件,2026.30 为 0),下面的 `iac/**` 路径**已不存在、链接不可点**。同一提交还删掉了根目录 `self-host.md`,以及根 `Makefile` 里的全部 Terraform/Nomad 目标(⚠️ `packages/docker-reverse-proxy/` 不在此列,它由更早的 `d153bbe9d` 删除)(`make init`、`make plan`、`make apply`、`make plan-only-jobs` 等)。**`make switch-env` / `make set-env` / `make build-and-upload/*` 仍然保留**,所以 §15.3 依旧有效。

**GCS Bucket 创建**(历史):`iac/provider-gcp/init/buckets.tf`

```hcl
# 第 135 行附近
name = (var.template_bucket_name != ""
  ? var.template_bucket_name
  : "${var.bucket_prefix}fc-templates")
```

**环境配置模板**:[`.env.gcp.template`](../.env.gcp.template) 第 119-124 行 — 可选覆盖 `TEMPLATE_BUCKET_NAME`,以及 `ANYWHERE_CACHE_ENABLED`(GCS Anywhere Cache)。

### 15.3 环境切换

```bash
make switch-env ENV=staging  # 切换到 staging
make switch-env ENV=prod     # 切换到 prod
make switch-env ENV=dev      # 切换到 dev
```

环境配置文件:`.env.{prod,staging,dev}`,基于 `.env.gcp.template`。

---

## 十六、Feature Flags

E2B 使用 LaunchDarkly 做 feature flag 管理。template 相关的 flag(行号均为 2026.30 的 [`packages/shared/pkg/featureflags/flags.go`](../packages/shared/pkg/featureflags/flags.go)):

| Flag | LD key | 行号 | 用途 |
|------|--------|------|------|
| `BuildFirecrackerVersion` | `build-firecracker-version` | [:743](../packages/shared/pkg/featureflags/flags.go) | 决定 build 用的 Firecracker 版本 |
| `BuildKernelVersion` | `build-kernel-version` | [:744](../packages/shared/pkg/featureflags/flags.go) | 决定 build 用的 kernel 版本 |
| `BuildEnvdVersion` | `build-envd-version` | [:756](../packages/shared/pkg/featureflags/flags.go) | **(2026.30 新增)** build 烘进 rootfs 的 envd 二进制,默认 `promoted` |
| `BuildKernelCmdlineArgs` | `build-kernel-cmdline-args` | [:777](../packages/shared/pkg/featureflags/flags.go) | **(2026.30 新增)** 按 team 追加 guest kernel 命令行参数,默认空 |
| `BuildEnvdMemoryProtection` | `build-envd-memory-protection` | [:493](../packages/shared/pkg/featureflags/flags.go) | **(2026.30 新增)** 给 envd 写 systemd `MemoryMin`/`MemoryLow` drop-in,默认 false |
| `BuildExt4DirIndex` | `build-ext4-dir-index` | [:390](../packages/shared/pkg/featureflags/flags.go) | **(2026.30 新增)** 是否保留 mkfs 默认的 htree 目录索引,默认 false(= 剥掉) |
| `BuildEnsureFreeDiskSpace` | `build-ensure-free-disk-space` | [:385](../packages/shared/pkg/featureflags/flags.go)(2026.29 :237) | 在 user steps 与 finalize 之间启用 `resize-disk`,默认 false |
| `MaxCacheWriterConcurrencyFlag` | `max-cache-writer-concurrency` | [:472](../packages/shared/pkg/featureflags/flags.go)(2026.29 :298) | 压缩 frame 写入 cache 的最大并发,默认 10 |
| `DeferRootfsExportFlag` | `defer-rootfs-export` | [:275](../packages/shared/pkg/featureflags/flags.go) | **(2026.30 新增)** 把 rootfs diff seal 推迟到 CoW 窗口,默认 false |
| `TemplateFeatureFlag` | `use-nfs-for-templates` | [:147](../packages/shared/pkg/featureflags/flags.go) | 是否启用 NFS cache(template) |
| `SnapshotFeatureFlag` | `use-nfs-for-snapshots` | [:146](../packages/shared/pkg/featureflags/flags.go) | 是否启用 NFS cache(snapshot) |
| `UseNFSCacheForBuildingTemplatesFlag` | `use-nfs-for-building-templates` | [:149](../packages/shared/pkg/featureflags/flags.go) | build 时是否用 NFS cache |
| `PeerToPeerChunkTransferFlag` | `peer-to-peer-chunk-transfer` | [:262](../packages/shared/pkg/featureflags/flags.go) | 是否启用 orchestrator 之间 P2P chunk 传输 |
| `FreePageReportingFlag` | `free-page-reporting` | [:279](../packages/shared/pkg/featureflags/flags.go) | Firecracker free page reporting 优化 |
| `BYOPProxyEnabledFlag` | `byop-proxy-enabled` | [:349](../packages/shared/pkg/featureflags/flags.go) | BYOP egress proxy |
| `BuildNodeInfo` | `preferred-build-node` | [:848](../packages/shared/pkg/featureflags/flags.go)(2026.29 :497) | 指定 build node 的机器配置(CPU family 等) |
| `MaxSandboxesPerNode` | `max-sandboxes-per-node` | [:435](../packages/shared/pkg/featureflags/flags.go)(2026.29 :282) | 每 node 最大沙盒数 |

> ⚠️ **`FreePageHintingFlag` 这个变量名不存在**——2026.29 和 2026.30 都没有它。free page hinting 的开关是一个**就地注册的 JSON flag** `free-page-hinting-config`(LD key 带 `-config` 后缀),注册点在 [`cmd/create-build/main.go:107`](../packages/orchestrator/cmd/create-build/main.go) 与 [`cmd/resume-build/fph_bench.go:109`](../packages/orchestrator/cmd/resume-build/fph_bench.go),**不在 `flags.go` 的集中清单里**。这也是为什么它容易被写成不存在的变量名。
>
> ⚠️ 同理,`BuildNodeInfo` 的 LD key 是 `preferred-build-node`,不是变量名的 kebab-case。

**Feature flag 客户端**:[`packages/shared/pkg/featureflags/`](../packages/shared/pkg/featureflags/)

---

## 十七、关键代码文件索引

### 17.1 数据库与查询层

| 文件 | 作用 |
|------|------|
| [`packages/db/migrations/20231124185944_create_schemas_and_tables.sql`](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql) | 创建 envs、env_aliases、tiers、teams 等基础表 |
| [`packages/db/migrations/20240315165236_create_env_builds.sql`](../packages/db/migrations/20240315165236_create_env_builds.sql) | 创建 env_builds 表 |
| [`packages/db/migrations/20241213142106_create_snapshots.sql`](../packages/db/migrations/20241213142106_create_snapshots.sql) | 创建 snapshots 表 |
| [`packages/db/migrations/20251218160000_allow_m_n_builds_with_tags.sql`](../packages/db/migrations/20251218160000_allow_m_n_builds_with_tags.sql) | 引入 env_build_assignments,支持 template↔build 多对多 + tag |
| [`packages/db/migrations/20260210120001_add_env_and_build_source_columns.sql`](../packages/db/migrations/20260210120001_add_env_and_build_source_columns.sql) | 引入 envs.source 列 |
| [`packages/db/migrations/20260210120002_add_status_group_column.sql`](../packages/db/migrations/20260210120002_add_status_group_column.sql) | 引入 env_builds.status_group 计算列 + 触发器 |
| [`packages/db/migrations/20260211120000_add_snapshot_templates.sql`](../packages/db/migrations/20260211120000_add_snapshot_templates.sql) | 创建 snapshot_templates 表 |
| [`packages/db/migrations/20260305130000_create_active_template_builds.sql`](../packages/db/migrations/20260305130000_create_active_template_builds.sql) | 创建 active_template_builds 表 |
| [`packages/db/migrations/20260628120000_add_env_deleted_at.sql`](../packages/db/migrations/20260628120000_add_env_deleted_at.sql) | 引入软删除 + active_envs 视图 |
| [`packages/db/migrations/20260714091414_add_template_disk_entitlements.sql`](../packages/db/migrations/20260714091414_add_template_disk_entitlements.sql) | **(2026.30 新增)** tiers/addons 的磁盘配额列 + CHECK + 回填 |
| [`packages/db/migrations/20260826075153_add_free_disk_limit_columns.sql`](../packages/db/migrations/20260826075153_add_free_disk_limit_columns.sql) | **(2026.30 新增)** `max_free_disk_size_mb` 系列列 + 重建 `team_limits` 视图 |
| [`packages/auth/pkg/types/limits.go`](../packages/auth/pkg/types/limits.go) | **(2026.30 新增字段)** `TeamLimits.DefaultFreeDiskSizeMb` / `MaxFreeDiskSizeMb`(:14-15) |
| [`packages/api/internal/team/free_disk.go`](../packages/api/internal/team/free_disk.go) | **(2026.30 新增)** `LimitFreeDiskSize`(:16) — 把请求的 `minFreeDiskMb` 解析到 team 配额内 |
| [`packages/db/pkg/types/types.go`](../packages/db/pkg/types/types.go) | BuildStatus / BuildStatusGroup 等类型定义 |
| [`packages/db/queries/templates/get_template_with_build_by_tag.sql`](../packages/db/queries/templates/get_template_with_build_by_tag.sql) | 核心 SQL:按 templateID + tag 查询 |
| [`packages/db/queries/templates/create_template.sql`](../packages/db/queries/templates/create_template.sql) | CreateOrUpdateTemplate 等 |
| [`packages/db/queries/templates/delete_template.sql`](../packages/db/queries/templates/delete_template.sql) | 软删除 + alias 释放 |
| [`packages/db/queries/builds/finish_template_build.sql`](../packages/db/queries/builds/finish_template_build.sql) | FinishTemplateBuild |
| [`packages/db/queries/snapshots/create_new_snapshot.sql`](../packages/db/queries/snapshots/create_new_snapshot.sql) | 沙盒 pause 时创建 snapshot |
| [`packages/db/queries/snapshots/create_snapshot_template_env.sql`](../packages/db/queries/snapshots/create_snapshot_template_env.sql) | 持久化 snapshot template |

### 17.2 API 层

| 文件 | 作用 |
|------|------|
| [`packages/api/internal/template/register_build.go`](../packages/api/internal/template/register_build.go) | `RegisterBuild` 函数 — DB 事务注册新 build |
| [`packages/api/internal/template-manager/template_manager.go`](../packages/api/internal/template-manager/template_manager.go) | `TemplateManager` 类型 — gRPC client 封装 |
| [`packages/api/internal/template-manager/create_template.go`](../packages/api/internal/template-manager/create_template.go) | `CreateTemplate` 方法 — 调用 gRPC `TemplateCreate` |
| [`packages/api/internal/template-manager/template_status.go`](../packages/api/internal/template-manager/template_status.go) | `PollBuildStatus` — 轮询 build 状态 |
| [`packages/api/internal/cache/templates/cache.go`](../packages/api/internal/cache/templates/cache.go) | `TemplateCache` — template+build 的 Redis 缓存 |
| [`packages/api/internal/cache/templates/alias_cache.go`](../packages/api/internal/cache/templates/alias_cache.go) | `AliasCache` — namespace/alias 解析 |
| [`packages/api/internal/handlers/template_request_build_v3.go`](../packages/api/internal/handlers/template_request_build_v3.go) | `POST /v3/templates` handler |
| [`packages/api/internal/handlers/template_delete.go`](../packages/api/internal/handlers/template_delete.go) | `DELETE /templates/{id}` handler |
| [`packages/api/internal/handlers/snapshot_template_create.go`](../packages/api/internal/handlers/snapshot_template_create.go) | `POST /sandboxes/{id}/snapshots` handler |
| [`packages/api/internal/orchestrator/snapshot_template.go`](../packages/api/internal/orchestrator/snapshot_template.go) | 从运行 sandbox 创建 snapshot template |

### 17.3 Orchestrator / template-manager 层

| 文件 | 作用 |
|------|------|
| [`packages/orchestrator/template-manager.proto`](../packages/orchestrator/template-manager.proto) | template-manager gRPC 服务 proto 定义 |
| [`packages/orchestrator/pkg/template/build/builder.go`](../packages/orchestrator/pkg/template/build/builder.go) | `Builder.Build` — 完整 build 流程编排 |
| [`packages/orchestrator/pkg/template/build/phases/ensurefreedisk/`](../packages/orchestrator/pkg/template/build/phases/ensurefreedisk/) | `resize-disk` phase:NBD 离线 ext4 空闲空间检测、扩容和 diff 导出 |
| [`packages/orchestrator/pkg/template/build/commands/copy.go`](../packages/orchestrator/pkg/template/build/commands/copy.go) | Template `COPY` step 的参数装配 |
| [`packages/orchestrator/pkg/template/build/commands/copy_script.sh`](../packages/orchestrator/pkg/template/build/commands/copy_script.sh) | Docker-compatible 目录 merge、覆盖与 symlink 处理 |
| [`packages/orchestrator/pkg/template/server/create_template.go`](../packages/orchestrator/pkg/template/server/create_template.go) | gRPC `TemplateCreate` 服务端实现 |
| [`packages/orchestrator/pkg/template/server/template_status.go`](../packages/orchestrator/pkg/template/server/template_status.go) | gRPC `TemplateBuildStatus` |
| [`packages/orchestrator/pkg/sandbox/template/cache.go`](../packages/orchestrator/pkg/sandbox/template/cache.go) | `sbxtemplate.Cache` — 沙盒启动用的 template 文件缓存 |
| [`packages/orchestrator/pkg/sandbox/template/storage_template.go`](../packages/orchestrator/pkg/sandbox/template/storage_template.go) | `storageTemplate` — Template interface 实现 |
| [`packages/orchestrator/pkg/template/metadata/template_metadata.go`](../packages/orchestrator/pkg/template/metadata/template_metadata.go) | `metadata.Template` 数据结构 |
| [`packages/orchestrator/pkg/server/sandboxes.go`](../packages/orchestrator/pkg/server/sandboxes.go) | gRPC `Sandbox.Create` — 沙盒启动入口 |
| [`packages/orchestrator/pkg/template/build/core/envd/resolve.go`](../packages/orchestrator/pkg/template/build/core/envd/resolve.go) | **(2026.30 新增)** `ResolveBuildBinary` — `build-envd-version` 目标解析 |
| [`packages/orchestrator/pkg/template/build/phases/base/distro/`](../packages/orchestrator/pkg/template/build/phases/base/distro/) | **(2026.30 新增)** distro profile / init system / NixOS 预制镜像 |
| [`packages/orchestrator/pkg/template/build/result.go`](../packages/orchestrator/pkg/template/build/result.go) | **(2026.30 新增)** `ClassifyBuildResult` — build 结果分类指标 |
| [`packages/orchestrator/pkg/sandbox/fc/kernel_args.go`](../packages/orchestrator/pkg/sandbox/fc/kernel_args.go) | **(2026.30 新增)** guest kernel cmdline 解析/校验/overlay |
| [`packages/orchestrator/pkg/sandbox/build/deferred_diff.go`](../packages/orchestrator/pkg/sandbox/build/deferred_diff.go) | **(2026.30 新增)** 延迟 seal 的 diff |

> ⛔ **`packages/orchestrator/pkg/server/template_cache.go` 已于 2026.30 删除**(连同 `ListCachedBuilds` RPC)。旧版本本文在此处列过它,现仅作历史记录。详见 §6.2.6。
>
> ⛔ **`packages/orchestrator/pkg/template/build/utils/utils.go` 已于 2026.30 删除**(2026.29 起已是无调用方的死代码)。

### 17.4 共享层

| 文件 | 作用 |
|------|------|
| [`packages/shared/pkg/storage/paths.go`](../packages/shared/pkg/storage/paths.go) | `storage.Paths` — GCS 路径构造 |
| [`packages/shared/pkg/id/id.go`](../packages/shared/pkg/id/id.go) | `id.ParseName` / `Generate` / `ValidateAndDeduplicateTags` |
| [`packages/shared/pkg/templates/versions.go`](../packages/shared/pkg/templates/versions.go) | template schema 版本常量 |
| [`packages/api/internal/constants/templates.go`](../packages/api/internal/constants/templates.go) | CPU / 内存限制常量 |

---

## 十八、设计要点与演进历史

### 18.1 命名历史包袱

| 层 | 命名 | 说明 |
|----|------|------|
| DB 表名 | `envs` / `env_builds` / `env_aliases` | 早期叫 "environment" |
| 应用层 | `template` | 统一对外 |
| `envs.source` 列 | `'template'` / `'snapshot'` / `'snapshot_template'` | 区分三种来源 |

**阅读建议**:看到 `env*` 命名时,要意识到它实际上就是 template。

### 18.2 多对多演进的复杂性

**历史**:template 和 build 一开始是一对一(`env_builds.env_id` 直接关联)。

**演进**:

1. **migration `20251218160000`**:引入 `env_build_assignments` 表,支持 tag。同时保留从 `env_builds.env_id` 自动同步的触发器(过渡期)。
2. **migration `20260204172712`**:移除所有同步触发器,完全由应用层管理。但保留了反向 backfill 触发器 `backfill_env_id_from_assignment`。

**为什么这样设计**:渐进式迁移,避免一次性大改动导致故障。

### 18.3 软删除策略

**为什么不能真删除**:
- 历史 sandbox 记录、snapshot 可能引用
- 计费/分析需要保留
- 防止误操作

**实现**:
- `envs.deleted_at` 标记软删除
- `active_envs` 视图过滤
- alias 会真删(让名字可复用)
- GCS 文件需要单独通过 `TemplateBuildDelete` RPC 清理

### 18.4 状态机的两套值

**为什么有两套**:

- `env_builds.status`(原始值,7+ 个值)— 兼容旧值,写操作用
- `env_builds.status_group`(归一化,4 个值)— 简化消费者,读操作用

**设计目的**:向后兼容老 status 值仍可读,同时简化消费者逻辑。

### 18.5 并发限制的"近似"实现

**为什么不严格限制**:

严格的并发限制需要分布式锁,代价高。E2B 选择了"近似"实现:

- 查 count(无锁)+ 插入
- 高并发下可能短暂超限
- 但实现简单,对用户透明

代码注释(`register_build.go:74-86`):

> This is a simple implementation of concurrency limit. It does not guarantee that the limit is not exceeded, but it should be good enough for now.

### 18.6 Cache key 设计的巧思

**Redis Cluster hash tag**:

```
key = "{templateID}:prod"
```

`{}` 是 Redis Cluster 的 hash tag,保证同一 template 的所有 key 落在同一 slot,从而支持 `DeleteByPrefix` 的原子批量删除(`InvalidateAllTags`)。

**好处**:失效一个 template 的所有缓存只需一次操作,而不是逐个删除。

### 18.7 Build Phases 的 Layer 缓存

**为什么分多个 phase**:

每个 phase 输出一个 layer,layer 是内容寻址的(content-addressed)。这意味着:

- 相同的 step 不会重复构建
- 多个 template 共享相同 base layer
- 大幅加速 build

### 18.8 status_group 触发器

**为什么用触发器**:

应用层维护 status_group 容易出 bug(忘记更新)。用 DB 触发器自动维护更可靠。

**实际实现**(见 [`migration 20260210120002`](../packages/db/migrations/20260210120002_add_status_group_column.sql)):

```sql
-- 计算函数
CREATE OR REPLACE FUNCTION compute_status_group() RETURNS TRIGGER AS $$
BEGIN
  NEW.status_group := CASE
    WHEN NEW.status IN ('pending', 'waiting') THEN 'pending'
    WHEN NEW.status IN ('in_progress', 'building', 'snapshotting') THEN 'in_progress'
    WHEN NEW.status IN ('ready', 'uploaded', 'success') THEN 'ready'
    ELSE 'failed'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 触发器(BEFORE INSERT OR UPDATE OF status)
CREATE OR REPLACE TRIGGER trg_compute_status_group
  BEFORE INSERT OR UPDATE OF status ON public.env_builds
  FOR EACH ROW EXECUTE FUNCTION compute_status_group();
```

migration 还包含一个 `backfill_status_group()` 存储过程,用 50000 行一批 + `pg_sleep(10)` 的方式把历史行回填,避免长事务锁表。

### 18.9 2026.30 变动速览

按影响面排序,便于快速定位。

**新增能力**

| 主题 | 一句话 | 详见 |
|------|--------|------|
| 磁盘目标拆分 | `TemplateConfig` 新增 `freeDiskSizeMB`,与 `diskSizeMB` 分工;缺席时回退 | §8.3.1、§13.2 |
| distro 感知 base | 按 `/etc/os-release` 选 profile 与 init system,systemd/OpenRC/NixOS 三分支 | §8.3.2、§6.2.4 |
| envd 版本可 pin | `build-envd-version` 让 build 烘指定的 staged envd;pin 不中直接 fail | §5.5、§16 |
| envd 内存保护 | `build-envd-memory-protection` 写 systemd `MemoryMin`/`MemoryLow` drop-in | §8.3.3、§16 |
| kernel cmdline 注入 | `build-kernel-cmdline-args` 按 team 追加参数,保留参数被拒则整段回退 | §8.3.4、§16 |
| ext4 htree 开关 | `build-ext4-dir-index`(默认 false = **剥掉** mkfs 默认的索引) | §8.3.5、§16 |
| 延迟 rootfs seal | `defer-rootfs-export` + `NewDeferredDiff` 把 seal 推到 CoW 窗口 | §12.5、§16 |
| build 结果指标 | `ClassifyBuildResult` → `template_build_result_total` | §6.2.4 |
| cache writer 限流 | `max-cache-writer-concurrency`(默认 10)限制压缩 frame 写入并发 | §12.4、§16 |
| 磁盘配额列 | 两个 migration 加 tiers/addons/project_limits 的 free-disk 列,重建 `team_limits` 视图 | §3.9、§17.1 |
| P2P 分片抽公共 | 新增 `peerserver/chunk.go`(`sendChunkSize = 1 MiB`) | §12.6 |

**变动 / 修正**

| 主题 | 一句话 | 详见 |
|------|--------|------|
| Firecracker 默认版本换线 | `DefaultFirecrackerVersion` 从 `v1.14.1_431f1fc` 改为 `v1.14-0.2.0`;跨 line 升级只由运维 flag 决定 | §5.5 |
| `diskSizeMB` 语义收窄 | 它不再等于"目标空闲空间",只是 base phase 的扩容目标 + 回退值 | §8.3.1 |
| 未完成工作计数 | `ServiceInfo.TrackWork()` 登记 template-manager 的未完成工作 | §6.2.4 |

**删除(⛔)**

| 主题 | 一句话 | 详见 |
|------|--------|------|
| `ListCachedBuilds` RPC | 连同 `CachedBuildInfo` / `SandboxListCachedBuildsResponse` 与 `pkg/server/template_cache.go` 一起删除;`SandboxService` 只剩 6 个 RPC | §6.2.6、§13.3 |
| `build/utils/utils.go` | 无调用方的死代码 | §6.2.4、§17.3 |
| `iac/` 部署目录 | 172 → 0 个文件;同批删除 `self-host.md`、根 Makefile 的 Terraform/Nomad 目标。⚠️ `packages/docker-reverse-proxy/`（19 → 0）由更早的 `d153bbe9d` 删除,不属同批 | §11.1、§15.2 |

---

## 十九、常见问题与排查

### 19.1 Template 创建失败

**症状**:`POST /v3/templates` 返回错误

**排查**:

1. 检查 namespace 是否等于 team slug([`id.ValidateNamespaceMatchesTeam`](../packages/shared/pkg/id/id.go))
2. 检查 alias 格式(必须匹配 `^[a-z0-9-_]+$`)
3. 检查 tag 格式(必须匹配 `^[a-z0-9-_.]+$`,不能是 UUID)
4. 检查并发 build 限制(`tiers.concurrent_template_builds`)
5. 检查资源限制(CPU 1-32,内存 ≥ 128MB)

### 19.2 Build 一直 pending

**症状**:build 状态长期停留在 `pending`

**排查**:

1. 检查 `active_template_builds` 表是否有对应记录
2. 检查 template-manager gRPC 服务是否可达
3. 查看 API 端的 `BuildStatusSync` 日志
4. 如果 pending 超过 40 分钟,会自动失败(`syncWaitingStateDeadline`)

### 19.3 Build 失败

**症状**:build 状态变成 `failed`

**排查**:

1. 查 `env_builds.reason` 字段(JSON,含 `message` 和 `step`)
2. 通过 `TemplateBuildStatus` gRPC 拉取 build 日志
3. 常见失败原因:
   - Docker 镜像拉取失败(检查 registry auth)
   - provisioning 脚本失败(检查 systemd 安装)
   - start_cmd / ready_cmd 超时
   - snapshot 失败(资源不足)
   - GCS 上传失败(权限/配额)

### 19.4 Sandbox 启动失败

**症状**:基于 template 启动沙盒失败

**排查**:

1. 检查 build 状态是否为 `ready`(`status_group = 'ready'`)
2. 检查 GCS bucket 里 build 目录是否有完整文件(memfile, rootfs.ext4, snapfile, metadata.json)
3. 检查 orchestrator 的 templateCache 日志
4. 检查 Firecracker / kernel / envd 版本兼容性

### 19.5 Alias 解析失败

**症状**:用 alias 启动沙盒,提示 template not found

**排查**:

1. 确认 alias 格式(`namespace/alias:tag`)
2. 检查 namespace 是否正确(裸 alias 会先按 team slug 查)
3. 检查 AliasCache 是否有缓存(TTL 5 分钟,可能过期)
4. 检查 `env_aliases` 表是否有对应记录
5. 检查 template 是否被软删除(`active_envs` 视图)

### 19.6 并发 build 限制

**症状**:创建 template 时报 "concurrent build limit exceeded"

**排查**:

```sql
-- 查看 team 的活跃 build
SELECT * FROM active_template_builds
  WHERE team_id = @team_id
  ORDER BY created_at DESC;

-- 查看 team 的并发限制
SELECT concurrent_template_builds FROM tiers
  WHERE id = (SELECT tier_id FROM teams WHERE id = @team_id);
```

如果 active build 数超过限制,等待现有 build 完成,或删除不需要的 template。

### 19.7 缓存不一致

**症状**:template 已更新但读到的还是旧数据

**排查**:

1. 检查 Redis 缓存是否已失效
   - `AliasCache`:5 分钟 TTL
   - `TemplateCache`:5 分钟 TTL
   - `TemplatesBuildCache`:5 分钟 TTL
2. 手动失效:
   - `templateCache.InvalidateAllTags(templateID)`
   - `templateCache.InvalidateAlias(alias, namespace)`
3. orchestrator 端 `sbxtemplate.Cache`:25 小时 TTL,如果需要立即可用,重启 orchestrator 或等待新 build

### 19.8 GCS 存储膨胀

**症状**:GCS bucket 占用持续增长

**排查**:

1. 删除 template 不会自动清理 GCS 文件
2. 需要通过 `TemplateBuildDelete` gRPC RPC 单独清理
3. 检查是否有遗留的 build 文件(已删除 template 的)

---

## 附录 A:常用 SQL 查询

### A.1 查看一个 template 的所有 build

```sql
SELECT
    eb.id,
    eb.status,
    eb.status_group,
    eb.created_at,
    eb.finished_at,
    eb.kernel_version,
    eb.firecracker_version,
    eb.envd_version,
    eba.tag
FROM env_builds eb
LEFT JOIN env_build_assignments eba ON eba.build_id = eb.id
WHERE eb.team_id = @team_id
  AND eb.id IN (
    SELECT build_id FROM env_build_assignments
    WHERE env_id = @template_id
  )
ORDER BY eb.created_at DESC;
```

### A.2 查看 team 的活跃 build

```sql
SELECT
    atb.build_id,
    atb.template_id,
    atb.tags,
    atb.created_at,
    e.alias
FROM active_template_builds atb
LEFT JOIN env_aliases e ON e.env_id = atb.template_id
WHERE atb.team_id = @team_id
ORDER BY atb.created_at DESC;
```

### A.3 按 tag 查询 template + build

```sql
SELECT
    e.id AS template_id,
    e.alias,
    eb.id AS build_id,
    eb.status_group,
    eb.kernel_version,
    eb.firecracker_version
FROM active_envs e
JOIN env_build_assignments eba ON eba.env_id = e.id
    AND eba.tag = @tag
JOIN env_builds eb ON eb.id = eba.build_id
    AND eb.status_group = 'ready'
WHERE e.id = @template_id
  AND e.source IN ('template', 'snapshot_template')
ORDER BY eba.created_at DESC
LIMIT 1;
```

### A.4 查看 template 的所有 alias

```sql
SELECT
    id,
    alias,
    namespace,
    is_renamable,
    created_at
FROM env_aliases
WHERE env_id = @template_id;
```

### A.5 查看软删除的 template

```sql
SELECT
    id,
    team_id,
    source,
    build_count,
    spawn_count,
    created_at,
    deleted_at
FROM envs
WHERE deleted_at IS NOT NULL
  AND team_id = @team_id
ORDER BY deleted_at DESC;
```

---

## 附录 B:Debug 工具

### B.1 SSH 到 orchestrator

```bash
make setup-ssh
make connect-orchestrator
```

### B.2 查看 Nomad UI

访问:`https://nomad.<your-domain>`(token 在 GCP Secrets Manager)

### B.3 查看日志

- **本地**:Docker logs(`make local-infra`)
- **生产**:Grafana Loki 或 Nomad UI

### B.4 gRPC 调试

可以用 `grpcurl` 直接调用 template-manager gRPC 服务(默认端口 5008,原先记录在 `iac/provider-gcp/variables.tf:335` — **该文件已在 2026.30 随 `iac/` 删除,见 §15.2**):

```bash
# 列出服务
grpcurl -plaintext localhost:5008 list

# 调用 TemplateBuildStatus
grpcurl -plaintext -d '{
  "template_id": "...",
  "build_id": "..."
}' localhost:5008 template.TemplateService/TemplateBuildStatus
```

---

## 附录 C:术语表

| 术语 | 含义 |
|------|------|
| Template | 沙盒镜像规格(DB: `envs`) |
| Template Build | Template 的一次构建(DB: `env_builds`) |
| Template Alias | Template 的可读名字(DB: `env_aliases`) |
| Template Tag | Build 的标记(DB: `env_build_assignments.tag`) |
| Snapshot | 运行中沙盒的快照(DB: `snapshots`) |
| Snapshot Template | 持久化的快照模版(source='snapshot_template') |
| Build Status | Build 的原始状态(pending/building/uploaded 等) |
| Build Status Group | 归一化状态组(pending/in_progress/ready/failed) |
| Active Template Build | 正在进行的 build(DB: `active_template_builds`) |
| memfile | VM 内存镜像(GCS, block device) |
| rootfs.ext4 | ext4 根文件系统(GCS, block device) |
| snapfile | VM CPU/设备状态序列化(GCS, 整文件) |
| metadata.json | template 元信息(GCS, JSON) |
| Envd | in-VM daemon(端口 49983) |
| Firecracker | microVM 虚拟化引擎 |
| NFS Cache | 本地文件缓存加速层 |
| DiffStore | block-level diff 缓存 |
| Peer-to-Peer | orchestrator 之间的 chunk 传输 |

---

**文档版本**:已同步至 **2026.30**。本文所有 `file:line` 行号均以 tag `2026.30` 为准;行号与 2026.29 有差异处已并列标注。2026.30 的变动清单见 [18.9 节](#189-202630-变动速览)。

**维护**:如有疑问或发现文档过期,请对照 [`packages/db/migrations/`](../packages/db/migrations/) 和 [`packages/api/internal/template/`](../packages/api/internal/template/) 的最新代码核对。
