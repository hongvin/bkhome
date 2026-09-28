/**
 * `lib/gtfs` barrel — browser-safe surface only.
 *
 * `read-feed.ts` is intentionally excluded because it imports `node:fs`. The
 * build script imports it directly.
 */

export * from "./csv";
export * from "./raw";
export * from "./normalize";
export * from "./geo";
export * from "./interchange";
export * from "./build";
export * from "./compact";
export * from "./graph-io";
export * from "./graph-index";
