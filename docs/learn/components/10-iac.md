# IaC：云底座与 Nomad 部署编排

> `iac/provider-gcp`、`iac/provider-aws` 和 `iac/modules` 把云资源、Nomad/Consul 节点池与应用作业装配成一套可部署的 E2B 集群。

## 1. 系统位置

IaC 位于源码构建产物和运行中服务之间，负责把“镜像/二进制需要什么”翻译为云资源、节点 metadata、环境变量、端口、服务发现和持久化配置。

```text
构建产物
  ├─ 容器镜像: API / Client Proxy / migrators
  ├─ 原生二进制: Orchestrator / Template Manager
  └─ 节点镜像: Packer image with Nomad / Consul / Firecracker
          │
          v
provider-gcp 或 provider-aws
  ├─ init/bootstrap: bucket / registry / secret / IAM (+ AWS network)
  ├─ cluster: VM node pools + startup scripts
  ├─ edge: DNS / TLS / load balancer / firewall
  └─ nomad: 复用 iac/modules/job-*
          │
          v
Nomad allocations + Consul/Nomad service discovery
```

云 provider 负责资源差异；`iac/modules/job-*` 负责尽量云无关的运行时 jobspec。

## 2. 启动/装配

两套 provider Makefile 都从仓库根的 `.last_used_env` 和 `.env.<env>` 读取环境，再把大写部署变量映射为 `TF_VAR_*`。

部署入口相似，但 bootstrap 不能当成完全统一的流程：

1. 两端的 `make init` 都创建远程 Terraform state bucket、初始化 backend，并 target `module.init`。
2. GCP `make init` 还配置 state bucket versioning/lifecycle，并直接运行 `nomad-cluster-disk-image init build`；GCP 网络由后续 `module.cluster`（`nomad-cluster`）创建，不属于 `module.init`。
3. AWS `make init` 不构建 AMI；完整 plan 前必须额外执行 `make -C nomad-cluster-disk-image init build`。否则各 nodepool 的 account-owned `data.aws_ami` 查询没有可匹配镜像。AWS 的 VPC/subnet 则属于 `module.init` 内的 cluster bootstrap。
4. `terraform plan` 创建不可变 plan 文件；`make apply` 只应用该 plan。
5. provider root 装配 cluster/nodepool 资源，再装配 `module.nomad` 并实例化共享 `job-*` modules。
6. `plan-only-jobs` 可只计划 Nomad jobs；`plan-without-jobs` 可只看云资源，降低发布时的变更面。

## 3. 核心机制与关键对象

### 3.1 Bootstrap 层

GCP `init/` 启用 Secret Manager、Certificate Manager、Compute、Artifact Registry、Monitoring、Logging、Filestore API，创建 service account、Artifact Registry 和多类 GCS bucket。

AWS `init/` 创建 VPC、三可用区 public/private/ElastiCache subnets、NAT/VPC endpoints、S3 buckets、ECR repositories、Secrets Manager secrets，以及 Cloudflare token/集群 ACL 输出。

模板、构建 cache、Firecracker kernel/version/envd/busybox、实例启动脚本、Loki 数据和 ClickHouse backup 使用不同 bucket，生命周期和权限也分别配置。

### 3.2 节点与调度层

GCP 以 instance template 和 managed instance group 创建 control server、API、build/client worker、ClickHouse、Loki 等节点；动态 build/client 配置可创建多个 worker cluster。Filestore 可挂载共享 chunk cache，persistent volume types 则创建独立 NFS endpoint。

AWS 以 launch template、Auto Scaling Group 或固定 EC2 instance 创建对应节点池；ClickHouse 使用固定 AZ 的 EBS volume。VPC 内节点共享安全组并允许集群内部通信。

启动脚本从 setup bucket 下载带内容 hash 的 `run-consul.sh`/`run-nomad.sh`，读取实例 metadata/tags 并生成本机配置。Consul 注册为 systemd service，Nomad 由 Supervisor 托管。Consul 提供 `.service.consul` DNS，Nomad node pool、meta labels 和 `job_constraint` 决定 job 落点。

client/build 节点还配置 Firecracker 目录、NBD、huge pages、快照/cache 挂载和容器 registry 登录；它们不是普通无状态应用节点。

### 3.3 应用作业层

`iac/modules` 当前包含：

| Job module | Nomad 类型 | 主要落点/职责 |
| --- | --- | --- |
| `job-api` | service | API 节点；含 prestart DB migrator |
| `job-dashboard-api` | service | dashboard API |
| `job-ingress` | service | Traefik HTTP/H2C 路由 |
| `job-client-proxy` | service | sandbox 公网流量代理 |
| `job-orchestrator` | system | 每个 client 节点一个 raw_exec 编排器 |
| `job-template-manager` | service | build 节点构建器，数量匹配节点 |
| `job-template-manager-autoscaler` | service | 自定义 APM 驱动的 job scaling |
| `job-otel-collector` | system/all | 每节点 OTLP、host、Nomad client metrics |
| `job-otel-collector-nomad-server` | service | 发现并抓取 Nomad server metrics |
| `job-logs-collector` | system/all | 每节点 Vector HTTP 日志入口 |
| `job-loki` | service | 集群内日志存储/查询 |
| `job-clickhouse` | service/batch | server、migrate、backup/restore |
| `job-redis` | service | 未启用 managed Redis 时的 fallback |

jobspec 经 Terraform `templatefile` 注入镜像、端口、资源、环境变量和动态配置，再由 `nomad_job` resource 提交。

### 3.4 公网入口

GCP 使用 Cloudflare DNS、Certificate Manager、global HTTPS forwarding rule、URL map、backend service、Cloud Armor 和 health check。`api.<domain>`、`docker.<domain>`、`nomad.<domain>` 与 wildcard sandbox/session host 路由到不同 instance group；部分 API path 可转到 Traefik ingress。

AWS 使用 Cloudflare wildcard CNAME、ACM wildcard certificate 和 public ALB。HTTP 重定向 HTTPS，gRPC 按 `content-type` listener rule 进入 GRPC target group，`nomad.<domain>` 单独进入 Nomad target group，其余进入 Traefik。

### 3.5 环境变量是运行时接线板

provider root 的 locals 将云 secret、bucket、Consul service name 和固定端口合成各服务 env：

- API 得到 PostgreSQL、Redis、Loki、ClickHouse、Nomad token 与内部 gRPC port。
- Client Proxy 得到 Redis catalog 和 `api-internal-grpc.service.consul`。
- Orchestrator 得到 storage/registry provider、模板 bucket、共享 cache、卷挂载与 Consul token。
- Template Manager 得到 registry、build cache、Nomad 和对象存储配置。
- 所有主要服务把 OTLP 指向本机 `localhost:4317`，日志 HTTP 指向本机 `localhost:30006`。

## 4. 主数据/部署流

```text
.env.<env> + tfvars
       │
       v
provider Makefile -> terraform plan/apply
       │
       ├─ init module
       │    ├─ state-independent buckets/registries
       │    ├─ IAM/service account/roles
       │    └─ secrets and ACL material
       │
       ├─ Packer image + hashed startup scripts
       │                 │
       │                 v
       ├─ node pools -> Consul + Nomad agents -> node_pool/meta
       │
       ├─ DNS/TLS/LB/firewall -> API/Ingress/Proxy/Nomad backends
       │
       └─ Nomad provider -> job modules -> allocations
                                  │
                                  ├─ localhost collectors
                                  └─ *.service.consul dependencies
```

应用镜像通常从 Artifact Registry/ECR 的 `latest` 解析为具体 digest；raw_exec 二进制从 pipeline bucket 读取，并把对象 hash/etag 放进 artifact URL 或 job ID 触发滚动更新。

## 5. 设计不变量与故障边界

- Terraform state 必须使用对应环境的远程 bucket；切环境要重新初始化 backend，不能复用本地 state 假设。
- `module.init` 是显式第一阶段。API 尚未启用、bucket/secret 尚未存在时直接全量 apply 会产生时序失败。
- secret resource 与 secret value 的所有权可能不同；多个 placeholder 使用 `ignore_changes`，外部写入的生产值不能被 Terraform 覆盖。
- image family、node pool、Nomad constraint 和实例 metadata 必须匹配，否则 job 会永久 pending 或跑到错误节点。
- system collector/log job 必须覆盖所有 node pools；服务使用 `localhost` 是依赖该共置不变量。
- Consul DNS 名、静态端口和 LB named port 是跨层契约；修改必须同时更新 provider locals、jobspec、health check 和应用配置。
- ClickHouse 节点/磁盘是有状态的，不能按普通 ASG/MIG 无状态替换。
- raw_exec 作业依赖宿主镜像和 pipeline bucket；容器镜像发布成功不代表 orchestrator/template-manager 已可部署。
- GCP 与 AWS 不完全对称。GCP 有 Filestore、多 worker cluster、可选 Anywhere Cache 和当前关闭的 ArgoCD app 输出；不能假设 AWS 变量在 GCP 有同义实现。
- `moved.tf`、state-migrate 目标表示资源地址演进；删除或绕过它们可能导致 Terraform 计划重建真实基础设施。
- `plan-only-jobs` 是发布工具，不是依赖求解替代品；新增 job 所需云资源时仍需完整 plan。
- 负载均衡健康和 Nomad/Consul 健康是不同层；一层 healthy 不证明端到端路由可用。

## 6. 与其他组件边界

| 对方 | IaC 负责 | 对方负责 |
| --- | --- | --- |
| 应用源码 | env、端口、镜像/二进制、资源限制 | 参数解析、业务启动与优雅退出 |
| Shared | 选择 storage/registry provider 和 OTLP endpoint | 云抽象与协议实现 |
| Nomad/Consul | 节点配置、ACL、jobspec、服务注册 | 调度、健康与 DNS 运行时状态 |
| ClickHouse/Loki/Redis | 实例、bucket、凭据、保留和 job | 数据语义、查询与客户端行为 |
| Cloudflare/LB | DNS、证书验证、Host/path 路由 | 应用级鉴权和 sandbox 目标解析 |
| CI/CD | 提供可消费的 image、AMI/GCE image、binary | Terraform 决定何处运行和如何连接 |

## 7. 源码阅读顺序

| 顺序 | 路径 | 先回答的问题 |
| --- | --- | --- |
| 1 | `iac/provider-gcp/main.tf` 或 `iac/provider-aws/main.tf` | 顶层模块和 env 如何接线？ |
| 2 | 对应 provider `Makefile` | 环境、state、plan/apply 流程是什么？ |
| 3 | 对应 provider `init/` | 哪些资源必须先存在？ |
| 4 | 对应 provider `nomad-cluster/` | 节点池、IAM、磁盘和脚本如何创建？ |
| 5 | `run-consul.sh`、`run-nomad.sh` | metadata 如何变成本机 agent 配置？ |
| 6 | 对应 provider `nomad/main.tf` | 哪些共享 job 被启用？ |
| 7 | `iac/modules/job-api/`、`job-orchestrator/` | service job 与 system job 如何部署？ |
| 8 | `iac/modules/job-otel-collector/`、`job-logs-collector/` | 每节点 sidecar 契约如何成立？ |
| 9 | GCP `nomad-cluster/network/` 或 AWS `alb.tf` | 公网请求如何进入集群？ |
| 10 | `nomad-cluster-disk-image/` | 节点镜像提供了哪些运行前提？ |

## 8. 相关深挖

- [Node 模块](../../md/node-module.md)：节点抽象、健康、drain 与 autoscaling。
- [Sandbox 流量路由](../../md/sandbox-traffic-routing.md)：LB、Client Proxy 与 Orchestrator Proxy 的请求链路。
- [Orchestrator 模块](../../md/orchestrator-module.md)：client node 上 system job 的运行时职责。
- [ClickHouse package](../../clickhouse-package.md)：有状态节点、迁移与备份作业。
- [Docker Reverse Proxy](../../docker-reverse-proxy.md)：`docker.<domain>` 路由和 registry 边界。
- [OIDC 演进](../../oidc-history.md)：auth provider 配置与云 secret 的部署历史。
