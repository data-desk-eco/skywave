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

// Regions come in two flavours:
//
//   · bbox region  — "show me a rack across this big area" (NW Europe,
//     Mediterranean, etc.). pickRack greedily packs 16 slots per band
//     with spatial diversity inside the bbox. Normal rack scoring.
//
//   · target region  — "monitor this specific patch of sea". A tight
//     cohort of receivers inside `radiusKm` of `gps`, scored to favour
//     proximity + bearing spread around the target. Same cohort is
//     replicated across all 6 DSC bands so the same burst has up to 6×
//     the chance of being heard by ≥3 receivers (TDOA quorum).
//
// The Black Sea is the inaugural target region: few public KiwiSDRs
// surround it, but the ones that do (Bucharest, Moscow, Edessa, plus
// proxy-fronted Baghdad/Sobikow/Hungary) give <1 km simulated p50
// error from synthetic bursts at every major Russian port.
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
  { id: "black-sea", name: "Black Sea",      bbox: null,
    target: { gps: [45.5, 36.5], radiusKm: 2000, cohortSize: 6 } },
  // North Atlantic — transatlantic shipping lanes between NW Europe
  // and E North America. Centroid mid-Atlantic so the cohort pulls
  // in Kaena/Canterbury/Tostedt-class receivers on both sides.
  { id: "n-atlantic", name: "N Atlantic",    bbox: null,
    target: { gps: [45.0, -30.0], radiusKm: 3500, cohortSize: 7 } },
  // Persian Gulf / Strait of Hormuz — the oil chokepoint. ~20% of
  // global crude flows through here; VLCC movements are routinely
  // announced on DSC HF. Local KiwiSDR coverage is sparse: Doha is
  // typically slot-saturated, Baghdad's GPS often loses lock. The
  // 4000 km radius pulls in Eastern European GPS-fixing receivers
  // (Bucharest / Zakynthos / Hungary / Moscow) which give long-
  // baseline geometry. Big baselines = bigger ionospheric residuals
  // but more bearing diversity around the target.
  { id: "persian-gulf", name: "Persian Gulf", bbox: null,
    target: { gps: [26.5, 56.5], radiusKm: 4000, cohortSize: 6 } },
  // SE Asia / West Pacific — natural surround geometry from the
  // Chiba (N) / Bandung (S) / Cha-Am (W) / NZ (SE) clusters. Centroid
  // on the South China Sea so the octant picker produces all four
  // compass quadrants. Shipping density is enormous here: tanker
  // traffic from the Gulf, container traffic Asia-Europe-Americas,
  // and the FJELD SVEA-class long-path HF that we've already seen
  // produce ~20 km fixes.
  { id: "sea-pac", name: "SE Asia / W Pacific", bbox: null,
    target: { gps: [10.0, 125.0], radiusKm: 10000, cohortSize: 8,
              monitoringRadiusKm: 3000 } },
  // Tight Europe / North Sea — the methodology's best-case geometry
  // on the public KiwiSDR fleet. Dense coverage surrounding a 2500 km
  // circle centred on the North Sea (max bearing gap 95°, avg baseline
  // 869 km). Not a shipping hotspot in its own right, but the shortest
  // baselines in the world for TDOA testing: if we can't pin a burst
  // under 100 km here, the floor is genuinely a timing-precision issue
  // rather than a geometry one.
  { id: "n-sea", name: "N Sea (tight)", bbox: null,
    target: { gps: [55.0, 5.0], radiusKm: 2500, cohortSize: 8 } },
  // English Channel — proving ground for ground-wave-only MF TDoA.
  // Centroid (50, 0) sits between the English south coast and Le Havre;
  // the 600 km cohort radius pulls in 6-8 MF receivers (Canterbury UK,
  // Le Havre FR, Bergen-op-Zoom NL, Bristol UK, Woking UK, Paris FR,
  // Brittany FR), max bearing gap ~70°. Every receiver-to-cohort-edge
  // distance stays inside MF ground-wave range over salt water (~600
  // km), so the propagation regime is uniform — no F2 hops, no iono
  // bias, no per-pair path-length unknown. `bands: [2187.5]` restricts
  // the rack to MF only (HF in the same area would mix in 1-3 hop
  // skywave from non-cohort regions of the world). Busiest shipping
  // lane on Earth → abundant DSC traffic + AIS ground truth.
  // English Channel — proving ground for ground-wave MF TDOA. Centroid
  // (50, 0) sits between the south coast of England and Le Havre. The
  // 400 km cohort radius pulls in 25-35 distinct MF receivers (after
  // 5 km site dedup): max bearing gap ~60°, all within MF ground-wave
  // range over salt water (~600 km). Live-validated against AIS:
  // WHITCHALLENGER (UK tanker at anchor in the Solent) was solved at
  // q=4/6/7 with fixes converging within 10 km of each other and
  // 40-50 km of her actual position.
  { id: "english-channel", name: "English Channel", bbox: null,
    target: {
      gps: [50.0, 0.0], radiusKm: 400, cohortSize: 40, bands: [2187.5],
    } },
  // NY Harbour & approaches — second-tier feasibility per
  // global_chokepoints.mjs. ~23 distinct MF sites surround New York
  // Harbour out to 400 km; bearing gap 130° is wider than English
  // Channel but still surround geometry. Channel approaches into
  // Newark/JFK area are some of the world's busiest shipping lanes.
  { id: "ny-harbour", name: "NY Harbour", bbox: null,
    target: {
      gps: [40.5, -74.0], radiusKm: 400, cohortSize: 40, bands: [2187.5],
    } },
  // Kattegat / Øresund — Danish & Swedish coastal MF receivers around
  // the strait between Denmark and Sweden. ~15 distinct sites, bearing
  // gap ~120°. Heavy shipping density (Baltic↔North Sea transits via
  // the Great Belt and Øresund).
  { id: "kattegat", name: "Kattegat / Øresund", bbox: null,
    target: {
      gps: [56.0, 12.0], radiusKm: 400, cohortSize: 40, bands: [2187.5],
    } },
  // Chesapeake & US Mid-Atlantic — DC/Virginia/NC coastal cluster.
  // ~18 distinct sites surrounding the bay; bearing gap ~165°. Lots
  // of military and commercial shipping (Norfolk navy base, Baltimore
  // commercial, Charleston container).
  { id: "chesapeake", name: "Chesapeake", bbox: null,
    target: {
      gps: [37.0, -76.0], radiusKm: 400, cohortSize: 40, bands: [2187.5],
    } },
  // Ligurian Sea — north-west Italian / Riviera coast. Surprise tier-2
  // hit from the global sweep: ~28 distinct MF sites within 400 km of
  // (44, 8.5), centred between Genoa and Marseille. Heavy commercial
  // traffic (Genoa container port, Marseille, Livorno) plus Med
  // ferry routes.
  { id: "ligurian", name: "Ligurian Sea", bbox: null,
    target: {
      gps: [44.0, 8.5], radiusKm: 400, cohortSize: 40, bands: [2187.5],
    } },
  // Western Approaches — Cornwall + Brittany coast. ~19 MF sites,
  // bearing gap ~120°. Watches the funnel where Atlantic shipping
  // turns into the Channel and the Bay of Biscay (transatlantic
  // routes, Bordeaux/Nantes traffic).
  { id: "western-approaches", name: "Western Approaches", bbox: null,
    target: {
      gps: [50.0, -5.5], radiusKm: 400, cohortSize: 40, bands: [2187.5],
    } },
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
//     · within MAX_COAST_DEG of a major port anchor. Inland KiwiSDRs
//       with good longwires sometimes pull in maritime DSC too, so
//       we only exclude obviously-landlocked-with-poor-antennas
//     · `snr` field reports ≥ MIN_SNR_DB. A marginal receiver that
//       occasionally catches a burst is still a useful 3rd point
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
// Filters below were originally tuned for "show the user a clean
// geographically diverse rack". TDOA wants the opposite: maximum
// coverage so any DSC burst has the most possible chances of being
// heard at ≥3 GPS-synced sites. We relax the propagation-assumption
// filters accordingly — the coordinator can always reject a cohort
// later if the residual is bad.
const MAX_COAST_DEG = 20;      // was 8 — inland longwires sometimes pull in
                               // maritime DSC as well as coastal loops
const MIN_SNR_DB = 8;          // was 15 — a weak receiver that happens to
                               // hear a burst is still a useful 3rd point
const UPDATE_RECENCY_SEC = 3600;
const MIN_SEP_DEG = 1.5;       // was 3 — two receivers on the same stretch
                               // of UK east coast both being picked is
                               // exactly what we want for dense same-packet
                               // cohorts; enforce only a very short
                               // exclusion radius (≈165 km) to avoid two
                               // stations on the same street
const MAX_BANDS_PER_HOST = 2;
const MIN_GPS_FIXES_HOUR = 100;  // GPS hardware must actually be fixing
const GPS_HW_MARKER = "📡 GPS"; // substring in `sdr_hw` when the option is present
export const DEFAULT_FANOUT = 96;  // also the hard ceiling — ?fanout= can only narrow the rack

// Cluster gate — a candidate is only kept if at least one other same-
// band candidate exists within the band's cluster radius. Purely a
// short-range-propagation filter: MF is ground-wave / short skywave
// (<1500 km useful range), so an MF receiver with no peer in that
// radius cannot co-hear a burst and just burns a slot. HF4 is similar
// during daylight (NVIS). HF6+ use F2 skywave whose skip zone routinely
// exceeds 2500 km — a Hawaii or Johannesburg receiver hears European
// traffic via long-path and IS valuable despite geographic isolation.
// So we only gate the short-range bands.
const CLUSTER_RADIUS_KM_BY_BAND = {
  2187.5: 1500,    // MF
  4207.5: 2500,    // HF4
  // HF6+: no gate. F2 long-path makes "isolated" receivers productive.
};

// Per-band slot allocation for the global (bbox) rack. HF8 + HF12
// produced 80% of multi-hearings in the same capture; HF4 produced
// zero during daylight; MF is under-represented but matters for
// coastal work. Weights sum to 1.0. A `?fanout=N` request scales
// these proportionally and rounds to integers; any residual goes to
// the highest-weighted band.
const BAND_WEIGHTS = {
  2187.5:  0.145,   // MF   — 14/96
  4207.5:  0.063,   // HF4  —  6/96
  6312.0:  0.188,   // HF6  — 18/96
  8414.5:  0.208,   // HF8  — 20/96
  12577.0: 0.208,   // HF12 — 20/96
  16804.5: 0.188,   // HF16 — 18/96
};

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
    // Hosts behind *.proxy.kiwisdr.com return a 307-redirect chain on
    // the WS handshake. The Worker pre-resolves the chain in
    // kiwi-upstream.js before upgrading, so they're usable now. (The
    // browser never sees the redirect — it talks to our Worker, which
    // talks to the KiwiSDR.) Historically this filter excluded them.
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

// Cluster-gate a per-band candidate pool: drop any candidate that has
// no other same-band candidate within CLUSTER_RADIUS_KM. O(N²) over
// the pool, which is fine — pool size is <300 even for "Global".
function clusterGate(candidates, radiusKm) {
  if (candidates.length < 2) return candidates;
  return candidates.filter((a) =>
    candidates.some((b) => a !== b && kmDistance(a.gps, b.gps) <= radiusKm),
  );
}

// Convert BAND_WEIGHTS to an integer quota summing exactly to `total`.
// Rounds each proportional share, then distributes any residual
// (positive or negative) from highest-weight band downward so HF4 is
// never inflated past its data-driven share.
function bandQuota(bandsKHz, total) {
  const rawShares = bandsKHz.map((khz) => total * (BAND_WEIGHTS[khz] ?? 1 / bandsKHz.length));
  const quota = rawShares.map((x) => Math.max(0, Math.round(x)));
  let residual = total - quota.reduce((a, b) => a + b, 0);
  const order = bandsKHz
    .map((khz, i) => [i, BAND_WEIGHTS[khz] ?? 0])
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);
  let oi = 0;
  while (residual > 0) { quota[order[oi % order.length]]++; residual--; oi++; }
  while (residual < 0) {
    // Take from the lightest-weighted non-zero band first.
    for (let i = order.length - 1; i >= 0 && residual < 0; i--) {
      if (quota[order[i]] > 0) { quota[order[i]]--; residual++; break; }
    }
  }
  return quota;
}

// ---- Target-region picker ----------------------------------------------
//
// When the region carries a `target: { gps, radiusKm, cohortSize }`
// we pick a tight cohort of ~cohortSize receivers and replicate it
// across every DSC band each receiver covers. The cohort is selected
// greedily:
//
//   · filter: within radiusKm of the target, passing the same health
//     gates as bbox picks (active, GPS-fixing, free slots, recent).
//   · seed:   closest receiver with usable SNR.
//   · subsequent picks: maximise (min-bearing-gap-from-existing-picks)
//     × (1 + range-ratio-bonus) × snrBonus ÷ (1 + dist/2000km). Closer
//     + different bearing + different distance shell = highest score.
//
// Distinct *host* per cohort member (host may still appear on multiple
// bands, just not twice on the same band).

function bearingDegFrom(from, to) {
  const la1 = from[0] * Math.PI / 180, la2 = to[0] * Math.PI / 180;
  const dlo = (to[1] - from[1]) * Math.PI / 180;
  const y = Math.sin(dlo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function kmDistance(a, b) {
  const EARTH_KM = 6371;
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const dla = la2 - la1, dlo = (b[1] - a[1]) * Math.PI / 180;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(
    Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2,
  ));
}

// Returns an array of viable candidates for a target region, per (host,
// band). Each entry is {host, port, bandKHz, gps, distKm, bearing, ...}.
function targetCandidates(receivers, target) {
  const { gps: center, radiusKm, bands: allowedBands } = target;
  const out = [];
  for (const r of receivers) {
    if (r.status !== "active" || r.offline === "yes" || !r.url) continue;
    if (r.ip_blacklist === "yes") continue;
    if (updatedSecondsAgo(r.updated) > UPDATE_RECENCY_SEC) continue;
    if (!String(r.sdr_hw || "").includes(GPS_HW_MARKER)) continue;
    if ((parseInt(r.fixes_hour, 10) || 0) < MIN_GPS_FIXES_HOUR) continue;
    const gps = parseGps(r.gps);
    if (!gps) continue;
    const distKm = kmDistance(gps, center);
    if (distKm > radiusKm) continue;
    // Band-restricted target: skip receivers that don't cover any of the
    // allowed bands (e.g. HF-only antennas in an MF-only region).
    if (allowedBands && !allowedBands.some((khz) => coversBand(r, khz))) continue;
    let host, port;
    try {
      const u = new URL(r.url);
      host = u.hostname;
      port = parseInt(u.port || "8073", 10);
    } catch (_) { continue; }
    const free = Math.max(0, (parseInt(r.users_max, 10) || 0) - (parseInt(r.users, 10) || 0));
    if (free < MIN_FREE_SLOTS_TO_JOIN) continue;
    const snr = snrDb(r.snr);
    // Ground-wave-restricted target: skip the SNR floor. Self-reported
    // SNR is a noise-floor measurement, not a DSC-decode predictor;
    // close-in receivers with low list SNR (Brighton, Chichester) often
    // decode MF DSC just fine, while distant high-SNR receivers can be
    // silent due to upstream/antenna issues we can't see at pick time.
    // For other targets keep the legacy filter.
    if (!allowedBands && snr != null && snr < MIN_SNR_DB) continue;
    const bearing = bearingDegFrom(center, gps);
    out.push({
      host, port, gps, distKm, bearing, free, snr,
      label: (r.loc || "").slice(0, 34) || r.name || "unknown",
      bandsRaw: r.bands,
    });
  }
  return out;
}

// Octant-based surround picker. Divides the compass into N (default
// 6) wedges around the target and takes the best-scoring receiver in
// each occupied wedge. Naturally produces surround geometry when the
// receiver distribution allows it, and naturally produces a small
// cohort when it doesn't (rather than packing the "closest" side with
// receivers that all give the same bearing). For TDOA this is the
// direct geometry lever: one vertex per compass octant is the
// difference between solvable (bearing gap ≤ ~180°) and unsolvable.
function pickSurroundCohort(candidates, octants = 6, maxPerOctant = 1) {
  if (!candidates.length) return [];
  const buckets = Array.from({ length: octants }, () => []);
  const wedgeDeg = 360 / octants;
  for (const c of candidates) {
    const bi = Math.floor((c.bearing % 360) / wedgeDeg) % octants;
    buckets[bi].push(c);
  }
  // Score within each wedge: best SNR, closer to target, broadband
  // antenna already implicit in the original `score`. Here we re-score
  // purely for cohort selection — snr > dist > free slots.
  const score = (c) => {
    const snrBonus = c.snr != null ? Math.min(2, c.snr / 20) : 1;
    const distPenalty = 1 + c.distKm / 4000;
    return snrBonus / distPenalty;
  };
  const picks = [];
  const usedHosts = new Set();
  for (const bucket of buckets) {
    bucket.sort((a, b) => score(b) - score(a));
    let taken = 0;
    for (const c of bucket) {
      if (usedHosts.has(c.host)) continue;
      picks.push(c);
      usedHosts.add(c.host);
      taken++;
      if (taken >= maxPerOctant) break;
    }
  }
  return picks;
}

// Ground-wave cohort: closest-first with octant-balanced spread, plus
// site-deduplication to avoid burning slots on near-collocated KiwiSDRs
// (e.g. two boxes at the same operator, 9 km apart) — they provide
// essentially the same geometric constraint but each takes a separate
// upstream WS connection. SNR self-report on the public list is a
// noise-floor estimate, not a guarantee that the receiver actually
// decodes weak MF DSC bursts; for ground-wave reception probability
// the only thing that matters is proximity to the transmitter. Within
// the closest 3× pool we pick one receiver per compass octant (round
// 1) and then top up with the next-closest unpicked (round 2). Result:
// a tight cohort (~50-300 km from centroid) with reasonable bearing
// spread when the receiver distribution allows it.
// Site dedup. Keep at 5 km — only collapse literal collocations (e.g.
// the same operator running two KiwiSDR boxes side-by-side). Anything
// further apart gives genuinely different timing, and *quantity of
// independent decoders* matters more than perfect spread for hitting
// quorum reliably.
const SITE_DEDUP_KM = 5;

function pickGroundWaveCohort(candidates, size) {
  if (!candidates.length) return [];
  const pool = [...candidates].sort((a, b) => a.distKm - b.distKm).slice(0, size * 4);
  const wedges = Array(8).fill(null).map(() => []);
  for (const c of pool) wedges[Math.floor(c.bearing / 45) % 8].push(c);
  for (const w of wedges) w.sort((a, b) => a.distKm - b.distKm);
  const picks = [];
  const usedHosts = new Set();
  const siteCovered = (c) => picks.some((p) => kmDistance(p.gps, c.gps) < SITE_DEDUP_KM);
  for (const w of wedges) {
    for (const c of w) {
      if (usedHosts.has(c.host) || siteCovered(c)) continue;
      picks.push(c); usedHosts.add(c.host); break;
    }
  }
  for (const c of pool) {
    if (picks.length >= size) break;
    if (usedHosts.has(c.host) || siteCovered(c)) continue;
    picks.push(c); usedHosts.add(c.host);
  }
  return picks.slice(0, size);
}

function pickTargetCohort(candidates, size, target) {
  if (!candidates.length) return [];
  // Ground-wave-restricted target: SNR is unreliable, proximity is king.
  if (target.bands) return pickGroundWaveCohort(candidates, size);
  // Strategy 1 — octant surround. If we get ≥ 3 occupied octants, use
  // them: compass surround is worth more than a same-side pile-on.
  const surround = pickSurroundCohort(candidates, 6, 1);
  if (surround.length >= 3) {
    // If surround is smaller than the requested size, top up with the
    // next best bearing-distant receivers, preserving host uniqueness.
    if (surround.length >= size) return surround.slice(0, size);
    const usedHosts = new Set(surround.map(c => c.host));
    const remaining = candidates.filter(c => !usedHosts.has(c.host));
    remaining.sort((a, b) => (b.snr ?? 0) - (a.snr ?? 0));
    return surround.concat(remaining.slice(0, size - surround.length));
  }
  // Strategy 2 (fallback) — old greedy bearing-spread when the target
  // simply doesn't have octant coverage. Preserves backwards-compat
  // for target regions whose receiver pool is geographically one-sided
  // (e.g. Black Sea with EU-only receivers). Those fixes won't pass
  // the confirmed bearing gate anyway but the cohort still gives the
  // preliminary tier a chance.
  const bySnrThenDist = [...candidates].sort((a, b) => a.distKm - b.distKm);
  const seed = bySnrThenDist.find(c => (c.snr ?? 0) >= MIN_SNR_DB + 2) || bySnrThenDist[0];
  const picks = [seed];
  const usedHosts = new Set([seed.host]);
  while (picks.length < size) {
    let best = null, bestScore = -Infinity;
    for (const c of candidates) {
      if (usedHosts.has(c.host)) continue;
      let minAng = 360;
      for (const p of picks) {
        let d = Math.abs(c.bearing - p.bearing);
        if (d > 180) d = 360 - d;
        if (d < minAng) minAng = d;
      }
      let minRangeRatio = Infinity;
      for (const p of picks) {
        const r = Math.abs(Math.log((c.distKm + 1) / (p.distKm + 1)));
        if (r < minRangeRatio) minRangeRatio = r;
      }
      const snrBonus = c.snr != null ? Math.min(2, c.snr / 20) : 1;
      const distPenalty = 1 + c.distKm / 2000;
      const score = minAng * (1 + minRangeRatio) * snrBonus / distPenalty;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    picks.push(best);
    usedHosts.add(best.host);
  }
  return picks;
}

// Pick a target rack: same small cohort replicated across every DSC
// band each receiver physically covers. Output shape matches the bbox
// rack — one entry per (host, band) — so the Worker can hand it to
// DirectoryDO's renderer unchanged.
//
// `target.bands` (optional) restricts the rack to specific DSC bands —
// useful for ground-wave-only operation (MF: 2187.5 kHz) where mixing
// in HF would pull in 1-3 hop skywave from outside the cohort area
// and break the uniform-propagation assumption.
export function pickTargetRack(receivers, target, requested = DEFAULT_FANOUT) {
  const candidates = targetCandidates(receivers, target);
  const size = Math.max(3, target.cohortSize ?? 6);
  const cohort = pickTargetCohort(candidates, size, target);
  const cap = Math.min(DEFAULT_FANOUT, Math.max(1, requested | 0));
  const allowedBands = target.bands ?? BANDS.map(b => b.khz);
  const picks = [];
  for (const khz of allowedBands) {
    for (const c of cohort) {
      if (!coversBand({ bands: c.bandsRaw }, khz)) continue;
      picks.push({
        host: c.host,
        port: c.port,
        bandKHz: khz,
        bandLabel: bandLabelFor(khz),
        label: c.label,
        gps: c.gps,
        snr: c.snr,
        coast: +c.distKm.toFixed(1),    // distance-to-target, repurposed
      });
      if (picks.length >= cap) break;
    }
    if (picks.length >= cap) break;
  }
  return picks;
}

export function pickRack(receivers, bbox, requested = DEFAULT_FANOUT) {
  const n = Math.max(1, Math.min(DEFAULT_FANOUT, requested | 0));
  const bandsKHz = BANDS.map((b) => b.khz);
  const k = bandsKHz.length;
  // Band-weighted allocation — see BAND_WEIGHTS for the data basis.
  const quota = bandQuota(bandsKHz, n);
  // Cluster-gate each band pool so isolated receivers (no same-band
  // peer within CLUSTER_RADIUS_KM) don't eat a slot. They decode but
  // never into a TDOA quorum. Small regions / thin pools fall back to
  // the ungated pool below, same as the top-up pass.
  const pools = bandsKHz.map((khz) => {
    const ranked = rankCandidates(receivers, khz, bbox);
    const radius = CLUSTER_RADIUS_KM_BY_BAND[khz];
    if (!radius) return ranked;                  // long-range bands: no gate
    const gated = clusterGate(ranked, radius);
    // If the gate would leave a band empty (e.g. a tight bbox with one
    // receiver), fall back to the ungated pool rather than serving
    // zero slots for that band.
    return gated.length >= 2 ? gated : ranked;
  });
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
