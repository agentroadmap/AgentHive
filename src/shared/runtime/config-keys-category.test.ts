import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FlagKeys } from "./config-keys";
import { CONFIG_CATEGORIES } from "./config-categories";

const VALID_CATEGORIES = new Set(CONFIG_CATEGORIES);

describe("FlagKeys categories", () => {
  it("every FlagKey has a defined category", () => {
    const missing: string[] = [];
    for (const [key, def] of Object.entries(FlagKeys)) {
      if (!def.category) {
        missing.push(key);
      }
    }
    assert.deepEqual(missing, [], `FlagKeys missing category: ${missing.join(", ")}`);
  });

  it("every FlagKey category is a valid ConfigKeyCategory value", () => {
    const invalid: string[] = [];
    for (const [key, def] of Object.entries(FlagKeys)) {
      if (def.category && !VALID_CATEGORIES.has(def.category)) {
        invalid.push(`${key}=${def.category}`);
      }
    }
    assert.deepEqual(invalid, [], `FlagKeys with invalid category: ${invalid.join(", ")}`);
  });

  it("ORCHESTRATOR_HEARTBEAT_MS has category orchestrator (AC-16 spot-check)", () => {
    assert.equal(FlagKeys.ORCHESTRATOR_HEARTBEAT_MS.category, "orchestrator");
  });
});
