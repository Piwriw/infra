#!/usr/bin/env python3
"""Build the batch-19 graph JSON. Splits into multiple parts when nodes>60 or edges>120."""
import json
import math
import os

ROOT = "/Users/joohwan/GolandProjects/infra"
OUT_DIR = f"{ROOT}/.understand-anything/intermediate"
TMP_DIR = f"{ROOT}/.understand-anything/tmp"

with open(f"{TMP_DIR}/ua-file-extract-results-19.json") as f:
    extraction = json.load(f)

with open(f"{ROOT}/.understand-anything/intermediate/batches.json") as f:
    batches = json.load(f)
batch = batches["batches"][18]
batch_imports = batch.get("batchImportData", {})

file_to_functions = {r["path"]: r.get("functions", []) for r in extraction["results"]}
file_to_classes = {r["path"]: r.get("classes", []) for r in extraction["results"]}

FILE_SUMMARIES = {
    "packages/shared/pkg/httpserver/h2c_test.go": "h2c HTTP 服务器配置的单元测试，覆盖 HTTP/2 cleartext 升级、超时和 idle timeout 行为。",
    "packages/shared/pkg/id/id.go": "提供 sandbox ID、namespace 与 tag 的生成、验证、解析与别名提取工具。",
    "packages/shared/pkg/id/id_test.go": "id 包的完整单元测试，覆盖 sandbox ID 与 tag 的解析、验证和命名空间匹配。",
    "packages/shared/pkg/limit/gcloud.go": "为 GCloud 上传信号量提供便捷访问函数。",
    "packages/shared/pkg/limit/limiter.go": "基于可调信号量的连接限流器，结合 LaunchDarkly feature flag 动态更新上限。",
    "packages/shared/pkg/limit/upload.go": "后台 goroutine 周期性根据 feature flag 调整上传限流上限。",
    "packages/shared/pkg/logger/exporter.go": "实现 HTTP zapcore.WriteSyncer 接口，用于将日志批量异步推送到远程 HTTP 端点。",
    "packages/shared/pkg/logger/exporter_test.go": "HTTP 日志写入器的并发、同步和顺序场景测试。",
    "packages/shared/pkg/logger/fields.go": "集中定义 E2B 各业务字段（sandbox、team、build、kernel 等）的 zap 日志字段构造函数。",
    "packages/shared/pkg/logger/grpc.go": "为 grpclog 提供 zap 适配器，并提供 health check / route 路径过滤选项。",
    "packages/shared/pkg/logger/logger.go": "构建基于 zap + OTEL 的 TracedLogger，支持全局、上下文相关以及多 core 输出。",
    "packages/shared/pkg/logger/sandbox/global.go": "提供 sandbox 内部与外部 logger 的全局访问函数。",
    "packages/shared/pkg/logger/sandbox/logger.go": "sandbox 专用 logger 的工厂与配置。",
    "packages/shared/pkg/logger/sandbox/metadata.go": "为 sandbox 提供统一的元数据接口，用于向 logger 注入字段。",
    "packages/shared/pkg/logger/sandbox/sandbox_logger.go": "封装 sandbox metrics 与 healthcheck 的结构化日志输出。",
    "packages/shared/pkg/logs/logs.go": "日志级别定义与扁平 JSON 日志行的解析逻辑。",
    "packages/shared/pkg/logs/logs_test.go": "FlatJsonLogLineParser 的表驱动单元测试。",
    "packages/shared/pkg/logs/loki/loki.go": "将 Loki 查询响应映射为 LogEntry 结构。",
    "packages/shared/pkg/logs/loki/provider.go": "封装对 Grafana Loki 的 build / sandbox 日志范围查询。",
    "packages/shared/pkg/logs/loki/provider_test.go": "覆盖 Loki 查询构造函数的输入清洗与注入防护测试。",
    "packages/shared/pkg/machineinfo/machine_info.go": "封装宿主机 CPU 信息的数据结构与兼容性比较函数。",
    "packages/shared/pkg/middleware/logging.go": "Gin 中间件，用于记录每个 HTTP 请求的耗时与状态码。",
    "packages/shared/pkg/middleware/otel/joined/joined.go": "管理 gRPC 与 HTTP 在同一 span 上的 join 状态，标记是否合并 trace。",
    "packages/shared/pkg/middleware/otel/joined/joined_test.go": "joined 包在无 holder、并发、idempotent 等场景下的单元测试。",
    "packages/shared/pkg/middleware/otel/metrics/middleware.go": "基于 OpenTelemetry 的 Gin HTTP 请求指标中间件。",
    "packages/shared/pkg/middleware/otel/tracing/middleware.go": "基于 OTEL tracer 的 Gin 链路追踪中间件。",
    "packages/shared/pkg/middleware/routes.go": "在已有中间件基础上按路径匹配进行包含/排除的包装器。",
    "packages/shared/pkg/middleware/timeout.go": "Gin 超时中间件及其请求上下文取消辅助函数。",
    "packages/shared/pkg/middleware/timeout_test.go": "RequestTimeout 在 deadline、blocking、context propagation 等场景下的测试。",
    "packages/shared/pkg/proxy/handler.go": "反向代理入口 handler，统一处理路由、限流与多种业务错误响应。",
    "packages/shared/pkg/proxy/host.go": "从 host 头和 E2B 自定义 header 中解析 sandbox ID 与端口的工具集。",
}

PER_FUNCTION_SUMMARY = {
    "TestConfigureH2CAcceptsHTTP2AndHTTP1": "测试 ConfigureH2C 是否同时接受 HTTP/2 与 HTTP/1.1 请求",
    "TestConfigureH2CLimitsUpgradeRequestBodyOnly": "测试 ConfigureH2C 是否仅限制 HTTP upgrade 请求体",
    "TestConfigureH2CLimitsAllStdlibUpgradeMatches": "测试 ConfigureH2C 与 stdlib upgrade 行为是否一致",
    "TestConfigureH2CPreservesParentIdleTimeout": "测试 ConfigureH2C 保留父级 IdleTimeout 配置",
    "TestNewHTTP2ServerConfiguresH2SpecificTimeouts": "测试 NewHTTP2Server 配置 HTTP/2 专属超时",
    "Generate": "生成 sandbox 唯一标识符",
    "ValidateSandboxID": "校验 sandbox ID 格式",
    "cleanAndValidate": "清洗并校验字符串是否符合给定正则",
    "validateTag": "校验单条 tag 的格式",
    "ValidateAndDeduplicateTags": "校验并去重 tag 列表",
    "SplitIdentifier": "按命名空间/别名拆分 identifier",
    "ParseName": "从用户输入中解析 sandbox 命名空间与别名",
    "WithTag": "为 identifier 附加 tag 后缀",
    "WithNamespace": "构造 namespace/alias 形式的 identifier",
    "ExtractAlias": "从 identifier 中提取 alias 部分",
    "ValidateNamespaceMatchesTeam": "校验 identifier 的 namespace 是否与 team 一致",
    "GCloudUploadLimiter": "暴露 GCloud 上传信号量访问函数",
    "GCloudMaxTasks": "从 feature flag 获取 GCloud 最大并发上传数",
    "New": "构造 Limiter 实例并初始化后台 ticker",
    "Close": "优雅关闭 Limiter",
    "UpdateUploadLimitSemaphore": "周期性同步 feature flag 到信号量上限",
    "NewHTTPWriter": "构造 HTTP 日志写入器",
    "Write": "实现 zapcore.WriteSyncer 写入逻辑，分行异步发送",
    "Sync": "等待所有已发送日志行 ack",
    "sendLogLine": "通过 HTTP POST 发送一条日志行",
    "TestHTTPWriterWaitGroupReuse": "测试 HTTPWriter 多次 Write/Sync 复用的正确性",
    "TestHTTPWriterConcurrentWriteSync": "测试并发 Write/Sync 场景下日志不会丢失或重复",
    "TestHTTPWriterSequentialWrites": "测试顺序写入场景下日志行的完整性",
    "WithSandboxID": "构造 sandbox ID 日志字段",
    "WithLifecycleID": "构造 lifecycle ID 日志字段",
    "WithTemplateID": "构造 template ID 日志字段",
    "WithBuildID": "构造 build ID 日志字段",
    "WithExecutionID": "构造 execution ID 日志字段",
    "WithUserID": "构造 user ID 日志字段",
    "WithTeamID": "构造 team ID 日志字段",
    "WithNodeID": "构造 node ID 日志字段",
    "WithClusterID": "构造 cluster UUID 日志字段",
    "WithEdgeTraceID": "构造 edge trace ID 日志字段",
    "WithServiceInstanceID": "构造 service instance ID 日志字段",
    "WithSandboxIP": "构造 sandbox IP 日志字段",
    "WithEnvdVersion": "构造 envd version 日志字段",
    "WithKernelVersion": "构造 kernel version 日志字段",
    "WithFirecrackerVersion": "构造 firecracker version 日志字段",
    "WithClientIP": "构造 client IP 日志字段",
    "WithMaskedAPIKey": "构造已掩码的 API key 字段",
    "WithMaskedAccessToken": "构造已掩码的 access token 字段",
    "MarshalLogObject": "timeFields 的 ObjectMarshaler 实现",
    "Time": "构造 zap 时间字段",
    "ProxyRequestFields": "构造代理请求相关日志字段",
    "clientIP": "从 *http.Request 提取客户端 IP",
    "GRPCLogger": "grpclog 到 zap 的适配函数",
    "WithoutHealthCheck": "返回过滤掉 /grpc.health.v1.* 路径的 grpclog 适配器",
    "WithoutRoutes": "返回过滤掉 / 路径的 grpclog 适配器",
    "NewLogger": "根据 LoggerConfig 创建带 OTEL core 的 logger",
    "GetConsoleEncoderConfig": "返回控制台输出 zap encoder 配置",
    "GetOTELCore": "获取 OTEL zap core",
    "NewTracedLoggerFromCore": "从给定 core 构造 TracedLogger",
    "NewTracedLogger": "从 zap logger 构造 TracedLogger",
    "L": "返回全局 logger",
    "NewNopLogger": "构造 no-op logger",
    "NewDevelopmentLogger": "构造开发模式 logger",
    "With": "全局 With 入口",
    "Info": "全局 Info 日志入口",
    "Warn": "全局 Warn 日志入口",
    "Error": "全局 Error 日志入口",
    "Fatal": "全局 Fatal 日志入口",
    "Panic": "全局 Panic 日志入口",
    "Debug": "全局 Debug 日志入口",
    "Log": "全局自定义级别日志入口",
    "WithOptions": "全局 WithOptions 入口",
    "Sync": "全局 Sync 入口",
    "Detach": "从 context 中剥离 logger",
    "generateFields": "从 context 生成合并的字段集",
    "ContextWithEdgeTraceID": "将 edge trace id 写入 context",
    "GetEdgeTraceID": "从 context 获取 edge trace id",
    "ReplaceGlobals": "用新 logger 替换全局 logger",
    "SetSandboxLoggerInternal": "设置 sandbox 内部 logger",
    "SetSandboxLoggerExternal": "设置 sandbox 外部 logger",
    "I": "使用 sandbox 内部 logger 输出",
    "E": "使用 sandbox 外部 logger 输出",
    "GetSandboxEncoderConfig": "获取 sandbox JSON encoder 配置",
    "LoggerMetadata": "LoggerMetadata 接口默认实现",
    "Fields": "将 SandboxMetadata 转成 zap fields",
    "Metrics": "记录 sandbox 指标到 logger",
    "Healthcheck": "记录 sandbox 健康检查状态到 logger",
    "StringToLevel": "将日志级别字符串转为内部等级常量",
    "LevelToString": "将内部日志等级常量转为字符串",
    "CompareLevels": "比较两个日志等级",
    "FlatJsonLogLineParser": "解析扁平 JSON 日志行",
    "TestFlatJsonLogLineParser": "FlatJsonLogLineParser 的表驱动测试",
    "ResponseMapper": "将 Loki 查询结果转换为 LogEntry 列表",
    "TestSanitizeLokiLabel": "测试 sanitizeLokiLabel 的清洗规则",
    "TestSanitizeLogMessageRegexFilter": "测试 sanitizeLogMessageRegexFilter 的清洗规则",
    "TestBuildSandboxLogsQueryWithoutSearch": "测试 buildSandboxLogsQuery 在无 search 时的查询字符串",
    "TestBuildSandboxLogsQueryWithMessageSearch": "测试带 search 时的查询字符串",
    "TestBuildBuildLogsQuerySanitizesBackticks": "测试 buildBuildLogsQuery 清洗反引号",
    "TestBuildSandboxLogsQueryEscapesInjectionLikeSearchInput": "测试 buildSandboxLogsQuery 的注入防护",
    "NewLokiQueryProvider": "构造 LokiQueryProvider 客户端",
    "QueryBuildLogs": "查询指定 build 的日志",
    "QuerySandboxLogs": "查询 sandbox 的日志",
    "sanitizeLokiLabel": "清洗 Loki label 输入",
    "sanitizeLogMessageRegexFilter": "清洗 Loki LogQL 消息正则 filter",
    "minLevelRegexFilter": "构造 Loki 最小日志级别 regex filter",
    "buildBuildLogsQuery": "构造 build 日志 Loki LogQL 查询",
    "buildSandboxLogsQuery": "构造 sandbox 日志 Loki LogQL 查询",
    "IsCompatibleWith": "判断宿主机 CPU 信息是否兼容",
    "IsExactMatch": "判断两个 MachineInfo 是否完全一致",
    "FromGRPCInfo": "从 gRPC MachineInfo 转换为本地 MachineInfo",
    "FromLDValue": "从 LaunchDarkly JSON 字符串解析 MachineInfo",
    "LoggingMiddleware": "Gin 请求日志中间件，记录耗时与状态码",
    "TestMark_NoHolder_Noop": "测试 Mark 在无 holder 时为 no-op",
    "TestAttribute_NoHolder_ReturnsFalse": "测试 Attribute 在无 holder 时返回 false",
    "TestAttribute_FreshHolder_ReturnsFalse": "测试新增 holder 的 Attribute 默认返回 false",
    "TestMark_FlipsAttributeToTrue": "测试 Mark 后 Attribute 翻转为 true",
    "TestWithHolder_Idempotent": "测试 WithHolder 的幂等性",
    "TestMark_DescendantGoroutine": "测试子 goroutine 中 Mark 仍能正确影响 holder",
    "WithHolder": "为 context 附加 joined span holder",
    "Mark": "在 holder 上标记已 join",
    "Attribute": "获取 holder 中 joined 标记对应的 OTEL attribute",
    "SetProcessingStartTime": "在 gin.Context 上记录请求处理开始时间",
    "getProcessingStartTime": "从 gin.Context 取出请求处理开始时间",
    "Middleware": "生成 OTEL HTTP 请求指标 Gin 中间件",
    "attributesFromGinContext": "从 gin.Context 中提取 OTEL 指标 attribute",
    "WithRequestStartTime": "将请求开始时间写入 context",
    "GetRequestStartTime": "从 context 取出请求开始时间",
    "CancelCause": "返回带 cause 的取消函数",
    "RequestTimeout": "Gin 超时中间件，设置请求 deadline",
    "TestRequestTimeout_SetsDeadline": "测试 RequestTimeout 设置了 deadline",
    "TestRequestTimeout_CancelsBlockingHandler": "测试 RequestTimeout 能取消阻塞 handler",
    "TestRequestTimeout_NormalRequestContextNotCanceled": "测试普通请求的 context 不会被中间件取消",
    "TestRequestTimeout_TimeoutContextVisibleToOuterMiddleware": "测试 timeout context 对外层中间件可见",
    "ExcludeRoutes": "构造中间件包装器，跳过匹配 pattern 的路径",
    "IncludeRoutes": "构造中间件包装器，仅对匹配 pattern 的路径生效",
    "shouldInclude": "判断路径是否在 include 列表中",
    "shouldSkip": "判断路径是否在 exclude 列表中",
    "matchPattern": "匹配路径与通配符模式",
    "handler": "反向代理 HTTP handler：解析目标、应用限流并代理请求",
    "GetTargetFromRequest": "从请求中解析 sandbox ID 与端口",
    "shouldParseHeaders": "判断 host 是否需要从 header 中解析 sandbox 路由",
    "requestHostname": "从 host 字符串取纯主机名",
    "isLocalRequestHost": "判断 host 是否为本地/IP 形式",
    "SandboxSharedHostDomain": "提取 sandbox 共享域子域",
    "hasRoutingHeaders": "判断是否存在 E2B 路由 header",
    "parseHost": "从 host 字符串解析 sandbox ID 与端口",
    "Error": "MissingHeaderError 的 Error 方法",
    "parseHeaders": "从 request header 解析 sandbox ID 与端口",
}

nodes = []
node_ids = set()

def add_node(node):
    if node["id"] in node_ids:
        return
    node_ids.add(node["id"])
    nodes.append(node)

# Build function nodes
def make_function_node(path, fn):
    name = fn["name"]
    start = fn["startLine"]
    end = fn["endLine"]
    is_test = name.startswith("Test")
    lines = end - start
    complexity = "simple" if lines < 25 else ("moderate" if lines < 80 else "complex")

    tags = []
    if is_test:
        tags.append("test")
    if "logger" in path:
        tags.append("logging")
    if "id" in path and "/id.go" in path:
        tags.append("id-parsing")
    elif "id_test.go" in path:
        tags.append("id-parsing")
    if "limit" in path:
        tags.append("rate-limiting")
    if "middleware" in path:
        tags.append("middleware")
    if "otel" in path:
        tags.append("opentelemetry")
    if "proxy" in path:
        tags.append("proxy")
    if "loki" in path:
        tags.append("loki")
    if "logs/" in path:
        tags.append("logs")
    if "machineinfo" in path:
        tags.append("machine-info")
    if "httpserver" in path:
        tags.append("http-server")
    if "grpc" in path:
        tags.append("grpc")
    if not tags:
        tags = ["utility"]
    tags = list(dict.fromkeys(tags))[:5]

    fn_id = f"function:{path}:{name}"
    summary = PER_FUNCTION_SUMMARY.get(name, f"{name} 函数定义")
    return {
        "id": fn_id,
        "type": "function",
        "name": name,
        "filePath": path,
        "lineRange": [start, end],
        "summary": summary,
        "tags": tags,
        "complexity": complexity,
    }

for path, fns in file_to_functions.items():
    for fn in fns:
        add_node(make_function_node(path, fn))

# Build class nodes
CLASS_SUMMARIES = {
    "TracedLogger": "基于 zap 的带 trace 上下文的 logger 包装类型",
    "LoggerConfig": "logger 构建配置结构体",
    "HTTPWriter": "通过 HTTP 异步批量推送日志的核心 WriteSyncer 实现",
    "Limiter": "可动态调节上限的信号量限流器",
    "SandboxLoggerConfig": "sandbox logger 构建配置结构体",
    "SandboxMetadata": "sandbox 通用元数据接口",
    "LoggerMetadata": "内部 logger 元数据接口",
    "SandboxLogger": "sandbox logger 类型别名（接口）",
    "SandboxMetricsFields": "sandbox 指标结构化日志字段集合",
    "LogEntry": "日志行统一结构：时间戳、消息、级别和字段",
    "MachineInfo": "宿主机 CPU 通用信息",
    "Config": "请求日志中间件配置",
    "LokiQueryProvider": "Loki 范围查询客户端封装",
    "MissingHeaderError": "反向代理解析 sandbox 路由时缺少 header 的错误类型",
    "holder": "OTEL joined span 标记对象",
    "config": "OTEL tracing 中间件配置",
    "timeFields": "zap 时间字段 ObjectMarshaler 实现",
}

def make_class_node(path, cls):
    name = cls["name"]
    start = cls["startLine"]
    end = cls["endLine"]
    methods = cls.get("methods", [])
    props = cls.get("properties", [])
    if len(methods) < 2 and (end - start) < 20:
        return None
    cls_id = f"class:{path}:{name}"
    lines = end - start
    complexity = "simple" if lines < 30 else "moderate" if lines < 100 else "complex"

    tags = []
    if "logger" in path:
        tags.append("logging")
    if "limit" in path:
        tags.append("rate-limiting")
    if "loki" in path or "logs" in path:
        tags.append("logs")
    if "machineinfo" in path:
        tags.append("machine-info")
    if "middleware" in path:
        tags.append("middleware")
    if "proxy" in path:
        tags.append("proxy")
    if not tags:
        tags = ["data-structure"]
    tags = list(dict.fromkeys(tags))[:5]
    return {
        "id": cls_id,
        "type": "class",
        "name": name,
        "filePath": path,
        "lineRange": [start, end],
        "summary": CLASS_SUMMARIES.get(name, f"{name} 类型定义"),
        "tags": tags,
        "complexity": complexity,
    }

for path, clss in file_to_classes.items():
    for cls in clss:
        node = make_class_node(path, cls)
        if node:
            add_node(node)

# Build file nodes
for r in extraction["results"]:
    path = r["path"]
    summary = FILE_SUMMARIES.get(path, f"{os.path.basename(path)} 文件")
    non_empty = r.get("nonEmptyLines", 50)
    if non_empty < 50:
        complexity = "simple"
    elif non_empty < 200:
        complexity = "moderate"
    else:
        complexity = "complex"
    tags = []
    base = os.path.basename(path)
    if base.endswith("_test.go"):
        tags.append("test")
    if "logger" in path:
        tags.append("logging")
    if "/id.go" in path or path.endswith("/id.go"):
        tags.append("id-parsing")
    elif base == "id_test.go":
        tags.append("id-parsing")
    if "limit" in path:
        tags.append("rate-limiting")
    if "middleware" in path:
        tags.append("middleware")
    if "otel" in path:
        tags.append("opentelemetry")
    if "proxy" in path:
        tags.append("proxy")
    if "loki" in path or "logs" in path:
        tags.append("logs")
    if "machineinfo" in path:
        tags.append("machine-info")
    if "httpserver" in path:
        tags.append("http-server")
    if "grpc" in path:
        tags.append("grpc")
    if not tags:
        tags = ["utility"]
    tags = list(dict.fromkeys(tags))[:5]
    file_node = {
        "id": f"file:{path}",
        "type": "file",
        "name": os.path.basename(path),
        "filePath": path,
        "summary": summary,
        "tags": tags,
        "complexity": complexity,
    }
    add_node(file_node)

# Build edges
edges = []
edge_keys = set()

def add_edge(source, target, etype, weight):
    if source == target:
        return
    key = (source, target, etype)
    if key in edge_keys:
        return
    edge_keys.add(key)
    edges.append({
        "source": source,
        "target": target,
        "type": etype,
        "direction": "forward",
        "weight": weight,
    })

# file -> contains -> function/class
for path, fns in file_to_functions.items():
    file_id = f"file:{path}"
    for fn in fns:
        add_edge(file_id, f"function:{path}:{fn['name']}", "contains", 1.0)

for path, clss in file_to_classes.items():
    file_id = f"file:{path}"
    for cls in clss:
        cls_id = f"class:{path}:{cls['name']}"
        if cls_id in node_ids:
            add_edge(file_id, cls_id, "contains", 1.0)

# file -> exports -> exported function/class
for r in extraction["results"]:
    path = r["path"]
    file_id = f"file:{path}"
    funcs_names = {f["name"] for f in r.get("functions", [])}
    classes_names = {c["name"] for c in r.get("classes", [])}
    for exp in r.get("exports", []):
        ename = exp["name"]
        if ename in funcs_names:
            add_edge(file_id, f"function:{path}:{ename}", "exports", 0.8)
        elif ename in classes_names:
            add_edge(file_id, f"class:{path}:{ename}", "exports", 0.8)

# file -> imports -> imports (one edge per entry)
imports_emitted = 0
for path, imports in batch_imports.items():
    file_id = f"file:{path}"
    for imp in imports:
        target = f"file:{imp}"
        add_edge(file_id, target, "imports", 0.7)
        imports_emitted += 1

# tested_by: production -> test
TEST_FILES = {p for p in batch_imports if p.endswith("_test.go")}
for path in TEST_FILES:
    test_file_id = f"file:{path}"
    for imp in batch_imports.get(path, []):
        if imp.endswith("_test.go"):
            continue
        prod_file_id = f"file:{imp}"
        add_edge(prod_file_id, test_file_id, "tested_by", 0.5)

total_imports_needed = sum(len(v) for v in batch_imports.values())
assert sum(1 for e in edges if e["type"] == "imports") == total_imports_needed, \
    f"import edge mismatch: emitted={sum(1 for e in edges if e['type']=='imports')}, need={total_imports_needed}"

# Now split by source-file ordering
sorted_files = sorted(file_to_functions.keys())
N = len(sorted_files)
parts = max(1, math.ceil(max(len(nodes) / 60, len(edges) / 120)))
chunk_size = math.ceil(N / parts)
parts_index = []
for k in range(parts):
    start_i = k * chunk_size
    end_i = min(N, (k + 1) * chunk_size)
    file_set = set(sorted_files[start_i:end_i])
    parts_index.append((k + 1, file_set))

# Build per-part nodes and edges
os.makedirs(OUT_DIR, exist_ok=True)
for part_idx, file_set in parts_index:
    part_nodes = [n for n in nodes if n["type"] != "file" or n["filePath"] in file_set]
    part_node_ids = {n["id"] for n in part_nodes}
    # Edges with source in this part OR with source being a function/class not in this part (we keep imports/calls from this part's files)
    # The rule is: source must be in this part's nodes
    part_edges = []
    for e in edges:
        if e["source"] in part_node_ids:
            part_edges.append(e)
    out_path = f"{OUT_DIR}/batch-19-part-{part_idx}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"nodes": part_nodes, "edges": part_edges}, f, ensure_ascii=False, indent=2)
    print(f"Part {part_idx}: files={len(file_set)}, nodes={len(part_nodes)}, edges={len(part_edges)} -> {out_path}")

print(f"Total: nodes={len(nodes)}, edges={len(edges)}, parts={parts}")
print(f"Imports emitted: {imports_emitted} (need {total_imports_needed})")
