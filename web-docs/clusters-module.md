# Clusters 模块

> 范围:E2B 控制平面(CP API)如何抽象"一个部署区域"、如何把 team 路由到对应的 cluster、如何在 cluster 内部发现 orchestrator/builder 实例并维护它们的健康状态。涉及 `packages/api/internal/clusters/`、`packages/shared/pkg/clusters/`、`packages/db/queries/get_active_clusters.sql` 与若干 migrations。
>
> 本文聚焦「多集群拓扑 + 节点发现 + 资源访问」的抽象。每个 cluster 内部的沙箱调度、模板缓存在 `orchestrator-module.md`(待写)与 `template-cache-module.md`(待写)中讨论。

## 目录

- [一、概述](#一概述)
- [二、数据模型与 schema 演进](#二数据模型与-schema-演进)
- [三、`Cluster` 与 `Pool` 的内存抽象](#三cluster-与-pool-的内存抽象)
- [四、Pool 同步循环](#四pool-同步循环)
- [五、Local Cluster vs Remote Cluster](#五local-cluster-vs-remote-cluster)
- [六、`Instance`:每个节点的小代理](#六instance每个节点的小代理)
- [七、Service Discovery 抽象](#七service-discovery-抽象)
- [八、`ClusterResource`:metrics 与 logs 的本地/远端策略](#八clusterresourcemetrics-与-logs-的本地远端策略)
- [九、gRPC 客户端装配](#九grpc-客户端装配)
- [十、多集群路由:`clusterID` 的解析与回退](#十多集群路由clusterid-的解析与回退)
- [十一、Edge API:远端 cluster 的统一入口](#十一edge-api远端-cluster-的统一入口)
- [十二、关键时序图](#十二关键时序图)
- [十三、配置](#十三配置)
- [十四、关键代码文件索引](#十四关键代码文件索引)
- [十五、设计要点与权衡](#十五设计要点与权衡)
- [十六、常见问题与排查](#十六常见问题与排查)
- [附录 A:`Cluster` / `Instance` 状态机](#附录-acluster--instance-状态机)
- [附录 B:DB schema 演进](#附录-bdb-schema-演进)
- [附录 C:术语表](#附录-c术语表)

---

## 一、概述

E2B 的 CP API 不仅服务单一部署,还能管理**多个独立部署的 cluster**(每个 cluster 是一组 orchestrator/builder 实例)。每个 team 通过 `teams.cluster_id` 绑定到一个 cluster(可为空,空则使用本地 cluster)。

```
                        ┌──────────────────────────────────────┐
                        │           Control Plane API          │
                        │  (packages/api)                      │
                        │                                      │
                        │  ┌────────────────────────────┐     │
   SDK / CLI  ─────────►│  │       clusters.Pool        │     │
                        │  │  ┌──────────┐  ┌────────┐  │     │
                        │  │  │ Local    │  │ Remote │  │     │
                        │  │  │ Cluster  │  │ Cluster│ ...   │
                        │  │  │ (uuid.Nil)│  │        │  │     │
                        │  │  └────┬─────┘  └───┬────┘  │     │
                        │  └───────┼────────────┼───────┘     │
                        │          │            │              │
                        └──────────┼────────────┼──────────────┘
                                   │            │
                       Nomad/Consul│            │ HTTPS Edge API
                                   ▼            ▼
                              ┌────────┐   ┌────────────────┐
                              │Local   │   │ Remote cluster │
                              │orch    │   │  (edge-backend │
                              │+builder│   │   + orchestr.) │
                              └────────┘   └────────────────┘
```

**两个核心抽象**:

| 抽象 | 文件 | 说明 |
|---|---|---|
| `Pool` | `clusters_sync.go:29-35` | 所有 cluster 的注册表,定期从 DB 同步 |
| `Cluster` | `cluster.go:39-47` | 单个 cluster,管理其 `Instance` 集合 + 资源访问器 |

**两种 cluster 类型**:
- **Local Cluster**(`cluster.go:72-103`):ID 为 `uuid.Nil`(`consts.LocalClusterID`),通过 Nomad/Consul 发现节点,直连节点 IP;这是 E2B 自托管/单一部署的默认形态
- **Remote Cluster**(`cluster.go:105-165`):ID 为真实 UUID,通过 HTTPS Edge API 与远端通信;用于 multi-region / multi-tenant 部署

### 与其他文档的边界

| 主题 | 文档 |
|---|---|
| API key / JWT 验证 | `auth-module.md` |
| 沙箱生命周期与状态机 | `sandbox-api-module.md` |
| 模板缓存与别名解析 | `template-cache-module.md`(待写) |
| **Cluster 拓扑、节点发现、资源访问** | **本文** |

---

## 二、数据模型与 schema 演进

clusters 表从 2025-06 起逐步扩展。完整迁移时间线见 [附录 B](#附录-bdb-schema-演进)。当前 schema 等价于:

```sql
CREATE TABLE clusters (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 TEXT NOT NULL,            -- 2026-06-09: 可读名
    endpoint             TEXT NOT NULL,            -- 远端 edge API host
    endpoint_tls         BOOLEAN NOT NULL DEFAULT TRUE,
    token                TEXT NOT NULL,            -- 共享密钥(Edge API auth)
    auth_org_id          TEXT,                     -- 2026-04-23: client-proxy OAuth org 校验值(详见 Q10)
    sandbox_proxy_domain TEXT                      -- 2025-07-14: 沙箱数据面域名
);

ALTER TABLE teams
    ADD COLUMN cluster_id UUID NULL REFERENCES clusters(id);

ALTER TABLE envs  -- 即 templates
    ADD COLUMN cluster_id UUID NULL REFERENCES clusters(id);
```

**关键字段含义**:

- `teams.cluster_id`:把 team 绑定到 cluster。**NULL 表示使用 local cluster**(`WithClusterFallback` 把 NULL 转成 `consts.LocalClusterID`)
- `envs.cluster_id`:模板的"出生 cluster"——一旦在某个 cluster 上 build,就绑定在那里。模板查找必须跨 cluster 路由
- `auth_org_id`:远端 cluster 关联的 OAuth 组织 ID,用于 client-proxy 鉴权(详见 Q10)
- `sandbox_proxy_domain`:数据面访问沙箱时用的域名(如 `sandbox.us-east.example.com`),由 client-proxy 用于路由

### `GetActiveClusters` 查询

`packages/db/queries/get_active_clusters.sql` 只返回**至少有一个 team 引用**的 cluster:

```sql
-- name: GetActiveClusters :many
SELECT DISTINCT sqlc.embed(c)
FROM public.clusters c
JOIN public.teams t ON t.cluster_id = c.id;
```

`JOIN` 是关键:**孤儿 cluster(没有任何 team 引用)不会被加载到内存**——这是为了控制内存占用,并避免误用未配置的 cluster。

---

## 三、`Cluster` 与 `Pool` 的内存抽象

### 3.1 `Pool` 结构

```go
// clusters_sync.go:29-35
type Pool struct {
	db  *client.Client
	tel *telemetry.Client

	clusters        *smap.Map[*Cluster]                                         // 内存中的 cluster 注册表
	synchronization *synchronization.Synchronize[queries.Cluster, *Cluster]    // 同步驱动器
}
```

`Pool` 暴露的方法非常少(`clusters_sync.go:84-106`):

| 方法 | 用途 |
|---|---|
| `GetClusterById(id uuid.UUID) (*Cluster, bool)` | 按 ID 取 cluster(常用) |
| `GetClusters() map[string]*Cluster` | 全量返回(主要用于调试/指标) |
| `Close(ctx)` | 优雅关闭:停 sync 循环 + 关闭每个 cluster 的连接 |

### 3.2 `Cluster` 结构

```go
// cluster.go:39-47
type Cluster struct {
	ID            uuid.UUID
	SandboxDomain *string
	AuthOrgID     string

	instances       *smap.Map[*Instance]
	synchronization *synchronization.Synchronize[discovery.Item, *Instance]
	resources       ClusterResource
}
```

每个 cluster 持有:
- 自己的 `instances` map(key 是 NodeID)
- 自己的 sync 循环(独立于 Pool 的循环)
- 自己的 `ClusterResource` 实现(本地走 ClickHouse/Loki,远端走 Edge API)

### 3.3 `localClusterConfig()`

```go
// clusters_sync.go:37-43
func localClusterConfig() *queries.Cluster {
	return &queries.Cluster{
		ID:                 consts.LocalClusterID,
		EndpointTls:        false,
		SandboxProxyDomain: nil,
	}
}
```

无论 DB 里有没有 local cluster 行,Pool 都会**无条件**注入一个 local cluster 配置——这就是为什么 `teams.cluster_id = NULL` 的 team 永远有 cluster 可用。

---

## 四、Pool 同步循环

`Pool` 用 `synchronization.Synchronize` 框架周期性地与 DB 对账。常量在 `clusters_sync.go:24-27`:

```go
const (
	clustersSyncInterval = 15 * time.Second  // 对账间隔
	clusterSyncTimeout   = 5 * time.Second   // 单次对账超时
)
```

启动入口(`clusters_sync.go:79`):

```go
go p.synchronization.Start(ctx, clustersSyncInterval, clusterSyncTimeout, true)
```

最后一个参数 `true` 是 `syncOnStart`——构造时立刻跑一次,避免第一次请求时还没有 cluster。

### 4.1 同步行为

`clustersSyncStore`(`clusters_sync.go:109-118`)实现了 7 个回调:

| 回调 | 行为 |
|---|---|
| `SourceList` | `db.GetActiveClusters` + 拼上 local cluster |
| `SourceExists` | DB 里是否还有这个 cluster |
| `PoolList` | 当前内存里的所有 cluster |
| `PoolExists` | 内存里是否有这个 cluster |
| `PoolInsert` | 装配 local 或 remote cluster,加入 map |
| `PoolUpdate` | **空实现**(`clusters_sync.go:207-209`)——目前不做热更新 |
| `PoolRemove` | 关闭 cluster 的所有连接,从 map 移除 |

### 4.2 `PoolInsert` 的关键分支

```go
// clusters_sync.go:164-205 (简化)
if cluster.ID == consts.LocalClusterID {
    c = newLocalCluster(...)        // Nomad/Consul discovery + 本地资源
} else {
    c, err = newRemoteCluster(...)  // Edge API discovery + 远端资源
}
d.clusters.Insert(clusterID, c)
```

注意 `PoolInsert` **不返回错误**——装配失败只 log,不阻塞同步循环。这是为了防止一个 cluster 装配失败导致整个 sync 停摆。

### 4.3 `PoolUpdate` 为什么是空的?

DB 里 cluster 的字段变了(比如 `endpoint` 改了),目前**不会**触发内存中的 cluster 重新装配。需要重启 API 才能生效。这是有意识的妥协——避免在运行时关闭并重建大量 gRPC 连接的复杂性。如果未来需要热更新,这里要补上。

---

## 五、Local Cluster vs Remote Cluster

两种 cluster 共享 `Cluster` 结构,但在**实例发现**和**资源访问**上完全不同。

| 维度 | Local (`cluster.go:72-103`) | Remote (`cluster.go:105-165`) |
|---|---|---|
| Cluster ID | `consts.LocalClusterID` (`uuid.Nil`) | DB 分配的真实 UUID |
| Discovery 源 | `LocalServiceDiscovery`(Nomad alloc 或 static) | `RemoteServiceDiscovery`(Edge API `/v1/service-discovery`) |
| gRPC 目标 | 直连节点 IP + `LocalInstanceApiPort` | 统一 endpoint(edge-backend 转发) |
| TLS | 通常关闭(`EndpointTls = false`) | 通常开启(`EndpointTls = true`) |
| 鉴权 | 无 | `EdgeRpcAuthHeader` + service instance ID 路由 |
| Resource 实现 | `LocalClusterResourceProvider`(ClickHouse + Loki 直连) | `ClusterResourceProviderImpl`(转发给 Edge API) |
| 沙箱数据面 | 同 VPC 内部 | 走 `cluster.SandboxDomain` |

### 5.1 为什么 Local 也要走同一套抽象?

代码注释明确指出(local cluster 的 instanceCreation):

> // For local cluster we are doing direct connection to instance IP and API port and without additional cluster access auth.

把 local 也作为 `Cluster` 的一个特例,让上层 handler 无需区分——`a.clusters.GetClusterById(...)` 永远返回一个能用的 `*Cluster`,无论底下是本地 Nomad 还是远端 cluster。

### 5.2 `newLocalCluster` 装配

```go
// cluster.go:72-103 (简化)
c := NewCluster(
    consts.LocalClusterID,
    nil,   // no sandbox domain
    "",    // no auth org
    instances,
    synchronization.NewSynchronize("cluster-instances", "Cluster instances", store),
    newLocalClusterResourceProvider(clickhouse, queryLogsProvider, instances, config),
)
go c.synchronization.Start(ctx, instancesSyncInterval, instancesSyncTimeout, true)
```

### 5.3 `newRemoteCluster` 装配

```go
// cluster.go:122-136 (简化)
httpClient, err := api.NewClientWithResponses(
    endpointBaseUrl,
    func(c *api.Client) error {
        c.RequestEditors = append(c.RequestEditors, func(_ context.Context, req *http.Request) error {
            req.Header.Set(consts.EdgeApiAuthHeader, secret)  // 共享密钥
            return nil
        })
        return nil
    },
)
```

每个 HTTP 请求都注入 `EdgeApiAuthHeader`——这就是远端 cluster 鉴权。

---

## 六、`Instance`:每个节点的小代理

`Instance`(`instance.go:30-55`)代表 cluster 内的一个 orchestrator/builder 进程。它持有:

- 标识:`uniqueIdentifier`、`NodeID`、`ClusterID`、`LocalIPAddress`、`serviceInstanceID`
- 元数据(从 gRPC `Info.ServiceInfo` 拉取):`status`、`roles`、`machine`、`serviceVersion`
- 一个 gRPC `client`(直连节点或经过 edge 代理)
- `syncFailCount`:连续失败计数,用于健康降级

### 6.1 角色(`roles`)

每个 Instance 可以同时具有多个角色(`instance.go:171-172`):

```go
i.isBuilder = slices.Contains(i.roles, infogrpc.ServiceInfoRole_TemplateBuilder)
i.isOrchestrator = slices.Contains(i.roles, infogrpc.ServiceInfoRole_Orchestrator)
```

一个节点可以**同时**是 builder 和 orchestrator(典型 local 部署),也可以**只**是 orchestrator(remote 部署常见)。

### 6.2 状态与降级

`maxSyncFailuresBeforeUnhealthy = 3`(`instance.go:25`)。如果连续 3 次 `Sync` 失败,实例被标记为 `Unhealthy`(`instance.go:133-146`)。

```go
i.syncFailCount++
if i.syncFailCount >= maxSyncFailuresBeforeUnhealthy {
    if i.status != infogrpc.ServiceInfoStatus_Unhealthy {
        i.status = infogrpc.ServiceInfoStatus_Unhealthy
        i.statusChangedAt = time.Now()
    }
}
```

**注意**:即便标记为 Unhealthy,实例**不会**被立即移除——它仍在 `instances` map 里。下次 `instancesSyncStore.PoolUpdate` 会再尝试 sync,如果成功,`syncFailCount` 重置为 0(`instance.go:155`),状态恢复。这是为了让临时网络抖动不会立即剔除节点。

### 6.3 选择 instance

`Cluster` 提供 3 个选择器(`cluster.go:191-279`):

| 方法 | 用途 |
|---|---|
| `GetTemplateBuilderByNodeID(nodeID)` | 精确取指定节点(用于 build logs) |
| `GetAvailableTemplateBuilder(expectedMachine)` | 随机选一个 healthy + CPU 匹配的 builder |
| `GetOrchestrators()` / `GetTemplateBuilders()` | 全量过滤 |

`GetAvailableTemplateBuilder` 用 `rand.Shuffle`(`cluster.go:222`)打散顺序,避免所有 build 都堆在第一个节点。

```go
// cluster.go:233-257 (简化)
instance, ok := c.getRandomInstance(func(info InstanceInfo, machineInfo machineinfo.MachineInfo) bool {
    if info.Status != infogrpc.ServiceInfoStatus_Healthy || !info.IsBuilder {
        return false
    }
    // Require an exact CPU match for the template builder
    if expectedInfo.CPUArchitecture != "" && !expectedInfo.IsExactMatch(machineInfo) {
        return false
    }
    return true
})
```

注意"exact CPU match"——**不跨架构兼容**。AMD64 的模板不会跑到 ARM64 的 builder 上。

### 6.4 `SyncInstances(ctx)` 的"懒同步"出口

```go
// cluster.go:285-290
func (c *Cluster) SyncInstances(ctx context.Context) error {
	return c.synchronization.Sync(ctx)
}
```

handler 在节点查找失败时可以调它,**立即**触发一次 discovery——用于处理"刚加入集群但还没被周期 sync 看到"的 orchestrator。

---

## 七、Service Discovery 抽象

`Discovery` 接口(`discovery/discovery.go:25-27`):

```go
type Discovery interface {
	Query(ctx context.Context) ([]Item, error)
}
```

返回的 `Item`(`discovery.go:11-23`):

```go
type Item struct {
	UniqueIdentifier     string  // 去重 key(alloc ID / service instance ID)
	NodeID               string  // 逻辑节点 ID
	InstanceID           string  // 每次重启变化(只有 remote 有)
	LocalIPAddress       string  // 节点 IP
	LocalInstanceApiPort uint16  // gRPC 端口
}
```

### 7.1 四个实现

| 实现 | 文件 | 用途 |
|---|---|---|
| `LocalServiceDiscovery` | `discovery/local.go:20-81` | Local cluster(Nomad 部署):Nomad alloc 或 static(local env) |
| `KubernetesServiceDiscovery` | `discovery/kubernetes.go:22-94` | Local cluster(K8s 部署):列举 template-manager pods |
| `RemoteServiceDiscovery` | `discovery/remote.go:32-73` | Remote cluster:Edge API `/v1/service-discovery` |
| `StaticServiceDiscovery` | `discovery/static.go:8-27` | 测试用 |

`KubernetesServiceDiscovery`(`kubernetes.go:29-38`)是 `LocalServiceDiscovery` 的 K8s 对应版本——用于在 K8s 上部署 E2B 时发现 template-manager pods。它通过 `pods.List(labelSelector)` 列举 pods,只返回 `podReady` 的(`kubernetes.go:83-94`)。注意它使用 `status.HostIP`(因为 template-manager 在 K8s 上以 `host_network=true` 运行,`kubernetes.go:21`),fallback 到 `status.PodIP`。

### 7.2 Local 实现细节

`discovery/local.go:32-81` 有两条路径:

```go
if env.IsLocal() {
    // static:返回单个 localhost 条目(用于本地开发)
    return []Item{{
        UniqueIdentifier: "local",
        NodeID: "local",
        LocalIPAddress: testsInstanceHost,
        LocalInstanceApiPort: consts.OrchestratorAPIPort,
    }}, nil
}

// 生产 local:从 Nomad 拉 alloc
alloc, err := discovery.ListOrchestratorAndTemplateBuilderAllocations(ctx, sd.nomad, discovery.FilterTemplateBuilders)
```

注意 `testsInstanceHost = env.GetEnv("TESTS_ORCH_INSTANCE_HOST", "localhost")`(`local.go:18`)——本地开发默认连 localhost。

**只查 template builders**:`FilterTemplateBuilders` 标志 + `local.go:55-56` 的注释说明:local orchestrators **不**通过这条 discovery 路径——它们仍走旧的 Nomad discovery(在 node manager flow 内部)。这是历史遗留,为了最小化改动而保留。

### 7.3 Remote 实现细节

`discovery/remote.go:44-73`:

```go
res, err := sd.client.V1ServiceDiscoveryWithResponse(ctx)
// ...
nodes := res.JSON200.Orchestrators
for i, n := range nodes {
    result[i] = Item{
        UniqueIdentifier: n.ServiceInstanceID,
        NodeID:           n.NodeID,
        InstanceID:       n.ServiceInstanceID,
        LocalIPAddress:   ipAddressFromServiceHost(n.ServiceHost),
    }
}
```

`ipAddressFromServiceHost`(`remote.go:18-30`)处理 `host:port` 格式,只保留 host(用于数据面路由;控制面走统一 endpoint)。

### 7.4 同步去重

`instancesSyncStore.SourceExists`(`instances_sync.go:33-42`)用 `UniqueIdentifier` 去重——同一个 alloc/service instance 不会被加两次。

`PoolExists`(`instances_sync.go:53-57`)用 `NodeID` 作为内存 key:

```go
func (d instancesSyncStore) PoolExists(_ context.Context, s discovery.Item) bool {
	_, found := d.instances.Get(s.NodeID)
	return found
}
```

如果 `NodeID` 相同但 `UniqueIdentifier` 变了(比如 alloc 重建),会被认为是"已存在"——这是有意识的设计,避免节点反复 add/remove。但**Instance 内部状态会通过 `Sync` 更新**。

---

## 八、`ClusterResource`:metrics 与 logs 的本地/远端策略

`ClusterResource`(`resources.go:20-25`)抽象了 4 个数据访问方法:

```go
type ClusterResource interface {
	GetSandboxMetrics(ctx, teamID, sandboxID, qStart, qEnd) ([]api.SandboxMetric, *api.APIError)
	GetSandboxesMetrics(ctx, teamID, sandboxIDs) (map[string]api.SandboxMetric, *api.APIError)
	GetSandboxLogs(ctx, teamID, sandboxID, start, end, limit, direction, level, search) (api.SandboxLogs, *api.APIError)
	GetBuildLogs(ctx, nodeID, templateID, buildID, offset, limit, level, cursor, direction, source) ([]logs.LogEntry, *api.APIError)
}
```

### 8.1 两个实现

| 实现 | 文件 | 数据源 |
|---|---|---|
| `LocalClusterResourceProvider` | `resources_local.go:20-25` | ClickHouse(metrics)+ Loki(logs),本地直连 |
| `ClusterResourceProviderImpl` | `resources_remote.go:20-24` | Edge API(透传给远端 cluster) |

handler 通过 `cluster.GetResources()`(`cluster.go:281-283`)拿到对应的实现——**完全不关心是 local 还是 remote**。

### 8.2 Build Logs 的"双源"策略

Build logs 是个特殊情况:既可能从**临时的 builder 实例**拉(gRPC `TemplateBuildStatus`),也可能从**持久化的日志后端**拉(local: Loki;remote: Edge API)。

`getBuildLogsWithSources`(`resources.go:183-238`)是共享逻辑,按 `source` 参数选择:

```go
// resources.go:202-223 (简化)
var sources []logSourceFunc

if nodeID != nil && logCheckSourceType(source, api.LogsSourceTemporary) {
    instance, found := instances.Get(*nodeID)
    if found {
        sources = append(sources, logsFromBuilderInstance(...))
    }
}

if logCheckSourceType(source, api.LogsSourcePersistent) {
    sources = append(sources, persistentLogFetcher)  // 由 local/remote 各自提供
}

for _, sourceFetch := range sources {
    entries, err := sourceFetch()
    if err != nil { continue }
    return entries, nil
}
```

**返回第一个成功的结果**——临时源失败时自动回退到持久化源。

### 8.3 日志保留窗口

`logsOldestLimit = 7 * 24 * time.Hour`(`resources.go:28`)= 7 天。`LogQueryWindow`(`resources.go:33-65`)根据 cursor 和 direction 计算查询窗口,确保不会查超过 7 天的日志。

---

## 九、gRPC 客户端装配

每个 Instance 持有一个 `GRPCClient`(`client.go:15-24`),聚合 4 个 gRPC 子客户端:

```go
type GRPCClient struct {
	Info     infogrpc.InfoServiceClient       // 节点信息(健康/角色)
	Sandbox  orchestratorgrpc.SandboxServiceClient   // 沙箱生命周期
	Volumes  orchestratorgrpc.VolumeServiceClient    // 持久化卷
	Template templatemanagergrpc.TemplateServiceClient  // 模板/构建

	Connection *grpc.ClientConn
	observeTarget string
}
```

### 9.1 `createClient`

`instance_client.go:33-68` 装配 gRPC 连接:

```go
grpcOptions := []grpc.DialOption{
	grpc.WithStatsHandler(otelgrpc.NewClientHandler(...)),  // OTEL tracing
	grpc.WithKeepaliveParams(keepalive.ClientParameters{
		Time: 30 * time.Second, Timeout: 5 * time.Second, PermitWithoutStream: true,
	}),
}

if auth != nil {
	grpcOptions = append(grpcOptions, grpc.WithPerRPCCredentials(auth))  // remote 才有
}

if endpointTLS {
	cred := credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})
	grpcOptions = append(grpcOptions, grpc.WithAuthority(endpoint), grpc.WithTransportCredentials(cred))
} else {
	grpcOptions = append(grpcOptions, grpc.WithTransportCredentials(insecure.NewCredentials()))
}
```

注释提到 AWS ALB 的 TLS 终止用 TLS 1.2(`instance_client.go:55`),所以这里没有强制 TLS 1.3。

### 9.2 Remote 的 PerRPC 鉴权

`instanceAuthorization`(`instance_client.go:19-31`):

```go
type instanceAuthorization struct {
	secret            string
	serviceInstanceID string
	tls               bool
}

func (a instanceAuthorization) GetRequestMetadata(...) (map[string]string, error) {
	return map[string]string{
		consts.EdgeRpcAuthHeader:             a.secret,
		consts.EdgeRpcServiceInstanceIDHeader: a.serviceInstanceID,
	}, nil
}
```

每个 gRPC 调用都带两个 header:
- `EdgeRpcAuthHeader`:cluster 共享密钥(证明"我是 CP")
- `EdgeRpcServiceInstanceIDHeader`:**目标**节点的 service instance ID

后者是关键——edge-backend 是个**多路 gRPC 代理**,它根据 service instance ID 把请求路由到正确的后端节点。

---

## 十、多集群路由:`clusterID` 的解析与回退

### 10.1 `WithClusterFallback`

`packages/shared/pkg/clusters/cluster.go:9-15`:

```go
func WithClusterFallback(clusterID *uuid.UUID) uuid.UUID {
	if clusterID == nil {
		return consts.LocalClusterID
	}
	return *clusterID
}
```

**所有**调用 `clusters.GetClusterById` 的 handler 都先经过这个 helper。`team.ClusterID == NULL` 自动落到 local cluster。

### 10.2 典型 handler 路径

`sandbox_logs.go:106-107`:

```go
clusterID := clustersshared.WithClusterFallback(team.ClusterID)
cluster, ok := a.clusters.GetClusterById(clusterID)
```

随后:`cluster.GetResources().GetSandboxLogs(...)`——剩下的工作交给 `ClusterResource` 实现,handler 完全不关心是哪种 cluster。

### 10.3 模板的 cluster 归属

模板的 `envs.cluster_id` 决定它在哪个 cluster 上 build/run。**跨 cluster 的模板查找目前不支持**——`resolveTemplateAndTeam`(`auth.go:134-190`)在用 access token 时只按 template ID 查,不关心 cluster。如果模板的 cluster 与 team 的 cluster 不一致,会失败。

实际部署中,team 和它的模板通常在同一个 cluster 上(因为 build 请求会路由到 team 的 cluster,生成的模板也归属于该 cluster)。

---

## 十一、Edge API:远端 cluster 的统一入口

Remote cluster 通过 **Edge API**(由 edge-backend 服务提供)统一暴露:

```
CP API  ──HTTPS──►  Edge API  ──►  Orchestrator 1
                    (edge-backend)  ├─► Orchestrator 2
                                    └─► Builder
```

### 11.1 两类 Edge 端点

| 类型 | 用途 | 鉴权 |
|---|---|---|
| HTTP REST | `/v1/service-discovery`, `/v1/sandboxes/{id}/metrics`, `/v1/sandboxes/{id}/logs`, `/v1/sandboxes/metrics`(批量), `/v1/templates/builds/{id}/logs` | `EdgeApiAuthHeader`(cluster 共享密钥) |
| gRPC | `SandboxService`, `VolumeService`, `TemplateService`, `InfoService` | `EdgeRpcAuthHeader` + `EdgeRpcServiceInstanceIDHeader` |

### 11.2 Edge API 鉴权头

`consts.EdgeApiAuthHeader` 与 `consts.EdgeRpcAuthHeader` 是两个**不同的** header 名,但值都是 cluster 的 `token`(在 DB 的 `clusters.token` 列里)。HTTP 用前者,gRPC 用后者——这是因为 gRPC 走 `credentials.PerRPCCredentials` 机制,需要单独的 header 名。

### 11.3 Sandbox 数据面

`cluster.SandboxDomain`(`cluster.go:41`)是**数据面**域名。终端用户的 SDK 调用沙箱(如 `wss://` 连接)走这个域名,而不是 control plane 域名。这是为什么:

- Control plane:`api.e2b.dev`(CP API 服务)
- Data plane:`<cluster>.e2b.dev`(由 client-proxy + edge 路由到具体沙箱)

`SandboxDomain` 在 local cluster 上是 `nil`(同 VPC 内不需要专门域名)。

---

## 十二、关键时序图

### 12.1 启动时的 cluster pool 装配

```
main.go         APIStore      clusters.NewPool     DB
  │                │                 │               │
  │ NewAPIStore    │                 │               │
  │───────────────>│                 │               │
  │                │ clusters.NewPool│               │
  │                │────────────────>│               │
  │                │                 │ GetActiveClusters
  │                │                 │──────────────>│
  │                │                 │<──────────────│ rows
  │                │                 │               │
  │                │                 │ + localClusterConfig()
  │                │                 │               │
  │                │                 │ for each cluster:
  │                │                 │   PoolInsert → newLocal/newRemoteCluster
  │                │                 │   go synchronization.Start(...)
  │                │                 │               │
  │                │<────────────────│ *Pool         │
  │<───────────────│                 │               │
```

### 12.2 周期对账(每 15s)

```
Pool.sync goroutine          DB                  内存 map
   │                          │                     │
   │ tick (15s)               │                     │
   │ SourceList ─────────────►│                     │
   │ ◄────────────────────────│ []Cluster           │
   │                          │                     │
   │ for each in SourceList:  │                     │
   │   if !PoolExists:        │                     │
   │     PoolInsert ──────────────────────────────►│ add
   │                          │                     │
   │ for each in PoolList:    │                     │
   │   if !SourceExists:      │                     │
   │     PoolRemove ──────────────────────────────►│ remove + close
   │                          │                     │
   │ sleep(clusterSyncTimeout)│                     │
```

### 12.3 处理一个 sandbox metrics 请求(remote cluster)

```
Client           APIStore          clusters.Pool       Remote Cluster          Edge API
  │                │                    │                     │                    │
  │ GET /sandboxes/{id}/metrics        │                     │                    │
  │ X-API-Key: e2b_...                 │                     │                    │
  │───────────────>│                    │                     │                    │
  │                │ ValidateAPIKey → team.ClusterID         │                    │
  │                │ WithClusterFallback(team.ClusterID)     │                    │
  │                │ GetClusterById ───►│                     │                    │
  │                │ ◄──────────────────│ *Cluster            │                    │
  │                │ cluster.GetResources().GetSandboxMetrics│                    │
  │                │ ────────────────────────────────────────────────────────────►│ /v1/sandboxes/{id}/metrics
  │                │ ◄───────────────────────────────────────────────────────────│ metrics
  │                │                          │                    │               │
  │ 200 + metrics  │                          │                    │               │
  │<───────────────│                                                                      │
```

### 12.4 节点查找失败 → 懒同步

```
Handler                         Cluster                instancesSyncStore      Discovery
  │                                │                          │                       │
  │ GetTemplateBuilderByNodeID(id) │                          │                       │
  │───────────────────────────────>│ ErrTemplateBuilderNotFound                      │
  │<───────────────────────────────│                          │                       │
  │                                │                          │                       │
  │ SyncInstances(ctx)             │                          │                       │
  │───────────────────────────────>│ synchronization.Sync(ctx)│                       │
  │                                │─────────────────────────>│                       │
  │                                │                          │ Query ──────────────►│
  │                                │                          │ ◄────────────────────│ items
  │                                │                          │ PoolInsert(new)      │
  │                                │                          │──> newInstance       │
  │                                │ ◄────────────────────────│ done                 │
  │                                │                          │                       │
  │ GetTemplateBuilderByNodeID(id) │ (retry)                  │                       │
  │───────────────────────────────>│                          │                       │
  │ ◄──────────────────────────────│ *Instance                │                       │
```

---

## 十三、配置

### 13.1 环境变量

| 变量 | 用途 |
|---|---|
| `TESTS_ORCH_INSTANCE_HOST` | 本地开发时 local discovery 用的 host(默认 `localhost`) |
| `LOKI_URL` / `LOKI_USER` / `LOKI_PASSWORD` | Local cluster 的 build/sandbox logs 后端 |
| `CLICKHOUSE_*` | Local cluster 的 metrics 后端 |

Local cluster 不需要 cluster-specific 配置——它的 ID 是 `uuid.Nil`,所有节点通过 Nomad/Consul 发现。

### 13.2 DB 配置

每个 remote cluster 在 `clusters` 表里有一行,包含 `endpoint`、`endpoint_tls`、`token` 等字段。**新增 cluster 只需要 INSERT 一行**——下一个 15s 周期会被 `PoolInsert` 自动加载。

### 13.3 同步间隔常量

| 常量 | 文件 | 值 |
|---|---|---|
| `clustersSyncInterval` | `clusters_sync.go:25` | 15s(Pool 对账) |
| `clusterSyncTimeout` | `clusters_sync.go:26` | 5s(单次对账超时) |
| `instancesSyncInterval` | `cluster.go:35` | 5s(Cluster 内 instance 对账) |
| `instancesSyncTimeout` | `cluster.go:36` | 5s |
| `maxInstanceSyncCallTimeout` | `instance.go:27` | 1s(单个 instance 的 ServiceInfo 调用) |
| `maxSyncFailuresBeforeUnhealthy` | `instance.go:25` | 3 |

---

## 十四、关键代码文件索引

| 文件 | 主要导出 | 说明 |
|---|---|---|
| `packages/api/internal/clusters/clusters_sync.go` | `Pool`、`NewPool`、`clustersSyncStore` | 顶层 cluster 注册表 + DB 对账 |
| `packages/api/internal/clusters/cluster.go` | `Cluster`、`NewCluster`、`newLocalCluster`、`newRemoteCluster` | 单个 cluster 抽象 |
| `packages/api/internal/clusters/instances_sync.go` | `instancesSyncStore` | cluster 内 instance 对账 |
| `packages/api/internal/clusters/instance.go` | `Instance`、`newInstance`、`Sync`、`GetInfo`、`GetMachineInfo` | 单个节点代理 |
| `packages/api/internal/clusters/instance_client.go` | `createClient`、`instanceAuthorization` | gRPC 连接装配 |
| `packages/api/internal/clusters/client.go` | `GRPCClient`、`NewGRPCClient` | gRPC 子客户端聚合 |
| `packages/api/internal/clusters/resources.go` | `ClusterResource` 接口、`LogQueryWindow`、`getBuildLogsWithSources` | 资源访问抽象 + 共享逻辑 |
| `packages/api/internal/clusters/resources_local.go` | `LocalClusterResourceProvider` | ClickHouse + Loki 直连 |
| `packages/api/internal/clusters/resources_remote.go` | `ClusterResourceProviderImpl` | Edge API 转发 |
| `packages/api/internal/clusters/discovery/discovery.go` | `Discovery` 接口、`Item` | 节点发现抽象 |
| `packages/api/internal/clusters/discovery/local.go` | `LocalServiceDiscovery` | Nomad/static 发现 |
| `packages/api/internal/clusters/discovery/kubernetes.go` | `KubernetesServiceDiscovery`、`NewKubernetesDiscovery`、`podReady` | K8s 部署的 local cluster 发现 |
| `packages/api/internal/clusters/discovery/remote.go` | `RemoteServiceDiscovery` | Edge API `/v1/service-discovery` |
| `packages/api/internal/clusters/discovery/static.go` | `StaticServiceDiscovery` | 测试用 |
| `packages/shared/pkg/clusters/cluster.go` | `WithClusterFallback` | `*uuid.UUID` → `uuid.UUID`(NULL→local) |
| `packages/shared/pkg/consts/cluster.go` | `LocalClusterID = uuid.Nil` | local cluster 标识 |
| `packages/db/queries/get_active_clusters.sql` | `GetActiveClusters` | 只返回有 team 引用的 cluster |
| `packages/db/migrations/20250606213446_deployment_cluster.sql` | — | 创建 `clusters` 表 |
| `packages/db/migrations/20250624001048_cluster_for_templates.sql` | — | `envs.cluster_id` |
| `packages/db/migrations/20250714132924_cluster_sandbox_domain.sql` | — | `sandbox_proxy_domain` |
| `packages/db/migrations/20260423170000_cluster_auth_org_id.sql` | — | `auth_org_id` |
| `packages/db/migrations/20260609120000_cluster_name.sql` | — | `name` |

---

## 十五、设计要点与权衡

### 15.1 为什么用 `smap.Map` 而不是 `sync.Map`?

`smap.Map`(`packages/shared/pkg/smap`)是 E2B 自家的类型化包装。`sync.Map` 的值是 `any`,需要 type assert;smap 在编译期保留类型。代价是多一层封装,但类型安全更重要。

### 15.2 `synchronization.Synchronize` 的"对账"模型

整套同步框架基于"**源(source)是真相,池(pool)是缓存**"的假设:
- Source 有的 → Pool 必须有(`PoolInsert`)
- Source 没的 → Pool 必须没(`PoolRemove`)
- 都有的 → 更新(`PoolUpdate`,目前是空)

这个模型简单,但要求 source 是稳定的(Nomad alloc 列表、DB cluster 列表)。如果 source 本身不稳定(比如经常抖动),会导致内存中 instance 反复重建——影响 gRPC 连接的稳定性。

### 15.3 Local cluster 无条件注入

`localClusterConfig()`(`clusters_sync.go:37-43`)永远返回一个 local cluster 行,即使 DB 里没有任何 team 用它。这是为了:
- **简化 handler 逻辑**:任何 team 都能落到一个 cluster
- **本地开发**:不需要在 DB 里手动插入 cluster 行

代价是:local cluster 的 `instancesSyncStore` 在生产中如果是 K8s/Nomad 部署但所有 team 都用 remote cluster,仍然会跑 discovery 浪费资源。`instancesSyncInterval = 5s`,成本不高但非零。

### 15.4 `PoolUpdate` 空实现的妥协

不实现热更新是为了:**避免运行时关闭大量 gRPC 连接**。如果 cluster 的 endpoint 改了,所有 instance 的 gRPC 连接都要重建——这是 expensive 操作,而且可能在重建期间丢失请求。当前做法是要求**重启 API** 生效。

替代方案:为每个 instance 维护一个 generation number,Cluster-level 字段变化时 bump generation,instance 在下次 sync 时自检并重建。但代码复杂度显著增加。

### 15.5 Remote 走 Edge API 而不是直连

为什么不直接从 CP 连到 remote cluster 的 orchestrator?因为:
- **网络隔离**:remote cluster 通常在独立 VPC,只有 edge-backend 暴露在公网
- **认证简化**:CP 只需一个 token,不需要为每个 orchestrator 维护独立凭证
- **路由透明**:edge-backend 根据 `ServiceInstanceIDHeader` 转发,CP 不需要知道节点 IP

代价是多一跳延迟(gRPC 经过 edge 转发)。对控制面操作(创建/销毁沙箱)这点延迟可接受;数据面(沙箱内 IO)不走这条路,走 `SandboxDomain`。

### 15.6 Instance 不立即移除的策略

`maxSyncFailuresBeforeUnhealthy = 3` 但 unhealthy 后**不移除**——只在 source(Nomad/Edge API)不再列出时才移除。这是为了让**临时网络问题**自愈,而不是放大故障。

代价是:unhealthy 的 instance 仍占用内存和 gRPC 连接。但连接本身有 keepalive(30s ping),如果节点真死了,keepalive 会失败,连接最终会被关闭。

---

## 十六、常见问题与排查

### Q1:新增了一个 remote cluster,但 handler 找不到它

DB 里 INSERT 了 cluster 行,但**还没有 team 引用它**。`GetActiveClusters` 的 `JOIN public.teams` 过滤了孤儿 cluster(`get_active_clusters.sql:4`)。**处理**:把某个 team 的 `cluster_id` 设为该 cluster 的 ID。

### Q2:`GetClusterById` 返回 false,但 team.ClusterID 不是 NULL

可能的原因:
- DB 里 cluster 行被删了(但 team 没更新)
- 还没等同步周期(15s)——刚 INSERT 的 cluster 不会立即可用
- 装配失败(`newRemoteCluster` 出错,只 log 不 panic)

**排查**:看日志中的 `Initializing remote cluster failed` 或 `Remote cluster initialized successfully`。

### Q3:Local cluster 的 instance 列表为空

检查:
- `env.IsLocal()` 是否为 true(本地开发模式)
- `TESTS_ORCH_INSTANCE_HOST` 是否设置(默认 `localhost`)
- Nomad alloc 列表是否非空(`ListOrchestratorAndTemplateBuilderAllocations` 是否报错)

### Q4:Builder 报"`available template builder not found`"

`GetAvailableTemplateBuilder`(`cluster.go:233-257`)返回 `ErrAvailableTemplateBuilderNotFound`。原因:
- 没有任何 healthy + IsBuilder 的实例
- CPU 架构不匹配(exact match 要求)

**排查**:看 instance 的 `Status` 和 `IsBuilder`,以及模板期望的 CPU 架构。

### Q5:Remote cluster 的 gRPC 调用全部 401

`EdgeRpcAuthHeader` 不匹配。检查:
- DB 里 `clusters.token` 是否正确
- Edge-backend 那边期望的 token 是否一致
- 是否在新建 cluster 后忘记同步 edge-backend 的配置

### Q6:模板在 cluster A build,在 cluster B 找不到

这是预期行为——**模板绑定到 cluster**(`envs.cluster_id`)。team 切换 cluster 后,旧模板不会迁移。**处理**:在新 cluster 上重新 build。

### Q7:Instance 反复出现 "marking instance as unhealthy"

`instance.go:134-140` 触发。原因:
- 节点真的不健康(gRPC 服务挂了)
- 网络问题导致 1s 内拿不到 ServiceInfo(`maxInstanceSyncCallTimeout = 1s`)
- 节点负载过高,响应慢

**排查**:看连续失败的 counter 和具体错误。如果是节点负载问题,可能需要扩容。

### Q8:`SyncInstances` 在哪里被调用?

handler 在节点查找失败时调它。典型场景:沙箱刚创建,orchestrator 还没被 5s 周期 sync 看到。`SyncInstances` 立即触发一次 discovery,补上缺失的 instance。

### Q9:`SandboxDomain` 是什么?

数据面域名(如 `sandbox.us-east.example.com`)。终端用户的 SDK 调用沙箱走这里(由 client-proxy 路由),不走 control plane 域名。Local cluster 上是 `nil`。

### Q10:`auth_org_id` 的作用?

远端 cluster 关联的 OAuth 组织 ID,用在 **client-proxy → CP API 的 gRPC 鉴权**路径上(`proxy_grpc.go:159-173`)。当 `requireEdgeClientProxyAuth` 开启时,CP 拿到 team 的 cluster,取出 `cluster.AuthOrgID`,然后调 `oauth.RequireOrgClaims(clientProxyClaims, authOrgID)`(`oauth.go:126-136`)检查 client-proxy 提交的 JWT 中 `OrgID` claim 是否匹配。

两点特别注意:
- 若 `auth_org_id` 是空字符串,**直接拒绝**(`oauth.go:128-130`)
- 比较用 `subtle.ConstantTimeCompare`,防时序攻击

简言之:它确保 client-proxy 来自这个 cluster 期望的组织,防止跨组织冒充。

---

## 附录 A:`Cluster` / `Instance` 状态机

### A.1 Cluster 生命周期

```
                GetActiveClusters 包含
                          │
                          ▼
                      ┌────────┐
                      │ Active │ ◄──── PoolInsert
                      └────┬───┘
                           │
              GetActiveClusters 不再包含
                           │
                           ▼
                      ┌────────┐
                      │ Closed │ ──── PoolRemove
                      └────────┘      (close gRPC conns)
```

注:Cluster 本身没有"Unhealthy"状态——只有 Instance 有。如果 cluster 的 endpoint 完全不可达,所有 instance 会变 unhealthy,但 cluster 仍在内存中。

### A.2 Instance 状态机

```
                  PoolInsert + Sync 成功
                          │
                          ▼
                      ┌─────────┐
              ┌───────│ Healthy │
              │       └────┬────┘
              │            │ Sync 失败 (×3)
              │            ▼
              │       ┌───────────┐
              │       │ Unhealthy │
              │       └─────┬─────┘
              │             │
              │     ┌───────┴────────┐
              │     │                │
              │ Sync 成功       Source 不再有
              │ (重置 fail count)    │
              │     │                │
              └─────┘                ▼
                                ┌────────┐
                                │ Closed │ ── PoolRemove
                                └────────┘
```

---

## 附录 B:DB schema 演进

按时间顺序:

| 日期 | Migration | 改动 |
|---|---|---|
| 2025-06-06 | `20250606213446_deployment_cluster.sql` | 创建 `clusters` 表;`teams.cluster_id` |
| 2025-06-24 | `20250624001047_deploy_cluster_policy.sql` | (空迁移,占位) |
| 2025-06-24 | `20250624001048_cluster_for_templates.sql` | `envs.cluster_id` |
| 2025-06-24 | `20250624001049_cluster_for_builds.sql` | `env_builds.cluster_node_id`(TEXT,记录 build 跑在哪个节点) |
| 2025-07-14 | `20250714132924_cluster_sandbox_domain.sql` | `clusters.sandbox_proxy_domain` |
| 2026-04-23 | `20260423170000_cluster_auth_org_id.sql` | `clusters.auth_org_id` + 部分 UNIQUE 索引(WHERE IS NOT NULL) |
| 2026-06-09 | `20260609120000_cluster_name.sql` | `clusters.name` |

当前完整 schema(等价):

```sql
CREATE TABLE clusters (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 TEXT NOT NULL,
    endpoint             TEXT NOT NULL,
    endpoint_tls         BOOLEAN NOT NULL DEFAULT TRUE,
    token                TEXT NOT NULL,
    auth_org_id          TEXT,                      -- 无字段级 UNIQUE,uniqueness 由部分索引保证(见下)
    sandbox_proxy_domain TEXT
);

ALTER TABLE teams ADD COLUMN cluster_id UUID NULL REFERENCES clusters(id);
ALTER TABLE envs   ADD COLUMN cluster_id UUID NULL REFERENCES clusters(id);

CREATE INDEX teams_cluster_id_uq  ON teams (cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX envs_cluster_id      ON envs   (cluster_id) WHERE cluster_id IS NOT NULL;
CREATE UNIQUE INDEX clusters_auth_org_id_idx
    ON clusters (auth_org_id) WHERE auth_org_id IS NOT NULL;
```

---

## 附录 C:术语表

| 术语 | 含义 |
|---|---|
| **Cluster** | 一组 orchestrator/builder 实例的集合,可以是 local(本地 Nomad)或 remote(远端 edge-backend) |
| **Pool** | 所有 active cluster 的内存注册表,定期与 DB 对账 |
| **Instance** | Cluster 内单个 orchestrator/builder 进程的内存代理 |
| **Discovery** | 节点发现机制,返回当前 cluster 内的 instance 列表 |
| **Local cluster** | ID 为 `uuid.Nil` 的特殊 cluster,本地直连节点 |
| **Remote cluster** | 通过 Edge API 访问的远端 cluster |
| **Edge API** | edge-backend 暴露的 HTTP+gRPC 接口,remote cluster 的统一入口 |
| **Edge headers** | `EdgeApiAuthHeader`(HTTP)、`EdgeRpcAuthHeader`+`EdgeRpcServiceInstanceIDHeader`(gRPC) |
| **SandboxDomain** | 沙箱数据面访问的域名(终端用户用) |
| **`auth_org_id`** | 远端 cluster 关联的 OAuth 组织 ID,用于 client-proxy 鉴权(详见 Q10) |
| **Source vs Pool** | 同步框架中的概念:source 是真相(DB/Nomad/Edge API),pool 是内存缓存 |
| **CP API** | Control Plane API,即 `packages/api`(本文档所在的服务) |
| **`syncFailCount`** | Instance 连续失败计数,达到阈值后标记为 unhealthy |
| **`WithClusterFallback`** | 把 `*uuid.UUID`(可空)转换为 `uuid.UUID` 的 helper,NULL → local cluster |
| **`smap.Map`** | E2B 自家的类型化并发 map 包装(`packages/shared/pkg/smap`) |
