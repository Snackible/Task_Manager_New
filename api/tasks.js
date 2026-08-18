import { getDashboardData } from "../lib/dashboardData.js";

export default async function handler(req, res) {
  try {
    const { payload } = await getDashboardData();
    res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
