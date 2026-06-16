import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FlagKeys } from "./config-keys";

const VALID_CATEGORIES = new Set([
  "orchestration",
  "a2a",
  "agency",
  "feature_flag",
  "budget",
  "billing",
  "ui",
  "security",
  "model_routing",
  "system",
  "uncategorized",
]);

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

  it("ORCHESTRATOR_HEARTBEAT_MS has category orchestration (AC-16 spot-check)", () => {
    assert.equal(FlagKeys.ORCHESTRATOR_HEARTBEAT_MS.category, "orchestration");
  });
});
