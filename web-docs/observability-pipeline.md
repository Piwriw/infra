# 可观测性、事件与资源统计链路深入解析

> 范围: `packages/shared/pkg/telemetry/`、`packages/shared/pkg/logs/loki/`、`packages/clickhouse/pkg/{events,hoststats}/`、`packages/orchestrator/pkg/{metrics,events,sandbox}/`、OTel Collector、Vector、Loki 与 ClickHouse 配置。
>
> 本文把容易混在一起的六条数据链拆开:服务 telemetry、sandbox metrics、sandbox/build logs、lifecycle events、cgroup host stats、egress 目的地址。
>
> 行号均按 tag `2026.30` 核对。已同步至 2026.30(2026-09-10)。

> ⛔ **2026.30 部署侧退役提示**:提交 `8a1c48884`（`chore(deploy): retire Nomad-based deployment ahead of a new deploy path`）把 **`iac/` 整棵树（172 个文件）** 全部删除,根目录 `self-host.md` 也已删除（⚠️ `packages/docker-reverse-proxy/` 的 19 个文件由更早的 `d153bbe9d` 删除,2026-08-06,不是这批）。本文中所有 `iac/**` 路径（如 `iac/modules/job-otel-collector/configs/otel-collector.yaml`、`iac/modules/job-logs-collector/configs/vector.toml`）在 2026.30 都已不存在,**链接不可点**,保留为历史档案;替代配置见 `packages/local-dev/`（见 §3.3）。`packages/nomad-nodepool-apm/` **仍然存在**,不受影响。

## 一、先区分六类数据

| 数据 | 产生位置 | 典型后端 | 主要用途 |
| --- | --- | --- | --- |
| service traces/metrics/logs | 所有 Go 服务 | Grafana Cloud/本地 Mimir、Tempo、Loki | 服务健康、延迟、错误定位 |
| sandbox resource metrics | orchestrator 轮询 envd | OTel -> ClickHouse `sandbox_metrics_gauge` | 用户查询 CPU/RAM/disk 历史 |
| sandbox/build logs | envd、template builder | Loki,**或**(2026.30 起)`sandbox_logs` ClickHouse 表 | 用户日志与构建日志查询 |
| sandbox lifecycle events | orchestrator handler | ClickHouse + 条件式 Redis Stream | 审计、webhook、历史事件 |
| sandbox host stats | orchestrator cgroup v2 | ClickHouse `sandbox_host_stats` | 宿主侧计量与资源分析 |
| **sandbox egress destinations** | 节点侧 egress proxy(**写入端不在本仓库**) | ClickHouse `sandbox_egress`(2026.30 新增) | 出站目的地审计与策略分析 |

这些链路共享 `sandbox_id`、`team_id` 等关联键，但可靠性、采样周期、保留期和查询入口不同。排障前先判断自己面对的是哪一种数据。

### 1.1 2026.30 变动速览

本窗口把「日志往哪写、往哪读」从编译期固定地址改成了 LaunchDarkly 动态路由，并新增了一条 ClickHouse 日志读取路径与一张 egress 表。逐条索引:

| 变动 | 章节 |
| --- | --- |
| 日志写入动态路由(`logs-write-config`)+ shadow 转发 | [5.6](#56-202630-日志写入动态路由logs-write-config) |
| 日志读取可切 ClickHouse(`logs-read-config`、`LOGS_READ_CONFIG`) | [5.7](#57-202630-日志读取可切-clickhouselogs-read-config) |
| `LOKI_URL` 变可选,双空则拒绝启动 | [5.7.2](#572-⚠️-loki_url-变可选但没有日志后端会拒绝启动) |
| 过期(pause 前)日志被丢弃 + 告警限流 | [5.8](#58-202630-过期日志丢弃与告警限流) |
| `sandbox_egress` 目的地址表 | [八](#八sandbox-egress-目的地址记录202630-新增) |
| `clickhouse-batcher-max-batch-size` 默认 100 → 1000 | [6.2](#62-clickhouse-batcher) |
| histogram 聚合抽成 `histogramAggregation`、Shutdown 先 force flush | [2.5](#25-202630-telemetry-sdk-的两处变化) |
| `iac/` 目录整体删除(Nomad 部署退役) | [3.3](#33-202630iac-目录已从仓库删除) |

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

### 2.5 2026.30 telemetry SDK 的两处变化

**(a) histogram 聚合选择器抽成具名函数 `histogramAggregation`**([`main.go:43-56`](../packages/shared/pkg/telemetry/main.go)):

```go
func histogramAggregation(kind sdkmetric.InstrumentKind) sdkmetric.Aggregation {
    if kind == sdkmetric.InstrumentKindHistogram {
        return sdkmetric.AggregationBase2ExponentialHistogram{MaxSize: 160, MaxScale: 20, NoMinMax: false}
    }
    return sdkmetric.DefaultAggregationSelector(kind)
}
```

行为与 2026.29 相同(参数没变),区别只在可测试性——`histogram_aggregation_test.go` 现在能直接断言它。源码注释里有一条容易被忽略的副作用:

> ⚠️ 因为 reader 默认聚合变成了 base-2 exponential,**在 instrument 上写 `metric.WithExplicitBucketBoundaries(...)` 会被丢弃**。显式 bucket 只在 reader 默认是 explicit-bucket 聚合时才有意义。要按 metric 定制分桶必须用 View,不能用 boundaries。

**(b) `Client.Shutdown` 先 force flush 再关 exporter**([`main.go:124-133`](../packages/shared/pkg/telemetry/main.go)):

```go
func (t *Client) Shutdown(ctx context.Context) error {
    var errs []error
    // Flush before the exporter is torn down: shutting it down first would
    // leave the reader's pending batch with nowhere to go.
    if err := t.forceFlush(ctx); err != nil {
        errs = append(errs, err)
    }
    ...
}
```

`forceFlush` 在 `New` 里绑定为 `meterProvider.ForceFlush`([`main.go:102`](../packages/shared/pkg/telemetry/main.go)),noop client 则绑一个恒返回 nil 的桩([`main.go:156`](../packages/shared/pkg/telemetry/main.go))。

⚠️ 这条对**进程最后 15 秒**的指标很关键:2026.29 之前先 `MetricExporter.Shutdown` 会让 periodic reader 里还没 export 的那一批无处可去。如果看到「服务退出前的指标缺失」,先确认跑的是 2026.30+。

同窗口还新增了 `telemetry.Observe0` / `Observe1` 辅助函数([`tracing.go:16-49`](../packages/shared/pkg/telemetry/tracing.go)),把「开 span → 执行 → 按 error 设置 span status」这套样板收敛成一个泛型函数;`telemetry.WithMaskedAccessToken` 随 access token 退役一起删除([`fields.go`](../packages/shared/pkg/telemetry/fields.go))。

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

### 3.3 2026.30:`iac/` 目录已从仓库删除

commit `8a1c48884`(`chore(deploy): retire Nomad-based deployment ahead of a new deploy path`)把整个 `iac/` 目录从仓库中移除——`iac/modules/job-otel-collector/`、`iac/modules/job-logs-collector/`、`iac/modules/job-clickhouse/`、`iac/modules/job-loki/`、`iac/provider-gcp/`、`iac/provider-aws/` 全部不复存在(`git ls-tree 2026.30 iac/` 为空)。

对本节的影响:

| 2026.29 的引用 | 2026.30 状态 |
| --- | --- |
| `iac/modules/job-otel-collector/configs/otel-collector.yaml` | ⛔ 已删除 |
| `iac/modules/job-otel-collector-nomad-server/configs/otel-collector-nomad-server.yaml` | ⛔ 已删除 |
| `iac/modules/job-logs-collector/configs/vector.toml` | ⛔ 已删除 |
| `packages/local-dev/otel-collector.yaml` | ✅ 保留(blob 未变) |
| `packages/local-dev/vector.toml` | ✅ 保留(blob 未变) |

⚠️ 因此上文 §3.1「生产节点 collector」描述的是 **2026.29 及之前的部署形态**。生产 pipeline/filter/exporter 的具体配置现在不再随本仓库发布,读代码时只能参考本地 dev 版本(`packages/local-dev/otel-collector.yaml`)。仓库内的 `packages/local-dev/vector.toml` 也仍然是本地拓扑,不是生产配置。

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

### 5.6 （2026.30）日志写入动态路由:`logs-write-config`

2026.29 之前,Hyperloop 的 `/logs` handler 只往一个编译期固定的 `LOGS_COLLECTOR_ADDRESS` POST。2026.30 起改为**每次请求解析一次路由**(commit `1b19a3bcb`)。

`NewHyperloopServer` 与 `NewHyperloopStore` 都多了一个 `*featureflags.Client` 参数:

| 函数 | 2026.29 | 2026.30 |
| --- | --- | --- |
| `NewHyperloopServer` | [`server.go:25`](../packages/orchestrator/pkg/hyperloopserver/server.go) | [`server.go:26`](../packages/orchestrator/pkg/hyperloopserver/server.go) |
| `NewHyperloopStore` | [`handlers/store.go:26`](../packages/orchestrator/pkg/hyperloopserver/handlers/store.go) | [`handlers/store.go:37`](../packages/orchestrator/pkg/hyperloopserver/handlers/store.go) |

store 里新增 `logWriteConfig *featureflags.LogWriteConfigResolver`([`handlers/store.go:30`](../packages/orchestrator/pkg/hyperloopserver/handlers/store.go)),由 `featureflags.NewLogWriteConfigResolver(featureFlags, sandboxCollectorAddr)` 构造([`handlers/store.go:50`](../packages/orchestrator/pkg/hyperloopserver/handlers/store.go))。

**flag 的 JSON 形状**(`LogsWriteConfigFlag = NewJSONFlag("logs-write-config", ldvalue.Null())`,[`flags.go:890`](../packages/shared/pkg/featureflags/flags.go)):

```json
{
  "mode": "primary_only" | "primary_and_shadow",
  "primary_url": "http://...",
  "shadow_urls": ["http://localhost:4321/logs"],
  "timeout_ms": 2000,
  "max_inflight_shadow_writes": 1024
}
```

约束(见 [`flags.go:862-890`](../packages/shared/pkg/featureflags/flags.go) 的注释):

- `mode` 缺省或非法 → 整体回落到 legacy(单一 `LOGS_COLLECTOR_ADDRESS`)。`primary_only` = 只写 `primary_url`;`primary_and_shadow` = 写 primary,并 fire-and-forget 扇出到 `shadow_urls`。
- `primary_url` 必填,且**只允许 `http://` / `https://`**,其余协议直接让整份 config 回落。
- `shadow_urls` 必须是数组、每个都是安全 URL,且**最多 `maxLogWriteShadowURLs = 4` 个**。
- `timeout_ms <= 0` 或过大 → clamp 到安全区间(`defaultLogWriteTimeout = 2000ms`、`maxLogWriteTimeout = 10000ms`)。
- `max_inflight_shadow_writes <= 0` → `defaultMaxInflightShadowWrites = 1024`([`handlers/store.go:22`](../packages/orchestrator/pkg/hyperloopserver/handlers/store.go))。

**shadow 转发的语义**(见 [`handlers/logs.go:124-158`](../packages/orchestrator/pkg/hyperloopserver/handlers/logs.go)):

- 用 `h.tryAcquireShadow(maxInflight)` 抢一个信号量;**抢不到就静默丢弃这条 shadow 写**,只记 metric `reason="saturated"`——防止高流量下 goroutine 无界增长和「shadow 日志风暴」。
- shadow goroutine 用 `context.WithoutCancel(ctx)` 派生的 context,响应早已返回也不受影响。
- **只有 primary 写决定响应**:primary 失败 → 500,primary 成功 → 200。shadow 成功/失败都不影响 guest 看到的 status。

对应新增两个指标([`handlers/logs.go:26-38`](../packages/orchestrator/pkg/hyperloopserver/handlers/logs.go)):

| 指标 | 类型 | 标签 |
| --- | --- | --- |
| `orchestrator.hyperloop.log_forward.write_count` | Counter | `route`(primary/shadow/ingest)、`result`(success/failure/dropped)、`reason`(send_error/saturated/stale_timestamp) |
| `hyperloop_log_forward_shadow_inflight` | UpDownCounter | — |

> ⚠️ `hyperloop_log_forward_shadow_inflight` 是**唯一一个不带 `orchestrator.` 前缀**的 hyperloop 指标名,别按前缀去 grep。

### 5.7 （2026.30）日志读取可切 ClickHouse:`logs-read-config`

读取侧的对称改动(commits `1b19a3bcb`、`fdc33599b`)。新增了一张 ClickHouse 表 `sandbox_logs`(迁移 `20260702181515_add_sandbox_logs.sql`,见 [clickhouse-package.md](./clickhouse-package.md)),并在 API 侧加了可切换的读取路径。

#### 5.7.1 路由开关与两个配置入口

| 入口 | 形态 | 作用 |
| --- | --- | --- |
| `logs-read-config`(LD bool flag) | `LogsReadConfigFlag = NewBoolFlag("logs-read-config", logsReadConfigFallback())`([`flags.go:898`](../packages/shared/pkg/featureflags/flags.go)) | `false` = 从 Loki 读(旧行为);`true` = 从 ClickHouse `sandbox_logs` 读 |
| `LOGS_READ_CONFIG`(环境变量) | **只接受 `strconv.ParseBool` 能解析的字符串** | 只作为 LD flag 的 **fallback 默认值** |

> ⚠️ 任务/旧文档里可能把 `LOGS_READ_CONFIG` 描述成 JSON 配置——**它不是**。它就是个 bool 字符串(`parseLogsReadConfig` = `strconv.ParseBool(strings.TrimSpace(raw))`,`[flags.go:902-908]`),未设置或解析失败一律当 `false`。真正的 JSON 配置是**写**侧的 `logs-write-config`(见 [5.6](#56-202630-日志写入动态路由logs-write-config))。
>
> LD 与 env 的优先级:**LD 有值则 LD 赢**;没有 LD(纯自托管)时读 env。

解析发生在**每次读请求**,不是启动时([`resources_local.go:98-104`](../packages/api/internal/clusters/resources_local.go)):

```go
func (l *LocalClusterResourceProvider) readFromClickhouse(ctx context.Context) bool {
    // 需要 flag 打开 且 配了 ClickHouse reader
    return l.featureFlags.BoolFlag(ctx, featureflags.LogsReadConfigFlag)
}
```

#### 5.7.2 ⚠️ `LOKI_URL` 变可选,但没有日志后端会拒绝启动

2026.30 起 `LOKI_URL` 从「必填」变成「可选」([`packages/api/internal/cfg/model.go:50-52`](../packages/api/internal/cfg/model.go)):

```go
// LokiURL is optional: without it the api has no Loki client, and sandbox
// and build log reads ...
LokiURL  string `env:"LOKI_URL"`
```

因为「不配 Loki」以前不可能发生,所以**没有**对应的启动校验;现在必须补一条,否则每个日志读都会变成 500。补的这条在:

`noLogStoreError(lokiURL, clickhouseConnectionString)` — [`packages/api/internal/handlers/logstore.go:9`](../packages/api/internal/handlers/logstore.go)(**注意是 `handlers` 包,不是 `cfg` 包**):

```go
func noLogStoreError(lokiURL, clickhouseConnectionString string) error {
    if lokiURL == "" && clickhouseConnectionString == "" {
        return errors.New("neither LOKI_URL nor CLICKHOUSE_CONNECTION_STRING is set: sandbox and build log reads would have no store")
    }
    return nil
}
```

调用点在 [`packages/api/internal/handlers/store.go:295`](../packages/api/internal/handlers/store.go),`logger.L().Fatal(ctx, "no log store configured", ...)` —— 即**进程直接不启动**。

> ⚠️ 这是本窗口最容易踩的运维坑:**只把 `LOKI_URL` 去掉、又没配 `CLICKHOUSE_CONNECTION_STRING` 的 API 会起不来**。错误文案是 `neither LOKI_URL nor CLICKHOUSE_CONNECTION_STRING is set: sandbox and build log reads would have no store`。
>
> 只配 `LOKI_URL` 时(旧部署)会多一行 warning:`LOKI_URL is not set: sandbox and build log reads need logs-read-config on (ClickHouse) or they fail`([`store.go:301`](../packages/api/internal/handlers/store.go))——反过来说,只配 ClickHouse 时 Loki 相关读会失败。

#### 5.7.3 API 侧的装配

| 位置 | 内容 |
| --- | --- |
| [`store.go:192`](../packages/api/internal/handlers/store.go) | `type APIStore struct` |
| [`store.go:215`](../packages/api/internal/handlers/store.go) | `sandboxLogsReader *sandboxlogs.Reader` |
| [`store.go:268-281`](../packages/api/internal/handlers/store.go) | 只在 `config.ClickhouseConnectionString != ""` 时用 `clickhouse.NewDriver` + `sandboxlogs.NewReader(conn)` 构造 |
| [`store.go:273`](../packages/api/internal/handlers/store.go) | `clusterLogsReader clusters.ClickhouseLogsReader` —— 注释明确说**要保持 nil interface**,不能塞一个 typed-nil 指针进 interface,否则 `resources_local.go` 里的 nil 判断失效、读会错误地走到 ClickHouse |
| [`store.go:309`](../packages/api/internal/handlers/store.go) | 传入 `clusters.NewPool(...)` |
| [`store.go:474-476`](../packages/api/internal/handlers/store.go) | `Close` 时关闭 reader |

reader 接口窄化为两个方法([`resources_local.go:29-31`](../packages/api/internal/clusters/resources_local.go)):`QuerySandboxLogs` 与 `QueryBuildLogs`。

读取分发(本地 cluster):

| 方法 | ClickHouse 分支 | Loki 分支 |
| --- | --- | --- |
| `GetSandboxLogs`([`resources_local.go:193`](../packages/api/internal/clusters/resources_local.go)) | `:213` `case l.readFromClickhouse(ctx):` → `sandboxLogsReader.QuerySandboxLogs`(`:223`) | `:230` `queryLogsProvider.QuerySandboxLogs` |
| `GetBuildLogs`([`resources_local.go:258`](../packages/api/internal/clusters/resources_local.go)) | `:275` `if l.readFromClickhouse(ctx)` → `logsFromClickhouse`(`:284`) | `logsFromLocalLoki`(`:301`) |

ClickHouse 读失败计数为 `log_read_clickhouse_error_count`(Counter,标签 `kind`,`[resources_local.go:36-59]`)。

**ClickHouse reader 的查询语义**([`packages/clickhouse/pkg/sandboxlogs/sandboxlogs.go`](../packages/clickhouse/pkg/sandboxlogs/sandboxlogs.go)):

- sandbox logs:`team_id = ? AND sandbox_id = ? AND category != 'metrics'`,可选 `level IN (...)`(语义与 Loki 的「最低级别」一致,由 `atLeastLevels` 映射)与 `position(message, ?) > 0`(literal substring,与 Loki 侧 `regexp.QuoteMeta` 的语义对齐)。
- build logs:`build_id = ? AND template_id = ? AND service = 'template-manager'`,带 `LIMIT offset, limit`。
- `Fields` 列是 JSON 编码的 `map[string]string`;unmarshal 失败时记 warning 并退化为空 map,**保留 `Raw`**。

#### 5.7.4 没有后端时的失败语义

`errNoLogStore`([`resources_local.go:93`](../packages/api/internal/clusters/resources_local.go)):

> `no log store for this read: LOKI_URL is unset and the read did not route to ClickHouse (logs-read-config off, or no CLICKHOUSE_CONNECTION_STRING to read from)`

即「API 起来了(因为至少配了一个),但这次读既没路由到 ClickHouse、也没有 Loki」——这是**启动校验通过之后**才会出现的第二种失败,和 [5.7.2](#572-⚠️-loki_url-变可选但没有日志后端会拒绝启动) 的 fatal 不是一回事。

### 5.8 （2026.30）过期日志丢弃与告警限流

commit `8ec4be5ff`:Hyperloop `/logs` 现在会**拒绝时间戳早于本 lifecycle resume 时刻的日志**([`handlers/logs.go:97-106`](../packages/orchestrator/pkg/hyperloopserver/handlers/logs.go)):

```go
if hasStaleLogTimestamp(payload, sbx.LifecycleStartedAt) {
    h.sendAPIStoreError(c, http.StatusBadRequest, "Log timestamp predates this sandbox's resume")
    recordLogForwardWrite(ctx, "ingest", "dropped", "stale_timestamp")
    h.staleWarnLogger.Warn(ctx, "dropping envd log with a stale pre-resume timestamp", ...)
    return
}
```

判定函数在 [`handlers/logs.go:270`](../packages/orchestrator/pkg/hyperloopserver/handlers/logs.go)。这解决的是 §5.1 提到的那类问题:旧 snapshot lifecycle 的 in-flight 日志会在 resume 之后才到,把旧时间戳的行写进新 lifecycle 的 Loki stream。

commit `fdc33599b` 给这条 warning 加了**限流**([`handlers/logs.go:40-47`](../packages/orchestrator/pkg/hyperloopserver/handlers/logs.go)):`staleLogWarningInterval = 30 * time.Second`,用 zap 的 sampler 按 `entry.Time`(墙钟)分桶。

> ⚠️ 注释里写明了这个实现的已知取舍:sampler 存的是 `resetAt = entry.Time + tick`,所以**墙钟回拨后,告警会静默大约一个回拨量,直到墙钟追回 `resetAt`**。这是接受了的代价——**per-drop 指标不受影响,仍然记录每一次丢弃**,所以排查时用指标计数,不要用 warning 条数。
>
> 另外:被抑制的 warning **故意不带 suppressed count**,数量信息只在指标里。

### 5.9 两类日志链路的对比小结

| 维度 | 2026.29 | 2026.30 |
| --- | --- | --- |
| 写入目标 | 编译期固定 `LOGS_COLLECTOR_ADDRESS` | LD `logs-write-config` 动态解析,可 shadow 扇出 |
| 写失败语义 | primary 失败 → 500 | 不变(shadow 失败静默) |
| 读取后端 | Loki | Loki 或 ClickHouse `sandbox_logs`,由 `logs-read-config` 每次请求决定 |
| `LOKI_URL` | 必填 | 可选,但双空则 fatal |
| 过期日志 | 照单转发 | 400 丢弃 + 计数 + 限流 warning |

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

**2026.30 变动**:`clickhouse-batcher-max-batch-size` 的默认值从 **100 改成 1000**([`flags.go:439`](../packages/shared/pkg/featureflags/flags.go);2026.29 在 `flags.go:286`)。`max-cache-writer-concurrency` 保持 10 不变([`flags.go:472`](../packages/shared/pkg/featureflags/flags.go))。

> ⚠️ 默认值放大 10 倍意味着**单次 flush 的 payload 变大、但 flush 频次降低**。如果某个环境在 LD 里没有显式覆盖这个 flag,升级到 2026.30 后 `batcher.flush.batch_size` 直方图的形状会整体右移,`batcher.flush.duration` 的尾延迟也可能变长——别把它当成回归。

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

## 八、Sandbox Egress 目的地址记录（2026.30 新增）

迁移 [`packages/clickhouse/migrations/20260818120000_add_sandbox_egress.sql`](../packages/clickhouse/migrations/20260818120000_add_sandbox_egress.sql) 新增 `sandbox_egress_local` + 分布式表 `sandbox_egress`。它记录 sandbox 出站连接被 egress proxy 判定的**目的地址与裁决结果**,是 §一 表格里第六类数据。

### 8.1 ⚠️ 本仓库只有表结构,没有写入端

> ⚠️ **重要且容易误判**:`git grep sandbox_egress` 在本仓库里只会命中迁移文件。**写入端不在这个仓库**(应在闭源/企业版组件里)。因此:
>
> - 不要在本仓库里找 `sandbox_egress` 的 `INSERT`——找不到是正常的,不是漏了。
> - 本仓库里唯一与它相关的改动是 [`packages/orchestrator/pkg/factories/run.go`](../packages/orchestrator/pkg/factories/run.go) 把 ClickHouse endpoint 暴露给版本相关的 `EgressFactory`(见 [8.3](#83-本仓库的使能改动))。
> - 表里没有数据时,先怀疑写入端部署,不要怀疑这张迁移。

### 8.2 表结构

列清单(全部 `CODEC (ZSTD(1))`,`DateTime64(9)` 带 `Delta` 前缀压缩):

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `first_seen` | `DateTime64(9)` | 该目的地第一次被看到(**节点时钟**) |
| `last_seen` | `DateTime64(9)` | 最后一次被看到(**节点时钟**) |
| `ingested_at` | `DateTime64(9) DEFAULT now64(9)` | **服务端**赋值,分区与 TTL 都基于它 |
| `team_id` | `UUID` | |
| `sandbox_id` | `String` | |
| `sandbox_execution_id` | `String` | |
| `sandbox_template_id` | `String` | |
| `sandbox_build_id` | `String` | |
| `sandbox_type` | `LowCardinality(String)` | |
| `protocol` | `LowCardinality(String)` | |
| `destination_ip` | **`String`** | 见下面的 ⚠️ |
| `destination_port` | `UInt16` | |
| `server_name` | `Nullable(String)` | |
| `decision` | `LowCardinality(String)` | 裁决(放行/拒绝) |
| `match_type` | `LowCardinality(String)` | 命中的规则类型 |
| `connections` | `UInt64` | `first_seen`..`last_seen` 之间到达该裁决的连接数 |

索引:`idx_destination_ip`(bloom_filter)、`idx_server_name`(bloom_filter)、`idx_sandbox_id`(bloom_filter),均 `GRANULARITY 4`。

表参数:

```sql
ENGINE = MergeTree
PARTITION BY toDate(ingested_at)
ORDER BY (team_id, sandbox_id, destination_ip, destination_port, last_seen)
TTL toDateTime(ingested_at) + INTERVAL 7 DAY
SETTINGS ttl_only_drop_parts = 1
```

分布式表按 **sandbox** 分片,而不是像邻居表那样按 team:

```sql
CREATE TABLE sandbox_egress AS sandbox_egress_local
    ENGINE = Distributed('cluster', currentDatabase(), 'sandbox_egress_local', xxHash64(sandbox_id));
```

迁移注释解释了原因:产生最多行的负载是「**一个 team 的很多 sandbox 访问很多目的地**」,按 team 分片会把它们全压到同一个 shard。

### 8.3 ⚠️ 三个反直觉的设计点

**(a) `destination_ip` 是 `String`,不是 `IPv6`——这是故意的**

迁移里的原文注释:

> String rather than IPv6 on purpose: the IPv6 type stores a v4 address as `::ffff:a.b.c.d`, for which `isIPAddressInRange` answers false against a v4 CIDR. On a String it answers directly.

也就是说:ClickHouse 的 `IPv6` 类型在存 v4 地址时会写成 v4-mapped 形式(`::ffff:1.2.3.4`),拿它去和一条 v4 CIDR 做 `isIPAddressInRange` 会**返回 false**——策略匹配会静默失效。用 `String` 存原始文本则能直接匹配。所以看到这个「类型选得不对」的列时,**不要「顺手修正」成 IPv6**。

**(b) 分区和 TTL 用 `ingested_at`,不是 `first_seen`**

`first_seen` / `last_seen` 由节点写入,受**节点时钟**影响;`ingested_at` 由服务端赋值。迁移注释:节点时钟偏斜会让它写进一个**永不过期的分区**。所以时间和分区维度要分开看:

- 按分区/TTL 思考 → 用 `ingested_at`。
- 按「事件什么时候发生」思考 → 用 `first_seen` / `last_seen`。

**(c) 一行是「裁决」,不是「完成的连接」**

`connections` 的注释:行在防火墙**放行或拒绝**时写入,**早于 upstream dial**,而 dial 仍然可能失败。所以:

- `decision=allow` 不等于「连接成功」。
- 行是**按 flush 间隔预聚合**的,要拿全量历史必须 `sum(connections)` 而不是 `count(*)`。

`server_name` 为 `NULL` 的场景注释里列全了:**所有非 TLS/HTTP 端口**、**没有 SNI 的 TLS 握手**、**没有 Host 头的 HTTP 请求**。空字符串不能代替这个「缺失」语义。注意「发往 IP 字面量的 HTTP 请求」**仍然带 Host 头**,此时这里记的是那个地址。

### 8.4 本仓库的使能改动

`factories.Deps` 新增字段并把 endpoint 传给 egress 工厂:

| 位置 | 内容 |
| --- | --- |
| [`run.go:89`](../packages/orchestrator/pkg/factories/run.go) | `ClickhouseEndpoints []ClickhouseEndpoint`(新增字段,在 `type Deps struct` `:82` 内) |
| [`run.go:92`](../packages/orchestrator/pkg/factories/run.go) | `type ClickhouseEndpoint struct` |
| [`run.go:176`](../packages/orchestrator/pkg/factories/run.go) | `openClickhouseEndpoints(ctx, config)` |
| [`run.go:640`](../packages/orchestrator/pkg/factories/run.go) | 调用 `openClickhouseEndpoints` |
| [`run.go:736`](../packages/orchestrator/pkg/factories/run.go) | `ClickhouseEndpoints: clickhouseEndpoints` 填进 `deps` |
| [`run.go:739`](../packages/orchestrator/pkg/factories/run.go) | `egressSetup, err := opts.EgressFactory(ctx, deps)` |

2026.29 的 `Deps`(`run.go:78`)没有这个字段,`EgressFactory` 也拿不到任何 ClickHouse 连接——这是本仓库内唯一可验证的「egress → ClickHouse」连接点。

---

## 九、Orchestrator 侧新增指标（2026.30）

除 §四 的 sandbox resource observer 外,2026.30 新增/改动了以下 orchestrator 指标。排查时按前缀找:

### 9.1 网络数据面

| 指标 | 类型 | 位置 |
| --- | --- | --- |
| `orchestrator.network.datapath` | Gauge(数据面版本) | 常量 [`network/metrics.go:13`](../packages/orchestrator/pkg/sandbox/network/metrics.go),注册 [`run.go:853`](../packages/orchestrator/pkg/factories/run.go) |
| `orchestrator.network.v2.slots_pool.creation_failures` | Counter | [`network/v2/metrics.go:14`](../packages/orchestrator/pkg/sandbox/network/v2/metrics.go) |
| `orchestrator.network.v2.host_firewall.mutation_failures` | Counter | [`network/v2/metrics.go:15`](../packages/orchestrator/pkg/sandbox/network/v2/metrics.go) |
| `orchestrator.network.v2.host_firewall.reconciliation_failures` | Counter | [`network/v2/metrics.go:16`](../packages/orchestrator/pkg/sandbox/network/v2/metrics.go) |
| `orchestrator.network.v2.host_firewall.connection_resets` | Counter | [`network/v2/metrics.go:17`](../packages/orchestrator/pkg/sandbox/network/v2/metrics.go) |
| `orchestrator.network.v2.host_firewall.connection_reset_failures` | Counter | [`network/v2/metrics.go:18`](../packages/orchestrator/pkg/sandbox/network/v2/metrics.go) |
| `orchestrator.network.v2.host_firewall.reconciliation_skipped` | Counter | [`network/v2/metrics.go:19`](../packages/orchestrator/pkg/sandbox/network/v2/metrics.go),标签 `reason`(目前只有 `unclean_startup_reclaim`) |

`RegisterDatapathMetric` 返回一个可 `Unregister()` 的注册句柄,关闭时释放([`run.go:857-859`](../packages/orchestrator/pkg/factories/run.go))。

### 9.2 Sandbox 生命周期

| 指标 | 类型 | 标签 | 位置 |
| --- | --- | --- | --- |
| `orchestrator.sandbox.execution.duration` | Histogram(ms) | `stop_reason` | [`telemetry/meters.go:341`](../packages/shared/pkg/telemetry/meters.go) 附近;记录 [`server/sandboxes.go:791-799`](../packages/orchestrator/pkg/server/sandboxes.go) |
| `orchestrator.sandbox.checkpoint` | Counter | `in_place`、`success` | [`meters.go:62`](../packages/shared/pkg/telemetry/meters.go);记录 [`sandboxes.go:1093-1096`](../packages/orchestrator/pkg/server/sandboxes.go) |
| `orchestrator.sandbox.pause_admission` | Counter | `outcome`、`rpc` | [`meters.go:58`](../packages/shared/pkg/telemetry/meters.go);记录 [`sandboxes.go:804-818`](../packages/orchestrator/pkg/server/sandboxes.go) |
| `orchestrator.sandbox.pause_admission.wait.duration` | Histogram(ms) | `outcome` | 同上 |
| `orchestrator.sandbox.pause.duration` | Histogram(ms) | `fs_only`、`success` | [`sandboxes.go:832-837`](../packages/orchestrator/pkg/server/sandboxes.go) |
| `orchestrator.routing.publish.total` / `orchestrator.routing.delete.total` | Counter | — | [`packages/orchestrator/pkg/routing/publisher.go`](../packages/orchestrator/pkg/routing/publisher.go) |

**execution duration 现在按 stop reason 分类**(commit `78525948b`)。`recordExecutionDuration`([`sandboxes.go:791`](../packages/orchestrator/pkg/server/sandboxes.go))打 `stop_reason` 标签,取值来自 [`packages/orchestrator/pkg/sandbox/sandbox.go:226-231`](../packages/orchestrator/pkg/sandbox/sandbox.go):

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `StopReasonKilled` | `killed` | Delete 及 orchestrator 主动拆除 |
| `StopReasonPaused` | `paused` | 正常 pause |
| `StopReasonCheckpointing` | `checkpointing` | checkpoint |
| `StopReasonCrashed` | `crashed` | **没有记录过原因**——即没人要求它停 |

> ⚠️ `crashed` 是「缺失值」而不是一个显式设置的状态([`sandbox.go:577-586`](../packages/orchestrator/pkg/sandbox/sandbox.go)):执行结束时如果没有任何人调用过 `SetStopReason`,读出来就是 `crashed`。所以 `stop_reason="crashed"` 的计数升高,含义是「有一批 execution 在没有被要求停止的情况下结束了」,不是「有代码显式判定崩溃」。
>
> 另外源码注释提醒:`stop_reason` 是**按意图**打的——一次 pause 如果快照失败,仍然记为 `paused`,失败由 pause 自己的指标计数。

**pause 的两个细分**(commits `4be33baa6`、`f551118f6`):

- `fs_only` 标签([`sandboxes.go:834`](../packages/orchestrator/pkg/server/sandboxes.go)、[`sandboxes.go:1614`](../packages/orchestrator/pkg/server/sandboxes.go)):gRPC 的 RPC 级指标区分不出 filesystem-only pause 和 memory pause,所以单独打标签,让 dashboard 能把「call count / error rate / latency」限定到 fs-only 队列。
- pause-snapshot 的延迟**按步骤拆开**:`orchestrator.sandbox.snapshot.process_memory.duration`、`.process_rootfs.duration`、`.rootfs_seal.duration`、`.guest_freeze.duration`、`.memory_seal.duration`(均见 [`meters.go`](../packages/shared/pkg/telemetry/meters.go))。

### 9.3 节点状态与 outstanding work

节点新增终态 `ServiceInfoStatus_ShuttingDown = 4`([`packages/orchestrator/info.proto:16-17`](../packages/orchestrator/info.proto)),语义是「排空存量工作后退出,不可逆」。健康检查把 `Draining`、`Standby`、`ShuttingDown` **三者都映射成 `e2bHealth.Draining`**([`healthcheck.go:44`](../packages/orchestrator/pkg/healthcheck/healthcheck.go))——2026.29 只映射前两个。

> ⚠️ 因此**从 `/health` 的响应分不出节点是 draining 还是正在关停**。要区分只能看 gRPC `ServiceInfo` 的 status 值(或日志里的 "Service status changed")。

`ServiceInfo` 新增 `optional uint64 outstanding_work = 58`([`info.proto:56`](../packages/orchestrator/info.proto)):

- ⚠️ **字段号故意跳过 57**,直接是 58。
- ⚠️ 它是 `optional`,并且注释写明「**Missing means unknown, not idle**」——**字段缺席表示「未知」,不表示「空闲」**。上报侧也用指针表达这个区别([`service_info.go:72/80`](../packages/orchestrator/pkg/service/service_info.go)):

  ```go
  outstandingWork := uint64(info.outstandingWork)
  ...
  OutstandingWork: &outstandingWork,
  ```

  这对 autoscaling 是**关键语义差异**:消费方如果把「没有这个字段」当成 0,会把一个老版本节点(不报这个字段)判成空闲并继续往里塞工作;正确做法是「字段缺席 → 不参与缩容决策」。

- 计数器本体在 [`service/info.go:38`](../packages/orchestrator/pkg/service/info.go)(`outstandingWork int64`),`TrackWork` 自增(`:56`)、release 自减(`:66`),读取在 `OutstandingWork()`(`:69`)。

API 侧对应新增 `GET /admin/sandboxes/running-counts`(handler [`packages/api/internal/handlers/admin_running_sandbox_counts.go`](../packages/api/internal/handlers/admin_running_sandbox_counts.go),返回 `api.AdminTeamRunningSandboxCounts`,即 teamID → count 的 map)。它由 `teamRunningSandboxCounter` 接口驱动([`handlers/store.go:188-190`](../packages/api/internal/handlers/store.go))。

---

## 十、读取边界与 Retention

| API/消费者 | 数据源 | 保留语义 |
| --- | --- | --- |
| sandbox metrics API | local ClickHouse 或 remote Edge | `sandbox_metrics_gauge` 固定 7 天 |
| sandbox logs API | local Loki、local ClickHouse `sandbox_logs`,或 remote Edge | Loki 由部署配置决定;ClickHouse 表固定 7 天(基于 `ingested_at`);Dashboard 按 7 天提示 |
| team metrics API | ClickHouse team tables | 见 team metrics 专章 |
| Dashboard sandbox record | PostgreSQL | record 可长期存在，只计算数据是否过期 |
| lifecycle event consumer | ClickHouse / Redis Stream | team TTL，默认 7、最大 365 天 |
| host stats analysis | ClickHouse | 固定 7 天 |
| egress destinations | ClickHouse `sandbox_egress` | 固定 7 天(基于 `ingested_at`) |

Dashboard record 的 `retentionExpired` 与 `eventsRetentionExpired` 是基于 `stopped_at` 的预测字段，不会实时探测 Loki/ClickHouse。因此它们适合 UI 决策，不是后端健康检查。

> ⚠️ `sandbox_logs` 的 TTL 键在 `ingested_at`(服务端时钟),不在 `timestamp`(节点时钟)。所以「日志比 7 天前还查得到/查不到」这种偏差要按 `ingested_at` 解释。

## 十一、端到端排障手册

### 11.1 Metrics API 返回空

按顺序检查:

1. sandbox 是否运行在当前 team/cluster。
2. envd version 是否达到 metrics 最低版本。
3. orchestrator 的 100 ms `GetMetrics` 是否 timeout。
4. `OTEL_COLLECTOR_GRPC_ENDPOINT` 是否设置。
5. collector `filter/external_metrics` 是否保留 `e2b.*`。
6. ClickHouse `metrics_gauge` 是否有原始行。
7. `sandbox_metrics_gauge_mv` 是否工作。
8. 查询时间窗是否超过 7 天。

### 11.2 Logs API 返回空

**先判断这次读走的是哪条路**(2026.30 起有两路):

1. 先查 API/Edge 日志，确认实际 cluster route。
2. 本地 cluster 时确认 `logs-read-config` 的当前值:开 → 查 ClickHouse `sandbox_logs`;关 → 查 Loki。
3. 如果 `LOKI_URL` 未配,确认 API 是**用 ClickHouse 配起来的**(否则根本起不来,见 [5.7.2](#572-⚠️-loki_url-变可选但没有日志后端会拒绝启动));此时 Loki 侧读会返回 `errNoLogStore`。
4. 检查 `log_read_clickhouse_error_count{kind=...}` 是否增长。
5. 检查 envd exporter 是否拿到 `LogsCollectorAddress`。
6. 检查 hyperloop 是否拒绝旧 lifecycle 的 instance ID,或**因时间戳过期而丢弃**(`write_count{route="ingest",result="dropped",reason="stale_timestamp"}`)。
7. 检查 Vector HTTP source 与 sink health。
8. 直接用 `{teamID=..., sandboxID=...}` 查 Loki,或 `SELECT ... FROM sandbox_logs WHERE team_id=... AND sandbox_id=...` 查 ClickHouse。
9. 注意 Loki provider 出错也可能对用户返回空数组。
10. 检查 192 KiB 单行与 8 MiB buffer 丢弃条件。

### 11.3 Event 丢失

1. lifecycle handler 是否实际走到 publish 点。
2. event 是否缺 version/type/team/timestamp。
3. `batcher.items.dropped{batcher="sandbox-events..."}` 是否增长。
4. ClickHouse feature flag 是否允许目标 endpoint 写入。
5. Redis webhook key `wh:{teamID}` 是否存在。
6. 查询窗口是否超过该 team 的 per-row TTL。
7. 2026.30 起 `clickhouse-batcher-max-batch-size` 默认 1000——如果 batch 变大导致 flush 间隔变长,「事件延迟」感受会变化,但不应丢。

### 11.4 Host stats 不连续

1. sandbox cgroup handle 是否初始化成功。
2. `GetStats` 是否持续报错。
3. batcher queue 是否满。
4. counter 是否因 resume reset；这种点 delta 会被压成 0。
5. stop 时 final sample 是否完成。
6. ClickHouse 多 endpoint fanout flag 是否符合预期。

### 11.5 Egress 表没有数据

1. 确认写入端(不在本仓库)是否部署——见 [8.1](#81-⚠️-本仓库只有表结构没有写入端)。
2. 确认迁移 `20260818120000_add_sandbox_egress.sql` 已执行(`sandbox_egress` / `sandbox_egress_local` 存在)。
3. 按 `ingested_at`(不是 `first_seen`)判断是否被 7 天 TTL 清掉。
4. 确认 `EgressFactory` 收到了非空 `ClickhouseEndpoints`。

### 11.6 节点到底在 draining 还是关停

`/health` 分不出来(三者都映射成 `Draining`)。查 gRPC `ServiceInfo` 的 status,或日志 `Service status changed`。`ShuttingDown` 是终态,一旦进入不会再退回。

## 十二、关键源码索引

| 文件 | 关注点 |
| --- | --- |
| `packages/shared/pkg/telemetry/main.go` | noop/OTLP client、`histogramAggregation`、Shutdown 前 force flush |
| `packages/shared/pkg/telemetry/config.go` | collector endpoint 开关 |
| `packages/shared/pkg/telemetry/metrics.go` | 15s provider、histogram view、exemplar |
| `packages/shared/pkg/telemetry/traces.go` | batch span、AlwaysSample、propagation、`Observe0`/`Observe1` |
| `packages/shared/pkg/telemetry/logs.go` | OTel log batch exporter |
| `packages/shared/pkg/telemetry/meters.go` | 指标名常量总表(2026.30 大幅扩充) |
| `packages/local-dev/otel-collector.yaml` | Tempo/Mimir/Loki/ClickHouse 本地拓扑 |
| `packages/local-dev/vector.toml` | 本地 Vector normalize/route |
| `packages/orchestrator/pkg/metrics/sandboxes.go` | 5s sandbox observer 与版本兼容 |
| `packages/clickhouse/migrations/20250717135224_sandbox_metrics.sql` | sandbox metrics materialized view |
| `packages/clickhouse/migrations/20260702181515_add_sandbox_logs.sql` | `sandbox_logs` 表(2026.30) |
| `packages/clickhouse/migrations/20260818120000_add_sandbox_egress.sql` | `sandbox_egress` 表(2026.30) |
| `packages/clickhouse/pkg/sandboxlogs/sandboxlogs.go` | ClickHouse 日志 reader(2026.30) |
| `packages/api/internal/handlers/logstore.go` | `noLogStoreError` 启动校验(2026.30) |
| `packages/api/internal/clusters/resources_local.go` | `readFromClickhouse` 路由与 `errNoLogStore` |
| `packages/envd/internal/logs/exporter/exporter.go` | guest log buffer 与 HTTP exporter |
| `packages/orchestrator/pkg/hyperloopserver/handlers/logs.go` | 身份校验、字段覆盖、动态路由、过期丢弃 |
| `packages/orchestrator/pkg/hyperloopserver/handlers/store.go` | `LogWriteConfigResolver` 与 shadow 并发上限 |
| `packages/shared/pkg/logs/loki/provider.go` | LogQL 构造与错误降级 |
| `packages/orchestrator/pkg/events/events.go` | lifecycle event 校验与 fanout |
| `packages/clickhouse/pkg/events/delivery.go` | event batch insert 与 TTL clamp |
| `packages/orchestrator/pkg/sandbox/hoststats_collector.go` | 1s cgroup sample 与 delta |
| `packages/clickhouse/pkg/hoststats/delivery.go` | host stats batch insert |
| `packages/clickhouse/pkg/batcher/batcher.go` | queue、flush、drop 与 shutdown 语义 |
| `packages/orchestrator/pkg/sandbox/network/metrics.go` | `orchestrator.network.datapath` |
| `packages/orchestrator/pkg/sandbox/network/v2/metrics.go` | v2 数据面失败/重连指标 |
| `packages/orchestrator/pkg/healthcheck/healthcheck.go` | Draining/Standby/ShuttingDown → `Draining` |
| `packages/orchestrator/pkg/service/info.go` | 状态机、`OutstandingWork` 计数 |

> ⛔ 2026.29 之前本节还列了 `iac/modules/job-otel-collector/configs/otel-collector.yaml` 与 `iac/modules/job-logs-collector/configs/vector.toml`——`iac/` 整个目录已在 2026.30 删除(见 [3.3](#33-202630iac-目录已从仓库删除))。

## 十三、掌握程度自检

1. 为什么 service metrics 的 15 秒周期不能用于估算 sandbox metrics 延迟？
2. Mimir 有 `e2b.sandbox.*` 时，为什么 ClickHouse API 仍可能返回空？
3. Hyperloop 为什么既验证 `instanceID`，又覆盖 team/template 字段？
4. 为什么 logs API 的 `200 + []` 不能证明 Loki 正常？
5. lifecycle event 为什么不参与 sandbox 操作的事务成功条件？
6. Redis Stream 为什么不是每个 team 都写？
7. host stats 为什么同时存 cumulative counter 和 precomputed delta？
8. (2026.30) `LOGS_READ_CONFIG` 和 `logs-read-config` 是什么关系？LD 和 env 谁赢？
9. (2026.30) 为什么 `LOGS_READ_CONFIG` 不是 JSON？
10. (2026.30) `sandbox_egress.destination_ip` 为什么是 `String` 而不是 `IPv6`？
11. (2026.30) `outstanding_work` 字段缺席时,消费方应该当成 0 吗？
12. (2026.30) `/health` 返回 `draining` 时,节点可能处于哪几种状态？
