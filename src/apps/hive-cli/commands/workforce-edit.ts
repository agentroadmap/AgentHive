/**
 * P1352 AC-3: CLI Command to Edit Agent Personality
 *
 * Command: roadmap workforce edit <agent-identity>
 *
 * Workflow:
 *   1. Load agent from agent_registry
 *   2. Extract personality JSONB
 *   3. Convert to YAML
 *   4. Spawn $EDITOR for user edit
 *   5. Parse edited YAML back
 *   6. Validate against schema
 *   7. Update agent_registry.personality
 *   8. Log change to operator_audit_log
 *
 * Operator-only: Rejects if principal_kind != 'operator'.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { query } from "../../../infra/postgres/pool.js";
import {
  personalityToYAML,
  yamlToPersonality,
  validateAgentPersonality,
} from "../../../core/agency/agent-profile-validator.ts";
import type { AgentPersonality } from "../../../core/identity/agent-registry/types.ts";

export interface WorkforceEditOptions {
  agent_identity: string;
  principal_identity?: string; // operator identity for audit logging
  principal_kind?: string; // should be "operator" only
  editor?: string; // override $EDITOR env var for testing
}

/**
 * Main entrypoint: Load agent, edit personality, validate, persist.
 */
export async function workforceEdit(opts: WorkforceEditOptions): Promise<{
  success: boolean;
  message: string;
  previous?: AgentPersonality;
  updated?: AgentPersonality;
}> {
  const { agent_identity, principal_identity, principal_kind, editor } = opts;

  // Check authorization: operator-only
  if (principal_kind !== "operator" && principal_kind !== "authority") {
    return {
      success: false,
      message: `Unauthorized. Only operators can edit agent personality. (principal_kind: ${principal_kind})`,
    };
  }

  // Fetch current agent
  const result = await query(
    `
    SELECT id, agent_identity, personality, display_name
    FROM roadmap_workforce.agent_registry
    WHERE agent_identity = $1
    `,
    [agent_identity]
  );

  if (result.rows.length === 0) {
    return {
      success: false,
      message: `Agent ${agent_identity} not found`,
    };
  }

  const row = result.rows[0];
  const currentPersonality: AgentPersonality | null = row.personality;

  // Convert current personality to YAML for editing
  let yamlContent: string;
  if (currentPersonality) {
    const validation = validateAgentPersonality(currentPersonality);
    if (!validation.valid) {
      // If current personality is invalid, start with a template
      console.warn(
        `⚠ Current personality is invalid: ${validation.errors?.map((e) => `${e.field}: ${e.message}`).join("; ")}`
      );
      yamlContent = createPersonalityTemplate();
    } else {
      yamlContent = personalityToYAML(currentPersonality);
    }
  } else {
    yamlContent = createPersonalityTemplate();
  }

  // Write to temp file and open in editor
  const tmpFile = path.join(os.tmpdir(), `agenthive-personality-${agent_identity}-${Date.now()}.yaml`);
  fs.writeFileSync(tmpFile, yamlContent);

  const editorCmd = editor || process.env.EDITOR || "nano";

  try {
    // Spawn editor
    console.log(`Opening editor: ${editorCmd}`);
    execSync(`${editorCmd} "${tmpFile}"`, { stdio: "inherit" });

    // Read edited content
    const editedYAML = fs.readFileSync(tmpFile, "utf-8");

    // Parse and validate
    let updatedPersonality: AgentPersonality;
    try {
      updatedPersonality = yamlToPersonality(editedYAML);
    } catch (e) {
      return {
        success: false,
        message: `Failed to parse edited personality: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Persist to database
    await query(
      `
      UPDATE roadmap_workforce.agent_registry
      SET personality = $2, updated_at = now()
      WHERE agent_identity = $1
      `,
      [agent_identity, JSON.stringify(updatedPersonality)]
    );

    // Log to operator_audit_log
    if (principal_identity) {
      try {
        await query(
          `
          INSERT INTO roadmap.operator_audit_log (operator_identity, action, target_identity, changes_summary)
          VALUES ($1, 'update_agent_personality', $2, $3)
          `,
          [
            principal_identity,
            agent_identity,
            JSON.stringify({
              previous: currentPersonality,
              updated: updatedPersonality,
            }),
          ]
        );
      } catch {
        // Audit log write failure should not block the update
        console.warn("Failed to log to operator_audit_log");
      }
    }

    return {
      success: true,
      message: `Successfully updated personality for ${agent_identity}`,
      previous: currentPersonality || undefined,
      updated: updatedPersonality,
    };
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Create a template personality for new agents or invalid ones.
 */
function createPersonalityTemplate(): string {
  return `# Agent Personality Configuration
# All fields are required. Edit carefully.

vibe: |
  Add a punchy one-liner (≤160 chars) describing this agent's essence.

core_truths:
  - Add core principles this agent follows
  - One principle per line
  - At least one is required

boundaries:
  - Add hard limits and ethical guardrails
  - One boundary per line
  - At least one is required

communication_style: |
  Describe how this agent communicates (tone, format, directness).

expertise:
  - architect
  - reviewer
  # Valid roles: architect, reviewer, coder, debugger, writer, researcher, tester, devops, designer
  # Select one or more appropriate for this agent
`;
}
