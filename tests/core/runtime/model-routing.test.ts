/**
 * P228: Cubic Runtime Abstraction — Model Routing Unit Tests
 *
 * Pure unit tests — no DB, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePhaseModel,
  selectCostOptimizedModel,
  buildModelFlag,
  PHASE_MODEL_TABLE,
} from "../../../src/core/runtime/model-routing.ts";

describe("PHASE_MODEL_TABLE", () => {
  it("has an entry for every expected phase", () => {
    const phases = PHASE_MODEL_TABLE.map((e) => e.phase);
    for (const phase of ["DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE", "TRIAGE", "FIX", "DEPLOYED"]) {
      assert.ok(phases.includes(phase as never), `Missing phase: ${phase}`);
    }
  });

  it("all entries have non-empty model", () => {
    for (const entry of PHASE_MODEL_TABLE) {
      assert.ok(entry.model.length > 0, `Entry for ${entry.phase} must have non-empty model`);
    }
  });

  it("all entries have non-empty agentCli", () => {
    for (const entry of PHASE_MODEL_TABLE) {
      assert.ok(
        entry.agentCli !== undefined && entry.agentCli.length > 0,
        `Entry for ${entry.phase} must have non-empty agentCli`,
      );
    }
  });
});

describe("resolvePhaseModel()", () => {
  it("DRAFT → claude-opus-4-7", () => {
    assert.equal(resolvePhaseModel("DRAFT").model, "claude-opus-4-7");
  });

  it("REVIEW → claude-sonnet-4-6", () => {
    assert.equal(resolvePhaseModel("REVIEW").model, "claude-sonnet-4-6");
  });

  it("DEVELOP → claude-sonnet-4-6", () => {
    assert.equal(resolvePhaseModel("DEVELOP").model, "claude-sonnet-4-6");
  });

  it("MERGE → claude-haiku-4-5", () => {
    assert.equal(resolvePhaseModel("MERGE").model, "claude-haiku-4-5");
  });

  it("returns agentCli = 'claude' for all built-in phases", () => {
    for (const phase of ["DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"]) {
      const { agentCli } = resolvePhaseModel(phase);
      assert.equal(agentCli, "claude", `${phase} must resolve to agentCli=claude`);
    }
  });

  it("modelOverride takes precedence over phase table", () => {
    assert.equal(resolvePhaseModel("DRAFT", "claude-haiku-4-5").model, "claude-haiku-4-5");
  });

  it("unknown phase falls back to claude-sonnet-4-6", () => {
    assert.equal(resolvePhaseModel("UNKNOWN_PHASE").model, "claude-sonnet-4-6");
  });

  it("null modelOverride does not override phase routing", () => {
    assert.equal(resolvePhaseModel("DRAFT", null).model, "claude-opus-4-7");
  });
});

describe("selectCostOptimizedModel()", () => {
  it("modelOverride takes priority when provided", () => {
    const result = selectCostOptimizedModel({
      phase: "DRAFT",
      acCount: 5,
      modelOverride: "claude-haiku-4-5",
    });
    assert.equal(result.model, "claude-haiku-4-5");
  });

  it("acCount >= 20 uses opus regardless of phase", () => {
    const result = selectCostOptimizedModel({ phase: "DEVELOP", acCount: 20 });
    assert.equal(result.model, "claude-opus-4-7");
  });

  it("acCount = 19 defers to phase routing (not opus upgrade)", () => {
    const result = selectCostOptimizedModel({ phase: "DEVELOP", acCount: 19 });
    assert.equal(result.model, "claude-sonnet-4-6");
  });

  it("DRAFT phase with acCount < 20 returns opus (DRAFT is opus in table)", () => {
    const result = selectCostOptimizedModel({ phase: "DRAFT", acCount: 5 });
    assert.equal(result.model, "claude-opus-4-7");
  });

  it("MERGE phase with acCount < 20 returns haiku", () => {
    const result = selectCostOptimizedModel({ phase: "MERGE", acCount: 3 });
    assert.equal(result.model, "claude-haiku-4-5");
  });
});

describe("buildModelFlag()", () => {
  it("returns empty array when modelOverride is undefined", () => {
    assert.deepEqual(buildModelFlag("claude"), []);
  });

  it("returns empty array when modelOverride is null", () => {
    assert.deepEqual(buildModelFlag("claude", null), []);
  });

  it("claude CLI: returns ['--model', modelName]", () => {
    assert.deepEqual(buildModelFlag("claude", "claude-opus-4-7"), ["--model", "claude-opus-4-7"]);
  });

  it("codex CLI: returns ['--model', modelName]", () => {
    assert.deepEqual(buildModelFlag("codex", "gpt-4o"), ["--model", "gpt-4o"]);
  });

  it("hermes CLI: returns ['-m', modelName]", () => {
    assert.deepEqual(buildModelFlag("hermes", "mimo-v2"), ["-m", "mimo-v2"]);
  });

  it("gemini CLI: returns ['--model', modelName]", () => {
    assert.deepEqual(buildModelFlag("gemini", "gemini-pro"), ["--model", "gemini-pro"]);
  });

  it("copilot CLI: returns ['--model', modelName]", () => {
    assert.deepEqual(buildModelFlag("copilot", "gpt-4"), ["--model", "gpt-4"]);
  });

  it("agy CLI: returns ['--model', modelName]", () => {
    assert.deepEqual(buildModelFlag("agy", "Gemini 3.5 Flash (Medium)"), ["--model", "Gemini 3.5 Flash (Medium)"]);
  });

  it("unknown CLI falls back to ['--model', modelName]", () => {
    assert.deepEqual(buildModelFlag("unknown-cli", "some-model"), ["--model", "some-model"]);
  });
});
