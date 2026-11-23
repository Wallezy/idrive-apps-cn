# waze-on-cluster

The part of [Maps on cluster](../../apps/robertn_waze_cluster) that runs in
the background: it puts the CarPlay or Android Auto map on the instrument
cluster of a BMW with iDrive 7.

You don't install or use it on its own. The Store installs it with the
**Maps on cluster** app, and you control it from that app. Settings, what to
do if the map doesn't show, and how to send logs:
[Maps on cluster](../../apps/robertn_waze_cluster/README.md).

## For developers

Shows the CarPlay instrument-cluster map (Waze, Apple Maps or Google Maps),
or Android Auto's (Google Maps), on the instrument cluster of a BMW with an
iDrive 7 head unit (MGU). It runs as root tools on the head unit and is
driven from the HMI by the companion app
[robertn_waze_cluster](../../apps/robertn_waze_cluster).

Both send the cluster map only as H.264 video, with no map data, so this is
a video pipeline:

1. **Ungate the second display.** A patch of carplay, applied in its
   memory at start while `/usr/bin/carplay` stays as it ships, makes `KI_KOMBI_VARIANT` 7 resolve to a supported
   cluster variant, makes CarPlay start the cluster stream itself, and
   advertises the size the map is shown at ([patch/PATCH.md](patch/PATCH.md)).
   Another, applied in aapd's memory while `/usr/bin/aapd` and
   `/etc/aapd.conf` stay as they ship, does the same for Android Auto
   (PATCH.md "Android Auto"). Each is applied only where it is supported,
   and each on its own.
2. **Capture.** The phone sends the stream as RTP to the stock media-bus sink,
   AVB stream `media_transport.avb_streaming.15`; the render joins it as an
   extra receiver. It also listens on a local UDP port and a FIFO, which
   other sink patches can point at.
3. **Decode.** One decode thread depacketises RTP to H.264 Annex B
   (`src/rtp_h264.*`) and decodes it with the unit's Intel Media SDK / VAAPI
   on `/dev/dri/renderD128`, through any lost packets.
4. **Draw.** Each frame goes to the shared cluster renderer,
   [cluster-render](../cluster-render), as a video layer (`src/map_feed.*`)
   on its `map` target, and on `hud` when the map is shown there.

### Install and remove

The Store installs it with the app `robertn_waze_cluster`; it requires
`cluster-render` and `mgu-deploy` (`component.json`, `"requires"`).

**Install.** The deploy tool runs `patchd.js activate` as root. On a car
coded `KI_KOMBI_VARIANT` 7 with any carplay build whose edit sites the
patcher finds and verifies, it plans the patch in memory and arms
CarPlay's next start, on trial until it has run healthy on that car (see
Boot recovery), and never stops, kills or
restarts CarPlay: the Store shows a restart pending, the app `Status:
Patched after restart`, and one head-unit start runs CarPlay with the
patch. Over an earlier release's patch of `/usr/bin/carplay` it puts the
shipped file back in the same step; the earlier patch keeps running until
CarPlay next starts, which then applies the patch in memory, so no restart
is needed for it. It then does the same for Android Auto on any aapd build
it can plan: an earlier release's patch of `/usr/bin/aapd` and `/etc/aapd.conf`
goes back as they ship, and the patch is armed in aapd's memory. Where the
sites are not found, the coding is another, or another tool's change is
found at a site (one that holds neither the shipped bytes nor our edit) or
beside our own edits, it leaves everything as it is, and the app's Status
says why; bytes away from the sites do not count. A patch you turned off
with Remove patch stays off across updates, car software updates and
restarts, until you press Patch (PATCH.md "Install-time activation", "In
memory").

**Remove.** In the Store, remove the app, then the tool (refused while the
app is installed). `patchd.js deactivate` turns both patches in memory
off, reverts our edits to carplay, aapd and aapd.conf where an earlier
release wrote them and drops our backups; the deploy tool then removes this
tool's services and files. The next head-unit start runs the original
CarPlay and aapd.

### Using it

The app's **Patch** and **Remove patch** buttons, for CarPlay and for
Android Auto, apply and revert the patches through the root patch daemon
`patchd`. A change takes effect when CarPlay (or aapd) next starts: `patchd`
restarts it at once only where that cannot restart the head unit (PATCH.md
"Activation"); otherwise the app shows **Restart head unit**.

**Never `systemctl stop` or `restart` carplay or aapd**: CarPlay dumps core
on SIGTERM, which restarts the head unit.

**Boot recovery.** If a patch keeps the head unit restarting, the boot step
stops arming CarPlay's patch in memory (and restores the original aapd)
before CarPlay (or aapd) starts: after one failed start for a patch not yet
proven on that car, after two for a proven one. CarPlay comes back without
the map, its Status reads `Removed — head
unit kept restarting`, and its Patch button applies the patch again
(PATCH.md "Boot recovery"). Android Auto's patch is removed at the first
crash of the patched aapd, and aapd is started again after every end, so
Android Auto comes back without the cluster map; the patch stays off until
its Patch button applies it, an update brings a newer patch, or a car
software update replaces aapd or aapd.conf (then it is tried again, on
trial).

To break a loop by hand: keep the phone from connecting (unplug it, or turn
off its Wi-Fi and Bluetooth), then over SSH run
`sh /var/opt/waze-on-cluster/current/woc-patch.sh off` (CarPlay: its next
start runs stock) or `... woc-patch.sh aa-revert` (Android Auto), and restart
the head unit.

**Android Auto.** **Zoom out** and **Zoom in** change the density the phone
is told (150-400 dpi, 180 by default; lower shows more map with smaller
text), and **Hide phone's turn card** crops Google Maps' turn card off the
top of the map. Each takes effect when aapd next starts.

**When the map shows.** The map comes up in the cluster's central map slot
at the stream's first non-blank picture and stays while the phone's
cluster stream is live. When the stream ends, stays blank for `blank_ms`
(10 s) or freezes for `freeze_ms` (10 s), the slot goes back to the
cluster's own content until the next picture. The render runs from boot and
decodes whether or not the map is shown, since the phone sends a keyframe
only when its stream starts: a render that missed the start shows nothing
until the phone reconnects.

**BMW's turn box.** While the map shows, BMW's CarPlay turn-by-turn box on
the cluster is hidden (cluster-render README, "Guide hold"). The app's
**Hide BMW's turn box** checkbox turns that off and on at once.

**BMW's turn box.** While the map shows, BMW's own CarPlay turn-by-turn box
on the cluster stays hidden: the map's layer leaves cluster-render's guide
hold on (cluster-render README "Guide hold"). The app's **Hide BMW's turn
box** checkbox turns that off and on at once, with no restart: the app sends
`{"cmd":"guide","hide":0|1}` on the control socket, the service sets the
layer's `guide_hold` and keeps the choice in
`/var/opt/waze-on-cluster/state/waze-on-cluster.state.conf` (`state_file`,
written whole and renamed into place), which outlives restarts and updates
and replaces `hide_bmw_guidance` (1) of the settings. The service makes the
folder, owned by `hmi_5000`, at each start. A value other than 0 or 1, or a
state file that does not read, hides the box, with a warning in the log.
The status event carries the choice as `hide_bmw_guidance`, and
`guide_disabled` 1 while cluster-render's mapping guard keeps the hold off
(cluster-render README "Mapping guard"): the box then shows whatever the
choice. With a
cluster-render before 0.3.7, which has no `guide_hold`, the switch changes
nothing.

From a shell, `waze-on-cluster -c <conf> run map|panel` sets the cluster
target until the service restarts and prints the status.

**Inside another app's scene.** An app that shows a scene file on a target
with `layers` 1 can host the map there (cluster-render PROTOCOL.md
"Hosting another target"), and so can an app that draws a target with
layers only, a cluster theme on the panel for example, with no scene file
(PROTOCOL.md "Hosting from layers", cluster-render releases after 0.8.1): the map
is then drawn only in the rect it names, scaled on the head unit to that
part of the picture, under the theme's layers (the map's layer is marked
as the hosted map, so cluster-render knows it). With
`hosted_vpp_scale = 1` the GPU does that scaling instead ("Experimental:
hosted_vpp_scale and always_packed" below). The app hiding its layers,
ending the host or exiting puts the map back on its own slot, and so does
any host whose place the map cannot be drawn in (its part misses the map,
or lands smaller than 64x32), a scene's host included.

CarPlay starts the cluster stream as soon as the phone connects (PATCH.md
Edit 3), and, where Edit 5's sites are found, gives the cluster display the
map's URL, so the phone streams its map from connect, route or not (on the
car the map showed within about 8 s of a reconnect), and Apple Maps and
Google Maps draw their arrival-time card on it during a route. Without Edit 5 the
phone sends a blank picture until a navigation app draws on the cluster: on
the car about 100 blank frames in the first 2 s, then nothing; in the field
the map came once a route started in Waze or Google Maps, and stayed after
it ended. So the stock map stays until
the first non-blank picture, and the app shows `Cluster map: Waiting for
the phone's map`. A picture that stays blank for `blank_ms` (10 s) after a map gives
the slot back to the stock map; the app then shows the same
line, or `Cluster map: Frozen` when the blank frames keep coming
fast enough to be a frozen stream (see "A frozen stream" below). The next
non-blank picture takes the slot again. A map always draws something, so a
blank spell shorter than that keeps the map up, and the map never comes and
goes faster than once every `blank_ms`.

While the map is up, a session the cluster ends (the stock map taking the
slot back, a refusal, no answer) is started again after 2, 5, 10, 20, then
every 30 s. The app shows `Cluster map: Starting…` while the renderer starts, and a
map error only when the renderer stays unreachable for 15 s.

A frozen stream, frames still coming (on the car 15-21 a second) but all the
same blank picture, is frozen after 10 s (`freeze_ms`, at least
`freeze_min_fps` 3 a second): the stock map shows (in Off, an empty centre)
and the app shows `Cluster map: Frozen`, not `Cluster map: Waiting
for the phone's map`. The map is down while the stream is frozen
or its picture has stayed blank for `blank_ms`, whichever comes first; with
both at 10 s they come together. The map is back with the next non-blank
picture. A stream that has shown no picture yet is frozen only after three
times as long (30 s), frames still coming: a phone starting its stream
sends the same blank picture for a couple of seconds and pauses. A stream
is CarPlay's cluster stream while it is live: its frames are those decoded
while it is live and those decoded at most 2 s before it became live (the
frame that made it live, or a first frame decoded before the connection
was read, which is read once a second). An older frame, such as the last
stream's still on its way after it ended, does not count. Blank: all but
one in a thousand of the sampled luma values within 17 levels. A static map
is never frozen, however many frames the phone sends: some phones send one
about every ten seconds, others keep their full rate.

A render that missed the stream's start decodes nothing until a new stream:
reconnect the phone.

**Losses.** The phone sends a keyframe only at the start of its stream, so
the render decodes through a lost packet:

- The AVB bridge's callback and the UDP reader only copy each packet into a
  queue of 4096 packets or 6 MB (about 4 s of the stream) and return; one
  decode thread depacketises and decodes them in order. Past the queue's
  headroom the oldest packets are dropped, and counted. A slot keeps a
  buffer of at most 2 KB once its packet is out, so large datagrams leave
  no memory behind. Every thread runs at the service's nice 0. The FIFO
  reader, a byte stream that holds its writer back, decodes on its own
  thread.
- Every frame is decoded, since each builds on the one before, but only the
  newest gets a picture. While a later frame's first packet (a new RTP
  timestamp) is already queued, the frames decoded meanwhile skip the
  picture: no scaling, packing, level rounding or hand-off. A decode slower
  than the phone's frame rate thus skips pictures instead of falling
  behind; the wait in the queue stays within about one picture's output
  and a few frames' decoding. A decoder slower than the stream even
  without the pictures is logged when every packet has waited over 200 ms
  for 5 s (`waze: the decoder is behind the stream: …`), and again when a
  packet waits under 100 ms (`waze: the decoder caught up with the stream
  after 37 s behind it (packets waited at most 2400 ms)`).
- A sequence gap drops only the NAL unit it cut (an FU-A); every slice after
  it goes to the decoder, which conceals what is missing. The frames are
  shown as decoded: the map can show smudges until the phone codes those
  areas again, and MSDK's per-frame `Corrupted` flags are counted. A decoder
  that has never started still waits for the stream's first SPS. Only
  30 access units in a row that fail to decode give the sequence up; the
  decoder then waits for a keyframe as at the start, until the next
  stream.
- A gap followed by an SPS is a new stream (the phone reconnected or
  CarPlay asked for a new one), logged as `waze: a new stream from avb
  (sequence 40000, expected 17)`, not a loss. Any other gap is a loss,
  logged with the jump, its source and whether the receive queue dropped
  it (`waze: lost 5 packets of the stream from avb (sequence 1240, expected
  1235); decoding through it`), and so are the first corrupted frame after
  it and the first clean one begun after it (`waze: the picture is clean
  again 150 ms after the loss at 12:39:50 (3 corrupted frames)`), at most
  10 such lines a minute.
- Decoding through a loss, the map shows and the status has no reason
  for it; `probe.txt`'s `stream:` line says `lost part of the stream at
  12:39:50; decoding through it` until that clean frame. The status's
  `reason`, which the app shows, is `Stream lost`
  while the stream arrives with nothing decoded for 2 s (a render started
  mid-stream, or a loss the decoder does not decode through) and while the
  decoder has given up its sequence. The detail, with when that began, is
  in the log (`waze: stream lost: the stream arrives with nothing decoded
  since 12:40:50`) and in `probe.txt`. A status line whose only change is
  the stream's reason is logged at most once every 10 s.

**Where the map shows.** `cluster` (on by
default) and `hud` (off by default) choose (`src/map_feeds.*`); the app's
**Show on** sets them to the cluster, the HUD, both or neither (**Off**),
and each change takes effect at once:

| | |
|---|---|
| Cluster only (the default) | the map on the cluster as always |
| HUD only | no map scene on the cluster, so the KOMBI shows its own content and the guide hold is not asked for; the HUD takes each frame itself, with the whole upload budget, at most `hud_fps` a second |
| Both | the cluster first; the HUD gets a copy, and up to half the budget, only what it spends (cluster-render README.md "Upload budget") |
| Neither (Off) | no feed and no connection to the renderer, so the cluster and the HUD show BMW's own content and the guide hold is not asked for; every frame is still decoded, since the phone sends keyframes only when its stream starts, but none gets a picture: no VPP, readback, rounding, copy, hand-off or upload. Turned on again, the map shows with the next frame, without waiting for a keyframe or a new stream |

cluster-render's `hud` target is slot 0x323 (its README.md "The HUD").

- **Off costs nothing.** With the HUD off there is no HUD connection to the
  renderer, no layer, no worker thread and no copy, so nothing HUD-related
  is asked of the KOMBI. On a head unit that refuses the tool, nothing of
  either runs.
- **The cluster first.** A new picture goes to the cluster's feed without a
  copy. The HUD's feed gets a copy of the newest when its next frame is
  due, at most `hud_fps` (10) a second, and a worker thread at a lower
  priority scales it to the size it is shown at (`src/atlas_scale.*`, area
  averaging, `hud_scale_down`); the main loop only copies and hands over,
  so the cluster's frames never wait for the HUD's. A picture the same as
  the last (a still map) goes to both as a repeat: the cluster's last frame
  and the HUD's last scaled one again, a few bytes each, with no copy and
  no scaling, and both layers stay shown. The copy goes no further than
  the cluster's map: one decode, one capture. cluster-render writes the
  HUD's frames, in changed tiles and never packed (a frame goes while the
  budget has any allowance left, into debt, and waits while it is in debt),
  from the HUD's share: up to half the
  budget, what it does not spend going back to the cluster at once.
- **Size** (`hud_width_pct`): Standard (0, the fitted box, about 57 % of the
  HUD's width, 453x200), or 30 % to 85 % (680x300, the widest: wider is cut
  off at the HUD's edges, and a larger saved size is held to it), the
  picture's shape kept; the app's **Size** slider steps it by 5 %.
  A new size is a new layer at that size.
- **Position** (`hud_offset_x`, `hud_offset_y`): pixels of the HUD's scene
  moved from the centre (+x right, +y down), held so the map stays whole
  inside the HUD (the status then reports the offset as far as it goes); the
  app's **Move left**, **Move right**, **Move up** and **Move down** move it
  10 px a press and **Centre** puts it back. A move only changes the layer's
  place, so it shows at once.
- **Made for a HUD.** At the standard size a frame is 135,600 B instead of
  783,360. On a HUD dark pixels are see-through: the corners are rounded
  (`hud_round_corners`, a twelfth of its height) and fade to black, and a
  night map's background is made black (`hud_black_background`): the
  frame's most common shade, followed frame to frame, and the shades just
  above it, so the HUD shows the roads, route and labels without Waze's
  grey-blue field; a day map (light background) is left as it is. Green is
  never made black, and does not count towards the background.
- **It gives way.** The HUD map steps aside while the HUD's media and list
  pop-ups show (the media source list; cluster-render `hud_yield_slots`)
  and comes back 1.5 s after they go, never for route guidance, and never
  takes the HUD from BMW's own content. With `hud_keep_shown` 1 (the app's
  **Keep HUD map over BMW's pop-ups**) it stays shown over them.
- **Disabled after errors.** cluster-render's mapping guard turns the HUD
  off after two cluster restarts within 10 s of its mapping; the status
  says `hud_state` `disabled`, the app shows `HUD map: Disabled after
  errors`, and its frames are no longer copied or scaled. The cluster's map
  is not affected. Choosing Cluster and then the HUD again does not undo it; as
  root, `cluster-render guard-reset` does.
- The settings (`cluster`, `hud`, `hud_width_pct`, `hud_offset_x`,
  `hud_offset_y`, `hud_keep_shown`) are saved by `patchd` in
  `/var/opt/waze-on-cluster/map.state.conf` (`map_state_file`), which this
  tool reads over its configuration at each start, and the app changes the
  running render at once. They stay out of `waze-on-cluster.local.conf`,
  which waze-on-cluster 0.8 refuses to start with: `patchd` moves any it
  finds there into the state file at its start and at an install. Control:
  `{"cmd":"hud","on":"1"}`, `{"cmd":"hud","hud_width_pct":"70"}`,
  `{"cmd":"hud","hud_x":"40","hud_y":"-20"}` (strings; an axis left out
  stays), `{"cmd":"hud","hud_keep_shown":"1"}`.
- Per driver profile: the settings are shared by every driver profile until
  the app's **Own settings for this driver** gives one its own copy. The app
  tells `patchd` the profile in use (`{"cmd":"profile","id"}`) and the
  checkbox (`{"cmd":"profile-own","id","on"}`); `patchd` keeps the shared
  settings and each profile's own in `/var/opt/waze-on-cluster/profiles.json`
  and writes the ones in effect into `map.state.conf`, as for any change,
  and the app moves the running render to them. `profiles.json` is written
  first; a write that fails is tried again, and at its start `patchd` writes
  `map.state.conf` again from `profiles.json` when a write between the two
  was cut short. `profile-own` is taken only for the profile last told.
  `map.state.conf` keeps its format, so an older version reads the settings
  in effect; changes made under an older version are replaced by
  `profiles.json`'s at the next start while a profile has its own settings.
  A missing, corrupt or unreadable `profiles.json` means no profile has its
  own settings (logged).

From a shell, `waze-on-cluster -c <conf> run map|panel` (`sail` is an alias
of `map`) sets the cluster target until the service restarts and prints the
status.

**Inside another app's scene.** Another app that shows a scene file on a
target (with `layers` 1) can host the map there (cluster-render
PROTOCOL.md "Hosting another target"): it names the map's target, a rect in
its own target and the part of the map's target it wants. While that holds,
the cluster's map is drawn there and only there: one video layer where its
part lands in that rect (the app's part is stretched over the rect, so a
map smaller than that part keeps its place in it), its frames that part of
the picture, scaled on the head unit to at most that size
(`src/atlas_scale.*`, the HUD's worker), and no layer
on its own target, so the KOMBI shows its own content there and nothing of
the map goes to it twice. The decoder is the same: one decode, one upload,
of that part only (a 560x400 part: 336,000 B a frame instead of 783,360).
While the app hides it, there is no layer at all and nothing is sent; the
newest picture is held and drawn first when it shows again. When the app's
scene goes, or cluster-render restarts, the map is back on its own target
(and in the scene again once it says so). The status says `hosted` 1 and
the scene's target as `target`; hidden, `state` idle with the reason
`hidden by the app it is shown in`; not hosted, the status line is as it
always was (no `hosted` field). While a HUD map is hosted, a new HUD size
or offset waits for its own place. Nothing changes without such an app.

### Status and diagnostics

Once a second the render writes, in `/run/waze-on-cluster/` (mode 0644):
`status.json`, the status the app shows (`state` idle, starting, showing,
frozen or error, or unsupported on a head unit that refuses the tool; `page`; `reason`; the shared upload cap as `upload_cap_kb_per_s` and
why as `upload_reason`, also in the app's status event); `probe.txt`, the
sources, the depacketiser (`rtp: packets nals aus aus_by_marker seq_gaps lost
dropped bad`), the receive queue (`queue: N dropped, at most M of 4096 packets waiting, K KB
held`), its backlog (`backlog: the oldest packet waiting N ms, the longest
wait M ms; K frames decoded without a picture to catch up`, with `; the
decoder is behind the stream` while it is), the stream (`stream: whole` or
the detail above), the decoder and the order it outputs in, the last SPS
(`sps:`, as the log's SPS line), the frame timing since the start (`frames
ended by the marker bit ...`, as the log's minute line), the late-join
verdict, the noise filter's tile differences and the renderer's own status. `patchd` answers
`{"cmd":"logs"}` with CarPlay, AVB and DLT marker lines and its own log.

Every line the render logs also goes to
`/var/opt/waze-on-cluster/log/waze-on-cluster.log` (`log_file`) with its UTC
time, so it outlives the journal's few minutes on the unit, restarts and
reboots; past `log_file_kb` (512) the file becomes `waze-on-cluster.log.1`.
The file is open only while a line is written, so the head unit can make
`/var/opt` read-only at shutdown; a line that finds `/var/opt` read-only or
full is dropped, and the lines after it are written once it takes them
again. The service makes the directory, owned by `hmi_5000`, at each start; the
deploy tool removes it with the rest of `/var/opt/waze-on-cluster`. The log
has the status when its state, reason or target changes, each loss and a
decoder behind the stream (above), and once a minute while frames come, how
many were decoded, how many of those without a picture, changed and flagged
corrupted, whether the last picture was blank, the losses and the packets
they cost, the packets the receive queue dropped, and how long the decoded
packets waited in it (with `picture_fps` set, also how many were left
without one for it, "Pictures"):
`waze: 1840 frames decoded in the last minute, 12 without a picture to
catch up, 1 changed, 0 corrupted; the last picture is not blank; 0 losses
(0 packets), 0 dropped by the receive queue; packets waited 2.4 ms on
average, 61 ms at most`. A second line says how the minute's RTP frames
ended, by their marker bit or by the next frame's timestamp, how long each
waited from its last packet's arrival until it went to the decoder, and how
many frames the decoder took in after each frame before that frame came out
(0 when each comes out as it is decoded; one it takes and never outputs adds
to frames already waiting in it, never to later ones):
`waze: frames ended by the marker bit 0, by the next timestamp 1840; handed
to the decoder 31.6 ms on average after their last packet, 66.0 ms at most;
the decoder held 0.0 frames on average, 0 at most`.

Each sequence's SPS is logged once, with its source:
`waze: SPS from avb: High (profile_idc 100) level 4.2, 1920x900,
pic_order_cnt_type 0, bitstream_restriction max_num_reorder_frames 0
max_dec_frame_buffering 4` (`bitstream_restriction none` without it, `none
(no VUI)` without a VUI). The decoder logs the first B slice
(`decoder: B slices in the stream: output in display order from the next
SPS`) and each sequence that starts in another output order than the last
(`decoder: output in display order from this sequence`, or `decoding
order`).

For a report, use the app's **Logs** page (below), or run as root on the
unit `sh /var/opt/waze-on-cluster/current/collect-logs.sh [-o <folder>]`:
it writes `woc-logs-<UTC date and time>.tar.gz` into the folder (`/tmp` by
default) and prints its path. The archive holds both tools' log files
(cluster-render's too), the journal lines the journal service keeps, the
files in `/run/cluster-render/`, the render's `status.json` and
`probe.txt`, boot recovery's counter and shutdown record, this boot's
journal of the render, `patchd`, the boot step, the recovery, capture,
journal and logs services, cluster-render and carplay, the list of boots,
`ls -l` of both tools' folders, their `*.local.conf`, the date and the
uptime, `wifi.txt`: CarPlay's Wi-Fi band (below), each P2P interface's
`/proc/net/dev` counters and the kernel's last 60 802.1X and DHCP lines for
the P2P interfaces (from the journal, else `dmesg`), and what a start the
head unit reset needs explained (`patch/logs_extra.js`):

- `patch-record-carplay.json`, `patch-record-aapd.json`: the patchers'
  records (`*.woc-patch.json`); `aa-boot-recovery.json`: the aapd boot
  recovery's counter;
- `aapd-status.txt`: `aapd_patch.js status` (aapd's build, its edits, the
  backups, the cluster coding); `coding.txt`: the cluster coding's
  `KI_KOMBI_VARIANT`, the number only;
- `deploy.txt`: the deploy tool's version, each tool installed with its
  version (`/var/opt/<id>/current/component.json`: id, kind, version) and,
  from the deploy tool's `state.json`, the tools' versions and firmware, the
  apps' versions, the restarts pending in this boot and the last bounce;
- `restart-record-<n>-<boot id>-<recmgr|crashhandler>.xml`: recmgr's and
  the crash handler's restart records, which each deletes at its start. The
  carplay boot step (`waze-on-cluster-boot.service`, root, before carplay)
  copies each it finds into `/var/opt/waze-on-cluster/restart-records/`
  (group `systemd-journal`, 2770, files 0640, as the kept journal), named by
  the boot that found it and numbered in boot order (the clock is not yet
  set then), VIN-scrubbed and cut to 64 KiB as below, those of the last 5
  boots kept; with no record it writes nothing, and a failure only logs a
  line;
- `restartInfo-recmgr.xml`, `restartInfo-crashhandler.xml`: the same
  records, should they still be there when the Logs page opens;
  `recmgr-crashes.txt`: the database file's modification time and the
  newest 200 rows of recmgr's crash table (`recmgr_stats.db` `Crash`: key,
  the application's name, crash id; recmgr leaves the rows' time empty and
  their lifecycle 0), read by the firmware's `sqlite3`
  read-only (`file:...?mode=ro`) and killed after 2 s; `core-dumps.txt`: the
  names and times of what the crash handler and the kernel keep of crashes
  (`coredumps/`, `gpu_hangs/`, `gcd/`, `dlt-cdh/`, `/var/opt/kerneldump`,
  two levels deep, the newest 100 of each), never the files. These four are
  under `/var/opt/public`, which only root reads: the logs service's
  firewall unit, root's, writes them to `/run/waze-on-cluster-logs` (group
  `systemd-journal`, 2750, written whole into a new folder and renamed into
  place) before the logs service starts, so a Save logs has them as they were when the Logs page opened;
  `collect-logs.sh` run as root reads them itself.

Each of these files is at most 64 KiB, and in each, text shaped like a VIN
(17 characters) or a short VIN (7) is replaced by `<VIN>`. Left out: the
coding image itself, recmgr's `UserID` column (7 characters, a short VIN's
size), the core dumps' and their context files' contents, every other field
of the deploy tool's `state.json` and component manifests, and the deploy
tool's and the updater's other files (their tokens, credentials, sources,
config and backups).

**CarPlay's Wi-Fi band.** The head unit runs two wireless-CarPlay P2P
groups, one on 5 GHz and one on 2.4 GHz, bridged on `wlan_bridge`
(`p2p-wlan0-N` with Broadcom's driver, `p2p-wfd0-N` with NXP's; which name
is which band is not fixed). On 2.4 GHz, CarPlay's streams and the cluster
stream together can be more than the link carries, and audio cuts out.
`patchd` (`patch/wifi_band.js`) reads `/proc/net/tcp` and `tcp6` every 15
s. While carplay holds a connection to the phone, it compares each P2P
interface's received bytes in `/proc/net/dev` over 5 s at the start, then
every 2 minutes: the phone's is the one receiving at least 1 KiB/s and 4
times any other. Its band is the frequency of that interface's group, which
`patchd` reads from wpa_supplicant over D-Bus with `busctl` (root only, by
the bus policy; never starting wpa_supplicant): the interface's `P2PDevice`
`Group`, then the group's `Frequency`. CarPlay over USB, too little traffic
to tell, or a frequency that cannot be read or is in no band leave the band
unknown; it is never taken from the interface's name or order. A band once
known stays for that CarPlay session through a still screen, while its
interface still receives the most, at least 128 bytes/s. `patchd` logs the
band when it is first known and when it changes (`CarPlay Wi-Fi: 2.4 GHz
(p2p-wlan0-1, 2462 MHz, 1180 KB/s)`), unknown after a band, and a frequency
it could not read; it sends it to the app in its status (`wifi`) and writes
it, with each P2P interface's rates, to
`/dev/shm/waze-on-cluster/wifi-band.json` (0644).

Sockets: `/dev/shm/waze-on-cluster/ctl.sock` (the render's status and log,
and the turn-box switch, group `tm_oap_app`; a connection also starts the
service),
`/dev/shm/waze-on-cluster/patch.sock` (`patchd`, `root:tm_oap_app`, 0660)
and `/dev/shm/waze-on-cluster/logs.sock` (the logs service, group
`tm_oap_app`; a connection starts it). The app's README lists the
protocols.

### Logs

**The journal service** (`waze-on-cluster-journal.service`,
`patch/journal_keep.js`) keeps the tools' part of the journal on
`/var/opt`: the unit's journal is volatile and holds about four minutes on
the car, where the navigation writes some 16,000 lines in that time. Its
timer starts it 10 s after boot, so a start the head unit resets within
its first minute still leaves its lines; it runs at the lowest CPU and I/O
priority, no unit waits for it, and it is ordered against no head-unit unit.
It reads what this boot logged so far, then follows this boot's lines of the
waze-on-cluster services, cluster-render, carplay, recmgr and crashhandler,
systemd's lines about them and their sockets, and the kernel's, and appends
them every 2 s to
`/var/opt/waze-on-cluster/journal/journal.log`, opening the file only for
the write. In the boot's first 2 minutes each append is also synced to disk
(`fdatasync`, through a read-only descriptor, so `var-opt-ro.service`'s
remount never finds the file open for writing): a start reset without a
shutdown keeps its lines up to the last 2 s before the reset. After that,
`/var/opt`'s own commit (ext4, `data=ordered`, every 5 s) makes the lines
durable within seconds. Each line is at most 1 KiB: the time (UTC, µs), the
unit, the program and its pid, the message. Past 384 KiB the file becomes
`journal.log.1` and the older ones move up to `journal.log.9`: at most 10
files and 3.75 MiB. The tools' lines (waze-on-cluster, cluster-render) and
the others each have 128 KiB a minute, with a minute's worth in reserve, so
a flood of one kind never pushes out the other; what comes faster is
dropped and counted (`journal-keep: dropped N other lines (M KiB) over the
rate limit`). That keeps at least the last 10 minutes whatever the units
log: the rotated files always hold more than 3447 KiB, and 10 minutes let
through at most 2816 KiB. What this boot logged before the start is written
whole, within the files' caps (its newest lines when it is more), not
limited. On the car these units wrote 189 lines in four
minutes with the map up (about 7 KiB a minute; carplay logs to DLT), the
tools' own log files at most 67 KiB in any 10 minutes over two days, and the
kernel about 1,650 lines (140 KiB) in a boot's first minute, so the limit is
met only by a fault flooding the journal, and the files hold hours. A start
writes what this boot logged after the newest line the files hold, all of it
when this boot has no such line, then follows from the last entry's journal
cursor, as does a journalctl started again; nothing depends on the clock.

**Save logs** on the app's Logs page asks the logs service
(`waze-on-cluster-logs.service`, `patch/logs.js`) for an archive: with at
least 64 MiB free on `/var/opt` it runs `collect-logs.sh -o
/var/opt/waze-on-cluster/saved`. An archive over 16 MiB is deleted, then the
oldest ones until at most 5 are left, together at most 20 MiB. One save
runs at a time, at most one every 10 s.

**Download.** The logs service serves the saved archives to a phone or a
laptop on the car's Wi-Fi hotspot, at `http://<wlan_bridge's
address>:8475/<token>/` (on the car `172.16.222.97`), which the Logs page
shows as text and as a QR code. The page lists the archives, each a
download. The token is 128 random bits, new at each start of the service;
another path, a wrong token or another `Host` is refused, and 10 wrong
tokens or 120 requests in a minute lock a client address out for the rest
of it, which may download two archives at a time. It serves only GET and
HEAD of the archives, no folder, link or other file.

The logs service starts when the app opens the Logs page (its socket) and
stops by itself 10 s after the page is closed, or 15 minutes after the last
Save logs if that is later. It listens only on `wlan_bridge`'s address while
it has one, checked every 5 s. It starts `waze-on-cluster-logs-fw.service`
(root, `logs_fw.js`) first and stops it with itself (`BindsTo`): that makes
`saved/`, removes any rule tagged `waze-on-cluster-logs` from the firewall's
`ip filter input` chain and keeps one at its top, `iifname "wlan_bridge"
tcp dport 8475 accept`, checked every 30 s and put back after a ruleset
load, and removes it when it stops, however it stopped (`ExecStopPost`).
From its second check on, a logs service neither running nor starting (its
start limit refused it) ends it too, the rule removed. A unit without that
chain gets none.

Every OAP app is in `tm_oap_app` and can use the logs socket, as it can
`patch.sock`; the token keeps out the other devices on the hotspot.

### Map size and upload

**Size.** The map covers the cluster's central map area, the stock map's
1088x480 rect on the 1920x720 panel (138x61 mm). The patch advertises exactly
that, so the phone renders those pixels, the decoder passes them through
unscaled and the texture maps onto the area one to one. In the whole-panel
slot `0x203` the map is centred at (416, 120) with everything around it
transparent. `tex_size` must equal the size the patch advertises.
`src_crop` takes part of a picture of one size (a phone that draws its map
in part of a larger picture) and scales it to `tex_size`; a picture of any
other size is used whole. `map_rect` draws the map stretched into a rect of
the current target instead of its map area.

**Texture.** The planes are packed into one R8 atlas, Y in rows 0–479 and U
and V side by side in rows 480–719 (783,360 B), which the renderer's shader
converts as full-range BT.601. The renderer keeps one persistent buffer and
writes only changed 64x64 tiles in place, one flush per update, so the
cluster never shows a half-written frame. (A new texture per frame held the
map to 3–4 frames a second on the car.)

**Noise filter** (`dirty_threshold` 8, `dirty_settle_ms` 1000). The phone
keeps coding residuals on a still map, mostly within 3 levels. A tile is
written only when it differs from what the cluster holds by more than the
threshold, or after `dirty_settle_ms`; a parked map costs about 1.6 updates a
second.

**Fast motion** (`pan_blocks` 1). An update whose exact write costs more than
261,120 B and more than the budget allows goes as 4x4 colour blocks at a
third of the bytes, slightly softer (38.8 dB mean on a recorded Waze capture;
street names and icons readable). The next update the budget covers, or a
quarter second later, brings the exact picture back. `waze-on-cluster
bench-pack <I420 file>` times the packing on the unit.

**Rate.** `target_fps` (30) is a ceiling on an exact grid; only the newest
frame waits, so the map skips ahead and never shows a backlog, and the
decoder skips the pictures of frames it is behind on ("Losses"). Real Waze
sent up to about 16 frames a second on the car.

**Pictures.** Every frame is decoded, but its picture (VPP, the copy to
system memory, the packing) is the CPU's cost, and a moving map changes
nearly every picture. `picture_fps` (0: every frame) makes at most that
many pictures a second, one in each 1000 / `picture_fps` ms slot of a fixed
grid; the frames between are decoded without one. Set it to `target_fps`
when that is below the phone's rate (a G-series car saw CarPlay at 30
frames a second while driving, with `target_fps = 15`): the pictures the
cluster never takes are not made. A value below `target_fps`, `hud_fps`
or, with `freeze_ms` set, `freeze_min_fps` is raised to it, with a warning
in the log. A frame left without one gets it after all when no newer frame
came by the end of its slot and a quarter of an interval, so a map that
stops moving shows the phone's last picture. The minute line counts the
frames that stay without one ("without one for picture_fps").

**Upload budget.** The budget belongs to cluster-render and is shared by all
its clients: a 5500 KB/s ceiling, stepping down by 500 KB/s to 2000 KB/s on
sustained congestion and recovering slowly. Set it with `upload_kb_per_s` in
`/var/opt/cluster-render/cluster-render.local.conf`. This tool's own
`upload_kb_per_s` and `upload_burst_ms` keys are accepted and ignored with a
warning naming that file. On the car 8000 KB/s made the cluster flash black;
6000 KB/s stayed smooth with packed motion and no failed writes, but the
cluster once removed a shown map after a minute averaging 5774 KB/s, so the
ceiling sits below that. Real Waze
transitions peaked at about 3.2 MB/s. Every head-unit participant shares
the link to the cluster, so an upload that outruns it can drop other contents
too. Details: the cluster-render README.

Settings are in `waze-on-cluster.conf` (documented inline). Overrides go in
`/var/opt/waze-on-cluster/waze-on-cluster.local.conf`, which updates keep;
the app's map settings are in `/var/opt/waze-on-cluster/map.state.conf`, and
the opt-in settings in `/var/opt/waze-on-cluster/features.conf`. A key the
local conf has that this version does not know is left out with a warning
in the log.

### Map size and upload

cluster-render writes only the 64x64 tiles of a frame that changed. The
upload budget is cluster-render's: set it with `upload_kb_per_s` in
`/var/opt/cluster-render/cluster-render.local.conf` (cluster-render README,
"Upload budget").

The map covers the cluster's central map area, 1088x480 on the 1920x720
panel. The patch advertises exactly that, so `tex_size` must equal it.
`src_crop` takes part of a picture of one size and scales it to `tex_size`
(Android Auto's 1280x720 stream has its map in the top 1280x564).
`map_rect` draws the map stretched into a rect of the current target.
`target_fps` (30) caps the frame rate; `picture_fps` (0: every frame) makes
at most that many pictures a second, which saves CPU when the phone sends
more than the cluster takes (set it to `target_fps` then). While another
app's layer on the cluster asks for upload bandwidth (cluster-render's
`others_fps`), the renderer writes the map at most at the rate it asks, 15
a second at the least, and the pictures follow; when that app hides its
content or exits, both go back to these settings. Nothing is written to
disk for it.
`always_packed = 1` sends fewer bytes for the same map ("Experimental:
hosted_vpp_scale and always_packed" below).

### Experimental: hosted_vpp_scale and always_packed

Two settings for a head unit that is short of CPU or of upload to the
cluster, for example while an app hosts the map in its own scene. Both are
0 (off) by default, and with 0 nothing changes.

| Key | What it does | When it helps | Cost |
|---|---|---|---|
| `hosted_vpp_scale` | While an app hosts the map and the HUD map is off, the decoder's VPP crops the host's part of each picture and scales it to the size shown, on the GPU. The CPU then copies and packs only that part and scales nothing. | A hosted map: the CPU neither copies the whole 1088x480 frame nor scales it. | VPP's scaling looks a little different from the CPU's. |
| `always_packed` | Every update of the cluster's map, in its own slot or hosted, goes as packed 4x4 colour blocks, never the exact picture. Only the blocks that changed are sent, at most 64 rects an update. The whole packed picture goes once when the map's layer starts (a new stream, a new size, a host moving it). A still map sends nothing. The HUD map is not affected. | Little upload to spare: about a third of the exact bytes, or less, for the same change. | A slightly softer picture: thin lines and small text show the 4x4 blocks. |

They can be used alone or together; with both, the GPU-made part is packed.

**Turning them on.** Add the lines to `/var/opt/waze-on-cluster/features.conf`,
which updates keep and earlier versions do not read:

```
hosted_vpp_scale = 1
always_packed = 1
```

They take effect when waze-on-cluster next starts (the next head-unit
start). A restart of the service applies them at once, but the map stays
blank until the phone connects again.

Not in `waze-on-cluster.local.conf`: there they are left out, and patchd
moves them to `features.conf`.

**What they need.**
- Both: a waze-on-cluster whose `waze-on-cluster.conf` has the key. An older
  one does not read `features.conf` and sends the map as with 0.
- `hosted_vpp_scale`: only acts while an app hosts the map (cluster-render
  PROTOCOL.md "Hosting another target") and the HUD map is off. Otherwise
  the map goes as with 0.
- `always_packed`: a cluster-render whose hello has `always_packed`
  (PROTOCOL.md), `pan_blocks = 1`, and a map (or host's part) whose width
  and height are multiples of 4. waze-on-cluster reads the hello at every
  connection, so a cluster-render updated later is picked up when it
  reconnects.

**Checking they work.** In the log ("Logs" below):
- `decoder: VPP makes the output's WxH at X,Y as WxH (hosted_vpp_scale)`:
  the GPU makes the host's part.
- `render: map layer on ... every update packed (always_packed)`: the map is
  packed.

If one cannot be used, the log says why once, and the map goes as with 0:
- `decoder: VPP cannot make ...`: the part is an odd size, outside the
  frame, more than 8 times smaller than its rect, or VPP failed. That
  stream's pictures are scaled on the CPU.
- `render: always_packed: the map's WxH not packed, ...`: the size is not
  a multiple of 4, or cluster-render does not take it.

**Side effects of `hosted_vpp_scale`.**
- The freeze watch and the minute's tally judge a blank or frozen picture
  by the part shown, not the whole frame.
- A host moving the map, the map going back to its own slot when the host
  drops it, and the HUD map turning on all show the map from the phone's
  next frame.

**Apps that host the map** can turn these on for their users by writing the
lines into `features.conf`, never over a value the owner set. Remove the
lines when the app is removed.

Not yet measured on a car: the unit's VPP with a part, the packed picture
and the CPU and GPU cost. `waze-on-cluster.conf` has the details for each
key.

### Logs

For a report, use the app's **Logs** page (Maps on cluster README, "Logs
and reporting a problem"), or run as root on the unit
`sh /var/opt/waze-on-cluster/current/collect-logs.sh [-o <folder>]`: it
writes `woc-logs-<UTC date and time>.tar.gz` into the folder (`/tmp` by
default) and prints its path. The archive holds both tools' logs, the kept
journal, patchd's CarPlay and DLT lines (`patchd-logs.json`), the status
files, the patchers' state and the head unit's restart records.
`incidents.txt` lists the tools' `INCIDENT` lines (each time the map was
lost), the boots and the time of the export, oldest first. Every file is
scrubbed before it goes in: VINs, MAC addresses, IP addresses outside the
car's own networks, Wi-Fi network names, phone and device names, keys and
tokens are replaced by tags (one address keeps one tag within an archive).
The coding image, core dumps and the deploy tool's tokens, credentials and
sources are left out.

- The render's log: `/var/opt/waze-on-cluster/log/waze-on-cluster.log`
  (and `.log.1`), in UTC.
- Its status, once a second: `/run/waze-on-cluster/status.json` (what the
  app shows) and `probe.txt` (the sources, the decoder, losses, timing).
- The journal service keeps in RAM, in `/run/waze-on-cluster-journal/`
  (10 files of 384 KiB), the tools' journal, the lines of carplay, aapd,
  recmgr and the crash handler, systemd's lines about any unit that starts,
  stops, is killed or fails, and the kernel's, without the high-volume
  lines that explain nothing (the firewall's blocked packets, Wi-Fi scans,
  audit records) and with a short summary of each boot's kernel log. Every
  30 s it adds a load line: the load averages, MemAvailable, the processes
  in D state and the 5 processes that used the most CPU.
- It writes the newest of those lines to `/var/opt/waze-on-cluster/journal/`
  only when they are worth keeping across a restart: shortly after a
  failure (an `INCIDENT` line, a crash or failure of carplay, aapd or one
  of the tools, a segfault or out-of-memory kill, a boot recovery step, a
  patch removed) and a minute later, and at each head-unit shutdown. Each
  write is one file `journal-<UTC>-<reason>.log` of at most 256 KiB: the
  last 10 minutes not written yet, lines that repeat with other numbers
  kept only 3 times. It keeps 16 files, 2 MiB at most, and removes the
  oldest of a shutdown before the oldest of a failure.
- **Save logs** keeps at most 5 archives in `/var/opt/waze-on-cluster/saved`.
  The Logs page serves them to a phone on the car's Wi-Fi hotspot, at the
  address it shows, while the page is open and for 15 minutes after a save.

### The patches

`patch/carplay_patch.js` and `patch/aapd_patch.js` (Node 8, no
dependencies) find their edit sites in the build and check them.
Their edits go into a plan that `preload/wocpatch.c` (`libwocpatch.so`,
preloaded into carplay or aapd) applies in memory; aapd also reads a copy
of aapd.conf with the cluster geometry, in `/run`. Neither file on `/` is
written but to put back a patch an earlier release wrote, from verified
backups, by atomic rename. The install patches any build whose sites are
all found and verify, on trial until it has run healthy on that car; no
list of builds decides it. Edits and sites:
[patch/PATCH.md](patch/PATCH.md).

`woc-patch.sh` (in `/var/opt/waze-on-cluster/current/`) is the shell path,
for reading the patches' state and undoing them without the app:

| Command | |
|---|---|
| `status`, `aa-status` | what is on disk |
| `probe` | where the edit sites are in a carplay binary and whether it is patchable, without writing |
| `aa-probe [<file>]` | the same for aapd (`/usr/bin/aapd` by default) |
| `verify` | whether carplay's patch is complete |
| `off`, `aa-off` | turns carplay's or Android Auto's patch in memory off: the next start runs stock |
| `revert [--force]` | restores the original carplay where an earlier release patched the file; `--force` over another build (a firmware update) |
| `aa-revert [--force]` | restores the original aapd and aapd.conf where an earlier release patched them |

It remounts `/` read-write only for the write.

### Building and testing

```sh
make test                         # host tests
make test-preload                 # libwocpatch.so against a test program, with the unit's toolchain in Docker
make test-x86                     # the C++ tests with the unit's toolchain in Docker (SSE2 paths)
make target                       # build/target/waze-on-cluster in Docker, imports checked
make test-firmware ROOTFS=<dir>   # DLT capture against the unit's own dlt-daemon in Docker
```

`CR` names cluster-render's tree, `../cluster-render` by default; it also
gives the log, the config, the unit's ABI tools and the build image. The
target builds in Ubuntu 18.04 (gcc 7.5, glibc 2.27) against link-only stubs
of the unit's libmfx, libva, libva-drm and IAS AVB bridge
(`abi/*.symbols`).

The repository carries no BMW binary. The patch tests take copies of the
unit's files: `CARPLAY_BIN` (carplay 22.28.3), `CARPLAY_BINS` (other
carplay builds, separated by `:`), `AAPD_BIN` (aapd 22.39.3),
`AAPD_CONF` and `AAPD_BINS` (other aapd builds, separated by `:`); tests
that need one are skipped without it. `test-firmware` takes `ROOTFS`, an
extracted root file system of the unit.

### License

GPL-3.0-or-later (`LICENSE`). `abi/include/mfx/` is a subset of the Intel
Media SDK headers under the MIT license (`abi/include/mfx/LICENSE`).
Third-party files keep their own licenses.
