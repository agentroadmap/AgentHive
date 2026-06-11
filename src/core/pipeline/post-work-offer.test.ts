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
	TerminalProposalError,
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
		const rows = i < scriptedRows.length ? scriptedRows[i] : [];
		i++;
		return { rows } as never;
	}) as never;
	return { calls, queue };
}

test("postWorkOffer: backpressure throws BackpressureError when in-flight count >= cap", async () => {
	process.env.AGENTHIVE_MAX_INFLIGHT_OFFERS = "20";
	// Order: (1) pause check (empty), (2) backpressure check (full), should throw before proposal lookup.
	const { calls, queue } = makeQuery([
		[], // pause check: empty (no pauses)
		[{ count: 20 }], // backpressure check: at cap
	]);

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
		BackpressureError,
	);

	assert.equal(
		calls.length,
		2,
		"backpressure must short-circuit before the proposal-state lookup",
	);
	assert.match(calls[1].sql, /squad_dispatch[\s\S]*offer_status/);
});

test("postWorkOffer: in-flight below cap proceeds to proposal lookup", async () => {
	process.env.AGENTHIVE_MAX_INFLIGHT_OFFERS = "20";
	// Order: (1) pause check, (2) backpressure check (under cap), (3) proposal lookup (not found).
	const { calls, queue } = makeQuery([
		[], // pause check: empty
		[{ count: 5 }], // backpressure check: under cap (5 < 20)
		[], // proposal lookup: empty → "not found"
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

	assert.equal(calls.length, 3, "expected pause check, backpressure check, and proposal lookup");
	assert.match(calls[1].sql, /squad_dispatch[\s\S]*offer_status/);
});

test("postWorkOffer: in-flight count of zero proceeds to proposal lookup", async () => {
	// Order: (1) pause check, (2) backpressure check (zero), (3) proposal lookup (not found).
	const { calls, queue } = makeQuery([
		[], // pause check: empty
		[{ count: 0 }], // backpressure check: zero in-flight
		[], // proposal lookup: empty → "not found" error
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

	assert.equal(calls.length, 3);
	assert.match(calls[1].sql, /squad_dispatch[\s\S]*offer_status/);
});

test("postWorkOffer: gate_scanner_paused proposal is refused before dispatch insert", async () => {
	// Order: (1) pause check, (2) backpressure check, (3) proposal lookup.
	const { calls, queue } = makeQuery([
		[], // pause check: empty
		[{ count: 0 }], // backpressure check: ok
		[
			{
				project_id: 1,
				status: "DRAFT",
				maturity: "new",
				gate_scanner_paused: true,
				gate_paused_by: "operator",
				gate_paused_at: "2026-06-09T12:00:00Z",
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
		/gate_scanner_paused/,
	);

	assert.equal(calls.length, 3, "expected pause check, backpressure check, and proposal lookup");
	assert.equal(
		calls.some((call) =>
			/INSERT INTO roadmap_workforce\.squad_dispatch/.test(call.sql),
		),
		false,
		"gate_scanner_paused guard must prevent INSERT",
	);
});

test("postWorkOffer: COMPLETE proposal is refused before dispatch insert (terminal status guard)", async () => {
	// Order: (1) pause check, (2) backpressure check, (3) proposal lookup.
	// The terminal status guard triggers on the proposal context, before INSERT.
	const { calls, queue } = makeQuery([
		[], // pause check: empty
		[{ count: 0 }], // backpressure check: ok
		[
			{
				project_id: 1,
				status: "COMPLETE",
				maturity: "new",
				gate_scanner_paused: false,
				gate_paused_by: null,
				gate_paused_at: null,
			},
		],
	]);

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
		TerminalProposalError,
	);

	assert.equal(calls.length, 3, "expected pause check, backpressure check, and proposal lookup");
	assert.equal(
		calls.some((call) =>
			/INSERT INTO roadmap_workforce\.squad_dispatch/.test(call.sql),
		),
		false,
		"terminal status guard must prevent INSERT",
	);
});
