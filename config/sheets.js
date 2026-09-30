// Configure the 7 Task Tracker sheets here.
//
// For each sheet you can set ONE of:
//   - `appScriptUrl` to read via a sheet-bound Apps Script web app (see
//     appscript/Code.gs for the script + deploy steps). No credentials
//     needed, sheet stays private, and access can be revoked any time by
//     deleting the deployment.
//   - `csvUrl` to read a sheet published to the web as CSV (File > Share >
//     Publish to web > CSV). This needs no credentials at all, but makes
//     the sheet fetchable by anyone with the link.
//   - `sheetId` (+ optional `tab`, default "Sheet1") to read live via the
//     Google Sheets API using a service account (see README "Live data" section).
//   - `fetcher`, an async function returning rows directly, for a sheet
//     whose layout needs real parsing beyond "CSV + header row" — banner
//     rows to strip, merged cells to forward-fill, a task title split
//     across columns. See lib/ecommPlanner.js and lib/b2bPlanner.js.
//
// Leave all four empty (or omit the entry) to fall back to bundled demo data
// for that slot (see data/sampleData.js) so the dashboard still runs out of the box.
//
// Every sheet is expected to have this header row (case-insensitive, order
// doesn't matter):
//   Task | Assigned By | Assigned to | Priority Level | Date Received | Deadline | Date Closed | Status | Notes
//
// `csvUrl` can also be a function (resolved fresh on every fetch, e.g.
// monthlyTabCsvUrl) for a team whose tab changes over time instead of a
// fixed string/array — see the Marketing entry below.

import { monthlyTabCsvUrl } from "../lib/sheetsClient.js";
import { fetchEcommPlannerRows } from "../lib/ecommPlanner.js";
import { fetchB2bPlannerRows } from "../lib/b2bPlanner.js";

export const SHEETS = [
  {
    key: "fo",
    name: "FO",
    sheetId: "17GmwobGGZOUUUL1v9SNW4sW7VDHh5hthy_lTCx47eCI",
    tab: "Sheet1",
    // Switched from appScriptUrl to csvUrl, same reasoning as GTMT below:
    // the sheet is now shared link-viewable, and CSV export is a plain
    // fetch with none of the Apps Script web app's intermittent-404
    // reliability problems.
    csvUrl: "https://docs.google.com/spreadsheets/d/17GmwobGGZOUUUL1v9SNW4sW7VDHh5hthy_lTCx47eCI/export?format=csv&gid=0",
    appScriptUrl: "",
  },
  {
    key: "rnd",
    name: "R&D",
    sheetId: "1bzwBuac8CE_lhM03qeMR_9Lxog9zsrsGNKZoRtarZVs",
    tab: "Sheet1",
    // Switched from appScriptUrl to csvUrl — this was the team hit hardest
    // by the Apps Script flakiness (repeatedly showed no data). Now shared
    // link-viewable, so CSV export works directly.
    csvUrl: "https://docs.google.com/spreadsheets/d/1bzwBuac8CE_lhM03qeMR_9Lxog9zsrsGNKZoRtarZVs/export?format=csv&gid=0",
    appScriptUrl: "",
  },
  {
    key: "b2b",
    name: "B2B",
    // Reads 0 tasks with a plain csvUrl, not because the sheet is empty —
    // it has real rows — but because row 1 is a banner ("Week 4; 28th to
    // 3rd September - Diwali Strategy") that a generic header-row-0 parser
    // treats as the header, so every "task"/"status" lookup comes up empty.
    // fetchB2bPlannerRows finds the real header and merges the task title's
    // two possible columns (Actionable / Task-Client-Name) into one. See
    // lib/b2bPlanner.js.
    fetcher: fetchB2bPlannerRows,
  },
  {
    key: "gtmt",
    name: "GTMT",
    sheetId: "170-11PweRDbMEPXUpVx_uJxTX5h1KO4LAT2BON6fQr8",
    tab: "Sheet1",
    // Switched from appScriptUrl to csvUrl: the Apps Script deployment kept
    // 404ing intermittently even after being confirmed correct and set to
    // "Anyone" access (its own execution log showed successful runs when
    // invoked directly, but our fetches still failed at Google's routing
    // layer before execution — a reliability issue with the web app itself,
    // not something fixable from our side). The sheet is already viewable
    // without auth, so its CSV export just works — confirmed with a plain
    // curl returning real rows, no login redirect. Note: this URL must be
    // the `/export?format=csv&gid=...` form, not a browser "edit" link.
    csvUrl: "https://docs.google.com/spreadsheets/d/170-11PweRDbMEPXUpVx_uJxTX5h1KO4LAT2BON6fQr8/export?format=csv&gid=0",
    appScriptUrl: "",
  },
  {
    key: "marketing",
    name: "Marketing",
    sheetId: "1eexWpJLoZgYIxgro5I1FCE5o1TN2_m3_he3HcXWopDM",
    tab: "",
    // Marketing creates a new tab every month ("August 26", "July 26", ...)
    // instead of reusing one gid, so a hardcoded gid URL goes stale as soon
    // as the month rolls over. csvUrl is a function here — resolved fresh on
    // every fetch via monthlyTabCsvUrl, which computes "{Month} {YY}" from
    // today's date and addresses that tab by name instead of gid. Self-
    // updating every month; no manual config change needed going forward.
    // Header here is "Tasks" (plural), handled in lib/aggregate.js.
    csvUrl: () => monthlyTabCsvUrl("1eexWpJLoZgYIxgro5I1FCE5o1TN2_m3_he3HcXWopDM"),
    appScriptUrl: "",
  },
  {
    key: "ecomm",
    name: "Ecomm",
    // Was pointed at the "EOD" tab (gid 1199127127) because gid 0 looked
    // like a kanban board with no per-row Status column — but the EOD tab
    // itself turned out to be the one that had gone stale (nothing logged
    // there since 2026-09-01), while gid 0 ("the current tracker") is what
    // the team actually keeps updating. It does have the Task/Status/Date
    // shape we need, just spread across banner rows and merged cells that
    // a plain csvUrl can't parse — see lib/ecommPlanner.js.
    fetcher: fetchEcommPlannerRows,
  },
  {
    key: "finance",
    name: "Finance",
    sheetId: "1Eba1mtyjN0eF657EtkxHCuZZfDSn-ng0XYr2cbfX63o",
    tab: "",
    // Two tabs merged into one team: "Daily" (gid 684750154) plus a
    // separate "Weekly" tab (gid 0) that was previously invisible to the
    // app entirely. Different column layout (Concerned/Remarks instead of
    // Assigned to/Notes, and Daily's date column is just "Date" rather than
    // Date Received/Deadline), but the field-getter aliases in
    // lib/fieldGetter.js and the date fallback in lib/taskList.js already
    // cover both. Tagged with subTab so the task list and reports can show
    // each tab on its own instead of one merged, undifferentiated list.
    csvUrl: [
      { url: "https://docs.google.com/spreadsheets/d/1Eba1mtyjN0eF657EtkxHCuZZfDSn-ng0XYr2cbfX63o/export?format=csv&gid=684750154", subTab: "Daily" },
      { url: "https://docs.google.com/spreadsheets/d/1Eba1mtyjN0eF657EtkxHCuZZfDSn-ng0XYr2cbfX63o/export?format=csv&gid=0", subTab: "Weekly" },
    ],
    appScriptUrl: "",
  },
];
