#!/usr/bin/env node
// Far-field (plane-wave) discriminator evaluation.
//
// Part 1 — synthetic: a Channel-like MF cohort hearing (a) sources
// genuinely inside / near the cohort, (b) far sources (Lyngby 750 km,
// Civitavecchia 1500 km, Greece 2400 km) whose timings reach the
// cohort as a near-planar wavefront. Report pointResid vs planeResid
// for each, with realistic timing noise.
//
// Part 2 — live: replay every broadcast in a capture JSONL (receivers
// carry gps + dtSec), run farFieldCheck on the as-measured timings,
// and print the ratio next to what we know of the truth.
//
// Usage: node scripts/test_farfield.mjs [capture.jsonl]

import { solveTdoa, farFieldCheck, geodist, C } from "../worker/src/tdoa.js";
import { coastRegistryCheck } from "../worker/src/coast-registry.js";
import fs from "node:fs";

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
const rng = mulberry32(42);

// Channel-like MF cohort (subset of the real english-channel rack).
const COHORT = [
  [50.05, -5.18],   // Cornwall
  [50.74, -2.63],   // Dorset
  [51.29,  0.98],   // Canterbury
  [51.43, -0.73],   // Reading
  [50.48,  4.88],   // Namur BE
  [51.57,  4.78],   // Breda NL
  [49.43,  1.09],   // Rouen FR
];

const CASES = [
  { name: "inside cohort (Solent)",      tx: [50.6, -1.3] },
  { name: "inside cohort (Dover Str)",   tx: [51.0,  1.4] },
  { name: "edge ~200 km (Brest)",        tx: [48.4, -4.5] },
  { name: "near ~400 km (Biscay)",       tx: [47.0, -4.0] },
  { name: "far 750 km (Blåvand DK)",     tx: [55.56, 8.08] },
  { name: "far 1500 km (Civitavecchia)", tx: [42.03, 11.84] },
  { name: "far 2400 km (Greece)",        tx: [38.42, 23.6] },
];

console.log("# Part 1 — synthetic, timing noise σ=0.3 ms (plus 0.5 ms/hop skywave spread on far cases)");
console.log("case                            pointResid  planeResid  ratio   appSpeed/c");
for (const c of CASES) {
  const far = geodist(c.tx, [50.7, 0.0]) / 1000 > 600;
  const dets = COHORT.map((gps) => {
    // Far sources arrive via skywave: per-receiver extra path delay,
    // not shared, ~0.5 ms spread. Near sources: ground wave, 0.3 ms.
    const noise = far ? (rng() - 0.5) * 2 * 0.0005 : (rng() - 0.5) * 2 * 0.0003;
    return { gps, t: geodist(c.tx, gps) / C + noise };
  });
  const t0 = dets[0].t;
  for (const d of dets) d.t -= t0;
  const sol = solveTdoa(dets);
  const ff = farFieldCheck(dets);
  const ratio = ff.planeResidKm / Math.max(0.001, sol.residualKm);
  console.log(
    `${c.name.padEnd(30)}  ${sol.residualKm.toFixed(1).padStart(8)}km  ${ff.planeResidKm.toFixed(1).padStart(8)}km  ${ratio.toFixed(2).padStart(5)}  ${ff.apparentSpeedC.toFixed(2).padStart(8)}`
  );
}

// Part 2 — live capture replay
const path = process.argv[2];
if (path && fs.existsSync(path)) {
  console.log(`\n# Part 2 — live broadcasts from ${path}`);
  console.log("mmsi        regime         q  pointResid  planeResid  ratio  appSp/c  fix              truth");
  const lines = fs.readFileSync(path, "utf8").trim().split("\n");
  for (const line of lines) {
    let b; try { b = JSON.parse(line); } catch { continue; }
    if (!b || !b.receivers || !b.receivers.some((r) => typeof r.dtSec === "number")) continue;
    const dets = b.receivers.map((r) => ({ gps: r.gps, t: r.dtSec }));
    const sol = solveTdoa(dets);
    const ff = farFieldCheck(dets);
    if (!sol || !ff) continue;
    const reg = /^\d{9}$/.test(String(b.mmsi)) ? coastRegistryCheck(b.mmsi, b.position.lat, b.position.lon) : null;
    const truth = reg ? `${reg.name} err=${reg.nearestKm.toFixed(0)}km` : "";
    const ratio = ff.planeResidKm / Math.max(0.001, sol.residualKm);
    console.log(
      `${String(b.mmsi).padEnd(10)}  ${String(b.regime).padEnd(13)} ${String(b.receivers.length).padStart(2)}  ${sol.residualKm.toFixed(1).padStart(8)}km  ${ff.planeResidKm.toFixed(1).padStart(8)}km  ${ratio.toFixed(2).padStart(5)}  ${ff.apparentSpeedC.toFixed(2).padStart(6)}  ${b.position.lat.toFixed(2)},${b.position.lon.toFixed(2)}      ${truth}`
    );
  }
}
