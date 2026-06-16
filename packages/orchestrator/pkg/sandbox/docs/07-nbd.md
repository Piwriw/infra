# 07. `nbd/` Linux NBD 用户态服务端

> 路径: `packages/orchestrator/pkg/sandbox/nbd/`
> 职责: 把 sandbox 的 rootfs overlay 暴露给 Firecracker 内核的 NBD 客户端。用内核 NBD 模块,用户态实现 NBD 协议。

---

## 1. 文件分工

| 文件 | 职责 |
|------|------|
| `pool.go` | `DevicePool`:`/dev/nbd*` 设备池,生命周期管理 |
| `dispatch.go` | `Dispatch`:NBD 协议服务端(读/写/写零/disconnect) |
| `path_direct.go` | `DirectPathMount`:Direct socket path 模式挂载(多连接 + 内核 netlink) |
| `devicehelper.go` | `GetNBDDevice`:一次性 helper(给 build rootfs 工具 + 测试) |
| `mounthelper.go` | `MountNBDDevice`:把 nbd 设备 mount 成 ext4(给调试 + 测试) |
| `testutils/` | 测试工具(Cleaner) |

---

## 2. 协议

来自 `<linux/nbd.h>` 和 `nbd.proto`(NBD 协议规范):

### 2.1 Request 包(28 字节,大端)

```
magic  (4)  | flags  (2)  | type  (2)  | handle (8)  | from (8)  | length (4)
NBDRequestMagic = 0x25609513
```

### 2.2 Response 包(16 字节)

```
magic (4)  | error (4)  | handle (8)
NBDResponseMagic = 0x67446698
```

### 2.3 命令

| 命令 | 值 | 说明 |
|------|----|------|
| `NBDCmdRead` | 0 | 读 → 28 字节头 + 4MB 缓冲 |
| `NBDCmdWrite` | 1 | 写 → 28 字节头 + 数据 |
| `NBDCmdDisconnect` | 2 | 关闭 |
| `NBDCmdFlush` | 3 | **不支持**(返错) |
| `NBDCmdTrim` | 4 | 丢弃(同 WriteZeroes,punch cache) |
| `NBDCmdWriteZeroes` | 6 | 写零 |

---

## 3. `DevicePool` —— `/dev/nbd*` 资源池

### 3.1 数据结构

```go
type DevicePool struct {
    done     chan struct{}            // close 信号
    doneOnce sync.Once
    usedSlots *bitset.BitSet          // 加速找空位
    mu sync.Mutex
    slots chan DeviceSlot             // 已 "ready" 的 slot 缓冲
}
```

### 3.2 `NewDevicePool(maxSlotsReady)`

- 读 `/sys/module/nbd/parameters/nbds_max` 拿最大 NBD 数(默认 256 或 4096)。
- 不存在 → `ErrNBDModuleNotLoaded`。
- 0 → 错误。
- `slots` channel 容量 = min(maxSlotsReady, maxDevices)。

### 3.3 `Populate(ctx)`

异步 goroutine,持续:
1. `getFreeDeviceSlot()` 找一个空 slot。
2. 加到 `slots` channel(`select` 含 done 和 ctx 取消,避免写阻塞时 goroutine 泄漏)。
3. 失败时 backoff 50ms + 累计 warn。

### 3.4 `isDeviceFree(slot)`

通过两个 kernel 接口判断 slot 是否真的空:
1. `/sys/block/nbd<slot>/pid` 不存在(没有进程持有)。
2. `/sys/block/nbd<slot>/size` == 0。

### 3.5 `getMaybeEmptySlot(start)` / `getFreeDeviceSlot`

`usedSlots` 是个 bit set,代表"我们认为已分配的 slot"。`getMaybeEmptySlot` 原子地 `NextClear(start)`,set true,返回 + cleanup closure。

`getFreeDeviceSlot`:
- 循环调 `getMaybeEmptySlot(start)` 直到拿到一个 kernel 真的认为是空的 slot。
- slot 不空 → cleanup,start++ 继续(避免死循环)。

### 3.6 `GetDevice(ctx)`

从 `slots` channel 拿;`done` / `ctx.Done` 时返 `ErrClosed` / `ctx.Err()`。拿一个 +1 acquired,ready counter -1。

### 3.7 `ReleaseDevice(ctx, idx, opts...)`

循环到 `release` 成功:
- 再次 `isDeviceFree` 确认。
- clear `usedSlots`。
- 错误(`DeviceInUseError`):
  - `WithInfiniteRetry` 时 sleep 500ms 继续。
  - 否则立即返。
- 100 次循环 log 一次 warn。

### 3.8 `Close(ctx)`

- `doneOnce.Do(close(done))` 通知所有 Populate / GetDevice 退出。
- 遍历 `usedSlots`,挨个 `ReleaseDevice(WithInfiniteRetry, WithTimeout(10min))`。

---

## 4. `Dispatch` —— NBD 协议服务端

### 4.1 字段

```go
type Dispatch struct {
    fp             io.ReadWriter        // 与 NBD 客户端的 socket
    responseHeader []byte               // 16 字节预构造(NBDResponseMagic 已填)
    writeLock      sync.Mutex
    prov           Provider             // 实际读写的 backend
    provName       string               // %T prov,log 用
    pendingResponses sync.WaitGroup
    shuttingDown   bool
    shuttingDownLock sync.Mutex
    fatal          chan error           // 主循环里 fatal 错误
}
```

### 4.2 接口

```go
type Provider interface {
    ReadAt(ctx, p, off) (int, error)
    Size(ctx) (int64, error)
    io.WriterAt
    WriteZeroesAt(off, length) (int, error)
}
```

`block.Device` 直接实现这个接口。

### 4.3 `Handle(ctx)`

主循环:
1. 从 `dispatchBufPool` 拿 4MB 缓冲(减少分配)。
2. 循环 `fp.Read` 填 buffer,`rp`/`wp` 指针解多包流水线:
   - 头未完整(`wp-rp < 28`)→ 跳出,等下次 read。
   - 检查 `d.fatal` / `ctx.Done`。
   - 按 `Type` dispatch:
     - `NBDCmdDisconnect` → 返 nil(graceful exit)。
     - `NBDCmdFlush` → 返错(不支持)。
     - `NBDCmdRead` → `cmdRead`(异步)。
     - `NBDCmdWrite` → 必拿到完整数据(可能跨多次 read),再 `cmdWrite`。
     - `NBDCmdWriteZeroes` / `NBDCmdTrim` → `cmdWriteZeroes`(同步,cheap)。
   - 处理完一个包,`rp` 推进,留 partial 给下一轮。
3. 退出时 buffer 还回 pool。

### 4.4 `cmdRead(ctx, handle, from, length)`

- `shuttingDownLock` + `pendingResponses.Add(1)`,防止关 dispatch 时丢响应。
- 启 goroutine `performRead`:
  - 启内部 goroutine 跑 `d.prov.ReadAt`,结果走 `errchan`。
  - select 等 `errchan` 或 `ctx.Done()`(允许 caller cancel 抢回控制)。
  - 出错:
    - backend 错误 → 回 `writeResponse(1, handle, [])`(告诉 NBD 客户端 EIO),`dispatch` 继续。
    - `writeResponse` 错误 → 走 `d.fatal` 让主循环退出。
  - 成功 → 回 `writeResponse(0, handle, data)`。
- 退出时 `pendingResponses.Done()`。

### 4.5 `cmdWrite(ctx, handle, from, data)`

对称 `cmdRead`,但 `prov.WriteAt` 是同步的(Overlay 走 `cache.WriteAt`,mmap copy)。`writeZeroes` 同步执行(`punchHole + tracker.Zero` cheap)。

### 4.6 `cmdWriteZeroes`

```go
if _, err := d.prov.WriteZeroesAt(from, length); err != nil { respErr = 1 }
return d.writeResponse(respErr, handle, nil)
```

### 4.7 `Drain()`

- `shuttingDown = true`(让 `cmdRead`/`cmdWrite` 拒绝新请求)。
- 等 `pendingResponses`(等所有 in-flight 完成)。

### 4.8 关键设计

- **写顺序一致**:`writeLock` 保证同一时间只有一个响应在写 socket(防止 TCP 帧乱序)。
- **fatal channel** vs **写错误写回响应**:backend 错误不影响 dispatch 主循环,只有 socket 死掉才致命。
- **`shuttingDown` + `pendingResponses`**:`Drain` 等所有 in-flight 完成再让 handler 退出。
- **`dispatchBufPool` 4MB**:和内核请求 size 匹配,避免 read 时反复分配。

---

## 5. `DirectPathMount` —— NBD 客户端 + 内核注入

```go
type DirectPathMount struct {
    Backend block.Device
    devicePool *DevicePool
    featureFlags *featureflags.Client
    blockSize uint64       // 4096
    ioTimeout time.Duration     // 90s
    deadconnTimeout time.Duration // 30s
    dispatchers []*Dispatch
    socksClient []*os.File
    socksServer []io.Closer
    handlersWg sync.WaitGroup
    deviceIndex uint32
    cancelfn context.CancelFunc
}
```

### 5.1 `NewDirectPathMount`

- 默认 `ioTimeout=90s` > backend fetch timeout 60s,保证 dispatch 来得及回响应。
- `deadconnTimeout=30s` —— 内核等 I/O 超时后再等多少时间判定死连接。

### 5.2 `Open(ctx)`

**目标**:拿一个 NBD 设备 slot,在 sandbox 容器内连到一个本地 socket pair,告诉内核去这个 socket 拉数据。

1. `ctx, cancelfn = context.WithCancel(ctx)`。
2. `Backend.Size(ctx)`。
3. 循环(允许重试 BADF 等):
   - `devicePool.GetDevice(ctx)` 拿 slot。
   - 建 N 个 socket pair(`NBDConnectionsPerDevice`,LD 决定,默认 8)。
     - `syscall.Socketpair(AF_UNIX, SOCK_STREAM, 0)`。
     - `os.NewFile` 包两端,`net.FileConn` 包 server 端做 `FileServer`。
     - `NewDispatch(serverc, Backend)` + `d.handlersWg.Go(dispatch.Handle)`。
   - `nbdnl.Connect(deviceIndex, clients, size, 0, serverFlags, opts...)`:
     - `serverFlags = FlagHasFlags | FlagCanMulticonn | FlagSendTrim | flagSendWriteZeroes`。
     - `WithBlockSize(4096)`, `WithTimeout(90s)`, `WithDeadconnTimeout(30s)`。
   - 失败(`BADF` 偶发)→ 关 socket,释放 slot,等 25ms,重试。
   - `nbdnl.Status(deviceIndex)` 轮询到 `Connected`。

### 5.3 `Close(ctx)`

- `cancelfn()`(让所有 cmdRead/cmdWrite 的 `ctx` 取消)。
- 关所有 server sockets → 等 `handlersWg`(handler 退出)→ `dispatchers.Drain()` 等所有响应。
- `disconnectNBDWithTimeout(30s)` → `nbdnl.Disconnect` + 等 `!Connected`。
- 关所有 client sockets → `devicePool.ReleaseDevice(WithInfiniteRetry)`。

### 5.4 `GetDevicePath(slot)`

```go
return "/dev/nbd<slot>"
```

---

## 6. `GetNBDDevice` (helper)

```go
func GetNBDDevice(ctx, backend, ff, opts...) (DevicePath, *Cleaner, error)
```

- 创建 64-slot 一次性 pool,异步 Populate。
- 创建 mount,`Open` 拿 deviceIndex。
- 返 path + Cleaner(Close mount, close pool)。

主要用于 `cmd/mount-build-rootfs` 调试工具和 `package` 测试。

---

## 7. `MountNBDDevice` (helper)

```go
func MountNBDDevice(device, mountPath) (*Cleaner, error)
```

- `unix.Mount(device, mountPath, "ext4", 0, "")`。
- Cleaner 每 600ms tick 尝试 unmount,直到成功。

---

## 8. 关键不变量

1. **`Populate` goroutine 不会泄漏**:`d.slots` 的 send 总是带 `select{done, ctx, slots}`,任何路径退出都能让 `defer close(slots)` 跑。
2. **NBD slot 释放**:`ReleaseDevice` 用 `isDeviceFree` 双重确认 kernel 状态,避免把还在用的 slot 借给其他 sandbox。
3. **dispatch fatal vs backend fail 分离**:backend 错误只回 EIO 响应,socket 死了才 fatal。
4. **shuttingDown 顺序**:`Drain` → 等 handlers → 等 responses → disconnect → 释放 slot。**只关 server socket 不动 client**(否则 kernel 收到 RST 来不及处理)。
5. **多连接(`FlagCanMulticonn`)**:FC 客户端可同时打开多个 socket,内核 NBD 派发读请求;增加吞吐。

---

## 9. 与其他模块的关系

```
rootfs.NBDProvider.Start(ctx)
  └─ mnt.Open(ctx)                # 拿 /dev/nbdX
       ├─ devicePool.GetDevice
       ├─ 建 N 个 socket pair
       ├─ 每对: Dispatch.Handle (goroutine)
       └─ nbdnl.Connect (netlink)

Sandbox.Pause → rootfs.ExportDiff
  └─ Overlay.EjectCache → cache.ExportToDiff
       └─ 仍用 nbd 设备(此时 sandbox 已停,FC 已停)
            → NBD provider 仍在 listen 一切 backend 请求
            → ExportToDiff 走 kernel → dispatch → Overlay.ReadAt → cache.Slice

sandbox.doStop → cleanup → NBDProvider.Close → mnt.Close
  └─ 拆 NBD,归还 slot
```
