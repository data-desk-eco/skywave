// Pure TDOA math. Kept free of I/O so the same module can run in the
// Worker and in a Node test script.
//
// Model: great-circle propagation at c. Real MF first-hop skywave adds
// a path-length bias of tens of kilometres due to ionospheric reflection
// height (~100 km ± 10 km at night). We accept that as a residual — this
// file validates the pairing/correlation/solve geometry; ionospheric
// correction is a follow-up.

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
  // Peak prominence: ratio of the main peak to the highest correlation
  // outside a narrow window around the peak. A clean, unambiguous
  // alignment has prominence ≫ 1; a noisy or multi-peaked cross-
  // correlation has prominence ~1 and its `lag` can't be trusted.
  // Used downstream as a quality gate before feeding lags to solveTdoa.
  const exclude = 20;               // samples either side of the peak to skip
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
