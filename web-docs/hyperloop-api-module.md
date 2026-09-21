# E2B Hyperloop API 模块详解

> 范围:本文描述 Orchestrator 节点上的 Hyperloop HTTP 服务,包括 sandbox 到 host 的网络路径、`GET /me`、`POST /logs`、基于源 IP 的身份识别、日志 payload 防伪和 collector 转发。这里的 Hyperloop 是 sandbox 内部控制/事件通道,不是 Edge API,也不是 Firecracker API。
>
> 行号均按 tag `2026.30` 核对。已同步至 2026.30(2026-09-10)。

> ⚠️ **2026.30 变动速览**:`POST /logs` 在 2026.30 被大幅改造,新增四项能力,并**纠正了一处旧行为**:
> 1. **过期时间戳丢弃**(§8.4):payload 的 `timestamp` 早于本 lifecycle 的 `LifecycleStartedAt` → 400 `"Log timestamp predates this sandbox's resume"`。
> 2. **动态日志路由**(§9.1):目标地址不再固定为 `LOGS_COLLECTOR_ADDRESS`,改由 LD JSON flag `logs-write-config` 解析,1 秒 TTL 缓存。
> 3. **shadow 写入**(§9.5):best-effort 的 fire-and-forget 第二/三/四路转发,有并发上限。
> 4. **⛔ 修正旧描述**:2026.29 版本的本文 §9.3 / §十六 Q4 / 附录 B 第 5 条都说"Hyperloop 不检查 collector 的 HTTP status code"。**2026.30 起这条不成立了**——`forwardLogs`(`logs.go:228-232`)会对非 2xx 返回错误,`POST /logs` 随之返回 500。详见 §9.4。
>
> `GET /me`、身份模型、网络路径、中间件链、payload 覆盖规则均未变。

## 目录

- [一、概述](#一概述)
- [二、架构位置与数据流](#二架构位置与数据流)
- [三、服务启动与中间件](#三服务启动与中间件)
- [四、网络路径](#四网络路径)
- [五、身份模型](#五身份模型)
- [六、GET /me](#六get-me)
- [七、POST /logs](#七post-logs)
- [八、日志 payload 防伪](#八日志-payload-防伪)
- [九、Collector 转发](#九collector-转发)
- [十、envd、MMDS 与客户端发现](#十envdmmds-与客户端发现)
- [十一、错误处理](#十一错误处理)
- [十二、生命周期与并发边界](#十二生命周期与并发边界)
- [十三、关键时序](#十三关键时序)
- [十四、配置与限制](#十四配置与限制)
- [十五、安全模型](#十五安全模型)
- [十六、常见问题与排查](#十六常见问题与排查)
- [十七、关键文件索引](#十七关键文件索引)
- [附录 A:端点速查](#附录-a端点速查)
- [附录 B:关键不变量](#附录-b关键不变量)

---

## 一、概述

Hyperloop 是每个 Orchestrator 节点上的轻量 HTTP 服务。它给该节点管理的 sandbox 提供两个能力:

1. 查询“我是谁”:根据请求来源返回 sandbox ID。
2. 上报日志:校验来源身份,重写可信元数据,转发到集中日志 collector。

OpenAPI 契约只有两个端点:

```text
GET  /me
POST /logs
```

服务默认监听 host 的 `5010` 端口,但 sandbox 内的调用方访问的是保留地址 `192.0.2.1:80`。Orchestrator 为每个 sandbox 建立 iptables REDIRECT,把这条流量转到 host 上的 Hyperloop 端口。

### 1.1 与相邻组件的区别

| 组件 | 方向 | 用途 |
|---|---|---|
| envd | host/API → guest | 进程、文件、初始化、freeze/thaw |
| Orchestrator gRPC | API → host | Sandbox 生命周期与 Volume 操作 |
| Edge API | API → remote cluster | Service discovery、logs、metrics |
| **Hyperloop** | guest → host | Guest 身份查询、日志/事件上报 |
| NFS proxy/portmapper | guest → host | Persistent Volume 文件访问 |

---

## 二、架构位置与数据流

```text
Sandbox guest
  │
  │ http://192.0.2.1/me
  │ http://192.0.2.1/logs
  ▼
guest eth0 / TAP / veth
  │
  │ iptables PREROUTING
  │ dst=192.0.2.1,dport=80
  │ REDIRECT --to-port 5010
  ▼
Orchestrator Hyperloop server
  │
  ├─ RemoteAddr IP → sandbox.Map.network → Sandbox
  │
  ├─ GET /me → {sandboxID}
  │
  └─ POST /logs
       ├─ 校验 payload.instanceID
       ├─ 覆盖 instanceID/envID/teamID
       └─ POST LOGS_COLLECTOR_ADDRESS
```

关键设计是:**身份来自网络槽位,不是请求自己声明的 ID**。请求 body 里的 `instanceID` 只是需要与网络身份一致的冗余校验值。

---

## 三、服务启动与中间件

### 3.1 启动位置

Orchestrator factory 在启动 NFS proxy 后创建 Hyperloop server:

```go
hyperloopSrv, err := hyperloopserver.NewHyperloopServer(
    ctx,
    config.NetworkConfig.HyperloopProxyPort,
    globalLogger,
    sandboxes,
    featureFlags,   // ← 2026.30 新增
)
```

服务作为 Orchestrator 的一个受管组件启动,shutdown 时调用 `http.Server.Shutdown`。

> ⚠️ **2026.30 变动**:`NewHyperloopServer`(`hyperloopserver/server.go:26`；2026.29 为 `:25`)新增第 5 个参数 `featureFlags *featureflags.Client`,并把它透传给 `handlers.NewHyperloopStore(logger, sandboxes, sandboxCollectorAddr, featureFlags)`(`server.go:28`)。**这是 §9 动态日志路由的入口**——没有它,Hyperloop 只能用固定的 `LOGS_COLLECTOR_ADDRESS`。

### 3.2 HTTP server

```go
server := &http.Server{
    Handler: engine,
    Addr:    fmt.Sprintf("0.0.0.0:%d", port),
}
```

随后调用 `httpserver.ConfigureH2C(server)`,允许 cleartext HTTP/2。

### 3.3 中间件链

Gin engine 只安装三个中间件:

| 中间件 | 作用 |
|---|---|
| `gin.Recovery()` | panic 恢复 |
| `RequestSizeLimiter(256 MiB)` | 限制 request body 大小 |
| `OapiRequestValidator` | 按嵌入的 Hyperloop OpenAPI 校验 path/operation |

没有 API key、Bearer token 或 traffic access token 中间件。Hyperloop 的授权依据是请求源 IP 与 sandbox network map。

### 3.4 代码生成

生成配置启用:

```yaml
generate:
  gin-server: true
  embedded-spec: true
  models: true
```

因此生成物同时包含:

- `Me`/`Error` 模型。
- `ServerInterface`。
- Gin 路由注册器。
- 嵌入式 OpenAPI,供运行时 request validator 使用。

---

## 四、网络路径

### 4.1 保留地址

Network config 默认值:

```text
SANDBOX_ORCHESTRATOR_IP=192.0.2.1
SANDBOX_HYPERLOOP_PROXY_PORT=5010
```

`192.0.2.0/24` 是文档/实验保留地址段,这里作为 guest 看到的 host 服务地址。

### 4.2 iptables REDIRECT

创建 sandbox network slot 时添加规则:

```text
table: nat
chain: PREROUTING
input: sandbox veth
protocol: tcp
destination: 192.0.2.1
destination port: 80
action: REDIRECT --to-port 5010
```

因此 guest 无需知道实际 host port。Hyperloop port 改动只影响 Orchestrator 配置和 redirect target,guest 仍访问 port 80。

### 4.3 与 NFS 的端口隔离

同一个 `192.0.2.1` 还承载:

| Guest 目标端口 | Host 服务 |
|---|---|
| 80 | Hyperloop,默认 host 5010 |
| 111 | portmapper,默认 host 5012 |
| NFS 端口 | NFS proxy,默认 host 5011 |

它们共享 host-facing IP,但使用不同 redirect 规则和协议。

---

## 五、身份模型

### 5.1 三索引 Sandbox Map

`sandbox.Map` 维护:

| 索引 | Key | 用途 |
|---|---|---|
| `live` | sandbox ID | API/proxy 查询当前可路由 lifecycle |
| `lifecycles` | sandboxID/lifecycleID | 等待旧 lifecycle 清理完成 |
| `network` | sandbox host IP | Hyperloop `GetByHostPort` |

Hyperloop 使用独立的 `network` 索引,因为请求只有源 IP,没有可信 sandbox ID。

### 5.2 `GetByHostPort`

```go
func (m *Map) GetByHostPort(hostPort string) (*Sandbox, error) {
    reqIP, _, err := net.SplitHostPort(hostPort)
    if err != nil { ... }

    sbx, ok := m.network.Get(reqIP)
    if !ok { ... }
    return sbx, nil
}
```

Gin 的 `Request.RemoteAddr` 通常是 `IP:ephemeral-port`;lookup 会忽略源 port,只用 IP。

### 5.3 索引生命周期

Sandbox 获得网络 slot 后通过 `AssignNetwork` 注册 IP。网络释放时对应 entry 被移除。Hyperloop 能识别一个请求的前提是:

1. 请求确实来自 sandbox veth 路径。
2. 该 IP 仍映射到当前 lifecycle。

---

## 六、GET /me

### 6.1 请求与响应

```http
GET /me HTTP/1.1
Host: 192.0.2.1
```

成功响应:

```json
{
  "sandboxID": "sbx_..."
}
```

流程只有三步:

1. 用 `RemoteAddr` 查询 `sandbox.Map.network`。
2. 读取 `sbx.Runtime.SandboxID`。
3. 返回 200 + `contracts.Me`。

### 6.2 失败

源地址无法解析或 network map 不存在该 IP 时返回:

```text
400 Error when finding source sandbox
```

日志会带解析出的 sandbox IP 和底层错误,响应不会暴露 map 细节。

---

## 七、POST /logs

### 7.1 契约与实际 handler

OpenAPI 只声明该端点接收 JSON 日志,没有定义固定 `requestBody` schema。Handler 使用:

```go
payload := make(map[string]any)
err := c.ShouldBindJSON(&payload)
```

因此 body 可以包含 collector 接受的扩展字段,但必须是 JSON object,并且 `instanceID` 必须存在且为 string。

示例:

```json
{
  "instanceID": "sbx_123",
  "message": "application started",
  "level": "info",
  "fields": {
    "port": 3000
  }
}
```

### 7.2 完整处理顺序

2026.30 版本(`handlers/logs.go:66-170`):

```text
 1. RemoteAddr → sandbox.Map.GetByHostPort                        :68
 2. JSON body → map[string]any                                    :80
 3. payload.instanceID 必须等于来源 sandbox ID                     :87
 4. 过期时间戳检查 → 400 + 丢弃计数（2026.30 新增）                  :97
 5. 覆盖 instanceID/envID/teamID                                   :110-112
 6. 重新 JSON marshal                                              :114
 7. 解析动态路由 route := logWriteConfig.Resolve(ctx)（2026.30 新增） :125
 8. shadow 转发：fire-and-forget goroutine，满则丢弃（2026.30 新增）   :134-157
 9. 主转发 forwardLogs(route.PrimaryURL, route.Timeout)             :160
10. 主转发成功 → 200；失败 → 500                                    :167-169
```

> ⚠️ **顺序很重要**:过期时间戳检查(第 4 步)在**覆盖归属字段之前**、也在**任何转发之前**——所以一条过期日志**不会**产生任何下游请求,只产生一个计数与一条限流 warning。
>
> ⚠️ **shadow 在主转发之前发起**(第 8 步先于第 9 步),但它们是 goroutine,**不阻塞也不影响**主转发的响应。见 §9.5。

### 7.3 服务端覆盖字段

无论调用方传什么值,转发前都会写入:

| 字段 | 可信来源 |
|---|---|
| `instanceID` | `sbx.Runtime.SandboxID` |
| `envID` | `sbx.Runtime.TemplateID` |
| `teamID` | `sbx.Runtime.TeamID` |

这三个字段决定日志归属,不能信任 guest 自报值。

---

## 八、日志 payload 防伪

### 8.1 为什么既验证又覆盖 `instanceID`

只覆盖可以阻止直接伪造,但无法发现生命周期切换中的迟到请求。当前逻辑先要求 payload ID 与源 IP 映射出的 sandbox ID 一致,再统一覆盖所有归属字段。

校验规则:

```text
payload["instanceID"] missing      → 400
payload["instanceID"] not string  → 400
payload instanceID != source ID    → 400
otherwise                          → continue
```

### 8.2 Snapshot/Resume 的迟到日志

源码注释明确指出一种已知场景:旧 snapshot lifecycle 中的 inflight logs 可能带旧 sandbox ID。当前处理是:

- 返回 400。
- 记录 warning 而不是 error。

要彻底消除需要 guest 在 pause 前 flush 并停止发送日志;当前 Hyperloop 没有这样的握手协议。

### 8.3 `envID` 与 `teamID`

这两个字段不要求请求体存在,也不比较请求值,直接由 Runtime metadata 覆盖。这样即使 guest 被修改,也不能把日志写到其他 template/team。

### 8.4 (2026.30 新增) 过期时间戳丢弃

`hasStaleLogTimestamp`(`logs.go:270-286`)检查 payload 的 `timestamp` 是否**早于本 lifecycle 的起点**:

```go
// Matches envd's zerolog timestamp format.
const envdTimestampLayout = time.RFC3339Nano

// Allows normal host/guest clock skew.
const clockSkewTolerance = time.Minute

func hasStaleLogTimestamp(payload map[string]any, lifecycleStart time.Time) bool {
    if lifecycleStart.IsZero() {
        return false
    }
    raw, ok := payload["timestamp"].(string)
    if !ok {
        return false          // 缺 timestamp 或不是 string → 不判过期
    }
    ts, err := time.Parse(envdTimestampLayout, raw)
    if err != nil {
        return false          // 解析失败 → 不判过期
    }
    return ts.Before(lifecycleStart.Add(-clockSkewTolerance))
}
```

触发时(`logs.go:97-107`):

| 项 | 值 |
|---|---|
| HTTP | 400 |
| message | `Log timestamp predates this sandbox's resume` |
| 指标 | `orchestrator.hyperloop.log_forward.write_count` 带 `route=ingest`、`result=dropped`、`reason=stale_timestamp` |
| 日志 | `staleWarnLogger.Warn("dropping envd log with a stale pre-resume timestamp")` |

> ⚠️ **四个反直觉点**:
> 1. **只对 "有 timestamp 且能解析" 的 payload 生效**。缺字段、类型错、格式不对**都放行**——这是一个"能判就判,判不了不拦"的宽松策略,不会因为 guest 换了日志库就丢日志。
> 2. **容忍 1 分钟时钟偏斜**(`clockSkewTolerance`)。所以"比 resume 早 59 秒"的日志**仍会被接受**。
> 3. **比对基准是 `sbx.LifecycleStartedAt`**(`sandbox.go:368`,由 `sandbox.go:1014` / `:1581` 用 `time.Now().UTC()` 赋值),不是 sandbox 创建时间——snapshot/resume 会刷新它,所以 pause 前发出的迟到日志会被正确丢弃。
> 4. **warning 是被限流的**。`staleWarnLogger` 由 `zapcore.NewSamplerWithOptions(core, staleLogWarningInterval, 1, 0)` 包装(`handlers/store.go:38-40`),`staleLogWarningInterval = 30 * time.Second`(`logs.go:45`)。源码注释明确承认了一个已知权衡:*sampler 按 wall clock 分桶,系统时钟回拨后 warning 会持续被抑制,直到时钟追回——静默时长约等于回拨幅度,时钟恢复后自愈*。**每个丢弃都有指标计数,不受限流影响;但 warning 日志会丢,别拿它当计数依据。**

---

## 九、Collector 转发

### 9.1 目标地址

**2026.30 起目标地址是动态的**,由 LD JSON flag `logs-write-config` 解析:

```go
// Resolve log destinations from LaunchDarkly (cached behind a short TTL),
// falling back to the fixed collector address. This lets operators retarget
// logs without a redeploy.
route := h.logWriteConfig.Resolve(ctx)
```

`logWriteConfig` 是 `*featureflags.LogWriteConfigResolver`(`handlers/store.go:30`),由 `NewLogWriteConfigResolver(featureFlags, sandboxCollectorAddr)` 构造(`store.go:50`)。

解析结果 `LogWriteConfig`(`packages/shared/pkg/featureflags/flags.go:946-957`):

| 字段 | 含义 |
|---|---|
| `PrimaryURL` | **同步、决定成败**的目标 |
| `ShadowURLs` | best-effort、fire-and-forget 的附加目标 |
| `Timeout` | 单次写入超时 |
| `MaxInflightShadowWrites` | shadow 并发上限 |

**JSON flag 的形状**(`ResolveLogWriteConfig`,`flags.go:962-1070`):

```json
{
  "mode": "primary_and_shadow",
  "primary_url": "http://...",
  "shadow_urls": ["http://...", "http://..."],
  "timeout_ms": 2000,
  "max_inflight_shadow_writes": 1024
}
```

| 约束 | 值 | 位置 |
|---|---|---|
| 合法 `mode` | `primary_only` / `primary_and_shadow` | `flags.go:913-916` |
| `timeout_ms` 默认 / 上限 | 2000 ms / 10000 ms | `flags.go:920` / `:922` |
| `shadow_urls` 数量上限 | 4 | `flags.go:924` |
| `max_inflight_shadow_writes` 默认 | 1024 | `flags.go:926` |
| flag 求值缓存 TTL | **1 秒** | `logrouting_resolver.go:17` |

> ⚠️ **五条容易踩的规则**:
> 1. **任何一处不合法 → 整个配置回退到 legacy**(只写 `LOGS_COLLECTOR_ADDRESS`,`Timeout = 0`)。触发回退的原因会记在 `log_write_config_resolution_count` 指标的 `reason` label 上:`nil_client` / `null` / `non_object` / `mode_not_string` / `unknown_mode` / `primary_not_string` / `unsafe_primary` / `shadow_not_array` / `too_many_shadows` / `shadow_not_string` / `unsafe_shadow`。
> 2. **`timeout_ms` 只在 flag 显式配置时生效**。legacy 回退路径下 `Timeout = 0`,调用方**跳过** per-request `WithTimeout`,完全依赖 HTTP client 自己的 10 秒超时——源码注释说这是为了"与 flag 出现之前的行为逐字一致"。
> 3. **`shadow_urls` 与 `primary_url` 重复会被去重**(`seen` map 以 primary 预置,`flags.go:1037`)。
> 4. **不安全的 URL 会让整份配置作废**。注释原文:`An unsafe shadow URL invalidates the whole config: fail safe to legacy rather than silently exfiltrating to an external host.`(`flags.go:1046-1047`)。
> 5. **`Resolve` 有 1 秒缓存**,且带双检锁(`logrouting_resolver.go:53-79`)。所以 flag 变更到生效最多滞后 1 秒。

> ⓘ **2026.29 行为**:目标只来自环境变量 `LOGS_COLLECTOR_ADDRESS`,`NewHyperloopStore` 在启动时保存它(`store.go:23` `collectorAddr` 字段)。该字段在 2026.30 **已被删除**,取而代之的是 `logWriteConfig` 与 `shadowInflight atomic.Int64`。

### 9.2 转发请求

2026.30 起统一走 `forwardLogs`(`logs.go:205-235`):

```go
// forwardLogs POSTs the marshaled logs payload to url, bounded by timeout.
func (h *APIStore) forwardLogs(ctx context.Context, url string, payload []byte, timeout time.Duration) error {
    if timeout > 0 {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, timeout)
        defer cancel()
    }
    request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBuffer(payload))
    ...
    request.Header.Set("Content-Type", "application/json")
    response, err := h.collectorClient.Do(request)
    ...
}
```

调用点:`h.forwardLogs(c.Request.Context(), route.PrimaryURL, logs, route.Timeout)`(`logs.go:160`)。

原请求 headers 不会透传。转发只保留重写后的 JSON body 和 `Content-Type`。

### 9.3 下游 status 行为

> ⛔ **2026.29 版本的本文在这里写的是"Hurloop 只检查 `Do` 是否返回 transport error,不检查 collector 的 HTTP status code"——2026.30 起这句话不成立了。**

2026.30 的 `forwardLogs` 在拿到 response 后**会检查状态码**(`logs.go:228-232`):

```go
// Always drain so the transport can reuse the connection; the body itself
// is never surfaced in the returned error (it may echo request content).
drainErr := drainLogForwardResponse(response.Body)

if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
    statusErr := fmt.Errorf("error forwarding sandbox logs: unexpected HTTP status %d", response.StatusCode)
    return errors.Join(statusErr, drainErr)
}
return drainErr
```

因此 `POST /logs` 的响应变为:

| Collector 结果 | Hyperloop 响应(2026.30) | Hyperloop 响应(2026.29) |
|---|---|---|
| 2xx | 200 | 200 |
| 3xx / 4xx / 5xx,但正常收到 response | **500** `Error when forwarding sandbox logs` | 200 |
| DNS/connect/timeout/transport error | 500 | 500 |
| 2xx 但 body drain 失败 | **500** | 200 |

> ⚠️ **两点必须记住**:
> 1. **`response.Body` 永远会被 drain**(`drainLogForwardResponse`,`logs.go:237-243`),即使状态码不对——这样 transport 才能复用连接。
> 2. **body 内容不会进入错误消息**。注释原文:`the body itself is never surfaced in the returned error (it may echo request content)`——**错误消息里只有状态码数字**,排障时要自己去看 collector 的日志。
>
> ⓘ **排查日志丢失的老建议仍然有效**:guest 收到 200 只说明**主转发**拿到了 2xx,**不覆盖 shadow 目标**。见 §9.5。

### 9.4 Response body

Collector response body **读取后被丢弃**(`io.Copy(io.Discard, body)`),不转发给 guest。

> ⓘ 2026.29 版本这里是"不读取、只在 defer 中关闭"。2026.30 改为**必须 drain**,否则 keep-alive 连接会因残留 body 而无法复用。

### 9.5 (2026.30 新增) Shadow 写入

`logs.go:127-157`。当 `mode = primary_and_shadow` 时,每个 `shadow_urls` 目标都会收到一份**独立的、异步的**转发:

```go
maxInflight := route.MaxInflightShadowWrites
if maxInflight <= 0 {
    maxInflight = defaultMaxInflightShadowWrites   // 1024（handlers/store.go:22）
}
for _, shadowURL := range route.ShadowURLs {
    if !h.tryAcquireShadow(maxInflight) {
        recordLogForwardWrite(ctx, "shadow", "dropped", "saturated")
        continue
    }
    recordLogForwardShadowInflight(ctx, 1)
    go func(url string, payload []byte) {
        defer func() {
            h.shadowInflight.Add(-1)
            recordLogForwardShadowInflight(context.WithoutCancel(ctx), -1)
        }()
        shadowCtx := context.WithoutCancel(ctx)
        if err := h.forwardLogs(shadowCtx, url, payload, route.Timeout); err != nil {
            recordLogForwardWrite(shadowCtx, "shadow", "failure", "send_error")
            return
        }
        recordLogForwardWrite(shadowCtx, "shadow", "success", "")
    }(shadowURL, logs)
}
```

> ⚠️ **四个反直觉点**:
> 1. **shadow 的成败绝不影响响应**。源码注释:`Fire-and-forget shadow writes: never affect the response.`
> 2. **`context.WithoutCancel(ctx)`**——这是刻意的:guest 的请求 context 在响应返回后就被取消,如果直接复用,shadow goroutine 会在刚启动时被取消掉。用 `WithoutCancel` 剥掉取消信号,只保留 values。
> 3. **并发上限用 CAS 自旋实现**(`tryAcquireShadow`,`logs.go:172-182`),**拿不到名额就直接丢弃**,不排队、不阻塞。注释解释了原因:*avoid unbounded goroutine growth (and a shadow log storm) under high volume*。
> 4. **丢包有指标**:`recordLogForwardWrite(ctx, "shadow", "dropped", "saturated")`。所以"shadow 目标没收到日志"的第一诊断点就是这个 `reason=saturated`。

**2026.30 新增的两个指标**(`logs.go:25-35`):

| 指标 | 类型 | 标签 |
|---|---|---|
| `orchestrator.hyperloop.log_forward.write_count` | Int64Counter | `route`(`ingest` / `primary` / `shadow`)、`result`(`success` / `failure` / `dropped`)、`reason`(`stale_timestamp` / `saturated` / `send_error` / 空) |
| `hyperloop_log_forward_shadow_inflight` | Int64UpDownCounter | 无(当前在途 shadow 转发数) |

> ⓘ 注意 `route=ingest` 只用于 §8.4 的过期时间戳丢弃——它表示"还没进入转发阶段就被丢掉了"。

---

## 十、envd、MMDS 与客户端发现

Hyperloop 地址通过两条路径进入 guest,用途不同。

### 10.1 envd `/init`

Orchestrator 调 envd `/init` 时发送:

```json
{
  "hyperloopIP": "192.0.2.1"
}
```

envd 异步执行 `SetupHyperloop`:

1. 更新 `/etc/hosts`,令 `events.e2b.local` 指向该 IP。
2. 设置默认环境变量:

```text
E2B_EVENTS_ADDRESS=http://192.0.2.1
```

用户进程由 envd 启动时可继承这个地址。

### 10.2 Firecracker MMDS

Cold boot/reboot 路径会在 MMDS 写入:

```json
{
  "instanceID": "...",
  "envID": "...",
  "address": "http://192.0.2.1/logs",
  "accessTokenHash": "..."
}
```

`address` 是直接的 `/logs` collector URL。字段名是兼容契约,不能随 Go struct 字段名任意改变。

### 10.3 `/me`

当 guest 只知道 Hyperloop address 而不知道可信 sandbox ID 时,可调用 `/me` 从网络身份反查。

---

## 十一、错误处理

错误体复用共享 API error 格式:

```json
{
  "code": 400,
  "message": "..."
}
```

| 阶段 | HTTP | Client message |
|---|---:|---|
| 源 IP 无法映射 sandbox | 400 | `Error when finding source sandbox` |
| JSON 解析失败 | 400 | `Invalid body for logs` |
| instanceID 缺失/类型错误/不匹配 | 400 | `Invalid sandboxID in logs payload` |
| **时间戳早于本 lifecycle(2026.30 新增)** | **400** | **`Log timestamp predates this sandbox's resume`** |
| payload JSON marshal 失败 | 500 | `Error when parsing logs payload` |
| collector request 构造失败 | 500 | `Error when creating request to forwarding sandbox logs` |
| collector transport/timeout | 500 | `Error when forwarding sandbox logs` |
| **collector 返回非 2xx(2026.30 行为变更)** | **500** | **`Error when forwarding sandbox logs`** |

`GET /me` 只有第一类 400;`POST /logs` 可能触发全部错误。

---

## 十二、生命周期与并发边界

### 12.1 Network map 与 live map 分离

Hyperloop lookup 不使用 `Map.Get(sandboxID)`,而使用 network index。这允许 map 明确表达:

- Sandbox 是否仍对 API/proxy 可路由。
- 某个 lifecycle 的 cleanup 是否完成。
- 某个源 IP 是否仍属于一个 sandbox。

三个状态不必在同一时刻消失。

### 12.2 IP 复用

网络 slot 会复用,所以 `NetworkReleased` 必须在 slot 交给下一个 sandbox 前移除旧映射。否则新 sandbox 的请求可能错误关联到旧 Runtime metadata。

### 12.3 请求 context

转发 collector 使用原 Gin request context。Guest 断开、server shutdown 或 request 被取消时,下游请求也会取消;此外还受 10 秒 client timeout 限制。

### 12.4 Server shutdown

Hyperloop 与 Orchestrator 生命周期绑定。Factory 把 `hyperloopSrv.Shutdown` 加入 closers,不会作为独立常驻进程继续服务。

---

## 十三、关键时序

### 13.1 Sandbox 初始化 Hyperloop 地址

```text
Orchestrator             envd                    guest filesystem/env
     │                    │
     │ POST /init         │
     │ hyperloopIP=       │
     │ 192.0.2.1          │
     ├───────────────────►│
     │                    │ go SetupHyperloop
     │                    ├─ /etc/hosts: events.e2b.local → 192.0.2.1
     │                    └─ E2B_EVENTS_ADDRESS=http://192.0.2.1
```

### 13.2 `GET /me`

```text
guest             iptables            Hyperloop             sandbox.Map
  │ GET /me          │                    │                       │
  │ dst :80          │                    │                       │
  ├─────────────────►│ REDIRECT :5010     │                       │
  │                  ├───────────────────►│ GetByHostPort         │
  │                  │                    ├──────────────────────►│
  │                  │                    │◄──── Sandbox ─────────┤
  │◄──────────── 200 {sandboxID} ─────────┤                       │
```

### 13.3 `POST /logs`

```text
guest        Hyperloop             sandbox.Map       primary        shadow(s)
  │ POST /logs  │                       │              │               │
  ├────────────►│ source IP lookup      │              │               │
  │             ├──────────────────────►│              │               │
  │             │◄──── Sandbox metadata ┤              │               │
  │             │ validate instanceID                  │               │
  │             │ stale timestamp? ──► 400 (2026.30)   │               │
  │             │ overwrite instanceID/envID/teamID    │               │
  │             │ Resolve(logs-write-config) (2026.30) │               │
  │             │ spawn shadow goroutines ─────────────┼──────────────►│
  │             │ POST sanitized JSON (primary)        │               │
  │             ├─────────────────────────────────────►│               │
  │             │◄──────────── HTTP response ──────────┤               │
  │◄─ 200/500 ──┤  (2xx→200, 非2xx→500；2026.30)       │               │
```

---

## 十四、配置与限制

| 配置/常量 | 默认/值 | 作用 |
|---|---|---|
| `SANDBOX_ORCHESTRATOR_IP` | `192.0.2.1` | Guest 看到的 host 地址 |
| `SANDBOX_HYPERLOOP_PROXY_PORT` | `5010` | Host Hyperloop listen/redirect port |
| `LOGS_COLLECTOR_ADDRESS` | 环境变量,无代码默认值 | `/logs` 转发的 **legacy fallback** 目标(2026.30 起不再是唯一目标) |
| `logs-write-config`(LD flag,2026.30 新增) | `null` → legacy | JSON,覆盖主目标 + shadow 目标 + 超时 + 并发上限 |
| `CollectorExporterTimeout` | 10 秒 | Collector HTTP client timeout(legacy 路径下是唯一超时) |
| `logWriteConfigCacheTTL`(2026.30 新增) | 1 秒 | LD flag 求值缓存 TTL |
| `staleLogWarningInterval`(2026.30 新增) | 30 秒 | 过期时间戳 warning 的 sampler 分桶 |
| `defaultMaxInflightShadowWrites`(2026.30 新增) | 1024 | shadow 并发上限的兜底值 |
| `clockSkewTolerance`(2026.30 新增) | 1 分钟 | 时间戳过期判定的时钟偏斜容忍 |
| `maxUploadLimit` | 256 MiB | Hyperloop request body 上限 |
| Listen address | `0.0.0.0:<port>` | Host 所有接口 |
| Guest target port | 80 | iptables 匹配入口 |

`LOGS_COLLECTOR_ADDRESS` 为空或格式非法时,legacy 路径下 `POST /logs` 会在创建/发送下游请求阶段失败。**2026.30 起如果 `logs-write-config` 配置了合法的 `primary_url`,这个环境变量就不再被使用**(它只作为 `ResolveLogWriteConfig` 的 `fallbackURL`)。

> ⓘ `defaultMaxInflightShadowWrites` 在仓库里**定义了两份**,值都是 1024:`packages/orchestrator/pkg/hyperloopserver/handlers/store.go:22`(handler 侧的兜底)与 `packages/shared/pkg/featureflags/flags.go:926`(resolver 侧的兜底)。

---

## 十五、安全模型

### 15.1 信任根

Hyperloop 不信任:

- Guest 提供的 `teamID`。
- Guest 提供的 `envID`。
- Guest 单独提供的 `instanceID`。

它信任:

1. Linux network namespace/veth/iptables 保证请求来自对应 slot。
2. `sandbox.Map.network` 正确维护 IP → Sandbox 映射。
3. Runtime metadata 由 Orchestrator 创建和持有。

### 15.2 为什么没有 token

该 API 不是公网或跨 cluster API。正常路径只能从 sandbox 私有网络通过定向 redirect 到达,身份已经由源 IP 与 host 维护的 network map 绑定。

这不意味着任意 host 网络请求都安全:服务监听 `0.0.0.0`,部署侧仍需用节点防火墙/网络策略限制非 sandbox 来源。即使外部请求能到端口,没有匹配 network map 的源 IP也会返回 400。

### 15.3 防止跨租户日志污染

防线是两层:

1. payload `instanceID` 必须与源 IP 对应 sandbox 一致。
2. `instanceID/envID/teamID` 在转发前由服务端强制覆盖。

只做其中任意一层都弱于当前组合。

---

## 十六、常见问题与排查

### Q1:Guest 访问 `192.0.2.1` 连接被拒绝

检查:

1. Hyperloop server 是否监听配置端口。
2. sandbox veth 的 PREROUTING redirect 是否存在。
3. destination 是否为 `SANDBOX_ORCHESTRATOR_IP` 且 port 为 80。
4. sandbox 是否仍持有 network slot。

### Q2:`GET /me` 返回 400

查看日志中的 source IP。常见原因:

- 请求不是从 sandbox veth 发出。
- network entry 尚未 Assign。
- lifecycle 正在停止且 network 已释放。
- host/proxy 改写了源地址。

### Q3:`POST /logs` 报 instanceID 不匹配

比较 payload ID 与 source IP 对应的当前 sandbox ID。Pause/snapshot/resume 附近可能是旧 lifecycle 的 inflight request;其他时候应按潜在错误路由或伪造请求排查。

### Q4:Guest 收到 200,但日志系统没有数据

> ⛔ **2026.29 版本的本文在这里写的是"Hyperloop 不检查 collector HTTP status"——2026.30 起这句话不成立**。主转发目标返回非 2xx 会让 `POST /logs` 返 500(见 §9.3)。

2026.30 的排查顺序:

1. **先看 guest 到底收到了什么**。200 → 主目标返回了 2xx;**500 → 主目标返回了非 2xx 或 transport 失败**,直接看 `Error when forwarding sandbox logs`。
2. **确认走的是哪个目标**:查 `log_write_config_resolution_count` 的 `outcome` / `reason` label。如果是 `legacy`,说明 flag 配置不合法,实际写的是 `LOGS_COLLECTOR_ADDRESS`。
3. **如果主目标正常但某个下游没有**:那多半是 **shadow** 目标。查 `orchestrator.hyperloop.log_forward.write_count` 里 `route=shadow` 的 `result` / `reason`(`saturated` = 并发满被丢弃,`send_error` = 转发失败)。**guest 的 200 完全不能说明 shadow 成功。**
4. 最后才看 collector 自身的 access/error log 与 ingestion 状态。

### Q5:`POST /logs` 约 10 秒后返回 500

通常是 collector DNS/connect/response timeout。检查 `LOGS_COLLECTOR_ADDRESS` 和节点到 collector 的网络。

### Q6:用户进程没有 `E2B_EVENTS_ADDRESS`

检查 envd `/init` 是否收到 `hyperloopIP`,`SetupHyperloop` 是否成功写 `/etc/hosts`,以及该进程是否由 envd 在 defaults 更新后启动。

### Q7:为什么访问 host 的 5010 不等同于 sandbox 内访问?

直接访问可能到达 HTTP server,但源 IP通常不在 sandbox network map 中,所以身份 lookup 失败。正常调用必须走 sandbox 网络路径。

### Q8:大日志请求被提前拒绝

单个 Hyperloop request 上限是 256 MiB。上报端应批量但避免超大 body;这不是 collector 的限制,而是 Hyperloop Gin 中间件限制。

---

## 十七、关键文件索引

| 文件 | 职责 |
|---|---|
| [`spec/openapi-hyperloop.yml`](../spec/openapi-hyperloop.yml) | `/me`、`/logs` 契约 |
| [`packages/orchestrator/pkg/hyperloopserver/contracts/cfg.yaml`](../packages/orchestrator/pkg/hyperloopserver/contracts/cfg.yaml) | Gin server/model/spec 生成配置 |
| [`packages/orchestrator/pkg/hyperloopserver/server.go`](../packages/orchestrator/pkg/hyperloopserver/server.go) | HTTP server、中间件、H2C、路由注册 |
| [`packages/orchestrator/pkg/hyperloopserver/handlers/store.go`](../packages/orchestrator/pkg/hyperloopserver/handlers/store.go) | APIStore、collector client、10 秒 timeout、`logWriteConfig` resolver、`shadowInflight` |
| [`packages/orchestrator/pkg/hyperloopserver/handlers/me.go`](../packages/orchestrator/pkg/hyperloopserver/handlers/me.go) | 源 IP → sandbox ID |
| [`packages/orchestrator/pkg/hyperloopserver/handlers/logs.go`](../packages/orchestrator/pkg/hyperloopserver/handlers/logs.go) | JSON 校验、metadata 覆盖、过期时间戳丢弃、动态路由、shadow 转发、collector 转发 |
| [`packages/shared/pkg/featureflags/logrouting_resolver.go`](../packages/shared/pkg/featureflags/logrouting_resolver.go)(2026.30 新增) | `LogWriteConfigResolver`、1 秒 TTL 缓存 |
| [`packages/shared/pkg/featureflags/flags.go`](../packages/shared/pkg/featureflags/flags.go) | `LogsWriteConfigFlag`(`:890`)、`LogWriteConfig`(`:946-957`)、`ResolveLogWriteConfig`(`:962-1070`)、`isSafeLogURL` |
| [`packages/orchestrator/pkg/sandbox/map.go`](../packages/orchestrator/pkg/sandbox/map.go) | network index 与 `GetByHostPort` |
| [`packages/orchestrator/pkg/sandbox/network/network.go`](../packages/orchestrator/pkg/sandbox/network/network.go) | port 80 → Hyperloop port REDIRECT |
| [`packages/orchestrator/pkg/sandbox/network/pool.go`](../packages/orchestrator/pkg/sandbox/network/pool.go) | IP/port 默认配置 |
| [`packages/orchestrator/pkg/sandbox/envd.go`](../packages/orchestrator/pkg/sandbox/envd.go) | `/init` 注入 `HyperloopIP` |
| [`packages/envd/internal/api/init.go`](../packages/envd/internal/api/init.go) | `/etc/hosts` 与 `E2B_EVENTS_ADDRESS` |
| [`packages/orchestrator/pkg/sandbox/fc/process.go`](../packages/orchestrator/pkg/sandbox/fc/process.go) | MMDS logs collector address |
| [`packages/orchestrator/pkg/sandbox/fc/mmds.go`](../packages/orchestrator/pkg/sandbox/fc/mmds.go) | MMDS JSON 字段兼容契约 |
| [`packages/orchestrator/pkg/factories/run.go`](../packages/orchestrator/pkg/factories/run.go) | Hyperloop 启动与 shutdown 装配 |

---

## 附录 A:端点速查

| Method | Path | Body | 成功响应 |
|---|---|---|---|
| GET | `/me` | 无 | 200 `{"sandboxID":"..."}` |
| POST | `/logs` | JSON object,必须含匹配的 string `instanceID`;可选 string `timestamp`(RFC3339Nano,2026.30 起会被比对 lifecycle 起点) | 200,无 body |

## 附录 B:关键不变量

1. Hyperloop 身份由 `RemoteAddr IP → network map` 决定。
2. Guest 目标始终是 orchestrator-in-sandbox IP 的 port 80,host port 由 REDIRECT 隐藏。
3. `/logs` 的 `instanceID` 必须匹配来源 sandbox。
4. `instanceID/envID/teamID` 必须在 host 侧覆盖后才能转发。
5. **主转发**:collector 返回非 2xx 即失败(2026.30 起;2026.29 时非 2xx 也算成功)。
6. **Shadow 转发**:永远不影响 guest 响应,并发满即丢弃(2026.30 新增)。
7. **过期时间戳**:早于 `LifecycleStartedAt - 1min` 的日志在转发前被丢弃并计 400(2026.30 新增)。
8. Network slot 复用前必须清理旧 IP 映射。

