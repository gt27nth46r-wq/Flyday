// Runway/crosswind math. Runway heading is entered in the browser and never
// sent to the server (see app.js), so these are duplicated there in plain
// JS - keep the two in sync by hand if either changes.

// Worst-case crosswind component for a runway, given an hour's wind.
// Runway heading and wind direction should be in the same reference
// (both true, or both magnetic) - Flyday uses true throughout.
export function crosswindComponentKt(windSpeedKt, windDirDeg, runwayHeadingDeg) {
  if (windSpeedKt == null || windDirDeg == null || runwayHeadingDeg == null) return null;
  const angleDiffRad = ((windDirDeg - runwayHeadingDeg) * Math.PI) / 180;
  return Math.abs(windSpeedKt * Math.sin(angleDiffRad));
}

// Matches the checklist's crosswind row: GREEN under 8kt, YELLOW 8-12kt,
// RED at or above 12kt or your personal limit, whichever is lower. Also
// folds in the "more than 15 degrees off the runway line" rule as an
// automatic RED, regardless of the crosswind component itself.
export function evaluateCrosswindTier(windSpeedKt, windDirDeg, runwayHeadingDeg, opts) {
  const { crosswindGreenKt = 8, crosswindYellowKt = 12, personalCrosswindLimitKt = 15 } = opts || {};

  if (runwayHeadingDeg == null || windDirDeg == null) return { tier: "NA", value: null };
  if (windSpeedKt != null && windSpeedKt < 3) return { tier: "GREEN", value: "calm" }; // direction is noisy near-calm

  const raw = Math.abs((((windDirDeg - runwayHeadingDeg) % 180) + 180) % 180);
  const angleOffRunway = raw > 90 ? 180 - raw : raw;

  if (angleOffRunway > 15) {
    return { tier: "RED", value: `${Math.round(angleOffRunway)}° off runway` };
  }

  const crosswind = crosswindComponentKt(windSpeedKt, windDirDeg, runwayHeadingDeg);
  const redThresholdKt = Math.min(crosswindYellowKt, personalCrosswindLimitKt);
  let tier;
  if (crosswind < crosswindGreenKt) tier = "GREEN";
  else if (crosswind < redThresholdKt) tier = "YELLOW";
  else tier = "RED";

  return { tier, value: `${Math.round(crosswind)} kt` };
}
