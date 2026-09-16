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

  // 6. Temp / dew point spread (fog and stability risk) - contributing signal
  items.push({
    key: "dewpointSpread",
    label: "Dew point spread",
    value: input.dewpointSpreadC != null ? `${input.dewpointSpreadC.toFixed(1)} °C` : null,
    tier: tierFromBands(input.dewpointSpreadC, (v) => v >= dewpointSpreadGreenC, (v) => v >= dewpointSpreadYellowC),
    critical: false,
  });

  // 7. Pressure pattern - critical: an approaching low or tight gradient is
  // a real weather-system-level concern, not something good wind offsets
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
    critical: true,
  });

  // 8. Fronts - no simple free feed for actual front position
  items.push({ key: "fronts", label: "Fronts nearby", value: null, tier: "NA", critical: false });

  // 9. Cloud type / vertical development - sky cover % doesn't tell you TCU vs stratus
  items.push({ key: "cloudType", label: "Cloud type", value: null, tier: "NA", critical: false });

  // 10. Precipitation - critical: freezing precip especially is a hard stop
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

  // 12-14. No free real-time feed for these without parsing G-AIRMET/SIGMET/PIREP geometry
  items.push({ key: "turbulence", label: "Turbulence", value: null, tier: "NA", critical: false });
  items.push({ key: "pireps", label: "PIREP ride reports", value: null, tier: "NA", critical: false });
  items.push({
    key: "icing",
    label: "Icing (freezing precip only)",
    value: freezingPrecip ? "freezing precip forecast" : null,
    tier: freezingPrecip ? "RED" : (input.iceAccumulationMm != null ? "GREEN" : "NA"),
    critical: true,
  });

  // 15. Convection - critical when it fires: this is standing in for actual
  // thunderstorm/SIGMET-level risk, not routine shower chances
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
    critical: true,
  });

  // 16. Winds aloft - a different product (e.g. FB winds/temps aloft), not fetched here
  items.push({ key: "windsAloft", label: "Winds aloft", value: null, tier: "NA", critical: false });

  return items;
}

// Combines all the checklist rows into one overall tier. This is
// deliberately NOT a simple "worst item wins" - a single stray Red or
// Yellow among a sea of Green shouldn't be enough to call the whole hour
// Bad, if it's genuinely just one soft signal. But some things really are
// go/no-go on their own regardless of how nice everything else looks - a
// low ceiling, poor visibility, an approaching low, freezing precip, a
// TAF-flagged hazard, or a crosswind beyond every runway don't get
// "averaged out" by good wind and pressure elsewhere.
export function overallTier(items) {
  const known = items.filter((i) => i.tier !== "NA");
  if (!known.length) return "NA";

  const reds = known.filter((i) => i.tier === "RED");
  const yellows = known.filter((i) => i.tier === "YELLOW");
  const criticalRed = reds.some((i) => i.critical);

  if (criticalRed) return "RED";
  if (reds.length >= 2) return "RED"; // multiple independent problems add up, even if none is individually critical
  if (yellows.length >= 4) return "RED"; // several cautions stacking up reads the same as one real problem
  if (reds.length >= 1 || yellows.length >= 1) return "YELLOW";
  return "GREEN";
}

export const TIER_TO_LABEL = { GREEN: "GOOD", YELLOW: "MARGINAL", RED: "BAD", NA: "UNKNOWN" };
