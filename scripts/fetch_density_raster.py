#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "mapbox-vector-tile", "numpy"]
# ///
"""Build a global vessel-presence raster for the TDOA dual-basin tiebreaker.

Pulls Global Fishing Watch 4Wings heatmap tiles (public-global-presence),
decodes the per-cell vessel-hour totals out of the MVT, resamples to a
180 × 360 1° equal-angle grid, log-transforms, and quantises to u8 so the
whole world fits in 64 800 bytes — small enough to bundle into the Worker
as a Data blob.

The output is a plain JS module (base64-embedded) so the same import
path works in both the Worker bundle and the Node-side offline tests
under scripts/. At solve time the Worker scores each candidate basin by
  score = residualKm + λ · densityPenalty(la, lo)
where `densityPenalty` is high in empty ocean and ~0 in busy lanes. That
breaks the dual-basin tie exposed by NEWRESOURCE / EUPHONY ACE-class HF
cohorts, where the residual landscape has two minima ~equally good
geometrically and we need a domain-specific prior to pick the right one.

Run once, commit the output:
    uv run scripts/fetch_density_raster.py
Re-run when GFW publishes a fresher annual roll-up; weekly variation
isn't worth chasing for a tiebreaker prior.

Requires GFW_API_KEY in the environment (in ~/.zshrc).
"""

from __future__ import annotations

import base64
import math
import os
import struct
import sys
from pathlib import Path

import httpx
import numpy as np
from mapbox_vector_tile import decode as mvt_decode

# ---- Knobs ------------------------------------------------------------------

# 2024 is the most recent fully-rolled-up calendar year on GFW at the
# time of writing. The prior is a slow-moving structural fact about
# where ships are; current-year partial data adds noise without value.
DATE_RANGE = "2024-01-01,2025-01-01"
DATASET = "public-global-presence:latest"
ZOOM = 2  # 16 tiles globally; ~0.8° resolution before resampling
TILE_BASE = "https://gateway.api.globalfishingwatch.org/v3/4wings/tile/heatmap"

# Output: 180 lat × 360 lon, row 0 = lat band [89°N, 90°N], col 0 = lon
# band [-180°, -179°]. u8 stores log-quantised hours; see encode/decode.
GRID_LAT = 180
GRID_LON = 360
OUT_PATH = Path(__file__).resolve().parent.parent / "worker" / "src" / "data" / "vessel_density.js"


# ---- Web-mercator <-> lat/lon -----------------------------------------------

def merc_lat_from_y_norm(y_norm: float) -> float:
    """Convert a vertical fraction in [0, 1] (0 = north, 1 = south) into
    geographic latitude in degrees, using the spherical-mercator formula
    XYZ tile servers use."""
    n = math.pi - 2 * math.pi * y_norm
    return math.degrees(math.atan(math.sinh(n)))


# ---- Fetch + decode one tile ------------------------------------------------

def fetch_tile(client: httpx.Client, z: int, x: int, y: int) -> list[tuple[float, float, float]]:
    """Return [(lat, lon, hours), ...] for every non-zero cell in tile (z, x, y).

    GFW returns features whose polygons are axis-aligned rectangles in tile
    coordinates (extent=4096). Each carries a year-keyed `hours` property.
    The mapbox-vector-tile decoder defaults to y-up (y=0 at the south edge
    of the tile), which is what we want for the inverse-mercator math
    below (y_norm = (y_xyz + 1 - mvt_y/extent) / 2^z).
    """
    url = f"{TILE_BASE}/{z}/{x}/{y}"
    params = {
        "format": "MVT",
        "interval": "YEAR",
        "datasets[0]": DATASET,
        "date-range": DATE_RANGE,
    }
    r = client.get(url, params=params, headers=AUTH, timeout=60.0)
    r.raise_for_status()
    if not r.content:
        return []
    tile = mvt_decode(r.content)
    layer = tile.get("main")
    if not layer:
        return []
    extent = layer.get("extent", 4096)
    n_tiles = 1 << z

    out: list[tuple[float, float, float]] = []
    for feat in layer["features"]:
        props = feat.get("properties", {})
        # GFW keys the per-year totals by stringified year; we asked for
        # YEAR interval over a single calendar year, so there's exactly
        # one numeric key in the properties bag. Tolerate either "2024"
        # or whatever year falls inside the date range.
        hours = next((v for k, v in props.items() if k.isdigit() and isinstance(v, (int, float))), 0.0)
        if hours <= 0:
            continue
        ring = feat["geometry"]["coordinates"][0]
        # Polygon is closed (last vertex repeats first); average over
        # the unique 4 corners to get the cell centre.
        cx = sum(p[0] for p in ring[:-1]) / 4
        cy = sum(p[1] for p in ring[:-1]) / 4
        x_norm_global = (x + cx / extent) / n_tiles
        y_norm_global = (y + 1 - cy / extent) / n_tiles
        lon = x_norm_global * 360 - 180
        lat = merc_lat_from_y_norm(y_norm_global)
        out.append((lat, lon, float(hours)))
    return out


# ---- Resample to 1° equal-angle ---------------------------------------------

def build_grid(samples: list[tuple[float, float, float]]) -> np.ndarray:
    """Sum vessel-hours into a 180 × 360 1° grid.

    Mercator cell sizes shrink with latitude, so cells in polar tiles
    represent less ground than cells near the equator. We're summing
    yearly hours, which is an absolute count rather than a density,
    so summing into the destination cell is correct: a 0.4° mercator
    cell at 60°N represents ~0.4° × 0.4°·cos(60°) ≈ 0.08 deg² of ocean,
    and that whole count belongs to the 1° equal-angle cell we land it
    in. We're not trying to recover a density-per-area — only a relative
    "are there ships here" prior.
    """
    grid = np.zeros((GRID_LAT, GRID_LON), dtype=np.float64)
    for lat, lon, hours in samples:
        # Row 0 = [89, 90], row 179 = [-90, -89]
        ilat = int(math.floor(90 - lat))
        if ilat < 0:
            ilat = 0
        elif ilat >= GRID_LAT:
            ilat = GRID_LAT - 1
        ilon = int(math.floor(lon + 180))
        if ilon < 0:
            ilon = 0
        elif ilon >= GRID_LON:
            ilon = GRID_LON - 1
        grid[ilat, ilon] += hours
    return grid


# ---- u8 quantisation --------------------------------------------------------

def quantise(grid: np.ndarray) -> tuple[np.ndarray, float]:
    """log10-then-normalise into u8.

    Vessel-hours per cell span 0 → ~10⁷ with a heavily skewed distribution
    (most ocean is empty, a few cells around Hormuz / Singapore / English
    Channel are extreme). log10 compresses the dynamic range so a u8
    quantum carries useful resolution at all magnitudes; the alternative
    (linear u8) wastes 250 of 256 levels on the long tail and flattens
    the busy/empty distinction we actually want.

    Encoding:  q = round(255 · log10(1 + h) / log10(1 + max))
    Decoding:  h ≈ exp10(q/255 · log10(1 + max)) - 1
    The Worker doesn't need to recover hours — only an ordering — so the
    log10(1+max) scale factor goes in alongside the raster.
    """
    log_grid = np.log10(1.0 + grid)
    max_log = float(log_grid.max())
    if max_log <= 0:
        raise RuntimeError("density grid is empty — check API response")
    q = np.clip(np.round(255 * log_grid / max_log), 0, 255).astype(np.uint8)
    return q, max_log


# ---- Main -------------------------------------------------------------------

def main() -> int:
    api_key = os.environ.get("GFW_API_KEY")
    if not api_key:
        print("error: GFW_API_KEY not set", file=sys.stderr)
        return 1
    global AUTH
    AUTH = {"Authorization": f"Bearer {api_key}"}

    n_tiles = 1 << ZOOM
    print(f"fetching {n_tiles * n_tiles} tiles at z={ZOOM} for {DATE_RANGE} …")
    samples: list[tuple[float, float, float]] = []
    with httpx.Client() as client:
        for tx in range(n_tiles):
            for ty in range(n_tiles):
                cells = fetch_tile(client, ZOOM, tx, ty)
                samples.extend(cells)
                print(f"  tile {ZOOM}/{tx}/{ty}: {len(cells):>5d} non-zero cells")

    if not samples:
        print("error: no cells returned", file=sys.stderr)
        return 1

    grid = build_grid(samples)
    nonzero = int((grid > 0).sum())
    print(f"populated {nonzero}/{GRID_LAT * GRID_LON} cells "
          f"({100 * nonzero / (GRID_LAT * GRID_LON):.1f}%); "
          f"max={grid.max():.0f} hours, total={grid.sum():.0f} hours")

    q, max_log = quantise(grid)

    # Pack as a header + raster blob, base64-encode it, and emit a JS
    # module that exports the parsed grid. Going through a JS module
    # rather than a raw .bin lets us import from both the Worker bundle
    # (wrangler) and Node-side offline tests under scripts/ with one
    # statement and zero filesystem access at runtime.
    #
    # On-wire layout (after base64-decode, byte-for-byte):
    #   magic         "SKWVDENS"  (8 bytes)
    #   version       u8          (1 byte, currently 1)
    #   reserved      3 bytes
    #   rows          u16 little-endian
    #   cols          u16 little-endian
    #   max_log10     f64 little-endian (decoder scale factor)
    #   raster        rows × cols u8, row-major, north→south, west→east
    blob = bytearray()
    blob += b"SKWVDENS"
    blob += struct.pack("<B3xHHd", 1, GRID_LAT, GRID_LON, max_log)
    blob += q.tobytes()
    b64 = base64.b64encode(bytes(blob)).decode("ascii")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w") as f:
        f.write(
            "// Auto-generated by scripts/fetch_density_raster.py — do not edit.\n"
            f"// Source: GFW {DATASET}, date-range={DATE_RANGE}, zoom={ZOOM}.\n"
            f"// Grid: {GRID_LAT} × {GRID_LON} u8, max_log10={max_log:.6f}.\n"
            "\n"
            "export const VESSEL_DENSITY_BASE64 =\n"
        )
        # Wrap to 76-char lines, joined with `+`, so the source file is
        # grep-friendly and stays valid JS (no implicit concatenation).
        chunks = [b64[i:i + 76] for i in range(0, len(b64), 76)]
        for i, chunk in enumerate(chunks):
            sep = ";" if i == len(chunks) - 1 else " +"
            f.write(f'  "{chunk}"{sep}\n')
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes; base64 {len(b64)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
