/**
 * Shared query-parameter parsing for the API routes.
 *
 * `mode=cache` is the default on purpose: the demo must always exercise the
 * staleness disclosure path, and the UI must never silently present cached data
 * as live. `mode=live` exists so the freshness path can be exercised too.
 */
import type { DataMode } from "@/lib/mock";

export function parseMode(url: URL): DataMode {
  return url.searchParams.get("mode") === "live" ? "live" : "cache";
}

export function parseString(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null || value === "" ? undefined : value;
}

export function parseInteger(
  url: URL,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
