# 按 `team_id` 统计 Sandbox、Template 与 Snapshot 存储大小

> 本文梳理当前代码库中 sandbox、template（代码和数据库中仍常称 `env`）、snapshot 的磁盘大小来源、写入链路、统计口径，并提供可以直接在 PostgreSQL 中执行的 SQL。
>
> **重要结论**：当前 PostgreSQL 记录的 `env_builds.total_disk_size_mb` 是 VM/rootfs 的**逻辑磁盘容量**，不是 GCS/S3/NFS 中对象的真实物理字节数。如果目标是云对象存储的计费或实际占用，需要使用对象存储 Inventory 或按对象的 `Content-Length` 统计，不能仅对 `total_disk_size_mb` 求和。

---

## 1. 统计目标与结论

### 1.1 当前可以从 PostgreSQL 统计什么

| 对象 | 数据来源 | 可统计的大小 | 归属字段 |
| --- | --- | --- | --- |
| 普通 Template | `active_envs` + 最新 ready build | Template 的逻辑磁盘容量 | `envs.team_id` |
| Pause Snapshot | `snapshots` 关联的 snapshot env 最新 ready build | Snapshot VM 逻辑磁盘容量 | `snapshots.team_id` / `envs.team_id` |
| Snapshot Template | `active_envs(source='snapshot_template')` + 最新 ready build | 可复用快照模板的逻辑磁盘容量 | `envs.team_id` |
| 运行中 Sandbox | Redis/Orchestrator 运行时状态 | 当前 sandbox 配置中的逻辑磁盘容量 | 运行时 `TeamID` |
| 构建历史 | `env_builds` | 每个 build 行记录的逻辑容量 | `env_builds.team_id` |
| 对象存储 Artifact | GCS/S3 对象及 metadata | 实际对象字节数、压缩后大小 | 对象 metadata 的 `team_id` |

### 1.2 推荐的默认口径

对于“每个 team 当前使用了多少磁盘”的数据库报表，推荐采用以下口径：

1. 只统计未软删除的资源，使用 `public.active_envs`。
2. 每个 env 只取 `default` tag 下最新的 `ready` build。
3. 不累加历史 build，避免同一个 template 的多次构建被重复计算。
4. 将 Template、Pause Snapshot、Snapshot Template 分列输出。
5. 同时输出 MiB 和 bytes，并明确这是**逻辑容量**。

不要直接将所有 `env_builds.total_disk_size_mb` 相加作为实际存储占用，因为这样会重复计算历史构建、共享 build、快照 diff chain 和已删除资源。

---

## 2. 相关数据模型

### 2.1 Template 实际对应哪些表

代码对外使用 Template，数据库保留了历史命名：

```text
Template
  └── public.envs                 -- template identity、team_id、source
        └── public.env_build_assignments
              └── public.env_builds -- 每个具体 build 的资源属性
```

`envs.source` 用于区分来源：

- `template`：普通用户 Template。
- `snapshot`：Pause/Resume 产生的 sandbox 快照环境。
- `snapshot_template`：通过 checkpoint 提升为可复用的 Snapshot Template。

普通 Template 的列表查询从 `public.active_envs` 出发，并过滤 `e.source = 'template'`。因此已软删除的 env 不应计入当前资源报表。

### 2.2 `env_builds` 中的磁盘字段

```sql
public.env_builds.total_disk_size_mb
public.env_builds.free_disk_size_mb
```

两者语义不同：

- `total_disk_size_mb`：build 完成后写入的 rootfs/VM 逻辑总磁盘容量，单位 MiB。
- `free_disk_size_mb`：创建 build 时请求或保留的可用磁盘空间，通常来自 team tier 限制，不能当作已占用空间。

模板 build 完成后，Template Manager 从 rootfs header 获得最终 rootfs size，并通过 `FinishTemplateBuild` 更新 `total_disk_size_mb`。相关代码：

- [`packages/api/internal/template-manager/template_status.go`](../packages/api/internal/template-manager/template_status.go)
- [`packages/db/queries/builds/finish_template_build.sql`](../packages/db/queries/builds/finish_template_build.sql)
- [`packages/orchestrator/pkg/template/build/builder.go`](../packages/orchestrator/pkg/template/build/builder.go)

### 2.3 Snapshot 的两层关系

一个 Pause Snapshot 通常涉及两类 env：

```text
原始 Template env (base_env_id)
        │
        └── snapshots.base_env_id

Snapshot 自己的 env (snapshots.env_id, source='snapshot')
        │
        └── env_build_assignments -> env_builds
```

`base_env_id` 是 sandbox 原来使用的 Template；`snapshots.env_id` 是本次 sandbox 的 snapshot env。统计 snapshot 大小时，应使用 snapshot 自己的 `env_id` 对应的 build，而不是再取 `base_env_id` 的 Template build。

同一个 sandbox 多次 pause 时，`snapshots` 按 `sandbox_id` upsert，通常保留一条当前快照记录；其 snapshot env/build 会持续更新。因此按当前 env 统计不会把每次 pause 都重复计入。

### 2.4 Sandbox 的存储位置

运行中的 Sandbox 不是主要通过 PostgreSQL 行保存的：

- 运行时状态主要在 Redis 和 Orchestrator 内存中。
- Sandbox 的 `TotalDiskSizeMB` 来自启动时的 sandbox config。
- pause 后，sandbox 的快照 build 会把该逻辑磁盘大小写入 `env_builds.total_disk_size_mb`。
- Sandbox 的实际写时数据是基于 Template rootfs 的 COW/diff，实际 artifact 位于本地 cache、NFS 或 GCS/S3。

因此，PostgreSQL 可以统计“当前持久化快照对应的逻辑容量”，不能仅靠数据库准确还原运行中 sandbox 的实时物理占用。

---

## 3. 磁盘大小写入链路

### 3.1 普通 Template Build

```text
Template build
  -> rootfs resize / finalize
  -> 从 rootfs header 读取逻辑 size
  -> Template Manager SetFinished
  -> env_builds.total_disk_size_mb
```

`SetFinished` 最终执行类似以下更新：

```sql
UPDATE public.env_builds
SET
    finished_at = NOW(),
    total_disk_size_mb = @total_disk_size_mb,
    status = @status,
    envd_version = @envd_version
WHERE id = @build_id;
```

只应该将 `status_group = 'ready'` 的 build 作为当前可用 build 统计。当前状态归一化后，`uploaded`、`success`、`ready` 都属于 ready group。

### 3.2 Pause Snapshot

Pause 时，API 从运行中的 sandbox 组装 `UpsertSnapshotParams`：

- `TeamID = sbx.TeamID`
- `BaseTemplateID = sbx.BaseTemplateID`
- `TotalDiskSizeMb = sbx.TotalDiskSizeMB`
- `FreeDiskSizeMb = 0`，因为 pause 路径并不知道原始 free disk 配置

`UpsertSnapshot` 会：

1. 首次 pause 时创建 `source = 'snapshot'` 的 env。
2. 插入或更新 `snapshots` 行。
3. 创建 snapshot 的 `env_builds` 行。
4. 通过 `env_build_assignments` 使用 `default` tag 关联 build。

相关文件：

- [`packages/api/internal/orchestrator/pause_instance.go`](../packages/api/internal/orchestrator/pause_instance.go)
- [`packages/db/queries/snapshots/create_new_snapshot.sql`](../packages/db/queries/snapshots/create_new_snapshot.sql)

### 3.3 Snapshot Template

Checkpoint 将一次 snapshot 提升为可复用的 Template：

1. 创建 `envs` 行，`source = 'snapshot_template'`。
2. 创建 `snapshot_templates` 元信息行。
3. 将已有 snapshot build 通过 `env_build_assignments` 关联到新 env。

Snapshot Template 的逻辑磁盘大小仍然来自其最新 ready build 的 `total_disk_size_mb`。它不是一个新的独立 rootfs 大小字段。

---

## 4. 现有查询的统计口径

### 4.1 Template 列表

[`packages/db/queries/get_team_templates.sql`](../packages/db/queries/get_team_templates.sql) 和 [`get_team_templates_with_cursor.sql`](../packages/db/queries/get_team_templates_with_cursor.sql) 都采用以下思路：

- 按 team 过滤 `envs.team_id`。
- 只查询 `source = 'template'`。
- 通过 `env_build_assignments` 找 `default` tag。
- 取最新 ready build。
- 返回 `eb.total_disk_size_mb`。

因此，Template API 的 `DiskSizeMB` 是最新 ready build 的逻辑磁盘容量，而不是 GCS/S3 object size。

当前分支的 cursor 查询还将模板 build 与其关联 snapshot build 的逻辑容量相加，结果字段仍叫 `build_total_disk_size_mb`。这个值适合展示“Template 加其 snapshot 逻辑容量”的场景，但不应直接解释成物理磁盘占用。若做独立 team 报表，建议将 Template 和 Snapshot 分列，避免语义混淆。

### 4.2 Pause Snapshot 列表

[`packages/db/queries/get_snapshots_with_cursor.sql`](../packages/db/queries/get_snapshots_with_cursor.sql) 使用：

```sql
snapshots s
JOIN active_envs e ON e.id = s.env_id
JOIN LATERAL (...) eb ON TRUE
```

其中 lateral 子查询只取 snapshot env 的最新 ready default build，并返回 `eb.total_disk_size_mb`。

### 4.3 Snapshot Template 列表

[`packages/db/queries/snapshots/list_team_snapshot_templates.sql`](../packages/db/queries/snapshots/list_team_snapshot_templates.sql) 使用：

- `active_envs e`
- `snapshot_templates st`
- 最新 ready build
- `e.team_id = @team_id`
- `e.source = 'snapshot_template'`

返回的 `eb.total_disk_size_mb` 同样是逻辑容量。

---

## 5. SQL：按 team 汇总当前逻辑磁盘容量

以下 SQL 均面向 PostgreSQL。所有大小字段均以 MiB 为基础，并额外转换为 bytes。

### 5.1 推荐：按资源类型分别汇总

此查询分别输出普通 Template、Pause Snapshot、Snapshot Template，避免把不同生命周期对象混在一列中：

```sql
WITH latest_ready_env_build AS (
    SELECT DISTINCT ON (e.id)
        e.id AS env_id,
        e.team_id,
        e.source,
        b.id AS build_id,
        b.total_disk_size_mb
    FROM public.active_envs AS e
    JOIN public.env_build_assignments AS ba
      ON ba.env_id = e.id
     AND ba.tag = 'default'
    JOIN public.env_builds AS b
      ON b.id = ba.build_id
     AND b.status_group = 'ready'
    WHERE e.source IN ('template', 'snapshot', 'snapshot_template')
    ORDER BY e.id, ba.created_at DESC, ba.id DESC
),
team_totals AS (
    SELECT
        team_id,
        COUNT(*) FILTER (WHERE source = 'template') AS template_count,
        COUNT(*) FILTER (WHERE source = 'snapshot') AS snapshot_count,
        COUNT(*) FILTER (WHERE source = 'snapshot_template')
            AS snapshot_template_count,
        COUNT(*) FILTER (
            WHERE source = 'template'
              AND total_disk_size_mb IS NOT NULL
        ) AS template_with_size_count,
        COUNT(*) FILTER (
            WHERE source = 'snapshot'
              AND total_disk_size_mb IS NOT NULL
        ) AS snapshot_with_size_count,
        COUNT(*) FILTER (
            WHERE source = 'snapshot_template'
              AND total_disk_size_mb IS NOT NULL
        ) AS snapshot_template_with_size_count,
        COALESCE(
            SUM(total_disk_size_mb) FILTER (WHERE source = 'template'),
            0
        )::bigint AS template_disk_size_mb,
        COALESCE(
            SUM(total_disk_size_mb) FILTER (WHERE source = 'snapshot'),
            0
        )::bigint AS snapshot_disk_size_mb,
        COALESCE(
            SUM(total_disk_size_mb)
                FILTER (WHERE source = 'snapshot_template'),
            0
        )::bigint AS snapshot_template_disk_size_mb
    FROM latest_ready_env_build
    GROUP BY team_id
)
SELECT
    team_id,
    template_count,
    snapshot_count,
    snapshot_template_count,
    template_with_size_count,
    snapshot_with_size_count,
    snapshot_template_with_size_count,
    template_disk_size_mb,
    snapshot_disk_size_mb,
    snapshot_template_disk_size_mb,
    (
        template_disk_size_mb
        + snapshot_disk_size_mb
        + snapshot_template_disk_size_mb
    )::bigint AS total_logical_disk_size_mb,
    (
        template_disk_size_mb
        + snapshot_disk_size_mb
        + snapshot_template_disk_size_mb
    )::numeric * 1024 * 1024 AS total_logical_disk_size_bytes,
    ROUND(
        (
            template_disk_size_mb
            + snapshot_disk_size_mb
            + snapshot_template_disk_size_mb
        )::numeric / 1024,
        2
    ) AS total_logical_disk_size_gib
FROM team_totals
ORDER BY total_logical_disk_size_mb DESC, team_id;
```

#### 口径

- 每个 active env 只保留一个最新 ready default build。
- `template_disk_size_mb`：普通 Template 的逻辑容量。
- `snapshot_disk_size_mb`：Pause Snapshot env 的逻辑容量。
- `snapshot_template_disk_size_mb`：可复用 Snapshot Template 的逻辑容量。
- `total_logical_disk_size_mb` 是三类 env 的简单相加。

> 如果业务上认为 Snapshot Template 与它背后的 Pause Snapshot 是同一份底层 artifact，不应将两者都计入“物理占用”。本查询是分类容量报表，不是去重后的对象存储账单。

### 5.2 只统计普通 Template

```sql
WITH latest_ready_template_build AS (
    SELECT DISTINCT ON (e.id)
        e.id AS template_id,
        e.team_id,
        b.id AS build_id,
        b.total_disk_size_mb
    FROM public.active_envs AS e
    JOIN public.env_build_assignments AS ba
      ON ba.env_id = e.id
     AND ba.tag = 'default'
    JOIN public.env_builds AS b
      ON b.id = ba.build_id
     AND b.status_group = 'ready'
    WHERE e.source = 'template'
    ORDER BY e.id, ba.created_at DESC, ba.id DESC
)
SELECT
    team_id,
    COUNT(*) AS template_count,
    COUNT(*) FILTER (WHERE total_disk_size_mb IS NOT NULL)
        AS template_with_disk_size_count,
    COALESCE(SUM(total_disk_size_mb), 0)::bigint
        AS total_template_disk_size_mb,
    COALESCE(SUM(total_disk_size_mb), 0)::numeric * 1024 * 1024
        AS total_template_disk_size_bytes,
    ROUND(COALESCE(SUM(total_disk_size_mb), 0)::numeric / 1024, 2)
        AS total_template_disk_size_gib
FROM latest_ready_template_build
GROUP BY team_id
ORDER BY total_template_disk_size_mb DESC, team_id;
```

### 5.3 只统计当前 Pause Snapshot

```sql
WITH latest_ready_snapshot_build AS (
    SELECT DISTINCT ON (e.id)
        e.id AS snapshot_env_id,
        e.team_id,
        s.sandbox_id,
        s.id AS snapshot_id,
        b.id AS build_id,
        b.total_disk_size_mb
    FROM public.active_envs AS e
    JOIN public.snapshots AS s
      ON s.env_id = e.id
    JOIN public.env_build_assignments AS ba
      ON ba.env_id = e.id
     AND ba.tag = 'default'
    JOIN public.env_builds AS b
      ON b.id = ba.build_id
     AND b.status_group = 'ready'
    WHERE e.source = 'snapshot'
    ORDER BY e.id, ba.created_at DESC, ba.id DESC
)
SELECT
    team_id,
    COUNT(*) AS snapshot_count,
    COUNT(*) FILTER (WHERE total_disk_size_mb IS NOT NULL)
        AS snapshot_with_disk_size_count,
    COALESCE(SUM(total_disk_size_mb), 0)::bigint
        AS total_snapshot_disk_size_mb,
    COALESCE(SUM(total_disk_size_mb), 0)::numeric * 1024 * 1024
        AS total_snapshot_disk_size_bytes,
    ROUND(COALESCE(SUM(total_disk_size_mb), 0)::numeric / 1024, 2)
        AS total_snapshot_disk_size_gib
FROM latest_ready_snapshot_build
GROUP BY team_id
ORDER BY total_snapshot_disk_size_mb DESC, team_id;
```

这里额外 JOIN `snapshots`，可以排除仅存在于 `envs` 但没有实际 snapshot 记录的异常数据。

### 5.4 只统计 Snapshot Template

```sql
WITH latest_ready_snapshot_template_build AS (
    SELECT DISTINCT ON (e.id)
        e.id AS snapshot_template_id,
        e.team_id,
        st.sandbox_id,
        b.id AS build_id,
        b.total_disk_size_mb
    FROM public.active_envs AS e
    JOIN public.snapshot_templates AS st
      ON st.env_id = e.id
    JOIN public.env_build_assignments AS ba
      ON ba.env_id = e.id
     AND ba.tag = 'default'
    JOIN public.env_builds AS b
      ON b.id = ba.build_id
     AND b.status_group = 'ready'
    WHERE e.source = 'snapshot_template'
    ORDER BY e.id, ba.created_at DESC, ba.id DESC
)
SELECT
    team_id,
    COUNT(*) AS snapshot_template_count,
    COUNT(*) FILTER (WHERE total_disk_size_mb IS NOT NULL)
        AS snapshot_template_with_disk_size_count,
    COALESCE(SUM(total_disk_size_mb), 0)::bigint
        AS total_snapshot_template_disk_size_mb,
    COALESCE(SUM(total_disk_size_mb), 0)::numeric * 1024 * 1024
        AS total_snapshot_template_disk_size_bytes,
    ROUND(
        COALESCE(SUM(total_disk_size_mb), 0)::numeric / 1024,
        2
    ) AS total_snapshot_template_disk_size_gib
FROM latest_ready_snapshot_template_build
GROUP BY team_id
ORDER BY total_snapshot_template_disk_size_mb DESC, team_id;
```

### 5.5 查询指定 `team_id` 的资源明细

将 `$1` 替换为目标 UUID，或者在 psql 中使用参数绑定：

```sql
WITH latest_ready_env_build AS (
    SELECT DISTINCT ON (e.id)
        e.id AS env_id,
        e.team_id,
        e.source,
        e.created_at AS env_created_at,
        b.id AS build_id,
        b.created_at AS build_created_at,
        b.total_disk_size_mb,
        b.free_disk_size_mb,
        b.status,
        b.status_group
    FROM public.active_envs AS e
    JOIN public.env_build_assignments AS ba
      ON ba.env_id = e.id
     AND ba.tag = 'default'
    JOIN public.env_builds AS b
      ON b.id = ba.build_id
     AND b.status_group = 'ready'
    WHERE e.team_id = $1::uuid
      AND e.source IN ('template', 'snapshot', 'snapshot_template')
    ORDER BY e.id, ba.created_at DESC, ba.id DESC
)
SELECT
    env_id,
    source,
    build_id,
    env_created_at,
    build_created_at,
    total_disk_size_mb,
    total_disk_size_mb::numeric * 1024 * 1024 AS total_disk_size_bytes,
    ROUND(total_disk_size_mb::numeric / 1024, 2) AS total_disk_size_gib,
    free_disk_size_mb,
    status,
    status_group
FROM latest_ready_env_build
ORDER BY source, env_created_at DESC, env_id;
```

### 5.6 指定 `team_id` 的模板及其关联 Snapshot 容量

如果要复现当前 cursor template 查询中“Template 自身 build + 其 base template 下 snapshots”的逻辑，可使用下面的明细查询：

```sql
WITH latest_ready_template_build AS (
    SELECT DISTINCT ON (e.id)
        e.id AS template_id,
        e.team_id,
        b.id AS template_build_id,
        b.total_disk_size_mb AS template_disk_size_mb
    FROM public.active_envs AS e
    JOIN public.env_build_assignments AS ba
      ON ba.env_id = e.id
     AND ba.tag = 'default'
    JOIN public.env_builds AS b
      ON b.id = ba.build_id
     AND b.status_group = 'ready'
    WHERE e.team_id = $1::uuid
      AND e.source = 'template'
    ORDER BY e.id, ba.created_at DESC, ba.id DESC
),
latest_ready_snapshot_build AS (
    SELECT DISTINCT ON (s.id)
        s.id AS snapshot_id,
        s.base_env_id AS template_id,
        s.sandbox_id,
        s.team_id,
        b.id AS snapshot_build_id,
        b.total_disk_size_mb AS snapshot_disk_size_mb
    FROM public.snapshots AS s
    JOIN public.active_envs AS snapshot_env
      ON snapshot_env.id = s.env_id
    JOIN public.env_build_assignments AS ba
      ON ba.env_id = s.env_id
     AND ba.tag = 'default'
    JOIN public.env_builds AS b
      ON b.id = ba.build_id
     AND b.status_group = 'ready'
    WHERE s.team_id = $1::uuid
    ORDER BY s.id, ba.created_at DESC, ba.id DESC
),
snapshot_totals AS (
    SELECT
        template_id,
        COUNT(*) AS snapshot_count,
        COALESCE(SUM(snapshot_disk_size_mb), 0)::bigint
            AS snapshot_disk_size_mb
    FROM latest_ready_snapshot_build
    GROUP BY template_id
)
SELECT
    t.template_id,
    t.template_build_id,
    t.template_disk_size_mb,
    COALESCE(s.snapshot_count, 0) AS snapshot_count,
    COALESCE(s.snapshot_disk_size_mb, 0) AS snapshot_disk_size_mb,
    (
        COALESCE(t.template_disk_size_mb, 0)
        + COALESCE(s.snapshot_disk_size_mb, 0)
    )::bigint AS logical_disk_size_mb,
    (
        COALESCE(t.template_disk_size_mb, 0)
        + COALESCE(s.snapshot_disk_size_mb, 0)
    )::numeric * 1024 * 1024 AS logical_disk_size_bytes
FROM latest_ready_template_build AS t
LEFT JOIN snapshot_totals AS s
  ON s.template_id = t.template_id
ORDER BY logical_disk_size_mb DESC, t.template_id;
```

该查询是“按模板归属的逻辑容量”视图，不是物理对象存储去重视图。一个 snapshot 的 diff 可能引用父 Template 的 layer，因此简单相加会高估真实物理对象数，但能回答容量配置和可恢复环境规模问题。

---

## 6. 不推荐但可用于审计的 build 行统计

有时需要检查数据库中 build 的历史分布，可以使用：

```sql
SELECT
    team_id,
    COUNT(*) AS build_count,
    COUNT(*) FILTER (WHERE status_group = 'ready') AS ready_build_count,
    COUNT(*) FILTER (WHERE status_group = 'in_progress')
        AS in_progress_build_count,
    COUNT(*) FILTER (WHERE status_group = 'failed') AS failed_build_count,
    COALESCE(SUM(total_disk_size_mb), 0)::bigint
        AS all_build_disk_size_mb,
    COALESCE(
        SUM(total_disk_size_mb) FILTER (WHERE status_group = 'ready'),
        0
    )::bigint AS ready_build_disk_size_mb
FROM public.env_builds
WHERE team_id IS NOT NULL
GROUP BY team_id
ORDER BY ready_build_disk_size_mb DESC, team_id;
```

此查询只能命名为“build-row logical capacity sum”，不能命名为“当前存储占用”，原因包括：

- 一个 Template 有多个历史 build。
- 一个 build 可以被多个 env/tag assignment 复用。
- layered artifact 的 ancestor layer 可能被多个 build 引用。
- 失败、取消、软删除资源仍可能有数据库历史记录。
- `total_disk_size_mb` 不是对象存储的 `Content-Length`。

如果历史数据存在 `env_builds.team_id IS NULL`，可以用 assignment 反查归属：

```sql
WITH build_team AS (
    SELECT
        b.id AS build_id,
        COALESCE(b.team_id, owner.team_id) AS team_id,
        b.total_disk_size_mb,
        b.status_group
    FROM public.env_builds AS b
    LEFT JOIN LATERAL (
        SELECT e.team_id
        FROM public.env_build_assignments AS ba
        JOIN public.envs AS e
          ON e.id = ba.env_id
        WHERE ba.build_id = b.id
        ORDER BY ba.created_at DESC, ba.id DESC
        LIMIT 1
    ) AS owner ON TRUE
)
SELECT
    team_id,
    COUNT(*) AS build_count,
    COALESCE(SUM(total_disk_size_mb), 0)::bigint AS total_disk_size_mb
FROM build_team
WHERE team_id IS NOT NULL
GROUP BY team_id
ORDER BY total_disk_size_mb DESC, team_id;
```

不过，若 schema 已完成 `env_builds.team_id` 的回填，优先使用该列，并把上述查询作为历史数据完整性检查。

---

## 7. 如果目标是 GCS/S3 的真实物理占用

### 7.1 为什么 PostgreSQL 不够

模板和 snapshot artifact 存储在对象存储时，常见对象包括：

```text
{buildID}/memfile
{buildID}/memfile.header
{buildID}/rootfs.ext4
{buildID}/rootfs.ext4.header
{buildID}/snapfile
{buildID}/snapfile.header
{buildID}/metadata.json
```

当前数据库中的 `total_disk_size_mb` 不能表达：

- 压缩后的对象大小。
- header 和 metadata 文件大小。
- snapshot diff chain 的 ancestor 复用。
- mapping 实际引用的字节数。
- 相同 layer 的跨 build 复用。
- 临时上传对象和软删除对象。

对象上传时会写入 `team_id`、`template_id`、`build_origin` 等 object metadata；这些 metadata 可以作为 Inventory 汇总维度。实际物理占用应优先使用对象的 `Content-Length` 或 Inventory 的 size 字段。

### 7.2 假设 Inventory 已导入 PostgreSQL 的查询

假设已经将 GCS/S3 Inventory 导入以下表：

```text
storage_objects(
    object_name text,
    team_id uuid,
    build_id uuid,
    size_bytes bigint,
    soft_deleted_at timestamptz,
    is_temporary boolean
)
```

按 team 汇总真实对象字节数：

```sql
SELECT
    team_id,
    COUNT(*) AS object_count,
    COALESCE(SUM(size_bytes), 0)::numeric AS physical_object_bytes,
    ROUND(COALESCE(SUM(size_bytes), 0)::numeric / 1024 / 1024, 2)
        AS physical_object_mib,
    ROUND(COALESCE(SUM(size_bytes), 0)::numeric / 1024 / 1024 / 1024, 2)
        AS physical_object_gib,
    COALESCE(
        SUM(size_bytes) FILTER (
            WHERE object_name LIKE '%/memfile%'
               OR object_name LIKE '%/rootfs.ext4%'
               OR object_name LIKE '%/snapfile%'
        ),
        0
    )::numeric AS data_object_bytes,
    COALESCE(
        SUM(size_bytes) FILTER (
            WHERE object_name LIKE '%.header'
               OR object_name LIKE '%/metadata.json'
        ),
        0
    )::numeric AS header_metadata_bytes
FROM storage_objects
WHERE soft_deleted_at IS NULL
  AND COALESCE(is_temporary, FALSE) = FALSE
  AND team_id IS NOT NULL
GROUP BY team_id
ORDER BY physical_object_bytes DESC, team_id;
```

> 如果 Inventory 记录的对象路径没有前导目录，或者 compressed artifact 使用不同后缀，应根据实际 `packages/shared/pkg/storage/paths.go` 生成的路径调整 `LIKE` 条件。

### 7.3 物理占用统计的去重注意事项

是否把以下对象计入报表，需要在业务上先确定：

- NFS 本地 cache：通常不应与 GCS/S3 主存储相加，否则会把同一份数据算两遍。
- Peer cache：通常是加速副本，不应作为权威存储账单。
- Snapshot Template 与原 snapshot 共享的数据 layer：应按 object key 去重。
- soft-deleted 对象：按计费周期决定是否保留；不能简单假设删除后立即不计费。
- header、metadata、size sidecar：如果目标是完整 bucket 用量，应计入；如果只看 data payload，可单独列出。

---

## 8. 排查和数据质量检查 SQL

### 8.1 检查没有 ready build 的 active env

```sql
SELECT
    e.team_id,
    e.id AS env_id,
    e.source,
    e.deleted_at
FROM public.active_envs AS e
WHERE e.source IN ('template', 'snapshot', 'snapshot_template')
  AND NOT EXISTS (
      SELECT 1
      FROM public.env_build_assignments AS ba
      JOIN public.env_builds AS b
        ON b.id = ba.build_id
      WHERE ba.env_id = e.id
        AND ba.tag = 'default'
        AND b.status_group = 'ready'
  )
ORDER BY e.team_id, e.source, e.id;
```

这些 env 会被推荐统计 SQL 排除；可以单独作为数据质量指标。

### 8.2 检查 ready build 缺少磁盘大小

```sql
SELECT
    e.team_id,
    e.id AS env_id,
    e.source,
    b.id AS build_id,
    b.status_group,
    b.total_disk_size_mb
FROM public.active_envs AS e
JOIN public.env_build_assignments AS ba
  ON ba.env_id = e.id
 AND ba.tag = 'default'
JOIN public.env_builds AS b
  ON b.id = ba.build_id
 AND b.status_group = 'ready'
WHERE b.total_disk_size_mb IS NULL
ORDER BY e.team_id, e.source, e.id, ba.created_at DESC;
```

### 8.3 检查 snapshot 的 team 归属是否一致

```sql
SELECT
    s.id AS snapshot_id,
    s.sandbox_id,
    s.team_id AS snapshot_team_id,
    e.team_id AS env_team_id,
    s.env_id,
    s.base_env_id
FROM public.snapshots AS s
JOIN public.envs AS e
  ON e.id = s.env_id
WHERE s.team_id <> e.team_id;
```

理论上该查询应返回 0 行。若有结果，应先修复归属数据，再生成 team 报表。

### 8.4 检查同一 env 的 default assignment 是否有多个 ready build

```sql
SELECT
    ba.env_id,
    COUNT(*) AS ready_default_build_count,
    ARRAY_AGG(b.id ORDER BY ba.created_at DESC, ba.id DESC) AS build_ids
FROM public.env_build_assignments AS ba
JOIN public.env_builds AS b
  ON b.id = ba.build_id
WHERE ba.tag = 'default'
  AND b.status_group = 'ready'
GROUP BY ba.env_id
HAVING COUNT(*) > 1
ORDER BY ready_default_build_count DESC, ba.env_id;
```

多个 ready build 并不一定是错误，因为 tag assignment 支持历史记录；正式统计必须按 assignment 时间取最新的一条，而不能直接 `SUM`。

---

## 9. 推荐报表字段

如果要把报表导出为 CSV、Dashboard 或管理后台，建议至少输出：

```text
team_id
team_name
普通 template 数量
普通 template 逻辑磁盘 MiB
pause snapshot 数量
pause snapshot 逻辑磁盘 MiB
snapshot template 数量
snapshot template 逻辑磁盘 MiB
逻辑容量合计 MiB
逻辑容量合计 GiB
无磁盘大小的 ready env 数量
统计时间
统计口径（logical_capacity / object_physical_size）
```

推荐在列名中显式包含 `logical` 或 `physical`，例如：

- `template_logical_disk_size_mb`
- `snapshot_logical_disk_size_mb`
- `physical_object_bytes`

不要把 `total_disk_size_mb` 直接命名成 `storage_used_mb`，避免使用者误认为这是实际磁盘或对象存储用量。

---

## 10. 关键源码索引

- 架构与存储拓扑：[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- Template 数据模型：[`web-docs/template-module.md`](./template-module.md)
- Snapshot 生命周期：[`web-docs/snapshots.md`](./snapshots.md)
- 数据库字段说明：[`web-docs/database-schema.md`](./database-schema.md)
- Template team 查询：[`packages/db/queries/get_team_templates.sql`](../packages/db/queries/get_team_templates.sql)
- Template cursor 查询：[`packages/db/queries/get_team_templates_with_cursor.sql`](../packages/db/queries/get_team_templates_with_cursor.sql)
- Snapshot 查询：[`packages/db/queries/get_snapshots_with_cursor.sql`](../packages/db/queries/get_snapshots_with_cursor.sql)
- Snapshot Template 查询：[`packages/db/queries/snapshots/list_team_snapshot_templates.sql`](../packages/db/queries/snapshots/list_team_snapshot_templates.sql)
- Pause snapshot upsert：[`packages/db/queries/snapshots/create_new_snapshot.sql`](../packages/db/queries/snapshots/create_new_snapshot.sql)
- Snapshot Template 创建：[`packages/db/queries/snapshots/create_snapshot_template_env.sql`](../packages/db/queries/snapshots/create_snapshot_template_env.sql)
- Template build 完成状态：[`packages/api/internal/template-manager/template_status.go`](../packages/api/internal/template-manager/template_status.go)
- Pause 参数组装：[`packages/api/internal/orchestrator/pause_instance.go`](../packages/api/internal/orchestrator/pause_instance.go)
- Artifact 路径：[`packages/shared/pkg/storage/paths.go`](../packages/shared/pkg/storage/paths.go)
- Artifact metadata 与缓存：[`web-docs/artifact-storage-cache.md`](./artifact-storage-cache.md)

---

## 11. 最终使用建议

- **看每个 team 当前 Template 逻辑容量**：使用 [5.2](#52只统计普通-template)。
- **看每个 team 的 Template + Pause Snapshot + Snapshot Template 分类容量**：使用 [5.1](#51推荐按资源类型分别汇总)。
- **看指定 team 的资源明细**：使用 [5.5](#55查询指定-team_id-的资源明细)。
- **看数据库 build 历史**：使用 [6](#6不推荐但可用于审计的-build-行统计)，但在报表中标注为历史逻辑容量。
- **看 GCS/S3 真实计费或物理占用**：建立对象 Inventory，使用 [7.2](#72假设-inventory-已导入-postgresql-的查询)，不要用 `total_disk_size_mb` 代替。
