#!/usr/bin/env python3
"""Build batch-32 graph fragment."""
import json
from pathlib import Path

EXTRACT = json.load(open('/Users/joohwan/GolandProjects/infra/.understand-anything/tmp/ua-file-extract-results-31.json'))
BATCHES = json.load(open('/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batches.json'))
BATCH = BATCHES['batches'][31]
FILES = [f['path'] for f in BATCH['files']]
IMPORT_DATA = BATCH['batchImportData']

nodes = []
edges = []
seen_ids = set()

def add_node(n):
    if n['id'] in seen_ids:
        return
    seen_ids.add(n['id'])
    nodes.append(n)


# ---- helpers ----
def file_summary(path):
    name = path.split('/')[-1]
    if name == 'api.gen.go':
        return "由 OpenAPI 自动生成的 Gin server 接口、类型定义、参数结构和路由注册代码,覆盖 dashboard-api 全部 endpoints。"
    if name == 'generate.go':
        return "OpenAPI 代码生成指令文件,通过 go:generate 调用 oapi-codegen。"
    if name == 'route_conflict_test.go':
        return "测试 static 路径与 param 路径在 Gin 路由中能共存(无 panic)。"
    if name == 'model.go' and '/cfg/' in path:
        return "Dashboard-API 的配置模型,定义 Config、FailureError 以及环境变量解析与 Ory issuer/auth provider 校验逻辑。"
    if name == 'model_test.go' and '/cfg/' in path:
        return "针对 cfg.Config 解析逻辑的单元测试,覆盖 Ory JWT issuer、auth provider 解析以及失败条件的解析。"
    if name == 'admin_auth_provider_profiles.go':
        return "实现 admin 用户 profile 相关的 endpoints:解析/查询 user profiles 并转换为 API DTO。"
    if name == 'admin_teams_bootstrap.go':
        return "提供 admin teams bootstrap endpoint,引导创建 admin 团队。"
    if name == 'admin_teams_bootstrap_test.go':
        return "测试 admin team bootstrap 的成功路径、回滚行为以及缺失字段拒绝。"
    if name == 'admin_users_bootstrap.go':
        return "提供 admin users bootstrap endpoint,引导创建 admin 用户。"
    if name == 'admin_users_delete.go':
        return "实现 admin 用户的删除 endpoint。"
    if name == 'build.go':
        return "实现 GetBuildsBuildId 单个构建详情 endpoint。"
    if name == 'builds_list.go':
        return "实现 GetBuilds 列表 endpoint,包含分页游标解析、状态聚合以及多种 group-by 映射逻辑。"
    if name == 'builds_statuses.go':
        return "实现 GetBuildsStatuses endpoint,返回构建状态汇总。"
    if name == 'sandbox_record.go':
        return "实现 GetSandboxesSandboxIDRecord endpoint,获取单个 sandbox 的记录并处理未定义表错误。"
    if name == 'sandbox_record_test.go':
        return "测试 sandbox record handler 的 404 与保留期限过期行为,使用 sqlmock 模拟数据库。"
    if name == 'store.go' and '/handlers/' in path:
        return "实现 APIStore 类型,持有依赖(配置、team provision、user profile)并提供共享辅助方法(GetHealth、用户/团队 token 解析)。"
    if name == 'team_creation.go':
        return "实现 PostTeams endpoint,创建团队并基于本地策略/配置决定是否阻止。"
    if name == 'team_handlers_test.go':
        return "团队相关 handler 与 bootstrap 流程的全面单元测试,覆盖更新、成员管理、OIDC bootstrap、并发与回滚。"
    if name == 'team_members.go':
        return "实现 GetTeamsTeamIDMembers、PostTeamsTeamIDMembers、DeleteTeamsTeamIDMembersUserId 三个团队成员管理 endpoint。"
    if name == 'team_update.go':
        return "实现 PatchTeamsTeamID endpoint,更新团队资料及 profile picture。"
    if name == 'teams_list.go':
        return "实现 GetTeams endpoint,列出当前用户所属团队。"
    if name == 'teams_resolve.go':
        return "实现 GetTeamsResolve endpoint,通过 slug/identifier 解析团队。"
    if name == 'template_get.go':
        return "实现 GetTemplatesTemplateID endpoint,按 ID 获取模板详情并校验团队所有权。"
    if name == 'template_get_test.go':
        return "测试 GetTemplatesTemplateID 的可见性、空构建状态以及团队隔离。"
    if name == 'template_tag_assignments.go':
        return "实现 GetTemplatesTemplateIDTagsTagAssignments endpoint,按 tag 分页返回模板的 build 分配记录。"
    if name == 'template_tag_assignments_test.go':
        return "测试 tag assignments endpoint 的最新优先、分页稳定性、非 ready build/tag 过滤、跨团队隔离等行为。"
    if name == 'template_tags.go':
        return "实现与模板 tag 相关的三个 endpoint:GetTagsGroups、GetTagsCount、GetTagsExists,并提供 tag 分组与限制检查工具函数。"
    return ""

def file_tags(path):
    n = path.split('/')[-1]
    base = ['go', 'dashboard-api']
    if 'test' in n:
        base.append('test')
    if n in ('api.gen.go', 'generate.go'):
        base = ['generated-code', 'openapi', 'dashboard-api', 'api-server']
        if n == 'generate.go':
            base.append('codegen-trigger')
        return base
    if n in ('store.go',) and '/handlers/' in path:
        return base + ['api-handler', 'service']
    if '/cfg/' in path:
        return base + ['configuration', 'validation']
    if n.startswith('admin_'):
        return base + ['api-handler', 'admin']
    if 'team' in n:
        return base + ['api-handler', 'team-management']
    if 'build' in n:
        return base + ['api-handler', 'build-management']
    if 'sandbox' in n:
        return base + ['api-handler', 'sandbox']
    if 'template' in n:
        return base + ['api-handler', 'template']
    return base + ['api-handler']


def file_complexity(path, r):
    ne = r.get('nonEmptyLines', 0)
    if ne < 50:
        return 'simple'
    if ne < 200:
        return 'moderate'
    return 'complex'

# ---- 1) File nodes ----
result_by_path = {r['path']: r for r in EXTRACT['results']}
for f in BATCH['files']:
    path = f['path']
    r = result_by_path.get(path, {})
    name = path.split('/')[-1]
    node = {
        'id': f'file:{path}',
        'type': 'file',
        'name': name,
        'filePath': path,
        'summary': file_summary(path) or f"{name} 文件。",
        'tags': file_tags(path),
        'complexity': file_complexity(path, r),
    }
    add_node(node)

# ---- 2) Function / class nodes (significant only) ----
def significant_function(fn):
    end = fn.get('endLine', 0)
    start = fn.get('startLine', 0)
    if end - start >= 8:  # ~10 lines including signature
        return True
    return False

def significant_class(cls):
    end = cls.get('endLine', 0)
    start = cls.get('startLine', 0)
    if end - start >= 20:
        return True
    if len(cls.get('methods', [])) >= 2:
        return True
    return False

for r in EXTRACT['results']:
    path = r['path']
    fns = r.get('functions', [])
    for fn in fns:
        if not significant_function(fn):
            continue
        # Skip generated Valid methods (tiny)
        name = fn['name']
        end = fn.get('endLine', 0)
        start = fn.get('startLine', 0)
        if end - start < 8:
            continue
        # build summary based on file context
        file_n = path.split('/')[-1]
        # Per-file special handling for handler functions
        nid = f'function:{path}:{name}'
        if nid in seen_ids:
            continue
        # Build summary
        if 'test' in file_n.lower() or name.startswith('Test') or name.startswith('Benchmark'):
            summary = f"测试函数 {name}。"
        elif file_n == 'api.gen.go':
            if name == 'RegisterHandlers':
                summary = "将所有 dashboard API endpoints 注册到默认 Gin engine。"
            elif name == 'RegisterHandlersWithOptions':
                summary = "带自定义 options 注册 dashboard API handlers,支持 base router/错误中间件配置。"
            elif name == 'PathToRawSpec':
                summary = "返回 OpenAPI spec 路径。"
            elif name == 'GetSpec':
                summary = "返回 HTTP handler,提供 OpenAPI JSON spec 路由。"
            elif name == 'GetSwagger':
                summary = "提供 Swagger UI 路由。"
            elif name == 'decodeSpec' or name == 'decodeSpecCached':
                summary = "解码(并缓存)OpenAPI spec 为 runtime 格式。"
            elif name == 'GetSpecJSON':
                summary = "返回 spec 的 JSON byte 表示。"
            elif name.startswith('Valid') and name != 'Validate':
                summary = "openapi validator 生成的参数验证辅助方法。"
            else:
                summary = f"openapi 生成的 endpoint handler {name}。"
        else:
            summary = f"{name} 函数。"
        node = {
            'id': nid,
            'type': 'function',
            'name': name,
            'filePath': path,
            'lineRange': [start, end],
            'summary': summary,
            'tags': file_tags(path)[:3] + ['function'],
            'complexity': 'moderate' if end - start < 60 else 'complex',
        }
        add_node(node)

    for cls in r.get('classes', []):
        if not significant_class(cls):
            continue
        name = cls['name']
        nid = f'class:{path}:{name}'
        if nid in seen_ids:
            continue
        file_n = path.split('/')[-1]
        if file_n == 'api.gen.go' and name in ('ServerInterface', 'ServerInterfaceWrapper'):
            summary = "openapi 生成的 dashboard API server 接口,所有 endpoint handler 需实现此接口。"
            tags = ['generated-code', 'server-interface', 'api-handler']
        elif file_n == 'api.gen.go' and name == 'GinServerOptions':
            summary = "openapi 生成的 server options,用于自定义 base router 及错误处理。"
            tags = ['generated-code', 'configuration']
        elif name == 'APIStore':
            summary = "Dashboard-API 的依赖容器与共享 store,持有配置、team provision 与 user profile 工厂。"
            tags = ['go', 'dashboard-api', 'service', 'dependency-injection']
        elif name == 'Config':
            summary = "Dashboard API 的环境变量配置模型。"
            tags = ['configuration', 'data-model']
        elif name == 'FailureError':
            summary = "配置解析失败错误类型,Unwrap 可恢复底层错误。"
            tags = ['error-type']
        else:
            # Avoid creating node for trivial data DTO structs in api.gen.go
            if file_n == 'api.gen.go':
                continue
            summary = f"{name} 类型。"
            tags = file_tags(path)[:3] + ['data-model']
        node = {
            'id': nid,
            'type': 'class',
            'name': name,
            'filePath': path,
            'lineRange': [cls.get('startLine'), cls.get('endLine')],
            'summary': summary,
            'tags': tags,
            'complexity': 'moderate',
        }
        add_node(node)

# ---- 3) Edges ----
# contains: file -> function/class
for r in EXTRACT['results']:
    path = r['path']
    file_id = f'file:{path}'
    for fn in r.get('functions', []):
        if not significant_function(fn):
            continue
        nid = f'function:{path}:{fn["name"]}'
        if nid in seen_ids:
            edges.append({'source': file_id, 'target': nid, 'type': 'contains', 'direction': 'forward', 'weight': 1.0})
    for cls in r.get('classes', []):
        if not significant_class(cls):
            continue
        nid = f'class:{path}:{cls["name"]}'
        if nid in seen_ids:
            edges.append({'source': file_id, 'target': nid, 'type': 'contains', 'direction': 'forward', 'weight': 1.0})

# exports: file -> function/class for exported ones matching ExportNames
export_match = {
    'PostAdminTeamsBootstrap',
    'PostAdminUserProfilesResolve', 'PostAdminUserProfilesByEmail', 'GetAdminUserProfilesUserId',
    'PostAdminUsersBootstrap', 'DeleteAdminUsersUserId',
    'GetBuildsBuildId', 'GetBuilds', 'GetBuildsStatuses',
    'GetSandboxesSandboxIDRecord',
    'APIStore', 'NewAPIStore',
    'PostTeams',
    'GetTemplatesTemplateID', 'GetTemplatesTemplateIDTagsTagAssignments',
    'GetTemplatesTemplateIDTagsGroups', 'GetTemplatesTemplateIDTagsCount', 'GetTemplatesTemplateIDTagsExists',
    'Config', 'FailureError', 'Error', 'Unwrap', 'ParseFailureCondition', 'Parse', 'validateOryConfig',
}

for r in EXTRACT['results']:
    path = r['path']
    file_id = f'file:{path}'
    for fn in r.get('functions', []):
        if fn['name'] in export_match:
            nid = f'function:{path}:{fn["name"]}'
            if nid in seen_ids:
                edges.append({'source': file_id, 'target': nid, 'type': 'exports', 'direction': 'forward', 'weight': 0.8})
    for cls in r.get('classes', []):
        if cls['name'] in ('APIStore', 'Config', 'FailureError'):
            nid = f'class:{path}:{cls["name"]}'
            if nid in seen_ids:
                edges.append({'source': file_id, 'target': nid, 'type': 'exports', 'direction': 'forward', 'weight': 0.8})

# imports: 1:1 emission from IMPORT_DATA
for file_path, imports in IMPORT_DATA.items():
    source = f'file:{file_path}'
    for target_path in imports:
        edges.append({
            'source': source,
            'target': f'file:{target_path}',
            'type': 'imports',
            'direction': 'forward',
            'weight': 0.7,
        })

# tested_by: handlers / store endpoints -> corresponding test files
test_pairs = [
    ('packages/dashboard-api/internal/handlers/admin_teams_bootstrap.go',
     'packages/dashboard-api/internal/handlers/admin_teams_bootstrap_test.go'),
    ('packages/dashboard-api/internal/handlers/sandbox_record.go',
     'packages/dashboard-api/internal/handlers/sandbox_record_test.go'),
    ('packages/dashboard-api/internal/handlers/template_get.go',
     'packages/dashboard-api/internal/handlers/template_get_test.go'),
    ('packages/dashboard-api/internal/handlers/template_tag_assignments.go',
     'packages/dashboard-api/internal/handlers/template_tag_assignments_test.go'),
    ('packages/dashboard-api/internal/cfg/model.go',
     'packages/dashboard-api/internal/cfg/model_test.go'),
]
for prod, test in test_pairs:
    if f'file:{prod}' in seen_ids and f'file:{test}' in seen_ids:
        edges.append({
            'source': f'file:{prod}',
            'target': f'file:{test}',
            'type': 'tested_by',
            'direction': 'forward',
            'weight': 0.5,
        })

# ---- output ----
import_count = sum(1 for e in edges if e['type'] == 'imports')
print(f"Total nodes: {len(nodes)}, total edges: {len(edges)}, imports: {import_count}")

output = {'nodes': nodes, 'edges': edges}
Path('/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batch-32.json').write_text(json.dumps(output, indent=2, ensure_ascii=False))
print("Written /Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batch-32.json")
