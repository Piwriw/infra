# E2B Template Tags & Aliases(tag/alias 管理端点)模块详解

> 模块定位:为 template build 打 tag、按 alias 查询 template 的 4 个端点。底层机制(M:N 关系、`env_build_assignments` 表、alias 解析流程)已在 [template-module.md](./template-module.md) 详述,本文聚焦**端点使用、输入校验、错误场景**。
>
> **核心特征**:
> - 4 个端点分两个 OpenAPI tag:`tags`(3 个)+ `templates`(1 个)
> - 输入统一用 `[namespace/]alias[:tag]` 字符串(由 `packages/shared/pkg/id` 解析)
> - tag 不能是 UUID、不能删除 `default` tag
> - alias 查询支持"显式 tag 探测"——可验证某 tag 是否存在
> - 所有写操作都触发 templateCache 失效(每个 tag 单独 invalidate)
>
> 适用代码范围:
> - `packages/api/internal/handlers/template_tags.go` — 3 个 tag 端点
> - `packages/api/internal/handlers/template_alias.go` — 1 个 alias 端点
> - `packages/shared/pkg/id/id.go` — 名称解析与校验
> - `packages/api/internal/cache/templates/alias_cache.go` — 别名缓存
> - `packages/db/queries/templates/` — 4 个 sqlc 查询
> - `spec/openapi.yml` 中 `tags: [tags]` 和 `GET /templates/aliases/{alias}` 端点

## 目录

- [一、概述](#一概述)
  - [1.1 tags/aliases 是什么](#11-tagsaliases-是什么)
  - [1.2 关键定位:为什么独立成模块](#12-关键定位为什么独立成模块)
  - [1.3 关键心智模型](#13-关键心智模型)
  - [1.4 整体架构](#14-整体架构)
- [二、核心概念](#二核心概念)
  - [2.1 名称格式:`[namespace/]alias[:tag]`](#21-名称格式namespacealiastag)
  - [2.2 tag 的约束(不能是 UUID,不能是空)](#22-tag-的约束不能是-uuid不能是空)
  - [2.3 `default` tag 的特殊地位](#23-default-tag-的特殊地位)
  - [2.4 alias 解析的 namespace 回退](#24-alias-解析的-namespace-回退)
  - [2.5 cache 失效粒度(每 tag 单独)](#25-cache-失效粒度每-tag-单独)
- [三、整体架构](#三整体架构)
  - [3.1 装配序列](#31-装配序列)
  - [3.2 依赖图](#32-依赖图)
  - [3.3 数据流总览](#33-数据流总览)
- [四、4 个端点逐一解析](#四4-个端点逐一解析)
  - [4.1 POST /templates/tags — 给某 tag 指向的 build 再加 tag(s)](#41-post-templatestags--给某-tag-指向的-build-再加-tags)
  - [4.2 DELETE /templates/tags — 批量删除 tag(s)](#42-delete-templatestags--批量删除-tags)
  - [4.3 GET /templates/{templateID}/tags — 列出所有 tag](#43-get-templatestemplateidtags--列出所有-tag)
  - [4.4 GET /templates/aliases/{alias} — 按 alias 查 template](#44-get-templatesaliasesalias--按-alias-查-template)
- [五、关键流程时序图](#五关键流程时序图)
  - [5.1 POST tags(给 production tag 加 v1.2 tag)](#51-post-tags给-production-tag-加-v12-tag)
  - [5.2 DELETE tags(批量删除)](#52-delete-tags批量删除)
  - [5.3 GET alias(含 tag 探测)](#53-get-alias含-tag-探测)
- [六、id 包深入](#六id-包深入)
  - [6.1 ParseName 的完整解析逻辑](#61-parsename-的完整解析逻辑)
  - [6.2 ValidateAndDeduplicateTags 的去重](#62-validateandeduplicatetags-的去重)
  - [6.3 ValidateNamespaceMatchesTeam 的归属校验](#63-validatenamespacematchesteam-的归属校验)
- [七、数据模型(简表)](#七数据模型简表)
- [八、与 alias cache 的闭环](#八与-alias-cache-的闭环)
  - [8.1 ResolveAlias 的 fallback 逻辑](#81-resolvealias-的-fallback-逻辑)
  - [8.2 写操作后如何 invalidate](#82-写操作后如何-invalidate)
  - [8.3 negative lookup tombstone](#83-negative-lookup-tombstone)
- [九、配置与 Feature Flag](#九配置与-feature-flag)
- [十、关键代码文件索引](#十关键代码文件索引)
- [十一、设计要点与权衡](#十一设计要点与权衡)
- [十二、常见问题与排查](#十二常见问题与排查)
- [附录 A:端点速查表](#附录-a端点速查表)
- [附录 B:错误码与 HTTP 状态映射](#附录-b错误码与-http-状态映射)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

### 1.1 tags/aliases 是什么

4 个端点分属两个 OpenAPI tag:

| 路径 | 方法 | OpenAPI tag | 功能 | Handler |
| --- | --- | --- | --- | --- |
| `/templates/tags` | POST | `tags` | 给现有 tag 指向的 build 再分配 tag(s) | `PostTemplatesTags` |
| `/templates/tags` | DELETE | `tags` | 批量删除 template 的 tag(s) | `DeleteTemplatesTags` |
| `/templates/{templateID}/tags` | GET | `tags` | 列出 template 的所有 tag | `GetTemplatesTemplateIDTags` |
| `/templates/aliases/{alias}` | GET | `templates` | 按 alias 查 template(含 tag 探测) | `GetTemplatesAliasesAlias` |

**典型使用场景**:
- CI/CD 完成新 build 后,把 `production` tag 移到新 build(POST)
- 旧版本废弃时,清理过期的 tag(DELETE)
- dashboard 展示 template 的所有 tag 列表(GET)
- SDK 启动时检查 `e2b-dev/my-app:production` 是否存在(GET alias)

### 1.2 关键定位:为什么独立成模块

虽然底层都依赖 template 数据模型(详见 [template-module.md](./template-module.md)),但这 4 个端点有独立的:
- 输入语义(都是字符串解析,有特殊校验规则)
- 缓存策略(alias cache 与 template cache 分开)
- 错误模式(403 vs 404 的边界设计特别微妙,见 [4.4](#44-get-templatesaliasesalias--按-alias-查-template))

所以单独成文档,不与 template-module.md 重复。

### 1.3 关键心智模型

1. **名称是组合的**:`namespace/alias:tag`,三部分都可选,但语义严格。
2. **tag 不能是 UUID**:防止与 build_id 混淆。例如 `e2b-dev/app:abc123` 中的 `abc123` 如果是 UUID 会被拒。
3. **`default` tag 受保护**:DELETE 不能删,POST 不需要显式指定时默认指向 `default`。
4. **namespace 必须匹配 team slug**:用户传 `other-team/app` 会被拒(除非 other-team 显式共享)。
5. **写后必须 invalidate cache**:每个 tag 是独立 cache 条目,逐个清。
6. **GET alias 含 tag 探测**:`GET /templates/aliases/app:v1` 会验证 v1 tag 是否存在,不存在返 404。
7. **所有权检查先于 tag 探测**:防止非 owner 通过 404 vs 403 推断 tag 是否存在。

### 1.4 整体架构

```
                  ┌──────────────────────────────────┐
                  │  dashboard / CI / SDK            │
                  │                                  │
                  │  - POST   /templates/tags        │
                  │  - DELETE /templates/tags        │
                  │  - GET    /templates/{id}/tags   │
                  │  - GET    /templates/aliases/{a} │
                  └──────────────┬───────────────────┘
                                 │
                                 │  Authorization + X-API-Key
                                 │  (或 OIDC + X-Team-Id)
                                 ▼
        ┌────────────────────────────────────────────────────┐
        │                API (Gin + oapi-codegen)            │
        │                                                  │
        │  鉴权(任一):                                     │
        │   - ApiKeyAuth                                    │
        │   - AuthProviderBearerAuth + AuthProviderTeamAuth │
        │   - AdminApiKeyAuth + AdminTeamAuth               │
        │                                                  │
        │  handlers/                                        │
        │   ├── template_tags.go (3 个 tag 端点)            │
        │   │   ├── id.ParseName(target/name)               │
        │   │   ├── id.ValidateNamespaceMatchesTeam         │
        │   │   ├── templateCache.ResolveAlias              │
        │   │   ├── id.ValidateAndDeduplicateTags           │
        │   │   ├── sqlcDB.WithTx + CreateTemplateBuild...  │
        │   │   └── templateCache.Invalidate(per tag)       │
        │   │                                               │
        │   └── template_alias.go (1 个 alias 端点)         │
        │       ├── id.ParseName(alias)                     │
        │       ├── templateCache.ResolveAliasWithMetadata  │
        │       ├── ownership check                         │
        │       └── (有 tag 时)GetTemplateWithBuildByTag    │
        └────────────┬─────────────────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────────────┐
        │  templateCache (Redis, 5 min TTL)│
        │  - AliasCache (template:alias:*)│
        │  - TemplateCache (template:*)    │
        └────────────┬─────────────────────┘
                     │
                     ▼
              ┌──────────────────┐
              │  PgSQL           │
              │  envs            │
              │  env_builds      │
              │  env_build_assignments │
              │  env_aliases     │
              └──────────────────┘
```

---

## 二、核心概念

### 2.1 名称格式:`[namespace/]alias[:tag]`

完整语法(`packages/shared/pkg/id/id.go:94` 的 `ParseName`):

```
格式:    [namespace/]alias[:tag]
示例:    "e2b-dev/my-app:production"
         "my-app:v1.2"
         "e2b-dev/my-app"
         "my-app"

正则:    identifier (alias/namespace): ^[a-z0-9-_]+$
         tag:                          ^[a-z0-9-_.]+$

规则:
  - alias/namespace 必须小写
  - tag 可含 `.`(支持 semver,如 v1.2.3)
  - 全部会做 ToLower + TrimSpace 标准化
```

`ParseName` 返回 `(identifier string, tag *string, err error)`。tag 是指针,区分"未指定 tag"(nil,默认 `default`)和"显式 tag"。

### 2.2 tag 的约束(不能是 UUID,不能是空)

`id.validateTag`(`packages/shared/pkg/id/id.go:50`):

```go
func validateTag(tag string) (string, error) {
    cleanedTag, err := cleanAndValidate(tag, "tag", tagRegex)
    if err != nil {
        return "", err
    }

    // Prevent tags from being a UUID
    _, err = uuid.Parse(cleanedTag)
    if err == nil {
        return "", errors.New("tag cannot be a UUID")
    }

    return cleanedTag, nil
}
```

**为什么 tag 不能是 UUID**?
- `GetTemplateWithBuildByTag` SQL 用 `try_cast_uuid` 同时匹配 tag 或 build_id:

```sql
eba.tag = COALESCE(sqlc.narg(tag), 'default')
OR
eba.build_id = try_cast_uuid(sqlc.narg(tag))
```

如果允许 UUID 作为 tag,会出现歧义(用户传一个 UUID,不知道是要按 tag 匹配还是按 build_id 匹配)。所以输入校验阶段就拒绝。

### 2.3 `default` tag 的特殊地位

```go
// packages/shared/pkg/id/id.go:23
const (
    DefaultTag         = "default"
    TagSeparator       = ":"
    NamespaceSeparator = "/"
)
```

- **每个 template 都有 default tag**:由 `env_builds` 表的旧 trigger 自动维护(2026-02 之前)或应用层管理(2026-02 之后)。
- **POST 不需要显式指定**:body 里 `target: "my-app"` 等价于 `target: "my-app:default"`,会找到 default tag 当前指向的 build。
- **DELETE 不能删 default**:`DeleteTemplatesTags` 显式检查 `slices.Contains(tags, id.DefaultTag)` 并返 400。
- **POST 可以"重新指向" default**:但通常不这么做,因为 default 应该指向 stable 版本。

### 2.4 alias 解析的 namespace 回退

`AliasCache.Resolve`(`packages/api/internal/cache/templates/alias_cache.go:71`)的逻辑:

```
input: identifier = "my-app"
       namespaceFallback = team.Slug (例如 "e2b-dev")

1. SplitIdentifier("my-app") → namespace=nil, alias="my-app"
2. namespace == nil,走 bare alias 路径:
   a. lookup(namespace="e2b-dev", alias="my-app")  ← 先试 team namespace
   b. 失败 → lookup(namespace=nil, alias="my-app") ← 再试 promoted(全局可见)templates
```

**显式 namespace 不回退**:
- input `"other-team/my-app"` → 直接 lookup(namespace="other-team", ...),失败就返 NotFound。
- 这防止"用户传错了 namespace,结果意外看到别人 template"的安全问题。

详见 [template-module.md 的 alias 解析章节](./template-module.md#十alias-别名解析机制)。

### 2.5 cache 失效粒度(每 tag 单独)

template cache 的 key 是 `(templateID, tag)` 二元组。**不是按 templateID 整体失效,而是按 tag 单独失效**:

```go
// template_tags.go:158-160
for _, tag := range tags {
    a.templateCache.Invalidate(context.WithoutCancel(ctx), template.ID, &tag)
}
```

原因:
- 每个 tag 的最新 build 是独立查询,缓存条目独立。
- 改一个 tag 不应影响其他 tag 的缓存。
- alias 缓存(`AliasCache`)与 template 缓存分开,**写 tag 不失效 alias**——alias 指向 templateID,与 tag 无关。

---

## 三、整体架构

### 3.1 装配序列

```go
r.POST  ("/templates/tags",                   middleware → apiStore.PostTemplatesTags)
r.DELETE("/templates/tags",                   middleware → apiStore.DeleteTemplatesTags)
r.GET   ("/templates/:templateID/tags",       middleware → apiStore.GetTemplatesTemplateIDTags)
r.GET   ("/templates/aliases/:alias",         middleware → apiStore.GetTemplatesAliasesAlias)
```

中间件链(所有 4 个端点共用):
1. `limits.RequestSizeLimiter`
2. `middleware.OapiRequestValidatorWithOptions` — schema + 鉴权

### 3.2 依赖图

```
APIStore
├── sqlcDB (packages/db/client)
│   ├── WithTx (POST 事务)
│   ├── GetTemplateWithBuildByTag
│   ├── CreateTemplateBuildAssignment
│   ├── DeleteTemplateTags
│   └── ListTemplateTags
├── templateCache (packages/api/internal/cache/templates)
│   ├── ResolveAlias / ResolveAliasWithMetadata
│   └── Invalidate(templateID, &tag)
├── GetTeam (内部 helper,从 ctx 拿 team)
├── posthog (analytics 事件)
└── id 包(纯函数,无状态)
```

### 3.3 数据流总览

```
HTTP 请求
   │
   ▼
Gin 中间件 → 鉴权 → 注入 team 到 ctx
   │
   ▼
Handler (template_tags.go / template_alias.go)
   │
   ├── 1. ginutils.ParseBody[...]
   ├── 2. id.ValidateAndDeduplicateTags (POST/DELETE)
   ├── 3. a.GetTeam(ctx, c, nil)              ← 从 ctx 拿 team
   ├── 4. id.ParseName(target/name/alias)     ← 解析名称
   ├── 5. id.ValidateNamespaceMatchesTeam     ← 归属校验
   ├── 6. a.templateCache.ResolveAlias        ← alias → templateID
   ├── 7. (POST only) GetTemplateWithBuildByTag ← 找当前 build
   ├── 8. (POST only) ValidateAliasInfo.TeamID == team.ID
   ├── 9. 写 DB / 查 DB
   ├── 10. for each tag: templateCache.Invalidate
   └── 11. c.JSON / c.Status
```

---

## 四、4 个端点逐一解析

### 4.1 POST /templates/tags — 给某 tag 指向的 build 再加 tag(s)

**Handler**:`APIStore.PostTemplatesTags` (`packages/api/internal/handlers/template_tags.go:24`)

**鉴权**(三选一):
```yaml
security:
  - ApiKeyAuth: []
  - AuthProviderBearerAuth: []
    AuthProviderTeamAuth: []
  - AdminApiKeyAuth: []
    AdminTeamAuth: []
```

**请求 body** (`AssignTemplateTagsRequest`):
```json
{
  "target": "e2b-dev/my-app:production",
  "tags": ["v1.2.3", "stable"]
}
```

- `target`:必填,格式 `[namespace/]alias[:tag]`。指向"当前要给哪些 build 加 tag"。
- `tags`:必填,至少 1 个。要新加的 tag 列表。

**流程**(`template_tags.go:24-181`):

```go
body, err := ginutils.ParseBody[api.AssignTemplateTagsRequest](ctx, c)
// ...

// 1. 校验 tags 非空
if len(body.Tags) == 0 {
    // 400 "At least one tag is required"
}

// 2. 拿 team
team, apiErr := a.GetTeam(ctx, c, nil)

// 3. 解析 target → identifier + 可选 tag
identifier, tag, err := id.ParseName(body.Target)
// e.g. "my-app:production" → identifier="my-app", tag="production"
// e.g. "my-app"            → identifier="my-app", tag=nil(默认 "default")

// 4. namespace 必须匹配 team slug
if err := id.ValidateNamespaceMatchesTeam(identifier, team.Slug); err != nil {
    // 400 "namespace 'X' must match your team 'Y'"
}

// 5. 解析 alias → templateID
aliasInfo, err := a.templateCache.ResolveAlias(ctx, identifier, team.Slug)

// 6. 默认 tag 处理
targetTagValue := id.DefaultTag
if tag != nil {
    targetTagValue = *tag
}

// 7. 开事务(防止中途失败留下脏数据)
client, tx, err := a.sqlcDB.WithTx(ctx)
defer tx.Rollback(ctx)

// 8. 找到 (templateID, targetTag) 当前指向的 build
result, err := client.GetTemplateWithBuildByTag(ctx, queries.GetTemplateWithBuildByTagParams{
    TemplateID: aliasInfo.TemplateID,
    Tag:        &targetTagValue,
})

// 9. 再次校验所有权(template 可能被转移)
if aliasInfo.TeamID != team.ID {
    // 403 "You don't have access to sandbox template 'X'"
}

// 10. 标准化 + 去重 tags
tags, err := id.ValidateAndDeduplicateTags(body.Tags)

// 11. 逐个创建 assignment
for _, tag := range tags {
    rows, err := client.CreateTemplateBuildAssignment(ctx, queries.CreateTemplateBuildAssignmentParams{
        TemplateID: template.ID,
        BuildID:    buildID,
        Tag:        tag,
    })
    if rows == 0 {
        // 404 template 已被删除(并发场景)
    }
}

// 12. 提交事务
err = tx.Commit(ctx)

// 13. 按 tag 单独失效缓存
for _, tag := range tags {
    a.templateCache.Invalidate(context.WithoutCancel(ctx), template.ID, &tag)
}

// 14. Posthog 埋点 + 日志
c.JSON(http.StatusCreated, api.AssignedTemplateTags{
    Tags:    tags,
    BuildID: buildID,
})
```

**关键点**:
- **事务**:`WithTx + Commit/Rollback`,保证所有 assignment 要么全成功要么全失败。
- **`GetTemplateWithBuildByTag`**:这是关键查询,先找到 `target` 当前指向的 build,然后把新 tags 都加到这个 build。
- **`FOR SHARE` 锁**:`CreateTemplateBuildAssignment` SQL 内部用 `FOR SHARE` 锁住 `envs` 行,防止并发 `DELETE template` 把 template 删了(详见 [SQL 注释](#71-sql-查询)))。
- **双重所有权检查**:第 4 步(namespace)和第 9 步(TeamID)是纵深防御。即使 namespace 校验过了,如果 template 被转移给别的 team,第二次检查会拒。
- **rows==0 = template 没了**:并发删除场景。返 404。

**响应**:`201 Created` + JSON `{tags, buildID}`。

### 4.2 DELETE /templates/tags — 批量删除 tag(s)

**Handler**:`APIStore.DeleteTemplatesTags` (`template_tags.go:184`)

**鉴权**:同 POST。

**请求 body** (`DeleteTemplateTagsRequest`):
```json
{
  "name": "e2b-dev/my-app",
  "tags": ["v1.2.3", "stable"]
}
```

- `name`:必填,**只是 template 名称(不含 tag)**。如果传 `"my-app:v1"` 会被拒(见第 5 步)。
- `tags`:必填,至少 1 个。

**流程**(`template_tags.go:184-297`):

```go
body, err := ginutils.ParseBody[api.DeleteTemplateTagsRequest](ctx, c)

// 1. 校验 + 去重 tags
tags, err := id.ValidateAndDeduplicateTags(body.Tags)

// 2. 必须非空
if len(tags) == 0 { /* 400 */ }

// 3. 不允许删 default tag
if slices.Contains(tags, id.DefaultTag) {
    // 400 "Cannot delete the 'default' tag"
}

// 4. 拿 team
team, apiErr := a.GetTeam(ctx, c, nil)

// 5. 解析 name → identifier + 可选 tag
identifier, tag, err := id.ParseName(body.Name)

// 6. name 不应该带 tag(必须用 tags 字段)
if tag != nil {
    // 400 "Template name should not contain a tag, use the 'tags' field instead"
}

// 7. namespace 校验
if err := id.ValidateNamespaceMatchesTeam(identifier, team.Slug); err != nil { /* 400 */ }

// 8. 解析 alias
aliasInfo, err := a.templateCache.ResolveAlias(ctx, identifier, team.Slug)

// 9. 所有权校验
if aliasInfo.TeamID != team.ID {
    // 403 "You don't have access..."
}

// 10. 批量 DELETE
err = a.sqlcDB.DeleteTemplateTags(ctx, queries.DeleteTemplateTagsParams{
    TemplateID: aliasInfo.TemplateID,
    Tags:       tags,
})

// 11. 失效缓存(每 tag 单独)
for _, tag := range tags {
    a.templateCache.Invalidate(context.WithoutCancel(ctx), aliasInfo.TemplateID, &tag)
}

c.Status(http.StatusNoContent)
```

**关键点**:
- **`name` 不应含 tag**:与 POST 的 `target` 不同(POST 的 target 可以含 tag,因为要找"当前指向哪个 build")。DELETE 只需要 template 标识。
- **default tag 受保护**:见 [2.3](#23-default-tag-的特殊地位)。
- **不需要事务**:`DeleteTemplateTags` 是单条 SQL(`DELETE WHERE tag = ANY(@tags)`),要么全成功要么全失败(DB 原子性)。
- **找不到 tag 不返 404**:如果 tag 不存在,DELETE 返 0 行受影响但 SQL 不报错。语义是"确保这些 tag 没了",**幂等**。

**响应**:`204 No Content`。

### 4.3 GET /templates/{templateID}/tags — 列出所有 tag

**Handler**:`APIStore.GetTemplatesTemplateIDTags` (`template_tags.go:300`)

**鉴权**:同 POST。

**path 参数**:`templateID`(`api.TemplateID` 类型,实际是 string),格式同 `[namespace/]alias`。

**流程**(`template_tags.go:300-357`):

```go
team, apiErr := a.GetTeam(ctx, c, nil)

identifier, _, err := id.ParseName(templateID)

if err := id.ValidateNamespaceMatchesTeam(identifier, team.Slug); err != nil { /* 400 */ }

aliasInfo, err := a.templateCache.ResolveAlias(ctx, identifier, team.Slug)

if aliasInfo.TeamID != team.ID {
    // 403 "You don't have access..."
}

tags, err := a.sqlcDB.ListTemplateTags(ctx, aliasInfo.TemplateID)

res := make([]api.TemplateTag, 0, len(tags))
for _, t := range tags {
    res = append(res, api.TemplateTag{
        Tag:       t.Tag,
        BuildID:   t.BuildID,
        CreatedAt: t.CreatedAt.Time,
    })
}

c.JSON(http.StatusOK, res)
```

**SQL 关键**(`list_template_tags.sql`):

```sql
SELECT DISTINCT ON (eba.tag) eba.tag, eba.build_id, eba.created_at
FROM public.env_build_assignments AS eba
WHERE eba.env_id = @template_id
ORDER BY eba.tag, eba.created_at DESC;
```

`DISTINCT ON (eba.tag) + ORDER BY eba.tag, eba.created_at DESC` 的含义:**每个 tag 只返回最新一条 assignment**。

为什么?因为 M:N 关系下一个 tag 可能指向过多个 build(历史 assignment),但当前生效的只有最新的。

**响应**:`200 OK` + `[]TemplateTag`:
```json
[
  {"tag": "default",    "buildID": "uuid-1", "createdAt": "2026-07-10T..."},
  {"tag": "production", "buildID": "uuid-2", "createdAt": "2026-07-12T..."},
  {"tag": "v1.2.3",     "buildID": "uuid-2", "createdAt": "2026-07-12T..."}
]
```

### 4.4 GET /templates/aliases/{alias} — 按 alias 查 template

**Handler**:`APIStore.GetTemplatesAliasesAlias` (`packages/api/internal/handlers/template_alias.go:18`)

**鉴权**:同 POST。

**path 参数**:`alias`,格式 `[namespace/]alias[:tag]`。可以只查 alias 是否存在,也可以同时探测 tag 是否存在。

**流程**(`template_alias.go:18-94`):

```go
team, apiErr := a.GetTeam(ctx, c, nil)

// 1. 检查 alias 字符串里有没有显式 tag
hasExplicitTag := strings.Contains(alias, id.TagSeparator)  // ":"

// 2. 解析 alias
identifier, tag, err := id.ParseName(alias)

// 3. namespace 校验
if err := id.ValidateNamespaceMatchesTeam(identifier, team.Slug); err != nil { /* 400 */ }

// 4. 解析 alias + 拿 metadata(public 标志)
aliasInfo, metadata, err := a.templateCache.ResolveAliasWithMetadata(ctx, identifier, team.Slug)

// 5. 所有权检查 — 关键!必须在 tag 探测之前
if aliasInfo.TeamID != team.ID {
    // 403 "You don't have access to this template alias"
    return
}

// 6. 如果有显式 tag,探测 tag 是否存在
if hasExplicitTag {
    tagValue := id.DefaultTag
    if tag != nil {
        tagValue = *tag
    }

    _, err = a.sqlcDB.GetTemplateWithBuildByTag(ctx, queries.GetTemplateWithBuildByTagParams{
        TemplateID: aliasInfo.TemplateID,
        Tag:        &tagValue,
    })
    if err != nil {
        if dberrors.IsNotFoundError(err) {
            // 404 "tag 'X' does not exist for template 'Y'"
        }
        // 500
    }
}

// 7. 返回 template 信息
c.JSON(http.StatusOK, api.TemplateAliasResponse{
    Public:     metadata.Public,
    TemplateID: aliasInfo.TemplateID,
})
```

**关键设计点**:**所有权检查必须在 tag 探测之前**。

代码注释(template_alias.go:52-55):
```go
// Ownership verification (handles edge case where template was transferred).
// Must run before the tag-existence probe below, otherwise non-owners could
// distinguish existing tags from missing ones on templates they no longer
// have access to via 404 vs 403 responses.
```

**为什么顺序很重要**?
- 假设 template 之前属于 team A,后被转移给 team B。
- team A 的用户调 `GET /templates/aliases/old-alias:v1`。
- 如果先做 tag 探测:
  - tag 存在 → 返 200(信息泄漏!)
  - tag 不存在 → 返 404
- 这样 team A 用户可以通过 404 vs 200/403 推断 tag 是否存在。
- 改成先做所有权检查:无论 tag 是否存在,都返 403 "You don't have access"。

**响应**:`200 OK` + JSON:
```json
{
  "public": false,
  "templateID": "uuid-of-template"
}
```

**404 场景**:仅当所有权 OK 但 tag 不存在时返 404。

---

## 五、关键流程时序图

### 5.1 POST tags(给 production tag 加 v1.2 tag)

```
CI/CD             API (PostTemplatesTags)         templateCache        PgSQL
  │                     │                            │                   │
  │ POST /templates/tags│                            │                   │
  │   {                 │                            │                   │
  │     target:         │                            │                   │
  │       "my-app:production",                       │                   │
  │     tags: ["v1.2"]  │                            │                   │
  │   }                 │                            │                   │
  ├────────────────────>│                            │                   │
  │                     │                            │                   │
  │                     │ 1. ParseName(target)       │                   │
  │                     │   → id="my-app", tag="production"              │
  │                     │                            │                   │
  │                     │ 2. ResolveAlias(id)        │                   │
  │                     ├───────────────────────────>│                   │
  │                     │                            │ cache miss        │
  │                     │                            ├──────────────────>│
  │                     │                            │<──────────────────┤
  │                     │<───────────────────────────┤                   │
  │                     │   aliasInfo.TemplateID     │                   │
  │                     │                            │                   │
  │                     │ 3. WithTx + GetTemplateWithBuildByTag          │
  │                     │   WHERE tag='production'   │                   │
  │                     ├───────────────────────────>│                   │
  │                     │                            ├──────────────────>│
  │                     │                            │<──────────────────┤
  │                     │   build_id (当前 production build)             │
  │                     │                            │                   │
  │                     │ 4. CreateTemplateBuildAssignment              │
  │                     │   (template_id, build_id, "v1.2")             │
  │                     ├───────────────────────────>│                   │
  │                     │                            ├──────────────────>│
  │                     │                            │<──────────────────┤
  │                     │                            │                   │
  │                     │ 5. Invalidate(template_id, &"v1.2")           │
  │                     ├───────────────────────────>│                   │
  │                     │                            │ DEL redis key     │
  │                     │                            │                   │
  │                     │ 6. 201 Created             │                   │
  │                     │   {tags:["v1.2"], buildID}│                   │
  │<────────────────────┤                            │                   │
```

### 5.2 DELETE tags(批量删除)

```
CI/CD             API (DeleteTemplatesTags)       templateCache        PgSQL
  │                     │                            │                   │
  │ DELETE /templates/tags                          │                   │
  │   {                 │                            │                   │
  │     name: "my-app", │                            │                   │
  │     tags:           │                            │                   │
  │       ["v1.2",      │                            │                   │
  │        "old"]       │                            │                   │
  │   }                 │                            │                   │
  ├────────────────────>│                            │                   │
  │                     │                            │                   │
  │                     │ 1. ValidateAndDeduplicateTags(["v1.2","old"]) │
  │                     │   → ["v1.2", "old"]        │                   │
  │                     │                            │                   │
  │                     │ 2. slices.Contains(tags, "default")?          │
  │                     │   → false(可删)            │                   │
  │                     │                            │                   │
  │                     │ 3. ParseName("my-app") → id="my-app", tag=nil │
  │                     │                            │                   │
  │                     │ 4. ResolveAlias + ownership check             │
  │                     ├───────────────────────────>│                   │
  │                     │<───────────────────────────┤                   │
  │                     │                            │                   │
  │                     │ 5. DeleteTemplateTags      │                   │
  │                     │   DELETE WHERE tag = ANY('{v1.2,old}')        │
  │                     ├───────────────────────────>│──────────────────>│
  │                     │                            │<──────────────────┤
  │                     │                            │   (n 行删除)      │
  │                     │                            │                   │
  │                     │ 6. Invalidate(template, &"v1.2")              │
  │                     │    Invalidate(template, &"old")               │
  │                     ├───────────────────────────>│                   │
  │                     │                            │                   │
  │                     │ 7. 204 No Content          │                   │
  │<────────────────────┤                            │                   │
```

### 5.3 GET alias(含 tag 探测)

```
SDK               API (GetTemplatesAliasesAlias)  templateCache        PgSQL
  │                     │                            │                   │
  │ GET /templates/aliases/my-app:v1.2              │                   │
  ├────────────────────>│                            │                   │
  │                     │                            │                   │
  │                     │ 1. hasExplicitTag = true (含 ":")             │
  │                     │                            │                   │
  │                     │ 2. ParseName → id="my-app", tag="v1.2"        │
  │                     │                            │                   │
  │                     │ 3. ResolveAliasWithMetadata                  │
  │                     ├───────────────────────────>│                   │
  │                     │<───────────────────────────┤                   │
  │                     │   aliasInfo, metadata.public=false            │
  │                     │                            │                   │
  │                     │ 4. 所有权检查(aliasInfo.TeamID == team.ID)?   │
  │                     │   ✓ 通过                    │                   │
  │                     │                            │                   │
  │                     │ 5. GetTemplateWithBuildByTag                 │
  │                     │   WHERE tag='v1.2'         │                   │
  │                     ├───────────────────────────>│──────────────────>│
  │                     │                            │<──────────────────┤
  │                     │   找到 build              │                   │
  │                     │                            │                   │
  │                     │ 6. 200 OK                  │                   │
  │                     │   {public:false,           │                   │
  │                     │    templateID:"uuid"}      │                   │
  │<────────────────────┤                            │                   │
```

**如果所有权检查失败**(template 已不属于该 team):

```
                     │ 4. 所有权检查(aliasInfo.TeamID == team.ID)?
                     │   ✗ 不通过
                     │
                     │ 5. 403 Forbidden
                     │   "You don't have access to this template alias"
                     │   (无论 tag 是否存在,都返 403)
```

---

## 六、id 包深入

### 6.1 ParseName 的完整解析逻辑

`packages/shared/pkg/id/id.go:94`:

```go
func ParseName(input string) (identifier string, tag *string, err error) {
    input = strings.TrimSpace(input)

    // 1. 切出 identifier 部分和 tag 部分
    identifierPart, tagPart, hasTag := strings.Cut(input, TagSeparator)  // ":"
    namespacePart, aliasPart := SplitIdentifier(identifierPart)          // "/"

    // 2. 校验 tag(如果有)
    if hasTag {
        validated, err := cleanAndValidate(tagPart, "tag", tagRegex)
        if !strings.EqualFold(validated, DefaultTag) {
            tag = &validated
        }
        // 如果是 "default",tag 保持 nil(让上层走 default 路径)
    }

    // 3. 校验 namespace(如果有)
    if namespacePart != nil {
        validated, err := cleanAndValidate(*namespacePart, "namespace", identifierRegex)
        namespacePart = &validated
    }

    // 4. 校验 alias(必有)
    aliasPart, err = cleanAndValidate(aliasPart, "template ID", identifierRegex)

    // 5. 拼回 identifier
    if namespacePart != nil {
        identifier = WithNamespace(*namespacePart, aliasPart)
    } else {
        identifier = aliasPart
    }

    return identifier, tag, nil
}
```

**标准化细节**:
- 全部 `ToLower`(用户传 `My-App` 会被改成 `my-app`)
- 全部 `TrimSpace`(用户传 `" my-app "` 会被改成 `my-app`)
- **如果 tag 是 "default",视为 nil**(让 `targetTagValue := id.DefaultTag` 走默认路径)

### 6.2 ValidateAndDeduplicateTags 的去重

`packages/shared/pkg/id/id.go:65`:

```go
func ValidateAndDeduplicateTags(tags []string) ([]string, error) {
    seen := make(map[string]struct{})

    for _, tag := range tags {
        cleanedTag, err := validateTag(tag)
        if err != nil {
            return nil, fmt.Errorf("invalid tag '%s': %w", tag, err)
        }
        seen[cleanedTag] = struct{}{}
    }

    return slices.Collect(maps.Keys(seen)), nil
}
```

**关键点**:
- 用 map 去重,`["v1", "V1", "v1"]` 标准化后都成 `["v1"]`。
- **任意顺序**:Go map 迭代顺序未定义,所以返回的 tags 顺序不保证。如果客户端依赖顺序,要自己排序。
- 任何一个 tag 校验失败,整个请求返 400。

### 6.3 ValidateNamespaceMatchesTeam 的归属校验

`packages/shared/pkg/id/id.go:157`:

```go
func ValidateNamespaceMatchesTeam(identifier, teamSlug string) error {
    namespace, _ := SplitIdentifier(identifier)
    if namespace != nil && *namespace != teamSlug {
        return fmt.Errorf("namespace '%s' must match your team '%s'", *namespace, teamSlug)
    }
    return nil
}
```

**逻辑**:
- 如果 identifier 含显式 namespace(如 `other-team/app`),必须等于 team slug。
- 如果是 bare alias(如 `app`),直接通过——`ResolveAlias` 会自动用 team slug 作 fallback。
- 这只校验"namespace 字符串匹配",真正的所有权还要靠 `aliasInfo.TeamID == team.ID` 二次校验。

---

## 七、数据模型(简表)

完整说明见 [template-module.md](./template-module.md)。这里只列与本模块直接相关的表:

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `envs` | `id` (text), `team_id`, `deleted_at` | template 本身 |
| `env_builds` | `id` (uuid), `env_id`, `status_group` | 具体构建 |
| `env_build_assignments` | `env_id`, `build_id`, `tag`, `source`, `created_at` | (template, build, tag) 三元组 M:N |
| `env_aliases` | `env_id`, `alias`, `namespace` | alias 解析表 |

### 7.1 SQL 查询

`packages/db/queries/templates/`:

| 查询 | 文件 | 类型 | 说明 |
| --- | --- | --- | --- |
| `GetTemplateWithBuildByTag` | `get_template_with_build_by_tag.sql` | `:one` | 找 (template, tag) 当前指向的 build。匹配 tag 或 build_id(try_cast_uuid)。JOIN `env_build_assignments` |
| `CreateTemplateBuildAssignment` | `create_template_build_assignment.sql` | `:execrows` | INSERT assignment,带 `FOR SHARE` 锁防并发删除。受影响行数为 0 = template 不存在 |
| `DeleteTemplateTags` | `delete_template_build_assignment.sql` | `:exec` | 批量 DELETE `WHERE tag = ANY(@tags)` |
| `ListTemplateTags` | `list_template_tags.sql` | `:many` | `DISTINCT ON (tag)` 每个 tag 取最新 assignment |

**关键 SQL 细节** —— `CreateTemplateBuildAssignment`(`create_template_build_assignment.sql`):

```sql
-- FOR SHARE serializes against a concurrent DeleteTemplate so a build can't be
-- attached to a soft-deleted env. 0 rows affected means the template is gone.
WITH active AS (
    SELECT id FROM "public"."envs"
    WHERE id = @template_id AND deleted_at IS NULL
    FOR SHARE
)
INSERT INTO "public"."env_build_assignments" (env_id, build_id, tag)
SELECT @template_id, @build_id, @tag::text
WHERE EXISTS (SELECT 1 FROM active);
```

**`FOR SHARE` 锁**:
- 防止并发 `DELETE FROM envs WHERE id = ?` 把 template 软删除。
- 如果 template 已被软删除(`deleted_at IS NOT NULL`),`active` CTE 返回空,`WHERE EXISTS` 失败,INSERT 0 行。
- handler 检测 `rows == 0` → 返 404。

---

## 八、与 alias cache 的闭环

### 8.1 ResolveAlias 的 fallback 逻辑

详见 [2.4](#24-alias-解析的-namespace-回退) 和 [template-module.md 第十章](./template-module.md#十alias-别名解析机制)。

### 8.2 写操作后如何 invalidate

| 端点 | invalidate 范围 |
| --- | --- |
| POST /templates/tags | `for each new tag: Invalidate(templateID, &tag)` |
| DELETE /templates/tags | `for each deleted tag: Invalidate(templateID, &tag)` |
| GET /templates/{id}/tags | (只读,不 invalidate) |
| GET /templates/aliases/{alias} | (只读,不 invalidate) |

**注意**:写 tag **不**失效 alias cache。原因:
- alias cache 的 key 是 `namespace/alias`,value 是 `templateID`。
- alias → templateID 的映射不受 tag 变化影响。
- 但 template cache(`(templateID, tag) → build`)会失效。

`templateCache.Invalidate` 详细签名见 `packages/api/internal/cache/templates/cache.go`。

### 8.3 negative lookup tombstone

`alias_cache.go:37`:

```go
var notFoundTombstone = &AliasInfo{NotFound: true}
```

`ResolveAlias` 不仅缓存 positive 结果(templateID),还缓存 **negative 结果**(templateID 不存在)。这防止攻击者用大量不存在的 alias 反复撞 DB。

TTL 与 positive 一样(5 分钟)。

---

## 九、配置与 Feature Flag

本模块**不直接挂任何 feature flag**。相关 flag(如 `MaxConcurrentTemplateBuilds`)在 template-module.md 详述。

**环境变量**:无专用。整个 alias 缓存依赖 Redis(配置见 auth-module.md)。

---

## 十、关键代码文件索引

### 10.1 handlers(`packages/api/internal/handlers/`)

| 文件 | 主要函数 |
| --- | --- |
| `template_tags.go:24` | `PostTemplatesTags` |
| `template_tags.go:184` | `DeleteTemplatesTags` |
| `template_tags.go:300` | `GetTemplatesTemplateIDTags` |
| `template_alias.go:18` | `GetTemplatesAliasesAlias` |
| `template_alias_test.go` | alias 解析的所有权检查测试 |

### 10.2 id 包(`packages/shared/pkg/id/`)

| 文件 | 主要 API |
| --- | --- |
| `id.go:23-26` | `DefaultTag = "default"`, `TagSeparator = ":"`, `NamespaceSeparator = "/"` |
| `id.go:28` | `Generate()`(uniuri,用于生成 alias) |
| `id.go:50` | `validateTag`(含 UUID 检查) |
| `id.go:65` | `ValidateAndDeduplicateTags` |
| `id.go:82` | `SplitIdentifier`(namespace/alias) |
| `id.go:94` | `ParseName` |
| `id.go:138` | `WithTag` |
| `id.go:143` | `WithNamespace` |
| `id.go:157` | `ValidateNamespaceMatchesTeam` |

### 10.3 cache(`packages/api/internal/cache/templates/`)

| 文件 | 主要 API |
| --- | --- |
| `alias_cache.go:22-23` | `aliasCacheTTL = 5 * time.Minute`, `aliasCacheRefreshInterval = time.Minute` |
| `alias_cache.go:30-35` | `AliasInfo` 结构 |
| `alias_cache.go:71` | `Resolve(identifier, namespaceFallback)` |
| `alias_cache.go:193` | `Invalidate(namespace, alias)` |
| `alias_cache.go:200` | `InvalidateAliasesByTemplateID` |
| `cache.go` | `TemplateCache.Invalidate(templateID, &tag)` |

### 10.4 DB(`packages/db/`)

| 文件 | 查询 |
| --- | --- |
| `queries/templates/get_template_with_build_by_tag.sql` | `GetTemplateWithBuildByTag :one` |
| `queries/templates/create_template_build_assignment.sql` | `CreateTemplateBuildAssignment :execrows` |
| `queries/templates/delete_template_build_assignment.sql` | `DeleteTemplateTags :exec` |
| `queries/templates/list_template_tags.sql` | `ListTemplateTags :many` |
| `migrations/20251218160000_allow_m_n_builds_with_tags.sql` | M:N 表引入 |
| `migrations/20251218170000_optimize_build_assignment_indexes.sql` | 索引优化 |
| `migrations/20260204172712_remove_build_assignment_triggers.sql` | 移除自动同步触发器 |

### 10.5 OpenAPI spec

| 位置 | 内容 |
| --- | --- |
| `spec/openapi.yml:3241` | `/templates/tags` POST + DELETE |
| `spec/openapi.yml:3301` | `/templates/{templateID}/tags` GET |
| `spec/openapi.yml:3332` | `/templates/aliases/{alias}` GET |
| `AssignTemplateTagsRequest` schema | `{target: str, tags: [str]}` |
| `DeleteTemplateTagsRequest` schema | `{name: str, tags: [str]}` |
| `AssignedTemplateTags` schema | `{tags: [str], buildID: uuid}` |
| `TemplateTag` schema | `{tag: str, buildID: uuid, createdAt: datetime}` |
| `TemplateAliasResponse` schema | `{public: bool, templateID: str}` |

---

## 十一、设计要点与权衡

### 11.1 为什么 POST 用事务,DELETE 不用?

- **POST** 要在循环里 `CreateTemplateBuildAssignment`(每 tag 一条 INSERT)。如果第 3 个失败,前 2 个需要回滚,否则留下半成品状态。
- **DELETE** 是单条 SQL(`DELETE WHERE tag = ANY(...)`)。PostgreSQL 保证单条 SQL 原子性,不需要显式事务。

### 11.2 为什么 tag 不能是 UUID?

详见 [2.2](#22-tag-的约束不能是-uuid不能是空)。简而言之:`GetTemplateWithBuildByTag` 同时按 tag 或 build_id 匹配,UUID tag 会引入歧义。

### 11.3 为什么 default tag 不能删?

- **`default` 是约定的"stable"指向**:SDK 默认用 `default` tag 启动 sandbox。
- 如果允许删,SDK 拿不到 default 就崩。
- 历史 trigger(2026-02 之前)会在新 build ready 时自动把 default 移过去;现在应用层管理,但语义保留。

### 11.4 为什么所有权检查要在 tag 探测之前?

详见 [4.4 的关键设计点](#44-get-templatesaliasesalias--按-alias-查-template)。简而言之:**防止非 owner 通过 404 vs 403/200 推断 tag 是否存在**(信息泄漏)。

### 11.5 为什么 alias cache 和 template cache 分开?

- **alias cache**:`(namespace/alias) → templateID`。templateID 几乎不变。
- **template cache**:`(templateID, tag) → build`。build 会随 tag 重新指向而变。
- 两者失效场景不同:删 template 时两者都失效;改 tag 时只后者失效。
- 分开让失效粒度更细,缓存命中率更高。

### 11.6 为什么 ListTemplateTags 用 `DISTINCT ON`?

详见 [4.3](#43-get-templatestemplateidtags--列出所有-tag)。简而言之:M:N 关系下一个 tag 可能指向过多个 build 历史,但当前生效的只有最新一条。

### 11.7 为什么 POST 不接受 alias 重命名?

POST 只能"给已有 build 加 tag",不能改 alias 本身。alias 管理(创建、删除、转移 namespace)走另一个端点(`POST /templates/{id}/aliases` 之类,见 template-module.md)。

职责分离,避免一个端点承担太多语义。

### 11.8 为什么 DELETE 找不到 tag 不返 404?

DELETE 的语义是"确保这些 tag 没了"。如果 tag 本来就不存在,目标已达成,返 204(幂等)。这与 RESTful 惯例一致:DELETE 应该幂等。

### 11.9 为什么不在 POST 里也用 `try_cast_uuid`?

`GetTemplateWithBuildByTag` SQL 用 `try_cast_uuid` 让 tag 字段同时匹配 build_id。但 `validateTag` 已经在输入校验阶段拒绝 UUID tag。

两层防护:输入校验 + SQL 兼容。即使输入校验被绕过(老客户端),SQL 也不会乱匹配。

### 11.10 为什么 GET alias 不返 build_id?

```json
{"public": false, "templateID": "uuid-of-template"}
```

响应里只有 `templateID`,没有 `build_id`。原因:
- alias 是 template 级别的概念,与具体 build 无关。
- 想拿当前 build,需要再调 `GET /templates/{id}` 或带上 tag 走 `GET /templates/aliases/app:v1`(这时 SQL 会验证 tag 存在,但仍不返 build_id)。
- 设计哲学:**alias 端点只回答"是否存在 + 谁拥有",不回答"当前指向什么"**。

---

## 十二、常见问题与排查

### Q1: 用户报告 "POST /templates/tags 返 400 'namespace X must match your team Y'"

**说明**:`target` 里显式 namespace 与当前 team 不匹配。

**处理**:
- 检查 target 是否传错了(例如复制了 `other-team/app` 而不是 `app`)。
- 提醒用户:不传 namespace 也行,系统会自动用 team slug 作 fallback。

### Q2: 用户报告 "POST 返 404 'Template X with tag Y not found'"

**说明**:`GetTemplateWithBuildByTag` 找不到当前指向的 build。可能原因:
- tag 还没创建过(例如 target 写 `app:production` 但 production tag 不存在)。
- build 还没 ready(`status_group != 'ready'`,SQL 显式过滤)。
- template 被软删了。

**排查**:
```sql
SELECT eba.tag, eb.id, eb.status_group
FROM env_build_assignments eba
JOIN env_builds eb ON eb.id = eba.build_id
WHERE eba.env_id = '<templateID>';
```

### Q3: 用户报告 "DELETE 返 400 'Cannot delete the default tag'"

**说明**:用户试图删 `default` tag,这是受保护的。

**处理**:不能删。如果想让 default 指向别的 build,用 POST 重新分配(把 default 加到新 build)。但这通常不该手动做——build 流程会自动管理 default。

### Q4: 用户报告 "DELETE 返 400 'Template name should not contain a tag'"

**说明**:`name` 字段里包含了 `:tag`。例如 `"my-app:v1"`。

**处理**:DELETE 的 `name` 只是 template 标识,不带 tag。要删的 tag 在 `tags` 数组里。

```json
// 错误
{"name": "my-app:v1", "tags": ["..."]}

// 正确
{"name": "my-app", "tags": ["v1"]}
```

### Q5: 用户报告 "GET /templates/aliases/X 返 403 'You don't have access'"

**说明**:template 之前属于该 team,后被转移。

**处理**:
- 用户无能为力——这个 template 已经不属于他的 team。
- 如果是误转移,需要 admin 联系支持改回。

### Q6: 用户报告 "GET /templates/aliases/app:v1 返 404 'tag v1 does not exist'"

**说明**:alias `app` 存在(所有权 OK),但 tag `v1` 不存在。

**处理**:
- 检查 tag 是否拼对(`v1` vs `v1.0` vs `V1`)。
- 用 `GET /templates/{id}/tags` 列出所有可用 tag。

### Q7: 用户报告 "POST 创建了部分 tag,有的没创建"

**说明**:这不应该发生——handler 用事务,要么全成功要么全失败。如果出现部分成功,说明:
- 客户端在多次重试中部分成功(网络抖动)。
- 或代码 bug(理论上不可能,事务保证)。

**处理**:
- 用 `GET /templates/{id}/tags` 查当前状态。
- 重新 POST 缺失的 tag(幂等)。

### Q8: 内部服务能否用 admin 代调?

**可以**。所有 4 个端点都接受 `AdminApiKeyAuth + AdminTeamAuth` 兜底。流程与 OIDC 路径一致,只是 team 来源不同(path param 而非 ctx)。

### Q9: tag 数量有上限吗?

- **代码层面**没有硬上限(`ValidateAndDeduplicateTags` 接受任意长度的 slice)。
- **实际**受 body 大小限制(RequestSizeLimiter 中间件)。
- **建议**:单次请求不超过 10 个 tag,避免 DB 压力。

### Q10: 如何审计 tag 变更?

- **Posthog 事件**:`assigned template tag` / `deleted template tags`(POST/DELETE 成功后埋点,带 tag 列表和 templateID)。
- **DB 层**:`env_build_assignments` 表的 `created_at` 字段。
- **不记录 who**:目前 posthog 事件只 identify 到 team,不到 user。如果需要 user 级审计,要在 handler 里加 `WithUserID` 属性。

---

## 附录 A:端点速查表

### A.1 4 个端点

| 端点 | 方法 | OpenAPI tag | 成功 | 失败常见码 |
| --- | --- | --- | --- | --- |
| `/templates/tags` | POST | tags | 201 + `AssignedTemplateTags` | 400, 401, 403, 404, 500 |
| `/templates/tags` | DELETE | tags | 204(无 body) | 400, 401, 403, 404, 500 |
| `/templates/{templateID}/tags` | GET | tags | 200 + `[]TemplateTag` | 400, 401, 403, 404, 500 |
| `/templates/aliases/{alias}` | GET | templates | 200 + `TemplateAliasResponse` | 400, 401, 403, 404, 500 |

### A.2 输入字段对照

| 字段 | 出现在 | 含义 | 是否含 tag |
| --- | --- | --- | --- |
| `target` | POST /templates/tags | "给这个 tag 当前指向的 build 加新 tag" | **可含**(默认 `default`) |
| `name` | DELETE /templates/tags | "从哪个 template 删 tag" | **不可含**(用 tags 字段) |
| `templateID` (path) | GET /templates/{id}/tags | 列出哪个 template 的 tag | 忽略(只解析 identifier) |
| `alias` (path) | GET /templates/aliases/{alias} | 查询的 alias | **可含**(同时探测 tag 存在) |

### A.3 tag 生命周期状态机

```
   (CI/CD build ready)
       │
       │ trigger 自动加 default
       ▼
   ┌────────┐
   │ default │ (受保护,不可 DELETE)
   └────────┘
       │
       │ POST /templates/tags
       │   target: "app:default"
       │   tags: ["v1", "production"]
       ▼
   ┌──────────────┐
   │ v1, production│ (新增)
   └──────────────┘
       │
       │ DELETE /templates/tags
       │   name: "app"
       │   tags: ["v1"]   (default 不能删)
       ▼
   ┌──────────────┐
   │ production   │ (v1 已删)
   └──────────────┘
```

---

## 附录 B:错误码与 HTTP 状态映射

| 场景 | HTTP | 说明 |
| --- | --- | --- |
| Body 解析失败 | 400 | "Invalid request body: ..." |
| tags 数组为空 | 400 | "At least one tag is required" |
| tag 是 UUID | 400 | "tag cannot be a UUID" |
| tag 含非法字符 | 400 | "invalid tag '...'" |
| `default` tag 被尝试删除 | 400 | "Cannot delete the 'default' tag" |
| DELETE 的 name 含 tag | 400 | "Template name should not contain a tag, use the 'tags' field instead" |
| namespace 与 team 不匹配 | 400 | "namespace 'X' must match your team 'Y'" |
| 未鉴权 | 401 | (中间件返回) |
| template 不属于当前 team | 403 | "You don't have access to..." |
| template 或 tag 不存在(对当前 user 而言) | 404 | "Template 'X' with tag 'Y' not found" |
| DB 错误 | 500 | "Error ..." |
| 成功(POST) | 201 | JSON `{tags, buildID}` |
| 成功(DELETE) | 204 | 无 body |
| 成功(GET) | 200 | JSON 数组或对象 |

---

## 附录 C:术语表

| 术语 | 含义 |
| --- | --- |
| **template** | 在 DB 里叫 `envs`,代表一个可启动的沙箱模板 |
| **template build** | 在 `env_builds` 表,每次 `e2b template build` 产生一个 |
| **tag** | 字符串标签,如 `default`、`v1.2.3`、`production`,指向某个 build |
| **alias** | 在 `env_aliases` 表,把 `[namespace/]alias` 字符串映射到 template |
| **assignment** | `env_build_assignments` 表的行,记录 (template, build, tag) 三元组 |
| **default tag** | 特殊 tag,每个 template 都有,受保护不能删 |
| **namespace** | alias 的前缀,通常等于 team slug |
| **bare alias** | 不带 namespace 的 alias(如 `my-app`),系统自动加 team slug |
| **promoted template** | namespace 为 NULL 的全局可见 template(回退路径) |
| **`id.ParseName`** | 解析 `[ns/]alias[:tag]` 字符串,返回 `(identifier, tag, err)` |
| **`id.ValidateAndDeduplicateTags`** | 校验 tag 格式(非 UUID)+ 去重 |
| **alias cache** | Redis 缓存,`alias → templateID`,TTL 5 分钟,refresh 1 分钟 |
| **template cache** | Redis 缓存,`(templateID, tag) → build`,tag 级失效 |
| **negative tombstone** | 缓存"alias 不存在"的结果,防止 DB 撞库 |
| **`try_cast_uuid`** | SQL helper,把 text 安全转 UUID(失败返 NULL),让 tag 字段兼容 build_id 匹配 |
| **`FOR SHARE` 锁** | PostgreSQL 行锁,`CreateTemplateBuildAssignment` 用它防并发删除 |
| **所有权检查** | `aliasInfo.TeamID == team.ID`,防止跨 team 访问 |
| **tag 探测** | GET alias 含 `:tag` 时,额外查 tag 是否存在 |
| **M:N 关系** | 多个 build 共享同一 tag(但只有最新一个被 ResolveAlias 返回) |
