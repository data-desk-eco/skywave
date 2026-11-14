// capture JSONL → one compact row per burst with a replica-based
// arrival time for every receiver that recorded it. downstream scripts
// (toa_score.mjs) iterate on solvers and truth without re-reading
// gigabytes of IQ.
//
//   node scripts/toa_extract.mjs captures/day1.jsonl > captures/day1_toa.jsonl

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { baseband, softBits, bitClock, replica, toa } from "../worker/src/replica.js";

const TB = 0.01;
const f32 = (b64) => new Float32Array(Buffer.from(b64, "base64").buffer.slice(0));
const compat = (a, b) => a.length === b.length &&
  [...a].every((c, i) => c === "?" || b[i] === "?" || c === b[i]);
const quality = (m) => [...m].filter((c) => c !== "?").length;
const pending = [];

const flush = (nowT) => {
  while (pending.length && nowT - pending[0].dets[0].packetT > 10) emit(pending.shift());
};

for await (const line of createInterface({ input: createReadStream(process.argv[2]) })) {
  if (!line.includes('"t":"det"')) continue;
  const o = JSON.parse(line), a = o.anchors;
  if (!a || a.length < 2) continue;
  let secs = a.map((p) => p.sec + p.nsec / 1e9);
  if (Math.max(...secs) - Math.min(...secs) > 3e5) secs = secs.map((s) => (s < 302400 ? s + 604800 : s));
  const x0 = a[0].abs, t0 = secs[0];
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  secs.forEach((s, k) => { const x = a[k].abs - x0, y = s - t0; sx += x; sy += y; sxx += x * x; sxy += x * y; });
  const n = a.length, slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
  const tAt = (abs) => t0 + icpt + slope * (abs - x0);
  const d = {
    host: o.host, gps: o.gps, sr: 1 / slope, call: o.call, wallMs: o.wallMs, band: o.band ?? "MF",
    packetT: tAt(o.absStart), snipT: tAt(o.snipAbs),
    z: baseband(f32(o.i), f32(o.q), o.sr, ((o.call.markHz ?? 1615) + (o.call.spaceHz ?? 1785)) / 2),
  };
  d.z.fs *= d.sr / o.sr;   // gps-fitted sample rate, not the nominal one
  const mmsi = o.call.caller ?? "?";
  let b = pending.find((b) => Math.abs(d.packetT - b.dets[0].packetT) < 2 && b.band === d.band
    && compat(mmsi, b.mmsi) && !b.dets.some((x) => x.host === d.host));
  if (!b) pending.push(b = { mmsi, band: d.band, dets: [] });
  else if (quality(mmsi) > quality(b.mmsi)) b.mmsi = mmsi;
  b.dets.push(d);
  pending.sort((x, y) => x.dets[0].packetT - y.dets[0].packetT);
  flush(d.packetT);
}
flush(Infinity);

function emit(b) {
  if (b.dets.length < 2) return;
  const ds = [...b.dets].sort((x, y) =>
    (x.call.badSymbols - y.call.badSymbols) || (x.call.phasingScore - y.call.phasingScore));
  // common bit grid on gps time: bit 0 starts at T0 (first whole bit of
  // the latest-starting snippet, on the best receiver's bit clock)
  const ref = ds[0], nb = 380;
  const T0 = Math.max(...ds.map((d) => d.snipT)) + 0.02;
  const refClk = ref.snipT + bitClock(ref.z, nb);
  const E0 = refClk + Math.ceil((T0 - refClk) / TB) * TB;
  const soft = new Float64Array(nb);
  for (const d of ds) {
    // own clock within ±TB/2 of the gps grid (propagation ≪ a bit)
    const c = d.snipT + bitClock(d.z, nb);
    const e = E0 + ((((c - E0) / TB + 0.5) % 1 + 1) % 1 - 0.5) * TB;
    const s = softBits(d.z, e - d.snipT, nb);
    let norm = 0;
    for (const x of s) norm += Math.abs(x);
    d.e = e;
    if (norm > 0) for (let k = 0; k < nb; k++) soft[k] += s[k] / norm;
  }
  const rep = replica(Array.from(soft, (x) => (x > 0 ? 1 : 0)));
  const rows = [];
  for (const d of ds) {
    const r = toa(d.z, rep, d.e - d.snipT);
    rows.push({
      host: d.host, gps: d.gps, t: d.snipT + r.tau, cfo: +r.cfo.toFixed(3), rho: +r.rho.toFixed(3),
      snrDb: +(10 * Math.log10(r.snr)).toFixed(1), sigUs: +(r.sigma * 1e6).toFixed(1),
      bad: d.call.badSymbols, seg: r.seg.map((s) => [+(s.tau * 1e6).toFixed(0), +s.amp.toFixed(4), +s.ph.toFixed(2)]),
    });
  }
  const t0 = Math.min(...rows.map((r) => r.t));
  for (const r of rows) r.t = +(r.t - t0).toFixed(7);
  console.log(JSON.stringify({ mmsi: b.mmsi, band: b.band, wallMs: ds[0].wallMs, gpsT: t0, dest: ref.call.destination, rows }));
}
