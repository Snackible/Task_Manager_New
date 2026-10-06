// Fetches and parses Ecomm's "current tracker" tab (gid=0) — this replaces
// the old "EOD" tab (see config/sheets.js) because the team actually keeps
// this one up to date, but it needs real parsing, not just a header row.
//
// How the sheet works: it's a weekly plan, newest week at the TOP. Each week
// is a block that starts with a banner row ("5th Oct to 9th Oct"), followed
// by groups of tasks per portal (Blinkit, Instamart, Zepto, ... plus
// "Website", "Others" and "All" for non-marketplace work). The whole week's
// tasks are typed in up front with no Date and no Status; as each one is
// actioned during the week its Date (the day it was done / last updated) and
// Status (Complete / WIP / Pending / Recurring) get filled in. So:
//
//  - A task with no Date isn't undated — it's planned for that week and not
//    touched yet. It gets the week's start (the banner's first day) as its
//    date, otherwise every untouched planned task (and every task in a week
//    nobody dated, like "7th Sept to 11th Sept") would look like it has no
//    date at all.
//  - The Date column is hand-typed (DD/MM/YYYY) and sometimes wrong — e.g.
//    "01/09/2026" inside the 28 Sept week, meant as 1 Oct. A date outside
//    its own week is first retried against the week's months, then with day
//    and month swapped, and finally falls back to the week's start.
//  - The task's own title has no column header at all: the real header row
//    is "Portal | <blank> | Notes | Date | Status | Section". The shared
//    CSV parser's collision fix (see csv.js) names that blank column
//    "Column 2" positionally; renamed here to "Task" so every existing
//    lookup (aiReport.js, eowReport.js, taskList.js, ...) picks it up
//    unchanged, no candidate-list changes needed anywhere else.
//  - Portal is only written on the first row of its group — a merged-cell
//    pattern — so every blank cell below it inherits the portal above it.
//  - Columns past "Section" hold stray scratch notes in some older rows;
//    they're ignored.
import { parseCSV, rowsToObjects } from "./csv.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { parseSheetDate, todayIST, toISODate } from "./dateUtils.js";

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/1W2S-smCzfRFUk6MqbHxhEQ4I_xvAUYJr04NtfAmwURs/export?format=csv&gid=0";

// Every week-banner row observed so far starts with a bare day-of-month
// plus its ordinal suffix ("28th", "21th" — misspelled in the sheet, still
// matches — "3rd", "10th") followed by a month name. No real task title in
// this sheet starts that way, so this is a narrow, safe discriminator —
// deliberately not a broad "contains the word 'to'" match, which would also
// eat a legitimate task like "Get Priya to check why...".
const WEEK_BANNER_RE = /^\d{1,2}(st|nd|rd|th)\s/i;
// "5th Oct to 9th Oct", "28th Sept to 3rd Oct", "21th Sept to 26th Sept" —
// the first month is sometimes omitted ("5th to 9th Oct").
const WEEK_RANGE_RE = /^(\d{1,2})(?:st|nd|rd|th)\s*(?:([a-z]+)\s*)?to\s*(\d{1,2})(?:st|nd|rd|th)\s*([a-z]+)/i;
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DAY_MS = 24 * 60 * 60 * 1000;

function monthFromName(name) {
  return MONTH_INDEX[String(name || "").slice(0, 3).toLowerCase()];
}

/** {start, windowEnd} (UTC-midnight Dates) for a banner, or null if it
 * doesn't parse. Banners carry no year, so it's inferred: the latest year
 * that doesn't put the week's end more than ~2 months in the future (the
 * sheet only ever holds the current week and older ones). windowEnd is the
 * Sunday after the week starts, since the team sometimes logs on the
 * Saturday even when the banner says Mon–Fri. */
function parseWeekBanner(text) {
  const m = text.match(WEEK_RANGE_RE);
  if (!m) return null;
  const endMonth = monthFromName(m[4]);
  const startMonth = m[2] ? monthFromName(m[2]) : endMonth;
  if (endMonth === undefined || startMonth === undefined) return null;

  const today = todayIST();
  let year = today.getUTCFullYear();
  if (Date.UTC(year, endMonth, +m[3]) > today.getTime() + 60 * DAY_MS) year -= 1;
  const startYear = startMonth > endMonth ? year - 1 : year;

  const start = new Date(Date.UTC(startYear, startMonth, +m[1]));
  return { start, windowEnd: new Date(start.getTime() + 6 * DAY_MS) };
}

/** The date a task row should carry: its own Date cell if it falls inside
 * its week, a repaired version of it if that's a recognisable typo, else the
 * week's start (planned for the week, not touched yet). */
function resolveTaskDate(cell, week) {
  const d = parseSheetDate(cell);
  const inWeek = (x) => x.getTime() >= week.start.getTime() && x.getTime() <= week.windowEnd.getTime();
  if (d && inWeek(d)) return d;
  if (d) {
    const day = d.getUTCDate();
    const candidates = [week.start, week.windowEnd].map(
      (ref) => new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), day))
    );
    if (day <= 12) candidates.push(new Date(Date.UTC(d.getUTCFullYear(), day - 1, d.getUTCMonth() + 1)));
    const fixed = candidates.find(inWeek);
    if (fixed) return fixed;
  }
  return week.start;
}

export async function fetchEcommPlannerRows() {
  const res = await fetchWithTimeout(CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch Ecomm planner CSV (${res.status})`);
  const rows = parseCSV(await res.text());

  // The real header ("Portal, <blank>, Notes, Date, Status, Section") is the
  // first row that populates more than one column — row 0 is always that
  // first week's banner, which only ever populates column A.
  const headerIdx = rows.findIndex((r) => r.filter((c) => c.trim() !== "").length > 1);
  if (headerIdx === -1) return [];

  const header = rows[headerIdx];
  const taskCol = header.findIndex((h, i) => i > 0 && h.trim() === "");
  const dateCol = header.findIndex((h) => h.trim().toLowerCase() === "date");

  const cleaned = [header];
  let currentPortal = "";
  let currentWeek = null;
  for (const row of rows.slice(headerIdx + 1)) {
    const portalCell = (row[0] || "").trim();
    if (WEEK_BANNER_RE.test(portalCell)) {
      currentWeek = parseWeekBanner(portalCell); // a new week's banner, not a data row
      continue;
    }
    if (portalCell) currentPortal = portalCell;
    const withPortal = row.slice();
    withPortal[0] = currentPortal;
    if (currentWeek && dateCol !== -1 && taskCol !== -1 && (row[taskCol] || "").trim()) {
      withPortal[dateCol] = toISODate(resolveTaskDate(row[dateCol], currentWeek));
    }
    cleaned.push(withPortal);
  }

  return rowsToObjects(cleaned).map((obj) => ({ ...obj, Task: obj["Column 2"], Portal: obj["Portal"] }));
}
