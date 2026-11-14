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
import { arrivals } from "../server/burst.js";

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
  if (!burst) return;
  const q = (h) => Math.min(...dets.filter((d) => d.host === h).map((d) => d.bad * 10 + d.score), 999);
  const rows = arrivals(iq, q, !!process.env.PATHS);
  if (!rows) return;
  const t0 = Math.min(...rows.map((r) => r.t));
  for (const r of rows) { r.t = +(r.t - t0).toFixed(7); for (const p of r.paths) p[0] = +(p[0] - t0).toFixed(7); }
  const d0 = dets.reduce((a, b) => (q(b.host) < q(a.host) ? b : a));
  console.log(JSON.stringify({ id: burst.id, mmsi: d0.caller, dest: d0.destination, fmt: d0.formatCode, eos: d0.eos,
    wallMs: burst.wallMs, gpsT: t0, rows }));
}
