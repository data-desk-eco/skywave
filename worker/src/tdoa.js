// Pure TDOA math. Kept free of I/O so the same module can run in the
// Worker and in a Node test script.
//
// Propagation model — skywave-aware. The signal doesn't travel along
// a great-circle arc at c; it bounces off the F2 layer at h ≈ 250 km
// in roughly 2000 km hops. The slant distance per hop is therefore
// 2·sqrt((d_hop/2)² + h²), so for a 1000 km surface path the actual
// signal travels 1118 km — 118 km of "iono bias". Long paths (e.g.
// 6000 km via 3 hops) accumulate ~700 km of extra slant. Modelling
// this correction is what lets the residual landscape distinguish
// the true TX from the ghost-basin mirror; without it the solver
// finds positions where the *straight-line* distances are consistent,
// which doesn't match the bounce-path arrival times.

export const C = 299792458;   // m/s
export const EARTH_R = 6371000;
const IONO_REFLECT_HEIGHT_M = 250000;   // F2 layer, mid-band HF average
const IONO_HOP_LENGTH_M = 2000000;      // ~2000 km surface arc per hop

// Slant (signal-path) distance for a great-circle surface distance d_m,
// assuming multi-hop F2 reflection. Reduces to d_m + iono-bias for
// d_m << HOP_LEN, and grows with the per-hop slant for long paths.
export function slantDistance(d_m, h_m = IONO_REFLECT_HEIGHT_M) {
  if (d_m <= 0) return 0;
  const nHops = Math.max(1, Math.ceil(d_m / IONO_HOP_LENGTH_M));
  const dPerHop = d_m / nHops;
  const slantPerHop = 2 * Math.sqrt((dPerHop / 2) ** 2 + h_m * h_m);
  return nHops * slantPerHop;
}

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
  // Peak prominence: ratio of the main peak to the highest correlation
  // OUTSIDE the symbol-period sidelobes around the peak. DSC FSK runs
  // at 100 baud — at SR 12 kHz that's 120 samples per symbol, so
  // adjacent lags within ±1 symbol period are inherently strongly
  // correlated due to symbol-aligned overlap, regardless of true
  // alignment quality. We exclude ±150 samples so prominence reflects
  // genuine off-peak noise floor, not the local sidelobe structure.
  const exclude = 150;
  let offPeakMax = 0;
  for (let i = 0; i < corrs.length; i++) {
    if (Math.abs(i - idx) <= exclude) continue;
    if (corrs[i] > offPeakMax) offPeakMax = corrs[i];
  }
  const prominence = offPeakMax > 0 ? best / offPeakMax : Infinity;
  return { lag: refined, peak: best, prominence };
}

// Solve TDOA. Input: array of {gps:[lat,lon], t:<seconds>} (t on any
// shared clock; only differences matter). Returns {lat, lon, residualKm}.
//
// Method: two-phase search. Phase 1 sweeps a coarse global grid across
// the plausible search area and keeps the top few candidate basins (the
// TDOA residual landscape has multiple saddle-y minima when receivers
// are unevenly distributed, so a single local refinement can land in a
// ghost basin). Phase 2 refines each candidate by nested grid and picks
// the global best. Still root-finder-free and cheap for N≤8 receivers.
export function solveTdoa(dets, opts = {}) {
  if (dets.length < 3) return null;
  const ref = dets[0];
  const obsDts = dets.map(d => d.t - ref.t);  // shared clock; diffs only

  // Search area: bbox of receivers expanded by `pad` degrees. For MF
  // first-hop skywave (≲2000 km from any receiver) a 15° pad is ample.
  const lats = dets.map(d => d.gps[0]);
  const lons = dets.map(d => d.gps[1]);
  const pad = opts.padDeg ?? 15;
  const latMin = Math.min(...lats) - pad, latMax = Math.max(...lats) + pad;
  const lonMin = Math.min(...lons) - pad, lonMax = Math.max(...lons) + pad;

  // Skywave-aware residual: convert each great-circle distance into
  // its multi-hop slant distance via slantDistance() before computing
  // expected arrival-time differences. Without this correction the
  // solver finds positions whose straight-line distances satisfy the
  // observed arrival times — which is *not* the same set as the
  // true positions when signals are propagating via F2 hops. Opt-in
  // (`opts.skywave: true`) so synthetic tests that generate timings
  // from straight-line propagation continue to validate the geometry
  // independent of the propagation model.
  const dist = opts.skywave ? (a, b) => slantDistance(geodist(a, b)) : geodist;
  const resid = (la, lo) => {
    const d0 = dist([la, lo], ref.gps);
    let s = 0;
    for (let k = 1; k < dets.length; k++) {
      const dk = dist([la, lo], dets[k].gps);
      const err = (dk - d0) / C - obsDts[k];
      s += err * err;
    }
    return s;
  };

  // Phase 1: coarse sweep. Keep top-K candidates.
  const nCoarse = opts.coarseN ?? 81;
  const topK = opts.topK ?? 6;
  const top = [];   // [{r, la, lo}, ...] sorted ascending by r
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

  // Phase 2: refine each candidate basin and return the best.
  const coarseCellDeg = Math.max(
    (latMax - latMin) / (nCoarse - 1),
    (lonMax - lonMin) / (nCoarse - 1),
  );
  let best = { r: Infinity, la: top[0].la, lo: top[0].lo };
  const refineN = opts.refineN ?? 21;
  const refineSteps = opts.refineSteps ?? 6;
  const shrink = opts.shrink ?? 0.3;

  for (const cand of top) {
    let la = cand.la, lo = cand.lo, range = coarseCellDeg * 2;
    let localBest = { r: cand.r, la, lo };
    for (let iter = 0; iter < refineSteps; iter++) {
      for (let i = 0; i < refineN; i++) {
        const la2 = la + (i - (refineN - 1) / 2) * range / (refineN - 1);
        for (let j = 0; j < refineN; j++) {
          const lo2 = lo + (j - (refineN - 1) / 2) * range / (refineN - 1);
          const r = resid(la2, lo2);
          if (r < localBest.r) localBest = { r, la: la2, lo: lo2 };
        }
      }
      la = localBest.la; lo = localBest.lo;
      range *= shrink;
    }
    if (localBest.r < best.r) best = localBest;
  }

  const rmsTimeErr = Math.sqrt(best.r / Math.max(1, dets.length - 1));
  return { lat: best.la, lon: best.lo, residualKm: rmsTimeErr * C / 1000 };
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
  // Local ENU unit vectors from solution to each receiver. ~scale-
  // accurate for sub-1000-km cohorts; for larger ones the spherical
  // approximation degrades but the broad shape (elongation, axes
  // ratio) remains informative.
  const cosLat = Math.cos(pLat * Math.PI / 180);
  const KM_PER_DEG = 111.32;
  const u = dets.map(d => {
    const dN = (d.gps[0] - pLat) * KM_PER_DEG;
    const dE = (d.gps[1] - pLon) * KM_PER_DEG * cosLat;
    const r = Math.hypot(dN, dE);
    return r > 0 ? [dE / r, dN / r] : [0, 0];   // [east, north] unit
  });
  // Build H (rows = pairs, cols = [E, N] derivative of (r_i - r_0)).
  // Reference is dets[0], so each pair (0, k) row is u_k - u_0.
  let HtH00 = 0, HtH01 = 0, HtH11 = 0;
  for (let k = 1; k < u.length; k++) {
    const e = u[k][0] - u[0][0];
    const n = u[k][1] - u[0][1];
    HtH00 += e * e;
    HtH01 += e * n;
    HtH11 += n * n;
  }
  // Invert 2x2: det = HtH00*HtH11 - HtH01², cov = (1/det) * [[HtH11,-HtH01],[-HtH01,HtH00]] · σ²·c²
  const det = HtH00 * HtH11 - HtH01 * HtH01;
  if (!isFinite(det) || det <= 1e-9) return null;        // degenerate
  const sigmaKm = (timingSigmaMs / 1000) * C / 1000;     // 1 ms ≈ 300 km
  const sigma2 = sigmaKm * sigmaKm;
  const Cee = (HtH11 / det) * sigma2;
  const Cnn = (HtH00 / det) * sigma2;
  const Cen = (-HtH01 / det) * sigma2;
  // Eigenvalues of the 2x2 covariance.
  const tr = Cee + Cnn;
  const D = Math.sqrt(Math.max(0, (Cee - Cnn) ** 2 + 4 * Cen * Cen));
  const lam1 = (tr + D) / 2;     // bigger eigenvalue
  const lam2 = (tr - D) / 2;
  const semiMajorKm = Math.sqrt(Math.max(0, lam1));
  const semiMinorKm = Math.sqrt(Math.max(0, lam2));
  // Orientation: angle (deg, 0=east, 90=north) of the major axis.
  const orientDeg = (Math.atan2(2 * Cen, Cee - Cnn) * 90 / Math.PI);
  return {
    semiMajorKm,
    semiMinorKm,
    // Axis ratio gives a quick scalar quality cue: 1.0 = perfectly
    // round (well-determined), >5 = strongly elongated (one direction
    // poorly constrained, e.g. one-sided cohort).
    axisRatio: semiMinorKm > 0 ? semiMajorKm / semiMinorKm : Infinity,
    orientationDeg: orientDeg,
  };
}
