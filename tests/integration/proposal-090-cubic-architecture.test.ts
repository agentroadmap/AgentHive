/**
 * Tests for proposal-090: Cubic Architecture - Isolated Sandbox for Expert Agents
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	agentHasCapability,
	CubicPhase,
	CubicSandbox,
	createCubicAgent,
	createDefaultCubicConfig,
	DEFAULT_PHASE_CAPABILITIES,
	type HandoffPayload,
	nextPhase,
	PHASE_ORDER,
	type PhaseSkill,
	prevPhase,
} from "../../src/core/orchestration/cubic-architecture.ts";

describe("proposal-090: Cubic Architecture", () => {
	// AC#1: CubicPhase and CubicConfig
	describe("AC#1: CubicPhase and CubicConfig", () => {
		it("has all four phases in correct order", () => {
			assert.deepStrictEqual(PHASE_ORDER, [
				CubicPhase.Design,
				CubicPhase.Build,
				CubicPhase.Test,
				CubicPhase.Ship,
			]);
		});

		it("nextPhase returns the next phase", () => {
			assert.equal(nextPhase(CubicPhase.Design), CubicPhase.Build);
			assert.equal(nextPhase(CubicPhase.Build), CubicPhase.Test);
			assert.equal(nextPhase(CubicPhase.Test), CubicPhase.Ship);
		});

		it("nextPhase returns null for Ship", () => {
			assert.equal(nextPhase(CubicPhase.Ship), null);
		});

		it("prevPhase returns the previous phase", () => {
			assert.equal(prevPhase(CubicPhase.Ship), CubicPhase.Test);
			assert.equal(prevPhase(CubicPhase.Test), CubicPhase.Build);
			assert.equal(prevPhase(CubicPhase.Build), CubicPhase.Design);
		});

		it("prevPhase returns null for Design", () => {
			assert.equal(prevPhase(CubicPhase.Design), null);
		});

		it("createDefaultCubicConfig generates valid config", () => {
			const config = createDefaultCubicConfig(CubicPhase.Build, "test-cubic-1");
			assert.equal(config.cubicId, "test-cubic-1");
			assert.equal(config.phase, CubicPhase.Build);
			assert.equal(config.maxAgents, 5);
			assert.equal(config.idleTimeoutMs, 30 * 60 * 1000);
			assert.deepStrictEqual(
				config.allowedCapabilities,
				DEFAULT_PHASE_CAPABILITIES[CubicPhase.Build],
			);
			assert.equal(config.canHandoff, true);
		});

		it("Ship phase has canHandoff=false by default", () => {
			const config = createDefaultCubicConfig(CubicPhase.Ship);
			assert.equal(config.canHandoff, false);
		});

		it("each phase has unique capabilities", () => {
			const allCaps = Object.values(DEFAULT_PHASE_CAPABILITIES);
			for (let i = 0; i < allCaps.length; i++) {
				for (let j = i + 1; j < allCaps.length; j++) {
					const overlap = allCaps[i].filter((c) => allCaps[j].includes(c));
					assert.deepStrictEqual(
						overlap,
						[],
						`Overlap between phases ${i} and ${j}: ${overlap}`,
					);
				}
			}
		});
	});

	// AC#2: CubicAgent interface
	describe("AC#2: CubicAgent interface", () => {
		it("createCubicAgent creates agent with defaults", () => {
			const agent = createCubicAgent(
				"agent-1",
				"Builder Bot",
				CubicPhase.Build,
			);
			assert.equal(agent.agentId, "agent-1");
			assert.equal(agent.name, "Builder Bot");
			assert.equal(agent.phase, CubicPhase.Build);
			assert.equal(agent.cubicId, null);
			assert.equal(agent.status, "idle");
			assert.deepStrictEqual(agent.skills, []);
		});

		it("agentHasCapability checks skill in current phase", () => {
			const skills: PhaseSkill[] = [
				{ skillId: "code", level: "expert", activePhases: [CubicPhase.Build] },
				{
					skillId: "test",
					level: "competent",
					activePhases: [CubicPhase.Test],
				},
			];
			const agent = createCubicAgent("a1", "Dev", CubicPhase.Build, skills);

			assert.equal(agentHasCapability(agent, "code"), true);
			assert.equal(agentHasCapability(agent, "test"), false);
		});

		it("agentHasCapability returns false for missing skill", () => {
			const agent = createCubicAgent("a1", "Dev", CubicPhase.Build);
			assert.equal(agentHasCapability(agent, "code"), false);
		});
	});

	// AC#3: CubicSandbox class
	describe("AC#3: CubicSandbox class", () => {
		it("creates sandbox with config", () => {
			const config = createDefaultCubicConfig(CubicPhase.Design, "design-1");
			const sandbox = new CubicSandbox(config);

			assert.equal(sandbox.getId(), "design-1");
			assert.equal(sandbox.getPhase(), CubicPhase.Design);
			assert.equal(sandbox.getAgentCount(), 0);
		});

		it("getConfig returns a copy", () => {
			const config = createDefaultCubicConfig(CubicPhase.Build, "b1");
			const sandbox = new CubicSandbox(config);
			const copy = sandbox.getConfig();
			copy.maxAgents = 999;
			assert.equal(sandbox.getConfig().maxAgents, 5);
		});

		it("joinAgent adds agent and sets cubicId", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			const agent = createCubicAgent("a1", "Builder", CubicPhase.Build);

			assert.equal(sandbox.joinAgent(agent), true);
			assert.equal(sandbox.getAgentCount(), 1);
			assert.equal(sandbox.getAgent("a1")?.cubicId, "b1");
		});

		it("joinAgent rejects when at capacity", () => {
			const config = createDefaultCubicConfig(CubicPhase.Test, "t1");
			config.maxAgents = 2;
			const sandbox = new CubicSandbox(config);

			sandbox.joinAgent(createCubicAgent("a1", "A1", CubicPhase.Test));
			sandbox.joinAgent(createCubicAgent("a2", "A2", CubicPhase.Test));
			assert.equal(
				sandbox.joinAgent(createCubicAgent("a3", "A3", CubicPhase.Test)),
				false,
			);
			assert.equal(sandbox.getAgentCount(), 2);
		});

		it("leaveAgent removes agent and clears cubicId", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			const agent = createCubicAgent("a1", "Builder", CubicPhase.Build);
			sandbox.joinAgent(agent);

			assert.equal(sandbox.leaveAgent("a1"), true);
			assert.equal(sandbox.getAgentCount(), 0);
			assert.equal(agent.cubicId, null);
		});

		it("leaveAgent returns false for unknown agent", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			assert.equal(sandbox.leaveAgent("ghost"), false);
		});

		it("getAgents returns all agents", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Design, "d1"),
			);
			sandbox.joinAgent(createCubicAgent("a1", "A1", CubicPhase.Design));
			sandbox.joinAgent(createCubicAgent("a2", "A2", CubicPhase.Design));

			const agents = sandbox.getAgents();
			assert.equal(agents.length, 2);
			assert.deepStrictEqual(agents.map((a) => a.agentId).sort(), ["a1", "a2"]);
		});
	});

	// AC#4: Phase capability gating
	describe("AC#4: Phase capability gating", () => {
		it("allows capabilities in the allowed list", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			assert.equal(sandbox.isCapabilityAllowed("code"), true);
			assert.equal(sandbox.isCapabilityAllowed("edit"), true);
			assert.equal(sandbox.isCapabilityAllowed("deploy"), false);
		});

		it("useCapability returns allowed for valid capability", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Test, "t1"),
			);
			const result = sandbox.useCapability("run-tests");
			assert.equal(result.allowed, true);
			assert.equal(result.reason, undefined);
		});

		it("useCapability rejects with descriptive error", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Design, "d1"),
			);
			const result = sandbox.useCapability("deploy");
			assert.equal(result.allowed, false);
			assert.ok(result.reason?.includes("deploy"));
			assert.ok(result.reason?.includes("design"));
		});

		it("each phase gates different capabilities", () => {
			const design = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Design, "d"),
			);
			const build = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b"),
			);
			const ship = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Ship, "s"),
			);

			assert.equal(design.useCapability("research").allowed, true);
			assert.equal(build.useCapability("research").allowed, false);
			assert.equal(ship.useCapability("deploy").allowed, true);
			assert.equal(design.useCapability("deploy").allowed, false);
		});
	});

	// AC#5: Health monitoring
	describe("AC#5: Health monitoring", () => {
		it("heartbeat updates lastHeartbeat", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			const before = Date.now();
			sandbox.heartbeat();
			const after = Date.now();

			const health = sandbox.getHealth();
			assert.ok(health.lastHeartbeat >= before);
			assert.ok(health.lastHeartbeat <= after);
		});

		it("getHealth reports alive when recently active", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			sandbox.heartbeat();

			const health = sandbox.getHealth();
			assert.equal(health.isAlive, true);
			assert.ok(health.idleMs < 1000);
		});

		it("isExpired returns false for fresh cubic", () => {
			const config = createDefaultCubicConfig(CubicPhase.Build, "b1");
			config.idleTimeoutMs = 5000;
			const sandbox = new CubicSandbox(config);
			sandbox.heartbeat();
			assert.equal(sandbox.isExpired(), false);
		});

		it("getHealth includes agent count", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			sandbox.joinAgent(createCubicAgent("a1", "A1", CubicPhase.Build));
			sandbox.joinAgent(createCubicAgent("a2", "A2", CubicPhase.Build));

			const health = sandbox.getHealth();
			assert.equal(health.agentCount, 2);
			assert.equal(health.cubicId, "b1");
		});
	});

	// AC#6: Handoff contract
	describe("AC#6: Handoff contract", () => {
		it("validates correct handoff", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			const agent = createCubicAgent("a1", "Builder", CubicPhase.Build);
			sandbox.joinAgent(agent);

			const payload: HandoffPayload = {
				fromPhase: CubicPhase.Build,
				toPhase: CubicPhase.Test,
				initiatorAgentId: "a1",
				readySignal: "all tests passing locally",
				artifacts: [
					{
						type: "code",
						reference: "src/",
						description: "Implementation code",
					},
					{
						type: "test-report",
						reference: "test-results.json",
						description: "Local test results",
					},
				],
				timestamp: Date.now(),
			};

			const validation = sandbox.validateHandoff(payload);
			assert.equal(validation.valid, true);
			assert.deepStrictEqual(validation.errors, []);
		});

		it("rejects handoff from wrong phase", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Test, "t1"),
			);
			const agent = createCubicAgent("a1", "Tester", CubicPhase.Test);
			sandbox.joinAgent(agent);

			const payload: HandoffPayload = {
				fromPhase: CubicPhase.Build,
				toPhase: CubicPhase.Test,
				initiatorAgentId: "a1",
				readySignal: "done",
				artifacts: [],
				timestamp: Date.now(),
			};

			const validation = sandbox.validateHandoff(payload);
			assert.equal(validation.valid, false);
			assert.ok(validation.errors[0].includes("doesn't match"));
		});

		it("rejects handoff to wrong target phase", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			const agent = createCubicAgent("a1", "Builder", CubicPhase.Build);
			sandbox.joinAgent(agent);

			const payload: HandoffPayload = {
				fromPhase: CubicPhase.Build,
				toPhase: CubicPhase.Ship,
				initiatorAgentId: "a1",
				readySignal: "done",
				artifacts: [],
				timestamp: Date.now(),
			};

			const validation = sandbox.validateHandoff(payload);
			assert.equal(validation.valid, false);
			assert.ok(
				validation.errors.some((e) => e.includes("Invalid handoff target")),
			);
		});

		it("rejects handoff from cubic with canHandoff=false", () => {
			const config = createDefaultCubicConfig(CubicPhase.Ship, "s1");
			config.canHandoff = false;
			const sandbox = new CubicSandbox(config);
			const agent = createCubicAgent("a1", "Shipper", CubicPhase.Ship);
			sandbox.joinAgent(agent);

			const payload: HandoffPayload = {
				fromPhase: CubicPhase.Ship,
				toPhase: CubicPhase.Design,
				initiatorAgentId: "a1",
				readySignal: "done",
				artifacts: [],
				timestamp: Date.now(),
			};

			const validation = sandbox.validateHandoff(payload);
			assert.equal(validation.valid, false);
			assert.ok(validation.errors.some((e) => e.includes("canHandoff")));
		});

		it("rejects handoff from agent not in cubic", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);

			const payload: HandoffPayload = {
				fromPhase: CubicPhase.Build,
				toPhase: CubicPhase.Test,
				initiatorAgentId: "ghost",
				readySignal: "done",
				artifacts: [],
				timestamp: Date.now(),
			};

			const validation = sandbox.validateHandoff(payload);
			assert.equal(validation.valid, false);
			assert.ok(validation.errors.some((e) => e.includes("not found")));
		});

		it("executeHandoff sets agent to handoff proposal", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			const agent = createCubicAgent("a1", "Builder", CubicPhase.Build);
			sandbox.joinAgent(agent);

			const payload: HandoffPayload = {
				fromPhase: CubicPhase.Build,
				toPhase: CubicPhase.Test,
				initiatorAgentId: "a1",
				readySignal: "done",
				artifacts: [],
				timestamp: Date.now(),
			};

			const result = sandbox.executeHandoff(payload);
			assert.equal(result.success, true);
			assert.equal(sandbox.getAgent("a1")?.status, "handoff");
		});

		it("executeHandoff fails for invalid payload", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			const agent = createCubicAgent("a1", "Builder", CubicPhase.Build);
			sandbox.joinAgent(agent);

			const payload: HandoffPayload = {
				fromPhase: CubicPhase.Test,
				toPhase: CubicPhase.Ship,
				initiatorAgentId: "a1",
				readySignal: "done",
				artifacts: [],
				timestamp: Date.now(),
			};

			const result = sandbox.executeHandoff(payload);
			assert.equal(result.success, false);
			assert.ok(result.errors && result.errors.length >= 2);
		});

		it("completeHandoff resets handoff agents to idle", () => {
			const sandbox = new CubicSandbox(
				createDefaultCubicConfig(CubicPhase.Build, "b1"),
			);
			const agent = createCubicAgent("a1", "Builder", CubicPhase.Build);
			sandbox.joinAgent(agent);

			sandbox.executeHandoff({
				fromPhase: CubicPhase.Build,
				toPhase: CubicPhase.Test,
				initiatorAgentId: "a1",
				readySignal: "done",
				artifacts: [],
				timestamp: Date.now(),
			});

			assert.equal(sandbox.getAgent("a1")?.status, "handoff");
			sandbox.completeHandoff();
			assert.equal(sandbox.getAgent("a1")?.status, "idle");
		});
	});
});
