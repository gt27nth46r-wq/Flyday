// Mirrors the rows of a standard GA "good flying weather" checklist
// (surface wind, gust spread, visibility, ceiling, dew point spread,
// pressure pattern, precipitation, etc.), each scored GREEN / YELLOW / RED.
//
// Turbulence and icing used to be permanent N/A rows - there's now real
// AIRMET/SIGMET/convective-SIGMET polygon data behind them (see
// lib/hazards.js), so they're checked properly. A few rows still have no
// simple free real-time source Flyday can reach - fronts (actual position),
// cloud type/vertical development, PIREP ride reports, winds aloft - those
// stay N/A rather than a guess.
//
// This runs on both an hourly record and a day's worst-case aggregate -
// both are normalized to the same shape by toChecklistInput() in server.js.

const TIER_RANK = { GREEN: 0, YELLOW: 1, RED: 2 };

function tierFromBands(value, greenIf, yellowIf) {
  if (value == null) return "NA";
  if (greenIf(value)) return "GREEN";
  if (yellowIf(value)) return "YELLOW";
  return "RED";
}

export function evaluateChecklist(input, opts) {
  const {
    windThresholdKt,
    gustSpreadYellowKt = 5,
    gustSpreadRedKt = 10,
    visibilityGreenSm = 10,
    visibilityYellowSm = 5,
    ceilingGreenFt = 5000,
    ceilingYellowFt = 3000,
    cloudBaseGreenFt = 2000,
    cloudBaseYellowFt = 1000,
    dewpointSpreadGreenC = 5,
    dewpointSpreadYellowC = 3,
    pressureThresholdHpa,
    pressureYellowBelowHpa = 8, // how far below threshold still reads as "moderate" rather than "low"
    precipYellowPct = 30,
    precipRedPct = 60,
  } = opts;

  const items = [];

  // 1. Surface wind - a contributing signal, not on its own a go/no-go stop
  items.push({
    key: "wind",
    label: "Surface wind",
    value: input.windSpeedKt != null ? `${Math.round(input.windSpeedKt)} kt` : null,
    tier: tierFromBands(input.windSpeedKt, (v) => v <= windThresholdKt, (v) => v <= windThresholdKt + 5),
    critical: false,
  });

  // 2. Gust spread (gust minus steady wind) - contributing signal
  const gustSpread = input.windGustKt != null && input.windSpeedKt != null
    ? Math.max(0, input.windGustKt - input.windSpeedKt)
    : (input.windSpeedKt != null ? 0 : null); // no gust reported = no spread
  items.push({
    key: "gustSpread",
    label: "Gust spread",
    value: gustSpread != null ? `${Math.round(gustSpread)} kt` : null,
    tier: tierFromBands(gustSpread, (v) => v < gustSpreadYellowKt, (v) => v <= gustSpreadRedKt),
    critical: false,
  });

  // 3. Crosswind - only known client-side (needs runway heading), so the
  // server always returns NA here; app.js overwrites this one row after
  // computing it locally. Critical: a crosswind beyond every runway you've
  // got is a real go/no-go stop on its own.
  items.push({
    key: "crosswind",
    label: "Crosswind (needs runway)",
    value: null,
    tier: "NA",
    critical: true,
  });

  // 4. Visibility - critical: poor visibility isn't offset by good wind
  items.push({
    key: "visibility",
    label: "Visibility",
    value: input.visibilitySm != null ? `${input.visibilitySm.toFixed(1)} sm` : null,
    tier: tierFromBands(input.visibilitySm, (v) => v >= visibilityGreenSm, (v) => v >= visibilityYellowSm),
    critical: true,
  });

  // 5. Ceiling - critical, same reasoning as visibility
  items.push({
    key: "ceiling",
    label: "Ceiling",
    value: input.ceilingFt != null ? `${Math.round(input.ceilingFt)} ft` : "unlimited",
    tier: input.ceilingFt == null ? "GREEN" : tierFromBands(input.ceilingFt, (v) => v >= ceilingGreenFt, (v) => v >= ceilingYellowFt),
    critical: true,
  });

  // 6. Temp / dew point spread (fog and stability risk) - contributing
  // signal. Bands: below 3°C is Bad, 3-5°C is Marginal, above 5°C is Good.
  items.push({
    key: "dewpointSpread",
    label: "Dew point spread",
    value: input.dewpointSpreadC != null ? `${input.dewpointSpreadC.toFixed(1)} °C` : null,
    tier: tierFromBands(input.dewpointSpreadC, (v) => v > dewpointSpreadGreenC, (v) => v >= dewpointSpreadYellowC),
    critical: false,
  });

  // 6b. Convective cloud base estimate (adiabatic lapse rate / LCL) -
  // a predictive signal for where cumulus bases will form given today's
  // heating, separate from the forecast ceiling itself. Contributing, since
  // it's an estimate rather than an observed/forecast value. Bands: below
  // 1,000ft is Bad, 1,000-2,000ft is Marginal, above 2,000ft is Good.
  items.push({
    key: "cloudBase",
    label: "Est. convective cloud base",
    value: input.cloudBaseFt != null ? `${input.cloudBaseFt.toLocaleString()} ft` : null,
    tier: tierFromBands(input.cloudBaseFt, (v) => v > cloudBaseGreenFt, (v) => v >= cloudBaseYellowFt),
    critical: false,
  });

  // 7. Pressure pattern - three clean bands now instead of "at the high-
  // pressure bar, or yellow": typical fair-weather pressure (a bit below the
  // "high pressure" threshold) reads as Yellow, not the same as a genuinely
  // low, unsettled pattern. Still critical - an approaching low or tight
  // gradient is a real weather-system-level concern that good wind doesn't
  // offset.
  const lowMovingIn = input.pressureTrendHpa3h != null && input.pressureTrendHpa3h <= opts.pressureFallThresholdHpa3h;
  const tightIsobars = input.pressureGradientHpa100km != null && input.pressureGradientHpa100km >= opts.gradientThresholdHpa100km;
  let pressureTier = tierFromBands(
    input.pressureHpa,
    (v) => v >= pressureThresholdHpa,
    (v) => v >= pressureThresholdHpa - pressureYellowBelowHpa
  );
  if (lowMovingIn || tightIsobars) pressureTier = "RED";
  items.push({
    key: "pressurePattern",
    label: "Pressure pattern",
    value: input.pressureHpa != null ? `${Math.round(input.pressureHpa)} hPa${lowMovingIn ? ", falling" : ""}${tightIsobars ? ", tight gradient" : ""}` : null,
    tier: pressureTier,
    critical: true,
  });

  // 8. Fronts - no simple free feed for actual front position
  items.push({ key: "fronts", label: "Fronts nearby", value: null, tier: "NA", critical: false });

  // 9. Cloud type / vertical development - sky cover % doesn't tell you TCU vs stratus
  items.push({ key: "cloudType", label: "Cloud type", value: null, tier: "NA", critical: false });

  // 10. Precipitation - critical: freezing precip especially is a hard stop.
  // Thresholds loosened from the first pass - a routine 20% shower chance
  // in an otherwise ordinary forecast was reading as a caution flag on
  // nearly every day, which doesn't match how a pilot actually reads that
  // number.
  const freezingPrecip = input.iceAccumulationMm != null && input.iceAccumulationMm > 0;
  items.push({
    key: "precipitation",
    label: "Precipitation",
    value: input.precipChance != null ? `${Math.round(input.precipChance)}%${freezingPrecip ? " (freezing)" : ""}` : null,
    tier: freezingPrecip ? "RED" : tierFromBands(input.precipChance, (v) => v < precipYellowPct, (v) => v < precipRedPct),
    critical: true,
  });

  // 11. TAF trend - critical when it fires: a TS/freezing precip/LLWS mention
  // in the raw TAF is a specific forecaster-flagged hazard, not a vague signal
  items.push({
    key: "tafTrend",
    label: "TAF trend",
    value: input.tafHazard ? "hazard mentioned" : (input.tafVolatile ? "changing" : null),
    tier: input.tafHazard ? "RED" : input.tafVolatile ? "YELLOW" : (input.tafKnown ? "GREEN" : "NA"),
    critical: true,
  });

  // 12. Turbulence - now backed by real AIRMET/SIGMET polygon data (see
  // lib/hazards.js) instead of being a permanent N/A. Critical when active.
  items.push({
    key: "turbulence",
    label: "Turbulence",
    value: input.hazardsChecked ? (input.turbulenceHazard ? "AIRMET/SIGMET active" : "none active") : null,
    tier: !input.hazardsChecked ? "NA" : input.turbulenceHazard ? "RED" : "GREEN",
    critical: true,
  });

  // 13. PIREP ride reports - still no free feed with proximity matching wired up
  items.push({ key: "pireps", label: "PIREP ride reports", value: null, tier: "NA", critical: false });

  // 14. Icing - freezing precip (from gridpoint ice accumulation) OR an
  // active icing AIRMET/SIGMET over the airport, whichever is worse.
  const icingHazard = !!input.icingHazard;
  items.push({
    key: "icing",
    label: "Icing",
    value: freezingPrecip
      ? "freezing precip forecast"
      : icingHazard
        ? "AIRMET/SIGMET active"
        : input.hazardsChecked || input.iceAccumulationMm != null
          ? "none active"
          : null,
    tier: freezingPrecip || icingHazard ? "RED" : (input.hazardsChecked || input.iceAccumulationMm != null ? "GREEN" : "NA"),
    critical: true,
  });

  // 15. Convection - a real convective SIGMET over the airport is the
  // strongest signal; falls back to the precip-chance/lightning-level proxy
  // only when hazard data wasn't available at all.
  const lal = input.lightningActivityLevel;
  const convectiveHazard = !!input.convectiveHazard;
  let convectionTier;
  let convectionValue;
  if (convectiveHazard) {
    convectionTier = "RED";
    convectionValue = "Convective SIGMET active";
  } else if (input.hazardsChecked) {
    // Hazard data is available and clean for this point - trust it over the
    // coarse precip-chance proxy, which otherwise flags routine forecasts.
    convectionTier = freezingPrecip ? "RED" : "GREEN";
    convectionValue = "no convective SIGMET active";
  } else if (input.precipChance != null || lal != null) {
    if (freezingPrecip || (lal != null && lal >= 4) || (input.precipChance != null && input.precipChance > precipRedPct)) {
      convectionTier = "RED";
    } else if ((lal != null && lal >= 2) || (input.precipChance != null && input.precipChance >= precipYellowPct)) {
      convectionTier = "YELLOW";
    } else {
      convectionTier = "GREEN";
    }
    convectionValue = lal != null ? `LAL ${lal}` : null;
  } else {
    convectionTier = "NA";
    convectionValue = null;
  }
  items.push({ key: "convection", label: "Convection", value: convectionValue, tier: convectionTier, critical: true });

  // 16. Winds aloft - a different product (e.g. FB winds/temps aloft), not fetched here
  items.push({ key: "windsAloft", label: "Winds aloft", value: null, tier: "NA", critical: false });

  return items;
}

// Combines all the checklist rows into one overall tier. This is
// deliberately NOT a simple "worst item wins" - a single stray Red or
// Yellow among a sea of Green shouldn't be enough to call the whole hour
// Bad, if it's genuinely just one soft signal. But some things really are
// go/no-go on their own regardless of how nice everything else looks - a
// low ceiling, poor visibility, an approaching low, freezing precip, an
// active AIRMET/SIGMET, a TAF-flagged hazard, or a crosswind beyond every
// runway don't get "averaged out" by good wind and pressure elsewhere.
export function overallTier(items) {
  const known = items.filter((i) => i.tier !== "NA");
  if (!known.length) return "NA";

  const reds = known.filter((i) => i.tier === "RED");
  const yellows = known.filter((i) => i.tier === "YELLOW");
  const criticalRed = reds.some((i) => i.critical);
  const criticalYellow = yellows.some((i) => i.critical);

  if (criticalRed) return "RED";
  if (reds.length >= 2) return "RED"; // multiple independent problems add up, even if none is individually critical
  if (yellows.length >= 4) return "RED"; // several cautions stacking up reads the same as one real problem
  if (reds.length >= 1 || criticalYellow || yellows.length >= 2) return "YELLOW";
  return "GREEN"; // zero reds, and at most one soft (non-critical) yellow
}

export const TIER_TO_LABEL = { GREEN: "GOOD", YELLOW: "MARGINAL", RED: "BAD", NA: "UNKNOWN" };
