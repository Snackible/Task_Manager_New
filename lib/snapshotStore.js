// Persists one JSON blob per calendar day of the last known-live rows for
// each team, using Vercel Blob instead of local disk — Vercel Functions run
// on an ephemeral, read-only filesystem (only /tmp is writable, and it
// doesn't survive between invocations), so local files can't be used the
// way the non-Vercel version of this app uses them.
//
// Blobs are stored as access: "public" rather than "private" — this keeps
// reads a plain unauthenticated fetch(url), matching the fetch pattern used
// everywhere else in this codebase, instead of the SDK's authenticated
// get() call. The tradeoff: anyone who had (or guessed) the exact blob URL
// — a random-looking per-store domain plus this predictable pathname —
// could read it. The data itself is internal task/notes content, not
// secrets, so that's an acceptable tradeoff here; switch to
// access: "private" + the SDK's get() if that stops being true.
import { put, list } from "@vercel/blob";

const PREFIX = "snapshots/";
const PATH_RE = /^snapshots\/(\d{4}-\d{2}-\d{2})\.json$/;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Overwrite today's snapshot blob with the latest known-live rows, keyed
 * by team. Call this from the cron job only (see api/cron-snapshot.js) —
 * not from request-serving routes — so snapshot capture doesn't add
 * latency or Blob-write cost to every dashboard load. Teams without a live
 * source (demo, empty) are left out entirely so they never overwrite real
 * prior data with placeholders. */
export async function saveTodaySnapshot(sheets, sources) {
  const liveRows = {};
  for (const [key, sheet] of Object.entries(sheets)) {
    if (sources[key] === "live") liveRows[key] = sheet.rows;
  }
  if (Object.keys(liveRows).length === 0) return;
  await put(`${PREFIX}${todayISO()}.json`, JSON.stringify(liveRows), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true, // cron delivery isn't exactly-once; a re-triggered run must be able to overwrite today's file
    contentType: "application/json",
  });
}

/** The most recent snapshot strictly before today — {date, sheets} — or
 * null if none exists yet (first day this has run, or no live fetch has
 * ever succeeded). `sheets` is keyed by team, same shape saveTodaySnapshot
 * writes. */
export async function loadPreviousSnapshot() {
  const today = todayISO();
  const { blobs } = await list({ prefix: PREFIX });
  const dated = blobs
    .map((b) => {
      const m = b.pathname.match(PATH_RE);
      return m ? { date: m[1], url: b.url } : null;
    })
    .filter(Boolean)
    .filter((b) => b.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length === 0) return null;

  const latest = dated[dated.length - 1];
  const res = await fetch(latest.url);
  if (!res.ok) return null;
  const sheets = await res.json();
  return { date: latest.date, sheets };
}
