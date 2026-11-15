# 应用增强 CN Beta 发布前调查

调查时间：2026-11-15（Asia/Tokyo）。本次只读核对发布工具、公开目录、已有快照和构建环境；未改全局发行元数据，未读取 OSS 密钥，未上传或发布，也未连接车辆。

本次属于用户明确要求的功能测试：先发 CN Beta，用户上车确认后再发 Stable。

## 当前可用工具

优先使用 `/Users/walle/.codex/worktrees/cn-safety-update/mgu-store/release/` 内的以下工具：

| 工具 | 用途 |
| --- | --- |
| `prepare_cn.py` | 合并两个仓库的本地产物、源码和 bootstrap，检查身份、哈希、依赖闭包，准备完整 Beta 快照 |
| `publish_cn.py` | 核对快照、公开基线、精确提交 CI，先做发布计划；显式 `--publish` 才上传 |
| `promote_cn.py` | 用户验收后，用对应 Beta 快照及证据生成 Stable；本次暂不执行 |

`/Users/walle/Documents/PycharmProjects/mgu-cn-distribution/mgu-store/release/` 也有同名工具，但其中 `publish_cn.py`、`promote_cn.py` 是旧版，缺少现有 Stable 的 `stable-owner-reviewed` 及组件保留验证。新版是最近发行脚本实际使用的版本。两处 `prepare_cn.py` 一致。

新版工具 SHA-256：

```text
prepare_cn.py ae901c2e2c11d233abcbe513a296a5c8d1e4afa7a18f624ec669fd75f640e2e1
publish_cn.py f377f486d6ab158bd23cc7322f62c0bf46301f96f73326b7f2f56891f5f79e06
promote_cn.py 6e553a3337cc0a6789fc51a74bb3ed2d710dc66fdfbbf7fd874fe19a499d0038
```

OSS CLI：`/Users/walle/.config/mgu-mirror/ossutil`，权限 `0700`。
OSS 配置：`/Users/walle/.config/mgu-mirror/ossutilconfig`，权限 `0600`。这里只核对路径和权限，没有打开配置内容。
共用发布工作目录：`/Users/walle/Documents/mgu-cn-publish-runs`。

## 已实时核对的公开基线

本次通过公开 HTTPS 重新读取 Beta、Stable 的 `cn-manifest.json` 及两个仓库目录，并验证两个目录的 SHA-256 均与各自清单匹配。本地读取缓存位于 `/tmp/redline-cn-release-preflight/`。

| 项目 | Beta | Stable |
| --- | --- | --- |
| 根地址 | `https://mgu.walle.pw/mgu/cn/beta/` | `https://mgu.walle.pw/mgu/cn/` |
| manifest SHA-256 | `6996f3408bff9d18c4bb34e4156f9b2c162a7c49cbe18805b51f6b11470e1dd5` | `4e9f94fc82b134629f72d8d707f1542f933dd942770220734be37e8e41be838f` |
| `idrive-apps` commit | `1c83eec6d4d95f18442daed588324fa5a7387370` | `b078d4effdb0bf71d50e94f8af522df1cff75a4e` |
| `mgu-store` commit | `1c34119802d8beaaafa5efe0f31888c757c95219` | 相同 |
| 状态 | `beta-candidate` | `stable-owner-reviewed` |

最近成功发布记录与上述公开哈希一致：

- Beta 完整快照：`/Users/walle/Documents/mgu-cn-publish-runs/20261114T102534Z-cersypfk/snapshot`。
- Stable 完整快照：`/Users/walle/Documents/mgu-cn-publish-runs/20261114T102628Z-cyb4rchp/snapshot`。
- 同内容的准备目录：`/Users/walle/Documents/mgu-cn-distribution-runs/20261114/ambient-watermarks/beta-snapshot`、`stable-snapshot`。
- 最新结果指针：`latest-beta-success.json`、`latest-stable-success.json` 位于共用发布工作目录。`latest-beta-prepared.json` 是更早的一次预备记录，不能作为当前基线。

## 推荐发行号及依赖

下面给出高于当前 CN 和用户导出版本的最小候选发行号。最终由主发布流程统一落地全部版本字段及 Unreleased；这里没有修改版本。

| ID | 当前 CN Beta | 用户导出 | 推荐本次发行号 |
| --- | --- | --- | --- |
| `redline` | 1.8.3 | 2.0.41 | **2.0.42** |
| `car_vitals` | 2.13.2 | 2.27.3 | **2.27.4** |
| `edrive` | 2.0.3 | 2.9.2 | **2.9.3** |
| `dtc_scanner` | 2.6.5 | 2.9.7 | **2.9.8** |
| `zf8hp` | 未列入目录 | 1.5.6 | **1.5.7**（新组件初始号） |
| `cluster-render` | 0.5.12 | 本次按既有 CN 组件升级 | **0.5.13** |
| `robertn_waze_cluster` | 0.6.13 | 沿用既有 ID | **0.6.14** |
| `waze-on-cluster` | 0.9.15 | 沿用既有 ID | 如果产物改变则 **0.9.16** |

直接从当前较旧 CN 号做一次 patch 递增，会低于 Redline/M Vitals/eDrive/DTC 的导出安装版本，因此不能只依赖默认 patch 自动编号。新包字节必须使用新号，不能覆盖已发布同号产物。

当前两个渠道共用的 Store 依赖版本：

| ID | 版本 |
| --- | --- |
| `mgu-deploy` | 0.8.20 |
| `mgu-render` | 0.6.23 |
| `mgu-updater` | 0.8.46 |
| `robertn_store` | 0.9.43 |

若本次不改 Store 仓库，直接复用当前 Beta 的整个 `mgu-store` 源码、产物、图标和 bootstrap。不要把旧文档里的 0.8.18／0.6.21 当成当前公开版本；应用依赖中的较低号是最低兼容要求。将 `cluster-render: "next"` 解析为本次实际 core 版本后检查完整依赖闭包。

## 双构建环境

`limactl list` 已确认 `mgu-cn-build` 正在运行。只读检查结果：

- Linux Node `v22.22.1`，Docker 服务端 `29.9.3`。
- 可用镜像包括 `cluster-render-build:2597260322`、`mgu-render-target:a7e89adfd0715210`、`node:8.16.2-stretch`。
- 当前 Codex 工作树路径不在 VM 挂载目录中；旧 `/Users/walle/Documents/PycharmProjects/mgu-cn-distribution/idrive-apps` 目录以只读方式挂载，且该目录不是本次提交。应传入已完成版本处理的确切提交，不能误用它构建。
- 可沿用既有方案：创建包含提交历史和 tags 的 Git bundle，使用 `limactl copy` 传至新 VM 目录，分别克隆成 build-1、build-2，明确 checkout 同一个发行 SHA。若有 submodule，还要带齐该 SHA 记录的子模块内容。

原生部分的目标工具链是 Docker 内 Ubuntu 18.04 x86-64、GCC 7.5、glibc 2.27。JS 源码包可在宿主机做两次 clean-export 构建；`cluster-render`、`waze-on-cluster` 的目标构建在 Lima 内进行。

`node release/release.js check <ids...>` 会从 `git archive HEAD` 建两遍并比较 SHA-256。它验证的是已提交 HEAD，未提交的工作树不会进入产物。保留可发布文件时可分别执行两次 `build`，各自保存 `release/out/`，比对目录和每个 artifact 的哈希。

既有参考脚本：

- `/Users/walle/Documents/mgu-cn-distribution-runs/20261114/upstream-sync/run_vm.py`：bundle 独立 clone、原生双构建和日志。
- `/Users/walle/Documents/mgu-cn-distribution-runs/20261114/upstream-sync/collect_builds.py`：收集双构建结果和逐包哈希。
- `/Users/walle/Documents/mgu-cn-distribution-runs/20261114/ambient-watermarks/build_apps.py`：宿主机应用双构建。

旧 VM 脚本包含 rootless Docker 的本地 `docker` 包装器（位于 `/home/walle.linux/cn-upstream-20261114/bin`，将容器 uid 改为 `0:0`）。这是构建环境适配，应记录到本次构建说明，不写入产品包。

## 最终准备顺序

1. 完成源码整合、中文测试、SDK-free 源码打包检查及版本处理，提交并固定发行 SHA。确认 `cn-localization-versions.json` 等版本一致性检查覆盖新增 `zf8hp`。
2. 对最终 SHA 运行测试与两次构建，确认包名、入口、应用 ID、资源闭包和哈希。更新分支触发精确 SHA 的 `Test`、`CN source checks`；发布工具还会核对 Store 对应提交的工作流。
3. 以已核对的完整 Beta 快照为输入，只替换本次改变组件，并追加 `zf8hp`。目前历史 `prepare_release.py` 只遍历旧组件；复用时必须显式追加新 ID，避免构建了 ZF 8HP 却没有放进目录。
4. 输入目录使用扁平本地 artifact/icon 文件名，准备两个仓库相应的 `git archive --format=tar.gz` 源码和精确哈希验证记录。未实车验证的 integration 保持 `pending`，不得填成已通过。调用 `prepare_cn.py --channel beta` 生成完整快照。
5. 使用 `publish_cn.py --channel beta --snapshot <目录> --expect-snapshot <SHA256> --ossutil <路径> --config <路径> --work-dir <共用目录>` 生成只读发布计划。核对计划后，用相同快照与哈希加 `--publish` 完成已授权 Beta 发布。
6. 发布后重新读取公开 manifest/catalog，并检查 SHA、版本、下载资源及依赖一致性。用户按应用文档上车更新测试。本次流程到 Beta 发布和反馈等待为止；后续 Stable 使用用户通过验收的同一批包字节。

此文档是本机发布调查记录，不是本轮已完成构建、CI 或发布的证明。
