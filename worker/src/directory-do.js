// DirectoryDO — singleton bookkeeper. Owns the receiver-list refresh
// (upstream: rx.linkfanel.net) and composes the per-region "front page"
// rack a client should attach to. Traffic doesn't flow through it; it
// just answers HTTP GETs with a JSON rack and lets the client connect
// to each ReceiverDO on its own.
//
// Ref-counting + idle teardown for ReceiverDOs lives inside each
// ReceiverDO (via its own alarm), so this DO stays stateless beyond
// a short in-memory cache of the receiver list.

import { pickRack, regionById, DEFAULT_FANOUT } from "./regions.js";

const RECEIVER_TTL_MS = 10 * 60 * 1000;

export class DirectoryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.receivers = null;
    this.receiversAt = 0;
    this.refreshPromise = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/rack")) {
      const regionId = url.searchParams.get("region") || "global";
      const fanoutRaw = parseInt(url.searchParams.get("fanout") || String(DEFAULT_FANOUT), 10);
      const fanout = Math.min(DEFAULT_FANOUT, Math.max(1, Number.isFinite(fanoutRaw) ? fanoutRaw : DEFAULT_FANOUT));
      return this._handleRack(url, regionId, fanout);
    }
    if (path.endsWith("/refresh")) {
      await this._refresh(true);
      return Response.json({ count: this.receivers ? this.receivers.length : 0 });
    }
    return new Response("skywave directory", { status: 404 });
  }

  async _refresh(force) {
    const now = Date.now();
    if (!force && this.receivers && now - this.receiversAt < RECEIVER_TTL_MS) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const upstream = await fetch("http://rx.linkfanel.net/kiwisdr_com.js", {
        cf: { cacheTtl: 600, cacheEverything: true },
      });
      if (!upstream.ok) throw new Error(`receiver list upstream ${upstream.status}`);
      const text = await upstream.text();
      const m = text.match(/var\s+kiwisdr_com\s*=\s*(\[[\s\S]*\])\s*;?/);
      if (!m) throw new Error("receiver list parse failed");
      // Same trailing-comma scrubbing as the legacy /receivers route.
      const json = m[1].replace(/,(\s*[\]}])/g, "$1");
      this.receivers = JSON.parse(json);
      this.receiversAt = Date.now();
    })();
    try { await this.refreshPromise; }
    finally { this.refreshPromise = null; }
  }

  async _handleRack(url, regionId, fanout) {
    try { await this._refresh(false); }
    catch (e) {
      return Response.json({ error: String(e.message || e) }, { status: 502 });
    }
    const region = regionById(regionId);
    if (!region) {
      return Response.json({ error: "unknown region" }, { status: 400 });
    }
    const picks = pickRack(this.receivers, region.bbox, fanout);
    // The Worker router smuggles the real public origin through on each
    // inbound call so the WS URLs we hand the client are addressable.
    const origin = url.searchParams.get("__origin") || `${url.protocol}//${url.host}`;
    const wsOrigin = origin.replace(/^http/, "ws");

    const slots = picks.map((s) => {
      const q = new URLSearchParams({
        label: s.label,
        lat: String(s.gps[0]),
        lon: String(s.gps[1]),
      });
      return {
        host: s.host,
        port: s.port,
        bandKHz: s.bandKHz,
        band: s.bandLabel,
        label: s.label,
        gps: s.gps,
        snr: s.snr,     // dB, receiver's self-report (null if none)
        coast: s.coast, // degrees to nearest coastal anchor
        wsUrl: `${wsOrigin}/v2/slot/${encodeURIComponent(s.host)}/${s.port}/${s.bandKHz}?${q}`,
      };
    });

    return Response.json(
      { region: region.id, regionName: region.name, slots },
      { headers: {
        "cache-control": "public, max-age=30",
        "access-control-allow-origin": "*",
      } },
    );
  }
}
