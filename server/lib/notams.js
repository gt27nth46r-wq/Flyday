import { HttpError } from "./geo.js";

const AWC_BASE = "https://aviationweather.gov/api/data";

// aviationweather.gov's NOTAM API - same Data API family as metar/taf, which
// have worked reliably elsewhere in this app. NOTAM JSON field names aren't
// as thoroughly documented as METAR/TAF's, so this reads several plausible
// field names defensively rather than betting on one.
export async function fetchNotams(icao, userAgent) {
  const url = `${AWC_BASE}/notam?ids=${encodeURIComponent(icao)}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new HttpError(502, `aviationweather.gov NOTAM request failed (${res.status})`);
  }
  const text = await res.text();
  if (!text) return [];
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : [data];

  return list
    .map((n) => n.icaoMessage || n.traditionalMessage || n.text || n.rawText || n.notamText || "")
    .filter(Boolean);
}

// Scans NOTAM text for runway-closure phrasing (e.g. "RWY 13/31 CLSD") and
// returns the set of individual runway idents (e.g. "13", "31") mentioned as
// closed. This is a plain-text keyword scan, not a parse of NOTAM Q-codes or
// effective date ranges - it can't tell a currently-active closure from one
// that already expired or hasn't started yet. Treat it as a prompt to go
// check the actual NOTAM, not as the final word.
const CLOSURE_PATTERN = /RWY\s+([\d]{2}[LRC]?(?:\/[\d]{2}[LRC]?)?)\s+(?:CLSD|CLOSED)/gi;

export function findClosedRunwayIdents(notamTexts) {
  const closed = new Set();
  for (const text of notamTexts) {
    for (const match of text.matchAll(CLOSURE_PATTERN)) {
      for (const ident of match[1].split("/")) closed.add(ident);
    }
  }
  return closed;
}
