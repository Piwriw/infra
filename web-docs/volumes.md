# 存储卷（Volumes）管理详解

> 本文覆盖 E2B 平台**持久化存储卷**的全栈实现:数据库表、API REST 接口、Orchestrator gRPC 服务、安全隔离机制(mount namespace + chroot)、以及 sandbox 内的 NFS 挂载流程。
>
> 代码位置:
> - 数据库:`packages/db/migrations/20260304120000_volumes.sql`、`packages/db/queries/volumes/`
> - API:`packages/api/internal/handlers/volume_*.go`、`packages/api/internal/cfg/model.go`
> - Orchestrator gRPC:`packages/orchestrator/volume.proto`、`packages/orchestrator/pkg/volumes/`
> - 安全隔离:`packages/orchestrator/pkg/chrooted/`
> - NFS 网关:`packages/orchestrator/pkg/nfsproxy/chroot/`
> - OpenAPI:`spec/openapi.yml` `/volumes` 路径
>
> 数据来源:代码与 OpenAPI 规范,**已同步至 2026.30**。行号均按 tag `2026.30` 核对;与 2026.29 有差异处标注为「行 N(2026.30;2026.29 为 M)」。

## 0. 2026.30 变动速览

| 变动 | 说明 | 详见 |
| --- | --- | --- |
| **创建流程重排,不再用 DB 事务** | 先生成 volume UUID → 调 orchestrator 创建目录 → **由 orchestrator 回传权威 `volume_type`** → 再写 DB 行。DB 唯一约束冲突时后台清理已建的 orchestrator volume | §3.1 |
| **`getVolumeType` 支持按 region 解析** | 签名改为 `getVolumeType(ctx, team)`,优先级:LD flag → 有 `ClusterID` 时的 placeholder → region map → 全局默认 | §3.1 |
| **健康判定换成 `CanAcceptNewRequests()`** | region 解析在挑节点时不再看 `Status() != Ready` | §3.1 |
| **token 的 `aud` 从 cluster UUID 改成 `https://api.<domain>`** | 与 SDK 实际请求的 host 对齐 | §4 |
| **`CreateVolumeResponse` 新增 `volume_type`** | proto 加 `optional string volume_type = 1`,SQL 的 `CreateVolume` 改为显式传入 `id` | §3.1 |
| **路径穿过普通文件时报 400** | `syscall.ENOTDIR`(`file.txt/sub` 这类)以前落到通用 500,现在映射为 `INVALID_REQUEST` | §6 |
| **响应新增 `Domain` 字段** | 两个端点都回传 SDK 应使用的目标域名(BYOC 集群的 `SandboxDomain`,默认集群为 nil) | §3.1、§4 |

> ⚠️ **DB 不再是 volume 的"第一事实源",orchestrator 才是。** 2026.30 的创建顺序是「先建目录、再落库」,`volume_type` 也由 orchestrator 回传决定(旧版 orchestrator 留空时才回落到请求里的值)。所以**落库的 `volume_type` 可能与客户端请求的不一致**——这是设计,不是 bug。
>
> ⚠️ **`getVolumeType` 的 region 解析是 opt-in。** 没有配 `DEFAULT_PERSISTENT_VOLUME_TYPE_BY_REGION` 时**不会去遍历集群节点**。而且只有当节点标签恰好命中**唯一一个** region 时才生效:零个(标签还没打到任何节点)或多个(标签没钉死 region)都会回落到全局默认。
>
> ⚠️ **region 只来自节点标签,不来自 team。** 代码里写得很直白:"Regions live on nodes, never on teams"。节点标签里 region 的前缀是 `region=`;没有自己的 scheduling label 的 team 走 `default` pool。
>
> ⚠️ **`volume_type` 里的 `PlaceholderPersistentVolumeType`(`__DEFAULT_VOLUME_TYPE__`)是有意为之的占位符。** team 有 `ClusterID` 时会先返回它,等 orchestrator 把它解析成真实类型再回传——这就是 `CreateVolumeResponse.volume_type` 存在的理由。

---

## 1. 概览

E2B 的 sandbox 是**临时的、无状态**的 Firecracker microVM — 一旦销毁,内存和文件系统全部丢失。但很多 AI 工作流需要跨 sandbox 共享或持久化数据(数据集、pip 缓存、模型权重、用户上传)。**Volumes** 就是为此提供的"团队级持久存储"。

### 1.1 关键特征

| 特性 | 实现 |
| --- | --- |
| **生命周期** | 与 team 绑定,独立于 sandbox。sandbox 销毁后数据仍在 |
| **作用域** | 团队级(team-scrolled),team 内 sandbox 可挂载 |
| **数据布局** | `<volume-type-root>/team-<teamID>/vol-<volumeID>/` |
| **后端可插拔** | 通过 `volume_type` 区分(NFS / 本地盘 / ...),orchestrator 节点按类型 label 调度 |
| **访问协议** | Sandbox 内通过 NFSv3 经 `nfsproxy` 访问;外部通过 REST/gRPC 管理 |
| **安全隔离** | 每次 FS 操作在专用 mount namespace + chroot 中执行,防止逃逸 |
| **认证** | API 签发短期 JWT(volume content token),客户端凭 token 直接读写 |
| **总开关** | LD flag `PersistentVolumesFlag`(`flags.go:277`,`can-use-persistent-volumes`)关闭时所有 volume API 返回 403 |
| **BYOC 域** | 团队挂在自定义集群上时,响应携带 `domain`,客户端须改打 `https://api.<domain>`(见 §3.5) |

### 1.2 系统分层

```
┌──────────────────────────────────────────────────────────────────┐
│  客户端                                                            │
│  SDK / CLI / 浏览器 → REST /volumes                                │
└──────────────┬───────────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  API 层 (packages/api)                                             │
│  PostVolumes / GetVolumes / GetVolumesVolumeID / DeleteVolumes... │
│  ─ LD flag 闸门 + 校验 + DB 写入 + 签 JWT                          │
│  ─ 节点选择:按 volume-type label 亲和性路由到 orchestrator         │
└──────────┬─────────────────────────────────┬─────────────────────┘
           │                                 │
       SQL (volumes 表)                  gRPC (VolumeService)
           │                                 │
           ▼                                 ▼
┌────────────────────────┐    ┌─────────────────────────────────────┐
│  PostgreSQL             │    │  Orchestrator (packages/volumes)     │
│  volumes 表              │    │  ─ CreateVolume / DeleteVolume       │
│  id / team_id / name /   │    │  ─ CreateDir / ListDir               │
│  volume_type / created_at│    │  ─ CreateFile (stream) / GetFile     │
│  UNIQUE(team_id, name)   │    │  ─ DeletePath / StatPath / UpdatePath│
└────────────────────────┘    │  ─ 每次操作经 chrooted.Builder        │
                               └──────────────┬──────────────────────┘
                                              ▼
                               ┌─────────────────────────────────────┐
                               │  chrooted (mount namespace)          │
                               │  ─ Unshare(CLONE_NEWNS)              │
                               │  ─ bind mount + pivot_root + chroot  │
                               │  ─ 单线程串行化所有 FS 操作            │
                               └──────────────┬──────────────────────┘
                                              ▼
                               ┌─────────────────────────────────────┐
                               │  持久化后端                            │
                               │  <volume-type-root>/team-X/vol-Y/    │
                               └─────────────────────────────────────┘

Sandbox 运行时:
   envd ── NFSv3 ──▶ nfsproxy ──▶ sandbox.Map.GetByHostPort ──▶ 匹配
                       VolumeMount ──▶ builder.Chroot ──▶ 文件 IO
```

---

## 2. 数据模型

### 2.1 数据库表

`packages/db/migrations/20260304120000_volumes.sql`:

```sql
CREATE TABLE IF NOT EXISTS volumes (
    id          UUID                        PRIMARY KEY     DEFAULT gen_random_uuid(),
    team_id     UUID                        NOT NULL,
    name        VARCHAR(250)                NOT NULL,
    volume_type VARCHAR(250)                NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE    NOT NULL        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_volumes_teams
        FOREIGN KEY (team_id)
        REFERENCES teams(id),

    CONSTRAINT volumes_teams_uq
        UNIQUE (team_id, name)
);
```

要点:
- `id` 数据库自动生成 UUID,作为对外的 `volumeID`
- `(team_id, name)` 唯一约束:同一 team 内卷名不能重复
- `volume_type` 字符串,对应 orchestrator 的 `PERSISTENT_VOLUME_MOUNTS` 中的 key(如 `nfs`、`local-ssd`、`test-volume-type`)
- 没有 `updated_at`、`deleted_at`、`size`、`description` 等字段 — 卷是**纯目录**,元数据极简

### 2.2 SQL 查询

`packages/db/queries/volumes/volumes.sql`:

```sql
-- name: CreateVolume :one
INSERT INTO volumes (team_id, volume_type, name)
VALUES (@team_id, @volume_type, @name)
RETURNING *;

-- name: GetVolume :one
SELECT * FROM volumes WHERE id = @volume_id AND team_id = @team_id;

-- name: GetVolumesByName :many
SELECT * FROM volumes WHERE team_id = @team_id AND name IN (
    SELECT UNNEST(@volume_names::text[])
);

-- name: FindVolumesByTeamID :many
SELECT * FROM volumes WHERE team_id = @team_id;

-- name: DeleteVolume :exec
DELETE FROM volumes WHERE team_id = @team_id AND id = @volume_id;
```

所有查询都带 `team_id` 过滤 — **数据库层就强制了 team 隔离**,即使攻击者拿到 volume_id 也无法跨 team 读/删。

---

## 3. API 层 (REST)

### 3.1 端点

| 方法 | 路径 | 用途 | 返回 |
| --- | --- | --- | --- |
| `POST` | `/volumes` | 创建卷 | `VolumeAndToken` (201) |
| `GET` | `/volumes` | 列出团队所有卷 | `[]Volume` (200) |
| `GET` | `/volumes/{volumeID}` | 获取单个卷(重新签 token) | `VolumeAndToken` (200) |
| `DELETE` | `/volumes/{volumeID}` | 删除卷 | (204) |

Schema(`spec/openapi.yml`):
```yaml
Volume:        { volumeID, name }                          # :2209
NewVolume:     { name }                                    # :2246
VolumeAndToken: { volumeID, name, token, domain }           # :2222;token 是短时 JWT
SandboxVolumeMount: { name, path }                          # :727;sandbox 创建时声明挂载
```

`VolumeAndToken.domain`(openapi.yml:2234-2243,**必填列表里没有它**):

```yaml
domain:
  type: string
  description: |
    Domain to use as the destination for volume content requests,
    replacing the default `api.<E2B_DOMAIN>`. Only returned when the
    team is connected to a custom (BYOC) cluster; absent otherwise, in
    which case the default domain is used.
```

> ⚠️ `domain` 是 **optional** 的(不在 `required` 中,`required` 块为 `:2241-2244`,只有 `volumeID`/`name`/`token`),只有团队挂在 BYOC 集群上时才出现。客户端必须把"缺省"当作"用默认 `api.<E2B_DOMAIN>`",不能当作错误。同一字段也出现在 sandbox 相关 schema 里(`:769`、`:817`)。

### 3.2 创建卷 — `PostVolumes`

`packages/api/internal/handlers/volume_create.go` 流程:

```
1. GetTeam (从 API key / cluster auth)
2. 检查 LD flag PersistentVolumesFlag,关闭 → 403 "use of volumes is not enabled"   (:42-46)
3. 检查 VolumesToken 是否配置完整,未配置 → 501 (ErrVolumesTokenNotConfigured)      (:50-55)
4. 解析 + 校验 body:名称正则 ^[a-zA-Z0-9_-]+$,不合法 → 400                       (:58-75)
5. 解析 volume_type = getVolumeType(ctx, team)                                     (:82)
     - 空字符串 → 500 "No persistent volume type is configured"
6. 解析 clusterID;再解析 BYOC domain = volumeContentDomain(team)                   (:90-100)
     - 集群找不到 → 503 "Cluster not found"(在分配任何资源之前失败)
7. 先构造"打算创建的"卷身份(客户端侧生成 UUID)                                    (:106-111)
8. createVolume(clusterID, volume) → 路由到 orchestrator                            (:113)
     - gRPC VolumeService.CreateVolume,orchestrator 实际 MkdirAll 卷目录
     - ErrClusterNotFound → 503;ErrUnknownVolumeType → 500;其他 → 500
9. **用 orchestrator 返回的 volume_type 覆盖**(若非空)                              (:135-140)
10. sqlcDB.CreateVolume(...)                                                        (:142)
     - 唯一约束冲突 → cleanupOrchestratorVolume + 400 "Volume with name '%s' already exists"
     - 其他错误   → cleanupOrchestratorVolume + 500
11. Posthog 事件 "created_volume"                                                    (:169-175)
12. generateVolumeContentToken(..., a.volumeTokenAudience(domain)) (签 JWT)          (:177)
13. 返回 201 + VolumeAndToken{VolumeID, Name, Token, Domain}                         (:185-192)
```

**关键防御**:
- `VolumesToken.IsConfigured()` 在第 3 步预检(注释 `:48-49`),避免"卷已创建但无法签 token"的窘境
- `volumeContentDomain` 在第 6 步预检(注释 `:92-93`),避免"资源已分配但团队集群找不到"

#### 2026.30 变动:创建流程重排(不再用 DB 事务)

> ⚠️ **本文档此前写错了。** 旧版本描述的是「先开 DB 事务 → 先写 DB 行 → 再调 orchestrator → 提交事务,提交失败则异步回滚」的流程。**2026.30 已经没有 DB 事务了**,而且顺序整个反了过来。

**新顺序是"先 orchestrator,后 DB"**,原因写在 `:102-105` 的注释里:卷的 ID 现在**提前生成**,好把它交给 orchestrator;orchestrator 有机会**调整这些值**(比如解析一个 placeholder volume type),然后返回**权威值**由 API 持久化。

具体差异:

| 维度 | 2026.29(旧文档描述) | 2026.30 |
|---|---|---|
| DB 事务 | 有(`tx.Commit()`) | **无** |
| 调用顺序 | DB 写入 → orchestrator | **orchestrator → DB 写入** |
| volume_type | API 决定后写库 | API 决定 → 交给 orchestrator → **以 orchestrator 返回值覆盖**(`response.GetVolumeType()`,`:138-140`);老版本 orchestrator 返回空则回退到 API 发送的值 |
| ID 生成 | 由 DB `DEFAULT gen_random_uuid()` | **API 侧 `uuid.New()` 提前生成**(`:107`),随请求发给 orchestrator |
| 失败回滚 | `tx.Rollback()` | `cleanupOrchestratorVolume`(`:290-296`)——**best-effort 后台删除**已经建出来的 orchestrator 目录 |

`cleanupOrchestratorVolume` 的实现:

```go
func (a *APIStore) cleanupOrchestratorVolume(ctx context.Context, clusterID uuid.UUID, volume queries.Volume) {
    go func(ctx context.Context) {
        if err := a.deleteVolume(ctx, clusterID, volume); err != nil {
            telemetry.ReportCriticalError(ctx, "failed to clean up volume after failing to persist it", err)
        }
    }(context.WithoutCancel(ctx))
}
```

注意 `context.WithoutCancel(ctx)`——API 请求的 context 可能已经取消,但清理必须跑完。注释(`:287-289`)说明意图:在 DB 行落库之前就建出来的 orchestrator 卷,如果不管就会**泄漏底层目录**,所以做后台 best-effort 删除,失败只记日志。

#### 2026.30 变动:`getVolumeType` 支持按 region 解析

签名变为 `getVolumeType(ctx context.Context, team *types.Team) string`(`volume_create.go:214`),**优先级从两级变成三级**(注释 `:206-213`):

1. **LD flag `DefaultPersistentVolumeType`**(`flags.go:847`,`default-persistent-volume-type`)非空 → 直接用
2. **团队有 `ClusterID`** → 返回 `config.PlaceholderPersistentVolumeType`(`:219-221`)。这是一个**占位值**,真正的类型由 orchestrator 解析并通过 `response.GetVolumeType()` 回传
3. **按 region 的默认值**(`:223-268`):
   - 若 `config.DefaultPersistentVolumeTypeByRegion` 为空或 `a.orchestrator == nil` → 直接返回 `config.DefaultPersistentVolumeType`(注释 `:223-224`:区域默认是 opt-in 的,没有 map 就不该去走集群)
   - 否则在团队会被调度到的那批节点上收集 `region=<name>` 标签(`regionNodeLabelPrefix = "region="`,`:199`)
   - **只有恰好解析出 1 个 region** 且该 region 在 map 里 → 返回映射值;0 个(标签还没匹配上)或 ≥2 个(标签没能钉住 region)→ 落回全局默认(`:257-266`)
4. 兜底:`config.DefaultPersistentVolumeType`

关键设计点(注释 `:210-213`):**节点标签只回答"团队跑在哪",而"那里新卷应该是什么类型"是策略问题,只来自 region map。** 所以一个挂载了多种 volume type 的 region 永远不需要运行期猜测。

节点筛选用的是 `node.CanAcceptNewRequests()`(`:241`)而非旧版的 `node.Status() != Ready`;标签子集判定用 `hasAllLabels`(`:271-279`)。`requiredLabels` 来自 `team.SandboxSchedulingLabels`,为空时回退到 `defaultSchedulingLabel = "default"`(`:203`),**与 `generateRequiredNodeLabels` 的语义对齐**(注释 `:229-231`)。

`config` 侧新增两个字段:`PlaceholderPersistentVolumeType` 与 `DefaultPersistentVolumeTypeByRegion`(见 §8.1)。

### 3.3 删除卷 — `DeleteVolumesVolumeID`

`volume_delete.go`:

```
1. getVolume (从 DB 取,带 team_id 过滤)
2. sqlcDB.DeleteVolume  ← 先删 DB 行
3. 异步 go deleteVolume → orchestrator.DeleteVolume (RemoveAll)
     - 即使 gRPC 失败也不阻塞 API 返回
     - 失败仅打 critical log,等下次清理
4. 返回 204
```

**先 DB 后存储**的设计:DB 行先删,确保该卷立即对外不可见;orchestrator 端的目录删除异步进行,失败时虽然有孤儿目录,但已无 volume_id 引用,后续可被清理任务回收。

### 3.4 节点亲和性调度 — `executeOnOrchestratorByClusterID`

`volume_util.go:118` 是卷操作的节点选择核心:

```go
volumeLabel := internal.MakeVolumeTypeLabel(volume.VolumeType)
// → "persistent-volume-type=<type>"                                       (:133)

labeledNodes, otherNodes := findNodesByVolumeLabel(nodes, volumeLabel)     (:134)
rand.Shuffle(len(labeledNodes), ...)  // 同优先级节点随机                    (:135)
rand.Shuffle(len(otherNodes), ...)                                         (:136)

// LD flag 控制是否回退到未标记节点                                          (:141-146)
if fallbackToUnmatched { nodes = append(labeledNodes, otherNodes...) }      (:148-151)

for _, node := range nodes {
    if !node.CanAcceptNewRequests() { skippedNodeCount++; continue }        (:174-178)
    c, clientCtx := node.GetClient(ctx)                                     (:180)
    err := fn(clientCtx, c)
    if err == nil { return nil }  // 成功
    if isUnknownVolumeTypeError(err) { /* 记录,试下一节点 */ continue }      (:198-203)
    if isRetryableError(err) { continue }  // net.ErrClosed / DeadlineExceeded (:205-209)
    return err  // 不可重试错误,直接返回                                      (:211)
}

// 所有可达节点都返回 UnknownVolumeType
if receivedUnknownVolumeTypeErrors == len(nodes)-skippedNodeCount && receivedUnknownVolumeTypeErrors > 0 {
    return ErrUnknownVolumeType: <type>                                     (:214-215)
}
```

**两类错误处理**:
- `UnknownVolumeTypeError`(orchestrator 不认识这个 volume type):**重试**,因为集群里可能有其他节点认识
- 网络错误(`net.ErrClosed`、`DeadlineExceeded`):**重试**
- 其他错误(权限、参数等):**不重试**,直接失败

**LD flag `VolumeFallbackToUnmatchedNodesFlag`**:迁移期用。当集群逐步上 volume-type label 时,允许未标记节点作为兜底,避免新卷类型上线时所有节点都失败。注释(`:138-140`)说明了最终目标:等每个节点都打上 label 后,未标记节点是 100% 失败的,所以这个 flag 就是用来关掉(并最终删除)兜底路径的。

#### 2026.30 变动:健康判定从 `Status() != Ready` 改为 `CanAcceptNewRequests()`

```go
// 2026.29
if node.Status() != api.NodeStatusReady {
    notReadyNodeCount++
    continue
}

// 2026.30
// Only nodes that can take new requests serve volume content
if !node.CanAcceptNewRequests() {
    skippedNodeCount++
    continue
}
```

`CanAcceptNewRequests()` 比"状态等于 Ready"更严格——它同时排除了**正在 draining / 达到容量上限**的节点,这类节点状态仍是 Ready 但不应再接新的卷操作。配套把计数器从 `notReadyNodeCount` 改名为 `skippedNodeCount`(`:156`),因为它现在计的不只是"未就绪"。

> ⚠️ `skippedNodeCount` 参与最终判定 `receivedUnknownVolumeTypeErrors == len(nodes)-skippedNodeCount`(`:214`)——即"**所有被尝试过的节点**都返回了 UnknownVolumeType"才算 `ErrUnknownVolumeType`。如果跳过的节点变多,这个等式的右边就变小,更容易判定为"全部未知类型"。这是有意的:被跳过的节点本来也没被问过。

### 3.5 Volume Content Token (JWT)

`volume_token.go:23` + `cfg.VolumesTokenConfig`:

```go
claims := jwt.MapClaims{
    // 标准 claims
    "aud": audience, "exp": expiration, "iat": now,                 // (:37-39)
    "iss": config.Issuer, "jti": uuid, "nbf": now, "sub": teamID,   // (:40-43)
    // 自定义 claims
    "teamid":  teamID,                                              // (:46)
    "volid":   volumeID,                                            // (:47)
    "voltype": volumeType,                                          // (:48)
}
token.Header["kid"] = config.SigningKeyName    // 标准 JOSE/JWKS key selection   (:54)
token.Header["tokid"] = config.SigningKeyName  // 旧 verifier 向后兼容            (:55)
```

`kid` 是标准 JWT header,用于 verifier 从 JWKS 或 key set 中选择签名密钥。`tokid` 暂时保留给旧客户端/验证器;两者当前写入相同的 `SigningKeyName`,新集成应读取 `kid`。

#### 2026.30 变动:`aud` 从 cluster UUID 改为 `https://api.<domain>`

> ⚠️ **本文档此前写错了。** 旧版本写的是 `"aud": clusterID`。2026.30 起 `aud` 是一个**完整的 origin 字符串**。

```go
// 2026.29
clusterID := clusters.WithClusterFallback(team.ClusterID)
"aud": clusterID.String(),

// 2026.30
"aud": audience,   // = "https://api.<domain>"
```

`generateVolumeContentToken` 新增第 4 个参数 `audience string`(`volume_token.go:23`),由 `volumeTokenAudience`(`volume_util.go:105-112`)构造:

```go
func (a *APIStore) volumeTokenAudience(domain *string) string {
	host := a.config.DomainName
	if domain != nil && *domain != "" {
		host = *domain
	}

	return fmt.Sprintf("https://api.%s", host)
}
```

即:**BYOC 团队**用其集群 domain,其余用部署默认 `a.config.DomainName`;两者都前缀 `https://api.`。注释(`:100-104`)说明这是为了"与 token 实际被出示的 host 保持一致"。

配套新增 `volumeContentDomain(team)`(`volume_util.go:87-98`),负责把 `team.ClusterID` 解析成集群的 `SandboxDomain`;团队不在 BYOC 集群上时返回 `nil, nil`。调用链见 §3.2 第 6 步与第 12 步。

> ⚠️ **迁移含义**:2026.29 签出的 token 其 `aud` 是 cluster UUID,2026.30 是 origin URL。**验证端若按 `aud == clusterID` 校验,升级后会全部失败。** 验证端应以 `https://api.<期望域名>` 作为期望 audience。

| 配置项 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `Enabled` | `VOLUME_TOKEN_ENABLED` | `true` | 总开关 |
| `Issuer` | `VOLUME_TOKEN_ISSUER` | — | 签发方 |
| `SigningMethod` | `VOLUME_TOKEN_SIGNING_METHOD` | — | 如 `HS256` |
| `SigningKey` | `VOLUME_TOKEN_SIGNING_KEY` | — | 密钥 |
| `SigningKeyName` | `VOLUME_TOKEN_SIGNING_KEY_NAME` | — | key ID(kid) |
| `Duration` | `VOLUME_TOKEN_DURATION` | `1h` | 有效期 |

`validate()` 在 startup 时检查:`Enabled=true` 但任一字段缺失就 fail-fast。

每次 `POST /volumes` 和 `GET /volumes/{id}` 都会重新签发短时 JWT,客户端用它直接访问卷内容(不经过 API)。

---

## 4. Orchestrator gRPC 服务

### 4.1 服务定义

`packages/orchestrator/volume.proto`:

```protobuf
service VolumeService {
  // volume 操作
  rpc CreateVolume(CreateVolumeRequest) returns (CreateVolumeResponse);
  rpc DeleteVolume(DeleteVolumeRequest) returns (DeleteVolumeResponse);

  // 目录操作
  rpc CreateDir(CreateDirRequest) returns (CreateDirResponse);
  rpc ListDir(ListDirRequest) returns (ListDirResponse);

  // 文件操作
  rpc CreateFile(stream CreateFileRequest) returns (CreateFileResponse);
  rpc GetFile(GetFileRequest) returns (stream GetFileResponse);

  // 路径操作(文件 / 目录 / 符号链接通用)
  rpc DeletePath(DeletePathRequest) returns (DeletePathResponse);
  rpc StatPath(StatPathRequest) returns (StatPathResponse);
  rpc UpdatePath(UpdatePathRequest) returns (UpdatePathResponse);
}
```

**消息设计要点**:
- `EntryInfo` 字段:`name(1)` / `type(2)` / `path(3)` / `size(4,int64)` / `mode(5,uint32)` / `uid(6,uint32)` / `gid(7,uint32)` / `modified_time(8)` / `symlink_target(9,optional)` / `created_time(10)` / `accessed_time(11)`。**注意 proto 字段是 `uid/gid`(数字 ID),不是 `owner/group`(用户/组名)**;三个时间字段(`modified_time/created_time/accessed_time`)都是 `google.protobuf.Timestamp`
- `FileType` 枚举:FILE_TYPE_UNSPECIFIED (默认 0) / FILE_TYPE_FILE / FILE_TYPE_DIRECTORY / FILE_TYPE_SYMLINK
- `UserErrorCode`:UNKNOWN_USER_ERROR_CODE (默认 0) / PATH_NOT_FOUND / PATH_ALREADY_EXISTS / CANNOT_DELETE_ROOT / NOT_SUPPORTED / DEPTH_OUT_OF_RANGE / INVALID_REQUEST
- `UserError` 同时携带 gRPC code 和建议的 HTTP status,方便 API 透传
- `UnknownVolumeTypeError`:特殊错误类型,带详细 volume type 字符串,用于节点亲和性重试

### 4.2 Service 结构

`packages/orchestrator/pkg/volumes/service.go`:

```go
type Service struct {
    orchestrator.UnimplementedVolumeServiceServer
    builder *chrooted.Builder
    config  cfg.Config
}

const (
    defaultDirMode  os.FileMode = 0o777
    defaultFileMode os.FileMode = 0o666
    defaultOwnerID  uint32      = 9090  // 默认 uid
    defaultGroupID  uint32      = 9090  // 默认 gid
)
```

`9090` 是 sandbox 内默认非 root 用户的 uid/gid — 跨 sandbox 一致,确保文件归属稳定。

### 4.3 路径解析

每个文件/目录操作走相同的三步:

```go
// 1. 解析 teamID、volumeID(UUID 格式校验)
// 2. builder.Chroot(volumeType, teamID, volumeID) → 进入卷的 chroot 环境
// 3. 清理 path:补 "/"、filepath.Clean
```

`getFilesystemAndPath` 返回 `(*chrooted.Chrooted, string, *status.Status)`。所有路径在 chroot 后被视为绝对路径,**物理逃逸不可能**。

### 4.4 创建卷 — `CreateVolume`

```go
func (s *Service) CreateVolume(ctx, request) (*CreateVolumeResponse, error) {
    fullPath, err := s.getVolumeRootPath(ctx, request.GetVolume())
    // → /<volume-type-root>/team-<teamID>/vol-<volumeID>

    if err := os.MkdirAll(fullPath, 0o700); err != nil { ... }
    return &CreateVolumeResponse{}, nil
}
```

特点:
- **不进入 chroot**(只是建目录,不操作文件)
- 权限 `0700`:只有 orchestrator(运行账号)能访问,team 之间通过路径隔离
- 幂等:`MkdirAll` 已存在不报错

### 4.5 删除卷 — `DeleteVolume`

```go
os.RemoveAll(fullPath)
```

递归删除整个卷目录。同样不进入 chroot。

### 4.6 文件操作

#### `CreateFile`(客户端流式)

协议:
```
client → server:  CreateFileRequest { oneof message {
    VolumeFileCreateStart    (volume, path, mode, uid, gid, force)
    VolumeFileCreateContent  (bytes content)
    VolumeFileCreateFinish   ()
}}
server → client:  CreateFileResponse { Entry entry }
```

行为:
- 第一个消息必须是 `Start`,否则 `ErrExpectedStart`
- `force=true`:`O_CREATE | O_WRONLY | O_TRUNC`(覆盖)+ `ensureDirs` 自动建父目录
- `force=false`:`O_CREATE | O_WRONLY | O_EXCL`(已存在则失败)
- 每收到 `Content` 就 `file.Write`
- 收到 `Finish`:`file.Sync()` → `Chown` → `Chmod`(再次显式设置,绕过 umask)→ stat → 返回 `Entry`

#### `GetFile`(服务端流式)

```
client → server:  GetFileRequest { volume, path }
server → client:  GetFileResponse { oneof message {
    VolumeFileGetResponseStart    (int64 size)
    VolumeFileGetResponseContent  (bytes content, 1MB chunks)
    VolumeFileGetResponseFinish   ()
}}
```

`fileStreamChunkSize = 1024 * 1024`(1MB,见 `pkg/volumes/file_get.go:16`)。先发 `Start`(含 size,客户端可预分配/显示进度),然后流式发 chunks,最后 `Finish`。

### 4.7 目录操作

#### `CreateDir`

```go
mode := os.FileMode(utils.DerefOrDefault(request.Mode, uint32(defaultDirMode)))  // 默认 0o777
uid := utils.DerefOrDefault(request.Uid, defaultOwnerID)                          // 默认 9090
gid := utils.DerefOrDefault(request.Gid, defaultGroupID)

if request.GetCreateParents() {
    ensureDirs(fs, filepath.Dir(path), uid, gid)  // 类 mkdir -p
}

err := fs.Mkdir(path, mode)
// 已存在 + CreateParents → 检查是目录则不报错
// 否则 AlreadyExists → 409 PATH_ALREADY_EXISTS

// 显式 Chown + Chmod 绕过 umask
```

`ensureDirs`(`service.go:190`):
- 从目标目录向上回溯,找出哪些父目录需要创建
- `MkdirAll` 一次性创建
- 只对**新建的**父目录 Chmod/Chown(避免覆盖已有目录的权限)

#### `ListDir`

```go
const (
    minDepth = 1
    maxDepth = 10
)

depth := max(int(request.GetDepth), minDepth)  // 至少 1
if depth > maxDepth {
    return DEPTH_OUT_OF_RANGE  // 400
}

results := s.listRecursive(ctx, fs, path, depth)
// 路径不存在 → PATH_NOT_FOUND (404)
```

递归列出,depth 控制深度。限制 10 层防止爆炸式返回。

### 4.8 路径操作

#### `DeletePath`

```go
if s.isRoot(path) {
    return CANNOT_DELETE_ROOT  // 不能删根(整个卷)
}

if _, err := fs.Lstat(path); err != nil {
    if os.IsNotExist(err) { return PATH_NOT_FOUND }
    ...
}

fs.RemoveAll(path)  // 递归删除
```

防御:`isRoot(path)` 检查 `path == "/"`,**永远不允许删除卷根**。`Lstat`(不跟随符号链接)先确认存在,因为 `RemoveAll` 对不存在的路径不报错。

#### `StatPath`

```go
info, err := fs.GetEntry(path)  // 内部用 filesystem.GetEntryFromPath(includeMetadata=false)
// 不存在 → PATH_NOT_FOUND (404)
```

`includeMetadata=false`:Orchestrator 的 `EntryInfo` proto 没有 metadata 字段,跳过 xattr syscall 省开销。

#### `UpdatePath`

更新 mode/uid/gid(可选字段,nil 表示不更新):

```go
if request.Mode != nil {
    fs.Chmod(path, os.FileMode(request.GetMode()))
    // 不存在 → PATH_NOT_FOUND
}
if request.Uid != nil || request.Gid != nil {
    fs.Chown(path, int(uid), int(gid))
}
if request.Mode != nil || request.Uid != nil || request.Gid != nil {
    // 返回更新后的 Entry
}
```

仅更新提供的字段,保持其他字段不变。

### 4.9 错误处理

`errors.go`:

```go
func newAPIError(ctx, grpcCode, httpStatus, userErrorCode, userErrorMessage, args) *status.Status {
    message := fmt.Sprintf(userErrorMessage, args...)  // 先格式化
    s := status.New(grpcCode, message)
    s, err := s.WithDetails(&orchestrator.UserError{
        Code:        userErrorCode,
        Message:     message,    // ← 用已格式化的 message,不是原始 userErrorMessage
        HttpStatus:  httpStatus,
    })
    // err 处理:失败则记日志,s 保持原状(不带 details)
    return s
}
```

双层错误模型:
1. **gRPC code**(InvalidArgument/NotFound/...):供 gRPC 客户端用
2. **UserError 详情**:供 API 层透传给最终用户(含建议 HTTP status 和语义化错误码)

`processError`(在 `dir_create.go` 等)把 `os.ErrExist` / `os.ErrNotExist` 自动映射为对应的 UserError。

---

## 5. 安全隔离:`chrooted` 包

这是 volume 操作安全的**心脏**。即使路径校验有 bug,这一层也保证 orchestrator 主进程不会被 sandbox 数据"逃逸"。

### 5.1 路径构建 — `Builder`

`packages/orchestrator/pkg/chrooted/builder.go`:

```go
func (b *Builder) BuildVolumePath(volumeType string, teamID, volumeID uuid.UUID) (string, error) {
    volumeTypeRoot, ok := b.config.PersistentVolumeMounts[volumeType]
    if !ok {
        return "", fmt.Errorf("%w: %q", ErrVolumeTypeNotFound, volumeType)
    }
    return filepath.Join(
        volumeTypeRoot,
        fmt.Sprintf("team-%s", teamID),
        fmt.Sprintf("vol-%s", volumeID),
    ), nil
}
```

**配置(`PERSISTENT_VOLUME_MOUNTS`)**:
```
PERSISTENT_VOLUME_MOUNTS=nfs:/data/nfs,local-ssd:/mnt/ssd
```
解析后存为 `map[string]string`,key 是 volume type,value 是根目录绝对路径。`cfg` 启动时 `filepath.Clean + Abs + Stat` 校验每个挂载点,不存在就启动失败。

**路径布局**:
```
<data/nfs>/                       ← volume type root
├── team-<uuid>/                  ← team 隔离
│   ├── vol-<uuid>/               ← 单个卷
│   │   ├── file1
│   │   ├── subdir/
│   │   └── ...
│   └── vol-<uuid>/
└── team-<uuid>/
```

### 5.2 mount namespace + chroot — `Chroot`

`chroot.go` 的 `Chroot(ctx, source)` 流程:

```
1. tempMountNS(ctx)        ← 在专用 OS 线程上 unshare(CLONE_NEWNS)
2. chroot(ns, source):
   a. Mount("", "/", "", MS_SLAVE|MS_REC, "")   ← 让所有挂载变成私有,避免传播
   b. Mount(source, source, "", MS_BIND|MS_REC, "")  ← bind mount 卷目录到自己
   c. 循环(最多 maxMountAttempts=10):
      - 创建 oldRootPath = source/.old-root.<random>
      - PivotRoot(source, oldRootPath)            ← 把 source 变成新根
      - Chdir("/")
      - Unmount(/.old-root.X, MNT_DETACH)         ← 卸载旧根
      - Remove(/.old-root.X)
   d. 返回 *Chrooted
```

**`pivot_root` vs `chroot`**:用 `pivot_root` 而非 plain `chroot`,因为 `chroot` 不安全(进程仍可通过 `..` 等技巧逃逸);`pivot_root` 真正交换根挂载点,旧根完全不可达。

### 5.3 单线程串行化 — `mountNS.Do`

`mountns.go`:

```go
type mountNS struct {
    file   *os.File
    closed bool

    mu     sync.Mutex
    reqCh  chan nsRequest
    stopCh chan struct{}
    doneCh chan struct{}
}
```

设计:
- `tempMountNS` 创建一个**专用 OS 线程**(`runtime.LockOSThread`),因为 `CLONE_NEWNS` 是 per-thread 的
- 该线程跑一个 select 循环,从 `reqCh` 取任务
- `Do(fn)` 把函数塞进 channel,阻塞等返回
- **同一个 namespace 的所有操作严格串行** — 没有并发 race,也没有逃逸窗口

**metric**:`orchestrator.chroot.request.latency`(微秒)记录每次操作的等待+执行延迟,用于诊断瓶颈。

### 5.4 关闭 — `Close`

```go
func (ns *mountNS) Close() error {
    close(stopCh)
    <-doneCh          // 等 goroutine 恢复原 namespace 并退出
    return file.Close()
}
```

关闭时,goroutine 会先 `threadNS.Set()` 把当前线程切回原 namespace,再退出。如果恢复失败,只打 critical log(`fail to restore original namespace`),不阻塞关闭。

### 5.5 Chrooted FS 辅助方法

`fs.go` 提供 `Create/Open/OpenFile/EvalSymlinks/Stat/Lstat/GetEntry/Mkdir/MkdirAll/Rename/Remove/RemoveAll/Join/TempFile/ReadDir/Symlink/Readlink/Chroot/Root`;`change.go` 补充 `Chmod/Chown/Lchown/Chtimes`。每个都通过 `fs.act(fn)` 在 mount namespace 内执行。例如:

```go
func (fs *Chrooted) Stat(filename string) (os.FileInfo, error) {
    err := fs.act(func() error {
        info, err = os.Stat(filename)
        return err
    })
    return info, err
}
```

调用方代码看起来像普通 `os.Stat`,但实际跑在隔离 namespace 里。

---

## 6. Sandbox 内挂载:NFS 网关

### 6.1 流程总览

```
┌─────────────────────────────────────────────────────────────┐
│ Sandbox (Firecracker VM)                                     │
│   └─ envd 启动时收到 /init JSON:                              │
│        volumeMounts: [{name: "data", path: "/mnt/data"}]     │
│   └─ envd 执行 NFS mount:                                     │
│        mount -t nfs <orchestrator-ip>:<port>:/data /mnt/data │
└──────────────────┬──────────────────────────────────────────┘
                   │ NFSv3 over TCP
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Orchestrator nfsproxy (port 5007 / ProxyPort)                │
│   └─ NFSHandler.Mount(request):                              │
│      1. remoteAddr → sandboxes.GetByHostPort → 找到 sbx       │
│      2. requestedPath = "/data" → volumeName = "data"        │
│      3. 遍历 sbx.Config.VolumeMounts 匹配 Name                │
│      4. builder.Chroot(volumeMount.Type, teamID, volID)       │
│      5. 缓存 chroot 到 chrootsByLifecycleID[lifecycleID]      │
│   └─ 后续 FS 请求直接走缓存的 chroot                            │
└──────────────────┬──────────────────────────────────────────┘
                   ▼
              持久化后端
```

### 6.2 配置传递

Sandbox 创建时(API → orchestrator `SandboxCreateRequest`):
```protobuf
message SandboxConfig {
    ...
    repeated SandboxVolumeMount volume_mounts = ...;
}
message SandboxVolumeMount {
    string id = ...;        // volume UUID
    string name = ...;      // 卷名,envd 用此匹配
    string path = ...;      // sandbox 内挂载点,如 "/mnt/data"
    string type = ...;      // volume_type,orchestrator 路由用
}
```

orchestrator 转成 `sandbox.VolumeMountConfig`,塞进 `Sandbox.Config.VolumeMounts`。

### 6.3 envd `/init` 注入

`sandbox/envd.go`:
```go
jsonBody := &envd.PostInitJSONBody{
    LifecycleID:    s.LifecycleID,
    VolumeMounts:   s.convertMounts(s.Config.VolumeMounts),  // [{Name, Path}]
    ...
}
// POST http://<sandbox-ip>:49983/init
```

envd 收到后,自己执行 NFS mount,目标地址是 `HyperloopIP`(orchestrator-in-sandbox IP),端口是 `ProxyPort`(默认 5007)。

### 6.4 NFS Mount 请求处理

`nfsproxy/chroot/nfs.go` 的 `getChroot`:

```go
sbx, err := h.sandboxes.GetByHostPort(remoteAddr.String())
// 通过源 IP 反查 sandbox(每个 sandbox 有独立 IP)

requestedPath := string(request.Dirpath)  // 例如 "/data"
if !mountPath.MatchString(requestedPath) {
    return ErrInvalidMountPath  // 必须是 "/xxx" 单层
}

volumeName := requestedPath[1:]  // "data"

var volumeMount *sandbox.VolumeMountConfig
for _, m := range sbx.Config.VolumeMounts {
    if m.Name == volumeName { volumeMount = &m; break }
}
if volumeMount == nil { return ErrVolumeNotFound }

if volumeMount.ID == uuid.Nil { return ErrVolumeID }

fs, err := h.builder.Chroot(ctx, volumeMount.Type, teamID, volumeMount.ID)
// 创建专属 chroot 实例

// 缓存
h.chrootsByLifecycleID[lifecycleID] = append(..., fs)
```

**安全要点**:
- 通过 `GetByHostPort` 反查 sandbox,即使恶意 sandbox 也只能访问自己声明的 volume
- 路径必须严格 `/volume_name` 单层,防止 `../` 攻击
- `volumeMount.ID == uuid.Nil` 防御性检查,防止配置错误导致根目录暴露
- 只能挂载 sandbox 启动时**显式声明**的卷名

### 6.5 资源跟踪与回收

`NFSHandler` 实现了 `sandbox.MapSubscriber`:

```go
func (h *NFSHandler) OnInsert(_ context.Context, _ *sandbox.Sandbox) {}  // 无操作

func (h *NFSHandler) OnNetworkRelease(ctx context.Context, sbx *sandbox.Sandbox) {
    lifecycleID := sbx.LifecycleID

    h.mu.Lock()
    chroots := h.chrootsByLifecycleID[lifecycleID]
    delete(h.chrootsByLifecycleID, lifecycleID)
    h.mu.Unlock()

    for _, chroot := range chroots {
        if err := chroot.Close(); err != nil { ... }
        h.chrootUnmountsCounter.Add(ctx, 1)
    }
}
```

**关键时机**:sandbox 的 network slot 释放时(也就是 sandbox 完全销毁前),关闭它所有的 NFS chroot。这保证了:
- sandbox 持有的文件句柄不会泄漏
- mount namespace 在 sandbox 退出后立即回收
- 同一 sandbox 的多次 lifecycle(checkpoint/resume)各自管理自己的 chroot

**Metrics**:
- `nfs.chroot.mounts`(counter)— 累计 mount 次数
- `nfs.chroot.unmounts`(counter)— 累计 unmount 次数
- `nfs.chroots.gauge`(observable gauge)— 当前活跃 chroot 数

### 6.6 `FSStat` 的特殊语义

```go
// FSStat describes the state of the exported file system...
// We offer volumes that are unlimited in size, so we leave all values to their
// defaults, which is 1 << 62.
func (h *NFSHandler) FSStat(...) error { return nil }
```

volume 向 sandbox 报告"无限大小"(`1 << 62` 字节)— 实际配额由后端存储管理,不在 NFS 协议层强制。

### 6.7 2026.30 变动:`ENOTDIR` 从 500 改判为 400

`packages/orchestrator/pkg/volumes/dir_create.go` 的 `processError` 新增了一条映射:路径中间某一段是**普通文件**时(例如 `file.txt/sub`),内核返回 `syscall.ENOTDIR`。

```go
// 2026.30 新增(示意)
if errors.Is(err, syscall.ENOTDIR) {
    return status.Error(codes.InvalidArgument, ...) // → 400 INVALID_REQUEST
}
```

> ⚠️ **这是客户端错误,不是服务端故障。** 2026.29 时 `ENOTDIR` 落进通用错误分支被当成 500,客户端会误以为"orchestrator 出问题了"并重试,而重试永远不会成功。2026.30 起它和其它路径类错误(`ENOENT`、`EACCES`)一样返回 400 `INVALID_REQUEST`。

`dir_create.go` 因此从 100 行涨到 109 行(2026.29 为 100)。

---

## 7. Sandbox 调度与 Volume 亲和性

### 7.1 节点 Label

每个 orchestrator 节点通过 Nomad/部署系统打 label:
```
persistent-volume-type=nfs
persistent-volume-type=local-ssd
```
表示该节点配置了哪些 volume type 的 `PERSISTENT_VOLUME_MOUNTS`。

### 7.2 Sandbox 调度

`packages/api/internal/orchestrator/create_instance.go`(`generateRequiredNodeLabels` 函数,第 476 行起):

```go
labelFilteringEnabled := o.featureFlagsClient.BoolFlag(ctx,
    featureflags.SandboxLabelBasedSchedulingFlag, ...)   // 顶级门控
if !labelFilteringEnabled {
    return nil, false                                    // 关闭时完全不参与 label 调度
}

allLabels := append([]string{}, team.SandboxSchedulingLabels...)
if len(allLabels) == 0 {
    allLabels = append(allLabels, "default")
}

volumeFilteringEnabled := o.featureFlagsClient.BoolFlag(ctx,
    featureflags.SandboxVolumeLabelBasedSchedulingFlag, ...)  // 嵌套门控
if volumeFilteringEnabled {
    for _, mount := range sbxData.VolumeMounts {
        label := internal.MakeVolumeTypeLabel(mount.GetType())
        allLabels = append(allLabels, label)
    }
}
```

两层 feature flag:
1. **`SandboxLabelBasedSchedulingFlag`** — 顶级开关,关闭时 sandbox 完全不带 label,走默认调度
2. **`SandboxVolumeLabelBasedSchedulingFlag`** — 嵌套开关,只在顶级启用时才检查;启用后 sandbox 创建时把声明的所有 volume type 转成 label

调度器只把 sandbox 放到同时满足所有 label 的节点上。这样保证 sandbox 启动后 NFS 挂载一定能命中本地数据。

### 7.3 双重亲和性

```
Volume CRUD (API → orchestrator gRPC)
    └─ executeOnOrchestratorByClusterID
        └─ 按 persistent-volume-type=<type> label 选节点
        └─ 该 volume 的数据物理上落在被选中的节点

Sandbox 启动 (API → orchestrator gRPC Create)
    └─ SandboxVolumeLabelBasedSchedulingFlag 启用时
    └─ sandbox 必须调度到挂载了相同 volume type 的节点
    └─ 因此 sandbox 看到的 NFS 路径就在本地
```

**潜在跨节点**:如果 volume CRUD 和 sandbox 落到不同节点,NFS 挂载会失败(数据不在那)。这就是为什么 volume 调度和 sandbox 调度都要遵循同一套 label 规则。

---

## 8. 配置参考

### 8.1 环境变量

| 变量 | 范围 | 默认 | 示例 |
| --- | --- | --- | --- |
| `PERSISTENT_VOLUME_MOUNTS` | orchestrator | — | `nfs:/data/nfs,local-ssd:/mnt/ssd` |
| `DEFAULT_PERSISTENT_VOLUME_TYPE` | API | — | `nfs` |
| `VOLUME_TOKEN_ENABLED` | API | `true` | `true` |
| `VOLUME_TOKEN_ISSUER` | API | — | `e2b-volumes` |
| `VOLUME_TOKEN_SIGNING_METHOD` | API | — | `HS256` |
| `VOLUME_TOKEN_SIGNING_KEY` | API | — | `<base64>` |
| `VOLUME_TOKEN_SIGNING_KEY_NAME` | API | — | `v1` |
| `VOLUME_TOKEN_DURATION` | API | `1h` | `1h` |

`PERSISTENT_VOLUME_MOUNTS` 解析后是 `map[string]string`,`cfg.NewConfig` 会:
1. `filepath.Clean` 每个路径
2. 转绝对路径
3. `os.Stat` 验证存在

任一步失败 → 启动错误。

### 8.2 LaunchDarkly Feature Flags

| Flag | 类型 | 作用 |
| --- | --- | --- |
| `PersistentVolumesFlag` | bool | API 总开关。关闭时 `POST/GET/DELETE /volumes` 全部 403 |
| `DefaultPersistentVolumeType` | string | 默认 volume type,优先级高于 config |
| `VolumeFallbackToUnmatchedNodesFlag` | bool | 节点未标记时是否回退(迁移期用) |
| `SandboxVolumeLabelBasedSchedulingFlag` | bool | sandbox 调度是否考虑 volume label |

所有 flag 都支持 team/cluster/volume/sandbox 多级 context,可精准放灰度。

---

## 9. 完整生命周期示例

### 9.1 创建并使用 volume

```
1. 客户端: POST /volumes { name: "mydata" }
   API:
     ├─ 校验 + DB INSERT volumes(team_id, name='mydata', volume_type='nfs')
     ├─ 选节点:找 label "persistent-volume-type=nfs" 的 orchestrator
     ├─ gRPC VolumeService.CreateVolume
     │   Orchestrator:
     │     └─ os.MkdirAll("/data/nfs/team-abc/vol-xyz", 0700)
     ├─ tx.Commit
     └─ 签 JWT → 返回 { volumeID: "xyz...", name: "mydata", token: "..." }

2. 客户端: POST /sandboxes { volumeMounts: [{name: "mydata", path: "/mnt/data"}] }
   API:
     ├─ 查 volume by name → 拿到 volumeID 和 volumeType
     ├─ SandboxVolumeLabelBasedSchedulingFlag → 给调度加 label "persistent-volume-type=nfs"
     └─ 调度到配置了 nfs 的节点,创建 sandbox

3. Sandbox 启动:
   Orchestrator → envd /init:
     └─ volumeMounts: [{name: "mydata", path: "/mnt/data"}]
   envd:
     └─ mount -t nfs <orchestrator-ip>:5007:/mydata /mnt/data
        │
        ▼
   nfsproxy:
     ├─ remoteAddr → 找到 sbx
     ├─ "/mydata" → volumeName="mydata"
     ├─ 在 sbx.Config.VolumeMounts 找匹配 → 拿到 volumeID
     ├─ builder.Chroot("nfs", teamID, volumeID) → 进入 /data/nfs/team-abc/vol-xyz
     └─ 返回 chroot 给 NFS 协议层

4. Sandbox 内进程读写 /mnt/data/file.txt
   → NFS 请求 → nfsproxy → chrooted FS 操作 → 实际文件 IO

5. Sandbox 退出:
   ├─ sbx.Close → MarkStopping → network release
   └─ NFSHandler.OnNetworkRelease → 关闭所有 chroot
```

### 9.2 删除 volume

```
DELETE /volumes/xyz...
API:
  ├─ DB DELETE volumes WHERE id=xyz AND team_id=abc
  ├─ 立即返回 204(对外已不可见)
  └─ 异步 go deleteVolume → orchestrator.DeleteVolume
       └─ os.RemoveAll("/data/nfs/team-abc/vol-xyz")
            (失败仅记 critical log,不影响 API 已返回的成功)
```

---

## 10. 关键不变量与安全保证

1. **Team 隔离**:所有 DB 查询带 `team_id` 过滤;所有文件路径含 `team-<uuid>` 段
2. **路径不可逃逸**:`pivot_root` + chroot 让所有 FS 操作只在卷目录内;`GetByHostPort` + 单层 `/volume_name` 校验在 NFS 入口防御
3. **声明式访问**:sandbox 只能挂载它启动时**显式声明**的 volume;即使用了同名,也要 volumeID 匹配
4. **资源回收**:每个 NFS chroot 绑定到 `LifecycleID`,sandbox network 释放时必关
5. **节点亲和**:volume CRUD 和 sandbox 调度都按 `persistent-volume-type` label,保证数据本地性
6. **DB 先于存储**:删除时先 DB 后目录,即使目录删除失败也不会有 ghost 卷
7. **JWT 短时**:每次 GET/POST 重签,默认 1h 过期,客户端不能长期持权
8. **JWT key 选择兼容**:标准 `kid` 与兼容 `tokid` 同值;新 verifier 使用 `kid`,迁移期不能先移除 `tokid`
9. **umask 防御**:`CreateFile` / `CreateDir` 显式 `Chmod` 绕过进程 umask,确保权限严格符合请求

---

## 11. 监控指标速查

| 指标 | 来源 | 含义 |
| --- | --- | --- |
| `nfs.chroot.mounts` | nfsproxy | counter,每次 NFS mount 递增 |
| `nfs.chroot.unmounts` | nfsproxy | counter,每次 chroot Close 递增 |
| `nfs.chroots.gauge` | nfsproxy | observable gauge,当前活跃 chroot 数 |
| `orchestrator.chroot.request.latency` | chrooted | histogram(μs),单次 FS 操作延迟 |
| `created_volume` / `deleted_volume` | API (Posthog) | 业务事件 |
| `received unknown volume type errors` | API log | 节点配置不一致的预警信号 |

---

## 12. 文件索引

行数均按 tag `2026.30` 实测；与 2026.29 不同处标注为「行数(2026.30;2026.29 为 M)」。

| 路径 | 行数 | 职责 |
| --- | --- | --- |
| `packages/orchestrator/volume.proto` | 193(2026.29 为 192) | VolumeService gRPC 定义;**2026.30 新增 `CreateVolumeResponse.volume_type`** |
| `packages/orchestrator/pkg/volumes/service.go` | 237 | Service 结构 + 路径解析 + ensureDirs |
| `packages/orchestrator/pkg/volumes/volume_create.go` | 46(2026.29 为 37) | CreateVolume (MkdirAll);**2026.30 回传 `volume_type`** |
| `packages/orchestrator/pkg/volumes/volume_delete.go` | 40 | DeleteVolume (RemoveAll) |
| `packages/orchestrator/pkg/volumes/file_create.go` | 125 | 客户端流式创建文件 |
| `packages/orchestrator/pkg/volumes/file_get.go` | 101 | 服务端流式读取文件 |
| `packages/orchestrator/pkg/volumes/dir_create.go` | 109(2026.29 为 100) | CreateDir + ensureDirs 接入;**2026.30 `processError` 把 `ENOTDIR` 映射为 400** |
| `packages/orchestrator/pkg/volumes/dir_list.go` | 119 | ListDir,depth ∈ [1, 10] |
| `packages/orchestrator/pkg/volumes/path_delete.go` | 63 | DeletePath,拒绝删根 |
| `packages/orchestrator/pkg/volumes/path_stat.go` | 52 | StatPath |
| `packages/orchestrator/pkg/volumes/path_update.go` | 93 | UpdatePath(mode/uid/gid) |
| `packages/orchestrator/pkg/volumes/errors.go` | 28 | UserError 构造 |
| `packages/orchestrator/pkg/chrooted/builder.go` | 51 | BuildVolumePath |
| `packages/orchestrator/pkg/chrooted/chroot.go` | 123 | pivot_root + chroot 实现 |
| `packages/orchestrator/pkg/chrooted/mountns.go` | 286 | mount namespace + 单线程串行 |
| `packages/orchestrator/pkg/chrooted/fs.go` | 192 | FS 操作的 chroot 包装(Stat/Mkdir/...) |
| `packages/orchestrator/pkg/chrooted/change.go` | 32 | Chmod/Chown/Lchown/Chtimes |
| `packages/orchestrator/pkg/nfsproxy/chroot/nfs.go` | 230(2026.29 为 227) | NFS Handler + VolumeMount 匹配 |
| `packages/api/internal/handlers/volume_create.go` | 308(2026.29 为 200) | POST /volumes handler;**2026.30 改为 orchestrator-first + `getVolumeType`** |
| `packages/api/internal/handlers/volume_delete.go` | 63 | DELETE /volumes/{id} handler |
| `packages/api/internal/handlers/volume_get.go` | 42(2026.29 为 33) | GET /volumes/{id} handler;**2026.30 响应加 `Domain`** |
| `packages/api/internal/handlers/volumes_list.go` | 44 | GET /volumes handler |
| `packages/api/internal/handlers/volume_util.go` | 258(2026.29 为 226) | 节点选择 + 错误分类;**2026.30 加 `volumeContentDomain`/`volumeTokenAudience`** |
| `packages/api/internal/handlers/volume_token.go` | 66(2026.29 为 63) | JWT 签发;**2026.30 `aud` 改为 `https://api.<domain>`** |
| `packages/api/internal/cfg/model.go` | 133, 139, 146, 188-215 | `VolumesToken`(:133)、`PlaceholderPersistentVolumeType`(:139)、`DefaultPersistentVolumeTypeByRegion`(:146)、`VolumesTokenConfig`(:188)(2026.29 记为 149-194,已失效) |
| `packages/api/internal/labels.go` | 3 | `MakeVolumeTypeLabel`(:3;2026.29 记为 5) |
| `packages/api/internal/orchestrator/create_instance.go` | 627-640 | sandbox 调度按 volume label(:636;2026.29 记为 477-506) |
| `packages/db/migrations/20260304120000_volumes.sql` | 25 | volumes 表 schema |
| `packages/db/queries/volumes/volumes.sql` | 18 | sqlc 查询;**2026.30 `CreateVolume` 改为显式传 `id`** |
| `spec/openapi.yml` | 2209-2246, 4212-4271 | Volume schema(`Volume:` :2209、`VolumeAndToken:` :2222、`NewVolume:` :2246)+ 路由(`/volumes:` :4212、`/volumes/{volumeID}:` :4271)(2026.29 记为 1946-1994, 3715-3790,已失效) |

---

*已同步至 **2026.30**。行号与文件行数均按 tag `2026.30` 实测核对;§0 汇总本版全部变动,正文各节的 `#### 2026.30 变动:` 小节给出实现细节。*
