/**
 * Vendored GTFS-Realtime protobuf loader.
 *
 * The official `gtfs-realtime.proto` (proto2, from google/transit) is committed
 * at `worker/proto/gtfs-realtime.proto` and parsed from local disk. Nothing in
 * this module (or anything that imports it) touches the network.
 */
import { readFileSync } from "node:fs";
import protobuf from "protobufjs";
import type { Type } from "protobufjs";

/** Absolute location of the vendored definition, resolved from this file. */
export const PROTO_PATH = new URL("./proto/gtfs-realtime.proto", import.meta.url);

/** Fully-qualified message name decoded by the vehicle-position worker. */
export const FEED_MESSAGE_TYPE = "transit_realtime.FeedMessage";

let cachedType: Type | null = null;

/**
 * Parse and return `transit_realtime.FeedMessage`.
 *
 * Parsing happens once per process and is cached. The definition has no
 * `import` statements, so no `resolvePath` / network lookup can occur.
 */
export function getFeedMessageType(): Type {
  if (cachedType) return cachedType;
  const source = readFileSync(PROTO_PATH, "utf8");
  const parsed = protobuf.parse(source, { keepCase: false });
  const type = parsed.root.lookupType(FEED_MESSAGE_TYPE);
  cachedType = type;
  return type;
}

/** Options that make decoded output JSON-friendly and numerically plain. */
const TO_OBJECT_OPTIONS = {
  longs: Number,
  enums: String,
  defaults: true,
  arrays: true,
  objects: true,
} as const;

/**
 * Decode a GTFS-R payload into a plain object.
 *
 * Throws on malformed/truncated input — callers wrap this into a typed error.
 */
export function decodeFeedMessage(bytes: Uint8Array): Record<string, unknown> {
  const type = getFeedMessageType();
  const message = type.decode(bytes);
  return type.toObject(message, TO_OBJECT_OPTIONS) as Record<string, unknown>;
}

/**
 * Encode a `FeedMessage`-shaped object. Used by the capture script's round-trip
 * check and by tests that need synthetic feeds (empty / partial).
 */
export function encodeFeedMessage(message: Record<string, unknown>): Uint8Array {
  const type = getFeedMessageType();
  const problem = type.verify(message);
  if (problem) throw new Error(`invalid FeedMessage: ${problem}`);
  return type.encode(type.create(message)).finish();
}
