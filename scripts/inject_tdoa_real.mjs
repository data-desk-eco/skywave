#!/usr/bin/env node
// Harder synthetic test: inject 3 receivers with slightly different
// sample rates (11998 / 12000 / 12001 Hz, like real Kiwis) and slightly
// offset startGpsNs anchors (like real clipping-adjacent snippets).
// This stresses the SR-tolerance + spread checks and proves the fixes
// hold against production-like conditions before we burn another 25 min
// waiting for traffic.

import { geodist, C } from "../worker/src/tdoa.js";

const GATEWAY = process.argv[2] || "https://skywave-gateway.louis-6bf.workers.dev";
const receivers = [
  { slot: "rx-real-a:8073", band: "HF8", gps: [50.846, -0.662], sr: 11998.5 },
  { slot: "rx-real-b:8073", band: "HF8", gps: [51.129,  1.316], sr: 12000.1 },
  { slot: "rx-real-c:8073", band: "HF8", gps: [52.958,  4.760], sr: 12001.7 },
];
const txGps = [52.0, 3.5];
const OVERSAMPLE = 8;

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
function makeBurst(highSR, nSymbols, rng) {
  const sps = highSR / 100;
  const total = Math.floor(sps * nSymbols);
  const out = new Float32Array(total);
  const syms = new Uint8Array(nSymbols);
  for (let i = 0; i < nSymbols; i++) syms[i] = rng() < 0.5 ? 0 : 1;
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const s = syms[Math.floor(i / sps)];
    phase += 2 * Math.PI * (s ? 1785 : 1615) / highSR;
    out[i] = Math.sin(phase);
  }
  return out;
}
// Nearest-neighbour decimation to any target SR
function decimate(highBase, highSR, arrivalSec, recordStartSec, durSec, targetSR, noise, rng) {
  const n = Math.ceil(durSec * targetSR);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = recordStartSec + k / targetSR - arrivalSec;
    const idx = Math.round(t * highSR);
    if (idx >= 0 && idx < highBase.length) out[k] = highBase[idx];
    out[k] += (rng() - 0.5) * 2 * noise;
  }
  return out;
}

const highSR = 100_000;  // high-rate source for resampling
const rng = mulberry32(7);
const base = makeBurst(highSR, 400, mulberry32(0xDEAD));  // 4s of burst
const arrivals = receivers.map(r => geodist(r.gps, txGps) / C);
const epochNs = 5n * 86_400n * 1_000_000_000n;

const records = receivers.map((r, i) => {
  // Each receiver picks its own snippet window with slight jitter
  const recordStart = arrivals[i] - 0.5 + (rng() - 0.5) * 0.2;   // ±100 ms
  const samples = decimate(base, highSR, arrivals[i], recordStart, 2.0, r.sr, 0.03, rng);
  const startGpsNs = epochNs + BigInt(Math.round(recordStart * 1e9));
  const packetGpsNs = startGpsNs + 500_000_000n;
  return {
    slot: { slot: r.slot, band: r.band, gps: r.gps },
    call: { caller: "777555333" },
    packetGpsNs: packetGpsNs.toString(),
    snippet: {
      sampleRate: r.sr,
      startGpsNs: startGpsNs.toString(),
      samples: Array.from(samples),
    },
  };
});

for (const rec of records) {
  const resp = await fetch(`${GATEWAY}/v2/tdoa/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rec),
  });
  console.log(rec.slot.slot, `sr=${rec.snippet.sampleRate}`, resp.status, (await resp.text()).slice(0, 120));
}
console.log("done");
