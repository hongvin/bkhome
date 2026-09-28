/**
 * Writes PROMPT.md from the canonical prompt string.
 *
 *   ./node_modules/.bin/tsx lib/agents/verify/emit-prompt.ts
 *
 * PROMPT.md is a deliverable judges read. It is generated rather than
 * hand-maintained so it can never drift from the rules the code implements;
 * `tests/signals/prompt.test.ts` asserts the two are identical.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { VERIFY_AGENT_PROMPT } from "./prompt";

const OUT = path.join(process.cwd(), "lib/agents/verify/PROMPT.md");

async function main(): Promise<void> {
  const body = [
    "<!-- GENERATED FILE — do not edit by hand. -->",
    "<!-- Source of truth: lib/agents/verify/prompt.ts. Regenerate with: -->",
    "<!--   ./node_modules/.bin/tsx lib/agents/verify/emit-prompt.ts -->",
    "",
    "# Verifier agent — system prompt",
    "",
    "The Verifier is a deterministic rule engine. This is its complete written",
    "specification; `agent.ts` and `rules.ts` implement it, and",
    "`tests/signals/prompt.test.ts` fails if this file and the code's prompt drift",
    "apart.",
    "",
    "```text",
    VERIFY_AGENT_PROMPT.trimEnd(),
    "```",
    "",
  ].join("\n");
  await writeFile(OUT, body, "utf8");
  process.stdout.write(`wrote ${path.relative(process.cwd(), OUT)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`emit-prompt failed: ${String(err)}\n`);
  process.exitCode = 1;
});
