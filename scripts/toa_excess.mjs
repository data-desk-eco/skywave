// night skywave as a statistical correction: with truth known, how much
// of each receiver's delay beyond the geodesic is a smooth function of
// range? fits one effective reflection height h (0 = none) by pooled
// scatter after removing each burst's median.
//   node scripts/toa_excess.mjs toa.jsonl ais.jsonl [main|first|blend]
import { readFileSync } from "node:fs";
import { geodist, C } from "../server/locate.js";
const rd = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const R = 6371, which = process.argv[4] ?? "blend";
const hop = (d, h) => (h ? 2 * Math.sqrt(R * R + (R + h) ** 2 - 2 * R * (R + h) * Math.cos(d / 2 / R)) : d);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };
const ais = new Map();
for (const a of rd(process.argv[3])) (ais.get(a.mmsi) ?? ais.set(a.mmsi, []).get(a.mmsi)).push({ t: Date.parse(a.ts), lat: a.lat, lon: a.lon, kn: a.speedKn });
const bursts = [];
for (const b of rd(process.argv[2])) {
  const s = ais.get(b.mmsi);
  if (!s) continue;
  const n = s.sort((x, y) => Math.abs(x.t - b.wallMs) - Math.abs(y.t - b.wallMs))[0];
  if (Math.abs(n.t - b.wallMs) > 12 * 60e3 || (n.kn ?? 0) > 16) continue;
  const rows = b.rows.filter((r) => r.pr > 8 && r.paths.length).map((r) => {
    const t = which === "blend" ? r.t : which === "first" ? r.paths[0][0] : r.paths.reduce((m, p) => (p[2] > m[2] ? p : m))[0];
    const d = geodist([n.lat, n.lon], r.gps) / 1000;
    return { d, e: (t + (r.sr > 20000 ? 463e-6 : 0)) * 1e6 - d / C * 1e9 };
  });
  if (rows.length >= 8) bursts.push(rows);
}
console.log(`${bursts.length} truth bursts, ${bursts.flat().length} arrivals (${which})`);
for (const h of [0, 60, 100, 140, 180, 220, 260, 300, 350, 400]) {
  const all = [];
  for (const rows of bursts) {
    const r = rows.map((x) => x.e - (hop(x.d, h) - x.d) / C * 1e9), m = med(r);
    for (const x of r) all.push(Math.abs(x - m));
  }
  console.log(`h=${String(h).padStart(3)}  mad=${med(all).toFixed(0)} us  p80=${all.sort((a, b) => a - b)[Math.floor(all.length * .8)].toFixed(0)}`);
}
// binned excess vs range, each burst aligned on its 300–700 km median
const bins = new Map();
for (const rows of bursts) {
  const ref = rows.filter((x) => x.d > 300 && x.d < 700);
  if (ref.length < 3) continue;
  const m = med(ref.map((x) => x.e));
  for (const x of rows) { const k = Math.min(9, Math.floor(x.d / 100)); (bins.get(k) ?? bins.set(k, []).get(k)).push(x.e - m); }
}
for (const [k, v] of [...bins].sort((a, b) => a[0] - b[0])) console.log(`${k * 100}-${k * 100 + 100} km  n=${String(v.length).padStart(4)}  median=${med(v).toFixed(0).padStart(6)}  iqr=${(v.sort((a, b) => a - b)[Math.floor(v.length * .75)] - v[Math.floor(v.length * .25)]).toFixed(0)}`);
