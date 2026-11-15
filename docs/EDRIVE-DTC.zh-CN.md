# eDrive 与故障检测增强

这次将 eDrive 的电池页面、主页卡片，以及故障检测的滚动列表和独立中文说明库移入现有 CN 应用包。继续使用原应用 ID，本次发行号分别为 `2.9.3` 与 `2.9.8`，用于直接升级原应用。变更记录在各应用 `package/CHANGELOG.md`。本次仅离线开发与测试，未连接车辆、未安装应用、未发布 Stable。

## eDrive 的变化

- 插电混动车型：续航、能量、电池健康、各电芯电压与温度、充电记录。主页卡片显示功率、电量、续航与行程能量；同时包含原生卡片 RHMI 布局和绘图资源。
- 48V 车型：电池电量、电压、功率、健康度、温度，以及 48V/12V DC/DC 转换器与电池详情。
- 无混动系统：12V 电压、传感器可提供的电流/电量/健康度、最近趋势、历史和行程统计。不同车型不支持的读数留空。
- 快速功率使用车辆动力信号与已测电池读数拟合。校准样本不足、无效数据或信号过期时不伪装成有效估算。估算数值带 `~`，状态明确带“估算”；电池直接读取值保留原本显示。
- 三种系统的主轮询统一使用活动门控。停车且十分钟未操作时停止诊断轮询；最近三分钟内驾驶/发动机运行属于活动状态。重新打开主页面、切换页面或手动读取可恢复。收到车辆已锁定离开状态时自动读取也停止。实时功率、电芯与主页卡片的读取沿用同类门控。
- 12V 电压优先读上次成功来源，连续三次失败才改探其他候选，避免短暂丢包触发全量重探。

`demo` 默认设为 `off`。没有诊断连接时显示不可用或等待数据，不自动填入演示数值。离线预览显式选择 `on` 并显示“演示”。如果旧安装保存过演示设置，升级会保留用户设置，需要在车上确认该项关闭。

## 故障检测的变化

长故障列表可通过触摸或旋钮滚动。诊断句子使用单独的 `diagnostic-text.js` 与 `diagnostic_i18n.pack`，不会套用仪表 UI 的逐词替换（例如把 ACC 控制单元误换成“加速”）。

随包中文目录覆盖该版本数据库的 86,735 条源描述，含规范化别名及补充条目共 87,210 个查找键。此数字只描述随包数据库，不代表覆盖全部 BMW 故障。词库来自公开上游的机器辅助翻译，未逐条通过人工审核；内部标识、数值和十六进制消息 ID 保留。找不到翻译时保留完整原文，原数据库缺少说明时不根据故障代码编造解释。专用 Noto Sans SC 字形图集随包包含。

清码仍由用户连续两次确认触发，首次点击只进入五秒确认状态。五秒超时或离开主页面会取消待确认清码。启动、扫描、滚动和一次点击不会清码。确认后保留上游已有的清码与重新扫描逻辑。离线测试仅对假的诊断传输执行断言，没有向车辆发送任何清码服务。

## 源码、许可证与维护位置

公开上游：`https://github.com/cauliflowermossgrape/idrive7-apps`，固定提交：

```text
8d860de5818a2da11d3a3750aab36866cecf6bde
```

eDrive 对应上游 2.9.2，故障检测对应 2.9.7。比对所提供导出的应用 JavaScript 与上游文件，全部逐字节一致；26 个 kit 运行库 JavaScript 文件和 DTC 数据库也一致。安装前归档用来补齐活动源码目录中缺少的 RHMI 及主页卡片资源。公开源码根目录的 MIT 许可证与上游/中文贡献署名随包保留；生成安装包的 `UNLICENSED` 元数据不替代已核实的公开许可证。来源、归档哈希、公开提交和主要改动记录在各包 `PROVENANCE.json`。

维护文件直接位于：

```text
apps/edrive/package/javascript/
apps/dtc_scanner/package/javascript/
apps/edrive/package/rhmiDataStartWidget/
```

增强版本使用各应用局部的 kit，不修改其他应用共享运行库。`localized-entry.js` 首先加载生成的 `app.js` SDK 桥，再由 `kit/mgu.js` 读取 `global.__mguLocalizedSdk` 的 `OnlineApp` 与 `logging`。现有 `src/sdk.js` 已提供这两个 API。发布源包不含生成桥、`node_modules`、BMW SDK、车辆状态或日志；安装构建仍使用车机 donor 机制。

两个应用要求 `mgu-deploy >= 0.8.18`、`mgu-render >= 0.6.21`。应用局部渲染客户端复用仓库已修正版本：优先使用 CN socket，握手超时、格式异常与断线重试均保留。渲染传输不改变诊断读写权限。

诊断中文资源按固定公开提交的 `kit/tools/build_diagnostic_zh.py` 中 `catalog()` 及 `kit/tools/pack_data.py` 中 `pack()` 生成；图集来自同一提交 `kit/localization/fonts/diagnostic-zh-CN.json`。更新词库时必须同时运行完整查找、字形、原文回退和 ID 保留检查，不能只替换中文 JSON。

## 离线验证

```sh
node tools/test_edrive_dtc_enhanced.js
node localized/kit/tools/test_zh.js apps/edrive/package/javascript/kit
node localized/kit/tools/test_zh.js apps/dtc_scanner/package/javascript/kit
```

增强测试共 13 组，涵盖源码包确定性及依赖闭包、SDK 排除、主页卡片和中文诊断包实际打包、估算校准与信号过期、闲置停读/恢复、连续读取来源选择、三种系统的 11 个完整页面、主页卡片、87,210 项中文查找及字形/ID、原文逐字绘制、故障列表滚动、首次点击/超时/离页不得清码及二次确认后的调用。

设置 `MGU_PREVIEW_DIR` 可以保存明确标注演示数据的页面 PNG：

```sh
MGU_PREVIEW_DIR=/tmp/edrive-dtc-previews node tools/test_edrive_dtc_enhanced.js
```

另外执行并通过了公开上游 `kit/tools/test_diagnostic_zh.js`：87,210 查找项、13,436 个十六进制 ID 保留断言，诊断图集 1024×1689；仓库 `tools/test_localized.js` 全部 14 应用通过，渲染客户端的 16 个真实 Unix socket 场景通过。这些测试不代表实际 MGU 固件/诊断接口验证。

CN Beta 实车验收还需确认原应用升级后能进入页面、车型自动识别与读数有效、主页卡片可添加和缩放、滚动手感及停车停读恢复。故障说明应与原始故障码/原文一同核对；日常验收无须执行清码。实车验收通过后才进入 Stable 发布流程。
