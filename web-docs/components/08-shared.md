# Shared：跨服务运行时契约

> `packages/shared` 是 API、Client Proxy、Orchestrator、Template Manager 与 Envd 共同依赖的 Go 基础库，统一跨进程协议、存储语义、遥测、日志、代理和基础并发原语。

## 0. 2026.30 变动速览

这一版 `packages/shared/pkg/` 的目录增删如下（`diff` 两个 tag 的目录列表即可复现）：

| 变化 | 包 | 说明 |
| --- | --- | --- |
| ➕ 新增 | `servicediscovery/` | **本版最重要的收敛**。原先分散在 API 包内的两套服务发现实现（`packages/api/internal/clusters/discovery/` 与 `packages/api/internal/orchestrator/discovery/`）全部删除，统一到这里。含 `provider/`、`dns/`、`nomad/`、`kube/` 四个后端目录 |
| ➕ 新增 | `secretsstore/` | Project secret 的**名字校验**（`name.go`） |
| ➕ 新增 | `networktransform/` | 网络 transform 规则的**占位符替换**（`placeholders.go`），被 `api/internal/handlers/sandbox_create.go` 使用；它自己又依赖 `secretsstore`，也就是说 transform 规则里可以引用 secret |
| ➕ 新增 | `azure/` | Azure 凭据（`credential.go`） |
| ➕ 新增 | `acr/` | Azure Container Registry 支持（`acr.go`），被 `artifacts-registry/registry_azure.go` 与 `dockerhub/repository_azure.go` 使用 |
| ➖ 删除 | `syncroaring/` | 并发位图原语，本版移除 |

> ⚠️ **`servicediscovery/` 是 2026.30 新建的目录，2026.29 完全不存在。** 如果你在 2026.29 的代码里找 `packages/shared/pkg/servicediscovery`，找不到是正常的。
>
> ⚠️ `servicediscovery/provider/` 子包在 2026.30 **没有任何调用方**——`git grep "servicediscovery/provider" 2026.30 -- '*.go'` 返回空。它是这次收敛时一并搬过来的、留给后续服务接线的入口。API 走的是自己的 switch（见 §3.3）。

## 1. 系统位置

它不是一个可独立启动的服务，而是被多个二进制在编译期链接进去。

```text
API ───────────────┐
Client Proxy ──────┤
Orchestrator ──────┼──> packages/shared
Template Manager ──┤      ├── grpc / http 契约
Envd ──────────────┘      ├── telemetry / logger
                          ├── storage / cache
                          ├── proxy / sandbox catalog
                          └── events / feature flags / utils
```

这个包的核心价值不是“工具函数很多”，而是让服务共享同一组边界语义：对象不存在如何表示、日志有哪些关联字段、gRPC 如何观测、沙箱如何定位、云存储如何切换。

## 2. 启动/装配

`packages/shared` 没有统一入口，调用方按能力装配。

1. 服务读取环境变量并调用 `telemetry.New`；未设置 `OTEL_COLLECTOR_GRPC_ENDPOINT` 时得到 noop client。
2. 调用方用 `logger.GetOTELCore` 和 `logger.NewLogger` 组合 OTLP 日志、控制台输出及固定字段，再替换全局 logger。
3. `featureflags.NewClient` 根据 `LAUNCH_DARKLY_API_KEY` 选择在线客户端或完全离线的数据源。
4. Orchestrator/Template Manager 通过 `storage.GetStorageProvider` 按 `STORAGE_PROVIDER` 选择 GCS、S3 或本地文件系统。
5. API、代理和编排器按需创建 Redis cache、事件 delivery、sandbox catalog、Loki 查询器与 gRPC server/client。
6. 退出时必须先停止生产请求，再关闭 delivery、遥测 provider、存储连接和后台观察器，使缓冲数据有机会落盘。

关键装配入口：

| 能力 | 构造入口 | 配置开关 |
| --- | --- | --- |
| 三类遥测 | `telemetry.New` | `OTEL_COLLECTOR_GRPC_ENDPOINT` |
| 结构化日志 | `logger.NewLogger` | 调用方传入 service/internal/debug |
| Feature Flag | `featureflags.NewClient` | `LAUNCH_DARKLY_API_KEY` |
| 模板与构建存储 | `storage.GetStorageProvider` | `STORAGE_PROVIDER` |
| 沙箱目录 | `sandboxcatalog.NewRedisSandboxCatalog` | Redis client |
| 反向代理 | `proxy.New` | 目标解析函数、连接池参数 |
| gRPC server | `grpc.NewGRPCServer` | telemetry client 与 server options |

## 3. 核心机制与关键对象

### 3.1 遥测与日志

`telemetry.Client` 同时持有 meter、tracer、log provider 和 W3C Trace Context/Baggage propagator。指标每 15 秒导出；直方图使用 base-2 exponential aggregation，快照和上传字节指标还有专门 view；exemplar 默认关闭以控制 Mimir 写入量。

`logger.TracedLogger` 在每条日志上补充当前 span 的 `trace_id`、`span_id`，并保留 edge trace id。`service`、`internal` 和 `pid` 是构造期固定字段，Vector 依赖 `internal` 区分用户可见日志和内部日志。

### 3.2 存储契约

`StorageProvider` 只暴露前缀删除、签名上传 URL、`Blob`、`Seekable` 和后端描述。GCS、S3、本地文件系统都必须实现相同错误与读取语义。

`Seekable` 支持范围读取和整文件写入；压缩帧表与 `header` 子包保存可随机访问的映射。V3/V4/V5 header、diff metadata、checksum、对象来源和软删除 metadata 都属于快照兼容协议，不只是内部序列化细节。

`TemplateStorageConfig` 与 `BuildCacheStorageConfig` 延迟读取路径和 bucket 名，允许测试在运行时覆盖环境变量。

### 3.3 路由与服务发现

`sandbox-catalog` 把 `sandbox_id` 映射为 orchestrator ID/IP、execution ID 与生命周期信息，Redis key 是流量路由的快速索引。

**2026.30 起同一个类型跑两个 key 前缀**（`packages/shared/pkg/sandbox-catalog/catalog_redis.go`）：

| 构造函数 | key 前缀 | 写入方 |
| --- | --- | --- |
| `NewRedisSandboxCatalog` | `sandbox:catalog:` | API |
| `NewRedisSandboxRoutingCatalog` | `sandbox:routing:` | **orchestrator**（2026.30 新增） |

删除语义也在 2026.30 变了两处：

- **从两轮往返改成一条原子 Lua 脚本** `deleteIfSameExecution`。2026.29 是 `Get` 之后 `Del`；中间窗口里并发 `StoreSandbox` 写下的新 execution 会被这个迟到的删除误删。脚本在服务端一次完成比较与删除，返回 4 种 outcome（`catalogDeleteAbsent` / `Deleted` / `Mismatch` / `Unreadable`），后两种都是"条目保留"。
- **拆成 `DeleteSandboxStrict` 与 `DeleteSandbox`**。前者返回 Redis 错误，后者把错误记 warning 后吞掉（条目最终靠 TTL 过期），需要知道删除是否真的落到 Redis 的调用方必须用 Strict 变体。

> ⚠️ **key 不存在、execution 不匹配、值解不开，这三者在 `DeleteSandboxStrict` 里都不是错误。** 只有 Redis 本身出错才是。所以"删除没报错"不等于"条目被删掉了"。

`proxy.Proxy` 组合 Host/请求头解析、目标选择、连接池、重试、H2C 和错误页。业务服务提供“如何找到目标”，共享层负责连接复用和稳定的 HTTP 行为。

**`servicediscovery`（2026.30 新增）** 是"某个服务现在跑在哪些实例上"的统一抽象：

```go
// packages/shared/pkg/servicediscovery/servicediscovery.go
type Instance struct { /* WorkloadID、NodeID、Address、... */ }
func (i Instance) Address() string

type Discoverer interface { /* 列举当前实例 */ }

// NoSync 标记"不需要后台同步"的实现。
```

> ⚠️ **一个实例有两个身份，别当成一个。** `Instance` 同时带 `WorkloadID`（工作负载层，例如 Nomad allocation ID / K8s pod 名）和 `NodeID`（云实例层，例如 Nomad node name / K8s node 名）。云实例可识别的是 `NodeID`。把两者混用会让"同一个节点上的多个 orchestrator"变成无法区分。
>
> ⚠️ 错误语义要分清：`ErrNotYetSynced`（后端还没完成首次同步，**不是空集**）、`Cached`（包了一层缓存的 discoverer）、`NewMerged`（多个后端取并集）。

后端常量（[`provider/provider.go:19-25`](../../../packages/shared/pkg/servicediscovery/provider/provider.go)）：

| provider key | 后端 |
| --- | --- |
| `DNS` | `dns.New`，按 DNS 查询结果发现 |
| `STATIC` | `NewStatic`，静态地址列表 |
| `NOMAD` | `nomad.NewAllocationsOnPort`，从 Nomad allocations 发现 |
| `K8S-PODS` | `kube.NewPodsOnPort`，按 pod label selector 发现 |
| `NOMAD+K8S-PODS` | `NewMerged(nomad, k8s)`，**Nomad 为 primary，去重冲突时 Nomad 条目胜出** |

> ⚠️ 这些是 **provider 包自己的字符串**（大写），和 API 的 `SERVICE_DISCOVERY_PROVIDER` 取值（`nomad` / `kubernetes` / `nomad+kubernetes` / `local`，小写）**不是同一套**。而且差异不只是大小写：API 写 `kubernetes`，provider 包写 `K8S-PODS`；API 写 `local`，provider 包写 `STATIC`。`provider.New` 虽然用 `strings.ToUpper` 归一化（`provider.go:34`），但归一化救不了词不同——API 的取值喂进去会落进 `default` 报 `unsupported service discovery provider`。
>
> ⚠️ 另有一处易混：`packages/shared/pkg/clusters/discovery/nomad.go` 是 **`Allocation` 列举器**，不是 `Discoverer` 抽象。

### 3.4 事件与动态开关

`events.Delivery[T]` 把发布者与 Redis Streams、Redis Pub/Sub、noop 或 ClickHouse 等后端解耦。事件结构保留版本、UUID、sandbox/build/template/team/execution 维度与可配置 TTL。

Feature Flag 类型封装 fallback，并自动附加 deployment、service、team、sandbox、template 等多上下文。无密钥时不发网络请求，所有评估使用本地 fallback，因此开发环境行为仍然确定。

### 3.5 协议与通用原语

`pkg/grpc` 保存 orchestrator、template-manager、proxy、envd 的生成客户端/服务端类型，以及 server、shutdown、channelz 和 metadata 辅助逻辑。生成的 `*.pb.go`/`*.connect.go` 是跨模块 ABI，不应手改。

`cache`、`redis`、`limit`、`retry`、`synchronization`、`smap` 和 `utils` 提供并发安全、锁、限流和生命周期原语；它们服务于共享契约，不应承载某个业务模块的状态机。

> ⛔ **`syncroaring` 在 2026.30 已被删除**，不要在阅读顺序里找它。

### 3.6 Secret 名字与网络 transform 占位符（2026.30 新增）

这两个新包都服务于 2026.30 新增的 project secrets 能力：

- **`secretsstore`**：`name.go` 只做一件事——**secret 名字的合法性校验**。校验放在共享层而不是 API 侧，是因为名字会成为占位符的一部分，被 `networktransform` 和 `sandbox_create.go` 同时消费。
- **`networktransform`**：`placeholders.go` 负责网络 transform 规则里的**占位符替换**。它 import 了 `secretsstore`，所以 transform 规则可以引用 secret——这正是名字校验必须共享的原因。

### 3.7 Azure 镜像仓库支持（2026.30 新增）

- **`azure/credential.go`**：Azure 凭据获取。
- **`acr/acr.go`**：Azure Container Registry 客户端。

两者被 `artifacts-registry/registry_azure.go` 与 `dockerhub/repository_azure.go` 使用，也就是模板镜像拉取的 Azure 分支。

> ⚠️ 注意时序：**`packages/docker-reverse-proxy/` 在 2026.30 已整体删除**（19 文件 → 0），而 `packages/shared/pkg/dockerhub/` 与 `artifacts-registry/` **仍在**。别把"docker 相关的包"当成一个整体来理解——退役的是那个反向代理服务，不是 shared 里的镜像仓库客户端。

## 4. 主数据/部署流

```text
业务请求
  │
  ├─ HTTP/gRPC middleware ──> trace context ──> handler
  │                                      │
  │                                      ├─ logger: trace_id/span_id
  │                                      └─ metrics/traces/logs
  │                                                │ OTLP gRPC
  │                                                v
  │                                         node-local collector
  │
  ├─ sandbox_id ──> RedisSandboxCatalog ──> orchestrator IP
  │                                      └─> shared reverse proxy pool
  │
  ├─ lifecycle event ──> Delivery[T] ──> Redis stream / ClickHouse delivery
  │
  └─ snapshot/template bytes
       └─ StorageProvider
            ├─ GCPBucket -> GCS
            ├─ AWSBucket -> S3
            └─ Local     -> filesystem
```

## 5. 设计不变量与故障边界

- `OTEL_COLLECTOR_GRPC_ENDPOINT` 为空必须退化为 noop，而不是阻止服务启动。
- 日志和指标中不得记录原始云凭据、token 或含密码的 DSN；对外字段应使用脱敏 endpoint 或对象 ID。
- `STORAGE_PROVIDER` 的选择必须发生在统一 factory；业务代码不能按云厂商分叉快照逻辑。
- `ErrObjectNotExist`、软删除、metadata 不支持是不同状态；开启强制软删除检查时无法验证 metadata 必须 fail closed。
- header 版本和对象路径是持久化协议。修改 writer 前要验证旧 reader，修改 reader 前要保留旧对象兼容。
- Redis catalog 是加速路由的派生状态，不是沙箱生命周期的唯一事实源；miss 可能表示暂停，也可能是传播延迟或后端故障。
- 代理连接池有容量、重试和 idle timeout；达到容量要返回明确错误，不能无限创建连接。
- Feature Flag 不可用时必须使用代码内 fallback；关键正确性不能依赖 LaunchDarkly 在线。
- buffered delivery 的 `Close` 是数据边界；未调用会丢失队列中的事件或统计。
- Redis Cluster 的多 key 操作必须使用 `SameSlot` 形成相同 hash slot。
- **（2026.30）`ErrNotYetSynced` 不等于空集。** 服务发现刚启动、后端还没完成首次同步时返回的是这个错误。把它当成"没有实例"会导致误判为容量为零。
- **（2026.30）`Instance` 的 `WorkloadID` 与 `NodeID` 不可互换。** 需要云实例标识（打标签、查实例元数据、autoscaler）时必须用 `NodeID`。
- **（2026.30）`NewMerged` 的去重顺序是语义。** `NOMAD+K8S-PODS` 合并时 Nomad 是 primary，冲突条目由 Nomad 胜出——迁移窗口里这个方向决定了哪个后端"说话算数"。

主要故障域彼此独立：OTel 故障影响观测，Redis 故障影响缓存/路由/事件，Loki 故障影响日志查询，GCS/S3 故障影响模板与快照；调用服务负责决定降级还是终止业务操作。

## 6. 与其他组件边界

| 对方 | Shared 提供 | 对方保留的职责 |
| --- | --- | --- |
| API | auth 周边原语、Redis、ClickHouse/Loki 接口、gRPC 类型 | HTTP 业务规则、数据库事务、租户授权 |
| Client Proxy | proxy、catalog、metadata、feature flags | paused sandbox 恢复决策与公开监听配置 |
| Orchestrator | FC client、storage、events、telemetry、协议类型 | microVM、网络、快照和生命周期状态机 |
| Template Manager | storage、registry、`servicediscovery`、telemetry | 构建调度和模板产物生成 |
| Envd | Connect/gRPC 生成类型、filesystem model | VM 内进程、文件系统与 cgroup 操作 |
| ClickHouse package | telemetry、logger、events、feature flags | SQL、batch insert、查询与迁移 |
| Collectors / 部署侧 | 环境变量和 OTLP/HTTP 契约 | 端口、数据后端和保留策略 |

> ⚠️ 最后一行 2026.29 时写的是 "IaC/Collectors"，因为当时 `iac/` 还在。**`iac/` 已于 2026.30 整体删除**（172 文件 → 0，提交 `8a1c48884406b909f64c1239c808d0bc1cbf05bf`），根目录 `self-host.md` 同时删除，所以这一行只剩 Collectors。

## 7. 源码阅读顺序

| 顺序 | 路径 | 先回答的问题 |
| --- | --- | --- |
| 1 | `packages/shared/pkg/telemetry/main.go` | 服务何时启用/关闭遥测？ |
| 2 | `packages/shared/pkg/logger/logger.go` | 日志如何关联 trace，并区分 internal？ |
| 3 | `packages/shared/pkg/featureflags/client.go`、`flags.go` | 在线与离线评估如何保持一致？ |
| 4 | `packages/shared/pkg/storage/storage.go` | 云无关存储接口和 factory 是什么？ |
| 5 | `packages/shared/pkg/storage/header/` | 快照随机读取格式如何演进？ |
| 6 | `packages/shared/pkg/events/` | 生命周期事件如何与 delivery 解耦？ |
| 7 | `packages/shared/pkg/sandbox-catalog/` | 流量如何从 sandbox ID 找到节点？ |
| 8 | `packages/shared/pkg/servicediscovery/servicediscovery.go` | **2026.30 新增**：实例抽象与 `ErrNotYetSynced` |
| 9 | `packages/shared/pkg/servicediscovery/merged.go`、`cached.go` | 多后端并集与缓存包装的语义 |
| 10 | `packages/shared/pkg/proxy/` | Host 解析、连接池和错误映射如何组合？ |
| 11 | `packages/shared/pkg/grpc/` | 跨服务 RPC 契约有哪些？ |
| 12 | `packages/shared/pkg/cache/`、`redis/`、`utils/` | 上层依赖了哪些并发与缓存语义？ |

## 8. 相关深挖

- [Client Proxy 模块](../client-proxy-module.md)：shared proxy、catalog 与自动恢复的实际组合。
- [沙箱流量路由](../sandbox-traffic-routing.md)：公网 Host 到 orchestrator-proxy 的完整路径。
- [Orchestrator 模块](../orchestrator-module.md)：storage、Firecracker client 和 gRPC 契约的主要消费者。
- [快照原理](../snapshots.md)：header、缓存、对象存储与恢复边界。
- [Envd 模块](../envd-module.md)：shared 生成协议在 microVM 内的实现端。
- [Clusters 与多集群路由](../clusters-module.md)：`servicediscovery` 在 API 侧的实际消费点。
- [Node 与节点池](../node-module.md)：`Instance` 双身份（`WorkloadID` / `NodeID`）的下游影响。

---

*已同步至 **2026.30**。*
