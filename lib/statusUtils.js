// Normalizes the many free-text status values seen across these sheets
// ("Done", "WIP", "Not started", "On Hold", "Not yet approved", ...) into the
// 7 buckets the dashboard reports on: no_status, pending, awaiting_approval,
// in_progress, standing, completed, overdue.

const COMPLETED = new Set(["done", "completed", "complete", "closed"]);
const IN_PROGRESS = new Set([
  "wip",
  "in progress",
  "inprogress",
  "in-progress",
  "ip",
  "yet to qc",
  "ongoing",
]);
// "Recurring" and "Revisions" are standing statuses a team sets once and
// never updates — the task itself keeps happening/getting reworked, but the
// status cell won't ever flip to "Done". Its own bucket, distinct from both
// "Completed" (that'd hide that the work is still ongoing) and "In Progress"
// (that would let classifyWithOverdue below reclassify it "Overdue" the
// moment its last deadline passes, and it'd stay that way forever since
// nothing ever updates the status to clear it).
const STANDING = new Set(["recurring", "revision", "revisions"]);
// Work that's actually done but stuck waiting on someone else's sign-off —
// distinct from "Pending" (nobody has started) because reports/tiles that
// lump the two together read as if the task hasn't been touched, which is
// misleading for a task that's finished and just needs approval. Matched by
// pattern rather than an exact-string Set since teams phrase this loosely
// ("Not yet approved", "Pending approval", "Awaiting approval", "For
// approval", ...) — but a bare "Approved" is intentionally NOT matched here,
// since that means the review is done (closer to completed than waiting).
const AWAITING_APPROVAL_RE = /not.*approved|awaiting approval|pending approval|approval pending|for approval/;
// "Cancelled" (and close synonyms) means closed, same as Done — there's no
// bucket here for "closed, but not done," and leaving it unmatched meant it
// fell through to "pending," which reads as outstanding work someone still
// needs to act on. Folded into "completed" instead: not a perfect semantic
// match, but "no longer open, no action needed" is exactly what that bucket
// means for every stat/filter/report that reads it. Matched by pattern, not
// exact string, for the same loose-phrasing reason as AWAITING_APPROVAL_RE.
export const CANCELLED_RE = /cancel|scrapped|dropped|not required|no longer required|won.?t do/;
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
  standing: "Standing",
  completed: "Completed",
  overdue: "Overdue",
};

export function classifyStatus(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "no_status";
  if (STANDING.has(s)) return "standing";
  if (COMPLETED.has(s) || CANCELLED_RE.test(s)) return "completed";
  if (IN_PROGRESS.has(s)) return "in_progress";
  if (AWAITING_APPROVAL_RE.test(s)) return "awaiting_approval";
  return "pending";
}

/**
 * classifyStatus() plus a deadline check: an incomplete task whose Deadline
 * has passed is reclassified as "overdue" instead of pending/in_progress —
 * used for the dashboard's own bucketing (aggregate.js, taskList.js). Kept
 * separate from classifyStatus() itself, which stays deadline-unaware and is
 * still what the AI report prompts use (unchanged, on purpose). "standing"
 * is exempted the same way "completed" is — see the STANDING comment above.
 */
export function classifyWithOverdue(raw, deadline, today) {
  const bucket = classifyStatus(raw);
  if (bucket !== "completed" && bucket !== "standing" && deadline && today && deadline.getTime() < today.getTime()) {
    return "overdue";
  }
  return bucket;
}

export function emptyStatusCounts() {
  return { no_status: 0, pending: 0, awaiting_approval: 0, in_progress: 0, standing: 0, completed: 0, overdue: 0 };
}
