/**
 * Text normalisation helpers shared by the Malay parser and the labeller.
 * Pure functions only — no I/O — so they are trivially testable.
 */

import { createHash } from "node:crypto";

/** Fold to a comparison form: uppercase, no accents, single-spaced. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fold + uppercase. The corpus mixes sentence case and ALL CAPS freely. */
export function upper(s: string): string {
  return fold(s).toUpperCase();
}

/**
 * Aggressive form for keyword matching: uppercase, punctuation removed, runs of
 * whitespace collapsed. "GANGGUAN PERKHIDMATAN!" and "gangguan  perkhidmatan"
 * both become "GANGGUAN PERKHIDMATAN".
 */
export function slug(s: string): string {
  return upper(s)
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split into sentences, keeping the terminator. Used for context windows. */
export function sentences(text: string): string[] {
  return fold(text)
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The first `n` characters of a string, ellipsised. For audit trails. */
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** sha256 hex, used for stable content-addressed ids. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** First 12 hex chars of the sha256 — short, stable ids. */
export function shortHash(input: string): string {
  return sha256Hex(input).slice(0, 12);
}
