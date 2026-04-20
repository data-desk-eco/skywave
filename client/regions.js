// Static data: DSC channels, scan regions, coastal proximity anchors,
// Maritime Identification Digit (MID) → ISO country lookup, and a few
// tiny helpers used across modules.

// ITU-R M.493 DSC channels.
export const BANDS = [
  { khz:  2187.5, short: "MF"   },
  { khz:  4207.5, short: "HF4"  },
  { khz:  6312.0, short: "HF6"  },
  { khz:  8414.5, short: "HF8"  },
  { khz: 12577.0, short: "HF12" },
  { khz: 16804.5, short: "HF16" },
];
export const bandLabelFor = (khz) =>
  (BANDS.find((b) => b.khz === khz) || {}).short || "?";

// Regional scan presets. Each entry constrains the receiver candidate
// pool to a bbox ([south, west, north, east]); the slot count is
// whatever eligible receivers are available in that bbox, capped at
// `maxFanout()`. Smaller areas end up with fewer slots than Global.
//
// When audio is tunnelling through the Cloudflare Worker gateway
// (always the case on HTTPS origins, since ws:// is blocked) we scan
// far fewer receivers — each live session keeps the Worker busy
// relaying PCM frames, and 96 of those in parallel can exhaust the
// free-tier CPU budget (audio hangs pending, user sees 0 / N). On
// http:// origins we bypass the Worker and can safely scale up.
export function maxFanout() {
  const hasGateway = !!document.querySelector('meta[name="skywave-gateway"]');
  const https = location.protocol === "https:";
  return https && hasGateway ? 24 : 96;
}
export const REGION_STORAGE_KEY = "skywave.region";
export const REGIONS = [
  { id: "global",    name: "Global",         bbox: null                  },
  { id: "nw-europe", name: "NW Europe",      bbox: [42, -12,  62,  15]   },
  { id: "med",       name: "Mediterranean",  bbox: [30,  -7,  46,  36]   },
  { id: "us-east",   name: "US East Coast",  bbox: [24, -82,  46, -62]   },
  { id: "us-west",   name: "US West Coast",  bbox: [30, -130, 50, -115]  },
  { id: "gulf-carib",name: "Gulf/Caribbean", bbox: [ 8, -100, 31,  -58]  },
  { id: "baltic",    name: "Baltic / N Sea", bbox: [50,  -2,  66,  32]   },
  { id: "east-asia", name: "East Asia",      bbox: [18, 115,  45, 150]   },
  { id: "oceania",   name: "Australia / NZ", bbox: [-48, 110, -8, 180]   },
];

export function currentRegion() {
  const saved = localStorage.getItem(REGION_STORAGE_KEY);
  return REGIONS.find((r) => r.id === saved) || REGIONS[0];
}

export function inRegion(gps, bbox) {
  if (!bbox) return true;
  const [s, w, n, e] = bbox;
  const [lat, lon] = gps;
  if (lat < s || lat > n) return false;
  // Tolerate bboxes that cross the antimeridian.
  return w <= e ? (lon >= w && lon <= e) : (lon >= w || lon <= e);
}

// Coastal anchors: (lat, lon) of major ports, coast-guard stations, and
// busy chokepoints. A receiver's "coastal score" is inverse-distance to
// the closest anchor — inland KiwiSDRs get deprioritised, sea-adjacent
// ones float to the top.
const COASTAL_ANCHORS = [
  // NE Atlantic / North Sea / Baltic
  [51.1,   1.3], [48.4,  -5.1], [50.4,  -4.1], [53.5,   9.9], [51.9,   4.5],
  [60.4,   5.3], [64.1, -21.9], [57.7,  11.9], [59.3,  18.1], [60.2,  24.9],
  [59.4,  24.8], [54.4,  18.7], [55.7,  12.6], [57.0,  -2.1], [62.0,  -7.0],
  // Mediterranean / Black Sea
  [36.1,  -5.3], [43.3,   5.4], [44.4,   8.9], [37.9,  23.7], [41.0,  29.0],
  [35.9,  14.5], [31.2,  29.9], [32.8,  35.0], [44.5,  33.5],
  // Iberia / W Africa / S Atlantic
  [38.7,  -9.1], [37.7, -25.7], [33.6,  -7.6], [14.7, -17.4], [ 6.5,   3.4],
  [-33.9,  18.4], [-29.9,  31.0], [-22.9, -43.2], [-34.6, -58.4], [-33.0, -71.6],
  // NW Atlantic / Caribbean
  [44.6, -63.6], [42.4, -71.1], [40.7, -74.0], [36.9, -76.3], [25.8, -80.2],
  [29.9, -90.1], [29.7, -95.4], [25.1, -77.3], [18.5, -66.1], [ 9.4, -79.9],
  // Pacific N America
  [47.6, -122.3], [37.8, -122.4], [33.7, -118.2], [49.3, -123.1],
  [21.3, -157.9], [61.2, -149.9],
  // Red Sea / Gulf / Indian Ocean
  [21.5,  39.2], [12.8,  45.0], [11.6,  43.1], [23.6,  58.6], [27.2,  56.3],
  [29.4,  48.0], [19.1,  72.9], [ 6.9,  79.9], [13.1,  80.3],
  // SE / E Asia
  [ 1.3, 103.8], [-6.2, 106.8], [14.6, 121.0], [22.3, 114.2], [31.2, 121.5],
  [35.2, 129.1], [35.7, 139.8], [43.1, 131.9], [13.7, 100.5],
  // Oceania
  [-33.9, 151.2], [-27.5, 153.0], [-31.9, 115.9], [-36.9, 174.8],
  [-41.3, 174.8], [-18.1, 178.4], [-9.5, 147.2],
];

export function coastDeg(gps) {
  if (!gps) return 999;
  let min = Infinity;
  for (const [la, lo] of COASTAL_ANCHORS) {
    const dlat = gps[0] - la;
    const dlon = ((gps[1] - lo + 540) % 360) - 180;
    const d = Math.hypot(dlat, dlon);
    if (d < min) min = d;
  }
  return min;
}

export function parseGps(s) {
  if (!s) return null;
  const m = s.match(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

export function coversBand(rx, khz) {
  if (!rx.bands) return true;
  const hz = khz * 1000;
  for (const range of rx.bands.split(",")) {
    const [lo, hi] = range.split("-").map(Number);
    if (hz >= lo && hz <= hi) return true;
  }
  return false;
}

// Maritime Identification Digit → ISO 3166-1 alpha-2 country. Source:
// ITU-R M.585 (2023). Missing entries fall through to no flag — the
// MMSI still renders.
export const MID_TO_ISO = {
  201:"AL",202:"AD",203:"AT",204:"PT",205:"BE",206:"BY",207:"BG",208:"VA",209:"CY",210:"CY",
  211:"DE",212:"CY",213:"GE",214:"MD",215:"MT",216:"AM",218:"DE",219:"DK",220:"DK",224:"ES",
  225:"ES",226:"FR",227:"FR",228:"FR",229:"MT",230:"FI",231:"FO",232:"GB",233:"GB",234:"GB",
  235:"GB",236:"GI",237:"GR",238:"HR",239:"GR",240:"GR",241:"GR",242:"MA",243:"HU",244:"NL",
  245:"NL",246:"NL",247:"IT",248:"MT",249:"MT",250:"IE",251:"IS",252:"LI",253:"LU",254:"MC",
  255:"PT",256:"MT",257:"NO",258:"NO",259:"NO",261:"PL",262:"ME",263:"PT",264:"RO",265:"SE",
  266:"SE",267:"SK",268:"SM",269:"CH",270:"CZ",271:"TR",272:"UA",273:"RU",274:"MK",275:"LV",
  276:"EE",277:"LT",278:"SI",279:"RS",301:"AI",303:"US",304:"AG",305:"AG",306:"CW",307:"AW",
  308:"BS",309:"BS",310:"BM",311:"BS",312:"BZ",314:"BB",316:"CA",319:"KY",321:"CR",323:"CU",
  325:"DM",327:"DO",329:"GP",330:"GD",331:"GL",332:"GT",334:"HN",336:"HT",338:"US",339:"JM",
  341:"KN",343:"LC",345:"MX",347:"MQ",348:"MS",350:"NI",351:"PA",352:"PA",353:"PA",354:"PA",
  355:"PA",356:"PA",357:"PA",358:"PR",359:"SV",361:"PM",362:"TT",364:"TC",366:"US",367:"US",
  368:"US",369:"US",370:"PA",371:"PA",372:"PA",373:"PA",374:"PA",375:"VC",376:"VC",377:"VC",
  378:"VG",379:"VI",401:"AF",403:"SA",405:"BD",408:"BH",410:"BT",412:"CN",413:"CN",414:"CN",
  416:"TW",417:"LK",419:"IN",422:"IR",423:"AZ",425:"IQ",428:"IL",431:"JP",432:"JP",434:"TM",
  436:"KZ",437:"UZ",438:"JO",440:"KR",441:"KR",443:"PS",445:"KP",447:"KW",450:"LB",451:"KG",
  453:"MO",455:"MV",457:"MN",459:"NP",461:"OM",463:"PK",466:"QA",470:"AE",471:"AE",472:"TJ",
  473:"YE",475:"YE",477:"HK",478:"BA",501:"AQ",503:"AU",506:"MM",508:"BN",510:"FM",511:"PW",
  512:"NZ",514:"KH",515:"KH",516:"CX",518:"CK",520:"FJ",523:"CC",525:"ID",529:"KI",531:"LA",
  533:"MY",536:"MP",538:"MH",540:"NC",542:"NU",544:"NR",546:"PF",548:"PH",550:"TL",553:"PG",
  555:"PN",557:"SB",559:"AS",561:"WS",563:"SG",564:"SG",565:"SG",566:"SG",567:"TH",570:"TO",
  572:"TV",574:"VN",576:"VU",577:"VU",578:"WF",601:"ZA",603:"AO",605:"DZ",607:"TF",608:"GB",
  609:"BI",610:"BJ",611:"BW",612:"CF",613:"CM",615:"CG",616:"KM",617:"CV",618:"TF",619:"CI",
  620:"KM",621:"DJ",622:"EG",624:"ET",625:"ER",626:"GA",627:"GH",629:"GM",630:"GW",631:"GQ",
  632:"GN",633:"BF",634:"KE",635:"TF",636:"LR",637:"LR",638:"SS",642:"LY",644:"LS",645:"MU",
  647:"MG",649:"ML",650:"MZ",654:"MR",655:"MW",656:"NE",657:"NG",659:"NA",660:"RE",661:"RW",
  662:"SD",663:"SN",664:"SC",665:"SH",666:"SO",667:"SL",668:"ST",669:"SZ",670:"TD",671:"TG",
  672:"TN",674:"TZ",675:"UG",676:"CD",677:"TZ",678:"ZM",679:"ZW",701:"AR",710:"BR",720:"BO",
  725:"CL",730:"CO",735:"EC",740:"FK",745:"GF",750:"GY",755:"PY",760:"PE",765:"SR",770:"UY",
  775:"VE",
};

export function midIso(mmsi) {
  const mid = parseInt((mmsi || "").slice(0, 3), 10);
  return (mid && MID_TO_ISO[mid]) || "";
}

// Coast stations use MMSIs starting "00" followed by a 3-digit MID
// then 4 zeros (mostly). They never broadcast AIS.
export const isCoastStation = (mmsi) => /^00\d{7}$/.test(mmsi || "");
