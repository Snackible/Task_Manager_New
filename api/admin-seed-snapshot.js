import { put, get, del } from "@vercel/blob";

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

  if (req.method === "GET") {
    // Read-only existence/content check — never writes. ?date=YYYY-MM-DD
    // Optional ?full=true returns raw row content instead of just counts —
    // scope it with ?team=<key> (recommended, avoids huge payloads) and/or
    // ?task=<substring> (case-insensitive match on the task title) to pull
    // just the row(s) needed to compare across days.
    try {
      const date = req.query && req.query.date;
      if (!date || !DATE_RE.test(date)) {
        res.status(400).json({ error: "Query must include date as YYYY-MM-DD" });
        return;
      }
      const result = await get(`${SNAPSHOT_PREFIX}${date}.json`, { access: "private" });
      if (!result) {
        res.status(200).json({ exists: false, date });
        return;
      }
      const sheets = await new Response(result.stream).json();

      const full = req.query && req.query.full === "true";
      if (full) {
        const team = req.query && req.query.team;
        const taskFilter = req.query && req.query.task ? req.query.task.toLowerCase() : null;
        const teamsToReturn = team ? { [team]: sheets[team] || [] } : sheets;
        const rows = {};
        for (const [key, teamRows] of Object.entries(teamsToReturn)) {
          rows[key] = taskFilter
            ? (teamRows || []).filter((r) => JSON.stringify(r).toLowerCase().includes(taskFilter))
            : teamRows;
        }
        res.status(200).json({ exists: true, date, uploadedAt: result.uploadedAt, rows });
        return;
      }

      res.status(200).json({
        exists: true,
        date,
        uploadedAt: result.uploadedAt,
        teams: Object.keys(sheets),
        rowCounts: Object.fromEntries(Object.entries(sheets).map(([k, rows]) => [k, rows.length])),
      });
    } catch (err) {
      console.error("[admin-seed-snapshot] check failed:", err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (req.method === "DELETE") {
    // Removes a stale snapshot so the next cron run is free to write a
    // fresh one in its place (the "already captured" guard in
    // snapshotStore.js otherwise blocks overwriting an existing file, even
    // a known-incomplete one). ?date=YYYY-MM-DD
    try {
      const date = req.query && req.query.date;
      if (!date || !DATE_RE.test(date)) {
        res.status(400).json({ error: "Query must include date as YYYY-MM-DD" });
        return;
      }
      await del(`${SNAPSHOT_PREFIX}${date}.json`);
      res.status(200).json({ ok: true, deleted: date });
    } catch (err) {
      console.error("[admin-seed-snapshot] delete failed:", err);
      res.status(500).json({ error: err.message });
    }
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
    await put(pathname, JSON.stringify(sheets), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
    });
    res.status(200).json({ ok: true, date, teams: Object.keys(sheets) });
  } catch (err) {
    console.error("[admin-seed-snapshot] failed:", err);
    res.status(500).json({ error: err.message });
  }
}
