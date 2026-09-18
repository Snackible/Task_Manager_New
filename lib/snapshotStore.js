// Persists one document per calendar day of the last known-live rows for
// each team, so a report generated today can diff against what the sheets
// looked like on a previous day (see diffTasks.js).
//
// Stored in MongoDB (see mongoClient.js) — this file previously used Vercel
// Blob, moved off it after an account-wide Blob restriction (triggered by a
// limit hit in a different project sharing the same Vercel account) took
// every Blob-backed feature here down with it. Requires a MONGODB_URI
// environment variable (a free MongoDB Atlas cluster works fine).
import { getDb } from "./mongoClient.js";
import { todayIST, toISODate } from "./dateUtils.js";

const COLLECTION = "snapshots";
// UTC hour the Vercel cron fires (vercel.json: "30 0 * * *", i.e. 6:00 AM
// IST). Checked against the same clock the cron itself uses, not
// local/IST, since this gate exists to stop an earlier ad-hoc call (a page
// load, not the cron) from locking in a stale pre-cron state.
const SNAPSHOT_HOUR = 0;

function todayISO() {
  return toISODate(todayIST());
}

/** The calendar date (YYYY-MM-DD) that a snapshot captured right now should
 * be filed under. The cron fires early morning IST, before that day's work
 * has started — so whatever it captures is really still the *previous*
 * day's closing state, not "today's". Filing it under yesterday's date
 * keeps every reader's assumption intact (loadPreviousSnapshot /
 * loadSnapshotForDate both expect the document keyed by date X to hold X's
 * actual closing state) without needing to touch the read side at all. */
function effectiveSnapshotDate() {
  const yesterday = new Date(todayIST());
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return toISODate(yesterday);
}

/** Write a snapshot of the latest known-live rows, keyed by team, filed
 * under yesterday's date (see effectiveSnapshotDate) — but only once per
 * calendar day, no earlier than SNAPSHOT_HOUR. Call this after every
 * successful live fetch; it's a no-op before that hour (so an early
 * request doesn't lock in a stale pre-cron state), and a no-op once that
 * date's document exists (so later calls that day are cheap and skip the
 * write). Teams without a live source (demo, empty) are left out entirely
 * so they never overwrite real prior data with placeholders — comparisons
 * for those teams just have nothing to diff against, which is correct. */
export async function saveTodaySnapshot(sheets, sources) {
  const liveRows = {};
  for (const [key, sheet] of Object.entries(sheets)) {
    if (sources[key] === "live") liveRows[key] = sheet.rows;
  }
  if (Object.keys(liveRows).length === 0) return;
  if (new Date().getUTCHours() < SNAPSHOT_HOUR) return;

  const col = (await getDb()).collection(COLLECTION);
  const _id = effectiveSnapshotDate();
  const existing = await col.findOne({ _id }, { projection: { _id: 1 } });
  if (existing) return; // already captured for this date

  await col.insertOne({ _id, sheets: liveRows, createdAt: new Date() });
}

/** The most recent snapshot strictly before `beforeDate` (default: today) —
 * {date, sheets} — or null if none exists yet (first day of use, or no live
 * fetch has ever succeeded). `sheets` is keyed by team, same shape as
 * saveTodaySnapshot's input. Pass an explicit `beforeDate` (YYYY-MM-DD) to
 * find what a *past* day's EOD report should diff against — otherwise this
 * always compares against today, which is wrong for a historical recap. */
export async function loadPreviousSnapshot(beforeDate) {
  const cutoff = beforeDate || todayISO();
  const col = (await getDb()).collection(COLLECTION);
  // _id is a YYYY-MM-DD string, which sorts lexicographically identically
  // to chronological order, so a plain string comparison/sort works.
  const doc = await col.find({ _id: { $lt: cutoff } }).sort({ _id: -1 }).limit(1).next();
  return doc ? { date: doc._id, sheets: doc.sheets } : null;
}

/** The snapshot captured for one specific calendar date (YYYY-MM-DD) — or
 * null if none was captured that day (no live fetch happened at/after
 * SNAPSHOT_HOUR that day). Used to build a historical EOD report for a day
 * other than today: `loadPreviousSnapshot` finds what to diff *from*, this
 * finds the day itself to diff *to*. */
export async function loadSnapshotForDate(dateISO) {
  const col = (await getDb()).collection(COLLECTION);
  const doc = await col.findOne({ _id: dateISO });
  return doc ? { date: doc._id, sheets: doc.sheets } : null;
}
