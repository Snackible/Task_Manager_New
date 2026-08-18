import { parseSheetDate, isoWeekStart, toISODate, weekLabel, dayLabel } from "./dateUtils.js";
import { classifyWithOverdue, emptyStatusCounts, STATUS_LABELS } from "./statusUtils.js";
import { fieldGetter } from "./fieldGetter.js";

/** Bump the bucket for `key` inside `map`, creating it (via `makeEntry`) on first use. */
function bump(map, key, makeEntry, bucket) {
  if (!map.has(key)) map.set(key, makeEntry());
  map.get(key)[bucket]++;
}

function sortedByKey(map) {
  return Array.from(map.values()).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

/**
 * @param {Record<string, {name: string, rows: object[]}>} sheets
 */
export function aggregate(sheets) {
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const totals = emptyStatusCounts();
  const perSheet = {};
  const weeklyMap = new Map(); // weekISO -> counts
  const dailyMap = new Map(); // dayISO -> counts
  const perSheetWeeklyMap = new Map(); // sheetKey -> (weekISO -> counts)
  const perSheetDailyMap = new Map(); // sheetKey -> (dayISO -> counts)
  const rawStatusCounts = {};
  let taskCount = 0;
  let undated = 0;

  for (const [key, { name, rows }] of Object.entries(sheets)) {
    perSheet[key] = { name, ...emptyStatusCounts(), total: 0 };
    perSheetWeeklyMap.set(key, new Map());
    perSheetDailyMap.set(key, new Map());

    for (const row of rows) {
      const get = fieldGetter(row);
      // Marketing's header is "Tasks" (plural); GTMT's is literally "Column 1".
      const task = get("task", "tasks", "column 1");
      if (!task) continue; // skip blank rows

      taskCount++;
      const rawStatus = get("status");
      const deadline = parseSheetDate(get("deadline"));
      const bucket = classifyWithOverdue(rawStatus, deadline, today);
      const rawLabel = rawStatus.trim() || "(blank)";
      rawStatusCounts[rawLabel] = (rawStatusCounts[rawLabel] || 0) + 1;

      totals[bucket]++;
      perSheet[key][bucket]++;
      perSheet[key].total++;

      const dateReceived = parseSheetDate(get("date received", "date recieved"));
      const dateClosed = parseSheetDate(get("date closed"));
      // Some sheets (Finance, Ecomm/EOD) only have one generic date column
      // instead of received/deadline/closed — fall back to it last.
      const genericDate = parseSheetDate(get("date", "timeline", "timeline /date", "timeline/date"));
      const anchorDate = dateReceived || deadline || dateClosed || genericDate;

      if (!anchorDate) {
        undated++;
        continue;
      }

      const weekStart = isoWeekStart(anchorDate);
      const weekISO = toISODate(weekStart);
      bump(weeklyMap, weekISO, () => ({ periodStart: weekISO, label: weekLabel(weekStart), ...emptyStatusCounts() }), bucket);
      bump(perSheetWeeklyMap.get(key), weekISO, () => ({ periodStart: weekISO, label: weekLabel(weekStart), ...emptyStatusCounts() }), bucket);

      const dayISO = toISODate(anchorDate);
      bump(dailyMap, dayISO, () => ({ periodStart: dayISO, label: dayLabel(anchorDate), ...emptyStatusCounts() }), bucket);
      bump(perSheetDailyMap.get(key), dayISO, () => ({ periodStart: dayISO, label: dayLabel(anchorDate), ...emptyStatusCounts() }), bucket);
    }
  }

  const perSheetWeekly = {};
  for (const [key, map] of perSheetWeeklyMap.entries()) perSheetWeekly[key] = sortedByKey(map);
  const perSheetDaily = {};
  for (const [key, map] of perSheetDailyMap.entries()) perSheetDaily[key] = sortedByKey(map);

  return {
    generatedAt: new Date().toISOString(),
    taskCount,
    undated,
    totals,
    perSheet,
    weekly: sortedByKey(weeklyMap),
    daily: sortedByKey(dailyMap),
    perSheetWeekly,
    perSheetDaily,
    rawStatusCounts,
    statusLabels: STATUS_LABELS,
  };
}
