// join replay_capture.mjs output with ais_watch.mjs snapshots: score
// every broadcast (AIS interpolated to fix time) and every rejected
// attempt (nearest AIS poll — good enough to call ghost vs real at the
// 100 km scale that matters).
//
//   node scripts/score_replay.mjs captures/day1_replay.txt captures/day1_ais.jsonl

import { readFileSync } from "node:fs";
import { geodist } from "../worker/src/tdoa.js";

const [replayFile, aisFile] = process.argv.slice(2);
const GPS_WEEK_START = Date.UTC(2026, 5, 28) / 1000;   // sun 2026-06-28, gps-utc = 18 s
const wallOfGps = (s) => (GPS_WEEK_START + s - 18) * 1000;

const ais = new Map();   // mmsi → [{t, lat, lon, name}] sorted
for (const l of readFileSync(aisFile, "utf8").split("\n")) {
  if (!l) continue;
  const o = JSON.parse(l);
  const t = o.ts ? Date.parse(o.ts) : o.pollMs;
  if (!ais.has(o.mmsi)) ais.set(o.mmsi, []);
  ais.get(o.mmsi).push({ t, lat: o.lat, lon: o.lon, name: o.name });
}
for (const v of ais.values()) v.sort((a, b) => a.t - b.t);

const spanKm = (v) => {
  const la = v.map((p) => p.lat), lo = v.map((p) => p.lon);
  return Math.max(Math.max(...la) - Math.min(...la), Math.max(...lo) - Math.min(...lo)) * 111;
};
const at = (mmsi, ms) => {
  const v = ais.get(mmsi);
  if (!v) return null;
  let lo = null, hi = null;
  for (const p of v) {
    if (p.t <= ms) lo = p;
    else { hi = p; break; }
  }
  if (lo && hi) {
    const f = (ms - lo.t) / (hi.t - lo.t);
    return { lat: lo.lat + f * (hi.lat - lo.lat), lon: lo.lon + f * (hi.lon - lo.lon), name: lo.name, exact: true, stationary: spanKm(v) < 2 };
  }
  const n = lo ?? hi;
  return Math.abs(n.t - ms) < 45 * 60000 ? { ...n, exact: false, stationary: spanKm(v) < 2 } : null;
};

const bStats = [], rStats = {};
for (const l of readFileSync(replayFile, "utf8").split("\n")) {
  if (l.startsWith("{")) {
    const o = JSON.parse(l);
    const truth = at(o.mmsi, wallOfGps(+o.atS));
    const err = truth ? geodist([o.lat, o.lon], [truth.lat, truth.lon]) / 1000 : null;
    bStats.push({ ...o, name: o.name ?? truth?.name, aisErrKm: err != null ? +err.toFixed(1) : null, stationary: truth?.stationary ?? null });
  } else if (l.startsWith("tdoa/reject:")) {
    const m = /gate=(\S+) mmsi=(\S+) q=(\d+) pos=([\d.-]+),([\d.-]+) resid=(\d+)/.exec(l);
    if (!m) continue;
    const [, gate, mmsi, q, la, lo_, resid] = m;
    const v = ais.get(mmsi);
    let err = null, st = null;
    if (v) { err = Math.min(...v.map((p) => geodist([+la, +lo_], [p.lat, p.lon]) / 1000)); st = spanKm(v) < 2; }
    (rStats[gate] ??= []).push({ mmsi, q: +q, resid: +resid, errKm: err != null ? +err.toFixed(0) : null, st });
  }
}

console.log("=== broadcasts (would have gone out) ===");
for (const b of bStats) console.log(JSON.stringify(b));
console.log("\n=== rejected attempts with AIS truth ===");
for (const [gate, rows] of Object.entries(rStats)) {
  const withT = rows.filter((r) => r.errKm != null);
  const real = withT.filter((r) => r.errKm < 100).length;
  console.log(`${gate}: ${rows.length} rejects, ${withT.length} with truth — ${real} were <100 km (over-rejected), ${withT.length - real} were ghosts`);
  for (const r of withT.sort((a, b) => a.errKm - b.errKm).slice(0, 8)) console.log(`   ${JSON.stringify(r)}`);
}
