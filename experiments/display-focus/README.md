# Display focus prototype (not installed on a head unit)

Open `demo.html` locally to try selection, OEM interruption, renderer release timeout,
legacy occupancy and disconnection. Run `node experiments/display-focus/test.js` from
the repository root for deterministic policy tests.

This is a policy core and simulated control panel, **not a running vehicle service**.
No production app or `cluster-render` imports it; the source archive includes it for
review, but the Cluster Metrics installation package does not.

The registry is trusted input. `connect(app)` is an adapter boundary, not an app-facing
RPC accepting self-asserted IDs. Production needs peer credentials and an installer-owned
identity/capability registry. Only the administrative transport may call `select`,
`restoreStock`; only renderer adapters may call `safety`, `legacy`, `hidden`.
App transport permits request/release/heartbeat on its bound session only.

The application protocol is versioned (`display-focus/1`):
- installer declaration: `{"roles":["hud.primary"],"protocol":1}`
- app request: `{"op":"request","zone":"hud.primary","requestId":"..."}`
- arbiter grant: `{event:"grant", zone, session, lease}`
- arbiter loss: `{event:"hide", zone, session, lease, epoch}`
- renderer confirmation: `{event:"hidden", zone, epoch}`
- read-only status: selected app, active lease, pending transition, reason.

There is no client-defined priority. Selection is exclusive in this pilot. App requests
alone do not take focus. Expired sessions lose permissions, and grants are fenced by a
new lease generation on every handover. Stale release acknowledgements are ignored.
A two-second release timeout is visible but does not grant over potentially stale pixels.
The production renderer adapter must enforce grants and remove old layers, even when
an app ignores loss. UI acknowledgements in the demo simulate this trusted adapter.

Production work still required: peer credential binding, renderer enforcement, crash
reconciliation against actual renderer state, durable selection validation, restart
recovery (start with unmanaged layers quarantined), bounded transport queues, rate
limits and malicious clients, diagnostics, app SDK, real Store UI, automatic tests with
renderer sockets, then real car verification. No permission or safety guarantee is made
by this offline model alone.
