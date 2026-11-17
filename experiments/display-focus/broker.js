'use strict';
// Pure policy prototype. No socket, service configuration or vehicle IO.
// Identity and capabilities are supplied by a trusted installer/transport adapter.
class DisplayFocus {
    constructor(registry, now) {
        this.registry = registry;
        this.now = now || (() => Date.now()); // production adapter MUST use a monotonic clock
        this.sessions = new Map();
        this.zones = {};
        for (const name of ['cluster.primary', 'hud.primary']) {
            this.zones[name] = { selected: null, active: null, pending: null, safety: false, legacy: false };
        }
        this.events = [];
        this.sequence = 0;
    }
    zone(name) { if (!this.zones[name]) throw new Error('unknown zone'); return this.zones[name]; }
    connect(id) {
        if (!this.registry[id]) throw new Error('unregistered app');
        const token = 'session-' + (++this.sequence);
        this.sessions.set(token, { id, expires: this.now() + 6000, requests: new Set() });
        return token;
    }
    session(token) {
        const s = this.sessions.get(token);
        if (!s || s.expires <= this.now()) throw new Error('expired session');
        return s;
    }
    heartbeat(token) { this.session(token).expires = this.now() + 6000; }
    request(token, zone) {
        this.zone(zone);
        const s = this.session(token);
        if (!this.registry[s.id].includes(zone)) throw new Error('undeclared capability');
        // Multiple live instances cannot race for the same app's reservation.
        for (const [other, value] of this.sessions) {
            if (other !== token && value.id === s.id && value.expires > this.now() && value.requests.has(zone)) {
                throw new Error('duplicate instance');
            }
        }
        s.requests.add(zone);
        this.reconcile(zone);
    }
    release(token, zone) {
        this.zone(zone);
        this.session(token).requests.delete(zone);
        this.reconcile(zone);
    }
    // Control-plane methods: never exposed on the app socket.
    select(zone, id) {
        if (id !== null && (!this.registry[id] || !this.registry[id].includes(zone))) throw new Error('invalid selection');
        this.zone(zone).selected = id;
        this.reconcile(zone);
    }
    safety(zone, on) { this.zone(zone).safety = Boolean(on); this.reconcile(zone); }
    legacy(zone, on) { this.zone(zone).legacy = Boolean(on); this.reconcile(zone); }
    restoreStock() { for (const zone of Object.keys(this.zones)) this.select(zone, null); }
    disconnect(token) {
        this.sessions.delete(token);
        for (const zone of Object.keys(this.zones)) this.reconcile(zone);
    }
    tick() {
        for (const [token, s] of this.sessions) if (s.expires <= this.now()) this.sessions.delete(token);
        for (const zone of Object.keys(this.zones)) this.reconcile(zone);
    }
    desired(zone) {
        const z = this.zone(zone);
        if (z.safety || z.legacy || !z.selected) return null;
        for (const [token, s] of this.sessions) {
            if (s.id === z.selected && s.expires > this.now() && s.requests.has(zone)) return token;
        }
        return null;
    }
    reconcile(zone) {
        const z = this.zone(zone);
        // Wait for renderer confirmation, not merely an app's 'released' message.
        if (z.pending) return;
        const desired = this.desired(zone);
        if (z.active && z.active.session !== desired) {
            z.pending = { epoch: ++this.sequence, lease: z.active.lease, since: this.now() };
            this.events.push({ event: 'hide', zone, session: z.active.session, lease: z.active.lease, epoch: z.pending.epoch });
            return;
        }
        if (!z.active && desired) {
            z.active = { session: desired, lease: ++this.sequence };
            this.events.push({ event: 'grant', zone, session: desired, lease: z.active.lease });
        }
    }
    // Called only by the trusted renderer adapter once OLD layers are hidden/unmapped.
    hidden(zone, epoch) {
        const z = this.zone(zone);
        if (!z.pending || z.pending.epoch !== epoch) return false;
        z.active = null; z.pending = null;
        this.reconcile(zone);
        return true;
    }
    permitted(token, zone, lease) {
        const z = this.zone(zone);
        return Boolean(!z.pending && !z.safety && !z.legacy && z.active &&
            z.active.session === token && z.active.lease === lease && this.desired(zone) === token);
    }
    status(zone) {
        const z = this.zone(zone);
        return { zone, selected: z.selected, active: z.active, pending: z.pending,
            reason: z.safety ? 'oem-safety' : z.legacy ? 'legacy-unmanaged' :
                z.pending ? (this.now() - z.pending.since >= 2000 ? 'release-timeout' : 'releasing') :
                    z.active ? 'granted' : z.selected ? 'waiting-for-app' : 'stock' };
    }
    drain() { const out = this.events; this.events = []; return out; }
}
if (typeof module !== 'undefined') module.exports = { DisplayFocus };
