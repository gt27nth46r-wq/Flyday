// Mirrors the rows of a standard GA "good flying weather" checklist
// (surface wind, gust spread, visibility, ceiling, dew point spread,
// pressure pattern, precipitation, etc.), each scored GREEN / YELLOW / RED.
//
// A few rows on a real checklist - turbulence, icing aloft, PIREPs, winds
// aloft, actual front position, cloud type/vertical development - have no
// simple free real-time data source Flyday can reach. Rather than fabricate
// a value for those, they're returned with tier "NA" so the UI can say so
// plainly. A safety-relevant tool being wrong about "not knowing" something
// is worse than it just saying so.
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
    crosswindGreenKt = 8,
    crosswindYellowKt = 12,
    personalCrosswindLimitKt = 15,
    visibilityGreenSm = 10,
    visibilityYellowSm = 5,
    ceilingGreenFt = 5000,
    ceilingYellowFt = 3000,
    dewpointSpreadGreenC = 8,
    dewpointSpreadYellowC = 4,
    pressureThresholdHpa,
    precipYellowPct = 20,
    precipRedPct = 50,
  } = opts;

  const items = [];

  // 1. Surface wind
  items.push({
    key: "wind",
    label: "Surface wind",
    value: input.windSpeedKt != null ? `${Math.round(input.windSpeedKt)} kt` : null,
    tier: tierFromBands(input.windSpeedKt, (v) => v <= windThresholdKt, (v) => v <= windThresholdKt + 5),
  });

  // 2. Gust spread (gust minus steady wind)
  const gustSpread = input.windGustKt != null && input.windSpeedKt != null
    ? Math.max(0, input.windGustKt - input.windSpeedKt)
    : (input.windSpeedKt != null ? 0 : null); // no gust reported = no spread
  items.push({
    key: "gustSpread",
    label: "Gust spread",
    value: gustSpread != null ? `${Math.round(gustSpread)} kt` : null,
    tier: tierFromBands(gustSpread, (v) => v < gustSpreadYellowKt, (v) => v <= gustSpreadRedKt),
  });

  // 3. Crosswind - only known client-side (needs runway heading), so the
  // server always returns NA here; app.js overwrites this one row after
  // computing it locally, using personalCrosswindLimitKt from the same opts.
  items.push({
    key: "crosswind",
    label: "Crosswind (needs runway)",
    value: null,
    tier: "NA",
  });

  // 4. Visibility
  items.push({
    key: "visibility",
    label: "Visibility",
    value: input.visibilitySm != null ? `${input.visibilitySm.toFixed(1)} sm` : null,
    tier: tierFromBands(input.visibilitySm, (v) => v >= visibilityGreenSm, (v) => v >= visibilityYellowSm),
  });

  // 5. Ceiling
  items.push({
    key: "ceiling",
    label: "Ceiling",
    value: input.ceilingFt != null ? `${Math.round(input.ceilingFt)} ft` : "unlimited",
    tier: input.ceilingFt == null ? "GREEN" : tierFromBands(input.ceilingFt, (v) => v >= ceilingGreenFt, (v) => v >= ceilingYellowFt),
  });

  // 6. Temp / dew point spread (fog and stability risk)
  items.push({
    key: "dewpointSpread",
    label: "Dew point spread",
    value: input.dewpointSpreadC != null ? `${input.dewpointSpreadC.toFixed(1)} °C` : null,
    tier: tierFromBands(input.dewpointSpreadC, (v) => v >= dewpointSpreadGreenC, (v) => v >= dewpointSpreadYellowC),
  });

  // 7. Pressure pattern (high + weak gradient vs transitioning vs strong low/tight gradient)
  const pressureGood = input.pressureHpa != null ? input.pressureHpa >= pressureThresholdHpa : null;
  const lowMovingIn = input.pressureTrendHpa3h != null && input.pressureTrendHpa3h <= opts.pressureFallThresholdHpa3h;
  const tightIsobars = input.pressureGradientHpa100km != null && input.pressureGradientHpa100km >= opts.gradientThresholdHpa100km;
  let pressureTier = "NA";
  if (pressureGood != null || lowMovingIn || tightIsobars) {
    if (lowMovingIn || tightIsobars) pressureTier = "RED";
    else if (pressureGood) pressureTier = "GREEN";
    else pressureTier = "YELLOW";
  }
  items.push({
    key: "pressurePattern",
    label: "Pressure pattern",
    value: input.pressureHpa != null ? `${Math.round(input.pressureHpa)} hPa${lowMovingIn ? ", falling" : ""}${tightIsobars ? ", tight gradient" : ""}` : null,
    tier: pressureTier,
  });

  // 8. Fronts - no simple free feed for actual front position
  items.push({ key: "fronts", label: "Fronts nearby", value: null, tier: "NA" });

  // 9. Cloud type / vertical development - sky cover % doesn't tell you TCU vs stratus
  items.push({ key: "cloudType", label: "Cloud type", value: null, tier: "NA" });

  // 10. Precipitation (probability, plus a freezing-precip override from ice accumulation)
  const freezingPrecip = input.iceAccumulationMm != null && input.iceAccumulationMm > 0;
  items.push({
    key: "precipitation",
    label: "Precipitation",
    value: input.precipChance != null ? `${Math.round(input.precipChance)}%${freezingPrecip ? " (freezing)" : ""}` : null,
    tier: freezingPrecip ? "RED" : tierFromBands(input.precipChance, (v) => v < precipYellowPct, (v) => v < precipRedPct),
  });

  // 11. TAF trend - only meaningful where a TAF reaches; day-level only, see server.js
  items.push({
    key: "tafTrend",
    label: "TAF trend",
    value: input.tafHazard ? "hazard mentioned" : (input.tafVolatile ? "changing" : null),
    tier: input.tafHazard ? "RED" : input.tafVolatile ? "YELLOW" : (input.tafKnown ? "GREEN" : "NA"),
  });

  // 12-14. No free real-time feed for these without parsing G-AIRMET/SIGMET/PIREP geometry
  items.push({ key: "turbulence", label: "Turbulence", value: null, tier: "NA" });
  items.push({ key: "pireps", label: "PIREP ride reports", value: null, tier: "NA" });
  items.push({
    key: "icing",
    label: "Icing (freezing precip only)",
    value: freezingPrecip ? "freezing precip forecast" : null,
    tier: freezingPrecip ? "RED" : (input.iceAccumulationMm != null ? "GREEN" : "NA"),
  });

  // 15. Convection - precip chance + lightning activity level where an office publishes it
  const lal = input.lightningActivityLevel;
  let convectionTier = "NA";
  if (input.precipChance != null || lal != null) {
    if (freezingPrecip || (lal != null && lal >= 4) || (input.precipChance != null && input.precipChance > precipRedPct)) {
      convectionTier = "RED";
    } else if ((lal != null && lal >= 2) || (input.precipChance != null && input.precipChance >= precipYellowPct)) {
      convectionTier = "YELLOW";
    } else {
      convectionTier = "GREEN";
    }
  }
  items.push({
    key: "convection",
    label: "Convection",
    value: lal != null ? `LAL ${lal}` : null,
    tier: convectionTier,
  });

  // 16. Winds aloft - a different product (e.g. FB winds/temps aloft), not fetched here
  items.push({ key: "windsAloft", label: "Winds aloft", value: null, tier: "NA" });

  return items;
}

export function overallTier(items) {
  const known = items.filter((i) => i.tier !== "NA");
  if (!known.length) return "NA";
  const worst = Math.max(...known.map((i) => TIER_RANK[i.tier]));
  return Object.keys(TIER_RANK).find((k) => TIER_RANK[k] === worst);
}

export const TIER_TO_LABEL = { GREEN: "GOOD", YELLOW: "MARGINAL", RED: "BAD", NA: "UNKNOWN" };
