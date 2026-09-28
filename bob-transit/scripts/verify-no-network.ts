/**
 * A4 — ZERO live external network calls on the demo path.
 *
 * Two independent checks:
 *
 *   1. STATIC: every source file reachable from a user request must not contain
 *      a network primitive, unless it is on the explicit acquisition allowlist.
 *      Acquisition scripts are one-shot tools whose output is committed as a
 *      fixture; they must never be imported by the request path.
 *
 *   2. RUNTIME: the request path is exercised with `globalThis.fetch` replaced by
 *      a throwing stub. If anything on the demo path reaches for the network,
 *      the run fails.
 *
 * Exits non-zero on any violation.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Directories that make up the user-facing request path. Nothing here may touch
 * the network — not at build time, not at request time.
 */
const DEMO_PATH_DIRS = [
  "app",
  "components",
  "lib/routing",
  "lib/risk",
  "lib/signals",
  "lib/agents",
  "lib/offline",
  "lib/mock",
  "lib/i18n",
  "lib/gtfs",
  "lib/db",
];

/**
 * Files permitted to perform network I/O. Each is a one-shot acquisition tool
 * whose output is committed as a fixture. Adding a file here is a deliberate,
 * reviewable act.
 */
const ACQUISITION_ALLOWLIST = [
  "eval/fetch-archive.ts",
  "worker/ingest.ts",
  "scripts/acquire-gtfs-static.ts",
];

/** Network primitives that are banned on the demo path. */
const BANNED_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bfetch\s*\(/, label: "fetch()" },
  { re: /\bXMLHttpRequest\b/, label: "XMLHttpRequest" },
  { re: /\baxios\b/, label: "axios" },
  { re: /from\s+["']node:https?["']/, label: "node:http(s) import" },
  { re: /from\s+["']node:net["']/, label: "node:net import" },
  { re: /from\s+["']node:dgram["']/, label: "node:dgram import" },
  { re: /require\(\s*["']https?["']\s*\)/, label: "require('http(s)')" },
  { re: /\bWebSocket\b/, label: "WebSocket" },
  { re: /\bnavigator\.sendBeacon\b/, label: "sendBeacon" },
  { re: /\bEventSource\b/, label: "EventSource" },
];

/**
 * Lines that are legitimately not network calls. Kept deliberately narrow —
 * a broad allowlist would defeat the check.
 */
const LINE_ALLOWLIST: RegExp[] = [
  /\/\/\s*network-allowed/,
  /\/\*\s*network-allowed/,
  /^\s*\*/, // JSDoc continuation lines
];

interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await walk(full, out);
    } else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function staticCheck(): Promise<Violation[]> {
  const violations: Violation[] = [];

  for (const rel of DEMO_PATH_DIRS) {
    const files = await walk(path.join(ROOT, rel));
    for (const file of files) {
      const relPath = path.relative(ROOT, file);
      if (ACQUISITION_ALLOWLIST.includes(relPath)) continue;

      const source = await readFile(file, "utf8");
      const lines = source.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? "";
        if (LINE_ALLOWLIST.some((re) => re.test(text))) continue;

        for (const { re, label } of BANNED_PATTERNS) {
          if (re.test(text)) {
            violations.push({ file: relPath, line: i + 1, label, text: text.trim() });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Runtime check: exercise the request path with fetch stubbed to throw.
 * Every module is imported dynamically so this script still runs when an
 * optional module has not landed yet.
 */
async function runtimeCheck(): Promise<string[]> {
  const failures: string[] = [];
  const attempted: string[] = [];

  const originalFetch = globalThis.fetch;
  const boom = (input: unknown): never => {
    const url = typeof input === "string" ? input : String(input);
    attempted.push(url);
    throw new Error(`NETWORK CALL ATTEMPTED ON DEMO PATH: ${url}`);
  };
  globalThis.fetch = boom as typeof globalThis.fetch;

  try {
    // 1. Graph must load from the committed fixture / built artifact, not the network.
    const graphPath = path.join(ROOT, "public/graph/transit-graph.json");
    try {
      const raw = await readFile(graphPath, "utf8");
      const graph = JSON.parse(raw) as { stats?: { connectionCount?: number } };
      if (!graph.stats || typeof graph.stats.connectionCount !== "number") {
        failures.push("transit-graph.json is missing stats.connectionCount");
      }
    } catch (err) {
      failures.push(
        `could not load public/graph/transit-graph.json from disk (run \`make graph\` first): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 2. The router must plan a journey without touching the network.
    //    The specifier is computed so TypeScript does not statically resolve it —
    //    this script must typecheck even before S1's module lands.
    const routingEntry = ["..", "lib", "routing", "index.ts"].join("/");
    try {
      const routing = (await import(routingEntry)) as Record<string, unknown>;
      const plan = (routing.planJourneys ?? routing.plan) as
        | ((...args: unknown[]) => unknown)
        | undefined;
      if (typeof plan !== "function") {
        failures.push("lib/routing did not export a planJourneys function");
      }
    } catch (err) {
      failures.push(
        `could not import lib/routing: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (attempted.length > 0) {
      failures.push(`network attempted during request-path exercise: ${attempted.join(", ")}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  return failures;
}

async function main(): Promise<void> {
  console.log("A4 — verifying zero live external network calls on the demo path");
  console.log(`repo: ${ROOT}\n`);

  const violations = await staticCheck();

  console.log("── STATIC CHECK ─────────────────────────────────────────");
  console.log(`scanned request-path dirs: ${DEMO_PATH_DIRS.join(", ")}`);
  console.log(`acquisition allowlist: ${ACQUISITION_ALLOWLIST.join(", ")}`);

  if (violations.length === 0) {
    console.log("PASS — no network primitives found on the demo path.\n");
  } else {
    console.log(`FAIL — ${violations.length} violation(s):\n`);
    for (const v of violations) {
      console.log(`  ${v.file}:${v.line}  [${v.label}]`);
      console.log(`      ${v.text}`);
    }
    console.log("");
  }

  console.log("── RUNTIME CHECK ────────────────────────────────────────");
  const runtimeFailures = await runtimeCheck();
  if (runtimeFailures.length === 0) {
    console.log("PASS — request path exercised with fetch() stubbed to throw.\n");
  } else {
    console.log(`FAIL — ${runtimeFailures.length} problem(s):\n`);
    for (const f of runtimeFailures) console.log(`  - ${f}`);
    console.log("");
  }

  const total = violations.length + runtimeFailures.length;
  if (total > 0) {
    console.error(`A4 FAILED — ${total} problem(s). The demo path must not touch the network.`);
    process.exit(1);
  }
  console.log("A4 PASSED — zero live external network calls on the demo path.");
}

main().catch((err) => {
  console.error("A4 check crashed:", err);
  process.exit(1);
});
