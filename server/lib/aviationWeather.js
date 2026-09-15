import { HttpError } from "./geo.js";

const AWC_BASE = "https://aviationweather.gov/api/data";

// Flight category severity, worst to best - used to pick the worst category
// within a day when a TAF has multiple periods that day.
const SEVERITY = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };

async function getJson(url, userAgent) {
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new HttpError(502, `aviationweather.gov request failed (${res.status}): ${url}`);
  }
  const text = await res.text();
  if (!text) return null; // AWC returns 204/empty body when there's nothing to report
  return JSON.parse(text);
}

export async function fetchLatestMetar(icao, userAgent) {
  const url = `${AWC_BASE}/metar?ids=${encodeURIComponent(icao)}&format=json&hours=2`;
  const data = await getJson(url, userAgent);
  const metar = Array.isArray(data) ? data[0] : data;
  if (!metar) return null;

  // Ceiling = base of the lowest broken/overcast layer, in feet AGL.
  const ceilingLayer = (metar.clouds ?? [])
    .filter((c) => c.cover === "BKN" || c.cover === "OVC")
    .sort((a, b) => (a.base ?? Infinity) - (b.base ?? Infinity))[0];

  return {
    raw: metar.rawOb ?? null,
    observedAt: metar.obsTime ? new Date(metar.obsTime * 1000).toISOString() : null,
    flightCategory: metar.fltcat ?? null,
    windDirDeg: metar.wdir ?? null,
    windSpeedKt: metar.wspd ?? null,
    windGustKt: metar.wgst ?? null,
    visibilitySm: metar.visib != null ? Number(String(metar.visib).replace("+", "")) : null,
    ceilingFt: ceilingLayer?.base ?? null,
    altimeterInHg: metar.altim ?? null,
    tempC: metar.temp ?? null,
  };
}

export async function fetchTaf(icao, userAgent) {
  const url = `${AWC_BASE}/taf?ids=${encodeURIComponent(icao)}&format=json`;
  const data = await getJson(url, userAgent);
  const taf = Array.isArray(data) ? data[0] : data;
  if (!taf || !Array.isArray(taf.fcsts)) return null;

  return {
    raw: taf.rawTAF ?? null,
    issuedAt: taf.issueTime ?? null,
    periods: taf.fcsts.map((f) => ({
      fromIso: f.timeFrom ? new Date(f.timeFrom * 1000).toISOString() : null,
      toIso: f.timeTo ? new Date(f.timeTo * 1000).toISOString() : null,
      flightCategory: f.fltcat ?? null,
      windSpeedKt: f.wspd ?? null,
      windGustKt: f.wgst ?? null,
      visibilitySm: f.visib ?? null,
    })),
  };
}

// For a given local calendar day, find the worst flight category any TAF
// period touching that day forecasts. Returns null if the TAF doesn't reach
// that day (TAFs only run ~24-30 hours out).
export function worstCategoryForDay(taf, dayKey, timeZone) {
  if (!taf) return null;
  let worst = null;
  for (const period of taf.periods) {
    if (!period.fromIso || !period.flightCategory) continue;
    const periodDay = new Date(period.fromIso).toLocaleDateString("en-CA", { timeZone });
    if (periodDay !== dayKey) continue;
    if (worst === null || SEVERITY[period.flightCategory] < SEVERITY[worst]) {
      worst = period.flightCategory;
    }
  }
  return worst;
}
