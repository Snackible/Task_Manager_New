// Bundled demo data, used only for sheet slots that have no `sheetId` /
// `csvUrl` configured (or that fail to fetch). This is a real export of the
// "Task Tracker - FO" sheet at the time this app was built — the other
// tracker sheets were still empty (headers only) in Drive, so their demo
// data is an empty list, which is the honest state, not a bug.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCSV, rowsToObjects } from "../lib/csv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const foCsv = readFileSync(path.join(__dirname, "fo-sample.csv"), "utf8");
const foRows = rowsToObjects(parseCSV(foCsv));

export const SAMPLE_DATA = {
  fo: foRows,
  rnd: [],
  b2b: [],
  gtmt: [],
  marketing: [],
  ecomm: [],
  finance: [],
};
