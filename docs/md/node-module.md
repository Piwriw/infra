# E2B 节点(Node / Cluster)系统详解

> 本文档详细描述 E2B Infrastructure 中 **节点(Node)与集群(Cluster)** 子系统的设计、架构、数据模型、生命周期、调度算法与关键实现。
>
> 适用于希望理解 E2B 如何管理 orchestrator / template-builder 节点、如何做服务发现、如何调度 sandbox 与 build 的工程师。
>
> **相关文档**:
> - [`template-module.md`](template-module.md) — Template 模版系统(build 产物)
> - [`sandbox-management.md`](sandbox-management.md) — Sandbox 管理面(节点上 sandbox 的生命周期)
> - [`database-schema.md`](database-schema.md) — 数据库 schema

---

## 目录

- [一、概述](#一概述)
- [二、核心概念](#二核心概念)
- [三、数据模型](#三数据模型)
- [四、节点 ID 与标识](#四节点-id-与标识)
- [五、CPU 兼容性](#五cpu-兼容性)
- [六、系统架构与组件](#六系统架构与组件)
- [七、Cluster 类型与配置](#七cluster-类型与配置)
- [八、Node 完整生命周期](#八node-完整生命周期)
- [九、Node 选择与调度](#九node-选择与调度)
- [十、Node 资源管理](#十node-资源管理)
- [十一、Autoscaling 自动伸缩](#十一autoscaling-自动伸缩)
- [十二、Nomad 集成](#十二nomad-集成)
- [十三、Build Node Pool vs Client Node Pool](#十三build-node-pool-vs-client-node-pool)
- [十四、gRPC / REST 接口](#十四grpc--rest-接口)
- [十五、配置与环境变量](#十五配置与环境变量)
- [十六、Feature Flags](#十六feature-flags)
- [十七、关键代码文件索引](#十七关键代码文件索引)
- [十八、设计要点与演进](#十八设计要点与演进)
- [十九、常见问题与排查](#十九常见问题与排查)

---

## 一、概述

### 1.1 节点系统是什么

E2B 的节点系统是 **多层级抽象**,管理着运行 Firecracker microVM 和 template build 的工作节点。从上到下可以分成:

| 层 | 概念 | 代码位置 |
|---|---|---|
| **Cluster(集群)** | 一组节点的逻辑分组,可能是本地集群也可能是远程集群 | `packages/api/internal/clusters/`、`clusters` 数据库表 |
| **Node Pool(节点池)** | Nomad 原生概念,把节点按用途划分(build / orchestrator / api) | IaC `nodepool-*.tf` + Nomad `node_pool` |
| **Instance / Node(实例/节点)** | 跑着 orchestrator 或 template-manager 进程的服务实例 | `clusters/instance.go`、`nodemanager/node.go` |
| **Orchestrator 进程** | 实际运行 Firecracker microVM 的进程,每节点一个 | `packages/orchestrator/` |

### 1.2 关键心智模型

> **"Node" 在代码里有两个层次的含义**,容易混淆:
>
> - 在 `packages/api/internal/clusters/` 里叫 **`Instance`** — discovery 发现到的一个服务实例(侧重连接管理、角色、健康检查)
> - 在 `packages/api/internal/orchestrator/nodemanager/` 里叫 **`Node`** — API 已连接、维护 gRPC 连接和 metrics 的节点(侧重调度、placement、status)
>
> 两者通过 `NewClusterNode()` 桥接([`nodemanager/node.go`](../../packages/api/internal/orchestrator/nodemanager/node.go))。

### 1.3 整体架构

```
                    ┌─────────────────────────────────────────────┐
                    │              User / SDK                      │
                    └──────────────┬──────────────────────────────┘
                                   │ REST API
                                   ▼
                    ┌─────────────────────────────────────────────┐
                    │              API Server                      │
                    │                                              │
                    │  ┌────────────────────────────────────────┐  │
                    │  │ Cluster Pool (15s DB sync)             │  │
                    │  │  └─ Local Cluster                      │  │
                    │  │  └─ Remote Cluster 1 (edge API)        │  │
                    │  │  └─ Remote Cluster 2 (edge API)        │  │
                    │  └────────────────────────────────────────┘  │
                    │                                              │
                    │  ┌────────────────────────────────────────┐  │
                    │  │ Orchestrator Manager                   │  │
                    │  │  ├─ Discovery (Nomad / K8s / edge)     │  │
                    │  │  ├─ Node Registry (20s sync)           │  │
                    │  │  ├─ Placement (Best-of-K)              │  │
                    │  │  └─ Evictor                             │  │
                    │  └────────────────────────────────────────┘  │
                    └──────────┬──────────────┬────────────────────┘
                               │ gRPC         │ gRPC (via edge proxy)
                               ▼              ▼
              ┌──────────────────────────┐   ┌──────────────────────────┐
              │  Local Cluster Nodes     │   │  Remote Cluster Nodes    │
              │  (Nomad-managed)         │   │  (managed by edge API)   │
              │                          │   │                          │
              │  ┌────────────────────┐  │   │  ┌────────────────────┐  │
              │  │ orchestrator node  │  │   │  │ orchestrator node  │  │
              │  │ (Firecracker VMs)  │  │   │  │ (Firecracker VMs)  │  │
              │  └────────────────────┘  │   │  └────────────────────┘  │
              │                          │   │                          │
              │  ┌────────────────────┐  │   │                          │
              │  │ template-manager   │  │   │                          │
              │  │ node (build)       │  │   │                          │
              │  └────────────────────┘  │   │                          │
              └──────────────────────────┘   └──────────────────────────┘
```

---

## 二、核心概念

### 2.1 Cluster(集群)

**定义**:一个 Cluster 是 "一组运行着 orchestrator/template-manager 进程的节点,共享同一个 edge endpoint"。

#### Cluster 的两种类型

| 类型 | ID | 发现方式 | 适用场景 |
|------|-----|----------|----------|
| **Local Cluster(本地集群)** | `uuid.Nil` | Nomad service / K8s pod / 静态 | 单机本地开发、自托管(self-host)主集群 |
| **Remote Cluster(远程集群)** | 非 nil UUID | edge API HTTP endpoint | BYOCH / BYOC(客户自管集群) |

**关键常量**:[`packages/shared/pkg/consts/cluster.go`](../../packages/shared/pkg/consts/cluster.go)

```go
var LocalClusterID = uuid.Nil
```

**Cluster fallback 函数**:[`packages/shared/pkg/clusters/cluster.go`](../../packages/shared/pkg/clusters/cluster.go)

```go
func WithClusterFallback(clusterID *uuid.UUID) uuid.UUID {
    if clusterID == nil {
        return consts.LocalClusterID
    }
    return *clusterID
}
```

这是贯穿整个调度链路的"兜底函数" — 当 team 没绑定 cluster 时,所有 sandbox 都落到本地集群。

### 2.2 Node(节点)

**定义**:一台运行着 orchestrator(或 template-manager)进程的(虚拟)机。

每个 Node 有:
- 一个**稳定的 Node ID**(对应云主机的 hostname / Nomad node name)
- 一个**易变的 Service Instance ID**(orchestrator 进程每次重启都变,UUID)

#### Node 的角色

由 `ORCHESTRATOR_SERVICES` 环境变量决定(见 [`packages/orchestrator/pkg/cfg/service.go`](../../packages/orchestrator/pkg/cfg/service.go)):

| 角色 | 服务发现名 | Nomad task group | 职责 |
|------|-----------|------------------|------|
| **Orchestrator** | `orchestrator` | `client-orchestrator` | 运行 Firecracker sandbox |
| **TemplateBuilder / Template Manager** | `template-manager` | `template-manager` | 构建 template 镜像 |

一个进程可以同时充当两个角色(本地开发场景)。

### 2.3 Node Pool(节点池)

Node Pool 是 **Nomad 原生概念**(Nomad 1.4+),不是 E2B 自创的。E2B 用 Nomad node pool 把节点按用途隔离:

| Node Pool | 跑什么 | GCP | AWS |
|-----------|--------|-----|-----|
| `build` | template-manager(build 镜像) | ✓ | — |
| `orchestrator` | orchestrator(运行 sandbox) | ✓ | — |
| `client` | orchestrator(运行 sandbox) | — | ✓ |
| `api` | API server | ✓ | ✓ |
| `clickhouse` | ClickHouse | ✓ | ✓ |
| `control-server` | control server | — | ✓ |

在 IaC 里,node pool 名通过 `run-nomad.sh` 写到 Nomad client 配置里,Nomad job spec 里通过 `node_pool = "${node_pool}"` 约束 job 只调度到对应池。

### 2.4 Instance(服务实例)

**定义**:discovery 发现到的一个服务实例,建立了 gRPC 连接。

**文件**:[`packages/api/internal/clusters/instance.go`](../../packages/api/internal/clusters/instance.go)

```go
type Instance struct {
    uniqueIdentifier string
    ClusterID        uuid.UUID
    NodeID           string
    LocalIPAddress   string

    serviceInstanceID    string
    serviceVersion       string
    serviceVersionCommit string

    client          *GRPCClient
    status          infogrpc.ServiceInfoStatus
    statusChangedAt time.Time
    machine         machineinfo.MachineInfo
    roles           []infogrpc.ServiceInfoRole
    isBuilder       bool
    isOrchestrator  bool

    syncFailCount int
    // ...
}
```

每个 Instance:
- 有 `InstanceID`(每次进程重启都变,UUID)
- 有 `NodeID`(稳定,来自 hostname)
- 维护 gRPC 连接和健康状态

### 2.5 概念之间的关系

```
                    ┌─────────────────────────────┐
                    │          Cluster            │
                    │   (clusters.id = uuid)      │
                    │                             │
                    │   类型:                     │
                    │   - Local (uuid.Nil)        │
                    │   - Remote (非 nil uuid)    │
                    └────────────┬────────────────┘
                                 │ 1:N
                                 ▼
                    ┌─────────────────────────────┐
                    │       Instance (Node)       │
                    │   - NodeID (稳定)           │
                    │   - InstanceID (易变)       │
                    │   - Role (orchestrator/     │
                    │          template-builder)  │
                    └────────────┬────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────────┐
                    │   Node Pool (Nomad 概念)    │
                    │   - build                   │
                    │   - orchestrator / client   │
                    │   - api / clickhouse        │
                    └─────────────────────────────┘
```

---

## 三、数据模型

### 3.1 `public.clusters` 表

最早来源:[`20250606213446_deployment_cluster.sql`](../../packages/db/migrations/20250606213446_deployment_cluster.sql)

```sql
CREATE TABLE IF NOT EXISTS clusters (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint      TEXT NOT NULL,
    endpoint_tls  BOOLEAN NOT NULL DEFAULT TRUE,
    token         TEXT NOT NULL
);

ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS cluster_id UUID NULL REFERENCES clusters(id);
```

#### 完整字段(含后续 migration 演进)

| 字段 | 类型 | 含义 | 添加的 migration |
|------|------|------|------------------|
| `id` | UUID PK | 集群 ID | `20250606213446` |
| `endpoint` | TEXT NOT NULL | edge API 的 host(不带 scheme) | `20250606213446` |
| `endpoint_tls` | BOOLEAN DEFAULT TRUE | 是否用 HTTPS/WSS | `20250606213446` |
| `token` | TEXT NOT NULL | 共享密钥,放在 `EdgeApiAuthHeader` | `20250606213446` |
| `sandbox_proxy_domain` | TEXT | sandbox 流量代理域名 | [`20250714132924_cluster_sandbox_domain.sql`](../../packages/db/migrations/20250714132924_cluster_sandbox_domain.sql) |
| `auth_org_id` | TEXT UNIQUE | 关联到 Ory/auth 组织 ID | [`20260423170000_cluster_auth_org_id.sql`](../../packages/db/migrations/20260423170000_cluster_auth_org_id.sql) |
| `name` | TEXT NOT NULL DEFAULT '' | 人类可读的集群名 | [`20260609120000_cluster_name.sql`](../../packages/db/migrations/20260609120000_cluster_name.sql) |

### 3.2 Cluster 关联关系(FK)

| 子表 | 字段 | 含义 | Migration |
|------|------|------|-----------|
| `teams` | `cluster_id` | team 绑定到哪个 cluster | `20250606213446` |
| `envs` | `cluster_id` | template 绑定到 build 时所在的 cluster | [`20250624001048_cluster_for_templates.sql`](../../packages/db/migrations/20250624001048_cluster_for_templates.sql) |
| `env_builds` | `cluster_node_id` TEXT | build 跑在哪个 node | [`20250624001049_cluster_for_builds.sql`](../../packages/db/migrations/20250624001049_cluster_for_builds.sql),后改 nullable `20251121101953` |
| `snapshots` | `origin_node_id` TEXT | snapshot 从哪个 node 来 | [`20250708135401_snapshot_pause_node_id.sql`](../../packages/db/migrations/20250708135401_snapshot_pause_node_id.sql) |
| `snapshot_templates` | `origin_node_id`, `build_id` | 同上 | [`20260228120000_snapshot_template_origin_node.sql`](../../packages/db/migrations/20260228120000_snapshot_template_origin_node.sql) |

### 3.3 `GetActiveClusters` 查询

文件:[`packages/db/queries/get_active_clusters.sql`](../../packages/db/queries/get_active_clusters.sql)

```sql
-- 只返回至少被一个 team 引用的 cluster
SELECT DISTINCT c FROM clusters c
JOIN teams t ON t.cluster_id = c.id;
```

**设计意图**:没有被任何 team 引用的 remote cluster 不会被加载到内存,节省资源。

### 3.4 Node 状态枚举

**DB 中没有专门的 node 表** — node 是动态的,由 discovery 发现。Node 状态存在 API 内存里。

**Node 状态枚举**(见 [`packages/api/internal/api/api.gen.go`](../../packages/api/internal/api/api.gen.go)):

| 状态 | 含义 |
|------|------|
| `ready` | 健康,可调度 |
| `draining` | 优雅下线中(不接受新 sandbox) |
| `unhealthy` | 健康检查失败 |
| `standby` | 备用(手动设置) |
| `connecting` | gRPC 连接中(派生状态) |

**状态映射**(见 [`nodemanager/client.go`](../../packages/api/internal/orchestrator/nodemanager/client.go)):

| ServiceInfoStatus (gRPC) | NodeStatus (API) |
|--------------------------|------------------|
| `Healthy` | `Ready` |
| `Draining` | `Draining` |
| `Unhealthy` | `Unhealthy` |
| `Standby` | `Standby` |

---

## 四、节点 ID 与标识

### 4.1 关键常量

文件:[`packages/shared/pkg/consts/sandboxes.go`](../../packages/shared/pkg/consts/sandboxes.go)

```go
const NodeIDLength = 8                                         // Nomad node ID 截断长度
const ClientID = "6532622b"                                    // sandbox ID 里 client 部分的占位值

var OrchestratorAPIPort = uint16(utils.Must(strconv.ParseUint(
    env.GetEnv("ORCHESTRATOR_PORT", "5008"), 10, 16)))         // gRPC 端口默认 5008
```

### 4.2 Node ID 的来源链

```
1. Nomad job spec 设置环境变量
   ┌─────────────────────────────────────────────┐
   │ NODE_ID = "${node.unique.name}"              │  ← GCE/AWS 实例的 hostname
   │ (orchestrator.hcl:69, template-manager.hcl:96)│
   └─────────────────────────────────────────────┘
                       │
                       ▼
2. orchestrator 进程启动读取
   ┌─────────────────────────────────────────────┐
   │ env.GetNodeID() (env.go:46)                 │
   │ → 读 NODE_ID 环境变量(required)             │
   └─────────────────────────────────────────────┘
                       │
                       ▼
3. 注入 service info
   ┌─────────────────────────────────────────────┐
   │ service.NewInfoContainer(nodeID, ...)       │
   │ (factories/run.go:281)                      │
   └─────────────────────────────────────────────┘
                       │
                       ▼
4. 通过 gRPC 暴露
   ┌─────────────────────────────────────────────┐
   │ ServiceInfoResponse.NodeId                  │
   │ (service/service_info.go:71)                │
   └─────────────────────────────────────────────┘
```

### 4.3 Nomad Short ID

Nomad 内部 node ID 是 36 字符 UUID,但 E2B **截断到前 8 字符** 作为 `NomadNodeShortID`(`consts.NodeIDLength`),用于在 discovery 层去重。

截断逻辑见:
- [`packages/api/internal/orchestrator/discovery/nomad.go`](../../packages/api/internal/orchestrator/discovery/nomad.go)
- [`packages/api/internal/orchestrator/discovery/nomad_node_pool.go`](../../packages/api/internal/orchestrator/discovery/nomad_node_pool.go)

### 4.4 scopedNodeID(跨集群唯一 key)

在 API 的 `Orchestrator.nodes` map 里,key 是 `<clusterID>-<nodeID>`(local cluster 直接用 nodeID),保证跨集群唯一。

文件:[`packages/api/internal/orchestrator/client.go`](../../packages/api/internal/orchestrator/client.go)

```go
func (o *Orchestrator) scopedNodeID(clusterID uuid.UUID, nodeID string) string {
    if clusterID == consts.LocalClusterID {
        return nodeID
    }
    return fmt.Sprintf("%s-%s", clusterID, nodeID)
}
```

### 4.5 Service Instance ID

- 每次进程重启都变(UUID)
- 用于区分同一 node 上的不同进程实例(例如快速重启)
- 不用于调度决策(调度用稳定的 NodeID)

---

## 五、CPU 兼容性

### 5.1 为什么需要 CPU 兼容性

Firecracker microVM 的 **snapshot resume** 要求 CPU 模型兼容:
- 同 model:总是兼容
- 跨 model:只能从旧到新(指令集超集),不能从新到旧

### 5.2 MachineInfo 结构

文件:[`packages/shared/pkg/machineinfo/machine_info.go`](../../packages/shared/pkg/machineinfo/machine_info.go)

```go
type MachineInfo struct {
    CPUArchitecture string   `json:"cpu_architecture"`
    CPUFamily       string   `json:"cpu_family"`
    CPUModel        string   `json:"cpu_model"`
    CPUModelName    string   `json:"cpu_model_name"`
    CPUFlags        []string `json:"cpu_flags"`
}

const (
    IceLakeModel       = "106"   // n2 GCP 机型
    EmeraldRapidsModel = "207"   // n4 GCP 机型
)
```

### 5.3 兼容性规则

**非对称跨代兼容**(硬编码):

```go
// machine_info.go:33
var compatibleNodeModels = map[string]map[string]struct{}{
    // Intel: an n2 (Ice Lake, model 106) build may run on an n4
    // (Emerald Rapids, model 207) node, but not the reverse.
    IceLakeModel: {EmeraldRapidsModel: {}},
}
```

意思是:
- n2(Ice Lake, model 106)上 build 的 sandbox 可以在 n4(Emerald Rapids, model 207)上 resume ✓
- 反过来不行 ✗

### 5.4 两个检查方法

```go
// IsCompatibleWith:sandbox/Resume 用,允许同 model 或硬编码的跨代兼容
func (m MachineInfo) IsCompatibleWith(nodeCPU MachineInfo) bool

// IsExactMatch:build 调度用,要求 CPU model 完全相同(因为 build 要确定性)
func (m MachineInfo) IsExactMatch(other MachineInfo) bool
```

### 5.5 使用场景对比

| 场景 | 方法 | 原因 |
|------|------|------|
| **Template build 选 build node** | `IsExactMatch` | build 要求确定性,不允许跨代 |
| **Sandbox 调度(resume 与 cold start 通用)** | `IsCompatibleWith` | 允许跨代 resume,提高调度灵活性;build 无 CPU 信息时(`CPUArchitecture == ""`)视为兼容(向后兼容) |

> **注**:调度层不区分 cold start 和 resume — `isNodeCPUCompatible`(`placement/cpu_compatibility.go`)对两者一视同仁,只要 build 携带 CPU 信息就用 `IsCompatibleWith` 检查。Resume 的"严格性"体现在它必须有兼容节点才能恢复 snapshot;cold start 在没有兼容节点时直接报"no available nodes"。

### 5.6 CPU 检测

文件:[`packages/orchestrator/pkg/service/machineinfo/main.go`](../../packages/orchestrator/pkg/service/machineinfo/main.go)

orchestrator 进程启动时调用 `Detect()`,用 gopsutil 读 `/proc/cpuinfo` 拿 CPU family/model/flags,通过 `ServiceInfoResponse` gRPC 上报给 API。

---

## 六、系统架构与组件

### 6.1 组件分层

```
┌─────────────────────────────────────────────────────────────────┐
│ 共享层 (packages/shared)                                         │
│  ├─ consts/cluster.go        LocalClusterID = uuid.Nil          │
│  ├─ consts/sandboxes.go      NodeIDLength, OrchestratorAPIPort  │
│  ├─ clusters/cluster.go      WithClusterFallback                │
│  ├─ clusters/discovery/nomad.go  Nomad allocation 发现           │
│  ├─ machineinfo/            CPU 兼容性                          │
│  └─ featureflags/           所有 node 相关 flag                  │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ API Cluster 层 (packages/api/internal/clusters)                 │
│  ├─ cluster.go              Cluster struct + build node 选择    │
│  ├─ clusters_sync.go        Pool:15s DB 同步                    │
│  ├─ instances_sync.go       instancesSyncStore:5s discovery 同步│
│  ├─ instance.go             Instance + Sync 健康检查             │
│  ├─ client.go               gRPC client + edge proxy auth       │
│  ├─ resources*.go           metrics/logs 接口                   │
│  └─ discovery/              Local/Remote/K8s/Static 发现         │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ API Node Manager 层 (packages/api/internal/orchestrator)        │
│  ├─ orchestrator.go         Orchestrator 主入口                  │
│  ├─ client.go               connectToNode/getOrConnectNode      │
│  ├─ cache.go                keepInSync 20s 同步                  │
│  ├─ create_instance.go      CreateSandbox 调度入口               │
│  ├─ nodemanager/            Node struct + metrics + status      │
│  ├─ discovery/              Nomad (new + legacy) + merged       │
│  ├─ placement/              Best-of-K 调度算法                   │
│  └─ evictor/                超时 sandbox 驱逐                    │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Orchestrator 服务端 (packages/orchestrator)                     │
│  ├─ service/info.go          ServiceInfo container              │
│  ├─ service/service_info.go  ServiceInfo gRPC                   │
│  ├─ server/main.go           主 server + DrainSandboxes         │
│  ├─ server/template_cache.go ListCachedBuilds gRPC              │
│  ├─ scheduling/metadata.go   build chain 解析                   │
│  └─ cfg/                     所有环境变量                        │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 各组件职责详解

#### 6.2.1 共享层

| 文件 | 职责 |
|------|------|
| [`consts/cluster.go`](../../packages/shared/pkg/consts/cluster.go) | `LocalClusterID = uuid.Nil` |
| [`consts/sandboxes.go`](../../packages/shared/pkg/consts/sandboxes.go) | `NodeIDLength=8`、`OrchestratorAPIPort=5008`、`ClientID` |
| [`clusters/cluster.go`](../../packages/shared/pkg/clusters/cluster.go) | `WithClusterFallback()` — nil cluster ID 兜底 |
| [`clusters/discovery/nomad.go`](../../packages/shared/pkg/clusters/discovery/nomad.go) | 共享 Nomad allocation 发现(`ListOrchestratorAndTemplateBuilderAllocations`)。**关键**:用 `v.NodeName`(云主机名)作为 NodeID,而不是 Nomad client UUID — 注释说"for historical reasons and better DX" |
| [`machineinfo/machine_info.go`](../../packages/shared/pkg/machineinfo/machine_info.go) | CPU 兼容性逻辑 |
| [`env/env.go`](../../packages/shared/pkg/env/env.go) | `GetNodeID()` 读 `NODE_ID`(required) |

#### 6.2.2 API Cluster 层

| 文件 | 职责 |
|------|------|
| [`clusters/cluster.go`](../../packages/api/internal/clusters/cluster.go) | `Cluster` struct,核心方法:`GetAvailableTemplateBuilder()`(随机洗牌 + CPU exact match 选 build node)、`GetOrchestrators()`、`SyncInstances()`。`newLocalCluster()` / `newRemoteCluster()` 是两个工厂 |
| [`clusters/clusters_sync.go`](../../packages/api/internal/clusters/clusters_sync.go) | `Pool` — 所有 cluster 的注册表。每 15s 从 DB `GetActiveClusters` 同步 + 注入 local cluster |
| [`clusters/instances_sync.go`](../../packages/api/internal/clusters/instances_sync.go) | `instancesSyncStore` — 同步单个 cluster 内的 instance 列表,每 5s 调一次 `discovery.Query()` |
| [`clusters/instance.go`](../../packages/api/internal/clusters/instance.go) | `Instance` struct — discovery 发现到的、建立了 gRPC 连接的服务实例。`Sync()` 调用 `InfoService.ServiceInfo` gRPC,失败 3 次(`maxSyncFailuresBeforeUnhealthy`)标记 unhealthy |
| [`clusters/client.go`](../../packages/api/internal/clusters/client.go) | gRPC client 工厂 `createClient()`。`instanceAuthorization` 实现 `PerRPCCredentials`,把 `EdgeRpcAuthHeader`(secret)和 `EdgeRpcServiceInstanceIDHeader`(路由用)塞进每次请求 — 远程 cluster gRPC 代理路由的关键 |
| [`clusters/resources.go`](../../packages/api/internal/clusters/resources.go) | `ClusterResource` interface:`GetSandboxMetrics`、`GetSandboxesMetrics`、`GetSandboxLogs`、`GetBuildLogs`。`getBuildLogsWithSources()` 是统一的 build 日志多源回退 |
| [`clusters/resources_local.go`](../../packages/api/internal/clusters/resources_local.go) | Local cluster 的资源实现,用 ClickHouse 查 metrics、Loki 查日志 |
| [`clusters/resources_remote.go`](../../packages/api/internal/clusters/resources_remote.go) | Remote cluster 的资源实现,全部走 edge API HTTP 端点 |

#### 6.2.3 API Cluster Discovery 层

| 文件 | 职责 |
|------|------|
| [`clusters/discovery/discovery.go`](../../packages/api/internal/clusters/discovery/) | `Discovery` interface + `Item{UniqueIdentifier, NodeID, InstanceID, LocalIPAddress, LocalInstanceApiPort}` |
| [`clusters/discovery/local.go`](../../packages/api/internal/clusters/discovery/) | `LocalServiceDiscovery` — 本地集群发现。本地开发环境用 `TESTS_ORCH_INSTANCE_HOST`;否则用共享层 Nomad allocation 列表 |
| [`clusters/discovery/remote.go`](../../packages/api/internal/clusters/discovery/) | `RemoteServiceDiscovery` — 远程集群,调 edge API 的 `V1ServiceDiscovery` 端点 |
| [`clusters/discovery/static.go`](../../packages/api/internal/clusters/discovery/) | `StaticServiceDiscovery` — 返回固定列表,darwin 本地开发用 |
| [`clusters/discovery/kubernetes.go`](../../packages/api/internal/clusters/discovery/) | `KubernetesServiceDiscovery` — K8s 部署的发现,列 template-manager pod |

#### 6.2.4 API Node Manager 层

| 文件 | 职责 |
|------|------|
| [`nodemanager/node.go`](../../packages/api/internal/orchestrator/nodemanager/node.go) | `Node` struct(API 视角的 node)。两个构造函数:`New()`(Nomad-managed 本地节点)和 `NewClusterNode()`(远程 cluster 节点)。`OptimisticAdd/OptimisticRemove` 是乐观资源记账 |
| [`nodemanager/sync.go`](../../packages/api/internal/orchestrator/nodemanager/sync.go) | `Node.Sync()` — 调 `ServiceInfo` gRPC 拉最新状态,重试 4 次(`syncMaxRetries`),全失败 `markUnhealthyLocal`。同时调 `GetSandboxes` 让 `sandbox.Store.Reconcile` 对账 |
| [`nodemanager/status.go`](../../packages/api/internal/orchestrator/nodemanager/status.go) | node 状态机。`Status()` 根据 gRPC 连接状态(`Shutdown/TransientFailure/Connecting`)动态推导 `Connecting` 状态。`SendStatusChange()` 通过 `ServiceStatusOverride` gRPC 远程改 orchestrator 的状态(drain 用) |
| [`nodemanager/client.go`](../../packages/api/internal/orchestrator/nodemanager/client.go) | `NewClient()` 创建 gRPC 连接(本地节点用 insecure) |
| [`nodemanager/placement_metrics.go`](../../packages/api/internal/orchestrator/nodemanager/placement_metrics.go) | `PlacementMetrics` — 跟踪"正在 placement 中"的 sandbox,避免重复计入负载 |
| [`nodemanager/metrics.go`](../../packages/api/internal/orchestrator/nodemanager/metrics.go) | `Metrics` struct — `CpuAllocated`、`CpuPercent`、`MemoryAllocated/Used/Total`、`SandboxCount`、`HugePages*`、`HostDisks` |
| [`nodemanager/metadata.go`](../../packages/api/internal/orchestrator/nodemanager/metadata.go) | `NodeMetadata{ServiceInstanceID, Commit, Version}`。`GetSandboxCreateCtx` 在创建 sandbox 时往 gRPC metadata 塞 `SandboxCatalogCreateEvent`(给 edge proxy 路由用) |
| [`nodemanager/labels.go`](../../packages/api/internal/orchestrator/nodemanager/labels.go) | node labels(用于 label-based scheduling)。**重要**:如果 node 没有 label,默认打 `"default"` label |
| [`nodemanager/machine_info.go`](../../packages/api/internal/orchestrator/nodemanager/machine_info.go) | CPU info getter/setter |
| [`nodemanager/sandboxes.go`](../../packages/api/internal/orchestrator/nodemanager/sandboxes.go) | `GetSandboxes()` — 调 orchestrator 的 `Sandbox.List` gRPC |
| [`nodemanager/sandbox_create.go`](../../packages/api/internal/orchestrator/nodemanager/sandbox_create.go) | `SandboxCreate()` — 调 `orchestrator.Sandbox.Create` |

#### 6.2.5 API Orchestrator 管理层

| 文件 | 职责 |
|------|------|
| [`orchestrator/orchestrator.go`](../../packages/api/internal/orchestrator/orchestrator.go) | `Orchestrator` struct — 整个节点管理的核心。`New()` 构造,启动 keepInSync goroutine、status logging、BestOfK config refresh。包含 `placementAlgorithm *placement.BestOfK` |
| [`orchestrator/client.go`](../../packages/api/internal/orchestrator/client.go) | 节点连接逻辑。`connectToNode()`(本地)、`connectToClusterNode()`(远程,走 cluster gRPC proxy)、`getOrConnectNode()`(按需发现 + 连接,处理 race)。`scopedNodeID()` 生成跨集群唯一 key。两个 `singleflight.Group`:`connectGroup`、`discoveryGroup` |
| [`orchestrator/cache.go`](../../packages/api/internal/orchestrator/cache.go) | `keepInSync()` — 每 20s(`cacheSyncTime`)同步节点列表。`syncNodes()` 分两路:本地 Nomad 节点 + 远程 cluster 节点 |
| [`orchestrator/create_instance.go`](../../packages/api/internal/orchestrator/create_instance.go) | `CreateSandbox()` — 创建 sandbox 的主入口。调度逻辑:`isResume && sbxData.NodeID != nil` 时优先 affinity 到原节点 |
| [`orchestrator/routing.go`](../../packages/api/internal/orchestrator/routing.go) | `addSandboxToRoutingTable` — 把 sandbox 注册到 Redis catalog(client proxy 路由用) |
| [`orchestrator/evictor/evict.go`](../../packages/api/internal/orchestrator/evictor/evict.go) | 超时 sandbox 驱逐器。50ms 轮询,并发上限 `MaxConcurrentEvictions`(默认 256) |

#### 6.2.6 API Node Discovery 层

> **注意**:这里和 clusters/discovery 是**两套** Discovery interface(命名空间隔离)— 这套是给 Nomad-managed orchestrator 用的。

| 文件 | 职责 |
|------|------|
| [`orchestrator/discovery/discovery.go`](../../packages/api/internal/orchestrator/discovery/discovery.go) | `Discovery` interface + `Node{ShortID, IPAddress, OrchestratorAddress}` |
| [`orchestrator/discovery/nomad.go`](../../packages/api/internal/orchestrator/discovery/nomad.go) | **新**:Nomad service-based — 查 `/v1/service/orchestrator` |
| [`orchestrator/discovery/nomad_node_pool.go`](../../packages/api/internal/orchestrator/discovery/nomad_node_pool.go) | **旧**:Nomad node-pool-based — 查 `/v1/nodes?NodePool=X`。作为 migration fallback 保留(注释明确说"Once no legacy jobs remain, disable via `NOMAD_ORCHESTRATOR_LEGACY_DISCOVERY_ENABLED=false`") |
| [`orchestrator/discovery/merged.go`](../../packages/api/internal/orchestrator/discovery/merged.go) | `NewMerged(primary, fallback)` — union 两个 discovery,按 ShortID 去重,primary 赢 |

#### 6.2.7 调度算法

| 文件 | 职责 |
|------|------|
| [`orchestrator/placement/placement.go`](../../packages/api/internal/orchestrator/placement/placement.go) | `PlaceSandbox()` — 调度入口。最多重试 3 次(`maxRetries`)。处理 `ResourceExhausted`(节点满,换一个)、其他错误(排除该节点 + 重试) |
| [`orchestrator/placement/placement_best_of_K.go`](../../packages/api/internal/orchestrator/placement/placement_best_of_K.go) | Best-of-K 调度算法实现。`Score = (cpuRequested + reserved + alpha*usageAvg) / (R * cpuCount)`。默认 `R=4, K=3, Alpha=0.5` |
| [`orchestrator/placement/cpu_compatibility.go`](../../packages/api/internal/orchestrator/placement/cpu_compatibility.go) | CPU 兼容性检查(用 `IsCompatibleWith`) |
| [`orchestrator/placement/label_compatibility.go`](../../packages/api/internal/orchestrator/placement/label_compatibility.go) | label 兼容性检查(node 必须包含所有 required labels) |

#### 6.2.8 Orchestrator 服务端

| 文件 | 职责 |
|------|------|
| [`service/info.go`](../../packages/orchestrator/pkg/service/info.go) | `ServiceInfo` container struct。`NewInfoContainer()`。`serviceRolesMapper`:`Orchestrator→ServiceInfoRole_Orchestrator`、`TemplateManager→ServiceInfoRole_TemplateBuilder` |
| [`service/service_info.go`](../../packages/orchestrator/pkg/service/service_info.go) | gRPC `InfoService` server。`ServiceInfo()` 返回 `ServiceInfoResponse`(NodeId、ServiceId、Status、Roles、MachineInfo、各种 metrics) |
| [`service/machineinfo/main.go`](../../packages/orchestrator/pkg/service/machineinfo/main.go) | `Detect()` 用 gopsutil 读 `/proc/cpuinfo` 拿 CPU family/model/flags |
| [`server/main.go`](../../packages/orchestrator/pkg/server/main.go) | orchestrator 主 server。`DrainSandboxes()` 优雅 drain。`refreshStartingSandboxesLimit` 每 30s 读 `MaxStartingInstancesPerNode` feature flag 调整信号量 |
| [`server/template_cache.go`](../../packages/orchestrator/pkg/server/template_cache.go) | `ListCachedBuilds()` gRPC — 返回本节点缓存的 build 列表(给预热/调度亲和用) |
| [`scheduling/metadata.go`](../../packages/orchestrator/pkg/scheduling/metadata.go) | `FromHeaders()` — 从 build 的 rootfs/memfile header 解析出引用的 build ID 链(最多 128 个),用于数据本地性调度 |
| [`cfg/model.go`](../../packages/orchestrator/pkg/cfg/model.go) | orchestrator 的所有环境变量 |
| [`cfg/service.go`](../../packages/orchestrator/pkg/cfg/service.go) | `ServiceType` 枚举 + `GetServices()` 解析 `ORCHESTRATOR_SERVICES` |

#### 6.2.9 Nomad Autoscaler 插件

| 文件 | 职责 |
|------|------|
| [`packages/nomad-nodepool-apm/main.go`](../../packages/nomad-nodepool-apm/main.go) | 自定义 Nomad autoscaler APM 插件,叫 `nomad-nodepool-apm` |
| [`packages/nomad-nodepool-apm/plugin/plugin.go`](../../packages/nomad-nodepool-apm/plugin/plugin.go) | 插件实现。被 template-manager job 的 scaling policy 引用,让 autoscaler 能根据 node pool 的节点数自动扩缩 template-manager allocation 数量 |

---

## 七、Cluster 类型与配置

### 7.1 BUILD_CLUSTERS_CONFIG / CLIENT_CLUSTERS_CONFIG

这两个环境变量是 **GCP 部署专用**(`.env.gcp.template:52,56`,AWS 模板里没有)。它们是 **JSON map**,key 是 cluster 名(默认 `"default"`),value 是 cluster 配置。

#### JSON 结构

```json
{
  "default": {
    "cluster_size": 1,                    // 初始节点数
    "hugepages_percentage": 80,           // (可选,client 默认 80,build 默认 60)
    "machine": {
      "type": "n1-standard-8",            // GCP 机型
      "min_cpu_platform": "Intel Skylake" // CPU 平台下限
    },
    "autoscaler": {                       // (可选)
      "size_max": 2,                      // 最大节点数
      "memory_target": 100,               // 内存利用率目标 %(必须 > hugepages_percentage)
      "cpu_target": 0.7                   // CPU 利用率目标 0-1
    },
    "boot_disk": {
      "disk_type": "pd-ssd",
      "size_gb": 200
    },
    "cache_disks": {
      "disk_type": "local-ssd",           // 或 pd-ssd
      "size_gb": 375,                     // local-ssd 必须 375
      "count": 1                          // local-ssd 可以多个,pd-ssd 必须 1
    },
    "network_interface_type": "...",      // (可选)
    "node_labels": ["..."]                // (可选)
  }
}
```

#### 示例(来自 `.env.gcp.template`)

```bash
BUILD_CLUSTERS_CONFIG='{"default": {"cluster_size": 1, "machine":{"type":"n1-standard-8","min_cpu_platform":"Intel Skylake"}, "boot_disk":{"disk_type":"pd-ssd","size_gb":200}, "cache_disks":{"disk_type":"local-ssd","size_gb":375,"count":1}}}'

CLIENT_CLUSTERS_CONFIG='{"default": {"cluster_size": 1, "hugepages_percentage": 80, "machine":{"type":"n1-standard-8","min_cpu_platform":"Intel Skylake"}, "autoscaler": {"size_max": 2, "memory_target": 100, "cpu_target": 0.7}, "boot_disk":{"disk_type":"pd-ssd","size_gb":200}, "cache_disks":{"disk_type":"local-ssd","size_gb":375,"count":1}}}'
```

#### 在 IaC 里怎么用

文件:[`iac/provider-gcp/nomad-cluster/main.tf`](../../iac/provider-gcp/nomad-cluster/main.tf)

- `module "build_cluster"` 对 `var.build_clusters_config`(`for_each`)每个 entry 创建一个 `worker-cluster` 子模块:
  - node_pool = `var.build_node_pool`(默认 `"build"`)
  - hugepages 默认 60
- `module "client_cluster"` 对 `var.client_clusters_config` 每个 entry 创建一个:
  - node_pool = `var.orchestrator_node_pool`(默认 `"orchestrator"`)
  - hugepages 默认 80
  - `"default"` key 特殊处理(集群名不加后缀)

### 7.2 LocalClusterID 与本地开发

- `LocalClusterID = uuid.Nil`
- 本地开发时 `env.IsLocal()` 为 true,所有节点都在 local cluster
- `LocalServiceDiscovery` 在本地模式下用 `TESTS_ORCH_INSTANCE_HOST`(默认 localhost)返回一个静态节点
- `Orchestrator` 在本地模式跳过 Nomad 同步(`skipNomadSync := env.IsLocal()`)
- 详见 [`DEV-LOCAL.md`](../../DEV-LOCAL.md) 和 [`packages/local-dev/`](../../packages/local-dev/)

### 7.3 Cluster 发现机制

#### 主集群(local cluster)节点发现 — 三种后端

| 后端 | 实现 | 查询 | 说明 |
|------|------|------|------|
| **Nomad service-based** | `NewNomad` | `/v1/service/orchestrator` | **新**,推荐 |
| **Nomad node-pool-based** | `NewNomadNodePool` | `/v1/nodes?NodePool=X` | **旧**,fallback |
| **Kubernetes** | `NewKubernetes` | 列 pod | K8s 部署用 |

`NewMerged` 把新和旧 union 起来,过渡期保险。

#### 远程 cluster 节点发现

`RemoteServiceDiscovery` 调 edge API 的 `V1ServiceDiscovery` HTTP 端点。

#### 服务发现频率

| 层 | 频率 | 说明 |
|----|------|------|
| Cluster Pool | 15s (`clustersSyncInterval`) | 从 DB 同步 cluster 列表 |
| Instance | 5s (`instancesSyncInterval`) | 同步单个 cluster 内的 instance 列表 |
| Node | 20s (`cacheSyncTime`) | API `keepInSync` 同步节点列表 |

#### Nomad ↔ Consul 关系

Nomad 用 Consul 做 DNS 和服务发现。Consul token、gossip key 在 `run-nomad.sh` 里配置。orchestrator job 在 Nomad 里注册 `service{ provider = "nomad" }`,被 API 的 Nomad discovery 查到。

### 7.4 添加 / 移除 Cluster

#### 添加

1. 往 `clusters` 表插一行(endpoint、token、tls、sandbox_proxy_domain)
2. team 绑定到它(`teams.cluster_id`)
3. 下次 `Pool` 同步(15s 内)就会加载

#### 移除

1. 删除 `teams.cluster_id` 引用
2. `GetActiveClusters` 就不再返回它
3. `Pool` 把它从内存移除并 close

---

## 八、Node 完整生命周期

### 8.1 Node 加入集群

#### Nomad-managed 节点(主集群)

```
1. 云 MIG/ASG 启动新 VM
       │
       ▼
2. start-client.sh 脚本配置 Nomad client
   (node_pool = build / orchestrator)
       │
       ▼
3. VM 加入 Nomad 集群
       │
       ▼
4. Nomad 调度 job
   ├─ orchestrator system job (orchestrator.hcl) 或
   └─ template-manager service job (template-manager.hcl)
       │
       ▼
5. orchestrator 进程启动
   ├─ 读 NODE_ID
   ├─ 监听 5008 端口
   └─ 注册 service{ name = "orchestrator" }
       │
       ▼
6. API 的 keepInSync() (20s 周期) 或
   getOrConnectNode() (按需) 发现该节点
       │
       ├─ listNomadNodes()
       │   └─ nodeDiscovery.ListNodes()
       │       └─ Nomad /v1/service/orchestrator
       │
       └─ connectToNode()
           ├─ nodemanager.New() 建 gRPC 连接
           ├─ 调 ServiceInfo 拿到真实 NodeID
           └─ registerNode()
               └─ 以 scopedNodeID(clusterID, nodeID) 为 key
                  存入 o.nodes map
       │
       ▼
7. 节点可调度
```

#### 远程 cluster 节点

```
1. 远程 cluster 自己的 edge API 发现节点
       │
       ▼
2. 主 API 的 Pool 每 15s 从数据库拉 cluster
   └─ newRemoteCluster() 创建 Cluster 对象
       │
       ▼
3. instancesSyncStore 每 5s 调
   RemoteServiceDiscovery.Query()
   (edge API /v1/service-discovery)
       │
       ▼
4. connectToClusterNode()
   └─ nodemanager.NewClusterNode()
       (复用 cluster 的 gRPC proxy 连接,不单独建连)
```

#### 两个 gap 的处理

文件:[`orchestrator/client.go:128-141`](../../packages/api/internal/orchestrator/client.go)

- **Gap 1**(0-5s cluster / 0-20s Nomad):节点在上游存在但还没被本地 sync 拉进 instance map
- **Gap 2**(0-20s):在 instance map 里但还没被 `keepInSync` 提升到 `o.nodes`

`getOrConnectNode()` 用 `discoveryGroup`(singleflight)按需触发一次 discovery,处理这两个 gap。

### 8.2 健康检查

**三层健康检查**:

#### Layer 1: Nomad service check

文件:[`iac/modules/job-orchestrator/jobs/orchestrator.hcl`](../../iac/modules/job-orchestrator/jobs/orchestrator.hcl)

```hcl
service {
  name = "orchestrator"
  check {
    type     = "http"
    path     = "/health"
    interval = "20s"
    timeout  = "5s"
  }
}
```

失败的 allocation 会被 Nomad 重启。

#### Layer 2: Instance Sync(5s)

文件:[`clusters/instance.go`](../../packages/api/internal/clusters/instance.go)

- 每 5s 调用 `InfoService.ServiceInfo` gRPC
- 连续失败 3 次(`maxSyncFailuresBeforeUnhealthy`)标记 `Unhealthy`

#### Layer 3: Node Sync(20s)

文件:[`nodemanager/sync.go`](../../packages/api/internal/orchestrator/nodemanager/sync.go)

- 每 20s 调 `ServiceInfo` + `Sandbox.List`
- 失败重试 4 次(`syncMaxRetries`)
- 全失败 `markUnhealthyLocal`
- 同时让 `sandbox.Store.Reconcile` 对账(发现孤儿 sandbox 清理)

#### 派生状态

文件:[`nodemanager/status.go:37-44`](../../packages/api/internal/orchestrator/nodemanager/status.go)

如果 gRPC 连接处于 `Shutdown`/`TransientFailure`/`Connecting`,即使 ServiceInfo 报 Healthy 也会显示 `Unhealthy`/`Connecting`。

### 8.3 Node 移除

#### 优雅 drain 流程

```
1. Admin 调用
   POST /nodes/{nodeId} { status: "draining" }
   (handlers/admin.go:49 PostNodesNodeID)
       │
       ▼
2. node.SendStatusChange(ctx, "draining")
   (nodemanager/status.go:75)
       │
       ▼
3. gRPC ServiceStatusOverride
   → orchestrator 的 ServiceInfo 设为 Draining
       │
       ▼
4. 调度器 sample() 跳过
   (Status() != NodeStatusReady 的节点)
   不再分配新 sandbox
       │
       ▼
5. 现有 sandbox 自然到期
   (被 evictor 处理)或被迁移
       │
       ▼
6. orchestrator 进程收到 SIGTERM
   ├─ Server.DrainSandboxes() (server/main.go:292)
   │   等待 live sandbox 清空
   └─ Server.Close()
       等在途 snapshot upload 完成
       │
       ▼
7. Nomad 注销 service 注册
   discovery 不再返回该节点
       │
       ▼
8. API 的 syncNode 发现节点不在 discovery 列表
   → deregisterNode
```

#### 强制移除

直接关 VM → discovery 20s 内丢失 → Instance sync 5s 内标记 unhealthy → Node sync 20s 内(4 次重试失败)deregister。

### 8.4 Node 下线时的 sandbox 处理

| 机制 | 文件 | 作用 |
|------|------|------|
| **evictor** | [`orchestrator/evictor/evict.go`](../../packages/api/internal/orchestrator/evictor/evict.go) | 50ms 轮询过期 sandbox,根据 `AutoPause` 决定 kill 还是 pause(快照) |
| **sandbox.Store.Reconcile** | `nodemanager/sync.go` | Node sync 时调 `GetSandboxes`,和本地 store 对账,发现孤儿 sandbox 清理 |
| **resume 重映射** | [`orchestrator/create_instance.go`](../../packages/api/internal/orchestrator/create_instance.go) `maybeRemapResumeOriginNode` | 如果 resume 因为原节点下线超时,把 snapshot 的 `origin_node_id` 改成实际 warm 的节点(`ResumeOriginNodeRemapFlag` 控制) |

---

## 九、Node 选择与调度

### 9.1 Sandbox 创建的节点选择

入口:[`orchestrator/create_instance.go:135`](../../packages/api/internal/orchestrator/create_instance.go) `Orchestrator.CreateSandbox()`

#### 调度决策树

```
CreateSandbox(sandboxRequest)
       │
       ▼
1. 确定 clusterID
   WithClusterFallback(team.ClusterID)
       │
       ▼
2. Resume affinity 检查
   isResume && sbxData.NodeID != nil ?
       │
       ├─ YES:优先尝试原节点(snapshot 在那)
       │       preferredNode = sbxData.NodeID
       │
       └─ NO:无偏好
       │
       ▼
3. GetClusterNodes(clusterID)
   拿出该 cluster 所有已连接节点
       │
       ▼
4. generateRequiredNodeLabels
   (如果开了 SandboxLabelBasedSchedulingFlag)
   合并 team.SandboxSchedulingLabels (默认 ["default"])
   + volume labels
       │
       ▼
5. PlaceSandbox(nodes, preferredNode, labels, ...)
   (placement/placement.go)
       │
       ▼
6. 调用 node.SandboxCreate() gRPC
       │
       ├─ 成功:OptimisticAdd + 返回
       ├─ ResourceExhausted:换节点
       └─ 其他错误:排除节点 + 重试
```

### 9.2 PlaceSandbox 流程

文件:[`placement/placement.go:43`](../../packages/api/internal/orchestrator/placement/placement.go)

最多 3 次重试(`maxRetries`):

1. 如果有 preferred node(resume),直接用它;否则 `algorithm.chooseNode()` 选一个
2. `node.SandboxCreate()` gRPC 调用
3. **成功**:`PlacementMetrics.Success` + `OptimisticAdd`(乐观增加资源占用),返回
4. **`ResourceExhausted`**:`PlacementMetrics.Skip`,排除该节点,换一个
5. **其他错误**:排除该节点 + `attempt++`,重试
6. **全失败**:返回错误(超时场景带 `WarmedNode` 给 resume 重映射)

### 9.3 Template Build 的节点选择

入口:[`template-manager/template_manager.go:111`](../../packages/api/internal/template-manager/template_manager.go) `TemplateManager.GetAvailableBuildClient()`

#### 调度逻辑

```
GetAvailableBuildClient(clusterID)
       │
       ▼
1. 拿到 cluster
       │
       ▼
2. 从 feature flag BuildNodeInfo 读期望的 CPU 信息
   (LaunchDarkly JSON flag)
       │
       ▼
3. cluster.GetAvailableTemplateBuilder(ctx, nodeInfo)
   (clusters/cluster.go:233)
       │
       ├─ 随机洗牌所有 instance (getRandomInstance)
       │  避免总是选同一个 builder
       │
       ├─ 过滤:Status == Healthy && IsBuilder
       │
       └─ CPU exact match
          (expectedInfo.IsExactMatch(machineInfo))
          build 要求确定性,不允许跨代兼容
       │
       ▼
4. 找不到 exact match?
   → fallback 到任意 builder (machineinfo.MachineInfo{})
```

### 9.4 调度算法:Best-of-K

实现:[`placement/placement_best_of_K.go`](../../packages/api/internal/orchestrator/placement/placement_best_of_K.go)

#### 配置(`BestOfKConfig`)

从 feature flag 读(每 30s 刷新):

| 参数 | 默认 | Flag | 含义 |
|------|------|------|------|
| `K` | 3 | `best-of-k-sample-size` | 采样数 |
| `R` | 4 | `best-of-k-max-overcommit`(存为 400%) | 集群级最大超卖比 |
| `Alpha` | 0.5 | `best-of-k-alpha`(存为 50%) | CPU usage 权重 |

#### 评分公式

```
reserved  = CpuAllocated + Σ(pendingCPUs)   // 已分配 + 正在创建中的
usageAvg  = CpuPercent / 100
totalCapacity = R * CpuCount

score = (cpuRequested + reserved + Alpha * usageAvg) / totalCapacity
```

**分数越低越好**(占用率低)。

#### 采样流程(`sample()`)

```
1. 从所有节点里随机选 K 个(无放回)
       │
       ▼
2. 过滤掉:
   ├─ excluded nodes (之前失败的)
   ├─ Status != Ready
   ├─ CPU 不兼容 (isNodeCPUCompatible)
   └─ label 不匹配 (isNodeLabelsCompatible)
       │
       ▼
3. 在候选里选 score 最低的
```

#### 算法特点

**这不是** round-robin,也**不是**纯 least-loaded,而是 **power-of-K-choices + fit-score** — 经典的分布式调度算法。

**为什么不用 least-loaded**:在分布式系统中,所有请求都涌向同一个 least-loaded 节点会导致**羊群效应**(thundering herd),反而过载。Best-of-K 随机采样 K 个再选最低分,既保证负载均衡,又避免羊群效应。

### 9.5 Build vs Sandbox 调度对比

| 维度 | Template Build | Sandbox |
|------|----------------|---------|
| **入口** | `GetAvailableBuildClient` | `CreateSandbox` → `PlaceSandbox` |
| **算法** | 随机洗牌 + CPU exact match | Best-of-K 评分 |
| **CPU 要求** | `IsExactMatch`(同 model,确定性) | `IsCompatibleWith`(允许跨代 resume) |
| **节点角色** | `IsBuilder`(template-manager) | `IsOrchestrator`(orchestrator) |
| **目的** | build 可重现 | 负载均衡 + 调度灵活 |

### 9.6 数据本地性(预留功能)

文件:[`orchestrator/pkg/scheduling/metadata.go`](../../packages/orchestrator/pkg/scheduling/metadata.go)

`FromHeaders()` 从 build 的 rootfs/memfile storage header 解析出引用的 build ID 链(最多 128,`chainLimit`),用于让 orchestrator 知道要预热哪些 build 的缓存。

配合 [`ListCachedBuilds`](../../packages/orchestrator/pkg/server/template_cache.go) gRPC,可以实现"优先调度到已经缓存了相关 build 的节点"。**当前没有**看到 API 端用它做调度决策,可能是预留给未来的 data-locality 调度。

---

## 十、Node 资源管理

### 10.1 资源限制(Feature Flag)

| Flag | 默认 | 含义 |
|------|------|------|
| `MaxSandboxesPerNode` | 200 | 每节点最大 sandbox 数 |
| `MaxStartingInstancesPerNode` | 3 | 每节点**并发**启动/恢复数,用 `AdjustableSemaphore` 实现 |
| `MaxConcurrentEvictions` | 256 | 全局并发驱逐上限 |

**`MaxStartingInstancesPerNode` 信号量**:

文件:[`server/main.go:117`](../../packages/orchestrator/pkg/server/main.go)

- 用 `AdjustableSemaphore` 实现(可动态调整大小)
- `refreshStartingSandboxesLimit` 每 30s 读 feature flag 调整
- 沙盒创建前 `Acquire(1)`,完成后 `Release(1)`
- 超过限制返回 `ResourceExhausted`,触发调度器换节点

### 10.2 资源上报

orchestrator 通过 `ServiceInfoResponse` gRPC 上报(见 [`service/service_info.go:70`](../../packages/orchestrator/pkg/service/service_info.go)):

| 类别 | 指标 |
|------|------|
| **已分配** | `MetricCpuAllocated`、`MetricMemoryAllocatedBytes`、`MetricDiskAllocatedBytes`(从 sandbox 配置累加) |
| **主机使用** | `MetricCpuPercent`、`MetricMemoryUsedBytes` |
| **主机总量** | `MetricCpuCount`、`MetricMemoryTotalBytes` |
| **HugePages** | `MetricHugepagesTotal/Used/Reserved`、`MetricHugepageSizeBytes` |
| **磁盘** | `MetricDisks`(每个 mount point) |
| **计数** | `MetricSandboxesRunning` |

API 端 `nodemanager.UpdateMetricsFromServiceInfoResponse()`(`metrics.go:35`)存入 `Node.metrics`。

### 10.3 乐观资源记账

由 `OptimisticResourceAccountingFlag`(默认 false)控制:

- **开启**:创建 sandbox 成功立即 `OptimisticAdd`(CpuAllocated += vcpu,MemoryAllocated += ram),不等下次 sync。避免连续调度时重复计入
- **关闭**:只依赖定期 sync 的 metrics

`OptimisticRemove` 有 underflow 保护(不会变成负数)。

### 10.4 HugePages 管理

Firecracker microVM 需要 hugepages 来分配 VM 内存。HugePages 在节点启动时预分配:

| Node Pool | 默认 hugepages | 原因 |
|-----------|----------------|------|
| build | 60% | build 时也要启动 VM,但占比可低 |
| client (orchestrator) | 80% | 主要工作就是跑 VM,需要大内存 |

预分配通过 `start-client.sh` + `BASE_HUGEPAGES_PERCENTAGE` 配置。

---

## 十一、Autoscaling 自动伸缩

### 11.1 云 MIG/ASG 自动伸缩

#### GCP

文件:[`iac/provider-gcp/nomad-cluster/worker-cluster/nodepool.tf:52`](../../iac/provider-gcp/nomad-cluster/worker-cluster/nodepool.tf)

```hcl
resource "google_compute_region_autoscaler" "..." {
  autoscaling_policy {
    cpu_utilization { target = var.cpu_target }       # 0-1
    metric {
      name = "agent.googleapis.com/memory/percent_used"
      target = var.memory_target                       # %
    }
  }
  mode = "ONLY_SCALE_OUT"   # 只扩不缩
}
```

**重要约束**(`nodepool.tf:86`):

```
memory_target > base_hugepages_percentage
```

因为 hugepages 预分配会被算作 used memory,如果 memory_target 太低会导致无限扩容。

#### AWS

文件:[`iac/provider-aws/modules/nodepool-client/main.tf:167`](../../iac/provider-aws/modules/nodepool-client/main.tf)

```hcl
resource "aws_autoscaling_group" "..." {
  min_size = var.cluster_size
  max_size = var.cluster_size   # 目前没开云层 autoscaler
}
```

AWS 目前靠 Nomad 层 autoscaler(见 11.2)。

### 11.2 Nomad autoscaler(template-manager)

文件:[`iac/modules/job-template-manager/jobs/template-manager.hcl:19-35`](../../iac/modules/job-template-manager/jobs/template-manager.hcl)

```hcl
scaling {
  enabled = true
  min     = 2
  max     = 10000  # Effectively unlimited

  policy {
    evaluation_interval = "10s"
    cooldown            = "2m"

    check "match_node_count" {
      source = "nomad-nodepool-apm"
      query  = "${node_pool}"

      strategy "pass-through" {}
    }
  }
}
```

**策略**:`pass-through` — 直接把 node count 作为目标 allocation count,让 template-manager allocation 数 = node pool 节点数。

**自定义 APM 插件**:[`packages/nomad-nodepool-apm/`](../../packages/nomad-nodepool-apm/)

部署:[`iac/modules/job-template-manager-autoscaler/`](../../iac/modules/job-template-manager-autoscaler/)(部署 nomad-autoscaler job + 插件)

### 11.3 ListCachedBuilds 与调度

文件:[`orchestrator/pkg/server/template_cache.go:14`](../../packages/orchestrator/pkg/server/template_cache.go)

返回节点缓存(`templateCache`,TTL 与 template 一致)的 build 列表 + 过期时间。

**当前状态**:API 端代码里只看到 gRPC 定义,调度路径走的是 Best-of-K + CPU/label,没有用 ListCachedBuilds 做调度决策。

**推测**:预留给未来的 data-locality 调度(配合 `scheduling/metadata.go` 解析的 build chain)。

---

## 十二、Nomad 集成

### 12.1 Nomad Job Spec

#### Orchestrator job

文件:[`iac/modules/job-orchestrator/jobs/orchestrator.hcl`](../../iac/modules/job-orchestrator/jobs/orchestrator.hcl)

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `type` | `"system"` | 每节点一个 allocation |
| `node_pool` | `"${node_pool}"` | 通常是 `orchestrator` |
| 端口 | `orchestrator` (5008)、`orchestrator-proxy` (5007) | 静态端口 |
| `constraint` | `meta.orchestrator_job_version == latest_orchestrator_job_id` | 版本滚动升级 |
| service | `orchestrator`(HTTP /health check)、`orchestrator-proxy`(TCP check) | Nomad-native service |
| driver | `raw_exec` | 直接执行二进制 |
| 关键 env | `NODE_ID = "${node.unique.name}"`、`NODE_IP`、`NODE_LABELS = "${meta.node_labels}"`、`GRPC_PORT`、`PROXY_PORT` | |

#### Template-manager job

文件:[`iac/modules/job-template-manager/jobs/template-manager.hcl`](../../iac/modules/job-template-manager/jobs/template-manager.hcl)

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `type` | `"service"` | 可 count > 1 |
| `count` | `"${current_count}"` | 从 Nomad state 读,被 autoscaler 控制 |
| `node_pool` | `"${node_pool}"` | 通常是 `build` |
| `constraint` | `distinct_hosts = true` | 每节点一个 |
| scaling | 内嵌 scaling policy | 见 [11.2](#112-nomad-autoscalertemplate-manager) |
| `update` | `max_parallel = 1` | 滚动更新 |
| `kill_timeout` | `"70m"` | 给 build 任务留时间 |
| 关键 env | `NODE_ID`、`NODE_LABELS`、`GRPC_PORT`、`FORCE_STOP` | |

### 12.2 Nomad Node Pool 发现

orchestrator 进程通过 `NODE_POOL`(写在 `start-client.sh` → Nomad client config `node_pool`)知道自己属于哪个池。

Nomad client 注册时带上 node_pool,API 通过:
- `/v1/nodes?NodePool=X`(旧,node-pool-based)
- `/v1/service/orchestrator`(新,service-based)

发现节点。

### 12.3 Nomad ↔ Consul

Consul 在 E2B 里主要做 **DNS 服务发现**(给 sandbox 内部用)。

orchestrator/template-manager 注册的是 **Nomad-native service**(`provider = "nomad"`),不走 Consul 服务目录。

Consul token/gossip key 在 `run-nomad.sh` 里配置,node_pool 名通过 Nomad client meta 暴露。

---

## 十三、Build Node Pool vs Client Node Pool

### 13.1 对比表

| 维度 | Build Node Pool | Client Node Pool (Orchestrator) |
|------|-----------------|----------------------------------|
| **跑什么** | template-manager(build 镜像) | orchestrator(运行 sandbox) |
| **Nomad node_pool 名(GCP)** | `build` | `orchestrator` |
| **Nomad node_pool 名(AWS)** | — | `client` |
| **Nomad job type** | `service`(count 可变,autoscaled) | `system`(每节点一个) |
| **Hugepages 默认** | 60% | 80% |
| **CPU 要求** | 确定性(exact match,build 可重现) | 兼容性(允许跨代 resume) |
| **是否开 autoscaler** | 是(nomad-nodepool-apm,match node count) | GCP 开云 MIG autoscaler(CPU/内存 target) |
| **服务发现名** | `template-manager` | `orchestrator` |
| **gRPC 角色** | `ServiceInfoRole_TemplateBuilder` | `ServiceInfoRole_Orchestrator` |
| **Job constraint** | `distinct_hosts`(每节点一个) | `meta.orchestrator_job_version` 匹配 |
| **资源特点** | 高 CPU、大磁盘(build 产物)、大量本地 SSD 缓存 | 大内存(hugepages,给 Firecracker VM)、网络带宽 |
| **persistent_volume_types** | `{}`(不需要) | `var.persistent_volume_types`(支持持久卷) |

### 13.2 为什么分开

- **资源 profile 不同**:build 是 CPU 密集 + 磁盘 IO 密集;client 是内存密集(hugepages 给 Firecracker)+ 网络密集
- **伸缩模式不同**:build 用 Nomad autoscaler(基于 node count);client 用云 MIG(基于 CPU/内存利用率)
- **升级策略不同**:build 滚动更新(`max_parallel=1`);client 用 `meta.orchestrator_job_version` 约束做版本滚动
- **物理隔离避免互相干扰**:build 的 CPU 峰值不会影响 production sandbox 的稳定性

---

## 十四、gRPC / REST 接口

### 14.1 gRPC 接口

#### orchestrator-info service

文件:[`packages/orchestrator/info.proto`](../../packages/orchestrator/info.proto)(生成代码在 `packages/shared/pkg/grpc/orchestrator-info/`)

| RPC | 请求 | 响应 | 用途 |
|-----|------|------|------|
| `ServiceInfo` | `Empty` | `ServiceInfoResponse` | 节点信息(NodeId、Status、Roles、MachineInfo、所有 metrics) |
| `ServiceStatusOverride` | `ServiceStatusChangeRequest` | `Empty` | 远程改节点状态(drain 用) |

#### orchestrator SandboxService

文件:[`packages/orchestrator/orchestrator.proto`](../../packages/orchestrator/orchestrator.proto)

| RPC | 用途 |
|-----|------|
| `Create` | 创建 sandbox(cold start 时 `Snapshot=false`;resume 时 `Snapshot=true`,从 snapshot 恢复) |
| `List` | 列出节点上的 sandbox(Node sync 用) |
| `Update` | 更新 sandbox 配置 |
| `Delete` | 删除 sandbox |
| `Pause` | 暂停 sandbox(做 snapshot) |
| `Checkpoint` | 给 sandbox 打快照(不停机) |
| `ListCachedBuilds` | 列出节点缓存的 build |

### 14.2 REST endpoint

#### Node 管理(Admin)

文件:[`packages/api/internal/handlers/admin.go`](../../packages/api/internal/handlers/admin.go)

| Method | Path | 用途 |
|--------|------|------|
| `GET` | `/nodes?cluster_id=` | 列节点(`AdminNodes`) |
| `GET` | `/nodes/{nodeId}?cluster_id=` | 节点详情(`AdminNodeDetail`) |
| `POST` | `/nodes/{nodeId}` | 改节点状态(`{status, cluster_id}`,用于触发 drain) |

### 14.3 ServiceInfoResponse 关键字段

```protobuf
message ServiceInfoResponse {
    string NodeId = 1;
    string ServiceId = 2;
    ServiceInfoStatus Status = 3;        // Healthy / Draining / Unhealthy / Standby
    repeated ServiceInfoRole Roles = 4;  // Orchestrator / TemplateBuilder
    MachineInfo MachineInfo = 5;
    // metrics ...
}
```

---

## 十五、配置与环境变量

### 15.1 Orchestrator 端环境变量

文件:[`packages/orchestrator/pkg/cfg/model.go`](../../packages/orchestrator/pkg/cfg/model.go)

| 变量 | 默认 | 作用 |
|------|------|------|
| `NODE_ID` | (必填) | 节点 ID,来自 Nomad `${node.unique.name}` |
| `NODE_IP` | `localhost` | 节点 IP,来自 `${attr.unique.network.ip-address}` |
| `NODE_LABELS` | (空) | 逗号分隔的 label,来自 Nomad `${meta.node_labels}` |
| `GRPC_PORT` | `5008` | gRPC 端口(= `OrchestratorAPIPort`) |
| `PROXY_PORT` | `5007` | sandbox 流量代理端口 |
| `ORCHESTRATOR_SERVICES` | `orchestrator` | 逗号分隔,决定角色(`orchestrator`/`template-manager`) |
| `ORCHESTRATOR_LOCK_PATH` | `/orchestrator.lock` | flock 文件,保证每节点一个 orchestrator |
| `PROVIDER` | `gcp` | 云厂商 |
| `DOMAIN_NAME` | (空) | |
| `ORCHESTRATOR_BASE_PATH` | `/orchestrator` | |
| `TEMPLATES_DIR` | `${ORCHESTRATOR_BASE_PATH}/build-templates` | |
| `SHARED_CHUNK_CACHE_PATH` | (空) | 共享 chunk 缓存(NFS) |
| `DEFAULT_CACHE_DIR` | `${ORCHESTRATOR_BASE_PATH}/build` | |
| `LOCAL_UPLOAD_BASE_URL` | (空) | 本地上传 URL |
| `FORCE_STOP` | `false` | template-manager 用,强制停止 |
| `DISABLE_STARTUP_RECLAIM` | `false` | |
| `PERSISTENT_VOLUME_MOUNTS` | (空) | map |

### 15.2 Cluster 配置(IaC 层)

| 变量 | 作用 |
|------|------|
| `BUILD_CLUSTERS_CONFIG` | JSON map,定义 build cluster(仅 GCP) |
| `CLIENT_CLUSTERS_CONFIG` | JSON map,定义 client cluster(仅 GCP) |
| `SERVER_MACHINE_TYPE` / `SERVER_CLUSTER_SIZE` | Nomad/Consul server |
| `API_MACHINE_TYPE` / `API_CLUSTER_SIZE` | API 节点 |
| `CLICKHOUSE_MACHINE_TYPE` / `CLICKHOUSE_CLUSTER_SIZE` | ClickHouse |

### 15.3 Nomad / Consul(节点启动脚本)

文件:[`iac/provider-gcp/nomad-cluster/scripts/run-nomad.sh`](../../iac/provider-gcp/nomad-cluster/scripts/run-nomad.sh)

节点启动时通过 `start-client.sh` → `run-nomad.sh` 配置:

| 变量 | 作用 |
|------|------|
| `NODE_POOL` | 写到 Nomad client config + meta |
| `CONSUL_TOKEN` | Consul ACL token |
| `CONSUL_GOSSIP_ENCRYPTION_KEY` | Consul gossip 加密 |
| `CONSUL_DNS_REQUEST_TOKEN` | Consul DNS 请求 token |
| `NOMAD_TOKEN` | Nomad ACL token |
| `BASE_HUGEPAGES_PERCENTAGE` | hugepages 预分配比例 |
| `NODE_LABELS` | 写到 Nomad node meta |
| `SET_ORCHESTRATOR_VERSION_METADATA` | 控制是否写 `meta.orchestrator_job_version` |
| `LOCAL_SSD`、`CACHE_DISK_COUNT` | 缓存盘配置 |

### 15.4 Discovery 相关

| 变量 | 作用 |
|------|------|
| `NOMAD_ORCHESTRATOR_LEGACY_DISCOVERY_ENABLED` | 启用旧的 node-pool-based discovery(过渡期) |
| `TESTS_ORCH_INSTANCE_HOST` | 本地开发用静态 host |

---

## 十六、Feature Flags

文件:[`packages/shared/pkg/featureflags/flags.go`](../../packages/shared/pkg/featureflags/flags.go)

### 16.1 节点资源限制

| Flag | 默认 | 作用 |
|------|------|------|
| `max-sandboxes-per-node` | 200 | 每节点最大 sandbox |
| `max-starting-instances-per-node` | 3 | 每节点并发启动数 |
| `max-concurrent-evictions` | 256 | 全局并发驱逐 |

### 16.2 调度算法

| Flag | 默认 | 作用 |
|------|------|------|
| `best-of-k-sample-size` | 3 | K(采样数) |
| `best-of-k-max-overcommit` | 400 (%) | R=4(集群级最大超卖比) |
| `best-of-k-alpha` | 50 (%) | Alpha=0.5(CPU usage 权重) |

### 16.3 调度开关

| Flag | 默认 | 作用 |
|------|------|------|
| `sandbox-label-based-scheduling` | false | 开 label 调度 |
| `sandbox-volume-label-based-scheduling` | false | 开 volume label 调度 |
| `sandbox-placement-optimistic-resource-accounting` | false | 乐观资源记账 |
| `resume-origin-node-remap` | false | resume origin 重映射 |

### 16.4 Build 节点

| Flag | 默认 | 作用 |
|------|------|------|
| `preferred-build-node` | (空 JSON) | 期望的 build node CPU(LaunchDarkly JSON flag,Go 端引用为 `BuildNodeInfo`) |

---

## 十七、关键代码文件索引

### 17.1 共享层

| 文件 | 作用 |
|------|------|
| [`packages/shared/pkg/consts/cluster.go`](../../packages/shared/pkg/consts/cluster.go) | `LocalClusterID = uuid.Nil` |
| [`packages/shared/pkg/consts/sandboxes.go`](../../packages/shared/pkg/consts/sandboxes.go) | `NodeIDLength=8`、`OrchestratorAPIPort=5008`、`ClientID` |
| [`packages/shared/pkg/clusters/cluster.go`](../../packages/shared/pkg/clusters/cluster.go) | `WithClusterFallback()` 兜底函数 |
| [`packages/shared/pkg/clusters/discovery/nomad.go`](../../packages/shared/pkg/clusters/discovery/nomad.go) | 共享 Nomad allocation 发现 |
| [`packages/shared/pkg/machineinfo/machine_info.go`](../../packages/shared/pkg/machineinfo/machine_info.go) | CPU 兼容性(`IsCompatibleWith`/`IsExactMatch` + `compatibleNodeModels` 跨代表) |
| [`packages/shared/pkg/env/env.go`](../../packages/shared/pkg/env/env.go) | `GetNodeID()` 读 `NODE_ID` |
| [`packages/shared/pkg/featureflags/flags.go`](../../packages/shared/pkg/featureflags/flags.go) | 所有 node 相关 feature flag |

### 17.2 数据库

| 文件 | 作用 |
|------|------|
| [`packages/db/migrations/20250606213446_deployment_cluster.sql`](../../packages/db/migrations/20250606213446_deployment_cluster.sql) | 创建 `clusters` 表 + `teams.cluster_id` |
| [`packages/db/migrations/20250624001048_cluster_for_templates.sql`](../../packages/db/migrations/20250624001048_cluster_for_templates.sql) | `envs.cluster_id` |
| [`packages/db/migrations/20250624001049_cluster_for_builds.sql`](../../packages/db/migrations/20250624001049_cluster_for_builds.sql) | `env_builds.cluster_node_id` |
| [`packages/db/migrations/20250708135401_snapshot_pause_node_id.sql`](../../packages/db/migrations/20250708135401_snapshot_pause_node_id.sql) | `snapshots.origin_node_id` |
| [`packages/db/migrations/20260228120000_snapshot_template_origin_node.sql`](../../packages/db/migrations/20260228120000_snapshot_template_origin_node.sql) | `snapshot_templates.origin_node_id` |
| [`packages/db/migrations/20260423170000_cluster_auth_org_id.sql`](../../packages/db/migrations/20260423170000_cluster_auth_org_id.sql) | `clusters.auth_org_id` |
| [`packages/db/migrations/20260609120000_cluster_name.sql`](../../packages/db/migrations/20260609120000_cluster_name.sql) | `clusters.name` |
| [`packages/db/queries/get_active_clusters.sql`](../../packages/db/queries/get_active_clusters.sql) | `GetActiveClusters`(JOIN teams) |

### 17.3 API Cluster 层

| 文件 | 作用 |
|------|------|
| [`packages/api/internal/clusters/cluster.go`](../../packages/api/internal/clusters/cluster.go) | `Cluster` struct、`GetAvailableTemplateBuilder()`、`newLocalCluster/newRemoteCluster` |
| [`packages/api/internal/clusters/clusters_sync.go`](../../packages/api/internal/clusters/clusters_sync.go) | `Pool`、15s DB 同步 |
| [`packages/api/internal/clusters/instances_sync.go`](../../packages/api/internal/clusters/instances_sync.go) | `instancesSyncStore`、5s discovery 同步 |
| [`packages/api/internal/clusters/instance.go`](../../packages/api/internal/clusters/instance.go) | `Instance`、`Sync()`、健康检查 |
| [`packages/api/internal/clusters/client.go`](../../packages/api/internal/clusters/client.go) | gRPC 客户端工厂、`instanceAuthorization`(edge proxy 鉴权) |
| [`packages/api/internal/clusters/resources.go`](../../packages/api/internal/clusters/resources.go) | metrics/logs 资源接口 |
| [`packages/api/internal/clusters/resources_local.go`](../../packages/api/internal/clusters/resources_local.go) | Local cluster 资源(ClickHouse + Loki) |
| [`packages/api/internal/clusters/resources_remote.go`](../../packages/api/internal/clusters/resources_remote.go) | Remote cluster 资源(edge API) |
| [`packages/api/internal/clusters/discovery/local.go`](../../packages/api/internal/clusters/discovery/) | `LocalServiceDiscovery`(Nomad allocations) |
| [`packages/api/internal/clusters/discovery/remote.go`](../../packages/api/internal/clusters/discovery/) | `RemoteServiceDiscovery`(edge API) |
| [`packages/api/internal/clusters/discovery/kubernetes.go`](../../packages/api/internal/clusters/discovery/) | K8s pod 发现 |

### 17.4 API Node Manager 层

| 文件 | 作用 |
|------|------|
| [`packages/api/internal/orchestrator/nodemanager/node.go`](../../packages/api/internal/orchestrator/nodemanager/node.go) | `Node` struct、`New`/`NewClusterNode`、`OptimisticAdd/Remove` |
| [`packages/api/internal/orchestrator/nodemanager/sync.go`](../../packages/api/internal/orchestrator/nodemanager/sync.go) | `Node.Sync()` + sandbox 对账 |
| [`packages/api/internal/orchestrator/nodemanager/status.go`](../../packages/api/internal/orchestrator/nodemanager/status.go) | 状态机 + `SendStatusChange`(drain) |
| [`packages/api/internal/orchestrator/nodemanager/metrics.go`](../../packages/api/internal/orchestrator/nodemanager/metrics.go) | `Metrics` + `UpdateMetricsFromServiceInfoResponse` |
| [`packages/api/internal/orchestrator/nodemanager/placement_metrics.go`](../../packages/api/internal/orchestrator/nodemanager/placement_metrics.go) | `PlacementMetrics`(in-progress 跟踪) |
| [`packages/api/internal/orchestrator/nodemanager/labels.go`](../../packages/api/internal/orchestrator/nodemanager/labels.go) | node labels(默认 `default`) |
| [`packages/api/internal/orchestrator/nodemanager/metadata.go`](../../packages/api/internal/orchestrator/nodemanager/metadata.go) | `NodeMetadata` + gRPC metadata 注入 |
| [`packages/api/internal/orchestrator/nodemanager/client.go`](../../packages/api/internal/orchestrator/nodemanager/client.go) | `NewClient()` gRPC 连接 |

### 17.5 API Orchestrator 管理层

| 文件 | 作用 |
|------|------|
| [`packages/api/internal/orchestrator/orchestrator.go`](../../packages/api/internal/orchestrator/orchestrator.go) | `Orchestrator` struct 主入口 |
| [`packages/api/internal/orchestrator/client.go`](../../packages/api/internal/orchestrator/client.go) | `connectToNode`/`connectToClusterNode`/`getOrConnectNode`/`scopedNodeID` |
| [`packages/api/internal/orchestrator/cache.go`](../../packages/api/internal/orchestrator/cache.go) | `keepInSync` 20s 同步循环 |
| [`packages/api/internal/orchestrator/create_instance.go`](../../packages/api/internal/orchestrator/create_instance.go) | `CreateSandbox` 调度入口 + `maybeRemapResumeOriginNode` |
| [`packages/api/internal/orchestrator/routing.go`](../../packages/api/internal/orchestrator/routing.go) | sandbox 路由表注册 |
| [`packages/api/internal/orchestrator/evictor/evict.go`](../../packages/api/internal/orchestrator/evictor/evict.go) | 超时 sandbox 驱逐 |
| [`packages/api/internal/orchestrator/discovery/discovery.go`](../../packages/api/internal/orchestrator/discovery/discovery.go) | orchestrator-side `Discovery` interface |
| [`packages/api/internal/orchestrator/discovery/nomad.go`](../../packages/api/internal/orchestrator/discovery/nomad.go) | 新:Nomad service-based |
| [`packages/api/internal/orchestrator/discovery/nomad_node_pool.go`](../../packages/api/internal/orchestrator/discovery/nomad_node_pool.go) | 旧:Nomad node-pool-based fallback |
| [`packages/api/internal/orchestrator/discovery/merged.go`](../../packages/api/internal/orchestrator/discovery/merged.go) | union 去重 |

### 17.6 调度算法

| 文件 | 作用 |
|------|------|
| [`packages/api/internal/orchestrator/placement/placement.go`](../../packages/api/internal/orchestrator/placement/placement.go) | `PlaceSandbox` 入口 + `Algorithm` interface |
| [`packages/api/internal/orchestrator/placement/placement_best_of_K.go`](../../packages/api/internal/orchestrator/placement/placement_best_of_K.go) | Best-of-K 实现 + `Score` 公式 |
| [`packages/api/internal/orchestrator/placement/cpu_compatibility.go`](../../packages/api/internal/orchestrator/placement/cpu_compatibility.go) | build CPU 兼容 |
| [`packages/api/internal/orchestrator/placement/label_compatibility.go`](../../packages/api/internal/orchestrator/placement/label_compatibility.go) | label 兼容 |

### 17.7 Orchestrator 服务端

| 文件 | 作用 |
|------|------|
| [`packages/orchestrator/pkg/service/info.go`](../../packages/orchestrator/pkg/service/info.go) | `ServiceInfo` container + `serviceRolesMapper` |
| [`packages/orchestrator/pkg/service/service_info.go`](../../packages/orchestrator/pkg/service/service_info.go) | `ServiceInfo` gRPC server(metrics 上报) |
| [`packages/orchestrator/pkg/service/machineinfo/main.go`](../../packages/orchestrator/pkg/service/machineinfo/main.go) | CPU 检测 |
| [`packages/orchestrator/pkg/server/main.go`](../../packages/orchestrator/pkg/server/main.go) | orchestrator server + `DrainSandboxes` + `MaxStartingInstancesPerNode` 信号量 |
| [`packages/orchestrator/pkg/server/template_cache.go`](../../packages/orchestrator/pkg/server/template_cache.go) | `ListCachedBuilds` gRPC |
| [`packages/orchestrator/pkg/scheduling/metadata.go`](../../packages/orchestrator/pkg/scheduling/metadata.go) | build chain 解析(数据本地性元数据) |
| [`packages/orchestrator/pkg/cfg/model.go`](../../packages/orchestrator/pkg/cfg/model.go) | orchestrator 所有环境变量 |
| [`packages/orchestrator/pkg/cfg/service.go`](../../packages/orchestrator/pkg/cfg/service.go) | `ServiceType` 枚举 |
| [`packages/orchestrator/pkg/factories/run.go`](../../packages/orchestrator/pkg/factories/run.go) | orchestrator 启动主流程 |

### 17.8 Nomad 插件

| 文件 | 作用 |
|------|------|
| [`packages/nomad-nodepool-apm/main.go`](../../packages/nomad-nodepool-apm/main.go) | 自定义 autoscaler APM |
| [`packages/nomad-nodepool-apm/plugin/plugin.go`](../../packages/nomad-nodepool-apm/plugin/plugin.go) | 插件实现 |

### 17.9 IaC

| 文件 | 作用 |
|------|------|
| [`iac/provider-gcp/nomad-cluster/main.tf`](../../iac/provider-gcp/nomad-cluster/main.tf) | GCP nomad 集群主入口(build_cluster + client_cluster 模块) |
| [`iac/provider-gcp/nomad-cluster/worker-cluster/nodepool.tf`](../../iac/provider-gcp/nomad-cluster/worker-cluster/nodepool.tf) | GCP 节点池(MIG + autoscaler + instance template) |
| [`iac/provider-aws/modules/nodepool-client/main.tf`](../../iac/provider-aws/modules/nodepool-client/main.tf) | AWS client 节点池(ASG + launch template) |
| [`iac/modules/job-orchestrator/jobs/orchestrator.hcl`](../../iac/modules/job-orchestrator/jobs/orchestrator.hcl) | orchestrator Nomad job spec |
| [`iac/modules/job-template-manager/jobs/template-manager.hcl`](../../iac/modules/job-template-manager/jobs/template-manager.hcl) | template-manager Nomad job spec(含 scaling policy) |
| [`iac/modules/job-template-manager-autoscaler/`](../../iac/modules/job-template-manager-autoscaler/) | nomad-autoscaler 部署 |
| [`iac/provider-gcp/nomad-cluster/scripts/run-nomad.sh`](../../iac/provider-gcp/nomad-cluster/scripts/run-nomad.sh) | 节点启动脚本(配置 Nomad client + node_pool) |

### 17.10 配置模板与文档

| 文件 | 作用 |
|------|------|
| [`.env.gcp.template`](../../.env.gcp.template) | `BUILD_CLUSTERS_CONFIG`/`CLIENT_CLUSTERS_CONFIG` 示例 |
| [`self-host.md`](../../self-host.md) | 自托管文档 |
| [`DEV-LOCAL.md`](../../DEV-LOCAL.md) | 本地开发文档 |

---

## 十八、设计要点与演进

### 18.1 两套 Discovery interface 的区别(容易混淆)

代码里有**两套** `Discovery` interface:

#### 第一套:cluster 层

文件:[`packages/api/internal/clusters/discovery/discovery.go`](../../packages/api/internal/clusters/discovery/)

- 给 **cluster 内的 Instance**(template-builder/orchestrator 服务实例)用
- `Query() → []Item`,Item 含 `InstanceID`(每次重启变化)
- 实现:`LocalServiceDiscovery`/`RemoteServiceDiscovery`/`KubernetesServiceDiscovery`/`StaticServiceDiscovery`

#### 第二套:orchestrator 层

文件:[`packages/api/internal/orchestrator/discovery/discovery.go`](../../packages/api/internal/orchestrator/discovery/discovery.go)

- 给 **Nomad-managed orchestrator 节点**用
- `ListNodes() → []Node`,Node 含 `ShortID`(稳定,8 字符)
- 实现:`nomadDiscovery`/`nomadNodePoolDiscovery`/`mergedDiscovery`

**使用关系**:`Orchestrator` 用第二套,`Cluster`/`Pool` 用第一套。

### 18.2 Node 的两套结构体

| 结构体 | 文件 | 侧重 |
|--------|------|------|
| `clusters.Instance` | [`instance.go`](../../packages/api/internal/clusters/instance.go) | 连接管理 + 角色(builder/orchestrator) + sync 健康检查 |
| `nodemanager.Node` | [`node.go`](../../packages/api/internal/orchestrator/nodemanager/node.go) | metrics + placement + status |

`NewClusterNode()` 把 `Instance` 转成 `Node`(复用 Instance 的 gRPC client,不重新建连)。

### 18.3 NodeID 用 hostname 而非 UUID 的历史原因

代码注释:

> for historical reasons and better DX, so we can easily map Nomad nodes to cloud instances

用 `v.NodeName`(云主机名)作为 NodeID,而不是 Nomad client UUID。好处:
- 在云控制台/GCP Console 直接能看到对应实例
- 排查问题时 hostname 比 UUID 友好

### 18.4 Best-of-K 而非 least-loaded 的原因

**least-loaded 的问题**:在分布式系统中,所有请求都涌向同一个 least-loaded 节点会导致**羊群效应**(thundering herd)。

**Best-of-K 的优势**:
- 随机采样 K 个,减少协调开销(不需要全局视图)
- 选最低分,保证负载均衡
- 避免羊群效应

### 18.5 CPU 兼容性的非对称设计

**为什么非对称**(只允许旧 → 新):

- 新 CPU 有旧 CPU 没有的指令集
- 在新 CPU 上 build 的 sandbox 可能用了新指令
- 拿到旧 CPU 上 resume 会因指令不存在而崩溃
- 反过来,旧 CPU 上 build 的 sandbox 不会用新指令,可以在新 CPU 上 resume

**硬编码的兼容矩阵**(`compatibleNodeModels`):
- 当前只允许 `IceLake (106) → EmeraldRapids (207)`
- 添加新机型需要改代码(没有动态配置)

### 18.6 远程 cluster 的 gRPC 路由

远程 cluster 的 gRPC 请求要走 edge proxy,需要两个 HTTP header:

| Header | 作用 |
|--------|------|
| `EdgeRpcAuthHeader` | 共享密钥(来自 `clusters.token`) |
| `EdgeRpcServiceInstanceIDHeader` | 目标 Instance ID,edge proxy 据此路由到具体节点 |

实现:[`clusters/client.go`](../../packages/api/internal/clusters/client.go) `instanceAuthorization`。

### 18.7 Discovery 的过渡期(新 + 旧并存)

**为什么有两套 Nomad discovery**:

- 旧的 jobspec 注册的 service Address 为空,所以需要 node-pool-based fallback
- 新 jobspec 修复了这个问题,可以用 service-based

**过渡策略**:`NewMerged` union 两套结果,按 ShortID 去重(primary 赢)。等所有 jobspec 都升级后,可以通过 `NOMAD_ORCHESTRATOR_LEGACY_DISCOVERY_ENABLED=false` 关闭旧的。

### 18.8 优雅 drain 的多阶段

drain 不是立即下线,而是:
1. 标记 Draining(调度器跳过)
2. 等现有 sandbox 自然到期(或被 evictor 清理)
3. SIGTERM 后 `DrainSandboxes` 等 live sandbox 清空
4. `Close` 等在途 snapshot upload 完成
5. Nomad 注销 service

每个阶段都有合理的等待,避免数据丢失。

---

## 十九、常见问题与排查

### 19.1 节点不被调度

**症状**:sandbox 创建时报 "no available nodes"

**排查**:

1. 检查节点状态:`GET /nodes?cluster_id=<cluster_id>`,确认有 `ready` 状态的节点
2. 检查节点角色:确认有 `Orchestrator` 角色的节点(template-manager 节点不能跑 sandbox)
3. 检查 CPU 兼容性:resume 场景下,build CPU 必须兼容 node CPU
4. 检查 label 匹配:如果开了 label-based scheduling,确认节点有 required labels
5. 检查资源:确认节点没达到 `MaxSandboxesPerNode` 或 `MaxStartingInstancesPerNode`

### 19.2 节点状态显示 Unhealthy

**症状**:节点状态变成 `unhealthy`

**排查**:

1. 检查 orchestrator 进程是否运行:`nomad alloc-status <alloc_id>`
2. 检查 gRPC 端口可达性:`telnet <node_ip> 5008`
3. 检查 Nomad service check:`nomad service info orchestrator`
4. 查 orchestrator 日志:`nomad alloc-logs <alloc_id>`
5. 确认 Node sync:Node sync 每 20s 一次,失败重试 4 次才标记 unhealthy,所以短暂网络抖动不会立即 unhealthy

### 19.3 Build 一直找不到合适节点

**症状**:template build 失败,提示 "no available builder"

**排查**:

1. 检查是否有 `IsBuilder` 角色的节点(template-manager)
2. 检查 CPU exact match:feature flag `preferred-build-node` 设的 CPU model 必须有节点匹配
3. 检查节点 healthy 状态
4. 临时方案:清空 `preferred-build-node` flag(fallback 到任意 builder)

### 19.4 Sandbox resume 失败

**症状**:resume sandbox 报 CPU 不兼容

**排查**:

1. 检查 build CPU model(`env_builds.cpu_model`)
2. 检查目标节点 CPU model
3. 确认在 `compatibleNodeModels` 兼容矩阵里(目前只有 IceLake → EmeraldRapids)
4. 如果原节点下线,确认 `resume-origin-node-remap` flag 开启(允许重映射到 warm 的节点)

### 19.5 节点 drain 后 sandbox 不结束

**症状**:节点 drain 后,sandbox 长时间不结束

**排查**:

1. 检查 evictor 是否运行(50ms 轮询)
2. 检查 sandbox 的 end time(是否到了驱逐时间)
3. 检查 `AutoPause` 设置(决定 kill 还是 pause)
4. 手动 kill:`DELETE /sandboxes/{id}`

### 19.6 Remote cluster 节点列表为空

**症状**:Remote cluster 的节点不出现在 `GET /nodes`

**排查**:

1. 检查 `clusters` 表的 endpoint/token 是否正确
2. 检查 edge API 是否可达:`curl https://<endpoint>/v1/service-discovery`
3. 检查 `Pool` 同步状态(15s 一次)
4. 检查 `instancesSyncStore` 同步状态(5s 一次)
5. 查看 API 日志中的 discovery 错误

### 19.7 Autoscaler 不工作

**症状**:template-manager 数量不随节点数变化

**排查**:

1. 检查 nomad-autoscaler 是否运行:`nomad job status template-manager-autoscaler`
2. 检查 scaling policy 是否注册:`nomad scaling-policy list`
3. 检查 `nomad-nodepool-apm` 插件是否加载
4. 查看 autoscaler 日志:`nomad alloc-logs <autoscaler_alloc_id>`

### 19.8 Hugepages 不足

**症状**:sandbox 启动失败,提示 "Cannot allocate memory" 或 hugepage 相关错误

**排查**:

1. 检查节点 hugepages:`cat /proc/meminfo | grep Huge`
2. 确认 `BASE_HUGEPAGES_PERCENTAGE` 配置正确(build 默认 60%,client 默认 80%)
3. 重启节点让 hugepages 重新分配
4. 检查 GCP autoscaler 的 `memory_target > base_hugepages_percentage` 约束

---

## 附录 A:常用 SQL 查询

### A.1 查看所有 cluster

```sql
SELECT
    c.id,
    c.name,
    c.endpoint,
    c.endpoint_tls,
    c.sandbox_proxy_domain,
    c.auth_org_id,
    COUNT(t.id) AS team_count
FROM clusters c
LEFT JOIN teams t ON t.cluster_id = c.id
GROUP BY c.id
ORDER BY team_count DESC;
```

### A.2 查看每个 cluster 的 template 数

```sql
SELECT
    c.id AS cluster_id,
    c.name AS cluster_name,
    COUNT(e.id) AS template_count
FROM clusters c
LEFT JOIN envs e ON e.cluster_id = c.id
WHERE e.deleted_at IS NULL
GROUP BY c.id, c.name
ORDER BY template_count DESC;
```

### A.3 查看每个 build 在哪个 node 上跑

```sql
SELECT
    eb.id AS build_id,
    eb.cluster_node_id,
    eb.status_group,
    eb.cpu_model_name,
    eb.created_at
FROM env_builds eb
WHERE eb.team_id = @team_id
ORDER BY eb.created_at DESC
LIMIT 50;
```

### A.4 查看 snapshot 的 origin node

```sql
SELECT
    s.id AS snapshot_id,
    s.sandbox_id,
    s.origin_node_id,
    s.base_env_id,
    s.created_at
FROM snapshots s
WHERE s.team_id = @team_id
ORDER BY s.created_at DESC;
```

---

## 附录 B:Debug 工具

### B.1 查看 Nomad 节点池

```bash
# 列出所有 Nomad 节点及其 node pool
nomad node status -verbose

# 按节点池过滤
nomad operator api '/v1/nodes?Filter=Status==ready and NodePool=="orchestrator"'
```

### B.2 查看 Nomad service

```bash
# 列出 orchestrator service 实例
nomad operator api '/v1/service/orchestrator'

# 列出 template-manager service 实例
nomad operator api '/v1/service/template-manager'
```

### B.3 触发节点 drain

```bash
# 通过 Admin API
curl -X POST https://api.<your-domain>/nodes/<node_id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"status": "draining", "cluster_id": "<cluster_uuid>"}'
```

### B.4 查看 ServiceInfo gRPC

```bash
# 用 grpcurl 直接调
grpcurl -plaintext <node_ip>:5008 orchestrator-info.InfoService/ServiceInfo
```

### B.5 查看 autoscaler 状态

```bash
# 列出 scaling policies
nomad scaling-policy list

# 查看 autoscaler job
nomad job status template-manager-autoscaler

# 查看 template-manager 的 scaling 事件
nomad operator api '/v1/jobs/template-manager/scale'
```

---

## 附录 C:术语表

| 术语 | 含义 |
|------|------|
| Cluster | 一组节点的逻辑分组(local / remote) |
| Node | 一台运行 orchestrator 或 template-manager 的 VM |
| Node Pool | Nomad 原生概念,按用途划分节点(build / orchestrator / api) |
| Instance | discovery 发现到的服务实例(对应一个进程) |
| LocalClusterID | `uuid.Nil`,代表本地集群 |
| NodeID | 节点 ID,来自云主机 hostname(`${node.unique.name}`) |
| ShortID | NodeID 截断到前 8 字符 |
| scopedNodeID | `<clusterID>-<nodeID>`,跨集群唯一 key |
| Service Instance ID | 每次进程重启都变的 UUID |
| Orchestrator | 运行 Firecracker sandbox 的节点/进程 |
| TemplateBuilder / Template Manager | 构建 template 镜像的节点/进程 |
| Best-of-K | 调度算法:随机采样 K 个节点选最低分 |
| IceLake / EmeraldRapids | Intel CPU 代际(model 106 / 207) |
| HugePages | 大页内存,Firecracker VM 需要 |
| Drain | 节点优雅下线 |
| Evictor | 驱逐超时 sandbox 的组件 |
| Edge API | 远程 cluster 的代理入口 |
| Nomad APM | Autoscaler Plugin 的 metric source |

---

**文档版本**:基于代码库 HEAD(2026-07-10)

**维护**:如有疑问或发现文档过期,请对照 [`packages/api/internal/clusters/`](../../packages/api/internal/clusters/) 和 [`packages/api/internal/orchestrator/`](../../packages/api/internal/orchestrator/) 的最新代码核对。
