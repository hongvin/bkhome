/**
 * Shared shape for the agents' custom tools.
 *
 * A tool here is a named, testable, domain-specific function with a written
 * statement of why it could not have come from a template. Both agents expose
 * theirs through a registry so they can be inspected and unit-tested by name.
 */

export interface AgentTool<Input, Output> {
  /** Stable, snake_case tool id. */
  name: string;
  description: string;
  /**
   * Why this tool is genuinely domain-specific: what it knows that a generic
   * helper (a search box, a string utility) cannot know.
   */
  provenance: string;
  run(input: Input): Output;
}

export function defineTool<Input, Output>(tool: AgentTool<Input, Output>): AgentTool<Input, Output> {
  return tool;
}
