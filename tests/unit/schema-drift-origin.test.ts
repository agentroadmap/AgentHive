import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { traceOrigin } from "../../src/core/schema-drift/origin.ts";

describe("traceOrigin", () => {
	it("extracts P-id from git pickaxe commit subject", () => {
		const exec = (cmd: string, args: string[]): string => {
			if (cmd === "git" && args[0] === "log") {
				return [
					"abc1234567890\tfeat(P634): drop cost_per_1k_input from model_routes",
					"def0000000000\tunrelated commit no proposal id",
				].join("\n");
			}
			throw new Error(`unexpected exec: ${cmd}`);
		};

		const guess = traceOrigin("cost_per_1k_input", { repoRoot: "/tmp/repo", exec });
		assert.equal(guess.proposalDisplayId, "P634");
		assert.equal(guess.proposalNumericId, 634);
		assert.equal(guess.commitSha, "abc1234567890");
		assert.equal(guess.source, "git_pickaxe");
	});

	it("returns a commit SHA when pickaxe matches but has no P-id", () => {
		const exec = (cmd: string, args: string[]): string => {
			if (cmd === "git") {
				return "deadbeef\trefactor: move things around";
			}
			throw new Error(`unexpected exec: ${cmd}`);
		};

		const guess = traceOrigin("cost_per_1k_input", { repoRoot: "/tmp/repo", exec });
		// Pickaxe matched a commit but had no P-id in the subject.
		// Still return the commit SHA for reference.
		assert.equal(guess.source, "git_pickaxe");
		assert.equal(guess.proposalDisplayId, null);
		assert.equal(guess.proposalNumericId, null);
		assert.equal(guess.commitSha, "deadbeef");
	});

	it("returns 'none' when neither git nor grep finds anything", () => {
		const exec = (cmd: string): string => {
			if (cmd === "git") return "";
			if (cmd === "grep") return "";
			return "";
		};
		const guess = traceOrigin("nonexistent_column", { repoRoot: "/tmp/repo", exec });
		assert.equal(guess.source, "none");
		assert.equal(guess.proposalDisplayId, null);
		assert.equal(guess.commitSha, null);
	});

	it("survives exec throwing (e.g. git not in PATH)", () => {
		const exec = (): string => {
			throw new Error("ENOENT: git");
		};
		const guess = traceOrigin("anything", { repoRoot: "/tmp/repo", exec });
		assert.equal(guess.source, "none");
	});

	it("handles regex-special characters in the missing name", () => {
		const exec = (cmd: string, args: string[]): string => {
			// Confirm the column name is escaped before being injected into grep -E.
			if (cmd === "grep") {
				const pattern = args.find((a) => a.includes("DROP COLUMN"));
				assert.ok(pattern, "expected a grep pattern arg");
				assert.match(pattern!, /\\\./);
				return "";
			}
			return "";
		};
		traceOrigin("table.col_with_dots", { repoRoot: "/tmp/repo", exec });
	});
});
