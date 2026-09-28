/**
 * Deterministic, documented, seeded PRNG.
 *
 * The eval must produce identical numbers on every run and on every machine.
 * `Math.random()` is therefore banned; every stochastic choice is drawn from a
 * generator seeded by the sha256 of a stable id.
 */

import { createHash } from "node:crypto";

/** First 4 bytes of sha256(seed) as a uint32. */
export function seedFrom(seed: string): number {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return digest.readUInt32BE(0);
}

/**
 * mulberry32 — small, fast, well-distributed, and fully specified here so the
 * sequence can be reproduced by any reader without this file.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

export function rng(seed: string): Rng {
  const next = mulberry32(seedFrom(seed));
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(items) {
      if (items.length === 0) throw new Error("rng.pick on an empty array");
      return items[Math.floor(next() * items.length)]!;
    },
  };
}
