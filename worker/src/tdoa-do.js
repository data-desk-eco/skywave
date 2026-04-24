// TDOADO — singleton coordinator for multi-receiver DSC TDOA geolocation.
//
// Each ReceiverDO POSTs a detection here whenever its decoder locks on a
// call. The record carries the receiver's GPS, a GPS-ns anchor at the
// packet start, and a ~2 s audio snippet aligned to that anchor. We
// bucket incoming detections by fuzzy MMSI + proximity on packetGpsNs;
// when three distinct hosts land in one bucket we cross-correlate their
// snippets, feed the refined arrival times to solveTdoa, and broadcast
// the position to every client on /subscribe.
//
// Routes:
//   POST /detect      — from ReceiverDO (fire-and-forget)
//   GET  /subscribe   — WS upgrade for clients
//   GET  /recent      — debug snapshot (persisted across eviction)

import { solveTdoa, xcorr } from "./tdoa.js";

const MIN_RECEIVERS  = 3;
// Time window (on packetGpsNs) during which arrivals from different
// receivers count as the same packet. Real MF-first-hop TDOA is ≲7 ms;
// 2 s lets the coordinator absorb any ordinary decoder scheduling skew.
const MAX_SPREAD_MS  = 2_000;
// Bucket lifetime; after this we give up waiting for stragglers.
const PAIR_WINDOW_MS = 30_000;
// Cross-correlation slack above the wall-clock startGpsNs delta. Covers
// skywave propagation within a first hop, no more.
const SKYWAVE_SLACK_SEC = 0.015;
// Keepalive alarm: CF DOs stay resident while an alarm is pending, so
// refresh one on every ingest to keep buckets alive across a cohort.
const KEEPALIVE_MS = 60_000;

export class TDOADO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // mmsi → [ { mmsi, firstSeenMs, dets: [...] }, ... ].
    // Buckets are in-memory only: audio snippets are too heavy to
    // persist, and same-packet cohorts arrive within seconds so the
    // keepalive alarm keeps the DO warm across them.
    this.buckets = new Map();
    // Lightweight persisted rings so /recent survives eviction.
    this.recentDets = [];
    this.recentSolves = [];
    this.state.blockConcurrencyWhile(async () => {
      this.recentDets   = (await this.state.storage.get("recentDets"))   || [];
      this.recentSolves = (await this.state.storage.get("recentSolves")) || [];
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/subscribe") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("websocket required", { status: 400 });
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/detect" && request.method === "POST") {
      const det = await this._parseDetection(request);
      if (!det) return Response.json({ ok: false, reason: "bad-record" }, { status: 400 });
      this._logDetection(det);
      this._ingest(det);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/recent") {
      const openBuckets = [];
      for (const [mmsi, list] of this.buckets) {
        for (const b of list) {
          openBuckets.push({
            mmsi,
            count: b.dets.length,
            slots: b.dets.map((d) => d.slotId),
            firstSeenMs: b.firstSeenMs,
          });
        }
      }
      return Response.json({
        recentDetections: this.recentDets.slice(-50),
        openBuckets,
        recentSolves: this.recentSolves.slice(-20),
      });
    }

    return new Response("tdoa coordinator", { status: 404 });
  }

  async webSocketMessage() {}
  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (_) {}
  }

  async alarm() {
    this._reap();
    if (this.buckets.size > 0) {
      await this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    }
  }

  async _parseDetection(req) {
    let body;
    try { body = await req.json(); } catch (_) { return null; }
    if (!body || !body.slot || !body.call || !body.snippet) return null;
    if (!Array.isArray(body.slot.gps) || body.slot.gps.length !== 2) return null;
    if (typeof body.packetGpsNs !== "string") return null;
    const s = body.snippet;
    if (!Array.isArray(s.samples) || !s.samples.length) return null;
    return {
      receivedMs: Date.now(),
      slotId: `${body.slot.slot}|${body.slot.band}`,
      gps: body.slot.gps,
      call: body.call,
      packetGpsNs: BigInt(body.packetGpsNs),
      snippet: {
        sampleRate: s.sampleRate,
        startGpsNs: BigInt(s.startGpsNs),
        samples: Float32Array.from(s.samples),
      },
    };
  }

  _ingest(det) {
    this._reap();
    // Keepalive: pin the DO in memory across the cohort window.
    this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS).catch(() => {});
    const mmsi = det.call.caller ?? "?";
    let b = this._findMatchingBucket(mmsi, det.packetGpsNs);
    if (!b) {
      b = { mmsi, firstSeenMs: det.receivedMs, dets: [] };
      if (!this.buckets.has(mmsi)) this.buckets.set(mmsi, []);
      this.buckets.get(mmsi).push(b);
    } else if (mmsiQuality(mmsi) > mmsiQuality(b.mmsi)) {
      b.mmsi = mmsi;
    }
    // Dedup by host (not slotId): the same physical KiwiSDR hearing the
    // same burst on two bands adds no new geometry to a TDOA solve.
    const detHost = hostOf(det.slotId);
    if (b.dets.some((d) => hostOf(d.slotId) === detHost)) return;
    b.dets.push(det);

    // Re-solve on every arrival past quorum: a 3-receiver 2D solve has
    // a mirror ambiguity that a 4th collapses; beyond that, the extra
    // overdetermination tightens the estimate. We broadcast each.
    if (b.dets.length >= MIN_RECEIVERS) {
      let result;
      try { result = this._solveBucket(b); } catch (_) { return; }
      if (result) {
        result.quorum = b.dets.length;
        console.log(`tdoa/solve: mmsi=${b.mmsi} pos=${result.position.lat.toFixed(3)},${result.position.lon.toFixed(3)} resid=${result.position.residualKm.toFixed(1)}km q=${b.dets.length}`);
        this._broadcast(result);
      }
    }
  }

  _findMatchingBucket(mmsi, packetGpsNs) {
    const spreadNs = BigInt(MAX_SPREAD_MS) * 1_000_000n;
    // Scan all buckets: fuzzy-match lets noise-garbled MMSI variants
    // (e.g. "563250300" and "5632??300") join the same cohort. N is
    // small (tens of live buckets at once) so O(N) is fine.
    for (const list of this.buckets.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (!mmsiCompatible(mmsi, b.mmsi)) continue;
        // Bucket match requires every detection's anchor — existing +
        // the new one — to lie within MAX_SPREAD_MS end-to-end.
        let minNs = b.dets[0].packetGpsNs, maxNs = minNs;
        for (const d of b.dets) {
          if (d.packetGpsNs < minNs) minNs = d.packetGpsNs;
          if (d.packetGpsNs > maxNs) maxNs = d.packetGpsNs;
        }
        if (packetGpsNs < minNs) minNs = packetGpsNs;
        if (packetGpsNs > maxNs) maxNs = packetGpsNs;
        if (maxNs - minNs <= spreadNs) return b;
      }
    }
    return null;
  }

  _reap() {
    const now = Date.now();
    for (const [mmsi, list] of this.buckets) {
      const kept = list.filter((b) => now - b.firstSeenMs <= PAIR_WINDOW_MS);
      if (kept.length) this.buckets.set(mmsi, kept);
      else this.buckets.delete(mmsi);
    }
  }

  // Cross-correlate each cohort snippet against the reference, combine
  // the xcorr lag with the difference in snippet-start GPS anchors to
  // recover each receiver's arrival time on a shared clock, then let
  // solveTdoa triangulate.
  //
  //   ref:  sample 0 at t = ref.snippet.startGpsNs
  //   det:  sample 0 at t = det.snippet.startGpsNs
  //   feature at ref-sample F aligns with det-sample F+L → same wall
  //   time when  ref.startGpsNs + F/sr  =  det.startGpsNs + (F+L)/sr
  //   so the arrival-time delta t_det − t_ref = startDt + L/sr.
  _solveBucket(bucket) {
    const dets = bucket.dets;
    const ref = dets[0];
    const refSR = ref.snippet.sampleRate;

    // Real KiwiSDRs run at 12 000 ± a few Hz depending on each board's
    // clock calibration. Accept anything within 1 % of the reference.
    for (const d of dets) {
      const ratio = d.snippet.sampleRate / refSR;
      if (!(ratio > 0.99 && ratio < 1.01)) return null;
      const dt = Number(d.snippet.startGpsNs - ref.snippet.startGpsNs);
      if (Math.abs(dt) > MAX_SPREAD_MS * 1_000_000) return null;
    }

    const solverDets = [{ gps: ref.gps, t: 0 }];
    const lagsReport = [{ slot: ref.slotId, gps: ref.gps, lagSamples: 0, dtSec: 0 }];
    for (let k = 1; k < dets.length; k++) {
      const d = dets[k];
      const startDtSec = Number(d.snippet.startGpsNs - ref.snippet.startGpsNs) / 1e9;
      const maxLag = Math.ceil((Math.abs(startDtSec) + SKYWAVE_SLACK_SEC) * refSR);
      const { lag, peak } = xcorr(ref.snippet.samples, d.snippet.samples, maxLag);
      if (!Number.isFinite(lag) || !(peak > 0)) return null;
      const dtSec = startDtSec + lag / refSR;
      solverDets.push({ gps: d.gps, t: dtSec });
      lagsReport.push({ slot: d.slotId, gps: d.gps, lagSamples: lag, dtSec });
    }

    const sol = solveTdoa(solverDets);
    if (!sol) return null;
    return {
      t: "tdoa",
      mmsi: bucket.mmsi,
      call: ref.call,
      position: { lat: sol.lat, lon: sol.lon, residualKm: sol.residualKm },
      receivers: lagsReport,
      packetGpsNs: ref.packetGpsNs.toString(),
      broadcastMs: Date.now(),
    };
  }

  _broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch (_) {}
    }
    this.recentSolves.push({
      mmsi: msg.mmsi,
      position: msg.position,
      quorum: msg.quorum,
      receivers: msg.receivers.map((r) => r.slot),
      broadcastMs: msg.broadcastMs,
    });
    if (this.recentSolves.length > 100) {
      this.recentSolves.splice(0, this.recentSolves.length - 100);
    }
    this.state.storage.put("recentSolves", this.recentSolves).catch(() => {});
  }

  _logDetection(det) {
    this.recentDets.push({
      mmsi: det.call.caller,
      slot: det.slotId,
      gps: det.gps,
      packetGpsNs: det.packetGpsNs.toString(),
      receivedMs: det.receivedMs,
      snippetSamples: det.snippet.samples.length,
    });
    if (this.recentDets.length > 200) {
      this.recentDets.splice(0, this.recentDets.length - 200);
    }
    this.state.storage.put("recentDets", this.recentDets).catch(() => {});
  }
}

// DSC symbols decode to 0-9 plus '?' for ECC failures. Two MMSIs are
// compatible if they share length and every non-'?' position agrees;
// buckets carry forward the cleanest (most non-'?') variant.
function mmsiCompatible(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "?" || b[i] === "?") continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}
function mmsiQuality(m) {
  let q = 0;
  for (let i = 0; i < m.length; i++) if (m[i] !== "?") q++;
  return q;
}

// slotId is "host:port|band". Dedup by the host:port half so the same
// physical KiwiSDR on two bands doesn't double-count toward quorum.
function hostOf(slotId) {
  const bar = slotId.indexOf("|");
  return bar < 0 ? slotId : slotId.slice(0, bar);
}
