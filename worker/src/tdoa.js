// Pure TDOA math. Kept free of I/O so the same module can run in the
// Worker and in a Node test script.
//
// Operating regime: this solver assumes ground-wave propagation —
// signals travel along the great-circle surface path at c. That holds
// when every cohort receiver is within MF/HF ground-wave range of the
// transmitter (~600 km on MF over salt water; less on HF). Multi-hop
// skywave is explicitly out of scope: F2 reflection adds path bias
// that varies with ionospheric conditions, time of day, and per-pair
// hop count, and the residual landscape gains symmetric ghost minima
// the solver can't disambiguate. Cohort selection (regions.js) is
// responsible for keeping the receivers inside the ground-wave regime.

export const C = 299792458;   // m/s
export const EARTH_R = 6371000;

// Great-circle distance (m) between two [lat, lon] points in degrees.
export function geodist(a, b) {
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const dla = la2 - la1;
  const dlo = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(dla / 2) ** 2
          + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Cross-correlate two real signals a, b. Returns {lag, peak} where lag
// is the sample offset at which b aligns with a (positive = b is delayed
// vs a). Sub-sample refinement via parabolic interpolation at the peak.
// Naive O(N·maxLag); fine for bursts up to ~1s at 12 kHz.
//
// Raw (unnormalized) sum — classical R_ab[k] = Σ a[i] b[i+k]. Do NOT
// divide by overlap count: zero-padded signals shrink the useful overlap
// at edge lags, and per-sample averaging then biases the peak inward.
export function xcorr(a, b, maxLag) {
  const n = Math.min(a.length, b.length);
  const M = Math.min(maxLag | 0, (n >> 1) - 1);
  let best = -Infinity, bestLag = 0;
  const corrs = new Float32Array(2 * M + 1);
  for (let lag = -M; lag <= M; lag++) {
    const iStart = Math.max(0, -lag);
    const iEnd = Math.min(n, n - lag);
    let s = 0;
    for (let i = iStart; i < iEnd; i++) s += a[i] * b[i + lag];
    corrs[lag + M] = s;
    if (s > best) { best = s; bestLag = lag; }
  }
  // Parabolic sub-sample refinement at the peak.
  let refined = bestLag;
  const idx = bestLag + M;
  if (idx > 0 && idx < corrs.length - 1) {
    const y0 = corrs[idx - 1], y1 = corrs[idx], y2 = corrs[idx + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      refined = bestLag + 0.5 * (y0 - y2) / denom;
    }
  }
  return { lag: refined, peak: best };
}

// Solve TDOA. Input: array of {gps:[lat,lon], t:<seconds>} (t on any
// shared clock; only differences matter). Returns {lat, lon, residualKm}.
//
// Method: coarse grid sweep over the receiver bbox + small pad, then
// nested-grid refinement on the top-K coarse cells; pick the candidate
// with the lowest score after refinement.
//
// Score is `residualKm + λ · prior(lat, lon)` when `opts.prior` is
// supplied (the vessel-density penalty for DSC sources — see
// density.js). The prior is the dual-basin tiebreaker for long-
// baseline HF cohorts where two intersection basins fit the timing
// constraints almost equally well: residual alone picks the lower-
// noise basin even when the truth is in the higher-noise one. For
// ground-wave cohorts the residual landscape is single-basin and the
// prior contributes negligibly, so it's always-on. With no prior
// supplied (offline tests, ground-truth synthetic), score reduces to
// pure residualKm and the original behaviour is preserved.
export function solveTdoa(dets, opts = {}) {
  if (dets.length < 3) return null;
  const ref = dets[0];
  const obsDts = dets.map(d => d.t - ref.t);  // shared clock; diffs only

  // Search area: receiver bbox expanded by `padDeg`. 10° (~1100 km) is
  // enough overflow for tight cohorts: the truth is inside the convex
  // hull of receivers in the surround case, and within ~one cohort
  // diameter outside it in the offset case. Wider padding invites
  // ghost basins from the periodic xcorr-sidelobe structure.
  const lats = dets.map(d => d.gps[0]);
  const lons = dets.map(d => d.gps[1]);
  const pad = opts.padDeg ?? 10;
  const latMin = Math.min(...lats) - pad, latMax = Math.max(...lats) + pad;
  const lonMin = Math.min(...lons) - pad, lonMax = Math.max(...lons) + pad;

  const resid = (la, lo) => {
    const d0 = geodist([la, lo], ref.gps);
    let s = 0;
    for (let k = 1; k < dets.length; k++) {
      const dk = geodist([la, lo], dets[k].gps);
      const err = (dk - d0) / C - obsDts[k];
      s += err * err;
    }
    return s;
  };

  // Phase 1: coarse sweep. Keep the top-K cells. K=6 (was 3) so the
  // dual-basin disambiguation in phase 2 has the alternative basin
  // available — refinement is bounded, so a single basin's coarse
  // minimum can't migrate over to the other. Each kept cell is a
  // potential basin centre.
  const nCoarse = opts.coarseN ?? 81;
  const topK = opts.topK ?? 6;
  const top = [];
  for (let i = 0; i < nCoarse; i++) {
    const la = latMin + (latMax - latMin) * i / (nCoarse - 1);
    for (let j = 0; j < nCoarse; j++) {
      const lo = lonMin + (lonMax - lonMin) * j / (nCoarse - 1);
      const r = resid(la, lo);
      if (top.length < topK || r < top[top.length - 1].r) {
        top.push({ r, la, lo });
        top.sort((a, b) => a.r - b.r);
        if (top.length > topK) top.length = topK;
      }
    }
  }

  // Phase 2: nested-grid refinement around each coarse candidate, then
  // pick the lowest-scoring refined candidate. Score is the timing-
  // residual converted to km plus an optional prior penalty, so that
  // when two basins both fit the timings ~equally well the prior (e.g.
  // vessel-density for DSC sources) is the tiebreaker.
  const coarseCellDeg = Math.max(
    (latMax - latMin) / (nCoarse - 1),
    (lonMax - lonMin) / (nCoarse - 1),
  );
  const refineN = opts.refineN ?? 21;
  const refineSteps = opts.refineSteps ?? 6;
  const shrink = opts.shrink ?? 0.3;
  const prior = opts.prior;     // (lat, lon) → dimensionless penalty
  const lambdaKm = opts.priorLambdaKm ?? 0;  // km per unit penalty
  const score = (rTime2, la, lo) => {
    const rmsTimeErr = Math.sqrt(rTime2 / Math.max(1, dets.length - 1));
    const residualKm = rmsTimeErr * C / 1000;
    const priorPenalty = prior ? prior(la, lo) : 0;
    return residualKm + lambdaKm * priorPenalty;
  };
  const refined = [];
  for (const cand of top) {
    let la = cand.la, lo = cand.lo, range = coarseCellDeg * 2;
    let local = { r: cand.r, la, lo };
    for (let iter = 0; iter < refineSteps; iter++) {
      for (let i = 0; i < refineN; i++) {
        const la2 = la + (i - (refineN - 1) / 2) * range / (refineN - 1);
        for (let j = 0; j < refineN; j++) {
          const lo2 = lo + (j - (refineN - 1) / 2) * range / (refineN - 1);
          const r = resid(la2, lo2);
          // Within a basin the residual gradient dominates; we refine
          // on the residual, then score-rank across basins below.
          if (r < local.r) local = { r, la: la2, lo: lo2 };
        }
      }
      la = local.la; lo = local.lo;
      range *= shrink;
    }
    refined.push({ ...local, s: score(local.r, local.la, local.lo) });
  }
  refined.sort((a, b) => a.s - b.s);
  const best = refined[0];

  const rmsTimeErr = Math.sqrt(best.r / Math.max(1, dets.length - 1));
  const result = {
    lat: best.la,
    lon: best.lo,
    residualKm: rmsTimeErr * C / 1000,
    // pinned against the search boundary = the true minimum is outside
    // the box (typically a far skywave source) — not a usable fix.
    atEdge: best.la < latMin + coarseCellDeg || best.la > latMax - coarseCellDeg
         || best.lo < lonMin + coarseCellDeg || best.lo > lonMax - coarseCellDeg,
  };
  // Surface the runner-up basin so the coordinator can decide whether
  // the prior was load-bearing for this fix. `runnerUp` is null when
  // there's only one well-separated minimum, otherwise it carries the
  // best alternative basin's position + residual + score so the broadcast
  // can flag dual-basin fixes.
  if (refined.length > 1) {
    const r2 = refined[1];
    const sepKm = (function () {
      const a = [best.la, best.lo], b = [r2.la, r2.lo];
      const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
      const dla = la2 - la1, dlo = (b[1] - a[1]) * Math.PI / 180;
      const h = Math.sin(dla / 2) ** 2
              + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
      return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
    })();
    const r2RmsTimeErr = Math.sqrt(r2.r / Math.max(1, dets.length - 1));
    if (sepKm > 1500) {
      result.runnerUp = {
        lat: r2.la,
        lon: r2.lo,
        residualKm: r2RmsTimeErr * C / 1000,
        scoreKm: r2.s,
        sepKm: +sepKm.toFixed(0),
      };
    }
  }
  result.scoreKm = best.s;
  return result;
}

// Nearest-k subset for the mixed ground-wave/skywave rescue. Night-MF
// cohorts are often a mix: receivers near the source hear it by ground
// wave (clean timing, ≤0.1 ms noise) while far ones hear it by skywave
// (+0.4–1.5 ms of hop delay). Plain least squares smears the regimes
// together: live mixed cohorts produced fixes ~60 km from truth with
// ~300 km residuals, dying at the gates (FRONT LEOPARD / AURORA SPIRIT
// at Milford Haven, 2026-06-09).
//
// The rescue: re-solve using only the k receivers nearest the initial
// (smeared) fix — for a real near source those are the ground-wave
// hearers, and the initial fix is dragged but still lands within
// ~100 km of truth, close enough to select the right subset. The
// selection is purely geometric — unlike RANSAC-style consensus
// picking it has no freedom to cherry-pick a timing-coherent skywave
// subset, which synthetic trials showed rescues far-source ghosts
// into convincing near-field fits. For a genuinely far source the
// nearest-k subset is still skywave-contaminated, so the re-solve
// stays planar/high-residual and the gates reject it the same way.
//
// Returns ORIGINAL indices (reference always included, order kept) so
// the caller can prune its parallel bookkeeping arrays.
export function nearestSubsetIdx(dets, fix, k) {
  const scored = dets.map((d, i) => ({ i, dist: geodist(fix, d.gps) }));
  const rest = scored.slice(1).sort((a, b) => a.dist - b.dist).slice(0, k - 1);
  return [0, ...rest.map((s) => s.i)].sort((a, b) => a - b);
}

// Far-field (plane-wave) fit. A transmitter far beyond the cohort's
// diameter produces an almost-planar wavefront across it: arrival-time
// differences become a LINEAR function of receiver position, and the
// cohort fundamentally cannot localise the source — any point along
// the back-azimuth fits almost equally well, so the point solver picks
// an arbitrary basin inside its search box (a ghost). Conversely a
// source genuinely inside / near the cohort produces strongly curved
// delays that no plane wave can reproduce.
//
// So: fit t_i = s⃗·x⃗_i + c by least squares on a local tangent plane
// and report the rms residual in km (same units as solveTdoa's
// residualKm). The coordinator compares the two fits — when the plane
// wave explains the timings about as well as the point fix does, the
// fix carries no range information and gets rejected. This is the
// internal signal for the night-MF-skywave failure mode (Channel
// cohort hears Greece/Denmark/Italy, classifies ground-wave by cohort
// spread, solves a geodesic ghost into the local sea).
//
// Returns null below 4 receivers (3 model params would fit exactly).
export function farFieldCheck(dets) {
  const n = dets.length;
  if (n < 4) return null;
  let la0 = 0, lo0 = 0;
  for (const d of dets) { la0 += d.gps[0]; lo0 += d.gps[1]; }
  la0 /= n; lo0 /= n;
  const cos0 = Math.cos(la0 * Math.PI / 180);
  const X = dets.map((d) => [
    (d.gps[1] - lo0) * Math.PI / 180 * EARTH_R * cos0,
    (d.gps[0] - la0) * Math.PI / 180 * EARTH_R,
    1,
  ]);
  const t = dets.map((d) => d.t);
  // Normal equations A·p = b for p = [sx, sy, c].
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 3; r++) {
      b[r] += X[i][r] * t[i];
      for (let c2 = 0; c2 < 3; c2++) A[r][c2] += X[i][r] * X[i][c2];
    }
  }
  // Gaussian elimination, 3×3.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-18) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c2 = col; c2 < 4; c2++) M[r][c2] -= f * M[col][c2];
    }
  }
  const p = [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const pred = p[0] * X[i][0] + p[1] * X[i][1] + p[2];
    ssr += (t[i] - pred) ** 2;
  }
  const rms = Math.sqrt(ssr / Math.max(1, n - 3));
  const slowness = Math.hypot(p[0], p[1]);     // s/m along the plane
  return {
    planeResidKm: rms * C / 1000,
    // Apparent along-surface speed of the fitted wavefront, as a
    // multiple of c. ~1 for a genuine surface wave from a far source;
    // >1 when the wave arrives steeply (multi-hop) or the fit is to
    // curved (near-source) delays.
    apparentSpeedC: slowness > 0 ? (1 / slowness) / C : Infinity,
    bearingDeg: (Math.atan2(-p[0], -p[1]) * 180 / Math.PI + 360) % 360,
  };
}

// Position uncertainty from cohort geometry. Linearises the TDOA
// system at the solved point: each receiver pair (i, j) constrains
// distance-difference along the unit vector u_i - u_j (where u_i is
// the unit vector from solution to receiver i in a local east/north
// frame). The Fisher information H^T H then gives the position
// covariance C = (H^T H)^-1 · σ²_t · c², whose 2x2 eigendecomposition
// yields a 1-σ error ellipse with semi-axes and orientation.
//
// Returns null when geometry is too degenerate to be meaningful
// (singular/near-singular H^T H).
//
// `timingSigmaMs` is the per-receiver arrival-time RMS noise.
// KiwiSDR realistic: ~1 ms.
export function tdoaUncertainty(dets, position, timingSigmaMs = 1.0) {
  if (dets.length < 3) return null;
  const [pLat, pLon] = position;
  const cosLat = Math.cos(pLat * Math.PI / 180);
  const KM_PER_DEG = 111.32;
  const u = dets.map(d => {
    const dN = (d.gps[0] - pLat) * KM_PER_DEG;
    const dE = (d.gps[1] - pLon) * KM_PER_DEG * cosLat;
    const r = Math.hypot(dN, dE);
    return r > 0 ? [dE / r, dN / r] : [0, 0];
  });
  let HtH00 = 0, HtH01 = 0, HtH11 = 0;
  for (let k = 1; k < u.length; k++) {
    const e = u[k][0] - u[0][0];
    const n = u[k][1] - u[0][1];
    HtH00 += e * e;
    HtH01 += e * n;
    HtH11 += n * n;
  }
  const det = HtH00 * HtH11 - HtH01 * HtH01;
  if (!isFinite(det) || det <= 1e-9) return null;
  const sigmaKm = (timingSigmaMs / 1000) * C / 1000;
  const sigma2 = sigmaKm * sigmaKm;
  const Cee = (HtH11 / det) * sigma2;
  const Cnn = (HtH00 / det) * sigma2;
  const Cen = (-HtH01 / det) * sigma2;
  const tr = Cee + Cnn;
  const D = Math.sqrt(Math.max(0, (Cee - Cnn) ** 2 + 4 * Cen * Cen));
  const lam1 = (tr + D) / 2;
  const lam2 = (tr - D) / 2;
  return {
    semiMajorKm: Math.sqrt(Math.max(0, lam1)),
    semiMinorKm: Math.sqrt(Math.max(0, lam2)),
    orientationDeg: Math.atan2(2 * Cen, Cee - Cnn) * 90 / Math.PI,
  };
}
