import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { runScan } from "../../src/tools/scanner/engine.ts";
import { loadRules } from "../../src/tools/scanner/rules.ts";
import { outputJsonl } from "../../src/tools/scanner/output.ts";

const SCHEMA_PATH = join(
  process.cwd(),
  "src/tools/scanner/schema/findings.schema.json"
);

function loadFindingsSchema(): Record<string, unknown> {
  const raw = readFileSync(SCHEMA_PATH, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function validateFinding(
  finding: Record<string, unknown>,
  schema: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  const required = schema.required as string[] | undefined;
  if (required) {
    for (const field of required) {
      if (!(field in finding)) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return errors;

  for (const [field, fieldSchema] of Object.entries(props)) {
    if (!(field in finding)) continue;
    const value = finding[field];
    if (fieldSchema.type === "integer" && !Number.isInteger(value)) {
      errors.push(`Field '${field}' must be integer, got ${typeof value}`);
    }
    if (fieldSchema.type === "boolean" && typeof value !== "boolean") {
      errors.push(`Field '${field}' must be boolean, got ${typeof value}`);
    }
    if (fieldSchema.type === "string" && typeof value !== "string") {
      errors.push(`Field '${field}' must be string, got ${typeof value}`);
    }
    if (fieldSchema.type === "array" && !Array.isArray(value)) {
      errors.push(`Field '${field}' must be array, got ${typeof value}`);
    }
    if (fieldSchema.const !== undefined && value !== fieldSchema.const) {
      errors.push(
        `Field '${field}' must equal ${JSON.stringify(fieldSchema.const)}, got ${JSON.stringify(value)}`
      );
    }
    if (fieldSchema.enum) {
      const enumVals = fieldSchema.enum as unknown[];
      if (!enumVals.includes(value)) {
        errors.push(`Field '${field}' must be one of ${JSON.stringify(enumVals)}, got ${JSON.stringify(value)}`);
      }
    }
    if (fieldSchema.minimum !== undefined && typeof value === "number") {
      if (value < (fieldSchema.minimum as number)) {
        errors.push(`Field '${field}' must be >= ${fieldSchema.minimum}, got ${value}`);
      }
    }
    if (fieldSchema.maxLength !== undefined && typeof value === "string") {
      if (value.length > (fieldSchema.maxLength as number)) {
        errors.push(`Field '${field}' exceeds maxLength ${fieldSchema.maxLength}`);
      }
    }
  }

  return errors;
}

test("findings.schema.json - file exists and has correct structure", () => {
  const schema = loadFindingsSchema();
  assert.equal(typeof schema, "object");
  assert.ok(Array.isArray(schema.required), "schema.required must be array");
  assert.ok("properties" in schema, "schema must have properties");
  assert.equal(
    (schema.required as string[]).includes("schema_version"),
    true,
    "schema_version must be required"
  );
});

test("findings.schema.json - JSONL output validates against schema", async () => {
  const rulesDir = join(process.cwd(), "src/tools/scanner/rules");
  const { rules } = await loadRules(rulesDir);
  assert.ok(rules.length > 0, "Must load at least one rule");

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/test-pattern.ts"],
      minConfidence: "low",
      minSeverity: "low",
    },
    rules
  );

  const jsonl = await outputJsonl(result);
  if (!jsonl.trim()) {
    // No findings from this fixture with live rules — skip validation
    return;
  }

  const schema = loadFindingsSchema();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const finding = JSON.parse(line) as Record<string, unknown>;
    const errors = validateFinding(finding, schema);
    assert.deepEqual(
      errors,
      [],
      `Finding failed schema validation: ${errors.join("; ")}\nFinding: ${line}`
    );
  }
});

test("findings.schema.json - schema_version is always 1", async () => {
  const testRule = {
    id: "test.schema-version",
    description: "Verify schema_version field",
    severity: "medium" as const,
    confidence: "high" as const,
    proposal: "P454",
    pattern: "/tmp",
    fix_suggestion: "Use getTempDir()",
    examples_match: ['const x = "/tmp";'],
    examples_no_match: ["process.env.TMPDIR"],
  };

  const result = await runScan(
    {
      paths: ["tests/scanner/fixtures/test-pattern.ts"],
      minConfidence: "low",
      minSeverity: "low",
    },
    [testRule]
  );

  assert.ok(result.findings.length > 0, "Should have findings from fixture");

  const jsonl = await outputJsonl(result);
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const finding = JSON.parse(line) as Record<string, unknown>;
    assert.equal(
      finding.schema_version,
      1,
      "Every JSONL finding must have schema_version=1"
    );
  }
});
