const fs = require('fs');

// Reusable helpers
const f = (path, name, summary, tags, complexity, languageNotes) => ({
  id: `file:${path}`, type: 'file', name, filePath: path, summary, tags, complexity,
  ...(languageNotes ? { languageNotes } : {})
});

const fn = (path, name, lineRange, summary, tags, complexity) => ({
  id: `function:${path}:${name}`, type: 'function', name, filePath: path, lineRange, summary, tags, complexity
});

const cls = (path, name, lineRange, summary, tags, complexity) => ({
  id: `class:${path}:${name}`, type: 'class', name, filePath: path, lineRange, summary, tags, complexity
});

const eImports = (srcPath, tgtPath) => ({ source: `file:${srcPath}`, target: `file:${tgtPath}`, type: 'imports', direction: 'forward', weight: 0.7 });
const eContains = (srcPath, nodeId) => ({ source: `file:${srcPath}`, target: nodeId, type: 'contains', direction: 'forward', weight: 1.0 });
const eExports = (srcPath, nodeId) => ({ source: `file:${srcPath}`, target: nodeId, type: 'exports', direction: 'forward', weight: 0.8 });
const eTestedBy = (srcPath, tgtPath) => ({ source: `file:${srcPath}`, target: `file:${tgtPath}`, type: 'tested_by', direction: 'forward', weight: 0.5 });

// ----- All file nodes -----
const files = {
  // 1. api/generate.go
  'tests/integration/internal/api/generate.go': f(
    'tests/integration/internal/api/generate.go',
    'generate.go',
    'oapi-codegen 代码生成指令文件，用于从 OpenAPI 规范生成 API 客户端代码。',
    ['code-generation', 'openapi', 'go-generate', 'barrel'],
    'simple',
    '使用 //go:generate 指令触发 oapi-codegen 工具'
  ),
  // 2. api/generated.go
  'tests/integration/internal/api/generated.go': f(
    'tests/integration/internal/api/generated.go',
    'generated.go',
    '由 oapi-codegen 从 spec/openapi.yml 自动生成的 OpenAPI 客户端代码，包含所有 API 请求/响应类型和客户端方法。集成测试通过此客户端调用 API 服务。',
    ['openapi', 'generated-code', 'api-client', 'code-generation', 'integration-test'],
    'complex',
    'oapi-codegen 自动生成；超过 11000 行，包含数百个类型与请求函数'
  ),
  // 3. envd/generate.go
  'tests/integration/internal/envd/generate.go': f(
    'tests/integration/internal/envd/generate.go',
    'generate.go',
    'oapi-codegen 代码生成指令文件，用于从 envd OpenAPI 规范生成 envd 客户端代码。',
    ['code-generation', 'openapi', 'go-generate', 'barrel'],
    'simple'
  ),
  // 4. envd/generated.go
  'tests/integration/internal/envd/generated.go': f(
    'tests/integration/internal/envd/generated.go',
    'generated.go',
    '由 oapi-codegen 从 packages/envd/spec/envd.yaml 自动生成的 envd HTTP 客户端代码，用于在集成测试中调用沙箱内 envd 守护进程。',
    ['openapi', 'generated-code', 'envd', 'api-client', 'integration-test'],
    'complex',
    'oapi-codegen 自动生成；近 2000 行，覆盖 envd 进程与文件系统 API'
  ),
  // 5. envd/types.go
  'tests/integration/internal/envd/types.go': f(
    'tests/integration/internal/envd/types.go',
    'types.go',
    '定义 SecureToken 类型别名（string），用于集成测试中对 envd 访问令牌进行简化建模。',
    ['type-definition', 'envd', 'test-fixture'],
    'simple',
    '类型别名 = string，避免在测试代码中引入 envd 的安全内存实现'
  ),
  // 6. main_test.go
  'tests/integration/internal/main_test.go': f(
    'tests/integration/internal/main_test.go',
    'main_test.go',
    '集成测试的 TestMain 入口；同时在测试启动前预热缓存以加载基础模板，确保后续测试的沙箱创建快速且稳定。',
    ['entry-point', 'test-fixture', 'integration-test', 'test-main'],
    'moderate'
  ),
  // 7. setup/api_client.go
  'tests/integration/internal/setup/api_client.go': f(
    'tests/integration/internal/setup/api_client.go',
    'api_client.go',
    '提供集成测试使用的 E2B REST API 客户端构造器，以及一组请求编辑器（API Key、Access Token、Team ID、User-Agent 等认证头注入）。',
    ['test-fixture', 'api-client', 'authentication', 'integration-test', 'utility'],
    'moderate'
  ),
  // 8. setup/constants.go
  'tests/integration/internal/setup/constants.go': f(
    'tests/integration/internal/setup/constants.go',
    'constants.go',
    '集中定义集成测试所需的全局常量与配置：API/envd 超时、API 服务器地址、模板 ID、API Key、Access Token、Team/User ID 等，全部来自环境变量。',
    ['config', 'test-fixture', 'environment-variables', 'integration-test'],
    'simple'
  ),
  // 9. setup/db_client.go
  'tests/integration/internal/setup/db_client.go': f(
    'tests/integration/internal/setup/db_client.go',
    'db_client.go',
    '提供集成测试用的 PostgreSQL 客户端构造器，同时封装主数据库与 auth 数据库的 client，便于测试直接查询数据库状态。',
    ['test-fixture', 'database', 'integration-test', 'postgresql', 'utility'],
    'simple'
  ),
  // 10. setup/envd_client.go
  'tests/integration/internal/setup/envd_client.go': f(
    'tests/integration/internal/setup/envd_client.go',
    'envd_client.go',
    '提供集成测试用的 envd 客户端构造器：包含 HTTP WithResponses 客户端、文件系统 Connect 客户端与进程 Connect 客户端，以及沙箱/access token 的请求头注入辅助函数。',
    ['test-fixture', 'envd', 'integration-test', 'grpc-client', 'utility'],
    'moderate'
  ),
  // 11. setup/orchestrator_client.go
  'tests/integration/internal/setup/orchestrator_client.go': f(
    'tests/integration/internal/setup/orchestrator_client.go',
    'orchestrator_client.go',
    '提供集成测试用的 orchestrator gRPC 客户端构造器（SandboxServiceClient），使用 insecure 凭证并随 ctx 退出自动关闭连接。',
    ['test-fixture', 'grpc-client', 'orchestrator', 'integration-test', 'utility'],
    'simple'
  ),
  // 12. apikey_test.go
  'tests/integration/internal/tests/api/apikey_test.go': f(
    'tests/integration/internal/tests/api/apikey_test.go',
    'apikey_test.go',
    '集成测试：验证调用 API 时 API Key 的 LastUsed 字段会被正确更新（容忍 1 分钟写入节流）。',
    ['test', 'integration-test', 'api-key', 'authentication', 'validation'],
    'moderate'
  ),
  // 13. health_test.go
  'tests/integration/internal/tests/api/health_test.go': f(
    'tests/integration/internal/tests/api/health_test.go',
    'health_test.go',
    '集成测试：调用 /health 端点验证 API 服务的健康检查接口返回正常。',
    ['test', 'integration-test', 'health-check', 'api-endpoint', 'validation'],
    'simple'
  ),
  // 14. metrics/sandbox_list_metrics_test.go
  'tests/integration/internal/tests/api/metrics/sandbox_list_metrics_test.go': f(
    'tests/integration/internal/tests/api/metrics/sandbox_list_metrics_test.go',
    'sandbox_list_metrics_test.go',
    '集成测试：验证 GET /sandboxes 列表接口返回的指标统计（运行/暂停计数等）与实际状态一致。',
    ['test', 'integration-test', 'metrics', 'sandbox', 'validation'],
    'moderate'
  ),
  // 15. metrics/sandbox_metrics_test.go
  'tests/integration/internal/tests/api/metrics/sandbox_metrics_test.go': f(
    'tests/integration/internal/tests/api/metrics/sandbox_metrics_test.go',
    'sandbox_metrics_test.go',
    '集成测试：验证沙箱级别的指标查询接口能返回正确的指标数据。',
    ['test', 'integration-test', 'metrics', 'sandbox', 'validation'],
    'moderate'
  ),
  // 16. metrics/team_metrics_max_test.go
  'tests/integration/internal/tests/api/metrics/team_metrics_max_test.go': f(
    'tests/integration/internal/tests/api/metrics/team_metrics_max_test.go',
    'team_metrics_max_test.go',
    '集成测试：验证团队级最大并发沙箱数、最大沙箱启动速率指标的统计正确性，以及空数据场景的兜底行为。',
    ['test', 'integration-test', 'metrics', 'team', 'validation'],
    'complex'
  ),
  // 17. metrics/team_metrics_test.go
  'tests/integration/internal/tests/api/metrics/team_metrics_test.go': f(
    'tests/integration/internal/tests/api/metrics/team_metrics_test.go',
    'team_metrics_test.go',
    '集成测试：验证团队级指标查询接口，覆盖默认范围、自定义时间范围、空数据与非法日期参数等场景。',
    ['test', 'integration-test', 'metrics', 'team', 'validation'],
    'complex'
  ),
  // 18. sandboxes/filesystem_only_test.go
  'tests/integration/internal/tests/api/sandboxes/filesystem_only_test.go': f(
    'tests/integration/internal/tests/api/sandboxes/filesystem_only_test.go',
    'filesystem_only_test.go',
    '集成测试：覆盖 filesystem-only 模板沙箱的创建约束、自动暂停/恢复行为与持久化语义。',
    ['test', 'integration-test', 'sandbox', 'filesystem-only', 'validation'],
    'complex'
  ),
  // 19. sandboxes/sandbox_auto_pause_test.go
  'tests/integration/internal/tests/api/sandboxes/sandbox_auto_pause_test.go': f(
    'tests/integration/internal/tests/api/sandboxes/sandbox_auto_pause_test.go',
    'sandbox_auto_pause_test.go',
    '集成测试：验证沙箱的自动暂停（auto-pause）、恢复（resume）与持久化行为，以及关闭 auto-pause 时的语义。',
    ['test', 'integration-test', 'sandbox', 'auto-pause', 'validation'],
    'complex'
  ),
  // 20. sandboxes/sandbox_connect_test.go
  'tests/integration/internal/tests/api/sandboxes/sandbox_connect_test.go': f(
    'tests/integration/internal/tests/api/sandboxes/sandbox_connect_test.go',
    'sandbox_connect_test.go',
    '集成测试：验证沙箱连接/重连流程，包括跨团队访问运行中与已暂停沙箱的权限语义。',
    ['test', 'integration-test', 'sandbox', 'connect', 'validation'],
    'complex'
  ),
  // 21. sandboxes/sandbox_detail_test.go
  'tests/integration/internal/tests/api/sandboxes/sandbox_detail_test.go': f(
    'tests/integration/internal/tests/api/sandboxes/sandbox_detail_test.go',
    'sandbox_detail_test.go',
    '集成测试：验证 GET 沙箱详情接口，覆盖运行中、已暂停、暂停中等生命周期状态以及网络配置与生命周期元数据。',
    ['test', 'integration-test', 'sandbox', 'validation'],
    'complex'
  ),
  // 22. sandboxes/sandbox_fuse_test.go
  'tests/integration/internal/tests/api/sandboxes/sandbox_fuse_test.go': f(
    'tests/integration/internal/tests/api/sandboxes/sandbox_fuse_test.go',
    'sandbox_fuse_test.go',
    '集成测试：验证沙箱内 FUSE 设备权限以及非 root 用户的 FUSE 访问能力。',
    ['test', 'integration-test', 'sandbox', 'fuse', 'validation'],
    'moderate'
  ),
  // 23. sandboxes/sandbox_internet_test.go
  'tests/integration/internal/tests/api/sandboxes/sandbox_internet_test.go': f(
    'tests/integration/internal/tests/api/sandboxes/sandbox_internet_test.go',
    'sandbox_internet_test.go',
    '集成测试：验证沙箱的网络出口策略，包括默认无网络访问、按模板配置的互联网访问以及恢复沙箱后的网络行为。',
    ['test', 'integration-test', 'sandbox', 'network', 'validation'],
    'moderate'
  ),
  // 24. sandboxes/sandbox_kill_test.go
  'tests/integration/internal/tests/api/sandboxes/sandbox_kill_test.go': f(
    'tests/integration/internal/tests/api/sandboxes/sandbox_kill_test.go',
    'sandbox_kill_test.go',
    '集成测试：验证沙箱的删除/kill 流程，包括删除不存在的沙箱、删除运行中沙箱及其级联清理。',
    ['test', 'integration-test', 'sandbox', 'validation'],
    'complex'
  ),
  // 25. sandboxes/sandbox_list_test.go
  'tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go': f(
    'tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go',
    'sandbox_list_test.go',
    '集成测试：全面验证沙箱列表接口（v1/v2），覆盖过滤、分页、按状态排序、元数据返回以及跨运行/暂停状态的混合查询。',
    ['test', 'integration-test', 'sandbox', 'list', 'pagination', 'validation'],
    'complex'
  ),
};

// ----- Function / class nodes -----
const funcs = [];
const classes = [];

// main_test.go
funcs.push(fn('tests/integration/internal/main_test.go', 'TestMain', [17, 21], 'Go 测试入口函数：执行测试前的环境初始化日志和测试运行。', ['test-main', 'entry-point'], 'simple'));
funcs.push(fn('tests/integration/internal/main_test.go', 'TestCacheTemplate', [24, 51], '在所有测试运行前创建一个基础模板沙箱以预热模板缓存，加速后续测试的沙箱创建。包含失败日志和自动清理。', ['test-fixture', 'cache-warming', 'integration-test'], 'moderate'));

// setup/api_client.go (all exported helpers, all >=10 lines after some)
funcs.push(fn('tests/integration/internal/setup/api_client.go', 'GetAPIClient', [11, 22], '构造带超时的 E2B REST API ClientWithResponses，使用 APIServerURL 作为基础地址。', ['api-client', 'factory', 'test-fixture'], 'simple'));
funcs.push(fn('tests/integration/internal/setup/api_client.go', 'WithAPIKey', [24, 34], '返回请求编辑器，将 X-API-Key 头设置为默认或传入的 API Key。', ['authentication', 'middleware', 'api-key'], 'simple'));
funcs.push(fn('tests/integration/internal/setup/api_client.go', 'WithUserAgent', [40, 46], '返回请求编辑器，将 User-Agent 头设置为指定值。', ['middleware', 'http-headers'], 'simple'));
funcs.push(fn('tests/integration/internal/setup/api_client.go', 'WithAccessToken', [48, 54], '返回请求编辑器，将 Authorization 头设置为 Bearer AccessToken。', ['authentication', 'middleware', 'access-token'], 'simple'));
funcs.push(fn('tests/integration/internal/setup/api_client.go', 'WithTeamID', [56, 67], '返回请求编辑器，将 X-Team-ID 头设置为默认或传入的 teamID。', ['authentication', 'middleware', 'team'], 'simple'));

// setup/db_client.go
classes.push(cls('tests/integration/internal/setup/db_client.go', 'Database', [13, 16], '封装主数据库与 auth 数据库 client 的测试用容器结构。', ['data-model', 'database', 'test-fixture'], 'simple'));
funcs.push(fn('tests/integration/internal/setup/db_client.go', 'GetTestDBClient', [18, 38], '从 POSTGRES_CONNECTION_STRING 构造主库与 auth 库的 client，并在测试结束时自动关闭。', ['database', 'factory', 'test-fixture'], 'moderate'));

// setup/envd_client.go
classes.push(cls('tests/integration/internal/setup/envd_client.go', 'EnvdClient', [16, 20], '封装 envd 的 HTTP WithResponses 客户端、文件系统 Connect 客户端与进程 Connect 客户端的测试用容器结构。', ['data-model', 'envd', 'test-fixture'], 'simple'));
funcs.push(fn('tests/integration/internal/setup/envd_client.go', 'GetEnvdClient', [22, 40], '构造 envd 客户端容器，使用 EnvdProxy 作为基础地址并设置 envdTimeout 超时。', ['envd', 'factory', 'test-fixture'], 'moderate'));
funcs.push(fn('tests/integration/internal/setup/envd_client.go', 'WithSandbox', [42, 51], '返回请求编辑器，在请求头中注入沙箱 ID 并将 Host 设置为对应沙箱。', ['envd', 'middleware', 'sandbox'], 'simple'));
funcs.push(fn('tests/integration/internal/setup/envd_client.go', 'WithEnvdAccessToken', [53, 61], '返回请求编辑器，在请求头中注入 X-Access-Token。', ['envd', 'middleware', 'authentication'], 'simple'));
funcs.push(fn('tests/integration/internal/setup/envd_client.go', 'SetSandboxHeader', [63, 67], '通过 grpc.SetSandboxHeader 设置沙箱路由头，复用 EnvdProxy 作为 host。', ['envd', 'http-headers', 'sandbox'], 'simple'));

// setup/orchestrator_client.go
funcs.push(fn('tests/integration/internal/setup/orchestrator_client.go', 'GetOrchestratorClient', [14, 30], '建立到 OrchestratorHost 的 gRPC 客户端（insecure 凭证），返回 SandboxServiceClient，并随 ctx 退出自动关闭连接。', ['grpc-client', 'orchestrator', 'factory'], 'moderate'));

// apikey_test.go
funcs.push(fn('tests/integration/internal/tests/api/apikey_test.go', 'TestAPIKeyLastUsedUpdated', [14, 41], '验证调用 API 时所用 API Key 的 LastUsed 字段被正确刷新，使用 Eventually 轮询以应对 1 分钟的写入节流。', ['test', 'api-key', 'authentication'], 'moderate'));

// health_test.go
funcs.push(fn('tests/integration/internal/tests/api/health_test.go', 'TestHealth', [13, 27], '调用健康检查端点验证 API 服务可访问且返回成功状态。', ['test', 'health-check'], 'simple'));

// metrics/sandbox_list_metrics_test.go
funcs.push(fn('tests/integration/internal/tests/api/metrics/sandbox_list_metrics_test.go', 'TestSandboxListMetrics', [16, 57], '验证沙箱列表接口返回的统计指标与实际创建的沙箱状态一致。', ['test', 'metrics', 'sandbox', 'list'], 'moderate'));

// metrics/sandbox_metrics_test.go
funcs.push(fn('tests/integration/internal/tests/api/metrics/sandbox_metrics_test.go', 'TestSandboxMetrics', [15, 52], '验证沙箱级指标查询接口能返回预期的指标数据。', ['test', 'metrics', 'sandbox'], 'moderate'));

// metrics/team_metrics_max_test.go
funcs.push(fn('tests/integration/internal/tests/api/metrics/team_metrics_max_test.go', 'TestTeamMetricsMaxConcurrentSandboxes', [15, 54], '验证团队最大并发沙箱数指标正确反映了并发创建的沙箱峰值。', ['test', 'metrics', 'team', 'concurrency'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/metrics/team_metrics_max_test.go', 'TestTeamMetricsMaxSandboxStartRate', [56, 95], '验证团队最大沙箱启动速率指标在多个沙箱并发创建后被正确统计。', ['test', 'metrics', 'team', 'rate'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/metrics/team_metrics_max_test.go', 'TestTeamMetricsMaxEmpty', [97, 138], '验证无任何沙箱活动时团队最大指标接口的空数据兜底行为。', ['test', 'metrics', 'team', 'edge-case'], 'moderate'));

// metrics/team_metrics_test.go
funcs.push(fn('tests/integration/internal/tests/api/metrics/team_metrics_test.go', 'TestTeamMetrics', [16, 57], '验证默认时间范围内团队指标查询接口的返回结构。', ['test', 'metrics', 'team'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/metrics/team_metrics_test.go', 'TestTeamMetricsWithTimeRange', [59, 100], '验证自定义 start/end 时间范围参数下团队指标查询的正确性。', ['test', 'metrics', 'team', 'time-range'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/metrics/team_metrics_test.go', 'TestTeamMetricsEmpty', [102, 121], '验证无活动时团队指标接口的空数据返回结构。', ['test', 'metrics', 'team', 'edge-case'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/metrics/team_metrics_test.go', 'TestTeamMetricsInvalidDate', [123, 138], '验证非法日期参数被接口拒绝并返回 4xx 错误。', ['test', 'metrics', 'team', 'validation'], 'simple'));

// sandboxes/filesystem_only_test.go
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/filesystem_only_test.go', 'TestSandboxCreate_FilesystemOnlyAutoPauseRejectsAutoResume', [21, 38], '验证 filesystem-only 沙箱在启用 auto-pause 时拒绝同时启用 auto-resume。', ['test', 'sandbox', 'filesystem-only', 'validation'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/filesystem_only_test.go', 'TestSandboxCreate_FilesystemOnlyAutoPauseRequiresAutoPause', [43, 59], '验证 filesystem-only 沙箱必须显式启用 auto-pause 才能创建。', ['test', 'sandbox', 'filesystem-only', 'validation'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/filesystem_only_test.go', 'TestSandboxConnect_FilesystemOnlyResumes', [79, 102], '验证 filesystem-only 沙箱在被连接时会自动从暂停状态恢复。', ['test', 'sandbox', 'filesystem-only', 'resume'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/filesystem_only_test.go', 'TestSandboxResume_FilesystemOnlyReboots', [109, 169], '验证 filesystem-only 沙箱在 resume 时通过 reboot 路径重启，并保持持久化语义。', ['test', 'sandbox', 'filesystem-only', 'resume', 'reboot'], 'complex'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/filesystem_only_test.go', 'TestSandboxAutoPause_FilesystemOnly', [177, 262], '验证 filesystem-only 沙箱的完整 auto-pause 生命周期，包括超时自动暂停、持久化与恢复。', ['test', 'sandbox', 'filesystem-only', 'auto-pause'], 'complex'));

// sandboxes/sandbox_auto_pause_test.go
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_auto_pause_test.go', 'TestSandboxAutoPausePauseResume', [17, 54], '验证沙箱在 auto-pause 启用时的暂停与恢复完整流程。', ['test', 'sandbox', 'auto-pause', 'resume'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_auto_pause_test.go', 'TestSandboxAutoPauseResumePersisted', [56, 141], '验证 auto-pause 沙箱恢复后保持之前的运行时持久化状态（文件、进程）。', ['test', 'sandbox', 'auto-pause', 'persistence'], 'complex'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_auto_pause_test.go', 'TestSandboxNotAutoPause', [143, 169], '验证未启用 auto-pause 的沙箱在超时后直接被销毁，而非进入暂停状态。', ['test', 'sandbox', 'auto-pause', 'edge-case'], 'moderate'));

// sandboxes/sandbox_connect_test.go
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_connect_test.go', 'TestSandboxConnect', [17, 182], '端到端验证沙箱连接、暂停后重连、进程持久化以及多次重连的行为一致性。', ['test', 'sandbox', 'connect', 'persistence'], 'complex'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_connect_test.go', 'TestSandboxConnect_CrossTeamAccess_Paused', [184, 206], '验证跨团队访问已暂停沙箱的鉴权与拒绝行为。', ['test', 'sandbox', 'connect', 'authorization'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_connect_test.go', 'TestSandboxConnect_CrossTeamAccess_Running', [208, 227], '验证跨团队访问运行中沙箱的鉴权与拒绝行为。', ['test', 'sandbox', 'connect', 'authorization'], 'simple'));

// sandboxes/sandbox_detail_test.go
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_detail_test.go', 'TestSandboxDetailRunning', [18, 35], '验证运行中沙箱详情接口返回正确的状态与元数据。', ['test', 'sandbox', 'detail'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_detail_test.go', 'TestSandboxDetailReturnsLifecycleAndNetworkConfig', [37, 88], '验证沙箱详情接口返回生命周期字段（运行/暂停）与网络配置（出口策略）。', ['test', 'sandbox', 'detail', 'lifecycle', 'network'], 'complex'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_detail_test.go', 'TestSandboxDetailPaused', [90, 107], '验证已暂停沙箱详情接口返回的状态字段。', ['test', 'sandbox', 'detail', 'paused'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_detail_test.go', 'TestSandboxDetailPausingSandbox', [109, 141], '验证暂停过渡（pausing）状态沙箱详情接口的返回结构。', ['test', 'sandbox', 'detail', 'pausing'], 'moderate'));

// sandboxes/sandbox_fuse_test.go
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_fuse_test.go', 'TestFuseDevicePermissions', [14, 32], '验证沙箱内 FUSE 设备的权限配置正确。', ['test', 'sandbox', 'fuse', 'permissions'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_fuse_test.go', 'TestFuseNonRootAccess', [34, 51], '验证非 root 用户在沙箱内可以访问 FUSE 设备。', ['test', 'sandbox', 'fuse', 'permissions'], 'simple'));

// sandboxes/sandbox_internet_test.go
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_internet_test.go', 'TestInternetAccess', [14, 51], '验证沙箱默认无互联网出口，且按模板配置的互联网访问策略被正确执行。', ['test', 'sandbox', 'network', 'internet'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_internet_test.go', 'TestInternetAccessResumedSbx', [53, 101], '验证已恢复的沙箱在网络访问策略上与新建沙箱保持一致。', ['test', 'sandbox', 'network', 'resume'], 'moderate'));

// sandboxes/sandbox_kill_test.go
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_kill_test.go', 'TestSandboxKill', [15, 143], '全面验证沙箱删除/kill 流程：包括删除不存在的沙箱、删除运行中沙箱、并发删除、删除后查询状态以及级联清理。', ['test', 'sandbox', 'kill', 'validation'], 'complex'));

// sandboxes/sandbox_list_test.go (helpers + tests)
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'pauseSandbox', [21, 28], '测试辅助函数：通过 POST pause 接口暂停指定沙箱。', ['test-helper', 'sandbox', 'pause'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxList', [30, 54], '验证 v2 沙箱列表基础接口的返回结构。', ['test', 'sandbox', 'list'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListWithFilter', [56, 78], '验证 v2 沙箱列表接口的过滤参数（template、team 等）。', ['test', 'sandbox', 'list', 'filter'], 'simple'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListRunning', [80, 109], '验证 v2 列表接口正确返回 running 状态沙箱。', ['test', 'sandbox', 'list', 'running'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListPausing', [165, 219], '验证 v2 列表接口正确返回 pausing 过渡状态沙箱。', ['test', 'sandbox', 'list', 'pausing'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListPaginationRunning', [243, 312], '验证 v2 列表接口在 running 状态下的分页行为。', ['test', 'sandbox', 'list', 'pagination'], 'complex'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListPaginationRunningLargerLimit', [314, 394], '验证 v2 列表接口在较大 limit 下的分页边界行为。', ['test', 'sandbox', 'list', 'pagination', 'edge-case'], 'complex'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListPaginationPaused', [396, 444], '验证 v2 列表接口在 paused 状态下的分页行为。', ['test', 'sandbox', 'list', 'pagination', 'paused'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListPaginationRunningAndPaused', [446, 495], '验证 v2 列表接口同时混合 running 与 paused 状态时的分页行为。', ['test', 'sandbox', 'list', 'pagination'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListRunningV1', [498, 528], '验证 v1 列表接口对 running 状态沙箱的兼容行为。', ['test', 'sandbox', 'list', 'v1'], 'moderate'));
funcs.push(fn('tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go', 'TestSandboxListSortedV1', [550, 580], '验证 v1 列表接口的排序字段返回。', ['test', 'sandbox', 'list', 'v1', 'sorting'], 'simple'));

// ----- Build edges -----
const edges = [];

// imports
const importData = JSON.parse(fs.readFileSync('/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batches.json', 'utf8')).batches[38].batchImportData;
for (const srcPath in importData) {
  for (const tgtPath of importData[srcPath]) {
    if (srcPath !== tgtPath) edges.push(eImports(srcPath, tgtPath));
  }
}

// Helper: build contains + exports edges for a file given function/class nodes
function emitContainment(filePath, fnNodes, clsNodes, exportedNames) {
  for (const n of fnNodes) {
    edges.push(eContains(filePath, n.id));
    if (exportedNames.has(n.name)) edges.push(eExports(filePath, n.id));
  }
  for (const n of clsNodes) {
    edges.push(eContains(filePath, n.id));
    if (exportedNames.has(n.name)) edges.push(eExports(filePath, n.id));
  }
}

// Per-file containment / exports
emitContainment('tests/integration/internal/main_test.go',
  funcs.filter(n => n.filePath === 'tests/integration/internal/main_test.go'), [],
  new Set(['TestMain', 'TestCacheTemplate']));

emitContainment('tests/integration/internal/setup/api_client.go',
  funcs.filter(n => n.filePath === 'tests/integration/internal/setup/api_client.go'), [],
  new Set(['GetAPIClient', 'WithAPIKey', 'WithTestsUserAgent', 'WithUserAgent', 'WithAccessToken', 'WithTeamID']));

emitContainment('tests/integration/internal/setup/db_client.go',
  funcs.filter(n => n.filePath === 'tests/integration/internal/setup/db_client.go'),
  classes.filter(n => n.filePath === 'tests/integration/internal/setup/db_client.go'),
  new Set(['Database', 'GetTestDBClient']));

emitContainment('tests/integration/internal/setup/envd_client.go',
  funcs.filter(n => n.filePath === 'tests/integration/internal/setup/envd_client.go'),
  classes.filter(n => n.filePath === 'tests/integration/internal/setup/envd_client.go'),
  new Set(['EnvdClient', 'GetEnvdClient', 'WithSandbox', 'WithEnvdAccessToken', 'SetSandboxHeader', 'SetAccessTokenHeader', 'SetUserHeader']));

emitContainment('tests/integration/internal/setup/orchestrator_client.go',
  funcs.filter(n => n.filePath === 'tests/integration/internal/setup/orchestrator_client.go'), [],
  new Set(['GetOrchestratorClient']));

// Test files - all tests are exported
const testFiles = [
  'tests/integration/internal/tests/api/apikey_test.go',
  'tests/integration/internal/tests/api/health_test.go',
  'tests/integration/internal/tests/api/metrics/sandbox_list_metrics_test.go',
  'tests/integration/internal/tests/api/metrics/sandbox_metrics_test.go',
  'tests/integration/internal/tests/api/metrics/team_metrics_max_test.go',
  'tests/integration/internal/tests/api/metrics/team_metrics_test.go',
  'tests/integration/internal/tests/api/sandboxes/filesystem_only_test.go',
  'tests/integration/internal/tests/api/sandboxes/sandbox_auto_pause_test.go',
  'tests/integration/internal/tests/api/sandboxes/sandbox_connect_test.go',
  'tests/integration/internal/tests/api/sandboxes/sandbox_detail_test.go',
  'tests/integration/internal/tests/api/sandboxes/sandbox_fuse_test.go',
  'tests/integration/internal/tests/api/sandboxes/sandbox_internet_test.go',
  'tests/integration/internal/tests/api/sandboxes/sandbox_kill_test.go',
  'tests/integration/internal/tests/api/sandboxes/sandbox_list_test.go',
];
for (const tf of testFiles) {
  const fnNodes = funcs.filter(n => n.filePath === tf);
  const exported = new Set(fnNodes.map(n => n.name));
  emitContainment(tf, fnNodes, [], exported);
}

// tested_by edges: test files exercise API endpoints via setup/api_client.go and use api/generated.go client.
// Map each test file -> setup/api_client.go (production helper) since they use GetAPIClient / WithAPIKey / etc.
const testedByTargets = [
  'tests/integration/internal/setup/api_client.go', // production-like helper exercised by tests
  'tests/integration/internal/api/generated.go', // the API client surface tests exercise
];
for (const tf of testFiles) {
  for (const tgt of testedByTargets) {
    if (tf !== tgt) edges.push(eTestedBy(tgt, tf));
  }
}
// also main_test exercises api_client
edges.push(eTestedBy('tests/integration/internal/setup/api_client.go', 'tests/integration/internal/main_test.go'));

// ----- Partition into 3 parts -----
// Sort files alphabetically by path
const sortedPaths = Object.keys(files).sort();
const parts = 3;
const chunkSize = Math.ceil(sortedPaths.length / parts);
const groups = [];
for (let i = 0; i < parts; i++) {
  groups.push(sortedPaths.slice(i * chunkSize, (i + 1) * chunkSize));
}

for (let k = 0; k < parts; k++) {
  const group = groups[k];
  const groupSet = new Set(group);
  const partNodes = [];
  // file nodes for this group
  for (const p of group) partNodes.push(files[p]);
  // function/class nodes whose filePath is in this group
  for (const n of [...funcs, ...classes]) {
    if (groupSet.has(n.filePath)) partNodes.push(n);
  }
  // edges whose source's filePath is in this group OR source file id is in group
  const partEdges = edges.filter(ed => {
    // source could be file: or function:/class:
    const m = ed.source.match(/^(file|function|class):([^:]+(?:\.[a-z]+)?(?::[^:]+)?)/i);
    if (!m) return false;
    // extract filePath by stripping prefix and (for function/class) trailing name
    let fp;
    if (ed.source.startsWith('file:')) {
      fp = ed.source.slice('file:'.length);
    } else if (ed.source.startsWith('function:')) {
      fp = ed.source.slice('function:'.length).split(':')[0];
      // function id format: function:<path>:<name>; but path may contain ':'
      const rest = ed.source.slice('function:'.length);
      const lastColon = rest.lastIndexOf(':');
      fp = rest.slice(0, lastColon);
    } else if (ed.source.startsWith('class:')) {
      const rest = ed.source.slice('class:'.length);
      const lastColon = rest.lastIndexOf(':');
      fp = rest.slice(0, lastColon);
    }
    return groupSet.has(fp);
  });

  const out = { nodes: partNodes, edges: partEdges };
  const outPath = `/Users/joohwan/GolandProjects/infra/.understand-anything/intermediate/batch-39-part-${k + 1}.json`;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}: ${partNodes.length} nodes, ${partEdges.length} edges (paths: ${group.length})`);
}

console.log(`Total nodes: ${Object.keys(files).length + funcs.length + classes.length}`);
console.log(`Total edges: ${edges.length}`);
