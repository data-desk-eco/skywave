// TDOADO — singleton coordinator for multi-receiver DSC TDOA geolocation.
//
// ReceiverDOs POST detection records here whenever they decode a call.
// Each record carries:
//   - slot (host:port + receiver GPS + band)
//   - call digest (caller MMSI, destination, category, format)
//   - packetGpsNs   — GPS-ns anchor at the decoded packet start
//   - snippet       — ~2 s of Float32 audio around the packet, aligned
//                     to GPS time at sample 0 (startGpsNs)
//
// We bucket incoming detections by (caller MMSI, 30 s time bucket). When
// three or more land in the same bucket, we fine-align each snippet to
// a reference via cross-correlation, derive precise arrival times from
// each snippet's startGpsNs anchor, run solveTdoa, and broadcast the
// result to every WS currently subscribed.
//
// Clients reach this DO through:
//   POST /detect      (ReceiverDO fire-and-forget)
//   GET  /subscribe   (clients; WS upgrade → JSON frames)

import { solveTdoa, xcorr, C as SPEED_OF_LIGHT } from "./tdoa.js";

// Detections stay in memory for PAIR_WINDOW_MS after first arrival; a
// fourth/fifth late receiver within that window can still be added, but
// the solve has already been broadcast by the time we see them (the
// first 3-receiver quorum wins).
const PAIR_WINDOW_MS = 30_000;
const MIN_RECEIVERS  = 3;
// Keep the DO resident across short idle gaps via a pending alarm.
// Cloudflare DOs stay in memory while an alarm is scheduled, so refresh
// one on every ingest: otherwise in-memory buckets can be wiped between
// a same-packet cohort's POSTs (receivers emit within ~3 s of each
// other but the DO can hibernate in seconds).
const KEEPALIVE_MS = 60_000;
// Reject detections that disagree by more than this on wall-clock. Real
// multi-receiver TDOA for the same packet agrees to <10 ms of ordinary
// decoder scheduling jitter plus whatever propagation spread exists
// (≲7 ms within a first skywave hop).
const MAX_SPREAD_MS  = 2_000;

export class TDOADO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // mmsi → [ { firstSeenMs, anchorNs, dets: [...] }, ... ].
    // Buckets are NOT persisted — audio snippets are too heavy, and
    // same-packet bursts arrive within seconds so the DO stays warm
    // across a cohort's POSTs.
    this.buckets = new Map();
    // Ring of recently-seen detections and solves. Persisted so /recent
    // keeps useful info across DO eviction (WS hibernation + idle
    // timeout both wipe in-memory state otherwise).
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
      if (!det) {
        console.log("tdoa/detect: parse failed");
        return Response.json({ ok: false, reason: "bad-record" }, { status: 400 });
      }
      console.log(`tdoa/detect: ok mmsi=${det.call.caller} slot=${det.slotId} samples=${det.snippet.samples.length} recentBefore=${this.recentDets.length} bucketsBefore=${this.buckets.size}`);
      this._logDetection(det);
      this._ingest(det);
      console.log(`tdoa/detect: after recent=${this.recentDets.length} buckets=${this.buckets.size}`);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/recent") {
      console.log(`tdoa/recent: recent=${this.recentDets.length} buckets=${this.buckets.size} solves=${this.recentSolves.length}`);
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
    // Keepalive heartbeat. Reap old buckets; if anything's still open,
    // rearm. Idle TDOADO with nothing pending just lets itself evict.
    this._reap();
    if (this.buckets.size > 0) {
      await this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    }
  }

  async _parseDetection(req) {
    let body;
    try { body = await req.json(); } catch (_) { return null; }
    if (!body || !body.slot || !body.call || !body.snippet) return null;
    if (!body.slot.gps || body.slot.gps.length !== 2) return null;
    if (typeof body.packetGpsNs !== "string") return null;
    const packetGpsNs = BigInt(body.packetGpsNs);
    const s = body.snippet;
    if (!Array.isArray(s.samples) || !s.samples.length) return null;
    const startGpsNs = BigInt(s.startGpsNs);
    return {
      receivedMs: Date.now(),
      slotId: `${body.slot.slot}|${body.slot.band}`,
      gps: body.slot.gps,
      call: body.call,
      packetGpsNs,
      snippet: {
        sampleRate: s.sampleRate,
        startGpsNs,
        samples: Float32Array.from(s.samples),
      },
    };
  }

  // Pair by fuzzy MMSI + GPS-ns proximity. Different receivers decode
  // the same BCD MMSI with different error patterns under noise — one
  // may see "563250300" while another sees "5632??300" and a third
  // "563252??0". Exact-string bucketing splits these into separate
  // cohorts and nothing ever reaches quorum. Compare with '?' as a
  // wildcard instead, and let the bucket carry forward the most
  // complete MMSI it's seen (fewest '?') so the broadcast reports it.
  _ingest(det) {
    this._reap();
    this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS).catch(() => {});
    const mmsi = det.call.caller ?? "?";
    let b = this._findMatchingBucket(mmsi, det.packetGpsNs);
    if (!b) {
      b = {
        mmsi,
        firstSeenMs: det.receivedMs,
        anchorNs: det.packetGpsNs,
        dets: [],
      };
      if (!this.buckets.has(mmsi)) this.buckets.set(mmsi, []);
      this.buckets.get(mmsi).push(b);
    } else if (mmsiQuality(mmsi) > mmsiQuality(b.mmsi)) {
      b.mmsi = mmsi;
    }
    // Dedup by host (not slotId): the same physical KiwiSDR hearing
    // the same burst on two bands gives identical geometry, so the
    // second arrival adds nothing to a TDOA solve. Ignore the extras.
    const detHost = hostOf(det.slotId);
    if (b.dets.some((d) => hostOf(d.slotId) === detHost)) {
      console.log(`tdoa/ingest: dedup same-host ${detHost} mmsi=${mmsi}`);
      return;
    }
    b.dets.push(det);
    console.log(`tdoa/ingest: mmsi=${mmsi} bucketSize=${b.dets.length} slots=${b.dets.map(d=>d.slotId).join(',')}`);

    // Re-solve on every detection past the quorum threshold. Three
    // receivers in 2D leaves a hyperbola-intersection ambiguity; a 4th
    // resolves it, and beyond that the over-determined least-squares
    // solve tightens the estimate. We broadcast each improvement.
    if (b.dets.length >= MIN_RECEIVERS) {
      console.log(`tdoa/solve: trying mmsi=${mmsi} n=${b.dets.length}`);
      let result;
      try {
        result = this._solveBucket(b);
      } catch (e) {
        console.log(`tdoa/solve: threw ${e && e.message}`);
        return;
      }
      if (result) {
        result.quorum = b.dets.length;
        console.log(`tdoa/solve: SUCCESS pos=${result.position.lat.toFixed(3)},${result.position.lon.toFixed(3)} resid=${result.position.residualKm.toFixed(1)}km`);
        this._broadcast(result);
      } else {
        console.log(`tdoa/solve: returned null`);
      }
    }
  }

  _findMatchingBucket(mmsi, packetGpsNs) {
    const spreadNs = BigInt(MAX_SPREAD_MS) * 1_000_000n;
    // Scan all buckets across the Map: fuzzy-match lets a noise-garbled
    // variant of the MMSI join an existing bucket for the same packet.
    // N is small (tens of buckets live simultaneously) so O(N) per
    // ingest is cheap.
    for (const list of this.buckets.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (!mmsiCompatible(mmsi, b.mmsi)) continue;
        let minNs = b.dets[0]?.packetGpsNs ?? b.anchorNs;
        let maxNs = minNs;
        for (const d of b.dets) {
          if (d.packetGpsNs < minNs) minNs = d.packetGpsNs;
          if (d.packetGpsNs > maxNs) maxNs = d.packetGpsNs;
        }
        const lo = packetGpsNs < minNs ? packetGpsNs : minNs;
        const hi = packetGpsNs > maxNs ? packetGpsNs : maxNs;
        if (hi - lo <= spreadNs) return b;
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

  // Core pairing + solve. Cross-correlate each detection's snippet against
  // the reference (first-arrived). The cross-correlation lag, combined
  // with the difference in per-snippet GPS start anchors, yields each
  // receiver's arrival time on a shared clock.
  _solveBucket(bucket) {
    const dets = bucket.dets;
    const ref = dets[0];
    const refSR = ref.snippet.sampleRate;

    // Verify all snippets share a sample rate and aren't absurdly far
    // apart. Widely divergent start times mean we accidentally paired
    // bursts that aren't actually the same packet.
    // Individual KiwiSDRs run at slightly different audio sample rates
    // (~12000 ± a few Hz, depending on each board's clock calibration),
    // so compare with a tolerance instead of strict equality. Timing
    // math later uses each snippet's own sr; a 0.1 % mismatch is a
    // few-sample skew over a 2 s window — well absorbed by xcorr.
    for (const d of dets) {
      const srRatio = d.snippet.sampleRate / refSR;
      if (!(srRatio > 0.99 && srRatio < 1.01)) {
        console.log(`tdoa/solve: reject sr mismatch ref=${refSR} d=${d.snippet.sampleRate} slot=${d.slotId}`);
        return null;
      }
      const dt = Number(d.snippet.startGpsNs - ref.snippet.startGpsNs);
      if (Math.abs(dt) > MAX_SPREAD_MS * 1_000_000) {
        console.log(`tdoa/solve: reject spread dt=${(dt/1e9).toFixed(3)}s limit=${MAX_SPREAD_MS/1000}s slot=${d.slotId} vs ref=${ref.slotId}`);
        return null;
      }
    }

    // For each non-ref detection, find the sample-level lag that best
    // aligns its snippet with the reference, then convert (lag + start-
    // time difference) into a shared-clock arrival delta.
    //
    // ref sample 0 is at t = ref.snippet.startGpsNs.
    // det[k] sample 0 is at t = det.snippet.startGpsNs.
    // If xcorr peaks at lag L samples, then feature at ref-sample F
    // aligns with det-sample F+L, i.e. same feature at:
    //   ref:  t = refStart + F/sr
    //   det:  t = detStart + (F+L)/sr
    // The TRUE arrival at each receiver is some fixed feature time on
    // the wall clock. Call ref's feature time t_ref, det's t_det. Then:
    //   t_det - t_ref = (detStart - refStart) + L/sr
    const solverDets = [ { gps: ref.gps, t: 0 } ];
    const lagsReport = [ { slot: ref.slotId, gps: ref.gps, lagSamples: 0, dtSec: 0 } ];

    // MF first-skywave-hop TDOA is ≲7 ms (2000 km). The xcorr window must
    // cover that PLUS the wall-clock difference between the two snippets'
    // sample-0 anchors, because each receiver chose its own snippet-start
    // moment independently. We size per-pair from startGpsNs.
    const SKYWAVE_SLACK_SEC = 0.015;

    for (let k = 1; k < dets.length; k++) {
      const d = dets[k];
      const startDtSec = Number(d.snippet.startGpsNs - ref.snippet.startGpsNs) / 1e9;
      const maxLag = Math.ceil((Math.abs(startDtSec) + SKYWAVE_SLACK_SEC) * refSR);
      const { lag, peak } = xcorr(ref.snippet.samples, d.snippet.samples, maxLag);
      if (!Number.isFinite(lag) || !Number.isFinite(peak) || peak <= 0) {
        console.log(`tdoa/solve: reject xcorr lag=${lag} peak=${peak} slot=${d.slotId} refLen=${ref.snippet.samples.length} dLen=${d.snippet.samples.length} maxLag=${maxLag} startDt=${startDtSec.toFixed(3)}s`);
        return null;
      }
      const dtSec = startDtSec + lag / refSR;
      solverDets.push({ gps: d.gps, t: dtSec });
      lagsReport.push({ slot: d.slotId, gps: d.gps, lagSamples: lag, dtSec });
    }

    const sol = solveTdoa(solverDets);
    if (!sol) {
      console.log(`tdoa/solve: solveTdoa returned null n=${solverDets.length}`);
      return null;
    }

    return {
      t: "tdoa",
      mmsi: ref.call.caller,
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

// MMSI fuzzy-match helpers. DSC symbols decode to 0–9 digits plus '?'
// for ECC failures; two strings are compatible if they share length and
// every non-'?' position agrees. We keep the most-complete string in
// the bucket so the broadcast carries the cleanest form.
function mmsiCompatible(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a[i], cb = b[i];
    if (ca === "?" || cb === "?") continue;
    if (ca !== cb) return false;
  }
  return true;
}
function mmsiQuality(m) {
  let q = 0;
  for (let i = 0; i < m.length; i++) if (m[i] !== "?") q++;
  return q;
}

// slotId is "host:port|band"; hostOf strips the band so same-host
// multi-band detections collapse for quorum purposes.
function hostOf(slotId) {
  const bar = slotId.indexOf("|");
  return bar < 0 ? slotId : slotId.slice(0, bar);
}
