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

import { solveTdoa, tdoaUncertainty, farFieldCheck, nearestSubsetIdx, C } from "./tdoa.js";
import { estimateDt, hilbert, resample } from "./toa.js";
import { lsegLookupMmsi } from "./lseg.js";
import { densityPenaltyDex } from "./density.js";
import { coastRegistryCheck, REGISTRY_MAX_KM } from "./coast-registry.js";

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
// Regime detection. Used only to pick the right site-dedup radius:
//
//   ground-wave   — MF, all receivers within ~ground-wave range.
//                   Solver's geodesic assumption matches reality.
//                   5 km dedup (collocations only).
//   long-baseline — everything else (any HF cohort, or wide MF).
//                   Skywave is the actual physics; clustered
//                   receivers contribute the same constraint, so
//                   adaptive dedup at max(500 km, max_pairwise/20)
//                   collapses near-duplicates and lets the post-solve
//                   ellipse + bearing-gap gates judge what survives.
//
// Earlier iterations refused to solve the "ambiguous middle" (HF
// cohorts with 100-5000 km spread) at the regime stage. Live data
// showed the ellipse gate had headroom to spare (zero firings in 87
// minutes), so the regime check was doubly conservative — turning
// it from a rejection into just a dedup-radius selector lets more
// fixes attempt to solve, with the post-solve gates doing the actual
// quality filtering. AWTAD/PALATINE-class cohorts (clustered HF
// receivers) collapse to ≤1 effective receiver under long-baseline
// dedup, then fail the q≥4 check at the dedup gate.
const GROUND_WAVE_MAX_SPAN_KM = 1500;
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
// Minimum envelope peak-to-floor ratio for a cross-correlation pair to
// count. Live Channel pairs with verified geometry measure 2.5-3.8;
// unlocked/noise pairs sit near 1. Rejected pairs are dropped from the
// cohort individually (counted under `pair`), not fatal to the bucket.
const MIN_PEAK_RATIO = 2.0;
// AIS oracle (vessels only; coast stations have the registry gate).
// The one failure mode no internal signal can catch — proven live
// 2026-07-03: a q=4 night cohort heard ESVAGT OBSERVER ~970 km away
// off Shetland via 1-hop skywave, and the path-difference timings fit
// a mid-Channel geodesic source with 0.8 km residual and a 102x
// far-field ratio. Internally flawless, externally provably wrong —
// fresh AIS (LSEG) at fix time is the only counter. A fix implying
// > AIS_MAX_IMPLIED_KN from the last AIS point is rejected; lookup
// failures and missing credentials never block a broadcast.
const AIS_MAX_IMPLIED_KN = 60;
const AIS_MAX_AGE_H = 12;
// Keepalive alarm: CF DOs stay resident while an alarm is pending, so
// refresh one on every ingest to keep buckets alive across a cohort.
const KEEPALIVE_MS = 60_000;
// Vessel-density prior for dual-basin disambiguation. Score per
// candidate basin is `residualKm + λ · densityPenaltyDex(la, lo)`,
// where the penalty is in log10(vessel-hours) below the global busiest
// cell (~0 for Hormuz / Singapore / English Channel, ~7-8 for empty
// Southern Ocean). λ is in km per dex; with λ = 100 a single-dex
// difference in shipping density buys 100 km of residual headroom.
//
// Calibrated against captured ghosts:
//   NEWRESOURCE  truth Δdex=2.5  wrong Δdex=6.3  →  Δ=380 km headroom
//   EUPHONY ACE  truth Δdex=2.8  wrong Δdex=3.5  →  Δ=78 km headroom
// The headroom only needs to outweigh the residual gap between the
// two basins (typically <100 km when both are good fits), so 100 is
// enough margin to flip the EUPHONY case while leaving room for the
// residual to dominate when it's actually decisive. Bigger λ would
// over-weight the prior and pull single-basin fixes toward shipping
// lanes; smaller λ would fail EUPHONY-class cases.
const PRIOR_LAMBDA_KM = 100;
// Far-field gate. Reject when a plane wave explains the measured
// timings nearly as well as the point fix: the cohort then carries no
// range information and the "fix" is an arbitrary basin (the night-MF-
// skywave failure mode — Channel cohorts hearing Lyngby/Civitavecchia/
// Aegean traffic 750-2400 km away and solving local ghosts).
//
// Calibration (scripts/test_farfield.mjs, synthetic Channel cohort):
// sources ≤300 km from the cohort give planeResid/pointResid ≥ 2.8
// (p10) at 0.1 ms timing noise with fix errors ≤50 km; sources
// ≥800 km give ratio ≈ 1 and 200+ km errors. Live ghosts measured
// 1.12 (q=8) and 1.59 (q=5). The ratio doubles as an accuracy gate:
// cohorts whose ratio is below ~2 produce >100 km errors even when the
// source is real, because timing noise has drowned the curvature.
// 2.5 (up from the initial 2.0) kills the marginal rescue leaks in the
// far-source synthetics without costing any recovered real fix — the
// recovered Milford-class fixes measure 2.65-5.23, the far-source
// leaks 2.02-2.39. The absolute floor handles tiny-residual q=4 cases
// where both fits are near-exact and the ratio becomes noise.
const FARFIELD_MIN_RATIO = 2.5;
// q=4 leaves the plane fit a single degree of freedom, so the ratio is
// noisy and far sources leak through the 2.5 threshold (live case:
// AIDAdiva at Bergen ghost-fixed inland England at ratio 2.65, q=4).
// Synthetic q=4 calibration: real near sources measure ratio p50 ≈ 10
// (78% above 3.5), far skywave sources p50 ≈ 1.1 (11% leak at 3.5).
const FARFIELD_MIN_RATIO_Q4 = 4.0;
const FARFIELD_ABS_FLOOR_KM = 30;
// Mixed-cohort rescue (see _solveBucket): when a big cohort's full
// solve would fail the residual or far-field gate, re-solve on the 6
// receivers nearest the initial fix. Only cohorts comfortably larger
// than the subset get rescued — rescuing q=6 down to 6 is a no-op and
// q=7→6 barely sheds contamination.
const RESCUE_MIN_COHORT = 7;
const RESCUE_SUBSET_K = 6;
// Known-position registry gate for coast stations: a fix further than
// REGISTRY_MAX_KM from every registered site for that MMSI is provably
// wrong no matter how clean the geometry looked (see coast-registry.js).
// Multi-burst convergence telemetry. For each MMSI we keep the last
// few fixes within a sliding window; on each new fix we report how
// many of the recent ones land within CONVERGENCE_AGREE_KM of the new
// one. Pure observability — not a gate. The point is to expose the
// failure mode where geometry passes the gates but the fix repeats
// in a wrong basin: those show high "agree" counts, but a vessel
// transiting a real route across multiple bursts also shows high
// agree, so this can't be a hard reject. The UI surfaces it so
// humans can judge.
const CONVERGENCE_WINDOW_MS = 30 * 60 * 1000;
const CONVERGENCE_HISTORY = 10;
const CONVERGENCE_AGREE_KM = 200;

export class TDOADO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buckets = new Map();        // mmsi → [{mmsi, firstSeenMs, dets[]}]
    this.recentDets = [];
    this.recentSolves = [];
    this.recentRejects = [];         // suppressed fixes, with position + gate
    this.rejections = {};            // gate → count, observability only
    this.recentFixesByMmsi = new Map(); // mmsi → [{lat,lon,broadcastMs}]
    this.state.blockConcurrencyWhile(async () => {
      this.recentDets    = (await this.state.storage.get("recentDets"))    || [];
      this.recentSolves  = (await this.state.storage.get("recentSolves"))  || [];
      this.recentRejects = (await this.state.storage.get("recentRejects")) || [];
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
      await this._ingest(det);
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
        recentSolves: this.recentSolves.slice(-40),
        recentRejects: this.recentRejects.slice(-60),
        rejections: this.rejections,
      }, { headers: { "access-control-allow-origin": "*" } });
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

  async _ingest(det) {
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

    // Warm the AIS cache as soon as a vessel bucket starts pairing, so
    // the fix-time oracle (cold chain: GFW → handshake → symbology →
    // ticket-polled query, easily >5 s) usually hits a cached position.
    if (b.dets.length === 2 && this.env?.LSEG_APP_KEY
        && !String(b.mmsi).startsWith("00") && !b.mmsi.includes("?")) {
      lsegLookupMmsi(this.env, b.mmsi).catch(() => {});
    }

    // Re-solve on every arrival past quorum: a 3-receiver 2D solve has
    // a mirror ambiguity that a 4th collapses; beyond that, the extra
    // overdetermination tightens the estimate. We broadcast each.
    if (b.dets.length >= MIN_RECEIVERS) {
      let result;
      try { result = await this._solveBucket(b); } catch (_) { return; }
      if (result) {
        result.quorum = result.receivers.length;
        const ru = result.geometry.runnerUp;
        const ruStr = ru ? ` runnerUp=(${ru.lat},${ru.lon},${ru.residualKm}km,${ru.priorPenaltyDex}dex,sep=${ru.sepKm}km)` : "";
        console.log(`tdoa/solve: regime=${result.regime} mmsi=${b.mmsi} pos=${result.position.lat.toFixed(3)},${result.position.lon.toFixed(3)} resid=${result.position.residualKm.toFixed(1)}km q=${result.quorum} ellipse=${result.geometry.ellipseSemiMajorKm}km prior=${result.geometry.priorPenaltyDex}dex${ruStr}`);
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
  async _solveBucket(bucket) {
    const regime = classifyRegime(bucket.dets);
    let dets = dedupByLocation(bucket.dets, regime.dedupKm);
    if (dets.length < MIN_RECEIVERS) {
      this.rejections.dedup = (this.rejections.dedup || 0) + 1;
      return null;
    }
    const ref = dets[0];
    const refSR = ref.snippet.sampleRate;
    const refA = hilbert(ref.snippet.samples);

    let solverDets = [{ gps: ref.gps, t: 0 }];
    let lagsReport = [{ slot: ref.slotId, label: ref.label, band: ref.band, gps: ref.gps, dtSec: 0, peakRatio: null }];
    const kept = [ref];
    for (let k = 1; k < dets.length; k++) {
      const d = dets[k];
      const startDtSec = Number(d.snippet.startGpsNs - ref.snippet.startGpsNs) / 1e9;
      // 0.35 s cap: decoder lock offsets measure ≤30 ms across receivers,
      // while DSC's DX/RX interleave repeats every symbol 400 ms later —
      // a correlation ghost the search window must never reach.
      if (Math.abs(startDtSec) > 0.35) continue;
      // kiwis run at ~12 kHz but a few serve 20.25 kHz — resample those
      // onto the reference rate instead of discarding them (sample-0
      // time is preserved, so the anchor math is unchanged).
      const samples = Math.abs(d.snippet.sampleRate / refSR - 1) < 0.01
        ? d.snippet.samples
        : resample(d.snippet.samples, d.snippet.sampleRate, refSR);
      const dA = hilbert(samples);
      const est = estimateDt(refA.re, refA.im, dA.re, dA.im, refSR,
        { maxLagSec: Math.abs(startDtSec) + PROPAGATION_SLACK_SEC });
      // envelope peak barely above the off-peak floor = the pair never
      // actually locked on a common waveform; using it would inject a
      // near-random lag into the solve.
      if (!est || !Number.isFinite(est.dt) || est.peakRatio < MIN_PEAK_RATIO) {
        this.rejections.pair = (this.rejections.pair || 0) + 1;
        continue;
      }
      const dtSec = startDtSec + est.dt;
      solverDets.push({ gps: d.gps, t: dtSec });
      lagsReport.push({ slot: d.slotId, label: d.label, band: d.band, gps: d.gps, dtSec, peakRatio: +est.peakRatio.toFixed(1), cfoHz: est.cfoHz });
      kept.push(d);
    }
    dets = kept;
    if (dets.length < MIN_RECEIVERS) {
      this.rejections.dedup = (this.rejections.dedup || 0) + 1;
      return null;
    }

    const SOLVE_OPTS = {
      prior: densityPenaltyDex,
      priorLambdaKm: PRIOR_LAMBDA_KM,
    };
    let sol = solveTdoa(solverDets, SOLVE_OPTS);
    if (!sol) return null;

    // Mixed-cohort rescue. Night-MF cohorts are often a MIX: receivers
    // near the source hear it by ground wave (clean timing) while far
    // ones hear it by skywave (+0.4–1.5 ms hop delay). Plain least
    // squares smears the regimes — live q=9..11 cohorts for tankers
    // anchored at Milford Haven produced fixes 60 km from truth but
    // with ~300 km residuals, dying at the gates (2026-06-09 capture,
    // FRONT LEOPARD / AURORA SPIRIT). When the full-cohort solve would
    // fail the residual or far-field gate, re-solve on the 6 receivers
    // nearest the initial fix: for a real near source those are the
    // ground-wave hearers (synthetic recovery: 8–35 km errors). The
    // subset choice is purely geometric, so a far-source cohort can't
    // be cherry-picked into a timing-coherent ghost — its nearest-6
    // subset is still skywave-contaminated and still fails the gates.
    const wouldFail = (s, d) => {
      if (s.residualKm > MAX_RESIDUAL_KM || s.atEdge) return true;
      const f = farFieldCheck(d);
      const minRatio = d.length <= 4 ? FARFIELD_MIN_RATIO_Q4 : FARFIELD_MIN_RATIO;
      return !!(f && f.planeResidKm < Math.max(minRatio * s.residualKm, FARFIELD_ABS_FLOOR_KM));
    };
    let dropped = null;
    if (solverDets.length >= RESCUE_MIN_COHORT && wouldFail(sol, solverDets)) {
      const keep = nearestSubsetIdx(solverDets, [sol.lat, sol.lon], RESCUE_SUBSET_K);
      const subDets = keep.map((i) => solverDets[i]);
      const subSol = solveTdoa(subDets, SOLVE_OPTS);
      if (subSol && !wouldFail(subSol, subDets)) {
        const keepSet = new Set(keep);
        dropped = lagsReport.filter((_, i) => !keepSet.has(i)).map((r) => r.slot);
        solverDets = subDets;
        lagsReport = lagsReport.filter((_, i) => keepSet.has(i));
        dets = dets.filter((_, i) => keepSet.has(i));
        sol = subSol;
        console.log(`tdoa/rescue: mmsi=${bucket.mmsi} kept=${solverDets.length} dropped=${dropped.join(",")} resid=${sol.residualKm.toFixed(0)}km`);
      }
    }

    const pos = [sol.lat, sol.lon];
    const rej = (gate) => {
      this.rejections[gate] = (this.rejections[gate] || 0) + 1;
      console.log(`tdoa/reject: gate=${gate} mmsi=${bucket.mmsi} q=${dets.length} pos=${pos[0].toFixed(2)},${pos[1].toFixed(2)} resid=${sol.residualKm.toFixed(0)}km`);
      // Suppressed fixes keep their position + cohort so a map can plot
      // ghosts alongside real fixes (these are the interesting rejects —
      // the pre-solve dedup/pair drops have no position and stay counts).
      this.recentRejects.push({
        mmsi: bucket.mmsi, gate, regime: regime.name,
        position: { lat: +sol.lat.toFixed(3), lon: +sol.lon.toFixed(3), residualKm: +sol.residualKm.toFixed(1) },
        quorum: dets.length,
        receivers: dets.map((d) => ({ slot: hostOf(d.slotId), label: d.label, gps: d.gps })),
        broadcastMs: Date.now(),
      });
      if (this.recentRejects.length > 100) this.recentRejects.splice(0, this.recentRejects.length - 100);
      this.state.storage.put("recentRejects", this.recentRejects).catch(() => {});
      return null;
    };

    // 1. Residual gate. Belt-and-suspenders against bad xcorr lags;
    //    most ghosts have small residuals (the wrong basin is
    //    internally consistent) so this gate rarely fires alone.
    if (sol.residualKm > MAX_RESIDUAL_KM) return rej("residual");

    // 1a. Edge gate. A minimum pinned against the search-box boundary
    //     means the true source is outside the box (far skywave);
    //     observed live 2026-07-02 (fixes at exactly bbox-edge lon).
    if (sol.atEdge) return rej("edge");

    // 1b. Far-field gate. When the plane-wave fit explains the timings
    //     almost as well as the point fix, the cohort has no range
    //     information on this source — it's far beyond the cohort
    //     diameter (night skywave) and the point fix is a ghost.
    const ff = farFieldCheck(solverDets);
    const ffMinRatio = solverDets.length <= 4 ? FARFIELD_MIN_RATIO_Q4 : FARFIELD_MIN_RATIO;
    if (ff && ff.planeResidKm < Math.max(ffMinRatio * sol.residualKm, FARFIELD_ABS_FLOOR_KM)) {
      return rej("farfield");
    }

    // 1c. Registry gate. Fixed transmitters with known positions
    //     (coast stations) can be checked against truth directly; a
    //     fix > REGISTRY_MAX_KM from every registered site is provably
    //     wrong even when the geometry looks clean. Catches the
    //     persistent-ghost mode no internal signal can (stable cohort,
    //     same wrong basin every burst, 100% convergence).
    const reg = coastRegistryCheck(bucket.mmsi, pos[0], pos[1]);
    if (reg && reg.nearestKm > REGISTRY_MAX_KM) return rej("registry");

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

    // 4. AIS oracle (vessels, creds permitting). Runs last so LSEG is
    //    only consulted for fixes that already pass every geometric
    //    gate. Also annotates surviving broadcasts with the AIS miss
    //    distance — free validation telemetry on every fix.
    let ais = null;
    if (this.env?.LSEG_APP_KEY && !String(bucket.mmsi).startsWith("00") && !bucket.mmsi.includes("?")) {
      try {
        const p = await Promise.race([
          lsegLookupMmsi(this.env, bucket.mmsi),
          new Promise((res) => setTimeout(() => res(null), 8000)),
        ]);
        if (p && !p.error && Number.isFinite(p.lat)) {
          const km = gcDistanceKm(pos, [p.lat, p.lon]);
          const ageH = p.ts ? Math.max(0.05, (Date.now() - p.ts) / 3.6e6) : null;
          const impliedKn = ageH != null ? km / ageH / 1.852 : null;
          ais = {
            name: p.name || null,
            km: +km.toFixed(0),
            ageH: ageH != null ? +ageH.toFixed(1) : null,
            impliedKn: impliedKn != null ? +impliedKn.toFixed(0) : null,
          };
          if (ageH != null && ageH <= AIS_MAX_AGE_H && impliedKn > AIS_MAX_IMPLIED_KN) {
            return rej("ais");
          }
        }
      } catch (_) {}
    }

    let furthestRxKm = 0, nearestRxKm = Infinity;
    for (const d of dets) {
      const dKm = gcDistanceKm(pos, d.gps);
      if (dKm > furthestRxKm) furthestRxKm = dKm;
      if (dKm < nearestRxKm) nearestRxKm = dKm;
    }

    const convergence = this._updateConvergence(bucket.mmsi, pos);

    const priorPenaltyDex = densityPenaltyDex(pos[0], pos[1]);
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
        priorPenaltyDex: +priorPenaltyDex.toFixed(2),
        // Far-field diagnostics: how much better the point fix explains
        // the timings than a plane wave does. Ratios barely above the
        // gate are range-information-poor; comfortably high ratios mean
        // the source is genuinely inside the cohort's near field.
        farfieldRatio: ff ? +(ff.planeResidKm / Math.max(0.001, sol.residualKm)).toFixed(2) : null,
        planeResidKm: ff ? +ff.planeResidKm.toFixed(1) : null,
        // Receivers excluded by the mixed-cohort nearest-6 rescue
        // (their timings were skywave-contaminated vs the kept subset).
        droppedReceivers: dropped && dropped.length ? dropped : null,
        // When the residual landscape had a competing basin, surface it
        // so we can see at a glance whether the prior was load-bearing.
        // `runnerUp` is null for clean single-basin fixes.
        runnerUp: sol.runnerUp ? {
          lat: +sol.runnerUp.lat.toFixed(3),
          lon: +sol.runnerUp.lon.toFixed(3),
          residualKm: +sol.runnerUp.residualKm.toFixed(1),
          sepKm: sol.runnerUp.sepKm,
          priorPenaltyDex: +densityPenaltyDex(sol.runnerUp.lat, sol.runnerUp.lon).toFixed(2),
        } : null,
      },
      convergence,
      ais,
      packetGpsNs: ref.packetGpsNs.toString(),
      broadcastMs: Date.now(),
    };
  }

  // Update per-MMSI fix history and return a convergence summary for
  // the new fix: how many recent fixes (within CONVERGENCE_WINDOW_MS)
  // land within CONVERGENCE_AGREE_KM of the new one. Pure observability.
  _updateConvergence(mmsi, pos) {
    const now = Date.now();
    const cutoff = now - CONVERGENCE_WINDOW_MS;
    const old = this.recentFixesByMmsi.get(mmsi) || [];
    const fresh = old.filter((f) => f.broadcastMs >= cutoff);
    let agree = 1;  // include the new fix
    let maxKm = 0;
    for (const f of fresh) {
      const d = gcDistanceKm(pos, [f.lat, f.lon]);
      if (d <= CONVERGENCE_AGREE_KM) agree++;
      if (d > maxKm) maxKm = d;
    }
    fresh.push({ lat: pos[0], lon: pos[1], broadcastMs: now });
    if (fresh.length > CONVERGENCE_HISTORY) fresh.splice(0, fresh.length - CONVERGENCE_HISTORY);
    this.recentFixesByMmsi.set(mmsi, fresh);
    return {
      fixCount: fresh.length,
      agreeCount: agree,
      maxDistKm: +maxKm.toFixed(0),
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
      convergence: msg.convergence,
      ais: msg.ais,
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

// Classify the cohort's propagation regime from band + spread, used
// to pick the site-dedup radius. Always returns a regime — there's
// no "refuse to solve" verdict here; the post-solve gates (residual,
// bearing-gap, ellipse) judge whether the resulting fix is trustworthy.
// All bucket dets share a band by ingest invariant.
function classifyRegime(dets) {
  if (!dets.length) {
    return { name: "long-baseline", dedupKm: LONG_BASELINE_DEDUP_MIN_KM };
  }
  const band = dets[0].band;
  const span = cohortMaxPairwiseKm(dets);
  if (band === "MF" && span <= GROUND_WAVE_MAX_SPAN_KM) {
    return { name: "ground-wave", dedupKm: GROUND_WAVE_DEDUP_KM };
  }
  return {
    name: "long-baseline",
    dedupKm: Math.max(LONG_BASELINE_DEDUP_MIN_KM, span / LONG_BASELINE_DEDUP_FACTOR),
  };
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
