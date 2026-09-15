import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lookupStation, resolveGridPoint, neighborGridPointUrl, GRID_SPACING_KM, HttpError } from "./lib/geo.js";
import { fetchGridForecast, buildHourlyTimeline, attachPressureGradient, summarizeDailyFromTimeline } from "./lib/nwsGrid.js";
import { fetchLatestMetar, fetchTaf, worstCategoryForDay } from "./lib/aviationWeather.js";
import { rateDay, rateHour } from "./lib/rating.js";
import { densityAltitudeFt } from "./lib/density.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const USER_AGENT = process.env.APP_USER_AGENT || "Flyday (set APP_USER_AGENT in .env)";
const DEFAULT_WIND_KT = Number(process.env.DEFAULT_WIND_THRESHOLD_KT || 10);
const DEFAULT_PRESSURE_HPA = Number(process.env.DEFAULT_PRESSURE_THRESHOLD_HPA || 1020);
const DEFAULT_CEILING_FT = Number(process.env.DEFAULT_CEILING_THRESHOLD_FT || 3000);
const DEFAULT_VISIBILITY_SM = Number(process.env.DEFAULT_VISIBILITY_THRESHOLD_SM || 5);
const DEFAULT_PRESSURE_FALL_HPA3H = Number(process.env.DEFAULT_PRESSURE_FALL_THRESHOLD_HPA3H || -3);
const DEFAULT_GRADIENT_HPA100KM = Number(process.env.DEFAULT_GRADIENT_THRESHOLD_HPA100KM || 6);
const CACHE_MS = Number(process.env.CACHE_MINUTES || 20) * 60 * 1000;

if (USER_AGENT.includes("you@example.com")) {
  console.warn(
    "[flyday] WARNING: APP_USER_AGENT still has the placeholder email. " +
    "aviationweather.gov and api.weather.gov both ask for a real contact - set this in .env."
  );
}

// Tiny in-memory cache so repeat requests for the same airport within
// CACHE_MINUTES don't re-hit upstream APIs. Good enough for a single-instance
// deploy; swap for Redis if you scale to multiple instances.
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

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/forecast", async (req, res) => {
  try {
    const icaoRaw = String(req.query.icao || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{3,5}$/.test(icaoRaw)) {
      return res.status(400).json({ error: "Provide a valid airport identifier, e.g. icao=KPAO" });
    }

    const windThresholdKt = Number(req.query.windThreshold) || DEFAULT_WIND_KT;
    const pressureThresholdHpa = Number(req.query.pressureThreshold) || DEFAULT_PRESSURE_HPA;
    const ceilingThresholdFt = Number(req.query.ceilingThreshold) || DEFAULT_CEILING_FT;
    const visibilityThresholdSm = Number(req.query.visibilityThreshold) || DEFAULT_VISIBILITY_SM;
    const pressureFallThresholdHpa3h = req.query.pressureFallThreshold
      ? Number(req.query.pressureFallThreshold)
      : DEFAULT_PRESSURE_FALL_HPA3H;
    const gradientThresholdHpa100km = Number(req.query.gradientThreshold) || DEFAULT_GRADIENT_HPA100KM;

    const cacheKey = `${icaoRaw}`;
    let bundle = cacheGet(cacheKey);

    if (!bundle) {
      const station = await lookupStation(icaoRaw, USER_AGENT);
      const grid = await resolveGridPoint(station.lat, station.lon, USER_AGENT);

      const [gridProps, neighborGridProps, metar, taf] = await Promise.all([
        fetchGridForecast(grid.forecastGridDataUrl, USER_AGENT),
        fetchGridForecast(neighborGridPointUrl(grid), USER_AGENT).catch(() => null),
        fetchLatestMetar(icaoRaw, USER_AGENT).catch(() => null),
        fetchTaf(icaoRaw, USER_AGENT).catch(() => null),
      ]);

      const timeline = buildHourlyTimeline(gridProps, 7);
      if (neighborGridProps) {
        const neighborTimeline = buildHourlyTimeline(neighborGridProps, 7);
        attachPressureGradient(timeline, neighborTimeline, GRID_SPACING_KM);
      }
      const dailyGrid = summarizeDailyFromTimeline(timeline, grid.timeZone, 7);

      bundle = { station, grid, dailyGrid, metar, taf, fetchedAt: new Date().toISOString() };
      cacheSet(cacheKey, bundle);
    }

    const rateOpts = { windThresholdKt, pressureThresholdHpa, ceilingThresholdFt, visibilityThresholdSm, pressureFallThresholdHpa3h, gradientThresholdHpa100km };

    const days = bundle.dailyGrid.map((day) => {
      const rating = rateDay(day, rateOpts);
      const tafCategory = worstCategoryForDay(bundle.taf, day.date, bundle.grid.timeZone);
      const densityAltFt = densityAltitudeFt(bundle.station.elevationFt, day.avgPressureHpa, day.maxTempC);
      const hourly = day.hourly.map((hour) => ({ ...hour, label: rateHour(hour, rateOpts) }));
      return { ...day, ...rating, hourly, tafFlightCategory: tafCategory, densityAltitudeFt: densityAltFt };
    });

    res.json({
      station: bundle.station,
      location: bundle.grid.relativeLocation,
      timeZone: bundle.grid.timeZone,
      thresholds: { windThresholdKt, pressureThresholdHpa, ceilingThresholdFt, visibilityThresholdSm, pressureFallThresholdHpa3h, gradientThresholdHpa100km },
      metar: bundle.metar,
      taf: bundle.taf ? { raw: bundle.taf.raw, issuedAt: bundle.taf.issuedAt } : null,
      days,
      fetchedAt: bundle.fetchedAt,
      sources: [
        "https://aviationweather.gov/data/api/ (station info, METAR, TAF)",
        "https://www.weather.gov/documentation/services-web-api (7-day gridpoint forecast: pressure, wind, ceiling, visibility, temperature, plus a neighboring gridpoint for pressure-gradient estimation)",
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
