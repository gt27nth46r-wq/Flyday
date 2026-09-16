// Real published runway data, so pilots don't have to type in their airport's
// runways by hand. Source: OurAirports' open data export, which is built from
// the FAA's own NASR/Chart Supplement (formerly A/FD) data for US airports,
// plus equivalent national sources elsewhere. It's a static reference file
// (refreshed on the FAA's ~28-day cycle), so this is cached for a long time -
// there's no need to re-download it on every request.
//
// The best part: this gives TRUE runway headings directly (le_heading_degT /
// he_heading_degT), which matches the true-referenced wind direction Flyday
// already uses - no magnetic-variation guessing needed for any airport found
// here, unlike the "runway number x10" approximation used for manual entry.

const RUNWAYS_CSV_URL = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv";
const CACHE_MS = Number(process.env.RUNWAY_CACHE_HOURS || 24) * 60 * 60 * 1000;

let cache = null; // { indexByIdent: Map<ident, RunwayInfo[]>, fetchedAt }

// Minimal CSV line parser - handles quoted fields, which is all this file
// needs (no embedded commas or escaped quotes in this particular dataset).
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

async function fetchRunwayIndex(userAgent) {
  const res = await fetch(RUNWAYS_CSV_URL, { headers: { "User-Agent": userAgent } });
  if (!res.ok) {
    throw new Error(`runway data fetch failed (${res.status})`);
  }
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const col = Object.fromEntries(header.map((name, i) => [name, i]));

  const indexByIdent = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    if (f[col.closed] === "1") continue;

    const ident = f[col.airport_ident];
    if (!ident) continue;

    const leHeading = Number(f[col.le_heading_degT]);
    const runway = {
      id: `${f[col.le_ident]}/${f[col.he_ident]}`,
      leIdent: f[col.le_ident],
      heIdent: f[col.he_ident],
      headingTrueDeg: Number.isFinite(leHeading) ? leHeading : null,
      lengthFt: Number(f[col.length_ft]) || null,
      widthFt: Number(f[col.width_ft]) || null,
      surface: f[col.surface] || null,
    };

    if (!indexByIdent.has(ident)) indexByIdent.set(ident, []);
    indexByIdent.get(ident).push(runway);
  }

  return indexByIdent;
}

async function ensureRunwayIndex(userAgent) {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.indexByIdent;
  const indexByIdent = await fetchRunwayIndex(userAgent);
  cache = { indexByIdent, fetchedAt: Date.now() };
  return indexByIdent;
}

// Never throws - this is a nice-to-have enhancement, not core to a forecast
// request, so any hiccup here just means an empty runway list (the frontend
// falls back to manual entry) rather than breaking the whole request.
export async function getRunwaysForAirport(icao, userAgent) {
  try {
    const index = await ensureRunwayIndex(userAgent);
    return index.get(icao) ?? [];
  } catch (err) {
    console.warn(`[flyday] runway lookup failed for ${icao}: ${err.message}`);
    return [];
  }
}
