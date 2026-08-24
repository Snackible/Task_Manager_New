import { getDashboardData } from "../lib/dashboardData.js";
import { generateReport } from "../lib/aiReport.js";

// Gemini calls (plus the built-in overload retry/backoff in aiReport.js)
// can comfortably take under a minute even in the worst case, well within
// Vercel's default 300s function duration — no custom maxDuration needed.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const { payload, rawSheets } = await getDashboardData();
    const scope = (req.query && req.query.scope) || "total";
    const rawType = req.query && req.query.type;
    const type = ["plan", "eod"].includes(rawType) ? rawType : "summary";
    const week = (req.query && req.query.week) || null; // Monday (YYYY-MM-DD); summary-mode only
    const day = (req.query && req.query.day) || null; // YYYY-MM-DD; eod-mode only
    const { text: report, dateLabel } = await generateReport(payload, rawSheets, scope, type, week, day);
    res.status(200).json({ report, dateLabel, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
