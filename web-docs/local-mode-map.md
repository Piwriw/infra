# Local 模式：先看懂本地运行的边界

本地开发由两部分组成：Docker Compose 提供 PostgreSQL、Redis、ClickHouse 和可选的观测服务；API、orchestrator、client-proxy 等 Go 服务由开发者分别启动。`make local-infra` 只启动依赖，不会启动完整的 E2B 服务。

## 本地拓扑

```text
SDK / curl
    │ REST :3000
    ▼
   API ───── PostgreSQL :5432（持久业务数据）
    │        Redis :6379（运行中沙箱状态与路由）
    │ gRPC :5008
    ▼
orchestrator ─── Firecracker microVM ─── envd :49983
    │
    └── 节点代理 :5007 ◀── client-proxy :3002

ClickHouse :9000 / :8123（指标、事件）
OTel Collector :4317 / :4318 → Tempo、Mimir、Loki
Vector :30006 → Loki
```

API 的管理请求和沙箱的数据流分开：API 创建沙箱并通知 orchestrator；客户端访问沙箱端口时走 client-proxy 和节点代理，不经过 API。

## Local 在代码里的含义

- `ENVIRONMENT=local` 让服务使用本地开发配置。API 未设置 `SERVICE_DISCOVERY_PROVIDER` 时，会在开发环境选择 `local`，并使用 `LOCAL_ORCHESTRATOR_ADDRESS`（默认 `127.0.0.1:5008`）。
- 本地 cluster 是 API 内部的单机实现，不需要 Nomad 或 Kubernetes。`packages/api/internal/handlers/store.go` 负责选择服务发现方式，`packages/shared/pkg/servicediscovery` 提供静态本地节点。
- `.env.local` 文件为 API、orchestrator 和 client-proxy 配置本机依赖地址；配置值以这些文件和各服务配置代码为准。
- 正常创建 Firecracker 沙箱需要 Linux、KVM、NBD 和 huge pages。macOS 上的 `dummy-orchestrator` 适合开发 API 调用路径，不会运行真实 VM。

## 入口与端口

| 进程 / 依赖 | 本地端口 | 用途 |
|---|---:|---|
| API | 3000 | REST API |
| API internal / edge gRPC | 5009 / 5109 | 内部生命周期调用、代理触发恢复 |
| Orchestrator | 5008 | API 调用的 gRPC 服务 |
| Orchestrator proxy | 5007 | 接收 client-proxy 转发的沙箱流量 |
| Client proxy | 3002 / 3003 | 沙箱流量入口 / 健康检查 |
| PostgreSQL / Redis | 5432 / 6379 | 业务数据 / 运行状态和路由 |
| ClickHouse | 8123 / 9000 | HTTP / native 接口 |
| Grafana / Loki | 53000 / 3100 | 可视化 / 日志 |
| OTel Collector | 4317 / 4318 | OTLP gRPC / HTTP |

VM 内的 envd 默认监听 `49983`；它不是宿主机上供 SDK 直接访问的端口。

## 相关源码

- 服务本地配置：[`packages/api/.env.local`](../packages/api/.env.local)、[`packages/orchestrator/.env.local`](../packages/orchestrator/.env.local)、[`packages/client-proxy/.env.local`](../packages/client-proxy/.env.local)
- 依赖栈：[`packages/local-dev/docker-compose.yaml`](../packages/local-dev/docker-compose.yaml)
- API 组装与本地服务发现：[`packages/api/internal/handlers/store.go`](../packages/api/internal/handlers/store.go)
- 总体架构：[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
