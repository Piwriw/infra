window.LEARNING_CATALOG = (() => {
  const core = [
    {
      id: 'local-map',
      order: 0,
      title: 'Local 模式与服务拓扑',
      shortTitle: '本地拓扑',
      phase: 'orientation',
      path: './local-mode-map.md',
      sourcePath: 'web-docs/local-mode-map.md',
      summary: '认识本地栈包含哪些服务、Local 配置怎样选择本地 orchestrator，以及服务监听哪些端口。',
      duration: 8,
      tags: ['Local', '服务拓扑', '端口'],
      codeRoot: 'packages/local-dev · packages/api'
    },
    {
      id: 'local-start',
      order: 1,
      title: '启动本地开发环境',
      shortTitle: '本地启动',
      phase: 'setup',
      path: './local-mode-start.md',
      sourcePath: 'web-docs/local-mode-start.md',
      summary: '按依赖、迁移、服务、base 模板的顺序启动，并检查本地健康端点。',
      duration: 6,
      tags: ['Docker Compose', 'KVM', '启动顺序'],
      codeRoot: 'DEV-LOCAL.md · packages/local-dev'
    },
    {
      id: 'local-flows',
      order: 2,
      title: '沙箱创建与访问链路',
      shortTitle: '沙箱链路',
      phase: 'runtime',
      path: './local-mode-flows.md',
      sourcePath: 'web-docs/local-mode-flows.md',
      summary: '跟踪 API、orchestrator、Firecracker、envd、Redis 和 client-proxy 的本地协作。',
      duration: 8,
      tags: ['Sandbox', 'Firecracker', 'Proxy'],
      codeRoot: 'packages/api · packages/orchestrator · packages/client-proxy'
    },
    {
      id: 'local-dependencies',
      order: 3,
      title: '本地依赖与观测',
      shortTitle: '依赖与观测',
      phase: 'support',
      path: './local-mode-dependencies.md',
      sourcePath: 'web-docs/local-mode-dependencies.md',
      summary: '区分运行沙箱所需的 PostgreSQL、Redis 与可选日志、trace、metrics 服务。',
      duration: 7,
      tags: ['PostgreSQL', 'Redis', 'Observability'],
      codeRoot: 'packages/local-dev · packages/otel-collector'
    }
  ];

  const deep = [
    ['sandbox-lifecycle', 'Sandbox 生命周期与快照', 'runtime', './sandbox-lifecycle.md', 'web-docs/sandbox-lifecycle.md', '创建、暂停、恢复、快照和回收的源码级参考。', ['Sandbox', 'Lifecycle', 'Firecracker']],
    ['client-proxy', 'Client Proxy 流量转发', 'runtime', './client-proxy-module.md', 'web-docs/client-proxy-module.md', '请求解析、Redis 路由、auto-resume 和转发到 VM 的实现。', ['Proxy', 'Redis', 'Traffic']],
    ['envd', 'Envd Guest Agent', 'runtime', './envd-module.md', 'web-docs/envd-module.md', 'VM 内进程、文件、初始化和端口处理的源码参考。', ['Envd', 'Guest', 'Process']],
    ['template-build', 'Local 模板构建与产物', 'runtime', './local-mode-template-build.md', 'web-docs/local-mode-template-build.md', '从本地 SDK 请求追到 template-manager 和磁盘产物。', ['Template', 'Local Storage', 'Build']],
    ['snapshots', 'Snapshots 快照与恢复', 'persistence', './snapshots.md', 'web-docs/snapshots.md', 'Pause、Checkpoint、Resume 与快照元数据和产物。', ['Snapshot', 'Pause', 'Resume']],
    ['volumes', 'Volumes 持久化卷', 'persistence', './volumes.md', 'web-docs/volumes.md', '卷的 API、节点存储、沙箱挂载和文件操作。', ['Volume', 'NFS', 'Storage']],
    ['data-dictionary', 'Local 数据字典：PG / ClickHouse / Redis', 'support', './database-schema.md', 'web-docs/database-schema.md', '查 PostgreSQL 表字段与关系、ClickHouse 表列，以及 Redis key 的类型、内容和 TTL。', ['PostgreSQL', 'ClickHouse', 'Redis', 'Schema']]
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
    { id: 'orientation', label: '00 / 本地环境', eyebrow: 'LOCAL' },
    { id: 'setup', label: '01 / 启动与检查', eyebrow: 'SETUP' },
    { id: 'runtime', label: '02 / 沙箱运行时', eyebrow: 'RUNTIME' },
    { id: 'support', label: '03 / 数据与观测', eyebrow: 'SUPPORT' }
  ];

  const topics = [
    { id: 'runtime', label: '沙箱运行时' },
    { id: 'persistence', label: '快照与持久卷' },
    { id: 'support', label: '依赖与观测' }
  ];

  const paths = [
    {
      id: 'local-first-run',
      label: '本地从零启动',
      description: '按顺序准备本地依赖、服务和 base 模板。',
      docs: ['local-map', 'local-start', 'local-dependencies', 'template-build', 'local-flows']
    },
    {
      id: 'sandbox-path',
      label: '跟一遍沙箱请求',
      description: '从 API 创建开始，追踪到 VM 内进程收到请求。',
      docs: ['local-flows', 'client-proxy', 'sandbox-lifecycle', 'envd']
    },
    {
      id: 'template-build-path',
      label: '构建本地模板',
      description: '从 SDK 构建命令追踪到本地 template-manager 和产物目录。',
      docs: ['local-start', 'template-build', 'sandbox-lifecycle']
    },
    {
      id: 'persistent-data',
      label: '快照与持久卷',
      description: '区分沙箱快照状态和跨沙箱生命周期保留的卷数据。',
      docs: ['local-map', 'snapshots', 'volumes', 'sandbox-lifecycle']
    },
    {
      id: 'local-troubleshooting',
      label: '本地依赖与排障',
      description: '了解核心依赖、观测服务和启动后的检查顺序。',
      docs: ['local-dependencies', 'local-start', 'local-flows']
    },
    {
      id: 'local-data-stores',
      label: '读懂本地数据存储',
      description: '从依赖拓扑进入 PostgreSQL、ClickHouse 表结构和 Redis key 空间。',
      docs: ['local-map', 'local-dependencies', 'data-dictionary', 'client-proxy']
    }
  ];

  const flows = [
    {
      id: 'create',
      label: '创建沙箱',
      description: 'API 协调本地节点，把模板恢复成可运行的 VM。',
      steps: [
        ['local-start', '本地服务', 'PostgreSQL、Redis 和 Go 服务已启动'],
        ['local-flows', 'API', '接收请求并调用本机 orchestrator'],
        ['sandbox-lifecycle', 'Orchestrator', '恢复模板并启动 Firecracker VM'],
        ['envd', 'Envd', '完成 guest 初始化并开放沙箱服务']
      ]
    },
    {
      id: 'traffic',
      label: '访问沙箱端口',
      description: '用户流量绕过 API，经 Redis 路由后进入目标 VM。',
      steps: [
        ['client-proxy', 'Client Proxy', '解析沙箱 ID 和目标端口'],
        ['local-map', 'Redis', '查找沙箱运行节点'],
        ['local-flows', 'Orchestrator Proxy', '把请求转发到 VM 网络'],
        ['envd', 'Sandbox', 'Envd 或用户进程响应请求']
      ]
    },
    {
      id: 'resume',
      label: '构建模板与恢复',
      description: '模板构建和快照恢复由本地 orchestrator 提供。',
      steps: [
        ['template-build', 'Template Manager', '用本地 orchestrator 构建 base 模板'],
        ['snapshots', 'Snapshot', '保存暂停状态并恢复 VM'],
        ['sandbox-lifecycle', 'Orchestrator', '从模板或快照启动 VM'],
        ['template-build', 'Local 存储', '从本机文件目录读取模板与快照产物'],
        ['local-dependencies', '观测栈', '需要时查看日志、trace 和 metrics']
      ]
    }
  ];

  return { core, deep, phases, topics, paths, flows, all: [...core, ...deep] };
})();
