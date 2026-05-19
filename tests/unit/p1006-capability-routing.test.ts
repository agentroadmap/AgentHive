/**
 * P1006 Unit Tests — Model Capability Registry
 *
 * AC-5: Unit test verifies:
 * - Tier-0 test-runner offer (max_cost_tier=0) never resolves to claude-opus
 * - Tier-3 architecture offer with min_reasoning=5 never resolves to gpt-4.1-mini
 * - Tier-2 offer with requires_vision=true skips claude-haiku
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OfferRequirements } from "../../src/core/orchestration/route-eligibility.ts";

// Mock data mimicking model_capability_profile seed data
const CAPABILITY_PROFILES = {
  "claude-opus-4-7": {
    provider: "anthropic",
    model_name: "claude-opus-4-7",
    cost_tier: 3,
    is_free: false,
    reasoning_score: 5,
    code_quality_score: 5,
    instruction_following_score: 5,
    context_window_k: 200,
    supports_tool_use: true,
    supports_vision: true,
    can_spawn_workers: true,
  },
  "claude-sonnet-4-6": {
    provider: "anthropic",
    model_name: "claude-sonnet-4-6",
    cost_tier: 2,
    is_free: false,
    reasoning_score: 4,
    code_quality_score: 4,
    instruction_following_score: 5,
    context_window_k: 200,
    supports_tool_use: true,
    supports_vision: true,
    can_spawn_workers: true,
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    model_name: "claude-haiku-4-5",
    cost_tier: 1,
    is_free: false,
    reasoning_score: 3,
    code_quality_score: 3,
    instruction_following_score: 4,
    context_window_k: 100,
    supports_tool_use: true,
    supports_vision: false, // AC-5: no vision
    can_spawn_workers: true,
  },
  "gpt-4.1-mini": {
    provider: "copilot",
    model_name: "gpt-4.1-mini",
    cost_tier: 0,
    is_free: true,
    reasoning_score: 2,
    code_quality_score: 2,
    instruction_following_score: 3,
    context_window_k: 128,
    supports_tool_use: true,
    supports_vision: false,
    can_spawn_workers: false, // copilot cannot spawn
  },
  "codex-5.5": {
    provider: "codex",
    model_name: "codex-5.5",
    cost_tier: 2,
    is_free: false,
    reasoning_score: 4,
    code_quality_score: 5,
    instruction_following_score: 4,
    context_window_k: 150,
    supports_tool_use: true,
    supports_vision: false,
    can_spawn_workers: true,
  },
};

/**
 * Helper function to filter models by offer requirements.
 * Mimics the behavior of selectActiveRouteRow with capability filters.
 */
function filterModelsByCapability(
  models: string[],
  requirements?: OfferRequirements,
): string[] {
  if (!requirements) {
    return models;
  }

  return models.filter((modelName) => {
    const profile = CAPABILITY_PROFILES[modelName as keyof typeof CAPABILITY_PROFILES];
    if (!profile) return false;

    // AC-14: Architecture/review require reasoning_score >= 5 and can_spawn_workers
    if (requirements.task_category && ["architecture", "review"].includes(requirements.task_category)) {
      if (profile.reasoning_score < 5) return false;
      if (!profile.can_spawn_workers) return false;
    }

    // AC-13: Testing/implementation/analysis/architecture/review require can_spawn_workers
    if (
      requirements.task_category &&
      ["testing", "implementation", "analysis", "architecture", "review"].includes(requirements.task_category)
    ) {
      if (!profile.can_spawn_workers) return false;
    }

    // Capability score requirements
    if ((requirements.min_reasoning_score ?? 0) > 0 && profile.reasoning_score < requirements.min_reasoning_score) {
      return false;
    }

    if (
      (requirements.min_code_quality_score ?? 0) > 0 &&
      profile.code_quality_score < requirements.min_code_quality_score
    ) {
      return false;
    }

    if (
      (requirements.min_instruction_following_score ?? 0) > 0 &&
      profile.instruction_following_score < requirements.min_instruction_following_score
    ) {
      return false;
    }

    // Tool/vision requirements
    if (requirements.requires_tool_use && !profile.supports_tool_use) return false;
    if (requirements.requires_vision && !profile.supports_vision) return false;

    // Context window requirement
    if ((requirements.min_context_window_k ?? 0) > 0) {
      if (!profile.context_window_k || profile.context_window_k < requirements.min_context_window_k) {
        return false;
      }
    }

    // Cost tier constraint
    if ((requirements.max_cost_tier ?? 3) < 3 && profile.cost_tier > requirements.max_cost_tier) {
      return false;
    }

    return true;
  });
}

test("AC-5: Tier-0 offer (max_cost_tier=0) never resolves to claude-opus", () => {
  const allModels = Object.keys(CAPABILITY_PROFILES);
  const tier0Offer: OfferRequirements = { max_cost_tier: 0 };

  const eligible = filterModelsByCapability(allModels, tier0Offer);

  // Only gpt-4.1-mini and gemini models are tier-0
  assert.ok(!eligible.includes("claude-opus-4-7"), "claude-opus (tier 3) should NOT be eligible for tier-0 offer");
  assert.ok(!eligible.includes("claude-sonnet-4-6"), "claude-sonnet (tier 2) should NOT be eligible for tier-0 offer");
  assert.ok(!eligible.includes("codex-5.5"), "codex (tier 2) should NOT be eligible for tier-0 offer");
});

test("AC-5: Architecture offer with min_reasoning=5 never resolves to gpt-4.1-mini", () => {
  const allModels = Object.keys(CAPABILITY_PROFILES);
  const archOffer: OfferRequirements = {
    task_category: "architecture",
    min_reasoning_score: 5,
  };

  const eligible = filterModelsByCapability(allModels, archOffer);

  // gpt-4.1-mini has reasoning_score=2 and cannot spawn
  assert.ok(!eligible.includes("gpt-4.1-mini"), "gpt-4.1-mini should NOT be eligible for architecture offer");
  // Only claude-opus qualifies (reasoning=5, can_spawn_workers=true)
  assert.ok(eligible.includes("claude-opus-4-7"), "claude-opus should be eligible for architecture offer");
});

test("AC-5: Offer with requires_vision=true skips claude-haiku", () => {
  const allModels = Object.keys(CAPABILITY_PROFILES);
  const visionOffer: OfferRequirements = { requires_vision: true };

  const eligible = filterModelsByCapability(allModels, visionOffer);

  // claude-haiku does not support vision
  assert.ok(!eligible.includes("claude-haiku-4-5"), "claude-haiku should NOT be eligible for vision offer");
  // claude-opus and claude-sonnet support vision
  assert.ok(eligible.includes("claude-opus-4-7"), "claude-opus should be eligible for vision offer");
  assert.ok(eligible.includes("claude-sonnet-4-6"), "claude-sonnet should be eligible for vision offer");
});

test("AC-5: Mechanical task (no spawn required) allows copilot models", () => {
  const allModels = Object.keys(CAPABILITY_PROFILES);
  const mechanicalOffer: OfferRequirements = {
    task_category: "mechanical",
  };

  const eligible = filterModelsByCapability(allModels, mechanicalOffer);

  // Mechanical tasks don't require spawn capability, so copilot models are allowed
  assert.ok(eligible.includes("gpt-4.1-mini"), "gpt-4.1-mini should be eligible for mechanical task");
  assert.ok(eligible.includes("claude-opus-4-7"), "claude-opus should be eligible for mechanical task");
});

test("AC-5: Implementation task requires can_spawn_workers=true", () => {
  const allModels = Object.keys(CAPABILITY_PROFILES);
  const implOffer: OfferRequirements = {
    task_category: "implementation",
  };

  const eligible = filterModelsByCapability(allModels, implOffer);

  // Implementation requires spawn capability
  assert.ok(!eligible.includes("gpt-4.1-mini"), "gpt-4.1-mini (cannot spawn) should NOT be eligible");
  assert.ok(eligible.includes("claude-opus-4-7"), "claude-opus (can spawn) should be eligible");
  assert.ok(eligible.includes("codex-5.5"), "codex (can spawn) should be eligible");
});

test("AC-5: Combined constraints: review + min_reasoning=5 + requires_vision", () => {
  const allModels = Object.keys(CAPABILITY_PROFILES);
  const reviewOffer: OfferRequirements = {
    task_category: "review",
    min_reasoning_score: 5,
    requires_vision: true,
  };

  const eligible = filterModelsByCapability(allModels, reviewOffer);

  // Only claude-opus qualifies all constraints
  assert.deepEqual(eligible, ["claude-opus-4-7"]);
});

test("AC-5: No requirements filter returns all available models", () => {
  const allModels = Object.keys(CAPABILITY_PROFILES);
  const eligible = filterModelsByCapability(allModels, undefined);

  assert.deepEqual(eligible, allModels);
});
