// Sunrise/sunset for a given date and lat/lon, computed locally - no API call
// needed. This is the standard solar-position algorithm (the same math behind
// most sunrise/sunset libraries), accurate to within a minute or two, which
// is plenty for shading a day/night band on an hourly strip.
const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

function toJulian(date) {
  return date.valueOf() / DAY_MS - 0.5 + J1970;
}
function fromJulian(j) {
  return new Date((j + 0.5 - J1970) * DAY_MS);
}
function toDays(date) {
  return toJulian(date) - J2000;
}
function declination(l) {
  return Math.asin(Math.sin(l) * Math.sin(OBLIQUITY));
}
function solarMeanAnomaly(d) {
  return RAD * (357.5291 + 0.98560028 * d);
}
function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372;
  return M + C + P + Math.PI;
}
function julianCycle(d, lw) {
  return Math.round(d - 0.0009 - lw / (2 * Math.PI));
}
function approxTransit(Ht, lw, n) {
  return 0.0009 + (Ht + lw) / (2 * Math.PI) + n;
}
function solarTransitJ(ds, M, L) {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}
function hourAngle(h, phi, d) {
  return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));
}

// Returns { sunrise, sunset } as JS Dates (UTC instants), or nulls for
// polar day/night where the sun doesn't rise or set that day.
export function sunTimes(date, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const Jnoon = solarTransitJ(ds, M, L);

  const h0 = -0.833 * RAD; // standard altitude accounting for atmospheric refraction
  const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));

  if (cosH > 1) return { sunrise: null, sunset: null }; // sun never rises
  if (cosH < -1) return { sunrise: null, sunset: null, alwaysUp: true }; // sun never sets

  const w = hourAngle(h0, phi, dec);
  const a = approxTransit(w, lw, n);
  const Jset = solarTransitJ(a, M, L);
  const Jrise = Jnoon - (Jset - Jnoon);

  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) };
}
