const form = document.getElementById("search-form");
const icaoInput = document.getElementById("icao");
const windInput = document.getElementById("wind-threshold");
const pressureInput = document.getElementById("pressure-threshold");
const ceilingInput = document.getElementById("ceiling-threshold");
const visibilityInput = document.getElementById("visibility-threshold");
const pressureFallInput = document.getElementById("pressure-fall-threshold");
const gradientInput = document.getElementById("gradient-threshold");
const runwayInput = document.getElementById("runway-heading");
const favoriteBtn = document.getElementById("favorite-btn");
const favoritesEl = document.getElementById("favorites");
const statusEl = document.getElementById("status");
const currentSection = document.getElementById("current");
const daysSection = document.getElementById("days");
const routeForm = document.getElementById("route-form");
const routeIcaosInput = document.getElementById("route-icaos");
const routeStatusEl = document.getElementById("route-status");
const routeMatrixEl = document.getElementById("route-matrix");
const tripForm = document.getElementById("trip-form");
const tripDepartureInput = document.getElementById("trip-departure");
const tripArrivalInput = document.getElementById("trip-arrival");
const tripDaySelect = document.getElementById("trip-day");
const tripTimeSelect = document.getElementById("trip-time");
const tripStatusEl = document.getElementById("trip-status");
const tripResultEl = document.getElementById("trip-result");
const progchartType = document.getElementById("progchart-type");
const progchartHour = document.getElementById("progchart-hour");
const progchartRegion = document.getElementById("progchart-region");
const progchartImg = document.getElementById("progchart-img");

const WEEKDAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const TIER_RANK = { GREEN: 0, YELLOW: 1, RED: 2 };
const TIER_TO_LABEL = { GREEN: "GOOD", YELLOW: "MARGINAL", RED: "BAD", NA: "UNKNOWN" };

let lastData = null; // most recent /api/forecast response, for re-rendering when runway changes

// ---------- settings persistence ----------

function restoreSettings() {
  const saved = JSON.parse(localStorage.getItem("flyday:settings") || "{}");
  if (saved.icao) icaoInput.value = saved.icao;
  if (saved.windThreshold) windInput.value = saved.windThreshold;
  if (saved.pressureThreshold) pressureInput.value = saved.pressureThreshold;
  if (saved.ceilingThreshold) ceilingInput.value = saved.ceilingThreshold;
  if (saved.visibilityThreshold) visibilityInput.value = saved.visibilityThreshold;
  if (saved.pressureFallThreshold) pressureFallInput.value = saved.pressureFallThreshold;
  if (saved.gradientThreshold) gradientInput.value = saved.gradientThreshold;
  if (saved.runway) runwayInput.value = saved.runway;
}

function saveSettings() {
  localStorage.setItem("flyday:settings", JSON.stringify({
    icao: icaoInput.value.trim().toUpperCase(),
    windThreshold: windInput.value,
    pressureThreshold: pressureInput.value,
    ceilingThreshold: ceilingInput.value,
    visibilityThreshold: visibilityInput.value,
    pressureFallThreshold: pressureFallInput.value,
    gradientThreshold: gradientInput.value,
    runway: runwayInput.value,
  }));
}

function getFavorites() {
  return JSON.parse(localStorage.getItem("flyday:favorites") || "[]");
}
function setFavorites(list) {
  localStorage.setItem("flyday:favorites", JSON.stringify(list));
}

function renderFavorites() {
  const favorites = getFavorites();
  favoritesEl.innerHTML = "";
  favoritesEl.classList.toggle("hidden", favorites.length === 0);

  for (const icao of favorites) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.innerHTML = `${icao}<span class="remove" data-icao="${icao}">×</span>`;
    chip.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) {
        e.stopPropagation();
        setFavorites(getFavorites().filter((f) => f !== icao));
        renderFavorites();
        return;
      }
      icaoInput.value = icao;
      loadForecast();
    });
    favoritesEl.appendChild(chip);
  }

  const current = icaoInput.value.trim().toUpperCase();
  favoriteBtn.classList.toggle("active", favorites.includes(current));
  favoriteBtn.textContent = favorites.includes(current) ? "★ Saved" : "☆ Save";
}

favoriteBtn.addEventListener("click", () => {
  const icao = icaoInput.value.trim().toUpperCase();
  if (!icao) return;
  const favorites = getFavorites();
  if (favorites.includes(icao)) {
    setFavorites(favorites.filter((f) => f !== icao));
  } else {
    setFavorites([...favorites, icao]);
  }
  renderFavorites();
});

// ---------- runway / crosswind (computed client-side, never sent to the server) ----------
// Crosswind bands, as specified: under 10kt is good, over 10kt is moderate,
// over 20kt is bad. Supports multiple runways at once and recommends the
// one with the lowest worst-case crosswind.

// Splits "13/31, 07/25" into [{ label: "13/31", headingDeg: 130 }, { label: "07/25", headingDeg: 70 }].
// Each token accepts "13/31", "13", or "090" (3 digits = heading already in degrees).
function parseRunwayList(text) {
  return String(text || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((label) => {
      const match = label.match(/\d{1,3}/);
      if (!match) return null;
      const n = Number(match[0]);
      const headingDeg = match[0].length >= 3 ? n % 360 : (n * 10) % 360;
      return { label, headingDeg };
    })
    .filter(Boolean);
}

function crosswindKt(windSpeedKt, windDirDeg, runwayHeadingDeg) {
  if (windSpeedKt == null || windDirDeg == null || runwayHeadingDeg == null) return null;
  const rad = ((windDirDeg - runwayHeadingDeg) * Math.PI) / 180;
  return Math.abs(windSpeedKt * Math.sin(rad));
}

function tierForCrosswindKt(kt) {
  if (kt < 10) return "GREEN";
  if (kt <= 20) return "YELLOW";
  return "RED";
}

// Worst-case crosswind for one runway across a set of hourly records.
function worstCrosswindForRunway(hours, runway) {
  const values = hours
    .map((h) => crosswindKt(h.windSpeedKt, h.windDirDeg, runway.headingDeg))
    .filter((v) => v != null);
  if (!values.length) return null;
  return Math.max(...values);
}

// Evaluates every entered runway against a set of hourly records (pass a
// single hour wrapped in an array for hour-level, or a whole day's hours for
// day-level) and returns each runway's crosswind + tier, plus which is best.
function evaluateRunways(hours, runways) {
  const results = runways.map((runway) => {
    const kt = worstCrosswindForRunway(hours, runway);
    return { label: runway.label, kt, tier: kt != null ? tierForCrosswindKt(kt) : "NA", closed: !!runway.closed };
  });
  // A NOTAM-closed runway is never recommended, no matter how good its crosswind looks.
  const known = results.filter((r) => r.kt != null && !r.closed);
  const best = known.length ? known.reduce((a, b) => (b.kt < a.kt ? b : a)) : null;
  return { results, best };
}

// Mirrors server/lib/checklist.js's overallTier() exactly - kept in sync by
// hand, since this file also has to recompute the overall tier after
// merging in the crosswind row. A single stray Red or Yellow among mostly
// Green items reads as Marginal, not Bad - but a critical item at Red (the
// crosswind row is marked critical, same as ceiling/visibility/etc. on the
// server) is a real go/no-go stop no matter how good everything else looks.
function overallTier(items) {
  const known = items.filter((i) => i.tier !== "NA");
  if (!known.length) return "NA";

  const reds = known.filter((i) => i.tier === "RED");
  const yellows = known.filter((i) => i.tier === "YELLOW");
  const criticalRed = reds.some((i) => i.critical);

  if (criticalRed) return "RED";
  if (reds.length >= 2) return "RED";
  if (yellows.length >= 4) return "RED";
  if (reds.length >= 1 || yellows.length >= 1) return "YELLOW";
  return "GREEN";
}

// Replaces the server's placeholder "crosswind" row (always NA server-side)
// with the best runway's crosswind, then recomputes the overall tier.
function finalizeChecklist(serverChecklist, bestRunwayResult) {
  const merged = serverChecklist.map((item) =>
    item.key === "crosswind"
      ? {
          ...item,
          label: bestRunwayResult ? `Crosswind (best: ${bestRunwayResult.label})` : "Crosswind",
          tier: bestRunwayResult ? bestRunwayResult.tier : "NA",
          value: bestRunwayResult ? `${Math.round(bestRunwayResult.kt)} kt` : null,
        }
      : item
  );
  const tier = overallTier(merged);
  return { checklist: merged, tier, label: TIER_TO_LABEL[tier] };
}

// If the runway field is empty, fall back to runways Flyday auto-detected
// for this airport from published FAA/open aviation data (true headings,
// no magnetic-variation guessing) - including which ones a NOTAM text scan
// flagged as closed. Manual entry always takes precedence and is parsed via
// the runway-number heuristic, with the usual caveat; manually-typed runways
// have no closure info, since NOTAMs are only cross-checked against detected ones.
function runwaysFromInput(detectedRunways) {
  const manual = parseRunwayList(runwayInput.value);
  if (manual.length) return manual;
  return (detectedRunways || []).map((r) => ({ label: r.id, headingDeg: r.headingTrueDeg, closed: r.closed }));
}

function runwayTableHtml(results, bestLabel) {
  if (!results.length) return "";
  const rows = results
    .map((r) => `<tr class="${r.label === bestLabel ? "best" : ""} ${r.closed ? "closed" : ""}">
      <td>${r.label}${r.label === bestLabel ? " ★" : ""}</td>
      <td>${r.closed ? "Closed (NOTAM)" : r.kt != null ? `${Math.round(r.kt)} kt` : "—"}</td>
      <td>${r.closed ? '<span class="tier-pill CLOSED">CLOSED</span>' : `<span class="tier-pill ${r.tier}">${r.tier === "NA" ? "N/A" : r.tier}</span>`}</td>
    </tr>`)
    .join("");
  return `<div class="table-scroll"><table class="runway-table">
    <thead><tr><th>Runway</th><th>Crosswind (worst)</th><th>Rating</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function buildThresholdParams() {
  return {
    windThresholdKt: windInput.value,
    pressureThresholdHpa: pressureInput.value,
    ceilingYellowFt: ceilingInput.value,
    visibilityYellowSm: visibilityInput.value,
    pressureFallThresholdHpa3h: pressureFallInput.value,
    gradientThresholdHpa100km: gradientInput.value,
  };
}

// ---------- rendering ----------

function fmt(value, digits = 0, unit = "") {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}${unit}`;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function renderCurrent(data) {
  document.getElementById("station-name").textContent =
    `${data.station.name} (${data.station.icao})`;
  const elevPart = data.station.elevationFt != null ? ` · field elevation ${data.station.elevationFt} ft` : "";
  const runwaysPart = data.station.runways?.length
    ? ` · runways ${data.station.runways.map((r) => `${r.id}${r.closed ? " (closed)" : ""}`).join(", ")} (detected - always cross-check against a current sectional/chart supplement)`
    : runwayInput.value
      ? ""
      : " · no runway data found for this airport - enter runways manually below for crosswind";
  document.getElementById("station-meta").textContent =
    (data.location ? `near ${data.location}` : "") + elevPart + runwaysPart;

  const banner = document.getElementById("notice-banner");
  const notices = [];
  if (data.weatherSubstitute) {
    notices.push(`${data.station.icao} doesn't report weather itself - showing conditions from ${data.weatherSubstitute.icao}, ${Math.round(data.weatherSubstitute.distanceNm)} nm away.`);
  }
  if (data.notamStatus === "unavailable") {
    notices.push("Couldn't check NOTAMs for runway closures right now - verify runway status yourself before choosing one.");
  } else if (data.notamStatus === "checked") {
    notices.push("Runway closures checked against current NOTAMs (automated text scan - not a substitute for reading the actual NOTAMs).");
  }
  banner.innerHTML = notices.map((n) => `<p>${n}</p>`).join("");
  banner.classList.toggle("hidden", notices.length === 0);

  const metarRow = document.getElementById("metar-row");
  metarRow.innerHTML = "";

  if (data.metar) {
    const items = [
      ["Flight category", data.metar.flightCategory
        ? `<span class="flightcat ${data.metar.flightCategory}">${data.metar.flightCategory}</span>`
        : "—", true],
      ["Wind", data.metar.windSpeedKt != null
        ? `${fmt(data.metar.windDirDeg)}° @ ${fmt(data.metar.windSpeedKt)} kt${data.metar.windGustKt ? ` G${fmt(data.metar.windGustKt)}` : ""}`
        : "—"],
      ["Ceiling", data.metar.ceilingFt != null ? `${data.metar.ceilingFt} ft` : "unlimited"],
      ["Visibility", data.metar.visibilitySm != null ? `${data.metar.visibilitySm} sm` : "—"],
      ["Altimeter", data.metar.altimeterInHg != null ? `${data.metar.altimeterInHg.toFixed(2)}"` : "—"],
    ];
    for (const [label, value, isHtml] of items) {
      const div = document.createElement("div");
      div.className = "metar-item";
      div.innerHTML = `<span class="value">${isHtml ? value : value}</span><span class="label">${label}</span>`;
      metarRow.appendChild(div);
    }
  } else {
    metarRow.innerHTML = `<p class="mono">No current METAR available.</p>`;
  }

  document.getElementById("taf-raw").textContent = data.taf?.raw || "";
  currentSection.classList.remove("hidden");
}

// A compact row of colored blocks, one per daylight hour (6am-8pm local).
// Shows all 24 hours (real sunrise/sunset shading, not a fixed 6am-8pm
// window), with time labels printed directly on the strip every few hours -
// hover tooltips don't work on a touchscreen, so the important info (time,
// day/night) has to be visible without a hover.
function hourStripHtml(hourFinals, timeZone) {
  if (!hourFinals.length) return "";
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone });
  const localHourFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone });

  const blocks = hourFinals
    .map(({ hour, label }) => {
      const localHour = Number(localHourFmt.format(new Date(hour.timeIso)));
      const t = timeFmt.format(new Date(hour.timeIso));
      const title = `${t}${hour.isDaytime === false ? " (night)" : hour.isDaytime ? " (day)" : ""}: ${label}${hour.windSpeedKt != null ? ` · ${fmt(hour.windDirDeg)}°/${fmt(hour.windSpeedKt)}kt` : ""}`;
      const showLabel = localHour % 4 === 0; // label every 4 hours - readable without crowding
      const skyClass = hour.isDaytime === false ? "night" : hour.isDaytime ? "day" : "";
      return `<div class="hour-col">
        <span class="hour-block ${label} ${skyClass}" title="${title}"></span>
        ${showLabel ? `<span class="hour-label">${t.replace(/\s?[AP]M/i, "")}</span>` : ""}
      </div>`;
    })
    .join("");
  return `<div class="hour-strip-wrap"><div class="hour-strip" aria-label="Hour by hour outlook, all 24 hours, shaded for day and night">${blocks}</div></div>`;
}

function hourlyTableHtml(hourFinals, timeZone) {
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone });
  const rows = hourFinals
    .filter(({ hour }) => hour.windSpeedKt != null || hour.ceilingFt != null)
    .map(({ hour, label }) => {
      const t = timeFmt.format(new Date(hour.timeIso));
      const sky = hour.isDaytime === false ? "🌙" : hour.isDaytime ? "☀" : "";
      return `<tr>
        <td><span class="hour-dot ${label}"></span>${sky} ${t}</td>
        <td>${fmt(hour.windDirDeg)}°/${fmt(hour.windSpeedKt)}${hour.windGustKt ? `G${fmt(hour.windGustKt)}` : ""}</td>
        <td>${hour.ceilingFt != null ? fmt(hour.ceilingFt) : "—"}</td>
        <td>${hour.visibilitySm != null ? hour.visibilitySm.toFixed(1) : "—"}</td>
        <td>${hour.pressureTrendHpa3h != null ? fmt(hour.pressureTrendHpa3h, 1) : "—"}</td>
        <td>${hour.pressureGradientHpa100km != null ? fmt(hour.pressureGradientHpa100km, 1) : "—"}</td>
      </tr>`;
    })
    .join("");
  if (!rows) return "";

  return `<details class="hourly">
    <summary>Hourly detail</summary>
    <div class="table-scroll"><table class="hourly-table">
      <thead><tr><th>Time</th><th>Wind</th><th>Ceil ft</th><th>Vis sm</th><th>Trend/3h</th><th>Gradient/100km</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </details>`;
}

function checklistTableHtml(checklist) {
  const rows = checklist
    .map((item) => `<tr>
      <td>${item.label}</td>
      <td>${item.value ?? "—"}</td>
      <td><span class="tier-pill ${item.tier}">${item.tier === "NA" ? "N/A" : item.tier}</span></td>
    </tr>`)
    .join("");

  return `<details class="checklist">
    <summary>Full checklist</summary>
    <div class="table-scroll"><table class="checklist-table">
      <thead><tr><th>Item</th><th>Worst case today</th><th>Rating</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </details>`;
}

function renderDays(data) {
  const runways = runwaysFromInput(data.station.runways);
  daysSection.innerHTML = "";

  for (const day of data.days) {
    const date = new Date(`${day.date}T12:00:00`);

    // Finalize every hour first (best-runway crosswind merged in), so the
    // day-level runway table and overall tier can both be derived from it.
    const hourFinals = day.hourly.map((hour) => {
      const { best } = evaluateRunways([hour], runways);
      const { checklist, tier, label } = finalizeChecklist(hour.checklist, best);
      return { hour, checklist, tier, label };
    });

    const dayRunways = evaluateRunways(day.hourly, runways);
    const dayFinal = finalizeChecklist(day.checklist, dayRunways.best);

    const card = document.createElement("article");
    card.className = `day-card ${dayFinal.label}`;

    card.innerHTML = `
      <div class="weekday">${WEEKDAY_FMT.format(date)}</div>
      <div class="date">${DATE_FMT.format(date)}</div>
      <div class="rating">${dayFinal.label}</div>
      ${hourStripHtml(hourFinals, data.timeZone)}
      <div class="readout"><span class="k">Pressure</span><span>${fmt(day.avgPressureHpa, 0, " hPa")}</span></div>
      <div class="readout"><span class="k">Wind (max)</span><span>${fmt(day.maxWindKt, 0, " kt")}</span></div>
      ${day.maxGustKt != null ? `<div class="readout"><span class="k">Gust</span><span>${fmt(day.maxGustKt, 0, " kt")}</span></div>` : ""}
      ${day.minCeilingFt != null ? `<div class="readout"><span class="k">Ceiling (worst)</span><span>${fmt(day.minCeilingFt, 0, " ft")}</span></div>` : ""}
      ${day.minVisibilitySm != null ? `<div class="readout"><span class="k">Visibility (worst)</span><span>${day.minVisibilitySm.toFixed(1)} sm</span></div>` : ""}
      ${day.densityAltitudeFt != null ? `<div class="readout density"><span class="k">Density alt (worst)</span><span>${fmt(day.densityAltitudeFt, 0, " ft")}</span></div>` : ""}
      ${dayRunways.best ? `<div class="readout crosswind"><span class="k">Best runway</span><span>${dayRunways.best.label} (${Math.round(dayRunways.best.kt)} kt)</span></div>` : ""}
      ${day.maxPrecipChance != null ? `<div class="readout"><span class="k">Precip chance</span><span>${fmt(day.maxPrecipChance, 0, "%")}</span></div>` : ""}
      ${day.tafFlightCategory ? `<span class="flightcat taf-badge ${day.tafFlightCategory}">TAF ${day.tafFlightCategory}</span>` : ""}
      ${dayRunways.results.length > 1 ? runwayTableHtml(dayRunways.results, dayRunways.best?.label) : ""}
      ${checklistTableHtml(dayFinal.checklist)}
      ${hourlyTableHtml(hourFinals, data.timeZone)}
    `;
    daysSection.appendChild(card);
  }
  daysSection.classList.remove("hidden");
}

// ---------- main forecast load ----------

async function loadForecast() {
  const icao = icaoInput.value.trim().toUpperCase();
  if (!icao) return;

  saveSettings();
  renderFavorites();
  setStatus(`Loading ${icao}…`);
  currentSection.classList.add("hidden");
  daysSection.classList.add("hidden");

  const params = new URLSearchParams({ icao, ...buildThresholdParams() });

  try {
    const res = await fetch(`/api/forecast?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    lastData = data;
    renderCurrent(data);
    renderDays(data);
    updateProgchart();
    setStatus(`Updated ${new Date(data.fetchedAt).toLocaleTimeString()} · wind ≤ ${data.thresholds.windThresholdKt} kt · pressure ≥ ${data.thresholds.pressureThresholdHpa} hPa`);
  } catch (err) {
    setStatus(err.message, true);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  loadForecast();
});

// Re-render (no new request needed) when runway/crosswind settings change,
// so the whole checklist updates instantly without hitting the server.
runwayInput.addEventListener("input", () => {
  saveSettings();
  if (lastData) renderDays(lastData);
});

// ---------- route comparison ----------

routeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const icaos = routeIcaosInput.value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!icaos.length) return;

  routeStatusEl.textContent = `Comparing ${icaos.join(", ")}…`;
  routeStatusEl.classList.remove("error");
  routeMatrixEl.classList.add("hidden");

  const params = new URLSearchParams(buildThresholdParams());

  try {
    const results = await Promise.all(
      icaos.map(async (icao) => {
        const res = await fetch(`/api/forecast?icao=${icao}&${params.toString()}`);
        const data = await res.json();
        if (!res.ok) return { icao, error: data.error || "failed" };
        return { icao, data };
      })
    );

    const ok = results.filter((r) => r.data);
    if (!ok.length) throw new Error("None of those airports returned a forecast.");

    const dayDates = ok[0].data.days.map((d) => d.date);
    const dateHeaderFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });

    let html = `<table><thead><tr><th>Airport</th>${
      dayDates.map((d) => `<th>${dateHeaderFmt.format(new Date(`${d}T12:00:00`))}</th>`).join("")
    }</tr></thead><tbody>`;

    for (const r of results) {
      if (r.error) {
        html += `<tr><td>${r.icao}</td><td colspan="${dayDates.length}" class="mono">${r.error}</td></tr>`;
        continue;
      }
      html += `<tr><td>${r.icao}</td>${
        r.data.days.map((d) => `<td><span class="cell ${d.label}" title="${fmt(d.avgPressureHpa)} hPa, ${fmt(d.maxWindKt)} kt">${d.label}</span></td>`).join("")
      }</tr>`;
    }
    html += "</tbody></table>";

    routeMatrixEl.innerHTML = html;
    routeMatrixEl.classList.remove("hidden");
    routeStatusEl.textContent = "";
  } catch (err) {
    routeStatusEl.textContent = err.message;
    routeStatusEl.classList.add("error");
  }
});

// ---------- trip planner (departure + arrival airport for a specific day/time) ----------

function populateTripSelectors() {
  tripDaySelect.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = i === 0 ? "Today" : `${WEEKDAY_FMT.format(d)} ${DATE_FMT.format(d)}`;
    tripDaySelect.appendChild(opt);
  }

  tripTimeSelect.innerHTML = "";
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = new Date(Date.UTC(2020, 0, 1, h)).toLocaleTimeString([], {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
    });
    if (h === 10) opt.selected = true; // a reasonable default departure time
    tripTimeSelect.appendChild(opt);
  }
}

// Finds the hourly record for `dayIndex`/`hourOfDay` in that airport's own
// local time, then finalizes its checklist the same way renderDays() does.
function legForTime(data, dayIndex, hourOfDay) {
  const day = data.days[dayIndex];
  if (!day) return null;

  const localHourFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: data.timeZone });
  const hour = day.hourly.find((h) => Number(localHourFmt.format(new Date(h.timeIso))) === hourOfDay);
  if (!hour) return null;

  const runways = runwaysFromInput(data.station.runways);
  const { best, results } = evaluateRunways([hour], runways);
  const final = finalizeChecklist(hour.checklist, best);

  const timeFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: data.timeZone,
  });

  return { data, hour, timeLabel: timeFmt.format(new Date(hour.timeIso)), runwayResults: results, runwayBest: best, ...final };
}

function tripLegHtml(role, icao, leg) {
  if (!leg) {
    return `<div class="trip-leg UNKNOWN"><h4>${role}: ${icao}</h4><div class="trip-leg-time">No data for that day/time yet.</div></div>`;
  }
  return `<div class="trip-leg ${leg.label}">
    <h4>${role}: ${leg.data.station.name} (${leg.data.station.icao})</h4>
    <div class="trip-leg-time">${leg.timeLabel} local</div>
    <div class="rating">${leg.label}</div>
    ${leg.runwayBest ? `<div class="readout crosswind"><span class="k">Best runway</span><span>${leg.runwayBest.label} (${Math.round(leg.runwayBest.kt)} kt)</span></div>` : ""}
    ${leg.runwayResults.length > 1 ? runwayTableHtml(leg.runwayResults, leg.runwayBest?.label) : ""}
    ${checklistTableHtml(leg.checklist)}
  </div>`;
}

tripForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const departureIcao = tripDepartureInput.value.trim().toUpperCase();
  const arrivalIcao = tripArrivalInput.value.trim().toUpperCase();
  if (!departureIcao || !arrivalIcao) return;

  const dayIndex = Number(tripDaySelect.value);
  const hourOfDay = Number(tripTimeSelect.value);

  tripStatusEl.textContent = `Checking ${departureIcao} → ${arrivalIcao}…`;
  tripStatusEl.classList.remove("error");
  tripResultEl.classList.add("hidden");

  const params = new URLSearchParams(buildThresholdParams());

  try {
    const [depRes, arrRes] = await Promise.all([
      fetch(`/api/forecast?icao=${departureIcao}&${params.toString()}`),
      fetch(`/api/forecast?icao=${arrivalIcao}&${params.toString()}`),
    ]);
    const [depData, arrData] = await Promise.all([depRes.json(), arrRes.json()]);

    if (!depRes.ok) throw new Error(`${departureIcao}: ${depData.error || "failed"}`);
    if (!arrRes.ok) throw new Error(`${arrivalIcao}: ${arrData.error || "failed"}`);

    const depLeg = legForTime(depData, dayIndex, hourOfDay);
    const arrLeg = legForTime(arrData, dayIndex, hourOfDay);

    const legTiers = [depLeg?.tier, arrLeg?.tier].filter((t) => t && t !== "NA");
    const verdictTier = legTiers.length ? legTiers.reduce((worst, t) => (TIER_RANK[t] > TIER_RANK[worst] ? t : worst)) : "NA";
    const verdictLabel = TIER_TO_LABEL[verdictTier];

    tripResultEl.innerHTML = `
      <div class="trip-verdict ${verdictLabel}">Trip outlook: ${verdictLabel}</div>
      ${tripLegHtml("Departure", departureIcao, depLeg)}
      ${tripLegHtml("Arrival", arrivalIcao, arrLeg)}
    `;
    tripResultEl.classList.remove("hidden");
    tripStatusEl.textContent = "";
  } catch (err) {
    tripStatusEl.textContent = err.message;
    tripStatusEl.classList.add("error");
  }
});

// ---------- prog charts (official AWC graphics, loaded client-side - no backend needed) ----------
// <img> tags aren't subject to the CORS restriction that blocks fetch() calls
// to aviationweather.gov, so these load directly from the browser.

// Rough approximation of the 9 classic CONUS aviation-forecast regions - a
// convenience default only. The region picker lets the person correct it.
function guessProgchartRegion(lat, lon) {
  if (lat == null || lon == null) return "us";
  if (lon > -87) return lat >= 41 ? "ne" : lat >= 35 ? "e" : "se";
  if (lon > -104) return lat >= 41 ? "nc" : lat >= 35 ? "c" : "sc";
  return lat >= 41 ? "nw" : lat >= 35 ? "w" : "sw";
}

function progchartUrl(type, hour, region) {
  // A light cache-buster (changes every 10 min) so the browser doesn't hold
  // on to a stale image from earlier in the session.
  const bust = Math.floor(Date.now() / 600000);
  return `https://www.aviationweather.gov/data/products/gfa/F${hour}_gfa_${type}_${region}.png?v=${bust}`;
}

function updateProgchart() {
  if (!lastData) return;
  const region = progchartRegion.value === "auto"
    ? guessProgchartRegion(lastData.station.lat, lastData.station.lon)
    : progchartRegion.value;
  progchartImg.src = progchartUrl(progchartType.value, progchartHour.value, region);
  progchartImg.alt = `AWC ${progchartType.value === "sfc" ? "Surface" : "Clouds"} Forecast, +${Number(progchartHour.value)}h, ${region.toUpperCase()} region`;
}

for (const el of [progchartType, progchartHour, progchartRegion]) {
  el.addEventListener("change", updateProgchart);
}

// ---------- init ----------

restoreSettings();
renderFavorites();
populateTripSelectors();
if (icaoInput.value) loadForecast();
