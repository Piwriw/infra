# ClickHouse：事件与指标分析层

> `packages/clickhouse` 定义 E2B 的 ClickHouse 查询、异步批量写入和 schema 迁移。2026.30 起它的职责从"指标与事件"扩展到"**可选的沙箱日志与出网审计**"。

## 0. 2026.30 变动速览

| 变动 | 说明 |
| --- | --- |
| **新增 `sandbox_logs` 表** | `packages/clickhouse/migrations/20260702181515_add_sandbox_logs.sql`。沙箱日志从 Loki 迁向 ClickHouse 的落点，TTL 7 天 |
| **新增 `sandbox_egress` 表** | `packages/clickhouse/migrations/20260818120000_add_sandbox_egress.sql`。**出网审计**：记录防火墙对每个连接的判定（目的地、协议、SNI、allow/deny），TTL 7 天 |
| **新增 `pkg/sandboxlogs/`** | 读侧包。被 `api/internal/clusters/resources_local.go` 与 `api/internal/handlers/store.go` 使用，也就是 **API 现在能从 ClickHouse 读沙箱日志** |
| **Loki 变成可选** | 切到 ClickHouse 读日志后可以不部署 Loki（`LOKI_URL` 可空） |
| **`iac/` 部署描述全部失效** | `iac/modules/job-clickhouse`、`job-otel-collector` 在 2026.30 已随 `iac/` 整体删除 |

> ⚠️ **两张新表的 Distributed 分片键刻意不同。** `sandbox_logs` 按 `xxHash64(team_id)` 分片；`sandbox_egress` 按 `xxHash64(sandbox_id)` 分片。migration 里的注释说明了原因：出网表里行数最多的场景是"**一个 team 的沙箱访问大量目的地**"，按 team 分片会把全部行压到单个 shard 上。
>
> ⚠️ **`sandbox_egress` 的一行是一个"判定"，不是一条"完成的连接"。** 它在防火墙放行或拒绝时写入，**早于上游 dial**——所以上游 dial 仍可能失败，而这行已经落了。
>
> ⚠️ 该表的 `destination_ip` 刻意用 `String` 而不是 `IPv6`：ClickHouse 的 IPv6 类型会把 v4 地址存成 `::ffff:a.b.c.d`，此时 `isIPAddressInRange` 对 v4 CIDR 返回 false；存成 String 才能直接判。
>
> ⚠️ `server_name` 是 `Nullable(String)`，**NULL 和空串含义不同**：NULL 表示"这条连接没有暴露服务名"（所有非 TLS/HTTP 端口、无 SNI 的 TLS 握手、无 Host 头的 HTTP 请求）。空串不能代替这个"缺失"。

## 1. 系统位置

ClickHouse 位于在线控制面的旁路数据层，不保存 API 的事务事实。

```text
PostgreSQL: 用户、团队、模板、快照等事务状态
Redis:      运行时目录、锁、队列和短期状态
ClickHouse: 生命周期事件、资源统计、团队/沙箱时间序列
            （2026.30 起）可选的沙箱日志与出网审计
Loki:       可检索日志（2026.30 起可选——切到 ClickHouse 日志后可省）
```

`packages/clickhouse` 是独立 Go module。API 使用它查询指标、**并读取沙箱日志**，Orchestrator 使用它投递 sandbox events 与 host stats；OTel Collector 则绕过 Go client，直接通过 ClickHouse exporter 写标准指标表。

## 2. 启动/装配

生产部署原先由 `iac/modules/job-clickhouse` 生成四类 Nomad job（service job、allocation 内 OTel Collector、`clickhouse-migrator` batch job、`clickhouse-backup` / `clickhouse-backup-restore` batch job），GCP 为 MIG 实例保留独立持久盘、AWS nodepool-clickhouse 用固定可用区和 EBS，两端通过 Nomad/Consul 注册 `clickhouse.service.consul:9000`。

> ⛔ **2026.30 起上面这段部署描述已无对应代码。** `iac/`（172 文件）在 2026.30 整体删除，提交 `8a1c48884406b909f64c1239c808d0bc1cbf05bf`（"chore(deploy): retire Nomad-based deployment ahead of a new deploy path"）。以下仍然成立且与部署方式无关：
>
> - **迁移由 `packages/clickhouse/Dockerfile` 里的 goose 执行**，每个 ClickHouse server 各跑一遍。
> - **ClickHouse 需要持久盘**，且实例与盘绑定；替换节点必须保留对应 stateful disk/volume。
> - **备份仍走 `clickhouse-backup` 对接 GCS/S3 bucket。**
> - 表结构仍必须先由迁移创建（见 §3.5 的 `create_schema: false`）。

应用装配分三种：

- 读取：`clickhouse.New` 创建 `Client`；需要灰度读 endpoint 时使用 `NewSwitchingClient`；读沙箱日志用 `pkg/sandboxlogs`。
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

### 3.7 沙箱日志与出网审计（2026.30 新增）

**`sandbox_logs` / `sandbox_logs_local`**：

```text
ORDER BY  (team_id, sandbox_id, timestamp)
PARTITION BY toDate(ingested_at)
TTL       ingested_at + INTERVAL 7 DAY, ttl_only_drop_parts = 1
Distributed 分片键 xxHash64(team_id)
```

关键列：`timestamp`、`ingested_at`（服务端赋值）、`team_id`、`sandbox_id`、`template_id`、`build_id`、`service`、`category`、`level`、`message`、`raw`、`fields`。

- `idx_build_id` 是 bloom filter。
- `idx_message_ngram` 用 **`ngrambf_v1(4, 8192, 3, 0)`**，migration 注释明确说明：读侧用的是 `position(message, ?) > 0` 子串搜索，**`tokenbf_v1` 只支持整词（`hasToken`）查找，帮不上子串谓词**。
- 分区和 TTL 都键在 **`ingested_at`**（服务端赋值）而不是 `timestamp`（节点时钟）——否则时钟偏移的节点会写进一个永不失效的分区。

**`sandbox_egress` / `sandbox_egress_local`**：

```text
ORDER BY  (team_id, sandbox_id, destination_ip, destination_port, last_seen)
PARTITION BY toDate(ingested_at)
TTL       ingested_at + INTERVAL 7 DAY, ttl_only_drop_parts = 1
Distributed 分片键 xxHash64(sandbox_id)   ← 与相邻表不同
```

关键列：`first_seen` / `last_seen`、`ingested_at`、`team_id`、`sandbox_id`、`sandbox_execution_id`、`sandbox_template_id`、`sandbox_build_id`、`sandbox_type`、`protocol`、`destination_ip`、`destination_port`、`server_name`、`decision`、`match_type`、`connections`。

- `ORDER BY` 把 `destination_ip` 放在时间戳之前，因为**预期的读法都是"按目的地分组、跨多个区间"**——同一个端点产生的重复行因此聚在一起，而不是散落在 part 各处。时间范围靠分区裁剪。`server_name` 不在排序键里，因为需要 `allow_nullable_key`（默认关闭），而且它跟着地址走。
- `connections` 是**区间内防火墙做出该判定的连接数**，行是按 flush 间隔预聚合的，**要拿完整历史必须 `sum(connections)`**。
- 三个 bloom filter 索引：`idx_destination_ip`、`idx_server_name`、`idx_sandbox_id`。后两个的存在理由写得很直白：排序键以 team 打头，所以"从目的地查"或"不知道 team 只查某个 sandbox"都吃不到排序键。

**读侧 `pkg/sandboxlogs/`**：被 `api/internal/clusters/resources_local.go` 与 `api/internal/handlers/store.go` 使用。这是 API 侧"日志从 Loki 切到 ClickHouse"的接缝。

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
- 单个 ClickHouse server 的磁盘与实例绑定；替换节点时必须保留对应 stateful disk/volume。
- **（2026.30）`sandbox_egress` 的一行是"判定"不是"连接结果"。** 它在 dial 之前写入，所以"有这行"不代表连接成功。
- **（2026.30）`sandbox_egress.connections` 必须 `sum()`。** 行是按 flush 间隔预聚合的，直接取单行会严重低估。
- **（2026.30）日志/出网表的分区和 TTL 键在 `ingested_at`（服务端），不是节点给的 `timestamp`。** 不要"顺手统一"成业务时间戳——那会让时钟偏移的节点写出永不失效的分区。
- **（2026.30）`server_name` 的 NULL 与空串不可互换。** NULL 是"没有暴露服务名"这一事实本身。
- **（2026.30）`sandbox_egress` 的 Distributed 分片键是 `sandbox_id`，不是 `team_id`。** 改它会把"一个 team 大量目的地"这一主要负载全压到一个 shard。

## 6. 与其他组件边界

| 对方 | ClickHouse 接收/提供 | 边界外职责 |
| --- | --- | --- |
| API | 团队/沙箱指标查询结果；**2026.30 起还包括沙箱日志**（`pkg/sandboxlogs`） | 鉴权、参数校验、HTTP schema |
| Orchestrator | 生命周期事件和 cgroup host stats | 采集时机、sandbox 状态机、出网判定 |
| Shared | events、feature flags、logger、telemetry | ClickHouse SQL 与 schema |
| OTel Collector | 标准 gauge/sum 写入 | SDK 埋点与 metric 语义 |
| 部署侧 | server、migrator、backup、凭据和磁盘 | 查询/写入业务逻辑 |
| GCS/S3 | ClickHouse backup 对象 | 在线表和恢复编排 |
| Grafana/Mimir | ClickHouse 自身运行指标可被转发 | 业务 ClickHouse 表的事实定义 |

> ⚠️ 2026.29 时这一行写的是 "IaC"；`iac/` 在 2026.30 已整体删除，所以改为"部署侧"。**迁移、磁盘绑定、备份这三件事仍然存在**，只是不再由本仓库的 Terraform/Nomad 描述。

## 7. 源码阅读顺序

| 顺序 | 路径 | 先回答的问题 |
| --- | --- | --- |
| 1 | `packages/clickhouse/pkg/clickhouse.go` | client 接口和连接边界是什么？ |
| 2 | `packages/clickhouse/pkg/switcher.go` | 灰度读 endpoint 如何切换？ |
| 3 | `packages/clickhouse/pkg/batcher/batcher.go` | 写入何时 flush、何时丢弃？ |
| 4 | `packages/clickhouse/pkg/events/delivery.go` | 生命周期事件如何落表？ |
| 5 | `packages/clickhouse/pkg/hoststats/` | host 采样模型和 fan-out 是什么？ |
| 6 | `packages/clickhouse/pkg/sandboxlogs/sandboxlogs.go` | **2026.30 新增**：日志读侧的 SQL 与索引假设 |
| 7 | `packages/clickhouse/pkg/sandbox.go` | 长表如何转为 sandbox 时间序列？ |
| 8 | `packages/clickhouse/pkg/team.go` | counter 和 gauge 如何合并？ |
| 9 | `packages/clickhouse/migrations/20260702181515_add_sandbox_logs.sql` | 日志表的排序键、ngram 索引与 TTL |
| 10 | `packages/clickhouse/migrations/20260818120000_add_sandbox_egress.sql` | 出网表的分片键与 NULL 语义 |
| 11 | `packages/clickhouse/migrations/` | local、Distributed、MV 与 TTL 如何演进？ |

> ⛔ 2026.29 时这份清单的第 9、10 项是 `iac/modules/job-clickhouse/main.tf` 与 `iac/modules/job-otel-collector/configs/otel-collector.yaml`。**两个路径在 2026.30 都已随 `iac/` 删除。**

## 8. 相关深挖

- [ClickHouse package 原理详解](../clickhouse-package.md)：batcher、SQL、迁移和部署的逐文件说明。
- [Team/Sandbox Metrics](../team-metrics-module.md)：HTTP 端点、动态步长与指标语义。
- [Sandbox 生命周期](../sandbox-lifecycle.md)：事件与 host stats 的产生时机。
- [Orchestrator 模块](../orchestrator-module.md)：直接写入端的装配位置。
- [可观测性数据管线](../observability-pipeline.md)：日志从 Loki 迁向 ClickHouse 的完整链路。

---

*已同步至 **2026.30**。*
