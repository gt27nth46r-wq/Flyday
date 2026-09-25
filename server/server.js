import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lookupStation, resolveGridPoint, neighborGridPointUrl, findNearestReportingStation, GRID_SPACING_KM, HttpError } from "./lib/geo.js";
import { fetchGridForecast, buildHourlyTimeline, attachPressureGradient, summarizeDailyFromTimeline } from "./lib/nwsGrid.js";
import { fetchLatestMetar, fetchTaf, worstCategoryForDay, flightCategoryAtTime, tafSignalsForDay } from "./lib/aviationWeather.js";
import { fetchNotams, findClosedRunwayIdents } from "./lib/notams.js";
import { fetchAirSigmets, activeHazardsAtPoint } from "./lib/hazards.js";
import { evaluateChecklist, overallTier, TIER_TO_LABEL } from "./lib/checklist.js";
import { densityAltitudeFt, stationPressureToAltimeterHpa } from "./lib/density.js";
import { getRunwaysForAirport } from "./lib/runways.js";
import { civilTwilightTimes } from "./lib/sun.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const USER_AGENT = process.env.APP_USER_AGENT || "Flyday (set APP_USER_AGENT in .env)";
const CACHE_MS = Number(process.env.CACHE_MINUTES || 20) * 60 * 1000;

// AIRMETs/SIGMETs are short-fuse products (SIGMETs run a few hours, G-AIRMETs
// out to roughly a day) - there's no realistic way for them to say anything
// about day 5 of a 7-day outlook. Hours further out than this just fall back
// to the coarser precip/lightning-level proxy instead of claiming "checked."
const HAZARD_COVERAGE_HOURS = 24;

// Checklist thresholds - defaults are close to the reference "Cessna 172
// Good Flying Weather Checklist" bands, with pressure and precipitation
// loosened from the first pass: the original 1020 hPa / 20% precip bars
// were tripping on perfectly ordinary fair-weather days, which is not what
// "caution" should mean. All overridable per-request; env vars only change
// the fallback.
const DEFAULTS = {
  windThresholdKt: Number(process.env.DEFAULT_WIND_THRESHOLD_KT || 10),
  pressureThresholdHpa: Number(process.env.DEFAULT_PRESSURE_THRESHOLD_HPA || 1015),
  pressureYellowBelowHpa: Number(process.env.DEFAULT_PRESSURE_YELLOW_BELOW_HPA || 8),
  pressureFallThresholdHpa3h: Number(process.env.DEFAULT_PRESSURE_FALL_THRESHOLD_HPA3H ?? -3),
  gradientThresholdHpa100km: Number(process.env.DEFAULT_GRADIENT_THRESHOLD_HPA100KM || 6),
  gustSpreadYellowKt: Number(process.env.DEFAULT_GUST_SPREAD_YELLOW_KT || 5),
  gustSpreadRedKt: Number(process.env.DEFAULT_GUST_SPREAD_RED_KT || 10),
  visibilityGreenSm: Number(process.env.DEFAULT_VISIBILITY_GREEN_SM || 10),
  visibilityYellowSm: Number(process.env.DEFAULT_VISIBILITY_YELLOW_SM || 5),
  ceilingGreenFt: Number(process.env.DEFAULT_CEILING_GREEN_FT || 5000),
  ceilingYellowFt: Number(process.env.DEFAULT_CEILING_YELLOW_FT || 3000),
  dewpointSpreadGreenC: Number(process.env.DEFAULT_DEWPOINT_SPREAD_GREEN_C || 5),
  dewpointSpreadYellowC: Number(process.env.DEFAULT_DEWPOINT_SPREAD_YELLOW_C || 3),
  fogWindMinKt: Number(process.env.DEFAULT_FOG_WIND_MIN_KT || 2),
  fogWindMaxKt: Number(process.env.DEFAULT_FOG_WIND_MAX_KT || 10),
  fogSkyClearMaxPct: Number(process.env.DEFAULT_FOG_SKY_CLEAR_MAX_PCT || 30),
  precipYellowPct: Number(process.env.DEFAULT_PRECIP_YELLOW_PCT || 30),
  precipRedPct: Number(process.env.DEFAULT_PRECIP_RED_PCT || 60),
};

if (USER_AGENT.includes("you@example.com")) {
  console.warn(
    "[flyday] WARNING: APP_USER_AGENT still has the placeholder email. " +
    "aviationweather.gov and api.weather.gov both ask for a real contact - set this in .env."
  );
}

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

function max(nums) {
  const clean = nums.filter((n) => n != null && !Number.isNaN(n));
  return clean.length ? Math.max(...clean) : null;
}
function min(nums) {
  const clean = nums.filter((n) => n != null && !Number.isNaN(n));
  return clean.length ? Math.min(...clean) : null;
}

function avg(nums) {
  const clean = nums.filter((n) => n != null && !Number.isNaN(n));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function hourChecklistInput(hour, tafSignals) {
  return {
    windSpeedKt: hour.windSpeedKt,
    windGustKt: hour.windGustKt,
    visibilitySm: hour.visibilitySm,
    ceilingFt: hour.ceilingFt,
    ceilingKnown: !!hour.ceilingKnown,
    dewpointSpreadC: hour.tempC != null && hour.dewpointC != null ? hour.tempC - hour.dewpointC : null,
    skyCoverPct: hour.skyCoverPct,
    isDaytime: hour.isDaytime,
    pressureHpa: hour.pressureHpa,
    pressureTrendHpa3h: hour.pressureTrendHpa3h,
    pressureGradientHpa100km: hour.pressureGradientHpa100km,
    precipChance: hour.precipChance,
    iceAccumulationMm: hour.iceAccumulationMm,
    lightningActivityLevel: hour.lightningActivityLevel,
    tafKnown: tafSignals.known,
    tafVolatile: tafSignals.volatile,
    tafHazard: tafSignals.hazard,
    hazardsChecked: hour.hazardsChecked,
    turbulenceHazard: hour.turbulenceHazard,
    icingHazard: hour.icingHazard,
    convectiveHazard: hour.convectiveHazard,
  };
}

function dayChecklistInput(day, tafSignals) {
  return {
    windSpeedKt: day.maxWindKt,
    windGustKt: day.maxGustKt,
    visibilitySm: day.minVisibilitySm,
    ceilingFt: day.minCeilingFt,
    ceilingKnown: !!day.ceilingKnown,
    dewpointSpreadC: day.minDewpointSpreadC,
    skyCoverPct: day.avgSkyCoverPct,
    isDaytime: true, // this summary is already daytime-only worst-case (see the per-day loop above), so the overnight-fog mechanism never applies here
    pressureHpa: day.avgPressureHpa,
    pressureTrendHpa3h: day.minPressureTrendHpa3h,
    pressureGradientHpa100km: day.maxPressureGradientHpa100km,
    precipChance: day.maxPrecipChance,
    iceAccumulationMm: day.maxIceAccumulationMm,
    lightningActivityLevel: day.maxLightningActivityLevel,
    tafKnown: tafSignals.known,
    tafVolatile: tafSignals.volatile,
    tafHazard: tafSignals.hazard,
    hazardsChecked: day.hazardsChecked,
    turbulenceHazard: day.turbulenceHazard,
    icingHazard: day.icingHazard,
    convectiveHazard: day.convectiveHazard,
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
      const resolvedIcao = station.icao; // may differ from icaoRaw - e.g. "SQL" typed, "KSQL" resolved (see lookupStation)
      const grid = await resolveGridPoint(station.lat, station.lon, USER_AGENT);

      const [gridProps, neighborGridProps, metar, taf, runways, notamTexts, airSigmets] = await Promise.all([
        fetchGridForecast(grid.forecastGridDataUrl, USER_AGENT),
        fetchGridForecast(neighborGridPointUrl(grid), USER_AGENT).catch(() => null),
        fetchLatestMetar(resolvedIcao, USER_AGENT).catch(() => null),
        fetchTaf(resolvedIcao, USER_AGENT).catch(() => null),
        getRunwaysForAirport(resolvedIcao, USER_AGENT),
        fetchNotams(resolvedIcao, USER_AGENT).catch(() => null), // null = "couldn't check", not "no closures"
        fetchAirSigmets(USER_AGENT).catch(() => null), // null = "couldn't check", not "no hazards"
      ]);

      // Small non-towered fields often have no ASOS/AWOS at all - fall back
      // to the nearest station that does report, rather than showing nothing.
      let finalMetar = metar;
      let finalTaf = taf;
      let weatherSubstitute = null;
      if (!metar) {
        const nearest = await findNearestReportingStation(resolvedIcao, station.lat, station.lon, USER_AGENT);
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
        // Gradient is a spatial difference between two nearby raw station-
        // pressure readings - computed before the sea-level correction below,
        // so it isn't skewed by the two points potentially sitting at
        // different elevations.
        attachPressureGradient(timeline, neighborTimeline, GRID_SPACING_KM);
      }

      // NWS's gridpoint "pressure" is raw station pressure, not sea-level
      // pressure - correct it here so "high pressure" means the same thing
      // regardless of the airport's elevation. See stationPressureToAltimeterHpa()
      // for why. Pressure *trend* (rise/fall) doesn't need this: it's a
      // difference between two readings at the same station, so a constant
      // elevation offset cancels out either way.
      if (station.elevationFt != null) {
        for (const hour of timeline) {
          hour.pressureHpa = stationPressureToAltimeterHpa(hour.pressureHpa, station.elevationFt);
        }
      }

      // The current hour is better represented by the actual METAR (a real
      // observation) than by the model's forecast for that same hour -
      // timeline[0] always represents "now" (see buildHourlyTimeline), so
      // this replaces just that one hour's key fields with ground truth
      // where the METAR reports them. Every other hour keeps the NWS
      // gridpoint's own forecast ceiling (see lib/nwsGrid.js's
      // `ceilingKnown` - a missing entry there means unavailable forecast
      // detail, not clear skies; only a real entry, however high, counts).
      // Forecast-only fields (precip chance, ice accumulation, lightning
      // activity level, pressure trend/gradient) are left as the model's
      // values, since METAR doesn't report those.
      if (finalMetar && timeline.length) {
        const nowHour = timeline[0];
        if (finalMetar.windSpeedKt != null) nowHour.windSpeedKt = finalMetar.windSpeedKt;
        if (finalMetar.windGustKt != null) nowHour.windGustKt = finalMetar.windGustKt;
        if (finalMetar.windDirDeg != null) nowHour.windDirDeg = finalMetar.windDirDeg;
        if (finalMetar.visibilitySm != null) nowHour.visibilitySm = finalMetar.visibilitySm;
        nowHour.ceilingFt = finalMetar.ceilingFt; // a real METAR's null here genuinely means "no ceiling reported" (clear/few/scattered), not missing data
        nowHour.ceilingKnown = true;
        if (finalMetar.tempC != null) nowHour.tempC = finalMetar.tempC;
        if (finalMetar.dewpointC != null) nowHour.dewpointC = finalMetar.dewpointC;
        // METAR's altimeter setting is already a sea-level-equivalent (QNH)
        // reading - unlike the gridpoint's raw station pressure, it needs no
        // elevation correction.
        if (finalMetar.altimeterInHg != null) nowHour.pressureHpa = finalMetar.altimeterInHg * 33.8639;
      }

      const dailyGrid = summarizeDailyFromTimeline(timeline, grid.timeZone, 7);

      const now = Date.now();
      for (const day of dailyGrid) {
        // Day/night, computed locally (no API needed) from the airport's
        // coordinates, using civil twilight rather than plain sunrise/sunset -
        // this matches 14 CFR 1.1's definition of "night" (the time between
        // the end of evening civil twilight and the start of morning civil
        // twilight), which is the aviation-relevant boundary.
        const { dawn, dusk } = civilTwilightTimes(new Date(`${day.date}T12:00:00Z`), station.lat, station.lon);
        day.civilDawnIso = dawn ? dawn.toISOString() : null;
        day.civilDuskIso = dusk ? dusk.toISOString() : null;

        for (const hour of day.hourly) {
          const t = new Date(hour.timeIso);
          hour.isDaytime = dawn && dusk ? t >= dawn && t <= dusk : null;

          // Official aviation flight category (VFR/MVFR/IFR/LIFR), straight
          // from whichever TAF period actually covers this hour - null
          // (shown as unknown, never guessed) once the hour is past the
          // TAF's ~24-30 hour coverage.
          hour.tafFlightCategory = flightCategoryAtTime(finalTaf, hour.timeIso);

          // AIRMET/SIGMET/convective SIGMET, scoped to hours the product
          // could plausibly say anything about.
          const hourMs = t.getTime();
          if (airSigmets != null && hourMs - now <= HAZARD_COVERAGE_HOURS * 3600000) {
            const active = activeHazardsAtPoint(airSigmets, station.lat, station.lon, hourMs);
            hour.hazardsChecked = true;
            hour.turbulenceHazard = active.turbulence;
            hour.icingHazard = active.icing;
            hour.convectiveHazard = active.convective;
          } else {
            hour.hazardsChecked = false;
            hour.turbulenceHazard = false;
            hour.icingHazard = false;
            hour.convectiveHazard = false;
          }
        }

        // "Worst case today" only looks at daytime hours from here on - an
        // overnight fog bank or a stray 3am wind gust shouldn't drag down a
        // day that's perfectly flyable from sunrise to sunset. This
        // overwrites the day's own summary fields (used both by the
        // checklist and by the plain readouts on the day card), so the two
        // never show different numbers. Falls back to all hours only if none
        // are flagged daytime (a sun-time edge case near the poles).
        const daytimeHours = day.hourly.filter((h) => h.isDaytime === true);
        const hoursForDaySummary = daytimeHours.length ? daytimeHours : day.hourly;

        day.maxWindKt = max(hoursForDaySummary.map((h) => h.windSpeedKt));
        day.avgWindKt = avg(hoursForDaySummary.map((h) => h.windSpeedKt));
        day.maxGustKt = max(hoursForDaySummary.map((h) => h.windGustKt));
        day.minVisibilitySm = min(hoursForDaySummary.map((h) => h.visibilitySm));
        day.minCeilingFt = min(hoursForDaySummary.map((h) => h.ceilingFt));
        day.ceilingKnown = hoursForDaySummary.some((h) => h.ceilingKnown);
        day.maxTempC = max(hoursForDaySummary.map((h) => h.tempC));
        day.maxPrecipChance = max(hoursForDaySummary.map((h) => h.precipChance));
        day.avgSkyCoverPct = avg(hoursForDaySummary.map((h) => h.skyCoverPct));
        day.avgPressureHpa = avg(hoursForDaySummary.map((h) => h.pressureHpa));
        day.minPressureTrendHpa3h = min(hoursForDaySummary.map((h) => h.pressureTrendHpa3h));
        day.maxPressureGradientHpa100km = max(hoursForDaySummary.map((h) => h.pressureGradientHpa100km));
        day.minDewpointSpreadC = min(hoursForDaySummary.map((h) => (h.tempC != null && h.dewpointC != null ? h.tempC - h.dewpointC : null)));
        day.maxIceAccumulationMm = max(hoursForDaySummary.map((h) => h.iceAccumulationMm));
        day.maxLightningActivityLevel = max(hoursForDaySummary.map((h) => h.lightningActivityLevel));
        day.hazardsChecked = hoursForDaySummary.some((h) => h.hazardsChecked);
        day.turbulenceHazard = hoursForDaySummary.some((h) => h.turbulenceHazard);
        day.icingHazard = hoursForDaySummary.some((h) => h.icingHazard);
        day.convectiveHazard = hoursForDaySummary.some((h) => h.convectiveHazard);
        day.hasData = hoursForDaySummary.some((h) => h.pressureHpa != null || h.windSpeedKt != null);
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
        hazardStatus: airSigmets != null ? "checked" : "unavailable",
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
      hazardStatus: bundle.hazardStatus,
      days,
      fetchedAt: bundle.fetchedAt,
      sources: [
        "https://aviationweather.gov/data/api/ (station info, METAR, TAF, NOTAM, AIRMET/SIGMET/convective SIGMET)",
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
