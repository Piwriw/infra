# `packages/clickhouse/` 原理详解

> 本文档梳理 E2B 基础设施中 `packages/clickhouse` 的设计原理、代码组织、批量写入路径、查询 API、数据模型与部署方式。所有结论均基于仓库源码与 `.understand-anything/knowledge-graph.json`。
>
> 行号均按 tag `2026.30` 核对。已同步至 2026.30(2026-09-10)。

## 1. 概述

`packages/clickhouse` 是 E2B 基础设施的 **分析/可观测数据层**，承担三类职责：

1. **写入端**：把 orchestrator 在沙箱生命周期中产生的高频遥测数据（生命周期事件、CPU/内存/磁盘指标、cgroup 主机统计、Webhook 投递结果）异步批量写入 ClickHouse。
2. **查询端**：向 API 层提供沙箱级和团队级时间序列指标的查询接口，用于 Dashboard 与限流决策。
3. **日志读取端（2026.30 新增）**：`pkg/sandboxlogs` 提供 `sandbox_logs` 表的最小 ClickHouse reader，让 API 在 `logs-read-config` 打开时不再依赖 Loki。

整个包是独立的 Go module（`packages/clickhouse/go.mod`），不依赖 `packages/api`、`packages/orchestrator` 等业务包，**只依赖** `packages/shared/pkg/{telemetry, logger, featureflags, events, logs}`，从而保证可复用性。

```
Client (Clickhouse) ──┬─> QuerySandboxTimeRange / QuerySandboxMetrics / QueryLatestMetrics
                      ├─> QueryTeamMetrics / QueryMaxStartRateTeamMetrics / QueryMaxConcurrentTeamMetrics
                      └─> Close

sandboxlogs.Reader    ──┬─> QuerySandboxLogs
                        └─> QueryBuildLogs            (2026.30 新增的读路径)

ClickhouseDelivery (events)  ─┐
ClickhouseDelivery (hoststats)─┴─> 共享 *batcher.Batcher[T]  → driver.Conn.PrepareBatch → INSERT
```

> ⚠️ **`sandbox_egress` 表只有迁移,没有写入实现**。它由 `20260818120000_add_sandbox_egress.sql` 创建,但写入端不在本仓库(见 §9.6)。

> ⛔ **2026.30 部署侧退役提示**:提交 `8a1c48884`（`chore(deploy): retire Nomad-based deployment ahead of a new deploy path`）把 **`iac/` 整棵树（172 个文件,含 `iac/provider-gcp/`、`iac/provider-aws/`、`iac/modules/job-*/`）** 全部删除,根目录 `self-host.md` 也已删除。⚠️ `packages/docker-reverse-proxy/`（19 个文件 → 0）**不是这个提交删的**,它由更早的 `d153bbe9d`（Jakub Rojko, 2026-08-06, `chore(docker-reverse-proxy): remove deprecated service`）删除。因此**本文中所有 `iac/**` 路径（尤其 §11）在 2026.30 都已不存在,链接不可点**,保留为历史档案。`packages/nomad-nodepool-apm/` **仍然存在**,不受影响。


## 2. 目录结构

```
packages/clickhouse/
├── go.mod / go.sum        # 独立 Go module（clickhouse-go v2、goose）
├── Dockerfile             # clickhouse-migrator 镜像（goose v3.24.2 on alpine）
├── Makefile               # build / migrate / run / connect-clickhouse 目标
├── local/                 # 本地 dev 用的 clickhouse-server 配置模板
│   ├── config.tpl.xml
│   └── users.tpl.xml
├── migrations/            # goose 迁移 SQL（按时间戳命名，2026.30 共 28 个文件）
└── pkg/
    ├── clickhouse.go      # Client、Clickhouse、SandboxQueriesProvider 接口、NewDriver、EndpointFromDSN
    ├── switcher.go        # SwitchingClient（LD-gated 多集群切换）
    ├── mock.go            # NoopClient（测试用）
    ├── dates.go           # MaxDate64 常量
    ├── sandbox.go         # 沙箱级指标查询
    ├── team.go            # 团队级指标查询
    ├── batcher/           # 通用泛型批量器 Batcher[T]
    │   ├── batcher.go
    │   └── batcher_test.go
    ├── events/            # 沙箱事件投递
    │   ├── event.go       # SandboxEvent 结构
    │   └── delivery.go    # ClickhouseDelivery
    ├── hoststats/         # 主机 cgroup 统计投递
    │   ├── hoststats.go   # SandboxHostStat + Delivery 接口 + noop / multi
    │   └── delivery.go    # ClickhouseDelivery
    ├── sandboxlogs/       # (2026.30 新增) sandbox_logs 读取端
    │   ├── sandboxlogs.go # Reader / QuerySandboxLogs / QueryBuildLogs / SortOrder
    │   └── sandboxlogs_test.go
    └── utils/             # 工具函数
        ├── sandbox.go     # GetSandboxStartEndTime
        ├── step.go        # CalculateStep
        └── validate.go    # ValidateRange
```

> ⓘ `switcher.go` 在本节之前的版本里漏列了，但它在 2026.29 就已存在。

## 3. 客户端与连接管理

入口文件：`pkg/clickhouse.go`。

### 3.1 接口契约

```go
type SandboxQueriesProvider interface {
    QuerySandboxTimeRange(ctx, sandboxID, teamID) (start, end time.Time, err)
    QuerySandboxMetrics(ctx, sandboxID, teamID, start, end, step) ([]Metrics, error)
    QueryLatestMetrics(ctx, sandboxIDs []string, teamID) ([]Metrics, error)
}

type Clickhouse interface {
    SandboxQueriesProvider
    Close(ctx) error
    QueryTeamMetrics(ctx, teamID, start, end, step) ([]TeamMetrics, error)
    QueryMaxStartRateTeamMetrics(ctx, teamID, start, end, step) (MaxTeamMetric, error)
    QueryMaxConcurrentTeamMetrics(ctx, teamID, start, end) (MaxTeamMetric, error)
}
```

- 业务层（API handlers）只面向 `Clickhouse` 接口编程，方便测试时注入 `NoopClient`。
- `SandboxQueriesProvider` 单独抽出，让 `utils.GetSandboxStartEndTime` 等辅助函数可以接受只关心沙箱查询的子集。

### 3.2 连接池

```go
func NewDriver(connectionString string) (driver.Conn, error) {
    options, _ := clickhouse.ParseDSN(connectionString)
    options.MaxOpenConns = 10
    options.MaxIdleConns = 3
    conn, _ := clickhouse.Open(options)
    return conn, nil
}
```

- 显式 `MaxOpenConns=10 / MaxIdleConns=3`：限制并发访问 ClickHouse 的连接数，避免被瞬时高并发压垮。
- **不启用 TLS**（`options.TLS = nil`），生产环境依赖 GCP/AWS VPC 内部网络做安全隔离。
- `EndpointFromDSN` 把 DSN 解析为 `host:port`，**剥离凭据**后供日志/指标 label 使用——这是审计上的硬要求，因为 `clickhouse-go` 的 `url.Error` 会把原始 DSN（包含密码）原样带出。

### 3.3 Noop 实现

`pkg/mock.go` 的 `NoopClient` 实现 `Clickhouse` 接口所有方法并返回零值。CLI/单元测试场景可注入它关闭对 ClickHouse 的所有调用。

## 4. 通用泛型批量器 `batcher.Batcher[T]`

文件：`pkg/batcher/batcher.go`。这是整个包最核心的写入基础设施，被 `events` 和 `hoststats` 共享复用。

### 4.1 数据结构

```go
type Batcher[T any] struct {
    Func         BatcherFunc[T]                 // 真正落库的回调
    MaxBatchSize int                            // 单批最大条数
    MaxDelay     time.Duration                  // 首批入队到 flush 的最长时间
    QueueSize    int                            // 缓冲 channel 容量
    ErrorHandler func(error)                    // 回调失败时的处理
    mu           sync.RWMutex
    ch           chan T
    doneCh       chan struct{}
    started      bool
    attrs        metric.MeasurementOption       // 用于 OTel 指标上的 batcher name 标签
}
```

### 4.2 触发模型

- **Size 触发**：累计到 `MaxBatchSize` 立即 `flush`。
- **Time 触发**：`processBatches` 内部有 `time.Ticker(MaxDelay)`，每到点把当前累积批 flush 掉。
- **生命周期触发**：`Stop()` 关闭 `ch` channel，循环读到 `!ok` 后做最后一次 `flush`，保证不丢数据。

`Push(item)` 是 **非阻塞的**：通过 `select default` 在 channel 满时直接返回 `ErrBatcherQueueFull`，不会因为 ClickHouse 暂时慢而拖垮调用方——上层可以根据错误决定丢弃、降级或重试（`events.delivery` 和 `hoststats.delivery` 都是只记录日志，不重试）。

### 4.3 默认参数与遥测

```go
const (
    defaultQueueSize    = 8 * 1024
    defaultMaxBatchSize = 64 * 1024
    defaultMaxDelay     = 100 * time.Millisecond
)
```

包级 OTel 指标（`pkg/batcher/batcher.go:30-37`）：

| 指标 | 类型 | 单位 | 含义 |
| --- | --- | --- | --- |
| `batcher.items.dropped` | Counter | `{item}` | 队列满时被丢弃的条数 |
| `batcher.queue.length` | Gauge | `{item}` | 当前队列长度 |
| `batcher.flush.batch_size` | Histogram | `{item}` | 每次 flush 的批大小 |
| `batcher.flush.wait_duration` | Histogram | `ms` | 从首批入队到 flush 的等待时间 |
| `batcher.flush.duration` | Histogram | `ms` | `BatcherFunc` 自身执行耗时 |

所有指标都带 `batcher=<name>` 属性（如 `sandbox-events`、`sandbox-host-stats`），便于在 Grafana 区分不同业务流的吞吐。

### 4.4 关键设计

- **`sync.RWMutex` 保护 `started` 状态**：`Push` 用读锁并发安全；`Start`/`Stop` 用写锁。
- **`Start/Stop` 不可重入**：`ErrBatcherAlreadyStarted` / `ErrBatcherNotStarted` 显式校验。
- **测试覆盖完整**：`batcher_test.go` 覆盖 `Start/Stop/Push` 的所有状态机边界、并发 push、最大批、最大延迟、队列满、Push/Stop 顺序等 11 个用例。

## 5. 事件投递：`events.ClickhouseDelivery`

文件：`pkg/events/{event.go, delivery.go}`。

### 5.1 数据模型

```go
type SandboxEvent struct {
    ID        uuid.UUID  // 2025-10 迁移后新增，自动 generateUUIDv4
    Version   string     // "v1" → "v2" (2025-10 迁移脚本改写)
    Type      string     // e.g. "sandbox.lifecycle.created"
    Timestamp time.Time

    EventData          sql.NullString
    SandboxID          string
    SandboxExecutionID string
    SandboxTemplateID  string
    SandboxBuildID     string
    SandboxTeamID      uuid.UUID
}
```

### 5.2 构造与配置

```go
func NewDefaultClickhouseSandboxEventsDelivery(ctx, conn, featureFlags, batcherName) (*ClickhouseDelivery, error) {
    maxBatchSize   := featureFlags.IntFlag(ctx, ClickhouseBatcherMaxBatchSize)
    maxDelay       := time.Duration(featureFlags.IntFlag(ctx, ClickhouseBatcherMaxDelay)) * time.Millisecond
    batcherQueueSize := featureFlags.IntFlag(ctx, ClickhouseBatcherQueueSize)
    ...
}
```

- **通过 LaunchDarkly 调参**：生产/预发环境的 `MaxBatchSize`、`MaxDelay`、`QueueSize` 都不写死，而是走 `featureflags` 动态下发，方便灰度/回滚。
- `batcherName` 作为 OTel `batcher` 属性传入。

**2026.30 变动**：`clickhouse-batcher-max-batch-size` 的默认值从 **100 改为 1000**（[`flags.go:439`](../packages/shared/pkg/featureflags/flags.go)；2026.29 在 `flags.go:286`）。相关 flag：

| Flag | 2026.29 默认 | 2026.30 默认 |
| --- | --- | --- |
| `clickhouse-batcher-max-batch-size` | 100 | **1000** |
| `max-cache-writer-concurrency` | 10 | 10（未变，[`flags.go:472`](../packages/shared/pkg/featureflags/flags.go)） |
| `clickhouse-write-fanout` | false | false（未变，[`flags.go:859`](../packages/shared/pkg/featureflags/flags.go)） |

> ⚠️ 注意区分两个 `defaultMaxBatchSize`：`batcher.go:18` 的 `defaultMaxBatchSize = 64 * 1024` 是**代码兜底值**（只在 flag 返回 0/负数时才用），而 LD flag 的默认是 1000。正常部署走的是 flag 值，不是 64K。


### 5.3 Publish 路径

```
Publish(ctx, _, event events.SandboxEvent)
  └─ json.Marshal(event.EventData) → sql.NullString
  └─ batcher.Push(SandboxEvent{...})
        └─ processBatches 内部累积
              └─ batchInserter(ctx, []SandboxEvent)
                    └─ tracer.Start("Flush sandbox events batch to Clickhouse")
                    └─ conn.PrepareBatch(ctx, "INSERT INTO sandbox_events (...) VALUES (?,?,?,...)", driver.WithReleaseConnection())
                    └─ batch.Append(...) × len(events)
                    └─ batch.Send()
```

要点：
- **`WithReleaseConnection`**：批量插入完成后立刻把连接归还连接池，避免长事务占用。
- **OTel span 包住整次 flush**：失败时 `RecordError` + `SetStatus(codes.Error)`，并在 span 上打 `batch.size` 属性。
- `Close()` 调 `batcher.Stop()`，阻塞等待 `doneCh`，把队列里残留事件全部写完。

## 6. 主机统计投递：`hoststats.ClickhouseDelivery`

文件：`pkg/hoststats/{hoststats.go, delivery.go}`。与 events 几乎对称，但面向 cgroup 主机侧的资源采样。

### 6.1 数据模型

```go
type SandboxHostStat struct {
    Timestamp          time.Time
    SandboxID          string
    SandboxExecutionID string
    SandboxTemplateID  string
    SandboxBuildID     string
    SandboxTeamID      uuid.UUID
    SandboxVCPUCount   int64
    SandboxMemoryMB    int64

    // cgroup v2 累计计数
    CgroupCPUUsageUsec  uint64
    CgroupCPUUserUsec   uint64
    CgroupCPUSystemUsec uint64
    CgroupMemoryUsage   uint64
    CgroupMemoryPeak    uint64

    // 两次采样间的预计算 delta
    DeltaCgroupCPUUsageUsec  uint64
    DeltaCgroupCPUUserUsec   uint64
    DeltaCgroupCPUSystemUsec uint64
    IntervalUs               uint64

    SandboxType string  // "sandbox" | "build"
}
```

### 6.2 Delivery 抽象

`hoststats.go` 在包内定义了**面向 orchestrator 的小接口**：

```go
type Delivery interface {
    Push(stat SandboxHostStat) error
    Close(ctx context.Context) error
}
```

并提供三种实现：

- **`noopDelivery`**：CLI 工具/测试场景丢弃所有统计。
- **`ClickhouseDelivery`**：批量写入 `sandbox_host_stats_local`。
- **`multiDelivery`**：扇出到多个 target；`Push` 串行（每个 `Push` 都是非阻塞的 batcher send），`Close` 并发（用 `sync.WaitGroup`，避免一个 target 卡住拖累其他）。

这层抽象让 orchestrator 通过 `hoststats.NewDelivery(...)` 拿到一个 `Delivery` 接口，**不直接依赖 `ClickhouseDelivery`**，方便无 ClickHouse 的环境（如本地 debug）走 noop。

### 6.3 写入流程

与 events 完全一致：

```
Push(stat) → batcher.Push → ... → batchInserter
  → conn.PrepareBatch("INSERT INTO sandbox_host_stats (...) VALUES (?,?,?,...)", WithReleaseConnection)
  → batch.Append × len(stats)
  → batch.Send
```

OTel span 名：`Flush host stats batch to Clickhouse`。

## 7. 查询接口

### 7.1 沙箱级查询（`pkg/sandbox.go`）

返回结构：

```go
type Metrics struct {
    SandboxID, TeamID string
    Timestamp         time.Time
    CPUCount, CPUUsedPercent float64
    MemTotal, MemUsed, MemCache float64
    DiskTotal, DiskUsed float64
}
```

#### 7.1.1 `QueryLatestMetrics(sandboxIDs, teamID)`

```sql
SELECT sandbox_id, team_id,
       argMaxIf(value, timestamp, metric_name = 'sandbox.cpu.total')   AS cpu_total,
       argMaxIf(value, timestamp, metric_name = 'sandbox.cpu.used')    AS cpu_used,
       ... (ram_total/ram_used/ram_cache/disk_total/disk_used)
FROM sandbox_metrics_gauge
WHERE sandbox_id IN ? AND team_id = ?
GROUP BY sandbox_id, team_id;
```

- 数据源是 **长表**（每行一个 metric_name + value），用 `argMaxIf` 在 ClickHouse 端做 **列转置**：
  - `argMax(value, timestamp, filter)` 返回该 sandbox 最新一条满足 filter 的 metric 值。
  - 由于所有 metric 在同一次采样中产生，`max(timestamp)` 即是整组采样的时间。
- 这种写法避免应用层 N+1 次查询或二次聚合。

#### 7.1.2 `QuerySandboxTimeRange(sandboxID, teamID)`

```sql
SELECT min(timestamp) AS start_time, max(timestamp) AS end_time
FROM sandbox_metrics_gauge
WHERE sandbox_id = {sandbox_id:String} AND team_id = {team_id:String};
```

用于在 API 入参缺一端时间时回查沙箱真实存续区间（被 `utils.GetSandboxStartEndTime` 调用）。

#### 7.1.3 `QuerySandboxMetrics(sandboxID, teamID, start, end, step)`

```sql
SELECT toStartOfInterval(timestamp, interval {step} second) AS ts,
       maxIf(value, metric_name = 'sandbox.cpu.total') AS cpu_total,
       ... (其他 6 个 metric)
FROM sandbox_metrics_gauge
WHERE sandbox_id = ? AND team_id = ?
  AND timestamp BETWEEN ? AND ?
GROUP BY ts
ORDER BY ts;
```

- `toStartOfInterval` 把原始采样按 `step` 桶化。
- 步长由 API 层通过 `utils.CalculateStep(start, end)` 计算（见 §8.2），目标点数 < 1000。

### 7.2 团队级查询（`pkg/team.go`）

```go
type TeamMetrics struct {
    Timestamp           time.Time
    SandboxStartedRate  float64  // 每秒沙箱创建速率
    ConcurrentSandboxes int64    // 并发沙箱数
}
type MaxTeamMetric struct {
    Timestamp time.Time
    Value     float64
}
```

#### 7.2.1 `QueryTeamMetrics`（速率+并发时间序列）

用 **CTE 拼表**：

```sql
WITH
  created AS (
    SELECT toStartOfInterval(timestamp, interval {step} second) AS ts,
           sum(value) AS created_sandboxes
    FROM team_metrics_sum
    WHERE metric_name = 'e2b.team.sandbox.created'  -- 创建计数
    GROUP BY ts
  ),
  concurrent AS (
    SELECT toStartOfInterval(timestamp, interval {step} second) AS ts,
           toInt64(max(value)) AS concurrent_sandboxes
    FROM team_metrics_gauge
    WHERE metric_name = 'e2b.team.sandbox.running'    -- 并发 gauge
    GROUP BY ts
  ),
  all_ts AS (SELECT ts FROM created UNION DISTINCT SELECT ts FROM concurrent)
SELECT all_ts.ts,
       COALESCE(created_sandboxes / {step}::Float32, 0.0) AS started_sandboxes_rate,
       COALESCE(concurrent_sandboxes, 0)                 AS concurrent_sandboxes
FROM all_ts
LEFT JOIN created cr    ON cr.ts = all_ts.ts
LEFT JOIN concurrent con ON con.ts = all_ts.ts
ORDER BY all_ts.ts ASC;
```

关键技巧：
- `team_metrics_sum` 是 **counter（累计求和）**，对应 `e2b.team.sandbox.created`；除以 `step` 得到 **速率**。
- `team_metrics_gauge` 是 **gauge（瞬时值）**，对应 `e2b.team.sandbox.running`；直接 `max` 取桶内最新值。
- `UNION DISTINCT` + 双 `LEFT JOIN` 让两条来源对齐到同一时间轴，缺数据的桶 `COALESCE` 成 0。

#### 7.2.2 `QueryMaxStartRateTeamMetrics`（峰值创建速率）

```sql
WITH aggregated AS (
  SELECT toStartOfInterval(timestamp, interval {step} second) AS agg_ts,
         sum(value) AS agg_value
  FROM team_metrics_sum
  WHERE metric_name = 'e2b.team.sandbox.created'
  GROUP BY agg_ts
)
SELECT argMax(agg_ts, agg_value) AS ts,
       max(agg_value) / {step}::Float32 AS max_value
FROM aggregated;
```

- 桶内求和 → 桶间取最大 → `argMax(ts, value)` 找回最大值对应的时间戳。

#### 7.2.3 `QueryMaxConcurrentTeamMetrics`（峰值并发）

```sql
SELECT argMax(timestamp, value) AS ts, max(value) AS max_value
FROM team_metrics_gauge
WHERE metric_name = 'e2b.team.sandbox.running'
  AND team_id = ? AND timestamp BETWEEN ? AND ?;
```

直接 `argMax + max` 在原始表上拿最大 gauge 与时间戳。

### 7.3 日志查询（`pkg/sandboxlogs/`，2026.30 新增）

文件：[`packages/clickhouse/pkg/sandboxlogs/sandboxlogs.go`](../packages/clickhouse/pkg/sandboxlogs/sandboxlogs.go)。这是**读 `sandbox_logs` 表**的最小 reader，与 §7.1/§7.2 的 metrics 查询彼此独立。

```go
type SortOrder int

const (
    SortOrderForward  SortOrder = iota
    SortOrderBackward
)

type Reader struct{ conn driver.Conn }

func NewReader(conn driver.Conn) *Reader
func (r *Reader) Close(_ context.Context) error

func (r *Reader) QuerySandboxLogs(ctx, teamID uuid.UUID, sandboxID string, start, end time.Time,
    limit int, order SortOrder, level *logs.LogLevel, search *string) ([]logs.LogEntry, error)

func (r *Reader) QueryBuildLogs(ctx, templateID, buildID string, start, end time.Time,
    limit int, offset int32, level *logs.LogLevel, order SortOrder) ([]logs.LogEntry, error)
```

两者共用同一段 `sandboxLogsSelect`（`SELECT timestamp, team_id, sandbox_id, template_id, build_id, service, category, level, message, raw, fields FROM sandbox_logs`），只在 WHERE / ORDER BY / LIMIT 上分叉：

| | `QuerySandboxLogs` | `QueryBuildLogs` |
| --- | --- | --- |
| 过滤 | `team_id = ?`、`sandbox_id = ?`、`timestamp BETWEEN ? AND ?`、`category != 'metrics'` | `build_id = ?`、`template_id = ?`、`timestamp BETWEEN ? AND ?`、`service = 'template-manager'` |
| `level` | 可选，`level IN {levels:Array(String)}` | 同左 |
| 文本搜索 | 可选，`position(message, ?) > 0` | ⛔ 不支持 |
| 分页 | `LIMIT <limit>` | `LIMIT <offset>, <limit>` |

三个设计要点：

1. **级别过滤对齐 Loki 语义**。`atLeastLevels(minLevel)` 把「最低级别」展开成允许的 level 字符串集合，与 [`packages/shared/pkg/logs/loki/provider.go`](../packages/shared/pkg/logs/loki/provider.go) 的 regex 语义一致：

   | 最低级别 | 允许的存储值 |
   | --- | --- |
   | `error` | `error` |
   | `warn` | `warn`, `error` |
   | `info` | `""`, `info`, `warn`, `error` |
   | `debug`（默认分支） | `""`, `debug`, `info`, `warn`, `error` |

2. **文本搜索是 literal substring，不是 regex**。用 `position(message, ?) > 0` 而不是 `match()`——与 Loki 侧用 `regexp.QuoteMeta` 转义用户输入的做法保持同样的安全语义。这张表的 `idx_message_ngram`（`ngrambf_v1(4, 8192, 3, 0)`）就是为这个谓词建的；迁移注释明确说 `tokenbf_v1` 只支持整 token 的 `hasToken`，**对 substring 谓词没有帮助**。

3. **`Fields` 是 JSON 编码的 `map[string]string`**。unmarshal 失败时不返回错误：记一条 warning（`failed to parse sandbox log fields`，带 `sandbox_id` / `timestamp`），退化成空 map，并**保留 `Raw`**。所以行不会因为一个坏 JSON 字段整条丢掉。

## 8. 工具函数（`pkg/utils/`）

### 8.1 `ValidateRange(start, end)`

```go
if start.After(MaxDate64) { return err }
if end.After(MaxDate64)   { return err }
if start.After(end)        { return err }
```

- `MaxDate64` = `2299-12-31 23:59:59.999999999 UTC`（ClickHouse DateTime64 可表示的最大值），防止 API 入参填了离谱的未来时间。
- 是 API handler 在调用 clickhouse 之前的 **第一道闸门**。

### 8.2 `CalculateStep(start, end)`

按区间长度选择步长，确保返回点数 ≤ 1000：

| 区间 | 步长 |
| --- | --- |
| < 1h | 5s |
| < 6h | 30s |
| < 12h | 1m |
| < 24h | 2m |
| < 7d | 5m |
| ≥ 7d | 15m |

### 8.3 `GetSandboxStartEndTime(ctx, store, teamID, sandboxID, qStart, qEnd)`

API 入参可能只给 `qStart` 或 `qEnd`；缺一端就回查 ClickHouse：

```go
if start.IsZero() || end.IsZero() {
    sbxStart, sbxEnd, _ := store.QuerySandboxTimeRange(...)
    if start.IsZero() { start = sbxStart }
    if end.IsZero()   { end   = sbxEnd   }
}
```

最后再调 `ValidateRange` 做最终校验（调用方负责）。

## 9. 数据模型与表结构

ClickHouse 的所有业务表都遵循 **local + Distributed 双层** 模式：

```
客户端写 ──> <table>            (Distributed 引擎, 路由)
                │
                ▼ xxHash64(<shard_key>) 选 shard
                │
       <table>_local   (MergeTree 引擎, 落盘)
```

| 表 | 引擎 | 排序键 (ORDER BY) | 分区 (PARTITION BY) | TTL | shard key |
| --- | --- | --- | --- | --- | --- |
| `metrics_gauge_local` | MergeTree | `(ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))` | `toDate(TimeUnix)` | 7d | — |
| `sandbox_metrics_gauge_local` | MergeTree | `(sandbox_id, metric_name, toUnixTimestamp64Nano(timestamp))` | `toDate(timestamp)` | 7d | `xxHash64(sandbox_id)` |
| `team_metrics_gauge_local` | MergeTree | `(team_id, metric_name, toUnixTimestamp64Nano(timestamp))` | `toDate(timestamp)` | 30d | `xxHash64(team_id)` |
| `team_metrics_sum_local` | MergeTree | `(team_id, metric_name, toUnixTimestamp64Nano(timestamp))` | `toDate(timestamp)` | 30d | `xxHash64(team_id)` |
| `sandbox_events_local` | MergeTree | `(sandbox_id, timestamp)` | `toDate(timestamp)` | 7d | `xxHash64(sandbox_id)` |
| `sandbox_host_stats_local` | MergeTree | `(sandbox_id, timestamp)` | `toDate(timestamp)` | 7d | `xxHash64(sandbox_id)` |
| `webhook_deliveries_local` | MergeTree | `(team_id, webhook_id, timestamp, id)` | `toDate(timestamp)` | 7d | `xxHash64(team_id)` |
| `sandbox_logs_local`（2026.30 新增） | MergeTree | `(team_id, sandbox_id, timestamp)` | `toDate(ingested_at)` | 7d | `xxHash64(team_id)` |
| `sandbox_egress_local`（2026.30 新增） | MergeTree | `(team_id, sandbox_id, destination_ip, destination_port, last_seen)` | `toDate(ingested_at)` | 7d | `xxHash64(sandbox_id)` |

> ⚠️ 新加的两张表**分区与 TTL 都键在 `ingested_at`（服务端时钟）而不是事件时间**。原因见 §9.6。

### 9.1 OTel 入口：metrics_gauge / metrics_sum

- `metrics_gauge_local` / `metrics_sum` 是 **OTel collector 直接落地的标准 schema**（带 `ResourceAttributes`、`ScopeName`、`Exemplars` 等列）。
- `metrics_gauge` 没有 `ENGINE = Distributed`，它**就是 collector 写入的本地表**；其他表用 `MATERIALIZED VIEW ... FROM metrics_gauge` 抽取自己关心的子集。

### 9.2 Materialized View 路由

`team_metrics_gauge_mv`（节选自 `20250801113224_team_metrics.sql`）：

```sql
CREATE MATERIALIZED VIEW team_metrics_gauge_mv
TO team_metrics_gauge AS SELECT
    toDateTime64(TimeUnix, 9) AS timestamp,
    Attributes['team_id'] AS team_id,
    MetricName AS metric_name,
    Value AS value
FROM metrics_gauge
WHERE MetricName LIKE 'e2b.team.%';
```

`sandbox_metrics_gauge_mv` 同理，从 `metrics_gauge` 抽 `Attributes['sandbox_id'] IS NOT NULL` 的行。

> 业务方只需把 OTel metrics 写到 ClickHouse，**subscribing-style 的订阅通过 MV 自动分流**，业务包完全不知道下游表的存在。

### 9.3 索引与投影

- `metrics_gauge_local` 用 `bloom_filter(0.01)` 索引 `mapKeys/mapValues` 提升 OTel Attributes 多键查找性能。
- 2026-04 迁移 `20260413080000_add_sandbox_events_team_projection.sql`：
  ```sql
  ALTER TABLE sandbox_events_local
      ADD PROJECTION IF NOT EXISTS proj_team_id (SELECT * ORDER BY sandbox_team_id, timestamp);
  ALTER TABLE sandbox_events_local MATERIALIZE PROJECTION proj_team_id;
  ALTER TABLE sandbox_events_local DROP INDEX IF EXISTS idx_team_id;
  ```
  因为基础 ORDER BY 是 `(sandbox_id, timestamp)`，按 `team_id` 查会全扫；加 projection 让 ClickHouse 知道还有一份按 `team_id` 排序的物理视图，可自动选用。临时方案——后续会把基础 ORDER BY 改成 `(team_id, timestamp, sandbox_id)` 后再删除 projection。

### 9.4 TTL 与 `ttl_only_drop_parts`

2026-04 迁移统一开启 `ttl_only_drop_parts = 1`：

```sql
ALTER TABLE sandbox_metrics_gauge_local MODIFY SETTING ttl_only_drop_parts = 1;
... (其他 4 张表)
```

- 因为所有表都 `PARTITION BY toDate(timestamp)`，TTL 边界（天）正好和分区边界对齐。
- 开启后，TTL 过期时 ClickHouse **直接 drop 整个 part**，不重写——大幅降低后台合并压力。

> ⚠️ **2026.30 起这条规则有两个例外**：`sandbox_logs` 与 `sandbox_egress` 的分区与 TTL 都键在 **`ingested_at`（服务端时钟）** 而不是 `timestamp` / `last_seen`（节点时钟）。原因是节点时钟偏斜会写出一个**永不过期的分区**。详见 §9.6。

### 9.5 v1 → v2 事件迁移

`20251017213618_migrate_sandbox_events.sql` 把旧 `event_category='lifecycle' + event_label='create' + version='v1'` 的记录一次性 `ALTER TABLE ... UPDATE` 成 `version='v2' + type='sandbox.lifecycle.created'`，配合 `20251017213615_sandbox_events.sql`（新增 `type`/`version` 列）和 `20251017213616_sandbox_events_id.sql`（新增 `id UUID DEFAULT generateUUIDv4()`）完成 v1→v2 升级。

### 9.6 2026.30 新增的两张表

#### 9.6.1 `sandbox_logs`（迁移 `20260702181515_add_sandbox_logs.sql`）

```sql
CREATE TABLE sandbox_logs_local (
    timestamp DateTime64(9) CODEC (Delta, ZSTD(1)),
    ingested_at DateTime64(9) DEFAULT now64(9) CODEC (Delta, ZSTD(1)),
    team_id UUID CODEC (ZSTD(1)),
    sandbox_id String CODEC (ZSTD(1)),
    template_id String CODEC (ZSTD(1)),
    build_id String CODEC (ZSTD(1)),
    service LowCardinality(String) CODEC (ZSTD(1)),
    category LowCardinality(String) CODEC (ZSTD(1)),
    level LowCardinality(String) CODEC (ZSTD(1)),
    message String CODEC (ZSTD(1)),
    raw String CODEC (ZSTD(1)),
    fields String CODEC (ZSTD(1)),
    INDEX idx_build_id build_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_message_ngram message TYPE ngrambf_v1(4, 8192, 3, 0) GRANULARITY 4
) ENGINE = MergeTree
    PARTITION BY toDate(ingested_at)
    ORDER BY (team_id, sandbox_id, timestamp)
    TTL toDateTime(ingested_at) + INTERVAL 7 DAY
    SETTINGS ttl_only_drop_parts = 1;

CREATE TABLE sandbox_logs AS sandbox_logs_local
    ENGINE = Distributed('cluster', currentDatabase(), 'sandbox_logs_local', xxHash64(team_id));
```

要点：

- 排序键 `(team_id, sandbox_id, timestamp)`——**查询入口按 team + sandbox**，与 `sandbox_events_local` 的 `(sandbox_id, timestamp)` 不同。
- **按 `team_id` 分片**，不是 sandbox。理由是日志的读取入口总是「某个 team 的某个 sandbox」。
- 分区/TTL 用 `ingested_at`（服务端）而非 `timestamp`（节点）：和 §9.6.2 同一个理由——**节点时钟偏斜会写进一个永不过期的分区**。
- `idx_message_ngram` 用 `ngrambf_v1`，专门服务 §7.3 的 `position(message, ?) > 0` 子串谓词；迁移注释明确说 `tokenbf_v1` 只支持整 token 的 `hasToken`，对子串谓词无效。

#### 9.6.2 `sandbox_egress`（迁移 `20260818120000_add_sandbox_egress.sql`）

记录 sandbox 出站连接的**目的地址与防火墙裁决**。完整列清单：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `first_seen` | `DateTime64(9)` | 首次看到（**节点时钟**） |
| `last_seen` | `DateTime64(9)` | 最后一次看到（**节点时钟**） |
| `ingested_at` | `DateTime64(9) DEFAULT now64(9)` | **服务端**赋值 |
| `team_id` | `UUID` | |
| `sandbox_id` | `String` | |
| `sandbox_execution_id` | `String` | |
| `sandbox_template_id` | `String` | |
| `sandbox_build_id` | `String` | |
| `sandbox_type` | `LowCardinality(String)` | |
| `protocol` | `LowCardinality(String)` | |
| `destination_ip` | **`String`** | 见下 ⚠️ |
| `destination_port` | `UInt16` | |
| `server_name` | `Nullable(String)` | |
| `decision` | `LowCardinality(String)` | |
| `match_type` | `LowCardinality(String)` | |
| `connections` | `UInt64` | 预聚合的连接数 |

```sql
ENGINE = MergeTree
PARTITION BY toDate(ingested_at)
ORDER BY (team_id, sandbox_id, destination_ip, destination_port, last_seen)
TTL toDateTime(ingested_at) + INTERVAL 7 DAY
SETTINGS ttl_only_drop_parts = 1

CREATE TABLE sandbox_egress AS sandbox_egress_local
    ENGINE = Distributed('cluster', currentDatabase(), 'sandbox_egress_local', xxHash64(sandbox_id));
```

三个反直觉点（都来自迁移里的原文注释）：

**(a) ⚠️ `destination_ip` 故意用 `String` 而不是 `IPv6`**

> the IPv6 type stores a v4 address as `::ffff:a.b.c.d`, for which `isIPAddressInRange` answers false against a v4 CIDR. On a String it answers directly.

ClickHouse 的 `IPv6` 类型把 v4 地址存成 v4-mapped 形式，拿它和 v4 CIDR 做 `isIPAddressInRange` 会**返回 false**，策略匹配静默失效。用 `String` 存原始文本可以直接匹配。**不要把它「修正」成 IPv6。**

**(b) 分区/TTL 用 `ingested_at`**

> a node with a skewed clock would otherwise write a partition that never expires

**(c) 一行是「裁决」，不是「完成的连接」**

行在防火墙**放行/拒绝**时写入，**早于 upstream dial**（dial 仍可能失败）；行是**按 flush 间隔预聚合**的，全量历史必须 `sum(connections)`，不是 `count(*)`。

索引：`idx_destination_ip`、`idx_server_name`、`idx_sandbox_id`，均 `bloom_filter GRANULARITY 4`。注释解释了为什么需要它们：排序键以 team 打头，所以「从目的地出发」或「不知道 team、只知道 sandbox」的查询都会全扫。

**按 sandbox 分片而不是按 team**，和邻居表相反：

> the workload that produces the most rows here is one team's sandboxes contacting many endpoints, and sharding on the team would land all of it on a single shard.

> ⚠️ **本仓库只有这张表的迁移，没有写入端**。`git grep sandbox_egress` 在仓库内只命中迁移文件；写入实现应在闭源/企业版组件里。仓库内唯一相关的改动是 `packages/orchestrator/pkg/factories/run.go` 把 ClickHouse endpoint 传给 `EgressFactory`（`Deps.ClickhouseEndpoints`，`run.go:89`，填充于 `:736`，传入于 `:739`）。

## 10. 迁移与运维

### 10.1 migrator 镜像

`Dockerfile` 用 `golang:1.26.3-alpine3.22` 构建 `goose v3.24.2`，运行时只把 `migrations/` 目录 COPY 进去，`ENTRYPOINT ["goose", "-table", "_migrations", "-dir", "migrations", "up"]`。

### 10.2 Makefile 目标

- `make build`：构建镜像并打 `latest` + git commit SHA 标签（与 `packages/api` 同模式）。
- `make build-and-upload`：构建并 push 到 ECR/Artifact Registry。
- `make migrate`：build + 在 e2b docker network 里跑 `clickhouse-migrator` 容器。
- `make migrate-local`：`go tool goose -dir migrations clickhouse up` 跑本地。
- `make run`：用 `local/config.tpl.xml` / `users.tpl.xml` 起一个 `clickhouse/clickhouse-server:25.4.5.24` 容器。
- `make connect-clickhouse`：`gcloud compute ssh` 端口转发到 9000。

## 11. 部署（IaC）—— 2026.30 起已从仓库退役

> ⛔ **本节描述的全部路径在 2026.30 已不存在**。提交 `8a1c48884` 把 `iac/`（172 个文件）整体删除,ClickHouse 的 Terraform/Nomad 部署栈（`iac/provider-gcp/`、`iac/provider-aws/`、`iac/modules/job-clickhouse/`）随之离开本仓库。下面保留 2026.29 的路径清单作为历史档案,**链接已不可点**;新的部署路径尚未落地。

### 11.1 GCP（2026.29 历史档案,⛔ 2026.30 已删除）

- `iac/provider-gcp/nomad-cluster/nodepool-clickhouse.tf`：`google_compute_instance_group_manager.clickhouse_pool` + `google_compute_instance_template.clickhouse` + `google_compute_stateful_disk`（持久化 ClickHouse 数据）+ `google_compute_health_check` + `per_instance_config`。
- `iac/provider-gcp/nomad-cluster/scripts/start-clickhouse.sh`：节点上启动脚本。
- `iac/provider-gcp/api.tf`：`random_password.clickhouse_password` / `clickhouse_server_secret`。
- `iac/provider-gcp/init/buckets.tf`：`google_storage_bucket.clickhouse_backups_bucket`（备份到 GCS）。
- `iac/modules/job-clickhouse/`：4 个 Nomad job —— `clickhouse.hcl`（主服务）、`clickhouse-migrator.hcl`（执行 SQL 迁移）、`clickhouse-backup.hcl` / `clickhouse-backup-restore.hcl`。
- `iac/modules/job-clickhouse/configs/`：`config.xml` / `users.xml` / `otel-agent.yaml`（otel collector 侧）。

### 11.2 AWS（2026.29 历史档案,⛔ 2026.30 已删除）

- `iac/provider-aws/modules/nodepool-clickhouse/`：EC2 + EBS + IAM（`clickhouse_node_policy`）+ launch template。
- `iac/provider-aws/init/`：`aws_s3_bucket.clickhouse_backups` + `aws_ecr_repository.clickhouse_migrator` + `aws_secretsmanager_secret.clickhouse`（含随机密码 + 初始版本 SecretVersion）。
- `iac/provider-aws/nomad-cluster/main.tf`：`module.clickhouse` + `data.aws_s3_bucket.clickhouse_bucket`。

### 11.3 2026.30 之后还剩什么

| 能力 | 2026.29 位置 | 2026.30 |
| --- | --- | --- |
| 建表迁移 | `packages/clickhouse/migrations/*.sql` + `Dockerfile` | ✅ 仍在仓库 |
| 迁移执行 | `make migrate` / `make migrate-local`（§10.2） | ✅ 仍在仓库 |
| 本地单机 ClickHouse | `local/config.tpl.xml` / `users.tpl.xml` + `make run` | ✅ 仍在仓库 |
| 集群/节点/备份 Terraform | `iac/provider-{gcp,aws}/...` | ⛔ 已删除 |
| Nomad job（含 migrator、backup） | `iac/modules/job-clickhouse/` | ⛔ 已删除 |
| 根目录 `self-host.md` 自托管指南 | `self-host.md` | ⛔ 已删除 |

## 12. 写入路径全景图

```
orchestrator/api
   │
   │ events.SandboxEvent
   ▼
events.Publish(ctx, _, event)                          hoststats.Push(stat)
   │                                                       │
   ▼                                                       ▼
json.Marshal(EventData)                             batcher.Push(SandboxHostStat)
   │                                                       │
   ▼                                                       │
batcher.Push(SandboxEvent) ──┐                              │
                            ▼                              ▼
              ┌────────────── processBatches ──────────────┐
              │   size 触发 → flush   或                   │
              │   ticker(MaxDelay) 触发 → flush           │
              └────────────────────┬───────────────────────┘
                                   ▼
              conn.PrepareBatch(INSERT INTO ... VALUES (?,?,...))
                                   │
                                   ▼
                              batch.Send()
                                   │
                                   ▼
                ClickHouse Distributed ──xxHash64→ shard ── MergeTree
```

## 13. 设计要点与权衡

1. **异步批量优先于同步写入**。所有遥测都走 batcher，写入失败仅日志告警（`ErrorHandler` 默认 no-op），保证热路径不阻塞业务。
2. **OTel 风格落地 + MV 抽子集**。OTel collector 直接写标准 schema 的 `metrics_gauge`，业务表通过 Materialized View 抽取 `e2b.team.*` 或带 `sandbox_id` 的子集——数据生产与消费解耦。
3. **shard key 选择**。沙箱级表用 `xxHash64(sandbox_id)` 让单个沙箱的所有数据落同一 shard，避免跨节点 JOIN；团队级表用 `xxHash64(team_id)`。
4. **TTL 按天分区 + ttl_only_drop_parts**。所有表 `PARTITION BY toDate(timestamp)`，TTL 与分区对齐后可以整 part drop，省去后台重写。
5. **Long-table + 服务端 pivot**。沙箱指标用长表（每行一个 metric_name），查询时用 `argMaxIf`/`maxIf` 在 ClickHouse 端 pivot 成宽列，避免应用层二次处理。
6. **按 team_id 投影是临时方案**。projection 的存在让"按 team 查"高效，但需要维护一份冗余物理序；终极方案是把基础 ORDER BY 改成 `(team_id, timestamp, sandbox_id)`。
7. **凭据安全**。`EndpointFromDSN` 在日志/指标 label 中永远只暴露 `host:port`，杜绝密码泄露。
8. **接口边界清晰**。`Clickhouse` 是查询接口；`events.ClickhouseDelivery` 和 `hoststats.ClickhouseDelivery` 是写入实现；`hoststats.Delivery` 把"主机统计怎么投递"与"投递到 ClickHouse"解耦。
9. **batcher 泛型复用**。一个 `Batcher[T]` 同时给 events 和 hoststats 用，避免重复实现 channel+flush 状态机。
10. **LaunchDarkly 调参**。batcher 的 `MaxBatchSize`/`MaxDelay`/`QueueSize` 都是 feature flag，无需发版即可调优。

## 14. 关键文件速查表

| 主题 | 文件 | 作用 |
| --- | --- | --- |
| 客户端 | `packages/clickhouse/pkg/clickhouse.go` | `Client`、`Clickhouse` 接口、`NewDriver` |
| 批量器 | `packages/clickhouse/pkg/batcher/batcher.go` | `Batcher[T]` 泛型批处理 |
| 事件投递 | `packages/clickhouse/pkg/events/delivery.go` | `ClickhouseDelivery.Publish` + `batchInserter` |
| 事件模型 | `packages/clickhouse/pkg/events/event.go` | `SandboxEvent` |
| 主机投递 | `packages/clickhouse/pkg/hoststats/delivery.go` | `ClickhouseDelivery.Push` + `batchInserter` |
| 主机模型 | `packages/clickhouse/pkg/hoststats/hoststats.go` | `SandboxHostStat` + `Delivery` 接口 + noop/multi |
| 沙箱查询 | `packages/clickhouse/pkg/sandbox.go` | `QueryLatestMetrics` / `QuerySandboxTimeRange` / `QuerySandboxMetrics` |
| 团队查询 | `packages/clickhouse/pkg/team.go` | `QueryTeamMetrics` / `QueryMaxStartRateTeamMetrics` / `QueryMaxConcurrentTeamMetrics` |
| 工具 | `packages/clickhouse/pkg/utils/*.go` | `ValidateRange` / `CalculateStep` / `GetSandboxStartEndTime` |
| 日志查询（2026.30 新增） | `packages/clickhouse/pkg/sandboxlogs/sandboxlogs.go` | `Reader` / `QuerySandboxLogs` / `QueryBuildLogs`（见 §7.3） |
| Mock | `packages/clickhouse/pkg/mock.go` | `NoopClient` |
| 迁移 | `packages/clickhouse/migrations/*.sql` | 28 张 goose 迁移（2026.30；2026.29 为 26 张） |
| 新增迁移（2026.30） | `packages/clickhouse/migrations/20260702181515_add_sandbox_logs.sql` | `sandbox_logs_local` + `sandbox_logs`（见 §9.6.1） |
| 新增迁移（2026.30） | `packages/clickhouse/migrations/20260818120000_add_sandbox_egress.sql` | `sandbox_egress_local` + `sandbox_egress`（见 §9.6.2,⚠️ 无写入端） |
| 部署 | `iac/modules/job-clickhouse/`, `iac/provider-{gcp,aws}/...` | ⛔ 2026.30 已随 `iac/` 整体删除,见 §11 |
