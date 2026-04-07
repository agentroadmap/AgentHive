import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type AgentSelectionValue,
	PLACEHOLDER_AGENT_VALUE,
	processAgentSelection,
} from "../../src/utils/agent-selection.ts";

const AGENTS_MD = "AGENTS.md" as const;
const CLAUDE_MD = "CLAUDE.md" as const;
const GEMINI_MD = "GEMINI.md" as const;

describe("processAgentSelection", () => {
	it("returns explicit selections", () => {
		const result = processAgentSelection({ selected: [AGENTS_MD, CLAUDE_MD] });
		assert.strictEqual(result.needsRetry, false);
		assert.deepStrictEqual(result.files, [AGENTS_MD, CLAUDE_MD]);
		assert.strictEqual(result.skipped, false);
	});

	it("auto-selects highlighted item when none selected and fallback enabled", () => {
		const result = processAgentSelection({
			selected: [],
			highlighted: GEMINI_MD,
			useHighlightFallback: true,
		});
		assert.strictEqual(result.needsRetry, false);
		assert.deepStrictEqual(result.files, [GEMINI_MD]);
		assert.strictEqual(result.skipped, false);
	});

	it("does not auto-select highlight when fallback disabled", () => {
		const result = processAgentSelection({
			selected: [],
			highlighted: CLAUDE_MD,
		});
		assert.strictEqual(result.needsRetry, true);
		assert.deepStrictEqual(result.files, []);
		assert.strictEqual(result.skipped, false);
	});

	it("ignores placeholder highlight even when fallback enabled", () => {
		const result = processAgentSelection({
			selected: [],
			highlighted: PLACEHOLDER_AGENT_VALUE,
			useHighlightFallback: true,
		});
		assert.strictEqual(result.needsRetry, true);
		assert.deepStrictEqual(result.files, []);
		assert.strictEqual(result.skipped, false);
	});

	it("requires retry when nothing highlighted or selected", () => {
		const result = processAgentSelection({ selected: [] });
		assert.strictEqual(result.needsRetry, true);
		assert.deepStrictEqual(result.files, []);
		assert.strictEqual(result.skipped, false);
	});

	it("filters out 'none' when combined with other selections", () => {
		const result = processAgentSelection({
			selected: ["none", AGENTS_MD] as AgentSelectionValue[],
		});
		assert.strictEqual(result.needsRetry, false);
		assert.deepStrictEqual(result.files, [AGENTS_MD]);
		assert.strictEqual(result.skipped, false);
	});

	it("reports skip when only 'none' is selected", () => {
		const result = processAgentSelection({ selected: ["none"] });
		assert.strictEqual(result.needsRetry, false);
		assert.deepStrictEqual(result.files, []);
		assert.strictEqual(result.skipped, true);
	});

	it("dedupes selections while preserving order", () => {
		const result = processAgentSelection({
			selected: [AGENTS_MD, CLAUDE_MD, AGENTS_MD, "none", CLAUDE_MD],
		});
		assert.strictEqual(result.needsRetry, false);
		assert.deepStrictEqual(result.files, [AGENTS_MD, CLAUDE_MD]);
		assert.strictEqual(result.skipped, false);
	});
});
