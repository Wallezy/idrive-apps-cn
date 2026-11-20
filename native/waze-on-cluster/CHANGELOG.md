# Changelog

## Unreleased

## 0.10.13

- Keep diagnostic journals in RAM; preserve bounded failure and shutdown logs with CN diagnostics.

- 修复 Android Auto 显示未就绪时异常退出，并完善自动恢复。
- 保留全屏、显示位置和 HUD 设置，补充故障诊断信息。

## 0.10.5 (CN)

- 修正兼容 CarPlay 地图的到达时间显示请求。
- 改进日志导出，减少无关内容并隐藏敏感信息。

## 0.10.4

支持兼容的 CarPlay 地图显示到达时间卡片。 完善旧补丁升级与恢复处理。

## 0.10.1

- Beta：适配主题内嵌地图的裁切、隐藏与重连，保留仪表盘全屏切换。

## 0.9.16

- Add `panel_gauges` as a logical cluster target, using the full physical
  ID7 panel and the renderer's gauge alpha mask.
- Report mask support to the settings application. Reject unsupported
  mode changes and stop a retained expanded layer if a restarted renderer
  does not support its mask. Standard map mode remains available.
## 0.10.12

The diagnostic journal is kept in memory and written to storage only around
failures and at shutdown, which greatly reduces writes to the head unit's
storage.
