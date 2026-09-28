/**
 * Test-only external repository module.
 *
 * Plain `.mjs` (not TypeScript) on purpose: `loadExternalRepository` imports it
 * by runtime specifier, exactly as the orchestrator will import `lib/db`, and
 * Node can load it without any extra loader.
 */
export function createExternalRepository() {
  const rows = [];
  return {
    rows,
    async insertMany(batch) {
      rows.push(...batch);
      return { inserted: batch.length, skipped: 0 };
    },
  };
}

/** Also exercise the "module exports a ready-made object" branch. */
export const readyMadeRepository = {
  inserted: [],
  async insertMany(batch) {
    this.inserted.push(...batch);
    return { inserted: batch.length, skipped: 0 };
  },
};
