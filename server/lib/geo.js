// Resolves an ICAO/FAA identifier to a lat/lon (via aviationweather.gov),
// then resolves that lat/lon to an NWS forecast gridpoint (via api.weather.gov).
// Both upstreams get hit server-side, so browser CORS restrictions never apply.

const AWC_BASE = "https://aviationweather.gov/api/data";
const NWS_BASE = "https://api.weather.gov";

export async function lookupStation(icao, userAgent) {
  const url = `${AWC_BASE}/stationinfo?ids=${encodeURIComponent(icao)}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });

  if (!res.ok) {
    throw new HttpError(502, `aviationweather.gov stationinfo lookup failed (${res.status})`);
  }

  const data = await res.json();
  const station = Array.isArray(data) ? data[0] : data;

  if (!station) {
    throw new HttpError(404, `No station found for "${icao}". Try the 4-letter ICAO code, e.g. KPAO.`);
  }

  const lat = station.lat ?? station.latitude;
  const lon = station.lon ?? station.longitude;

  if (lat == null || lon == null) {
    throw new HttpError(502, `Station data for "${icao}" did not include coordinates.`);
  }

  // aviationweather.gov's station database reports elevation in meters.
  const elevM = station.elev ?? station.elevation ?? null;

  return {
    icao: station.icaoId ?? icao.toUpperCase(),
    name: station.site ?? station.name ?? icao.toUpperCase(),
    state: station.state ?? null,
    lat,
    lon,
    elevationFt: elevM != null ? Math.round(elevM * 3.28084) : null,
  };
}

export async function resolveGridPoint(lat, lon, userAgent) {
  const url = `${NWS_BASE}/points/${lat},${lon}`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/geo+json" },
  });

  if (!res.ok) {
    throw new HttpError(502, `api.weather.gov point lookup failed (${res.status})`);
  }

  const data = await res.json();
  const props = data.properties;

  return {
    gridId: props.gridId,
    gridX: props.gridX,
    gridY: props.gridY,
    timeZone: props.timeZone,
    forecastGridDataUrl: props.forecastGridData,
    relativeLocation: props.relativeLocation?.properties?.city
      ? `${props.relativeLocation.properties.city}, ${props.relativeLocation.properties.state}`
      : null,
  };
}

// A neighboring gridpoint used only to estimate how tightly packed the
// isobars are (a real pressure-gradient reading needs two points). Offsetting
// by a single grid cell (~2.5km) is too close - at that spacing, ordinary
// model interpolation noise gets amplified 40x once scaled to hPa/100km and
// swamps any real signal. Offsetting further (~50km) trades a little
// directional specificity for a gradient reading that actually reflects
// mesoscale pressure pattern rather than grid noise.
const NEIGHBOR_OFFSET_CELLS = 20;
export function neighborGridPointUrl(grid) {
  return `${NWS_BASE}/gridpoints/${grid.gridId}/${grid.gridX + NEIGHBOR_OFFSET_CELLS},${grid.gridY}`;
}
export const GRID_SPACING_KM = 2.5 * NEIGHBOR_OFFSET_CELLS;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
