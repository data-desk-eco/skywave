// joins toa_extract rows with truth (ais_watch snapshots for vessels,
// coast registry for stations) and emits one row per (burst, receiver)
// with the timing residual against geodesic truth:
//   resUs = t_i − d_i/c − median_j(t_j − d_j/c)
//
//   node scripts/toa_score.mjs captures/day1_toa.jsonl captures/day1_ais.jsonl [hKm] > captures/day1_res.jsonl

import { readFileSync } from "node:fs";
import { geodist } from "../worker/src/tdoa.js";
import { reduce } from "../worker/src/locate.js";
import { COAST_REGISTRY } from "../worker/src/coast-registry.js";

const [toaFile, aisFile, h = 0] = process.argv.slice(2);   // h: E-layer height for the two-mode model (0 = ground wave only)
const rd = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ais = new Map();
for (const a of aisFile ? rd(aisFile) : []) {
  const t = Date.parse(a.ts);
  if (!ais.has(a.mmsi)) ais.set(a.mmsi, []);
  const s = ais.get(a.mmsi);
  if (!s.some((p) => p.t === t)) s.push({ t, lat: a.lat, lon: a.lon, name: a.name });
}
for (const s of ais.values()) s.sort((a, b) => a.t - b.t);

// truth at time t: interpolate between bracketing fixes ≤ 40 min apart,
// or take a fix within 10 min; `mob` = km moved across the bracket
function truthAt(mmsi, t) {
  const reg = COAST_REGISTRY[mmsi];
  if (reg) return reg.sites.length === 1 ? { pos: reg.sites[0], kind: "coast", name: reg.name, mob: 0 } : null;
  const s = ais.get(mmsi);
  if (!s) return null;
  const i = s.findIndex((p) => p.t >= t), a = i < 0 ? s.at(-1) : s[i - 1], b = s[i];
  if (a && b && b.t - a.t < 40 * 60e3) {
    const f = (t - a.t) / (b.t - a.t || 1);
    return { pos: [a.lat + f * (b.lat - a.lat), a.lon + f * (b.lon - a.lon)], kind: "ais", name: a.name,
      mob: geodist([a.lat, a.lon], [b.lat, b.lon]) / 1000 };
  }
  const n = [a, b].filter(Boolean).sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t))[0];
  if (n && Math.abs(n.t - t) < 10 * 60e3) return { pos: [n.lat, n.lon], kind: "ais1", name: n.name, mob: Math.abs(n.t - t) / 60e3 };
  return null;
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };
rd(toaFile).forEach((b, id) => {
  const tr = truthAt(b.mmsi, b.wallMs);
  if (!tr) return;
  const rows = b.rows.filter((r) => (r.pr ? r.pr > 6 : true));   // burst captures: detected receivers only
  if (rows.length < 2) return;
  const D = rows.map((r) => geodist(tr.pos, r.gps) / 1000);
  const e = reduce(rows, D, [rows.map((_, i) => i)], { h: +h }), m = med(e);
  rows.forEach((r, k) => console.log(JSON.stringify({
    id, mmsi: b.mmsi, name: tr.name, kind: tr.kind, mob: +tr.mob.toFixed(2), utc: new Date(b.wallMs).toISOString().slice(11, 16),
    q: rows.length, sr: r.sr, dec: r.dec, host: r.host, km: Math.round(geodist(tr.pos, r.gps) / 1000), resUs: Math.round((e[k] - m) * 1e6),
    snrDb: r.snrDb, sigUs: r.sigUs, rho: r.rho, cfo: r.cfo, seg: r.seg, lat: tr.pos[0], lon: tr.pos[1],
  })));
});
