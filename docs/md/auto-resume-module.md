# Auto-Resume 模块详解

> 范围:当用户流量到达 client-proxy 而 sandbox 已 paused 时,系统自动触发恢复的完整链路——从配置、触发、校验、状态机到冷启动。
>
> 阅读建议:先看「一、概述」与「四、端到端时序图」建立全局视图,再按需深入具体章节。本文与 `sandbox-api-module.md`(REST 端点)、`client-proxy-module.md`(边缘路由)、`sandbox-management.md`(orchestrator 内部)互为补充,只在 auto-resume 这条路径上展开细节。

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、整体架构](#三整体架构)
- [四、端到端时序图](#四端到端时序图)
- [五、配置层:Policy 与 Timeout](#五配置层policy-与-timeout)
- [六、创建时的硬约束](#六创建时的硬约束)
- [七、触发层:Client-Proxy 的 catalog miss 路径](#七触发层client-proxy-的-catalog-miss-路径)
- [八、API 入口:SandboxService.ResumeSandbox 深度解析](#八api-入口sandboxserviceresumesandbox-深度解析)
- [九、状态机:HandleExistingSandboxAutoResume](#九状态机handleexistingsandboxautoresume)
- [十、超时计算](#十超时计算)
- [十一、Feature Flag 与常量](#十一feature-flag-与常量)
- [十二、关键代码文件索引](#十二关键代码文件索引)
- [十三、设计要点与权衡](#十三设计要点与权衡)
- [十四、常见问题与排查](#十四常见问题与排查)
- [附录 A:成功条件清单](#附录-a成功条件清单)
- [附录 B:gRPC 状态码映射](#附录-bgrpc-状态码映射)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

**Auto-resume** 是 E2B 的"流量驱动恢复"机制:当客户端的请求到达 client-proxy,而 sandbox 在 Redis catalog 中查不到(意味着已 paused 或从未运行),系统会**自动**通过 gRPC 把请求转发给 API,API 校验通过后启动 sandbox,再把 nodeIP 返回 client-proxy 用于后续转发。

它和三个看起来相似的入口对比:

| 入口 | 触发者 | 谁发起 | 走 auto-resume 路径? |
|---|---|---|---|
| `POST /sandboxes/{id}/resume` | 用户主动 | 客户端 REST | 否(直接走 startSandbox) |
| `POST /sandboxes/{id}/connect` | 用户主动 | 客户端 REST | 部分(类似但走 KeepAliveFor 重试) |
| **auto-resume** | **系统(流量到达)** | **client-proxy → API gRPC** | **是(本文主题)** |

这条路径只对 **`Policy=Any` 的 sandbox** 生效;`Policy=Off` 的 sandbox 即使有快照,流量到达也只会得到 404。

### 与其他文档的边界

| 主题 | 文档 |
|---|---|
| REST 端点(POST /resume、POST /connect 等) | `sandbox-api-module.md` |
| Client-proxy 整体架构 | `client-proxy-module.md` |
| Orchestrator 内部 VM 调度 | `sandbox-management.md` |
| Sandbox 状态机(内部/API) | `sandbox-lifecycle.md` |
| **流量驱动 auto-resume 全链路** | **本文** |

---

## 二、核心概念

### 2.1 Policy:`Any` vs `Off`

定义在 `packages/db/pkg/types/types.go:104-109`:

```go
type SandboxAutoResumePolicy string

const (
    SandboxAutoResumeAny SandboxAutoResumePolicy = "any"  // 允许流量触发
    SandboxAutoResumeOff SandboxAutoResumePolicy = "off"  // 仅允许显式 resume
)
```

OpenAPI 对外只暴露 `autoResume.enabled: bool`(`api.SandboxAutoResumeConfig`),在 `buildAutoResumeConfig`(`packages/api/internal/handlers/sandbox_create.go:339-352`)里翻译:

```go
policy := types.SandboxAutoResumeOff
if autoResume.Enabled {
    policy = types.SandboxAutoResumeAny
}
```

### 2.2 FilesystemOnly 与 AutoPauseFilesystemOnly

两者容易混淆,但语义截然不同(`packages/db/pkg/types/types.go:122-134`):

| 字段 | 含义 | 控制 |
|---|---|---|
| `FilesystemOnly` | **当前这个快照** 是否只有 rootfs(无内存) | 描述"是什么" |
| `AutoPauseFilesystemOnly` | **下一次 auto-pause** 是否拍 filesystem-only 快照 | 描述"下次怎么做" |

auto-resume 关心的是 **`FilesystemOnly`**:如果是 true,流量触发恢复会走 cold-boot(丢失内存状态),API 层拒绝隐式做这件事(`getAutoResumeSnapshot` 返回 `FailedPrecondition`)。

### 2.3 catalog miss 是触发起点

Client-proxy 维护一个 Redis-backed 的 sandbox catalog(`catalog.SandboxesCatalog`接口),运行中 sandbox 的 sandboxID → nodeIP 映射保存在这里。当客户端请求到达:

```
catalog.GetSandbox(sandboxId)
├─ 命中 → 直接转发到 nodeIP
└─ ErrSandboxNotFound (catalog miss)
    → handlePausedSandbox
        → gRPC ResumeSandbox 到 API
```

**只有 catalog miss 才会走 auto-resume 路径**——这是触发点。

### 2.4 流量类型:envd vs non-envd

`packages/api/internal/handlers/proxy_grpc.go:63-83`:

```go
func isNonEnvdTrafficRequest(ctx, incomingMetadata, sandboxID) bool {
    requestPort, found := metadataFirstValue(incomingMetadata, proxygrpc.MetadataSandboxRequestPort)
    if !found {
        return true  // 缺失视为非 envd
    }
    return requestPort != uint64(consts.DefaultEnvdServerPort)  // 49983
}
```

区分这两类流量是为了选择正确的 token 校验路径:
- **envd 流量**(端口 49983):对 secure sandbox 校验 `MetadataEnvdAccessToken`
- **非 envd 流量**(其他端口 / 用户业务流量):对私有 ingress sandbox 校验 `MetadataTrafficAccessToken`

### 2.5 三类 budget/timeout

| 名称 | 含义 | 默认值 |
|---|---|---|
| `autoResumeTransitionWaitBudget` | 已存在 sandbox 在 pausing/snapshotting 时,API 等待状态变化的总预算 | `1 * time.Minute`(`proxy_grpc.go:97`) |
| `MaxAutoResumeTransitionRetries` | 在上述预算内的最大重试次数 | `3`(`autoresume.go:18`) |
| `defaultProxyAutoResumeTimeout` | 冷启动后 sandbox 的运行时长(未配置时) | `5 * time.Minute`(`timeout_helper.go:11`) |
| `MinAutoResumeTimeoutSeconds`(LD flag) | 团队级最小 auto-resume 超时下限 | feature flag |

---

## 三、整体架构

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │                       Client 流量(任意业务请求)                       │
   └─────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
                        ┌────────────────────────┐
                        │   Client-Proxy (边缘)   │
                        │   reverseproxy.New       │
                        └──────────┬─────────────┘
                                   │ catalog.GetSandbox
                                   ▼
                        ┌────────────────────────┐
                        │  Redis catalog         │
                        └──────────┬─────────────┘
                                   │
                  ┌────────────────┼────────────────┐
                  │ catalog hit    │ catalog miss    │
                  ▼                ▼                 │
            直接转发 nodeIP    handlePausedSandbox   │
                              ─▶ pausedChecker.Resume
                                   │ gRPC ResumeSandbox
                                   ▼
                        ┌────────────────────────┐
                        │  API: SandboxService    │
                        │  ResumeSandbox (gRPC)   │
                        └──────────┬─────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
            ▼                      ▼                      ▼
    getAutoResumeSnapshot   HandleExistingSandbox    startSandboxInternal
    (snapshotCache + 校验)   AutoResume (状态机)      (isResume=true)
            │                      │                      │
            ▼                      ▼                      ▼
    ClickHouse snapshots   orchestrator 索引         gRPC → nomad
    + Config.AutoResume    WaitForStateChange         cold-boot / memory-resume
                                   │
                                   ▼
                            返回 OrchestratorIp
                                   │
                                   ▼
                        Client-Proxy 转发原始流量到 nodeIP
```

### 3.1 涉及的 4 个核心组件

| 组件 | 位置 | 在 auto-resume 链路中的角色 |
|---|---|---|
| Client-Proxy | `packages/client-proxy/internal/proxy/proxy.go` | 触发点;catalog miss 后调 gRPC |
| API gRPC handler | `packages/api/internal/handlers/proxy_grpc.go` | 校验 + 协调;入口是 `SandboxService.ResumeSandbox` |
| Orchestrator(逻辑层) | `packages/api/internal/orchestrator/autoresume.go` | 处理已存在 sandbox 的状态转换 |
| Snapshot Cache | `packages/api/internal/cache/snapshots` | 提供 paused sandbox 的快照数据与 Config |

> 注:`packages/api/internal/orchestrator/` 是 **API 进程内** 的 orchestrator 客户端逻辑(管理 gRPC 连接、状态轮询等),不是 nomad 上跑的那个 orchestrator 二进制。后者在 `packages/orchestrator/`。

---

## 四、端到端时序图

### 4.1 标准成功路径(cold-boot)

```
Client           Client-Proxy         Redis Catalog      API (gRPC)         Orchestrator
  │                  │                     │                  │                  │
  │ HTTP 请求         │                     │                  │                  │
  │ (带 sandboxID)    │                     │                  │                  │
  │─────────────────>│                     │                  │                  │
  │                  │ GetSandbox──────────>                  │                  │
  │                  │<────────── ErrSandboxNotFound          │                  │
  │                  │ handlePausedSandbox                     │                  │
  │                  │ pausedChecker.Resume                   │                  │
  │                  │   (gRPC ResumeSandbox)─────────────────────────────────>  │
  │                  │                     │                  │                  │
  │                  │                     │     getAutoResumeSnapshot           │
  │                  │                     │     (snapshotCache.Get)             │
  │                  │                     │     ✓ Policy=Any                   │
  │                  │                     │     ✓ 非 filesystem-only           │
  │                  │                     │     ✓ OAuth scope / org            │
  │                  │                     │     ✓ team 未被封禁                │
  │                  │                     │     ✓ token 校验通过              │
  │                  │                     │                  │                  │
  │                  │                     │     HandleExistingSandboxAutoResume│
  │                  │                     │     (GetSandbox → ErrNotFound)     │
  │                  │                     │                  │                  │
  │                  │                     │     startSandboxInternal           │
  │                  │                     │     (isResume=true)─────────────────> cold-boot
  │                  │                     │<────────────────── sbx              │
  │                  │                     │     nodeIP                          │
  │                  │<────────────────────────────── OrchestratorIp              │
  │                  │ normalizeNodeIP                                              │
  │                  │ 转发 HTTP 请求到 nodeIP──────────────────────────────────>│
  │<─────────────────│                                                              │
  │ HTTP 响应                                                                        │
```

### 4.2 Sandbox 仍在 pausing 的路径

```
ResumeSandbox 调用
  │
  ▼
getAutoResumeSnapshot ✓
  │
  ▼
GetSandbox(teamID, sandboxID) → sbx.State == StatePausing
  │
  ▼
HandleExistingSandboxAutoResume
  ├─ attempt 1: WaitForStateChange(≤1min budget) → 仍 Pausing
  ├─ attempt 2: WaitForStateChange → 仍 Pausing
  └─ attempt 3: WaitForStateChange → 仍 Pausing
       ↓
       ErrSandboxStillTransitioning → API 返回 FailedPrecondition
       → client-proxy 返回 SandboxStillTransitioningError
```

### 4.3 Sandbox 已在 running 的快速路径

```
ResumeSandbox 调用
  │
  ▼
GetSandbox → sbx.State == StateRunning
  │
  ▼
HandleExistingSandboxAutoResume → 直接返回 (nodeIP, handled=true)
  │
  ▼
API 返回 OrchestratorIp(nodeIP)
  │
  ▼
Client-Proxy 转发(无冷启动开销)
```

---

## 五、配置层:Policy 与 Timeout

### 5.1 `SandboxAutoResumeConfig` 结构

`packages/db/pkg/types/types.go:111-114`:

```go
type SandboxAutoResumeConfig struct {
    Policy  SandboxAutoResumePolicy `json:"policy"`
    Timeout uint64                  `json:"timeout,omitempty"`
}
```

**字段含义**:
- `Policy`:流量触发权限,`"any"` 允许,`"off"` 拒绝
- `Timeout`:auto-resume 后 sandbox 的运行时长(秒);0 表示使用默认 `5min`

### 5.2 它存在哪里

`SandboxAutoResumeConfig` 是 `PausedSandboxConfig` 的字段之一(`types.go:119`):

```go
type PausedSandboxConfig struct {
    Version                string
    Network                *SandboxNetworkConfig
    AutoResume             *SandboxAutoResumeConfig    // ← 这里
    VolumeMounts           []*SandboxVolumeMountConfig
    FilesystemOnly         bool
    AutoPauseFilesystemOnly bool
}
```

`PausedSandboxConfig` 在 sandbox 被 pause 时序列化为 JSON,写入 ClickHouse 的 `snapshots` 表。auto-resume 时 `snapshotCache.Get` 读出来,API 直接消费。

### 5.3 创建时如何生成

`buildAutoResumeConfig`(`sandbox_create.go:339-352`)只设置 Policy,**Timeout 在另一个地方计算**(`sandbox_create.go:165-168`):

```go
if autoResume != nil {
    minAutoResumeTimeout := time.Duration(
        a.featureFlags.IntFlag(ctx, featureflags.MinAutoResumeTimeoutSeconds),
    ) * time.Second
    autoResume.Timeout = calculateTimeoutSeconds(timeout, minAutoResumeTimeout, teamInfo)
}
```

注意这里 `timeout` 是 sandbox 的 **运行 timeout**(用户请求体里的 `timeout`),不是 auto-resume 独立配置——也就是说:**auto-resume 后的运行时长 = 用户创建时声明的 timeout**(经钳制)。

---

## 六、创建时的硬约束

`packages/api/internal/handlers/sandbox_create.go:170-185` 有两条强校验,任一违反返回 400:

### 6.1 `autoPauseFilesystemOnly && !autoPause`

```go
// autoPauseMemory 只在 autoPause=true 时才有意义
if autoPauseFilesystemOnly && !autoPause {
    → 400 "autoPauseMemory=false only applies when autoPause is true."
}
```

这是 autoPause 自身的约束,与 autoResume 无关,但它是下一条的前置。

### 6.2 `autoPauseFilesystemOnly && Policy=Any`

```go
// filesystem-only 快照不能被流量 auto-resume
if autoPauseFilesystemOnly && autoResume != nil && autoResume.Policy == types.SandboxAutoResumeAny {
    → 400 "autoPauseMemory=false (filesystem-only auto-pause) cannot be combined with autoResume: ..."
}
```

**设计意图**:filesystem-only 快照没有内存状态,cold-boot 恢复会丢失内存。这种"丢失内存的恢复"如果由流量隐式触发,用户无法预知,违背预期。所以系统要求:要么拍 memory snapshot(允许流量 auto-resume),要么拍 filesystem-only(必须用户显式 `POST /resume`)。

> 注:创建时校验的是 `AutoPauseFilesystemOnly`(下次 auto-pause 的策略),运行时校验的是 `FilesystemOnly`(当前快照的事实)。两者协作保证"任何一次 auto-pause 产生的快照,要么能被流量恢复,要么不会假装能被流量恢复"。

---

## 七、触发层:Client-Proxy 的 catalog miss 路径

### 7.1 入口:`catalogResolution`

`packages/client-proxy/internal/proxy/proxy.go:76-95`:

```go
func catalogResolution(ctx, sandboxId, sandboxPort, trafficAccessToken, envdAccessToken, c, pausedChecker) (string, error) {
    s, err := c.GetSandbox(ctx, sandboxId)
    if err != nil {
        if errors.Is(err, catalog.ErrSandboxNotFound) {
            nodeIP, res, pausedErr := handlePausedSandbox(ctx, sandboxId, sandboxPort, trafficAccessToken, envdAccessToken, pausedChecker)
            if pausedErr != nil {
                return "", pausedErr
            }
            if res == autoResumeSucceeded {
                return nodeIP, nil
            }
            return "", ErrNodeNotFound  // 非"成功"结果都映射为 ErrNodeNotFound
        }
        return "", fmt.Errorf("failed to get sandbox from catalog: %w", err)
    }
    return catalogSandboxNodeIP(s)
}
```

### 7.2 `handlePausedSandbox` 的错误码映射

`packages/client-proxy/internal/proxy/proxy.go:97-136`:

| gRPC code | autoResumeResult | client-proxy 行为 |
|---|---|---|
| `OK` | `autoResumeSucceeded` | 用 nodeIP 转发 |
| `PermissionDenied` | `autoResumePermissionDenied` | 返回 `SandboxResumePermissionDeniedError` |
| `NotFound` | `autoResumeNotAllowed` | 静默映射为 `ErrNodeNotFound` → `SandboxNotFoundError` |
| `FailedPrecondition` + `SandboxStillTransitioningMessage` | `autoResumeErrored` | 返回 `SandboxStillTransitioningError` |
| `ResourceExhausted` | `autoResumeResourceExhausted` | 返回 `SandboxResourceExhaustedError` |
| 其他 | `autoResumeErrored` | 透传 |

### 7.3 gRPC 客户端封装

`packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go:73-97`:

```go
func (c *grpcPausedSandboxResumer) Resume(ctx, sandboxId, sandboxPort, trafficAccessToken, envdAccessToken) (string, error) {
    ctx = metadata.AppendToOutgoingContext(ctx, proxygrpc.MetadataSandboxRequestPort, strconv.FormatUint(sandboxPort, 10))
    if trafficAccessToken != "" {
        ctx = metadata.AppendToOutgoingContext(ctx, proxygrpc.MetadataTrafficAccessToken, trafficAccessToken)
    }
    if envdAccessToken != "" {
        ctx = metadata.AppendToOutgoingContext(ctx, proxygrpc.MetadataEnvdAccessToken, envdAccessToken)
    }
    ctx, err := c.auth.authorize(ctx)  // client-proxy 自己的 OAuth
    // ...
    resp, err := c.client.ResumeSandbox(ctx, &proxygrpc.SandboxResumeRequest{SandboxId: sandboxId})
    return strings.TrimSpace(resp.GetOrchestratorIp()), nil
}
```

**关键**:`MetadataSandboxRequestPort` 必须传,API 用它判断 envd vs non-envd 流量;两类 access token 是可选的,只在对应场景下被校验。

---

## 八、API 入口:`SandboxService.ResumeSandbox` 深度解析

`packages/api/internal/handlers/proxy_grpc.go:127-279`,分 8 个阶段。

### 8.1 Phase 1:OAuth + scope 校验(:130-140)

```go
if s.requireEdgeClientProxyAuth {
    clientProxyClaims, authErr := oauth.RequireClaims(ctx, incomingMetadata, s.clientProxyOAuth)
    if err := oauth.RequireScopeClaims(clientProxyClaims, oauth.RequiredScope); err != nil {
        return nil, err
    }
}
```

仅在生产/边缘部署时启用(`requireEdgeClientProxyAuth=true`)。本地开发通常关闭。

### 8.2 Phase 2:`getAutoResumeSnapshot` —— 三大前置条件(:147-150, 调用 `:99-125`)

```go
snap, autoResume, err := s.getAutoResumeSnapshot(ctx, sandboxID)
```

**完整校验链**(`:99-125`):

```go
// (1) 快照必须存在
snap, err := s.api.snapshotCache.Get(ctx, sandboxID)
if errors.Is(err, snapshotcache.ErrSnapshotNotFound) {
    return nil, nil, status.Error(codes.NotFound, "snapshot not found")
}

// (2) Policy 必须是 Any
var autoResume *dbtypes.SandboxAutoResumeConfig
if snap.Snapshot.Config != nil {
    autoResume = snap.Snapshot.Config.AutoResume
}
if autoResume == nil || autoResume.Policy != dbtypes.SandboxAutoResumeAny {
    return nil, nil, status.Error(codes.NotFound, "sandbox auto-resume disabled")
}

// (3) 不能是 filesystem-only
if snap.Snapshot.Config != nil && snap.Snapshot.Config.FilesystemOnly {
    return nil, nil, status.Error(codes.FailedPrecondition, "filesystem-only snapshot must be resumed explicitly")
}
```

### 8.3 Phase 3:团队解析 + cluster 归属(:152-177)

```go
teamID := snap.Snapshot.TeamID
team, err := s.api.authService.GetTeamByID(ctx, teamID)

// cluster.AuthOrgID 必须匹配 client-proxy claims 的 org
if s.requireEdgeClientProxyAuth {
    cluster, found := s.api.clusters.GetClusterById(*team.ClusterID)
    authOrgID = cluster.AuthOrgID
    if err := oauth.RequireOrgClaims(clientProxyClaims, authOrgID); err != nil {
        return nil, err
    }
}

// team 不能被封禁
if err := auth.CheckTeamBlocked(team); err != nil {
    return nil, status.Error(codes.PermissionDenied, err.Error())
}
```

### 8.4 Phase 4:已存在 sandbox 的状态处理(:179-208)

```go
sandboxData, sandboxErr := s.api.orchestrator.GetSandbox(ctx, teamID, sandboxID)
if sandboxErr != nil {
    if !errors.Is(sandboxErr, sandbox.ErrNotFound) {
        return nil, status.Errorf(codes.Internal, "failed to get sandbox state: %v", sandboxErr)
    }
    // 走 cold-boot 路径(落到 Phase 5)
} else {
    // sandbox 还在 orchestrator 索引里——交给状态机处理
    nodeIP, handled, existingErr := s.api.orchestrator.HandleExistingSandboxAutoResume(
        ctx, teamID, sandboxID, sandboxData, autoResumeTransitionWaitBudget,
    )
    if existingErr != nil {
        // 错误分类见下文
    }
    if handled {
        return &proxygrpc.SandboxResumeResponse{OrchestratorIp: nodeIP}, nil  // 快速路径
    }
    // handled=false 表示 sandbox 已不在(Killing/NotFound),继续走 cold-boot
}
```

**existingErr 分类**:
- `ErrSandboxStillTransitioning` → API 返回 `FailedPrecondition` + `SandboxStillTransitioningMessage`
- `sandbox.ErrNotFound` → 返回 `NotFound "sandbox not found"`
- `context.Canceled/DeadlineExceeded` → 透传 context 错误
- 其他 → `Internal`

### 8.5 Phase 5:计算 timeout(:210-212)

```go
minAutoResumeTimeout := time.Duration(
    s.api.featureFlags.IntFlag(ctx, featureflags.MinAutoResumeTimeoutSeconds),
) * time.Second
timeout := calculateAutoResumeTimeout(autoResume, minAutoResumeTimeout, team)
```

### 8.6 Phase 6:secure envd access token(:214-224)

```go
var envdAccessToken *string
if snap.Snapshot.EnvSecure {
    accessToken, tokenErr := s.api.getEnvdAccessToken(snap.EnvBuild.EnvdVersion, sandboxID)
    if tokenErr != nil {
        return nil, status.Error(codes.Internal, "failed to create envd access token")
    }
    envdAccessToken = &accessToken
}
```

### 8.7 Phase 7:两类 token 校验(:226-256)

```go
var network *dbtypes.SandboxNetworkConfig
if snap.Snapshot.Config != nil {
    network = snap.Snapshot.Config.Network
}
isNonEnvdTraffic := isNonEnvdTrafficRequest(ctx, incomingMetadata, sandboxID)

// 场景 A:私有 ingress + 非 envd 流量 → traffic access token
if isPrivateIngressTraffic(network) && isNonEnvdTraffic {
    expectedToken, _ := s.api.accessTokenGenerator.GenerateTrafficAccessToken(sandboxID)
    providedToken, _ := metadataFirstValue(incomingMetadata, proxygrpc.MetadataTrafficAccessToken)
    if !tokensMatch(providedToken, expectedToken) {
        return nil, denyResumePermission()  // PermissionDenied
    }
}

// 场景 B:envd 流量 + secure sandbox → envd access token
if !isNonEnvdTraffic && snap.Snapshot.EnvSecure && envdAccessToken != nil {
    providedEnvdToken, _ := metadataFirstValue(incomingMetadata, proxygrpc.MetadataEnvdAccessToken)
    if !tokensMatch(providedEnvdToken, *envdAccessToken) {
        return nil, denyResumePermission()
    }
}
```

**`tokensMatch`** 使用 `crypto/subtle.ConstantTimeCompare` 防止时序攻击(`:89-91`)。

### 8.8 Phase 8:冷启动(:258-278)

```go
headers := http.Header{}
sbx, apiErr := s.api.startSandboxInternal(
    ctx,
    sandboxID,
    timeout,
    team,
    s.api.buildResumeSandboxData(sandboxID, nil),  // 复用 REST resume 的闭包
    &headers,
    true,  // isResume
    nil,   // mcp
)
if apiErr != nil {
    return nil, status.Error(sharedutils.GRPCCodeFromHTTPStatus(apiErr.Code), apiErr.ClientMsg)
}

nodeIP := s.api.orchestrator.GetNodeRouteIPAddress(sbx.ClusterID, sbx.NodeID)
if nodeIP == "" {
    return nil, status.Error(codes.Internal, "sandbox resumed but orchestrator IP is not available yet")
}
return &proxygrpc.SandboxResumeResponse{OrchestratorIp: nodeIP}, nil
```

**注意 `buildResumeSandboxData`** —— 这与 REST `POST /sandboxes/{id}/resume` 共用同一个闭包(`sandbox_resume.go:192-258`)。闭包内会在 sandbox 锁内读取 snapshot 数据,避免 TOCTOU。

---

## 九、状态机:`HandleExistingSandboxAutoResume`

`packages/api/internal/orchestrator/autoresume.go:22-129`。

### 9.1 函数签名

```go
func (o *Orchestrator) HandleExistingSandboxAutoResume(
    ctx context.Context,
    teamID uuid.UUID,
    sandboxID string,
    sbx apisandbox.Sandbox,
    transitionWaitBudget time.Duration,
) (nodeIP string, handled bool, err error)
```

**返回值语义**:
- `handled=true` + `err=nil`:已处理(快速路径),用 nodeIP 直接返回
- `handled=false` + `err=nil`:sandbox 已不在,继续走 cold-boot
- `err != nil`:错误,直接返回

### 9.2 状态分支表

| `sbx.State` | 行为 | 返回 |
|---|---|---|
| `StateRunning` | 取 nodeIP,验证非空,直接返回 | `(nodeIP, true, nil)` |
| `StatePausing` / `StateSnapshotting` | 进 WaitForStateChange 循环(见 9.3) | 视情况 |
| `StateKilling` | 返回 `apisandbox.ErrNotFound`(被上层 Phase 4 映射为 gRPC `NotFound`) | `("", false, apisandbox.ErrNotFound)` |
| 其他 / 未知 | 内部错误 | `("", false, errors.New("sandbox is in an unknown state"))` |

> **Killing 与"重试中 refresh NotFound"的区别**:
> - `StateKilling` 直接返回 `apisandbox.ErrNotFound` —— 上层(`proxy_grpc.go:196-198`)拦截后返回 gRPC `NotFound "sandbox not found"`,**不走 cold-boot**。
> - Pausing/Snapshotting 重试循环内的 `GetSandbox` 刷新返回 `ErrNotFound`(`autoresume.go:93-95`)→ 函数返回 `("", false, nil)` —— 上层 `handled=false` 且无 err,**走 cold-boot**。
>
> 两者都基于 `ErrNotFound`,但语义截然不同:前者是"sandbox 正在被销毁,拒绝恢复",后者是"sandbox 在等待状态变化期间消失了,允许重新创建"。

### 9.3 Pausing/Snapshotting 的重试逻辑

```go
for {
    switch sbx.State {
    case apisandbox.StatePausing, apisandbox.StateSnapshotting:
        if attempts >= MaxAutoResumeTransitionRetries {  // = 3
            return "", false, ErrSandboxStillTransitioning
        }
        attempts++

        err := o.WaitForStateChange(transitionCtx, teamID, sandboxID)
        if err != nil {
            // 预算耗尽(且 ctx 未取消)→ StillTransitioning
            if errors.Is(transitionCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
                return "", false, ErrSandboxStillTransitioning
            }
            // 调用方取消 → 透传
            if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
                return "", false, err
            }
            // 其他错误
            return "", false, errors.New(waitErrMsg)
        }

        // 刷新状态后继续循环
        updatedSandbox, getSandboxErr := o.GetSandbox(ctx, teamID, sandboxID)
        if getSandboxErr == nil {
            sbx = updatedSandbox
            continue
        }
        if errors.Is(getSandboxErr, apisandbox.ErrNotFound) {
            return "", false, nil  // 已不在,走 cold-boot
        }
        return "", false, fmt.Errorf("failed to refresh sandbox state: %w", getSandboxErr)
    // ... 其他 case
    }
}
```

**两个 budget 协同**:
- `autoResumeTransitionWaitBudget = 1 * time.Minute`(单次 WaitForStateChange 的 ctx 超时)
- `MaxAutoResumeTransitionRetries = 3`(循环次数上限)

任一耗尽即返回 `ErrSandboxStillTransitioning`。

### 9.4 Running 分支的 routing 细节

```go
case apisandbox.StateRunning:
    node := o.getOrConnectNode(ctx, sbx.ClusterID, sbx.NodeID)
    nodeIP := ""
    if node != nil {
        nodeIP = routeNodeIPAddress(node, env.IsLocal())  // 本地特殊处理
    }
    if nodeIP == "" {
        return "", false, errors.New("sandbox is running but routing info is not available yet")
    }
    return nodeIP, true, nil
```

**`getOrConnectNode`** 会按需建立到目标 node 的 gRPC 连接(懒连接);**`routeNodeIPAddress`** 在本地开发场景返回空字符串以外的特殊值(CI/CD 环境)。

---

## 十、超时计算

`packages/api/internal/handlers/timeout_helper.go`:

### 10.1 入口:`calculateAutoResumeTimeout`(:38-45)

```go
func calculateAutoResumeTimeout(
    autoResume *dbtypes.SandboxAutoResumeConfig,
    minAutoResumeTimeout time.Duration,
    team *typesteam.Team,
) time.Duration {
    timeout := defaultProxyAutoResumeTimeout  // 5min
    if autoResume != nil && autoResume.Timeout > 0 {
        timeout = time.Duration(autoResume.Timeout) * time.Second
    }
    return clampAutoResumeTimeout(timeout, getTeamPlanLimit(team), minAutoResumeTimeout)
}
```

### 10.2 钳制:`clampAutoResumeTimeout`(:22-32)

```go
func clampAutoResumeTimeout(requestedTimeout, teamPlanLimit, minAutoResumeTimeout time.Duration) time.Duration {
    timeout := requestedTimeout
    if teamPlanLimit > 0 && timeout > teamPlanLimit {
        timeout = teamPlanLimit  // 不超过团队 plan 上限
    }
    if timeout < minAutoResumeTimeout {
        timeout = minAutoResumeTimeout  // 不低于 LD flag 下限
    }
    return timeout
}
```

### 10.3 钳制顺序图

代码顺序(`clampAutoResumeTimeout:22-32`):**先钳上限,再钳下限**。在两者都满足的常规情况下顺序不影响结果;但记录实际顺序有助于排查边界场景。

```
用户配置的 autoResume.Timeout
        │
        ▼  (1) 先钳上限
   ≤ teamPlanLimit = team.Limits.MaxLengthHours
        │
        ▼  (2) 再钳下限
   ≥ MinAutoResumeTimeoutSeconds (LD flag)
        │
        ▼
   最终的运行 timeout
```

> 边界:若 `teamPlanLimit < minAutoResumeTimeout`(团队 plan 上限反而低于 LD flag 下限),第二步会把第一步的结果重新抬升到 minAutoResumeTimeout——即**下限优先**。这种情况通常不会发生(LD flag 配置会考虑 plan 等级),但代码逻辑上确实如此。

### 10.4 默认值兜底

如果 `autoResume.Timeout == 0`(创建时未显式设置),用 `defaultProxyAutoResumeTimeout = 5 * time.Minute`。这是 **API gRPC handler 自己的默认值**,与 REST 端点的 `SandboxTimeoutDefault = 15s` 不同——后者是首次创建 sandbox 的默认 timeout,前者是 auto-resume 后的兜底运行时长。

---

## 十一、Feature Flag 与常量

### 11.1 关键常量

| 常量 | 位置 | 值 | 用途 |
|---|---|---|---|
| `autoResumeTransitionWaitBudget` | `proxy_grpc.go:97` | `1 * time.Minute` | 单次 WaitForStateChange 的 ctx 超时 |
| `MaxAutoResumeTransitionRetries` | `autoresume.go:18` | `3` | Pausing/Snapshotting 重试上限 |
| `defaultProxyAutoResumeTimeout` | `timeout_helper.go:11` | `5 * time.Minute` | 冷启动后默认运行时长 |
| `MetadataSandboxRequestPort` | `shared/pkg/grpc/proxy/metadata.go:7` | `"e2b-sandbox-request-port"` | gRPC metadata key:请求端口 |
| `MetadataTrafficAccessToken` | (proxy grpc) | — | 非环境流量 token |
| `MetadataEnvdAccessToken` | (proxy grpc) | — | envd 流量 token |
| `SandboxStillTransitioningMessage` | `shared/pkg/grpc/proxy/status.go:5` | `"sandbox is still transitioning"` | 标识 still-transitioning 错误 |
| `DefaultEnvdServerPort` | `shared/pkg/consts/envd.go:4` | `49983` | envd 流量判定阈值 |

### 11.2 Feature Flag

| Flag | 类型 | 用途 |
|---|---|---|
| `MinAutoResumeTimeoutSeconds` | `IntFlag` | auto-resume 超时的团队级下限(秒) |

**无独立的 "auto-resume enabled" feature flag** —— 启用与否完全由 sandbox 级别的 `Policy` 控制。这是有意为之:auto-resume 是商业 feature,但开关放在 sandbox 配置而非团队 feature flag,意味着每个 sandbox 独立决定。

---

## 十二、关键代码文件索引

| 文件 | 主要导出 | 说明 |
|---|---|---|
| `packages/api/internal/handlers/proxy_grpc.go` | `SandboxService`、`ResumeSandbox`、`getAutoResumeSnapshot`、`isNonEnvdTrafficRequest`、`isPrivateIngressTraffic`、`tokensMatch` | gRPC 入口与所有前置校验 |
| `packages/api/internal/orchestrator/autoresume.go` | `HandleExistingSandboxAutoResume`、`ErrSandboxStillTransitioning`、`MaxAutoResumeTransitionRetries` | 状态机 |
| `packages/api/internal/handlers/sandbox_create.go` | `buildAutoResumeConfig`、auto-resume 相关校验(line 165-185) | 创建时的配置翻译与约束 |
| `packages/api/internal/handlers/timeout_helper.go` | `calculateAutoResumeTimeout`、`clampAutoResumeTimeout`、`calculateTimeoutSeconds`、`getTeamPlanLimit` | 超时计算 |
| `packages/client-proxy/internal/proxy/proxy.go` | `catalogResolution`、`handlePausedSandbox` | 触发逻辑 |
| `packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go` | `NewGRPCPausedSandboxResumer`、`grpcPausedSandboxResumer.Resume` | gRPC 客户端 |
| `packages/db/pkg/types/types.go` | `SandboxAutoResumeConfig`、`SandboxAutoResumePolicy`、`SandboxAutoResumeAny/Off`、`PausedSandboxConfig` | 类型定义 |
| `packages/shared/pkg/grpc/proxy/metadata.go` | `MetadataSandboxRequestPort` 等 | gRPC metadata 常量 |
| `packages/shared/pkg/grpc/proxy/status.go` | `SandboxStillTransitioningMessage` | 错误标识 |

---

## 十三、设计要点与权衡

### 13.1 为什么 auto-resume 用 gRPC 而非 REST

REST 的 `POST /sandboxes/{id}/resume` 是给**终端用户**用的;auto-resume 是给 **client-proxy(系统内部)** 用的。两者诉求不同:

| 维度 | REST resume | gRPC auto-resume |
|---|---|---|
| 调用者 | 用户 SDK | client-proxy |
| 认证 | API key / OIDC | client-proxy OAuth + sandbox 内 token |
| 流量类型感知 | 否 | **是**(envd vs non-envd,用于 token 选型) |
| 返回 | 完整 Sandbox 对象 | 仅 OrchestratorIp |
| 已 running 行为 | 409 already-running | **返回当前 nodeIP(快速路径)** |

gRPC handler 复用 `buildResumeSandboxData` / `startSandboxInternal`,但走完全不同的校验链——这是"同一业务、不同入口"的典型权衡。

### 13.2 三个 budget 协同避免雪崩

- **`MaxAutoResumeTransitionRetries = 3`**:防止单次请求无限重试
- **`autoResumeTransitionWaitBudget = 1min`**:防止单次 WaitForStateChange 阻塞太久
- **`MinAutoResumeTimeoutSeconds` (LD flag)**:防止用户配置过低导致 sandbox 刚恢复就再次 pause(乒乓效应)

三者协同:即使整个集群都在状态转换中,单个 auto-resume 请求最多占用 1 分钟;即使误配,也不会让 sandbox 来回震荡。

### 13.3 FilesystemOnly 的双重保护

- **创建时**(`sandbox_create.go:181`):`autoPauseFilesystemOnly && Policy=Any` → 400。从源头禁止产生"声明能 auto-resume 但实际不行"的配置。
- **运行时**(`proxy_grpc.go:120`):`FilesystemOnly` → FailedPrecondition。即使绕过创建时校验(老数据、迁移等),运行时也会拒绝。

这是"防御性编程"的体现:**永远不信任配置,运行时再校验一次**。

### 13.4 ConstantTimeCompare 防止时序攻击

`tokensMatch`(`proxy_grpc.go:89-91`)用 `crypto/subtle.ConstantTimeCompare` 而非 `==`。traffic/envd access token 是 sandbox 级别的凭证,攻击者可能通过响应时间推断字符 —— 常量时间比较堵死这个侧信道。

### 13.5 快速路径 vs 冷启动

`HandleExistingSandboxAutoResume` 返回 `handled=true` 时走快速路径(直接返回 running sandbox 的 nodeIP),无需 cold-boot。这是性能优化:对刚 pause 又有流量进来的 sandbox(比如短暂空闲后第一波请求),免去冷启动开销。

代价是状态机的复杂度——需要处理 Pausing/Snapshotting 的中间态。重试与 budget 就是为此设计。

### 13.6 错误码的"用户友好"与"系统精确"分层

API 层返回 gRPC code,client-proxy 把它翻译成对用户更友好的 HTTP 错误:

| gRPC code | HTTP 最终呈现 |
|---|---|
| `NotFound` | `SandboxNotFoundError`(404) |
| `PermissionDenied` | `SandboxResumePermissionDeniedError`(403) |
| `FailedPrecondition` + StillTransitioning | `SandboxStillTransitioningError`(503) |
| `ResourceExhausted` | `SandboxResourceExhaustedError`(429/503) |
| `Internal` | 透传(500) |

**NotFound 的特殊处理**:当 Policy=Off 时,API 故意返回 `NotFound` 而非更明确的"auto-resume disabled"——目的是 **不暴露 sandbox 存在性**。客户端看到的"404 sandbox not found"在两种情况下出现(真不存在 / 存在但禁用 auto-resume),无法区分,保护了用户隐私。

---

## 十四、常见问题与排查

### Q1:为什么我的流量到达 sandbox,得到 404 但 sandbox 明明在 ClickHouse 里有快照?

最常见原因:**Policy=Off**。检查 `snapshots` 表中该 sandbox 的 `config.autoResume.policy`:
- 如果是 `"off"` 或 `null`,auto-resume 在 `getAutoResumeSnapshot` 阶段就返回 NotFound。
- 创建 sandbox 时 `autoResume.enabled` 未设为 `true`,Policy 默认就是 Off。

**修复**:重新创建 sandbox 时显式 `autoResume: { enabled: true }`,或主动调 `POST /sandboxes/{id}/resume`。

### Q2:返回 503 "sandbox is still transitioning"

Sandbox 在 orchestrator 索引中处于 `StatePausing` 或 `StateSnapshotting`,且在 1 分钟 / 3 次重试内未完成状态转换。

**常见原因**:
- 大内存 sandbox 的 memory snapshot 写盘慢
- 同时有大量 sandbox 在 pause(GC 风暴)
- 磁盘 I/O 瓶颈

**处理**:
- client 端短暂重试即可(转换完成后下次请求会成功)
- 持续出现:检查 orchestrator 节点的磁盘性能,或 NBD 后端负载

### Q3:返回 403 "permission denied"

两类可能:
1. **Team 被 blocked**:`auth.CheckTeamBlocked` 失败,通常因为欠费/违规
2. **Token 不匹配**:
   - secure sandbox + envd 流量:`MetadataEnvdAccessToken` 缺失或不匹配
   - 私有 ingress + 非 envd 流量:`MetadataTrafficAccessToken` 缺失或不匹配

**排查**:在 client-proxy 日志中看具体是哪种 `PermissionDenied`(gRPC status message)。

### Q4:auto-resume 后 sandbox 只活了 5 分钟就又被 pause 了

`defaultProxyAutoResumeTimeout = 5 * time.Minute`,这是 `autoResume.Timeout=0` 时的兜底值。如果创建 sandbox 时未显式设 `timeout`,auto-resume 后就用这个默认值。

**修复**:
- 创建时显式声明足够大的 `timeout`(会被 `team.Limits.MaxLengthHours` 钳制)
- 或者依赖 `MinAutoResumeTimeoutSeconds` LD flag 强制下限

### Q5:`autoResume.enabled: true` 创建时被 400 拒绝

错误消息通常是 `autoPauseMemory=false (filesystem-only auto-pause) cannot be combined with autoResume`。

这是因为同时设置了:
- `autoPause: true`
- `autoPauseMemory: false`(产生 filesystem-only 快照)
- `autoResume.enabled: true`

**修复**:三者只能二选一——要么 `autoPauseMemory: true`(允许 auto-resume),要么 `autoResume.enabled: false`(只允许显式 resume)。

### Q6:auto-resume 后的 sandbox 看不到原 sandbox 的进程?

如果原 sandbox 是 **memory snapshot** 恢复,进程状态完整保留。但如果是 **filesystem-only snapshot**(走 cold-boot),进程不会自动起来——只有文件系统状态在。

**注意**:filesystem-only **不应该走 auto-resume**(会被 `getAutoResumeSnapshot` 拒)。如果发生了,说明配置出错——检查是否绕过了创建时校验。

### Q7:client-proxy 报 `autoResumeNotAllowed`,但 Policy 确实是 Any

`autoResumeNotAllowed` 是 client-proxy 侧的 `autoResumeResult`,对应 gRPC `NotFound`。可能原因:
- snapshotCache.Get 真的没找到(ClickHouse 查询失败 / 数据未落盘)
- Policy 不是 Any(数据被覆盖)
- FilesystemOnly=true(返回 FailedPrecondition 而非 NotFound,但 client-proxy 可能映射到同一 result)

**排查**:看 API 端日志的 `ResumeSandbox` 详细错误,而非 client-proxy 端。

### Q8:同一个 sandboxID 短时间内多次 auto-resume 会怎样?

第一次成功 cold-boot 后,sandbox 进入 orchestrator 索引(`StateRunning`)。后续请求:
1. catalog hit → 直接转发
2. 即使 catalog miss(刚 resume 还没传播),`HandleExistingSandboxAutoResume` 会发现 `StateRunning`,走快速路径返回 nodeIP

所以不会重复 cold-boot。

### Q9:auto-resume 路径与 `POST /connect` 路径有何不同?

| 维度 | auto-resume | POST /connect |
|---|---|---|
| 触发 | 流量到达(系统) | 用户主动 |
| 入口 | gRPC `ResumeSandbox` | REST |
| 优先级 | 先 catalog,miss 才 resume | 先 `KeepAliveFor`,失败才 resume |
| FilesystemOnly 处理 | 拒绝 | 允许(走 cold-boot 路径) |
| Token 校验 | 严格(traffic + envd) | 不需要(已通过 API key 认证) |

connect 是用户主动的"软"恢复,auto-resume 是系统触发的"硬"恢复——后者校验更严,因为调用方不是终端用户。

### Q10:如何确认一次 auto-resume 成功了?

- API 日志:`ResumeSandbox` gRPC handler 的 trace span,看返回 code 是否 OK
- client-proxy 日志:`catalog miss, attempting resume via api` 之后无错误
- ClickHouse:对应 sandbox 的 `sandbox_started` 事件,`is_resume=true`
- Redis catalog:重新出现 sandboxID → nodeIP 映射

---

## 附录 A:成功条件清单

要使一次流量驱动 auto-resume 成功,以下条件**全部**必须满足:

### A.1 配置侧
1. ✅ 创建时 `autoResume.enabled=true`(写入 `Policy=Any`)
2. ✅ 不是 `autoPauseFilesystemOnly`(创建时校验)
3. ✅ 快照的 `FilesystemOnly=false`(只有 memory snapshot 才能被流量恢复)

### A.2 触发侧(client-proxy)
4. ✅ Redis catalog 查不到 sandbox(catalog miss,触发 handlePausedSandbox)
5. ✅ client-proxy OAuth 配置正确(`requireEdgeClientProxyAuth` 通过)

### A.3 API 校验侧(`ResumeSandbox`)
6. ✅ 快照存在(`snapshotCache.Get` 命中)
7. ✅ `Policy=Any`
8. ✅ 非 filesystem-only
9. ✅ client-proxy OAuth claims 有效且 scope 匹配
10. ✅ cluster.AuthOrgID 与 claims org 匹配
11. ✅ 团队未被封禁(`CheckTeamBlocked`)
12. ✅ 若是私有 ingress + 非 envd 流量:`MetadataTrafficAccessToken` 匹配
13. ✅ 若是 secure sandbox + envd 流量:`MetadataEnvdAccessToken` 匹配
14. ✅ sandbox 若在转换中,必须在 3 次重试 / 1 分钟内变到稳定态

### A.4 执行侧
15. ✅ `startSandboxInternal(isResume=true)` 成功
16. ✅ orchestrator 能返回非空 nodeIP

任一条件失败,返回对应 gRPC code,client-proxy 据此决定是返回 404/403/503 还是重试。

---

## 附录 B:gRPC 状态码映射

| Code | 触发点 | 含义 | client-proxy 映射 |
|---|---|---|---|
| `OK` | `:278` (返回 nodeIP) | 成功 | 转发到 nodeIP |
| `InvalidArgument` | `:144` (sandboxID 不合法) | 请求格式错 | ErrNodeNotFound(降级) |
| `NotFound` | `:103` (snapshot not found) / `:114` (auto-resume disabled) / `:197` (sandbox not found) | 不存在或禁用 | ErrNodeNotFound → SandboxNotFound |
| `FailedPrecondition` | `:121` (filesystem-only) / `:194` (still transitioning) | 状态前置条件不满足 | SandboxStillTransitioningError |
| `PermissionDenied` | `:176` (team blocked) / `:245,254` (token 不匹配) / `:171` (org 不匹配) | 鉴权失败 | SandboxResumePermissionDeniedError |
| `ResourceExhausted` | (orchestrator 资源耗尽透传) | 节点满载 | SandboxResourceExhaustedError |
| `Internal` | 多处(orchestrator 不可达、startSandbox 失败等) | 内部错误 | 透传 |

---

## 附录 C:术语表

| 术语 | 含义 |
|---|---|
| **Auto-resume** | 流量驱动自动恢复(catalog miss → gRPC → cold-boot / 快速路径) |
| **Policy** | `SandboxAutoResumePolicy`:`Any`(允许)或 `Off`(拒绝) |
| **FilesystemOnly** | 快照只有 rootfs,无内存——不能走 auto-resume |
| **AutoPauseFilesystemOnly** | 下次 auto-pause 时是否拍 filesystem-only 快照 |
| **Catalog miss** | client-proxy 在 Redis 中查不到 sandboxID,触发 auto-resume |
| **envd traffic** | 目标端口 `49983`(envd)的流量;否则为 non-envd |
| **Traffic access token** | 私有 ingress + 非 envd 流量所需的 token |
| **Envd access token** | secure sandbox + envd 流量所需的 token |
| **Cold-boot** | 从 rootfs 重新启动(filesystem-only 恢复路径) |
| **Memory resume** | 从 memory snapshot 直接恢复 RAM |
| **HandleExistingSandboxAutoResume** | 处理 orchestrator 索引中仍存在的 sandbox 的状态机 |
| **SandboxStillTransitioning** | 在 budget 内未能脱离 Pausing/Snapshotting 状态的错误标识 |
| **快速路径** | sandbox 已 Running,直接返回 nodeIP 无需 cold-boot |
| **PausedSandboxConfig** | sandbox 被 pause 时持久化的配置 JSON,含 `AutoResume` 等 |
