/**
 * ONE-SHOT ACQUISITION SCRIPT — THE ONLY FILE IN `eval/` ALLOWED TO TOUCH THE NETWORK.
 *
 * Downloads the archived myrapid.com.my media-statement PDFs from the Wayback
 * Machine into `eval/archive/` so that every other part of the eval (labelling,
 * pipeline, metrics, tests) runs fully offline from the cached corpus.
 *
 *   ./node_modules/.bin/tsx eval/fetch-archive.ts
 *   ./node_modules/.bin/tsx eval/fetch-archive.ts --all       # all 323 manifest entries
 *   ./node_modules/.bin/tsx eval/fetch-archive.ts --force     # re-download present files
 *
 * Idempotent: a file that is already present and starts with the PDF magic bytes
 * is skipped. Prints a succeeded/failed summary and writes
 * `eval/archive/fetch-report.json`.
 *
 * Why Wayback and not myrapid.com.my: the origin is behind Imperva bot
 * protection and answers direct requests (including direct PDF fetches) with a
 * 302 redirect loop. The Wayback `id_` URL form returns the raw archived bytes.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = path.join(HERE, "archive");

/** Wayback is slow and flaky under concurrency; keep this modest. */
const CONCURRENCY = 5;
const ATTEMPTS = 4;
const TIMEOUT_MS = 120_000;
const MIN_PDF_BYTES = 512;

interface ManifestEntry {
  timestamp: string;
  original: string;
  wayback: string;
  filename: string;
  looks_like_media_statement: boolean;
}

interface Manifest {
  count?: number;
  entries: ManifestEntry[];
}

export type FetchStatus =
  | "present"
  | "downloaded"
  | "failed"
  | "not-a-pdf";

export interface FetchResult {
  filename: string;
  wayback: string;
  status: FetchStatus;
  bytes: number;
  attempts: number;
  error?: string;
}

/** Decode percent-escapes and strip anything that could escape the archive dir. */
export function safeFilename(raw: string): string {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // Leave malformed escapes alone rather than throwing.
  }
  name = name.replace(/[\\/]+/g, "_").replace(/^\.+/, "_").trim();
  if (!name.toLowerCase().endsWith(".pdf")) name = `${name}.pdf`;
  return name;
}

async function isUsablePdf(file: string): Promise<number | null> {
  try {
    const s = await stat(file);
    if (!s.isFile() || s.size < MIN_PDF_BYTES) return null;
    const head = await readFile(file);
    const magic = head.subarray(0, 5).toString("latin1");
    if (magic !== "%PDF-") return null;
    return s.size;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Two manifest entries can share a basename when the same document was uploaded
 * to different `wp-content/uploads/<year>/<month>/` paths. Collapsing them would
 * silently drop a document, so later occurrences get a deterministic suffix
 * derived from their own original URL. Must be applied in manifest order.
 */
export function dedupeFilenames(entries: ManifestEntry[]): string[] {
  const used = new Map<string, number>();
  return entries.map((entry) => {
    const base = safeFilename(entry.filename);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    if (seen === 0) return base;
    const stem = base.replace(/\.pdf$/i, "");
    return `${stem}__dup${seen + 1}__${entry.timestamp}.pdf`;
  });
}

async function downloadOne(
  entry: ManifestEntry,
  filename: string,
  force: boolean,
): Promise<FetchResult> {
  const target = path.join(ARCHIVE_DIR, filename);

  if (!force) {
    const size = await isUsablePdf(target);
    if (size !== null) {
      return { filename, wayback: entry.wayback, status: "present", bytes: size, attempts: 0 };
    }
  }

  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(entry.wayback, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "user-agent":
            "bob-transit-eval/1.0 (offline research corpus acquisition; contact: local)",
          accept: "application/pdf,*/*",
        },
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        await sleep(500 * attempt * attempt);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const magic = buf.subarray(0, 5).toString("latin1");
      if (magic !== "%PDF-" || buf.byteLength < MIN_PDF_BYTES) {
        // Wayback sometimes serves an HTML interstitial or a truncated body.
        lastError = `not a pdf (${buf.byteLength}B, magic=${JSON.stringify(magic)})`;
        await sleep(1000 * attempt);
        continue;
      }
      await writeFile(target, buf);
      return {
        filename,
        wayback: entry.wayback,
        status: "downloaded",
        bytes: buf.byteLength,
        attempts: attempt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(700 * attempt * attempt);
    }
  }

  return {
    filename,
    wayback: entry.wayback,
    status: "failed",
    bytes: 0,
    attempts: ATTEMPTS,
    error: lastError,
  };
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  const useAll = argv.has("--all");
  const force = argv.has("--force");

  await mkdir(ARCHIVE_DIR, { recursive: true });

  const manifestFile = useAll ? "manifest.json" : "media-statements.json";
  const manifest = JSON.parse(
    await readFile(path.join(ARCHIVE_DIR, manifestFile), "utf8"),
  ) as Manifest;

  const entries = manifest.entries;
  process.stdout.write(
    `[fetch-archive] source=${manifestFile} entries=${entries.length} concurrency=${CONCURRENCY} force=${force}\n`,
  );

  let done = 0;
  const filenames = dedupeFilenames(entries);
  const results = await mapPool(entries, CONCURRENCY, async (entry, i) => {
    const r = await downloadOne(entry, filenames[i]!, force);
    done++;
    if (done % 10 === 0 || done === entries.length) {
      process.stdout.write(`[fetch-archive] ${done}/${entries.length}\n`);
    }
    return r;
  });

  const by = (s: FetchStatus) => results.filter((r) => r.status === s);
  const present = by("present");
  const downloaded = by("downloaded");
  const failed = by("failed");
  const notPdf = by("not-a-pdf");

  const totalBytes = results.reduce((a, r) => a + r.bytes, 0);

  process.stdout.write("\n[fetch-archive] summary\n");
  process.stdout.write(`  present (cached) : ${present.length}\n`);
  process.stdout.write(`  downloaded       : ${downloaded.length}\n`);
  process.stdout.write(`  failed           : ${failed.length}\n`);
  process.stdout.write(`  not-a-pdf        : ${notPdf.length}\n`);
  process.stdout.write(
    `  usable total     : ${present.length + downloaded.length}/${entries.length}\n`,
  );
  process.stdout.write(`  bytes on disk    : ${totalBytes}\n`);
  if (failed.length > 0) {
    process.stdout.write("  failures:\n");
    for (const f of failed) {
      process.stdout.write(`    - ${f.filename}: ${f.error ?? "unknown"}\n`);
    }
  }

  const report = {
    generatedFrom: manifestFile,
    generatedAt: new Date().toISOString(),
    entries: entries.length,
    present: present.length,
    downloaded: downloaded.length,
    failed: failed.length,
    results,
  };
  await writeFile(
    path.join(ARCHIVE_DIR, "fetch-report.json"),
    `${JSON.stringify(report, null, 1)}\n`,
    "utf8",
  );

  if (present.length + downloaded.length === 0) {
    process.stderr.write("[fetch-archive] no PDFs available — aborting\n");
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`[fetch-archive] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
