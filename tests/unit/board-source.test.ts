import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveBoardDataSource } from "../../src/apps/board-source.ts";

describe("resolveBoardDataSource", () => {
	it("uses Postgres when source is auto and config selects Postgres", () => {
		assert.equal(
			resolveBoardDataSource("auto", {
				database: { provider: "Postgres" },
			} as any),
			"postgres",
		);
	});

	it("uses file when source is auto and config does not select Postgres", () => {
		assert.equal(resolveBoardDataSource("auto", null), "file");
		assert.equal(resolveBoardDataSource(undefined, {}), "file");
	});

	it("honors explicit source values", () => {
		assert.equal(
			resolveBoardDataSource("file", {
				database: { provider: "Postgres" },
			} as any),
			"file",
		);
		assert.equal(resolveBoardDataSource("postgres", null), "postgres");
	});

	it("rejects invalid source values", () => {
		assert.throws(
			() => resolveBoardDataSource("sqlite", null),
			/Invalid board source/,
		);
	});
});
