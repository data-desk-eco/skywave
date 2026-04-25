// Global Fishing Watch vessel identity lookup, via the Skywave gateway
// (`/gfw?query=<MMSI>`). GFW's public gateway accepts an empty bearer
// token so long as Origin + Referer come from globalfishingwatch.org,
// which browsers won't let us forge — hence the proxy.
//
// Results are cached in localStorage forever so repeat MMSIs don't
// re-hit the upstream.

// Gateway URL lives in a <meta> tag — same source of truth as app.js.
// Inlined so vessels.js stays a leaf module with no intra-app deps.
const GATEWAY = (() => {
  const meta = document.querySelector('meta[name="skywave-gateway"]');
  const url = meta && meta.content.trim();
  return url ? url.replace(/\/+$/, "") : null;
})();

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

  // GFW often splits one MMSI into several `entries` when ownership or
  // registry metadata changes over time, and even within a single entry
  // the selfReportedInfo / registryInfo / combinedSourcesInfo arrays
  // aren't sorted by recency — so entries[0] and entries[*][0] can
  // easily point at a retired identity. We honour the
  // `matchCriteria.latestVesselInfo` flag GFW sets on the current-
  // identity match; failing that, we pick by the most recent
  // transmissionDateTo.
  function latestBy(arr, key) {
    if (!arr || !arr.length) return null;
    let best = arr[0], bestTs = Date.parse(best[key] || "") || 0;
    for (let i = 1; i < arr.length; i++) {
      const ts = Date.parse(arr[i][key] || "") || 0;
      if (ts > bestTs) { best = arr[i]; bestTs = ts; }
    }
    return best;
  }

  function extract(entries) {
    if (!entries || !entries.length) return null;

    // 1. Pick the entry tagged as the current identity.
    let entry = null, latestRef = null;
    for (const e of entries) {
      const mc = (e.matchCriteria || []).find((m) => m.latestVesselInfo);
      if (mc) { entry = e; latestRef = mc.reference; break; }
    }
    // Fallback: the entry whose newest AIS segment has the latest TX.
    if (!entry) {
      let bestTs = 0;
      for (const e of entries) {
        const latest = latestBy(e.selfReportedInfo, "transmissionDateTo");
        const ts = latest ? Date.parse(latest.transmissionDateTo || "") || 0 : 0;
        if (ts > bestTs) { bestTs = ts; entry = e; latestRef = latest && latest.id; }
      }
    }
    if (!entry) entry = entries[0];

    // 2. Within the chosen entry, pick the specific records aligned
    //    with `latestRef` — falling through to the latest by timestamp.
    const selfs = entry.selfReportedInfo || [];
    const self = (latestRef && selfs.find((s) => s.id === latestRef))
      || latestBy(selfs, "transmissionDateTo")
      || selfs[0];

    const combineds = entry.combinedSourcesInfo || [];
    const combined = (latestRef && combineds.find((c) => c.vesselId === latestRef))
      || combineds[0];

    const regs = entry.registryInfo || [];
    const reg = latestBy(regs, "dateTo")
      || latestBy(regs, "transmissionDateTo")
      || regs[0];

    // 3. Registry fields are typically cleaner than AIS-self-reported;
    //    fall back either way.
    const name = (reg && reg.shipname) || (self && self.shipname) || null;
    const flag = (reg && reg.flag) || (self && self.flag) || null;
    const callsign = (reg && reg.callsign) || (self && self.callsign) || null;
    const imo = (reg && reg.imo) || (self && self.imo) || null;

    // 4. Vessel type is attached with yearFrom/yearTo — pick the class
    //    whose window covers the current year; else take the last.
    let type = null;
    if (combined && combined.shiptypes && combined.shiptypes.length) {
      const now = new Date().getUTCFullYear();
      const current = combined.shiptypes.find(
        (s) => (s.yearTo || 9999) >= now && (s.yearFrom || 0) <= now,
      );
      type = (current || combined.shiptypes[combined.shiptypes.length - 1]).name || null;
    }

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
            if (t && t.lastPos) {
              cached.lastPos = t.lastPos;
              cached.trail = t.trail;
              cache.set(mmsi, cached);
              scheduleSave();
            }
            // fire either way so the UI can flip from "waiting" to the
            // track or to "no-track" without a second open.
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
        const info = extract(data && data.entries);
        cache.set(mmsi, info);
        scheduleSave();
        if (info) notify(mmsi, info);
        if (info && info.vesselId) return fetchTracks(info.vesselId).then((t) => {
          if (t && t.lastPos) {
            info.lastPos = t.lastPos;
            info.trail = t.trail;
            cache.set(mmsi, info);
            scheduleSave();
          }
          notify(mmsi, info);
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

  // Fresh AIS position via LSEG. Independent of the GFW lookup chain
  // because LSEG returns minute-fresh positions while GFW lastPos can
  // be days stale. Result merged into the same vessel info so the
  // existing onUpdate listeners pick it up; key field is `aisLive`
  // so legacy GFW lastPos isn't accidentally overwritten.
  const liveAisPending = new Set();
  const liveAisCacheMs = new Map();   // mmsi → last fetch wall-clock time
  const LIVE_AIS_TTL_MS = 30_000;
  function liveAis(mmsi) {
    if (!/^\d{9}$/.test(mmsi || "")) return;
    if (liveAisPending.has(mmsi)) return;
    const last = liveAisCacheMs.get(mmsi) || 0;
    if (Date.now() - last < LIVE_AIS_TTL_MS) return;     // server-side cached too
    if (!GATEWAY) return;
    liveAisPending.add(mmsi);
    fetch(`${GATEWAY}/lseg/track?mmsi=${mmsi}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data || data.error || !Number.isFinite(data.lat) || !Number.isFinite(data.lon)) return;
        const info = cache.get(mmsi) || {};
        info.aisLive = {
          lat: data.lat, lon: data.lon, ts: data.ts,
          name: data.name, speed: data.speed, dest: data.dest,
        };
        // Backfill identity fields if GFW didn't have them.
        if (!info.name && data.name) info.name = data.name;
        if (!info.flag && data.flag) info.flag = data.flag;
        if (!info.imo && data.imo) info.imo = data.imo;
        cache.set(mmsi, info);
        liveAisCacheMs.set(mmsi, Date.now());
        scheduleSave();
        notify(mmsi, info);
      })
      .catch(() => {})
      .finally(() => liveAisPending.delete(mmsi));
  }

  return {
    lookup,
    liveAis,
    get: (mmsi) => cache.get(mmsi) || null,
    onUpdate: (fn) => listeners.add(fn),
  };
})();
