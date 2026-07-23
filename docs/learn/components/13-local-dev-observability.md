# Local Dev 与可观测性：在本机重建平台依赖

> `packages/local-dev`、`packages/otel-collector` 和 `tests/` 提供本地依赖栈、遥测落点与分层验证入口，让服务可在不部署云集群时运行和排障。

## 1. 系统位置

`packages/local-dev` 启动的是“服务依赖”，不是完整 E2B 控制面：

```text
应用进程（另行启动）
  ├─ PostgreSQL: 事务数据
  ├─ Redis: 运行时状态
  ├─ ClickHouse: 指标/事件
  ├─ OTLP -> OTel Collector
  │           ├─ traces -> Tempo
  │           ├─ metrics -> Mimir
  │           ├─ logs -> Loki
  │           └─ e2b.* metrics -> ClickHouse
  ├─ HTTP NDJSON -> Vector -> Loki
  └─ SOCKS5: BYOP 网络测试

Grafana -> Tempo / Mimir / Loki
```

`packages/otel-collector` 是 CI/integration 专用的最小 Collector 启动包；生产 Collector 配置在 `iac/modules/job-otel-collector`，不要把三套配置视为同一个文件。

验证层也分开：包内 `*_test.go` 验证纯逻辑，`tests/integration` 驱动本机完整服务链，`tests/periodic-test` 定时验证已部署集群。

## 2. 启动/装配

本地依赖栈：

1. `make local-infra` 进入 `packages/local-dev`。
2. Makefile 用 `envsubst` 从 ClickHouse template 生成本地 server config。
3. Docker Compose 启动 PostgreSQL、Redis、ClickHouse、OTel Collector、Vector、Loki、Mimir、Tempo、Grafana、Memcached 和 SOCKS5。
4. PostgreSQL schema 与 ClickHouse schema 仍需分别执行仓库迁移；Compose 不替代 migrator。
5. `make -C packages/local-dev seed-database` 写入固定本地 user、team、OIDC identity、access token 和 API key；它要求数据库表已经存在。
6. 单独启动 API、Orchestrator、Client Proxy 等应用，并设置本地 connection string、`STORAGE_PROVIDER=Local`、`ARTIFACTS_REGISTRY_PROVIDER=Local` 和 collector/log endpoint。

主要本地端口：

| 服务 | 端口 | 用途 |
| --- | --- | --- |
| PostgreSQL | `5432` | 事务数据库 |
| Redis | `6379` | cache/catalog/events/locks |
| ClickHouse | `9000`、`8123` | native、HTTP |
| OTel Collector | `4317`、`4318` | OTLP gRPC、HTTP |
| Vector | `30006` | NDJSON 日志入口 |
| Loki | `3100` | 日志写入/查询 |
| Grafana | `53000` | 本地 Explore/UI |
| SOCKS5 | `1080` | BYOP proxy 测试 |

`packages/otel-collector/Makefile` 则把 ClickHouse 环境变量替换进测试配置，创建 `e2b` Docker network，并以 `13133` health、`4317` OTLP 端口启动单个 Collector。

## 3. 核心机制与关键对象

### 3.1 应用侧遥测

服务通过 shared `telemetry.New` 创建 OTLP gRPC exporter。只有设置 `OTEL_COLLECTOR_GRPC_ENDPOINT` 才启用；未设置时 metrics、traces、logs 全部使用 noop provider。

资源字段包含 service name/version/instance、host ID/name 和 SDK 信息。Trace 使用 W3C Trace Context/Baggage；logger bridge 把 span ID 写入结构化日志。

### 3.2 本地 OTel Collector

`packages/local-dev/otel-collector.yaml` 接收 OTLP gRPC/HTTP，并建立四条 pipeline：

- traces：batch 后发往 Tempo OTLP gRPC。
- metrics：batch 后发往 Mimir OTLP HTTP。
- metrics/clickhouse：只保留 `e2b.*`，大 batch 写 `metrics_gauge`/`metrics_sum`。
- logs：batch 后发往 Loki OTLP HTTP。

同一个 `e2b.*` metric 会同时进入 Mimir 和 ClickHouse：前者用于通用时序观测，后者通过物化视图形成产品级 team/sandbox metrics。

Tempo 的 metrics generator 把 service graph 与 span metrics remote-write 到 Mimir；`local-blocks` processor 则把 spans 写入本地 traces storage，供 TraceQL metrics 查询。两类处理共同支持 trace 与 metric 之间的跳转，但落点不同。

### 3.3 Vector 与 Loki

Vector 在 `30006` 接收 NDJSON，规范化 `instanceID`、`sandbox_id`、`team_id`、`build_id`、`env_id` 和 dotted OTEL 风格字段，补齐 service/category/ID 默认值。

生产配置把非 internal 日志写入集群 Loki，可选 tee 到 otel-router；internal 日志可写 Grafana Cloud Loki。本地配置只把非 internal 路由写入本地 Loki。

Loki label 固定包含 service、teamID、envID、buildID、sandboxID 和 category。label 是检索索引，原始 JSON message 仍保留在日志 body。

### 3.4 Grafana 数据源

Grafana provisioning 注册三个数据源：Tempo 为默认 trace 数据源，Mimir 使用 Prometheus API，Loki 提供 LogQL。匿名访问在本地开启，不能复制到生产。

Mimir 使用单进程、filesystem backend、无多租户配置；Tempo 也使用本地 block/WAL。它们的目标是复现协议和查询，不是复现生产容量、HA 或保留保证。

### 3.5 测试分层

`tests/integration` 是独立 Go module，通过 OpenAPI 生成 API/envd client，并复用 shared orchestrator gRPC 类型。测试覆盖 API、templates、sandboxes、pause/resume、proxy、envd、volumes 和 metrics。

CI 的 `start-services` action 启动 PostgreSQL、ClickHouse、Redis、最小 OTel Collector，再以本地 storage/registry 启动 Orchestrator、API、Client Proxy。Integration matrix 分别验证 uncompressed、zstd 和 lz4/dedup 组合，并扫描服务日志中的 Go race detector 输出。

`tests/periodic-test` 每 10 分钟在多个真实域名上执行 run code、template build/time sync、pause/resume 和 Internet connectivity；失败时保留 sandbox 供人工连接，并向 incident.io 上报。

## 4. 主数据/部署流

```text
本地启动
docker-compose.yaml
  ├─ postgres <---- db migrations <---- API
  ├─ redis <------------------------ API / Proxy / Orchestrator
  ├─ clickhouse <-- CH migrations
  │       ^
  │       └── OTel filter(e2b.*)
  ├─ vector ----> loki <---- OTel logs
  ├─ otel-collector
  │       ├──> tempo ----> metrics generator ──┐
  │       └──> mimir <─────────────────────────┘
  └─ grafana ----> tempo / mimir / loki

验证
unit tests -> integration local stack -> periodic deployed clusters
```

CI 的 integration 数据流与 Compose 类似，但为可控性逐个启动容器和应用进程，并把 service stdout/stderr 保存到 `~/logs` 作为失败证据。

## 5. 设计不变量与故障边界

- Compose 只提供依赖；“容器都 healthy”不代表 API、Orchestrator 或 sandbox runtime 已启动。
- PostgreSQL 与 ClickHouse migration 必须先于 seed 和指标测试；Collector 配置 `create_schema: false`。
- `OTEL_COLLECTOR_GRPC_ENDPOINT` 为空会静默退化为 noop；看不到数据时先检查应用环境，而不是先查 Grafana。
- `e2b.*` 是进入 ClickHouse 的边界；改 metric name 可能让 Mimir仍有数据而产品指标表断流。
- Vector HTTP 日志与 OTLP logs 是两条入口，字段、internal 路由和保留行为不同。
- 本地 Vector 不持久化 internal 分支到 Loki；不能用本地 UI 是否可见推断生产 internal 日志是否发出。
- Grafana anonymous admin、Mimir 单进程、Tempo filesystem 都是开发配置，不能作为生产安全/HA 模板。
- Compose 的 ClickHouse/PostgreSQL/Tempo 使用 named volume；普通 `down` 不等于清空旧 schema 和数据。
- `packages/otel-collector/tests/otel-collector.yaml` 只验证 external metrics 到 ClickHouse，并把 traces/logs 发往 debug exporter；它不覆盖生产 filter、hostmetrics、Grafana Cloud 或云资源检测。
- Integration test 的 `Eventually` 反映遥测异步性；固定 sleep 会放大机器性能差异。
- 本地 storage/registry 路径不会覆盖 GCS/S3/ECR/Artifact Registry 权限和一致性问题。
- Periodic test 验证真实部署的用户旅程，但覆盖面很窄；它不能替代 integration 的错误分支和数据完整性测试。

## 6. 与其他组件边界

| 对方 | 本地/观测层负责 | 对方负责 |
| --- | --- | --- |
| Shared telemetry/logger | 提供 OTLP 和 NDJSON 接收端 | 埋点、resource/trace 字段、关闭 flush |
| API/Orchestrator/Proxy | 提供依赖和测试 endpoint | 服务进程、业务状态与 lifecycle |
| ClickHouse package | 本地 server 和 Collector 写入口 | migration、查询、batch delivery |
| IaC | 本地配置模拟协议 | 生产 node-local 部署、云鉴权和后端 |
| Integration tests | 从公开/API/内部协议验证组合 | 单包边界条件与纯函数测试 |
| Periodic tests | 验证真实域名的关键旅程 | 深度诊断和完整回归矩阵 |

## 7. 源码阅读顺序

| 顺序 | 路径 | 先回答的问题 |
| --- | --- | --- |
| 1 | `packages/local-dev/docker-compose.yaml` | 本地到底启动了哪些依赖？ |
| 2 | `packages/local-dev/otel-collector.yaml` | traces/metrics/logs 分别去哪？ |
| 3 | `packages/local-dev/vector.toml` | 用户日志如何规范化和打 label？ |
| 4 | `packages/local-dev/grafana-datasources.yaml` | Grafana 查询哪些后端？ |
| 5 | `packages/local-dev/seed-local-database.go` | 固定本地身份和凭据如何生成？ |
| 6 | `packages/otel-collector/tests/otel-collector.yaml` | CI 最小 Collector 验证了什么？ |
| 7 | `iac/modules/job-otel-collector/configs/otel-collector.yaml` | 与生产 Collector 有哪些差异？ |
| 8 | `iac/modules/job-logs-collector/configs/vector.toml` | 生产日志 fan-out 如何工作？ |
| 9 | `tests/integration/README.md`、`internal/setup/` | 测试 client 和环境变量如何接线？ |
| 10 | `.github/actions/start-services/action.yml` | CI 如何重建本地控制面？ |
| 11 | `.github/workflows/periodic-test.yml` | 哪些旅程在真实集群持续运行？ |

## 8. 相关深挖

- [Team/Sandbox Metrics](../../md/team-metrics-module.md)：`e2b.*` 从 SDK 到 API 查询的完整语义。
- [ClickHouse package](../../clickhouse-package.md)：Collector 落表、物化视图与迁移。
- [API 模块](../../md/api-module.md)：integration tests 驱动的主要 HTTP 入口。
- [Client Proxy 模块](../../md/client-proxy-module.md)：本地 auto-resume/proxy tests 对应的运行时链路。
- [Sandbox 生命周期](../../md/sandbox-lifecycle.md)：pause/resume 与 periodic test 验证的状态保持。
