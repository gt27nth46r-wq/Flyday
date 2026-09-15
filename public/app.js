const form = document.getElementById("search-form");
const icaoInput = document.getElementById("icao");
const windInput = document.getElementById("wind-threshold");
const pressureInput = document.getElementById("pressure-threshold");
const ceilingInput = document.getElementById("ceiling-threshold");
const visibilityInput = document.getElementById("visibility-threshold");
const pressureFallInput = document.getElementById("pressure-fall-threshold");
const gradientInput = document.getElementById("gradient-threshold");
const runwayInput = document.getElementById("runway-heading");
const crosswindLimitInput = document.getElementById("crosswind-limit");
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
  if (saved.crosswindLimit) crosswindLimitInput.value = saved.crosswindLimit;
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
    crosswindLimit: crosswindLimitInput.value,
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
// Mirrors server/lib/rating.js's crosswindComponentKt() and evaluateCrosswindTier() -
// kept in sync by hand, since runway heading and personal crosswind limit never leave the browser.

// Accepts "13/31", "13", or "090" and returns a heading in degrees (0-360).
function parseRunwayHeading(text) {
  const match = String(text || "").match(/\d{1,3}/);
  if (!match) return null;
  const n = Number(match[0]);
  if (match[0].length >= 3) return n % 360;
  return (n * 10) % 360;
}

function crosswindKt(windSpeedKt, windDirDeg, runwayHeadingDeg) {
  if (windSpeedKt == null || windDirDeg == null || runwayHeadingDeg == null) return null;
  const rad = ((windDirDeg - runwayHeadingDeg) * Math.PI) / 180;
  return Math.abs(windSpeedKt * Math.sin(rad));
}

// Returns { tier, value } for the checklist's crosswind row, given one hour's wind.
function evaluateCrosswindTier(windSpeedKt, windDirDeg, runwayHeadingDeg, personalLimitKt) {
  if (runwayHeadingDeg == null || windDirDeg == null) return { tier: "NA", value: null };
  if (windSpeedKt != null && windSpeedKt < 3) return { tier: "GREEN", value: "calm" };

  const raw = Math.abs((((windDirDeg - runwayHeadingDeg) % 180) + 180) % 180);
  const angleOffRunway = raw > 90 ? 180 - raw : raw;
  if (angleOffRunway > 15) return { tier: "RED", value: `${Math.round(angleOffRunway)}° off runway` };

  const crosswind = crosswindKt(windSpeedKt, windDirDeg, runwayHeadingDeg);
  const redThresholdKt = Math.min(12, personalLimitKt);
  let tier;
  if (crosswind < 8) tier = "GREEN";
  else if (crosswind < redThresholdKt) tier = "YELLOW";
  else tier = "RED";
  return { tier, value: `${Math.round(crosswind)} kt` };
}

function overallTier(items) {
  const known = items.filter((i) => i.tier !== "NA");
  if (!known.length) return "NA";
  const worst = Math.max(...known.map((i) => TIER_RANK[i.tier]));
  return Object.keys(TIER_RANK).find((k) => TIER_RANK[k] === worst);
}

// Replaces the server's placeholder "crosswind" row (always NA server-side)
// with the value computed here, then recomputes the overall tier so a bad
// runway alignment can actually turn a day/hour Bad.
function finalizeChecklist(serverChecklist, crosswindResult) {
  const merged = serverChecklist.map((item) =>
    item.key === "crosswind" ? { ...item, label: "Crosswind", tier: crosswindResult.tier, value: crosswindResult.value } : item
  );
  const tier = overallTier(merged);
  return { checklist: merged, tier, label: TIER_TO_LABEL[tier] };
}

function crosswindOptsFromInputs() {
  return {
    runwayHeadingDeg: parseRunwayHeading(runwayInput.value),
    personalLimitKt: Number(crosswindLimitInput.value) || 15,
  };
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
  document.getElementById("station-meta").textContent =
    (data.location ? `near ${data.location}` : "") + elevPart;

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
function hourStripHtml(hourFinals, timeZone) {
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone });
  const daylight = hourFinals.filter((h) => {
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(new Date(h.hour.timeIso))
    );
    return localHour >= 6 && localHour <= 20;
  });
  if (!daylight.length) return "";

  const blocks = daylight
    .map(({ hour, label }) => {
      const t = timeFmt.format(new Date(hour.timeIso));
      const title = `${t}: ${label}${hour.windSpeedKt != null ? ` · ${fmt(hour.windDirDeg)}°/${fmt(hour.windSpeedKt)}kt` : ""}`;
      return `<span class="hour-block ${label}" title="${title}"></span>`;
    })
    .join("");
  return `<div class="hour-strip" aria-label="Hour by hour outlook, 6am to 8pm">${blocks}</div>`;
}

function hourlyTableHtml(hourFinals, timeZone) {
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone });
  const rows = hourFinals
    .filter(({ hour }) => hour.windSpeedKt != null || hour.ceilingFt != null)
    .map(({ hour, label }) => {
      const t = timeFmt.format(new Date(hour.timeIso));
      return `<tr>
        <td><span class="hour-dot ${label}"></span>${t}</td>
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
    <table class="hourly-table">
      <thead><tr><th>Time</th><th>Wind</th><th>Ceil ft</th><th>Vis sm</th><th>Trend/3h</th><th>Gradient/100km</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
    <table class="checklist-table">
      <thead><tr><th>Item</th><th>Worst case today</th><th>Rating</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </details>`;
}

function renderDays(data) {
  const { runwayHeadingDeg, personalLimitKt } = crosswindOptsFromInputs();
  daysSection.innerHTML = "";

  for (const day of data.days) {
    const date = new Date(`${day.date}T12:00:00`);

    // Finalize every hour first (crosswind merged in), so the day-level
    // crosswind row and overall tier can both be derived from the worst hour.
    const hourFinals = day.hourly.map((hour) => {
      const cw = evaluateCrosswindTier(hour.windSpeedKt, hour.windDirDeg, runwayHeadingDeg, personalLimitKt);
      const { checklist, tier, label } = finalizeChecklist(hour.checklist, cw);
      return { hour, checklist, tier, label, crosswind: cw };
    });

    const worstHourCrosswind = hourFinals.reduce((worst, h) => {
      if (h.crosswind.tier === "NA") return worst;
      if (worst.tier === "NA" || TIER_RANK[h.crosswind.tier] > TIER_RANK[worst.tier]) return h.crosswind;
      return worst;
    }, { tier: "NA", value: null });

    const dayFinal = finalizeChecklist(day.checklist, worstHourCrosswind);

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
      ${worstHourCrosswind.tier !== "NA" ? `<div class="readout crosswind"><span class="k">Crosswind (worst)</span><span>${worstHourCrosswind.value}</span></div>` : ""}
      ${day.maxPrecipChance != null ? `<div class="readout"><span class="k">Precip chance</span><span>${fmt(day.maxPrecipChance, 0, "%")}</span></div>` : ""}
      ${day.tafFlightCategory ? `<span class="flightcat taf-badge ${day.tafFlightCategory}">TAF ${day.tafFlightCategory}</span>` : ""}
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
for (const el of [runwayInput, crosswindLimitInput]) {
  el.addEventListener("input", () => {
    saveSettings();
    if (lastData) renderDays(lastData);
  });
}

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

  const { runwayHeadingDeg, personalLimitKt } = crosswindOptsFromInputs();
  const cw = evaluateCrosswindTier(hour.windSpeedKt, hour.windDirDeg, runwayHeadingDeg, personalLimitKt);
  const final = finalizeChecklist(hour.checklist, cw);

  const timeFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: data.timeZone,
  });

  return { data, hour, timeLabel: timeFmt.format(new Date(hour.timeIso)), ...final };
}

function tripLegHtml(role, icao, leg) {
  if (!leg) {
    return `<div class="trip-leg UNKNOWN"><h4>${role}: ${icao}</h4><div class="trip-leg-time">No data for that day/time yet.</div></div>`;
  }
  return `<div class="trip-leg ${leg.label}">
    <h4>${role}: ${leg.data.station.name} (${leg.data.station.icao})</h4>
    <div class="trip-leg-time">${leg.timeLabel} local</div>
    <div class="rating">${leg.label}</div>
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

// ---------- init ----------

restoreSettings();
renderFavorites();
populateTripSelectors();
if (icaoInput.value) loadForecast();
