// Skywave regions — server-side subset of client/regions.js. Contains
// only what the Worker needs to pick a rack of receivers for a region:
// DSC channel table, regional bboxes, GPS / bbox / coastal helpers.

export const BANDS = [
  { khz:  2187.5, short: "MF"   },
  { khz:  4207.5, short: "HF4"  },
  { khz:  6312.0, short: "HF6"  },
  { khz:  8414.5, short: "HF8"  },
  { khz: 12577.0, short: "HF12" },
  { khz: 16804.5, short: "HF16" },
];
export const bandLabelFor = (khz) =>
  (BANDS.find((b) => b.khz === khz) || {}).short || "?";

export const REGIONS = [
  { id: "global",    name: "Global",         bbox: null                  },
  { id: "nw-europe", name: "NW Europe",      bbox: [42, -12,  62,  15]   },
  { id: "med",       name: "Mediterranean",  bbox: [30,  -7,  46,  36]   },
  { id: "us-east",   name: "US East Coast",  bbox: [24, -82,  46, -62]   },
  { id: "us-west",   name: "US West Coast",  bbox: [30, -130, 50, -115]  },
  { id: "gulf-carib",name: "Gulf/Caribbean", bbox: [ 8, -100, 31,  -58]  },
  { id: "baltic",    name: "Baltic / N Sea", bbox: [50,  -2,  66,  32]   },
  { id: "east-asia", name: "East Asia",      bbox: [18, 115,  45, 150]   },
  { id: "oceania",   name: "Australia / NZ", bbox: [-48, 110, -8, 180]   },
];

export const regionById = (id) => REGIONS.find((r) => r.id === id) || REGIONS[0];

export function inRegion(gps, bbox) {
  if (!bbox) return true;
  const [s, w, n, e] = bbox;
  const [lat, lon] = gps;
  if (lat < s || lat > n) return false;
  return w <= e ? (lon >= w && lon <= e) : (lon >= w || lon <= e);
}

// Coastal anchors — see client/regions.js for the prose commentary.
const COASTAL_ANCHORS = [
  [51.1,1.3],[48.4,-5.1],[50.4,-4.1],[53.5,9.9],[51.9,4.5],[60.4,5.3],[64.1,-21.9],
  [57.7,11.9],[59.3,18.1],[60.2,24.9],[59.4,24.8],[54.4,18.7],[55.7,12.6],[57.0,-2.1],
  [62.0,-7.0],[36.1,-5.3],[43.3,5.4],[44.4,8.9],[37.9,23.7],[41.0,29.0],[35.9,14.5],
  [31.2,29.9],[32.8,35.0],[44.5,33.5],[38.7,-9.1],[37.7,-25.7],[33.6,-7.6],[14.7,-17.4],
  [6.5,3.4],[-33.9,18.4],[-29.9,31.0],[-22.9,-43.2],[-34.6,-58.4],[-33.0,-71.6],
  [44.6,-63.6],[42.4,-71.1],[40.7,-74.0],[36.9,-76.3],[25.8,-80.2],[29.9,-90.1],
  [29.7,-95.4],[25.1,-77.3],[18.5,-66.1],[9.4,-79.9],[47.6,-122.3],[37.8,-122.4],
  [33.7,-118.2],[49.3,-123.1],[21.3,-157.9],[61.2,-149.9],[21.5,39.2],[12.8,45.0],
  [11.6,43.1],[23.6,58.6],[27.2,56.3],[29.4,48.0],[19.1,72.9],[6.9,79.9],[13.1,80.3],
  [1.3,103.8],[-6.2,106.8],[14.6,121.0],[22.3,114.2],[31.2,121.5],[35.2,129.1],
  [35.7,139.8],[43.1,131.9],[13.7,100.5],[-33.9,151.2],[-27.5,153.0],[-31.9,115.9],
  [-36.9,174.8],[-41.3,174.8],[-18.1,178.4],[-9.5,147.2],
];

export function coastDeg(gps) {
  if (!gps) return 999;
  let min = Infinity;
  for (const [la, lo] of COASTAL_ANCHORS) {
    const dlat = gps[0] - la;
    const dlon = ((gps[1] - lo + 540) % 360) - 180;
    const d = Math.hypot(dlat, dlon);
    if (d < min) min = d;
  }
  return min;
}

export function parseGps(s) {
  if (!s) return null;
  const m = String(s).match(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

export function coversBand(rx, khz) {
  if (!rx.bands) return true;
  const hz = khz * 1000;
  for (const range of String(rx.bands).split(",")) {
    const [lo, hi] = range.split("-").map(Number);
    if (hz >= lo && hz <= hi) return true;
  }
  return false;
}

// Rack selection — defensible narrative
// =====================================
//
// Out of the ~900 public KiwiSDRs, we pick 16 per DSC band (96 slots
// total) for a given region. The criteria, in order:
//
//   Hard filters (all must pass):
//     · receiver self-reports `status=active`, not `offline=yes`
//     · not proxy.kiwisdr.com (307-redirects on handshake, browsers
//       can't follow — empirically blocks outbound in CF DOs too)
//     · `ip_blacklist !== "yes"` — some operators exclude CF IPs
//     · has the GPS hardware option (`sdr_hw` advertises "📡 GPS")
//       AND is actively fixing (`fixes_hour` ≥ MIN_GPS_FIXES_HOUR).
//       TDOA geolocation needs per-frame GNSS timestamps; a KiwiSDR
//       without a sky-view GPS can't provide them. ~63% of the
//       public fleet survives this cut.
//     · has a site GPS fix we can parse (the `gps` string)
//     · covers the DSC band's dial frequency (`bands` field)
//     · lies within the region's bbox
//     · has ≥ MIN_FREE_SLOTS_TO_JOIN free user slots (etiquette)
//     · is coastal — within MAX_COAST_DEG of a major port anchor.
//       DSC is a maritime service; inland KiwiSDRs rarely hear calls
//     · `snr` field reports ≥ MIN_SNR_DB. Below that the noise floor
//       leaves nothing for our decoder to work with
//     · list entry `updated` within UPDATE_RECENCY_SEC. Stale rows
//       are often dead receivers the public list hasn't GC'd yet
//
//   Score (greater = better):
//     freeSlots × coastalProximity × snrBonus × antennaBonus
//
//     · freeSlots          — rewards receivers with headroom
//     · coastalProximity   — 3 / (coastDeg + 0.5), max 6
//     · snrBonus           — min(2, snr_dB / 20)
//     · antennaBonus       — 1.5 if the antenna text mentions a broad-
//       band design (loop, dipole, T2FD, Beverage); 1 otherwise
//
//   Spatial diversity:
//     · within a band, new picks must be ≥ MIN_SEP_DEG from any pick
//       already on that band — prevents stacking four Mediterranean
//       slots in Naples when Valletta, Piraeus and Tel Aviv would
//       give better coverage
//     · across bands, the same (host, port) can appear on up to
//       MAX_BANDS_PER_HOST different bands — one Weston-super-Mare
//       station on MF + HF4 + HF6 is fine, six is silly

export const MIN_FREE_SLOTS_TO_JOIN = 2;
const MAX_COAST_DEG = 8;       // receiver must be within 8° of a coastal anchor
const MIN_SNR_DB = 15;         // noise-floor cut-off, per receiver's own report
const UPDATE_RECENCY_SEC = 3600;
const MIN_SEP_DEG = 3;         // per-band geographic spread
const MAX_BANDS_PER_HOST = 2;
const MIN_GPS_FIXES_HOUR = 100;  // GPS hardware must actually be fixing
const GPS_HW_MARKER = "📡 GPS"; // substring in `sdr_hw` when the option is present
export const DEFAULT_FANOUT = 96;  // also the hard ceiling — ?fanout= can only narrow the rack

// Coast-station-style MMSIs and many public KiwiSDRs name-check their
// antenna in free text. Match a few designs known to pull in weak HF:
const BROADBAND_ANTENNA = /\b(loop|dipole|t2fd|beverage|folded|longwire|long wire|EWE|K9AY)\b/i;

function snrDb(raw) {
  // snr field is typically "<snr_weak>,<snr_strong>" in dB. Take the
  // higher number — represents dynamic range on a clean signal.
  if (!raw) return null;
  const nums = String(raw).split(/[,\s]+/).map(Number).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : null;
}

function updatedSecondsAgo(raw) {
  if (!raw) return Infinity;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 1000;
}

function scoreReceiver(r, gps, free, coast) {
  const snr = snrDb(r.snr);
  const snrBonus = snr != null ? Math.min(2, snr / 20) : 1;
  const coastalProx = Math.max(0.25, 3 / (coast + 0.5));
  const antennaBonus = BROADBAND_ANTENNA.test(r.antenna || "") ? 1.5 : 1;
  return { score: free * coastalProx * snrBonus * antennaBonus, snr };
}

function rankCandidates(receivers, khz, bbox) {
  const out = [];
  for (const r of receivers) {
    if (r.status !== "active" || r.offline === "yes" || !r.url) continue;
    if (r.ip_blacklist === "yes") continue;
    if (/proxy\.kiwisdr\.com/i.test(r.url)) continue;
    if (!coversBand(r, khz)) continue;
    if (updatedSecondsAgo(r.updated) > UPDATE_RECENCY_SEC) continue;
    // GPS-option + actively fixing. Required for TDOA geolocation:
    // without per-frame GNSS timestamps there's no shared time base.
    if (!String(r.sdr_hw || "").includes(GPS_HW_MARKER)) continue;
    if ((parseInt(r.fixes_hour, 10) || 0) < MIN_GPS_FIXES_HOUR) continue;
    let host;
    try {
      const u = new URL(r.url);
      host = u.hostname + ":" + (u.port || "8073");
    } catch (_) { continue; }
    const gps = parseGps(r.gps);
    if (!gps) continue;
    if (!inRegion(gps, bbox)) continue;
    const free = Math.max(0, (parseInt(r.users_max, 10) || 0) - (parseInt(r.users, 10) || 0));
    if (free < MIN_FREE_SLOTS_TO_JOIN) continue;
    const coast = coastDeg(gps);
    if (coast > MAX_COAST_DEG) continue;
    const { score, snr } = scoreReceiver(r, gps, free, coast);
    if (snr != null && snr < MIN_SNR_DB) continue;
    out.push({ r, host, gps, free, coast, snr, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function pickRack(receivers, bbox, requested = DEFAULT_FANOUT) {
  const n = Math.max(1, Math.min(DEFAULT_FANOUT, requested | 0));
  const bandsKHz = BANDS.map((b) => b.khz);
  const k = bandsKHz.length;
  const base = Math.floor(n / k);
  const extra = n - base * k;
  const quota = bandsKHz.map((_, i) => base + (i < extra ? 1 : 0));
  const pools = bandsKHz.map((khz) => rankCandidates(receivers, khz, bbox));
  const picks = [];
  const bandsPerHost = new Map();  // host → count of picks using it

  // First pass: respect per-band spatial diversity + per-host band cap.
  let progress = true;
  while (progress && picks.length < n) {
    progress = false;
    for (let bi = 0; bi < k; bi++) {
      if (quota[bi] <= 0) continue;
      const pool = pools[bi];
      for (let ci = 0; ci < pool.length; ci++) {
        const c = pool[ci];
        if (!c) continue;
        if ((bandsPerHost.get(c.host) || 0) >= MAX_BANDS_PER_HOST) continue;
        const sameBand = picks.filter((p) => p.bandKHz === bandsKHz[bi]);
        const tooClose = sameBand.some(
          (p) => Math.hypot(p.gps[0] - c.gps[0], p.gps[1] - c.gps[1]) < MIN_SEP_DEG,
        );
        if (tooClose) continue;
        picks.push({ ...c, bandKHz: bandsKHz[bi] });
        bandsPerHost.set(c.host, (bandsPerHost.get(c.host) || 0) + 1);
        pool[ci] = null;
        quota[bi]--;
        progress = true;
        break;
      }
      if (picks.length >= n) break;
    }
  }
  // Top-up pass: if the rack is still short (small region, thin pool),
  // drop the spatial-diversity rule but keep the per-host cap.
  for (let bi = 0; bi < k && picks.length < n; bi++) {
    for (const c of pools[bi]) {
      if (!c) continue;
      if ((bandsPerHost.get(c.host) || 0) >= MAX_BANDS_PER_HOST) continue;
      picks.push({ ...c, bandKHz: bandsKHz[bi] });
      bandsPerHost.set(c.host, (bandsPerHost.get(c.host) || 0) + 1);
      if (picks.length >= n) break;
    }
  }

  return picks.slice(0, n).map((p) => ({
    host: p.host.split(":")[0],
    port: parseInt(p.host.split(":")[1], 10),
    bandKHz: p.bandKHz,
    bandLabel: bandLabelFor(p.bandKHz),
    label: (p.r.loc || "").slice(0, 34) || p.r.name || "unknown",
    gps: p.gps,
    snr: p.snr,
    coast: +p.coast.toFixed(2),
  }));
}
