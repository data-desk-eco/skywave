// Per-pair TDOA hyperbolas, drawn on the mini-map for visual diagnosis.
//
// For each non-reference receiver `other`, the constraint
//
//   d(P, other) − d(P, ref) = c · dtSec_other
//
// defines a curve on Earth (a hyperbola in the plane, slightly distorted
// on the sphere). The solved fix lies on every such curve; in a clean
// fix all curves intersect at one point and fan out elsewhere, in a
// degenerate fix they run nearly parallel near the fix or have a second
// near-intersection that gives the solver a competing basin.
//
// We trace each curve by marching squares over a global lat/lon grid:
// sample the constraint at every grid corner, then for each cell find
// the line segment connecting the zero-crossings on its edges. Cheaper
// than ray-casting from the fix and works equally well far from it,
// which is where the diagnostic value lives.

const C_KM_PER_S = 299792.458;
const EARTH_R_KM = 6371;
const D2R = Math.PI / 180;

function geoDistanceKm(latA, lonA, latB, lonB) {
  const φ1 = latA * D2R, φ2 = latB * D2R;
  const dφ = (latB - latA) * D2R;
  const dλ = (lonB - lonA) * D2R;
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(x)));
}

// Linear interpolation along a cell edge between values vA (at coord A)
// and vB (at coord B), to the zero crossing.
function lerpZero(a, b, vA, vB) {
  const t = vA / (vA - vB);
  return a + (b - a) * t;
}

export function hyperbolaSegments(refGps, otherGps, dtSec, stepDeg = 4) {
  const target = C_KM_PER_S * dtSec;
  const fn = (lat, lon) =>
    geoDistanceKm(lat, lon, otherGps[0], otherGps[1]) -
    geoDistanceKm(lat, lon, refGps[0], refGps[1]) -
    target;

  const latN = Math.floor(180 / stepDeg);
  const lonN = Math.floor(360 / stepDeg);
  const grid = new Float32Array((latN + 1) * (lonN + 1));
  for (let i = 0; i <= latN; i++) {
    const lat = -90 + i * stepDeg;
    const row = i * (lonN + 1);
    for (let j = 0; j <= lonN; j++) {
      grid[row + j] = fn(lat, -180 + j * stepDeg);
    }
  }

  // Cells whose 4-corner constraint values are within FLAT_KM of each
  // other have no real curve passing through them — float noise on a
  // near-zero gradient generates spurious crossings (e.g. near the
  // poles for cohorts at similar latitudes). Filter them out.
  const FLAT_KM = 50;
  const segments = [];
  for (let i = 0; i < latN; i++) {
    const row = i * (lonN + 1);
    const lat0 = -90 + i * stepDeg;
    const lat1 = lat0 + stepDeg;
    for (let j = 0; j < lonN; j++) {
      const v00 = grid[row + j];
      const v01 = grid[row + j + 1];
      const v10 = grid[row + (lonN + 1) + j];
      const v11 = grid[row + (lonN + 1) + j + 1];
      const vmin = Math.min(v00, v01, v10, v11);
      const vmax = Math.max(v00, v01, v10, v11);
      if (vmax - vmin < FLAT_KM) continue;
      const lon0 = -180 + j * stepDeg;
      const lon1 = lon0 + stepDeg;
      const c = [];
      if ((v00 > 0) !== (v01 > 0)) c.push([lat0, lerpZero(lon0, lon1, v00, v01)]);
      if ((v01 > 0) !== (v11 > 0)) c.push([lerpZero(lat0, lat1, v01, v11), lon1]);
      if ((v11 > 0) !== (v10 > 0)) c.push([lat1, lerpZero(lon1, lon0, v11, v10)]);
      if ((v10 > 0) !== (v00 > 0)) c.push([lerpZero(lat1, lat0, v10, v00), lon0]);
      if (c.length === 2) {
        segments.push([c[0], c[1]]);
      } else if (c.length === 4) {
        // Saddle cell — connect (0,1) and (2,3) by convention.
        segments.push([c[0], c[1]]);
        segments.push([c[2], c[3]]);
      }
    }
  }
  return segments;
}
