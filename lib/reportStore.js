// Persists the most recently generated report for each (scope, mode, week-
// or-day) combination, so the report panel survives a page reload, the
// manual Refresh button, and different devices/browsers — not just the tab
// that generated it.
//
// Stored in MongoDB (see mongoClient.js) — this file previously used Vercel
// Blob, moved off it after an account-wide Blob restriction (triggered by a
// limit hit in a different project sharing the same Vercel account) took
// every Blob-backed feature here down with it.
//
// Unlike snapshots (one per calendar day forever, needed indefinitely for
// historical day-picker reports), this collection has no natural ceiling —
// every distinct (scope, mode, day/week) combination anyone ever generates
// via the day-picker gets its own permanent document. Over months of normal
// use that's unbounded growth for a feature whose only purpose is "survive
// a reload," so documents auto-expire via a TTL index instead of sticking
// around forever.
import { getDb } from "./mongoClient.js";

const COLLECTION = "reports";
const TTL_DAYS = 45;

function keyFor(scope, mode, extra) {
  // extra is a week (YYYY-MM-DD Monday) or "" (plan mode, or summary/eow
  // with no explicit week selected).
  return `${scope}__${mode}__${extra || "none"}`;
}

// Created lazily on first save rather than on every getDb() call (which
// every store shares) — createIndex is idempotent and cheap once the index
// exists, but there's no reason to pay even that per read. Once per warm
// instance is enough.
let indexEnsured = false;
async function ensureIndex(col) {
  if (indexEnsured) return;
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  indexEnsured = true;
}

/** Save the report just generated for (scope, mode, extra) — overwrites
 * whatever was there before, since this is "the latest generated report for
 * this combo," not a history. Refreshes the TTL on every save, so a report
 * someone keeps regenerating stays alive; one nobody's touched in
 * TTL_DAYS quietly expires. */
export async function saveReport(scope, mode, extra, { report, dateLabel }) {
  const col = (await getDb()).collection(COLLECTION);
  await ensureIndex(col);
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
  await col.updateOne(
    { _id: keyFor(scope, mode, extra) },
    { $set: { report, dateLabel, generatedAt: new Date().toISOString(), expiresAt } },
    { upsert: true }
  );
}

/** The most recently generated report for (scope, mode, extra), or null if
 * none has ever been generated for that exact combo (or it's since
 * expired). */
export async function loadReport(scope, mode, extra) {
  const col = (await getDb()).collection(COLLECTION);
  const doc = await col.findOne({ _id: keyFor(scope, mode, extra) });
  if (!doc) return null;
  return { report: doc.report, dateLabel: doc.dateLabel, generatedAt: doc.generatedAt };
}
