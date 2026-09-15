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
  statusEl.textCont
