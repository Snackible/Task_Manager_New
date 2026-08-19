const STATUS_ORDER = ["overdue", "pending", "in_progress", "completed"];
const STATUS_COLOR = {
  overdue: "var(--status-overdue)",
  pending: "var(--status-pending)",
  in_progress: "var(--status-in-progress)",
  completed: "var(--status-completed)",
};
// Resolved (non-variable) colors, needed for SVG fill attrs in some browsers.
const STATUS_COLOR_RESOLVED = {};
// Gradient defs live in the hidden <svg> at the top of index.html — their
// stops reference the CSS vars directly, so they repaint on theme change
// with no JS involvement.
const STATUS_GRADIENT_ID = {
  overdue: "gradOverdue",
  pending: "gradPending",
  in_progress: "gradInProgress",
  completed: "gradCompleted",
};

function resolveColors() {
  const style = getComputedStyle(document.documentElement);
  for (const status of STATUS_ORDER) {
    STATUS_COLOR_RESOLVED[status] = style.getPropertyValue(`--status-${status.replace("_", "-")}`).trim();
  }
}

let currentData = null;
let currentScope = "total"; // "total" or a sheet key (data.perSheet key)
let currentGranularity = "weekly"; // "weekly" or "daily" — which series feeds the chart/tiles
let currentReportMode = "summary"; // "summary" (retrospective) or "plan" (WIP + Not Started)
let currentReportDateLabel = null; // e.g. "Week of Aug 11–17, 2026" — the data the current report covers, not when it was generated

async function loadData() {
  const res = await fetch("/api/tasks");
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

function render(data) {
  currentData = data;
  resolveColors();

  if (!(currentScope === "total" || currentScope in data.perSheet)) {
    currentScope = "total"; // scope disappeared (config changed) -> fall back
  }

  renderTabs(data);
  renderScopedView(data);
  renderFooter(data);
  populateWeekSelect(data);
  loadTaskList(currentScope);

  const dt = new Date(data.generatedAt);
  document.getElementById("updatedAt").textContent = `Updated ${dt.toLocaleString()}`;
}

/** Silent refresh for the 30s auto-poll: updates counts/chart/task list but
 * deliberately does NOT touch the report panel — a background refresh
 * shouldn't wipe out a report the user already generated and is reading. */
function silentRefresh(data) {
  currentData = data;
  resolveColors();
  renderTabs(data);
  renderScopedContent(data);
  renderFooter(data);
  populateWeekSelect(data);
  loadTaskList(currentScope);

  const dt = new Date(data.generatedAt);
  document.getElementById("updatedAt").textContent = `Updated ${dt.toLocaleString()}`;
}

function isoWeekStartClient(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

function populateWeekSelect(data) {
  const select = document.getElementById("reportWeekSelect");
  const thisWeekStart = isoWeekStartClient(new Date()).toISOString().slice(0, 10);
  const weeksMap = new Map();
  for (const w of data.weekly || []) weeksMap.set(w.periodStart, w.label);
  if (!weeksMap.has(thisWeekStart)) weeksMap.set(thisWeekStart, "no data yet");

  const entries = Array.from(weeksMap.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  const prevValue = select.value;
  select.innerHTML = entries
    .map(([periodStart, label]) => {
      const text = periodStart === thisWeekStart ? `This week (${label})` : label;
      return `<option value="${periodStart}">${text}</option>`;
    })
    .join("");
  select.value = entries.some(([p]) => p === prevValue) ? prevValue : thisWeekStart;
}

function fmt(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function badgeHTML(source) {
  if (source === "live") return '<span class="badge live">Live</span>';
  if (source === "demo") return '<span class="badge demo">Demo data</span>';
  return '<span class="badge empty">No data</span>';
}

let currentDateRange = "all"; // "all" | "week" | "month" | "7d" | "30d" — shared filter across stat tiles, chart, and the task table

/** UTC {start, end} Date bounds for a date-range filter value, or null for "all". */
function dateRangeBounds(range) {
  if (range === "all" || !range) return null;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === "week") {
    const start = isoWeekStartClient(today);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return { start, end };
  }
  if (range === "month") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    return { start, end };
  }
  if (range === "7d") {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 6);
    return { start, end: today };
  }
  if (range === "30d") {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 29);
    return { start, end: today };
  }
  return null;
}

function isWithinRange(isoDateStr, range) {
  if (!range) return true;
  if (!isoDateStr) return false;
  const d = new Date(`${isoDateStr}T00:00:00Z`);
  return d.getTime() >= range.start.getTime() && d.getTime() <= range.end.getTime();
}

/** Sum a weekly/daily series' per-period status counts into one totals object. */
function sumSeriesTotals(series) {
  const totals = { overdue: 0, pending: 0, in_progress: 0, completed: 0 };
  for (const period of series) {
    for (const status of STATUS_ORDER) totals[status] += period[status] || 0;
  }
  return totals;
}

/** Resolve the currently selected scope + granularity + date range into a
 * {label, totals, series, taskCount, source} view. When a date range is
 * active, totals are recomputed from the (now range-filtered) series
 * instead of the lifetime totals — those totals are literally "how many
 * dated tasks fall in this range, by current status," which is what a
 * date-range filter should mean. */
function scopedView(data) {
  const seriesKey = currentGranularity === "daily" ? "daily" : "weekly";
  const perSheetSeriesKey = currentGranularity === "daily" ? "perSheetDaily" : "perSheetWeekly";

  let label, totals, series, taskCount, source;
  if (currentScope === "total") {
    label = "Total";
    totals = data.totals;
    series = data[seriesKey] || [];
    taskCount = data.taskCount;
    source = null;
  } else {
    const sheet = data.perSheet[currentScope];
    label = sheet.name;
    totals = { overdue: sheet.overdue, pending: sheet.pending, in_progress: sheet.in_progress, completed: sheet.completed };
    series = (data[perSheetSeriesKey] && data[perSheetSeriesKey][currentScope]) || [];
    taskCount = sheet.total;
    source = data.sources[currentScope];
  }

  const range = dateRangeBounds(currentDateRange);
  if (range) {
    series = series.filter((p) => isWithinRange(p.periodStart, range));
    totals = sumSeriesTotals(series);
    taskCount = STATUS_ORDER.reduce((sum, s) => sum + (totals[s] || 0), 0);
  }

  return { label, totals, series, taskCount, source };
}

function renderTabs(data) {
  const bar = document.getElementById("tabBar");
  const tabs = [{ key: "total", label: "Total", source: null }].concat(
    Object.entries(data.perSheet).map(([key, s]) => ({ key, label: s.name, source: data.sources[key] }))
  );
  // Remove only the old buttons — the indicator div stays in place (same DOM
  // node) so its left/width transition has a real "from" value to animate.
  bar.querySelectorAll(".tab-btn").forEach((b) => b.remove());

  let activeBtn = null;
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn" + (tab.key === currentScope ? " active" : "");
    // "Total" spans every source at once, so it gets no single dot to show —
    // only per-team tabs have one source to report on.
    const dot =
      tab.source === "live"
        ? '<span class="tab-availability-dot is-live" title="Live data"></span>'
        : tab.source
          ? '<span class="tab-availability-dot is-offline" title="Demo or no live data"></span>'
          : "";
    btn.innerHTML = `${dot}${tab.label}`;
    btn.addEventListener("click", () => {
      if (currentScope === tab.key) return;
      currentScope = tab.key;
      renderTabs(currentData);
      renderScopedView(currentData);
      loadTaskList(currentScope);
    });
    bar.appendChild(btn);
    if (tab.key === currentScope) activeBtn = btn;
  }

  moveTabIndicator(activeBtn);
}

function moveTabIndicator(activeBtn) {
  const indicator = document.getElementById("tabIndicator");
  if (!indicator || !activeBtn) return;
  indicator.style.left = `${activeBtn.offsetLeft}px`;
  indicator.style.width = `${activeBtn.offsetWidth}px`;
}

function replayFadeIn(el) {
  el.classList.remove("fade-in");
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add("fade-in");
}

function renderScopedContent(data) {
  const view = scopedView(data);

  renderStatTiles(view);
  renderLegend(data);
  renderSeriesChart(view.series);
  renderSeriesTable(view.series);
  replayFadeIn(document.getElementById("statRow"));
  replayFadeIn(document.getElementById("chartWrap"));

  const grLabel = currentGranularity === "daily" ? "Daily" : "Weekly";
  const chartTitle = document.getElementById("chartTitle");
  chartTitle.innerHTML =
    currentScope === "total"
      ? `${grLabel} breakdown`
      : `${grLabel} breakdown &mdash; ${view.label} ${badgeHTML(view.source)}`;

  const teamPanel = document.getElementById("teamPanel");
  if (currentScope === "total") {
    teamPanel.hidden = false;
    renderTeamTable(data);
  } else {
    teamPanel.hidden = true;
  }

  // A "remind" is inherently team-scoped (one WhatsApp contact per team) —
  // there's no single number to send an "all teams" reminder to, so the
  // panel only makes sense once a specific team is selected.
  document.getElementById("reminderPanel").hidden = currentScope === "total";

  document.getElementById("tasksTitle").textContent =
    currentScope === "total" ? "Tasks" : `Tasks — ${view.label}`;
}

/** Full scope render, used whenever the scope/tab actually changes — resets
 * the report panel, since a report generated for the previous tab/team no
 * longer applies. Granularity changes (Weekly/Daily) don't affect which
 * team/week the report covers, so they use renderScopedContent() directly
 * and leave an already-generated report in place. */
function renderScopedView(data) {
  renderScopedContent(data);
  resetReportPanel(scopedView(data).label);
}

const REPORT_EMPTY_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>`;

// One place to add a new report mode: button/loading/error copy + the empty-state blurb.
const REPORT_MODE_META = {
  summary: {
    buttonLabel: "Generate Report",
    regenerateLabel: "Regenerate",
    generatingLabel: "Generating…",
    errorNoun: "report",
    emptyText: (scopeText) =>
      `Get an AI-written summary of ${scopeText} weekly data — highlights, risks, and a recommendation.`,
  },
  plan: {
    buttonLabel: "Generate Plan",
    regenerateLabel: "Regenerate Plan",
    generatingLabel: "Planning…",
    errorNoun: "plan",
    emptyText: (scopeText) =>
      `Get a Monday-morning plan for ${scopeText} open work — what's WIP, what hasn't started, and what to focus on first.`,
  },
  eod: {
    buttonLabel: "Generate EOD Summary",
    regenerateLabel: "Regenerate",
    generatingLabel: "Wrapping up…",
    errorNoun: "EOD summary",
    emptyText: (scopeText) =>
      `Get an end-of-day recap of ${scopeText} activity today — what got done, what's still open, and tomorrow's priority.`,
  },
};

function resetReportPanel(scopeLabel) {
  document.getElementById("reportTitle").textContent = "AI Report";
  currentReportDateLabel = null;
  const btn = document.getElementById("reportBtn");
  btn.disabled = false;
  document.getElementById("reportIcon").classList.remove("spin");
  document.getElementById("reportPdfBtn").hidden = true;
  const meta = REPORT_MODE_META[currentReportMode];
  const scopeText = scopeLabel === "Total" ? "all teams'" : scopeLabel + "'s";
  document.getElementById("reportLabel").textContent = meta.buttonLabel;
  document.getElementById("reportBody").innerHTML = `
    <div class="report-empty">
      <div class="report-empty-icon">${REPORT_EMPTY_ICON_SVG}</div>
      <p>${meta.emptyText(scopeText)}</p>
    </div>`;
}

/** Opens a clean, printable copy of the current report in a new tab and
 * triggers the browser's print dialog — "Save as PDF" is a standard print
 * destination in every modern browser, so this needs no PDF library. */
function saveReportAsPdf() {
  const scopeLabel = currentScope === "total" ? "Total" : (currentData.perSheet[currentScope] || {}).name || currentScope;
  const modeLabel = { summary: "Summary", plan: "Weekly Plan", eod: "End of Day" }[currentReportMode] || "Report";
  // Prefer the actual date(s) the report's data covers over when it happened
  // to be generated — a report can be regenerated well after the week/day it
  // describes, so "generated at" is misleading as the headline date.
  const dateLabel = currentReportDateLabel || new Date().toLocaleDateString();
  // Full string (incl. date) is the document <title> — Chrome/Edge use it as
  // the suggested filename when saving the print dialog as a PDF. The on-page
  // <h1> stays shorter since the date gets its own badge right below it.
  const title = `${scopeLabel} — ${modeLabel} — ${dateLabel}`;
  const heading = `${scopeLabel} — ${modeLabel}`;
  const bodyHTML = document.getElementById("reportBody").innerHTML;

  const win = window.open("", "_blank");
  if (!win) {
    alert("Your browser blocked the print popup — allow popups for this site and try again.");
    return;
  }
  // This is a standalone document (no access to styles.css or its CSS custom
  // properties), so the report-card / status-pill styling from the live panel
  // is mirrored here with literal light-theme colors instead of var(...).
  //
  // print-color-adjust / -webkit-print-color-adjust are the load-bearing
  // rule here: without them, Chrome/Edge/Firefox silently drop every
  // background-color and gradient when printing/saving as PDF unless the
  // user manually ticks "Background graphics" in the print dialog — which
  // is why the status pills and callout box were rendering colorless.
  // Spelled out as an explicit "Data considered:" line rather than a bare
  // date, so it reads unambiguously as the window of data behind the report
  // — not a generation timestamp — even to someone skimming the PDF.
  const metaLine = currentReportDateLabel
    ? `Data considered: ${currentReportDateLabel}`
    : "Generated " + new Date().toLocaleString();
  win.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
  html { background: #f3f2ef; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 760px;
    margin: 40px auto;
    padding: 0 24px 56px;
    color: #111;
    line-height: 1.6;
  }

  .doc-masthead { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .doc-brandmark { display: flex; align-items: flex-end; gap: 3px; width: 26px; height: 26px; padding: 4px; border-radius: 7px; background: #fcfcfb; border: 1px solid #e1e0d9; }
  .doc-brandmark span { width: 4px; border-radius: 1.5px; display: block; }
  .doc-brandmark span:nth-child(1) { height: 40%; background: #2a78d6; }
  .doc-brandmark span:nth-child(2) { height: 70%; background: #fab219; }
  .doc-brandmark span:nth-child(3) { height: 100%; background: #0ca30c; }
  .doc-brandname { font-size: 12.5px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: #898781; }

  .doc-card { background: #ffffff; border: 1px solid #e1e0d9; border-radius: 16px; padding: 32px 36px 36px; }

  h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 12px; color: #0b0b0b; }
  .meta {
    display: inline-block;
    background: linear-gradient(135deg, rgba(42,120,214,0.12), rgba(74,58,167,0.12));
    border: 1px solid #e1e0d9;
    color: #4a3aa7;
    font-size: 12.5px;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 999px;
    margin-bottom: 26px;
  }
  ul { padding-left: 20px; margin: 0 0 12px; }
  li { margin-bottom: 6px; }
  p { margin: 0 0 12px; }
  strong { color: #000; }

  .report-team { padding-left: 14px; border-left: 3px solid #e1e0d9; }
  .report-team + .report-team { margin-top: 20px; padding-top: 18px; border-top: 1px solid #e1e0d9; }
  .report-team:nth-of-type(6n+1) { border-left-color: #2a78d6; }
  .report-team:nth-of-type(6n+2) { border-left-color: #4a3aa7; }
  .report-team:nth-of-type(6n+3) { border-left-color: #0ca30c; }
  .report-team:nth-of-type(6n+4) { border-left-color: #fab219; }
  .report-team:nth-of-type(6n+5) { border-left-color: #ec835a; }
  .report-team:nth-of-type(6n)   { border-left-color: #d03b3b; }
  .report-team h2 { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #111; margin: 0 0 8px; }

  .status-word { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.6; white-space: nowrap; }
  .status-word-pending { background: rgba(42,120,214,0.16); color: #2a78d6; }
  .status-word-in-progress { background: rgba(250,178,25,0.30); color: #8a5c00; }
  .status-word-completed { background: rgba(12,163,12,0.16); color: #0ca30c; }
  .status-word-hold { background: #f3f2ef; color: #52514e; border: 1px solid #e1e0d9; }

  li.report-overall { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e1e0d9; font-style: italic; color: #52514e; }

  .report-callout { margin: 20px 0 0 !important; padding: 12px 14px; border-radius: 10px; background: linear-gradient(135deg, rgba(42,120,214,0.14), rgba(74,58,167,0.14)); border: 1px solid #e1e0d9; }
  .report-callout strong { color: #4a3aa7; }

  .report-not-updated { color: #898781; font-style: italic; }

  @media print {
    html, body { background: #fff; margin: 0; }
    .doc-card { border-radius: 0; border: none; padding: 0; }
  }
</style>
</head><body>
<div class="doc-masthead">
  <div class="doc-brandmark"><span></span><span></span><span></span></div>
  <div class="doc-brandname">Task Tracker Dashboard</div>
</div>
<div class="doc-card">
<h1>${heading}</h1>
<div class="meta">${metaLine}</div>
${bodyHTML}
</div>
</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

// The four status words the model is instructed to weave into report prose
// (see STYLE_RULES in lib/aiReport.js) — highlighted as colored pills so the
// report reads at a glance, using the same status palette as the rest of
// the dashboard (stat tiles, chart, badges).
const STATUS_WORD_CLASS = {
  "Not Started": "pending",
  "On Hold": "hold",
  WIP: "in-progress",
  Done: "completed",
};
const STATUS_WORD_RE = /\b(Not Started|On Hold|WIP|Done)\b/g;
const REPORT_CALLOUT_PREFIXES = ["**Focus this week:**", "**Tomorrow's priority:**"];

function highlightStatusWords(html) {
  return html.replace(STATUS_WORD_RE, (m) => `<span class="status-word status-word-${STATUS_WORD_CLASS[m]}">${m}</span>`);
}

/** Minimal markdown -> HTML: "## " team headings (each becomes a report-team
 * card), bold (**x**), and "- " bullet lists. No deps. Also flags a few
 * report-specific line shapes for prettier styling: the per-team "Overall"
 * wrap-up bullet, the closing "Focus this week:" / "Tomorrow's priority:"
 * callout, and a bare "Not updated" line for teams with no source data. */
function renderMarkdownLite(text) {
  const lines = text.split("\n");
  let html = "";
  let inList = false;
  let inTeam = false;

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  const closeTeam = () => {
    if (inTeam) {
      html += "</div>";
      inTeam = false;
    }
  };
  const inline = (s) => highlightStatusWords(s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith("## ")) {
      closeList();
      closeTeam();
      html += `<div class="report-team"><h2>${inline(line.slice(3))}</h2>`;
      inTeam = true;
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      const itemText = line.slice(2).trim();
      const cls = /^overall\b/i.test(itemText) ? ' class="report-overall"' : "";
      html += `<li${cls}>${inline(itemText)}</li>`;
    } else if (REPORT_CALLOUT_PREFIXES.some((p) => line.startsWith(p))) {
      closeList();
      closeTeam(); // the closing callout sits below every team's section, not inside one
      html += `<p class="report-callout">${inline(line)}</p>`;
    } else if (/^not updated\.?$/i.test(line)) {
      closeList();
      html += `<p class="report-not-updated">${inline(line)}</p>`;
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  closeTeam();
  return html;
}

async function generateReport() {
  const btn = document.getElementById("reportBtn");
  const label = document.getElementById("reportLabel");
  const icon = document.getElementById("reportIcon");
  const body = document.getElementById("reportBody");
  const meta = REPORT_MODE_META[currentReportMode];
  btn.disabled = true;
  label.textContent = meta.generatingLabel;
  icon.classList.add("spin");
  body.innerHTML = `<p class="report-loading">Asking Gemini to put together the ${meta.errorNoun}…</p>`;
  try {
    let url = `/api/report?scope=${encodeURIComponent(currentScope)}&type=${encodeURIComponent(currentReportMode)}`;
    if (currentReportMode === "summary") {
      const week = document.getElementById("reportWeekSelect").value;
      if (week) url += `&week=${encodeURIComponent(week)}`;
    }
    const res = await fetch(url, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Report request failed (${res.status})`);
    body.innerHTML = renderMarkdownLite(json.report);
    currentReportDateLabel = json.dateLabel || null;
    document.getElementById("reportTitle").textContent = currentReportDateLabel
      ? `AI Report — ${currentReportDateLabel}`
      : "AI Report";
    replayFadeIn(body);
    label.textContent = meta.regenerateLabel;
    document.getElementById("reportPdfBtn").hidden = false;
  } catch (err) {
    body.innerHTML = `<p class="report-error"><span class="err-icon">&#9888;</span> Couldn't generate ${meta.errorNoun}: ${err.message}</p>`;
    currentReportDateLabel = null;
    label.textContent = meta.buttonLabel;
    document.getElementById("reportPdfBtn").hidden = true;
  } finally {
    btn.disabled = false;
    icon.classList.remove("spin");
  }
}

// Does a rising count mean things are getting better or worse, per status?
const DELTA_UP_IS_GOOD = { overdue: false, pending: false, in_progress: null, completed: true };

function renderStatTiles(view) {
  const row = document.getElementById("statRow");
  row.innerHTML = "";
  for (const status of STATUS_ORDER) {
    const total = view.totals[status] || 0;
    const label = currentData.statusLabels[status];
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    tile.style.setProperty("--tile-accent", STATUS_COLOR[status]);
    tile.innerHTML = `
      <div class="label"><span class="swatch" style="background:${STATUS_COLOR[status]}"></span>${label}</div>
      <div class="value-row">
        <div class="value">${fmt(total)}</div>
        ${sparklineSVG(view.series, status)}
      </div>
      <div class="sub">${deltaSub(view, status)}</div>
    `;
    row.appendChild(tile);
  }
}

function deltaSub(view, status) {
  const series = view.series;
  const periodWord = currentGranularity === "daily" ? "day" : "week";
  if (series.length < 2) return `${view.taskCount} tasks total`;
  const last = series[series.length - 1][status] || 0;
  const prev = series[series.length - 2][status] || 0;
  if (prev === 0 && last === 0) return `no change this ${periodWord}`;
  const delta = last - prev;
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
  const upIsGood = DELTA_UP_IS_GOOD[status];
  let mood = "neutral";
  if (delta !== 0 && upIsGood !== null) {
    const isImprovement = (delta > 0) === upIsGood;
    mood = isImprovement ? "good" : "bad";
  }
  // Color lives on the arrow glyph only — the number and text stay normal ink
  // (a status hue on small text fails contrast; the arrow is a "mark", the
  // adjacent plain-ink text is its relief label).
  return `<span class="delta-arrow ${mood}">${arrow}</span> ${Math.abs(delta)} vs prior ${periodWord}`;
}

/** 12-point-max inline trend sparkline for one status across the visible periods. */
function sparklineSVG(series, status) {
  if (series.length < 2) return "";
  const points = series.slice(-12).map((p) => p[status] || 0);
  const w = 56;
  const h = 24;
  const pad = 2;
  const max = Math.max(1, ...points);
  const stepX = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y];
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];
  const color = STATUS_COLOR_RESOLVED[status];
  return `
    <svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.55" />
      <circle cx="${lastX}" cy="${lastY}" r="2.5" fill="${color}" />
    </svg>`;
}

function renderLegend(data) {
  const el = document.getElementById("chartLegend");
  el.innerHTML = STATUS_ORDER.map(
    (s) =>
      `<span class="item"><span class="dot" style="background:${STATUS_COLOR[s]}"></span>${data.statusLabels[s]}</span>`
  ).join("");
}

function renderSeriesChart(series) {
  const svg = document.getElementById("weeklyChart");
  const width = svg.parentElement.clientWidth || 800;
  // A wall-to-wall 280px chart around one lonely bar reads as broken, not
  // minimal — scale the canvas down when there's little to show.
  const height = series.length === 0 ? 160 : series.length <= 1 ? 190 : series.length <= 3 ? 230 : 280;
  const marginLeft = 40;
  const marginBottom = 28;
  const marginTop = 28;
  const marginRight = 8;

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.height = `${height}px`;
  svg.innerHTML = "";

  if (series.length === 0) {
    const text = svgEl("text", {
      x: width / 2,
      y: height / 2,
      "text-anchor": "middle",
      class: "axis-label",
    });
    text.textContent = "No dated tasks yet";
    svg.appendChild(text);
    return;
  }

  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const maxTotal = Math.max(
    1,
    ...series.map((p) => p.pending + p.in_progress + p.completed)
  );
  const niceMax = niceCeil(maxTotal);

  // gridlines + y ticks (0, mid, max)
  const ticks = [0, niceMax / 2, niceMax];
  for (const t of ticks) {
    const y = marginTop + plotH - (t / niceMax) * plotH;
    svg.appendChild(
      svgEl("line", {
        x1: marginLeft,
        x2: width - marginRight,
        y1: y,
        y2: y,
        class: t === 0 ? "baseline" : "gridline",
      })
    );
    const label = svgEl("text", {
      x: marginLeft - 8,
      y: y + 4,
      "text-anchor": "end",
      class: "axis-label",
    });
    label.textContent = Math.round(t).toLocaleString();
    svg.appendChild(label);
  }

  const bandW = plotW / series.length;
  const barW = Math.min(24, bandW * 0.5);
  const gap = 2;
  // With many bars (dense daily views), a label on every one overlaps its
  // neighbors — thin them out so only every Nth bar is labeled, based on how
  // much horizontal room a label like "Aug 10" actually needs (~6 chars).
  const estLabelW = 6 * 6.5 + 6;
  const labelStride = Math.max(1, Math.ceil(estLabelW / bandW));

  series.forEach((period, i) => {
    const cx = marginLeft + bandW * i + bandW / 2;
    let yCursor = marginTop + plotH; // bottom, we stack upward
    const total = period.pending + period.in_progress + period.completed;

    STATUS_ORDER.forEach((status, si) => {
      const val = period[status] || 0;
      if (val <= 0) return;
      const segH = (val / niceMax) * plotH;
      const isTop = STATUS_ORDER.slice(si + 1).every((s) => (period[s] || 0) === 0);
      const y = yCursor - segH;
      const rectGap = si === 0 ? 0 : gap / 2;

      const rect = svgEl("rect", {
        x: cx - barW / 2,
        y: y,
        width: barW,
        height: Math.max(0, segH - (isTop ? 0 : gap / 2) - rectGap),
        fill: `url(#${STATUS_GRADIENT_ID[status]})`,
        rx: isTop ? 4 : 0,
        class: "bar-seg",
      });
      rect.style.animationDelay = `${i * 35}ms`;
      rect.dataset.period = period.periodStart;
      rect.dataset.status = status;
      rect.addEventListener("mousemove", (e) => showTooltip(e, period));
      rect.addEventListener("mouseleave", hideTooltip);
      svg.appendChild(rect);

      yCursor -= segH;
    });

    // Columns get their value on the cap (marks-and-anatomy.md) — plain ink,
    // never the segment color, and skipped if it would clip past the top edge.
    if (total > 0) {
      const topY = yCursor;
      const valueY = topY - 8;
      if (valueY > 10) {
        const valueLabel = svgEl("text", {
          x: cx,
          y: valueY,
          "text-anchor": "middle",
          class: "bar-value-label",
        });
        valueLabel.textContent = fmt(total);
        valueLabel.style.animationDelay = `${i * 35 + 200}ms`;
        svg.appendChild(valueLabel);
      }
    }

    const isLastBar = i === series.length - 1;
    if (i % labelStride === 0 || isLastBar) {
      const label = svgEl("text", {
        x: cx,
        y: height - 6,
        "text-anchor": "middle",
        class: "axis-label",
      });
      label.textContent = shortAxisLabel(period.label);
      svg.appendChild(label);
    }
  });
}

function shortAxisLabel(label) {
  // "Aug 10–16, 2026" -> "Aug 10"; "Mon, Aug 10, 2026" -> "Aug 10"
  const m = label.match(/[A-Za-z]{3,9} \d{1,2}/);
  return m ? m[0] : label;
}

function niceCeil(n) {
  if (n <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const steps = [1, 2, 2.5, 5, 10];
  for (const s of steps) {
    if (n <= s * pow) return s * pow;
  }
  return Math.ceil(n / pow) * pow;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function showTooltip(evt, period) {
  const tooltip = document.getElementById("tooltip");
  const wrap = document.getElementById("chartWrap");
  const wrapRect = wrap.getBoundingClientRect();

  tooltip.innerHTML = `
    <div class="tt-title">${period.label}</div>
    ${STATUS_ORDER.map(
      (s) => `
      <div class="tt-row">
        <span class="k"><span class="dot" style="background:${STATUS_COLOR[s]}"></span>${currentData.statusLabels[s]}</span>
        <span class="v">${period[s] || 0}</span>
      </div>`
    ).join("")}
  `;
  tooltip.hidden = false;
  let left = evt.clientX - wrapRect.left + 12;
  let top = evt.clientY - wrapRect.top + 12;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  document.getElementById("tooltip").hidden = true;
}

function renderSeriesTable(series) {
  const wrap = document.getElementById("weeklyTableWrap");
  const periodHeader = currentGranularity === "daily" ? "Day" : "Week";
  const rows = series
    .map(
      (p) => `
      <tr>
        <td>${p.label}</td>
        <td class="num">${p.pending}</td>
        <td class="num">${p.in_progress}</td>
        <td class="num">${p.completed}</td>
        <td class="num">${p.pending + p.in_progress + p.completed}</td>
      </tr>`
    )
    .join("");
  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>${periodHeader}</th><th class="num">Pending</th><th class="num">In Progress</th><th class="num">Completed</th><th class="num">Total</th></tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="5">No dated tasks yet</td></tr>`}</tbody>
    </table>`;
}

function renderTeamTable(data) {
  const wrap = document.getElementById("teamTableWrap");
  const rows = Object.entries(data.perSheet)
    .map(([key, s]) => {
      return `
      <tr data-team-key="${key}" tabindex="0" role="button" aria-label="View ${s.name}">
        <td>${s.name}</td>
        <td class="num">${s.pending}</td>
        <td class="num">${s.in_progress}</td>
        <td class="num">${s.completed}</td>
        <td class="num">${s.total}</td>
        <td>${badgeHTML(data.sources[key])}</td>
      </tr>`;
    })
    .join("");
  wrap.innerHTML = `
    <table class="data-table clickable-rows">
      <thead>
        <tr><th>Team</th><th class="num">Pending</th><th class="num">In Progress</th><th class="num">Completed</th><th class="num">Total</th><th>Source</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  const goToTeam = (key) => {
    if (currentScope === key || !currentData) return;
    currentScope = key;
    renderTabs(currentData);
    renderScopedView(currentData);
    loadTaskList(currentScope);
    document.getElementById("tabBar").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  wrap.querySelectorAll("tr[data-team-key]").forEach((tr) => {
    tr.addEventListener("click", () => goToTeam(tr.dataset.teamKey));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        goToTeam(tr.dataset.teamKey);
      }
    });
  });
}

// ---- Task list (search + owner + status filter) ----
let taskListData = [];
let taskSearchText = "";
let taskOwnerFilter = "";
let taskStatusFilter = "";
let taskListLoading = false;
const TASK_LIST_DISPLAY_CAP = 150;

// Guards against out-of-order responses: switching tabs quickly fires a new
// loadTaskList() before the previous one's fetch has resolved, and network
// timing doesn't guarantee responses arrive in request order. Without this,
// a slow-but-stale response can land last and silently overwrite the
// current (correct) scope's data with the wrong — or empty, on a failed
// fetch — one. Each call gets a sequence number; a response is only
// applied if it's still the most recent request by the time it resolves.
let taskListRequestSeq = 0;

async function loadTaskList(scope) {
  const requestId = ++taskListRequestSeq;
  taskListLoading = true;
  renderTaskListTable();
  let data;
  try {
    const res = await fetch(`/api/tasklist?scope=${encodeURIComponent(scope)}`);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const json = await res.json();
    data = json.tasks;
  } catch (err) {
    if (requestId !== taskListRequestSeq) return; // superseded — don't clobber newer (possibly successful) data with this failure
    console.error("Failed to load task list:", err);
    data = [];
  }
  if (requestId !== taskListRequestSeq) return; // a newer request already landed; this one is stale
  taskListData = data;
  taskListLoading = false;
  populateOwnerSelect();
  renderTaskListTable();
}

function populateOwnerSelect() {
  const select = document.getElementById("taskOwnerSelect");
  const owners = Array.from(new Set(taskListData.map((t) => t.assignedTo).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  const prevValue = select.value;
  select.innerHTML =
    `<option value="">All owners</option>` + owners.map((o) => `<option value="${o}">${o}</option>`).join("");
  select.value = owners.includes(prevValue) ? prevValue : "";
  if (select.value !== prevValue) taskOwnerFilter = select.value;
}

function filteredTaskList() {
  const q = taskSearchText.trim().toLowerCase();
  const range = dateRangeBounds(currentDateRange);
  return taskListData.filter((t) => {
    if (taskStatusFilter && t.status !== taskStatusFilter) return false;
    if (taskOwnerFilter && t.assignedTo !== taskOwnerFilter) return false;
    if (q && !t.task.toLowerCase().includes(q)) return false;
    // Filtering by deadline specifically (the only per-task date exposed to
    // the client) — tasks with no deadline are excluded once a range is
    // active, same as "undated" tasks drop out of the chart/stat-tile view.
    if (range && !isWithinRange(t.deadline, range)) return false;
    return true;
  });
}

function renderTaskListTable() {
  const wrap = document.getElementById("taskListWrap");
  const countEl = document.getElementById("taskListCount");

  if (taskListLoading) {
    wrap.innerHTML = `<p class="empty-note loading-note"><span class="loading-spinner" aria-hidden="true"></span> Loading tasks…</p>`;
    countEl.textContent = "";
    return;
  }

  const filtered = filteredTaskList();
  const showTeamColumn = currentScope === "total";

  if (taskListData.length === 0) {
    wrap.innerHTML = `<p class="empty-note">No tasks to show for this view.</p>`;
    countEl.textContent = "";
    return;
  }
  if (filtered.length === 0) {
    wrap.innerHTML = `<p class="empty-note">No tasks match your filters.</p>`;
    countEl.textContent = `0 of ${taskListData.length} tasks`;
    return;
  }

  const colCount = showTeamColumn ? 5 : 4;
  const shown = filtered.slice(0, TASK_LIST_DISPLAY_CAP);
  const rows = shown
    .map((t, i) => {
      const teamCell = showTeamColumn ? `<td>${t.teamName}</td>` : "";
      const hasNotes = !!t.notes;
      // Click-to-expand notes: deliberately not persisted across re-renders
      // (search/filter/scope changes all rebuild this table from scratch) —
      // expansion resetting when the underlying list changes is the
      // expected behavior, not a bug, so no state tracking needed here.
      const noteRow = hasNotes
        ? `<tr class="task-note-row" data-note-index="${i}" hidden><td colspan="${colCount}"><span class="task-note-label">Notes:</span> ${escapeHTML(t.notes)}</td></tr>`
        : "";
      return `
      <tr class="${hasNotes ? "has-notes" : ""}" data-note-index="${i}" ${hasNotes ? 'role="button" tabindex="0" aria-expanded="false"' : ""}>
        <td>${escapeHTML(t.task)}${hasNotes ? '<span class="note-indicator" title="Has notes — click to view">Notes</span>' : ""}</td>
        ${teamCell}
        <td>${t.assignedTo ? escapeHTML(t.assignedTo) : '<span class="text-muted-cell">—</span>'}</td>
        <td><span class="badge ${t.status}">${currentData.statusLabels[t.status]}</span></td>
        <td>${t.deadline || '<span class="text-muted-cell">—</span>'}</td>
      </tr>${noteRow}`;
    })
    .join("");

  wrap.innerHTML = `
    <table class="data-table task-list-table">
      <thead>
        <tr>
          <th>Task</th>
          ${showTeamColumn ? "<th>Team</th>" : ""}
          <th>Assigned To</th>
          <th>Status</th>
          <th>Deadline</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  const toggleNote = (tr) => {
    const idx = tr.dataset.noteIndex;
    const noteRow = wrap.querySelector(`tr.task-note-row[data-note-index="${CSS.escape(idx)}"]`);
    if (!noteRow) return;
    noteRow.hidden = !noteRow.hidden;
    tr.setAttribute("aria-expanded", String(!noteRow.hidden));
  };
  wrap.querySelectorAll("tr.has-notes").forEach((tr) => {
    tr.addEventListener("click", () => toggleNote(tr));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleNote(tr);
      }
    });
  });

  const countBits = [`${filtered.length} of ${taskListData.length} tasks`];
  if (filtered.length > TASK_LIST_DISPLAY_CAP) countBits.push(`showing first ${TASK_LIST_DISPLAY_CAP}`);
  countEl.textContent = countBits.join(" · ");
}

function escapeHTML(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderFooter(data) {
  const el = document.getElementById("footer");
  const sheetCount = Object.keys(data.perSheet).length;
  const bits = [`${data.taskCount} tasks across ${sheetCount} sheets`];
  if (data.undated > 0) {
    bits.push(`${data.undated} without a usable date (excluded from the weekly chart, still counted in totals)`);
  }
  el.textContent = bits.join(" · ");
}

async function refresh() {
  const btn = document.getElementById("refreshBtn");
  const label = document.getElementById("refreshLabel");
  const icon = document.getElementById("refreshIcon");
  btn.disabled = true;
  label.textContent = "Refreshing…";
  icon.classList.add("spin");
  try {
    await fetch("/api/refresh", { method: "POST" });
    const data = await loadData();
    render(data);
  } catch (err) {
    console.error(err);
    alert("Couldn't refresh: " + err.message);
  } finally {
    btn.disabled = false;
    label.textContent = "Refresh";
    icon.classList.remove("spin");
  }
}

document.getElementById("refreshBtn").addEventListener("click", refresh);
document.getElementById("reportBtn").addEventListener("click", generateReport);
document.getElementById("reportPdfBtn").addEventListener("click", saveReportAsPdf);
document.getElementById("toggleTableBtn").addEventListener("click", () => {
  const chart = document.getElementById("chartWrap");
  const table = document.getElementById("weeklyTableWrap");
  const btn = document.getElementById("toggleTableBtn");
  const showingTable = !table.hidden;
  table.hidden = showingTable;
  chart.hidden = !showingTable;
  btn.textContent = showingTable ? "View as table" : "View as chart";
});

document.querySelectorAll("#granularityToggle .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const g = btn.dataset.granularity;
    if (g === currentGranularity || !currentData) return;
    currentGranularity = g;
    document.querySelectorAll("#granularityToggle .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderScopedContent(currentData); // not renderScopedView — leave any generated report in place
  });
});

document.getElementById("dateRangeSelect").addEventListener("change", (e) => {
  currentDateRange = e.target.value;
  if (!currentData) return;
  renderScopedContent(currentData); // stat tiles + chart
  renderTaskListTable(); // tasks table — same shared filter, no refetch needed
});

document.querySelectorAll("#reportModeToggle .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const m = btn.dataset.mode;
    if (m === currentReportMode || !currentData) return;
    currentReportMode = m;
    document.querySelectorAll("#reportModeToggle .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("reportWeekSelect").hidden = m !== "summary";
    const scopeLabel = currentScope === "total" ? "Total" : currentData.perSheet[currentScope].name;
    resetReportPanel(scopeLabel);
  });
});

// ---- Reminders (WhatsApp deep-link — https://wa.me/<number>?text=<message>,
// opens WhatsApp with the message pre-filled; the person still hits Send
// themselves inside WhatsApp. No account, no API key, no backend. ) ----
const REMINDER_META = {
  eod: {
    heading: "Send EOD Update Reminder",
    message: (scopeName) =>
      `Reminder: please update today's EOD status for *${scopeName}* in the Task Tracker — log what got done today and update task notes.`,
  },
  plan: {
    heading: "Send Weekly Plan Reminder",
    message: (scopeName) =>
      `Reminder: please log this week's plan for *${scopeName}* in the Task Tracker — what's WIP, what hasn't started, and this week's priorities.`,
  },
  weekcheck: {
    heading: "Send Week Cross-check Reminder",
    message: (scopeName) =>
      `Reminder: please cross-check the status and notes of all *${scopeName}* tasks in the Task Tracker for the whole week before it closes out.`,
  },
};
const REMINDER_NUMBERS_KEY = "taskTrackerReminderNumbers";

function loadReminderNumbers() {
  try {
    return JSON.parse(localStorage.getItem(REMINDER_NUMBERS_KEY)) || {};
  } catch {
    return {};
  }
}
function saveReminderNumbers(n1) {
  try {
    localStorage.setItem(REMINDER_NUMBERS_KEY, JSON.stringify({ n1 }));
  } catch {
    // localStorage unavailable (e.g. private browsing) — not worth failing over
  }
}
function waLink(number, text) {
  const digits = number.replace(/\D/g, ""); // wa.me wants digits only: no +, spaces, dashes, or parens
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function openReminderModal(type) {
  const meta = REMINDER_META[type];
  if (!meta || !currentData) return;
  const scopeName =
    currentScope === "total" ? "all teams" : (currentData.perSheet[currentScope] || {}).name || currentScope;
  document.getElementById("reminderModalHeading").textContent = meta.heading;
  document.getElementById("reminderMessage").value = meta.message(scopeName);
  const saved = loadReminderNumbers();
  document.getElementById("reminderNumber1").value = saved.n1 || "";
  document.getElementById("reminderModalOverlay").hidden = false;
}
function closeReminderModal() {
  document.getElementById("reminderModalOverlay").hidden = true;
}

document.querySelectorAll(".btn-reminder").forEach((btn) => {
  btn.addEventListener("click", () => openReminderModal(btn.dataset.reminder));
});
document.getElementById("reminderCancelBtn").addEventListener("click", closeReminderModal);
document.getElementById("reminderModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "reminderModalOverlay") closeReminderModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("reminderModalOverlay").hidden) closeReminderModal();
});
// Persist on every edit (not just on Send) — a number typed in and then
// cancelled out of should still be there next time the modal opens.
function persistReminderNumberFields() {
  saveReminderNumbers(document.getElementById("reminderNumber1").value.trim());
}
document.getElementById("reminderNumber1").addEventListener("input", persistReminderNumberFields);
document.getElementById("reminderSendBtn").addEventListener("click", () => {
  const n1 = document.getElementById("reminderNumber1").value.trim();
  const message = document.getElementById("reminderMessage").value;
  if (!n1) {
    alert("Enter a phone number.");
    return;
  }
  window.open(waLink(n1, message), "_blank");
  closeReminderModal();
});

// ---- Task list filters ----
document.getElementById("taskSearch").addEventListener("input", (e) => {
  taskSearchText = e.target.value;
  renderTaskListTable();
});
document.getElementById("taskOwnerSelect").addEventListener("change", (e) => {
  taskOwnerFilter = e.target.value;
  renderTaskListTable();
});
document.getElementById("taskStatusSelect").addEventListener("change", (e) => {
  taskStatusFilter = e.target.value;
  renderTaskListTable();
});

// ---- Auto-refresh ----
let liveEnabled = true;
let livePollId = null;

const LIVE_POLL_MS = 10 * 60 * 1000; // was 5 min, then 30s before that — each drop was to ease load on the Apps Script sources, which rate-limit under concurrent/frequent requests and intermittently return empty data when tripped

function startLivePolling() {
  if (livePollId) return;
  livePollId = setInterval(() => {
    loadData().then(silentRefresh).catch((err) => console.error("Auto-refresh failed:", err));
  }, LIVE_POLL_MS);
}
function stopLivePolling() {
  clearInterval(livePollId);
  livePollId = null;
}

document.getElementById("liveToggle").addEventListener("click", () => {
  liveEnabled = !liveEnabled;
  const toggle = document.getElementById("liveToggle");
  toggle.classList.toggle("active", liveEnabled);
  document.getElementById("liveLabel").textContent = liveEnabled ? "Live" : "Paused";
  toggle.title = liveEnabled ? "Auto-refreshes every 10 min — click to pause" : "Auto-refresh paused — click to resume";
  if (liveEnabled) startLivePolling();
  else stopLivePolling();
});
startLivePolling();

window.addEventListener("resize", () => {
  if (currentData) renderSeriesChart(scopedView(currentData).series);
  const activeBtn = document.querySelector(".tab-btn.active");
  if (activeBtn) moveTabIndicator(activeBtn);
});

function hideLoadingOverlay() {
  const el = document.getElementById("loadingOverlay");
  if (!el) return;
  el.classList.add("loading-overlay-hidden");
  setTimeout(() => { el.hidden = true; }, 300);
}

loadData()
  .then((data) => {
    render(data);
    hideLoadingOverlay();
  })
  .catch((err) => {
    document.getElementById("app").innerHTML = `<p style="padding:40px;color:#e34948">Failed to load dashboard: ${err.message}</p>`;
    hideLoadingOverlay();
  });
