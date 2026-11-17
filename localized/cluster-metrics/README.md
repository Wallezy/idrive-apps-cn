# idrive7-cluster-metrics

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
   - Reads live hydraulic brake pressure (`bar`) from the G30 Brake ECU (`DSC 0x29` Read-Only UDS `0x22`: `0xDBE5` / `0xDB29`, with longitudinal force-balance fallback) so pure EV brake-pedal recuperation stays at `0/20` until physical friction brake pads actually clamp (`>= 1.5 bar`), while pressing the brake firmly when stopped fills all `20/20` segments.
   - Positioned above the bottom bracket line (`y = 630..637`), clear of `Power %` and the `CHARGE` Power Gauge needle, and **hidden automatically when in Park**.
5. **Bottom-Left Corner Temps (`corner_left`, `x: 8..124, y: 643..709`)**:
   - Large `22 px` bold **`OIL`** and **`CL`** temperatures displayed at all times in both EV and Gas modes.
6. **Bottom-Right Corner Charge / Vital (`corner_right`, `x: 1816..1914, y: 643..709`)**:
   - Defaults to large `28 px` **`SOC` (`HV Battery %`)** on PHEVs (`IAT` on pure ICE cars; configurable to `HV Battery temp`, `Gearbox oil temp`, `12V voltage`, `Intake air temp`, or `Off`).
7. **3-Line Configurable Windshield HUD + Full-Height Vector HUD Navigation (`800×480` on `0x323`)**:
   - **3-Line HUD (`y: 100..198`)**: Compact 3-line upper-left layout (`HUD Line 1–3` configurable in Settings; `SOC & OIL` omitted by default) with crisp black text outlines, staying strictly above BMW's Assisted Driving / Adaptive Cruise Control display (`y >= 202`). When **Maps on Cluster** (`waze-on-cluster`) projects its map to the HUD (`0x323`), `hud_main` stays overlaid cleanly on top of Waze's HUD map!
   - **Full-Height HUD Navigation Re-Renderer + Intersection Mini-Map Auto-Yield (`hudNavMode`)**: Spans the full right-side HUD height (`264×264` at `x: 412..676, y: 108..372`) matching stock BMW HUD proportions — top street/exit banner, giant hero maneuver glyphs (turns, highway exits/forks, roundabouts with exit numbers, U-turns, checkered flags), `"then"` secondary maneuvers, large distance/unit aligned across from BMW's speed readout, and full-width 6-lane guidance cells with eDrive blue lane highlights. Automatically yields `0x323` **only** when BMW HUD switches to an intersection mini-map (detected directly from `GuidanceRenderedContent` `HIGH_GUIDING` / `JUNCTION_VIEW` / `CITY_HIGHWAY_MAP` and live DCSM2 HUD scene `0x01000200`/`0x01000201` — never arbitrary distance thresholds).
   - **Borderless Side-Bottom Cluster Map Layout (`clusterSlotMode`)**: When **Maps on Cluster** (`waze-on-cluster`) holds `map` (`0x100`), `Auto` unmaps `panel` (`0x203`) so KOMBI4's right-side BC/Media widget and stalk BC button stay 100% functional, and renders borderless OEM white/blue readouts with crisp 2px black outlines at the bottom-left (`OIL` / `CL`) and bottom-right (`D1–D8` + `SOC %` + 14-segment friction brake bar) of the map area — with **zero background box**, **zero metric shifting between Park (`P`) and Drive (`D`)**, and a **312 px unobstructed center navigation corridor**.

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
../mgu-store/deploy/hu install --artifact dist/cluster_metrics@0.5.0.tgz --yes
```
