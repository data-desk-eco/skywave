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

## Ranking

Most likely to work now: AIS spoofing checks, the GPS interference
map, who calls whom. Most interesting technically: wideband emitters,
lightning. Closest to Data Desk's subject: the platform beacon census.
