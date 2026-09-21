# E2B Infra 项目全景

> E2B Infra 的核心，是把一次“创建并连接沙箱”的请求，转换为一台可隔离、可暂停、可恢复、可观测的 Firecracker microVM，并让客户端始终通过稳定入口访问它。

## 1. 先建立三个平面

理解这个仓库时，不要先按目录记文件。先把系统拆成三个相互协作的平面。

| 平面 | 回答的问题 | 主要组件 |
|---|---|---|
| 控制面 | 谁能创建什么、放到哪里、生命周期如何变化 | `api`、`auth`、`dashboard-api`、`db` |
| 数据面 | 请求最终怎样进入 microVM，进程和文件怎样被操作 | `client-proxy`、`orchestrator`、`envd` |
| 支撑面 | 服务怎样发现、观测和共享协议 | `shared`（含 `servicediscovery`）、`clickhouse`、OTel |

这三个平面不是三个独立系统。一次真实请求通常会跨越它们：控制面决定目标和权限，数据面执行动作，支撑面提供状态、协议和运行环境。

> ⛔ **2026.30 把 `iac` 从支撑面里删掉了。** 本仓库不再包含部署 IaC：`iac/`（172 文件）、根目录 `self-host.md` 全部删除，根 `Makefile` 移除了所有 Terraform/Nomad 目标。（`packages/docker-reverse-proxy/`，19 文件 → 0，也在 2026.30 消失，但由更早的 `d153bbe9d` 删除，不属于同一次退役。）支撑面现在只剩"跨服务契约 + 观测 + 服务发现"这些**仓库内**的职责。详见 [§13 2026.30 变动小结](#13-202630-变动小结)。

## 2. 一张最小系统图

```text
SDK / CLI / Dashboard
        |
        | REST: 管理请求
        v
  API / Dashboard API ---- Auth ---- OIDC / API Key
        |
        +---- PostgreSQL: 用户、团队、模板、构建、快照元数据
        |
        | gRPC: 创建、更新、暂停、恢复、删除
        v
  Orchestrator node ---- Firecracker ---- envd inside microVM
        ^                                      |
        |                                      | process / filesystem API
        | HTTP sandbox traffic                 |
  Client Proxy ---- Redis sandbox catalog -----+

  Orchestrator / API ---- OTLP ---- OTel Collector ---- metrics / trace backends
  Envd ---- HTTP JSON ---- Orchestrator /logs ---- Vector ---- Loki
```

这里最重要的边界是：

- PostgreSQL 保存业务事实，但不承载高频沙箱流量。
- Redis catalog 保存“运行中的 sandbox 在哪个 orchestrator”这类短生命周期路由事实。
- Orchestrator 拥有节点内 microVM 的运行状态，API 不直接操作 Firecracker。
- Envd 运行在 microVM 内，是进程、文件与初始化能力的最终执行者。
- Client Proxy 不决定业务权限归属，它解析目标、查询 catalog，并把流量送到正确节点。

## 3. 创建一个沙箱时发生什么

```text
1. SDK -> API
   提交 template、timeout、环境变量、网络等期望状态；CPU/内存来自 template build

2. API -> Auth + PostgreSQL
   解析调用身份与 team，验证额度和模板/构建元数据

3. API -> placement -> Orchestrator gRPC
   从可用节点中选址，请节点创建 sandbox

4. Orchestrator -> local runtime
   分配网络 slot、准备 rootfs/快照、启动 Firecracker、注入 MMDS

5. Orchestrator -> Envd
   等待 VM 内 daemon 就绪，执行 /init，建立可用状态

6. 创建链路 -> sandbox catalog
   默认由 API（cloud）在 Create 返回后写 Redis 的 sandbox:catalog:{id}；
   BYOC 集群由集群 edge 从 gRPC metadata 取 catalog create/delete event 处理

7. API -> SDK
   返回 sandbox 标识和连接所需信息
```

这条链路把“声明一个沙箱”与“真的启动一台 VM”分开。API 负责业务判断和跨节点协调，Orchestrator 负责单节点资源与运行时细节。

## 4. 连接沙箱时发生什么

管理请求和沙箱流量走不同入口。创建、暂停和删除进入 API；访问沙箱端口进入 Client Proxy。

```text
SDK
 |
 | Host: {port}-{sandboxID}.{domain}
 | 或 E2b-Sandbox-Id / E2b-Sandbox-Port
 v
Client Proxy
 |
 | Redis catalog: sandboxID -> orchestrator IP
 v
Orchestrator proxy :5007
 |
 | 节点内 sandbox network mapping
 v
Envd / user process inside microVM
```

如果 catalog 中没有目标，Client Proxy 可以调用 API 的 Resume gRPC 入口尝试自动恢复已暂停沙箱。恢复成功时 API 直接返回新的 orchestrator IP，Client Proxy 用这个返回值继续当前请求；catalog 发布会随恢复链路发生，但不是当前请求转发前必须重读或等待的屏障。

> ⚠️ **2026.30 起"路由 catalog"其实是两条记录并存**：API 持有的 `sandbox:catalog:{id}`（默认，也是事实来源）与 orchestrator 持有的 `sandbox:routing:{id}`（v1 测试路径，由 `orchestrator-routing-publish` / `orchestrator-routing-prioritized` 两个 flag 门控，且 miss 时不回退）。本节及下文按**默认路径**叙述。详见 [架构总览 §沙箱路由记录](../architecture-overview.md#沙箱路由记录)。

## 5. 暂停与恢复为什么是核心能力

暂停不是简单地停止进程。系统需要保留足够状态，使沙箱之后可以在同一节点或另一节点继续运行。

```text
Pause
  API -> 先删除可见路由，阻止新流量
      -> Orchestrator MarkStopping
      -> 冻结 VM 内工作负载
      -> Firecracker snapshot / memory state
      -> rootfs diff 与元数据持久化
      -> 远端 snapshot 产物可继续异步上传

Resume
  API -> 读取 snapshot 元数据
      -> 重新选址
      -> Orchestrator 加载模板 + snapshot
      -> 恢复 VM 与 envd
      -> 重新发布 catalog 路由
```

因此，快照元数据、对象存储中的实际产物、节点缓存和 catalog 必须保持清晰的所有权边界。任何一步失败都不能把“不完整的运行实例”发布给流量入口。

## 6. 模板为什么不是普通容器镜像

模板是沙箱启动的根。模板构建流程最终准备的是 Firecracker 可消费的 rootfs 和相关构建产物，而不是只保存一条 Docker image 引用。

```text
Template definition
  -> API 注册 build
  -> template-manager 执行构建
  -> 生成并上传 rootfs / manifest
  -> PostgreSQL 更新 build 状态
  -> Orchestrator 按 build ID 缓存并启动 VM
```

模板、build、alias/tag 是不同概念：模板表示长期身份，build 表示一次不可混淆的构建产物，alias/tag 提供面向用户的可变名字。

## 7. 状态分别放在哪里

| 状态 | 权威存储或所有者 | 典型读者 |
|---|---|---|
| 用户、团队、权限关系 | PostgreSQL | API、Dashboard API、Auth |
| 模板、build、snapshot 元数据 | PostgreSQL | API、template manager |
| sandbox 当前节点路由 | Redis catalog | Client Proxy、API、Orchestrator |
| 节点内运行实例 | Orchestrator 进程内状态 | gRPC server、proxy、metrics |
| rootfs、snapshot 等大对象 | GCS/S3 或 Local 对象存储；NFS 只可作为底层 provider 的缓存 | Orchestrator、template manager |
| 高频指标与事件 | ClickHouse / OTel 后端 | API 查询、监控与计量 |
| 沙箱与模板构建日志 | 默认 Loki（Vector 写入）；迁移期可切 ClickHouse 的 `sandbox_logs` | API 日志读端点、Grafana |
| API 契约和跨服务消息 | OpenAPI / protobuf，生成到各 Go module | 服务端与客户端 |

判断一个修改是否正确时，先问“哪一份状态是权威来源”。缓存、catalog 和本地 map 都不能悄悄变成第二份业务真相。

## 8. 跨组件不变量

### 身份不变量

认证成功不等于授权完成。Auth 先把用户或 key 解析成 team 上下文，具体 handler 仍要按 team 约束资源查询，避免只按资源 ID 访问。

### 生命周期不变量

只有完成运行时初始化的 sandbox 才能被流量发现；删除或暂停时，应先阻止新流量，再回收底层资源。

### 协议不变量

OpenAPI 与 protobuf 是跨组件边界。字段编号、认证 scheme、错误码和 header 名称都属于兼容性契约，不是实现细节。

### 资源不变量

网络 slot、NBD 设备、文件描述符、goroutine 和连接池都有明确释放路径。创建流程中途失败时，清理顺序与成功路径同样重要。

### 可观测性不变量

指标维度必须可控，敏感连接串和 token 不能进入日志；计数器和 gauge 的聚合语义要与 ClickHouse 查询一致。

## 9. 推荐阅读顺序

| 顺序 | 组件文档 | 先回答的问题 |
|---:|---|---|
| 1 | [API](01-api.md) | 外部请求怎样变成业务动作？ |
| 2 | [Auth](02-auth.md) | 身份怎样变成 team 上下文？ |
| 3 | [Dashboard API](03-dashboard-api.md) | 控制台业务为什么单独成服务？ |
| 4 | [DB](04-db.md) | 业务事实如何建模与迁移？ |
| 5 | [Client Proxy](05-client-proxy.md) | 沙箱端口流量怎样寻址？ |
| 6 | [Orchestrator](06-orchestrator.md) | 一台节点怎样管理 microVM？ |
| 6A | [Orchestrator 源码专章](../orchestrator-module.md) | 启动、运行、快照和清理如何按模块协作？ |
| 7 | [Envd](07-envd.md) | VM 内部怎样执行进程与文件操作？ |
| 8 | [Shared](08-shared.md) | 跨服务契约和基础能力放在哪里？ |
| 9 | [ClickHouse](09-clickhouse.md) | 高频指标和事件怎样写入与查询？ |
| 10 | [IaC](10-iac.md) ⛔ | 这些服务怎样变成真实部署？（**描述的是 2026.29 及之前**） |
| 11 | [Docker Reverse Proxy](11-docker-reverse-proxy.md) ⛔ | 模板构建怎样安全访问镜像仓库？（**描述的是 2026.29 及之前**） |
| 12 | [Nomad Nodepool APM](12-nomad-nodepool-apm.md) | 节点池怎样向 autoscaler 暴露指标？ |
| 13 | [Local Dev 与 OTel](13-local-dev-observability.md) | 本地依赖与遥测管道怎样复现？ |

> ⛔ **第 10、11 项的主题在 2026.30 已从仓库删除**：`iac/`（Terraform + Nomad job）与 `packages/docker-reverse-proxy/` 都不再存在。这两篇文档保留为**历史档案**，用于理解旧部署路径的设计；当前状态请看 [架构总览 §部署拓扑](../architecture-overview.md#部署拓扑)。第 12 项（`nomad-nodepool-apm`）**仍然有效**——该插件目录还在仓库里，只是它服务的 Nomad 部署路径退役了。

## 10. 阅读源码的方法

每个组件都按以下顺序阅读，通常比从目录第一行开始更快：

1. 从 `main.go` 或 module 的公开入口确认依赖装配。
2. 找 OpenAPI/protobuf/接口，先看边界而不是实现。
3. 选择一条主链路，沿 handler、service、repository/client 向下走。
4. 单独检查状态机、并发所有权、timeout 和 cleanup。
5. 最后读测试，用测试确认异常路径和兼容性假设。

## 11. 第一批源码锚点

| 文件 | 作用 |
|---|---|
| `go.work` | 列出仓库内 Go module 边界 |
| `packages/api/main.go` | 控制面 API 的完整装配入口 |
| `packages/orchestrator/main.go` | 节点运行时模式选择与启动入口 |
| `packages/envd/main.go` | microVM 内 daemon 的服务装配 |
| `packages/client-proxy/main.go` | 沙箱流量入口、catalog 与 auto-resume 装配 |
| `packages/shared/pkg/grpc/` | 跨服务 protobuf 契约 |
| `packages/db/migrations/` | PostgreSQL 业务模型的演进历史 |
| `packages/shared/pkg/servicediscovery/` | 节点发现后端：Kubernetes / DNS / 静态列表 / legacy Nomad（2026.30 新建） |
| `packages/api/internal/orchestrator/placement/` | best-of-K 选点实现 |
| `packages/orchestrator/pkg/routing/` | orchestrator 持有的路由记录写入（flag 门控） |

## 12. 深挖入口

- [Sandbox 端到端生命周期](../sandbox-lifecycle.md)
- [Sandbox 流量路由](../sandbox-traffic-routing.md)
- [模板构建流程](../template-build-flow.md)
- [认证子系统](../auth-module.md)
- [数据库表与关系](../database-schema.md)
- [Orchestrator 深度剖析](../orchestrator-module.md)
- [架构总览（已同步至 2026.30）](../architecture-overview.md)

## 13. 2026.30 变动小结

本模块描述的是"项目全景"，因此受 2026.30 影响的主要是**支撑面与部署拓扑**部分。按"删除 / 新增 / 改写"列出：

### 13.1 ⛔ 删除（不再存在于仓库）

| 对象 | 说明 | 本模块受影响处 |
|---|---|---|
| `iac/`（172 文件） | Terraform（`provider-gcp/`、`provider-aws/`）+ Nomad job spec + 共享模块 | §1 支撑面、§9 阅读顺序第 10 项、§11 源码锚点 |
| `packages/docker-reverse-proxy/`（19 文件） | Docker Registry v2 认证网关（:5000） | §9 阅读顺序第 11 项 |
| 根目录 `self-host.md` | 自托管指南 | —— |
| 根 `Makefile` 的 Terraform/Nomad 目标 | `plan`、`apply`、`init`、`build-and-upload` 等 | §10 阅读源码的方法（无直接影响） |
| `.github/workflows/` 四个工作流 | `publish.yml`、`release-please.yml`、`validate-iac.yml`、`build-and-upload-images.yml` | —— |
| `Consul KV` | orchestrator 的网络 slot 分配状态（跨重启） | §7 状态表（本模块本来就没列它；slot 分配改为按节点本地 netns 状态） |
| `access_tokens` 表与 `sk_e2b_` 凭证 | 用户级 access token 完全退役 | 见 [`access-tokens-module.md`](../access-tokens-module.md) |

相关提交：`8a1c48884406b909f64c1239c808d0bc1cbf05bf` "chore(deploy): retire Nomad-based deployment ahead of a new deploy path"。

### 13.2 ✅ 新增（2026.30 才有）

| 对象 | 说明 | 本模块受影响处 |
|---|---|---|
| `packages/shared/pkg/servicediscovery/` | 节点发现后端：Kubernetes、DNS、静态列表、legacy Nomad | §1 支撑面、§11 源码锚点 |
| 双路由记录 | API 持有的 `sandbox:catalog:{id}`（默认）vs orchestrator 持有的 `sandbox:routing:{id}`（flag 门控、miss 不回退） | §4 连接沙箱、§7 状态表 |
| volume-content API（belt） | 卷内容的独立 API，`api.<domain>`，由 API 铸造短生命周期 JWT（`aud` 绑定 origin） | 新增的平面边界，见 [架构总览](../architecture-overview.md#卷内容) |
| API 的 Secrets / Workload identity / Rig 透传 | 三个新的 API 能力面 | 控制面职责扩大 |
| ClickHouse 可选日志 | `sandbox_logs` + `logs-read-config` 迁移期读路径 | §7 状态表 |
| `project_limits` 表 | 按团队配额覆盖，`team_limits` 视图优先读它 | §7 状态表 |

### 13.3 🔁 改写

| 主题 | 2026.29 | 2026.30 |
|---|---|---|
| 部署方式 | Terraform 部署到 Nomad + Consul 集群（server/api/default/build/clickhouse 五池） | **与调度器无关的二进制/容器；官方支持的运行方式是 Kubernetes 发行版**（控制面 / 沙箱节点 / 构建节点 / 分析四池） |
| 节点发现 | Nomad、Kubernetes 或静态列表 | 同上，但实现收敛到 `packages/shared/pkg/servicediscovery`，Nomad 后端被标为 legacy |
| 沙箱节点运行方式 | Nomad *system* job + `raw_exec`（需要 root） | 直接在宿主机上运行 orchestrator（同样需要 root） |
| 沙箱代理 | 只走 HTTP | 走 HTTP 或配置的 HTTPS（后端可用自签名证书） |
| 日志管道 | Vector → Loki | 默认仍是 Vector → Loki，但可动态选择主/shadow collector，并可切到 ClickHouse |

### 13.4 一条不变的判断准则

§8 的跨组件不变量在 2026.30 全部仍然成立。特别地，"**先问哪一份状态是权威来源**"这条在路由记录上变得更关键了：现在物理上存在两条路由记录，但**只有 API 持有的那条是事实来源**，orchestrator 持有的那条是 v1 测试路径。

---

> 文档版本：已同步至 **2026.30**（提交 `f32ee8a2a50052f32e3632ceb451111a98dd5104`）。
