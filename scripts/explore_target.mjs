#!/usr/bin/env node
// Backend-only TDOA feasibility study for a specific *area of interest*.
//
// Given a handful of port targets (defaults: Russian Black Sea), this
// script:
//
//   1. Fetches the public KiwiSDR list.
//   2. Applies the same hard filters as pickRack (GPS-fixing, active,
//      free slots, band coverage, not proxy/blacklisted).
//   3. Builds a geometry-driven cohort of N receivers around the target:
//      greedy pick that rewards close-in + angular spread + SNR.
//   4. Simulates a synthetic DSC burst originating from each port,
//      pushes it through xcorr + solveTdoa using that cohort, and
//      reports expected km error.
//
// The aim is to answer: "if we focused Skywave on <this area>, which
// receivers would we glue together, and how well would TDOA work on a
// real burst from there?"
//
// Run:
//   node scripts/explore_target.mjs
//   node scripts/explore_target.mjs --size 6 --band MF
//   node scripts/explore_target.mjs --size 8 --band HF8 --noise 0.1
//
// Flags:
//   --size N        cohort size (default 6)
//   --band LABEL    which DSC band to pick (MF, HF4, HF6, HF8, HF12, HF16)
//   --trials N      repetitions per port (default 15)
//   --noise x       additive noise amplitude per sample (default 0.05)
//   --max-km N      max receiver distance from target centroid (default 3500)
//   --target lat,lon  override centroid (free-text label becomes "custom")
//
// Output is entirely offline — no WebSockets opened, no upstream KiwiSDR
// traffic. Pure list scrape + math.

import fs from "node:fs";
import { xcorr, solveTdoa, geodist, C } from "../worker/src/tdoa.js";
import { BANDS, bandLabelFor, parseGps, coversBand } from "../worker/src/regions.js";

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const SIZE    = parseInt(getArg("--size", "6"), 10);
const BAND    = getArg("--band", "MF");
const TRIALS  = parseInt(getArg("--trials", "15"), 10);
const NOISE   = parseFloat(getArg("--noise", "0.05"));
const MAX_KM  = parseFloat(getArg("--max-km", "3500"));
const TARGET  = getArg("--target", null);
// Public KiwiSDRs behind proxy.kiwisdr.com serve a 307 redirect on the
// WS handshake that browsers can't follow; we exclude them from the
// production rack. A script running kiwirecorder.py *can* follow, so for
// backend-only feasibility studies it's useful to include them.
const ALLOW_PROXY = args.includes("--allow-proxy");
const LIST_URL = "http://rx.linkfanel.net/kiwisdr_com.js";
const CACHE    = "/tmp/kiwisdr_com.js";

const BAND_KHZ = (BANDS.find(b => b.short === BAND) || BANDS[0]).khz;

// ---------- Target area ---------------------------------------------------

// Russian Black Sea / Sea of Azov ports — the operational interest set.
// Order roughly W→E so the simulator output reads geographically.
const DEFAULT_PORTS = [
  { name: "Sevastopol",    gps: [44.62, 33.52] },   // occupied Crimea
  { name: "Feodosia",      gps: [45.03, 35.39] },
  { name: "Kerch",         gps: [45.37, 36.47] },
  { name: "Taman",         gps: [45.22, 36.72] },
  { name: "Novorossiysk",  gps: [44.72, 37.78] },   // main crude terminal
  { name: "Tuapse",        gps: [44.10, 39.08] },
  { name: "Taganrog",      gps: [47.22, 38.93] },   // Sea of Azov
];

let ports = DEFAULT_PORTS;
let targetCentroid;
let targetLabel = "Russian Black Sea";
if (TARGET) {
  const [la, lo] = TARGET.split(",").map(Number);
  ports = [{ name: "custom", gps: [la, lo] }];
  targetCentroid = [la, lo];
  targetLabel = `custom ${la.toFixed(2)},${lo.toFixed(2)}`;
} else {
  const la = ports.reduce((s, p) => s + p.gps[0], 0) / ports.length;
  const lo = ports.reduce((s, p) => s + p.gps[1], 0) / ports.length;
  targetCentroid = [la, lo];
}

// ---------- Fetch & parse list -------------------------------------------

async function loadList() {
  // Cache for 1h.
  let raw;
  try {
    const st = fs.statSync(CACHE);
    if (Date.now() - st.mtimeMs < 3600_000) {
      raw = fs.readFileSync(CACHE, "utf8");
    }
  } catch (_) {}
  if (!raw) {
    console.error(`# fetching ${LIST_URL} ...`);
    const res = await fetch(LIST_URL);
    raw = await res.text();
    fs.writeFileSync(CACHE, raw);
  }
  const i = raw.indexOf("[");
  const j = raw.lastIndexOf("]");
  // The list has trailing commas, so use a Function eval rather than JSON.
  return (new Function("return " + raw.slice(i, j + 1)))();
}

// ---------- Filter & score -----------------------------------------------

function bearingDeg(from, to) {
  const la1 = from[0] * Math.PI / 180, la2 = to[0] * Math.PI / 180;
  const dlo = (to[1] - from[1]) * Math.PI / 180;
  const y = Math.sin(dlo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function filterCandidates(list, khz) {
  const out = [];
  for (const r of list) {
    if (r.status !== "active" || r.offline === "yes" || !r.url) continue;
    if (r.ip_blacklist === "yes") continue;
    if (!ALLOW_PROXY && /proxy\.kiwisdr\.com/i.test(r.url)) continue;
    if (!String(r.sdr_hw || "").includes("GPS")) continue;
    if ((parseInt(r.fixes_hour, 10) || 0) < 100) continue;
    if (!coversBand(r, khz)) continue;
    const gps = parseGps(r.gps);
    if (!gps) continue;
    let host;
    try {
      const u = new URL(r.url);
      host = `${u.hostname}:${u.port || "8073"}`;
    } catch { continue; }
    const free = Math.max(0, (parseInt(r.users_max, 10) || 0) - (parseInt(r.users, 10) || 0));
    if (free < 2) continue;
    const distKm = geodist(gps, targetCentroid) / 1000;
    if (distKm > MAX_KM) continue;
    const snrRaw = String(r.snr || "").split(/[,\s]+/).map(Number).filter(Number.isFinite);
    const snr = snrRaw.length ? Math.max(...snrRaw) : null;
    out.push({
      host,
      gps,
      distKm,
      bearing: bearingDeg(targetCentroid, gps),
      free,
      snr,
      label: (r.loc || r.name || "unknown").slice(0, 32),
      url: r.url,
    });
  }
  return out;
}

// Greedy cohort selection. First pick = closest + healthy. Each subsequent
// pick maximises (angular separation from already-picked) × SNR-bonus ÷
// distance-penalty. Keeps same-host dedup (a single Kiwi can't contribute
// twice — identical geometry = degenerate).
function pickCohort(candidates, size) {
  if (!candidates.length) return [];
  // Seed: closest decent-SNR receiver.
  const seed = candidates
    .filter(c => (c.snr ?? 0) >= 8)
    .sort((a, b) => a.distKm - b.distKm)[0] || candidates[0];
  const picks = [seed];
  const usedHosts = new Set([seed.host.split(":")[0]]);
  while (picks.length < size) {
    let best = null, bestScore = -Infinity;
    for (const c of candidates) {
      if (usedHosts.has(c.host.split(":")[0])) continue;
      // Minimum angular separation (deg) from any existing pick.
      let minAng = 360;
      for (const p of picks) {
        let d = Math.abs(c.bearing - p.bearing);
        if (d > 180) d = 360 - d;
        if (d < minAng) minAng = d;
      }
      // Range diversity bonus: prefer a different distance shell from the
      // nearest existing pick.
      let minRangeRatio = Infinity;
      for (const p of picks) {
        const r = Math.abs(Math.log((c.distKm + 1) / (p.distKm + 1)));
        if (r < minRangeRatio) minRangeRatio = r;
      }
      const snrBonus = c.snr != null ? Math.min(2, c.snr / 20) : 1;
      // Distance penalty — further = more ionospheric bias, lower SNR.
      const distPenalty = 1 + c.distKm / 2000;
      const score = minAng * (1 + minRangeRatio) * snrBonus / distPenalty;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    picks.push(best);
    usedHosts.add(best.host.split(":")[0]);
  }
  return picks;
}

// ---------- Synthetic burst simulation ------------------------------------

const SR = 12000;
const OVERSAMPLE = 8;
const HIGH_SR = SR * OVERSAMPLE;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBurst(nSymbols, rng) {
  const sps = HIGH_SR / 100;
  const total = Math.floor(sps * nSymbols);
  const out = new Float32Array(total);
  const syms = new Uint8Array(nSymbols);
  for (let s = 0; s < nSymbols; s++) syms[s] = rng() < 0.5 ? 0 : 1;
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const sym = syms[Math.floor(i / sps)];
    const freq = sym ? 1785 : 1615;
    phase += 2 * Math.PI * freq / HIGH_SR;
    out[i] = Math.sin(phase);
  }
  const fadeN = 20 * OVERSAMPLE;
  for (let i = 0; i < fadeN; i++) {
    const w = 0.5 * (1 - Math.cos(Math.PI * i / fadeN));
    out[i] *= w;
    out[total - 1 - i] *= w;
  }
  return out;
}

function sampleReceiver(highRateBase, arrivalSec, padSec, noise, rng) {
  const padSamples = Math.ceil(padSec * SR);
  const burstSec = highRateBase.length / HIGH_SR;
  const totalOut = Math.ceil((burstSec + Math.abs(arrivalSec)) * SR) + 2 * padSamples;
  const out = new Float32Array(totalOut);
  for (let k = 0; k < totalOut; k++) {
    const t = (k - padSamples) / SR - arrivalSec;
    const idx = Math.round(t * HIGH_SR);
    if (idx >= 0 && idx < highRateBase.length) out[k] = highRateBase[idx];
    out[k] += (rng() - 0.5) * 2 * noise;
  }
  return out;
}

function simulateOne(cohort, txGps, rng) {
  const base = makeBurst(200, rng);
  const arrivals = cohort.map(c => geodist(c.gps, txGps) / C);
  const refArr = arrivals[0];
  const relDelays = arrivals.map(t => t - refArr);
  const padSec = 0.05;
  const sigs = relDelays.map(t => sampleReceiver(base, t, padSec, NOISE, rng));
  const maxAbsSamples = Math.max(...relDelays.map(t => Math.abs(t * SR)));
  const maxLag = Math.ceil(maxAbsSamples) + 20;
  const ref = sigs[0];
  const dets = sigs.map((s, i) => {
    if (i === 0) return { gps: cohort[0].gps, t: 0 };
    const { lag } = xcorr(ref, s, maxLag);
    return { gps: cohort[i].gps, t: lag / SR };
  });
  const solved = solveTdoa(dets);
  if (!solved) return { errKm: NaN, residualKm: NaN };
  return {
    errKm: geodist([solved.lat, solved.lon], txGps) / 1000,
    residualKm: solved.residualKm,
  };
}

// ---------- Main ----------------------------------------------------------

const list = await loadList();
const candidates = filterCandidates(list, BAND_KHZ);
candidates.sort((a, b) => a.distKm - b.distKm);

console.log(`# Target: ${targetLabel}  centroid=${targetCentroid[0].toFixed(2)},${targetCentroid[1].toFixed(2)}`);
console.log(`# Band: ${BAND} (${BAND_KHZ} kHz)   Cohort size: ${SIZE}   Noise: ${NOISE}   Trials/port: ${TRIALS}`);
console.log(`# Filtered candidates within ${MAX_KM} km: ${candidates.length}`);
console.log();

if (candidates.length < 3) {
  console.log("# not enough receivers — relax --max-km or pick another band");
  process.exit(1);
}

// Show the top 12 candidates so the reader can sanity-check the pool.
console.log("# Top 12 closest candidates (for context):");
console.log("  dist_km  bearing  snr  free  host");
for (const c of candidates.slice(0, 12)) {
  console.log(
    `  ${c.distKm.toFixed(0).padStart(5)}    ${c.bearing.toFixed(0).padStart(5)}°  `
    + `${String(c.snr ?? "-").padStart(3)}   ${String(c.free).padStart(2)}   `
    + `${c.host.padEnd(32)}  ${c.label}`,
  );
}
console.log();

const cohort = pickCohort(candidates, SIZE);
console.log(`# Selected cohort (${cohort.length} receivers):`);
console.log("  dist_km  bearing  snr  host                              label");
for (const c of cohort) {
  console.log(
    `  ${c.distKm.toFixed(0).padStart(5)}    ${c.bearing.toFixed(0).padStart(5)}°  `
    + `${String(c.snr ?? "-").padStart(3)}   ${c.host.padEnd(33)} ${c.label}`,
  );
}
console.log();

// Geometric diversity summary
const bearings = cohort.map(c => c.bearing).sort((a, b) => a - b);
const gaps = bearings.map((b, i) => {
  const next = bearings[(i + 1) % bearings.length];
  let g = next - b; if (g < 0) g += 360;
  return g;
});
const maxGap = Math.max(...gaps);
console.log(`# Azimuthal coverage: max bearing gap = ${maxGap.toFixed(0)}° `
  + `(smaller = better symmetry; >180° means all receivers on one side of target)`);
console.log();

// Simulate
console.log(`# Simulated TDOA error per port (synthetic FSK burst, noise=${NOISE}):`);
console.log("  port              p50_km   p90_km   max_km   median_resid_km");

const rng = mulberry32(42);
const allErrors = [];
for (const p of ports) {
  const errs = [], resids = [];
  for (let t = 0; t < TRIALS; t++) {
    const { errKm, residualKm } = simulateOne(cohort, p.gps, rng);
    if (Number.isFinite(errKm)) { errs.push(errKm); resids.push(residualKm); }
  }
  errs.sort((a, b) => a - b);
  resids.sort((a, b) => a - b);
  allErrors.push(...errs);
  const pct = (a, q) => a[Math.floor(a.length * q)] ?? NaN;
  console.log(
    `  ${p.name.padEnd(18)}`
    + `${pct(errs, 0.5).toFixed(2).padStart(6)}  `
    + `${pct(errs, 0.9).toFixed(2).padStart(7)}  `
    + `${errs[errs.length - 1].toFixed(2).padStart(7)}  `
    + `${pct(resids, 0.5).toFixed(3).padStart(10)}`,
  );
}

allErrors.sort((a, b) => a - b);
const pct = (q) => allErrors[Math.floor(allErrors.length * q)] ?? NaN;
console.log();
console.log(`# Overall (${allErrors.length} simulated bursts): `
  + `p50=${pct(0.5).toFixed(2)} km   p90=${pct(0.9).toFixed(2)} km   `
  + `mean=${(allErrors.reduce((s, x) => s + x, 0) / allErrors.length).toFixed(2)} km`);

console.log();
console.log("# Hosts in this cohort (for live verification via kiwirecorder.py");
console.log("# or a one-off Worker attachment):");
for (const c of cohort) console.log(`#   ${c.host}`);
