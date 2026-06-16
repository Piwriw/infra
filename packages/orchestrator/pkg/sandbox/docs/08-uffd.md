# 08. `uffd/` userfaultfd 按需分页、写时复制

> 路径: `packages/orchestrator/pkg/sandbox/uffd/`
> 职责: 在 sandbox resume 时,通过 userfaultfd 接管 guest 内存,按需从 memfile(模板)拉页;pause 时统计 dirty/empty 区域;提供主动 prefetch。

---

## 1. 文件分工

| 文件 | 职责 |
|------|------|
| `uffd.go` | `Uffd` 类型 + `MemoryBackend` 实现:接 FC unix socket、解析 region mappings、驱动 `Userfaultfd.Serve` |
| `memory_backend.go` | `MemoryBackend` 接口(全 sandbox 内存后端的抽象) |
| `noop.go` | `NoopMemory`:不接 UFFD 的占位实现(冷启动 sandbox 用) |
| `userfaultfd/` | 内核 userfaultfd 设施的高级包装(看 `userfaultfd.md` 内部) |
| `memory/` | `memory.Mapping` / `memory.Region`(FC 报的 user-virt → host-virt 映射) |
| `prefetch/` | `prefetch.New(...)` 主动预取 goroutine |
| `fdexit/` | `fdexit.FdExit`:通知 handler 退出的 eventfd |

---

## 2. `MemoryBackend` 接口

```go
type MemoryBackend interface {
    DiffMetadata(ctx, f *fc.Process) (*header.DiffMetadata, error)
    PrefetchData(ctx) (block.PrefetchData, error)
    Prefault(ctx, offset, data) (installed bool, err error)
    Start(ctx, sandboxID) error
    Stop() error
    Ready() chan struct{}
    Exit() *utils.ErrorOnce
    Memfd(ctx) *block.Memfd
    ServeStats() userfaultfd.ServeSnapshot
}
```

- `DiffMetadata`:返回 dirty + empty bitmap 给 `Pause` 用。
- `PrefetchData`:返回 page fault 顺序 + 类型。
- `Prefault`:envd `POST /prefetch` 用,主动装一页(返回是否真的装了)。
- `Start`:开始接收 FC 连接;`Ready()` 在握手完成后 close。
- `Stop`:发退出信号给 handler。
- `Memfd`:把 FC 传来的 memfd 所有权转走(给 `ExportMemory` 用),Uffd teardown 不会再关。
- `ServeStats`:cumulative 统计(Pages/Bytes/SourcePages),`WaitForEnvd` 第一次成功时上报。

---

## 3. `Uffd` —— 主实现

### 3.1 字段

```go
type Uffd struct {
    exit       *utils.ErrorOnce
    readyCh    chan struct{}
    readyOnce  sync.Once
    lis        *net.UnixListener
    socketPath string
    memfile    block.ReadonlyDevice    // 父 memfile 头
    memfd      atomic.Pointer[block.Memfd]
    handler    utils.SetOnce[*userfaultfd.Userfaultfd]
    fdExit     utils.SetOnce[*fdexit.FdExit]
}
```

### 3.2 `New(memfile, socketPath)`

只构造,不启任何东西。`memfile` 用来:
- 取 `Header()` 拿 generation(给 metrics 标签)。
- 提供 `Slice` 给 UFFD handler 做读(实际从 memfile 拉数据)。

### 3.3 `Start(ctx, sandboxID)`

- `net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})`。
- `os.Chmod(socketPath, 0o777)`(FC 进程能连)。
- `fdexit.New()` —— eventfd,handler 用它监听退出。
- 后台 goroutine 跑 `u.handle(ctx, sandboxID, fdExit)`。
- handle 失败 → `handler.SetError` 让 Prefetch goroutine 不再 hang。

### 3.4 `handle(ctx, sandboxID, fdExit)`

1. `lis.SetDeadline(time.Now().Add(10s))` —— 10s 内没 FC 连就放弃。
2. `lis.Accept`。
3. `unixConn.ReadMsgUnix(regionMappingsBuf, fdBuf)`:
   - **payload** = JSON `[memory.Region]`:FC 报告的 guest 内存区(user-virt + 长度 + flags)。
   - **control message** = SCM_RIGHTS:1 个 fd(uffd)或 2 个(uffd + memfd,新 FC 版本)。
4. JSON unmarshal regions,ParseSocketControlMessage 拿 fds。
5. 校验 `len(controlMsgs) == 1` + `len(fds) >= 1`。
6. `memory.NewMapping(regions)` 构造 UFFD 用的映射对象。
7. `userfaultfd.NewUserfaultfdFromFd(fds[0], memfile, m, generation, logger)`:
   - 接管 fds[0],构造 handler。
8. defer:
   - 关闭 uffd。
   - 关闭 memfd(若 `memfd.Swap(nil)` 还有)。
9. 若有 memfd(`fds[1]`):`block.NewFromFd(fds[1])`,`u.memfd.Store(memfd)`。
10. `u.handler.SetValue(uffd)` + `u.readyOnce.Do(close(u.readyCh))`。
11. `uffd.Serve(ctx, fdExit)` —— 阻塞,处理 page fault 直到 exit。

### 3.5 `Prefault(ctx, offset, data)`

```go
handler, err := u.handler.WaitWithContext(ctx)
return handler.Prefault(ctx, offset, data)
```

把 `data` 装到 `offset` 位置,跳过已存在页(返回 `installed=false`)。这是 envd `POST /prefetch` 的核心:envd 在 sandbox 启动后,根据 prefetch mapping 预热特定页。

### 3.6 `Stop()`

`fdExit.SignalExit()` —— handler 的 `Serve` 监听到后退出,defer 链清理 uffd + memfd。

### 3.7 `DiffMetadata(ctx, fcProcess)` —— Pause 用

```go
handler, _ := u.handler.WaitWithContext(ctx)
_, empty := handler.ExportPageStates()   // WP-async pagemap

diff, _ := fcProcess.DirtyMemory(ctx, handler.PageSize())
empty.AndNot(diff.Dirty)                  // dirty wins over empty
return &header.DiffMetadata{Dirty: diff.Dirty, Empty: empty, BlockSize: diff.BlockSize}, nil
```

要点:
- **WP-async 协议**:`ExportPageStates` 一次性返回 Zero bitmap(FC 用 write-protect 异步报回);`DirtyMemory` 走 FC `GET /memory/dirty` 拿 WP-async 写过的页。
- 注释解释:`Settle in-flight UFFD workers (and the REMOVE batch) before sampling FC's WP-async pagemap, so a Zero→Write install can't slip in between and escape both bitmaps.` —— 必须等 in-flight worker 完成,否则 Zero 后被 Write 的页会在两个 bitmap 中都漏报。
- `empty.AndNot(diff.Dirty)`:dedup 出"已被记为 dirty 的 empty"。

### 3.8 `PrefetchData(ctx)`

`handler.PrefetchData()` —— 返回按访问顺序排列的 block entries + 类型(read/write/prefetch)。

### 3.9 `Memfd(ctx)`

```go
return u.memfd.Swap(nil)
```

把 memfd 所有权一次性转走。`Uffd.handle` defer 里的 `u.memfd.Swap(nil)` 现在拿到 nil,不再 Close。

### 3.10 `ServeStats()`

```go
handler, err := u.handler.Result()    // 不阻塞,handler 没就绪时返零 snapshot
return handler.ServeStats()
```

返回 cumulative 统计(从 resume 起的所有 page fault)。`WaitForEnvd` 第一次成功时 `startupStatsOnce.Do` 上报,关键指标:
- `uffdStartupPages`:按 page 算
- `uffdStartupSourcePages`:从 memfile 拉来的页
- `uffdStartupBytes`:对应字节数

`startupStatsOnce` 保证只在 sandbox 实际启动时记一次,后续 envd binary swap 的 `WaitForEnvd` 不会再上报。

---

## 4. `NoopMemory` —— 冷启动用

```go
type NoopMemory struct {
    size, blockSize int64
    exit *utils.ErrorOnce
}
```

- `Start` 是 no-op。
- `Ready` 立刻 close 的 channel。
- `DiffMetadata` 调 `fc.MemoryInfo` 拿 `Resident + Empty` bitmap,把 Resident 当 Dirty;`Empty` 用 `Flip(Dirty, 0, totalPages)` 算(diffInfo.Empty 不完整,要补)。
- `Prefault` 是 no-op。
- `ServeStats` 永远返零。

冷启动走 `FC /memory`(需要 FC custom 支持),不走 userfaultfd。

---

## 5. `prefetch/` —— 主动预取

入口在 `Factory.ResumeSandbox` 中:

```go
if meta.Prefetch != nil && meta.Prefetch.Memory != nil {
    fcUffd, err := uffdPromise.Wait(ctx)
    if err != nil { return }

    p := prefetch.New(logger, memfile, fcUffd, meta.Prefetch.Memory, featureFlags)
    err := p.Start(execCtx)   // 启动后台 goroutine
}
```

`prefetch.Prefetcher` 在 sandbox 启动后异步工作:
- 读 `meta.Prefetch.Memory`(prefetch mapping 文件)。
- 周期性 `uffd.Prefault(offset, data)` 装页,跳过已存在。

目的:把 envd init 时的 fault 工作前移到 sandbox 刚 resume 的窗口,减少首次 `WaitForEnvd` 的耗时。

---

## 6. `fdexit/` —— 退出事件

```go
type FdExit struct {
    efd int
}

func New() (*FdExit, error)         // eventfd(0, EFD_NONBLOCK|EFD_CLOEXEC)
func (e *FdExit) SignalExit() error  // 写 eventfd
func (e *FdExit) Close() error       // 关 eventfd
```

`Userfaultfd.Serve` 内部用 `select` 同时监听 uffd fd + exit fd;exit fd 触发就退出 serve 循环。

为什么用 eventfd 而不靠 ctx cancel?—— UFFD `poll` 是阻塞系统调用,直接 cancel 可能不通知底层 syscall,eventfd 是 Linux 习惯的 wakeup fd 模式。

---

## 7. `memory/`

提供 `Mapping` 和 `Region` 类型,`UFFD` handler 用它把 guest 虚拟地址翻译成 memfile 中的对应位置。

(详细实现见 `09-memory-mapping.md` 内部;这里只提接口)

---

## 8. `userfaultfd/` 高级包装

提供 `Userfaultfd` 类型,封装:
- 各种 page fault 处理(MISS / WP / MINOR_SHMEM / ...)
- WP-async 协议(state machine、bitmap 更新)
- Serve loop(多 worker + main loop)
- Prefault / ExportPageStates / PrefetchData / ServeStats

文件多而细,建议独立成单独文档 `uffd-userfaultfd.md` 内部阅读。

---

## 9. 关键不变量

1. **Memfd 一次性 ownership**:`Uffd.handle` 关闭时若 `u.memfd` 仍非 nil,会 Close 一次;`Memfd()` 调 `Swap(nil)` 转走所有权,handle 关闭时就是 nil。
2. **`readyOnce`** 防止 FC 重连时 readyCh 被关两次。
3. **`DiffMetadata` 必须先等 in-flight worker**:WP-async 协议下,先 `ExportPageStates` 等 settle,再 `DirtyMemory`。
4. **NoopMemory 与 Uffd 互斥**:一个 sandbox 只会用其中一个。`Factory.CreateSandbox` 用 NoopMemory,`Factory.ResumeSandbox` 用 Uffd。
5. **`Prefault` 是 idempotent** —— handler 内部会查 page state,已存在的页直接返 `installed=false`,不重复装。
6. **`ServeStats` 在 handler 未就绪时返零**:resume 后的最初几毫秒内 `WaitForEnvd` 可能先到;这里返零保证不会 panic。

---

## 10. 与其他模块的关系

```
Sandbox.ResumeSandbox
  ├─ uffd.New(memfile, socketPath)
  ├─ go uffd.Start (异步 serve)
  │    └─ 等 FC 连接
  │         ├─ 拿 uffd fd(+ memfd 可选)
  │         ├─ 解析 regions
  │         ├─ userfaultfd.NewUserfaultfdFromFd
  │         └─ Serve (处理 page fault,直到 fdExit)
  ├─ (条件) prefetch.New(memfile, uffd, prefetchMapping, ff)
  │    └─ 异步 Prefault 装页
  └─ fc.Resume(uffdSocket, snapfile, uffdReady, ...)

Sandbox.Pause
  └─ uffd.DiffMetadata
       ├─ handler.ExportPageStates  → empty bitmap
       ├─ fc.DirtyMemory            → dirty bitmap
       └─ empty.AndNot(dirty)
  └─ pauseProcessMemory
       └─ fc.ExportMemory(memfd=uffd.Memfd(), ...)

sandbox.doStop → memory.Stop → uffd.Stop → fdExit.SignalExit
```
