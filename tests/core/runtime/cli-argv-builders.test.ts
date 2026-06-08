import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildAntigravityArgs,
	defaultBrandFor,
} from "../../../src/core/runtime/cli-argv-builders.ts";

describe("buildAntigravityArgs", () => {
	it("returns exactly the expected arguments for a given prompt, model, and addDir", () => {
		const prompt = "summarize the codebase";
		const model = "Gemini 3.5 Flash (Medium)";
		const addDir = "/data/code/worktree/antigravity";
		const argv = buildAntigravityArgs(prompt, model, addDir);

		assert.deepEqual(argv, [
			"-p",
			prompt,
			"--model",
			model,
			"--dangerously-skip-permissions",
			"--add-dir",
			addDir,
		]);
	});
});

describe("defaultBrandFor", () => {
	it("returns Antigravity for antigravity provider", () => {
		assert.equal(defaultBrandFor("antigravity"), "Antigravity");
	});
});
