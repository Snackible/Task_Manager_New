// Persists reminder phone numbers (one per team scope) so they survive a
// page reload and are shared across devices/browsers — a number typed in on
// one phone shouldn't vanish when someone opens the dashboard on a laptop.
// Stored in Vercel Blob for the same reason snapshotStore.js is: serverless
// functions get a read-only filesystem at runtime.
import { put, get } from "@vercel/blob";

const PATHNAME = "reminder-numbers.json";

/** The full {scope: number} map, or {} if nothing's been saved yet. */
export async function loadReminderNumbers() {
  const result = await get(PATHNAME, { access: "private" });
  if (!result) return {};
  return new Response(result.stream).json();
}

/** Save one scope's number, merging into whatever's already stored — a save
 * for "fo" shouldn't clobber an already-saved number for "rnd". */
export async function saveReminderNumber(scope, number) {
  const all = await loadReminderNumbers();
  all[scope] = number;
  await put(PATHNAME, JSON.stringify(all), {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
  });
  return all;
}
