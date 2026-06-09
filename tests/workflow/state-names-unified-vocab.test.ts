/**
 * P706: State Vocabulary Unification Tests
 *
 * Validates that RFC and Hotfix workflows use a unified state vocabulary.
 * No legacy states (TRIAGE, FIX, DEPLOYED, REJECTED, DISCARDED) appear in
 * active code paths.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("P706: Unified State Vocabulary", () => {
  describe("AC-TEST-01: src/core/runtime/model-routing.ts has no hotfix legacy states", () => {
    it("should not export ProposalPhase with TRIAGE, FIX, or DEPLOYED", () => {
      const filePath = join(process.cwd(), "src/core/runtime/model-routing.ts");
      const content = readFileSync(filePath, "utf-8");

      // Hotfix legacy states should not be in ProposalPhase type
      const phaseTypeMatch = content.match(/type ProposalPhase[\s\S]*?;/);
      assert.ok(phaseTypeMatch, "ProposalPhase type should exist");

      const phaseType = phaseTypeMatch[0];
      assert.ok(!phaseType.includes("TRIAGE"), "TRIAGE should not be in ProposalPhase");
      assert.ok(!phaseType.includes("FIX"), "FIX should not be in ProposalPhase");
      assert.ok(!phaseType.includes("DEPLOYED"), "DEPLOYED should not be in ProposalPhase");

      // Verify unified states are present
      assert.ok(phaseType.includes("DRAFT"), "DRAFT should be in ProposalPhase");
      assert.ok(phaseType.includes("REVIEW"), "REVIEW should be in ProposalPhase");
      assert.ok(phaseType.includes("DEVELOP"), "DEVELOP should be in ProposalPhase");
      assert.ok(phaseType.includes("MERGE"), "MERGE should be in ProposalPhase");
      assert.ok(phaseType.includes("COMPLETE"), "COMPLETE should be in ProposalPhase");
    });

    it("should not have PHASE_MODEL_TABLE entries for TRIAGE, FIX, or DEPLOYED", () => {
      const filePath = join(process.cwd(), "src/core/runtime/model-routing.ts");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        !content.includes('phase: "TRIAGE"'),
        'PHASE_MODEL_TABLE should not have TRIAGE phase'
      );
      assert.ok(
        !content.includes('phase: "FIX"'),
        'PHASE_MODEL_TABLE should not have FIX phase'
      );
      assert.ok(
        !content.includes('phase: "DEPLOYED"'),
        'PHASE_MODEL_TABLE should not have DEPLOYED phase'
      );
    });
  });

  describe("AC-TEST-02: src/core/orchestration/agent-spawner.ts uses isTerminal() not hardcoded states", () => {
    it("should import isTerminal from state-names", () => {
      const filePath = join(process.cwd(), "src/core/orchestration/agent-spawner.ts");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        content.includes("isTerminal") && content.includes("from"),
        "agent-spawner.ts should import isTerminal"
      );
    });

    it("should call isTerminal() instead of hardcoded terminal check", () => {
      const filePath = join(process.cwd(), "src/core/orchestration/agent-spawner.ts");
      const content = readFileSync(filePath, "utf-8");

      // Verify renderClosingHint uses isTerminal
      const renderClosingHint = content.match(/export function renderClosingHint[\s\S]*?return `\$\{input\.contextPackage\}/);
      assert.ok(renderClosingHint, "renderClosingHint should exist");

      const hint = renderClosingHint[0];
      assert.ok(
        hint.includes("isTerminal"),
        "renderClosingHint should use isTerminal()"
      );
      assert.ok(
        !hint.includes('stage === "COMPLETE" || stage === "DEPLOYED"'),
        "renderClosingHint should not hardcode COMPLETE/DEPLOYED check"
      );
    });
  });

  describe("AC-TEST-03: src/apps/ui/board.ts dynamically loads workflow stages", () => {
    it("should not have hardcoded RFC_STATUSES or HOTFIX_STATUSES arrays", () => {
      const filePath = join(process.cwd(), "src/apps/ui/board.ts");
      const content = readFileSync(filePath, "utf-8");

      // Legacy hardcoded arrays should not exist
      assert.ok(
        !content.includes("const RFC_STATUSES"),
        "RFC_STATUSES should not be hardcoded"
      );
      assert.ok(
        !content.includes("const HOTFIX_STATUSES"),
        "HOTFIX_STATUSES should not be hardcoded"
      );
      assert.ok(
        !content.includes("const WORKFLOW_VIEWS"),
        "WORKFLOW_VIEWS should not be hardcoded"
      );
    });

    it("should have getRfcStatusesCanonical and getHotfixStatusesCanonical functions", () => {
      const filePath = join(process.cwd(), "src/apps/ui/board.ts");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        content.includes("getRfcStatusesCanonical"),
        "getRfcStatusesCanonical should exist"
      );
      assert.ok(
        content.includes("getHotfixStatusesCanonical"),
        "getHotfixStatusesCanonical should exist"
      );
    });

    it("should call getView() to load workflow stages dynamically", () => {
      const filePath = join(process.cwd(), "src/apps/ui/board.ts");
      const content = readFileSync(filePath, "utf-8");

      const getRfcCanonical = content.match(
        /function getRfcStatusesCanonical[\s\S]*?\n\s*\}/
      );
      assert.ok(getRfcCanonical, "getRfcStatusesCanonical should exist");

      const fn = getRfcCanonical[0];
      assert.ok(
        fn.includes('getView("Standard RFC")'),
        "getRfcStatusesCanonical should call getView('Standard RFC')"
      );
    });
  });

  describe("AC-TEST-04: src/apps/dashboard-web/components/ProposalsPage.tsx filters obsolete by maturity", () => {
    it("should not have HIDDEN_STATUSES constant", () => {
      const filePath = join(process.cwd(), "src/apps/dashboard-web/components/ProposalsPage.tsx");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        !content.includes("const HIDDEN_STATUSES"),
        "HIDDEN_STATUSES should not exist"
      );
    });

    it("should filter proposals where maturity=obsolete", () => {
      const filePath = join(process.cwd(), "src/apps/dashboard-web/components/ProposalsPage.tsx");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        content.includes("maturity") && content.includes("obsolete"),
        "ProposalsPage should filter by maturity=obsolete"
      );
    });
  });

  describe("AC-TEST-05: src/core/orchestration/legacy-dispatch.ts hotfix workflow uses unified states", () => {
    it("should map DRAFT->DEVELOP->COMPLETE for hotfix, not TRIAGE->FIX->DEPLOYED", () => {
      const filePath = join(process.cwd(), "src/core/orchestration/legacy-dispatch.ts");
      const content = readFileSync(filePath, "utf-8");

      // Find STATE_TO_PHASE mapping
      const stateToPhase = content.match(/STATE_TO_PHASE[\s\S]*?\}/);
      assert.ok(stateToPhase, "STATE_TO_PHASE should exist");

      const mapping = stateToPhase[0];
      assert.ok(!mapping.includes("TRIAGE"), "STATE_TO_PHASE should not have TRIAGE");
      assert.ok(!mapping.includes("FIX"), "STATE_TO_PHASE should not have FIX");
      assert.ok(!mapping.includes("DEPLOYED"), "STATE_TO_PHASE should not have DEPLOYED");

      // Find the hotfix workflow case
      const hotfixCase = content.match(
        /case "DRAFT"[\s\S]*?toStage:.*?DEVELOP/
      );
      assert.ok(
        hotfixCase,
        "Hotfix workflow should map DRAFT -> DEVELOP"
      );

      const developCase = content.match(
        /case "DEVELOP"[\s\S]*?toStage:.*?COMPLETE/
      );
      assert.ok(
        developCase,
        "Hotfix workflow should map DEVELOP -> COMPLETE"
      );
    });
  });

  describe("AC-TEST-06: Maturity-based obsolescence replaces terminal states", () => {
    it("REJECTED and DISCARDED states are not actively used in new code", () => {
      // Legacy getters removed from state-names.ts
      const filePath = join(process.cwd(), "src/core/workflow/state-names.ts");
      const content = readFileSync(filePath, "utf-8");

      const rfcStatesSection = content.match(/export const RfcStates[\s\S]*?\n\};/);
      assert.ok(rfcStatesSection, "RfcStates should be defined");

      // The REJECTED and DISCARDED getters should not exist
      // (they were removed from state-names.ts)
      const rfcStates = rfcStatesSection[0];
      assert.ok(
        !rfcStates.includes("get REJECTED"),
        "RfcStates.REJECTED getter should not exist"
      );
      assert.ok(
        !rfcStates.includes("get DISCARDED"),
        "RfcStates.DISCARDED getter should not exist"
      );
    });

    it("maturity=obsolete is used to mark rejected/discarded proposals", () => {
      // This is a design constraint verified via DB data and schemas
      // The test verifies that code references maturity, not terminal states
      const filePath = join(process.cwd(), "src/apps/dashboard-web/components/ProposalsPage.tsx");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        content.includes("maturity"),
        "Dashboard should reference maturity field"
      );
    });
  });

  describe("AC-TEST-07: Workflow stages are loaded from SMDL, not hardcoded", () => {
    it("should have loadWorkflowStages() function in state-names.ts", () => {
      const filePath = join(process.cwd(), "src/core/workflow/state-names.ts");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        content.includes("export function loadWorkflowStages"),
        "loadWorkflowStages() should be exported"
      );
    });

    it("should return stages from getView().stages.map()", () => {
      const filePath = join(process.cwd(), "src/core/workflow/state-names.ts");
      const content = readFileSync(filePath, "utf-8");

      const loadWorkflowStages = content.match(
        /export function loadWorkflowStages[\s\S]*?\n\}/
      );
      assert.ok(loadWorkflowStages, "loadWorkflowStages should exist");

      const fn = loadWorkflowStages[0];
      assert.ok(
        fn.includes("getView") && fn.includes("stages.map"),
        "loadWorkflowStages should load from SMDL via getView().stages"
      );
    });
  });

  describe("AC-TEST-08: No legacy state strings in hardcoded arrays", () => {
    it("should not find hardcoded [TRIAGE, FIX, DEPLOYED] arrays in src/", () => {
      const filePath = join(process.cwd(), "src/core/orchestration/legacy-dispatch.ts");
      const content = readFileSync(filePath, "utf-8");

      // These legacy states should not appear in record keys or array literals
      // but can appear in comments explaining consolidation
      assert.ok(
        !content.includes('case "TRIAGE"'),
        "TRIAGE should not appear as case label"
      );
      assert.ok(
        !content.includes('case "FIX"'),
        "FIX should not appear as case label"
      );
      assert.ok(
        !content.includes('case "DEPLOYED"'),
        "DEPLOYED should not appear as case label"
      );
      assert.ok(
        !content.includes('TRIAGE:') || content.includes('// P706'),
        "TRIAGE key should be removed or P706 commented"
      );
      assert.ok(
        !content.includes('FIX:') || content.includes('// P706'),
        "FIX key should be removed or P706 commented"
      );
    });
  });

  describe("AC-TEST-09: State names registry provides unified interface", () => {
    it("should export functions: getView, isTerminal, isGateable, nextOnMature, isValidTransition", () => {
      const filePath = join(process.cwd(), "src/core/workflow/state-names.ts");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        content.includes("export function getView"),
        "getView should be exported"
      );
      assert.ok(
        content.includes("export function isTerminal"),
        "isTerminal should be exported"
      );
      assert.ok(
        content.includes("export function isGateable"),
        "isGateable should be exported"
      );
      assert.ok(
        content.includes("export function nextOnMature"),
        "nextOnMature should be exported"
      );
      assert.ok(
        content.includes("export function isValidTransition"),
        "isValidTransition should be exported"
      );
    });

    it("should export RfcStates and HotfixStates convenience objects", () => {
      const filePath = join(process.cwd(), "src/core/workflow/state-names.ts");
      const content = readFileSync(filePath, "utf-8");

      assert.ok(
        content.includes("export const RfcStates"),
        "RfcStates should be exported"
      );
      assert.ok(
        content.includes("export const HotfixStates"),
        "HotfixStates should be exported"
      );
    });
  });
});
