// Estimates convective cloud base (the lifted condensation level, LCL) from
// surface temperature and dew point - the classic "spread method" pilots are
// taught, and it's a genuine adiabatic-process calculation: rising air cools
// at the dry adiabatic lapse rate (~3°C/1000ft) while its dew point falls at
// a much shallower rate (~0.5°C/1000ft), so the two converge at roughly
// 2.5°C per 1000ft - about 400ft of cloud-base height per °C of surface
// temp/dew point spread.
//
// This estimates where cumulus bases are likely to form given today's
// heating, which is a different (and earlier-warning) signal than the
// forecast ceiling itself - useful for spotting an afternoon that looks
// clear on paper but has a lot of convective potential building underneath.
export function estimateCloudBaseFt(tempC, dewpointC) {
  if (tempC == null || dewpointC == null) return null;
  const spread = tempC - dewpointC;
  if (spread <= 0) return 0; // saturated air - clouds/fog already at the surface
  return Math.round(spread * 400);
}
