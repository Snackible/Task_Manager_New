// Builds a per-task list (title/assignee/status/deadline/notes) for the
// search + owner-filter UI. Notes are included on request — an explicit
// choice by whoever's running this dashboard, since they can carry more
// freeform/sensitive commentary than the rest of this list. Task titles and
// assignee names are exposed here on purpose too — search only works
// against something to search.

import { fieldGetter } from "./fieldGetter.js";
import { classifyWithOverdue } from "./statusUtils.js";
import { parseSheetDate, toISODate, todayIST } from "./dateUtils.js";

/**
 * @param {Record<string, {name: string, rows: object[]}>} sheets
 * @param {string|null} onlyKey - restrict to one sheet's key, or null for all
 */
export function buildTaskList(sheets, onlyKey) {
  const today = todayIST();
  const out = [];

  for (const [key, { name, rows }] of Object.entries(sheets)) {
    if (onlyKey && key !== onlyKey) continue;

    for (const row of rows) {
      const get = fieldGetter(row);
      const task = get("task", "tasks", "column 1").toString().trim();
      if (!task) continue;

      const deadline = parseSheetDate(get("deadline"));
      // Some sheets (Finance's "Daily" tab, Ecomm) only have one generic
      // date column instead of a real Date Received — without this
      // fallback, every row from a sheet shaped that way showed completely
      // blank in both date columns despite genuinely having a date.
      const dateReceived =
        parseSheetDate(get("date received", "date recieved")) ||
        parseSheetDate(get("date", "timeline", "timeline /date", "timeline/date"));
      const status = classifyWithOverdue(get("status"), deadline, today);
      const assignedTo = get("assigned to", "aligned to (mkt)", "poc", "concerned", "owner").toString().trim();
      const notes = get("notes", "remarks", "remarks ").toString().trim();

      out.push({
        team: key,
        teamName: name,
        task,
        assignedTo: assignedTo || null,
        status,
        dateReceived: dateReceived ? toISODate(dateReceived) : null,
        deadline: deadline ? toISODate(deadline) : null,
        notes: notes || null,
        // Which sheet tab this row came from, for teams whose tasks span
        // multiple tabs (see config/sheets.js's csvUrl `{url, subTab}`
        // form) — null for every team that isn't tagged that way.
        subTab: row.__subTab || null,
      });
    }
  }

  return out;
}
