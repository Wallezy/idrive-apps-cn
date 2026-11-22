# Changelog

## Unreleased

## 0.8.1

## 0.6.6 (CN)

- 记住仪表适用的地图传输速率，减少重启后反复掉图。
- 完善掉图原因与恢复日志。

## 0.6.5

改善仪表地图短暂黑屏后的恢复，减少反复掉图。 优化转向卡片避让，保留仪表全屏和防花屏修复。


## 0.6.2

- 修复主题切换时图片尚未上传导致的短暂花屏。

## 0.6.1

- Beta：支持主题场景内嵌实时地图；保留仪表全屏遮罩和映射失败保护。

## 0.5.14

- Remove the experimental map-underlay calibration protocol, grid layers and viewport overrides. Keep the full-panel map gauge mask and normal rendering behavior.

## 0.5.13

- Add the `video_gauge_mask_v1` capability for the ID7 1920×720 panel.
  Atlas and packed video paths share an alpha contour around the OEM
  gauges and speed readout. Masked video never enters opaque compositing
  or claims opaque coverage of underlying layers.
- Hold masked video layers, controls and frames until the current
  connection explicitly confirms support, including after reconnect.
  Shader-template and shader-compilation failures stop that layer.
A layer can ask for upload bandwidth while it is shown (`others_fps`): the
other apps' videos are then written at most that many times a second, 15
at the least, until the layer is hidden or goes or its app exits. The apps
held are told (`fps_cap`).

## 0.7.0

A layer can ask for its target's scene to stay loaded on the cluster while
nothing shows it, so the target appears without loading again when a layer
wants it (`preload`).
