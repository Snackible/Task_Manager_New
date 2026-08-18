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
    csvUrl: "",
    appScriptUrl: "https://script.google.com/macros/s/AKfycbxH6z_T3VN6ATixw-BVZizmf2TO99Dm4xtUHud35vAL65PHaly89kQoMsQTx9N2ZZ_e/exec",
  },
  {
    key: "rnd",
    name: "R&D",
    sheetId: "1bzwBuac8CE_lhM03qeMR_9Lxog9zsrsGNKZoRtarZVs",
    tab: "Sheet1",
    csvUrl: "",
    appScriptUrl: "https://script.google.com/macros/s/AKfycbyupmgoz1daCfwbqmtbl_YAcq0coqtdvUGF5cnGTRUMURKan0l8dGUW8Fcx_1pT7jpx0Q/exec",
  },
  {
    key: "b2b",
    name: "B2B",
    sheetId: "1fSUA6m6z36YAyKlGk1zhAP7SeJ7arPa9n2d0xR3CQxE",
    tab: "Sheet1",
    csvUrl: "",
    // Deployed, but currently returns HTTP 403 (confirmed with both curl and
    // Node's own fetch) — unlike the other 3, which work fine. Almost
    // certainly the deployment's "Who has access" is set to something other
    // than "Anyone" (see README Option C, step 3). Falls back to demo/empty
    // until that's fixed.
    appScriptUrl: "https://script.google.com/macros/s/AKfycbyhe4ZZ-mAsHhxrDQXFSNWPaxtqgyOOgXDf7dTpYlpgeCD-quouZH7TbTgS7J9yjJnw/exec",
  },
  {
    key: "gtmt",
    name: "GTMT",
    sheetId: "170-11PweRDbMEPXUpVx_uJxTX5h1KO4LAT2BON6fQr8",
    tab: "Sheet1",
    csvUrl: "",
    appScriptUrl: "https://script.google.com/macros/s/AKfycbyXsZZB2e0WmiY1_bUl65FsZswHzCXZaQibu0r-BehDt6bioa2OFjaftxFe_ILh-0Nc/exec",
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
    csvUrl: "https://docs.google.com/spreadsheets/d/1Eba1mtyjN0eF657EtkxHCuZZfDSn-ng0XYr2cbfX63o/export?format=csv&gid=684750154",
    appScriptUrl: "",
  },
];
