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

import { solveTdoa, xcorr, tdoaUncertainty, C } from "./tdoa.js";

// Two-tier quorum: 3-receiver fixes are exactly-determined in 2D, so
// `residualKm` is meaningless there — they can still be correct but
// we can't verify. They're broadcast as `preliminary` and only if the
// geometry is stricter (max bearing gap ≤ 120°). 4+ receivers have
// one degree of overdetermination, so the residual is a real quality
// signal and the broadcast tier is `confirmed`.
const MIN_RECEIVERS  = 3;
const CONFIRMED_MIN_RECEIVERS = 4;
// (Previously we used a stricter bearing-gap threshold for the
// preliminary / q=3 tier because there's no residual safety net
// at exactly-determined dimensionality. Live data showed this was
// rejecting real n-sea surround fixes where bearings span 160°
// naturally. With the residual gate now applied at all quorums,
// the bearing threshold collapses to a single value.)
// Maximum solver RMS time residual, converted to km (c·Δt). The
// physical floor with realistic 1 ms KiwiSDR clock jitter on good
// geometry (e.g. FJELD SVEA cohort, ~150° max bearing gap) is 100-
// 200 km — verified by simulation. 250 km admits all reasonable
// fixes given that floor while still catching the ghost-basin /
// bad-xcorr cases that produce 1000+ km residuals.
const MAX_RESIDUAL_KM = 250;
// Maximum permitted angular gap between consecutive receivers as seen
// from the solved position. The hard limit is 360° (degenerate). 180°
// is the textbook surround threshold but live data showed the
// realistic floor for valid cohorts is ~150-180°; clipping at exactly
// 180° was rejecting edge-of-cluster fixes that were actually correct.
// 220° is calibrated to admit those while still catching SUNNY-KEROUANE-
// class cohorts where every receiver is on one side of the world from
// the solved position.
const MAX_BEARING_GAP_DEG = 220;
// Maximum semi-major axis of the 1-σ position uncertainty ellipse
// derived from cohort geometry + 1 ms timing noise. Replaces the
// bearing-gap heuristic with a principled measure: the ellipse is
// the right answer for "how well constrained is this fix in any
// direction". Anything above 1000 km along the major axis means the
// geometry can't pin the position to better than continent-scale —
// reject regardless of how clean the residual happens to be.
// FJELD-class surround geometry gives ~250 km semi-major; SUNNY-
// class one-sided gives ~6500 km; collinear gives ~1200 km.
const MAX_ELLIPSE_SEMIMAJOR_KM = 1000;
// Per-band sanity ceiling on receiver-to-solution distance. A solve
// placing the transmitter beyond the band's plausible propagation
// range from even one receiver is mathematically possible (the
// hyperbolas still intersect) but physically implausible. MF ground-
// wave caps at ~1500 km; HF extends much further via F2 skip.
const MAX_RANGE_KM_BY_BAND = {
  MF:   2000,
  HF4:  5000,
  HF6:  7000,
  HF8:  10000,
  HF12: 15000,
  HF16: 20000,
};
// Leave-one-out cross-validation: at q≥5 we re-solve N times, each
// excluding one receiver. If the resulting positions agree (median
// pairwise distance below this threshold), the cohort is internally
// consistent. If they scatter, one or more receivers' timing is
// suspect — even when the residual happens to look reasonable. This
// is the gate intended to separate "224 km off truth" from "2171 km
// off truth" cases that have indistinguishable residuals.
const LOO_MAX_SCATTER_KM = 250;
// Minimum cross-correlation peak prominence (peak / max-off-peak) on
// the weakest receiver pair. Below this the lag the solver got is
// not just noisy but indistinguishable from random correlation.
// Calibrated against live data: every implausible fix observed had
// prominence in the 1.04-1.15 band, while clean DSC bursts in the
// synthetic e2e test produce values >5. 1.8 admits marginal-but-real
// peaks while rejecting the noise-floor matches that are responsible
// for most of the "good residual but wildly wrong position" cases.
const MIN_XCORR_PROMINENCE = 1.8;
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
    // In-memory gate counters for observability. Not persisted — they
    // reset when the DO evicts, which is fine for tuning sessions.
    this.rejections = {};
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
        rejections: this.rejections,
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
      label: body.slot.label,
      band: body.slot.band,
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
        // Quorum reported to clients reflects the POST-TRIM cohort (the
        // receivers that actually contributed to the final solve).
        // `geometry.originalQuorum` preserves the pre-trim count so
        // operators can see how much outlier rejection happened.
        result.quorum = result.receivers.length;
        const trimmed = result.geometry?.trimmedReceivers || 0;
        console.log(`tdoa/solve: mmsi=${b.mmsi} pos=${result.position.lat.toFixed(3)},${result.position.lon.toFixed(3)} resid=${result.position.residualKm.toFixed(1)}km q=${result.quorum}${trimmed ? `/${b.dets.length}` : ""}`);
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
    const lagsReport = [{ slot: ref.slotId, label: ref.label, band: ref.band, gps: ref.gps, lagSamples: 0, dtSec: 0 }];
    let minProminence = Infinity;
    for (let k = 1; k < dets.length; k++) {
      const d = dets[k];
      const startDtSec = Number(d.snippet.startGpsNs - ref.snippet.startGpsNs) / 1e9;
      const maxLag = Math.ceil((Math.abs(startDtSec) + SKYWAVE_SLACK_SEC) * refSR);
      const { lag, peak, prominence } = xcorr(ref.snippet.samples, d.snippet.samples, maxLag);
      if (!Number.isFinite(lag) || !(peak > 0)) return null;
      if (prominence < minProminence) minProminence = prominence;
      const dtSec = startDtSec + lag / refSR;
      solverDets.push({ gps: d.gps, t: dtSec });
      lagsReport.push({ slot: d.slotId, label: d.label, band: d.band, gps: d.gps, lagSamples: lag, dtSec });
    }

    // Robust iteratively-reweighted solve. Do the main solve, compute
    // per-receiver arrival-time residuals, and if one receiver's
    // contribution dominates (>3× median) drop it and re-solve. Repeat
    // up to TRIM_ITERS rounds. One bad xcorr lag in an 8-receiver
    // cohort can wrench the least-squares solution by hundreds of km;
    // this iteratively walks the solver toward the set of receivers
    // whose timing is mutually consistent. Keeps minCohortSize of 4
    // so we don't trim past the confirmed-tier threshold.
    const TRIM_ITERS = 3, TRIM_MIN_COHORT = 4, TRIM_MEDIAN_MULTIPLE = 3;
    let workingDets = solverDets;
    let workingLags = lagsReport;
    let sol = solveTdoa(workingDets);
    if (!sol) return null;
    let trimmedReceivers = [];
    for (let iter = 0; iter < TRIM_ITERS && workingDets.length > TRIM_MIN_COHORT; iter++) {
      const refGps = workingDets[0].gps;
      const posRef = [sol.lat, sol.lon];
      const d0 = gcDistanceKm(posRef, refGps) * 1000;
      const perDetResid = workingDets.map((d, i) => {
        if (i === 0) return 0;
        const di = gcDistanceKm(posRef, d.gps) * 1000;
        const predDt = (di - d0) / C;
        return Math.abs(d.t - predDt);
      });
      // Median over the non-zero entries (i=0 is reference, always 0).
      const nonRef = perDetResid.slice(1).sort((a, b) => a - b);
      const med = nonRef[Math.floor(nonRef.length / 2)] || 1e-9;
      let worstIdx = 0, worst = 0;
      for (let i = 1; i < perDetResid.length; i++) {
        if (perDetResid[i] > worst) { worst = perDetResid[i]; worstIdx = i; }
      }
      // Only drop when the worst pair's residual is a clear outlier.
      if (worst < TRIM_MEDIAN_MULTIPLE * med) break;
      const droppedLag = workingLags[worstIdx];
      const nextDets = workingDets.filter((_, i) => i !== worstIdx);
      const nextLags = workingLags.filter((_, i) => i !== worstIdx);
      const nextSol = solveTdoa(nextDets);
      // Only accept the trim if residual actually improves — a worst-
      // pair outlier that happens to be geometrically load-bearing can
      // leave the remaining receivers degenerate.
      if (!nextSol || nextSol.residualKm >= sol.residualKm) break;
      workingDets = nextDets;
      workingLags = nextLags;
      sol = nextSol;
      trimmedReceivers.push(droppedLag.slot);
    }
    // Use the trimmed cohort for the rest of the gates + broadcast.
    // `dets` is the original KiwiSDR detections list; we only need the
    // indices that survived to check band-range, so keep that mapping.
    const trimmedSet = new Set(trimmedReceivers);
    const keptDets = dets.filter((d, i) => !trimmedSet.has(lagsReport[i].slot));
    // Expose the trimmed count in the broadcast payload so operators
    // can see how much outlier-rejection work happened.
    const lagsReportOut = workingLags;
    if (!sol) return null;

    // Note: minProminence is a candidate reliability signal (the
    // weakest pair's xcorr peak-over-noise ratio). We report it on
    // every solve via the geometry payload so we can observe the
    // real-world distribution before committing to a threshold —
    // gating on a blind guess would just rediscover bearing-prelim.

    // Reliability gates — see constants at the top of the file for the
    // rationale. A rejected solve returns null so _ingest() silently
    // drops it rather than broadcasting a low-confidence fix. We also
    // bump a counter per gate so /recent can show how many solves got
    // dropped and by which gate, useful for threshold tuning.
    const pos = [sol.lat, sol.lon];
    const rej = (gate) => {
      this.rejections[gate] = (this.rejections[gate] || 0) + 1;
      console.log(`tdoa/reject: gate=${gate} mmsi=${bucket.mmsi} q=${dets.length} pos=${pos[0].toFixed(2)},${pos[1].toFixed(2)} resid=${sol.residualKm.toFixed(0)}km`);
      return null;
    };

    // Tier: ≥4 receivers with a passing residual = `confirmed`; a
    // 3-receiver fix = `preliminary` (no residual check possible) and
    // must pass a stricter bearing gap.
    // The "dets" used below for gates is the POST-TRIM cohort
    // (`keptDets`) — after the robust solver discarded outlier
    // receivers. Geometry and range checks apply to the cohort that
    // actually contributed to the final solve, not the raw detections.
    const effectiveDets = keptDets;
    const confirmed = effectiveDets.length >= CONFIRMED_MIN_RECEIVERS;
    const tier = confirmed ? "confirmed" : "preliminary";

    // Note: xcorr peak prominence (`minProminence`) is reported in the
    // geometry payload but is NOT gated. DSC FSK with two tones (1615 /
    // 1785 Hz) at 100 baud has strong correlation sidelobes everywhere
    // due to the periodic symbol structure: even a wide exclusion
    // window around the main peak finds substantial off-peak energy in
    // real captures (observed range 1.01-1.36 for both consistent and
    // inconsistent fixes). It's still useful telemetry for tuning
    // experiments but doesn't separate good from bad in the way it
    // would for a noise-like waveform.

    // 1. Residual. At q=3 the solver is exactly-determined so the
    //    residual should be ~0 in the cleanly-solvable case — but when
    //    the cohort's measured arrival times can't satisfy any triplet
    //    of hyperbolas, the coarse search lands somewhere with a
    //    notable residual. That's a real quality signal even at q=3
    //    (we see 1000+ km residuals when the geometry's degenerate),
    //    so the gate applies at all quorums.
    if (sol.residualKm > MAX_RESIDUAL_KM) return rej("residual");

    // 2. Bearing spread. Uniform threshold across tiers now — the
    //    residual gate handles the "unsolvable" cases at q=3.
    const bearings = workingDets
      .map((d) => bearingFromTo(pos, d.gps))
      .sort((a, b) => a - b);
    let maxGap = 360 - (bearings[bearings.length - 1] - bearings[0]);
    for (let i = 1; i < bearings.length; i++) {
      const g = bearings[i] - bearings[i - 1];
      if (g > maxGap) maxGap = g;
    }
    if (maxGap > MAX_BEARING_GAP_DEG) return rej("bearing");

    // 3. Band-range: each receiver must be within its band's plausible
    //    propagation radius of the solve. Rejects SUNNY-KEROUANE-class
    //    fixes where the solver put an Asian ship in Romania despite
    //    one receiver being in SE Asia — the Asian receiver would have
    //    been >10 000 km from the fake European fix.
    for (let i = 0; i < effectiveDets.length; i++) {
      const band = bandOf(effectiveDets[i].slotId);
      const maxKm = MAX_RANGE_KM_BY_BAND[band];
      if (maxKm == null) continue;                // unknown band → skip check
      if (gcDistanceKm(pos, effectiveDets[i].gps) > maxKm) return rej("band-range");
    }

    // 4. Position uncertainty ellipse from cohort geometry + 1 ms
    //    timing noise. Reject fixes whose semi-major axis exceeds
    //    MAX_ELLIPSE_SEMIMAJOR_KM — those positions are not
    //    constrained well enough to be trusted, even if every other
    //    metric looks clean. This is the principled GDOP gate that
    //    replaces the rule-of-thumb bearing-gap heuristic.
    const ellipse = tdoaUncertainty(workingDets, pos, 1.0);
    if (ellipse && ellipse.semiMajorKm > MAX_ELLIPSE_SEMIMAJOR_KM) {
      return rej("geometry-uncertainty");
    }

    // 5. Leave-one-out scatter — kept as a TELEMETRY metric (reported
    //    in the geometry payload) but no longer a hard gate. In
    //    practice ghost-basin solves where every receiver's timing
    //    fits the same wrong location pass LOO with low scatter, so
    //    the gate didn't reject what it was meant to. Computed only
    //    at q≥5 where it has meaning.
    let looScatter = null;
    if (workingDets.length >= 5) {
      const looPositions = [];
      for (let drop = 0; drop < workingDets.length; drop++) {
        const subset = workingDets.filter((_, i) => i !== drop);
        const sub = solveTdoa(subset);
        if (sub) looPositions.push([sub.lat, sub.lon]);
      }
      if (looPositions.length >= 3) {
        const dists = [];
        for (let i = 0; i < looPositions.length; i++) {
          for (let j = i + 1; j < looPositions.length; j++) {
            dists.push(gcDistanceKm(looPositions[i], looPositions[j]));
          }
        }
        dists.sort((a, b) => a - b);
        looScatter = dists[Math.floor(dists.length / 2)];
      }
    }

    return {
      t: "tdoa",
      tier,                                       // "confirmed" | "preliminary"
      mmsi: bucket.mmsi,
      call: ref.call,
      position: { lat: sol.lat, lon: sol.lon, residualKm: sol.residualKm },
      receivers: lagsReportOut,       // post-trim receivers only
      geometry: {
        maxBearingGapDeg: +maxGap.toFixed(1),
        minXcorrProminence: Number.isFinite(minProminence) ? +minProminence.toFixed(2) : null,
        looScatterKm: looScatter != null ? +looScatter.toFixed(1) : null,
        trimmedReceivers: trimmedReceivers.length,
        originalQuorum: dets.length,
        ellipseSemiMajorKm: ellipse ? +ellipse.semiMajorKm.toFixed(0) : null,
        ellipseSemiMinorKm: ellipse ? +ellipse.semiMinorKm.toFixed(0) : null,
        ellipseOrientationDeg: ellipse ? +ellipse.orientationDeg.toFixed(0) : null,
        ellipseAxisRatio: ellipse ? +ellipse.axisRatio.toFixed(1) : null,
      },
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
      tier: msg.tier,
      position: msg.position,
      quorum: msg.quorum,
      geometry: msg.geometry,
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

function bandOf(slotId) {
  const bar = slotId.indexOf("|");
  return bar < 0 ? null : slotId.slice(bar + 1);
}

// Great-circle distance (km) between two [lat, lon] degree pairs.
function gcDistanceKm(a, b) {
  const R = 6371;
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const dla = la2 - la1;
  const dlo = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(dla / 2) ** 2
          + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial compass bearing from `from` to `to` in degrees, 0 = north.
function bearingFromTo(from, to) {
  const la1 = from[0] * Math.PI / 180, la2 = to[0] * Math.PI / 180;
  const dlo = (to[1] - from[1]) * Math.PI / 180;
  const y = Math.sin(dlo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
