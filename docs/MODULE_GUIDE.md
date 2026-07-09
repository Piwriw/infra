# Envd 模块详细指南

> Envd（Environment Daemon）是运行在每个 Firecracker microVM 内部的守护进程，向沙箱外部暴露进程管理与文件系统操作的 RPC/HTTP API。它是 E2B 平台中沙箱与外部世界交互的核心桥梁——用户的代码执行、文件读写、环境配置全部通过 envd 完成。

---

## 目录

- [1. 概述与架构定位](#1-概述与架构定位)
- [2. 入口与启动 (main.go)](#2-入口与启动-maingo)
- [3. REST API 层 (internal/api)](#3-rest-api-层-internalapi)
  - [3.1 API 核心结构 (store.go)](#31-api-核心结构-storego)
  - [3.2 Init/Freeze/Unfreeze (init.go)](#32-initfreezeunfreeze-initgo)
  - [3.3 文件上传 (upload.go)](#33-文件上传-uploadgo)
  - [3.4 文件下载 (download.go)](#34-文件下载-downloadgo)
  - [3.5 文件合并 (compose.go)](#35-文件合并-composego)
  - [3.6 授权与签名 (auth.go)](#36-授权与签名-authgo)
  - [3.7 安全令牌 (secure_token.go)](#37-安全令牌-secure_tokengo)
  - [3.8 编码协商 (encoding.go)](#38-编码协商-encodinggo)
  - [3.9 环境变量查询 (envs.go)](#39-环境变量查询-envsgo)
- [4. Process gRPC 服务 (internal/services/process)](#4-process-grpc-服务-internalservicesprocess)
  - [4.1 服务容器 (service.go)](#41-服务容器-servicego)
  - [4.2 进程 Handler (handler/handler.go)](#42-进程-handler-handlerhandlergo)
  - [4.3 多路复用通道 (handler/multiplex.go)](#43-多路复用通道-handlermultiplexgo)
  - [4.4 Start RPC (start.go)](#44-start-rpc-startgo)
  - [4.5 Connect RPC (connect.go)](#45-connect-rpc-connectgo)
  - [4.6 输入处理 (input.go)](#46-输入处理-inputgo)
  - [4.7 信号与更新 (signal.go / update.go)](#47-信号与更新-signalgo--updatego)
  - [4.8 进程列表 (list.go)](#48-进程列表-listgo)
- [5. Filesystem gRPC 服务 (internal/services/filesystem)](#5-filesystem-grpc-服务-internalservicesfilesystem)
  - [5.1 服务容器 (service.go)](#51-服务容器-servicego)
  - [5.2 目录操作 (dir.go)](#52-目录操作-dirgo)
  - [5.3 文件移动 (move.go)](#53-文件移动-movego)
  - [5.4 文件删除 (remove.go)](#54-文件删除-removego)
  - [5.5 文件元信息 (stat.go)](#55-文件元信息-statgo)
  - [5.6 目录监听 (watch.go / watch_sync.go)](#56-目录监听-watchgo--watch_syncgo)
  - [5.7 工具函数 (utils.go)](#57-工具函数-utilsgo)
- [6. Cgroup 管理 (internal/services/cgroups)](#6-cgroup-管理-internalservicescgroups)
- [7. 主机交互层 (internal/host)](#7-主机交互层-internalhost)
  - [7.1 MMDS 客户端 (mmds.go)](#71-mmds-客户端-mmdsgo)
  - [7.2 MMDS 路由 (mmds_route)](#72-mmds-路由-mmds_route)
  - [7.3 主机指标 (metrics.go)](#73-主机指标-metricsgo)
  - [7.4 CA 证书安装 (cacerts.go)](#74-ca-证书安装-cacertsgo)
- [8. 日志系统 (internal/logs)](#8-日志系统-internallogs)
  - [8.1 Logger 工厂 (logger.go)](#81-logger-工厂-loggergo)
  - [8.2 HTTP 日志导出 (exporter/)](#82-http-日志导出-exporter)
  - [8.3 速率限制 (ratelimit/)](#83-速率限制-ratelimit)
  - [8.4 gRPC 拦截器 (interceptor.go)](#84-grpc-拦截器-interceptorgo)
- [9. 权限与认证 (internal/permissions)](#9-权限与认证-internalpermissions)
- [10. 端口转发 (internal/port)](#10-端口转发-internalport)
- [11. Legacy 兼容层 (internal/services/legacy)](#11-legacy-兼容层-internalserviceslegacy)
- [12. 工具模块 (internal/utils)](#12-工具模块-internalutils)
- [13. Proto 接口定义 (spec/)](#13-proto-接口定义-spec)
- [14. 代码生成](#14-代码生成)
- [15. 版本管理](#15-版本管理)
- [16. 架构总览图](#16-架构总览图)
- [17. 端到端数据流](#17-端到端数据流)
  - [17.1 沙箱启动初始化](#171-沙箱启动初始化)
  - [17.2 进程启动与交互](#172-进程启动与交互)
  - [17.3 文件上传](#173-文件上传)
  - [17.4 文件系统监听](#174-文件系统监听)
  - [17.5 暂停前冻结 / 恢复后解冻](#175-暂停前冻结--恢复后解冻)
- [18. 环境变量与命令行参数参考](#18-环境变量与命令行参数参考)

---

## 1. 概述与架构定位

Envd 是部署在每个 Firecracker VM 内部的用户态守护进程，监听端口 **49983**。它通过两种协议对外提供服务：

| 协议 | 框架 | 用途 |
|------|------|------|
| **Connect RPC** (基于 HTTP/2) | `connect-go` + `chi` | 进程管理、文件系统操作（结构化 API） |
| **REST (OpenAPI)** | `oapi-codegen` + `Gin` 兼容 | 初始化、健康检查、文件上传/下载、指标查询 |

**关键依赖：**
- 运行在 Firecracker microVM 内部，通过 **MMDS**（Microvm Metadata Service）获取 orchestrator 注入的配置
- 所有子进程通过 **cgroup v2** 进行资源隔离和冻结/解冻
- 通过 **NFS v3** 挂载持久卷

---

## 2. 入口与启动 (main.go)

`main.go` 是 envd 守护进程的入口点。

**命令行参数：**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | `49983` | 监听端口 |
| `--isnotfc` | `false` | 非 Firecracker 模式（跳过 MMDS 轮询和 HTTP 日志导出） |
| `--cgroup-root` | `/sys/fs/cgroup` | cgroup 根目录 |
| `--no-cgroups` | `false` | 禁用 cgroup 管理 |
| `--verbose` | `false` | 将 envd 日志输出到 stdout |
| `--version` | — | 打印版本号 |
| `--commit` | — | 打印 git commit SHA |

**启动流程 (`run()`)**：

1. 创建 `/run/e2b` 运行时目录
2. 初始化 `execcontext.Defaults`（默认用户 `root` + 环境变量 Map）
3. 启动 MMDS 配置轮询 goroutine（非 `--isnotfc` 模式）
4. 构造 `zerolog` 日志器（含 OTEL + HTTP 导出器 + 速率限制）
5. 创建 `chi.Mux` 路由器
6. 挂载 **Filesystem gRPC 服务** 到 mux
7. 创建 **cgroup 管理器**（三种进程类型：PTY/Socat/User，各自独立的资源限制）
8. 挂载 **Process gRPC 服务** 到 mux
9. 创建 **REST API** 服务实例，用 oapi-codegen 生成的 `HandlerFromMux` 挂载
10. 组装中间件链：`withCORS` → `WithAuthorization`（HMAC 签名）→ `authn.NewMiddleware`（Connect-RPC 认证）
11. 启动 **端口扫描器**（1s 间隔扫描 `/proc/net/tcp`）和 **端口转发器**（socat 转发到 gateway IP）
12. 启动 HTTP 服务器（`0.0.0.0:49983`，idle timeout 640s）

**常量：**

| 常量 | 值 | 说明 |
|------|-----|------|
| `idleTimeout` | 640s | 高于 orchestrator 代理的 600s 空闲超时 |
| `defaultPort` | 49983 | 默认监听端口 |
| `portScannerInterval` | 1000ms | 端口扫描间隔 |
| `defaultUser` | `"root"` | 默认用户 |

---

## 3. REST API 层 (internal/api)

基于 OpenAPI 3.0 规范（`spec/envd.yaml`）通过 `oapi-codegen` 自动生成的 HTTP 处理器。

### 3.1 API 核心结构 (store.go)

`API` 结构体是 REST 层的核心容器：

| 字段 | 类型 | 说明 |
|------|------|------|
| `isNotFC` | `bool` | 是否运行在非 FC 环境 |
| `logger` | `*zerolog.Logger` | 日志器 |
| `accessToken` | `*SecureToken` | 安全访问令牌（常量时间比较 + 内存清零） |
| `defaults` | `*execcontext.Defaults` | 执行上下文默认值（用户、工作目录、环境变量） |
| `mmdsChan` | `chan *host.MMDSOpts` | MMDS 配置通知通道 |
| `hyperloopLock` | `sync.Mutex` | Hyperloop 设置互斥锁 |
| `mmdsClient` | `MMDSClient` | MMDS 客户端接口（可测试） |
| `lastSetTime` | `*utils.AtomicMax` | 上次设置时间戳（防止时间倒退） |
| `initLock` | `*semaphore.Weighted` | init 请求串行化信号量 |
| `caCertInstaller` | `*host.CACertInstaller` | CA 证书安装器 |
| `cgroupManager` | `cgroups.Manager` | cgroup 管理器 |
| `freezeLock` | `*semaphore.Weighted` | 冻结/解冻操作互斥信号量 |
| `isMountingNFS` | `atomic.Bool` | NFS 挂载并发保护 |
| `mountedPaths` | `sync.Map` | 已挂载路径与 lifecycle ID 映射 |

**暴露的端点：**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查（204 No Content） |
| `GET` | `/metrics` | 资源使用指标（CPU/内存/磁盘） |
| `POST` | `/init` | 沙箱初始化（环境变量、用户、NFS、Hyperloop、系统时间） |
| `POST` | `/freeze` | 冻结 user/pty cgroup（暂停前调用） |
| `POST` | `/unfreeze` | 解冻 user/pty cgroup（暂停失败回滚用） |
| `GET` | `/envs` | 返回当前环境变量 |
| `GET` | `/files` | 下载文件/目录 |
| `POST` | `/files` | 上传文件（multipart/raw + gzip） |
| `POST` | `/files/compose` | 零拷贝合并多个文件 |

### 3.2 Init/Freeze/Unfreeze (init.go)

#### `POST /init`

沙箱每次从快照恢复后由 orchestrator 调用，完成环境配置。

**完整流程：**
1. 解析请求 body（`PostInitJSONBody`）
2. 销毁请求中的 `AccessToken`（defer，安全清理）
3. 获取 `initLock` 信号量（串行化）
4. **验证访问令牌**：与现有令牌比较 → 与 MMDS 哈希比较 → 首次设置允许空令牌
5. **defer 解冻**：无论请求是否更新数据，都解冻 user/pty cgroup
6. **时间戳守卫**：仅在请求时间戳更新时执行 `SetData`
7. **后台 MMDS 轮询**：触发一次性配置更新

**`SetData` 执行的配置项：**
- 系统时间同步（`settimeofday`，偏差 >50ms past 或 >5s future 时触发）
- 环境变量替换（区分 internal 和 user 条目）
- 访问令牌设置/清零
- Hyperloop IP → `/etc/hosts` 重写（`events.e2b.local`）
- 默认用户和工作目录更新
- CA 证书安装（去重写入系统 bundle）
- NFS 卷挂载（按 lifecycle ID 管理生命周期，支持重挂载）

**NFS 挂载选项：** `sync, rsize=1048576, wsize=1048576, mountproto=tcp, mountport=2049, proto=tcp, port=2049, nfsvers=3, noacl, noac, lookupcache=none` — 禁用缓存以确保 pause/resume 正确性。

#### `POST /freeze`

在 orchestrator 暂停沙箱前调用，冻结 user 和 pty cgroup。冻结状态随快照持久化，`/init` 恢复时自动解冻。

#### `POST /unfreeze`

**仅用于暂停失败回滚路径**。正常恢复解冻通过 `/init` 的 defer 完成。

**冻结/解冻的 cgroup 集合：** `ProcessTypeUser` + `ProcessTypePTY`

### 3.3 文件上传 (upload.go)

`POST /files` 支持两种上传模式。

**`PostFiles(w, r, params)` — 顶层入口**

签名：`(w http.ResponseWriter, r *http.Request, params PostFilesParams)`

完整流程：
1. 签名验证 → 失败返回 `401`
2. 解析 username → 失败返回 `400`
3. 解压 gzip body（`Content-Encoding` 检测）→ 失败返回 `400`
4. 查找用户、解析 UID/GID
5. 验证元数据（`ValidateMetadata`）→ 失败返回 `400`
6. 按 `Content-Type` 分发：
   - `"application/octet-stream"` → `handleRawUpload`
   - `"multipart/*"` → `handleMultipartUpload`
   - 其他 → `400`
7. 返回 `200` + `UploadSuccess`（`[]EntryInfo` JSON）

**`processFile(r, path, part, uid, gid, metadata, logger) (int, error)`**

核心文件写入函数：
1. `EnsureDirs(filepath.Dir(path), uid, gid)` 创建父目录 → 失败 `500`
2. 检查已有路径：如果是目录 → `400`
3. 以 `O_WRONLY|O_CREATE|O_TRUNC` 打开文件（mode `0666`）→ `ENOSPC` 返回 `507`（Inode 耗尽）
4. `chown` 设置所有权
5. `file.ReadFrom(part)` 写入内容 → `ENOSPC` 返回 `507`，包含尝试写入字节数
6. `WriteMetadata(path, metadata)` 写入 xattr → xattr 不支持时 warn 并继续；`ENOSPC`/`EDQUOT` → `507`；其他 → `500`
7. 成功返回 `(204, nil)`

**`extractMetadataHeaders(h http.Header) map[string]string`**
- 提取 `X-Metadata-*` 头，剥离前缀，key 转小写
- 无匹配时返回 `nil`

**`resolvePath(part, paths, u, defaultPath, params) (string, error)`**
- 优先使用 `params.Path`，否则从 multipart part 的 `FileNameWithPath()` 提取
- 展开 `~` 和相对路径
- 检测同一次请求中的重复路径

**错误码映射：**

| 条件 | HTTP 状态码 |
|------|------------|
| 签名无效 | `401 Unauthorized` |
| Content-Encoding 解压失败 | `400 Bad Request` |
| 元数据格式无效 | `400 Bad Request` |
| 目标路径是目录 | `400 Bad Request` |
| 磁盘空间不足（data/inode/xattr） | `507 Insufficient Storage` |
| 其他写入错误 | `500 Internal Server Error` |

**Multipart 模式：**
- 解析 multipart 表单，使用 `CustomPart` 保留完整文件路径（含目录）
- 仅处理 `FormName() == "file"` 的 part，跳过其他 part

**Raw body 模式：**
- 直接读取 body，支持 `Content-Encoding: gzip` 自动解压
- **必须**提供 `path` 查询参数，否则返回 `400`

**元数据支持：** `X-Metadata-<key>` 请求头被持久化为 `user.e2b.<key>` 扩展属性（xattr），在 `EntryInfo` 查询时返回。每次上传替换全部元数据。

**限制：**
- Key 必须为可打印 US-ASCII（0x20-0x7E）
- Key 长度上限 246 字节
- 单文件所有元数据总大小上限 4096 字节

### 3.4 文件下载 (download.go)

**`GetFiles(w, r, params)` — 签名：`(w http.ResponseWriter, r *http.Request, params GetFilesParams)`**

完整流程：
1. 签名验证（`validateSigning`，read 操作）→ 失败 `401`
2. 解析 username → 失败 `400`
3. 查找用户 → 失败 `401`
4. 展开并解析路径 → 失败 `400`
5. `os.Stat(path)`：不存在 → `404`；其他错误 → `500`；是目录 → `400`
6. 解析 `Accept-Encoding` 头 → 失败 `406 NotAcceptable`
7. 设置 `Vary: Accept-Encoding`
8. **Range/条件请求处理**：如果请求含 `Range`/`If-Modified-Since`/`If-None-Match`/`If-Range` 头，回退到 identity 编码（必须可接受）
9. 打开文件，设置 `Content-Disposition: inline; filename=<basename>`
10. **Gzip 模式**：设置 `Content-Encoding: gzip`，根据扩展名推断 `Content-Type`（默认 `application/octet-stream`），通过 `gzip.NewWriter` 流式写入
11. **Identity 模式**：委托 `http.ServeContent(w, r, path, stat.ModTime(), file)` — 原生支持 Range/条件请求

**编码协商逻辑：**
- `parseAcceptEncoding(r)` 解析 `Accept-Encoding` 头，支持 q-value 优先级排序
- 优先选择 gzip（如果客户端接受），否则回退 identity

### 3.5 文件合并 (compose.go)

**`PostFilesCompose(w, r)` — 签名：`(w http.ResponseWriter, r *http.Request)`**

**请求体 `ComposeRequest`：**
- `SourcePaths []string`（必填，不可为空）
- `Destination string`（必填，不可为空）
- `Username *string`（可选）

完整流程：
1. 解析 JSON body → 无效 JSON 返回 `400`
2. 验证 `SourcePaths` 非空 → 空返回 `400`
3. 验证 `Destination` 非空 → 空返回 `400`
4. 解析 username/用户 → 失败 `401`
5. 对每个源路径：展开路径 → 验证不等于目标路径（`400`）→ `os.Stat` 验证是常规文件（`404`/`400`）
6. `EnsureDirs` 创建目标父目录
7. 写入临时文件 `<dest>.e2b-compose.<uuid>.tmp` → `ENOSPC` 返回 `507`
8. `chown` 临时文件 → 失败 `500`，清理临时文件
9. 按顺序遍历源文件：`destFile.ReadFrom(srcFile)` 使用 Linux `copy_file_range` 零拷贝 → `ENOSPC` 返回 `507`，其他错误 `500`，均清理临时文件
10. `os.Rename(tmpFile, destPath)` 原子替换 → 失败 `500`，清理临时文件
11. 删除所有源文件
12. 返回 `200` + `EntryInfo` JSON

### 3.6 授权与签名 (auth.go)

**常量：**

| 常量 | 值 | 说明 |
|------|-----|------|
| `SigningReadOperation` | `"read"` | 读操作签名类型 |
| `SigningWriteOperation` | `"write"` | 写操作签名类型 |
| `accessTokenHeader` | `"X-Access-Token"` | 令牌头名称 |

**无需通用认证的路径：**
```go
var authExcludedPaths = []string{"GET/health", "GET/files", "POST/files", "POST/init"}
```

**`WithAuthorization(handler) http.Handler`**

中间件逻辑：
- 如果 `accessToken` 已设置：读取 `X-Access-Token` 头
  - 令牌不匹配 **且** 路径不在排除列表 → `401`
  - 其他情况放行

**`generateSignature(path, username, operation, signatureExpiration) (string, error)`**

签名算法：
1. 获取令牌字节（defer `memguard.WipeBytes` 清零）
2. 构建签名字符串：
   - 无过期：`path:operation:username:tokenBytes`
   - 有过期：`path:operation:username:tokenBytes:expiration`
3. `SHA256` 哈希
4. 返回 `"v1_" + hex_hash`

**`validateSigning(r, signature, signatureExpiration, username, path, operation) error`**

验证流程：
1. 令牌未设置 → 直接通过（无认证配置）
2. `X-Access-Token` 头存在 → 验证匹配
3. 无 `signature` 参数 → 错误 `"missing signature query parameter"`
4. 生成期望签名 → 常量时间比较
5. 签名不匹配 → 错误 `"invalid signature"`
6. `signatureExpiration < now` → 错误 `"signature is already expired"`

### 3.7 安全令牌 (secure_token.go)

`SecureToken` 提供安全令牌容器：

| 方法 | 说明 |
|------|------|
| `Set(raw)` | 从字节设置令牌，清零入参 buffer |
| `EqualsSecure(other)` | 常量时间比较（`subtle.ConstantTimeCompare`） |
| `Destroy()` | 显式内存清零（`memguard.WipeBytes`） |
| `UnmarshalJSON(data)` | JSON 反序列化，使用常量时间字符串比较 |
| `TakeFrom(other)` | 原子转移所有权，清零源令牌 |

### 3.8 编码协商 (encoding.go)

HTTP 内容协商工具集：

| 函数 | 说明 |
|------|------|
| `parseAcceptEncodingHeader(header)` | 解析 `Accept-Encoding` 头，支持 q-value 优先级排序 |
| `getDecompressedBody(body, encoding)` | 根据 `Content-Encoding` 自动选择 reader 链解压（gzip/deflate/zstd） |

### 3.9 环境变量查询 (envs.go)

`GET /envs` 返回当前实例的全部环境变量（internal + user 合并后的 `Map[string]string`）。

---

## 4. Process gRPC 服务 (internal/services/process)

基于 Connect-RPC 协议（`spec/process/process.proto`），提供进程全生命周期管理。

### 4.1 服务容器 (service.go)

`Service` 结构体：

| 字段 | 类型 | 说明 |
|------|------|------|
| `processes` | `*utils.Map[uint32, *handler.Handler]` | PID → Handler 的线程安全映射 |
| `logger` | `*zerolog.Logger` | 日志器 |
| `defaults` | `*execcontext.Defaults` | 默认执行上下文 |
| `cgroupManager` | `cgroups.Manager` | cgroup 管理器 |

**`getProcess(selector)`** 按 PID 或 tag 查找进程，未找到返回 `NotFound` 错误。

### 4.2 进程 Handler (handler/handler.go)

**`Handler` 结构体：**

```go
type Handler struct {
    Config     *rpc.ProcessConfig     // 进程配置（cmd、args、envs、cwd）
    Tag        *string                // 可选标签（用于 Connect RPC 按 tag 查找）
    cmd        *exec.Cmd              // 底层 OS 命令
    tty        *os.File               // PTY 主端（可选）
    cancel     context.CancelFunc     // 进程上下文取消
    outCtx     context.Context        // 输出管道生命周期
    outCancel  context.CancelFunc     // 输出取消
    stdinMu    sync.Mutex             // stdin 写互斥锁
    stdin      io.WriteCloser         // stdin 管道写端
    stdoutBytes atomic.Int64          // stdout 累计字节
    stderrBytes atomic.Int64          // stderr 累计字节
    ptyBytes    atomic.Int64          // PTY 累计字节
    DataEvent  *MultiplexedChannel[rpc.ProcessEvent_Data]   // 数据事件多路复用
    EndEvent   *MultiplexedChannel[rpc.ProcessEvent_End]    // 结束事件多路复用
}
```

**常量：**

| 常量 | 值 | 说明 |
|------|-----|------|
| `defaultNice` | `0` | 默认 nice 值 |
| `defaultOomScore` | `100` | 默认 OOM score（与 init 相同） |
| `outputBufferSize` | `64` | 输出 channel buffer |
| `systemTag` | `"_system"` | 系统进程标签 |
| `stdChunkSize` | `32 KiB` | stdout/stderr 读取块大小 |
| `ptyChunkSize` | `16 KiB` | PTY 读取块大小 |

**`New(ctx, user, req, logger, defaults, cgroupManager, cancel) (*Handler, error)`**

完整构造逻辑：
1. 构建包装命令：`/bin/sh -c '<oom_script> && exec /usr/bin/ionice -c 2 -n 4 /usr/bin/nice -n <delta> "${@}" -- <cmd> <args>'`
   - 重置 `oom_score_adj` 为 100
   - `ionice` 设为 best-effort class 2 / priority 4
   - `nice` 设为 `defaultNice - currentNice()` 差值
2. 解析 UID/GID + 补充组（`user.GroupIds()`）
3. 获取 cgroup FD（`cgroupManager.GetFileDescriptor(getProcType(req))`），注入 `cmd.SysProcAttr`
4. 设置 `cmd.SysProcAttr.Credential`（Uid, Gid, Groups）
5. 解析 cwd（`ExpandAndResolve`）→ 不存在返回 `InvalidArgument`
6. 构建环境变量链：`PATH`（当前环境）→ `HOME`/`USER`/`LOGNAME` → 全局默认值 → 请求级 envs（后者覆盖前者）
7. **PTY 模式**（`req.GetPty() != nil`）：立即通过 `pty.StartWithSize(cmd, &Winsize{Cols, Rows})` 启动进程；启动 goroutine 以 `ptyChunkSize` 读取 tty → 发布 `Pty` 变体 DataEvent
8. **非 PTY 模式**：创建 `cmd.StdoutPipe()` 和 `cmd.StderrPipe()`；各自 goroutine 以 `stdChunkSize` 读取 → 发布 `Stdout`/`Stderr` 变体 DataEvent
9. **stdin**：仅在 `req.Stdin == nil || req.GetStdin() == true` 时创建（向后兼容）；否则使用 `/dev/null`
10. 启动 goroutine 等待输出管道完成 → 关闭 `outMultiplex.Source` + 调用 `outCancel()`

**错误条件：**

| 错误 | Connect Code |
|------|-------------|
| UID/GID 解析失败 | `Internal` |
| cwd 解析失败/不存在 | `InvalidArgument` |
| PTY 启动失败 | `InvalidArgument` |
| stdout/stderr pipe 失败 | `Internal` |
| stdin pipe 失败 | `Internal` |

**`Start(requestTimeout time.Duration) (uint32, error)`**
- 非 PTY 模式：调用 `cmd.Start()`；PTY 模式：已在 `New()` 中启动，跳过
- 返回 `uint32(cmd.Process.Pid)`

**`Wait()`**
- 阻塞等待 `outCtx.Done()`（所有输出管道关闭）
- 调用 `cmd.Wait()` 回收子进程
- 关闭 `tty`
- 构造 `EndEvent{Error, ExitCode, Exited, Status}`
- 发送到 `EndEvent.Source`，记录 stdout/stderr/pty 字节数
- 调用 `cancel()` 清理

**`WriteStdin(data []byte) error`**
- `tty != nil` → 错误 `"tty assigned to process"`
- 获取 `stdinMu`；`stdin == nil` → 错误 `"stdin not enabled or closed"`
- 写入 `data` 到 `stdin`

**`WriteTty(data []byte) error`**
- `tty == nil` → 错误 `"tty not assigned to process"`
- 写入 `data` 到 `tty`

**`ResizeTty(size *pty.Winsize) error`**
- `tty == nil` → 错误 `"tty not assigned to process"`
- 委托 `pty.Setsize(tty, size)`

**`SendSignal(signal syscall.Signal) error`**
- `cmd.Process == nil` → 错误 `"process not started"`
- SIGKILL/SIGTERM 时先调用 `outCancel()` 取消输出上下文
- 委托 `cmd.Process.Signal(signal)`

**`CloseStdin() error`**
- `tty != nil` → 错误 `"cannot close stdin for PTY process"`（建议发送 Ctrl+D / 0x04）
- 获取 `stdinMu`；`stdin == nil` → 无操作
- 调用 `stdin.Close()`，然后 `stdin = nil`（即使出错也不再重试）

**`getProcType(req) ProcessType`**
- `tag == "_system"` → `ProcessTypeSystem`
- `req.GetPty() != nil` → `ProcessTypePTY`
- 默认 → `ProcessTypeUser`

### 4.3 多路复用通道 (handler/multiplex.go)

**`MultiplexedChannel[T any]` 结构体：**

```go
type MultiplexedChannel[T any] struct {
    Source   chan T                    // 源写入端
    mu       sync.RWMutex             // 保护 channels 列表
    channels []*subscriber[T]         // 订阅者列表
    exited   atomic.Bool              // Source 关闭标记
}

type subscriber[T any] struct {
    ch   chan T          // 订阅者数据通道
    done chan struct{}   // 取消信号
    once sync.Once       // 保证 cancel 幂等
}
```

**`NewMultiplexedChannel[T](buffer int) *MultiplexedChannel[T]`**
- 创建 `Source = make(chan T, buffer)`
- 立即启动 `go c.run()` 后台 goroutine

**`run()` — 扇出循环**
- Range 遍历 `Source`，对每个值：
  - `RLock` → 快照 `channels` → `RUnlock`
  - 对每个订阅者：已取消则跳过；否则 `select` 尝试写入 `s.ch` 或监听 `s.done`（取消的消费者永不阻塞扇出）
- `Source` 关闭（drained）→ 设置 `exited = true`
- 获取完整锁，对所有剩余订阅者调用 `cancel()` + 关闭 `ch`，置空 `channels`

**`Fork() (chan T, func())`**
- 快速路径：`exited == true` → 返回预关闭 channel + no-op cancel
- 加锁，二次检查 `exited`
- 创建新 `subscriber{T]`，追加到 `channels`
- 返回 `s.ch` 和取消函数（调用 `m.remove(s)`）

**`remove(s *subscriber[T])`**
- 先调用 `s.cancel()`（不持锁，使扇出中的发送可以 unblock）
- 加写锁：在 `channels` 中查找 `s`，通过 `slices.Concat` 创建新底层数组（安全支持并发 `run()` 迭代）

**`HasSubscribers() bool`**
- `RLock` → 遍历 → 返回是否有未取消的订阅者

### 4.4 Start RPC (start.go)

`Start(request, stream)` — 服务端流式 RPC，启动新进程并流式推送事件。

**流程：**
1. 认证用户（`GetAuthUser`）
2. 解析超时（从 `Connect-Timeout-Ms` 头）
3. 创建 Handler
4. 创建事件多路复用：Start → Data → End
5. 启动后台 goroutine 流式发送事件：
   - 发送 `StartEvent{pid}`
   - 进入数据循环：`DataEvent` → 发送 / `KeepAlive` ticker → 发送 / context 取消 → 退出
   - 发送 `EndEvent{exit_code, exited, status}`
6. 调用 `proc.Start()` 启动进程
7. 将 Handler 注册到 `processes` Map
8. 启动后台清理 goroutine（`Wait()` 完成后从 Map 删除）
9. 等待发送 goroutine 完成

### 4.5 Connect RPC (connect.go)

`Connect(request, stream)` — 订阅已存在进程的事件流。

- 按 PID/tag 查找进程
- Fork DataEvent 和 EndEvent 订阅者
- 周期性发送 `KeepAlive` 事件
- 支持上下文取消

### 4.6 输入处理 (input.go)

| RPC | 说明 |
|-----|------|
| `SendInput` | 一次性写入数据到 PTY 或 stdin |
| `StreamInput` | 客户端流式写入，处理 Start/Data/KeepAlive 事件 |
| `CloseStdin` | 关闭进程 stdin（仅非 PTY 模式） |

### 4.7 信号与更新 (signal.go / update.go)

| RPC | 说明 |
|-----|------|
| `SendSignal` | 将 RPC 信号枚举映射为 `syscall.Signal`（SIGTERM=15, SIGKILL=9）并发送 |
| `Update` | 当前仅支持 PTY 窗口大小调整（`ResizeTty`） |

### 4.8 进程列表 (list.go)

`List()` — 遍历 `processes` Map，返回所有进程的 `ProcessInfo`（PID、配置、tag）。

---

## 5. Filesystem gRPC 服务 (internal/services/filesystem)

基于 Connect-RPC 协议（`spec/filesystem/filesystem.proto`），提供文件系统操作。

### 5.1 服务容器 (service.go)

`Service` 结构体：

| 字段 | 类型 | 说明 |
|------|------|------|
| `logger` | `*zerolog.Logger` | 日志器 |
| `watchers` | `*utils.Map[string, *FileWatcher]` | watcher ID → FileWatcher 映射 |
| `defaults` | `*execcontext.Defaults` | 默认执行上下文 |

**拦截器链：** `NewUnaryLogInterceptor`（日志）→ `legacy.Convert()`（兼容性转换）

### 5.2 目录操作 (dir.go)

| RPC | 说明 |
|-----|------|
| `ListDir(path, depth)` | 递归遍历目录，返回条目列表。支持符号链接解析（最大跳转限制） |
| `MakeDir(path)` | 以指定用户身份创建目录，设置所有权 |

**关键函数：**
- `followSymlink(path)` — 限制最大跳转次数的符号链接解析
- `walkDir(path, depth)` — 按指定深度遍历生成 `EntryInfo` 列表
- `checkIfDirectory(path)` — 判断路径是否为可访问目录

### 5.3 文件移动 (move.go)

`Move(source, destination)` — 解析源/目标路径，切换用户身份，调用 `os.Rename`。支持跨用户移动并保留权限。

### 5.4 文件删除 (remove.go)

`Remove(path)` — 解析路径并切换到目标用户执行删除（`os.RemoveAll`）。

### 5.5 文件元信息 (stat.go)

`Stat(path)` — 解析路径后获取文件/目录的 `EntryInfo`（名称、类型、大小、权限、所有者、修改时间、符号链接目标、xattr 元数据）。

### 5.6 目录监听 (watch.go / watch_sync.go)

**流式监听 (`WatchDir`)**

签名：`WatchDir(ctx, req *connect.Request[WatchDirRequest], stream *connect.ServerStream[WatchDirResponse]) error`

完整流程：
1. 解析用户 → 解析路径
2. Stat 路径 → 不存在 `NotFound`；不是目录 `InvalidArgument`
3. `IsPathOnNetworkMount` → 网络文件系统返回 `InvalidArgument`
4. 创建 `fsnotify.NewWatcher()`，通过 `FsnotifyPath(path, recursive)` 添加监听
5. 发送 `WatchDirResponse_Start` 事件
6. 设置 keepalive ticker（来自 `GetKeepAliveTicker`）
7. 主循环 `select`：
   - `keepaliveTicker.C` → 发送 `KeepAlive`
   - `ctx.Done()` → 返回
   - `w.Errors` → channel 关闭 `Internal("watcher error channel closed")`；否则包装错误
   - `w.Events` → channel 关闭 `Internal("watcher event channel closed")`
     - 将 `e.Op` 分解为多个 `EventType`（CREATE/RENAME/CHMOD/WRITE/REMOVE）
     - 对每个 op：解析相对路径，可选附带 `EntryInfo`（`GetIncludeEntry()` 且 `opCarriesEntry(op)`）
     - 流式发送 `WatchDirResponse_Filesystem`
     - 重置 keepalive ticker

**同步监听 (`FileWatcher`)**

```go
type FileWatcher struct {
    watcher *fsnotify.Watcher
    Events  []*rpc.FilesystemEvent    // 累积事件（Lock 保护）
    cancel  func()                    // 取消函数
    Error   error                     // 错误（Lock 保护）
    Lock    sync.Mutex
}
```

**`CreateFileWatcher(ctx, logger, watchPath, recursive, includeEntryInfo) (*FileWatcher, error)`**
- 创建 `fsnotify.NewWatcher()` → 失败 `Internal`
- 创建独立 context（`WithoutCancel` + `WithCancel`）
- 添加路径 → 失败关闭 watcher 并取消，返回 `Internal`
- 启动 goroutine：事件分解循环与 `watchHandler` 相同，但追加到 `fw.Events`（加锁）
- 返回 `*FileWatcher`

**`Close()`** — 关闭 watcher + 调用 cancel

**RPC 端点：**

| RPC | 签名 | 说明 |
|-----|------|------|
| `CreateWatcher` | `(ctx, req[CreateWatcherRequest]) → (resp[CreateWatcherResponse], error)` | 生成 ID `"w" + id.Generate()`，存入 `watchers` Map |
| `GetWatcherEvents` | `(ctx, req[GetWatcherEventsRequest]) → (resp[GetWatcherEventsResponse], error)` | 加载 watcher → 检查 `Error` → 排空 `Events`（替换空切片）→ 返回 |
| `RemoveWatcher` | `(ctx, req[RemoveWatcherRequest]) → (resp[RemoveWatcherResponse], error)` | 加载 → `Close()` → 从 Map 删除 |

**错误条件：**
- watcher 不存在 → `NotFound`
- 路径不存在 → `NotFound`
- 路径不是目录 → `InvalidArgument`
- 路径在网络挂载上 → `InvalidArgument`

### 5.7 工具函数 (utils.go)

| 函数 | 说明 |
|------|------|
| `IsPathOnNetworkMount(path)` | 解析 `/proc/self/mountinfo` 检测路径是否在 NFS/FUSE 挂载上 |
| `entryInfo(info, path)` | 将 `os.FileInfo` 转换为 `EntryInfo`（含 owner、type、xattr） |
| `getFileOwnership(info)` | 从 FileInfo 提取 UID/GID 与用户名 |

---

## 6. Cgroup 管理 (internal/services/cgroups)

基于 Linux cgroup v2 的进程资源管理。

**接口 (`iface.go`)**：

```go
type Manager interface {
    GetFileDescriptor(procType ProcessType) (int, bool)
    Freeze(procType ProcessType) error
    Unfreeze(procType ProcessType) error
    Close() error
}
```

**进程类型枚举：**

| 类型 | 值 | cgroup 子目录 | 说明 |
|------|----|---------------|------|
| `ProcessTypePTY` | `"pty"` | `ptys` | PTY 终端进程 |
| `ProcessTypeUser` | `"user"` | `user` | 用户进程 |
| `ProcessTypeSocat` | `"socat"` | `socats` | 端口转发 socat 进程 |
| `ProcessTypeSystem` | `"system"` | — | 系统进程（tag=`_system`） |

**`Cgroup2Manager` 结构体：**

```go
type Cgroup2Manager struct {
    cgroupFDs   map[ProcessType]int     // 进程类型 → cgroup 目录 FD
    cgroupPaths map[ProcessType]string  // 进程类型 → cgroup 路径
}
```

**`NewCgroup2Manager(opts ...Cgroup2ManagerOption) (*Cgroup2Manager, error)`**
1. 默认根路径：`/sys/fs/cgroup`
2. 通过 `unix.Statfs` 验证 cgroup v2（检查 `st.Type == CGROUP2_SUPER_MAGIC`）
3. 调用 `createCgroups` 创建所有进程类型的 cgroup
4. 创建失败：关闭已打开的 FD，返回聚合错误

**`createCgroup(fullPath, properties) (int, error)`**
- `os.MkdirAll(fullPath, 0755)`
- 写入属性：以 `O_WRONLY|O_TRUNC` 打开文件（不创建），跳过不存在或权限不足的属性
- 返回目录 FD（`unix.Open(fullPath, O_RDONLY, 0)`）用于 `CLONE_INTO_CGROUP`

**`Freeze(procType) / Unfreeze(procType) error`**
- 写入 `<path>/cgroup.freeze`：`"1"`（冻结）或 `"0"`（解冻）

**`Close() error`**
- 关闭所有 cgroup FD（`unix.Close(fd)`），从 map 中删除

**内存预留策略（`main.go`）：**
- 保留 `min(总内存/8, 128MB)` 作为系统预留
- `memoryMax = 总内存 - 预留`
- `memoryHigh = memoryMax`（OOM-kill 立即触发，不等 throttling 回收）

**实现：**
- `Cgroup2Manager` — Linux 真实实现
- `NoopManager` — 空操作兜底（`--no-cgroups` 或不支持 cgroup 的环境）
- `Cgroup2Manager`（stub）— 非 Linux 平台编译占位

---

## 7. 主机交互层 (internal/host)

### 7.1 MMDS 客户端 (mmds.go)

通过 Firecracker 的 Microvm Metadata Service (MMDS) 获取配置。

**`MMDSOpts` 结构体：**
- `logsAddress` — 日志推送地址
- `accessTokenHash` — 访问令牌 SHA256 哈希

**关键函数：**

| 函数 | 说明 |
|------|------|
| `GetAccessTokenHashFromMMDS(ctx)` | 从 `http://169.254.169.254` 获取令牌哈希 |
| `PollForMMDSOpts(ctx, ch, envVars)` | 轮询 MMDS 直到获取有效配置，写入通道 |

### 7.2 MMDS 路由 (mmds_route)

- **Linux** (`mmds_route_linux.go`)：通过 `iptables` 将 MMDS 流量（169.254.169.254:80）pin 到专用路由表，防止用户自定义规则干扰
- **其他平台** (`mmds_route_other.go`)：空操作

### 7.3 主机指标 (metrics.go)

`Metrics` 结构体从 `/proc` 和 `statfs` 采集：

| 字段 | 来源 |
|------|------|
| `CpuCount` | `runtime.NumCPU()` |
| `CpuUsedPct` | `/proc/stat` 计算 |
| `MemTotal` / `MemUsed` / `MemCache` | `syscall.Sysinfo()` |
| `DiskUsed` / `DiskTotal` | `statfs` |

### 7.4 CA 证书安装 (cacerts.go)

`CACertInstaller` 将 PEM 编码的 CA 证书注入系统证书捆绑包：
- 去重检查（避免重复安装）
- 原子追加到系统 bundle
- 支持从 bundle 中移除指定证书

---

## 8. 日志系统 (internal/logs)

### 8.1 Logger 工厂 (logger.go)

`NewLogger(ctx, isFC, verbose, mmdsChan)` 构造 `zerolog.Logger`：
- 输出到 stdout（`--verbose` 模式）
- OpenTelemetry span 关联
- HTTP 导出器（在 FC 模式下推送日志到 orchestrator）
- 速率限制防止日志洪泛

### 8.2 HTTP 日志导出 (exporter/)

`HTTPExporter` 实现 `io.Writer` 接口：
- 缓存日志条目
- 监听 MMDS 获取日志地址
- 异步批量推送到 orchestrator 的 `POST /logs` 端点
- 覆盖 instance/env/team ID 防伪造

### 8.3 速率限制 (ratelimit/)

`Limiter` 实现简单的令牌桶限流：
- `Allow()` 判断当前事件是否通过
- 记录上次输出时间和抑制次数
- 参数 `floor` 控制最小允许间隔

### 8.4 gRPC 拦截器 (interceptor.go)

| 函数 | 说明 |
|------|------|
| `AssignOperationID()` | 为请求生成唯一 operation ID |
| `AddRequestIDToContext()` | 为 context 注入 Request ID（链路追踪） |
| `NewUnaryLogInterceptor(l)` | 构造 unary 拦截器，自动注入 Request ID 并记录访问日志 |
| `LogServerStreamWithoutEvents` | 服务端流拦截器（无事件时记录日志） |
| `LogClientStreamWithoutEvents` | 客户端流拦截器 |

---

## 9. 权限与认证 (internal/permissions)

| 文件 | 核心函数 | 说明 |
|------|----------|------|
| `authenticate.go` | `AuthenticateUsername` | Connect-RPC 认证拦截器，从 Basic Auth 头解析用户名 |
| `authenticate.go` | `GetAuthUser` | 从 context 获取认证用户，未指定时回退到默认用户 |
| `user.go` | `GetUser` | 通过用户名查询系统用户 |
| `user.go` | `GetUserIdInts/Uints` | 提取 UID/GID |
| `path.go` | `ExpandAndResolve` | 展开 `~` → 家目录，解析相对路径为绝对路径 |
| `path.go` | `EnsureDirs` | 递归创建目录并设置所有权 |
| `keepalive.go` | `GetKeepAliveTicker` | 为长连接 RPC 流生成 keepalive ticker |

---

## 10. 端口转发 (internal/port)

将 VM 内部 `127.0.0.1` 上监听的端口自动映射到 eth0 接口，使外部可访问。

**关键常量：**
- `defaultGatewayIP = 169.254.0.21` — 端口转发的源 IP

### Scanner (scan.go)

```go
type Scanner struct {
    Processes chan net.ConnectionStat     // TCP 连接状态广播
    scanExit  chan struct{}               // 退出信号
    subs      *smap.Map[*ScannerSubscriber]
    period    time.Duration               // 扫描间隔
}
```

**`ScanAndBroadcast()`** — 主循环：
- 调用 `net.Connections("tcp")`（IPv4 + IPv6）
- 对每个订阅者调用 `sub.Signal(processes)`
- 间隔 `period`（默认 1s）
- `scanExit` 关闭时返回

### ScannerSubscriber (scanSubscriber.go)

```go
type ScannerSubscriber struct {
    logger   *zerolog.Logger
    filter   *ScannerFilter              // 过滤规则
    Messages chan ([]net.ConnectionStat)  // 过滤后的连接列表
    id       string
}
```

**`Signal(proc []net.ConnectionStat)`**
- filter 为 nil → 发送全部进程
- 否则过滤匹配的进程并发送

### ScannerFilter (scanfilter.go)

```go
type ScannerFilter struct {
    State string       // socket 状态（如 "LISTEN"）
    IPs   []string     // 匹配的 IP 列表
}
```

**`Match(proc *net.ConnectionStat) bool`**
- State 和 IPs 都为空 → `false`（不匹配任何）
- `proc.Laddr.IP` 在 `IPs` 中 **且** `State == proc.Status` → `true`

### Forwarder (forward.go)

```go
type Forwarder struct {
    logger            *zerolog.Logger
    cgroupManager     cgroups.Manager
    ports             map[string]*PortToForward
    scannerSubscriber *ScannerSubscriber
    sourceIP          net.IP                // 169.254.0.21
}

type PortToForward struct {
    socat  *exec.Cmd     // socat 子进程
    pid    int32         // 监听进程 PID
    family uint32        // AF_INET=2 / AF_INET6=10
    state  PortState     // FORWARD / DELETE
    port   uint32
}
```

**`NewForwarder(logger, scanner, cgroupManager) *Forwarder`**
- 订阅 Scanner，过滤器：IPs `["127.0.0.1", "localhost", "::1"]`，State `"LISTEN"`
- 设置 `sourceIP = 169.254.0.21`

**`StartForwarding(ctx)` — 主循环**
1. 等待 scanner 事件或 context 取消
2. 对每次扫描结果：
   - 标记所有已跟踪端口为 `PortStateDelete`
   - 遍历连接：构建 key `"<pid>-<port>"`
     - 已跟踪 → 标记 `PortStateForward`
     - 新端口 → 创建 `PortToForward`，调用 `startPortForwarding`
   - 移除仍为 `PortStateDelete` 的端口

**`startPortForwarding(ctx, p)`**
- 执行命令：`socat -d -d -d TCP4-LISTEN:<port>,bind=<sourceIP>,reuseaddr,fork TCP<family>:localhost:<port>`
- 通过 `applyCgroupFD` 将子进程加入 `ProcessTypeSocat` cgroup
- 设置 `Setpgid: true`（进程组管理）
- 后台 goroutine 调用 `cmd.Wait()`

**`stopPortForwarding(p)`**
- 通过 `syscall.Kill(-pid, SIGKILL)` 杀死整个进程组
- 设置 `p.socat = nil`

**`familyToIPVersion(family)`**
- `AF_INET` → 4，`AF_INET6` → 6，默认 → 0

---

## 11. Legacy 兼容层 (internal/services/legacy)

提供与旧版 `connect-python` SDK 的向后兼容：

| 组件 | 说明 |
|------|------|
| `ConversionInterceptor` | Connect-RPC 拦截器，仅对 `connect-python` UA 触发 |
| `conversion.go` | 响应字段转换与事件格式归一化 |
| `streamConverter` | 将 `connect.StreamingHandlerConn` 适配为旧版流式接口 |
| `legacyfilesystem.pb.go` | 旧版 filesystem proto 生成代码 |
| `legacyprocess.pb.go` | 旧版 process proto 生成代码 |

---

## 12. 工具模块 (internal/utils)

| 文件 | 类型 | 说明 |
|------|------|------|
| `atomic.go` | `AtomicMax` | 互斥锁保护的"仅增大"计数器（跟踪最大时间戳） |
| `envvars.go` | `EnvVars` | 线程安全环境变量 Map，区分 internal（不可覆盖）和 user 条目 |
| `map.go` | `Map[K,V]` | 基于 `sync.Map` 的泛型类型安全包装 |
| `multipart.go` | `CustomPart` | 扩展 multipart.Part，`FileName` 返回含路径的完整文件名 |
| `rfsnotify.go` | `FsnotifyPath` | 递归监听路径添加 `...` 后缀 |

---

## 13. Proto 接口定义 (spec/)

### Process Service (`spec/process/process.proto`)

**8 个 RPC 端点：**

| RPC | 类型 | 说明 |
|-----|------|------|
| `List` | Unary | 列出所有进程 |
| `Start` | Server streaming | 启动进程，流式返回事件（Start→Data→End） |
| `Connect` | Server streaming | 订阅已存在进程的事件流 |
| `Update` | Unary | 更新进程配置（PTY 大小） |
| `StreamInput` | Client streaming | 流式写入 stdin/PTY |
| `SendInput` | Unary | 一次性写入 stdin/PTY |
| `SendSignal` | Unary | 发送信号（SIGTERM/SIGKILL） |
| `CloseStdin` | Unary | 关闭 stdin |

**核心消息：**
- `ProcessSelector` — 按 PID 或 tag 选择进程
- `StartRequest` — 进程配置 + 可选 PTY + tag + stdin 标志
- `ProcessEvent` — 事件联合：`StartEvent{pid}` / `DataEvent{stdout|stderr|pty}` / `EndEvent{exit_code, exited, status}` / `KeepAlive`
- `ProcessInput` — 输入联合：`stdin bytes` / `pty bytes`

### Filesystem Service (`spec/filesystem/filesystem.proto`)

**9 个 RPC 端点：**

| RPC | 类型 | 说明 |
|-----|------|------|
| `Stat` | Unary | 获取文件元信息 |
| `MakeDir` | Unary | 创建目录 |
| `Move` | Unary | 移动/重命名文件 |
| `ListDir` | Unary | 列出目录内容 |
| `Remove` | Unary | 删除文件/目录 |
| `WatchDir` | Server streaming | 实时监听目录变更 |
| `CreateWatcher` | Unary | 创建 watcher（同步模式） |
| `GetWatcherEvents` | Unary | 拉取 watcher 累积事件 |
| `RemoveWatcher` | Unary | 删除 watcher |

**核心消息：**
- `EntryInfo` — 文件元信息（name, path, type, size, mode, permissions, owner, group, modified_time, symlink_target, metadata xattr）
- `FileType` — 枚举：FILE / DIRECTORY / SYMLINK
- `FilesystemEvent` — 变更事件（name, type, 可选 entry）
- `EventType` — 枚举：CREATE / WRITE / REMOVE / RENAME / CHMOD

---

## 14. 代码生成

Envd 使用多种代码生成工具：

| 工具 | 输入 | 输出 | 命令 |
|------|------|------|------|
| `oapi-codegen` | `spec/envd.yaml` | `internal/api/api.gen.go` | `make generate` |
| `protoc-gen-go` | `spec/process/process.proto` | `internal/services/spec/process/process.pb.go` | `make generate` |
| `protoc-gen-connect-go` | `spec/process/process.proto` | `internal/services/spec/process/processconnect/process.connect.go` | `make generate` |
| `protoc-gen-go` | `spec/filesystem/filesystem.proto` | `internal/services/spec/filesystem/filesystem.pb.go` | `make generate` |
| `protoc-gen-connect-go` | `spec/filesystem/filesystem.proto` | `internal/services/spec/filesystem/filesystemconnect/filesystem.connect.go` | `make generate` |
| `buf` | `spec/*.yaml` | 共享桩代码到 `packages/shared/pkg/grpc/envd/` | `make generate` |
| `mockery` | Connect 接口 | `internal/services/spec/*/mocks/` | `make generate-mocks` |

**配置文件：**
- `spec/buf.gen.yaml` — 内部代码生成
- `spec/buf.gen.shared.yaml` — 共享包代码生成
- `internal/api/cfg.yaml` — oapi-codegen 配置

---

## 15. 版本管理

版本号定义在 `pkg/version.go`：

```go
const Version = "0.6.3"
```

**重要规则：** 每次行为变更（非纯注释/文档修改）必须更新版本号。envd 版本用于 orchestrator 编译时检查，确保兼容性。

---

## 16. 架构总览图

```
                        ┌─────────────────────────────────────────────┐
                        │           Orchestrator (host)               │
                        │                                             │
                        │  POST /init ───→ MMDS(token hash, logs)    │
                        │  POST /freeze ──→ cgroup freeze             │
                        │  POST /unfreeze → cgroup unfreeze           │
                        └──────────────┬──────────────────────────────┘
                                       │ HTTP (port 49983)
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      Firecracker microVM                                │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                        envd (:49983)                               │  │
│  │                                                                    │  │
│  │  ┌──────────────────────┐  ┌──────────────────────────────────┐   │  │
│  │  │    REST API (Gin)    │  │     Connect-RPC Services (chi)    │   │  │
│  │  │                      │  │                                    │   │  │
│  │  │  /health             │  │  Process Service:                  │   │  │
│  │  │  /metrics            │  │    Start / Connect / List          │   │  │
│  │  │  /init               │  │    SendInput / StreamInput         │   │  │
│  │  │  /freeze /unfreeze   │  │    SendSignal / CloseStdin         │   │  │
│  │  │  /envs               │  │    Update (PTY resize)             │   │  │
│  │  │  /files (GET/POST)   │  │                                    │   │  │
│  │  │  /files/compose      │  │  Filesystem Service:               │   │  │
│  │  │                      │  │    Stat / ListDir / MakeDir        │   │  │
│  │  └──────────────────────┘  │    Move / Remove                   │   │  │
│  │                            │    WatchDir (streaming)             │   │  │
│  │                            │    CreateWatcher/Get/Remove         │   │  │
│  │                            └──────────────────────────────────┘   │  │
│  │                                                                    │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │  │
│  │  │  Cgroup v2   │  │ Port Scanner │  │   MMDS Client            │ │  │
│  │  │  Manager     │  │ + Forwarder  │  │   (169.254.169.254)      │ │  │
│  │  │  (PTY/Socat/ │  │  (socat)     │  │                          │ │  │
│  │  │   User)      │  │              │  │   token hash / logs addr │ │  │
│  │  └──────┬───────┘  └──────┬───────┘  └───────────────────────────┘ │  │
│  │         │                  │                                        │  │
│  └─────────┼──────────────────┼────────────────────────────────────────┘  │
│            │                  │                                           │
│            ▼                  ▼                                           │
│  ┌─────────────────┐  ┌────────────────┐                                 │
│  │  User Processes  │  │  eth0 ↔ lo     │                                 │
│  │  (via Handler)   │  │  Port Forward  │                                 │
│  └─────────────────┘  └────────────────┘                                 │
│                                                                          │
│  ┌─────────────────┐  ┌────────────────┐                                 │
│  │  NFS Mounts      │  │  /etc/hosts    │                                 │
│  │  (Volumes)       │  │  (Hyperloop)   │                                 │
│  └─────────────────┘  └────────────────┘                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 17. 端到端数据流

### 17.1 沙箱启动初始化

```
Orchestrator 恢复 VM
  │
  ├─ VM 启动 → envd 自动运行
  │     ├─ 创建 cgroup 管理器 (ptys/socats/user)
  │     ├─ 挂载 Filesystem + Process RPC 服务
  │     ├─ 挂载 REST API 端点
  │     ├─ 启动端口扫描器 + 转发器
  │     └─ 启动 MMDS 轮询
  │
  ├─ Orchestrator POST /init (无限重试直到成功)
  │     │
  │     ├─ 验证访问令牌 (MMDS hash 比对)
  │     ├─ 设置系统时间 (settimeofday)
  │     ├─ 替换用户环境变量
  │     ├─ 设置/清零访问令牌
  │     ├─ 设置默认用户和工作目录
  │     ├─ 安装 CA 证书
  │     ├─ 配置 Hyperloop (重写 /etc/hosts)
  │     ├─ 挂载 NFS 卷 (按 lifecycle ID)
  │     └─ 解冻 user/pty cgroup (defer)
  │
  └─ 沙箱就绪，等待用户请求
```

### 17.2 进程启动与交互

```
用户 → SDK → API → Orchestrator → envd Process.Start RPC
  │
  ├─ Start RPC (server streaming)
  │     ├─ 认证用户 → 解析超时
  │     ├─ Handler.New() 构建进程
  │     │     ├─ 解析 cwd + envs
  │     │     ├─ exec.Cmd + oom_score_adj + ionice + nice
  │     │     ├─ [可选] PTY 创建
  │     │     └─ cgroup FD 注入 (SysProcAttr)
  │     │
  │     ├─ proc.Start() → 获取 PID
  │     ├─ 注册到 processes Map
  │     │
  │     ├─ 流式推送事件:
  │     │     ├─ StartEvent {pid}
  │     │     ├─ DataEvent {stdout|stderr|pty} (循环)
  │     │     ├─ KeepAlive (定时)
  │     │     └─ EndEvent {exit_code, exited, status}
  │     │
  │     └─ 进程退出 → 从 Map 删除
  │
  ├─ [可选] SendInput / StreamInput → 写入 stdin/PTY
  ├─ [可选] Update → PTY 窗口大小调整
  └─ [可选] SendSignal → SIGTERM/SIGKILL
```

### 17.3 文件上传

```
用户 → SDK → Orchestrator 代理 → envd POST /files
  │
  ├─ [multipart 模式]
  │     ├─ 解析 multipart 表单
  │     ├─ 提取 X-Metadata-* 头 → xattr
  │     ├─ 对每个 part:
  │     │     ├─ 解析用户 → 解析目标路径
  │     │     ├─ 写入临时文件 (解压 gzip)
  │     │     └─ 原子移动到目标路径 + 设置所有权 + 设置 xattr
  │     └─ 返回 EntryInfo 列表
  │
  └─ [raw body 模式]
        ├─ 从 path 参数获取目标
        ├─ 自动解压 Content-Encoding
        └─ processFile 处理
```

### 17.4 文件系统监听

```
用户 → SDK → envd WatchDir RPC (server streaming)
  │
  ├─ 创建 FileWatcher (fsnotify)
  │     ├─ 监听目标路径 (可选递归 "...")
  │     └─ 聚合事件到 channel
  │
  ├─ 流式推送:
  │     ├─ StartEvent
  │     ├─ FilesystemEvent (CREATE/WRITE/REMOVE/RENAME/CHMOD)
  │     │     └─ [可选] EntryInfo (include_entry=true)
  │     └─ KeepAlive (定时)
  │
  └─ 客户端断开 → 清理 watcher
```

### 17.5 暂停前冻结 / 恢复后解冻

```
Orchestrator 暂停沙箱:
  │
  ├─ POST /freeze
  │     ├─ 获取 freezeLock 信号量
  │     ├─ 冻结 ProcessTypeUser cgroup
  │     ├─ 冻结 ProcessTypePTY cgroup
  │     └─ 冻结状态随 VM 快照持久化
  │
  ├─ FC Pause + 快照创建
  │
  └─ [失败回滚] POST /unfreeze

Orchestrator 恢复沙箱:
  │
  ├─ VM 从快照恢复 → envd 自动启动
  │
  ├─ POST /init
  │     ├─ ... 配置更新 ...
  │     └─ defer: 解冻 ProcessTypeUser + ProcessTypePTY
  │
  └─ 用户进程恢复执行
```

---

## 18. 环境变量与命令行参数参考

### 命令行参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--port` | int64 | `49983` | 监听端口 |
| `--isnotfc` | bool | `false` | 非 FC 模式（跳过 MMDS 和日志导出） |
| `--cgroup-root` | string | `/sys/fs/cgroup` | cgroup 根目录路径 |
| `--no-cgroups` | bool | `false` | 禁用 cgroup 管理（使用 no-op manager） |
| `--verbose` | bool | `false` | 日志输出到 stdout |
| `--version` | bool | `false` | 打印版本号后退出 |
| `--commit` | bool | `false` | 打印 commit SHA 后退出 |

### 内部环境变量

| 变量 | 说明 |
|------|------|
| `E2B_SANDBOX` | `"true"` / `"false"`，标记是否运行在 FC 内 |
| `E2B_EVENTS_ADDRESS` | Hyperloop 事件推送地址（`http://<IP>`） |

### 请求头

| 头 | 用途 |
|-----|------|
| `X-Access-Token` | 访问令牌（REST API 认证） |
| `X-E2B-Timestamp` | 请求时间戳（HMAC 签名验证） |
| `X-E2B-Signature` | HMAC-SHA256 签名 |
| `X-Metadata-<key>` | 文件元数据（上传时持久化为 xattr） |
| `Connect-Timeout-Ms` | 进程超时（Process.Start RPC） |
| `Authorization` | Basic Auth（Connect-RPC 用户认证） |

---

> 本文档基于 `.understand-anything/knowledge-graph.json` 知识图谱和源代码分析生成。
> 覆盖 `packages/envd/` 下约 99 个源文件、231 个函数、23 个类/接口定义。
