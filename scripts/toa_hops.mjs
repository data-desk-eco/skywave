// exploratory: does a hop model (ground, 1E, 1F, 2F with free layer
// heights) explain the resolved path delays at the TRUE position
// better than at displaced positions? prints the match score at truth
// and at offsets.   node scripts/toa_hops.mjs toa.jsonl ais.jsonl
import { readFileSync } from "node:fs";
import { geodist, C } from "../worker/src/tdoa.js";
const rd = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const R = 6371, SIG = 60e-6;
const hop = (d, h, n) => n * 2 * Math.sqrt(R * R + (R + h) ** 2 - 2 * R * (R + h) * Math.cos(d / n / 2 / R));
const ais = new Map();
for (const a of rd(process.argv[3])) (ais.get(a.mmsi) ?? ais.set(a.mmsi, []).get(a.mmsi)).push({ t: Date.parse(a.ts), lat: a.lat, lon: a.lon, name: a.name });
export function score(obs, p) {
  let best = { s: -1 };
  const d = obs.map((o) => geodist(p, o.gps) / 1000);
  for (let hE = 90; hE <= 115; hE += 5) for (let hF = 200; hF <= 380; hF += 15) {
    const pred = d.map((x) => [x, hop(x, hE, 1), hop(x, hF, 1), hop(x, hF, 2)].map((y) => y / C * 1e3));
    // candidate t0: every (path, mode) pairing
    const cand = [];
    obs.forEach((o, i) => { for (const t of o.ts) for (const q of pred[i]) cand.push(t - q); });
    cand.sort((a, b) => a - b);
    for (let c = 0; c < cand.length; c += 2) {
      const t0 = cand[c];
      let s = 0;
      obs.forEach((o, i) => {
        let m = 0;
        for (const t of o.ts) for (const q of pred[i]) { const u = (t - t0 - q) / SIG; if (u * u < 9) m = Math.max(m, Math.exp(-u * u / 2)); }
        s += m;
      });
      if (s > best.s) best = { s, t0, hE, hF };
    }
  }
  return best;
}
for (const b of rd(process.argv[2])) {
  const s = ais.get(b.mmsi);
  if (!s) continue;
  const n = s.sort((x, y) => Math.abs(x.t - b.wallMs) - Math.abs(y.t - b.wallMs))[0];
  if (Math.abs(n.t - b.wallMs) > 20 * 60e3) continue;
  const obs = b.rows.filter((r) => r.pr > 6 && r.paths.length).map((r) => {
    const mx = Math.max(...r.paths.map((p) => p[2]));
    return { gps: r.gps, ts: r.paths.filter((p) => p[2] >= 0.4 * mx).slice(0, 2).map((p) => p[0] - (r.sr > 20000 ? -463e-6 : 0)) };
  });
  if (obs.length < 8) continue;
  const at = (dn, de) => score(obs, [n.lat + dn / 111.2, n.lon + de / 111.2 / Math.cos(n.lat * Math.PI / 180)]);
  const t = at(0, 0), ring = (r) => [[r, 0], [-r, 0], [0, r], [0, -r], [r * .7, r * .7], [-r * .7, r * .7], [r * .7, -r * .7], [-r * .7, -r * .7]].map(([a, c]) => at(a, c).s.toFixed(1)).join(" ");
  console.log(`#${b.id} ${n.name} q=${obs.length} truth s=${t.s.toFixed(1)} hE=${t.hE} hF=${t.hF} | 40km: ${ring(40)} | 120km: ${ring(120)}`);
}
