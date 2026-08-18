import { getDashboardData } from "../lib/dashboardData.js";
import { buildTaskList } from "../lib/taskList.js";

export default async function handler(req, res) {
  try {
    const { rawSheets } = await getDashboardData();
    const scope = (req.query && req.query.scope) || "total";
    const list = buildTaskList(rawSheets, scope === "total" ? null : scope);
    res.status(200).json({ tasks: list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
