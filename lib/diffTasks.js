// Compares one team's raw rows now vs. a prior snapshot, to find real
// changes — a status flip, an edited note, a brand-new task — instead of
// just handing the model "here's everything currently open" and hoping it
// notices what's new.
import { fieldGetter } from "./fieldGetter.js";

// Spreadsheet rows have no stable ID, so tasks are matched by title. A
// renamed task will show up as "removed" + "new" rather than a rename —
// an acceptable tradeoff given how this data is actually kept (titles are
// rarely edited once a task exists).
function taskKey(row) {
  const get = fieldGetter(row);
  return get("task", "tasks", "column 1").toString().trim().toLowerCase();
}

/** {task, change} entries describing what's different between prevRows and
 * currRows for one team: status changes, note edits, and new tasks.
 * Case/whitespace-only differences don't count — they're not real edits. */
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

    const prev = prevByKey.get(key);
    if (!prev) {
      changes.push({ task: title, change: `new task added (currently ${status || "no status set"})` });
      continue;
    }

    const prevGet = fieldGetter(prev);
    const prevStatus = prevGet("status").toString().trim();
    const prevNotes = prevGet("notes", "remarks", "remarks ").toString().trim();

    if (status && prevStatus && status.toLowerCase() !== prevStatus.toLowerCase()) {
      changes.push({ task: title, change: `status changed from "${prevStatus}" to "${status}"` });
    }
    if (notes && notes !== prevNotes) {
      changes.push({ task: title, change: `notes updated to: "${notes.slice(0, 220)}"` });
    }
  }
  return changes;
}
