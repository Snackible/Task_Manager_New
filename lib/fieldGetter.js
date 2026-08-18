// Case/whitespace-tolerant column lookup, since sheet headers occasionally
// carry stray trailing spaces ("Date Closed ") or slightly different casing
// (or entirely different names across teams' sheets, e.g. "Tasks" vs "Task").
export function fieldGetter(row) {
  const map = {};
  for (const k of Object.keys(row)) {
    map[k.trim().toLowerCase()] = row[k];
  }
  return (...candidates) => {
    for (const c of candidates) {
      const v = map[c.toLowerCase()];
      if (v !== undefined) return v;
    }
    return "";
  };
}
