# 发布软件包到 e2b-artifacts

> 本文译自 `docs/RELEASING.md` 的 **2026.30** 版本（原文 41 行 → 57 行，发布流程整体移出本仓库）。技术名词、镜像地址、包路径、环境变量一律保持原文。

> ⚠️ **反直觉点：本仓库是只读镜像（read-only mirror），在这里找不到 release tag 或 GitHub Release 是设计如此，不是配置遗漏 —— 发布流程整体在 E2B 内部 monorepo 里。**

本仓库是只读镜像：它的 source of truth 是 E2B 的内部 monorepo，由后者通过 copybara 把代码导出到这里。发布同样在 monorepo 里完成 —— [release-please](https://github.com/googleapis/release-please) 配置、per-package release PR、`<component>-v<version>` git tag 以及 publish workflow 全部位于 monorepo（这里每个包的目录对应那边的 `go/oss/<directory>`）。本仓库中不会出现 release tag 或 GitHub Release。

| Component | Package directory | Published artifact |
|---|---|---|
| api | `packages/api` | images `us-docker.pkg.dev/e2b-artifacts/api/api` 和 `…/api/db-migrator`（作为一个单元发布） |
| client-proxy | `packages/client-proxy` | image `us-docker.pkg.dev/e2b-artifacts/client-proxy/client-proxy` |
| clickhouse-migrator | `packages/clickhouse` | image `us-docker.pkg.dev/e2b-artifacts/clickhouse-migrator/clickhouse-migrator` |
| dashboard-api | `packages/dashboard-api` | image `us-docker.pkg.dev/e2b-artifacts/dashboard-api/dashboard-api` |
| envd | `packages/envd` | binary `https://storage.googleapis.com/e2b-artifact-binaries/envd/v<version>/envd` |
| nomad-nodepool-apm | `packages/nomad-nodepool-apm` | binaries `nomad-nodepool-apm`、`nomad-deployment-aware-target`，位于 `…/nomad-nodepool-apm/v<version>/` |
| orchestrator | `packages/orchestrator` | binaries `orchestrator`、`clean-nfs-cache`，位于 `…/orchestrator/v<version>/` |

> ⛔ **`docker-reverse-proxy` 这一行已从表中删除。** 2026.29 的表还有一行 `docker-reverse-proxy` → `packages/docker-reverse-proxy` → 镜像 `us-docker.pkg.dev/e2b-artifacts/docker-reverse-proxy/docker-reverse-proxy`；该包在 2026.30 整体退役（目录下 19 个文件全部删除，现存 0 个），因此不再有可发布的制品。
>
> 表头也从 2026.29 的 `Image` 改为 `Published artifact`：2026.30 起本表不再只描述镜像，`envd`、`nomad-nodepool-apm`、`orchestrator` 发布的是 bucket 里的二进制。

## 一次发布是如何发生的

1. monorepo 中触及某个包目录的 conventional commits（`feat:`、`fix:`）会累积成由 monorepo 的 Release Please workflow 维护的 per-package release PR。（同样的 commit 会通过 copybara 导出到这里，所以本镜像的 git 历史能反映每个 release 包含了什么。）
2. 合并该 release PR 会在 monorepo 中给 merge commit 打上 `<component>-v<version>` tag（只是一个 git tag —— 不会创建 GitHub Release）。
3. tag push 触发 monorepo 的 publish workflow，它用本镜像所展示的同一份源码构建制品并推送到 `e2b-artifacts` —— 镜像以 `:v<version>` 形式发布，二进制以带版本号的对象形式发布到公开的 `e2b-artifact-binaries` bucket。

普通 merge 永远不会发布：只有 release PR 合并（或下面的手动 tag）才会产生 tag。

## Release candidate / 手动发布

在 monorepo 中手动推送一个 `<component>-v<version>` tag（例如 `client-proxy-v2.0.0-rc1`），publish workflow 就会把那个 commit 发布为 `:v2.0.0-rc1`。registry 的 tag 不可变，**且 binaries bucket 是 create-only**，所以手动 tag 永远无法覆盖已存在的版本 —— 发布出去的坏版本只能通过切下一个版本修掉，绝不能靠重新发布。

## 故障恢复

所有恢复操作都在 monorepo 中进行：

- **Publish 失败**：重新运行该 tag 的 publish run（任何时候都可以），或者用 tag 名字手动 dispatch publish workflow。
- **Release 已合并但从未打 tag**（例如那次合并不是它所在 push 的 head commit）：在 merge commit 上手动推送 `<component>-v<version>` tag，并把 release PR 的 label 从 `autorelease: pending` 换成 `autorelease: tagged` —— 否则 release-please 会拒绝为任何包开新的 release PR。

---

> 已同步至 **2026.30**。结构与内容按 tag `2026.30` 的 `docs/RELEASING.md`（57 行）逐节核对；发布流程本身已移出本仓库，改动需在 monorepo 侧进行。
