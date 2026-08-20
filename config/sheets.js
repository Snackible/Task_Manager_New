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
//
// Leave all three empty (or omit the entry) to fall back to bundled demo data
// for that slot (see data/sampleData.js) so the dashboard still runs out of the box.
//
// Every sheet is expected to have this header row (case-insensitive, order
// doesn't matter):
//   Task | Assigned By | Assigned to | Priority Level | Date Received | Deadline | Date Closed | Status | Notes

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
    sheetId: "1fSUA6m6z36YAyKlGk1zhAP7SeJ7arPa9n2d0xR3CQxE",
    tab: "Sheet1",
    // Switched from appScriptUrl to csvUrl — the old deployment was
    // confirmed returning HTTP 403. Now shared link-viewable, so CSV
    // export works directly.
    csvUrl: "https://docs.google.com/spreadsheets/d/1fSUA6m6z36YAyKlGk1zhAP7SeJ7arPa9n2d0xR3CQxE/export?format=csv&gid=0",
    appScriptUrl: "",
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
    // csvUrl targets the exact gid you shared — the sheet is link-viewable so
    // this works without credentials. Header here is "Tasks" (plural), handled
    // in lib/aggregate.js.
    csvUrl: "https://docs.google.com/spreadsheets/d/1eexWpJLoZgYIxgro5I1FCE5o1TN2_m3_he3HcXWopDM/export?format=csv&gid=936322201",
    appScriptUrl: "",
  },
  {
    key: "ecomm",
    name: "Ecomm",
    sheetId: "1W2S-smCzfRFUk6MqbHxhEQ4I_xvAUYJr04NtfAmwURs",
    tab: "",
    // NOTE: the gid in the link you sent (0) is a kanban-style planning tab
    // with no per-row Status column, so nothing there could be counted. This
    // points at the "EOD" tab (gid 1199127127) in the same spreadsheet
    // instead, which has the Task/Status/Date shape we need.
    csvUrl: "https://docs.google.com/spreadsheets/d/1W2S-smCzfRFUk6MqbHxhEQ4I_xvAUYJr04NtfAmwURs/export?format=csv&gid=1199127127",
    appScriptUrl: "",
  },
  {
    key: "finance",
    name: "Finance",
    sheetId: "1Eba1mtyjN0eF657EtkxHCuZZfDSn-ng0XYr2cbfX63o",
    tab: "",
    // Two tabs merged into one team: the main tracker (gid 684750154) plus
    // a separate "Weekly" tab (gid 0) that was previously invisible to the
    // app entirely. Different column layout (Concerned/Remarks instead of
    // Assigned to/Notes), but the field-getter aliases in lib/fieldGetter.js
    // already cover both names, so no code changes were needed for that.
    csvUrl: [
      "https://docs.google.com/spreadsheets/d/1Eba1mtyjN0eF657EtkxHCuZZfDSn-ng0XYr2cbfX63o/export?format=csv&gid=684750154",
      "https://docs.google.com/spreadsheets/d/1Eba1mtyjN0eF657EtkxHCuZZfDSn-ng0XYr2cbfX63o/export?format=csv&gid=0",
    ],
    appScriptUrl: "",
  },
];
