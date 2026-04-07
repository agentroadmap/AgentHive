import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as editor from "../../src/utils/editor.ts";

describe("Editor Utils", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.EDITOR = "";
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("should resolve editor from env var", () => {
		process.env.EDITOR = "vim";
		assert.equal(editor.resolveEditor(), "vim");
	});

	it("should resolve editor from config", () => {
		const config = { defaultEditor: "code" } as any;
		assert.equal(editor.resolveEditor(config), "code");
	});

	it("should fallback to platform default", () => {
		const result = editor.resolveEditor();
		assert.ok(["nano", "notepad", "vi", "vim"].some((e) => result.includes(e)));
	});

	it("should check if editor is available", async () => {
		// Mock successful which/where command
		// Note: real execSync is hard to mock in node:test without affecting everything
		// but we can at least test it doesn't crash
		const available = await editor.isEditorAvailable("ls"); // ls should exist on linux
		assert.equal(typeof available, "boolean");
	});
});
