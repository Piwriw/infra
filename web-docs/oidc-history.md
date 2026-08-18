# OIDC 认证演进历史与迁移升级方案

本文件汇总 E2B Infrastructure 仓库中所有与 OIDC（OpenID Connect）相关的提交，按时间顺序梳理设计决策、影响范围与行为变化，并在最后一章给出从旧版（Supabase HMAC JWT）到新版（多 issuer OIDC）的完整迁移升级方案。

> 数据来源：`git log --all -i --grep="oidc|openid|ory|auth_provider|user_identities|identity_lookup|wif"`
> 截止日期：2026-07-09（分支 `learn/brain`），共 17 个核心 PR(#2673 起按时间顺序)

---

## 目录

1. [背景与设计目标](#1-背景与设计目标)
2. [提交时间线一览](#2-提交时间线一览)
3. [提交详解](#3-提交详解)
4. [架构演进与影响面](#4-架构演进与影响面)
5. [迁移升级方案](#5-迁移升级方案)

---

## 1. 背景与设计目标

E2B 早期的 dashboard 与 API 服务使用 Supabase 颁发的 HMAC 签名 JWT 进行用户认证，验证逻辑硬编码在 `packages/auth/pkg/auth/jwt.go` 中，仅依赖 `SUPABASE_JWT_SECRETS` 共享密钥。

为支持自托管场景（self-host）以及多身份提供商（Ory Kratos/Hydra、Auth0、Okta、Keycloak 等），auth 包被重写为通用的 OIDC 验证器：

- 通过 OIDC Discovery Document 自动获取 JWKS 端点，密钥自动刷新。
- 用 `(oidc_iss, oidc_sub)` 二元组在新表 `public.user_identities` 中查表，映射到内部 `public.users.id`。
- 同时支持多个 issuer；旧的 Supabase HMAC 流程在 [#2673](https://github.com/e2b-dev/infra/pull/2673) 中作为 `legacy` 子策略短暂保留，[#3042](https://github.com/e2b-dev/infra/pull/3042) 已彻底删除，**当前主分支不再支持 HMAC 兼容路径**。
- 未配置时返回 `(nil, nil)`，使 JWT 路径统一 401，但 API Key / Access Token 仍可工作。

---

## 2. 提交时间线一览

| 时间 | Commit | PR | 标题 | 类型 |
|---|---|---|---|---|
| 2026-05-19 | `f27618a1b` | [#2673](https://github.com/e2b-dev/infra/pull/2673) | Add OIDC auth provider for API and dashboard API | feat / 破坏性 |
| 2026-05-19 | `b673a10cb` | [#2743](https://github.com/e2b-dev/infra/pull/2743) | feat(dashboard-api): expose auth profile admin routes（`GET/POST /admin/auth-provider-profiles/*`） | feat |
| 2026-05-19 | `d9e036f12` | [#2716](https://github.com/e2b-dev/infra/pull/2716) | feat(auth): allow unconfigured AUTH_PROVIDER_CONFIG | feat |
| 2026-05-24 | `3bed55329` | [#2812](https://github.com/e2b-dev/infra/pull/2812) | feat(auth): allow http OIDC issuer on loopback hosts | feat |
| 2026-05-25 | `dfd50e421` | [#2821](https://github.com/e2b-dev/infra/pull/2821) | chore(local-dev): make local dev seed OIDC identity configurable | chore |
| 2026-05-28 | `9599d5767` | [#2839](https://github.com/e2b-dev/infra/pull/2839) | refactor(auth): export Verifier type and NewVerifier constructor | refactor |
| 2026-05-29 | `30d40d22f` | [#2840](https://github.com/e2b-dev/infra/pull/2840) | feat(dashboard-api): add Ory user profile provider and auth middleware fix | feat / 关键 |
| 2026-05-29 | `8eea298f0` | [#2866](https://github.com/e2b-dev/infra/pull/2866) | chore(db): remove default RLS setup（含 user_identities 表） | chore / 修正 |
| 2026-06-01 | `6a7a59ee0` | [#2841](https://github.com/e2b-dev/infra/pull/2841) | feat(dashboard-api): add OIDC admin user bootstrap endpoint | feat |
| 2026-06-04 | `a7455d100` | [#2922](https://github.com/e2b-dev/infra/pull/2922) | refactor(dashboard-api): read Ory project API key from external secret | refactor |
| 2026-06-05 | `cb07c1717` | [#2940](https://github.com/e2b-dev/infra/pull/2940) | fix(dashboard-api): avoid repeated Ory bootstrap provisioning | fix |
| 2026-06-15 | `ecc1291ad` | [#2986](https://github.com/e2b-dev/infra/pull/2986) | feat(dashboard-api): add internal admin route for deleting a user | feat |
| 2026-06-18 | `ac79b1b97` | [#3042](https://github.com/e2b-dev/infra/pull/3042) | chore: remove Supabase auth references（删除 legacy HMAC verifier） | chore / 破坏性 |
| 2026-06-22 | `6c512329d` | [#3062](https://github.com/e2b-dev/infra/pull/3062) | feat(dashboard-api): populate Ory identity external_id on admin bootstrap | feat |
| 2026-06-29 | `00ad04b13` | [#3133](https://github.com/e2b-dev/infra/pull/3133) | fix(dashboard-api): set Ory external_id only after the bootstrap commit | fix / 关键 |
| 2026-07-01 | `61e16bf4b` | [#3167](https://github.com/e2b-dev/infra/pull/3167) | Rp reverse proxy（GitHub Actions → GCP Artifact Registry 的 WIF OIDC） | infra / 间接 |
| 2026-07-09 | `dbd098f9f` | [#3094](https://github.com/e2b-dev/infra/pull/3094) | feat(dashboard-api): map Ory SSO organizations to E2B teams（`teams.ory_organization_id` 字段，SSO 用户自动入组） | feat / 企业 SSO |

---

## 3. 提交详解

### 3.1 [#2673](https://github.com/e2b-dev/infra/pull/2673) — Add OIDC auth provider for API and dashboard API (2026-05-19)

**作者**：Tomas Virgl
**Commit**：`f27618a1b8528d271225689014ff361711744033`
**类型**：破坏性重写（带 legacy 兼容 shim）

#### 变更摘要

| 层 | 文件 / 目录 | 影响 |
|---|---|---|
| DB schema | `packages/db/migrations/20260515120000_create_user_identities_table.sql` | 新增 `public.user_identities (created_at, updated_at, oidc_iss, oidc_sub, user_id)`，PK `(oidc_iss, oidc_sub)`，FK → `public.users(id) ON DELETE CASCADE`；新建 `user_identities_user_id_idx`。**注**：初始版本启用了 RLS，[#2866](https://github.com/e2b-dev/infra/pull/2866) 已将该 `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` 行删除（仓库整体移除默认 RLS 策略） |
| sqlc 查询 | `packages/db/pkg/auth/sql_queries/user_identities/upsert_public_identity.sql` 等 | 新增 `GetUserIdentity`、`UpsertPublicIdentity` |
| 新建包 | `packages/auth/pkg/auth/oidc/` | `config.go`、`oidc.go`、`audience.go`、`testserver.go`：基于 OIDC discovery 的 `Verifier`，依赖 `MicahParks/keyfunc/v3` + `jwkset` 自动刷新 JWKS |
| 新建包 | `packages/auth/pkg/auth/legacy/` | HMAC-only `Verifier`，兼容旧 Supabase JWT 密钥，保留 16 字节最小长度校验。**整个包已被 [#3042](https://github.com/e2b-dev/infra/pull/3042) 删除** |
| 重写 | `packages/auth/pkg/auth/verifier.go` | 聚合 `Verifier`，遍历所有 strategy，返回第一个成功结果 |
| 删除 | `packages/auth/pkg/auth/jwt.go`、`jwt_test.go` | Supabase 专用 parser 整体删除 |
| 服务层 | `packages/auth/pkg/auth/service.go` | `AuthService` 不再持有原始 JWT secret；`ValidateSupabaseToken` → `ValidateAuthProviderToken`，并在结果为 `uuid.Nil` 时拒绝 |
| 适配器 | `packages/auth/pkg/auth/identity_lookup.go` | `NewAuthIdentityLookup` 将读写主库的 `*authqueries.Queries` 注入到 `oidc.IdentityLookup`，把 `pgx.ErrNoRows` 映射成 `oidc.ErrIdentityNotFound` |
| API 配置 | `packages/api/internal/cfg/model.go`、`main.go`、`handlers/store.go` | 删除 `SUPABASE_JWT_SECRETS`，改用 `AUTH_PROVIDER_CONFIG`（自定义 `env` 解析器解析 JSON） |
| Dashboard API | 同上 + `packages/dashboard-api/...` | 同步迁移到 `AUTH_PROVIDER_CONFIG` |
| OpenAPI | `spec/openapi.yml`、`spec/openapi-dashboard.yml`、`packages/*/internal/api/api.gen.go` | 新增 `AuthProviderBearerAuth`（Bearer）与 `AuthProviderTeamAuth`（`X-Team-ID`），与既有 Supabase scheme 并存。Header 大小写经 [#2723](https://github.com/e2b-dev/infra/pull/2723) 统一为 `X-Team-ID`（`packages/auth/pkg/auth/consts.go:HeaderTeamID`） |
| CORS / 中间件 | Gin CORS 头与 authenticator | 增加接受新 header |
| IaC | `iac/provider-gcp/`、`iac/provider-aws/`、`iac/modules/job-api/`、`iac/modules/job-dashboard-api/` | 引入 `auth_provider_config` 变量；既有 `supabase_jwt_secret` 默认值塞入 `legacy.hmac.secrets` 兼容老 token |

#### 行为变化

- API/dashboard-api 启动时不再要求 Supabase secret 必填。
- 验签顺序：OIDC → legacy HMAC；任意一项通过即放行。
- `(iss, sub)` 在 `public.user_identities` 没有对应行 → 401。
- `legacy.hmac.secrets` 留作旧客户端 token 的过渡期通道（**该通道在 [#3042](https://github.com/e2b-dev/infra/pull/3042) 中已彻底删除，参见 3.12**）。

#### 配置示例（仅历史参考，主分支已不支持 `legacy` 字段）

```json
{
  "jwt": [
    {
      "issuer": {
        "url": "https://issuer.example.com",
        "discoveryURL": "https://issuer.example.com/.well-known/openid-configuration",
        "audiences": ["dashboard-api"],
        "audienceMatchPolicy": "MatchAny"
      },
      "cacheDuration": "5m"
    }
  ],
  "legacy": {
    "hmac": { "secrets": ["legacy-supabase-secret"] }
  }
}
```

---

### 3.2 [#2716](https://github.com/e2b-dev/infra/pull/2716) — feat(auth): allow unconfigured AUTH_PROVIDER_CONFIG (2026-05-19)

**作者**：Tomas Virgl
**Commit**：`d9e036f128c2977e573bb950ba776b2b15e9d15b`
**类型**：可用性改进（非破坏性）

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `packages/auth/pkg/auth/verifier.go` | `NewVerifier` 当配置无 JWT issuer 且无 legacy 时返回 `(nil, nil)`；`Verifier.Verify` 保留 nil-receiver 守卫作为 defense-in-depth |
| `packages/auth/pkg/auth/service.go` | `ValidateAuthProviderToken` 在 verifier 为 nil 时短路返回 401 `Backend authentication failed` |
| `verifier_test.go`、`service_test.go` | 新增 `TestNewVerifier_DisabledConfigReturnsNil`、`TestAuthService_ValidateAuthProviderTokenNilVerifier` |

#### 行为变化

- 未配置 `AUTH_PROVIDER_CONFIG` 不再启动失败。
- 所有 JWT 路径（`AuthProviderBearer`、`AuthProviderTeam`）统一返回 401。
- API Key、Access Token 流程不受影响。

#### 影响面

允许 self-host 部署只使用 API Key，无需搭建 OIDC issuer；同时降低误配置导致服务启动失败的风险。

---

### 3.3 [#2812](https://github.com/e2b-dev/infra/pull/2812) — feat(auth): allow http OIDC issuer on loopback hosts (2026-05-24)

**作者**：Tomas Virgl
**Commit**：`3bed5532975af7c6563f23d56b14dca324e3d871`
**类型**：开发者体验改进

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `packages/auth/pkg/auth/oidc/oidc.go` | `validateURL` 对 issuer 与 discovery/JWKS URL 放宽：当 host 为 `localhost`、`127.0.0.0/8`、`::1` 时允许 `http://`；刻意不做 DNS 解析以避免 TOCTOU |
| `packages/auth/pkg/auth/oidc/config_test.go` | 新增覆盖 `localhost`、`127.0.0.1`、IPv6 loopback 的正向用例 |

#### 行为变化

- 本地开发可直接使用 `http://localhost:4444/`（自托管 Hydra/Ory）作为 OIDC issuer，无需 TLS 终结器。
- 与 Kubernetes apiserver 的 `--oidc-issuer-url` loopback 豁免策略一致。
- 非回环地址仍强制 HTTPS。

---

### 3.4 [#2821](https://github.com/e2b-dev/infra/pull/2821) — chore(local-dev): make local dev seed OIDC identity configurable (2026-05-25)

**作者**：Tomas Virgl
**Commit**：`dfd50e421e02ac7d790dd58cd95ee954be1b1954`
**类型**：本地开发辅助

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `packages/local-dev/seed-local-database.go` | 新增 `OIDC_ISSUER` / `OIDC_SUBJECT` 环境变量；默认值 `http://localhost:4444/` 与 `local-dev-user`；调用 `upsertUserIdentity` 写入 `(oidc_iss, oidc_sub)` 行 |

#### 行为变化

- 本地开发者可指向任意 issuer / subject 来 seed 测试身分。
- 与 [#2812](https://github.com/e2b-dev/infra/pull/2812) 配合，构成完整的本地 OIDC 流程。

---

### 3.5 [#2839](https://github.com/e2b-dev/infra/pull/2839) — refactor(auth): export Verifier type and NewVerifier constructor (2026-05-28)

**作者**：Tomas Virgl
**Commit**：`9599d5767b557f787c32953d360fbc49e54b5cee`
**类型**：API 暴露面调整（非破坏性）

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `packages/auth/pkg/auth/verifier.go` | `verifier` → `Verifier`，`newVerifier` → `NewVerifier`，导出给外部包使用 |
| `packages/auth/pkg/auth/service.go`、`verifier_test.go` | 配合更名 |

#### 行为变化

- dashboard-api 等外部包可直接持有 `*auth.Verifier` 引用，便于后续 [#2840](https://github.com/e2b-dev/infra/pull/2840) 在 dashboard 侧引入 Ory profile provider 时复用。

---

### 3.6 [#2840](https://github.com/e2b-dev/infra/pull/2840) — feat(dashboard-api): add Ory user profile provider and auth middleware fix (2026-05-29)

**作者**：Ben Fornefeld
**Commit**：`30d40d22fb3dcff8654d687f0c40c7e9639483a2`
**类型**：关键功能（Ory 正式接入）

#### 变更摘要（节选）

| 文件 | 影响 |
|---|---|
| `packages/dashboard-api/internal/userprofile/ory.go` | **新建** Ory Kratos 项目 API 客户端（当前主分支 419 行；PR #2840 初版约 275 行，后续 PR 增长）：通过 `ORY_PROJECT_API_TOKEN` 调用 Ory Admin API 拉取 identities |
| `packages/dashboard-api/internal/userprofile/dual.go`、`mode.go` | 双 provider 模式：`SupabaseMode` / `OryMode` 运行时切换 |
| `packages/dashboard-api/internal/userprofile/providers.go` | 统一构造入口 |
| `packages/dashboard-api/internal/cfg/model.go` | 增加 `ORY_PROJECT_API_TOKEN`、profile mode 等配置 |
| `packages/auth/pkg/auth/middleware.go` | 修复中间件在缺失 verifier 时的 panic |
| `packages/db/pkg/auth/sql_queries/user_identities/get_user_identities_by_subjects.sql`、`get_user_identities_by_user_ids.sql` | 新增批量查询（按 subjects / 按 user_ids） |
| `spec/openapi-dashboard.yml` | 新增管理 profile 相关字段 |
| IaC | `iac/provider-gcp/init/secrets.tf` 新增 `ory-project-api-token` secret 占位 |
| 测试 | `dual_test.go`、`ory_test.go`、`supabase_test.go` 新增约 430 行 |

#### 行为变化

- dashboard-api 首次具备「Ory 模式」运行能力：用户登录后从 Ory拉取 profile，匹配 `public.user_identities` 行得到 `public.users.id`。
- `Provider` 接口正式确立，[#2841](https://github.com/e2b-dev/infra/pull/2841)、[#3062](https://github.com/e2b-dev/infra/pull/3062)、[#2986](https://github.com/e2b-dev/infra/pull/2986) 都在该接口上加方法。
- 是 dashboard 前端 OIDC 登录链路的底层依赖。

---

### 3.7 [#2866](https://github.com/e2b-dev/infra/pull/2866) — chore(db): remove default RLS setup (2026-05-29)

**作者**：Jakub Dobry
**Commit**：`8eea298f0b2c5bb3c09649f8eaa2afc09c4ec44b`
**类型**：DB 策略调整（影响 `user_identities` 表）

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `packages/db/migrations/20260515120000_create_user_identities_table.sql` | 删除 `ALTER TABLE public.user_identities ENABLE ROW LEVEL SECURITY;` |
| `scripts/remove-row-level-security.sql` | 新增脚本批量清理历史 RLS |
| 其他 14 个历史迁移 | 同步删除 `ENABLE ROW LEVEL SECURITY` 行（不影响已 apply 的库，仅影响新部署） |

#### 行为变化

- `public.user_identities` 不再启用 RLS，与仓库整体策略一致（RLS 由应用层负责）。
- **修正本文件旧版本中关于「RLS 启用」的描述**：当前表已无 RLS。

---

### 3.8 [#2841](https://github.com/e2b-dev/infra/pull/2841) — feat(dashboard-api): add OIDC admin user bootstrap endpoint (2026-06-01)

**作者**：Ben Fornefeld
**Commit**：`6a7a59ee031b7e3ef507679293fc5f5cb09c83b2`
**类型**：新功能（依赖 #2840 的 Ory profile provider）

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `spec/openapi-dashboard.yml` | 新增 `POST /admin/users/bootstrap`（admin token 鉴权）：body 含 `issuer, subject, email, name?` |
| `packages/dashboard-api/internal/api/api.gen.go` | oapi-codegen 再生成 |
| `packages/dashboard-api/internal/handlers/admin_users_bootstrap.go` | 新 handler，校验 issuer 白名单后 upsert `public.users` 与 `public.user_identities`，再创建默认 team |
| `packages/dashboard-api/internal/handlers/utils_team_provisioning.go` | 提取 `bootstrapUserWithIdentity` 等复用逻辑 |
| `packages/db/pkg/auth/sql_queries/user_identities/upsert_public_identity.sql` + 生成代码 | 调整 upsert 字段顺序，配合 bootstrap 流程 |
| `packages/auth/pkg/auth/identity_lookup.go`、`service.go` | 配合调整接口签名 |
| `packages/dashboard-api/internal/api/route_conflict_test.go` | 新增路由冲突回归测试：`/admin/users/bootstrap` 与 `/admin/users/{userId}/bootstrap` 不可冲突 |
| `packages/dashboard-api/internal/handlers/team_handlers_test.go` | +374 行测试覆盖 |

#### 行为变化

- 管理员可用 admin token 通过该端点预先创建 OIDC 用户，避免首次登录时 dashboard 报错。
- issuer 必须在 dashboard 端 Ory profile resolver 的白名单中。
- 配套 dashboard 前端 PR #342。

---

### 3.9 [#2922](https://github.com/e2b-dev/infra/pull/2922) — refactor(dashboard-api): read Ory project API key from external secret (2026-06-04)

**作者**：Ben Fornefeld
**Commit**：`a7455d100d0bc73834b167a5df2ff8328841d90b`
**类型**：基础设施重构

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `iac/provider-gcp/init/secrets.tf` | 删除 `${prefix}ory-project-api-token` 占位 secret；新增 `${prefix}ory-project-api-key` presence lookup（由独立 Ory Terraform 维护） |
| `iac/provider-gcp/dashboard-api.tf` | 注入 `ORY_PROJECT_API_TOKEN` env var |
| `packages/dashboard-api/internal/cfg/model.go`、`main.go` | 解析 `ORY_PROJECT_API_TOKEN`；config 解析失败时记录非敏感诊断 |

#### 行为变化

- Ory API token 不再由本仓库维护，转由独立 Ory Terraform stack 注入。
- 部署侧需要确保 `${prefix}ory-project-api-key` 在 GCP Secret Manager 中存在；缺失时 dashboard-api 不会启动失败，但所有 Ory API 调用会失败。

---

### 3.10 [#2940](https://github.com/e2b-dev/infra/pull/2940) — fix(dashboard-api): avoid repeated Ory bootstrap provisioning (2026-06-05)

**作者**：Ben Fornefeld
**Commit**：`cb07c171763d458570a9319edc482d275c428232`
**类型**：bug 修复

#### 缺陷描述

dashboard 前端在登录后短时间内可能多次触发 bootstrap 请求，导致同一用户被重复创建默认 team。

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `packages/dashboard-api/internal/handlers/utils_team_provisioning.go` | 若 default team 创建时间在 30 秒内，复用现有 team；超过 30 秒才认为是新的 provisioning 事件 |

#### 行为变化

- Ory bootstrap 在并发或重试场景下幂等。
- 是 [#3133](https://github.com/e2b-dev/infra/pull/3133) 修复路径之前的早期防御层。

---

### 3.11 [#2986](https://github.com/e2b-dev/infra/pull/2986) — feat(dashboard-api): add internal admin route for deleting a user (2026-06-15)

**作者**：devin-ai-integration[bot] + Ben Fornefeld
**Commit**：`ecc1291ad52bc35831735f704c0c88d3e0fbd2f7`
**类型**：新功能（admin）

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `spec/openapi-dashboard.yml` | 新增 `DELETE /admin/users/{userId}` |
| `packages/dashboard-api/internal/handlers/admin_users_delete.go` | 新 handler，两阶段删除：先 `PrepareDeleteUser` 解析 `user_identities.oidc_sub`，再删 `public.users`（FK cascade 清理 `user_identities`），最后 `DeleteUserHandle.Execute` 调用 Ory Admin SDK `DeleteIdentity` |
| `packages/dashboard-api/internal/userprofile/provider.go` | `Provider` 接口新增 `PrepareDeleteUser(ctx, userID) (DeleteUserHandle, error)`；新接口 `DeleteUserHandle.Execute(ctx)`（**注**：commit message 把它简化为 `DeleteUser`，实际是两阶段模式，确保 DB 行先被删除后才调 Ory） |
| `packages/dashboard-api/internal/userprofile/ory.go` | Ory 实现：`PrepareDeleteUser` 用 `GetUserIdentitiesByUserIDs` 查 `oidc_sub`；`Execute` 调 `IdentityAPI.DeleteIdentity` |
| `packages/dashboard-api/internal/userprofile/supabase.go` | 返回 `"not supported in supabase mode"`（Supabase 实现随后被 [#3042](https://github.com/e2b-dev/infra/pull/3042) 整体删除） |

#### 行为变化

- 仅供 Ory 部署使用，Supabase 模式显式不支持。
- 与 [#2841](https://github.com/e2b-dev/infra/pull/2841) 的 bootstrap 形成完整的用户生命周期管理。

---

### 3.12 [#3042](https://github.com/e2b-dev/infra/pull/3042) — chore: remove Supabase auth references (2026-06-18)

**作者**：Ben Fornefeld
**Commit**：`ac79b1b97a51138da66b97b22b3fc6403491562a`
**类型**：破坏性清理（迁移终点）

#### 变更摘要

| 范围 | 影响 |
|---|---|
| `packages/auth/pkg/auth/legacy/` | **整个包删除**（`config.go`、`legacy.go`、`legacy_test.go`）。HMAC 兼容路径彻底消失 |
| `packages/auth/pkg/auth/verifier.go` | `ProviderConfig` 移除 `Legacy` 字段；`NewVerifier` 不再处理 HMAC strategy |
| `packages/auth/pkg/auth/middleware.go` | 删除 Supabase bearer middleware |
| `packages/auth/pkg/auth/consts.go` | 删除 Supabase 相关常量 |
| `packages/db/pkg/supabase/` | **整个包删除**（`client.go`、`queries/`、`schema/`、`sql_queries/`） |
| `packages/db/sqlc.yaml` | 删除 supabase 配置 |
| `packages/dashboard-api/internal/userprofile/supabase.go`、`supabase_test.go`、`mode.go`、`creator_context.go` | 删除 Supabase provider 与「双模式」开关；profile 解析变为 Ory-only。**注**：`creator_context.go` 后在 2026-07-02 的 `a160ab26f`（"rename userprofile package to identity"）中被重新引入,当前主分支仍存在于 `packages/dashboard-api/internal/userprofile/creator_context.go` |
| `spec/openapi.yml`、`spec/openapi-dashboard.yml` | 删除 `SupabaseTokenAuth` 等 scheme；删除相关 header |
| `packages/api/internal/api/api.gen.go`、`packages/dashboard-api/internal/api/api.gen.go` | oapi-codegen 再生成（净删除 ~800 行） |
| IaC | `iac/provider-gcp/`、`iac/provider-aws/init/secrets.tf` 删除 `supabase_jwt_secret`、`supabase_*` 相关 secret |
| `self-host.md`、`CLAUDE.md` | 文档更新 |
| `tests/integration/` | 移除 Supabase 客户端 import |

#### 行为变化（关键）

- `AUTH_PROVIDER_CONFIG.legacy.hmac.secrets` 字段不再被解析；旧 Supabase JWT 全部失效。
- 部署若仍依赖 Supabase token，**必须在升级到此 commit 之前完成用户迁移**。
- 配置 schema 简化为 `{ "jwt": [...] }`。
- 这是 OIDC 迁移的终点，本 commit 之后无任何 Supabase 残留。

---

### 3.13 [#3062](https://github.com/e2b-dev/infra/pull/3062) — feat(dashboard-api): populate Ory identity external_id on admin bootstrap (2026-06-22)

**作者**：Ben Fornefeld
**Commit**：`6c512329de91c3e8a3b49be8d9f72e61d794fcee`
**类型**：功能完善

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `packages/dashboard-api/internal/userprofile/provider.go` | `Provider` 接口新增 `SetIdentityExternalID(ctx, subject, externalID)` |
| `packages/dashboard-api/internal/userprofile/ory.go` | 通过 Ory `PatchIdentity` 实现。**注**：#3062 commit message 写的是 "JSON patch `replace /external_id`"，但实际代码从一开始就用 `Op: "add"`（代码注释解释：因为 Ory 对未设置的 `external_id` 用 omitempty 序列化，`replace` 会因路径不存在而失败，`add` 同时支持创建和替换，从而幂等） |
| `packages/dashboard-api/internal/handlers/utils_team_provisioning.go` | `bootstrapUserWithIdentity` 在每次 commit 之后调用 setter（新建 team 与已有 team 两条路径都调用），仅 OIDC bootstrap 触发；Ory 更新失败则 bootstrap 整体失败 |

#### 行为变化

- Ory identity 的 `external_id` 字段写入 `public.users.id` UUID，让 dashboard 能将 Ory 会话与内部用户对齐。
- 此 PR 在 [#3133](https://github.com/e2b-dev/infra/pull/3133) 中被发现有时序 bug，需要回填修复。

---

### 3.14 [#3133](https://github.com/e2b-dev/infra/pull/3133) — fix(dashboard-api): set Ory external_id only after the bootstrap commit (2026-06-29)

**作者**：Alex Drankou
**Commit**：`00ad04b13d60e97e1908829aa9cba77952517d77`
**类型**：bug 修复（关键）

#### 缺陷描述

[#3062](https://github.com/e2b-dev/infra/pull/3062) 把 `setOIDCIdentityExternalID` 放在了 `tx.Commit()` 之前。如果 commit（或 commit 之后任何步骤）失败，PostgreSQL 回滚，但 Ory 已经写入了 `external_id`。dashboard 把 `external_id` 存在视为「完全 provisioned」，于是出现：用户拥有合法的 Ory 会话，但 `public.users` / team 不存在，且重新登录不会触发 bootstrap（Ory 端看起来已完成），用户永久处于悬空状态。

#### 变更摘要

| 文件 | 影响 |
|---|---|
| `packages/dashboard-api/internal/handlers/utils_team_provisioning.go` | 将 `setOIDCIdentityExternalID` 移到 `tx.Commit()` 之后，**两条路径都调用**：新建 team 路径 + 已有 team 路径（恢复路径，让上次失败的用户重新走 bootstrap 时被幂等修复） |
| `packages/dashboard-api/internal/handlers/team_handlers_test.go` | +122 行覆盖 commit 失败回滚 + Ory 未写入的场景 |

#### 关键设计点

- 使用 RFC 6902 `add` 操作（而非 `replace`），所以重复调用是安全的 no-op-equivalent。
- 修复后 `external_id` 的写入与 DB 提交保持「先 DB 后 Ory」的顺序，崩溃时 Ory 永远不会比 DB 更「新」。

---

### 3.15 [#3167](https://github.com/e2b-dev/infra/pull/3167) — Rp reverse proxy (2026-07-01，间接相关)

**作者**：Charlie Wyse
**Commit**：`61e16bf4b9df5b93ac7d607c949d09175625f5bc`
**类型**：发布基础设施

#### 为什么出现在 OIDC 列表里

该 PR 为 `packages/docker-reverse-proxy` 接入 release-please + 版本化镜像发布。其中提到：发布任务需要「在 `e2b-artifacts` GCP 项目里创建 service account + **OIDC connector**」并设置 GitHub repo 变量 `E2B_ARTIFACTS_WIF_PROVIDER` / `E2B_ARTIFACTS_PUBLISH_SA`，用于 GitHub Actions 通过 Workload Identity Federation（WIF）推送镜像。

这是 GCP 与 GitHub 之间的 OIDC WIF，与终端用户认证无关，但同样是 OIDC 协议的应用，故列入。

#### 变更摘要（仅列 OIDC 相关部分）

- `.github/workflows/release-please.yml`：发布任务以 WIF 方式登录 GCP（具体 WIF provider 配置在独立 Terraform 中）。
- `.env.gcp.template` / `.env.aws.template`：新增可选 `REVERSE_PROXY_VERSION`（与 OIDC 无直接关系）。
- `packages/docker-reverse-proxy/Makefile`、`main.go`、`Dockerfile`：发布流程改造。

---

### 3.16 [#3094](https://github.com/e2b-dev/infra/pull/3094) — feat(dashboard-api): map Ory SSO organizations to E2B teams (2026-07-09)

**作者**：Ben Fornefeld
**Commit**：`dbd098f9ff026956a85eb0efb099eb41c7552911`
**类型**：企业 SSO 接入（Ory 组织 → E2B team 自动映射）

#### 变更摘要

| 文件 | 影响 |
|---|---|
| DB schema | `teams.ory_organization_id`(nullable,**非唯一** — 一个 Ory 组织可映射到多个 team) |
| `packages/dashboard-api/internal/handlers/utils_team_provisioning.go` | bootstrap 时读取 Ory Kratos 的 `identity.organization_id`,把用户入组到该 org 映射的 team 而非创建个人 team |
| 业务约束 | SSO 用户被禁止改动 team 成员资格 |

#### 行为变化

- 企业用户首次通过 SSO 登录时,自动入组到管理员预先配置的 org→team 映射。
- Ory Kratos 是组织 ID 的权威来源(无 JWT/claim 改造),避免 dashboard 自己实现 SSO claim 解析。

---

## 4. 架构演进与影响面

### 4.1 数据库层

| 时间 | 表 / 列 | 动作 |
|---|---|---|
| 2026-05-19 (`f27618a1b`) | `public.user_identities(oidc_iss, oidc_sub, user_id, created_at, updated_at)` | 新建；PK `(oidc_iss, oidc_sub)`；FK → `public.users(id) ON DELETE CASCADE`；额外索引 `user_identities_user_id_idx`；初始启用 RLS |
| 2026-05-29 (`8eea298f0`) | `public.user_identities` | 移除 RLS（仓库整体清理） |

迁移文件：`packages/db/migrations/20260515120000_create_user_identities_table.sql`
必须先于 auth 服务升级之前应用。

### 4.2 配置层

| 旧 | 新 | 备注 |
|---|---|---|
| `SUPABASE_JWT_SECRETS` (逗号分隔列表) | `AUTH_PROVIDER_CONFIG` (JSON) | [#2673](https://github.com/e2b-dev/infra/pull/2673) 起旧 secret 自动映射到 `legacy.hmac.secrets`；[#3042](https://github.com/e2b-dev/infra/pull/3042) 已删除该字段，当前**仅支持 `jwt[]`** |
| 单一 Supabase issuer | `jwt[]` 数组，支持多 issuer | 每 issuer 独立 cache duration、audience 策略 |
| 无 | `OIDC_ISSUER` / `OIDC_SUBJECT` (local-dev) | seed 脚本可配置 |
| 无 | `ORY_PROJECT_API_TOKEN` (dashboard-api) | [#2840](https://github.com/e2b-dev/infra/pull/2840) 引入，[#2922](https://github.com/e2b-dev/infra/pull/2922) 改为由独立 Ory Terraform 维护的 GCP secret |

`AUTH_PROVIDER_CONFIG` 通过自定义 `env.UnmarshalFunc` 解析；在 Nomad jobspec 中以 `replace(jsonencode(...), "\"", "\\\"")` 转义双引号后注入。

### 4.3 代码包结构（当前主分支状态）

```
packages/auth/pkg/auth/
├── oidc/                # 基于 discovery 的 JWT 验证
│   ├── config.go        # Config / Issuer / AudienceMatchPolicy
│   ├── oidc.go          # Verifier + validateURL (含 loopback 豁免)
│   ├── audience.go      # MatchAny / MatchAll
│   └── testserver.go    # 测试用 OIDC server
├── identity_lookup.go   # authqueries → oidc.IdentityLookup 适配
├── verifier.go          # 聚合 strategy（[#3042] 后只剩 OIDC strategy）
├── service.go           # ValidateAuthProviderToken
└── middleware.go        # Gin authenticator（[#3042] 删除 Supabase middleware）

# 已删除：
# - jwt.go             ([#2673] 删除)
# - legacy/            ([#3042] 删除)
```

### 4.4 OpenAPI / 鉴权 scheme（当前主分支状态）

| Scheme | Header | 说明 |
|---|---|---|
| `ApiKeyAuth` | `X-API-Key` | 不变 |
| `AccessTokenAuth` | `Authorization: Bearer e2b_at_…` | 不变 |
| `AuthProviderBearerAuth` | `Authorization: Bearer …`（OIDC JWT） | [#2673](https://github.com/e2b-dev/infra/pull/2673) 引入。**注**：#2673 commit message 写的是 `AuthProviderTokenAuth`,但实际 spec / 生成代码从一开始就是 `AuthProviderBearerAuth`(spec/openapi.yml:25 有注释说明 "B before T" 命名约定) |
| `AuthProviderTeamAuth` | `X-Team-ID` | [#2673](https://github.com/e2b-dev/infra/pull/2673) 引入；[#2723](https://github.com/e2b-dev/infra/pull/2723) 大小写统一 |
| ~~`SupabaseTokenAuth`~~ | ~~`Authorization: Bearer …`~~ | [#3042](https://github.com/e2b-dev/infra/pull/3042) 删除 |

### 4.5 Dashboard API 路由

| 时间 | 路由 | 说明 |
|---|---|---|
| 2026-05-19 (`b673a10cb`, [#2743](https://github.com/e2b-dev/infra/pull/2743)) | `GET/POST /admin/auth-provider-profiles/*` | 管理 OIDC profile 元数据（白名单 issuer、display name 等）。该 PR 是 #2673 同日接入的配套管理后台路由 |
| 2026-06-01 (`6a7a59ee0`) | `POST /admin/users/bootstrap` | OIDC 用户预置 |
| 2026-06-15 (`ecc1291ad`) | `DELETE /admin/users/{userId}` | 删除用户（Ory 模式） |

### 4.6 IaC 层

- `iac/provider-gcp/main.tf`：`local.default_auth_provider_config`（第 63 行）默认 `{ jwt = [] }`；`local.auth_provider_config`（第 71 行）是条件表达式,`var.auth_provider_config != null ? jsondecode(jsonencode(var.auth_provider_config)) : local.default_auth_provider_config`；最终在 `AUTH_PROVIDER_CONFIG` env（第 85 行）注入并供 `dashboard-api.tf` 等下游消费。
- `iac/provider-gcp/dashboard-api.tf`：dashboard-api job 注入 `AUTH_PROVIDER_CONFIG` 与 `ORY_PROJECT_API_TOKEN`。
- `iac/provider-gcp/variables.tf`：`auth_provider_config` 变量定义在第 225 行。
- `iac/provider-gcp/init/secrets.tf`：[#2922](https://github.com/e2b-dev/infra/pull/2922) 后只保留 `${prefix}ory-project-api-key` presence lookup，旧 `ory-project-api-token` 占位与所有 `supabase_*` secret 已删除。
- `iac/provider-aws/main.tf`：AWS 端对称实现。
- `iac/modules/job-api/`、`iac/modules/job-dashboard-api/`：变量从 `supabase_jwt_secret` 重命名为 `auth_provider_config`。

---

## 5. 迁移升级方案

本章面向两类读者：

- **现有 self-host 部署**：当前使用 `SUPABASE_JWT_SECRETS`，需要升级到 OIDC。
- **新部署**：直接部署最新代码，需要从零配置 OIDC。

### 5.0 关键前置事实

> **重要**：主分支当前已无 legacy HMAC 兼容路径（[#3042](https://github.com/e2b-dev/infra/pull/3042) 删除）。
>
> - 旧版（[#2673](https://github.com/e2b-dev/infra/pull/2673) ~ [#2986](https://github.com/e2b-dev/infra/pull/2986) 之间）曾支持 `AUTH_PROVIDER_CONFIG.legacy.hmac.secrets` 用于双轨过渡。
> - 升级到 [#3042](https://github.com/e2b-dev/infra/pull/3042) 之后的代码必须确保所有 Supabase 用户已迁移完毕。
> - 5.2 节的「模式 B」仅适用于停留在过渡期 commit 的部署；主分支部署请直接用「模式 A」或「模式 C」。

### 5.1 前置检查

1. 确认目标 commit 包含本文件列出的全部 15 个 PR（或至少停在 [#2673](https://github.com/e2b-dev/infra/pull/2673) ~ [#2986](https://github.com/e2b-dev/infra/pull/2986) 之间以保留 legacy）。
2. 准备一个 OIDC issuer（Ory Kratos/Hydra、Keycloak、Auth0、Okta 均可），并确保其 `/.well-known/openid-configuration` 与 `jwks_uri` 可被 API/dashboard-api 容器访问。
3. 备份 PostgreSQL：

   ```bash
   pg_dump -Fc -t public.users -t public.user_identities -t public.teams > pre-oidc-$(date +%F).dump
   ```

### 5.2 升级步骤（按顺序执行）

#### 步骤 1：应用数据库迁移

```bash
# 通过仓库自带的 migrator（基于 github.com/pressly/goose/v3，见 packages/db/scripts/migrator.go）
POSTGRES_CONNECTION_STRING=postgresql://... \
make migrate
```

> 仓库的 `make migrate` 内部调用 `packages/db/scripts/migrator.go`，它用 goose 库应用 `packages/db/migrations/*.sql`。不要直接调 `goose` CLI——版本表名（`_migrations`）和锁定模式由 migrator 自行管理。

验证：

```sql
\d public.user_identities
-- 期望看到列：oidc_iss, oidc_sub, user_id, created_at, updated_at
-- PK: (oidc_iss, oidc_sub)
-- 注意：[#2866] 之后此表不再启用 RLS
```

#### 步骤 2：选择迁移模式

| 模式 | 适用场景 | `AUTH_PROVIDER_CONFIG` 设置 |
|---|---|---|
| **A. 仅 API Key（无 OIDC）** | self-host 不需要前端登录 | 留空或不设置 |
| **B. OIDC + 兼容旧 Supabase token** ⚠️ 仅过渡期 commit | 已有 Supabase 用户基线，且代码停在 [#2673](https://github.com/e2b-dev/infra/pull/2673) ~ [#2986](https://github.com/e2b-dev/infra/pull/2986) 之间 | `jwt[]` + `legacy.hmac.secrets[]` 同时配置 |
| **C. 纯 OIDC（推荐 / 主分支必选）** | 新部署或已完成迁移 | 仅 `jwt[]` |

模式 A 自 [#2716](https://github.com/e2b-dev/infra/pull/2716) 起被官方支持，所有 JWT 鉴权请求返回 401，API Key / Access Token 正常。

#### 步骤 3：构造 `AUTH_PROVIDER_CONFIG`

主分支（模式 C）以 Ory Hydra 为例：

```json
{
  "jwt": [
    {
      "issuer": {
        "url": "https://auth.your-domain.com/",
        "discoveryURL": "https://auth.your-domain.com/.well-known/openid-configuration",
        "audiences": ["dashboard-api", "api"],
        "audienceMatchPolicy": "MatchAny"
      },
      "cacheDuration": "5m"
    }
  ]
}
```

过渡期 commit（模式 B，仅 [#2673](https://github.com/e2b-dev/infra/pull/2673) ~ [#2986](https://github.com/e2b-dev/infra/pull/2986) 之间）可在 `jwt[]` 之外额外加 `legacy` 段：

```json
{
  "jwt": [
    {
      "issuer": {
        "url": "https://auth.your-domain.com/",
        "discoveryURL": "https://auth.your-domain.com/.well-known/openid-configuration",
        "audiences": ["dashboard-api", "api"],
        "audienceMatchPolicy": "MatchAny"
      },
      "cacheDuration": "5m"
    }
  ],
  "legacy": {
    "hmac": {
      "secrets": ["<旧的 SUPABASE_JWT_SECRET>"]
    }
  }
}
```

注意事项：

- `issuer.url` 必须与 discovery document 中的 `issuer` 字段完全一致（含末尾斜杠）。
- 生产环境 issuer 与 discovery URL 必须 HTTPS（loopback 例外，见 [#2812](https://github.com/e2b-dev/infra/pull/2812)）。
- `audienceMatchPolicy` 当前只支持 `MatchAny`；`MatchAll` 是占位符，被 validator 拒绝。
- `cacheDuration` 默认 5 分钟，按 issuer 的密钥轮换频率调整。
- `legacy.*` 字段在 [#3042](https://github.com/e2b-dev/infra/pull/3042) 之后会被 verifier 忽略（schema 不再解析）。

#### 步骤 4：写入 Terraform 变量

`iac/provider-gcp/terraform.tfvars`（或对应的 AWS tfvars）：

```hcl
auth_provider_config = {
  jwt = [
    {
      issuer = {
        url                 = "https://auth.your-domain.com/"
        discoveryURL        = "https://auth.your-domain.com/.well-known/openid-configuration"
        audiences           = ["dashboard-api", "api"]
        audienceMatchPolicy = "MatchAny"
      }
      cacheDuration = "5m"
    }
  ]
}
```

AWS 端：`iac/provider-aws/terraform.tfvars` 同样写法。

同时确保 Ory API key secret 存在（[#2922](https://github.com/e2b-dev/infra/pull/2922) 之后）：

```bash
gcloud secrets create ${PREFIX}ory-project-api-key --replication-policy=automatic
echo "$ORY_PROJECT_API_TOKEN" | gcloud secrets versions add ${PREFIX}ory-project-api-key --data-file=-
```

#### 步骤 5：移除旧变量

将原 `supabase_jwt_secret` 变量从 tfvars / GCP Secret Manager / AWS Secrets Manager 中清除。**主分支代码已不再读取该变量**（[#3042](https://github.com/e2b-dev/infra/pull/3042) 删除）。

过渡期 commit：旧值需并入 `auth_provider_config.legacy.hmac.secrets[0]`，待步骤 9 完成后再清除。

#### 步骤 6：计划与 apply

```bash
make switch-env ENV=<prod|staging|dev>
make plan-only-jobs           # 仅看 Nomad job 变化
make plan-without-jobs        # 看其它基础设施变化
make plan                     # 全量 plan
make apply
```

#### 步骤 7：seed 已有用户到 `user_identities`（模式 B / C 必做）

对每个需要 OIDC 登录的现有用户，用 admin token 调用 bootstrap（来自 [#2841](https://github.com/e2b-dev/infra/pull/2841)）：

```bash
curl -X POST https://dashboard.<your-domain>/admin/users/bootstrap \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "issuer": "https://auth.your-domain.com/",
    "subject": "<OIDC sub claim>",
    "email": "user@example.com",
    "name": "Real Name"
  }'
```

批量场景可用脚本遍历用户列表，幂等可重试（[#2940](https://github.com/e2b-dev/infra/pull/2940) 的 30 秒窗口 + [#3133](https://github.com/e2b-dev/infra/pull/3133) 的 RFC 6902 `add` PATCH 共同保证幂等）。

#### 步骤 8：本地开发环境（可选）

```bash
# packages/local-dev/seed-local-database.go
export OIDC_ISSUER=http://localhost:4444/   # Hydra 本地
export OIDC_SUBJECT=local-dev-user
go run ./packages/local-dev ./seed-local-database.go
```

#### 步骤 9：完成迁移后切到模式 C（仅过渡期 commit 需要）

观察日志 1–2 周，确认所有 401 都来自真实未授权请求而非 legacy token 失效。然后将 `legacy.hmac.secrets` 清空：

```hcl
auth_provider_config = {
  jwt = [ /* 同上 */ ]
  # legacy 整段删除
}
```

再次 `make plan && make apply`。此时旧的 Supabase JWT 将全部失效。可随后升级到 [#3042](https://github.com/e2b-dev/infra/pull/3042) 之后的代码。

### 5.3 回滚预案

| 阶段 | 回滚动作 |
|---|---|
| DB 迁移后 | 写一个临时 Go 入口调 `packages/db/scripts/migrator.go` 的 goose 实例 `DownTo(20260515120000)`，或直接连库 `DELETE FROM _migrations WHERE version >= 20260515120000` 后 `DROP TABLE public.user_identities`；已 bootstrap 的 OIDC 用户需要重新创建 |
| Apply 后（主分支） | `terraform state` 不会自动回退 env var；需把 `auth_provider_config.jwt[]` 还原为前值后重新 apply。**无法**回滚到 legacy HMAC（代码已删除） |
| Apply 后（过渡期 commit） | 把 `auth_provider_config` 改回 `legacy.hmac.secrets` 形式后重新 apply |
| Bootstrap 失败 | 由于 [#3133](https://github.com/e2b-dev/infra/pull/3133) 已修复时序问题，可直接重试；Ory 端 `external_id` 不会先于 DB 写入 |
| 误删用户 | 使用 [#2986](https://github.com/e2b-dev/infra/pull/2986) 的 `DELETE /admin/users/{userId}` 后，用户在 Ory / `public.users` / `user_identities` 全部清除；需要从备份恢复或在 Ory 控制台重建 identity 后再次 bootstrap |

### 5.4 验证清单

- [ ] `public.user_identities` 表存在（注：[#2866](https://github.com/e2b-dev/infra/pull/2866) 之后不启用 RLS）。
- [ ] API 与 dashboard-api 容器日志中无 `auth provider JWT verifier` 初始化错误。
- [ ] 用 OIDC JWT 调用 `GET /teams`，期望 200 且响应中 `user_id` 为 `public.users.id`。
- [ ] 携带 `X-Team-ID` header 调用需要 team 上下文的接口，期望 200（确认 header 大小写正确）。
- [ ] 未携带 token 调用 `GET /health`，期望 200（health 路径不应受影响）。
- [ ] 模式 A 部署：携带任意 JWT 调用受保护接口，期望 401 `Backend authentication failed`。
- [ ] dashboard bootstrap 后，Ory 控制台中该 identity 的 `external_id` 等于 `public.users.id`。
- [ ] 杀掉 dashboard-api 在 `tx.Commit` 之后、Ory PATCH 之前，再次 bootstrap 同一用户，应成功且无重复 team。
- [ ] 主分支部署：携带旧 Supabase JWT 调用任意接口，期望 401（验证 legacy 已彻底失效）。

### 5.5 已知边界与未来工作

- `audienceMatchPolicy = "MatchAll"` 当前被 validator 拒绝，仅作为占位符保留（[#2673](https://github.com/e2b-dev/infra/pull/2673) 注释）。
- 主分支不再支持 Supabase 模式，旧 Supabase 用户必须先用 admin API bootstrap 到 `public.users` + `public.user_identities`，否则无法登录。
- Ory API token 由独立 Terraform 维护，部署本仓库前需确认 `${prefix}ory-project-api-key` secret 已存在（[#2922](https://github.com/e2b-dev/infra/pull/2922)）。
- `AUTH_PROVIDER_CONFIG` JSON 转义依赖 Terraform `replace`，未来若改用 Nomad `env` block 的 HEREDOC 可减少 escape 复杂度。
- bootstrap 流程依赖三个 PR 的合力：[#2841](https://github.com/e2b-dev/infra/pull/2841)（端点）+ [#2940](https://github.com/e2b-dev/infra/pull/2940)（30s 幂等窗口）+ [#3133](https://github.com/e2b-dev/infra/pull/3133)（commit 后写 external_id）。部署时三个 PR 都必须在位。

---

## 附录：相关文件索引

- 验证器核心：`packages/auth/pkg/auth/oidc/oidc.go`、`packages/auth/pkg/auth/verifier.go`
- 服务层：`packages/auth/pkg/auth/service.go`、`identity_lookup.go`、`middleware.go`
- 数据库迁移：`packages/db/migrations/20260515120000_create_user_identities_table.sql`
- sqlc 查询：`packages/db/pkg/auth/sql_queries/user_identities/upsert_public_identity.sql`、`get_user_identities_by_subjects.sql`、`get_user_identities_by_user_ids.sql`
- IaC：`iac/provider-gcp/main.tf:63-85`、`iac/provider-gcp/variables.tf:225`、`iac/provider-gcp/dashboard-api.tf`、`iac/provider-aws/main.tf:114`、`iac/provider-gcp/init/secrets.tf`
- OpenAPI：`spec/openapi-dashboard.yml`、`spec/openapi.yml`
- Dashboard bootstrap handler：`packages/dashboard-api/internal/handlers/admin_users_bootstrap.go`、`utils_team_provisioning.go`、`admin_users_delete.go`
- Ory provider：`packages/dashboard-api/internal/userprofile/ory.go`、`provider.go`、`providers.go`
- 本地 seed：`packages/local-dev/seed-local-database.go`
- 已删除（仅供历史参考）：`packages/auth/pkg/auth/legacy/`、`packages/auth/pkg/auth/jwt.go`、`packages/db/pkg/supabase/`、`packages/dashboard-api/internal/userprofile/supabase.go`、`packages/dashboard-api/internal/userprofile/mode.go`。**注**：`packages/dashboard-api/internal/userprofile/creator_context.go` 由 [#2967](https://github.com/e2b-dev/infra/pull/2967) 创建、[#3042](https://github.com/e2b-dev/infra/pull/3042) 删除,2026-07-02 又由 commit `a160ab26f` 重新引入,当前仍存在
