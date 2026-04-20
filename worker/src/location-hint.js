// GPS → Cloudflare `locationHint`. A ReceiverDO for a Tokyo KiwiSDR
// should wake up in apac, not wnam, regardless of where its first
// caller lives. The hint is a strong suggestion; CF honours it when
// a POP in that region is available.
//
// Reference: https://developers.cloudflare.com/durable-objects/reference/data-location/

export function locationHintFor(gps) {
  if (!gps) return undefined;
  const [lat, lon] = gps;
  // Oceania (AU/NZ/Pacific islands)
  if (lat < -10 && lon > 110 && lon < 180) return "oc";
  // APAC (Japan, Korea, China, SE Asia, India)
  if (lon > 60 && lon < 180 && lat > -10) return "apac";
  // Middle East (Arabia / Gulf)
  if (lat > 12 && lat < 42 && lon > 30 && lon < 65) return "me";
  // Africa — split by rough longitude so Cape Town doesn't go to wnam
  if (lat < 35 && lon > -20 && lon < 55) return "afr";
  // Europe: everything roughly -15..45 lon, above 35 lat
  if (lat > 35 && lon > -15 && lon < 45) {
    return lon < 20 ? "weur" : "eeur";
  }
  // Americas
  if (lon < -30) {
    if (lat < 12) return "sam";
    // Rough N-America east/west divide at -100° longitude
    return lon < -100 ? "wnam" : "enam";
  }
  return undefined;
}
