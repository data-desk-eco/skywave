# Skywave

Single-page browser app that watches a rack of public KiwiSDR
receivers tuned to the six international DSC channels, decodes every
call, and prints the result as a scrolling table. Optional Global
Fishing Watch enrichment resolves each caller's MMSI to a ship name,
flag, type and 14-day AIS track. For target regions, when ≥3 receivers
hear the same burst, a TDOA solver triangulates the transmitter's
position and broadcasts a fix to subscribed clients.

## Topology — v2, edge-decoded

One Cloudflare Durable Object per KiwiSDR channel holds the only
upstream WebSocket, runs the DSC decoder, and fans decoded calls out
to every browser attached to it. The browser is a pure viewer.

```
browser —ws—┐
browser —ws—┼──► ReceiverDO (one per <host>:<port>:<bandKHz>)
browser —ws—┘        │ upstream ws://
                     ▼
                 KiwiSDR @ Etten-Leur / Dover / …
```

* **DirectoryDO** (singleton) refreshes the public kiwisdr_com list and
  composes the "front page" rack for each region. HTTP only — traffic
  doesn't flow through it.
* **ReceiverDO** (keyed) owns the upstream, runs `dsc.js` on a
  10-second rolling Float32 ring, broadcasts decoded calls, and
  gates base64 PCM frames on a Goertzel burst detector (1615 /
  1785 Hz). Uses the hibernation API so client sockets are cheap;
  closes itself 5 min after the last viewer leaves. Also POSTs each
  decoded call's GPS-anchored audio snippet to `TDOADO`.
* **TDOADO** (singleton) buckets snippets by fuzzy MMSI + same band +
  tight packetGpsNs window, classifies each bucket's propagation
  regime to pick a site-dedup radius, estimates each pair's arrival-
  time difference with the complex-envelope correlator (`toa.js`),
  runs `solveTdoa`, applies the post-solve gates (residual + edge +
  far-field + registry + bearing-gap + ellipse + AIS oracle), tracks
  per-MMSI fix history for convergence telemetry, and broadcasts each
  surviving fix to clients on `/v2/tdoa/subscribe`.
* **locationHint**: a ReceiverDO is placed near its KiwiSDR via a
  GPS-derived CF region string (apac / weur / wnam …), keeping
  upstream hops on-continent.

There is no persistent state worth backing up — DO storage holds only
each ReceiverDO's (host, port, band, label, gps) config and the
TDOADO's last 100 broadcasts (`/recent` debug ring).

## Why the rack looks the way it does

Two rack flavours live in `worker/src/regions.js`:

- **bbox regions** — the default "show me a rack across this big area"
  picker (`pickRack`). Band-weighted slot allocation (HF8/HF12 get
  more, HF4 fewer) reflects which bands actually produce co-hearings.
  Cluster-gate on MF/HF4 only (short-range bands); HF6+ skip-zone
  receivers stay in. Used for the "Global" view and continent-scale
  presets.
- **target regions** — a tight cohort focused on one specific patch
  of sea (`pickTargetRack`). Two cohort-selection strategies depending
  on whether the target restricts bands:
  - **Ground-wave mode** (`target.bands` set, e.g. `[2187.5]` for MF):
    `pickGroundWaveCohort` picks the closest receiver in each compass
    octant, then tops up with the next-closest unpicked. Site-deduped
    at 5 km. SNR self-report is ignored (it's a noise-floor estimate,
    not a decode predictor). The whole available pool is taken
    (`cohortSize: 40` is naturally capped by the pool, ~25-35 distinct
    sites within a 400 km radius of busy maritime areas).
  - **Surround mode** (no `target.bands`): `pickSurroundCohort` does
    one-per-octant SNR-weighted, replicates across all 6 DSC bands
    each receiver covers. Used for long-baseline targets where ground
    wave isn't an option (sea-pac, persian-gulf, etc.).

All picks pass the same hard health filters: **active**, **GPS-equipped
and actively fixing** (TDOA needs per-frame GNSS timestamps — this also
cuts the pool by ~37%), **list entry updated in the last hour, not IP-
blacklisting us**, and **considerate** (≥ 2 free user slots so a human
listener always has one). Any one (host, port) is capped at 2 bands
in the bbox picker so the rack doesn't over-index on a single operator;
target picks replicate across allowed bands deliberately. The "Global"
view and per-region bbox views share a 40-slot ceiling (lowered from
96 to keep monthly DO compute under Cloudflare's 400k GB-s free tier).

Scoring (bbox): `freeSlots × coastalProximity × snrBonus × antennaBonus`.
`antennaBonus = 1.5` when the antenna free-text mentions a broadband
design (loop / dipole / T2FD / Beverage / folded / longwire).

## TDOA methodology

The pipeline organises around **propagation regimes**, but uses them
only to pick the right site-dedup radius — not as a hard gate. Live
data showed regime-as-rejection was doubly conservative: it filtered
many legitimate cohorts while the post-solve ellipse + bearing-gap
gates had headroom to spare. The current shape:

1. Bucket by `(MMSI, band, same-burst time-window)`.
2. Classify the cohort's regime from band + max pairwise distance.
3. Site-dedup at the regime-appropriate radius (adaptive for HF).
4. Estimate per-pair arrival-time differences (complex-envelope
   correlator, `toa.js`; pairs below the peak-ratio confidence floor
   are dropped individually).
5. Solve.
6. Apply the post-solve gates (residual, edge, far-field, registry,
   bearing-gap, ellipse, AIS oracle).
7. Record per-MMSI fix history; report convergence as telemetry.
8. Broadcast.

### Arrival-time estimation (`worker/src/toa.js`)

The v1 pipeline cross-correlated raw real audio and took the maximum.
That estimator carries three structural errors on a 100 Bd / 170 Hz
FSK burst: the correlation's fine structure oscillates at the ~1.7 kHz
audio tone, so the peak lands wherever the pair's random phase offset
(receiver LO phases + RF carrier phase at the two sites) says — an
irreducible uniform ±0.29 ms bias; under noise it slips whole cycles
(±0.59 ms quanta); and a fractional-Hz LO offset between the two Kiwis
decorrelates the whole 2 s window (Monte Carlo: p90 jumps to ~11 ms at
2 Hz CFO). Together: the "~1 ms KiwiSDR timing noise" of earlier
iterations was mostly estimator artifact, not hardware.

The replacement correlates **complex analytic snippets** (imaginary
part reconstructed losslessly by `hilbert()` — the Kiwi passband is
positive-only, so real(IQ) is sufficient) and picks the peak of the
**envelope** |R(τ)|, which has no carrier fine-structure. A small grid
of spectral shifts handles CFO. Monte Carlo on synthetic DSC bursts:
p50 15–52 µs at 5–20 dB in-band SNR with zero cycle slips (production
xcorr: 110–540 µs, 13–77 % slips); 2–6 µs at high SNR. The GPS time
base itself is good to ~0.1 µs (measured live: per-frame GNSS stamps
against a linear clock fit), so the estimator now dominates the error
budget — and below it, propagation.

`estimateDt` also returns `peakRatio` — envelope peak over the rms
envelope beyond the ±5.9 ms FSK beat sidelobes. Locked live pairs
measure 2.9–5.2; unlocked pairs ~1. Pairs under `MIN_PEAK_RATIO = 2`
are dropped from the cohort individually (`pair` rejection counter),
not fatally. Mixed sample rates (a few Kiwis serve 20.25 kHz) are
cubic-resampled onto the reference rate instead of, as before, the
whole bucket being discarded. Snippets run 0.5 s before + 3.5 s after
the decoder's packet-start anchor — most of the burst's energy;
correlation noise scales as 1/√T. The pair search window is clamped
to ±0.35 s because DSC's DX/RX interleave repeats every symbol 400 ms
later, a correlation ghost the search must never reach.

### The two regimes

| regime | trigger | site-dedup | what it is |
|---|---|---|---|
| **ground-wave** | band = MF AND cohort max-pairwise ≤ 1500 km | 5 km | Signals travel geodesically along the surface at ~c. Solver assumption matches reality. Used by LIG / WAPP / NY / KAT / CHES / english-channel / dover. |
| **long-baseline** | everything else (any HF cohort, or wide MF) | adaptive: max(500 km, max_pairwise / 20) | Skywave is the actual physics; clustered receivers contribute the same constraint, so the dedup collapses near-duplicates and the post-solve gates judge what survives. AWTAD/PALATINE-class cohorts (clustered HF receivers ≤500 km apart) all collapse to ≤1 effective receiver and fail q≥4 at the dedup gate. ISABELITA-class (3 European HF receivers 480-830 km apart, in a 17 000 km cohort) collapse via the adaptive radius (~850 km) to 1 effective European, then fail q≥4. SBITANGO/MEDI NOSHIMA-class (genuinely distributed) survive.

### Per-regime site-dedup

Receivers within the regime's dedup radius give essentially the same
TDOA constraint and shouldn't fake `q ≥ 4` overdetermination. Solve-
time dedup runs after classification; the cleanest decode in each
cluster wins (and becomes the xcorr reference by virtue of
`dedupByLocation` returning cleanest-first).

The long-baseline radius is **adaptive**: `max(500 km, max_pairwise /
20)`. Empirically, this keeps the SBITANGO-class cohorts (4-5 well-
spread receivers, closest pair ~700 km) intact while collapsing
ISABELITA-class cohorts (3 European receivers within 800 km collapse
to 1 because at a 17 000 km cohort spread their TDOA contributions are
geometrically equivalent). Dedup goes greedy cleanest-decode-first —
order matters, so picking by `mmsiQuality` keeps it deterministic.

### Dual-basin disambiguation: vessel-density prior

Long-baseline HF cohorts often produce a residual landscape with two
roughly-equivalent intersection basins — the truth basin and a mirror
basin somewhere in empty ocean. The geometric gates can't tell them
apart: both pass the bearing-gap test (cohort spans ~190° from either
viewpoint), both have small ellipses (locally well-determined), both
have small residuals (the wrong basin is internally self-consistent
under whatever skywave-degraded timings the xcorr produced).

Examples that drove this in: NEWRESOURCE 636014485 (truth Oman, fix
−44°/30° south Atlantic) and EUPHONY ACE 431434000 (truth Arabian Sea,
fix −32°/38° south Indian Ocean). Both 4-RX HF12 cohorts. Both passed
every existing gate.

The disambiguator is a **shipping-density prior**. DSC is a maritime
service: every legitimate transmitter is a vessel in a shipping lane
or a coast station on a coastline. "Where ships actually are" is a
strong domain-specific tiebreaker that the geometric gates can't
access. The solver scores each candidate basin by

```
score = residualKm + λ · densityPenaltyDex(la, lo)
```

where `densityPenaltyDex` is `log10(max_hours / (1 + cell_hours))` from
a 1° equal-angle raster of GFW's `public-global-presence` annual
vessel-hours dataset (busy lanes ~0 dex, empty ocean ~7-8 dex). The
solver picks the lowest-score basin after refinement, not the lowest-
residual one.

`λ = 100 km/dex` calibrated against the two captured ghosts:

| case | truth Δdex | wrong Δdex | headroom |
|---|---|---|---|
| NEWRESOURCE | 2.5 | 6.3 | 380 km |
| EUPHONY ACE | 2.8 | 3.5 | 78 km |

EUPHONY's 78 km headroom is the binding constraint — the wrong basin
sits on the Cape-of-Good-Hope shipping route and isn't all that empty.
Bigger λ would over-weight the prior and pull single-basin fixes
toward shipping lanes; smaller λ would fail EUPHONY-class cases.

The prior is always-on. For ground-wave cohorts the residual landscape
is single-basin and the prior moves the fix imperceptibly within the
basin (residual gradients dominate near the minimum). The `runnerUp`
field on broadcasts surfaces the alternative basin (lat, lon, residual,
prior penalty, separation) when phase-2 refinement found two distinct
minima >1500 km apart, so we can see at a glance whether the prior
was load-bearing for any given fix.

The raster lives at `worker/src/data/vessel_density.js` (~95 KB JS, base64-
embedded so the same import path works in the Worker bundle and in
Node-side offline tests). Source-of-truth is
`scripts/fetch_density_raster.py` — re-run yearly when GFW publishes a
fresher annual roll-up; the where-ships-are surface is structural
enough that month-to-month variation isn't worth chasing.

### Gates that apply across all surviving regimes

`worker/src/tdoa-do.js`:

- **q ≥ 4 (post-dedup)**. q=3 is exactly determined in 2D, has a
  mirror ambiguity that only a 4th constraint breaks, residual ≡ 0 by
  construction. Decoded calls still surface in the table (presence
  info); we just don't pretend we know where the source is.
- **Same band per bucket** (ingest invariant) — receivers on different
  DSC bands hear different physical transmissions, so cross-band
  snippet xcorr is noise. Imposed in `_findMatchingBucket`.
- **Residual ≤ 300 km** — belt-and-suspenders against grossly bad
  xcorr lags. Most ghosts have small residuals because the wrong basin
  is internally self-consistent, so this rarely fires alone.
- **Bearing gap ≤ 220°** — max angular gap between consecutive
  receivers as seen from the solved position. >220° means the cohort
  is bunched in <140° of the compass and the fix is unconstrained in
  the away direction.
- **Ellipse semi-major ≤ 1000 km** — the 1σ position-uncertainty
  ellipse from the cohort's Fisher matrix at 1 ms per-receiver timing
  noise. Strongest single signal in live data: a near-singular Fisher
  matrix blows up to thousands of km along the unconstrained axis.
- **Far-field (plane-wave) gate** — reject when a plane wave explains
  the measured timings nearly as well as the point fix
  (`planeResidKm < max(2.5 × pointResidKm, 30 km)`; at q=4 the ratio
  threshold is 4.0 because the plane fit has one degree of freedom and
  the ratio gets noisy — a live q=4 ghost passed at 2.65 while real
  q=4 fixes measure p50 ≈ 10). A source far beyond
  the cohort's diameter produces a near-planar wavefront: arrival-time
  differences become a linear function of receiver position and the
  cohort fundamentally cannot range the source — the point solver then
  picks an arbitrary basin inside its search box. This is the internal
  signal for the **night-MF-skywave failure mode** discovered live on
  2026-06-09: after dark, Channel MF cohorts decode coast stations and
  vessels 750–2400 km away (Lyngby, Civitavecchia, Trieste, a tanker
  anchored in Greece), classify as ground-wave by cohort spread, and
  solve geodesic ghosts into the local sea. Calibration
  (`scripts/test_farfield.mjs`): sources ≤300 km from a Channel-like
  cohort give ratio ≥2.8 (p10) at 0.1 ms noise with ≤50 km fix errors;
  sources ≥800 km give ratio ≈1 and 200+ km errors; live ghosts
  measured 1.12 and 1.59. The ratio doubles as an accuracy gate —
  below 2, timing noise has drowned the wavefront curvature and even
  a real source's fix is >100 km off. Global-scale HF cohorts
  (SBITANGO-class) measure ratio 5–38 because Earth curvature breaks
  the planar model, so the gate never misfires on legitimate
  long-baseline fixes. Broadcasts carry `farfieldRatio` +
  `planeResidKm` in `geometry` for threshold retuning.
- **Mixed-cohort rescue (nearest-6 re-solve)** — not a gate but the
  cadence-saving counterpart to the far-field gate. Night-MF cohorts
  are often a mix: receivers near the source hear it by ground wave
  (clean timing) while far ones hear it by skywave (+0.4–1.5 ms hop
  delay). Plain least squares smears the regimes — live q=9..11
  cohorts for tankers anchored at Milford Haven (FRONT LEOPARD /
  AURORA SPIRIT, Kpler-verified) produced fixes 60 km from truth with
  ~300 km residuals, dying at the gates. When the full-cohort solve
  would fail the residual or far-field gate and q ≥ 7, the coordinator
  re-solves on the 6 receivers nearest the initial fix — for a real
  near source those are the ground-wave hearers (synthetic recovery:
  8–35 km errors). The subset selection is purely geometric: unlike a
  RANSAC-style consensus pick (tried, rejected) it has no freedom to
  assemble a timing-coherent skywave subset into a convincing ghost —
  a far source's nearest-6 subset is still contaminated and still
  fails the gates. Rescued broadcasts list the excluded receivers in
  `geometry.droppedReceivers`.
- **Coast-station registry gate** — `worker/src/coast-registry.js`
  holds verified positions for ~25 European + Chinese MF/HF DSC coast
  stations (multi-site networks store every transmitter site). A fix
  for a registered MMSI landing >500 km from every site is provably
  wrong and rejected regardless of geometry. This is the external
  oracle for the persistent-ghost mode (stable cohort, same wrong
  basin every burst, 100% convergence) that no internal signal can
  catch. Only confidently-sourced positions belong in the registry —
  a wrong entry silently rejects real fixes. ITU's coast-station list
  (itu.int/mmsapp) resolves MMSI → station name; positions come from
  operator publications.
- **Edge gate** — a solver minimum pinned against the search-box
  boundary means the true source is outside the box (far skywave);
  the solver flags it (`atEdge`) and the coordinator rejects. Perfect
  score in validation: 10/10 edge-gated fixes were confirmed ghosts at
  1082–1490 km from AIS truth (TOM SAWYER in the Baltic, COSCO
  SHIPPING HIMALAYAS off Sardinia, …), zero real fixes lost.
- **AIS oracle (vessels)** — the counterpart of the registry gate for
  moving transmitters, and the closure for the one failure mode no
  internal signal can catch. Proven necessity 2026-07-03: a q=4 night
  cohort heard ESVAGT OBSERVER ~970 km away off Shetland via 1-hop
  skywave, and the path-difference timings fit a mid-Channel geodesic
  source with **0.8 km residual and a 102× far-field ratio** —
  internally flawless, externally provably wrong (the vessel was on DP
  at a rig, LSEG AIS 30 s old). At fix time the coordinator queries
  LSEG (MMSI → IMO via GFW identity → RIC → TR.AssetLocation*),
  rejects when the implied speed from the freshest AIS point exceeds
  60 kn, and annotates every surviving broadcast with the AIS miss
  distance (`ais: {name, km, ageH, impliedKn}`) — free per-fix
  validation telemetry. The cache is pre-warmed when a vessel bucket
  starts pairing (the cold chain takes >5 s); lookup failures and
  missing credentials never block a broadcast. Requires the
  `LSEG_APP_KEY` / `LSEG_PROXY_API_KEY` wrangler secrets.

The ellipse gate's σ_t is calibrated against measured reality now:
the GPS anchor chain is ~0.1 µs, the estimator 15–50 µs, and the rest
is propagation (from ~100 µs on contaminated daytime MF paths to
~1 ms+ at night / on HF). The ellipse itself validated well: STENBERG
(anchored, truth known) produced fixes 103 km off with a one-sided
cohort whose reported semi-major was 335 km — the miss was inside 1σ.

### Convergence telemetry

For each MMSI we keep the last 10 fixes within a 30-minute sliding
window. Every broadcast includes a `convergence` field:

```
{ fixCount, agreeCount, maxDistKm }
```

`agreeCount` is the number of recent fixes within 200 km of the new
one (including the new one itself). `maxDistKm` is the widest
separation in the recent set.

This is **observability, not a gate**. Live data shows:
- Most repeat fixes converge tightly (0–250 km between fixes for the
  same MMSI), regardless of whether they're real or wrong. A coast
  station that consistently fixes in the wrong basin still shows
  `2/2 within 0 km`.
- Genuinely useful: catches the `004122100`-class case where 5 of 6
  fixes converge at the Yangtze and 1 outlier is 7700 km away.
- The UI surfaces it as `N/M converging` so the human can judge.

### Rejection telemetry

The rejection counter (`/v2/tdoa/recent`) tracks buckets dropped at
each stage:
- `dedup` — post-dedup count fell below q=4 (catches AWTAD/PALATINE/
  ISABELITA-class clustered cohorts)
- `pair` — a receiver's envelope correlation never locked
  (peakRatio < 2); dropped individually, not fatal to the bucket
- `residual`, `bearing`, `ellipse` — failed the named gate at solve
  time
- `edge` — solver minimum pinned to the search-box boundary (source
  outside the box)
- `farfield` — plane wave fit the timings as well as the point fix
  (night-skywave ghosts; see far-field gate above)
- `registry` — a registered coast station fixed >500 km from every
  known transmitter site
- `ais` — a vessel fix implying >60 kn from its freshest LSEG AIS
  position

Watching the relative counts across these is the cheapest way to
understand which class of cohort the rack is actually producing.

### Persistent ghosts — closed

The vessel-density prior catches the dual-basin failure mode (one of
two equally-good intersection basins is in genuinely empty ocean).
The classic persistent-ghost mode — **a stable cohort consistently
producing the same wrong basin across multiple bursts** (far source
via skywave, path-difference timing fits a nearer geodesic source,
100% convergence) — is now attacked from two sides:

- The **far-field gate** catches it internally whenever the wavefront
  reaching the cohort is near-planar, which is the geometric signature
  of "source much further than the cohort is wide". This killed the
  `005030001`-class (Falmouth → Coral Sea) and the 2026-06-09 live
  crop (Lyngby → mid-Channel, Civitavecchia/Trieste → mid-Channel,
  SIKINOS tanker anchored in Greece → North Sea).
- The **registry gate** catches registered coast stations even when
  the timing happens to fit a near-field interpretation.

- The **AIS oracle** closes the last mode: a far **vessel** (no
  registry entry) whose skywave timings fit a curved, near-field
  interpretation better than a planar one. Not rare after all —
  the 2026-07-02 overnight capture produced four of them in one
  night, all passing every geometric gate, all provably wrong by
  LSEG AIS (ESVAGT OBSERVER being the canonical case: 0.8 km
  residual, ff 102, truth 970 km away). The fix-time LSEG check in
  the worker rejects them and annotates everything else.

### Reference receiver

The reference is the cohort's **cleanest decode** (highest
`mmsiQuality` — fewest `?` characters in the recovered MMSI), not
just the first detection to arrive. The reference snippet is the
xcorr template every other receiver gets correlated against, so a
noisy template directly inflates the lag estimate noise on every
other receiver. Picking the cleanest decode is a strict improvement
with no downside, since most cohorts have at least one receiver that
got every bit right and ties fall back to first-arrival.

### Hyperbola visualisation

Each non-reference receiver contributes one hyperbola: the locus of
points where geodesic timing would match the measured offset. In a
clean fix all curves intersect at the diamond and fan out elsewhere;
in a degenerate fix they run nearly parallel near the fix or have a
second near-intersection that gives the solver a competing basin —
which is exactly the failure mode the gates can't always catch
(AWTAD-style "wrong propagation model fits a near-cohort source").

The mini-map traces each curve via marching-squares zero-crossings
of the constraint on a global lat/lon grid, drawn as subtle white
polylines. Cheaper than ray-casting from the fix, and works equally
well far from the fix where the diagnostic value lives. See
`client/hyperbola.js`.

### Solver

`worker/src/tdoa.js`:
- Plain geodesic distance — no skywave / slant correction. The HF
  skywave fixes that pass do so because their geometry is good enough
  that residual per-hop variability stays inside the timing-noise
  budget the gates already account for.
- Two-phase grid search: 81×81 coarse sweep over the receiver bbox
  expanded by 10°, then nested refinement on the top-6 coarse cells.
  Each refined cell is a candidate basin; the solver picks the lowest-
  scoring one (`residualKm + λ · prior(la, lo)`), not the lowest-
  residual one. Top-K bumped from 3 to 6 so the dual-basin
  disambiguation has the alternative basin available when there is
  one — refinement is bounded and won't migrate from one basin to
  another.
- `tdoaUncertainty` returns the 1σ error ellipse (Fisher inverse →
  2×2 eigendecomposition). **Load-bearing for the ellipse gate**, not
  just telemetry.

### Cohort selection

`worker/src/regions.js`:
- **bbox regions** (Global + continent presets) → `pickRack` allocates
  40 slots across all 6 DSC bands. **For HF bands, picks are scored
  by `base_score × spread_bonus`**, where `spread_bonus` saturates at
  5 000 km from the nearest already-picked same-band receiver — that's
  the long-baseline-regime threshold the solver uses, so picks beyond
  it count as "geometrically distinct" for free. The intent is to
  build an HF rack whose detection cohorts are *long-baseline by
  construction*, so most HF multi-RX bursts land cleanly in the
  long-baseline regime instead of the ambiguous middle. **MF picks
  keep the original "best score" behaviour** because tight ground-wave
  coverage is what we want there.
- **target regions with `target.bands: [2187.5]`** → `pickGroundWaveCohort`
  picks octant-balanced MF receivers within `radiusKm`. Site-deduped
  at 5 km. SNR self-report ignored (it's a noise-floor estimate, not
  a decode-rate predictor). Feeds the ground-wave regime by design.
- **target regions without `target.bands`** → `pickSurroundCohort`
  for long-baseline targets where ground wave isn't an option.
- All picks pass the same hard health filters: active, GPS-fixing,
  considerate (≥2 free user slots), recent.

### Validation — 2026-07-02/03 ground-truth campaign

The question "can this really produce decent, consistent fixes?" got
a dedicated 20-hour campaign: three parallel IQ captures with full
GPS-anchor + complex-snippet recording (`scripts/capture_iq.mjs` —
Channel MF overnight 4.2 h / 3 400 decodes; Channel MF daylight
06:28–12:28 UT through solar noon / 1 360 decodes; global HF8-16,
24 receivers on 4 continents, 5 h / 2 380 decodes; plus a sparse US
East Coast set), LSEG AIS polled every 15 min for every vessel heard
(`ais_watch.mjs`, 47 stationary vessels as delay-proof truth), all
replayed through the production coordinator (`replay_capture.mjs` +
`score_replay.mjs`). Findings, most important first:

- **The timing chain is clean.** Per-frame KiwiSDR GNSS stamps are
  self-consistent to ~0.1 µs; the envelope estimator reaches 15–50 µs
  on synthetic and single-digit-µs repeatability on strong live pairs
  (back-to-back bursts repeat to 1–30 µs). Nothing in the hardware or
  DSP now caps accuracy.
- **Propagation is the budget.** Night MF: 300–900 µs burst-to-burst
  ionospheric variability — irreducible, and *fatal in a way gates
  can't see* (see the AIS-oracle rationale: sub-km residuals on
  970 km ghosts). Daylight July MF: still ~100–300 µs mixed-mode
  contamination (sporadic-E season) — 1000+ km DX decodes at solar
  noon are routine. HF: 1.7–4.6 **ms** vs geodesic truth (multi-hop),
  though stable paths repeat to 30 µs (Coruña heard in Germany + New
  Zealand), so differential schemes have headroom.
- **Day-set scorecard (production stack, AIS truth):** 118 solve
  attempts → 87 confirmed ghosts all correctly rejected, 26
  real-but-modest fixes (3–100 km error, median ~45 km) suppressed by
  the far-field/ellipse gates, 1 leak at 146 km that the (offline-
  disabled) AIS oracle catches live. Zero clean fixes existed to
  pass: no cohort that morning was surrounded + uncontaminated.
- **Decode coverage is the binding constraint on geometry.** Of 235
  distinct day bursts, 138 were decoded by exactly one receiver and
  only 38 reached q≥4; the top receiver decoded 60× more than the
  median. Cohorts end up one-sided (all south of the source), so even
  perfect timing leaves a 300 km ellipse axis. Decoder sensitivity
  (coherent demod, soft-decision ECC) is the highest-leverage
  future improvement — worth more than any further timing work.
- **Honest capability statement.** Consistent, ghost-free output is
  achievable — as suppressed-ghosts + occasional 20–100 km fixes with
  per-fix AIS annotation — in daytime dense-receiver regions.
  Km-grade fixes are physically available (best validated fix: 3 km)
  but need a clean ionosphere (winter day, no Es) AND a surrounded
  cohort; July delivers neither reliably. Night MF and global HF are
  presence + ocean-basin localization, not tracking.

### Validation — earlier iterations

Live capture against the deployed Global rack while iterating the
gate stack:
- ~10 fixes/min throughput pre-regime-classification; expected to
  drop to a slower stream of higher-confidence fixes after, with the
  ambiguous middle dropped wholesale.
- The decisive failures that drove the regime split:
  - **AWTAD** (Saudi cargo, q=3 → q=4 after MIN_RECEIVERS bump): 3
    NW-European HF16 receivers heard a Persian-Gulf transmission via
    skywave; fix landed in the cohort itself in NW Europe. Cluster
    diameter ~600 km → ambiguous → reject.
  - **PALATINE** (MLT cargo, q=4): 3 N-Italian HF8 receivers within
    150 km + 1 in the UK; fix landed inside the Italian cluster.
    Cluster diameter ~1500 km, HF → ambiguous → reject.
  - **ISABELITA** (q=5): 3 European HF12 receivers (480-830 km
    pairwise) + 1 NZ + 1 Indonesia; long-baseline cohort spread, but
    European 3 contributed identical constraint and fix landed in
    Tibet. Cohort diameter ~18 000 km → long-baseline → adaptive
    dedup at ~900 km collapses the European 3 to 1 → q=3 < 4 → drop
    at the dedup gate.
- Cases preserved by the new methodology:
  - **WHITCHALLENGER** (UK tanker, english-channel cohort): MF
    ground-wave, q=4/6/7 fixes converging within 10 km of each other
    and 40-50 km of her Solent anchor. Tight cohort (~700 km
    diameter), MF → ground-wave regime → preserved.
  - **SBITANGO** (MHL cargo): 5 HF12 receivers spanning NZ →
    Hong Kong → Finland → UK / Denmark; fix at (5.7°N, 71°E) Indian
    Ocean validated against fresh AIS. Cohort diameter ~17 000 km →
    long-baseline → adaptive dedup at ~850 km is large enough to
    drop one of the 700-km European pairs but leaves q=4 distinct
    geographies.

`scripts/global_chokepoints.mjs` ranks where ground-wave cohorts can
form on the current public KiwiSDR fleet:
- **Tier 1**: Dover Strait, English Channel — 26-32 receivers within
  60° bearing gap.
- **Tier 2**: NY Harbour, Skagerrak/Kattegat, Chesapeake, Cornwall
  Lands End, Northern Italy — 11-19 receivers within 95-167° gap.
- **Other strategic chokepoints** (Hormuz, Malacca, Bosphorus,
  Singapore) lack ground-wave receiver density — they appear on the
  Global rack via HF skywave instead, and depend on the long-baseline
  regime + HF spread bias in the picker for usable cohorts.

### Future work

- **Decoder sensitivity — the highest-leverage item.** The 2026-07-03
  day capture showed decode coverage, not timing, now bounds fix
  quality: 138/235 bursts decoded by a single receiver, 60× decode-
  rate spread across the rack, cohorts one-sided as a result. A
  coherent demod with soft-decision ECC (the current one is
  non-coherent, hard-decision, needs near-full phasing) would grow
  quorums and surround-ness everywhere at zero infra cost.
- **Multi-burst aggregation as a fix-quality signal.** Convergence
  telemetry is in place but only as observability. A future iteration
  could weight the broadcast position by recent convergent fixes
  (geometric median, ellipse-weighted) and emit a fused fix instead of
  the latest raw one. Improves spatial accuracy for vessels emitting
  multiple bursts.
- **Threshold calibration from live data.** The 1500 km / 5000 km
  regime boundaries and the 5 / 500 / max_pairwise/20 dedup scales
  are picked off intuition. The `regime` field on every broadcast,
  the rejection counter under `dedup`, and the `convergence` field
  give the data needed to retune over a longer capture.
- **λ tuning for the density prior.** Currently 100 km/dex, calibrated
  off two captured ghosts (NEWRESOURCE, EUPHONY ACE). The `runnerUp`
  field on every broadcast carries the alternative basin's residual
  and prior penalty, so a longer capture lets us see how often the
  prior was load-bearing and at what margin. If real fixes ever flip
  to the runner-up under a higher λ, that's the upper bound; if
  ghosts ever land in shipping lanes (the `005030001`-class Falmouth
  failure mode), no λ helps and we need an external oracle. A 4 h ×
  40-slot Global capture on 2026-04-27 produced 39 fixes with
  `withRunnerUp = 0` — i.e. phase-2 refinement never found two minima
  >1500 km apart, so the prior wasn't tested at all that run. The
  runner-up class (NEWRESOURCE/EUPHONY) is rare in any given window;
  λ tuning needs either patience or a deliberate replay of those
  captured snippets.

## Tone & design

Radio-ham tinker spirit served with Data Desk restraint.

- Monospace everything (JetBrains Mono). Pure monochrome, one accent,
  no clutter.
- Educational as much as it is intelligence-generating — hearing the
  actual FSK burst that AIS was supposed to replace is viscerally
  satisfying; lean into that.
- Mobile first: UI collapses to a stacked list on narrow viewports;
  at ≥ 900 px it's a classic five-column log.

## Code shape

### `client/` — static site (ES modules, no build step)

- `app.js` — SlotConn WebSocket class, cross-slot call dedupe,
  rendering, audio picker (follow-the-loudest-burst), CSV export,
  region dropdown, bootstrap.
- `vessels.js` — GFW identity + tracks. Both routes proxy through the
  Worker (GFW checks Origin + Referer). Cached in localStorage with
  a schema version.
- `regions.js` — region dropdown data, MID-to-ISO, GPS parser.
- `map.js` — Leaflet mini-map per card; lazy-mounted on first expand.
- `hyperbola.js` — geo math + marching-squares trace of the per-pair
  TDOA constraint. Pure function `hyperbolaSegments(refGps, otherGps,
  dtSec)` returns `[[lat,lon],[lat,lon]]` segments for `map.js` to
  draw. Lets the human see at a glance whether a fix is the unique
  intersection of all curves or a coincidental near-miss with ghosts.
- `index.html`, `styles.css`, `favicon.svg`.

### `worker/src/` — Cloudflare Worker + Durable Objects

- `index.js` — HTTP routing. `/v2/rack`, `/v2/slot/:host/:port/:band`,
  `/v2/tdoa/subscribe`, `/v2/tdoa/recent`, `/v2/tdoa/inject` (debug),
  `/gfw`, `/gfw/tracks`, `/receivers` (debug).
- `directory-do.js` — `DirectoryDO`. Composes the rack; no fan-out.
- `receiver-do.js` — `ReceiverDO`. The hot path. Upstream + decoder
  + hibernation fanout + idle alarm. Also emits TDOA detection
  records (GPS-anchored audio snippets) to `TDOADO`.
- `tdoa-do.js` — `TDOADO`. Singleton coordinator. Fuzzy-MMSI +
  same-band bucketing across receivers, cross-correlates snippets,
  calls the solver (passes the vessel-density prior + λ), applies the
  residual + bearing-gap + ellipse gates, broadcasts.
- `capturer-do.js` — `CapturerDO`. Singleton "synthetic listener" that
  opens outbound WS to every slot in a chosen rack (so ReceiverDOs
  stay alive without a human watching), subscribes to TDOA, writes
  every broadcast to R2 as JSONL chunks, and computes prior-validation
  metrics from a finished capture. Hard-capped at 6 h × 50 slots.
  Cost-shape: ~1¢/slot/h while running; full Global rack × 4 h ≈ $1.60.
- `tdoa.js` — pure solver math. `solveTdoa` (two-phase grid-search;
  scores top-K refined candidates by `residualKm + λ · prior`,
  surfaces a `runnerUp` basin when one exists >1500 km away, flags
  `atEdge` minima) + `tdoaUncertainty` (Fisher-inverse ellipse,
  load-bearing for the ellipse gate) + `farFieldCheck` (plane-wave
  fit, load-bearing for the far-field gate) + `nearestSubsetIdx`
  (mixed-cohort rescue subset) + legacy `xcorr` (kept as the
  comparison baseline in tests). Exercised offline by the scripts
  under `scripts/`.
- `toa.js` — arrival-time estimation. `estimateDt` (complex-envelope
  cross-correlation with CFO grid search, sub-sample peak, peakRatio
  confidence) + `hilbert` (analytic reconstruction of real snippets)
  + `resample` (cubic, for the 20.25 kHz Kiwis) + `fft`. See the
  "Arrival-time estimation" section for why this replaced raw xcorr.
- `coast-registry.js` — verified positions for ~25 MF/HF DSC coast
  stations (multi-site networks carry every transmitter site).
  `coastRegistryCheck(mmsi, lat, lon)` → distance to nearest site;
  load-bearing for the registry gate. Only confidently-sourced
  positions belong here — a wrong entry silently rejects real fixes.
- `density.js` — vessel-density prior. Loads the bundled raster once
  and returns `densityPenaltyDex(lat, lon)` in log10(vessel-hours)
  below the global busiest cell. Used by `tdoa-do.js` as the dual-
  basin tiebreaker.
- `data/vessel_density.js` — auto-generated 1° equal-angle raster of
  GFW `public-global-presence` annual vessel-hours, base64-embedded so
  the same import works in the Worker bundle and Node-side tests.
  Generated by `scripts/fetch_density_raster.py`; do not edit by hand.
- `kiwi-upstream.js` — server-side KiwiSDR WebSocket client. Runs in
  IQ mode so every frame carries a GPS-ns header — the shared time
  base the TDOA coordinator needs.
- `dsc.js` — ITU-R M.493 decoder (port of
  `~/Research/dsc-triangulation/scripts/dsc_decode_ddesk.py`).
- `regions.js` — BANDS + regional bboxes + coastal anchors +
  `pickRack` (bbox) + `pickTargetRack` (target) +
  `pickGroundWaveCohort` (target.bands-restricted) +
  `pickSurroundCohort` (long-baseline target).
- `location-hint.js` — GPS → CF region string.

### `scripts/` — offline validation + live testing

- `capture_iq.mjs` — ground-truth capture harness. Connects directly
  to the Kiwis of a region's rack (any band set), decodes DSC
  continuously, and writes one JSONL record per decode with the
  COMPLEX snippet + every raw GPS anchor, so offline analysis can
  re-derive arrival times under any convention/estimator. In-place
  rings, reconnect-guarded (a failed socket fires both error and
  close — unguarded that doubles pending reconnects each cycle
  until OOM).
- `ais_watch.mjs` — polls LSEG every 15 min for a fresh AIS position
  of every vessel MMSI seen in a running capture (GFW only for
  MMSI → IMO identity). The snapshots make fix-time truth
  interpolable — a single post-hoc lookup can't distinguish TDOA
  error from AIS staleness; 47 of ~90 tracked vessels turned out
  stationary (<2 km drift), i.e. delay-proof anchors.
- `analyse_capture.mjs` — streaming pair-level analysis of a capture:
  buckets like the TDOADO, measures every pair with BOTH estimators,
  scores against coast-registry geometry binned ground-wave vs
  skywave, reports per-pair repeatability across repeat bursts.
- `replay_capture.mjs` — replays a capture through the PRODUCTION
  coordinator (real `TDOADO._solveBucket`, real gates) and prints
  every broadcast + rejection.
- `score_replay.mjs` — joins replay output with `ais_watch` snapshots:
  interpolated-AIS error per broadcast, ghost-vs-real classification
  per rejected attempt, mobility-flagged so stale AIS can't
  masquerade as TDOA error.
- `test_estimators.mjs` — Monte Carlo comparing arrival-time
  estimators on synthetic CPFSK bursts across SNR × CFO (source of
  the toa.js numbers above).
- `test_tdoa.mjs` — synthetic geometry against `tdoa.js` solver,
  p50 ≈ 1.6 km on 100 trials.
- `test_tdoa_e2e.mjs` — synthetic multi-receiver cohorts through
  `TDOADO._solveBucket` with realistic sample-rate + snippet-start
  jitter, ground-wave (geodesic) propagation, p50 ≈ 1.1 km.
- `fetch_density_raster.py` — one-shot fetch of GFW vessel-presence
  tiles, resamples to 1° equal-angle, log-quantises to u8, emits
  `worker/src/data/vessel_density.js`. Re-run yearly when GFW
  publishes a fresher annual roll-up. Needs `GFW_API_KEY` in env.
- `tdoa_watch.mjs` — the live ground-truth harness. Subscribes to
  `/v2/tdoa/subscribe` and the `/v2/tdoa/recent` poll, attaches to
  every slot in a region's rack with auto-reconnect, and for each
  solved MMSI cross-checks against fresh AIS via LSEG (MMSI → GFW
  search → IMO → LSEG SymbologySearch → RIC → LSEG TR.AssetLocation*).
  GFW lookup filters strictly on `ssvid == query MMSI` because GFW's
  fuzzy search returns entries for *different* vessels too.
- `analyse_solves.mjs` — offline post-processor for `tdoa_watch.mjs`
  JSONL. Per-MMSI: GFW lookup (for vessels) + speed-plausibility
  check, or fixed-position lookup (for coast stations). Cohort
  fetched live from `/v2/rack` so the analyser stays in sync with
  the picker. Use this whenever you want to turn a capture into a
  table of "did we get the right ship in the right place".
- `validate_fixes.mjs` — ground-truth validator for any fix JSONL
  (capture chunks, the `/v2/tdoa/recent` ring, or `tdoa_watch` rows).
  Coast stations score against `coast-registry.js` (definitive,
  per-fix); vessels against fresh AIS via LSEG when the proxy is up.
  When LSEG is down, use the Kpler skill instead: GFW gives
  MMSI → name, `kpler search <name> --categories VESSEL` →
  `kpler positions <id>` gives AIS hours old (verified live: caught
  SIKINOS anchored in Greece while her ghost fixed in the North Sea,
  and FRONT LEOPARD / AURORA SPIRIT at the Milford Haven anchorage).
  Prints per-fix error percentiles, % within 100 km, and what the
  registry gate would have rejected.
- `test_farfield.mjs` — far-field discriminator calibration: synthetic
  near/far sources through a Channel-like cohort, plus replay of any
  capture JSONL (re-runs `farFieldCheck` on the as-measured timings).
  The source of the 2.5 ratio threshold and the distance sweep table
  in the far-field gate rationale.
- `global_chokepoints.mjs` — feasibility sweep. Walks a labelled list
  of maritime chokepoints + a 2.5° lat × lon grid, computes for each
  candidate centroid: `n receivers within 400 km after site-dedup`,
  `max bearing gap`, `mean distance`. Score = n × (180 / max_gap).
  Tells you where in the world the methodology can run.
- `inject_tdoa.mjs`, `inject_tdoa_real.mjs` — push synthetic cohorts
  at the deployed `/v2/tdoa/inject` debug route, useful for sanity-
  checking the live path before burning hours waiting for traffic.
- `attach_nwe.mjs`, `inject_tdoa_black_sea.mjs`, `tdoa_summary.mjs` —
  legacy harnesses from earlier methodology iterations; kept for
  reproducibility of historical captures.

## Do

- Plain ES modules, Web Audio, Fetch, WebSocket. No framework, no
  build step. Leaflet from CDN is the only runtime dep.
- Each module keeps a single responsibility and a small surface.
- Ship small. Client is under 100 KB gzipped.
- Mobile- and desktop-friendly from a single stylesheet.

## Don't

- Any framework or bundler. The repo's only `package.json` exists
  to declare `"type": "module"` so Node treats `.js` files as ESM
  when scripts under `scripts/` import from `worker/src/`. `npm`
  proper is banned; only `npx wrangler` runs in `worker/`.
- "Listen forever" loops. The etiquette gate (≥ 2 free slots to join)
  still applies server-side; `ReceiverDO` self-destructs 5 min after
  the last viewer leaves so a quiet region stops squatting slots.
- Storing secrets. The GFW proxy works with an empty bearer because
  of Origin/Referer allow-listing on globalfishingwatch.org; no API
  key anywhere.
- Adding TDOA gates without a live-data case showing the new gate
  rejects ghosts *more* than it rejects real fixes. The history is
  littered with gates that looked principled but in practice fired
  on real fixes while letting through obvious ghosts. Current stack
  (residual + bearing-gap + ellipse + same-band-per-bucket) earned
  its keep against a 20-fix `/v2/tdoa/recent` snapshot showing clean
  separation between real fixes (semi-major <600 km) and ghosts
  (semi-major >1500 km). Same standard for any future addition.

## Gotchas

- **DSC channel ≠ KiwiSDR dial frequency.** DSC lives at 2187.5 kHz
  MF; the audio decoder wants tones at 1615 / 1785 Hz. In USB the
  dial sits 1.7 kHz below the channel (2185.8 kHz for MF). Passband
  300–3000 Hz. `scripts/kiwi_capture.py` in the research repo
  explains the chain.
- **KiwiSDR sample rate is not an integer multiple of 100 baud.** Bit
  boundaries must be tracked as floats, not rounded. See `fskDemod`
  in `dsc.js`.
- **Browser audio autoplay.** `AudioContext.resume()` is blocked
  until the user activates the page. Decoding and UI work without a
  gesture — only speakers wait for the first tap/click/key.
- **GFW's public endpoints need Origin + Referer from
  globalfishingwatch.org.** Browsers won't forge those, so every GFW
  call goes through the Worker, which adds them server-side. No API
  key needed; `Authorization: Bearer` (literally empty) is what the
  logged-out map UI sends too.
- **GFW `/tracks` only accepts `binary=true` without a key.** We ask
  for `format=GEOJSON&binary=true` so the Worker can decode without a
  protobuf dep.
- **GFW lastPos can be days stale.** GFW caches non-fishing vessel
  tracks; large container ships often show 3-5 day old positions. The
  watch script's plausibility check converts (Δkm to TDOA fix) ÷
  (Δhours since AIS) to an implied speed; flagged as implausible only
  when > 60 kn. For exact ground truth use LSEG (`tdoa_watch.mjs`)
  or a fixed-position coast station.
- **Cloudflare Workers refuse `fetch()` to bare IP addresses** (error
  code 1003 wrapped in a 403). The LSEG proxy lives at a raw GCE IP;
  the worker reaches it via nip.io wildcard DNS
  (`34.13.53.112.nip.io`), set as `LSEG_PROXY_URL` in wrangler.toml.
- **KiwiSDR GPS stamps are per-frame and sample-accurate.** Every SND
  frame carries a gpssec/gpsnsec extrapolated by the server from the
  last PVT against the GPS-disciplined ADC clock — measured
  self-consistency ~0.1 µs against a linear clock fit. The "fresh
  solution only ~1/sec" model in older comments understated this;
  anchoring on any frame and extrapolating by the kiwi-reported
  sample rate is sub-µs.
- **DSC's DX/RX interleave repeats every symbol 400 ms later**, so
  cross-correlation has a strong ghost peak at ±400 ms. Keep pair
  search windows well under that (production clamps at ±0.35 s).
- **Outbound WebSockets from a DO prevent the DO from hibernating.**
  This is fine here — the DO is only alive while a viewer is
  attached; 5 minutes after the last WebSocketClose, the idle alarm
  fires and tears the DO down.
- **`*.proxy.kiwisdr.com` hosts 307-redirect the WS handshake, and
  neither browsers nor CF Worker WebSocket clients follow those.** The
  Worker sidesteps this by pre-resolving the redirect chain with a
  plain `fetch({ redirect: "follow" })` before the upgrade — the final
  stable endpoint is some `*.proxy2.kiwisdr.com:8073` the WS can reach
  directly. The resolved endpoint is cached per-host. Browsers still
  never see the redirect because they only ever talk to the Worker,
  not the KiwiSDR. Without this, ~35% of the public fleet (including
  the only SE-of-Black-Sea receiver) is unreachable.
- **CF DO costs scale with listener-hours, not listeners.** N slots
  in a region = N DOs active while anyone is watching, each handling
  ~100 audio frames/sec (each = 1 billable WS message). Nobody
  watching = zero cost. Ten people watching the same region = same
  cost as one person. Ground-wave target cohorts run 25-35 slots; a
  rough order-of-magnitude is 1¢/hour-of-viewing per cohort member.
- **TDOA cohorts need `host:port` dedup, not `slotId` dedup.** A
  single physical KiwiSDR hearing the same burst on two bands gives
  identical geometry — counting both toward quorum wastes the solve
  on degenerate math. `tdoa-do.js` collapses on `host:port`. The
  picker also site-dedups at 5 km so two boxes at the same operator
  don't burn two cohort slots.
- **Cross-band buckets are rejected at ingest.** A burst heard by
  receiver A on HF8 and receiver B on HF12 is two different physical
  transmissions; xcorr between their snippets returns a noise lag
  that the solver then triangulates into a ghost. `_findMatchingBucket`
  requires same-band, so a single MMSI heard on multiple bands within
  the 2 s window forms parallel buckets, each tracking its band
  independently. Real cross-band convergence (vessel re-keys all DSC
  channels back-to-back) is rare and not worth the ghost risk.
- **MMSIs decoded under noise differ between receivers.** One Kiwi
  reads `563250300`, another `5632??300`, a third `563252??0` — all
  the same ship. The coordinator fuzzy-matches with `?` as a
  wildcard and carries the cleanest variant forward.
- **Self-reported KiwiSDR SNR is a noise-floor estimate, not a
  decode-rate predictor.** Close-in low-SNR receivers (Brighton at
  96 km, Chichester at 105 km) decode MF DSC reliably; distant
  high-SNR receivers can sit silent due to upstream/antenna issues
  invisible at pick time. Ground-wave cohort selection ignores the
  SNR floor for this reason.

## Research pointers

Everything below is in `~/Research/dsc-triangulation`:

- **KiwiSDR protocol** — `vendor/kiwiclient/kiwirecorder.py`. The
  Worker port (`kiwi-upstream.js`) is ~140 LoC.
- **DSC decoder (canonical)** — `scripts/dsc_decode_taosw/` wraps the
  .NET TAOSW library.
- **DSC decoder (Python reference)** — `scripts/dsc_decode_ddesk.py`.
  Non-coherent I/Q demod + phasing search.
- **Test vectors** —
  `vendor/TAOSW.DSC_Decoder.Core/.../SymbolsDecoderTests.cs` has
  hand-decoded real symbol sequences with expected outputs.
- **Real SDR capture** — `vendor/TAOSW.DSC_Decoder/testFiles/*.wav`
  contains an 88.2 kHz stereo WAV with 5 real DSC calls from Greek
  coast station Olympia Radio. The decoder must produce those 5
  calls byte-for-byte.
- **Public KiwiSDR list** — `http://rx.linkfanel.net/kiwisdr_com.js`.
  Returns a JS assignment (not JSON).
- **HF Underground TDoA discussion** — topic 117872. Practitioner
  consensus on what works and what doesn't for KiwiSDR-based
  triangulation. Skywave timing has too many free parameters for the
  free-public-receiver case; ground-wave is what actually works.

## Captures (offline prior validation)

Headless 4 h capture against the live rack (no humans needed on the
page) for prior-validation analysis:

```sh
GW=https://skywave-gateway.louis-6bf.workers.dev

# Kick off; CapturerDO opens WS to every slot + subscribes to TDOA.
curl -X POST "$GW/v2/capture/start?region=global&fanout=40&durationH=4"

# Live progress (slot connection count, fixes so far).
curl "$GW/v2/capture/status"

# Hard kill if needed (the alarm() also auto-stops at +durationH anyway).
curl -X POST "$GW/v2/capture/stop"

# After it's done, list captures and pull the report.
curl "$GW/v2/capture/list"
curl "$GW/v2/capture/report/<captureId>" | jq .summary
```

Cost: ~1¢/slot/h while running; full Global rack × 4 h ≈ $1.60.
Hard caps in `capturer-do.js` (`MAX_DURATION_MS = 6 h`, `MAX_SLOTS = 50`)
prevent runaway sessions even if a caller asks for more. R2 bucket
`skywave-captures` must exist before first deploy:

```sh
npx wrangler r2 bucket create skywave-captures
```

## Deploy

Static client served at `https://research.datadesk.eco/skywave/` via
GitHub Pages (`.github/workflows/deploy.yml` triggers on push to main).
Worker deployed to `https://skywave-gateway.louis-6bf.workers.dev`:

    cd worker && npx wrangler deploy

The `skywave-gateway` `<meta>` tag in `client/index.html` points the
client at the Worker URL. Bump the `?v=` cache-bust in `index.html`,
`app.js`, `map.js` whenever client modules change so browsers pick up
the new code.
