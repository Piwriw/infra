# `packages/docker-reverse-proxy/` 原理详解

> 本文梳理 E2B 自托管 Docker registry 反向代理的完整工作原理。所有结论基于仓库源码、`.understand-anything/knowledge-graph.json` 与 IaC 配置文件。

## 1. 背景与定位

### 1.1 为什么需要它

E2B 平台的核心是 **沙箱 = 容器镜像 = OCI artifact**。用户创建/构建自定义环境时，需要 `docker push` 镜像到 E2B 的私有 registry，运行时 orchestrator 也会从该 registry `docker pull` 镜像。直接暴露 GCP Artifact Registry 的接口给用户有两个问题：

1. **协议身份不匹配**：GCP Artifact Registry 的认证用 GCP OAuth / Service Account JSON，**与 E2B 自身的 access token 模型不兼容**。用户不可能用 E2B SDK 签发的 token 去签 GCP 请求。
2. **缺少租户级授权**：GCP 原生权限模型只有"项目级 / 仓库级"，无法表达"用户 X 对模板 Y 有 push 权限但对模板 Z 没有"这种细粒度约束。
3. **Docker CLI 期望标准 v2 registry API**：需要 `WWW-Authenticate: Bearer realm="..."` 引导用户走 OAuth 流程，**GCP 的 401 响应不符合这个规范**，原样透传会破坏 `docker login` / `docker push` 流程。

`docker-reverse-proxy` 就是为了解决这三个问题而存在的 **GCP Artifact Registry 的薄包装**。

### 1.2 它做什么 / 不做什么

| 它做 | 它不做 |
| --- | --- |
| 接受 `docker push` / `docker pull` / `docker login` 调用 | 不存储任何镜像（透传到 GCP） |
| 解析 E2B access token 校验身份 | 不解析 JWT 内容，只验证哈希是否在 DB |
| 根据请求 scope 校验"该 token 能否操作该模板" | 不参与沙箱调度（那是 orchestrator 的事） |
| 用 GCP Service Account 替用户向 Artifact Registry 申请短期 token | 不缓存 GCP 颁发的 token（每次重新拿） |
| 把 path 前缀从 `/v2/e2b/custom-envs/<template>` 重写为 `/v2/<project>/<repo>/<template>` | 不实现 Docker 协议层（manifest / blob 校验），只做 HTTP 转发 |

### 1.3 在系统中的位置

```
docker CLI  ───HTTPS───►  docker-reverse-proxy  ───HTTPS (Basic SA creds)──►  GCP Artifact Registry
                          │                                                       │
                          ├── PostgreSQL (team_access, template, build)           └── 真实 OCI 镜像
                          │
                          └── 内存 TTL cache (e2bToken → {templateID, dockerToken})
```

## 2. 目录结构

```
packages/docker-reverse-proxy/
├── Dockerfile                        # 多阶段构建：golang:1.26.3-alpine → alpine:3.22
├── Makefile                          # build / build-debug / build-and-upload / test
├── go.mod                            # 独立 module（依赖 shared + db + jellydator/ttlcache）
├── main.go                           # 入口、路由表、HTTP 服务器启动
└── internal/
    ├── auth/validate.go              # E2B token 哈希校验 + scope 模板授权查询
    ├── auth/validate_test.go         # 单测
    ├── cache/auth.go                 # AuthCache（基于 ttlcache v3）
    ├── constants/main.go             # 启动期环境变量校验 + 路径常量
    ├── handlers/
    │   ├── store.go                  # APIStore：组合 db、authDb、AuthCache、ReverseProxy
    │   ├── proxy.go                  # /v2/* 转发主逻辑
    │   ├── login.go                  # /v2/ (version-check) 处理
    │   ├── token.go                  # /v2/token 颁发短期 docker 凭据
    │   └── health.go                 # /health 探针
    └── utils/
        ├── authorization.go          # SetDockerUnauthorizedHeaders（401 响应规范）
        ├── random.go                 # GenerateRandomString（crypto/rand + base64）
        └── string.go                 # SubstringMax（日志截断）
```

> **包名** `auth` 是包内自实现的（与 `packages/auth/` 不同），仅做"反代视角"的 token 哈希校验，不涉及 JWT 解析。

## 3. 启动流程（`main.go`）

```
main()
  ├─ constants.CheckRequired()         # 校验 5 个必需环境变量
  ├─ flag.Parse() → :5000              # 默认 5000 端口（Nomad job 可覆盖）
  ├─ handlers.NewStore(ctx)            # 见 §4
  ├─ http.NewServeMux()
  ├─ mux.HandleFunc("/", 路由分发)    # 见 §3.1
  ├─ httpserver.ConfigureH2C(server)  # 启用 HTTP/2 cleartext（docker 流量大）
  └─ server.ListenAndServe()
```

### 3.1 路由表（一个 catch-all）

只有一条 `"/"` 路由 + 一组基于 `req.URL.Path` / `req.Method` 的分支判断，是 **单一路由器**：

```go
mux.HandleFunc("/", func(w, r) {
    // 1. /health
    if r.URL.Path == "/health"               → store.HealthCheck

    // 2. PATCH /artifacts-uploads/...  (跨服务)
    if Method==PATCH && path startsWith
       /artifacts-uploads/namespaces/{project}/repositories/{repo}/uploads/
                                              → store.ServeHTTP  （直透传，无认证）

    // 3. POST /v2/token  (Docker OAuth spec 但本服务不用)
    if POST  /v2/token                       → 404

    // 4. 无 Authorization header
    if r.Header.Get("Authorization") == ""   → SetDockerUnauthorizedHeaders(401 + WWW-Authenticate)

    // 5. GET /v2/token  (本服务实现)
    if r.URL.Path == "/v2/token"             → store.GetToken

    // 6. /v2/  (API version check)
    if r.URL.Path == "/v2/"                  → store.LoginWithToken

    // 7. 其余
                                          → store.Proxy
})
```

设计要点：
- **先做路径分流再校验 token**：单分支判断 + 早返回，避免在 hot path 上跑校验。
- **PATCH /artifacts-uploads 是反例**：GCP 上传 blob 是 PATCH + 长随机 URL，**没有 Authorization 头**，所以要单独豁免。
- **POST /v2/token 故意返回 404**：Docker CLI 优先尝试 OAuth flow，**我们用 Token flow（GET）**，返回 404 引导它走正确的路径。

## 4. 核心数据结构 `APIStore`（`handlers/store.go`）

```go
type APIStore struct {
    db        *client.Client        // sqlc 生成的 PostgreSQL 客户端
    authDb    *authdb.Client        // 另一份 PostgreSQL 客户端，访问 auth schema
    AuthCache *cache.AuthCache      // 内存 ttlcache
    proxy     *httputil.ReverseProxy // 单 host 反向代理
}
```

构造逻辑（`NewStore`）：

```go
databaseURL := utils.RequiredEnv("POSTGRES_CONNECTION_STRING", ...)
database,   _ := client.NewClient(ctx, databaseURL, pool.WithMaxConnections(3))
authDatabase,_ := authdb.NewClient(ctx, databaseURL, databaseURL, pool.WithMaxConnections(3))

targetUrl := &url.URL{Scheme: "https", Host: "<GCP_REGION>-docker.pkg.dev"}
proxy := httputil.NewSingleHostReverseProxy(targetUrl)
proxy.ModifyResponse = func(resp *http.Response) error {
    if resp.StatusCode == 401 {
        log body for debugging
    }
    return nil
}
```

要点：
- **两个独立的 DB 连接池**：`db` 走业务表（`template`、`team_access`），`authDb` 走 auth schema。隔离关注点。
- **`MaxConnections(3)`**：反代是 IO 密集型而非事务密集型，3 个连接足够；多一个浪费 PG 端 fd。
- **`httputil.NewSingleHostReverseProxy`**：用 stdlib 自带的反向代理；`Director` 是默认的（按 host header 转发），不写自定义。
- **`ModifyResponse` 仅做日志**：把上游 401 的 body 打出来方便排查（默认会被吞掉）。

## 5. 认证与 token 流

E2B 的 access token 命名规则是 `e2b_<random>`。DB 里存的是哈希值（详见 `shared/pkg/keys.VerifyKey`）。整套认证有 **三层校验**：

### 5.1 Token 形态校验（`auth.ExtractAccessToken`）

Docker CLI 把 token 放在 Basic Auth 里： `Authorization: Basic base64("_e2b_access_token:<access_token>")`。

```go
encodedLoginInfo := strings.TrimPrefix(authHeader, "Basic ")
loginInfo, _    := base64.StdEncoding.DecodeString(encodedLoginInfo)
parts           := strings.Split(string(loginInfo), ":")
if parts[0] != "_e2b_access_token" { return error }
return strings.TrimSpace(parts[1]), nil
```

只关心 `_e2b_access_token` 这种约定 username；不接受其他 username。特殊处理：去掉 token 周围的双引号（兼容 Windows docker CLI 多余的引号）。

### 5.2 token 合法性校验（`auth.ValidateAccessToken`）

```go
hashedToken, _ := keys.VerifyKey(keys.AccessTokenPrefix, accessToken)
_, err := db.Read.GetUserIDFromAccessToken(ctx, hashedToken)
return err == nil
```

- 先用 `keys.VerifyKey` 校验 token 格式（必须是 `e2b_xxx`，否则直接 false）。
- 再用 access token 的哈希值去 `auth` schema 查 user_id，能查到即合法。

### 5.3 模板授权校验（`auth.Validate`）

只有当请求带了 `?scope=repository:e2b/custom-envs/<templateID>:pull|push` 时才会走到这里：

```go
hashedToken, _ := keys.VerifyKey(keys.AccessTokenPrefix, token)
exists, err := sqlcDB.ExistsWaitingTemplateBuild(ctx, queries.ExistsWaitingTemplateBuildParams{
    TemplateID:      envID,
    AccessTokenHash: hashedToken,
})
```

查询的是"该 token 是否在 template build 任务上有名下记录"。这是 E2B 团队在 `template build` 流程里分配的临时权限——只有当用户主动触发"build this template"时，DB 里才会出现一对 `(template_id, access_token_hash)` 记录，反代据此判定 push 授权。

> 注意：pull 路径走的是 **缓存里现成的 dockerToken**（见 §6），不需要每次都查 DB；只有 `GetToken` 这个 "申请新 token" 的端点才查。

## 6. 短期 Docker Token 颁发（`handlers/token.go`）

这是整个包 **最核心的业务逻辑**。Docker CLI 在 `docker push` 之前会向 `https://<host>/v2/token?...` 发起 GET 请求；本服务响应一个 **短期 token**，CLI 后续会带着它去打 `/v2/...`。

### 6.1 流程

```
docker CLI                                    docker-reverse-proxy                              GCP Artifact Registry
   │                                                │                                                    │
   │  GET /v2/token?scope=repository:e2b/          │                                                    │
   │   custom-envs/<id>:push,pull                   │                                                    │
   │  Authorization: Basic base64("_e2b_...:tkn")  │                                                    │
   │ ─────────────────────────────────────────────► │                                                    │
   │                                                │ ExtractAccessToken() → tkn                        │
   │                                                │ ValidateAccessToken(authDb, tkn)                  │
   │                                                │  ↳ if invalid: 403                                │
   │                                                │ scopeRegex.FindStringSubmatch(scope)              │
   │                                                │  ↳ if action=delete: 403                          │
   │                                                │ Validate(db, tkn, templateID)                      │
   │                                                │  ↳ if no access: 403                              │
   │                                                │                                                    │
   │                                                │ ── GET /v2/token?service=...&scope=repository     │
   │                                                │       :<project>/<repo>/<template>:push,pull ──► │
   │                                                │      Authorization: Basic base64(<gcp_sa_key>)    │
   │                                                │ ◄──── {"token":"<gcp_docker_token>","expires_in":N} ─
   │                                                │                                                    │
   │                                                │ AuthCache.Create(templateID, gcpDockerToken, ttl)  │
   │                                                │  ↳ 生成 e2bToken (crypto/rand, 128B)              │
   │                                                │  ↳ cache.Set(e2bToken, AccessTokenData{...}, 2h)  │
   │                                                │  ↳ return JSON: {"token":"<e2bToken>","expires_in":N}
   │ ◄──────────────────────────────────────────────│                                                    │
   │                                                │                                                    │
   │  POST/GET/PUT /v2/e2b/custom-envs/<id>/...     │                                                    │
   │  Authorization: Bearer <e2bToken>              │                                                    │
   │ ─────────────────────────────────────────────► │ AuthCache.Get(e2bToken) → AccessTokenData         │
   │                                                │ req.Header.Set("Authorization",                   │
   │                                                │   "Bearer <gcpDockerToken>")                      │
   │                                                │ req.URL.Path rewrite: /v2/e2b/custom-envs/...     │
   │                                                │                → /v2/<project>/<repo>/...         │
   │                                                │ httputil.ReverseProxy.ServeHTTP ───────────────► │
```

### 6.2 Scope 正则

```go
var scopeRegex = regexp.MustCompile(
    `^repository:e2b/custom-envs/(?P<templateID>[^:]+):(?P<action>[^:]+)$`)
```

- 严格匹配 `repository:e2b/custom-envs/<templateID>:<action>`，**项目名和仓库名都硬编码成 e2b/custom-envs**。
- `action` 收 `[^:]+`，但代码里有 `if strings.Contains(action, "delete")` 显式拒绝删除操作——**避免某个 token 拿到 delete 权限**把别人的镜像删了。

### 6.3 `AuthCache.Create` 的设计

```go
func (c *AuthCache) Create(templateID, token string, expiresIn int) string {
    userToken := utils.GenerateRandomString(128)              // crypto/rand, base64
    jsonResponse := fmt.Sprintf(`{"token": "%s", "expires_in": %d}`, userToken, expiresIn)
    c.cache.Set(userToken, &AccessTokenData{
        DockerToken: token,  // 真正的 GCP 颁发的 token
        TemplateID:  templateID,
    }, time.Hour*2)            // 缓存 TTL = 2 小时（与 GCP token 同寿命）
    return jsonResponse
}
```

关键观察：
- **"e2bToken" 是本服务自己生成的随机串**，与 E2B access token 无关——它只是一个 session id。
- **缓存的是 GCP token，不是 E2B token**。`AuthCache.Get(e2bToken)` 拿到 `DockerToken` 后再写到 `Authorization` 头里转给上游。
- **TTL = 2 小时**，与 GCP `expires_in` 同量级。过期后 docker CLI 自动重新 GET `/v2/token` 走一遍流程。
- **缓存粒度是 token 维度**（不是 team 维度），不同用户有不同 e2bToken。

## 7. 反向代理（`handlers/proxy.go`）

### 7.1 三段式保护

```go
func (a *APIStore) Proxy(w, r) {
    // ① token 缓存校验：e2bToken 必须在 cache 里
    e2bToken := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
    token, err := a.AuthCache.Get(e2bToken)
    if err != nil { SetDockerUnauthorizedHeaders(w); return }

    // ② 注入上游凭据
    r.Header.Set("Authorization", "Bearer "+token.DockerToken)

    // ③ 路径 / scope 二次校验（防越权访问其他 template）
    if path startsWith /v2/e2b/custom-envs/ or /v2/<project>/<repo>/
        if path startsWith /v2/<project>/<repo>/pkg/blobs/uploads/   ← 上传分片,放行
        templateWithBuildID := parse  ← path 第二段:tag
        if templateWithBuildID[0] != token.TemplateID                 ← 越权,403
        r.URL.Path = Replace /v2/e2b/custom-envs/ → /v2/<project>/<repo>/
        ServeHTTP(w, r)
    else 403
}
```

### 7.2 路径改写

```go
repoPrefix    := "/v2/e2b/custom-envs/"
realRepoPrefix := fmt.Sprintf("/v2/%s/%s/", consts.GCPProject, consts.DockerRegistry)
r.URL.Path     = strings.Replace(r.URL.Path, repoPrefix, realRepoPrefix, 1)
```

示例：
```
client 请求:    /v2/e2b/custom-envs/my-template/abc123/manifests/latest
改写后发到 GCP: /v2/my-gcp-project/custom-envs/my-template/abc123/manifests/latest
```

### 7.3 越权防护层级

| 校验 | 何时执行 | 拒绝响应 |
| --- | --- | --- |
| e2bToken 是否在 cache | 每个请求 | 401 + WWW-Authenticate |
| 路径是否在白名单（custom-envs 或真实 prefix） | 每个请求 | 403 |
| 路径里的 templateID 是否等于 cache 里的 templateID | 非 blob upload 路径 | 403 |
| blob upload（PATCH 之外）走真实 prefix 但不查 templateID | 上传分片 | —（仍走 ① ②） |

> blob upload 用 templateID:buildID 命名，**buildID 每次构建都不同**，没法在 cache 阶段提前预知；用"/v2/.../pkg/blobs/uploads/" 前缀识别"上传中"分片，**跳过 templateID 比对**。

## 8. 缓存层（`cache/auth.go`）

```go
type AccessTokenData struct {
    DockerToken string  // 真正的 GCP 颁发的 token
    TemplateID  string  // 颁发时锁定的 template
}

type AuthCache struct {
    cache *ttlcache.Cache[string, *AccessTokenData]
}
```

- 选 `github.com/jellydator/ttlcache/v3` 而非手写 map+mutex——支持 TTL 自动过期、并发安全、内置 `Start()` 后台清理。
- 启动时 `go cache.Start()` 启动清理协程。
- `Get` 找不到时返回 error（区分"key 不存在"和"key 存在但 nil"，虽然这里两者等价）。
- **2 小时 TTL** 是硬编码常量 `authInfoExpiration`；与 GCP token 寿命同步，避免下发一个 e2bToken 但里面存的 GCP token 已失效。

> **进程内缓存**——多实例部署时不共享。这是有意为之：GCP 颁发 token 廉价（一次 HTTP 调用），多副本各持各的 cache 没有同步问题。

## 9. 工具函数（`utils/`）

### 9.1 `SetDockerUnauthorizedHeaders`（`authorization.go`）

```go
func SetDockerUnauthorizedHeaders(w) {
    w.Header().Set("Www-Authenticate",
        fmt.Sprintf(`Bearer realm="https://docker.%s/v2/token"`, consts.Domain))
    w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
    w.WriteHeader(http.StatusUnauthorized)
}
```

这是 Docker Registry v2 协议规定的 401 响应。`Www-Authenticate` 里的 `realm` 告诉 CLI 去哪个 URL 申请 token，CLI 据此自动 GET 一次 `/v2/token`。

### 9.2 `GenerateRandomString`（`random.go`）

```go
func GenerateRandomString(length int) string {
    b := make([]byte, length)
    _, _ = rand.Read(b)             // crypto/rand
    return base64.StdEncoding.EncodeToString(b)
}
```

- 用 `crypto/rand`（密码学安全 RNG）而非 `math/rand`。
- 128 字节的输入 → 约 171 字符 base64 串作为 e2bToken。
- `rand.Read` 失败会 panic（确实会失败的情况：/dev/urandom 不可用等几乎不会发生）。

### 9.3 `SubstringMax`（`string.go`）

```go
func SubstringMax(s string, maxLen int) string {
    if len(s) <= maxLen { return s }
    return s[:maxLen] + "..."
}
```

- **只按字节数截断**，不处理 rune 边界——中文等可能产生乱码，但 docker URL 路径全是 ASCII，无问题。
- 截断路径用于日志输出，避免超长 blob upload URL 把日志撑爆。

## 10. 配置与启动校验（`constants/main.go`）

```go
func CheckRequired() error {
    var missing []string
    if consts.GCPProject               == "" { missing = append(missing, "GCP_PROJECT_ID") }
    if consts.Domain                   == "" { missing = append(missing, "DOMAIN_NAME") }
    if consts.DockerRegistry           == "" { missing = append(missing, "GCP_DOCKER_REPOSITORY_NAME") }
    if consts.GoogleServiceAccountSecret == "" { missing = append(missing, "GOOGLE_SERVICE_ACCOUNT_BASE64") }
    if consts.GCPRegion                == "" { missing = append(missing, "GCP_REGION") }
    if len(missing) > 0 { return error }
    return nil
}

var GCPArtifactUploadPrefix = fmt.Sprintf(
    "/artifacts-uploads/namespaces/%s/repositories/%s/uploads/",
    consts.GCPProject, consts.DockerRegistry,
)
```

- **5 个必需 env**：项目、域名、仓库名、Service Account 凭据、区域。
- `GCPArtifactUploadPrefix` 是硬编码白名单前缀，**用 env 拼出来后缓存为包级变量**，避免每个请求都 `fmt.Sprintf`。
- `CheckRequired` 在 main 启动时跑一次，缺一即 `log.Fatal`——**fail fast**。

## 11. 部署（IaC）

### 11.1 GCP 资源（`iac/provider-gcp/docker-reverse-proxy.tf`）

```hcl
resource "google_service_account" "docker_registry_service_account" {
  account_id   = "${var.prefix}docker-reverse-proxy-sa"
  display_name = "Docker Reverse Proxy Service Account"
}

resource "google_artifact_registry_repository_iam_member" "orchestration_repository_member" {
  repository = google_artifact_registry_repository.custom_environments_repository.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.docker_registry_service_account.email}"
}

resource "google_service_account_key" "google_service_key" {
  service_account_id = google_service_account.docker_registry_service_account.id
}
```

3 个 GCP 资源：

1. **Service Account**——服务身份。
2. **IAM 授权**——给该 SA `artifactregistry.writer` 角色，覆盖整个 `custom_environments_repository`。
3. **Service Account Key**——导出为 JSON key 供容器内的反代使用（`consts.EncodedDockerCredentials`）。

> ⚠️ 这种"为服务账号导出 long-lived key"在 GCP 安全最佳实践里不推荐，更推荐 Workload Identity。本服务目前沿用 key 模式，是已知的历史选择。

### 11.2 Nomad Job（`iac/provider-gcp/nomad/jobs/docker-reverse-proxy.hcl`）

```hcl
job "docker-reverse-proxy" {
  type     = "service"
  priority = 85

  group "reverse-proxy" {
    restart { interval = "5s" attempts = 1 delay = "5s" mode = "delay" }
    network { port "${port_name}" { static = "${port_number}" } }

    service {
      name = "docker-reverse-proxy"
      port = "${port_name}"
      check {
        type = "http"  name = "health"
        path = "${health_check_path}"   # /health
        interval = "20s"  timeout = "5s"
        port = "${port_number}"
      }
    }

    task "start" {
      driver = "docker"
      resources { memory_max = 2048  memory = 512  cpu = 256 }
      env { %{ for k,v in job_env_vars ~} ${k} = "${v}" %{ endfor ~} }
      config {
        network_mode = "host"
        image = "${image_name}"
        ports = ["${port_name}"]
        args = ["--port", "${port_number}"]
      }
    }
  }
}
```

部署形态：
- **type=service**——长跑任务；priority=85 较低，让 Nomad 在资源紧张时优先驱逐。
- **restart 5s 间隔**——失败后等 5 秒重试（无限循环）。
- **网络 host 模式**——监听宿主机的 5000 端口，便于 GCP load balancer 接入。
- **健康检查**——每 20 秒 GET `/health`，超时 5 秒；不健康时从 service registry 摘除。
- **env 模板化**——`job_env_vars` 是模板变量，由上一层 Terraform module 注入。

### 11.3 Dockerfile

两阶段：
1. **builder**：`golang:1.26.3-alpine3.22`，分三个 `WORKDIR` 预先 `go mod download`（shared、db、docker-reverse-proxy），最大化缓存命中；然后 `make build` 出二进制。
2. **runtime**：`alpine:3.22` 只 COPY 二进制；最终镜像约 20 MB。

> `Dockerfile` 在仓库**根目录**构建（`docker buildx build ..`），因为要 COPY 上层的 `shared/`、`db/`。这也是为什么 `Makefile` 里 `docker buildx build` 的路径是 `..`。

## 12. 测试覆盖

| 文件 | 覆盖点 |
| --- | --- |
| `internal/auth/validate_test.go` | `TestValidate`（含 `setupValidateTest` setup）——测试 access token 哈希校验与模板授权查询 |
| 间接通过 `httputil.ReverseProxy` 测试 stdlib 行为（`ModifyResponse` 不易单测） | — |

`make test` 跑 `go test -race -v ./...`。**`internal/handlers/` 下没有单测**，因为 `Proxy` / `GetToken` 等都强依赖 `*httputil.ReverseProxy` 和 PostgreSQL，需要 testcontainers；目前测试覆盖偏薄，新功能改动要小心。

## 13. 完整请求流（时序图）

```
docker CLI            docker-reverse-proxy              PostgreSQL             GCP Artifact Registry
   │                         │                              │                          │
   │  GET /v2/token?scope=  │                              │                          │
   │  repository:e2b/...     │                              │                          │
   │  Authorization: Basic...│                              │                          │
   │ ──────────────────────► │                              │                          │
   │                         │ ExtractAccessToken           │                          │
   │                         │ ValidateAccessToken ──────► │ Read.GetUserIDFrom       │
   │                         │ ◄──── user_id (if valid) ─── │   AccessToken            │
   │                         │ Validate (template auth) ─► │ ExistsWaitingTemplate    │
   │                         │ ◄──────── true/false ────── │   Build                  │
   │                         │                              │                          │
   │                         │ GET /v2/token?scope=...      │                          │
   │                         │ Authorization: Basic <sa>    │                          │
   │                         │ ─────────────────────────────────────────────────────► │
   │                         │ ◄───────── {"token":"gcp_t","expires_in":N} ────────── │
   │                         │ AuthCache.Create(tpl, gcp_t)│                          │
   │                         │  ↳ 随机 e2bToken, Set(ttl=2h)│                          │
   │ ◄───── {"token":"<e2bToken>","expires_in":N} ────│                              │
   │                         │                              │                          │
   │  GET /v2/e2b/custom-envs│                              │                          │
   │  /<tpl>/manifests/latest│                              │                          │
   │  Authorization: Bearer  │                              │                          │
   │  <e2bToken>             │                              │                          │
   │ ──────────────────────► │                              │                          │
   │                         │ AuthCache.Get(e2bToken)     │                          │
   │                         │  ↳ {DockerToken, TemplateID} │                          │
   │                         │ Set Authorization: Bearer   │                          │
   │                         │  <gcpDockerToken>           │                          │
   │                         │ Path rewrite:                │                          │
   │                         │  /v2/e2b/custom-envs/...     │                          │
   │                         │  → /v2/<proj>/custom-envs/...│                          │
   │                         │ Check templateID 匹配        │                          │
   │                         │ ReverseProxy.ServeHTTP       │                          │
   │                         │ ─────────────────────────────────────────────────────► │
   │                         │ ◄───────── manifest.json ───────────────────────────────│
   │ ◄────── manifest.json ──│                              │                          │
```

## 14. 设计要点与权衡

1. **GCP 凭据托管在本服务**。SA key base64 编码后放在 env 变量；本服务替所有用户代为申请 GCP token。这把"权限最小化"问题收敛到一个地方（SA 只有 `artifactregistry.writer`），不需为每个用户开 GCP IAM。
2. **缓存粒度 = 单次会话**。`AuthCache` key 是 128 字节随机串（不是 E2B access token），TTL 2 小时；过期后 docker CLI 自动重走 `/v2/token` 流程，无需后台刷新。
3. **path 双重身份**：客户端看到的是 `/v2/e2b/custom-envs/<tpl>/...`，上游是 `/v2/<gcp_proj>/<repo>/<tpl>/...`。**双重身份既方便 E2B 模板命名空间，又避免暴露 GCP 项目结构**。
4. **POST /v2/token 故意 404**：明确告诉 docker CLI "不要用 OAuth flow"，迫使其走我们的 Token flow（GET + Basic Auth）。
5. **PATCH /artifacts-uploads/* 单独豁免**：GCP 上传分片的设计是 PATCH + 长随机 URL，不带 Authorization 头，**违反通用 token 校验模型**，必须打洞。
6. **`httputil.ReverseProxy` 而非自实现**：stdlib 提供 Director + ModifyResponse + 连接池 + 错误处理；自实现会重复造轮子且容易出 bug。
7. **memory_only cache + 多副本**：每个进程独立缓存（≈ 几 KB/entry），多副本无共享问题。代价：流量高峰时 GCP token 颁发会多一些，但 GCP 这边没限流、无成本。
8. **scope 校验前置**：所有需要数据库校验的逻辑都在 `GetToken` 一次性完成；后续 `/v2/*` 请求**只查内存缓存**，不碰 DB——这是性能与可扩展性的关键。
9. **templateID 二次校验**：cache 里的 `TemplateID` 与路径里的比对，**防止 e2bToken 在不同 template 间滥用**（虽然 cache key 不同已经防止了大部分，但这是 belt-and-suspenders）。
10. **错误码语义化**：401 给 token 缺失/失效，403 给 scope 不匹配/越权，400 给格式错误，404 给 `POST /v2/token`——与 Docker 协议对齐。
11. **HTTP/2 cleartext（h2c）**：docker 流量层（manifest 拉取、blob 上传）单请求体积大、并发连接多，HTTP/2 多路复用能省不少 TCP handshake。`httpserver.ConfigureH2C` 启用它。
12. **环境 fail-fast**：`CheckRequired` 启动时一次性校验 5 个 env，缺一即 `log.Fatal`——避免运行时出现 500。
13. **Service Account 而非 OAuth user flow**：统一用 SA JSON 替所有用户发请求，**简化了用户身份管理**（用户用 E2B token 即可），代价是失去用户级 GCP 审计。

## 15. 关键文件速查表

| 主题 | 文件 | 作用 |
| --- | --- | --- |
| 入口 / 路由 | `packages/docker-reverse-proxy/main.go` | 启动校验 + 单一 catch-all 路由 |
| 存储 | `packages/docker-reverse-proxy/internal/handlers/store.go` | `APIStore` 组合 DB / 缓存 / 反代 |
| 反代逻辑 | `packages/docker-reverse-proxy/internal/handlers/proxy.go` | 路径改写、scope 二次校验、token 注入 |
| Token 颁发 | `packages/docker-reverse-proxy/internal/handlers/token.go` | `/v2/token` 端点 + 调用 GCP |
| 登录验证 | `packages/docker-reverse-proxy/internal/handlers/login.go` | `/v2/` version-check 端点 |
| 健康检查 | `packages/docker-reverse-proxy/internal/handlers/health.go` | `/health` 200 OK |
| 认证 | `packages/docker-reverse-proxy/internal/auth/validate.go` | token 哈希校验 + scope 模板授权 |
| 缓存 | `packages/docker-reverse-proxy/internal/cache/auth.go` | `AuthCache` 包装 ttlcache |
| 启动校验 | `packages/docker-reverse-proxy/internal/constants/main.go` | 5 个 env 校验 + 路径常量 |
| 401 头 | `packages/docker-reverse-proxy/internal/utils/authorization.go` | `WWW-Authenticate` 头 + 401 状态 |
| 随机串 | `packages/docker-reverse-proxy/internal/utils/random.go` | `crypto/rand` + base64 |
| 日志截断 | `packages/docker-reverse-proxy/internal/utils/string.go` | `SubstringMax` |
| 部署 | `iac/provider-gcp/docker-reverse-proxy.tf` | SA + IAM + Key 3 资源 |
| 部署 | `iac/provider-gcp/nomad/jobs/docker-reverse-proxy.hcl` | Nomad service job |
| 镜像 | `packages/docker-reverse-proxy/Dockerfile` | 多阶段构建（golang:1.26 → alpine） |
