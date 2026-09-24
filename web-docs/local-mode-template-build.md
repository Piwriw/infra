# Local 模式：模板构建与产物

Local 模式下，`base` 模板由仓库里的脚本通过本机 API 提交给本机 orchestrator 构建。模板和 build 的元数据保存在 PostgreSQL，构建产物由 orchestrator 写入本地文件系统，不需要配置云端模板存储。

## 构建入口

```bash
make -C packages/shared/scripts local-build-base-template
```

该目标读取 `packages/shared/scripts/.env.local`，使用本地 API URL 和由 `seed-database` 准备的 API key。脚本通过 E2B SDK 调用 `Template.build`：模板定义来自 `Template().fromBaseImage()`，别名为 `base`，内存配置为 512 MB。默认跳过构建缓存；设置 `USE_CACHE=true` 才会启用。

## 本机上的构建链路

```text
build.prod.ts / E2B SDK
  → API :3000：登记模板与 build
  → 本地服务发现：选择同时提供 template-manager 的 orchestrator
  → TemplateCreate gRPC :5008：执行模板构建
  → 本地文件系统：保存模板产物与 build cache
  → PostgreSQL：保存模板和 build 状态
```

本地 API 的服务发现把同一组本机节点用于沙箱运行和模板构建。`packages/orchestrator/.env.local` 中的 `ORCHESTRATOR_SERVICES=orchestrator,template-manager` 让同一个进程承担这两个角色；只提供沙箱运行角色的进程不能被选为模板 builder。macOS 上的 dummy orchestrator 不构建模板，也不能替代这一步。

模板构建不是只把一个 Docker 镜像标签写入数据库：template-manager 会准备 Firecracker 可用的模板产物，后续创建沙箱时由 orchestrator 加载。完整的构建服务端实现位于 [`packages/orchestrator/pkg/template/`](../packages/orchestrator/pkg/template/)，API 调度入口位于 [`packages/api/internal/handlers/template_start_build_v2.go`](../packages/api/internal/handlers/template_start_build_v2.go)。

## Local 存储位置

当前 orchestrator 配置使用本地 provider：

| 配置 | 用途 | 当前值 |
|---|---|---|
| `STORAGE_PROVIDER` | 模板和沙箱快照产物的存储后端 | `Local` |
| `LOCAL_TEMPLATE_STORAGE_BASE_PATH` | 模板产物目录 | `./tmp/local-template-storage` |
| `LOCAL_BUILD_CACHE_STORAGE_BASE_PATH` | 构建过程缓存目录 | `./tmp/local-build-cache` |
| `ARTIFACTS_REGISTRY_PROVIDER` | 构建所需镜像的 registry 来源 | `Local` |

这两个目录相互独立：build cache 用于构建过程，template storage 保存之后启动沙箱所需的模板和快照产物。路径是相对 orchestrator 工作目录的；通过 `make -C packages/orchestrator run-local` 启动时，目录位于 `packages/orchestrator/tmp/` 下。切换工作目录或清理这些文件会影响本地缓存和产物。

## 常见问题

- **API 返回未授权**：确认先运行了本地 `seed-database`，且脚本读取的 `.env.local` 与本地 API 使用同一套种子凭据。
- **找不到 template builder**：确认运行的是 Linux 上的真实 orchestrator，且 `ORCHESTRATOR_SERVICES` 包含 `template-manager`；dummy orchestrator 只支持轻量 API 开发。
- **沙箱创建时找不到模板**：先检查 build 是否成功，再确认 orchestrator 仍指向生成该模板的本地存储目录。
- **排查日志**：先看 API 和 orchestrator 的控制台输出；构建日志也会由脚本的 `onBuildLogs` 打印。

## 源码入口

- [`packages/shared/scripts/Makefile`](../packages/shared/scripts/Makefile)：本地构建命令
- [`packages/shared/scripts/build.prod.ts`](../packages/shared/scripts/build.prod.ts)：SDK 构建参数
- [`packages/shared/scripts/template.ts`](../packages/shared/scripts/template.ts)：模板来源定义
- [`packages/api/internal/handlers/store.go`](../packages/api/internal/handlers/store.go)：Local 服务发现
- [`packages/api/internal/template-manager/template_manager.go`](../packages/api/internal/template-manager/template_manager.go)：选择本地 builder
- [`packages/orchestrator/pkg/cfg/storage.go`](../packages/orchestrator/pkg/cfg/storage.go)：本地存储路径解析
- [`packages/orchestrator/.env.local`](../packages/orchestrator/.env.local)：本地角色和存储配置

继续阅读：[Sandbox 生命周期](./sandbox-lifecycle.md)、[Snapshots](./snapshots.md) 和[本地启动顺序](./local-mode-start.md)。
