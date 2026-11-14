// Known-position registry for fixed DSC transmitters (coast stations).
//
// This is the external oracle for the persistent-ghost failure mode the
// geometric gates can't catch: a stable cohort hearing a far coast
// station via multi-hop skywave consistently produces the same wrong
// basin, with small ellipse, passable bearing gap and 100% convergence
// across repeats. There's no purely-internal signal — but a coast
// station's true position is public and fixed, so a TDOA fix hundreds
// of km from its registered site is provably wrong.
//
// Live cases that drove this in (2026-06-09 English Channel capture):
//   002191000 Lyngby Radio (DK, MF from Blåvand/Bovbjerg/Skagen) fixed
//     at (50.2, 1.5) in the English Channel — 750 km from the nearest
//     transmitter. Night MF skywave heard by a Channel cohort that
//     classified as ground-wave and solved geodesically.
//   002470123 Civitavecchia Radio (IT) decoded cleanly by five UK/BE
//     MF receivers ~1500 km away at 21:00 UTC — any "ground-wave"
//     solve of that cohort lands a ghost in NW Europe.
//   005030001-class (CLAUDE.md known limit): UK coast station fixing
//     in the Coral Sea across multiple bursts, 100% convergent.
//
// MMSIs here are networks as much as stations: one MMSI can key
// several geographically-spread transmitter sites (Lyngby: 3 sites
// over 250 km; Türk Radyo: 11 sites over 600 km). Each entry lists
// every site we know; the gate measures distance to the NEAREST site
// and rejects only past a generous threshold, so a distributed network
// never causes a false rejection of a genuine fix.
//
// Only entries with confidently-known positions belong here — a wrong
// registry position silently rejects real fixes, which is worse than
// letting a ghost through. Sources: ITU coast-station list (names),
// station/operator publications (sites). Verify before adding.

// Reject a registered coast station's fix only when it lands further
// than this from every known site for that MMSI. Generous on purpose:
// covers per-site position fuzz, multi-site networks with sites we
// don't know about, and honest TDOA error on a real fix (worst real
// coast-station fixes observed live are <300 km off). Cross-continent
// ghosts (the only thing we're hunting) are 700+ km off.
export const REGISTRY_MAX_KM = 500;

// mmsi → { name, sites: [[lat, lon], ...] }
export const COAST_REGISTRY = {
  // United Kingdom — MCA coastguard MF DSC remote sites
  "002320001": { name: "Shetland CG",        sites: [[60.15, -1.15]] },
  "002320004": { name: "Aberdeen CG",        sites: [[57.10, -2.05]] },
  "002320006": { name: "Humber CG",          sites: [[53.319, 0.155]] },
  "002320011": { name: "Solent CG / Niton",  sites: [[50.586, -1.296]] },
  "002320012": { name: "Holyhead CG",        sites: [[53.318, -4.629]] },
  "002320013": { name: "Milford Haven CG",   sites: [[51.69, -5.16]] },
  "002320014": { name: "Falmouth CG",        sites: [[50.150, -5.066]] },
  "002320018": { name: "Belfast CG",         sites: [[54.717, -5.704]] },

  // France — CROSS MF DSC
  "002275000": { name: "CROSS La Garde",     sites: [[43.10, 5.93]] },
  "002275100": { name: "CROSS Gris-Nez",     sites: [[50.87, 1.59]] },
  "002275200": { name: "CROSS Jobourg",      sites: [[49.68, -1.93]] },
  "002275300": { name: "CROSS Corsen",       sites: [[48.43, -4.78]] },
  "002275400": { name: "CROSS Étel",         sites: [[47.66, -3.21]] },

  // Netherlands / Belgium / Germany
  "002442000": { name: "Den Helder MRCC",    sites: [[52.96, 4.76]] },
  "002050480": { name: "Oostende Radio",     sites: [[51.18, 2.85]] },
  "002111240": { name: "Bremen Rescue",      sites: [[53.05, 8.80]] },

  // Denmark — Lyngby Radio keys MF DSC from three west-coast sites
  "002191000": { name: "Lyngby Radio",       sites: [[57.74, 10.57], [56.52, 8.12], [55.56, 8.08]] },

  // Ireland
  "002500100": { name: "Valentia CG",        sites: [[51.93, -10.35]] },
  "002500200": { name: "Malin Head CG",      sites: [[55.37, -7.34]] },

  // Spain
  "002241022": { name: "Coruña Radio",       sites: [[43.37, -8.42]] },

  // Italy — Guardia Costiera MF DSC network (one MMSI per station;
  // both below were heard in the English Channel via night skywave
  // on 2026-06-09 and solved as mid-Channel ghosts pre-gate)
  "002470123": { name: "Civitavecchia Radio", sites: [[42.03, 11.84]] },
  "002470135": { name: "Trieste Radio",       sites: [[45.65, 13.77]] },

  // Turkey — Türk Radyo network, 11 sites under one MMSI; the MF DSC
  // sites cluster around the Marmara and western Black Sea coasts.
  "002711000": { name: "Türk Radyo (Istanbul net)", sites: [[41.02, 28.98], [41.09, 31.13], [39.31, 26.69]] },

  // China — MSA coast stations
  "004122100": { name: "Shanghai Radio (XSG)",  sites: [[31.06, 121.55]] },
  "004123100": { name: "Guangzhou Radio (XSQ)", sites: [[23.15, 113.50]] },
};

function gcKm(la1, lo1, la2, lo2) {
  const R = 6371;
  const A = la1 * Math.PI / 180, B = la2 * Math.PI / 180;
  const h = Math.sin((B - A) / 2) ** 2
          + Math.cos(A) * Math.cos(B) * Math.sin((lo2 - lo1) * Math.PI / 360) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Returns null when the MMSI isn't a registered coast station (or has
// wildcard digits), otherwise { name, nearestKm } for the given fix.
export function coastRegistryCheck(mmsi, lat, lon) {
  const entry = COAST_REGISTRY[String(mmsi)];
  if (!entry) return null;
  let nearestKm = Infinity;
  for (const [sla, slo] of entry.sites) {
    const d = gcKm(lat, lon, sla, slo);
    if (d < nearestKm) nearestKm = d;
  }
  return { name: entry.name, nearestKm };
}
