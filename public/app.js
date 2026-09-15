const form = document.getElementById("search-form");
const icaoInput = document.getElementById("icao");
const windInput = document.getElementById("wind-threshold");
const pressureInput = document.getElementById("pressure-threshold");
const ceilingInput = document.getElementById("ceiling-threshold");
const visibilityInput = document.getElementById("visibility-threshold");
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

const WEEKDAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

let lastData = null; // most recent /api/forecast response, for re-rendering when runway changes

// ---------- settings persistence ----------

function restoreSettings() {
  const saved = JSON.parse(localStorage.getItem("flyday:settings") || "{}");
  if (saved.icao) icaoInput.value = saved.icao;
  if (saved.windThreshold) windInput.value = saved.windThreshold;
  if (saved.pressureThreshold) pressureInput.value = saved.pressureThreshold;
  if (saved.ceilingThreshold) ceilingInput.value = saved.ceilingThreshold;
  if (saved.visibilityThreshold) visibilityInput.value = saved.visibilityThreshold;
  if (saved.runway) runwayInput.value = saved.runway;
}

function saveSettings() {
  localStorage.setItem("flyday:settings", JSON.stringify({
    icao: icaoInput.value.trim().toUpperCase(),
    windThreshold: windInput.value,
    pressureThreshold: pressureInput.value,
    ceilingThreshold: ceilingInput.value,
    visibilityThreshold: visibilityInput.value,
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

// Accepts "13/31", "13", or "090" and returns a heading in degrees (0-360).
// Two-digit input is treated as a runway number (x10); three digits as a
// heading already in degrees.
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

function maxCrosswindForDay(day, runwayHeadingDeg) {
  if (runwayHeadingDeg == null || !day.hourly?.length) return null;
  const values = day.hourly
    .map((h) => crosswindKt(h.windSpeedKt, h.windDirDeg, runwayHeadingDeg))
    .filter((v) => v != null);
  return values.length ? Math.max(...values) : null;
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

function hourlyTableHtml(day, timeZone) {
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone });
  const rows = day.hourly
    .filter((h) => h.windSpeedKt != null || h.ceilingFt != null)
    .map((h) => {
      const t = timeFmt.format(new Date(h.timeIso));
      return `<tr>
        <td>${t}</td>
        <td>${fmt(h.windDirDeg)}°/${fmt(h.windSpeedKt)}${h.windGustKt ? `G${fmt(h.windGustKt)}` : ""}</td>
        <td>${h.ceilingFt != null ? fmt(h.ceilingFt) : "—"}</td>
        <td>${h.visibilitySm != null ? h.visibilitySm.toFixed(1) : "—"}</td>
        <td>${fmt(h.tempC)}</td>
        <td>${h.precipChance != null ? fmt(h.precipChance) : "—"}</td>
      </tr>`;
    })
    .join("");

  if (!rows) return "";

  return `<details class="hourly">
    <summary>Hourly detail</summary>
    <table class="hourly-table">
      <thead><tr><th>Time</th><th>Wind</th><th>Ceil ft</th><th>Vis sm</th><th>Temp C</th><th>Precip %</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </details>`;
}

function renderDays(data) {
  const runwayHeadingDeg = parseRunwayHeading(runwayInput.value);
  daysSection.innerHTML = "";

  for (const day of data.days) {
    const date = new Date(`${day.date}T12:00:00`);
    const card = document.createElement("article");
    card.className = `day-card ${day.label}`;

    const crosswind = maxCrosswindForDay(day, runwayHeadingDeg);

    card.innerHTML = `
      <div class="weekday">${WEEKDAY_FMT.format(date)}</div>
      <div class="date">${DATE_FMT.format(date)}</div>
      <div class="rating">${day.label}</div>
      <div class="readout"><span class="k">Pressure</span><span>${fmt(day.avgPressureHpa, 0, " hPa")}</span></div>
      <div class="readout"><span class="k">Wind (max)</span><span>${fmt(day.maxWindKt, 0, " kt")}</span></div>
      ${day.maxGustKt != null ? `<div class="readout"><span class="k">Gust</span><span>${fmt(day.maxGustKt, 0, " kt")}</span></div>` : ""}
      ${day.minCeilingFt != null ? `<div class="readout"><span class="k">Ceiling (worst)</span><span>${fmt(day.minCeilingFt, 0, " ft")}</span></div>` : ""}
      ${day.minVisibilitySm != null ? `<div class="readout"><span class="k">Visibility (worst)</span><span>${day.minVisibilitySm.toFixed(1)} sm</span></div>` : ""}
      ${day.densityAltitudeFt != null ? `<div class="readout density"><span class="k">Density alt (worst)</span><span>${fmt(day.densityAltitudeFt, 0, " ft")}</span></div>` : ""}
      ${crosswind != null ? `<div class="readout crosswind"><span class="k">Crosswind (rwy)</span><span>${fmt(crosswind, 0, " kt")}</span></div>` : ""}
      ${day.maxPrecipChance != null ? `<div class="readout"><span class="k">Precip chance</span><span>${fmt(day.maxPrecipChance, 0, "%")}</span></div>` : ""}
      ${day.tafFlightCategory ? `<span class="flightcat taf-badge ${day.tafFlightCategory}">TAF ${day.tafFlightCategory}</span>` : ""}
      ${hourlyTableHtml(day, data.timeZone)}
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

  const params = new URLSearchParams({
    icao,
    windThreshold: windInput.value,
    pressureThreshold: pressureInput.value,
    ceilingThreshold: ceilingInput.value,
    visibilityThreshold: visibilityInput.value,
  });

  try {
    const res = await fetch(`/api/forecast?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    lastData = data;
    renderCurrent(data);
    renderDays(data);
    setStatus(`Updated ${new Date(data.fetchedAt).toLocaleTimeString()} · wind < ${data.thresholds.windThresholdKt} kt · pressure ≥ ${data.thresholds.pressureThresholdHpa} hPa · ceiling ≥ ${data.thresholds.ceilingThresholdFt} ft · vis ≥ ${data.thresholds.visibilityThresholdSm} sm`);
  } catch (err) {
    setStatus(err.message, true);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  loadForecast();
});

// Re-render (no new request needed) when the runway heading changes, so
// crosswind updates instantly.
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

  const params = new URLSearchParams({
    windThreshold: windInput.value,
    pressureThreshold: pressureInput.value,
    ceilingThreshold: ceilingInput.value,
    visibilityThreshold: visibilityInput.value,
  });

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

// ---------- init ----------

restoreSettings();
renderFavorites();
if (icaoInput.value) loadForecast();
