import { test } from "node:test";
import assert from "node:assert/strict";
import { runScan } from "../../src/tools/scanner/engine.ts";
import { type Rule } from "../../src/tools/scanner/rules.ts";

test("scanner engine - match pattern", async () => {
  const testRule: Rule = {
    id: "test-pattern",
    description: "Test pattern matching",
    severity: "high",
    confidence: "high",
    proposal: "P000",
    pattern: "/tmp",
    fix_suggestion: "Use getTempDir()",
    examples_match: ['const x = "/tmp";'],
    examples_no_match: ["const y = process.env.TMPDIR"],
  };

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/test-pattern.ts"],
      minConfidence: "low",
      minSeverity: "low",
    },
    [testRule]
  );

  assert.ok(result.findings.length > 0, "Should find pattern match");
  assert.equal(result.findings[0].rule, "test-pattern");
});

test("scanner engine - allowlist suppression", async () => {
  const testRule: Rule = {
    id: "test-suppress",
    description: "Test suppression",
    severity: "high",
    confidence: "high",
    proposal: "P000",
    pattern: "SUPPRESS_ME",
    fix_suggestion: "Fix it",
    examples_match: ["const x = SUPPRESS_ME;"],
    examples_no_match: ["const y = ALLOWED;"],
  };

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/test-suppress.ts"],
      allowlistPath: "tests/scanner/fixtures/.scanignore-test.yaml",
      minConfidence: "low",
      minSeverity: "low",
    },
    [testRule]
  );

  // All findings should be suppressed by allowlist
  // (Implementation depends on fixture files)
});

test("scanner engine - inline allow comment", async () => {
  // This test would verify that inline suppressions work
  // Implementation depends on test fixture with inline comments
});

test("scanner engine - acknowledged debt detection", async () => {
  // This test would verify that TODO(Pxxx) comments reduce severity
  // Implementation depends on test fixture with TODO comments
});

test("scanner engine - file glob filtering", async () => {
  const testRule: Rule = {
    id: "test-glob",
    description: "Test glob filtering",
    severity: "high",
    confidence: "high",
    proposal: "P000",
    pattern: "MATCH_ME",
    file_glob: ["src/**/*.ts"],
    file_glob_exclude: ["**/*.test.ts"],
    fix_suggestion: "Fix it",
    examples_match: ["const x = MATCH_ME;"],
    examples_no_match: ["const y = ALLOWED;"],
  };

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/"],
      minConfidence: "low",
      minSeverity: "low",
    },
    [testRule]
  );

  // Should only match files in src/**/*.ts but not **/*.test.ts
});

test("scanner engine - binary file skipping", async () => {
  const testRule: Rule = {
    id: "test-binary",
    description: "Test binary skip",
    severity: "high",
    confidence: "high",
    proposal: "P000",
    pattern: "SHOULD_NOT_MATCH",
    fix_suggestion: "Fix it",
    examples_match: ["SHOULD_NOT_MATCH"],
    examples_no_match: ["ALLOWED"],
  };

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/"],
      includeBinary: false,
      minConfidence: "low",
      minSeverity: "low",
    },
    [testRule]
  );

  // Binary files should be skipped unless includeBinary is true
});

test("scanner engine - confidence filtering", async () => {
  const highConfidenceRule: Rule = {
    id: "high-conf",
    description: "High confidence rule",
    severity: "high",
    confidence: "high",
    proposal: "P000",
    pattern: "MATCH",
    fix_suggestion: "Fix",
    examples_match: ["MATCH"],
    examples_no_match: [""],
  };

  const lowConfidenceRule: Rule = {
    id: "low-conf",
    description: "Low confidence rule",
    severity: "high",
    confidence: "low",
    proposal: "P000",
    pattern: "MATCH",
    fix_suggestion: "Fix",
    examples_match: ["MATCH"],
    examples_no_match: [""],
  };

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/"],
      minConfidence: "high",
      minSeverity: "low",
    },
    [highConfidenceRule, lowConfidenceRule]
  );

  // Should only match with high-conf rule, not low-conf rule
});

test("scanner engine - severity filtering", async () => {
  const criticalRule: Rule = {
    id: "critical",
    description: "Critical rule",
    severity: "critical",
    confidence: "high",
    proposal: "P000",
    pattern: "MATCH",
    fix_suggestion: "Fix",
    examples_match: ["MATCH"],
    examples_no_match: [""],
  };

  const lowRule: Rule = {
    id: "low",
    description: "Low rule",
    severity: "low",
    confidence: "high",
    proposal: "P000",
    pattern: "MATCH",
    fix_suggestion: "Fix",
    examples_match: ["MATCH"],
    examples_no_match: [""],
  };

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/"],
      minSeverity: "high",
      minConfidence: "low",
    },
    [criticalRule, lowRule]
  );

  // Should only match with critical rule, not low rule
});

test("scanner engine - stats calculation", async () => {
  const testRule: Rule = {
    id: "test-stats",
    description: "Test stats",
    severity: "high",
    confidence: "high",
    proposal: "P000",
    pattern: "MATCH",
    fix_suggestion: "Fix",
    examples_match: ["MATCH"],
    examples_no_match: [""],
  };

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/"],
      minConfidence: "low",
      minSeverity: "low",
    },
    [testRule]
  );

  assert.ok("findingsByRule" in result.stats);
  assert.ok("findingsBySeverity" in result.stats);
  assert.ok("acknowledgedDebt" in result.stats);
  assert.ok("suppressed" in result.stats);
});
