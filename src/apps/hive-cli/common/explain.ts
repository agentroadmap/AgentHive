/**
 * Explain: AI-ergonomics surface for walking agents through context and decisions.
 *
 * Per cli-hive-ai-ergonomics.md §3: formatExplain formats human-readable explanations
 * of why a command was executed, what data was gathered, and what decisions were made.
 *
 * Designed for log aggregation and multi-turn agent reasoning.
 *
 * @module common/explain
 */

/**
 * Formats a human-readable explanation for an AI agent.
 *
 * @param command - The CLI command that was executed (e.g., "hive proposal get P123")
 * @param intent - Why the agent ran this command (e.g., "Check if proposal is stuck in ACTIVE maturity")
 * @param decisions - Array of decision statements made based on the output
 *   Example: ["Found proposal P123 in ACTIVE state for 8 days", "Maturity exceeds 7-day threshold"]
 * @param data - Optional: structured data to include in the explanation (context for reasoning)
 * @returns Formatted explanation string suitable for agent logs or multi-turn reasoning
 *
 * Example output:
 *   Command: hive proposal get P123
 *   Intent: Check if proposal is stuck in ACTIVE maturity
 *   Data gathered:
 *     - proposal_id: P123
 *     - state: ACTIVE
 *     - maturity_days: 8
 *   Decisions made:
 *     1. Found proposal P123 in ACTIVE state for 8 days
 *     2. Maturity exceeds 7-day threshold
 *     3. Suggested next: run `hive doctor` to find remediation steps
 */
export function formatExplain(
  command: string,
  intent: string,
  decisions: string[],
  data?: unknown
): string {
  const lines: string[] = [];

  lines.push(`Command: ${command}`);
  lines.push(`Intent: ${intent}`);

  if (data) {
    lines.push("Data gathered:");
    if (typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (value !== null && value !== undefined) {
          const valueStr =
            typeof value === "string" ? value : JSON.stringify(value);
          lines.push(`  - ${key}: ${valueStr}`);
        }
      }
    } else if (Array.isArray(data)) {
      data.forEach((item, idx) => {
        lines.push(`  - [${idx}]: ${JSON.stringify(item)}`);
      });
    } else {
      lines.push(`  - ${JSON.stringify(data)}`);
    }
  }

  if (decisions && decisions.length > 0) {
    lines.push("Decisions made:");
    decisions.forEach((decision, idx) => {
      lines.push(`  ${idx + 1}. ${decision}`);
    });
  }

  return lines.join("\n");
}

/**
 * Explains a proposed remediation step (for doctor output).
 *
 * @param checkName - Name of the health check that triggered this remediation
 * @param status - Current status (e.g., "failing", "warning")
 * @param suggestedCommand - The exact CLI command to run
 * @param rationale - Why this command is suggested
 * @returns Formatted explanation for the operator
 */
export function formatRemediation(
  checkName: string,
  status: string,
  suggestedCommand: string,
  rationale: string
): string {
  const lines: string[] = [];

  lines.push(`Health Check: ${checkName}`);
  lines.push(`Status: ${status}`);
  lines.push(`Rationale: ${rationale}`);
  lines.push("");
  lines.push(`Suggested remediation:`);
  lines.push(`  ${suggestedCommand}`);
  lines.push("");
  lines.push(
    "Review this command carefully before executing. Some remediations are destructive."
  );

  return lines.join("\n");
}

/**
 * Explains a recipe step execution (for recipe logs).
 *
 * @param recipeId - ID of the recipe being executed
 * @param stepIndex - Zero-based step number
 * @param stepCommand - The command that will be/was executed
 * @param stepDescription - Human description of the step
 * @param output - Optional: output from the step execution
 * @param error - Optional: error message if the step failed
 * @returns Formatted explanation for recipe logs
 */
export function formatRecipeStep(
  recipeId: string,
  stepIndex: number,
  stepCommand: string,
  stepDescription: string,
  output?: string,
  error?: string
): string {
  const lines: string[] = [];

  lines.push(`Recipe: ${recipeId}`);
  lines.push(`Step ${stepIndex + 1}: ${stepDescription}`);
  lines.push(`Command: ${stepCommand}`);

  if (output) {
    lines.push("Output:");
    output.split("\n").forEach((line) => {
      lines.push(`  ${line}`);
    });
  }

  if (error) {
    lines.push("Error:");
    lines.push(`  ${error}`);
  }

  return lines.join("\n");
}
