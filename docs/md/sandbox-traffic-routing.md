# Sandbox 流量路由详解

> 范围:用户 HTTP 请求从公网到达 sandbox 内业务进程的完整转发链路——三层反向代理级联、Host 编码规则、端口 1:1 直通、envd vs 业务流量分流、私有 ingress token 校验、共享主机 Host 改写。
>
> 阅读建议:先看「一、概述」与「四、端到端时序图」建立全局视图,再按需深入具体章节。本文与 `client-proxy-module.md`(边缘路由整体)、`orchestrator-module.md`(节点内部)、`auto-resume-module.md`(paused 唤醒)、`access-tokens-module.md`(token 校验)互为补充,只在**流量转发规则**这条路径上展开细节。

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、整体架构:三层反向代理](#三整体架构三层反向代理)
- [四、端到端时序图](#四端到端时序图)
- [五、Layer 1:Client-Proxy(边缘)](#五layer-1client-proxy边缘)
- [六、Layer 2:Orchestrator Proxy(节点入口)](#六layer-2orchestrator-proxy节点入口)
- [七、Layer 3:Sandbox 内部(业务进程)](#七layer-3sandbox-内部业务进程)
- [八、Host 解析规则详解](#八host-解析规则详解)
- [九、端口 1:1 直通机制](#九端口-11-直通机制)
- [十、envd 流量 vs 业务流量](#十envd-流量-vs-业务流量)
- [十一、私有 ingress 与 traffic-access-token](#十一私有-ingress-与-traffic-access-token)
- [十二、共享主机 Host 改写](#十二共享主机-host-改写)
- [十三、连接池与 keep-alive](#十三连接池与-keep-alive)
- [十四、错误码与用户可见响应](#十四错误码与用户可见响应)
- [十五、设计要点与权衡](#十五设计要点与权衡)
- [十六、常见问题与排查](#十六常见问题与排查)
- [附录 A:关键常量速查](#附录-a关键常量速查)
- [附录 B:代码文件索引](#附录-b代码文件索引)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

E2B 的数据面流量转发是**三层反向代理级联**:

```
用户 HTTP 请求
    │
    │ Host: {port}-{sandboxID}.{domain}
    │
    ▼
Client-Proxy   ── 跨节点路由(Redis catalog)──►   nodeIP:5007
                                                    │
                                                    ▼
                                            Orchestrator Proxy
                                            ── 节点内路由(in-memory map)──►
                                                    │
                                                    ▼
                                            sandboxIP:{port}
                                            ── 直接打到业务进程 ──►
                                                    │
                                                    ▼
                                            Sandbox 内 envd / 用户业务
```

**核心特征**:

1. **路由信息编码在 Host 头里**:`{port}-{sandboxID}.{domain}` 是核心编码规则
2. **端口号 1:1 直通**:外部请求的 port = sandbox 内业务 listen 的 port,**没有端口重映射表**
3. **三次解析 (sandboxID, port)**:每层代理都独立解析一次,层层校验
4. **两类流量分流**:envd 流量(49983)走 SDK 控制路径,业务流量走数据路径
5. **私有 ingress token 校验**:可选的 sandbox 级别访问凭证

### 与其他文档的边界

| 主题 | 文档 |
|---|---|
| Client-proxy 整体架构 / graceful shutdown / 连接池 | `client-proxy-module.md` |
| Orchestrator 内部 VM 管理 / network slot | `orchestrator-module.md` / `sandbox-management.md` |
| Paused sandbox 自动唤醒 | `auto-resume-module.md` |
| Access token 生成与签发 | `access-tokens-module.md` |
| **HTTP 转发到 sandbox 内业务的路由规则** | **本文** |

---

## 二、核心概念

### 2.1 三层代理角色

| 层 | 角色 | 位置 | 主要职责 |
|---|---|---|---|
| **Layer 1** | Client-Proxy | 公网边缘节点 | 解析 Host、查 Redis catalog、跨节点路由 |
| **Layer 2** | Orchestrator Proxy | sandbox 所在节点的 :5007 | 再次解析、查本地 sandbox map、token 校验 |
| **Layer 3** | envd / 业务进程 | sandbox VM 内部 | 处理请求(49983 → envd,其他端口 → 业务) |

### 2.2 Host 编码格式

```
{port}-{sandboxID}.{domain}
└─┬─┘ └──────┬──────┘
 │           │
 │           └── sandboxID(从 API 创建时返回,UUID 形式)
 │
 └── 业务监听端口号(1-65535)
```

**示例**:
- 生产独占域名:`3000-abc123def456.sandbox.e2b.dev`
- 共享主机:`3000-abc123def456.sandbox.e2b.dev`(`sandbox.` 前缀触发 Header 模式)
- 本地 / IP:`localhost:3000`(必须配 `E2b-Sandbox-Id` Header)

### 2.3 两个固定端口号

| 端口 | 含义 | 用途 |
|---|---|---|
| **5007** | orchestrator proxy 监听端口(`orchestratorProxyPort`) | client-proxy 跨节点路由的固定目标 |
| **49983** | envd daemon 监听端口(`DefaultEnvdServerPort`) | SDK 控制流量专用端口 |

### 2.4 两类流量

| 流量类型 | 目标端口 | 例子 | token 校验路径 |
|---|---|---|---|
| **envd 流量** | 49983 | SDK 调 `/proc/start`、`/fs/write` 等 envd API | envd 自己的 auth(secure sandbox 用 `MetadataEnvdAccessToken`) |
| **业务流量** | 其他任意 | 用户 `EXPOSE` 的 web 服务(3000、8080…) | orchestrator proxy 校验 `e2b-traffic-access-token`(若配了私有 ingress) |

---

## 三、整体架构:三层反向代理

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │                       用户 HTTP 请求                                  │
   │   Host: 3000-abc123def456.sandbox.e2b.dev                              │
   │   Header: e2b-traffic-access-token: xxxx (可选)                        │
   └─────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
                        ┌────────────────────────┐
                        │   Client-Proxy (边缘)   │
                        │   :443 / :80             │
                        └──────────┬─────────────┘
                                   │ GetTargetFromRequest
                                   │  → 解析 (sandboxID, port)
                                   │
                                   ▼
                        ┌────────────────────────┐
                        │  Redis Catalog          │
                        │  sandboxID → nodeIP     │
                        └──────────┬─────────────┘
                                   │
                  ┌────────────────┼─────────────────────┐
                  │ catalog hit    │ catalog miss         │
                  ▼                ▼                      │
            直接转发 nodeIP    handlePausedSandbox        │
                              → auto-resume(见专项文档)   │
                                   │
                                   ▼
                        http://nodeIP:5007 (orchestratorProxyPort)
                                   │
                                   ▼
                        ┌────────────────────────┐
                        │  Orchestrator Proxy     │
                        │  (sandbox 所在节点)      │
                        └──────────┬─────────────┘
                                   │ GetTargetFromRequest
                                   │  → 再次解析 (sandboxID, port)
                                   │
                                   │ sandboxes.Get(sandboxID)
                                   │ → sbx.Slot.HostIPString()
                                   │  (sandbox 在 host netns 的 IP)
                                   │
                                   │ traffic-access-token 校验(可选)
                                   │ MaskRequestHost(共享主机)
                                   │
                                   ▼
                        http://sandboxIP:{port}
                                   │
                                   ▼
                        ┌────────────────────────┐
                        │  Sandbox VM             │
                        │  ├─ :49983 → envd       │
                        │  └─ :{port} → 用户业务   │
                        └────────────────────────┘
```

---

## 四、端到端时序图

### 4.1 标准成功路径(业务流量,公共 ingress)

```
用户        Client-Proxy      Redis Catalog   Orchestrator Proxy    Sandbox VM
 │              │                   │                  │                  │
 │ HTTP GET     │                   │                  │                  │
 │ Host: 3000-{id}.sandbox...        │                  │                  │
 │─────────────>│                   │                  │                  │
 │              │                   │                  │                  │
 │              │ GetTargetFromRequest                 │                  │
 │              │  → (sandboxID={id}, port=3000)       │                  │
 │              │                   │                  │                  │
 │              │ GetSandbox({id})──>                  │                  │
 │              │<────────── SandboxInfo                │                  │
 │              │  (nodeIP=10.0.5.20)                  │                  │
 │              │                   │                  │                  │
 │              │ 建立到 10.0.5.20:5007 的连接          │                  │
 │              │ 转发原始 HTTP(Host/Headers 保留)─────>│                  │
 │              │                   │                  │                  │
 │              │                   │                  │ GetTargetFromRequest
 │              │                   │                  │  → ({id}, 3000)  │
 │              │                   │                  │                  │
 │              │                   │                  │ sandboxes.Get({id})
 │              │                   │                  │  → sbx           │
 │              │                   │                  │  HostIP=192.168.5.42
 │              │                   │                  │                  │
 │              │                   │                  │ 建立到 192.168.5.42:3000
 │              │                   │                  │─────────────────>│
 │              │                   │                  │                  │ 业务进程处理
 │              │                   │                  │<─────────────────│
 │              │                   │                  │ HTTP 200         │
 │<─────────────┴───────────────────┴──────────────────┴──────────────────│
 │ HTTP 200 响应                                                                              │
```

### 4.2 私有 ingress 流量(token 校验)

```
用户 HTTP(带 e2b-traffic-access-token)
  │
  ▼
Client-Proxy ──► Redis Catalog ──► nodeIP
  │
  ▼
Orchestrator Proxy
  │
  ├─ GetNetworkIngress().GetTrafficAccessToken()
  │   → 取出 sandbox 配置的预期 token
  │
  ├─ isNonEnvdTraffic = (port != 49983) → true
  │
  ├─ accessToken != "" → 进入校验分支
  │
  ├─ r.Header.Get("e2b-traffic-access-token")
  │
  ├─ subtle.ConstantTimeCompare(provided, expected)
  │   ├─ 1 → 通过,继续转发
  │   └─ 0 → 返回 InvalidTrafficAccessToken 错误页
  │
  ▼
sandboxIP:{port}
```

### 4.3 envd 流量(SDK 调用,绕过 traffic token)

```
SDK 调用 (POST /proc/start 等)
  │
  │ Host: 49983-{id}.sandbox.e2b.dev
  │
  ▼
Orchestrator Proxy
  │
  ├─ port == 49983 → isNonEnvdTraffic = false
  │
  ├─ 跳过 traffic-access-token 校验
  │
  ▼
sandboxIP:49983 → envd
  │
  ├─ envd 自己的 auth(secure sandbox 时校验 MetadataEnvdAccessToken)
  │
  └─ 处理 SDK 请求
```

### 4.4 catalog miss(catalog miss → auto-resume → 重路由)

参见 [`auto-resume-module.md`](auto-resume-module.md) 第四章。简言之:

```
Client-Proxy
  │
  ├─ GetSandbox({id}) → ErrSandboxNotFound
  │
  ├─ handlePausedSandbox
  │   ├─ gRPC ResumeSandbox 到 API
  │   ├─ API 启动 sandbox、写入 Redis catalog
  │   └─ 返回 nodeIP
  │
  └─ 用新 nodeIP 继续 Layer 2/3 转发
```

---

## 五、Layer 1:Client-Proxy(边缘)

### 5.1 入口构造

`packages/client-proxy/internal/proxy/proxy.go:138-215` `NewClientProxy`:

```go
getTargetFromRequest := reverseproxy.GetTargetFromRequest()
proxy := reverseproxy.New(
    port,
    reverseproxy.ClientProxyRetries,
    idleTimeout,
    func(r *http.Request) (*pool.Destination, error) {
        ctx := r.Context()
        sandboxId, port, err := getTargetFromRequest(r)  // ← 第一次解析
        if err != nil { return nil, err }

        trafficAccessToken := r.Header.Get(proxygrpc.MetadataTrafficAccessToken)
        envdAccessToken     := r.Header.Get(proxygrpc.MetadataEnvdHTTPAccessToken)

        nodeIP, err := catalogResolution(ctx, sandboxId, port, trafficAccessToken, envdAccessToken, catalog, pausedSandboxResumer)
        if err != nil { /* 错误分类处理 */ }

        url := &url.URL{
            Scheme: "http",
            Host:   net.JoinHostPort(nodeIP, strconv.Itoa(orchestratorProxyPort)),  // ← 固定 :5007
        }

        return &pool.Destination{
            SandboxId:       sandboxId,
            SandboxPort:     port,
            ConnectionKey:   pool.ClientProxyConnectionKey,
            Url:             url,
            MaskRequestHost: clientProxyMaskRequestHost(ctx, featureFlagsClient, r.Host, sandboxId, port),
        }, nil
    },
    nil,
    false,
)
```

### 5.2 catalog 解析

`packages/client-proxy/internal/proxy/proxy.go:76-95` `catalogResolution`:

```go
func catalogResolution(ctx, sandboxId, sandboxPort, trafficAccessToken, envdAccessToken, c, pausedChecker) (string, error) {
    s, err := c.GetSandbox(ctx, sandboxId)
    if err != nil {
        if errors.Is(err, catalog.ErrSandboxNotFound) {
            // catalog miss → 触发 auto-resume(详见 auto-resume-module.md)
            nodeIP, res, pausedErr := handlePausedSandbox(ctx, sandboxId, sandboxPort, trafficAccessToken, envdAccessToken, pausedChecker)
            if pausedErr != nil { return "", pausedErr }
            if res == autoResumeSucceeded { return nodeIP, nil }
            return "", ErrNodeNotFound
        }
        return "", fmt.Errorf("failed to get sandbox from catalog: %w", err)
    }
    return catalogSandboxNodeIP(s)  // catalog hit → 用 s.OrchestratorIP
}
```

### 5.3 重要:Client-Proxy 不做 token 校验

注意 Layer 1 **只把 token header 透传出去,自己不校验**。校验在 Layer 2(orchestrator proxy)做。这是有意为之——client-proxy 是路由层,orchestrator proxy 才持有 sandbox 的 ingress 配置。

例外:auto-resume 触发时,API 的 gRPC handler 会校验一次(因为此时还没到 orchestrator proxy)。详见 `auto-resume-module.md` 第八章 Phase 7。

---

## 六、Layer 2:Orchestrator Proxy(节点入口)

### 6.1 入口构造

`packages/orchestrator/pkg/proxy/proxy.go:44-130` `NewSandboxProxy`:

```go
func NewSandboxProxy(meterProvider, port, sandboxes *sandbox.Map, featureFlags) (*SandboxProxy, error) {
    getTargetFromRequest := reverseproxy.GetTargetFromRequest()
    limiter := connlimit.NewConnectionLimiter()
    metrics := NewMetrics(meterProvider)

    connLimitConfig := &reverseproxy.ConnectionLimitConfig{
        Limiter: limiter,
        GetMaxLimit: func(ctx) int {
            return featureFlags.IntFlag(ctx, featureflags.SandboxMaxIncomingConnections)
        },
        OnConnectionAcquired: metrics.RecordConnectionsPerSandbox,
        OnConnectionReleased: metrics.RecordConnectionDuration,
        OnConnectionBlocked:  metrics.RecordConnectionBlocked,
    }

    proxy := reverseproxy.New(
        port,
        reverseproxy.SandboxProxyRetries,  // 重试 5 次,处理 envd 端口转发延迟
        idleTimeout,
        func(r *http.Request) (*pool.Destination, error) {
            sandboxId, port, err := getTargetFromRequest(r)  // ← 第二次解析
            if err != nil { return nil, err }

            sbx, found := sandboxes.Get(sandboxId)  // ← 本地内存 map 查询
            if !found {
                return nil, reverseproxy.NewErrSandboxNotFound(sandboxId)
            }

            ingress := sbx.Config.GetNetworkIngress()
            accessToken := ingress.GetTrafficAccessToken()
            isNonEnvdTraffic := int64(port) != consts.DefaultEnvdServerPort

            // 私有 ingress + 非 envd 流量 → 校验 token
            if accessToken != "" && isNonEnvdTraffic {
                accessTokenRaw := r.Header.Get(trafficAccessTokenHeader)
                if accessTokenRaw == "" {
                    return nil, reverseproxy.NewErrMissingTrafficAccessToken(sandboxId, trafficAccessTokenHeader)
                } else if subtle.ConstantTimeCompare([]byte(accessTokenRaw), []byte(accessToken)) != 1 {
                    return nil, reverseproxy.NewErrInvalidTrafficAccessToken(sandboxId, trafficAccessTokenHeader)
                }
            }

            // 共享主机 Host 改写
            var maskRequestHost *string = nil
            if h := ingress.GetMaskRequestHost(); isNonEnvdTraffic && h != "" {
                h = strings.ReplaceAll(h, pool.MaskRequestHostPortPlaceholder, strconv.FormatUint(port, 10))
                maskRequestHost = &h
            }

            url := &url.URL{
                Scheme: "http",
                Host:   net.JoinHostPort(sbx.Slot.HostIPString(), strconv.FormatUint(port, 10)),  // ← sandboxIP:{port}
            }

            return &pool.Destination{
                Url:                                url,
                SandboxId:                          sbx.Runtime.SandboxID,
                SandboxPort:                        port,
                DefaultToPortError:                 true,
                IncludeSandboxIdInProxyErrorLogger: true,
                MaskRequestHost:                    maskRequestHost,
                // ...
            }, nil
        },
        connLimitConfig,
        true,
    )
    // ...
}
```

### 6.2 关键差异(vs Client-Proxy)

| 维度 | Client-Proxy | Orchestrator Proxy |
|---|---|---|
| 查询源 | Redis catalog | in-memory `sandbox.Map` |
| 目标 | `nodeIP:5007` | `sandboxIP:{port}` |
| Token 校验 | 不做(透传) | 做(若 ingress 配置) |
| Host 改写 | 共享主机时改(基于 LD flag) | 共享主机时改(基于 ingress 配置) |
| 重试 | `ClientProxyRetries` | `SandboxProxyRetries`(5 次,处理 envd 启动延迟) |
| 连接限流 | 不做 | 做(`SandboxMaxIncomingConnections` feature flag) |

### 6.3 连接限流

`connLimitConfig` 在 Layer 2 启用:

```go
count, acquired := connLimitConfig.Limiter.TryAcquire(d.ConnectionKey, maxLimit)
if !acquired {
    // 返回 SandboxTooManyConnectionsError 用户友好的 HTML 页
}
```

阈值由 `featureflags.SandboxMaxIncomingConnections` 控制(LaunchDarkly)。超限的连接被 OnConnectionBlocked 计数。

---

## 七、Layer 3:Sandbox 内部(业务进程)

### 7.1 端口监听约定

sandbox 内部:

| 端口 | 监听者 | 用途 |
|---|---|---|
| 49983 | envd | SDK 控制端口(/proc、/fs、/health 等) |
| 1-65535(除 49983) | 用户业务 | 由 Dockerfile `EXPOSE` 决定 |

**没有端口映射表**——sandbox 内 `EXPOSE 3000` 就在 3000 监听,外部也用 3000 访问。

### 7.2 envd auth 白名单

`packages/envd/internal/api/auth.go:27` 列出免 auth 路径:

```go
"GET/health",
// ...
```

`/health` 可直接 curl,返回 204。其他 envd 端点在 secure sandbox 下要 `MetadataEnvdAccessToken`。

### 7.3 用户的业务端口

业务代码必须 `0.0.0.0:{port}` 监听,**不能只 listen `127.0.0.1`**。orchestrator proxy 从 host netns 走网络命名空间过来,需要业务监听对外可达的接口。

---

## 八、Host 解析规则详解

### 8.1 入口函数

`packages/shared/pkg/proxy/host.go:16-43`:

```go
func GetTargetFromRequest() func(r *http.Request) (sandboxId string, port uint64, err error) {
    return func(r *http.Request) (sandboxId string, port uint64, err error) {
        if shouldParseHeaders(r.Host) && hasRoutingHeaders(r.Header) {
            sandboxId, port, ok, err = parseHeaders(r.Header)
            if err != nil { return "", 0, err }
            if ok {
                if err := id.ValidateSandboxID(sandboxId); err != nil {
                    return "", 0, ErrInvalidSandboxID
                }
                return sandboxId, port, nil
            }
        }

        sandboxId, port, err = parseHost(r.Host)
        if err != nil { return "", 0, err }
        if err := id.ValidateSandboxID(sandboxId); err != nil {
            return "", 0, ErrInvalidSandboxID
        }
        return sandboxId, port, nil
    }
}
```

### 8.2 主路径:Host 头解析

`packages/shared/pkg/proxy/host.go:74-99` `parseHost`:

```go
func parseHost(host string) (sandboxID string, port uint64, err error) {
    dot := strings.Index(host, ".")
    if dot == -1 {
        return "", 0, ErrInvalidHost  // 必须有域名部分
    }

    host = host[:dot]  // 取第一个 "." 之前
    // 例: "3000-abc123def456"

    hostParts := strings.Split(host, "-")
    if len(hostParts) < 2 {
        return "", 0, ErrInvalidHost
    }

    sandboxPortString := hostParts[0]
    sandboxID = hostParts[1]

    sandboxPort, err := strconv.ParseUint(sandboxPortString, 10, 64)
    if err != nil {
        return "", 0, InvalidSandboxPortError{sandboxPortString, err}
    }

    return sandboxID, sandboxPort, nil
}
```

**输入示例与输出**:

| 输入 Host | 解析结果 |
|---|---|
| `3000-abc123.sandbox.e2b.dev` | `(abc123, 3000)` |
| `8080-xyz789.e2b.dev` | `(xyz789, 8080)` |
| `49983-abc123.sandbox.e2b.dev` | `(abc123, 49983)`(envd 流量) |
| `sandbox.e2b.dev` | `ErrInvalidHost`(没有 port-sandboxID 前缀) |
| `3000.sandbox.e2b.dev` | `ErrInvalidHost`(缺少 `-` 分隔) |
| `abc-def-3000-...` | port=`abc` → `InvalidSandboxPortError` |

### 8.3 旁路:Header 解析(本地 / IP / 共享主机)

`packages/shared/pkg/proxy/host.go:45-49` `shouldParseHeaders`:

```go
func shouldParseHeaders(host string) bool {
    _, sharedHost := SandboxSharedHostDomain(host)
    return isLocalRequestHost(host) || sharedHost
}
```

仅在以下场景启用:

| 场景 | 判定 |
|---|---|
| `localhost` | `isLocalRequestHost` 返回 true |
| IP 地址(`127.0.0.1`、`10.0.0.1` 等) | `net.ParseIP` 解析成功 |
| 共享主机(`sandbox.{domain}`) | `SandboxSharedHostDomain` 返回 sharedHost=true |

Header 名(`packages/shared/pkg/proxy/host.go:109-112`):

```go
const (
    headerSandboxID   = "E2b-Sandbox-Id"
    headerSandboxPort = "E2b-Sandbox-Port"
)
```

**为什么生产域名禁用 Header 路径**:多租户共享 IP 时,Header 路径无法在 HTTP 层被 DNS / TLS 验证;Host 路径与 TLS SNI / 证书绑定,更难绕过。

### 8.4 sandboxID 校验

`packages/shared/pkg/id.ValidateSandboxID`(via `id` 包)负责校验 sandboxID 格式。**两层代理都做**——防止恶意 Host 注入非法 ID 后被路由到错误的 catalog 条目。

---

## 九、端口 1:1 直通机制

### 9.1 关键不变量

**端口号从用户请求到 sandbox 内业务进程全程不变**:

```
用户请求 Host: {PORT}-{id}.{domain}
                │
                ▼
Client-Proxy: 解析出 port = {PORT}
                │
                │   连接 nodeIP:5007 (orchestratorProxyPort,固定值)
                │   但 sandboxPort 字段保留 = {PORT}
                ▼
Orchestrator Proxy: 再次解析 port = {PORT}
                │
                │   连接 sandboxIP:{PORT}
                ▼
Sandbox VM: 业务进程在 :{PORT} 监听
```

### 9.2 为什么 5007 是例外

`orchestratorProxyPort = 5007` 是 **client-proxy → orchestrator proxy 这一跳的固定端口**,与 sandboxID 无关。

它是节点上 orchestrator 进程的入站监听端口,Nomad job 定义中固定。orchestrator 收到后,**根据 Host 头再决定要打到哪个 sandbox**。

### 9.3 没有 NAT / 端口映射表

与 Docker `-p 8080:80` 不同,E2B **不做端口重映射**:

| 场景 | Docker | E2B |
|---|---|---|
| 外部访问端口 | 由 `-p` 决定 | 由 Host 编码决定 |
| 容器内监听 | 由 EXPOSE / 应用决定 | 由 EXPOSE / 应用决定 |
| 映射关系 | `-p hostPort:containerPort` 显式 | **1:1,无映射** |

代价:sandbox 内业务必须监听对外可达端口,不能用 `127.0.0.1`。收益:路由逻辑极简,无需维护端口映射状态。

---

## 十、envd 流量 vs 业务流量

### 10.1 判定逻辑

`packages/orchestrator/pkg/proxy/proxy.go:80`:

```go
isNonEnvdTraffic := int64(port) != consts.DefaultEnvdServerPort
```

`packages/shared/pkg/consts/envd.go:4`:

```go
DefaultEnvdServerPort int64 = 49983
```

**只有一个端口的硬编码判定**:49983 = envd,其他 = 业务。

### 10.2 两类流量对比

| 维度 | envd 流量 | 业务流量 |
|---|---|---|
| 端口 | 49983 | 任意(非 49983) |
| 调用者 | E2B SDK | 用户 / 用户应用 |
| 内容 | 控制 API(`/proc`、`/fs`、`/health`) | 用户业务(HTTP、WebSocket、自定义) |
| Token 校验 | envd 内部 auth(`MetadataEnvdAccessToken`,secure sandbox 时) | orchestrator proxy 校验 `e2b-traffic-access-token`(私有 ingress 时) |
| MaskRequestHost | 不做 | 共享主机时做 |
| 重试策略 | envd 启动慢会重试 | 同上 |

### 10.3 为什么 envd 流量绕过 traffic token

envd 流量是 SDK 的控制调用,本身已经有自己的 auth:

- **非 secure sandbox**:envd 监听本地,无 token
- **secure sandbox**:envd 要求 `MetadataEnvdAccessToken`,通过 client-proxy 时 Header 名为 `MetadataEnvdHTTPAccessToken`(`proxy.go:155`),由 envd 内部 `auth.go` 校验

orchestrator proxy 跳过 envd 端口的 token 校验,避免双重验证和 token 类型混淆。

---

## 十一、私有 ingress 与 traffic-access-token

### 11.1 配置来源

`packages/orchestrator/pkg/sandbox/sandbox.go:151-152`:

```go
func (c *Config) GetNetworkIngress() *orchestrator.SandboxNetworkIngressConfig {
    // 加锁读取,线程安全
}
```

`SandboxNetworkIngressConfig` 字段(从 sandbox 创建时的配置注入):

| 字段 | 用途 |
|---|---|
| `TrafficAccessToken` | 预期的 token 值(空表示公共 ingress) |
| `MaskRequestHost` | 共享主机模式下的 Host 改写模板 |

### 11.2 token 校验代码

`packages/orchestrator/pkg/proxy/proxy.go:77-91`:

```go
ingress := sbx.Config.GetNetworkIngress()
accessToken := ingress.GetTrafficAccessToken()

if accessToken != "" && isNonEnvdTraffic {
    accessTokenRaw := r.Header.Get(trafficAccessTokenHeader)  // "e2b-traffic-access-token"
    if accessTokenRaw == "" {
        return nil, reverseproxy.NewErrMissingTrafficAccessToken(sandboxId, trafficAccessTokenHeader)
    } else if subtle.ConstantTimeCompare([]byte(accessTokenRaw), []byte(accessToken)) != 1 {
        return nil, reverseproxy.NewErrInvalidTrafficAccessToken(sandboxId, trafficAccessTokenHeader)
    }
}
```

### 11.3 常量时间比较防时序攻击

```go
subtle.ConstantTimeCompare([]byte(accessTokenRaw), []byte(accessToken)) != 1
```

用 `crypto/subtle` 而非 `==`,堵死响应时间侧信道——攻击者无法通过响应延迟逐字符猜测 token。

### 11.4 token 的生成

详见 [`access-tokens-module.md`](access-tokens-module.md)。简言之:

- 由 API 在 sandbox 创建时生成(HMAC-SHA256,基于 sandboxID + team secret)
- 写入 sandbox 配置(同步到 orchestrator)
- 同时返回给客户端用于后续请求的 `e2b-traffic-access-token` header

### 11.5 失败错误页

`packages/shared/pkg/proxy/handler.go:127-159` 提供用户友好的 HTML 错误页:

```go
var trafficMissingTokenErr *MissingTrafficAccessTokenError
if errors.As(err, &trafficMissingTokenErr) {
    err := template.NewTrafficAccessTokenMissingHeader(...).HandleError(w, r)
    return
}

var trafficInvalidTokenErr *InvalidTrafficAccessTokenError
if errors.As(err, &trafficInvalidTokenErr) {
    err := template.NewTrafficAccessTokenInvalidHeader(...).HandleError(w, r)
    return
}
```

---

## 十二、共享主机 Host 改写

### 12.1 触发条件

两种场景触发 Host 改写:

| 场景 | 触发位置 | 配置来源 |
|---|---|---|
| Client-Proxy | `clientProxyMaskRequestHost`(`client-proxy/proxy.go:65-74`) | feature flag `OrchAcceptsCombinedHostFlag` |
| Orchestrator Proxy | `ingress.GetMaskRequestHost()`(`orchestrator/proxy/proxy.go:93-98`) | sandbox ingress 配置 |

### 12.2 Client-Proxy 端

`packages/client-proxy/internal/proxy/proxy.go:65-74`:

```go
func clientProxyMaskRequestHost(ctx, featureFlags, host, sandboxID, port) *string {
    domain, sharedHost := reverseproxy.SandboxSharedHostDomain(host)
    if !sharedHost || featureFlags.BoolFlag(ctx, featureflags.OrchAcceptsCombinedHostFlag) {
        return nil  // 独占域名或新版 orchestrator → 不改写
    }

    orchestratorHost := fmt.Sprintf("%d-%s.%s", port, sandboxID, domain)
    return &orchestratorHost
}
```

**判定**:
- 共享主机(`sandbox.{domain}` 前缀)
- **且** LD flag 关闭(老版本 orchestrator 不接受合并 Host)

→ 把 Host 改写成 `{port}-{sandboxID}.{domain}` 形式,确保 orchestrator 端能正确解析。

### 12.3 Orchestrator 端

`packages/orchestrator/pkg/proxy/proxy.go:93-98`:

```go
var maskRequestHost *string = nil
if h := ingress.GetMaskRequestHost(); isNonEnvdTraffic && h != "" {
    h = strings.ReplaceAll(h, pool.MaskRequestHostPortPlaceholder, strconv.FormatUint(port, 10))
    maskRequestHost = &h
}
```

ingress 配置的 `MaskRequestHost` 是模板,包含 `{port}` 占位符(`pool.MaskRequestHostPortPlaceholder`),按当前请求端口填充。

### 12.4 实际转发时的 Host 改写

`packages/shared/pkg/proxy/pool/client.go:112-119`:

```go
r.SetURL(t.Url)

if t.MaskRequestHost != nil {
    // Mask the request host to bypass source host protections.
    r.Out.Header.Set("X-Forwarded-Host", r.In.Host)  // 保留原始 Host 到 X-Forwarded-Host
    r.Out.Host = *t.MaskRequestHost                   // 改写实际 Host
} else {
    r.Out.Host = r.In.Host
}
```

注释中 "bypass source host protections" 指:某些后端服务(如 Nginx、Spring Boot)会校验 Host 头防止 DNS rebinding 攻击。共享主机场景下,外部 Host 与 sandbox 内业务期望的 Host 不一致,需要改写才能让业务正常处理。

### 12.5 envd 流量跳过

```go
if h := ingress.GetMaskRequestHost(); isNonEnvdTraffic && h != "" {
```

`isNonEnvdTraffic` 条件确保 envd 流量(49983)不改写——envd 不做 Host 校验,改写反而会破坏它的路由。

---

## 十三、连接池与 keep-alive

### 13.1 长连接 idle timeout

`packages/orchestrator/pkg/proxy/proxy.go:32`:

```go
idleTimeout = 620 * time.Second
```

`packages/client-proxy/internal/proxy/proxy.go:34`:

```go
idleTimeout = 610 * time.Second
```

> **为什么 610 / 620 秒**:GCP LB 的 upstream idle timeout 是 600 秒。两层代理的 idle timeout 必须 **> 600**,防止 LB 先关连接导致竞态(注释明确说明)。
>
> 链接:https://cloud.google.com/load-balancing/docs/https#timeouts_and_retries

orchestrator proxy 设 620(比 client-proxy 多 10 秒)——保证 client-proxy 关连接前,orchestrator 还活着,避免半关连接。

### 13.2 连接池

`packages/shared/pkg/proxy/pool/` 提供 `ProxyPool`,按 Destination 复用 HTTP 连接。详细机制参见 `client-proxy-module.md` 的连接池章节。

### 13.3 连接限流

仅 Layer 2 启用(见 §6.3)。`featureflags.SandboxMaxIncomingConnections` 控制单 sandbox 最大并发入站连接数,超限返回 `SandboxTooManyConnectionsError`。

### 13.4 重试

| 层 | 重试次数 | 原因 |
|---|---|---|
| Client-Proxy | `ClientProxyRetries` | 处理 orchestrator 端短暂不可达 |
| Orchestrator Proxy | `SandboxProxyRetries = 5` | 处理 sandbox envd / 业务端口启动延迟(冷启动后端口转发还没就绪) |

---

## 十四、错误码与用户可见响应

### 14.1 错误页模板

`packages/shared/pkg/proxy/handler.go:16-216` 列出所有错误类型,每种都有对应的 HTML 模板:

| 错误类型 | 触发场景 | 用户看到 |
|---|---|---|
| `MissingHeaderError` | 本地 Header 模式缺 `E2b-Sandbox-Id/Port` | 400 "missing header" |
| `ErrInvalidHost` | Host 格式错误 | 400 "Invalid host" |
| `ErrInvalidSandboxID` | sandboxID 格式不合法 | 400 "Invalid sandbox ID" |
| `InvalidSandboxPortError` | 端口不是数字 / 越界 | 400 "Invalid sandbox port" |
| `SandboxNotFoundError` | catalog miss + auto-resume 失败 | HTML 错误页(sandbox not found) |
| `SandboxResumePermissionDeniedError` | auto-resume 时 token / team blocked | HTML 错误页 |
| `SandboxStillTransitioningError` | sandbox 在 pausing/snapshotting | HTML 错误页 |
| `SandboxResourceExhaustedError` | 团队 sandbox 配额耗尽 | HTML 错误页 |
| `MissingTrafficAccessTokenError` | 私有 ingress 缺 token | HTML 错误页 |
| `InvalidTrafficAccessTokenError` | 私有 ingress token 不匹配 | HTML 错误页 |
| `SandboxTooManyConnectionsError` | 超过单 sandbox 连接限流 | HTML 错误页 |

### 14.2 port closed 错误的特殊处理

`packages/shared/pkg/proxy/pool/client.go:150-163`:

```go
if t.DefaultToPortError {
    err = template.NewPortClosedError(t.SandboxId, r.Host, t.SandboxPort).HandleError(w, r)
    return
}
```

orchestrator proxy 在 `Destination` 里设了 `DefaultToPortError: true`,意味着后端连接失败时默认认为是 sandbox 内端口未监听,返回 `PortClosedError`(更友好的错误页)。

---

## 十五、设计要点与权衡

### 15.1 为什么用 Host 编码而非 path / query

| 方案 | 优势 | 劣势 |
|---|---|---|
| **Host 编码** ✅(选定) | TLS SNI 一致、CDN 友好、可在 DNS 层负载均衡 | 必须配 wildcard DNS / 证书 |
| Path(`/sandboxes/{id}/ports/{port}/`) | URL 清晰 | 需要 URL 重写、不利 TLS |
| Query(`?sbx={id}&port={n}`) | 最简单 | 破坏 REST 语义、不利缓存 |

Host 编码让 sandbox 流量与普通 HTTP 服务在协议层无差别——浏览器、curl、SDK 都能直接用。

### 15.2 为什么三层都重新解析

每层代理都独立调 `GetTargetFromRequest`:

```go
sandboxId, port, err := getTargetFromRequest(r)
```

**看似冗余,实际必要**:

1. **不信任上游**:client-proxy 可能被绕过(直接打 orchestrator proxy),需要在 orchestrator 端重新校验
2. **协议层独立**:Host 头在每个 HTTP hop 都可能变(mask 改写),不能依赖 metadata 透传
3. **故障隔离**:即使 client-proxy 配错,orchestrator 仍能正确路由

代价是 CPU(重复解析字符串),但相对网络 RTT 可忽略。

### 15.3 为什么用 in-memory map 而非 Redis

orchestrator proxy 用 `sandboxes.Get(sandboxId)`(in-memory map)而非 Redis 查询:

- **性能**:in-memory 查询比 Redis 快 10-100 倍
- **正确性**:orchestrator 只路由本地节点的 sandbox,本地数据天然权威
- **隔离**:跨节点路由由 client-proxy / catalog 处理,orchestrator proxy 只关心本地

代价是节点重启后 in-memory map 丢失——但 sandbox 也丢了(VM 进程没了),所以一致。

### 15.4 为什么 traffic token 在 Layer 2 校验而非 Layer 1

Layer 1 (client-proxy) 没有 sandbox 配置(它在 Redis catalog 里只有 IP),无法拿到预期的 token。Layer 2 (orchestrator) 才持有 sandbox 的完整配置。

副作用:auto-resume 触发时,API 的 gRPC handler 也会校验一次(因为此时还没到 Layer 2)。这就是为什么校验逻辑在 `proxy_grpc.go:ResumeSandbox` Phase 7 又实现了一次——同一校验逻辑分布在两个地方,需要保持同步。

### 15.5 端口 1:1 直通的代价

| 收益 | 代价 |
|---|---|
| 路由逻辑极简,无映射表 | sandbox 内业务必须监听对外可达端口 |
| Host 编码自描述 | 端口冲突:同 sandbox 不能有两个进程监听同端口 |
| 易于 SDK / 文档生成 | 不能做端口隐藏(扫描到 sandbox 就能扫到所有端口) |

token 校验弥补了端口扫描的风险——私有 ingress 让"端口存在但不可访问"成为可能。

---

## 十六、常见问题与排查

### Q1:用户访问 `https://3000-{id}.sandbox.e2b.dev` 得到 404 sandbox not found

最可能原因:
- sandbox 已被销毁(超过 `timeout` 且未配 auto-resume)
- sandbox 被 pause,但 `Policy=Off`
- Redis catalog 数据丢失(Redis 故障)

**排查**:
1. 调 `GET /sandboxes/{id}` 看 sandbox 是否存在
2. 看 client-proxy 日志,是否有 `catalog miss, attempting resume via api`
3. 看 API 日志的 `ResumeSandbox` 失败原因

### Q2:用户得到 "Invalid host" 400

Host 格式错误。常见原因:
- 缺少 `-` 分隔(`{sandboxID}.sandbox.e2b.dev`,缺 port)
- 缺少 `.` 分隔(`3000-{id}`,缺域名)
- sandboxID 格式不合法

### Q3:用户得到 "Invalid sandbox port" 400

`hostParts[0]` 不是合法 uint。例如:
- `{abc}-{id}.{domain}`(端口段不是数字)
- `-{id}.{domain}`(端口段为空)

### Q4:用户得到 traffic access token 相关错误

| 错误 | 含义 | 处理 |
|---|---|---|
| `MissingTrafficAccessTokenError` | sandbox 配了私有 ingress,但请求没带 `e2b-traffic-access-token` header | 客户端必须从 sandbox 创建响应里拿 token,加到后续请求 header |
| `InvalidTrafficAccessTokenError` | header 有但值不匹配 | token 过期或被泄露/篡改,需要重新创建 sandbox |

### Q5:sandbox 内业务能起,但外部访问一直超时

可能原因:
1. 业务监听 `127.0.0.1` 而非 `0.0.0.0`——必须改对外可达
2. 业务 listen 在错误端口(创建 sandbox 时声明 EXPOSE 3000,实际 listen 3001)
3. orchestrator proxy 重试 5 次都失败(`SandboxProxyRetries = 5`),最后返回 `PortClosedError`

**排查**:
- sandbox 内 `ss -tlnp` 确认监听地址和端口
- 看 orchestrator 日志的 `sandbox error handler called`

### Q6:同一个请求,有时通有时不通

可能原因:
1. **catalog miss 窗口期**:sandbox 刚 pause,Redis 还没删;或刚 resume,Redis 还没写。在 5-10 秒内的请求有的 hit 有的 miss
2. **多节点**:sandbox 在迁移中,新旧 nodeIP 短暂并存

**处理**:在客户端加 retry。

### Q7:envd 流量被 traffic token 校验拦了

不应该发生——envd 端口(49983)的流量绕过 traffic token 校验。如果发生,说明:
- 端口解析错误(实际不是 49983 但被识别成 49983)
- isNonEnvdTraffic 判定 bug

**排查**:看 orchestrator 日志的 `port` 字段。

### Q8:共享主机模式下 Host 改写导致业务异常

业务可能依赖原始 Host 做路由(如 multi-tenant SaaS)。改写后会破坏:

- 检查 ingress 配置的 `MaskRequestHost` 是否合理
- 业务侧用 `X-Forwarded-Host` header 取原始 Host(`pool/client.go:114` 保留了)
- 升级到支持 `OrchAcceptsCombinedHostFlag` 的 orchestrator 版本,关闭改写

### Q9:WebSocket 流量如何处理

WebSocket 升级握手走 HTTP,三层代理对 UPGRADE 请求透明。升级后变成 raw TCP 透传,Host 编码 / token 校验只在握手时做一次。

注意:`idleTimeout = 610/620s` 对长连接 WebSocket 是问题——空闲超过 10 分钟会被关。业务侧需要发送 ping 保活。

### Q10:能否绕过 client-proxy 直接访问 orchestrator proxy

理论上可以(知道 nodeIP:5007 即可),但:
- nodeIP 通常是内网 IP(GCP VPC),公网不可达
- 即使可达,也缺少 client-proxy 的 OAuth / DDoS 防护
- 生产部署 orchestrator proxy 监听在内网,公网防火墙屏蔽

不建议,也不被支持。

---

## 附录 A:关键常量速查

| 常量 | 位置 | 值 | 用途 |
|---|---|---|---|
| `orchestratorProxyPort` | `client-proxy/proxy.go:29` | `5007` | client-proxy → orchestrator 的固定目标端口 |
| `DefaultEnvdServerPort` | `shared/pkg/consts/envd.go:4` | `49983` | envd daemon 监听端口 |
| `idleTimeout`(client-proxy) | `client-proxy/proxy.go:34` | `610s` | > GCP LB 的 600s |
| `idleTimeout`(orchestrator) | `orchestrator/proxy.go:32` | `620s` | > client-proxy 的 610s |
| `trafficAccessTokenHeader` | `orchestrator/proxy/proxy.go:34` | `"e2b-traffic-access-token"` | 业务流量 token header 名 |
| `MetadataEnvdHTTPAccessToken` | `shared/pkg/grpc/proxy/metadata.go` | (string) | envd HTTP 流量 token header 名 |
| `MetadataSandboxRequestPort` | `shared/pkg/grpc/proxy/metadata.go:7` | `"e2b-sandbox-request-port"` | auto-resume gRPC 元数据 |
| `ClientProxyRetries` | `shared/pkg/proxy/` | (常量) | client-proxy 重试次数 |
| `SandboxProxyRetries` | `shared/pkg/proxy/` | `5` | orchestrator proxy 重试次数 |
| `sandboxSharedHostSubdomain` | `shared/pkg/proxy/host.go:14` | `"sandbox."` | 共享主机前缀 |
| `headerSandboxID` | `shared/pkg/proxy/host.go:110` | `"E2b-Sandbox-Id"` | 本地 Header 模式 sandboxID |
| `headerSandboxPort` | `shared/pkg/proxy/host.go:111` | `"E2b-Sandbox-Port"` | 本地 Header 模式 port |

---

## 附录 B:代码文件索引

| 文件 | 主要导出 | 说明 |
|---|---|---|
| `packages/shared/pkg/proxy/host.go` | `GetTargetFromRequest`、`parseHost`、`parseHeaders`、`shouldParseHeaders`、`SandboxSharedHostDomain` | Host 解析(两层代理共用) |
| `packages/shared/pkg/proxy/handler.go` | `handler` | 反向代理 HTTP handler,错误分类 |
| `packages/shared/pkg/proxy/pool/client.go` | (pool client) | 连接池,Host 改写 |
| `packages/shared/pkg/consts/envd.go` | `DefaultEnvdServerPort` | envd 端口常量 |
| `packages/client-proxy/internal/proxy/proxy.go` | `NewClientProxy`、`catalogResolution`、`handlePausedSandbox`、`clientProxyMaskRequestHost` | Layer 1 入口 |
| `packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go` | `NewGRPCPausedSandboxResumer`、`Resume` | catalog miss 时 gRPC 唤醒 API |
| `packages/orchestrator/pkg/proxy/proxy.go` | `NewSandboxProxy`、`SandboxProxy` | Layer 2 入口 |
| `packages/orchestrator/pkg/proxy/metrics.go` | `Metrics` | 连接数 / 持续时间 OTel 指标 |
| `packages/orchestrator/pkg/sandbox/sandbox.go` | `Config.GetNetworkIngress` | ingress 配置读取 |
| `packages/shared/pkg/sandbox-catalog/catalog_redis.go` | `RedisSandboxCatalog` | Redis catalog 实现 |
| `packages/shared/pkg/grpc/proxy/metadata.go` | 各 metadata 常量 | gRPC 元数据 keys |

---

## 附录 C:术语表

| 术语 | 含义 |
|---|---|
| **Client-Proxy** | 公网边缘反向代理,跨节点路由 |
| **Orchestrator Proxy** | 节点内反向代理,查本地 sandbox map |
| **Catalog** | Redis 中 sandboxID → nodeIP 映射 |
| **Sandbox Map** | orchestrator 进程内 sandboxID → sandbox 对象映射 |
| **Host 编码** | `{port}-{sandboxID}.{domain}` 格式的路由信息编码 |
| **Header 旁路** | 本地 / IP / 共享主机场景下用 `E2b-Sandbox-Id/Port` header 替代 Host 编码 |
| **envd 流量** | 目标端口 49983 的 SDK 控制流量 |
| **业务流量** | 目标端口非 49983 的用户业务流量 |
| **私有 ingress** | 配了 `TrafficAccessToken` 的 sandbox,业务流量需要 token |
| **公共 ingress** | 没配 token 的 sandbox,业务流量开放 |
| **MaskRequestHost** | 共享主机模式下的 Host 改写机制 |
| **traffic-access-token** | 业务流量校验用 token,header 名 `e2b-traffic-access-token` |
| **envd access token** | envd 流量校验用 token(secure sandbox) |
| **orchestratorProxyPort** | 5007,client-proxy → orchestrator 的固定目标端口 |
| **idleTimeout** | 长连接空闲超时,> GCP LB 的 600s 避免竞态 |
| **PortClosedError** | sandbox 内端口未监听时返回的用户友好错误页 |
