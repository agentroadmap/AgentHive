/**
 * V3-C8 (P1440): Capability Matching Minimum Taxonomy
 *
 * This module defines the shared vocabulary of capabilities used by both:
 *   1. Agency registration (roadmap_workforce.provider_registry.capabilities JSONB)
 *   2. Work offer requirements (roadmap_proposal.proposal.required_capabilities JSONB)
 *
 * The taxonomy is pragmatically minimal: enough structure to enable capability-based
 * matching without over-engineering a full hierarchical system. Both agency-side and
 * offer-side import from here to ensure consistency.
 *
 * Current real-world capability keys observed in live registrations:
 *   - jobs: string[] — job types (develop, review, design, research, test, etc.)
 *   - tier: number — cost/capability tier (1-3)
 *   - liaison: boolean — can act as a liaison agent
 *   - provider: string — preferred provider (claude, codex, gemini, etc.)
 *
 * AC-1 Satisfaction:
 *   - Shared vocabulary defined here (CAPABILITY_TAXONOMY)
 *   - Used by agency-resolver for subset matching
 *   - Used by offer path to validate required_capabilities
 */

/**
 * Canonical capability taxonomy.
 * Extend this object when new capabilities become part of the shared vocabulary.
 */
export const CAPABILITY_TAXONOMY = {
  // Job types — work activity domains
  jobs: {
    develop: "Code implementation and generation",
    review: "Code review and quality assessment",
    design: "Architectural and design decisions",
    research: "Information research and analysis",
    test: "Test writing and validation",
    enhance: "Enhancement and improvement",
    security: "Security analysis and hardening",
    documentation: "Documentation writing",
    integration: "Integration and deployment",
  },
  // Tier ratings — cost and capability bands
  tier: {
    1: "Budget tier — fast, cost-effective",
    2: "Standard tier — balanced quality and cost",
    3: "Premium tier — advanced reasoning and quality",
  },
  // Role support — can act in specific roles
  liaison: "Can serve as agency liaison/dispatcher",
  provider: "Preferred LLM provider (claude, codex, gemini, etc.)",
} as const;

function normalizeCapabilities(
  value: unknown,
): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return { jobs: value };
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Validate that required_capabilities conform to the taxonomy.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 *
 * A capability is "valid" if its key exists in the taxonomy.
 * For objects with structure (jobs, tier), validate the object shape.
 */
export function validateCapabilitiesAgainstTaxonomy(
  requiredCapabilities: unknown,
): { valid: boolean; errors: string[] } {
  const obj = normalizeCapabilities(requiredCapabilities);
  if (!obj) {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];

  // Check top-level keys
  for (const key of Object.keys(obj)) {
    if (!(key in CAPABILITY_TAXONOMY)) {
      errors.push(
        `Unknown capability key "${key}"; not in CAPABILITY_TAXONOMY`,
      );
    }
  }

  // Validate jobs array if present
  if ("jobs" in obj) {
    if (!Array.isArray(obj.jobs)) {
      errors.push("jobs must be an array of strings");
    } else {
      for (const jobKey of obj.jobs) {
        if (
          typeof jobKey !== "string" ||
          !(jobKey in CAPABILITY_TAXONOMY.jobs)
        ) {
          errors.push(
            `Unknown job type "${jobKey}"; not in CAPABILITY_TAXONOMY.jobs`,
          );
        }
      }
    }
  }

  // Validate tier if present
  if ("tier" in obj) {
    const tierVal = obj.tier;
    if (typeof tierVal !== "number" || !(tierVal in CAPABILITY_TAXONOMY.tier)) {
      errors.push(`Invalid tier ${tierVal}; must be one of 1, 2, 3`);
    }
  }

  // Validate provider string if present
  if ("provider" in obj && typeof obj.provider !== "string") {
    errors.push("provider must be a string");
  }

  // Validate liaison boolean if present
  if ("liaison" in obj && typeof obj.liaison !== "boolean") {
    errors.push("liaison must be a boolean");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if agency capabilities are a SUPERSET of required capabilities.
 * Returns true if the agency can satisfy all required capabilities.
 *
 * Subset semantics:
 *   - agency.jobs must include all of required.jobs
 *   - agency.tier must be >= required.tier
 *   - if required.liaison=true, agency.liaison must be true
 *   - provider is informational; no hard requirement
 *
 * @param agencyCapabilities The agency's declared capabilities (from provider_registry)
 * @param requiredCapabilities The work offer's requirements (from proposal.required_capabilities)
 * @returns true if agency can handle the offer
 */
export function isCapabilitySubsetMatch(
  agencyCapabilities: unknown,
  requiredCapabilities: unknown,
): boolean {
  const agency = normalizeCapabilities(agencyCapabilities);
  const required = normalizeCapabilities(requiredCapabilities);

  // Treat missing capabilities as "no constraints"
  if (!agency || !required) {
    return true;
  }

  // Check jobs: agency must have all required jobs
  if (Array.isArray(required.jobs)) {
    const agencyJobs = Array.isArray(agency.jobs) ? agency.jobs : [];
    for (const requiredJob of required.jobs) {
      if (!agencyJobs.includes(requiredJob)) {
        return false; // agency missing this job
      }
    }
  }

  // Check tier: agency tier must be >= required tier
  const agencyTier = typeof agency.tier === "number" ? agency.tier : 0;
  const requiredTier = typeof required.tier === "number" ? required.tier : 0;
  if (requiredTier > agencyTier) {
    return false; // agency tier too low
  }

  // Check liaison: if required, agency must have it
  if (required.liaison === true && agency.liaison !== true) {
    return false; // agency is not a liaison
  }

  return true; // all constraints satisfied
}

/**
 * Build a human-readable string describing what capabilities are missing.
 * Used for escalation_log.obstacle_type = "CAPABILITY_MISMATCH" entries.
 */
export function describeMissingCapabilities(
  agencyCapabilities: unknown,
  requiredCapabilities: unknown,
): string {
  const agency = normalizeCapabilities(agencyCapabilities);
  const required = normalizeCapabilities(requiredCapabilities);

  if (!agency || !required) {
    return "no capability constraints";
  }
  const missing: string[] = [];

  // Missing jobs
  if (Array.isArray(required.jobs)) {
    const agencyJobs = Array.isArray(agency.jobs) ? agency.jobs : [];
    const missingJobs = (required.jobs as unknown[]).filter(
      (j) => !agencyJobs.includes(j),
    );
    if (missingJobs.length > 0) {
      missing.push(`missing jobs: ${missingJobs.join(", ")}`);
    }
  }

  // Insufficient tier
  const agencyTier = typeof agency.tier === "number" ? agency.tier : 0;
  const requiredTier = typeof required.tier === "number" ? required.tier : 0;
  if (requiredTier > agencyTier) {
    missing.push(`insufficient tier (have ${agencyTier}, need ${requiredTier})`);
  }

  // Missing liaison
  if (required.liaison === true && agency.liaison !== true) {
    missing.push("not a liaison");
  }

  if (missing.length === 0) {
    return "no capability mismatch (should not reach here)";
  }

  return missing.join("; ");
}
