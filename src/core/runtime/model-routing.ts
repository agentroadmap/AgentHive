/**
 * P228: Cubic Runtime Abstraction — Model Routing
 *
 * Phase-to-model mapping and cost-based model selection.
 * The orchestrator (not individual agents) decides which model to use.
 *
 * This module provides the phase routing table and cost-based picker
 * for when a model_override is not explicitly set.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProposalPhase =
  | "DRAFT"
  | "REVIEW"
  | "DEVELOP"
  | "MERGE"
  | "COMPLETE"
  | "TRIAGE"
  | "FIX"
  | "DEPLOYED";

export interface PhaseModelMapping {
  phase: ProposalPhase;
  /** Preferred model for this phase */
  model: string;
  /** CLI to use (defaults to claude) */
  agentCli?: string;
  /** Rationale for the model choice */
  rationale: string;
}

export interface ModelCostEntry {
  modelName: string;
  agentCli: string;
  /** Cost per million input tokens (USD) */
  costPerMillionInput: number;
  /** Cost per million output tokens (USD) */
  costPerMillionOutput: number;
}

// ─── Phase-to-model table ─────────────────────────────────────────────────────

/**
 * Default phase-to-model routing table.
 *
 * Override individual phases via DB model_routes (preferred) or
 * cubic.metadata.model_override (per-dispatch override).
 */
export const PHASE_MODEL_TABLE: PhaseModelMapping[] = [
  {
    phase: "DRAFT",
    model: "claude-opus-4-7",
    agentCli: "claude",
    rationale: "Architecture/design work needs maximum reasoning depth",
  },
  {
    phase: "REVIEW",
    model: "claude-sonnet-4-6",
    agentCli: "claude",
    rationale: "Gate review is cost-sensitive; sonnet is sufficient",
  },
  {
    phase: "DEVELOP",
    model: "claude-sonnet-4-6",
    agentCli: "claude",
    rationale: "Coding tasks: sonnet trades off cost vs. capability well",
  },
  {
    phase: "MERGE",
    model: "claude-haiku-4-5",
    agentCli: "claude",
    rationale: "Integration validation: simple checks, lowest cost",
  },
  {
    phase: "COMPLETE",
    model: "claude-haiku-4-5",
    agentCli: "claude",
    rationale: "Terminal state: minimal work needed",
  },
  {
    phase: "TRIAGE",
    model: "claude-sonnet-4-6",
    agentCli: "claude",
    rationale: "Hotfix triage needs reliable but fast response",
  },
  {
    phase: "FIX",
    model: "claude-sonnet-4-6",
    agentCli: "claude",
    rationale: "Hotfix implementation: sonnet for coding tasks",
  },
  {
    phase: "DEPLOYED",
    model: "claude-haiku-4-5",
    agentCli: "claude",
    rationale: "Post-deploy: lightweight verification only",
  },
];

// ─── Phase routing ────────────────────────────────────────────────────────────

/**
 * Resolve the preferred model for a given proposal phase.
 *
 * Order of precedence:
 * 1. model_override (from cubic metadata or caller)
 * 2. PHASE_MODEL_TABLE lookup for the current phase
 * 3. Fallback: claude-sonnet-4-6
 */
export function resolvePhaseModel(
  phase: string,
  modelOverride?: string | null,
): { model: string; agentCli: string } {
  if (modelOverride) {
    return { model: modelOverride, agentCli: "claude" };
  }

  const entry = PHASE_MODEL_TABLE.find(
    (m) => m.phase === (phase as ProposalPhase),
  );

  return {
    model: entry?.model ?? "claude-sonnet-4-6",
    agentCli: entry?.agentCli ?? "claude",
  };
}

/**
 * Select the cheapest model from a set of candidates that satisfies
 * the minimum AC count threshold.
 *
 * Heuristic: if the proposal has ≥ 20 ACs, use opus; otherwise sonnet.
 * Always constrained by the phase default.
 */
export function selectCostOptimizedModel(opts: {
  phase: string;
  acCount: number;
  modelOverride?: string | null;
  costEntries?: ModelCostEntry[];
}): { model: string; agentCli: string } {
  if (opts.modelOverride) {
    return { model: opts.modelOverride, agentCli: "claude" };
  }

  // Heuristic: complex proposals (many ACs) use stronger model
  if (opts.acCount >= 20) {
    return { model: "claude-opus-4-7", agentCli: "claude" };
  }

  return resolvePhaseModel(opts.phase, null);
}

// ─── Model override flow ──────────────────────────────────────────────────────

/**
 * Parse model_override from cubic metadata into CLI argv.
 *
 * Returns the --model flag fragment for the CLI, or empty array if
 * model_override is not set (CLI will use its own default).
 */
export function buildModelFlag(
  agentCli: string,
  modelOverride?: string | null,
): string[] {
  if (!modelOverride) return [];

  switch (agentCli) {
    case "claude":
      return ["--model", modelOverride];
    case "codex":
      return ["--model", modelOverride];
    case "hermes":
      return ["-m", modelOverride];
    case "gemini":
      return ["--model", modelOverride];
    case "copilot":
      return ["--model", modelOverride];
    default:
      return ["--model", modelOverride];
  }
}
