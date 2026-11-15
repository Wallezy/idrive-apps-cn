# 汉化署名与来源

本仓库的简体中文汉化由 **抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430** 维护。

- 汉化仓库：https://github.com/JackieZ123430/idrive7-apps-cn
- 上游项目：https://github.com/cauliflowermossgrape/idrive7-apps
- 汉化部分 Copyright (c) 2026 小白151 (GitHub: JackieZ123430)，按仓库 MIT 许可证提供。

请在转载、分发或修改版本时保留上游许可证、版权声明及汉化署名，并清楚标明修改来源。
本仓库没有设置付费激活、联网授权或收费下载。若有人收费提供安装服务，该收费并非本仓库的下载费或授权费，请自行核对服务内容。

这份来源说明不更改上游开源许可证，也不额外限制其已授予的权利。Doom/Freedoom 相关组件继续适用各自原有许可证。

中文绘制字形来自 Noto Sans SC，使用 SIL Open Font License 1.1；许可证随字库存放在
`javascript/kit/fonts/OFL-NotoSansSC.txt`。BMW 的原厂 oap-sdk 必须从使用者自己的车机提取，不公开分发。

## 本次 HUD 研发移植

Redline HUD 扩展对应公开仓库 `cauliflowermossgrape/idrive7-apps` 的固定提交
`8d860de5818a2da11d3a3750aab36866cecf6bde`（Redline 2.0.41）。在本次中文化和兼容修复前，使用者提供的
`redline@2.0.41.tgz` 内全部 49 个 JavaScript 模块与该提交的 `apps/redline/`、`kit/runtime/`
逐字节一致。逐文件哈希和比对结论记录在应用源码目录的 `harvest-provenance.json`。
公开源码按 MIT 许可证提供，原版权和许可全文保留在本包 `LICENSE`；生成包中的 `UNLICENSED`
元数据不是本次授权依据。

HUD 原始实现署名 `@biscotit`；HUD 可见窗口尺寸的原始注释引用 `bimmer-lab/apps shared/visible.js`（MIT）。
`javascript/cluster_render_client.js` 使用本仓库 MPL-2.0 客户端，Copyright (C) 2026 Robert Nisipeanu，
其源码随包公开提供，许可全文在 `MPL-2.0.txt`。新增 HUD 中文设置、资源整理、帧上传重试和退出清理修复
及离线回归由 Codex 完成，尚未在本车验收。
