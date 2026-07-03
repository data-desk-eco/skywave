// Vessel-presence prior for TDOA dual-basin disambiguation.
//
// The TDOA residual landscape on long-baseline HF cohorts often has two
// roughly-equivalent intersection basins (the source basin + a mirror
// in some empty patch of ocean) and the geometric gates can't tell them
// apart — both pass <220° bearing-gap and <1000 km ellipse, both have
// small internal residuals. DSC traffic is overwhelmingly maritime,
// concentrated in shipping lanes and chokepoints, so "where ships
// actually are" is a strong domain-specific tiebreaker the gates don't
// have.
//
// This module loads a 1° equal-angle raster of GFW's public-global-
// presence dataset (annual vessel-hours, log-quantised to u8) and
// exposes `densityPenaltyDex(lat, lon)`. The penalty is in log10 units
// below the global busiest cell (Hormuz, ~4 × 10⁷ vessel-hours/year):
//   penalty ≈ 0       in the busiest lanes
//   penalty ≈ 7-8     in genuinely empty Southern-Ocean / mid-Pacific
// solveTdoa multiplies this by a tunable λ (km/dex) and adds it to
// residualKm when scoring candidate basins. See tdoa-do.js for the
// constant + rationale.
//
// Source: scripts/fetch_density_raster.py. Re-run that script to refresh
// from a newer GFW annual roll-up; the raster is structural enough
// (where shipping lanes are doesn't change month to month) that this
// is yearly maintenance at most.

import { VESSEL_DENSITY_BASE64 } from "./data/vessel_density.js";

let _grid = null;        // Uint8Array, row-major, north→south, west→east
let _rows = 0;
let _cols = 0;
let _maxLog = 0;         // log10(1 + max_hours), the quantisation scale

function _load() {
  if (_grid) return;
  // Decode the base64 payload to a Uint8Array. `atob` is available in
  // both Workers (native) and modern Node, so this works in the
  // bundled Worker and in scripts/ offline tests with one code path.
  const bin = atob(VESSEL_DENSITY_BASE64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  if (buf.length < 24) throw new Error("density: blob too small");
  // Magic "SKWVDENS" at byte 0 guards against accidental wrong-import.
  const magic = String.fromCharCode(...buf.subarray(0, 8));
  if (magic !== "SKWVDENS") throw new Error(`density: bad magic '${magic}'`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint8(8);
  if (version !== 1) throw new Error(`density: unknown version ${version}`);
  _rows = dv.getUint16(12, true);
  _cols = dv.getUint16(14, true);
  _maxLog = dv.getFloat64(16, true);
  _grid = buf.subarray(24);
  if (_grid.length !== _rows * _cols) {
    throw new Error(`density: expected ${_rows * _cols} cells, got ${_grid.length}`);
  }
}

// Penalty for placing a fix at (lat, lon), in log10 units below the
// global busiest cell. 0 = peak shipping lane (Hormuz / Singapore /
// Channel), ~7-8 = empty Southern Ocean. Out-of-range coordinates
// return the maximum penalty (treat them as empty).
export function densityPenaltyDex(lat, lon) {
  _load();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return _maxLog;
  // Wrap longitude into [-180, 180); clamp latitude.
  let lo = lon;
  while (lo < -180) lo += 360;
  while (lo >= 180) lo -= 360;
  const irow = Math.min(_rows - 1, Math.max(0, Math.floor(90 - lat)));
  const icol = Math.min(_cols - 1, Math.max(0, Math.floor(lo + 180)));
  const q = _grid[irow * _cols + icol];
  const logH = (q / 255) * _maxLog;  // log10(1 + hours) reconstruction
  return _maxLog - logH;
}

// Exposed for tests / diagnostics. Returns the cell-centre lookup as
// log10(1 + vessel-hours) on the year the raster was built. Mostly
// useful for sanity-checking the bundled blob from a worker route.
export function densityLogHours(lat, lon) {
  _load();
  const pen = densityPenaltyDex(lat, lon);
  return _maxLog - pen;
}

export function densityMetadata() {
  _load();
  return { rows: _rows, cols: _cols, maxLog: _maxLog };
}
