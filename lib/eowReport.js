// Builds the End of Week report: an accountability-focused weekly report,
// replacing the old day-level EOD recap. Redesigned from a template the
// user provided (see the "Why the current format falls short" rationale in
// that doc) — the core idea is that a week's report can't just describe
// what happened, it has to remember what happened *last* week too, so a
// stuck item reads as "third week running" instead of being described
// fresh every time as if it just came up.
//
// Two kinds of content, assembled together:
//  - Deterministic tables (Executive Snapshot, Chronic Delay Tracker,
//    Non-Reporting Departments, each department's Carried Over table) —
//    computed directly from the data, never left to the model's judgment,
//    since the whole accountability mechanism depends on these being
//    exactly right (same item, same "first flagged" date, every week).
//  - AI-written narrative (Completed-this-week bullets, ranked priorities,
//    the accountability flag sentence, and a blocker/needs-action-from
//    guess per carried-over item pulled from its notes) — asked for as
//    JSON so it can be merged back into the tables above by exact task
//    title, not parsed out of free-form prose.
import { fieldGetter } from "./fieldGetter.js";
import { classifyStatus } from "./statusUtils.js";
import { parseSheetDate, toISODate, isoWeekStart, todayIST, weekLabel } from "./dateUtils.js";
import { scopeTeams, rowSignature, callGeminiAcrossKeys } from "./aiReport.js";
import { loadWeeklyTracking, saveWeeklyTracking } from "./weeklyTrackingStore.js";

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function anchorDates(row) {
  const get = fieldGetter(row);
  return [
    parseSheetDate(get("date received", "date recieved")),
    parseSheetDate(get("deadline")),
    parseSheetDate(get("date closed")),
    parseSheetDate(get("date", "timeline", "timeline /date", "timeline/date")),
  ].filter(Boolean);
}

function isInWeek(dates, weekStartISO, weekEndISO) {
  return dates.some((d) => {
    const iso = toISODate(d);
    return iso >= weekStartISO && iso <= weekEndISO;
  });
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

// For an item the tracked ledger has never seen before, on a department's
// very first tracked week only, estimate its real age from the row's own
// dates instead of assuming "just noticed = brand new." Without this, every
// item in an existing backlog looks brand-new on week 1 purely because
// that's when tracking started — the chronic-delay tables and the
// narrative blocker/needs-action guesses (both gated on 2+ weeks pending,
// see buildNarrativePrompt) would then stay silent on genuinely old items
// for an entire extra week. Every subsequent week relies purely on
// observed ledger continuity, as originally designed — this only patches
// the one-time cold-start gap.
function bootstrapAge(earliestDate, weekStartISO) {
  if (!earliestDate) return null;
  const weekStart = parseSheetDate(weekStartISO);
  const weeksElapsed = Math.floor((weekStart.getTime() - earliestDate.getTime()) / MS_PER_WEEK);
  if (weeksElapsed < 1) return null; // received this week or later — genuinely new, not backdated
  return { firstFlagged: toISODate(isoWeekStart(earliestDate)), weeksPending: weeksElapsed + 1 };
}

/** One department's data for one week, matched against last week's saved
 * ledger to carry forward "first flagged" dates and weeks-pending counts.
 * `previous` is last week's loadWeeklyTracking() result, or null (first
 * tracked week for this department — everything currently open is
 * bootstrapped from its own dates via bootstrapAge, not just started fresh
 * at 1). */
function computeDepartmentWeek(rawSheets, teamKey, weekStartISO, weekEndISO, previous) {
  const rows = (rawSheets[teamKey] && rawSheets[teamKey].rows) || [];
  const completed = [];
  const openNow = [];
  let anyDatedThisWeek = false;

  for (const row of rows) {
    const get = fieldGetter(row);
    const task = get("task", "tasks", "column 1").toString().trim();
    if (!task) continue;
    const bucket = classifyStatus(get("status"));
    const dates = anchorDates(row);
    if (isInWeek(dates, weekStartISO, weekEndISO)) anyDatedThisWeek = true;

    const assignedTo = get("assigned to", "aligned to (mkt)", "poc", "concerned", "owner").toString().trim();
    const notes = get("notes", "remarks", "remarks ").toString().trim();

    if (bucket === "completed") {
      if (isInWeek(dates, weekStartISO, weekEndISO)) completed.push({ task, assignedTo, notes });
    } else {
      const earliestDate = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
      openNow.push({ task, assignedTo, notes, sig: rowSignature(row), earliestDate });
    }
  }

  // Match by title+Date Received (see rowSignature in aiReport.js) — the
  // same identity problem diffTasks.js solves for day-over-day diffing
  // applies here week-over-week: several genuinely distinct tasks sharing
  // one title (e.g. "Meeting with AS") would otherwise be indistinguishable
  // when checking "was this the same stuck item last week."
  const prevBySig = new Map();
  for (const item of (previous && previous.carriedOver) || []) {
    if (item.sig) prevBySig.set(item.sig, item);
  }
  const isFirstTrackedWeek = previous === null;
  const carriedOver = openNow.map(({ earliestDate, ...item }) => {
    const prevItem = item.sig && prevBySig.get(item.sig);
    if (prevItem) {
      return { ...item, firstFlagged: prevItem.firstFlagged, weeksPending: prevItem.weeksPending + 1 };
    }
    const bootstrap = isFirstTrackedWeek && bootstrapAge(earliestDate, weekStartISO);
    return {
      ...item,
      firstFlagged: bootstrap ? bootstrap.firstFlagged : weekStartISO,
      weeksPending: bootstrap ? bootstrap.weeksPending : 1,
    };
  });

  // "Reported" means the department logged something real this week — a
  // completion or anything with a date landing in this week. A department
  // sitting on old open items with no fresh activity has filed nothing,
  // same as an explicit "not updated."
  const reported = completed.length > 0 || anyDatedThisWeek;
  const nonReportingStreak = reported ? 0 : ((previous && previous.nonReportingStreak) || 0) + 1;

  return { reported, nonReportingStreak, completedCount: completed.length, completed, carriedOver };
}

const NOTES_CHAR_CAP = 280;
function truncate(s) {
  return s.length <= NOTES_CHAR_CAP ? s : `…${s.slice(-NOTES_CHAR_CAP)}`;
}

// Asking the model to write a {blocker, needsActionFrom} entry for every
// carried-over item doesn't scale: a heavily-used tracker can easily have
// several hundred open (non-completed) items across departments, and that
// output — on top of completedSummary/priorities — blows straight through
// the token budget and gets the whole narrative cut off mid-JSON (observed
// 2026-09-19: a real run with ~400 open items across 7 departments hit
// MAX_TOKENS and produced nothing at all, taking every department's
// narrative down with it, not just the oversized one). Capping the
// per-item narrative to chronic items (2+ weeks pending, the same
// threshold the Chronic Delay Tracker itself uses) bounds output to
// however many items have genuinely been stuck a while, which is the only
// subset an accountability report actually needs a blocker story for — a
// brand-new open item doesn't have one yet. A defensive per-department cap
// on top of that keeps a single runaway department from reintroducing the
// same blowup once enough items go chronic at once.
const MAX_CHRONIC_NARRATIVE_ITEMS = 25;
const MAX_DISPLAYED_CARRIED_ITEMS = 40;

// Printed/exported report tables are a different budget than the narrative
// prompt above (page count, not tokens), but the same problem: a heavily-
// used tracker's full open-item list runs to hundreds of rows per
// department, which is a backlog dump, not an executive "snapshot" — and
// printed to PDF, hundreds of table rows becomes dozens of pages (observed
// 2026-09-19: a real run came out to 45 pages). Both tables below are
// capped at the oldest/most-pending rows, which is what an accountability
// report actually needs to surface; the full backlog stays one click away
// in the dashboard's own task view.
const MAX_CARRIED_TABLE_ROWS = 20;
const MAX_CHRONIC_TRACKER_ROWS = 30;

/** Builds the JSON-mode prompt asking Gemini for the narrative parts only —
 * everything structural (which items are carried over, their ages, the
 * cross-department tables) is already decided by computeDepartmentWeek and
 * never left to the model. */
function buildNarrativePrompt(teams, perTeam, weekStartISO, weekEndISO) {
  const configuredTeams = teams.filter((team) => !perTeam[team.key].notConfigured);
  const sections = configuredTeams
    .map((team) => {
      const d = perTeam[team.key];
      const completedLines = d.completed
        .map((c) => `  - ${c.task}${c.assignedTo ? ` — ${c.assignedTo}` : ""}${c.notes ? ` (note: ${truncate(c.notes)})` : ""}`)
        .join("\n") || "  (none)";
      const sortedCarried = [...d.carriedOver].sort((a, b) => b.weeksPending - a.weeksPending);
      const shown = sortedCarried.slice(0, MAX_DISPLAYED_CARRIED_ITEMS);
      const omitted = sortedCarried.length - shown.length;
      const carriedLines =
        shown
          .map(
            (c) =>
              `  - "${c.task}"${c.assignedTo ? ` — ${c.assignedTo}` : ""}, pending ${c.weeksPending} week(s) since ${c.firstFlagged}${c.notes ? ` (note: ${truncate(c.notes)})` : ""}`
          )
          .join("\n") || "  (none)";
      const omittedNote = omitted > 0 ? `\n  (+ ${omitted} more open item(s), all pending 1 week — too new to prioritize or need a blocker story yet)` : "";
      return `${team.name.toUpperCase()} (reported: ${d.reported ? "yes" : "no"}${d.nonReportingStreak > 0 ? `, non-reporting streak: ${d.nonReportingStreak} week(s)` : ""}):
  Completed this week:
${completedLines}
  Carried over / still pending (sorted oldest-first):
${carriedLines}${omittedNote}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return `Week of ${weekStartISO} to ${weekEndISO}. For each department below, return narrative content as JSON.

${sections}

Return ONLY a JSON object shaped exactly like this, one key per department (lowercase, matching the department names above with spaces replaced by nothing, e.g. "foundersoffice" for "FOUNDER'S OFFICE" — actually use these exact keys in order: ${configuredTeams.map((t) => `"${t.key}"`).join(", ")}):

{
  "<team key>": {
    "completedSummary": "1-3 short bullet-style sentences crediting who did what, pulling real detail from notes — empty string if nothing was completed",
    "priorities": ["ranked priority 1", "priority 2", "..."],
    "accountabilityFlag": "one plain sentence if this department has a real chronic-delay or non-reporting issue worth calling out this week, else null",
    "carriedOver": {
      "<exact task title from the list above, CHRONIC ITEMS ONLY — see rules>": { "blocker": "short phrase — what's actually stuck, from the note", "needsActionFrom": "a named person if the note identifies one, else the department/vendor" }
    }
  }
}

Rules:
- completedSummary: credit people by name, pull specifics from notes, don't just restate the task title. Max 5 real items — if there are more, cover the most significant and note the rest happened without listing all.
- priorities: max 5, ranked, pulled from carried-over items plus anything with an obvious hard deadline in its notes. If a department genuinely has nothing to prioritize, return an empty array — don't pad it.
- accountabilityFlag: null unless something in this department's data actually warrants it (a carried-over item pending 2+ weeks, or a non-reporting streak). Never invent one for a clean department.
- carriedOver: ONLY include entries for items pending 2+ weeks (chronic delays) — skip every item pending just 1 week, it's too new to have a blocker story. Cap it at the ${MAX_CHRONIC_NARRATIVE_ITEMS} oldest chronic items per department if there are more than that. If notes don't clearly state a blocker, write "no blocker stated in notes" rather than guessing. A department with no items pending 2+ weeks gets an empty carriedOver object — that's correct, not an omission.
- Every department key listed above must be present in your response, even if its values are empty/null.
- Return raw JSON only — no markdown code fences, no commentary before or after.`;
}

const EOW_SYSTEM_PROMPT = `You are producing structured data for an accountability-focused End of Week report for a
founder/manager audience. You are not writing the final document — only the narrative fields requested, as
JSON, which get merged into tables that are already built. Be precise and honest: don't inflate a quiet
department's activity, and don't manufacture an accountability flag where the data doesn't support one. Pull
real specifics out of notes wherever they exist rather than restating task titles.`;

async function getNarrative(teams, perTeam, weekStartISO, weekEndISO) {
  const prompt = buildNarrativePrompt(teams, perTeam, weekStartISO, weekEndISO);
  const raw = await callGeminiAcrossKeys(EOW_SYSTEM_PROMPT, prompt, { jsonMode: true });
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("[eowReport] narrative JSON parse failed, falling back to empty narrative:", err, raw.slice(0, 500));
    return {};
  }
}

function escapeCell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function mdTable(headers, rows) {
  if (rows.length === 0) {
    return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n| ${headers.map(() => "—").join(" | ")} |`;
  }
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

// Markdown link syntax `[text](#anchor)` — parsed client-side (see
// renderMarkdownLite's inline() in app.js) into a real <a>, so clicking a
// department name anywhere in the report (this table, the chronic tracker,
// the non-reporting list) jumps straight to that department's own section
// further down. The anchor itself is planted on each department's heading
// below via the matching `{#dept-<key>}` suffix.
function deptLink(name, key) {
  return `[${name}](#dept-${key})`;
}

// The template's own flag rules (Part D) are explicit that this should be
// "mechanical, not a judgment call each week": a chronic item (2+ weeks
// pending) always warrants a flag, whether or not the department also
// reported this week, and whether or not Gemini's narrative call happened
// to succeed. Used for both the Executive Snapshot's "Top flag" cell and
// each department's own accountability-flag line, so a Gemini outage never
// silently drops a flag that the deterministic data already justifies.
function mechanicalFlag(d, teamName) {
  if (!d.reported) {
    return `Non-reporting${d.nonReportingStreak > 1 ? ` (${d.nonReportingStreak} weeks running)` : " this week"}`;
  }
  const chronicCount = d.carriedOver.filter((c) => c.weeksPending >= 2).length;
  if (chronicCount > 0) {
    return `${chronicCount} item(s) carried over 2+ weeks`;
  }
  return "None";
}

function assembleReport(teams, perTeam, chronicDelays, nonReporting, narrative, weekStartISO, weekEndISO) {
  const snapshotRows = teams
    .filter((t) => !perTeam[t.key].notConfigured)
    .map((t) => {
      const d = perTeam[t.key];
      const overdue = d.carriedOver.filter((c) => c.weeksPending >= 2).length;
      const n = narrative[t.key] || {};
      const topFlag = n.accountabilityFlag || mechanicalFlag(d, t.name);
      return [deptLink(t.name, t.key), d.reported ? "Yes" : "No", String(d.completedCount), overdue ? String(overdue) : "—", topFlag];
    });

  const shownChronic = chronicDelays.slice(0, MAX_CHRONIC_TRACKER_ROWS);
  const omittedChronic = chronicDelays.length - shownChronic.length;
  const chronicRows = shownChronic.map((c) => [
    c.task,
    deptLink(c.deptName, c.teamKey),
    c.assignedTo || "—",
    `${c.weeksPending} (${c.firstFlagged} → ${weekEndISO})`,
    (narrative[c.teamKey] && narrative[c.teamKey].carriedOver && narrative[c.teamKey].carriedOver[c.task]?.blocker) || "—",
    (narrative[c.teamKey] && narrative[c.teamKey].carriedOver && narrative[c.teamKey].carriedOver[c.task]?.needsActionFrom) || "—",
  ]);

  const nonReportingRows = nonReporting.map((n) => [
    deptLink(n.deptName, n.teamKey),
    `${n.streak} week(s)`,
    n.streak >= 3 ? "Escalate to AS — 3+ non-reporting weeks" : "Watch",
  ]);

  const parts = [];
  parts.push(`## Executive Accountability Snapshot`);
  parts.push(mdTable(["Department", "Reported this week?", "Items completed", "Items overdue (2+ wks)", "Top flag"], snapshotRows));

  parts.push(`\n## Cross-Department Chronic Delay Tracker`);
  parts.push(
    chronicRows.length
      ? mdTable(["Item", "Department", "Owner", "Weeks pending", "Blocker", "Needs action from"], chronicRows)
      : "_Nothing has been carried over for 2+ consecutive weeks — no chronic delays this week._"
  );
  if (omittedChronic > 0) {
    parts.push(`\n_+ ${omittedChronic} more chronic item(s) not shown — see the full backlog in the dashboard's task view._`);
  }

  if (nonReportingRows.length) {
    parts.push(`\n## Non-Reporting Departments`);
    parts.push(mdTable(["Department", "Weeks with no real update", "Note"], nonReportingRows));
  }

  // Narrative sections read like a report; task-list tables read like a
  // spreadsheet. Interleaving one department's table between the next
  // department's narrative meant you couldn't read straight through the
  // summary without hitting a wall of rows first — so every department's
  // narrative (completed, priorities, accountability flag) runs first, and
  // every department's carried-over table is deferred to one appendix
  // section at the very end, linked from a one-line count in the narrative.
  for (const team of teams) {
    const d = perTeam[team.key];
    parts.push(`\n## ${team.name.toUpperCase()}: {#dept-${team.key}}`);
    if (d.notConfigured) {
      parts.push("Not updated");
      continue;
    }
    const n = narrative[team.key] || {};
    parts.push(`**Completed this week:** ${n.completedSummary || (d.completedCount === 0 ? "None reported." : "")}`);

    // Only chronic items (2+ weeks pending) count toward the report at all —
    // a task that's merely open, not stuck, isn't an accountability story
    // yet (buildNarrativePrompt already only asks Gemini about chronic
    // items, so a fresh item's blocker cell was always going to read "—").
    const chronicCount = d.carriedOver.filter((c) => c.weeksPending >= 2).length;
    if (d.carriedOver.length === 0) {
      parts.push(`\n**Carried over:** Nothing — clean slate.`);
    } else if (chronicCount === 0) {
      parts.push(`\n**Carried over:** ${d.carriedOver.length} item(s) open, none yet 2+ weeks pending.`);
    } else {
      parts.push(`\n**Carried over:** ${chronicCount} item(s) pending 2+ weeks — [full list](#carried-${team.key}).`);
    }

    if (Array.isArray(n.priorities) && n.priorities.length) {
      parts.push(`\n**Priorities for next week:**`);
      parts.push(n.priorities.map((p, i) => `${i + 1}. ${p}`).join("\n"));
    }

    if (n.accountabilityFlag) {
      parts.push(`\n**Accountability flag:** ${n.accountabilityFlag}`);
    } else if (!d.reported) {
      parts.push(
        `\n**Accountability flag:** Non-reporting — ${team.name} has filed nothing usable this week${
          d.nonReportingStreak > 1 ? ` (${d.nonReportingStreak} weeks running)` : ""
        }.`
      );
    } else if (chronicCount > 0) {
      parts.push(
        `\n**Accountability flag:** ${chronicCount} item(s) have been carried over for 2+ weeks — see Task Detail below.`
      );
    }
  }

  // Appendix: every department's carried-over table, together, after every
  // department's narrative. Skips departments with nothing chronic to show —
  // the narrative loop above already said so in one line.
  const appendixTeams = teams.filter((team) => !perTeam[team.key].notConfigured && perTeam[team.key].carriedOver.some((c) => c.weeksPending >= 2));
  if (appendixTeams.length) {
    parts.push(`\n## Task Detail — Carried Over Items`);
    for (const team of appendixTeams) {
      const d = perTeam[team.key];
      const n = narrative[team.key] || {};
      const freshCount = d.carriedOver.filter((c) => c.weeksPending < 2).length;
      const chronicCarried = d.carriedOver.filter((c) => c.weeksPending >= 2).sort((a, b) => b.weeksPending - a.weeksPending);
      const shownCarried = chronicCarried.slice(0, MAX_CARRIED_TABLE_ROWS);
      const omittedCarried = chronicCarried.length - shownCarried.length;
      const carriedRows = shownCarried.map((c) => {
        const info = (n.carriedOver && n.carriedOver[c.task]) || {};
        return [c.task, c.assignedTo || "—", c.firstFlagged, info.blocker || "—", info.needsActionFrom || "—"];
      });
      parts.push(`\n## ${team.name.toUpperCase()} {#carried-${team.key}}`);
      parts.push(mdTable(["Item", "Owner", "First flagged (week of)", "Blocker", "Needs action from"], carriedRows));
      if (omittedCarried > 0) {
        parts.push(`\n_+ ${omittedCarried} more chronic item(s) not shown — see the full backlog in the dashboard's task view._`);
      }
      if (freshCount > 0) {
        parts.push(`\n_+ ${freshCount} item(s) opened this week or last, not yet 2+ weeks pending — not shown here._`);
      }
    }
  }

  return parts.join("\n");
}

export async function generateEowReport(payload, rawSheets, scope, week) {
  const teams = scopeTeams(payload, scope);
  const weekStart = week ? parseSheetDate(week) : isoWeekStart(todayIST());
  const anchoredWeekStart = isoWeekStart(weekStart || todayIST());
  const weekStartISO = toISODate(anchoredWeekStart);
  const weekEndISO = toISODate(addDays(anchoredWeekStart, 6));
  const prevWeekStartISO = toISODate(addDays(anchoredWeekStart, -7));

  const perTeam = {};
  for (const team of teams) {
    if (team.source === "demo" || team.source === "empty") {
      perTeam[team.key] = { notConfigured: true, reported: false, nonReportingStreak: 0, completedCount: 0, completed: [], carriedOver: [] };
      continue;
    }
    const previous = await loadWeeklyTracking(team.key, prevWeekStartISO).catch((err) => {
      console.error(`[eowReport] loadWeeklyTracking failed for ${team.key}, treating as first tracked week:`, err);
      return null;
    });
    const computed = computeDepartmentWeek(rawSheets, team.key, weekStartISO, weekEndISO, previous);
    perTeam[team.key] = computed;
    saveWeeklyTracking(team.key, weekStartISO, {
      reported: computed.reported,
      nonReportingStreak: computed.nonReportingStreak,
      completedCount: computed.completedCount,
      carriedOver: computed.carriedOver.map((c) => ({
        sig: c.sig,
        task: c.task,
        assignedTo: c.assignedTo,
        firstFlagged: c.firstFlagged,
        weeksPending: c.weeksPending,
      })),
    }).catch((err) => console.error(`[eowReport] saveWeeklyTracking failed for ${team.key}:`, err));
  }

  const chronicDelays = [];
  const nonReporting = [];
  for (const team of teams) {
    const d = perTeam[team.key];
    if (d.notConfigured) continue;
    for (const item of d.carriedOver) {
      if (item.weeksPending >= 2) chronicDelays.push({ ...item, deptName: team.name, teamKey: team.key });
    }
    if (d.nonReportingStreak >= 1) nonReporting.push({ deptName: team.name, teamKey: team.key, streak: d.nonReportingStreak });
  }
  chronicDelays.sort((a, b) => b.weeksPending - a.weeksPending);

  let narrative = {};
  try {
    narrative = await getNarrative(teams, perTeam, weekStartISO, weekEndISO);
  } catch (err) {
    // A narrative failure (Gemini down/quota) shouldn't take down the whole
    // report — the tables (the actual accountability mechanism) are already
    // fully computed and correct without it; the report just reads more
    // sparsely (no completed-summary prose, no AI-guessed blockers) until
    // the next successful generate.
    console.error("[eowReport] narrative generation failed, continuing with tables only:", err);
  }

  const text = assembleReport(teams, perTeam, chronicDelays, nonReporting, narrative, weekStartISO, weekEndISO);
  const dateLabel = `Week of ${weekLabel(anchoredWeekStart)}`;
  return { text, dateLabel };
}
