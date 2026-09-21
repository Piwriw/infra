# 12. Nomad NodePool APM

> ## ⛔ 部署路径已随 `iac/` 于 2026.30 删除，包本身仍在
>
> **`packages/nomad-nodepool-apm/` 在 2026.30 依然存在，代码没被删除。** 被删除的是它的**部署方式**：提交 `8a1c48884406b909f64c1239c808d0bc1cbf05bf`（Tomas Virgl，2026-09-09，subject：`chore(deploy): retire Nomad-based deployment ahead of a new deploy path`）删掉了整个 `iac/` 目录（172 文件 → 0），其中包括本插件的全部部署描述：
>
> - `iac/modules/job-template-manager-autoscaler/`（`main.tf`、`variables.tf`、`jobs/nomad-autoscaler.hcl`）—— 下载插件二进制、设置 `-plugin-dir`、声明 `apm "nomad-nodepool-apm"` block 的地方
> - `iac/modules/job-template-manager/jobs/template-manager.hcl` —— 定义 `check "match_node_count"` 与 `strategy "pass-through"` 的地方
> - `iac/provider-gcp/nomad/main.tf` 与 `iac/provider-aws/nomad/main.tf` —— 把 artifact 与 ETag 注入部署参数的地方
>
> 也就是说，本文 §2「启动/装配」描述的 1~4 步（构建二进制 → 上传 GCS/S3 → job 下载到 `local/plugins/` → agent 配置声明 APM block）**在 2026.30 的仓库里已无对应的可执行产物**。正文中所有 `iac/**` 路径**链接已失效**。
>
> ⚠️ 2026.30 的 `docs/ARCHITECTURE.md` 仍把该包列在仓库布局里（`nomad-nodepool-apm/   Nomad autoscaler metric and deployment-aware target plugins`），并且仍提到节点发现可以走 "the legacy Nomad backend the code still carries" —— 代码路径保留了，部署描述没有。
>
> ---
>
> **本文档的结构：**
> - **§零** — 2026.30 的包状态、行为变更与 Makefile 变更（只有这节描述当前状态）
> - **§1 ~ §8** — **历史档案**，描述 2026.29 及以前的实现与部署方式

---

## 零、2026.30 状态：包仍在，且有一个行为变更

### 零.1 2026.30 的文件清单（10 → 12 个）

`packages/nomad-nodepool-apm/` 在 2026.30 的文件：

| 文件 | 2026.29 | 2026.30 | 说明 |
| --- | --- | --- | --- |
| `main.go` | ✅ | ✅ | 插件进程入口 |
| `plugin/plugin.go` | ✅ | ✅ | APM 实现（**2026.30 有行为变更，见 §零.2**） |
| `plugin/plugin_test.go` | ❌ | ✅ **新增** | 为 `countReadyNodes` 补的单元测试 |
| `target/plugin.go` | ✅ | ✅ | deployment-aware target 实现 |
| `target/plugin_test.go` | ✅ | ✅ | |
| `cmd/nomad-deployment-aware-target/main.go` | ✅ | ✅ | 第二插件的入口（2026.29 就已在，非新增） |
| `CHANGELOG.md` | ❌ | ✅ **新增** | release-please 生成的版本记录 |
| `Dockerfile` | ✅ | ✅ | |
| `Makefile` | ✅ | ✅ | **2026.30 新增 `pull-released` 目标，见 §零.3** |
| `README.md` | ✅ | ✅ | **2026.30 改写了计数语义描述** |
| `go.mod`、`go.sum` | ✅ | ✅ | |

### 零.2 行为变更：计数不再要求 `eligible`

2026.30 把「ready **且** eligible」放宽为「只要求 ready」。`plugin/plugin.go` 里新增了 `countReadyNodes`：

```go
// countReadyNodes keeps nodes that are temporarily ineligible in the desired
// allocation count until they have actually left the pool.
func countReadyNodes(nodes []*api.NodeListStub) int {
	count := 0
	for _, node := range nodes {
		if node.Status == api.NodeStatusReady {
			count++
		}
	}

	return count
}
```

> ⚠️ **这直接推翻了本文 §3「Query 语义」与 §5 的两条结论**：正文写的是「插件只计数同时满足 `node.Status == ready` 与 `node.SchedulingEligibility == eligible`」，以及「drain 后变为 scheduling-ineligible 的节点不会计入 desired count」。**在 2026.30 这两句都不成立** —— 临时 ineligible（例如正在 drain）的节点仍会被计入，直到它真正离开 node pool。日志字段也从 `ready_eligible_nodes` 改名为 `ready_nodes`。
>
> `README.md` 同步把 "ready, eligible nodes" 改成 "ready nodes"；`target` 侧同时把 deployment-aware target 的使用者从仅 `orchestrator-ee` 扩展为 `template-manager` 与 `orchestrator-ee`。

### 零.3 Makefile 新增「拉取已发布二进制」路径

2026.30 的 `Makefile` 新增 `pull-released` 目标与 `NOMAD_NODEPOOL_APM_VERSION` 开关：未设置时（默认）从源码构建并上传到客户端的 `fc-env-pipeline` bucket；设置为例如 `NOMAD_NODEPOOL_APM_VERSION=v0.1.0` 时跳过构建，改为从公开的 `https://storage.googleapis.com/e2b-artifact-binaries/nomad-nodepool-apm/<version>/` 下载已发布的 `nomad-nodepool-apm` 与 `nomad-deployment-aware-target`。两个插件同版本一起发布。根 `Makefile` 的 `build-and-upload` 聚合目标在 2026.30 新增了 `build-and-upload/nomad-nodepool-apm`。

---

## 1. 系统位置

> ⓘ **以下（§1 ~ §8）为历史档案**，描述 2026.29 及以前的实现与部署方式。其中 `iac/**` 路径在 2026.30 已不存在，链接已失效；§3 与 §5 的计数语义已被 2026.30 推翻（见 §零.2）。

```text
template-manager Nomad job
  scaling check: source=nomad-nodepool-apm, query=<node_pool>
                         |
                         v
                Nomad Autoscaler agent
                         |
                  go-plugin RPC
                         v
              nomad-nodepool-apm
                         |
                         | Nomad HTTP API: Nodes.List(filter)
                         v
                    Nomad server
```

- 它是指标源，不是常驻业务 HTTP 服务，也不代理 sandbox 流量。
- “APM” 是 Nomad Autoscaler 的插件类别；这里没有应用 tracing 或日志采集含义。
- IaC 只在 build cluster 规模大于 1 时部署该插件、autoscaler job 与 template-manager scaling stanza；单节点 build cluster 使用固定 allocation。
- 部署后，它只调整 template-manager service job 的 allocation 数，不伸缩云 VM、orchestrator 或 client-proxy。
- 目标效果是“每个可调度节点一个 template-manager allocation”，同时保留 service job 的 rolling update 能力。

## 2. 启动/装配

`packages/nomad-nodepool-apm/main.go` 只有一个入口：`plugins.Serve(factory)`。Nomad Autoscaler 通过 HashiCorp go-plugin 启动二进制并取得 APM 接口实现。

满足上述多节点条件时，部署链路由 IaC 完成：

1. 构建静态 Linux amd64 二进制并上传到 GCS 或 S3。
2. autoscaler Nomad job 把二进制下载到 `local/plugins/nomad-nodepool-apm`。
3. 启动 autoscaler agent 时传入 `-plugin-dir local/plugins`。
4. agent 配置声明 `apm "nomad-nodepool-apm"`，driver 也使用同名值。
5. `SetConfig` 从插件 config 覆盖 Nomad address、token、region 和 namespace。
6. 未显式覆盖的值由 `api.DefaultConfig()` 读取标准 Nomad 环境变量和默认值。

二进制名、`PluginName`、APM block、driver 和 scaling check 的 source 必须一致为 `nomad-nodepool-apm`。

## 3. 核心机制与关键对象

### `NodePoolPlugin`

对象只保存三个东西：Nomad API client、原始 config map 和 hclog logger。`SetConfig` 创建 client，`PluginInfo` 返回插件 name/type，`Query` 产生单条指标。

### Query 语义

scaling check 的 `query` 原样作为 node pool 名：

```text
NodePool == "<escaped query>"
```

插件先对反斜杠和双引号转义，再传给 Nomad filter expression，避免 query 改写 filter。

Nomad 返回候选节点后，插件只计数同时满足：

- `node.Status == ready`
- `node.SchedulingEligibility == eligible`

结果是一个 `TimestampedMetric{Timestamp: time.Now(), Value: count}`。传入的 `TimeRange` 不参与计算，因为这是当前 Nomad 状态的瞬时值，不是历史时序查询。

### `QueryMultiple`

Dynamic Application Sizing 接口要求多组时序。该插件不产生维度拆分，只调用 `Query`，再把同一组 metrics 包成长度为 1 的数组。

### Scaling policy

template-manager job 使用：

```hcl
check "match_node_count" {
  source = "nomad-nodepool-apm"
  query  = "<node_pool>"
  strategy "pass-through" {}
}
```

pass-through 把指标值直接当作 desired count；job 的 `min`、`max`、cooldown 和 evaluation interval 仍由 Nomad Autoscaler policy 处理。

## 4. 主请求或数据流

```text
每次 scaling evaluation
  -> autoscaler 调用 Query(query=node pool, timeRange)
  -> 检查 query 非空
  -> escape(query)
  -> Nomad Nodes().List(Filter: NodePool == "...")
  -> 遍历节点
       ready && eligible -> count++
       down / initializing / ineligible -> ignore
  -> 返回 [timestamp=now, value=count]
  -> pass-through strategy 得到 desired allocation count
  -> Nomad target 更新 template-manager group count
  -> distinct_hosts 约束把 allocation 分散到不同节点
```

在仓库的 job spec 中，evaluation interval 是 10 秒，cooldown 是 2 分钟，template-manager group 还设置 `distinct_hosts = true` 和串行 rolling update。

## 5. 设计不变量与故障边界

- 指标表示“当前 ready + eligible 节点数”，不是 node pool 总节点数、运行 allocation 数或空闲容量。
- drain 后变为 scheduling-ineligible 的节点不会计入 desired count，即使 Nomad 仍保留其 node record。
- `query` 为空直接返回错误，不会把它解释为所有 node pool。
- filter value 必须转义，node pool 名不能突破引号注入额外筛选条件。
- Nomad API 查询失败时本次 Query 返回错误，不会伪造零值；如何保留旧 desired count 由 autoscaler 决定。
- 插件没有内部 cache，每次 evaluation 都读取 Nomad 当前状态。
- plugin config 中的 ACL token只用于构造 Nomad client，不出现在返回 metric 中。
- policy 的 min/max 可能钳制插件返回值；因此最终 allocation 数不保证严格等于节点数。
- `distinct_hosts` 保证至多每 host 一个 allocation，但若调度约束或资源不足，desired count 不保证都能落地。
- 插件只观察 node pool，不负责确认每台节点上的 template-manager health。
- `QueryMultiple` 不提供按 region、namespace 或节点状态拆分的多指标语义。

## 6. 与其他组件边界

| 相邻组件 | 插件负责 | 对方负责 |
| --- | --- | --- |
| Nomad Autoscaler | 提供 APM Query/QueryMultiple 指标 | 周期、cooldown、strategy、target 更新 |
| Nomad server | 构造 filter、读取并筛选 node list | 节点状态、资格与 node pool 权威数据 |
| template-manager job | 给出 node pool 的当前 ready/eligible 数 | min/max、distinct_hosts、rolling update |
| 云 MIG / ASG | 无交互 | 增减承载 Nomad client 的 VM |
| orchestrator | 无直接调用 | 在 client node 上运行 sandbox runtime |
| API / scheduler | 无直接调用 | 发现节点并调度 sandbox/template build |

## 7. 源码阅读顺序

> ⛔ **表中第 4、5、7、8 条指向 `iac/**`，这些文件在 2026.30 已随整个 `iac/` 目录删除，链接失效。** 第 1、2、3、6 条（`packages/nomad-nodepool-apm/**`）在 2026.30 仍然有效；阅读第 2 条时请以 §零.2 的 2026.30 语义为准。

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | `packages/nomad-nodepool-apm/main.go` | 看外部插件进程入口和 factory |
| 2 | `packages/nomad-nodepool-apm/plugin/plugin.go` | 看完整 APM interface、filter 与计数规则 |
| 3 | `packages/nomad-nodepool-apm/README.md` | 看独立构建、配置和 query 示例 |
| 4 | `iac/modules/job-template-manager-autoscaler/jobs/nomad-autoscaler.hcl` | 看二进制下载、plugin-dir 与 APM block |
| 5 | `iac/modules/job-template-manager/jobs/template-manager.hcl` | 看 scaling check、pass-through 与 distinct_hosts |
| 6 | `packages/nomad-nodepool-apm/Makefile` | 看 GCS/S3 artifact 发布路径 |
| 7 | `iac/provider-gcp/nomad/main.tf` | 看 GCP artifact generation 进入部署参数 |
| 8 | `iac/provider-aws/nomad/main.tf` | 看 AWS artifact ETag 进入部署参数 |

注意：package README 的配置示例仍使用旧名字 `nomad-nodepool`；当前源码和 IaC 的权威标识是 `nomad-nodepool-apm`。（原文的「和 IaC」在 2026.30 已无对应物 —— IaC 侧全部删除，标识的权威来源只剩源码与 README。）

## 8. 相关深挖

- [Node / Cluster 系统详解](../node-module.md)
- [Template 模块详解](../template-module.md)
- [Orchestrator 模块详解](../orchestrator-module.md)
- [Template Build 流程](../template-build-flow.md)

---

> **文档版本**：已同步至 **2026.30**。§零 描述 2026.30 的包状态与行为变更；§1 ~ §8 为 2026.29 及以前的历史档案，其中 `iac/**` 路径均已失效，§3/§5 的计数语义已被 §零.2 取代。
