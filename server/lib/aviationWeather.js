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
    dewpointC: metar.dewp ?? null,
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

// The flight category forecast for one specific instant, from whichever TAF
// period actually covers it. Returns null when the TAF doesn't reach that
// far (most of a 7-day outlook, since TAFs only run ~24-30 hours) - never
// estimated from anything else, same "reported, not guessed" rule as ceiling.
export function flightCategoryAtTime(taf, timeIso) {
  if (!taf) return null;
  const t = new Date(timeIso).getTime();
  for (const period of taf.periods) {
    if (!period.fromIso || !period.toIso || !period.flightCategory) continue;
    const from = new Date(period.fromIso).getTime();
    const to = new Date(period.toIso).getTime();
    if (t >= from && t < to) return period.flightCategory;
  }
  return null;
}

// Feeds the checklist's "TAF trend" row: known = the TAF reaches this day at
// all; volatile = more than one flight category shows up that day (a sign of
// TEMPO/FM changes); hazard = a simple keyword scan of the raw TAF text for
// thunderstorms, freezing precip, or low-level wind shear. The keyword scan
// is TAF-wide, not scoped to just this day's periods - full TAF group parsing
// (TEMPO/FM/PROB lines with their own time windows) is more than this needs.
const HAZARD_PATTERN = /\bTS\b|FZRA|FZDZ|LLWS/;
export function tafSignalsForDay(taf, dayKey, timeZone) {
  if (!taf) return { known: false, volatile: false, hazard: false };

  const periodsForDay = taf.periods.filter(
    (p) => p.fromIso && new Date(p.fromIso).toLocaleDateString("en-CA", { timeZone }) === dayKey
  );
  if (!periodsForDay.length) return { known: false, volatile: false, hazard: false };

  const categories = new Set(periodsForDay.map((p) => p.flightCategory).filter(Boolean));
  return {
    known: true,
    volatile: categories.size > 1,
    hazard: HAZARD_PATTERN.test(taf.raw || ""),
  };
}
