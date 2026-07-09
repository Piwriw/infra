#!/usr/bin/env node
// Build final layer assignment for E2B Infrastructure (3-10 layers)

const fs = require('fs');

const d = JSON.parse(fs.readFileSync('/Users/joohwan/GolandProjects/infra/.understand-anything/tmp/architecture-input.json', 'utf8'));
const allNodeIds = d.fileNodes.map(n => n.id);
const totalNodes = allNodeIds.length;
const assigned = new Set();
const layers = [];

function addLayer(id, name, description, nodeIds) {
  if (nodeIds.length === 0) {
    console.error('WARN: empty layer', id);
    return;
  }
  for (const nid of nodeIds) {
    if (!allNodeIds.includes(nid)) {
      console.error('ERROR: unknown node id', nid, 'in layer', id);
      process.exit(1);
    }
    if (assigned.has(nid)) {
      console.error('ERROR: duplicate assignment of', nid, 'in layer', id);
      process.exit(1);
    }
    assigned.add(nid);
  }
  layers.push({ id, name, description, nodeIds });
  console.log(`Layer ${id}: ${nodeIds.length} files`);
}

function filterStrict(prefix) {
  return d.fileNodes.filter(n => n.filePath === prefix || n.filePath.startsWith(prefix + '/')).map(n => n.id);
}

// L1: API Service
addLayer('layer:api-service', 'API 服务层', 'E2B REST API 服务 (Gin 框架),处理客户端请求、编排 orchestrator 与 PostgreSQL,提供 OpenAPI 生成 (oapi-codegen)、API key/access token/OIDC 鉴权、模板缓存、集群管理、sandbox 生命周期等 HTTP 端点。', filterStrict('packages/api'));

// L2: Orchestrator Service (Firecracker VM lifecycle)
addLayer('layer:orchestrator-service', '编排服务层 (Orchestrator)', 'Firecracker microVM 编排核心:pkg/sandbox (cleanup/reclaim/checks/hoststats/snapshot/上传/uffd 按需分页/cgroup/network/rootfs/template)、pkg/nfsproxy、pkg/volumes、pkg/server (gRPC Sandbox/Chunk/Info/Template/Volume 服务)、NBD 块设备、TCP 防火墙、chrooted、cmd/* 工具 (build-template/clean-nfs-cache/simulate-gcs-traffic)。', filterStrict('packages/orchestrator'));

// L3: Envd Daemon (in-VM)
addLayer('layer:envd-daemon', 'Envd 守护进程层', '在 Firecracker VM 内 root 运行的 daemon (Connect RPC 49983),负责进程管理、文件系统、init/freeze/upload/download、HTTP API,通过 spec/process 与 spec/filesystem protobuf 与 orchestrator 通信;legacy 兼容 Python SDK 协议。', filterStrict('packages/envd'));

// L4: Shared Library
addLayer('layer:shared-library', '共享库层', '跨服务复用的公共代码:logger/telemetry (OpenTelemetry) /featureflags (LaunchDarkly)/storage (GCS/S3)/proxy/grpc/middleware、gRPC 客户端封装 (orchestrator/envd)、ent ORM schema、工具函数 (id/sync/cache/smap/sandbox-catalog/clusters/filesystem/keys/connlimit/sandbox-network 等)。', filterStrict('packages/shared'));

// L5: Database Layer (PostgreSQL)
addLayer('layer:database', '数据库层 (PostgreSQL)', 'PostgreSQL 持久化层:goose 迁移 (migrations/*.sql)、sqlc 类型安全查询 (queries/*.sql)、ent schema、查询封装 (auth/dashboard 子包)、连接池、错误处理、retry 工具、测试辅助 (testutils/db/tests)。', filterStrict('packages/db'));

// L6: ClickHouse Analytics + Dashboard API + Auth + Client-Proxy + Docker Reverse Proxy + Local-dev + APM + Otel (辅助服务集群)
const chIds = filterStrict('packages/clickhouse');
const dashIds = filterStrict('packages/dashboard-api');
const authIds = filterStrict('packages/auth');
const cpIds = filterStrict('packages/client-proxy');
const drpIds = filterStrict('packages/docker-reverse-proxy');
const ldIds = filterStrict('packages/local-dev');
const apmIds = filterStrict('packages/nomad-nodepool-apm');
const otelIds = filterStrict('packages/otel-collector');
const supportingIds = [...chIds, ...dashIds, ...authIds, ...cpIds, ...drpIds, ...ldIds, ...apmIds, ...otelIds];
addLayer('layer:supporting-services', '辅助服务层 (Dashboard/Auth/Proxy/Analytics)', '围绕核心服务的小型辅助服务:ClickHouse 列式分析 (迁移 + Batcher)、Dashboard API (团队与用户档案)、Auth (API key/access token/OIDC 鉴权)、Client-Proxy (Consul + Redis 边缘 HTTP 反向代理)、Docker Registry 反向代理、本地开发 Docker Compose、Nomad NodePool APM 插件、OTel Collector。', supportingIds);

// L7: API Specifications (OpenAPI)
addLayer('layer:api-schemas', 'OpenAPI 规范层', 'OpenAPI 规范 (openapi.yml/openapi-edge.yml/openapi-dashboard.yml/openapi-hyperloop.yml) 作为 REST API 契约单一来源,供 oapi-codegen 生成 API/edge/dashboard 处理器、类型与 specs;Redocly 一致性插件用于规范校验。', filterStrict('spec'));

// L8: Infrastructure as Code (Terraform + Nomad)
addLayer('layer:iac', '基础设施即代码 (Terraform + Nomad)', 'GCP 与 AWS 两个 provider 的 Terraform:网络、Nomad 集群、节点池 (api/orchestrator/clickhouse/control/client)、作业定义 (job-api/job-orchestrator/job-clickhouse/job-template-manager 等)、ALB/Redis/Cloudflare、持久卷与 Packer 磁盘镜像;Nomad HCL 任务文件 (clean-nfs-cache/docker-reverse-proxy)。', filterStrict('iac'));

// L9: CI/CD Pipelines
addLayer('layer:ci-cd', 'CI/CD 流水线层', 'GitHub Actions 工作流:PR 检查 (lint/test/arm64/no-generated-changes)、构建与上传镜像、集成测试矩阵、IaC 验证 (terraform validate)、OpenAPI lint、envd 提升、release-please 自动化发布、out-of-order-migrations 校验、go-dependbot 清理、periodic 定时监控。', filterStrict('.github'));

// L10: Documentation, Tests, Tooling, Build Config (project-level meta)
const docIds = d.fileNodes.filter(n =>
  n.type === 'document' &&
  (n.filePath.split('/').length === 1 || n.filePath.startsWith('docs/'))
).map(n => n.id);

const testIds = filterStrict('tests');

const topLevelConfigs = d.fileNodes.filter(n =>
  n.type === 'config' && n.filePath.split('/').length === 1
).map(n => n.id);
const rootConfigPatterns = [
  /^Makefile$/, /^go\.work$/, /^go\.work\.sum$/, /^codecov\.yml$/, /^redocly\.yaml$/,
  /^release-please-config\.json$/, /^\.release-please-manifest\.json$/,
  /^\.golangci\.yml$/, /^\.mockery\.yaml$/, /^\.envrc$/, /^\.tool-versions$/,
  /^\.gitattributes$/, /^\.dockerignore$/, /^\.env\.aws\.template$/, /^\.env\.gcp\.template$/,
  /^CODEOWNERS$/, /^\.env\.local$/, /^\.air\.toml$/, /^\.env\.template$/,
];
const rootConfigIds = d.fileNodes.filter(n => {
  if (n.type === 'config') return false;
  if (n.type !== 'file') return false;
  return rootConfigPatterns.some(p => p.test(n.filePath));
}).map(n => n.id);
const scriptIds = filterStrict('scripts');
const fixturesIds = filterStrict('fixtures');
const toolingIds = d.fileNodes.filter(n => /^(\.cursor|\.gemini|\.redocly|\.devcontainer|\.understand-anything)\//.test(n.filePath)).map(n => n.id);
const rootFiles = d.fileNodes.filter(n => n.filePath.split('/').length === 1 && n.type === 'pipeline').map(n => n.id);

const projectMetaIds = [...new Set([
  ...docIds, ...testIds, ...topLevelConfigs, ...rootConfigIds, ...scriptIds, ...fixturesIds, ...toolingIds, ...rootFiles
])];
addLayer('layer:project-meta', '项目元数据 (文档/测试/工具配置)', '项目级元资源:根级与 docs/ 总览文档 (README/CLAUDE/AGENTS/CONTRIBUTING/DEV/SCHEMA/MODULE_GUIDE)、tests/ 端到端集成测试与周期性测试、根级 Makefile/go.work/.env 模板/lint/mockery/codecov 等工具配置、scripts/ 与 fixtures/、Cursor/Gemini/Redocly/devcontainer 编辑器与 lint 工具配置。', projectMetaIds);

console.log('---');
console.log('Total layers:', layers.length);
console.log('Total assigned:', assigned.size, '/', totalNodes);
const unassigned = d.fileNodes.filter(n => !assigned.has(n.id));
if (unassigned.length > 0) {
  console.log('UNASSIGNED nodes:', unassigned.length);
  unassigned.slice(0, 20).forEach(n => console.log(' ', n.id, '-', n.filePath));
}

for (const l of layers) {
  if (!l.id || !l.name || !l.description || !Array.isArray(l.nodeIds) || l.nodeIds.length === 0) {
    console.error('INVALID LAYER:', l.id);
    process.exit(1);
  }
}

fs.writeFileSync('/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/layers.json', JSON.stringify(layers, null, 2));
console.log('Wrote layers.json');
