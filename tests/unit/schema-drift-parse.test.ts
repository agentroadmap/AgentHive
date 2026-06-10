import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	dedupeHits,
	extractDriftHits,
	fingerprintHit,
	normalizeQueryFragment,
} from "../../src/core/schema-drift/parse.ts";

describe("extractDriftHits", () => {
	it("catches a 42703 column-missing line", () => {
		const log = `Apr 27 23:22:01 bot node[1663194]: Error listing routes: error: column "cost_per_1k_input" does not exist`;
		const hits = extractDriftHits(log);
		assert.equal(hits.length, 1);
		assert.equal(hits[0].errorCode, "42703");
		assert.equal(hits[0].missingName, "cost_per_1k_input");
	});

	it("catches a 42P01 relation-missing line", () => {
		const log = `Apr 27 23:30:00 bot node[1234]: relation "control_plane.operator_audit_log" does not exist`;
		const hits = extractDriftHits(log);
		assert.equal(hits.length, 1);
		assert.equal(hits[0].errorCode, "42P01");
		assert.equal(hits[0].missingName, "control_plane.operator_audit_log");
	});

	it("returns empty for unrelated logs", () => {
		const log = `[WS] Snapshot sent successfully\nGate D3 held P594. Target transition: DEVELOP -> Merge`;
		assert.deepEqual(extractDriftHits(log), []);
	});

	it("captures multiple distinct hits in one window", () => {
		const log = [
			`error: column "cost_per_1k_input" does not exist`,
			`error: relation "old_table" does not exist`,
			`error: column "missing_two" does not exist`,
		].join("\n");
		const hits = extractDriftHits(log);
		assert.equal(hits.length, 3);
		assert.deepEqual(
			hits.map((h) => h.missingName).sort(),
			["cost_per_1k_input", "missing_two", "old_table"],
		);
	});

	it("extracts a query excerpt when present on the same line", () => {
		const log = `Error listing routes: SELECT id, cost_per_1k_input FROM roadmap.model_routes WHERE id = $1 — column "cost_per_1k_input" does not exist`;
		const hits = extractDriftHits(log);
		assert.equal(hits.length, 1);
		assert.ok(hits[0].queryExcerpt, "expected a query excerpt");
		assert.match(hits[0].queryExcerpt!, /SELECT/i);
	});
});

describe("normalizeQueryFragment", () => {
	it("collapses whitespace and replaces literals", () => {
		const q = "SELECT  id, name FROM roadmap.model_routes WHERE id = 42 AND model = 'claude'";
		const n = normalizeQueryFragment(q);
		assert.match(n, /SELECT id, name FROM roadmap.model_routes WHERE id = \?/);
		assert.match(n, /model = \?/);
	});

	it("normalizes positional params", () => {
		const q = "SELECT * FROM proposal WHERE id = $1 AND status = $2";
		assert.equal(
			normalizeQueryFragment(q),
			"SELECT * FROM proposal WHERE id = ? AND status = ?",
		);
	});
});

describe("fingerprintHit + dedupe", () => {
	it("identical hits dedupe to one fingerprint", () => {
		const log = [
			`error: column "x" does not exist`,
			`error: column "x" does not exist`,
			`error: column "x" does not exist`,
		].join("\n");
		const hits = extractDriftHits(log);
		assert.equal(hits.length, 3);
		const deduped = dedupeHits(hits);
		assert.equal(deduped.length, 1);
	});

	it("same column under different queries produces distinct fingerprints", () => {
		const a = {
			errorCode: "42703" as const,
			missingName: "cost_per_1k_input",
			queryExcerpt: "SELECT cost_per_1k_input FROM model_routes",
			rawLine: "",
		};
		const b = {
			errorCode: "42703" as const,
			missingName: "cost_per_1k_input",
			queryExcerpt: "SELECT cost_per_1k_input FROM model_metadata",
			rawLine: "",
		};
		assert.notEqual(fingerprintHit(a), fingerprintHit(b));
	});

	it("dedupes within a single scrape but preserves order", () => {
		const hits = [
			{ errorCode: "42703" as const, missingName: "a", queryExcerpt: "Q1", rawLine: "" },
			{ errorCode: "42703" as const, missingName: "b", queryExcerpt: "Q2", rawLine: "" },
			{ errorCode: "42703" as const, missingName: "a", queryExcerpt: "Q1", rawLine: "" },
		];
		const out = dedupeHits(hits);
		assert.equal(out.length, 2);
		assert.equal(out[0].missingName, "a");
		assert.equal(out[1].missingName, "b");
	});
});
