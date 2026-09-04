// Compares one team's raw rows now vs. a prior snapshot, to find real
// changes — a status flip, an edited note, a brand-new task — instead of
// just handing the model "here's everything currently open" and hoping it
// notices what's new.
import { fieldGetter } from "./fieldGetter.js";
import { classifyStatus } from "./statusUtils.js";
import { parseSheetDate, toISODate } from "./dateUtils.js";

// Same fallback chain as aiReport.js's extractTasks — computed here too so
// every diff entry carries the task's own date, not just its title and
// what changed. Without it, an old task (say, from three weeks ago) whose
// note gets edited today shows up in the diff exactly like something
// brand-new, and the model has no way to tell the difference.
function anchorISO(row) {
  const get = fieldGetter(row);
  const candidates = [
    parseSheetDate(get("date received", "date recieved")),
    parseSheetDate(get("deadline")),
    parseSheetDate(get("date closed")),
    parseSheetDate(get("date", "timeline", "timeline /date", "timeline/date")),
  ].filter(Boolean);
  return candidates[0] ? toISODate(candidates[0]) : null;
}

// Spreadsheet rows have no stable ID, so tasks are matched by title plus
// Date Received. Title alone collides constantly — FO alone has four
// separate rows literally titled "Meeting with AS" on four different
// dates — and a Map keyed only by title can hold just one same-titled row
// from prevRows, so every other same-titled row in currRows gets matched
// against that ONE unrelated row instead of its own true counterpart,
// producing entirely fabricated "status changed"/"notes updated" diff
// entries for rows that never actually changed. Date Received is the most
// stable per-instance field (Deadline/Date Closed routinely change as work
// progresses; the day a task was logged essentially never does), so
// title+received reliably separates genuinely distinct same-titled tasks.
// A renamed task, or one with no Date Received at all, still shows up as
// "removed" + "new" rather than a rename — an acceptable tradeoff given how
// this data is actually kept (titles are rarely edited once a task exists).
function taskKey(row) {
  const get = fieldGetter(row);
  const title = get("task", "tasks", "column 1").toString().trim().toLowerCase();
  if (!title) return null; // blank row — callers skip these on a falsy key
  const received = get("date received", "date recieved").toString().trim().toLowerCase();
  return `${title}|${received}`;
}

// Teams mark a recurring task by literally setting its Status to
// "Recurring" (see statusUtils.js's IN_PROGRESS set) rather than cycling
// it through Not Started every time a new occurrence starts. Check both
// the before and after status: a task can go Recurring -> Done (finished
// this cycle) or Done -> Recurring (reset for the next one), and either
// side carrying that literal badge means the "regression" is really just
// the task's normal cycle, not a step backward.
function hasRecurringBadge(rawStatus) {
  return rawStatus.trim().toLowerCase() === "recurring";
}

// Fallback for teams that don't use the literal "Recurring" status badge
// but still clearly mean it by the title ("Daily analysis", "Weekly
// plan") — not exhaustive, just catches the obvious cases.
const RECURRING_TITLE_KEYWORDS = ["daily", "weekly", "every day", "every week", "each day", "each week", "recurring"];

function looksRecurring(title, status, prevStatus) {
  if (hasRecurringBadge(status) || hasRecurringBadge(prevStatus)) return true;
  const t = title.toLowerCase();
  return RECURRING_TITLE_KEYWORDS.some((kw) => t.includes(kw));
}

const BUCKET_ORDER = { pending: 0, in_progress: 1, completed: 2 };

/** {task, change, dateISO} entries describing what's different between
 * prevRows and currRows for one team: status changes, note edits, and new
 * tasks. dateISO is the task's OWN date (see anchorISO above) — a task from
 * three weeks ago that merely got a note edited today still carries its
 * real, older date, so the prompt can tell the model "this is an update to
 * an existing item," not "this is today's news." Case/whitespace-only
 * differences don't count — they're not real edits. */
export function diffTeamRows(prevRows, currRows) {
  const prevByKey = new Map();
  for (const row of prevRows || []) {
    const key = taskKey(row);
    if (key) prevByKey.set(key, row);
  }

  const changes = [];
  for (const row of currRows || []) {
    const key = taskKey(row);
    if (!key) continue;
    const get = fieldGetter(row);
    const title = get("task", "tasks", "column 1").toString().trim();
    const status = get("status").toString().trim();
    const notes = get("notes", "remarks", "remarks ").toString().trim();
    const dateISO = anchorISO(row);

    const prev = prevByKey.get(key);
    if (!prev) {
      changes.push({ task: title, change: `new task added (currently ${status || "no status set"})`, dateISO });
      continue;
    }

    const prevGet = fieldGetter(prev);
    const prevStatus = prevGet("status").toString().trim();
    const prevNotes = prevGet("notes", "remarks", "remarks ").toString().trim();

    const statusChanged = status && prevStatus && status.toLowerCase() !== prevStatus.toLowerCase();
    const notesChanged = notes && notes !== prevNotes;

    if (statusChanged) {
      const isRegression = BUCKET_ORDER[classifyStatus(status)] < BUCKET_ORDER[classifyStatus(prevStatus)];
      // A recurring task (daily/weekly) resetting from Done back to Not
      // Started at the start of its next cycle isn't a real regression —
      // it's the task doing exactly what it's supposed to. Suppress only
      // that specific case; a forward move (even for a recurring task) or
      // a backward move on a non-recurring task both still get reported —
      // those are genuinely worth knowing about.
      if (!(isRegression && looksRecurring(title, status, prevStatus))) {
        changes.push({ task: title, change: `status changed from "${prevStatus}" to "${status}"`, dateISO });
      }
    }
    if (notesChanged) {
      // Called out explicitly, not left for the model to infer from two
      // separate facts — a note update with an unmoved badge is easy to
      // read as "nothing happened" unless the diff itself says otherwise.
      changes.push({
        task: title,
        dateISO,
        change: statusChanged
          ? `notes also updated to: "${notes.slice(0, 220)}"`
          : `HIGHLIGHT — no status change (still "${status || prevStatus}"), but notes updated to: "${notes.slice(0, 220)}"`,
      });
    }
  }
  return changes;
}
