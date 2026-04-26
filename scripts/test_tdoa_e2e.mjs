#!/usr/bin/env node
// End-to-end validation of the TDOA coordinator's pairing + solve path.
//
// Builds detection records exactly as ReceiverDO would — each carrying a
// slot-local GPS-ns snippet anchor and a Float32 audio snippet — then
// feeds them to TDOADO._solveBucket() to exercise the full cross-corr +
// hyperboloid solve stack. Uses a mock DO state so no Cloudflare runtime
// is needed.
//
// Success criterion: recovered TX position within a few km of ground
// truth despite per-receiver snippet-start jitter (simulates the real
// world where receivers don't all grab the burst at exactly the same
// wall-clock moment).
//
// Run:  node scripts/test_tdoa_e2e.mjs [--trials N] [--jitter 0.3]

import { geodist, C } from "../worker/src/tdoa.js";
import { TDOADO } from "../worker/src/tdoa-do.js";

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const TRIALS = parseInt(getArg("--trials", "20"), 10);
// Per-receiver wall-clock offset in the snippet start (seconds). Models
// the fact that each ReceiverDO runs its own decoder loop and picks the
// snippet window at slightly different moments.
const JITTER_SEC = parseFloat(getArg("--jitter", "0.3"));
const SEED = parseInt(getArg("--seed", "7"), 10);
const SR = 12000;
const OVERSAMPLE = 8;
const HIGH_SR = SR * OVERSAMPLE;

// Five receivers spanning NW Europe — enough to surround any TX in
// the North Sea / Baltic area. The 5th (Gdansk) is essential for the
// production path: TDOADO's reliability gates reject solves where the
// cohort is all in one hemisphere from the solution (max bearing gap
// > 180°), which is what the original four-receiver all-west geometry
// would have triggered. With Gdansk to the east, TX positions in the
// North Sea are properly surrounded.
const receivers = [
  { name: "Chichester UK", slot: "gb-chi:8073|MF", gps: [50.846, -0.662] },
  { name: "Dover UK",      slot: "gb-dov:8073|MF", gps: [51.129,  1.316] },
  { name: "Den Helder NL", slot: "nl-den:8073|MF", gps: [52.958,  4.760] },
  { name: "Bergen NO",     slot: "no-ber:8073|MF", gps: [60.391,  5.322] },
  { name: "Gdansk PL",     slot: "pl-gda:8073|MF", gps: [54.356, 18.646] },
];

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
  const symbols = new Uint8Array(nSymbols);
  for (let s = 0; s < nSymbols; s++) symbols[s] = rng() < 0.5 ? 0 : 1;
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const sym = symbols[Math.floor(i / sps)];
    phase += 2 * Math.PI * (sym ? 1785 : 1615) / HIGH_SR;
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

// Build a Float32 snippet of length ~2 s centred on the burst, where
// the receiver started recording at absolute time `recordStartSec`
// (its own choice; the coordinator uses the startGpsNs anchor to align).
function captureSnippet(highRateBase, arrivalSec, recordStartSec, durSec, noise, rng) {
  const nOut = Math.ceil(durSec * SR);
  const out = new Float32Array(nOut);
  for (let k = 0; k < nOut; k++) {
    const wallClock = recordStartSec + k / SR;
    const tIntoBurst = wallClock - arrivalSec;   // when was this sample emitted?
    const idx = Math.round(tIntoBurst * HIGH_SR);
    if (idx >= 0 && idx < highRateBase.length) out[k] = highRateBase[idx];
    out[k] += (rng() - 0.5) * 2 * noise;
  }
  return out;
}

// Mock enough of the DurableObjectState surface for TDOADO to run.
function mockState() {
  return {
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    blockConcurrencyWhile: (fn) => fn(),
    storage: {
      get: async () => null,
      put: async () => {},
      setAlarm: async () => {},
    },
  };
}

function runTrial(txGps, rng) {
  const base = makeBurst(200, mulberry32(0xD5C));
  // Ground-wave propagation: signal travels great-circle at c. Matches
  // the production solver's geodesic-distance assumption — the cohort
  // is selected to keep every receiver inside MF ground-wave range.
  const arrivals = receivers.map(r => geodist(r.gps, txGps) / C);

  // Assume the TX emitted the burst at absolute t = 0. Each receiver
  // picks a recording window starting ~0.5 s before its arrival, with
  // JITTER_SEC of independent slop (models decoder scheduling).
  const records = receivers.map((r, i) => {
    const arr = arrivals[i];
    const recordStartSec = arr - 0.5 + (rng() - 0.5) * 2 * JITTER_SEC;
    const samples = captureSnippet(base, arr, recordStartSec, 2.0, 0.05, rng);

    // GPS-ns anchor for sample 0 of the snippet. Pick an arbitrary GPS
    // epoch (e.g. 4 days of GPS week).
    const epochNs = 4n * 86_400n * 1_000_000_000n;
    const startGpsNs = epochNs + BigInt(Math.round(recordStartSec * 1e9));
    // packetGpsNs can be anywhere inside the snippet; for bucketing just
    // use a point ~0.5 s in.
    const packetGpsNs = startGpsNs + 500_000_000n;

    return {
      slot: { slot: r.slot, band: "MF", gps: r.gps },
      call: { caller: "112233445" },
      packetGpsNs: packetGpsNs.toString(),
      snippet: {
        sampleRate: SR,
        startGpsNs: startGpsNs.toString(),
        samples: Array.from(samples),
      },
    };
  });

  const coord = new TDOADO(mockState(), {});
  let latest = null;
  coord._broadcast = (m) => { latest = m; };

  for (const rec of records) {
    coord._ingest({
      receivedMs: Date.now(),
      slotId: `${rec.slot.slot}|${rec.slot.band}`,
      band: rec.slot.band,
      label: rec.slot.slot,
      gps: rec.slot.gps,
      call: rec.call,
      packetGpsNs: BigInt(rec.packetGpsNs),
      snippet: {
        sampleRate: rec.snippet.sampleRate,
        startGpsNs: BigInt(rec.snippet.startGpsNs),
        samples: Float32Array.from(rec.snippet.samples),
      },
    });
  }

  if (!latest) return { ok: false, reason: "no solve" };
  const errKm = geodist([latest.position.lat, latest.position.lon], txGps) / 1000;
  return { ok: true, errKm, residualKm: latest.position.residualKm, lags: latest.receivers };
}

// ---- drive ------------------------------------------------------------
const rng = mulberry32(SEED);
// TX positions inside the receiver surround — bearing gap < 180° from
// each. Locations outside the convex hull (e.g. [58, -2]: all receivers
// to the east; or [51.5, -5]: all receivers to the east) are rejected
// by the production gates and no longer part of this "golden path"
// test.
const txs = [
  [52.0,  3.5],    // inside surround — Dogger Bank
  [54.0,  6.0],    // inside surround — German Bight
  [57.0,  7.5],    // inside surround — Skagerrak
  [55.5,  8.0],    // inside surround — Jutland coast
  [58.0,  5.5],    // inside surround — Norwegian coast
];
console.log(`# TDOA end-to-end (coordinator path) — jitter=${JITTER_SEC}s, seed=${SEED}`);
console.log("tx_lat   tx_lon   err_km   resid_km   lags(samples)");

const errors = [];
for (const tx of txs) {
  for (let t = 0; t < TRIALS; t++) {
    const r = runTrial(tx, rng);
    if (!r.ok) { console.log(`${tx}: ${r.reason}`); continue; }
    errors.push(r.errKm);
    if (t === 0) {
      const lagStr = r.lags.map(l => l.lagSamples.toFixed(1)).join(" ");
      console.log(`${tx[0].toFixed(3).padStart(6)}  ${tx[1].toFixed(3).padStart(7)}  ${r.errKm.toFixed(2).padStart(6)}  ${r.residualKm.toFixed(3).padStart(8)}   ${lagStr}`);
    }
  }
}
errors.sort((a, b) => a - b);
const pct = p => errors[Math.floor(errors.length * p)];
const mean = errors.reduce((s, x) => s + x, 0) / errors.length;
console.log();
console.log(`# n=${errors.length}  mean=${mean.toFixed(2)} km  p50=${pct(0.5).toFixed(2)} km  p90=${pct(0.9).toFixed(2)} km  max=${errors[errors.length-1].toFixed(2)} km`);
