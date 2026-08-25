// Persists one JSON blob per calendar day of the last known-live rows for
// each team, so a report generated today can diff against what the sheets
// looked like on a previous day (see diffTasks.js).
//
// Stored in Vercel Blob, NOT the local filesystem. This file intentionally
// diverges from the main project's lib/snapshotStore.js (which uses
// node:fs and works fine for local dev, where the disk is real and
// persistent). Vercel's serverless functions get a read-only filesystem at
// runtime — only /tmp is writable, and /tmp doesn't survive between
// separate invocations/cold starts — so a filesystem write here would
// either throw outright or silently vanish before tomorrow's cron run ever
// saw it. Requires a Blob store connected to this project (Vercel
// dashboard → Storage → Connect Store), which provisions the
// BLOB_READ_WRITE_TOKEN env var these calls read implicitly.
import { put, get, list } from "@vercel/blob";
import { todayIST, toISODate } from "./dateUtils.js";

const SNAPSHOT_PREFIX = "snapshots/";
const SNAPSHOT_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
// UTC hour the Vercel cron fires (vercel.json: "0 6 * * *") — checked
// against the same clock the cron itself uses, not local/IST, since this
// gate exists to stop an earlier ad-hoc call (a page load, not the cron)
// from locking in a stale pre-cron state as "today"'s snapshot.
const SNAPSHOT_HOUR = 6;

function todayISO() {
  return toISODate(todayIST());
}

function pathFor(dateISO) {
  return `${SNAPSHOT_PREFIX}${dateISO}.json`;
}

async function readBlobJSON(pathname) {
  const result = await get(pathname, { access: "private" });
  if (!result) return null;
  return new Response(result.stream).json();
}

/** Write today's snapshot with the latest known-live rows, keyed by team —
 * but only once per calendar day, no earlier than SNAPSHOT_HOUR. Call this
 * after every successful live fetch; it's a no-op before that hour (so an
 * early request doesn't lock in a stale pre-cron state as "today"), and a
 * no-op once today's blob exists (so later calls that day are cheap and
 * skip the write). Whichever fetch is first at/after SNAPSHOT_HOUR each day
 * is what tomorrow's diff compares against. Teams without a live source
 * (demo, empty) are left out entirely so they never overwrite real prior
 * data with placeholders — comparisons for those teams just have nothing
 * to diff against, which is correct. */
export async function saveTodaySnapshot(sheets, sources) {
  const liveRows = {};
  for (const [key, sheet] of Object.entries(sheets)) {
    if (sources[key] === "live") liveRows[key] = sheet.rows;
  }
  if (Object.keys(liveRows).length === 0) return;
  if (new Date().getUTCHours() < SNAPSHOT_HOUR) return;

  const pathname = pathFor(todayISO());
  const existing = await get(pathname, { access: "private" });
  if (existing) return; // already captured today

  await put(pathname, JSON.stringify(liveRows), { access: "private", contentType: "application/json" });
}

/** The most recent snapshot strictly before `beforeDate` (default: today) —
 * {date, sheets} — or null if none exists yet (first day of use, or no live
 * fetch has ever succeeded). `sheets` is keyed by team, same shape as
 * saveTodaySnapshot's input. Pass an explicit `beforeDate` (YYYY-MM-DD) to
 * find what a *past* day's EOD report should diff against — otherwise this
 * always compares against today, which is wrong for a historical recap. */
export async function loadPreviousSnapshot(beforeDate) {
  const cutoff = beforeDate || todayISO();
  const { blobs } = await list({ prefix: SNAPSHOT_PREFIX });
  const dates = blobs
    .map((b) => b.pathname.slice(SNAPSHOT_PREFIX.length).match(SNAPSHOT_FILE_RE))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((d) => d < cutoff)
    .sort();
  if (dates.length === 0) return null;

  const latest = dates[dates.length - 1];
  const sheets = await readBlobJSON(pathFor(latest));
  return sheets ? { date: latest, sheets } : null;
}

/** The snapshot captured for one specific calendar date (YYYY-MM-DD) — or
 * null if none was captured that day (no live fetch happened at/after
 * SNAPSHOT_HOUR that day). Used to build a historical EOD report for a day
 * other than today: `loadPreviousSnapshot` finds what to diff *from*, this
 * finds the day itself to diff *to*. */
export async function loadSnapshotForDate(dateISO) {
  const sheets = await readBlobJSON(pathFor(dateISO));
  return sheets ? { date: dateISO, sheets } : null;
}
