// Persists one document per (department scope, week) recording that week's
// carried-over items, completion count, and reporting status — the memory
// that makes the End of Week report's accountability features possible.
// Without this, every week's report would be computed in isolation with no
// way to tell a brand-new open item from one that's been stuck for three
// weeks running, which is the entire point of the redesign this report is
// built from (see lib/eowReport.js).
//
// Stored in MongoDB (see mongoClient.js), same pattern as the other stores.
import { getDb } from "./mongoClient.js";

const COLLECTION = "weeklyTracking";

function keyFor(scope, weekStart) {
  return `${scope}__${weekStart}`;
}

/** The saved ledger entry for (scope, weekStart) — the previous week's
 * carried-over list, completion count, and non-reporting streak — or null
 * if that department/week combo has never been computed (first tracked
 * week, or storage is unavailable). Callers should treat null the same as
 * "start counting from this week" rather than fail. */
export async function loadWeeklyTracking(scope, weekStart) {
  const col = (await getDb()).collection(COLLECTION);
  const doc = await col.findOne({ _id: keyFor(scope, weekStart) });
  if (!doc) return null;
  return {
    reported: doc.reported,
    nonReportingStreak: doc.nonReportingStreak,
    completedCount: doc.completedCount,
    carriedOver: doc.carriedOver,
  };
}

/** Save the computed ledger for (scope, weekStart) — overwrites whatever
 * was there before for that exact week, since regenerating the same week's
 * report should reflect the latest data, not accumulate duplicate history.
 * `entry` is {reported, nonReportingStreak, completedCount, carriedOver}. */
export async function saveWeeklyTracking(scope, weekStart, entry) {
  const col = (await getDb()).collection(COLLECTION);
  await col.updateOne(
    { _id: keyFor(scope, weekStart) },
    { $set: { scope, weekStart, ...entry, updatedAt: new Date() } },
    { upsert: true }
  );
}
