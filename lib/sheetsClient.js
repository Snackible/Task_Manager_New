import { parseCSV, rowsToObjects } from "./csv.js";
import { getAccessToken } from "./sheetsAuth.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Build a CSV export URL for a sheet tab addressed by NAME instead of gid,
 * via Google's gviz query endpoint — for teams that create a new tab every
 * month (e.g. "August 26") instead of reusing one gid forever. Computed
 * fresh from the given date (default: right now), so a config entry using
 * this never goes stale when the month rolls over — no manual gid update
 * needed. Assumes the "{Month name} {2-digit year}" naming pattern; if a
 * team's tabs follow a different pattern, this won't apply to them as-is.
 */
export function monthlyTabCsvUrl(sheetId, date = new Date()) {
  const month = MONTH_NAMES[date.getMonth()];
  const yy = String(date.getFullYear()).slice(-2);
  const sheetName = `${month} ${yy}`;
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

/**
 * Fetch one sheet's rows as an array of objects (keyed by its header row).
 * Returns null if this sheet slot has no source configured, so the caller
 * can fall back to bundled demo data.
 */
export async function fetchSheetRows(sheetConfig) {
  if (sheetConfig.appScriptUrl) {
    return fetchViaAppScript(sheetConfig.appScriptUrl);
  }
  if (sheetConfig.csvUrl) {
    // csvUrl may be a single URL (most teams), an array (a team whose tasks
    // are split across multiple tabs in the same spreadsheet), or a function
    // (a team whose current tab needs computing fresh each call, e.g. via
    // monthlyTabCsvUrl) — resolve it to one-or-many URLs, fetch all, and
    // concatenate rows into one team, in order. An array entry can also be
    // `{ url, subTab }` instead of a bare string, to tag every row it
    // produces with which sheet tab it actually came from (e.g. Finance's
    // "Daily" tab vs its "Weekly" tab) — lib/taskList.js and lib/aiReport.js
    // both read this to let a team's sub-tabs be viewed/reported separately
    // instead of silently merged into one indistinguishable list.
    const resolved = typeof sheetConfig.csvUrl === "function" ? sheetConfig.csvUrl() : sheetConfig.csvUrl;
    const specs = Array.isArray(resolved) ? resolved : [resolved];
    const results = await Promise.all(
      specs.map(async (spec) => {
        const isTagged = typeof spec === "object" && spec !== null;
        const rows = await fetchViaCSV(isTagged ? spec.url : spec);
        if (isTagged && spec.subTab) {
          for (const row of rows) row.__subTab = spec.subTab;
        }
        return rows;
      })
    );
    return results.flat();
  }
  if (sheetConfig.sheetId) {
    const token = await getAccessToken();
    if (token) {
      return fetchViaAPI(sheetConfig.sheetId, sheetConfig.tab || "Sheet1", token);
    }
    // No service-account creds configured — try the public CSV export as a
    // last resort (works if the sheet is shared "Anyone with the link").
    const publicCsvUrl = `https://docs.google.com/spreadsheets/d/${sheetConfig.sheetId}/export?format=csv`;
    try {
      return await fetchViaCSV(publicCsvUrl);
    } catch {
      return null;
    }
  }
  return null;
}

// Apps Script web apps have per-account execution limits, and all 4 of our
// appScriptUrl sheets can be owned by the same Google account. Observed
// failures haven't been brief single-request blips — logs have shown 3 of
// 4 Apps Script sheets failing on every attempt within the same cycle,
// which looks like a sustained condition (e.g. a daily quota run dry from
// heavy testing) rather than something a quick retry clears. So: don't
// retry (a same-second retry against a sustained failure just doubles the
// wait for the same outcome) and use a shorter timeout than the app's
// general default, so one bad sheet can't hold up the whole page load —
// getDashboardData()'s lastGoodRows fallback covers the gap until the next
// cache cycle finds it recovered.
const APPSCRIPT_TIMEOUT_MS = 8000;

/**
 * Fetch rows from a sheet-bound Apps Script web app (see appscript/Code.gs).
 * Expects the same shape as the Sheets API: a JSON 2D array with the header
 * row first, e.g. [["Task","Assigned By",...], ["Fix login","Aditi",...]].
 */
async function fetchViaAppScript(url) {
  const res = await fetchWithTimeout(url, { redirect: "follow" }, APPSCRIPT_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`Apps Script fetch failed (${res.status}): ${url}`);
  }
  const values = await res.json();
  if (!Array.isArray(values)) {
    throw new Error(`Unexpected Apps Script response shape for ${url}`);
  }
  return rowsToObjects(values);
}

async function fetchViaCSV(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch CSV (${res.status}): ${url}`);
  }
  const text = await res.text();
  return rowsToObjects(parseCSV(text));
}

async function fetchViaAPI(sheetId, tab, token) {
  const range = encodeURIComponent(tab);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?majorDimension=ROWS`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sheets API error (${res.status}) for ${sheetId}: ${text}`);
  }
  const json = await res.json();
  const values = json.values || [];
  return rowsToObjects(values);
}
