# Firecracker 模块实现原理详解

> 本文档详细介绍 E2B Infra 中 Orchestrator 服务对 Firecracker microVM 的封装与扩展实现。
> 代码主路径:`packages/orchestrator/pkg/sandbox/`

---

## 目录

1. [Firecracker 与 E2B 的关系](#1-firecracker-与-e2b-的关系)
2. [整体架构与模块划分](#2-整体架构与模块划分)
3. [核心数据结构](#3-核心数据结构)
4. [fc/ — Firecracker 进程与 API 客户端](#4-fc--firecracker-进程与-api-客户端)
5. [rootfs/ — 根文件系统提供者](#5-rootfs--根文件系统提供者)
6. [nbd/ — Network Block Device 设备池](#6-nbd--network-block-device-设备池)
7. [uffd/ — 用户态缺页内存后端](#7-uffd--用户态缺页内存后端)
8. [network/ — 沙箱网络](#8-network--沙箱网络)
9. [template/ — 模板缓存层](#9-template--模板缓存层)
10. [block/ — 块设备抽象](#10-block--块设备抽象)
11. [cgroup/ — 资源记账](#11-cgroup--资源记账)
12. [生命周期:Create 与 Resume](#12-生命周期create-与-resume)
13. [快照流程:Pause 与导出](#13-快照流程pause-与导出)
14. [Envd:VM 内守护进程握手](#14-envdvm-内守护进程握手)
15. [可观测性](#15-可观测性)

---

## 1. Firecracker 与 E2B 的关系

[Firecracker](https://firecracker-microvm.github.io/) 是 AWS 开源的轻量级虚拟化引擎,基于 KVM,专门为多租户、短生命周期的工作负载设计。E2B 把它作为代码沙箱的执行载体,在它的基础上做了若干关键扩展:

| 需求 | 上游 Firecracker | E2B 的扩展 |
|------|----------------|-----------|
| 秒级冷启动 | 标准 KVM boot | 通过快照 + UFFD 恢复 |
| 内存按需加载 | 快照恢复时整段读 | UFFD 按需分页 |
| 跨节点共享 | 无 | rootfs/memfile 分块去重 + GCS/对等网络传输 |
| 多租户网络 | 简单 TAP | 网络命名空间 + veth/vpeer + nftables |
| 限速 | 简单 token bucket | LD flag 驱动的动态速率限制 |
| 内存回收 | balloon | free-page-hinting / free-page-reporting |

Orchestrator 通过 Firecracker 的 REST API(Unix Socket)控制 VM,并对上游做了一些 fork(在 `packages/shared/pkg/fc/` 里),增加了一些自定义端点(如导出内存、获取 resident pages)。

---

## 2. 整体架构与模块划分

```
                  ┌─────────────────────────────────────────────┐
                  │                Sandbox (聚合根)              │
                  │   Resources:Slot + rootfs.Provider + memory  │
                  │   Metadata:Config + Runtime + lifecycle      │
                  └────────────┬────────────────────────────────┘
                               │ 持有
        ┌──────────────┬───────┴──────┬──────────────┬───────────┐
        ▼              ▼              ▼              ▼           ▼
   fc.Process    rootfs.Provider  uffd.Memory   network.Slot  cgroup
   (FC 进程)     (CoW rootfs)     Backend       (netns+tap)   (资源)
        │              │              │              │
        │         ┌────┴─────┐   ┌────┴────┐   ┌────┴────┐
        │         ▼          ▼   ▼         ▼   ▼         ▼
        │     NBD        Direct  Uffd    Noop   Pool     Firewall
        │   Provider    Provider              │           (nftables)
        │      │                                 │
        │      ▼                                 ▼
        │   nbd.DevicePool                newSlots /
        │   (/dev/nbdX)                   reusedSlots
        │
        ▼
   Firecracker (REST API via Unix Socket)
        │
        ▼
   KVM + 内核 (vmlinux + initramfs)
        │
        ▼
   沙箱内的 Envd 守护进程
```

| 子包 | 职责 |
|------|------|
| `fc/` | Firecracker 进程启动、API 调用、kernel args、MMDS、内存导出 |
| `rootfs/` | 把模板 rootfs 包装成可写的 CoW 块设备 |
| `nbd/` | NBD 设备池,提供 `/dev/nbdX` 块设备 |
| `uffd/` | 用户态缺页处理,实现内存按需加载 |
| `network/` | 沙箱的网络命名空间、IP 池、防火墙 |
| `template/` | 模板(rootfs + memfile + snapfile)的本地缓存与获取 |
| `block/` | 块设备的通用抽象:cache、overlay、dedup、memfd |
| `cgroup/` | 把 FC 进程放入 cgroup 做资源记账 |
| `envd/` | 与 VM 内的 envd 守护进程通信的客户端代码 |

---

## 3. 核心数据结构

### 3.1 `Sandbox`(聚合根)

定义在 `pkg/sandbox/sandbox.go:235`。一个 `Sandbox` 实例对应一次 Firecracker 生命周期(无论冷启动还是快照恢复)。

关键字段:

```go
type Sandbox struct {
    *Resources                                       // Slot、rootfs、memory
    *Metadata                                        // Config、Runtime、startedAt、endAt

    LifecycleID string  // 每次 FC 进程启动都换新;用于 Map 的淘汰保护

    process      *fc.Process                         // FC 进程句柄
    cgroupHandle *cgroup.CgroupHandle                // cgroup 句柄
    Template     template.Template                   // 模板引用

    cleanup *Cleanup                                 // 反向清理栈
    exit    *utils.ErrorOnce                         // 单次退出错误
    stop    utils.Lazy[error]                        // Stop 的幂等包装
}
```

### 3.2 `Config`(运行参数)

`pkg/sandbox/sandbox.go:77`,描述一个沙箱的"启动参数":

```go
type Config struct {
    Vcpu, RamMB        int64
    HugePages          bool                          // 2 MB 大页
    FreePageReporting  bool                          // balloon 特性
    FreePageHinting    bool

    Envd              EnvdMetadata                   // 注入到 VM 内的 envd 元数据
    FirecrackerConfig fc.Config                      // 内核 / FC 版本

    VolumeMounts      []VolumeMountConfig            // 额外挂载点
    Network           *orchestrator.SandboxNetworkConfig
    mu                *sync.RWMutex                  // 保护 Network 的并发修改
}
```

`Config.Network` 用读写锁保护 —— 运行时可以通过 `SetNetworkEgress` 动态更新防火墙规则而不阻塞启动。

### 3.3 `Resources`(可释放资源)

```go
type Resources struct {
    Slot   *network.Slot            // 网络命名空间槽
    rootfs rootfs.Provider          // CoW rootfs 提供者
    memory uffd.MemoryBackend       // 内存后端(UFFD 或 Noop)
}
```

这三者都需要在沙箱销毁时释放,所以放在同一个结构里方便 `Cleanup` 管理。

---

## 4. fc/ — Firecracker 进程与 API 客户端

这是整个项目最核心的子包,所有与 Firecracker 二进制的交互都集中在这里。

### 4.1 `Config`(版本管理)— `fc/config.go:31`

```go
type Config struct {
    KernelVersion      string  // 例如 "5.10.186"
    FirecrackerVersion string  // 例如 "1.10.0"
}
```

E2B 同时支持多套内核和 Firecracker 版本,沙箱使用哪个由模板决定。文件里有两个关键的路径解析函数:

- `HostKernelPath(config)`:`{ kernels_dir }/{ version }/{ arch }/vmlinux.bin`
  - 优先 arch 子目录,失败回退到 `{ version }/vmlinux.bin`(老节点兼容)
- `FirecrackerPath(config)`:同样的逻辑,寻找 `firecracker` 二进制

这种"arch-prefixed + legacy fallback"的设计是为了让同一个集群能同时跑 x86_64 和 arm64 节点。

### 4.2 `Process` — FC 进程封装

`fc/process.go:121`:

```go
type Process struct {
    Versions Config
    cmd      *exec.Cmd                       // 启动 FC 的 exec 句柄

    firecrackerSocketPath string             // /path/to/sandbox.sock
    metricsPath           string             // /path/to/metrics.fifo

    slot           *network.Slot             // 沙箱网络槽
    rootfsProvider rootfs.Provider           // rootfs 路径提供者

    Exit   *utils.ErrorOnce                  // 进程退出信号(单次)
    client *apiClient                        // REST 客户端
    balloonAccum atomic.Pointer[BalloonMetricsSnapshot]
}
```

#### 4.2.1 进程启动 — `NewProcess` + `configure`

Firecracker **不是直接 `exec` 二进制**,而是包在一段 bash 启动脚本里(`fc/script_builder.go`):

```bash
# startScriptV2(简化):
mount --make-rprivate / &&
mount -t tmpfs tmpfs {{ SandboxDir }} -o X-mount.mkdir &&

# 把 host 上的 rootfs/kernel 软链到沙箱私有 mount 命名空间
ln -s {{ HostRootfsPath }} {{ SandboxDir }}/rootfs.ext4 &&
mkdir -p {{ SandboxDir }}/{{ KernelVersion }} &&
ln -s {{ HostKernelPath }} {{ SandboxDir }}/{{ KernelVersion }}/vmlinux.bin &&

# 在沙箱专属 netns 里启动 firecracker
ip netns exec {{ NamespaceID }} {{ FirecrackerPath }} --api-sock {{ Socket }}
```

为什么要这么复杂?

1. **隔离 mount 命名空间**:`unshare -m` 让 FC 进程看到自己的 `/`,可以挂载 tmpfs、做软链而不影响宿主机。
2. **路径稳定**:FC 一旦启动,它会记住 rootfs/kernel 的路径;通过软链,我们能"先启动 FC、再绑定真实 rootfs"(典型技巧,见 §12)。
3. **网络命名空间**:`ip netns exec ns-N` 让 FC 创建的 TAP 设备只在该 netns 可见,与其它沙箱隔离。

`configure` 函数(`process.go:211`)做几件事:

1. 设置 stdout/stderr:`zapio.Writer` 把日志发到 zap,还套了个 `fcLogFilter`(`process.go:47`)过滤掉每几秒一次的 `FlushMetrics` 噪声日志。**Filter 是状态化的**(atomic flag),利用 FC API 服务器单线程特性:请求和响应日志永远相邻。
2. 设置 cgroup FD:`SysProcAttr.UseCgroupFD = true`,通过 `CLONE_INTO_CGROUP` 原子地把进程放入预先建好的 cgroup。比"先 fork 再 echo pid > cgroup.procs"更安全,没有竞争窗口。
3. `syscall.Mkfifo(metricsPath, 0o600)` 创建 metrics FIFO。
4. `cmd.Start()` + 一个 goroutine 调用 `cmd.Wait()`,把退出错误写到 `Exit *ErrorOnce`。
5. `socket.Wait(...)` 轮询等待 FC 的 API socket 出现(默认 10ms 间隔)。

#### 4.2.2 冷启动 `Create`(`process.go:303`)

调用 Firecracker REST API 顺序构造 VM。每一步出错都要 `Stop()` 把 FC 进程杀掉:

```
1. 把 rootfs link 指向 /dev/null        (SymlinkForce,允许 FC 启动而 rootfs 还没准备好)
2. configure()                          (启动 FC 进程,等 socket)
3. startMetricsReader() + setMetrics    (建立 metrics 通道)
4. setBootSource(kernelArgs, kernelPath)
5. 把 rootfs link 重指向真实路径
6. setRootfsDrive(rootfsPath, ioEngine, rateLimiter)
7. setNetworkInterface(vpeer, tap, mac, txRateLimiter)
8. setMachineConfig(vcpu, memoryMB, hugePages)
9. setEntropyDevice()
10. installBalloon()                    (可选,如果开 free-page-reporting/hinting)
11. startVM()
```

**关键点**:`/dev/null` → 真实 rootfs 的两步软链,是为了让 rootfs Provider(NBD)能和 FC 启动**并行**进行 —— FC 启动慢,等它启动后再让 NBD 完成 mount 也能赶得上。

### 4.3 Kernel Args — `fc/kernel_args.go`

非常简单的 `map[string]string` + 序列化。E2B 用的关键参数(`process.go:351`):

| 参数 | 值 | 含义 |
|------|-----|------|
| `quiet`, `loglevel=1` | | 关闭内核日志(生产模式加速) |
| `init` | `/init.so` | 内核 init 程序(就是 envd) |
| `ip` | `169.254.0.21::169.254.0.22:255.255.255.252:instance:eth0:off:tap0` | 内核内置 IP 配置,跳过 DHCP |
| `ipv6.disable=0`, `ipv6.autoconf=1` | | 启用 IPv6 SLAAC |
| `panic=1`, `reboot=k` | | panic 后 1 秒重启 |
| `pci=off` | | 关闭 PCI 枚举(用 MMIO) |
| `rootflags=discard` | | ext4 TRIM on free → 块从快照 diff 中消失 |

`console=ttyS0` + `loglevel=5` 只在调试模式下打开,会通过 FC stdout 拿到内核日志。

### 4.4 REST API 客户端 — `fc/client.go`

```go
type apiClient struct {
    client *client.Firecracker   // go-swagger 生成的客户端
}

func newApiClient(socketPath string) *apiClient {
    client := client.NewHTTPClient(strfmt.NewFormats())
    transport := firecracker.NewUnixSocketTransport(socketPath, nil, false)
    client.SetTransport(transport)
    ...
}
```

走 **Unix Socket HTTP**,所有 API 调用都是 swagger 生成的强类型方法。比如 `setMachineConfig`(`client.go:361`):

```go
smt := runtime.GOARCH != archARM64    // ARM 不支持超线程
machineConfig := &models.MachineConfiguration{
    VcpuCount:       &vCPUCount,
    MemSizeMib:      &memoryMB,
    Smt:             &smt,
    TrackDirtyPages: &trackDirtyPages,
}
if hugePages {
    machineConfig.HugePages = models.MachineConfigurationHugePagesNr2M
}
```

ARM 上 `Smt=false` 是**硬性要求**:ARM 的 big.LITTLE 拓扑与 x86 SMT 不兼容,FC 会拒绝。这里特意用 `runtime.GOARCH`(而不是 `utils.TargetArch()`),因为 orchestrator 二进制和 FC 永远跑在同架构。

### 4.5 LoadSnapshot 与 MMDS

#### Resume 路径(`client.go:42`)

```go
backend := &models.MemoryBackend{
    BackendPath: &uffdSocketPath,
    BackendType: &backendType,  // "Uffd"
}
if useMemfd {
    backend.UseMemfd = &useMemfd   // 新版 FC 才支持
}

snapshotConfig := operations.LoadSnapshotParams{
    Body: &models.SnapshotLoadParams{
        ResumeVM:            false,           // 暂不 resume,后面单独 PATCH
        EnableDiffSnapshots: false,
        MemBackend:          backend,
        SnapshotPath:        &snapfilePath,
    },
}
client.Operations.LoadSnapshot(&snapshotConfig)

<-uffdReady    // 等 UFFD 通知"我准备好了"
```

`ResumeVM: false` 是为了在 `Resume` 流程里能插入更多操作(速率限制、MMDS)再 `PatchVM(Resumed)`。

#### MMDS(MicroVM Metadata Service)— `fc/mmds.go`

```go
type MmdsMetadata struct {
    SandboxID            string `json:"instanceID"`
    TemplateID           string `json:"envID"`
    LogsCollectorAddress string `json:"address"`
    AccessTokenHash      string `json:"accessTokenHash,omitempty"`
}
```

类似 AWS IMDS,VM 内可以通过特殊路由(默认 `169.254.169.254`)拿到自己的元数据。VM 内 envd 启动时会读取它,知道:
- 自己是哪个沙箱(`instanceID`)
- 日志要发往哪里(`address` = orchestrator in-sandbox IP)
- 客户端的 access token 哈希(用于鉴权)

**注意注释里说"序列化字段名不能改"** —— 因为 VM 内的 envd 在用同样的字段名解析,改了就破坏向后兼容。

### 4.6 速率限制

`fc/process.go:108` 定义了 token bucket 配置:

```go
type TokenBucketConfig struct {
    BucketSize   int64  // < 0 表示禁用
    OneTimeBurst int64
    RefillTimeMs int64
}

type RateLimiterConfig struct {
    Ops       TokenBucketConfig  // 网络包/秒  或  IOPS
    Bandwidth TokenBucketConfig  // 字节/秒
}
```

`buildRateLimiter`(`client.go:262`)的语义:
- 两个 bucket 都禁用 → 整个 RateLimiter 为 `nil`(不限制)
- 至少一个启用 → 返回 `RateLimiter{Ops, Bandwidth}`

Resume 路径里**总是**调一次 `setTxRateLimit` / `setDriveRateLimit`,即便禁用也会发空 `RateLimiter{}` PATCH,目的是**覆盖快照中持久化的旧限制**。

### 4.7 内存导出 — `fc/memory.go`

这是 E2B 对上游 FC 的核心 fork 扩展之一。沙箱做快照时需要把"脏页"导出到本地缓存,有三种路径:

1. **memfd + dedup**(最优):新版 FC 通过 `use_memfd` 把整个内存作为 memfd 共享,我们 `mmap` 它直接读;还能与原始 memfile 对比去掉未修改页。
2. **memfd 无 dedup**:直接 mmap memfd。
3. **从 FC 进程内存读**:对老版 FC,通过 `GetMemoryMappings` API 拿到 guest 物理地址 → host 虚拟地址映射,然后用 `/proc/{pid}/mem` + process VM read 拷贝出来。

`ExportMemory`(`memory.go:73`)还把 diff metadata 异步化:dedup 路径下,header 在 goroutine 里产出,`Pause` 函数可以提前返回。

### 4.8 自定义 FC 端点

`client.go` 里有几个上游 FC 不存在的方法,只能在 E2B 的 FC fork 上工作:

- `GetMemoryMappings` → 获取 guest 物理 → host 虚拟地址映射
- `GetMemory` → 返回 resident pages + empty pages(`memoryInfo`,通过 roaring bitmap 压缩)
- `GetDirtyMemory` → 返回脏页 bitmap(`dirtyMemory`,WP-async pagemap)
- `StartBalloonHinting` / `DescribeBalloonHinting` → 触发并轮询 free-page-hinting 周期

### 4.9 版本能力探测 — `fc/fph_gates.go`

```go
func FCSupportsFreePageHinting(fcVersion string) bool { ... }
func FCSupportsMemfd(fcVersion string) bool { ... }
```

调用方在用某个特性前先检查,避免老版 FC 收到不认识的字段直接拒绝请求。

### 4.10 Metrics — `fc/fc_metrics.go`

FC 把 metrics 写到一个 FIFO(`PutMetrics` 设置路径)。`startMetricsReader`(`fc_metrics.go:271`)做得很精巧:

1. 先 `O_RDWR` 打开 FIFO(自己同时做读写端,避免阻塞在 `open`)
2. 再 `O_RDONLY` 打开作为读端
3. 一个 goroutine 等 `p.Exit.Done()`,关闭 `O_RDWR` FD → 这样 FC 退出后,读端会收到 EOF
4. 另一个 goroutine 用 `bufio.Scanner` 解析 JSON 行,把 net/block/balloon 指标发到 OTEL
5. 还有一个 flusher goroutine 每 5 秒调一次 `FlushMetrics` API,而不是依赖 FC 默认的 60 秒

`monitorDirtyPageThrottle`(`fc_metrics.go:121`)是进程级后台 goroutine,每秒读 `/proc/self/task/*/wchan`,统计有几个线程卡在 `balance_dirty_pages`。`rate()` 这个 counter 可以实时反映写入限流强度,是定位 GCS 上传慢和脏页限流的唯一可靠信号。

---

## 5. rootfs/ — 根文件系统提供者

接口 `Provider`(`rootfs.go:22`):

```go
type Provider interface {
    Start(ctx context.Context) error
    Close(ctx context.Context) error
    Path() (string, error)                                  // 给 FC 用的设备路径
    ExportDiff(ctx context.Context, out *os.File, ...) (*header.DiffMetadata, error)
}
```

两个实现:

### 5.1 `NBDProvider`(`rootfs/nbd.go`)

生产路径。流程:

```
模板 rootfs (只读,来自 GCS 或本地缓存)
         │
         ▼
    block.Overlay (CoW)
         │                ┌─→ block.Cache (本地 mmap 文件,记录脏块)
         └── 读路径 ──────┘
         │
         ▼
   nbd.DirectPathMount
         │
         ▼
    /dev/nbdX  (内核 NBD 设备)
         │
         ▼
    给 FC 作 rootfs drive
```

`NewNBDProvider`(`nbd.go:36`):

```go
size, _ := rootfs.Size(ctx)
blockSize := rootfs.BlockSize()
cache, _ := block.NewCache(size, blockSize, cachePath, false)
overlay := block.NewOverlay(rootfs, cache)
mnt := nbd.NewDirectPathMount(overlay, devicePool, featureFlags)
```

`Overlay` 把对块设备的读分成两路:
- 命中 cache(已写过) → 读本地 mmap
- 未命中 → 读模板(底层 GCS chunk)

`Start`(`nbd.go:64`)从 `DevicePool` 申请一个 NBD 设备号,启动 NBD server 把 overlay 暴露为 `/dev/nbdX`。`Path()` 返回该路径。

`Close`(`nbd.go:130`)的关键:`BLKFLSBUF` ioctl 强制把内核 page cache 刷出来,然后 `fsync` —— 保证后续 diff 导出能拿到完整的脏块。

`ExportDiff`(`nbd.go:73`)用于"在沙箱还活着时导出 diff"的场景(比如 build):先 eject cache(把 overlay 切到只读模式),然后异步停止沙箱,等 overlay 完成所有 in-flight 操作,最后 `cache.ExportToDiff`。

### 5.2 `DirectProvider`

跳过 NBD,直接把 rootfs 文件路径给 FC。用于 build 场景,沙箱要直接修改模板 rootfs。代码在 `rootfs/direct.go`。

---

## 6. nbd/ — Network Block Device 设备池

Linux 内核有 NBD 模块(`modprobe nbd nbds_max=4096`),`/dev/nbd0` ~ `/dev/nbd{N-1}`。每个沙箱需要一个独立的 NBD 设备号作为 rootfs。

`DevicePool`(`nbd/pool.go:74`)用 bitset + channel 实现:

```go
type DevicePool struct {
    usedSlots *bitset.BitSet       // 快速查找空闲槽位
    mu        sync.Mutex
    slots     chan DeviceSlot       // 预热好的 slot 缓冲队列
}
```

关键操作:

- `getFreeDeviceSlot`(`pool.go:233`):bitset 找下一个 clear bit,然后 `isDeviceFree` 检查 `/sys/block/nbdX/pid` 是否存在、`size` 是否为 0,**双保险**防止内核状态错乱。
- `GetDevice`(`pool.go:267`):从 channel 拿,带计数。
- `ReleaseDevice`(`pool.go:301`):支持 `WithInfiniteRetry`(无限重试)和 `WithTimeout`。

`Populate` 在后台持续预热 slot,直到 channel 满。

---

## 7. uffd/ — 用户态缺页内存后端

UFFD(userfaultfd)是 Linux 的一个系统调用,允许用户态程序接管"缺页异常"。E2B 用它实现**内存按需加载**:沙箱从快照恢复时,不把整个 memfile 读进内存,而是 FC 访问到哪一页,才把那一页从 memfile 拉进来。

### 7.1 接口 `MemoryBackend`(`uffd/memory_backend.go`)

```go
type MemoryBackend interface {
    Start(ctx, sandboxId) error
    Stop() error
    Ready() chan struct{}                            // UFFD 已就绪信号
    Exit() *utils.ErrorOnce                          // UFFD 退出信号
    Memfd(ctx) *block.Memfd                          // 从 FC 拿到的 memfd
    DiffMetadata(ctx, *fc.Process) (*header.DiffMetadata, error)
    PrefetchData(ctx) (block.PrefetchData, error)
    Prefault(ctx, offset, data) (installed bool, err error)
    ServeStats() userfaultfd.ServeSnapshot
}
```

两个实现:

### 7.2 `Uffd`(`uffd/uffd.go`)

真正的 UFFD 服务,用于快照恢复。

```
   FC 进程启动 LoadSnapshot
        │
        │ (FC 通过 Unix socket 把 uffd fd + region mappings 发过来)
        ▼
   uffd.handle() 接收 fd
        │
        ▼
   创建 userfaultfd.Userfaultfd
        │
        ▼
   Serve()  ─── 循环读 UFFD 事件 ──→ 找 src page ──→ UFFDIO_COPY 装填
```

`Start`(`uffd.go:72`):

1. `net.ListenUnix` 创建 Unix socket(给 FC 连)
2. `os.Chmod(socketPath, 0o777)` —— FC 是另一个进程,需要权限
3. `fdexit.New()` 创建一个"退出信号"机制(`fdexit` 子包)
4. 启动 goroutine `handle()`

`handle`(`uffd.go:121`):

```go
conn, _ := u.lis.Accept()                            // FC 连进来
// 读 FC 发过来的:region mappings (JSON) + fd (UFFD + 可选 memfd)
unixConn.ReadMsgUnix(regionMappingsBuf, fdBuf)
regions := json.Unmarshal(...)
fds := syscall.ParseUnixRights(...)                  // SCM_RIGHTS 收 fd
uffd, _ := userfaultfd.NewUserfaultfdFromFd(fds[0], ...)
if len(fds) > 1 {                                    // 新版 FC 还会发 memfd
    memfd, _ := block.NewFromFd(fds[1])
    u.memfd.Store(memfd)
}
u.handler.SetValue(uffd)                             // 通知 Prefault/PrefetchData
close(u.readyCh)                                     // 通知 FC:可以 resume 了
uffd.Serve(ctx, fdExit)                              // 进入服务循环
```

### 7.3 `NoopMemory`(`uffd/noop.go`)

冷启动路径用。不做 UFFD,FC 自己分配匿名内存。`DiffMetadata` 走 FC 的 `MemoryInfo` API 获取 resident pages。

### 7.4 `Userfaultfd` 核心 — `uffd/userfaultfd/userfaultfd.go`

`Userfaultfd` 是 UFFD 服务循环的核心:

```go
type Userfaultfd struct {
    fd Fd                                            // userfaultfd 文件描述符
    src PageReader                                   // memfile 读
    ma  *memory.Mapping                              // guest 物理 → host 虚拟地址映射
    pageSize    uintptr
    pageTracker *block.Tracker                       // 已安装页面追踪
    prefetchTracker *block.PrefetchTracker

    settleRequests sync.RWMutex                      // 多 worker 并发安装
    readSerial     sync.Mutex                        // 与 Export 串行化

    wakeupPipe [2]int                                // 自管道唤醒 poll

    servedPages, servedSourcePages, servedBytes atomic.Int64
}
```

设计要点:

- **`settleRequests` vs `readSerial` 解耦**:UFFD 的服务循环读事件用 `readSerial`,处理缺页(lookup→install→SetRange)用 `settleRequests.RLock`。两者**必须不相交**,否则快照时的 REMOVE batch 会和正在处理的 worker 死锁(参见 `TestNoMadviseDeadlockWithInflightCopy`)。
- **`wakeupPipe` 自管道**:worker 推迟一个 fault 后,通过自管道立刻唤醒 poll 循环,防止"延迟的 fault 永远等下一个无关 UFFD 事件"。
- **pagePool**:`sync.Pool` 复用 2 MB 大页缓冲,避免每页分配。
- **ServeStats**:累计的"已服务页面数",`WaitForEnvd` 在 envd init 完成时采样一次,得到**冷启动工作集**(guest 真正需要的内存)。

### 7.5 预取 `uffd/prefetch/`

如果模板的 metadata 里有 `Prefetch.Memory` 映射(基于上一次运行的 page fault trace),后台 goroutine 会**主动**把这些页读出来,而不是等缺页。比纯 UFFD 按需更快。

---

## 8. network/ — 沙箱网络

E2B 的沙箱网络是个三层架构:

```
   ┌─────────── Host 默认命名空间 ───────────┐
   │                                          │
   │  default gateway (eth0)                  │
   │       ▲                                  │
   │       │ 路由                              │
   │  veth-N (Slot.Idx 的 vEthIp)             │
   │       ▲                                  │
   └───────┼──────────────────────────────────┘
           │ veth pair 跨 netns
   ┌───────┼──────── Slot netns (ns-N) ───────┐
   │       ▼                                  │
   │  vpeer (Slot.Idx 的 vPeerIp, 即 "eth0") │
   │       │                                  │
   │  nftables firewall (allow/deny rules)    │
   │       │                                  │
   │  tap0 (TAP 设备,FC 用)                  │
   │       │                                  │
   │  hyperloop proxy / NFS proxy / 等       │
   └──────────────────────────────────────────┘
```

### 8.1 `Slot`(`network/slot.go:60`)

每个沙箱分配一个 `Slot`,持有:

| 资源 | 说明 |
|------|------|
| `Idx` | 1 ~ vrtSlotsSize |
| `vPeerIp` / `vEthIp` | 来自 `10.12.0.0/16` 的 /31 块 |
| `HostIP` | 来自 `10.11.0.0/16`,host 上访问沙箱用 |
| `tapIp` | `169.254.0.22`(link-local) |
| `Firewall` | nftables 规则集 |

地址计算示例(`slot.go:93`):

```go
vEthIp, _ := netutils.GetIndexedIP(vrtNetworkCIDR, idx*vrtAddressPerSlot)
vPeerIp, _ := netutils.GetIndexedIP(vrtNetworkCIDR, idx*vrtAddressPerSlot+1)
```

`vrtAddressPerSlot = 2`(vpeer + veth),所以 /16 块能容纳约 32K 个 slot。

### 8.2 `Pool`(`network/pool.go:90`)

两个 channel:

```go
newSlots    chan *Slot    // 容量 NewSlotsPoolSize-1 = 31
reusedSlots chan *Slot    // 容量 ReusedSlotsPoolSize = 100
```

- `newSlots`:后台 goroutine 持续创建新 slot 填进去
- `reusedSlots`:沙箱结束后归还的 slot

`Get`(`pool.go:162`)优先取 reused(避免创建 netns 的开销),不行再取 new。

**关键设计:`ReturnDelay = 3 * time.Second`**(`pool.go:30`)。沙箱结束后等 3 秒再把 slot 放回 reused 池,让上一个沙箱的 inflight 请求排干。否则新沙箱立刻复用同一 IP,会接到老沙箱的回包。

### 8.3 `Firewall`(`network/firewall.go`)

基于 **nftables**。每个 slot 的防火墙规则在 slot 的 netns 内,互不干扰。规则集大致是:

```
allow: orchestrator IP (必须,envd 要访问 orchestrator)
allow: AllowSandboxInternalCIDRs (用户配置,允许访问内网)
deny:  私有网段 (10.0.0.0/8, 172.16.0.0/12, ...)
allow: 其它 (互联网)
```

用户配置的 `allowedCidrs` / `deniedCidrs` / `allowedDomains` 通过 `Slot.ConfigureInternet` / `UpdateInternet` 动态下发,**单次 flush 原子替换**。

### 8.4 端口分离设计

```
SandboxTCPFirewallHTTPPort  5016   # 目的端口 80 的流量(HTTP Host header 检查)
SandboxTCPFirewallTLSPort   5017   # 目的端口 443 的流量(TLS SNI 检查)
SandboxTCPFirewallOtherPort 5018   # 其它流量(纯 CIDR 检查)
```

不同协议分端口,避免 server-first 协议(如 SSH)阻塞协议检测。

---

## 9. template/ — 模板缓存层

模板 = `rootfs + memfile + snapfile + metadata`,通常存放在 GCS。每次启动沙箱都从 GCS 拉太慢,所以有本地缓存。

### 9.1 `Cache`(`template/cache.go:51`)

```go
type Cache struct {
    cache       *ttlcache.Cache[string, Template]
    persistence storage.StorageProvider                  // GCS / S3
    buildStore  *build.DiffStore                          // diff 层缓存
    peers       peerclient.Resolver                       // P2P 数据传输
}
```

TTL 25 小时(`templateExpiration`),比沙箱最长生命期长,保证活跃模板不会过期。

### 9.2 多级存储路由

`GetTemplate`(`cache.go:159`)按 feature flag 包装 persistence:

```
GCS (base)
  ↓ 包装
+ NFSCache (本地 chunk 缓存,SharedChunkCacheDir)
  ↓ 包装 (如果开 P2P)
+ peerclient.RoutingProvider (per-buildID 路由到 peer orchestrator)
```

`peerclient` 子包实现了 P2P 数据传输:每个 buildID 通过 Redis 找到"哪个 orchestrator 有这个数据",直接走网络拉,**不用等 GCS 上传完成**。

### 9.3 异步 fetch

```go
go tmpl.Fetch(context.WithoutCancel(ctx), c.buildStore)
```

`context.WithoutCancel` —— **fetch 不受请求取消影响**,因为模板可能被后续请求复用。即使当前请求取消了,fetch 也跑完。

### 9.4 TTL 自动延期

```go
if maxSandboxLengthHours > 0 {
    ttl = max(ttl, time.Duration(maxSandboxLengthHours)*time.Hour + templateExpirationBuffer)
}
```

某个团队可能跑超长 sandbox,缓存 TTL 至少要覆盖这个时长。

---

## 10. block/ — 块设备抽象

最底层的块设备抽象,被 rootfs/uffd/template 共用。核心类型:

| 类型 | 作用 |
|------|------|
| `Cache` | 本地 mmap 文件,记录脏块 |
| `Overlay` | CoW 叠加:底层只读 + 上层 cache |
| `Memfd` | memfd_create 创建的匿名文件,跨进程共享内存 |
| `Tracker` | 跟踪已安装页面 |
| `PrefetchTracker` | 跟踪已预取页面 |
| `DedupBudget` | dedup 的资源预算,防止 runaway |
| `StreamingChunk` | 流式分块读取(从 GCS) |
| `FetchSession` | 复用对同一源的多次 fetch |

**`block/local.go`、`block/memfd.go`、`block/dedup.go` 是这个子包的三大核心**。`dedup.go` 实现了"diff 与原始 memfile 对比去掉未修改页"的逻辑,被 `fc/memory.go` 的 `ExportMemory` 调用。

---

## 11. cgroup/ — 资源记账

`cgroup/manager.go` 实现了 cgroup v2 的管理。每个沙箱创建一个独立 cgroup,把 FC 进程放进去,用于:

- CPU / 内存记账
- 限制 noisy neighbor 影响
- 沙箱停止时整组杀掉

关键设计:

```go
// sandbox.go:444
cgroupHandle, cgroupFD := createCgroup(ctx, f.cgroupManager, sandboxFiles.SandboxCgroupName())
defer releaseCgroupFD(ctx, cgroupHandle, runtime.SandboxID)
```

`cgroupFD` 是 cgroup 目录的文件描述符,传给 FC 进程,FC 用 `CLONE_INTO_CGROUP` 原子地把自己塞进去。比传统的"先 fork 再写 cgroup.procs"避免了竞争窗口(在窗口内 FC 已经在跑,但还没被记账)。

`cgroup/noop.go` 是退化实现,在 cgroup 不可用时降级。

---

## 12. 生命周期:Create 与 Resume

### 12.1 冷启动 `Factory.CreateSandbox`(`sandbox.go:345`)

流程:

```
1. 生成 LifecycleID(uuid)
2. 异步申请网络 slot(getNetworkSlot)
3. 创建 sandbox files(工作目录、socket 路径)
4. 创建 rootfs Provider:
   - 有 rootfsCachePath → DirectProvider
   - 否则 → NBDProvider
5. 启动 rootfs Provider(后台)
6. 获取 template memfile 大小
7. 等网络 slot 就绪
8. (可选)pre-boot hook,修改 rootfs
9. 创建 cgroup
10. fc.NewProcess(准备启动脚本、API client)
11. fcHandle.Create(
      - 配置 kernel/rootfs/net/machine/balloon
      - startVM
    )
12. 注册到 Sandboxes map
13. 初始化 host stats collector
14. cleanup.AddPriority(sbx.Stop)  ← 优先级清理
15. goroutine:等 FC 退出 → sbx.Stop → 设置 exit error
16. Sandboxes.MarkRunning
```

`memory = uffd.NewNoopMemory(...)` —— 冷启动用 Noop,FC 自己分配匿名内存。

### 12.2 快照恢复 `Factory.ResumeSandbox`(`sandbox.go:598`)

流程更复杂,因为要并行初始化多个资源:

```
1. 生成 LifecycleID
2. 创建 sandbox files
3. 异步初始化 uffd(uffdPromise)
4. 异步启动 prefetcher(如果有 Prefetch.Memory 映射)
5. 异步申请网络 slot(ipsPromise)
6. 异步初始化 rootfs overlay(overlayPromise)
7. 异步启动 uffd 服务(memoryPromise)
8. 等所有 promise 完成
9. 获取 rootfs / metadata
10. 创建 cgroup
11. fc.NewProcess
12. fcHandle.Resume(
      - 并行:configure FC + 等 uffd socket + symlink rootfs
      - setMetrics
      - loadSnapshot(等 uffdReady)
      - setTxRateLimit / setDriveRateLimit
      - resumeVM
      - setMmds
    )
13. sbx.WaitForEnvd(envd 启动握手)
14. 启动 health checks
15. goroutine:等 FC 或 uffd 退出 → sbx.Stop
```

**`utils.Promise`** 在这里大量使用 —— 让多个慢操作(IP 池、rootfs mount、UFFD 启动)并行,把启动延迟压到最低。

### 12.3 停止 `Sandbox.Stop` / `doStop`(`sandbox.go:996`)

```go
func (s *Sandbox) doStop(ctx context.Context) error {
    s.Checks.Stop()                  // 停健康检查
    fcStopErr := s.process.Stop(ctx) // SIGTERM FC,10 秒后 SIGKILL
    <-s.process.Exit.Done()          // 等真的退出
    uffdStopErr := s.Resources.memory.Stop()
    return errors.Join(fcStopErr, uffdStopErr)
}
```

`process.Stop`(`fc/process.go:653`)的优雅停止:

1. 删除 metrics FIFO
2. 如果进程已退出,直接返回
3. `SIGTERM` → 等 10 秒
4. 10 秒后检查进程状态,如果还在 → `SIGKILL`

`stop utils.Lazy[error]` 保证 `Stop` 是幂等的 —— 多次调用只有第一次真的执行。

---

## 13. 快照流程:Pause 与导出

`Sandbox.Pause`(`sandbox.go:1078`)是把**运行中的沙箱**转化为新模板的过程。

### 13.1 步骤

```
1. 创建 cachePaths(buildID 派生)
2. 停健康检查
3. bestEffortReclaim(fstrim / sync / drop_caches / compact_memory)
   - 失败不致命,只清理 guest 内存
4. cleanup.Add(bestEffortUnfreeze) ← 失败回滚
5. DrainBalloon(可选,让 guest 释放空闲页,避免进快照)
6. process.Pause → PATCH VM state=Paused
7. FlushMetrics(尽力而为)
8. process.CreateSnapshot → POST /snapshot/create
   (FC fork 特性:不传 memfile path,只创建 snapfile + flush disk)
9. memory.DiffMetadata → 获取脏页 bitmap
10. pauseProcessMemory → 从 FC 进程导出脏页到 cache
    - 三路径:memfd-dedup / memfd / process-read
    - 异步生成 diff header
11. pauseProcessRootfs → 从 rootfs overlay 导出 diff
12. 计算 scheduling metadata(估算新模板大小)
13. 写 metadata file
14. 返回 Snapshot{Snapfile, MemfileDiff, RootfsDiff, ...}
```

### 13.2 `Snapshot` 结构(`snapshot.go:29`)

```go
type Snapshot struct {
    MemfileDiff, RootfsDiff    build.Diff
    MemfileDiffHeader, RootfsDiffHeader *DiffHeader
    Snapfile, Metafile         template.File
    BuildID                    uuid.UUID
    SchedulingMetadata         *orchestrator.SchedulingMetadata
    MemfileBlockSize, RootfsBlockSize uint64
    cleanup *Cleanup
}
```

`DiffHeader` 是 `utils.SetOnce[*header.Header]`,因为 memfd-dedup 路径下 header 是异步算的,`Pause` 不会等它。

### 13.3 Reclaim 优化

`bestEffortReclaim` 通过 envd 在 guest 内执行 `fstrim` / `echo 3 > /proc/sys/vm/drop_caches` / `compact_memory`,让 guest 主动释放空闲内存和磁盘块。这样导出的 diff 更小,新沙箱启动也更快。

Reclaim 会 freeze 用户 cgroup,所以失败路径必须 `bestEffortUnfreeze`,否则 VM 留在 frozen 状态。

---

## 14. Envd:VM 内守护进程握手

Envd 是跑在每个沙箱内的守护进程(代码在 `packages/envd/`)。orchestrator 通过 HTTP 与它通信。

### 14.1 `WaitForEnvd`(`sandbox.go:1488`)

```go
func (s *Sandbox) WaitForEnvd(ctx, startType, timeout) error {
    defer func() {
        // 第一次 WaitForEnvd 成功后采样 UFFD 启动统计
        s.startupStatsOnce.Do(func() {
            stats := s.memory.ServeStats()
            uffdStartupPagesHistogram.Record(ctx, stats.Pages, ...)
            uffdStartupSourcePagesHistogram.Record(ctx, stats.SourcePages, ...)
            uffdStartupBytesHistogram.Record(ctx, stats.Bytes, ...)
        })
        if e == nil { s.SetStartedAt(time.Now()) }
    }()

    // 超时 / FC 退出 / initEnvd 三选一
    go func() {
        select {
        case <-time.After(timeout): cancel(...)
        case <-s.process.Exit.Done(): cancel(...)
        }
    }()

    return s.initEnvd(ctx)
}
```

`startupStatsOnce` 的注释解释了一个微妙之处:UFFD 的 `ServeStats` 是累计的,如果在同一个 handler 上多次 `WaitForEnvd`(比如 build 流程中 envd 二进制热替换),第二次采样会包含中间的 page fault,不能反映"这次启动的真实工作集"。所以**只在第一次采样**。

### 14.2 `initEnvd`(`envd.go:151`)

POST `http://{HostIP}:{49983}/init`,带:

```json
{
  "LifecycleID": "...",
  "EnvVars": {...},
  "HyperloopIP": "orchestrator in-sandbox IP",
  "AccessToken": "...",
  "DefaultUser": "...",
  "DefaultWorkdir": "...",
  "VolumeMounts": [...],
  "CaBundle": "...",
  "Timestamp": "..."
}
```

`doRequestWithInfiniteRetries`(`envd.go:41`)实现**无限重试**,直到:
- 上下文超时
- 上下文取消
- 成功

每次重试间隔 5ms。`Timestamp` 在每次重试时更新,envd 用它判断"这个 init 请求是不是 stale"。

### 14.3 Freeze / Unfreeze

`callEnvdFreeze`(`envd.go:99`)调用 envd 的原生 `/freeze` 端点,只 freeze user/pty cgroups(不 stop 任何进程)。这是 Pause 流程的预处理:让用户进程先停下来,避免快照时还在写内存。

---

## 15. 可观测性

整个 sandbox 包大量使用 OpenTelemetry:

### 15.1 Tracing

每个子包都有自己的 tracer:

```go
var tracer = otel.Tracer("github.com/e2b-dev/infra/packages/orchestrator/pkg/sandbox/<sub>")
```

`CreateSandbox` / `ResumeSandbox` 用 `startExecutionSpan`(`sandbox.go:968`)创建**独立 root 的执行 span**,因为它跨越多个 gRPC 请求的生命周期。

### 15.2 Metrics

OTEL meter 注册在 `sandbox/metrics.go`,主要指标:

- `orchestrator.sandbox.uffd.startup.pages` / `.source_pages` / `.bytes` — 冷启动工作集
- `orchestrator.sandbox.envd.init.calls{success=...}` — envd init 调用次数
- `orchestrator.sandbox.envd.wait.duration` — 等 envd 时间
- `orchestrator.network.slots_pool.*` — 网络池
- `orchestrator.nbd.slots_pool.*` — NBD 池
- `orchestrator.templates.cache.hits/misses` — 模板缓存
- `orchestrator.host.balance_dirty_pages.threads` — 写入限流强度

### 15.3 日志

- `pkg/logger` — Zap + OTEL hooks
- `sbxlogger` — 沙箱专用 logger,自动带 sandbox_id / template_id / team_id
- `fcLogFilter` — 过滤 FC 自身的 FlushMetrics 日志噪声

---

## 附录:关键文件索引

| 文件 | 内容 |
|------|------|
| `pkg/sandbox/sandbox.go` | `Sandbox` 聚合根、`Factory.CreateSandbox` / `ResumeSandbox`、`Pause` |
| `pkg/sandbox/snapshot.go` | `Snapshot` 结构 |
| `pkg/sandbox/envd.go` | envd HTTP 客户端、init 流程 |
| `pkg/sandbox/cleanup.go` | 反向清理栈 |
| `pkg/sandbox/fc/process.go` | `Process`、`Create` / `Resume` / `Stop` |
| `pkg/sandbox/fc/client.go` | Firecracker REST API 客户端 |
| `pkg/sandbox/fc/config.go` | 内核/FC 版本路径解析 |
| `pkg/sandbox/fc/kernel_args.go` | 内核启动参数 |
| `pkg/sandbox/fc/mmds.go` | MMDS 元数据 |
| `pkg/sandbox/fc/memory.go` | 内存导出 |
| `pkg/sandbox/fc/script_builder.go` | FC 启动脚本生成 |
| `pkg/sandbox/fc/fc_metrics.go` | FC metrics FIFO 读取 |
| `pkg/sandbox/fc/fph_gates.go` | FC 版本能力探测 |
| `pkg/sandbox/rootfs/{rootfs,nbd,direct}.go` | rootfs Provider 实现 |
| `pkg/sandbox/nbd/{pool,dispatch,mounthelper}.go` | NBD 设备池 |
| `pkg/sandbox/uffd/{uffd,noop,memory_backend}.go` | UFFD 顶层 |
| `pkg/sandbox/uffd/userfaultfd/userfaultfd.go` | UFFD 服务循环核心 |
| `pkg/sandbox/uffd/prefetch/prefetcher.go` | 内存预取 |
| `pkg/sandbox/network/{slot,pool,firewall,host}.go` | 沙箱网络 |
| `pkg/sandbox/template/{cache,storage_template,local_template}.go` | 模板缓存 |
| `pkg/sandbox/block/{cache,overlay,memfd,dedup}.go` | 块设备抽象 |
| `pkg/sandbox/cgroup/manager.go` | cgroup v2 管理 |
| `pkg/sandbox/socket/socket.go` | Unix socket 等待工具 |

---

## 附录:E2B 对上游 Firecracker 的 fork 改动

下列 API/字段是 E2B 自定义 FC fork 才有的(在 `packages/shared/pkg/fc/` 的 swagger 模型里),上游 Firecracker 不支持:

- `GET /memory_mappings` — guest 物理 → host 虚拟地址映射
- `GET /memory` — resident + empty pages bitmap
- `GET /dirty_memory` — WP-async 脏页 bitmap
- `PUT /balloon` 的 `freePageReporting` / `freePageHinting` 字段
- `POST /balloon/start_hinting` / `GET /balloon/describe_hinting`
- `LoadSnapshot` 的 `use_memfd` 字段
- `CreateSnapshot` 不传 memfile path 时的 "只 snapfile + flush disk" 行为

这些都是 E2B 性能优化的关键,迁移到上游 Firecracker 需要先实现或放弃这些功能。
