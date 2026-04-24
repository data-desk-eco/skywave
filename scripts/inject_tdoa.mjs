#!/usr/bin/env node
// Inject a synthetic 3-receiver cohort directly against the deployed
// TDOADO's public subscribe/detect surface, to force the solve path to
// run on the exact code that's live in production. Uses three NW Europe
// KiwiSDR coordinates so the solve has a plausible geometry.
//
// NB: /detect is only routed internally from ReceiverDO in normal use,
// but TDOADO's /subscribe WebSocket is public. We don't have a direct
// public POST path — so this script cannot actually hit /detect from
// outside. Instead it connects to a fake "debug" endpoint we'll add.
//
// Keep script for documentation purposes; the actual injection is done
// via a /v2/tdoa/inject debug route wired into index.js.

import { geodist, C } from "../worker/src/tdoa.js";

const GATEWAY = process.argv[2] || "https://skywave-gateway.louis-6bf.workers.dev";

const receivers = [
  { name: "Chichester", slot: "rx-a:8073", band: "MF", gps: [50.846, -0.662] },
  { name: "Dover",      slot: "rx-b:8073", band: "MF", gps: [51.129,  1.316] },
  { name: "Den Helder", slot: "rx-c:8073", band: "MF", gps: [52.958,  4.760] },
];
const txGps = [52.0, 3.5];
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
  for (let i = 0; i < nSymbols; i++) syms[i] = rng() < 0.5 ? 0 : 1;
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const s = syms[Math.floor(i / sps)];
    phase += 2 * Math.PI * (s ? 1785 : 1615) / HIGH_SR;
    out[i] = Math.sin(phase);
  }
  return out;
}
function captureAt(highBase, arrivalSec, recordStartSec, durSec, noise, rng) {
  const n = Math.ceil(durSec * SR);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = recordStartSec + k / SR - arrivalSec;
    const idx = Math.round(t * HIGH_SR);
    if (idx >= 0 && idx < highBase.length) out[k] = highBase[idx];
    out[k] += (rng() - 0.5) * 2 * noise;
  }
  return out;
}

const rng = mulberry32(42);
const base = makeBurst(200, mulberry32(0xD5C));
const arrivals = receivers.map(r => geodist(r.gps, txGps) / C);
const epochNs = 4n * 86_400n * 1_000_000_000n;
const records = receivers.map((r, i) => {
  const recordStart = arrivals[i] - 0.5;
  const samples = captureAt(base, arrivals[i], recordStart, 2.0, 0.02, rng);
  const startGpsNs = epochNs + BigInt(Math.round(recordStart * 1e9));
  const packetGpsNs = startGpsNs + 500_000_000n;
  return {
    slot: { slot: r.slot, band: r.band, gps: r.gps },
    call: { caller: "999888777" },
    packetGpsNs: packetGpsNs.toString(),
    snippet: {
      sampleRate: SR,
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
  console.log(rec.slot.slot, resp.status, (await resp.text()).slice(0, 120));
}
console.log("done");
