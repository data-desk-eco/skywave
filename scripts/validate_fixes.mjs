#!/usr/bin/env node
// Ground-truth validator for TDOA fix JSONL (capture chunks, the
// /v2/tdoa/recent ring, or tdoa_watch.mjs rows — all three shapes).
//
// Per fix:
//   - coast stations (MMSI in worker/src/coast-registry.js): error =
//     distance to nearest registered site. Definitive ground truth.
//   - vessels: fresh AIS via LSEG (MMSI → GFW IMO → RIC → position).
//     Error = distance to AIS position; implied speed absorbs AIS lag.
//
// Prints per-fix rows, then the headline numbers for "valid positional
// reads on a reliable cadence": per-fix error percentiles, % within
// 100 km, fixes/hour, and what the registry gate would have rejected.
//
// Usage:
//   ./scripts/with_lseg.sh node scripts/validate_fixes.mjs <jsonl> [--no-ais]

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { COAST_REGISTRY, REGISTRY_MAX_KM, coastRegistryCheck } from "../worker/src/coast-registry.js";

const args = process.argv.slice(2);
const path = args[0];
const NO_AIS = args.includes("--no-ais");
if (!path) { console.error("usage: validate_fixes.mjs <jsonl> [--no-ais]"); process.exit(2); }

function gcKm(a, b) {
  const R = 6371, la1 = a[0]*Math.PI/180, la2 = b[0]*Math.PI/180;
  const dla = la2-la1, dlo = (b[1]-a[1])*Math.PI/180;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(
    Math.sin(dla/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dlo/2)**2)));
}

// ---------- LSEG + GFW lookup chain (mirrors tdoa_watch.mjs) ----------
const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_HEADERS = {
  accept: "*/*",
  authorization: "Bearer",
  origin: "https://globalfishingwatch.org",
  referer: "https://globalfishingwatch.org/map/fishing-activity/default-public/vessel-search",
};
const LSEG_BASE = process.env.LSEG_PROXY_URL || "http://34.13.53.112:8080";
const LSEG_PROXY_KEY = process.env.LSEG_PROXY_API_KEY || "";
const LSEG_APP_KEY = process.env.LSEG_APP_KEY || "";
let lsegToken = null;
function lsegHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": LSEG_PROXY_KEY,
    "x-tr-applicationid": LSEG_APP_KEY,
    Authorization: `Bearer ${lsegToken}`,
  };
}
async function lsegHandshake() {
  if (!LSEG_APP_KEY || !LSEG_PROXY_KEY) return false;
  const r = await fetch(`${LSEG_BASE}/api/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": LSEG_PROXY_KEY },
    body: JSON.stringify({
      AppKey: LSEG_APP_KEY, AppScope: "trapi", ApiVersion: "1",
      LibraryName: "skywave-validate", LibraryVersion: "1.0",
    }),
  }).catch(() => null);
  if (!r || !r.ok) { console.error(`# LSEG handshake failed`); return false; }
  lsegToken = (await r.json()).access_token;
  console.error("# LSEG handshake OK");
  return true;
}
const mmsiToImoCache = new Map();
async function gfwImoForMmsi(mmsi) {
  if (!/^\d{9}$/.test(mmsi)) return null;
  if (mmsiToImoCache.has(mmsi)) return mmsiToImoCache.get(mmsi);
  const url = `${GFW_BASE}/vessels/search?includes%5B0%5D=MATCH_CRITERIA` +
    `&datasets%5B0%5D=public-global-vessel-identity%3Av4.0&query=${mmsi}`;
  try {
    const r = await fetch(url, { headers: GFW_HEADERS });
    if (!r.ok) { mmsiToImoCache.set(mmsi, null); return null; }
    const j = await r.json();
    const mmsiInt = parseInt(mmsi, 10);
    const candidates = [];
    for (const e of j.entries || []) {
      for (const si of e.selfReportedInfo || []) {
        if (parseInt(si.ssvid, 10) !== mmsiInt || !si.imo) continue;
        candidates.push({ imo: si.imo, name: si.shipname, flag: si.flag,
          to: Date.parse(si.transmissionDateTo || "") || 0 });
      }
    }
    if (!candidates.length) { mmsiToImoCache.set(mmsi, null); return null; }
    candidates.sort((a, b) => b.to - a.to);
    const result = { imo: candidates[0].imo, name: candidates[0].name, flag: candidates[0].flag };
    mmsiToImoCache.set(mmsi, result);
    return result;
  } catch { mmsiToImoCache.set(mmsi, null); return null; }
}
const imoToRicCache = new Map();
async function lsegRicForImo(imo) {
  if (imoToRicCache.has(imo)) return imoToRicCache.get(imo);
  try {
    const r = await fetch(`${LSEG_BASE}/api/udf`, {
      method: "POST", headers: lsegHeaders(),
      body: JSON.stringify({ Entity: { E: "SymbologySearch", W: {
        symbols: [String(imo)], from: "IMO", to: ["RIC"], bestMatchOnly: true,
      }}}),
    });
    const j = await r.json();
    const ric = j.mappedSymbols?.[0]?.bestMatch?.RIC || null;
    imoToRicCache.set(imo, ric);
    return ric;
  } catch { imoToRicCache.set(imo, null); return null; }
}
async function lsegPositionForRic(ric) {
  try {
    const r = await fetch(`${LSEG_BASE}/api/udf`, {
      method: "POST", headers: lsegHeaders(),
      body: JSON.stringify({ Entity: { E: "DataGrid_StandardAsync", W: { requests: [{
        instruments: [ric],
        fields: [
          { name: "TR.AssetName" }, { name: "TR.AssetLocationLatitude" },
          { name: "TR.AssetLocationLongitude" }, { name: "TR.AssetDateTime" },
          { name: "TR.AssetSpeed" },
        ],
      }]}}}),
    });
    const j = await r.json();
    const row = j.responses?.[0]?.data?.[0];
    if (!row) return null;
    const [, name, lat, lon, dateStr, speed] = row;
    if (lat == null || lon == null) return null;
    return { lat: +lat, lon: +lon, ts: dateStr ? Date.parse(dateStr) : null,
      name, speed: +speed || null };
  } catch { return null; }
}

// ---------- Load + normalise rows ----------
const rows = fs.readFileSync(path, "utf8").trim().split("\n").map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const fixes = rows
  .filter((r) => r && (r.kind === "solve" || r.t === "tdoa"
    || (r.position && typeof r.position?.lat === "number" && r.mmsi)))
  .map((r) => r.kind === "solve"
    ? { mmsi: String(r.mmsi), pos: r.tdoa, q: r.quorum, resid: r.tdoa_resid_km,
        regime: r.regime, geometry: r.geometry }
    : { mmsi: String(r.mmsi), pos: [r.position.lat, r.position.lon], q: r.quorum,
        resid: r.position.residualKm, regime: r.regime, geometry: r.geometry });

console.log(`# ${path}: ${fixes.length} fixes, ${new Set(fixes.map(f => f.mmsi)).size} distinct MMSIs`);

// ---------- Coast stations: per-fix definitive errors ----------
const coastFixes = fixes.filter((f) => COAST_REGISTRY[f.mmsi]);
const coastErrs = [];
let registryWouldReject = 0;
console.log(`\n# Coast-station fixes (registry ground truth): ${coastFixes.length}`);
for (const f of coastFixes) {
  const c = coastRegistryCheck(f.mmsi, f.pos[0], f.pos[1]);
  coastErrs.push(c.nearestKm);
  const rej = c.nearestKm > REGISTRY_MAX_KM;
  if (rej) registryWouldReject++;
  console.log(`  ${rej ? "GHOST" : "  ok "}  ${f.mmsi}  ${c.name.padEnd(26)} q=${f.q} ${String(f.regime||"").padEnd(13)} fix=${f.pos[0].toFixed(2)},${f.pos[1].toFixed(2)}  err=${c.nearestKm.toFixed(0)} km`);
}

// ---------- Vessels: fresh AIS ----------
const vesselFixes = fixes.filter((f) => /^\d{9}$/.test(f.mmsi) && !f.mmsi.startsWith("00") && !COAST_REGISTRY[f.mmsi]);
const byVessel = new Map();
for (const f of vesselFixes) {
  if (!byVessel.has(f.mmsi)) byVessel.set(f.mmsi, []);
  byVessel.get(f.mmsi).push(f);
}
console.log(`\n# Vessel fixes: ${vesselFixes.length} over ${byVessel.size} distinct MMSIs`);
const vesselErrs = [];        // per-fix error vs fresh AIS (fresh = <6h old)
const vesselRows = [];

// Kpler fallback for fresh AIS: GFW gives MMSI → name, the kpler CLI
// (skill wrapper, auths via Google Secret Manager) gives name → recent
// positions. Coverage is commodity vessels only, but Kpler positions
// are hours old where GFW's public lastPos can be a week stale.
const KPLER = new URL("../.claude/skills/kpler/kpler", import.meta.url).pathname;
function kplerFreshPos(name) {
  try {
    const tsv = execFileSync(KPLER, ["search", name, "--categories", "VESSEL"],
      { encoding: "utf8", timeout: 60000 });
    const row = tsv.trim().split("\n").slice(1)
      .map((l) => l.split("\t"))
      .find((c) => c[2] && c[2].toLowerCase() === name.toLowerCase());
    if (!row) return null;
    const pos = execFileSync(KPLER, ["positions", row[1]], { encoding: "utf8", timeout: 60000 });
    const first = pos.trim().split("\n")[1];
    if (!first) return null;
    const [t, lat, lon] = first.split("\t");
    return { lat: +lat, lon: +lon, ts: Date.parse(t + "Z"), name: row[2] };
  } catch { return null; }
}

const lsegUp = !NO_AIS && await lsegHandshake();
if (!NO_AIS && !lsegUp) console.error("# LSEG down — using Kpler fallback for vessel AIS");
if (!NO_AIS && !lsegUp) {
  for (const [mmsi, fl] of byVessel.entries()) {
    const imoRec = await gfwImoForMmsi(mmsi);
    if (!imoRec || !imoRec.name) { vesselRows.push(`       ${mmsi}  (no GFW identity)  fixes=${fl.length}`); continue; }
    const pos = kplerFreshPos(imoRec.name);
    if (!pos) { vesselRows.push(`       ${mmsi}  ${imoRec.name} (not in Kpler)  fixes=${fl.length}`); continue; }
    const ageH = pos.ts ? (Date.now() - pos.ts) / 3600000 : null;
    for (const f of fl) {
      const err = gcKm(f.pos, [pos.lat, pos.lon]);
      const fresh = ageH != null && ageH < 24;
      if (fresh) vesselErrs.push(err);
      vesselRows.push(
        `  ${fresh && err < 100 ? " ✓✓ " : fresh && err < 200 ? "  ✓ " : fresh ? "  ✗ " : "    "}  ${mmsi}  ${imoRec.name.padEnd(22)} q=${f.q} ${String(f.regime || "").padEnd(13)} fix=${f.pos[0].toFixed(2)},${f.pos[1].toFixed(2)}  Δ=${err.toFixed(0)} km  aisAge=${ageH?.toFixed(1) ?? "?"}h`);
    }
  }
}
if (lsegUp) {
  for (const [mmsi, fl] of byVessel.entries()) {
    const imoRec = await gfwImoForMmsi(mmsi);
    if (!imoRec) { vesselRows.push(`       ${mmsi}  (no IMO via GFW)  fixes=${fl.length}`); continue; }
    const ric = await lsegRicForImo(imoRec.imo);
    const pos = ric ? await lsegPositionForRic(ric) : null;
    if (!pos) { vesselRows.push(`       ${mmsi}  ${imoRec.name || "?"} (no LSEG position)  fixes=${fl.length}`); continue; }
    const ageH = pos.ts ? (Date.now() - pos.ts) / 3600000 : null;
    for (const f of fl) {
      const err = gcKm(f.pos, [pos.lat, pos.lon]);
      const impliedKn = ageH > 0 ? err / ageH / 1.852 : null;
      const fresh = ageH != null && ageH < 6;
      if (fresh) vesselErrs.push(err);
      vesselRows.push(
        `  ${fresh && err < 100 ? " ✓✓ " : fresh ? "  ✓ " : "    "}  ${mmsi}  ${(imoRec.name || pos.name || "?").padEnd(22)} q=${f.q} ${String(f.regime||"").padEnd(13)} fix=${f.pos[0].toFixed(2)},${f.pos[1].toFixed(2)}  Δ=${err.toFixed(0)} km  aisAge=${ageH?.toFixed(1) ?? "?"}h${impliedKn != null && ageH > 6 ? `  impl=${impliedKn.toFixed(0)}kn` : ""}`);
    }
  }
} else if (NO_AIS) {
  console.log("  (AIS check skipped)");
}
for (const r of vesselRows) console.log(r);

// ---------- Headline ----------
const pq = (xs, q) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : null;
console.log("\n# ---- headline ----");
if (coastErrs.length) {
  const errs = [...coastErrs].sort((a, b) => a - b);
  const within = errs.filter(e => e < 100).length;
  console.log(`# coast per-fix: n=${errs.length}  p50=${pq(errs,0.5).toFixed(0)} km  p90=${pq(errs,0.9).toFixed(0)} km  within100=${within}/${errs.length}`);
  console.log(`# registry gate would reject ${registryWouldReject}/${errs.length} coast fixes as >${REGISTRY_MAX_KM} km ghosts`);
  const surviving = errs.filter(e => e <= REGISTRY_MAX_KM);
  if (surviving.length) {
    const w = surviving.filter(e => e < 100).length;
    console.log(`# coast per-fix AFTER registry gate: n=${surviving.length}  p50=${pq(surviving,0.5).toFixed(0)} km  within100=${w}/${surviving.length}`);
  }
}
if (vesselErrs.length) {
  const errs = [...vesselErrs].sort((a, b) => a - b);
  const within = errs.filter(e => e < 100).length;
  console.log(`# vessel per-fix vs fresh AIS (<6h): n=${errs.length}  p50=${pq(errs,0.5).toFixed(0)} km  p90=${pq(errs,0.9).toFixed(0)} km  within100=${within}/${errs.length}`);
}
