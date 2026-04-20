// Global Fishing Watch vessel identity lookup, via the Skywave gateway
// (`/gfw?query=<MMSI>`). GFW's public gateway accepts an empty bearer
// token so long as Origin + Referer come from globalfishingwatch.org,
// which browsers won't let us forge — hence the proxy.
//
// Results are cached in localStorage forever so repeat MMSIs don't
// re-hit the upstream.

import { GATEWAY } from "./kiwi.js";

// Bump `STORAGE_VERSION` when the cached-entry schema changes — we drop
// mismatches on load rather than trying to migrate.
const STORAGE_KEY = "skywave.gfwCache";
const STORAGE_VERSION = 2;
const DEBUG = /(\?|&)debug=1\b/.test(location.search);

export const Vessels = (() => {
  const cache = new Map();                // mmsi → info | null (null = known absent)
  const listeners = new Set();
  const pending = new Set();
  let saveTimer = null;

  (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === STORAGE_VERSION && Array.isArray(parsed.entries)) {
        for (const [mmsi, info] of parsed.entries) cache.set(mmsi, info);
        if (DEBUG) console.log(`[gfw] restored ${cache.size} cached identities`);
      } else {
        if (DEBUG) console.log("[gfw] cache schema mismatch — discarding");
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (_) { localStorage.removeItem(STORAGE_KEY); }
  })();

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          v: STORAGE_VERSION,
          entries: Array.from(cache.entries()),
        }));
      } catch (_) {}
    }, 3000);
  }

  // Pick the "best" identity fields out of a GFW search response. Prefer
  // the formal registry record; fall back to the AIS-self-reported entry
  // (which almost always has at least a flag and often a shipname). The
  // shiptype comes from GFW's ML-inferred combinedSourcesInfo. We also
  // keep the vesselId so we can follow up with a tracks lookup.
  function extract(entry) {
    if (!entry) return null;
    const reg = entry.registryInfo && entry.registryInfo[0];
    const self = entry.selfReportedInfo && entry.selfReportedInfo[0];
    const combined = entry.combinedSourcesInfo && entry.combinedSourcesInfo[0];
    const name = (reg && reg.shipname) || (self && self.shipname) || null;
    const flag = (reg && reg.flag) || (self && self.flag) || null;
    const callsign = (reg && reg.callsign) || (self && self.callsign) || null;
    const imo = (reg && reg.imo) || (self && self.imo) || null;
    const type = combined && combined.shiptypes && combined.shiptypes[0]
      ? combined.shiptypes[0].name
      : null;
    const vesselId = (combined && combined.vesselId) || (self && self.id) || null;
    if (!name && !flag && !type && !vesselId) return null;
    return { name, flag, type, callsign, imo, vesselId };
  }

  function notify(mmsi, info) {
    for (const fn of listeners) { try { fn(mmsi, info); } catch (_) {} }
  }

  // Chains: identity → (if vesselId) tracks. Each stage updates the cache
  // and fires listeners so the UI can paint progressively — ship name
  // appears first, then the vessel marker + trail arrive a moment later.
  function lookup(mmsi) {
    if (!/^\d{9}$/.test(mmsi || "")) return;
    if (pending.has(mmsi)) return;
    const cached = cache.get(mmsi);
    if (cached) {
      notify(mmsi, cached);
      // If a previous session cached only identity (older code path or
      // tracks temporarily failed), follow up with tracks now.
      if (cached.vesselId && !cached.lastPos && GATEWAY) {
        pending.add(mmsi);
        fetchTracks(cached.vesselId)
          .then((t) => {
            if (!t || !t.lastPos) return;
            cached.lastPos = t.lastPos;
            cached.trail = t.trail;
            cache.set(mmsi, cached);
            scheduleSave();
            notify(mmsi, cached);
          })
          .finally(() => pending.delete(mmsi));
      }
      return;
    }
    if (cache.has(mmsi)) return;            // known-absent (null)
    if (!GATEWAY) return;
    pending.add(mmsi);
    fetch(`${GATEWAY}/gfw?query=${mmsi}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const info = extract(data && data.entries && data.entries[0]);
        cache.set(mmsi, info);
        scheduleSave();
        if (info) notify(mmsi, info);
        if (info && info.vesselId) return fetchTracks(info.vesselId).then((t) => {
          if (t && t.lastPos) {
            info.lastPos = t.lastPos;
            info.trail = t.trail;
            cache.set(mmsi, info);
            scheduleSave();
            notify(mmsi, info);
          }
        });
      })
      .catch(() => { cache.set(mmsi, null); scheduleSave(); })
      .finally(() => pending.delete(mmsi));
  }

  function fetchTracks(vesselId) {
    return fetch(`${GATEWAY}/gfw/tracks?vesselId=${encodeURIComponent(vesselId)}`)
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null);
  }

  return {
    lookup,
    get: (mmsi) => cache.get(mmsi) || null,
    onUpdate: (fn) => listeners.add(fn),
  };
})();
