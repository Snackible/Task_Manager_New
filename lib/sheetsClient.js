import { parseCSV, rowsToObjects } from "./csv.js";
import { getAccessToken } from "./sheetsAuth.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

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
    // csvUrl may be a single URL (most teams) or an array (a team whose
    // tasks are split across multiple tabs in the same spreadsheet, e.g. a
    // separate "Weekly" tab alongside the main one) — fetch every URL and
    // concatenate their rows into one team, in array order.
    const urls = Array.isArray(sheetConfig.csvUrl) ? sheetConfig.csvUrl : [sheetConfig.csvUrl];
    const results = await Promise.all(urls.map(fetchViaCSV));
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
