/**
 * Minimal RFC-4180 CSV reader for GTFS text files.
 *
 * Why not `csv-parse`? The router is shipped to the browser for offline routing,
 * and `lib/gtfs` must stay importable from client code without dragging a Node
 * CSV dependency into the bundle. The GTFS files here are small, plain and
 * comma-delimited; this reader handles the only thing that actually appears in
 * the fixture (quoted fields, e.g. `"DATO' KERAMAT"`), plus CRLF and a UTF-8 BOM.
 */

/** Parse CSV text into a matrix of raw (untrimmed) fields. */
export function parseCsvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV text into records keyed by the header row. Header names and values
 * are trimmed (the fixture has a trailing space in `BUKIT BINTANG `).
 * Blank lines are skipped. Missing trailing columns become `""`.
 */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text).filter(
    (r) => !(r.length === 1 && r[0].trim() === ""),
  );
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      record[header[c]] = (cells[c] ?? "").trim();
    }
    out.push(record);
  }
  return out;
}
