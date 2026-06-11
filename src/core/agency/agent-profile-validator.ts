/**
 * P1352 AC-2: Agent Personality Validator
 *
 * Validates personality JSONB objects conform to schema:
 *   - vibe: string, max 160 chars
 *   - core_truths: string[], non-empty
 *   - boundaries: string[], non-empty
 *   - communication_style: string, max 500 chars
 *   - expertise: ExpertiseRole[], non-empty, valid roles only
 *
 * Used by:
 *   - CLI workforce edit command (AC-3) before persist
 *   - Agent spawn briefing assembly (AC-4) to select personality
 */

import type { AgentPersonality, ExpertiseRole } from "../identity/agent-registry/types.ts";

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate that an object conforms to AgentPersonality schema.
 * Returns { valid: true } on success, or { valid: false, errors: [...] } on failure.
 */
export function validateAgentPersonality(obj: unknown): {
  valid: boolean;
  errors?: ValidationError[];
} {
  const errors: ValidationError[] = [];

  if (!obj || typeof obj !== "object") {
    return {
      valid: false,
      errors: [{ field: "root", message: "Personality must be a non-null object" }],
    };
  }

  const p = obj as Record<string, unknown>;

  // Validate vibe
  if (typeof p.vibe !== "string") {
    errors.push({ field: "vibe", message: "vibe is required and must be a string" });
  } else if (p.vibe.trim().length === 0) {
    errors.push({ field: "vibe", message: "vibe must not be empty" });
  } else if (p.vibe.length > 160) {
    errors.push({
      field: "vibe",
      message: `vibe must be ≤160 characters (got ${p.vibe.length})`,
    });
  }

  // Validate core_truths
  if (!Array.isArray(p.core_truths)) {
    errors.push({
      field: "core_truths",
      message: "core_truths is required and must be an array of strings",
    });
  } else if (p.core_truths.length === 0) {
    errors.push({ field: "core_truths", message: "core_truths must not be empty" });
  } else if (!p.core_truths.every((t) => typeof t === "string")) {
    errors.push({
      field: "core_truths",
      message: "All core_truths must be strings",
    });
  } else if (!p.core_truths.every((t: string) => t.trim().length > 0)) {
    errors.push({
      field: "core_truths",
      message: "All core_truths must be non-empty",
    });
  }

  // Validate boundaries
  if (!Array.isArray(p.boundaries)) {
    errors.push({
      field: "boundaries",
      message: "boundaries is required and must be an array of strings",
    });
  } else if (p.boundaries.length === 0) {
    errors.push({ field: "boundaries", message: "boundaries must not be empty" });
  } else if (!p.boundaries.every((b) => typeof b === "string")) {
    errors.push({
      field: "boundaries",
      message: "All boundaries must be strings",
    });
  } else if (!p.boundaries.every((b: string) => b.trim().length > 0)) {
    errors.push({
      field: "boundaries",
      message: "All boundaries must be non-empty",
    });
  }

  // Validate communication_style
  if (typeof p.communication_style !== "string") {
    errors.push({
      field: "communication_style",
      message: "communication_style is required and must be a string",
    });
  } else if (p.communication_style.trim().length === 0) {
    errors.push({
      field: "communication_style",
      message: "communication_style must not be empty",
    });
  } else if (p.communication_style.length > 500) {
    errors.push({
      field: "communication_style",
      message: `communication_style must be ≤500 characters (got ${p.communication_style.length})`,
    });
  }

  // Validate expertise
  if (!Array.isArray(p.expertise)) {
    errors.push({
      field: "expertise",
      message: "expertise is required and must be an array of roles",
    });
  } else if (p.expertise.length === 0) {
    errors.push({ field: "expertise", message: "expertise must not be empty" });
  } else if (!p.expertise.every((e) => typeof e === "string")) {
    errors.push({
      field: "expertise",
      message: "All expertise entries must be strings",
    });
  } else {
    const validRoles: ExpertiseRole[] = [
      "architect",
      "reviewer",
      "coder",
      "debugger",
      "writer",
      "researcher",
      "tester",
      "devops",
      "designer",
    ];
    const invalid = (p.expertise as string[]).filter((e) => !validRoles.includes(e as ExpertiseRole));
    if (invalid.length > 0) {
      errors.push({
        field: "expertise",
        message: `Invalid expertise roles: ${invalid.join(", ")}. Valid: ${validRoles.join(", ")}`,
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Assert that an object is a valid AgentPersonality.
 * Throws with descriptive error on failure.
 */
export function assertValidPersonality(obj: unknown): asserts obj is AgentPersonality {
  const result = validateAgentPersonality(obj);
  if (!result.valid) {
    const messages = result.errors!.map((e) => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`Invalid personality: ${messages}`);
  }
}

/**
 * Safely parse and validate a JSON string as AgentPersonality.
 * Returns parsed object on success, throws on parse/validation error.
 */
export function parsePersonalityJSON(jsonStr: string): AgentPersonality {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  assertValidPersonality(obj);
  return obj;
}

/**
 * Convert AgentPersonality to JSON string for CLI editor.
 * Pretty-printed for human readability.
 */
export function personalityToYAML(p: AgentPersonality): string {
  return JSON.stringify(p, null, 2);
}

/**
 * Parse JSON string back to AgentPersonality object.
 * Expects the format produced by personalityToYAML() (which now produces JSON).
 */
export function yamlToPersonality(jsonStr: string): AgentPersonality {
  // Despite the function name (for backwards compat), this now parses JSON
  return parsePersonalityJSON(jsonStr);
}
