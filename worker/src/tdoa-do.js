// TDOADO — singleton coordinator for multi-receiver DSC TDOA geolocation.
//
// Each ReceiverDO POSTs a detection here whenever its decoder locks on a
// call. The record carries the receiver's GPS, a GPS-ns anchor at the
// packet start, and a ~2 s audio snippet aligned to that anchor. We
// bucket incoming detections by fuzzy MMSI + same band + proximity on
// packetGpsNs; when 3+ distinct hosts land in one bucket we
// cross-correlate their snippets, feed the refined arrival times to
// solveTdoa, and broadcast the position to every client on /subscribe.
//
// Operating regime: any band, geometry-gated. Two propagation regimes
// produce real fixes on the public KiwiSDR fleet:
//   · MF ground-wave on a tight cohort (LIG / WAPP / english-channel /
//     dover / etc.) — the cleanest physics, handful of cohorts where the
//     fleet has the density to form quorum.
//   · HF skywave on a globally-spread cohort — produces real fixes when
//     the receiver geometry around the source is good (tight ellipse,
//     low bearing gap), and produces clear ghosts when it isn't. The
//     gates below separate the two well in live data.
// Cross-band buckets are explicitly rejected at ingest: receivers on
// different DSC bands hear different physical transmissions and the
// xcorr between their snippets is noise.
//
// Routes:
//   POST /detect      — from ReceiverDO (fire-and-forget)
//   GET  /subscribe   — WS upgrade for clients
//   GET  /recent      — debug snapshot (persisted across eviction)

import { solveTdoa, xcorr, tdoaUncertainty, C } from "./tdoa.js";

// q=4 minimum. q=3 is exactly determined in 2D, has a mirror ambiguity
// that only q=4 breaks, and residual ≡ 0 by construction — too unreliable
// to publish as a position. Decoded calls still surface in the table
// (presence info); we just don't pretend we know where the source is.
const MIN_RECEIVERS = 4;
// Maximum solver RMS time residual, converted to km (c·Δt). With ~1 ms
// KiwiSDR clock jitter and good ground-wave geometry the floor is
// 100-200 km; 300 km admits all reasonable fixes while catching the
// gross bad-xcorr cases that produce 1000+ km residuals. Belt-and-
// suspenders against the ellipse gate — most ghosts have small residuals
// because the wrong basin is internally self-consistent.
const MAX_RESIDUAL_KM = 300;
// Maximum bearing gap from the solved position to consecutive receivers
// around the compass. >220° means receivers span less than 140° of the
// compass — geometry degenerate enough that the fix is essentially
// unconstrained in the away-from-receivers direction. Ghost basins on
// HF skywave routinely sit at 230-247°.
const MAX_BEARING_GAP_DEG = 220;
// Maximum 1σ position-uncertainty ellipse semi-major (km), assuming
// 1 ms per-receiver timing noise. This is the most discriminating
// signal in live data: real fixes on both MF ground-wave and HF skywave
// land at <600 km; ghost basins (one-sided cohort, near-singular Fisher
// matrix) blow up to 1500-20000 km. 1000 km gives margin around the
// real cluster while catching every ghost we've observed.
const MAX_ELLIPSE_SEMI_MAJOR_KM = 1000;
// Regime detection. Each bucket falls into one of three classes
// based on band + cohort spread; we apply different site-dedup at
// each, and refuse to solve the ambiguous middle.
//
//   ground-wave   — MF, all receivers within ~ground-wave range.
//                   Solver's geodesic assumption matches reality.
//                   5 km dedup (collocations only).
//   long-baseline — HF cohort spread ≫ "fool the solver" range.
//                   Skywave is the actual physics, but the spread is
//                   so large that geometry forces a unique solution
//                   near the truth even with the wrong propagation
//                   model. Adaptive dedup at max_pairwise/20.
//   ambiguous     — anything else: HF cohorts in the 100-5000 km
//                   middle zone, or unusually-wide MF cohorts.
//                   The PALATINE/AWTAD/ISABELITA failure mode lives
//                   here. Refuse to solve.
//
// Re-classified on every arrival, so a bucket that starts ambiguous
// (3 European HF receivers) and gains a distant straggler (NZ) can
// transition to long-baseline mid-life.
const GROUND_WAVE_MAX_SPAN_KM = 1500;
const LONG_BASELINE_MIN_SPAN_KM = 5000;
const GROUND_WAVE_DEDUP_KM = 5;
const LONG_BASELINE_DEDUP_MIN_KM = 500;
const LONG_BASELINE_DEDUP_FACTOR = 20;
// Time window (on packetGpsNs) during which arrivals from different
// receivers count as the same packet. Real MF-ground-wave TDOA is ≲4 ms
// even for the longest baselines we'd consider; 2 s lets the
// coordinator absorb any ordinary decoder scheduling skew.
const MAX_SPREAD_MS = 2_000;
// Bucket lifetime; after this we give up waiting for stragglers.
const PAIR_WINDOW_MS = 30_000;
// Cross-correlation slack above the wall-clock startGpsNs delta.
// Ground-wave on MF is at c, so any pair across our cohort
// (≤1500 km baseline) arrives within 5 ms of the snippet anchor.
const PROPAGATION_SLACK_SEC = 0.010;
// Keepalive alarm: CF DOs stay resident while an alarm is pending, so
// refresh one on every ingest to keep buckets alive across a cohort.
const KEEPALIVE_MS = 60_000;

export class TDOADO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buckets = new Map();        // mmsi → [{mmsi, firstSeenMs, dets[]}]
    this.recentDets = [];
    this.recentSolves = [];
    this.rejections = {};            // gate → count, observability only
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
    this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS).catch(() => {});
    const mmsi = det.call.caller ?? "?";
    let b = this._findMatchingBucket(mmsi, det.band, det.packetGpsNs);
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
        result.quorum = result.receivers.length;
        console.log(`tdoa/solve: regime=${result.regime} mmsi=${b.mmsi} pos=${result.position.lat.toFixed(3)},${result.position.lon.toFixed(3)} resid=${result.position.residualKm.toFixed(1)}km q=${result.quorum} ellipse=${result.geometry.ellipseSemiMajorKm}km`);
        this._broadcast(result);
      }
    }
  }

  _findMatchingBucket(mmsi, band, packetGpsNs) {
    const spreadNs = BigInt(MAX_SPREAD_MS) * 1_000_000n;
    for (const list of this.buckets.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (!mmsiCompatible(mmsi, b.mmsi)) continue;
        // Same-band only: cross-band xcorr is noise (different transmissions).
        if (b.dets[0].band !== band) continue;
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
  //
  // The reference is the cohort's cleanest decode (highest mmsiQuality):
  // every other receiver's snippet is correlated against it, so picking
  // a noisy template (the old "first arrival" default) directly inflates
  // the lag estimate noise on every other receiver.
  //
  // Regime classification + per-regime site-dedup runs first; ambiguous
  // cohorts (the PALATINE/ISABELITA middle zone) are refused outright.
  // Surviving cohorts are deduped at the regime-appropriate scale, and
  // the cleanest decode in each cluster wins (becoming the xcorr
  // reference by virtue of `dedupByLocation` returning cleanest-first).
  _solveBucket(bucket) {
    const regime = classifyRegime(bucket.dets);
    if (!regime) {
      this.rejections.regime = (this.rejections.regime || 0) + 1;
      return null;
    }
    const dets = dedupByLocation(bucket.dets, regime.dedupKm);
    if (dets.length < MIN_RECEIVERS) {
      this.rejections.dedup = (this.rejections.dedup || 0) + 1;
      return null;
    }
    const ref = dets[0];
    const refSR = ref.snippet.sampleRate;

    // KiwiSDRs run at 12 000 ± a few Hz. Accept anything within 1 % of
    // the reference; reject pairs whose snippet anchors are wildly out.
    for (const d of dets) {
      const ratio = d.snippet.sampleRate / refSR;
      if (!(ratio > 0.99 && ratio < 1.01)) return null;
      const dt = Number(d.snippet.startGpsNs - ref.snippet.startGpsNs);
      if (Math.abs(dt) > MAX_SPREAD_MS * 1_000_000) return null;
    }

    const solverDets = [{ gps: ref.gps, t: 0 }];
    const lagsReport = [{ slot: ref.slotId, label: ref.label, band: ref.band, gps: ref.gps, lagSamples: 0, dtSec: 0 }];
    for (let k = 1; k < dets.length; k++) {
      const d = dets[k];
      const startDtSec = Number(d.snippet.startGpsNs - ref.snippet.startGpsNs) / 1e9;
      const maxLag = Math.ceil((Math.abs(startDtSec) + PROPAGATION_SLACK_SEC) * refSR);
      const { lag, peak } = xcorr(ref.snippet.samples, d.snippet.samples, maxLag);
      if (!Number.isFinite(lag) || !(peak > 0)) return null;
      const dtSec = startDtSec + lag / refSR;
      solverDets.push({ gps: d.gps, t: dtSec });
      lagsReport.push({ slot: d.slotId, label: d.label, band: d.band, gps: d.gps, lagSamples: lag, dtSec });
    }

    const sol = solveTdoa(solverDets);
    if (!sol) return null;

    const pos = [sol.lat, sol.lon];
    const rej = (gate) => {
      this.rejections[gate] = (this.rejections[gate] || 0) + 1;
      console.log(`tdoa/reject: gate=${gate} mmsi=${bucket.mmsi} q=${dets.length} pos=${pos[0].toFixed(2)},${pos[1].toFixed(2)} resid=${sol.residualKm.toFixed(0)}km`);
      return null;
    };

    // 1. Residual gate. Belt-and-suspenders against bad xcorr lags;
    //    most ghosts have small residuals (the wrong basin is
    //    internally consistent) so this gate rarely fires alone.
    if (sol.residualKm > MAX_RESIDUAL_KM) return rej("residual");

    // 2. Bearing-gap gate. Cheap geometric proxy for one-sided cohorts.
    //    Catches the worst wedge geometries (gap > 220°) before we
    //    bother computing the ellipse.
    const bearings = solverDets
      .map((d) => bearingFromTo(pos, d.gps))
      .sort((a, b) => a - b);
    let maxGap = 360 - (bearings[bearings.length - 1] - bearings[0]);
    for (let i = 1; i < bearings.length; i++) {
      const g = bearings[i] - bearings[i - 1];
      if (g > maxGap) maxGap = g;
    }
    if (maxGap > MAX_BEARING_GAP_DEG) return rej("bearing");

    // 3. Ellipse gate. Direct measurement of position uncertainty given
    //    cohort geometry + 1 ms timing noise: a singular Fisher matrix
    //    blows the semi-major axis up to thousands of km. The strongest
    //    single signal — separates the convergent S China Sea AtoN
    //    (semi-major ~200 km) from the Falmouth-coast-station-fixing-
    //    in-Coral-Sea ghost (semi-major ~1900 km) cleanly.
    const ellipse = tdoaUncertainty(solverDets, pos, 1.0);
    if (ellipse && ellipse.semiMajorKm > MAX_ELLIPSE_SEMI_MAJOR_KM) {
      return rej("ellipse");
    }

    let furthestRxKm = 0, nearestRxKm = Infinity;
    for (const d of dets) {
      const dKm = gcDistanceKm(pos, d.gps);
      if (dKm > furthestRxKm) furthestRxKm = dKm;
      if (dKm < nearestRxKm) nearestRxKm = dKm;
    }

    return {
      t: "tdoa",
      regime: regime.name,
      mmsi: bucket.mmsi,
      call: ref.call,
      position: { lat: sol.lat, lon: sol.lon, residualKm: sol.residualKm },
      receivers: lagsReport,
      geometry: {
        maxBearingGapDeg: +maxGap.toFixed(1),
        furthestReceiverKm: +furthestRxKm.toFixed(0),
        nearestReceiverKm: Number.isFinite(nearestRxKm) ? +nearestRxKm.toFixed(0) : null,
        ellipseSemiMajorKm: ellipse ? +ellipse.semiMajorKm.toFixed(0) : null,
        ellipseSemiMinorKm: ellipse ? +ellipse.semiMinorKm.toFixed(0) : null,
        ellipseOrientationDeg: ellipse ? +ellipse.orientationDeg.toFixed(0) : null,
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
      regime: msg.regime,
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

// Greedy site-dedup: walk detections cleanest-decode-first, keep each
// only if it's ≥ radiusKm from every already-kept one. Returned list
// is in keep-order, so dets[0] is the cohort-wide cleanest decode —
// the natural reference for the xcorr template.
function dedupByLocation(dets, radiusKm) {
  const sorted = [...dets].sort(
    (a, b) => mmsiQuality(b.call.caller) - mmsiQuality(a.call.caller),
  );
  const keep = [];
  for (const d of sorted) {
    if (keep.every((k) => gcDistanceKm(d.gps, k.gps) >= radiusKm)) keep.push(d);
  }
  return keep;
}

// Compute the maximum pairwise distance (km) among the cohort. O(N²)
// over typically 3-10 detections — trivially cheap.
function cohortMaxPairwiseKm(dets) {
  let max = 0;
  for (let i = 0; i < dets.length; i++) {
    for (let j = i + 1; j < dets.length; j++) {
      const d = gcDistanceKm(dets[i].gps, dets[j].gps);
      if (d > max) max = d;
    }
  }
  return max;
}

// Classify the cohort's propagation regime from band + spread. Returns
// { name, dedupKm } for solvable regimes, or null for ambiguous (which
// the caller treats as "refuse to solve"). All bucket dets share a
// band by ingest invariant, so we can read it off dets[0].
function classifyRegime(dets) {
  if (!dets.length) return null;
  const band = dets[0].band;
  const span = cohortMaxPairwiseKm(dets);
  if (band === "MF") {
    if (span <= GROUND_WAVE_MAX_SPAN_KM) {
      return { name: "ground-wave", dedupKm: GROUND_WAVE_DEDUP_KM };
    }
    return null;
  }
  if (span >= LONG_BASELINE_MIN_SPAN_KM) {
    return {
      name: "long-baseline",
      dedupKm: Math.max(LONG_BASELINE_DEDUP_MIN_KM, span / LONG_BASELINE_DEDUP_FACTOR),
    };
  }
  return null;
}

// slotId is "host:port|band". Dedup by the host:port half so the same
// physical KiwiSDR on two bands doesn't double-count toward quorum.
function hostOf(slotId) {
  const bar = slotId.indexOf("|");
  return bar < 0 ? slotId : slotId.slice(0, bar);
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
