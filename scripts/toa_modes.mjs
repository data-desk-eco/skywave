// exploratory: per-receiver excess delay over the geodesic at TRUTH,
// next to what 1-hop E / F reflections would add at that range.
//   node scripts/toa_modes.mjs captures/nov1_toa.jsonl captures/nov1_ais.jsonl
import { readFileSync } from "node:fs";
import { geodist, C } from "../server/locate.js";
const rd = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const R = 6371;
const hop = (dKm, h, n = 1) => n * 2 * Math.sqrt(R * R + (R + h) ** 2 - 2 * R * (R + h) * Math.cos(dKm / n / 2 / R));
const ais = new Map();
for (const a of rd(process.argv[3])) (ais.get(a.mmsi) ?? ais.set(a.mmsi, []).get(a.mmsi)).push({ t: Date.parse(a.ts), lat: a.lat, lon: a.lon, name: a.name, kn: a.speedKn });
for (const b of rd(process.argv[2])) {
  const s = ais.get(b.mmsi);
  if (!s) continue;
  const n = s.sort((x, y) => Math.abs(x.t - b.wallMs) - Math.abs(y.t - b.wallMs))[0];
  if (Math.abs(n.t - b.wallMs) > 20 * 60e3) continue;
  const rows = b.rows.filter((r) => r.pr > 6 && r.paths.length).map((r) => {
    const d = geodist([n.lat, n.lon], r.gps) / 1000, bias = r.sr > 20000 ? -463 : 0;
    const main = r.paths.reduce((m, p) => (p[2] > m[2] ? p : m));
    return { d, e1: r.paths[0][0] * 1e6 - bias - d / C * 1e9, em: main[0] * 1e6 - bias - d / C * 1e9, np: r.paths.length, snr: r.paths[0][3], host: r.host };
  }).sort((a, b) => a.d - b.d);
  const e0 = [...rows.map((r) => r.e1)].sort((a, b) => a - b)[Math.floor(rows.length / 4)];
  console.log(`\n#${b.id} ${b.mmsi} ${n.name} ${new Date(b.wallMs).toISOString().slice(11, 16)} truth ${n.lat.toFixed(2)},${n.lon.toFixed(2)} kn=${n.kn} ageMin=${((b.wallMs - n.t) / 60e3).toFixed(0)}`);
  for (const r of rows) console.log(`  ${r.d.toFixed(0).padStart(5)} km  first=${(r.e1 - e0).toFixed(0).padStart(6)}  main=${(r.em - e0).toFixed(0).padStart(6)}  n=${r.np} snr1=${String(r.snr).padStart(6)}  ${r.host.slice(0, 22)}`);
}
