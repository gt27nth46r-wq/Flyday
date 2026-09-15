// Core rule, as specified: a day is a GOOD flying day when
//   1) there's a high pressure system over the area (avg pressure >= threshold), and
//   2) winds are under the wind threshold (default 10 kt)
// One of the two -> MARGINAL. Neither -> BAD. No data -> UNKNOWN.
//
// On top of that, ceiling/visibility act as a safety gate: no matter how
// nice the pressure and wind look, a day with a low ceiling or poor
// visibility can't be called GOOD, and a day at or below basic VFR minimums
// is capped at BAD. This only pulls ratings down - it never turns a
// pressure/wind BAD day into something better.
//
// All four thresholds are tunable per request; defaults live in server.js.
export function rateDay(day, opts) {
  const {
    windThresholdKt,
    pressureThresholdHpa,
    ceilingThresholdFt = 3000,
    visibilityThresholdSm = 5,
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
  } else if (label === "GOOD" && (ceilingGood === false || visibilityGood === false)) {
    label = "MARGINAL";
  }

  return { label, pressureGood, windGood, ceilingGood, visibilityGood };
}

// Worst-case crosswind component for a runway, given an hour's wind.
// Runway heading and wind direction should be in the same reference
// (both true, or both magnetic) - Flyday uses true throughout.
export function crosswindComponentKt(windSpeedKt, windDirDeg, runwayHeadingDeg) {
  if (windSpeedKt == null || windDirDeg == null || runwayHeadingDeg == null) return null;
  const angleDiffRad = ((windDirDeg - runwayHeadingDeg) * Math.PI) / 180;
  return Math.abs(windSpeedKt * Math.sin(angleDiffRad));
}
