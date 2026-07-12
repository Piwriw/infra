# E2B Client Proxy 详解

> 本文档详细描述 E2B Infrastructure 中 **Client Proxy**(`packages/client-proxy/`)的设计、架构、转发逻辑、与 API / Orchestrator 的协作、auto-resume 流程、连接池与 graceful shutdown。
>
> 适用于希望理解 E2B 数据面流量(sandbox HTTP / WebSocket)如何从公网转发到 Firecracker microVM 的工程师。
>
> **相关文档**:
> - [`api-module.md`](api-module.md) — API 服务(控制面、Edge gRPC server)
> - [`sandbox-management.md`](sandbox-management.md) — Sandbox 管理面
> - [`node-module.md`](node-module.md) — 节点 / 集群 / 服务发现
> - [`template-module.md`](template-module.md) — Template 模版系统

---

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、架构与组件](#三架构与组件)
- [四、HTTP 请求转发生命周期](#四http-请求转发生命周期)
- [五、关键流程时序图](#五关键流程时序图)
- [六、Redis Catalog 与存储](#六redis-catalog-与存储)
- [七、HTTP 路由与错误页](#七http-路由与错误页)
- [八、gRPC 接口(到 API)](#八grpc-接口到-api)
- [九、连接池与连接追踪](#九连接池与连接追踪)
- [十、Graceful Shutdown](#十graceful-shutdown)
- [十一、配置与环境变量](#十一配置与环境变量)
- [十二、Feature Flags](#十二feature-flags)
- [十三、关键代码文件索引](#十三关键代码文件索引)
- [十四、设计要点与演进历史](#十四设计要点与演进历史)
- [十五、常见问题排查](#十五常见问题排查)
- [十六、附录](#十六附录)

---

## 一、概述

### 1.1 服务定位

Client Proxy 是 E2B 数据面的"前门"。客户端 SDK 拿到 sandboxID 之后,所有发往 sandbox 内部 HTTP 服务的流量(REST、WebSocket、SSE 等)都先到这里:

```
                   客户端 SDK / 浏览器
                          │
                          ▼
                    ┌──────────┐
                    │ Traefik  │  (Nomad ingress,catch-all 路由)
                    └────┬─────┘
                         │
                         ▼
                ┌──────────────────┐
                │  Client Proxy    │  ← 本文档
                │  (packages/      │
                │   client-proxy)  │
                └────────┬─────────┘
                         │
            ┌────────────┴────────────┐
            │ 查 Redis sandbox catalog │
            │ miss → 调 API ResumeSandbox (gRPC)
            ▼
    ┌──────────────────────────┐
    │   Orchestrator Proxy     │  (节点上, port 5007)
    │   └─► envd (sandbox)     │
    └──────────────────────────┘
```

控制面流量(创建 / 列出 / 删除 sandbox 等)走 API 服务的 REST 接口,**不** 经过 client-proxy。client-proxy 只关心一件事:**把这个 HTTP 请求转发到 sandbox 实际所在 node 的 5007 端口**(orchestrator proxy 监听)。

### 1.2 在仓库中的位置

| 项 | 路径 |
| --- | --- |
| 模块根 | [`packages/client-proxy/`](../../packages/client-proxy/) |
| 入口 | [`packages/client-proxy/main.go`](../../packages/client-proxy/main.go) (312 行) |
| Go module | [`packages/client-proxy/go.mod`](../../packages/client-proxy/go.mod) |
| Dockerfile | [`packages/client-proxy/Dockerfile`](../../packages/client-proxy/Dockerfile) |
| Makefile | [`packages/client-proxy/Makefile`](../../packages/client-proxy/Makefile) |
| Nomad job 模板 | [`iac/modules/job-client-proxy/jobs/client-proxy.hcl`](../../iac/modules/job-client-proxy/jobs/client-proxy.hcl) |
| CHANGELOG | [`packages/client-proxy/CHANGELOG.md`](../../packages/client-proxy/CHANGELOG.md) |

服务总规模:**801 行** Go 代码(含测试 1024 行)—— 是 E2B 后端最小的服务之一。复杂的转发逻辑都复用 `packages/shared/pkg/proxy/`。

### 1.3 服务名与版本

- `serviceName = "client-proxy"`([`main.go:40`](../../packages/client-proxy/main.go))
- `version = "1.2.0"`([`main.go:45`](../../packages/client-proxy/main.go))
- `commitSHA` 通过 `-ldflags -X=` 在构建时注入(见 §11)

### 1.4 端口

| 用途 | 默认端口 | 配置项 |
| --- | --- | --- |
| HTTP proxy(对外,sandbox 数据面) | 3002 | `PROXY_PORT` |
| Health server(只对 Nomad) | 3003 | `HEALTH_PORT` |

> 注:GCP 生产环境的端口由 Terraform `client_proxy_port` / `client_proxy_health_port` 变量决定,默认 proxy=3002、health=3001(见 §11)。`PROXY_PORT` / `HEALTH_PORT` 环境变量由 Nomad 在 `env` stanza 里从 `NOMAD_PORT_*` 注入。

### 1.5 与 API / Orchestrator 的边界

| 流量类型 | 走哪 |
| --- | --- |
| 控制面 REST API(创建/列出/删除 sandbox 等) | 直连 **API 服务**(端口 80) |
| Sandbox 内 HTTP 服务(数据面) | 走 **Client Proxy**(端口 3002) |
| Auto-resume(sandbox 已 paused,首次访问时唤醒) | Client Proxy → API edge gRPC(5109)→ Orchestrator |

client-proxy **不直接** 访问 PostgreSQL、ClickHouse、Loki。所有"控制面"信息(sandbox 在哪、是否 paused)都通过:
- **Redis sandbox catalog**(路由表,由 API 写入)
- **API edge gRPC**(auto-resume 询问)

---

## 二、核心概念

### 2.1 两种 sandbox 路由方式

Client Proxy 必须从入站 HTTP 请求中提取 `(sandboxID, port)` 元组,有两种机制:

#### 2.1.1 Host-based(子域名编码)

请求形如:
```
GET / HTTP/1.1
Host: 3000-abc123def456.sandbox.e2b.app
       ↑    ↑              ↑
       port sandboxID      shared host domain
```

解析逻辑在 [`packages/shared/pkg/proxy/host.go:parseHost`](../../packages/shared/pkg/proxy/host.go):
1. 取 host 第一段(`.` 之前):`3000-abc123def456`
2. 用 `-` 切分,第一段是 port,第二段是 sandboxID
3. 校验 sandboxID 格式(`id.ValidateSandboxID`)

#### 2.1.2 Header-based(IP host 或共享域名)

请求形如:
```
GET / HTTP/1.1
Host: 127.0.0.1:3002
E2b-Sandbox-Id: abc123def456
E2b-Sandbox-Port: 3000
```

`shouldParseHeaders` ([`host.go:45`](../../packages/shared/pkg/proxy/host.go))判断何时尝试 header 路径:
- 请求 host 是 IP / localhost(`isLocalRequestHost`),或
- 请求 host 以 `sandbox.` 子域开头(`SandboxSharedHostDomain`)

`hasRoutingHeaders` 检查 `E2b-Sandbox-Id` / `E2b-Sandbox-Port` 是否至少有一个出现。两者都必填,缺一个返 400 `Missing header`。

> **关键设计**:`shouldParseHeaders` 让"直连 IP:port" 的本地开发场景和"共享域名"的多租户场景共用同一套 header 路由代码。host-based 路由则要求请求方拥有自己的子域名 DNS 记录。

### 2.2 Sandbox 状态对应路由表的两类条目

| Sandbox 状态 | Redis catalog | 处理方式 |
| --- | --- | --- |
| **Running**(正在某 orchestrator 上跑) | `sandbox:catalog:<id>` 存在,值含 `OrchestratorIP` | 直接转发到 `<OrchestratorIP>:5007` |
| **Paused** 或 never-seen | catalog miss | 调 API edge gRPC `ResumeSandbox` → 拿到 IP → 转发 |
| **Deleted** | API 端的 `ResumeSandbox` 返 NotFound | 返 HTML 错误页 `SandboxNotFound` |

### 2.3 Orchestrator Proxy(端口 5007)

Client Proxy 不直接和 Firecracker microVM 通信,而是转发到 orchestrator node 的 **orchestrator proxy** 端口 5007(`orchestratorProxyPort` 常量, [`proxy.go:29`](../../packages/client-proxy/internal/proxy/proxy.go))。orchestrator 内部再把流量路由到 sandbox 的 envd。

### 2.4 三种连接计数

Client Proxy 暴露三个 OTel UpDownCounter,用于观察连接池健康度:

| Metric | 含义 |
| --- | --- |
| `client_proxy_pool_connections` | 累计已建立的转发连接数(monotonic) |
| `client_proxy_pool_size` | 当前池子里缓存的 `*ProxyClient`(按 `ConnectionKey` 索引)数量 |
| `client_proxy_server_connections` | 当前面向客户端的活跃 socket 数 |

详见 §9。

---

## 三、架构与组件

### 3.1 总体架构

```
                ┌────────────────────────────────────┐
                │       Client Proxy Process         │
                │                                    │
   客户端 ─────►│  http.Server (Proxy)               │
   HTTP/WS     │   │                                │
                │   ▼ handler()                     │
                │   ├─ GetTargetFromRequest         │
                │   │   ├─ parseHost / parseHeaders │
                │   │   └─ (sandboxID, port)        │
                │   ├─ catalogResolution            │
                │   │   ├─ Redis GetSandbox         │
                │   │   │   └─ hit → nodeIP         │
                │   │   └─ miss → handlePausedSandbox│
                │   │       └─ gRPC ResumeSandbox ──┼─► API Edge gRPC :5109
                │   ├─ pool.Get(ConnectionKey)      │
                │   └─ httputil.ReverseProxy.ServeHTTP
                │       └─► http://<nodeIP>:5007    │
                │                                   │
                │  http.Server (Health)             │
                │   └─► 200 "healthy" / 503 "unhealthy"
                └───────────────────────────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │    Redis     │
                    │ sandbox:catalog:<id>
                    └──────────────┘
```

### 3.2 启动顺序

入口 `run()` ([`main.go:50`](../../packages/client-proxy/main.go)):

1. `cfg.Parse()`(详见 §11)。
2. 顶层 ctx + cancel。
3. 生成 `instanceID = uuid.New().String()` 和 `nodeID = env.GetNodeID()`(`NODE_ID` 环境变量)。
4. **Telemetry 初始化**:`telemetry.New(ctx, nodeID, serviceName, commitSHA, version, instanceID)` — `OTEL_COLLECTOR_GRPC_ENDPOINT` 未设时返 NoopClient。
5. `e2bgrpc.StartChannelzSampler(ctx)` — gRPC Channelz 采样。
6. **Logger 初始化**:`logger.NewLogger(...)`,然后 `logger.ReplaceGlobals(ctx, l)`。
7. `signalCtx, sigCancel := signal.NotifyContext(ctx, SIGTERM, SIGINT)`。
8. **Feature Flags**:`featureflags.NewClient()`;`SetServiceName(serviceName)`。
9. **Redis**:`factories.NewRedisClient(ctx, RedisConfig{...})`。
10. **Sandbox catalog**:`e2bcatalog.NewRedisSandboxCatalog(redisClient)`。
11. **ServiceInfo**:`internal.ServiceInfo{}`,初始状态 `Healthy`。
12. **PausedSandboxResumer**:
    - 优先用 `API_INTERNAL_GRPC_ADDRESS`(insecure,内网直连)。
    - 否则用 `API_EDGE_GRPC_ADDRESS`(TLS + OAuth client credentials)。
    - 都没配 → warn,paused sandbox 检查禁用。
    - `NewGRPCPausedSandboxResumer(...)` + `Init(ctx)`(启动 connection observer)。
13. **Client Proxy HTTP server**:`e2bproxy.NewClientProxy(tel.MeterProvider, serviceName, port, catalog, pausedSandboxResumer, featureFlagsClient)` — 返回 `*reverseproxy.Proxy`,内部用 `httputil.ReverseProxy`。
14. **Health HTTP server**:`0.0.0.0:<HealthPort>`,handler 检查 `info.GetStatus() == Healthy` 返 200/503。
15. **closers 列表**:`[featureFlagsClient, catalog]`,如果 resumer 实现 `Closeable` 也追加。
16. **启动 goroutines**(`wg.Go` 是 Go 1.24+ `WaitGroup.Go`):
    - proxy server `ListenAndServe(ctx)`
    - health server `ListenAndServe()`
    - shutdown watcher(<-signalCtx.Done(),详见 §10)
17. `wg.Wait()` → 返回 exit code。

### 3.3 反向代理构造(`NewClientProxy`)

文件:[`packages/client-proxy/internal/proxy/proxy.go:138-252`](../../packages/client-proxy/internal/proxy/proxy.go)

```go
func NewClientProxy(
    meterProvider metric.MeterProvider,
    serviceName string,
    port uint16,
    catalog catalog.SandboxesCatalog,
    pausedSandboxResumer PausedSandboxResumer,
    featureFlagsClient *featureflags.Client,
) (*reverseproxy.Proxy, error) {
    getTargetFromRequest := reverseproxy.GetTargetFromRequest()
    proxy := reverseproxy.New(
        port,
        reverseproxy.ClientProxyRetries,   // = 1(orchestrator 侧已重试)
        idleTimeout,                       // 610s,> GCP LB 的 600s
        func(r *http.Request) (*pool.Destination, error) {
            // 1. 解析 sandboxID + port
            sandboxId, port, err := getTargetFromRequest(r)
            ...
            // 2. 查 Redis catalog(或 miss 时调 API)
            trafficAccessToken := r.Header.Get(proxygrpc.MetadataTrafficAccessToken)
            envdAccessToken := r.Header.Get(proxygrpc.MetadataEnvdHTTPAccessToken)
            nodeIP, err := catalogResolution(ctx, sandboxId, port, trafficAccessToken, envdAccessToken, catalog, pausedSandboxResumer)
            ...
            // 3. 构造 Destination
            url := &url.URL{
                Scheme: "http",
                Host:   net.JoinHostPort(nodeIP, strconv.Itoa(orchestratorProxyPort)),  // :5007
            }
            return &pool.Destination{
                SandboxId:     sandboxId,
                RequestLogger: l,
                SandboxPort:   port,
                ConnectionKey: pool.ClientProxyConnectionKey,  // "client-proxy" 常量
                Url:           url,
                MaskRequestHost: clientProxyMaskRequestHost(...),  // 见 §3.4
            }, nil
        },
        nil,     // *ConnectionLimitConfig,nil = 不限并发
        false,   // disableKeepAlives
    )
    // 4. 注册三个 OTel UpDownCounter(§9)
    ...
}
```

`reverseproxy.New` 在 [`packages/shared/pkg/proxy/proxy.go:46`](../../packages/shared/pkg/proxy/proxy.go) 实现,返回的 `*Proxy` 嵌入 `http.Server`,开启 H2C(`httpserver.ConfigureH2C`),并把 handler 设为 `handler(p, getDestination, connLimitConfig)`(详见 §4)。

### 3.4 Host masking(combined host vs separate host)

文件:[`packages/client-proxy/internal/proxy/proxy.go:65-74`](../../packages/client-proxy/internal/proxy/proxy.go)

```go
func clientProxyMaskRequestHost(ctx context.Context, featureFlags *featureflags.Client, host string, sandboxID string, port uint64) *string {
    domain, sharedHost := reverseproxy.SandboxSharedHostDomain(host)
    if !sharedHost || featureFlags.BoolFlag(ctx, featureflags.OrchAcceptsCombinedHostFlag) {
        return nil
    }
    orchestratorHost := fmt.Sprintf("%d-%s.%s", port, sandboxID, domain)
    return &orchestratorHost
}
```

**作用**:当 client-proxy 收到的请求 host 是 `sandbox.e2b.app`(共享域名,而不是 `<port>-<sandboxID>.sandbox.e2b.app` 这种已经编码好的)时,把转发给 orchestrator 的 host 重写成 `<port>-<sandboxID>.<domain>`。这是因为 orchestrator proxy 同样用 host-based 路由识别 sandbox。

如果 LD flag `orch-accepts-combined-host` = true(orchestrator 已升级到接受"合并 host"),则不需要 mask,直接透传原 host。

详见 §12。

---

## 四、HTTP 请求转发生命周期

### 4.1 handler 链(`shared/pkg/proxy/handler.go`)

文件:[`packages/shared/pkg/proxy/handler.go`](../../packages/shared/pkg/proxy/handler.go)

每个请求都走 `handler(p, getDestination, connLimitConfig)`,完整流程:

```
┌── 接受连接(tracking.Listener.Accept 计数 +1)──┐
│                                                  │
▼  http.Server 内部                                 │
handler(w, r):                                     │
  │                                                │
  ├─ d, err := getDestination(r)                   │
  │   └─ (调用 NewClientProxy 注册的闭包,见 §3.3) │
  │                                                 │
  ├─ 错误分支(逐个 errors.As 处理):               │
  │   ├─ MissingHeaderError         → 400 + 文本   │
  │   ├─ ErrInvalidHost             → 400 + 文本   │
  │   ├─ ErrInvalidSandboxID        → 400 + 文本   │
  │   ├─ InvalidSandboxPortError    → 400 + 文本   │
  │   ├─ SandboxNotFoundError       → 502 HTML    │
  │   ├─ SandboxResumePermissionDeniedError → HTML │
  │   ├─ SandboxStillTransitioningError    → HTML │
  │   ├─ SandboxResourceExhaustedError    → HTML  │
  │   ├─ MissingTrafficAccessTokenError   → HTML  │
  │   ├─ InvalidTrafficAccessTokenError   → HTML  │
  │   └─ 其他                       → 500 + 文本   │
  │                                                 │
  ├─ 连接限流(本服务 nil,跳过)                   │
  │                                                 │
  ├─ proxy := p.Get(ctx, d)                        │
  │   └─ 按 d.ConnectionKey 从 smap 查/建 ProxyClient │
  │                                                 │
  └─ proxy.ServeHTTP(w, r)                          │
      └─ httputil.ReverseProxy:                     │
          ├─ Rewrite: r.SetURL(d.Url)               │
          │           r.Out.Host = d.MaskRequestHost │
          │           或 r.In.Host                  │
          ├─ Transport.DialContext (重试 1 次)      │
          ├─ 转发 request body                      │
          ├─ 流式转发 response                      │
          └─ ModifyResponse: 记录 status code 日志  │
└── 连接关闭(tracking.Connection.Close 计数 -1)──┘
```

### 4.2 转发 URL 构造

对于每个请求,`Destination.Url` 都是:
```
http://<nodeIP>:5007
```

`nodeIP` 来源:
- **catalog hit**:Redis `sandbox:catalog:<id>` 中 `SandboxInfo.OrchestratorIP`。
- **catalog miss**:调 API `ResumeSandbox` gRPC 返回的 `OrchestratorIp`。

`sandboxPort`(sandbox 内的目标端口)不放在 URL 里,而是通过 host masking 透传给 orchestrator(orchestrator 内部再路由到 sandbox)。

### 4.3 Dial 重试(`ClientProxyRetries = 1`)

文件:[`packages/shared/pkg/proxy/pool/client.go:53-91`](../../packages/shared/pkg/proxy/pool/client.go)

```go
DialContext: func(ctx, network, addr string) (net.Conn, error) {
    maxAttempts := max(maxConnectionAttempts, 1)
    for attempt := range maxAttempts {
        conn, err = (&net.Dialer{
            Timeout:   30 * time.Second,
            KeepAlive: 20 * time.Second,
        }).DialContext(ctx, network, addr)

        if err == nil {
            totalConnsCounter.Add(1)
            return tracking.NewConnection(conn, currentConnsCounter, activeConnections), nil
        }
        if ctx.Err() != nil {
            return nil, ctx.Err()
        }
        if attempt < maxAttempts-1 {
            // Linear backoff: 100ms, 200ms, 300ms, ...
            backoff := time.Duration(100*(attempt+1)) * time.Millisecond
            select {
            case <-time.After(backoff):
            case <-ctx.Done():
                return nil, ctx.Err()
            }
        }
    }
    return nil, err
}
```

**关键注释**:重试是为了应对 sandbox envd 的"端口转发延迟"——当 sandbox 内的进程绑定到 localhost,需要 ~1s 时间被端口扫描器发现并启动 socat 转发到 host IP。client-proxy 默认 `ClientProxyRetries = 1`(只重试一次),因为 orchestrator proxy 那一层还有更激进的重试(`SandboxProxyRetries = 5`)。

### 4.4 Idle timeout

```go
// packages/client-proxy/internal/proxy/proxy.go:34
idleTimeout = 610 * time.Second
```

故意大于 GCP LB 的 600s upstream keepalive,避免 race condition。注释链接到 [GCP LB 文档](https://cloud.google.com/load-balancing/docs/https#timeouts_and_retries)。

shared 层 `proxy.New` 还会在 `idleTimeout` 基础上加 `idleTimeoutBufferUpstreamDownstream = 10s`(见 [`proxy.go:68`](../../packages/shared/pkg/proxy/proxy.go)),保证 downstream(client 侧)idle timeout 严格大于 upstream(orchestrator 侧),防止"server 已关连接,client 还想复用"的 race。

### 4.5 客户端 IP 透传

`Rewrite` 函数 **不** 用 `SetX forwarded`(`packages/shared/pkg/proxy/pool/client.go:117`):

```go
// We are **not** using SetXForwarded() because servers can sometimes modify
// the content-location header to be http which might break some customer services.
r.Out.Host = r.In.Host
```

只在 `MaskRequestHost` 不为 nil 时,设 `X-Forwarded-Host: r.In.Host` 然后改写 `r.Out.Host`。

---

## 五、关键流程时序图

### 5.1 Running sandbox 转发(catalog hit)

```
Client                 Client-Proxy              Redis              Orchestrator (port 5007)
  │                         │                       │                        │
  │ HTTP request            │                       │                        │
  │ Host: 3000-sbx.sandbox. │                       │                        │
  │       e2b.app           │                       │                        │
  ├────────────────────────►│                       │                        │
  │                         │                       │                        │
  │                         │ GetTargetFromRequest  │                        │
  │                         │  parseHost →          │                        │
  │                         │  (sbx, 3000)          │                        │
  │                         │                       │                        │
  │                         │ catalog.GetSandbox ──►│                        │
  │                         │ ◄─── SandboxInfo ─────┤                        │
  │                         │      {IP: 10.0.0.5}   │                        │
  │                         │                       │                        │
  │                         │ Destination{Url: http://10.0.0.5:5007, ...}   │
  │                         │ pool.Get("client-proxy") → ProxyClient         │
  │                         │ ReverseProxy.ServeHTTP ───────────────────────►│
  │                         │                                                │      │
  │                         │                                          envd →│      │
  │                         │                                                │      │
  │                         │ ◄──────── HTTP response ──────────────────────┤      │
  │ ◄──────── HTTP response │                                                │      │
```

### 5.2 Paused sandbox auto-resume

```
Client         Client-Proxy                API Edge gRPC         Orchestrator       Redis
  │                │                           │                      │                │
  │ HTTP request   │                           │                      │                │
  │ (sandbox已paused)                         │                      │                │
  ├───────────────►│                           │                      │                │
  │                │ GetTargetFromRequest → (sbx, port)               │                │
  │                │ catalog.GetSandbox ─────────────────────────────────────────────►│
  │                │ ◄──── ErrSandboxNotFound ────────────────────────────────────────┤
  │                │                           │                      │                │
  │                │ handlePausedSandbox:      │                      │                │
  │                │  pausedChecker.Resume(...)│                      │                │
  │                │  ─ build metadata:        │                      │                │
  │                │    e2b-sandbox-request-port                       │                │
  │                │    e2b-traffic-access-token (if any)              │                │
  │                │    X-Access-Token (envd, if any)                  │                │
  │                │  ─ OAuth Token() (client_credentials)            │                │
  │                │    scope=sandboxes:lifecycle                     │                │
  │                │  ResumeSandbox(sandbox_id) ─────────────────────►│                │
  │                │                           │  Verify OIDC         │                │
  │                │                           │  scope               │                │
  │                │                           │  取 snapshot         │                │
  │                │                           │  验证 team           │                │
  │                │                           │  检查 blocked        │                │
  │                │                           │  HandleExisting-     │                │
  │                │                           │   SandboxAutoResume  │                │
  │                │                           │   or startSandbox-   │                │
  │                │                           │   Internal (resume)─►│ 启动 VM        │
  │                │                           │                      │ 写 Redis ─────►│
  │                │                           │ ◄────────────────────┤                │
  │                │ ◄─── OrchestratorIp ──────┤                      │                │
  │                │                           │                      │                │
  │                │ Destination{Url: http://<nodeIP>:5007}           │                │
  │                │ ReverseProxy.ServeHTTP ─────────────────────────►│                │
  │ ◄──── HTTP response (来自 sandbox)        │                      │                │
```

### 5.3 Sandbox resume 失败的错误分支

`handlePausedSandbox`([`proxy.go:97-136`](../../packages/client-proxy/internal/proxy/proxy.go))把 gRPC 错误码映射到本地 error:

| gRPC Code / 条件 | 本地 error | 客户端看到 |
| --- | --- | --- |
| `PermissionDenied` | `SandboxResumePermissionDeniedError` | HTML 错误页(403 类) |
| `NotFound` | `autoResumeNotAllowed` + `ErrNodeNotFound` | HTML 错误页 "Sandbox not found" |
| `FailedPrecondition` + message="sandbox is still transitioning" | `SandboxStillTransitioningError` | HTML 错误页 "Still transitioning" |
| `ResourceExhausted` | `SandboxResourceExhaustedError` | HTML 错误页 "Team sandbox limit" |
| 其他 | `autoResumeErrored` + 原 error | 500 / 502 |

---

## 六、Redis Catalog 与存储

### 6.1 SandboxesCatalog interface

文件:[`packages/shared/pkg/sandbox-catalog/catalog.go`](../../packages/shared/pkg/sandbox-catalog/catalog.go)

```go
type SandboxInfo struct {
    OrchestratorID    string    `json:"orchestrator_id"`
    OrchestratorIP    string    `json:"orchestrator_ip"` // used only for cases where orchestrator is not registered in edge pool
    ExecutionID       string    `json:"execution_id"`
    StartedAt         time.Time `json:"sandbox_started_at"`
    MaxLengthInHours  int64     `json:"sandbox_max_length_in_hours"`
}

type SandboxesCatalog interface {
    GetSandbox(ctx, sandboxID) (*SandboxInfo, error)
    StoreSandbox(ctx, sandboxID string, sandboxInfo *SandboxInfo, expiration time.Duration) error
    DeleteSandbox(ctx, sandboxID, executionID string) error
    Close(ctx) error
}
```

client-proxy 只调 `GetSandbox`(以及 `Close`)。`StoreSandbox` / `DeleteSandbox` 由 API 服务(orchestrator client)调用。

### 6.2 Redis 实现

文件:[`packages/shared/pkg/sandbox-catalog/catalog_redis.go`](../../packages/shared/pkg/sandbox-catalog/catalog_redis.go)

```go
const catalogRedisTimeout = 1 * time.Second

func (c *RedisSandboxCatalog) getCatalogKey(sandboxID string) string {
    return fmt.Sprintf("sandbox:catalog:%s", sandboxID)
}
```

- **GetSandbox**:1s 超时;`redis.Nil` → `ErrSandboxNotFound`;JSON unmarshal 失败 → wrapped error。
- **StoreSandbox**:JSON marshal 后 `SET key value EX <expiration>`。
- **DeleteSandbox**:先 `GET` 检查 `ExecutionID` 是否匹配(防止"同 ID 不同执行"被误删),再 `DEL`。
- **Close**:no-op(共享连接由 main.go 的 `factories.CloseCleanly(redisClient)` 关)。

### 6.3 数据生命周期

| 事件 | 谁写 Redis | TTL |
| --- | --- | --- |
| Sandbox 启动(catalog.StoreSandbox) | API(orchestrator client) | sandbox 配置的最大生命周期(小时级) |
| Sandbox pause / kill | API(orchestrator client) | 立即 `DeleteSandbox`(若 ExecutionID 匹配) |
| Auto-resume 完成 | API(orchestrator client) | 重新 `StoreSandbox` |

client-proxy **永远只读**。

### 6.4 Redis 客户端配置

由 `factories.NewRedisClient` 构造(见 [`packages/shared/pkg/factories/redis.go`](../../packages/shared/pkg/factories/redis.go)):

```go
redisClient, err := factories.NewRedisClient(ctx, factories.RedisConfig{
    RedisURL:         config.RedisURL,
    RedisClusterURL:  config.RedisClusterURL,
    RedisTLSCABase64: config.RedisTLSCABase64,
    PoolSize:         config.RedisPoolSize,  // 默认 40(本服务比 API 的 160 小)
})
```

详见 §11。

---

## 七、HTTP 路由与错误页

### 7.1 路由

Client Proxy **没有路由表**,catch-all 所有 HTTP 方法 + path。Traefik 在 Nomad job 里用 `PathPrefix("/")` + `priority=100` 把所有未匹配的请求路由到这里(见 [`iac/modules/job-client-proxy/jobs/client-proxy.hcl:46-55`](../../iac/modules/job-client-proxy/jobs/client-proxy.hcl)):

```hcl
service {
  name = "client-proxy"
  port = "proxy"
  tags = [
    "traefik.enable=true",
    "traefik.http.routers.client-proxy.entrypoints=${entrypoints}",
    "traefik.http.routers.client-proxy.rule=PathPrefix(`/`)",
    "traefik.http.routers.client-proxy.ruleSyntax=v2",
    "traefik.http.routers.client-proxy.priority=100",
    "traefik.http.services.client-proxy.loadbalancer.server.port=$${NOMAD_PORT_proxy}"
  ]
}
```

`entrypoints` 由 `exposure_type` 决定:
- `public` → `web`(对公网开放)
- `private` → `internal`(只内网)
- `both` → `web,internal`(默认)

### 7.2 健康检查路由

独立的 HTTP server 在 `0.0.0.0:<HealthPort>`:

```go
// main.go:177
healthHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
    if info.GetStatus() == internal.Healthy {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("healthy"))
        return
    }
    w.WriteHeader(http.StatusServiceUnavailable)
    w.Write([]byte("unhealthy"))
})
```

Nomad service check:`/health` 每 3s,timeout 3s(见 [`client-proxy.hcl:57-64`](../../iac/modules/job-client-proxy/jobs/client-proxy.hcl))。

### 7.3 HTML 错误页

文件:[`packages/shared/pkg/proxy/template/`](../../packages/shared/pkg/proxy/template/)

每种错误都对应一个 embedded HTML 文件(`//go:embed browser_*.html`),渲染成用户友好的错误页。文件清单:

| HTML 文件 | 触发条件 | HTTP 状态 |
| --- | --- | --- |
| `browser_sandbox_not_found.html` | catalog miss + API 返 NotFound | 502 |
| `browser_sandbox_resume_permission_denied.html` | API 返 PermissionDenied | (template 决定) |
| `browser_sandbox_still_transitioning.html` | API 返 FailedPrecondition "still transitioning" | (template 决定) |
| `browser_sandbox_too_many_connections.html` | 连接限流命中(本服务 nil,不触发) | 429 |
| `browser_team_sandbox_limit.html` | API 返 ResourceExhausted | (template 决定) |
| `browser_port_closed.html` | 端口未监听(由 `DefaultToPortError` 决定) | (template 决定) |
| `browser_traffic_access_token_missing_error.html` | 缺 traffic access token | (template 决定) |
| `browser_traffic_access_token_invalid_error.html` | traffic access token 无效 | (template 决定) |

每个 HTML 都通过对应的 `*.go` 构造器(如 [`sandbox_not_found.go`](../../packages/shared/pkg/proxy/template/sandbox_not_found.go))返回 `*TemplatedError[T]`,统一接口。

> **设计目的**:用户在浏览器里访问 sandbox URL 看到失败时,不是冷冰冰的 JSON / plain text,而是带 sandboxID、原因、host 的可读 HTML 页面。

### 7.4 错误类型清单

文件:[`packages/shared/pkg/proxy/errors.go`](../../packages/shared/pkg/proxy/errors.go)

```go
var (
    ErrInvalidHost      = errors.New("invalid url host")
    ErrInvalidSandboxID = errors.New("invalid sandbox ID")
)

type InvalidSandboxPortError struct { ... }
type SandboxNotFoundError struct { SandboxId string }
type SandboxResumePermissionDeniedError struct { SandboxId string }
type SandboxStillTransitioningError struct { SandboxId string }
type MissingTrafficAccessTokenError struct { SandboxId, Header string }
type InvalidTrafficAccessTokenError struct { SandboxId, Header string }
type SandboxResourceExhaustedError struct { SandboxId, Message string }
```

每个都有 `NewErr*` 构造器,client-proxy 在 §5.3 的错误映射中产出这些类型,handler 再 `errors.As` 分发到对应的 HTML 页面。

---

## 八、gRPC 接口(到 API)

### 8.1 概览

Client Proxy 是 gRPC **client**(只调 API 的 edge gRPC `ResumeSandbox`),不是 gRPC server。

| 端点 | 用途 | 凭证 |
| --- | --- | --- |
| `API_INTERNAL_GRPC_ADDRESS`(优先,default port 5009) | 内网直连,insecure | 无 |
| `API_EDGE_GRPC_ADDRESS`(fallback,default port 5109) | TLS + OAuth client credentials | OIDC |

### 8.2 proto 定义

文件:[`packages/shared/pkg/grpc/proxy/proxy.proto`](../../packages/shared/pkg/grpc/proxy/proxy.proto)

```protobuf
message SandboxResumeRequest {
  string sandbox_id = 1;
  reserved 2;
  reserved "timeout_seconds";
}

message SandboxResumeResponse {
  string orchestrator_ip = 1;
}

service SandboxService {
  rpc ResumeSandbox(SandboxResumeRequest) returns (SandboxResumeResponse);
}
```

`timeout_seconds` 字段在 v1.x 之后已废弃(`reserved`)。

### 8.3 gRPC metadata(请求级)

文件:[`packages/shared/pkg/grpc/proxy/metadata.go`](../../packages/shared/pkg/grpc/proxy/metadata.go)

```go
const (
    MetadataTrafficAccessToken     = "e2b-traffic-access-token"
    MetadataSandboxRequestPort     = "e2b-sandbox-request-port"
    MetadataEnvdAccessToken        = "e2b-envd-access-token"
    MetadataAuthorization          = "authorization"
    ScopeSandboxLifecycle          = "sandboxes:lifecycle"
    MetadataEnvdHTTPAccessToken    = "X-Access-Token"   // 注意:HTTP header 风格
)
```

`Resume` 方法在每次调用时附加 metadata(见 [`paused_sandbox_resumer_grpc.go:73-83`](../../packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go)):

```go
func (c *grpcPausedSandboxResumer) Resume(ctx, sandboxId, sandboxPort, trafficAccessToken, envdAccessToken) (string, error) {
    ctx = metadata.AppendToOutgoingContext(ctx, proxygrpc.MetadataSandboxRequestPort, strconv.FormatUint(sandboxPort, 10))
    if trafficAccessToken != "" {
        ctx = metadata.AppendToOutgoingContext(ctx, proxygrpc.MetadataTrafficAccessToken, trafficAccessToken)
    }
    if envdAccessToken != "" {
        ctx = metadata.AppendToOutgoingContext(ctx, proxygrpc.MetadataEnvdAccessToken, envdAccessToken)
    }
    ctx, err := c.auth.authorize(ctx)  // 加 OAuth Bearer
    ...
    resp, err := c.client.ResumeSandbox(ctx, &proxygrpc.SandboxResumeRequest{SandboxId: sandboxId})
    return strings.TrimSpace(resp.GetOrchestratorIp()), nil
}
```

这些 metadata 来自客户端 HTTP 请求的 headers(`e2b-traffic-access-token`、`X-Access-Token`),透传给 API,API 再传给 orchestrator 用于 envd 鉴权。

### 8.4 OAuth client credentials

文件:[`packages/client-proxy/internal/proxy/grpc_resume_auth.go`](../../packages/client-proxy/internal/proxy/grpc_resume_auth.go)

```go
const grpcResumeAuthScope = proxygrpc.ScopeSandboxLifecycle  // "sandboxes:lifecycle"

type oauthGrpcResumeAuth struct {
    tokenSource oauth2.TokenSource
}

func newGrpcResumeAuth(ctx, c GRPCOAuthConfig) (grpcResumeAuth, error) {
    if !c.Enabled() {
        return noopGrpcResumeAuth{}, nil
    }
    if strings.TrimSpace(c.ClientID) == "" || ... {
        return nil, errors.New("api grpc OAuth client ID, client secret, and token URL are required when OAuth is configured")
    }
    oauthConfig := clientcredentials.Config{
        ClientID:     strings.TrimSpace(c.ClientID),
        ClientSecret: strings.TrimSpace(c.ClientSecret),
        TokenURL:     strings.TrimSpace(c.TokenURL),
        Scopes:       []string{grpcResumeAuthScope},
    }
    return oauthGrpcResumeAuth{tokenSource: oauthConfig.TokenSource(ctx)}, nil
}

func (a oauthGrpcResumeAuth) authorize(ctx context.Context) (context.Context, error) {
    token, err := a.tokenSource.Token()
    if err != nil {
        return ctx, fmt.Errorf("get api grpc OAuth token: %w", err)
    }
    return metadata.AppendToOutgoingContext(ctx, proxygrpc.MetadataAuthorization, "Bearer "+token.AccessToken), nil
}
```

**关键设计**:
- `Enabled()` 三件套(ClientID/ClientSecret/TokenURL)任一非空就视为"配置了",然后三者必须齐全。
- 没配 → `noopGrpcResumeAuth{}`(空实现,authorize 直接返 ctx)。
- 每次 Resume 都 `Token()` 取一次新 token(`clientcredentials` 内部缓存)。
- Token scope 严格 = `sandboxes:lifecycle`,API 端会校验这个 scope(见 [`api-module.md` §5.3](api-module.md))。

### 8.5 Connection observer

```go
// paused_sandbox_resumer_grpc.go:65
func (c *grpcPausedSandboxResumer) Init(ctx context.Context) {
    e2bgrpc.ObserveConnection(ctx, c.conn, "api-resumer")
}
```

`e2bgrpc.ObserveConnection`([`packages/shared/pkg/grpc/connobserver.go:43`](../../packages/shared/pkg/grpc/connobserver.go))把 conn 注册到 Channelz,配合 `StartChannelzSampler` 周期采样,把 gRPC 连接状态(IDLE / CONNECTING / READY / TRANSIENT_FAILURE)上报到 OTel metric。

---

## 九、连接池与连接追踪

### 9.1 ProxyPool

文件:[`packages/shared/pkg/proxy/pool/pool.go`](../../packages/shared/pkg/proxy/pool/pool.go)

```go
const (
    hostConnectionSplit = 4
    ClientProxyConnectionKey = "client-proxy"  // 常量
)

type ProxyPool struct {
    pool                  *smap.Map[*ProxyClient]
    maxClientConns        int                 // 16384
    maxConnectionAttempts int
    idleTimeout           time.Duration
    totalConnsCounter     atomic.Uint64
    currentConnsCounter   atomic.Int64
    disableKeepAlives     bool
}
```

`ProxyClient` 嵌入 `httputil.ReverseProxy`,内部用 `http.Transport`。

### 9.2 ConnectionKey

```go
// pool/destination.go:25
// ConnectionKey uniquely identifies a single sandbox lifecycle. It is
// used for two purposes:
//   1. keepalive connection pool isolation, so connections to a reused
//      IP:port pair are not accidentally shared across sandboxes;
//   2. per-sandbox ingress connection limiter accounting.
```

client-proxy 用常量 `ClientProxyConnectionKey = "client-proxy"`,即 **所有 sandbox 共享一个连接池**。

> **为什么 client-proxy 不需要按 sandbox 分池?** 注释明确说:"we don't have to separate connection pools as we need to do when connecting to sandboxes (from orchestrator proxy) to prevent reuse of pool connections by different sandboxes cause failed connections."
>
> 原因:client-proxy 的 upstream 是 orchestrator proxy(单个固定 IP:5007),orchestrator 那一层再按 sandbox 分池。orchestrator proxy(走 `SandboxProxyRetries = 5`)才是真正"贴近 sandbox"的层。

### 9.3 每主机连接数上限

```go
// pool/pool.go:73-79
// We limit the max number of connections per host to avoid exhausting the number of available via one host.
func() int {
    if p.maxClientConns <= hostConnectionSplit {
        return p.maxClientConns
    }
    return p.maxClientConns / hostConnectionSplit  // 16384 / 4 = 4096
}(),
```

`MaxIdleConnsPerHost = 4096`,防一个 orchestrator node 把 client-proxy 的所有 idle 连接都吃光。

### 9.4 连接追踪

文件:[`packages/shared/pkg/proxy/tracking/`](../../packages/shared/pkg/proxy/tracking/)

`Listener` wrap net.Listener,`Accept` 时把连接包成 `tracking.Connection`,持有 `*atomic.Int64` 计数器:

```go
// tracking/connection.go:22
func NewConnection(conn net.Conn, counter *atomic.Int64, m *smap.Map[*Connection]) *Connection {
    counter.Add(1)
    ...
}

func (c *Connection) Close() error {
    err := c.Conn.Close()
    if err != nil {
        return err
    }
    c.counter.Add(-1)
    ...
}
```

`m` 是 active connections map(只在 sandbox proxy 场景下用,client-proxy 传 nil)。

`Reset()` 用 `SetLinger(0)` 强制 RST 关闭(用于"打洞"重连场景)。

### 9.5 三个连接 metric

[`proxy.go:217-249`](../../packages/client-proxy/internal/proxy/proxy.go) 注册:

```go
telemetry.GetObservableUpDownCounter(
    meter, telemetry.ClientProxyPoolConnectionsMeterCounterName,
    func(_ context.Context, observer metric.Int64Observer) error {
        observer.Observe(proxy.CurrentPoolConnections())  // 池里活跃连接
        return nil
    },
)
// 同样注册 ClientProxyPoolSizeMeterCounterName(pool 大小)
// 同样注册 ClientProxyServerConnectionsMeterCounterName(面向客户端的活跃 socket)
```

- `CurrentPoolConnections()` = `pool.CurrentConnections()`(transport 层的 `currentConnsCounter`,每次 `DialContext` +1,`Close` -1)
- `CurrentPoolSize()` = `pool.Size()`(smap 里 `*ProxyClient` 数量,通常 1)
- `CurrentServerConnections()` = `proxy.currentServerConnsCounter`(`tracking.Listener` 维护,面向客户端的活跃 socket)

---

## 十、Graceful Shutdown

文件:[`main.go:250-302`](../../packages/client-proxy/main.go)

### 10.1 三阶段状态机

`ServiceInfo.status` 是 `Healthy / Draining / Unhealthy` 三态(见 [`internal/info.go`](../../packages/client-proxy/internal/info.go))。

```
正常态:    Healthy
              │
              │ SIGTERM/SIGINT(<-signalCtx.Done())
              ▼
阶段 1:    Draining       (info.SetStatus)
              │
              │ sleep shutdownDrainingWait = 15s
              ▼
           (proxy.Shutdown,等待连接排空,最多 24h)
              │
              ▼
阶段 2:    Unhealthy     (info.SetStatus)
              │
              │ sleep shutdownUnhealthyWait = 15s
              ▼
           (healthServer.Shutdown, 5s timeout)
              │
              ▼
阶段 3:    closers 串行 Close()
              │  featureFlagsClient
              │  catalog
              │  pausedSandboxResumer (if Closeable)
              ▼
           进程退出
```

### 10.2 各阶段注释

代码里有详细说明(见 [`main.go:243-249`](../../packages/client-proxy/main.go)):

> Service gracefully shutdown flow
>
> When service shut-downs we need to info all services that depends on us gracefully shutting down existing connections.
> Shutdown phase starts with marking sandbox traffic as draining.
> After that we will wait some time so all dependent services will recognize that we are draining and will stop sending new requests.
> Following phase marks the service as unhealthy, we are waiting for some time to let dependent services recognize new state.
> After some wait proxy server is closed with followed close of health server and calling all registered closers.

### 10.3 关键常量

```go
// main.go:42
shutdownDrainingWait  = 15 * time.Second
shutdownUnhealthyWait = 15 * time.Second
```

### 10.4 proxy.Shutdown 超时 24h

```go
// main.go:262
proxyShutdownCtx, proxyShutdownCtxCancel := context.WithTimeout(ctx, 24*time.Hour)
```

为什么是 24h?因为 client-proxy 持有长连接(WebSocket / sandbox 长任务),最多可以让一个连接挂这么久。Nomad job 的 `kill_timeout = "24h"`(见 §11.4)与这个上限对齐:

```hcl
# iac/modules/job-client-proxy/jobs/client-proxy.hcl:89-91
%{ if update_stanza }
  kill_timeout = "24h"
%{ endif }
```

**注意**:`kill_timeout` 只在 `update_stanza` 启用时注入。冷关闭(整个 job 销毁)走默认 Nomad 行为。

### 10.5 与 API graceful shutdown 的对比

| 项 | API | Client Proxy |
| --- | --- | --- |
| 健康状态 | `atomic.Bool Healthy`(2 态) | `ServiceInfo.status`(3 态) |
| `/health` 行为 | Healthy=false → 503 | status≠Healthy → 503 |
| Drain 等待 | 15s(等 GCP LB) | 15s(等 LB)+ 15s(等"已 unhealthy"传播) |
| Shutdown 超时 | 75s(请求级) | 24h(连接级) |
| 阶段 | Healthy=false → drain → Shutdown → pprof → cleanup | Draining → drain → Unhealthy → proxy.Shutdown → health.Shutdown → closers |

API 的 shutdown 是"请求级"(70s requestTimeout + 5s slack),Client Proxy 是"连接级"(允许长连接排空 24h)。两者反映"控制面 vs 数据面"的根本差异。

---

## 十一、配置与环境变量

### 11.1 配置文件

文件:[`packages/client-proxy/internal/cfg/model.go`](../../packages/client-proxy/internal/cfg/model.go) (24 行)

```go
type Config struct {
    HealthPort uint16 `env:"HEALTH_PORT" envDefault:"3003"`
    ProxyPort  uint16 `env:"PROXY_PORT"  envDefault:"3002"`

    RedisURL         string `env:"REDIS_URL"`
    RedisClusterURL  string `env:"REDIS_CLUSTER_URL"`
    RedisTLSCABase64 string `env:"REDIS_TLS_CA_BASE64"`
    RedisPoolSize    int    `env:"REDIS_POOL_SIZE"     envDefault:"40"`

    APIInternalGRPCAddress string `env:"API_INTERNAL_GRPC_ADDRESS"`
    APIEdgeGRPCAddress     string `env:"API_EDGE_GRPC_ADDRESS"`

    APIEdgeGRPCOAuthClientID     string `env:"API_EDGE_GRPC_OAUTH_CLIENT_ID"`
    APIEdgeGRPCOAuthClientSecret string `env:"API_EDGE_GRPC_OAUTH_CLIENT_SECRET"`
    APIEdgeGRPCOAuthTokenURL     string `env:"API_EDGE_GRPC_OAUTH_TOKEN_URL"`
}
```

用 `caarlos0/env/v11`,无自定义 parser。

### 11.2 环境变量完整清单

#### 端口

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `HEALTH_PORT` | 3003 | 健康检查端口 |
| `PROXY_PORT` | 3002 | HTTP proxy 端口(sandbox 数据面) |

> 注:生产部署中,这两个端口实际由 Nomad 的 `NOMAD_PORT_proxy` / `NOMAD_PORT_health` 决定,在 [`client-proxy.hcl:104-105`](../../iac/modules/job-client-proxy/jobs/client-proxy.hcl) 由 `env` stanza 注入到 `PROXY_PORT` / `HEALTH_PORT`。

#### Redis

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `REDIS_URL` | — | 单实例 |
| `REDIS_CLUSTER_URL` | — | 集群(优先) |
| `REDIS_TLS_CA_BASE64` | — | base64 CA cert |
| `REDIS_POOL_SIZE` | 40 | 连接池大小(API 服务是 160) |

#### API gRPC 连接

| Env var | 默认 | 说明 |
| --- | --- | --- |
| `API_INTERNAL_GRPC_ADDRESS` | — | 优先;insecure,内网直连 API 内部 gRPC(默认 5009) |
| `API_EDGE_GRPC_ADDRESS` | — | fallback;TLS + OAuth,API edge gRPC(默认 5109) |
| `API_EDGE_GRPC_OAUTH_CLIENT_ID` | — | OAuth client credentials |
| `API_EDGE_GRPC_OAUTH_CLIENT_SECRET` | — | OAuth client credentials |
| `API_EDGE_GRPC_OAUTH_TOKEN_URL` | — | OAuth token endpoint |

**关键选择逻辑**([`main.go:133-145`](../../packages/client-proxy/main.go)):

```go
var pausedSandboxResumer e2bproxy.PausedSandboxResumer
apiGRPCAddress := strings.TrimSpace(config.APIInternalGRPCAddress)
apiGRPCOAuthConfig := e2bproxy.GRPCOAuthConfig{}
apiGRPCUseTLS := false
if apiGRPCAddress == "" {
    apiGRPCAddress = strings.TrimSpace(config.APIEdgeGRPCAddress)
    apiGRPCUseTLS = true
    apiGRPCOAuthConfig = e2bproxy.GRPCOAuthConfig{
        ClientID:     config.APIEdgeGRPCOAuthClientID,
        ClientSecret: config.APIEdgeGRPCOAuthClientSecret,
        TokenURL:     config.APIEdgeGRPCOAuthTokenURL,
    }
}

if apiGRPCAddress != "" {
    pausedSandboxResumer, err = e2bproxy.NewGRPCPausedSandboxResumer(ctx, apiGRPCAddress, apiGRPCOAuthConfig, apiGRPCUseTLS)
    ...
} else {
    l.Warn(ctx, "API gRPC address not set; paused sandbox checks disabled")
}
```

> **关键设计**:两个地址都没配时,client-proxy 仍能启动,但**不能 resume paused sandbox**——所有 catalog miss 都返 502。这是为了本地开发 / 测试场景的灵活性。

#### 其他(隐式)

这些环境变量来自 `packages/shared`,client-proxy 直接消费:

| Env var | 来源 | 用途 |
| --- | --- | --- |
| `NODE_ID` | `env.GetNodeID()` | 节点唯一 ID(Nomad 注入 `node.unique.id`),缺失即 fatal |
| `LAUNCH_DARKLY_API_KEY` | `featureflags.NewClient` | 缺则用 offline test data |
| `OTEL_COLLECTOR_GRPC_ENDPOINT` | `telemetry.New` | 缺则 telemetry 走 noop |
| `E2B_DEBUG` | `env.IsDebug()` | 调试模式 |

### 11.3 构建时 ldflags

```makefile
# packages/client-proxy/Makefile:43
go build -o bin/client-proxy -ldflags "-X=main.commitSHA=$(COMMIT_SHA)" .
```

只注入 `commitSHA`,不像 API 那样还有 `expectedMigrationTimestamp`(client-proxy 不访问 DB,不需要 schema 版本校验)。

### 11.4 Nomad job 关键 stanza

文件:[`iac/modules/job-client-proxy/jobs/client-proxy.hcl`](../../iac/modules/job-client-proxy/jobs/client-proxy.hcl)

```hcl
job "client-proxy" {
  node_pool = "${node_pool}"
  priority  = 80                              # 比 API(90)低

  group "client-proxy" {
    restart {
      attempts = 2                             # 10 min 内最多 2 次重启
      interval = "10m"
      delay    = "10s"
      mode     = "fail"
    }

    reschedule {                               # 重启失败后,reschedule 到其他 node
      delay          = "30s"
      delay_function = "exponential"
      max_delay      = "10m"
      unlimited      = true
    }

    count = ${count}
    constraint { operator = "distinct_hosts", value = "true" }

    network {
      port "proxy"  { static = "${proxy_port}" }
      port "health" { static = "${health_port}" }
    }

    # update stanza 可选(由 var.update_stanza 决定)
    update {
      max_parallel      = ${update_max_parallel}
      canary            = ${update_max_parallel}
      min_healthy_time  = "10s"
      healthy_deadline  = "30s"
      auto_promote      = true
      progress_deadline = "24h"
    }

    task "start" {
      driver = "docker"
      kill_timeout = "24h"                      # 与 proxy.Shutdown 的 24h 对齐
      kill_signal  = "SIGTERM"

      resources {
        memory_max = ${memory_mb * 1.5}
        memory     = ${memory_mb}
        cpu        = ${cpu_count * 1000}        # MHz
      }

      env {
        NODE_ID     = "$${node.unique.id}"
        NODE_IP     = "$${attr.unique.network.ip-address}"
        HEALTH_PORT = "$${NOMAD_PORT_health}"
        PROXY_PORT  = "$${NOMAD_PORT_proxy}"
      }

      config {
        network_mode = "host"
        image        = "${image}"
        ports        = ["proxy", "health"]
      }
    }
  }
}
```

### 11.5 Terraform 调用

模块入口:[`iac/modules/job-client-proxy/main.tf`](../../iac/modules/job-client-proxy/main.tf)

```hcl
locals {
  entrypoints = (
    var.exposure_type == "both" ? "web,internal" :
    var.exposure_type == "private" ? "internal" :
    "web"
  )
}

resource "nomad_job" "client_proxy" {
  jobspec = templatefile("${path.module}/jobs/client-proxy.hcl", {
    update_stanza       = var.update_stanza
    count               = var.client_proxy_count
    cpu_count           = var.client_proxy_cpu_count
    memory_mb           = var.client_proxy_memory_mb
    update_max_parallel = var.client_proxy_update_max_parallel
    node_pool           = var.node_pool
    proxy_port          = var.proxy_port
    health_port         = var.health_port
    image               = var.image
    job_env_vars        = local.job_env_vars
    entrypoints         = local.entrypoints
  })
}
```

GCP provider 调用([`iac/provider-gcp/nomad/main.tf:116-131`](../../iac/provider-gcp/nomad/main.tf)):

```hcl
module "client_proxy" {
  source                          = "../../modules/job-client-proxy"
  client_proxy_count              = var.client_proxy_count
  client_proxy_cpu_count          = var.client_proxy_resources_cpu_count
  client_proxy_memory_mb          = var.client_proxy_resources_memory_mb
  client_proxy_update_max_parallel = var.client_proxy_update_max_parallel
  proxy_port  = var.client_proxy_session_port
  health_port = var.client_proxy_health_port
  image       = data.google_artifact_registry_docker_image.client_proxy_image.self_link
  job_env_vars = var.client_proxy_env_vars
  ...
}
```

GCP 默认值([`iac/provider-gcp/variables.tf`](../../iac/provider-gcp/variables.tf)):

| Variable | 默认 |
| --- | --- |
| `client_proxy_count` | 1 |
| `client_proxy_resources_memory_mb` | 1024 |
| `client_proxy_resources_cpu_count` | 1 |
| `client_proxy_update_max_parallel` | 1 |
| `client_proxy_port.port` | 3002 |
| `client_proxy_health_port.port` | 3001 |

AWS provider 调用([`iac/provider-aws/nomad/main.tf:89-98`](../../iac/provider-aws/nomad/main.tf))类似,但 image 来自 `data.aws_ecr_image.client_proxy.image_uri`。

### 11.6 Released-image 部署模式

Makefile `build-and-upload` 支持两种模式:

```makefile
# packages/client-proxy/Makefile:50-65
.PHONY: build-and-upload
build-and-upload:
ifeq ($(strip $(CLIENT_PROXY_VERSION)),)
    # 现有流程:从源码构建,push 到客户自己的 core repo
    $(eval COMMIT_SHA := $(shell git rev-parse --short HEAD))
    @docker buildx build --platform $(BUILD_PLATFORM) --tag $(IMAGE_REGISTRY) --tag $(IMAGE_REGISTRY):$(COMMIT_SHA) --push --build-arg COMMIT_SHA="$(COMMIT_SHA)" -f ./Dockerfile ..
else
    # Released-image 流程:从 E2B artifacts registry 拉预构建版本,retag/push
    @echo "Using released client-proxy $(CLIENT_PROXY_VERSION) from $(E2B_ARTIFACTS_REGISTRY)"
    docker pull --platform $(BUILD_PLATFORM) $(E2B_ARTIFACTS_REGISTRY):$(CLIENT_PROXY_VERSION)
    docker tag $(E2B_ARTIFACTS_REGISTRY):$(CLIENT_PROXY_VERSION) $(IMAGE_REGISTRY):latest
    docker tag $(E2B_ARTIFACTS_REGISTRY):$(CLIENT_PROXY_VERSION) $(IMAGE_REGISTRY):$(CLIENT_PROXY_VERSION)
    docker push $(IMAGE_REGISTRY):latest
    docker push $(IMAGE_REGISTRY):$(CLIENT_PROXY_VERSION)
endif
```

`E2B_ARTIFACTS_REGISTRY ?= us-docker.pkg.dev/e2b-artifacts/client-proxy/client-proxy` —— 由 release-please workflow 在打 tag 时发布。客户可以通过 `CLIENT_PROXY_VERSION=v0.1.0` 跳过本地构建。

---

## 十二、Feature Flags

Client Proxy 用 LaunchDarkly,但只关心 **少量** flag(大部分 flag 是 orchestrator / API 用)。

### 12.1 主要 flag

| Flag | 用途 | 文档 |
| --- | --- | --- |
| `orch-accepts-combined-host` | orchestrator 接受 `<port>-<sandboxID>.<domain>` 这种"合并 host"。为 true 时 client-proxy 不做 host masking | §3.4 |

```go
// proxy.go:65-74
func clientProxyMaskRequestHost(ctx, featureFlags, host, sandboxID, port) *string {
    domain, sharedHost := reverseproxy.SandboxSharedHostDomain(host)
    if !sharedHost || featureFlags.BoolFlag(ctx, featureflags.OrchAcceptsCombinedHostFlag) {
        return nil
    }
    orchestratorHost := fmt.Sprintf("%d-%s.%s", port, sandboxID, domain)
    return &orchestratorHost
}
```

**演进**:旧版 orchestrator 只接受 host-based 路由(`<port>-<sandboxID>.<domain>`),所以 client-proxy 必须把"共享域名 + header"形式的请求 mask 成"host 编码"形式再转发。新 orchestrator 加了 `orch-accepts-combined-host` 后能直接接受任意 host + header,client-proxy 就可以透传。flag 完全 rollout 后这段 mask 逻辑应该可以删掉。

### 12.2 context 注入

Client Proxy **没有专门的 LD context middleware**(不像 API 那样在 gin middleware 里注入 team / cluster / tier)。原因:client-proxy 没有 team / user 上下文(请求只携带 sandboxID)。

只有启动时 `featureFlagsClient.SetServiceName(serviceName)`([`main.go:108`](../../packages/client-proxy/main.go))把 serviceName 加到 LD context。flag 评估只依赖 deployment / service 维度。

### 12.3 客户端 offline 测试

`featureflags.NewClient()` 在 `LAUNCH_DARKLY_API_KEY` 未设时返 offline test data source(`ldtestdata.DataSource()`),所有 flag 走 default 值。本地开发零配置即可跑。

---

## 十三、关键代码文件索引

### 13.1 入口与配置

| 文件 | 行数 | 主节 |
| --- | --- | --- |
| [`packages/client-proxy/main.go`](../../packages/client-proxy/main.go) | 312 | §3.2, §10 |
| [`packages/client-proxy/Makefile`](../../packages/client-proxy/Makefile) | — | §11.3, §11.6 |
| [`packages/client-proxy/Dockerfile`](../../packages/client-proxy/Dockerfile) | — | §11.6 |
| [`packages/client-proxy/CHANGELOG.md`](../../packages/client-proxy/CHANGELOG.md) | — | §14.2 |
| [`packages/client-proxy/internal/cfg/model.go`](../../packages/client-proxy/internal/cfg/model.go) | 24 | §11.1 |
| [`packages/client-proxy/internal/info.go`](../../packages/client-proxy/internal/info.go) | 40 | §3.2, §10.1 |

### 13.2 代理核心

| 文件 | 行数 | 主节 |
| --- | --- | --- |
| [`packages/client-proxy/internal/proxy/proxy.go`](../../packages/client-proxy/internal/proxy/proxy.go) | 252 | §3.3, §3.4, §5, §9.5 |
| [`packages/client-proxy/internal/proxy/grpc_resume_auth.go`](../../packages/client-proxy/internal/proxy/grpc_resume_auth.go) | 66 | §8.4 |
| [`packages/client-proxy/internal/proxy/paused_resumer.go`](../../packages/client-proxy/internal/proxy/paused_resumer.go) | 10 | §8 |
| [`packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go`](../../packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go) | 97 | §8 |

### 13.3 共享反向代理(在 `packages/shared`)

| 文件 | 主节 |
| --- | --- |
| [`packages/shared/pkg/proxy/proxy.go`](../../packages/shared/pkg/proxy/proxy.go) | §3.3, §9 |
| [`packages/shared/pkg/proxy/handler.go`](../../packages/shared/pkg/proxy/handler.go) | §4.1, §7 |
| [`packages/shared/pkg/proxy/host.go`](../../packages/shared/pkg/proxy/host.go) | §2.1, §4 |
| [`packages/shared/pkg/proxy/errors.go`](../../packages/shared/pkg/proxy/errors.go) | §7.4 |
| [`packages/shared/pkg/proxy/pool/pool.go`](../../packages/shared/pkg/proxy/pool/pool.go) | §9.1, §9.2, §9.3 |
| [`packages/shared/pkg/proxy/pool/client.go`](../../packages/shared/pkg/proxy/pool/client.go) | §4.3, §9 |
| [`packages/shared/pkg/proxy/pool/destination.go`](../../packages/shared/pkg/proxy/pool/destination.go) | §9.2 |
| [`packages/shared/pkg/proxy/tracking/listener.go`](../../packages/shared/pkg/proxy/tracking/listener.go) | §9.4 |
| [`packages/shared/pkg/proxy/tracking/connection.go`](../../packages/shared/pkg/proxy/tracking/connection.go) | §9.4 |
| [`packages/shared/pkg/proxy/template/`](../../packages/shared/pkg/proxy/template/) | §7.3 |

### 13.4 Redis Catalog

| 文件 | 主节 |
| --- | --- |
| [`packages/shared/pkg/sandbox-catalog/catalog.go`](../../packages/shared/pkg/sandbox-catalog/catalog.go) | §6.1 |
| [`packages/shared/pkg/sandbox-catalog/catalog_redis.go`](../../packages/shared/pkg/sandbox-catalog/catalog_redis.go) | §6.2 |
| [`packages/shared/pkg/factories/redis.go`](../../packages/shared/pkg/factories/redis.go) | §6.4 |

### 13.5 gRPC / Proto

| 文件 | 主节 |
| --- | --- |
| [`packages/shared/pkg/grpc/proxy/proxy.proto`](../../packages/shared/pkg/grpc/proxy/proxy.proto) | §8.2 |
| [`packages/shared/pkg/grpc/proxy/proxy_grpc.pb.go`](../../packages/shared/pkg/grpc/proxy/proxy_grpc.pb.go) | §8 |
| [`packages/shared/pkg/grpc/proxy/metadata.go`](../../packages/shared/pkg/grpc/proxy/metadata.go) | §8.3 |
| [`packages/shared/pkg/grpc/proxy/status.go`](../../packages/shared/pkg/grpc/proxy/status.go) | §5.3 |
| [`packages/shared/pkg/grpc/connobserver.go`](../../packages/shared/pkg/grpc/connobserver.go) | §8.5 |
| [`packages/shared/pkg/grpc/channelz.go`](../../packages/shared/pkg/grpc/channelz.go) | §3.2 |

### 13.6 部署

| 文件 | 主节 |
| --- | --- |
| [`iac/modules/job-client-proxy/main.tf`](../../iac/modules/job-client-proxy/main.tf) | §11.5 |
| [`iac/modules/job-client-proxy/variables.tf`](../../iac/modules/job-client-proxy/variables.tf) | §11.5 |
| [`iac/modules/job-client-proxy/jobs/client-proxy.hcl`](../../iac/modules/job-client-proxy/jobs/client-proxy.hcl) | §7.1, §11.4 |
| [`iac/provider-gcp/nomad/main.tf`](../../iac/provider-gcp/nomad/main.tf) | §11.5 |
| [`iac/provider-gcp/variables.tf`](../../iac/provider-gcp/variables.tf) | §11.5 |
| [`iac/provider-aws/nomad/main.tf`](../../iac/provider-aws/nomad/main.tf) | §11.5 |

### 13.7 测试

| 文件 | 行数 | 主节 |
| --- | --- | --- |
| [`packages/client-proxy/internal/proxy/proxy_test.go`](../../packages/client-proxy/internal/proxy/proxy_test.go) | 511 | §16.2 |
| [`packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc_test.go`](../../packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc_test.go) | 245 | §16.2 |
| [`packages/client-proxy/internal/proxy/grpc_resume_auth_test.go`](../../packages/client-proxy/internal/proxy/grpc_resume_auth_test.go) | 132 | §16.2 |
| [`packages/client-proxy/internal/info_test.go`](../../packages/client-proxy/internal/info_test.go) | 66 | §16.2 |
| [`packages/client-proxy/internal/cfg/model_test.go`](../../packages/client-proxy/internal/cfg/model_test.go) | 70 | §16.2 |

---

## 十四、设计要点与演进历史

### 14.1 设计要点(必读)

1. **client-proxy 不访问 DB / ClickHouse / Loki**:所有"控制面"信息走 Redis catalog 或 API edge gRPC。这让本服务极其轻量。
2. **共享反向代理位于 `packages/shared/pkg/proxy/`**:client-proxy 与 orchestrator 内部的 sandbox proxy 共用 `reverseproxy.New`,只是参数不同(client-proxy 用 `ClientProxyRetries=1` + `ClientProxyConnectionKey="client-proxy"`,sandbox proxy 用 `SandboxProxyRetries=5` + per-sandbox ConnectionKey)。
3. **两种 sandbox 路由方式同时支持**:host-based(`<port>-<sandboxID>.domain`)与 header-based(`E2b-Sandbox-Id` + `E2b-Sandbox-Port`)。后者让本地开发(IP:port 直连)和多租户共享域名都能用。
4. **`ConnectionKey` 常量 `"client-proxy"`**:所有 sandbox 共享一个连接池。原因:upstream 是 orchestrator proxy(单个固定 IP:5007),不需要按 sandbox 分池。
5. **`idleTimeout = 610s` > GCP LB 的 600s**:避免 race condition。shared 层再加 10s buffer(`idleTimeoutBufferUpstreamDownstream`),downstream 严格 > upstream。
6. **`ClientProxyRetries = 1` 而不是更多**:重试是为了应对 envd 端口转发延迟(~1s)。orchestrator 那一层还有 `SandboxProxyRetries = 5`,client-proxy 不必激进重试。
7. **Linear backoff 100ms/200ms/300ms/...**([`pool/client.go:79`](../../packages/shared/pkg/proxy/pool/client.go)):简单可预测,对短延迟场景足够。
8. **`tracking.Listener` + `tracking.Connection`**:把 `net.Conn` wrap 一层,在 `Accept` / `Close` 时增减 atomic counter,从而暴露实时连接数 metric。
9. **三阶段 graceful shutdown(Healthy → Draining → Unhealthy)**:每阶段 sleep 15s 让上游 LB / Traefik 有时间感知状态变化,避免在排空期间接收新请求。
10. **`kill_timeout = 24h`** 与 `proxy.Shutdown(24h)` 对齐:允许长连接(WebSocket / sandbox 长任务)完整排空。
11. **gRPC address 二选一**:`API_INTERNAL_GRPC_ADDRESS`(insecure,内网)优先,`API_EDGE_GRPC_ADDRESS`(TLS + OAuth)fallback。都没配时仍能启动(catalog miss 一律 502)。
12. **OAuth client credentials 用 `sandboxes:lifecycle` scope**:API 端严格校验这个 scope,见 [`api-module.md` §5.3.3](api-module.md)。
13. **gRPC metadata 透传 traffic access token**:客户端 HTTP 请求的 `e2b-traffic-access-token` / `X-Access-Token` header 被透传到 API → orchestrator → envd,用于 sandbox 内部的访问控制。
14. **HTML 错误页**:8 种错误场景各有 embedded HTML 模板,让浏览器用户看到可读的错误信息而不是 raw JSON。
15. **Traefik catch-all 路由 `PathPrefix("/")` priority=100**:确保所有未匹配的请求(sandbox 数据面)都路由到 client-proxy,而 API / dashboard-api 的具体路径用更高 priority 抢占。
16. **`NetworkMode = host`**:容器与宿主共享网络栈,避免 Docker bridge NAT 增加延迟(对数据面至关重要)。
17. **Released-image 部署模式**:通过 `CLIENT_PROXY_VERSION=v0.1.0` 让客户从 E2B artifacts registry 拉预构建版本,跳过本地构建。这是 E2B 自托管流程的"released artifacts"模式。
18. **不需要 migration 校验**:client-proxy 不访问 DB,所以 `main.go` 没有 `CheckMigrationVersion` 步骤,ldflags 也不注入 `expectedMigrationTimestamp`。

### 14.2 演进历史

CHANGELOG([`packages/client-proxy/CHANGELOG.md`](../../packages/client-proxy/CHANGELOG.md))显示:

- **1.0.0(2026-07-07)**:首发,作为 E2B 自托管 artifacts 的一部分。
- **1.0.1(2026-07-08)**:修 3 个 CVE。
- **1.2.0**(代码中 version):当前版本。

之前提到 `local-dev: rename API_GRPC_ADDRESS to API_INTERNAL_GRPC_ADDRESS in local dev env (#2589)`——意味着历史上 client-proxy 用过通用名 `API_GRPC_ADDRESS`,后改名以区分 internal/edge。

### 14.3 服务发现:从 Consul 到 Redis Catalog

历史上 client-proxy 用过 Consul 做服务发现,但**当前实现完全没有 Consul/Nomad service discovery**。所有"哪个 sandbox 在哪"的信息都通过 **Redis sandbox catalog** 解析。

唯一与 Nomad 的耦合是:
- `NODE_ID` 从 `node.unique.id` 注入
- `NOMAD_PORT_*` 注入端口
- Traefik 通过 Nomad service 注册发现 client-proxy 实例

---

## 十五、常见问题排查

### 15.1 启动失败

| 症状 | 可能原因 | 排查 |
| --- | --- | --- |
| `failed to parse config` fatal | env var 类型错(如端口非数字) | 看 error message,改 env var |
| `failed to create redis client` | Redis 不可达 / TLS 配错 | 检查 `REDIS_URL` / `REDIS_CLUSTER_URL` / `REDIS_TLS_CA_BASE64` |
| 启动日志 warn: `API gRPC address not set` | 内部 + edge gRPC 地址都没配 | 配 `API_INTERNAL_GRPC_ADDRESS`(优先)或 `API_EDGE_GRPC_ADDRESS` |
| OAuth init error | OAuth 三件套不齐 | `API_EDGE_GRPC_OAUTH_CLIENT_ID/CLIENT_SECRET/TOKEN_URL` 必须全配或全不配 |

### 15.2 转发失败

| 症状 | 可能原因 |
| --- | --- |
| `400 Missing header` | 共享域名 / IP host 请求缺 `E2b-Sandbox-Id` 或 `E2b-Sandbox-Port` |
| `400 Invalid host` | host 格式不对(没有 `.` 或没有 `-`) |
| `400 Invalid sandbox ID` | sandboxID 格式不合法 |
| HTML "Sandbox not found"(502) | catalog miss + API 返 NotFound |
| HTML "Still transitioning" | sandbox 正在 pause/resume 过渡态,稍后重试 |
| HTML "Team sandbox limit" | 团队并发 sandbox 上限触发,API 返 ResourceExhausted |
| HTML "Resume permission denied" | traffic access token 无效或 sandbox 不属于该用户 |
| 502 "Failed to route request to sandbox" | upstream 连接失败,可能是 orchestrator node 挂了 |

### 15.3 Auto-resume 异常

| 症状 | 可能原因 |
| --- | --- |
| 每次 catalog miss 都 502 | `API_INTERNAL_GRPC_ADDRESS` / `API_EDGE_GRPC_ADDRESS` 没配,启动时会有 warn |
| OAuth token 获取失败 | TokenURL 不可达 / ClientID/Secret 错;检查 `get api grpc OAuth token` error |
| Resume 偶尔失败 | sandbox 正在 pause/resume 过渡态;返 `SandboxStillTransitioningMessage` 让 client 重试 |
| Resume 持续失败 | API edge gRPC 不可达 / OIDC issuer 配错(API 端 `CLIENT_PROXY_OIDC_ISSUER_URL`) |

### 15.4 连接池 / metric 异常

| 症状 | 可能原因 |
| --- | --- |
| `client_proxy_server_connections` 持续增长不降 | `tracking.Connection.Close` 没被调用;检查是否 `disableKeepAlives` 被错误启用 |
| `client_proxy_pool_size` > 1 | 不应该(ConnectionKey 是常量);检查是否多 NewClientProxy 调用 |
| 转发延迟高 | 看 `client_proxy_pool_connections` 是否达上限(16384)或 `MaxIdleConnsPerHost`(4096) |

### 15.5 Graceful Shutdown 异常

| 症状 | 可能原因 |
| --- | --- |
| Nomad 强杀(SIGKILL) | `kill_timeout = 24h` 不够用,有连接挂着不退;查 `proxy.Shutdown` 是否卡住 |
| Draining 状态没被 LB 感知 | `shutdownDrainingWait = 15s` 太短(Traefik / GCP LB admit 慢),考虑延长 |
| 频繁重启 | 看 Nomad `restart { attempts=2, interval=10m }`,超过会 reschedule 到其他 node |

---

## 十六、附录

### 16.1 术语表

| 术语 | 含义 |
| --- | --- |
| **Client Proxy** | `packages/client-proxy/` 服务,数据面边缘转发器 |
| **Orchestrator Proxy** | orchestrator 进程内的 HTTP 代理,监听 port 5007,把 client-proxy 转过来的流量路由到 sandbox envd |
| **Sandbox Catalog** | Redis 中 `sandbox:catalog:<id>` 的路由表,由 API 写入,client-proxy 只读 |
| **Host-based 路由** | 从请求 host(`<port>-<sandboxID>.domain`)解析 sandbox 路由信息 |
| **Header-based 路由** | 从 `E2b-Sandbox-Id` + `E2b-Sandbox-Port` header 解析 |
| **Shared host domain** | 以 `sandbox.` 子域开头的共享域名,允许多租户共用一个域名 |
| **Combined host** | `<port>-<sandboxID>.<domain>` 这种已编码好 sandbox 信息的 host |
| **MaskRequestHost** | 把共享 host 重写为 combined host 给 orchestrator(向后兼容) |
| **ConnectionKey** | 连接池分片 key,client-proxy 用常量 `"client-proxy"` |
| **`PausedSandboxResumer`** | catalog miss 时调 API 唤醒 paused sandbox 的接口 |
| **`SandboxStillTransitioningMessage`** | API 返的过渡态错误消息,触发 client-proxy 返 HTML "Still transitioning" |
| **ServiceInfo.status** | 三态健康状态(Healthy / Draining / Unhealthy) |

### 16.2 测试入口

#### 单元测试

文件清单(共 1024 行测试代码):

- [`internal/proxy/proxy_test.go`](../../packages/client-proxy/internal/proxy/proxy_test.go)(511 行)— 转发逻辑、catalog 解析、错误映射、host masking
- [`internal/proxy/paused_sandbox_resumer_grpc_test.go`](../../packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc_test.go)(245 行)— gRPC resumer,用 `bufconn` 起 fake server
- [`internal/proxy/grpc_resume_auth_test.go`](../../packages/client-proxy/internal/proxy/grpc_resume_auth_test.go)(132 行)— OAuth/noop auth 两种路径
- [`internal/cfg/model_test.go`](../../packages/client-proxy/internal/cfg/model_test.go)(70 行)— 配置解析
- [`internal/info_test.go`](../../packages/client-proxy/internal/info_test.go)(66 行)— ServiceInfo 状态机

测试用 `ldtestdata.DataSource()` 起 offline LaunchDarkly,无需真实 LD 连接。

#### 运行测试

```bash
cd packages/client-proxy
go test -race -v ./...
```

### 16.3 与 API / Orchestrator 的对照

| 项 | API | Client Proxy | Orchestrator |
| --- | --- | --- | --- |
| 主要职责 | 控制面 REST + gRPC | 数据面 HTTP 转发 | sandbox 生命周期 + Firecracker |
| 端口 | 80 / 5009 / 5109 | 3002(proxy)/ 3003(health) | 5008(gRPC)/ 5007(proxy) |
| DB / ClickHouse | 是 | 否 | 是 |
| Redis | 缓存 / 限流 / 路由 | 只读 catalog | 是 |
| LaunchDarkly | 是(大量 flag) | 是(极少 flag) | 是(大量 flag) |
| 路由框架 | Gin + oapi-codegen | net/http + httputil.ReverseProxy | chi(envd) + gin |
| Graceful Shutdown | 75s(请求级) | 24h(连接级) | 看 sandbox 数量 |
| 服务规模(LoC) | ~30k | 801 | ~50k |

### 16.4 关键常量速查

```go
// packages/client-proxy/internal/proxy/proxy.go
const (
    orchestratorProxyPort = 5007
    idleTimeout           = 610 * time.Second
)

// packages/client-proxy/main.go
const (
    serviceName           = "client-proxy"
    shutdownDrainingWait  = 15 * time.Second
    shutdownUnhealthyWait = 15 * time.Second
    version               = "1.2.0"
)

// packages/shared/pkg/proxy/proxy.go
const (
    maxClientConns                      = 16384
    idleTimeoutBufferUpstreamDownstream = 10 * time.Second
    ClientProxyRetries                  = 1
    SandboxProxyRetries                 = 5
)

// packages/shared/pkg/proxy/pool/pool.go
const (
    hostConnectionSplit     = 4
    ClientProxyConnectionKey = "client-proxy"
)

// packages/shared/pkg/proxy/host.go
const (
    headerSandboxID   = "E2b-Sandbox-Id"
    headerSandboxPort = "E2b-Sandbox-Port"
)

// packages/shared/pkg/grpc/proxy/metadata.go
const (
    MetadataTrafficAccessToken  = "e2b-traffic-access-token"
    MetadataSandboxRequestPort  = "e2b-sandbox-request-port"
    MetadataEnvdAccessToken     = "e2b-envd-access-token"
    MetadataAuthorization       = "authorization"
    ScopeSandboxLifecycle       = "sandboxes:lifecycle"
    MetadataEnvdHTTPAccessToken = "X-Access-Token"
)
```

### 16.5 相关文档

- [`api-module.md`](api-module.md) — API 服务
- [`sandbox-management.md`](sandbox-management.md) — Sandbox 管理面
- [`node-module.md`](node-module.md) — 节点 / 集群 / 服务发现
- [`template-module.md`](template-module.md) — Template 模版系统
- [`volumes.md`](volumes.md) — 持久化卷
- [`snapshots.md`](snapshots.md) — Pause / Resume 与 snapshot
- [`../sandbox-lifecycle.md`](../sandbox-lifecycle.md) — Sandbox 生命周期(老文档)
- [`../MODULE_GUIDE.md`](../MODULE_GUIDE.md) — 模块导览

---

> 文档版本:2026-07-11。基于 `learn/brain` 分支代码,涵盖 `packages/client-proxy/` 全部子系统 + 关键共享包(`packages/shared/pkg/proxy/`、`sandbox-catalog/`、`grpc/proxy/`)。后续演进(auto-resume 协议变化、Traefik 路由调整、released-image 流程更新)请同步更新本文档。
