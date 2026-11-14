// capture_burst JSONL → one row per burst with a replica-based arrival
// time for EVERY receiver that recorded it, decoded or not.
//
//   node scripts/burst_toa.mjs captures/nov1.jsonl >> captures/nov1_toa.jsonl
// PATHS=1 adds the multipath decomposition per receiver (slow).
// name the output file (…_toa.jsonl) as an argument to add only new bursts;
// further capture files are FOLLOW slaves of the first:
//   node scripts/burst_toa.mjs captures/nov1b.jsonl captures/nov1w.jsonl captures/nov1b_toa.jsonl >> captures/nov1b_toa.jsonl

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { softBits, bitClock, replica, toa, paths } from "../worker/src/replica.js";

const TB = 0.01, NB = 980;
const i16 = (b) => { const u = Buffer.from(b, "base64"); return new Int16Array(u.buffer, u.byteOffset, u.length >> 1); };
const outFile = process.argv.slice(2).find((f) => f.endsWith("_toa.jsonl"));
const done = new Set(existsSync(outFile ?? "") ? readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
const open = new Map();   // id → { burst, dets, iq }
const get = (id) => open.get(id) ?? open.set(id, { dets: [], iq: [] }).get(id);

// one or more capture files (a master and its FOLLOW slaves), each in
// burst-id order, read as a single id-ordered stream
async function* merged(files) {
  const its = files.map((f) => createInterface({ input: createReadStream(f) })[Symbol.asyncIterator]());
  const head = await Promise.all(its.map((it) => it.next()));
  const idOf = (h) => (h.done ? Infinity : +(/"id":(\d+)/.exec(h.value.slice(0, 40))?.[1] ?? -1));
  for (;;) {
    let k = 0;
    for (let i = 1; i < its.length; i++) if (idOf(head[i]) < idOf(head[k])) k = i;
    if (head[k].done) return;
    yield head[k].value;
    head[k] = await its[k].next();
  }
}
for await (const line of merged(process.argv.slice(2).filter((f) => f !== outFile))) {
  let o;
  const id = /^\{"t":"\w+","id":(\d+)/.exec(line);
  if (!id || done.has(+id[1])) continue;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.t === "det") get(o.id).dets.push(o);
  else if (o.t === "burst") get(o.id).burst = o;
  else if (o.t === "iq") {
    if (!(o.fs > 1900 && o.fs < 2100) || o.clkUs > 5) continue;   // broken gps clock fit
    get(o.id).iq.push({ host: o.host, gps: o.gps, sr: o.sr, t0: o.t0, clkUs: o.clkUs,
      z: { re: Float64Array.from(i16(o.re)), im: Float64Array.from(i16(o.im)), fs: o.fs } });
    for (const [id, b] of open) if (id < o.id - 3) { emit(b); open.delete(id); }
  }
}
for (const b of open.values()) emit(b);

function emit({ burst, dets, iq }) {
  if (!burst || iq.length < 2) return;
  // decoders first, cleanest first; their soft bits vote on the sequence
  const q = (h) => Math.min(...dets.filter((d) => d.host === h).map((d) => d.bad * 10 + d.score), 999);
  const dec = iq.filter((r) => q(r.host) < 999).sort((a, b) => q(a.host) - q(b.host));
  if (!dec.length) return;
  const T0 = Math.max(...iq.map((r) => r.t0)) + 0.02;
  const refClk = dec[0].t0 + bitClock(dec[0].z, NB);
  const E0 = refClk + Math.ceil((T0 - refClk) / TB) * TB;
  const soft = new Float64Array(NB);
  for (const d of dec.slice(0, 10)) {
    const c = d.t0 + bitClock(d.z, NB);
    const e = E0 + ((((c - E0) / TB + 0.5) % 1 + 1) % 1 - 0.5) * TB;
    const s = softBits(d.z, e - d.t0, NB);
    let norm = 0;
    for (const x of s) norm += Math.abs(x);
    for (let k = 0; k < NB; k++) soft[k] += s[k] / norm;
  }
  // burst extent: where the 30-bit mean eye stays above a third of its
  // level in the phasing/message core (2.6 s … 5.6 s into the window)
  const eye = (k) => { let s = 0; for (let j = k; j < k + 30; j++) s += Math.abs(soft[j] ?? 0); return s; };
  const core = [];
  for (let k = 260; k < 560; k += 30) core.push(eye(k));
  const lvl = core.sort((a, b) => a - b)[core.length >> 1] / 3;
  let a = 260, b = 560;
  while (a > 0 && eye(a - 10) > lvl) a -= 10;
  while (b < NB - 30 && eye(b) > lvl) b += 10;
  const rep = replica(Array.from(soft.subarray(a, b), (x) => (x > 0 ? 1 : 0)));
  const tauOf = (r) => E0 + a * TB - r.t0;
  const first = toa(dec[0].z, rep, tauOf(dec[0]), 0.004, 9);   // block DFT aliases every 20 Hz
  const rows = iq.map((r) => {
    const m = r === dec[0] ? first : toa(r.z, rep, tauOf(r) + first.tau - tauOf(dec[0]), 0.008, 1.5, first.cfo);
    return {
      host: r.host, gps: r.gps, sr: Math.round(r.sr), dec: q(r.host) < 999 ? 1 : 0, t: r.t0 + m.tau,
      cfo: +m.cfo.toFixed(3), rho: +m.rho.toFixed(4), pr: +m.pr.toFixed(1), snrDb: +(10 * Math.log10(m.snr)).toFixed(1),
      sigUs: +(m.sigma * 1e6).toFixed(1),
      paths: process.env.PATHS && m.pr > 5 ? paths(r.z, rep, m.tau, m.cfo).map((p) => [+((r.t0 + p.tau) % 1000).toFixed(7), +p.cfo.toFixed(3), Math.round(p.amp), +(10 * Math.log10(p.snr)).toFixed(1), +(p.sigma * 1e6).toFixed(1)]) : [],
      clkUs: r.clkUs, seg: m.seg.map((s) => [Math.round(s.tau * 1e6), +s.amp.toFixed(0), +s.ph.toFixed(2)]),
    };
  });
  const t0 = Math.min(...rows.map((r) => r.t));
  for (const r of rows) { r.t = +(r.t - t0).toFixed(7); for (const p of r.paths) p[0] = +(p[0] - t0 % 1000).toFixed(7); }
  const d0 = dets.find((d) => d.host === dec[0].host);
  console.log(JSON.stringify({ id: burst.id, mmsi: d0.caller, dest: d0.destination, fmt: d0.formatCode, eos: d0.eos,
    wallMs: burst.wallMs, gpsT: t0, bits: b - a, rows }));
}
