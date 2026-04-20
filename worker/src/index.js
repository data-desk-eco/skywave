// Skywave gateway — a thin Cloudflare Worker that lets the static
// HTTPS site talk to the HTTP-only KiwiSDR ecosystem.
//
// Two routes:
//   GET  /receivers              → kiwisdr_com list as JSON, cached 10 min
//   WS   /kiwi/:host/:port/<path>  → tunnels to ws://host:port/<path>
//
// Why this exists: rx.linkfanel.net serves the public receiver list over
// plain HTTP, and every KiwiSDR speaks plain ws://. Mixed-content rules
// block both from an HTTPS origin. This Worker terminates TLS and relays.
//
// Deploy: (cd worker && npx wrangler deploy)

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

async function receivers() {
  // CF fetches this upstream via its own edge cache (cacheTtl); browsers
  // honour the Cache-Control header on our response. No need for an
  // explicit caches.default dance, which is per-POP and painful to bust.
  const upstream = await fetch(
    "http://rx.linkfanel.net/kiwisdr_com.js",
    { cf: { cacheTtl: 600, cacheEverything: true } },
  );
  if (!upstream.ok) {
    return new Response(`upstream ${upstream.status}`, {
      status: 502,
      headers: CORS,
    });
  }
  const text = await upstream.text();
  const m = text.match(/var\s+kiwisdr_com\s*=\s*(\[[\s\S]*\])\s*;?/);
  if (!m) return new Response("list parse failed", { status: 502, headers: CORS });

  // The upstream blob is JS (object-literal), not JSON — trailing commas
  // before `}` or `]` are valid there and invalid here. Strip them.
  const json = m[1].replace(/,(\s*[\]}])/g, "$1");

  return new Response(json, {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=600",
      ...CORS,
    },
  });
}

// GFW vessel identity lookup. The public gateway.api.globalfishingwatch.org
// endpoint accepts an empty bearer token (`Authorization: Bearer`) so long
// as the request's Origin and Referer come from globalfishingwatch.org —
// same allowance that backs the logged-out vessel search on their map.
// Browsers won't let us forge those headers client-side, so we proxy.
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

// GFW vessel tracks. Same permission shape as /gfw, but responses can
// be enormous (a fortnight of a busy ferry is > 700 KB) so we parse the
// GeoJSON upstream and return a compact { lastPos, trail } shape to
// the client. Trail is decimated to ≤100 points.
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

  // Flatten into parallel coords/times arrays, regardless of whether
  // the geometry is LineString or MultiLineString.
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

async function proxyKiwi(request, host, port, rest) {
  const p = parseInt(port, 10);
  if (!Number.isFinite(p) || p < 1 || p > 65535) {
    return new Response("bad port", { status: 400 });
  }
  // Only allow KiwiSDR-ish path shapes: /<timestamp>/SND|EXT|W%2FF|W/F
  if (!/^\/\d+\/(SND|EXT|W%2FF|W\/F)$/.test(rest)) {
    return new Response("unexpected path", { status: 400 });
  }

  const target = `http://${host}:${port}${rest}`;
  let upstreamResp;
  try {
    upstreamResp = await fetch(target, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        origin: `http://${host}:${port}`,
      },
    });
  } catch (e) {
    console.log(`fetch-throw ${host}:${port}${rest} — ${e.message}`);
    return new Response(`upstream fetch threw: ${e.message}`, { status: 502 });
  }

  const upstream = upstreamResp.webSocket;
  if (!upstream) {
    console.log(`no-ws ${host}:${port}${rest} — status ${upstreamResp.status}`);
    return new Response(`upstream upgrade failed (${upstreamResp.status})`, {
      status: 502,
    });
  }
  console.log(`ok ${host}:${port}${rest}`);
  upstream.accept();

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const relay = (from, to) => {
    from.addEventListener("message", (e) => {
      try { to.send(e.data); } catch {}
    });
    from.addEventListener("close", () => { try { to.close(); } catch {} });
    from.addEventListener("error", () => { try { to.close(); } catch {} });
  };
  relay(server, upstream);
  relay(upstream, server);

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (url.pathname === "/receivers") return receivers();
    if (url.pathname === "/gfw") return gfw(url);
    if (url.pathname === "/gfw/tracks") return gfwTracks(url);

    const m = url.pathname.match(/^\/kiwi\/([^/]+)\/(\d+)(\/.+)$/);
    if (m && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return proxyKiwi(request, m[1], m[2], m[3]);
    }

    return new Response("skywave gateway · /receivers · /kiwi/:host/:port/*", {
      status: 404,
      headers: CORS,
    });
  },
};
