# Sandbox Public URI 到沙箱服务的访问链路

本文说明一次公网请求如何从 Sandbox Public URI 到达 Firecracker microVM 内的用户服务，并沿原路返回响应。重点覆盖正常运行、私有 ingress、暂停后自动恢复和自定义域名四种情况。

相关深度文档：

- [Sandbox 流量路由](./sandbox-traffic-routing.md)：Client Proxy、连接池和错误处理的源码细节
- [Auto-resume](./auto-resume-module.md)：catalog miss 后的恢复状态机
- [Sandbox 生命周期](./sandbox-lifecycle.md)：创建、暂停、恢复和销毁
- [Envd](./envd-module.md)：VM 内端口扫描与 localhost 转发

## 1. URI 与访问前提

标准 Public URI 的形式是：

```text
https://<port>-<sandboxID>.<sandbox-domain>/<path>
```

例如：

```text
https://3000-i7fa3.sandbox.example.com/api/health
```

这个 URI 同时编码了两个路由参数：

| URI 部分 | 示例 | 用途 |
|---|---:|---|
| `port` | `3000` | microVM 内用户服务监听的 TCP 端口 |
| `sandboxID` | `i7fa3` | 定位 Sandbox 和其所在 orchestrator 节点 |
| `sandbox-domain` | `sandbox.example.com` | 将公网请求送到 Sandbox 流量入口 |
| `path` | `/api/health` | 原样交给用户服务 |

请求成功还需要满足以下条件：

1. `*.<sandbox-domain>` 的 DNS 指向公网负载均衡器。
2. TLS 证书覆盖 `*.<sandbox-domain>`。
3. 负载均衡器将通配 Sandbox Host 路由到 Client Proxy。
4. Sandbox 正在运行；或者已暂停但允许自动恢复。
5. 用户服务正在目标 TCP 端口监听。推荐监听 `0.0.0.0:<port>`；监听 `127.0.0.1` 或 `localhost` 时，envd 会检测并建立转发。
6. 私有 ingress 在创建时同时启用 `secure: true`，且业务端口请求携带正确的 `e2b-traffic-access-token`。

`network.allowPublicTraffic` 默认是 `true`。它只决定入站业务流量是否需要 token，不决定 Sandbox 是否能够访问互联网，也不等同于模板的 `public` 属性。

## 2. 总链路

```text
Browser / HTTP Client
  │
  │ HTTPS
  │ Host: 3000-i7fa3.sandbox.example.com
  ▼
Public DNS
  │  *.sandbox.example.com -> load balancer
  ▼
Cloud Load Balancer / TLS termination
  │  根据通配 Host 选择 Sandbox 流量后端
  ▼
Client Proxy :3002
  │  ① Host -> sandboxID=i7fa3, port=3000
  │  ② Redis catalog: sandboxID -> orchestratorIP
  │  ③ catalog miss 时请求 API 自动恢复
  ▼
Orchestrator node :5007
  │  ④ 再次解析 sandboxID 和 port
  │  ⑤ 查节点内 sandbox map
  │  ⑥ 校验 traffic access token
  │  ⑦ 目标 = sandbox slot IP:3000
  ▼
Per-sandbox network namespace / veth / tap
  │
  ▼
Firecracker microVM :3000
  │  用户服务处理请求
  ▼
Response 沿反向链路返回
```

正常业务流量不会经过 API。API 只在 Sandbox 生命周期操作，以及暂停 Sandbox 的流量触发自动恢复时进入链路。

## 3. 分步说明

### 3.1 DNS 与 TLS

客户端先解析完整 Host：

```text
3000-i7fa3.sandbox.example.com
```

通配 DNS 将它解析到公网负载均衡器。TLS 握手发生在负载均衡器，证书必须包含 `*.sandbox.example.com`；否则请求在进入应用层之前就会失败。

不同部署的下一跳略有不同：

| 部署 | 入口路径 |
|---|---|
| GCP | HTTPS Load Balancer 直接将 `*.<domain>` 送到 session backend，即 Client Proxy `:3002` |
| AWS | ALB 将请求送到 Traefik ingress，再由最低优先级的通配路由送到 Client Proxy |

GCP 的 Host 规则和 session backend 见 [`iac/provider-gcp/nomad-cluster/network/main.tf`](../iac/provider-gcp/nomad-cluster/network/main.tf)。AWS 的 ALB 和 Traefik 服务发现分别见 [`iac/provider-aws/alb.tf`](../iac/provider-aws/alb.tf) 与 [`iac/modules/job-client-proxy/jobs/client-proxy.hcl`](../iac/modules/job-client-proxy/jobs/client-proxy.hcl)。

### 3.2 Client Proxy 解析 Public URI

Client Proxy 使用共享的 `GetTargetFromRequest` 解析请求。常规 Public URI 走 Host 解析：

```text
3000-i7fa3.sandbox.example.com
└───────┬──────┘
        ├─ port      = 3000
        └─ sandboxID = i7fa3
```

解析器只读取最左侧 DNS label，并按 `-` 分割：第一段是端口，第二段是 Sandbox ID。Sandbox ID 随后还会经过格式校验。实现见 [`packages/shared/pkg/proxy/host.go`](../packages/shared/pkg/proxy/host.go)。

另有一种 header 路由模式，仅在 Host 是 IP、`localhost` 或 `sandbox.<domain>` 时启用：

```http
E2b-Sandbox-Id: i7fa3
E2b-Sandbox-Port: 3000
```

这主要用于共享入口和本地测试；标准 Public URI 不需要这两个 header。

### 3.3 Redis catalog 定位节点

Client Proxy 用 `sandboxID` 查询 Redis routing catalog：

```text
sandbox:catalog:i7fa3
  -> orchestrator_id
  -> orchestrator_ip
  -> execution_id
  -> sandbox_started_at
  -> sandbox_max_length_in_hours
```

Sandbox 创建完成后，API 将这条记录写入 catalog；Client Proxy 只读取它，不参与 Sandbox 放置。实现见：

- [`packages/api/internal/orchestrator/lifecycle.go`](../packages/api/internal/orchestrator/lifecycle.go)：写入节点路由
- [`packages/shared/pkg/sandbox-catalog/catalog_redis.go`](../packages/shared/pkg/sandbox-catalog/catalog_redis.go)：Redis 读写
- [`packages/client-proxy/internal/proxy/proxy.go`](../packages/client-proxy/internal/proxy/proxy.go)：解析 catalog 结果

catalog 命中后，Client Proxy 得到 owning node 的 IP，并将请求转发到：

```text
http://<orchestratorIP>:5007
```

请求的 method、path、query、body 和业务 header 会继续传递。连接池按下游节点管理连接。

### 3.4 Orchestrator Proxy 定位 Sandbox

每个 Sandbox 节点上的 Orchestrator Proxy 监听 `:5007`。它再次从请求中解析 `sandboxID` 和 `port`，然后在节点内存的 sandbox map 中查找当前 Sandbox 实例。

找到实例后，目标地址被设置为：

```text
http://<sandbox-slot-host-IP>:<port>
```

这里不是 Sandbox 的公网 IP。每个 Sandbox 使用独立 network namespace、veth、tap 和唯一 slot IP；节点内 NAT 再把流量送入对应的 Firecracker microVM。实现见 [`packages/orchestrator/pkg/proxy/proxy.go`](../packages/orchestrator/pkg/proxy/proxy.go) 和 [`packages/orchestrator/pkg/sandbox/network/network.go`](../packages/orchestrator/pkg/sandbox/network/network.go)。

### 3.5 VM 内端口到用户服务

用户服务监听 `0.0.0.0:<port>` 时，可以直接从 VM 网络接口接收流量。

如果服务只监听 `127.0.0.1`、`localhost` 或 `::1`，envd 会按运行时提供的扫描周期扫描 TCP LISTEN 端口，并启动 `socat`（当前 envd 入口使用的默认周期为 1 秒）：

```text
169.254.0.21:<port> -> localhost:<port>
```

因此 localhost 服务也能通过 Public URI 到达，但首次发现端口可能有短暂延迟；Orchestrator Proxy 会对端口连接做有限重试。实现见 [`packages/envd/internal/port/scan.go`](../packages/envd/internal/port/scan.go) 和 [`packages/envd/internal/port/forward.go`](../packages/envd/internal/port/forward.go)。

如果目标端口没有进程监听，代理最终返回“Sandbox 正在运行，但端口未打开”的错误。

### 3.6 响应返回

用户服务的 HTTP 响应按原连接返回：

```text
User service
  -> VM network
  -> Orchestrator Proxy
  -> Client Proxy
  -> Load Balancer
  -> Client
```

这条链路支持普通 HTTP 请求、流式响应和 WebSocket。Public URI 不是通用的公网 TCP/UDP 映射；目标服务需要使用代理能够承载的 HTTP 协议族。

## 4. 运行状态分支

### 4.1 Public ingress

创建 Sandbox 时未设置 `network.allowPublicTraffic`，或显式设置为 `true`：

```json
{
  "network": {
    "allowPublicTraffic": true
  }
}
```

API 不生成 traffic access token，业务请求可以匿名通过 Public URI 到达用户服务。用户服务仍可实现自己的 Cookie、JWT 或其他应用层认证。

### 4.2 Private ingress

设置：

```json
{
  "secure": true,
  "network": {
    "allowPublicTraffic": false
  }
}
```

`secure: true` 是 private ingress 的创建前提；缺少它时 API 返回 `400`，不会创建 Sandbox。创建成功后，API 为 Sandbox 生成 `trafficAccessToken`，业务端口调用方必须发送：

```http
e2b-traffic-access-token: <trafficAccessToken>
```

运行中 Sandbox 的请求由 Orchestrator Proxy 使用常量时间比较校验 token：

```text
缺少 token  -> 403
token 错误  -> 403
token 正确  -> 转发到用户服务
```

Client Proxy 在正常转发路径中只透传 token，不执行最终校验，因为真正的 ingress 配置保存在 owning node。端口 `49983` 是 envd 的特殊端口，不使用 traffic token，而由 envd 自己校验 `X-Access-Token`。

### 4.3 Paused Sandbox 与 auto-resume

Sandbox 暂停后会离开 Redis catalog。此时 Public URI 请求触发以下分支：

```text
Client Proxy
  │
  ├─ Redis GetSandbox -> catalog miss
  │
  ├─ gRPC ResumeSandbox -> API
  │    ├─ 查找 snapshot
  │    ├─ 检查 autoResume.enabled
  │    ├─ 拒绝 filesystem-only snapshot 的隐式恢复
  │    ├─ private ingress 的业务端口先校验 traffic token
  │    ├─ secure envd 端口 49983 先校验 X-Access-Token
  │    ├─ 重新放置并恢复 Sandbox
  │    └─ 写回 Redis catalog，返回 orchestrator IP
  │
  └─ 使用新节点 IP 继续当前 HTTP 请求
```

自动恢复成立的必要条件：

1. 创建时启用 `autoResume.enabled`。
2. 暂停产物包含内存状态；filesystem-only snapshot 必须显式恢复。
3. 团队和资源限制允许恢复。
4. private ingress 的非 envd 请求携带正确 traffic token；secure envd `49983` 请求携带正确 `X-Access-Token`。

如果条件不成立，请求会得到 not found、permission denied、still transitioning 或 resource exhausted 对应错误，而不会无限等待。

## 5. 自定义域名为什么不能只用 CNAME

假设希望把：

```text
https://3000-i7fa3.sandbox.example.com
```

变成：

```text
https://demo.sandbox.com
```

下面的裸 CNAME 不足以完成映射：

```dns
demo.sandbox.com CNAME 3000-i7fa3.sandbox.example.com
```

DNS 只返回目标地址。浏览器发出的 HTTP Host 和 TLS SNI 仍然是：

```text
demo.sandbox.com
```

Client Proxy 无法从这个 Host 解析出 `port=3000` 和 `sandboxID=i7fa3`，所以请求不会自动到达目标 Sandbox。

要使用友好域名，必须在某一层保存这条映射：

```text
demo.sandbox.com -> sandboxID=i7fa3, port=3000
```

当前可用方式：

| 方式 | 映射位置 | 特点 |
|---|---|---|
| CDN/LB Origin Host rewrite | Cloudflare 或负载均衡器 | 少量固定域名最省事 |
| Nginx/Traefik reverse proxy | 独立代理配置 | 可同时做 TLS、认证和 WebSocket |
| HTTP redirect | 边缘规则 | 最简单，但浏览器地址会变回标准 Public URI |
| Client Proxy 原生 alias | 需要新增域名映射存储与解析逻辑 | 适合平台化管理大量用户域名，当前代码尚未实现 |

无论使用哪种方式，自定义域名都需要自己的 TLS 证书。private ingress 的 traffic token 应由可信代理注入，不应暴露在浏览器代码或公开 DNS 配置中。

## 6. 快速验证

Public ingress：

```bash
curl -i 'https://3000-i7fa3.sandbox.example.com/health'
```

Private ingress：

```bash
curl -i \
  -H 'e2b-traffic-access-token: <trafficAccessToken>' \
  'https://3000-i7fa3.sandbox.example.com/health'
```

按链路排查时，可以依次确认：

| 检查点 | 预期结果 |
|---|---|
| DNS | 完整 Host 解析到公网负载均衡器 |
| TLS | 证书覆盖完整 Host，握手成功 |
| LB | 通配 Host 命中 Sandbox/session 后端 |
| Host parser | 得到正确 `sandboxID` 和 `port` |
| Redis catalog | 运行中 Sandbox 能查到 owning node；暂停实例能进入 auto-resume |
| Node route | Client Proxy 能访问 `<orchestratorIP>:5007` |
| Ingress auth | Public 无 token；Private token 正确 |
| Sandbox map | owning node 上存在对应 Sandbox 实例 |
| VM port | 用户进程正在目标 TCP 端口监听 |

## 7. 源码导航

| 阶段 | 主要实现 |
|---|---|
| Public URI schema | [`spec/openapi.yml`](../spec/openapi.yml) |
| GCP DNS、TLS、LB | [`iac/provider-gcp/nomad-cluster/network/main.tf`](../iac/provider-gcp/nomad-cluster/network/main.tf) |
| AWS DNS、TLS、ALB | [`iac/provider-aws/domain.tf`](../iac/provider-aws/domain.tf)、[`iac/provider-aws/alb.tf`](../iac/provider-aws/alb.tf) |
| Host/header 解析 | [`packages/shared/pkg/proxy/host.go`](../packages/shared/pkg/proxy/host.go) |
| Client Proxy 路由 | [`packages/client-proxy/internal/proxy/proxy.go`](../packages/client-proxy/internal/proxy/proxy.go) |
| Redis catalog | [`packages/shared/pkg/sandbox-catalog/catalog_redis.go`](../packages/shared/pkg/sandbox-catalog/catalog_redis.go) |
| Paused Sandbox 恢复 | [`packages/api/internal/handlers/proxy_grpc.go`](../packages/api/internal/handlers/proxy_grpc.go) |
| Orchestrator Proxy | [`packages/orchestrator/pkg/proxy/proxy.go`](../packages/orchestrator/pkg/proxy/proxy.go) |
| Sandbox 网络 | [`packages/orchestrator/pkg/sandbox/network/network.go`](../packages/orchestrator/pkg/sandbox/network/network.go) |
| VM 内 localhost 转发 | [`packages/envd/internal/port/forward.go`](../packages/envd/internal/port/forward.go) |

## 8. Host 解析的精确规则

前面的链路图把 Host 解析简化成了“端口 + Sandbox ID”。实际实现还要决定是否允许 routing header、校验端口和校验 Sandbox ID。Client Proxy 和 Orchestrator Proxy 都调用同一个共享解析器，因此入口和节点侧对非法请求的判断保持一致。

### 8.1 标准 Host 的语法

标准路径只使用 Host 的最左侧 label：

```text
<port>-<sandboxID>.<rest-of-host>
```

解析器的行为可以概括为：

1. Host 必须包含 `.`；没有域名部分时返回 `ErrInvalidHost`。
2. 只取第一个 `.` 之前的内容，后面的域名、端口和其他 label 不参与路由参数解析。
3. 最左侧内容按 `-` 分割，第一段按十进制无符号整数解析为端口，第二段作为 Sandbox ID。
4. 分割结果多于两段时，额外段不会被拼接进 ID；因此不要把带 `-` 的自定义 ID 当作完整 ID 传入。
5. 端口解析成功后，Sandbox ID 还要通过 `id.ValidateSandboxID`。

例如：

| Host | 解析结果 |
|---|---|
| `3000-i7fa3.sandbox.example.com` | `sandboxID=i7fa3`、`port=3000` |
| `49983-i7fa3.sandbox.example.com` | `sandboxID=i7fa3`、`port=49983`（envd） |
| `sandbox.example.com` | `400 Invalid host`，没有 `port-sandboxID` 前缀 |
| `3000.sandbox.example.com` | `400 Invalid host`，缺少 `-` |
| `http-i7fa3.sandbox.example.com` | `400 Invalid sandbox port` |
| `3000-非法ID.sandbox.example.com` | `400 Invalid sandbox ID`，ID 校验失败 |

这里的解析不是一个通用的 URL slug 解析器。尤其不能把完整域名、路径或 query 参数当作 Sandbox ID 的一部分。实现见 [`packages/shared/pkg/proxy/host.go`](../packages/shared/pkg/proxy/host.go)，测试见 [`packages/shared/pkg/proxy/host_test.go`](../packages/shared/pkg/proxy/host_test.go)。

### 8.2 Routing header 的优先级

当请求 Host 是本地地址、IP 地址或共享 Host `sandbox.<domain>`，并且至少出现一个 routing header 时，解析器先尝试 header 路径：

```http
E2b-Sandbox-Id: i7fa3
E2b-Sandbox-Port: 3000
```

两个 header 必须成对出现。只提供其中一个会返回 `400`；端口不是十进制整数也会返回 `400`。两个 header 都没有时才回退到 Host 解析。

| Host 类型 | routing header 存在 | 实际路径 |
|---|---:|---|
| `localhost` | 是 | header，随后校验 ID 和端口 |
| `127.0.0.1` 或其他 IP | 是 | header，随后校验 ID 和端口 |
| `sandbox.example.com` | 是 | header，随后校验 ID 和端口 |
| 上述 Host | 否 | 尝试标准 Host 解析，通常会得到 `400` |
| `3000-i7fa3.sandbox.example.com` | 任意 | 标准 Host 解析；生产域名不启用 header 旁路 |

判断共享 Host 时使用 Hostname，不把 `:port` 误当作域名的一部分。HTTP 头名称大小写由 `net/http` 处理，但文档和排障命令应使用代码中的规范拼写 `E2b-Sandbox-Id` 与 `E2b-Sandbox-Port`。

### 8.3 两层都做校验的原因

Client Proxy 先解析并校验，避免把明显非法的请求送到节点；Orchestrator Proxy 再解析并校验，避免绕过 Client Proxy 的内部入口直接访问 `:5007` 时缺少边界保护。两层的校验结果统一由共享 handler 转成：

| 错误 | HTTP 响应 |
|---|---|
| 缺 routing header | `400 missing header` |
| 无法解析 Host | `400 Invalid host` |
| ID 格式非法 | `400 Invalid sandbox ID` |
| 端口不是整数 | `400 Invalid sandbox port` |

这些错误发生在下游连接建立前，不会触发 Redis 查询、auto-resume 或节点内连接重试。看到 `400` 时，应先修正 Host/header，而不是检查 VM 进程。

## 9. 两层 proxy 的职责边界

Client Proxy 和 Orchestrator Proxy 都是 HTTP reverse proxy，但它们解决的是不同的寻址问题：前者把 Sandbox ID 映射到节点，后者把同一个 ID 映射到节点内的 network slot。

### 9.1 Client Proxy：catalog 与恢复入口

Client Proxy 的 destination 计算顺序如下：

```text
HTTP request
  -> GetTargetFromRequest
  -> Redis sandbox:catalog:<sandboxID>
  -> 命中: 得到 orchestratorIP
  -> 未命中: 调用 API ResumeSandbox
  -> 得到 orchestratorIP
  -> <orchestratorIP>:5007
```

Client Proxy 不读取节点内 sandbox map，也不决定 slot IP。Redis catalog value 包含 `orchestrator_id`、`orchestrator_ip`、`execution_id`、启动时间和最大生命周期，key 固定为 `sandbox:catalog:<sandboxID>`。记录由 API/orchestrator 生命周期代码写入，TTL 使用 Sandbox 最大生命周期小时数。

Redis 的单次读、写、删操作都有 1 秒 context timeout。读超时、空 IP 或其他 catalog 错误不会被当作“可以恢复”；Client Proxy 最终把无法得到节点路由的情况映射成 Sandbox not found 页面，避免把半成品路由发给下游。

### 9.2 Orchestrator Proxy：sandbox map 与 slot

节点侧 `:5007` 收到请求后再次解析 ID/端口，并从内存 sandbox map 查找当前生命周期。命中后目标地址是：

```text
<sandbox-slot-host-ip>:<requested-port>
```

它不是节点的公网 IP，也不是固定的 `5007`。`5007` 只代表 Client Proxy 到 Orchestrator Proxy 的这一跳；请求端口仍然保持原值，最终连接到 VM 内同号 TCP 端口。

节点侧还负责：

- 根据 ingress 配置校验业务端口的 `e2b-traffic-access-token`；
- 对 `49983` envd 端口跳过 traffic token，让 envd 校验 `X-Access-Token`；
- 应用 `maskRequestHost`，必要时将 `${PORT}` 替换为本次请求端口；
- 对每个 Sandbox 生命周期实施连接数限制和连接时长 metrics。

实现分别见 [`packages/client-proxy/internal/proxy/proxy.go`](../packages/client-proxy/internal/proxy/proxy.go) 与 [`packages/orchestrator/pkg/proxy/proxy.go`](../packages/orchestrator/pkg/proxy/proxy.go)。

### 9.3 Host、X-Forwarded-Host 与连接池

没有 mask 时，共享 reverse proxy 会保留原始 `Host`，不会主动调用 `SetXForwarded`。配置了 mask 时，upstream `Host` 被替换，原始值写入 `X-Forwarded-Host`：

```text
原始 Host: 3000-i7fa3.sandbox.example.com
upstream Host: api.internal.example.com
X-Forwarded-Host: 3000-i7fa3.sandbox.example.com
```

Client Proxy 的连接池 key 固定为 `client-proxy`，因为它的 upstream 是节点的 `IP:5007`，节点侧还会继续按 Sandbox 生命周期隔离连接。Orchestrator Proxy 的 key 使用生命周期 ID，而不是仅使用 slot IP；这个 key 同时用于 per-sandbox connection limiter、pool 清理和生命周期级日志。Orchestrator Proxy 当前显式禁用 keep-alive，因此不要把它理解成允许旧 HTTP keep-alive 连接跨生命周期复用。

## 10. Auto-resume 的鉴权与时序

暂停实例不在 routing catalog 中时，Client Proxy 把当前请求变成一次 API gRPC `ResumeSandbox` 调用。只有恢复成功取得节点 IP 后，当前 HTTP 请求才会继续走 `:5007`；恢复失败不会悄悄降级为匿名访问。

### 10.1 proto 与 metadata

`SandboxResumeRequest` 只包含 `sandbox_id`；请求端口和访问凭证全部使用 gRPC metadata 传递：

| metadata | 来源 | 用途 |
|---|---|---|
| `e2b-sandbox-request-port` | Host/header 解析出的端口 | API 区分业务端口与 envd `49983` |
| `e2b-traffic-access-token` | 原始 HTTP header | private ingress 业务端口鉴权 |
| `e2b-envd-access-token` | 原始 `X-Access-Token` | secure envd 鉴权 |
| `authorization` | 可选 OAuth client credentials | edge gRPC 的 Client Proxy 身份 |

对应常量见 [`packages/shared/pkg/grpc/proxy/metadata.go`](../packages/shared/pkg/grpc/proxy/metadata.go)，proto 见 [`packages/shared/pkg/grpc/proxy/proxy.proto`](../packages/shared/pkg/grpc/proxy/proxy.proto)。Client Proxy 的 gRPC 实现见 [`packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go`](../packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go)。

### 10.2 API 的前置条件

API `ResumeSandbox` 按以下顺序检查：

1. 若启用 `requireEdgeClientProxyAuth`，先验证 OAuth claims 和 `sandboxes:lifecycle` scope；配置了 cluster 时还要验证组织 claim 与 team cluster 匹配。
2. 将请求 ID 规范化为短 ID；非法值返回 gRPC `InvalidArgument`。
3. snapshot 必须存在，且 auto-resume policy 必须为 `Any`。不存在或策略不允许时返回 `NotFound`。
4. filesystem-only snapshot 不能被流量隐式恢复，返回 `FailedPrecondition`，调用方必须显式 resume。
5. 若 Sandbox 已经存在于 API/orchestrator 状态，先走 existing-sandbox 处理；过渡状态最多等待 1 分钟预算，仍在过渡时返回专用错误。
6. 检查团队状态、资源额度、private ingress token 和 secure envd token。
7. 启动 Sandbox，等待 node route 可用，并返回 `orchestrator_ip`。

API 不把请求 body 或 path 放入 gRPC request；恢复成功后原始 HTTP 请求仍由 Client Proxy 重新送入节点。这样 auto-resume 只负责生命周期和寻址，不改变应用请求语义。

### 10.3 两种 ingress 的 token 分支

private ingress 的判定来自 `network.Ingress.AllowPublicAccess != nil && !*AllowPublicAccess`，不是 `allowOut`/`denyOut` 等 egress 配置。

```text
请求端口 == 49983?
  ├─ 是: secure sandbox 需要 X-Access-Token 对应的 envd token
  └─ 否: private ingress 需要 e2b-traffic-access-token
```

API 和 Orchestrator Proxy 都使用常量时间比较。缺失或错误的业务 token 在恢复阶段返回 `PermissionDenied`，运行中的节点请求则由共享 handler 渲染为 `403` traffic-token 页面。secure envd 的 token 只用于 envd 路径，不应替代业务 traffic token。

`secure: true` 是创建 private ingress 的前提；创建阶段缺少 secure 会直接返回 `400`。secure 模板还必须满足 envd 版本要求，否则无法创建可恢复的安全 Sandbox。

### 10.4 catalog miss 的并发竞态

两个请求可能同时看到 catalog miss，并同时调用 `ResumeSandbox`。API 会先查询已有 Sandbox 状态，再走 existing-sandbox 处理；并发结果由当时的生命周期状态和过渡等待预算决定，可能直接得到已运行实例的节点 IP，也可能在过渡预算耗尽后得到 `409`。因此客户端不应把 `NotFound`、`409` 或 `429` 当作“继续无限重试”的信号。

恢复成功后，生命周期代码写回新的 catalog 记录，并带上新的 execution ID。删除旧生命周期时会先比较 execution ID，避免迟到的删除操作误删新生命周期的路由记录。

## 11. 重试、超时与错误映射

### 11.1 连接和 Redis 参数

| 位置 | 参数 | 设计意图 |
|---|---|---|
| Redis catalog | 每次操作 1 秒 | 快速失败，避免边缘请求长时间占用连接 |
| Client Proxy | idle timeout 610 秒 | 高于 GCP 600 秒上游空闲窗口 |
| Orchestrator Proxy | idle timeout 620 秒 | 继续高于前一跳，减少 keep-alive 竞态 |
| 共享 Proxy pool | 最多 16384 个 idle client 连接 | 每个 host 的上限按 4 路拆分（通常为 4096） |
| TCP dial | 每次 30 秒 | 等待节点或 VM 端口建立连接 |
| Client Proxy dial | 1 次尝试 | 端口转发重试由节点侧负责 |
| Orchestrator Proxy dial | 5 次尝试 | 等待 envd 扫描并启动 socat |
| dial backoff | 100/200/300/400 ms | 仅在非最后一次尝试之间等待 |

Client Proxy 的 HTTP Server idle timeout 在 upstream idle timeout 上再留 10 秒 buffer。Orchestrator Proxy 创建 pool 时传入 `disableKeepAlives=true`，以降低不稳定用户服务重启时的连接复用风险；这与它仍然配置 620 秒 idle timeout 并不矛盾，后者是共享 pool 参数和服务端连接边界。反向代理没有设置 response-header 或读写超时来截断应用自己的流式响应；实际总时长仍受客户端、负载均衡器和下游服务约束。

### 11.2 HTTP 错误映射

共享 `handler.go` 先处理解析和路由错误，再交给模板或连接池。主要结果如下：

| 触发点 | 对外状态 | 说明 |
|---|---:|---|
| Host/header/ID/port 非法 | `400` | 请求未进入下游 |
| catalog 无记录且恢复不可用 | `502` | Sandbox not found 页面；不等同于 DNS 失败 |
| 恢复权限、private token 或 secure envd token 失败 | `403` | permission/token 页面 |
| Sandbox 仍处于恢复/切换状态 | `409` | still transitioning 页面 |
| 团队额度或资源耗尽 | `429` | team/resource limit 页面 |
| 连接到 VM 端口失败（节点侧 `DefaultToPortError=true`） | `502` | “Sandbox running but no service on port” 页面 |
| 其他下游连接错误 | `502` | generic route failure |

业务服务自己返回的 `4xx/5xx` 会由 reverse proxy 原样返回并记录状态码；只有代理自身无法建立下游连接时，才会套用上述 route/port 错误。看到 `502` 时要先区分“Sandbox 不存在”和“端口未监听”，不能只根据状态码判断。

### 11.3 不应盲目增加重试

重试只能覆盖短暂的连接建立问题，不能修复：

- 非法 Host、非法 Sandbox ID 或缺少 token；
- auto-resume policy 不允许或 filesystem-only snapshot；
- team quota、cluster 归属或 OAuth scope 错误；
- 用户服务没有监听目标端口。

应用层 SDK 如果要重试，建议读取错误页面/日志中的原因，并采用有上限的指数退避；不要在每次 `502` 上重新创建 Sandbox，也不要绕过 `:5007` 直接向 VM slot 发请求。

## 12. Envd 端口发现的边界

### 12.1 Scanner 是配置驱动的周期扫描

envd 的 Scanner 使用 gopsutil 扫描 TCP 连接并广播给 Forwarder。扫描周期由构造函数传入，来自 envd 运行配置；排障文档不应把“每秒”当作协议保证。新进程监听端口后，至少要等待一次扫描和 socat 启动，Orchestrator Proxy 的 5 次连接尝试就是为这段窗口服务的。

### 12.2 只有 localhost LISTEN 会被转发

Forwarder 的过滤条件同时要求：

- TCP 连接状态是 `LISTEN`；
- 本地地址是 `127.0.0.1`、`localhost` 或 `::1`。

监听 `0.0.0.0:<port>` 或 VM 对外网卡的服务不需要这条 socat 旁路。UDP、已建立连接、非 localhost 地址和仅绑定 Unix socket 都不会被 Public URI 端口转发覆盖。

### 12.3 socat 的地址和生命周期

对于每个 `(pid, port)`，envd 启动一个独立进程组的 socat：

```text
TCP4-LISTEN:<port>,bind=169.254.0.21,reuseaddr,fork
  -> TCP{4|6}:localhost:<port>
```

固定的 `169.254.0.21` 是 VM gateway 地址，不是用户服务应该监听的公网地址。端口停止监听后，Forwarder 会杀掉整个 process group，避免 `fork` 出来的 socat 子进程残留。实现见 [`packages/envd/internal/port/scan.go`](../packages/envd/internal/port/scan.go) 和 [`packages/envd/internal/port/forward.go`](../packages/envd/internal/port/forward.go)。

端口转发不是端口注册 API，也不会向 Redis catalog 写入端口信息。要排查“URL 404/502 但进程已启动”，应先在 VM 内确认 `LISTEN` 地址和端口，再确认 envd 日志中是否发现并转发了该 `(pid, port)`。

## 13. 自定义域名、mask 与 private ingress

### 13.1 三种概念不要混用

| 概念 | 改变什么 | 是否提供 Sandbox 到域名的持久映射 |
|---|---|---:|
| DNS CNAME | DNS 返回的地址 | 否；浏览器 Host/SNI 仍是自定义域名 |
| `maskRequestHost` | 转发到下游时的 Host | 否；只改变 upstream 请求头 |
| 自定义域名 alias | 入口域名到 `(sandboxID, port)` 的映射 | 当前代码没有原生实现 |

因此，单独增加 `demo.example.com CNAME 3000-id.sandbox.example.com` 不能让 Client Proxy 解析出端口和 ID。需要在 CDN/LB、Traefik/Nginx 或业务代理层完成 Host rewrite/redirect，或者新增平台级 alias 存储和解析逻辑。

### 13.2 maskRequestHost 的真实语义

OpenAPI 的 `network.maskRequestHost` 是入口请求 Host mask，不是 DNS alias。API 创建阶段会校验 host 可转换为 ASCII；Orchestrator Proxy 只对非 envd 流量应用它，并将 `${PORT}` 替换成原始请求端口：

```text
配置: api.example.com:${PORT}
端口: 3000
upstream Host: api.example.com:3000
```

共享 Host 的兼容路径还可能先由 Client Proxy 将 `sandbox.<domain>` 重写为 `<port>-<sandboxID>.<domain>`，并保存原始 Host 到 `X-Forwarded-Host`。是否启用这一步由 `OrchAcceptsCombinedHostFlag` feature flag 决定，不应把它当作所有部署都存在的固定行为。

### 13.3 private ingress 的代理边界

自定义反向代理可以代用户注入 `e2b-traffic-access-token`，但 token 只能在可信服务端保存和注入。把 token 写入前端 JavaScript、公开 URL、缓存 key 或浏览器可见的 redirect 会绕过 private ingress 的安全边界。对于 secure envd，`X-Access-Token` 是另一套凭证，不能用业务 token 替换。

## 14. 可观测性与排障顺序

### 14.1 从外到内逐层确认

推荐按以下顺序排查，每一步都能把问题范围缩小一层：

1. **DNS/TLS**：确认完整 Host 解析到正确负载均衡器，证书覆盖通配域名或自定义域名。
2. **LB/ingress**：确认 GCP session backend 或 AWS Traefik route 收到请求，且健康检查通过。
3. **Host parser**：从 Client Proxy 日志确认 `sandboxID`、`port`；若是 `400`，停止向后排查。
4. **Redis catalog**：检查 `sandbox:catalog:<id>` 是否存在、IP 是否非空、TTL 是否覆盖当前生命周期。暂停实例应观察到 catalog miss 后的 `ResumeSandbox` 调用。
5. **API auto-resume**：检查 snapshot、policy、filesystem-only、OAuth scope、team/cluster 和 token 分支。
6. **Node route**：从 Client Proxy 到 `<orchestratorIP>:5007` 的 TCP 连接是否成功；注意 Client Proxy 只重试一次。
7. **Sandbox map/ingress**：节点是否有同一生命周期的 sandbox map 项，业务 token 是否通过 constant-time compare。
8. **VM port**：用户进程是否监听目标 TCP 端口；localhost 监听还要确认 envd scanner/Forwarder 已经建立 socat。

### 14.2 可用的信号

| 信号 | 代码位置/名称 | 用途 |
|---|---|---|
| Redis trace | `sandbox-catalog-get/store/delete` | 判断 catalog 延迟、miss 或写入失败 |
| Client Proxy log | `catalog miss, attempting resume via api` | 证明请求进入 auto-resume 分支 |
| gRPC connection observer | `api-resumer` | 查看 API resumer 连接状态 |
| Proxy pool metrics | client/orchestrator pool connections、pool size | 区分连接堆积和单次 dial 失败 |
| Orchestrator metrics | per-sandbox acquired/released/blocked/duration | 判断连接限流和长连接；`sandbox-max-incoming-connections` 默认值为 `-1`（不限制） |
| envd logs | port scanner/port forwarding | 判断 localhost 端口是否被发现和转发 |

不要把“HTTP 502”直接解释成 VM 崩溃：它也可能是 catalog miss、节点路由为空、端口未监听或下游连接耗尽。应结合错误模板、sandbox ID、port 和 owning node 日志交叉判断。

### 14.3 最小复现命令

```bash
# 公共业务端口
curl -sv 'https://3000-i7fa3.sandbox.example.com/health'

# 私有业务端口
curl -sv \
  -H 'e2b-traffic-access-token: <trafficAccessToken>' \
  'https://3000-i7fa3.sandbox.example.com/health'

# secure envd（端口 49983 的控制请求）
curl -sv \
  -H 'X-Access-Token: <envdAccessToken>' \
  'https://49983-i7fa3.sandbox.example.com/health'
```

命令只验证入口行为，不代替在 VM 内检查监听地址。不要在共享终端、工单或日志中粘贴真实 token。

## 15. 关键代码与测试索引

| 主题 | 实现 | 测试/补充 |
|---|---|---|
| Host/header 解析 | [`packages/shared/pkg/proxy/host.go`](../packages/shared/pkg/proxy/host.go) | [`packages/shared/pkg/proxy/host_test.go`](../packages/shared/pkg/proxy/host_test.go) |
| 共享错误与 HTTP 映射 | [`packages/shared/pkg/proxy/handler.go`](../packages/shared/pkg/proxy/handler.go) | [`packages/shared/pkg/proxy/proxy_test.go`](../packages/shared/pkg/proxy/proxy_test.go) |
| 连接池、dial、Host mask | [`packages/shared/pkg/proxy/pool/client.go`](../packages/shared/pkg/proxy/pool/client.go)、[`packages/shared/pkg/proxy/pool/destination.go`](../packages/shared/pkg/proxy/pool/destination.go) | [`packages/shared/pkg/proxy/proxy_test.go`](../packages/shared/pkg/proxy/proxy_test.go) |
| Client Proxy catalog/恢复 | [`packages/client-proxy/internal/proxy/proxy.go`](../packages/client-proxy/internal/proxy/proxy.go) | [`packages/client-proxy/internal/proxy/proxy_test.go`](../packages/client-proxy/internal/proxy/proxy_test.go) |
| Client Proxy → API gRPC | [`packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go`](../packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go) | [`paused_sandbox_resumer_grpc_test.go`](../packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc_test.go)、[`grpc_resume_auth_test.go`](../packages/client-proxy/internal/proxy/grpc_resume_auth_test.go) |
| API auto-resume | [`packages/api/internal/handlers/proxy_grpc.go`](../packages/api/internal/handlers/proxy_grpc.go) | [`packages/api/internal/handlers/proxy_grpc_test.go`](../packages/api/internal/handlers/proxy_grpc_test.go) |
| Catalog 生命周期 | [`packages/api/internal/orchestrator/lifecycle.go`](../packages/api/internal/orchestrator/lifecycle.go)、[`packages/shared/pkg/sandbox-catalog/catalog_redis.go`](../packages/shared/pkg/sandbox-catalog/catalog_redis.go) | [`packages/client-proxy/internal/proxy/proxy_test.go`](../packages/client-proxy/internal/proxy/proxy_test.go) |
| Orchestrator Proxy | [`packages/orchestrator/pkg/proxy/proxy.go`](../packages/orchestrator/pkg/proxy/proxy.go) | 共享 proxy 测试覆盖 pool/handler；节点级行为需结合 sandbox smoke test |
| VM localhost 转发 | [`packages/envd/internal/port/scan.go`](../packages/envd/internal/port/scan.go)、[`packages/envd/internal/port/forward.go`](../packages/envd/internal/port/forward.go) | [`web-docs/envd-module.md`](./envd-module.md) §8 |
| Public URI 配置 | [`spec/openapi.yml`](../spec/openapi.yml) | [`web-docs/sandbox-api-module.md`](./sandbox-api-module.md) 网络配置章节 |
| 部署入口 | [`iac/provider-gcp/nomad-cluster/network/main.tf`](../iac/provider-gcp/nomad-cluster/network/main.tf)、[`iac/provider-aws/alb.tf`](../iac/provider-aws/alb.tf) | [`web-docs/sandbox-traffic-routing.md`](./sandbox-traffic-routing.md) |

更细的 Host 语法、连接池和错误模板说明见 [`sandbox-traffic-routing.md`](./sandbox-traffic-routing.md)；auto-resume 状态机见 [`auto-resume-module.md`](./auto-resume-module.md)。本篇保留端到端视角，只记录会改变排障结论的实现细节。
