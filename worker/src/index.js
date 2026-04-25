// Skywave gateway — the single Cloudflare Worker behind research.
// datadesk.eco/skywave.
//
// Routes:
//   GET  /v2/rack?region=<id>           → regional rack as JSON
//   WS   /v2/slot/:host/:port/:bandKHz  → attach to a ReceiverDO
//   GET  /gfw?query=<mmsi>              → GFW identity lookup (proxy)
//   GET  /gfw/tracks?vesselId=          → GFW decimated 14-day AIS track
//   GET  /lseg/track?mmsi=<mmsi>        → LSEG fresh AIS position (cached 30s)
//   GET  /receivers                     → kiwisdr_com list as JSON
//                                         (kept as a handy debug endpoint;
//                                          no client code hits it since v2)
//
// Deploy: (cd worker && npx wrangler deploy)

import { ReceiverDO } from "./receiver-do.js";
import { DirectoryDO } from "./directory-do.js";
import { TDOADO } from "./tdoa-do.js";
import { locationHintFor } from "./location-hint.js";
import { lsegLookupMmsi } from "./lseg.js";

export { ReceiverDO, DirectoryDO, TDOADO };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

// -------------------------------------------------------------------
// v1 helpers (unchanged from pre-v2)
// -------------------------------------------------------------------

async function receivers() {
  const upstream = await fetch(
    "http://rx.linkfanel.net/kiwisdr_com.js",
    { cf: { cacheTtl: 600, cacheEverything: true } },
  );
  if (!upstream.ok) {
    return new Response(`upstream ${upstream.status}`, { status: 502, headers: CORS });
  }
  const text = await upstream.text();
  const m = text.match(/var\s+kiwisdr_com\s*=\s*(\[[\s\S]*\])\s*;?/);
  if (!m) return new Response("list parse failed", { status: 502, headers: CORS });
  const json = m[1].replace(/,(\s*[\]}])/g, "$1");
  return new Response(json, {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=600",
      ...CORS,
    },
  });
}

async function gfw(url) {
  const q = url.searchParams.get("query") || "";
  if (!/^\d{9}$/.test(q)) {
    return new Response("bad query", { status: 400, headers: CORS });
  }
  const target =
    "https://gateway.api.globalfishingwatch.org/v3/vessels/search" +
    "?includes%5B0%5D=MATCH_CRITERIA" +
    "&includes%5B1%5D=OWNERSHIP" +
    "&datasets%5B0%5D=public-global-vessel-identity%3Av4.0" +
    `&query=${encodeURIComponent(q)}`;
  const upstream = await fetch(target, {
    cf: { cacheTtl: 86400, cacheEverything: true },
    headers: {
      accept: "*/*",
      authorization: "Bearer",
      origin: "https://globalfishingwatch.org",
      referer: "https://globalfishingwatch.org/map/fishing-activity/default-public/vessel-search",
    },
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=86400",
      ...CORS,
    },
  });
}

async function gfwTracks(url) {
  const vesselId = url.searchParams.get("vesselId") || "";
  if (!/^[a-z0-9-]{10,}$/i.test(vesselId)) {
    return new Response("bad vesselId", { status: 400, headers: CORS });
  }
  const end = new Date();
  const start = new Date(end.getTime() - 14 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const target =
    `https://gateway.api.globalfishingwatch.org/v3/vessels/${vesselId}/tracks` +
    "?binary=true" +
    "&fields%5B0%5D=LONLAT" +
    "&fields%5B1%5D=TIMESTAMP" +
    "&format=GEOJSON" +
    "&dataset=public-global-all-tracks%3Av4.0" +
    `&start-date=${fmt(start)}&end-date=${fmt(end)}`;
  const upstream = await fetch(target, {
    cf: { cacheTtl: 1800, cacheEverything: true },
    headers: {
      accept: "*/*",
      authorization: "Bearer",
      origin: "https://globalfishingwatch.org",
      referer: "https://globalfishingwatch.org/map/fishing-activity/default-public/vessel-search",
    },
  });
  if (!upstream.ok) {
    return new Response(`upstream ${upstream.status}`, { status: upstream.status, headers: CORS });
  }
  const json = (obj) => new Response(JSON.stringify(obj), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=1800",
      ...CORS,
    },
  });
  const data = await upstream.json();
  const feature = data.features && data.features[0];
  if (!feature || !feature.geometry) return json({ lastPos: null, trail: [] });
  const coords = [];
  const times = [];
  const timesProp = feature.properties && feature.properties.coordinateProperties
    && feature.properties.coordinateProperties.times;
  if (feature.geometry.type === "MultiLineString") {
    for (let li = 0; li < feature.geometry.coordinates.length; li++) {
      const seg = feature.geometry.coordinates[li];
      const tSeg = (timesProp && timesProp[li]) || [];
      for (let pi = 0; pi < seg.length; pi++) {
        coords.push(seg[pi]);
        times.push(tSeg[pi]);
      }
    }
  } else {
    for (let i = 0; i < feature.geometry.coordinates.length; i++) {
      coords.push(feature.geometry.coordinates[i]);
      times.push((timesProp || [])[i]);
    }
  }
  if (!coords.length) return json({ lastPos: null, trail: [] });
  const last = coords[coords.length - 1];
  const lastTs = times[times.length - 1] || null;
  const MAX_TRAIL = 100;
  const step = Math.max(1, Math.ceil(coords.length / MAX_TRAIL));
  const trail = [];
  for (let i = 0; i < coords.length; i += step) {
    trail.push([+coords[i][0].toFixed(4), +coords[i][1].toFixed(4)]);
  }
  if (trail[trail.length - 1][0] !== +last[0].toFixed(4) ||
      trail[trail.length - 1][1] !== +last[1].toFixed(4)) {
    trail.push([+last[0].toFixed(4), +last[1].toFixed(4)]);
  }
  return json({
    lastPos: { lat: +last[1].toFixed(5), lon: +last[0].toFixed(5), ts: lastTs },
    trail,
  });
}

async function lseg(url, env) {
  const mmsi = url.searchParams.get("mmsi") || "";
  if (!/^\d{9}$/.test(mmsi)) {
    return new Response("bad mmsi", { status: 400, headers: CORS });
  }
  try {
    const result = await lsegLookupMmsi(env, mmsi);
    return new Response(JSON.stringify(result), {
      headers: {
        "content-type": "application/json",
        // Browser-side cache: 30 s matches the worker-side position cache.
        "cache-control": "public, max-age=30",
        ...CORS,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 502,
      headers: { "content-type": "application/json", ...CORS },
    });
  }
}

// -------------------------------------------------------------------
// v2 routing — DirectoryDO (rack composition) + ReceiverDO (per-slot WS)
// -------------------------------------------------------------------

function directoryStub(env) {
  const id = env.DIRECTORY.idFromName("directory");
  return env.DIRECTORY.get(id);
}

function receiverStub(env, host, port, bandKHz, gps) {
  const name = `${host}:${port}:${bandKHz}`;
  const id = env.RECEIVER.idFromName(name);
  const locationHint = locationHintFor(gps);
  return env.RECEIVER.get(id, locationHint ? { locationHint } : undefined);
}

async function handleV2Rack(request, env) {
  const url = new URL(request.url);
  const inner = new URL("https://do/rack");
  for (const [k, v] of url.searchParams) inner.searchParams.set(k, v);
  // Inner host is ignored by the DO; only pathname + query matter to
  // the DO handler, but we still want the user-facing host when the DO
  // builds WS URLs — smuggle it through as a query param.
  inner.searchParams.set("__origin", `${url.protocol}//${url.host}`);
  return (await directoryStub(env).fetch(new Request(inner, request)));
}

async function handleV2Slot(request, env, host, port, bandKHz) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("websocket required", { status: 400 });
  }
  const p = parseInt(port, 10);
  const band = parseFloat(bandKHz);
  if (!Number.isFinite(p) || p < 1 || p > 65535 || !Number.isFinite(band)) {
    return new Response("bad slot", { status: 400 });
  }
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat") || "NaN");
  const lon = parseFloat(url.searchParams.get("lon") || "NaN");
  const gps = Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;

  // Forward the upgrade to the receiver DO, passing config via the query
  // so the first attach doesn't need a separate /init round-trip.
  const inner = new URL(`https://do/attach`);
  inner.searchParams.set("host", host);
  inner.searchParams.set("port", String(p));
  inner.searchParams.set("band", String(band));
  if (url.searchParams.get("label")) inner.searchParams.set("label", url.searchParams.get("label"));
  if (gps) {
    inner.searchParams.set("lat", String(gps[0]));
    inner.searchParams.set("lon", String(gps[1]));
  }
  const fwd = new Request(inner, request);
  return receiverStub(env, host, p, band, gps).fetch(fwd);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === "/v2/rack") return handleV2Rack(request, env);
    const vSlot = url.pathname.match(/^\/v2\/slot\/([^/]+)\/(\d+)\/([0-9.]+)\/?$/);
    if (vSlot) return handleV2Slot(request, env, decodeURIComponent(vSlot[1]), vSlot[2], vSlot[3]);

    // TDOA subscription and debug. POST /detect is used only by
    // ReceiverDOs (via service binding) so it isn't routed here.
    if (url.pathname === "/v2/tdoa/subscribe" || url.pathname === "/v2/tdoa/recent"
        || url.pathname === "/v2/tdoa/inject") {
      const id = env.TDOA.idFromName("singleton");
      const innerPath = url.pathname === "/v2/tdoa/recent" ? "https://do/recent"
                      : url.pathname === "/v2/tdoa/inject" ? "https://do/detect"
                      : "https://do/subscribe";
      const inner = new URL(innerPath);
      return env.TDOA.get(id).fetch(new Request(inner, request));
    }

    if (url.pathname === "/receivers") return receivers();
    if (url.pathname === "/gfw") return gfw(url);
    if (url.pathname === "/gfw/tracks") return gfwTracks(url);
    if (url.pathname === "/lseg/track") return lseg(url, env);

    return new Response(
      "skywave gateway · /v2/rack · /v2/slot/:host/:port/:band · /gfw · /gfw/tracks · /receivers",
      { status: 404, headers: CORS },
    );
  },
};
