// Fetches and parses B2B's tracker tab (gid=0). Same root problem as Ecomm
// (see ecommPlanner.js): row 0 is a banner ("Week 4; 28th to 3rd September -
// Diwali Strategy") that the shared CSV parser would otherwise treat as the
// header, so every field lookup came up empty and the sheet read as 0 tasks.
//
// Once the real header ("Sr No | Date | Task/ Client Name | Actionable |
// B2B POC | Week Closure | Status | Notes") is used instead, one more quirk
// remains: the task title isn't reliably in one column. Early rows (a
// checklist-style weekly plan) put it under "Actionable" with "Task/ Client
// Name" blank. Later rows (named clients/deals) put the real title under
// "Task/ Client Name" — and when a row like that ALSO has an "Actionable"
// value, that's a checklist of sub-steps for that client, not a second
// title (e.g. "Task/ Client Name: Diwali Clients - AS list" paired with
// "Actionable: 1. GM - CLOSED / 2. COMPASS - 29th call / ..."). So
// "Task/ Client Name" wins when present, and a leftover "Actionable" gets
// folded into Notes instead of discarded — but only when Notes is itself
// empty, so it can't clobber a real note. "B2B POC" is renamed to
// "Assigned To" for the same "give every existing lookup a name it already
// knows" reason.
import { parseCSV, rowsToObjects } from "./csv.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/1fSUA6m6z36YAyKlGk1zhAP7SeJ7arPa9n2d0xR3CQxE/export?format=csv&gid=0";

export async function fetchB2bPlannerRows() {
  const res = await fetchWithTimeout(CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch B2B planner CSV (${res.status})`);
  const rows = parseCSV(await res.text());

  // Same "first row naming more than one column is the real header"
  // discriminator as ecommPlanner.js — row 0 here is always the week's
  // banner, one populated cell.
  const headerIdx = rows.findIndex((r) => r.filter((c) => c.trim() !== "").length > 1);
  if (headerIdx === -1) return [];

  return rowsToObjects([rows[headerIdx], ...rows.slice(headerIdx + 1)]).map((obj) => {
    const taskClientName = (obj["Task/ Client Name"] || "").trim();
    const actionable = (obj["Actionable"] || "").trim();
    const notes = (obj["Notes"] || "").trim();
    return {
      ...obj,
      Task: taskClientName || actionable,
      Notes: taskClientName && actionable && !notes ? actionable : notes,
      "Assigned To": obj["B2B POC"] || "",
    };
  });
}
