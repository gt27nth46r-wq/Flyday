import { HttpError } from "./geo.js";

// NWS gridpoint values look like:
//   { validTime: "2026-09-14T18:00:00+00:00/PT6H", value: 102400 }
// We expand every layer onto an hourly UTC timeline (repeating the value
// across its duration), then merge layers into one hourly record per hour.
// That gives us paired wind-speed/wind-direction (needed for crosswind) and
// an hourly drill-down for the UI, not just daily averages.
const MAX_EXPAND_HOURS = 24; // gridpoint durations are normally <= 12h; this is a safety cap

function parseIsoDurationHours(duration) {
  const match = duration.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!match) return 1;
  const [, days, hours, minutes] = match;
  return (Number(days || 0) * 24) + Number(hours || 0) + (Number(minutes || 0) / 60);
}

function expandToHourly(values) {
  const map = new Map(); // hourKey (ISO, truncated to hour, UTC) -> value
  for (const entry of values ?? []) {
    const [startIso, duration] = entry.validTime.split("/");
    const start = new Date(startIso);
    const hours = Math.min(Math.max(Math.round(parseIsoDurationHours(duration)), 1), MAX_EXPAND_HOURS);
    for (let h = 0; h < hours; h++) {
      const t = new Date(start.getTime() + h * 3600 * 1000);
      t.setUTCMinutes(0, 0, 0);
      map.set(t.toISOString(), entry.value);
    }
  }
  return map;
}

function localDateKey(isoString, timeZone) {
  return new Date(isoString).toLocaleDateString("en-CA", { timeZone });
}

function avg(nums) {
  const clean = nums.filter((n) => n != null && !Number.isNaN(n));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}
function max(nums) {
  const clean = nums.filter((n) => n != null && !Number.isNaN(n));
  if (!clean.length) return null;
  return Math.max(...clean);
}
function min(nums) {
  const clean = nums.filter((n) => n != null && !Number.isNaN(n));
  if (!clean.length) return null;
  return Math.min(...clean);
}

export async function fetchGridForecast(forecastGridDataUrl, userAgent) {
  const res = await fetch(forecastGridDataUrl, {
    headers: { "User-Agent": userAgent, Accept: "application/geo+json" },
  });
  if (!res.ok) {
    throw new HttpError(502, `api.weather.gov gridpoint fetch failed (${res.status})`);
  }
  const data = await res.json();
  return data.properties;
}

// Builds an hourly timeline (next `days` days) with normalized units:
// kt for wind, hPa for pressure, ft for ceiling, statute miles for visibility,
// degrees C for temperature. Any layer a given office doesn't publish is left null.
// Also computes a 3-hour pressure tendency per hour - the same "rising/falling"
// signal reported in a synoptic pressure tendency, used as an approaching-low warning.
export function buildHourlyTimeline(gridProps, days = 7) {
  const pressureMap = expandToHourly(gridProps.pressure?.values); // Pa
  const windMap = expandToHourly(gridProps.windSpeed?.values); // km/h
  const gustMap = expandToHourly(gridProps.windGust?.values); // km/h
  const dirMap = expandToHourly(gridProps.windDirection?.values); // degrees true
  const ceilingMap = expandToHourly(gridProps.ceilingHeight?.values); // meters
  const visMap = expandToHourly(gridProps.visibility?.values); // meters
  const tempMap = expandToHourly(gridProps.temperature?.values); // degC
  const dewpointMap = expandToHourly(gridProps.dewpoint?.values); // degC
  const popMap = expandToHourly(gridProps.probabilityOfPrecipitation?.values); // %
  const skyMap = expandToHourly(gridProps.skyCover?.values); // %
  const iceMap = expandToHourly(gridProps.iceAccumulation?.values); // mm, freezing precip only
  const lalMap = expandToHourly(gridProps.lightningActivityLevel?.values); // 1-6 scale, not all offices publish this

  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const hours = days * 24;

  const timeline = [];
  for (let h = 0; h < hours; h++) {
    const t = new Date(now.getTime() + h * 3600 * 1000);
    const key = t.toISOString();

    const pa = pressureMap.get(key);
    const wk = windMap.get(key);
    const gk = gustMap.get(key);
    const cm = ceilingMap.get(key);
    const vm = visMap.get(key);
    const ice = iceMap.get(key);

    timeline.push({
      timeIso: key,
      pressureHpa: pa != null ? pa / 100 : null,
      windSpeedKt: wk != null ? wk * 0.539957 : null,
      windGustKt: gk != null ? gk * 0.539957 : null,
      windDirDeg: dirMap.get(key) ?? null,
      ceilingFt: cm != null ? cm * 3.28084 : null,
      visibilitySm: vm != null ? vm / 1609.34 : null,
      tempC: tempMap.get(key) ?? null,
      dewpointC: dewpointMap.get(key) ?? null,
      precipChance: popMap.get(key) ?? null,
      skyCoverPct: skyMap.get(key) ?? null,
      iceAccumulationMm: ice ?? null,
      lightningActivityLevel: lalMap.get(key) ?? null,
    });
  }

  // 3-hour pressure tendency: current minus 3 hours ago. Negative = falling
  // (a classic sign of an approaching low); the first 3 hours have nothing
  // before "now" to compare against, so they're left null rather than guessed.
  for (let i = 0; i < timeline.length; i++) {
    if (i < 3 || timeline[i].pressureHpa == null || timeline[i - 3].pressureHpa == null) {
      timeline[i].pressureTrendHpa3h = null;
    } else {
      timeline[i].pressureTrendHpa3h = timeline[i].pressureHpa - timeline[i - 3].pressureHpa;
    }
  }

  return timeline;
}

// Merges a neighboring gridpoint's pressure into `timeline` as a gradient
// (hPa per 100km) - tightly packed isobars show up as a large gradient here.
// This is a one-directional sample (east neighbor only), so it's a proxy for
// "how sharp is the pressure gradient nearby," not a true multi-directional
// isobar analysis.
export function attachPressureGradient(timeline, neighborTimeline, gridSpacingKm) {
  const neighborByTime = new Map(neighborTimeline.map((h) => [h.timeIso, h.pressureHpa]));
  for (const hour of timeline) {
    const neighborPressure = neighborByTime.get(hour.timeIso);
    if (hour.pressureHpa == null || neighborPressure == null) {
      hour.pressureGradientHpa100km = null;
    } else {
      const diff = Math.abs(hour.pressureHpa - neighborPressure);
      hour.pressureGradientHpa100km = diff * (100 / gridSpacingKm);
    }
  }
  return timeline;
}

// Groups the hourly timeline into local calendar days and computes the
// worst-case / representative numbers Flyday's rating and display need.
export function summarizeDailyFromTimeline(timeline, timeZone, days = 7) {
  const todayKey = localDateKey(new Date().toISOString(), timeZone);
  const todayDate = new Date(`${todayKey}T00:00:00`);

  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(todayDate);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);

    const hoursForDay = timeline.filter((h) => localDateKey(h.timeIso, timeZone) === key);

    out.push({
      date: key,
      hasData: hoursForDay.some((h) => h.pressureHpa != null || h.windSpeedKt != null),
      avgPressureHpa: avg(hoursForDay.map((h) => h.pressureHpa)),
      maxWindKt: max(hoursForDay.map((h) => h.windSpeedKt)),
      avgWindKt: avg(hoursForDay.map((h) => h.windSpeedKt)),
      maxGustKt: max(hoursForDay.map((h) => h.windGustKt)),
      minCeilingFt: min(hoursForDay.map((h) => h.ceilingFt)),
      minVisibilitySm: min(hoursForDay.map((h) => h.visibilitySm)),
      maxTempC: max(hoursForDay.map((h) => h.tempC)),
      maxPrecipChance: max(hoursForDay.map((h) => h.precipChance)),
      avgSkyCoverPct: avg(hoursForDay.map((h) => h.skyCoverPct)),
      minPressureTrendHpa3h: min(hoursForDay.map((h) => h.pressureTrendHpa3h)),
      maxPressureGradientHpa100km: max(hoursForDay.map((h) => h.pressureGradientHpa100km)),
      minDewpointSpreadC: min(hoursForDay.map((h) => (h.tempC != null && h.dewpointC != null ? h.tempC - h.dewpointC : null))),
      maxIceAccumulationMm: max(hoursForDay.map((h) => h.iceAccumulationMm)),
      maxLightningActivityLevel: max(hoursForDay.map((h) => h.lightningActivityLevel)),
      hourly: hoursForDay.map((h) => ({
        timeIso: h.timeIso,
        windSpeedKt: h.windSpeedKt,
        windGustKt: h.windGustKt,
        windDirDeg: h.windDirDeg,
        ceilingFt: h.ceilingFt,
        visibilitySm: h.visibilitySm,
        tempC: h.tempC,
        dewpointC: h.dewpointC,
        precipChance: h.precipChance,
        pressureHpa: h.pressureHpa,
        pressureTrendHpa3h: h.pressureTrendHpa3h,
        pressureGradientHpa100km: h.pressureGradientHpa100km,
        iceAccumulationMm: h.iceAccumulationMm,
        lightningActivityLevel: h.lightningActivityLevel,
        skyCoverPct: h.skyCoverPct,
      })),
    });
  }
  return out;
}
