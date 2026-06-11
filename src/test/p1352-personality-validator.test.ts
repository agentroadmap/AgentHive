/**
 * P1352: Agent Personality Validator Tests
 *
 * Tests for AC-2 (validation function) and AC-3 (YAML parser)
 */

import { describe, it, expect } from "bun:test";
import {
  validateAgentPersonality,
  assertValidPersonality,
  personalityToYAML,
  yamlToPersonality,
  parsePersonalityJSON,
} from "../core/agency/agent-profile-validator.ts";
import type { AgentPersonality } from "../core/identity/agent-registry/types.ts";

const validPersonality: AgentPersonality = {
  vibe: "Strategic architect focused on system design and implementation",
  core_truths: ["measure twice, code once", "simplicity wins", "test everything"],
  boundaries: ["no unsafe assumptions", "always verify before acting", "ask for help when stuck"],
  communication_style:
    "Direct, factual, and thorough. I explain my reasoning and ask clarifying questions.",
  expertise: ["architect", "reviewer", "coder"],
};

describe("Agent Personality Validator", () => {
  describe("validateAgentPersonality", () => {
    it("accepts valid personality", () => {
      const result = validateAgentPersonality(validPersonality);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("rejects null object", () => {
      const result = validateAgentPersonality(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0].field).toBe("root");
    });

    it("rejects missing vibe", () => {
      const bad = { ...validPersonality };
      delete (bad as any).vibe;
      const result = validateAgentPersonality(bad);
      expect(result.valid).toBe(false);
      const vibeError = result.errors?.find((e) => e.field === "vibe");
      expect(vibeError).toBeDefined();
    });

    it("rejects empty vibe", () => {
      const bad = { ...validPersonality, vibe: "" };
      const result = validateAgentPersonality(bad);
      expect(result.valid).toBe(false);
      const vibeError = result.errors?.find((e) => e.field === "vibe");
      expect(vibeError?.message).toContain("must not be empty");
    });

    it("rejects vibe > 160 chars", () => {
      const bad = {
        ...validPersonality,
        vibe: "a".repeat(161),
      };
      const result = validateAgentPersonality(bad);
      expect(result.valid).toBe(false);
      const vibeError = result.errors?.find((e) => e.field === "vibe");
      expect(vibeError?.message).toContain("160");
    });

    it("rejects non-array core_truths", () => {
      const bad = { ...validPersonality, core_truths: "not an array" };
      const result = validateAgentPersonality(bad);
      expect(result.valid).toBe(false);
      const ctError = result.errors?.find((e) => e.field === "core_truths");
      expect(ctError?.message).toContain("array");
    });

    it("rejects empty core_truths", () => {
      const bad = { ...validPersonality, core_truths: [] };
      const result = validateAgentPersonality(bad);
      expect(result.valid).toBe(false);
      const ctError = result.errors?.find((e) => e.field === "core_truths");
      expect(ctError?.message).toContain("must not be empty");
    });

    it("rejects non-string core_truths elements", () => {
      const bad = { ...validPersonality, core_truths: ["valid", 123] };
      const result = validateAgentPersonality(bad);
      expect(result.valid).toBe(false);
      const ctError = result.errors?.find((e) => e.field === "core_truths");
      expect(ctError?.message).toContain("must be strings");
    });

    it("rejects invalid expertise roles", () => {
      const bad = { ...validPersonality, expertise: ["architect", "invalid_role"] };
      const result = validateAgentPersonality(bad);
      expect(result.valid).toBe(false);
      const expError = result.errors?.find((e) => e.field === "expertise");
      expect(expError?.message).toContain("invalid_role");
    });

    it("rejects empty expertise", () => {
      const bad = { ...validPersonality, expertise: [] };
      const result = validateAgentPersonality(bad);
      expect(result.valid).toBe(false);
      const expError = result.errors?.find((e) => e.field === "expertise");
      expect(expError?.message).toContain("must not be empty");
    });

    it("accepts all valid expertise roles", () => {
      const allRoles: AgentPersonality = {
        ...validPersonality,
        expertise: [
          "architect",
          "reviewer",
          "coder",
          "debugger",
          "writer",
          "researcher",
          "tester",
          "devops",
          "designer",
        ],
      };
      const result = validateAgentPersonality(allRoles);
      expect(result.valid).toBe(true);
    });
  });

  describe("assertValidPersonality", () => {
    it("passes for valid personality", () => {
      expect(() => {
        assertValidPersonality(validPersonality);
      }).not.toThrow();
    });

    it("throws for invalid personality", () => {
      const bad = { ...validPersonality, vibe: "" };
      expect(() => {
        assertValidPersonality(bad);
      }).toThrow();
    });
  });

  describe("personalityToYAML", () => {
    it("converts valid personality to JSON string", () => {
      const json = personalityToYAML(validPersonality);
      expect(json).toContain('"vibe"');
      expect(json).toContain(validPersonality.vibe);
      expect(json).toContain('"core_truths"');
      expect(json).toContain('"boundaries"');
      expect(json).toContain('"communication_style"');
      expect(json).toContain('"expertise"');
    });

    it("output is valid JSON and parses correctly", () => {
      const json = personalityToYAML(validPersonality);
      const parsed = JSON.parse(json);
      expect(parsed).toEqual(validPersonality);
    });
  });

  describe("yamlToPersonality", () => {
    it("parses yaml back to personality object", () => {
      const yaml = personalityToYAML(validPersonality);
      const parsed = yamlToPersonality(yaml);
      expect(parsed.vibe).toBe(validPersonality.vibe);
      expect(parsed.core_truths).toEqual(validPersonality.core_truths);
      expect(parsed.boundaries).toEqual(validPersonality.boundaries);
      expect(parsed.communication_style).toBe(validPersonality.communication_style);
      expect(parsed.expertise).toEqual(validPersonality.expertise);
    });

    it("round-trip conversion preserves data", () => {
      const original = validPersonality;
      const yaml = personalityToYAML(original);
      const roundtrip = yamlToPersonality(yaml);

      // Should be valid and identical
      assertValidPersonality(roundtrip);
      expect(roundtrip).toEqual(original);
    });

    it("throws on invalid parsed yaml", () => {
      const badYaml = `
vibe: |
  Test

core_truths: []
boundaries:
  - test
communication_style: test
expertise:
  - architect
`;
      expect(() => {
        yamlToPersonality(badYaml);
      }).toThrow();
    });
  });

  describe("parsePersonalityJSON", () => {
    it("parses and validates JSON string", () => {
      const jsonStr = JSON.stringify(validPersonality);
      const parsed = parsePersonalityJSON(jsonStr);
      expect(parsed).toEqual(validPersonality);
    });

    it("throws on invalid JSON", () => {
      expect(() => {
        parsePersonalityJSON("{not valid json");
      }).toThrow();
    });

    it("throws on valid JSON but invalid personality", () => {
      expect(() => {
        parsePersonalityJSON(JSON.stringify({ vibe: "test" }));
      }).toThrow();
    });
  });
});
