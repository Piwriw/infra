# `pkg/sandbox` 模块原理总览

> 路径: `packages/orchestrator/pkg/sandbox/`
> 职责: 把一个 e2b template(Firecracker 镜像)变成一个可运行的 microVM 沙箱,管理其全生命周期:网络、内存、磁盘、cgroup、上传/下载、暂停/恢复、健康检查、指标。

---

## 1. 在整体架构中的位置

```
                                  +-------------------+
   API (REST)  ─── gRPC/HTTP ───> |  orchestrator svc |
                                  +-------------------+
                                            |
                                            v
                +---------------------------------------------------+
                |              pkg/sandbox (本模块)                 |
                |                                                   |
                |   Factory  ─── CreateSandbox / ResumeSandbox     |
                |     │                                             |
                |     +── fc.Process    (Firecracker 进程控制)      |
                |     +── rootfs.Provider (NBD/Direct 磁盘)         |
                |     +── uffd.MemoryBackend (按需分页 / 写时复制)  |
                |     +── network.Slot  (网络命名空间 + 防火墙)     |
                |     +── cgroup.Handle (资源计量)                  |
                |     +── block.* (缓存/分块/去重)                  |
                |     +── template.* (镜像/快照缓存)                |
                |     +── build.*   (差异/上传)                     |
                |     +── Checks    (健康检查 + ClickHouse)         |
                +---------------------------------------------------+
                                            |
                                            v
                                     Firecracker VM
```

- 上游:`pkg/server`(gRPC)、`pkg/api/sandbox`(handler)调用 `Factory.Create/Resume/Pause`。
- 下游:`firecracker` 进程、内核 NBD 设备、Linux netlink/iptables、cgroup v2、`/proc/self/...`、GCS(经 `storage.StorageProvider`)。

---

## 2. 目录结构(本模块范围内)

```
pkg/sandbox/
├── sandbox.go              # 顶层入口:Factory/Sandbox/Config/Resources
├── cleanup.go              # Cleanup:优先级 + 普通 + 幂等清理
├── reclaim.go              # 暂停前回收:fstrim/sync/drop_caches/cgroup freeze
├── map.go                  # Map:live+network 两套索引,订阅者
├── checks.go / health.go / metrics.go
│                           # 健康检查 + /health + /metrics 代理到 envd
├── hoststats.go / hoststats_collector.go
│                           # 周期性 cgroup 采样 → ClickHouse
├── snapshot.go / snapshot_metrics.go / diffcreator.go
│                           # Pause 产物(Snapshot)+ 指标
├── build_upload.go / build_upload_v3.go / build_upload_v4.go
│                           # 将 Snapshot 上传到 GCS 的两个版本
├── uploads.go              # Uploads:跨 orch 等待 + Redis pub/sub
├── envd.go / envd_process.go
│                           # 与 envd 的 HTTP/gRPC 交互
├── fc/                     # Firecracker 进程抽象:Start/Pause/Resume/Snapshot
├── block/                  # 块设备缓存:Cache/Chunker/Dedup/Overlay/Memfd
├── nbd/                    # Linux NBD 内核驱动 + 用户态协议
├── uffd/                   # userfaultfd:按需分页、写时复制、prefetch
├── cgroup/                 # cgroup v2:cpu/memory 计量
├── network/                # veth + tap + 防火墙 + 出口代理
├── rootfs/                 # rootfs overlay 的两种实现
├── socket/                 # Unix 域 socket 等待工具
├── template/               # 模板缓存(本地 + peer 路由)
├── build/                  # build diff 的存储/读取/上传
└── docs/                   # 本目录
```

---

## 3. 核心类型(类型地图)

| 类型 | 位置 | 职责 |
|------|------|------|
| `Factory` | `sandbox.go` | 创建/恢复沙箱的工厂,持有共享池(网络/设备/特性开关) |
| `Sandbox` | `sandbox.go` | 单个沙箱实例,持有 Resources + Metadata + 生命周期句柄 |
| `Config` / `RuntimeMetadata` | `sandbox.go` | 静态配置 + 运行时元信息 |
| `Map` | `map.go` | live sandbox 集合 + IP 索引 + 订阅者广播 |
| `Cleanup` | `cleanup.go` | 清理钩子注册 + LIFO 顺序 + 优先级 + 幂等 |
| `Checks` | `checks.go` | 周期性 /health 检查 + 状态切换 + ClickHouse 事件 |
| `fc.Process` | `fc/process.go` | Firecracker 进程(linux 子进程)的全生命周期 |
| `rootfs.Provider` | `rootfs/rootfs.go` | 抽象 rootfs 暴露方式(NBD 或 Direct) |
| `uffd.MemoryBackend` | `uffd/memory_backend.go` | 抽象 memfile 后端(UFFD 真按需分页或 Noop) |
| `network.Slot` | `network/slot.go` | 沙箱的网络命名空间 + tap + 防火墙 + IP 分配 |
| `cgroup.CgroupHandle` | `cgroup/manager.go` | 单 sandbox cgroup(CLONE_INTO_CGROUP 注入) |
| `block.Cache` | `block/cache.go` | mmap 化的本地块缓存(dirty/zero 追踪) |
| `block.Chunker` | `block/streaming_chunk.go` | 流式拉取 + fetch session 复用 |
| `block.Dedup` | `block/dedup.go` | 与 base memfile 的页级去重 + 廉价父帧提升 |
| `block.Memfd` | `block/memfd.go` | FC 传来的 memfd 包装(zero-copy) |
| `nbd.DirectPathMount` | `nbd/path_direct.go` | NBD 用户态服务端 + 内核 netlink 注入 |
| `template.Cache` | `template/cache.go` | 模板内存缓存(ttlcache)+ NFS + P2P 路由 |
| `build.Diff` | `build/build.go` | 一层 build diff 的统一接口 |

---

## 4. 关键调用链

### 4.1 创建冷启动沙箱(无现成 snapshot)

```
Factory.CreateSandbox
  ├─ 分配 network slot            (network.Pool.Get)
  ├─ 创建 rootfs overlay          (rootfs.NewNBDProvider / DirectProvider)
  │    └─ 异步 Open:nbd.Connect  ── 内核 NBD 设备
  ├─ 取 memfile 头部/大小
  ├─ 创建 cgroup                  (cgroup.Manager.Create,返回 FD)
  ├─ 启动 fc 进程                 (fc.NewProcess → configure → SetBoot/Net/Drives)
  ├─ 安装 uffd(本路径走 NoopMemory,不走 UFFD)
  ├─ 异步等 fc.Exec 退出
  ├─ 注册到 Map.MarkRunning
  └─ WaitForEnvd → 调用 POST /init(无限重试)
```

### 4.2 从 snapshot 恢复(快路径)

```
Factory.ResumeSandbox
  ├─ 拿 uffd handle promise
  ├─ 启动 uffd 服务                 (uffd.Uffd.Start → handle unix msg)
  │    └─ FC 连接后发 region mappings + UFFD fd(可能含 memfd)
  ├─ 异步启动 prefetcher            (prefetch.New,若 meta.Prefetch.Memory)
  ├─ 分配 network slot
  ├─ 异步创建 rootfs overlay
  ├─ fcHandle.Resume(snapfile, uffd, useMemfd)
  │    └─ 加载 snap + 连接 uffd 后端 + 设置 MMDS
  ├─ 注册到 Map.MarkRunning
  ├─ WaitForEnvd                    (成功后才把 Stats 计入 startup 指标)
  └─ 启动 Checks + 等退出
```

### 4.3 暂停 → 快照

```
Sandbox.Pause(meta, useCase)
  ├─ bestEffortReclaim
  │    ├─ 选配 freeze user cgroup (envd /freeze)
  │    └─ 通过 envd 系统 shell 跑 fstrim/sync/drop_caches/compact_memory
  ├─ DrainBalloon                    (FPH,按 useCase 超时)
  ├─ process.Pause                   (FC PATCH /vm state=Paused)
  ├─ process.CreateSnapshot(snapfile)
  ├─ memory.DiffMetadata            (UFFD → diff,或 Noop → FC /memory)
  ├─ pauseProcessMemory             (FC.ExportMemory:memfd → 去重 → cache)
  ├─ pauseProcessRootfs             (overlay.EjectCache → ExportToDiff)
  ├─ 落 metadata.json 到 cache
  └─ 返回 Snapshot{MemfileDiff, RootfsDiff, Snapfile, Metafile, BuildID, ...}
```

### 4.4 关闭

```
Sandbox.Stop  (幂等,内部 utils.Lazy[error] 保证只跑一次)
  ├─ Checks.Stop
  ├─ process.Stop
  │    ├─ 删 metrics FIFO
  │    ├─ SIGTERM → 10s 等待
  │    └─ SIGKILL(若未退出,记录 pre-kill 状态)
  ├─ memory.Stop                    (UFFD fdExit.SignalExit)
  └─ Cleanup.Run
       ├─ priority:Stop
       ├─ cgroup.Remove(rmdir → cgroup.kill → rmdir)
       ├─ NBD Close / Overlay.Close
       ├─ markStopping(LifecycleID 守卫)
       ├─ hostStatsCollector.Stop
       └─ 删除临时 socket/链接
```

---

## 5. 与 envd 交互的入口

| 入口 | 文件 | 用途 |
|------|------|------|
| `POST /init` | `envd.go:doRequestWithInfiniteRetries` | 启动时告知 envd sandbox 元数据 |
| `GET /health` | `health.go:getHealth` | Checks 周期性轮询 |
| `GET /metrics` | `metrics.go:GetMetrics` | 拉取 envd 内的 sandbox 级指标 |
| `POST /freeze` / `/unfreeze` | `envd.go:callEnvdCgroupOp` | reclaim 阶段冻结用户 cgroup |
| Connect-RPC `/process.Start` | `envd_process.go:StartEnvdShell` | reclaim 用 envd 系统 shell 跑回收脚本 |

---

## 6. 关键不变量(阅读源码时关注)

1. **LifecycleID**:每个 Firecracker 进程独立 lifecycle,与 ExecutionID 区分;`Map.MarkStopping` 用 lifecycleID 守卫,防止旧 sandbox 的清理覆盖新一次 resume。
2. **mmap dirty/zero 双 bitmap**:`block.Tracker` 用 disjoint dirty+zero 位图,Present 表示脏或已知零。
3. **并发安全**:`Cache` 写路径有写锁;`Slice` 返回的是 mmap 视图,调用方需保证同一块不并发写。
4. **FC 进程句柄关闭**:`Process.Stop` 内 `context.WithoutCancel` 保证不会因请求 ctx 取消而失败。
5. **NBD dispatch 的 fatal channel**:`d.fatal` 把 writeResponse 错误上报主循环;backend 错误只回响应并保留 dispatch 循环。
6. **Cleanup 的 LIFO + 优先级**:`AddPriority` 先 LIFO 执行(用于 Stop),`Add` 后 LIFO 执行(用于资源回收)。
7. **dedup 的 cheap-frame promotion**:`promoteCheapFrames` 阈值由 `BlockFaultPct` 决定,默认 0=不提升。
8. **startupStatsOnce**:在 `WaitForEnvd` 内只记一次 UFFD startup stats,避免被后续 WaitForEnvd 污染。

---

## 7. 文档索引(按学习顺序)

| 序 | 文档 | 主题 |
|----|------|------|
| 1 | `01-sandbox-entry.md` | `sandbox.go`:Factory / Sandbox / Config / Resources / Create / Resume / Pause / Stop |
| 2 | `02-cleanup-reclaim-map.md` | `cleanup.go` + `reclaim.go` + `map.go` |
| 3 | `03-checks-hoststats.md` | `checks.go` / `health.go` / `metrics.go` / `hoststats*.go` |
| 4 | `04-snapshot-and-uploads.md` | `snapshot.go` + `build_upload*.go` + `uploads.go` + `snapshot_metrics.go` |
| 5 | `05-fc.md` | Firecracker 进程抽象 + 启动脚本 + 指标 |
| 6 | `06-block.md` | 块设备抽象 + Cache + Tracker + Overlay + Chunker + Memfd + Dedup |
| 7 | `07-nbd.md` | NBD 设备池 + 用户态 dispatch + netlink 连接 |
| 8 | `08-uffd.md` | userfaultfd:按需分页、memfd、prefetch、fdexit |
| 9 | `09-cgroup-network-rootfs.md` | cgroup v2 / 网络 / rootfs 暴露 |
| 10 | `10-template-and-build.md` | template.Cache 与 build.File 协同 |

---

## 8. 阅读建议路线

1. **先看 `sandbox.go`** 的 `Factory.CreateSandbox` 和 `ResumeSandbox`,把"创建"和"恢复"两条路径的字段和顺序捋清楚。
2. **再走 `fc/process.go` 的 `Create` / `Resume`**,看 FC API 调用序列(boot source → rootfs drive → network iface → machine config → start)。
3. **然后看 `block/`**:从 `Cache` 的 mmap 基础开始,再到 `Memfd`/`Overlay`,最后到 `Dedup` 与 `Chunker`。
4. **UFFD 与 NBD 是 cold/warm 路径的核心差异**,分别看 `uffd/uffd.go` 的 `handle`(FC 连接握手)和 `nbd/path_direct.go` 的 `Open`(`nbdnl.Connect`)。
5. **Pause 链** 是数据流最复杂的一环:同时涉及 uffd diff、memfd 拷贝、dedup、rootfs diff、metadata 写入、scheduling 元数据计算,看 `sandbox.go:Pause` 主函数 + `pauseProcessMemory` + `pauseProcessRootfs` 三个函数即可。
