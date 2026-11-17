# cluster-render

Cluster renderer draws apps' content, such as the
[Maps on cluster](../../apps/robertn_waze_cluster) map, on the instrument
cluster and the head-up display of a BMW with iDrive 7 or iDrive 8.

You don't install or use it on its own. The Store installs it with the apps
that need it, and there is nothing to set up. If something an app draws doesn't
show, follow that app's instructions; for Maps on cluster, see
[If the map doesn't show](../../apps/robertn_waze_cluster/README.md#if-the-map-doesnt-show).

## For developers

The one renderer every app on a BMW iDrive 7 or iDrive 8 head unit (MGU)
draws through on the instrument cluster and the HUD: maps and video,
widgets, overlays, 2D and 3D, and whole-cluster content. Apps and native
producers are its clients ([PROTOCOL.md](PROTOCOL.md)); it is the head
unit's one custom RAMSES participant and display client (Dcsm2 on
iDrive 7, RAMSES 27's DCSM on iDrive 8, "iDrive 8"), shares the display
slots between its clients, and spends one upload budget for all of them.
`kit/` is the pixel path it shares with producers that prepare frames.

| Part | What | Who links it |
|---|---|---|
| `kit/` | the pixel path: 4:2:0 atlas, dirty tiles, packed blocks, SIMD conversion and rounding, pacer, frame clock, map geometry | the service, and any producer that prepares frames |
| `src/` | the service: slot arbitration, the layer stack, layers, the upload governor, the iDrive 7 and iDrive 8 backends, the socket | — (one process, `hmi_5000`) |
| `include/`, `client/` | the C++ client and protocol, `libcluster_render_client.a` on the unit | native producers |
| `js/cluster_render_client.js` | the Node 8 client | OAP apps |
| `dcsm/`, `abi/`, `tools/`, `docker/` | the Dcsm2 client ([dcsm/DCSM.md](dcsm/DCSM.md)), the units' RAMSES 19, RAMSES 27 and vsomeip ABI ([abi/ABI.md](abi/ABI.md), [abi/ABI27.md](abi/ABI27.md)), the ABI checks and the unit's toolchain | the service's build |

Frames cross a socket: a whole 1088x480 video frame is 783 KB. An app's
content is made of the layer kinds and assets below, or, on a target that
takes them, a whole scene file a root install put in place ("Layers").

### Clients

- **Native producers** link `libcluster_render_client.a` and include
  `include/cluster_render/client.h`.
- **OAP apps** copy `js/cluster_render_client.js` into their sources (Node 8,
  only the `net` and `events` builtins). The installed copy is
  `/var/opt/cluster-render/current/cluster_render_client.js`.
- Any other language speaks [PROTOCOL.md](PROTOCOL.md) over the socket.

A client needs only the socket's group, `tm_oap_app`, which every OAP app
has: no participant, no Dcsm2 client and no `hmi_5000`. A tool or app that
draws through the service requires `cluster-render` in its catalog entry
(`"requires"`).

`js/showcase.js` puts content of every layer kind on a target through the
service and prints every event: a 3D cube in a mesh layer the renderer
turns, plasma in an effect, labels in effects over a glyph-atlas asset, a
needle, an alert and a video:

```sh
node showcase.js [--socket PATH] [all|cube|text|needle|plasma|alert|video] \
    [--target panel|map|hud|guide|widget] [--size WxH]   # iDrive 8's map: --size 874x749
```

### Targets

A **target** is one slot with one scene. On iDrive 7:

| Target | Slot | Size | Where |
|---|---|---|---|
| `map` | 0x100 | 1088x480 | the central map area, under the gauges |
| `panel` | 0x203 | 1920x720 | the whole cluster, over the gauges |
| `hud` | 0x323 | 800x480 | the head-up display |

iDrive 8's targets are in "iDrive 8". The service's `hello` event names the
targets and their sizes.

### Arbitration

Every client's layers on a target are drawn in that target's scene.

- **Order.** Every layer is drawn at once, bottom to top by class
  (ambient, content, overlay, alert), then the client's `z`, then the newest
  on top. A layer marked `exclusive` hides the layers below it while it is
  drawn, from the flush after its first write went: until then they stay
  shown, under it (an image shows from that write). They are suspended, not
  removed, and come back in the flush it goes. A target with an alert or
  exclusive layer waiting for its first write stages first, so that write
  takes the next allowance of the upload budget. A change of the stack is
  one flush: no display traffic, so a client replacing another is
  instant.
- **Refcounted slots.** A target is requested while at least one visible
  layer has content (or is `prewarm`) and is released only when none has for
  `<target>_linger_ms`, after the fade-out below. While it lingers the scene
  stays mapped, empty and transparent, so a client that comes back within
  it is shown at once. The map's linger is 0: it is unmapped as soon as its
  video has stopped and faded out.
- **Warm scenes.** A target's scene is published at its first request and
  stays published while the target is released, taken by the display,
  refused or not answered: only the Dcsm2 fetch and map cycle. A released
  target stages and flushes nothing, and its writes are not upload
  activity. Asked for again, its layers continue from what they hold: a
  renderer that subscribes gets the scene as it was last flushed, so a
  video writes only the tiles that differ from it. The scenes go at exit,
  and when a target needs a scene id another target's released scene has
  (`hud` and a `panel` that has fallen back to the HUD's id, "Scene ids").
- **The KOMBI's queue** (VERIFIED on the car, slot 0x100, class 0,
  [dcsm/DCSM.md](dcsm/DCSM.md)):
  - The KOMBI never takes a slot from the content it shows. The first
    content mapped into a slot is shown (map status 1). A later map is
    accepted (`E_DCSM_OK`) and parked, invisible (map status 3). When the
    shown content is unmapped, the oldest parked one is shown within about
    0.5 s. The class does not change this for 0x100. Class 1 was parked
    even with the slot free, so the map's class is 0.
  - The slot table has one row per mapping: slot, content, class and map
    status, with the slot's status in every row. The row with map status 1
    or 2 is the one shown, and so the holder. Rows stay listed, unmapped,
    until their content is unfetched.
  - The stock map is content 0x01000300, class 0. In Map view the HMI maps
    it into 0x100.
  - A phone reconnecting or a door-open warning locks 0x100 (status 0), and
    the KOMBI unmaps every mapping in it, ours and the stock map's. A map
    into the locked slot is answered `E_DCSM_OK` and never shown. Once it
    is free again, the first to ask is shown: the HMI's map, which stays
    fetched through the lock and only needs mapping, is there before ours.
- **Warnings** (iDrive 7). During a warning or with a door open, the cluster
  locks a group of slots (the middle, the right side or the HUD), takes
  everything in it off screen and keeps what it has loaded. A shown target
  taken off by a lock (or a parked `contend` one) keeps its scene loaded
  and stops drawing; nothing is asked for while the slot is locked. When
  the slot unlocks, the scene is put back at once, so it can show before
  the stock HMI's, and drawing resumes once it shows. If the cluster
  refuses that or has dropped the scene, it is asked for in full. So is a
  scene locked out for over 3 minutes, or when the cluster stops answering
  heartbeats. If the stock map still shows first, `map` takes over from it
  at once, then on its usual steps.
- **Parked.** A target the KOMBI parks stays mapped and fetched, with no
  timeout, and is `parked` (behind the holder the table names) until the
  KOMBI shows it. A parked target stages and flushes nothing. Nobody
  wanting it, it is released at once, with no linger.
- **Giving way.**
  A target with `<target>_yield_slots` gives way while the stock HMI shows
  content there: asking for the target again while a pop-up showed pushed
  the pop-up from the HUD to the cluster. It is asked for again
  `<target>_yield_ms` (1500) after the pop-up goes, and an overlay-only
  target gives way to stock content parked behind it the same way. The
  HMI puts its other HUD content in two slots (HmiMain3D's
  `getDisplayClusterParams` and `getSceneID` for the high HUD, VERIFIED in
  the firmware):
  - 0x322: its lists, content 0x01000251, class 512: the media source
    list, playlists, recent calls, apps' HUD lists (VERIFIED on a G05 with
    the media and list pop-ups). The HUD's yield slot (`hud_yield_slots =
    0x322`).
  - 0x321: its pop-ups, content 0x01000600, class 0: incoming and active
    calls, apps' HUD pop-ups, the xOffroad and M Drift widgets. Not given
    way to as shipped: an active call's pop-up would keep the HUD map off
    for the whole call, and the slot is not yet seen on a car.
    `hud_yield_slots = 0x321,0x322` adds it.

  Route guidance never counts, in any slot: the HMI's roadbook contents
  (0x01000200, 0x01000201, 0x01000210, 0x01000211 on the HUD; 0x01000300,
  0x01000301, 0x01000310-0x01000314, 0x01000360 on the cluster, the turn box
  0x01000310 among them). The HUD's guidance shows in slots of its own
  (0x330-0x332 on a G05; 0x300 on an X3, which the KOMBI disables while the
  HUD map holds 0x323). A layer with `yield` 0 (PROTOCOL.md) keeps its
  target from giving way while it wants it.
- **The HUD** (iDrive 7, `hud`): slot 0x323 only, the slot a HUD map was shown in on a G80 and a
  G05 (VERIFIED there), scene 0x01000400, class 0.
  - Another `hud_slot` or `hud_scene_id`, or `hud_take_over_stock` 1,
    leaves the HUD out: the
    service runs without it and logs why (`target hud left out: …`). It
    never takes a slot from the stock HMI, so BMW's own HUD content (its
    guidance, 0x01000210, in 0x330-0x332) is never unmapped; it gives way
    to the HUD's lists, never to guidance ("Giving way").
  - It shows with `panel`, which has a scene id of its own, unless the
    panel has fallen back to 0x01000400 ("Scene ids").
  - It has the HUD's share of the budget ("Upload budget"): up to half of
    it, only as much as it writes, and nothing it shows the governor moves
    the cap.
  - The mapping guard disables it after two strikes, and only it.
- **Take-over.** A target with `<target>_take_over_stock` (the map's
  default) takes the slot from the stock HMI, as long as a wanting layer
  has `contend`, such as the phone's map from Maps on cluster:
  - When the target is parked and the row shown in its own slot is the
    stock HMI's content, the service unmaps that content once with the
    HMI's client handle (`dcsm_hmi_client_handle`, 1). VERIFIED on the
    car: the KOMBI then shows ours, and the HMI maps its map again at once,
    parked behind ours. When ours is unmapped, the stock map is shown again
    within 1 s.
  - It is a race: about 100 ms after the unmap, either the KOMBI has shown
    ours, or the HMI's map comes back first and is shown again. On the car
    (2026-11-01 to 11-03) 10 of 33 take-overs lost it, up to four in a row,
    with the HMI mapping its map again within about 100 ms every time and
    nothing else changing.
  - Take-overs are 1.5 s apart four times, then 10 s, then every 30 s while
    the stock content keeps coming back on top; never two less than 1.5 s
    apart. The count starts over once the target has been shown for 10 s,
    and when it is released because nothing wants it or because the
    display accepted it and does not map it (not a guide hold, whose map
    can come and go faster); a target shown and parked again sooner keeps
    backing off.
  - Never content of anything other than the stock HMI, never without a
    contending layer, never in any other slot. Each one is logged with
    what was unmapped, and so is the KOMBI's reply. Unmap replies are
    matched in a queue of their own, so they never answer a fetch or a map.
- **The stock HMI and other apps** without a parked mapping (not asked yet,
  or a target that does not take over): content of an app that does not
  use this service is always yielded to: the slot is asked for again only
  once the table says it is free. The stock HMI's (scene ids 0x0100xxxx
  that are not ours) is yielded to the same way, unless a wanting layer has
  `contend`. A contending layer whose request was refused or whose scene was
  lost retries after 2, 5, 10, 20, then every 30 s, and the ladder starts
  over after 30 s shown. Nothing is asked for while the table reports the
  slot disabled (`slot locked`), unless that report is 30 s old with none
  since; a request sent before or during the lock and still unanswered when
  the slot is free again is taken down and asked for again at once. A slot
  the table reports disabled or with another content mapped, and then free
  again (a door-open warning come and gone), is asked for at once, whatever
  step the ladder is on. After a lock, a target that takes over from the
  stock HMI is asked for as soon as the slot is reported not locked, even
  with stock content shown there (the car's door sequence: 0x105 from status
  0 straight to 2, the box shown), which it then takes over. A loss with the
  slot reported locked does not climb the ladder. Without a contending
  layer, a slot the table names as held is not asked for, even when a retry
  is due.
- **Refusals, failed fetches and no answer** (neither shown nor parked
  within 5 s) retry on the same ladder; they are not upload evidence. A
  shown target whose scene the display removes with nobody else in the slot
  (not locked, not our release) asks again on the ladder too, and no sooner
  than 2 s after the removal. A fetch that fails within 1 s of a request made within 10 s
  of such a removal is the display not ready yet: asked again after 1.5 s,
  four times, before the ladder. On the car the KOMBI failed every fetch
  asked about 2 s after such a removal, 85-360 ms after the request, took
  most asked about 3.6 s after it, and once took 7 s. Requests to a slot are
  at least 1 s apart, with one outstanding. A fetch failed within 2 s of the
  scene's publication (the renderer not having seen it yet) is asked again
  after 250 ms, three times, before the ladder.
- **Accepted, not mapped.** For every target and slot: a map the display
  accepted (`E_DCSM_OK`) with no map status within 3 s (the map asked
  again every 0.5 s meanwhile), or a parked, shown or lingering scene whose
  own row the slot table reports unmapped, with no map status, for 3 s, is
  released and asked for again (fetch and map) as a loss: on the ladder, at
  once when its slot comes back from a lock, never while it is locked, and
  not upload evidence. VERIFIED on the car (2026-11-12): a lock unmaps a
  scene parked in the locked slot with no map status, and the KOMBI does
  not map it again when the slot is free, take-overs or not. A parked
  scene the stock map stays ahead of is the take-overs' business, not
  this.
- **Releases confirmed.** After a release, the next request of that scene
  id waits until the KOMBI confirms the release: the replies to the unmap
  and the unfetch, and the REMOVED of the fetch when there was one (about
  35 ms on the car). When subscriptions are observable (below) it also
  waits for the renderer to unsubscribe from the scene, which on a
  test unit follows the REMOVED by 150-170 ms. Without both within 1 s it
  goes anyway, and the log says which was missing. Every request after a
  release logs how long after it went.
- **Rendering verified.** The service reads the RAMSES client's console
  (`src/ramses_console.h`), where the library logs each renderer
  subscribing to or unsubscribing from our scenes, and writes those lines
  to its log. A shown target is `verified` once the renderer is subscribed
  to its scene, which it normally is before the display shows it. Once any
  subscription has been seen since start, a shown target whose scene is not
  subscribed 1.5 s after the display showed it (or after the renderer
  unsubscribed) is logged (`the display reports scene 0x10004f0 mapped but
  its renderer is not subscribed`), unmapped and unfetched, and asked for
  again once the KOMBI confirms that, at once the first time and on the
  ladder after that; its scene stays published. Until a subscription has
  been seen, nothing is verified and the status says `renderer subscription
  not observable`. The state is in each `target` event (`rendering`:
  `none`, `checking`, `verified`, `unobservable`) and in the status's target
  lines. The reader counts every console line by its context and the
  status says so (`renderer console: 1290 lines (ramses.Periodic 960,
  ramses.Client 3, ramses.Framework 1, other 326), the last 1 s ago`), so a
  console that goes quiet is told from a renderer whose subscriptions are
  not logged. The first 20 RAMSES lines other than the 2-second statistics
  (`ramses.Periodic`) go to the log as they are, within the 30 raw lines a
  minute.
- **Fades.** A target's video and image layers are drawn at their own
  opacity times the target's fade. The fade is 0 until the target is shown
  and rises to 1 over `fade_ms` (250) once it is. When nothing wants the
  target any more, the layers last drawn stay drawn and fall to 0 over
  `fade_ms`, and only then does the linger start. A fade steps at most
  every 50 ms, in the target's ordinary flush, with no pixel writes. Effect
  and mesh layers have no opacity and do not fade; a target with only those
  is released without one. A layer a client drops, or whose client goes,
  goes at once. A slot the display takes is gone without a fade, and so is
  everything on SIGTERM.
- **Guide hold** (iDrive 7, `guide_hold = 1`, the default). While `map`
  is shown and the stock HMI's CarPlay maneuver panel (the box, content
  0x01000310, class 0) is mapped in its slot, and only then, the service
  holds that slot with an empty 16x16 scene of its own, never drawn, so
  the box is hidden on the cluster while the map shows. With no box there
  (no route, or a navigation app that sends no guidance, such as Waze)
  the slot is left alone, and the cluster shows what it shows in it when
  it is empty, such as the car's badge (the eDrive logo, an M emblem).
  The box is in 0x105 on one car and in 0x103 on another,
  whose KOMBI reports 0x105 disabled and empty (both VERIFIED on the car).
  With `guide_slots = auto`, the default, the slot is the one the slot
  table reports the box in (below), held with `guide_scene_id`
  (0x010004f1); a list of slot ids pins a hold to each instead, the first
  with `guide_scene_id`, each next with the next id (only 0x010004f1 is in
  the shipped `scene_ids_allowed`). VERIFIED on the car with the slot
  named (2026-11-03): the KOMBI takes 0x010004f1 in 0x105, the box is
  hidden, the HUD keeps its guidance, and the box is back after the
  release; on the other car, with `guide_slots = 0x103`, the box is
  hidden and a seat-belt warning still shows on the cluster with the map
  up (its HUD and a head-unit restart not checked). `auto` itself, and
  the hold waiting for the box, have not run on a car (`slots_test`
  only). The HUD's slots are not touched.
  - Each hold is a target of its own (`guide_auto`, or `guide_0x105` for a
    listed slot), in the status but in no client's hello or events, and no
    client can put a layer on it.
  - The box is there while the slot table reports a content of
    `guide_take_over` mapped (shown or parked) in the hold's slot (`the
    box is mapped: held while the map is shown`). The hold is then asked
    for and takes the box over (below), so the box can show for about a
    second when a route starts. Once asked for, the box gone from the table
    or reported unmapped for 3 s releases it (`no box mapped: not held`),
    as when the route ends; a shorter gap, such as the one between a
    take-over and the HMI mapping the box again behind ours, does not.
    The hold is asked for again when the box next comes.
  - `auto`: the hold's slot is 0x105 or 0x103; no other slot is ever asked
    for, and `auto` is refused when another target has either. It has no
    slot until a report has a content of `guide_take_over` mapped (shown
    or parked) in one of them, the slot not disabled; that report, or a
    later one with the box in the other slot, moves the hold there (`hold
    moves to slot 0x103, where the slot table reports 0x1000310 ...`);
    shown wins over parked, then the slot it has, then 0x105. It is released from the old one first when it
    is held, so it never holds two slots, then asked for in the new one like
    any request
    (at least 1 s after the last, after the release is confirmed, and no
    sooner than a wait on the retry ladder it was in). The box unmapped (the
    route over) or mapped only in another slot, the hold keeps its slot.
    Each move counts as a loss towards the give-up (below), never as a
    fault, so a box that keeps moving gives the hold up. The mapping guard
    counts the hold as one mapping in both slots (`guide_auto auto 0x10004f1
    0`): a move never escapes a strike, and two in either or both slots
    disable it. The box's slot is in the log either way: `dcsm: slot 0x103
    status 2 content 0x1000310 class 0 map 1`. A car that needs a fixed slot
    sets `guide_slots = 0x103` (or any slot) in `cluster-render.local.conf`.
  - The map's clients choose: while any layer that wants `map` has
    `guide_hold` 0 (PROTOCOL.md), the hold is not asked for, and one held is
    released; the status names such a layer (`guide_hold 0`). A client
    that never sends the field gets the hold.
  - It is requested, contending and taking over from the stock HMI, as
    soon as `map` is shown with the box in the slot. Parked behind the HMI's content, it takes over
    as the map does, but only content in `guide_take_over` (0x01000310;
    0x01000314, the seat-belt-warning panel, is refused there): it
    unmaps that content shown in its slot and that can be parked ahead of
    ours, so none of it is shown in its place; the HMI maps it again behind
    ours. VERIFIED on the car, with `panel` taking over in 0x105: with a
    route 0x105 shows 0x01000310 with 0x01000314 always parked behind it;
    one take-over of 0x01000310 has the KOMBI show ours, the HMI maps
    0x01000310 again behind ours within about 100 ms, and 0x01000314 stays
    parked. Which ones are ahead
    comes from when ours was asked for, since the order of the table's rows
    is not known to be the slot's queue: those mapped when it was asked
    for or while it was being fetched and mapped. Content mapped after ours
    is left parked behind it.
  - It yields to any other content shown in its slot (map status 1 or 2),
    such as the seat-belt-warning panel 0x01000314 during a warning, or
    when the KOMBI shows it instead of ours: released at once (`hold yields
    to …`), and not asked for while that is shown there. Other content
    only parked there (map status 3) is neither taken over nor yielded to.
  - More than 3 losses within 60 s (our scene removed, unmapped, parked
    again behind other content, or released to yield, not to a lock; or a
    move with `auto`) give it up until the service next starts (`hold given
    up`). When none of those losses was BMW's own content taking the slot
    (a yield, a re-park behind it, or our scene unmapped or removed while
    content off `guide_take_over` is shown there, such as the seat-belt
    panel) or a move with `auto`, the give-up is also a strike of the
    mapping guard against it (below).
  - The KOMBI's watchdog for our client is fed by our own heartbeats every
    250 ms (`dcsm/dcsm_client.cpp`); a take-over's unmap goes with the
    HMI's handle, so it does not feed ours (INFERRED: the KOMBI restarts
    the watchdog of the client handle a request names, `dcsm/DCSM.md`
    "Heartbeat").
  - Rendering verification never releases it: the KOMBI's renderer
    subscribing to an empty scene or not shows nothing either way.
  - It is released as soon as `map` is not shown (within three passes of
    the loop; one still being asked for first waits up to 5 s for the
    KOMBI's answer), and on stop; the KOMBI then shows the box again.
  - Its take-overs' count starts over only after 10 s shown, not when it
    is released, so the map coming and going keeps them on their 1.5 s,
    10 s and 30 s steps.
  - It is not asked for while the latest report of its slot says
    disabled (`slot locked`, a lock or a slot the coding does not use),
    however long ago that report came. After a lock it is asked for as
    soon as the table reports the slot not locked with the box mapped
    there, and takes over the box. A map
    the KOMBI refuses with E_DCSM_SLOTID_UNKNOWN is not asked for again
    until the service next starts, and is a strike against it. A door opened was seen on the car only with `panel`
    taking over in 0x105, a target that does not follow the map: the KOMBI
    disabled 0x105 and unmapped everything in it, and `panel` was asked for
    again and took over again by itself. That the hold, after such a lock,
    is asked for again and takes over again once the slot is free and `map`
    is shown comes from `slots_test` only.
  - The map or the box shown and hidden quickly cannot make it flap
    faster than the slot manager's spacing: requests at least 1 s apart,
    take-overs at least 1.5 s apart.
  - The log has a line for each change of its state, each take-over (with
    what it unmapped, what it left parked, and the count since start) and
    each content of the HMI mapped again behind it, with our scene id and
    the slot's rows (content, class, map status: 1 shown, 3 parked, 0
    unmapped). `dcsm: slot ...` lines log every new or changed row of every
    slot the KOMBI reports, so the box's slot can be read from the log
    without the hold.
  - Settings take effect at the service's next start (`systemctl restart
    cluster-render`). `guide_hold` other than 0 or 1 counts as 1. A
    malformed slot, scene id, class or take-over list (`auto` with slot
    ids, a slot that is not whole hex from 0x1 to 0xfff, listed twice, or
    a scene id not in
    `scene_ids_allowed` or another target's) keeps the hold off, the safe
    choice: the service runs without it, and the log says why (`guide hold
    off: …`).
- **Mapping guard** (`src/guard.h`). A mapping the KOMBI cannot take can
  make it restart the cluster and the HUD (scene ids 7702 and 7703 did), and
  the service would map it again after every restart and every boot. Only
  a guide hold, the HUD and the panel's own scene id (0x010004f8, "Scene
  ids") can be disabled; the map and a fallen-back panel only have their
  strikes logged, and the map's mapping in 0x100 with 0x010004f0, the one
  the car has shown for longest, is never disabled whatever the file says.
  - A mapping event is our request of a target and the display's first
    showing of it after that request. A re-park or re-show the KOMBI makes
    on its own is none.
  - The display service (Dcsm2, or iDrive 8's DCSM) going away within 10 s
    of a hold's, the HUD's or the panel's own id's mapping event, held still
    or released since, is a strike against that mapping (its slot, scene id
    and class), even when the map had a later event; the map and a
    fallen-back panel are never blamed while such an event is in the
    window. With more than one of those in it, the latest is struck. The
    panel's own id disabled, the panel falls back ("Scene ids"). With none
    of those in it, the target with the latest event gets the strike,
    logged only. A KOMBI restart takes its SOME/IP
    service, and with it Dcsm2's TCP connection, away (INFERRED;
    CAR-ONLY). A scene removed, a silent heartbeat or a slot table without
    our rows also come from the stock HMI re-mapping its content, a full
    link or the KOMBI's own arbitration, so they are no strike by
    themselves. A restart that does not follow a mapping event within the
    window (the KOMBI also restarts on its own) is no strike.
  - A hold giving up on faults alone (more than 3 losses within 60 s, none
    of them BMW's own content taking the slot or a move, above) is a strike
    too, which covers a KOMBI renderer that restarts with Dcsm2 staying up,
    and so is a map refused with E_DCSM_SLOTID_UNKNOWN. A give-up with a
    yield among its losses (a seat-belt or passenger-seat alert that keeps
    coming back) only stops the hold until the service next starts.
  - Two strikes disable the hold's mapping: never asked for again, the
    box shown, the map's clients told (`guide_disabled` in the map's
    `target` event, PROTOCOL.md), and `status` says so (`guard: guide_auto
    auto 0x10004f1 0: disabled, 2 strikes`). Two strikes disable the HUD's
    the same way: never asked for again, however often its layers come and
    go, its clients told (`disabled` in the HUD's `target` event), the map
    untouched (`guard: hud 0x323 0x1000400 0: disabled, 2 strikes`).
  - A strike stops counting after three boots with no other against the
    same mapping; a disabled mapping stays disabled.
  - The strikes are kept in `guard_path`
    (`/var/opt/cluster-render/state/guard.txt`, written whole, renamed into
    place, its folder synced), so a boot never asks for a disabled mapping.
    A new cluster-render version starts them over. As root, `cluster-render
    guard-reset` removes the file and restarts the service if it runs; no
    client can reset it. A file that does not read starts over; one that
    cannot be written leaves the guard working from memory until the
    service stops.
- **Scene ids** come from `scene_ids_allowed`. Ids 7702 and 7703 made the
  KOMBI restart the cluster and the HUD. `map` has 0x010004f0, the guide
  hold 0x010004f1, `hud` 0x01000400 and `panel` 0x010004f8, so all three
  targets show at once (the panel's id with the HUD shown reported on one
  car). No
  stock content has 0x010004f8: neither HmiMain3D nor the KOMBI's
  firmware names it, and the KOMBI's own scenes are 99 to 201.
  - **Fallback.** The panel goes to `panel_fallback_scene_id`
    (0x01000400), logged (`target panel: scene 0x10004f8 refused: …;
    falling back to 0x1000400 until cluster-render restarts`), when the
    KOMBI refuses its id as unknown (E_DCSM_CONTENTID_UNKNOWN) or the
    mapping guard disables it after two strikes; a panel whose id the guard
    has disabled starts on the fallback. Other refusals, failed fetches and
    removals are retried on the ladder as for any target.
  - Two targets with one id (`hud` and a fallen-back `panel`) are never
    requested at once; the second's request unpublishes the first's
    released scene and publishes its own.
- **Our own id in the slot.** A target can be lost while the table still
  names its scene id. That is a report from before the loss, or the stock
  HMI's content with the same id (0x01000400 is also the speech dialog). The
  next report after our unfetch decides: still named, it is the stock HMI's;
  other content, its holder's; free, or no report within 1 s, the loss was
  ours. The ladder counts from the loss either way.
- **Recovery.** Dcsm2 going away takes every target down; the scenes stay
  published. When it comes back, the targets still wanted are asked for
  again after 1 s. A scene the display removes is asked for again on the
  ladder (2 s after the removal at the earliest), in the same scene, its layers continuing from what they hold. In
  a new scene each layer starts from what it last showed: the video's
  newest frame, written whole and exact as soon as the budget allows, its
  bytes charged to the budget as debt.

### Upload budget

Every head-unit participant shares one link to the KOMBI, and too much
upload makes the cluster drop scenes. Every layer of every client writes
within one budget (`src/governor.h`, `kit/upload_pacer.h`):

- The cap starts at the ceiling: `upload_kb_per_s` (5500 KB/s), or the
  remembered ceiling below it. When the link shows congestion (a shown
  scene removed, heartbeat replies stalling, refused or slow flushes) it
  steps down by 500 KB/s, to 2000 KB/s at the least, and recovers slowly, up
  to the ceiling. A shown scene the KOMBI removes while the cap is above
  4000 KB/s lowers the ceiling for the rest of the drive. Clients get a
  `budget` event when the cap changes.
- **Remembered ceiling.** A removal also lowers the ceiling for later
  drives to one step below the level it came at, kept in
  `/var/opt/cluster-render/state/upload-ceiling`. After 3 clean drives at
  it (each with a target shown 10 min in all and no removal) the next drive
  tries one step higher, and keeps it if that drive is clean; a removal
  there keeps the old ceiling and starts the count over. A firmware update
  or another KOMBI variant forgets it. `upload_kb_per_s` set in the local
  conf is the ceiling, and the remembered one is not used.
- **What the log keeps.** One `INCIDENT` line each time a shown target is
  lost (why, the cap and ceiling, how long it was shown) and when it is
  back (put back after a lock, asked for in full, or shown again by the
  cluster). On a removal, the 30 s before it second by second: KB written,
  budget holds, offer-to-flush time and the deepest TCP send queue on the
  head unit with its peer; once a minute, a summary of the same. In the car
  logs none of these rose reliably before a removal, so none steers the
  cap.
- Within the cap the top layers write first. A video frame whose exact
  write the budget cannot cover goes as packed 4x4 blocks (with
  `pan_blocks`), the exact picture follows when the budget allows, and only
  the newest frame waits.
- **The HUD's share.** While `hud` has a layer, its layers and assets write
  from up to half of the budget, only as much as they spend; what the HUD
  leaves goes to the cluster. With the cluster idle the HUD gets the whole
  cap. Together they never exceed it.
- Video tiles wholly covered by opaque layers drawn above them are not
  written while they stay hidden (`src/occlusion.h`). Opaque means a video,
  or an image where its pixels have alpha 255, drawn unturned, unanimated
  and at full opacity, not fading; effect and mesh layers never cover.

`cluster-render status` and `/run/cluster-render/status.txt` show the cap,
why it is what it is, and the remembered ceiling.

### Layers

| Kind | What the client sends | What the service does |
|---|---|---|
| video | 4:2:0 atlases (`w*h*3/2` bytes) | one persistent buffer; only 64x64 tiles that changed past a noise filter are written, settled after `settle_ms`; packed 4x4 blocks for motion the budget cannot cover; newest frame only |
| image | RGBA rectangles that changed | one persistent RGBA8 buffer, written in those rectangles at most `fps` a second |
| effect | a GLSL ES 1.00 fragment shader, uniforms (arrays too), binds to assets | a quad drawn by it; `u_time` at `time_fps`, or from the renderer's own clock |
| mesh | parts: shaders, geometry (`M`), transforms, uniforms, binds to assets | a render pass of its own over its rect, with its own perspective or orthographic camera; geometry replaced at most once a second within the budget; depth cleared, never colour |

Beside the layers:

- **Assets:** RGBA8, R8, `etc2rgba` or `etc2rgb` textures a client uploads
  once and its effect layers and mesh parts on the same target sample, such
  as a glyph atlas or sprites. Not drawn, so they never make a target
  wanted. A compressed asset is sent whole once: a 2048x1024 atlas takes
  2 MiB as `etc2rgba` and 1 MiB as `etc2rgb`. On iDrive 7 the KOMBI draws
  `etc2rgba` atlases up to 2048x2048 on the cluster and the HUD
  ([TEST-ETC2.md](TEST-ETC2.md)); `etc2rgb`, and both on iDrive 8, have not
  been tried on a car. `tools/etc2_test/etc2_encode.py encode IN.rgba W H
  OUT.etc2 [etc2rgb]` encodes them. Which format to use: PROTOCOL.md
  "Choosing a pixel format"; artwork sent once animates with no more pixels
  sent: PROTOCOL.md "Animating preloaded assets".
- **Several videos:** clients have up to 8 video layers together, and the
  display holds the buffers of at most two. Past two, the videos on a
  target drawn unturned, at their frame's size and at even x and y are
  composed on the head unit into one video; a turned, scaled or odd-placed
  video always takes a buffer of its own (PROTOCOL.md "Client to service").
- **Turns:** video, image and effect quads rotate and scale about a pivot
  (a needle).
- **Animations:** keys the renderer plays by itself on a quad's rotation,
  offset and scale, a part's pose, a mesh camera, or a uniform; nothing is
  sent per frame.
- **Scene files** (PROTOCOL.md "Scene files"): on a target with
  `<target>_scene_files` 1, a RAMSES scene file and its resource files,
  authored beforehand, loaded as the target's whole scene and changed live
  by edit lines (`--hide`, `--rotate`, `--uniform`, `--set`, ...). Taken
  only from under `/var/opt/`, owned by root and writable by no one else,
  with the SHA-256 the client gives. With `layers` 1 the target's layers
  are drawn over the file (RAMSES 19 only), and the scene may host another
  target's content (PROTOCOL.md "Hosting another target").

Each target's changes are flushed together once a tick, so the cluster never
shows a half-written frame: a video or exclusive image left half written
holds its target until its whole rewrite goes.

### Lifecycle

- `cluster-render.socket` listens from boot; the first client starts the
  service. Clients reconnect by themselves (0.25, 0.5, 1, then every 2 s)
  and make their assets and layers again with their last settings, images
  and assets sent whole, a video layer's last frame sent whole.
- A client's layers go with its connection, then its assets. A video layer
  whose frames (or repeats) stop for `stall_ms` stops wanting its slot.
- On SIGTERM every target is released.

### Identity and packaging

`hmi_5000` (the one uid allowed Dcsm2 and the RAMSES offers), participant
801, vsomeip application `cluster-demo` and clientID `"\0cluster"`, on
iDrive 7 and iDrive 8. A standalone renderer with the same identity
(`cluster-demo.service`) cannot run beside it, so the service conflicts
with it (`Conflicts=`). One systemd unit serves both generations: it runs
`cluster-render`, which starts `cluster-render-idrive7` or
`cluster-render-idrive8` in its place.

### Supported head units

Every iDrive 7 and iDrive 8 head-unit variant. On a head unit whose variant
cannot be read (a kernel command line with no `hwvariant=`, or two that
disagree) the service draws nothing: it stays up holding only its socket, a
status request gets `not supported on this car (head unit: ...)` and any
other message an `error` event with that reason.

### Install

From the Store ([robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store)),
as a requirement of the apps that use it: the binaries, its settings and
the Node client in `/var/opt/cluster-render/`, `cluster-render.socket`
enabled. The same kit installs on iDrive 7 and iDrive 8; `cluster-render`
starts `cluster-render-idrive7` or `cluster-render-idrive8`.

To install a kit built from the working tree over SSH, with mgu-store's
deploy tool (from this repository's root):

```sh
node release/tool_artifact.js native/cluster-render --out /tmp/kit   # runs make target, writes /tmp/kit/cluster-render@<version>.tgz
<mgu-store>/deploy/hu install --artifact /tmp/kit/cluster-render@<version>.tgz
```

### Configure

[`cluster-render.conf`](cluster-render.conf) lists every setting with its
default: the generation (`auto`, `7` or `8`), the identity, the targets
(slot, content class, scene id, size, linger; on iDrive 8 the `id8_` ones),
the targets that take scene files, the guide hold, the upload budget and
the tick. A unit's own settings go in
`/var/opt/cluster-render/cluster-render.local.conf`, which updates keep;
each key there replaces the shipped value, and `key += a,b` adds to a list.
`-s key=value` on the command line overrides both. An error in the shipped
file, local_conf or the command line stops the service (exit 2).

`cluster-render status` prints the targets, the display service's state,
every client's layers and the upload cap. The log is in
`/var/opt/cluster-render/log/cluster-render.log` (and `.log.1`), in UTC.

### iDrive 8

iDrive 8 draws its cluster and HUD with RAMSES 27, which has DCSM built in:
the head unit offers content in a category and the cluster decides when to
show it ([abi/ABI27.md](abi/ABI27.md)). A target's slot is a category and
`id8_<target>_content` the content offered in it. An offered target is
`parked` until the cluster shows it; the cluster shows some categories by
itself (the middle, the HUD, and the head unit's own guiding panel) and a
widget once it is picked in its widget menu. It takes a shown widget back on every layout
change and shows it again 1 to 7 s later. There is no take-over and no
guide hold, and `panel` does not exist (a layer on it is refused).

| Target | Category | Content | Size | Where |
|---|---|---|---|---|
| `map` | `Ca_ComCenter_IC` 43100201 | 43204041 | 874x749, all shown | the middle of the cluster, between the gauges; the cluster draws its media placeholder over it |
| `hud` | `Ca_ComCenter_HUD` 43100202 | 43204012 | 353x203, all shown | the HUD, above its speed bar |
| `guide` | `Ca_GuidingPanel_IC` 43100401 | 43204051, a dynamic content | 702x213, all shown | the top centre of the cluster, over the map in the normal layout |
| `widget` | `Ca_Widget_IC` 43100301 | 43204001, a dynamic widget (43202001-43205000) | canvas 2240x896, most of it shown (below) | the middle of the cluster once picked in its widget menu, with the entry `id8_widget_description`, `_order` and `_preview` |
| `popup` | `Ca_Widget_IC` 43100301 | 43204003, a dynamic widget | canvas 2240x896, as `widget` | the middle of the cluster, on a black middle, by itself while a client draws on it: a focus request with the offer |

- **The widget's canvas** is the whole cluster. Shown, in canvas
  coordinates: about x 400-1720, y 143-765 in the normal layout and x
  690-1530, y 185-700 in the M layout, with a black notch at the top middle
  down to about y 167, dimmed behind the gauge panels and the bottom bar. A
  big picture fits best at 1140x480 at 550,220 in layout 4. The safe rect
  moves with the layout (layout 4: 630x570 at 805,125; layout 5: 612x527 at
  814,170); clients are not told it.
- **Widget options:** `id8_<target>_background_id` (43400001, 43400004,
  43400005 or 43400006 black out the cluster's own artwork behind the
  widget), `_layouts` (a mask of the cluster views it is shown in; 1 is
  ROAD) and `_focus` 1 (the cluster switches to the widget by itself
  when it is offered).
- **Your own widget.** A target is its keys: `id8_<name>_<field>` for any
  name of lowercase letters and digits, with the fields `category`,
  `content`, `scene_id`, `size`, `linger_ms`, `description`, `order`,
  `preview`, `background_id`, `layouts` and `focus`. A tool installed under
  `/var/opt/<id>/current` adds one with a drop-in there,
  `cluster-render.d/<name>.conf`, which goes with the tool on uninstall;
  the unit's own drop-ins go in `/var/opt/cluster-render/conf.d/`
  (`cluster-render.conf` has an example). A drop-in adds its targets and
  scene ids with `+=` (`id8_targets += mywidget`, `id8_scene_ids_allowed +=
  0x4d4755000020`) and sets only those targets' keys. Each target it adds
  is a widget: category `Ca_Widget_IC` 43100301, a dynamic widget content
  (43202001-43205000, never the head unit's own 43202020-43202120) and a
  scene id `0x4d4755……`, none of them another target's; the drop-ins
  together add at most 8 targets. `_preview` is a regular file of at most
  1 MB. A drop-in is read only as a regular file owned by root and writable
  by no one else; a bad one is skipped whole, with a warning in the log,
  and the service runs without it. `cluster-render status` lists each
  drop-in, `loaded` or `skipped` and why.
- Whether the cluster shows `guide`'s content, and which content it shows
  there during route guidance while the head unit offers its own guiding
  panel in the same category, is not known yet.
- What the head unit does when `cluster-render.service` exits or is
  restarted on iDrive 8 is not known: don't stop or restart it on an
  iDrive 8 car.
- Content ids the head unit offers itself (`C_NaviMap_IC` 43200501,
  `C_GuidingPanels_IC` 43201101, `C_Media_IC` 43202120, ...) are never
  offered: two providers of one content fight.

### Building and testing

In `native/cluster-render`:

```sh
make test                       # every host test
make test-x86                   # the C++ tests with the unit's gcc 7.5 in Docker (SSE2 paths)
make target                     # build/target/cluster-render, cluster-render-idrive7, cluster-render-idrive8
                                # and libcluster_render_client.a, every import checked against the units' libraries
make test-ramses ROOTFS=…       # every layer kind and a scene file on the unit's own libramses
make test-ramses27 ROOTFS=…     # the same on an iDrive 8 unit's libramses 27
```

The host tests need a C++14 compiler and Node; the rest need Docker
(linux/amd64, the image `cluster-render-build` from `docker/Dockerfile`).
`ROOTFS` is a copy of the unit's root filesystem, which is not part of this
repository.

On a test unit whose stand-in KOMBI has no slot 0x100, run the
binary as `hmi_5000` with `-s map_slot=0x201`. On an
iDrive 8 test unit with a stand-in cluster for a category, run `cluster-render`
as `hmi_5000`: it starts the iDrive 8 service.
`js/showcase.js` puts content of every layer kind on a target through
the service and prints every event: `node showcase.js [--socket PATH]
[all|cube|text|needle|plasma|alert|video] [--target panel|map|hud|guide|widget]
[--size WxH]` (iDrive 8's `map`: `--size 874x749`).

The host tests:
- `log_test`: the log file's timestamps, start line, rotation to `.1`, no
  descriptor open between lines, lines dropped while the file system is
  read-only or full and written again after, and a path that cannot be
  opened;
- `slots_test`: arbitration, on slot tables of one row per mapping as the
  car reports them: parked targets, take-overs and their spacing, locks
  and the car's lock and take-over sequences;
  warm scenes and a shared scene id, requests waiting for a release's
  confirmation, quick retries of a fetch failed after the publication, the
  rendering verdicts and their recovery, and the guide hold following the
  map: held only while it is shown, released when it is not, not asked for
  while its slot is disabled, held again after a door lock once the slot is
  free and the map shown, again at once after a second lock, its take-overs'
  count starting over after 10 s shown, the stock contents ahead of it taken
  over and those behind it left, the HMI mapping it again logged and taken
  over no more, the seat-belt panel left alone while parked and yielded to
  while shown, never released by rendering verification, and no flapping;
  never asked for while the table reports its slot disabled, however long
  ago, or does not name it; the HUD under the guard: a display drop after its
  mapping striking it and not the map, also with the map mapped after it,
  two disabling it and only it, in that boot and the next, wanting it again
  not undoing that; `map`, `panel` and `hud` shown at once with their own
  scene ids, released and asked for again apart; the panel falling back to
  the HUD's id when the KOMBI refuses its id as unknown or the guard
  disables it, and not for other refusals or removals; the HMI's speech
  dialog in 0x203, on the HUD's id, given way to; and `panel` and
  `hud` on one id never asked for at once; display drops around the hold:
  logged naming the target mapped last, a re-park and re-show by the
  display no mapping event, the hold asked for again with the map; its
  slot refused as unknown: not asked for again until the next start; a
  give-up, on unmaps or on yields to the seat-belt panel, in each of two
  starts, held again at the second; the hold only while the box is
  mapped in its slot, in 0x105 or 0x103, fixed or `auto`: no box, never
  asked for; the box shown, held and taken over; the box unmapped by the
  take-over and mapped again behind ours, still held; the box gone 3 s,
  released; the box coming and going fast, the spacing kept; with `auto`,
  the hold in 0x103 or 0x105, whichever has
  the box with the other disabled, no slot before the box, never in any
  other slot or a disabled one, moving
  The CN mapping guard retains persistent strike and disable checks (guard.h).
  with the box and keeping a ladder wait, a box that keeps moving giving
  it up with no strike, and Dcsm2 drops after its mappings in both slots
  disabling it at the second, in that boot and the next;
- `ramses_console_test`: the RAMSES console lines the car's libramses
  prints (subscriptions, unsubscriptions, a renderer gone, resource
  requests), which lines are kept raw, and the raw lines' rate limit;
- `governor_test`: the budget's steps, cooldown, recovery and probation,
  the removal hold, and the levels above 4000 KB/s a removal bars for the
  run;
- `map_upload_test` (the kit's): the HUD's share: its source deciding
  exactly as alone with the share off, never more than half for a greedy
  share and never less than half for the source, an unspent share going
  back, an idle source's whole rate for it, within a burst, and the two
  together never holding more than one burst (both still, then both
  greedy);
- `compositor_test`: the map's flushes byte for byte as without a HUD
  while the HUD has no layer; with a HUD layer and the map moving at the
  cap, at least half the bytes for the map and at most half for the HUD at
  its 10 a second; the HUD alone at its rate, within the cap;
- `compositor_test`: layers on a fake renderer that keeps pending and
  flushed state apart. It covers dirty, packed and exact writes, failure
  parking, the stack and the closed budget loop: slow flushes lower the cap
  and the bytes written follow it. Also assets (written before the layers
  sampling them, charged to the budget, bound again, refused as a drop
  while sampled), mesh parts and their looks, geometry paced and replaced
  at most once a second, passes following the stack with an exclusive
  layer, turns, uniform arrays, animations, and a scene published again
  rebuilding all of it; fades in and out and their timing, a parked
  target staging nothing, and a released target's warm scene; the limits
  (64 layers a client, 96 in all) and 96 small layers changing every tick
  past the 5500 KB/s ceiling, written within it, each an even share;
- `video_composite_test`: one video, and two on one target or on two,
  draw themselves and drive the renderer call for call and byte for byte
  as recorded from the build before composites (`test/video_trace.h`); a
  third composing on as few targets as it takes, and separating again; a
  camera joining a shown map between passes, and sets, traced the same way;
  a video joining a kept composite at its opacity at once; a refused video
  not tried again until its scene is published again, and its refusal
  gone once it is composited; a video sliding every tick for 10 s remaking
  the composite at most once a second and shrinking it after; a video moved
  faster than the budget writes, hidden, shown and with flushes refused,
  its quads never over a place that does not hold it; a video stepped 1 px
  a set for 10 s making a bounded number of buffers; a video arriving
  while a composite waits to shrink priced against the one held; a held
  change refused when it would not fit once taken, and videos let in past
  what fits changing no buffer; a composite made with a video held at an
  odd x starting at the even x; the
  blend and cells, SSE2 and
  scalar equal, against a float reference; an opaque video drawn through
  the composite exactly as alone (the shaders' CPU twins); two, three and
  four videos on one target (two on a one-buffer display) with order,
  opacity, overlap and none; only
  changed tiles composed and written; hiding, showing, moving, fading; the
  limits and refusals (client videos, display buffers, memory, span, a
  `set`); the last other video leaving and the remaining one drawing itself
  again; at most two video buffers on the display whatever comes and goes;
  three moving videos within 5500 KB/s; the composing cost, printed;
- `occlusion_test`: the coverage's cells and the tiles' footprints (luma,
  chroma, scaled); the tiles under an opaque camera left unwritten; nothing
  hidden under a translucent, turned or scaled camera, an effect layer, an
  image with transparent pixels (written or waiting), an animated image;
  a camera, an image, a fade, packed blocks, a composite under an image
  and a scaled map under a composite, moved, hidden, shown, made
  translucent and turned faster than a tight budget writes, with refused
  flushes and writes: no flush shows a part of a video from another frame
  than the rest; the map panning past the budget (and after resent's
  charge) while an image over a panel video moves and hides: the panel's
  other changes flush every tick, the image's change waits only for the
  budget's debt; a hidden tile changed within the threshold kept across a
  scene published again; a camera as large as the map hiding every map
  tile (the map writing nothing while covered, the camera the budget),
  moved aside, back and removed with nothing stale; an 800x480 camera
  hiding exactly the tiles it covers, chroma ones included; an exclusive
  alert dismissed or removed during a pan, made before or after the video,
  never showing neither, and removed while above it an image hides and
  another moves onto it; an exclusive alert added again and again during a
  pan past the budget, shown within 300 ms each time, never showing neither;
  an image animated and stopped every tick, no write
  going while the budget is in debt; an image removed and made again,
  writes past the budget never back to back; a composite the renderer
  refuses over a scaled map, the map shown and nothing hidden; a held
  opacity change meeting a fade step, nothing stale; a camera sliding or
  jumping over a panning map and a panel change uncovering within the
  debt and one map frame; a full-slot camera's client gone mid-pan, its
  map's forced write packed, every window within the rate, the burst and a
  frame and a packed frame; a hole made transparent in an image under a
  saturated budget, never forced; with nothing opaque over a video, every
  renderer call and byte equal to the trace recorded from the base branch
  (a camera at 0.9 or turned, Waze on the cluster and the HUD, an overlay
  with transparent pixels); a minute's bytes under an
  opaque, a translucent and a moving camera, and the cost a tick, printed;
- `dcsm2_port_test`: the Dcsm2 request sequence, parked and promoted
  mappings, take-overs, reply matching and refusal kinds; the undecoded
  notifications' rate limit, subscription answers, the no-answer line and
  the status text; releases confirmed by REMOVED or the unfetch's reply;
  slot rows logged for slots no target uses;
- `dcsm27_port_test`: iDrive 8's offers under the slot manager: parked
  offers, ready, show, hide and release, a stop and its scene kept until it
  is accepted, a request while it is not, refusals, two targets;
- `generation_test`: telling iDrive 7 from iDrive 8 by MainApp's folders and
  the running HMI;
- `holds_test`: the HUD's rules (0x323 and its share, any other slot or a
  take-over refused); the guide hold's settings, on as shipped, `guide_hold`
  other than 0 or 1 taken as 1 with a warning, and every other malformed
  value refused with no hold added (a slot that is not whole hex from 0x1
  to 0xfff, listed twice or another target's, a scene id not allowed or
  another target's);
- `scene_test`: scene files and their edits, on files it writes: SHA-256
  against the standard's vectors; a scene file and its resource files
  taken from under the root, also through a symlink staying there, and
  refused through one leaving it, with `..`, relative, missing, a folder,
  writable by the group or others (the file or a folder below the root),
  another owner's, with a hash not its file's or one too few, more than 16
  resource files; every edit kind parsed and malformed lines refused; the
  keys a line replaces a kept one by; the edits applied to a synthetic
  gauge, each pattern resolved once over 30 updates, a line changing
  nothing reported once, and a new scene given every kept line ending as
  the first;
- `settings_test`: the shipped cluster-render.conf loading with every key
  known; `id8_<name>_<field>` taken for any target name and each field,
  every other unknown key refused; `+=` adding each entry once; a target
  declared by its keys alone loaded on iDrive 8; drop-ins, on files it
  writes: a widget target added, read in the order of their paths across
  patterns, a file matched twice once, a skipped one not stopping the next,
  the earlier of two with one content kept, `drop_ins` empty reading none;
  and every bad one skipped whole with the settings as before it: an
  unknown key or line, a missing scene id, a content or scene id another
  target's, a scene id not allowed, a list set rather than added to,
  another key or another target's key set, a target already listed, a
  category other than the widget one, a content outside the dynamic
  widgets or the head unit's own, a scene id not ours, more than 8 targets
  from drop-ins, a symlink, writable by the group or others, another
  owner; a widget's picture read, a device, a pipe, a missing, empty or
  too large file refused, a symlink to one followed;
- `guard_test`: the mapping guard's file: a strike read back, a hold's
  mapping disabled at its limit and after a reboot, the default limit never
  disabling, the map's mapping never disabled whatever its limit or the
  file, another version started over, strikes expiring after three clean
  boots while a disabled mapping stays, the file removed, a file that does
  not read or cannot be written;
- `service_test`: the whole service over its socket with the C++ client,
  on a fake KOMBI that parks and promotes as the car's does (the map taking
  over from the stock map and falling back to it, and asked for again in
  the same scene once the KOMBI confirms its release),
  including a restart under the client that makes assets, binds, uniform
  arrays, mesh parts, geometry and animations again, and malformed or
  oversized mesh messages and bad keys refused; the guide hold on a KOMBI
  showing the box: no client's target, held with the box parked behind it
  while the map is shown, and with the seat-belt panel parked there,
  released with the map and at stop, released and taking nothing over while
  the map's layer has `guide_hold` 0 and held again with 1, held for a
  client that never sends the field; the mapping guard: a cluster restart
  right after the hold's mapping strikes the hold and not the map, also
  while the hold is still being asked for in the tick its map was shown, two
  disable it (the map shown without it, also after a service restart, and
  the map's client told), a restart 15 s after any mapping is no strike,
  the map's strikes never disable it, and a client's `guard_reset` is an
  unknown op; scene files: refused on a target without them, with a
  resource file's hash not its, from outside the root; a synthetic one
  parked behind stock content with its edits in its first flush, an edit
  held while parked, shown; made again with its edits by the client after
  a restart; the layers there waiting, named by the scene's ref or client;
  unpublished while the HUD (the same scene id) is shown and loaded again
  with every kept edit; dropped, the layers back; a file of another scene
  id in error; edit lines refused or changing nothing reported; another
  file in place, the slot kept; its client gone, shown through the linger
  and released; a scene with layers: the layers drawn over the file past
  its passes, its edits flushed with them, also while a video's refused
  write holds the target; a host of the map told to every client, refused
  (and ended) outside either target, not sent by the client for the
  scene's own target or without layers, a producer's video moved into the
  host's rect over the file with the map's slot released, hidden, back
  with the scene, its edits and its host after a service restart; a host
  the service refused, or one a `layers` 0 replacement ended, not sent again
  after a restart; ended by a file that fails to load (gone from the
  status), by `layers` 0 and by the scene's drop; a backend drawing nothing
  over files leaving the layers waiting and refusing hosts, nobody told;
- `js/test/client_test.js`: the Node client against `host_service`,
  assets, a mesh layer and a scene file included, and a scene with layers
  hosting the map: the part sent as the C++ client sends it, a refused host
  forgotten, shown, hidden, replaced (its hosts forgotten) and dropped.

### Verified, and open

Verified off the car:
- **The kit.** waze-on-cluster built from the kit gives a binary whose
  loaded sections are byte-identical to its 0.4.24 release.
- **Host tests.** Every one above passes on the host and with the unit's
  gcc 7.5 (`make test-x86`).
- **The unit's own libramses 19.0.14** (`make test-ramses`) took everything
  the service does with no error logged:
  - every layer kind, and the effect shaders compiled by its glslang;
  - whole, partial and packed video writes and the return to exact;
  - draw-order changes, an exclusive layer and removals;
  - a scene published again;
  - perspective and orthographic views between quads in five passes, one
    reaching past the target's edge and one moved off it, reordered into
    three;
  - parts with every attribute and every uniform semantic (`u_normal` as a
    mat4), depth, culling and blending, geometry made and replaced;
  - R8 and RGBA8 buffers, repeating and clamped, sampled by one effect with
    a vec4 array, and mat4, vec3 and float uniforms;
  - turned and scaled quads;
  - animations of every property, linear and step, on quads, parts and
    cameras, uniforms included, stopped and dropped with their objects;
  - through the compositor, a lit cube turning in a mesh layer, labels over
    a glyph-atlas asset, a needle sweeping and plasma on the renderer's
    clock, all back after the panel was taken and published again;
  - scene files (on another build of 19.0.14, `abi/ABI.md`): a synthetic
    gauge saved by the library with its resource file, loaded as the
    panel's scene with every edit kind read back from the library, its
    needle turned at 30 edits a second, unpublished for the HUD's shared
    scene id and loaded again with every kept edit, replaced in place by a
    second file with the slot kept, layers over it (a video and an effect
    in passes from render order 2, past the file's two, its edits flushed
    with them, gone again with the file kept), dropped with the resources
    its loads made; a file of another scene id refused.
- **The target binary** links against the unit's libraries within its
  glibc 2.27 and libstdc++ limits.

Verified on a test unit: its stand-in KOMBI renderer and Dcsm2
provider (not the KOMBI), with the map on 0x201 and clients using the Node
client under the unit's Node 8.
- **Startup and drawing.** The service joined as participant 801, found
  Dcsm2, and drew on both targets at once: a 15 fps video with an overlay
  image on `map`, and a uniform-driven effect on `panel`.
- **Requests.** Each target took one fetch, one map, one unmap and one
  unfetch.
- **A client leaving.** Its panel lingered 3.0 s and was released; the map
  sent nothing.
- **An exclusive alert.** It suspended the video, which was back within
  2 ms of the alert going, with no Dcsm2 traffic.
- **Frames stopping.** The video stalled after 6 s and the map was released
  after its linger.
- **Shutdown.** SIGTERM shut down cleanly.
- **Warm scenes and rendering** (the car's libramses build, a video client
  on `map` wanted for 12 s and gone for 10 s, three times): the scene was
  published once and unpublished only at SIGTERM. Each time the client came
  back the service asked again (the KOMBI stand-in had confirmed the
  release), the renderer subscribed 45-105 ms after the fetch, and the
  service logged the map rendered 200-400 ms before the display showed it.
  Screenshots showed the client's frame each time. After each release the
  renderer unsubscribed 150-170 ms after the REMOVED. RAMSES's console was
  at info, its lines left stdout, and the subscription lines reached the
  service's log.
- **3D and the rest** (`js/showcase.js` on `panel` and `map`, and one-off
  check clients for depth, the cut view, angles and mat4 order, checked on
  screenshots):
  - **Meshes.** A lit cube turned by the renderer draws with depth: a
    smaller cube behind it is hidden. Its pass leaves the colour below it
    and stays under a label drawn over it. An exclusive alert hides it, and
    a view cut at the target's edge draws pixel for pixel as the uncut part.
  - **Turns** go clockwise on screen for video, image and effect quads.
    Mesh and camera angles are right-handed, posed or animated.
  - **Text and needle.** Glyph-atlas text with a sprite updates once a
    second, and the needle sweeps about its pivot.
  - **Clock.** `u_time` runs on the renderer's clock: with only animations
    running, no flush is sent for 14 s.
  - **Matrices.** A mat4 uniform is read in column order.
  - **Restart.** Everything is back after the service restarts under the
    client.

Not verified, needs the car:
  - how the KOMBI's renderer draws the same: the extra passes and their
    depth clear, render order, the cut view, and mat4 order on its GPU;
  - animations against the KOMBI's clock;
  - slot 0x100, and the map and the panel shown at once, from one
    participant;
  - fades on the KOMBI. The take-over and the parked state are VERIFIED
    on the car (above), and the HMI took up to five take-overs in a row
    within about 73 s (0, 3, 13, 43 and 73 s); the test unit's HMI never takes
    a cluster slot;
  - the take-overs' 1.5 s pace: five within 6 s;
  - what the HMI does after a take-over in views other than Map view;
  - heartbeat replies: the test unit does not answer heartbeat requests;
  - 0x010004f8 on the panel with the HUD shown, on cars other than one;
  - 0x01000400 on a fallen-back panel while the HMI's speech dialog exists;
  - how a flush's duration and the heartbeat replies behave as the link
    fills, which sets `slow_flush_ms`;
  - the governor's steps on a real drive;
  - Maps on cluster and other clients through the service at once;
  - the KOMBI's renderer subscribing to and unsubscribing from our scenes
    as the stand-in does: the subscription before the display shows the
    scene (verification), and the unsubscription within 1 s of a release
    (the re-request's wait). The same library logs both on the car, but
    when the KOMBI subscribes has not been seen there;
  - the guide hold: `guide_slots = auto` choosing the box's slot (VERIFIED
    only with 0x105 and 0x103 named by hand), the box's slot and whether
    the KOMBI takes 0x010004f1 there on other units (the mapping guard
    disables a hold the KOMBI restarts on), and the hold after a
    door-open lock (seen only with `panel`). If the KOMBI ever shows the
    parked 0x01000314 instead of ours after a take-over, the hold yields,
    and that panel stays shown until the HMI parks it again; on the car
    the KOMBI showed ours;
  - the mapping guard's signal: that a KOMBI restart takes Dcsm2 away
    (INFERRED; a test unit's stand-in KOMBI does it on demand);
  - whether a hold's loss is a fault or BMW's content is judged from the
    slot table at the loss, which can lag the KOMBI;
  - `cluster-render guard-reset` restarts the service with no recmgr check:
    run it only on a unit that has booted with cluster-render installed;
  - that the KOMBI draws a warm scene asked for again. Once on the car, a
    scene destroyed and published again with the same id within a second
    was reported mapped and never drawn; `hud` and a fallen-back `panel`
    handing their shared scene id over still do that.

On iDrive 8 ("iDrive 8"), verified on the car with icwidget, a test widget
of ours on the same calls (RAMSES 27 scene, DCSM offer, user 801), as
`nav_didui`, 2026-10-25 and 27:
- the cluster takes offers from user 801: the widget in its widget menu,
  and in `Ca_ComCenter_IC`, `Ca_ComCenter_HUD` and the other categories of
  the table, shown by the cluster by itself;
- the areas: canvas, category rect and safe rect (canvas coordinates) per
  layout; the widget taken back and shown again on a layout change;
- a scene of ours drawn in the widget with no colour clear: moving text
  left no trail;
- the stop: offer stopped, accepted, the scene unpublished, the process
  gone without a crash (any crash on the unit restarts the head unit, so
  `cluster-render-idrive8` leaves with `_exit()` once the offers are
  stopped).

Verified off the car:
- **The unit's own libramses 27.0.116r1** (`make test-ramses27`, on a
  copy of the unit's root filesystem): every check of
  `make test-ramses` passes, nothing logged as an error.
- **The target binary** loads with the unit's own loader and libraries,
  every symbol bound (`LD_BIND_NOW`).
- **iDrive 7 unchanged:** its program builds from the same sources with
  the same checks, and `make test-ramses` passes on the iDrive 8 unit's own
  copy of libramses 19 too (another build than iDrive 7's).

Verified on an iDrive 8 test unit (its root filesystem with
Hmi8 running, its vsomeip and policies; a stand-in cluster, a DCSM consumer
and renderer on the unit's libramses, for one category: no KOMBI):
- **Start.** `cluster-render` found iDrive 8 (both MainApp folders, Hmi8
  running) and started `cluster-render-idrive8`, which connected as user
  801 as `hmi_5000`.
- **`map`.** Offered in `Ca_ComCenter_IC`, parked, asked for, ready and
  shown about 125 ms after the offer; `js/showcase.js all` on it drawn by
  the stand-in (plasma, dial and needle, the lit cube with depth, text over
  a glyph atlas, video, then the exclusive alert); checked on a screenshot.
- **`widget`.** Offered with its menu entry (the stand-in got "Cluster
  renderer", order 50) and shown.
- **Release and shutdown.** The client gone, the offer stopped and
  accepted, then the scene unpublished, with no error from the stand-in;
  SIGTERM exited 0. (Before 0.2.2's warm scenes were merged: a released
  scene now stays published until shutdown.)

Not verified, needs the car (iDrive 8): the CAR-ONLY list of "iDrive 8".

### Releases

A version is `component.json` `version` (`x.y.z`), published once; the
release sets it ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)). The
repository's release tooling (`release/`, its README) builds, checks and
publishes cluster-render with the repository's other components, from the
repository's root:

```sh
node release/release.js check cluster-render              # build twice, compare the artifacts byte for byte
node release/release.js publish cluster-render --dry-run  # what publish would do
```

Builds run on a `git archive` export of HEAD, never the working tree, with
`SOURCE_DATE_EPOCH` the time of the last commit that touched what ships
(everything but `test/` and the notes at its top level).
`release/tool_artifact.js` runs `make target` and packs the tool kit
`cluster-render@<version>.tgz` in the deploy tool's format (mgu-store's
`deploy/hu artifact` packs the same bytes): its `component.json` (each
file's sha256, `mguHmi`), `files/` and `units/`, sorted, owned 0:0, one
mtime, gzip without a name or time.
Node's bundled zlib is the one outside input, so CI pins Node 22.12.0.

The repository's catalog (schema 2) lists cluster-render with `requires`,
`uninstallable` and `mguHmi` from `component.json`:

```json
{ "id": "cluster-render", "kind": "tool", "title": "Cluster renderer", "description": "…", "version": "0.1.0",
  "artifact": { "name": "cluster-render@0.1.0.tgz", "size": 2242698, "sha256": "…",
                "url": "https://api.github.com/repos/robertnisipeanu/idrive-apps/releases/assets/<id>" },
  "requires": { "mgu-deploy": "0.4.0" }, "uninstallable": true, "mguHmi": ["ID7", "ID8"] }
```

mgu-deploy checks the kit's `mguHmi` from 0.3.0 and, from 0.4.0, applies
an update's changed socket unit: at once while the service is stopped,
else with the next boot.

### License

The service is GPL-3.0-or-later ([LICENSE](LICENSE)). What apps compile in
or copy, `include/`, `client/`, `kit/`, `js/cluster_render_client.js` and
[PROTOCOL.md](PROTOCOL.md), is MPL-2.0
([LICENSES/MPL-2.0.txt](LICENSES/MPL-2.0.txt)), so apps under any license
can use them; they reach the service over a socket. `abi/include/ramses19/`
declares the API of RAMSES (BMW Car IT, MPL-2.0) and the symbol lists name
the exports of RAMSES and vsomeip, so they are MPL-2.0 too;
`abi/include/ramses27/` is RAMSES 27.0.116's own headers, unchanged, with
their notices (BMW Car IT, MPL-2.0);
`dcsm/third_party/vsomeip/` is COVESA's vsomeip, MPL-2.0, with its own
notices. Source, script and build files name their license in an SPDX
header; the rest is GPL-3.0-or-later.
