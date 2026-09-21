# Artifact、存储与多级缓存深入解析

> 范围: `packages/shared/pkg/storage/`、`packages/shared/pkg/storage/header/`、`packages/orchestrator/pkg/sandbox/{template,build,block}/` 以及 orchestrator 的 storage 装配代码。
>
> 本文关注 sandbox 的 memfile/rootfs/snapfile 如何从本地 diff 变成可恢复 artifact，以及一次 guest block read 怎样在 mapping、P2P、NFS cache 和对象存储之间完成。

## 零、2026.30 变动速览

这一版 `packages/shared/pkg/storage/` +1713/-124、`packages/orchestrator/pkg/sandbox/{template,build,block}/` 大幅变动（+32617/-1089）。与本文主题相关的有七件事：

| 变动 | 说明 | 详见 |
| --- | --- | --- |
| **新增 Azure Blob provider** | 第三种云后端：URL scheme `azblob://<container>`、provider 常量 `AzureBucket`、实现 `storage_azure.go`（640 行） | §三、§四 |
| **新增 provisional diff header** | pause 时立刻可用的**本地专用** header，绕过 dedup，让 resume 不必等 dedup 完成。**禁止上传** | §5.5 |
| **新增 deferred rootfs seal** | pause 可以在后台完成 rootfs 封存，前台先返回一个 `deferredDiff` 承诺 | §10.1 |
| **P2P chunk 大小修了一个真 bug** | 旧值 `storage.MemoryChunkSize`(4 MiB) **恰好等于 gRPC 默认接收上限**，加上 protobuf framing 就超限；改为固定 1 MiB | §9.3 |
| **`ValidateHeader` 被删除** | 校验职责收敛到 `Mapping.Validate`(`compact.go:206`) 与 `ValidateMappings`(`inspect.go:88`) | §5.2 |
| **新增内存故障恢复** | `block/fault.go` 的 `RunFaultSafe` 把 mmap 读错误导致的 **SIGBUS** 转成 `*MemoryFaultError`，而不是杀死进程 | §12 |
| **新增节点本地 envd 二进制缓存** | 第四层缓存：把 13 MB 的 gcsfuse 读从 resume 关键路径上搬走；miss 时**刻意不读源**，改为推迟一个周期 | §9.4 |

> ⚠️ **provisional header 和 `IncompletePendingUpload` 是两个不同的"未完成"状态，别混。**
> - `IncompletePendingUpload`：**已经 dedup**、mapping 正确，只是数据还没进对象存储。会随 finalized header 上传时被清除。
> - **provisional header（2026.30 新增）**：**没有 dedup**，所有 dirty page 都按 identity offset 归到一个临时 build ID 名下。它**只存在于本进程**，注释写得很直接："It must never be uploaded (the uploaded artifact always uses the deduped ToDiffHeader output)."
>
> 详见 §5.5。

> ⚠️ **2026.30 起"pause 完成"不再等于"rootfs 已经封存"。** `deferredDiff`（`build/deferred_diff.go`）让 pause 同步返回一个**承诺**：cache key 和 block size 立刻可知（`DiffStore.Add` 和上传的 compress-config 校验马上能跑），但每个带数据的方法都会阻塞在内层 promise 上直到后台封存完成。**`sealed()` 是不阻塞的**，cache eviction 用它来跳过尚未封存的 diff，而不是卡在数据方法上。

---

## 一、先建立正确的心智模型

E2B 的 rootfs 与内存快照不是每次都保存一个完整大文件。一个恢复后的虚拟设备通常由多个 build layer 拼成:

```text
虚拟设备偏移
  -> header.Mapping 找到来源 build 和 build-local U-offset
  -> header.Builds 找到该 build 的 size/checksum/FrameTable
  -> DiffStore 解析来源: local cache / peer / object storage
  -> FrameTable 把未压缩 U-space 映射到压缩 C-space
  -> range read
  -> 解压 frame
  -> 把正确字节交给 NBD/UFFD/Firecracker
```

因此，**header 不是普通 metadata sidecar，而是整个分层设备的寻址索引**。数据文件还在，但 header 丢失或损坏，快照仍然无法正确恢复。

相关阅读:

- [snapshots.md](./snapshots.md):Pause/Resume 与 snapshot 生命周期。
- [sandbox-lifecycle.md](./sandbox-lifecycle.md):NBD、UFFD、Firecracker 启动主链路。
- [template-build-flow.md](./template-build-flow.md):模板构建如何产出最终 artifact。
- [orchestrator-module.md](./orchestrator-module.md):orchestrator 服务整体装配。

## 二、Artifact 目录布局

`storage.Paths{BuildID: ...}` 统一生成远端 key。每个 build 使用独立前缀:

```text
{buildID}/
  memfile
  memfile.lz4 | memfile.zstd
  memfile.header
  rootfs.ext4
  rootfs.ext4.lz4 | rootfs.ext4.zstd
  rootfs.ext4.header
  snapfile
  metadata.json
```

| artifact | 读取方式 | 内容 |
| --- | --- | --- |
| `memfile[.codec]` | seekable/range | guest memory diff |
| `rootfs.ext4[.codec]` | seekable/range | root filesystem diff |
| `*.header` | whole blob | layer mapping、build metadata、frame table |
| `snapfile` | whole blob | Firecracker VM state |
| `metadata.json` | whole blob | 恢复 VM 所需模板/运行时 metadata |

`memfile` 与 `rootfs.ext4` 很大，核心接口是 `OpenRangeReader`；header、snapfile 和 metadata 较小，使用 `Blob.WriteTo` 整体读取。这个区别贯穿 cache、metrics 和 P2P protocol。

压缩后缀只出现在数据文件名上。V4/V5 header 自身的内部 block 虽然也用 LZ4 压缩，文件名仍然是 `.header`。

## 三、两个存储角色

Orchestrator 分别解析两个逻辑角色:

| 角色 | 首选配置 | 用途 |
| --- | --- | --- |
| template persistence | `TEMPLATE_STORAGE_URL` | 可启动/恢复的模板与 snapshot artifact |
| build-cache persistence | `BUILD_CACHE_STORAGE_URL` | template build 的中间 cache layer 与上传 |

两个角色可以指向不同 provider 或 bucket。URL 是该角色的权威配置；未设置时才把旧环境变量转换成等价 URL，再走同一个 parser。

支持的 URL:

```text
gs://bucket
s3://bucket?region=us-east-1
s3://bucket?endpoint=http://minio:9000&s3ForcePathStyle=true
azblob://container                      # ← 2026.30 新增
file:///var/lib/e2b/templates
file:relative/path
```

约束:

- `gs://`、`s3://` 与 `azblob://` 只接受 bucket/container，不接受 key prefix。
- 未知 query 参数直接报错，避免拼写错误静默生效。
- URL 不接受 credentials；凭证来自 GCP ADC/Workload Identity、AWS 环境，或 Azure 的 `AZURE_STORAGE_ACCOUNT_NAME` + managed identity/account key。
- S3-compatible endpoint 必须是绝对 `http(s)` URL。
- 本地 build-cache provider 会额外启动带 HMAC 的 signed-upload endpoint。

旧配置默认 provider 是 GCP。Local 模式下 template/build-cache 的默认目录分别是 `/tmp/templates` 和 `/tmp/build-cache`。

> ⚠️ **`azblob://` 是 2026.30 新增的第三种云后端**（`storage_url.go` 的 `AzureStorageProvider Provider = "AzureBucket"`，实现在 `storage_azure.go`，另有 402 行集成测试 + 222 行单元测试）。**scheme 名是 `azblob` 不是 `azure`**；错误信息也随之更新为 `(want gs, s3, azblob, or file)`。`Spec.Bucket` 字段的注释同时改了：对 `azblob://` 来说它是**container 名**。

## 四、StorageProvider 抽象

`packages/shared/pkg/storage/storage.go` 把 backend 收敛成三个能力:

```go
type StorageProvider interface {
    DeleteObjectsWithPrefix(ctx context.Context, prefix string) error
    UploadSignedURL(ctx context.Context, path string, ttl time.Duration) (string, error)
    OpenBlob(ctx context.Context, path string) (Blob, error)
    OpenSeekable(ctx context.Context, path string) (Seekable, error)
    GetDetails() string
}
```

四个 backend 由同一个 factory 收敛（`storage_factory.go:33` 的 `NewProvider`）：

| `spec.Provider` | 构造入口 | 配置来源 |
| --- | --- | --- |
| `LocalStorageProvider`（`"Local"`） | `newFileSystemStorage` | `file://` URL 的 `BasePath` |
| `AWSStorageProvider`（`"AWSBucket"`） | `newAWSStorage` | `s3://` URL + `region`/`endpoint`/`s3ForcePathStyle` |
| `GCPStorageProvider`（`"GCPBucket"`） | `NewGCP` | `gs://` URL |
| **`AzureStorageProvider`（`"AzureBucket"`）** | **`newAzureStorage(ctx, spec.Bucket, o.limiter)`** | **`azblob://` URL（2026.30 新增）** |

`Provider` 常量定义在 `storage_url.go:17-25`，默认值是 `GCPStorageProvider`。URL parser 在 `storage_url.go:79` 把 `azblob` scheme 映射到 `AzureStorageProvider`，失败时的错误文案是 `(want gs, s3, azblob, or file)`。

> ⚠️ **factory 只按 `spec.Provider` 分叉，不按云厂商分叉业务逻辑。** 这是 §五 的设计不变量：快照读写路径永远只认 `Blob`/`Seekable` 语义，Azure 分支的差异被关在 `storage_azure.go` 内部。
>
> ⚠️ **注意 `newAzureStorage` 的第三个参数与 AWS 不同。** AWS 传整个 `spec`（因为需要 `region`/`endpoint`），Azure 只传 `spec.Bucket`——Azure 的区域与凭据走环境（`AZURE_STORAGE_ACCOUNT_NAME` + managed identity/account key），不从 URL query 读。

### 4.1 Blob

适合整对象读写:

- `WriteTo`:流式写到 caller 的 writer。
- `Put`:上传内存中的 bytes。
- `Exists`:检查存在性。
- 可选 `MetadataReader`:只读 custom metadata，不下载 body。

### 4.2 Seekable

适合大数据文件:

- `OpenRangeReader(offset, length, frameTable)`:打开 progressive range stream。
- `StoreFile(localPath, options...)`:从本地文件上传，可压缩并计算 checksum。
- `Size`:返回逻辑未压缩大小。

`RangeReader.Close` 返回 `StoredBytes`、`DeliveredBytes`、source I/O 时间和解压时间，使“读了多少远端压缩字节、最终交付多少字节”可以分别观测。

## 五、Header 是怎样描述分层设备的

### 5.1 Metadata

Metadata 保存 header format version、虚拟文件 size、block size、generation、当前 build ID 与 base build ID 等基础信息。

### 5.2 Mapping

每个 mapping 表示:

```text
virtual [Offset, Offset+Length)
    -> BuildId
    -> build-local BuildStorageOffset
```

`uuid.Nil` 表示空洞，读取时直接 zero-fill，不访问 storage。相邻 mapping 可以来自不同 build，因此一次 `ReadAt` 可能被拆成多个 segment。

Mapping 在内存中使用紧凑列式结构，而不是保留 `[]BuildMap`。原因是长期缓存的 header 可能包含数百万个 page-granular entry，直接保留 Go struct 会显著放大 orchestrator heap。

### 5.3 Builds map

V4/V5 header 为每个仍被 mapping 引用的 build 保存:

| 字段 | 含义 |
| --- | --- |
| `Size` | 该 build data file 的未压缩大小 |
| `Checksum` | 未压缩数据 SHA-256；全零表示未知 |
| `FrameData` | 压缩 frame 的 U-space/C-space 索引；nil 表示未压缩/兼容路径 |

子 layer 只继承仍被 mapping 引用的 ancestor entry。已经完全被新 diff 覆盖的 ancestor 不需要继续携带。

### 5.4 IncompletePendingUpload

`ToDiffHeader` 生成的内存 header 会标记 `IncompletePendingUpload=true`，表示 mapping 已经能描述新 diff，但数据还没有进入对象存储。此时 reader 必须从本地 cache/peer 取 self layer，不能假设 frame table 已经存在。

这个 flag 不允许写入权威 storage。`StoreHeader` 遇到 incomplete header 会拒绝持久化；只有 P2P peer server 可以在上传期间暴露这类内存状态。

### 5.5 Provisional diff header（2026.30 新增）

`DiffMetadata.ToProvisionalDiffHeader`（`packages/shared/pkg/storage/header/metadata.go:108`）生成另一种"未完成"header，用途和 §5.4 完全不同：

```go
// ToProvisionalDiffHeader builds a local-only header that describes the memfd
// directly — all dirty pages attributed to buildID with identity storage
// offsets (see createIdentityMapping), composed over originalHeader. Unlike
// ToDiffHeader it needs no dedup metadata, so it is available at pause time and
// lets a resume serve immediately. It must never be uploaded (the uploaded
// artifact always uses the deduped ToDiffHeader output).
func (d *DiffMetadata) ToProvisionalDiffHeader(
	ctx context.Context,
	originalHeader *Header,
	buildID uuid.UUID,
) (*Header, error)
```

和 `ToDiffHeader` 的两个关键差异：

| | `ToDiffHeader` | `ToProvisionalDiffHeader` |
| --- | --- | --- |
| 需要 dedup 元数据 | 是 | **否** —— 所以 pause 时立刻可用 |
| offset 语义 | 紧凑排布（compacted） | **identity**：`BuildStorageOffset == Offset` |
| 能否上传 | 能（这是权威产物） | **绝对不能** |

**identity offset 是核心。** `createIdentityMapping`（`header/mapping.go:46`）把每个 dirty range 的 `BuildStorageOffset` 直接设成它的设备 `Offset`，而不是像 `CreateMapping` 那样紧凑打包。原因是这个 header 描述的是一个**仍然映射着的 memfd** —— 数据按绝对设备偏移寻址，根本不存在"紧凑的 diff artifact"。

调用点在 `packages/orchestrator/pkg/sandbox/sandbox.go:3192` 的 `buildProvisionalMemfile`：

```go
provisionalBuildID := uuid.New()
provisionalHeader, err := diffMetadata.ToProvisionalDiffHeader(ctx, originalHeader, provisionalBuildID)
// ...
provisionalSource := block.NewMemfdIdentitySource(dc, int64(originalHeader.Metadata.Size))
provisionalDiff, err := build.NewLocalDiffFromCache(build.GetDiffStoreKey(provisionalBuildID.String(), build.Memfile), provisionalSource)
```

> ⚠️ **临时 build ID 是"每次新建"的，这是竞态设计而非随意取值。** 函数注释："The provisional source is keyed by a fresh build id so a header swap to the deduped header (after dedup) is race-free"。dedup 完成后 `AddSnapshot` 的 swap goroutine 会把 deduped header 换进去，两个 header 必须能在 cache 里共存而不互相覆盖。

> ⚠️ **provisional 路径失败时不会拖慢 pause。** `buildProvisionalMemfile` 在 `enabled == false`、`originalMemfile == nil`、`originalHeader == nil`、`diffMetadata == nil`，以及 `ToProvisionalDiffHeader`/`NewLocalDiffFromCache` 任一出错时，都返回 `(nil, nil, nil)` 并调用 `dc.MarkSwapped()`，**回落到 deduped header**。注释："so it never blocks a pause"。

> ⚠️ **`MarkSwapped()` 在拒绝路径上也是必须调的。** 它的作用是让 `runDedup` 持有的 inflight memfd **在 drain 时释放**，而不必等满 swap grace。既然没有任何东西会从 memfd 提供服务，就没有理由继续持有它。

## 六、V3、V4、V5 格式

| 版本 | 主要能力 | mapping 编码 | 当前角色 |
| --- | --- | --- | --- |
| V3 | 未压缩 layer，只有 metadata + mappings | 固定宽度记录 | 读取兼容 |
| V4 | `Builds`、checksum、FrameTable，支持压缩或未压缩 data | 每项固定 40 bytes，整个 block LZ4 | 当前写入格式 |
| V5 | 与 V4 语义相同 | build-ID table + 四列 varint/delta，整个 block LZ4 | feature flag 控制的新写格式 |

V4/V5 framing 相同:

```text
[Metadata]
[uint8 flags]
[uint32 uncompressed block size]
[LZ4(Builds section + Mapping section)]
```

V5 只改变 mapping 的磁盘编码，不改变恢复语义。它把 UUID 每个 header 只存一次，并把 offset、length、storage offset 转成 page block 数和 varint/delta，因此对高度碎片化的 memfile header 通常远小于 V4。

保护上限:

- V4/V5 未压缩 inner block 最大 256 MiB，读写两侧都检查。
- V5 mapping entry 最大 `8 << 20`。
- FrameTable 最多约 100 万 frame，默认 2 MiB/frame 时覆盖约 2 TiB 未压缩空间。

读取 V3 ancestor 时没有 `Builds` map。反序列化兼容层会为缺失 build 写入空 `BuildData` sentinel，让后续路径明确把它当作未压缩数据，并在需要时调用 upstream `Size()`。

## 七、压缩与 FrameTable

默认 frame 的未压缩大小是 2 MiB，并要求能被 hugepage 与 rootfs block size 整除。

```text
U-space: |------- 2 MiB -------|------- 2 MiB -------|
            frame 0                  frame 1

C-space: |--- 0.6 MiB ---|----- 0.9 MiB -----|
          StartC/SizeC     StartC/SizeC
```

FrameTable 对每个 frame 保存 `StartU/SizeU/StartC/SizeC`。读某个未压缩 offset 时:

1. `LocateUncompressed` 找到包含它的完整 frame。
2. `LocateCompressed` 得到对象存储中的压缩 byte range。
3. backend 读取完整压缩 frame。
4. decoder 解压，再从 U-space frame 中截取 caller 需要的部分。

压缩粒度是性能权衡:

- frame 大:远端 round trip 少、顺序预热快，但随机 miss 多读更多字节。
- frame 小:随机读取精确，但 frame table 更大、请求更多。

`CompressConfig` 可以按 build/pause use case 和文件类型被 LaunchDarkly 覆盖。支持 LZ4 与 Zstd；zero value 表示禁用压缩。

## 八、一次 ReadAt 的完整路径

`build.File.ReadAt` 是理解恢复读取的最佳入口:

```text
Firecracker / UFFD / NBD
  -> block.Device.ReadAt
  -> build.File.ReadAt
       |- Header.GetShiftedMapping(virtual offset)
       |- 按连续 mapping 生成 read segments
       |- uuid.Nil segment: clear(dst)
       |- 非空 segment: DiffStore.Get(buildID)
       |- 可选并发读取多个 segment
       `- segment.Diff.ReadAt(build-local offset, FrameTable)
            |- local diff
            |- peer gRPC
            `- storage Seekable range read
```

每次调用有一个最多 16 项的局部 Diff cache，避免跨很多 mapping 时重复争用全局 TTL cache mutex。`MaxParallelBuildReadSegments` 大于 1 时，不同 segment 可以并发读取。

如果 plan 与实际读取之间 Diff 被 cache eviction 关闭，代码捕获 `CacheClosedError`，重新 plan 整次 read。因为 `ReadAt` 是幂等填充，已写过的目标区间可以安全覆盖。

## 九、四层加速路径

权威对象存储之外，读取可能经过四类 cache。前三类（§9.1–§9.3）服务于 artifact 字节本身；第四类（§9.4，2026.30 新增）服务于 **host 侧 envd 二进制**，把它的 13 MB gcsfuse 读从 resume 关键路径上搬走。

### 9.1 Orchestrator template/build cache

`template.Cache` 保存已经解析的 template、header 和 block device，`DiffStore` 再缓存各 build 的 `Diff`。这是进程内对象层，避免每次 sandbox create 都重新加载 header 与构造设备图。

它不是持久化层。进程退出或 entry eviction 后，数据必须能从 peer 或对象存储重建。

### 9.2 NFS/shared chunk cache

`storage.WrapInNFSCache` 包装权威 provider:

- blob 保存为本地 `content.bin`。
- 未压缩 seekable 默认按 4 MiB chunk 保存。
- 压缩 seekable 按 frame 的 C-space range 保存 `.frm` 文件。
- size 单独保存为 `size.txt`。
- 写入使用 file lock + atomic commit，多个 reader 对同一 miss 可去重。
- cache miss 先返回 inner stream，再异步 best-effort writeback。

prefetch 可通过 context 设置 `WithSkipCacheWriteback`，防止一次性预取污染共享 NFS cache。`EnableWriteThroughCacheFlag` 打开时，上传也会异步填充 cache；压缩 frame 写入并发受 feature flag 限制。

删除远端 prefix 时，本地 cache 删除在 detached goroutine 中执行，不阻塞权威删除响应。

### 9.3 Peer-to-peer

有 Redis 与可公开 node address 时，orchestrator 注册 build -> peer address。读取方按 build ID 查询 registry，并通过 `ChunkService` 从其他 orchestrator 流式读取:

- seekable: `GetBuildFileSize`、`ReadAtBuildSeekable`
- blob: `GetBuildFileExists`、`GetBuildBlob`

peer 只服务本机 template cache 中存在的 build。若 build 已上传完成，server 返回 `UseStorage`，client 将该 build 标记为 transitioned，并改走权威 storage。随后如果 reader 需要 V4/V5 frame table，会重新加载 finalized header。

Redis 查询失败、没有 peer、peer 是自己或 dial 失败时都回退到 base provider；P2P 是加速路径，不应成为数据唯一副本。

**2026.30 修了一个 chunk 大小的真 bug**（`template/peerserver/chunk.go`）：

```go
// sendChunkSize bounds the payload of a single Sender.Send call. gRPC applies
// its receive limit to the encoded message, so the payload has to leave room
// for the protobuf framing. Deliberately not storage.MemoryChunkSize, which
// equals the default limit exactly and so overflows once framed.
const sendChunkSize = 1 << 20 // 1 MiB
```

> ⚠️ **旧值 `storage.MemoryChunkSize` 恰好是 4 MiB，等于 gRPC 的默认接收上限。** 一个 4 MiB 的 payload 加上 protobuf framing 就超过 4 MiB，接收侧直接拒绝。也就是说 **2026.29 的 P2P 在传 4 MiB 边界大小的块时是会失败的** —— 注释里 "equals the default limit exactly and so overflows once framed" 说的就是这个。新值固定 1 MiB，留出 4 倍余量。

`sendChunked` 同时处理了一个边界情况：

```go
// An empty payload still produces one Send: a stream carrying no messages reads
// at the receiver as a peer miss rather than as an empty body.
```

也就是说**空 payload 也要发一条消息**，否则接收侧会把"零消息的流"解读为 peer miss，而不是"peer 有一个空对象"。

`chunkWriter` 被从 `file.go` 移到 `chunk.go`，改用同一个 `sendChunkSize` —— 这个改动顺带修掉了**磁盘流式源**（`fileSource.Stream`）上的同一个 bug。

### 9.4 节点本地 envd 二进制缓存（2026.30 新增）

第四层加速不在 artifact 路径上，但用的是同一套思路：**把昂贵的读从关键路径上搬走，而不是给关键路径加超时**。

`packages/orchestrator/pkg/sandbox/envdbin/` 缓存 host 侧 envd 二进制的节点本地副本。包注释把动机写得很清楚：

> resume-time envd upgrade 的路径**既不该 fork `envd -version`，也不该每次尝试都从 gcsfuse mount 上流 13 MB**。

| 符号 | 位置 | 语义 |
| --- | --- | --- |
| `Cache` | `cache.go:327` | 节点本地缓存；`NewCache(dir, probe)` |
| `Cache.Lookup(srcPath)` | `cache.go:523` | **最多两次 stat + 一次 map 读**，绝不读源字节 |
| `Cache.WarmAsync(ctx, srcPath)` | `cache.go:583` | 后台预热，miss 时触发 |
| `Entry` | `cache.go:305` | `SourcePath` / `LocalPath` / `Version` / `size` / `modTime` |
| `Outcome` | `cache.go:268` | `hit` / `copy` / `miss` / `stale` |
| `ErrNotCached` | `resolver.go:35` | **不是失败**：本次 resume 推迟升级，后台预热 |
| `Op` | `resolver.go:21` | `live`（resume 时热升级）/ `offline`（冷启动 rootfs 替换） |
| `maxEntries = 4` | `cache.go:95` | 上限刻意不可配置，目录永久封顶约 4 × 13 MB |

> ⚠️ **miss 时读源是被刻意禁止的，这不是疏忽。** 包注释：*"Deferring is the one thing the cache-off path never does, and it is deliberate: reading the source instead would put back the cost this package exists to remove, on a path a customer is waiting on."* 因为升级是幂等的、每次 resume 都重试，**推迟一次的代价就是一个周期**。
>
> ⚠️ **为什么不能靠超时兜底？** 注释给的理由很硬：*"a read already blocked in the kernel is not interruptible from userspace, so a deadline bounds a copy that is progressing slowly and not one that is stuck."* 超时只能约束"慢"，约束不了"卡死"——把拷贝移出关键路径是**消除这一类问题**，而不是给这类问题设上界。
>
> ⚠️ **cache key 是源的 identity（size + mtime），而 mtime 才是承重的那一半。** 因为两个 build 的二进制**长度可能完全相同**。源的 `/fc-envd/envd`（或旁边的 `envd.<sha>`）在只读 gcsfuse mount 上，promotion 是**原地覆盖**，所以路径永远不变，字节的 identity 只能从 stat 得来。
>
> ⚠️ **`/fc-envd` 是四个 mount 里唯一没有套共享 gcsfuse config 的那个**，而共享 config 把 `metadata-cache ttl-secs` 设成 `-1`（无限）。所以这里用的是 gcsfuse 的有界默认值，promotion 在该 TTL 内可见、**不是立刻**。这个延迟是良性的：窗口内的 resume 会解析到 promotion 前的二进制并按 `same_version` 跳过升级，下一次 resume 就拿到新的。
>
> ⚠️ **依赖红线**：如果哪天把 `/fc-envd` 也归并到共享 config 上，stat 将**永远观测不到 promotion**，这个缓存会无限期地供给 promotion 前的二进制。**不要把它指向配置了无限 metadata TTL 的 mount。**

几个容易看错的语义：

- **`ErrNotCached` 与 `getversion_failed` 必须分开。** 后者是"目标读不到"，属于该追的配置错误；前者是"节点还没预热"，属于缓存按设计工作。混在一起，真实配置错误会在每台新启动的节点上被"预期状态"淹没（`resolver.go:57` 的 `GatedReason` 就是为此存在）。
- **推迟与拒绝共用一个词汇表**（`ReasonNotCached` / `ReasonCopyVanished`）：对运维来说两者是同一个事件——"这次 resume 没升级，原因是这个"。live 路径上报到 gated series 而不是 `upgrade.attempts`，因为**没有任何东西到达 guest**。
- **"哪一半原因让副本消失"被刻意不区分**（被 `maxEntries` 淘汰 vs. 被看到 promotion 的预热替换）：调用方的处境完全相同，区分开反而暗示其中一个需要处置。
- **预热失败会进 backoff**（`errWarmSuppressed`、`pathBackoff`），且**唯一不触发预热的 miss 是它自己的源 stat 失败的那次**——因为预热开头就要重新 stat，把失败报在原地即可。

## 十、上传与发布顺序

当前 `NewUpload` 默认使用 V4 header；`HeaderV5WriteFlag` 打开时写 V5。V3 保留为兼容实现。

V4/V5 upload 对 memfile、rootfs、snapfile、metadata 并发执行，但每个 seekable artifact 内部保持关键顺序:

```text
local diff file
  -> StoreFile / optional compression / SHA-256
  -> obtain FullFrameTable + size + checksum
  -> wait for every referenced ancestor upload/header
  -> clone diff header as V4/V5
  -> fill/refresh Builds entries
  -> clear IncompletePendingUpload
  -> upload *.header
  -> atomically swap finalized header into local cached device
```

**数据文件先于 header 发布。** header 是“这个 layer 已经可从 storage 恢复”的提交标记。如果先上传 header，其他 orchestrator 可能立即读取它，却找不到数据 body 或 ancestor frame table。

### 10.1 Deferred rootfs seal（2026.30 新增）

`build/deferred_diff.go` 引入 `deferredDiff`，让 **pause 的 rootfs 封存可以异步完成**：

```go
// deferredDiff is a Diff whose backing data is produced asynchronously. It is
// returned synchronously from a pause that seals the rootfs in the background:
// the cache key and block size are known up front (so DiffStore.Add and the
// upload's compress-config validation work immediately), while every data-
// bearing method blocks on the inner promise until the background seal resolves
// the real Diff.
```

| 方法 | 行为 |
| --- | --- |
| `CacheKey()`、`BlockSize()` | **同步返回**，不阻塞 |
| `sealed()` | **不阻塞**，只查 promise 是否已 resolve |
| `CachePath`、`ReadAt`、`Slice`、`Size`、`FileSize` | 阻塞在 `inner.WaitWithContext(ctx)` 上 |
| `Close()` | 等 promise；**只有成功时才关**内层 diff |

> ⚠️ **生产者必须无条件 resolve 这个 promise。** 注释原话："The producer MUST always resolve the promise — with the sealed Diff on success or an error on failure — otherwise the data methods (and Close) block forever." 这是整个设计里唯一的硬约束。

> ⚠️ **封存失败是终态，重试没有意义。** `ErrDeferredSealFailed`（`deferred_diff.go:16`）标记一个**只跑一次**的后台封存失败：promise 带着这个错误永久 settle，之后每个带数据的方法都返回它。pause 上传的重试循环**匹配这个错误来提前停止重试**，而不是把整个重试预算浪费在一个永远不会成功的 diff 上。注释："rather than burning the whole retry budget on it"。

> ⚠️ **`sealed()` 的存在是为了 cache eviction 的正确性。** 没有它，eviction 只有两个坏选择：调用数据方法（会**阻塞在封存上**），或者**逐出一个刚创建、还在飞行中的快照**。所以注释写的是 "skip a not-yet-sealed diff"。

> ⚠️ **`Close()` 在失败路径上不关内层 diff**，因为失败时生产者已经清理了部分文件：`deferredDiff.Close` 只在 `Wait()` 返回 nil error 时才调 `inner.Close()`。

跨 orchestrator 的 parent/child upload 通过两种机制协调:

- 本机 `Uploads` future，TTL 3 小时。
- Redis `orchestrator.upload.done.{buildID}` pub/sub 提示 + storage polling；Redis 缺失时退化为纯 polling。

远端 header 等待预算 2 小时，与 server 的完整 upload retry budget 对齐，避免 child 在 parent 仍重试时过早把 not-found 当终态。

## 十一、Object Metadata 与软删除

上传对象会携带可索引 metadata:

| key | 含义 |
| --- | --- |
| `team_id` | artifact owner team |
| `template_id` | template identity |
| `build_origin` | `pause`、`template_build`、`template_build_cache`、`snapshot_template` |
| `uncompressed-size` | 压缩对象的逻辑大小 |
| `logical-size` | 虚拟设备大小 |
| `mapped-size` | mapping 指向非空 build 的总 bytes |
| `diff-size` | 当前 build 自己贡献的 bytes |

storage index 可后写 `storage-index-soft-deleted=<reason>:<action_id>` tombstone。`StorageDiff` 的检查有两阶段 feature flag:

1. `StorageSoftDeleteCheckFlag`:后台读取 data object metadata，只记录与告警，不增加首个 read 的同步延迟。
2. `StorageSoftDeleteEnforceFlag`:命中 tombstone 后让后续 read 返回 `ErrObjectSoftDeleted`。

如果 backend 不支持 custom metadata，check-only 模式告警并继续；enforce 模式 fail closed。检查结果绑定具体 active data path，peer transition 换成新 path 后，旧 tombstone 不会错误阻断新来源。

## 十二、常见失败与排查顺序

| 症状 | 优先排查 |
| --- | --- |
| header 存在但恢复报 object not found | 数据 body 是否先于 header 成功上传，压缩后缀是否匹配 FrameTable |
| 某个 offset 数据错误 | `Mapping.BuildStorageOffset`、segment 边界、frame U/C offset |
| 只在长 diff chain 失败 | ancestor `Builds` entry 是否存在，V3 sentinel/Size fallback 是否工作 |
| P2P 读取中途失败 | peer 是否已返回 `UseStorage`，client 是否重载 finalized header |
| NFS cache 命中率低 | cache root、4 MiB chunk 对齐、prefetch 是否设置 skip writeback |
| cache 文件偶发损坏 | atomic commit/file lock 错误，是否缓存了 short read |
| 压缩后随机读放大 | frame size 是否过大，FrameTable 是否 sparse-trimmed |
| snapshot 被拒绝读取 | soft-delete marker、check/enforce flag、backend metadata 能力 |
| Local build upload URL 失败 | `LOCAL_UPLOAD_BASE_URL`、HMAC handler 与 build-cache base path |
| **（2026.30）P2P 传大块时流被拒** | `sendChunkSize` 是否为 1 MiB（2026.29 的 4 MiB 恰好撞上 gRPC 上限） |
| **（2026.30）pause 成功但 resume 读不到 rootfs** | 后台 seal 是否 resolve 了 promise；`ErrDeferredSealFailed` 是否已永久 settle |
| **（2026.30）resume 立刻可服务但读到的数据与 dedup 后不一致** | 是否把 provisional header 当成了权威产物；它**只应存在于本进程** |
| **（2026.30）resume 报 `binary_not_cached` / `copy_vanished`** | 这是 deferral 不是故障：节点未预热，或承载该版本的副本已被 `maxEntries` 淘汰/被 promotion 替换（§9.4） |
| **（2026.30）orchestrator 日志出现 `memory fault`** | **本地磁盘在 cache 下正在坏**。`RunFaultSafe` 把它从"进程被 SIGBUS 杀死"降级为"单次 read 失败"，但根因是硬件 |

> ⚠️ **`memory fault` 不是软件 bug，是硬件信号。** `block/fault.go` 的注释解释了成因：mmap 文件下出现不可恢复的读错误（坏扇区）时，**内核无法对内存访问返回 EIO，只能投递 SIGBUS**。`RunFaultSafe` 用 `debug.SetPanicOnFault(true)` 把这种 panic 转成 `*MemoryFaultError`，于是：
>
> - `build.File.readSegmentFaultSafe`（`build.go:258`）让**一次 read 失败，而不是整个进程死掉**，日志里带 `diff_cache_key`、`fault_addr`、`offset`、`length`；
> - `block/cache.go:382` 的 dedup 比较阶段同样包了一层，日志写 "memory fault comparing pages during dedup"。
>
> 两个调用点的日志文案都指向同一个结论：**"local disk under the cache is likely failing"**。指标 `orchestrator.block.memory_fault` 的描述是 "healthy steady state is zero" —— 非零就该去查盘。
>
> ⚠️ **只有带 `Addr()` 的 `runtime.Error` 才被当作 fault。** 其它 panic 一律 `panic(r)` 原样抛出，避免把真实 bug 静默成"磁盘问题"。

排障时先判断失败发生在哪个地址空间:

1. virtual offset 是否映射正确？
2. build-local U-offset 是否正确？
3. U-space 到 C-space frame 是否正确？
4. source 是 NFS、peer、GCS/S3 还是 local FS？
5. body bytes 正确但解压/校验失败，还是根本没取到 bytes？

## 十三、源码阅读路线

1. `packages/shared/pkg/storage/paths.go`:先记住 artifact namespace。
2. `packages/shared/pkg/storage/header/header.go` 与 `mapping.go`:理解虚拟设备映射。**`mapping.go:46` 的 `createIdentityMapping` 是 2026.30 新增的对照实现**——把 `CreateMapping`（紧凑）和它（identity）并排看，能一次看懂 `BuildStorageOffset` 到底是什么。
3. `serialization_v3.go`、`serialization_v4.go`、`serialization_v5.go`:理解兼容格式。
4. `compress_frame_table.go`:理解 U-space/C-space。
5. `packages/orchestrator/pkg/sandbox/build/build.go`:沿 `ReadAt` 看 segment planning。**`readSegmentFaultSafe`(`:258`) 是 2026.30 新增的故障边界**。
6. `storage_diff.go` 与 `template/peerclient/`:比较 storage 和 peer source。
7. `storage_cache*.go`:看 NFS miss、writeback 与 lock。
8. `build_upload_v4.go` 与 `uploads.go`:看发布屏障和 parent dependency。
9. **（2026.30 新增）`packages/orchestrator/pkg/sandbox/build/deferred_diff.go`**:看 pause 的异步封存承诺。
10. **（2026.30 新增）`packages/shared/pkg/storage/header/metadata.go:102` 的 `ToProvisionalDiffHeader`**:看"绕过 dedup 的本地 header"如何构造。
11. **（2026.30 新增）`packages/orchestrator/pkg/sandbox/envdbin/cache.go` 的包注释**:读懂"把拷贝移出关键路径而不是给它设超时"这个论证，再回头看 §9.1–§9.3 的三层缓存，会发现它们共享同一个设计取向。

关键文件索引:

| 文件 | 关注点 |
| --- | --- |
| `packages/orchestrator/pkg/cfg/storage.go` | 两个 storage role 与 legacy fallback |
| `packages/shared/pkg/storage/storage_url.go` | URL parser 与安全校验 |
| `packages/shared/pkg/storage/storage_factory.go` | GCS/S3/**Azure**/Local provider factory |
| `packages/shared/pkg/storage/storage_azure.go` | **2026.30 新增**：Azure Blob provider（640 行） |
| `packages/orchestrator/pkg/sandbox/build/deferred_diff.go` | **2026.30 新增**：pause 的异步 rootfs 封存承诺 |
| `packages/orchestrator/pkg/sandbox/block/fault.go` | **2026.30 新增**：SIGBUS → `MemoryFaultError` |
| `packages/orchestrator/pkg/sandbox/template/peerserver/chunk.go` | **2026.30 新增**：P2P 的 1 MiB chunk 边界 |
| `packages/orchestrator/pkg/sandbox/envdbin/cache.go` | **2026.30 新增**：节点本地 envd 二进制缓存（§9.4） |
| `packages/orchestrator/pkg/sandbox/envdbin/resolver.go` | **2026.30 新增**：`ErrNotCached` 与 deferral 词汇表 |
| `packages/shared/pkg/storage/storage.go` | Blob/Seekable/RangeReader contract |
| `packages/shared/pkg/storage/header/header.go` | Header、BuildData、incomplete 状态 |
| `packages/shared/pkg/storage/header/serialization_v5.go` | V5 列式 varint mapping |
| `packages/shared/pkg/storage/storage_cache.go` | NFS wrapper 与删除/writeback 策略 |
| `packages/orchestrator/pkg/sandbox/build/build.go` | 分层设备读取算法 |
| `packages/orchestrator/pkg/sandbox/template/peerclient/` | P2P resolver 与 storage fallback |
| `packages/orchestrator/pkg/sandbox/build_upload_v4.go` | data/header 上传提交顺序 |
| `packages/orchestrator/pkg/sandbox/uploads.go` | 同机 future 与跨机 Redis 通知 |
| `packages/orchestrator/pkg/sandbox/build/softdelete.go` | tombstone check/enforce |

## 十四、掌握程度自检

1. 为什么 header 存在不等于 snapshot 已经完整提交？
2. `Mapping.Offset` 与 `BuildStorageOffset` 分别属于哪个地址空间？
3. 为什么压缩 range read 必须拿完整 frame，而不是只取 caller 请求的 bytes？
4. V5 相比 V4 改了什么，又刻意没有改什么？
5. 为什么 P2P 返回 `UseStorage` 后必须重载 header？
6. 为什么 prefetch 默认可以跳过 NFS writeback？
7. soft-delete enforce 为什么对不支持 metadata 的 backend fail closed？
8. **（2026.30）** provisional header 与 `IncompletePendingUpload` 分别代表哪种"未完成"？为什么前者绝不能上传？
9. **（2026.30）** `createIdentityMapping` 为什么把 `BuildStorageOffset` 设成等于 `Offset`，而不是像 `CreateMapping` 那样紧凑打包？
10. **（2026.30）** P2P 的 chunk 上限为什么**故意不用** `storage.MemoryChunkSize`？
11. **（2026.30）** `deferredDiff.sealed()` 为什么必须是非阻塞的？如果它改成调用 `Size()` 会发生什么？
12. **（2026.30）** 为什么 mmap 下的坏扇区表现为 SIGBUS 而不是 EIO，`RunFaultSafe` 又为什么只接管带 `Addr()` 的 panic？
13. **（2026.30）** envd 二进制缓存在 miss 时为什么**不读源**、而选择把升级推迟一个周期？
14. **（2026.30）** 为什么"给拷贝加超时"解决不了这个问题，而"把拷贝移出关键路径"可以？
15. **（2026.30）** `ErrNotCached` 与 `getversion_failed` 如果合成一个指标，会在什么样的节点上产生误导？

---

> **版本说明**：已同步至 **2026.30**。§零 汇总本版全部变动；§三/§四 补入 Azure Blob provider；§5.5、§9.3、§10.1 为 2026.30 新增小节；§十二 增加四条排障项与 `memory fault` 的硬件含义；§9.4 记录节点本地 envd 二进制缓存；§十三/§十四 补入新文件与自检题。所有路径与行号均以 tag `2026.30` 为准。
