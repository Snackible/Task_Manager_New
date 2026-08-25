import { getDashboardData } from "../lib/dashboardData.js";
import { saveTodaySnapshot } from "../lib/snapshotStore.js";

// Vercel invokes this on the schedule declared in vercel.json (see the
// "crons" array) and automatically sends CRON_SECRET as a Bearer token —
// see https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
// Without this check, anyone who found this URL could trigger it freely.
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const { payload, rawSheets } = await getDashboardData();
    await saveTodaySnapshot(rawSheets, payload.sources);
    res.status(200).json({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[cron-snapshot] failed:", err);
    res.status(500).json({ error: err.message });
  }
}
