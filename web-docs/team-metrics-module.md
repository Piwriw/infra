# E2B Metrics(team/sandbox 指标查询)模块详解

> 模块定位:4 个 metrics 查询端点,分两路数据源——team 级走 ClickHouse(历史时间序列),sandbox 级走 edge cluster(实时快照)。本文档解释两路数据流的差异、动态步长算法、以及为什么某些字段是 deprecated。
>
> **核心特征**:
> - 跨 2 个 OpenAPI tag:`auth`(team 级)+ `sandboxes`(sandbox 级)
> - team metrics 历史数据存 ClickHouse(`team_metrics_sum` / `team_metrics_gauge` 表)
> - sandbox metrics 实时数据由 edge/client-proxy 提供
> - 时间窗口默认 7 天,step 动态计算(6 档,确保 ≤1000 个数据点)
> - `timestamp` 字段 deprecated,统一用 `timestampUnix`(int64,Unix 秒)
> - sandbox_ids 批量查询硬上限 100
>
> 适用代码范围:
> - `packages/api/internal/handlers/team_metrics.go` — `GET /teams/{id}/metrics`
> - `packages/api/internal/handlers/team_metrics_max.go` — `GET /teams/{id}/metrics/max`
> - `packages/api/internal/handlers/sandbox_metrics.go` — `GET /sandboxes/{id}/metrics`
> - `packages/api/internal/handlers/sandboxes_list_metrics.go` — `GET /sandboxes/metrics`
> - `packages/clickhouse/pkg/team.go` — ClickHouse 查询实现
> - `packages/clickhouse/pkg/utils/step.go` — 动态步长算法
> - `packages/api/internal/clusters/resources_*.go` — sandbox metrics 转发层
> - `packages/api/internal/metrics/team.go` — `ExportPeriod` 定义(5s)

## 目录

- [一、概述](#一概述)
  - [1.1 metrics 是什么](#11-metrics-是什么)
  - [1.2 关键定位:两路数据源](#12-关键定位两路数据源)
  - [1.3 关键心智模型](#13-关键心智模型)
  - [1.4 整体架构](#14-整体架构)
- [二、核心概念](#二核心概念)
  - [2.1 team metrics vs sandbox metrics](#21-team-metrics-vs-sandbox-metrics)
  - [2.2 动态步长(CalculateStep)](#22-动态步长calculatestep)
  - [2.3 `timestamp` 字段为什么 deprecated](#23-timestamp-字段为什么-deprecated)
  - [2.4 ClickHouse 的 sum vs gauge 表](#24-clickhouse-的-sum-vs-gauge-表)
  - [2.5 ExportPeriod 5 秒的影响](#25-exportperiod-5-秒的影响)
- [三、整体架构](#三整体架构)
  - [3.1 装配序列](#31-装配序列)
  - [3.2 依赖图](#32-依赖图)
  - [3.3 数据流总览](#33-数据流总览)
- [四、4 个端点逐一解析](#四4-个端点逐一解析)
  - [4.1 GET /teams/{teamID}/metrics — team 时间序列](#41-get-teamsteamidmetrics--team-时间序列)
  - [4.2 GET /teams/{teamID}/metrics/max — team 峰值](#42-get-teamsteamidmetricsmax--team-峰值)
  - [4.3 GET /sandboxes/metrics — 批量 sandbox 实时指标](#43-get-sandboxesmetrics--批量-sandbox-实时指标)
  - [4.4 GET /sandboxes/{sandboxID}/metrics — 单 sandbox 时间序列](#44-get-sandboxessandboxidmetrics--单-sandbox-时间序列)
- [五、关键流程时序图](#五关键流程时序图)
  - [5.1 team metrics 查询(ClickHouse 路径)](#51-team-metrics-查询clickhouse-路径)
  - [5.2 sandbox metrics 查询(edge 转发路径)](#52-sandbox-metrics-查询edge-转发路径)
- [六、ClickHouse 查询深入](#六clickhouse-查询深入)
  - [6.1 QueryTeamMetrics 的 SQL 逻辑](#61-queryteammetrics-的-sql-逻辑)
  - [6.2 QueryMaxConcurrentTeamMetrics(argMax 算法)](#62-querymaxconcurrentteammetricsargmax-算法)
  - [6.3 QueryMaxStartRateTeamMetrics](#63-querymaxstartrateteammetrics)
- [七、数据模型](#七数据模型)
  - [7.1 ClickHouse 表结构](#71-clickhouse-表结构)
  - [7.2 团队 metrics 上报路径](#72-团队-metrics-上报路径)
- [八、动态步长算法详解](#八动态步长算法详解)
- [九、配置与 Feature Flag](#九配置与-feature-flag)
- [十、关键代码文件索引](#十关键代码文件索引)
- [十一、设计要点与权衡](#十一设计要点与权衡)
- [十二、常见问题与排查](#十二常见问题与排查)
- [附录 A:端点速查表](#附录-a端点速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录-b错误码与-http-状态映射)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

### 1.1 metrics 是什么

4 个端点跨两个 OpenAPI tag:

| 路径 | 方法 | tag | 数据源 | 功能 |
| --- | --- | --- | --- | --- |
| `/teams/{teamID}/metrics` | GET | `auth` | ClickHouse | team 级时间序列(concurrent sandboxes + start rate) |
| `/teams/{teamID}/metrics/max` | GET | `auth` | ClickHouse | team 级峰值(单 metric,单值) |
| `/sandboxes/metrics?sandbox_ids=...` | GET | `sandboxes` | edge cluster | 批量 sandbox 实时快照(CPU/Mem/Disk) |
| `/sandboxes/{sandboxID}/metrics` | GET | `sandboxes` | edge cluster | 单 sandbox 时间序列(CPU/Mem/Disk) |

**典型使用场景**:
- dashboard 展示"过去 7 天我的 team 用了多少 sandbox"(team 时间序列)
- 计费/容量规划:查"上周高峰期多少 sandbox 并发"(team 峰值)
- 监控某 sandbox 实时资源占用(sandbox metrics)
- 列出 team 当前所有运行中 sandbox 的资源情况(批量)

### 1.2 关键定位:两路数据源

```
                          ┌───────────────────┐
                          │   dashboard / SDK │
                          └─────────┬─────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  │                                   │
        GET /teams/{id}/metrics               GET /sandboxes/{id}/metrics
        GET /teams/{id}/metrics/max           GET /sandboxes/metrics
                  │                                   │
                  ▼                                   ▼
        ┌──────────────────┐              ┌──────────────────────┐
        │  ClickHouse      │              │  Cluster Resource    │
        │  team_metrics_*  │              │  Provider            │
        │                  │              │   ├ local: ClickHouse│
        │  (历史聚合,5s 粒度)│              │   └ remote: edge API │
        └──────────────────┘              └──────────────────────┘
                                            (实时,转发到 cluster)
```

**两路数据源的根本差异**:
- **team metrics**:OpenTelemetry meter 每 5 秒 export 一次到 ClickHouse。查询走聚合 SQL,数据有滞后(秒级)。
- **sandbox metrics**:由 edge cluster(client-proxy/orchestrator)直接采集,API 层只做转发。

### 1.3 关键心智模型

1. **team 和 sandbox 是两路数据源**,不要假设它们存在同一个地方。
2. **step 自动算**:`CalculateStep(range)` 根据时间窗口选 **6 档**步长,保证 ≤~1000 个数据点。
3. **`timestamp` 是 deprecated 字段**:RFC3339 字符串格式,有解析开销和时区歧义。**新代码用 `timestampUnix`**(int64 Unix 秒)。
4. **峰值不是简单的 max**:`argMax(ts, value)` 返回"峰值发生的时间戳",不是查询窗口的边界。
5. **sandbox_ids 上限 100**:防止 SQL `IN (...)` 列表过长和 edge 请求体过大。
6. **数据有 5 秒延迟**:OpenTelemetry export period 是 5 秒,所以"刚刚发生的"指标可能还没到 ClickHouse。
7. **空窗口返 0,不返 404**:即使 team 没有任何活动,峰值查询也返 `{value: 0, timestamp: now}`,而不是错误。

### 1.4 整体架构

```
                  ┌──────────────────────────────────┐
                  │  dashboard / SDK                 │
                  │                                  │
                  │  GET /teams/{id}/metrics         │
                  │  GET /teams/{id}/metrics/max     │
                  │  GET /sandboxes/metrics          │
                  │  GET /sandboxes/{id}/metrics     │
                  └──────────────┬───────────────────┘
                                 │
                                 │  Authorization + X-API-Key
                                 │  (或 OIDC + X-Team-Id)
                                 ▼
        ┌────────────────────────────────────────────────────┐
        │                API (Gin + oapi-codegen)            │
        │                                                  │
        │  鉴权(三选一):                                     │
        │   - ApiKeyAuth                                    │
        │   - AuthProviderBearerAuth + AuthProviderTeamAuth │
        │   - AdminApiKeyAuth + AdminTeamAuth               │
        │                                                  │
        │  handlers/                                        │
        │   ├── team_metrics.go                             │
        │   │   ├── 校验 path teamID == ctx teamID         │
        │   │   ├── 解析 start/end(default 7d)              │
        │   │   ├── ValidateRange                           │
        │   │   ├── CalculateStep                           │
        │   │   └── clickhouseStore.QueryTeamMetrics        │
        │   │                                               │
        │   ├── team_metrics_max.go                         │
        │   │   ├── (同上)                                  │
        │   │   └── 按 metric 查 argMax                     │
        │   │                                               │
        │   ├── sandbox_metrics.go + sandboxes_list_metrics│
        │   │   ├── ShortID 标准化                          │
        │   │   ├── clusters.WithClusterFallback            │
        │   │   ├── cluster.GetResources().GetSandboxMetrics│
        │   │   └── (转发到 edge API 或本地 ClickHouse)     │
        └────────────┬─────────────────────────┬───────────┘
                     │                         │
                     ▼                         ▼
        ┌────────────────────────┐   ┌─────────────────────┐
        │  ClickHouse            │   │  Cluster Pool       │
        │  (team_metrics_sum)    │   │  ├ local resource   │
        │  (team_metrics_gauge)  │   │  │  (查 ClickHouse) │
        │                        │   │  └ remote resource  │
        │  数据延迟 ~5s           │   │     (HTTP → edge)  │
        └────────────────────────┘   └─────────────────────┘
```

---

## 二、核心概念

### 2.1 team metrics vs sandbox metrics

| 维度 | team metrics | sandbox metrics |
| --- | --- | --- |
| 数据源 | ClickHouse | edge cluster(转发性) |
| 表/接口 | `team_metrics_sum` + `team_metrics_gauge` | edge API `/v1/sandbox/{id}/metrics` |
| 粒度 | 5 秒(export period) | 实时(秒级采集) |
| 历史窗口 | 默认 7 天,可任意指定 | 由 edge 决定(通常也 7 天) |
| 字段 | `concurrentSandboxes` + `sandboxStartRate` | CPU/Mem/Disk 使用率 |
| 用途 | 容量规划、计费、趋势分析 | 单 sandbox 监控、故障排查 |
| 聚合 | 服务端 SQL 聚合(`toStartOfInterval`) | 边缘聚合(由 edge 决定) |

### 2.2 动态步长(CalculateStep)

`packages/clickhouse/pkg/utils/step.go:7`:

```go
func CalculateStep(start, end time.Time) time.Duration {
    duration := end.Sub(start)
    switch {
    case duration < time.Hour:              return 5 * time.Second
    case duration < 6*time.Hour:            return 30 * time.Second
    case duration < 12*time.Hour:           return time.Minute
    case duration < 24*time.Hour:           return 2 * time.Minute
    case duration < 7*24*time.Hour:         return 5 * time.Minute
    default:                                return 15 * time.Minute
    }
}
```

**6 档步长对应数据点数**(上限约 720):
- <1h,step=5s → ≤720 点
- 1h-6h,step=30s → ≤720 点
- 6h-12h,step=60s → ≤720 点
- 12h-24h,step=120s → ≤720 点
- 24h-7d,step=300s → ≤2016 点 ⚠(略超 1000)
- >7d,step=900s → 取决于上限

**为什么约 1000 个点**?
- 太少 → 趋势丢失
- 太多 → 网络传输慢、前端渲染卡
- 1000 是 Grafana / Prometheus 等业界的事实标准

注意:5s 步长与 export period(5s)对齐——再小没意义,因为底层就是 5s 一个采样。

### 2.3 `timestamp` 字段为什么 deprecated

OpenAPI schema(`spec/openapi.yml:499-507`):

```yaml
SandboxMetric:
  properties:
    timestamp:
      type: string
      format: date-time
      deprecated: true              # ← 弃用
      description: Timestamp of the metric entry
    timestampUnix:
      type: integer
      format: int64
      description: Timestamp of the metric entry in Unix time (seconds since epoch)
```

**两个字段同时返回**,但 `timestamp` 是 RFC3339 字符串(`2026-07-12T02:30:00Z`),有三个问题:
1. **解析开销**:JSON 反序列化 + 字符串 parse 比 int64 慢一个数量级。
2. **时区歧义**:`+08:00` vs `Z` 不一致容易出 bug。
3. **排序需要再解析**:前端要按时间排序必须先转 time.Time。

**`timestampUnix`**(int64 Unix 秒)更紧凑、可直接比较。

历史包袱:早期只返回 `timestamp`,后来加 `timestampUnix`,**两者并存一段时间**为了客户端兼容。最终会下线 `timestamp`。

### 2.4 ClickHouse 的 sum vs gauge 表

OpenTelemetry metric 类型对应两张表:

| 表 | 类型 | 用途 | 例子 |
| --- | --- | --- | --- |
| `team_metrics_sum` | Counter / Sum | OTEL Counter 类型(配置为 DeltaTemporality,每行 = 该 5s 周期内的新增数) | 每 5s 新增的 sandbox 创建数 |
| `team_metrics_gauge` | Gauge | 瞬时值,可上下波动 | 当前 running sandbox 数 |

**关键差异**:
- `sum` 表的 `value` 是"该 5s export 周期内的新增数"——因为 `metrics/team.go:32-34` 配置了 `DeltaTemporality`(每次 export 只发送上次以来的增量,不是全局累计)。查询时用 `sum(value)` 把 step 桶内的多个 5s 增量加起来。
- `gauge` 表的 `value` 是"export 瞬间采样到的当前值"(ObservableGauge 在每次 collect 时回调 `TeamObserver.Start` 里的 callback 取值)——查询时用 `max(value)` 取每个时间窗口的最大值(避免 export 抖动)。

`QueryTeamMetrics` SQL 同时查两张表(`packages/clickhouse/pkg/team.go:20`):

```sql
WITH
  created AS (
    SELECT toStartOfInterval(timestamp, interval {step} second) AS ts,
           sum(value) as created_sandboxes         -- sum 表
    FROM team_metrics_sum
    WHERE metric_name = 'e2b.team.sandbox.created'
    GROUP BY ts
  ),
  concurrent AS (
    SELECT toStartOfInterval(timestamp, interval {step} second) AS ts,
           toInt64(max(value)) AS concurrent_sandboxes  -- gauge 表
    FROM team_metrics_gauge
    WHERE metric_name = 'e2b.team.sandbox.running'
    GROUP BY ts
  ),
  ...
```

### 2.5 ExportPeriod 5 秒的影响

`packages/api/internal/metrics/team.go:20`:

```go
const ExportPeriod = 5 * time.Second
```

OpenTelemetry SDK 把内存中的 metric 每 5 秒批量 export 到 ClickHouse(通过 OTEL collector)。

**对查询的影响**:
- **数据延迟约 5-10 秒**:刚发生的 sandbox 创建不会立刻出现在 metrics 里。
- **`CalculateStep` 的最小档是 5s**:再小没意义。
- **5s 内多次创建会累加进同一行**:DeltaTemporality 下 counter `Add(ctx, 1)` 累计到内存,下次 export 把这 5s 的增量一并发出——所以不会丢精度。
- **gauge 表可能丢失瞬时极值**:ObservableGauge 只在每次 collect 瞬间采样当前值,如果两次 collect 之间出现峰值又回落,那个峰值不会被记录。

---

## 三、整体架构

### 3.1 装配序列

```go
r.GET("/teams/:teamID/metrics",       middleware → apiStore.GetTeamsTeamIDMetrics)
r.GET("/teams/:teamID/metrics/max",   middleware → apiStore.GetTeamsTeamIDMetricsMax)
r.GET("/sandboxes/metrics",           middleware → apiStore.GetSandboxesMetrics)
r.GET("/sandboxes/:sandboxID/metrics",middleware → apiStore.GetSandboxesSandboxIDMetrics)
```

中间件链(所有 4 个端点共用):
1. `limits.RequestSizeLimiter`
2. `middleware.OapiRequestValidatorWithOptions` — schema + 鉴权

### 3.2 依赖图

```
APIStore
├── clickhouseStore (clickhouse.Clickhouse interface)
│   ├── QueryTeamMetrics
│   ├── QueryMaxConcurrentTeamMetrics
│   └── QueryMaxStartRateTeamMetrics
├── clusters (*clusters.Pool)
│   └── GetClusterById(clusterID)
│       └── GetResources() (ClusterResource)
│           ├── LocalClusterResourceProvider (查本地 ClickHouse)
│           └── ClusterResourceProviderImpl (HTTP → edge API)
├── posthog (analytics)
└── tracer (OpenTelemetry)
```

### 3.3 数据流总览

```
HTTP 请求
   │
   ▼
Gin 中间件 → 鉴权 → 注入 team 到 ctx
   │
   ▼
Handler
   │
   ├── (team metrics) 路径:
   │    ├── teamID := auth.MustGetTeamID(c)
   │    ├── 校验 path teamID == ctx teamID(防越权)
   │    ├── 解析 start/end(default 7d)
   │    ├── ValidateRange(start, end) — 防 start > end 或超过 MaxDate64
   │    ├── step := CalculateStep(start, end)
   │    └── clickhouseStore.Query* — 直接查 ClickHouse
   │
   └── (sandbox metrics) 路径:
        ├── sandboxID := utils.ShortID(sandboxID) — 标准化
        ├── team := auth.MustGetTeamInfo(c) — 拿 clusterID
        ├── clusterID := clusters.WithClusterFallback(team.ClusterID)
        ├── cluster := a.clusters.GetClusterById(clusterID)
        └── cluster.GetResources().GetSandboxMetrics(...) — 转发到 edge
```

---

## 四、4 个端点逐一解析

### 4.1 GET /teams/{teamID}/metrics — team 时间序列

**Handler**:`APIStore.GetTeamsTeamIDMetrics` (`packages/api/internal/handlers/team_metrics.go:18`)

**鉴权**:三选一(ApiKeyAuth / OIDC+TeamAuth / Admin)。

**参数**:
- `teamID` (path):要查的 team ID
- `start` (query, optional):Unix 秒,默认 7 天前
- `end` (query, optional):Unix 秒,默认 now

**流程**(`team_metrics.go:18-71`):

```go
authTeamID := auth.MustGetTeamID(c)

// 1. 防 cross-team 访问:path teamID 必须等于 ctx teamID
if teamID != authTeamID.String() {
    // 403 "You (X) are not authorized to access this team's (Y) metrics"
}

// 2. 默认 7 天窗口
start, end := time.Now().Add(-defaultTimeRange), time.Now()
if params.Start != nil {
    start = time.Unix(*params.Start, 0)
}
if params.End != nil {
    end = time.Unix(*params.End, 0)
}

// 3. 校验时间范围
start, end, err := clickhouseUtils.ValidateRange(start, end)
//   - start 不能晚于 MaxDate64(避免溢出)
//   - end 不能晚于 MaxDate64
//   - start 不能晚于 end

// 4. 动态计算 step
step := clickhouseUtils.CalculateStep(start, end)

// 5. 查 ClickHouse
metrics, err := a.clickhouseStore.QueryTeamMetrics(ctx, teamID, start, end, step)

// 6. 转 API 响应
apiMetrics := make([]api.TeamMetric, len(metrics))
for i, m := range metrics {
    apiMetrics[i] = api.TeamMetric{
        Timestamp:           m.Timestamp,             // deprecated
        TimestampUnix:       m.Timestamp.Unix(),      // 推荐
        ConcurrentSandboxes: int32(m.ConcurrentSandboxes),
        SandboxStartRate:    float32(m.SandboxStartedRate),
    }
}

c.JSON(http.StatusOK, apiMetrics)
```

**关键点**:
- **path teamID 与 ctx teamID 必须相等**:即使有 OIDC 鉴权,也要二次校验,防止 user 用自己的 token 查别的 team。
- **`SandboxStartRate` 是 float32**:表示"每秒启动的 sandbox 数",由 sum/step 算出。
- **`ConcurrentSandboxes` 是 int32**:那个时间窗口内的最大并发数。
- **空数据返空数组**:`[]`,不是 404。

**响应**:`200 OK` + `[]TeamMetric`。

### 4.2 GET /teams/{teamID}/metrics/max — team 峰值

**Handler**:`APIStore.GetTeamsTeamIDMetricsMax` (`packages/api/internal/handlers/team_metrics_max.go:18`)

**鉴权**:同 4.1。

**参数**:
- `teamID` (path)
- `start` / `end` (query)
- `metric` (query, **required**):枚举 `concurrent_sandboxes` 或 `sandbox_start_rate`

**流程**(`team_metrics_max.go:18-77`):

```go
// (同 4.1 的鉴权 + 时间窗口逻辑)
// ...

// 关键:按 metric 类型路由到不同 SQL
var maxMetric clickhouse.MaxTeamMetric
switch params.Metric {
case api.ConcurrentSandboxes:
    // 查 gauge 表的 argMax
    maxMetric, err = a.clickhouseStore.QueryMaxConcurrentTeamMetrics(ctx, teamID, start, end)

case api.SandboxStartRate:
    // 查 sum 表的 argMax(需要 step 参数算 rate)
    maxMetric, err = a.clickhouseStore.QueryMaxStartRateTeamMetrics(
        ctx, teamID, start, end, metrics.ExportPeriod)

default:
    // 400 "invalid metric: %s"
}

apiMetrics := api.MaxTeamMetric{
    Timestamp:     maxMetric.Timestamp,
    TimestampUnix: maxMetric.Timestamp.Unix(),
    Value:         float32(maxMetric.Value),
}

c.JSON(http.StatusOK, apiMetrics)
```

**关键点**:
- **`metric` 是必填**:OpenAPI spec `required: true`,没有就 400。
- **两个查询走不同表**:`ConcurrentSandboxes` 走 gauge 表(瞬时值),`SandboxStartRate` 走 sum 表(累计值除以 step)。
- **`QueryMaxStartRateTeamMetrics` 用 `ExportPeriod = 5s`**:这里 step **不是 `CalculateStep` 算出来的**,而是 export period(因为要看真实的"每秒启动率",不能用粗粒度 step 平均掉峰值)。
- **`argMax(ts, value)`**:ClickHouse 内置函数,返回"value 最大时对应的 ts"。即"峰值发生时间",不是窗口边界。
- **空数据返 0**:`QueryMax*` 内部如果 rows.Next() = false,返回 `{Value: 0, Timestamp: now}`,不报错。

**响应**:`200 OK` + `MaxTeamMetric`:
```json
{
  "timestamp": "2026-07-10T14:30:00Z",  // deprecated
  "timestampUnix": 1752157800,
  "value": 42.5
}
```

### 4.3 GET /sandboxes/metrics — 批量 sandbox 实时指标

**Handler**:`APIStore.GetSandboxesMetrics` (`packages/api/internal/handlers/sandboxes_list_metrics.go:68`)

**鉴权**:同 4.1。

**参数**:
- `sandbox_ids` (query, **required**):逗号分隔的 sandbox ID 列表,**最多 100 个**

**流程**(`sandboxes_list_metrics.go:68-95`):

```go
team := auth.MustGetTeamInfo(c)

// 1. 校验 sandbox_ids 数量
if len(params.SandboxIds) > maxSandboxMetricsCount {  // 100
    // 400 "Too many sandboxes requested, maximum is 100"
}

// 2. Posthog 埋点(用于统计 dashboard 使用)
a.posthog.CreateAnalyticsTeamEvent(ctx, team.ID.String(),
    "listed running instances with metrics", ...)

// 3. 转发到 cluster resource provider
sandboxesWithMetrics, apiErr := a.getSandboxesMetrics(
    ctx, team.ID,
    clusters.WithClusterFallback(team.ClusterID),
    params.SandboxIds,
)
if apiErr != nil { /* 500 or edge 返回的错误码 */ }

c.JSON(http.StatusOK, &api.SandboxesWithMetrics{Sandboxes: sandboxesWithMetrics})
```

**`getSandboxesMetrics` 实现**(`sandboxes_list_metrics.go:23-66`):

```go
// 1. 标准化每个 sandbox ID(可能用户传长/短两种格式)
for i, id := range sandboxIDs {
    short, err := utils.ShortID(id)
    sandboxIDs[i] = short
}

// 2. 拿 cluster(BYC 场景可能多个 cluster,这里取 team 的默认)
cluster, found := a.clusters.GetClusterById(clusterID)
if !found {
    // 500 "cluster not found"
}

// 3. 调用 cluster resource provider(local 或 remote)
metrics, apiErr := cluster.GetResources().GetSandboxesMetrics(
    ctx, teamID.String(), sandboxIDs)
```

**两种 resource provider**:
- **Local**(`resources_local.go:90`):本地 dev 模式,直接查 ClickHouse。
- **Remote**(`resources_remote.go:77`):生产模式,HTTP 转发到 edge API(`/v1/sandboxes/metrics`)。

**响应**:`200 OK` + `SandboxesWithMetrics`:
```json
{
  "sandboxes": {
    "sbx_abc123": {
      "timestamp": "...",       // deprecated
      "timestampUnix": 1752157800,
      "cpuUsedPct": 45.2,
      "cpuCount": 2,
      "memUsed": 1073741824,
      "memTotal": 2147483648,
      "memCache": 268435456,
      "diskUsed": 5368709120,
      "diskTotal": 10737418240
    },
    "sbx_def456": { ... }
  }
}
```

### 4.4 GET /sandboxes/{sandboxID}/metrics — 单 sandbox 时间序列

**Handler**:`APIStore.GetSandboxesSandboxIDMetrics` (`packages/api/internal/handlers/sandbox_metrics.go:16`)

**鉴权**:同 4.1。

**参数**:
- `sandboxID` (path)
- `start` / `end` (query, optional)

**流程**(`sandbox_metrics.go:16-48`):

```go
// 1. 标准化 sandbox ID
sandboxID, err = utils.ShortID(sandboxID)
if err != nil {
    // 400 "Invalid sandbox ID"
}

team := auth.MustGetTeamInfo(c)

// 2. 拿 cluster(带 fallback,本地 dev 走 local cluster)
clusterID := clusters.WithClusterFallback(team.ClusterID)
cluster, found := a.clusters.GetClusterById(clusterID)
if !found {
    // 500 "cluster not found"
}

// 3. 转发到 cluster resource provider
metrics, apiErr := cluster.GetResources().GetSandboxMetrics(
    ctx, team.ID.String(), sandboxID, params.Start, params.End)

c.JSON(http.StatusOK, metrics)
```

**关键点**:
- **`utils.ShortID` 标准化**:sandbox ID 可能是完整 UUID 或短形式,统一转成短的(edge 用短的)。
- **`clusters.WithClusterFallback`**:如果 team.ClusterID 为空(老数据),fallback 到 `LocalClusterID`。
- **响应直接透传**:handler 不做字段转换,edge 返回什么就给什么。

**响应**:`200 OK` + `[]SandboxMetric`(时间序列数组)。

---

## 五、关键流程时序图

### 5.1 team metrics 查询(ClickHouse 路径)

```
dashboard          API (GetTeamsTeamIDMetrics)    ClickHouse
   │                     │                          │
   │ GET /teams/X/metrics│                          │
   │   ?start=...&end=...│                          │
   ├────────────────────>│                          │
   │                     │                          │
   │                     │ 1. 校验 path teamID       │
   │                     │   == ctx teamID           │
   │                     │                          │
   │                     │ 2. defaultTimeRange=7d    │
   │                     │   start = now - 7d        │
   │                     │   end   = now             │
   │                     │                          │
   │                     │ 3. ValidateRange          │
   │                     │   (start<=end, no overflow)│
   │                     │                          │
   │                     │ 4. step = CalculateStep   │
   │                     │   (7d → 5min)             │
   │                     │                          │
   │                     │ 5. QueryTeamMetrics       │
   │                     │   (with CTE: created +   │
   │                     │    concurrent + all_ts)   │
   │                     ├─────────────────────────>│
   │                     │                          │
   │                     │   聚合查询(sum + gauge)  │
   │                     │                          │
   │                     │<─────────────────────────┤
   │                     │   []TeamMetrics           │
   │                     │                          │
   │                     │ 6. 转 API 类型            │
   │                     │   (含 deprecated timestamp)│
   │                     │                          │
   │ 7. 200 OK           │                          │
   │   [{timestampUnix,  │                          │
   │     concurrentSandboxes, sandboxStartRate},...]│
   │<────────────────────┤                          │
```

### 5.2 sandbox metrics 查询(edge 转发路径)

```
dashboard          API                          Cluster Pool          edge API
   │                     │                          │                   │
   │ GET /sandboxes/X/metrics                     │                   │
   ├────────────────────>│                          │                   │
   │                     │                          │                   │
   │                     │ 1. ShortID(sandboxID)    │                   │
   │                     │   标准化                 │                   │
   │                     │                          │                   │
   │                     │ 2. team := MustGetTeamInfo                   │
   │                     │   clusterID := WithClusterFallback           │
   │                     │                          │                   │
   │                     │ 3. GetClusterById(clusterID)                 │
   │                     ├─────────────────────────>│                   │
   │                     │<─────────────────────────┤                   │
   │                     │   cluster (with resources)│                   │
   │                     │                          │                   │
   │                     │ 4. GetSandboxMetrics(ctx, teamID, sbxID, ...)│
   │                     ├─────────────────────────>│                   │
   │                     │                          │ HTTP request       │
   │                     │                          ├──────────────────>│
   │                     │                          │<──────────────────┤
   │                     │                          │   metrics          │
   │                     │<─────────────────────────┤                   │
   │                     │   []SandboxMetric         │                   │
   │                     │                          │                   │
   │ 5. 200 OK           │                          │                   │
   │   (透传 edge 返回)  │                          │                   │
   │<────────────────────┤                          │                   │
```

---

## 六、ClickHouse 查询深入

### 6.1 QueryTeamMetrics 的 SQL 逻辑

`packages/clickhouse/pkg/team.go:20-55`:

```sql
WITH
  -- CTE 1: 累计型 metric(sum 表),按 step 分桶并求和
  created AS (
    SELECT
      toStartOfInterval(timestamp, interval {step} second) AS ts,
      sum(value) as created_sandboxes
    FROM team_metrics_sum
    WHERE metric_name = 'e2b.team.sandbox.created'
      AND team_id = {team_id:String}
      AND timestamp BETWEEN {start_time} AND {end_time}
    GROUP BY ts
  ),

  -- CTE 2: 瞬时型 metric(gauge 表),按 step 分桶取 max
  concurrent AS (
    SELECT
      toStartOfInterval(timestamp, interval {step} second) AS ts,
      toInt64(max(value)) AS concurrent_sandboxes
    FROM team_metrics_gauge
    WHERE metric_name = 'e2b.team.sandbox.running'
      AND team_id = {team_id:String}
      AND timestamp BETWEEN {start_time} AND {end_time}
    GROUP BY ts
  ),

  -- CTE 3: 两个时间序列的并集(用 UNION DISTINCT 补齐缺失桶)
  all_ts AS (
    SELECT ts FROM created
    UNION DISTINCT
    SELECT ts FROM concurrent
  )

-- 最终:LEFT JOIN 两个时间序列,COALESCE 缺失为 0
SELECT
  all_ts.ts AS ts,
  COALESCE(created_sandboxes / {step}::Float32, 0.0) AS started_sandboxes_rate,
  COALESCE(concurrent_sandboxes, 0)                AS concurrent_sandboxes
FROM all_ts
LEFT JOIN created      ON created.ts = all_ts.ts
LEFT JOIN concurrent   ON concurrent.ts = all_ts.ts
ORDER BY all_ts.ts ASC;
```

**关键设计点**:
1. **`toStartOfInterval(timestamp, interval N second)`**:ClickHouse 内置分桶函数,把 timestamp 对齐到 N 秒边界。
2. **`UNION DISTINCT` 取并集**:如果某个时间桶只有 sum 数据没有 gauge 数据(或反过来),用 LEFT JOIN + COALESCE 填 0。
3. **`created_sandboxes / step` 算 rate**:counter 表的 sum 是"那段时间新增了多少",除以 step 秒得到"每秒多少个"。
4. **gauge 表用 `max(value)`**:而不是 `sum` 或 `avg`。gauge 表存的是"export 瞬间的并发采样值",一个 step 桶内有多个采样点(`step / ExportPeriod` 个),取 max 反映"那个时间段内的最高水位"——这正是 `concurrent_sandboxes` 想表达的语义(峰值并发)。

### 6.2 QueryMaxConcurrentTeamMetrics(argMax 算法)

`packages/clickhouse/pkg/team.go:141-149`:

```sql
SELECT
  argMax(timestamp, value) AS ts,   -- value 最大时对应的 timestamp
  max(value) AS max_value           -- 最大的 value
FROM team_metrics_gauge
WHERE metric_name = 'e2b.team.sandbox.running'
  AND team_id = {team_id:String}
  AND timestamp BETWEEN {start} AND {end};
```

**`argMax(x, y)` 的语义**:返回"y 最大时对应的 x"。这里 `y=value`, `x=timestamp`,所以返回的是"峰值发生的时间点"。

**为什么不是 `max(value)` 单独查**?
- 单独 max 只给峰值,不给时间。
- 用户想知道"高峰什么时候发生的"(用于关联日志、事件)。
- argMax 同时拿到值和时间,一次查询。

### 6.3 QueryMaxStartRateTeamMetrics

`packages/clickhouse/pkg/team.go:90-106`:

```sql
WITH aggregated AS (
    SELECT
        toStartOfInterval(timestamp, interval {step} second) AS agg_ts,
        sum(value) AS agg_value
    FROM team_metrics_sum
    WHERE metric_name = 'e2b.team.sandbox.created'
      AND team_id = {team_id:String}
      AND timestamp BETWEEN {start} AND {end}
    GROUP BY agg_ts
)
SELECT
    argMax(agg_ts, agg_value) AS ts,           -- 峰值桶的时间
    max(agg_value) / {step}::Float32 AS max_value  -- 峰值除以 step = rate
FROM aggregated;
```

**关键差异**(对比 6.2):
- **需要 step**:这里 step 是 **5s(ExportPeriod)**,不是 `CalculateStep` 算出来的。
- **为什么**:start_rate 的语义是"每秒启动多少 sandbox"。如果用粗 step(如 5min)平均,会掩盖瞬时高峰。用 export period(5s)才是真实的"最高 5 秒启动率"。

代码确认(`team_metrics_max.go:56`):
```go
maxMetric, err = a.clickhouseStore.QueryMaxStartRateTeamMetrics(
    ctx, teamID, start, end, metrics.ExportPeriod)  // 5s
```

---

## 七、数据模型

### 7.1 ClickHouse 表结构

简表(完整迁移见 `packages/clickhouse/migrations/`):

| 表 | 用途 | 关键字段 | 来源 migration |
| --- | --- | --- | --- |
| `team_metrics_sum` | team 级 Counter 累计值 | `team_id`, `metric_name`, `value`, `timestamp` | `20250801113226_team_counters.sql` |
| `team_metrics_gauge` | team 级 Gauge 瞬时值 | `team_id`, `metric_name`, `value`, `timestamp` | `20250801113224_team_metrics.sql` |
| `sandbox_metrics_gauge` | sandbox 级 Gauge(CPU/Mem/Disk) | `sandbox_id`, `team_id`, `metric_name`, `value`, `timestamp` | `20250717135224_sandbox_metrics.sql` |
| `sandbox_events` | sandbox 生命周期事件 | `team_id`, `sandbox_id`, `event_label`, `type`, `timestamp` | `20250725223341_add_sandbox_events.sql`(分布式) / `20250725223340_add_sandbox_events_local.sql`(本地) |
| `sandbox_host_stats` | 主机资源快照 | `cpu_used_pct`, `mem_used`, ... | `20260209152327_add_sandbox_host_stats.sql` |

**TTL**:
- `team_metrics_*` 表 **30 天** TTL(`20250801113224_team_metrics.sql` / `20250801113226_team_counters.sql` 创建时设定)。
- `sandbox_events` **默认 7 天** TTL,但 `20260702120000_add_sandbox_events_ttl_days.sql` 引入 `events_ttl_days` 列后变为**按行 per-team 配置**(默认 7,某些 team 可配更长)。

注意:`20250521131545/6_add_metrics*.sql` 创建的是 OpenTelemetry 通用的 `metrics_gauge_local` / `metrics_sum` 表,不是 `team_metrics_*`。`team_metrics_*` 表通过物化视图从通用表里按 `MetricName LIKE 'e2b.team.%'` 路由过来。

### 7.2 团队 metrics 上报路径

```
API/orchestrator (产生 metric)
   │
   │  OpenTelemetry SDK (memory)
   │
   │  每 ExportPeriod(5s)批量 flush
   ▼
OTEL Collector (optional, 中转)
   │
   │  批量写入
   ▼
ClickHouse
├── team_metrics_sum   (counter 类型)
└── team_metrics_gauge (gauge 类型)
```

**metric 名字**(`packages/shared/pkg/telemetry/meters.go`):
- `telemetry.TeamSandboxCreated` = `"e2b.team.sandbox.created"`(Counter,sum 表)
- `telemetry.TeamSandboxRunningGaugeName` = `"e2b.team.sandbox.running"`(Gauge,gauge 表)

这两个名字通过 `team.go:20-55` 的 `fmt.Sprintf` 注入到 SQL 的 `WHERE metric_name = '%s'` 子句。物化视图也按 `MetricName LIKE 'e2b.team.%'` 把 OTEL 通用表的数据路由到 `team_metrics_*`。

---

## 八、动态步长算法详解

`CalculateStep`(`packages/clickhouse/pkg/utils/step.go:7`)的 6 档选择:

| 时间窗口 | step | 数据点数上限 | 适用场景 |
| --- | --- | --- | --- |
| < 1h | 5s | 720 | 实时调试、故障排查 |
| 1h ~ 6h | 30s | 720 | 短期趋势 |
| 6h ~ 12h | 60s | 720 | 半天监控 |
| 12h ~ 24h | 120s | 720 | 全天监控 |
| 24h ~ 7d | 300s(5min) | 2016 | 周度报告(略超 1000) |
| > 7d | 900s(15min) | 无上限 | 长期趋势 |

**为什么 5s 是最小档**?
- 与 `ExportPeriod` 对齐。再细的粒度底层没有数据。
- 5s 已经是"近实时"的工程极限。

**为什么 5min 档会超 1000**?
- 7 天 / 5min = 2016 点。是个工程妥协。
- 更细的 step(如 2min)会让数据点过多(5040),前端渲染慢。
- 更粗的 step(如 10min)会让短期波动消失。
- 5min 是"还能看到小时级模式"的最小粒度。

---

## 九、配置与 Feature Flag

本模块**不直接挂任何 feature flag**。

**常量**:
- `defaultTimeRange = 7 * 24 * time.Hour`(`team_metrics.go:16`)— 默认窗口
- `maxSandboxMetricsCount = 100`(`sandboxes_list_metrics.go:21`)— 批量上限
- `ExportPeriod = 5 * time.Second`(`packages/api/internal/metrics/team.go:20`)— export 间隔

**环境变量**:
- `CLICKHOUSE_CONNECTION_STRING` / `CLICKHOUSE_CONNECTION_STRINGS` — ClickHouse 连接(LD flag 切换)
- 详见 `packages/api/internal/cfg/`

---

## 十、关键代码文件索引

### 10.1 handlers(`packages/api/internal/handlers/`)

| 文件 | 主要函数 |
| --- | --- |
| `team_metrics.go:16` | `defaultTimeRange = 7 * 24 * time.Hour` |
| `team_metrics.go:18` | `GetTeamsTeamIDMetrics` |
| `team_metrics_max.go:18` | `GetTeamsTeamIDMetricsMax` |
| `sandbox_metrics.go:16` | `GetSandboxesSandboxIDMetrics` |
| `sandboxes_list_metrics.go:21` | `maxSandboxMetricsCount = 100` |
| `sandboxes_list_metrics.go:23` | `getSandboxesMetrics`(私有 helper) |
| `sandboxes_list_metrics.go:68` | `GetSandboxesMetrics` |

### 10.2 clickhouse(`packages/clickhouse/pkg/`)

| 文件 | 主要 API |
| --- | --- |
| `clickhouse.go:19-28` | `Clickhouse` interface(含 QueryTeamMetrics 等) |
| `team.go:14-18` | `TeamMetrics` 结构 |
| `team.go:20-55` | `teamMetricsSelectQuery` SQL |
| `team.go:57` | `QueryTeamMetrics` |
| `team.go:85-88` | `MaxTeamMetric` 结构 |
| `team.go:90-106` | `maxStartRateTeamMetricsSelectQuery` SQL |
| `team.go:108` | `QueryMaxStartRateTeamMetrics` |
| `team.go:141-149` | `maxConcurrentTeamMetricsSelectQuery` SQL |
| `team.go:151` | `QueryMaxConcurrentTeamMetrics` |
| `switcher.go:16` | `SwitchingClient` struct(LD-gated 多集群切换) |
| `switcher.go:83-93` | `SwitchingClient` 的 3 个 team metrics 方法(QueryTeamMetrics / QueryMaxStartRateTeamMetrics / QueryMaxConcurrentTeamMetrics) |
| `utils/validate.go:11` | `ValidateRange` |
| `utils/step.go:7` | `CalculateStep` |

### 10.3 clusters(`packages/api/internal/clusters/`)

| 文件 | 主要 API |
| --- | --- |
| `resources.go:20-25` | `ClusterResource` interface |
| `resources_local.go:41` | `GetSandboxMetrics`(本地) |
| `resources_local.go:90` | `GetSandboxesMetrics`(本地) |
| `resources_remote.go:38` | `GetSandboxMetrics`(转发到 edge) |
| `resources_remote.go:77` | `GetSandboxesMetrics`(转发到 edge) |

### 10.4 metrics 上报(`packages/api/internal/metrics/`)

| 文件 | 主要内容 |
| --- | --- |
| `team.go:20` | `ExportPeriod = 5 * time.Second` |
| `team.go:41` | `meterProvider` 初始化 |

### 10.5 OpenAPI spec

| 位置 | 内容 |
| --- | --- |
| `spec/openapi.yml:2028` | `/teams/{teamID}/metrics` GET |
| `spec/openapi.yml:2073` | `/teams/{teamID}/metrics/max` GET |
| `spec/openapi.yml:2233` | `/sandboxes/metrics` GET |
| `spec/openapi.yml:2421` | `/sandboxes/{sandboxID}/metrics` GET |
| `spec/openapi.yml:486` | `SandboxMetric` schema |
| `spec/openapi.yml:701` | `SandboxesWithMetrics` schema |
| `spec/openapi.yml:825` | `TeamMetric` schema |
| `spec/openapi.yml:851` | `MaxTeamMetric` schema |

---

## 十一、设计要点与权衡

### 11.1 为什么 team 和 sandbox 走两路数据源?

详见 [1.2](#12-关键定位两路数据源)。简而言之:
- team metrics 是**全局聚合**(across all sandboxes),适合用 OLAP(ClickHouse)预聚合。
- sandbox metrics 是**单实例透视**,需要 edge 直接采集(orchestrator 已经有数据,不必绕一圈)。

### 11.2 为什么 step 用动态算法而不是固定值?

详见 [八](#八动态步长算法详解)。简而言之:**保证数据点数 ≤ ~1000**,前端渲染友好。

### 11.3 为什么 `timestamp` 字段保留(deprecated)?

详见 [2.3](#23-timestamp-字段为什么-deprecated)。简而言之:**客户端兼容**。下线需要 major version bump。

### 11.4 为什么 `QueryMaxStartRateTeamMetrics` 用 `ExportPeriod` 而不是 `CalculateStep`?

详见 [6.3](#63-querymaxstartrateteammetrics)。简而言之:**避免峰值被粗粒度平均掉**。粗 step 会把瞬时高峰稀释。

### 11.5 为什么 sandbox_ids 上限是 100?

- **SQL `IN (...)` 列表过长**会拖慢查询计划。
- **HTTP 请求体过大**:GET 用 query string,过长会被中间代理截断。
- **edge 端资源**:同时取 100 个 sandbox 的 metrics 是合理的 dashboard 上限。

### 11.6 为什么 path teamID 与 ctx teamID 必须相等?

- **二次防御**:即使 OIDC 鉴权过了,handler 仍校验。
- **防止 token 复用**:某用户的 token 不能用来查别的 team,即使他知道 teamID。
- **管理员路径**:AdminApiKeyAuth + AdminTeamAuth 走的是 admin 上下文,`auth.MustGetTeamID` 拿到的是 admin token 指定的 team,与 path 应该一致。

### 11.7 为什么空窗口返 0 而不是 404?(仅 `/metrics/max` 端点)

注意:这条只适用于 `GET /teams/{id}/metrics/max`(`QueryMaxConcurrentTeamMetrics` / `QueryMaxStartRateTeamMetrics` 在 `team.go:121-130` 和 `team.go:164-172` 显式返回 `{Value: 0, Timestamp: time.Now()}`)。**`GET /teams/{id}/metrics`(不带 `/max`)空数据返空数组 `[]`,不是返 0**。

- **语义清晰**:team 没有活动也是一种"答案",不是"找不到"。
- **前端友好**:不用区分"404 = 数据没了"和"真的有数据但都是 0"。
- **时间戳用 `time.Now()`**:让前端知道"查询在 X 时刻执行,没数据"。

### 11.8 为什么不在 API 层缓存 metrics?

- **数据时效性**:metrics 是时间序列,缓存会引入"看到的是 N 秒前的数据"的混淆。
- **底层已优化**:ClickHouse 自带缓存;edge cluster 也有自己的缓存策略。
- **查询参数变化大**:start/end/step 组合多,缓存命中率低。

### 11.9 为什么 `sandbox_metrics.go` 不解析 body / 不校验时间范围?

- 它只透传 `start/end` 给 edge(可选),edge 自己校验。
- 单 sandbox 查询由 edge 决定窗口大小,API 层不干预。

### 11.10 为什么 `GetSandboxesMetrics` 有 posthog 埋点但 `GetSandboxMetrics` 没有?

- 代码事实上如此(`sandboxes_list_metrics.go:82-84` 有 posthog 调用,`sandbox_metrics.go` 没有)。
- `GetSandboxesMetrics` 触发的事件名是 `"listed running instances with metrics"`,用于 dashboard list 视图的产品分析。
- 单 sandbox 调用没埋点可能是历史原因或有意降低 posthog 调用频率(单 sandbox 详情请求频率通常更高)。

---

## 十二、常见问题与排查

### Q1: 用户报告 "GET /teams/X/metrics 返 403"

**说明**:path 里的 teamID 与当前 auth 的 teamID 不一致。

**处理**:
- 检查 dashboard 是否传错了 teamID(例如切换 team 后没刷新)。
- SDK 用 `client.getTeamMetrics()` 应该用当前 team。

### Q2: 用户报告"metrics 数据延迟 10 秒以上"

**说明**:正常。`ExportPeriod = 5s` + ClickHouse 写入 + 查询 = 总延迟 5-15s。

**处理**:
- 实时监控用 `GET /sandboxes/{id}/metrics`(走 edge,延迟 <1s)。
- 历史趋势用 team metrics。

### Q3: 用户报告"过去 N 天的 team metrics 查不到"

**说明**:可能原因:
1. **超过 TTL**:`team_metrics_*` 表 30 天 TTL,N > 30 的数据已被 ClickHouse 自动清理。
2. team 是新创建的,没有历史数据。
3. 时间窗口参数传错了(start 是未来的时间,或 start > end 被拒绝)。
4. 该 team 在该时间段内确实没有 sandbox 活动(空窗口,SQL 会返回空数组)。

注:`sandbox_events` 表默认 7 天 TTL(per-team 可配),与本端点无关——本端点查 `team_metrics_*`,不查 `sandbox_events`。

**排查**:
```sql
SELECT MIN(timestamp), MAX(timestamp)
FROM team_metrics_gauge
WHERE team_id = '<teamID>';
```

### Q4: 用户报告"`max concurrent_sandboxes` 跟实际感受不符"

**可能原因**:
- 用户期望"瞬间最大",但实际是"5 秒 export 周期内的最大"。
- 极短的峰值(如 1 秒内 50 个 sandbox 启动又立刻销毁)可能被采样错过。

**处理**:这是采样原理的限制,无法避免。降低 export period 会改善但成本高。

### Q5: 用户报告"GET /sandboxes/metrics 返 400 Too many sandboxes"

**说明**:`sandbox_ids` 超过 100 个。

**处理**:分批查询,每批 ≤100。

### Q6: 用户报告"GET /sandboxes/X/metrics 返 500 cluster not found"

**说明**:team 的 `clusterID` 在 cluster pool 中找不到。可能是:
- 配置错误(BYC cluster 没注册)。
- 集群下线了但 team 数据没迁移。
- 本地 dev 模式下没启动 local cluster。

**排查**:
- 检查 `team.ClusterID` 字段。
- 检查 cluster 注册逻辑(`packages/api/internal/clusters/`)。

### Q7: 内部服务能否用 admin 代查任意 team 的 metrics?

**可以**。所有 4 个端点都接受 `AdminApiKeyAuth + AdminTeamAuth` 兜底。
- 用 admin token + `X-Team-Id: <targetTeamID>` 调用。
- handler 里 `auth.MustGetTeamID` 会拿到 admin 指定的 team。
- 仍然校验 path teamID == ctx teamID(一致就过)。

### Q8: 如何审计 metrics 查询?

- `GetSandboxesMetrics` 有 posthog 事件 `listed running instances with metrics`。
- 其他 3 个端点没有显式埋点(只有 telemetry span)。
- 想做 user-level 审计需要在 handler 里加 `WithUserID`。

### Q9: 为什么 sandbox metrics 走 edge,不直接查 ClickHouse?

- edge 有实时数据(秒级采集)。
- ClickHouse 有延迟(5-15s)。
- 转发到 edge 还能利用 edge 的本地缓存。

本地 dev 模式下,`resources_local.go` 确实直接查 ClickHouse(因为没有 edge)。

### Q10: 能否查多个 team 的 metrics 做对比?

**不能**。每个请求只能查一个 team(path 参数)。如果要跨 team 对比(例如 admin 看全平台):
- 实现一个新端点 `GET /admin/metrics?team_ids=...`(目前没有)。
- 或直接连 ClickHouse 查(需要 DB 访问权限)。

---

## 附录 A:端点速查表

### A.1 4 个 metrics 端点

| 端点 | 数据源 | 成功 | 失败常见码 |
| --- | --- | --- | --- |
| `GET /teams/{id}/metrics` | ClickHouse | 200 + `[]TeamMetric` | 400, 401, 403, 500 |
| `GET /teams/{id}/metrics/max` | ClickHouse | 200 + `MaxTeamMetric` | 400, 401, 403, 500 |
| `GET /sandboxes/metrics?sandbox_ids=...` | edge cluster | 200 + `SandboxesWithMetrics` | 400, 401, 500 |
| `GET /sandboxes/{sandboxID}/metrics` | edge cluster | 200 + `[]SandboxMetric` | 400, 401, 404, 500 |

### A.2 时间窗口与步长对照

| 时间窗口 | step(秒) | 数据点数 |
| --- | --- | --- |
| < 1h | 5 | ≤720 |
| 1h ~ 6h | 30 | ≤720 |
| 6h ~ 12h | 60 | ≤720 |
| 12h ~ 24h | 120 | ≤720 |
| 24h ~ 7d | 300 | ≤2016 |
| > 7d | 900 | 无上限 |

### A.3 字段映射(team metrics)

| DB 列 / 计算结果 | API 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| `toStartOfInterval(timestamp, step)` | `timestampUnix` | int64 | 桶起始时间(Unix 秒) |
| 同上 | `timestamp` | string (deprecated) | RFC3339 字符串 |
| `max(value)` from `team_metrics_gauge` | `concurrentSandboxes` | int32 | 并发数 |
| `sum(value) / step` from `team_metrics_sum` | `sandboxStartRate` | float32 | 每秒启动数 |

### A.4 字段映射(sandbox metrics)

| edge 返回字段 | API 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| `timestampUnix` | `timestampUnix` | int64 | Unix 秒 |
| `timestamp` | `timestamp` | string (deprecated) | RFC3339 |
| `cpuUsedPct` | `cpuUsedPct` | float32 | CPU 使用率 % |
| `cpuCount` | `cpuCount` | int32 | CPU 核数 |
| `memUsed` | `memUsed` | int64 | 已用内存(字节) |
| `memTotal` | `memTotal` | int64 | 总内存 |
| `memCache` | `memCache` | int64 | 页缓存 |
| `diskUsed` | `diskUsed` | int64 | 已用磁盘 |
| `diskTotal` | `diskTotal` | int64 | 总磁盘 |

---

## 附录 B:错误码与 HTTP 状态映射

| 场景 | HTTP | 说明 |
| --- | --- | --- |
| path teamID 与 auth team 不一致 | 403 | "You (X) are not authorized to access this team's (Y) metrics" |
| start > end | 400 | "start time cannot be after end time" |
| start/end 超过 MaxDate64 | 400 | "start/end time cannot be after <MaxDate64>" |
| `metric` 参数缺失或非法 | 400 | "invalid metric: ..." |
| sandbox_ids 数量 > 100 | 400 | "Too many sandboxes requested, maximum is 100" |
| sandboxID 格式非法 | 400 | "Invalid sandbox ID" |
| 未鉴权 | 401 | (中间件返回) |
| sandbox 不存在 | 404 | (edge 返回) |
| cluster 找不到 | 500 | "cluster not found for sandbox metrics" |
| ClickHouse 查询失败 | 500 | "error querying team metrics: ..." |
| 成功(所有端点) | 200 | JSON |

---

## 附录 C:术语表

| 术语 | 含义 |
| --- | --- |
| **team metrics** | team 级时间序列(concurrent sandboxes + start rate) |
| **sandbox metrics** | 单 sandbox 或批量 sandbox 的资源快照(CPU/Mem/Disk) |
| **step** | 时间序列的聚合粒度(5s/30s/1min/2min/5min/15min) |
| **`CalculateStep`** | 根据 time window 算 step 的函数 |
| **`ExportPeriod`** | OpenTelemetry meter export 间隔(5s) |
| **`team_metrics_sum`** | ClickHouse 表,存 counter 类型(DeltaTemporality,每行 = 5s 内的新增量) |
| **`team_metrics_gauge`** | ClickHouse 表,存 gauge 类型(export 瞬间采样值) |
| **`argMax(x, y)`** | ClickHouse 函数:返回 y 最大时对应的 x |
| **`toStartOfInterval`** | ClickHouse 函数:把 timestamp 对齐到 N 秒边界 |
| **`MaxDate64`** | ClickHouse DateTime64 上限,用于 ValidateRange |
| **`defaultTimeRange`** | 默认时间窗口 7 天 |
| **`maxSandboxMetricsCount`** | sandbox_ids 批量上限 100 |
| **`ShortID`** | sandbox ID 标准化(完整 UUID → 短形式) |
| **`WithClusterFallback`** | team.ClusterID 为空时 fallback 到 local cluster |
| **`ClusterResource`** | interface,有 local / remote 两种实现 |
| **`timestampUnix`** | 推荐使用(int64 Unix 秒) |
| **`timestamp`** | deprecated(RFC3339 字符串) |
| **concurrent_sandboxes** | 当前并发运行的 sandbox 数(gauge) |
| **sandbox_start_rate** | 每秒启动的 sandbox 数(sum ÷ step) |
| **OTEL collector** | OpenTelemetry 中转层,把 SDK export 转发到 ClickHouse |
