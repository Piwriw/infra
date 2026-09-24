# Local 模式：依赖、日志与观测

`packages/local-dev/docker-compose.yaml` 启动基础依赖和可选的观测服务。API、orchestrator 和 client-proxy 是单独的本地 Go 进程；它们通过各自的 `.env.local` 连接这些容器。

## 本地依赖

| 组件 | 端口 | Local 模式用途 | 是否为沙箱基本运行所需 |
|---|---:|---|---|
| PostgreSQL | 5432 | 团队、模板、构建和快照元数据 | 是 |
| Redis | 6379 | 运行状态、路由目录、协调数据 | 是 |
| ClickHouse | 8123 / 9000 | 指标和事件 | 创建沙箱与转发请求不直接依赖；指标和事件功能需要 |
| Loki | 3100 | 本地服务日志查询 | 否 |
| Vector | 30006 | 转发服务日志到 Loki | 否 |
| OTel Collector | 4317 / 4318 | 接收 traces、metrics 和 logs | 否 |
| Tempo / Mimir | Compose 内部 | 存储 traces / metrics，Grafana 使用 | 否 |
| Grafana | 53000 | 查看日志、trace 和 metrics | 否 |

Compose 内还包含 memcached 和 Tempo 初始化容器，它们支撑本地观测栈。

## 日志、trace 和 metrics 去向

```text
应用 OTLP :4317/:4318 → OTel Collector
  ├─ traces → Tempo
  ├─ metrics → Mimir
  ├─ e2b.* metrics → ClickHouse（同时也进入 Mimir）
  └─ OTLP logs → Loki

HTTP NDJSON :30006 → Vector → Loki
Grafana :53000 → 查询 Tempo / Mimir / Loki
```

两条日志入口作用不同：OTLP logs 由 Collector 接收，HTTP NDJSON 由 Vector 接收；它们最后都写入 Loki。Collector 还会把 `e2b.*` 指标写入 ClickHouse，供本地 API 的指标查询使用。应用没有设置 `OTEL_COLLECTOR_GRPC_ENDPOINT` 时，共享 telemetry SDK 会使用 noop provider；看不到 trace 或 metrics 时，先检查各服务 `.env.local` 的 collector 地址，再看 Collector 和 Grafana。

## 初始化数据

服务启动前按 [`DEV-LOCAL.md`](../DEV-LOCAL.md) 执行数据库迁移和种子数据脚本：

- `make -C packages/db migrate-local`
- `make -C packages/clickhouse migrate-local`
- `make -C packages/local-dev seed-database`

`seed-database` 建立本地测试团队及 API key。只在本地开发环境使用该固定种子凭证。

表字段、表关系、ClickHouse 指标/事件列以及 Redis key 的内容和 TTL 见[Local 数据字典](./database-schema.md)。

## 排查顺序

1. 用 `docker compose -f packages/local-dev/docker-compose.yaml ps` 确认 PostgreSQL、Redis 和 ClickHouse 已就绪。
2. 确认各服务的 `.env.local` 指向本机端口，且 API、orchestrator、client-proxy 已分别启动。
3. 沙箱创建失败时，查看 API 与 orchestrator 日志；访问失败时，再检查 Redis 路由和 client-proxy。
4. 只有日志、trace 或指标不可见时，检查 Vector、Loki、OTel Collector、Tempo / Mimir 与 Grafana。观测服务不是运行 VM 的前置条件。

观测配置源码位于 `packages/local-dev/` 和 `packages/otel-collector/`。
