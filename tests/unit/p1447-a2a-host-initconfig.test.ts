/**
 * P1447 AC-2: a2a-host initConfig() fix unit test.
 *
 * Verifies that start-a2a-host.ts calls initConfig() to initialize the
 * runtime config resolver with the DB pool, preventing silent flag-read
 * failures (which led to AGENCY_OFFER_CLAIM_ENABLED defaulting to false).
 *
 * Context: start-liaison.ts added this call in V3-C6 (#80697ffa), but
 * start-a2a-host.ts was left without it. When runtime_config.get() is called
 * without initializing the global resolver, it throws "Resolver not initialized",
 * and callers that use .catch(() => false) silently disable features.
 *
 * This test is a code-review assertion: it verifies the fix is present in
 * source code and properly wired.
 *
 * AC mapping:
 *   - AC-2: initConfig({ pool, scopeContext }) called early in main()
 *   - Mirrors: start-liaison.ts:51-57 + scripts/orchestrator.ts:40
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

describe("P1447 AC-2: a2a-host initConfig fix", () => {
	describe("initConfig import and call", () => {
		it("imports initConfig from src/shared/runtime/config.ts", () => {
			const filePath = path.join(__dirname, "../../scripts/start-a2a-host.ts");
			const source = fs.readFileSync(filePath, "utf-8");

			// Verify import statement
			assert.match(
				source,
				/import\s+\{[\s\S]*?initConfig[\s\S]*?\}\s+from\s+["'].*config\.ts["']/,
				"initConfig should be imported from config.ts",
			);
		});

		it("calls initConfig() in main() before loadRuntimeFlags()", () => {
			const filePath = path.join(__dirname, "../../scripts/start-a2a-host.ts");
			const source = fs.readFileSync(filePath, "utf-8");

			// Extract main() function body
			const mainStart = source.indexOf("async function main()");
			assert.ok(mainStart > 0, "should have main() function");

			const mainBody = source.substring(mainStart);

			// Find first occurrence of key calls in main()
			const getPoolInMain = mainBody.indexOf("getPool()");
			const initConfigInMain = mainBody.indexOf("await initConfig({");
			const loadRuntimeFlagsInMain = mainBody.indexOf("await loadRuntimeFlags()");

			assert.ok(
				getPoolInMain > 0,
				"getPool() should be called in main()",
			);

			assert.ok(
				initConfigInMain > 0,
				"initConfig() should be called",
			);

			assert.ok(
				getPoolInMain < initConfigInMain,
				"initConfig() should be called after getPool()",
			);

			assert.ok(
				initConfigInMain < loadRuntimeFlagsInMain,
				"initConfig() should be called before loadRuntimeFlags()",
			);
		});

		it("passes pool and scopeContext to initConfig()", () => {
			const filePath = path.join(__dirname, "../../scripts/start-a2a-host.ts");
			const source = fs.readFileSync(filePath, "utf-8");

			// Verify initConfig call signature
			assert.match(
				source,
				/await\s+initConfig\s*\(\s*\{[\s\S]*?pool\s*:\s*getPool\(\)[\s\S]*?scopeContext[\s\S]*?\}\s*\)/,
				"initConfig should be called with { pool: getPool(), scopeContext: ... }",
			);

			// Verify scopeContext includes hostId
			assert.match(
				source,
				/scopeContext\s*:\s*\{[\s\S]*?hostId\s*:\s*host[\s\S]*?\}/,
				"scopeContext should include hostId: host",
			);
		});
	});

	describe("comparison with start-liaison.ts", () => {
		it("matches the pattern used in start-liaison.ts", () => {
			const liaisonPath = path.join(__dirname, "../../scripts/start-liaison.ts");
			const a2aHostPath = path.join(__dirname, "../../scripts/start-a2a-host.ts");

			const liaisonSource = fs.readFileSync(liaisonPath, "utf-8");
			const a2aHostSource = fs.readFileSync(a2aHostPath, "utf-8");

			// Both should import initConfig
			assert.match(liaisonSource, /initConfig/, "start-liaison.ts should import initConfig");
			assert.match(a2aHostSource, /initConfig/, "start-a2a-host.ts should import initConfig");

			// Both should call initConfig with pool
			assert.match(
				liaisonSource,
				/await\s+initConfig\s*\(\s*\{[\s\S]*?pool\s*:\s*getPool\(\)/,
				"start-liaison.ts should call initConfig with pool",
			);
			assert.match(
				a2aHostSource,
				/await\s+initConfig\s*\(\s*\{[\s\S]*?pool\s*:\s*getPool\(\)/,
				"start-a2a-host.ts should call initConfig with pool",
			);

			// Both should have scopeContext
			assert.match(
				liaisonSource,
				/scopeContext\s*:\s*\{/,
				"start-liaison.ts should have scopeContext",
			);
			assert.match(
				a2aHostSource,
				/scopeContext\s*:\s*\{/,
				"start-a2a-host.ts should have scopeContext",
			);
		});
	});

	describe("comment documenting the fix", () => {
		it("includes P1447 AC-2 comment explaining why initConfig is required", () => {
			const filePath = path.join(__dirname, "../../scripts/start-a2a-host.ts");
			const source = fs.readFileSync(filePath, "utf-8");

			// Verify explanatory comment near initConfig call
			assert.match(
				source,
				/P1447.*AC-2[\s\S]*?initialize[\s\S]*?resolver/i,
				"should have comment explaining P1447 AC-2 and why initConfig is needed",
			);
		});
	});
});
