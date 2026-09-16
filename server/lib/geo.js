// Resolves an ICAO/FAA identifier to a lat/lon (via aviationweather.gov),
// then resolves that lat/lon to an NWS forecast gridpoint (via api.weather.gov).
// Both upstreams get hit server-side, so browser CORS restrictions never apply.

const AWC_BASE = "https://aviationweather.gov/api/data";
const NWS_BASE = "https://api.weather.gov";

async function fetchStationInfo(icao, userAgent) {
  const url = `${AWC_BASE}/stationinfo?ids=${encodeURIComponent(icao)}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new HttpError(502, `aviationweather.gov stationinfo lookup failed (${res.status})`);
  }
  const data = await res.json();
  const station = Array.isArray(data) ? data[0] : data;
  return station ?? null;
}

export async function lookupStation(icao, userAgent) {
  let station = await fetchStationInfo(icao, userAgent);

  // aviationweather.gov is keyed by ICAO identifiers, which for the
  // continental US always have a "K" prefix (KSQL, not SQL) - a lot of
  // small GA fields are more commonly known by their bare 3-character FAA
  // identifier. If a 3-character input comes up empty, try it again with
  // "K" prepended before giving up. This doesn't help identifiers that use
  // a different prefix (Alaska/Hawaii/territories, other countries), but
  // it covers the most common case.
  if (!station && icao.length === 3) {
    station = await fetchStationInfo(`K${icao}`, userAgent);
  }

  if (!station) {
    throw new HttpError(404, `No station found for "${icao}". Try the ICAO code (e.g. KPAO instead of PAO) if this is a US airport, or double-check the identifier for other countries.`);
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

function haversineNm(lat1, lon1, lat2, lon2) {
  const R_NM = 3440.065;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Finds the closest station with a current METAR when the requested airport
// doesn't report weather itself (common at small non-towered fields with no
// ASOS/AWOS). Searches a bounding box around the airport and picks the
// nearest hit. This is a fallback path, not the primary lookup, so any
// failure here just means "no substitute found" rather than a broken request.
const SEARCH_RADIUS_DEG = 0.6; // roughly 35-40nm depending on latitude
export async function findNearestReportingStation(icao, lat, lon, userAgent) {
  try {
    const box = [lat - SEARCH_RADIUS_DEG, lon - SEARCH_RADIUS_DEG, lat + SEARCH_RADIUS_DEG, lon + SEARCH_RADIUS_DEG];
    const url = `https://aviationweather.gov/api/data/metar?bbox=${box.join(",")}&format=json`;
    const res = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
    if (!res.ok) return null;

    const text = await res.text();
    if (!text) return null;
    const stations = JSON.parse(text);
    if (!Array.isArray(stations) || !stations.length) return null;

    let nearest = null;
    for (const s of stations) {
      const sIcao = s.icaoId ?? s.station_id;
      const sLat = s.lat ?? s.latitude;
      const sLon = s.lon ?? s.longitude;
      if (!sIcao || sIcao === icao || sLat == null || sLon == null) continue;

      const distanceNm = haversineNm(lat, lon, sLat, sLon);
      if (!nearest || distanceNm < nearest.distanceNm) {
        nearest = { icao: sIcao, distanceNm };
      }
    }
    return nearest;
  } catch {
    return null; // fail open - the caller just proceeds without a substitute
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
