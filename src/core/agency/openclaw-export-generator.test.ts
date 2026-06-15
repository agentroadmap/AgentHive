/**
 * P1357 (P1355-B): OpenClaw workspace export generator.
 *
 * AC-1: generator returns three non-empty Markdown files from a complete profile.
 * AC-2: SOUL.md has Core Truths / Boundaries / Continuity.
 * AC-3: IDENTITY.md has the name/emoji/vibe metadata block.
 * AC-4: AGENTS.md has Every Session / Capabilities (grouped) / Coordination.
 *
 * Pure-function tests — no DB, no env gate. Runs in the default suite.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	generateOpenClawWorkspace,
	type OpenClawAgentProfile,
} from "./openclaw-export-generator.ts";

function fixture(
	overrides: Partial<OpenClawAgentProfile> = {},
): OpenClawAgentProfile {
	return {
		agent_identity: "codex.a",
		display_alias: "codex.a",
		display_name: "Codex Agency",
		personality: {
			vibe: "Principled orchestrator who marshals distributed AI reasoning.",
			core_truths: [
				"Consensus emerges from structural debate, not authority.",
				"Evidence precedes conclusion.",
			],
			boundaries: [
				"Never blend strategic judgment with operational detail.",
				"Rejects fabricated evidence in decision logs.",
			],
			communication_style: "Direct, evidence-grounded, skeptically constructive.",
			expertise: ["architect", "reviewer", "debugger"],
		},
		display_metadata: {
			emoji: "⚖️",
			color: "#2563eb",
			source: "operator",
			description: "Distributed orchestrator across agency proposals.",
		},
		capabilities: [
			{ capability: "architecture", proficiency: 5 },
			{ capability: "review", proficiency: 5 },
			{ capability: "messaging", proficiency: 3 },
			{ capability: "agent-spawner", proficiency: 3 },
		],
		...overrides,
	};
}

describe("generateOpenClawWorkspace (P1357 AC-1)", () => {
	test("returns three non-empty Markdown files", () => {
		const ws = generateOpenClawWorkspace(fixture());
		assert.ok(ws.soul_md.length > 0);
		assert.ok(ws.identity_md.length > 0);
		assert.ok(ws.agents_md.length > 0);
		// Each is Markdown with at least one header.
		assert.match(ws.soul_md, /^#/m);
		assert.match(ws.identity_md, /^#/m);
		assert.match(ws.agents_md, /^#/m);
	});

	test("tolerates a null personality / empty capabilities without throwing", () => {
		const ws = generateOpenClawWorkspace(
			fixture({ personality: null, display_metadata: null, capabilities: [] }),
		);
		assert.ok(ws.soul_md.includes("Continuity"));
		assert.ok(ws.identity_md.includes("name: codex.a"));
		assert.ok(ws.agents_md.includes("Every Session"));
	});
});

describe("SOUL.md (P1357 AC-2)", () => {
	test("has Core Truths, Boundaries, Continuity sections with content", () => {
		const { soul_md } = generateOpenClawWorkspace(fixture());
		assert.match(soul_md, /## Core Truths/);
		assert.match(soul_md, /- Consensus emerges from structural debate/);
		assert.match(soul_md, /## Boundaries/);
		assert.match(soul_md, /- Never blend strategic judgment/);
		assert.match(soul_md, /## Continuity/);
		assert.match(soul_md, /roadmap\.proposal_discussion/);
	});
});

describe("IDENTITY.md (P1357 AC-3)", () => {
	test("metadata block has name (required), emoji, vibe", () => {
		const { identity_md } = generateOpenClawWorkspace(fixture());
		assert.match(identity_md, /^---$/m);
		assert.match(identity_md, /^name: codex\.a$/m);
		assert.match(identity_md, /^emoji: ⚖️$/m);
		assert.match(identity_md, /^vibe: /m);
	});

	test("name is always emitted even when emoji/vibe absent", () => {
		const { identity_md } = generateOpenClawWorkspace(
			fixture({
				personality: {
					vibe: "",
					core_truths: [],
					boundaries: [],
					communication_style: "",
					expertise: [],
				},
				display_metadata: null,
			}),
		);
		assert.match(identity_md, /^name: codex\.a$/m);
		assert.ok(!/^emoji:/m.test(identity_md), "no emoji line when none provided");
	});
});

describe("AGENTS.md (P1357 AC-4)", () => {
	test("has Every Session, Capabilities grouped by band, Coordination", () => {
		const { agents_md } = generateOpenClawWorkspace(fixture());
		assert.match(agents_md, /## Every Session/);
		assert.match(agents_md, /Claim \(lease\) a proposal/);
		assert.match(agents_md, /## Capabilities/);
		// proficiency 5 → Expert band, 3 → Proficient band
		assert.match(agents_md, /\*\*Expert:\*\* architecture, review/);
		assert.match(agents_md, /\*\*Proficient:\*\* agent-spawner, messaging/);
		assert.match(agents_md, /## Multi-agent Coordination/);
		assert.match(agents_md, /A2A message bus/);
		assert.match(agents_md, /liaison/);
	});
});
