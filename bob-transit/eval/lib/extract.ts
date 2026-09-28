/**
 * PDF -> text extraction. Offline only; reads files already present in
 * `eval/archive/`. Uses the pdfjs-dist legacy build, which runs in Node without
 * a DOM or a real worker.
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_DIR = path.resolve(HERE, "..");
export const ARCHIVE_DIR = path.join(EVAL_DIR, "archive");

export interface ExtractedDoc {
  filename: string;
  pages: number;
  /** Per-page raw text, in page order. */
  pageTexts: string[];
  /** All pages joined; page boundaries become a blank line. */
  text: string;
  /** pdfjs info-dictionary CreationDate/ModDate, ISO-normalised, when present. */
  pdfCreatedAt: string | null;
  pdfModifiedAt: string | null;
}

/**
 * pdfjs emits one item per text run and sets `hasEOL` on runs that end a line.
 * Joining on that recovers the document's own line breaks, which the parser
 * relies on for headline detection.
 */
function itemsToText(
  items: Array<{ str?: string; hasEOL?: boolean }>,
): string {
  const out: string[] = [];
  for (const item of items) {
    if (typeof item.str === "string" && item.str.length > 0) out.push(item.str);
    if (item.hasEOL) out.push("\n");
  }
  return out
    .join(" ")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** pdfjs info dates look like `D:20210623103000+08'00'`. */
export function parsePdfDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function extractPdf(file: string): Promise<ExtractedDoc> {
  // Imported lazily so that the acquisition script (which must not need pdfjs)
  // stays independent of it.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(file));
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    // Silence pdfjs's "TT: undefined function" font warnings on stdout.
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  const pageTexts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pageTexts.push(itemsToText(content.items as Array<{ str?: string; hasEOL?: boolean }>));
    page.cleanup();
  }

  let info: Record<string, unknown> = {};
  try {
    info = (await doc.getMetadata()).info as unknown as Record<string, unknown>;
  } catch {
    info = {};
  }
  const pages = doc.numPages;
  // v6 exposes teardown on the loading task, not the document proxy.
  await loadingTask.destroy();

  return {
    filename: path.basename(file),
    pages,
    pageTexts,
    text: pageTexts.join("\n\n"),
    pdfCreatedAt: parsePdfDate(info["CreationDate"]),
    pdfModifiedAt: parsePdfDate(info["ModDate"]),
  };
}

/** Sorted list of every PDF currently cached in `eval/archive/`. */
export async function listArchivedPdfs(): Promise<string[]> {
  const names = await readdir(ARCHIVE_DIR);
  return names.filter((n) => n.toLowerCase().endsWith(".pdf")).sort();
}

export interface ExtractAllOptions {
  outFile?: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Extract every cached PDF. Results are keyed by filename so the labeller can
 * join against the manifest. Ordering is by filename, which makes the whole
 * pipeline deterministic.
 */
export async function extractAll(
  options: ExtractAllOptions = {},
): Promise<Record<string, ExtractedDoc>> {
  const files = await listArchivedPdfs();
  const out: Record<string, ExtractedDoc> = {};
  let done = 0;
  for (const name of files) {
    try {
      out[name] = await extractPdf(path.join(ARCHIVE_DIR, name));
    } catch (err) {
      // A corrupt PDF must not silently drop the document from the corpus; the
      // labeller records it as unreadable and the report counts it.
      out[name] = {
        filename: name,
        pages: 0,
        pageTexts: [],
        text: "",
        pdfCreatedAt: null,
        pdfModifiedAt: null,
      };
      process.stderr.write(
        `[extract] WARN ${name}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    done++;
    options.onProgress?.(done, files.length);
  }
  if (options.outFile) {
    await mkdir(path.dirname(options.outFile), { recursive: true });
    await writeFile(options.outFile, `${JSON.stringify(out, null, 1)}\n`, "utf8");
  }
  return out;
}
