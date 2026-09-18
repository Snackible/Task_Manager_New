// Calls the Google Gemini API (free tier) to turn the dashboard's raw task
// rows into a written report. No SDK — plain fetch, consistent with the rest
// of this app. Three report types:
//   "summary" — retrospective narrative: how did this week go, covering both
//               open and closed work, in the style of a human-written update
//   "plan"    — forward-looking: what's still open (WIP + Not Started only),
//               meant for a Monday-morning "here's the plan" read
//   "eow"     — end of week: accountability-focused weekly report (see
//               eowReport.js) — completed/carried-over/priorities per
//               department, plus cross-department chronic-delay and
//               non-reporting tracking that persists week over week
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
- No preamble before the first heading, no closing pleasantries after the last section.
- The same task title often repeats across multiple, genuinely separate rows (e.g. several distinct "Meeting
  with AS" entries, each its own date/notes/status) — a repeated title gets a "(date)" appended right after
  it wherever that happens. Each instance is its own task: never borrow, merge, or infer notes/status from
  one instance of a repeated title into your description of a different instance, even if they sound related
  — only use the note/status/date that appear on that exact line. If you're not sure which instance a detail
  belongs to, leave the detail out rather than guessing.`;

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
- No preamble before the first heading, no closing pleasantries after the last section.
- The same task title often repeats across multiple, genuinely separate rows (e.g. several distinct "Meeting
  with AS" entries, each its own date/notes) — a repeated title gets a "(date)" appended right after it
  wherever that happens. Each instance is its own task: never borrow or merge notes from one instance of a
  repeated title into your description of a different instance. If you're not sure which instance a detail
  belongs to, leave it out rather than guessing.`;

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

const REPORT_TYPES = {
  summary: { system: SUMMARY_SYSTEM_PROMPT, buildPrompt: buildSummaryPrompt },
  plan: { system: PLAN_SYSTEM_PROMPT, buildPrompt: buildPlanPrompt },
};

/** GEMINI_API_KEY may be a single key or several comma-separated keys — used
 * as a fallback chain when one hits its daily quota. Note: a second key only
 * helps if it's from a *different* Google Cloud project — free-tier quotas
 * are per-project, so two keys from the same project/account share one
 * 20-requests/day pool and a second key buys nothing. */
export function getApiKeys() {
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
// requests. A real "high demand" window tends to run 10-30s, not the couple
// of seconds this used to assume — [1200, 2500]ms of total backoff gave up
// on all 3 keys before a single window had a chance to clear (observed
// 2026-09-19: every key exhausted its retries and failed inside ~12s). The
// alternative to waiting it out is surfacing the error straight to the
// user, who then burns another one of the free tier's very few daily
// requests just re-clicking "Regenerate" into the same still-overloaded
// window.
function isOverloadError(status, body) {
  return status === 503 || /UNAVAILABLE|overloaded|high demand/i.test(body || "");
}

const OVERLOAD_RETRY_DELAYS_MS = [2000, 5000, 10000]; // 4 attempts total per key

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(apiKey, system, prompt, { jsonMode = false } = {}) {
  const generationConfig = {
    // This model can't fully disable "thinking" (thinkingBudget: 0 is
    // rejected outright by the API; lower budgets don't reliably cap it
    // either), and thinking tokens count against maxOutputTokens — a
    // complex 7-team prompt burned ~3900 tokens on invisible thinking
    // alone. Budget generously for thinking + the actual report text.
    maxOutputTokens: 16384,
    temperature: 0.6,
  };
  // Used by the End of Week report (lib/eowReport.js) to get back
  // per-department narrative fields (blocker/needs-action-from per carried-
  // over item, priorities, accountability flag) as parseable JSON rather
  // than free-form prose — those get merged into deterministically-computed
  // tables afterward, so they need to be reliably machine-readable.
  if (jsonMode) generationConfig.responseMimeType = "application/json";

  const res = await fetch(`${GEMINI_API_URL}/${MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig,
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
export async function callGeminiWithRetry(apiKey, system, prompt, options) {
  let lastErr;
  for (let attempt = 0; attempt < OVERLOAD_RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      return await callGemini(apiKey, system, prompt, options);
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

/** Tries every configured GEMINI_API_KEY in order, falling back to the next
 * one on a quota/overload error (see getApiKeys' doc comment on why a
 * second key only helps from a different Google Cloud project). Shared by
 * every report type, including the End of Week report (lib/eowReport.js),
 * which needs its own separate Gemini call (JSON-mode, for structured
 * narrative fields) outside the summary/plan table below. */
export async function callGeminiAcrossKeys(system, prompt, options) {
  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it as an environment variable to enable AI reports (see README) — get a free key at https://aistudio.google.com/apikey."
    );
  }
  let lastErr;
  for (let i = 0; i < apiKeys.length; i++) {
    try {
      return await callGeminiWithRetry(apiKeys[i], system, prompt, options);
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

export async function generateReport(payload, rawSheets, scope, type, week) {
  if (type === "eow") {
    const { generateEowReport } = await import("./eowReport.js");
    return generateEowReport(payload, rawSheets, scope, week);
  }

  const { system, buildPrompt } = REPORT_TYPES[type] || REPORT_TYPES.summary;
  const prompt = buildPrompt(payload, rawSheets, scope, week);
  const dateLabel = reportDateLabel(payload, scope, type, week);
  const text = await callGeminiAcrossKeys(system, prompt);
  return { text, dateLabel };
}

/** Which day/week of data the report actually covers — shown in the UI and
 * the exported PDF in place of a plain "generated at" timestamp, since the
 * data considered can lag well behind when the report was generated.
 * "eow" isn't handled here — generateReport() routes it to eowReport.js
 * before this is ever called, since that module computes its own label
 * from the target week directly. */
function reportDateLabel(payload, scope, type, week) {
  if (type === "summary") {
    const range = week ? weekRange(week) : null;
    return range ? `Week of ${weekLabel(range.start)}` : null;
  }
  return `Week of ${weekLabel(isoWeekStart(todayIST()))}`; // plan
}

// Same title+Date Received signature diffTasks.js's taskKey uses, for the
// same reason: title alone collides across genuinely distinct rows (see
// that file's comment). Used here to detect which live rows a historical
// snapshot is missing, not for diffing — kept in sync with taskKey manually
// since the two files diff different row shapes for different purposes.
export function rowSignature(row) {
  const get = fieldGetter(row);
  const title = get("task", "tasks", "column 1").toString().trim().toLowerCase();
  if (!title) return null;
  const received = get("date received", "date recieved").toString().trim().toLowerCase();
  return `${title}|${received}`;
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
export function extractTasks(rows, { buckets, dateRange, receivedSince } = {}) {
  const out = [];
  for (const row of rows || []) {
    const get = fieldGetter(row);
    const task = get("task", "tasks", "column 1").toString().trim();
    if (!task) continue;

    const bucket = classifyStatus(get("status"));
    if (buckets && !buckets.includes(bucket)) continue;

    // Same fallback chain aggregate.js uses for anchorDate: not every team's
    // sheet has a literal "Date Received" column (Finance's main tab and
    // Ecomm both only have one generic date column instead) — without this
    // fallback, "added since Monday" silently came up empty for those teams
    // every time, reading as "nothing new" when the real issue was just no
    // Date Received column to check.
    const candidates = [
      parseSheetDate(get("date received", "date recieved")),
      parseSheetDate(get("deadline")),
      parseSheetDate(get("date closed")),
      parseSheetDate(get("date", "timeline", "timeline /date", "timeline/date")),
    ].filter(Boolean);
    const anchor = candidates[0] || null;

    if (dateRange && (!anchor || anchor.getTime() < dateRange.start.getTime() || anchor.getTime() > dateRange.end.getTime())) continue;
    if (receivedSince && (!anchor || anchor.getTime() < receivedSince.start.getTime() || anchor.getTime() > receivedSince.end.getTime())) continue;

    const assignedTo = get("assigned to", "aligned to (mkt)", "poc", "concerned", "owner").toString().trim();
    const notes = truncateNotes(get("notes", "remarks", "remarks "));
    // Which sheet tab this row came from, for a team whose tasks span more
    // than one (e.g. Finance's "Daily" and "Weekly" tabs) — see
    // config/sheets.js's csvUrl `{url, subTab}` form. null for every team
    // that isn't tagged that way.
    out.push({ task, bucket, assignedTo, notes, anchorISO: anchor ? toISODate(anchor) : null, subTab: row.__subTab || null });
  }
  return out;
}

function formatTaskLines(tasks, showStatus) {
  // A sheet like FO routinely has several tasks that are literally titled
  // the same thing ("Meeting with AS" seven times over, each a distinct
  // instance with its own date/notes/status) — when they're all just
  // "Meeting with AS" in the list, the model has no strong per-line anchor
  // and tends to blend one instance's notes into another's write-up. Count
  // duplicates within THIS list and fold the date into the title itself so
  // each repeated-name instance reads as visibly distinct even at a skim.
  const titleCounts = {};
  for (const t of tasks) titleCounts[t.task] = (titleCounts[t.task] || 0) + 1;

  return tasks
    .map((t) => {
      const who = t.assignedTo ? ` — ${t.assignedTo}` : "";
      const note = t.notes ? ` (note: ${t.notes})` : "";
      const statusPrefix = showStatus ? `[${BUCKET_LABEL[t.bucket]}] ` : "";
      const dupTag = titleCounts[t.task] > 1 ? ` (${t.anchorISO || "undated"})` : "";
      return `  ${statusPrefix}${t.task}${dupTag}${who}${note}`;
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
    .map(
      (sub) =>
        `  ${sub}:\n${formatTaskLines(tasks.filter((t) => t.subTab === sub), showStatus).replace(/^  /gm, "    ")}`
    )
    .join("\n");
}

/** Iterate {key, name, source} for either every team (total scope) or just one. */
export function scopeTeams(payload, scope) {
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
export function weekRange(week) {
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

