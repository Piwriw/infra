# 10. `template/` 与 `build/` 模板与差异存储

> 路径: `packages/orchestrator/pkg/sandbox/{template,build}/`
> 职责: 模板缓存(template.Cache,本地 TTL + peer 路由 + NFS) + build diff 存储(build.DiffStore + build.File)。

---

# Part A. `template/` 模板缓存

## 1. 文件分工

| 文件 | 职责 |
|------|------|
| `template.go` | `Template` 接口、`closeTemplate` 工具 |
| `cache.go` | `Cache` 模板内存缓存(ttlcache + buildStore + peer + NFS) |
| `storage.go` | `newTemplateFromStorage` 工厂 + common helpers |
| `storage_template.go` | 真实 StorageTemplate 实现(template.Template 接口) |
| `storage_file.go` / `file.go` / `local_file.go` / `mask_template.go` | file 抽象 |
| `header_metrics.go` | 模板 header 解析的指标 |
| `local_template.go` | 调试用 |
| `peerclient/` | P2P 客户端(从 peer orch 拉数据) |
| `peerserver/` | P2P 服务端(给其他 orch 拉) |
| `mocks/` | mock |

## 2. `Template` 接口

```go
type Template interface {
    Files() storage.CachePaths
    Memfile(ctx) (block.ReadonlyDevice, error)
    Rootfs() (block.ReadonlyDevice, error)
    Snapfile() (File, error)
    Metadata() (metadata.Template, error)
    UpdateMetadata(meta metadata.Template) error
    Close(ctx) error
}
```

实现:`*storageTemplate`,持有一个 buildStore 引用和 memfileHeader / rootfsHeader 这两个 `*utils.SetOnce[*header.Header]`。

## 3. `Cache` —— 模板入口

### 3.1 字段

```go
type Cache struct {
    config        cfg.Config
    flags         *featureflags.Client
    cache         *ttlcache.Cache[string, Template]
    persistence   storage.StorageProvider
    buildStore    *build.DiffStore
    blockMetrics  blockmetrics.Metrics
    rootCachePath string
    peers         peerclient.Resolver
    extendMu      sync.Mutex
}
```

### 3.2 TTL

```go
const (
    templateExpiration       = 25 * time.Hour
    templateExpirationBuffer = 1 * time.Hour
)
```

- `templateExpiration` 应大于 sandbox 最大生命周期(避免 live sandbox 的 template 被驱逐)。
- `maxSandboxLengthHours` 传进来 → 实际 TTL = `max(25h, maxLen + 1h)`。
- `extendMu` 锁防止两个 goroutine 竞争 `GetOrSet` 时被覆盖。

### 3.3 `NewCache` 启动期清理

- 创建 `ttlcache`,注册 `OnEviction` 钩子:
  - `peers.Purge(item.Key())` —— 让 P2P 层忘掉这个 buildID。
  - `template.Close(ctx)` —— 释放 memfile/rootfs/snapfile 句柄。
- `cleanDir(config.DefaultCacheDir)` —— 启动时清空 build cache dir(防止 stale 数据)。
- `build.NewDiffStore(config, flags, ..., peers.IsActive)` —— 真实的 diff 存储。

### 3.4 `GetTemplate(ctx, buildID, isSnapshot, isBuilding, opts...)`

```go
persistence := c.persistence
if path, enabled := c.useNFSCache(ctx, isBuilding, isSnapshot); enabled {
    persistence = storage.WrapInNFSCache(ctx, path, persistence, c.flags)
    span.SetAttributes(attribute.Bool("use_cache", true))
}
if c.flags.BoolFlag(ctx, featureflags.PeerToPeerChunkTransferFlag) {
    persistence = peerclient.NewRoutingProvider(persistence, c.peers)
}
storageTemplate, _ := newTemplateFromStorage(..., persistence, c.blockMetrics, nil, nil)
return c.getTemplateWithFetch(ctx, storageTemplate, maxLen)
```

- `isBuilding` 不走 NFS 缓存(本次 build 不被未来 sandbox 用)。
- `isSnapshot` 用 `SnapshotFeatureFlag`,`!isSnapshot` 用 `TemplateFeatureFlag`。
- P2P 路由:把 `persistence` 包一层,每个 chunk 的 fetch 都会先看 peer 是不是活的、是不是有这段数据。

### 3.5 `getTemplateWithFetch`

```go
key := tmpl.Files().CacheKey()
c.extendMu.Lock()
t, found := c.cache.GetOrSet(key, tmpl, ttlcache.WithTTL(ttl))
if found && t.TTL() < ttl {
    c.cache.Set(key, t.Value(), ttl)        // 短 TTL 已被另一个 team 拉长
}
c.extendMu.Unlock()

if !found {
    missesMetric.Add(ctx, 1)
    go tmpl.Fetch(context.WithoutCancel(ctx), c.buildStore)
} else {
    hitsMetric.Add(ctx, 1)
}
return t.Value()
```

- `Fetch` 异步,且 detach ctx —— 不被原始请求的 cancel 终止(否则同 template 多个 sandbox 启动会失败)。
- 第一次 GetOrSet 成功后,后续同 key 直接走 hits。

### 3.6 `AddSnapshot` —— Pause 完成后注册

```go
func (c *Cache) AddSnapshot(ctx, buildId, memfileHeader, rootfsHeader, localSnapfile, localMetafile, memfileDiff, rootfsDiff) error
```

- 把 `memfileDiff` / `rootfsDiff` 注册到 `buildStore`(若不是 `*build.NoDiff`)。
- 创建 `storageTemplate` 并 put 进 `cache` 触发 fetch(但**不**返回 error,异步跑)。

### 3.7 `useNFSCache`

- `isBuilding=true` → 不缓存。
- 否则查 LD `SnapshotFeatureFlag` / `TemplateFeatureFlag`,且要求 `rootCachePath != ""`。

## 4. `storageTemplate` 实现

构造时拿到 persistence + memfileHeader/rootfsHeader + metrics + snapfile/metafile(可能 nil)。

- `Files()` 返 `storage.CachePaths`(模板的本地路径集合)。
- `Memfile(ctx)` 走 buildStore 拿 memfile diff。
- `Rootfs()` 走 buildStore 拿 rootfs diff。
- `Snapfile()` 返本地 `File`(可能 NoopFile)。
- `Metadata()` 读 metafile 路径 → `metadata.Template`。
- `UpdateMetadata` 写 metafile + SwapHeader。

## 5. `File` 抽象

`File` 表示一个 sandbox 可见的 file(snapfile、metafile、memfile 入口、rootfs 入口),有 Path() 和 Close()。

---

# Part B. `build/` build diff 存储

## 1. 文件分工

| 文件 | 职责 |
|------|------|
| `build.go` | `Diff` 接口 + `File` 类型(给定一个 buildID,组装 ancestors + 当前层) |
| `cache.go` | `DiffStore`:diff 对象的 TTL 缓存 |
| `diff.go` | `Diff` 工厂与基础类型 |
| `local_diff.go` | `NewLocalDiffFromCache` / `NewLocalDiffFile` —— 本地 cache 路径的 diff |
| `header_load.go` | `refreshBuildHeader` 远程 header 拉取 |
| `storage_diff.go` | 真实 StorageDiff 实现(可远端拉、按 frame table 解压) |
| `read_metrics.go` | 读路径指标 |
| `mocks/` | mock |

## 2. 关键类型

```go
type DiffType string
const (
    Memfile DiffType = "memfile"
    Rootfs  DiffType = "rootfs"
)

type Diff interface {
    io.Closer
    ReadAt(ctx, p, off int64) (int, error)
    Slice(ctx, off, length) ([]byte, error)
    Size() (int64, error)
    FileSize(ctx) (int64, error)
    BlockSize() int64
    Path(ctx) (string, error)
    RefreshSource(ctx) error
}

type File struct {
    header      atomic.Pointer[header.Header]
    store       *DiffStore
    fileType    DiffType
    persistence storage.StorageProvider
    metrics     blockmetrics.Metrics
}
```

`File` 是模板视角的"看一整张 build 链"的抽象:从自己的 header 出发表,沿 mapping 拉各祖先 build 的 diff。

## 3. `File.ReadAt(ctx, p, off)`

```go
for {
    segments, n, distinctBuilds, err := b.planRead(ctx, p, off)
    if err == nil { err = b.readSegments(ctx, p, segments, maxParallel) }
    if err == nil {
        recordReadFanout(...)
        if n < len(p) { return n, io.EOF }
        return n, nil
    }
    var closed *block.CacheClosedError
    if errors.As(err, &closed) { continue }     // diff 被并发驱逐,重新 plan
    return 0, err
}
```

- planRead 切片每个 mapping 段;uuid.Nil 段 zero-fill。
- readSegments 并发拉(limit=maxParallel)。
- 失败若是 CacheClosed → 重试;其他 → 报错。

## 4. `planRead` 详解

```go
const buildCacheSize = 16
var (
    underlyingIDs   [16]uuid.UUID
    underlyingDiffs [16]Diff
    cacheIDs  = underlyingIDs[:0]
    cacheDiffs = underlyingDiffs[:0]
)

for n < len(p) {
    mapped, _ := h.GetShiftedMapping(ctx, off+int64(n))
    readLength := min(int64(mapped.Length), int64(len(p)-n))
    if readLength <= 0 { return segments, n, len(cacheIDs), nil }  // EOF
    if mapped.BuildId == uuid.Nil {
        clear(p[n : n+int(readLength)]); n += int(readLength); continue
    }
    diff, _ := b.cachedBuild(ctx, mapped.BuildId, &cacheIDs, &cacheDiffs)
    segments = append(segments, readSegment{...})
    n += int(readLength)
}
```

要点:
- 栈上数组当 per-read cache,容量 16,满了就丢(实际很少超过)。
- `distinctBuilds` 在 extremely fragmented read 时会饱和(超过 16 返回 16)。
- zero-length mapping → EOF(`io.ReaderAt` 语义)。

## 5. `readSegment` —— 错误恢复

```go
n, err := s.diff.ReadAt(ctx, dst, s.srcOff, s.ft)
if err != nil {
    var transitionErr *storage.PeerTransitionedError
    if !errors.As(err, &transitionErr) { return err }
    if err = waitTransitionBackoff(ctx, transitionErr); err != nil { return err }
    if refreshErr := s.diff.RefreshSource(ctx); refreshErr != nil { ... }
    n, err = s.diff.ReadAt(ctx, dst, s.srcOff, s.ft)
}
if int64(n) != s.length { return io.ErrUnexpectedEOF }
```

- **P2P peer transition**:peer 在你读到一半时切到 storage,RefreshSource 拉新 header/CT,重试一次。
- `waitTransitionBackoff` honor 对方 `RetryAfter`(防止立刻 retry 把对方打爆)。

## 6. `File.Slice` —— 零拷贝快路径

```go
if length > 0 {
    h := b.Header()
    m, _ := h.GetShiftedMapping(ctx, off)
    if int64(m.Length) >= length {
        if m.BuildId == uuid.Nil && length <= len(header.EmptyHugePage) {
            return header.EmptyHugePage[:length], nil    // 整 huge page 的零
        }
        if m.BuildId != uuid.Nil {
            ft := h.GetBuildFrameData(m.BuildId)
            diff, _ := b.getBuild(ctx, m.BuildId)
            slice, _ := diff.Slice(ctx, int64(m.Offset), length, ft)
            if slice != nil { return slice, nil }       // 零拷贝
        }
    }
}
// fallback: read + 分配
out := make([]byte, length)
b.ReadAt(ctx, out, off)
return out, nil
```

- 零拷贝路径要求整个 range 落在单 build、单 mapping 内。
- uuid.Nil 段(空)用 `header.EmptyHugePage` 整页零 buffer 直接切。
- 失败 fallback `ReadAt`。

## 7. `File.IsCached` —— dedup 优化

```go
func (b *File) IsCached(ctx, off, length) bool
```

- 沿 mapping 走,每个非 nil BuildId 段:
  - 查 `b.store.Lookup(GetDiffStoreKey(buildID, b.fileType))`。
  - 类型断言 `block.CachePeeker.IsCached(ctx, mappedOffset, segLen)`。
- 全 true 才返 true(供 dedup.bestEffort 用)。

## 8. `File.createDiff` —— 创建/打开一个 build 的 diff

按 `h.Builds[buildID]` 是否存在分两路:

### 8.1 hasEntry

```go
size = bd.Size
initialCT = bd.FrameData.CompressionType()
```

**不**把 `bd.FrameData` 当作全 file 的 FT(它只覆盖了本 build 用到的 frame)。

### 8.2 无 entry 且 V4+

- 检查 `b.store.isActivePeer(buildID.String())`:
  - 若 peer 活跃 → 走 peer 路径(询问 size)。
  - 否则 → `refreshAncestorAndOpenUpstream`(主动拉 header)。

### 8.3 `refreshAncestorAndOpenUpstream`

1. 调 `refreshBuildHeader` 主动从 GCS 拉最新版 header。
2. 若 self-match → SwapHeader(本机缓存升级)。
3. V3 祖先(< MetadataVersionV4):无 Builds map → 当作 uncompressed。
4. V4 祖先:要求 header 一定有 self entry,否则报错;拿到 `SelfBuildData` 拿 size + FT,`openUpstream` 打开。

### 8.4 `openUpstream`

```go
path := storage.Paths{BuildID: ...}.DataFile(string(b.fileType), ct)
return b.persistence.OpenSeekable(ctx, path, objType)
```

按 `fileType` + `compressionType` 找正确的远端文件。

## 9. `DiffStore`

```go
type DiffStore struct {
    cache        *lru.Cache[string, Diff]
    cachePath    string
    flags        *featureflags.Client
    persistence  storage.StorageProvider
    blockMetrics blockmetrics.Metrics
    isActivePeer func(buildID string) bool
    mu           sync.Mutex
    inflight     singleflight.Group
    cleanupOnce  sync.Once
}
```

- LRU 缓存 Diff。
- `GetOrCreate(ctx, key, createFn)` 用 singleflight 防 thundering herd。
- `Lookup(key)` 单纯看是否在缓存。
- `Add(diff)` 把新产生的 diff 放进去。
- `RemoveCache()` 清空 LRU(冷启动 benchmark)。

## 10. 关键不变量

1. **`File.header` 用 atomic.Pointer**:并发 SwapHeader 不会撕裂读。
2. **per-read cache (栈数组 16)**:大 fragmented read 会饱和,但 LRU store 还是有效兜底。
3. **P2P transition 重试**最多一次:refresh 后再读一次,失败就放弃。
4. **V3 祖先路径**:`b.persistence` 走不带 `.com.gz` 后缀的路径;V4+ 按 `CompressionType` 拼后缀。
5. **header promption**:`refreshAncestorAndOpenUpstream` 拿到 self-match 时 `SwapHeader` —— 本机缓存升级,后续 read 不必再 refresh。

---

# 整体协作(模板、build、上传)

```
Pause 结束
  └─ template.Cache.AddSnapshot
        ├─ buildStore.Add(memfileDiff, rootfsDiff)
        └─ newTemplateFromStorage + put into cache  (异步 fetch)

下次 GetTemplate
  └─ cache hit → 拿 storageTemplate
       └─ 内部 File.ReadAt/Slice
            └─ File.planRead
                 └─ File.cachedBuild → DiffStore.GetOrCreate
                      └─ createDiff → newStorageDiff
                           └─ 读 ancestors (可能走 peer → waitTransitionBackoff → RefreshSource)
                           └─ storageDiff.ReadAt (chunker.fetch,见 block.md)

新 sandbox Resume 触发
  └─ Sandbox.ResumeSandbox(t template.Template, ...)
       └─ template.Rootfs() → File.planRead
       └─ template.Memfile() → File.planRead
       └─ template.Snapfile() → local file

跨 orchestrator
  └─ template.PeerToPeerChunkTransferFlag=true
       └─ persistence = peerclient.NewRoutingProvider(persistence, peers)
            └─ storage 内部 OpenSeekable → 走 P2P → fail/transition → fall back to GCS

同 orchestrator cross-build
  └─ Upload.runV4 → appendAncestorBuilds
       └─ Uploads.Wait(ctx, parentBuildID, fileType)
            ├─ 本地有 → future
            ├─ 本地无 + p2p 活跃 → 轮询 GCS + Redis sub
            └─ 本地无 + p2p 不活跃 → (nil, nil)
```
