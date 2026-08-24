// Calls the Google Gemini API (free tier) to turn the dashboard's raw task
// rows into a written report. No SDK — plain fetch, consistent with the rest
// of this app. Three report types:
//   "summary" — retrospective narrative: how did this week go, covering both
//               open and closed work, in the style of a human-written update
//   "plan"    — forward-looking: what's still open (WIP + Not Started only),
//               meant for a Monday-morning "here's the plan" read
//   "eod"     — end of day: today's dated activity vs. the open backlog,
//               meant for a close-of-business recap
//
// Unlike the dashboard's aggregate counts (pending/in_progress/completed
// totals, which is all /api/tasks ever exposes), reports here are built from
// the actual task rows — title, assignee, notes — so the model can write a
// real narrative ("the exports packaging design is progressing with
// Vrushikesh and Manya...") instead of just reciting numbers. That row data
// is passed in directly from server.js's cache and is never sent to the
// browser through any other endpoint.

import { fieldGetter } from "./fieldGetter.js";
import { classifyStatus } from "./statusUtils.js";
import { parseSheetDate, toISODate, weekLabel, dayLabel, isoWeekStart, todayIST } from "./dateUtils.js";
import { loadPreviousSnapshot, loadSnapshotForDate } from "./snapshotStore.js";
import { diffTeamRows } from "./diffTasks.js";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const BUCKET_LABEL = { pending: "Not Started", awaiting_approval: "Awaiting Approval", in_progress: "WIP", completed: "Done" };

// A short excerpt of the house style (from a real hand-written weekly
// update) so the model matches tone/structure instead of writing generic
// AI-report prose. Kept short on purpose — anchors style, not content.
const STYLE_EXAMPLE = `## MARKETING:
Marketing has shown strong movement since last week, with the majority of tasks now Done, several actively WIP, a handful On Hold due to competing priorities, and only two items still explicitly Not Started, pending external inputs.
- On product and packaging, the exports packaging design for the Baked Crunchies, Baked Bhujia, and Protein Puffs ranges is progressing well with Vrushikesh, Manya, and Purthi, with both Bhujia pack designs ready to go, though the team is now waiting on label format QC from R&D to create BOPs for the other products.
- Custom packaging work saw mixed progress, with custom 1kg labels now completed by Purthi, Manya, and Vrushikesh, while the custom pillow packs for the BD order remain On Hold.
- The export dataroom write-up is finished and Awaiting Approval from Aditi before it goes out — work's done here, just waiting on sign-off.
- Overall, the week reflects a strong close-out rate for Marketing, with most remaining open items either awaiting external dependencies or deprioritized in favor of higher-priority projects rather than being stalled internally.`;

const STYLE_RULES = `Match this style exactly (a real example of the house format, for tone/structure only — write about
THIS week's actual data below, never reuse names/tasks from the example):

${STYLE_EXAMPLE}

Formatting rules:
- One "## TEAMNAME:" markdown heading (literally starting with "## ", team name in caps, colon) per team in
  scope — this exact "## " prefix is required for rendering, not optional — then an opening sentence or two
  on overall movement/mood, then "- " bullets grouping related tasks by theme/initiative (not one bullet per
  task) — weave in who's working on what and use the status words naturally inside sentences (Done, WIP, On
  Hold, Not Started, Awaiting Approval) rather than as brackets or labels. "Awaiting Approval" specifically
  means the work itself is done and it's stuck waiting on someone else's sign-off — never describe an
  Awaiting Approval task as "not started" or imply no work has happened on it. End each team's section with
  an "Overall" bullet.
- Prefer specific task titles and names over generic language — this is a real operational update, not a
  vague status blurb.
- Some task lines end with a "(note: ...)" annotation — that's the single richest source of real detail
  here (what actually happened, who said what, blockers, next steps, dates) and should drive most of the
  specifics you write. Don't just restate the task title and status word — pull the actual content out of
  the note and write it into the sentence. A task with no note gets a shorter, plainer mention; a task with
  a note is where the "real texture" comes from. Never surface the literal string "(note: ...)" itself.
- If a team's data source is "demo" or "empty", or it has no task rows, write "Not updated" under its
  heading instead of inventing anything (matches how humans write this report when a sheet wasn't filled in).
- No preamble before the first heading, no closing pleasantries after the last section.`;

const SUMMARY_SYSTEM_PROMPT = `You are writing this week's status update from a task tracker, covering
everything — completed, in-progress, and not-started work — for a founder/manager audience who wants the
real texture of what happened, not just numbers.

${STYLE_RULES}`;

// The Plan report doesn't share STYLE_RULES with the other two — that block
// was written for a retrospective weekly *update* (its example narrates what
// happened, and its formatting rule explicitly calls for status words like
// "Done"/"WIP" woven into sentences), which fought against everything this
// report is trying to be. Overriding it after the fact ("ignore the status
// rule above") was unreliable — the model kept using status anyway, since it
// was still concrete instruction sitting right there. Simpler and more
// reliable to just not give it a retrospective example or a status-word
// instruction to begin with; the underlying task data also omits status
// entirely (see buildPlanPrompt's formatTasks call), so there's nothing to
// slip up on either side.
const PLAN_STYLE_EXAMPLE = `## MARKETING:
Marketing added several new packaging and campaign items this week that need attention across design and content execution.
- On product and packaging, the exports packaging design for the Baked Crunchies, Baked Bhujia, and Protein Puffs ranges needs sign-off from Vrushikesh, Manya, and Purthi, with the Bhujia pack designs ready to move forward once label format QC comes back from R&D.
- New campaign work includes custom 1kg labels for Purthi, Manya, and Vrushikesh to finalize, along with the custom pillow packs for the BD order, which needs a decision on scope given competing priorities.
- Overall, the week's new intake centers on packaging finalization and a few campaign items waiting on external dependencies — worth checking in on those blockers early.`;

const PLAN_STYLE_RULES = `Match this style exactly (tone/structure only — write about THIS week's actual new
tasks below, never reuse names/tasks from the example):

${PLAN_STYLE_EXAMPLE}

Formatting rules:
- One "## TEAMNAME:" markdown heading (literally starting with "## ", team name in caps, colon) per team in
  scope — this exact "## " prefix is required for rendering, not optional — then an opening sentence or two
  framing what's new this week, then "- " bullets grouping related tasks by theme/initiative (not one bullet
  per task) — weave in who owns what, written forward-looking (needs, is waiting on, should move on this
  week) never retrospective (completed, wrapped up, finished, successfully). Never use the words Done, WIP,
  On Hold, Not Started, Awaiting Approval, or any other status label — status isn't part of this report. End
  each team's section with an "Overall" bullet.
- Prefer specific task titles and names over generic language — this is a real operational brief, not a
  vague to-do blurb.
- Some task lines end with a "(note: ...)" annotation — pull real content out of it (what's actually
  needed, blockers, next steps) rather than restating the bare task title. Never surface the literal string
  "(note: ...)" itself.
- If a team has no new tasks this week, or its data source is "demo"/"empty", say so plainly under its
  heading instead of inventing anything.
- No preamble before the first heading, no closing pleasantries after the last section.`;

const PLAN_SYSTEM_PROMPT = `You are writing a Monday-morning plan for the week ahead, from a task tracker.
Every task you're given below was added (by Date Received) on or after this week's Monday — that's already
the complete filter. This report answers "what's new since Monday and what needs doing," not "what's still
open" and not "here's what happened."

${PLAN_STYLE_RULES}

Additional rules for this plan:
- Group by theme/initiative like usual, but organize around why each item matters (deadline proximity, who
  owns it, priority level).
- End the whole report (after all teams) with a "**Focus this week:**" line naming the single task across
  everything in scope that most needs attention this week.`;

const EOD_SYSTEM_PROMPT = `You are writing a short end-of-day recap from a task tracker, read at the close
of business. Focus on today's real activity — that means both tasks with a dated field (received/deadline/
closed) matching today, AND anything flagged in the "Changes since <date>" diff, including a task whose
notes/comments were updated even though its status badge didn't move. A notes-only update is just as
newsworthy as a status change here — never downgrade it to background context just because the badge
stayed the same. Use the overall open backlog beyond those two sources only as brief supporting context,
not the main content. Mention any changes added via comments on the day report is generated.

Some diff entries are prefixed "HIGHLIGHT" — that marks a task whose status badge did NOT move today but
whose notes did. Explicitly call these out in the write-up (e.g. "status held at WIP, but notes show...")
rather than folding them silently into a generic status-grouped bullet — the point is a reader scanning
only the badges would miss that anything happened on that task at all.

${STYLE_RULES}

Additional rules for this recap:
- If there's no dated activity for today for a team, say so plainly under its heading instead of inventing
  anything, and lean on its overall backlog for one line of context instead.
- Keep this shorter than the other report types — a recap, not a full retrospective.`;

const REPORT_TYPES = {
  summary: { system: SUMMARY_SYSTEM_PROMPT, buildPrompt: buildSummaryPrompt },
  plan: { system: PLAN_SYSTEM_PROMPT, buildPrompt: buildPlanPrompt },
  eod: { system: EOD_SYSTEM_PROMPT, buildPrompt: buildEodPrompt },
};

/** GEMINI_API_KEY may be a single key or several comma-separated keys — used
 * as a fallback chain when one hits its daily quota. Note: a second key only
 * helps if it's from a *different* Google Cloud project — free-tier quotas
 * are per-project, so two keys from the same project/account share one
 * 20-requests/day pool and a second key buys nothing. */
function getApiKeys() {
  const raw = process.env.GEMINI_API_KEY || "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function isQuotaError(status, body) {
  return status === 429 || /RESOURCE_EXHAUSTED/i.test(body || "");
}

// Distinct from a genuine quota error: this is Gemini saying the model is
// momentarily saturated ("high demand" / "The model is overloaded. Please
// try again later.", status UNAVAILABLE), not that the caller is out of
// requests. It's usually gone within a couple seconds, so it's worth a
// couple of quick automatic retries — the alternative is surfacing it
// straight to the user, who then burns another one of the free tier's very
// few daily requests just re-clicking "Regenerate" into the same window.
function isOverloadError(status, body) {
  return status === 503 || /UNAVAILABLE|overloaded|high demand/i.test(body || "");
}

const OVERLOAD_RETRY_DELAYS_MS = [1200, 2500]; // 3 attempts total per key

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(apiKey, system, prompt) {
  const res = await fetch(`${GEMINI_API_URL}/${MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: {
        // This model can't fully disable "thinking" (thinkingBudget: 0 is
        // rejected outright by the API; lower budgets don't reliably cap it
        // either), and thinking tokens count against maxOutputTokens — a
        // complex 7-team prompt burned ~3900 tokens on invisible thinking
        // alone. Budget generously for thinking + the actual report text.
        maxOutputTokens: 16384,
        temperature: 0.6,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Gemini API error (${res.status}): ${text.slice(0, 300)}`);
    err.isQuotaError = isQuotaError(res.status, text);
    err.isOverloadError = !err.isQuotaError && isOverloadError(res.status, text);
    throw err;
  }

  const json = await res.json();
  const candidate = json.candidates && json.candidates[0];
  const text = ((candidate && candidate.content && candidate.content.parts) || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  const finishReason = candidate && candidate.finishReason;

  if (!text) {
    throw new Error(
      finishReason ? `Gemini returned no text (finishReason: ${finishReason}).` : "Gemini API returned an empty response."
    );
  }
  // A truncated report is worse than no report — it reads as complete when it
  // isn't (silently missing whichever teams didn't fit). Fail loudly instead.
  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      "The report was cut off (ran out of tokens) before finishing. Try a single-team tab instead of Total, or click Regenerate."
    );
  }
  return text;
}

/** callGemini with a couple of quick automatic retries when Gemini reports
 * transient overload ("high demand") — see isOverloadError above for why
 * this specifically excludes real quota errors. */
async function callGeminiWithRetry(apiKey, system, prompt) {
  let lastErr;
  for (let attempt = 0; attempt < OVERLOAD_RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      return await callGemini(apiKey, system, prompt);
    } catch (err) {
      lastErr = err;
      const delay = OVERLOAD_RETRY_DELAYS_MS[attempt];
      if (!err.isOverloadError || delay === undefined) throw err;
      console.error(`[aiReport] Gemini reported high demand (attempt ${attempt + 1}), retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function generateReport(payload, rawSheets, scope, type, week, day) {
  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it as an environment variable to enable AI reports (see README) — get a free key at https://aistudio.google.com/apikey."
    );
  }

  const { system, buildPrompt } = REPORT_TYPES[type] || REPORT_TYPES.summary;
  const prompt = await buildPrompt(payload, rawSheets, scope, week, day); // buildEodPrompt is async (reads a snapshot file); await works fine on the sync builders too
  const dateLabel = reportDateLabel(payload, scope, type, week, day);

  let lastErr;
  for (let i = 0; i < apiKeys.length; i++) {
    try {
      const text = await callGeminiWithRetry(apiKeys[i], system, prompt);
      return { text, dateLabel };
    } catch (err) {
      lastErr = err;
      // Real (non-quota, non-overload) error — don't mask it by trying another key.
      if (!err.isQuotaError && !err.isOverloadError) throw err;
      const reason = err.isQuotaError ? "hit its quota" : "still overloaded after retrying";
      console.error(`[aiReport] key ${i + 1}/${apiKeys.length} ${reason}, trying next key...`);
    }
  }
  const suffix = apiKeys.length > 1 ? ` (tried all ${apiKeys.length} keys)` : "";
  const message = lastErr.isOverloadError
    ? `Gemini is at capacity right now — it stayed at "high demand" through several retries${suffix}. Wait a minute or two and click Regenerate.`
    : `${lastErr.message}${suffix}`;
  throw new Error(message);
}

/** Which day/week of data the report actually covers — shown in the UI and
 * the exported PDF in place of a plain "generated at" timestamp, since the
 * data considered can lag well behind when the report was generated. */
function reportDateLabel(payload, scope, type, week, day) {
  if (type === "summary") {
    const range = week ? weekRange(week) : null;
    return range ? `Week of ${weekLabel(range.start)}` : null;
  }
  if (type === "plan") {
    return `Week of ${weekLabel(isoWeekStart(todayIST()))}`;
  }
  // eod — an explicitly picked day, else the most recent day with dated
  // activity, else today
  if (day) {
    const parsed = parseSheetDate(day);
    if (parsed) return dayLabel(parsed);
  }
  const latestDay = latestDailyPeriod(payload, scope);
  return latestDay ? latestDay.label : dayLabel(todayIST());
}

/** Most recent {periodStart, label, ...} daily bucket in scope that isn't in
 * the future, or null. Buckets are keyed by whichever date anchors a task
 * (Date Received, falling back to Deadline/Date Closed/a generic date column)
 * — a task with only a future Deadline entered still anchors to that future
 * day, so the chronologically-last bucket in the sorted list isn't
 * necessarily today. Walk backward from the end to skip past those. */
function latestDailyPeriod(payload, scope) {
  const dailySource = scope && scope !== "total" ? payload.perSheetDaily && payload.perSheetDaily[scope] : payload.daily;
  if (!dailySource || !dailySource.length) return null;
  const todayISO = toISODate(todayIST());
  for (let i = dailySource.length - 1; i >= 0; i--) {
    if (dailySource[i].periodStart <= todayISO) return dailySource[i];
  }
  return null;
}

const NOTES_CHAR_CAP = 280;

/** Truncate a notes cell for the prompt, keeping the *end* of the text
 * rather than the start. Teams tend to treat notes as a running log and
 * append new updates to the end ("8/10: started... 8/15: revised...
 * 8/17: approved by R&D") — truncating from the front silently drops
 * exactly the most recent update, which defeats the point of including
 * notes at all. */
function truncateNotes(raw) {
  const s = raw.toString().trim();
  if (s.length <= NOTES_CHAR_CAP) return s;
  return `…${s.slice(-NOTES_CHAR_CAP)}`;
}

/** Pull {task, bucket, assignedTo, notes, anchorDate} out of one sheet's raw rows. */
function extractTasks(rows, { buckets, onDate, dateRange, receivedSince } = {}) {
  const out = [];
  for (const row of rows || []) {
    const get = fieldGetter(row);
    const task = get("task", "tasks", "column 1").toString().trim();
    if (!task) continue;

    const bucket = classifyStatus(get("status"));
    if (buckets && !buckets.includes(bucket)) continue;

    if (onDate || dateRange || receivedSince) {
      // Same fallback chain aggregate.js uses for anchorDate: not every
      // team's sheet has a literal "Date Received" column (Finance's main
      // tab and Ecomm both only have one generic date column instead) —
      // without this fallback, "added since Monday" silently came up empty
      // for those teams every time, reading as "nothing new" when the real
      // issue was just no Date Received column to check.
      const anchor =
        parseSheetDate(get("date received", "date recieved")) ||
        parseSheetDate(get("deadline")) ||
        parseSheetDate(get("date closed")) ||
        parseSheetDate(get("date", "timeline", "timeline /date", "timeline/date"));
      if (onDate && (!anchor || toISODate(anchor) !== onDate)) continue;
      if (dateRange && (!anchor || anchor.getTime() < dateRange.start.getTime() || anchor.getTime() > dateRange.end.getTime())) continue;
      if (receivedSince && (!anchor || anchor.getTime() < receivedSince.start.getTime() || anchor.getTime() > receivedSince.end.getTime())) continue;
    }

    const assignedTo = get("assigned to", "aligned to (mkt)", "poc", "concerned", "owner").toString().trim();
    const notes = truncateNotes(get("notes", "remarks", "remarks "));
    // Which sheet tab this row came from, for a team whose tasks span more
    // than one (e.g. Finance's "Daily" and "Weekly" tabs) — see
    // config/sheets.js's csvUrl `{url, subTab}` form. null for every team
    // that isn't tagged that way.
    out.push({ task, bucket, assignedTo, notes, subTab: row.__subTab || null });
  }
  return out;
}

function formatTaskLines(tasks, showStatus) {
  return tasks
    .map((t) => {
      const who = t.assignedTo ? ` — ${t.assignedTo}` : "";
      const note = t.notes ? ` (note: ${t.notes})` : "";
      const statusPrefix = showStatus ? `[${BUCKET_LABEL[t.bucket]}] ` : "";
      return `  ${statusPrefix}${t.task}${who}${note}`;
    })
    .join("\n");
}

function formatTasks(tasks, { showStatus = true } = {}) {
  if (!tasks.length) return "  (none)";
  const subTabs = Array.from(new Set(tasks.map((t) => t.subTab).filter(Boolean)));
  // Only split into sub-sections when a team's tasks genuinely span more
  // than one tagged tab — otherwise this is identical to one flat list, so
  // every team without that setup (nearly all of them) is unaffected.
  if (subTabs.length < 2) return formatTaskLines(tasks, showStatus);
  return subTabs
    .map((sub) => `  ${sub}:\n${formatTaskLines(tasks.filter((t) => t.subTab === sub), showStatus).replace(/^  /gm, "    ")}`)
    .join("\n");
}

/** Iterate {key, name, source} for either every team (total scope) or just one. */
function scopeTeams(payload, scope) {
  if (!scope || scope === "total") {
    return Object.entries(payload.perSheet).map(([key, s]) => ({ key, name: s.name, source: payload.sources[key] }));
  }
  const sheet = payload.perSheet[scope];
  return sheet ? [{ key: scope, name: sheet.name, source: payload.sources[scope] }] : [];
}

function teamBlock(team, rawSheets, extractOpts) {
  if (team.source === "demo" || team.source === "empty") {
    return `${team.name.toUpperCase()}:\n  (data source: ${team.source} — not wired up to a live sheet yet)`;
  }
  const rows = (rawSheets[team.key] && rawSheets[team.key].rows) || [];
  const tasks = extractTasks(rows, extractOpts);
  return `${team.name.toUpperCase()}:\n${formatTasks(tasks)}`;
}

/** Given a week's Monday (YYYY-MM-DD), the [start, end] to filter tasks by —
 * clipped to today if this is the week containing today (a report generated
 * mid-week shouldn't imply days that haven't happened yet). */
function weekRange(week) {
  const start = parseSheetDate(week);
  if (!start) return null;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const today = todayIST();
  const effectiveEnd = today.getTime() < end.getTime() && today.getTime() >= start.getTime() ? today : end;
  return { start, end: effectiveEnd, isPartial: effectiveEnd.getTime() !== end.getTime() };
}

function buildSummaryPrompt(payload, rawSheets, scope, week) {
  const teams = scopeTeams(payload, scope);
  const range = week ? weekRange(week) : null;

  const blocks = teams.map((team) => teamBlock(team, rawSheets, range ? { dateRange: range } : {})).join("\n\n");

  if (!range) {
    return `Write this week's status update. Teams in scope: ${teams.map((t) => t.name).join(", ")}.

${blocks}`;
  }

  const weekLabel = `${toISODate(range.start)} to ${toISODate(range.end)}`;
  const partialNote = range.isPartial
    ? ` This week is still in progress (data only goes up to ${toISODate(range.end)}) — do not imply the week is over.`
    : "";

  return `Write the status update for the week of ${weekLabel} ONLY — every task below is already filtered to
that window; do not reference activity from any other week. Teams in scope: ${teams.map((t) => t.name).join(", ")}.${partialNote}

${blocks}`;
}

function buildPlanPrompt(payload, rawSheets, scope) {
  const teams = scopeTeams(payload, scope);
  const monday = isoWeekStart(todayIST());
  const today = todayIST();
  const receivedSince = { start: monday, end: today };

  const blocks = teams
    .map((team) => {
      if (team.source === "demo" || team.source === "empty") return teamBlock(team, rawSheets, {});
      const rows = (rawSheets[team.key] && rawSheets[team.key].rows) || [];
      const newTasks = extractTasks(rows, { receivedSince });
      // No status shown here on purpose — the model can't mention a badge
      // it was never given, which is a more reliable guarantee than just
      // instructing it to ignore status it can see.
      return `${team.name.toUpperCase()}:\n${formatTasks(newTasks, { showStatus: false })}`;
    })
    .join("\n\n");

  return `Write the plan covering only tasks added since ${toISODate(monday)} (this week's Monday), by Date
Received. Teams in scope: ${teams.map((t) => t.name).join(", ")}. Every task below already meets that filter
regardless of its current status — do not exclude or reorganize by status, and do not reference anything
added before this week.

${blocks}`;
}

async function buildEodPrompt(payload, rawSheets, scope, week, day) {
  const teams = scopeTeams(payload, scope);
  const todayISO = toISODate(todayIST());
  // day=today (the default the UI sends) behaves identically to no day at
  // all — auto-detect. Only a day strictly before today is "historical".
  const isHistorical = !!day && day !== todayISO;

  let onDate, dateLine, daySnapshot;
  if (isHistorical) {
    onDate = day;
    const parsedDay = parseSheetDate(day);
    dateLine = `Recapping ${
      parsedDay ? dayLabel(parsedDay) : day
    } — a past day, generated after the fact. Do not call it "today" or "this evening"; refer to it by name/date, and frame the closing priority as what mattered next after that day, not literally "tomorrow".`;
    // Prefer that day's own snapshot (state as it stood then) over today's
    // live rows — otherwise a report about a past day would quietly
    // describe today's current state (a task closed since then would look
    // like it was never open, etc). Falls back to live rows per-team below
    // when no snapshot was captured that day.
    daySnapshot = await loadSnapshotForDate(day);
  } else {
    const latestDay = latestDailyPeriod(payload, scope);
    onDate = latestDay ? latestDay.periodStart : null;
    dateLine = latestDay
      ? `Most recent day with dated activity: ${latestDay.label}.`
      : "No dated task activity recorded for any day yet — write the recap around the open backlog instead.";
    daySnapshot = null;
  }

  // The real "what changed" signal: a diff against the saved snapshot from
  // before the day in question (see snapshotStore.js / diffTasks.js),
  // rather than inferring it from the current-state notes dump below. Falls
  // back gracefully — null before any snapshot exists yet.
  const previous = await loadPreviousSnapshot(isHistorical ? day : undefined);

  const blocks = teams
    .map((team) => {
      if (team.source === "demo" || team.source === "empty") return teamBlock(team, rawSheets, {});
      const liveRows = (rawSheets[team.key] && rawSheets[team.key].rows) || [];
      const historicalRows = isHistorical && daySnapshot && daySnapshot.sheets[team.key];
      const rows = historicalRows || liveRows;
      const dayTasks = onDate ? extractTasks(rows, { onDate }) : [];
      // Backstop for when there's no prior snapshot to diff against yet:
      // the full open backlog with notes, so the model can still notice
      // something that reads like a fresh update even without a real diff.
      const openBacklog = extractTasks(rows, { buckets: ["pending", "awaiting_approval", "in_progress"] });

      let changesBlock;
      if (isHistorical && !historicalRows) {
        changesBlock = `  Changes: no snapshot was captured for ${day} for this team, so a real diff isn't available — the activity and backlog above are today's current data used as a best-effort substitute, not this team's actual state on ${day}.`;
      } else if (!previous) {
        changesBlock = isHistorical
          ? `  Changes since the prior snapshot: not available (no snapshot exists before ${day} yet).`
          : "  Changes since yesterday: not available yet (no snapshot has been captured before today).";
      } else if (!previous.sheets[team.key]) {
        changesBlock = `  Changes since ${previous.date}: not available (no prior snapshot for this team).`;
      } else {
        const changes = diffTeamRows(previous.sheets[team.key], rows);
        changesBlock = changes.length
          ? `  Changes since ${previous.date} (this is the authoritative "what happened${isHistorical ? " that day" : " today"}" signal — a real diff, not a guess):\n${changes.map((c) => `    - ${c.task}: ${c.change}`).join("\n")}`
          : `  Changes since ${previous.date}: none detected.`;
      }

      return `${team.name.toUpperCase()}:
  ${isHistorical ? "That day's" : "Today's"} dated activity (${onDate || "none"}):
${formatTasks(dayTasks)}
${changesBlock}
  Full open backlog (Not Started + Awaiting Approval + WIP, as of ${isHistorical ? "that day" : "today"}, for context):
${formatTasks(openBacklog)}`;
    })
    .join("\n\n");

  return `Write the end-of-day recap. Teams in scope: ${teams.map((t) => t.name).join(", ")}. ${dateLine}

${blocks}`;
}
