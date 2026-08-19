// Shared data-fetch-and-aggregate path for every API route. Mirrors the
// non-Vercel version's getDashboardData() in server.js, minus the
// local-server-only pieces: no setInterval heartbeat (nothing stays
// resident between invocations on Vercel — see api/cron-snapshot.js for how
// daily capture is triggered instead), and no snapshot-saving here (that's
// the cron job's job exclusively, so a normal page load never pays for a
// Blob write on a cache miss).
import { SHEETS } from "../config/sheets.js";
import { fetchSheetRows } from "./sheetsClient.js";
import { SAMPLE_DATA } from "../data/sampleData.js";
import { aggregate } from "./aggregate.js";

const CACHE_MS = 60_000;

// Module-level state persists only for as long as this function instance
// stays warm — Vercel may reuse an instance across nearby requests, or may
// not; there's no guarantee either way. Treat this purely as a best-effort
// optimization, never as something correctness depends on (unlike the
// local-server version, where the process is guaranteed to stay alive).
let cache = { at: 0, payload: null, rawSheets: null };

export function clearCache() {
  cache = { at: 0, payload: null, rawSheets: null };
}

// Survives across loadAllSheets() calls within the same warm instance
// (unlike `cache` above, which is fully replaced each time) so a transient
// fetch failure for one team can fall back to that team's last successful
// live rows instead of dropping straight to demo/empty. Best-effort only,
// same caveat as `cache` — a cold instance starts with nothing to fall
// back to.
const lastGoodRows = {};

async function fetchOneSheet(cfg) {
  let rows = null;
  let source = "demo";
  try {
    rows = await fetchSheetRows(cfg);
    if (rows && rows.length >= 0 && (cfg.sheetId || cfg.csvUrl || cfg.appScriptUrl)) {
      source = "live";
      lastGoodRows[cfg.key] = rows;
    }
  } catch (err) {
    console.error(`[sheets] ${cfg.name}: ${err.message}`);
  }
  if (!rows) {
    if (lastGoodRows[cfg.key]) {
      rows = lastGoodRows[cfg.key];
      source = "live";
    } else {
      rows = SAMPLE_DATA[cfg.key] || [];
      source = rows.length ? "demo" : "empty";
    }
  }
  return { key: cfg.key, name: cfg.name, rows, source };
}

async function loadAllSheets() {
  // Tried serializing the Apps Script fetches here on the theory that a
  // per-account simultaneous-execution limit was the cause of teams
  // randomly showing no data. Reverted: live logs showed 3 of 4 Apps
  // Script sheets failing on *every* attempt (both retries) in the same
  // cycle, not just one loser — that's a sustained failure (likely a
  // daily account-level quota, exhausted by testing), not a brief
  // concurrency overlap. Serializing only made it worse, turning each
  // sheet's own ~15s timeout into an additive 90s+ page load instead of a
  // shared ~15s parallel wait. Back to parallel; lib/sheetsClient.js's
  // shorter per-attempt timeout and single attempt (no retry) now bound
  // the worst case, and lastGoodRows below covers the rest.
  const results = await Promise.all(SHEETS.map(fetchOneSheet));

  const sheets = {};
  const sources = {};
  for (const r of results) {
    sheets[r.key] = { name: r.name, rows: r.rows };
    sources[r.key] = r.source;
  }

  return { sheets, sources };
}

export async function getDashboardData() {
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_MS) {
    return cache;
  }
  const { sheets, sources } = await loadAllSheets();
  const result = aggregate(sheets);
  const payload = { ...result, sources };
  cache = { at: now, payload, rawSheets: sheets };
  return cache;
}
