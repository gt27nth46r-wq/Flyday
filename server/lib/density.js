// Standard pilot's density-altitude approximation:
//   pressure altitude = field elevation + (29.92 - altimeter setting) * 1000
//   ISA temp at that pressure altitude = 15C - 2C per 1000ft
//   density altitude = pressure altitude + 120 * (actual OAT - ISA temp)
//
// Good enough for planning purposes; not a POH-grade calculation.
export function densityAltitudeFt(elevationFt, pressureHpa, tempC) {
  if (elevationFt == null || pressureHpa == null || tempC == null) return null;

  const altimeterInHg = pressureHpa * 0.0295299830714;
  const pressureAltitudeFt = elevationFt + (29.92 - altimeterInHg) * 1000;
  const isaTempC = 15 - 2 * (pressureAltitudeFt / 1000);
  const densityAltFt = pressureAltitudeFt + 120 * (tempC - isaTempC);

  return Math.round(densityAltFt / 50) * 50; // round to nearest 50ft
}
