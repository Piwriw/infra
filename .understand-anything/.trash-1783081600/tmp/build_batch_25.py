#!/usr/bin/env python3
"""Generate batch-25.json graph data from extraction results."""
import json
import os

EXTRACT_PATH = '/Users/joohwan/GolandProjects/infra/.understand-anything/tmp/ua-file-extract-results-25.json'
BATCH_PATH = '/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batches.json'
OUT_DIR = '/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate'

with open(EXTRACT_PATH) as f:
    ext = json.load(f)

with open(BATCH_PATH) as f:
    batches_data = json.load(f)

batch = batches_data['batches'][24]
batch_imports = batch['batchImportData']
neighbor_map = batch.get('neighborMap', {})

# File-level descriptions (Chinese)
FILE_SUMMARIES = {
    'packages/db/pkg/tests/templates/get_team_templates_with_cursor_test.go': (
        '测试 GetTeamTemplatesWithCursor 查询的降序排序与游标分页行为。',
        'test', 'moderate',
    ),
    'packages/db/pkg/tests/templates/list_team_templates_test.go': (
        '测试 ListTeamTemplates 系列查询的排序、过滤与分页边界，并验证仪表盘 schema 协助函数。',
        'test', 'complex',
    ),
    'packages/db/pkg/tests/templates/template_assignment_ordering_test.go': (
        '测试模板构建分配顺序与构建本身顺序的关系，确保返回结果符合预期。',
        'test', 'moderate',
    ),
    'packages/db/pkg/tests/volumes/db_test.go': (
        'Volumes 查询的集成测试，校验数据库读写逻辑。',
        'test', 'simple',
    ),
    'packages/db/pkg/testutils/db.go': (
        '测试辅助工具，使用 testcontainers 启动 PostgreSQL 容器并应用迁移，为 db 包测试提供隔离的数据库环境。',
        'test-utils', 'moderate',
    ),
    'packages/db/pkg/testutils/queries.go': (
        '测试辅助函数库，提供创建测试团队、模板、构建、快照等公共测试夹具，便于多个测试套件共享数据准备逻辑。',
        'test-utils', 'complex',
    ),
    'packages/db/pkg/testutils/queries/db.go': (
        '测试工具的 sqlc 查询封装，提供 DBTX 接口与 Queries 类型用于单元测试。',
        'utility', 'simple',
    ),
    'packages/db/pkg/testutils/queries/models.go': (
        '测试工具的查询结果模型定义，包含 InsertTestTeamParams 等参数类型。',
        'data-model', 'moderate',
    ),
    'packages/db/pkg/testutils/queries/tests.sql.go': (
        '测试工具的 sqlc 生成代码，提供 InsertTestTeam、GetLastInsertedEnvID 等查询函数。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/pkg/types/db.go': (
        '自定义 PostgreSQL 类型映射基础接口，定义 DBTX 抽象用于 sqlc 查询。',
        'type-definition', 'simple',
    ),
    'packages/db/pkg/types/types.go': (
        '自定义数据库类型集合，包含 JSONBStringMap、Nullable 字符串、UUID、Int64 等 PostgreSQL 兼容类型的扫描/编码实现。',
        'data-model', 'moderate',
    ),
    'packages/db/pkg/types/types_test.go': (
        'types 包的单元测试，验证 JSONBStringMap、UUID 等自定义类型的编解码与 NULL 处理。',
        'test', 'moderate',
    ),
    'packages/db/queries/active_template_builds.sql.go': (
        'sqlc 生成的 ActiveTemplateBuilds 查询代码，用于查询指定模板正在进行或最近完成的构建。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/check_alias_exists.sql.go': (
        'sqlc 生成的 CheckAliasExists 查询代码，用于判断给定别名是否已存在。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/create_alias.sql.go': (
        'sqlc 生成的 CreateAlias 查询代码，向 env_aliases 表插入新别名。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/create_new_snapshot.sql.go': (
        'sqlc 生成的 CreateNewSnapshot 查询代码，用于创建新的 env 快照记录。',
        'sqlc-generated', 'moderate',
    ),
    'packages/db/queries/create_snapshot_template_env.sql.go': (
        'sqlc 生成的 CreateSnapshotTemplateEnv 查询代码，创建快照与模板环境关联。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/create_template.sql.go': (
        'sqlc 生成的 CreateTemplate 查询代码，向 envs 表插入新模板记录。',
        'sqlc-generated', 'moderate',
    ),
    'packages/db/queries/create_template_build_assignment.sql.go': (
        'sqlc 生成的 CreateTemplateBuildAssignment 查询代码，关联构建与模板。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/db.go': (
        'sqlc 生成的 DBTX 接口与 Queries 类型定义，作为所有查询文件的共享基础。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/delete_old_aliases.sql.go': (
        'sqlc 生成的 DeleteOldAliases 查询代码，按条件删除过期的别名。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/delete_template.sql.go': (
        'sqlc 生成的 DeleteTemplate 查询代码，按 ID 软删除模板。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/delete_template_build_assignment.sql.go': (
        'sqlc 生成的 DeleteTemplateBuildAssignment 查询代码，解除构建与模板的关联。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/exists_template_snapshots.sql.go': (
        'sqlc 生成的 ExistsTemplateSnapshots 查询代码，校验模板是否存在快照。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/finish_template_build.sql.go': (
        'sqlc 生成的 FinishTemplateBuild 查询代码，标记构建为已完成。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/get_active_clusters.sql.go': (
        'sqlc 生成的 GetActiveClusters 查询代码，查询当前活跃的集群节点信息。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/get_build_info.sql.go': (
        'sqlc 生成的 GetBuildInfo 查询代码，获取指定构建的详细信息。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/get_builds_paginated.sql.go': (
        'sqlc 生成的 GetTeamBuildsPage 查询代码，支持按团队分页列出构建记录，包含模板 ID 与别名关联。',
        'sqlc-generated', 'complex',
    ),
    'packages/db/queries/get_builds_statuses.sql.go': (
        'sqlc 生成的 GetBuildsStatuses 查询代码，按构建 ID 列表批量获取构建状态。',
        'sqlc-generated', 'simple',
    ),
    'packages/db/queries/get_concurrent_template_builds.sql.go': (
        'sqlc 生成的 GetConcurrentTemplateBuilds 查询代码，统计同一模板的并发构建数。',
        'sqlc-generated', 'simple',
    ),
}

# Build nodes and edges
nodes = []
edges = []
seen_ids = set()

# Track file-level node ids
file_id_map = {}

def add_node(n):
    if n['id'] in seen_ids:
        return
    seen_ids.add(n['id'])
    nodes.append(n)

def add_edge(e):
    edges.append(e)

# 1. Create file nodes
for r in ext['results']:
    path = r['path']
    summary, tag_base, complexity = FILE_SUMMARIES[path]
    # Refine tags
    tags = [tag_base, 'database', 'postgres']
    if 'test' in path or '_test.go' in path:
        tags = ['test', 'database'] + ([tag_base] if tag_base != 'test' else [])
        if 'templates' in path:
            tags.append('templates')
    if 'sql.go' in path and '_test' not in path:
        tags = ['sqlc-generated', 'database-query', 'postgres']
    if 'pkg/types' in path:
        tags = ['type-definition', 'database', 'postgres']
    if 'pkg/testutils' in path:
        tags = ['test-utils', 'database']
    if 'queries/db.go' == path.split('/')[-1]:
        tags = ['sqlc-generated', 'database-query']
    node = {
        'id': f'file:{path}',
        'type': 'file',
        'name': path.split('/')[-1],
        'filePath': path,
        'summary': summary,
        'tags': tags[:5],
        'complexity': complexity,
    }
    add_node(node)
    file_id_map[path] = f'file:{path}'

# 2. Create function/class nodes (only for significant ones)
for r in ext['results']:
    path = r['path']
    is_sqlc_gen = path.startswith('packages/db/queries/') and path.endswith('.sql.go') and 'db.go' not in path.split('/')[-1]
    is_test_utils = path.startswith('packages/db/pkg/testutils/') and path.endswith('.sql.go')
    is_pkg_testutils_db = path.startswith('packages/db/pkg/testutils/queries/')

    for fn in r.get('functions', []):
        lines = fn['endLine'] - fn['startLine'] + 1
        # For sqlc generated, skip all functions (they are wrappers)
        if is_sqlc_gen or is_test_utils:
            continue
        # Skip trivial one-liners
        if lines < 10 and not any(e['name'] == fn['name'] for e in r.get('exports', [])):
            continue
        # Significant threshold: 10+ lines OR exported
        is_exported = any(e['name'] == fn['name'] for e in r.get('exports', []))
        if lines < 10 and not is_exported:
            continue
        # Build summary based on context
        if path.endswith('_test.go'):
            fn_summary = f'测试函数 {fn["name"]}，验证数据库相关行为。'
            fn_tags = ['test', 'database']
            if lines >= 30:
                fn_tags.append('integration-test')
        else:
            fn_summary = f'函数 {fn["name"]}，实现 {path.split("/")[-1]} 中的业务逻辑。'
            fn_tags = ['function']
            if 'Database' in path or 'testutils' in path:
                fn_tags.append('test-utils')
            else:
                fn_tags.append('database')
        add_node({
            'id': f'function:{path}:{fn["name"]}',
            'type': 'function',
            'name': fn['name'],
            'filePath': path,
            'lineRange': [fn['startLine'], fn['endLine']],
            'summary': fn_summary,
            'tags': fn_tags[:5],
            'complexity': 'complex' if lines > 50 else ('moderate' if lines >= 20 else 'simple'),
        })
        # contains edge
        add_edge({
            'source': f'file:{path}',
            'target': f'function:{path}:{fn["name"]}',
            'type': 'contains',
            'direction': 'forward',
            'weight': 1.0,
        })

    for cls in r.get('classes', []):
        lines = cls['endLine'] - cls['startLine'] + 1
        # For sqlc generated, skip all classes
        if is_sqlc_gen or is_test_utils:
            continue
        methods_count = len(cls.get('methods', []))
        # Significant threshold
        if methods_count < 2 and lines < 20:
            continue
        # Build summary
        if 'Database' in cls['name'] and 'testutils' in path:
            cls_summary = '测试数据库封装类型，聚合 sqlc 客户端、Auth 客户端与测试查询实例。'
            cls_tags = ['data-model', 'test-utils', 'database']
        elif 'queries' in path and 'pkg/testutils' in path:
            cls_summary = f'sqlc 生成的查询对象类型 {cls["name"]}。'
            cls_tags = ['data-model', 'sqlc-generated']
        elif 'JSONBStringMap' in cls['name'] or 'UUID' in cls['name'] or 'Nullable' in cls['name']:
            cls_summary = f'自定义 PostgreSQL 兼容类型 {cls["name"]}，处理 jsonb/UUID/NULL 编码。'
            cls_tags = ['type-definition', 'database']
        else:
            cls_summary = f'类型 {cls["name"]}，定义于 {path.split("/")[-1]}。'
            cls_tags = ['data-model']
        add_node({
            'id': f'class:{path}:{cls["name"]}',
            'type': 'class',
            'name': cls['name'],
            'filePath': path,
            'lineRange': [cls['startLine'], cls['endLine']],
            'summary': cls_summary,
            'tags': cls_tags[:5],
            'complexity': 'moderate' if lines < 50 else 'complex',
        })
        # contains edge
        add_edge({
            'source': f'file:{path}',
            'target': f'class:{path}:{cls["name"]}',
            'type': 'contains',
            'direction': 'forward',
            'weight': 1.0,
        })

# 3. Create imports edges (1:1 from batchImportData)
for path, import_list in batch_imports.items():
    src = f'file:{path}'
    if src not in seen_ids:
        # skip if file not in batch
        continue
    for imported in import_list:
        add_edge({
            'source': src,
            'target': f'file:{imported}',
            'type': 'imports',
            'direction': 'forward',
            'weight': 0.7,
        })

# Write output
os.makedirs(OUT_DIR, exist_ok=True)
output = {
    'nodes': nodes,
    'edges': edges,
}

node_count = len(nodes)
edge_count = len(edges)
print(f'nodeCount={node_count}, edgeCount={edge_count}')

# Need to split? threshold 60 nodes / 120 edges
if node_count <= 60 and edge_count <= 120:
    out_path = os.path.join(OUT_DIR, 'batch-25.json')
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f'Written: {out_path}')
else:
    import math
    parts = math.ceil(max(node_count / 60, edge_count / 120))
    print(f'Need {parts} parts')
    # Sort files alphabetically
    file_paths = sorted({n['filePath'] for n in nodes if n.get('filePath')})
    chunk_size = math.ceil(len(file_paths) / parts)
    file_chunks = [file_paths[i:i+chunk_size] for i in range(0, len(file_paths), chunk_size)]
    for k, chunk in enumerate(file_chunks, 1):
        chunk_set = set(chunk)
        chunk_nodes = [n for n in nodes if n.get('filePath') is None or n.get('filePath') in chunk_set]
        chunk_node_ids = {n['id'] for n in chunk_nodes}
        chunk_edges = [e for e in edges if e['source'] in chunk_node_ids]
        out_path = os.path.join(OUT_DIR, f'batch-25-part-{k}.json')
        with open(out_path, 'w') as f:
            json.dump({'nodes': chunk_nodes, 'edges': chunk_edges}, f, indent=2)
        print(f'Part {k}: nodes={len(chunk_nodes)}, edges={len(chunk_edges)} -> {out_path}')