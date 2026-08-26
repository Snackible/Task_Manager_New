import { getDashboardData } from "../lib/dashboardData.js";
import { generateReport } from "../lib/aiReport.js";
import { saveReport, loadReport } from "../lib/reportStore.js";

// Gemini calls (plus the built-in overload retry/backoff in aiReport.js)
// can comfortably take under a minute even in the worst case, well within
// Vercel's default 300s function duration — no custom maxDuration needed.

/** The "extra" key that pins a report to a specific week/day beyond just
 * scope+type — mirrors the client's reportExtraParam() so a save and a
 * later restore land on the exact same storage key. */
function reportExtraParam(type, week, day) {
  if (type === "summary") return week || "";
  if (type === "eod") return day || "";
  return "";
}

export default async function handler(req, res) {
  const scope = (req.query && req.query.scope) || "total";
  const rawType = req.query && req.query.type;
  const type = ["plan", "eod"].includes(rawType) ? rawType : "summary";
  const week = (req.query && req.query.week) || null; // Monday (YYYY-MM-DD); summary-mode only
  const day = (req.query && req.query.day) || null; // YYYY-MM-DD; eod-mode only
  const extra = reportExtraParam(type, week, day);

  if (req.method === "GET") {
    // Restores whatever was last generated for this exact scope/type/week-
    // or-day combo, so the report panel survives a reload without asking
    // Gemini again. report: null (not a 404) when nothing's been generated
    // yet for this combo — that's a normal empty state, not an error.
    try {
      const stored = await loadReport(scope, type, extra);
      res.status(200).json(stored || { report: null });
    } catch (err) {
      console.error("[report] restore failed:", err);
      res.status(200).json({ report: null });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const { payload, rawSheets } = await getDashboardData();
    const { text: report, dateLabel } = await generateReport(payload, rawSheets, scope, type, week, day);
    const generatedAt = new Date().toISOString();
    try {
      await saveReport(scope, type, extra, { report, dateLabel });
    } catch (err) {
      // Don't fail the whole request over a persistence hiccup — the user
      // still gets their report this session, it just won't survive a
      // reload until the next successful generate.
      console.error("[report] save failed:", err);
    }
    res.status(200).json({ report, dateLabel, generatedAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
