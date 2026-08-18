import { clearCache } from "../lib/dashboardData.js";

// Best-effort on Vercel: this only clears the cache of whichever function
// instance happens to handle this request. It does nothing for other warm
// instances that might be serving concurrent requests — there's no shared
// in-memory state across instances on serverless. Harmless either way: the
// 60s cache in dashboardData.js expires on its own regardless.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  clearCache();
  res.status(204).end();
}
