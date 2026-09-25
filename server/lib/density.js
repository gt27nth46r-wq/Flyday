// Standard pilot's density-altitude approximation:
//   pressure altitude = field elevation + (29.92 - altimeter setting) * 1000
//   ISA temp at that pressure altitude = 15C - 2C per 1000ft
//   density altitude = pressure altitude + 120 * (actual OAT - ISA temp)
//
// Good enough for planning purposes; not a POH-grade calculation. Expects
// pressureHpa to already be an altimeter setting (sea-level-equivalent) -
// see stationPressureToAltimeterHpa() below if starting from raw station
// pressure, e.g. the NWS gridpoint "pressure" element.
//
// Sanity-bounded: if any input is garbage (NaN, a bad elevation from a data
// glitch, etc.), this returns null instead of an absurd number - a real
// density altitude essentially never falls outside roughly -3,000 to
// +25,000ft, even at extreme hot/high combinations.
export function densityAltitudeFt(elevationFt, pressureHpa, tempC) {
  if (!Number.isFinite(elevationFt) || !Number.isFinite(pressureHpa) || !Number.isFinite(tempC)) return null;
  if (elevationFt < -1500 || elevationFt > 20000) return null; // covers below-sea-level fields through the world's highest airports

  const altimeterInHg = pressureHpa * 0.0295299830714;
  if (altimeterInHg < 24 || altimeterInHg > 33) return null; // real-world altimeter settings essentially never leave ~25.7-32.1"

  const pressureAltitudeFt = elevationFt + (29.92 - altimeterInHg) * 1000;
  const isaTempC = 15 - 2 * (pressureAltitudeFt / 1000);
  const densityAltFt = pressureAltitudeFt + 120 * (tempC - isaTempC);
  if (densityAltFt < -3000 || densityAltFt > 25000) return null;

  return Math.round(densityAltFt / 50) * 50; // round to nearest 50ft
}

// Standard ICAO altimeter-setting (QNH) formula - converts raw station
// pressure (the pressure actually measured at the field's elevation) to its
// sea-level equivalent, using elevation alone (no temperature needed, unlike
// a full sea-level-pressure reduction). This is the same conversion an
// altimeter itself does, and the inverse of the standard
// altimeter-to-station-pressure formula.
//
// NWS's gridpoint "pressure" element is raw station pressure, not sea-level
// pressure - at any airport with meaningful elevation, using it directly
// against a "high pressure = 1015+ hPa" threshold is comparing the wrong
// thing (station pressure is always lower than sea-level pressure, by
// roughly 1 hPa per 8-9m of elevation). This correction is what makes "high
// pressure" mean the same thing at a mountain airport as at a coastal one.
//
// Sanity-bounded: a bad elevation or pressure reading (a data glitch, a
// unit mismatch, etc.) shouldn't silently produce a wildly wrong "corrected"
// pressure - if the inputs or the result fall outside a physically
// reasonable range, this returns the original uncorrected value rather than
// compounding the error.
export function stationPressureToAltimeterHpa(stationPressureHpa, elevationFt) {
  if (!Number.isFinite(stationPressureHpa) || !Number.isFinite(elevationFt)) return stationPressureHpa ?? null;
  if (elevationFt < -1500 || elevationFt > 20000) return stationPressureHpa; // clearly bad elevation - don't compound it

  const stationPressureInHg = stationPressureHpa / 33.8639;
  const altimeterInHg = stationPressureInHg / Math.pow(1 - 6.8754e-6 * elevationFt, 5.2559);
  if (!Number.isFinite(altimeterInHg) || altimeterInHg < 20 || altimeterInHg > 36) return stationPressureHpa;

  return altimeterInHg * 33.8639;
}

