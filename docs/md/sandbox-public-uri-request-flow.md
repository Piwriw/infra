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

GCP 的 Host 规则和 session backend 见 [`iac/provider-gcp/nomad-cluster/network/main.tf`](../../iac/provider-gcp/nomad-cluster/network/main.tf)。AWS 的 ALB 和 Traefik 服务发现分别见 [`iac/provider-aws/alb.tf`](../../iac/provider-aws/alb.tf) 与 [`iac/modules/job-client-proxy/jobs/client-proxy.hcl`](../../iac/modules/job-client-proxy/jobs/client-proxy.hcl)。

### 3.2 Client Proxy 解析 Public URI

Client Proxy 使用共享的 `GetTargetFromRequest` 解析请求。常规 Public URI 走 Host 解析：

```text
3000-i7fa3.sandbox.example.com
└───────┬──────┘
        ├─ port      = 3000
        └─ sandboxID = i7fa3
```

解析器只读取最左侧 DNS label，并按 `-` 分割：第一段是端口，第二段是 Sandbox ID。Sandbox ID 随后还会经过格式校验。实现见 [`packages/shared/pkg/proxy/host.go`](../../packages/shared/pkg/proxy/host.go)。

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

- [`packages/api/internal/orchestrator/lifecycle.go`](../../packages/api/internal/orchestrator/lifecycle.go)：写入节点路由
- [`packages/shared/pkg/sandbox-catalog/catalog_redis.go`](../../packages/shared/pkg/sandbox-catalog/catalog_redis.go)：Redis 读写
- [`packages/client-proxy/internal/proxy/proxy.go`](../../packages/client-proxy/internal/proxy/proxy.go)：解析 catalog 结果

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

这里不是 Sandbox 的公网 IP。每个 Sandbox 使用独立 network namespace、veth、tap 和唯一 slot IP；节点内 NAT 再把流量送入对应的 Firecracker microVM。实现见 [`packages/orchestrator/pkg/proxy/proxy.go`](../../packages/orchestrator/pkg/proxy/proxy.go) 和 [`packages/orchestrator/pkg/sandbox/network/network.go`](../../packages/orchestrator/pkg/sandbox/network/network.go)。

### 3.5 VM 内端口到用户服务

用户服务监听 `0.0.0.0:<port>` 时，可以直接从 VM 网络接口接收流量。

如果服务只监听 `127.0.0.1`、`localhost` 或 `::1`，envd 每秒扫描一次 TCP LISTEN 端口，并启动 `socat`：

```text
169.254.0.21:<port> -> localhost:<port>
```

因此 localhost 服务也能通过 Public URI 到达，但首次发现端口可能有短暂延迟；Orchestrator Proxy 会对端口连接做有限重试。实现见 [`packages/envd/internal/port/scan.go`](../../packages/envd/internal/port/scan.go) 和 [`packages/envd/internal/port/forward.go`](../../packages/envd/internal/port/forward.go)。

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
| Public URI schema | [`spec/openapi.yml`](../../spec/openapi.yml) |
| GCP DNS、TLS、LB | [`iac/provider-gcp/nomad-cluster/network/main.tf`](../../iac/provider-gcp/nomad-cluster/network/main.tf) |
| AWS DNS、TLS、ALB | [`iac/provider-aws/domain.tf`](../../iac/provider-aws/domain.tf)、[`iac/provider-aws/alb.tf`](../../iac/provider-aws/alb.tf) |
| Host/header 解析 | [`packages/shared/pkg/proxy/host.go`](../../packages/shared/pkg/proxy/host.go) |
| Client Proxy 路由 | [`packages/client-proxy/internal/proxy/proxy.go`](../../packages/client-proxy/internal/proxy/proxy.go) |
| Redis catalog | [`packages/shared/pkg/sandbox-catalog/catalog_redis.go`](../../packages/shared/pkg/sandbox-catalog/catalog_redis.go) |
| Paused Sandbox 恢复 | [`packages/api/internal/handlers/proxy_grpc.go`](../../packages/api/internal/handlers/proxy_grpc.go) |
| Orchestrator Proxy | [`packages/orchestrator/pkg/proxy/proxy.go`](../../packages/orchestrator/pkg/proxy/proxy.go) |
| Sandbox 网络 | [`packages/orchestrator/pkg/sandbox/network/network.go`](../../packages/orchestrator/pkg/sandbox/network/network.go) |
| VM 内 localhost 转发 | [`packages/envd/internal/port/forward.go`](../../packages/envd/internal/port/forward.go) |
