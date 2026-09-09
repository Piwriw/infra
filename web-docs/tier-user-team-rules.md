# Tier、用户与团队的数据表及配额规则

当前实现中，**沙箱资源配额归属于团队，实际额度主要由 `tier` 基础额度与有效 `addons` 增量共同决定**；用户通过团队成员关系使用这些额度。依据：[额度计算视图:11](../packages/db/migrations/20260702120000_add_events_ttl_days.sql#L11)。

本文基于仓库提交 `93113e5eb`、数据库迁移的 `Up` 部分及业务代码，整理日期为 2026-09-05。分析前已阅读 [架构文档](../docs/ARCHITECTURE.md)。**未查询线上数据库**，因此下文区分迁移中的初始值、请求默认值和实际校验规则；无法从仓库确认的内容标为“未确认”。源码行号对应上述提交。

## 1. 数据表与关联

| 表／视图 | 用途与关键字段 | 关联及规则 | 源码依据 |
|---|---|---|---|
| `public.users` | 内部用户标识：`id`、`created_at`、`updated_at` | 当前已移除 `email`，也已解除 `id → auth.users.id` 的外键依赖；没有用户级 tier 或资源配额字段 | [用户建表:3](../packages/db/migrations/20251217000000_create_public_users_table.sql#L3)、[解除依赖:6](../packages/db/migrations/20260316130000_repoint_user_fks_to_public_users.sql#L6)、[删除邮箱:4](../packages/db/migrations/20260521181000_drop_public_users_email.sql#L4) |
| `public.user_identities` | 外部身份映射：`oidc_iss`、`oidc_sub`、`user_id` | `(oidc_iss, oidc_sub)` 为主键；`user_id → users.id`；同一用户在同一 issuer 下只能有一个映射 | [建表:3](../packages/db/migrations/20260515120000_create_user_identities_table.sql#L3)、[唯一约束:4](../packages/db/migrations/20260707193000_user_identities_unique_user_issuer.sql#L4) |
| `public.users_teams` | 用户与团队的多对多关系：`user_id`、`team_id`、`is_default`、`added_by` | 同一用户不能重复加入同一团队；当前主键为 `uuid_id`；每个用户最多一个默认团队 | [成员关系:93](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql#L93)、[UUID 主键:5](../packages/db/migrations/20260316120000_users_teams_uuid_pkey.sql#L5)、[默认团队唯一约束:4](../packages/db/migrations/20260511120000_users_teams_unique_default.sql#L4) |
| `public.teams` | 团队归属与状态：`id`、`name`、`slug`、`tier`、`is_blocked`、`is_banned`、`cluster_id` | `tier` 必填，外键指向 `tiers.id`；SSO 通过 `sso_organization_id` 关联，一个组织可对应多个团队 | [tier 外键:28](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql#L28)、[当前模型:13](../packages/db/pkg/auth/queries/models.go#L13)、[SSO 字段:4](../packages/db/migrations/20260706120000_add_teams_sso_organization_id.sql#L4) |
| `public.tiers` | 套餐定义：`id`、`name`，以及下表中的七项额度 | 多个团队可以引用同一 tier；套餐值来自数据库记录 | [初始定义:8](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql#L8)、[当前额度字段:15](../packages/db/migrations/20260702120000_add_events_ttl_days.sql#L15) |
| `public.addons` | 团队附加额度：`team_id`、各类 `extra_*`、`valid_from`、`valid_to`、`added_by` | 一队可有多个 addon；有效增量累加；`valid_to = NULL` 表示不设结束时间 | [建表:5](../packages/db/migrations/20251011200438_create_addons_table.sql#L5)、[事件额度扩展:8](../packages/db/migrations/20260702120000_add_events_ttl_days.sql#L8) |
| `public.team_limits` **视图** | 按团队计算的有效额度，`id` 为团队 ID | 由 `teams + tiers + addons` 计算；认证代码读取此视图，而不是单独读取 `tiers` | [视图:11](../packages/db/migrations/20260702120000_add_events_ttl_days.sql#L11)、[认证查询:1](../packages/db/pkg/auth/sql_queries/teams/get_team.sql#L1) |
| `public.team_api_keys` | 团队凭证：`id`、`team_id`、`api_key_hash`、`created_by` | API Key 直接确定团队；同一团队的不同 Key 共用团队额度 | [当前模型:29](../packages/db/pkg/auth/queries/models.go#L29)、[Key → 团队查询:1](../packages/db/pkg/auth/sql_queries/teams/get_team.sql#L1) |
| `public.access_tokens` | 用户凭证：`user_id`、`access_token_hash`、`id` | Token 先确定用户，再通过成员关系选择团队；没有单独资源额度 | [Token 查询:1](../packages/db/pkg/auth/sql_queries/access_token/get_user_id_from_access_token.sql#L1)、[选择团队:46](../packages/api/internal/handlers/auth.go#L46) |
| `envs`、`env_build_assignments`、`env_builds` | 模板归属、模板与构建的关联、构建规格 | `envs.team_id → teams.id`；assignment 关联模板与 build；`env_builds` 保存实际 `vcpu`、`ram_mb`、`free_disk_size_mb`、`total_disk_size_mb` | [模板归属:41](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql#L41)、[构建规格:9](../packages/db/migrations/20240315165236_create_env_builds.sql#L9)、[构建关联:17](../packages/db/migrations/20251218160000_allow_m_n_builds_with_tags.sql#L17) |
| `public.active_template_builds` | 构建并发计数依据：`build_id`、`team_id`、`template_id`、`tags`、`created_at` | 构建登记时写入；配额查询按团队统计此表 | [建表:3](../packages/db/migrations/20260305130000_create_active_template_builds.sql#L3)、[计数查询:11](../packages/db/queries/builds/get_inprogress_builds.sql#L11) |
| `snapshots`、`volumes` | 暂停快照与持久卷 | 都有团队归属；`volumes` 要求团队内名称唯一。运行中沙箱的并发计数则使用 Redis | [快照归属:3](../packages/db/migrations/20250923094021_add_team_id_to_snapshots.sql#L3)、[卷定义:3](../packages/db/migrations/20260304120000_volumes.sql#L3)、[Redis 计数:49](../packages/api/internal/sandbox/reservations/redis/scripts.go#L49) |

完整的用户关联路径是：

`OIDC (iss, sub) → user_identities.user_id → users.id → users_teams.team_id → teams.tier → tiers.id`

随后用该团队的有效 `addons` 计算 `team_limits`。JWT 身份映射及团队成员校验见 [OIDC 解析:144](../packages/auth/pkg/auth/oidc/oidc.go#L144)、[成员与额度查询:8](../packages/db/pkg/auth/sql_queries/teams/get_team.sql#L8)。

API Key 路径直接通过 `team_api_keys.team_id → teams → team_limits` 取得团队与额度，不必先确定某个用户：[API Key 认证查询:1](../packages/db/pkg/auth/sql_queries/teams/get_team.sql#L1)。

## 2. 套餐配置、默认值与单位

仓库明确初始化的套餐只有 **`base_v1`**。下面的值是假设完整执行仓库迁移、且没有外部修改时可推导出的结果。其他套餐的实际 ID、名称和额度均为 **未确认**。依据：[初始化套餐:5](../packages/db/migrations/20231220094836_create_triggers_and_policies.sql#L5)。

| `tiers` 字段 | 单位／含义 | `base_v1` 迁移结果，不含 addon | 数据库 `DEFAULT`／约束 | 源码依据 |
|---|---|---:|---|---|
| `concurrent_instances` | 个／团队沙箱并发 | 20 | 无 `DEFAULT`；必须 `> 0` | [初始化:5](../packages/db/migrations/20231220094836_create_triggers_and_policies.sql#L5)、[约束:15](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql#L15) |
| `concurrent_template_builds` | 个／团队构建并发 | 20 | 默认 20；必须 `> 0` | [迁移:5](../packages/db/migrations/20250901161352_add_concurrent_template_builds_to_tier.sql#L5) |
| `max_vcpu` | vCPU／单个模板规格上限 | 8 | 默认 8；该迁移未增加正数检查 | [迁移:5](../packages/db/migrations/20250507134356_add_max_specs_to_tier.sql#L5) |
| `max_ram_mb` | MiB／单个模板内存上限 | 8192，即 8 GiB | 当前默认 8192；旧值 8096 被修正 | [修正迁移:3](../packages/db/migrations/20250513111201_tier_fix_max_memory.sql#L3) |
| `disk_mb` | MiB／构建预留可用磁盘空间 | 512 | 默认 512；必须 `> 0` | [初始定义:14](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql#L14)、[写入构建:226](../packages/api/internal/template/register_build.go#L226) |
| `max_length_hours` | 小时／沙箱一次运行周期的时长上限 | 1 | **无 `DEFAULT`**；迁移给已有空值补 1，再设为 `NOT NULL` | [迁移:5](../packages/db/migrations/20240219190940_add_max_length_hours.sql#L5) |
| `events_ttl_days` | 天／沙箱事件保留期 | 7 | 默认 7；必须 `> 0` | [迁移:4](../packages/db/migrations/20260702120000_add_events_ttl_days.sql#L4) |

磁盘字段虽然命名为 `MB`，代码实际按 `2²⁰` 字节转换，因此这里统一写作 MiB：[单位转换:5](../packages/shared/pkg/units/units.go#L5)。

## 3. 业务代码实际执行的限制

数据库配置进入业务代码后，实际执行规则如下。**CPU、内存限制的是单个模板规格；沙箱并发和构建并发由整个团队共享。**

| 限制项 | 请求默认值及实际边界 | 校验位置／生效条件 | 超限或到期行为 | 源码依据 |
|---|---|---|---|---|
| 沙箱并发 | 上限为 `team_limits.concurrent_sandboxes` | 创建、恢复走同一预留入口；Redis 原子检查“存储中的沙箱数 + 正在启动的预留数” | 达到额度返回 HTTP **429**；过期的启动预留按 90 秒清理 | [创建入口:153](../packages/api/internal/orchestrator/create_instance.go#L153)、[原子检查:35](../packages/api/internal/sandbox/reservations/redis/scripts.go#L35)、[预留期限:24](../packages/api/internal/sandbox/reservations/redis/reservation.go#L24) |
| 模板构建并发 | 上限为 `team_limits.concurrent_template_builds` | 登记构建前，统计最近一天的 active build；排除同模板且 tag 重叠、将被替代的记录 | 达到额度返回 **429**；查询与登记并非原子操作，代码明确说明可能短暂超额 | [登记检查:73](../packages/api/internal/template/register_build.go#L73)、[统计范围:11](../packages/db/queries/builds/get_inprogress_builds.sql#L11) |
| CPU | 省略时 **2 vCPU**；显式设置必须为 **1 或偶数**，且 `≤ min(32, team_limits.max_vcpu)` | 模板构建登记时调用 `LimitResources` | 不符合范围、奇偶规则或团队额度，返回 **400** | [常量:3](../packages/api/internal/constants/templates.go#L3)、[CPU 校验:17](../packages/api/internal/team/limits.go#L17) |
| 内存 | 省略时 **1024 MiB**；显式设置必须 `≥ 128`、可被 2 整除，且 `≤ team_limits.max_ram_mb` | 模板构建登记时校验；此函数没有额外固定的内存业务上限 | 不符合规则返回 **400** | [默认值:8](../packages/api/internal/constants/templates.go#L8)、[内存校验:52](../packages/api/internal/team/limits.go#L52) |
| 磁盘 | 从有效团队额度写入 `env_builds.free_disk_size_mb`；不是客户端指定的磁盘总容量上限 | 构建阶段测量可用空间，不足时扩容；空间足够则不缩盘 | 扩容错误会使构建失败；ext4 元数据导致可用空间略低于目标时，当前代码仅记录警告并继续 | [保存额度:219](../packages/api/internal/template/register_build.go#L219)、[扩容逻辑:70](../packages/orchestrator/pkg/template/build/phases/ensurefreedisk/grow.go#L70)、[不足目标时处理:182](../packages/orchestrator/pkg/template/build/phases/ensurefreedisk/builder.go#L182) |
| 创建／恢复／fork 的超时 | 默认 **15 秒**，非负；上限为 `max_length_hours × 3600` 秒；connect 的 `timeout` 必填 | 请求入口校验套餐上限；创建或恢复后记录本次 `StartTime` 和最大运行时长 | 超限 **400**；到期默认 kill，开启 `autoPause` 时暂停 | [请求约束:709](../spec/openapi.yml#L709)、[创建检查:153](../packages/api/internal/handlers/sandbox_create.go#L153)、[恢复检查:58](../packages/api/internal/handlers/sandbox_resume.go#L58)、[fork 检查:64](../packages/api/internal/handlers/sandbox_fork.go#L64)、[connect 检查:45](../packages/api/internal/handlers/sandbox_connect.go#L45)、[到期动作:151](../packages/api/internal/orchestrator/evictor/evict.go#L151) |
| 运行中续期 | 设置的期限被截断为 `min(请求时长, 本次运行剩余额度)`；旧 refresh 接口还有请求上限 **3600 秒**、处理时最低 **15 秒** | 使用沙箱创建时保存的 `MaxInstanceLength`；反复续期不能突破本次运行周期上限 | 尚未耗尽时截断期限；已超过最大运行时长返回 **400** | [续期:27](../packages/api/internal/orchestrator/keep_alive.go#L27)、[计算剩余时间:73](../packages/api/internal/orchestrator/keep_alive.go#L73)、[refresh 约束:795](../spec/openapi.yml#L795)、[最低时长:47](../packages/api/internal/handlers/sandbox_refresh.go#L47) |
| 流量触发的自动恢复 | 无有效保存值时默认 **300 秒**；最低值由功能开关控制，默认也为 **300 秒** | 先按正数套餐上限截断，再提高到最低自动恢复时长 | 自动调整值；若最低值配置得比套餐上限大，当前实现最终采用最低值 | [计算顺序:22](../packages/api/internal/handlers/timeout_helper.go#L22)、[默认最低值:359](../packages/shared/pkg/featureflags/flags.go#L359) |
| 事件保留期 | 有效团队额度；写入值 `≤ 0` 时回退 **7 天**，大于 **365 天**时截为 365 | 事件写入器处理后，将 TTL 保存到 ClickHouse 每一行 | 按事件时间加该行 TTL 过期；不是 API 请求拒绝 | [写入规则:114](../packages/clickhouse/pkg/events/delivery.go#L114)、[逐行 TTL:9](../packages/clickhouse/migrations/20260702120000_add_sandbox_events_ttl_days.sql#L9) |

请求体还统一经过 OpenAPI schema 校验，因此表中的非负、必填等 schema 约束也在 HTTP 入口生效：[校验中间件:201](../packages/api/main.go#L201)。

## 4. 用户和团队管理规则

| 场景 | 实际规则 | 失败行为／边界 | 源码依据 |
|---|---|---|---|
| 新团队的初始套餐 | 普通注册创建的默认团队、用户额外创建的团队，均显式使用 `base_v1` | 这是应用写入值，不是 `teams.tier` 的数据库默认值 | [默认团队:138](../packages/dashboard-api/internal/provisioning/bootstrap.go#L138)、[额外团队:46](../packages/dashboard-api/internal/provisioning/team.go#L46) |
| 用户创建团队数量 | 仅加入基础套餐团队时上限 **3**；只要已加入任一 `tier != base_v1` 的团队，上限变为 **10** | 按用户**所有团队成员关系**计数；达到上限返回 **400**；任一已加入团队被 banned，也会拒绝创建 | [常量:14](../packages/dashboard-api/internal/provisioning/service.go#L14)、[判断逻辑:140](../packages/dashboard-api/internal/provisioning/team.go#L140)、[计数范围:23](../packages/db/pkg/auth/sql_queries/teams/team_creation_guard.sql#L23) |
| 加入及移除成员 | 添加成员要求邮箱对应已存在且唯一的用户；此接口没有复用上述 3/10 创建限制，也未读取 tier 成员人数额度 | 用户不存在 **404**；邮箱匹配多人 **409**；重复成员 **400**；不能移除默认团队成员或最后一名成员 | [添加成员:110](../packages/dashboard-api/internal/handlers/team_members.go#L110)、[移除限制:226](../packages/dashboard-api/internal/handlers/team_members.go#L226) |
| SSO 托管用户 | 不能自行创建团队；首次 bootstrap 在没有默认团队时加入组织配置的自动加入团队；组织团队邀请对象必须属于同一组织 | 自建团队 **403**；没有可自动加入团队 **403**；跨组织邀请 **400** | [自建限制:42](../packages/dashboard-api/internal/provisioning/sso.go#L42)、[加入流程:14](../packages/dashboard-api/internal/provisioning/sso.go#L14)、[邀请检查:133](../packages/dashboard-api/internal/handlers/team_members.go#L133) |
| banned／blocked 团队 | banned 在团队认证查询时拒绝；blocked 按接口白名单限制，部分读取和删除仍允许 | HTTP 团队认证／访问拒绝通常为 **403**；不能把“额度尚有剩余”理解为仍可创建资源 | [banned 检查:13](../packages/auth/pkg/auth/team_state.go#L13)、[认证返回:106](../packages/auth/pkg/auth/service.go#L106)、[blocked 白名单:15](../packages/api/internal/middleware/blocked_team.go#L15) |

## 5. 配置优先级、空值与套餐变更

配置优先级、空值与变更行为需要单独看，不能简单理解为“用户配置覆盖套餐”。

| 情况 | 实际处理方式 | 源码依据 |
|---|---|---|
| tier 与 addon 的合成 | 并发、构建并发、CPU、内存、磁盘、事件保留期采用 **tier 值 + 所有有效 addon 增量之和**。`max_length_hours` 直接取 tier，当前没有对应 addon 增量 | [完整计算:15](../packages/db/migrations/20260702120000_add_events_ttl_days.sql#L15) |
| addon 为空、未开始或已过期 | 无有效 addon 时增量为 0。生效区间为 `valid_from <= now()`，且 `valid_to IS NULL OR valid_to > now()`，结束边界不包含在内 | [求和及有效期:25](../packages/db/migrations/20260702120000_add_events_ttl_days.sql#L25) |
| 请求省略 CPU／内存 | 分别直接采用 2 vCPU、1024 MiB。**当前上限校验位于“字段非 nil”的分支内，省略字段不会再校验默认值是否超过团队额度** | [默认值与分支:13](../packages/api/internal/team/limits.go#L13) |
| tier 未配置或引用不存在 | `teams.tier = NULL` 或指向不存在的 tier 会违反数据库约束；没有自动回退套餐的查询逻辑。若异常数据使额度 JOIN 无结果，API Key 路径会认证失败，而不是补用基础套餐 | [非空及外键:35](../packages/db/migrations/20231124185944_create_schemas_and_tables.sql#L35)、[INNER JOIN:1](../packages/db/pkg/auth/sql_queries/teams/get_team.sql#L1)、[失败响应:116](../packages/auth/pkg/auth/service.go#L116) |
| 配额为 0 或负数 | 没有统一的“0／负数代表无限”规则。addon 增量未设非负检查；合成沙箱并发为 **0 时拒绝新增**，为 **负数时 Redis 跳过并发限制**；事件 TTL 非正数则回退 7 天 | [addon 字段约束:11](../packages/db/migrations/20251011200438_create_addons_table.sql#L11)、[并发特殊值:49](../packages/api/internal/sandbox/reservations/redis/scripts.go#L49)、[TTL 回退:114](../packages/clickhouse/pkg/events/delivery.go#L114) |
| 套餐或 addon 改动何时生效 | 视图重新查询时计算新值；团队认证对象缓存 **5 分钟**，命中且缓存年龄超过 **1 分钟**时触发异步刷新，当前请求仍可能使用旧值。因此 addon 到期也不等于所有请求立即切换额度 | [缓存参数:13](../packages/auth/pkg/auth/cache.go#L13)、[命中返回:99](../packages/shared/pkg/cache/redis.go#L99)、[刷新条件:392](../packages/shared/pkg/cache/redis.go#L392) |
| 已登记模板／已有沙箱规格 | CPU、内存、磁盘参数在登记构建时保存。创建沙箱直接使用 build 中的规格，未重新比较当前团队 CPU／内存上限；修改套餐不会自动重建或调整已有模板规格 | [保存构建:219](../packages/api/internal/template/register_build.go#L219)、[使用 build 规格:275](../packages/api/internal/orchestrator/create_instance.go#L275) |
| 已运行沙箱的时长上限 | 创建／恢复时把当时的套餐时长保存到沙箱；运行中续期使用这个保存值。套餐升级不会通过续期函数自动替换它；新的恢复周期重新记录开始时间和额度 | [创建时保存:357](../packages/api/internal/orchestrator/create_instance.go#L357)、[续期使用保存值:27](../packages/api/internal/orchestrator/keep_alive.go#L27) |
| 并发额度下调 | 创建路径按新额度拒绝后续新增；没有在该路径主动终止已有沙箱。自动清理按沙箱到期状态执行，未见此处按套餐降级主动缩容 | [新增检查:153](../packages/api/internal/orchestrator/create_instance.go#L153)、[到期扫描:99](../packages/api/internal/orchestrator/evictor/evict.go#L99) |
| 事件保留期变更 | 生命周期事件使用沙箱保存的 TTL；已写入 ClickHouse 的事件按各自行内 TTL 过期。未见修改 tier 后批量回写历史事件 TTL 的逻辑 | [读取保存值:865](../packages/orchestrator/pkg/server/sandboxes.go#L865)、[逐行保存:122](../packages/clickhouse/pkg/events/delivery.go#L122)、[数据库 TTL:9](../packages/clickhouse/migrations/20260702120000_add_sandbox_events_ttl_days.sql#L9) |

## 6. 其他限制与未确认项

还存在一些与资源使用相关、但不由 `tiers` 字段直接定义的限制。

| 项目 | 代码中的默认值／规则 | 源码依据 |
|---|---|---|
| 单次 fork 数量 | 默认 1，最大 100，且必须严格小于团队沙箱并发上限；每个 fork 仍需通过实际并发预留。基础额度为 20 时，单次参数最多 19 | [全局上限:28](../packages/api/internal/handlers/sandbox_fork.go#L28)、[参数检查:75](../packages/api/internal/handlers/sandbox_fork.go#L75) |
| API 请求速率 | 使用功能开关 `rate-limit-config`，按“团队 ID + 路由”计数；默认配置为空则不限制，`period_s` 默认 1 秒；超限 429。当前 Redis 故障时放行；生产环境开关值及其与具体 tier 的对应关系 **未确认** | [配置解析:34](../packages/api/internal/middleware/ratelimit/ratelimit.go#L34)、[计数与响应:107](../packages/api/internal/middleware/ratelimit/ratelimit.go#L107)、[FailOpen 配置:223](../packages/api/main.go#L223) |
| OCI 基础 rootfs 大小 | `build-base-rootfs-size-limit-mb` 默认 **25000 MiB**，在镜像转换为基础 ext4 时使用；不等同于 tier 的可用磁盘额度；生产环境开关值 **未确认** | [默认值:356](../packages/shared/pkg/featureflags/flags.go#L356)、[构建检查:158](../packages/orchestrator/pkg/template/build/core/rootfs/rootfs.go#L158) |
| root 专用磁盘保留空间 | `build-reserved-disk-space-mb` 默认 **256 MiB**，构建启动前设置；非正值不设置；生产环境开关值 **未确认** | [默认值:363](../packages/shared/pkg/featureflags/flags.go#L363)、[应用逻辑:75](../packages/orchestrator/pkg/template/build/layer/create_sandbox.go#L75) |
| 持久卷容量／数量 | **未确认套餐配额**。卷创建接口检查功能开关及团队归属，但没有使用 `TeamLimits` 校验卷数量或容量 | [卷创建入口:24](../packages/api/internal/handlers/volume_create.go#L24)、[配额类型:3](../packages/auth/pkg/types/limits.go#L3) |
| 商业套餐配置、购买与降级结算 | **未确认**。普通团队更新接口只允许名称和头像；仓库可见向外部 billing 服务发送团队 provisioning 请求，但不能据此确认生产套餐值、价格、余额或降级结算规则 | [允许更新字段:95](../packages/dashboard-api/internal/handlers/team_update.go#L95)、[billing 调用:123](../packages/dashboard-api/internal/teamprovision/http_sink.go#L123) |

## 7. 历史数据兼容

以下迁移尤其容易影响对当前规则的理解。

| 历史变化 | 当前应如何解释 | 源码依据 |
|---|---|---|
| 删除旧 `tiers.vcpu`、`tiers.ram_mb` | 初始套餐中的 2 CPU／512 MiB 不是当前模板请求默认值；当前分别使用代码默认值与 `max_vcpu`／`max_ram_mb` 上限 | [删除旧字段:5](../packages/db/migrations/20240305221944_remove_tier_resources.sql#L5)、[当前默认值:3](../packages/api/internal/constants/templates.go#L3) |
| 内存上限 8096 修正为 8192 | 迁移同时修改 SQL 默认值，并修正所有恰好等于 8096 的历史记录 | [修正逻辑:3](../packages/db/migrations/20250513111201_tier_fix_max_memory.sql#L3) |
| 默认团队标记从团队移到成员关系 | 默认团队是“某个用户的默认团队”，不是团队全局属性；数据库只保证每用户最多一个。旧用户凭证路径找不到默认团队时返回 500；没有任何团队时返回 403 | [移除团队字段:5](../packages/db/migrations/20250106142106_remove_team_is_default.sql#L5)、[默认团队查找:52](../packages/api/internal/handlers/auth.go#L52)、[无团队处理:119](../packages/api/internal/handlers/auth.go#L119) |
| 移除注册后的数据库自动建队触发器 | 当前由应用 bootstrap 创建用户映射及默认团队；直接插入用户行不会再依赖旧触发器自动获得基础团队 | [移除触发器:3](../packages/db/migrations/20260416120000_remove_user_team_provision_triggers.sql#L3)、[应用 bootstrap:138](../packages/dashboard-api/internal/provisioning/bootstrap.go#L138) |
| 删除明文 API Key／Access Token 列 | 当前认证按哈希查找。旧 CLI 团队列表路径会生成新的团队 API Key，以兼容哈希存储后的登录配置流程 | [删除明文列:3](../packages/db/migrations/20250910124212_remove_raw_keys.sql#L3)、[CLI 兼容逻辑:27](../packages/api/internal/handlers/teams.go#L27) |

## 相关文档

- [数据库表字段与关联关系](./database-schema.md)
- [Sandbox 基于 Team-ID 的认证详解](./sandbox-team-auth.md)
- [认证子系统详解](./auth-module.md)
- [Dashboard API 详解](./dashboard-api-module.md)
