// Builds a per-task list (title/assignee/status/deadline/notes) for the
// search + owner-filter UI. Notes are included on request — an explicit
// choice by whoever's running this dashboard, since they can carry more
// freeform/sensitive commentary than the rest of this list. Task titles and
// assignee names are exposed here on purpose too — search only works
// against something to search.

import { fieldGetter } from "./fieldGetter.js";
import { classifyWithOverdue } from "./statusUtils.js";
import { parseSheetDate, toISODate } from "./dateUtils.js";

/**
 * @param {Record<string, {name: string, rows: object[]}>} sheets
 * @param {string|null} onlyKey - restrict to one sheet's key, or null for all
 */
export function buildTaskList(sheets, onlyKey) {
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const out = [];

  for (const [key, { name, rows }] of Object.entries(sheets)) {
    if (onlyKey && key !== onlyKey) continue;

    for (const row of rows) {
      const get = fieldGetter(row);
      const task = get("task", "tasks", "column 1").toString().trim();
      if (!task) continue;

      const deadline = parseSheetDate(get("deadline"));
      const status = classifyWithOverdue(get("status"), deadline, today);
      const assignedTo = get("assigned to", "aligned to (mkt)", "poc", "concerned", "owner").toString().trim();
      const notes = get("notes", "remarks", "remarks ").toString().trim();

      out.push({
        team: key,
        teamName: name,
        task,
        assignedTo: assignedTo || null,
        status,
        deadline: deadline ? toISODate(deadline) : null,
        notes: notes || null,
      });
    }
  }

  return out;
}
