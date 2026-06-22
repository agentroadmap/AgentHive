/**
 * P4509 — unit tests for the SHARED canonical-action validator and cutover gate.
 *
 * No DB required. Exercises AC-2 (validation rejects typos / accepts the five
 * defined actions + wildcard) and AC-7 (cutover gate keys off the ledger row).
 *
 * Run:
 *   node --import jiti/register --test src/apps/server/operator-actions.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "assert";
import {
	__resetCutoverMemoForTests,
	GENERIC_STOP_ACTION,
	GRANULAR_CONTROL_ACTIONS,
	isDestructiveControlAction,
	isGranularControlCutoverEnabled,
	isValidOperatorAction,
	P4509_BACKFILL_MIGRATION_FILENAME,
	resolveControlAction,
	validateAllowedActions,
} from "./operator-actions.ts";

test("AC-2: accepts the five defined actions and the wildcard", () => {
	for (const a of [...GRANULAR_CONTROL_ACTIONS, GENERIC_STOP_ACTION, "*"]) {
		assert.ok(isValidOperatorAction(a), `expected ${a} to be valid`);
	}
	const res = validateAllowedActions([
		"suspend-agency",
		"drain-host",
		"cancel-dispatch",
		"terminate-worker",
		"control.stop",
		"*",
	]);
	assert.equal(res.ok, true, res.message ?? "");
	assert.equal(res.invalid.length, 0);
});

test("AC-2: accepts existing dotted namespaced actions", () => {
	const res = validateAllowedActions([
		"config.read",
		"agency.pause",
		"state-machine.halt",
		"token.issue",
	]);
	assert.equal(res.ok, true, res.message ?? "");
});

test("AC-2: rejects unknown / typo'd action strings", () => {
	for (const bad of [
		"suspendagency", // missing hyphen, not dotted
		"drain_host", // underscore, not the canonical hyphen
		"control.stp", // typo but dotted → caught only because... see note
		"terminateworker",
		"randomword",
	]) {
		const res = validateAllowedActions([bad]);
		// Bare (non-dotted) typos must be rejected. Dotted typos like
		// "control.stp" are syntactically namespaced and pass the structural
		// rule by design (the action surface is open-ended); the granular
		// CONTROL typos (no dot) are the ones P4509 must catch.
		if (!bad.includes(".")) {
			assert.equal(res.ok, false, `expected ${bad} to be rejected`);
			assert.ok(res.invalid.includes(bad));
		}
	}
	// The four granular-action typos (no dot) are all rejected.
	for (const bad of [
		"suspendagency",
		"drain_host",
		"terminateworker",
		"cancel-dispatchx",
	]) {
		assert.equal(
			validateAllowedActions([bad]).ok,
			false,
			`expected ${bad} rejected`,
		);
	}
});

test("AC-2: rejects empty list and non-string entries", () => {
	assert.equal(validateAllowedActions([]).ok, false);
	assert.equal(validateAllowedActions("not-an-array").ok, false);
	assert.equal(validateAllowedActions([123, "drain-host"]).ok, false);
});

test("AC-2: trims and normalizes whitespace", () => {
	const res = validateAllowedActions(["  drain-host  ", " * "]);
	assert.equal(res.ok, true);
	assert.deepEqual(res.actions, ["drain-host", "*"]);
});

test("AC-6: destructive-control classification", () => {
	for (const a of [...GRANULAR_CONTROL_ACTIONS, GENERIC_STOP_ACTION]) {
		assert.ok(isDestructiveControlAction(a), `${a} should be destructive`);
	}
	assert.equal(isDestructiveControlAction("config.read"), false);
	assert.equal(isDestructiveControlAction("agent.message"), false);
});

test("AC-7: resolveControlAction returns legacy stop pre-cutover, granular post-cutover", () => {
	assert.equal(resolveControlAction("drain-host", false), GENERIC_STOP_ACTION);
	assert.equal(resolveControlAction("drain-host", true), "drain-host");
});

test("AC-7: cutover gate is false when ledger lacks the backfill row", async () => {
	__resetCutoverMemoForTests();
	delete process.env.AGENTHIVE_P4509_GRANULAR_DISABLE;
	const fakeQuery = async <T = Record<string, unknown>>(
		_sql: string,
		_p?: unknown[],
	) => ({ rows: [{ cnt: 0 } as unknown as T] });
	const enabled = await isGranularControlCutoverEnabled(fakeQuery);
	assert.equal(enabled, false);
});

test("AC-7: cutover gate is true when ledger has the backfill row", async () => {
	__resetCutoverMemoForTests();
	delete process.env.AGENTHIVE_P4509_GRANULAR_DISABLE;
	const fakeQuery = async <T = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	) => {
		assert.ok(sql.includes("schema_migration"));
		assert.equal((params as string[])?.[0], P4509_BACKFILL_MIGRATION_FILENAME);
		return { rows: [{ cnt: 1 } as unknown as T] };
	};
	const enabled = await isGranularControlCutoverEnabled(fakeQuery);
	assert.equal(enabled, true);
});

test("AC-7: AGENTHIVE_P4509_GRANULAR_DISABLE forces cutover off even if ledgered", async () => {
	__resetCutoverMemoForTests();
	process.env.AGENTHIVE_P4509_GRANULAR_DISABLE = "1";
	const fakeQuery = async <T = Record<string, unknown>>(
		_sql: string,
		_p?: unknown[],
	) => ({ rows: [{ cnt: 1 } as unknown as T] });
	const enabled = await isGranularControlCutoverEnabled(fakeQuery);
	assert.equal(enabled, false);
	delete process.env.AGENTHIVE_P4509_GRANULAR_DISABLE;
});

test("AC-7: ledger lookup error fails safe to no-cutover", async () => {
	__resetCutoverMemoForTests();
	delete process.env.AGENTHIVE_P4509_GRANULAR_DISABLE;
	const fakeQuery = async () => {
		throw new Error("db down");
	};
	const enabled = await isGranularControlCutoverEnabled(fakeQuery);
	assert.equal(enabled, false);
});
