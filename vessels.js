// Global Fishing Watch vessel-identity lookup. Complements the
// aisstream position cache with authoritative ship details (name,
// flag, type, callsign) — especially valuable for ships that never
// show up in aisstream's real-time feed.
//
// Requires a (free) GFW API token:
//   localStorage.setItem("skywave.gfwKey", "<token>")
// Without a key set, lookups are skipped silently.
//
// Results are persisted to localStorage so repeat MMSIs don't re-hit
// the API — GFW enforces strict rate limits on the free tier.

const STORAGE_KEY = "skywave.gfwCache";
const GFW_URL = "https://gateway.api.globalfishingwatch.org/v3/vessels/search";

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
      for (const [mmsi, info] of JSON.parse(raw)) cache.set(mmsi, info);
      if (DEBUG) console.log(`[gfw] restored ${cache.size} cached identities`);
    } catch (_) {}
  })();

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(cache.entries())));
      } catch (_) {}
    }, 3000);
  }

  const key = () => localStorage.getItem("skywave.gfwKey") || null;

  function lookup(mmsi) {
    if (!/^\d{9}$/.test(mmsi || "")) return;
    if (cache.has(mmsi) || pending.has(mmsi)) {
      // Still fire the listener so late-mounted UI reads the cache.
      if (cache.has(mmsi)) {
        const info = cache.get(mmsi);
        if (info) for (const fn of listeners) { try { fn(mmsi, info); } catch (_) {} }
      }
      return;
    }
    if (!key()) return;
    pending.add(mmsi);
    const url = `${GFW_URL}?query=${mmsi}&datasets[0]=public-global-vessel-identity:latest`;
    fetch(url, { headers: { Authorization: `Bearer ${key()}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const entry = data && data.entries && data.entries[0];
        const reg = entry && entry.registryInfo && entry.registryInfo[0];
        const info = entry ? {
          name: (reg && reg.shipname) || entry.shipname || null,
          flag: entry.flag || (reg && reg.flag) || null,
          type: (entry.shiptypes && entry.shiptypes[0]) || null,
          callsign: (reg && reg.callsign) || null,
          imo: (reg && reg.imo) || null,
        } : null;
        cache.set(mmsi, info);
        scheduleSave();
        if (info) for (const fn of listeners) { try { fn(mmsi, info); } catch (_) {} }
      })
      .catch(() => { cache.set(mmsi, null); scheduleSave(); })
      .finally(() => pending.delete(mmsi));
  }

  return {
    lookup,
    get: (mmsi) => cache.get(mmsi) || null,
    onUpdate: (fn) => listeners.add(fn),
    hasKey: () => !!key(),
  };
})();
