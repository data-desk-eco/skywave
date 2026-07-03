// offline analysis of capture_iq.mjs JSONL: buckets detections like the
// TDOADO, measures every pair's arrival-time difference with both the
// production-v1 estimator (real xcorr) and the complex-envelope
// estimator (toa.js), and — for coast stations with registered
// positions — scores both against geometric truth, binned by range
// (ground-wave pairs vs skywave pairs). also reports per-pair
// repeatability across repeat bursts and solved fixes.
//
//   node scripts/analyse_capture.mjs captures/night1.jsonl [--pairs]

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { xcorr, solveTdoa, geodist } from "../worker/src/tdoa.js";
import { estimateDt } from "../worker/src/toa.js";
import { COAST_REGISTRY } from "../worker/src/coast-registry.js";

const C = 299792458;
const [file, ...flags] = process.argv.slice(2);
const SHOW_PAIRS = flags.includes("--pairs");
const GW_KM = 300;   // both ends within this of the source = ground-wave pair

const f32 = (b64) => new Float32Array(Buffer.from(b64, "base64").buffer.slice(0));
const compat = (a, b) => a.length === b.length &&
  [...a].every((c, i) => c === "?" || b[i] === "?" || c === b[i]);
const quality = (m) => [...m].filter((c) => c !== "?").length;
let nBuckets = 0, nMulti = 0;
const bins = { gw: { prod: [], env: [] }, sky: { prod: [], env: [] } };
const pairSeries = new Map();      // mmsi|ref|det → [envUs...]
const fixRows = [];
const vesselMmsis = new Set();
let nDets = 0;
const pending = [];   // open buckets, flushed once 10 s of stream passes them
const flushReady = (nowT) => {
  while (pending.length && (nowT === Infinity || nowT - pending[0].dets[0].packetT > 10)) {
    processBucket(pending.shift());
  }
};
const addDet = (d) => {
  nDets++;
  const mmsi = d.call.caller ?? "?";
  let b = pending.find((b) => Math.abs(d.packetT - b.dets[0].packetT) < 2
    && compat(mmsi, b.mmsi) && !b.dets.some((x) => x.host === d.host));
  if (!b) {
    b = { mmsi, dets: [d] };
    pending.push(b);
    pending.sort((x, y) => x.dets[0].packetT - y.dets[0].packetT);
  } else {
    if (quality(mmsi) > quality(b.mmsi)) b.mmsi = mmsi;
    b.dets.push(d);
  }
  flushReady(d.packetT);
};
for await (const line of createInterface({ input: createReadStream(file) })) {
  if (!line.includes('"t":"det"')) continue;
  const o = JSON.parse(line);
  const a = o.anchors;
  if (!a || a.length < 2) continue;
  let secs = a.map((p) => p.sec + p.nsec / 1e9);
  if (Math.max(...secs) - Math.min(...secs) > 300000) {
    secs = secs.map((s) => (s < 302400 ? s + 604800 : s));   // GPS week wrap
  }
  const x0 = a[0].abs, t0 = secs[0];
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let k = 0; k < a.length; k++) {
    const x = a[k].abs - x0, y = secs[k] - t0;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = a.length;
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const icpt = (sy - slope * sx) / n;
  const tAt = (abs) => t0 + icpt + slope * (abs - x0);
  addDet({
    host: o.host, gps: o.gps, sr: o.sr, call: o.call, wallMs: o.wallMs,
    band: o.band ?? "MF",
    i: f32(o.i), q: f32(o.q),
    packetT: tAt(o.absStart), snipT: tAt(o.snipAbs),
  });
}
flushReady(Infinity);
report();

function processBucket(b) {
  nBuckets++;
  if (b.dets.length < 2) return;
  if (new Set(b.dets.map((d) => d.band)).size > 1) return;   // cross-band guard
  nMulti++;
  const ds = [...b.dets].sort((x, y) =>
    (x.call.badSymbols - y.call.badSymbols) || (x.call.phasingScore - y.call.phasingScore));
  const ref = ds[0];
  const entry = COAST_REGISTRY[b.mmsi];
  if (!entry && !b.mmsi.startsWith("00") && !b.mmsi.includes("?")) vesselMmsis.add(b.mmsi);
  let truth = null;
  if (entry) {
    const cLat = ds.reduce((s, d) => s + d.gps[0], 0) / ds.length;
    const cLon = ds.reduce((s, d) => s + d.gps[1], 0) / ds.length;
    truth = entry.sites.reduce((best, s) =>
      !best || geodist(s, [cLat, cLon]) < geodist(best, [cLat, cLon]) ? s : best, null);
  }
  const solver = [{ gps: ref.gps, t: 0 }];
  for (const d of ds.slice(1)) {
    const startDt = d.snipT - ref.snipT;
    const maxLagSec = Math.abs(startDt) + 0.010;
    const dI = Math.abs(d.sr - ref.sr) / ref.sr > 0.01 ? null : d.i;
    if (!dI) continue;
    const { lag } = xcorr(ref.i, dI, Math.ceil(maxLagSec * ref.sr));
    const dtProd = startDt + lag / ref.sr;
    const est = estimateDt(ref.i, ref.q, dI, d.q, ref.sr, { maxLagSec });
    if (!est) continue;
    const dtEnv = startDt + est.dt;
    if (est.peakRatio >= 2.0) solver.push({ gps: d.gps, t: dtEnv });
    if (truth) {
      const geo = (geodist(truth, d.gps) - geodist(truth, ref.gps)) / C;
      const refKm = geodist(truth, ref.gps) / 1000, detKm = geodist(truth, d.gps) / 1000;
      const bin = Math.max(refKm, detKm) <= GW_KM ? "gw" : "sky";
      bins[bin].prod.push((dtProd - geo) * 1e6);
      bins[bin].env.push((dtEnv - geo) * 1e6);
      const key = `${b.mmsi}|${ref.host}|${d.host}`;
      if (!pairSeries.has(key)) pairSeries.set(key, { bin, refKm, detKm, vals: [] });
      pairSeries.get(key).vals.push(dtEnv * 1e6);
      if (SHOW_PAIRS) console.log(JSON.stringify({
        mmsi: b.mmsi, name: entry.name, bin, ref: ref.host, det: d.host,
        refKm: +refKm.toFixed(0), detKm: +detKm.toFixed(0),
        prodUs: +((dtProd - geo) * 1e6).toFixed(1), envUs: +((dtEnv - geo) * 1e6).toFixed(1),
        peakRatio: +est.peakRatio.toFixed(1), cfoHz: +est.cfoHz.toFixed(2),
      }));
    }
  }
  if (solver.length >= 4) {
    const sol = solveTdoa(solver);
    if (sol) fixRows.push({
      mmsi: b.mmsi, name: entry?.name, q: solver.length,
      lat: +sol.lat.toFixed(3), lon: +sol.lon.toFixed(3),
      residKm: +sol.residualKm.toFixed(1), atEdge: sol.atEdge || undefined,
      errKm: truth ? +(geodist([sol.lat, sol.lon], truth) / 1000).toFixed(1) : null,
      t: new Date(b.dets[0].wallMs).toISOString().slice(5, 19),
    });
  }
}

function report() {
console.log(`${nDets} detections, ${nBuckets} buckets, ${nMulti} multi-receiver`);
const stats = (arr) => {
  if (!arr.length) return "n=0";
  const abs = arr.map(Math.abs).sort((a, b) => a - b);
  const p = (q) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))].toFixed(0);
  return `n=${arr.length} p50=${p(0.5)}us p90=${p(0.9)}us max=${p(1)}us`;
};
for (const bin of ["gw", "sky"]) {
  console.log(`\n${bin === "gw" ? `ground-wave pairs (both <= ${GW_KM} km)` : "skywave pairs"}:`);
  console.log(`  prod: ${stats(bins[bin].prod)}`);
  console.log(`  env:  ${stats(bins[bin].env)}`);
}
console.log(`\nrepeatability (same station+pair across bursts, env, n>=3):`);
for (const [key, s] of pairSeries) {
  if (s.vals.length < 3) continue;
  const mean = s.vals.reduce((a, x) => a + x, 0) / s.vals.length;
  const sd = Math.sqrt(s.vals.reduce((a, x) => a + (x - mean) ** 2, 0) / (s.vals.length - 1));
  console.log(`  ${key} ${s.bin} n=${s.vals.length} sd=${sd.toFixed(1)}us  (${s.refKm.toFixed(0)}/${s.detKm.toFixed(0)} km)`);
}
console.log(`\nfixes (env, peakRatio>=2):`);
for (const r of fixRows) console.log(JSON.stringify(r));
console.log(`\nvessel MMSIs seen: ${[...vesselMmsis].join(" ")}`);
}
