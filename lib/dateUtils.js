// Small, dependency-free date helpers tuned for this sheet's DD/MM/YYYY (or
// D/M/YY) formatted date columns.

/**
 * Parse a date string like "12/08/2026", "14/8/26", "2026-08-12" into a Date
 * (UTC midnight) or null if it can't be parsed / is empty.
 */
export function parseSheetDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO-ish: 2026-08-12
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return safeUTCDate(+y, +mo, +d);
  }

  // ISO datetime, e.g. "2026-08-11T18:30:00.000Z" — what Apps Script produces
  // when JSON.stringify serializes a Date cell (see appscript/Code.gs, which
  // now formats dates as plain yyyy-MM-dd instead so this shouldn't fire for
  // freshly-redeployed scripts). Kept as a defensive fallback: takes the
  // UTC calendar date as given, which can be off by one day for
  // negative-UTC-offset timezones — the Code.gs fix is the correct one.
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T/);
  if (m) {
    const [, y, mo, d] = m;
    return safeUTCDate(+y, +mo, +d);
  }

  // D/M/YYYY or D/M/YY (day-first, matches the sheets' locale)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    let year = +y;
    if (year < 100) year += 2000;
    return safeUTCDate(year, +mo, +d);
  }

  // D-M-YYYY
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    let year = +y;
    if (year < 100) year += 2000;
    return safeUTCDate(year, +mo, +d);
  }

  return null;
}

function safeUTCDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

/** Monday (UTC midnight) of the ISO week containing `date`. */
export function isoWeekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

export function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** e.g. "Aug 10 – Aug 16, 2026" */
export function weekLabel(weekStart) {
  const end = new Date(weekStart);
  end.setUTCDate(end.getUTCDate() + 6);
  const sameMonth = weekStart.getUTCMonth() === end.getUTCMonth();
  const startStr = `${MONTHS[weekStart.getUTCMonth()]} ${weekStart.getUTCDate()}`;
  const endStr = sameMonth
    ? `${end.getUTCDate()}`
    : `${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`;
  return `${startStr}–${endStr}, ${end.getUTCFullYear()}`;
}

/** e.g. "Mon, Aug 10, 2026" */
export function dayLabel(date) {
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}
