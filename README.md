# Task Tracker Dashboard — Vercel version

This is a second copy of the dashboard, restructured to run on Vercel. It sits
next to the original local version (`../server.js` and friends) so you can
keep both — nothing here touches the parent folder.

## What's different from the local version

The local version is one long-running `node server.js` process: an in-memory
cache, a `setInterval` heartbeat, and snapshot files written to local disk.
None of that works on Vercel — serverless functions don't stay resident
between requests, and their filesystem is ephemeral. So:

| | Local version | This version |
|---|---|---|
| Server | One `node:http` process | Individual functions under `api/*.js`, one per route |
| Request cache | In-memory, guaranteed to persist 60s | Same 60s logic, but only guaranteed while a function instance happens to stay warm — a pure optimization, not load-bearing |
| Keeping data fresh with no visitors | `setInterval` every 30 min | **Vercel Cron** (`vercel.json`) hits `/api/cron-snapshot` once a day |
| Daily snapshot storage (for EOD "changes since yesterday") | `data/snapshots/*.json` on local disk | **Vercel Blob** — see `lib/snapshotStore.js` |

Everything else — `lib/aggregate.js`, `dateUtils.js`, `csv.js`,
`fieldGetter.js`, `statusUtils.js`, `taskList.js`, `fetchWithTimeout.js`,
`sheetsClient.js`, `sheetsAuth.js`, `diffTasks.js`, `aiReport.js`, the whole
`public/` frontend, `config/sheets.js`, `data/sampleData.js` — is copied
over unchanged. The frontend still just calls `/api/tasks`, `/api/report`,
etc.; Vercel's file-based routing maps those straight to the files in `api/`.

**One tradeoff worth knowing:** snapshot blobs are stored as `access:
"public"` (see the comment at the top of `lib/snapshotStore.js`) so reads
are a plain `fetch(url)` instead of the SDK's authenticated call. Anyone
who had the exact (random-looking) store URL plus the date filename could
read a snapshot. The data is internal task/notes content, not secrets — but
if that's not acceptable, switch to `access: "private"` and the Blob SDK's
`get()`.

## Deploy steps

1. **Install the Vercel CLI** (skip if you already have it):
   ```bash
   npm install -g vercel
   ```

2. **From inside this folder**, log in and link the project:
   ```bash
   cd vercel-deploy
   vercel login
   vercel link
   ```
   Follow the prompts — create a new project (don't link it to the existing
   local-server project, this is a separate deployment).

3. **Create a Blob store and connect it to this project:**
   - Go to your project in the Vercel dashboard → **Storage** tab
   - **Create Database** → **Blob** → **Public** access → give it a name
   - When asked which environments to include, check **Production**,
     **Preview**, and **Development** (Development lets you test locally)
   - This automatically adds `BLOB_STORE_ID` / `VERCEL_OIDC_TOKEN` (and
     `BLOB_READ_WRITE_TOKEN`) as environment variables on the project — you
     don't set these yourself.

4. **Set the rest of your environment variables** — in the dashboard
   (**Settings → Environment Variables**) or via CLI:
   ```bash
   vercel env add GEMINI_API_KEY
   vercel env add CRON_SECRET
   ```
   `CRON_SECRET` can be any random string (`openssl rand -hex 32` works).
   See `.env.example` for the full list, including the Sheets service-account
   ones (only needed if you use that fallback instead of `appScriptUrl`/`csvUrl`).

5. **Deploy to production:**
   ```bash
   vercel deploy --prod
   ```
   Cron jobs only run on production deployments, not preview branches — so
   the snapshot capture won't start firing until this step.

6. **Verify the cron job registered:** in the dashboard, go to
   **Settings → Cron Jobs**. You should see `/api/cron-snapshot` scheduled
   for `0 6 * * *` (6 AM UTC daily — edit the schedule in `vercel.json` and
   redeploy if you want a different time; remember Vercel expresses cron
   schedules in UTC, and Hobby accounts only get once-daily granularity with
   ±59 minutes of slack on the hour, which is fine for this).

7. **Local development (optional):** to run this version on your own
   machine against the same env vars/Blob store Vercel has:
   ```bash
   vercel env pull .env.local
   vercel dev
   ```
   Note per Vercel's own docs: cron jobs don't fire under `vercel dev` — to
   test the snapshot capture locally, just hit the route directly:
   ```bash
   curl -H "Authorization: Bearer <your CRON_SECRET>" http://localhost:3000/api/cron-snapshot
   ```

## After deploying

- The EOD report's "changes since yesterday" diff won't have anything to
  compare against until **at least one full day** has passed with the cron
  job running — the first day's report will say "not available yet." That's
  expected, not a bug.
- Every push to your production branch (or `vercel deploy --prod`) creates a
  new deployment; the cron schedule carries over automatically as long as
  `vercel.json` still declares it.
