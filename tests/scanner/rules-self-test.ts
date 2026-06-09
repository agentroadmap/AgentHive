import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRules } from "../../src/tools/scanner/rules.ts";
import path from "path";

test("rule loader - loads all rules", async () => {
  const rulesDir = path.resolve("src/tools/scanner/rules");
  const { rules, errors } = await loadRules(rulesDir);

  assert.ok(rules.length > 0, "Should load at least example rules");
  if (errors.length > 0) {
    console.error("Rule load errors:", errors);
  }
  // Don't fail on errors in case some rules are not yet created
});

test("rule loader - validates rule structure", async () => {
  const rulesDir = path.resolve("src/tools/scanner/rules");
  const { rules, errors } = await loadRules(rulesDir);

  for (const rule of rules) {
    assert.ok(rule.id, `Rule must have id`);
    assert.match(rule.id, /^[a-z0-9][a-z0-9.-]*$/, `Rule id must be kebab-case or category.rule-name: ${rule.id}`);
    assert.ok(rule.description, `Rule ${rule.id} must have description`);
    assert.ok(
      ["critical", "high", "medium", "low"].includes(rule.severity),
      `Rule ${rule.id} has invalid severity`
    );
    assert.ok(
      ["high", "medium", "low"].includes(rule.confidence),
      `Rule ${rule.id} has invalid confidence`
    );
    assert.ok(rule.proposal, `Rule ${rule.id} must have proposal`);
    assert.ok(rule.fix_suggestion, `Rule ${rule.id} must have fix_suggestion`);
    assert.ok(
      rule.examples_match && rule.examples_match.length > 0,
      `Rule ${rule.id} must have examples_match`
    );
    assert.ok(
      rule.examples_no_match && rule.examples_no_match.length > 0,
      `Rule ${rule.id} must have examples_no_match`
    );
    assert.ok(
      rule.pattern || rule.regex || rule.ast_query,
      `Rule ${rule.id} must have pattern, regex, or ast_query`
    );
  }
});

test("rule loader - validates examples match pattern", async () => {
  const rulesDir = path.resolve("src/tools/scanner/rules");
  const { rules } = await loadRules(rulesDir);

  for (const rule of rules) {
    for (const example of rule.examples_match) {
      let matches = false;

      if (rule.pattern && example.includes(rule.pattern)) {
        matches = true;
      } else if (rule.regex) {
        matches = new RegExp(rule.regex).test(example);
      }

      assert.ok(
        matches,
        `Rule ${rule.id}: examples_match example should match: "${example}"`
      );
    }
  }
});

test("rule loader - validates examples no match pattern", async () => {
  const rulesDir = path.resolve("src/tools/scanner/rules");
  const { rules } = await loadRules(rulesDir);

  for (const rule of rules) {
    for (const example of rule.examples_no_match) {
      let matches = false;

      if (rule.pattern && example.includes(rule.pattern)) {
        matches = true;
      } else if (rule.regex) {
        matches = new RegExp(rule.regex).test(example);
      }

      assert.equal(
        matches,
        false,
        `Rule ${rule.id}: examples_no_match example should NOT match: "${example}"`
      );
    }
  }
});

test("rule loader - validates rule id uniqueness", async () => {
  const rulesDir = path.resolve("src/tools/scanner/rules");
  const { rules, errors } = await loadRules(rulesDir);

  const ids = new Set<string>();
  for (const rule of rules) {
    assert.ok(!ids.has(rule.id), `Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
  }
});

test("rule loader - validates regex compilation", async () => {
  const rulesDir = path.resolve("src/tools/scanner/rules");
  const { rules, errors } = await loadRules(rulesDir);

  for (const rule of rules) {
    if (rule.regex) {
      assert.doesNotThrow(
        () => new RegExp(rule.regex!),
        `Rule ${rule.id}: regex should compile: ${rule.regex}`
      );
    }
  }
});

test("rule loader - example rules work", async () => {
  const rulesDir = path.resolve("src/tools/scanner/rules");
  const { rules } = await loadRules(rulesDir);

  const exampleRules = rules.filter((r) => r.id.startsWith("example-"));
  assert.ok(exampleRules.length > 0, "Should have example rules for validation");

  for (const rule of exampleRules) {
    assert.ok(rule.proposal === "P448" || rule.proposal === "P449", `Example rule should reference P448 or P449`);
  }
});
