# 06. `block/` 块设备抽象、缓存、去重、分块

> 路径: `packages/orchestrator/pkg/sandbox/block/`
> 职责: 把 sandbox 用的 memfile/rootfs 暴露为统一的块设备接口,实现 mmap 化的本地缓存、按需分块拉取、memfd 导入、dedup、Overlay 写时复制、prefetch 追踪。

---

## 1. 文件分工

| 文件 | 职责 |
|------|------|
| `device.go` | 抽象接口:`Device` / `ReadonlyDevice` / `Slicer` / `FramedReader` / `FramedSlicer` / `CachePeeker` / `DiffSource` / `BytesNotAvailableError` |
| `cache.go` | `Cache`:mmap 文件 + dirty/zero 位图 + Sparse(零块不占盘) + pwritev/copy_file_range 导出 |
| `tracker.go` | `Tracker`:Dirty/Zero/NotPresent 三态位图 |
| `local.go` | `Local`:基于 `os.File.ReadAt` 的只读设备(全 read 都不截) |
| `empty.go` | `Empty`:全零只读设备,`Slice` 返回 `make([]byte, length)` |
| `overlay.go` | `Overlay`:cache 优先,miss 时穿透到下层 ReadonlyDevice |
| `memfd.go` | `Memfd` / `NewCacheFromMemfd` / `NewCacheFromMemfdAsync` / `NewCacheFromMemfdDeduped` / `pwritevAll` |
| `range.go` | `Range` / `BitsetRanges` / `GetSize` |
| `iov.go` | `IOV_MAX` / `MAX_RW_COUNT` / `drainIovs` 分批 iovec 工具 |
| `fetch_session.go` | `fetchSession`:chunk 拉取会话的并发等待 + 原子 bytesReady |
| `streaming_chunk.go` | `Chunker`:按需拉 chunk 到 cache,带 metric |
| `prefetch_tracker.go` | `PrefetchTracker`:块访问顺序 + 类型(read/write/prefetch) |
| `dedup.go` | 父 frame 比对 + cheap-frame 提升 + per-block fetch-window 压缩 |
| `metrics/main.go` | 计数/直方图,被 chunker 等使用 |

---

## 2. 接口(`device.go`)

```go
type Slicer interface { Slice(ctx, off, length) ([]byte, error); BlockSize() int64 }

type ReadonlyDevice interface {
    ReadAt(ctx, p, off) (int, error)
    Size(ctx) (int64, error)
    io.Closer
    Slicer
    BlockSize() int64
    Header() *header.Header
    SwapHeader(h *header.Header)
}

type Device interface {
    ReadonlyDevice
    io.WriterAt
    WriteZeroesAt(off, length) (int, error)
}

type CachePeeker interface { IsCached(ctx, off, length) bool }

type FramedReader interface {
    ReadAt(ctx, p, off, ft *storage.FrameTable) (int, error)
}
type FramedSlicer interface {
    Slice(ctx, off, length, ft *storage.FrameTable) ([]byte, error)
}

type DiffSource interface {
    io.Closer
    ReadAt(b, off) (int, error)
    Slice(off, length) ([]byte, error)
    Size() (int64, error)
    FileSize(ctx) (int64, error)
    BlockSize() int64
    Path(ctx) (string, error)
}

type BytesNotAvailableError struct{}
```

要点:
- `Slicer` 是 plain(无 FrameTable),UFFD/NBD 走它。
- `FramedReader/FramedSlicer` 带 `*storage.FrameTable`,`build.File` 走它(压/未压 chunker)。
- `DiffSource` 是上传/解压的输入,`Cache` 满足它。
- `BytesNotAvailableError` 是 chunker 检测 "needs fetch" 的标志,`is` 匹配用 `errors.As`。

---

## 3. `Cache` —— mmap 块缓存

### 3.1 字段

```go
type Cache struct {
    filePath  string
    size      int64
    blockSize int64
    mmap      *mmap.MMap
    mu        sync.RWMutex
    tracker   *Tracker           // Dirty=有数据,Zero=已知 0,未注册=NotPresent
    dirtyFile bool               // true 时 isCached 永远 true
    closed    atomic.Bool
}
```

### 3.2 `NewCache(size, blockSize, filePath, dirtyFile)`

- `os.OpenFile(..., O_RDWR|O_CREATE, 0644)`,`f.Truncate(size)`(Linux 上是 sparse)。
- `mmap.MapRegion` PROT_READ|PROT_WRITE 映射整文件。
- `dirtyFile=true` 用于 "从某个 source 全量复制" 场景,所有块都标 Dirty,后续 read 不再触发 fetch。
- `size=0` 时不 mmap,只保留 tracker(空 cache)。

### 3.3 写入路径

#### 3.3.1 `WriteAt` / `WriteAtWithoutLock`

```go
flush := func(runStart, runEnd int64, runZero bool) {
    if runZero { punchHole + tracker.SetRange(...Zero) } 
    else       { copy mmap + tracker.SetRange(...Dirty) }
}

runStart := off
runZero  := IsZero(b[:blockSize])
for i := off + blockSize; i < end; i += blockSize {
    z := IsZero(b[i-off : i-off+blockSize])
    if z == runZero { continue }
    flush(runStart, i, runZero)
    runStart, runZero = i, z
}
flush(runStart, end, runZero)
```

- **detect-zeroes=unmap** 优化:把同状态的连续块合并成一次 `punchHole` 或一次 `copy`。
- `punchHole` 用 `unix.MADV_REMOVE` 释放 backing 页;失败 fallback `clear(...)`。
- **调用方必须保证块对齐**;不满足直接 `misaligned write` 错误。

#### 3.3.2 `WriteZeroesAt`

走 punchHole + tracker.Zero,通常 NBD 写零使用。

### 3.4 读取路径

#### 3.4.1 `Slice(off, length)`

```go
if c.dirtyFile || c.isCached(off, length) { return mmap[off:end], nil }
return nil, BytesNotAvailableError{}
```

- `isCached` 查 `tracker.Present` —— Dirty ∪ Zero 都算 present。
- 不持有锁,mmap 视图跨调用有效,但 **写路径要锁**;调用方并发写同 block 需自己加锁。

#### 3.4.2 `sliceDirect(off, length)`

跳过 `isCached` 检查,给 chunker 用 —— chunker 已经等 fetch 完成后才调用。

### 3.5 `ExportToDiff` —— 把 cache 内容导出为 diff

```go
diff, empty := c.tracker.Export()
copy_file_range(f, dst)            // XFS 自动 reflink;失败 fallback io.Copy
```

- 关键:用 `unix.SyncFileRange` 提前把 dirty 范围写回(优化)。
- 对 diff.Dirty 的每个 range 调 `CopyFileRange`,内核 2GB 上限要循环。
- `CopyFileRange` 在跨文件系统 / 不支持时返 `EXDEV`/`EOPNOTSUPP`/`ENOSYS`,降级为 `io.Copy`。
- 返回的 `DiffMetadata{Dirty, Empty, BlockSize}` 给 Pause 路径的 header 计算用。

### 3.6 `Dedup` —— 父 memfile 去重

```go
func (c *Cache) Dedup(ctx, base ReadonlyDevice, dirty *Bitmap, blockSize, outPath, bestEffort, directIO, budget) (*Cache, *DiffMetadata, error)
```

- 构造 packed 偏移映射。
- `dedupCompare(src, base, dirty, blockSize, bestEffort, budget)` → `dedupPlan{pageDirty, pageEmpty}`。
- `dedupDrain(src, plan.pageDirty, blockSize, outPath, directIO)`:
  - `O_DIRECT` + `fallocate`(可选)。
  - 按 page×dirty 写出。
  - 末尾 `Truncate(fileOff)`。
- `recordDedupAttrs` 打 OTEL span attr(dedup ratio / promoted pages 等)。
- 返回新 `*Cache`(block size = PageSize,4KiB)+ `DiffMetadata`。
- 调用方在完成后 `cache.Close()` + `dedupCache.Close()`。

### 3.7 `NewCacheFromProcessMemory`

```go
func NewCacheFromProcessMemory(ctx, blockSize, filePath, pid, ranges) (*Cache, error)
```

- 拿 ranges 总大小建 cache。
- `copyProcessMemory`:
  - 预 split `ranges` ≤ `getAlignedMaxRwCount(blockSize)`(避开内核 2GB 上限)。
  - `drainIovs` 分批 → 用 `unix.ProcessVMReadv(pid, local, remote, 0)` 把 FC 进程 host-virt 内存拉到本地 mmap。
  - 处理 EAGAIN / EINTR / ENOMEM(短 backoff)。
- 失败时 `errors.Join(err, cache.Close())` 双清理。

### 3.8 `Close`

- 一次 `Unmap()` + `RemoveAll(filePath)`。
- `closed.CompareAndSwap(false, true)` 防重入。

---

## 4. `Tracker` —— Dirty/Zero/NotPresent 三态

```go
type State uint8
const ( NotPresent; Dirty; Zero )

type Tracker struct { mu sync.RWMutex; dirty, zero *Bitmap }
```

- 两个 `roaring.Bitmap`,**互不相交**。
- `SetRange(s, e, state)`:
  - Dirty: `dirty.AddRange` + `zero.RemoveRange`
  - Zero: `zero.AddRange` + `dirty.RemoveRange`
  - NotPresent: 两个都 RemoveRange
- `Present(s, e)` = dirty + zero 在范围内的 count == e-s(因为 disjoint)。
- `Export()` 返两个克隆,给 header 计算用。

---

## 5. `Local` / `Empty` / `Overlay` —— 简单设备实现

### 5.1 `Local`

```go
type Local struct {
    f    *os.File
    path string
    header atomic.Pointer[header.Header]
}
```

- 每次 `Slice` 都 `make + ReadAt`(全 read),不 mmap(冷数据用)。
- `Header() / SwapHeader()` 通过 atomic.Pointer 替换。
- `UpdateHeaderSize` 重新 stat 后更新 metadata。

### 5.2 `Empty`

```go
type Empty struct { header *header.Header }
```

- `Slice` 返回 `make([]byte, length)`,永远成功。
- 典型用途:header 里有 uuid.Nil mapping 的"洞"。

### 5.3 `Overlay` —— cache 优先的读写设备

```go
type Overlay struct {
    device ReadonlyDevice
    cache  *Cache
    cacheEjected atomic.Bool
    blockSize int64
}
```

- `ReadAt`:按 blockSize 切片,先 cache,miss 穿透 `device`。
- `WriteAt/WriteZeroesAt` 直接打到 cache。
- `EjectCache()`:返回 `*Cache`,之后 `Close()` 不会再关它(给 rootfs diff 用)。
- `Header/SwapHeader` 委托给下层 `device` —— 但真实场景是 `Overlay` 包 `Local`(template rootfs),由 template.LocalFileLink 维护 header。

---

## 6. `Memfd` / MemfdCache / DedupedMemfdCache

### 6.1 `Memfd`

```go
type Memfd struct { fd int; mmap []byte }
func NewFromFd(fd) (*Memfd, error)  // 拿走 fd,mmap 它
func (m *Memfd) Slice(offset, size) []byte
func (m *Memfd) Close() error
```

- 一次性 owner,Close 后不能再用。

### 6.2 `NewCacheFromMemfd`

```go
func NewCacheFromMemfd(ctx, blockSize, filePath, memfd, dirty) (*Cache, error)
```

- 建 cache(`size = dirty.count × blockSize`)。
- `copyFromMemfd`:按 BitsetRanges 顺序 `copy(mmap[cacheOff:cacheOff+r.Size], memfd.Slice(r.Start, r.Size))`,同时 `setIsCached`。
- 完成后 memfd Close。

### 6.3 `NewCacheFromMemfdAsync`

```go
func NewCacheFromMemfdAsync(ctx, ...) (*MemfdCache, error)
```

- 后台 goroutine 跑 `copyFromMemfd`,Pause 立即返回。
- 调 `Wait(ctx)` 才阻塞等 done,所有 read 都先 Wait 再 delegate。
- `Close` 触发 cancel + 等 done + 关 cache。

### 6.4 `NewCacheFromMemfdDeduped`

```go
func NewCacheFromMemfdDeduped(ctx, base, blockSize, outPath, memfd, dirty, bestEffort, directIO, budget, inputEmpty, metaOut) (*DedupedMemfdCache, error)
```

- 后台 goroutine:compare → drain → close memfd。
- **metaOut 在 compare 之后立即 set**(整个 plan.pageEmpty 已含 inputEmpty)。
- `scanEmptyPages` 在合并前被 capture,用于 dedup.empty_pages metric(scan-only 计数)。
- 完成后 `done` resolve 为最终 `*Cache`。

### 6.5 `pwritevAll(fd, off, iovs)`

`drainIovs` 切割好 iovs,这里写:
- 处理 EINTR 重试。
- 处理 short write:把第一个 iov 切掉已写部分,直到全部写完。
- `len(iovs) <= IOV_MAX` 由调用方保证。

---

## 7. `Range` / `BitsetRanges` / `drainIovs` / `IOV_MAX`

### 7.1 `Range`

```go
type Range struct { Start, Size int64 }
func (r *Range) End() int64
func NewRange(start, size) Range
func NewRangeFromBlocks(startIdx, nBlocks, blockSize) Range
```

### 7.2 `BitsetRanges`

```go
func BitsetRanges(b *Bitmap, blockSize) iter.Seq[Range]
```

用 `iter.Seq` (Go 1.23+),把 bitmap 的 `Ranges()` 转为 blockSize 对齐的 Range,无分配。

### 7.3 `drainIovs`

```go
func drainIovs[T any](items, sizeOf, blockSize, op func(destOff, batch, batchBytes) error) error
```

- 每批 `IOV_MAX` 个 / `MAX_RW_COUNT & PAGE_MASK` 字节。
- 超过任一上限就切批,调用 `op(destOff, batch, batchBytes)`,destOff 累加。
- 用于 process memory copy、dedup drain、cache export。

### 7.4 `IOV_MAX` / `MAX_RW_COUNT`

- `IOV_MAX` 从 `sysconf(SC_IOV_MAX)` 拿,通常是 1024。
- `MAX_RW_COUNT = INT_MAX & PAGE_MASK` —— Linux 写不能超过 ~2GiB(可避免,见 stackoverflow 链接)。

---

## 8. `fetchSession` —— chunk 拉取会话

```go
type fetchSession struct {
    chunkOff, chunkLen int64
    cache *Cache
    mu sync.Mutex; cond sync.Cond
    fetchErr error
    done bool
    bytesReady atomic.Int64   // 进度(从 chunkOff 起算)
}
```

- `registerAndWait(ctx, blockOff)`:
  - 算 `endByte = min(blockOff+blockSize - chunkOff, chunkLen)`。
  - **fast path**:`bytesReady.Load() >= endByte` 立即返回。
  - 慢路径:cond.Wait,`ctx.AfterFunc` 触发 Broadcast 退出。
  - terminated 时:
    - 块已 cached → 返 nil(其他 session 已 fetch 完毕)。
    - fetchErr != nil → wrap error。
    - 否则 → "terminated without error but block not cached" 内不一致错误。
- `advance(bytesReady)`:进度更新 + Broadcast。
- `setDone`:成功完成,`bytesReady = chunkLen`。
- `fail(err)`:无条件失败。
- `failIfRunning(err)`:panic recovery / safety-net 用,只在未终止时记错误,然后 Broadcast。

**保证**:`bytesReady` 单调增 → fast path 安全;`cond` 在 mu 保护下操作;`AfterFunc(ctx)` 用 ctx 控制 broadcast 触发。

---

## 9. `Chunker` —— 流式拉 chunk

```go
type Chunker struct {
    cache *Cache
    metrics metrics.Metrics
    fetchTimeout time.Duration     // 60s,单个 chunk
    featureFlags *featureflags.Client
    size int64
    fetchMu sync.Mutex
    fetchSessions []*fetchSession
}
```

### 9.1 `NewChunker(ff, size, blockSize, cachePath, metrics)`

新建底层 `Cache`(blockSize, 4KB / PageSize 之类),`fetchTimeout=60s`。

### 9.2 `ReadAt(ctx, b, off, upstream, ft)` / `Slice(ctx, off, length, upstream, ft)`

1. `cache.Slice(off, length)`:
   - 命中 → 立即返 + `successFromCache` 计时。
   - `BytesNotAvailableError` → 继续 fetch。
2. 循环 fetch:对每个 chunk 调用 `locateChunk(cur, ft)`:
   - 压缩:frame table → `[r.Offset, r.Length)`。
   - 未压缩:`MemoryChunkSize` 对齐(向后兼容)。
3. `fetch(ctx, cur, rangeEnd-cur, upstream, ft)` —— 取得 session,等所有 [startBlock, endBlock] 都 ready(跨 block 也等)。
4. `cache.sliceDirect(...)` → `successFromRemote` 计时。

### 9.3 `getOrCreateSession`

- 查已有 session(看 `contains(off, length)`)。
- 加锁后再检查 `cache.isCached(off, length)`,防止 TOCTOU(fetch 完时 mark cached 与 session 创建竞争)。
- 创建新 session,启动 `runFetch` goroutine(`context.WithoutCancel` —— 即使第一个 caller 取消也要继续)。

### 9.4 `runFetch`

- mmap 写端 `addressBytes(chunkOff, chunkLen)` 取锁。
- `progressiveRead`:
  - 打开 `upstream.OpenRangeReader(ctx, chunkOff, chunkLen, ft)`。
  - 按 `readBatch = max(blockSize, MinChunkerReadSizeKB×1024)` 分批 `io.ReadFull`。
  - 每批 `s.advance(totalRead)` —— 推进 bytesReady,唤醒所有 waiter。
- 完成后 `cache.setIsCached(chunkOff, chunkLen)` **在 release lock 之前**,关闭 TOCTOU。
- `setDone()` 唤醒所有 waiter,`defer s.failIfRunning(...)` 兜底。

### 9.5 `locateChunk`

```go
if ft.IsCompressed() {
    r, _ := ft.LocateUncompressed(off)
    return r.Offset, int64(r.Length), nil
}
chunkOff := (off / MemoryChunkSize) * MemoryChunkSize
return chunkOff, min(MemoryChunkSize, c.size - chunkOff), nil
```

### 9.6 `IsCached(ctx, off, length)`

给 `block.CachePeeker` 用 —— dedup 阶段判断"父 base 某 range 是否在本地"。

### 9.7 指标

- 四个 outcome:`successFromCache` / `successFromRemote` / `failCacheRead` / `failRemoteFetch` / `failLocalReadAgain`。
- `chunkerAttrs` 和 `chunkerAttrsCompressed` 两套,compressed 版本多了 `compressed` attr。
- `RemoteReads` timer:`remoteSuccess` / `remoteFailure` + `failureTypeRemoteRead`。

---

## 10. `PrefetchTracker` —— 块访问追踪

```go
type PrefetchData struct {
    BlockEntries map[uint64]PrefetchBlockEntry
    BlockSize    int64
}
type PrefetchBlockEntry struct { Index, Order uint64; AccessType AccessType /* read/write/prefetch */ }
```

- `Add(off, type)`:第一次见到该 block 才记录,`Order` 单调增。
- `PrefetchData()`:停止追踪 + 返回快照(map 拷贝,避免后续 mutation)。

被 `uffd` 在每次 fault 时调用 `Add`,pause 时拉一份 `PrefetchData` 给上层。

---

## 11. `dedup.go` —— 与父 memfile 去重

### 11.1 数据结构

```go
type DedupBudget struct {
    MaxFetchWindowsPerBlock, MaxPromotedParentPagesPerBlock int
    MaxPagesPerPromotedFrame, BlockFaultPct int
    FetchRunWindowPages int   // 0 → use storage.DefaultCompressFrameSize / PageSize
}

type dedupPlan struct {
    pageDirty, pageEmpty *roaring.Bitmap
    exportedSize int64
    promotedBlocks, promotedPages, parentFrames int64
    promotedFrames, promotedFramePages int64
}
```

### 11.2 `dedupCompare` 三步

1. **per-page 分类**:
   - 全 0 页 → `pageEmpty`。
   - 与 base 不等 → `pageDirty`。
   - 与 base 相等 → 候选 dedup(由 `parentFetchKey` 分组)。
   - 父 header 是 `BuildId=uuid.Nil` 的"洞" → pageDirty(不可 fallback)。
   - `bestEffort=true` 且父页 uncached → pageDirty(避免误用未缓存的父数据)。
2. **cheap-frame promotion**(`promoteCheapFrames`):
   - 算 `value = (1-pFault)^extBlocks * (1 - (1-pFault)^distinctBlocks)`。
   - 每个 candidate key:若 `pageCount <= MaxPagesPerPromotedFrame * value`,把整个 key 提升为 pageDirty。
3. **per-block fetch-window 压缩**(`compactBlockWindows`):
   - 一个 block 内的所有页按 fetch-key 分组,每组是一组 parent page。
   - 贪心:按组大小升序提升为 current,直到 fetch window 数 ≤ `maxWindows` 或 promotion 预算用尽。
   - 只提升**整组**(整 key),部分提升无法减少 fetch window。
   - 当前页和已提升的页都算 fetch window,model 准确。

### 11.3 `compactBlockWindows` 实现要点

```go
type fetchWindower struct {
    windowPages int
    currentStart int64  // 已存储的 page 数(用于算 current page 的 fetch window 数)
}

func (w fetchWindower) currentWindows(n int) int {
    return int((w.currentStart+int64(n)-1)/wp - w.currentStart/wp + 1)
}
```

- `parentKeyGroups` 按 key 长度升序、tie 时按首 page 升序,返回 `[][]int`(每组是该 key 的 page 索引)。
- 贪心:扫前缀,`g+1` 个组 + 当前 n 个 current pages 的总 window 是否 < 当前 best;若 < best,记 chosen。
- 找到最优前缀后,把这些组里所有 page kind 改为 `dedupPageCurrent`。

### 11.4 `countExternalBlocks`

为 cheap-frame promotion 算"外部有多少 block 仍然引用此 frame"。

- 遍历 base header 所有 `BuildMap`。
- 对每个 mapping 的 block 范围,跳过 dirty block,按 frame table 切窗口。
- 对每个窗口 key,如果上次见到该 block 是不同 block,计数 +1。

### 11.5 `parentFetchKey` / `fetchKeyAndEnd`

- 父 header 已知 frame table 且压缩 → 取该页所在的 exact frame。
- 否则按 `windowBytes = FetchRunWindowPages × PageSize` 桶分。

### 11.6 `recordDedupAttrs`

打 OTEL span attrs:
- `dedup.total_pages` / `deduped_pages` / `unique_pages` / `empty_pages`。
- `dedup.ratio` = deduped/total。
- `dedup.promoted_blocks` / `promoted_pages`(per-block cap 提升)。
- `dedup.parent_frames`(候选父帧数)。
- `dedup.promoted_frames` / `promoted_frame_pages`(global cheap-frame)。
- `dedup.compare_ms` / `dedup.write_ms`。

---

## 12. 关键不变量

1. **`Cache` mmap 视图跨 Slice 调用有效**;但写路径加锁保证不并发写同一 block。
2. **Tracker 的 dirty 和 zero disjoint**;Present 计数 == dirty + zero。
3. **memfd 的生命周期**:NewCacheFromMemfd* 拿所有权并在内部 Close。
4. **chunk fetch 进度单调**:`bytesReady` 只增,fast path 安全;`setIsCached` 在 release lock 之前,关闭 TOCTOU。
5. **dedup 输出 PageSize**,block size 在 FC 视角是 4KB(对齐)。
6. **cheap-frame 阈值**:`BlockFaultPct` 0 或 100 时是 strict(只提升"父帧无人引用"的情况)。

---

## 13. 与本目录其他模块的协作

```
Sandbox.CreateSandbox (cold)
  └─ memfile.size → NoopMemory(memfd=nil) → memory.ExportMemory(走 exportMemoryFromFc)

Sandbox.ResumeSandbox (warm)
  └─ uffd.New → memory.Memfd (FC PUT /memfd) → ExportMemory(走 NewCacheFromMemfd* / dedup)

Sandbox.Pause
  ├─ pauseProcessMemory
  │    └─ ExportMemory → memfd → (optional)Dedup → cache → ExportToDiff → DiffMetadata
  └─ pauseProcessRootfs
       └─ Overlay.EjectCache → Cache.ExportToDiff → DiffMetadata
```
