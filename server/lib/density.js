// Standard pilot's density-altitude approximation:
//   pressure altitude = field elevation + (29.92 - altimeter setting) * 1000
//   ISA temp at that pressure altitude = 15C - 2C per 1000ft
//   density altitude = pressure altitude + 120 * (actual OAT - ISA temp)
//
// Good enough for planning purposes; not a POH-grade calculation. Expects
// pressureHpa to already be an altimeter setting (sea-level-equivalent) -
// see stationPressureToAltimeterHpa() below if starting from raw station
// pressure, e.g. the NWS gridpoint "pressure" element.
export function densityAltitudeFt(elevationFt, pressureHpa, tempC) {
  if (elevationFt == null || pressureHpa == null || tempC == null) return null;

  const altimeterInHg = pressureHpa * 0.0295299830714;
  const pressureAltitudeFt = elevationFt + (29.92 - altimeterInHg) * 1000;
  const isaTempC = 15 - 2 * (pressureAltitudeFt / 1000);
  const densityAltFt = pressureAltitudeFt + 120 * (tempC - isaTempC);

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
export function stationPressureToAltimeterHpa(stationPressureHpa, elevationFt) {
  if (stationPressureHpa == null || elevationFt == null) return stationPressureHpa;
  const stationPressureInHg = stationPressureHpa / 33.8639;
  const altimeterInHg = stationPressureInHg / Math.pow(1 - 6.8754e-6 * elevationFt, 5.2559);
  return altimeterInHg * 33.8639;
}

