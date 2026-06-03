/**
 * Tests for postWorkOffer's backpressure cap (BackpressureError).
 *
 * Pure-mocked: no DB. Verifies the queueFn invocation pattern and that the
 * cap fires before the proposal lookup so a full queue rejects cheaply.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
	BackpressureError,
	postWorkOffer,
	type QueryFn,
} from "./post-work-offer.ts";

interface RecordingQuery {
	calls: Array<{ sql: string; params: unknown[] }>;
	queue: QueryFn;
}

function makeQuery(
	scriptedRows: Array<Array<Record<string, unknown>>> = [],
): RecordingQuery {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	let i = 0;
	const queue: QueryFn = (async (sql: string, params?: unknown[]) => {
		calls.push({ sql, params: params ?? [] });
		const rows = scriptedRows[i++] ?? [];
		return { rows } as never;
	}) as never;
	return { calls, queue };
}

test("postWorkOffer: backpressure throws BackpressureError when in-flight count >= cap", async () => {
	process.env.AGENTHIVE_MAX_INFLIGHT_OFFERS = "20";
	// First (and only) query the function should make is the in-flight count;
	// a full queue should short-circuit before any other DB interaction.
	const { calls, queue } = makeQuery([[{ count: 20 }]]);

	await assert.rejects(
		() =>
			postWorkOffer(
				{
					proposalId: 999,
					squadName: "P999-test",
					role: "developer",
					task: "anything",
				},
				queue,
			),
		(err: unknown) => {
			assert.ok(err instanceof BackpressureError);
			assert.equal((err as BackpressureError).inflight, 20);
			assert.equal((err as BackpressureError).cap, 20);
			return true;
		},
	);

	assert.equal(
		calls.length,
		1,
		"backpressure must short-circuit before the proposal-state lookup",
	);
	assert.match(calls[0].sql, /squad_dispatch[\s\S]*offer_status/);
});

test("postWorkOffer: in-flight below cap proceeds to proposal lookup", async () => {
	process.env.AGENTHIVE_MAX_INFLIGHT_OFFERS = "20";
	// (1) inflight count, (2) proposal context (we'll throw on the next step
	// to confirm we got past the cap without exercising the full insert path)
	const { calls, queue } = makeQuery([
		[{ count: 5 }],
		[], // empty proposal context → triggers "proposal not found" error
	]);

	await assert.rejects(
		() =>
			postWorkOffer(
				{
					proposalId: 12345,
					squadName: "P12345-test",
					role: "developer",
					task: "anything",
				},
				queue,
			),
		/proposal 12345 not found/,
	);

	// Two queries: in-flight count, then proposal-state lookup. The cap did
	// NOT short-circuit because 5 < 20.
	assert.equal(calls.length, 2);
	assert.match(calls[0].sql, /squad_dispatch[\s\S]*offer_status/);
	assert.match(calls[1].sql, /FROM roadmap_proposal\.proposal/);
});

test("postWorkOffer: in-flight count of zero proceeds to proposal lookup", async () => {
	const { calls, queue } = makeQuery([
		[{ count: 0 }],
		[], // empty proposal context → "not found" error
	]);

	await assert.rejects(
		() =>
			postWorkOffer(
				{
					proposalId: 7,
					squadName: "P7",
					role: "developer",
					task: "anything",
				},
				queue,
			),
		/proposal 7 not found/,
	);

	assert.equal(calls.length, 2);
	assert.match(calls[0].sql, /squad_dispatch[\s\S]*offer_status/);
});

test("postWorkOffer: gate_scanner_paused proposal is refused before dispatch insert", async () => {
	const { calls, queue } = makeQuery([
		[{ count: 0 }],
		[
			{
				project_id: 1,
				status: "DRAFT",
				maturity: "new",
				gate_scanner_paused: true,
			},
		],
	]);

	await assert.rejects(
		() =>
			postWorkOffer(
				{
					proposalId: 1411,
					squadName: "P1411-test",
					role: "developer",
					task: "anything",
				},
				queue,
			),
		/gate_scanner_paused; dispatch refused/,
	);

	assert.equal(calls.length, 2);
	assert.match(calls[1].sql, /gate_scanner_paused/);
	assert.equal(
		calls.some((call) =>
			/INSERT INTO roadmap_workforce\.squad_dispatch/.test(call.sql),
		),
		false,
	);
});
