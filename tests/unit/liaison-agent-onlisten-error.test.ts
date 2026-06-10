/**
 * P1142: onListenError callback unit test.
 *
 * Tests the per-agency LISTEN client error handler:
 *   - AC-1: runLiaisonAgent accepts optional onListenError callback in options
 *   - AC-2: existing LISTEN error handler invokes callback AFTER log (if provided)
 *   - AC-7: when callback omitted, log-only behavior is preserved
 *
 * Note: This is a code review assertion test. The callback is verified to exist
 * in the source code and be wired correctly. Full integration tests are in
 * tests/integration/liaison-agent.test.ts which test against live DB.
 *
 * AC signatures verified:
 *   - AC-1: onListenError?: (err: Error, identity: string) => void
 *   - AC-2: listenClient.on("error") logs, then invokes opts.onListenError
 *   - AC-7: No callback → log-only path still works
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

describe("P1142: liaison-agent onListenError code review", () => {
	describe("AC-1: LiaisonAgentOptions interface includes onListenError", () => {
		it("has onListenError callback in options interface", () => {
			const filePath = path.join(
				__dirname,
				"../../src/infra/agency/liaison-agent.ts",
			);
			const source = fs.readFileSync(filePath, "utf-8");

			// Verify onListenError is declared in LiaisonAgentOptions
			assert.match(
				source,
				/onListenError\s*\?\s*:\s*\(\s*err\s*:\s*Error\s*,\s*identity\s*:\s*string\s*\)\s*=>\s*void/,
				"onListenError callback signature should be in LiaisonAgentOptions",
			);
		});
	});

	describe("AC-2: error handler invokes callback after log", () => {
		it("logs error first, then invokes callback", () => {
			const filePath = path.join(
				__dirname,
				"../../src/infra/agency/liaison-agent.ts",
			);
			const source = fs.readFileSync(filePath, "utf-8");

			// Verify the error handler logs first
			assert.match(
				source,
				/listenClient\.on\("error",\s*\(\s*err\s*\)\s*=>\s*\{\s*console\.error\(/,
				"error handler should call console.error first",
			);

			// Verify callback is invoked after the log
			assert.match(
				source,
				/console\.error\([^)]+\);\s*\/\/ AC-2:[^\n]*\n\s*if\s*\(\s*opts\.onListenError\s*\)\s*\{\s*opts\.onListenError\(/,
				"callback should be invoked after console.error",
			);
		});
	});

	describe("AC-3: start-a2a-host passes onListenError callback", () => {
		it("passes onListenError with exit(1) handler", () => {
			const filePath = path.join(__dirname, "../../scripts/start-a2a-host.ts");
			const source = fs.readFileSync(filePath, "utf-8");

			// Verify onListenError is passed in start-a2a-host
			assert.match(
				source,
				/onListenError\s*:\s*\([^)]*\)\s*=>\s*\{[\s\S]*?process\.exit\(1\)/,
				"start-a2a-host should pass onListenError that calls process.exit(1)",
			);

			// Verify the error message is logged
			assert.match(
				source,
				/FATAL LISTEN client error.*exiting for systemd restart/,
				"should log FATAL message before exit",
			);
		});
	});

	describe("AC-4: start-liaison.ts backward compatibility", () => {
		it("does NOT pass onListenError for legacy rollback", () => {
			const filePath = path.join(__dirname, "../../scripts/start-liaison.ts");
			const source = fs.readFileSync(filePath, "utf-8");

			// Extract the runLiaisonAgent call in start-liaison.ts
			const callMatch = source.match(
				/runLiaisonAgent\s*\(\s*\{[\s\S]*?\}\s*\)/,
			);
			assert.ok(callMatch, "should have a runLiaisonAgent call");

			const callContent = callMatch[0];
			// Verify onListenError is NOT in the options
			assert.ok(
				!callContent.includes("onListenError"),
				"start-liaison.ts should NOT pass onListenError for backward compatibility",
			);
		});
	});

	describe("AC-7: backward compatibility with omitted callback", () => {
		it("log-only path exists when callback is undefined", () => {
			const filePath = path.join(
				__dirname,
				"../../src/infra/agency/liaison-agent.ts",
			);
			const source = fs.readFileSync(filePath, "utf-8");

			// The error handler should log regardless of whether callback exists
			assert.match(
				source,
				/listenClient\.on\("error",\s*\(err\)\s*=>\s*\{\s*console\.error\(`.*LISTEN client error/,
				"should always log error first",
			);

			// The callback check is conditional (if opts.onListenError)
			assert.match(
				source,
				/if\s*\(\s*opts\.onListenError\s*\)\s*\{/,
				"callback invocation should be conditional",
			);
		});
	});
});
