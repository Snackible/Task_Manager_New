// Persists one JSON file per calendar day of the last known-live rows for
// each team, so a report generated today can diff against what the sheets
// looked like on a previous day (see diffTasks.js). This is the only piece
// of state in the app that survives a server restart — everything else
// (the getDashboardData cache) is deliberately in-memory and disposable.
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { todayIST, toISODate } from "./dateUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, "..", "data", "snapshots");
const SNAPSHOT_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
// Matches the Vercel-deployed version's cron time (0 6 * * *) so the daily
// capture reflects roughly the same point in the day everywhere this app
// runs, in local time since this process (unlike the Vercel cron) has no
// fixed timezone convention of its own.
const SNAPSHOT_HOUR = 6;

function todayISO() {
  return toISODate(todayIST());
}

async function ensureDir() {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
}

/** Write today's snapshot with the latest known-live rows, keyed by team —
 * but only once per calendar day, no earlier than SNAPSHOT_HOUR. Call this
 * after every successful live fetch; it's a no-op before that hour (so an
 * early-morning request doesn't lock in a stale pre-6am state as "today"),
 * and a no-op once today's file exists (so later calls that day — heartbeat
 * ticks, page loads — are cheap and skip the write). Whichever fetch is
 * first at/after SNAPSHOT_HOUR each day is what tomorrow's diff compares
 * against. Teams without a live source that run (demo, empty) are left out
 * entirely so they never overwrite real prior data with placeholders —
 * comparisons for those teams just have nothing to diff against, which is
 * correct. */
export async function saveTodaySnapshot(sheets, sources) {
  const liveRows = {};
  for (const [key, sheet] of Object.entries(sheets)) {
    if (sources[key] === "live") liveRows[key] = sheet.rows;
  }
  if (Object.keys(liveRows).length === 0) return;
  if (new Date().getHours() < SNAPSHOT_HOUR) return;
  await ensureDir();
  const file = path.join(SNAPSHOT_DIR, `${todayISO()}.json`);
  try {
    await stat(file);
    return; // already captured today
  } catch {
    // no file yet — fall through and write it
  }
  await writeFile(file, JSON.stringify(liveRows), "utf8");
}

/** The most recent snapshot strictly before `beforeDate` (default: today) —
 * {date, sheets} — or null if none exists yet (first day of use, or no live
 * fetch has ever succeeded). `sheets` is keyed by team, same shape as
 * saveTodaySnapshot's input. Pass an explicit `beforeDate` (YYYY-MM-DD) to
 * find what a *past* day's EOD report should diff against — otherwise this
 * always compares against today, which is wrong for a historical recap. */
export async function loadPreviousSnapshot(beforeDate) {
  let files;
  try {
    files = await readdir(SNAPSHOT_DIR);
  } catch {
    return null; // directory doesn't exist yet — nothing captured so far
  }
  const cutoff = beforeDate || todayISO();
  const dates = files
    .map((f) => f.match(SNAPSHOT_FILE_RE))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((d) => d < cutoff)
    .sort();
  if (dates.length === 0) return null;

  const latest = dates[dates.length - 1];
  const raw = await readFile(path.join(SNAPSHOT_DIR, `${latest}.json`), "utf8");
  return { date: latest, sheets: JSON.parse(raw) };
}

/** The snapshot captured for one specific calendar date (YYYY-MM-DD) — or
 * null if none was captured that day (server wasn't running around
 * snapshot time, or every live fetch that day failed). Used to build a
 * historical EOD report for a day other than today: `loadPreviousSnapshot`
 * finds what to diff *from*, this finds the day itself to diff *to*. */
export async function loadSnapshotForDate(dateISO) {
  try {
    const raw = await readFile(path.join(SNAPSHOT_DIR, `${dateISO}.json`), "utf8");
    return { date: dateISO, sheets: JSON.parse(raw) };
  } catch {
    return null;
  }
}
