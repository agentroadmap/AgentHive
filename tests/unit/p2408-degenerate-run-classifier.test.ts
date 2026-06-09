import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyProviderSignal } from "../../src/core/orchestration/provider-cooldown.ts";

/**
 * P2408: the a2a-host mechanical floor used to treat any exit-0 worker run as a
 * `delivered` offer. An unauthenticated `agy` worker prints a login prompt and
 * exits 0 having done no work — a silent offer-sink that fakes deliveries and
 * starves healthy agencies. classifyProviderSignal must now surface that auth
 * failure as `auth_required` so the handler can mark the run failed and cool the
 * provider down, instead of mislabelling it a transient rate/credit issue.
 */
describe("P2408 degenerate-run classifier (auth_required)", () => {
	it("classifies the live antigravity auth-fail string as auth_required", () => {
		const out =
			"Authentication required. Please visit the URL to log in: https://acc.example/auth?x=1";
		assert.equal(classifyProviderSignal(out), "auth_required");
	});

	it("detects common not-logged-in variants", () => {
		for (const sample of [
			"Error: you are not logged in. Run `agy login` to continue.",
			"login required",
			"Not authenticated — please sign in.",
			"please run agy login",
		]) {
			assert.equal(
				classifyProviderSignal(sample),
				"auth_required",
				`expected auth_required for: ${sample}`,
			);
		}
	});

	it("prefers auth_required over credit when both words appear", () => {
		// An unauthenticated CLI often also prints incidental 'usage'/'limit'
		// wording; auth must win so we apply the 30-min config-fault backoff,
		// not a 2-min transient one.
		const out =
			"Authentication required. Please log in. (note: usage limit info unavailable)";
		assert.equal(classifyProviderSignal(out), "auth_required");
	});

	it("still classifies genuine rate-limit and credit signals", () => {
		assert.equal(classifyProviderSignal("HTTP 429 too many requests"), "rate_limit");
		assert.equal(classifyProviderSignal("insufficient funds / billing"), "credit_exhausted");
	});

	it("returns null for healthy worker output (no false positives)", () => {
		for (const sample of [
			"Done. Implemented AC-1 and AC-2, all tests pass.",
			"Reviewed the diff; LGTM with one nit on naming.",
			"",
		]) {
			assert.equal(
				classifyProviderSignal(sample),
				null,
				`expected null for: ${JSON.stringify(sample)}`,
			);
		}
	});
});
