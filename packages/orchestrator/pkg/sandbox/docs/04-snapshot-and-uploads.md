# 04. `snapshot.go` / `build_upload*.go` / `uploads.go` / `snapshot_metrics.go`

> 路径: `packages/orchestrator/pkg/sandbox/`
> 职责: Pause 产物管理 + 把 memfile/rootfs/snap/meta 上传到 GCS + 跨 orch 等待(Redis pub/sub) + 快照相关指标。

---

## 1. `snapshot.go` — `Snapshot` 数据结构

```go
type DiffHeader = utils.SetOnce[*header.Header]   // 类型别名

func NewResolvedDiffHeader(h *header.Header) *DiffHeader {
    d := utils.NewSetOnce[*header.Header]()
    _ = d.SetValue(h)
    return d
}

type Snapshot struct {
    MemfileDiff       build.Diff
    MemfileDiffHeader *DiffHeader        // 大部分路径同步;memfd-dedup 异步
    RootfsDiff        build.Diff
    RootfsDiffHeader  *DiffHeader
    Snapfile          template.File
    Metafile          template.File
    BuildID           uuid.UUID
    SchedulingMetadata *orchestrator.SchedulingMetadata
    MemfileBlockSize  uint64             // 同步缓存,用于 NewUpload 校验
    RootfsBlockSize   uint64
    cleanup *Cleanup
}
func (s *Snapshot) Close(ctx) error
```

要点:
- `DiffHeader` 是 `*utils.SetOnce`,既能同步设值,也能异步等 —— memfd-dedup 路径是典型异步。
- `MemfileBlockSize` / `RootfsBlockSize` 在 `Pause` 时同步捕获,`NewUpload` 的 `validateCompressConfig` 用它校验 frame size 整除性。
- `Close` 调 `cleanup.Run` —— Pause 阶段创建的临时文件(snapfile、metadataFileLink、memfileDiff、rootfsDiff)在这里释放。

---

## 2. `build_upload.go` — V3 / V4 路由与公共逻辑

### 2.1 `Upload` 结构

```go
type Upload struct {
    buildID        uuid.UUID
    snap           *Snapshot
    paths          storage.Paths
    uploads        *Uploads                  // nil 表示单机上传
    store          storage.StorageProvider
    mem, root      storage.CompressConfig
    useCase        string
    objectMetadata storage.ObjectMetadata
    future         *utils.ErrorOnce          // 上传完成的 future
    useV4          bool                      // 是否走 V4 路径
    headerVersion  uint64                    // 写入的 header version (V4 / V5)
}
```

### 2.2 `NewUpload` 决定走 V3 还是 V4

```go
mem, memV4, err := resolveCompressConfig(ctx, cfg, ff, storage.MemfileName, snap.MemfileBlockSize, useCase)
root, rootV4, err := resolveCompressConfig(ctx, cfg, ff, storage.RootfsName, snap.RootfsBlockSize, useCase)
...
headerVersion := uint64(headers.MetadataVersionV4)
if ff != nil && ff.BoolFlag(ctx, featureflags.HeaderV5WriteFlag) {
    headerVersion = headers.MetadataVersionV5
}
useV4 := memV4 || rootV4 || headerVersion == headers.MetadataVersionV5
```

- `useV4` 在以下情况为真:
  1. 任意文件启用 V4 header(用于未压缩上传)
  2. 写 V5 header
  3. 任意文件启用压缩

### 2.3 `Run` 入口

```go
func (u *Upload) Run(ctx) error {
    ctx = featureflags.AddToContext(ctx, featureflags.CompressUseCaseContext(u.useCase))
    if !u.mem.IsCompressionEnabled() && !u.root.IsCompressionEnabled() && !u.useV4 {
        return u.runV3(ctx)        // V3:不压缩 + V3 header
    }
    return u.runV4(ctx)            // V4:压缩 / V4 header
}
```

### 2.4 `resolveCompressConfig` 详细

```go
func resolveCompressConfig(ctx, base, ff, fileType, blockSize, useCase) (CompressConfig, bool, error)
```

返回 `(cfg, useV4, err)`:
- `base` 是默认配置(由 API 或 cmdline 传入)。
- 如果 LD `CompressConfigFlag` 配 `compressBuilds=true` 且 type 非 none,则覆盖。
- `useV4` 来自 `V4HeaderForUncompressedFlag`。
- `blockSize` 用于 `validateCompressConfig`:**FrameSize 必须整除 blockSize**,否则 chunker 的 frame fetch 会让 tail 读到未初始化 mmap。

### 2.5 `Finish` 与 publish

```go
func (u *Upload) Finish(ctx, uploadErr error) {
    if u.future != nil { _ = u.future.SetError(uploadErr) }
    if u.uploads != nil { u.uploads.publishUploadDoneToRedis(ctx, u.buildID, uploadErr) }
}
```

`Finish` 在上传链路收尾(成功或失败)时调用,广播给所有等此 build 的同 orchestrator 和跨 orch 协程。

### 2.6 `publish` —— 替换本地缓存的 header

```go
func (u *Upload) publish(ctx, t build.DiffType, h *headers.Header) error
```

`Uploads.find` 在 `buildStore` 里找本地缓存的 diff,把它的 header `SwapHeader` 成最终版(从 storage 写回后)。`ErrBuildNotInCache` 视为"无需 publish"。

---

## 3. `build_upload_v3.go` — V3 路径

```go
func (u *Upload) runV3(ctx) error
```

并发上传 6 个文件:

| 任务 | 文件 | 备注 |
|------|------|------|
| memfile header | `u.paths.MemfileHeader()` | `finalizeV3(h)` 清掉 `IncompletePendingUpload` |
| rootfs header | `u.paths.RootfsHeader()` | 同上 |
| memfile 主体 | `u.paths.Memfile()` | 不压缩(`storage.UploadFramed` 的 framing 是历史兼容) |
| rootfs 主体 | `u.paths.Rootfs()` | 同上 |
| snapfile | `u.paths.Snapfile()` | 普通 blob 上传 |
| metafile | `u.paths.Metadata()` | 普通 blob 上传 |

- 全部 errgroup 跑,任一失败全 cancel。
- 主任务 `Wait` 后做 ancestor builds 拼装(`appendAncestorBuilds` 传 nil,V3 不写 Builds map),再 `publish` 把 header 写到本地缓存。
- `finalizeV3` 做浅拷贝,清 `IncompletePendingUpload` 标志。

---

## 4. `build_upload_v4.go` — V4 路径

```go
func (u *Upload) runV4(ctx) error
```

并发 4 个任务(用 errgroup):
1. memfile framed + 自身 Builds 写入(见下)
2. rootfs framed + 自身 Builds 写入
3. snapfile blob
4. metafile blob

### 4.1 `uploadFramed` 详解

```go
func (u *Upload) uploadFramed(ctx, fileType, srcPath, srcHeader, cfg) error
```

流程:
1. **upload body**:`storage.UploadFramed(..., seekableTypeFor(fileType), srcPath, WithCompressConfig(cfg), WithChecksumSHA256())`,得到 `fullFT`(frame table)和 sha256。
2. **指标**:`recordUploadCompression` 记录压缩前后字节 + 压缩比。
3. **构造 selfBuild**:`{Size, Checksum, FrameData: ft}`。
4. **构造目标 header**:`h := srcHeader.CloneForUpload(u.headerVersion)`,清 `IncompletePendingUpload`,初始化 `Builds` map。
5. **拼祖先 builds**:`appendAncestorBuilds`:
   ```go
   for _, buildID := range mappings.Builds() {
       if buildID == u.buildID || buildID == uuid.Nil { continue }
       h, err := u.uploads.Wait(ctx, buildID, fileType)
       if h == nil || dst == nil { continue }       // V3 caller pass nil
       if bd, ok := h.Builds[buildID]; ok {
           dst[buildID] = bd                          // 覆盖(Wait 更权威)
       }
   }
   ```
   - 关键:等待所有**不同**的祖先 build 完成(用 Uploads 的 Redis pub/sub 协调跨 orch)。
   - 单飞:同 buildID 只等一次(Mapping.Builds 已 dedup)。
6. **写入本 build**:`h.Builds[u.buildID] = selfBuild`。
7. **存 header**:`storeHeaderWithMetrics(..., u.paths.HeaderFile(...), ...)`。
8. **publish**:`u.publish(ctx, fileType, h)` 把 header swap 到本地 cache。

### 4.2 `seekableTypeFor`

```go
func seekableTypeFor(fileType build.DiffType) storage.SeekableObjectType
```

简单 switch 把 `build.Memfile` / `build.Rootfs` 映射到 `storage.MemfileObjectType` / `storage.RootFSObjectType`,其他 `UnknownSeekableObjectType`。

---

## 5. `uploads.go` — 跨 orchestrator 等待

### 5.1 数据结构

```go
type Uploads struct {
    tc          templateLookup              // *template.Cache
    persistence storage.StorageProvider
    p2p         peerclient.Resolver
    redis       redis.UniversalClient       // 可为 nil
    futures     *ttlcache.Cache[uuid.UUID, *utils.ErrorOnce]
}

var (
    errUploadInFlight  = errors.New("upload already in flight for build")
    ErrBuildNotInCache = errors.New("build not in template cache")
)

const (
    futureTTL              = 1 * time.Hour
    refreshHeaderBudget    = 20 * time.Minute
    uploadDoneChannelPrefix = "orchestrator.upload.done."   // + buildID
)
```

### 5.2 `Start(buildID)`

```go
func (u *Uploads) Start(buildID uuid.UUID) (*utils.ErrorOnce, error)
```

- 若同 buildID 已有未完成的 future → `errUploadInFlight`(防御性,正常不会发生)。
- 否则替换为新的 future,返回供 `Upload.future` 用。

### 5.3 `Wait(buildID, fileType)`

```go
func (u *Uploads) Wait(ctx, buildID, t) (*header.Header, error)
```

返回值语义:
- `(h, nil)` — 父 build 完成的 post-upload header。
- `(nil, nil)` — 父从未在本机缓存、也无人正在上传,调用方已自带 `BuildData`。

执行逻辑:
1. `find(ctx, buildID, t)` 查本地 template cache。
2. 若本地 future 存在且 fire → 等到 fire,返回 `d.Header()`(本地缓存已被 publish 替换过)。
3. 若本地有但 `!IncompletePendingUpload` → 已经是 finalized header,直接返回。
4. 若本地无 且 `!p2p.IsActive(buildID)` → `return nil, nil`(无人在传)。
5. **P2P mid-upload**:调 `build.PollRemoteStorageForHeader` 轮询 storage(用 Redis `subscribe` 提前唤醒)。

### 5.4 Redis pub/sub 协调

- `publishUploadDoneToRedis(ctx, buildID, uploadErr)` — `Upload.Finish` 末尾调,空 payload 成功,非空是错误信息。
- `subscribe(ctx, buildID) <-chan error` — 每调用都新开一个 SUBSCRIBE goroutine,ctx 取消时关闭;若 redis == nil 返回 nil channel(ticker 退化成唯一信号源)。

### 5.5 错误恢复层级

```
Wait 调用方
  ├─ find → 本地有 cache → 取 d.Header()
  ├─ futures 存在 → 等 future(本地正在上传)
  ├─ P2P active → 轮询 storage + Redis sub
  └─ 都没 → (nil, nil),调用方自行处理
```

---

## 6. `snapshot_metrics.go` — Pause 指标

### 6.1 直方图

```go
var (
    snapshotDiffBytes  = ...  // 字节数
    snapshotDiffRatio  = ...  // 比例 [0,1],{1} 单位
    snapshotTotalBytes = ...  // 原文件总字节
)
```

### 6.2 `recordSnapshotDiff`

```go
func recordSnapshotDiff(ctx, fileType, dm *header.DiffMetadata, original *header.Header)
```

记录:
- `snapshotTotalBytes{file_type}`:原文件大小。
- `snapshotDiffBytes{file_type, kind}`:kind ∈ {dirty, empty},按 block×count 计字节。
- `snapshotDiffRatio{file_type, kind}`:`ratio = bytes / totalBytes`,clamp 到 [0,1]。

### 6.3 `recordSnapshotDedup`

```go
func recordSnapshotDedup(ctx, fileType, pre, post *header.DiffMetadata, bestEffort bool)
```

记录 dedup 节省的字节和比例。`kind` 三种:
- `none`:post == nil(没跑 dedup)。
- `dedup`:跑了。
- `best_effort_dedup`:跑了且 bestEffort 模式。

`savings = max(pre - post, 0)`,注意 `pre` block size 可能与 `post` 不同(memfd dedup 输出 PageSize)。

---

## 7. `snapshot.go` 的 cleanup

`Snapshot.Close`:
- 调 `cleanup.Run` 释放 Pause 阶段注册的资源。

注意:正常情况下 `Upload.Run` 之后会用新的 cache paths 替换临时 `LocalFileLink`,旧文件由 cleanup 删。

---

## 8. 整体时序:从 Pause 到 upload 完成

```
Sandbox.Pause(meta, useCase)
  ├─ 准备临时 cache paths
  ├─ bestEffortReclaim
  ├─ process.Pause
  ├─ process.CreateSnapshot
  ├─ memory.DiffMetadata / rootfs.ExportDiff
  ├─ pauseProcessMemory (memfd → cache + dedup goroutine)
  ├─ pauseProcessRootfs (overlay → cache)
  ├─ 计算 SchedulingMetadata
  ├─ 写 metadata.json
  └─ return *Snapshot

            (上层,通常在 BuildSnapshot API handler)
                  ↓
            build.NewUpload (resolveCompressConfig)
            upload.Start (注册 future)
                  ↓
            Upload.Run → runV3 or runV4
            ├─ storage 上传 (body + header)
            ├─ 调 Uploads.Wait 等所有祖先
            └─ publish (swap 本地 cache)
                  ↓
            Upload.Finish (SetError + Redis publish)
                  ↓
            其他 orchestrator / 协程的 Wait 醒来
```

---

## 9. 关键不变量

- **BuildID 唯一**:`uuid.NewString()` 在 Pause 入口产生,保证不会出现 upload 冲突。
- **Builds map 是 sparse**:`appendAncestorBuilds` 只 push 父链里出现的 buildID,`uuid.Nil` 跳过。
- **`IncompletePendingUpload` 在 finalizeV3 / uploadFramed 末尾清掉**,保证其他 orchestrator 看到的就是最终版。
- **跨 orch 通过 Redis `orchestrator.upload.done.<buildID>` 频道** —— 频道数 ≈ 同时在传的 build 数(不是 sandbox 数),不会成为热点。
