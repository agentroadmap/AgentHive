/**
 * Tests for proposal-integrity.ts — Transition Validation with ErrorCode (AC-12, AC-17)
 *
 * Tests the structured validation errors and error codes returned by
 * the transition validation functions.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

// Import types and formatting functions (unit-testable without DB)
import {
	formatValidationError,
	type ValidationError,
	type ErrorCode,
} from "../../src/core/proposal/proposal-integrity.ts";

describe("proposal-integrity: ValidationError formatting", () => {
	it("should format INVALID_TRANSITION error with correct icon", () => {
		const error: ValidationError = {
			code: "INVALID_TRANSITION",
			message: "Transition Draft → Complete not allowed",
			context: { fromState: "Draft", toState: "Complete" },
		};
		const formatted = formatValidationError(error);
		assert.ok(formatted.includes("🚫"));
		assert.ok(formatted.includes("[INVALID_TRANSITION]"));
		assert.ok(formatted.includes("Draft → Complete"));
	});

	it("should format MATURITY_GATE_BLOCKED error with correct icon", () => {
		const error: ValidationError = {
			code: "MATURITY_GATE_BLOCKED",
			message: "Cannot promote: maturity is 'active', must be 'mature'",
			context: { currentMaturity: "active", requiredMaturity: "mature" },
		};
		const formatted = formatValidationError(error);
		assert.ok(formatted.includes("⏳"));
		assert.ok(formatted.includes("[MATURITY_GATE_BLOCKED]"));
		assert.ok(formatted.includes("active"));
	});

	it("should format AC_GATE_FAILED error with correct icon", () => {
		const error: ValidationError = {
			code: "AC_GATE_FAILED",
			message: "Cannot transition: 3 acceptance criteria not satisfied",
			context: { blockingItemNumbers: [1, 2, 3] },
		};
		const formatted = formatValidationError(error);
		assert.ok(formatted.includes("📋"));
		assert.ok(formatted.includes("[AC_GATE_FAILED]"));
		assert.ok(formatted.includes("3"));
	});

	it("should format DAG_CYCLE_DETECTED error with correct icon", () => {
		const error: ValidationError = {
			code: "DAG_CYCLE_DETECTED",
			message: "Transition would create a cycle",
			context: { cyclePath: ["P001", "P002", "P001"] },
		};
		const formatted = formatValidationError(error);
		assert.ok(formatted.includes("🔄"));
		assert.ok(formatted.includes("[DAG_CYCLE_DETECTED]"));
	});

	it("should format LEASE_CONFLICT error with correct icon", () => {
		const error: ValidationError = {
			code: "LEASE_CONFLICT",
			message: "Proposal is leased by 'agent-a', not 'agent-b'",
			context: { currentLeaseHolder: "agent-a", requestingAgent: "agent-b" },
		};
		const formatted = formatValidationError(error);
		assert.ok(formatted.includes("🔒"));
		assert.ok(formatted.includes("[LEASE_CONFLICT]"));
		assert.ok(formatted.includes("agent-a"));
	});

	it("should format ROLE_VIOLATION error with correct icon", () => {
		const error: ValidationError = {
			code: "ROLE_VIOLATION",
			message: "Agent lacks required role",
			context: { requiredRoles: ["coordinator"], agentRoles: ["builder"] },
		};
		const formatted = formatValidationError(error);
		assert.ok(formatted.includes("⛔"));
		assert.ok(formatted.includes("[ROLE_VIOLATION]"));
	});
});

describe("proposal-integrity: ErrorCode types", () => {
	it("should have all 6 error codes defined", () => {
		const validCodes: ErrorCode[] = [
			"INVALID_TRANSITION",
			"MATURITY_GATE_BLOCKED",
			"AC_GATE_FAILED",
			"DAG_CYCLE_DETECTED",
			"LEASE_CONFLICT",
			"ROLE_VIOLATION",
		];
		// Type check — all codes should compile
		for (const code of validCodes) {
			assert.ok(typeof code === "string");
			assert.ok(code.length > 0);
		}
	});
});

describe("proposal-integrity: ValidationError structure", () => {
	it("should have code, message, and optional context", () => {
		const error: ValidationError = {
			code: "INVALID_TRANSITION",
			message: "test",
		};
		assert.strictEqual(error.code, "INVALID_TRANSITION");
		assert.strictEqual(error.message, "test");
		assert.strictEqual(error.context, undefined);
	});

	it("should include context when provided", () => {
		const error: ValidationError = {
			code: "AC_GATE_FAILED",
			message: "test",
			context: { blockingItemNumbers: [1, 2] },
		};
		assert.deepStrictEqual(error.context?.blockingItemNumbers, [1, 2]);
	});
});
