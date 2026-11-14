# 来源与发行说明

本应用基于 cauliflowermossgrape/idrive7-apps 的 MIT 许可源码及用户提供的同源车机应用导出适配。已将导出的应用主程序与公开仓库固定提交 `8d860de5818a2da11d3a3750aab36866cecf6bde` 逐字节比对，结果一致；运行库、生成资源及中文适配的具体比对记录见 PROVENANCE.json。导出 package.json 中的 UNLICENSED 是生成包的元数据标记，许可依据为已核验公开源码根目录 LICENSE；本包保留该文件及原版权声明。

上游 Copyright (c) 2026 cauliflowermossgrape。中文翻译 Copyright (c) 2026 小白151 (GitHub: JackieZ123430)。翻译署名：抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430。第三方字体按 javascript/kit/fonts/ 下的 SIL Open Font License 1.1 保留许可。

本次新增工作包括商店 donor SDK 链接、简体中文固定资源、遥测读取边界、渲染服务连接兼容和离线验证。源码包不包含 BMW oap-sdk、node_modules、车辆状态、日志或设备身份数据。安装时 SDK 由本车 donor 提供；归档哈希、源版本与公开源码固定提交均记录于 PROVENANCE.json。
