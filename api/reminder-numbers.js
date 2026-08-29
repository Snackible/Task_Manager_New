import { loadReminderNumbers, saveReminderNumber } from "../lib/reminderStore.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const numbers = await loadReminderNumbers();
      res.status(200).json({ numbers });
    } catch (err) {
      console.error("[reminder-numbers] load failed:", err);
      // A read failure shouldn't break the reminder modal — it just opens
      // with an empty field instead of the saved number.
      res.status(200).json({ numbers: {} });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const { scope, number } = req.body || {};
    if (!scope || typeof scope !== "string") {
      res.status(400).json({ error: "Body must include scope" });
      return;
    }
    if (typeof number !== "string") {
      res.status(400).json({ error: "Body must include number" });
      return;
    }
    const numbers = await saveReminderNumber(scope, number);
    res.status(200).json({ numbers });
  } catch (err) {
    console.error("[reminder-numbers] save failed:", err);
    res.status(500).json({ error: err.message });
  }
}
