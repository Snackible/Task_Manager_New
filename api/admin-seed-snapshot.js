import { put } from "@vercel/blob";

const SNAPSHOT_PREFIX = "snapshots/";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One-off manual endpoint to backfill historical snapshots into Blob from
// local dev's file-based snapshots (data/snapshots/*.json), since the
// deployed cron never captured any before its auth was fixed. Not part of
// the app's normal flow — safe to delete once the backfill is done.
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const adminSecret = process.env.ADMIN_SEED_SECRET;
  console.log("[admin-seed-snapshot] env check:", { hasAdminSecret: !!adminSecret, hasHeader: !!authHeader });
  if (!adminSecret || authHeader !== `Bearer ${adminSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { date, sheets } = req.body;
    if (!date || !DATE_RE.test(date)) {
      res.status(400).json({ error: "Body must include date as YYYY-MM-DD" });
      return;
    }
    if (!sheets || typeof sheets !== "object") {
      res.status(400).json({ error: "Body must include sheets object" });
      return;
    }

    const pathname = `${SNAPSHOT_PREFIX}${date}.json`;
    await put(pathname, JSON.stringify(sheets), { access: "private", contentType: "application/json" });
    res.status(200).json({ ok: true, date, teams: Object.keys(sheets) });
  } catch (err) {
    console.error("[admin-seed-snapshot] failed:", err);
    res.status(500).json({ error: err.message });
  }
}
