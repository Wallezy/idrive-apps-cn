# Redline HUD 增强版：开发与实车验收

本次保留应用 ID `redline`，在 CN Beta 中更新现有“换挡转速”应用。增加的是挡风玻璃抬头显示 HUD 的布局、换挡提示和信息小窗；仪表扩展地图由独立的地图应用和 `cluster-render` 提供。

## 车上怎样直接看效果

1. 在 CN Beta 更新“换挡转速”，同时完成应用依赖更新：`cluster-render`、`mgu-render` 和 `mgu-deploy`。发布准备阶段会把 `release.json` 中的 `next` 解析为实际版本。
2. 停车、保持车辆通电并打开原厂 HUD，进入“换挡转速 → 设置”，把“显示到 HUD（测试功能）”设为“开启”。
3. 在应用“HUD 外观”页选择布局。默认舒适／节能模式隐藏扩展 HUD；可切至运动模式，或将“舒适／节能模式”改为“与运动模式相同”或“独立 HUD 配置”。这项设置不改变车辆的驾驶模式。
4. 先在中控预览选择“标准、简洁、分翼、复古数字、VFD 荧光、矢量轮廓、弧形、阶梯、圆盘、胶囊”十种布局。车辆静止且 HUD 状态可用时，“在 HUD 演示”会把演示直接显示到抬头显示上；可以在停车状态确认换挡灯、挡位和布局。
5. 用“HUD 位置与大小”调整实际可见位置。默认位置来自上游已测车型，其他车型的光学可见范围仍需实车确认。首次确认效果优先用默认大小；“定位图”是可选的位置检查，不是正常使用前必须完成的日志采集。

## 需要确认的行为

| 操作 | 预期结果 |
| --- | --- |
| 切换十种布局 | 中控预览立即变化；HUD 开启且当前模式允许时，玻璃上的布局同步变化 |
| 修改舒适模式独立配置，再切回运动模式 | 两种模式分别保留布局、尺寸和位置 |
| 将舒适／节能模式设为隐藏 | 扩展内容消失，原厂 HUD 内容保留 |
| 导航有可读转弯提示 | 右下角显示方向／距离小窗；它优先于胎压小窗 |
| 导航正在引导但无法读取下一转弯卡片 | Redline 主动让出 HUD，供原厂导航显示 |
| 无导航提示且胎压条件满足 | 同一角落显示胎压；默认只有低压时出现，可选始终显示 |
| 关闭“显示到 HUD”或车辆断电 | 释放扩展图层及后台 HUD 读取；再次开启后恢复 |

换挡灯随转速和换挡点变化，升挡后结束本次提示；缺少转速数据时不会保留旧的限转提示。演示数据默认关闭，缺少车辆信号不会自动切入模拟读数；中控预览和手动触发的 HUD 演示用于静止时检查外观。真实车辆数据、导航信号、轮胎数据和反应时间学习仍需实车验收。HUD 被原厂弹窗暂时接管时，应用暂停像素上传，恢复后先补发完整图像。

出现位置不合适或遮挡时，可直接关闭“显示到 HUD”，原厂显示随即恢复。Beta 验收完成后再推进 Stable。

## 技术实现与来源

- HUD 采用 CPU 绘制 RGBA 图片，再通过本仓库 `ClusterRender` 客户端发送主图层和导航／胎压共用小窗图层；应用不创建自定义 GPU shader。
- 中控 HUD 编辑页与 HUD 采用同一组绘制模块，可在离线环境生成真实像素预览。
- 中控渲染客户端优先连接 `/run/mgu-render/render.sock`，包含握手超时、旧服务回退和重连清理。
- 已修复增量像素上传失败后静态画面不再重试的问题；失败后下一帧发送完整图像。已修复 HUD 停止后遗留定时器和设置回调重新打开连接的问题。
- 所有设置和原生 RHMI 文本固定为简体中文，单位和字体名保留原名。中文图集由验证过哈希的 Noto Sans SC 生成，字库及许可证随包保留；应用页面无额外署名水印。
- 功能源对应 `cauliflowermossgrape/idrive7-apps` 的 MIT 提交 `8d860de5818a2da11d3a3750aab36866cecf6bde`（Redline 2.0.41）。车机导出中的全部 49 个 JavaScript 模块与该提交逐字节相同，详见 `apps/redline/harvest-provenance.json`。原署名和本次修改说明在应用的 `NOTICE.zh-CN.md` 中保留。

## 离线验证与维护

```sh
REDLINE_PREVIEW_DIR=/tmp/redline-hud-preview node tools/test_redline_enhanced.js
node localized/kit/tools/test_zh.js apps/redline/package/javascript/kit
```

增强测试覆盖 13 组行为：源码包身份和可复现性、SDK 排除、相对依赖完整性、中文和字形、换挡状态、驾驶模式配置、默认布局边界、十种布局像素渲染、关闭 HUD、导航与胎压优先级、原厂导航避让、后台暂停、上传失败重试和停止清理。预览输出为 `/tmp/redline-hud-preview/hud-layouts.png`。这些检查不能替代 MGU、KOMBI 和 HUD 实车集成测试。

本次 `apps/redline/package` 是维护的应用源码树，不能用旧版 `localized/apps/redline` 生成器覆盖。修改中文后运行：

```sh
python3 apps/redline/tools/localize_hud.py
```

增加图集中没有的字时，传入官方 Noto Sans SC 字体，脚本会验证 SHA-256 再生成：

```sh
python3 apps/redline/tools/localize_hud.py --font /path/to/NotoSansSC.ttf
```

固定字体 SHA-256：`a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`。构建保持 `javascript/localized-entry.js` 为入口，先加载链接器生成的 `app.js`；运行时通过 `global.__mguLocalizedSdk` 使用用户自己的 SDK。源码包没有 BMW SDK、`node_modules`、车机状态或日志。

本次 CN Beta 发行号为 `2.0.42`，高于已安装来源版本 `2.0.41`。
