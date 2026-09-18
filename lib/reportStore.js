// Persists the most recently generated report for each (scope, mode, week-
// or-day) combination, so the report panel survives a page reload, the
// manual Refresh button, and different devices/browsers — not just the tab
// that generated it.
//
// Stored in MongoDB (see mongoClient.js) — this file previously used Vercel
// Blob, moved off it after an account-wide Blob restriction (triggered by a
// limit hit in a different project sharing the same Vercel account) took
// every Blob-backed feature here down with it.
import { getDb } from "./mongoClient.js";

const COLLECTION = "reports";

function keyFor(scope, mode, extra) {
  // extra is a week (YYYY-MM-DD Monday) or day (YYYY-MM-DD) or "" (plan
  // mode, or summary/eod with no explicit selection).
  return `${scope}__${mode}__${extra || "none"}`;
}

/** Save the report just generated for (scope, mode, extra) — overwrites
 * whatever was there before, since this is "the latest generated report for
 * this combo," not a history. */
export async function saveReport(scope, mode, extra, { report, dateLabel }) {
  const col = (await getDb()).collection(COLLECTION);
  await col.updateOne(
    { _id: keyFor(scope, mode, extra) },
    { $set: { report, dateLabel, generatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

/** The most recently generated report for (scope, mode, extra), or null if
 * none has ever been generated for that exact combo. */
export async function loadReport(scope, mode, extra) {
  const col = (await getDb()).collection(COLLECTION);
  const doc = await col.findOne({ _id: keyFor(scope, mode, extra) });
  if (!doc) return null;
  return { report: doc.report, dateLabel: doc.dateLabel, generatedAt: doc.generatedAt };
}
