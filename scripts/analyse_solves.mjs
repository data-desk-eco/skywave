#!/usr/bin/env node
// Offline analyser for tdoa_watch.mjs JSONL captures.
//
// For each solve where at least one receiver is in our cohort:
//  1. Look up the MMSI in GFW (free, public). For vessels: get
//     vesselId → tracks → lastPos. Compute Δkm to TDOA fix.
//  2. Coast stations (MID-prefix patterns 00xxxxxxx + 0-tail) get
//     compared to a hardcoded fixed-position table — no AIS needed,
//     they don't move.
//  3. Compute implied speed: ship-speed plausibility check absorbs
//     stale GFW data. >60 kn implied = ⚠ implausible; below = ✓.
//
// Usage: node scripts/analyse_solves.mjs <jsonl> [--cohort host1,host2,...]
//
// Defaults to the English Channel cohort if no --cohort is given.

import fs from "node:fs";

const args = process.argv.slice(2);
const path = args[0];
if (!path) { console.error("usage: analyse_solves.mjs <jsonl> [--region english-channel] [--cohort h1,h2,...]"); process.exit(2); }
const GATEWAY = process.env.SKYWAVE_GATEWAY || "https://skywave-gateway.louis-6bf.workers.dev";
const cohortArg = args.indexOf("--cohort");
const regionArg = args.indexOf("--region");
const REGION = regionArg >= 0 ? args[regionArg + 1] : "english-channel";
let COHORT_HOSTS;
if (cohortArg >= 0) {
  COHORT_HOSTS = args[cohortArg + 1].split(",");
} else {
  // Live-fetch the cohort for the named region — keeps the analyser in
  // sync with whatever pickTargetRack is currently serving.
  const rackR = await fetch(`${GATEWAY}/v2/rack?region=${encodeURIComponent(REGION)}`);
  const rack = await rackR.json();
  COHORT_HOSTS = [...new Set((rack.slots || []).map((s) => s.host))];
  console.error(`# Live cohort for ${REGION}: ${COHORT_HOSTS.length} hosts`);
}

// Maritime coast stations in the English Channel area. ITU MID prefixes:
//  002 = international coast station, 232 = UK MCA, 227 = France CROSS,
//  244 = Netherlands. These broadcast scheduled DSC tests on MF; their
//  position is fixed, so they're cleaner ground truth than vessel AIS.
const COAST_STATIONS = {
  "002320011": { name: "Solent CG / Niton",    gps: [50.585, -1.296] },
  "002320014": { name: "Falmouth CG",          gps: [50.150, -5.066] },
  "002320006": { name: "Humber CG",            gps: [53.319,  0.155] },
  "002320012": { name: "Holyhead CG",          gps: [53.318, -4.629] },
  "002320018": { name: "Belfast CG",           gps: [54.717, -5.704] },
  "002442000": { name: "Den Helder MRCC",      gps: [52.958,  4.760] },
  "002275100": { name: "CROSS Gris-Nez",       gps: [50.870,  1.590] },
  "002275200": { name: "CROSS Jobourg",        gps: [49.680, -1.930] },
  "002275300": { name: "CROSS Corsen",         gps: [48.430, -4.780] },
  "002275400": { name: "CROSS Étel",           gps: [47.660, -3.210] },
  "002241022": { name: "Coruña Radio",         gps: [43.370, -8.420] },
};

function gcKm(a, b) {
  const R = 6371, la1 = a[0]*Math.PI/180, la2 = b[0]*Math.PI/180;
  const dla = la2-la1, dlo = (b[1]-a[1])*Math.PI/180;
  return 2*R*Math.asin(Math.sqrt(
    Math.sin(dla/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dlo/2)**2));
}

const gfwIdCache = new Map();
async function gfwVesselId(mmsi) {
  if (gfwIdCache.has(mmsi)) return gfwIdCache.get(mmsi);
  if (!/^\d{9}$/.test(mmsi)) { gfwIdCache.set(mmsi, null); return null; }
  try {
    const r = await fetch(`${GATEWAY}/gfw?query=${mmsi}`);
    if (!r.ok) { gfwIdCache.set(mmsi, null); return null; }
    const j = await r.json();
    const mmsiInt = parseInt(mmsi, 10);
    for (const e of j.entries || []) {
      for (const si of e.selfReportedInfo || []) {
        if (parseInt(si.ssvid, 10) !== mmsiInt) continue;
        const id = si.id || (e.combinedSourcesInfo && e.combinedSourcesInfo[0] && e.combinedSourcesInfo[0].vesselId);
        const result = { id, name: si.shipname, flag: si.flag, imo: si.imo };
        gfwIdCache.set(mmsi, result);
        return result;
      }
    }
  } catch {}
  gfwIdCache.set(mmsi, null);
  return null;
}

async function gfwLastPos(vesselId) {
  if (!vesselId) return null;
  try {
    const r = await fetch(`${GATEWAY}/gfw/tracks?vesselId=${vesselId}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.lastPos;
  } catch { return null; }
}

const rows = fs.readFileSync(path, "utf8").trim().split("\n").map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const solves = rows.filter((r) => r.kind === "solve");

// Filter: at least one cohort host must have heard the burst.
function hostFromSlot(slot) { return String(slot || "").split("|")[0].split(":")[0]; }
const ours = solves.filter((s) => {
  const hosts = (s.heard_by || s.receivers || []).map((r) => hostFromSlot(r.slot || r));
  return hosts.some((h) => COHORT_HOSTS.includes(h));
});

console.log(`# Source: ${path}`);
console.log(`# Total solves: ${solves.length}   In our cohort: ${ours.length}`);
console.log();

// Group by mmsi, keep highest-quorum broadcast per MMSI.
const byMmsi = new Map();
for (const s of ours) {
  const cur = byMmsi.get(s.mmsi);
  if (!cur || (s.quorum || 0) > (cur.quorum || 0)) byMmsi.set(s.mmsi, s);
}
const distinct = [...byMmsi.values()];
console.log(`# Distinct MMSIs: ${distinct.length}`);
console.log();

const rowsOut = [];
for (const s of distinct) {
  const mmsi = String(s.mmsi || "");
  const tdoa = s.tdoa;
  const cs = COAST_STATIONS[mmsi];
  let label = "(unknown)", deltaKm = null, deltaH = null, impliedKn = null, kind = "";
  if (cs) {
    deltaKm = gcKm(tdoa, cs.gps);
    label = cs.name;
    kind = "coast";
  } else if (/^\d{9}$/.test(mmsi)) {
    const id = await gfwVesselId(mmsi);
    if (id) {
      label = `${id.name || "?"} (${id.flag || "??"})`;
      const lp = await gfwLastPos(id.id);
      if (lp) {
        deltaKm = gcKm(tdoa, [lp.lat, lp.lon]);
        const tsMs = typeof lp.ts === "number" ? lp.ts : lp.ts ? Date.parse(lp.ts) : NaN;
        if (Number.isFinite(tsMs)) {
          deltaH = (Date.now() - tsMs) / 3600000;
          impliedKn = deltaH > 0 ? deltaKm / deltaH / 1.852 : null;
        }
        kind = "vessel-stale";
      } else {
        kind = "vessel-no-pos";
      }
    } else {
      kind = "vessel-not-in-gfw";
    }
  } else {
    kind = "non-numeric-mmsi";
  }
  rowsOut.push({ mmsi, tdoa, label, kind, q: s.quorum, resid: s.tdoa_resid_km, deltaKm, deltaH, impliedKn, hostsInCohort:
    (s.heard_by || s.receivers || []).filter((r) => COHORT_HOSTS.includes(hostFromSlot(r.slot || r))).length });
}

rowsOut.sort((a, b) => (a.deltaKm ?? 1e9) - (b.deltaKm ?? 1e9));
console.log("# Per-MMSI summary (sorted by Δkm, lower = better):");
console.log("  flag  q  cohort  resid    Δkm   Δh    impl_kn  mmsi        kind          tdoa_pos          identity");
for (const r of rowsOut) {
  const flag = r.kind === "coast" && r.deltaKm < 50 ? "  ✓ "
             : r.kind === "coast" && r.deltaKm >= 50 ? "  ✗ "
             : r.impliedKn != null && r.impliedKn > 60 ? " ⚠ "
             : r.deltaKm != null && r.deltaKm < 200 ? "  ✓ "
             : r.deltaKm != null ? "   ~"
             : "    ";
  console.log(
    `${flag}  ${String(r.q).padStart(2)}  ${String(r.hostsInCohort).padStart(3)}     ${String(r.resid?.toFixed(0) ?? "-").padStart(4)}km  `
    + `${String(r.deltaKm?.toFixed(0) ?? "-").padStart(5)}  ${String(r.deltaH?.toFixed(1) ?? "-").padStart(4)}  `
    + `${String(r.impliedKn?.toFixed(0) ?? "-").padStart(6)}   ${r.mmsi.padEnd(10)}  ${r.kind.padEnd(13)}  `
    + `${r.tdoa[0].toFixed(2)},${r.tdoa[1].toFixed(2)}     ${r.label}`,
  );
}

// Aggregate: tier by accuracy
const coast = rowsOut.filter(r => r.kind === "coast" && r.deltaKm != null);
const vessel = rowsOut.filter(r => r.kind === "vessel-stale" && r.deltaKm != null);
console.log();
if (coast.length) {
  const accurate = coast.filter(r => r.deltaKm < 50).length;
  console.log(`# Coast stations: ${accurate}/${coast.length} within 50 km of true position (BEST GROUND TRUTH)`);
  for (const r of coast) console.log(`#   ${r.mmsi}  Δ=${r.deltaKm.toFixed(0)} km  ${r.label}`);
}
if (vessel.length) {
  const ok = vessel.filter(r => (r.impliedKn ?? 0) <= 60).length;
  const close = vessel.filter(r => r.deltaKm < 200).length;
  console.log(`# Vessels: ${ok}/${vessel.length} plausible by speed; ${close}/${vessel.length} within 200 km of stale GFW lastPos`);
}
