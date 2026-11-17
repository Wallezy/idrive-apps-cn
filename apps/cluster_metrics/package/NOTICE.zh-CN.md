# 组合仪表数据 · CN Beta

原作者：chyiz。上游：chyiz/idrive7-cluster-metrics，0.6.0，
提交 ff5c83e96133c0e165f1e00167c4dc918dd0f373。主体 MIT 许可。
MGU App Kit 按其独立 MIT 许可保留；渲染客户端由 Robert Nisipeanu
提供，使用 MPL-2.0，完整可编辑源码随包及发行源码归档提供。

CN 发行 0.6.1，修订 1：重新制作简体中文菜单、状态和诊断提示。
保留原数字图集，另以 Noto Sans SC（OFL-1.1）生成简体中文字形。
字形覆盖 GB2312 常用汉字及界面文字；罕见汉字仍可能显示问号。
上游新增 JPEG 解码器版权 notmasteryet，Apache-2.0，许可随包。
字体图集及原始 NOTICE 保留；完整字体许可见 javascript/kit/fonts。
BMW SDK 由安装时的车机 donor 链接，不随包分发。

首次使用默认暂停显示，选择显示位置后开启；默认在导航期间隐藏本应用
HUD 内容。不会执行上游 configure-cluster-slot.sh，也不修改共享显示配置。
原厂告警与图层仲裁仍由 cluster-render 负责。这不代表应用间所有布局已验证。

此版仅 Beta：离线测试不能替代实车验证。上游报告的验证范围为 G30 530e
iDrive 7；其他车型、仪表主题及 CN 全屏地图共存仍需验证。
