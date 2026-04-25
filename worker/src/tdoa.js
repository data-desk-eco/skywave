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
// nested-grid refinement on the global minimum. Single basin — works
// because the cohort is tight and inside the ground-wave regime, so
// the residual landscape has one well-defined minimum near the truth.
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

  // Phase 1: coarse sweep. Keep the top-K cells so refinement can rescue
  // cases where the global coarse minimum is one or two cells off truth
  // due to grid-discretisation noise — the refine box is bounded, so
  // refining only the best coarse cell can converge on a slightly-wrong
  // local minimum. K=3 is enough in practice for tight cohorts.
  const nCoarse = opts.coarseN ?? 81;
  const topK = opts.topK ?? 3;
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

  // Phase 2: nested-grid refinement around each coarse candidate; take
  // the global best after refining.
  const coarseCellDeg = Math.max(
    (latMax - latMin) / (nCoarse - 1),
    (lonMax - lonMin) / (nCoarse - 1),
  );
  const refineN = opts.refineN ?? 21;
  const refineSteps = opts.refineSteps ?? 6;
  const shrink = opts.shrink ?? 0.3;
  let best = { r: Infinity, la: 0, lo: 0 };
  for (const cand of top) {
    let la = cand.la, lo = cand.lo, range = coarseCellDeg * 2;
    let local = { r: cand.r, la, lo };
    for (let iter = 0; iter < refineSteps; iter++) {
      for (let i = 0; i < refineN; i++) {
        const la2 = la + (i - (refineN - 1) / 2) * range / (refineN - 1);
        for (let j = 0; j < refineN; j++) {
          const lo2 = lo + (j - (refineN - 1) / 2) * range / (refineN - 1);
          const r = resid(la2, lo2);
          if (r < local.r) local = { r, la: la2, lo: lo2 };
        }
      }
      la = local.la; lo = local.lo;
      range *= shrink;
    }
    if (local.r < best.r) best = local;
  }

  const rmsTimeErr = Math.sqrt(best.r / Math.max(1, dets.length - 1));
  return {
    lat: best.la,
    lon: best.lo,
    residualKm: rmsTimeErr * C / 1000,
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
