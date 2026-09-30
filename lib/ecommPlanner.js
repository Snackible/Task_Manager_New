// Fetches and parses Ecomm's "current tracker" tab (gid=0) — this replaces
// the old "EOD" tab (see config/sheets.js) because the team actually keeps
// this one up to date, but it needs real parsing, not just a header row:
//
//  - It's not one flat table. Each week's block has its own banner row
//    ("28th Sept to 3rd Oct", "21th Sept to 26th Sept", ...) scattered
//    through the sheet, not just one at the very top — every one of those
//    has to be dropped, not just the first.
//  - The task's own title has no column header at all: the real header row
//    is "Portal | <blank> | Notes | Date | Status | Section". The shared
//    CSV parser's collision fix (see csv.js) names that blank column
//    "Column 2" positionally; renamed here to "Task" so every existing
//    lookup (aiReport.js, eowReport.js, taskList.js, ...) picks it up
//    unchanged, no candidate-list changes needed anywhere else.
//  - Portal (Zepto/Blinkit/Instamart/...) is only written on the first row
//    of its group — a merged-cell pattern — so every blank cell below it
//    needs to inherit the portal above it.
import { parseCSV, rowsToObjects } from "./csv.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/1W2S-smCzfRFUk6MqbHxhEQ4I_xvAUYJr04NtfAmwURs/export?format=csv&gid=0";

// Every week-banner row observed so far starts with a bare day-of-month
// plus its ordinal suffix ("28th", "21th" — misspelled in the sheet, still
// matches — "3rd", "10th") followed by a month name. No real task title in
// this sheet starts that way, so this is a narrow, safe discriminator —
// deliberately not a broad "contains the word 'to'" match, which would also
// eat a legitimate task like "Get Priya to check why...".
const WEEK_BANNER_RE = /^\d{1,2}(st|nd|rd|th)\s/i;

export async function fetchEcommPlannerRows() {
  const res = await fetchWithTimeout(CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch Ecomm planner CSV (${res.status})`);
  const rows = parseCSV(await res.text());

  // The real header ("Portal, <blank>, Notes, Date, Status, Section") is the
  // first row that populates more than one column — row 0 is always that
  // first week's banner, which only ever populates column A.
  const headerIdx = rows.findIndex((r) => r.filter((c) => c.trim() !== "").length > 1);
  if (headerIdx === -1) return [];

  const cleaned = [rows[headerIdx]];
  let currentPortal = "";
  for (const row of rows.slice(headerIdx + 1)) {
    const portalCell = (row[0] || "").trim();
    if (WEEK_BANNER_RE.test(portalCell)) continue; // a new week's banner, not a data row
    if (portalCell) currentPortal = portalCell;
    const withPortal = row.slice();
    withPortal[0] = currentPortal;
    cleaned.push(withPortal);
  }

  return rowsToObjects(cleaned).map((obj) => ({ ...obj, Task: obj["Column 2"], Portal: obj["Portal"] }));
}
