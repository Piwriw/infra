# 节点、Sandbox 与 Template 构建调度策略

**Sandbox 的常规选点采用 Best-of-K：随机抽取符合条件的节点，再选 CPU 评分最低者。Template 构建采用健康 builder 随机选点，并支持可回退的 CPU 型号偏好。** 两者共用部分节点发现能力，但没有共用负载评分器。依据：[Sandbox 选点:93](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L93)、[Builder 选点:215](../packages/api/internal/clusters/cluster.go#L215)、[构建 CPU 偏好及回退:111](../packages/api/internal/template-manager/template_manager.go#L111)。

本文基于仓库提交 `93113e5eb`，整理日期为 2026-09-05；分析前已阅读 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。下文区分数据库配置、API 选点、节点接收限制与基础设施部署策略。Feature Flag 数值均指代码中的回退值；线上 Flag、数据库记录及实际部署状态**未确认**。源码行号对应上述提交。

## 1. 调度层次与两类任务对照

| 维度 | Sandbox 创建／恢复 | Template 构建 | 源码依据 |
|---|---|---|---|
| 集群范围 | 取请求团队的 `cluster_id`，只从该集群的 Node 列表选点 | 取请求团队的 `cluster_id`，只从该集群的 Instance 列表选 builder | [create_instance.go:310](../packages/api/internal/orchestrator/create_instance.go#L310)、[template_start_build_v2.go:137](../packages/api/internal/handlers/template_start_build_v2.go#L137) |
| 未指定集群 | `cluster_id = nil` 回退到本地逻辑集群；显式指定的集群不可用时，没有跨集群搜索 | 同左；builder 的 CPU 偏好回退也仍在原集群内 | [集群回退:9](../packages/shared/pkg/clusters/cluster.go#L9)、[LocalClusterID:5](../packages/shared/pkg/consts/cluster.go#L5)、[GetClusterNodes:236](../packages/api/internal/orchestrator/client.go#L236)、[构建回退:128](../packages/api/internal/template-manager/template_manager.go#L128) |
| 候选节点 | 常规路径要求 `Ready`、CPU 兼容、满足已启用的标签条件、未被本次请求排除 | 要求 `Healthy` 且具有 `TemplateBuilder` 角色；第一轮可附加 CPU 精确匹配 | [placement_best_of_K.go:167](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L167)、[cluster.go:238](../packages/api/internal/clusters/cluster.go#L238) |
| 选点算法 | 默认从最多 3 个合格随机样本中选 CPU 评分最低者；恢复可优先尝试原节点 | 打乱节点列表，返回第一个符合条件者；不比较 CPU／内存占用和在建任务数 | [Sandbox 评分选择:98](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L98)、[恢复优先:310](../packages/api/internal/orchestrator/create_instance.go#L310)、[builder 随机选择:215](../packages/api/internal/clusters/cluster.go#L215) |
| 请求规格的作用 | `env_builds.vcpu`、`ram_mb`、`total_disk_size_mb` 传给节点；其中 vCPU 参与评分 | build 的 vCPU、RAM、空闲磁盘规格传给已选定的 builder；选点函数不接收这些规格 | [Sandbox 请求:275](../packages/api/internal/orchestrator/create_instance.go#L275)、[构建请求:166](../packages/api/internal/handlers/template_start_build_v2.go#L166)、[GetAvailableBuildClient:111](../packages/api/internal/template-manager/template_manager.go#L111) |
| 失败后重新选点 | 有请求内重试；`ResourceExhausted` 与其他错误的计数方式不同，见第 3 节 | 发起构建及轮询使用已保存的 node ID；这些路径未实现自动换节点重建 | [placement.go:134](../packages/api/internal/orchestrator/placement/placement.go#L134)、[CreateTemplate:91](../packages/api/internal/template-manager/create_template.go#L91)、[GetStatus:217](../packages/api/internal/template-manager/template_manager.go#L217) |
| 团队额度 | 在选点前预留团队 Sandbox 并发额度，超限返回 HTTP 429 | 登记 build 时查询团队构建并发，超限返回 HTTP 429；此查询不是节点容量预留 | [团队 Sandbox 预留:153](../packages/api/internal/orchestrator/create_instance.go#L153)、[构建并发校验:73](../packages/api/internal/template/register_build.go#L73) |

团队的 tier、addon 与规格校验另见 [Tier、用户与团队配额规则](./tier-user-team-rules.md)。本文关注上述额度通过之后，任务如何落到节点。

## 2. 节点模型、发现与健康状态

### 2.1 身份及调度输入

| 对象／字段 | 来源与用途 | 是否直接决定选点 | 源码依据 |
|---|---|---|---|
| `Cluster` | 逻辑集群，包含服务实例及访问资源；本地集群 ID 为全零 UUID，远端集群通过 endpoint 连接 | 限定搜索范围 | [cluster.go:39](../packages/api/internal/clusters/cluster.go#L39)、[本地集群:37](../packages/api/internal/clusters/clusters_sync.go#L37)、[远端连接:141](../packages/api/internal/clusters/cluster.go#L141) |
| `clusters.Instance` | 缓存 `NodeID`、`serviceInstanceID`、角色、健康状态、机器 CPU 信息；builder 直接从此池选择 | 是，builder 的候选依据 | [instance.go:30](../packages/api/internal/clusters/instance.go#L30)、[同步角色与 CPU:161](../packages/api/internal/clusters/instance.go#L161) |
| `nodemanager.Node` | API 管理的 Sandbox 节点：连接、状态、标签、指标，以及本 API 进程内正在分配的资源记录 | 是，Best-of-K 的候选依据；多集群 map key 带集群作用域 | [node.go:98](../packages/api/internal/orchestrator/nodemanager/node.go#L98)、[集群节点包装:139](../packages/api/internal/orchestrator/nodemanager/node.go#L139)、[scopedNodeID:89](../packages/api/internal/orchestrator/client.go#L89) |
| 发现层 ShortID／进程实例 ID | Nomad 发现使用截短的 Nomad node UUID，K8s 发现使用完整 Pod 名；`ServiceInfo` 另外报告节点 ID 与进程实例 ID | 不应把这些 ID 当成同一个字段；远端 gRPC 用进程实例 ID 路由，进程更换还参与缓存失效判断 | [Nomad ShortID:74](../packages/api/internal/orchestrator/discovery/nomad.go#L74)、[K8s ShortID:67](../packages/api/internal/orchestrator/discovery/kubernetes.go#L67)、[ServiceInfo:70](../packages/orchestrator/pkg/service/service_info.go#L70)、[实例失效:182](../packages/api/internal/orchestrator/cache.go#L182) |
| `ServiceInfo.roles` | 由启用的服务映射为 `Orchestrator`／`TemplateBuilder` | 集群中的 orchestrator 按角色进入 Sandbox Node 池；构建要求 builder 角色 | [角色映射:40](../packages/orchestrator/pkg/service/info.go#L40)、[GetOrchestrators:259](../packages/api/internal/clusters/cluster.go#L259)、[接入 Node 池:154](../packages/api/internal/orchestrator/cache.go#L154) |
| `teams.sandbox_scheduling_labels` | 数据库字段，非空数组，默认 `{}`；它保存团队的节点标签要求 | 只有 Sandbox 标签 Flag 启用时才进入过滤规则 | [字段迁移:3](../packages/db/migrations/20260309120000_add_team_sandbox_scheduling_labels.sql#L3)、[读取标签要求:485](../packages/api/internal/orchestrator/create_instance.go#L485) |
| 节点 `NODE_LABELS` | 节点进程从环境变量按逗号读取，经 `ServiceInfo.labels` 上报；Nomad jobspec 从节点 metadata 注入 | Sandbox 可用；builder 选择器未读取这些标签 | [cfg/model.go:90](../packages/orchestrator/pkg/cfg/model.go#L90)、[ServiceInfo:80](../packages/orchestrator/pkg/service/service_info.go#L80)、[Nomad 注入:68](../iac/modules/job-orchestrator/jobs/orchestrator.hcl#L68)、[builder 条件:238](../packages/api/internal/clusters/cluster.go#L238) |
| `env_builds.cluster_node_id`、`cpu_*` | 构建开始前保存已选 builder 节点及 CPU 描述；vCPU、RAM 等规格另存于 build | node ID 用于后续构建调用；CPU 描述用于 Sandbox 常规兼容性筛选 | [保存选点结果:145](../packages/api/internal/handlers/template_start_build_v2.go#L145)、[更新 SQL:1](../packages/db/queries/builds/update_template.sql#L1)、[读取 build CPU:325](../packages/api/internal/orchestrator/create_instance.go#L325) |
| `snapshots.origin_node_id` | 暂停快照的来源节点；恢复数据读取后放入 `SandboxMetadata.NodeID` | 恢复时形成节点偏好，既不是节点锁定，也不保证原节点仍可用 | [恢复元数据:214](../packages/api/internal/handlers/sandbox_resume.go#L214)、[NodeID 传递:250](../packages/api/internal/handlers/sandbox_resume.go#L250)、[原节点判断:310](../packages/api/internal/orchestrator/create_instance.go#L310) |

### 2.2 节点从哪里发现

| 模式 | Sandbox 节点发现 | Template builder 发现 | 源码依据 |
|---|---|---|---|
| Nomad，默认 provider | 查询 `NOMAD_ORCHESTRATOR_SERVICE_NAMES` 指定的原生服务，默认 `orchestrator`；合并并按 Nomad NodeID 去重，跳过空地址，采用服务登记端口。登记本身不代表健康 | 查询 running allocations，要求 task group 为 `template-manager` 且 JobID 包含 `template-manager`；读取 allocation IP，随后通过 ServiceInfo 确认角色与状态 | [provider 默认值:46](../packages/api/internal/cfg/model.go#L46)、[服务发现:41](../packages/api/internal/orchestrator/discovery/nomad.go#L41)、[builder 发现:55](../packages/api/internal/clusters/discovery/local.go#L55)、[allocation 过滤:29](../packages/shared/pkg/clusters/discovery/nomad.go#L29) |
| Nomad 历史兼容 | `NOMAD_ORCHESTRATOR_LEGACY_DISCOVERY_ENABLED` 默认 `true`：额外列出 `default` pool 内 Status 为 ready 的节点，使用约定 gRPC 端口。按 ShortID 合并，服务登记优先；任一发现源失败使本轮发现失败 | 不走这个 Sandbox 合并分支 | [装配兼容源:174](../packages/api/internal/handlers/store.go#L174)、[Flag 默认值:67](../packages/api/internal/cfg/model.go#L67)、[旧发现条件:47](../packages/api/internal/orchestrator/discovery/nomad_node_pool.go#L47)、[合并规则:34](../packages/api/internal/orchestrator/discovery/merged.go#L34) |
| Kubernetes | 按 namespace 与 orchestrator Pod selector 列举，只接受 Running 且 Ready 的 Pod；优先 HostIP，缺失时用 PodIP | 使用独立的 template-manager Pod selector，也要求 Running 且 Ready | [provider 装配:140](../packages/api/internal/handlers/store.go#L140)、[Sandbox Pod 筛选:40](../packages/api/internal/orchestrator/discovery/kubernetes.go#L40)、[builder Pod 筛选:40](../packages/api/internal/clusters/discovery/kubernetes.go#L40)、[默认 selectors:75](../packages/api/internal/cfg/model.go#L75) |
| `SERVICE_DISCOVERY_PROVIDER=local` | 使用固定 `LOCAL_ORCHESTRATOR_ADDRESS`，默认 `127.0.0.1:5008` | 该 provider 明确装配空 builder 列表，因此不能据此认定本地模式具备构建节点 | [local 分支:157](../packages/api/internal/handlers/store.go#L157)、[地址默认值:73](../packages/api/internal/cfg/model.go#L73) |
| 远端逻辑集群 | 由 Edge API 的 service discovery 返回节点；控制调用经集群 gRPC proxy，携带实例路由信息 | 复用该集群发现到的 Instance，再按 builder 角色筛选 | [远端发现:44](../packages/api/internal/clusters/discovery/remote.go#L44)、[远端客户端:141](../packages/api/internal/clusters/cluster.go#L141)、[角色筛选:238](../packages/api/internal/clusters/cluster.go#L238) |

### 2.3 健康状态如何影响候选集合

| 环节 | 实际周期／行为 | 对调度的影响 | 源码依据 |
|---|---|---|---|
| Cluster 池 | 启动即同步，此后每 15 秒查询 active clusters，并加入本地逻辑集群；单轮超时 5 秒 | 控制 API 知道哪些逻辑集群 | [周期:24](../packages/api/internal/clusters/clusters_sync.go#L24)、[启动:78](../packages/api/internal/clusters/clusters_sync.go#L78)、[来源:120](../packages/api/internal/clusters/clusters_sync.go#L120) |
| Cluster Instance 池 | 每 5 秒发现／同步；单次 `Instance.Sync` 的 ServiceInfo 超时 1 秒；连续 3 次失败标记 Unhealthy，成功清零失败计数 | 新 build 要求 Healthy；既有 build 按 ID 访问时只排除 Unhealthy 与非 builder，因而可继续访问仍在池中的 Draining builder | [实例周期:34](../packages/api/internal/clusters/cluster.go#L34)、[失败阈值:24](../packages/api/internal/clusters/instance.go#L24)、[同步行为:121](../packages/api/internal/clusters/instance.go#L121)、[按 ID 获取:191](../packages/api/internal/clusters/cluster.go#L191) |
| Sandbox Node 池 | 启动即同步，此后每 20 秒一次；一轮同步受 20 秒 context 约束；Node.Sync 最多尝试 4 次 ServiceInfo＋Sandbox 列表同步，全失败则本地标记 Unhealthy | 这是与上行 Instance 健康检查不同的一层；同步指标也来自此路径 | [cache.go:22](../packages/api/internal/orchestrator/cache.go#L22)、[本轮超时:53](../packages/api/internal/orchestrator/cache.go#L53)、[Node.Sync:15](../packages/api/internal/orchestrator/nodemanager/sync.go#L15) |
| Sandbox 连接状态 | 服务 Healthy 映射为 API Ready；Ready 节点的 gRPC 连接处于 Connecting／TransientFailure 时显示 Connecting，Shutdown 时显示 Unhealthy | 常规采样只接受 Ready，排除 Draining、Standby、Connecting、Unhealthy | [状态映射:16](../packages/api/internal/orchestrator/nodemanager/status.go#L16)、[连接状态:32](../packages/api/internal/orchestrator/nodemanager/status.go#L32)、[采样条件:172](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L172) |
| 节点／进程消失 | Nomad 发现列表不再含节点，或集群中找不到对应进程实例 ID 时，关闭连接并从 Node map 注销；发现查询本身失败则跳过该轮，而不是拿部分结果注销节点 | 候选集合变化与发现周期有关，不是实时强一致清单 | [发现失败:64](../packages/api/internal/orchestrator/cache.go#L64)、[注销:109](../packages/api/internal/orchestrator/cache.go#L109)、[实例／节点存在性:172](../packages/api/internal/orchestrator/cache.go#L172) |
| 已知 Sandbox 的目标节点未缓存 | `getOrConnectNode` 用 singleflight 按需发现、连接，补上 API 副本发现进度差；普通创建的 `GetClusterNodes` 与恢复偏好的 `GetNode` 没有调用此补发现函数 | 已有 Sandbox 操作的按需连接机制，不等于每次新建都会刷新全体候选 | [getOrConnectNode:142](../packages/api/internal/orchestrator/client.go#L142)、[已有 Sandbox 更新:34](../packages/api/internal/orchestrator/update_instance.go#L34)、[新建／恢复取节点:310](../packages/api/internal/orchestrator/create_instance.go#L310) |

## 3. Sandbox 选点、接收与重试

### 3.1 执行顺序

| 顺序 | 实际逻辑 | 源码依据 |
|---|---|---|
| 1 | 预留团队的 Sandbox 并发额度；然后使用 build 的 vCPU／RAM／磁盘规格组成创建请求 | [团队预留:153](../packages/api/internal/orchestrator/create_instance.go#L153)、[请求构造:275](../packages/api/internal/orchestrator/create_instance.go#L275) |
| 2 | 普通新建不提供原节点偏好；快照恢复读取 `origin_node_id`，只在当前团队集群中找到且状态为 Ready 时优先使用 | [普通新建:287](../packages/api/internal/handlers/sandbox_create.go#L287)、[恢复数据:214](../packages/api/internal/handlers/sandbox_resume.go#L214)、[偏好判断:310](../packages/api/internal/orchestrator/create_instance.go#L310) |
| 3 | 没有可用偏好时，随机、不重复地检查集群节点，跳过被排除节点、不 Ready 节点、CPU 不兼容节点和标签不匹配节点；直到收集 K 个合格节点或遍历完毕 | [sample:143](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L143) |
| 4 | 对收集的候选计算 CPU 分数，选择最低分；这是样本内最优，不是全池最低负载保证 | [chooseNode:93](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L93) |
| 5 | 在本 API 的 Node 上记录本次正在分配的 CPU／RAM，发送 `Sandbox.Create` RPC；成功、拒绝或失败都会移除这条临时记录 | [placement.go:108](../packages/api/internal/orchestrator/placement/placement.go#L108)、[结果分支:149](../packages/api/internal/orchestrator/placement/placement.go#L149)、[PlacementMetrics:21](../packages/api/internal/orchestrator/nodemanager/placement_metrics.go#L21) |
| 6 | 目标节点校验运行数量、获取启动名额，加载模板或快照，通过本机 Sandbox Factory 恢复或启动 VM；RPC 结果决定本次成功还是继续选点 | [节点接收限制:139](../packages/orchestrator/pkg/server/sandboxes.go#L139)、[本机启动:229](../packages/orchestrator/pkg/server/sandboxes.go#L229)、[RPC 结果:118](../packages/api/internal/orchestrator/placement/placement.go#L118) |

### 3.2 CPU 兼容性与标签过滤

| 条件 | Sandbox 常规选点规则 | Template builder 的区别 | 源码依据 |
|---|---|---|---|
| build 未记录 CPU architecture | 跳过 CPU 兼容检查，兼容历史 build | 偏好 JSON 的 architecture 为空时，同样不附加 CPU 条件 | [cpu_compatibility.go:12](../packages/api/internal/orchestrator/placement/cpu_compatibility.go#L12)、[builder CPU 条件:246](../packages/api/internal/clusters/cluster.go#L246) |
| 同 CPU 型号 | architecture、family 必须一致；model 相同则兼容 | 偏好匹配要求 architecture＋family＋model 全部相同 | [IsCompatibleWith:46](../packages/shared/pkg/machineinfo/machine_info.go#L46)、[IsExactMatch:65](../packages/shared/pkg/machineinfo/machine_info.go#L65) |
| 跨 CPU 型号 | architecture、family 一致的前提下，硬编码允许 build model `106`（Ice Lake）运行于 node model `207`（Emerald Rapids）；反向未允许 | 第一轮精确匹配不接受跨代兼容；找不到匹配 builder 后，第二轮放开 CPU 偏好 | [兼容表:22](../packages/shared/pkg/machineinfo/machine_info.go#L22)、[匹配实现:46](../packages/shared/pkg/machineinfo/machine_info.go#L46)、[偏好回退:124](../packages/api/internal/template-manager/template_manager.go#L124) |
| `cpu_flags`／`cpu_model_name` | CPU 描述中有记录，但这两个比较函数没有用它们判断兼容 | 相同 | [MachineInfo:14](../packages/shared/pkg/machineinfo/machine_info.go#L14)、[两个比较函数:46](../packages/shared/pkg/machineinfo/machine_info.go#L46) |
| 标签总开关关闭 | `sandbox-label-based-scheduling = false` 时直接返回“不过滤”，包括团队标签和卷类型标签 | builder 选择器没有标签条件 | [generateRequiredNodeLabels:485](../packages/api/internal/orchestrator/create_instance.go#L485)、[builder 条件:238](../packages/api/internal/clusters/cluster.go#L238) |
| 标签总开关开启 | 使用团队的完整标签数组；数组为空时要求 `default`；候选节点必须包含所有要求标签 | 团队 Sandbox 标签不会在该 builder 选择器中生效 | [团队默认标签:491](../packages/api/internal/orchestrator/create_instance.go#L491)、[全部匹配:11](../packages/api/internal/orchestrator/placement/label_compatibility.go#L11) |
| 卷类型标签开关开启 | 仅在总开关已开启时生效；为每个挂载卷追加 `persistent-volume-type=<type>` 标签，仍要求全部匹配 | 构建选点没有读取 Sandbox VolumeMounts | [卷标签条件:499](../packages/api/internal/orchestrator/create_instance.go#L499)、[标签格式:3](../packages/api/internal/labels.go#L3)、[构建选点入参:111](../packages/api/internal/template-manager/template_manager.go#L111) |
| 节点未上报标签 | Node manager 将空集合补成 `default`；有非空标签的节点不会额外自动补 `default` | 只影响 Sandbox Node 的标签集合 | [labels.go:3](../packages/api/internal/orchestrator/nodemanager/labels.go#L3) |

### 3.3 Best-of-K 评分及资源记账

实际公式如下，`CPUPercent = 100` 按实现解释为占用 1 个 CPU 核。依据：[Score:35](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L35)。

```text
pendingCPU  = 当前 API 进程在该节点上尚未完成的分配请求 vCPU 之和
reservedCPU = 最近上报的 CpuAllocated + pendingCPU
usedCPU     = CpuPercent / 100

score = (本次请求 vCPU + reservedCPU + Alpha × usedCPU)
        / (R × 节点 CpuCount)

代码默认：K = 3，R = 4，Alpha = 0.5；分数越低越优先。
```

| 边界 | 代码实际行为 | 源码依据 |
|---|---|---|
| `R = 4` 的含义 | 只用于评分分母；没有 `score <= 1` 或“已分配 CPU 不得超过物理核数四倍”的接收条件。对同次选择中的所有节点使用相同正数 R 时，它也不会改变评分排序，这是公式本身的结果 | [Score:50](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L50)、[最低分选择:101](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L101) |
| 内存、磁盘与 HugePages | 节点确实上报相关数据，但当前常规候选过滤和 Score 未使用剩余内存、磁盘、HugePages 数量；不能把“上报了指标”理解为“已做容量准入” | [ServiceInfo 指标:84](../packages/orchestrator/pkg/service/service_info.go#L84)、[Metrics:15](../packages/api/internal/orchestrator/nodemanager/metrics.go#L15)、[Score:35](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L35)、[过滤项:167](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L167) |
| 指标来源 | 节点按本机 Sandbox map 汇总 vCPU／RAM／磁盘配置，同时上报宿主机 CPU 使用量与总 CPU 数；API 定期覆盖本地指标视图 | [ServiceInfo 汇总:57](../packages/orchestrator/pkg/service/service_info.go#L57)、[API 指标更新:35](../packages/api/internal/orchestrator/nodemanager/metrics.go#L35) |
| 本地 pending 记账 | `sandboxesInProgress` 是每个 API 进程内的 map；可以让该进程后续评分看到正在发起的分配，但不是跨 API 副本共享的节点容量预留 | [map 初始化:109](../packages/api/internal/orchestrator/nodemanager/node.go#L109)、[PlacementMetrics:14](../packages/api/internal/orchestrator/nodemanager/placement_metrics.go#L14)、[Score 读取:38](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L38) |
| 乐观资源记账 | `sandbox-placement-optimistic-resource-accounting` 默认关闭；开启后成功创建会立即累加本 API 视图的 CPU／RAM 分配量，后续 ServiceInfo 覆盖校正 | [Flag:167](../packages/shared/pkg/featureflags/flags.go#L167)、[调用:123](../packages/api/internal/orchestrator/placement/placement.go#L123)、[OptimisticAdd:201](../packages/api/internal/orchestrator/nodemanager/node.go#L201) |
| 无效采样或指标 | `K <= 0` 时没有候选；`CpuCount == 0` 时分数为 MaxFloat64，因选择条件是严格小于，不能成为选中节点。配置读取未对 K／R／Alpha 做范围归一化 | [sample:143](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L143)、[零 CPU:50](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L50)、[选择条件:107](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L107)、[配置读取:311](../packages/api/internal/orchestrator/orchestrator.go#L311) |

### 3.4 节点侧接收限制

| 限制 | 默认值／单位 | 校验与超限行为 | 源码依据 |
|---|---|---|---|
| `max-sandboxes-per-node` | 200，个 | 每次 Create 读取 Flag；当前本机 Sandbox map 的 Count 达到阈值时，返回 gRPC `ResourceExhausted`。这是入口计数检查，没有把后续尚未进入 map 的启动请求合并为原子容量预留 | [Flag:282](../packages/shared/pkg/featureflags/flags.go#L282)、[运行数检查:139](../packages/orchestrator/pkg/server/sandboxes.go#L139) |
| `max-starting-instances-per-node` | 3，同时进行的启动／恢复操作 | 单节点可调整 semaphore；普通新建 `TryAcquire(1)`，无名额立即返回 `ResourceExhausted`；Create 结束释放名额 | [Flag:367](../packages/shared/pkg/featureflags/flags.go#L367)、[semaphore 初始化:117](../packages/orchestrator/pkg/server/main.go#L117)、[获取／释放:148](../packages/orchestrator/pkg/server/sandboxes.go#L148) |
| 快照恢复等待名额 | 最长 15 秒，也受上游 context 限制 | `Snapshot=true` 调用阻塞 Acquire；等待失败返回 `ResourceExhausted`。不是新建请求的全局排队服务 | [acquireTimeout:44](../packages/orchestrator/pkg/server/sandboxes.go#L44)、[分支:149](../packages/orchestrator/pkg/server/sandboxes.go#L149)、[waitForAcquire:14](../packages/orchestrator/pkg/server/utils.go#L14) |
| 同一启动名额的其他消费者 | 共享上述 semaphore | Checkpoint 也获取并释放该名额；启用暂停侧预取采集后，其临时恢复路径同样获取名额。因此默认 3 个名额并非仅供外部 Create 请求使用 | [Checkpoint:746](../packages/orchestrator/pkg/server/sandboxes.go#L746)、[预取采集开关:163](../packages/orchestrator/pkg/server/prefetch_harvest.go#L163)、[共享名额:127](../packages/orchestrator/pkg/server/prefetch_harvest.go#L127)、[获取名额:296](../packages/orchestrator/pkg/server/prefetch_harvest.go#L296) |
| 节点 Create RPC | 最长 60 秒，也受上游 deadline 限制 | 节点为本次调用添加超时；这是启动请求的处理时间，区别于沙箱本身的存活时间 `timeout` | [requestTimeout:44](../packages/orchestrator/pkg/server/sandboxes.go#L44)、[context:75](../packages/orchestrator/pkg/server/sandboxes.go#L75)、[沙箱存活时间:61](../packages/api/internal/handlers/sandbox.go#L61) |
| 启动名额动态变更 | 每 30 秒重读 | 启动时非正值使 semaphore 初始化失败；运行中非正值被忽略，不表示无限并发；正值用于调整 limit | [刷新周期:38](../packages/orchestrator/pkg/server/main.go#L38)、[初始化校验:23](../packages/shared/pkg/utils/resizable_semaphore.go#L23)、[刷新逻辑:336](../packages/orchestrator/pkg/server/main.go#L336) |

### 3.5 恢复偏好及重试细节

| 场景 | 实际处理 | 源码依据 |
|---|---|---|
| 原节点仍在当前集群缓存中且 Ready | 先直接尝试原节点；这个分支**绕过 Best-of-K 的 CPU、标签检查与评分**。不能把常规候选规则无条件套到恢复首选节点上 | [原节点 Ready 判断:310](../packages/api/internal/orchestrator/create_instance.go#L310)、[优先节点分支:59](../packages/api/internal/orchestrator/placement/placement.go#L59)、[跳过 chooseNode:93](../packages/api/internal/orchestrator/placement/placement.go#L93) |
| 原节点缺失／不 Ready | 不再保持偏好，转入同一集群的常规 Best-of-K；不会等待原节点恢复 | [create_instance.go:310](../packages/api/internal/orchestrator/create_instance.go#L310)、[PlaceSandbox:93](../packages/api/internal/orchestrator/placement/placement.go#L93) |
| 节点返回 `ResourceExhausted` | 移除 pending 记录，重新选点；**不增加 attempt、不加入排除集，也没有显式 backoff**。所以仍可能再次选到同一节点，不能解释为“只尝试 3 次” | [placement.go:134](../packages/api/internal/orchestrator/placement/placement.go#L134) |
| 其他 RPC 错误 | 将失败节点加入本请求排除集，移除 pending，attempt 加 1；最多 3 次这类计数失败，期间仍受候选集合和 context 限制 | [maxRetries:4](../packages/api/internal/orchestrator/placement/config.go#L4)、[循环边界:84](../packages/api/internal/orchestrator/placement/placement.go#L84)、[错误分支:153](../packages/api/internal/orchestrator/placement/placement.go#L153) |
| 无合格候选、重试耗尽或请求结束 | 选点失败向上层返回；`CreateSandbox` 对该失败路径生成 HTTP 500，消息为 `Failed to place sandbox`，区别于前置团队额度的 HTTP 429 | [无候选:113](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L113)、[请求结束:85](../packages/api/internal/orchestrator/placement/placement.go#L85)、[HTTP 映射:337](../packages/api/internal/orchestrator/create_instance.go#L337) |
| 恢复请求超时／被取消 | `ctx.Err() != nil` 时才输出 `TimedOut` 与首个非 ResourceExhausted 失败节点；`resume-origin-node-remap` 开启且节点不同于原节点时，在独立 5 秒 context 中更新快照来源节点、失效缓存，影响下一次恢复偏好；本次仍失败 | [记录首个尝试节点:143](../packages/api/internal/orchestrator/placement/placement.go#L143)、[TimedOut 判断:76](../packages/api/internal/orchestrator/placement/placement.go#L76)、[remap:436](../packages/api/internal/orchestrator/create_instance.go#L436)、[Flag 默认关闭:213](../packages/shared/pkg/featureflags/flags.go#L213) |
| Fork 使用源快照 | 恢复数据另存 `SnapshotSandboxID`；remap 更新源快照所属 Sandbox 的记录，而非新 fork 的 Sandbox ID | [元数据:250](../packages/api/internal/handlers/sandbox_resume.go#L250)、[源 ID 选择:327](../packages/api/internal/orchestrator/create_instance.go#L327) |
| 历史 `origin_node_id` | 迁移把 NULL 写成 `unknown` 并设为 NOT NULL；恢复代码仍只是按字符串查 Node，找不到则走普通选点，没有专门的 `unknown` 节点规则 | [历史迁移:3](../packages/db/migrations/20250824185634_snapshot_node_not_nullable.sql#L3)、[查找及回退:310](../packages/api/internal/orchestrator/create_instance.go#L310) |

## 4. Template 构建如何选择并绑定节点

### 4.1 登记、派发与执行

| 阶段 | 实际行为与限制 | 源码依据 |
|---|---|---|
| 登记 build | 先检查团队构建并发。计数来自最近一天的 `active_template_builds`，排除同模板且 tag 相交的记录；代码明确说明该查询式检查不能保证并发下绝不超限 | [RegisterBuild:73](../packages/api/internal/template/register_build.go#L73)、[计数 SQL:11](../packages/db/queries/builds/get_inprogress_builds.sql#L11) |
| 启动前处理冲突 build | 查询同模板、tag 相交、状态为 pending／in_progress 的其他 build；取消函数只对其中 in_progress 且有 node ID 的记录向对应节点发送删除请求。不要解读为任何两个不同 tag 的构建都互斥 | [冲突查询:1](../packages/db/queries/builds/get_concurrent_template_builds.sql#L1)、[取消函数:31](../packages/api/internal/handlers/deprecated_template_start_build.go#L31)、[v2 调用:99](../packages/api/internal/handlers/template_start_build_v2.go#L99) |
| 校验待启动状态 | 只有 `status_group = pending` 可触发；否则 HTTP 400。当前 handler 先执行上面的冲突取消，再检查本 build 状态 | [template_start_build_v2.go:99](../packages/api/internal/handlers/template_start_build_v2.go#L99) |
| 第一轮选 builder | 解析 `preferred-build-node` JSON；在团队集群内随机打乱 Instance，取首个 Healthy＋TemplateBuilder，非空 architecture 时额外要求 CPU architecture／family／model 精确匹配 | [GetAvailableBuildClient:111](../packages/api/internal/template-manager/template_manager.go#L111)、[随机选点:215](../packages/api/internal/clusters/cluster.go#L215)、[精确匹配:65](../packages/shared/pkg/machineinfo/machine_info.go#L65) |
| CPU 偏好回退 | 找不到符合偏好的 builder 时，再以空 MachineInfo 从同集群的健康 builder 中随机选择。JSON 默认 `null`；解析失败会记录错误并返回空 MachineInfo。因此此配置是偏好，不保证构建必在特定 CPU 上执行 | [Flag:497](../packages/shared/pkg/featureflags/flags.go#L497)、[JSON 解析:85](../packages/shared/pkg/machineinfo/machine_info.go#L85)、[第二轮选择:124](../packages/api/internal/template-manager/template_manager.go#L124) |
| 保存选点结果 | 将 `cluster_node_id`、实际选中 builder 的 `cpu_architecture/family/model/model_name/flags` 写入 `env_builds`，同时保存构建命令／步骤 | [保存结果:145](../packages/api/internal/handlers/template_start_build_v2.go#L145)、[更新字段:1](../packages/db/queries/builds/update_template.sql#L1) |
| 固定节点派发 | 使用上述 node ID 调用 `TemplateCreate`；成功发起后才将 DB 状态改为 in_progress，并立即启动状态同步；启动接口成功返回 HTTP 202，表示构建已经发起 | [固定客户端:91](../packages/api/internal/template-manager/create_template.go#L91)、[派发及状态更新:156](../packages/api/internal/template-manager/create_template.go#L156)、[异步同步:183](../packages/api/internal/template-manager/create_template.go#L183)、[HTTP 202:203](../packages/api/internal/handlers/template_start_build_v2.go#L203) |
| builder 节点接收 | 建立本机 build cache，增加 WaitGroup／activeBuilds 后启动 goroutine；后台 context 使用 `WithoutCancel` 脱离发起请求。此入口没有按 activeBuilds 数量限流；activeBuilds 字段用于观测和 drain | [TemplateCreate:108](../packages/orchestrator/pkg/template/server/create_template.go#L108)、[后台构建:124](../packages/orchestrator/pkg/template/server/create_template.go#L124)、[脱离请求:188](../packages/orchestrator/pkg/template/server/create_template.go#L188)、[activeBuilds 定义:54](../packages/orchestrator/pkg/template/server/main.go#L54) |
| 同一个 build ID 重复派发 | 本机 cache 已有该 ID 时 Create 返回错误；并非返回已有任务并确认成功，也没有队列重分配 | [BuildCache.Create:147](../packages/orchestrator/pkg/template/cache/build_cache.go#L147) |
| 单 build 内的阶段 | base、user、steps、可选磁盘扩容、finalize、optimize 由同一个 builder 组织，phase 顺序执行；命中层缓存可跳过该 phase 的实际构建 | [阶段组装:387](../packages/orchestrator/pkg/template/build/builder.go#L387)、[顺序执行:79](../packages/orchestrator/pkg/template/build/phases/phase.go#L79)、[命中缓存:149](../packages/orchestrator/pkg/template/build/phases/phase.go#L149) |
| 构建用 VM 的位置 | 使用 builder 本机注入的 Sandbox Factory，标记 `SandboxTypeBuild`；不经 API Best-of-K，也不经 `SandboxService.Create` 的 200／3 入口检查。不能用这两个 Sandbox 接口阈值推导 builder 的构建并发上限 | [CreateSandbox:134](../packages/orchestrator/pkg/template/build/layer/create_sandbox.go#L134)、[ResumeSandbox:36](../packages/orchestrator/pkg/template/build/layer/resume_sandbox.go#L36)、[Sandbox RPC 限制所在位置:139](../packages/orchestrator/pkg/server/sandboxes.go#L139) |
| 旧版模板启动接口 | 旧 handler 也调用 `GetAvailableBuildClient`，保存 node／CPU 后向同一 node 派发；没有另外一套按资源负载选点的旧算法 | [旧接口选点:172](../packages/api/internal/handlers/deprecated_template_start_build.go#L172)、[旧接口派发:203](../packages/api/internal/handlers/deprecated_template_start_build.go#L203) |

**构建节点会影响产物后续能调度到哪些 CPU。** 构建派发保存所选机器的 CPU 描述，Sandbox 常规选点再用这个描述做方向性的兼容匹配；“构建时可以回退到任意健康 builder”不等于“产物随后可以在任意 Sandbox 节点启动”。依据：[保存 CPU:145](../packages/api/internal/handlers/template_start_build_v2.go#L145)、[Sandbox 使用 build 信息:325](../packages/api/internal/orchestrator/create_instance.go#L325)、[兼容实现:46](../packages/shared/pkg/machineinfo/machine_info.go#L46)。

### 4.2 状态同步、超时与故障处理

| 场景 | 实际处理 | 源码依据 |
|---|---|---|
| 没有可用 builder／指定集群不存在 | 启动 handler 返回 HTTP 503；CPU 偏好回退仍找不到节点即失败，没有等待节点上线的派发队列 | [选点失败:137](../packages/api/internal/handlers/template_start_build_v2.go#L137)、[集群缺失及回退:111](../packages/api/internal/template-manager/template_manager.go#L111) |
| TemplateCreate 失败 | `CreateTemplate` 返回错误并尝试将 build 标为 failed；handler 返回 HTTP 500。该函数内没有再次随机选择 builder 的循环 | [失败处理:66](../packages/api/internal/template-manager/create_template.go#L66)、[RPC 调用:156](../packages/api/internal/template-manager/create_template.go#L156)、[HTTP 映射:196](../packages/api/internal/handlers/template_start_build_v2.go#L196) |
| 运行中状态查询 | 每个 build 按固定 `clusterID + nodeID` 查询；poll ticker 为 1 秒。API 另每分钟从数据库扫 pending／in_progress build，补启动状态同步；`processing` map 只是本 API 内的轮询去重 | [GetStatus:217](../packages/api/internal/template-manager/template_manager.go#L217)、[poll:104](../packages/api/internal/template-manager/template_status.go#L104)、[周期补同步:80](../packages/api/internal/template-manager/template_manager.go#L80)、[processing:255](../packages/api/internal/template-manager/template_status.go#L255) |
| 已登记但迟迟未开始 | pending 距 `created_at` 超过 40 分钟时尝试标为 failed；没有在此分支分配 builder 或启动构建 | [pending 超时:19](../packages/api/internal/template-manager/template_status.go#L19)、[处理:41](../packages/api/internal/template-manager/template_status.go#L41) |
| in_progress 但缺少 node ID | 状态同步直接返回错误；这里未补选节点，也未直接把 build 改成 failed | [node ID 检查:61](../packages/api/internal/template-manager/template_status.go#L61) |
| builder 消失／Unhealthy／本机 build cache 丢失 | 固定节点客户端获取或状态 RPC 返回错误；常规非 DeadlineExceeded 错误被当作终止错误，轮询尝试将 DB 状态改为 failed。没有换节点继续或恢复构建过程 | [固定节点状态门槛:191](../packages/api/internal/clusters/cluster.go#L191)、[本机状态来源:25](../packages/orchestrator/pkg/template/server/template_status.go#L25)、[错误分类:161](../packages/api/internal/template-manager/template_status.go#L161)、[终止处理:122](../packages/api/internal/template-manager/template_status.go#L122) |
| 轮询调用超时 | 对满足 `errors.Is(err, context.DeadlineExceeded)` 的错误允许重试，retrier 参数为 `10, 100ms, 1s`；其他常规查询错误停止重试。重试目标仍是原节点 | [错误分类:161](../packages/api/internal/template-manager/template_status.go#L161)、[retrier:223](../packages/api/internal/template-manager/template_status.go#L223) |
| 状态轮询持续过久 | 单次 BuildStatusSync 的轮询 context 最长 1 小时，结束分支尝试标 failed；该写入沿用已结束的 context，最终写入成功与否不能保证。**此时长不是 builder 进程已强制结束整个构建的保证**：后台构建脱离发起请求，代码另有阶段／命令超时 | [轮询预算:76](../packages/api/internal/template-manager/template_status.go#L76)、[超时分支:110](../packages/api/internal/template-manager/template_status.go#L110)、[后台 context:188](../packages/orchestrator/pkg/template/server/create_template.go#L188)、[命令超时:31](../packages/orchestrator/pkg/template/build/sandboxtools/command.go#L31) |
| 构建完成／失败 | builder 将结果写入本机 cache；API 轮询 Completed 时写完成信息，Failed 时写失败原因。状态同步不重新运行 build phases | [本机结果:162](../packages/orchestrator/pkg/template/server/create_template.go#L162)、[结果分派:183](../packages/api/internal/template-manager/template_status.go#L183) |
| 构建期间变更团队 cluster | 周期补同步查询使用当时 `teams.cluster_id` 与 build 的 `cluster_node_id`；即时同步则使用发起时的参数。不能据此认定已支持跨集群迁移在途构建；迁移保障**未确认** | [周期查询:1](../packages/db/queries/builds/get_inprogress_builds.sql#L1)、[周期同步参数:99](../packages/api/internal/template-manager/template_manager.go#L99)、[即时同步参数:190](../packages/api/internal/template-manager/create_template.go#L190) |

## 5. 配置值与生效范围速查

下表汇总影响节点选择的主要可配置项。数据库配置是否参与执行，要看对应 Flag 和调用路径；表中回退值不代表线上已启用。

| 配置键／字段 | 代码默认值 | 生效位置与条件 | 源码依据 |
|---|---|---|---|
| `teams.cluster_id` | nil 时使用全零 UUID 的本地集群 | Sandbox／build 的集群范围；不是找不到指定集群时再回退 | [WithClusterFallback:9](../packages/shared/pkg/clusters/cluster.go#L9)、[LocalClusterID:5](../packages/shared/pkg/consts/cluster.go#L5) |
| `best-of-k-sample-size` | 3 | API 构造 Best-of-K 时读取，此后每 30 秒更新；控制合格候选样本数 | [Flag:289](../packages/shared/pkg/featureflags/flags.go#L289)、[初始化:128](../packages/api/internal/orchestrator/orchestrator.go#L128)、[动态更新:293](../packages/api/internal/orchestrator/orchestrator.go#L293) |
| `best-of-k-max-overcommit` | 400，百分数，换算为 `R=4` | 同上；用于评分，不是四倍 CPU 硬上限 | [Flag:290](../packages/shared/pkg/featureflags/flags.go#L290)、[百分比换算:311](../packages/api/internal/orchestrator/orchestrator.go#L311)、[评分:56](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L56) |
| `best-of-k-alpha` | 50，百分数，换算为 `Alpha=0.5` | 同上；权衡已用 CPU 在评分中的权重 | [Flag:291](../packages/shared/pkg/featureflags/flags.go#L291)、[换算:318](../packages/api/internal/orchestrator/orchestrator.go#L318) |
| `sandbox-label-based-scheduling` | false | 生成标签要求时附加 team／sandbox Flag context；关掉则不做标签过滤 | [Flag:166](../packages/shared/pkg/featureflags/flags.go#L166)、[生效条件:485](../packages/api/internal/orchestrator/create_instance.go#L485) |
| `sandbox-volume-label-based-scheduling` | false | 标签总开关开启后，再用 team／cluster／sandbox context 读取；开启时追加挂载卷类型标签 | [Flag:194](../packages/shared/pkg/featureflags/flags.go#L194)、[生效条件:499](../packages/api/internal/orchestrator/create_instance.go#L499) |
| `teams.sandbox_scheduling_labels` | 数据库 `{}` | 总开关启用后读取；空数组解释为要求 `default` | [数据库默认值:3](../packages/db/migrations/20260309120000_add_team_sandbox_scheduling_labels.sql#L3)、[空数组处理:491](../packages/api/internal/orchestrator/create_instance.go#L491) |
| `sandbox-placement-optimistic-resource-accounting` | false | 控制 API 本地成功分配后的 CPU／RAM 乐观累加，独立于请求进行中的 pending 记账 | [Flag:167](../packages/shared/pkg/featureflags/flags.go#L167)、[OptimisticAdd:201](../packages/api/internal/orchestrator/nodemanager/node.go#L201) |
| `resume-origin-node-remap` | false | 恢复请求结束且有记录到的尝试节点时，按 team／sandbox context 控制快照来源节点更新 | [Flag:213](../packages/shared/pkg/featureflags/flags.go#L213)、[判断与更新:436](../packages/api/internal/orchestrator/create_instance.go#L436) |
| `preferred-build-node` | JSON null | 每次选 builder 读取，附加 cluster context；非空 architecture 时尝试精确 CPU 匹配，失败可放开偏好 | [Flag:497](../packages/shared/pkg/featureflags/flags.go#L497)、[读取与回退:117](../packages/api/internal/template-manager/template_manager.go#L117) |
| `max-sandboxes-per-node`／`max-starting-instances-per-node` | 200／3 | 在节点 Sandbox RPC 中执行；前者每请求读取，后者由节点周期刷新 semaphore；不属于 Best-of-K 参数 | [运行数校验:139](../packages/orchestrator/pkg/server/sandboxes.go#L139)、[启动数校验:148](../packages/orchestrator/pkg/server/sandboxes.go#L148)、[刷新:336](../packages/orchestrator/pkg/server/main.go#L336) |

## 6. 节点部署、扩容与 Drain

这里分析基础设施把服务进程放在哪些主机、部署多少实例。它与 API 将某一次 Sandbox／build 请求分配给哪个进程，是不同层面的决策。

| 层次 | 仓库中确认的策略 | 与请求调度的关系 | 源码依据 |
|---|---|---|---|
| Nomad orchestrator jobspec | `type = system`，限定 `node_pool`；非 dev 版本还有 `meta.orchestrator_job_version` 约束，使用固定服务端口 | 决定哪些主机运行哪个版本的 orchestrator；每个 Sandbox VM 仍由该进程本机创建，而非提交一个独立 Nomad job | [orchestrator.hcl:1](../iac/modules/job-orchestrator/jobs/orchestrator.hcl#L1)、[版本约束:20](../iac/modules/job-orchestrator/jobs/orchestrator.hcl#L20)、[节点本机启动:229](../packages/orchestrator/pkg/server/sandboxes.go#L229) |
| Nomad template-manager jobspec | `type = service`，限定 `node_pool`；`distinct_hosts=true`，count 使用当前 Nomad 数量，以保留 autoscaler 管理值 | 部署层约束一个节点一个该 job allocation；不代表一个节点同时只处理一个 build | [template-manager.hcl:1](../iac/modules/job-template-manager/jobs/template-manager.hcl#L1)、[并发 goroutine:124](../packages/orchestrator/pkg/template/server/create_template.go#L124) |
| template-manager 实例扩缩 | `update_stanza` 条件满足时启用 scaling：min 2、max 10000、每 10 秒评估、cooldown 2 分钟，pass-through 节点池计数。APM 实际只计 `ready && scheduling eligible` 的 Nomad 节点 | 目标是让服务实例数跟随可调度节点数，不是根据每个 build 的 CPU／RAM 或队列长度挑选 builder | [scaling 条件及参数:16](../iac/modules/job-template-manager/jobs/template-manager.hcl#L16)、[APM 计数:120](../packages/nomad-nodepool-apm/plugin/plugin.go#L120) |
| GCP worker VM 扩容 | 共享 worker-cluster 模块只在 `autoscaler.size_max > cluster_size` 时创建 autoscaler；min 为 cluster_size，max 为 size_max，cooldown 240 秒，模式 `ONLY_SCALE_OUT`；可配置 CPU 与内存指标目标 | 这是宿主机数量控制。即使云层使用内存指标，API Best-of-K 仍未使用 RAM 容量评分；具体部署的 size／target **未确认** | [nodepool.tf:52](../iac/provider-gcp/nomad-cluster/worker-cluster/nodepool.tf#L52)、[CPU／内存条件:66](../iac/provider-gcp/nomad-cluster/worker-cluster/nodepool.tf#L66)、[Best-of-K:35](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L35) |
| 服务 Drain | 退出时将 Healthy／Standby 改为 Draining，非本地环境等待 15 秒传播；然后等待在途 build。正常停止还等待现存 Sandbox 生命周期结束；ForceStop 路径跳过正常 Sandbox drain | 更新后的选择视图会停止选择 Draining 节点；现有工作在原进程收尾，这段逻辑没有把运行中的 VM／build 迁移到其他节点 | [退出流程:942](../packages/orchestrator/pkg/factories/run.go#L942)、[Sandbox 候选状态:172](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L172)、[builder 候选状态:238](../packages/api/internal/clusters/cluster.go#L238) |
| builder 退出等待 | WaitGroup 等待构建结束，受 close context 限制；非本地环境结束后再留 15 秒给消费者读取最终状态 | 在途 build 的状态查询可继续按 node ID 访问池中 Draining builder；不是任务转移队列 | [Wait:158](../packages/orchestrator/pkg/template/server/main.go#L158)、[状态读取宽限:37](../packages/orchestrator/pkg/template/server/main.go#L37)、[按 ID 获取:191](../packages/api/internal/clusters/cluster.go#L191) |

## 7. 已确认的能力边界与未确认项

| 问题 | 结论 | 核对入口 |
|---|---|---|
| Sandbox 是否全局最优分配、严格限制 CPU 超分？ | 当前实现是随机 K 个合格候选内取最低分；没有 Score 阈值准入，不提供全池最低负载或四倍 CPU 封顶保证 | [采样及评分:93](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L93) |
| builder 是否按资源剩余量、缓存命中率或公平队列选点？ | 当前选择器只读取健康、角色、可选 CPU 偏好；没有这些选择条件。本机层缓存存在，但没有被这里用作节点偏好 | [builder 选择器:215](../packages/api/internal/clusters/cluster.go#L215)、[本机层缓存:135](../packages/orchestrator/pkg/template/build/phases/phase.go#L135) |
| 是否有 builder 专用的节点级 build 并发阈值？ | 已核对的选点与 TemplateCreate 入口未实现该阈值；团队构建并发校验独立存在。不能从 activeBuilds 计数或 Nomad allocation 数量推导单机并发上限 | [TemplateCreate:108](../packages/orchestrator/pkg/template/server/create_template.go#L108)、[团队并发:73](../packages/api/internal/template/register_build.go#L73)、[Nomad 约束:10](../iac/modules/job-template-manager/jobs/template-manager.hcl#L10) |
| 当前节点池、标签、Flag 线上取值是什么？ | **未确认**。仓库只给出配置来源与回退值；没有读取线上数据库、LaunchDarkly 或 Nomad／K8s 实时状态 | [API 配置:42](../packages/api/internal/cfg/model.go#L42)、[调度 Flag:289](../packages/shared/pkg/featureflags/flags.go#L289)、[节点标签:90](../packages/orchestrator/pkg/cfg/model.go#L90) |
| Kubernetes 宿主机亲和性／反亲和性、真实资源 Requests 是什么？ | **未确认**。本分析确认了 API 的 Pod 发现和应用内选点；不能用发现代码中的部署注释代替实际 workload 清单 | [provider 装配:140](../packages/api/internal/handlers/store.go#L140)、[Sandbox Pod 发现:40](../packages/api/internal/orchestrator/discovery/kubernetes.go#L40)、[builder Pod 发现:40](../packages/api/internal/clusters/discovery/kubernetes.go#L40) |
| 宿主机内存／磁盘耗尽是否一定被友好拒绝？ | **未确认统一的资源耗尽准入保障**。已确认常规选点不做 RAM／磁盘容量判断；节点入口校验运行数与启动名额，后续模板加载和 VM 操作仍可能报错，不能把它们等同容量充足证明 | [选点条件:167](../packages/api/internal/orchestrator/placement/placement_best_of_K.go#L167)、[节点入口:139](../packages/orchestrator/pkg/server/sandboxes.go#L139)、[启动错误处理:250](../packages/orchestrator/pkg/server/sandboxes.go#L250) |

## 8. 相关文档

| 文档 | 适合继续查阅的内容 |
|---|---|
| [Tier、用户与团队配额规则](./tier-user-team-rules.md) | 团队额度来源、规格默认值、超限校验及套餐变更 |
| [Node 与节点池](./node-module.md) | 节点模块及节点池总体结构 |
| [Clusters 与多集群路由](./clusters-module.md) | 集群访问、远端发现和连接边界 |
| [Template Build 端到端](./template-build-flow.md) | 构建阶段、层与最终产物 |
| [Sandbox 完整生命周期](./sandbox-lifecycle.md) | 创建、运行、暂停和回收 |
| [Artifact 存储与缓存](./artifact-storage-cache.md) | 模板／快照加载与分层缓存 |
