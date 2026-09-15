// Core rule, as specified: a day is a GOOD flying day when
//   1) there's a high pressure system over the area (avg pressure >= threshold), and
//   2) winds are under the wind threshold (default 10 kt)
// One of the two -> MARGINAL. Neither -> BAD. No data -> UNKNOWN.
//
// On top of that, several things act as a safety gate: they can only pull a
// rating down, never up.
//   - ceiling/visibility: can't be GOOD below your thresholds, drops to BAD
//     below basic VFR minimums (1,000ft / 3sm)
//   - a sharp 3-hour pressure fall (a classic sign of an approaching low) or
//     a tight pressure gradient nearby (an isobar-spacing proxy) also caps
//     the day at MARGINAL
//
// All thresholds are tunable per request; defaults live in server.js.
export function rateDay(day, opts) {
  const {
    windThresholdKt,
    pressureThresholdHpa,
    ceilingThresholdFt = 3000,
    visibilityThresholdSm = 5,
    pressureFallThresholdHpa3h = -3,
    gradientThresholdHpa100km = 6,
  } = opts;

  if (!day.hasData) {
    return { label: "UNKNOWN", pressureGood: null, windGood: null, ceilingGood: null, visibilityGood: null };
  }

  const pressureGood = day.avgPressureHpa != null ? day.avgPressureHpa >= pressureThresholdHpa : null;
  const windGood = day.maxWindKt != null ? day.maxWindKt < windThresholdKt : null;
  const ceilingGood = day.minCeilingFt != null ? day.minCeilingFt >= ceilingThresholdFt : null;
  const visibilityGood = day.minVisibilitySm != null ? day.minVisibilitySm >= visibilityThresholdSm : null;

  // Basic VFR minimums (1,000ft ceiling / 3sm vis) as a hard floor, regardless
  // of the requested thresholds - below this it isn't a flyable VFR day.
  const belowBasicVfr =
    (day.minCeilingFt != null && day.minCeilingFt < 1000) ||
    (day.minVisibilitySm != null && day.minVisibilitySm < 3);

  const lowMovingIn = day.minPressureTrendHpa3h != null && day.minPressureTrendHpa3h <= pressureFallThresholdHpa3h;
  const tightIsobars = day.maxPressureGradientHpa100km != null && day.maxPressureGradientHpa100km >= gradientThresholdHpa100km;

  let label;
  if (pressureGood == null && windGood == null) {
    label = "UNKNOWN";
  } else if (pressureGood && windGood) {
    label = "GOOD";
  } else if (pressureGood === false && windGood === false) {
    label = "BAD";
  } else {
    label = "MARGINAL";
  }

  if (belowBasicVfr) {
    label = "BAD";
  } else if (label === "GOOD" && (ceilingGood === false || visibilityGood === false || lowMovingIn || tightIsobars)) {
    label = "MARGINAL";
  }

  return { label, pressureGood, windGood, ceilingGood, visibilityGood, lowMovingIn, tightIsobars };
}

// Hour-by-hour version of the same idea, for the "best times of day" view.
// Deliberately does NOT know about runway heading - that's applied
// client-side afterward (see app.js), since runway is never sent to the
// server. Returns "GOOD" | "MARGINAL" | "BAD" | "UNKNOWN".
export function rateHour(hour, opts) {
  const {
    windThresholdKt,
    pressureThresholdHpa,
    ceilingThresholdFt = 3000,
    visibilityThresholdSm = 5,
    pressureFallThresholdHpa3h = -3,
    gradientThresholdHpa100km = 6,
  } = opts;

  if (hour.pressureHpa == null && hour.windSpeedKt == null) return "UNKNOWN";

  const belowBasicVfr =
    (hour.ceilingFt != null && hour.ceilingFt < 1000) || (hour.visibilitySm != null && hour.visibilitySm < 3);
  const tooWindy = hour.windSpeedKt != null && hour.windSpeedKt >= windThresholdKt;
  const lowMovingIn = hour.pressureTrendHpa3h != null && hour.pressureTrendHpa3h <= pressureFallThresholdHpa3h;
  const tightIsobars = hour.pressureGradientHpa100km != null && hour.pressureGradientHpa100km >= gradientThresholdHpa100km;

  if (belowBasicVfr || tooWindy || lowMovingIn || tightIsobars) return "BAD";

  const pressureGood = hour.pressureHpa != null ? hour.pressureHpa >= pressureThresholdHpa : null;
  const ceilingGood = hour.ceilingFt != null ? hour.ceilingFt >= ceilingThresholdFt : null;
  const visibilityGood = hour.visibilitySm != null ? hour.visibilitySm >= visibilityThresholdSm : null;
  const steadyOrRising = hour.pressureTrendHpa3h == null || hour.pressureTrendHpa3h > -1;

  if (pressureGood && ceilingGood !== false && visibilityGood !== false && steadyOrRising) return "GOOD";
  return "MARGINAL";
}

// Downgrades an hour's rating based on how far the wind is off a runway's
// line (0-90 deg from the runway, since a runway is flown from either end).
// Applied client-side, after rateHour() - see app.js. Only ever makes
// things worse, per the rule as specified: more than 15 degrees off -> BAD.
export function applyRunwayAlignment(label, windDirDeg, windSpeedKt, runwayHeadingDeg) {
  if (runwayHeadingDeg == null || windDirDeg == null) return label;
  if (windSpeedKt != null && windSpeedKt < 3) return label; // direction is noisy at near-calm wind

  const raw = Math.abs(((windDirDeg - runwayHeadingDeg) % 180 + 180) % 180);
  const angleOffRunway = raw > 90 ? 180 - raw : raw;

  if (angleOffRunway > 15) return "BAD";
  return label;
}

// Worst-case crosswind component for a runway, given an hour's wind.
// Runway heading and wind direction should be in the same reference
// (both true, or both magnetic) - Flyday uses true throughout.
export function crosswindComponentKt(windSpeedKt, windDirDeg, runwayHeadingDeg) {
  if (windSpeedKt == null || windDirDeg == null || runwayHeadingDeg == null) return null;
  const angleDiffRad = ((windDirDeg - runwayHeadingDeg) * Math.PI) / 180;
  return Math.abs(windSpeedKt * Math.sin(angleDiffRad));
}
