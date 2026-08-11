# Artifact、存储与多级缓存深入解析

> 范围: `packages/shared/pkg/storage/`、`packages/shared/pkg/storage/header/`、`packages/orchestrator/pkg/sandbox/{template,build,block}/` 以及 orchestrator 的 storage 装配代码。
>
> 本文关注 sandbox 的 memfile/rootfs/snapfile 如何从本地 diff 变成可恢复 artifact，以及一次 guest block read 怎样在 mapping、P2P、NFS cache 和对象存储之间完成。

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
file:///var/lib/e2b/templates
file:relative/path
```

约束:

- `gs://` 与 `s3://` 只接受 bucket，不接受 key prefix。
- 未知 query 参数直接报错，避免拼写错误静默生效。
- URL 不接受 credentials；凭证来自 GCP ADC/Workload Identity 或 AWS 环境。
- S3-compatible endpoint 必须是绝对 `http(s)` URL。
- 本地 build-cache provider 会额外启动带 HMAC 的 signed-upload endpoint。

旧配置默认 provider 是 GCP。Local 模式下 template/build-cache 的默认目录分别是 `/tmp/templates` 和 `/tmp/build-cache`。

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

## 九、三层加速路径

权威对象存储之外，读取可能经过三类 cache。

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

排障时先判断失败发生在哪个地址空间:

1. virtual offset 是否映射正确？
2. build-local U-offset 是否正确？
3. U-space 到 C-space frame 是否正确？
4. source 是 NFS、peer、GCS/S3 还是 local FS？
5. body bytes 正确但解压/校验失败，还是根本没取到 bytes？

## 十三、源码阅读路线

1. `packages/shared/pkg/storage/paths.go`:先记住 artifact namespace。
2. `packages/shared/pkg/storage/header/header.go` 与 `mapping.go`:理解虚拟设备映射。
3. `serialization_v3.go`、`serialization_v4.go`、`serialization_v5.go`:理解兼容格式。
4. `compress_frame_table.go`:理解 U-space/C-space。
5. `packages/orchestrator/pkg/sandbox/build/build.go`:沿 `ReadAt` 看 segment planning。
6. `storage_diff.go` 与 `template/peerclient/`:比较 storage 和 peer source。
7. `storage_cache*.go`:看 NFS miss、writeback 与 lock。
8. `build_upload_v4.go` 与 `uploads.go`:看发布屏障和 parent dependency。

关键文件索引:

| 文件 | 关注点 |
| --- | --- |
| `packages/orchestrator/pkg/cfg/storage.go` | 两个 storage role 与 legacy fallback |
| `packages/shared/pkg/storage/storage_url.go` | URL parser 与安全校验 |
| `packages/shared/pkg/storage/storage_factory.go` | GCS/S3/Local provider factory |
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
