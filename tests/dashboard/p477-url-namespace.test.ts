/**
 * P477 AC-7 / AC-11: URL-namespace + project-derivation contract tests.
 *
 * Run: node --import jiti/register --test tests/dashboard/p477-url-namespace.test.ts
 *
 * The dashboard-web app uses wouter for routing. The two pure functions tested
 * here encode the AC-7 contract:
 *   - parseProjectId: derives a validated numeric projectId from the
 *     `/project/:projectId/*` route param (used by useProject()).
 *   - legacyRedirectTarget: the legacy-flat → `/project/1/<section>` redirect
 *     table that backs the <Redirect> routes in App.tsx.
 *
 * NOTE: full wouter render tests live as .tsx and require the vitest/jsdom path,
 * which is not wired into `npm test` (node --test + jiti cannot parse the
 * `import type` syntax in .tsx — the existing tests/e2e/*.tsx fail the same way).
 * The render-level behavior is verified via the build + manual steps documented
 * in the deliverable. These pure tests guard the routing logic in CI.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	DEFAULT_PROJECT_ID,
	LEGACY_PROJECT_ROUTES,
	legacyRedirectTarget,
	parseProjectId,
} from "../../src/apps/dashboard-web/hooks/useProject.ts";

// ─── parseProjectId ──────────────────────────────────────────────────────────

describe("parseProjectId (P477 AC-7 :projectId derivation)", () => {
	it("parses a positive integer string", () => {
		assert.equal(parseProjectId("1"), 1);
		assert.equal(parseProjectId("2"), 2);
		assert.equal(parseProjectId("42"), 42);
	});

	it("returns null for missing param (not on a /project/:id route)", () => {
		assert.equal(parseProjectId(undefined), null);
		assert.equal(parseProjectId(null), null);
		assert.equal(parseProjectId(""), null);
	});

	it("rejects non-numeric, negative, zero, decimal, and trailing junk", () => {
		assert.equal(parseProjectId("abc"), null);
		assert.equal(parseProjectId("-1"), null);
		assert.equal(parseProjectId("0"), null);
		assert.equal(parseProjectId("1.5"), null);
		assert.equal(parseProjectId("2x"), null);
		assert.equal(parseProjectId(" 3"), null);
	});
});

// ─── legacyRedirectTarget ─────────────────────────────────────────────────────

describe("legacyRedirectTarget (P477 AC-7 back-compat redirects)", () => {
	it("maps every legacy project route to /project/1/<section>", () => {
		assert.ok(LEGACY_PROJECT_ROUTES.length >= 6, "expected the 6 legacy sections");
		for (const section of LEGACY_PROJECT_ROUTES) {
			assert.equal(
				legacyRedirectTarget(`/${section}`),
				`/project/${DEFAULT_PROJECT_ID}/${section}`,
			);
		}
	});

	it("DEFAULT_PROJECT_ID is 1", () => {
		assert.equal(DEFAULT_PROJECT_ID, 1);
		assert.equal(legacyRedirectTarget("/board"), "/project/1/board");
		assert.equal(legacyRedirectTarget("/proposals"), "/project/1/proposals");
	});

	it("does NOT redirect control-plane root sections (stay cross-project)", () => {
		for (const cp of ["/", "/fleet", "/efficiency", "/identity", "/platform"]) {
			assert.equal(legacyRedirectTarget(cp), null);
		}
	});

	it("returns null for unknown paths", () => {
		assert.equal(legacyRedirectTarget("/teams"), null);
		assert.equal(legacyRedirectTarget("/nonexistent"), null);
	});

	it("tolerates trailing/leading slashes on the input path", () => {
		assert.equal(legacyRedirectTarget("/board/"), "/project/1/board");
		assert.equal(legacyRedirectTarget("board"), "/project/1/board");
	});

	it("honors a custom default project id", () => {
		assert.equal(legacyRedirectTarget("/board", 7), "/project/7/board");
	});
});
