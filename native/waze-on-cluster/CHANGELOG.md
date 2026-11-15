# Changelog

## Unreleased

## 0.10.1

- Beta：适配主题内嵌地图的裁切、隐藏与重连，保留仪表盘全屏切换。

## 0.9.16

- Add `panel_gauges` as a logical cluster target, using the full physical
  ID7 panel and the renderer's gauge alpha mask.
- Report mask support to the settings application. Reject unsupported
  mode changes and stop a retained expanded layer if a restarted renderer
  does not support its mask. Standard map mode remains available.

