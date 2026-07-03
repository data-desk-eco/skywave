// bake this session's captured detections into one static JSON the map
// view can load directly — no live endpoint needed. replays each capture
// through the production coordinator and records BOTH the fixes that
// passed every gate and the suppressed (gate-rejected) ghosts, each with
// position + cohort, plus the receiver rack and AIS truth where known.
//
//   node --max-old-space-size=6144 scripts/build_map_data.mjs
//   → client/detections-data.json

import { createReadStream, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { TDOADO } from "../worker/src/tdoa-do.js";
import { geodist } from "../worker/src/tdoa.js";
import { COAST_REGISTRY } from "../worker/src/coast-registry.js";

const f32 = (b64) => new Float32Array(Buffer.from(b64, "base64").buffer.slice(0));
const CAPTURES = [
  { file: "captures/night1.jsonl", ais: null, label: "channel-mf-night", band: "MF" },
  { file: "captures/day1.jsonl", ais: "captures/day1_ais.jsonl", label: "channel-mf-day", band: "MF" },
  { file: "captures/globalhf1.jsonl", ais: "captures/globalhf1_ais.jsonl", label: "global-hf", band: "HF" },
  { file: "captures/usday1.jsonl", ais: "captures/usday1_ais.jsonl", label: "us-east-mf", band: "MF" },
];

const fixes = [], rejects = [], receivers = new Map();

function loadAis(path) {
  const ais = new Map();
  if (!path || !existsSync(path)) return ais;
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l) continue;
    const o = JSON.parse(l);
    if (!ais.has(o.mmsi)) ais.set(o.mmsi, []);
    ais.get(o.mmsi).push({ t: o.ts ? Date.parse(o.ts) : o.pollMs, lat: o.lat, lon: o.lon, name: o.name });
  }
  for (const v of ais.values()) v.sort((a, b) => a.t - b.t);
  return ais;
}
// nearest AIS point + whether the vessel was stationary across polls
function aisTruth(ais, mmsi, ms) {
  const v = ais.get(mmsi);
  if (!v) return null;
  const la = v.map((p) => p.lat), lo = v.map((p) => p.lon);
  const stationary = Math.max(Math.max(...la) - Math.min(...la), Math.max(...lo) - Math.min(...lo)) * 111 < 2;
  let best = v[0];
  for (const p of v) if (Math.abs(p.t - ms) < Math.abs(best.t - ms)) best = p;
  return { lat: best.lat, lon: best.lon, name: best.name, stationary };
}

for (const cap of CAPTURES) {
  if (!existsSync(cap.file)) { console.error(`skip ${cap.file} (missing)`); continue; }
  const ais = loadAis(cap.ais);
  const coord = new TDOADO({
    getWebSockets: () => [], acceptWebSocket: () => {}, blockConcurrencyWhile: (fn) => fn(),
    storage: { get: async () => null, put: async () => {}, setAlarm: async () => {}, deleteAlarm: async () => {} },
  }, {});
  const seenRej = () => coord.recentRejects.length;
  coord._broadcast = (m) => {
    const t = aisTruth(ais, m.mmsi, m.broadcastMs);
    fixes.push({
      src: cap.label, mmsi: m.mmsi, regime: m.regime, q: m.quorum,
      lat: +m.position.lat.toFixed(3), lon: +m.position.lon.toFixed(3),
      residualKm: +m.position.residualKm.toFixed(1),
      ellipseKm: m.geometry.ellipseSemiMajorKm, ellipseMinorKm: m.geometry.ellipseSemiMinorKm,
      ellipseDeg: m.geometry.ellipseOrientationDeg, farfieldRatio: m.geometry.farfieldRatio,
      receivers: m.receivers.map((r) => ({ slot: r.slot, gps: r.gps })).filter((r) => r.gps),
      name: t?.name || null,
      truth: t ? { lat: +t.lat.toFixed(3), lon: +t.lon.toFixed(3), stationary: t.stationary,
                   errKm: +(geodist([m.position.lat, m.position.lon], [t.lat, t.lon]) / 1000).toFixed(1) } : null,
      ms: m.broadcastMs,
    });
  };

  let nDrained = 0;
  const drainRejects = () => {
    // recentRejects is capped at 100 in the DO; drain after every ingest
    // so nothing is lost on high-reject captures.
    for (const r of coord.recentRejects) {
      const t = aisTruth(ais, r.mmsi, r.broadcastMs);
      rejects.push({
        src: cap.label, mmsi: r.mmsi, gate: r.gate, regime: r.regime, q: r.quorum,
        lat: r.position.lat, lon: r.position.lon, residualKm: r.position.residualKm,
        receivers: r.receivers.map((rc) => ({ slot: rc.slot, gps: rc.gps })),
        name: t?.name || null,
        truth: t ? { lat: +t.lat.toFixed(3), lon: +t.lon.toFixed(3), stationary: t.stationary,
                     errKm: +(geodist([r.position.lat, r.position.lon], [t.lat, t.lon]) / 1000).toFixed(1) } : null,
        ms: r.broadcastMs,
      });
      nDrained++;
    }
    coord.recentRejects.length = 0;
  };

  const reapOld = (nowNs) => {
    for (const [mmsi, list] of coord.buckets) {
      const kept = list.filter((b) => b.dets.some((d) => nowNs - d.packetGpsNs < 30_000_000_000n));
      if (kept.length) coord.buckets.set(mmsi, kept); else coord.buckets.delete(mmsi);
    }
  };

  let nDets = 0;
  for await (const line of createInterface({ input: createReadStream(cap.file) })) {
    if (!line.includes('"t":"det"')) continue;
    const o = JSON.parse(line);
    const a = o.anchors;
    if (!a || a.length < 2) continue;
    receivers.set(o.host, { host: o.host, label: o.label, gps: o.gps, band: o.band ?? cap.band });
    let secs = a.map((p) => p.sec + p.nsec / 1e9);
    if (Math.max(...secs) - Math.min(...secs) > 300000) secs = secs.map((s) => (s < 302400 ? s + 604800 : s));
    const x0 = a[0].abs, t0 = secs[0];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < a.length; k++) { const x = a[k].abs - x0, y = secs[k] - t0; sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const n = a.length, slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
    const tAt = (abs) => t0 + icpt + slope * (abs - x0);
    const rec = {
      receivedMs: Date.now(), slotId: `${o.host}|${o.band ?? cap.band}`, label: o.label,
      band: o.band ?? cap.band, gps: o.gps, call: o.call,
      packetGpsNs: BigInt(Math.round(tAt(o.absStart) * 1e9)),
      snippet: { sampleRate: o.sr, startGpsNs: BigInt(Math.round(tAt(o.snipAbs) * 1e9)), samples: f32(o.i) },
    };
    reapOld(rec.packetGpsNs);
    await coord._ingest(rec);
    drainRejects();
    nDets++;
  }
  console.error(`${cap.label}: ${nDets} dets → ${fixes.filter((f) => f.src === cap.label).length} fixes, ${nDrained} rejects`);
}

const out = {
  generatedMs: Date.now(),
  note: "static snapshot of the 2026-07-02/03 ground-truth campaign, replayed through the production coordinator. fixes = passed every gate; rejects = suppressed ghosts (see .gate). truth from LSEG AIS where known (trust truth.stationary).",
  registry: Object.entries(COAST_REGISTRY).map(([mmsi, e]) => ({ mmsi, name: e.name, sites: e.sites })),
  receivers: [...receivers.values()],
  fixes, rejects,
};
writeFileSync("client/detections-data.json", JSON.stringify(out));
console.error(`\nwrote client/detections-data.json: ${fixes.length} fixes, ${rejects.length} rejects, ${receivers.size} receivers`);
