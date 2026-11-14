// vessel lookups via the gateway: identity from Global Fishing Watch
// (`/gfw`, cached in localStorage) and the single latest AIS position
// from LSEG (`/lseg/track`, memory only). one position per ship, never
// a track.

export const GATEWAY = document.querySelector('meta[name="skywave-gateway"]')
  ?.content.trim().replace(/\/+$/, "") || null;

// bump VERSION when the cached shape changes; mismatches are dropped
const KEY = "skywave.gfwCache", VERSION = 3, AIS_TTL_MS = 60_000;
const isMmsi = (s) => /^\d{9}$/.test(s || "");
const json = (path) =>
  fetch(GATEWAY + path).then((r) => r.ok ? r.json() : null);
const ts = (o, k) => Date.parse(o?.[k] || "") || 0;
const latest = (arr = [], k) =>
  arr.reduce((b, x) => !b || ts(x, k) > ts(b, k) ? x : b, null);

// GFW splits one MMSI into several entries as ownership changes, in no
// order. take the one flagged `latestVesselInfo`, else the one with
// the newest transmission; registry fields beat self-reported ones.
function identity(entries = []) {
  const last = (e) => latest(e.selfReportedInfo, "transmissionDateTo");
  const flagged = (e) => e.matchCriteria?.find((m) => m.latestVesselInfo);
  const e = entries.find(flagged) || entries.reduce((b, x) =>
    !b || ts(last(x), "transmissionDateTo") > ts(last(b), "transmissionDateTo")
      ? x : b, null);
  if (!e) return null;
  const ref = flagged(e)?.reference;
  const self = e.selfReportedInfo?.find((s) => s.id === ref) || last(e) || {};
  const reg = latest(e.registryInfo, "dateTo") || {};
  const types = (e.combinedSourcesInfo?.find((c) => c.vesselId === ref)
    || e.combinedSourcesInfo?.[0])?.shiptypes || [];
  const y = new Date().getUTCFullYear();
  const pick = (k) => reg[k] || self[k] || null;
  const info = {
    name: pick("shipname"), flag: pick("flag"), callsign: pick("callsign"),
    imo: pick("imo"),
    type: (types.find((t) => (t.yearFrom || 0) <= y && y <= (t.yearTo || 9999))
      || types.at(-1))?.name || null,
  };
  return Object.values(info).some(Boolean) ? info : null;
}

const ids = new Map();          // mmsi → identity | null (known absent)
const fixes = new Map();        // mmsi → { lat, lon, ts, speed, name }
const asked = new Map();        // mmsi → last AIS request time
const pending = new Set(), listeners = new Set();
const notify = (mmsi) => listeners.forEach((fn) => fn(mmsi));

try {
  const c = JSON.parse(localStorage.getItem(KEY));
  if (c?.v === VERSION) for (const [k, v] of c.entries) ids.set(k, v);
  else localStorage.removeItem(KEY);
} catch (_) {}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY,
        JSON.stringify({ v: VERSION, entries: [...ids] }));
    } catch (_) {}
  }, 3000);
}

export const Vessels = {
  get: (mmsi) => ids.get(mmsi) || null,
  ais: (mmsi) => fixes.get(mmsi) || null,
  onUpdate: (fn) => listeners.add(fn),

  lookup(mmsi) {
    if (!GATEWAY || !isMmsi(mmsi) || ids.has(mmsi) || pending.has(mmsi)) return;
    pending.add(mmsi);
    json(`/gfw?query=${mmsi}`)
      .then((d) => identity(d?.entries), () => null)
      .then((info) => {
        ids.set(mmsi, info);
        pending.delete(mmsi);
        save();
        if (info) notify(mmsi);
      });
  },

  fetchAis(mmsi) {
    if (!GATEWAY || !isMmsi(mmsi)) return;
    if (Date.now() - (asked.get(mmsi) || 0) < AIS_TTL_MS) return;
    asked.set(mmsi, Date.now());
    json(`/lseg/track?mmsi=${mmsi}`).then((d) => {
      if (!Number.isFinite(d?.lat) || !Number.isFinite(d?.lon)) return;
      const { lat, lon, ts, speed, name } = d;
      fixes.set(mmsi, { lat, lon, ts, speed, name });
      notify(mmsi);
    }, () => {});
  },
};
