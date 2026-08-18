# 可观测性、事件与资源统计链路深入解析

> 范围: `packages/shared/pkg/telemetry/`、`packages/shared/pkg/logs/loki/`、`packages/clickhouse/pkg/{events,hoststats}/`、`packages/orchestrator/pkg/{metrics,events,sandbox}/`、OTel Collector、Vector、Loki 与 ClickHouse 配置。
>
> 本文把容易混在一起的五条数据链拆开:服务 telemetry、sandbox metrics、sandbox/build logs、lifecycle events、cgroup host stats。

## 一、先区分五类数据

| 数据 | 产生位置 | 典型后端 | 主要用途 |
| --- | --- | --- | --- |
| service traces/metrics/logs | 所有 Go 服务 | Grafana Cloud/本地 Mimir、Tempo、Loki | 服务健康、延迟、错误定位 |
| sandbox resource metrics | orchestrator 轮询 envd | OTel -> ClickHouse `sandbox_metrics_gauge` | 用户查询 CPU/RAM/disk 历史 |
| sandbox/build logs | envd、template builder | Vector -> Loki | 用户日志与构建日志查询 |
| sandbox lifecycle events | orchestrator handler | ClickHouse + 条件式 Redis Stream | 审计、webhook、历史事件 |
| sandbox host stats | orchestrator cgroup v2 | ClickHouse `sandbox_host_stats` | 宿主侧计量与资源分析 |

这些链路共享 `sandbox_id`、`team_id` 等关联键，但可靠性、采样周期、保留期和查询入口不同。排障前先判断自己面对的是哪一种数据。

相关阅读:

- [team-metrics-module.md](./team-metrics-module.md):team 与 sandbox metrics API 查询。
- [sandbox-api-module.md](./sandbox-api-module.md):logs/metrics HTTP 端点。
- [hyperloop-api-module.md](./hyperloop-api-module.md):guest 到 host 的内部 HTTP 通道。
- [dashboard-api-module.md](./dashboard-api-module.md):Dashboard 的 sandbox record 与 retention 提示。

## 二、共享 OpenTelemetry SDK

`telemetry.New` 由各 Go 服务在启动时调用。是否启用只取决于 `OTEL_COLLECTOR_GRPC_ENDPOINT`:

```text
OTEL_COLLECTOR_GRPC_ENDPOINT unset
  -> noop metrics/traces/logs provider

OTEL_COLLECTOR_GRPC_ENDPOINT=localhost:4317
  -> OTLP/gRPC exporters
  -> local collector
```

unset 时不是启动错误，而是返回 noop client。这方便 CLI、测试和最小自托管环境运行，但也意味着“业务正常、完全没有 telemetry”可能只是配置缺失。

### 2.1 Resource attributes

每个 signal 共享 resource:

| attribute | 来源 |
| --- | --- |
| `service.name` | 调用方传入的服务名 |
| `service.version` | `{version}-{commit}` |
| `service.instance.id` | 每次进程启动生成的 UUID |
| `host.id` | node ID |
| `host.name` | OS hostname，读取成功时添加 |
| `telemetry.sdk.name/language` | `otel` / Go |

`service.instance.id` 区分同一服务的多个 allocation；`host.id` 用于回到具体节点。不要用高基数 sandbox ID 代替 resource identity，sandbox/team 等应放在 span 或 metric datapoint attributes。

### 2.2 Metrics SDK

通用 meter provider:

- 默认每 15 秒 export。
- histogram 使用 base-2 exponential aggregation，`MaxSize=160`、`MaxScale=20`。
- snapshot/upload byte histogram 有专门 view，避免大 byte value 全落入显式 bucket 的 `+Inf`。
- exemplars 默认关闭，因为当前 dashboard 不查询它们，开启会增加 Mimir item rate。
- OTLP 单请求上限 100 MiB，与 collector receiver 对齐。

Go runtime instrumentation 复用同一 provider，采集 memory、GC、goroutine、processor limit 等指标。

注意:15 秒只是通用 provider 周期。sandbox resource observer 使用独立 provider，每 5 秒 export；host stats 又是独立的 1 秒 ClickHouse writer。不要把所有数据延迟都按 15 秒估算。

### 2.3 Traces

- exporter 使用 OTLP/gRPC + gzip。
- provider 使用 batch span processor。
- sampler 当前是 `AlwaysSample`。
- propagation 使用 W3C `traceparent`/`tracestate` 与 baggage。

HTTP/gRPC middleware 创建 request span，业务代码通过 `SetAttributes`、`ReportEvent`、`ReportError` 补充语义。`ReportCriticalError` 同时写 error log、记录带 stack trace 的 span error，并把 span status 设为 Error；普通 `ReportError` 不修改 span status。

### 2.4 Service logs

服务 logger 可以添加 OTel log core。log provider 使用 batch processor，经 OTLP/gRPC + gzip 发往 collector。它与后文的 guest sandbox log pipeline 是两条不同链路:前者是服务自身日志，后者是用户 sandbox 内输出。

## 三、Collector 的生产与本地拓扑

### 3.1 生产节点 collector

生产 collector 同时接收:

- OTLP/gRPC `0.0.0.0:4317`，最大消息 100 MiB。
- Nomad Prometheus scrape，15 秒周期。
- hostmetrics，30 秒周期。

主要 pipeline:

```text
OTLP metrics
  -> metric allowlist / resource detection / label normalization
  -> Grafana Cloud OTLP

e2b.* external metrics
  -> batch/clickhouse (up to 50,000)
  -> ClickHouse metrics_gauge / metrics_sum

OTLP traces
  -> resource normalization -> batch -> Grafana Cloud OTLP

OTLP logs
  -> resource normalization -> batch -> Grafana Cloud OTLP
```

可选分支还能把 metrics 发到 Google Managed Prometheus，或把 `e2b.*` 转发到 OTel router。Collector 会删除/聚合一部分高基数或未使用 label，例如 Nomad node metadata 和单 CPU/device 维度。

### 3.2 本地开发 collector

`packages/local-dev/otel-collector.yaml` 的目标更直观:

```text
traces  -> Tempo
metrics -> Mimir
logs    -> Loki
e2b.*   -> ClickHouse
```

因此本地问题可以分别在 Tempo/Mimir/Loki/ClickHouse 验证。生产环境则可能由 Grafana Cloud 承载通用三信号，同时保留 ClickHouse 产品指标。

## 四、Sandbox Resource Metrics

`packages/orchestrator/pkg/metrics/sandboxes.go` 创建独立 `SandboxObserver`。它每 5 秒遍历当前 sandbox map，并发调用每个 sandbox 的 `Checks.GetMetrics`，单次 timeout 100 ms。

```text
envd metrics
  -> orchestrator Checks.GetMetrics
  -> ObservableGauge e2b.sandbox.*
       attributes: sandbox_id, team_id, build_id, sandbox_type
  -> OTLP collector
  -> ClickHouse metrics_gauge
  -> materialized view sandbox_metrics_gauge
  -> API QuerySandboxMetrics / QueryLatestMetrics
```

### 4.1 指标集合

| metric | 单位 |
| --- | --- |
| `e2b.sandbox.cpu.total` | CPU count |
| `e2b.sandbox.cpu.used` | percent |
| `e2b.sandbox.ram.total` | bytes |
| `e2b.sandbox.ram.used` | bytes |
| `e2b.sandbox.ram.cache` | bytes |
| `e2b.sandbox.disk.total` | bytes |
| `e2b.sandbox.disk.used` | bytes |

不同 envd 版本提供的字段不同。observer 会:

- 跳过 `<0.1.5` 的 envd。
- 对旧内存指标把 MiB 转成 bytes。
- 只有足够新版本才上报 cache 与 disk。
- 检测 sandbox clock 与 host clock 是否偏差超过 5 秒。
- CPU 或 memory 使用率达到 80% 时写 sandbox-scoped warning log。

### 4.2 为什么 Gauge 使用 Delta temporality

这个 observer 为 Gauge 选择 Delta temporality，防止已经消失的 sandbox datapoint 被 exporter 无限重复上报。其他 instrument kind 仍使用 cumulative。

### 4.3 ClickHouse materialized view

Collector 首先写通用 `metrics_gauge`。`sandbox_metrics_gauge_mv` 只选择带 `Attributes['sandbox_id']` 的数据，展平成:

```text
timestamp, sandbox_id, team_id, metric_name, value
```

表按 `(sandbox_id, metric_name, timestamp)` 排序，TTL 7 天。查询最新值使用 `argMaxIf`，时间序列使用 `toStartOfInterval` + `maxIf`。

这解释了两个常见现象:

- Mimir 有指标但 API 查不到:检查 ClickHouse external metrics pipeline 与 materialized view。
- sandbox 刚停止后仍能查询:数据保留 7 天，但不会再产生新 datapoint。

## 五、Sandbox 与 Build Logs

### 5.1 Guest 到 Loki 的可信链路

```text
process stdout/stderr inside VM
  -> envd log interceptor/exporter
  -> HTTP POST LogsCollectorAddress
  -> orchestrator hyperloop /logs
       |- source IP -> active Sandbox
       |- validate payload instanceID
       `- overwrite instanceID/envID/teamID
  -> Vector HTTP NDJSON source
  -> normalize labels
  -> local Loki
  `-> optional OTel router / Grafana Loki
```

Hyperloop 不相信 guest 自报的 owner 字段。它用请求源地址找到 active sandbox，验证 payload 中旧 `instanceID` 没串到另一个 lifecycle，然后覆盖 `instanceID`、`envID`、`teamID`。这防止一个 sandbox 伪造另一个 team 的 Loki labels。

### 5.2 有界 buffer 与丢弃语义

envd exporter:

- 单行超过 192 KiB 直接丢弃，低于 Loki 默认 256 KiB 上限。
- 内存 buffer 最大 8 MiB。
- collector 不可用或 producer 过快时丢最旧记录。
- HTTP client timeout 10 秒，禁用 keep-alive。

Vector 的可选 OTel router sink 使用 500 event 内存 buffer，满时丢新记录，request 不重试且 timeout 2 秒。这些选择保证日志故障不会拖垮 sandbox 运行时，但日志链路是 best effort，不提供 exactly-once。

### 5.3 Vector label 规范化

Vector 把不同历史字段统一为:

```text
service, teamID, envID, buildID, sandboxID, category
```

缺失字段填 `unknown`。`internal=true` 的记录与用户日志分流:非 internal 写 local Loki，并可发 OTel router；internal 可单独写 Grafana sink。

### 5.4 API 查询 Loki

本地 cluster 的 LogQL selector:

```text
{teamID=`...`, sandboxID=`...`, category!="metrics"}
```

可选 level 是“最低级别”过滤:

| 参数 | regex |
| --- | --- |
| error | `error` |
| warn | `warn|error` |
| info | empty/info/warn/error |
| debug | empty/debug/info/warn/error |

search 使用 `regexp.QuoteMeta`，语义是 literal substring，不允许用户注入任意 LogQL regex。label 中的反引号也会移除。

Loki 返回多 stream，`ResponseMapper` 会解析 flat JSON，只保留 string/number/bool 字段，删除重复的 `message` 与 `level`，最后按 timestamp 和请求 direction 重新排序。未知 level 归一为 info。

一个需要知道的失败语义是:当前 `QuerySandboxLogs`/`QueryBuildLogs` 在 Loki query 或 mapping 失败时记录 telemetry，然后返回空 slice 和 nil error。因此用户可能看到 `200 + []`，而不是 `500`。排障时不能把空结果直接等同于“确实没有日志”。

### 5.5 多集群读取

- local cluster:API 直接查询配置的 Loki。
- remote cluster:API 通过 Edge HTTP resource provider 转发。
- build logs:运行中的 builder gRPC 与持久 Loki 都可能成为 source。

所以先检查 team 的 cluster 路由，再检查 Loki。只盯 API 所在 region 的 Loki 可能查错后端。

## 六、Sandbox Lifecycle Events

事件模型定义在 `packages/shared/pkg/events/sandbox.go`。当前 V2 type 使用 dot namespace:

```text
sandbox.lifecycle.created
sandbox.lifecycle.killed
sandbox.lifecycle.paused
sandbox.lifecycle.resumed
sandbox.lifecycle.updated
sandbox.lifecycle.checkpointed
```

V1 的 `event_category/event_label` 仍可迁移到 V2 type；这两个旧字段已经 deprecated。

### 6.1 发布路径

```text
orchestrator lifecycle handler
  -> prepare event data + team retention
  -> goroutine with context.WithoutCancel
  -> EventsService.validateEvent
  -> fan out
       |- ClickHouse batcher -> sandbox_events
       `- Redis Streams -> sandbox.events.stream (conditional)
```

必填字段是 version、type、sandbox ID、non-zero team UUID、timestamp。校验或任一 target 失败只写日志，不回滚已经成功的 sandbox lifecycle operation。

Redis Stream 不是无条件写入。publisher 先检查 `wh:{teamID}` key 是否存在，只有存在时才 `XADD`。这个 key 相当于 team 是否需要 webhook/event delivery 的动态订阅开关。

### 6.2 ClickHouse batcher

events writer 使用通用非阻塞 batcher:

- 达到 max batch size 或 max delay 时 flush。
- queue 满时 `Push` 立即返回 `ErrBatcherQueueFull`，item 被丢弃。
- shutdown `Close` 会 drain 剩余 batch。
- 多 ClickHouse endpoint 可同时创建 delivery，额外 endpoint 由 feature flag gate。

需要监控 `batcher.items.dropped`、`batcher.queue.length`、flush duration 和 delivery error。生命周期 handler 成功不代表事件一定持久化成功。

### 6.3 每行 retention

事件携带 team 的 `events_ttl_days`:

- `<=0` 回退为 7 天。
- 最大 365 天。
- ClickHouse local table 使用每行 TTL，而不是固定表 TTL。
- 因为同一个 part 中行的 TTL 不同，`sandbox_events_local` 关闭 `ttl_only_drop_parts`，允许 merge 精确删除过期行。

## 七、Cgroup Host Stats

Host stats 不通过 OTel metric exporter，而由 orchestrator 直接批量写 ClickHouse。

### 7.1 采样生命周期

每个 sandbox 初始化后启动一个 `HostStatsCollector`:

```text
start
  -> push zero baseline row
  -> every 1s: cgroup v2 GetStats -> compute delta -> Push
  -> stop signal
  -> wait sampling goroutine exit
  -> collect final sample
```

采集失败只记录 error 并继续，不会 kill sandbox。team UUID 解析失败时使用 zero UUID 并告警。

### 7.2 字段与 delta

| 类别 | 字段 |
| --- | --- |
| identity | sandbox/execution/template/build/team ID、sandbox type |
| allocation | vCPU count、memory MB |
| cumulative CPU | usage/user/system usec |
| memory | current usage bytes、interval peak bytes |
| precomputed delta | delta usage/user/system usec、interval usec |

delta 使用 saturating subtraction。cgroup counter 因 resume 或 migration 变小的时候返回 0，而不是让 `uint64` 下溢成巨大值。

初始 baseline 与 final sample 很重要:前者捕获启动到第一个 ticker 之间的 CPU，后者减少停止边界的数据缺口。

### 7.3 存储

`sandbox_host_stats_local`:

- `MergeTree`
- 按日期 partition
- `(sandbox_id, timestamp)` 排序
- TTL 7 天
- distributed table 按 `xxHash64(sandbox_id)` 分片

host stats 同样可以 fan out 到多个 ClickHouse endpoint，`ClickhouseWriteFanoutFlag` 控制额外 gated delivery。多 target 的 `Push` 串行调用，但每个 target 只是非阻塞 enqueue；`Close` 并行执行，避免一个 endpoint 阻塞其他 endpoint drain。

## 八、读取边界与 Retention

| API/消费者 | 数据源 | 保留语义 |
| --- | --- | --- |
| sandbox metrics API | local ClickHouse 或 remote Edge | `sandbox_metrics_gauge` 固定 7 天 |
| sandbox logs API | local Loki 或 remote Edge | 部署配置决定，Dashboard 按 7 天提示 |
| team metrics API | ClickHouse team tables | 见 team metrics 专章 |
| Dashboard sandbox record | PostgreSQL | record 可长期存在，只计算数据是否过期 |
| lifecycle event consumer | ClickHouse / Redis Stream | team TTL，默认 7、最大 365 天 |
| host stats analysis | ClickHouse | 固定 7 天 |

Dashboard record 的 `retentionExpired` 与 `eventsRetentionExpired` 是基于 `stopped_at` 的预测字段，不会实时探测 Loki/ClickHouse。因此它们适合 UI 决策，不是后端健康检查。

## 九、端到端排障手册

### 9.1 Metrics API 返回空

按顺序检查:

1. sandbox 是否运行在当前 team/cluster。
2. envd version 是否达到 metrics 最低版本。
3. orchestrator 的 100 ms `GetMetrics` 是否 timeout。
4. `OTEL_COLLECTOR_GRPC_ENDPOINT` 是否设置。
5. collector `filter/external_metrics` 是否保留 `e2b.*`。
6. ClickHouse `metrics_gauge` 是否有原始行。
7. `sandbox_metrics_gauge_mv` 是否工作。
8. 查询时间窗是否超过 7 天。

### 9.2 Logs API 返回空

1. 先查 API/Edge 日志，确认实际 cluster route。
2. 检查 envd exporter 是否拿到 `LogsCollectorAddress`。
3. 检查 hyperloop 是否拒绝旧 lifecycle 的 instance ID。
4. 检查 Vector HTTP source 与 sink health。
5. 直接用 `{teamID=..., sandboxID=...}` 查 Loki。
6. 注意 Loki provider 出错也可能对用户返回空数组。
7. 检查 192 KiB 单行与 8 MiB buffer 丢弃条件。

### 9.3 Event 丢失

1. lifecycle handler 是否实际走到 publish 点。
2. event 是否缺 version/type/team/timestamp。
3. `batcher.items.dropped{batcher="sandbox-events..."}` 是否增长。
4. ClickHouse feature flag 是否允许目标 endpoint 写入。
5. Redis webhook key `wh:{teamID}` 是否存在。
6. 查询窗口是否超过该 team 的 per-row TTL。

### 9.4 Host stats 不连续

1. sandbox cgroup handle 是否初始化成功。
2. `GetStats` 是否持续报错。
3. batcher queue 是否满。
4. counter 是否因 resume reset；这种点 delta 会被压成 0。
5. stop 时 final sample 是否完成。
6. ClickHouse 多 endpoint fanout flag 是否符合预期。

## 十、关键源码索引

| 文件 | 关注点 |
| --- | --- |
| `packages/shared/pkg/telemetry/main.go` | noop/OTLP client 与 shutdown |
| `packages/shared/pkg/telemetry/config.go` | collector endpoint 开关 |
| `packages/shared/pkg/telemetry/metrics.go` | 15s provider、histogram view、exemplar |
| `packages/shared/pkg/telemetry/traces.go` | batch span、AlwaysSample、propagation |
| `packages/shared/pkg/telemetry/logs.go` | OTel log batch exporter |
| `iac/modules/job-otel-collector/configs/otel-collector.yaml` | 生产 pipeline/filter/exporter |
| `packages/local-dev/otel-collector.yaml` | Tempo/Mimir/Loki/ClickHouse 本地拓扑 |
| `packages/orchestrator/pkg/metrics/sandboxes.go` | 5s sandbox observer 与版本兼容 |
| `packages/clickhouse/migrations/20250717135224_sandbox_metrics.sql` | sandbox metrics materialized view |
| `packages/envd/internal/logs/exporter/exporter.go` | guest log buffer 与 HTTP exporter |
| `packages/orchestrator/pkg/hyperloopserver/handlers/logs.go` | sandbox 身份校验与字段覆盖 |
| `iac/modules/job-logs-collector/configs/vector.toml` | Vector normalize、route 与 Loki labels |
| `packages/shared/pkg/logs/loki/provider.go` | LogQL 构造与错误降级 |
| `packages/orchestrator/pkg/events/events.go` | lifecycle event 校验与 fanout |
| `packages/clickhouse/pkg/events/delivery.go` | event batch insert 与 TTL clamp |
| `packages/orchestrator/pkg/sandbox/hoststats_collector.go` | 1s cgroup sample 与 delta |
| `packages/clickhouse/pkg/hoststats/delivery.go` | host stats batch insert |
| `packages/clickhouse/pkg/batcher/batcher.go` | queue、flush、drop 与 shutdown 语义 |

## 十一、掌握程度自检

1. 为什么 service metrics 的 15 秒周期不能用于估算 sandbox metrics 延迟？
2. Mimir 有 `e2b.sandbox.*` 时，为什么 ClickHouse API 仍可能返回空？
3. Hyperloop 为什么既验证 `instanceID`，又覆盖 team/template 字段？
4. 为什么 logs API 的 `200 + []` 不能证明 Loki 正常？
5. lifecycle event 为什么不参与 sandbox 操作的事务成功条件？
6. Redis Stream 为什么不是每个 team 都写？
7. host stats 为什么同时存 cumulative counter 和 precomputed delta？
