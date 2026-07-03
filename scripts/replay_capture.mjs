// replay a capture_iq.mjs JSONL through the PRODUCTION coordinator —
// real detections, real estimator, real gate stack — and score every
// broadcast against registry truth where available.
//
//   node scripts/replay_capture.mjs captures/day1.jsonl

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { TDOADO } from "../worker/src/tdoa-do.js";
import { geodist } from "../worker/src/tdoa.js";
import { COAST_REGISTRY } from "../worker/src/coast-registry.js";

const file = process.argv[2];
const f32 = (b64) => new Float32Array(Buffer.from(b64, "base64").buffer.slice(0));

const coord = new TDOADO({
  getWebSockets: () => [],
  acceptWebSocket: () => {},
  blockConcurrencyWhile: (fn) => fn(),
  storage: { get: async () => null, put: async () => {}, setAlarm: async () => {}, deleteAlarm: async () => {} },
}, {});
const fixes = [];
coord._broadcast = (m) => fixes.push(m);
let nDets = 0;
// reap by GPS time, not wall time — replay compresses hours into seconds
const reapOld = (nowNs) => {
  for (const [mmsi, list] of coord.buckets) {
    const kept = list.filter((b) => b.dets.some((d) => nowNs - d.packetGpsNs < 30_000_000_000n));
    if (kept.length) coord.buckets.set(mmsi, kept);
    else coord.buckets.delete(mmsi);
  }
};
for await (const line of createInterface({ input: createReadStream(file) })) {
  if (!line.includes('"t":"det"')) continue;
  const o = JSON.parse(line);
  const a = o.anchors;
  if (!a || a.length < 2) continue;
  let secs = a.map((p) => p.sec + p.nsec / 1e9);
  if (Math.max(...secs) - Math.min(...secs) > 300000) {
    secs = secs.map((s) => (s < 302400 ? s + 604800 : s));
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
  nDets++;
  const rec = {
      receivedMs: Date.now(),

      slotId: `${o.host}|${o.band ?? "MF"}`,
      label: o.label,
      band: o.band ?? "MF",
      gps: o.gps,
      call: o.call,
      packetGpsNs: BigInt(Math.round(tAt(o.absStart) * 1e9)),
      snippet: {
        sampleRate: o.sr,
        startGpsNs: BigInt(Math.round(tAt(o.snipAbs) * 1e9)),
        samples: f32(o.i),
      },
  };
  reapOld(rec.packetGpsNs);
  await coord._ingest(rec);
}
console.log(`${nDets} detections`);

console.log(`\nrejections: ${JSON.stringify(coord.rejections)}`);
console.log(`${fixes.length} broadcasts:`);
for (const m of fixes) {
  const entry = COAST_REGISTRY[m.mmsi];
  let errKm = null;
  if (entry) {
    errKm = Math.min(...entry.sites.map((s) =>
      geodist(s, [m.position.lat, m.position.lon]) / 1000));
  }
  console.log(JSON.stringify({
    atS: Math.round(Number(BigInt(m.packetGpsNs) / 1000000n)) / 1000,
    mmsi: m.mmsi, name: entry?.name, q: m.quorum, regime: m.regime,
    lat: +m.position.lat.toFixed(3), lon: +m.position.lon.toFixed(3),
    residKm: +m.position.residualKm.toFixed(1),
    ellipseKm: m.geometry.ellipseSemiMajorKm,
    ff: m.geometry.farfieldRatio,
    peakRatios: m.receivers.map((r) => r.peakRatio),
    errKm: errKm != null ? +errKm.toFixed(1) : null,
  }));
}
