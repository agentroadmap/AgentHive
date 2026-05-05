import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeExtraEnv } from "../src/core/orchestration/spawn-env-sanitizer.ts";

// Tests for P845-C1: strip *_SECRET/*_PASSWORD from extraEnv passed to spawned agents.
// sanitizeExtraEnv is the only export needed — it has no DB/network dependencies.

describe("P845 — sanitizeExtraEnv", () => {
	it("AC-2: strips _PASSWORD suffix (case-insensitive)", () => {
		const result = sanitizeExtraEnv({ MY_PASSWORD: "x", SAFE_KEY: "z" });
		assert.equal(result.MY_PASSWORD, undefined);
		assert.equal(result.SAFE_KEY, "z");
	});

	it("AC-2: strips _SECRET suffix (case-insensitive)", () => {
		const result = sanitizeExtraEnv({ API_SECRET: "y", SAFE_KEY: "z" });
		assert.equal(result.API_SECRET, undefined);
		assert.equal(result.SAFE_KEY, "z");
	});

	it("AC-2: canonical test case from AC spec", () => {
		const result = sanitizeExtraEnv({ MY_PASSWORD: "x", API_SECRET: "y", SAFE_KEY: "z" });
		assert.deepEqual(result, { SAFE_KEY: "z" });
	});

	it("AC-2: lowercase _secret and _password are also stripped", () => {
		const result = sanitizeExtraEnv({ db_secret: "hidden", db_password: "hidden2", ok_key: "visible" });
		assert.equal(result.db_secret, undefined);
		assert.equal(result.db_password, undefined);
		assert.equal(result.ok_key, "visible");
	});

	it("AC-3: non-dangerous keys pass through unchanged", () => {
		const result = sanitizeExtraEnv({ CUSTOM_FLAG: "1", LOG_LEVEL: "debug", SECRETAIRE: "not-stripped" });
		assert.equal(result.CUSTOM_FLAG, "1");
		assert.equal(result.LOG_LEVEL, "debug");
		// SECRETAIRE doesn't end in _SECRET so must survive
		assert.equal(result.SECRETAIRE, "not-stripped");
	});

	it("empty input returns empty object", () => {
		assert.deepEqual(sanitizeExtraEnv({}), {});
	});
});
