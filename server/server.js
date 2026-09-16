import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lookupStation, resolveGridPoint, neighborGridPointUrl, findNearestReportingStation, GRID_SPACING_KM, HttpError } from "./lib/geo.js";
import { fetchGridForecast, buildHourlyTimeline, attachPressureGradient, summarizeDailyFromTimeline } from "./lib/nwsGrid.js";
import { fetchLatestMetar, fetchTaf, worstCategoryForDay, tafSignalsForDay } from "./lib/aviationWeather.js";
import { fetchNotams, findClosedRunwayIdents } from "./lib/notams.js";
import { evaluateChecklist, overallTier, TIER_TO_LABEL } from "./lib/checklist.js";
import { densityAltitudeFt } from "./lib/density.js";
import { getRunwaysForAirport } from "./lib/runways.js";
import { sunTimes } from "./lib/sun.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const USER_AGENT = process.env.APP_USER_AGENT || "Flyday (set APP_USER_AGENT in .env)";
const CACHE_MS = Number(process.env.CACHE_MINUTES || 20) * 60 * 1000;

// Checklist thresholds - defaults match the reference "Cessna 172 Good Flying
// Weather Checklist" bands exactly. All are overridable per-request via query
// params (see readThresholds() below); env vars only change the fallback.
const DEFAULTS = {
  windThresholdKt: Number(process.env.DEFAULT_WIND_THRESHOLD_KT || 10),
  pressureThresholdHpa: Number(process.env.DEFAULT_PRESSURE_THRESHOLD_HPA || 1020),
  pressureFallThresholdHpa3h: Number(process.env.DEFAULT_PRESSURE_FALL_THRESHOLD_HPA3H ?? -3),
  gradientThresholdHpa100km: Number(process.env.DEFAULT_GRADIENT_THRESHOLD_HPA100KM || 6),
  gustSpreadYellowKt: Number(process.env.DEFAULT_GUST_SPREAD_YELLOW_KT || 5),
  gustSpreadRedKt: Number(process.env.DEFAULT_GUST_SPREAD_RED_KT || 10),
  visibilityGreenSm: Number(process.env.DEFAULT_VISIBILITY_GREEN_SM || 10),
  visibilityYellowSm: Number(process.env.DEFAULT_VISIBILITY_YELLOW_SM || 5),
  ceilingGreenFt: Number(process.env.DEFAULT_CEILING_GREEN_FT || 5000),
  ceilingYellowFt: Number(process.env.DEFAULT_CEILING_YELLOW_FT || 3000),
  dewpointSpreadGreenC: Number(process.env.DEFAULT_DEWPOINT_SPREAD_GREEN_C || 8),
  dewpointSpreadYellowC: Number(process.env.DEFAULT_DEWPOINT_SPREAD_YELLOW_C || 4),
  precipYellowPct: Number(process.env.DEFAULT_PRECIP_YELLOW_PCT || 20),
  precipRedPct: Number(process.env.DEFAULT_PRECIP_RED_PCT || 50),
};

if (USER_AGENT.includes("you@example.com")) {
  console.warn(
    "[flyday] WARNING: APP_USER_AGENT still has the placeholder email. " +
    "aviationweather.gov and api.weather.gov both ask for a real contact - set this in .env."
  );
}

// Tiny in-memory cache so repeat requests for the same airport within
// CACHE_MINUTES don't re-hit upstream APIs.
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
}

function readThresholds(query) {
  const opts = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const raw = query[key];
    opts[key] = raw !== undefined && raw !== "" ? Number(raw) : def;
  }
  return opts;
}

function hourChecklistInput(hour, tafSignals) {
  return {
    windSpeedKt: hour.windSpeedKt,
    windGustKt: hour.windGustKt,
    visibilitySm: hour.visibilitySm,
    ceilingFt: hour.ceilingFt,
    dewpointSpreadC: hour.tempC != null && hour.dewpointC != null ? hour.tempC - hour.dewpointC : null,
    pressureHpa: hour.pressureHpa,
    pressureTrendHpa3h: hour.pressureTrendHpa3h,
    pressureGradientHpa100km: hour.pressureGradientHpa100km,
    precipChance: hour.precipChance,
    iceAccumulationMm: hour.iceAccumulationMm,
    lightningActivityLevel: hour.lightningActivityLevel,
    tafKnown: tafSignals.known,
    tafVolatile: tafSignals.volatile,
    tafHazard: tafSignals.hazard,
  };
}

function dayChecklistInput(day, tafSignals) {
  return {
    windSpeedKt: day.maxWindKt,
    windGustKt: day.maxGustKt,
    visibilitySm: day.minVisibilitySm,
    ceilingFt: day.minCeilingFt,
    dewpointSpreadC: day.minDewpointSpreadC,
    pressureHpa: day.avgPressureHpa,
    pressureTrendHpa3h: day.minPressureTrendHpa3h,
    pressureGradientHpa100km: day.maxPressureGradientHpa100km,
    precipChance: day.maxPrecipChance,
    iceAccumulationMm: day.maxIceAccumulationMm,
    lightningActivityLevel: day.maxLightningActivityLevel,
    tafKnown: tafSignals.known,
    tafVolatile: tafSignals.volatile,
    tafHazard: tafSignals.hazard,
  };
}

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/forecast", async (req, res) => {
  try {
    const icaoRaw = String(req.query.icao || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{3,5}$/.test(icaoRaw)) {
      return res.status(400).json({ error: "Provide a valid airport identifier, e.g. icao=KPAO" });
    }

    const opts = readThresholds(req.query);
    const cacheKey = icaoRaw;
    let bundle = cacheGet(cacheKey);

    if (!bundle) {
      const station = await lookupStation(icaoRaw, USER_AGENT);
      const grid = await resolveGridPoint(station.lat, station.lon, USER_AGENT);

      const [gridProps, neighborGridProps, metar, taf, runways, notamTexts] = await Promise.all([
        fetchGridForecast(grid.forecastGridDataUrl, USER_AGENT),
        fetchGridForecast(neighborGridPointUrl(grid), USER_AGENT).catch(() => null),
        fetchLatestMetar(icaoRaw, USER_AGENT).catch(() => null),
        fetchTaf(icaoRaw, USER_AGENT).catch(() => null),
        getRunwaysForAirport(icaoRaw, USER_AGENT),
        fetchNotams(icaoRaw, USER_AGENT).catch(() => null), // null = "couldn't check", not "no closures"
      ]);

      // Small non-towered fields often have no ASOS/AWOS at all - fall back
      // to the nearest station that does report, rather than showing nothing.
      let finalMetar = metar;
      let finalTaf = taf;
      let weatherSubstitute = null;
      if (!metar) {
        const nearest = await findNearestReportingStation(icaoRaw, station.lat, station.lon, USER_AGENT);
        if (nearest) {
          const [subMetar, subTaf] = await Promise.all([
            fetchLatestMetar(nearest.icao, USER_AGENT).catch(() => null),
            fetchTaf(nearest.icao, USER_AGENT).catch(() => null),
          ]);
          if (subMetar) {
            finalMetar = subMetar;
            finalTaf = subTaf ?? taf;
            weatherSubstitute = nearest;
          }
        }
      }

      // NOTAM-reported runway closures - a best-effort text scan, not a
      // parse of effective dates or Q-codes. See lib/notams.js for caveats.
      const notamStatus = notamTexts != null ? "checked" : "unavailable";
      const closedIdents = notamTexts != null ? findClosedRunwayIdents(notamTexts) : new Set();
      const runwaysWithClosures = runways.map((r) => ({
        ...r,
        closed: closedIdents.has(r.leIdent) || closedIdents.has(r.heIdent),
      }));

      const timeline = buildHourlyTimeline(gridProps, 7);
      if (neighborGridProps) {
        const neighborTimeline = buildHourlyTimeline(neighborGridProps, 7);
        attachPressureGradient(timeline, neighborTimeline, GRID_SPACING_KM);
      }
      const dailyGrid = summarizeDailyFromTimeline(timeline, grid.timeZone, 7);

      // Day/night, computed locally (no API needed) from the airport's own
      // coordinates - see lib/sun.js.
      for (const day of dailyGrid) {
        const { sunrise, sunset } = sunTimes(new Date(`${day.date}T12:00:00Z`), station.lat, station.lon);
        day.sunriseIso = sunrise ? sunrise.toISOString() : null;
        day.sunsetIso = sunset ? sunset.toISOString() : null;
        for (const hour of day.hourly) {
          const t = new Date(hour.timeIso);
          hour.isDaytime = sunrise && sunset ? t >= sunrise && t <= sunset : null;
        }
      }

      bundle = {
        station,
        grid,
        dailyGrid,
        metar: finalMetar,
        taf: finalTaf,
        weatherSubstitute,
        runways: runwaysWithClosures,
        notamStatus,
        fetchedAt: new Date().toISOString(),
      };
      cacheSet(cacheKey, bundle);
    }

    const days = bundle.dailyGrid.map((day) => {
      const tafSignals = tafSignalsForDay(bundle.taf, day.date, bundle.grid.timeZone);

      const dayChecklist = evaluateChecklist(dayChecklistInput(day, tafSignals), opts);
      const dayTier = overallTier(dayChecklist);

      const hourly = day.hourly.map((hour) => {
        const checklist = evaluateChecklist(hourChecklistInput(hour, tafSignals), opts);
        const tier = overallTier(checklist);
        return { ...hour, checklist, tier, label: TIER_TO_LABEL[tier] };
      });

      const tafCategory = worstCategoryForDay(bundle.taf, day.date, bundle.grid.timeZone);
      const densityAltFt = densityAltitudeFt(bundle.station.elevationFt, day.avgPressureHpa, day.maxTempC);

      return {
        ...day,
        checklist: dayChecklist,
        tier: dayTier,
        label: TIER_TO_LABEL[dayTier],
        hourly,
        tafFlightCategory: tafCategory,
        densityAltitudeFt: densityAltFt,
      };
    });

    res.json({
      station: { ...bundle.station, runways: bundle.runways },
      location: bundle.grid.relativeLocation,
      timeZone: bundle.grid.timeZone,
      thresholds: opts,
      metar: bundle.metar,
      taf: bundle.taf ? { raw: bundle.taf.raw, issuedAt: bundle.taf.issuedAt } : null,
      weatherSubstitute: bundle.weatherSubstitute,
      notamStatus: bundle.notamStatus,
      days,
      fetchedAt: bundle.fetchedAt,
      sources: [
        "https://aviationweather.gov/data/api/ (station info, METAR, TAF, NOTAM)",
        "https://www.weather.gov/documentation/services-web-api (7-day gridpoint forecast: pressure, wind, ceiling, visibility, temperature, dew point, ice accumulation, lightning activity level, plus a neighboring gridpoint for pressure-gradient estimation)",
        "https://github.com/davidmegginson/ourairports-data (runway headings, built from FAA NASR/Chart Supplement and equivalent sources for other countries)",
      ],
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong" });
  }
});

app.listen(PORT, () => {
  console.log(`Flyday server running on http://localhost:${PORT}`);
});
