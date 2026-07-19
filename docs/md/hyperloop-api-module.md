# E2B Hyperloop API 模块详解

> 范围:本文描述 Orchestrator 节点上的 Hyperloop HTTP 服务,包括 sandbox 到 host 的网络路径、`GET /me`、`POST /logs`、基于源 IP 的身份识别、日志 payload 防伪和 collector 转发。这里的 Hyperloop 是 sandbox 内部控制/事件通道,不是 Edge API,也不是 Firecracker API。

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
)
```

服务作为 Orchestrator 的一个受管组件启动,shutdown 时调用 `http.Server.Shutdown`。

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

```text
1. RemoteAddr → sandbox.Map.GetByHostPort
2. JSON body → map[string]any
3. payload.instanceID 必须等于来源 sandbox ID
4. 覆盖 instanceID/envID/teamID
5. 重新 JSON marshal
6. POST 到 LOGS_COLLECTOR_ADDRESS
7. collector 请求成功建立并收到响应 → 返回 200
```

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

---

## 九、Collector 转发

### 9.1 目标地址

目标来自环境变量:

```text
LOGS_COLLECTOR_ADDRESS
```

`NewHyperloopStore` 在启动时保存地址,并创建一个 timeout 为 10 秒的 `http.Client`。

### 9.2 转发请求

```go
request, err := http.NewRequestWithContext(
    c,
    http.MethodPost,
    h.collectorAddr,
    bytes.NewBuffer(logs),
)
request.Header.Set("Content-Type", "application/json")
response, err := h.collectorClient.Do(request)
```

原请求 headers 不会透传。转发只保留重写后的 JSON body 和 `Content-Type`。

### 9.3 下游 status 行为

当前 handler 只检查 `Do` 是否返回 transport error,**不检查 collector 的 HTTP status code**。只要收到了 HTTP response,就关闭 body 并向 guest 返回 200。

因此:

| Collector 结果 | Hyperloop 响应 |
|---|---|
| 2xx | 200 |
| 4xx/5xx,但正常收到 response | 200 |
| DNS/connect/timeout/transport error | 500 |

排查日志丢失时不能仅凭 guest 收到 200 判断 collector 已接受数据。

### 9.4 Response body

Collector response body 不读取、不转发,只在 defer 中关闭。

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
| payload JSON marshal 失败 | 500 | `Error when parsing logs payload` |
| collector request 构造失败 | 500 | `Error when creating request to forwarding sandbox logs` |
| collector transport/timeout | 500 | `Error when forwarding sandbox logs` |

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
guest        Hyperloop             sandbox.Map          logs collector
  │ POST /logs  │                       │                     │
  ├────────────►│ source IP lookup      │                     │
  │             ├──────────────────────►│                     │
  │             │◄──── Sandbox metadata ┤                     │
  │             │ validate instanceID                         │
  │             │ overwrite instanceID/envID/teamID           │
  │             │ POST sanitized JSON                         │
  │             ├─────────────────────────────────────────────►│
  │             │◄──────────── HTTP response ──────────────────┤
  │◄──── 200 ───┤                                             │
```

---

## 十四、配置与限制

| 配置/常量 | 默认/值 | 作用 |
|---|---|---|
| `SANDBOX_ORCHESTRATOR_IP` | `192.0.2.1` | Guest 看到的 host 地址 |
| `SANDBOX_HYPERLOOP_PROXY_PORT` | `5010` | Host Hyperloop listen/redirect port |
| `LOGS_COLLECTOR_ADDRESS` | 环境变量,无代码默认值 | `/logs` 转发目标 |
| `CollectorExporterTimeout` | 10 秒 | Collector HTTP client timeout |
| `maxUploadLimit` | 256 MiB | Hyperloop request body 上限 |
| Listen address | `0.0.0.0:<port>` | Host 所有接口 |
| Guest target port | 80 | iptables 匹配入口 |

`LOGS_COLLECTOR_ADDRESS` 为空或格式非法时,`POST /logs` 会在创建/发送下游请求阶段失败。

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

Hyperloop 不检查 collector HTTP status。检查 collector 自身的 access/error log、返回码和 ingestion 状态;不要只看 guest response。

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
| [`spec/openapi-hyperloop.yml`](../../spec/openapi-hyperloop.yml) | `/me`、`/logs` 契约 |
| [`packages/orchestrator/pkg/hyperloopserver/contracts/cfg.yaml`](../../packages/orchestrator/pkg/hyperloopserver/contracts/cfg.yaml) | Gin server/model/spec 生成配置 |
| [`packages/orchestrator/pkg/hyperloopserver/server.go`](../../packages/orchestrator/pkg/hyperloopserver/server.go) | HTTP server、中间件、H2C、路由注册 |
| [`packages/orchestrator/pkg/hyperloopserver/handlers/store.go`](../../packages/orchestrator/pkg/hyperloopserver/handlers/store.go) | APIStore、collector client、10 秒 timeout |
| [`packages/orchestrator/pkg/hyperloopserver/handlers/me.go`](../../packages/orchestrator/pkg/hyperloopserver/handlers/me.go) | 源 IP → sandbox ID |
| [`packages/orchestrator/pkg/hyperloopserver/handlers/logs.go`](../../packages/orchestrator/pkg/hyperloopserver/handlers/logs.go) | JSON 校验、metadata 覆盖、collector 转发 |
| [`packages/orchestrator/pkg/sandbox/map.go`](../../packages/orchestrator/pkg/sandbox/map.go) | network index 与 `GetByHostPort` |
| [`packages/orchestrator/pkg/sandbox/network/network.go`](../../packages/orchestrator/pkg/sandbox/network/network.go) | port 80 → Hyperloop port REDIRECT |
| [`packages/orchestrator/pkg/sandbox/network/pool.go`](../../packages/orchestrator/pkg/sandbox/network/pool.go) | IP/port 默认配置 |
| [`packages/orchestrator/pkg/sandbox/envd.go`](../../packages/orchestrator/pkg/sandbox/envd.go) | `/init` 注入 `HyperloopIP` |
| [`packages/envd/internal/api/init.go`](../../packages/envd/internal/api/init.go) | `/etc/hosts` 与 `E2B_EVENTS_ADDRESS` |
| [`packages/orchestrator/pkg/sandbox/fc/process.go`](../../packages/orchestrator/pkg/sandbox/fc/process.go) | MMDS logs collector address |
| [`packages/orchestrator/pkg/sandbox/fc/mmds.go`](../../packages/orchestrator/pkg/sandbox/fc/mmds.go) | MMDS JSON 字段兼容契约 |
| [`packages/orchestrator/pkg/factories/run.go`](../../packages/orchestrator/pkg/factories/run.go) | Hyperloop 启动与 shutdown 装配 |

---

## 附录 A:端点速查

| Method | Path | Body | 成功响应 |
|---|---|---|---|
| GET | `/me` | 无 | 200 `{"sandboxID":"..."}` |
| POST | `/logs` | JSON object,必须含匹配的 string `instanceID` | 200,无 body |

## 附录 B:关键不变量

1. Hyperloop 身份由 `RemoteAddr IP → network map` 决定。
2. Guest 目标始终是 orchestrator-in-sandbox IP 的 port 80,host port 由 REDIRECT 隐藏。
3. `/logs` 的 `instanceID` 必须匹配来源 sandbox。
4. `instanceID/envID/teamID` 必须在 host 侧覆盖后才能转发。
5. Collector transport 成功不等于 collector 业务接收成功。
6. Network slot 复用前必须清理旧 IP 映射。

