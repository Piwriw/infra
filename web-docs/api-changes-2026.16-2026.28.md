# API 层面变动总览：2026.16 → 2026.28

- **范围**：`2026.16`（2026-04-15）→ `2026.28`（2026-07-09）
- **统计**：范围内共 555 个提交；`packages/api/` 变更 198 文件、+14,618/-5,815 行
- **OpenAPI 主规范**（`spec/openapi.yml`）：+577/-153 行
- **OpenAPI Dashboard 规范**（`spec/openapi-dashboard.yml`）：+917/-53 行
- 涉及仓库：`packages/api/`、`packages/shared/pkg/auth/`、`spec/`、`packages/db/`

> 本文聚焦 **面向调用方的契约级变动**（认证、endpoint、schema、字段、错误码），并附带触发这些变动的关键提交号，方便回溯源码。

---

## 1. 认证体系重构（最高影响等级）

本轮迭代对认证做了三类清理：彻底移除 Supabase、引入可插拔 Auth Provider（含 OIDC）、对 Access Token 启动弃用流程。

### 1.1 Security Scheme 重命名

| 旧（2026.16） | 新（2026.28） | scheme 类型 | Header / 凭证 |
| --- | --- | --- | --- |
| `Supabase1TokenAuth` | `AuthProviderBearerAuth` | http bearer | `X-Supabase-Token` → OIDC bearer（认证 provider 改为 OIDC） |
| `Supabase2TeamAuth` | `AuthProviderTeamAuth` | apiKey | `X-Supabase-Team` → `X-Team-ID` |
| `AdminTokenAuth` | `AdminApiKeyAuth` | apiKey | `X-Admin-Token`（**header 名未变**，只是 scheme 重命名） |
| —（新增） | `AdminTeamAuth` | apiKey | `X-Team-ID`（与 `AuthProviderTeamAuth` 同 header） |

- 涉及所有 endpoint 的 `security:` 段全部重写。
- 命名约定：Bearer/ApiKey 字母序在前，确保 token 校验先于 team 上下文填充。
- **`X-Team-ID` header 是全新引入**（2026.16 用 `X-Supabase-Team`，2026.28 起 Supabase 移除、改用 `X-Team-ID`）。代码层面同时做了大小写规范化 `X-Team-Id` → `X-Team-ID`（#2723）；按 RFC 7230 HTTP header 名大小写不敏感，对绝大多数客户端无影响。
- 相关提交：#2673（OIDC Auth Provider）、#2720（整合 NewAuthService）、#2723（header 大小写规范化）、#2725/#2726/#2728（auth 包内聚）、#2934（admin token team auth）、#3042（删除 Supabase 残留）。

### 1.2 Access Token 弃用流程上线

Access Token（不是 API Key）开始进入弃用周期，全部由 LaunchDarkly 特性开关门控：

- **`POST /access-tokens`** 标记为 `deprecated: true`，描述中提示改用 `E2B_API_KEY`，新增 `410 Gone` 响应（#3084、#3101、#3110、#3240）。
- 新增 LD 开关链：
  - 控制 issuance（签发）：`feat(api): gate access token issuance behind feature flag`（#3101）
  - 控制改名：`feat(api): e2b access token deprecation feature flag rename`（#3110）
  - 控制接收：`feat(api): add feature flag to stop accepting E2B access tokens`（#3240）
- OpenAPI 中 `AccessTokenAuth` 增加 deprecated 说明：
  > **Deprecated.** Access token authentication is deprecated and will be removed in a future release. Use API key authentication (`X-API-Key`) instead.

### 1.3 用户字段弃用

- `User.email` 改为 `nullable: true` + `deprecated: true` + `default: null`（#2718）。
- 路由响应里所有 user email 字段进入弃用周期，调用方应改用 user-profile 子系统。

### 1.4 团队级访问控制

- 引入 `blocked-team` 概念并在所有 mutating endpoint 强制执行（#2757、#2659）。
- 新增 **Admin Team API Key** 路由（见 §2.1）。
- auth 层提供 `MustGetTeamID` helper（#2728）。

---

## 2. 新增 / 变更的 Endpoint

### 2.1 Admin Team API Key 管理（新增）

> 完全新增的两条路由，用于内部服务工作流以 admin 身份管理团队 API Key。

| Method | Path | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/admin/teams/{teamID}/api-keys` | `AdminApiKeyAuth` | 创建团队 API Key，body = `NewTeamAPIKey`，返回 `CreatedTeamAPIKey` |
| `DELETE` | `/admin/teams/{teamID}/api-keys/{apiKeyID}` | `AdminApiKeyAuth` | 删除团队 API Key |

- 响应码：`201` / `204` / `400` / `401` / `403` / `404` / `500`
- 相关提交：#2825 `feat(api): add admin team API key routes`，handlers 见 `packages/api/internal/handlers/admin_api_keys.go`。

### 2.2 模板列表分页 v2

- **新增 `GET /v2/templates`**（EN-603，#3059）：支持 `teamID`、`paginationNextToken`、`paginationLimit`，响应头返回 `X-Next-Token` 游标。
- 旧版 `GET /templates` 标记为 `deprecated: true`。
- 相关提交：#3059、#2983（templates list sorting）、#2916（修复 alias tag 在 exists 端点的检查）。

### 2.3 Snapshot 按名称过滤

- **`GET /snapshots`** 新增 `name` query 参数：
  > Filter snapshots by name or ID, optionally tag-qualified (e.g. `"my-snapshot"`, `"my-team/my-snapshot"` or `"my-snapshot:v1"`).
- 相关提交：#3184。

### 2.4 Nodes 列表支持 clusterID 过滤

- **`GET /nodes`** 新增可选 query `clusterID`（uuid），用于管理面按集群过滤节点。
- 同时把 `/nodes`、`/nodes/{nodeID}`、`/nodes/{nodeID}` (POST)、`/teams/{teamID}/sandboxes:kill`、`/teams/{teamID}/builds:cancel` 的鉴权从 `AdminTokenAuth` 切换为 `AdminApiKeyAuth`。
- 相关提交：#2641。

### 2.5 Sandbox Pause 支持 body

- **`POST /sandboxes/{sandboxID}/pause`** 的 `requestBody` 由必填变为可选，schema 引用新 `SandboxPauseRequest`（含 `memory` 字段，见 §3.2）。
- 修复 Content-Length 为 0 时的解析（#3056）。

### 2.6 Sandbox Resume 行为改进

- Resume 失败重试现在会 **pin 到上一次超时的节点**（#3066），避免再次选择坏节点。
- Resume 时会重新挂载 volumes（#2407）。

### 2.7 弃用标记（deprecated）

下列 endpoint 在 OpenAPI 中明确标记 `deprecated: true`：

| Endpoint | 备注 |
| --- | --- |
| `GET /sandboxes` | 改用 `GET /v2/sandboxes` |
| `GET /templates` | 改用 `GET /v2/templates` |
| `POST /templates` | 改用 `POST /v3/templates` |
| `POST /templates/{templateID}` | 旧 rebuild 入口 |
| `PATCH /templates/{templateID}` | 改用 `PATCH /v2/templates/{templateID}` |
| `POST /templates/{templateID}/builds/{buildID}` | 改用 v2 |
| `POST /access-tokens` | 整体弃用（见 §1.2） |
| `GET /sandboxes/{sandboxID}/logs` | 改用 v2 |
| `POST /sandboxes/{sandboxID}/resume` | 行为变更但保留兼容 |

---

## 3. Sandbox / 网络 / 节点 Schema 变化

### 3.1 网络配置：新增 SOCKS5 egress proxy 与 per-domain 规则

`PUT /sandboxes/{sandboxID}/network` 的 body 抽取为新 schema **`SandboxNetworkUpdateConfig`**，新增能力：

```yaml
SandboxNetworkUpdateConfig:
  properties:
    allowOut:        # 已有，CIDR/IP/域名
    denyOut:         # 已有，CIDR/IP
    egressProxy:     # 【新】SandboxEgressProxyConfig
    rules:           # 【新】per-domain 规则
    allow_internet_access:  # 【新】便捷开关
```

- **`SandboxEgressProxyConfig`**（#2642）：BYOP（Bring Your Own Proxy），支持 SOCKS5 outbound 隧道。
  - `address`（必填，`host:port`）
  - `username` / `password`（可选，RFC 1929，max 255 字节）
  - 域名匹配流量使用远端 DNS（`ATYP=domain`）。
- **`SandboxNetworkRule` + `SandboxNetworkTransform`**（#2748）：按域名注入/覆盖 HTTP headers。
  - 注意：列入 `rules` 不会自动 allow，仍需在 `allowOut` 显式放行。
- **`allow_internet_access`**（#2433）：布尔便捷开关；`false` 等价于 `denyOut: ["0.0.0.0/0"]`。

### 3.2 Sandbox 生命周期请求体抽取为命名 Schema

下列原本内联在 path 的请求体被抽到 `components/schemas/`，便于复用与 SDK 生成：

| Schema | 用于 | 字段要点 |
| --- | --- | --- |
| `SandboxTimeoutRequest` | `POST /sandboxes/{id}/timeout` | `timeout: int32, minimum: 0` |
| `SandboxRefreshRequest` | `POST /sandboxes/{id}/refreshes` | `duration: int, 0..3600` |
| `SandboxSnapshotRequest` | `POST /sandboxes/{id}/snapshots` | `name: string` |
| `SandboxPauseRequest` | `POST /sandboxes/{id}/pause` | **`memory: bool = true`**（见下） |

- **Filesystem-only snapshots**（#3055、#3027）：`SandboxPauseRequest.memory = false` 表示只持久化文件系统、丢弃内存；冷启动 resume 会 reboot；此类 snapshot 不能 auto-resume。
- `SandboxConfig` 同步新增 **`autoPauseMemory`**（默认 `true`）：当 `autoPause=true` 时控制自动 pause 的快照类型；`false` 不能与 `autoResume` 共存。

### 3.3 Node / MachineInfo 指标扩展

`MachineInfo` 新增 **hugepage 指标**（必填字段，#3182）：

```yaml
hugePagesTotal:       # uint64, 节点预分配 hugepage 总数
hugePagesUsed:        # uint64, 已用
hugePagesReserved:    # uint64, 已提交未 fault
hugePageSizeBytes:    # uint64, 单页字节数
```

`Node` 与 `NodeInfo` 新增 **`statusChangedAt: date-time`**（#2980，必填）：节点上次状态变更时间，用于排障与放置决策。

### 3.4 模板字段约束

- `TemplateCreate.name`、`alias`、`TemplateBuild.name` 添加 **`maxLength: 128`**（#3109）。
- 简化模板校验逻辑（#2961），模板上传 hashes 强制校验（#2952）。
- 无效 tag 错误现在返回 `400 Bad Request`（#2799）。

### 3.5 错误响应扩展

- 新增 **`410 Gone`** 标准响应组件（#3084），目前用于弃用的 access-tokens 路径。
- 多个 endpoint 补齐 `403` 响应（权限不足时返回，例如 `POST /v3/templates`）。

---

## 4. OpenAPI 规范质量提升

- **Summary 一致性 lint**：引入 `fe10b1d6b Add OpenAPI summary consistency linting`（#3074），随后给每个 endpoint 补齐 `summary` 字段——这是本轮 diff 中改动量巨大的主要原因之一（看起来很大但实际语义变更少）。
- **去冗余**：所有 `items: allOf: [$ref]` 简化为 `items: $ref`（如 `ListedSandbox`、`Template`、`Node`、`Team`）。
- **内联请求体抽取**：见 §3.2，5 个 schema 被命名化（#2837、#2748）。
- 升级 `getkin/kin-openapi` 到 v0.135.0 并重新生成（#2624）。

---

## 5. 服务发现 / 后端基础设施（影响 API 行为）

虽然不在 OpenAPI 中体现，但调用方可能感受到的行为变化：

| 主题 | 提交 | 行为 |
| --- | --- | --- |
| Pluggable service discovery | #2601 | 引入可插拔接口 |
| Kubernetes SD | #2602 | 新增 K8s 服务发现 |
| Nomad SD | #3176 | 通过 Nomad service 发现 orchestrator |
| Dummy orchestrator | #2744 | 本地 API 开发用假 orchestrator |
| Reservation waiters pub/sub | #2729 | 唤醒替代 20ms 轮询，降低延迟抖动 |
| Shared publish worker | #2668 | 替代 per-Release goroutine |
| Memory sandbox backends 移除 | #2750 | 只保留 Redis 后端 |
| LD-gated ClickHouse reader | #3061 | 读路径可切换 ClickHouse |
| Singleflight per sandbox | #2625 | 256 并发上限 + in-flight gauge |
| Soft-delete build layers | #3121 | 用户删除时软删除构建层 |
| Per-team events TTL | #3181 | tier + addons 控制事件保留 |
| Sandbox duration clamp | #3200 | 防止溢出 |
| uint64 underflow 修复 | #3216 | 节点已分配指标 |
| Sandbox stop time 损坏容错 | #3203 | 数据损坏时不再 panic |
| Eviction index 自愈 | #3199 | EN-1048 |
| Stale sandbox eviction | #2640 | 清理超过 `StaleCutoff` 的沙箱 |

---

## 6. Dashboard API（`spec/openapi-dashboard.yml`）变化概览

Dashboard 规范增长 +917/-53 行，本轮重点扩充了 **用户/团队管理面** 与 **模板标签体系**。

### 6.1 新增 endpoint（顶层路径）

| Path | 主题 |
| --- | --- |
| `/admin/teams/bootstrap` | 内部团队创建（#2824） |
| `/admin/users/{userId}` | 内部删除用户路由（#2986） |
| `/admin/user-profiles/by-email` | Ory/OIDC profile 查询 |
| `/admin/user-profiles/resolve` | profile 解析 |
| `/admin/user-profiles/{userId}` | profile 管理（#2743、#2840） |
| `/templates` | 列表（含分页 #2904、排序 #2983） |
| `/templates/{templateID}` | 模板管理 |
| `/templates/{templateID}/tags/count` | 标签统计（#2885） |
| `/templates/{templateID}/tags/exists` | 标签存在性 |
| `/templates/{templateID}/tags/groups` | 标签分组 |
| `/templates/{templateID}/tags/{tag}/assignments` | 标签分配管理 |

> 注：`/health` 在 diff 中显示为 `-/+`，是位置重排（添加 `summary` 字段），并非新增。

### 6.2 关键能力

- **OIDC Admin Bootstrap**：`feat(dashboard-api): add OIDC admin user bootstrap endpoint`（#2841）——首次启动可 bootstrap 管理员。
- **Ory profile provider**：`feat(dashboard-api): add Ory user profile provider and auth middleware fix`（#2840）。
- **Auth Profile Admin Routes**：`feat(dashboard-api): expose auth profile admin routes`（#2743）。
- **Build 资源**：`feat(dashboard-api): include build resources in /builds response`（#3009）——便于面板展示构建资源用量。
- **Signup metadata 透传**：`fix(dashboard-api): pass signup metadata to billing provisioning`（#2978）。
- **数据保留标记**：`feat(dashboard-api): flag sandboxes past data retention`（#3102）。

---

## 7. 升级影响清单（给调用方）

如果调用方要从 2026.16 升级到 2026.28，**必须**处理：

1. **Supabase token 移除**：原 `X-Supabase-Token` / `X-Supabase-Team` 全部失效，改用 API Key 或 OIDC Auth Provider Bearer + `X-Team-ID`。
2. **Access Token 进入弃用**：尽快迁移到 `E2B_API_KEY`，否则将来会收到 `410 Gone`。
3. **Admin 路由鉴权变更**：scheme 从 `AdminTokenAuth` 改为 `AdminApiKeyAuth`（header 名 `X-Admin-Token` 未变），管理面 mutating endpoint 还需配套 `X-Team-ID`。
4. **User email 字段**：准备 email 变 `null` 的兼容代码。

> 备注：HTTP header 名大小写不敏感（RFC 7230），代码层面的 `X-Team-Id` → `X-Team-ID`（#2723）只是 Go 解析侧规范化，对调用方无实际影响。

**可选但推荐**：

1. 网络 API：开始使用 `egressProxy`（SOCKS5 BYOP）、`rules`（per-domain header 注入）、`allow_internet_access` 便捷字段。
2. 模板列表：切换到 `GET /v2/templates` 以获得分页与游标。
3. 沙箱 pause：评估 filesystem-only snapshot（`memory=false` / `autoPauseMemory=false`）能否降低成本，注意不能与 autoResume 共存。
4. 节点面：消费 `statusChangedAt` 与 hugepage 指标。

---

## 8. 关键源码索引

| 主题 | 文件 |
| --- | --- |
| OpenAPI 主规范 | `spec/openapi.yml` |
| OpenAPI Dashboard 规范 | `spec/openapi-dashboard.yml` |
| Admin API Key handler | `packages/api/internal/handlers/admin_api_keys.go` |
| Sandbox pause | `packages/api/internal/handlers/sandbox_pause.go` |
| Sandbox network update | `packages/api/internal/handlers/sandbox_network_update.go` |
| Templates list v2 | `packages/api/internal/handlers/templates_list_v2.go` |
| Snapshot list (name filter) | `packages/api/internal/handlers/snapshot_template_list.go` |
| Auth service wiring | `packages/shared/pkg/auth/` |
| Service discovery | `packages/api/internal/servicediscovery/` |

---

## 9. 关键 PR 索引（按主题）

**认证**
- #2673 OIDC Auth Provider for API and dashboard API
- #2720 整合 `NewAuthService`
- #2723 `X-Team-Id` → `X-Team-ID`
- #2725 / #2726 / #2728 auth 包收口
- #2757 / #2659 blocked-team 强化
- #2825 admin team API key routes
- #2934 admin token team auth
- #3042 删除 Supabase 残留
- #3084 / #3101 / #3110 / #3240 access token 弃用开关链

**Sandbox 网络 / Pause / Snapshot**
- #2433 `allow_internet_access`
- #2642 SOCKS5 egress proxy (BYOP)
- #2748 抽取 `SandboxNetworkUpdateConfig`
- #2837 抽取内联请求体 schema
- #3027 / #3055 filesystem-only snapshots
- #3056 pause body Content-Length 修复
- #3066 resume 重试 pin 节点

**模板**
- #2799 invalid tag → 400
- #2916 alias tag exists 检查修复
- #2952 upload hashes 校验
- #2961 简化模板校验
- #3059 分页 `GET /v2/templates`
- #3109 名称 `maxLength: 128`

**节点 / 指标**
- #2641 `clusterID` 过滤
- #2980 `statusChangedAt`
- #3182 hugepage 指标

**OpenAPI 工程化**
- #2624 kin-openapi v0.135.0
- #2715 spec limitations 文档
- #3074 summary 一致性 lint

**API 内部基础设施**
- #2601 pluggable service-discovery 接口
- #2602 Kubernetes service discovery
- #2668 shared publish worker
- #2729 reservation pub/sub
- #2750 移除 memory sandbox backends
- #3061 LD-gated ClickHouse reader
- #3121 soft-delete build layers
- #3181 per-team events TTL
- #3199 eviction index 自愈（EN-1048）
- #3200 sandbox duration clamp
- #3216 uint64 underflow 修复
- #3176 Nomad service discovery
