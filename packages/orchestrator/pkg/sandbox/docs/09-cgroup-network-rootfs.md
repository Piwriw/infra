# 09. `cgroup/` / `network/` / `rootfs/` 资源管理三大子模块

> 路径: `packages/orchestrator/pkg/sandbox/{cgroup,network,rootfs}/`
> 职责: sandbox 的 CPU/内存计量 (cgroup v2)、网络命名空间与防火墙、rootfs 暴露方式(Direct mmap 或 NBD)。

---

# Part A. `cgroup/` cgroup v2 资源计量

## 1. 文件分工

| 文件 | 职责 |
|------|------|
| `manager.go` | `Manager` 接口 + `managerImpl` + `CgroupHandle`(单 sandbox cgroup) |
| `noop.go` | `noopManager` / `NewNoopManager`(CLI/测试 用,不真创建 cgroup) |

## 2. 核心常量

```go
const (
    cgroupV2MountPoint  = "/sys/fs/cgroup"
    RootCgroupPath       = cgroupV2MountPoint + "/e2b"  // 父 cgroup
    NoCgroupFD           = -1                            // 哨兵
)
```

## 3. `Stats`

```go
type Stats struct {
    CPUUsageUsec, CPUUserUsec, CPUSystemUsec uint64
    MemoryUsageBytes, MemoryPeakBytes        uint64  // peak 每次 GetStats 后 reset
}
```

## 4. `CgroupHandle` 生命周期

```
Create → GetFD → cmd.Start() (传 SysProcAttr.CgroupFD) → ReleaseCgroupFD → GetStats (重复) → Remove
```

### 4.1 `Create(ctx, cgroupName)`

```go
cgroupPath := filepath.Join(RootCgroupPath, cgroupName)
os.MkdirAll(cgroupPath, 0o755)
file, _ := os.Open(cgroupPath)                    // FD 给 CLONE_INTO_CGROUP
memoryPeakFile, _ := os.OpenFile(filepath.Join(cgroupPath, "memory.peak"), os.O_RDWR, 0)
                                                    // O_RDWR FD 必须保持开
                                                    // (per-FD 计数器,reset 写"0"即可)
```

- `memoryPeakFile` 可能失败(老内核),warn + 继续,只是丢 peak metric。

### 4.2 `GetFD() int`

返 `int(h.file.Fd())`,若 `h.file == nil` 返 `NoCgroupFD`。

### 4.3 `ReleaseCgroupFD()`

- 关 `h.file`,置 nil。Safe to call multiple times。
- 关键:**不要**关 `memoryPeakFile`(per-FD 计数器,跨 GetStats 要复用)。

### 4.4 `GetStats(ctx)`

- noop handle → 返 `(nil, nil)`,host stats collector 跳过。
- 真 handle:
  - 读 `cpu.stat`,解析 `usage_usec` / `user_usec` / `system_usec`。
  - 读 `memory.current` 拿当前值。
  - 若有 `memoryPeakFile` → `readAndResetMemoryPeak`:
    - Seek(0) → Read(buf) → ParseUint → WriteString("0")(reset per-FD peak)。
  - 返 `*Stats`。

### 4.5 `Remove(ctx)`

- `noop` / `removed` 跳过。
- 关闭 `file`(如果 ReleaseCgroupFD 没调)。
- 关闭 `memoryPeakFile`。
- `os.Remove(path)`:
  - 成功或不存在 → ok。
  - 其他错误(EBUSY,sandbox 还有进程)→ log warn,写 `cgroup.kill=1`(kernel 5.14+),2s 内循环重试 rmdir。
  - 仍失败 → 返错。

## 5. `managerImpl`

### 5.1 `Initialize(ctx)`

- `os.MkdirAll(RootCgroupPath, 0755)`。
- 写 `cgroup.subtree_control` 加 `+cpu +memory`。
- 通常在 orchestrator 启动时一次性调。

### 5.2 `Create(ctx, cgroupName)` —— 见上。

## 6. `noopManager`

`noopManager.Create` 返 `*CgroupHandle{noop: true}` —— 所有方法都是 no-op,`GetFD` 返 `NoCgroupFD`,`GetStats` 返 `(nil, nil)`。

用于 CLI 工具、单元测试。

## 7. 与 FC 进程的集成

`fc.Process.configure` 中:

```go
if cgroupFD != cgroup.NoCgroupFD {
    p.cmd.SysProcAttr.UseCgroupFD = true
    p.cmd.SysProcAttr.CgroupFD = cgroupFD
}
```

- Linux `clone3(CLONE_INTO_CGROUP)`:子进程在 `clone` 阶段原子地进入指定 cgroup,启动后立即受 cgroup v2 cpu/memory 控制器约束。
- `cgroupFD` 是 `/sys/fs/cgroup/e2b/<sandboxName>` 的打开 fd。

## 8. 关键不变量

1. **FD 释放顺序**:cgroup 启动 → `cmd.Start`(用 FD)→ 立即 `ReleaseCgroupFD` → 子进程已通过 `CLONE_INTO_CGROUP` 进入 cgroup,FD 不再需要。
2. **memoryPeakFile 全程保持开**,让 `readAndResetMemoryPeak` 反复 reset per-FD 计数。
3. **Handle 多次 Remove 安全**:`removed` flag 防止重复清理。

---

# Part B. `network/` 沙箱网络

## 1. 文件分工

| 文件 | 职责 |
|------|------|
| `pool.go` | `Pool` 网络 slot 池(双池:new + reused) |
| `slot.go` | `Slot` 实体(配置防火墙/获取/归还) |
| `network.go` | `Slot.CreateNetwork` / `RemoveNetwork`(netlink + iptables) |
| `firewall.go` | `Firewall`:基于 nftables 的 egress 规则 |
| `egressproxy.go` | `EgressProxy` 接口与默认实现(给 sandbox 出网代理) |
| `host.go` | `host` 工具(orchestrator 在沙箱内可见的 IP) |
| `storage.go` / `storage_*.go` | slot 存储(local/memory/kv) |
| `pool_test.go` | 测试 |

## 2. `Config`

```go
type Config struct {
    OrchestratorInSandboxIPAddress string  // 默认 192.0.2.1 (TEST-NET-1)
    HyperloopProxyPort uint16      // 5010
    NFSProxyPort       uint16      // 5011
    PortmapperPort     uint16      // 5012
    UseLocalNamespaceStorage bool
    AllowSandboxInternalCIDRs []string
    SandboxTCPFirewallHTTPPort  uint16  // 5016
    SandboxTCPFirewallTLSPort   uint16  // 5017
    SandboxTCPFirewallOtherPort uint16  // 5018
}
```

## 3. CIDR 划分

```
host CIDR (10.11.0.0/16)        - /32,每个 slot 拿到一个 host IP (10.11.0.<idx>)
vrt CIDR  (10.12.0.0/16)        - /31,每个 slot 拿到 vpeer + veth 各 1 个
                                   10.12.0.<idx*2>   = vpeer IP
                                   10.12.0.<idx*2+1> = veth IP
tap    169.254.0.22/30          - tap0,所有 slot 共用(只一个 tap)
ns     169.254.0.21              - guest VM 看的 namespace IP
```

## 4. `Slot` 字段

```go
type Slot struct {
    Key string
    Idx int
    Firewall *Firewall
    firewallCustomRules atomic.Bool
    vPeerIp, vEthIp  net.IP
    vrtMask          net.IPMask
    tapIp, tapMask   net.IP
    HostIP           net.IP
    hostNet          *net.IPNet
    hostCIDR         string
    hyperloopPort    string
    egressProxy      EgressProxy
    config           Config
}
```

### 4.1 `NewSlot(key, idx, config, egressProxy)`

校验 `1 <= idx <= vrtSlotsSize`,从 CIDR 派生:
- `vEthIp = GetIndexedIP(vrtNetworkCIDR, idx*2)`
- `vPeerIp = GetIndexedIP(vrtNetworkCIDR, idx*2+1)`
- `hostIp = GetIndexedIP(hostNetworkCIDR, idx)`

存进结构体,准备后续 CreateNetwork。

### 4.2 命名规则

- `NamespaceID = "ns-<idx>"`(创建 netns 用)
- `VpeerName = "eth0"`(guest VM 视角)
- `VethName = "veth-<idx>"`(host 视角)
- `TapName = "tap0"`(在 namespace 内的 tap)

## 5. `CreateNetwork(ctx)` 详解

```go
runtime.LockOSThread()
defer runtime.UnlockOSThread()

hostNS, _ := netns.Get()                    // 保存 host ns
defer netns.Set(hostNS); hostNS.Close()

ns, _ := netns.NewNamed(s.NamespaceID())    // 新 namespace
defer ns.Close()
```

- `LockOSThread` + 存/恢复 host ns —— 避免在操作期间线程飘到其他 ns。
- 错误恢复链:任何 `defer` 都按 LIFO 恢复。

### 5.1 在新 ns 里建 veth pair

```go
vethAttrs.Name = s.VethName()
veth := &netlink.Veth{LinkAttrs: vethAttrs, PeerName: s.VpeerName()}
netlink.LinkAdd(veth)        // 创建 veth pair
vpeer, _ := netlink.LinkByName(s.VpeerName())
netlink.LinkSetUp(vpeer)
netlink.AddrAdd(vpeer, &Addr{IPNet: vpeerCIDR})
```

`vpeer` 是 peer 端(留在新 ns 里),`veth` 是 host 端(下面移走)。

### 5.2 把 veth 端移回 host ns

```go
netlink.LinkSetNsFd(veth, int(hostNS))   // veth 端移到 host
netns.Set(hostNS)                          // 切回 host ns
vethInHost, _ := netlink.LinkByName(s.VethName())
netlink.LinkSetUp(vethInHost)
netlink.AddrAdd(vethInHost, &Addr{IPNet: vethCIDR})
```

### 5.3 在 sandbox ns 里建 tap + 配置路由

```go
netns.Set(ns)                              // 切回 sandbox ns
tap := &netlink.Tuntap{Mode: TAP, ...}
netlink.LinkAdd(tap)
netlink.LinkSetUp(tap)
netlink.AddrAdd(tap, &Addr{IPNet: tapCIDR})
netlink.LinkSetUp(lo)                      // lo 也 up
netlink.RouteAdd(&Route{Gw: s.VethIP()})   // 默认路由走 veth
```

### 5.4 NAT 规则(ns 内 + host)

```go
// ns 内 nat POSTROUTING: 把 sandbox 出包 SNAT 成 hostIP
tables.Append("nat", "POSTROUTING", "-o", "eth0", "-s", "169.254.0.21", "-j", "SNAT", "--to", hostIP)
// ns 内 nat PREROUTING: 把 hostIP 目标 DNAT 回 namespaceIP
tables.Append("nat", "PREROUTING", "-i", "eth0", "-d", hostIP, "-j", "DNAT", "--to", "169.254.0.21")
```

### 5.5 host 上加路由 + FORWARD + 几个 REDIRECT

```go
// host 路由: 目标 hostIP 走 vpeer
netlink.RouteAdd(&Route{Gw: vpeerIP, Dst: hostNet})

// host FORWARD: 双向 ACCEPT
tables.Append("filter", "FORWARD", "-i", "veth-<idx>", "-o", defaultGateway, "-j", "ACCEPT")
tables.Append("filter", "FORWARD", "-i", defaultGateway, "-o", "veth-<idx>", "-j", "ACCEPT")

// host POSTROUTING: 来自 hostCIDR 的走默认网关时 MASQUERADE
tables.Append("nat", "POSTROUTING", "-s", hostCIDR, "-o", defaultGateway, "-j", "MASQUERADE")

// REDIRECT 80 → hyperloop proxy, 2049 → NFS proxy, 111 → portmapper
```

### 5.6 egress proxy 接入

```go
s.egressProxy.OnSlotCreate(s, tables)
```

外部 module(默认是 noop)往 iptables 加额外规则。

## 6. `RemoveNetwork()`

- CloseFirewall
- delete host iptables 规则
- delete veth
- delete host route
- `netns.DeleteNamed(ns-id)`(最后,清 ns)

注意:即使中间某步失败,也继续做后续(收集所有 errs join 返回)。

## 7. `ConfigureInternet` / `UpdateInternet` / `ResetInternet`

- 都通过 `ns.GetNS(...).Do(func(ns.NetNS) error { ... })` 在 sandbox ns 里跑 nftables。
- `firewallCustomRules atomic.Bool` 追踪是否需要清理。
- `ResetInternet` 用 CAS 把 true→false,只有改过的 slot 才真正清规则。

## 8. `Pool` —— 双池设计

```go
type Pool struct {
    config      Config
    done        chan struct{}
    closeMu     sync.RWMutex
    closed      bool
    newSlots    chan *Slot
    reusedSlots chan *Slot
    slotStorage Storage
}
```

- `newSlots` 容量 = `newSlotsPoolSize - 1`(populate 完才 close,所以有 1 容量差)。
- `reusedSlots` 容量 = `reusedSlotsPoolSize`,复用的 slot。

### 8.1 `Populate(ctx)`

持续 `createNetworkSlot`(向 Storage 申请 IP + CreateNetwork),put 进 `newSlots`。

### 8.2 `Get(ctx, network)`

1. 优先 `reusedSlots`(有就拿),否则等 `newSlots`。
2. `slot.ConfigureInternet(ctx, network)` —— 设 egress rules。
3. 失败 → 异步 recycle 后返错。

### 8.3 `Return(ctx, slot, releasedFn, returnDelay)`

- `ReturnDelay = 3s` —— 等 in-flight 请求在新 sandbox 启动时不再到达旧 IP。
- 期间 `releasedFn(ctx, hostIP)` 被 `sync.OnceFunc` 包,只触发一次,给 `Map.NetworkReleased` 调。
- 超时/ctx cancel → `cleanup`(直接 `RemoveNetwork` + storage release)。
- 正常路径 → `recycle`:
  - `slot.ResetInternet`。
  - `reusedSlots <- slot`(`closeMu` RLock)。
  - `closed` / ctx cancel / `done` → `cleanup`。

### 8.4 `Close(ctx)`

- close done。
- `closeMu.Lock; closed = true`。
- drain `newSlots` 全部 cleanup。
- drain `reusedSlots` 全部 cleanup(非阻塞 `default` 分支跳出)。

## 9. `Storage` 接口

```go
type Storage interface {
    Acquire(ctx) (*Slot, error)         // 拿一个 IP
    Release(*Slot) error                // 还 IP
}
```

实现:`storage_local`(本地 IP 池)、`storage_memory`(内存)、`storage_kv`(键值)。具体用哪个由 `Config.UseLocalNamespaceStorage` 等决定。

## 10. 关键不变量

1. **slot idx 唯一 + 范围 [1, vrtSlotsSize)**:vrt CIDR /31 划分,2 IP per slot。
2. **LockOSThread** 是 CreateNetwork 的硬性要求,否则 ns 切不回 host。
3. **firewallCustomRules**:短原子布尔,避免重复清理未改过的 slot。
4. **closeMu 优先用 RLock**:让 `recycle` 写入 reusedSlots 期间 `Close` 不会因为 Lock 卡住(Close Lock 之后才能看到 closed=true)。

---

# Part C. `rootfs/` rootfs 暴露方式

## 1. 文件分工

| 文件 | 职责 |
|------|------|
| `rootfs.go` | `Provider` 接口 + `flush` 工具 |
| `direct.go` | `DirectProvider`:全 mmap 到 host 路径 |
| `nbd.go` | `NBDProvider`:`Overlay` + NBD 设备 |

## 2. `Provider` 接口

```go
type Provider interface {
    Start(ctx) error
    Close(ctx) error
    Path() (string, error)             // 暴露给 FC 的最终路径
    ExportDiff(ctx, out *os.File, closeSandbox func(ctx) error) (*header.DiffMetadata, error)
}
```

- `Path()` 返回的可能是:
  - NBD: `/dev/nbd<slot>`(FC 走内核 NBD 客户端)
  - Direct: 一个 host 路径(FC 直读)

## 3. `flush(ctx, path)`

```go
file, _ := os.Open(path)
syscall.Fsync(int(file.Fd()))
file.Sync()
```

- 调两次:fdatasync + syscall sync,确保 mmap 化的页落盘。

## 4. `DirectProvider`

```go
type DirectProvider struct {
    header *header.Header
    path      string
    blockSize int64
    finishedOperations chan struct{}
    closed    atomic.Bool
    mmap      *mmap.MMap
}
```

### 4.1 `NewDirectProvider(ctx, rootfs, path)`

- 拿 `rootfs.Size`,`Truncate` 到 path,`mmap.MapRegion` RW 映射整文件。
- 注释:"Populate direct cache directly from the source file / needed for marking all blocks as dirty and being able to read them directly"

### 4.2 `Start(ctx)` —— no-op

DirectProvider 没有 NBD 设备要打开,直接可用。

### 4.3 `ExportDiff(ctx, out, stopSandbox)`

- 标记 `closed = true`(单次 export)。
- 异步 goroutine 调 `stopSandbox` 关 FC。
- `select { <-finishedOperations; <-ctx.Done() }` 等关 FC 完成(或 ctx cancel)。
- `exportToDiff(ctx, out)`:
  - `sync`(mmap.Flush + file fsync + file sync)。
  - 用 `header.NewDiffMetadataBuilder` 逐 block 扫描(ReadAt → Process),产生 diff 元数据。
- 返回 `DiffMetadata`。

### 4.4 `Close(ctx)`

- 触发 `finishedOperations <- struct{}{}`(让 export 能继续)。
- `closed.CompareAndSwap(false, true)` → 二次 unmap(防 race)。

## 5. `NBDProvider`

```go
type NBDProvider struct {
    overlay      *block.Overlay
    mnt          *nbd.DirectPathMount
    featureFlags *featureflags.Client
    ready        *utils.SetOnce[string]
    blockSize    int64
    finishedOperations chan struct{}
    devicePool   *nbd.DevicePool
}
```

### 5.1 `NewNBDProvider(ctx, rootfs, cachePath, devicePool, ff)`

- 拿 size,blockSize。
- `block.NewCache(size, blockSize, cachePath, false)` 建 mmap cache(Overlay 的"上层")。
- `block.NewOverlay(rootfs, cache)` —— cache 优先,miss 走下层 rootfs。
- `nbd.NewDirectPathMount(overlay, devicePool, ff)` —— 把 Overlay 暴露成 NBD 设备。

### 5.2 `Start(ctx)`

- 异步 `mnt.Open(ctx)` 拿 `/dev/nbd<slot>`。
- 把路径 `SetValue` 进 `ready`(让 `Path()` 不再阻塞)。

### 5.3 `ExportDiff(ctx, out, closeSandbox)`

- `overlay.EjectCache()` —— 把 cache 所有权拿出来,Overlay.Close 不再关它。
- 异步 closeSandbox。
- `select { <-finishedOperations; <-ctx.Done() }`。
- ctx cancel 路径:`cache.Close()` 避免 mmap 泄漏(这里没等 sandbox stop)。
- `cache.ExportToDiff(ctx, out)` —— 用 `copy_file_range` 写出 dirty blocks,生成 `DiffMetadata`。
- 成功路径:`cache.Close()`。

### 5.4 `Close(ctx)`

- `sync`(BLKFLSBUF + fsync) —— `unix.IoctlSetInt(fd, BLKFLSBUF, 0)` 清空 block device buffer cache。
- `mnt.Close(ctx)` —— 拆 NBD,还 slot。
- 触发 `finishedOperations <- struct{}{}`。
- `overlay.Close()`。

## 6. Direct vs NBD 的选择

`Factory.CreateSandbox` / `ResumeSandbox`:

```go
if rootfsCachePath == "" {
    rootfsProvider, err = rootfs.NewNBDProvider(...)   // 走 NBD
} else {
    rootfsProvider, err = rootfs.NewDirectProvider(...) // 走 Direct
}
```

- **NBD**:默认。`/dev/nbdX` 让 FC 用标准块设备驱动,FC 端走 block device 路径(有 rate limit、discard、TRIM 支持)。
- **Direct**:build rootfs 工具(调试/包测试)用的。

## 7. 关键不变量

1. **`finishedOperations` 容量 = 1**:`ExportDiff` 期间等,`Close` 触发 1 次;额外的 `Close` 不会卡。
2. **`overlay.EjectCache()` 必须先于 `cache.Close()`**:cache 一旦 eject,`Overlay.Close` 不再管它,但 ExportDiff 内部会关。
3. **`NBDProvider.Close` 顺序**:sync → mnt.Close(拆 NBD)→ 触发 finishedOperations → overlay.Close(关 rootfs 缓存)。
4. **NBD 的 multiconn**:FC 可同时开 N 个 socket,`DirectPathMount` 默认 8(`NBDConnectionsPerDevice`)。

---

# 总体联动

```
Sandbox.CreateSandbox / ResumeSandbox
  ├─ getNetworkSlot
  │    └─ network.Pool.Get
  │         └─ Storage.Acquire + Slot.CreateNetwork
  │              └─ netlink 建 veth + tap + ns + iptables 规则
  ├─ rootfs.NewNBDProvider
  │    ├─ block.NewOverlay(rootfs, cache)
  │    └─ nbd.NewDirectPathMount(overlay, pool, ff)
  │         └─ (Start 阶段) nbdnl.Connect → 内核 NBD 设备
  ├─ cgroup.Manager.Create (cgroupName)
  │    └─ 拿 cgroupFD + memoryPeakFile
  ├─ fc.NewProcess(..., cgroupFD, ...)
  │    └─ (configure 阶段) cmd.SysProcAttr.CgroupFD = cgroupFD
  │         → FC 进程通过 CLONE_INTO_CGROUP 原子地进入 cgroup
  ├─ hostStatsCollector 周期 cgroup.GetStats → ClickHouse
  └─ MarkRunning (通知 client-proxy 注册 sandbox IP)
```

每一块都是独立 module,但协同点非常清晰:**Slot 给 IP、rootfs 给 device、cgroup 给 FD、FC 串起来**。
