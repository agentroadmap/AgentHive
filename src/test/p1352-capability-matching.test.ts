/**
 * P1352 AC-5: Capability Matching Tests
 *
 * Tests for scoreAgencyByExpertise() and matching algorithm.
 */

import { describe, it, expect } from "bun:test";
import { scoreAgencyByExpertise } from "../core/orchestration/capability-matcher.ts";
import type { AgentPersonality } from "../core/identity/agent-registry/types.ts";

describe("Capability Matching", () => {
  describe("scoreAgencyByExpertise", () => {
    it("gives base score 50 with no personality", () => {
      const { score, matchedExpertise } = scoreAgencyByExpertise(null);
      expect(score).toBe(50);
      expect(matchedExpertise).toEqual([]);
    });

    it("gives base score 50 with no required capabilities", () => {
      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: ["architect"],
      };
      const { score } = scoreAgencyByExpertise(p);
      expect(score).toBe(50);
    });

    it("gives base score 50 with empty personality expertise", () => {
      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: [],
      };
      const { score } = scoreAgencyByExpertise(p, ["architect"]);
      expect(score).toBe(50);
    });

    it("adds 10 points per expertise match", () => {
      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: ["architect", "reviewer", "coder"],
      };

      const { score, matchedExpertise } = scoreAgencyByExpertise(p, [
        "architect",
        "reviewer",
      ]);

      expect(score).toBe(70); // 50 base + 10 + 10
      expect(matchedExpertise).toEqual(["architect", "reviewer"]);
    });

    it("case-insensitive matching", () => {
      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: ["ARCHITECT"],
      };

      const { score, matchedExpertise } = scoreAgencyByExpertise(p, ["architect"]);

      expect(score).toBe(60); // matched
      expect(matchedExpertise).toEqual(["ARCHITECT"]);
    });

    it("whitespace-tolerant matching", () => {
      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: ["architect"],
      };

      const { score } = scoreAgencyByExpertise(p, ["  architect  "]);

      expect(score).toBe(60); // matched despite extra whitespace
    });

    it("counts duplicates in expertise array", () => {
      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: ["architect", "architect"], // duplicate in array
      };

      const { score, matchedExpertise } = scoreAgencyByExpertise(p, ["architect"]);

      // Duplicates are counted as presented (this is rare in practice)
      expect(score).toBe(70); // 50 base + 10 + 10
      expect(matchedExpertise).toEqual(["architect", "architect"]);
    });

    it("partial match scenario", () => {
      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: ["architect", "coder"],
      };

      const { score, matchedExpertise } = scoreAgencyByExpertise(p, [
        "architect",
        "reviewer",
        "tester",
      ]);

      expect(score).toBe(60); // 50 base + 10 for architect only
      expect(matchedExpertise).toEqual(["architect"]);
    });

    it("no match scenario", () => {
      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: ["architect"],
      };

      const { score, matchedExpertise } = scoreAgencyByExpertise(p, [
        "reviewer",
        "tester",
      ]);

      expect(score).toBe(50); // base score only, no matches
      expect(matchedExpertise).toEqual([]);
    });

    it("all expertise match", () => {
      const allExpertise = [
        "architect",
        "reviewer",
        "coder",
        "debugger",
        "writer",
        "researcher",
        "tester",
        "devops",
        "designer",
      ] as const;

      const p: AgentPersonality = {
        vibe: "test",
        core_truths: ["test"],
        boundaries: ["test"],
        communication_style: "test",
        expertise: [...allExpertise],
      };

      const { score, matchedExpertise } = scoreAgencyByExpertise(p, [...allExpertise]);

      expect(score).toBe(50 + 9 * 10); // 140 total
      expect(matchedExpertise).toEqual(allExpertise);
    });
  });
});
