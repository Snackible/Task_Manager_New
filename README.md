# Task Tracker Dashboard

A small, dependency-free Node.js web app that reads 7 "Task Tracker" Google
Sheets (Task / Assigned By / Assigned to / Priority Level / Date Received /
Deadline / Date Closed / Status / Notes) and shows weekly Pending / In
Progress / Completed counts, current totals, and a per-team breakdown.

No `npm install` required — everything is built on Node's standard library
(`node:http`, `node:crypto`, `fetch`). Requires **Node 18+**.

## Quick start (demo data)

```
node server.js
```

Open http://localhost:3000. Out of the box it runs on bundled demo data
(a real export of the "Task Tracker - FO" sheet) for any sheet slot that
isn't configured yet, so you can see it working immediately.

## Pointing it at your real sheets

Edit `config/sheets.js`. All 7 are pre-filled: FO, R&D, B2B, GTMT (via
`sheetId`, Sheets API), and Marketing/Ecomm/Finance (via `csvUrl` pointed at
the specific tab you shared — Ecomm points at that spreadsheet's "EOD" tab
specifically, since the tab in the link you sent has no Status column to
count). Swap any of them if they're not the right ones.

Each entry needs the sheet's ID (the long string in its URL:
`https://docs.google.com/spreadsheets/d/<THIS PART>/edit`) and, optionally,
the tab name if it isn't `Sheet1`.

There are three ways to get live data in, pick whichever is easiest for you:

### Option C — Apps Script web app (no credentials, sheet stays private)

1. Open a Google Sheet, then **Extensions → Apps Script**.
2. Delete the placeholder code and paste in the contents of
   [`appscript/Code.gs`](appscript/Code.gs).
3. **Deploy → New deployment**, gear icon → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone** (this only controls who can hit the JSON
     endpoint you're about to create — it doesn't change the sheet's own
     sharing, which stays whatever it already was)
4. Click **Deploy**, authorize when prompted, then copy the **Web app URL**
   (ends in `/exec`).
5. Paste that URL into that sheet's `appScriptUrl` in `config/sheets.js`.
6. Repeat for each of the 7 sheets (each gets its own deployment + URL).

If a sheet's data tab isn't named `Sheet1`, append `?tab=<tab name>` to the
web app URL before pasting it in.

Redeploying after you edit the script requires **Deploy → Manage deployments
→ edit (pencil) → New version** — saving the script alone doesn't update the
live URL.

### Option A — Publish to web (no credentials, easiest)

1. In each Google Sheet: **File → Share → Publish to web**.
2. Choose the specific sheet/tab, format **CSV**, click **Publish**.
3. Copy the generated URL into that sheet's `csvUrl` in `config/sheets.js`.

This works with zero setup, but the sheet's contents become fetchable by
anyone with the link (that's what "publish to web" means).

### Option B — Service account (private sheets, recommended for real use)

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   reuse) a project, enable the **Google Sheets API**, and create a
   **Service Account**.
2. Create a JSON key for that service account and note its `client_email`
   and `private_key`.
3. Open each of the 7 Google Sheets and **share** it with that
   `client_email` address (Viewer access is enough).
4. Set two environment variables before starting the server:

   ```
   export GOOGLE_SERVICE_ACCOUNT_EMAIL="your-bot@your-project.iam.gserviceaccount.com"
   export GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   node server.js
   ```

   (Copy `.env.example` to `.env` and fill it in if you'd rather use a
   `.env` file — you'll need to load it, e.g. `node --env-file=.env server.js`
   on Node 20.6+.)

Sheets keep working on demo data individually until you fill in their
`appScriptUrl`/`csvUrl`/`sheetId` and (for Option B) credentials are present
— nothing breaks if only some of the 7 are wired up.

## How status is counted

The `Status` column is free text in these sheets ("Done", "WIP", "Not
started", "On Hold", "Not yet approved", blank, ...). It's normalized into 4
buckets (`lib/statusUtils.js`), on top of which a 5th (`Overdue`) is applied
when a non-completed task's deadline has passed:

- **Completed** — Done, Completed
- **In Progress** — WIP, In Progress, Recurring (ongoing/repeating work)
- **Awaiting Approval** — Not yet approved, Pending approval, Awaiting
  approval, For approval, ... (matched by pattern) — the work itself is
  done, it's just stuck waiting on someone else's sign-off. Kept separate
  from Pending on purpose: lumping it in there made reports describe
  finished-but-unapproved work as "Not Started", which reads as if nobody
  had touched it.
- **Pending** — everything else (Not Started, On Hold, blank, Paused, ...) —
  i.e. not finished and not actively being worked on, and not waiting on
  approval either

Edit `lib/statusUtils.js` if you want different bucketing.

## How "weekly" is computed

Each task is placed in the ISO week (Monday–Sunday) of its **Date
Received** — falling back to **Deadline**, then **Date Closed**, if that's
blank. Tasks with no usable date anywhere are still counted in the totals
and per-team breakdown, just excluded from the weekly chart (the dashboard
footer tells you how many).

## AI reports

Three report types, each scoped per tab (Total or a single team) via a
toggle above the Generate button:

- **Summary** — a full narrative of the week (open and closed work), written
  in the style of a real hand-written update — grouped by initiative, naming
  who's working on what, not just counts.
- **Weekly Plan** — a Monday-morning plan from open work only (WIP + Not
  Started); ends with a single named "Focus this week" priority.
- **End of Day** — a close-of-business recap of today's dated activity,
  with the open backlog as brief context; ends with "Tomorrow's priority".

Unlike the dashboard itself (which only ever sees aggregate counts —
Pending: 6, WIP: 13, etc.), these reports are built from the actual task
rows (title, assignee, notes) so the model can write real specifics instead
of reciting numbers. That row-level data is only ever used server-side to
build the prompt — it's never sent to the browser through `/api/tasks` or
anywhere else, and nothing is cached or logged beyond the 60s data cache
already used for the dashboard.

Requires a `GEMINI_API_KEY` environment variable — get a free one at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey), set it the
same way as the Google Sheets credentials above (export it, or add it to
your `.env`). Without it, the button shows an explanatory error instead of
crashing the app. Uses model `gemini-3.6-flash` by default; override with
`GEMINI_MODEL` if you want a different one.

**Free-tier limit:** 20 requests/day per Google Cloud project (the token
limit, ~250K/min, is generous and not the binding constraint). Once you hit
it, reports fail with a quota error until it resets. You can list several
comma-separated keys in `GEMINI_API_KEY` as a fallback chain — the app tries
each in order and moves to the next on a quota error — but **only keys from
different Google Cloud projects actually extend your capacity**; two keys
from the same project/account share one 20/day pool, so generating a second
key from the same account doesn't help.

## Project layout

```
server.js            plain Node HTTP server: serves the frontend + /api/tasks
config/sheets.js      the 7 sheets to read (edit this)
lib/sheetsAuth.js      service-account JWT sign + token exchange (no deps)
lib/sheetsClient.js    fetches one sheet's rows (CSV or Sheets API)
lib/csv.js             tiny CSV parser
lib/fieldGetter.js     case/whitespace/alias-tolerant column lookup
lib/statusUtils.js     Status text -> pending/in_progress/completed
lib/dateUtils.js       date parsing + ISO-week/day bucketing
lib/aggregate.js       merges all 7 sheets into the dashboard payload
lib/aiReport.js        calls the Gemini API to write the AI reports
data/sampleData.js     demo fallback data (real FO export)
public/                frontend: index.html, app.js, styles.css (vanilla JS, no build step)
```

`/api/tasks` responses are cached in memory for 60s so repeated page loads
don't hammer the Sheets API; the **Refresh** button in the header forces a
re-fetch. Adjust `CACHE_MS` in `server.js` if you want a different interval.

## Deploying

This wasn't deployed anywhere yet on purpose — get it looking right locally
first. When you're ready to put it online (Vercel, Render, a small VPS,
etc.), the app already speaks plain HTTP so most Node hosts work with
`node server.js` as the start command; just set the two
`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` environment variables
(or your `csvUrl`s, which need no env vars at all) in that host's dashboard.
