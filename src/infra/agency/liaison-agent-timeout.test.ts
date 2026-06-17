import { afterEach, describe, expect, it } from "bun:test";
import { resolveLiaisonLlmTimeoutMs } from "./liaison-timeout.ts";

// Flag-backed key uses LIAISON_LLM_TIMEOUT_MS (no AGENTHIVE_ prefix) as env override.
// Per-provider overrides still use AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_<PROVIDER>.
const ORIGINAL_GLOBAL = process.env.LIAISON_LLM_TIMEOUT_MS;
const ORIGINAL_CODEX = process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_CODEX;

function restoreEnv() {
	if (ORIGINAL_GLOBAL === undefined) {
		delete process.env.LIAISON_LLM_TIMEOUT_MS;
	} else {
		process.env.LIAISON_LLM_TIMEOUT_MS = ORIGINAL_GLOBAL;
	}

	if (ORIGINAL_CODEX === undefined) {
		delete process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_CODEX;
	} else {
		process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_CODEX = ORIGINAL_CODEX;
	}
}

describe("resolveLiaisonLlmTimeoutMs", () => {
	afterEach(restoreEnv);

	it("uses a longer default for Codex liaison invocations", async () => {
		delete process.env.LIAISON_LLM_TIMEOUT_MS;
		delete process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_CODEX;

		expect(await resolveLiaisonLlmTimeoutMs("codex")).toBe(120000);
		expect(await resolveLiaisonLlmTimeoutMs("claude")).toBe(30000);
	});

	it("allows global and provider-specific timeout overrides", async () => {
		process.env.LIAISON_LLM_TIMEOUT_MS = "45000";
		expect(await resolveLiaisonLlmTimeoutMs("claude")).toBe(45000);
		expect(await resolveLiaisonLlmTimeoutMs("codex")).toBe(45000);

		process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_CODEX = "180000";
		expect(await resolveLiaisonLlmTimeoutMs("codex")).toBe(180000);
	});

	it("ignores invalid overrides", async () => {
		process.env.LIAISON_LLM_TIMEOUT_MS = "not-a-number";
		process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_CODEX = "0";

		expect(await resolveLiaisonLlmTimeoutMs("codex")).toBe(120000);
		expect(await resolveLiaisonLlmTimeoutMs("claude")).toBe(30000);
	});
});
