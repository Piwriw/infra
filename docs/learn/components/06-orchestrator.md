# 06. Orchestrator

`orchestrator` 是每台 sandbox 节点上的运行时控制器：它把 gRPC 生命周期请求落实为网络槽、磁盘、内存与 Firecracker 进程，并同时承载该节点的 sandbox 流量入口。

## 1. 系统位置

```text
API / scheduler -- gRPC :5008 --> orchestrator node
                                      |
                     +----------------+----------------+
                     |                |                |
                 lifecycle        ingress :5007    host services
                     |                |           NFS / events / metrics
                     v                v
             Firecracker microVM <--- VM network slot
                     |
                    envd :49983
```

- API 层拥有产品状态机、团队配额与跨节点调度；orchestrator 只管理本机实际资源。
- `SandboxService` 提供 `Create`、`Update`、`List`、`Delete`、`Pause`、`Checkpoint`。
- `VolumeService`、`ChunkService`、Info service 和可选 Template service 与生命周期 gRPC 共用端口。
- `SandboxProxy` 在独立的 5007 端口接入 client-proxy 流量，再连接本机 VM。
- orchestrator 还为 VM 提供 hyperloop、NFS/portmapper、出站防火墙和快照缓存能力。

## 2. 启动/装配

`main.go` 只应用测试 flag override，然后调用 `factories.Run`。真正装配在 `pkg/factories/run.go`：

1. 解析配置并创建缓存、模板、snapshot 与 sandbox 目录。
2. 对使用 sandbox runtime 的生产进程获取 host 级 flock，避免同机双实例争用资源。
3. 初始化 telemetry、feature flags、对象存储、Redis peer registry 和 template cache。
4. 初始化 host cgroup manager、NBD device pool 与 network slot pool。
5. 创建共享的 `sandbox.Map`，把 server、ingress proxy、firewall 等组件接到同一运行态索引。
6. 构造 `sandbox.Factory` 与 gRPC `server.Server`。
7. 启动 ingress proxy、egress proxy、hyperloop、可选 NFS proxy 和监控服务。
8. 用 `cmux` 在 `GRPC_PORT` 上区分 HTTP/1 health/upload 与其余 gRPC 流量。

收到关闭信号后，节点先进入 draining；非强制模式等待 live sandbox 自行退出和 lifecycle cleanup 完成，再按逆序关闭依赖。

## 3. 核心机制与关键对象

### `server.Server`

它是 gRPC 边界，负责并发准入、参数转换、事件发布、快照上传以及把请求委派给 `sandbox.Factory`。启动中 sandbox 数由可动态调整的 semaphore 限制。

### `sandbox.Factory`

Factory 把模板设备、network slot、cgroup、rootfs provider、UFFD memory backend 和 Firecracker process 组合成 `Sandbox`。

- `ResumeSandbox`：从内存快照恢复，是普通运行时模板启动与 pause 后恢复的常见路径。
- `RebootSandbox`：仅允许 filesystem-only snapshot，丢弃 RAM、进程和 socket，从 rootfs 冷启动。
- `CreateSandbox`：底层冷启动原语，主要由模板构建与 reboot 路径复用。

### `sandbox.Map`

它维护三个互相独立的索引：

- `live`：可路由、可被 `Get/List/Count` 看见的当前 lifecycle。
- `lifecycles`：尚未完成 cleanup 的所有 lifecycle；checkpoint 时同一 sandbox ID 可同时存在旧、新 lifecycle。
- `network`：VM host IP 到 sandbox 的映射，供防火墙和 host-side 服务反查。

### 存储与恢复

rootfs 通过 NBD overlay 按需读取；内存恢复由 UFFD 按页服务。template cache 把对象存储、节点本地缓存与可选 peer chunk transfer 统一成可读模板。

## 4. 主请求或数据流

### 创建或恢复

```text
SandboxService.Create
  -> 准入限制 + templateCache.GetTemplate
  -> 读取 snapshot metadata
  -> filesystem-only ? RebootSandbox : ResumeSandbox
  -> 分配 network / rootfs / memory / cgroup
  -> 启动或恢复 Firecracker
  -> POST envd /init，等待 204
  -> MarkRunning
  -> 返回 client ID 与 scheduling metadata
```

请求字段 `sandbox.snapshot` 决定事件语义是 created 还是 resumed；真正选择热恢复或冷启动的是快照自身的 `IsFilesystemOnly()` 元数据。

### 暂停与恢复

```text
Pause
  -> MarkStopping（立即停止新路由）
  -> envd reclaim / 可选 freeze
  -> Firecracker pause + snapshot
  -> 导出 memory diff 与 rootfs diff
  -> 加入本地 template cache
  -> 后台上传对象存储
  -> 异步 Stop 旧 lifecycle

后续 Create(snapshot=true)
  -> 取回该 build
  -> memory snapshot: ResumeSandbox + UFFD
  -> filesystem-only: RebootSandbox
```

filesystem-only pause 会先通过 envd `fsfreeze`，旧 envd 不支持时执行强制 guest `sync`；它不保存内存，因此恢复后原进程与连接不存在。

### 删除

```text
Delete -> live.Get -> MarkStopping -> 立即返回
                                  |
                                  +-> goroutine: Stop -> Close -> 释放资源
```

`MarkStopping` 只移除 live 路由；network 索引保留到 slot 真正释放，避免关闭中的 VM 在防火墙反查时突然失去身份。

## 5. 设计不变量与故障边界

- sandbox 只有在 envd `/init` 成功后才能进入 `live`，因此可路由意味着 guest 控制面已就绪。
- `LifecycleID` 而非 sandbox ID 隔离连接池和 cleanup，防止 pause/resume 期间旧 lifecycle 清掉新实例。
- Pause/Delete 先 `MarkStopping` 再做耗时清理；调用成功返回不等于所有 host 资源已经释放。
- Pause 先把 snapshot 放入本地 cache，再注册和启动远端上传；上传异步失败会记录指标，但 Pause 已可能返回成功。
- filesystem-only snapshot 不能进入 memory resume；`RebootSandbox` 还会再次校验快照元数据。
- Firecracker 版本、kernel、rootfs 和 memfile 元数据必须兼容；恢复错误不会降级为任意冷启动。
- `Close` 的 cleanup 链负责 FC、UFFD、NBD、cgroup、文件和 network slot；生命周期等待使用 `lifecycles`，不能只观察 live 数量。
- ingress proxy 只接受 live map 中的 sandbox，并按 lifecycle key 禁止复用已经回收 IP 上的旧连接。
- 启动时 reclaim 处理 crash 遗留的 namespace、设备和 cgroup；它不恢复崩溃前的 live VM 状态。

## 6. 与其他组件边界

| 相邻组件 | orchestrator 负责 | 对方负责 |
| --- | --- | --- |
| API / scheduler | 执行本机 gRPC 请求、报告资源与状态 | DB 状态机、配额、节点选择、catalog |
| client-proxy | 在 5007 接收选中节点的流量 | 用 Redis 把 sandbox 映射到节点 |
| envd | 启动后调用 `/init`，暂停前调用控制端点 | guest 内进程、文件、cgroup 与 localhost 端口转发 |
| Firecracker | 生成配置、控制 pause/snapshot/resume/stop | microVM 隔离与设备模拟 |
| 对象存储 / peer | 生成 diff、cache 与上传任务 | 持久化和跨节点提供 snapshot chunk |
| Nomad / host | 暴露健康与 drain 行为 | 部署节点进程、发送终止信号 |

## 7. 源码阅读顺序

| 顺序 | 文件 | 阅读目标 |
| --- | --- | --- |
| 1 | `packages/orchestrator/main.go` | 看 edition 入口与 egress factory |
| 2 | `packages/orchestrator/pkg/factories/run.go` | 看整台节点的依赖图、listener 与关闭顺序 |
| 3 | `packages/orchestrator/orchestrator.proto` | 先建立生命周期 RPC 契约 |
| 4 | `packages/orchestrator/pkg/server/sandboxes.go` | 看 Create/Pause/Delete/Checkpoint 边界 |
| 5 | `packages/orchestrator/pkg/sandbox/sandbox.go` | 看资源组合、Resume、Pause 与 cleanup |
| 6 | `packages/orchestrator/pkg/sandbox/reboot.go` | 看 filesystem-only 冷启动约束 |
| 7 | `packages/orchestrator/pkg/sandbox/envd.go` | 看 readiness、`/init` 与 pause 控制调用 |
| 8 | `packages/orchestrator/pkg/sandbox/map.go` | 看 live/lifecycle/network 三索引 |
| 9 | `packages/orchestrator/pkg/proxy/proxy.go` | 看节点 ingress、鉴权与连接隔离 |
| 10 | `packages/orchestrator/pkg/sandbox/fc/process.go` | 最后下钻 Firecracker API 交互 |

## 8. 相关深挖

- [Orchestrator 模块详解](../../md/orchestrator-module.md)
- [Sandbox 生命周期详解](../../md/sandbox-lifecycle.md)
- [Sandbox 管理机制](../../md/sandbox-management.md)
- [Sandbox 流量路由详解](../../md/sandbox-traffic-routing.md)
- [Template Build 流程](../../md/template-build-flow.md)
- [Orchestrator 底层实现说明](../../orchestrator-module.md)
