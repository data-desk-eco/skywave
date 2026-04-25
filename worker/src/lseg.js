// LSEG Workspace AIS lookup — fresh vessel positions for solved MMSIs.
//
// Pipeline: MMSI → IMO (via GFW) → RIC (via LSEG SymbologySearch) →
// lat/lon/timestamp/speed (via LSEG DataGrid_StandardAsync,
// TR.AssetLocation* fields). The bearer token from the LSEG handshake
// is cached in module scope (worker isolate lifetime, ~5 min typical)
// to avoid handshaking on every call. Token has a 24h expiry per LSEG
// spec; we just refresh on 401 if caching outlives it.
//
// Secrets: LSEG_APP_KEY, LSEG_PROXY_API_KEY (set via `wrangler secret`).
// Plain env: LSEG_PROXY_URL (default http://34.13.53.112:8080).
//
// Result shape:
//   { lat, lon, ts, name, speed, dest, ric, imo }
//   or { error: "string" }

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_HEADERS = {
  accept: "*/*",
  authorization: "Bearer",
  origin: "https://globalfishingwatch.org",
  referer: "https://globalfishingwatch.org/map/fishing-activity/default-public/vessel-search",
};

// Module-scope state, lives for the duration of the isolate.
let lsegToken = null;
let lsegTokenAt = 0;
const TOKEN_TTL_MS = 23 * 3600 * 1000;   // 23h, leave headroom
const mmsiToImoCache = new Map();        // mmsi → {imo, name, flag} | null
const imoToRicCache = new Map();         // imo → ric | null
const positionCache = new Map();         // mmsi → {result, t}
const POSITION_CACHE_MS = 30_000;        // 30 s

function lsegBase(env) {
  return env.LSEG_PROXY_URL || "http://34.13.53.112:8080";
}

async function ensureLsegToken(env, force = false) {
  const now = Date.now();
  if (!force && lsegToken && now - lsegTokenAt < TOKEN_TTL_MS) return lsegToken;
  if (!env.LSEG_APP_KEY || !env.LSEG_PROXY_API_KEY) {
    throw new Error("LSEG credentials not configured");
  }
  const r = await fetch(`${lsegBase(env)}/api/handshake`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": env.LSEG_PROXY_API_KEY,
    },
    body: JSON.stringify({
      AppKey: env.LSEG_APP_KEY,
      AppScope: "trapi",
      ApiVersion: "1",
      LibraryName: "skywave-worker",
      LibraryVersion: "1.0",
    }),
  });
  if (!r.ok) throw new Error(`LSEG handshake ${r.status}`);
  const j = await r.json();
  lsegToken = j.access_token;
  lsegTokenAt = now;
  return lsegToken;
}

function lsegHeaders(env, token) {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": env.LSEG_PROXY_API_KEY,
    "x-tr-applicationid": env.LSEG_APP_KEY,
    Authorization: `Bearer ${token}`,
  };
}

// MMSI → IMO via GFW. GFW search is fuzzy and can return entries with
// a *different* ssvid than the query (e.g. 005030001 returns a 503177000
// vessel). Filter strictly on ssvid match. Compare as integers to absorb
// leading-zero asymmetry (GFW serves "5030001", we may have "005030001").
async function gfwImoForMmsi(mmsi) {
  if (mmsiToImoCache.has(mmsi)) return mmsiToImoCache.get(mmsi);
  if (!/^\d{9}$/.test(mmsi)) { mmsiToImoCache.set(mmsi, null); return null; }
  const url = `${GFW_BASE}/vessels/search`
    + `?includes%5B0%5D=MATCH_CRITERIA`
    + `&datasets%5B0%5D=public-global-vessel-identity%3Av4.0`
    + `&query=${mmsi}`;
  const r = await fetch(url, { headers: GFW_HEADERS, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) { mmsiToImoCache.set(mmsi, null); return null; }
  const j = await r.json();
  const mmsiInt = parseInt(mmsi, 10);
  const candidates = [];
  for (const e of j.entries || []) {
    for (const si of e.selfReportedInfo || []) {
      if (parseInt(si.ssvid, 10) !== mmsiInt) continue;
      if (!si.imo) continue;
      candidates.push({
        imo: si.imo, name: si.shipname, flag: si.flag,
        to: Date.parse(si.transmissionDateTo || "") || 0,
      });
    }
  }
  if (!candidates.length) { mmsiToImoCache.set(mmsi, null); return null; }
  candidates.sort((a, b) => b.to - a.to);     // most recently active wins
  const result = { imo: candidates[0].imo, name: candidates[0].name, flag: candidates[0].flag };
  mmsiToImoCache.set(mmsi, result);
  return result;
}

async function lsegRicForImo(env, imo) {
  if (imoToRicCache.has(imo)) return imoToRicCache.get(imo);
  const token = await ensureLsegToken(env);
  const r = await fetch(`${lsegBase(env)}/api/udf`, {
    method: "POST",
    headers: lsegHeaders(env, token),
    body: JSON.stringify({
      Entity: { E: "SymbologySearch", W: {
        symbols: [String(imo)], from: "IMO", to: ["RIC"], bestMatchOnly: true,
      }},
    }),
  });
  if (!r.ok) {
    if (r.status === 401) {                    // token expired — refresh once
      await ensureLsegToken(env, true);
      return lsegRicForImo(env, imo);
    }
    imoToRicCache.set(imo, null);
    return null;
  }
  const j = await r.json();
  const ric = j.mappedSymbols?.[0]?.bestMatch?.RIC || null;
  imoToRicCache.set(imo, ric);
  return ric;
}

async function lsegPositionForRic(env, ric) {
  const token = await ensureLsegToken(env);
  const r = await fetch(`${lsegBase(env)}/api/udf`, {
    method: "POST",
    headers: lsegHeaders(env, token),
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
      }]}},
    }),
  });
  if (!r.ok) {
    if (r.status === 401) {
      await ensureLsegToken(env, true);
      return lsegPositionForRic(env, ric);
    }
    return null;
  }
  const j = await r.json();
  const row = j.responses?.[0]?.data?.[0];
  if (!row) return null;
  const [, name, lat, lon, dateStr, speed, dest] = row;
  if (lat == null || lon == null) return null;
  const ts = dateStr ? Date.parse(dateStr) : null;
  return {
    lat: +lat, lon: +lon, ts,
    name: name || null,
    speed: +speed || null,
    dest: dest || null,
  };
}

// Public: MMSI → fresh AIS position from LSEG. Cached 30 s.
export async function lsegLookupMmsi(env, mmsi) {
  const cached = positionCache.get(mmsi);
  if (cached && Date.now() - cached.t < POSITION_CACHE_MS) return cached.result;

  const result = await (async () => {
    const imoRec = await gfwImoForMmsi(mmsi);
    if (!imoRec) return { error: "no-imo-from-gfw", mmsi };
    const ric = await lsegRicForImo(env, imoRec.imo);
    if (!ric) return { error: "no-ric-for-imo", mmsi, imo: imoRec.imo, name: imoRec.name, flag: imoRec.flag };
    const pos = await lsegPositionForRic(env, ric);
    if (!pos) return { error: "no-lseg-position", mmsi, imo: imoRec.imo, ric, name: imoRec.name, flag: imoRec.flag };
    return {
      mmsi, imo: imoRec.imo, ric,
      name: pos.name || imoRec.name, flag: imoRec.flag,
      lat: pos.lat, lon: pos.lon, ts: pos.ts,
      speed: pos.speed, dest: pos.dest,
    };
  })();
  positionCache.set(mmsi, { result, t: Date.now() });
  return result;
}
