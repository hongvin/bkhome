/**
 * The ingest agent's custom tool registry.
 *
 * Both tools are domain-specific in a way a template cannot be: one knows
 * RapidKL's operational vocabulary, the other knows how Malaysian commuters
 * actually joke about it. See each module's `provenance` field.
 */

import type { AgentTool } from "@/lib/signals/tool";

import {
  type PhraseParserInput,
  malayDisruptionPhraseParser,
} from "./malay-phrases";
import {
  type AuthenticityInput,
  socialAuthenticityDetector,
} from "./social-authenticity";

import type { AuthenticityAssessment, PhraseParse } from "@/lib/signals/types";

export const INGEST_TOOLS: ReadonlyArray<
  AgentTool<PhraseParserInput, PhraseParse> | AgentTool<AuthenticityInput, AuthenticityAssessment>
> = [malayDisruptionPhraseParser, socialAuthenticityDetector];

export function ingestToolNames(): string[] {
  return INGEST_TOOLS.map((t) => t.name);
}
