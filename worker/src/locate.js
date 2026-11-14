// position from per-receiver arrival times. unknowns: lat, lon and one
// emission time per burst; each arrival contributes (t − d/c − t0)/σ
// with its own σ, so a weak receiver informs the fix without steering
// it. several bursts from one slow or stationary transmitter can be
// solved together (obs[i].k = burst index): one position, many t0s.

import { geodist, C } from "./tdoa.js";

// two error models:
//  day   — symmetric cauchy; one bad arrival cannot drag the rest.
//  night — arrivals can only be LATE (ionospheric hops add path), by up
//          to several ms, so the loss is one-sided: an arrival more than
//          ~2σ late costs a small constant (it is a hop, ignore it), an
//          early one costs heavily. the fit hugs the earliest mutually
//          consistent arrivals instead of the middle of the smear.
const LATE = 2, EARLY = 12;
const cauchy = (u) => Math.log1p(u * u / 2), cw = (u) => 1 / (1 + u * u / 2);
const welsch = (u, L) => L * (1 - Math.exp(-u * u / (2 * L)));

// path length (km) of one reflection at virtual height h over ground
// range d, spherical earth
const RE = 6371;
export const hopKm = (d, h) => 2 * Math.sqrt(RE * RE + (RE + h) ** 2 - 2 * RE * (RE + h) * Math.cos(d / 2 / RE));

// robust cost at p with every burst's t0 profiled out.
// o.h (km): two-mode propagation — each arrival is either the ground
// wave (d/c) or one E-layer hop (hopKm(d, h)/c), whichever fits; the
// assignment starts from range (ground inside o.gwKm) and is revised
// once against the provisional t0.
// arrival times reduced to emission-time estimates under the two-mode
// model: e[i] = t[i] − (ground or hop delay at range D[i] km)
export function reduce(obs, D, groups, o) {
  const X = D.map((d) => (o.h ? (hopKm(d, o.h) - d) * 1e3 / C : 0));
  const e = obs.map((x, i) => x.t - D[i] * 1e3 / C - (o.h && D[i] > (o.gwKm ?? 350) ? X[i] : 0));
  if (o.h) for (const g of groups) {
    const m = g.map((i) => e[i]).sort((a, b) => a - b)[g.length >> 1];
    for (const i of g) {
      const eg = obs[i].t - D[i] * 1e3 / C, eh = eg - X[i];
      e[i] = D[i] < 120 ? eg : D[i] > 700 ? eh : Math.abs(eg - m) < Math.abs(eh - m) ? eg : eh;
    }
  }
  return e;
}

function cost(obs, groups, p, o) {
  let c = 0;
  const e = reduce(obs, obs.map((x) => geodist(p, x.gps) / 1000), groups, o);
  const t0 = [];
  for (const g of groups) {
    let t, cg = Infinity;
    if (o.late) {
      for (const i of g) for (const k of [-0.5, 0, 0.5]) {
        const cand = e[i] + k * obs[i].sigma;
        let s = 0;
        for (const j of g) { const u = (e[j] - cand) / obs[j].sigma; s += welsch(u, u > 0 ? LATE : EARLY); }
        if (s < cg) { cg = s; t = cand; }
      }
    } else {
      t = g.map((i) => e[i]).sort((a, b) => a - b)[g.length >> 1];
      for (let it = 0; it < 8; it++) {
        let sw = 0, s = 0;
        for (const i of g) { const w = cw((e[i] - t) / obs[i].sigma) / obs[i].sigma ** 2; sw += w; s += w * e[i]; }
        t = s / sw;
      }
      cg = 0;
      for (const i of g) cg += cauchy((e[i] - t) / obs[i].sigma);
    }
    c += cg; t0.push(t);
  }
  return { c, t0, e };
}

// obs: [{gps:[lat,lon], t (s), sigma (s), k?}], ≥3 arrivals per burst.
// opts.late     — night loss (see above)
// opts.h        — E-layer virtual height (km) for the two-mode model, or
//                 opts.hs = [..] to fit it; omitted = ground wave only
// opts.padDeg   — search margin around the receivers (default 6°)
// returns { lat, lon, t0[], res[] (s), w[], chi2, nEff,
//           semiMajorKm, semiMinorKm, orientDeg }
export function locate(obs, opts = {}) {
  if (opts.hs) return opts.hs.map((h) => locate(obs, { ...opts, hs: null, h })).filter(Boolean).reduce((a, b) => (b.cost < a.cost ? b : a), { cost: Infinity });
  const ks = [...new Set(obs.map((x) => x.k ?? 0))];
  const groups = ks.map((k) => obs.map((x, i) => ((x.k ?? 0) === k ? i : -1)).filter((i) => i >= 0));
  if (groups.some((g) => g.length < 3)) return null;
  const la = obs.map((x) => x.gps[0]), lo = obs.map((x) => x.gps[1]), pad = opts.padDeg ?? 6;
  const box = [Math.max(-85, Math.min(...la) - pad), Math.min(85, Math.max(...la) + pad),
    Math.min(...lo) - pad * 1.5, Math.max(...lo) + pad * 1.5];
  // coarse sweep, then pattern-search down from the best few cells
  const N = 60, dLa = (box[1] - box[0]) / N, dLo = (box[3] - box[2]) / N, cands = [];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const p = [box[0] + i * dLa, box[2] + j * dLo];
    cands.push({ p, c: cost(obs, groups, p, opts).c });
  }
  cands.sort((a, b) => a.c - b.c);
  let best = null;
  for (const s of cands.slice(0, 8)) {
    let p = s.p, c = s.c, hLa = dLa, hLo = dLo;
    while (hLa > 1e-4) {
      let moved = false;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const q = [p[0] + a * hLa, p[1] + b * hLo], cq = cost(obs, groups, q, opts).c;
        if (cq < c - 1e-12) { p = q; c = cq; moved = true; }
      }
      if (!moved) { hLa /= 2; hLo /= 2; }
    }
    if (!best || c < best.c) best = { p, c };
  }
  const { p } = best, { t0, e } = cost(obs, groups, p, opts);
  const res = e.map((x, i) => x - t0[ks.indexOf(obs[i].k ?? 0)]);
  const w = res.map((r, i) => { const u = r / obs[i].sigma; return opts.late ? Math.exp(-u * u / (2 * (u > 0 ? LATE : EARLY))) : cw(u); });
  // position information: per burst, fisher in local east/north (km)
  // with that burst's t0 eliminated (schur complement), then summed
  const h = 0.01, kLa = 111.195, kLo = 111.195 * Math.cos(p[0] * Math.PI / 180);
  let a = 0, b = 0, d = 0, chi2 = 0;
  for (const g of groups) {
    const F = [0, 0, 0, 0, 0, 0];   // ee en et nn nt tt
    for (const i of g) {
      const x = obs[i], s = w[i] / x.sigma ** 2;
      const gE = (geodist([p[0], p[1] + h], x.gps) - geodist([p[0], p[1] - h], x.gps)) / (2 * h * kLo) / C;
      const gN = (geodist([p[0] + h, p[1]], x.gps) - geodist([p[0] - h, p[1]], x.gps)) / (2 * h * kLa) / C;
      F[0] += s * gE * gE; F[1] += s * gE * gN; F[2] += s * gE; F[3] += s * gN * gN; F[4] += s * gN; F[5] += s;
      chi2 += w[i] * (res[i] / x.sigma) ** 2;
    }
    a += F[0] - F[2] ** 2 / F[5]; b += F[1] - F[2] * F[4] / F[5]; d += F[3] - F[4] ** 2 / F[5];
  }
  const det = a * d - b * b, tr = (a + d) / det, disc = Math.sqrt(Math.max(0, tr * tr / 4 - 1 / det));
  return {
    lat: p[0], lon: p[1], t0, res, w, chi2, cost: best.c, h: opts.h, nEff: w.reduce((s, x) => s + x, 0),
    semiMajorKm: det > 0 ? Math.sqrt(tr / 2 + disc) : Infinity,
    semiMinorKm: det > 0 ? Math.sqrt(Math.max(0, tr / 2 - disc)) : Infinity,
    orientDeg: 0.5 * Math.atan2(-2 * b, d - a) * 180 / Math.PI,
  };
}
