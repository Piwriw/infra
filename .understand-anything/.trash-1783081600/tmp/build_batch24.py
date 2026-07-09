#!/usr/bin/env python3
"""Build batch-24 graph fragment."""
import json
from collections import defaultdict

EXTRACT_FILE = '/Users/joohwan/GolandProjects/infra/.understand-anything/tmp/ua-file-extract-results-24.json'
BATCHES_FILE = '/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batches.json'
OUT_DIR = '/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate'

with open(EXTRACT_FILE) as f:
    data = json.load(f)

with open(BATCHES_FILE) as f:
    batches_data = json.load(f)

batch24 = batches_data['batches'][23]
files = batch24['files']
imports_map = batch24['batchImportData']
neighbor_map = batch24['neighborMap']

# Map path -> result
results_by_path = {r['path']: r for r in data['results']}

# ===================== FILE METADATA =====================
# Custom summaries for each file (in Chinese)
file_meta = {
    'packages/db/pkg/dashboard/queries/get_dashboard_teams_with_users_teams_with_tier.sql.go': {
        'summary': 'sqlc 生成的查询代码：获取包含用户团队和订阅层级的仪表板团队列表。',
        'tags': ['sqlc-generated', 'dashboard', 'team-query', 'database'],
    },
    'packages/db/pkg/dashboard/queries/get_default_templates.sql.go': {
        'summary': 'sqlc 生成的查询代码：获取团队的默认模板列表。',
        'tags': ['sqlc-generated', 'template-query', 'database'],
    },
    'packages/db/pkg/dashboard/queries/list_team_templates.sql.go': {
        'summary': 'sqlc 生成的查询代码：按创建时间或更新时间升降序列出团队模板，包含参数与行结构定义。',
        'tags': ['sqlc-generated', 'template-query', 'pagination', 'database'],
    },
    'packages/db/pkg/dashboard/queries/list_template_tag_assignments_by_tag.sql.go': {
        'summary': 'sqlc 生成的查询代码：按标签列出模板标签分配记录。',
        'tags': ['sqlc-generated', 'tag-query', 'database'],
    },
    'packages/db/pkg/dashboard/queries/list_template_tag_groups_by_latest_asc.sql.go': {
        'summary': 'sqlc 生成的查询代码：按最新分配时间升序列出模板标签组。',
        'tags': ['sqlc-generated', 'tag-group-query', 'database'],
    },
    'packages/db/pkg/dashboard/queries/list_template_tag_groups_by_latest_desc.sql.go': {
        'summary': 'sqlc 生成的查询代码：按最新分配时间降序列出模板标签组。',
        'tags': ['sqlc-generated', 'tag-group-query', 'database'],
    },
    'packages/db/pkg/dashboard/queries/list_template_tag_groups_by_name_asc.sql.go': {
        'summary': 'sqlc 生成的查询代码：按名称升序列出模板标签组。',
        'tags': ['sqlc-generated', 'tag-group-query', 'database'],
    },
    'packages/db/pkg/dashboard/queries/list_template_tag_groups_by_name_desc.sql.go': {
        'summary': 'sqlc 生成的查询代码：按名称降序列出模板标签组。',
        'tags': ['sqlc-generated', 'tag-group-query', 'database'],
    },
    'packages/db/pkg/dashboard/queries/models.go': {
        'summary': 'sqlc 生成的模型定义：Team 和 TeamLimit 数据模型。',
        'tags': ['sqlc-generated', 'data-model', 'database'],
    },
    'packages/db/pkg/dashboard/queries/update_team.sql.go': {
        'summary': 'sqlc 生成的查询代码：更新团队记录及其返回行结构。',
        'tags': ['sqlc-generated', 'team-query', 'database'],
    },
    'packages/db/pkg/dberrors/dberrors.go': {
        'summary': '数据库错误判断工具：识别未找到错误、唯一约束冲突、外键约束冲突。',
        'tags': ['database', 'error-handling', 'utility'],
    },
    'packages/db/pkg/dberrors/dberrors_test.go': {
        'summary': '测试 dberrors 包中错误识别函数的正确性。',
        'tags': ['test', 'database', 'error-handling'],
    },
    'packages/db/pkg/pool/main.go': {
        'summary': 'pgxpool 连接池构造器：解析连接串、配置重试、初始化遥测池并返回 DBTX 接口。',
        'tags': ['connection-pool', 'pgx', 'infrastructure'],
    },
    'packages/db/pkg/pool/options.go': {
        'summary': 'pgxpool 的 functional options：连接上限、空闲下限、注入重试配置。',
        'tags': ['connection-pool', 'options-pattern', 'configuration'],
    },
    'packages/db/pkg/retry/config.go': {
        'summary': '数据库重试配置结构与默认值、链式 Option 构造器。',
        'tags': ['retry', 'configuration', 'options-pattern'],
    },
    'packages/db/pkg/retry/errors.go': {
        'summary': '错误分类：判断 PostgreSQL/网络/上下文错误是否可重试。',
        'tags': ['retry', 'error-classification', 'utility'],
    },
    'packages/db/pkg/retry/errors_test.go': {
        'summary': '测试 IsRetriable 对各类错误（PostgreSQL、网络、连接、上下文、消息）的判定。',
        'tags': ['test', 'retry', 'error-handling'],
    },
    'packages/db/pkg/retry/wrapper.go': {
        'summary': '数据库重试包装器：包装 DBTX 以指数退避重试 Exec/Query/QueryRow，并集成 OTEL 与日志。',
        'tags': ['retry', 'database', 'observability', 'wrapper'],
    },
    'packages/db/pkg/retry/wrapper_test.go': {
        'summary': '测试重试包装器：成功路径、各类错误重试决策、退避增长与封顶。',
        'tags': ['test', 'retry', 'database'],
    },
    'packages/db/pkg/tests/builds/active_template_builds_test.go': {
        'summary': '集成测试：验证 GetInProgressTemplateBuildsByTeam 与 DeleteActiveTemplateBuild 的过滤与删除行为。',
        'tags': ['test', 'integration', 'database', 'template-build'],
    },
    'packages/db/pkg/tests/builds/finish_template_build_test.go': {
        'summary': '集成测试：FinishTemplateBuild 的版本号写入与保留语义。',
        'tags': ['test', 'integration', 'database', 'template-build'],
    },
    'packages/db/pkg/tests/builds/get_concurrent_template_builds_test.go': {
        'summary': '集成测试：并发模板构建查询的标签匹配、跨模板隔离与去重行为。',
        'tags': ['test', 'integration', 'database', 'concurrency'],
    },
    'packages/db/pkg/tests/builds/get_exclusive_builds_for_template_deletion_test.go': {
        'summary': '集成测试：获取模板删除的独占构建集合在多种共享场景下的正确性。',
        'tags': ['test', 'integration', 'database', 'template-deletion'],
    },
    'packages/db/pkg/tests/builds/invalidate_unstarted_builds_test.go': {
        'summary': '集成测试：使未开始的构建失效（特定标签、模板、状态过滤）。',
        'tags': ['test', 'integration', 'database', 'template-build'],
    },
    'packages/db/pkg/tests/db_test.go': {
        'summary': '数据库测试基础设施：断言无行级安全（RLS）策略生效。',
        'tags': ['test', 'integration', 'database', 'security'],
    },
    'packages/db/pkg/tests/snapshots/snapshot_latest_assignment_test.go': {
        'summary': '集成测试：最近快照分配的游标分页、标签与构建顺序行为。',
        'tags': ['test', 'integration', 'database', 'snapshot'],
    },
    'packages/db/pkg/tests/snapshots/upsert_snapshot_test.go': {
        'summary': '集成测试：快照的新建与已存在时的 upsert 行为。',
        'tags': ['test', 'integration', 'database', 'snapshot'],
    },
    'packages/db/pkg/tests/template_aliases/delete_template_aliases_test.go': {
        'summary': '集成测试：删除模板别名的成功路径与不存在别名场景。',
        'tags': ['test', 'integration', 'database', 'template-alias'],
    },
    'packages/db/pkg/tests/template_aliases/namespace_resolution_test.go': {
        'summary': '集成测试：模板别名在命名空间与 null 命名空间下的解析、跨团队隔离。',
        'tags': ['test', 'integration', 'database', 'template-alias'],
    },
    'packages/db/pkg/tests/templates/delete_template_test.go': {
        'summary': '集成测试：模板软删除环境同时保留结构关联。',
        'tags': ['test', 'integration', 'database', 'template'],
    },
}

# Per-class summaries (path -> class -> summary)
class_meta = {
    ('packages/db/pkg/dashboard/queries/get_dashboard_teams_with_users_teams_with_tier.sql.go', 'GetDashboardTeamsWithUsersTeamsWithTierRow'): {
        'summary': 'GetDashboardTeamsWithUsersTeamsWithTier 返回的行结构：团队及其成员关联信息。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/get_default_templates.sql.go', 'GetDefaultTemplatesRow'): {
        'summary': 'GetDefaultTemplates 返回的行结构：模板核心字段。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByCreatedAtAscParams'): {
        'summary': '按创建时间升序的查询参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByCreatedAtAscRow'): {
        'summary': '按创建时间升序的查询结果行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByCreatedAtDescParams'): {
        'summary': '按创建时间降序的查询参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByCreatedAtDescRow'): {
        'summary': '按创建时间降序的查询结果行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByUpdatedAtAscParams'): {
        'summary': '按更新时间升序的查询参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByUpdatedAtAscRow'): {
        'summary': '按更新时间升序的查询结果行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByUpdatedAtDescParams'): {
        'summary': '按更新时间降序的查询参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByUpdatedAtDescRow'): {
        'summary': '按更新时间降序的查询结果行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_assignments_by_tag.sql.go', 'ListTemplateTagAssignmentsByTagParams'): {
        'summary': '按标签查询模板标签分配记录的参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_assignments_by_tag.sql.go', 'ListTemplateTagAssignmentsByTagRow'): {
        'summary': '按标签查询模板标签分配记录的行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_latest_asc.sql.go', 'ListTemplateTagGroupsByLatestAscParams'): {
        'summary': '按最新分配时间升序查询的参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_latest_asc.sql.go', 'ListTemplateTagGroupsByLatestAscRow'): {
        'summary': '按最新分配时间升序查询的行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_latest_desc.sql.go', 'ListTemplateTagGroupsByLatestDescParams'): {
        'summary': '按最新分配时间降序查询的参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_latest_desc.sql.go', 'ListTemplateTagGroupsByLatestDescRow'): {
        'summary': '按最新分配时间降序查询的行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_name_asc.sql.go', 'ListTemplateTagGroupsByNameAscParams'): {
        'summary': '按名称升序查询模板标签组的参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_name_asc.sql.go', 'ListTemplateTagGroupsByNameAscRow'): {
        'summary': '按名称升序查询模板标签组的行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_name_desc.sql.go', 'ListTemplateTagGroupsByNameDescParams'): {
        'summary': '按名称降序查询模板标签组的参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_name_desc.sql.go', 'ListTemplateTagGroupsByNameDescRow'): {
        'summary': '按名称降序查询模板标签组的行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/dashboard/queries/models.go', 'Team'): {
        'summary': '团队数据模型：团队标识、层级等核心字段。',
        'tags': ['sqlc-generated', 'data-model'],
    },
    ('packages/db/pkg/dashboard/queries/models.go', 'TeamLimit'): {
        'summary': '团队资源限额数据模型。',
        'tags': ['sqlc-generated', 'data-model'],
    },
    ('packages/db/pkg/dashboard/queries/update_team.sql.go', 'UpdateTeamParams'): {
        'summary': '更新团队的查询参数。',
        'tags': ['sqlc-generated', 'params'],
    },
    ('packages/db/pkg/dashboard/queries/update_team.sql.go', 'UpdateTeamRow'): {
        'summary': '更新团队查询返回的行结构。',
        'tags': ['sqlc-generated', 'row-model'],
    },
    ('packages/db/pkg/retry/config.go', 'Config'): {
        'summary': '重试配置：最大尝试次数、初始/最大退避与退避倍数；Apply 方法把配置写回 pgxpool.Config。',
        'tags': ['retry', 'configuration'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'RetryableDBTX'): {
        'summary': '实现了 types.DBTX 接口的数据库事务类型，提供带重试的 Exec/Query/QueryRow。',
        'tags': ['retry', 'database', 'wrapper'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'retryableRow'): {
        'summary': 'pgx.Row 的可重试包装：Scan 在连接错误时重试。',
        'tags': ['retry', 'database', 'wrapper'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'mockDBTX'): {
        'summary': '单元测试用的 DBTX mock 实现。',
        'tags': ['test', 'mock'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'mockRow'): {
        'summary': '单元测试用的 pgx.Row mock 实现。',
        'tags': ['test', 'mock'],
    },
}

# Per-function summaries
func_meta = {
    ('packages/db/pkg/dashboard/queries/get_dashboard_teams_with_users_teams_with_tier.sql.go', 'GetDashboardTeamsWithUsersTeamsWithTier'): {
        'summary': '执行 sqlc 生成的 SQL，按用户返回其所属团队及订阅层级信息。',
        'tags': ['sqlc-generated', 'query'],
    },
    ('packages/db/pkg/dashboard/queries/get_default_templates.sql.go', 'GetDefaultTemplates'): {
        'summary': '执行 sqlc 生成的 SQL，返回团队默认模板列表。',
        'tags': ['sqlc-generated', 'query'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByCreatedAtAsc'): {
        'summary': '按创建时间升序分页列出团队模板。',
        'tags': ['sqlc-generated', 'query', 'pagination'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByCreatedAtDesc'): {
        'summary': '按创建时间降序分页列出团队模板。',
        'tags': ['sqlc-generated', 'query', 'pagination'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByUpdatedAtAsc'): {
        'summary': '按更新时间升序分页列出团队模板。',
        'tags': ['sqlc-generated', 'query', 'pagination'],
    },
    ('packages/db/pkg/dashboard/queries/list_team_templates.sql.go', 'ListTeamTemplatesByUpdatedAtDesc'): {
        'summary': '按更新时间降序分页列出团队模板。',
        'tags': ['sqlc-generated', 'query', 'pagination'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_assignments_by_tag.sql.go', 'ListTemplateTagAssignmentsByTag'): {
        'summary': '执行 sqlc 生成的 SQL，按标签返回模板的标签分配记录。',
        'tags': ['sqlc-generated', 'query'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_latest_asc.sql.go', 'ListTemplateTagGroupsByLatestAsc'): {
        'summary': '执行 sqlc 生成的 SQL，按最近分配时间升序返回模板标签组。',
        'tags': ['sqlc-generated', 'query'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_latest_desc.sql.go', 'ListTemplateTagGroupsByLatestDesc'): {
        'summary': '执行 sqlc 生成的 SQL，按最近分配时间降序返回模板标签组。',
        'tags': ['sqlc-generated', 'query'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_name_asc.sql.go', 'ListTemplateTagGroupsByNameAsc'): {
        'summary': '执行 sqlc 生成的 SQL，按名称升序返回模板标签组。',
        'tags': ['sqlc-generated', 'query'],
    },
    ('packages/db/pkg/dashboard/queries/list_template_tag_groups_by_name_desc.sql.go', 'ListTemplateTagGroupsByNameDesc'): {
        'summary': '执行 sqlc 生成的 SQL，按名称降序返回模板标签组。',
        'tags': ['sqlc-generated', 'query'],
    },
    ('packages/db/pkg/dashboard/queries/update_team.sql.go', 'UpdateTeam'): {
        'summary': '执行 sqlc 生成的 SQL，更新团队记录并返回更新后的行。',
        'tags': ['sqlc-generated', 'query', 'mutation'],
    },
    ('packages/db/pkg/dberrors/dberrors.go', 'IsNotFoundError'): {
        'summary': '判断错误是否为 pgx 的 ErrNoRows。',
        'tags': ['database', 'error-handling'],
    },
    ('packages/db/pkg/dberrors/dberrors.go', 'IsUniqueConstraintViolation'): {
        'summary': '判断错误是否为 PostgreSQL 唯一约束冲突 (SQLSTATE 23505)。',
        'tags': ['database', 'error-handling'],
    },
    ('packages/db/pkg/dberrors/dberrors.go', 'IsForeignKeyViolation'): {
        'summary': '判断错误是否为 PostgreSQL 外键约束冲突 (SQLSTATE 23503)。',
        'tags': ['database', 'error-handling'],
    },
    ('packages/db/pkg/dberrors/dberrors_test.go', 'TestIsUniqueConstraintViolation'): {
        'summary': '测试 IsUniqueConstraintViolation 对各类 pg 错误的判定。',
        'tags': ['test', 'error-handling'],
    },
    ('packages/db/pkg/pool/main.go', 'New'): {
        'summary': '构造带 OpenTelemetry、重试包装的 pgxpool.Pool，并返回 types.DBTX 抽象。',
        'tags': ['connection-pool', 'factory'],
    },
    ('packages/db/pkg/pool/options.go', 'WithMaxConnections'): {
        'summary': '设置 pgxpool 最大连接数的 Option。',
        'tags': ['connection-pool', 'options-pattern'],
    },
    ('packages/db/pkg/pool/options.go', 'WithMinIdle'): {
        'summary': '设置 pgxpool 最小空闲连接数的 Option。',
        'tags': ['connection-pool', 'options-pattern'],
    },
    ('packages/db/pkg/pool/options.go', 'WithRetryConfig'): {
        'summary': '覆写默认重试配置的 Option。',
        'tags': ['connection-pool', 'retry', 'options-pattern'],
    },
    ('packages/db/pkg/retry/config.go', 'DefaultConfig'): {
        'summary': '返回默认重试配置（5 次尝试、100ms 初始退避、5s 上限、2 倍退避）。',
        'tags': ['retry', 'configuration'],
    },
    ('packages/db/pkg/retry/config.go', 'WithMaxAttempts'): {
        'summary': '设置最大重试次数。',
        'tags': ['retry', 'options-pattern'],
    },
    ('packages/db/pkg/retry/config.go', 'WithInitialBackoff'): {
        'summary': '设置初始退避时长。',
        'tags': ['retry', 'options-pattern'],
    },
    ('packages/db/pkg/retry/config.go', 'WithMaxBackoff'): {
        'summary': '设置最大退避时长上限。',
        'tags': ['retry', 'options-pattern'],
    },
    ('packages/db/pkg/retry/config.go', 'WithBackoffMultiplier'): {
        'summary': '设置指数退避乘数。',
        'tags': ['retry', 'options-pattern'],
    },
    ('packages/db/pkg/retry/config.go', 'Apply'): {
        'summary': '把重试配置中的退避参数应用到 pgxpool.Config。',
        'tags': ['retry', 'configuration'],
    },
    ('packages/db/pkg/retry/errors.go', 'IsRetriable'): {
        'summary': '判断给定的错误是否可重试（PostgreSQL、网络、连接错误等）。',
        'tags': ['retry', 'error-classification'],
    },
    ('packages/db/pkg/retry/errors.go', 'isRetriablePgError'): {
        'summary': '内部辅助：依据 pgconn.PgError 的 SQLSTATE 判定 PostgreSQL 错误是否可重试。',
        'tags': ['retry', 'error-classification'],
    },
    ('packages/db/pkg/retry/errors_test.go', 'TestIsRetriable_NilError'): {
        'summary': '测试 nil 错误不被视为可重试。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/errors_test.go', 'TestIsRetriable_ContextErrors'): {
        'summary': '测试上下文取消/超时错误的可重试判定。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/errors_test.go', 'TestIsRetriable_PostgreSQLErrors'): {
        'summary': '测试 PostgreSQL 各类 SQLSTATE 错误的可重试判定。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/errors_test.go', 'TestIsRetriable_NetworkErrors'): {
        'summary': '测试网络错误的可重试判定。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/errors_test.go', 'TestIsRetriable_ConnectError'): {
        'summary': '测试 net.OpError 类型的可重试判定。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/errors_test.go', 'TestIsRetriable_NetError'): {
        'summary': '测试 net.Error 接口实现的错误判定。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/errors_test.go', 'TestIsRetriable_ErrorMessages'): {
        'summary': '基于错误消息文本判定是否可重试。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/errors_test.go', 'TestIsRetriable_WrappedErrors'): {
        'summary': '测试 errors.Wrap/Is 链路下的错误可重试判定。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'Wrap'): {
        'summary': '将 DBTX 包装为可重试版本；若已是事务则原样返回。',
        'tags': ['retry', 'wrapper'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'Exec'): {
        'summary': '带重试的 Exec：执行 SQL 并在可重试错误时退避重试。',
        'tags': ['retry', 'database'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'Query'): {
        'summary': '带重试的 Query：返回可扫描行的结果集。',
        'tags': ['retry', 'database'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'QueryRow'): {
        'summary': '带重试的 QueryRow：返回带 Scan 重试逻辑的行对象。',
        'tags': ['retry', 'database'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'Scan'): {
        'summary': 'retryableRow.Scan：扫描行并在连接错误时重试。',
        'tags': ['retry', 'database'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'handleRetry'): {
        'summary': '内部辅助：在两次尝试之间处理日志记录与退避休眠。',
        'tags': ['retry', 'helper'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'shouldRetry'): {
        'summary': '判定当前是否应再尝试一次：上下文未取消且剩余次数充足且错误可重试。',
        'tags': ['retry', 'helper'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'backoffFunc'): {
        'summary': '返回单次尝试前的休眠时长（含抖动），遵循指数退避 + 上限。',
        'tags': ['retry', 'helper'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'calculateBackoff'): {
        'summary': '计算给定尝试序号的指数退避时长，clamp 至 maxBackoff。',
        'tags': ['retry', 'helper'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'logRetry'): {
        'summary': '使用 zap 记录重试事件，包含操作名、尝试次数与错误。',
        'tags': ['retry', 'logging'],
    },
    ('packages/db/pkg/retry/wrapper.go', 'recordRetrySpan'): {
        'summary': '在 OTEL span 上记录重试事件及属性。',
        'tags': ['retry', 'observability'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'Exec'): {
        'summary': 'mockDBTX.Exec：记录调用并返回设定结果。',
        'tags': ['test', 'mock'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'Query'): {
        'summary': 'mockDBTX.Query：记录调用并返回设定的行集合。',
        'tags': ['test', 'mock'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'QueryRow'): {
        'summary': 'mockDBTX.QueryRow：记录调用并返回设定的 mock 行。',
        'tags': ['test', 'mock'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'Scan'): {
        'summary': 'mockRow.Scan：记录调用并返回设定错误。',
        'tags': ['test', 'mock'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'testConfig'): {
        'summary': '返回测试使用的快退避重试配置，缩短用例时长。',
        'tags': ['test', 'helper'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestWrap_ReturnsOriginalForTransaction'): {
        'summary': '测试 Wrap 在传入事务时原样返回。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestExec_SuccessOnFirstAttempt'): {
        'summary': '测试 Exec 首次成功时不重试。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestExec_RetryOnConnectionError'): {
        'summary': '测试 Exec 在连接错误时重试并在后续成功。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestExec_NoRetryOnDeadlock'): {
        'summary': '测试 Exec 在死锁（不可重试）时不重试。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestExec_NoRetryOnConstraintViolation'): {
        'summary': '测试 Exec 在约束冲突时直接返回错误。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestExec_MaxAttemptsExceeded'): {
        'summary': '测试 Exec 超过最大尝试次数后返回最后一次错误。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestExec_ContextCancellation'): {
        'summary': '测试 Exec 在上下文取消时立即停止重试。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestQuery_RetryOnConnectionError'): {
        'summary': '测试 Query 在连接错误时重试。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestQueryRow_RetryOnConnectionError'): {
        'summary': '测试 QueryRow 在 Scan 时连接错误时重试。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestQueryRow_NoRetryOnNoRows'): {
        'summary': '测试 QueryRow 在 pgx.ErrNoRows 时不重试。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestConfig_Options'): {
        'summary': '测试 Config 链式 Option 构造器。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestBackoff_ExponentialGrowth'): {
        'summary': '测试退避时长按指数增长。',
        'tags': ['test', 'retry'],
    },
    ('packages/db/pkg/retry/wrapper_test.go', 'TestBackoff_MaxBackoffCap'): {
        'summary': '测试退避时长达到 maxBackoff 后被封顶。',
        'tags': ['test', 'retry'],
    },
}

# Test function summaries (per path)
test_func_meta = {
    'packages/db/pkg/tests/builds/active_template_builds_test.go': {
        'TestGetInProgressTemplateBuildsByTeam_ExcludesSameTemplateWithOverlappingTags': '验证按团队列出进行中模板构建时排除同模板有重叠标签的构建。',
        'TestGetInProgressTemplateBuildsByTeam_IgnoresRowsOlderThanDay': '验证按团队列出进行中构建时忽略超过一天的过期记录。',
        'TestDeleteActiveTemplateBuild_RemovesActiveBuild': '验证删除活跃模板构建的正常路径。',
    },
    'packages/db/pkg/tests/builds/finish_template_build_test.go': {
        'getBuildVersions': '读取构建的 kernel/firecracker 版本号辅助函数。',
        'TestFinishTemplateBuild_OverwritesVersionsWhenProvided': '验证 FinishTemplateBuild 在提供新版本时覆盖旧版本。',
        'TestFinishTemplateBuild_PreservesVersionsWhenEmpty': '验证传入空版本时保留已有版本号。',
        'TestFinishTemplateBuild_PreservesSingleVersionWhenOnlyOneEmpty': '验证仅单个版本为空时仍保留原值。',
    },
    'packages/db/pkg/tests/builds/get_concurrent_template_builds_test.go': {
        'TestGetConcurrentTemplateBuilds_ReturnsBuildWithSameTag': '验证并发构建查询在相同标签下返回构建。',
        'TestGetConcurrentTemplateBuilds_DoesNotReturnBuildWithDifferentTag': '验证不同标签下不返回该构建。',
        'TestGetConcurrentTemplateBuilds_ReturnsBuildsWithOverlappingTags': '验证重叠标签场景下返回多个构建。',
        'TestGetConcurrentTemplateBuilds_DoesNotReturnBuildsFromOtherTemplates': '验证不会返回其他模板的构建。',
        'TestGetConcurrentTemplateBuilds_OnlyReturnsPendingAndInProgressBuilds': '验证仅返回待处理与进行中状态的构建。',
        'TestGetConcurrentTemplateBuilds_NoDuplicatesWithMultipleOverlappingTags': '验证多重叠标签下不会重复返回同一构建。',
    },
    'packages/db/pkg/tests/builds/get_exclusive_builds_for_template_deletion_test.go': {
        'TestGetExclusiveBuildsForTemplateDeletion_ExclusiveBuild': '验证仅属于当前模板的构建被返回。',
        'TestGetExclusiveBuildsForTemplateDeletion_SharedBuild': '验证与其他模板共享的构建不被返回。',
        'TestGetExclusiveBuildsForTemplateDeletion_MixedBuilds': '验证混合场景下的正确过滤。',
        'TestGetExclusiveBuildsForTemplateDeletion_NoBuilds': '验证无构建时返回空集。',
        'TestGetExclusiveBuildsForTemplateDeletion_MultipleTagsSameTemplate': '验证同一模板多个标签下的过滤。',
        'TestGetExclusiveBuildsForTemplateDeletion_SharedBuildAcrossTeams': '验证跨团队共享构建的场景。',
        'TestGetExclusiveBuildsForTemplateDeletion_MixedBuildsAcrossTeams': '验证跨团队的混合构建过滤。',
    },
    'packages/db/pkg/tests/builds/invalidate_unstarted_builds_test.go': {
        'TestInvalidateUnstartedTemplateBuilds_InvalidatesWaitingBuilds': '验证使未开始的（等待中）构建失效。',
        'TestInvalidateUnstartedTemplateBuilds_OnlyAffectsSpecificTag': '验证失效仅作用于指定标签。',
        'TestInvalidateUnstartedTemplateBuilds_DoesNotAffectOtherTemplates': '验证不影响其他模板的构建。',
        'TestInvalidateUnstartedTemplateBuilds_DoesNotAffectNonWaitingBuilds': '验证不影响非等待状态的构建。',
        'TestInvalidateUnstartedTemplateBuilds_MultipleWaitingBuilds': '验证同时失效多个等待构建。',
        'TestInvalidateUnstartedTemplateBuilds_MultipleTagsInSingleCall': '验证单次调用传入多个标签的失效。',
    },
    'packages/db/pkg/tests/db_test.go': {
        'TestNoRowLevelSecurity': '断言数据库当前未启用 PostgreSQL 行级安全策略。',
    },
    'packages/db/pkg/tests/snapshots/snapshot_latest_assignment_test.go': {
        'TestGetLastSnapshot_ReturnsLatestAssignment': '验证获取最近快照分配的结果。',
        'TestGetLastSnapshot_OnlyReturnsSuccessBuilds': '验证仅返回成功构建对应的快照。',
        'TestGetSnapshotsWithCursor_ReturnsLatestAssignment': '验证游标分页下返回最近分配。',
        'TestGetLastSnapshot_BuildSharedWithOtherTemplate': '验证构建被其他模板共享时的快照行为。',
        'TestGetLastSnapshot_IgnoresNonDefaultTags': '验证忽略非默认标签的快照。',
        'TestGetLastSnapshot_AssignmentOrderDifferentFromBuildOrder': '验证分配顺序与构建顺序不同时的结果。',
    },
    'packages/db/pkg/tests/snapshots/upsert_snapshot_test.go': {
        'TestUpsertSnapshot_NewSnapshot': '验证新建快照时的 upsert 行为。',
        'TestUpsertSnapshot_ExistingSnapshot': '验证快照已存在时的 upsert 行为。',
    },
    'packages/db/pkg/tests/template_aliases/delete_template_aliases_test.go': {
        'TestDeleteTemplateAliases_Success': '验证删除存在的模板别名。',
        'TestDeleteTemplateAliases_NoAlias': '验证删除不存在的模板别名场景。',
    },
    'packages/db/pkg/tests/template_aliases/namespace_resolution_test.go': {
        'TestGetTemplateByAlias_MatchesNamespace': '验证按别名查找时按命名空间匹配。',
        'TestGetTemplateByAlias_MatchesNullNamespace': '验证 null 命名空间的别名匹配。',
        'TestGetTemplateByAlias_NotFound': '验证未找到时的错误路径。',
        'TestGetTemplateById': '验证按 ID 查找模板。',
        'TestTwoTeamsCanHaveSameAliasName': '验证两个团队可以使用相同的别名名。',
        'TestCheckAliasExistsInNamespace_FindsInSameNamespace': '验证同命名空间下别名存在性检查。',
        'TestCheckAliasExistsInNamespace_NotFoundInDifferentNamespace': '验证跨命名空间不命中。',
        'TestCheckAliasExistsInNamespace_NullNamespaceForPromotedTemplates': '验证提升模板的 null 命名空间存在性检查。',
    },
    'packages/db/pkg/tests/templates/delete_template_test.go': {
        'envDeleted': '检测环境是否被软删除的辅助函数。',
        'TestDeleteTemplate_SoftDeletesEnvAndPreservesStructure': '验证模板删除时软删除 env 同时保留其结构关联。',
    },
}


def complexity_for(file_path, lines):
    """Infer complexity from line count and category."""
    if 'tests/' in file_path:
        if lines < 80:
            return 'simple'
        elif lines < 200:
            return 'moderate'
        else:
            return 'complex'
    if lines < 50:
        return 'simple'
    elif lines < 200:
        return 'moderate'
    else:
        return 'complex'


# ===================== BUILD NODES =====================
nodes = []
node_ids = set()
edges = []

# File nodes
for r in data['results']:
    p = r['path']
    meta = file_meta.get(p, {'summary': '', 'tags': []})
    fid = f'file:{p}'
    node_ids.add(fid)
    nodes.append({
        'id': fid,
        'type': 'file',
        'name': p.split('/')[-1],
        'filePath': p,
        'summary': meta['summary'],
        'tags': meta['tags'],
        'complexity': complexity_for(p, r.get('totalLines', 0)),
    })

# Function/class nodes
for r in data['results']:
    p = r['path']
    is_test = '/pkg/tests/' in p

    # Classes
    for c in r.get('classes', []):
        cid = f'class:{p}:{c["name"]}'
        if cid in node_ids:
            continue
        line_range = [c['startLine'], c['endLine']]
        # Significance filter
        if c['endLine'] - c['startLine'] < 20 and len(c.get('methods', [])) < 2:
            # skip trivial classes (structs with < 20 lines and < 2 methods)
            continue
        if (p, c['name']) in class_meta:
            m = class_meta[(p, c['name'])]
            summary = m['summary']
            tags = m['tags']
        else:
            summary = f'类型 {c["name"]}。'
            tags = ['data-model']
        node_ids.add(cid)
        nodes.append({
            'id': cid,
            'type': 'class',
            'name': c['name'],
            'filePath': p,
            'lineRange': line_range,
            'summary': summary,
            'tags': tags,
            'complexity': 'simple' if (line_range[1] - line_range[0] < 30) else 'moderate',
        })

    # Functions
    for fn in r.get('functions', []):
        name = fn['name']
        fid = f'function:{p}:{name}'
        if fid in node_ids:
            continue
        line_range = [fn['startLine'], fn['endLine']]
        body_len = line_range[1] - line_range[0]

        # Significance filter
        is_test_func = name.startswith('Test') or name.startswith('test')
        # Always include exported functions
        if body_len < 10 and not is_test_func:
            # exported helper (e.g., getBuildVersions, envDeleted, testConfig) - include if exported
            # Check if exported
            is_exported = any(e['name'] == name for e in r.get('exports', []))
            if not is_exported:
                continue

        # Get metadata
        if is_test and is_test_func:
            if name in test_func_meta.get(p, {}):
                summary = test_func_meta[p][name]
                tags = ['test', 'integration']
            else:
                summary = f'测试函数 {name}。'
                tags = ['test']
        elif (p, name) in func_meta:
            m = func_meta[(p, name)]
            summary = m['summary']
            tags = m['tags']
        elif not is_test:
            # Generic fallback
            summary = f'函数 {name}。'
            tags = ['function']
        else:
            continue  # skip unknown test helper

        node_ids.add(fid)
        nodes.append({
            'id': fid,
            'type': 'function',
            'name': name,
            'filePath': p,
            'lineRange': line_range,
            'summary': summary,
            'tags': tags,
            'complexity': 'simple' if body_len < 30 else 'moderate',
        })


# ===================== BUILD EDGES =====================
# contains edges (only for nodes that exist in our node_ids set)
for r in data['results']:
    p = r['path']
    fid = f'file:{p}'
    for c in r.get('classes', []):
        cid = f'class:{p}:{c["name"]}'
        if cid in node_ids:
            edges.append({
                'source': fid,
                'target': cid,
                'type': 'contains',
                'direction': 'forward',
                'weight': 1.0,
            })
    for fn in r.get('functions', []):
        fnid = f'function:{p}:{fn["name"]}'
        if fnid in node_ids:
            edges.append({
                'source': fid,
                'target': fnid,
                'type': 'contains',
                'direction': 'forward',
                'weight': 1.0,
            })

# exports edges (for exported funcs/classes) - only if node exists
for r in data['results']:
    p = r['path']
    fid = f'file:{p}'
    for e in r.get('exports', []):
        ename = e['name']
        # Try class first
        cid = f'class:{p}:{ename}'
        fid_fn = f'function:{p}:{ename}'
        if cid in node_ids:
            edges.append({
                'source': fid,
                'target': cid,
                'type': 'exports',
                'direction': 'forward',
                'weight': 0.8,
            })
        elif fid_fn in node_ids:
            edges.append({
                'source': fid,
                'target': fid_fn,
                'type': 'exports',
                'direction': 'forward',
                'weight': 0.8,
            })

# imports edges (from batchImportData)
for f in files:
    p = f['path']
    if f['fileCategory'] != 'code':
        continue
    imp_list = imports_map.get(p, [])
    for imp_path in imp_list:
        edges.append({
            'source': f'file:{p}',
            'target': f'file:{imp_path}',
            'type': 'imports',
            'direction': 'forward',
            'weight': 0.7,
        })

# tested_by edges: test files -> production files
test_to_prod = {}
for r in data['results']:
    p = r['path']
    if '/pkg/tests/' in p:
        imp_list = imports_map.get(p, [])
        for imp_path in imp_list:
            if '/pkg/tests/' not in imp_path:
                # production file
                if imp_path not in test_to_prod:
                    test_to_prod[imp_path] = []
                test_to_prod[imp_path].append(p)

for prod_path, test_paths in test_to_prod.items():
    prod_id = f'file:{prod_path}'
    for tp in test_paths:
        test_id = f'file:{tp}'
        # edge direction: production -> test (canonical)
        if prod_id in node_ids and test_id in node_ids:
            edges.append({
                'source': prod_id,
                'target': test_id,
                'type': 'tested_by',
                'direction': 'forward',
                'weight': 0.5,
            })

# Remove self-referencing
edges = [e for e in edges if e['source'] != e['target']]

print(f'Total nodes: {len(nodes)}')
print(f'Total edges: {len(edges)}')

# Verify import edge count
import_total = sum(len(v) for v in imports_map.values())
import_edges = [e for e in edges if e['type'] == 'imports']
print(f'Import edges: {len(import_edges)} / {import_total}')

# Save full graph to tmp for partitioning
out = {
    'nodes': nodes,
    'edges': edges,
}
with open('/Users/joohwan/GolandProjects/infra/.understand-anything/tmp/batch24_full.json', 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
print('Saved full graph.')