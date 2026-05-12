import { describe, expect, test } from "bun:test";
import {
	PERMANENT_AGENT_MAPPINGS,
	resolvePermanentAgentIdentity,
	resolvePermanentAgentMapping,
} from "../../src/core/identity/agent-registry/permanent-agent-map.ts";

describe("permanent agent name mapping", () => {
	test("maps requested Claude bot names to stable identities", () => {
		for (const name of [
			"adam",
			"andy",
			"alan",
			"alex",
			"andrew",
			"alice",
			"ana",
		]) {
			const mapping = resolvePermanentAgentMapping(name);
			expect(mapping).toMatchObject({
				name,
				agentIdentity: `claude/${name}`,
				provider: "claude",
				host: "bot",
			});
		}
	});

	test("maps requested Codex bot names to stable identities", () => {
		for (const name of [
			"cooper",
			"carter",
			"calvin",
			"clark",
			"cory",
			"chloe",
		]) {
			const mapping = resolvePermanentAgentMapping(name);
			expect(mapping).toMatchObject({
				name,
				agentIdentity: `codex/${name}`,
				provider: "codex",
				host: "bot",
			});
		}
	});

	test("accepts bare names and already-qualified identities", () => {
		expect(resolvePermanentAgentIdentity("Adam")).toBe("claude/adam");
		expect(resolvePermanentAgentIdentity("codex/carter")).toBe("codex/carter");
		expect(resolvePermanentAgentIdentity("unknown")).toBe("unknown");
		expect(PERMANENT_AGENT_MAPPINGS).toHaveLength(31);
	});

	test("derives provider by popular first-name initial", () => {
		expect(resolvePermanentAgentMapping("clark.dev")).toMatchObject({
			agentIdentity: "codex/clark.dev",
			provider: "codex",
			host: "bot",
			expertise: "dev",
			label: "clark.dev",
		});
		expect(resolvePermanentAgentMapping("grace.ts")).toMatchObject({
			agentIdentity: "gemini/grace.ts",
			provider: "gemini",
		});
		expect(resolvePermanentAgentMapping("peter.test")).toMatchObject({
			agentIdentity: "copilot/peter.test",
			provider: "copilot",
		});
		expect(resolvePermanentAgentMapping("henry.ops")).toMatchObject({
			agentIdentity: "hermes/henry.ops",
			provider: "hermes",
		});
	});

	test("uses @host in labels and A2A-safe colon in agent_identity", () => {
		expect(resolvePermanentAgentMapping("alan.dev@iMac")).toMatchObject({
			agentIdentity: "claude/alan.dev:imac",
			provider: "claude",
			host: "imac",
			label: "alan.dev@iMac",
			roleFamily: "builder",
		});
		expect(resolvePermanentAgentMapping("peter.test@iMac")).toMatchObject({
			agentIdentity: "copilot/peter.test:imac",
			provider: "copilot",
			host: "imac",
			label: "peter.test@iMac",
		});
	});

	test("marks Claude boys as builders and girls as skeptics", () => {
		expect(resolvePermanentAgentMapping("andrew.dev")).toMatchObject({
			provider: "claude",
			roleFamily: "builder",
		});
		expect(resolvePermanentAgentMapping("alice.review")).toMatchObject({
			provider: "claude",
			roleFamily: "skeptic",
		});
	});

	test("accepts provider-qualified agency and liaison labels", () => {
		expect(resolvePermanentAgentMapping("claude.a")).toMatchObject({
			agentIdentity: "claude.a",
			provider: "claude",
			host: "bot",
			permanentRole: "agency",
			label: "claude.a",
		});
		expect(resolvePermanentAgentMapping("claude.gary.a")).toMatchObject({
			agentIdentity: "claude.gary.a",
			provider: "claude",
			host: "bot",
			name: "gary",
			permanentRole: "agency",
		});
		expect(resolvePermanentAgentMapping("claude.gary.l")).toMatchObject({
			agentIdentity: "claude.gary.l",
			provider: "claude",
			host: "bot",
			name: "gary",
			permanentRole: "liaison",
		});
		expect(resolvePermanentAgentMapping("claude.xiaomi.l")).toMatchObject({
			agentIdentity: "claude.xiaomi.l",
			provider: "claude",
			host: "bot",
			name: "xiaomi",
			permanentRole: "liaison",
		});
		expect(resolvePermanentAgentMapping("codex.andy.l")).toMatchObject({
			agentIdentity: "codex.andy.l",
			provider: "codex",
			host: "bot",
			name: "andy",
			permanentRole: "liaison",
		});
	});

	test("keeps provider-qualified non-bot host as label while identity stays A2A-safe", () => {
		expect(resolvePermanentAgentMapping("codex.andy.l@iMac")).toMatchObject({
			agentIdentity: "codex.andy.l:imac",
			provider: "codex",
			host: "imac",
			label: "codex.andy.l@iMac",
			permanentRole: "liaison",
		});
	});
});
