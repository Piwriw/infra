# 沙箱生命周期(Sandbox Lifecycle)

> 范围:从用户调用 `POST /sandboxes` 创建沙箱,到 firecracker microVM 启动、网络/NBD/uffd 就绪、envd 握手;再到 pause / resume / refresh / timeout / kill 的端到端流程。涉及 `packages/api/internal/handlers/sandbox*.go`、`packages/api/internal/orchestrator/`、`packages/api/internal/sandbox/`(运行态 store)、`packages/orchestrator/pkg/sandbox/`(orchestrator 端 VM 管理)、`packages/orchestrator/orchestrator.proto`(gRPC 协议)与 `packages/client-proxy/`(数据面)。
>
> 本文聚焦「一个沙箱实例的诞生、运行、暂停、恢复、死亡」这一主链路。沙箱列表查询、metrics/logs、模板缓存策略、多集群拓扑分别见 `sandbox-management.md`、`sandbox-api-module.md`、`template-cache-module.md`(待写)、`clusters-module.md`。

## 目录

- [一、概述](#一概述)
- [二、状态机:运行态在 Redis、终态在 Postgres](#二状态机运行态在-redis终态在-postgres)
- [三、API 端点全景](#三api-端点全景)
- [四、CP API 层的 Sandbox 编排器](#四cp-api-层的-sandbox-编排器)
- [五、Create(冷启动):HTTP → gRPC → Firecracker](#五create冷启动http--grpc--firecracker)
- [六、Firecracker 集成](#六firecracker-集成)
- [七、网络初始化:veth + TAP + iptables + nftables](#七网络初始化veth--tap--iptables--nftables)
- [八、NBD / 模板 rootfs 加载](#八nbd--模板-rootfs-加载)
- [九、uffd 与内存快照恢复](#九uffd-与内存快照恢复)
- [十、Pause:从运行中到快照](#十pause从运行中到快照)
- [十一、Resume:从快照恢复](#十一resume从快照恢复)
- [十二、Refresh / Timeout / Evictor](#十二refresh--timeout--evictor)
- [十三、Kill 与资源回收](#十三kill-与资源回收)
- [十四、Client-Proxy 数据面与 Auto-Resume](#十四client-proxy-数据面与-auto-resume)
- [十五、关键时序图](#十五关键时序图)
- [十六、关键代码文件索引](#十六关键代码文件索引)
- [十七、设计要点与权衡](#十七设计要点与权衡)
- [十八、常见问题与排查](#十八常见问题与排查)
- [附录 A:状态机详图](#附录-a状态机详图)
- [附录 B:gRPC `SandboxService` 协议](#附录-bgrpc-sandboxservice-协议)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

E2B 的「沙箱」(sandbox)是一个**运行中的 Firecracker microVM 实例**,代表用户某个模板的一次运行。每个沙箱有独立 IP、独立文件系统(从模板 rootfs 派生)、独立内存与 CPU 配额。沙箱生命周期横跨四个进程:

```
  SDK / CLI              CP API                  Orchestrator                Client-Proxy
  ────────               ──────                  ─────────────               ────────────
  POST /sandboxes  ──►   PostSandboxes
                          ├─ 解析模板 alias
                          ├─ sandboxStore.Reserve (并发限制)
                          ├─ placement.PlaceSandbox ───┐
                          │   选节点 + gRPC Create     │
                          │                            ▼
                                                  Factory.CreateSandbox
                                                  ├─ 网络命名空间 + TAP
                                                  ├─ NBD 挂载 rootfs
                                                  ├─ firecracker 进程 + 配置
                                                  ├─ startVM + 等 envd
                                                  └─ MarkRunning
                          ◄─   返回 (clientId, scheduling) ─┘
                          ├─ routingCatalog.StoreSandbox (Redis) ──────┐
                          └─ Posthog / 返回 201                         │
                                                                      │
                                                                      ▼
  GET /v1/sandbox 数据面 ────────────────────────────────────►  reverse proxy
                                                                ├─ catalog.GetSandbox
                                                                ├─ 取 OrchestratorIP
                                                                └─ http://<node>:5007
                                                                       │
                                                                       ▼
                                                                orchestrator:5007
                                                                iptables redirect
                                                                       │
                                                                       ▼
                                                                  FC VM (TAP)
```

**两个抽象层**(分别在两个进程内):

| 抽象 | 文件 | 职责 |
|---|---|---|
| **API 层 Sandbox Store** | `packages/api/internal/sandbox/store.go` | 运行中沙箱的注册表(Redis 后端),负责状态机、并发限制、过期驱逐 |
| **Orchestrator 层 Sandbox Factory** | `packages/orchestrator/pkg/sandbox/sandbox.go` | 在节点上启动/暂停/恢复 Firecracker 进程 |

**两个独立的状态存储**:

| 存储 | 内容 |
|---|---|
| **Redis**(API 层) | 运行中沙箱的元数据(`Sandbox` struct 序列化,ZSET 按 EndTime 排序供 Evictor 扫) |
| **Postgres** | `billing.sandbox_logs`(计费/审计)、`public.snapshots`(暂停态快照元数据);另有 `env_builds`(build 状态)、`envs`(模板)、`sandboxes_network_configs` 等表,本文不展开 |

> **注意**:运行态沙箱**不在 Postgres 里**。如果你直接查 `SELECT * FROM sandboxes`,什么也不会找到。运行态在 Redis,暂停态在 `snapshots` 表。

### 与其他文档的边界

| 主题 | 文档 |
|---|---|
| 列表查询、过滤、分页 | `sandbox-management.md` |
| Sandbox 的 metrics/logs HTTP 端点 | `sandbox-api-module.md` |
| 模板 rootfs 缓存策略 | `template-cache-module.md`(待写)|
| 沙箱快照(snapshot)实现细节 | `snapshots.md` |
| 多集群路由与 builder 节点 | `clusters-module.md` |
| **沙箱实例的生命周期** | **本文** |

---

## 二、状态机:运行态在 Redis、终态在 Postgres

### 2.1 状态枚举

`packages/api/internal/sandbox/sandboxtypes/states.go:95-103`:

```go
type State string

const (
    StateRunning      State = "running"
    StatePausing      State = "pausing"
    StateKilling      State = "killing"
    StateSnapshotting State = "snapshotting"
)
```

**没有显式的 `StatePaused`**:暂停状态由 `public.snapshots` 表中的快照行表达。`GET /sandboxes/{id}` 在 store 未命中时回退查 snapshot,如果找到则返回 `State: api.Paused`(`sandbox_get.go:251`)。

### 2.2 状态迁移

`AllowedTransitions`(`states.go:83-87`)定义合法迁移。注意:`State` 枚举只有 4 个,**没有显式的 `Reserved` 状态**——`sandboxStore.Reserve` 只是在 Redis 写一行元数据(sandboxID + teamID),不分配 State;真正进入 `Running` 是 `sandboxStore.Add` 之后。

```
            sandboxStore.Reserve (Redis 写元数据,无 State 字段)
                       │
                       │ CreateSandbox 成功 + sandboxStore.Add
                       ▼
            ┌──────────────────────┐
            │      Running         │◄────────────────┐
            └──┬─────────┬─────────┘                 │
               │         │                           │
       Pause   │  Kill   │  Checkpoint               │
       (API)   │ (API)   │  (内部)                  │
               │         │                           │
               ▼         ▼                           │
        ┌─────────┐  ┌─────────┐  ┌─────────────┐    │
        │ Pausing │  │ Killing │  │ Snapshotting│    │
        └────┬────┘  └────┬────┘  └──────┬──────┘    │
             │            │              │           │
             │ 完成       │ 完成         │ 完成      │ Resume
             ▼            ▼              ▼           │
        snapshots 表  billing.log   (回到 Running)───┘
        (Paused)      (killed)
```

### 2.3 Action 三件套

`states.go:11-47`:

```go
type TransitionEffect int

const (
    TransitionExpires   TransitionEffect = iota  // 完成后从 store 移除(Pause/Kill)
    TransitionTransient                          // 完成后回 Running(Snapshot)
)

type StateAction struct {
    Name        string           // "pause" / "kill" / "snapshot"
    TargetState State            // StatePausing / StateKilling / StateSnapshotting
    Effect      TransitionEffect
}

var (  // struct 值不能用 const
    StateActionPause = StateAction{Name: "pause", TargetState: StatePausing, Effect: TransitionExpires}
    StateActionKill  = StateAction{Name: "kill",  TargetState: StateKilling, Effect: TransitionExpires}
    StateActionSnapshot = StateAction{Name: "snapshot", TargetState: StateSnapshotting, Effect: TransitionTransient}
)
```

### 2.4 KillReason 枚举

`states.go:49-58`:

| KillReason | 触发场景 |
|---|---|
| `Unknown` | 默认值 |
| `Request` | `DELETE /sandboxes/{id}` |
| `Timeout` | evictor 因 EndTime 过期触发 |
| `Admin` | `POST /admin/teams/.../sandboxes/kill` |
| `Orphaned` | orchestrator 重启后 Redis 有但本地无 |
| `BaseTemplateMissing` | 模板被删,无法继续运行 |

### 2.5 关键常量(`states.go:9-92`)

| 常量 | 值 | 含义 |
|---|---|---|
| `StaleCutoff` | 10 分钟 | sandbox Reserve 后超过此时间仍未 Add 到 store,视为僵尸 |
| `SandboxTimeoutDefault` | 15 秒 | 默认 EndTime(最小值) |
| `AutoPauseDefault` | false | 默认超时直接 kill,不自动暂停 |

---

## 三、API 端点全景

OpenAPI 端点(`spec/openapi.yml`):

| 路径 | 方法 | 处理器 | 角色 |
|---|---|---|---|
| `/sandboxes` | POST | `PostSandboxes`(`sandbox_create.go:59`)| **Create** |
| `/sandboxes/{id}` | DELETE | `DeleteSandboxesSandboxID`(`sandbox_kill.go:39`)| **Kill** |
| `/sandboxes/{id}` | GET | `GetSandboxesSandboxID`(`sandbox_get.go:94`)| **Status** |
| `/sandboxes/{id}/pause` | POST | `PostSandboxesSandboxIDPause`(`sandbox_pause.go:26`)| **Pause** |
| `/sandboxes/{id}/resume` | POST | `PostSandboxesSandboxIDResume`(`sandbox_resume.go:28`)| **Resume** |
| `/sandboxes/{id}/connect` | POST | `PostSandboxesSandboxIDConnect`(`sandbox_connect.go:24`)| 运行中=keep-alive,暂停=隐式 resume |
| `/sandboxes/{id}/refreshes` | POST | `PostSandboxesSandboxIDRefreshes`(`sandbox_refresh.go:18`)| 延长 EndTime |
| `/sandboxes/{id}/timeout` | POST | `PostSandboxesSandboxIDTimeout`(`sandbox_timeout.go:17`)| 设置/缩短 EndTime |
| `/sandboxes/{id}/network` | PUT | `PutSandboxesSandboxIDNetwork`(`sandbox_network_update.go:21`)| 更新 egress/ingress 规则 |
| `/admin/teams/{tid}/sandboxes/kill` | POST | 见 `admin-module.md` | 管理员批量 kill |

### 安全方案

所有 sandbox 端点都接受 4 种 scheme 组合(ApiKeyAuth / AccessTokenAuth / AuthProviderBearerAuth+AuthProviderTeamAuth / AdminApiKeyAuth+AdminTeamAuth),与 `/v2/templates` 一致(见 `template-build-flow.md` §3)。

---

## 四、CP API 层的 Sandbox 编排器

`packages/api/internal/orchestrator/orchestrator.go:45` 定义 `Orchestrator` struct,它是 API 进程内**所有 sandbox 操作的入口**(注意不要和 orchestrator 进程混淆——这是 API 进程内的客户端封装)。

### 4.1 关键方法

| 方法 | 文件:行 | 职责 |
|---|---|---|
| `CreateSandbox` | `create_instance.go:135` | 冷启动 + resume 的统一入口 |
| `RemoveSandbox` | `delete_instance.go:23` | Kill/Pause 的统一入口(参数化 Action) |
| `KeepAliveFor` | `keep_alive.go:19` | Refresh / set-timeout |
| `UpdateSandbox` | `update_instance.go:20` | 把新 EndTime 或 egress 推到 orchestrator |
| `GetNode` | `client.go:121` | 取节点 gRPC 客户端(singleflight) |
| `GetClusterNodes` | `client.go:236` | 列出集群节点 |

### 4.2 `Orchestrator` struct 关键字段

```go
// orchestrator.go:45-84(节选)
type Orchestrator struct {
    sandboxStore       *sandbox.Store                          // Redis 后端
    nodes              *smap.Map[*nodemanager.Node]            // 节点缓存(并发安全 map)
    clusters           *clusters.Pool                          // 多集群拓扑
    featureFlagsClient *featureflags.Client
    snapshotCache      SnapshotCacheInvalidator                // 接口(见 :41-43),只有 Invalidate(ctx, sandboxID)
    routingCatalog     e2bcatalog.SandboxesCatalog             // Redis 路由表(client-proxy 读)
    placementAlgorithm *placement.BestOfK                      // 放置算法
    snapshotUpsertSem  *utils.AdjustableSemaphore              // 并发 upsert 限速(可热调容量)
    // ...
}
```

### 4.3 节点客户端管理

`client.go` 用两个 singleflight group(`connectGroup` / `discoveryGroup`)防止并发重复连接同一节点:

- `connectToNode`(client.go:20) — 直连某个已知 nodeID
- `connectToClusterNode`(client.go:46) — 走 cluster 路由
- `getOrConnectNode`(client.go:142) — 缓存未命中时按需发现并连接
- `discoverNomadNodes`(client.go:180) — 通过 Nomad 服务发现本集群所有节点
- `discoverClusterNode`(client.go:209) — 通过 cluster 的 edge API 发现远端节点

详见 `clusters-module.md` §7。

---

## 五、Create(冷启动):HTTP → gRPC → Firecracker

### 5.1 Handler 流程

`sandbox_create.go:59` 的 `PostSandboxes`:

```
PostSandboxes
  ├─ ParseBody[api.Sandbox]
  ├─ 解析模板 alias:name ?? alias
  ├─ templateCache.Get(templateID, tag, teamID, clusterID)
  │     // 取得 buildID + KernelVersion + FirecrackerVersion + EnvdVersion
  ├─ sandboxID = "i-" + id.Generate()
  ├─ body 强制约束:timeout、network、volume
  ├─ getSandboxData 闭包:延迟求值 sandbox 元数据
  └─ startSandbox ─────────────────────────────────────┐
                                                         │
                                                         ▼
                                            sandbox.go:23 startSandbox
                                              ├─ startSandboxInternal
                                              │   ├─ buildCreationMetadata
                                              │   │   // 打包 MCP / headers
                                              │   ├─ 计算 endTime
                                              │   └─ orchestrator.CreateSandbox ──┐
                                              └─ 返回                              │
                                                                                     ▼
                                                                       create_instance.go:135
                                                                         CreateSandbox
```

### 5.2 `CreateSandbox` 详解(`create_instance.go:135`)

```
CreateSandbox(ctx, team, sandboxID, executionID, getSandboxData, startTime, endTime, timeout, isResume, creationMeta)
  │
  ├─ finishStart, waitForStart, err := sandboxStore.Reserve(team.Team.ID, sandboxID, SandboxConcurrency)
  │     // 并发限制:同一 team 不能超过 SandboxConcurrency
  │     // 返回三个值:finishStart(完成后回调)、waitForStart(等待已有启动)、err
  │
  ├─ if waitForStart != nil:
  │     // 已有同 sandboxID 在启动,等它结束(直接 return)
  │     sbx = waitForStart(ctx)
  │     return sbx
  │
  ├─ defer { finishStart(sbx, apiErr) }  // 无论成功失败都要回调 store
  │
  ├─ sbxData, fetchErr := getSandboxData(ctx)  // 真正解析 Sandbox 元数据
  │
  ├─ fcSemver := fcversion.New(sbxData.Build.FirecrackerVersion)
  │
  ├─ 构造 SandboxCreateRequest:
  │     - SandboxConfig(模板/build/资源/network/volumes/...)
  │     - StartTime = now
  │     - EndTime   = endTime
  │     - Snapshot  = isResume  // ← resume 标志
  │
  ├─ if isResume && sbxData.NodeID != nil:
  │     // 节点亲和:sbxData.NodeID 是 buildResumeSandboxData 从 snap.OriginNodeID 赋过来的
  │     node = GetNode(clusterID, *sbxData.NodeID)
  │     if node != nil && node.Status() == Ready:
  │        preferredNode = node  // 传给 PlaceSandbox
  │
  ├─ placed, err := placement.PlaceSandbox(ctx, algorithm, clusterNodes, preferredNode, sbxRequest, ...)
  │     // 节点亲和失败或非 resume:PlaceSandbox 内部自行 chooseNode
  │     // 若 placement 超时且 isResume → maybeRemapResumeOriginNode
  │
  ├─ sandbox.NewSandbox(...)  // 构造 store 用的 Sandbox struct
  ├─ sandboxStore.Add(sbx, &creationMeta)
  │     // 异步触发 addSandboxToRoutingTable(写 Redis 路由表)
  │
  └─ return sbx
```

### 5.3 `placement.PlaceSandbox`(`placement/placement.go:43`)

placement 是 API 层的调度算法。它接收一组候选节点 + 可选 preferredNode(resume 亲和),按 retry 循环挑选:

```
PlaceSandbox
  ├─ if preferredNode != nil:
  │     node = preferredNode  // resume 时优先用原节点
  │
  ├─ for attempt := 0; attempt < maxRetries; attempt++ {
  │     if node == nil:
  │       node = algorithm.chooseNode(ctx, clusterNodes, nodesExcluded, ...)
  │         // BestOfK.chooseNode (placement_best_of_K.go:93):
  │         //   1) sample K=3 个候选(随机抽样)
  │         //      sample 内部跳过:excluded、非 Ready、CPU 不兼容、labels 不兼容
  │         //   2) 对每个候选用 Score() 计算负载评分
  │         //   3) 选评分最低的(score 越低 = 越空闲)
  │
  │     err = node.SandboxCreate(ctx, req)
  │       // 调 gRPC Sandbox.Create
  │
  │     if err == nil:
  │       node.OptimisticAdd(ctx, ...)  // 乐观更新资源占用
  │       return {Node: node}, nil
  │
  │     switch grpc.Code(err):
  │       case ResourceExhausted:
  │         // 节点满,只 Skip 不计入 attempt(不 exclude,下次还可选)
  │         node.PlacementMetrics.Skip(...)
  │       default:
  │         // 其他错误,exclude 节点 + attempt++
  │         nodesExcluded[failedNode.ID] = struct{}{}
  │         attempt++
  │     }
  │
  └─ return ErrSandboxCreateFailed
```

#### Score 公式(`placement_best_of_K.go:35-61`)

```
Score = (cpuRequested + reserved + α·usageAvg) / (R·cpuCount)
```

| 参数 | 含义 | 默认 |
|---|---|---|
| `cpuRequested` | 本沙箱申请的 vCPU 数 | — |
| `reserved` | 节点已分配 CPU + 进行中的(PlacementMetrics.InProgress) | — |
| `usageAvg` | 节点 CPU 使用率(`CpuPercent / 100`)| — |
| `R` | 集群超分比 | `4` |
| `α` | CPU 使用率权重 | `0.5` |
| `K` | 每次采样的候选数 | `3` |

**不是简单的"挑资源最少的"**:而是综合"已分配 + 申请 + 当前使用率"的负载评分。score 越低 = 节点越空闲 = 越优先。

#### `failed` 路径(超时识别)

`PlaceSandbox` 用 `failed(err)` 闭包判断是否超时(`ctx.Err() != nil`),返回 `PlacementResult{WarmedNode: firstTriedNode, TimedOut: true}`。`WarmedNode` 是第一个真正尝试创建(非 ResourceExhausted 拒绝)的节点,后续 `maybeRemapResumeOriginNode` 会把 snapshot 的 origin 指向它,避免下次 resume 又重新拉 memfile。

### 5.4 `SandboxCreateRequest` 关键字段(`orchestrator.proto:114`)

```protobuf
message SandboxCreateRequest {
  SandboxConfig sandbox = 1;
  google.protobuf.Timestamp start_time = 2;
  google.protobuf.Timestamp end_time = 3;
}

message SandboxConfig {
  string template_id           = 1;
  string build_id              = 2;
  string kernel_version        = 3;
  string firecracker_version   = 4;
  bool   huge_pages            = 5;
  string sandbox_id            = 6;
  map<string,string> env_vars  = 7;
  map<string,string> metadata  = 8;
  optional string alias        = 9;
  string envd_version          = 10;
  // ...
  int64  vcpu                  = 11;
  int64  ram_mb                = 12;
  string team_id               = 13;
  int64  max_sandbox_length    = 14;
  int64  total_disk_size_mb    = 15;
  bool   snapshot              = 16;  // = isResume
  string base_template_id      = 17;
  bool   auto_pause            = 18;
  optional string envd_access_token = 19;
  string execution_id          = 20;
  optional bool allow_internet_access = 21;
  optional SandboxNetworkConfig network = 22;
  repeated SandboxVolumeMount volumeMounts = 23;
  optional SandboxAutoResumeConfig auto_resume = 24;  // 嵌套 message,不是 bool
  bool   auto_pause_filesystem_only = 25;
  int64  events_ttl_days       = 26;
}

message SandboxAutoResumeConfig {
  string policy = 1;          // "off" / "any" 等(API 层拥有)
  uint64 timeout_seconds = 2; // 初始 create 的 timeout(秒)
}
```

---

## 六、Firecracker 集成

orchestrator 进程内的 `pkg/sandbox/fc/` 封装了 Firecracker 进程管理。

### 6.1 启动方式:unshare + bash 脚本

`fc/process.go:159-225` 的 `NewProcess`:

```go
// 1. 用 StartScriptBuilder 生成 bash 启动脚本
startScript := NewStartScriptBuilder(config).Build(versions, files, rootfsPaths, slot.NamespaceID())

// 2. 在专用 mount namespace 启动
cmd := exec.CommandContext(ctx, "unshare", "-m", "--", "bash", "-c", startScript.Value)
```

`unshare -m` 创建新的 mount namespace,让 FC 进程内看到的挂载点不影响 host。这是 Firecracker 集成的核心隔离手段。

### 6.2 FC 进程对象

`Process` struct(`process.go:135-158`)的关键字段:

```go
type Process struct {
    cmd                 *exec.Cmd
    firecrackerSocketPath string   // unix socket 路径,FC API
    client              *apiClient           // 见 client.go
    slot                *network.Slot        // 网络配置
    Exit                *utils.ErrorOnce     // FC 进程退出信号
    // ...
}
```

### 6.3 FC API 调用顺序(Create 冷启动)

`Process.Create`(`process.go:319-510`)按以下顺序调 FC REST API(通过 unix socket):

```
Create
  ├─ setMetrics             // 配置 metrics FIFO
  ├─ setBootSource          // 内核镜像 + kernel args
  ├─ setRootfsDrive        // rootfs(占位 /dev/null,实际由 NBD 接管)
  ├─ setNetworkInterface   // TAP 设备
  ├─ setMachineConfig      // vCPU / 内存 / hugePages
  ├─ setEntropyDevice
  ├─ installBalloon?       // 可选:Free Page Hinting
  ├─ setMmds?              // cold boot 时:写 access token hash 给 envd
  └─ startVM               // 启动!
```

### 6.4 Boot Source(kernel args)

`process.go:369-393` 的 kernel args:

| arg | 含义 |
|---|---|
| `quiet loglevel=1` | 静默内核日志 |
| `init=<InitScriptPath>` | 用户态 init 脚本 |
| `ip=<nsIP>::<tapIP>:<mask>:instance:<vpeerName>:off:<tapName>` | 内核态 IP 配置(无 DHCP)|
| `ipv6.disable=0 ipv6.autoconf=1` | IPv6 自动配置 |
| `panic=1 reboot=k` | panic 时立即重启 |
| `pci=off` | 禁用 PCI(降低攻击面) |
| `i8042.nokbd`、`i8042.noaux` | 禁用键盘/AUX 控制器 |
| `random.trust_cpu=on` | 信任 CPU RNG |
| `rootflags=discard` | rootfs TRIM 支持 |

### 6.5 MMDS(metadata 服务)

`fc/mmds.go:6` 定义 `MmdsMetadata`,在 cold boot 时通过 FC MMDS(mock metadata service)传给 guest:

```go
type MmdsMetadata struct {
    SandboxID            string `json:"instanceID"`
    TemplateID           string `json:"envID"`
    LogsCollectorAddress string `json:"address"`
    AccessTokenHash      string `json:"accessTokenHash,omitempty"`  // envd 鉴权用
}
```

**注意**:Go 字段名与 JSON tag 不同(`SandboxID` ↔ `instanceID` 等),序列化以 JSON tag 为准——注释明确说"serialization should not be changed"。envd 启动时通过 `169.254.169.254` 取这些字段(类似 AWS EC2 metadata)。

### 6.6 FC 版本路径

`fc/config.go:26-80`:

```go
type Config struct {
    KernelVersion      string
    FirecrackerVersion string
}

HostKernelPath(version, arch) = ${HostKernelsDir}/{version}/{arch}/{artifact.KernelFileName}
FirecrackerPath(version, arch) = ${FirecrackerVersionsDir}/{version}/{arch}/firecracker
```

模板构建时(`template-build-flow.md` §17.1)由 `BuildFirecrackerVersion` / `BuildKernelVersion` feature flag 决定,运行时 sandbox 沿用其模板的版本。

---

## 七、网络初始化:veth + TAP + iptables + nftables

`pkg/sandbox/network/` 在 host 上为每个 FC VM 搭建独立网络命名空间。

### 7.1 网络拓扑

设备名是动态生成的(`s.VethName()` / `s.VpeerName()` / `s.TapName()`),不是固定字符串。

```
       ┌─────────────────────────── host 网络命名空间 ───────────────────────────┐
       │                                                                          │
       │   ┌─────────┐                                                            │
       │   │  veth   │ ← 配 host IP(= sandbox 默认网关),路由到 default gateway  │
       │   └────┬────┘                                                            │
       │        │ veth pair                                                        │
       │   ┌────┴────┐                                                            │
       │   │ iptables│ nat POSTROUTING -o veth -j MASQUERADE  (出站 SNAT)         │
       │   │ rules   │ FORWARD 规则(允许 sandbox ↔ host 流量)                    │
       │   │ + 路由  │ host→FC namespace 路由                                       │
       │   └────┬────┘                                                            │
       │        │                                                                 │
       └────────┼─────────────────────────────────────────────────────────────────┘
                │ veth pair
       ┌────────┼──────── sandbox 网络命名空间 ───────┐
       │   ┌────┴────┐                                 │
       │   │ vpeer   │ ← 配 NS IP                      │
       │   └────┬────┘                                 │
       │        │                                      │
       │   ┌────┴────┐    ┌──────────┐                 │
       │   │  tap    │ ←► │ FC VM    │                 │
       │   └─────────┘    │ eth0 =   │                 │
       │   ┌─────────┐    │ tap MAC  │                 │
       │   │   lo    │    └──────────┘                 │
       │   └─────────┘                                 │
       │   ┌─────────┐                                 │
       │   │ default │                                 │
       │   │ route → │                                 │
       │   │ vethIP  │                                 │
       │   └─────────┘                                 │
       │   ┌─────────┐                                 │
       │   │iptables │ nat POSTROUTING -s NS_IP (SNAT)│
       │   │(sandbox │ nat PREROUTING -d vethIP (DNAT)│
       │   │  NS 内) │ mangle POSTROUTING -j DSCP     │
       │   │         │ nftables Firewall (egress)     │
       │   └─────────┘                                 │
       └───────────────────────────────────────────────┘
```

**关键**:SNAT/DNAT(nat POSTROUTING/PREROUTING)在 **sandbox NS** 内,host NS 只有 MASQUERADE 和 FORWARD。nftables Firewall 也在 sandbox NS 内,匹配来自 TAP 的流量做 egress 控制。

### 7.2 `Slot.CreateNetwork`(`network/network.go:78-350`)

主要步骤(约 20 步,按代码顺序):

```
CreateNetwork
  ├─ runtime.LockOSThread + 保存 host NS
  ├─ 检查并回收 stale namespace
  ├─ netns.NewNamed(s.NamespaceID())
  ├─ 创建 veth/vpeer 对
  ├─ vpeer 配 NS IP
  ├─ veth 移到 host NS
  ├─ host NS 中给 veth 配 host IP
  ├─ 回到 sandbox NS
  ├─ 创建 TAP 设备(netlink.Tuntap)
  ├─ 配 TAP IP
  ├─ 起 lo
  ├─ 默认路由经 veth host IP
  ├─ iptables(sandbox NS 内):
  │     nat POSTROUTING -s NS_IP -j SNAT  (出站源地址转换)
  │     nat PREROUTING  -d vethIP -j DNAT (入站目的地址转换)
  ├─ iptables:mangle POSTROUTING -j DSCP(可选 QoS)
  ├─ InitializeFirewall(nftables,见 §7.3)
  ├─ 回 host NS
  ├─ host→FC namespace 路由
  ├─ host FORWARD 规则
  ├─ nat POSTROUTING MASQUERADE(出 host NS 时 SNAT)
  ├─ hyperloop/portmapper/NFS proxy 流量 redirect 到本地端口
  └─ egressProxy.OnSlotCreate
```

`runtime.LockOSThread` 是关键:整个网络操作必须在一个固定的 OS 线程上执行,因为 netns 切换是线程级状态。

**SNAT/DNAT 不是"双向 NAT"这个术语**:POSTROUTING 是源地址转换(出站),PREROUTING 是目的地址转换(入站),各为一个方向的 NAT。

### 7.3 `Firewall`(nftables)

`firewall/firewall.go:27-470` 基于 nftables(不是老 iptables)实现:

| 规则 | 作用 |
|---|---|
| tap iface match | 匹配来自 TAP 的流量 |
| IP-set(allow/deny CIDR)| 用户自定义 egress allowlist/denylist |
| established accept | 已建立连接放行 |
| tap drop | 默认拒绝 |
| BYOP 规则 | SOCKS5 egress proxy 自定义链 |

`DenyEgress`(L408)在 resume 的 "throwaway" 路径中使用:不让 snapshot-derived 沙箱在确认正常前对外发包。

### 7.4 Slot 复用

`pool.go:130-300` 的 `Pool` 维护一组预热的 slot,避免每次沙箱启动都创建新 namespace:

- `Populate` 启动时预创建一批 slot
- `Get` 优先复用空闲 slot,否则 `createNetworkSlot` 新建
- `ReturnAsync` 沙箱关闭后异步回收 slot(网络配置保留,下次复用)

slot 持久化后端(`storage_*.go`)支持 Redis / memory / kv,用于 orchestrator 重启后恢复 slot 状态。

---

## 八、NBD / 模板 rootfs 加载

`pkg/sandbox/nbd/` 实现 **Network Block Device**(NBD)协议,把模板 rootfs 从 GCS 暴露成 `/dev/nbdX` 给 FC。

### 8.1 为什么要 NBD?

模板 rootfs 可能很大(几 GB),orchestrator 节点本地不一定有。NBD 的妙用:
- FC 看到 `/dev/nbdX` 像本地块设备
- 实际读写由 NBD 服务端(orchestrator 进程内)处理
- NBD 服务端按需从 GCS 拉取(只读所需 chunk)

### 8.2 `DevicePool`(`/dev/nbdX` 设备池)

`pool.go:75-340`:

```go
type DevicePool struct {
    maxSlotsReady int             // 预热数量
    devices       map[string]*DeviceSlot
    // ...
}

// getMaxDevices 通过读 /sys/module/nbd/parameters/nbds_max 确定可用 nbd 设备数
// 该值由 modprobe nbd nbds_max=N 决定(推荐 4096,见 pool.go:74 注释)
func getMaxDevices() int
```

每个 nbd 设备通过 ioctl(`NBD_SET_SOCK`、`NBD_DO_IT`)绑定到一个 socketpair,socketpair 的另一端是 dispatch goroutine。`/sys/block/nbdX/` 只用于查单个设备的连接状态。

### 8.3 `DirectPathMount`(实际是 NBD 客户端 + 服务端)

`path_direct.go:45-370`,虽然名字叫 "DirectPath",实际是 NBD 实现:

```
DirectPathMount.Open
  ├─ devicePool.GetDevice         // 拿一个空闲 /dev/nbdX
  ├─ socketpair()
  ├─ go dispatch.Handle(socket, blockDevice, ...)
  │     // dispatch 是 NBD 服务端,把 read/write 请求转给 blockDevice
  │     // blockDevice 来自 template.Rootfs(),见 §8.4
  ├─ ioctl NBD_SET_SOCK
  ├─ ioctl NBD_DO_IT
  └─ return /dev/nbdX 路径
```

### 8.4 `block.Device` 来源(template cache)

`DirectPathMount` 接收的 `block.Device` 来自 `template.Rootfs()`(`pkg/sandbox/template/template.go:16`):

```go
type Template interface {
    Files() storage.CachePaths
    Memfile(ctx context.Context) (block.ReadonlyDevice, error)   // 内存快照(用于 resume)
    Rootfs() (block.ReadonlyDevice, error)                       // rootfs(只读)
    Snapfile() (File, error)                                     // VM 状态文件(CPU/设备寄存器)
    Metadata() (metadata.Template, error)
    UpdateMetadata(meta metadata.Template) error
    Close(ctx context.Context) error
}
```

> **注意**:`memfile` 是内存快照,`snapfile` 是 VM 状态(CPU/设备寄存器);resume 时两者都要。所有方法都返回 `(value, error)` 二元组(`Files()` 例外,因为它从缓存读取,不会失败)。

`Storage` struct(`template/storage.go:25`)包装 `block.Device`,实现 `ReadAt` / `Slice` / `Size`,从 GCS 按需读取。NBD 层只负责暴露成 `/dev/nbdX`,GCS 拉取/缓存由 `template/` 层负责。

详见 `template-cache-module.md`(待写)。

---

## 九、uffd 与内存快照恢复

`pkg/sandbox/uffd/` 实现 **userfaultfd**(用户态缺页处理),用于 resume 时高效恢复内存。

### 9.1 为什么需要 uffd?

Resume 时需要把 pause 时的内存状态恢复到 FC 进程。两种做法:
1. **全量预读**:把整个 memfile 读到 FC 内存,再 startVM。慢。
2. **uffd(按需 page-in)**:FC 启动时遇到缺页,触发 uffd handler,handler 从 memfile 读对应 page,再交给 FC。快。

E2B 选 uffd。详见 `pkg/sandbox/uffd/`。

### 9.2 uffd 工作流

```
Factory.ResumeSandbox
  ├─ uffdPromise = uffd.New(memfile, fcUffdPath)
  │     // 创建 uffd fd,注册到 memfile 区域
  │
  ├─ 后台 prefetcher(可选):
  │     if metadata.Prefetch.Memory != nil:
  │         go prefetch.New(memfile, prefetchRanges).Start
  │             // 主动 read-ahead 一些热点 page,减少缺页次数
  │
  ├─ fc.NewProcess with RootfsPaths
  ├─ fcHandle.Resume
  │     // LoadSnapshot 时,FC 不直接读 memfile,而是用 uffd fd
  │     // FC 第一次访问某 page → uffd 通知 → handler 从 memfile 读 → 解阻塞
  │
  └─ WaitForEnvd(StartTypeResume, ...)
        // 等 envd 完成 /init 握手
```

### 9.3 filesystem-only resume(走 reboot 路径)

`reboot.go:39` 处理「只有 rootfs diff,没有 memfile」的快照:不走 uffd,而是 cold boot + 重新跑 init。比 uffd 慢但兼容更多场景。

---

## 十、Pause:从运行中到快照

`POST /sandboxes/{id}/pause` 触发的完整流程,跨 4 个层(handler → API orchestrator → gRPC → orchestrator 进程)。

### 10.1 Handler 层

`sandbox_pause.go:26-100`:

```go
PostSandboxesSandboxIDPause
  ├─ 取 sandbox from store
  ├─ filesystemOnly := body.Memory == false  // 默认 memory=true
  └─ orchestrator.RemoveSandbox(ctx, teamID, sandboxID, RemoveOpts{
        Action:         StateActionPause,
        FilesystemOnly: filesystemOnly,
    })
```

### 10.2 API orchestrator 层

`delete_instance.go:23-130` 的 `RemoveSandbox` + `pause_instance.go:32-180` 的 `pauseSandbox`:

```
RemoveSandbox(Action: Pause)
  ├─ sandboxStore.StartRemoving(sandboxID, Action)
  │     // State: Running → Pausing
  │
  ├─ removeSandboxFromNode(sandbox, node, action)
  │     │
  │     ├─ switch action:
  │     │     case StateActionPause → pauseSandbox(...)
  │     │     case StateActionKill  → killSandboxOnNode(...)
  │     │
  │     └─ routingCatalog.DeleteSandbox(sandboxID)
  │           // 从 Redis 路由表移除(client-proxy 不再路由)
  │
  └─ sandboxStore.Remove(sandboxID)
       // 从 Redis store 删除
```

**预期副作用**:pause 删除路由表后,如果有 SDK 流量进来,client-proxy 会在 catalog 找不到 sandbox,触发 auto-resume(§14.2)。这是**预期行为**:pause 后立即有流量 → 立即拉回。不是 bug。

### 10.3 `pauseSandbox`(`pause_instance.go:32`)

```
pauseSandbox
  ├─ throttledUpsertSnapshot(ctx, params)
  │     // snapshotUpsertSem 控制并发(避免 DB 写入压垮)
  │     // 先在 snapshots 表 upsert 一行(status=snapshotting)
  │     // 这样 GET /sandboxes/{id} 能立刻看到 paused
  │
  ├─ gRPC Sandbox.Pause
  │     // 真正告诉 orchestrator 节点开始快照
  │
  ├─ UpdateEnvBuildStatus(buildID, Success)
  │     // 把对应 build 状态标 Success(pause 创建的新 build)
  │
  └─ 返回 SchedulingMetadata(包含新 buildID)
```

### 10.4 orchestrator 进程内 `Sandbox.Pause`(`pkg/sandbox/sandbox.go:1253`)

注释在 `:1238-1252`。流程(严格按代码顺序):

```
Sandbox.Pause
  ├─ Checks.Stop                    // 停止健康检查
  │
  ├─ bestEffortReclaim              // 在 guest 内执行 fstrim/sync/drop_caches/compact_memory
  │     // 释放空闲页,缩小快照体积。LD flag 控制各步超时,默认 0 = 禁用
  │     // 失败不致命(non-fatal);reclaim 冻结了 cgroup,失败时 cleanup 会 unfreeze
  │
  ├─ if filesystemOnly:
  │     guestPrepareFsForPause       // guest 内 fsfreeze,刷 page cache 到盘
  │     m.Prefetch = nil             // memfile 不持久化,prefetch 失效
  │
  ├─ m = m.MarkFilesystemOnly(filesystemOnly)
  │     // 写入 metadata(resume 时据此刻判断走 reboot 还是 memory-resume)
  │
  ├─ if FreePageHintingTimeout > 0:  // LD flag 控制,0 = 禁用
  │     process.DrainBalloon         // 释放 free pages hinting
  │
  ├─ process.Pause(ctx)              // 暂停 FC vCPUs
  │
  ├─ process.FlushMetrics(ctx)       // best-effort 刷 metrics(忽略错误)
  │     // 必须在 rootfs export goroutine 关 FC API socket 之前
  │
  ├─ process.CreateSnapshot(ctx, snapfile.Path())
  │     // 自定义 FC:仅创建 snapfile + drain + flush virtio disk
  │     // filesystem-only 时也调(为了 disk flush),只是 snapfile 不上传
  │
  ├─ if !filesystemOnly:
  │     processMemorySnapshot(ctx, buildID)  // sandbox.go:1456
  │       // 关键:s.Resources.memory.DiffMetadata(ctx, s.process)
  │       //   返回 memfileDiffMetadata(含 Dirty 位图 — roaring bitmap)
  │       // 然后 pauseProcessMemory 从 FC 进程内存直接拷贝 dirty pages 到 diff file
  │       // 支持 dedup(可选,LD flag)
  │
  ├─ pauseProcessRootfs
  │     // 生成 rootfs diff(后续 pause 出来的快照只存 diff)
  │
  ├─ schedulingMetadata := scheduling.FromHeaders(buildID, mem.header, rootfsHeader, ...)
  │     // 同步派生调度元数据(不让 Pause 阻塞在异步 memfile dedup 上)
  │
  ├─ m.ToFile(metadataFileLink.Path())
  │
  └─ return Snapshot{Snapfile, Metafile, MemorySnapshot, RootfsDiff, SchedulingMetadata, ...}
```

### 10.5 异步上传 GCS

pause 返回后,orchestrator 后台把 snapshot 上传到 GCS:

```
uploadSnapshotAsync
  ├─ retry 直到上传成功(最长 2h)
  └─ templateCache.AddSnapshot
        // 加入本地缓存,下次 resume 可直接用

harvestResumePrefetchAsync
  └─ 分析快照访问模式,优化 prefetch 策略
```

---

## 十一、Resume:从快照恢复

`POST /sandboxes/{id}/resume` 或 `/connect`(对 paused 沙箱)触发。

### 11.1 Handler 流程(`sandbox_resume.go:28-190`)

```
PostSandboxesSandboxIDResume
  ├─ sandboxStore.Get(sandboxID)
  │     // 可能 running,可能不在 store(paused)
  │
  ├─ if sbx != nil:
  │     switch sbx.State:
  │       case StatePausing:
  │         WaitForStateChange(ctx, timeout)
  │           // 等 pause 完成
  │       case StateSnapshotting:
  │         return 409 Conflict("snapshot being created")
  │       case StateRunning:
  │         return 409 Conflict("already running")
  │       case StateKilling:
  │         return 404
  │
  ├─ snap := snapshotCache.Get(sandboxID)
  │     // 取最近快照
  │
  ├─ buildResumeSandboxData(snap)
  │     // 从 snapshot 构造 SandboxMetadata
  │     // 关键:NodeID = snap.OriginNodeID ← 节点亲和!
  │
  └─ startSandbox(..., isResume=true)
        // 走 §5 的流程,但 Snapshot=true
```

### 11.2 节点亲和

`buildResumeSandboxData`(`sandbox_resume.go:192-220`)的关键:

```go
sbx.NodeID = snap.OriginNodeID
```

原因:uffd 恢复依赖 memfile 在本地缓存。原节点最可能已有 memfile(刚 pause 时上传过),所以 resume 优先在原节点。如果原节点不可用(下线/满载),走 `maybeRemapResumeOriginNode`(`create_instance.go:427`)重映射到其他 warm 节点。

### 11.3 orchestrator 进程内 resume 路径

`Server.Create`(orchestrator)检查 `req.Sandbox.Snapshot == true`,然后看 `template.Metadata().IsFilesystemOnly()`:

- **memory snapshot**(完整)→ `Factory.ResumeSandbox`(`sandbox.go:698`)
  - uffd + prefetch + LoadSnapshot + Resume + WaitForEnvd
- **filesystem-only**(无内存)→ `Factory.RebootSandbox`(`reboot.go:39`)
  - cold boot from rootfs,重新跑 init

详见 §9。

### 11.4 Connect 端点的回退式 resume

`POST /sandboxes/{id}/connect`(`sandbox_connect.go:24`)是 SDK 探活端点,但语义复合:

- 沙箱 running → `KeepAliveFor` 刷新 EndTime(keep-alive)
- 沙箱 paused(store 未命中且 snapshot 表有)→ 回退到 `startSandbox(isResume=true)` 触发完整 resume 流程
- 沙箱正处于状态切换中(Pausing→Running 等)→ 重试

实现上 `maxConnectRetries = 3`(`:64`),期间 `WaitForStateChange` 等待状态稳定。代码注释原文(`sandbox_connect.go:63`):"It could happen that after sandbox transition, it'll be again transitioning"——`maxConnectRetries` 是为应对**连续多次状态切换**而设,不是为"竞争"。

---

## 十二、Refresh / Timeout / Evictor

### 12.1 Refresh / set-timeout

`sandbox_refresh.go:18` 和 `sandbox_timeout.go:17` 都调 `Orchestrator.KeepAliveFor`,差别在 `allowShorter` 参数:

```go
// sandbox_refresh.go:57
orchestrator.KeepAliveFor(ctx, teamID, sandboxID, duration, allowShorter=false)
// sandbox_timeout.go:52
orchestrator.KeepAliveFor(ctx, teamID, sandboxID, duration, allowShorter=true)
```

`allowShorter=false` 表示不允许缩短 EndTime(refresh 只能延长);`true` 允许缩短(timeout 端点可以提前)。

### 12.2 `KeepAliveFor`(`keep_alive.go:19-80`)

```
KeepAliveFor(ctx, teamID, sandboxID, duration, allowShorter)
  ├─ sbx := sandboxStore.Get(sandboxID)
  ├─ if sbx == nil or sbx.State != Running:
  │     return NotRunningError
  │
  ├─ newEndTime = min(now + duration, getMaxAllowedTTL(sbx))
  │     // getMaxAllowedTTL 受 MaxInstanceLength 上限约束
  │
  ├─ if !allowShorter && newEndTime < sbx.EndTime:
  │     return nil  // 不缩短,直接返回
  │
  ├─ sandboxStore.Update(sandboxID, newEndTime)
  │     // 原子更新 Redis
  │
  └─ UpdateSandbox(ctx, teamID, sandboxID, WithEndTime(newEndTime))
        // gRPC Sandbox.Update 把新 EndTime 推到 orchestrator
```

### 12.3 Evictor(超时驱逐)

`packages/api/internal/orchestrator/evictor/evict.go:82-200` 是一个**独立的 goroutine**,每 50ms tick 一次:

```
Evictor.Start
  ├─ ticker = time.NewTicker(50ms)
  │
  └─ for {
       <-ticker.C
       refreshConcurrencyLimit()
         // 每 30s 从 LaunchDarkly 刷新 MaxConcurrentEvictions
       expired := sandboxStore.ExpiredItems(now)
       for each sbx in expired:
         concurrencyLimiter.Go(func() {
           evictSandbox(sbx)
         })
     }
```

### 12.4 `evictSandbox` 的双分支

`evict.go:151-200`:

```go
func evictSandbox(sbx *Sandbox) {
    var action StateAction
    var opts RemoveOpts

    if sbx.AutoPause {
        action = StateActionPause
        opts.FilesystemOnly = sbx.AutoPauseFilesystemOnly
        // 超时变 pause(写 snapshot)
    } else {
        action = StateActionKill
        opts.Reason = KillReasonTimeout
        // 超时变 kill
    }

    orchestrator.RemoveSandbox(ctx, sbx.TeamID, sbx.SandboxID, action, opts)
}
```

`AutoPause` 由 `SandboxConfig.auto_pause`(`orchestrator.proto` 字段号 18)控制,通常按 tier 设置:免费/低价 tier 不开启(直接 kill),付费 tier 开启(超时自动暂停)。

---

## 十三、Kill 与资源回收

### 13.1 Kill 触发路径

| 触发 | KillReason | 入口 |
|---|---|---|
| `DELETE /sandboxes/{id}` | `Request` | `sandbox_kill.go:39` |
| Evictor 超时(`AutoPause=false`) | `Timeout` | `evict.go:161` |
| `POST /admin/teams/.../sandboxes/kill` | `Admin` | 见 `admin-module.md` |
| Orchestrator 重启发现 orphan | `Orphaned` | `delete_instance.go:201` `killOrphanSandbox` |
| 模板被删 | `BaseTemplateMissing` | (内部清理)|

### 13.2 Kill 流程

```
DeleteSandboxesSandboxID (handler)
  └─ orchestrator.RemoveSandbox(Action: Kill, Reason: Request)
       ├─ sandboxStore.StartRemoving(sandboxID, Action: Kill)
       │     // State: Running → Killing
       │
       ├─ removeSandboxFromNode
       │     └─ killSandboxOnNode
       │           └─ gRPC Sandbox.Delete{kill_reason}
       │
       ├─ routingCatalog.DeleteSandbox
       │
       └─ sandboxStore.Remove
             // 同时:从 store 删除后,异步写 billing.sandbox_logs
```

### 13.3 orchestrator 进程内的 Stop

`Server.Delete` → `sbx.Stop` → `doStop`(`sandbox.go:1148`):

```
doStop
  ├─ Checks.Stop                      // 停健康检查
  ├─ fcStopErr := process.Stop(ctx)   // 给 FC 发 shutdown 信号
  ├─ cgroupKillErr := cgroupHandle.Kill(ctx)  // 杀 cgroup 内所有进程(兜底)
  │     // 上面两步的错误都收集到 errs,不中断后续清理
  ├─ select:
  │     case <-process.Exit.Done():   // 等 FC 进程退出
  │     case <-ctx.Done():            // 或 context 取消
  └─ uffdStopErr := Resources.memory.Stop()  // uffd 服务停止(所有沙箱都调,
                                              //  cold boot 的 sandbox 这里是 no-op)
```

**关键**:`memory.Stop()` 对所有沙箱都调用,但只有 resume 启动的沙箱(uffd 实际运行)会真正清理;冷启动沙箱这里是 no-op。错误用 `errors.Join` 聚合返回。

### 13.4 `Close` 资源回收

`sandbox.go:1126` 的 `Close` 在 `sbx.Stop` 之后调用,清理所有底层资源:

```
Close
  ├─ 清理 cgroup
  ├─ 删除本地工作目录(FC socket、FIFO、log)
  ├─ networkSlot.RemoveNetwork
  │     // 删除 namespace、veth、TAP、iptables 规则
  │     // nftables 规则
  ├─ nbdDevice.Release
  │     // 释放 /dev/nbdX
  └─ (可选)templateCache 引用计数减一
```

### 13.5 Orphan 清理(重启恢复)

orchestrator 重启后,`store.Reconcile`(`store.go:140`)对比 Redis 和本地 `sandbox.Map`:

- Redis 有但本地无 → `killOrphanSandbox`(`KillReasonOrphaned`)
- 本地有但 Redis 无 → 也清理(orchestrator 自发 stop)

这保证 orchestrator 重启后不会留下「Redis 以为还在跑,但本地其实已经死」的悬挂沙箱。

---

## 十四、Client-Proxy 数据面与 Auto-Resume

### 14.1 路由:从 host header 到 orchestrator:5007

`client-proxy/internal/proxy/proxy.go:138`:

```
NewClientProxy
  └─ reverseproxy.Proxy{TargetFromRequest: func(r) {
       host := r.Host
       sandboxID, port := parseHost(host)
         // host 形如 "<sandboxID>-<port>.sandbox.<domain>"
       
       info, err := catalog.GetSandbox(ctx, sandboxID)
         // 从 Redis 路由表取
       
       if err == ErrSandboxNotFound:
         info = handlePausedSandbox(sandboxID)
           // 触发 auto-resume,见 §14.2
       
       nodeIP := info.OrchestratorIP
       return "http://" + nodeIP + ":5007"
            // orchestratorProxyPort = 5007
     }}
```

### 14.2 Auto-Resume

`handlePausedSandbox`(`proxy.go:97-136`):

```go
func handlePausedSandbox(
    ctx context.Context,
    sandboxId string,
    sandboxPort uint64,
    trafficAccessToken string,
    envdAccessToken string,
    pausedChecker PausedSandboxResumer,
) (string, autoResumeResult, error) {
    // 通过 gRPC 通知 CP API 触发 resume(走 proxy.proto ResumeSandbox)
    nodeIP, err := pausedChecker.Resume(ctx, sandboxId, sandboxPort, trafficAccessToken, envdAccessToken)
    if err != nil {
        // 根据 gRPC status 返回不同的 autoResumeResult(NotAllAllowed/PermissionDenied/
        // StillTransitioning/ResourceExhausted/Errored)
        return "", mapErrToAutoResumeResult(err), wrapErr(err)
    }
    // 直接返回 gRPC 拿到的 nodeIP,**不**再回查 catalog
    // (上游 NewClientProxy 用这个 nodeIP 拼成 http://<node>:5007)
    return normalizeNodeIP(nodeIP), autoResumeSucceeded, nil
}
```

> **注意**:函数**不**回查 catalog。Resume 调用是同步的,orchestrator 在 resume 完成后才返回 nodeIP,所以拿到时沙箱已经 Running、路由表也已 upsert。上层 `NewClientProxy`(`proxy.go:138`)的 callback 把这个 nodeIP 拼成 `http://<nodeIP>:5007` 作为反代目标。

`autoresume.go`(`packages/api/internal/orchestrator/`)实现 CP API 端的处理:接收 client-proxy 的 resume 请求,走 §11 的 resume 流程。

### 14.3 orchestrator:5007 之后

流量到 orchestrator 节点的 5007 端口后,由 orchestrator 上的反向代理(`pkg/proxy/`、`pkg/portmap/`、`pkg/hyperloopserver/`)经 iptables redirect 规则进入 VM 的 TAP 设备(§7.2 第 ⑱ 步)。

**关键点**:client-proxy **不直接**连接 FC VM。它只到 orchestrator:5007,剩下的由 orchestrator 节点本机的 iptables/nftables 规则把流量引入对应 sandbox 的 TAP。

---

## 十五、关键时序图

### 15.1 完整 Create 时序

```
SDK                  CP API                Placement             Node(gRPC)         Orchestrator进程
──                   ──────                ──────────             ────────           ────────────────
POST /sandboxes ─►   PostSandboxes
                       ├─ templateCache.Get
                       ├─ sandboxID = "i-" + uuid
                       ├─ sandboxStore.Reserve ──► Redis(写 reserved)
                       └─ orchestrator.CreateSandbox
                            ├─ getSandboxData(取模板/build/版本)
                            ├─ fcversion.New
                            └─ placement.PlaceSandbox ──►
                                                    ├─ chooseNode
                                                    └─ node.SandboxCreate ─►
                                                                             gRPC Create ─►  Server.Create
                                                                                              ├─ Factory.CreateSandbox
                                                                                              │   ├─ getNetworkSlot
                                                                                              │   ├─ template.NewSandboxFiles
                                                                                              │   ├─ rootfs.NewNBDProvider
                                                                                              │   ├─ fc.NewProcess
                                                                                              │   │   ├─ startScript
                                                                                              │   │   └─ exec unshare bash
                                                                                              │   ├─ fc.Create
                                                                                              │   │   ├─ setBootSource
                                                                                              │   │   ├─ setRootfsDrive
                                                                                              │   │   ├─ setNetworkInterface
                                                                                              │   │   ├─ setMachineConfig
                                                                                              │   │   └─ startVM
                                                                                              │   ├─ WaitForEnvd
                                                                                              │   └─ MarkRunning
                                                                                              └─ return (clientId, scheduling)
                                                                            ◄─ resp ──────────
                                                  ◄─ resp ──────────
                       ◄─ SchedulingMetadata ────
                       ├─ sandboxStore.Add(sbx, Running)
                       ├─ routingCatalog.StoreSandbox ──► Redis(写路由)
                       └─ Posthog event
◄── 201 Created ───
```

### 15.2 Pause 时序

```
SDK                  CP API                            Node(gRPC)         Orchestrator进程
──                   ──────                            ────────           ────────────────
POST .../pause ─►    PostSandboxesSandboxIDPause
                       └─ orchestrator.RemoveSandbox(Action: Pause)
                            ├─ sandboxStore.StartRemoving
                            │     // State: Running → Pausing
                            ├─ throttledUpsertSnapshot ──► Postgres
                            │     // snapshots 行(status=snapshotting)
                            └─ gRPC Sandbox.Pause ─────────────────────────►  Server.Pause
                                                                                ├─ Checks.Stop
                                                                                ├─ bestEffortReclaim
                                                                                ├─ process.Pause(vCPUs)
                                                                                ├─ process.CreateSnapshot
                                                                                ├─ processMemorySnapshot
                                                                                │     // dirty pages → diff
                                                                                ├─ pauseProcessRootfs
                                                                                └─ return Snapshot
                                                          ◄─ snap info ──────
                            ├─ templateCache.AddSnapshot(本地)
                            ├─ UpdateEnvBuildStatus(Success)
                            ├─ routingCatalog.DeleteSandbox ──► Redis(删路由)
                            └─ sandboxStore.Remove ──► Redis(删 store)
                                  └─ async: 写 billing.sandbox_logs
◄── 200 {paused} ──

                              (异步,最长 2h)
                              uploadSnapshotAsync → GCS
                              harvestResumePrefetchAsync
```

### 15.3 Timeout 与 Evictor

```
 Evictor goroutine                  sandboxStore           orchestrator
 ────────────────                   ─────────────           ────────────────
 每 50ms tick:
   expired = store.ExpiredItems(now) ──► 找出 EndTime < now
   for sbx in expired:
     if sbx.AutoPause:
       RemoveSandbox(Action: Pause, FilesystemOnly: sbx.AutoPauseFilesystemOnly)
     else:
       RemoveSandbox(Action: Kill, Reason: Timeout)
```

### 15.4 Auto-Resume(client-proxy 触发)

```
SDK(发数据)        Client-Proxy              CP API(gRPC)         Node              Orchestrator
──                 ────────────              ────────────          ────              ────────────
GET /v1/sandbox ─►  reverseproxy
                      ├─ parseHost → sandboxID
                      ├─ catalog.GetSandbox ──► Redis:NotFound
                      ├─ handlePausedSandbox
                      │   └─ PausedSandboxResumer.Resume (gRPC, paused_sandbox_resumer_grpc.go:89)
                      │                                     │   proto: packages/shared/pkg/grpc/proxy/proxy.proto:23
                      │                                     ▼
                      │                              CP API 收到 gRPC ResumeSandbox 请求
                      │                              (走 §11 的 startSandbox(isResume=true) 流程)
                      │                                     ├─ snapshotCache.GetLast
                      │                                     └─ gRPC Sandbox.Create(snapshot=true) ──►  ResumeSandbox
                      │                                                                                ├─ uffd.New
                      │                                                                                ├─ prefetcher
                      │                                                                                ├─ fc.Resume
                      │                                                                                │   └─ LoadSnapshot
                      │                                                                                └─ WaitForEnvd
                      │                                          ◄─ resp ───────────────────────────────
                      │                                     ├─ routingCatalog.StoreSandbox ──► Redis
                      │                                     └─ sandboxStore.Add(Running)
                      ├─ (重试)catalog.GetSandbox ──► Redis:命中
                      └─ http://<node>:5007 ──────────────────────────────────────────────►  iptables redirect
                                                                                              │
                                                                                              ▼
                                                                                          FC VM (TAP)
◄── response ────
```

**注意**:client-proxy 触发 auto-resume 走的是 **gRPC**(proxy.proto 的 `ResumeSandbox`),不是 HTTP `/resume` 端点。HTTP `/resume` 端点是给 SDK/CLI 直接调用的。

---

## 十六、关键代码文件索引

### 16.1 CP API 层

| 文件 | 关键符号 | 行号 |
|---|---|---|
| `packages/api/internal/handlers/sandbox.go` | `startSandbox`, `startSandboxInternal`, `buildCreationMetadata` | `:23`, `:51`, `:100` |
| `packages/api/internal/handlers/sandbox_create.go` | `PostSandboxes` | `:59` |
| `packages/api/internal/handlers/sandbox_kill.go` | `DeleteSandboxesSandboxID`, `deleteSnapshot` | `:39`, `:21` |
| `packages/api/internal/handlers/sandbox_pause.go` | `PostSandboxesSandboxIDPause` | `:26` |
| `packages/api/internal/handlers/sandbox_resume.go` | `PostSandboxesSandboxIDResume`, `buildResumeSandboxData` | `:28`, `:192` |
| `packages/api/internal/handlers/sandbox_connect.go` | `PostSandboxesSandboxIDConnect`, `maxConnectRetries` | `:24`, `:64` |
| `packages/api/internal/handlers/sandbox_refresh.go` | `PostSandboxesSandboxIDRefreshes` | `:18` |
| `packages/api/internal/handlers/sandbox_timeout.go` | `PostSandboxesSandboxIDTimeout` | `:17` |
| `packages/api/internal/handlers/sandbox_get.go` | `GetSandboxesSandboxID` | `:94` |
| `packages/api/internal/sandbox/store.go` | `Store`, `NewStore`, `Add`, `Remove`, `ExpiredItems`, `Update`, `StartRemoving`, `WaitForStateChange`, `Reconcile`, `Reserve` | `:52`, `:59`, `:73`, `:104`, `:120`, `:128`, `:132`, `:136`, `:140`, `:157` |
| `packages/api/internal/sandbox/sandboxtypes/sandbox.go` | `Sandbox` struct, `NewSandbox`, `IsExpired`, `ToAPISandbox` | `:79`, `:13`, `:138`, `:117` |
| `packages/api/internal/sandbox/sandboxtypes/states.go` | `State`, `StateAction`, `AllowedTransitions`, `KillReason`, `SandboxTimeoutDefault`, `StaleCutoff` | `:95`, `:22`, `:83`, `:49-58`, `:90`, `:9` |
| `packages/api/internal/orchestrator/orchestrator.go` | `Orchestrator` struct | `:45` |
| `packages/api/internal/orchestrator/create_instance.go` | `CreateSandbox`, `SandboxMetadata`, `SandboxDataFetcher`, `buildEgressConfig`, `buildNetworkConfig`, `maybeRemapResumeOriginNode` | `:135`, `:40`, `:38`, `:63`, `:107`, `:427` |
| `packages/api/internal/orchestrator/delete_instance.go` | `RemoveSandbox`, `removeSandboxFromNode`, `killSandboxOnNode`, `killOrphanSandbox` | `:23`, `:126`, `:224`, `:201` |
| `packages/api/internal/orchestrator/pause_instance.go` | `pauseSandbox`, `snapshotInstance`, `buildUpsertSnapshotParams`, `throttledUpsertSnapshot` | `:32`, `:89`, `:125`, `:173` |
| `packages/api/internal/orchestrator/keep_alive.go` | `KeepAliveFor`, `getMaxAllowedTTL` | `:19`, `:73` |
| `packages/api/internal/orchestrator/update_instance.go` | `UpdateSandbox` | `:20` |
| `packages/api/internal/orchestrator/lifecycle.go` | `addSandboxToRoutingTable` | `:15` |
| `packages/api/internal/orchestrator/client.go` | `connectToNode`, `connectToClusterNode`, `getOrConnectNode`, `GetNode`, `discoverNomadNodes`, `discoverClusterNode`, `GetClusterNodes` | `:20`, `:46`, `:142`, `:121`, `:180`, `:209`, `:236` |
| `packages/api/internal/orchestrator/autoresume.go` | (auto-resume handler) | — |
| `packages/api/internal/orchestrator/evictor/evict.go` | `Evictor.Start`, `evictSandbox`, `pollInterval = 50ms` | `:82`, `:151`, `:23` |
| `packages/api/internal/orchestrator/placement/placement.go` | `PlaceSandbox` | `:43` |
| `packages/api/internal/orchestrator/placement/config.go` | `maxRetries = 3`(及 R/K/α 等 BestOfKConfig 默认值) | `:4` |
| `packages/api/internal/orchestrator/placement/placement_best_of_K.go` | `BestOfK`, `BestOfKConfig`(R=4, K=3, α=0.5), `Score`, `chooseNode`, `sample` | `:64`, `:16`, `:35`, `:93`, `:143` |
| `packages/api/internal/orchestrator/placement/cpu_compatibility.go` | `isNodeCPUCompatible` | `:12` |
| `packages/api/internal/orchestrator/placement/label_compatibility.go` | `isNodeLabelsCompatible` | `:11` |
| `packages/api/internal/orchestrator/nodemanager/node.go` | `Node` struct | — |
| `packages/api/internal/orchestrator/nodemanager/sandbox_create.go` | `SandboxCreate`(直接调 gRPC)| `:9` |

### 16.2 Orchestrator 进程层

| 文件 | 关键符号 | 行号 |
|---|---|---|
| `packages/orchestrator/pkg/sandbox/sandbox.go` | `Config`, `Metadata`, `Sandbox` struct, `Factory`, `NewFactory`, `CreateSandbox`, `ResumeSandbox`, `Pause`, `Stop`, `doStop`, `Close`, `Wait`, `WaitForEnvd`, `Shutdown` | `:89`, `:234`, `:260`, `:337`, `:348`, `:396`, `:698`, `:1253`, `:1141`, `:1148`, `:1126`, `:1122`, `:1740`, `:1185` |
| `packages/orchestrator/pkg/sandbox/map.go` | `Map` struct, `MarkRunning`, `MarkStopping`, `MarkStopped`, `AssignNetwork`, `GetByHostPort` | — |
| `packages/orchestrator/pkg/sandbox/cleanup.go` | `Cleanup` 工具(延迟执行的清理栈)| — |
| `packages/orchestrator/pkg/sandbox/reclaim.go` | `bestEffortReclaim`(pause 前释放空闲页)| — |
| `packages/orchestrator/pkg/sandbox/envd.go` | envd HTTP 客户端:`/init`、`callEnvdFreeze`、`callEnvdUnfreeze`、`callEnvdFsfreeze`、`callEnvdFsthaw`、`envdOp*` 常量 | `:283`, `:132`, `:139`, `:146`, `:153`, `:64-68` |
| `packages/orchestrator/pkg/sandbox/envd_process.go` | `StartEnvdShell`, `StartEnvdSystemShell` | — |
| `packages/orchestrator/pkg/sandbox/reboot.go` | `Factory.RebootSandbox`(filesystem-only resume)| `:39` |
| `packages/orchestrator/pkg/sandbox/uffd/` | uffd 处理器(resume 时按需 page-in)| — |
| `packages/orchestrator/pkg/sandbox/rootfs/` | `NewNBDProvider`, `NewDirectProvider` | — |
| `packages/orchestrator/pkg/sandbox/fc/process.go` | `ProcessOptions`, `Process`, `NewProcess`, `configure`, `Create`, `Resume`, `Pause`, `Stop`, `CreateSnapshot`, `DrainBalloon` | `:88`, `:135`, `:159`, `:227`, `:319`, `:513`, `:749`, `:677`, `:823`, `:762` |
| `packages/orchestrator/pkg/sandbox/fc/client.go` | `apiClient`, `loadSnapshot`, `resumeVM`, `pauseVM`, `createSnapshot`, `setMmds`, `flushMetrics`, `setMetrics`, `setBootSource`, `setRootfsDrive`, `setNetworkInterface`, `setMachineConfig`, `setEntropyDevice`, `startVM`, `installBalloon`, `memoryMapping`, `memoryInfo`, `dirtyMemory` | `:27`, `:42`, `:94`, `:114`, `:131`, `:151`, `:168`, `:185`, `:201`, `:215`, `:327`, `:361`, `:398`, `:420`, `:440`, `:499`, `:512`, `:529` |
| `packages/orchestrator/pkg/sandbox/fc/config.go` | `Config`, `HostKernelPath`, `FirecrackerPath`, `RootfsPaths`, `envsDisk`, `rootfsDriveID` | `:26`, `:35`, `:50`, `:66`, `:16`, `:19` |
| `packages/orchestrator/pkg/sandbox/fc/kernel_args.go` | `KernelArgs` | `:11` |
| `packages/orchestrator/pkg/sandbox/fc/script_builder.go` | `StartScriptBuilder` | — |
| `packages/orchestrator/pkg/sandbox/fc/mmds.go` | `MmdsMetadata` struct | — |
| `packages/orchestrator/pkg/sandbox/network/network.go` | `Slot.CreateNetwork`, `RemoveNetwork` | `:78`, `:352` |
| `packages/orchestrator/pkg/sandbox/network/slot.go` | `Slot`, `NewSlot`, `ConfigureInternet`, `UpdateInternet`, `DenyEgress`, `ResetInternet`, `GetVrtSlotsSize` | `:60`, `:88`, `:251`, `:287`, `:320`, `:351`, `:406` |
| `packages/orchestrator/pkg/sandbox/network/pool.go` | `Pool`, `NewPool`, `Get`, `returnSlot`, `ReturnAsync`, `Populate` | `:109`, `:130`, `:195`, `:239`, `:281`, `:160` |
| `packages/orchestrator/pkg/sandbox/network/firewall.go` | `Firewall`(nftables), `ApplyRules`, `DenyEgress` | `:27`, `:368`, `:408` |
| `packages/orchestrator/pkg/sandbox/network/host.go` | `getDefaultGateway` | `:35` |
| `packages/orchestrator/pkg/sandbox/nbd/dispatch.go` | NBD 服务端协议:`Provider`, `Request`, `Response`, `Dispatch`, `NewDispatch`, `Handle`, `cmdRead`, `cmdWrite`, `cmdWriteZeroes` | `:46`, `:85`, `:95`, `:101`, `:121`, `:174`, `:287`, `:374`, `:450` |
| `packages/orchestrator/pkg/sandbox/nbd/pool.go` | `DevicePool`, `NewDevicePool`, `getMaxDevices`, `GetDevice`, `ReleaseDevice`, `ConnectedDevices` | `:75`, `:86`, `:111`, `:300`, `:334`, `:130` |
| `packages/orchestrator/pkg/sandbox/nbd/path_direct.go` | `DirectPathMount`, `NewDirectPathMount`, `Open`, `Close`, `DisconnectDevice` | `:45`, `:76`, `:96`, `:243`, `:334` |
| `packages/orchestrator/pkg/sandbox/template/cache.go` | `Cache`, `NewCache`, `GetTemplate`, `AddSnapshot`, `UpdateMetadata`, `GetCachedTemplate`, `Invalidate` | `:51`, `:66`, `:159`, `:219`, `:274`, `:261`, `:143` |
| `packages/orchestrator/pkg/sandbox/template/template.go` | `Template` interface, `File` interface | `:16` |
| `packages/orchestrator/pkg/sandbox/template/storage.go` | `Storage` struct(包装 `block.Device`)| `:25` |
| `packages/orchestrator/orchestrator.proto` | gRPC `SandboxService`:Create/Update/List/Delete/Pause/Checkpoint/ListCachedBuilds | service `:209-218` |

### 16.3 Client-Proxy / DB

| 文件 | 关键符号 | 行号 |
|---|---|---|
| `packages/client-proxy/main.go` | `main`, `NewClientProxy` (调用点), `ListenAndServe` (调用点) | `:309`, `:161`, `:210` |
| `packages/client-proxy/internal/proxy/proxy.go` | `NewClientProxy`(reverse proxy), `catalogResolution`, `catalogSandboxNodeIP`, `handlePausedSandbox`, `orchestratorProxyPort=5007` | `:138`, `:76`, `:52`, `:97`, `:29` |
| `packages/shared/pkg/proxy/host.go` | `GetTargetFromRequest`(被 client-proxy 在 `proxy.go:139` 用局部变量 `getTargetFromRequest` 包裹调用)| `:16` |
| `packages/client-proxy/internal/proxy/paused_sandbox_resumer_grpc.go` | `PausedSandboxResumer` 实现 | — |
| `packages/db/queries/sandboxes/get_sandbox_record.sql` | `GetSandboxRecordByTeamAndSandboxID`(计费查询)| — |

---

## 十七、设计要点与权衡

### 17.1 为什么运行态在 Redis,不在 Postgres?

如果运行态写 Postgres:
- 每次状态变更(Running→Pausing→Killing)都要走 Postgres,延迟高
- EndTime 频繁 refresh(每个 SDK 调用都触发),Postgres 扛不住
- Postgres 是 OLTP,不适合做高频计数器

Redis 优势:
- 单线程原子操作,状态机安全
- ZSET 按 EndTime 排序,Evictor 用 `ExpiredItems` 高效范围扫描到期沙箱
- 沙箱元数据序列化小,内存占用可控

**注意**:沙箱到期**不是**靠 Redis key TTL 自动过期,而是 Evictor 每 50ms tick 主动扫描 `ExpiredItems`(`EndTime < now`),然后调 `RemoveSandbox`。这是主动驱逐,不是被动过期。

代价:重启时需要 `Reconcile` 与 orchestrator 对账(§13.5),Redis 故障会丢运行态(沙箱变成 orphan)。

### 17.2 为什么用 uffd 而不是预读?

uffd 让 FC 在第一次访问某 page 时才从 memfile 加载。合理推测的优点(代码注释未明确陈述动机):
- **首字节延迟低**:不用等几 GB 内存全加载完才启动
- **按需 IO**:冷门 page 永远不加载,节省带宽

代价:
- uffd 是 Linux 特性,需要 CONFIG_USERFAULTFD
- page-in 抖动:首批请求会触发缺页,延迟较高(prefetcher 缓解)
- 实现复杂(见 `pkg/sandbox/uffd/`)

### 17.3 为什么用 NBD 而不是把 rootfs 完整下载到本地?

类似 uffd 的思路,但是对**块设备**:
- rootfs 可能几 GB,完整下载延迟高
- NBD 按需读,首次启动只需读 boot sector
- 多个沙箱共享同一模板时,GCS 只读一次(orchestrator 本地缓存)

代价:
- 实现 NBD 协议复杂(`dispatch.go` 450 行)
- `/dev/nbdX` 设备数有限(由 `modprobe nbd nbds_max=N` 决定,推荐 4096,见 `pool.go:74` 注释;Linux 内核默认仅 16)
- 故障恢复复杂(NBD 服务端挂了,FC 会卡 IO)

### 17.4 为什么「pause」走 RemoveSandbox 路径?

API 层只有 `RemoveSandbox`,通过 `Action` 参数区分 kill/pause。原因:
- 二者**都从 Redis store 删除沙箱**(pause 在删除前先 upsert 到 `snapshots` 表,kill 在删除后异步写 `billing.sandbox_logs`)
- 大部分清理逻辑相同(routingCatalog.DeleteSandbox、Store.Remove)
- 只有节点上的 gRPC 调用不同(Delete vs Pause)

**注意**:pause 完成后沙箱**确实**从 Redis store 消失,但其元数据(snapfile/memfile/rootfs diff)**保留在 `snapshots` 表 + GCS**,直到 TTL 过期或显式删除。`GET /sandboxes/{id}` 在 store 未命中时回退查 snapshot 表,所以用户仍能看到 paused 状态。

代价:`RemoveSandbox` 这个名字容易误导,实际包含 pause 语义。

### 17.5 为什么 client-proxy 不直接连 FC?

如果 client-proxy 直接连 FC VM:
- 需要知道每个 VM 的 IP(暴露内部网络)
- 跨 orchestrator 时复杂(VM 可能迁移)
- FC VM 没有公网 IP,只有 host 上的 TAP

通过 orchestrator:5007 + iptables redirect:
- client-proxy 只需要知道 orchestrator IP(从 Redis 拿)
- iptables 规则保证流量进入正确的 sandbox NS
- TAP 设备在 host 上,与 orchestrator 进程解耦;**但 orchestrator 重启会触发 Reconcile**(§13.5),Redis 有但本地无的沙箱会被 `killOrphanSandbox` 杀掉,VM 不会原地保留

### 17.6 为什么 Evictor 在 API 层,不在 orchestrator?

orchestrator 只知道本节点沙箱,但 timeout 是**单沙箱维度**的(EndTime 字段在 Sandbox struct 上)。把驱逐放 API 层是因为:
- API 层有全局视角,能扫所有节点的到期沙箱
- 配合 `SandboxConcurrency`(team 维度)做并发限制
- 在 Pause 失败时降级到 Kill(`KillReasonTimeout`)
- 跨节点协调 AutoPause 决策(若原节点不可用可换节点)

代价:Evictor 每 50ms tick,要扫整个 Redis store。沙箱规模大时(目前没有已知分片方案),可能需要更聪明的事件驱动索引(EndTime 到期触发)。

### 17.7 为什么有 `connect` 端点?

`POST /sandboxes/{id}/connect` 是复合端点:
- 对 running 沙箱:刷新 EndTime(keep-alive)
- 对 paused 沙箱:回退到完整 resume 流程(`startSandbox(isResume=true)`)

SDK 用它做「探活 + 自动恢复」,减少调用方需要区分 paused/running 的负担。代价:语义复合,实现要 `maxConnectRetries=3` 应对连续状态切换(代码注释:"It could happen that after sandbox transition, it'll be again transitioning")。

---

## 十八、常见问题与排查

### Q1:沙箱关闭后,数据立刻消失吗?

不立刻。流程:
1. `RemoveSandbox` 把状态改 Killing(Redis 还在)
2. orchestrator stop FC、清理 cgroup/网络/NBD
3. `Close` 删除本地文件、释放 slot
4. `sandboxStore.Remove` 从 Redis 删除
5. 异步写 `billing.sandbox_logs`(Postgres)

如果 pause,数据(snapfile + memfile + rootfs diff)保留在 GCS,`snapshots` 表保留元数据,直到 TTL 过期或显式删除。

### Q2:为什么我的沙箱状态卡在 Pausing?

可能原因:
- orchestrator 节点压力大,`process.CreateSnapshot` 慢
- 上传 GCS 失败,`uploadSnapshotAsync` 一直在重试(最长 2h)
- `bestEffortReclaim` 在 guest 内 fstrim 卡住

排查:`GetSandboxesSandboxID` 返回 200 + paused 表示 DB snapshot 已写;但若路由表已删除,client-proxy 会触发 auto-resume 立刻拉回。

### Q3:为什么 `DELETE` 后立即 `GET` 还能看到沙箱?

`sandbox_get.go` 在 store 未命中时回退查 `snapshots` 表(`:179-251`)。即使 kill 完成后,snapshot 行可能还在(异步清理)。此时 `GET` 返回 paused 状态。

### Q4:resume 失败,如何排查?

resume 是最复杂的路径。常见失败点:
- **`snapshotCache.GetLast` 找不到快照**:可能 snapshot 还没上传 GCS 完成,等几秒重试
- **`maybeRemapResumeOriginNode`**:原节点不可用,重映射到其他节点,但其他节点没有 memfile 缓存,需要先从 GCS 下载(慢)
- **`WaitForEnvd` 超时**:envd 启动失败,可能 memfile 损坏或 kernel/fc 版本不匹配

排查:看 orchestrator 日志搜 sandboxID,关注 `uffd`、`LoadSnapshot`、`WaitForEnvd` 阶段。

### Q5:`AutoPause=true` 和 `false` 的区别?

`AutoPause=true`:EndTime 到期时,evictor 调 `RemoveSandbox(Action: Pause)`,沙箱数据保存。
`AutoPause=false`(默认):EndTime 到期时,直接 `Action: Kill`,沙箱数据删除。

通常按 tier 配置:免费/低价 tier 不开启(省存储成本),付费 tier 开启。

### Q6:`/connect` 端点为什么有时很慢?

`maxConnectRetries = 3`,每次重试间 `WaitForStateChange`。如果沙箱正在 Pausing→运行中切换,会重试到成功或超时。极端情况下,首次 `/connect` 可能触发完整 resume 流程(uffd + LoadSnapshot),耗时几秒到几十秒。

### Q7:为什么有些沙箱在 `billing.sandbox_logs` 表里有,但运行时找不到?

`billing.sandbox_logs` 是**终态写入**(kill/pause 完成后才写)。运行中沙箱在这里**没有记录**,只在 Redis。如果沙箱还在运行,直接查 Postgres 找不到。

### Q8:网络隔离如何工作?

每个沙箱有独立的 network namespace,包含:
- vpeer(veth 对的 sandbox 端)
- TAP 设备(FC VM 接入)
- lo
- 默认路由经 veth → host

host 上的 iptables MASQUERADE + nftables Firewall 控制出入站。`DenyEgress`(resume throwaway)可以临时禁出站,确认沙箱正常后再放行。

### Q9:为什么 Evictor 间隔 50ms 而不是 1s?

50ms 让 timeout 控制更精确(沙箱到期后最多 50ms 内被驱逐)。但扫描成本高,所以用 `MaxConcurrentEvictions`(LD flag)限并发。规模大时可能改成更聪明的事件驱动(EndTime 到期触发)。

### Q10:`Sandbox` struct 和 `RunningSandbox` proto 消息什么关系?

`Sandbox` struct(`packages/api/internal/sandbox/sandboxtypes/sandbox.go:79`)是 API 层内部的完整对象,包含所有字段(State、NodeID、模板版本、网络配置等)。

`RunningSandbox`(`orchestrator.proto:188`)是 gRPC `List` 响应里的简化版,只有 `config + client_id + start_time + end_time`。

`Sandbox.ToAPISandbox`(`sandbox.go:117`)负责把内部 struct 转成 OpenAPI 暴露给用户的 `api.Sandbox`。

---

## 附录 A:状态机详图

### A.1 完整状态机

```
              sandboxStore.Reserve (Redis 写元数据,无 State)
                                  │
                                  │ CreateSandbox 成功 + sandboxStore.Add
                                  ▼
                       ┌──────────────────────┐
                       │                      │
                       │     Running          │
        ┌──────────────┤                      ├──────────────┐
        │              └──────────┬───────────┘              │
        │                         │                          │
        │ StateActionPause        │ StateActionKill          │ StateActionSnapshot
        │ (POST .../pause         │ (DELETE                  │ (内部 checkpoint,
        │  or AutoPause)          │  or Timeout              │  不暴露 HTTP)
        │                         │  or Admin)               │
        ▼                         ▼                          ▼
  ┌──────────┐              ┌──────────┐               ┌──────────────┐
  │ Pausing  │              │ Killing  │               │ Snapshotting │
  └────┬─────┘              └────┬─────┘               └──────┬───────┘
       │                         │                            │
       │ 完成后从                 │ 完成后从                   │ 完成后回 Running
       │ store 删除               │ store 删除                 │(ActionEffect=
       │ + snapshots 表           │ + billing.sandbox_logs     │ TransitionTransient)
       │ 新增一行                 │ 新增一行
       │ (status=ready)           │
       ▼                         ▼
   [Paused]                  [Killed]
       │
       │ POST .../resume 或 connect
       │ (走 CreateSandbox with Snapshot=true)
       │
       └──► 重新进入 Reserve → Running 路径
```

### A.2 KillReason 触发矩阵

| KillReason | 来源 |
|---|---|
| `Request` | `DELETE /sandboxes/{id}`(`sandbox_kill.go:39`)|
| `Timeout` | `evict.go:161`(AutoPause=false 时)|
| `Admin` | `POST /admin/teams/{tid}/sandboxes/kill`(见 admin-module.md)|
| `Orphaned` | `killOrphanSandbox`(`delete_instance.go:201`)|
| `BaseTemplateMissing` | 模板删除触发的清理 |
| `Unknown` | 默认值,生产不应出现 |

### A.3 `AllowedTransitions`(`states.go:83-87`)

只允许以下迁移(`State` 枚举只有 4 个,无 Reserved):

| from | to |
|---|---|
| Running | Pausing, Killing, Snapshotting |
| Pausing | (从 store 删除,不再迁移)|
| Killing | (从 store 删除)|
| Snapshotting | Running |

非法迁移会被 `sandboxStore.StartRemoving` 拒绝,返回 `ErrInvalidStateTransition`。

---

## 附录 B:gRPC `SandboxService` 协议

`packages/orchestrator/orchestrator.proto:209-218`:

```protobuf
service SandboxService {
  rpc Create(SandboxCreateRequest)     returns (SandboxCreateResponse);
  rpc Update(SandboxUpdateRequest)     returns (google.protobuf.Empty);
  rpc List(google.protobuf.Empty)      returns (SandboxListResponse);
  rpc Delete(SandboxDeleteRequest)     returns (google.protobuf.Empty);
  rpc Pause(SandboxPauseRequest)       returns (SandboxPauseResponse);
  rpc Checkpoint(SandboxCheckpointRequest) returns (SandboxCheckpointResponse);
  rpc ListCachedBuilds(google.protobuf.Empty) returns (SandboxListCachedBuildsResponse);
}
```

### B.1 关键 message

```protobuf
message SandboxConfig {
  string template_id           = 1;
  string build_id              = 2;
  string kernel_version        = 3;
  string firecracker_version   = 4;
  bool   huge_pages            = 5;
  string sandbox_id            = 6;
  map<string,string> env_vars  = 7;
  map<string,string> metadata  = 8;
  optional string alias        = 9;
  string envd_version          = 10;
  int64  vcpu                  = 11;
  int64  ram_mb                = 12;
  string team_id               = 13;
  int64  max_sandbox_length    = 14;
  int64  total_disk_size_mb    = 15;
  bool   snapshot              = 16;  // = isResume
  string base_template_id      = 17;
  bool   auto_pause            = 18;
  optional string envd_access_token = 19;
  string execution_id          = 20;
  optional bool allow_internet_access = 21;
  optional SandboxNetworkConfig network = 22;
  repeated SandboxVolumeMount volumeMounts = 23;
  optional SandboxAutoResumeConfig auto_resume = 24;  // 嵌套 message,不是 bool
  bool   auto_pause_filesystem_only = 25;
  int64  events_ttl_days       = 26;
}

message SandboxAutoResumeConfig {
  string policy = 1;
  uint64 timeout_seconds = 2;
}

message SandboxCreateRequest {
  SandboxConfig sandbox = 1;
  google.protobuf.Timestamp start_time = 2;
  google.protobuf.Timestamp end_time = 3;
}

message SandboxCreateResponse {
  string client_id                = 1;
  SchedulingMetadata scheduling_metadata = 2;
}

message SchedulingMetadata {
  string memfile_base_build_id = 1;
  string build_id = 2;
  repeated string memfile_build_ids = 3;
  repeated string rootfs_build_ids = 4;
  uint32 memfile_dropped_builds = 5;
  uint32 rootfs_dropped_builds = 6;
  repeated uint64 memfile_build_bytes = 7;
  repeated uint64 rootfs_build_bytes = 8;
  string rootfs_base_build_id = 9;
}

message SandboxUpdateRequest {
  string sandbox_id = 1;
  optional google.protobuf.Timestamp end_time = 2;
  optional SandboxNetworkEgressConfig egress = 3;
}

message SandboxDeleteRequest {
  string sandbox_id     = 1;
  optional string kill_reason = 2;
}

message SandboxPauseRequest {
  string sandbox_id   = 1;
  string template_id  = 2;
  string build_id     = 3;
  bool   filesystem_only = 4;
}

message SandboxPauseResponse {
  SchedulingMetadata scheduling_metadata = 1;
}
```

### B.2 调用映射

| HTTP 端点 | gRPC 调用 |
|---|---|
| `POST /sandboxes` | `Sandbox.Create`(snapshot=false)|
| `POST /sandboxes/{id}/resume` | `Sandbox.Create`(snapshot=true)|
| `POST /sandboxes/{id}/pause` | `Sandbox.Pause`|
| `DELETE /sandboxes/{id}` | `Sandbox.Delete(kill_reason=Request)`|
| `POST /sandboxes/{id}/refreshes` | `Sandbox.Update(end_time)`|
| `POST /sandboxes/{id}/timeout` | `Sandbox.Update(end_time)`|
| (内部)| `Sandbox.Checkpoint`(transient snapshot)|
| (内部)| `Sandbox.List`(节点同步)|

---

## 附录 C:术语表

| 术语 | 含义 |
|---|---|
| **sandbox** | 一个运行中的 Firecracker microVM 实例 |
| **sandboxID** | 形如 `"i-" + uuid` 的实例 ID |
| **executionID** | 用户自定义的执行标识,用于区分同模板的不同运行 |
| **Reserved** | store 中已占位但还没真正启动的状态 |
| **Running / Pausing / Killing / Snapshotting** | 4 个运行态状态 |
| **Paused** | 隐式状态,由 `snapshots` 表中的行表达 |
| **Killed** | 隐式状态,由 `billing.sandbox_logs` 表达 |
| **StateAction** | 触发状态迁移的动作类型(Pause/Kill/Snapshot)|
| **KillReason** | kill 的原因(Request/Timeout/Admin/Orphaned/BaseTemplateMissing/Unknown)|
| **AutoPause** | tier 配置,EndTime 到期时是 pause(true)还是 kill(false)|
| **Sandbox Store** | API 层的运行态注册表(Redis 后端)|
| **Sandbox Factory** | orchestrator 层的 VM 创建/管理器 |
| **Slot** | 网络配置单元(命名空间 + veth + TAP + iptables 规则)|
| **DevicePool** | `/dev/nbdX` 设备池(默认 128 个)|
| **block.Device** | 抽象的块设备接口,template rootfs 实现它 |
| **memfile** | pause 时保存的 FC 内存状态(用于 resume)|
| **snapfile** | pause 时保存的 FC VM 状态(CPU 寄存器等)|
| **rootfs diff** | pause 时相对 base rootfs 的差异(增量)|
| **uffd** | userfaultfd,Linux 特性,resume 时按需 page-in 内存 |
| **MMDS** | Firecracker mock metadata service,cold boot 时传 envd 鉴权信息 |
| **envd** | VM 内 daemon,负责进程管理、文件系统、健康检查 |
| **Client-Proxy** | 数据面边缘代理,根据 host header 路由到 orchestrator:5007 |
| **Routing Catalog** | Redis 中的 `<sandboxID → OrchestratorIP>` 路由表 |
| **Auto-Resume** | client-proxy 发现 sandbox paused 时自动触发 resume |
| **Evictor** | API 层的超时驱逐 goroutine,50ms tick |
| **Orphan** | orchestrator 重启后 Redis 有但本地无的沙箱 |
| **Reconcile** | orchestrator 重启时对照 Redis 与本地 sandbox map 的过程 |
| **Placement** | API 层的调度算法,从候选节点选一个启动沙箱 |
| **best-of-K** | placement 默认算法:随机抽 K 个候选,挑资源最少的 |
| **SchedulingMetadata** | gRPC 响应字段,告诉 API 层这次启动用了哪些 build(rootfs/memfile)|
| **KeepAliveFor** | API 层方法,延长 EndTime(refresh/set-timeout 共用)|
| **`orchestratorProxyPort`** | `5007`,client-proxy → orchestrator 的固定端口 |
| **NBD** | Network Block Device,把远程 rootfs 暴露为 `/dev/nbdX` |
| **Throwaway Resume** | resume 时先 `DenyEgress`,确认正常后再放行 |
