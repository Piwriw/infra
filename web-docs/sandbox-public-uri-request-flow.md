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

## 16. HTTP 透传契约

### 16.1 ReverseProxy 对请求的改变范围

**已实现：** 两层 proxy 都使用共享 `pool.ProxyClient`。该 client 的 `Rewrite` 回调先从 request context 取出 `Destination`，再调用 `r.SetURL(t.Url)`。因此 upstream 的 scheme 和 authority 来自 destination；请求的 method、URI path、query、body 以及未被显式覆盖的 header 仍由 Go `httputil.ReverseProxy` 负责复制。

**已实现：** 共享实现没有调用 `SetXForwarded()`。没有 `maskRequestHost` 时，代码显式设置 `r.Out.Host = r.In.Host`，所以用户服务看到的 `Host` 是原始 Public URI Host，而不是 orchestrator 节点地址。这个选择还避免标准库自动写入的 `X-Forwarded-*` 组合影响 `Content-Location`，源码注释把这一点列为兼容性原因。

**已实现：** 配置了 `MaskRequestHost` 时，upstream `Host` 被替换为 mask，原始值写入单一的 `X-Forwarded-Host`：

```text
client request Host       = 3000-i7fa3.sandbox.example.com
upstream request Host     = api.internal.example.com:3000
upstream X-Forwarded-Host = 3000-i7fa3.sandbox.example.com
```

上面的两个 Host 只表示字段位置；真实 sandbox ID 和 mask 由请求与配置决定。不要把 `X-Forwarded-Host` 当作可验证的身份凭据，应用若要信任它，必须只信任来自已知 proxy 的连接。

**可推导：** 由于 `Destination.Url` 在 Client Proxy 阶段指向 `<orchestratorIP>:5007`，在 Orchestrator Proxy 阶段指向 `<slotHostIP>:<requestedPort>`，path 和 query 在两个阶段都不会被重新拼接。若用户服务收到错误 path，应先比较两层 access log 中的原始 URL，再检查服务自身的 router；不应先假设 catalog 把 path 丢失了。

### 16.2 Header、压缩和协议版本

**已实现：** transport 设置 `DisableCompression: true`，不会为了 upstream 协商而自动加入 `Accept-Encoding: gzip`，也不会在 proxy 层解压或重新压缩响应。用户服务主动返回的 `Content-Encoding` 仍属于业务响应的一部分，proxy 不会把它改写成固定编码。

**已实现：** transport 设置 `ForceAttemptHTTP2: false`。Client Proxy 到 Orchestrator Proxy 的普通连接因此按 HTTP/1.1 建立；Orchestrator Proxy 到 VM 也沿用同一 transport。入口 server 通过 `httpserver.ConfigureH2C` 开启 h2c 能力，实际是否使用 h2c 由入口负载均衡器和后端配置决定，而不是由 Public URI 的端口号决定。

**已实现：** GCP 网络模块为 `session` backend 同时创建可选 H2C backend，`protocol = "H2C"` 且 `compression_mode = "DISABLED"`。同一个配置文件明确提醒：WebSocket upgrade 路径应继续留在 HTTP/1.1 backend，除非另行拆分 backend。因此，看到普通 HTTP/2 成功不能推断 WebSocket 在所有部署中都会成功。

**可推导：** 对长响应、SSE 或 WebSocket，连接 limiter 的释放点仍是 proxy handler 返回之后，而不是收到 response headers 的时刻。入口 LB、客户端和用户服务任何一层提前关闭连接，才会让 handler 提前返回；只要 body 还在读取，整个 slot 仍计入并发数。

### 16.3 业务响应和代理错误的边界

**已实现：** `ModifyResponse` 只记录状态码，不替换业务 body。用户服务返回的 `2xx/3xx/4xx/5xx` 会沿反向链路返回，状态码和应用 header 由 `ReverseProxy` 继续处理。只有 transport 无法建立或写入 upstream 时才进入 `ErrorHandler`。

**已实现：** 代理生成的恢复、限流和端口错误使用统一模板。模板根据 User-Agent 是否匹配 `mozilla|chrome|safari|firefox|edge|opera|msie` 选择 HTML 或 JSON：

| 触发类型 | 状态码 | 非浏览器 Content-Type | 浏览器 Content-Type |
|---|---:|---|---|
| 恢复权限拒绝 | 403 | `application/json; charset=utf-8` | `text/html; charset=utf-8` |
| 仍在过渡 | 409 | `application/json; charset=utf-8` | `text/html; charset=utf-8` |
| 团队/连接资源耗尽 | 429 | `application/json; charset=utf-8` | `text/html; charset=utf-8` |
| Sandbox 不存在或端口关闭 | 502 | `application/json; charset=utf-8` | `text/html; charset=utf-8` |

对应测试在 [`packages/shared/pkg/proxy/proxy_test.go`](../packages/shared/pkg/proxy/proxy_test.go) 中分别用普通 client 和 Mozilla User-Agent 验证了 status code、Content-Type 和 JSON 字段。排障脚本使用 `curl` 时通常得到 JSON；浏览器直接打开同一 URL 则可能看到内嵌 HTML 页面。

**已实现：** Host、ID、端口和 routing header 的解析错误不走模板，而由 `handler.go` 用 `http.Error` 返回纯文本 `400`。如果看到 JSON 错误体，说明请求至少已经通过了 Host parser；如果看到 `Invalid host`，Redis、auto-resume 和 VM 尚未被访问。

### 16.4 请求体重试的风险

**已实现：** Client Proxy 的 pool 只设置 `ClientProxyRetries = 1`，Orchestrator Proxy 设置 `SandboxProxyRetries = 5`。重试发生在 transport 的 TCP dial，而不是在 HTTP handler 中重复发送已经写出的 application request。每次 dial 都接收原 request context，因此客户端取消会停止后续尝试。

**可推导：** 对带不可重放 body 的 `POST`，proxy 不会因为端口重试而在应用层复制一次 POST；但如果客户端自身重试整个 HTTP 请求，用户服务仍可能收到多次业务操作。需要幂等性的 API 应使用业务 idempotency key，不能依赖 Public URI proxy 的 dial retry。

**建议方案：** 若未来增加 HTTP 层重试，应限定为明确可重放的 `GET/HEAD/OPTIONS`，或者要求调用方提供显式幂等键，并在文档和 metrics 中区分“dial retry”和“request retry”。当前仓库没有通用的 request-level retry middleware。

## 17. 生命周期级连接池和并发控制

### 17.1 两种 connection key

**已实现：** Client Proxy 的 destination 使用常量 `client-proxy` 作为 `ConnectionKey`。它只连接各节点的 `IP:5007`，不需要为每个 Sandbox 创建独立 keep-alive pool；同一个节点的 upstream 连接可以被多个 Sandbox 请求共享，因为节点侧会再次按 Sandbox ID 路由。

**已实现：** Orchestrator Proxy 的 destination 使用 `sbx.LifecycleID`，而不是 Sandbox ID 或 slot IP。注释明确指出：同一 network slot 的 IP:port 可能在 pause/resume 后被重新分配；LifecycleID 能防止旧生命周期的连接被新生命周期复用。

**可推导：** `ExecutionID` 在 pause/resume 过程中可保持稳定，LifecycleID 每次运行实例独立。故排查连接复用时应同时记录：

| 标识 | 用途 | 是否跨 resume 稳定 |
|---|---|---:|
| Sandbox ID | Public URI 和 API 资源 | 是 |
| Execution ID | catalog 删除守卫、API/分析身份 | 通常是 |
| Lifecycle ID | 节点内 map、连接池、limiter | 否，每次生命周期新建 |
| slot IP | VM 网络寻址 | 可能复用 |

把 Sandbox ID 当作 pool key 会让旧 cleanup 线程有机会关闭新生命周期的连接；这也是源码不采用 Sandbox ID 的原因。

### 17.2 pool 容量与关闭顺序

**已实现：** 共享 pool 的总 idle client 上限是 `16384`。每个 `ProxyClient` 的 `MaxIdleConnsPerHost` 为总上限除以 `hostConnectionSplit=4`（总上限不超过 4 时不再除），目的是避免一个 host 吃完所有本地可用端口。这个值是 transport 上限，不代表每个 Sandbox 可以同时建立 16384 个业务连接。

**已实现：** `ProxyPool.Close(connectionKey)` 先从 map 删除 proxy，再关闭 idle connections，并调用 active connection 的 `Reset()`。Orchestrator server 在 sandbox lifecycle goroutine 完成 `sbx.Close` 后按 LifecycleID 调用 `RemoveFromPool`；模板构建阶段也有同样的 defer 清理。清理失败会记 warning，不能把它解释为 Sandbox 仍然在 catalog 中。

**可推导：** lifecycle cleanup 与一个正在进行的 response 可能并发。关闭 active connection 会让客户端看到连接错误或截断 body；这是停止 Sandbox 时的预期结果。若业务需要完整下载，应在 Sandbox 停止前等待 response 完成，而不是依赖 pool 的 graceful idle timeout。

### 17.3 limiter 的原子语义

**已实现：** `ConnectionLimiter.TryAcquire` 为每个 key 保存 `atomic.Int64`，使用 CAS 循环递增。`maxLimit < 0` 表示不限制，`maxLimit == 0` 直接拒绝全部请求；非负上限下只有 `current < maxLimit` 时才允许递增。`Release` 也用 CAS 递减，计数不会下降到负数。

**已实现：** handler 在 destination 解析成功后、调用 pool `ServeHTTP` 前获取 slot；获取失败立即渲染 429，不建立 downstream 连接。获取成功后用 defer 释放，因此包含代理错误、客户端取消和正常业务响应。Orchestrator 的 `GetMaxLimit` 从 feature flag `SandboxMaxIncomingConnections` 读取，不应把默认值写成永远固定的行为；当前默认 flag 值在指标说明中为 `-1`。

**已实现：** Sandbox map 的 `OnNetworkRelease` 调用 `limiter.Remove(LifecycleID)`，避免生命周期结束后空 counter 永久留在 map。旧 response 的 defer 可能在 Remove 后执行，此时 `Release` 对已删除 key 是 no-op；它不会影响新生命周期的同名计数，因为新生命周期使用新的 key。

**可推导：** slot 的占用单位是 HTTP handler 生命周期，不是 TCP accept 数。一个 keep-alive TCP 连接上的连续请求会分别进入 handler、分别获取和释放 slot；一个流式 response 则会长时间占用一个 slot。应使用 `IngressProxyConnectionDurationHistogramName` 观察长连接，而不是只看当前 server connection 数。

### 17.4 并发排障矩阵

| 现象 | 首要信号 | 可能边界 | 操作 |
|---|---|---|---|
| 立即 429 | `connectionsBlocked` 增加 | feature flag 上限、同一 Lifecycle 长连接 | 查看 limiter count 和 duration histogram |
| 连接数持续增长 | pool/server observable gauge 增加 | 客户端未读 body、SSE、WebSocket | 对比 response duration 与 LB idle timeout |
| resume 后偶发旧响应 | 同一 slot IP、不同 LifecycleID | pool 未及时关闭或旧请求仍存活 | 检查 lifecycle cleanup 和 `RemoveFromPool` warning |
| 新 Sandbox 继承旧限流计数 | key 不是 LifecycleID 或 cleanup 缺失 | 自定义调用方误用 Sandbox ID | 检查 destination.ConnectionKey 和 `OnNetworkRelease` |

**建议方案：** 若未来需要跨多台 orchestrator 的全局连接上限，应在边缘层引入有租约的分布式计数器；当前 limiter 只存在于单个 orchestrator 进程内，不能提供跨节点总量保证。

## 18. Auto-resume gRPC 与 OAuth 精确协议

### 18.1 proto 只承载 Sandbox ID

**已实现：** [`packages/shared/pkg/grpc/proxy/proxy.proto`](../packages/shared/pkg/grpc/proxy/proxy.proto) 的 `SandboxResumeRequest` 只有 `sandbox_id` 字段，`timeout_seconds` 仍是 reserved。响应只有 `orchestrator_ip`。请求端口、业务 traffic token 和 secure envd token 不进入 proto message，而由 Client Proxy 追加到 gRPC metadata。

```text
ResumeSandbox request message:
  sandbox_id = i7fa3

metadata:
  e2b-sandbox-request-port: 3000
  e2b-traffic-access-token: <optional>
  e2b-envd-access-token: <optional>
  authorization: Bearer <optional edge OAuth token>
```

**可推导：** gRPC 调用没有 path、query 或 body，因此 auto-resume 成功后，原始 HTTP 请求仍由 Client Proxy 重新发送到 `<orchestratorIP>:5007`。API 不会缓存或重放用户 body；这把生命周期操作与业务请求数据边界分开。

### 18.2 地址选择和 TLS

**已实现：** Client Proxy 启动时优先使用 `API_INTERNAL_GRPC_ADDRESS`。只有该值为空，才回退到 `API_EDGE_GRPC_ADDRESS`，并将 `useTLS` 设为 true，同时加载 edge OAuth 配置。两个值都为空时，paused sandbox resumer 不创建，日志标明 paused checks disabled；运行中 catalog 路由不受此开关影响。

**已实现：** internal gRPC server 注册 `NewSandboxService(apiStore, false, nil)`，通常由 Nomad Consul 地址 `api-internal-grpc.service.consul:<port>` 访问；edge gRPC server 注册 `NewSandboxService(apiStore, true, verifier)`。edge client 使用 TLS 最低版本 1.2，internal client 使用 insecure credentials，不能因为两者都使用 gRPC 就把证书要求混为一谈。

**已实现：** 环境配置模型的 proxy/health 默认端口是 `3002/3003`，但 gRPC 地址和端口来自环境/IaC，不能从 Public URI 的业务 port 推导。GCP 和 AWS 的 provider 都向 client-proxy job 注入 `API_INTERNAL_GRPC_ADDRESS`；部署覆盖可以通过 `client_proxy_env_vars` 改变该值。

### 18.3 OAuth token 生命周期

**已实现：** OAuth 配置只要 Client ID、Client Secret 或 Token URL 任一非空，就被视为启用；启用时三项必须全部非空，否则初始化直接报错。`clientcredentials.Config` 请求 scope 固定为 `sandboxes:lifecycle`，拿到 token 后以 `Authorization: Bearer <access_token>` metadata 发送给 edge gRPC。

**已实现：** Token 获取发生在每次 `Resume` 的 `authorize` 阶段，失败立即返回，不会调用 `ResumeSandbox` RPC。oauth2 `TokenSource` 负责缓存和刷新 token；本仓库没有在 HTTP 请求层另存 token，也不会把 token 写入 Redis catalog。

**已实现：** API edge handler 在 `requireEdgeClientProxyAuth` 为 true 时依次要求 bearer token、OIDC claims、`sandboxes:lifecycle` scope。若目标 team 绑定 cluster，还会从 cluster 的 `AuthOrgID` 与 token `org_id` 做 constant-time 比较。验证失败统一返回 gRPC `PermissionDenied`，Client Proxy 再映射成恢复权限错误页面。

**可推导：** 一个有效 OAuth token 只证明 Client Proxy 有权请求生命周期操作，不等于业务 traffic token，也不等于 secure envd token。三者在 metadata key、生成方和校验路径上互相独立：

| 凭证 | 作用域 | 校验位置 | 是否写入 URL |
|---|---|---|---:|
| edge OAuth bearer | Client Proxy -> API edge gRPC | API OAuth verifier | 否 |
| traffic access token | private 业务端口 | API resume + Orchestrator Proxy | 否，HTTP header/metadata |
| envd access token | secure `49983` | API resume + envd | 否，HTTP `X-Access-Token`/metadata |

**建议方案：** 生产环境应把三项 OAuth 配置作为同一 secret 的原子发布单元，并在滚动更新时先验证 token endpoint 可达；当前启动检查只验证配置是否完整，不会预取 token 或执行端到端授权探针。

### 18.4 API 前置检查与错误转换

**已实现：** API `ResumeSandbox` 的顺序是：鉴权、短 ID 规范化、snapshot/auto-resume policy、filesystem-only 检查、team/cluster 校验、已有 Sandbox 状态处理、envd token 生成、private ingress token 校验、启动 Sandbox、读取 node route。任何一步失败都会在调用 `startSandboxInternal` 前返回；因此错误不应被解释为“VM 已经启动但 HTTP 请求失败”。

**已实现：** metadata 中缺少 `e2b-sandbox-request-port` 时，API 按 non-envd traffic 处理；端口值无法解析时记录 warning，也按 non-envd traffic 处理。这意味着自定义 gRPC 调用方若省略或拼错端口 metadata，可能意外走业务 token 分支，而不是 secure envd 分支。

**已实现：** `startSandboxInternal` 返回的 HTTP API error 通过 `GRPCCodeFromHTTPStatus` 转换为 gRPC code；Client Proxy 根据 `PermissionDenied`、`FailedPrecondition`、`ResourceExhausted` 和其他 code 映射到 403、409、429 或 generic not-found/route error。要定位根因，应同时记录原始 gRPC status message 和最终 HTTP status。

## 19. Redis catalog 一致性与竞态

### 19.1 记录格式和 TTL

**已实现：** Redis key 固定为 `sandbox:catalog:<sandboxID>`，value 是 JSON `SandboxInfo`：

```json
{
  "orchestrator_id": "node-service-instance",
  "orchestrator_ip": "10.0.1.25",
  "execution_id": "execution-uuid",
  "sandbox_started_at": "2026-08-19T08:00:00Z",
  "sandbox_max_length_in_hours": 1
}
```

字段名以 `SandboxInfo` 的 JSON tags 为准；示例值仅用于说明边界，不是固定部署值。API 生命周期代码只为本地节点写入 catalog；远程 cluster node 走 gRPC metadata routing registration，不在本地 Redis routing table 注册。

**已实现：** Store 的 expiration 由 `MaxLengthInHours` 推导：sandbox 的最大生命周期除以一小时后转换为整数，再以该小时数构造 TTL。TTL 是生命周期上限的缓存边界，不是“请求后延长”的 sliding TTL。若部署允许非整小时的最大生命周期，应注意整数转换后的精度损失，并以实际 feature/config 为准。

**已实现：** Get、Store、Delete 都在各自 Redis 操作外包一秒 context timeout，并创建对应 OpenTelemetry span：`sandbox-catalog-get`、`sandbox-catalog-store`、`sandbox-catalog-delete`。Redis timeout 或 JSON decode error 不等价于 key miss；只有 `redis.Nil` 被转换为 `ErrSandboxNotFound`。

### 19.2 catalog miss 的唯一恢复入口

**已实现：** Client Proxy 的 `catalogResolution` 只在 `GetSandbox` 返回 `ErrSandboxNotFound` 时调用 paused resumer。Redis 连接失败、超时、空 JSON 或 unmarshal 失败会直接走 route error，不会尝试恢复。这样可以避免 Redis 故障期间对同一 Sandbox 产生大量无依据的 resume 请求。

**已实现：** resumer 返回的 `orchestrator_ip` 会经过 `strings.TrimSpace` 和 `normalizeNodeIP`；空字符串转换为 `ErrNodeRouteUnavailable`。Client Proxy 会记录 route unavailable，并最终把它包装成 Sandbox not found/502 页面。一个 catalog 命中但 IP 为空的记录仍然是不可路由状态，不能当成成功命中。

**可推导：** catalog miss 与 snapshot miss 的外部表现可能相同（502 或 not-found 页面），但内部路径不同：前者可能调用 API，后者会在 API 返回 NotFound 后停止。排查时应先看 `sandbox-catalog-get` span 和 `catalog miss, attempting resume via api` 日志，再判断是否需要检查 snapshot。

### 19.3 写入、删除和旧生命周期保护

**已实现：** `addSandboxToRoutingTable` 由 API 生命周期调用，写入当前 node 的 service instance ID、路由 IP、ExecutionID、启动时间和最大长度。`removeSandboxFromNode` 在本地 node 上删除记录；远程 node 分支跳过 Redis 删除，因为它的路由注册由远端 gRPC metadata 管理。

**已实现：** `DeleteSandbox` 删除前重新读取 value，并比较 `info.ExecutionID` 与待删除的 execution ID。若 catalog 已经被新生命周期覆盖，旧生命周期的删除请求直接返回，不会删除新路由。这个 compare 是防止 pause/resume 迟到 cleanup 破坏新路由的关键守卫。

**可推导：** Delete 的实现对 Redis `Get` 的任意错误都返回 nil（注释说明不存在时可提前返回），而不是把 Redis error 传播给调用方；因此删除日志成功不一定证明 key 已经删除。若需要严格一致性，应结合 Redis key 查询和后续 Get span 验证，而不是只看 API delete 请求的 HTTP status。

**可推导：** Store 和 Delete 不是同一个 Redis transaction。写入新 execution、旧 execution 删除、节点网络释放之间可能交错；ExecutionID compare 只保护删除，不提供跨操作的全局线性化。Client Proxy 必须把 catalog 当作短期路由缓存，不能把它当作 Sandbox 状态的唯一事实源。

### 19.4 并发恢复的行为

**已实现：** 两个边缘请求同时看到 miss 时，两个请求都可能进入 `ResumeSandbox`。API 在启动新实例前查询 orchestrator 状态，并调用 `HandleExistingSandboxAutoResume`；若发现已有实例或过渡状态，会返回已有 node route、`FailedPrecondition`（still transitioning）或其他明确错误。仓库没有在 Client Proxy 内实现 per-Sandbox singleflight。

**可推导：** 一个请求可能在 API 已启动 Sandbox 但 catalog 尚未写回的窗口内再次看到 miss。此时第二次请求可能等待已有状态，也可能得到 409；客户端应使用有上限的退避，不能把所有 409 当成可无限重试。恢复成功返回 node IP 后，当前请求才会重新进入 Client Proxy pool。

**建议方案：** 若需要降低同一 Sandbox 的重复 resume，应在 API 层以 Sandbox ID 建立短时 singleflight/lease，并将 lease 状态与现有生命周期状态机绑定。单独在 Redis 加锁而不处理 API 进程崩溃、lease 过期和旧 ExecutionID，可能引入更难排查的死锁；当前仓库尚未实现这一方案。

## 20. 配置、部署和操作手册

### 20.1 Client Proxy 进程和 Nomad

**已实现：** client-proxy 配置默认 `PROXY_PORT=3002`、`HEALTH_PORT=3003`，但环境变量可覆盖。Nomad job 将两个端口声明为 host network static port，并把 `HEALTH_PORT`、`PROXY_PORT` 传给容器。健康 handler 在 healthy 状态返回 `200 healthy`，否则返回 `503 unhealthy`。

**已实现：** Nomad service check 访问 health port 的 `/health`，间隔和 timeout 都是 job 配置项；Traefik service router 使用 `PathPrefix(`/`)` 的低优先级 fallback，承接动态 Sandbox 子域名。该 fallback 只决定请求送到 Client Proxy，不解析 Sandbox ID，也不替代 Client Proxy 的 Host parser。

**已实现：** job restart policy 在十分钟内最多尝试两次，reschedule 使用指数退避并允许无限次重新放置；启用 update stanza 时采用 canary 和健康 deadline。看到所有 Sandbox 同时 502 时，应先检查 Nomad allocation、`/health` 和 restart/reschedule 事件，再检查 Redis。

**可推导：** Client Proxy 自身没有业务连接 limiter；它的 pool/server observable metrics 只能说明入口连接和到节点的连接数量，不能说明某个 Sandbox 的并发数。Sandbox 级 429 只在 Orchestrator Proxy 的 limiter 产生。

### 20.2 GCP 入口边界

**已实现：** GCP URL map 将 `*.${domain_name}` 和额外域名的 wildcard host 送到 `session-paths`，其 default backend 是可配置的 client-proxy session port；`api.*`、`docker.*` 和 `nomad.*` 有各自 host rule。session backend timeout 从 IaC 配置读取，当前定义为 86400 秒，health check path/port 同样由 `client_proxy_health_port` 变量提供。

**已实现：** GCP TLS policy 的最低版本是 TLS 1.2；certificate map 同时覆盖顶层域名和 wildcard 子域名。Cloudflare `A` wildcard record 指向 global forwarding rule 的 IP，不是指向单个 Sandbox 或 orchestrator 节点。

**已实现：** session、api、docker-reverse-proxy backend 的 compression 被禁用；H2C backend 是单独资源，且由 `h2c_backends` 集合决定。WebSocket 是否使用 HTTP/1.1 backend 取决于部署路由，不能只看 client-proxy 是否开启 h2c。

**排障顺序：**

1. 用 `dig` 检查 wildcard A 记录和实际 global forwarding IP。
2. 用 `openssl s_client -servername <full-host>` 检查证书和 TLS 最低版本。
3. 检查 URL map 的 host rule 是否落在 session backend，而不是 `api.*` 或 `nomad.*`。
4. 检查 session health check 是否命中 `3003`（或覆盖后的 health port）和正确 path。
5. 最后才在 Client Proxy 查 Host parser 和 Redis catalog。

### 20.3 AWS ALB 和 gRPC 分流

**已实现：** AWS HTTPS listener 的默认 action 转发到 HTTP/1 target group；`content-type: application/grpc*` 的优先级规则转发到独立的 GRPC target group。两个 target group 都指向可配置的 ingress port，但业务 target group 使用 `protocol_version = "HTTP1"`，gRPC target group 使用 `protocol_version = "GRPC"`。

**已实现：** AWS HTTP target group 健康检查为 `/ping`、matcher `200`；GRPC target group 也请求 `/ping`，但 matcher 是 gRPC status `0`。因此在 AWS 上用浏览器访问 `/ping` 验证 gRPC 健康并不等价于一次完整 Resume RPC；它只验证 target group 的 health contract。

**已实现：** ALB 的 host default route 不做 Sandbox ID 解析；wildcard certificate 只负责 TLS。若自定义域名直接落到 default target group，Client Proxy 仍会看到自定义 Host，并按标准 `<port>-<sandboxID>.<domain>` 规则解析失败。域名 alias 必须在 edge rewrite/redirect 或平台映射层实现。

### 20.4 错误到操作动作的映射

| 外部结果 | 已知原因 | 先查什么 | 不要做什么 |
|---|---|---|---|
| 400 | Host/header/ID/port 语法 | `host.go` 日志、请求 Host | 不要重试 Redis 或 resume |
| 403 | traffic/envd/OAuth/组织权限 | token header、gRPC status、scope/org | 不要把 OAuth token 当 traffic token |
| 409 | 已有生命周期仍在过渡 | API existing-sandbox 日志和 transition budget | 不要并发启动第二个 Sandbox |
| 429 | team quota 或 ingress connection limit | API resource error、proxy blocked metric | 不要无界指数重试 |
| 502 | catalog/route/VM dial 失败 | catalog span、node IP、端口监听 | 不要直接判定 VM 崩溃 |
| 500 | 代理内部模板/未知错误 | Client/Orchestrator error log | 不要把业务 5xx 与代理 500 混淆 |

**已实现：** 代理自身的 `DefaultToPortError` 只在 Orchestrator Proxy destination 设置为 true；因此节点侧 dial 失败通常渲染“Sandbox running but no service on port”页面，而 Client Proxy 到 `:5007` 的失败走 generic route failure。这个差异可帮助区分“节点不可达”和“VM 端口未监听”。

### 20.5 最小测试和未覆盖风险

**已实现：** 当前测试可以覆盖以下最小矩阵：

| 测试 | 证据 |
|---|---|
| Host/header 解析和非法输入 | [`packages/shared/pkg/proxy/host_test.go`](../packages/shared/pkg/proxy/host_test.go) |
| HTML/JSON 错误模板和 status | [`packages/shared/pkg/proxy/proxy_test.go`](../packages/shared/pkg/proxy/proxy_test.go) |
| Host mask 与 X-Forwarded-Host | [`packages/shared/pkg/proxy/proxy_test.go`](../packages/shared/pkg/proxy/proxy_test.go) |
| connection limiter 的阻断/释放 | [`packages/shared/pkg/proxy/proxy_test.go`](../packages/shared/pkg/proxy/proxy_test.go)、[`packages/shared/pkg/connlimit/limiter_test.go`](../packages/shared/pkg/connlimit/limiter_test.go) |
| Client Proxy mask 和 catalog/resume 分支 | [`packages/client-proxy/internal/proxy/proxy_test.go`](../packages/client-proxy/internal/proxy/proxy_test.go) |
| gRPC OAuth 配置、metadata 和错误 | [`packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc_test.go`](../packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc_test.go)、[`packages/client-proxy/internal/proxy/grpc_resume_auth_test.go`](../packages/client-proxy/internal/proxy/grpc_resume_auth_test.go) |
| API resume 的 token、policy 和状态 | [`packages/api/internal/handlers/proxy_grpc_test.go`](../packages/api/internal/handlers/proxy_grpc_test.go) |

**未覆盖风险：** 当前仓库没有一个同时启动真实 LB、Client Proxy、Redis、API gRPC、Orchestrator Proxy、envd 和 Firecracker 的端到端 Public URI 测试。尤其需要人工验证：

- GCP H2C 与 WebSocket upgrade 在具体 URL map 版本中的组合；
- AWS ALB gRPC health matcher 与实际 edge gRPC TLS/证书链；
- Redis timeout、catalog 写入延迟和 API 启动窗口的并发行为；
- slot IP 复用时旧 keep-alive/streaming response 的关闭可见性；
- 自定义域名 rewrite 是否保留原始 Host、SNI、`X-Forwarded-Host` 和 private token 的可信边界。

**建议方案：** 将这些风险纳入部署 smoke test，至少记录 request ID、Sandbox ID、port、ExecutionID、LifecycleID、catalog key、orchestrator IP、gRPC status 和最终 HTTP status。测试应使用短生命周期、可重复的 sandbox fixture，结束时显式等待 catalog 删除和 pool cleanup，避免把前一次测试的 slot 或 Redis key 当成当前结果。

### 20.6 文档边界和配置变更规则

**已实现：** 本文只描述源码和当前 IaC 能证明的行为；端口、域名、最大生命周期、feature flag、LB timeout、health path、OAuth issuer 和是否启用 edge auth 都是配置驱动。部署升级时应重新检查对应变量和环境注入，而不是把示例中的 `3000`、`3002`、`3003`、`5007` 或 `49983` 当作所有环境的常量。

**建议方案：** 新增 ingress 行为时同时更新三处：OpenAPI 的网络配置说明、本文的端到端边界、以及对应的单元/集成测试。若引入 DNS alias、private ingress gateway、全局 connection limiter 或 HTTP request retry，还应先定义数据存储、token 生命周期和旧生命周期清理语义，再添加实现；单独增加一条路由规则无法解决这些跨服务一致性问题。
