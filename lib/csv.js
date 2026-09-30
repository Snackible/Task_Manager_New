// Minimal RFC 4180-ish CSV parser (handles quoted fields, escaped quotes,
// commas/newlines inside quotes). No external dependency needed.

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip; \n handles the row break
    } else {
      field += c;
    }
  }
  // last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Rows (array of arrays) -> array of objects keyed by the header row. */
export function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  // A blank header cell used to become the object key "" — harmless with
  // one blank column, but a sheet with several (a trailing run of unused
  // columns, say) collapsed them all onto that one key, and `forEach`'s
  // last write wins. That silently discarded whichever blank column
  // actually held real data (observed on a sheet whose task title sat in
  // an unlabeled column, clobbered by an empty column further right).
  // Naming each blank column "Column N" (1-based, matching how a person
  // would point at it) keeps every column's value reachable.
  const seen = new Map();
  const header = rows[0].map((h, idx) => {
    const trimmed = h.trim() || `Column ${idx + 1}`;
    const count = (seen.get(trimmed) || 0) + 1;
    seen.set(trimmed, count);
    // A genuine duplicate (two columns literally named the same thing) gets
    // the same treatment, for the same reason — better a "Status (2)" you
    // can still reach than a silently overwritten "Status".
    return count === 1 ? trimmed : `${trimmed} (${count})`;
  });
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = (r[idx] ?? "").trim();
    });
    return obj;
  });
}
