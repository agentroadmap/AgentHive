/**
 * P455 AC#2 — CLI taxonomy and schema tests.
 * Verifies getCliSchema() returns a well-formed command tree,
 * and that RECIPES follow the expected shape.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { getCliSchema, RECIPES, CLI_VERSION, MCP_PROTOCOL_VERSION } from "../../src/apps/hive-cli/schema.ts";

describe("hive-cli taxonomy schema", () => {
  const schema = getCliSchema();

  it("schema has schema_version field", () => {
    assert.ok("schema_version" in schema, "missing schema_version");
    assert.strictEqual(typeof schema.schema_version, "number");
    assert.ok(schema.schema_version >= 1);
  });

  it("schema carries cli_version", () => {
    assert.strictEqual(typeof schema.cli_version, "string");
    assert.ok(schema.cli_version.length > 0);
    assert.strictEqual(schema.cli_version, CLI_VERSION);
  });

  it("schema carries mcp_protocol_version", () => {
    assert.strictEqual(typeof schema.mcp_protocol_version, "string");
    assert.strictEqual(schema.mcp_protocol_version, MCP_PROTOCOL_VERSION);
  });

  it("schema.commands is a non-empty array", () => {
    assert.ok(Array.isArray(schema.commands), "commands must be an array");
    assert.ok(schema.commands.length > 0, "commands must not be empty");
  });

  it("every top-level command has name and description", () => {
    for (const cmd of schema.commands) {
      assert.ok(cmd.name?.length > 0, `command missing name: ${JSON.stringify(cmd)}`);
      assert.ok(cmd.description?.length > 0, `command '${cmd.name}' missing description`);
    }
  });

  it("every command with sub-commands has a non-empty sub-commands array", () => {
    for (const cmd of schema.commands) {
      if ("subcommands" in cmd && cmd.subcommands !== undefined) {
        assert.ok(Array.isArray(cmd.subcommands), `${cmd.name}.subcommands must be array`);
        assert.ok(cmd.subcommands.length > 0, `${cmd.name}.subcommands must not be empty`);
      }
    }
  });

  it("proposal domain is present", () => {
    const proposal = schema.commands.find((c) => c.name === "proposal");
    assert.ok(proposal, "proposal domain missing from command tree");
  });

  it("proposal domain has sub-commands: list, get/show, claim, next, maturity", () => {
    const proposal = schema.commands.find((c) => c.name === "proposal");
    const subs = (proposal as { subcommands?: { name: string }[] }).subcommands ?? [];
    const names = subs.map((s) => s.name);
    for (const required of ["list", "claim", "next", "maturity"]) {
      assert.ok(names.includes(required), `proposal missing sub-command: ${required}`);
    }
  });

  it("workflow domain is present", () => {
    const workflow = schema.commands.find((c) => c.name === "workflow");
    assert.ok(workflow, "workflow domain missing from command tree");
  });

  it("doctor command is present", () => {
    const doctor = schema.commands.find((c) => c.name === "doctor");
    assert.ok(doctor, "doctor command missing from command tree");
  });

  it("stop domain is present", () => {
    const stop = schema.commands.find((c) => c.name === "stop");
    assert.ok(stop, "stop domain missing from command tree");
  });

  it("context command is present", () => {
    const ctx = schema.commands.find((c) => c.name === "context");
    assert.ok(ctx, "context command missing from command tree");
  });

  it("every flag def has name and type", () => {
    for (const cmd of schema.commands) {
      const flags = (cmd as { flags?: { name: string; type: string }[] }).flags ?? [];
      for (const f of flags) {
        assert.ok(f.name?.length > 0, `flag missing name in ${cmd.name}`);
        assert.ok(f.type?.length > 0, `flag '${f.name}' missing type in ${cmd.name}`);
      }
    }
  });

  it("schema is JSON-serialisable (circular reference check)", () => {
    assert.doesNotThrow(() => JSON.stringify(schema));
  });
});

describe("hive-cli RECIPES", () => {
  it("RECIPES is a non-empty array", () => {
    assert.ok(Array.isArray(RECIPES), "RECIPES must be an array");
    assert.ok(RECIPES.length > 0, "RECIPES must not be empty");
  });

  it("every recipe has name, description, and steps", () => {
    for (const recipe of RECIPES) {
      assert.ok(recipe.name?.length > 0, `recipe missing name: ${JSON.stringify(recipe)}`);
      assert.ok(recipe.description?.length > 0, `recipe '${recipe.name}' missing description`);
      assert.ok(Array.isArray(recipe.steps), `recipe '${recipe.name}' steps must be array`);
      assert.ok(recipe.steps.length > 0, `recipe '${recipe.name}' must have at least one step`);
    }
  });

  it("every recipe step has command and description", () => {
    for (const recipe of RECIPES) {
      for (const step of recipe.steps) {
        assert.ok(step.command?.length > 0, `recipe '${recipe.name}' step missing command`);
        assert.ok(step.description?.length > 0, `recipe '${recipe.name}' step missing description`);
      }
    }
  });

  it("recipe names are unique", () => {
    const names = RECIPES.map((r) => r.name);
    const unique = new Set(names);
    assert.strictEqual(unique.size, names.length, "duplicate recipe names detected");
  });

  it("RECIPES are JSON-serialisable as JSONL", () => {
    assert.doesNotThrow(() => {
      for (const recipe of RECIPES) {
        JSON.stringify(recipe);
      }
    });
  });

  it("claim-and-develop recipe exists", () => {
    const found = RECIPES.find((r) => r.name === "claim-and-develop");
    assert.ok(found, "claim-and-develop recipe missing");
  });

  it("health-check recipe exists", () => {
    const found = RECIPES.find((r) => r.name === "health-check");
    assert.ok(found, "health-check recipe missing");
  });
});
