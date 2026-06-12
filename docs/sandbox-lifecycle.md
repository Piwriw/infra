# Sandbox 生命周期控制详解

E2B 的 sandbox 生命周期控制是一个**多层协调**的系统，从 API 网关层到 orchestrator 核心层，再到 VM 内部守护进程。本质上每个 sandbox 是一个 **Firecracker microVM** 实例，由 orchestrator 进程通过 gRPC 管理。

## 🏗️ 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     API 网关层 (Gin 处理器)                        │
│  sandbox_create / pause / resume / kill / refresh / connect / ... │
└──────────────┬───────────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────┐
│              API Orchestrator 客户端层 (orchestrator/orchestrator.go) │
│  节点发现 + 沙箱存储 + 放置算法 + 驱逐 + 路由 + 资源指标          │
│   ├─ create_instance.go: CreateSandbox (主创建流程)               │
│   ├─ pause_instance.go: pauseSandbox / snapshotInstance           │
│   ├─ delete_instance.go: 删除 VM + 清理 DB/缓存                    │
│   ├─ keep_alive.go: 会话保活 (refresh token)                       │
│   ├─ autoresume.go: 自动恢复 paused sandbox                         │
│   └─ evictor/evict.go: evictSandbox (TTL 到期驱逐)                 │
└──────────────┬───────────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────┐
│           Orchestrator 核心层 (orchestrator/pkg/sandbox/sandbox.go) │
│  Sandbox 结构体: Config + Runtime + Volume + Slot + Checks + Files │
│  1519 行的状态机: 创建/启动/暂停/恢复/销毁                          │
└──────────────┬───────────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────┐
│                   VM 守护进程层 (envd)                             │
│  /init (首次初始化,含 CA bundle)  /freeze /unfreeze  /health      │
└──────────────────────────────────────────────────────────────────┘
```

## 📊 核心数据结构 (`packages/orchestrator/pkg/sandbox/sandbox.go`)

这是整个生命周期控制的**心脏**——一个 1519 行的核心文件，封装了：

- `Sandbox` 类：组合 Config / Runtime / Volume / Slot / Checks / Files
- `Factory` 类：sandbox 创建工厂
- `Metadata`：sandbox 元信息
- `Network` 配置：内部 IP、proxy 端口、TCP 防火墙端口

**关键函数**：
- `NewFactory()`：构造 sandbox 工厂
- `CreateSandbox()`：创建并启动
- `ResumeSandbox()`：从 paused 状态恢复
- `Wait()`：阻塞直到 sandbox 退出

## 🔄 完整生命周期流转

### 1️⃣ 创建（POST /sandboxes）

入口：`packages/api/internal/handlers/sandbox_create.go` → `orchestrator.CreateSandbox`

**主流程**：

1. **模板解析**：通过 template alias（`getTemplateById`）解析用户传入的镜像模板
2. **网络策略配置**：解析 volumes 和 egress 规则
3. **Feature flag 检查**：LaunchDarkly 标志位（是否启用 pause/resume 等）
4. **节点放置**（`placement/placement.go`）：使用 `BestOfK` 算法选择最优 orchestrator 节点
5. **资源预留**：在 Redis 中预留 CPU/内存配额
6. **Sandbox 创建**（`sandbox.go: CreateSandbox`）：
   - 配置 cgroup 资源限制（`cgroup/manager.go`）
   - 从模板缓存拉取 rootfs（`template/cache.go`）
   - 通过 NBD 挂载 rootfs（`nbd/dispatch.go`）
   - 启动 Firecracker 进程（`fc/process.go`）
   - 等待 envd /health
7. **首次初始化**（`envd.go: initSandbox`）：调用 envd `/init`，传 LifecycleID/envVars/CA bundle/volume mount
8. **路由表注册**（`lifecycle.go: addSandboxToRoutingTable`）：写入 Nomad 本地节点的 e2bcatalog，让 client-proxy 能定位到此 sandbox
9. **DB 持久化**：在 `envs` 表插入记录

### 2️⃣ 运行中 (Running)

sandbox 在运行期间由多个守护机制支撑：

- **保活机制**（`keep_alive.go`）：客户端通过 `POST /sandboxes/{id}/refresh` 续期 token，超时 sandbox 会进入 paused
- **后台 metrics 采集**（`hoststats_collector.go`）：基于 cgroup 周期性采集 CPU/内存，写入 ClickHouse（`pkg/clickhouse/pkg/hoststats/delivery.go`）
- **连接签发**（`sandbox_connect.go`）：调用 `GetConnectionToken` 颁发短期 token，client-proxy 用此 token 直连 envd

### 3️⃣ 暂停（POST /sandboxes/{id}/pause）

入口：`packages/api/internal/handlers/sandbox_pause.go` → `orchestrator.pauseSandbox`

**reclaim + snapshot 流程**（`pause_instance.go`）：

1. **best-effort reclaim**（`reclaim.go`）：
   - `freeze` cgroup（暂停进程调度）
   - `fstrim` 释放未使用块
   - `sync` 文件系统
   - `drop_caches` 清理页缓存
   - `compact_memory` 整理内存
   - 任一步骤失败都**不**影响暂停
2. **cgroup freeze**（`envd.go: freeze`）：调用 envd `/freeze` 冻结用户进程
3. **Firecracker 快照**（`fc/process.go: CreateSnapshot`）：将 VM 状态写入差分快照
4. **DB 更新**（`buildUpsertSnapshotParams`）：在 `snapshots` 表中记录快照元数据（包含 rootfs 差分、CPU 配置、envd 版本等）
5. **清理**（`cleanup.go`）：通过优先级回调队列释放 NBD、cgroup、网络 slot（`Cleanup` 类用 sync.Once 保证只 Run 一次）
6. **VM 销毁**：从 orchestrator 移除（`map.go: Sandboxes` 线程安全字典）

**Cleanup 组件关键设计**：

- `Cleanup` 类维护 `cleanup` + `priorityCleanup` 两个回调列表
- `Run()` 用 `sync.Once` 触发，Run 之后再 Add 会立即同步执行
- 关键清理：NBD 设备释放、cgroup 删除、Consul slot 归还、Redis 状态变更广播

### 4️⃣ 恢复（POST /sandboxes/{id}/resume）

入口：`packages/api/internal/handlers/sandbox_resume.go` → `orchestrator.ResumeSandbox`（也支持 `autoresume.go` 自动触发）

1. **节点放置**：同样用 `BestOfK` 算法选节点（可能与暂停前不同）
2. **快照加载**（`fc/client.go: loadSnapshot`）：从 GCS 拉取差分快照
3. **VM 启动**：基于快照恢复 Firecracker
4. **cgroup unfreeze**（`envd.go: unfreeze`）
5. **路由重新注册**到 client-proxy

### 5️⃣ 删除（DELETE /sandboxes/{id}）

入口：`sandbox_kill.go` → `delete_instance.go: DeleteInstance`

- 调用 orchestrator 释放 VM
- 清理 `snapshots` 和 `template` 关联记录
- 删除 DB envs 记录 + Redis 缓存
- 触发 `Cleanup.Run()` 释放所有底层资源

### 6️⃣ TTL 驱逐（`evictor/evict.go`）

- `evictSandbox()`：周期性扫描超时 sandbox
- 与 `keep_alive` 互斥：有 keep-alive 续期则不驱逐

## 🔑 关键设计模式

1. **Cleanup 优先级队列**（`cleanup.go`）：延迟执行的回调注册，`sync.Once` 保证只 Run 一次
2. **状态机**（`sandbox.go: Sandbox`）：1519 行核心结构，统一管理 Config/Runtime/Volume/Slot/Checks
3. **Map pub-sub**（`map.go`）：线程安全的 sandbox 字典，订阅变更广播用于 client-proxy 实时路由
4. **资源预留**（`placement/placement.go`）：通过 Redis Lua 脚本 + singleflight 保证并发安全
5. **BestOfK 放置**：从 K 个候选节点中按 CPU/内存/标签匹配度选最优（`placement_best_of_K.go`）
6. **重试无限机制**（`envd.go: requestWithRetries`）：对 envd /init 无限重试直到 sandbox healthy

## 📁 关键文件清单

| 文件 | 角色 |
|---|---|
| `packages/orchestrator/pkg/sandbox/sandbox.go` (1519 行) | 核心状态机 |
| `packages/orchestrator/pkg/sandbox/reclaim.go` | pause 前的 reclaim 流程 |
| `packages/orchestrator/pkg/sandbox/cleanup.go` | 延迟清理回调队列 |
| `packages/orchestrator/pkg/sandbox/snapshot.go` | 快照元数据 |
| `packages/orchestrator/pkg/sandbox/build_upload.go` | 模板构建上传 |
| `packages/orchestrator/pkg/sandbox/diffcreator.go` | rootfs 差分导出 |
| `packages/orchestrator/pkg/sandbox/map.go` | sandbox 字典 + pub-sub |
| `packages/orchestrator/pkg/sandbox/envd.go` | envd 通信（init/freeze/unfreeze） |
| `packages/orchestrator/pkg/sandbox/envd_process.go` | 通过 nsenter 在 VM 内拉起 envd |
| `packages/orchestrator/pkg/sandbox/hoststats_collector.go` | cgroup 资源采集 |
| `packages/orchestrator/pkg/sandbox/checks.go` | envd 周期健康检查 |
| `packages/orchestrator/pkg/sandbox/cgroup/manager.go` | cgroup v2 资源隔离 |
| `packages/orchestrator/pkg/sandbox/block/cache.go` (825 行) | mmap 块缓存 |
| `packages/orchestrator/pkg/sandbox/template/cache.go` | 模板缓存管理 |
| `packages/orchestrator/pkg/sandbox/network/pool.go` | 网络 slot 池 |
| `packages/api/internal/orchestrator/orchestrator.go` | 客户端侧编排器 |
| `packages/api/internal/orchestrator/create_instance.go` | 主创建流程 |
| `packages/api/internal/orchestrator/pause_instance.go` | pause + snapshot |
| `packages/api/internal/orchestrator/evictor/evict.go` | TTL 驱逐 |
| `packages/api/internal/orchestrator/placement/placement.go` | 节点放置 |
| `packages/api/internal/handlers/sandbox_*.go` | REST API handlers |

## 🌊 完整状态流图

```
                          ┌──────────────┐
            create ──────▶│  CREATING    │
                          └──────┬───────┘
                                 │ init success
                                 ▼
            ┌─────── keep_alive ─┴────────┐
            │                            │
   resume   │       ┌──────────────┐     │ timeout/evict
  ┌─────────┴───┐   │   RUNNING    │◀────┘
  │   PAUSED    │◀──┤              │
  │ (snapshot)  │   └──────┬───────┘
  └─────────────┘          │ kill / TTL / error
                           ▼
                  ┌────────────────┐
                  │  KILLING / DEAD │
                  └────────────────┘
```

---

> **注**：本说明基于 `E2B Infrastructure` 代码库（commit `a7455d100`，共 1,891 个源文件、6,752 个知识图谱节点），由 `/understand-anything:understand-chat` 技能基于 `.understand-anything/knowledge-graph.json` 自动生成。
