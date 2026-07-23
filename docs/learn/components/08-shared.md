# Shared：跨服务运行时契约

> `packages/shared` 是 API、Client Proxy、Orchestrator、Template Manager 与 Envd 共同依赖的 Go 基础库，统一跨进程协议、存储语义、遥测、日志、代理和基础并发原语。

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

`proxy.Proxy` 组合 Host/请求头解析、目标选择、连接池、重试、H2C 和错误页。业务服务提供“如何找到目标”，共享层负责连接复用和稳定的 HTTP 行为。

`clusters/discovery` 从 Nomad allocations 读取正在运行的 orchestrator 与 template-manager，并把 Nomad node name 作为云实例可识别的节点 ID。

### 3.4 事件与动态开关

`events.Delivery[T]` 把发布者与 Redis Streams、Redis Pub/Sub、noop 或 ClickHouse 等后端解耦。事件结构保留版本、UUID、sandbox/build/template/team/execution 维度与可配置 TTL。

Feature Flag 类型封装 fallback，并自动附加 deployment、service、team、sandbox、template 等多上下文。无密钥时不发网络请求，所有评估使用本地 fallback，因此开发环境行为仍然确定。

### 3.5 协议与通用原语

`pkg/grpc` 保存 orchestrator、template-manager、proxy、envd 的生成客户端/服务端类型，以及 server、shutdown、channelz 和 metadata 辅助逻辑。生成的 `*.pb.go`/`*.connect.go` 是跨模块 ABI，不应手改。

`cache`、`redis`、`limit`、`retry`、`synchronization`、`smap`、`syncroaring` 和 `utils` 提供并发安全、锁、限流和生命周期原语；它们服务于共享契约，不应承载某个业务模块的状态机。

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

主要故障域彼此独立：OTel 故障影响观测，Redis 故障影响缓存/路由/事件，Loki 故障影响日志查询，GCS/S3 故障影响模板与快照；调用服务负责决定降级还是终止业务操作。

## 6. 与其他组件边界

| 对方 | Shared 提供 | 对方保留的职责 |
| --- | --- | --- |
| API | auth 周边原语、Redis、ClickHouse/Loki 接口、gRPC 类型 | HTTP 业务规则、数据库事务、租户授权 |
| Client Proxy | proxy、catalog、metadata、feature flags | paused sandbox 恢复决策与公开监听配置 |
| Orchestrator | FC client、storage、events、telemetry、协议类型 | microVM、网络、快照和生命周期状态机 |
| Template Manager | storage、registry、Nomad discovery、telemetry | 构建调度和模板产物生成 |
| Envd | Connect/gRPC 生成类型、filesystem model | VM 内进程、文件系统与 cgroup 操作 |
| ClickHouse package | telemetry、logger、events、feature flags | SQL、batch insert、查询与迁移 |
| IaC/Collectors | 环境变量和 OTLP/HTTP 契约 | 端口、服务发现、数据后端和保留策略 |

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
| 8 | `packages/shared/pkg/proxy/` | Host 解析、连接池和错误映射如何组合？ |
| 9 | `packages/shared/pkg/grpc/` | 跨服务 RPC 契约有哪些？ |
| 10 | `packages/shared/pkg/cache/`、`redis/`、`utils/` | 上层依赖了哪些并发与缓存语义？ |

## 8. 相关深挖

- [Client Proxy 模块](../../md/client-proxy-module.md)：shared proxy、catalog 与自动恢复的实际组合。
- [沙箱流量路由](../../md/sandbox-traffic-routing.md)：公网 Host 到 orchestrator-proxy 的完整路径。
- [Orchestrator 模块](../../md/orchestrator-module.md)：storage、Firecracker client 和 gRPC 契约的主要消费者。
- [快照原理](../../md/snapshots.md)：header、缓存、对象存储与恢复边界。
- [Envd 模块](../../md/envd-module.md)：shared 生成协议在 microVM 内的实现端。
