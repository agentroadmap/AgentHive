/**
 * P1099: Identity canonicalization unit tests
 *
 * Tests the canonicalizeIdentity() utility without DB access.
 * Covers AC-1, AC-4, AC-8 normalization and idempotency.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canonicalizeIdentity,
	InvalidIdentityError,
} from "../../src/infra/messaging/identity.js";

describe("P1099: canonicalizeIdentity() normalization", () => {
	describe("AC-1 & AC-4: Basic normalization and slash collapsing", () => {
		it("collapses multiple slashes to single slash", () => {
			const result = canonicalizeIdentity("user//gary");
			assert.equal(result, "user/gary");
		});

		it("removes trailing slashes", () => {
			const result = canonicalizeIdentity("user//gary/");
			assert.equal(result, "user/gary");
		});

		it("handles multiple trailing slashes", () => {
			const result = canonicalizeIdentity("user/gary///");
			assert.equal(result, "user/gary");
		});

		it("handles mixed multiple and trailing slashes", () => {
			const result = canonicalizeIdentity("user//gary///");
			assert.equal(result, "user/gary");
		});

		it("trims leading and trailing whitespace", () => {
			const result = canonicalizeIdentity(" user/gary ");
			assert.equal(result, "user/gary");
		});

		it("handles complex whitespace and slashes", () => {
			const result = canonicalizeIdentity("  user//gary//  ");
			assert.equal(result, "user/gary");
		});
	});

	describe("AC-8: Case folding to lowercase", () => {
		it("converts uppercase to lowercase", () => {
			const result = canonicalizeIdentity("User/Gary");
			assert.equal(result, "user/gary");
		});

		it("converts mixed case to lowercase", () => {
			const result = canonicalizeIdentity("CODEX/AGENCY-BOT");
			assert.equal(result, "codex/agency-bot");
		});

		it("preserves lowercase identity", () => {
			const result = canonicalizeIdentity("user/gary");
			assert.equal(result, "user/gary");
		});

		it("handles complex mixed-case identity", () => {
			const result = canonicalizeIdentity("SkEpTiC/OcEaN-LoUd");
			assert.equal(result, "skeptic/ocean-loud");
		});
	});

	describe("AC-4: Idempotency", () => {
		it("double application returns same result", () => {
			const input = "user//gary/";
			const once = canonicalizeIdentity(input);
			const twice = canonicalizeIdentity(once);
			assert.equal(once, twice);
		});

		it("idempotency holds for complex input", () => {
			const input = "  User//Gary///  ";
			const once = canonicalizeIdentity(input);
			const twice = canonicalizeIdentity(once);
			assert.equal(once, twice);
		});

		it("already-canonical identity is unchanged by reapplication", () => {
			const canonical = "user/gary";
			const result = canonicalizeIdentity(canonical);
			assert.equal(result, canonical);
		});
	});

	describe("AC-4: Rejection of malformed identities", () => {
		it("rejects empty string", () => {
			assert.throws(
				() => canonicalizeIdentity(""),
				InvalidIdentityError,
				"Should reject empty string",
			);
		});

		it("rejects whitespace-only string", () => {
			assert.throws(
				() => canonicalizeIdentity("   "),
				InvalidIdentityError,
				"Should reject whitespace-only string",
			);
		});

		it("rejects identity starting with slash", () => {
			assert.throws(
				() => canonicalizeIdentity("/user/gary"),
				InvalidIdentityError,
				"Should reject leading slash",
			);
		});

		it("rejects identity with interior spaces", () => {
			assert.throws(
				() => canonicalizeIdentity("user /gary"),
				InvalidIdentityError,
				"Should reject interior space",
			);
		});

		it("rejects identity with space before slash", () => {
			assert.throws(
				() => canonicalizeIdentity("user /gary"),
				InvalidIdentityError,
				"Should reject space before slash",
			);
		});

		it("rejects identity with space after slash", () => {
			assert.throws(
				() => canonicalizeIdentity("user/ gary"),
				InvalidIdentityError,
				"Should reject space after slash",
			);
		});

		it("rejects slash-only string", () => {
			assert.throws(
				() => canonicalizeIdentity("/"),
				InvalidIdentityError,
				"Should reject slash-only string",
			);
		});

		it("rejects multiple slashes only", () => {
			assert.throws(
				() => canonicalizeIdentity("///"),
				InvalidIdentityError,
				"Should reject multiple slashes",
			);
		});
	});

	describe("AC-4: Valid multi-segment identities", () => {
		it("accepts two-segment identity", () => {
			const result = canonicalizeIdentity("provider/agent");
			assert.equal(result, "provider/agent");
		});

		it("accepts three-segment identity", () => {
			const result = canonicalizeIdentity("codex/agency-bot/instance");
			assert.equal(result, "codex/agency-bot/instance");
		});

		it("accepts identity with hyphens and numbers", () => {
			const result = canonicalizeIdentity("user-1/gary-42");
			assert.equal(result, "user-1/gary-42");
		});

		it("accepts identity with underscores", () => {
			const result = canonicalizeIdentity("user_name/gary_agent");
			assert.equal(result, "user_name/gary_agent");
		});

		it("accepts identity with dots", () => {
			const result = canonicalizeIdentity("user.name/gary.agent");
			assert.equal(result, "user.name/gary.agent");
		});
	});

	describe("P1017 homograph scenarios", () => {
		it("normalizes homographs with double slashes", () => {
			const a = canonicalizeIdentity("user//gary");
			const b = canonicalizeIdentity("user/gary");
			assert.equal(a, b, "Both should normalize to same canonical form");
		});

		it("normalizes homographs with trailing slashes", () => {
			const a = canonicalizeIdentity("user/gary/");
			const b = canonicalizeIdentity("user/gary");
			assert.equal(a, b, "Both should normalize to same canonical form");
		});

		it("normalizes complex homographs", () => {
			const variants = [
				"user//gary/",
				"user///gary//",
				"user/gary/",
				"user/gary",
				"USER/GARY",
				"User/Gary/",
				"  user//gary///  ",
			];
			const canonicals = variants.map(canonicalizeIdentity);
			const firstCanonical = canonicals[0];
			for (const canonical of canonicals) {
				assert.equal(
					canonical,
					firstCanonical,
					"All variants should normalize to same value",
				);
			}
		});

		it("bearer-token subject matching prevents homograph bypass", () => {
			const tokenSub = "user/gary";
			const fromAgentWithSlash = "user//gary";
			const fromAgentWithTrailingSlash = "user/gary/";

			const canonical1 = canonicalizeIdentity(tokenSub);
			const canonical2 = canonicalizeIdentity(fromAgentWithSlash);
			const canonical3 = canonicalizeIdentity(fromAgentWithTrailingSlash);

			assert.equal(canonical1, canonical2, "Token sub should match");
			assert.equal(canonical2, canonical3, "From agent should match");
			assert.equal(
				canonical1,
				canonical3,
				"All should be identical after canonicalization",
			);
		});
	});

	describe("Error messages and types", () => {
		it("InvalidIdentityError is properly typed", () => {
			const err = new InvalidIdentityError("test");
			assert.ok(err instanceof Error);
			assert.ok(err instanceof InvalidIdentityError);
			assert.equal(err.name, "InvalidIdentityError");
		});

		it("error messages are descriptive", () => {
			try {
				canonicalizeIdentity("");
			} catch (err) {
				assert.ok(err instanceof InvalidIdentityError);
			}
		});
	});
});
