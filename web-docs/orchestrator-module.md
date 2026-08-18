# Orchestrator 专章：节点运行原理与源码解析

> 本章以当前 `packages/orchestrator/` 源码为准，按运行时协作关系组织，而不是逐目录罗列文件。目标是回答三个问题：一次请求怎样在节点上变成 microVM，暂停与恢复怎样搬运状态，以及异常发生时谁负责撤销资源。

## 1. 先建立正确的职责边界

Orchestrator 是**单个宿主节点上的执行引擎**，不是跨节点调度器。

```text
API control plane
  - team / quota / DB state
  - cluster discovery
  - cross-node placement
          |
          | SandboxService gRPC :5008
          v
Orchestrator node
  - admission and local runtime state
  - network / cgroup / rootfs / memory
  - Firecracker lifecycle
  - snapshot cache and upload
          |
          | /init, /health, process control
          v
envd inside the microVM
```

跨节点选址在 `packages/api/internal/orchestrator/` 完成。节点侧 `pkg/scheduling` 只生成缓存链和脏数据规模等调度反馈，它不选择下一台 Orchestrator。

| 状态或决策 | 主要所有者 | Orchestrator 的角色 |
|---|---|---|
| team、配额、产品生命周期 | API + PostgreSQL | 接收已经完成业务校验的请求 |
| sandbox 应放在哪个节点 | API placement | 报告节点能力和启动成本 |
| 当前流量应去哪个节点 | Redis catalog | 在本机只维护可路由 lifecycle |
| VM、network slot、NBD、cgroup | 节点 Orchestrator | 唯一直接所有者 |
| guest 内进程和文件 API | envd | 启动后初始化和健康检查 envd |
| snapshot 大对象 | 对象存储，节点 cache 为加速层 | 生成、缓存、上传和按需读取 |

一句话概括：**API 决定“在哪运行”，Orchestrator 负责“在本机真的运行起来”。**

`Map.MarkRunning` 只建立节点内可路由状态，不会直接发布 Redis catalog。对本地集群，API 在 Create/Resume 成功返回后更新 catalog；暂停和删除的控制面链路先撤掉对外路由。两层状态故意分开：节点 live 是执行事实，catalog 是跨节点寻址事实。

## 2. 模块地图

先用下表建立目录与运行职责的对应关系。后续所有调用链都会回到这些模块。

| 模块 | 运行职责 | 首要源码入口 |
|---|---|---|
| 进程入口 | 选择 edition 能力并启动运行时 | `main.go` |
| 配置 | 解析端口、路径、存储、节点标签和服务模式 | `pkg/cfg/model.go`、`pkg/cfg/service.go` |
| 装配 | 创建共享依赖、启动监听器、组织 drain 与关停 | `pkg/factories/run.go` |
| RPC 边界 | 准入、请求转换、事件和异步上传 | `orchestrator.proto`、`pkg/server/` |
| Sandbox 核心 | 组合资源并管理一个 Firecracker lifecycle | `pkg/sandbox/sandbox.go` |
| 运行态索引 | 区分可路由、清理中和网络身份 | `pkg/sandbox/map.go` |
| Firecracker | 进程、API socket、创建、恢复、暂停和停止 | `pkg/sandbox/fc/` |
| 磁盘链 | template、build、block cache、NBD 和 rootfs | `pkg/sandbox/{template,build,block,nbd,rootfs}/` |
| 内存恢复 | userfaultfd、按页读取、memfd 和预取 | `pkg/sandbox/uffd/` |
| 网络数据面 | netns、veth、tap、入口代理和出口策略 | `pkg/sandbox/network/`、`pkg/proxy/`、`pkg/tcpfirewall/` |
| 节点内服务 | Hyperloop、NFS、portmapper、volume 文件操作 | `pkg/hyperloopserver/`、`pkg/nfsproxy/`、`pkg/portmap/`、`pkg/volumes/` |
| 可靠性与观测 | cleanup、reclaim、health、events、metrics | `pkg/sandbox/{cleanup,reclaim,checks,hoststats_collector}.go` |
| 崩溃后回收 | 清理由上一个进程遗留的宿主资源 | `pkg/startupreclaim/` |

阅读时不要把目录层级误认为调用顺序。一次 `Create` 会同时穿过 `server`、`template`、`sandbox`、`network`、`rootfs`、`uffd` 和 `fc`。

## 3. 启动与服务装配

### 3.1 从 `main.go` 到 `factories.Run`

`main.go` 很薄：应用测试 flag override，构造 edition 对应的 `EgressFactory`，然后调用 `factories.Run`。真正的节点依赖图在 `pkg/factories/run.go`。

```text
main
  -> cfg.Parse
  -> ensureDirs
  -> factories.run
       -> host lock
       -> telemetry / logger / feature flags
       -> storage / Redis / ClickHouse deliveries
       -> cgroup manager
       -> startup reclaim
       -> template cache / NBD pool / network pool
       -> sandbox.Map / Factory / Server
       -> ingress, egress, Hyperloop, optional NFS
       -> gRPC + HTTP health through cmux
```

生产模式下，只要当前服务组合会使用 sandbox runtime，就会获取 host 级 `flock`。它防止同一宿主上两个进程同时管理 KVM、NBD、network namespace 和 cgroup。开发模式会跳过这项限制。

`ORCHESTRATOR_SERVICES` 决定进程运行 Orchestrator、Template Manager 或组合模式。共享装配不意味着两种角色拥有相同职责；Template Manager 会复用 sandbox runtime 构建模板，Orchestrator 则暴露 sandbox 生命周期 RPC。

### 3.2 监听面

| 默认端口 | 协议 | 用途 |
|---:|---|---|
| `5008` | gRPC + HTTP/1，经 `cmux` 复用 | Sandbox、Chunk、Volume、Info、gRPC health，以及 `/health`、可选 `/upload` |
| `5007` | HTTP | client-proxy 到本机 sandbox 的入口代理 |
| `5010` | HTTP | VM 到宿主的 Hyperloop 内部通道 |
| `5011` | NFS | 配置持久卷时的 NFS proxy |
| `5012` | portmapper | 为 NFS 客户端发现 2049 服务 |
| `5016-5018` | TCP | 按 HTTP、TLS、其他协议拆分的出口防火墙入口 |

端口是默认值，真实部署应以 `pkg/cfg` 和环境变量为准。

### 3.3 启动时为什么先回收

Orchestrator 的 live 状态只存在内存中。进程崩溃后不会“接管”原来的 VM，而是在启动时 best-effort 清理孤儿资源：

1. 终止遗留的 Firecracker 进程。
2. 断开遗留 NBD 设备。
3. 删除 network namespace 和网络资源。
4. 销毁遗留 cgroup。
5. 清理临时 socket、链接和工作目录。

入口在 `pkg/startupreclaim/reclaim.go`。失败会被记录，但不会把旧 VM 重新加入 live map。

### 3.4 Template 与 Build Cache 的存储角色解析

`pkg/cfg/storage.go` 分别解析 template storage 和 build-cache storage。`TEMPLATE_STORAGE_URL`、`BUILD_CACHE_STORAGE_URL` 对各自角色是权威配置,因此两个角色可以使用不同 provider 或 destination:

| URL | 含义 |
|---|---|
| `gs://bucket` | Google Cloud Storage |
| `s3://bucket?endpoint=http://host:port&s3ForcePathStyle=true&region=us-east-1` | AWS S3 或 S3-compatible storage |
| `file:///absolute/path` | 本地绝对路径 |
| `file:relative/path` | 本地相对路径 |

云存储 URL 只接受 bucket,不支持 key prefix。未知 query 参数、URL credentials、非法 endpoint 都会在启动时失败;凭据来自 ADC/Workload Identity 或 AWS 环境变量。未设置角色 URL 时,旧配置 `STORAGE_PROVIDER`、两个 `*_BUCKET_NAME`、两个 `LOCAL_*_BASE_PATH` 和 `S3_USE_PATH_STYLE` 仍会先转换成等价 URL,再走统一 parser。`storage.NewProvider` 接收已经解析的 `storage.Spec`,不再自行读取环境变量。

## 4. RPC 边界与节点准入

### 4.1 `SandboxService` 不是薄转发

`orchestrator.proto` 定义了以下节点动作：

| RPC | 节点语义 |
|---|---|
| `Create` | 获取模板，恢复内存快照或冷启动 filesystem-only 快照 |
| `Update` | 更新 end time、网络入口/出口等可变配置，并在失败时回滚 |
| `List` | 返回 live map 中当前可路由的 sandbox |
| `Delete` | 先退出 live，再异步停止底层资源 |
| `Pause` | 退出 live，生成本地 snapshot，启动后台上传 |
| `Checkpoint` | 完整快照后立即在本节点恢复成新 lifecycle |
| `ListCachedBuilds` | 暴露节点已有的 build cache |

同一 gRPC server 还注册 `ChunkService`、`VolumeService`、Info service 和 health service。因此，`pkg/server` 同时是生命周期边界、节点能力边界和缓存数据边界。

### 4.2 `Server.Create` 的准入顺序

`pkg/server/sandboxes.go:Server.Create` 先保护节点，再准备 VM：

```text
request timeout (60s)
  -> feature-flag context and BYOP defense-in-depth
  -> max running sandboxes check
  -> starting semaphore
  -> templateCache.GetTemplate
  -> parse network, volume and FC config
  -> inspect snapshot metadata
  -> RebootSandbox or ResumeSandbox
  -> setup lifecycle watcher
  -> publish event and return scheduling metadata
```

恢复请求最多等待一段时间获取 starting semaphore；非恢复请求使用 `TryAcquire`，节点忙时直接返回 `ResourceExhausted`。这个差异让恢复有短暂排队空间，又避免大量新建请求在节点内无限堆积。

### 4.3 最容易写错的 Create 事实

普通 sandbox 请求通常**不调用** `Factory.CreateSandbox`。模板本身就是可恢复的 Firecracker 产物，因此：

```text
template metadata is filesystem-only
  -> Factory.RebootSandbox
       -> Factory.CreateSandbox as cold-boot primitive

otherwise
  -> Factory.ResumeSandbox
       -> load memory snapshot through UFFD
```

`request.sandbox.snapshot` 影响事件语义和准入策略，但真正决定热恢复还是冷启动的是模板元数据 `IsFilesystemOnly()`。内存快照不能被任意降级为冷启动，因为 guest page cache 中可能还有尚未落入 rootfs 的写入。

节点边界不会用请求中的 `snapshot` 布尔值重新推导模板种类，也不会让它覆盖 metadata。调用方必须保持两者语义一致；即使不一致，启动路径仍以 metadata 为准，而事件名和 semaphore 策略可能仍按请求字段解释。

### 4.4 `SandboxService.Update` 按 Sandbox 串行化

`Sandbox` 持有专用 `updateMu`,`Server.Update` 通过 `sbx.RunUpdate` 把整组 all-or-none 更新、失败回滚和事件派发包在同一个临界区。同一 sandbox 的并发 timeout/network 更新会严格串行,后一个请求只能看到前一个请求提交或完整回滚后的状态,不会互相覆盖或用旧值回滚新值。锁是每个 `Sandbox` 实例私有的,不同 sandbox 的更新仍可并行。

## 5. Sandbox 生命周期核心

### 5.1 三层对象

`pkg/sandbox/sandbox.go` 的核心不是一个大状态枚举，而是三层对象协作：

| 对象 | 作用 |
|---|---|
| `Factory` | 持有 network pool、NBD pool、cgroup manager、feature flags 和共享 Map，创建具体 lifecycle |
| `Sandbox` | 绑定一次 Firecracker 进程及其 network、rootfs、memory、cgroup、checks 和 cleanup |
| `Resources` | 把 `network.Slot`、`rootfs.Provider`、`uffd.MemoryBackend` 组合到 Sandbox |

`Factory` 的生命周期与节点进程一致，`Sandbox` 的生命周期与一次 Firecracker 进程一致。

### 5.2 三种身份不要混用

| 标识 | 稳定范围 | 典型用途 |
|---|---|---|
| `SandboxID` | 产品层 sandbox | API 查询和用户可见身份 |
| `ExecutionID` | 一段业务执行，可跨 checkpoint 保持 | catalog、事件和分析关联 |
| `LifecycleID` | 一次具体 Firecracker 进程 | 本机清理、连接池隔离和竞态守卫 |

Checkpoint 会保持 `SandboxID` 与 `ExecutionID`，但生成新的 `LifecycleID`。旧 VM 的异步 cleanup 因此不能误删新 VM。

保护来自三个不同键：`MarkStopping` 只有在 live 中的 `LifecycleID` 与调用方一致时才删除；`MarkStopped` 删除精确的 `sandboxID/lifecycleID` 组合键；proxy 连接也按 `LifecycleID` 隔离。旧 lifecycle 即使晚到，也只能清理自己的 map entry 和连接。

### 5.3 `sandbox.Map` 的三个索引

当前 `pkg/sandbox/map.go` 明确维护三个独立索引：

```text
live[sandboxID]
  当前可路由 lifecycle
  Get / Items / Count / ingress proxy 使用

lifecycles[sandboxID/lifecycleID]
  尚未完成 cleanup 的所有 lifecycle
  graceful shutdown 等它清空

network[hostIP]
  已分配 network slot 的 lifecycle
  出口防火墙和宿主服务按源 IP 反查
```

不变量是 `live` 是 `lifecycles` 的子集。`MarkRunning` 同时登记 live 与 lifecycle；`MarkStopping` 只移除 live；`MarkStopped` 要等 `Sandbox.Close` 完成后才移除 lifecycle。

尚在 Create/Resume、还没通过 envd 初始化的对象不在 `lifecycles` 中。它们仍由当前 RPC、Factory 的 deferred Cleanup 和服务 goroutine 持有；`WaitLifecycles` 只证明所有**曾经进入 running** 的 lifecycle 已完成 cleanup，不代表它单独覆盖所有 pre-live 启动任务。

closers 反向执行时，后注册的 gRPC server 会先调用 `GracefulStop`，等待在途 RPC 结束，之后才关闭先注册的 network/NBD pool、template cache 等依赖。但它发生在 `DrainSandboxes` 和 `WaitLifecycles` **之后**：一个当时仍 pre-live 的 Create 可能在 lifecycle 等待已经返回后才 `MarkRunning`。因此当前顺序仍依赖上游停止路由新请求；绕过服务发现的并发 Create 存在跨过 drain 屏障的风险。更强的顺序应先停止准入并等待在途 Create/Resume，再等待 live 与 lifecycles 清空。

network 索引会保留到 slot 真正释放。这样 Delete/Pause 已经阻止新入口流量后，关闭中的 VM 仍能被出口防火墙按源 IP 识别。

### 5.4 Cleanup 与 Stop/Close

这三个动作语义不同：

| 动作 | 做什么 |
|---|---|
| `Stop` | 幂等停止 checks、Firecracker、cgroup 中进程和 UFFD |
| `Close` | 执行 cleanup 链，释放 NBD、rootfs、network、文件等，并 `MarkStopped` |
| `Shutdown` | 为磁盘 flush 执行 pause/snapshot，再 Close；不保留产物 |

`Stop` 使用 `utils.Lazy[error]`，并发调用只会真正执行一次。`Cleanup.Run` 也只执行一次；先运行 priority 组，再运行普通组，每组内部都是 LIFO。请求 context 已取消时，清理仍使用不随父 context 取消的上下文继续执行。

`Server.setupSandboxLifecycle` 在后台等待 VM 退出，然后调用 `Close`，最后按 `LifecycleID` 清理 proxy 连接。RPC 返回和资源完全释放不是同一个时刻。

## 6. Firecracker 与 guest 就绪

### 6.1 `fc.Process` 的两条启动路径

`pkg/sandbox/fc/process.go` 把 Firecracker 二进制、API socket、启动脚本和退出信号封装为 `Process`。

```text
Cold boot
  fc.NewProcess
  -> configure process + cgroup FD
  -> boot source / rootfs / network / machine config
  -> optional balloon and entropy device
  -> InstanceStart

Memory resume
  fc.NewProcess
  -> configure process + cgroup FD
  -> wait for rootfs and UFFD socket
  -> load snapshot
  -> restore rate limits
  -> Resume VM
  -> update MMDS
```

`NewProcess` 只准备路径和句柄，不代表 VM 已启动。真正启动发生在 `Create` 或 `Resume`。

### 6.2 `WaitForEnvd` 才是可用性屏障

Firecracker 进程存在不等于 sandbox 可用。恢复路径会：

1. 先把 host IP 登记到 network 索引，供恢复期间的宿主侧反查。
2. 启动 Firecracker 和 UFFD。
3. 调用 `Sandbox.WaitForEnvd`，向 guest 内 envd 发送 `/init`。
4. `/init` 成功后才 `MarkRunning`。
5. 进入 live map 后启动周期 checks。

filesystem-only 的 `RebootSandbox` 也用同一约束：它以 systemd 冷启动 guest，等待 envd 完成初始化后才进入 live。

`WaitForEnvd` 同时监听初始化超时和 Firecracker 提前退出。成功时会更新实际 started time，并记录启动阶段 UFFD 读取的页数和字节数。

### 6.3 Orchestrator 与 envd 的边界

Orchestrator 通过 MMDS 和 envd API 传入 access token hash、环境变量、默认用户、工作目录、网络与 volume mount 等配置。envd 最终负责 guest 内的进程、文件和本地端口。

因此，`MarkRunning` 的含义不是“FC API 返回成功”，而是“guest 控制面已经接受初始化”。

## 7. 磁盘与内存的按需恢复

### 7.1 两条不同的数据路径

```text
Normal resume rootfs read
guest virtio block
  -> Linux /dev/nbdX
  -> nbd.Dispatch
  -> block.Overlay
  -> local Cache or build.File upstream
  -> object storage / NFS cache / peer chunk

Memory fault
guest touches a missing page
  -> Firecracker userfaultfd
  -> uffd handler
  -> template memfile chain
  -> copy page into guest memory
  -> optionally record/prefetch working set
```

NBD 解决“guest 看到一块可写磁盘”的问题，UFFD 解决“恢复时不必先读取全部 RAM”的问题。两者都按需读取，但协议、页/块粒度和生命周期不同。

上图是常规 resume/reboot 路径。模板构建等显式传入 `rootfsCachePath` 的冷启动可以使用 `rootfs.DirectProvider`，直接准备宿主路径而不经过 NBD；选择发生在 `Factory.CreateSandbox`。

### 7.2 模块分工

| 模块 | 核心抽象 | 关键作用 |
|---|---|---|
| `template` | `Template`、`Cache`、`File` | 按 build ID 找到 metadata、snapfile、memfile 与 rootfs |
| `build` | 分层 `File` / `Diff` | 沿父 build 链规划读取，处理本地与远端片段 |
| `block` | `Cache`、`Tracker`、`Overlay`、`Chunker` | mmap cache、dirty/zero 状态、流式 chunk、去重 |
| `nbd` | `DevicePool`、`Dispatch`、`DirectPathMount` | 管理 `/dev/nbd*` 并实现用户态 NBD 服务端 |
| `rootfs` | `Provider` | 把 overlay 以 NBD 或 direct path 暴露给 Firecracker |
| `uffd` | `MemoryBackend` | 处理 missing page、memfd、diff metadata 和 prefetch |

### 7.3 为什么 template cache 不是真相源

`template.Cache` 可以从本地 cache、NFS、对象存储或 peer 获取数据，但它只是读取加速层。Pause 成功加入本地 cache 后即可在本机使用；跨节点恢复仍依赖远端产物最终完整落地，或在上传窗口内由 peer 提供 chunk。

### 7.4 调度反馈来自哪里

恢复完成后，Server 从已经解析的 memfile/rootfs header 生成 `SchedulingMetadata`。rootfs 新增字节当前可以精确计算；memory dirty bytes 在异步 dedup 完成前是上界。API 可以用这些数据估算把同一 build 放到不同节点的读取成本，但最终选点仍在 API 侧。

### 7.5 Template Build 的离线 Rootfs 扩容

`build-ensure-free-disk-space` 开启时,template builder 在 user steps 之后、finalize 之前插入 `resize-disk` phase。`DiskSizeMB` 此时表示目标空闲 rootfs MiB,而不是总磁盘大小。phase 通过 NBD 暴露 quiescent COW overlay,回放 ext4 journal,读取 block group 空闲块;不足时执行 `e2fsck → resize2fs → e2fsck`,并只导出变化 block。无需扩容也会生成可缓存的 empty diff。该 layer 是 filesystem-only,所以 finalize 会 cold boot;ext4 metadata 和 finalize 写入可能让最终空闲空间略低于目标。

## 8. 网络与流量路径

### 8.1 一个 network slot 包含什么

`pkg/sandbox/network` 预创建并复用 network slot。一个 slot 绑定 network namespace、veth、tap、host/guest IP、路由和防火墙状态。

```text
host namespace
  route -> veth(host)
             |
             v
sandbox netns
  veth(ns) -> tap -> Firecracker guest NIC
```

新 slot 和复用 slot 使用不同队列。归还时有短暂延迟，让旧 lifecycle 的在途连接先排空，降低 IP 立即复用带来的串流风险。

### 8.2 入口流量

```text
SDK request
  -> client-proxy reads Redis catalog
  -> orchestrator proxy :5007
  -> parse sandboxID + port
  -> live Map.Get(sandboxID)
  -> validate traffic token when required
  -> http://<sandbox-host-ip>:<port>
```

`pkg/proxy/proxy.go` 只接受 live map 中的 sandbox。envd 端口跳过普通 traffic token，因为 envd 有自己的认证机制。

连接池 key 使用 `LifecycleID`，不是复用后的 IP，也不是长期稳定的 `SandboxID`。Checkpoint 或 resume 产生新 VM 后，旧 lifecycle 的连接不会误发到新 VM。

### 8.3 出口与宿主服务

guest 出口经过 network slot 的路由和 edition 提供的 `EgressProxy`。默认实现由 `pkg/tcpfirewall` 检查 CIDR、HTTP Host 或 TLS SNI；BYOP 配置还会在 Server.Create/Update 做二次 feature gate。

Hyperloop、NFS proxy 和 portmapper 使用固定的 sandbox 内 Orchestrator 地址提供宿主能力。Volume gRPC 管理宿主目录，guest 再通过 NFS mount 使用持久卷。它们依赖 network 索引按源 IP 识别 sandbox，因此 stopping 阶段不能过早删除该索引。

### 8.4 `NetworkAssignHook` 的执行屏障

Edition-specific `EgressFactory` 可在 `EgressSetup` 中注入 `NetworkAssignHook`;未提供时使用 `NoopNetworkAssignHook`。Factory 在 `AssignNetwork` 完成后同步执行 hook,并严格等待 hook 返回后才允许 guest create/resume,因此扩展可以在 guest 发出任何流量前完成依赖网络身份的配置。

reason 区分 `create`、`resume`、`reboot` 和 `throwaway_resume`。Hook 必须自行实现 timeout;返回错误只记录 warning,panic 会被 recover 并记录 error,两者都不会阻止 sandbox 启动。这意味着 hook 是顺序屏障但不是成功门槛,实现方不能无限阻塞。

## 9. Pause、Checkpoint 与恢复

### 9.1 Pause 的同步部分

`Server.Pause` 先 `MarkStopping`，阻止新流量，然后调用 `snapshotAndCacheSandbox`：

```text
stop health checks
  -> best-effort reclaim in guest
  -> optional mandatory fsfreeze/sync for filesystem-only
  -> drain free-page hinting balloon
  -> Firecracker Pause
  -> CreateSnapshot (also drains/flushed virtio disk)
  -> export memory diff unless filesystem-only
  -> export rootfs diff
  -> write metadata
  -> templateCache.AddSnapshot
  -> register upload
```

只有本地 snapshot 已加入 cache，Server 才启动后台远端上传并返回。旧 lifecycle 随后异步 Stop。

### 9.2 Full-memory 与 filesystem-only

| 类型 | 保存内容 | 下次启动 | 保留的用户状态 |
|---|---|---|---|
| full-memory | snapfile、memory diff、rootfs diff、metadata | `ResumeSandbox` | RAM、进程、socket 与文件系统 |
| filesystem-only | rootfs diff、metadata；不上传内存状态 | `RebootSandbox` | 仅持久化到文件系统的内容 |

filesystem-only 必须在 pause 前让 guest 文件系统进入一致状态，并清除 memory prefetch。恢复时会重新走 systemd 和 envd `/init`，原进程与连接不会回来。

filesystem-only 仍调用 Firecracker `CreateSnapshot`，因为定制实现会在该操作中 drain/flush virtio disk；生成的 snapfile 只是过程产物，不进入最终可恢复集合，也不会上传。额外的 guest fsfreeze/sync 仍不可省：full-memory snapshot 会保留 guest page cache，filesystem-only 不保存 RAM，必须先把已确认写入推到磁盘层。

### 9.3 后台上传不是 Pause 的事务尾部

Pause 的远端上传脱离请求 context，使用有界重试预算。graceful shutdown 会等待已登记的上传；最终失败会记录错误和指标，但不会把已经返回成功的 Pause 自动变回运行态。

因此，上传失败后的保证只到“本节点 cache 中已有 snapshot”。如果 cache 随节点退出或淘汰而消失，而对象存储又没有完整产物，就不能承诺跨节点恢复；节点侧不会自行修复控制面的 paused 状态，补偿与重试必须由更上层工作流处理。

full-memory Pause 还可以在后台用本地 snapshot 做一次隔离的 throwaway resume，收集真实缺页序列并写成下次恢复的 prefetch mapping。throwaway lifecycle 禁止出口、不挂载 volume、不进入 live map，也不污染客户启动指标。

### 9.4 Checkpoint 不是 Pause 的别名

Checkpoint 固定生成 full-memory snapshot，然后立即在同一节点恢复：

```text
old lifecycle
  -> MarkStopping
  -> snapshot + local cache
  -> ResumeSandbox
  -> same SandboxID and ExecutionID
  -> new LifecycleID
  -> publish checkpoint event
```

它的目标是替换底层 VM lifecycle，同时让业务 sandbox 继续运行。上传同步还是异步由 feature flag 控制；同步上传失败时，刚恢复的 lifecycle 也会被撤销，避免运行一个无法再次恢复的实例。

Checkpoint 没有回滚到旧 VM：旧 lifecycle 已退出 live，并通过 deferred Stop 收尾；snapshot 或新 resume 失败时，RPC 失败且旧实例仍会停止。异步上传模式若最终失败，则新 lifecycle 可以继续运行，但该 checkpoint 的远端耐久性不成立，保证与 Pause 的后台上传窗口相同。

上层有两种 checkpoint 编排:`/sandboxes/{id}/snapshots` 在 checkpoint 外创建或关联 snapshot template;`/sandboxes/{id}/fork` 只刷新原 sandbox 的 snapshot row,再从同一 immutable snapshot 启动多个新 ID。节点侧 `Checkpoint` 本身不决定是否创建 template。

## 10. 删除、故障与有序关停

### 10.1 Delete 为什么快速返回

`Server.Delete` 的顺序是：

1. 从 live map 找到 sandbox。
2. 用 `SandboxID + LifecycleID` 调用 `MarkStopping`。
3. 做最后一次健康采样并发布 killed event。
4. 在 goroutine 中调用幂等 `Stop`。
5. RPC 返回，不等待全部 cleanup。

这保证新入口流量立即停止，同时把耗时的 FC 退出、NBD 断开和 network slot 归还放到后台。

### 10.2 运行中异常

| 异常 | 主要响应 |
|---|---|
| Firecracker 提前退出 | lifecycle waiter 触发 Stop 和 Close |
| UFFD 退出 | resume lifecycle 取消并停止 FC |
| Create/Resume 中途失败 | deferred Cleanup 逆序撤销已分配资源 |
| Pause 生成 snapshot 失败 | 清理临时产物；Server 路径仍停止已退出 live 的旧 lifecycle，失败不表示旧 VM 仍可用 |
| 后台上传最终失败 | 记录失败，不重新发布旧 VM |
| 进程崩溃 | 下次启动由 startup reclaim 清理宿主残留 |

### 10.3 健康、指标与事件

- `Checks` 周期访问 envd `/health`，并且必须在 pause/stop 前停止，避免冻结中的 VM 被误报不健康。
- `HostStatsCollector` 从 sandbox cgroup 采集 CPU/内存等宿主视角指标，cleanup 时在 cgroup 删除前做最后采样。
- `pkg/events` 把 created、resumed、paused、checkpointed、killed 等事件投递到配置的 delivery。
- Firecracker、NBD、block、proxy、snapshot upload 和启动缺页都有独立指标；高基数字段不应直接变成 metric label。

### 10.4 节点 shutdown

收到信号后，`factories.run`：

1. 把 `ServiceInfo` 标记为 `Draining`，让发现方停止选择该节点。
2. 等待 Template Manager 的在途构建。
3. 非 `ForceStop` 模式等待 live sandbox 自然退出。
4. 再等待 `lifecycles` 索引清空，确认 cleanup 完成。
5. `Server.Close` 等待已登记的 snapshot upload。
6. 按注册顺序的逆序关闭 listener、proxy、pool、cache 和 delivery。

`DrainSandboxes` 本身只等待，不负责拒绝新 Create；新请求准入必须由上层根据节点 `Draining` 状态停止路由。gRPC listener 在后续 closer 阶段才关闭，因此绕过服务发现的直连 Create 可能与 drain 竞争，这是调用方必须遵守的契约。

`ForceStop` 会取消 close context、跳过 live sandbox 自然退出和 lifecycle 等待，并让上传等待立即结束；随后 closers 以 best-effort 方式拆除资源。它提供快速进程退出，不提供 graceful 路径的耐久化与完整等待保证。

## 11. 五条源码调用链

### 11.1 常规启动

```text
API placement
  -> SandboxService.Create
  -> template.Cache.GetTemplate
  -> Factory.ResumeSandbox
  -> network.Pool.Get + rootfs NBD + UFFD
  -> fc.Process.Resume
  -> Sandbox.WaitForEnvd
  -> Map.MarkRunning
  -> Server.setupSandboxLifecycle
```

### 11.2 filesystem-only 恢复

```text
SandboxService.Create
  -> metadata.IsFilesystemOnly
  -> Factory.RebootSandbox
  -> Factory.CreateSandbox(WithDeferredMarkRunning)
  -> fc.Process.Create
  -> WaitForEnvd
  -> Map.MarkRunning
```

### 11.3 暂停

```text
SandboxService.Pause
  -> Map.MarkStopping
  -> Sandbox.Pause
  -> template.Cache.AddSnapshot
  -> Upload.Run in background
  -> Sandbox.Stop in background
```

### 11.4 在线 checkpoint

```text
SandboxService.Checkpoint
  -> MarkStopping(old LifecycleID)
  -> snapshotAndCacheSandbox
  -> Factory.ResumeSandbox(new LifecycleID)
  -> setupSandboxLifecycle(new)
  -> upload + event
  -> Stop(old)
```

### 11.5 端口请求

```text
client-proxy
  -> SandboxProxy :5007
  -> Map.Get(sandboxID)
  -> ingress token / host mask
  -> Slot.HostIP:port
  -> envd or user process
```

## 12. 源码阅读顺序

### 第一遍：只看边界

1. `packages/orchestrator/main.go`
2. `packages/orchestrator/pkg/cfg/model.go`
3. `packages/orchestrator/pkg/factories/run.go`
4. `packages/orchestrator/orchestrator.proto`
5. `packages/orchestrator/pkg/server/sandboxes.go`

完成后应能回答：谁选择节点、一个进程监听哪些接口、Create 为什么有两种恢复路径。

### 第二遍：掌握 lifecycle

1. `packages/orchestrator/pkg/sandbox/sandbox.go`
2. `packages/orchestrator/pkg/sandbox/reboot.go`
3. `packages/orchestrator/pkg/sandbox/map.go`
4. `packages/orchestrator/pkg/sandbox/cleanup.go`
5. `packages/orchestrator/pkg/sandbox/envd.go`
6. `packages/orchestrator/pkg/server/main.go`

完成后应能解释 `SandboxID`、`ExecutionID`、`LifecycleID`，以及 Stop、Close、MarkStopping、MarkStopped 的先后关系。

### 第三遍：下钻资源

1. `pkg/sandbox/fc/process.go`
2. `pkg/sandbox/template/cache.go`
3. `pkg/sandbox/build/`
4. `pkg/sandbox/block/`
5. `pkg/sandbox/nbd/`
6. `pkg/sandbox/uffd/`
7. `pkg/sandbox/network/`
8. `pkg/proxy/proxy.go`

每读一个资源模块，都要找出四件事：分配入口、所有者、失败回滚、成功释放。

## 13. 必须守住的不变量

1. 跨节点 placement 属于 API；节点 scheduling metadata 只是反馈。
2. 只有 envd 初始化成功的 lifecycle 才能进入 live map。
3. `LifecycleID` 隔离旧 VM 的连接和 cleanup，不能用 `SandboxID` 代替。
4. `MarkStopping` 只停止可路由性，完整释放要观察 lifecycles 索引。
5. network 索引必须活到 slot 释放，不能在退出 live 时同步删除。
6. 内存快照只能走 memory resume；filesystem-only 才允许 reboot。
7. Pause 加入本地 cache 与远端上传完成是两个时间点。
8. 任何资源分配都必须在 Cleanup 中注册对称释放。
9. 请求 context 取消不能自动取消必要的 Stop、Close 和上传收尾。
10. Firecracker、kernel、envd、snapshot metadata 的兼容性错误不能静默降级。
11. 同一 sandbox 的 Update 必须覆盖完整 apply/rollback/event 临界区;不同 sandbox 不共享这把锁。
12. `NetworkAssignHook` 必须发生在 `AssignNetwork` 之后、guest 执行之前;hook 自己负责 timeout,失败不阻断启动。

## 14. 学完后的源码练习

### 练习一：证明旧 cleanup 不会删掉 checkpoint 后的新 VM

从 `Server.Checkpoint` 找到新旧 `LifecycleID`，再读 `Map.MarkStopping`、`Map.MarkStopped` 和 proxy 的 `ConnectionKey`。画出旧 lifecycle cleanup 与新 lifecycle MarkRunning 交错时的结果。

### 练习二：追一次 rootfs cache miss

从 guest block read 开始，依次定位 NBD dispatch、block overlay、build file 和 storage/peer reader。记录每一层的读取粒度、缓存位置与错误返回方式。

### 练习三：解释 Pause 已成功但跨节点暂时无法 Resume

从 `snapshotAndCacheSandbox`、`uploadSnapshotAsync` 和 `template.Cache.AddSnapshot` 解释本地可用与远端耐久化之间的窗口，并找出 upload failure 的指标和日志入口。

### 练习四：验证 graceful shutdown 等待的对象

从 `factories.run` 进入 `Server.DrainSandboxes`、`Map.WaitLifecycles` 与 `Server.Close`，分别说明 live sandbox、cleanup 中 lifecycle 和 in-flight upload 的等待边界。

## 15. 相关章节

- [Orchestrator 组件总览](./components/06-orchestrator.md)
- [Sandbox 完整生命周期](sandbox-lifecycle.md)
- [Snapshots 快照系统](snapshots.md)
- [Sandbox 流量路由](sandbox-traffic-routing.md)
- [Envd 深度剖析](envd-module.md)
- [Volumes 持久化卷](volumes.md)
