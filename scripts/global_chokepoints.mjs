#!/usr/bin/env node
// Global feasibility sweep for ground-wave MF TDoA cohorts.
//
// Walks a 5° lat × 5° lon grid worldwide. For each candidate centroid,
// applies the same picker logic as the english-channel region:
//
//   · MF receivers (band 2187.5 kHz) within 400 km
//   · GPS-fixing, free slots, recent
//   · site-deduped (no two receivers within 30 km of each other)
//
// Then computes:
//   · n: cohort size after dedup
//   · maxGap: max bearing gap from centroid (lower = better surround)
//   · meanDist: average receiver distance (for ground-wave reception)
//
// Score: n * (180 / maxGap) — rewards both quorum + spread.
//
// Filters out land-locked centroids (>~200 km from coast) since those
// can't host vessels broadcasting MF DSC.
//
// Output: top candidates ranked by score.

import fs from "node:fs";
import { geodist } from "../worker/src/tdoa.js";
import { coversBand, parseGps, coastDeg } from "../worker/src/regions.js";

const KHZ = 2187.5;
const RADIUS_KM = 400;
const SITE_DEDUP_KM = 30;
const MIN_RECEIVERS = 5;
const MAX_BEARING_GAP_DEG = 180;
// Coastal proximity filter — coastDeg() returns nearest-anchor distance
// in degrees; anchors are major ports. <2° (~220 km) ≈ "near coast".
const MAX_COAST_DEG = 2;

function bearingDeg(from, to) {
  const la1 = from[0]*Math.PI/180, la2 = to[0]*Math.PI/180;
  const dlo = (to[1]-from[1])*Math.PI/180;
  const y = Math.sin(dlo)*Math.cos(la2);
  const x = Math.cos(la1)*Math.sin(la2) - Math.sin(la1)*Math.cos(la2)*Math.cos(dlo);
  return ((Math.atan2(y, x)*180/Math.PI)+360)%360;
}

const raw = fs.readFileSync("/tmp/kiwisdr_com.js", "utf8");
const i = raw.indexOf("["), j = raw.lastIndexOf("]");
const list = (new Function("return " + raw.slice(i, j + 1)))();

// Pre-filter to MF-capable, GPS-fixing, free receivers.
const eligible = [];
for (const r of list) {
  if (r.status !== "active" || r.offline === "yes" || !r.url) continue;
  if (r.ip_blacklist === "yes") continue;
  if (!String(r.sdr_hw||"").includes("📡 GPS")) continue;
  if ((parseInt(r.fixes_hour,10)||0) < 100) continue;
  if (!coversBand(r, KHZ)) continue;
  const gps = parseGps(r.gps); if (!gps) continue;
  const free = Math.max(0, (parseInt(r.users_max,10)||0) - (parseInt(r.users,10)||0));
  if (free < 2) continue;
  let host; try { const u = new URL(r.url); host = u.hostname; } catch { continue; }
  eligible.push({ host, gps, label: (r.loc||r.name||"?").slice(0,32) });
}
console.error(`# Pool: ${eligible.length} MF-capable GPS-fixing receivers worldwide`);

function siteDeduped(picks, c) {
  for (const p of picks) if (geodist(p.gps, c.gps)/1000 < SITE_DEDUP_KM) return true;
  return false;
}

function evalCentroid(centroid) {
  const cands = [];
  for (const r of eligible) {
    const d = geodist(r.gps, centroid)/1000;
    if (d > RADIUS_KM) continue;
    cands.push({ ...r, distKm: d, bearing: bearingDeg(centroid, r.gps) });
  }
  if (cands.length < MIN_RECEIVERS) return null;
  cands.sort((a, b) => a.distKm - b.distKm);
  // Site dedup
  const sites = [];
  for (const c of cands) if (!siteDeduped(sites, c)) sites.push(c);
  if (sites.length < MIN_RECEIVERS) return null;
  // Bearing gap on deduped sites
  const bearings = sites.map(s => s.bearing).sort((a, b) => a - b);
  let maxGap = 360 - (bearings[bearings.length - 1] - bearings[0]);
  for (let i = 1; i < bearings.length; i++) {
    const g = bearings[i] - bearings[i - 1];
    if (g > maxGap) maxGap = g;
  }
  if (maxGap > MAX_BEARING_GAP_DEG) return null;
  const meanDist = sites.reduce((s, x) => s + x.distKm, 0) / sites.length;
  return {
    n: sites.length,
    maxGap,
    meanDist,
    minDist: sites[0].distKm,
    score: sites.length * (180 / maxGap),
    sites: sites.slice(0, 8),
  };
}

const results = [];
const labelled = [
  // Hand-picked named candidates so the output reads as "X works/doesn't"
  // rather than just bare lat/lon. Mix of strategic chokepoints and
  // dense-receiver areas.
  ["English Channel",      [50.0,    0.0]],
  ["Dover Strait",         [51.0,    1.5]],
  ["German Bight",         [54.0,    7.0]],
  ["Skagerrak",            [58.0,    9.0]],
  ["NW Mediterranean",     [42.0,    5.0]],
  ["Tyrrhenian Sea",       [40.0,   12.0]],
  ["Adriatic",             [43.0,   15.0]],
  ["Aegean",               [37.0,   25.0]],
  ["Sea of Marmara",       [40.8,   28.0]],
  ["Bosphorus",            [41.1,   29.0]],
  ["Black Sea (NW)",       [44.0,   31.0]],
  ["Black Sea (Crimea)",   [45.0,   34.0]],
  ["Strait of Gibraltar",  [36.0,   -5.5]],
  ["Strait of Hormuz",     [26.5,   56.5]],
  ["Bab el Mandeb",        [12.6,   43.4]],
  ["Suez Canal",           [30.0,   32.5]],
  ["Strait of Malacca",    [3.5,   100.0]],
  ["Singapore Strait",     [1.2,   103.7]],
  ["Sunda Strait",         [-6.0,  105.7]],
  ["Lombok Strait",        [-8.7,  115.7]],
  ["Tsugaru Strait",       [41.5,  140.5]],
  ["Tokyo Bay",            [35.3,  139.8]],
  ["Yellow Sea",           [36.0,  124.0]],
  ["Hong Kong",            [22.0,  114.0]],
  ["Panama Canal Atlantic",[9.4,   -79.9]],
  ["Panama Canal Pacific", [8.8,   -79.5]],
  ["Magellan Strait",      [-53.0, -71.0]],
  ["Florida Straits",      [25.0,  -80.0]],
  ["Chesapeake",           [37.0,  -76.0]],
  ["NY Harbour",           [40.5,  -74.0]],
  ["Cape Cod",             [42.0,  -70.0]],
  ["Bay of Biscay",        [45.0,   -5.0]],
  ["Irish Sea",            [54.0,   -5.0]],
  ["Skagerrak/Kattegat",   [57.0,   11.0]],
  ["Gulf of Finland",      [60.0,   25.0]],
  ["Strait of Sicily",     [37.0,   12.0]],
  ["Cape of Good Hope",    [-34.5,  19.0]],
];

for (const [name, gps] of labelled) {
  if (coastDeg(gps) > MAX_COAST_DEG) continue;
  const r = evalCentroid(gps);
  if (r) results.push({ name, gps, ...r });
}

// Bonus pass: 2.5° lat × 2.5° lon grid sweep, only retain centroids that
// (a) pass coastal filter, (b) score above the lowest labelled hit and
// (c) aren't within 4° of an already-named candidate. Surfaces unnamed
// chokepoints we didn't think to add to the labelled list.
const labelledGps = labelled.map(([_, g]) => g);
const minScoreToReport = Math.min(...results.map(r => r.score));
for (let lat = -60; lat <= 70; lat += 2.5) {
  for (let lon = -180; lon < 180; lon += 2.5) {
    const gps = [lat, lon];
    if (coastDeg(gps) > MAX_COAST_DEG) continue;
    if (labelledGps.some(g => Math.hypot(g[0] - lat, (g[1] - lon + 540) % 360 - 180) < 4)) continue;
    if (results.some(r => Math.hypot(r.gps[0] - lat, (r.gps[1] - lon + 540) % 360 - 180) < 3)) continue;
    const r = evalCentroid(gps);
    if (r && r.score >= minScoreToReport) {
      results.push({ name: `(unnamed ${lat.toFixed(1)},${lon.toFixed(1)})`, gps, ...r });
    }
  }
}

results.sort((a, b) => b.score - a.score);

console.log(`# Global ground-wave MF TDoA feasibility — top candidates by surround score`);
console.log(`# Filters: ≥${MIN_RECEIVERS} receivers within ${RADIUS_KM} km, ≤${MAX_BEARING_GAP_DEG}° max bearing gap`);
console.log(`# Score = n × (180 / max_gap)   (higher = better surround geometry)`);
console.log();
console.log("score   n   gap   meanDist   minDist   centroid              name");
for (const r of results) {
  console.log(
    `${r.score.toFixed(1).padStart(5)}  ${String(r.n).padStart(2)}  ${r.maxGap.toFixed(0).padStart(3)}°   ${r.meanDist.toFixed(0).padStart(4)} km   ${r.minDist.toFixed(0).padStart(4)} km   ${r.gps[0].toFixed(1).padStart(5)},${r.gps[1].toFixed(1).padStart(6)}    ${r.name}`,
  );
}
console.log();
console.log("# Top 5 candidates' cohorts:");
for (const r of results.slice(0, 5)) {
  console.log(`# ─── ${r.name} (${r.gps[0].toFixed(2)},${r.gps[1].toFixed(2)}) ───`);
  for (const s of r.sites) {
    console.log(`#   ${s.distKm.toFixed(0).padStart(3)}km  ${s.bearing.toFixed(0).padStart(3)}°  ${s.host.padEnd(36)} ${s.label}`);
  }
}
