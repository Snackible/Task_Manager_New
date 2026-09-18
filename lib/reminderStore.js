// Persists reminder phone numbers (one per team scope) so they survive a
// page reload and are shared across devices/browsers — a number typed in on
// one phone shouldn't vanish when someone opens the dashboard on a laptop.
//
// Stored in MongoDB (see mongoClient.js) — this file previously used Vercel
// Blob, moved off it after an account-wide Blob restriction (triggered by a
// limit hit in a different project sharing the same Vercel account) took
// every Blob-backed feature here down with it.
import { getDb } from "./mongoClient.js";

const COLLECTION = "reminderNumbers";

/** The full {scope: number} map, or {} if nothing's been saved yet. */
export async function loadReminderNumbers() {
  const col = (await getDb()).collection(COLLECTION);
  const docs = await col.find({}).toArray();
  const numbers = {};
  for (const doc of docs) numbers[doc._id] = doc.number;
  return numbers;
}

/** Save one scope's number — a save for "fo" shouldn't clobber an
 * already-saved number for "rnd" (each scope is its own document, so this
 * can't happen). */
export async function saveReminderNumber(scope, number) {
  const col = (await getDb()).collection(COLLECTION);
  await col.updateOne({ _id: scope }, { $set: { number } }, { upsert: true });
  return loadReminderNumbers();
}
