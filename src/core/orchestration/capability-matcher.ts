/**
 * P1352 AC-5: Capability Matching via Agent Expertise
 *
 * Matches proposals to agencies based on expertise overlap.
 * Used by orchestrator to rank available agencies for dispatch.
 *
 * Matching algorithm:
 *   - Base score = 50 (all agencies eligible)
 *   - For each overlap between proposal.required_capabilities and agent.personality.expertise[]:
 *     score += 10
 *   - Agencies with matching expertise rank higher for tasks with capability requirements
 *
 * Note: expertise matching is ADVISORY, not blocking.
 * Gate logic remains in the hands of the gating agent.
 */

import type { AgentPersonality, ExpertiseRole } from "../identity/agent-registry/types.ts";
import { query } from "../../infra/postgres/pool.js";

export interface AgencyCandidate {
  agent_identity: string;
  personality?: AgentPersonality | null;
  score: number;
  matchedExpertise: ExpertiseRole[];
}

export interface MatchingContext {
  required_capabilities?: string[];
  preferred_expertise?: ExpertiseRole[];
}

/**
 * Score a single agency based on expertise overlap.
 * Base score 50, +10 per matched expertise role.
 */
export function scoreAgencyByExpertise(
  personality: AgentPersonality | null | undefined,
  requiredCapabilities?: string[]
): { score: number; matchedExpertise: ExpertiseRole[] } {
  let score = 50; // base score: all agencies are eligible
  const matched: ExpertiseRole[] = [];

  if (!personality || !personality.expertise || personality.expertise.length === 0) {
    return { score, matchedExpertise: matched };
  }

  if (!requiredCapabilities || requiredCapabilities.length === 0) {
    return { score, matchedExpertise: matched };
  }

  // Normalize capability names to lowercase for comparison
  const normalizedRequired = requiredCapabilities.map((c) => c.toLowerCase().trim());

  // Find overlap: does personality.expertise contain any of the required capabilities?
  for (const expertise of personality.expertise) {
    const normalizedExpertise = expertise.toLowerCase().trim();
    if (normalizedRequired.includes(normalizedExpertise)) {
      matched.push(expertise);
      score += 10;
    }
  }

  return { score, matchedExpertise: matched };
}

/**
 * Fetch all active agencies and score them by expertise match.
 * Returns candidates sorted by score descending.
 */
export async function matchAgenciesByExpertise(
  context: MatchingContext
): Promise<AgencyCandidate[]> {
  const { required_capabilities = [] } = context;

  const result = await query(
    `
    SELECT
      agent_identity,
      personality,
      display_name
    FROM roadmap_workforce.agent_registry
    WHERE agent_type = 'agency' AND status = 'active'
    ORDER BY agent_identity
    `
  );

  const candidates: AgencyCandidate[] = [];

  for (const row of result.rows) {
    const { score, matchedExpertise } = scoreAgencyByExpertise(
      row.personality,
      required_capabilities
    );

    candidates.push({
      agent_identity: row.agent_identity,
      personality: row.personality,
      score,
      matchedExpertise,
    });
  }

  // Sort by score descending, then by identity for deterministic ordering
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.agent_identity.localeCompare(b.agent_identity);
  });

  return candidates;
}

/**
 * Find the best-matching agency for a task.
 * Returns the top-ranked candidate, or null if no agencies found.
 */
export async function findBestAgency(
  context: MatchingContext
): Promise<AgencyCandidate | null> {
  const candidates = await matchAgenciesByExpertise(context);
  return candidates.length > 0 ? candidates[0] : null;
}
