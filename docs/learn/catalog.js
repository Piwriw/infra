window.LEARNING_CATALOG = (() => {
  const core = [
    {
      id: 'overview',
      order: 0,
      title: 'E2B Infra 项目全景',
      shortTitle: '项目全景',
      phase: 'orientation',
      path: 'components/00-overview.md',
      sourcePath: 'docs/learn/components/00-overview.md',
      summary: '用控制面、数据面和支撑面建立全局心智模型。',
      duration: 14,
      tags: ['架构', '入口', '学习路径'],
      codeRoot: 'README.md · go.work'
    },
    {
      id: 'api',
      order: 1,
      title: 'API：控制面总入口',
      shortTitle: 'API',
      phase: 'control',
      path: 'components/01-api.md',
      sourcePath: 'docs/learn/components/01-api.md',
      summary: '理解 OpenAPI、认证中间件、handler 与 orchestrator client 如何组装。',
      duration: 18,
      tags: ['REST', '控制面', '生命周期'],
      codeRoot: 'packages/api'
    },
    {
      id: 'auth',
      order: 2,
      title: 'Auth：身份与团队上下文',
      shortTitle: 'Auth',
      phase: 'control',
      path: 'components/02-auth.md',
      sourcePath: 'docs/learn/components/02-auth.md',
      summary: '理解 OIDC、API Key、Access Token 与 team 授权上下文。',
      duration: 16,
      tags: ['OIDC', '认证', '授权'],
      codeRoot: 'packages/auth'
    },
    {
      id: 'dashboard-api',
      order: 3,
      title: 'Dashboard API：控制台业务边界',
      shortTitle: 'Dashboard API',
      phase: 'control',
      path: 'components/03-dashboard-api.md',
      sourcePath: 'docs/learn/components/03-dashboard-api.md',
      summary: '理解用户、团队、模板视图与身份提供商集成。',
      duration: 15,
      tags: ['Dashboard', 'Team', 'OIDC'],
      codeRoot: 'packages/dashboard-api'
    },
    {
      id: 'db',
      order: 4,
      title: 'DB：业务事实与迁移边界',
      shortTitle: 'DB',
      phase: 'control',
      path: 'components/04-db.md',
      sourcePath: 'docs/learn/components/04-db.md',
      summary: '理解 PostgreSQL schema、sqlc 查询与事务所有权。',
      duration: 17,
      tags: ['PostgreSQL', 'sqlc', '迁移'],
      codeRoot: 'packages/db'
    },
    {
      id: 'client-proxy',
      order: 5,
      title: 'Client Proxy：沙箱流量入口',
      shortTitle: 'Client Proxy',
      phase: 'runtime',
      path: 'components/05-client-proxy.md',
      sourcePath: 'docs/learn/components/05-client-proxy.md',
      summary: '理解 Host 解析、Redis catalog、反向代理和透明恢复。',
      duration: 15,
      tags: ['Proxy', 'Redis', 'Auto-resume'],
      codeRoot: 'packages/client-proxy'
    },
    {
      id: 'orchestrator',
      order: 6,
      title: 'Orchestrator：节点与 microVM 运行时',
      shortTitle: 'Orchestrator',
      phase: 'runtime',
      path: 'components/06-orchestrator.md',
      sourcePath: 'docs/learn/components/06-orchestrator.md',
      summary: '理解 Firecracker、网络、块设备、快照与节点内状态机。',
      duration: 24,
      tags: ['Firecracker', 'gRPC', 'Snapshot'],
      codeRoot: 'packages/orchestrator'
    },
    {
      id: 'envd',
      order: 7,
      title: 'Envd：microVM 内执行平面',
      shortTitle: 'Envd',
      phase: 'runtime',
      path: 'components/07-envd.md',
      sourcePath: 'docs/learn/components/07-envd.md',
      summary: '理解 VM 内初始化、进程、文件系统、cgroup 与端口转发。',
      duration: 18,
      tags: ['Connect RPC', 'Process', 'Filesystem'],
      codeRoot: 'packages/envd'
    },
    {
      id: 'shared',
      order: 8,
      title: 'Shared：跨服务契约与基础能力',
      shortTitle: 'Shared',
      phase: 'foundation',
      path: 'components/08-shared.md',
      sourcePath: 'docs/learn/components/08-shared.md',
      summary: '理解 protobuf、catalog、proxy、telemetry 等共享边界。',
      duration: 16,
      tags: ['Proto', 'Catalog', 'Telemetry'],
      codeRoot: 'packages/shared'
    },
    {
      id: 'clickhouse',
      order: 9,
      title: 'ClickHouse：指标与事件查询层',
      shortTitle: 'ClickHouse',
      phase: 'foundation',
      path: 'components/09-clickhouse.md',
      sourcePath: 'docs/learn/components/09-clickhouse.md',
      summary: '理解沙箱与团队指标、批处理写入和迁移模型。',
      duration: 14,
      tags: ['Metrics', 'Events', 'OLAP'],
      codeRoot: 'packages/clickhouse'
    },
    {
      id: 'iac',
      order: 10,
      title: 'IaC：从组件到生产拓扑',
      shortTitle: 'IaC',
      phase: 'operations',
      path: 'components/10-iac.md',
      sourcePath: 'docs/learn/components/10-iac.md',
      summary: '理解 Terraform provider、Nomad job module 和云资源边界。',
      duration: 20,
      tags: ['Terraform', 'Nomad', 'GCP/AWS'],
      codeRoot: 'iac'
    },
    {
      id: 'docker-reverse-proxy',
      order: 11,
      title: 'Docker Reverse Proxy：镜像仓库入口',
      shortTitle: 'Docker Proxy',
      phase: 'operations',
      path: 'components/11-docker-reverse-proxy.md',
      sourcePath: 'docs/learn/components/11-docker-reverse-proxy.md',
      summary: '理解 registry token、Artifact Registry 路由与代理边界。',
      duration: 11,
      tags: ['Registry', 'Token', 'Proxy'],
      codeRoot: 'packages/docker-reverse-proxy'
    },
    {
      id: 'nomad-nodepool-apm',
      order: 12,
      title: 'Nomad Nodepool APM：节点池扩缩指标',
      shortTitle: 'Nodepool APM',
      phase: 'operations',
      path: 'components/12-nomad-nodepool-apm.md',
      sourcePath: 'docs/learn/components/12-nomad-nodepool-apm.md',
      summary: '理解 Nomad autoscaler 插件如何计算节点池指标。',
      duration: 9,
      tags: ['Nomad', 'Autoscaler', 'Plugin'],
      codeRoot: 'packages/nomad-nodepool-apm'
    },
    {
      id: 'local-dev-observability',
      order: 13,
      title: 'Local Dev 与 OTel：复现支撑面',
      shortTitle: 'Local Dev / OTel',
      phase: 'operations',
      path: 'components/13-local-dev-observability.md',
      sourcePath: 'docs/learn/components/13-local-dev-observability.md',
      summary: '理解本地依赖栈、种子数据和遥测收集链。',
      duration: 13,
      tags: ['Docker Compose', 'OTel', '开发环境'],
      codeRoot: 'packages/local-dev · packages/otel-collector'
    }
  ].map(doc => ({ ...doc, kind: 'core' }));

  const deep = [
    ['api-deep', 'API 服务深度剖析', 'control', '../md/api-module.md', 'docs/md/api-module.md', '路由、中间件、handler 与服务装配的完整参考。', ['API', 'OpenAPI']],
    ['database-schema', '数据库表与关联关系', 'control', '../md/database-schema.md', 'docs/md/database-schema.md', '核心表、约束、索引与查询关系参考。', ['Schema', 'PostgreSQL']],
    ['clusters', 'Clusters 与多集群路由', 'control', '../md/clusters-module.md', 'docs/md/clusters-module.md', 'team 到 cluster、节点发现和健康状态。', ['Cluster', 'Discovery']],
    ['auth-deep', '认证子系统深度剖析', 'security', '../md/auth-module.md', 'docs/md/auth-module.md', '认证器组合、缓存、OIDC 与 team 上下文。', ['Auth', 'OIDC']],
    ['cli-auth', 'CLI 登录与凭证签发', 'security', '../md/cli-auth-flow.md', 'docs/md/cli-auth-flow.md', 'CLI 从 OIDC 登录到长期凭证的调用链。', ['CLI', 'Token']],
    ['api-keys', 'API Key 管理', 'security', '../md/api-keys-module.md', 'docs/md/api-keys-module.md', 'API Key 的生成、哈希、掩码与 team 绑定。', ['API Key', 'Security']],
    ['access-tokens', 'Access Token 管理', 'security', '../md/access-tokens-module.md', 'docs/md/access-tokens-module.md', '用户级 token 与兼容路径。', ['Token', 'Compatibility']],
    ['admin', 'Admin 管理面', 'security', '../md/admin-module.md', 'docs/md/admin-module.md', '内部管理端点与管理员认证边界。', ['Admin', 'Authorization']],
    ['oidc-history', 'OIDC 认证演进历史', 'security', '../oidc-history.md', 'docs/oidc-history.md', 'OIDC 迁移、兼容性和身份模型演进。', ['OIDC', 'History']],
    ['template', 'Template 模板系统', 'templates', '../md/template-module.md', 'docs/md/template-module.md', '模板、build、alias 与状态模型。', ['Template', 'Build']],
    ['template-build', 'Template Build 端到端', 'templates', '../md/template-build-flow.md', 'docs/md/template-build-flow.md', '从 API 注册到 rootfs 产物落地。', ['Template', 'Workflow']],
    ['template-tags', 'Template Tags 与 Aliases', 'templates', '../md/template-tags-module.md', 'docs/md/template-tags-module.md', 'tag/alias 的校验、去重与缓存失效。', ['Template', 'Alias']],
    ['sandbox-api', 'Sandbox REST API', 'sandbox', '../md/sandbox-api-module.md', 'docs/md/sandbox-api-module.md', '沙箱端点、模型校验与 orchestrator 边界。', ['Sandbox', 'REST']],
    ['sandbox-management', 'Sandbox 管理机制', 'sandbox', '../md/sandbox-management.md', 'docs/md/sandbox-management.md', '创建、暂停、恢复、停止和 timeout。', ['Sandbox', 'Lifecycle']],
    ['sandbox-lifecycle', 'Sandbox 完整生命周期', 'sandbox', '../md/sandbox-lifecycle.md', 'docs/md/sandbox-lifecycle.md', '从选址到 VM 启动、快照、恢复与回收。', ['Sandbox', 'Firecracker']],
    ['auto-resume', 'Auto-resume 透明恢复', 'sandbox', '../md/auto-resume-module.md', 'docs/md/auto-resume-module.md', 'catalog miss 到 Resume 状态机与错误映射。', ['Resume', 'Proxy']],
    ['orchestrator-deep', 'Orchestrator 深度剖析', 'runtime', '../md/orchestrator-module.md', 'docs/md/orchestrator-module.md', '节点运行时、Firecracker、NBD、网络与缓存。', ['Runtime', 'Firecracker']],
    ['hyperloop-api', 'Hyperloop 内部通道', 'runtime', '../md/hyperloop-api-module.md', 'docs/md/hyperloop-api-module.md', 'sandbox 内部身份、日志与 collector 转发。', ['Hyperloop', 'Internal API']],
    ['node', 'Node 与节点池', 'runtime', '../md/node-module.md', 'docs/md/node-module.md', '实例抽象、健康状态、drain 与 autoscaling。', ['Node', 'Autoscaling']],
    ['volumes', 'Volumes 持久化卷', 'runtime', '../md/volumes.md', 'docs/md/volumes.md', 'NFS 后端、缓存、调度门控和文件操作。', ['Volume', 'NFS']],
    ['snapshots', 'Snapshots 快照系统', 'runtime', '../md/snapshots.md', 'docs/md/snapshots.md', 'pause/resume 产物、分发和缓存 TTL。', ['Snapshot', 'Storage']],
    ['envd-deep', 'Envd 深度剖析', 'runtime', '../md/envd-module.md', 'docs/md/envd-module.md', '进程、文件、cgroup、MMDS 与端口转发。', ['Envd', 'Process']],
    ['envd-api', 'Envd REST API', 'runtime', '../md/envd-api-module.md', 'docs/md/envd-api-module.md', '初始化、文件传输、认证与 freeze/thaw。', ['Envd', 'REST']],
    ['traffic-routing', 'Sandbox 流量路由', 'traffic', '../md/sandbox-traffic-routing.md', 'docs/md/sandbox-traffic-routing.md', 'Client Proxy、Host 解析、token 与下游路由。', ['Traffic', 'Proxy']],
    ['client-proxy-deep', 'Client Proxy 深度剖析', 'traffic', '../md/client-proxy-module.md', 'docs/md/client-proxy-module.md', 'catalog、连接池、恢复和优雅关停。', ['Proxy', 'Redis']],
    ['edge-api', 'Edge API 契约', 'traffic', '../md/edge-api-module.md', 'docs/md/edge-api-module.md', '远端 cluster 的服务发现、日志和指标契约。', ['Edge', 'OpenAPI']],
    ['team-metrics', 'Team Metrics 与计量', 'observability', '../md/team-metrics-module.md', 'docs/md/team-metrics-module.md', '团队用量、OTLP temporality 与 ClickHouse 查询。', ['Metrics', 'Billing']],
    ['clickhouse-deep', 'ClickHouse 包详解', 'observability', '../clickhouse-package.md', 'docs/clickhouse-package.md', '查询接口、事件投递和批处理实现。', ['ClickHouse', 'Events']],
    ['docker-proxy-deep', 'Docker Reverse Proxy 详解', 'operations', '../docker-reverse-proxy.md', 'docs/docker-reverse-proxy.md', 'Registry 协议、token 验证与 Artifact Registry。', ['Registry', 'Proxy']]
  ].map(([id, title, topic, path, sourcePath, summary, tags], index) => ({
    id,
    order: index + 1,
    title,
    shortTitle: title,
    topic,
    path,
    sourcePath,
    summary,
    tags,
    duration: 12,
    kind: 'deep'
  }));

  const phases = [
    { id: 'orientation', label: '00 / 建立地图', eyebrow: 'ORIENT' },
    { id: 'control', label: '01 / 控制面', eyebrow: 'CONTROL' },
    { id: 'runtime', label: '02 / 流量与运行时', eyebrow: 'RUNTIME' },
    { id: 'foundation', label: '03 / 共享与数据', eyebrow: 'FOUNDATION' },
    { id: 'operations', label: '04 / 部署与运维', eyebrow: 'OPERATIONS' }
  ];

  const topics = [
    { id: 'control', label: '控制面全貌' },
    { id: 'security', label: '身份与权限' },
    { id: 'templates', label: '模板构建' },
    { id: 'sandbox', label: '沙箱生命周期' },
    { id: 'runtime', label: '节点运行时' },
    { id: 'traffic', label: '流量与边缘' },
    { id: 'observability', label: '指标与计量' },
    { id: 'operations', label: '运维补充' }
  ];

  const paths = [
    {
      id: 'first-pass',
      label: '核心速通',
      description: '先建立完整链路，再决定下钻方向。',
      docs: ['overview', 'api', 'client-proxy', 'orchestrator', 'envd', 'db']
    },
    {
      id: 'sandbox-life',
      label: '沙箱生命周期',
      description: '沿创建、运行、暂停、恢复与回收读源码。',
      docs: ['api', 'sandbox-api', 'sandbox-lifecycle', 'orchestrator', 'snapshots', 'envd']
    },
    {
      id: 'template-path',
      label: '模板构建',
      description: '理解模板如何变成可启动的 rootfs。',
      docs: ['api', 'template', 'template-build', 'db', 'orchestrator-deep', 'docker-reverse-proxy']
    },
    {
      id: 'identity-path',
      label: '身份与控制台',
      description: '从 token 验证走到 team 级资源授权。',
      docs: ['auth', 'dashboard-api', 'auth-deep', 'api-keys', 'oidc-history', 'database-schema']
    },
    {
      id: 'operate-path',
      label: '部署与观测',
      description: '把代码组件映射到真实云资源和遥测链。',
      docs: ['iac', 'shared', 'local-dev-observability', 'clickhouse', 'team-metrics', 'nomad-nodepool-apm']
    }
  ];

  const flows = [
    {
      id: 'create',
      label: '创建沙箱',
      description: '从期望状态到可接收流量的 microVM。',
      steps: [
        ['api', 'API', '校验请求、身份、额度与模板'],
        ['auth', 'Auth', '建立 user/team 上下文'],
        ['db', 'PostgreSQL', '读取模板和持久化业务状态'],
        ['orchestrator', 'Orchestrator', '选址后创建 microVM'],
        ['envd', 'Envd', 'VM 内初始化并宣告可用'],
        ['shared', 'Catalog', '发布 sandbox 到节点的路由']
      ]
    },
    {
      id: 'traffic',
      label: '连接端口',
      description: '管理面完成后，用户流量走独立的高速路径。',
      steps: [
        ['client-proxy', 'Client Proxy', '解析 sandbox ID 与目标端口'],
        ['shared', 'Redis catalog', '查找运行节点地址'],
        ['orchestrator', 'Node proxy', '按节点内网络映射转发'],
        ['envd', 'Sandbox port', 'envd 或用户进程接收请求']
      ]
    },
    {
      id: 'resume',
      label: '暂停 / 恢复',
      description: '把运行状态持久化，并在新节点重新建立路由。',
      steps: [
        ['api', 'API', '串行化生命周期动作'],
        ['orchestrator', 'Orchestrator', '冻结、快照或加载状态'],
        ['db', 'Metadata', '保存 snapshot 与状态事实'],
        ['iac', 'Object storage', '保存大体积构建/快照产物'],
        ['shared', 'Catalog', '移除或重新发布运行路由']
      ]
    },
    {
      id: 'metrics',
      label: '指标链路',
      description: '从运行实例采样到团队级查询。',
      steps: [
        ['envd', 'Envd', '采集 VM 内进程与资源信息'],
        ['orchestrator', 'Orchestrator', '增加节点与 sandbox 维度'],
        ['local-dev-observability', 'OTel Collector', '接收、处理并导出遥测'],
        ['clickhouse', 'ClickHouse', '保存高频指标和事件'],
        ['api', 'API', '按 team/sandbox 查询并返回']
      ]
    }
  ];

  return { core, deep, phases, topics, paths, flows, all: [...core, ...deep] };
})();
