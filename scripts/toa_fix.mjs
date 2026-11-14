// solve every burst in a toa_extract file with locate.js and, where
// truth exists, score it. bias table: {host: biasUs} json.
//
//   node scripts/toa_fix.mjs captures/day1_toa.jsonl --ais captures/day1_ais.jsonl --bias captures/bias.json [--minq 4] [--floor 15]
import { readFileSync } from "node:fs";
import { locate } from "../worker/src/locate.js";
import { geodist } from "../worker/src/tdoa.js";
import { COAST_REGISTRY } from "../worker/src/coast-registry.js";
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const rd = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const bias = opt("--bias") ? JSON.parse(readFileSync(opt("--bias"), "utf8")) : {};
const minPr = +opt("--pr", 6), floor = +opt("--floor", 15) * 1e-6, minq = +opt("--minq", 4), skip = +opt("--skip", 0);
const ais = new Map();
for (const a of opt("--ais") ? rd(opt("--ais")) : []) {
  const s = ais.get(a.mmsi) ?? ais.set(a.mmsi, []).get(a.mmsi), t = Date.parse(a.ts);
  if (!s.some((p) => p.t === t)) s.push({ t, lat: a.lat, lon: a.lon, name: a.name });
}
for (const s of ais.values()) s.sort((a, b) => a.t - b.t);
const truthAt = (mmsi, t) => {
  const reg = COAST_REGISTRY[mmsi];
  if (reg) return reg.sites.length === 1 ? { pos: reg.sites[0], name: reg.name, kind: "coast" } : null;
  const s = ais.get(mmsi);
  if (!s) return null;
  const i = s.findIndex((p) => p.t >= t), a = i < 0 ? s.at(-1) : s[i - 1], b = s[i];
  if (a && b && b.t - a.t < 40 * 60e3) {
    const f = (t - a.t) / (b.t - a.t || 1);
    return { pos: [a.lat + f * (b.lat - a.lat), a.lon + f * (b.lon - a.lon)], name: a.name, kind: "ais" };
  }
  const n = [a, b].filter(Boolean).sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t))[0];
  return n && Math.abs(n.t - t) < 10 * 60e3 ? { pos: [n.lat, n.lon], name: n.name, kind: "ais" } : null;
};
// --h N: two-mode model at fixed E height; --h fit: height fitted per solve
const hOpt = opt("--h"), prop = hOpt === "fit" ? { hs: [0, 90, 100, 110, 120, 130, 140] } : hOpt ? { h: +hOpt } : {};
const far = +opt("--far", 0), half = opt("--half"), fuseMin = +opt("--fuse", 0);
const mk = (b, k) => b.rows.filter((r) => (r.pr ? r.pr > minPr : r.rho > 0.3) && (!opt("--known") || r.host in bias)).map((r) => ({
  // 20.25 kHz-mode kiwis stamp ~463 us early unless individually calibrated
  gps: r.gps, host: r.host, k, t: (opt("--first") && r.paths?.length ? r.paths[0][0] : r.t) - (bias[r.host] ?? (r.sr > 20000 ? -463 : 0)) * 1e-6,
  sigma: Math.hypot(r.sigUs * 1e-6, floor),
}));
const all = rd(args[0]).filter((b) => /^\d{9}$/.test(b.mmsi) && (!half || (+b.mmsi % 2 === 0) === (half === "a")));
// --fuse M: bursts of one mmsi within M minutes are solved as one position
const sets = [];
for (const b of all) {
  const s = fuseMin && sets.findLast((s) => s[0].mmsi === b.mmsi && b.wallMs - s[0].wallMs < fuseMin * 60e3);
  if (s) s.push(b); else sets.push([b]);
}
for (const s of sets) {
  const obs = s.flatMap((b, k) => { const o = mk(b, k); return o.length >= minq ? o : []; });
  if (!obs.length) continue;
  let f = locate(obs, { ...prop, late: !!opt("--late") });
  // --far KM (night): re-solve on receivers at least KM from the first fix,
  // where one hop dominates and delays are far more consistent
  if (f && far) {
    const o2 = obs.filter((o) => geodist([f.lat, f.lon], o.gps) / 1000 >= far);
    const ok = new Set(o2.map((o) => o.k)).size === new Set(obs.map((o) => o.k)).size && o2.length >= minq;
    if (!ok) continue;
    obs.length = 0; obs.push(...o2);
    f = locate(obs, { ...prop, late: !!opt("--late") });
  }
  if (!f) continue;
  const b = s[Math.floor(s.length / 2)], tr = truthAt(b.mmsi, b.wallMs);
  console.log(JSON.stringify({
    mmsi: b.mmsi, name: tr?.name, kind: tr?.kind, utc: new Date(b.wallMs).toISOString().slice(5, 16), q: obs.length, bursts: new Set(obs.map((o) => o.k)).size,
    lat: +f.lat.toFixed(4), lon: +f.lon.toFixed(4), smaj: +f.semiMajorKm.toFixed(1), smin: +f.semiMinorKm.toFixed(1),
    chi2: +f.chi2.toFixed(1), h: f.h, nEff: +f.nEff.toFixed(1), id: b.id, tLat: tr?.pos[0], tLon: tr?.pos[1],
    errKm: tr ? +(geodist([f.lat, f.lon], tr.pos) / 1000).toFixed(1) : null,
    resUs: f.res.map((r) => Math.round(r * 1e6)), km: obs.map((o) => Math.round(geodist([f.lat, f.lon], o.gps) / 1000)),
    hosts: opt("--hosts") ? obs.map((o) => o.host) : undefined,
  }));
}
