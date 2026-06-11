import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../");

test("P779 rule: bare-hotfix-stage has correct configuration", async () => {
  // Load the rules and verify workflow-states.bare-hotfix-stage is properly configured
  const rulesPath = path.join(repoRoot, "src/tools/scanner/rules/06-workflow-states.yaml");
  const rulesContent = await fs.readFile(rulesPath, "utf-8");

  // Verify the rule includes all legacy states
  assert.ok(rulesContent.includes("TRIAGE"), "Rule should check for TRIAGE");
  assert.ok(rulesContent.includes("FIX"), "Rule should check for FIX");
  assert.ok(rulesContent.includes("DEPLOYED"), "Rule should check for DEPLOYED");
  assert.ok(rulesContent.includes("ESCALATE"), "Rule should check for ESCALATE");
  assert.ok(rulesContent.includes("WONT_FIX"), "Rule should check for WONT_FIX");
  assert.ok(rulesContent.includes("NON_ISSUE"), "Rule should check for NON_ISSUE");
  assert.ok(rulesContent.includes("REJECTED"), "Rule should check for REJECTED");
  assert.ok(rulesContent.includes("DISCARDED"), "Rule should check for DISCARDED");
  assert.ok(rulesContent.includes("REPLACED"), "Rule should check for REPLACED");

  // Verify migrations are excluded
  assert.ok(rulesContent.includes("database/migrations/**"), "Rule should exclude database/migrations");

  // Verify scripts are excluded (for operational test harnesses)
  assert.ok(rulesContent.includes("scripts/**"), "Rule should exclude scripts (test harnesses)");

  // Verify web bundles are excluded
  assert.ok(rulesContent.includes("src/web/**"), "Rule should exclude src/web build artifacts");

  // Verify proposal is P779
  assert.ok(rulesContent.includes("P779"), "Rule should reference proposal P779");

  console.log("✓ P779 rule is properly configured with all legacy states and correct exclusions");
});

test("CI integration: gitlab-ci.yml includes workflow-states-check", async () => {
  const ciPath = path.join(repoRoot, ".gitlab-ci.yml");
  const ciContent = await fs.readFile(ciPath, "utf-8");

  assert.ok(ciContent.includes("workflow-states-check:"), "CI should have a workflow-states-check job");
  assert.ok(
    ciContent.includes("npm run scan:workflow-states"),
    "CI job should run npm run scan:workflow-states"
  );
  assert.ok(ciContent.includes("stage: check"), "Job should be in the check stage");

  console.log("✓ CI integration: workflow-states-check is wired into GitLab CI");
});

test("npm script exists: scan:workflow-states", async () => {
  const pkgPath = path.join(repoRoot, "package.json");
  const pkgContent = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgContent);

  assert.ok(pkg.scripts["scan:workflow-states"], "npm script scan:workflow-states should exist");
  assert.ok(
    pkg.scripts["scan:workflow-states"].includes("--rule-tag workflow"),
    "Script should filter by workflow tag"
  );
  assert.ok(
    pkg.scripts["scan:workflow-states"].includes("--fail-on high"),
    "Script should fail on high severity"
  );

  console.log("✓ npm script scan:workflow-states is properly configured");
});

test("Rule examples for bare-hotfix-stage are valid", async () => {
  const rulesPath = path.join(repoRoot, "src/tools/scanner/rules/06-workflow-states.yaml");
  const rulesContent = await fs.readFile(rulesPath, "utf-8");

  // Find the bare-hotfix-stage rule section
  const ruleStartIdx = rulesContent.indexOf("id: workflow-states.bare-hotfix-stage");
  assert.ok(ruleStartIdx !== -1, "Should find bare-hotfix-stage rule");

  const ruleSection = rulesContent.substring(ruleStartIdx, ruleStartIdx + 2000);

  // Verify examples_match section exists and has valid examples
  assert.ok(ruleSection.includes("examples_match:"), "Rule should have examples_match");
  assert.ok(
    ruleSection.includes("TRIAGE") || ruleSection.includes("DEPLOYED"),
    "Examples should include hotfix states"
  );

  // Verify fix_suggestion references States.hotfix
  assert.ok(ruleSection.includes("States.hotfix"), "Fix suggestion should reference States.hotfix");

  console.log("✓ bare-hotfix-stage rule has valid examples and suggestions");
});
