# 中文应用商店发行源

本目录收录来自 JackieZ123430/idrive7-apps-cn 的 11 个应用和中文运行库。来源提交、版权与汉化署名记录在 provenance.json 和 NOTICE.zh-CN.md 中。中文画面的 12 px、约 25% 不透明度角落署名保持原样。

应用通过车机商店安装和更新；车机连接可上网的热点后刷新商店列表即可。发行包是无 BMW SDK 的源码包，由商店部署工具使用车机 donor 链接。

## 汉化范围

固定简体中文菜单、设置、提示及内置绘图文字。Doom 的游戏内贴图和关卡文字保留原文；故障数据库中未收录的说明保留原文。

这组应用保持原有软件 PNG 渲染后备路径；存在兼容的 mgu-renderd 时可以使用原有 GPU 协议。商店的 mgu-render 与该协议不同。本次接入不安装额外的 HMI 控制器插件，Doom 的独占旋钮操作需要原有兼容插件；可用的普通 HMI 按钮保持原样。

## 构建与验证（开发机）

运行 `python3 tools/import_localized.py` 生成 apps/ 下的无 SDK 源包目录；通过 `node release/release.js check <应用ID...>` 检查可重复构建。运行 `python3 localized/kit/tools/test_zh.py` 和 `node tools/test_localized.js` 检查界面资源和包结构。

离线演示预览使用模拟数据，不等同于车机或完整车机模拟器验证。实车测试结果单独记录在每次发布的验证报告中。

版本在导入的原始版本上递增一个补丁号。较新英文版不会自动降级为较旧的汉化分支；商店根据实际版本提供可用操作。
