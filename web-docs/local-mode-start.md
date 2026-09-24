# Local 模式：启动顺序

具体命令、系统准备、环境变量和排错步骤统一维护在仓库根目录的 [`DEV-LOCAL.md`](../DEV-LOCAL.md)。按那里完成本地部署后，再用本页检查启动顺序和服务入口。

## 启动顺序

1. 启动 Docker 依赖：`make local-infra`（在 `packages/local-dev` 的 Compose 配置中运行）。
2. 初始化 PostgreSQL、ClickHouse，并构建 envd。
3. 写入本地用户、团队和 API key 种子数据。
4. 分别启动 API、orchestrator 和 client-proxy。
5. 通过本地 orchestrator 构建 `base` 模板，再创建沙箱。

orchestrator 同时启用 `orchestrator,template-manager` 两种角色，所以本地可以用同一进程运行沙箱并构建模板。真实 Firecracker 沙箱需要 Linux 主机或开启嵌套虚拟化的 Linux VM；只有 API 调用链需要时，可以使用 `packages/orchestrator` 的 `run-dummy`。

## 启动后检查

| 检查项 | 地址 / 命令 |
|---|---|
| API 健康检查 | `http://localhost:3000/health` |
| Orchestrator 健康检查 | `http://localhost:5008/health` |
| Client proxy 健康检查 | `http://localhost:3003/health` |
| Client proxy 沙箱流量入口 | `http://localhost:3002` |
| Compose 依赖状态 | `docker compose -f packages/local-dev/docker-compose.yaml ps` |

## 阅读路线

- 先看[本地拓扑](./local-mode-map.md)，了解服务边界和端口。
- 创建沙箱、访问沙箱端口和暂停恢复的流程见[本地运行链路](./local-mode-flows.md)。
- 构建 `base` 模板的 SDK、服务发现和本地磁盘产物见[Local 模板构建专题](./local-mode-template-build.md)。
- 依赖栈、日志和遥测入口见[本地依赖与观测](./local-mode-dependencies.md)。
- 需要追源码时，可以继续读 [Sandbox 生命周期](./sandbox-lifecycle.md)、[Snapshots](./snapshots.md)、[Volumes](./volumes.md)、[Client Proxy](./client-proxy-module.md) 和 [Envd](./envd-module.md)。
