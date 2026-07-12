# E2B 数据库表字段与关联关系参考

> 数据来源:`packages/db/migrations/` 下 100+ 个 goose 迁移,最新至 `20260702120000_add_events_ttl_days.sql`。
> 本文档聚焦**每个表的字段作用**与**跨表关联关系**,作为开发参考。整体演进历史与触发器细节见 [`../SCHEMA.md`](../SCHEMA.md)。
> 已逐表对照迁移文件两轮校对(2026-07-10)。

---

## 目录

- [1. 总览](#1-总览)
  - [1.1 全局关系图](#11-全局关系图主要外键)
  - [1.2 枚举字段值速查](#12-枚举字段值速查)
- [2. 身份认证簇](#2-身份认证簇)
  - [`auth.users`](#authusers)
  - [`public.users`](#publicusers)
  - [`user_identities`](#user_identities)
- [3. 租户与权限簇](#3-租户与权限簇)
  - [`tiers`](#tiers)
  - [`teams`](#teams)
  - [`users_teams`](#users_teams)
- [4. 凭据与令牌簇](#4-凭据与令牌簇)
  - [`team_api_keys`](#team_api_keys)
  - [`access_tokens`](#access_tokens)
- [5. 模板与构建簇](#5-模板与构建簇)
  - [`envs`](#envs)
  - [`env_aliases`](#env_aliases)
  - [`env_builds`](#env_builds)
  - [`env_build_assignments`](#env_build_assignments)
  - [`active_template_builds`](#active_template_builds)
- [6. 沙箱与快照簇](#6-沙箱与快照簇)
  - [`snapshots`](#snapshots)
  - [`snapshot_templates`](#snapshot_templates)
- [7. 容量与基础设施簇](#7-容量与基础设施簇)
  - [`clusters`](#clusters)
  - [`volumes`](#volumes)
  - [`addons`](#addons)
  - [视图 `team_limits`](#视图-team_limits)
  - [视图 `active_envs`](#视图-active_envs)
- [8. 关联关系矩阵](#8-关联关系矩阵)
- [9. 索引与触发器一览](#9-索引与触发器一览)
- [10. 常见查询模式](#10-常见查询模式)
- [11. 并发与一致性要点](#11-并发与一致性要点)
- [附录:迁移文件命名规范](#附录迁移文件命名规范)

---

## 1. 总览

数据库分 6 个业务簇:

| 簇 | 核心表 | 职责 |
| --- | --- | --- |
| 身份认证 | `auth.users`、`public.users`、`user_identities` | Supabase auth 投影 + OIDC 多身份 |
| 租户与权限 | `tiers`、`teams`、`users_teams` | 多租户与团队成员 |
| 凭据与令牌 | `team_api_keys`、`access_tokens` | hash 化的 API 凭证 |
| 模板与构建 | `envs`、`env_aliases`、`env_builds`、`env_build_assignments`、`active_template_builds` | 模板生命周期与构建执行 |
| 沙箱与快照 | `snapshots`、`snapshot_templates` | 沙箱状态持久化 |
| 容量与基础设施 | `clusters`、`volumes`、`addons` | 编排集群、卷、附加配额 |

**全局约定**:
- 所有枚举字段用 `text` + 应用层约束,无 `CREATE TYPE ... AS ENUM`
- 所有时戳字段为 `timestamptz`
- 主键命名:`id`(uuid/text) 或复合业务键
- 唯一约束 / partial 索引大量用于软删除与可空唯一列
- **软删除**:仅 `envs.deleted_at` 实现;其它表(teams/users/...)用 CASCADE 或业务层 is_banned/is_blocked
- **跨表联接读路径**:`active_envs` 视图是读 envs 的规范入口,所有快照/构建查询都要 JOIN 它来跳过软删除 env

### 1.1 全局关系图(主要外键)

```
                          ┌──────────────┐
                          │  auth.users  │   ← Supabase 管理,E2B 不引用
                          └──────────────┘

                          ┌──────────────┐         ┌────────────────┐
                          │ public.users │◄────────│ user_identities│ (OIDC 多身份)
                          └──────┬───────┘         └────────────────┘
                                 │
                                 │ user_id
                                 ▼
   ┌──────────────────┐    ┌──────────────┐    ┌─────────────┐
   │   access_tokens  │    │ users_teams  │    │ team_api_keys│
   └──────────────────┘    └──────┬───────┘    └──────┬──────┘
                                  │ team_id           │ team_id
                                  ▼                   ▼
                              ┌────────────────────────┐    ┌────────┐
                              │         teams          │───▶│ tiers  │
                              │  (tenant主体, slug 唯一) │    └────────┘
                              └────┬───────────────┬───┘
                  cluster_id ──────┤               │ tier
                                   │               │
                    ┌──────────────┴────────┐      │
                    ▼                       ▼      │
              ┌──────────┐            ┌─────────┐   │
              │ clusters │            │ volumes │   │
              └──────────┘            └─────────┘   │
                                                    │
                                   ┌────────────────┴────────────┐
                                   ▼                             ▼
                              ┌─────────┐               ┌──────────────┐
                              │  envs   │◄──────────────│   addons    │ (有效期内的额外配额)
                              │ (source)│               └──────────────┘
                              └─┬───┬───┘
                env_aliases  ───┤   ├── snapshots (env_id, base_env_id)
                env_build_      │   │
                assignments  ───┤   ├── snapshot_templates (env_id=PK)
                                │   │
                                ▼   ▼
                            ┌─────────────┐  build_id ◄── active_template_builds
                            │ env_builds  │              (配额计数)
                            │ (status_group)│
                            └─────────────┘
```

### 1.2 枚举字段值速查

E2B 不用 PostgreSQL ENUM 类型,但下列"事实枚举"由应用层 + 触发器约束:

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `tiers.id` | `free`、`pro`、`enterprise`、`startup-pro`、... | tier 标识(实际值由 seed 决定,代码不写死) |
| `envs.source` | `template` | 普通模板(默认) |
| | `snapshot` | 由 pause 产生的 env(快照遗留) |
| | `snapshot_template` | 由 checkpoint 提升的快照模板 |
| `env_builds.status` | `waiting` | 已 INSERT 但等待资源分配 |
| | `pending` | 排队中 |
| | `building` | template-manager 正在 docker build |
| | `in_progress` | orchestrator 正在导出 rootfs/memfile |
| | `snapshotting` | pause/checkpoint 中的中间状态 |
| | `ready` | build 完成,可被 spawn(resume-ready) |
| | `uploaded` | 已上传到 GCS(checkpoint 终态) |
| | `success` | 通用成功终态 |
| | `error` / `failed` | 失败终态(status_group 都映射到 `failed`) |
| `env_builds.status_group` | `pending` | 由 `waiting`/`pending` 派生 |
| (派生自 status) | `in_progress` | 由 `building`/`in_progress`/`snapshotting` 派生 |
| | `ready` | 由 `ready`/`uploaded`/`success` 派生 |
| | `failed` | 其它(status_group 派生函数的兜底分支) |
| `env_build_assignments.source` | `app` | 用户 API 创建(默认) |
| | `trigger` | CI 触发器自动创建 |
| | `migration` | 数据迁移脚本 |

---

## 2. 身份认证簇

### `auth.users`

- **Schema**:`auth`
- **来源**:`20000101000000_auth.sql`
- **角色**:Supabase 风格的身份源表,E2B 不直接写入

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | 用户唯一标识 |
| `email` | text NOT NULL | 邮箱(由 Supabase 管理) |
| `created_at` | timestamptz DEFAULT now() | 创建时间 |
| `raw_app_meta_data` | jsonb NULL | 应用元数据(Supabase 内部) |
| `raw_user_meta_data` | jsonb NULL | 用户元数据 |

**关联**:不被任何 FK 引用(早期由 `public.users` 引用,`20260316130000` 中 DROP)

**其它**:`auth.uid()` 函数定义在同 schema,目前无 FK 依赖

---

### `public.users`

- **Schema**:`public`
- **来源**:`20251217000000_create_public_users_table.sql`
- **角色**:E2B 业务域的用户投影表

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK | 与 `auth.users.id` 历史一致,现已无 FK |
| `created_at` | timestamptz DEFAULT now() | 创建时间 |
| `updated_at` | timestamptz DEFAULT now() | 更新时间 |

> 早期有 `email` 列,经 `20260520193000` 弃用 + `20260521181000` DROP。当前只有 `id` + 时间戳。

**关联(被引用,均 CASCADE 或 SET NULL)**:
- `user_identities.user_id` → CASCADE
- `users_teams.user_id` / `users_teams.added_by` → CASCADE / SET NULL
- `access_tokens.user_id` → CASCADE
- `team_api_keys.created_by` → SET NULL
- `envs.created_by` → SET NULL
- `addons.added_by` → NO ACTION

---

### `user_identities`

- **Schema**:`public`
- **来源**:`20260515120000_create_user_identities_table.sql`
- **角色**:支持同一 user 绑定多个 OIDC 身份(不同 IdP)

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `oidc_iss` | text NOT NULL PK(组合) | OIDC issuer URL |
| `oidc_sub` | text NOT NULL PK(组合) | OIDC subject(在该 IdP 内唯一) |
| `user_id` | uuid NOT NULL | 关联 `public.users.id` |
| `created_at` | timestamptz DEFAULT now() | 首次绑定时间 |
| `updated_at` | timestamptz DEFAULT now() | 更新时间 |

**主键**:(`oidc_iss`, `oidc_sub`)
**外键**:`user_id → public.users(id) ON UPDATE NO ACTION ON DELETE CASCADE`
**索引**:`user_identities_user_id_idx (user_id)`

---

## 3. 租户与权限簇

### `tiers`

- **Schema**:`public`
- **来源**:`20231124185944_create_schemas_and_tables.sql`
- **角色**:订阅层级,定义团队的基础配额

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | text PK | 层级 ID(如 `free`、`pro`) |
| `name` | text NOT NULL | 显示名 |
| `disk_mb` | bigint DEFAULT 512 | 单 sandbox 磁盘(MB) |
| `concurrent_instances` | bigint NOT NULL | 团队并发 sandbox 上限 |
| `max_length_hours` | bigint NOT NULL(`20240219190940` 加,曾默认 1) | 单 sandbox 最长存活小时 |
| `max_vcpu` | bigint NOT NULL DEFAULT 8(`20250507134356` 加) | 团队级 CPU 总量上限 |
| `max_ram_mb` | bigint NOT NULL DEFAULT 8192(同上,曾误设 8096 后修) | 团队级内存总量上限 |
| `concurrent_template_builds` | bigint NOT NULL DEFAULT 20(`20250901161352` 加) | 团队并发模板构建数 |
| `events_ttl_days` | bigint NOT NULL DEFAULT 7(`20260702120000` 加) | 事件日志保留天数 |

> **已删除字段**:早期 `vcpu`、`ram_mb`(单 sandbox 级别),`20240305221944_remove_tier_resources.sql` 中 DROP,因为单实例规格改由 `env_builds` 自带。

**CHECK 约束**:`concurrent_instances > 0`、`disk_mb > 0`、`concurrent_template_builds > 0`、`events_ttl_days > 0`
**被引用**:`teams.tier`
**聚合于视图**:`team_limits`

**典型查询**:
- 直接 SELECT:获取 tier 字典(API 启动时缓存到内存)
- 通过 `team_limits` 视图聚合(addons 加成)后,几乎所有配额检查都走视图而非本表

**代码入口**:
- 读:`packages/api/internal/auth/...`(tier 解析)、`team_limits` 视图调用点
- 写:**无运行时写入**,仅 seed/迁移脚本管理

---

### `teams`

- **Schema**:`public`
- **来源**:`20231124185944_create_schemas_and_tables.sql`
- **角色**:租户主体,几乎所有业务数据的归属维度

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | 团队 ID |
| `created_at` | timestamptz DEFAULT now() | 创建时间 |
| `name` | text NOT NULL | 团队名 |
| `is_blocked` | boolean NOT NULL DEFAULT false | 旧版封禁标记(保留兼容) |
| `tier` | text NOT NULL | FK → `tiers(id)`,订阅层级 |
| `email` | varchar(255) NOT NULL(`20240103104619` 加) | 联系邮箱 |
| `is_banned` | boolean NOT NULL DEFAULT false(`20240106121919` 加) | 新版封禁标记 |
| `blocked_reason` | text NULL(同上) | 封禁原因 |
| `cluster_id` | uuid(`20250606213446` 加,可空) | FK → `clusters(id)` 专属集群 |
| `slug` | text NOT NULL UNIQUE(`20260121175429` 加) | URL 友好标识,由触发器自动生成 |
| `sandbox_scheduling_labels` | text[] NOT NULL DEFAULT '{}'(`20260309120000` 加) | 调度时附加的节点标签 |

> **已删除字段**:`is_default`(团队级),`20250106142106` 中 DROP(默认团队语义移到 `users_teams.is_default`)

**外键**:
- `tier → tiers(id) ON UPDATE NO ACTION ON DELETE NO ACTION`
- `cluster_id → clusters(id)`(可空)

**唯一约束**:`teams_slug_unique (slug)`
**触发器**:`team_slug_trigger`(BEFORE INSERT 自动生成 slug)

**被引用(8 个表)**:`users_teams`、`team_api_keys`、`addons`、`volumes`、`envs`、`snapshots`、`env_builds`(无 FK)、`active_template_builds`

**典型查询**:

按 slug 解析团队(`queries/teams/resolve_team.sql`):
```sql
SELECT t.id, t.slug
FROM public.teams t
JOIN public.users_teams ut ON ut.team_id = t.id
WHERE ut.user_id = $1 AND t.slug = $2;
```

**代码入口**:
- 读:几乎所有 API handler 通过 `auth.MustGetTeamInfo(c)` 拿到 `teamInfo`(含 tier、limits)
- 写:注册流(`POST /users`)在事务里建 team + 关联 owner;`is_banned`、`blocked_reason` 由管理员后台改

**业务约定**:
- 一个 user 至少有一个"默认团队"(`users_teams.is_default = true` 由 partial UNIQUE 索引强制)
- team 删除:**不允许**——所有 FK 都是 NO ACTION/CASCADE,删除会级联砍掉所有模板/快照
- `cluster_id` 仅 enterprise 客户设置(单租户专属集群)

---

### `users_teams`

- **Schema**:`public`
- **来源**:`20231124185944_create_schemas_and_tables.sql`(2026-03 重构为 UUID PK)
- **角色**:user ↔ team 多对多,带"加入者"与"默认团队"语义

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `uuid_id` | uuid PK DEFAULT gen_random_uuid()(`20260316120000` 加) | 当前主键 |
| `id` | bigint GENERATED BY DEFAULT AS IDENTITY | **历史 PK,现已非主键但列仍保留** |
| `user_id` | uuid NOT NULL | FK → `public.users(id)` |
| `team_id` | uuid NOT NULL | FK → `teams(id)` |
| `is_default` | boolean NOT NULL DEFAULT false | 是否为该用户的默认团队 |
| `added_by` | uuid(`20241206124325` 加,可空) | FK → `public.users(id)`,谁邀请的 |
| `created_at` | timestamptz NOT NULL DEFAULT now()(`20250522105042` 加) | 加入时间 |

**外键**:
- `user_id → public.users(id) CASCADE`
- `team_id → teams(id) CASCADE`
- `added_by → public.users(id) SET NULL`

**索引**:
- `usersteams_team_id_user_id (team_id, user_id)` UNIQUE
- `users_teams_user_id_is_default_idx (user_id) WHERE is_default = true` UNIQUE partial — 每用户仅一个默认团队
- `idx_teams_user_teams (team_id)`、`idx_users_user_teams (user_id)`
- `users_teams_uuid_id_idx (uuid_id)`(由 PK using index 提供)

**典型查询**(`queries/teams/team_members.sql`):

```sql
-- 列成员
-- name: GetTeamMembers :many
SELECT ut.user_id, ut.team_id, ut.is_default, ut.added_by, ut.created_at
FROM public.users_teams ut
WHERE ut.team_id = $1;

-- 加锁成员列表(用于团队级配额变更时防并发)
-- name: LockTeamMembersForUpdate :many
SELECT user_id FROM public.users_teams
WHERE team_id = $1
FOR UPDATE;
```

**代码入口**:
- 读:`GET /teams/{id}/members` → `team_members.sql`
- 写:`POST /teams/{id}/members` (`AddTeamMember`)/ `DELETE /teams/{id}/members/{user}` (`RemoveTeamMember`)

**ID 历史包袱**:`id`(bigint IDENTITY)是早期主键,2026-03 切到 UUID 主键后**列仍保留**——因为 `env_builds.created_by` 等历史 FK 还可能引用 bigint。新代码必须用 `uuid_id`。

---

## 4. 凭据与令牌簇

> **演进要点**:`team_api_keys` 与 `access_tokens` 在 2025-08~09 完成"明文键 → hash 化"重构。原 `api_key` / `access_token` 列在 `20250910124212_remove_raw_keys.sql` 中彻底 DROP。

### `team_api_keys`

- **Schema**:`public`
- **角色**:团队级 API 密钥

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid()(`20241121225404` 加) | 内部主键 |
| `api_key_hash` | text UNIQUE(`20250211160814` 加) | 服务端校验用单向 hash |
| `api_key_prefix` | varchar(10)(`20250606204750` 加) | key 前缀(如 `e2b_`)用于快速识别 |
| `api_key_length` | integer(`20250606204750` 加) | 长度校验(防御性) |
| `api_key_mask_prefix` | varchar(5)(`20250606204750` 加) | UI 展示用前几位 |
| `api_key_mask_suffix` | varchar(5)(`20250606204750` 加) | UI 展示用后几位 |
| `team_id` | uuid NOT NULL | FK → `teams(id)` |
| `created_at` | timestamptz DEFAULT now() | 创建时间 |
| `updated_at` | timestamptz(`20241120222814` 加) | 最近修改时间 |
| `name` | text NOT NULL DEFAULT 'Unnamed API Key'(同上) | UI 显示用名称 |
| `last_used` | timestamptz NULL(同上) | 最近使用时间(审计/清理) |
| `created_by` | uuid NULL(同上) | FK → `public.users(id)`,创建者 |

> **已删除字段**:`api_key`(原明文,`20250910124212` DROP)、`api_key_mask`(`20250825102900` DROP,被 prefix+suffix 取代)

**外键**:
- `team_id → teams(id) CASCADE`
- `created_by → public.users(id) SET NULL`

**索引**:
- `idx_team_team_api_keys (team_id)` — 按团队列出
- `idx_team_api_keys_api_key_hash (api_key_hash)` UNIQUE — 登录时 hash 查找

**典型查询**:
- 鉴权:API middleware 收到 `Authorization: Bearer e2b_xxx`,先 SHA-256 hash 该 key,再 `SELECT * FROM team_api_keys WHERE api_key_hash = $1`
- 列表:`SELECT * FROM team_api_keys WHERE team_id = $1 ORDER BY created_at DESC`
- `last_used` 更新:每次鉴权成功后 best-effort UPDATE(异步,不阻塞请求)

**代码入口**:
- 读/鉴权:`packages/api/internal/auth/api_key.go`
- 写:`POST /teams/{id}/api-keys` / `DELETE /teams/{id}/api-keys/{key_id}`

**安全约束**:
- `api_key_hash` 不允许 COLLATION(纯 ASCII),避免排序性能问题
- 创建时返回明文 key 一次,**之后再也读不到**

---

### `access_tokens`

- **Schema**:`public`
- **角色**:用户级访问令牌

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid NOT NULL DEFAULT gen_random_uuid()(`20250211160814` 加,`20250910072612` 改为 NOT NULL) | 内部主键 |
| `access_token_hash` | text UNIQUE(`20250211160814` 加) | 服务端校验用单向 hash |
| `access_token_prefix` | varchar(10)(`20250606204750` 加) | 识别前缀 |
| `access_token_length` | integer(`20250606204750` 加) | 长度校验 |
| `access_token_mask_prefix` | varchar(5)(同上) | UI 展示用前几位 |
| `access_token_mask_suffix` | varchar(5)(同上) | UI 展示用后几位 |
| `user_id` | uuid NOT NULL | FK → `public.users(id)` |
| `created_at` | timestamptz DEFAULT now() | 创建时间 |
| `name` | text NOT NULL DEFAULT 'Unnamed Access Token'(`20250211160814` 加) | UI 显示用名称 |

> **已删除字段**:`access_token`(原明文,`20250910124212` DROP)、`access_token_mask`(`20250825102900` DROP)

**外键**:`user_id → public.users(id) CASCADE`
**索引**:
- `idx_users_access_tokens (user_id)` — 按用户列出
- `idx_access_tokens_access_token_hash (access_token_hash)` UNIQUE — 校验查找

> **凭据设计模式**:`*_hash` 做服务端校验,`*_prefix` / `*_mask_prefix` / `*_mask_suffix` 让 UI 还能展示 `e2b_abc...xyz` 而不暴露真实 key。

**典型查询 / 代码入口**:
- 鉴权路径同 `team_api_keys`(hash 查找),但归属是 user 而非 team
- 写:`POST /users/{user_id}/access-tokens`(用户个人 token,与团队 key 并存)

---

## 5. 模板与构建簇

### `envs`

- **Schema**:`public`
- **角色**:**模板/沙箱的统一实体**——一个 env 既是模板定义也是可启动的沙箱

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | text PK | 模板 ID(如 `abc123`),业务可见 |
| `created_at` | timestamptz DEFAULT now() | 创建时间 |
| `updated_at` | timestamptz NOT NULL | 最近修改时间 |
| `public` | boolean DEFAULT false | 是否公开可被其他团队发现 |
| `build_count` | int DEFAULT 1 | 累计构建次数 |
| `spawn_count` | bigint DEFAULT 0 | 累计启动次数 |
| `last_spawned_at` | timestamptz NULL | 最近一次启动时间 |
| `team_id` | uuid NOT NULL | FK → `teams(id)`,归属团队 |
| `created_by` | uuid(`20241127174604` 加,可空) | FK → `public.users(id)`,创建者 |
| `cluster_id` | uuid(`20250624001048` 加,可空) | FK → `clusters(id)` 专属集群 |
| `source` | text NOT NULL DEFAULT 'template'(`20260210120001` 加) | `'template'` 或 `'snapshot'`,来源类型 |
| `deleted_at` | timestamptz NULL(`20260628120000` 加) | 软删除标记 |

> **已删除字段**(全部 `20240315165236` 移到 `env_builds`):`dockerfile`、`build_id`、`vcpu`、`ram_mb`、`free_disk_size_mb`、`total_disk_size_mb`、`kernel_version`、`firecracker_version`

**外键**:
- `team_id → teams(id) ON UPDATE NO ACTION ON DELETE NO ACTION`
- `created_by → public.users(id) SET NULL`
- `cluster_id → clusters(id)`

**被引用**(共 6 个,均 CASCADE):
- `env_aliases.env_id`
- `env_build_assignments.env_id`
- `snapshot_templates.env_id`(同时是 PK)
- `snapshots.env_id` 与 `snapshots.base_env_id`
- `active_template_builds.template_id`

**索引**:
- `idx_envs_team_id_source (team_id, source)`(`20260216120000` 加,同时 DROP 旧的 `idx_teams_envs`)
- `idx_envs_team_source_created_at (team_id, source, created_at DESC, id DESC)`(`20260603120000` 加) — 团队模板翻页
- `idx_envs_team_updated_at_templates (team_id, updated_at DESC, id DESC) WHERE source = 'template'`(`20260612120000` 加) partial

**视图**:见 [`active_envs`](#视图-active_envs)

**典型查询**:

按 ID 取模板(`queries/templates/get_template.sql`):
```sql
-- name: GetTemplateById :one
SELECT e.id, e.team_id, e.public, e.cluster_id
FROM public.active_envs AS e
WHERE e.id = @template_id
  AND e.source IN ('template', 'snapshot_template');
```

> 注意所有读路径都用 `active_envs` 视图而非 `envs` 直接读,自动跳过软删除。

**关键写操作**:

upsert 模板(每次新 build 时调用,`queries/templates/create_template.sql`):
```sql
-- name: CreateOrUpdateTemplate :one
INSERT INTO envs(id, team_id, created_by, updated_at, public, cluster_id, source)
VALUES (@template_id, @team_id, @created_by, NOW(), FALSE, @cluster_id, 'template')
ON CONFLICT (id) DO UPDATE
SET updated_at = NOW(), build_count = envs.build_count + 1
WHERE envs.deleted_at IS NULL    -- 软删除后不允许"复活"
RETURNING id;
```

软删除(两步事务,`delete_template.sql`):
1. `SoftDeleteTemplate` UPDATE 设 `deleted_at = NOW()`(锁定行,阻止并发 build)
2. `ReleaseTemplateAliases` DELETE 别名(让名字可重用,并返回 alias key 给缓存失效)
3. `DeleteActiveTemplateBuilds` DELETE 在途 build 记录(避免 zombie 计配额)

**代码入口**:
- 读:`GET /templates`、`GET /templates/{id}` → `get_team_templates.sql` / `get_template.sql`
- 写:`POST /templates`(create/build)、`DELETE /templates/{id}`(软删)

---

### `env_aliases`

- **Schema**:`public`
- **角色**:env 的可读别名(如 `my-template`),支持多命名空间

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK(`20260127120000` 切到 UUID) | 内部主键 |
| `alias` | text NOT NULL | 别名字符串 |
| `is_renamable` | boolean NOT NULL DEFAULT true(`20240315165236` 由 `is_name` 改名) | 是否允许用户改名 |
| `env_id` | text NOT NULL(`20240315165236` 设为 NOT NULL) | FK → `envs(id)` |
| `namespace` | text(`20260121175430` 加) | 命名空间;`NULL` 表示"被推广的公共模板" |

**外键**:`env_id → envs(id) ON DELETE CASCADE`
**唯一约束**:`idx_env_aliases_alias_namespace_unique (alias, namespace) NULLS NOT DISTINCT` — 同 namespace 下唯一

**命名空间语义**:
- `namespace = NULL`:被推广的公共模板(`20260129105527` 数据回填)
- `namespace = '<team_slug>'`:团队私有别名

**典型查询**(`queries/template_aliases/check_alias_exists.sql`):

按 alias 检查是否与现有 env ID 冲突(template build 时避免重名):
```sql
-- name: CheckAliasConflictsWithTemplateID :one
SELECT EXISTS(
    -- envs, not active_envs: an id stays reserved while its env row exists
    -- (even soft-deleted), so an alias must not shadow it.
    SELECT 1
    FROM "public"."envs"
    WHERE id = @alias
);

-- name: CheckAliasExistsInNamespace :one
SELECT *
FROM "public"."env_aliases"
WHERE alias = @alias
  AND namespace IS NOT DISTINCT FROM sqlc.narg(namespace)::text;
```

**代码入口**:
- 读:`templateCache.ResolveAlias()`(API 启动 + 缓存失效后回填)
- 写:`CreateTemplateAlias`(在 checkpoint 流程内,见 `snapshot_template.go:191`);`ReleaseTemplateAliases`(软删 env 时)

**唯一约束细节**:`NULLS NOT DISTINCT` 是 PostgreSQL 15+ 特性,使 `(alias='x', namespace=NULL)` 与另一行 `(alias='x', namespace=NULL)` 视为相同(默认 NULL ≠ NULL 会留漏洞)。

---

### `env_builds`

- **Schema**:`public`
- **来源**:`20240315165236_create_env_builds.sql`
- **角色**:env 的具体构建产物,记录每次构建的完整配置

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | build ID |
| `created_at` | timestamptz DEFAULT now() | 开始构建时间 |
| `updated_at` | timestamptz NOT NULL | 状态变更时间 |
| `finished_at` | timestamptz NULL | 完成(成功/失败)时间 |
| `status` | text NOT NULL DEFAULT 'waiting' | 状态枚举:`waiting` / `pending` / `building` / `in_progress` / `snapshotting` / `ready` / `uploaded` / `success` / `error` 等 |
| `status_group` | text(`20260210120002` 加) | 派生字段,由触发器维护:`'pending'` / `'in_progress'` / `'ready'` / `'failed'` |
| `dockerfile` | text NULL | 构建用的 Dockerfile 内容 |
| `start_cmd` | text NULL | 容器启动命令 |
| `vcpu` | bigint NOT NULL | CPU 核数 |
| `ram_mb` | bigint NOT NULL | 内存(MB) |
| `free_disk_size_mb` | bigint NOT NULL | 可用磁盘 |
| `total_disk_size_mb` | bigint NULL | 总磁盘 |
| `kernel_version` | text NOT NULL DEFAULT 'vmlinux-5.10.186' | 使用的 Linux 内核版本 |
| `firecracker_version` | text NOT NULL DEFAULT 'v1.7.0-dev_8bb88311' | Firecracker microVM 版本 |
| `envd_version` | text NULL(`20240625095352` 加) | Envd 守护进程版本 |
| `ready_cmd` | text(`20250528203546` 加) | 就绪探针命令 |
| `env_id` | text NULL(**无 FK**;`20260204172712` 中 DROP FK 并允许 NULL) | 第一个分配的 env,由 `env_build_assignments` 触发器回填 |
| `team_id` | uuid(`20260218120000` 加,无 FK) | 同上,从 assignments 回填 |
| `reason` | jsonb(`20250624232413` 加 → `20250815181502` 改为 jsonb) | 构建原因 metadata |
| `version` | text(`20251018100653` 加) | 业务层版本号 |
| `cpu_architecture` | text NULL(`20251127000000` 加) | CPU 架构(`x86_64` / `arm64`) |
| `cpu_family` | text NULL(同上) | CPU family 字符串 |
| `cpu_model` | text NULL(同上) | CPU model 字符串 |
| `cpu_model_name` | text NULL(同上) | CPU 显示名 |
| `cpu_flags` | text[] NULL(同上) | CPU 特性 flag 数组 |
| `cluster_node_id` | uuid(`20250624001049` 加 → `20250824185633` 设为 NOT NULL → `20251121101953` 改回可空) | 实际跑构建的 orchestrator 节点 |

**触发器**:`trg_compute_status_group`(BEFORE INSERT OR UPDATE OF `status`) — 根据 status 自动派生 status_group,值映射:
- `pending`/`waiting` → `'pending'`
- `in_progress`/`building`/`snapshotting` → `'in_progress'`
- `ready`/`uploaded`/`success` → `'ready'`
- 其他 → `'failed'`

**索引**(针对分页与状态查询优化):
- `idx_env_builds_status (status)`(`20250506112836`)
- `idx_env_builds_status_group (status_group)`(`20260210120002`)
- `idx_env_builds_team_status_pagination (team_id, created_at DESC, id DESC) INCLUDE (status, status_group)`(`20260218120000`) — **覆盖索引**专门服务翻页
- `idx_env_builds_team_env_created_id (team_id, env_id, created_at DESC, id DESC)`(同上)
- `idx_env_builds_team_status_group (team_id, status_group)`(`20260225120000`)
- `idx_env_builds_team_active (team_id) WHERE status_group IN ('pending','in_progress')`(`20260305120000`) partial — "我们团队现在有几个 build 在跑"
- `idx_env_builds_created_at (created_at DESC)`(`20260210120000` 重新加) — 全局扫描
- `idx_env_builds_id_covering (id) INCLUDE (status_group, created_at, finished_at)`(`20260612140000`) — dashboard 模板 tag 查询 index-only

> **已删除索引**:`idx_env_builds_env_status_created`(`20260204172712` 中 DROP)、原 `idx_env_builds_created_at`(`20251218160000` 中临时加,`20260218120000` 中又 DROP,但 `20260210120000` 在中间重新加回)

**典型查询**:

(1) 团队构建列表翻页(`queries/builds/get_builds_paginated.sql`):
```sql
SELECT b.id, b.status_group, b.reason, b.created_at, b.finished_at,
       b.vcpu, b.ram_mb, b.total_disk_size_mb, b.envd_version,
       eba.env_id AS template_id, COALESCE(ea.alias, '') AS template_alias
FROM public.env_builds b
JOIN LATERAL (
    SELECT a.env_id FROM public.env_build_assignments a
    JOIN public.active_envs e ON e.id = a.env_id
    WHERE a.build_id = b.id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 1
) eba ON TRUE
LEFT JOIN LATERAL (
    SELECT x.alias FROM public.env_aliases x
    WHERE x.env_id = eba.env_id
    ORDER BY x.alias ASC LIMIT 1
) ea ON TRUE
WHERE b.team_id = $1
  AND (b.created_at, b.id) < ($2, $3)         -- 游标
  AND b.status_group = ANY($4::text[])         -- 可按状态过滤
ORDER BY b.created_at DESC, b.id DESC
LIMIT $5;
```

> `JOIN LATERAL ... LIMIT 1` 解决了一个 build 可能被分配给多个 env 的多对多语义——只展示最新分配的 env。这就是为什么 `idx_env_builds_team_status_pagination` 是**覆盖索引**:`team_id, created_at DESC, id DESC` 是 ORDER BY + 游标,`INCLUDE (status, status_group)` 让过滤也能 index-only。

(2) 并发构建配额检查(`queries/builds/get_concurrent_template_builds.sql`):
```sql
-- name: GetConcurrentTemplateBuilds :many
SELECT DISTINCT eb.* FROM env_build_assignments eba
JOIN env_builds eb ON eb.id = eba.build_id
WHERE eba.env_id = @template_id
  AND eb.status_group IN ('pending', 'in_progress')
  AND eb.id != @current_build_id
  AND eba.tag IN (
      SELECT tag FROM env_build_assignments
      WHERE build_id = @current_build_id AND env_id = @template_id
  );
```

> 这条查询用于"同 template 同 tag 不能并发构建"约束。结合 `tiers.concurrent_template_builds`(团队级总并发)双层把关。

**关键写操作**:

```sql
-- name: CreateTemplateBuild :exec
INSERT INTO env_builds (id, status, ram_mb, vcpu, kernel_version,
                        firecracker_version, free_disk_size_mb,
                        start_cmd, ready_cmd, dockerfile, version)
VALUES (@build_id, @status, @ram_mb, @vcpu, ...);

-- name: FailTemplateBuildAndDeactivate :exec
WITH deactivated AS (
    DELETE FROM active_template_builds WHERE build_id = @build_id
)
UPDATE env_builds SET status = @status, finished_at = @finished_at, reason = @reason
WHERE id = @build_id;
```

**状态转换**(实际语义):
```
waiting ──资源分配──→ pending ──template-manager 取走──→ building
                                                    │
                                                    ▼
                                                in_progress(orchestrator 导出)
                                                    │
                                              ┌─────┴──────┐
                                              ▼            ▼
                                            ready       snapshotting
                                              │            │
                                              ▼            ▼
                                           success     uploaded(=checkpoint 终态)

任意状态 ──失败──→ error / failed
```

**代码入口**:
- 写:`packages/api/internal/orchestrator/...`(create build / update status);`packages/orchestrator/pkg/server/...`(build 完成时 FinishTemplateBuild)
- 读:`GET /builds`(团队列表)、`GET /templates/{id}/builds`(单模板列表)

---

### `env_build_assignments`

- **Schema**:`public`
- **来源**:`20251218160000_allow_m_n_builds_with_tags.sql`
- **角色**:env ↔ build 的多对多关系表(支持一个 build 被多个 env 引用,带 tag 维度)

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | 内部主键 |
| `env_id` | text NOT NULL | FK → `envs(id)` |
| `build_id` | uuid NOT NULL | FK → `env_builds(id)` |
| `tag` | text NOT NULL | 业务层 tag(默认 `'default'`,可指定如 `latest`、`stable`) |
| `source` | text NOT NULL DEFAULT 'app' | `'app'` / `'trigger'` / `'migration'`,数据来源 |
| `created_at` | timestamptz DEFAULT now() | 分配时间 |

**外键**:
- `env_id → envs(id) CASCADE`
- `build_id → env_builds(id) CASCADE`

**唯一约束**:`uq_legacy_assignments (env_id, build_id, tag) WHERE source IN ('trigger','migration')` partial UNIQUE — 只对历史/触发器数据强制唯一,新 'app' 数据无强制约束

**触发器**:
- `trigger_backfill_env_id`(AFTER INSERT,`20260204172712` 加) — 把 `env_builds.env_id` 设为该 build 第一次被分配的 env
- `trigger_backfill_team_id`(AFTER INSERT,`20260218120000` 加) — 同理回填 `env_builds.team_id`

> **已删除触发器**(均在 `20260204172712_remove_build_assignment_triggers.sql` 中删除):
> - `trigger_validate_assignment_source`(原 BEFORE INSERT)
> - `trigger_sync_env_build_assignment`(原在 `env_builds` 表 AFTER INSERT/UPDATE)

**索引**:
- `idx_env_build_assignments_env_tag_created (env_id, tag, created_at DESC)`
- `idx_env_build_assignments_build (build_id)`(`20251218170000` 加)
- 原 `idx_env_build_assignments_env_build (env_id, build_id)` 已被 DROP(`20251218170000` 中,认为被上面两个覆盖)

**典型查询**(`queries/templates/get_template_with_build_by_tag.sql`):

按 tag 解析"模板 + 最新 build"(sandbox 启动时核心查询):
```sql
-- name: GetTemplateWithBuildByTag :one
SELECT sqlc.embed(e), sqlc.embed(eb), aliases, names
FROM public.active_envs AS e
JOIN public.env_build_assignments AS eba ON eba.env_id = e.id
    AND (eba.tag = COALESCE(@tag, 'default')        -- 默认 tag
         OR eba.build_id = try_cast_uuid(@tag))      -- 也允许用 build_id 当作 tag
JOIN public.env_builds AS eb ON eb.id = eba.build_id
    AND eb.status_group = 'ready'                    -- 只取可用的 build
CROSS JOIN LATERAL (
    SELECT array_agg(alias)::text[] AS aliases, ...
    FROM public.env_aliases WHERE env_id = e.id
) AS al
WHERE e.id = @template_id
  AND e.source IN ('template', 'snapshot_template')
ORDER BY eba.created_at DESC LIMIT 1;
```

**写入语义**:
- 每次 build 完成 → `CreateTemplateBuildAssignment(env_id, build_id, tag)`
- 同 (env, tag) 可以有多条记录——查询时按 `created_at DESC` 取最新
- **唯一约束仅覆盖历史数据**:`uq_legacy_assignments WHERE source IN ('trigger','migration')` — 新 `app` 数据允许重复(因为 tag 可以重用)

**代码入口**:
- 写:`snapshot_template.go:155` (`CreateTemplateBuildAssignment` — checkpoint 复用已有 template 时)、`snapshot_template.go:184` (`CreateSnapshotTemplateEnv` 内部也会写)
- 读:所有"按 tag 取 build"的路径(sandbox create / resume / pause)

---

### `active_template_builds`

- **Schema**:`public`
- **来源**:`20260305130000_create_active_template_builds.sql`
- **角色**:跟踪"团队当前正在构建中的 build 集合",用于 `tiers.concurrent_template_builds` 配额检查

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `build_id` | uuid PK | build ID(无显式 FK) |
| `team_id` | uuid | 归属团队 |
| `template_id` | text | FK → `envs(id)`,模板 |
| `tags` | text[] | 该次构建涉及的 tag 集合 |
| `created_at` | timestamptz DEFAULT now() | 构建开始时间 |

**外键**:`template_id → envs(id) CASCADE`(`20260413120000` 加)

**索引**:
- `idx_active_template_builds_team_created_at (team_id, created_at DESC)` — 配额计数
- `idx_active_template_builds_template_id (template_id)` — 按模板查活跃构建

**典型查询**(`queries/builds/get_inprogress_builds.sql`):

```sql
-- name: GetInprogressBuilds :many
SELECT build_id, team_id, template_id, tags, created_at
FROM active_template_builds
WHERE team_id = $1
ORDER BY created_at DESC;
```

应用层读这张表 → count → 与 `team_limits.concurrent_template_builds` 比较,超了就拒绝新 build。

**生命周期**:
- INSERT:build 进入 `pending`/`building` 状态时
- DELETE:build 进 `ready`/`failed` 终态时(由 `FailTemplateBuildAndDeactivate` 或 `FinishTemplateBuild` 触发)
- env 软删时:`DeleteActiveTemplateBuilds`(避免 zombie 计配额)

**为什么没有 FK 到 env_builds**:历史决策,允许 build 失败后单独清理 `env_builds`,而不必级联到这张"配额计数表"。

---

## 6. 沙箱与快照簇

### `snapshots`

- **Schema**:`public`
- **来源**:`20241213142106_create_snapshots.sql`
- **角色**:沙箱暂停时持久化的运行时状态(auto-pause 场景)

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | 快照 ID |
| `created_at` | timestamptz NULL | 创建时间 |
| `env_id` | **text** NOT NULL | FK → `envs(id)`,产生快照的 env |
| `base_env_id` | **text** NOT NULL | FK → `envs(id)`,父 env(模板) |
| `sandbox_id` | text NOT NULL UNIQUE | 对应的 sandbox ID |
| `sandbox_started_at` | timestamptz(`20250404151700` 加) | 沙箱启动时间 |
| `metadata` | jsonb NOT NULL DEFAULT '{}'::jsonb(`20260310` 设为 NOT NULL) | 用户自定义 KV |
| `env_secure` | boolean(`20250409113306` 加) | 是否禁用 envd 通信安全 |
| `origin_node_id` | uuid(`20250708135401` 加) | 创建快照的 orchestrator 节点 |
| `allow_internet_access` | boolean(`20250728135400` 加) | 网络出口策略 |
| `auto_pause` | boolean(`20250818114512` 加) | 是否由自动暂停触发 |
| `team_id` | uuid NOT NULL(`20250923094021` 加 → `20250923103614` 设为 NOT NULL) | FK → `teams(id)` |
| `config` | jsonb NULL(`20251106172810` 加) | sandbox 重启配置 |

**外键**:
- `env_id → envs(id) CASCADE`(`20250206105106` 加)
- `base_env_id → envs(id) CASCADE`(同上)
- `team_id → teams(id) ON UPDATE NO ACTION ON DELETE NO ACTION`(`20250923094021` 加)

**触发器**:
- `trg_sync_env_source_on_snapshot`(AFTER INSERT,`20260210120001` 加) — 父 env 标记 `source = 'snapshot'`
- `trg_snapshots_fix_json_null_metadata`(BEFORE INSERT OR UPDATE OF metadata,`20260310` 加) — SQL NULL / JSON `null` 都规整为 `'{}'::jsonb`

**索引**:
- `snapshots_sandbox_id_unique (sandbox_id)` UNIQUE(原 `idx_snapshots_sandbox_id` 普通索引已被 unique 替代)
- `idx_snapshots_team_time_id (team_id, sandbox_started_at DESC, sandbox_id)`(`20250923103546` 加) — 团队快照列表游标翻页
- `idx_snapshots_env_id (env_id)`(`20251030130958` 加)
- `snapshots_base_env_id_idx (base_env_id)`(`20251216135834` 加)
- `idx_snapshots_team_metadata_gin (team_id, metadata) USING GIN`(`20260310` 加,依赖 `btree_gin` 扩展) — 按 metadata KV 过滤

**`env_id` vs `base_env_id`(关键区分)**:

| 字段 | 含义 | 何时设置 |
| --- | --- | --- |
| `env_id` | **本快照自己挂靠的 env**(随快照创建,`source='snapshot'`) | 首次 pause 时由 `UpsertSnapshot` CTE 创建 |
| `base_env_id` | **原 sandbox 用的模板 env** | 每次 pause 都更新(始终是父模板) |

例:用户用 template T1 启动 sandbox S,然后 pause:
- `envs` 多了一行 `E_snap (source='snapshot')`
- `snapshots` 一行:`{sandbox_id: S, env_id: E_snap, base_env_id: T1}`

之后 resume S 再 pause,`env_id` 不变(还是 `E_snap`),`base_env_id` 也不变(还是 T1)。

**`config` jsonb 结构**(完整 sandbox 重启所需上下文,Go 类型 `PausedSandboxConfig`):

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `Version` | int | schema 版本(当前 = 1) |
| `Network` | `SandboxNetworkConfig` | 网络配置(ingress 规则等) |
| `AutoResume` | `SandboxAutoResumeConfig` | auto-resume 策略;`{Policy:"any"}` 表示允许 |
| `VolumeMounts` | `[]SandboxVolumeMountConfig` | 挂载卷定义 |
| `FilesystemOnly` | bool | 是否 fs-only pause(无 memfile) |
| `AutoPauseFilesystemOnly` | bool | 后续 auto-pause 是否降级为 fs-only |

> Go 端类型在 `packages/db/pkg/types/types.go`:`PausedSandboxConfig` / `SandboxAutoResumeConfig` / `SandboxNetworkConfig`。

**典型查询**:

(1) 取最近一次快照(resume 时核心查询,`queries/snapshots/get_last_snapshot.sql`):

```sql
SELECT COALESCE(ea.aliases, ARRAY[]::text[]) AS aliases,
       COALESCE(ea.names, ARRAY[]::text[]) AS names,
       sqlc.embed(s), sqlc.embed(eb)
FROM snapshots s
JOIN active_envs e ON e.id = s.env_id           -- 跳过软删 env
JOIN LATERAL (
    -- 取 status_group='ready' 的最新 default-tag build
    SELECT eba.build_id FROM env_build_assignments eba
    JOIN env_builds eb ON eb.id = eba.build_id AND eb.status_group = 'ready'
    WHERE eba.env_id = s.env_id AND eba.tag = 'default'
    ORDER BY eba.created_at DESC LIMIT 1
) latest_eba ON TRUE
JOIN env_builds eb ON eb.id = latest_eba.build_id
LEFT JOIN LATERAL (
    -- 聚合 base_env 的所有 alias
    SELECT ARRAY_AGG(alias ORDER BY alias) AS aliases, ...
    FROM env_aliases WHERE env_id = s.base_env_id
) ea ON TRUE
WHERE s.sandbox_id = $1;
```

> 这条查询的 JOIN 设计:1) 跳软删 env;2) 强制取 ready build(失败 build 不能 resume);3) 用 `base_env_id` 聚合 alias(因为快照的 `env_id` 是临时 env,alias 还挂在父模板上)。

(2) Kill 时的级联清理(`queries/snapshots/get_snapshot_builds.sql`):

```sql
SELECT s.env_id AS template_id,
       eb.id AS build_id,
       eb.cluster_node_id AS build_cluster_node_id
FROM snapshots s
JOIN active_envs e ON e.id = s.env_id
LEFT JOIN env_build_assignments eba ON eba.env_id = s.env_id AND eba.tag = 'default'
LEFT JOIN env_builds eb ON eb.id = eba.build_id
WHERE s.sandbox_id = @sandbox_id AND s.team_id = @team_id;
```

> 用 LEFT JOIN:即使 build 已被清理(NULL build_id),仍要拿到 `template_id` 去做 softDeleteTemplate。

**代码入口**:
- 写:`pause_instance.go:32` 的 `pauseSandbox` → `throttledUpsertSnapshot` → `UpsertSnapshot`
- 读:`snapshotsCache.Get(sandboxID)`(Redis 缓存,miss 后回 DB 走 `GetLastSnapshot`)
- 失效:每次 pause/checkpoint/kill 后 `snapshotCache.Invalidate(sandboxID)`

---

### `snapshot_templates`

- **Schema**:`public`
- **来源**:`20260211120000_add_snapshot_templates.sql`
- **角色**:把"快照"提升为可被 spawn 的"快照模板"(envs.source='snapshot' 的子集)

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `env_id` | text PK + FK | 对应的 env(同时是主键) |
| `sandbox_id` | text | 源 sandbox ID |
| `created_at` | timestamptz DEFAULT now() | 提升为模板的时间 |
| `origin_node_id` | uuid(`20260228120000` 加) | 提供快照数据的节点 |
| `build_id` | uuid | 关联的 env_builds ID |

**外键**:`env_id → envs(id) ON DELETE CASCADE`
**索引**:`idx_snapshot_templates_sandbox_id (sandbox_id)`

**典型查询**(列表过滤,`queries/snapshots/list_team_snapshot_templates.sql`):

```sql
WHERE e.team_id = @team_id
  AND e.source = 'snapshot_template'                     -- 只列快照模板
  AND (@sandbox_id IS NULL OR st.sandbox_id = @sandbox_id)
  AND (@env_id IS NULL OR e.id = @env_id)
  AND (e.created_at, e.id) < (@cursor_time, @cursor_id)
ORDER BY e.created_at DESC, e.id DESC
LIMIT @page_limit
```

**业务约定**:
- `env_id` 既是 PK 又是 FK——一一行只为每个 snapshot_template env 存在
- 创建路径:`CreateSnapshotTemplateEnv` 把 `envs` 表插入 `source='snapshot_template'` 的 env 后,本表自动跟进
- 删除路径:用户 DELETE 模板时,本表随 envs CASCADE 自动清理

**与 `snapshots` 表的区别**:
- `snapshots`:每个 sandbox 至多一行(描述 sandbox 当前/最近一次 pause 状态)
- `snapshot_templates`:每个**提升为模板**的快照 env 一行(描述可被反复 spawn 的快照模板)

**代码入口**:
- 写:`snapshot_template.go:176` `CreateSnapshotTemplateEnv`(checkpoint 流程中,新建模板时)
- 读:`GET /snapshots` → `ListTeamSnapshotTemplates`(分页 + sandbox_id/name 过滤)

---

## 7. 容量与基础设施簇

### `clusters`

- **Schema**:`public`
- **来源**:`20250606213446_deployment_cluster.sql`
- **角色**:编排集群(orchestrator 池)注册表

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK | 集群 ID |
| `endpoint` | text | orchestrator API 入口 |
| `endpoint_tls` | BOOLEAN NOT NULL DEFAULT TRUE | orchestrator endpoint 是否启用 TLS |
| `token` | text | 集群访问令牌 |
| `sandbox_proxy_domain` | text(`20250714132924` 加) | sandbox 流量代理域名 |
| `auth_org_id` | text(`20260423170000` 加) | OIDC 组织 ID |
| `name` | text NOT NULL(`20260609120000` 加,默认 '' 后 DROP DEFAULT) | 集群显示名 |

**唯一约束**:`clusters_auth_org_id_idx (auth_org_id) WHERE auth_org_id IS NOT NULL` partial UNIQUE
**被引用**:`teams.cluster_id`(可选)、`envs.cluster_id`(可选)

**典型查询**(`queries/get_active_clusters.sql`):

```sql
-- name: GetActiveClusters :many
SELECT DISTINCT sqlc.embed(c)
FROM public.clusters c
JOIN public.teams t ON t.cluster_id = c.id;
```

**业务约定**:
- 启动时 API 通过此查询加载集群列表,在内存中维护 `clusterRegistry`
- `auth_org_id` 唯一性确保一个 OIDC 组织只能映射到一个集群
- 路由 sandbox 时:先看 `envs.cluster_id` → 没有就看 `teams.cluster_id` → 否则默认集群

**代码入口**:
- 读:`packages/api/internal/orchestrator/nodemanager/cluster_registry.go`
- 写:**手工/迁移管理**,运行时不直接写

---

### `volumes`

- **Schema**:`public`
- **来源**:`20260304120000_volumes.sql`
- **角色**:团队挂载卷(持久化存储)

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | 卷 ID |
| `team_id` | uuid NOT NULL | FK → `teams(id)` |
| `name` | varchar(250) NOT NULL | 卷名(团队内唯一) |
| `volume_type` | varchar(250) NOT NULL | 卷类型(如 `nfs` / `persistent`) |
| `created_at` | timestamptz DEFAULT now() | 创建时间 |

**外键**:`team_id → teams(id)`(默认 NO ACTION)
**唯一约束**:`volumes_teams_uq (team_id, name)` — 团队内卷名唯一

**典型查询**(`queries/volumes/volumes.sql`):

```sql
-- name: CreateVolume :one
INSERT INTO volumes (team_id, volume_type, name)
VALUES (@team_id, @volume_type, @name) RETURNING *;

-- name: GetVolumesByName :many   -- sandbox 启动前校验挂载卷存在
SELECT * FROM volumes WHERE team_id = @team_id AND name IN (SELECT UNNEST(@volume_names::text[]));

-- name: DeleteVolume :exec
DELETE FROM volumes WHERE team_id = @team_id AND id = @volume_id;
```

**业务约定**:
- `volume_type` 当前值:`'nfs'`(NFS 共享卷)/ `'persistent'`(持久卷);**实际值由代码常量决定**,DB 不约束
- 删除策略:`team_id → teams(id)` 是 NO ACTION(默认),要删 team 必须先删 volumes
- sandbox 挂载:启动时按 `Config.VolumeMounts[].Name` 在本表查 `GetVolumesByName`,缺失则启动失败

**代码入口**:
- 读写:`packages/api/internal/handlers/volumes.go`(CRUD handler)

---

### `addons`

- **Schema**:`public`
- **来源**:`20251011200438_create_addons_table.sql`
- **角色**:在 tier 基础上加购的额外配额(时段有效)

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | addon ID |
| `team_id` | uuid NOT NULL | FK → `teams(id)` |
| `name` | text NOT NULL | 配额包名 |
| `description` | text NULL | 描述 |
| `extra_concurrent_sandboxes` | bigint NOT NULL DEFAULT 0 | 额外并发 sandbox 数 |
| `extra_concurrent_template_builds` | bigint NOT NULL DEFAULT 0 | 额外并发构建数 |
| `extra_max_vcpu` | bigint NOT NULL DEFAULT 0 | 额外 CPU 配额 |
| `extra_max_ram_mb` | bigint NOT NULL DEFAULT 0 | 额外内存配额 |
| `extra_disk_mb` | bigint NOT NULL DEFAULT 0 | 额外磁盘配额 |
| `extra_events_ttl_days` | bigint NOT NULL DEFAULT 0(`20260702120000` 加) | 额外事件保留天数 |
| `valid_from` | timestamptz NOT NULL DEFAULT now() | 生效起始 |
| `valid_to` | timestamptz NULL | 生效结束(NULL = 永久) |
| `added_by` | uuid NOT NULL | FK → `public.users(id)`,谁加的 |
| `idempotency_key` | text(`20251026192416` 加) | 幂等创建 key |

**外键**:
- `team_id → teams(id) CASCADE`
- `added_by → public.users(id) ON UPDATE NO ACTION ON DELETE NO ACTION`

**CHECK**:`valid_to IS NULL OR valid_to > valid_from`、`extra_events_ttl_days >= 0`(由视图计算时 assumed)
**唯一约束**:`addons_idempotency_key_uidx (idempotency_key) WHERE idempotency_key IS NOT NULL` partial UNIQUE — 幂等创建保护
**索引**:`addons_team_id_idx (team_id)`

**典型查询**:不直接 SELECT addons,通过 `team_limits` 视图聚合。但**写入是显式的**:

```sql
-- 售卖侧写入:Stripe webhook 触发,带 idempotency_key 防重复扣款
INSERT INTO addons (team_id, name, extra_concurrent_sandboxes, extra_max_vcpu,
                    valid_from, valid_to, added_by, idempotency_key)
VALUES (...) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
```

**业务约定**:
- `valid_to IS NULL` = 永久;`valid_to > now()` = 仍在生效;`valid_to <= now()` = 历史已过期(数据保留以做审计)
- `extra_*` 字段都是 **加成**(在 tier 之上),不允许负数(CHECK 保证)
- 团队级 total = `tier.X + SUM(addons.extra_X WHERE valid)` 由视图自动算

**代码入口**:
- 写:billing/Stripe webhook handler;管理员后台
- 读:通过 `team_limits` 视图,所有 `auth.MustGetTeamInfo` 链路

---

### 视图 `team_limits`

- **来源**:`20251011200438_create_addons_table.sql`(经 `20260702120000` 更新)
- **角色**:聚合 `teams` + `tiers` + 当前有效 `addons`,暴露最终配额

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | uuid | 团队 ID(视图主键,实际为 `teams.id`) |
| `max_length_hours` | bigint | 单 sandbox 最长存活 = `tier.max_length_hours` |
| `concurrent_sandboxes` | bigint | 并发 sandbox = `tier.concurrent_instances + SUM(addons.extra_concurrent_sandboxes)` |
| `concurrent_template_builds` | bigint | 并发构建 = `tier.concurrent_template_builds + SUM(addons.extra_concurrent_template_builds)` |
| `max_vcpu` | bigint | CPU 总量 = `tier.max_vcpu + SUM(addons.extra_max_vcpu)` |
| `max_ram_mb` | bigint | 内存总量 = `tier.max_ram_mb + SUM(addons.extra_max_ram_mb)` |
| `disk_mb` | bigint | 磁盘 = `tier.disk_mb + SUM(addons.extra_disk_mb)` |
| `events_ttl_days` | bigint(`20260702120000` 加) | 事件保留天数 = `tier.events_ttl_days + SUM(addons.extra_events_ttl_days)` |

**addon 聚合条件**:`addon.valid_from <= now() AND (addon.valid_to IS NULL OR addon.valid_to > now())`
**特性**:`security_invoker=on` — 视图以调用者权限运行,避免越权查询其他团队配额

**典型查询**:几乎每个 API handler 间接命中——`auth.MustGetTeamInfo(c)` 返回的 `teamInfo.Limits` 就是这张视图的 row。例如:

```go
// Go 调用侧
if teamInfo.Limits.MaxLengthHours < requestedTimeoutHours { ... 拒绝 }
if currentSandboxes >= teamInfo.Limits.ConcurrentSandboxes { ... 拒绝 }
```

**演进**:每加一个 `tiers` 字段都要同步给 `addons.extra_*` 与本视图加同名列。`events_ttl_days` 是 2026-07 最后一次按这套模式加的(`20260702120000`)。

---

### 视图 `active_envs`

- **来源**:`20260628120000_add_env_deleted_at.sql`
- **角色**:`envs` 的软删除视图,过滤掉 `deleted_at IS NOT NULL` 的行

| 字段 | 作用 |
| --- | --- |
| `id`, `created_at`, `updated_at`, `public`, `build_count`, `spawn_count`, `last_spawned_at`, `team_id`, `created_by`, `cluster_id`, `source` | 与 `envs` 同名子集(不含 `deleted_at`) |

**WHERE 子句**:`deleted_at IS NULL`
**用途**:软删除场景下的规范读路径,调用方无需重复 `WHERE deleted_at IS NULL` 过滤

**重要**:任何读 `envs` 的查询都**应当**走 `active_envs`(否则可能读到已软删除的模板)。具体体现在:
- `GetTemplateById`、`GetTemplateByAlias`、`GetTemplateWithBuildByTag`、`GetLastSnapshot`、`GetTeamBuildsPage`、`ListTeamSnapshotTemplates` 等核心查询都 JOIN `active_envs` 而非 `envs`
- 写路径仍然直接对 `envs` 表(因为视图不可写)

---

## 8. 关联关系矩阵

### 8.1 外键关系总览(出向)

```
public.users
  └─(被引用)─→ user_identities, users_teams, access_tokens, team_api_keys, envs, addons

teams
  ├─→ tiers (tier)
  └─→ clusters (cluster_id, 可空)

users_teams
  ├─→ public.users (user_id CASCADE, added_by SET NULL)
  └─→ teams (team_id CASCADE)

team_api_keys
  ├─→ teams (team_id CASCADE)
  └─→ public.users (created_by SET NULL)

access_tokens
  └─→ public.users (user_id CASCADE)

envs
  ├─→ teams (team_id NO ACTION)
  ├─→ public.users (created_by SET NULL)
  └─→ clusters (cluster_id, 可空)

env_aliases
  └─→ envs (env_id CASCADE)

env_builds
  └─ (env_id 与 team_id 无 FK, 由 env_build_assignments 触发器维护)

env_build_assignments
  ├─→ envs (env_id CASCADE)
  └─→ env_builds (build_id CASCADE)

active_template_builds
  └─→ envs (template_id CASCADE)

snapshots
  ├─→ envs (env_id CASCADE)
  ├─→ envs (base_env_id CASCADE)
  └─→ teams (team_id NO ACTION)

snapshot_templates
  └─→ envs (env_id CASCADE, 同时是 PK)

volumes
  └─→ teams (team_id 默认 NO ACTION)

addons
  ├─→ teams (team_id CASCADE)
  └─→ public.users (added_by NO ACTION)
```

### 8.2 反向引用(envs.id 的多重身份)

`envs.id` 是数据库中最重要的"被引用键",共 6 条入向:

| 引用方 | 字段 | ON DELETE | 用途 |
| --- | --- | --- | --- |
| `env_aliases` | `env_id` | CASCADE | env 的别名(可多个) |
| `env_build_assignments` | `env_id` | CASCADE | env 关联的构建记录 |
| `snapshots` | `env_id` | CASCADE | 该 env 自身的快照 |
| `snapshots` | `base_env_id` | CASCADE | 以该 env 为父模板的快照 |
| `snapshot_templates` | `env_id` | CASCADE(PK) | 快照提升为模板 |
| `active_template_builds` | `template_id` | CASCADE | 该 env 的活跃构建 |

### 8.3 跨簇关键链路

**用户 → 团队 → 模板 → 构建**:
```
public.users
  └─ users_teams ─ teams ─ envs ─ env_build_assignments ─ env_builds
                                              │
                                              └─ active_template_builds (配额)
```

**模板 → 快照 → 快照模板**:
```
envs (source='template')
  └─ snapshots (env_id, base_env_id)
       └─ snapshot_templates (env_id) ─→ envs (source='snapshot')
```

**团队配额双层叠加**:
```
teams
  ├─→ tiers (基础配额)
  └─→ addons (有效期内额外配额)
        │
        └→ 视图 team_limits (security_invoker) ─→ 应用层查询
```

### 8.4 env ↔ build 多对多(去 FK 的反范式)

`env_builds.env_id` **没有**外键约束(`20260204172712` 中 DROP),改用 `env_build_assignments` 中间表 + 触发器维护。原因:支持一个 build 被多个 env 共享。

```
INSERT env_builds (env_id=NULL)
INSERT env_build_assignments (env_id, build_id, tag, source='app')
   ↓ 触发器 trigger_backfill_env_id
UPDATE env_builds SET env_id=$env_id WHERE id=$build_id AND env_id IS NULL

   ↓ 触发器 trigger_backfill_team_id
UPDATE env_builds SET team_id=(SELECT team_id FROM envs WHERE id=NEW.env_id)
WHERE id=$build_id AND team_id IS NULL
```

`env_builds.env_id` 始终 = 该 build 被分配的**第一个** env(业务层保证)。读取侧用 `env_build_assignments` 拿完整关系。

---

## 9. 索引与触发器一览

### 9.1 索引策略分类

| 类型 | 例子 | 服务的查询 |
| --- | --- | --- |
| **覆盖翻页索引** | `idx_env_builds_team_status_pagination (team_id, created_at DESC, id DESC) INCLUDE (status, status_group)` | 团队构建列表翻页 + 排序 |
| **覆盖索引** | `idx_env_builds_id_covering (id) INCLUDE (status_group, created_at, finished_at)` | dashboard 模板 tag 查询 index-only |
| **状态过滤 partial** | `idx_env_builds_team_active (team_id) WHERE status_group IN ('pending','in_progress')` | 活跃构建计数 |
| **时间倒序游标** | `idx_snapshots_team_time_id (team_id, sandbox_started_at DESC, sandbox_id)` | 快照列表游标翻页 |
| **唯一性 partial** | `addons_idempotency_key_uidx (idempotency_key) WHERE idempotency_key IS NOT NULL` | 幂等创建 |
| **唯一性 partial** | `users_teams_user_id_is_default_idx (user_id) WHERE is_default = true` | 每用户仅一个默认团队 |
| **唯一性 partial** | `clusters_auth_org_id_idx (auth_org_id) WHERE auth_org_id IS NOT NULL` | 集群 OIDC 组织 ID 唯一 |
| **partial(按来源)** | `idx_envs_team_updated_at_templates (team_id, updated_at DESC, id DESC) WHERE source = 'template'` | 仅模板来源的团队列表 |
| **GIN(仅一处)** | `idx_snapshots_team_metadata_gin (team_id, metadata) USING GIN` | 按 metadata KV 过滤(依赖 `btree_gin` 扩展) |

### 9.2 触发器(最终状态)

| 触发器 | 表 | 时机 | 作用 |
| --- | --- | --- | --- |
| `team_slug_trigger` | `teams` | BEFORE INSERT | 自动生成 slug |
| `trg_compute_status_group` | `env_builds` | BEFORE INSERT OR UPDATE OF `status` | 派生 status_group(4 值:pending/in_progress/ready/failed) |
| `trigger_backfill_env_id` | `env_build_assignments` | AFTER INSERT | 回填 `env_builds.env_id` |
| `trigger_backfill_team_id` | `env_build_assignments` | AFTER INSERT | 回填 `env_builds.team_id` |
| `trg_sync_env_source_on_snapshot` | `snapshots` | AFTER INSERT | 父 env 标记 `source='snapshot'` |
| `trg_snapshots_fix_json_null_metadata` | `snapshots` | BEFORE INSERT OR UPDATE OF `metadata` | 规整 metadata 为 `'{}'::jsonb` |

> **已删除触发器**(均在 `20260416120000` 中清理):
> - `post_user_signup`(原在 auth.users)
> - `sync_inserts_to_public_users` / `sync_updates_to_public_users` / `sync_delete_auth_users_to_public_users`(auth↔public 同步三件套)
> - `create_default_team`(原 user 注册时自动建团队)
>
> 应用层现在负责这些"provision"逻辑,数据库只做约束。

---

## 10. 常见查询模式

### 10.1 按团队/模板翻页(游标分页)

E2B 统一用 `(created_at DESC, id DESC)` 复合游标,而非 OFFSET——避免深度翻页性能塌方。

**模式**:
```sql
WHERE team_id = @team_id
  AND (created_at, id) < (@cursor_time, @cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT @page_limit
```

**为何 `(created_at, id)` 而非只 `created_at`**:`created_at` 可能重复(同毫秒并发 INSERT),`id` 作为 tiebreaker 保证游标稳定。

**应用此模式的表**:`envs`、`env_builds`、`snapshots`、`env_aliases`。

### 10.2 LATERAL 子查询取"最新关联"

当存在多对多关系时,用 `JOIN LATERAL ... LIMIT 1` 取最新一行:

```sql
JOIN LATERAL (
    SELECT a.env_id FROM env_build_assignments a
    JOIN active_envs e ON e.id = a.env_id
    WHERE a.build_id = b.id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 1
) eba ON TRUE
```

**优势**:
- 比 `LEFT JOIN` + 后处理去重简单
- 比 window function `ROW_NUMBER()` 高效(只需 1 行)
- 可下推到 GIN/BTREE 索引

### 10.3 配额计数(active vs all)

`active_template_builds` 表专为配额设计——只保留在途 build,完成时立即 DELETE。

```sql
-- 配额检查
SELECT count(*) FROM active_template_builds WHERE team_id = $1;
-- 与 team_limits.concurrent_template_builds 比较
```

**为何不直接 `count(*) FROM env_builds WHERE status_group IN (...)`**:
- 后者要扫整张表(即使有 partial 索引)
- 前者是个轻量计数表,行数 = 当前活跃数,毫秒级
- 也方便 dashboard 显示"团队当前在跑几个 build"

### 10.4 软删除 + 别名释放的事务序列

`DELETE /templates/{id}` 是个**多语句事务**(见 §`envs`):

```sql
BEGIN;
-- 1. 软删 env(锁行,阻止并发 build 注册)
UPDATE envs SET deleted_at = NOW() WHERE id = $1 AND team_id = $2 AND deleted_at IS NULL
RETURNING id;

-- 2. 释放别名(让名字可重用) + 返回 alias key 给缓存失效
DELETE FROM env_aliases WHERE env_id = $1
RETURNING (CASE WHEN namespace IS NOT NULL THEN namespace || '/' || alias ELSE alias END);

-- 3. 清在途 build 计数(zombie 配额)
DELETE FROM active_template_builds WHERE template_id = $1;
COMMIT;
```

**为何不单条 CASCADE**:别名释放要返回 key 给应用层失效 Redis;CASCADE 删了应用拿不到 key。

### 10.5 GIN 索引按 JSONB KV 过滤

`snapshots.metadata` 是用户自定义 KV,支持按 KV 过滤:

```sql
-- 找出所有 metadata 中带 "env: prod" 的快照
SELECT * FROM snapshots
WHERE team_id = $1
  AND metadata @> '{"env": "prod"}';
```

**索引**:`idx_snapshots_team_metadata_gin (team_id, metadata) USING GIN`

**注意**:
- GIN 索引需要 `btree_gin` 扩展(因为 `team_id` 是 text,默认 GIN 不支持标量)
- 仅本表用 GIN——其他 jsonb 字段(`snapshots.config`、`env_builds.reason`)目前没建索引

---

## 11. 并发与一致性要点

### 11.1 行锁策略

| 操作 | 锁机制 | 目的 |
| --- | --- | --- |
| 软删模板 | `UPDATE envs SET deleted_at=...` 隐式行锁 | 阻止并发 build 注册(注册会 ON CONFLICT,但 WHERE deleted_at IS NULL 让它失败) |
| Pause/Checkpoint | 应用层 `sandboxStore.StartRemoving` 独占 transition key | 防止同一 sandbox 并发 pause/snapshot/kill |
| 团队成员变更 | `LockTeamMembersForUpdate`(显式 `FOR UPDATE`) | 防止管理员改成员时其它请求读到不一致状态 |
| Build 状态变更 | `UPDATE env_builds SET status=...` 隐式行锁 | 防止 orchestrator 与 template-manager 同时改同一 build |

### 11.2 ON CONFLICT 模式

| 场景 | ON CONFLICT 子句 | 行为 |
| --- | --- | --- |
| `CreateOrUpdateTemplate`(每次新 build) | `(id) DO UPDATE SET build_count = build_count + 1` | 同一模板的多次 build 累加计数 |
| `UpsertSnapshot`(每次 pause) | `(sandbox_id) DO UPDATE` | 同一 sandbox 多次 pause 只更新,不重复 |
| `UpsertAlias`(显式更新别名) | `(alias, namespace) DO UPDATE/NOTHING` | 别名重建/迁移 |
| Addon 创建(幂等) | `(idempotency_key) WHERE ... DO NOTHING` | Stripe webhook 重放保护 |

### 11.3 触发器维护的反范式

`env_builds.env_id` 与 `env_builds.team_id` 是**反范式冗余字段**,由 `env_build_assignments` 的触发器维护:

```
应用写:  INSERT env_builds (env_id=NULL, team_id=NULL)
         INSERT env_build_assignments (env_id, build_id)
                     │
                     ▼ 触发器 trigger_backfill_env_id / trigger_backfill_team_id
         UPDATE env_builds SET env_id=$env_id, team_id=$team_id WHERE id=$build_id
```

**为什么不用 FK**:`env_builds.env_id` 是"第一个被分配的 env"(可能后续被分配给其它 env),无法用单一 FK 表达。`team_id` 同理——一个 build 理论上可以跨团队(虽然业务上不会)。

### 11.4 软删除 vs CASCADE 的选择

| 删除场景 | 策略 | 原因 |
| --- | --- | --- |
| 删模板 | **软删**(`deleted_at`) | 保留行,让在途 build/pause 失败时还能找到原 env(诊断) |
| 删快照 | **CASCADE**(随 env 软删后清理) | 快照本身不需要审计 |
| 删团队成员 | SET NULL(`added_by`)或 CASCADE(`user_id`) | 保持 audit 痕迹 vs 完全清理 |
| 删 team | **不允许**(应用层禁止) | 数据完整性 |

### 11.5 时区与时间戳

- **所有**业务时间戳用 `timestamptz`(带时区),避免跨地域部署歧义
- `now()` 由 PostgreSQL 服务器时钟决定,API 多实例间靠 NTP 同步
- 游标分页用 `created_at DESC, id DESC`——`created_at` 同毫秒时靠 `id` 兜底

### 11.6 sqlc 与原始 SQL 的边界

- 所有查询走 `packages/db/queries/*.sql` 经 sqlc 生成 Go 类型化代码(`internal/db/`)
- 极少数动态 SQL(如根据 filter 拼 WHERE):用 `sqlc.narg()` + `COALESCE` 模式
- DDL 不在查询文件,只走迁移(`packages/db/migrations/`)

---

## 附录:迁移文件命名规范

文件名格式:`YYYYMMDDHHMMSS_<short_description>.sql`

- 时间戳是 commit 时间(UTC),不一定是 release 时间
- "向前兼容"原则:先发新代码(读老+新字段)→ 再发迁移改字段 → 再发新代码(只用新字段)
- 大改动通常拆 2-3 个迁移:加新列 → 回填数据 → 删旧列(中间版本可回滚)

参考:`packages/db/migrations/` 下 100+ 文件,主要里程碑:
- `20240315165236`:env_builds 拆出来(去除 envs 上的构建字段)
- `20250211160814`:凭据 hash 化(安全升级)
- `20251218160000`:env_builds 多对多 + tag
- `20260211120000`:snapshot_templates 表
- `20260628120000`:envs 软删除
