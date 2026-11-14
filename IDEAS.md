# Other things to do with the receiver rack

Recorded 2026-11-14. The asset is a few hundred public KiwiSDR
receivers, each covering 10 kHz–30 MHz with GPS-stamped samples, that
one script can tune, record and compare. The pattern that worked for
DSC applies to all of these: one receiver identifies a signal, then
every other receiver is searched for that known waveform.

None of these is built. Each entry says what it would give and how
sure it is to work.

## Close to the current work

- **AIS spoofing checks.** Every DSC call carries the ship's MMSI, so
  each call is a position check that does not depend on AIS. A 50 km
  estimate is poor for tracking and decisive for "the AIS says the Gulf
  of Oman, the radio says the Baltic". Night bearings already hold at
  1000+ km. Current accuracy is enough. Near-certain to work; needs a
  rule for when a disagreement is real (ellipse, repeat bursts) and the
  wrong-ship AIS matches filtered out.
- **Who calls whom.** A DSC call names both parties. Logged across all
  six bands it is a graph of ship–ship and ship–shore contact that AIS
  does not hold. The server already stores both parties of every timed burst in
  `/var/lib/skywave`. Certain to work; the question is what it shows.
- **The ionosphere as the product.** Coast stations transmit all day
  from known positions. Timing them across the rack measures reflection
  height and hop delay in near real time. That is also the calibration
  the night estimates lack. Needs transmitter sites surveyed to a
  kilometre; several coast-station MMSIs key more than one site.
- **Receiver clock offsets from the stream.** The same fixed
  transmitters, and AIS-matched ships, give each receiver's offset
  continuously, so the −463 µs class of error is found without a
  capture campaign.

## Same method, better signals

- **Wideband emitters.** Timing precision scales with bandwidth. DSC
  is about 300 Hz wide. Over-the-horizon radars and chirp sounders are
  10–100 times wider, so the same pipeline should place them far more
  tightly. The same applies to broadcast jammers and numbers stations.
  The KiwiSDR stream is 12 kHz wide, which bounds the gain. Technically
  the most interesting; propagation remains the limit at night.
- **Lightning.** Sferics at VLF are impulsive and wideband, and
  arrival-time difference across receivers is how lightning networks
  locate strikes. A strike map from receivers that already exist.
  Needs receivers with usable VLF antennas, which many lack.
- **HFDL.** Aircraft report their positions over HF data link. Decoding
  it across the rack gives oceanic tracks outside ADS-B coverage, and
  each report is a transmitter with a known position, which calibrates
  everything else. Needs an HFDL decoder (PSK, 1800 baud).

## Monitoring at scale, no timing needed

- **GPS interference map.** Every KiwiSDR reports its own GPS fix
  count in the public list. Polling the list shows where GPS is jammed
  or spoofed (Baltic, eastern Mediterranean, Black Sea) hour by hour,
  at almost no cost and with no receiver connection. Near-certain to
  work; a receiver's own antenna faults need separating from jamming.
- **Offshore platform beacons.** Many rigs and helidecks run
  low-frequency non-directional beacons with a Morse ident. A census of
  which idents are on air, kept for months, is a platform-activity
  signal. Fits the oil and gas work. Needs a list of platform idents
  and receivers near the fields.
- **Fishing radio buoys.** Longline and driftnet buoys send short
  idents on 1.6–4 MHz. Counting and roughly placing them is a proxy
  for fishing effort where AIS is off. Uncertain: the signals are weak
  and the idents are not registered anywhere public.
- **Solar flares and outages.** A fade across many receivers at once is
  a flare. A broadcaster or coast station that goes silent shows the
  same way. Cheap once any monitoring loop runs.
- **NAVTEX at source.** 518 kHz decoded across the rack gives the
  bulletins the `navtex` skill reads from a mirror, earlier and with
  the receiving stations known.

## Grid frequency by radio (lead candidate, test unfinished)

Recorded 2026-11-14. Not limited to the DSC work or to Data Desk's
subject. The test applied to every candidate: does anything else
already measure this?

**The idea.** Every mains-powered transmitter leaks its power supply
ripple onto its carrier as faint sidebands at multiples of the local
grid frequency. The offset between carrier and sideband is immune to
ionospheric doppler and to receiver clock error, so a KiwiSDR a
thousand kilometres away can read the grid frequency at the
transmitter to a few mHz. Broadcast carriers, beacons, time stations,
jammers and numbers stations all qualify. What that would give:

- Grid frequency, minute by minute, for grids that publish none
  (Iran, Cuba, North Korea, Nigeria, Pakistan, Russia). Frequency is
  the supply–demand balance: load shedding, large plant trips (the
  size follows from the dip) and collapses to the second.
- Which transmitters share a synchronous grid. Two sites whose
  frequencies wander together are electrically connected. That maps
  grid membership where it is disputed or changing: occupied Ukraine,
  Moldova and Transnistria, Libya, Cyprus, North Korea's islands.
- A transmitter whose hum wanders alone is on a generator: an outage
  at that site.
- Attribution. The hum on a jammer, numbers station or clandestine
  broadcaster names the grid its transmitter is plugged into,
  independent of TDOA.
- Stretch: with GPS-stamped samples, the phase angle between two
  sites on one grid, which follows the power flow between them.

**Novelty.** Seven searches (ENF from AM / broadcast / RF carriers,
hum sidebands in MW DXing, transmitter attribution by grid, remote
frequency of closed grids, North Korea hum) found no instance.
Electric network frequency (ENF) work reads hum from audio, video and
wall sockets; FNET/GridEye needs a sensor plugged in inside the grid.
Absence in searches is not proof; the DX and forensics literature
were not read in depth.

**What was measured (one evening, 60–90 s recordings).**

- A UK receiver gave 49.873, 49.911, 49.965 and 49.950 Hz from the
  100 Hz line on 693, 909, 1089 and 225 kHz. Elexon's GB frequency at
  those times was 49.87–49.88, 49.89–49.91, 49.95 and 49.948. The
  extraction is accurate to a few mHz.
- That does not show the hum came from the transmitters. 225 kHz is
  Poland, on another grid, and it read the GB value at −10 dBc: that
  line was the receiver's own mains. A Dutch receiver saw no line on
  the three British carriers at 15 dB in 60 s.
- Carrier phase is the sensitive channel: programme audio is on the
  amplitude only. NHK Tokyo 594 kHz from a Tokyo receiver showed
  lines at 50, 100, 200 and 300 Hz at −70 to −80 dBc, fundamental
  49.951 Hz at 22:41 UTC and 49.999 Hz at 22:48. Receiver and
  transmitter share a grid, so this is also unresolved.
- North Korean carriers (3250, 6100 kHz) from Daegu and Tokyo showed
  smeared lines near 85 and 170 Hz. Not interpreted.

**The test that decides it.** A transmitter and receiver on different
grids, carrier above 55 dB-Hz, phase channel, 5+ minutes. Japan is the
place: 50 Hz Tokyo stations (594, 693, 954 kHz) from a 60 Hz-side
receiver and 60 Hz Osaka stations (666, 828) from Tokyo, at night
when both propagate. The run was started in daylight and stopped
early; the Kyoto and Hiroshima receivers were too weak on Tokyo. If
the line follows the transmitter's grid the idea works; if it follows
the receiver's, each KiwiSDR is still a sensor for its own grid and
the remote reading is dead.

Scratch scripts and recordings are in `captures/hum-2026-11-14/`
(not committed): `rec.mjs host:port kHz secs out` records a carrier,
`ana.mjs out…` lists narrow lines in its amplitude and phase,
`pick.mjs lat lon n` lists receivers, `hum.mjs` is the first
envelope-only survey.

## Other candidates from the same search

- **Where an over-the-horizon radar is looking.** Map the signal
  level of one radar across the whole rack to outline its footprint.
  TDOA fixes of these radars are common; no footprint map was found.
  Propagation shapes the footprint as much as the beam does.
- **Jamming index.** Which foreign broadcasts each state jams, hour
  by hour, with the jammers located. Hobby logs are anecdotal; USAGM
  monitors privately. Not a new technique, a new record.
- **GPS jamming at the transmitter.** A GPS-locked carrier drifts when
  its site loses GPS. Not found in a search. Ground-wave LW/MW only;
  speculative.
- **Speech recognition across HF voice.** Exists per receiver
  (Wavelingo, RadioTransciptor). Legal limits on disclosing
  intercepted traffic apply.
- **HF doppler for launches and explosions.** Done by HamSCI and the
  Japanese HFD network; GNSS does it better.

## Ranking

Most likely to work now: AIS spoofing checks, the GPS interference
map, who calls whom. Most interesting technically: wideband emitters,
lightning. Closest to Data Desk's subject: the platform beacon census.
