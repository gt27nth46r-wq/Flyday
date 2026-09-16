import { HttpError } from "./geo.js";

const AWC_BASE = "https://aviationweather.gov/api/data";

// aviationweather.gov's combined domestic AIRMET/SIGMET feed - includes
// convective SIGMETs too (they show up with hazard: "CONVECTIVE"), so one
// fetch covers all three of what was asked for. Same Data API family as
// metar/taf/notam.
export async function fetchAirSigmets(userAgent) {
  const url = `${AWC_BASE}/airsigmet?format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new HttpError(502, `aviationweather.gov airsigmet request failed (${res.status})`);
  }
  const text = await res.text();
  if (!text) return [];
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [data];
}

// Geometry comes back as WKT ("POLYGON((lon lat, lon lat, ...))"), not
// GeoJSON - this is a minimal parser for just that one shape, not a general
// WKT library. Falls back to null (skip the record) on anything unexpected.
function parseWktPolygon(wkt) {
  if (typeof wkt !== "string") return null;
  const match = wkt.match(/POLYGON\s*\(\(([^)]+)\)\)/i);
  if (!match) return null;
  return match[1]
    .split(",")
    .map((pair) => pair.trim().split(/\s+/).map(Number))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

// Standard ray-casting point-in-polygon test. `polygon` is [[lon,lat], ...].
function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000; // seconds vs ms
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Returns which hazard categories currently have an active AIRMET/SIGMET
// polygon covering this point. Never throws - a failed or empty fetch just
// means every category comes back false, and the caller marks the relevant
// checklist rows NA rather than guessing.
export function activeHazardsAtPoint(airSigmets, lat, lon, atMs = Date.now()) {
  const active = {
    icing: false,
    turbulence: false,
    convective: false,
    ifrOrObscuration: false,
    checked: true,
  };

  for (const item of airSigmets) {
    const from = toEpochMs(item.validTimeFrom);
    const to = toEpochMs(item.validTimeTo);
    if (from != null && atMs < from) continue;
    if (to != null && atMs > to) continue;

    const polygon = parseWktPolygon(item.geometry ?? item.coords);
    if (!polygon || polygon.length < 3) continue;
    if (!pointInPolygon(lat, lon, polygon)) continue;

    const hazard = String(item.hazard || "").toUpperCase();
    if (hazard.includes("ICE")) active.icing = true;
    else if (hazard.includes("TURB")) active.turbulence = true;
    else if (hazard.includes("CONVECTIVE") || hazard.includes("TS")) active.convective = true;
    else if (hazard.includes("IFR") || hazard.includes("MTN OBSC") || hazard.includes("OBSC")) active.ifrOrObscuration = true;
  }

  return active;
}
