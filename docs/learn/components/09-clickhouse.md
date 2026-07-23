# ClickHouse：事件与指标分析层

> `packages/clickhouse` 定义 E2B 的 ClickHouse 查询、异步批量写入和 schema 迁移，并由 Nomad 作业部署数据库、迁移器及备份任务。

## 1. 系统位置

ClickHouse 位于在线控制面的旁路数据层，不保存 API 的事务事实。

```text
PostgreSQL: 用户、团队、模板、快照等事务状态
Redis:      运行时目录、锁、队列和短期状态
ClickHouse: 生命周期事件、资源统计、团队/沙箱时间序列
Loki:       可检索日志
```

`packages/clickhouse` 是独立 Go module。API 使用它查询指标，Orchestrator 使用它投递 sandbox events 与 host stats；OTel Collector 则绕过 Go client，直接通过 ClickHouse exporter 写标准指标表。

## 2. 启动/装配

生产部署由 `iac/modules/job-clickhouse` 生成四类 Nomad job：

1. `clickhouse` service job：按 server index 部署 ClickHouse，每个实例受 `job_constraint` 约束到固定节点。
2. 每个 ClickHouse allocation 内有 ClickHouse server 和一个专用 OTel Collector；后者抓取 ClickHouse Prometheus 指标并转发给节点 Collector。
3. `clickhouse-migrator` batch job：运行 `packages/clickhouse/Dockerfile` 中的 goose，对每个 server 执行迁移。
4. `clickhouse-backup` 与 `clickhouse-backup-restore` batch job：使用 `clickhouse-backup` 对接 GCS/S3 bucket。

GCP 为 ClickHouse MIG 实例保留独立持久盘；AWS nodepool-clickhouse 使用固定可用区和 EBS。两端都通过 Nomad/Consul 注册 `clickhouse.service.consul:9000`。

应用装配分两种：

- 读取：`clickhouse.New` 创建 `Client`；需要灰度读 endpoint 时使用 `NewSwitchingClient`。
- 直接写入：调用 `NewDefaultClickhouseSandboxEventsDelivery` 或 `NewDefaultClickhouseHostStatsDelivery`，随后在退出阶段调用 `Close`。
- OTLP 写入：服务只向 `localhost:4317` 发指标，由每节点 Collector 负责 ClickHouse exporter。

## 3. 核心机制与关键对象

### 3.1 连接与读切换

`NewDriver` 解析 DSN，限制为 10 个 open、3 个 idle 连接。`EndpointFromDSN` 只返回脱敏后的 `host:port`，防止带密码 DSN 进入日志和 metric attribute。

`SwitchingClient` 每次查询都根据 `clickhouse-read-endpoint` Feature Flag 解析目标，因此切换无需重启。空值选默认 DSN，数字字符串选择 alternate DSN；非法值回落默认端。允许无 ClickHouse 的调用方可显式启用 noop default。

### 3.2 非阻塞 Batcher

`batcher.Batcher[T]` 用有界 channel 接受事件。达到 `MaxBatchSize`，或周期性的 `MaxDelay` ticker 到点时调用同步 flush 函数。ticker 从 batcher 启动或上一次非空 flush 后计时，不会在首条数据入队时重置；`batchStartTime` 只用于记录本批等待指标。

`Push` 不等待：队列满立即返回 `ErrBatcherQueueFull`，并增加 `batcher.items.dropped`。flush 失败交给 `ErrorHandler` 记录，不会自动把整个 batch 放回队列。

默认业务参数来自 Feature Flag：最大 batch、最大延迟和队列长度可动态配置。`Stop` 关闭 channel，处理完剩余数据后才返回。

### 3.3 Sandbox events

`events.ClickhouseDelivery` 把 shared `SandboxEvent` JSON 编码后写入 `sandbox_events`。行中保留 event UUID、version、type、timestamp，以及 sandbox、execution、template、build、team 维度。

事件 TTL 由事件携带，缺失时用 shared 默认值，超过上限时截断。`GatedClickhouseDelivery` 还可由 `ClickhouseWriteFanoutFlag` 在迁移期间控制双写。

### 3.4 Host stats

`hoststats.ClickhouseDelivery` 写入 `sandbox_host_stats`。数据同时包含分配的 vCPU/内存、cgroup 累计 CPU、当前/峰值内存、相邻采样 delta、采样间隔以及 `sandbox`/`build` 类型。

`Delivery` 接口有 noop 和 multi 实现。multi 写入逐个执行非阻塞 Push，关闭时并行 drain 各目标，适合 endpoint 迁移时 fan-out。

### 3.5 OTLP 指标与物化视图

Collector 的 ClickHouse exporter 写 `metrics_gauge` 与 `metrics_sum`，且 `create_schema: false`；表必须先由迁移创建。

物化视图按 metric 名和 attributes 把长表拆成业务表：

- `sandbox_metrics_gauge`：按 sandbox/team/metric/time 保存 CPU、内存、磁盘指标。
- `team_metrics_gauge`：保存 `e2b.team.*` gauge。
- `team_metrics_sum`：保存 `e2b.team.*` counter/delta。

业务查询不扫描完整 OTLP attributes map，而是读取这些窄表。

### 3.6 查询接口

`Clickhouse` 接口提供：

- `QuerySandboxTimeRange`：获取某 sandbox/team 的首末采样时间。
- `QuerySandboxMetrics`：按动态 step 分桶，用 `maxIf` 把 metric rows 转为 CPU/内存/磁盘列。
- `QueryLatestMetrics`：对一组 sandbox 使用 `argMaxIf` 取每类指标最新值。
- `QueryTeamMetrics`：对 sum 表求窗口内新增数，对 gauge 表取窗口最大并合并时间轴。
- `QueryMaxStartRateTeamMetrics`、`QueryMaxConcurrentTeamMetrics`：返回峰值及发生时间。

`utils.ValidateRange` 约束 ClickHouse DateTime64 可表示范围和 start/end 顺序，`CalculateStep` 按时间跨度控制返回点数。

## 4. 主数据/部署流

```text
直接写入链路
Orchestrator
  ├─ SandboxEvent ──> events Batcher ─────┐
  └─ cgroup sample ─> hoststats Batcher ──┼─> ClickHouse Distributed tables
                                          └─ queue/flush telemetry

指标链路
API / Orchestrator / Proxy
  └─ OTLP metrics -> localhost:4317
       -> node-local OTel Collector
       -> filter e2b.* -> ClickHouse exporter
       -> metrics_gauge / metrics_sum
       -> MATERIALIZED VIEW
       -> sandbox_metrics_* / team_metrics_*

读取链路
HTTP metrics handler -> Clickhouse interface -> 分桶 SQL -> API response
```

底层表通常采用 `*_local` MergeTree 加 Distributed 表：local 表负责分区、排序、TTL 和物理数据，Distributed 表负责按 sandbox/team hash 路由。

## 5. 设计不变量与故障边界

- PostgreSQL 仍是事务事实源；ClickHouse 延迟或丢样不能改变 sandbox 生命周期结果。
- Collector 的 `create_schema` 必须保持关闭，schema 只能由版本化迁移推进。
- 写 Distributed 表、读业务窄表；修改 local/Distributed/MV 任一层时必须一起验证集群行为。
- batch queue 是有界且允许丢弃的。调用方必须记录 `Push` 错误并监控 dropped/queue/flush 指标。
- flush 失败没有内建持久重试；ClickHouse 故障窗口内的数据可能丢失，不能把 delivery 当消息队列。
- `Close` 必须 drain batcher；强制退出会丢失内存队列。
- 查询必须带 `team_id`，避免仅凭 sandbox ID 造成跨租户读取。
- 时间参数必须通过 DateTime64 范围校验，并显式使用秒级 step；不要拼接用户输入 SQL。
- 事件 TTL 可逐行不同，因此 `sandbox_events_local` 不能依赖只丢整 part 的 TTL 优化。
- `metrics_*`、sandbox metrics 与 host stats 的 TTL 不同；保留策略是产品语义，不应只在 bucket 生命周期中推断。
- 日志、span 和指标只能记录 `EndpointFromDSN`，不得记录原 DSN。
- 单个 ClickHouse server 的磁盘和 job constraint 绑定；替换节点时必须保留对应 stateful disk/volume。

## 6. 与其他组件边界

| 对方 | ClickHouse 接收/提供 | 边界外职责 |
| --- | --- | --- |
| API | 团队/沙箱指标查询结果 | 鉴权、参数校验、HTTP schema |
| Orchestrator | 生命周期事件和 cgroup host stats | 采集时机、sandbox 状态机 |
| Shared | events、feature flags、logger、telemetry | ClickHouse SQL 与 schema |
| OTel Collector | 标准 gauge/sum 写入 | SDK 埋点与 metric 语义 |
| IaC | server、migrator、backup、凭据和磁盘 | 查询/写入业务逻辑 |
| GCS/S3 | ClickHouse backup 对象 | 在线表和恢复编排 |
| Grafana/Mimir | ClickHouse 自身运行指标可被转发 | 业务 ClickHouse 表的事实定义 |

## 7. 源码阅读顺序

| 顺序 | 路径 | 先回答的问题 |
| --- | --- | --- |
| 1 | `packages/clickhouse/pkg/clickhouse.go` | client 接口和连接边界是什么？ |
| 2 | `packages/clickhouse/pkg/switcher.go` | 灰度读 endpoint 如何切换？ |
| 3 | `packages/clickhouse/pkg/batcher/batcher.go` | 写入何时 flush、何时丢弃？ |
| 4 | `packages/clickhouse/pkg/events/delivery.go` | 生命周期事件如何落表？ |
| 5 | `packages/clickhouse/pkg/hoststats/` | host 采样模型和 fan-out 是什么？ |
| 6 | `packages/clickhouse/pkg/sandbox.go` | 长表如何转为 sandbox 时间序列？ |
| 7 | `packages/clickhouse/pkg/team.go` | counter 和 gauge 如何合并？ |
| 8 | `packages/clickhouse/migrations/` | local、Distributed、MV 与 TTL 如何演进？ |
| 9 | `iac/modules/job-clickhouse/main.tf` | Nomad 作业如何装配配置和镜像？ |
| 10 | `iac/modules/job-otel-collector/configs/otel-collector.yaml` | 哪些 OTLP 指标会进入 ClickHouse？ |

## 8. 相关深挖

- [ClickHouse package 原理详解](../../clickhouse-package.md)：batcher、SQL、迁移和部署的逐文件说明。
- [Team/Sandbox Metrics](../../md/team-metrics-module.md)：HTTP 端点、动态步长与指标语义。
- [Sandbox 生命周期](../../md/sandbox-lifecycle.md)：事件与 host stats 的产生时机。
- [Orchestrator 模块](../../md/orchestrator-module.md)：直接写入端的装配位置。
