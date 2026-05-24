/**
 * P1389 — Parameter fidelity round-trip tests.
 *
 * Each test exercises a write surface with a non-default value
 * and immediately reads back to verify the value was persisted,
 * not silently dropped.
 *
 * Run: node --test tests/integration/p1389-param-fidelity.test.ts
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
	submitReview,
	listReviews,
} from "../../src/apps/mcp-server/tools/rfc/pg-handlers.ts";
import { PgProposalHandlers } from "../../src/apps/mcp-server/tools/proposals/pg-handlers.ts";
import { closePool, initPoolFromConfig } from "../../src/postgres/pool.ts";
import {
	createProposal,
	deleteProposal,
} from "../../src/infra/postgres/proposal-storage-v2.ts";

const TEST_PREFIX = `p1389_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_TYPE = "feature"; // known-valid type with workflow_templates row

let pool: Pool;
let testProposalId: number;
let testDisplayId: string;

function textContent(result: {
	content?: Array<{ type?: string; text?: string }>;
}): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function resolvePgConfig() {
	const password = process.env.PGPASSWORD;
	if (!password) {
		throw new Error("PGPASSWORD required for p1389-param-fidelity tests");
	}
	return {
		host: process.env.PG_HOST ?? "127.0.0.1",
		port: Number(process.env.PG_PORT ?? 5432),
		user: process.env.PG_USER ?? "admin",
		password,
		database: process.env.PG_DATABASE ?? "agenthive",
		options: "-c search_path=roadmap_proposal,roadmap_workforce,roadmap,public",
	};
}

const PG_CONFIG = resolvePgConfig();

before(async () => {
	pool = new Pool(PG_CONFIG);
	initPoolFromConfig({
		host: PG_CONFIG.host,
		port: PG_CONFIG.port,
		user: PG_CONFIG.user,
		password: PG_CONFIG.password,
		name: PG_CONFIG.database,
		schema: "roadmap",
	});

	// Seed a reviewer identity
	await pool.query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role)
		 VALUES ($1, 'llm', 'reviewer')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[`${TEST_PREFIX}_reviewer`],
	);

	const proposal = await createProposal(
		{
			type: TEST_TYPE,
			title: `${TEST_PREFIX} fidelity test proposal`,
			summary: "P1389 round-trip verification",
			design: "Each test writes then reads back a specific param.",
		},
		`${TEST_PREFIX}_agent`,
	);
	testProposalId = proposal.id;
	testDisplayId = proposal.display_id;
});

after(async () => {
	if (testProposalId) {
		await deleteProposal(testProposalId).catch(() => {});
	}
	await pool.query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE $1`,
		[`${TEST_PREFIX}%`],
	);
	await closePool();
	await pool.end();
});

describe("P1389 — param fidelity round-trip", () => {
	describe("submit_review / list_reviews — is_blocking", () => {
		it("persists is_blocking=true and list_reviews shows [BLOCKING]", async () => {
			const reviewer = `${TEST_PREFIX}_reviewer`;

			const submitResult = await submitReview({
				proposal_id: testDisplayId,
				reviewer,
				verdict: "request_changes",
				notes: "Must fix the thing",
				is_blocking: true,
			});
			assert.ok(
				textContent(submitResult).includes("Review submitted"),
				`Expected submit success, got: ${textContent(submitResult)}`,
			);

			const listResult = await listReviews({ proposal_id: testDisplayId });
			const text = textContent(listResult);
			assert.ok(
				text.includes("[BLOCKING]"),
				`Expected [BLOCKING] in list_reviews output, got:\n${text}`,
			);
		});

		it("persists is_blocking=false and list_reviews does NOT show [BLOCKING]", async () => {
			const reviewer = `${TEST_PREFIX}_reviewer`;

			// Update to false (same reviewer, ON CONFLICT updates)
			const submitResult = await submitReview({
				proposal_id: testDisplayId,
				reviewer,
				verdict: "request_changes",
				notes: "Minor nit",
				is_blocking: false,
			});
			assert.ok(textContent(submitResult).includes("Review submitted"));

			const listResult = await listReviews({ proposal_id: testDisplayId });
			const text = textContent(listResult);
			assert.ok(
				!text.includes("[BLOCKING]"),
				`Expected no [BLOCKING] after is_blocking=false update, got:\n${text}`,
			);
		});
	});

	describe("prop_list — search filter", () => {
		it("returns only proposals whose title contains the search string", async () => {
			const uniqueToken = `UNIQUE_${TEST_PREFIX}`;
			// The fixture proposal title starts with TEST_PREFIX — search for that unique token
			const handlers = new PgProposalHandlers({} as any, "");

			const result = await handlers.listProposals({
				search: uniqueToken,
				include_terminal: true,
			});
			const parsed = JSON.parse(textContent(result));
			assert.ok(
				parsed.returned >= 1,
				`Expected at least 1 hit for search="${uniqueToken}", got ${parsed.returned}`,
			);
			for (const item of parsed.items) {
				assert.ok(
					item.title.toLowerCase().includes(uniqueToken.toLowerCase()),
					`Item title "${item.title}" does not contain "${uniqueToken}"`,
				);
			}
		});

		it("returns zero results for a search that matches nothing", async () => {
			const handlers = new PgProposalHandlers({} as any, "");
			const result = await handlers.listProposals({
				search: "ZZZNOMATCH_XYZ_IMPOSSIBLE_STRING_12345",
				include_terminal: true,
			});
			const parsed = JSON.parse(textContent(result));
			assert.equal(parsed.total, 0, `Expected 0 results, got ${parsed.total}`);
		});
	});

	describe("prop_list — maturity filter", () => {
		it("exact maturity filter returns only proposals at that maturity", async () => {
			const handlers = new PgProposalHandlers({} as any, "");

			// Set our test proposal to 'active' so there's something to find
			await pool.query(
				`UPDATE roadmap_proposal.proposal SET maturity = 'active' WHERE id = $1`,
				[testProposalId],
			);

			const result = await handlers.listProposals({
				maturity: "active",
				include_terminal: true,
			});
			const parsed = JSON.parse(textContent(result));
			assert.ok(
				parsed.returned >= 1,
				`Expected at least 1 active proposal, got ${parsed.returned}`,
			);
			for (const item of parsed.items) {
				assert.equal(
					item.maturity,
					"active",
					`Item ${item.display_id} has maturity="${item.maturity}", expected "active"`,
				);
			}
		});

		it("maturity_min=active excludes new proposals", async () => {
			const handlers = new PgProposalHandlers({} as any, "");

			// Set our test proposal to 'new' so it can be used as a control
			await pool.query(
				`UPDATE roadmap_proposal.proposal SET maturity = 'new' WHERE id = $1`,
				[testProposalId],
			);

			// Confirm the proposal is visible with no maturity filter
			const allResult = await handlers.listProposals({ include_terminal: true });
			const allParsed = JSON.parse(textContent(allResult));
			const allIds = allParsed.items?.map((i: any) => i.id) ?? [];
			assert.ok(
				allIds.includes(testProposalId),
				"Test proposal should appear with no maturity filter",
			);

			// Now filter to maturity_min=active — should exclude our 'new' proposal
			const filteredResult = await handlers.listProposals({
				maturity_min: "active",
				include_terminal: true,
			});
			const filteredParsed = JSON.parse(textContent(filteredResult));
			const filteredIds = filteredParsed.items?.map((i: any) => i.id) ?? [];
			assert.ok(
				!filteredIds.includes(testProposalId),
				`Test proposal (maturity=new) should be excluded from maturity_min=active results`,
			);

			// Reset
			await pool.query(
				`UPDATE roadmap_proposal.proposal SET maturity = 'new' WHERE id = $1`,
				[testProposalId],
			);
		});
	});

	describe("prop_release — release_reason canonical param", () => {
		it("accepts release_reason as canonical parameter", async () => {
			const handlers = new PgProposalHandlers({} as any, "");
			const agent = `${TEST_PREFIX}_release_agent`;

			// Pre-register agent and claim a lease
			await pool.query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role)
				 VALUES ($1, 'llm', 'builder')
				 ON CONFLICT (agent_identity) DO NOTHING`,
				[agent],
			);

			const claimResult = await handlers.claimProposal({
				id: testDisplayId,
				agent,
				durationMinutes: 5,
			});
			assert.ok(
				textContent(claimResult).toLowerCase().includes("lease"),
				`Expected claim success, got: ${textContent(claimResult)}`,
			);

			// Now release using the canonical release_reason param
			const releaseResult = await handlers.releaseProposal({
				id: testDisplayId,
				agent,
				release_reason: "P1389 fidelity test — canonical release_reason param",
			} as any);

			const releaseText = textContent(releaseResult);
			assert.ok(
				releaseText.toLowerCase().includes("released") ||
					releaseText.toLowerCase().includes("lease"),
				`Expected release success, got: ${releaseText}`,
			);
		});
	});
});
