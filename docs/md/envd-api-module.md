# E2B envd REST API 原理详解

> 范围:本文以 `packages/envd/internal/api/api.gen.go` 中生成的 `ServerInterface` 为骨架,解释 envd 的 12 个 REST 端点如何路由、鉴权和修改 guest 状态,以及它们在文件传输、初始化、指标采集和 pause/resume 中承担的职责。
>
> envd 还提供 Process 与 Filesystem Connect RPC;这些 RPC 不属于 `ServerInterface`,参见 [envd-module.md](./envd-module.md)。

## 目录

- [一、接口全景](#一接口全景)
- [二、从 OpenAPI 到 Handler](#二从-openapi-到-handler)
- [三、请求入口与鉴权](#三请求入口与鉴权)
- [四、POST /init](#四post-init)
- [五、GET /envs](#五get-envs)
- [六、GET /files](#六get-files)
- [七、POST /files](#七post-files)
- [八、POST /files/compose](#八post-filescompose)
- [九、GET /health 与 GET /metrics](#九get-health-与-get-metrics)
- [十、POST /freeze 与 POST /unfreeze](#十post-freeze-与-post-unfreeze)
- [十一、POST /collapse](#十一post-collapse)
- [十二、POST /fsfreeze 与 POST /fsthaw](#十二post-fsfreeze-与-post-fsthaw)
- [十三、pause/resume 完整时序](#十三pauseresume-完整时序)
- [十四、并发、取消与幂等边界](#十四并发取消与幂等边界)
- [十五、错误与响应约定](#十五错误与响应约定)
- [十六、常见问题与排查](#十六常见问题与排查)
- [十七、关键文件索引](#十七关键文件索引)
- [附录 A:端点速查](#附录-a端点速查)
- [附录 B:关键不变量](#附录-b关键不变量)

---

## 一、接口全景

### 1.1 `ServerInterface`

[`api.gen.go`](../../packages/envd/internal/api/api.gen.go) 由 OpenAPI 生成,当前服务端契约是:

```go
type ServerInterface interface {
	// (POST /collapse)
	PostCollapse(w http.ResponseWriter, r *http.Request)
	// (GET /envs)
	GetEnvs(w http.ResponseWriter, r *http.Request)
	// (GET /files)
	GetFiles(w http.ResponseWriter, r *http.Request, params GetFilesParams)
	// (POST /files)
	PostFiles(w http.ResponseWriter, r *http.Request, params PostFilesParams)
	// (POST /files/compose)
	PostFilesCompose(w http.ResponseWriter, r *http.Request)
	// (POST /freeze)
	PostFreeze(w http.ResponseWriter, r *http.Request)
	// (POST /fsfreeze)
	PostFsfreeze(w http.ResponseWriter, r *http.Request)
	// (POST /fsthaw)
	PostFsthaw(w http.ResponseWriter, r *http.Request)
	// (GET /health)
	GetHealth(w http.ResponseWriter, r *http.Request)
	// (POST /init)
	PostInit(w http.ResponseWriter, r *http.Request)
	// (GET /metrics)
	GetMetrics(w http.ResponseWriter, r *http.Request)
	// (POST /unfreeze)
	PostUnfreeze(w http.ResponseWriter, r *http.Request)
}
```

接口方法在生成文件中的排列按 operation 生成,不是业务调用顺序。理解 envd 时更适合按四组能力分类:

| 能力 | 端点 | 核心职责 |
|---|---|---|
| 生命周期初始化 | `POST /init`、`GET /envs` | 恢复 guest 内运行时配置,读取当前环境变量 |
| 文件数据面 | `GET /files`、`POST /files`、`POST /files/compose` | 下载、覆盖上传、原子发布拼接结果 |
| 状态与指标 | `GET /health`、`GET /metrics` | liveness 与 guest 资源采样 |
| pause 协作 | `POST /freeze`、`POST /unfreeze`、`POST /collapse`、`POST /fsfreeze`、`POST /fsthaw` | 冻结进程、整理 envd 堆、冻结 rootfs 及失败回滚 |

### 1.2 架构位置

```text
SDK / API / Orchestrator
          │
          │ HTTP, guest slot IP:49983
          ▼
Firecracker guest
  envd http.Server
    │
    ├─ CORS
    ├─ access-token authorization
    ├─ Connect authn username middleware
    └─ chi.Router
         ├─ OpenAPI REST ServerInterface
         ├─ Process Connect RPC
         └─ Filesystem Connect RPC
```

REST 与 Connect RPC 共享同一个 `chi.Router`、监听地址和端口。`ServerInterface` 只描述 REST 路由,不代表 envd 的全部对外能力。

### 1.3 两类调用者

| 调用者 | 主要端点 | 特征 |
|---|---|---|
| SDK/文件客户端 | `/files`、`/files/compose`、`/envs` | 面向 sandbox 内文件与用户上下文 |
| Orchestrator | `/init`、`/metrics`、五个 pause 端点 | 面向 VM 生命周期,使用 slot IP 直连 envd |

`/health` 可由探针直接访问。pause 端点不是通用用户控制面;`/unfreeze` 与 `/fsthaw` 尤其只属于失败回滚路径。

---

## 二、从 OpenAPI 到 Handler

### 2.1 单一契约源

REST 契约源是 [`packages/envd/spec/envd.yaml`](../../packages/envd/spec/envd.yaml)。生成配置 [`internal/api/cfg.yaml`](../../packages/envd/internal/api/cfg.yaml) 启用 models 与 chi server,生成入口是 [`generate.go`](../../packages/envd/internal/api/generate.go)。

```text
spec/envd.yaml
    │ oapi-codegen
    ▼
internal/api/api.gen.go
    ├─ 请求/响应模型
    ├─ GetFilesParams / PostFilesParams
    ├─ ServerInterface
    ├─ ServerInterfaceWrapper
    └─ HandlerFromMux / chi 路由注册
```

`api.gen.go` 是生成产物。端点、参数或 schema 变化应先修改 `spec/envd.yaml`,再运行生成流程;业务原理实现在同目录的手写 `.go` 文件中。

### 2.2 生成 wrapper 的职责

`ServerInterfaceWrapper` 做两件事:

1. 把 OpenAPI security scopes 写入 request context。
2. 对 `/files` 的 `path`、`username`、`signature`、`signature_expiration` query 参数做类型绑定,再调用手写 handler。

它不会自动校验 JSON request body。`/init` 与 `/files/compose` 的 body 仍由各自 handler 解码和做业务校验。

### 2.3 服务组装

[`main.go`](../../packages/envd/main.go) 先把 Process/Filesystem RPC 注册到 `chi.Router`,再调用:

```go
service := api.New(...)
handler := api.HandlerFromMux(service, m)

server.Handler = withCORS(
	service.WithAuthorization(
		authnMiddleware.Wrap(handler),
	),
)
```

按请求进入顺序,中间件是:

```text
CORS
  → API access-token authorization
    → Connect username authentication
      → chi route / generated wrapper
        → API handler
```

Basic Auth 的 username middleware 主要服务 Connect RPC。它对所有经过 server 的请求可见:没有 Basic Auth 时直接放行,带有 Basic Auth 但 username 不存在时会拒绝请求;即使认证成功,REST 文件接口仍使用 query/body 中的 `username`,不会把 Basic Auth 用户当作文件 owner 来源。

---

## 三、请求入口与鉴权

### 3.1 默认 access token

envd 启动时 `SecureToken` 为空。token 未设置时,通用鉴权不拦截受保护端点,文件签名校验也会放行;这是 bootstrap 状态。首次 `/init` 的信任并不是由外层放行授予,而是由 handler 内的 MMDS/空状态规则决定。token 设置后,绝大多数端点要求:

```http
X-Access-Token: <sandbox access token>
```

token 存在 `memguard.LockedBuffer` 中,替换或销毁时会擦除旧 buffer;字符串比较使用 memguard 的常量时间比较。

### 3.2 三条鉴权路径

```text
请求
 │
 ├─ GET /health
 │    └─ 始终跳过通用 token 校验
 │
 ├─ POST /init
 │    └─ handler 内校验:现有 token 或 MMDS AccessTokenHash
 │
 ├─ GET/POST /files
 │    └─ handler 内校验:X-Access-Token 或签名 query
 │
 └─ 其他端点
      └─ token 已设置时必须匹配 X-Access-Token
```

通用中间件明确豁免 `GET /health`、`GET /files`、`POST /files`、`POST /init`。豁免只表示这些请求不在外层被拦截;`/init` 和 `/files` 仍有自己的校验。

### 3.3 文件签名

文件接口可不用 header token,改用 query 签名。签名原文是:

```text
无过期时间: path:operation:username:token
有过期时间: path:operation:username:token:expirationUnixSeconds
```

然后计算 SHA-256 并加 `v1_` 前缀:

```text
signature = "v1_" + sha256Hex(signingInput)
```

其中 `operation` 对下载是 `read`,对上传是 `write`;没有传 `username` 时签名字段使用空字符串,并不是解析后的默认用户名。若 header token 与签名同时存在,handler 优先检查 header;错误的 header 不会回退到有效签名。

`signature_expiration` 参与签名且必须不早于 envd 当前 Unix 秒。签名绑定原始 `path` 字符串,不是 path 解析后的绝对路径。

### 3.4 `/init` 的 MMDS 信任根

这里的“request token”特指 `/init` JSON body 的 `accessToken` 字段,不是 HTTP `X-Access-Token` header。`/init` 的独立校验只读取 body token;外层豁免意味着 header 不会替代 body token。

Orchestrator 在 Firecracker MMDS 中写入 `AccessTokenHash`。`/init` 接受以下任一条件:

1. request token 与 envd 当前 token 相同。
2. request token 的 hash 与 MMDS hash 相同。
3. envd 尚无 token且 MMDS 也没有有效 hash,属于首次设置。

MMDS 中 `hash("")` 明确授权清空 token;空的 MMDS 字段本身不授予 token reset。读取 MMDS 失败时,envd 会重新把保护 MMDS 的 iptables RETURN 规则置顶并重试一次,避免 guest 自定义重定向遮蔽 `169.254.169.254:80`。

JSON token 的具体语义是:

| body 状态 | 校验/更新语义 |
|---|---|
| 非空字符串 | 作为 request token,可在首次设置或 MMDS 授权下轮换,随后转移到 secure buffer |
| 字段省略或 JSON `null` | request token 为 nil;只有当前无 token的首次请求,或 MMDS 提供 `hash("")` 的显式 reset 才能通过;通过后清除当前 token |
| 空字符串 `""` | `SecureToken.UnmarshalJSON` 拒绝,返回 `400`;它不是清空 token 的写法 |

因此,要保持已有 token 不变,调用方应发送已有非空 token;不要省略字段。`envVars`、`volumeMounts` 等其他可选字段的省略语义见下表。

---

## 四、POST /init

### 4.1 定位

`/init` 不是只在第一次启动调用一次的构造函数,而是 Orchestrator 在 create/resume 阶段反复重试的**状态收敛入口**。它负责把 host 掌握的 lifecycle 配置重新应用到 guest,并在恢复时解冻用户进程。

请求可包含:

| 字段 | JSON 类型 | 作用与省略语义 |
|---|---|---|
| `timestamp` | RFC3339 string | host 当前时间,用于纠正 guest `CLOCK_REALTIME`;省略表示不带 timestamp,本次仍可应用配置 |
| `envVars` | object<string,string> | 替换用户环境变量集合;省略表示不修改 |
| `accessToken` | non-empty string | 设置或轮换 envd token;省略/`null` 只有在首次或显式 reset 授权时才表示清除,空字符串非法 |
| `defaultUser` | string | 设置文件与 RPC 默认用户;空或省略不修改 |
| `defaultWorkdir` | string | 设置默认工作目录;空或省略不修改 |
| `hyperloopIP` | IP string | 更新 `events.e2b.local` 和 `E2B_EVENTS_ADDRESS`;省略不修改 |
| `caBundle` | PEM string | 安装代理 CA 到 guest trust store;空或省略不安装 |
| `volumeMounts` | array<VolumeMount> | 挂载 NFS volume;省略不执行 mount,空数组表示本轮没有 volume |
| `lifecycleID` | string | 与 `volumeMounts` 配合判断 NFS mount 是否属于当前 lifecycle;省略按空 ID 处理 |

### 4.2 处理流程

```text
POST /init
  │
  ├─ 读取完整 body,JSON decode,退出时擦除原始 bytes
  ├─ 获取 initLock
  ├─ 校验 request token / MMDS hash
  │    └─ 未授权:401,且不允许触发 unfreeze
  ├─ 注册 deferred user/pty unfreeze
  ├─ timestamp 为空或严格大于 lastSetTime?
  │    ├─ 是:SetData
  │    └─ 否:跳过旧配置,仍执行 deferred unfreeze
  ├─ 后台重新轮询 MMDS metadata,最多 60s
  └─ 204 No Content + Cache-Control:no-store
```

认证发生在 unfreeze defer 之前,因此旧但合法的重试可以解冻,未授权请求不能借 `/init` 解冻进程。

后台 MMDS 轮询不重放 `SetData`:它刷新 internal env vars `E2B_SANDBOX_ID`、`E2B_TEMPLATE_ID` 及对应 `/run/e2b` 标记文件,并把非空日志 collector 地址送给日志 exporter。轮询在独立 goroutine 中最多运行 60s,失败只写 stderr,不改变当前 `/init` 已返回的 `204`。

### 4.3 timestamp 防倒退

`lastSetTime` 是原子最大值。带 timestamp 的请求只有在 timestamp 严格更新时才应用 `SetData`;无 timestamp 的请求总是应用。这样 Orchestrator 的并发或延迟重试不会用旧 env vars、token、用户和挂载配置覆盖新状态。

timestamp guard 只控制 `SetData`,不控制恢复所需的 unfreeze。这个边界保证“旧配置不能覆盖新配置”和“合法重试仍能恢复用户进程”同时成立。

### 4.4 `SetData` 的副作用

`SetData` 依次执行:

1. 必要时用 `clock_settime(CLOCK_REALTIME)` 校时。
2. 用 `ReplaceUserVars` 替换用户 env vars,保留 envd/MMDS 写入的 internal vars。
3. 转移新 token 的 secure buffer,或在授权的 nil token 请求中销毁旧 token。
4. 异步更新 Hyperloop hosts/env var。
5. 更新非空的默认用户和默认工作目录。
6. 同步安装非空 CA bundle。
7. 按 lifecycle 并发挂载 NFS volumes。

校时阈值并不对称:guest 比 host 慢超过 50ms,或快超过 5s 才调整。`clock_settime` 失败只记录日志,不会让 `/init` 失败;CA/NFS 失败会让请求返回错误。

### 4.5 env vars 的内外分层

`utils.EnvVars` 给每一项记录 `internal` 标志:

- `Store` 写 internal var,用户不能覆盖。
- `ReplaceUserVars` 删除旧的用户项、加入新用户项,但跳过同名 internal var。
- `All` 返回两类变量的合并快照。

因此 `/init` 的 `envVars` 是“替换全部用户变量”,不是 merge;同时它不能伪造 `E2B_SANDBOX_ID` 等 internal 元数据。

### 4.6 NFS mount 收敛

`lifecycleID` 是 Orchestrator 为每个新 Firecracker 进程生成的唯一 ID;它用于区分 create、memory resume 或 filesystem reboot 产生的新 VM 生命周期,同一 VM 的重复 `/init` 不会改变它。NFS 初始化使用 `isMountingNFS` 防止并发 mount episode。每个 path 记录上次成功 mount 的 `lifecycleID`:

```text
未记录该 path                 → mount
已记录且 lifecycleID 相同     → skip
已记录但 lifecycleID 改变     → unmount stale mount → remount
```

实现把 nil/省略的 ID 当作空字符串。空 ID 与空 ID 的已挂载记录会跳过 remount;从非空 ID 变为空,或从空变为非空,都会按 lifecycle 改变处理。

mount 使用 NFSv3、TCP、hard、sync、`noac`、`lookupcache=none`,单轮总超时 10s。它用 `context.WithoutCancel` 脱离 HTTP 客户端取消,再套自身 timeout,避免客户端断开把 guest 留在半挂载状态。

### 4.7 返回码

| 状态 | 含义 |
|---|---|
| `204` | 合法请求已收敛;旧 timestamp 也可返回此状态 |
| `400` | body/配置错误或 CA/NFS 等初始化失败 |
| `401` | token 与当前值/MMDS 都不匹配,或未被授权的 token reset |
| `503` | `initLock` 等待被取消,或并发 CA 安装仍在进行 |

Orchestrator 对网络错误做高频重试,但收到非 `204` response 后当前 `initEnvd` episode 会报错。因此 handler 必须让重复请求趋于相同状态。

---

## 五、GET /envs

`GetEnvs` 调用 `defaults.EnvVars.All()` 取得带锁快照,返回一个 JSON object:

```json
{
  "E2B_SANDBOX": "true",
  "E2B_SANDBOX_ID": "sbx_...",
  "USER_DEFINED_KEY": "value"
}
```

返回包含 internal 与 user 两类变量。它反映 envd 用于后续进程启动的默认环境,不是读取调用者 shell 的 `/proc/<pid>/environ`。

响应是 `200 application/json`,并设置 `Cache-Control: no-store`。token 已设置时,该端点由通用鉴权保护。

---

## 六、GET /files

### 6.1 参数和 path 解析

`GET /files` 接受:

| 参数 | 作用 |
|---|---|
| `path` | 文件路径;相对路径基于用户 home,空路径使用默认 workdir |
| `username` | 文件访问用户;缺省为 `/init` 设置的 default user |
| `signature` | 无 header token 时的 read 签名 |
| `signature_expiration` | 签名过期 Unix 秒 |

path 解析顺序:

```text
显式 path
  或 defaultWorkdir
    → 展开 ~/...
      → 绝对路径直接保留
      → 相对路径拼到 user.HomeDir
        → filepath.Abs 清理
```

这是 guest 内的文件 API,允许访问绝对路径;它不是把访问限制在 home 目录内的 sandbox-within-sandbox。授权边界来自 sandbox token/签名和 guest OS 文件权限。

### 6.2 下载流程

```text
签名/header token 校验
  → 解析 default username
  → os/user.Lookup
  → ExpandAndResolve
  → os.Stat:必须存在且不是目录
  → 协商 Accept-Encoding
  → os.Open
  ├─ gzip:io.Copy(file → gzip.Writer → response)
  └─ identity:http.ServeContent
```

identity 路径使用 `http.ServeContent`,因此支持 Range、修改时间和标准条件请求。响应还设置 `Content-Disposition: inline; filename=...` 与 `Vary: Accept-Encoding`。

### 6.3 gzip 与 Range

envd 只支持 `gzip` 和 `identity`。普通请求按 `Accept-Encoding` 的 q 值选择;如果带 `Range`、`If-Modified-Since`、`If-None-Match` 或 `If-Range`,handler 强制 identity,以保留 `206 Partial Content` 和 `304 Not Modified` 的语义。

若客户端同时拒绝 identity,条件/Range 请求返回 `406`。gzip 分支是动态流式压缩,不会预先把整个文件读进内存。

---

## 七、POST /files

### 7.1 两种上传格式

| Content-Type | path 来源 | 文件数 |
|---|---|---|
| `application/octet-stream` | 必须来自 `?path=` | 1 |
| `multipart/*` | 无 `?path=` 时使用每个 `file` part 的 filename;有 `?path=` 时该 path 应只用于一个 part | 多个 part(无 query path 时) |

请求可用 `Content-Encoding: gzip`;envd 先构造流式 gzip reader,再按解压后的内容执行 raw 或 multipart 解析。其他 content encoding 返回 `400`。

multipart 只处理 form name 为 `file` 的 part。`?path=` 会成为每个 part 的候选目标,所以带 query path 的请求若包含多个 `file` part,第二个 part 会因目标重复而返回 `400`;多文件上传应省略 query path 并在各 part filename 中提供不同相对路径。已经写入的前序 part 不会因后续 part 失败而回滚。

### 7.2 文件落盘

每个文件按以下顺序处理:

```text
EnsureDirs(parent, uid, gid)
  → 若目标已存在:确认不是目录并预先 chown
  → open(O_WRONLY | O_CREATE | O_TRUNC, 0666)
  → 必要时对新 fd chown
  → File.ReadFrom(request stream)
  → WriteMetadata(open fd, metadata)
  → ReadMetadata(path) 生成响应
```

预先 chown 的目的，是让已有 inode 在截断写入前就具有目标 owner。目录按 `0755` 创建,新文件初始 mode 还会受 guest umask 影响。

上传使用 `O_TRUNC`,不是 temp-file + rename。因此覆盖期间其他读者可能看到空文件或部分内容;写入失败也可能留下被截断的目标。需要“旧文件或完整新文件”发布语义时,应使用调用方自己的临时路径,完成后通过 Filesystem RPC move,或使用适合场景的 `/files/compose`。

### 7.3 文件 metadata

每个 `X-Metadata-<key>: <value>` header 会映射为 `user.e2b.<lowercase-key>` xattr。规则是:

- key/value 必须是可打印 US-ASCII `0x20-0x7E`。
- key 最长 246 bytes,为 Linux 255-byte xattr name 留出 `user.e2b.` 前缀。
- 单文件 metadata 总预算 4096 bytes。
- 重复 header 只取第一个值。
- multipart 中所有文件共享同一组 metadata。
- 每次上传**替换**完整 `user.e2b.*` 集合;没传 metadata 会清空旧的 E2B metadata。

metadata 通过已打开 fd 写入,避免 pathname 在写 xattr 时被并发 rename。`/proc`、`/sys` 等不支持 xattr 的虚拟文件系统会保留文件 body、记录 warning,但不宣称 metadata 已写入。xattr 空间不足返回 `507`。

### 7.4 返回与部分成功

成功返回 `200` 和 `EntryInfo[]`。磁盘/inode 或 xattr 空间不足映射为 `507 Insufficient Storage`。

`EntryInfo` 的字段来自 OpenAPI model:

| 字段 | JSON 类型 | 含义 |
|---|---|---|
| `path` | string | guest 内解析后的绝对路径 |
| `name` | string | `filepath.Base(path)` |
| `type` | string | 当前上传/compose 只返回 `file` |
| `metadata` | object<string,string>,可选 | 已从 `user.e2b.*` xattr 读回的 metadata;没有可读 metadata 时省略 |

例如单文件上传成功时响应是 `[ { "path": "/home/user/a.txt", "name": "a.txt", "type": "file" } ]`。compose 响应是单个 `EntryInfo` object,而不是数组,且实现不会从 source 继承 metadata。

multipart 是顺序流式处理,没有事务日志。第 N 个 part 失败时,前 N-1 个文件已经落盘;错误响应不会列出一份可靠的回滚计划。客户端需要把整批上传设计成可重试,并避免在一个 multipart 中复用目标路径。

---

## 八、POST /files/compose

### 8.1 请求

```json
{
  "source_paths": ["chunk-000", "chunk-001", "chunk-002"],
  "destination": "result.bin",
  "username": "user"
}
```

`source_paths` 的数组顺序就是拼接顺序。数组不能为空,destination 必填,每个 source 必须是 regular file,source 解析后的绝对路径不能等于 destination。

### 8.2 原理

```text
解析 username 与所有 path
  → 预检全部 source
  → EnsureDirs(destination parent)
  → 在 destination 同目录创建唯一 tmp file
  → chown tmp
  → 依次打开 source
      → destFile.ReadFrom(source)
  → close tmp
  → rename(tmp, destination)
  → best-effort remove(source...)
  → 返回 destination EntryInfo
```

Go 在 Linux regular-file 间的 `File.ReadFrom` 可走 `copy_file_range`,数据在内核中移动,避免用户态 read/write buffer。临时文件与 destination 同目录,所以最终 `os.Rename` 提供同一 filesystem 内的原子 namespace 替换:拼接失败不会破坏已有 destination,成功时读者看到旧目标或完整新目标。

### 8.3 原子性的边界

“原子 compose”只覆盖 destination 的发布,不表示整个操作是事务:

- source 在 rename 成功后逐个删除,删除错误被忽略,所以成功后可能残留 source。
- 没有目录/file `fsync`,进程或 VM 在极窄窗口崩溃时不提供数据库式持久化保证。
- source 在预检和打开之间仍可能被并发修改、替换或删除。
- destination metadata 不从 source 继承,响应只包含 path/name/type。

因此客户端可把 source 删除视为清理效果,不能把“source 一定不存在”当作成功条件。

---

## 九、GET /health 与 GET /metrics

### 9.1 `GET /health`

`/health` 只证明 envd HTTP handler 能被调度并返回 response。它不检查 MMDS、NFS、cgroup、rootfs 写入或下游 collector。

响应:

```http
HTTP/1.1 204 No Content
Cache-Control: no-store
```

该端点始终豁免 access token,适合 liveness probe。

### 9.2 `GET /metrics`

`host.GetMetrics()` 在请求时即时采样:

| 字段 | 来源 |
|---|---|
| `ts` | guest `time.Now().UTC().Unix()` |
| `cpu_count` | gopsutil logical CPU count |
| `cpu_used_pct` | gopsutil immediate CPU percent,保留两位小数 |
| `mem_total`、`mem_used`、`mem_cache` | guest virtual memory stats |
| `disk_used`、`disk_total` | `/` 的 `statfs` |
| `mem_total_mib`、`mem_used_mib` | 兼容旧 Orchestrator 的 deprecated 字段 |

Orchestrator 以短 timeout 轮询每个 live sandbox 的 `/metrics`,再转成带 sandbox/team/template attributes 的 OTEL observations。`ts` 还用于检测 guest 与 host 的时钟漂移。

该端点是 pull snapshot,不是 Prometheus exposition format,也不维护时间序列。采样任一步失败返回 `500`。

---

## 十、POST /freeze 与 POST /unfreeze

### 10.1 为什么不通过 Process RPC

pause 前可能有大量用户进程和系统负载。如果通过 Process RPC 启动 shell 再写 cgroup 文件,会引入进程创建、调度和 shell timeout 开销。原生端点直接调用 cgroup manager:

```text
POST /freeze
  → Freeze(user)
  → Freeze(pty)
```

`system` 和 `socat` cgroup 不冻结。envd 自身必须继续响应 pause 协议;端口转发也不能被历史版本中的错误 freeze 破坏。

### 10.2 部分执行语义

`PostFreeze` 和 `PostUnfreeze` 都会尝试 `user`、`pty` 两类,不会因第一类失败就跳过第二类。错误通过 `errors.Join` 汇总,只要任一类失败就返回 `500`。

因此 `500` 不表示“没有发生任何状态变化”:可能一个 cgroup 已冻结/解冻,另一个失败。调用方必须按幂等方式补偿。

### 10.3 `/unfreeze` 的限定用途

正常 pause 成功后,冻结状态进入 memory snapshot;resume 时由已认证 `/init` 的 deferred unfreeze 恢复。`POST /unfreeze` 只在 pause 失败、VM 仍存活时由 Orchestrator cleanup 调用。

这一区分很重要:

```text
pause 成功 → resume → /init → unfreeze
pause 失败 → cleanup → /unfreeze
```

如果把正常恢复改成独立 `/unfreeze`,就会绕过 `/init` 的配置收敛与授权顺序,让用户进程在 token/env/NFS/CA 尚未恢复前运行。

### 10.4 版本门控

Orchestrator 只对 envd `>= 0.6.3` 使用 native cgroup freeze。`0.6.0-0.6.2` 曾同时冻结 socat,因此虽然端点已存在,仍不满足正确的 resume 行为。

---

## 十一、POST /collapse

### 11.1 要解决的问题

envd 的 Go heap arena 运行一段时间后,live 4 KiB pages 会散布在许多 2 MiB guest-physical frame 中。冷 resume 从远端 snapshot 按 frame fault-in;envd 初始化触碰的 frame 越多,串行 cold fault 越多。

`/collapse` 在 pause 前把 envd 自己的匿名可写映射整理为 2 MiB transparent hugepages,让相关 live pages 聚集到更少 frame。它不整理用户进程 heap。

### 11.2 内核操作

Linux 实现:

```text
/proc/self/maps
  → 选择 anonymous + read/write + 无 pathname 的 region
  → MADV_HUGEPAGE(region)
  → 对完整且 2 MiB 对齐的 window:
       MADV_COLLAPSE(window)
  → /proc/self/smaps_rollup 的 AnonHugePages delta
       拆分 collapsed 与 alreadyHuge
```

逐 window 调 `MADV_COLLAPSE` 是为了让空或不满足条件的 window 只计为 skipped,不终止整个 region。调用是同步的,并在每个 region/window 之间检查 request context;Orchestrator timeout 或断连后会尽快停止后续 madvise。

### 11.3 统计值

响应示例:

```json
{
  "regions": 8,
  "chunks": 120,
  "collapsed": 37,
  "alreadyHuge": 61,
  "skipped": 22,
  "elapsedMs": 43
}
```

核心不变量:

```text
chunks = collapsed + alreadyHuge + skipped
```

`MADV_COLLAPSE` 对“新迁移”和“原本已经是 hugepage”都返回成功,所以实现用调用前后的 `AnonHugePages` 差值拆分两者。若 smaps 数据不可读或并发 THP 活动使计数倒退,实现保守地把成功项计入 `collapsed`。

### 11.4 best-effort 的两层含义

handler 内部会跳过单个不合格 window,继续处理其他 window;但读取 procfs、context cancel 等全局错误仍使 endpoint 返回 `500`。Orchestrator 对 endpoint 整体也是 best-effort:记录 duration/result 后继续 pause,不会因为 collapse 失败阻断 snapshot。

Orchestrator 从 envd `>= 0.6.5` 才调用该端点,并由 feature flag 控制是否启用和 timeout。

---

## 十二、POST /fsfreeze 与 POST /fsthaw

### 12.1 为什么 `sync` 不够

filesystem-only pause 不保存 guest memory,page cache 会在 reboot resume 时丢失。单独执行 `sync` 只能保证 sync 返回前的 dirty pages 已提交;在 `sync` 返回与 Firecracker pause 之间,用户进程仍可完成新写入,形成 acknowledged-write 丢失窗口。

`FIFREEZE` 同时完成两件事:

1. flush rootfs dirty data/metadata。
2. 阻塞后续 filesystem 修改,直到 thaw。

因此 `/fsfreeze` 关闭了 `sync → pause` race。

### 12.2 ioctl 与幂等

envd 对 mountpoint `/` 打开 fd,调用 Linux ioctl:

| 端点 | ioctl | 特殊 errno | 语义 |
|---|---|---|---|
| `/fsfreeze` | `FIFREEZE` | `EBUSY` | 已冻结,按成功处理 |
| `/fsthaw` | `FITHAW` | `EINVAL` | 未冻结,按成功处理 |

两个端点由独立的 `fsFreezeLock` 串行化。它与 cgroup `freezeLock` 分开,因为冻结进程和 quiesce filesystem 是不同资源与失败域。

### 12.3 成功路径和回滚路径

filesystem-only pause 成功后,VM 会停止并在下次 resume 走 reboot,旧 kernel 中的 frozen mount 状态随 VM 丢弃,无需 `/fsthaw`。

若 `/fsfreeze` 之后 pause/export 失败,VM 继续存活;Orchestrator cleanup 必须调用 `/fsthaw`,否则任何 filesystem writer 都可能永久阻塞。

Orchestrator 对 envd `>= 0.6.6` 使用 `/fsfreeze`;旧版本回退到强制 guest `sync`,但无法关闭 sync-to-pause race。

---

## 十三、pause/resume 完整时序

### 13.1 memory snapshot 成功

```text
Orchestrator                     envd / guest
     │
     ├─ stop health checks
     ├─ POST /freeze ───────────► Freeze user + pty cgroups
     ├─ POST /collapse ─────────► Collapse envd anonymous heap
     ├─ optional reclaim ───────► fstrim/sync/drop_caches/compact_memory
     ├─ Firecracker Pause
     ├─ create/upload snapshot
     │
     │  ... later resume ...
     │
     ├─ restore VM + MMDS token hash
     └─ POST /init ─────────────► validate token
                                  apply newer config
                                  deferred Unfreeze(user + pty)
```

`/freeze` 与 `/collapse` 受 feature flag 和 envd version gate 控制,属于 best-effort reclaim。即使它们失败,Orchestrator 仍可继续 pause。

### 13.2 memory snapshot 失败

```text
POST /freeze
  → 后续 pause/snapshot 失败
    → Cleanup.Run
      → POST /unfreeze
        → live VM 恢复 user + pty
```

cleanup 使用脱离已取消 parent context 的调用,因为原始 pause context 失败不能成为跳过补偿的理由。

### 13.3 filesystem-only pause

```text
best-effort /freeze + /collapse + reclaim
  → mandatory /fsfreeze (或旧 envd 的 mandatory sync)
  → Firecracker Pause
  → rootfs drain/export
  → stop VM
  → 下次从 rootfs reboot
```

任何中途错误会运行 `/fsthaw` 与 `/unfreeze` cleanup,使仍存活的 VM 回到可用状态。成功路径不 thaw:旧 VM 被丢弃,新 boot 的 filesystem 和 cgroups 天然未冻结。

---

## 十四、并发、取消与幂等边界

### 14.1 锁与状态

| 原语 | 保护对象 | 参与路径 |
|---|---|---|
| `initLock` | `/init` 配置收敛 episode | `/init` |
| `lastSetTime` | 最新配置 timestamp | `/init` |
| `freezeLock` | user/pty cgroup sweep | `/freeze`、`/unfreeze`、`/init` deferred unfreeze |
| `fsFreezeLock` | rootfs freeze state | `/fsfreeze`、`/fsthaw` |
| `hyperloopLock` | `/etc/hosts` rewrite | `/init` 异步 Hyperloop setup |
| `isMountingNFS` | 单轮 NFS mount episode | `/init` |
| `mountedPaths` | path → lifecycleID | `/init` NFS 收敛 |
| `SecureToken.mu` | token buffer 生命周期 | 鉴权、签名、`/init` token 更新 |

`/init` 先持有 `initLock`,退出时执行 deferred unfreeze 并获取 `freezeLock`;`/freeze` 和 `/unfreeze` 不反向获取 `initLock`,避免锁顺序环。

### 14.2 request cancellation

不同操作对取消的处理是有意不同的:

| 操作 | 使用 request context | 原因 |
|---|---|---|
| `/init` initLock | 是 | 请求在等待配置收敛锁时被取消会返回 `503` |
| `/freeze` lock | 是 | 调用者放弃后不必等待尚未开始的 freeze |
| `/collapse` work | 是 | timeout 后停止额外 madvise |
| `/fsfreeze` lock | 是 | 调用者放弃后不开始新的 freeze |
| `/unfreeze` lock | `WithoutCancel` | 补偿必须尽量完成 |
| `/fsthaw` lock | `WithoutCancel` | 不能因断连留下 frozen rootfs |
| `/init` deferred unfreeze | `WithoutCancel` | 合法 init 一旦进入就要恢复用户进程 |
| NFS mount | `WithoutCancel` + 10s timeout | 避免半完成,同时保证有界 |

### 14.3 幂等矩阵

| 端点 | 重复调用结果 |
|---|---|
| `/init` | 新 timestamp 收敛;旧 timestamp 不覆盖配置但仍 unfreeze |
| `/freeze` | cgroup manager 应允许重复 freeze;部分失败仍可能改变状态 |
| `/unfreeze` | 未冻结时应为 no-op |
| `/fsfreeze` | `EBUSY` 视为成功 |
| `/fsthaw` | `EINVAL` 视为成功 |
| `/collapse` | 可重复,后续更多项会落入 `alreadyHuge`;不是无副作用 no-op |
| `/files` GET | 只读,但结果受并发文件修改影响 |
| `/files` POST | 可覆盖,不是原子;重复 multipart 可能重复部分副作用 |
| `/files/compose` | source 成功后通常被删,所以同一请求一般不可直接重放 |

---

## 十五、错误与响应约定

### 15.1 JSON error

多数业务错误经 `jsonError` 返回:

```json
{
  "message": "path '/tmp/missing' does not exist",
  "code": 404
}
```

并设置:

```http
Content-Type: application/json; charset=utf-8
X-Content-Type-Options: nosniff
```

### 15.2 非统一路径

当前实现并非所有错误都使用 OpenAPI `Error` JSON:

- 生成 wrapper 的 query bind 错误默认走 `http.Error`,是 text/plain `400`。
- `/init` 的业务错误写 status 后直接写错误文本。
- `/metrics` 采样失败只写 `500`,没有 JSON body。
- response 已开始流式写出后发生的 gzip/encode 错误只能记录日志,不能可靠改写 status。

客户端应优先以 HTTP status 判断结果,只在 content type 为 JSON 时解析标准 `Error`。

### 15.3 常见 status

| 状态 | 典型来源 |
|---|---|
| `200` | envs、files、compose、metrics、collapse |
| `204` | health、init、freeze/unfreeze、fsfreeze/fsthaw |
| `400` | body/query/path/content type/metadata 不合法 |
| `401` | token/signature/user 校验失败 |
| `404` | 下载或 compose source 不存在 |
| `406` | 无可接受 download encoding |
| `500` | syscall、文件、采样或全局 collapse 失败 |
| `503` | 初始化/冻结相关锁等待被取消或并发初始化仍在进行 |
| `507` | file body、inode 或 xattr 空间不足 |

---

## 十六、常见问题与排查

### 16.1 `/files` 明明有正确签名仍返回 401

检查是否同时发送了错误的 `X-Access-Token`。header 存在时不会回退到 query signature。然后逐字核对签名输入中的原始 path、`read/write`、username 空值规则和 expiration 秒。

### 16.2 上传成功但 metadata 没有返回

确认目标 filesystem 支持 `user.*` xattr。envd 对 `/proc`、`/sys` 一类不支持 xattr 的 filesystem 会保留 body 上传结果,但 metadata best-effort 丢弃并记录 warning。

### 16.3 multipart 返回错误后为什么已有文件

multipart part 是按流顺序直接写目标文件,没有整批事务。检查错误发生前的 part,并让重试使用确定的目标路径和内容。

### 16.4 compose 成功后 source 仍存在

destination rename 是成功判定点,之后的 source 删除是 best-effort 且忽略错误。残留 source 可由调用方另行清理;不要因此否定已发布的 destination。

### 16.5 stale `/init` 为什么仍然解冻进程

timestamp 只防止旧配置覆盖新配置。合法 `/init` 还是 resume handshake,必须执行 deferred unfreeze;否则一次延迟重试可能让恢复后的用户进程永久冻结。

### 16.6 `/freeze` 返回 500 后是否可以假设没冻结

不可以。handler 尝试两个 cgroup 并聚合错误,一个成功另一个失败也返回 500。pause 失败路径应继续执行幂等 `/unfreeze`。

### 16.7 filesystem-only pause 卡住写操作

确认 pause 错误 cleanup 是否调用 `/fsthaw`,envd 版本是否 `>= 0.6.6`,以及 `/fsthaw` 的 Orchestrator/guest 日志。`FIFREEZE` 后仍存活的 VM 若未 thaw,写 filesystem 的进程会阻塞。

### 16.8 `/collapse` 的 collapsed 很低是不是失败

不一定。查看 `alreadyHuge` 和 `skipped`:heap 可能已被 THP 覆盖,也可能多数 2 MiB window 为空或不满足 collapse 条件。endpoint 的目标是减少 resume frame faults,不能只用单次 collapsed 数判断收益。

---

## 十七、关键文件索引

| 文件 | 职责 |
|---|---|
| [`packages/envd/spec/envd.yaml`](../../packages/envd/spec/envd.yaml) | REST OpenAPI 契约 |
| [`internal/api/api.gen.go`](../../packages/envd/internal/api/api.gen.go) | 生成模型、ServerInterface、query binding 与 chi 路由 |
| [`internal/api/store.go`](../../packages/envd/internal/api/store.go) | API 状态、锁、health、metrics |
| [`internal/api/auth.go`](../../packages/envd/internal/api/auth.go) | 通用 token 中间件与文件签名 |
| [`internal/api/init.go`](../../packages/envd/internal/api/init.go) | `/init`、cgroup freeze/unfreeze、NFS/Hyperloop 初始化 |
| [`internal/api/download.go`](../../packages/envd/internal/api/download.go) | 文件下载、Range、gzip |
| [`internal/api/upload.go`](../../packages/envd/internal/api/upload.go) | raw/multipart 上传、owner 与 metadata |
| [`internal/api/compose.go`](../../packages/envd/internal/api/compose.go) | zero-copy compose 与 destination rename |
| [`internal/api/collapse.go`](../../packages/envd/internal/api/collapse.go) | collapse HTTP handler |
| [`services/memory/collapse_linux.go`](../../packages/envd/internal/services/memory/collapse_linux.go) | proc maps、THP 与 `MADV_COLLAPSE` |
| [`internal/api/fsfreeze.go`](../../packages/envd/internal/api/fsfreeze.go) | rootfs freeze/thaw HTTP handler |
| [`services/fsfreeze/fsfreeze_linux.go`](../../packages/envd/internal/services/fsfreeze/fsfreeze_linux.go) | `FIFREEZE`/`FITHAW` ioctl |
| [`shared/pkg/filesystem/xattr.go`](../../packages/shared/pkg/filesystem/xattr.go) | `user.e2b.*` metadata 读写与限制 |
| [`orchestrator/pkg/sandbox/envd.go`](../../packages/orchestrator/pkg/sandbox/envd.go) | Orchestrator 的 init/pause endpoint client |
| [`orchestrator/pkg/sandbox/reclaim.go`](../../packages/orchestrator/pkg/sandbox/reclaim.go) | pause 前 reclaim、freeze/collapse/fsfreeze 与补偿 |
| [`orchestrator/pkg/sandbox/sandbox.go`](../../packages/orchestrator/pkg/sandbox/sandbox.go) | Pause 主时序与 cleanup 注册 |

---

## 附录 A:端点速查

| Method | Path | 成功 | token 已设置后的鉴权 | 主要副作用 |
|---|---|---|---|---|
| `POST` | `/init` | `204` | 当前 token 或 MMDS hash | 配置、token、CA、NFS、Hyperloop、unfreeze |
| `GET` | `/envs` | `200` | header token | 无 |
| `GET` | `/files` | `200/206/304` | header token 或 read signature | 无 |
| `POST` | `/files` | `200` | header token 或 write signature | 创建/截断文件、owner、xattr |
| `POST` | `/files/compose` | `200` | header token | 发布 destination、删除 source |
| `GET` | `/health` | `204` | 豁免 | 无 |
| `GET` | `/metrics` | `200` | header token | 即时资源采样 |
| `POST` | `/freeze` | `204` | header token | freeze user/pty cgroups |
| `POST` | `/unfreeze` | `204` | header token | unfreeze user/pty cgroups |
| `POST` | `/collapse` | `200` | header token | 整理 envd anonymous heap |
| `POST` | `/fsfreeze` | `204` | header token | flush 并冻结 `/` filesystem |
| `POST` | `/fsthaw` | `204` | header token | thaw `/` filesystem |

## 附录 B:关键不变量

1. 未授权 `/init` 不能触发 user/pty unfreeze。
2. 合法但 stale 的 `/init` 不覆盖新配置,仍执行 resume unfreeze。
3. 正常 resume 通过 `/init` unfreeze;`/unfreeze` 只用于 pause 失败补偿。
4. filesystem-only pause 成功不调用 `/fsthaw`;失败且 VM 仍存活时必须补偿 thaw。
5. cgroup freeze 不包含 `system` 和 `socat`。
6. `/collapse` 只整理 envd 自身匿名可写映射,且 `chunks = collapsed + alreadyHuge + skipped`。
7. `/files` 覆盖上传不是原子发布;`/files/compose` 只保证 destination rename 的原子可见性。
8. 上传 metadata 替换完整 `user.e2b.*` 集合,不会删除其他 namespace 的 xattr。
9. 文件签名绑定原始 path、operation、原始 username 字段和可选 expiration。
10. token 为空时通用鉴权开放是 bootstrap 行为,不是已初始化 sandbox 的常态。
