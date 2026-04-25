#!/usr/bin/env node
// Post-process a tdoa_watch.mjs JSONL: dedupe by MMSI (keep highest-q
// solve), break down by tier and AIS-plausibility, print a one-screen
// summary. Use to compare runs across deploys.
//
// Usage:  node scripts/tdoa_summary.mjs /tmp/watch-eval.jsonl

import fs from "node:fs";

const path = process.argv[2];
if (!path) { console.error("usage: tdoa_summary.mjs <jsonl>"); process.exit(2); }

const rows = fs.readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
const start = rows.find(r => r.kind === "start");
const end = rows.find(r => r.kind === "end");
const solves = rows.filter(r => r.kind === "solve");

// Group broadcasts by MMSI. Multiple broadcasts of the same MMSI within
// ~5 s are re-solves of the same burst as more receivers arrive — their
// trajectory convergence is a strong self-validation signal: a real
// solve tightens monotonically; a ghost-basin solve wanders.
const broadcasts = new Map();   // mmsi → [solve, ...] sorted by quorum
for (const s of solves) {
  if (!broadcasts.has(s.mmsi)) broadcasts.set(s.mmsi, []);
  broadcasts.get(s.mmsi).push(s);
}
for (const arr of broadcasts.values()) arr.sort((a, b) => a.quorum - b.quorum);

const gcKm = (a, b) => {
  const R = 6371, la1 = a[0]*Math.PI/180, la2 = b[0]*Math.PI/180;
  const dla = la2 - la1, dlo = (b[1]-a[1])*Math.PI/180;
  return 2*R*Math.asin(Math.sqrt(Math.sin(dla/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dlo/2)**2));
};

// Convergence metric: max distance between any two consecutive-q
// broadcasts of the same MMSI. Low = stable solve as receivers
// arrived. High = wandering, suggests the solver is finding different
// basins as the cohort grows.
function convergenceKm(arr) {
  if (arr.length < 2) return null;
  let maxJump = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = gcKm(arr[i-1].tdoa, arr[i].tdoa);
    if (d > maxJump) maxJump = d;
  }
  return maxJump;
}

// Deduplicate by MMSI — keep the broadcast with the highest quorum
// (later re-solves typically tighten the answer).
const byMmsi = new Map();
for (const s of solves) {
  const cur = byMmsi.get(s.mmsi);
  if (!cur || (s.quorum || 0) > (cur.quorum || 0)) byMmsi.set(s.mmsi, s);
}
const distinct = [...byMmsi.values()];
// Attach the convergence metric to each MMSI's chosen broadcast.
for (const s of distinct) {
  const arr = broadcasts.get(s.mmsi) || [];
  s._conv_km = convergenceKm(arr);
  s._n_broadcasts = arr.length;
}

console.log(`# Source: ${path}`);
if (start) console.log(`# Started: ${start.startedAt}, region=${start.region}`);
console.log(`# Total broadcasts: ${solves.length}  Distinct MMSIs solved: ${distinct.length}`);
console.log();

// Tier breakdown
const byTier = {};
for (const s of distinct) {
  const t = s.tier || "(no-tier)";
  byTier[t] = (byTier[t] || 0) + 1;
}
console.log("# Distinct fixes by tier:", byTier);

// AIS resolution outcome
const aisOutcome = {};
for (const s of distinct) {
  const o = s.ais ? "matched" : (s.ais_reason || "no-attempt");
  aisOutcome[o] = (aisOutcome[o] || 0) + 1;
}
console.log("# AIS lookup outcome:", aisOutcome);

// Of matched: distance distribution + plausibility
const matched = distinct.filter(s => s.ais && s.delta_km != null);
if (matched.length) {
  const ds = matched.map(s => s.delta_km).sort((a, b) => a - b);
  const fmt = q => ds[Math.floor(ds.length * q)]?.toFixed(0);
  console.log(`# AIS-matched: ${matched.length}  Δkm  p50=${fmt(0.5)}  p90=${fmt(0.9)}  max=${fmt(0.99)}`);
  // Bucket by plausibility
  const buckets = { "<50km": 0, "50-200": 0, "200-500": 0, "500-2000": 0, ">2000": 0 };
  for (const s of matched) {
    const d = s.delta_km;
    if (d < 50) buckets["<50km"]++;
    else if (d < 200) buckets["50-200"]++;
    else if (d < 500) buckets["200-500"]++;
    else if (d < 2000) buckets["500-2000"]++;
    else buckets[">2000"]++;
  }
  console.log("# Δkm bucket distribution:", buckets);
  // Implied speed — flags physically-impossible TDOAs given fresh AIS
  const fast = matched.filter(s => s.implied_kn != null && s.implied_kn > 60);
  console.log(`# Implausible (>60 kn implied over ais_Δt): ${fast.length}/${matched.length}`);
}

// Residual distribution
console.log();
const residSorted = distinct
  .map(s => s.tdoa_resid_km)
  .filter(Number.isFinite)
  .sort((a, b) => a - b);
if (residSorted.length) {
  const f = q => residSorted[Math.floor(residSorted.length * q)]?.toFixed(0);
  console.log(`# Solver residual_km  p50=${f(0.5)}  p90=${f(0.9)}  max=${f(0.99)}`);
}

// Convergence breakdown across all multi-broadcast MMSIs
const multi = distinct.filter(s => s._n_broadcasts >= 2);
if (multi.length) {
  const convs = multi.map(s => s._conv_km).filter(Number.isFinite).sort((a, b) => a - b);
  const f = q => convs[Math.floor(convs.length * q)]?.toFixed(0);
  console.log();
  console.log(`# Multi-broadcast MMSIs: ${multi.length}/${distinct.length}.  q-trajectory jump km  p50=${f(0.5)} p90=${f(0.9)} max=${f(0.99)}`);
  // Cross-tab: convergence vs AIS-truth
  const stableAccurate = multi.filter(s => s._conv_km < 50 && s.delta_km < 200 && (s.implied_kn ?? 0) < 60).length;
  const stableWrong = multi.filter(s => s._conv_km < 50 && (s.implied_kn ?? 0) > 60).length;
  const wanderingAccurate = multi.filter(s => s._conv_km > 200 && s.delta_km < 200 && (s.implied_kn ?? 0) < 60).length;
  const wanderingWrong = multi.filter(s => s._conv_km > 200 && (s.implied_kn ?? 0) > 60).length;
  console.log(`# Convergence vs AIS truth (multi-broadcast subset):`);
  console.log(`#   stable convergence (<50 km jump) + accurate AIS:    ${stableAccurate}`);
  console.log(`#   stable convergence (<50 km jump) + wrong AIS:       ${stableWrong}`);
  console.log(`#   wandering (>200 km jump) + accurate AIS:            ${wanderingAccurate}`);
  console.log(`#   wandering (>200 km jump) + wrong AIS:               ${wanderingWrong}`);
}

// Detail table
console.log();
console.log("# Per-MMSI detail (highest-q broadcast):");
console.log("  q  n  conv_km  resid_km  Δkm     Δh   speed_kn  mmsi        vessel              tdoa_pos");
for (const s of distinct.sort((a, b) => (a.delta_km ?? 1e9) - (b.delta_km ?? 1e9))) {
  // Only mark as OK when both close-in km AND a plausible implied speed
  // given AIS staleness. A 200 km delta over 30s of stale AIS implies
  // 1300 kn — physically impossible regardless of "small" Δkm.
  const flag = s.delta_km == null ? "       "
             : (s.implied_kn != null && s.implied_kn > 60) ? " ⚠ bad "
             : s.delta_km < 100 ? "  ✓ ok "
             : s.delta_km < 500 ? "  ~ ok "
             : "  …    ";   // far but stale enough to be plausible movement
  console.log(
    `${flag}${String(s.quorum).padStart(2)}  ${String(s._n_broadcasts).padStart(1)}  ` +
    `${String(s._conv_km?.toFixed(0) ?? "-").padStart(6)}  ` +
    `${String(s.tdoa_resid_km?.toFixed(0) ?? "-").padStart(6)}  ` +
    `${String(s.delta_km?.toFixed(0) ?? "-").padStart(5)}  ${String(s.delta_hours?.toFixed(2) ?? "-").padStart(5)}  ` +
    `${String(s.implied_kn?.toFixed(0) ?? "-").padStart(7)}   ` +
    `${String(s.mmsi).padStart(10)}  ${String(s.vessel_name || s.ais_reason || "-").slice(0,18).padEnd(18)}  ` +
    `${s.tdoa[0].toFixed(2)},${s.tdoa[1].toFixed(2)}`,
  );
}

if (end) {
  console.log();
  console.log(`# End: ${end.reason}`);
}
