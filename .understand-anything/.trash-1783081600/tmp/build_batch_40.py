#!/usr/bin/env python3
"""Build the batch-40 graph output."""
import json

PROJECT_ROOT = '/Users/joohwan/GolandProjects/infra'

# Read the extraction results
with open(f'{PROJECT_ROOT}/.understand-anything/tmp/ua-file-extract-results-40.json') as f:
    extract = json.load(f)

# Read the batch import data and neighbor map from batches.json
with open(f'{PROJECT_ROOT}/.understand-anything/intermediate/batches.json') as f:
    batches = json.load(f)

batch = batches['batches'][39]
batch_imports = batch.get('batchImportData', {})

# Helper to summarize file
def file_summary(path):
    p = path.lower()
    if 'sandbox_network_out' in p:
        return "集成测试套件,验证 sandbox 出站流量防火墙规则(IP、域名、CIDR、UDP/TCP)的语义正确性。"
    if 'sandbox_network_update' in p:
        return "集成测试套件,验证运行中 sandbox 的网络配置(network config)可被 PUT 接口动态更新并生效。"
    if 'sandbox_pause' in p:
        return "集成测试套件,验证 sandbox 通过 API 暂停(pause)后资源保留、状态正确以及幂等性。"
    if 'sandbox_rapid_pause_resume' in p:
        return "集成测试套件,验证 sandbox 在快照链(snapshot chain)上连续快速 pause/resume 时数据完整性。"
    if 'sandbox_refresh' in p:
        return "集成测试套件,验证 sandbox 续期(refresh)接口对运行中 sandbox 延长超时的行为,以及越权访问和资源不存在场景。"
    if 'sandbox_resume' in p:
        return "集成测试套件,验证 paused sandbox 通过 API 恢复(resume)后能继续工作,以及跨团队访问控制。"
    if 'sandbox_secure' in p:
        return "集成测试套件,验证带 envd 安全访问令牌(secure envd)的 sandbox 创建以及关闭公网访问的组合配置。"
    if 'sandbox_test' in p and 'pause' not in p and 'resume' not in p and 'timeout' not in p and 'network' not in p and 'refresh' not in p and 'secure' not in p and 'rapid' not in p:
        return "集成测试套件,验证 sandbox 的核心 CRUD 行为:创建、resume 不存在的 sandbox、resume 带安全令牌的 sandbox、暂停不存在的 sandbox。"
    if 'sandbox_timeout' in p:
        return "集成测试套件,验证 sandbox 超时(timeout)设置的持久化、跨团队访问限制以及对暂停中 sandbox 的修改。"
    if 'snapshot_template' in p:
        return "集成测试套件,验证从运行中 sandbox 创建快照模板(snapshot template),以及基于快照模板创建新 sandbox 的完整链路和并发安全。"
    if 'build_template' in p:
        return "集成测试套件,验证模板构建(build template)支持 RUN/ENV/WORKDIR/COPY/FUSE 等指令、缓存、源镜像、文件上传和启动命令。"
    if 'delete_template' in p:
        return "集成测试套件,验证模板删除接口的鉴权(API key)和跨团队访问拒绝行为。"
    if 'request_build' in p:
        return "集成测试套件,验证模板构建请求(request build)的参数校验:CPU、内存上下限、奇偶校验和 2 的整除性。"
    if 'status_build' in p:
        return "集成测试套件,验证构建状态查询接口对非法状态值的拒绝行为。"
    if 'template_list' in p and 'v2' not in p:
        return "集成测试套件,验证模板列表接口在 API key、Team ID 组合下的鉴权与跨团队访问拒绝。"
    if 'template_list_v2' in p:
        return "集成测试套件,验证模板列表 V2 接口的鉴权、分页(pagination)及跨团队访问拒绝。"
    if 'template_tags' in p:
        return "集成测试套件,验证模板标签(tag)的分配、删除、按标签创建 sandbox、build 关联以及 latest 标签的语义与重赋值顺序。"
    if 'template_update' in p:
        return "集成测试套件,验证模板元数据更新(可见性、名称等)接口的鉴权和跨团队隔离。"
    if 'volumes/crud' in p:
        return "集成测试套件,验证 volume 的完整 CRUD 链路(创建、读取、更新、删除)以及数据持久性。"
    if 'auth_filesystem_only' in p:
        return "集成测试套件,验证 filesystem-only 模式下 secured sandbox 仅允许文件系统接口访问的鉴权语义。"
    if 'auth_test' in p:
        return "集成测试套件,验证 envd 访问令牌对未授权路径、错误 token、resume 后 access token 等鉴权场景的正确拒绝。"
    if 'ca_cert_build' in p:
        return "集成测试套件,验证通过模板构建(build)注入的 CA 证书在 baked bundle 中持久化可用。"
    if 'ca_cert_reboot' in p:
        return "集成测试套件,验证 filesystem-only reboot 后之前注入的 CA 证书仍被系统信任。"
    if 'ca_cert_test' in p:
        return "集成测试套件,验证 CA 证书注入、tmpfs 存储、resume 期间轮转以及 update-ca-certificates 持久化行为。"
    if 'envd/filesystem' in p:
        return "集成测试套件,验证 envd 文件系统接口的目录列表、文件权限、stat、并发上传等行为。"
    return "Go 集成测试文件"

def file_tags(path):
    p = path.lower()
    tags = ['integration-test', 'go-test']
    if '/api/sandboxes/' in p:
        tags.extend(['sandbox', 'api-test'])
    elif '/api/templates/' in p:
        tags.extend(['template', 'api-test'])
    elif '/api/volumes/' in p:
        tags.extend(['volume', 'api-test'])
    elif '/envd/' in p:
        tags.extend(['envd', 'filesystem'])
    if 'network' in p:
        tags.append('network')
    if 'secure' in p or 'auth' in p:
        tags.append('security')
    if 'pause' in p or 'resume' in p:
        tags.append('lifecycle')
    if 'timeout' in p:
        tags.append('timeout')
    if 'snapshot' in p:
        tags.append('snapshot')
    if 'build' in p:
        tags.append('build')
    if 'tag' in p:
        tags.append('tag')
    if 'update' in p:
        tags.append('update')
    if 'ca_cert' in p:
        tags.append('tls')
        tags.append('ca-cert')
    return tags[:5]

def file_complexity(r):
    non_empty = r.get('nonEmptyLines', 0)
    funcs = len(r.get('functions', []))
    if non_empty > 300 or funcs > 10:
        return 'complex'
    if non_empty > 100 or funcs > 3:
        return 'moderate'
    return 'simple'

def func_complexity(start, end):
    lines = end - start + 1
    if lines >= 30:
        return 'complex'
    if lines >= 10:
        return 'moderate'
    return 'simple'

# Build nodes
nodes = []
edges = []

# Map file path -> file node id
file_node_ids = {}
for r in extract['results']:
    file_path = r['path']
    file_id = f"file:{file_path}"
    file_node_ids[file_path] = file_id
    name = file_path.split('/')[-1]

    node = {
        "id": file_id,
        "type": "file",
        "name": name,
        "filePath": file_path,
        "summary": file_summary(file_path),
        "tags": file_tags(file_path),
        "complexity": file_complexity(r),
    }
    nodes.append(node)

    # Function nodes
    for fn in r.get('functions', []):
        start = fn.get('startLine', 0)
        end = fn.get('endLine', 0)
        if (end - start + 1) < 10 and not (fn['name'].startswith('Test') or fn['name'].startswith('verify') or fn['name'].startswith('assert') or fn['name'].startswith('load') or fn['name'].startswith('default') or fn['name'].startswith('wait') or fn['name'].startswith('start') or fn['name'].startswith('seed') or fn['name'].startswith('find') or fn['name'].startswith('post') or fn['name'].startswith('read') or fn['name'].startswith('inject') or fn['name'].startswith('sandbox') or fn['name'].startswith('create') or fn['name'].startswith('put') or fn['name'].startswith('build') or fn['name'].startswith('upload') or fn['name'].startswith('compute') or fn['name'].startswith('generate')):
            # Skip trivial helper functions below 10 lines (e.g., ptrS)
            continue

        fn_id = f"function:{file_path}:{fn['name']}"
        fn_summary = f"测试辅助函数 {fn['name']}({', '.join(fn.get('params', []))}),行 {start}-{end}。"
        fn_tags = ['test-helper']
        if fn['name'].startswith('Test'):
            fn_tags = ['test-case']
        elif fn['name'].startswith('verify') or fn['name'].startswith('assert') or fn['name'].startswith('wait') or fn['name'].startswith('load') or fn['name'].startswith('find') or fn['name'].startswith('start') or fn['name'].startswith('seed') or fn['name'].startswith('read'):
            fn_tags = ['assertion', 'test-helper']
        else:
            fn_tags = ['test-helper', 'utility']

        nodes.append({
            "id": fn_id,
            "type": "function",
            "name": fn['name'],
            "filePath": file_path,
            "lineRange": [start, end],
            "summary": fn_summary,
            "tags": fn_tags,
            "complexity": func_complexity(start, end),
        })
        # contains edge
        edges.append({
            "source": file_id,
            "target": fn_id,
            "type": "contains",
            "direction": "forward",
            "weight": 1.0
        })

# Class nodes
for r in extract['results']:
    file_path = r['path']
    file_id = file_node_ids[file_path]
    for c in r.get('classes', []):
        class_name = c['name']
        # Skip tiny helper structs (under 5 lines)
        line_count = c['endLine'] - c['startLine'] + 1
        if line_count < 3:
            continue
        cls_id = f"class:{file_path}:{class_name}"
        nodes.append({
            "id": cls_id,
            "type": "class",
            "name": class_name,
            "filePath": file_path,
            "lineRange": [c['startLine'], c['endLine']],
            "summary": f"测试辅助结构体 {class_name},用于组织测试上下文数据。",
            "tags": ["test-helper", "struct"],
            "complexity": "simple" if line_count < 10 else "moderate",
        })
        edges.append({
            "source": file_id,
            "target": cls_id,
            "type": "contains",
            "direction": "forward",
            "weight": 1.0
        })

# Import edges
for file_path, imports in batch_imports.items():
    file_id = file_node_ids.get(file_path)
    if not file_id:
        continue
    for imp_path in imports:
        target_id = f"file:{imp_path}"
        edges.append({
            "source": file_id,
            "target": target_id,
            "type": "imports",
            "direction": "forward",
            "weight": 0.7
        })

# Add tested_by edges - tests test sandbox/template API
# Each test file tests the production code
production_targets = {
    "tests/integration/internal/tests/api/sandboxes/": [
        "packages/api/internal/handlers/store.go",
        "packages/api/internal/handlers/sandbox.go",
        "packages/api/internal/handlers/sandbox_network.go",
        "packages/api/internal/handlers/sandbox_template.go",
    ],
    "tests/integration/internal/tests/api/templates/": [
        "packages/api/internal/handlers/template.go",
        "packages/api/internal/handlers/template_build.go",
        "packages/api/internal/handlers/sandbox_template.go",
    ],
    "tests/integration/internal/tests/api/volumes/": [
        "packages/api/internal/handlers/volume.go",
    ],
    "tests/integration/internal/tests/envd/": [
        "packages/envd/main.go",
        "packages/envd/internal/",
    ],
}

# tested_by edges: production -> test, but we are emitting from test file (imports include api_client etc)
# Skip these for now since we don't have the production file ids in our batch and the import edges already encode the relationship

print(f"Total nodes: {len(nodes)}")
print(f"Total edges: {len(edges)}")

# Write output
output = {
    "nodes": nodes,
    "edges": edges,
}

with open(f'{PROJECT_ROOT}/.understand-anything/intermediate/batch-40.json', 'w') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print("Written batch-40.json")