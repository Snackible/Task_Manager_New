// Persists the most recently generated report for each (scope, mode, week-
// or-day) combination, so the report panel survives a page reload, the
// manual Refresh button, and different devices/browsers — not just the tab
// that generated it. Stored in Vercel Blob for the same reason
// snapshotStore.js is: serverless functions get a read-only filesystem at
// runtime, so a plain file write here would throw or silently vanish.
import { put, get } from "@vercel/blob";

const REPORT_PREFIX = "reports/";

function pathFor(scope, mode, extra) {
  // extra is a week (YYYY-MM-DD Monday) or day (YYYY-MM-DD) or "" (plan
  // mode, or summary/eod with no explicit selection) — safe to drop
  // straight into a path segment since it only ever contains those shapes.
  return `${REPORT_PREFIX}${scope}__${mode}__${extra || "none"}.json`;
}

/** Save the report just generated for (scope, mode, extra) — overwrites
 * whatever was there before, since this is "the latest generated report for
 * this combo," not a history. */
export async function saveReport(scope, mode, extra, { report, dateLabel }) {
  const pathname = pathFor(scope, mode, extra);
  await put(
    pathname,
    JSON.stringify({ report, dateLabel, generatedAt: new Date().toISOString() }),
    { access: "private", contentType: "application/json", allowOverwrite: true }
  );
}

/** The most recently generated report for (scope, mode, extra), or null if
 * none has ever been generated for that exact combo. */
export async function loadReport(scope, mode, extra) {
  const pathname = pathFor(scope, mode, extra);
  const result = await get(pathname, { access: "private" });
  if (!result) return null;
  return new Response(result.stream).json();
}
