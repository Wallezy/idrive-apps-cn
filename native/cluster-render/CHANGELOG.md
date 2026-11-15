# Changelog

## Unreleased

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

