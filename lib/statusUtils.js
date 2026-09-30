// Normalizes the many free-text status values seen across these sheets
// ("Done", "WIP", "Not started", "On Hold", "Not yet approved", ...) into the
// 6 buckets the dashboard reports on: no_status, pending, awaiting_approval,
// in_progress, completed, overdue.

const COMPLETED = new Set(["done", "completed", "complete", "closed"]);
const IN_PROGRESS = new Set([
  "wip",
  "in progress",
  "inprogress",
  "in-progress",
  "ip",
  "yet to qc",
  "ongoing",
  "recurring", // ongoing/repeating work — actively worked, not "not started"
]);
// Work that's actually done but stuck waiting on someone else's sign-off —
// distinct from "Pending" (nobody has started) because reports/tiles that
// lump the two together read as if the task hasn't been touched, which is
// misleading for a task that's finished and just needs approval. Matched by
// pattern rather than an exact-string Set since teams phrase this loosely
// ("Not yet approved", "Pending approval", "Awaiting approval", "For
// approval", ...) — but a bare "Approved" is intentionally NOT matched here,
// since that means the review is done (closer to completed than waiting).
const AWAITING_APPROVAL_RE = /not.*approved|awaiting approval|pending approval|approval pending|for approval/;
// Everything else with SOME text (Not Started, On Hold, Paused, Blocked,
// ...) is treated as "pending" — not yet done, and not actively being
// worked on. A genuinely blank cell is its own bucket instead (see
// no_status below) — it's a different fact than "pending": pending means
// someone looked at this and it hasn't started, blank means no one has
// recorded a status at all, which is worth surfacing rather than quietly
// folding into the same count.

export const STATUS_LABELS = {
  no_status: "No Status",
  pending: "Pending",
  awaiting_approval: "Awaiting Approval",
  in_progress: "In Progress",
  completed: "Completed",
  overdue: "Overdue",
};

export function classifyStatus(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "no_status";
  if (COMPLETED.has(s)) return "completed";
  if (IN_PROGRESS.has(s)) return "in_progress";
  if (AWAITING_APPROVAL_RE.test(s)) return "awaiting_approval";
  return "pending";
}

/**
 * classifyStatus() plus a deadline check: an incomplete task whose Deadline
 * has passed is reclassified as "overdue" instead of pending/in_progress —
 * used for the dashboard's own bucketing (aggregate.js, taskList.js). Kept
 * separate from classifyStatus() itself, which stays deadline-unaware and is
 * still what the AI report prompts use (unchanged, on purpose).
 */
export function classifyWithOverdue(raw, deadline, today) {
  const bucket = classifyStatus(raw);
  if (bucket !== "completed" && deadline && today && deadline.getTime() < today.getTime()) {
    return "overdue";
  }
  return bucket;
}

export function emptyStatusCounts() {
  return { no_status: 0, pending: 0, awaiting_approval: 0, in_progress: 0, completed: 0, overdue: 0 };
}
