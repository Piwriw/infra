# E2B Edge API 模块详解

> 范围:本文描述 `spec/openapi-edge.yml` 定义的 9 个 HTTP 端点,以及当前仓库中 `packages/api` 如何使用这些端点访问远端 cluster。Edge 服务端实现不在本仓库;因此服务端内部存储、部署和查询实现不做推测,只描述 OpenAPI 契约和本仓库中可验证的客户端行为。

## 目录

- [一、概述](#一概述)
- [二、契约与代码生成](#二契约与代码生成)
- [三、Edge 在多集群架构中的位置](#三edge-在多集群架构中的位置)
- [四、认证与连接配置](#四认证与连接配置)
- [五、端点全景](#五端点全景)
- [六、Service Discovery](#六service-discovery)
- [七、Sandbox Logs](#七sandbox-logs)
- [八、Sandbox Metrics](#八sandbox-metrics)
- [九、Template Build Logs](#九template-build-logs)
- [十、Health 与节点信息](#十health-与节点信息)
- [十一、响应转换与错误映射](#十一响应转换与错误映射)
- [十二、兼容性机制](#十二兼容性机制)
- [十三、关键时序](#十三关键时序)
- [十四、配置与同步周期](#十四配置与同步周期)
- [十五、常见问题与排查](#十五常见问题与排查)
- [十六、关键文件索引](#十六关键文件索引)
- [附录 A:端点速查](#附录-a端点速查)
- [附录 B:时间单位与限制](#附录-b时间单位与限制)

---

## 一、概述

Edge API 是控制面 API 访问**远端 cluster**时使用的 HTTP 契约。它不负责创建、暂停或恢复 sandbox;这些生命周期操作仍然通过远端 endpoint 代理的 gRPC 服务完成。Edge API 主要承担三类读取:

1. **服务发现**:返回远端 cluster 中的 orchestrator / template-builder 节点。
2. **可观测数据**:读取 sandbox 日志、单 sandbox 时间序列指标、批量最新指标。
3. **持久化构建日志**:读取 template build 的结构化日志。

此外还有健康检查和 Edge 节点自身信息端点。

### 1.1 与其他文档的边界

| 文档 | 关注点 |
|---|---|
| [clusters-module.md](./clusters-module.md) | Cluster/Pool/Instance 抽象、local/remote 选择、节点同步 |
| [team-metrics-module.md](./team-metrics-module.md) | 公共 API 的 team/sandbox metrics 端点和 ClickHouse 查询 |
| [template-build-flow.md](./template-build-flow.md) | Template build 注册、执行、状态同步和对外日志端点 |
| **本文** | Edge HTTP 契约、远端资源读取、鉴权头、转换和兼容性 |

### 1.2 重要边界:本仓库没有 Edge 服务端

本仓库的生成配置只启用 `client` 和 `models`:

```yaml
package: edge
output: generated.go
generate:
  client: true
  models: true
```

因此 [`packages/shared/pkg/http/edge/generated.go`](../../packages/shared/pkg/http/edge/generated.go) 是强类型 HTTP 客户端,不是 Gin/Chi 服务端。本文所说的“Edge 返回”来自 OpenAPI 响应契约;服务端具体如何查日志、指标和节点信息不在本仓库内。

---

## 二、契约与代码生成

### 2.1 单一契约源

OpenAPI 文件:

```text
spec/openapi-edge.yml
```

生成入口:

```go
// packages/shared/pkg/http/edge/generate.go
//go:generate go tool github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen \
//  -config ./cfg.yaml ../../../../../spec/openapi-edge.yml
```

生成物提供两层客户端:

| 类型 | 行为 |
|---|---|
| `Client` | 返回原始 `*http.Response` |
| `ClientWithResponses` | 解析 JSON body,暴露 `JSON200`、`JSON400`、`JSON401`、`JSON500` |

业务代码统一使用 `ClientWithResponses`,避免手写 URL、query 编码和 JSON 解码。

### 2.2 核心模型

| 模型 | 用途 |
|---|---|
| `ClusterNodeInfo` | `/v1/info` 的 Edge 节点信息 |
| `ClusterServiceDiscovery` | 当前 service discovery 响应,包含 `orchestrators` |
| `ClusterOrchestratorNode` | 远端节点身份、地址、状态与角色 |
| `SandboxLogsResponse` | 兼容旧文本日志和新结构化日志 |
| `SandboxMetric` | 单个时间点的 CPU、内存、磁盘指标 |
| `SandboxesWithMetrics` | sandbox ID 到最新指标的 map |
| `TemplateBuildLogsResponse` | 结构化 build log 数组 |
| `Error` | `{code, message}` 错误体 |

---

## 三、Edge 在多集群架构中的位置

### 3.1 Local 与 Remote 的资源读取差异

```text
公共 API handler
       │
       ▼
clusters.Pool ── 根据 team/template/sandbox 的 clusterID 选 Cluster
       │
       ├─ Local Cluster
       │    ├─ Service discovery: 本地 Nomad/Kubernetes/static
       │    ├─ Metrics: ClickHouse 或本地资源 provider
       │    └─ Logs: Loki + builder gRPC
       │
       └─ Remote Cluster
            ├─ Service discovery: Edge /v1/service-discovery
            ├─ Sandbox metrics/logs: Edge HTTP API
            ├─ Persistent build logs: Edge HTTP API
            └─ 生命周期/节点 RPC: endpoint 代理的 gRPC
```

`ClusterResource` 接口把 local 和 remote 的差异收敛为四个方法:

```go
type ClusterResource interface {
    GetSandboxMetrics(...)
    GetSandboxesMetrics(...)
    GetSandboxLogs(...)
    GetBuildLogs(...)
}
```

远端实现是 `ClusterResourceProviderImpl`;内部持有 cluster ID、节点 map 和 Edge `ClientWithResponses`。

### 3.2 Remote cluster 初始化

`clusters.Pool` 每 15 秒从 `clusters` 数据表同步一次 active cluster。远端记录提供:

| 字段 | 作用 |
|---|---|
| `endpoint` | Edge HTTP 与 gRPC proxy 的地址 |
| `endpoint_tls` | 决定 `http/https` 和 gRPC transport security |
| `token` | Edge HTTP/gRPC 共享 secret |
| `sandbox_proxy_domain` | 该 cluster 的 sandbox 域名 |
| `auth_org_id` | 外部认证组织映射 |

初始化远端 cluster 时会创建:

1. 一个 Edge HTTP client。
2. 一个 `RemoteServiceDiscovery`。
3. 一个远端 `ClusterResourceProviderImpl`。
4. 一个 5 秒周期的 instance 同步循环。

---

## 四、认证与连接配置

### 4.1 HTTP 鉴权

受保护的 Edge 端点使用 OpenAPI `ApiKeyAuth`:

```http
X-API-Key: <cluster token>
```

`newRemoteCluster` 给生成客户端追加全局 `RequestEditor`,每个请求都写入同一个 cluster token:

```go
req.Header.Set(consts.EdgeApiAuthHeader, secret)
```

这里的 `X-API-Key` 是**cluster 间共享 secret**,不是终端用户通过公共 API 使用的 team API key。虽然 header 名相同,信任边界不同。

### 4.2 gRPC 鉴权

远端 gRPC 请求使用 per-RPC metadata:

```text
authorization: <cluster token>
service-instance-id: <目标 service instance ID>
```

Edge HTTP API 用于发现节点和读取持久化资源;带 `service-instance-id` 的 gRPC metadata 用于 endpoint 把 RPC 路由到具体 orchestrator/template-builder 实例。

### 4.3 TLS

- `endpoint_tls=false`:HTTP + insecure gRPC transport。
- `endpoint_tls=true`:HTTPS + TLS gRPC,最低 TLS 1.2。

HTTP client 的 base URL 和 gRPC target 来自同一个 `endpoint`,但协议和路由由各自客户端处理。

---

## 五、端点全景

OpenAPI 共定义 9 个 endpoint:

| 分组 | Method | Path | 是否声明 `ApiKeyAuth` | 本仓库主要调用方 |
|---|---|---|---|---|
| 运维 | GET | `/health` | 否 | 健康探测 |
| 运维 | GET | `/health/machine` | 否 | 节点健康探测 |
| 运维 | GET | `/v1/info` | 否 | 节点信息/诊断 |
| discovery | GET | `/v1/service-discovery/nodes/orchestrators` | 是 | 已废弃,当前 API 不调用 |
| discovery | GET | `/v1/service-discovery` | 是 | `RemoteServiceDiscovery` |
| sandboxes | GET | `/v1/sandboxes/{sandboxID}/logs` | 是 | 公共 sandbox logs handler |
| sandboxes | GET | `/v1/sandboxes/{sandboxID}/metrics` | 是 | 单 sandbox metrics |
| sandboxes | GET | `/v1/sandboxes/metrics` | 是 | 批量 sandbox metrics |
| templates | GET | `/v1/templates/builds/{buildID}/logs` | 是 | template build logs |

注意:`templates` 被 endpoint 使用,但顶层 `tags` 列表只声明了 `service-discovery` 和 `sandboxes`;这不影响代码生成和运行时请求。

---

## 六、Service Discovery

### 6.1 当前端点:`GET /v1/service-discovery`

响应主体:

```json
{
  "orchestrators": [
    {
      "nodeID": "node-a",
      "serviceInstanceID": "instance-a",
      "serviceVersion": "...",
      "serviceVersionCommit": "...",
      "serviceHost": "10.0.0.12:5008",
      "serviceStartedAt": "2026-01-01T00:00:00Z",
      "serviceStatus": "healthy",
      "roles": ["orchestrator", "template-builder"]
    }
  ]
}
```

`RemoteServiceDiscovery.Query` 将每个节点转换为内部 `discovery.Item`:

| Edge 字段 | 内部字段 |
|---|---|
| `serviceInstanceID` | `UniqueIdentifier`、`InstanceID` |
| `nodeID` | `NodeID` |
| `serviceHost` | 去掉 port 后写入 `LocalIPAddress` |

随后 instance 同步器根据 `UniqueIdentifier` 添加或移除 `Instance`,并通过 gRPC `ServiceInfo` 获取最新状态、角色和 machine info。

### 6.2 废弃端点

`GET /v1/service-discovery/nodes/orchestrators` 返回裸数组,已在 OpenAPI 标记 `deprecated: true`。当前 `RemoteServiceDiscovery` 不调用它,而是使用带 `orchestrators` 包装对象的新端点。

### 6.3 失败行为

`RemoteServiceDiscovery.Query` 要求:

- HTTP status 必须是 200。
- `JSON200` 不能为 nil。

否则本轮同步失败。连续同步和 instance 健康状态的处理属于 [clusters-module.md](./clusters-module.md),不是 Edge handler 自身的行为。

---

## 七、Sandbox Logs

### 7.1 `GET /v1/sandboxes/{sandboxID}/logs`

Query 参数:

| 参数 | 必填 | 单位/限制 | 说明 |
|---|---|---|---|
| `teamID` | 是 | string | sandbox 所属 team |
| `start` | 否 | Unix 毫秒 | 开始时间 |
| `end` | 否 | Unix 毫秒 | 结束时间 |
| `limit` | 否 | 默认 1000,最小 0 | 最大返回条数 |
| `direction` | 否 | `forward`/`backward` | 默认 forward |
| `level` | 否 | debug/info/warn/error | 最低日志级别 |
| `search` | 否 | 最长 256 | 区分大小写的 message 子串 |

公共 API 的 `GetSandboxLogs` 将参数原样映射到 Edge 类型,其中日志级别通过共享 `logs.LogLevel` 转换。

### 7.2 双格式响应

响应同时保留两种日志:

```json
{
  "logs": [
    {"timestamp": "...", "line": "legacy text line"}
  ],
  "logEntries": [
    {
      "timestamp": "...",
      "level": "info",
      "message": "structured message",
      "fields": {"key": "value"}
    }
  ]
}
```

客户端分别转换为公共 API 的 `SandboxLog` 和 `SandboxLogEntry`,不会在转换时合并或去重。

### 7.3 Filter 能力协商

老版本 Edge 可能接受 `level`/`search`,但未真正应用过滤。新版本通过响应头声明能力:

```text
X-E2B-Edge-Feature-Sandbox-Logs-Level-Text-Filtering-Enabled
```

当调用方请求了 `level` 或非空 `search`,但响应缺少该 header 时,API 仍返回 Edge 的结果,同时记录结构化 warning:

```text
edge incompatible with api contract: sandbox logs level+text filtering not supported
```

这是一种“可用但可能语义降级”的兼容策略,不是请求失败。

---

## 八、Sandbox Metrics

### 8.1 单 sandbox 时间序列

```http
GET /v1/sandboxes/{sandboxID}/metrics?teamID=...&start=...&end=...
```

这里的 `start`/`end` 是 **Unix 秒**,与 logs 的毫秒不同。响应为 `SandboxMetric[]`。

每个点包含:

| 类别 | 字段 |
|---|---|
| 时间 | `timestamp`, `timestamp_unix` |
| CPU | `cpu_used_pct`, `cpu_count` |
| 内存 | `mem_total`, `mem_used`, `mem_cache` |
| 磁盘 | `disk_total`, `disk_used` |

API 客户端逐字段转换为公共 API 的同名语义模型。

### 8.2 批量最新指标

```http
GET /v1/sandboxes/metrics?teamID=...&sandbox_ids=id1&sandbox_ids=id2
```

响应不是数组,而是 map:

```json
{
  "sandboxes": {
    "sandbox-1": {"timestamp_unix": 0, "cpu_used_pct": 0},
    "sandbox-2": {"timestamp_unix": 0, "cpu_used_pct": 0}
  }
}
```

OpenAPI description 约定最多 100 个 sandbox ID。公共 API handler 负责对用户请求执行相应的数量限制;Edge client 本身只负责 query 编码。

### 8.3 数据源边界

本仓库只知道 Edge 返回的模型,不知道远端服务从何处读取指标。不要根据 local cluster 的 ClickHouse 实现推断 remote Edge 也使用相同存储。

---

## 九、Template Build Logs

### 9.1 `GET /v1/templates/builds/{buildID}/logs`

| 参数 | 必填 | 单位/限制 | 说明 |
|---|---|---|---|
| `buildID` | 是 | path | Build ID |
| `templateID` | 是 | query | Template ID |
| `orchestratorID` | 否 | deprecated | 旧路由参数 |
| `offset` | 否 | 默认 0 | 兼容基于序号的读取 |
| `start`/`end` | 否 | Unix 毫秒 | 时间窗口 |
| `limit` | 否 | 默认 100,最大 100 | 返回条数 |
| `direction` | 否 | forward/backward | 查询方向 |
| `level` | 否 | 日志级别 | 最低级别 |

当前客户端仍发送:

```go
OrchestratorID: new("unused")
```

这是兼容旧 Edge 契约的临时字段;OpenAPI 已将参数标记为 deprecated。

### 9.2 临时日志与持久化日志

`GetBuildLogs` 不总是直接查 Edge:

1. 如果有 `nodeID`,先尝试通过 builder gRPC 读临时日志。
2. 临时源不可用或调用方选择 persistent source 时,再调用 Edge。
3. 返回第一个成功的数据源。

Edge 在这个流程中是**远端 cluster 的持久化日志 backend**,不是 build 运行中的唯一日志来源。

### 9.3 时间窗口

API 侧 `LogQueryWindow` 将 build logs 限制在最近 7 天。cursor + direction 决定窗口向前或向后展开,再转换为 Unix 毫秒传给 Edge。

---

## 十、Health 与节点信息

### 10.1 `GET /health`

只定义 200 成功响应,用于服务级健康探测。

### 10.2 `GET /health/machine`

用于机器状态健康探测,同样只定义 200。

### 10.3 `GET /v1/info`

返回当前 Edge 节点:

- `nodeID`
- `serviceInstanceID`
- `serviceVersion`
- `serviceVersionCommit`
- `serviceStartup`
- `serviceStatus`:healthy/draining/unhealthy/standby

这三个端点没有在 operation 上声明 `ApiKeyAuth`;它们主要是运维面契约。当前 `packages/api/internal/clusters` 的正常发现与资源查询路径不调用它们。

---

## 十一、响应转换与错误映射

### 11.1 成功响应的严格条件

资源读取同时要求:

```text
HTTP status == 200
AND
JSON200 != nil
```

只有 status 200 但 body 未成功解码,仍按失败处理。

### 11.2 `handleEdgeErrorResponse`

| Edge 响应 | 公共 API 行为 |
|---|---|
| 400 + JSON message | 保留 message,向用户返回 400 |
| 401 | 内部记录 Edge message,对外转换为通用 500 |
| 500 | 内部记录 Edge message,对外转换为通用 500 |
| 其他状态/空错误体 | `Unexpected error occurred`,对外通用 500 |
| HTTP transport 错误 | 对外通用 500 |

只有 400 被视为可安全透传的调用方错误。鉴权 secret、远端故障和未知响应不会直接泄露 Edge 细节给终端用户。

### 11.3 字段转换

转换层刻意逐字段复制,而不是直接复用 Edge model。这样公共 API contract 与 cluster 内部 contract 可以独立演进,代价是新增字段必须显式同步。

---

## 十二、兼容性机制

### 12.1 Feature header

当前显式能力协商只有 sandbox logs 的 level/text filtering header。缺 header 时记录:

- `incompatibility_type=missing_feature_header`
- `feature_header=<header name>`
- cluster ID、sandbox ID
- 是否请求 level/search filter

### 12.2 Deprecated 参数与端点

| 对象 | 当前状态 |
|---|---|
| `/v1/service-discovery/nodes/orchestrators` | Deprecated,客户端不调用 |
| `orchestratorID` build logs query | Deprecated,客户端暂时传 `unused` |
| Sandbox logs `logs` 文本数组 | 与结构化 `logEntries` 并存 |

跨版本部署时不要只看 HTTP 200;还要检查 feature header 和实际响应字段。

---

## 十三、关键时序

### 13.1 远端 service discovery

```text
clusters sync loop (每 15s)
        │
        └─ 初始化/保留 remote Cluster
                  │
instance sync loop (每 5s)
                  │
                  ├─ GET Edge /v1/service-discovery
                  │      X-API-Key: cluster token
                  │
                  ├─ ClusterOrchestratorNode[] → discovery.Item[]
                  │
                  └─ 创建/移除 Instance
                         └─ gRPC ServiceInfo 同步状态和角色
```

### 13.2 公共 sandbox metrics 到远端 Edge

```text
用户
 │ GET /sandboxes/{id}/metrics
 ▼
公共 API handler
 │ 解析 team/sandbox clusterID
 ▼
clusters.Pool → Remote Cluster
 │ ClusterResource.GetSandboxMetrics
 ▼
Edge GET /v1/sandboxes/{id}/metrics
 │ X-API-Key + teamID + start/end(seconds)
 ▼
Edge SandboxMetric[]
 │ 逐字段转换
 ▼
公共 API SandboxMetric[]
```

### 13.3 Build logs 双源读取

```text
GET 公共 build logs
        │
        ├─ nodeID 存在 → builder gRPC temporary logs
        │                    │
        │                    └─ 成功则直接返回
        │
        └─ Edge /v1/templates/builds/{buildID}/logs
                           persistent logs
```

---

## 十四、配置与同步周期

| 配置/常量 | 值/来源 | 影响 |
|---|---|---|
| Edge base URL | `clusters.endpoint` + `endpoint_tls` | HTTP client 地址 |
| Edge token | `clusters.token` | `X-API-Key` 和 gRPC authorization |
| Cluster pool sync | 15 秒 | 新增/删除 remote cluster 的发现延迟 |
| Instance sync | 5 秒 | Edge service discovery 对账周期 |
| Instance sync timeout | 5 秒 | 单轮节点列表同步上限 |
| ServiceInfo timeout | 1 秒 | 单节点状态同步上限 |
| Build logs retention window | 7 天 | API 侧传给 Edge 的查询范围 |

`PoolUpdate` 当前为空:数据库中已存在 cluster 的 endpoint/token 改动不会通过 update 分支热更新现有 client。需要结合 cluster 移除/重建或服务重启理解配置变更行为。

---

## 十五、常见问题与排查

### Q1:Remote cluster 一直没有节点

检查:

1. `clusters` 表中的 endpoint、TLS、token。
2. `GET /v1/service-discovery` 是否返回 200 和非空 JSON。
3. `serviceHost` 是否能解析出有效 host。
4. 后续 gRPC `ServiceInfo` 是否可通过 endpoint + `service-instance-id` 路由。

### Q2:Edge 返回 401,用户却看到 500

这是当前错误映射策略。401 表示 cluster 间 secret 或 Edge 鉴权配置错误,不作为终端用户的认证错误透传。查 API 日志中的原始 Edge message 和 cluster ID。

### Q3:Sandbox logs 的 level/search 没生效

检查响应是否带:

```text
X-E2B-Edge-Feature-Sandbox-Logs-Level-Text-Filtering-Enabled
```

缺失时 API 会记录兼容性 warning,但仍返回未过滤或部分过滤结果。

### Q4:Metrics 时间范围明显不对

确认时间单位:

- Sandbox metrics:`start/end` 为 Unix **秒**。
- Sandbox logs/build logs:`start/end` 为 Unix **毫秒**。

### Q5:Build logs 为空但 Edge 有数据

检查 `source` 选择、7 天窗口、direction/cursor、level、templateID/buildID,以及是否先从 builder temporary source 得到了空但成功的结果。

### Q6:改了 cluster token 但请求仍使用旧 token

`PoolUpdate` 不重建 client。确认 cluster 是否被重新初始化,必要时通过受控的 cluster 重建或服务重启使 client 使用新配置。

### Q7:为什么 `/v1/info` 没参与 service discovery?

节点列表来自 `/v1/service-discovery`;`/v1/info` 只描述 Edge 服务节点自身,两者模型和用途不同。

---

## 十六、关键文件索引

| 文件 | 职责 |
|---|---|
| [`spec/openapi-edge.yml`](../../spec/openapi-edge.yml) | 9 个端点与模型的契约源 |
| [`packages/shared/pkg/http/edge/cfg.yaml`](../../packages/shared/pkg/http/edge/cfg.yaml) | oapi-codegen client/models 配置 |
| [`packages/shared/pkg/http/edge/generated.go`](../../packages/shared/pkg/http/edge/generated.go) | 生成的强类型客户端 |
| [`packages/shared/pkg/http/edge/incompatibility_log.go`](../../packages/shared/pkg/http/edge/incompatibility_log.go) | feature header 缺失告警 |
| [`packages/shared/pkg/consts/edge.go`](../../packages/shared/pkg/consts/edge.go) | HTTP/gRPC 鉴权头和 feature header |
| [`packages/api/internal/clusters/cluster.go`](../../packages/api/internal/clusters/cluster.go) | Remote cluster/client 初始化 |
| [`packages/api/internal/clusters/discovery/remote.go`](../../packages/api/internal/clusters/discovery/remote.go) | Edge service discovery 消费 |
| [`packages/api/internal/clusters/resources.go`](../../packages/api/internal/clusters/resources.go) | ClusterResource 接口、日志双源逻辑 |
| [`packages/api/internal/clusters/resources_remote.go`](../../packages/api/internal/clusters/resources_remote.go) | Edge metrics/logs/build logs 转换 |
| [`packages/api/internal/clusters/clusters_sync.go`](../../packages/api/internal/clusters/clusters_sync.go) | Cluster pool 周期同步 |
| [`packages/api/internal/clusters/instance_client.go`](../../packages/api/internal/clusters/instance_client.go) | 远端 gRPC metadata 与 TLS |

---

## 附录 A:端点速查

```text
GET /health
GET /health/machine
GET /v1/info
GET /v1/service-discovery/nodes/orchestrators  [deprecated]
GET /v1/service-discovery
GET /v1/sandboxes/{sandboxID}/logs
GET /v1/sandboxes/{sandboxID}/metrics
GET /v1/sandboxes/metrics
GET /v1/templates/builds/{buildID}/logs
```

## 附录 B:时间单位与限制

| 端点 | 时间单位 | 默认/上限 |
|---|---|---|
| Sandbox logs | Unix 毫秒 | limit 默认 1000 |
| Sandbox metrics | Unix 秒 | 时间范围可选 |
| Batch sandbox metrics | 无时间范围 | 描述约定最多 100 IDs |
| Build logs | Unix 毫秒 | limit 默认 100,最大 100 |

