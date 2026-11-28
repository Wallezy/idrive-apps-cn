# idrive7-cluster-metrics

## CN 仪表导航卡片

在商店更新“组合仪表数据”，打开应用的“仪表”设置，可分别开启“仪表转向提示”
和“仪表到达信息”。转向提示显示方向、距离和道路名；到达信息显示预计到达时间、
剩余时长及距离。两个开关初始关闭，转向提示可选择导航期间显示或按距离显示。

卡片使用现有 cluster-render 的 panel 图层，可与现有 Waze 全屏地图配合。
仅 HUD、仅地图区域及应用关闭时不显示卡片。手机导航必须提供车机可读取的结构化
导航数据；只有投屏画面时不显示。导航取消、服务断开或数据过期时清除卡片。
导航提供的到达时间保持其本地时间；推算时间使用车机时区，缺失时采用 UTC+8。

卡片位置以 KOMBI4 的 1920×720 布局为基础，保留现有仪表偏移设置和渲染服务的
原厂内容避让。其他仪表布局、手机导航来源及与原厂告警共存的真车效果仍需验证。

参考实现：Hyperionism/idrive7-cockpit-plus，提交
`0ba2af68b4fe4c4825b2db2f69dab174cc617209`，GPL-3.0-only。
仅复用导航卡片及到达数据处理，不依赖其配套 FullView 工具。

> [!WARNING]
> **Disclaimer**: This is an independent personal project and has **only been tested on a BMW G30 (530e) with iDrive 7**. It is not affiliated with, endorsed by, or supported by BMW or any equipment supplier. Everything in this repository is provided **"as is"** without warranty of any kind — modifying vehicle software or displays can cause unexpected behavior, distract the driver, or void warranties. Use entirely at your own risk.

Standalone BMW iDrive 7 (`MGU` + `KOMBI4` + `HUD`) instrumentation app (`cluster_metrics` / **Cluster Metrics**) that places real-time efficiency, HV battery charge `%`, powertrain temperatures, live boost / cold-rev ceiling, friction-brake force indication, and current forward gear (`1–8` next to `D`) directly into real-car calibrated pockets of the `1920×720` instrument cluster and `800×480` windshield HUD — without covering BMW's telltales, speedometer or right-side Power Gauge needles, lower Fuel/SoC sub-gauges, right-wing Media artwork, or center Navigation map.

Built for a **BMW G30 530e PHEV** (only tested on iDrive 7 G30; includes automatic PHEV / ICE signal detection).

---

## Key Features

> **iDrive Setting Note**: Turn off BMW's optional secondary speed readout under **CAR → Settings → Displays → Instrument panel → Second speed = Off** so the pocket directly below your main digital speed is open.

1. **Native Full-Width iDrive 7 Center Screen UI (`LT_State_Wide`)**:
   - **Main Screen (`MAIN`)**: Native BMW iDrive 7 switches (`Enable cluster & HUD metrics`, `Smart anomaly alerts`) and native dropdowns (`Display target`, `Cluster display mode`, `HUD during navigation`, `HUD Line 1–3`, `Bottom-right indicator`, `Bottom-left temperatures`, `Current gear`, `Friction brake indicator`, `Units`, etc.) spanning the full screen width, with a live status summary row and a button to open Diagnostics.
   - **Live Telemetry & Diagnostics (`DIAG`)**: Dedicated native full-width diagnostics screen showing live sensor values, `cluster-render` slot/layer health, `DSC 0x29` hydraulic brake caliper/master pressure & regen torque, HUD navigation/mini-map state, and Read-Only UDS (`0x22` / `0x01`) counters, plus **Read UDS Sensors Now** and **Record 30s Brake & HUD Nav Probe** (`/tmp/cluster-metrics-probe.log`) buttons.
2. **Below Speed Indicator (`below_speed`, `x: 392..606, y: 429..513`)**:
   - Aligned directly underneath BMW's digital speed readout (`x = 500` right-aligned digits) to stay clear of the center Navigation map.
   - Large `44 px` hero efficiency (`mi/kWh`, `kWh/100km`, or `Wh/mi` in EV; `MPG (US)`, `MPG (UK)`, `L/100km`, or `km/L` in Gas/ICE) + `23 px` live secondary line (`+14.2 kW` / `-26.0 kW` regen / `+8.5 psi` boost / `<3.8k RPM` cold ceiling).
   - Rolling efficiency **holds steady at 0 mph traffic stops**; `FastKw` needle-calibrated interpolation + cooperative `/dev/shm/cluster-info` IPC + self-healing SME UDS auto-wake keep `kW` and `SoC %` live across long drives.
3. **Shift Position (`1`–`8`) Next to Stock `D` (`gear_d`, `x: 1463..1537, y: 650..706`)**:
   - Placed strictly right of KOMBI4's native PRNDL window (`GEAR_WIN` `x: 1380..1460`) and aligned 1:1 with `D`'s real-car baseline (`y = 696`), preventing both glyph clipping and KOMBI4's safety black-box blanking over the Media display.
4. **Hydraulic Friction Brake Indicator (`brake_rail`, `x: 1280..1576, y: 609..640`)**:
   - Dedicated `260 ms` live Read-Only UDS (`0x22`) poller on G30 Brake ECU (`DSC 0x29`: `0xDBE5` / `0xDB29`, active whenever not in Park and off throttle `< 4%` without relying on event-only `statusBrakingDriver`) reads wheel caliper hydraulic pressure (`bar`) directly so pure EV brake-pedal recuperation stays at `0/20` until physical brake pads actually clamp (`>= 1.5 bar`), while pressing the brake firmly when stopped fills all `20/20` segments.
   - Positioned above the bottom bracket line (`y = 630..637`), clear of `Power %` and the `CHARGE` Power Gauge needle, and **hidden automatically when in Park**.
5. **Re-Implemented Right-Wing Cluster Widget (`right_widget`, `x: 1244..1556, y: 214..480`) + BC Stalk Button Cycling**:
   - **Media Playback Page**: Full-color `124×124` JPEG/PNG album art (`HmiMediaState.coverArt` across CarPlay, Bluetooth, USB, Spotify & Radio) with dominant-color ambient radial glow, track title, artist/album, and live playback progress bar (`1:42 / 4:03`).
   - **Trip & Powertrain Page**: Borderless 2×3 OEM readout (`EV Range`, `Fuel Range`, `Trip Distance`, `Gearbox Oil`, `HV Battery Temp` / `IAT`, `12V Aux`).
   - **BC Button Cycling (`KombiIF.statusKombiSelection` + `Light.IndicatorSteeringColumn`)**: Cycles `Media -> Trip -> Off` directly on `panel` (`0x203`).
6. **Bottom-Left Corner Temps (`corner_left`, `x: 8..124, y: 643..709`)**:
   - Large `22 px` bold **`OIL`** and **`CL`** temperatures displayed at all times in both EV and Gas modes.
7. **Bottom-Right Corner Charge / Vital (`corner_right`, `x: 1816..1914, y: 643..709`)**:
   - Defaults to large `28 px` **`SOC` (`HV Battery %`)** on PHEVs (`IAT` on pure ICE cars; configurable to `HV Battery temp`, `Gearbox oil temp`, `12V voltage`, `Intake air temp`, or `Off`).
8. **Full-Width Top Road Banner + Highway Exit Green Badge + 3-Line Windshield HUD (`800×480` on `0x323`)**:
   - **Full-Width Top Road & Highway Exit Banner (`hud_road`, `544×38` at `x: 132..676, y: 100..138`)**: Uses the entire top row of the HUD to render long street names without clipping, plus authentic Highway Green (`#15803d`) rounded-square exit number badges (`[14B]` from `DescriptionElement.icon.text`).
   - **3-Line HUD (`hud_main`, `y: 100..200`)**: Automatically shifts into a compact Row-2 layout (`y: 140..198`) beneath the top road banner during active turns while staying strictly above BMW's Assisted Driving / Adaptive Cruise Control display (`y >= 202`), and overlays cleanly on top of Waze's HUD map when **Maps on Cluster** projects to HUD.
   - **HUD Navigation Re-Renderer + Intersection Mini-Map Auto-Yield (`hudNavMode`)**: Right-side maneuver & 6-lane guidance (`264×232` at `x: 412..676, y: 140..372`) that yields `0x323` **only** when BMW HUD switches to an intersection mini-map (detecting both `GuidanceRenderedContent` `HIGH_GUIDING` / `JUNCTION_VIEW` / `CITY_HIGHWAY_MAP` and parked `status 1 ... map 0` DCSM2 HUD scene `0x01000200`/`0x01000201`).
   - **Consistent Cluster Display Mode (`clusterSlotMode`)**: Defaults to **Full Cluster Panel (`panel_only`)** for a consistent multi-zone + Right-Wing Media/Trip layout regardless of whether BMW Map or CarPlay/Waze is active (with optional **Map Slot Only (`map_only`)** if you prefer KOMBI4's native BC widget).

---

## Quick Start: Local Simulator & Tests

```sh
python3 kit/tools/build.py --stub-sdk cluster_metrics
node test/run_tests.js
node bench/server.js
# Open http://localhost:8078
```

---

## Deploying to Your Car (`MGU` + `cluster-render`)

1. Install **`cluster-render`** (`>= 0.4.0`, `robertnisipeanu/idrive-apps`) and **`cluster_metrics`** (**Cluster Metrics**) via **MGU Store** (`chyiz/mgu-apps`) — **no `cluster-render.local.conf` change is required** (`panel_slot = 0x203` works transparently out-of-the-box).
2. Or build and deploy directly over SSH during development:

```sh
python3 kit/tools/build.py --omit-sdk cluster_metrics
../mgu-store/deploy/hu install --artifact dist/cluster_metrics@0.6.0.tgz --yes
```
