# Local 模式：沙箱运行链路

## 创建沙箱

```text
SDK / curl
  → API :3000：鉴权、检查模板与请求参数
  → PostgreSQL：读取模板等持久数据
  → Orchestrator gRPC :5008：创建沙箱
  → Firecracker：恢复模板快照并启动 VM
  → Envd :49983：完成 guest 初始化
  → Redis：保存运行状态和沙箱到节点的路由记录
```

本地模板和快照使用 orchestrator 的 Local 存储配置落盘，不需要配置云对象存储。构建 `base` 模板是第一次创建沙箱前的准备步骤；具体脚本、服务调用和本地文件位置见[Local 模板构建专题](./local-mode-template-build.md)，操作命令见 [`DEV-LOCAL.md`](../DEV-LOCAL.md)。

## 访问沙箱端口

```text
SDK / 浏览器
  → client-proxy :3002：从请求 Host 解析沙箱 ID 和目标端口
  → Redis：查找沙箱所在节点
  → orchestrator proxy :5007：转发到 VM
  → Envd / VM 内用户进程：处理请求
```

管理 API 不承担沙箱端口的代理。若请求无法到达 VM，先检查 Redis 里的路由状态、client-proxy 和 orchestrator proxy 是否都在运行。

## 暂停与恢复

暂停时，API 通知 orchestrator 保存沙箱状态；恢复时，orchestrator 从本地或持久化的快照和模板产物还原 VM，EnvD 就绪后 API 更新路由。完整状态变化和代码入口见[Sandbox 生命周期专题](./sandbox-lifecycle.md)。

## 快照和持久卷的区别

- **Snapshot** 保存沙箱暂停时的 VM 状态，之后用于恢复或作为模板派生沙箱。见[Snapshots 专题](./snapshots.md)。
- **Volume** 保存团队级文件数据，独立于某个沙箱的销毁和重建；运行中的沙箱通过挂载访问它。Local 模式的挂载类型和目录在 [`packages/orchestrator/.env.local`](../packages/orchestrator/.env.local) 中配置。见[Volumes 专题](./volumes.md)。

需要跨沙箱保留文件时使用 Volume；需要恢复某个沙箱的运行状态时使用 Snapshot。

## 下一步读源码

- API 启动与服务发现：`packages/api/internal/handlers/store.go`
- Sandbox gRPC 服务：`packages/orchestrator/pkg/server/`
- VM 创建与恢复：`packages/orchestrator/pkg/sandbox/`
- 节点内 HTTP 代理：`packages/orchestrator/pkg/proxy/`
- 客户端流量入口：`packages/client-proxy/internal/`
- VM 内 agent：`packages/envd/`
