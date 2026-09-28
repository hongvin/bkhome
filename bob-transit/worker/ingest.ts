#!/usr/bin/env node
/**
 * GTFS-Realtime vehicle-position ingest worker — CLI entry point.
 *
 * This process is NOT on the request path: it runs on a timer (an external
 * scheduler, or `--loop`) and never serves a user request. Everything the user
 * touches is Next.js.
 *
 *   npm run ingest                          # one poll cycle, then exit
 *   npm run ingest -- --loop                # poll every 30s until signalled
 *   npm run ingest -- --category=rapid-bus-kl --timeout=15000
 *   npm run ingest -- --repo-module=../lib/db/index.ts --repo-export=createVehiclePositionRepository
 *
 * Exit codes: 0 success, 1 ingest/binding failure (scheduler should alert),
 * 2 bad CLI usage.
 */
import { pathToFileURL } from "node:url";
import type { FetchLike } from "./client";
import {
  DEFAULT_CATEGORY,
  DEFAULT_TIMEOUT_MS,
  buildFeedUrl,
  runIngestCycle,
  type IngestCycleResult,
} from "./cycle";
import { createRepository, type RepositorySpec } from "./repository";
import { jsonLogger, type Logger, type VehiclePositionRepository } from "./types";

/** Poll interval for `--loop`, matching the 30s cadence in the module spec. */
export const DEFAULT_INTERVAL_MS = 30_000;

export const USAGE = `GTFS-Realtime vehicle-position ingest worker

Usage: npm run ingest -- [options]

Options:
  --once                     run a single poll cycle, then exit (default)
  --loop                     poll repeatedly until SIGINT/SIGTERM
  --interval=<ms>            loop interval (default ${DEFAULT_INTERVAL_MS})
  --category=<name>          feed category (default ${DEFAULT_CATEGORY});
                             rail ("rapid-rail-kl") has no realtime feed
  --url=<url>                override the whole feed URL
  --timeout=<ms>             request timeout (default ${DEFAULT_TIMEOUT_MS})
  --allow-empty              treat a feed with zero usable rows as success
  --fail-fast                in --loop mode, exit 1 on the first failed cycle
  --repo=stdout|memory       where rows go (default stdout, NDJSON)
  --repo-module=<specifier>  import an external repository module (e.g. lib/db)
  --repo-export=<name>       export to read from --repo-module (default default)
  --help                     print this message
`;

export interface CliOptions {
  loop: boolean;
  intervalMs: number;
  category: string;
  /** null means "derive from --category". */
  feedUrl: string | null;
  timeoutMs: number;
  allowEmpty: boolean;
  failFast: boolean;
  repository: RepositorySpec;
  help: boolean;
}

export type ParseResult =
  | { ok: true; options: CliOptions }
  | { ok: false; message: string };

const VALUE_FLAGS = new Set([
  "interval",
  "category",
  "url",
  "timeout",
  "repo",
  "repo-module",
  "repo-export",
]);

const BOOLEAN_FLAGS = new Set([
  "once",
  "loop",
  "allow-empty",
  "fail-fast",
  "help",
]);

function positiveInt(raw: string, flag: string): number | string {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return `--${flag} expects a positive integer, got "${raw}"`;
  }
  return value;
}

/** Parse CLI arguments. Pure — no I/O, no process access. */
export function parseArgs(argv: string[]): ParseResult {
  const options: CliOptions = {
    loop: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    category: DEFAULT_CATEGORY,
    feedUrl: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowEmpty: false,
    failFast: false,
    repository: { kind: "stdout" },
    help: false,
  };

  const seen = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === "") continue;
    if (!arg.startsWith("--")) {
      return { ok: false, message: `unexpected argument "${arg}"` };
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    let value = eq === -1 ? null : body.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (value !== null) {
        return { ok: false, message: `--${name} does not take a value` };
      }
      seen.set(name, "true");
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      return { ok: false, message: `unknown option "--${name}"` };
    }

    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: `--${name} requires a value` };
      }
      value = next;
      i += 1;
    }
    seen.set(name, value);
  }

  // `--once` wins over `--loop` when both are present, so a scheduler can
  // append `--once` to a looping command without editing it.
  if (seen.get("loop") === "true") options.loop = true;
  if (seen.get("once") === "true") options.loop = false;
  if (seen.get("allow-empty") === "true") options.allowEmpty = true;
  if (seen.get("fail-fast") === "true") options.failFast = true;
  if (seen.get("help") === "true") options.help = true;

  const interval = seen.get("interval");
  if (interval !== undefined) {
    const parsed = positiveInt(interval, "interval");
    if (typeof parsed === "string") return { ok: false, message: parsed };
    options.intervalMs = parsed;
  }

  const timeout = seen.get("timeout");
  if (timeout !== undefined) {
    const parsed = positiveInt(timeout, "timeout");
    if (typeof parsed === "string") return { ok: false, message: parsed };
    options.timeoutMs = parsed;
  }

  const category = seen.get("category");
  if (category !== undefined) {
    if (category.trim() === "") {
      return { ok: false, message: "--category must not be empty" };
    }
    options.category = category.trim();
  }

  const url = seen.get("url");
  if (url !== undefined) options.feedUrl = url;

  const repoModule = seen.get("repo-module");
  if (repoModule !== undefined) {
    options.repository = {
      kind: "external",
      moduleSpecifier: repoModule,
      exportName: seen.get("repo-export") ?? "default",
    };
  } else {
    const repo = seen.get("repo") ?? "stdout";
    if (repo !== "stdout" && repo !== "memory") {
      return {
        ok: false,
        message: `--repo expects "stdout" or "memory", got "${repo}"`,
      };
    }
    options.repository = { kind: repo };
  }

  return { ok: true, options };
}

/** Minimal structural view of a stream, so tests can pass an EventEmitter. */
export interface ErrorEmittingStream {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Keep a closed stdout reader (`npm run ingest | head`) from killing the
 * process: a broken pipe arrives asynchronously as an `error` event on the
 * stream, which would otherwise be an unhandled 'error' event. A closed reader
 * is not an ingest failure, so it exits 0; any other stream error exits 1.
 *
 * Injectable so it is testable without exiting the test runner.
 */
export function installEpipeGuard(
  stream: ErrorEmittingStream = process.stdout,
  onFatal: (code: number) => void = (code) => {
    process.exit(code);
  },
): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    onFatal(err.code === "EPIPE" ? 0 : 1);
  });
}

export interface MainDeps {
  /** Pre-built repository; skips repository resolution (used by tests). */
  repository?: VehiclePositionRepository;
  fetchImpl?: FetchLike;
  logger?: Logger;
  /** Injectable sleep for loop tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable clock. */
  now?: () => Date;
  /** External abort, e.g. from a test harness. */
  signal?: AbortSignal;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run the worker. Never throws: returns the process exit code.
 */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.logger ?? jsonLogger;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const options = parsed.options;

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let repository: VehiclePositionRepository;
  try {
    repository = deps.repository ?? (await createRepository(options.repository));
  } catch (err) {
    log("error", "ingest.repository_binding_failed", {
      kind: options.repository.kind,
      moduleSpecifier: options.repository.moduleSpecifier,
      message: err instanceof Error ? err.message : String(err),
    });
    return 1;
  }

  const feedUrl = options.feedUrl ?? buildFeedUrl(options.category);
  const cycleOptions = {
    repository,
    feedUrl,
    category: options.category,
    timeoutMs: options.timeoutMs,
    allowEmpty: options.allowEmpty,
    fetchImpl: deps.fetchImpl,
    logger: log,
  };

  const logResult = (result: IngestCycleResult): void => {
    log(result.ok ? "info" : "error", "ingest.cycle", {
      ok: result.ok,
      feedUrl: result.feedUrl,
      category: result.category,
      observedAt: result.observedAt,
      durationMs: result.durationMs,
      entityCount: result.entityCount,
      rows: result.rows,
      inserted: result.inserted,
      skipped: result.skipped,
      duplicateEntities: result.duplicateEntities,
      skippedEntities: result.skippedEntities,
      error: result.error,
    });
  };

  if (!options.loop) {
    try {
      const result = await runIngestCycle({
        ...cycleOptions,
        observedAt: deps.now?.() ?? new Date(),
      });
      logResult(result);
      return result.ok ? 0 : 1;
    } catch (err) {
      // Defensive: runIngestCycle should never throw.
      log("error", "ingest.unexpected_error", {
        message: err instanceof Error ? err.message : String(err),
      });
      return 1;
    }
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener("abort", onSignal, { once: true });
  }

  const sleep = deps.sleep ?? defaultSleep;
  let cycles = 0;
  try {
    while (!controller.signal.aborted) {
      const startedAt = Date.now();
      const result = await runIngestCycle({
        ...cycleOptions,
        observedAt: deps.now?.() ?? new Date(),
      });
      cycles += 1;
      logResult(result);
      if (!result.ok && options.failFast) return 1;
      if (controller.signal.aborted) break;
      await sleep(
        Math.max(0, options.intervalMs - (Date.now() - startedAt)),
        controller.signal,
      );
    }
    log("info", "ingest.loop_stopped", { cycles });
    return 0;
  } catch (err) {
    log("error", "ingest.unexpected_error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    deps.signal?.removeEventListener("abort", onSignal);
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  installEpipeGuard();
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // Last-resort guard: a scheduler must see a non-zero exit, never a crash.
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          event: "ingest.fatal",
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
      process.exitCode = 1;
    });
}
