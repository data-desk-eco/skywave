#!/usr/bin/env node
// Skywave test harness: attach to a region's rack, subscribe to TDOA
// solves as they land, cross-check each solved position against GFW's
// last-known AIS position for that MMSI, and stream a structured log
// of the whole pipeline.
//
// Answers two questions:
//   (a) Are we maximising TDOA hits?
//       → measures decodes, unique-decodes-after-dedup, quorum rate,
//         per-band productivity, per-receiver productivity.
//   (b) Are solves reasonable vs AIS ground truth?
//       → for every solved MMSI, computes km-distance between TDOA
//         fix and GFW lastPos, plus the time gap to that position.
//         Flags outliers >500 km.
//
// Output: one line of structured JSON per event, plus a 60-s heartbeat
// with rolling stats. Ctrl+C prints a final summary.
//
// Usage:
//   node scripts/tdoa_watch.mjs --region global --duration 3600
//   node scripts/tdoa_watch.mjs --region black-sea --out /tmp/bsk.jsonl
//
// Flags:
//   --region ID       region to watch (default: global)
//   --duration SEC    stop after this many seconds (default: 3600)
//   --out PATH        append JSONL to this file (default: ./watch-<ts>.jsonl)
//   --gateway URL     Skywave Worker (default: prod)
//   --no-ais          skip the GFW cross-check (faster, less signal)
//   --verbose         print every call event, not just solves

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const REGION   = arg("--region", "global");
const DURATION = parseInt(arg("--duration", "3600"), 10) * 1000;
const GATEWAY  = arg("--gateway", "https://skywave-gateway.louis-6bf.workers.dev");
const NO_AIS   = args.includes("--no-ais");
const VERBOSE  = args.includes("--verbose");
const OUT      = arg("--out", `./watch-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

const outStream = fs.createWriteStream(OUT, { flags: "a" });
const jlog = (obj) => outStream.write(JSON.stringify(obj) + "\n");

// ---------- Stats bookkeeping --------------------------------------------

const stats = {
  startedAt: Date.now(),
  decodeEvents: 0,            // raw `t:"call"` across all slots
  uniqueDecodes: 0,           // after dedup
  solves: 0,                  // `t:"tdoa"` events from subscribe
  prelimSolves: 0,            // tier="preliminary"
  confirmedSolves: 0,         // tier="confirmed"
  trustedSolves: 0,           // solves where solver residual < 50 km
  implausibleSolves: 0,       // solves that would require >60 kn speed
  residKm: [],                // solver residuals for every solve
  aisChecks: 0,               // GFW lookups completed
  aisHits: 0,                 // lookup returned a position
  aisDeltasKm: [],            // km between TDOA fix and AIS lastPos
  aisDeltaHours: [],          // hours between TDOA time and AIS timestamp
  outliers500Km: 0,           // solves with delta > 500 km
  perBandDecodes: new Map(),
  perBandSolves: new Map(),
  perRecvDecodes: new Map(),
  perRecvMulti: new Map(),    // decodes where ≥2 receivers heard it in dedup window
  openConns: 0,
  totalConns: 0,
};

// Dedup window (ms) within which identical decodes from different
// receivers are treated as the same burst. Matches ReceiverDO's
// decodedSigs 60s window.
const DEDUP_MS = 60000;
const dedupMap = new Map(); // sig → { firstSeen, receivers:Set, band }

function dedupKey(call) {
  return [call.caller, call.destination, call.formatCode,
          call.tc1Code, call.tc2Code, call.eos].join("|");
}

function gcKm(a, b) {
  const R = 6371, la1 = a[0]*Math.PI/180, la2 = b[0]*Math.PI/180;
  const dla = la2 - la1, dlo = (b[1]-a[1])*Math.PI/180;
  return 2*R*Math.asin(Math.sqrt(
    Math.sin(dla/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dlo/2)**2,
  ));
}

// ---------- GFW lookup (direct, cache-bypassing) --------------------------
//
// We bypass the Worker's cached /gfw + /gfw/tracks so the AIS position
// is always "freshest available", not 30-min stale. Two requests per
// solved MMSI: identity search to get vesselId, then tracks to get the
// last coordinate.

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_HEADERS = {
  accept: "*/*",
  authorization: "Bearer",
  origin: "https://globalfishingwatch.org",
  referer: "https://globalfishingwatch.org/map/fishing-activity/default-public/vessel-search",
};

// LSEG Workspace proxy — premium realtime AIS source. The Workspace is
// hosted on a GCE Windows VM, the in-VM Data API Proxy listens on 9000,
// and proxy.ps1 exposes it on 8080 with an X-Api-Key gate. Auth needs
// LSEG_APP_KEY plus a handshake-derived bearer token.
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
  if (!LSEG_APP_KEY || !LSEG_PROXY_KEY) {
    console.error("# LSEG creds missing — set LSEG_APP_KEY + LSEG_PROXY_API_KEY (or use --no-ais)");
    return false;
  }
  const r = await fetch(`${LSEG_BASE}/api/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": LSEG_PROXY_KEY },
    body: JSON.stringify({
      AppKey: LSEG_APP_KEY, AppScope: "trapi", ApiVersion: "1",
      LibraryName: "skywave-watch", LibraryVersion: "1.0",
    }),
  });
  if (!r.ok) { console.error(`# LSEG handshake failed: ${r.status}`); return false; }
  const j = await r.json();
  lsegToken = j.access_token;
  console.error(`# LSEG handshake OK (token expires in ${(j.expires_in/86400).toFixed(0)}d)`);
  return true;
}

// MMSI → IMO via GFW (free, public dataset has IMO for many cargo/
// tanker MMSIs even when it can't return their tracks). Cached.
const mmsiToImoCache = new Map();
async function gfwImoForMmsi(mmsi) {
  if (!/^\d{9}$/.test(mmsi)) return null;
  if (mmsiToImoCache.has(mmsi)) return mmsiToImoCache.get(mmsi);
  const url = `${GFW_BASE}/vessels/search` +
    `?includes%5B0%5D=MATCH_CRITERIA` +
    `&datasets%5B0%5D=public-global-vessel-identity%3Av4.0` +
    `&query=${mmsi}`;
  try {
    const r = await fetch(url, { headers: GFW_HEADERS });
    if (!r.ok) { mmsiToImoCache.set(mmsi, null); return null; }
    const j = await r.json();
    // Prefer the entry with an IMO populated.
    let imo = null, name = null;
    for (const e of j.entries || []) {
      const si = (e.selfReportedInfo || [])[0] || {};
      if (si.imo) { imo = si.imo; name = si.shipname; break; }
      if (!name && si.shipname) name = si.shipname;
    }
    const result = imo ? { imo, name } : null;
    mmsiToImoCache.set(mmsi, result);
    return result;
  } catch { mmsiToImoCache.set(mmsi, null); return null; }
}

// IMO → RIC via LSEG SymbologySearch. Cached.
const imoToRicCache = new Map();
async function lsegRicForImo(imo) {
  if (imoToRicCache.has(imo)) return imoToRicCache.get(imo);
  try {
    const r = await fetch(`${LSEG_BASE}/api/udf`, {
      method: "POST",
      headers: lsegHeaders(),
      body: JSON.stringify({
        Entity: { E: "SymbologySearch", W: {
          symbols: [String(imo)], from: "IMO", to: ["RIC"], bestMatchOnly: true,
        }}
      }),
    });
    const j = await r.json();
    const ric = j.mappedSymbols?.[0]?.bestMatch?.RIC || null;
    imoToRicCache.set(imo, ric);
    return ric;
  } catch { imoToRicCache.set(imo, null); return null; }
}

// RIC → live LSEG AIS position (lat, lon, timestamp, speed). NOT
// cached — we always want the freshest position.
async function lsegPositionForRic(ric) {
  try {
    const r = await fetch(`${LSEG_BASE}/api/udf`, {
      method: "POST",
      headers: lsegHeaders(),
      body: JSON.stringify({
        Entity: { E: "DataGrid_StandardAsync", W: { requests: [{
          instruments: [ric],
          fields: [
            { name: "TR.AssetName" },
            { name: "TR.AssetLocationLatitude" },
            { name: "TR.AssetLocationLongitude" },
            { name: "TR.AssetDateTime" },
            { name: "TR.AssetSpeed" },
            { name: "TR.AssetDestination" },
          ],
        }]}}
      }),
    });
    const j = await r.json();
    const row = j.responses?.[0]?.data?.[0];
    if (!row) return null;
    const [, name, lat, lon, dateStr, speed, dest] = row;
    if (lat == null || lon == null) return null;
    const ts = dateStr ? Date.parse(dateStr) : null;
    return { lat: +lat, lon: +lon, ts, name, speed: +speed || null, dest: dest || null };
  } catch { return null; }
}

// ---------- Solve → AIS cross-check --------------------------------------

async function checkSolveAgainstAIS(solve) {
  const mmsi = String(solve.mmsi || "");
  const rec = {
    ts: new Date().toISOString(),
    mmsi,
    call: solve.call,
    quorum: solve.receivers?.length ?? null,
    tdoa: [solve.position.lat, solve.position.lon],
    tdoa_resid_km: solve.position.residualKm,
    heard_by: (solve.receivers || []).map((r) => r.slot || r),
  };
  if (NO_AIS || /\?/.test(mmsi)) {   // skip if MMSI has wildcards
    jlog({ kind: "solve", ...rec });
    return;
  }
  stats.aisChecks++;
  const imoRec = await gfwImoForMmsi(mmsi);
  if (!imoRec) {
    rec.ais = null;
    rec.ais_reason = "no-imo-from-gfw";
    jlog({ kind: "solve", ...rec });
    return;
  }
  rec.vessel_name = imoRec.name || null;
  rec.imo = imoRec.imo;
  const ric = await lsegRicForImo(imoRec.imo);
  if (!ric) {
    rec.ais = null;
    rec.ais_reason = "no-ric-for-imo";
    jlog({ kind: "solve", ...rec });
    return;
  }
  const lastPos = await lsegPositionForRic(ric);
  if (!lastPos) {
    rec.ais = null;
    rec.ais_reason = "no-lseg-position";
    jlog({ kind: "solve", ...rec });
    return;
  }
  stats.aisHits++;
  const deltaKm = gcKm([solve.position.lat, solve.position.lon], [lastPos.lat, lastPos.lon]);
  // GFW lastPos.ts arrives as unix-ms number, not an ISO string.
  const tsMs = typeof lastPos.ts === "number" ? lastPos.ts
             : lastPos.ts ? Date.parse(lastPos.ts) : NaN;
  const deltaH = Number.isFinite(tsMs) ? (Date.now() - tsMs) / 3600000 : null;
  stats.aisDeltasKm.push(deltaKm);
  if (deltaH != null) stats.aisDeltaHours.push(deltaH);
  // Implied-speed plausibility: the AIS reference is often hours stale
  // (GFW public track dataset is cached for non-fishing vessels). So a
  // large km-delta doesn't automatically mean the TDOA is wrong —
  // the ship may have sailed that distance. We flag a solve as
  // physically implausible only when delta_km / delta_hours exceeds
  // what a ship could sustain (≈40 kn, i.e. 74 km/h). Conservative:
  // 60 kn sustained is effectively impossible for anything bigger
  // than a hydrofoil over more than an hour.
  const kmPerHour = deltaH ? deltaKm / deltaH : null;
  const impliedKn = kmPerHour ? kmPerHour / 1.852 : null;
  rec.implied_kn = impliedKn != null ? +impliedKn.toFixed(1) : null;
  const implausible = impliedKn != null && impliedKn > 60;
  if (implausible) stats.implausibleSolves++;
  if (deltaKm > 500) stats.outliers500Km++;
  const resid = solve.position.residualKm;
  stats.residKm.push(resid);
  // Solves with huge solver residuals are self-flagged as unreliable — the
  // geometry didn't close. Track those separately so quorum-rate isn't
  // inflated by bad fixes.
  if (resid < 50) stats.trustedSolves++;
  rec.ais = { lat: lastPos.lat, lon: lastPos.lon, ts: lastPos.ts };
  rec.delta_km = +deltaKm.toFixed(1);
  rec.delta_hours = deltaH != null ? +deltaH.toFixed(2) : null;
  jlog({ kind: "solve", ...rec });
  const flag = implausible ? ` ⚠ IMPLAUSIBLE ${impliedKn.toFixed(0)}kn`
             : impliedKn != null ? ` ✓ ${impliedKn.toFixed(0)}kn-plausible`
             : deltaKm > 500 ? " ~ large-Δ no-Δt" : " ·";
  console.log(
    `SOLVE ${rec.ts.slice(11, 19)}  mmsi=${mmsi.padEnd(10)} q=${rec.quorum} resid=${solve.position.residualKm.toFixed(0)}km  ` +
    `tdoa=${rec.tdoa[0].toFixed(2)},${rec.tdoa[1].toFixed(2)}  ` +
    `ais=${lastPos.lat.toFixed(2)},${lastPos.lon.toFixed(2)}  ` +
    `Δ=${deltaKm.toFixed(0)}km  Δt=${deltaH?.toFixed(1) ?? "?"}h${flag}`,
  );
}

// ---------- Main loop -----------------------------------------------------

if (!NO_AIS) await lsegHandshake();

const rack = await (await fetch(`${GATEWAY}/v2/rack?region=${encodeURIComponent(REGION)}`)).json();
if (!rack.slots?.length) {
  console.error(`no slots for region "${REGION}"`); process.exit(1);
}
console.error(`# Region ${rack.regionName} — ${rack.slots.length} slots`);
console.error(`# Output: ${path.resolve(OUT)}`);
jlog({ kind: "start", region: REGION, slots: rack.slots.length, startedAt: new Date().toISOString() });

// Subscribe to TDOA solves with auto-reconnect. A Worker redeploy or
// ordinary DO eviction drops the WS; without reconnect we go blind
// for the rest of the run and wildly under-report solves.
const subUrl = GATEWAY.replace(/^http/, "ws") + "/v2/tdoa/subscribe";
let tdoaWs;
let tdoaBackoff = 2000;
let shuttingDown = false;
function connectTdoaSubscribe() {
  tdoaWs = new WebSocket(subUrl);
  tdoaWs.onopen = () => { tdoaBackoff = 2000; console.error("# TDOA subscribe open"); };
  tdoaWs.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t !== "tdoa") return;
    stats.solves++;
    if (msg.tier === "preliminary") stats.prelimSolves++;
    else stats.confirmedSolves++;
    const band = (msg.receivers?.[0]?.slot || "").split("|").pop();
    stats.perBandSolves.set(band, (stats.perBandSolves.get(band) || 0) + 1);
    checkSolveAgainstAIS(msg).catch((e) => console.error("# ais check error:", e.message || e));
  };
  tdoaWs.onerror = () => {};
  tdoaWs.onclose = () => {
    if (shuttingDown) return;
    console.error(`# TDOA subscribe closed — reconnecting in ${tdoaBackoff}ms`);
    setTimeout(connectTdoaSubscribe, tdoaBackoff);
    tdoaBackoff = Math.min(tdoaBackoff * 2, 30_000);
  };
}
connectTdoaSubscribe();

// Attach to every slot in the rack, with auto-reconnect. Worker
// redeploys kick all the slot WSs; without reconnect we go silent.
const conns = new Map();  // s.wsUrl → ws
function attachSlot(s) {
  const ws = new WebSocket(s.wsUrl);
  conns.set(s.wsUrl, ws);
  ws._slot = s;
  stats.totalConns++;
  ws.onopen = () => { stats.openConns++; };
  ws.onclose = () => {
    stats.openConns = Math.max(0, stats.openConns - 1);
    if (shuttingDown) return;
    // Back-off so a storm of closes (e.g. Worker redeploy) doesn't DOS.
    setTimeout(() => attachSlot(s), 4000 + Math.random() * 6000);
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t !== "call") return;
    stats.decodeEvents++;
    stats.perBandDecodes.set(s.band, (stats.perBandDecodes.get(s.band) || 0) + 1);
    stats.perRecvDecodes.set(s.label, (stats.perRecvDecodes.get(s.label) || 0) + 1);
    const sig = dedupKey(msg.call || {});
    const now = Date.now();
    let entry = dedupMap.get(sig);
    if (!entry || now - entry.firstSeen > DEDUP_MS) {
      entry = { firstSeen: now, receivers: new Set([s.label]), band: s.band, call: msg.call };
      dedupMap.set(sig, entry);
      stats.uniqueDecodes++;
    } else {
      if (!entry.receivers.has(s.label)) {
        entry.receivers.add(s.label);
        if (entry.receivers.size === 2) {
          // Second receiver heard this decode — both get multi-credit.
          for (const r of entry.receivers) {
            stats.perRecvMulti.set(r, (stats.perRecvMulti.get(r) || 0) + 1);
          }
        } else if (entry.receivers.size > 2) {
          stats.perRecvMulti.set(s.label, (stats.perRecvMulti.get(s.label) || 0) + 1);
        }
      }
    }
    if (VERBOSE) {
      console.log(`CALL  ${new Date().toISOString().slice(11, 19)}  ${s.band.padEnd(5)} ${s.label.slice(0, 24).padEnd(24)}  ${msg.call?.caller} → ${msg.call?.destination}`);
    }
  };
}
for (const s of rack.slots) attachSlot(s);

// Prune dedup map periodically.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dedupMap) if (now - v.firstSeen > DEDUP_MS * 2) dedupMap.delete(k);
}, 30000);

// Heartbeat summary.
const heartbeat = setInterval(() => {
  const elapsed = (Date.now() - stats.startedAt) / 1000;
  const pct = (n) => stats.uniqueDecodes ? (100 * n / stats.uniqueDecodes).toFixed(1) + "%" : "-";
  const d = [...stats.aisDeltasKm].sort((a, b) => a - b);
  const p50 = d.length ? d[Math.floor(d.length * 0.5)] : null;
  const p90 = d.length ? d[Math.floor(d.length * 0.9)] : null;
  const line =
    `[${new Date().toISOString().slice(11, 19)}] ` +
    `${Math.round(elapsed)}s  ` +
    `conn=${stats.openConns}/${stats.totalConns}  ` +
    `decodes=${stats.decodeEvents} unique=${stats.uniqueDecodes}  ` +
    `solves=${stats.solves} (conf=${stats.confirmedSolves} prelim=${stats.prelimSolves}, ${pct(stats.solves)} of unique)  ` +
    `ais=${stats.aisHits}/${stats.aisChecks}  ` +
    (p50 != null ? `Δkm p50=${p50.toFixed(0)} p90=${p90.toFixed(0)}  implausible=${stats.implausibleSolves}/${stats.aisHits}` : ``);
  console.error(line);
  jlog({ kind: "heartbeat", t: new Date().toISOString(), ...stats,
         perBandDecodes: Object.fromEntries(stats.perBandDecodes),
         perBandSolves: Object.fromEntries(stats.perBandSolves),
         aisDeltasKm: undefined, aisDeltaHours: undefined,
         p50km: p50, p90km: p90 });
}, 60000);

// Final summary on shutdown.
function finish(reason) {
  clearInterval(heartbeat);
  const elapsed = (Date.now() - stats.startedAt) / 1000;
  const d = [...stats.aisDeltasKm].sort((a, b) => a - b);
  const pct = (n) => stats.uniqueDecodes ? (100 * n / stats.uniqueDecodes).toFixed(1) + "%" : "-";
  const pctl = (q) => d.length ? d[Math.floor(d.length * q)] : null;
  console.error(``);
  console.error(`# ${reason}. ${Math.round(elapsed)}s elapsed.`);
  console.error(`# decodes=${stats.decodeEvents} unique=${stats.uniqueDecodes} solves=${stats.solves} (${pct(stats.solves)} of unique) trusted=${stats.trustedSolves}`);
  const residSorted = [...stats.residKm].sort((a, b) => a - b);
  if (residSorted.length) {
    console.error(`# solver residual km: p50=${residSorted[Math.floor(residSorted.length * 0.5)].toFixed(0)} p90=${residSorted[Math.floor(residSorted.length * 0.9)].toFixed(0)}`);
  }
  console.error(`# AIS checks=${stats.aisChecks} hits=${stats.aisHits}` +
    (d.length ? `  Δkm p50=${pctl(0.5).toFixed(0)} p90=${pctl(0.9).toFixed(0)} max=${pctl(0.99).toFixed(0)}  >500km=${stats.outliers500Km}` : ""));
  console.error("# top 10 receivers by multi-hearings:");
  const multi = [...stats.perRecvMulti.entries()].sort((a, b) => b[1] - a[1]);
  for (const [r, m] of multi.slice(0, 10)) {
    const d = stats.perRecvDecodes.get(r) || 0;
    console.error(`#   multi=${String(m).padStart(3)}/${String(d).padStart(3)}  ${r}`);
  }
  console.error(`# per-band solves: ` +
    [...stats.perBandSolves.entries()].map(([b, n]) => `${b}=${n}`).join(" "));
  console.error(`# logged to ${path.resolve(OUT)}`);
  jlog({ kind: "end", reason, ...stats,
         perBandDecodes: Object.fromEntries(stats.perBandDecodes),
         perBandSolves: Object.fromEntries(stats.perBandSolves),
         perRecvDecodes: Object.fromEntries(stats.perRecvDecodes),
         perRecvMulti: Object.fromEntries(stats.perRecvMulti) });
  outStream.end();
  shuttingDown = true;
  try { tdoaWs?.close(); } catch {}
  for (const w of conns.values()) try { w.close(); } catch {}
  setTimeout(() => process.exit(0), 400);
}

process.on("SIGINT", () => finish("SIGINT"));
setTimeout(() => finish("duration elapsed"), DURATION);
