# 11. Docker Reverse Proxy

> ## ⛔ 本包已于 2026.30 整体删除
>
> **`packages/docker-reverse-proxy/` 当前不存在。** 2026.29 的 **19 个文件 → 2026.30 的 0 个文件**，删除发生在提交 `d153bbe9d1e2ccd5e087d7c1dece5b8974175b54`（Jakub Rojko，2026-08-06，subject：`chore(docker-reverse-proxy): remove deprecated service`）。
>
> ⚠️ **不要把它和 `iac/` 的退役混成一次删除。** `iac/` 整棵树（172 文件 → 0）是**一个月后**的另一个提交 `8a1c48884406b909f64c1239c808d0bc1cbf05bf`（Tomas Virgl，2026-09-09）删的；那个提交顺带带走了本包仅剩的两个部署文件（`iac/provider-gcp/docker-reverse-proxy.tf`、`iac/provider-gcp/nomad/jobs/docker-reverse-proxy.hcl`）。
>
> 本文档因此转为**历史档案**，描述的是 2026.29 及以前的实现。其中的源码路径、行号、配置项都已不存在，保留是为了理解 template build 的 registry push 链路当初如何收窄权限。
>
> **同时消失的：**
> - 根 `Makefile` 的 `build-and-upload` 聚合目标不再包含 `build-and-upload/docker-reverse-proxy`。
> - 它的部署描述 `iac/provider-gcp/docker-reverse-proxy.tf` 与 `iac/provider-gcp/nomad/jobs/docker-reverse-proxy.hcl` 随整个 `iac/` 目录一起删除（见 [10-iac.md](./10-iac.md)）。正文中一切 `iac/**` 链接**已失效**。
> - `docs/ARCHITECTURE.md` 在 2026.30 已把该服务从架构图和服务表中移除 —— 它不再是 E2B 拓扑的一个组件。
>
> **2026.30 没有等价的替代服务。** 2026.30 的 `docs/ARCHITECTURE.md` 里已经完全没有 `docker.<domain>`、registry 网关或镜像 push 的描述：LB 只列 `api.* | *.domain wildcard`，控制面服务表里只有 api / dashboard-api / client-proxy。本文描述的这条「受限 registry 网关」链路在 2026.30 的架构文档中没有对位物。
>
> ⚠️ 需要区分：2026.30 的 `docs/ARCHITECTURE.md` 确实新增了一个 `volume-content API (belt)`（`api.<domain>`，content token 鉴权），但它是**持久卷（`POST/GET /volumes`）文件内容的读写服务**，与镜像 push / Registry v2 协议无关，不能当作本包的替代者。它与本包唯一的共同点是「独立服务 + token 鉴权 + 由 api 签发凭据」这一模式。
>
> ---
>
> **本文档的结构：**
> - **§零** — 2026.30 删除清单（只有这节描述当前状态）
> - **§1 ~ §8** — **历史档案**，描述 2026.29 及之前的实现

---

## 零、2026.30 删除清单

`packages/docker-reverse-proxy/` 在 2026.29 的完整文件清单（19 个，全部在 2026.30 删除）：

| 类别 | 2026.29 路径 | 职责 |
| --- | --- | --- |
| 入口 | `main.go` | catch-all 路由、h2c server、AuthCache 清理 goroutine |
| 构建 | `Dockerfile`、`Makefile`、`go.mod`、`go.sum` | 独立 Go module，单独镜像 |
| 版本 | `CHANGELOG.md` | release-please 生成的版本记录 |
| 配置 | `internal/constants/main.go` | `CheckRequired()` 与 upload prefix 常量 |
| 授权 | `internal/auth/validate.go`、`internal/auth/validate_test.go` | access token 与 template build 授权查询 |
| 缓存 | `internal/cache/auth.go` | `AuthCache`：session token → GCP token + template ID，固定 2 小时 TTL |
| handler | `internal/handlers/store.go` | `APIStore`：业务 DB、auth DB、cache、上游 reverse proxy 的装配 |
| handler | `internal/handlers/token.go`、`internal/handlers/token_test.go` | Registry v2 challenge 与 GCP token 交换 |
| handler | `internal/handlers/proxy.go` | 路径白名单、template 绑定校验与 prefix 改写 |
| handler | `internal/handlers/login.go` | login 端点 |
| handler | `internal/handlers/health.go` | `/health`（只返回 200，不检查依赖） |
| 工具 | `internal/utils/authorization.go` | `WWW-Authenticate` challenge header |
| 工具 | `internal/utils/random.go`、`internal/utils/string.go` | session token 生成与字符串处理 |

2026.30 里既没有替代包，也没有 `docker-reverse-proxy` 的遗留引用 —— 在 tag `2026.30` 上 `git grep -l "iac/" 2026.30 -- '*.md' '*.yml' '*.yaml' 'Makefile'` 返回空，说明连部署侧的引用也一并清干净了。

---

## 1. 系统位置

> ⓘ **以下（§1 ~ §8）为历史档案**，描述 2026.29 及以前的实现。`packages/docker-reverse-proxy/**` 与 `iac/**` 路径在 2026.30 已不存在，链接已失效。

```text
Docker CLI / template build
          |
          | Registry v2 protocol
          v
docker-reverse-proxy :5000
    |             |
    | SQL auth    | short-lived token cache
    v             v
PostgreSQL     process memory
          \
           \ HTTPS + GCP service-account token
            v
     GCP Artifact Registry
```

- 它服务自定义模板镜像 push 流程，不参与 sandbox HTTP ingress。
- 对客户端呈现逻辑仓库 `e2b/custom-envs/<template>`，对上游改写成配置的 GCP project/repository。
- 它不构建镜像、不消费镜像，也不运行 template build。
- 它把高权限 service-account registry token 留在服务端，只给 Docker CLI 一个进程内 session token。

## 2. 启动/装配

入口 `packages/docker-reverse-proxy/main.go` 的步骤很短：

1. `constants.CheckRequired()` 校验 GCP project、domain、repository、service-account secret 与 region。
2. 解析 `--port`，默认监听 5000。
3. `handlers.NewStore` 从 `POSTGRES_CONNECTION_STRING` 创建业务 DB 与 auth DB client。
4. 启动 `AuthCache` 的 TTL 清理 goroutine。
5. 创建目标为 `<region>-docker.pkg.dev` 的 `httputil.ReverseProxy`。
6. 在单个 catch-all handler 中按 method/path 分派 health、token、login、upload 和普通代理请求。
7. 给 HTTP server 配置 h2c 后调用 `ListenAndServe`。

所有授权 session 都只存在当前进程内；重启或流量切到另一个无共享状态的副本后，Docker CLI 需要重新走 token challenge。

## 3. 核心机制与关键对象

### `APIStore`

`APIStore` 聚合四个依赖：业务 DB、auth DB、`AuthCache` 和到 Artifact Registry 的 reverse proxy。业务 DB 检查 template build 授权，auth DB 检查 access token 对应用户是否存在。

### 两类 token

名称相似但含义不同：

- E2B access token：Docker Basic Auth 的 password，username 必须是 `_e2b_access_token`。
- E2B registry session token：服务随机生成，Docker 后续以 Bearer 方式携带。
- GCP Docker token：服务用 service-account Basic 凭据向 Artifact Registry 申请，缓存于 session token 后面。

`AuthCache` 的 value 同时保存 GCP token 和被授权的 template ID，后续每次 manifest/blob 请求都可再次约束路径。

### Registry v2 challenge

无 `Authorization` 请求得到 401，并带：

```text
WWW-Authenticate: Bearer realm="https://docker.<domain>/v2/token"
Docker-Distribution-API-Version: registry/2.0
```

Docker CLI 据此自动调用 `GET /v2/token`。`POST /v2/token` 故意返回 404，因为该服务实现 token flow，不实现 OAuth endpoint。

### 路径守卫与改写

普通请求只允许两个前缀：逻辑 `/v2/e2b/custom-envs/` 和真实 GCP repository prefix。除上传中间路径外，请求中的 template ID 必须等于 cache 中绑定的 template ID，然后逻辑 prefix 才会被改写为真实 prefix。

## 4. 主请求或数据流

### 获取 registry session token

```text
Docker CLI
  -> GET /v2/                         无 Authorization
  <- 401 + Bearer realm
  -> GET /v2/token?scope=repository:e2b/custom-envs/<id>:push,pull
       Authorization: Basic base64(_e2b_access_token:<access-token>)
  -> ExtractAccessToken
  -> auth DB 验证 token
  -> business DB 验证 token 可访问 waiting template build
  -> 拒绝包含 delete 的 action
  -> GCP GET /v2/token，使用 service-account Basic credential
  <- GCP Docker token
  -> AuthCache.Create(templateID, GCP token)
  <- { token: <random session token>, expires_in: <upstream value> }
```

scope 必须完整匹配 `repository:e2b/custom-envs/<templateID>:<action>`；服务向 GCP 请求的权限固定为 `push,pull`。

### 代理镜像请求

```text
Authorization: Bearer <session token>
  -> AuthCache.Get
  -> 取出 templateID + GCP Docker token
  -> 校验允许的 repository prefix
  -> 校验 path templateID
  -> Authorization 改成 Bearer <GCP token>
  -> path 改成 /v2/<project>/<repository>/...
  -> Artifact Registry
```

GCP blob upload 返回的 Location 使用 `/artifacts-uploads/...` 长随机路径；后续 PATCH 没有 Authorization，因此 main handler 在进入通用鉴权前按精确前缀放行并直传上游。

## 5. 设计不变量与故障边界

- 用户永远不应看到 service-account secret 或 GCP Docker token；客户端只持有随机 session key。
- session token 与单个 template ID 绑定，不能用同一 token 访问另一个模板路径。
- delete action 在 token 申请阶段被拒绝，即使上游 service account 本身有更高权限。
- `AuthCache` TTL 固定为 2 小时；响应中的 `expires_in` 来自 GCP，两者不是由代码动态对齐的同一个值。
- 进程内 cache 不跨副本共享，缓存 miss 以标准 Docker 401 challenge 触发重新登录。
- PATCH artifact-upload 绕过 Authorization 的安全边界依赖 GCP 生成的不可预测 Location 和严格的 project/repository prefix。
- 其他 artifact-upload method 仍需 session token，并由 `Proxy` 注入上游 token。
- PostgreSQL 或 GCP token endpoint 故障会阻止新 session；已有 cache session 仍可代理，直到 cache 或上游 token 失效。
- `/health` 只返回 200，不检查 DB、cache 上游凭据或 Artifact Registry。
- 服务没有显式 graceful shutdown 与资源 close 编排；进程退出由部署系统处理。

## 6. 与其他组件边界

| 相邻组件 | docker-reverse-proxy 负责 | 对方负责 |
| --- | --- | --- |
| Docker CLI / builder | Registry challenge、session 与路径代理 | 构建 layer、执行 push、重试 token flow |
| auth DB | 校验 access token hash 对应用户 | 持久化用户凭据 |
| business DB | 查询 token 与 waiting template build 的关系 | 创建和推进 build 记录 |
| Artifact Registry | 换取 token、注入 token、改写路径 | 存储 blob/manifest 并签发 upload Location |
| template-manager | 无直接 runtime 调用 | 发起或承载模板构建流程 |
| client-proxy | 完全无数据面关系 | 代理运行中 sandbox 的用户流量 |

## 7. 源码阅读顺序

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | `packages/docker-reverse-proxy/main.go` | 看 catch-all 路由优先级和 PATCH 特例 |
| 2 | `packages/docker-reverse-proxy/internal/handlers/store.go` | 看 DB、cache 与上游 reverse proxy 装配 |
| 3 | `packages/docker-reverse-proxy/internal/handlers/token.go` | 看完整 challenge、scope 与 GCP token 交换 |
| 4 | `packages/docker-reverse-proxy/internal/auth/validate.go` | 看 access token 与 template build 授权查询 |
| 5 | `packages/docker-reverse-proxy/internal/cache/auth.go` | 看 session value 和固定 TTL |
| 6 | `packages/docker-reverse-proxy/internal/handlers/proxy.go` | 看路径白名单、template 绑定与改写 |
| 7 | `packages/docker-reverse-proxy/internal/utils/authorization.go` | 看 Registry v2 challenge header |
| 8 | `packages/docker-reverse-proxy/internal/constants/main.go` | 看启动必需配置和 upload prefix |

## 8. 相关深挖

- [Docker Reverse Proxy 原理详解](../docker-reverse-proxy.md)
- [Template Build 流程](../template-build-flow.md)
- [Template 模块详解](../template-module.md)
- [认证子系统详解](../auth-module.md)

---

> **文档版本**：已同步至 **2026.30**。§零 描述 2026.30 的删除状态；§1 ~ §8 为 2026.29 及以前的历史档案，其中 `packages/docker-reverse-proxy/**` 与 `iac/**` 路径均已失效。
