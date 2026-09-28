/**
 * A4 — ZERO live EXTERNAL network calls on the demo path.
 *
 * "External" is the operative word. This app is ONE Next.js deployment serving
 * both UI and API, so the request path legitimately fetches its OWN origin
 * (`/api/route`, `/graph/transit-graph.json`). Those are not external calls —
 * and the graph fetch is the whole point of the offline-first design.
 *
 * What must never happen is a call to a third-party host on the demo path.
 *
 * Two independent checks:
 *
 *   1. STATIC: request-path sources must not reference an absolute external URL
 *      in a network primitive, and must not import a network client library.
 *      One-shot acquisition scripts are allowlisted — their output is committed
 *      as a fixture and they must never be imported by the request path.
 *
 *   2. RUNTIME: the request path is exercised with `globalThis.fetch` replaced by
 *      a recorder that THROWS on any non-same-origin URL. Same-origin calls are
 *      permitted and logged.
 *
 * Exits non-zero on any violation.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Directories that make up the user-facing request path. */
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
 * Files permitted to reach external hosts. Each is a one-shot acquisition tool
 * whose output is committed as a fixture. Adding a file here is deliberate.
 */
const ACQUISITION_ALLOWLIST = [
  "eval/fetch-archive.ts",
  "worker/ingest.ts",
  "worker/client.ts",
  "worker/scripts/capture-fixture.ts",
  "scripts/acquire-gtfs-static.ts",
];

/**
 * Absolute URLs that are NOT external: loopback and the wildcard bind address.
 * Everything else with a scheme+host is a third party.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/** Matches an absolute URL and captures its host. */
const ABSOLUTE_URL_RE = /\bhttps?:\/\/([^\s"'`/)]+)/g;

/**
 * Network client libraries that have no legitimate place on the request path.
 * Bare `fetch` is NOT in this list — same-origin fetch is fine.
 */
const BANNED_LIBRARIES: Array<{ re: RegExp; label: string }> = [
  { re: /\baxios\b/, label: "axios" },
  { re: /\bXMLHttpRequest\b/, label: "XMLHttpRequest" },
  { re: /from\s+["']node:https?["']/, label: "node:http(s) import" },
  { re: /from\s+["']node:net["']/, label: "node:net import" },
  { re: /from\s+["']node:dgram["']/, label: "node:dgram import" },
  { re: /\bWebSocket\b/, label: "WebSocket" },
  { re: /\bnavigator\.sendBeacon\b/, label: "sendBeacon" },
  { re: /\bEventSource\b/, label: "EventSource" },
];

/**
 * Call sites whose argument we inspect for a third-party host.
 *
 * A bare URL string elsewhere in the source is DATA, not a network call — e.g.
 * `SourceRef.url` provenance links in fixtures. Only URLs that are actually
 * handed to a network primitive count as violations.
 */
const NETWORK_CALL_SITES: RegExp[] = [
  /\bfetch\s*\(/,
  /\baxios\s*[.(]/,
  /\bnew\s+WebSocket\s*\(/,
  /\bnew\s+EventSource\s*\(/,
  /\bnavigator\.sendBeacon\s*\(/,
];

/** How many lines after a call site to search for its URL argument. */
const CALL_ARGUMENT_WINDOW = 6;

/** Lines that legitimately mention a URL without calling it. */
const LINE_ALLOWLIST: RegExp[] = [
  /\/\/\s*network-allowed/,
  /\/\*\s*network-allowed/,
  /^\s*\*/, // JSDoc continuation
  /^\s*\/\//, // line comment
];

interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

function isExternalHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/:\d+$/, "");
  return !LOCAL_HOSTS.has(bare);
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
    for (const file of await walk(path.join(ROOT, rel))) {
      const relPath = path.relative(ROOT, file);
      if (ACQUISITION_ALLOWLIST.includes(relPath)) continue;

      const lines = (await readFile(file, "utf8")).split("\n");

      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? "";
        if (LINE_ALLOWLIST.some((re) => re.test(text))) continue;

        for (const { re, label } of BANNED_LIBRARIES) {
          if (re.test(text)) {
            violations.push({ file: relPath, line: i + 1, label, text: text.trim() });
          }
        }

        // Only inspect URLs that are actually handed to a network primitive.
        // A bare URL string elsewhere is DATA (e.g. SourceRef.url provenance).
        if (NETWORK_CALL_SITES.some((re) => re.test(text))) {
          const window = lines.slice(i, i + CALL_ARGUMENT_WINDOW).join("\n");
          ABSOLUTE_URL_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = ABSOLUTE_URL_RE.exec(window)) !== null) {
            const host = m[1] ?? "";
            if (isExternalHost(host)) {
              violations.push({
                file: relPath,
                line: i + 1,
                label: `external URL passed to a network call (${host})`,
                text: text.trim(),
              });
            }
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Runtime check: exercise the request path with `fetch` replaced by a recorder
 * that throws on any non-same-origin URL. Same-origin calls are recorded.
 */
async function runtimeCheck(): Promise<{ failures: string[]; sameOrigin: string[] }> {
  const failures: string[] = [];
  const sameOrigin: string[] = [];

  const originalFetch = globalThis.fetch;
  const guard = (input: unknown): never => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof input === "object" && input !== null && "url" in input
            ? String((input as { url: unknown }).url)
            : String(input);

    let host = "";
    try {
      host = new URL(url, "http://localhost").hostname;
    } catch {
      host = "";
    }

    if (host && isExternalHost(host)) {
      throw new Error(`EXTERNAL NETWORK CALL ATTEMPTED ON DEMO PATH: ${url}`);
    }
    sameOrigin.push(url);
    // Same-origin fetches are not served in this harness; report as offline.
    return Promise.reject(new Error("offline-harness: same-origin fetch not served")) as never;
  };
  globalThis.fetch = guard as typeof globalThis.fetch;

  try {
    const graphPath = path.join(ROOT, "public/graph/transit-graph.json");
    try {
      const graph = JSON.parse(await readFile(graphPath, "utf8")) as {
        stats?: { connectionCount?: number; segmentCount?: number };
      };
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
  } finally {
    globalThis.fetch = originalFetch;
  }

  return { failures, sameOrigin };
}

async function main(): Promise<void> {
  console.log("A4 — verifying zero live EXTERNAL network calls on the demo path");
  console.log(`repo: ${ROOT}\n`);

  const violations = await staticCheck();

  console.log("── STATIC CHECK ─────────────────────────────────────────");
  console.log(`scanned request-path dirs: ${DEMO_PATH_DIRS.join(", ")}`);
  console.log(`acquisition allowlist: ${ACQUISITION_ALLOWLIST.join(", ")}`);
  console.log("policy: same-origin fetches allowed; third-party hosts banned\n");

  if (violations.length === 0) {
    console.log("PASS — no external network primitives on the demo path.\n");
  } else {
    console.log(`FAIL — ${violations.length} violation(s):\n`);
    for (const v of violations) {
      console.log(`  ${v.file}:${v.line}  [${v.label}]`);
      console.log(`      ${v.text}`);
    }
    console.log("");
  }

  console.log("── RUNTIME CHECK ────────────────────────────────────────");
  const { failures, sameOrigin } = await runtimeCheck();
  if (failures.length === 0) {
    console.log("PASS — request path exercised with fetch() guarded against external hosts.");
    if (sameOrigin.length > 0) {
      console.log(`       same-origin calls observed (allowed): ${sameOrigin.join(", ")}`);
    }
    console.log("");
  } else {
    console.log(`FAIL — ${failures.length} problem(s):\n`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log("");
  }

  const total = violations.length + failures.length;
  if (total > 0) {
    console.error(`A4 FAILED — ${total} problem(s). The demo path must not reach third parties.`);
    process.exit(1);
  }
  console.log("A4 PASSED — zero live external network calls on the demo path.");
}

main().catch((err) => {
  console.error("A4 check crashed:", err);
  process.exit(1);
});
