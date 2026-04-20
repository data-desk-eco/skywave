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
  const cache = caches.default;
  const cacheKey = new Request("https://skywave-gateway/receivers");
  let resp = await cache.match(cacheKey);
  if (resp) return resp;

  const upstream = await fetch(
    "http://rx.linkfanel.net/kiwisdr_com.js?t=" + Date.now(),
    { cf: { cacheTtl: 600 } },
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

  resp = new Response(m[1], {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=600",
      ...CORS,
    },
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
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
  const upstreamResp = await fetch(target, {
    headers: {
      upgrade: "websocket",
      connection: "upgrade",
      // KiwiSDR checks origin loosely; forward a safe one
      origin: `http://${host}:${port}`,
    },
  });

  const upstream = upstreamResp.webSocket;
  if (!upstream) {
    return new Response(`upstream upgrade failed (${upstreamResp.status})`, {
      status: 502,
    });
  }
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
