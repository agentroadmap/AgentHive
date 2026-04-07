/**
 * Tests for proposal-094: Creative Phase Handoff Protocol
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createArchitectFeedback,
	createHandoffLog,
	createImplementationNarrative,
	createQualitySignals,
	GATE_TRANSITIONS,
	gateForTransition,
	HandoffEngine,
	HandoffGate,
	type IntentToShip,
	type PulseMessage,
} from "../../src/core/collaboration/handoff-protocol.ts";
import { CubicPhase } from "../../src/core/orchestration/cubic-architecture.ts";

describe("proposal-094: Creative Phase Handoff Protocol", () => {
	// AC#1: G1-G4 Handoff Points
	describe("AC#1: G1-G4 Handoff Points", () => {
		it("defines all four gates", () => {
			assert.equal(HandoffGate.G1, "G1");
			assert.equal(HandoffGate.G2, "G2");
			assert.equal(HandoffGate.G3, "G3");
			assert.equal(HandoffGate.G4, "G4");
		});

		it("GATE_TRANSITIONS maps gates to phase transitions", () => {
			assert.deepStrictEqual(GATE_TRANSITIONS[HandoffGate.G1], {
				from: CubicPhase.Design,
				to: CubicPhase.Build,
			});
			assert.deepStrictEqual(GATE_TRANSITIONS[HandoffGate.G2], {
				from: CubicPhase.Build,
				to: CubicPhase.Test,
			});
			assert.deepStrictEqual(GATE_TRANSITIONS[HandoffGate.G3], {
				from: CubicPhase.Test,
				to: CubicPhase.Ship,
			});
		});

		it("gateForTransition returns correct gate", () => {
			assert.equal(
				gateForTransition(CubicPhase.Design, CubicPhase.Build),
				HandoffGate.G1,
			);
			assert.equal(
				gateForTransition(CubicPhase.Build, CubicPhase.Test),
				HandoffGate.G2,
			);
			assert.equal(
				gateForTransition(CubicPhase.Test, CubicPhase.Ship),
				HandoffGate.G3,
			);
		});

		it("gateForTransition returns null for invalid transition", () => {
			assert.equal(gateForTransition(CubicPhase.Ship, CubicPhase.Design), null);
			assert.equal(gateForTransition(CubicPhase.Test, CubicPhase.Build), null);
		});

		it("accepts intent to ship", () => {
			const intent: IntentToShip = {
				agentId: "designer-1",
				fromPhase: CubicPhase.Design,
				toPhase: CubicPhase.Build,
				gate: HandoffGate.G1,
				summary: "Architecture spec complete",
				deliverables: ["spec.md", "diagrams/", "adr-002.md"],
				risks: ["External API may change"],
				timestamp: Date.now(),
			};
			assert.ok(intent.summary);
			assert.ok(intent.deliverables.length > 0);
		});
	});

	// AC#2: Architect Feedback & Insights (G1)
	describe("AC#2: Architect Feedback & Insights", () => {
		it("creates architect feedback with proceed assessment", () => {
			const feedback = createArchitectFeedback(
				"architect-1",
				"proceed",
				["Clean separation of concerns", "Good API design"],
				["Missing error handling spec"],
				["Add retry logic to external calls"],
				[],
			);

			assert.equal(feedback.gate, HandoffGate.G1);
			assert.equal(feedback.assessment, "proceed");
			assert.equal(feedback.insights.length, 2);
			assert.equal(feedback.recommendations.length, 1);
			assert.deepStrictEqual(feedback.requiredChanges, []);
		});

		it("creates architect feedback with required changes", () => {
			const feedback = createArchitectFeedback(
				"architect-1",
				"revise",
				["Good overall structure"],
				["No auth layer", "Missing rate limiting"],
				["Add OAuth2", "Implement rate limiter"],
				["Add authentication layer", "Add rate limiting"],
			);

			assert.equal(feedback.assessment, "revise");
			assert.equal(feedback.requiredChanges.length, 2);
		});

		it("creates architect feedback with blocked assessment", () => {
			const feedback = createArchitectFeedback(
				"architect-1",
				"blocked",
				[],
				["Fundamental architecture issue with data model"],
				["Redesign data model"],
				["Redesign data model before proceeding"],
			);

			assert.equal(feedback.assessment, "blocked");
		});
	});

	// AC#3: Senior Dev Implementation Narrative (G2)
	describe("AC#3: Implementation Narrative", () => {
		it("creates implementation narrative with high confidence", () => {
			const narrative = createImplementationNarrative(
				"senior-dev-1",
				"Built user authentication with JWT tokens and refresh flow",
				[
					"Chose JWT over session cookies for proposalless scaling",
					"Used bcrypt for password hashing",
				],
				[
					{
						path: "src/auth/jwt.ts",
						type: "created",
						description: "JWT utilities",
					},
					{
						path: "src/auth/middleware.ts",
						type: "created",
						description: "Auth middleware",
					},
					{
						path: "src/routes/auth.ts",
						type: "modified",
						description: "Added login/register",
					},
				],
				[
					{ suite: "auth.test.ts", passed: 24, failed: 0, durationMs: 1200 },
					{
						suite: "middleware.test.ts",
						passed: 12,
						failed: 0,
						durationMs: 450,
					},
				],
				"high",
				["Token expiry edge case"],
			);

			assert.equal(narrative.gate, HandoffGate.G2);
			assert.equal(narrative.confidence, "high");
			assert.equal(narrative.changes.length, 3);
			assert.equal(narrative.localTestResults.length, 2);
			assert.equal(narrative.localTestResults[0].passed, 24);
			assert.equal(narrative.localTestResults[0].failed, 0);
			assert.ok(narrative.qaHotspots.length > 0);
		});

		it("creates implementation narrative with low confidence", () => {
			const narrative = createImplementationNarrative(
				"senior-dev-1",
				"Experimental approach to caching",
				["Trying new cache invalidation strategy"],
				[
					{
						path: "src/cache/index.ts",
						type: "created",
						description: "Cache layer",
					},
				],
				[{ suite: "cache.test.ts", passed: 8, failed: 2, durationMs: 800 }],
				"low",
				["Cache invalidation may have race conditions", "Needs load testing"],
			);

			assert.equal(narrative.confidence, "low");
			assert.equal(narrative.qaHotspots.length, 2);
		});
	});

	// AC#4: QA Quality Signals & Risk Observations (G3)
	describe("AC#4: Quality Signals & Risk Observations", () => {
		it("creates quality signals with ready assessment", () => {
			const signals = createQualitySignals(
				"qa-agent-1",
				"ready",
				{ linesPercent: 92, branchesPercent: 85, functionsPercent: 95 },
				[
					{ suite: "unit", passed: 145, failed: 0, durationMs: 5200 },
					{ suite: "integration", passed: 38, failed: 0, durationMs: 12000 },
				],
				[
					{
						category: "performance",
						severity: "low",
						description: "Slight slowdown on large datasets",
						component: "query-engine",
					},
				],
				[
					{
						metric: "p95-latency",
						value: 245,
						unit: "ms",
						meetsThreshold: true,
					},
				],
				"immediate",
			);

			assert.equal(signals.gate, HandoffGate.G3);
			assert.equal(signals.assessment, "ready");
			assert.equal(signals.coverage.linesPercent, 92);
			assert.equal(signals.shipPriority, "immediate");
			assert.equal(signals.risks.length, 1);
			assert.equal(signals.risks[0].severity, "low");
		});

		it("creates quality signals with blocked assessment", () => {
			const signals = createQualitySignals(
				"qa-agent-1",
				"blocked",
				{ linesPercent: 68, branchesPercent: 52, functionsPercent: 71 },
				[
					{ suite: "unit", passed: 120, failed: 15, durationMs: 5200 },
					{ suite: "integration", passed: 20, failed: 8, durationMs: 15000 },
				],
				[
					{
						category: "security",
						severity: "critical",
						description: "SQL injection vulnerability",
						component: "user-input",
						mitigation: "Use parameterized queries",
					},
					{
						category: "reliability",
						severity: "high",
						description: "Race condition in checkout",
						component: "cart-service",
					},
				],
				[
					{
						metric: "p95-latency",
						value: 2500,
						unit: "ms",
						meetsThreshold: false,
					},
				],
				"defer",
			);

			assert.equal(signals.assessment, "blocked");
			assert.equal(signals.risks.length, 2);
			assert.equal(signals.risks[0].severity, "critical");
			assert.equal(signals.shipPriority, "defer");
		});

		it("tracks coverage metrics", () => {
			const signals = createQualitySignals(
				"qa-agent-1",
				"ready",
				{ linesPercent: 100, branchesPercent: 100, functionsPercent: 100 },
				[],
				[],
				[],
				"immediate",
			);

			assert.equal(signals.coverage.linesPercent, 100);
			assert.equal(signals.coverage.branchesPercent, 100);
			assert.equal(signals.coverage.functionsPercent, 100);
		});
	});

	// AC#5: Handoff Engine — Pulse Message Routing
	describe("AC#5: Handoff Engine & Pulse Routing", () => {
		it("creates handoff engine", () => {
			const engine = new HandoffEngine();
			assert.deepStrictEqual(engine.getHistory(), []);
			assert.deepStrictEqual(engine.getMessages(), []);
		});

		it("subscribes to phase messages", () => {
			const engine = new HandoffEngine();
			let received: PulseMessage | null = null;

			engine.subscribe(CubicPhase.Build, (msg) => {
				received = msg;
			});

			const intent: IntentToShip = {
				agentId: "designer-1",
				fromPhase: CubicPhase.Design,
				toPhase: CubicPhase.Build,
				gate: HandoffGate.G1,
				summary: "Spec ready",
				deliverables: ["spec.md"],
				risks: [],
				timestamp: Date.now(),
			};

			engine.submitIntent(intent);

			assert.ok(received);
			const msg = received as PulseMessage;
			assert.equal(msg.fromPhase, CubicPhase.Design);
			assert.equal(msg.toPhase, CubicPhase.Build);
			assert.equal(msg.type, "intent");
			assert.equal(msg.gate, HandoffGate.G1);
		});

		it("routes architect feedback to build team", () => {
			const engine = new HandoffEngine();
			let received: PulseMessage | null = null;

			engine.subscribe(CubicPhase.Build, (msg) => {
				received = msg;
			});

			const feedback = createArchitectFeedback(
				"arch-1",
				"proceed",
				["Good design"],
				[],
				[],
				[],
			);

			engine.submitArchitectFeedback(feedback);

			assert.ok(received);
			const msg2 = received as PulseMessage;
			assert.equal(msg2.type, "feedback");
			assert.equal(msg2.priority, "normal");
		});

		it("routes implementation narrative to QA team", () => {
			const engine = new HandoffEngine();
			let received: PulseMessage | null = null;

			engine.subscribe(CubicPhase.Test, (msg) => {
				received = msg;
			});

			const narrative = createImplementationNarrative(
				"dev-1",
				"Built feature X",
				[],
				[],
				[],
				"high",
				[],
			);

			engine.submitImplementationNarrative(narrative);

			assert.ok(received);
			const msg = received as PulseMessage;
			assert.equal(msg.type, "narrative");
		});

		it("routes quality signals to ship team", () => {
			const engine = new HandoffEngine();
			let received: PulseMessage | null = null;

			engine.subscribe(CubicPhase.Ship, (msg) => {
				received = msg;
			});

			const signals = createQualitySignals(
				"qa-1",
				"ready",
				{ linesPercent: 90, branchesPercent: 85, functionsPercent: 95 },
				[],
				[],
				[],
				"immediate",
			);

			engine.submitQualitySignals(signals);

			assert.ok(received);
			const msg3 = received as PulseMessage;
			assert.equal(msg3.type, "quality");
			assert.equal(msg3.fromPhase, CubicPhase.Test);
			assert.equal(msg3.toPhase, CubicPhase.Ship);
		});

		it("sets urgent priority when risks present", () => {
			const engine = new HandoffEngine();
			let received: PulseMessage | null = null;

			engine.subscribe(CubicPhase.Build, (msg) => {
				received = msg;
			});

			const intent: IntentToShip = {
				agentId: "designer-1",
				fromPhase: CubicPhase.Design,
				toPhase: CubicPhase.Build,
				gate: HandoffGate.G1,
				summary: "Spec ready but has risks",
				deliverables: ["spec.md"],
				risks: ["External dependency unstable"],
				timestamp: Date.now(),
			};

			engine.submitIntent(intent);

			assert.ok(received);
			const msg4 = received as PulseMessage;
			assert.equal(msg4.priority, "urgent");
		});

		it("sets blocking priority for blocked assessments", () => {
			const engine = new HandoffEngine();
			let received: PulseMessage | null = null;

			engine.subscribe(CubicPhase.Ship, (msg) => {
				received = msg;
			});

			const signals = createQualitySignals(
				"qa-1",
				"blocked",
				{ linesPercent: 50, branchesPercent: 40, functionsPercent: 60 },
				[],
				[],
				[],
				"defer",
			);

			engine.submitQualitySignals(signals);

			assert.ok(received);
			const msg5 = received as PulseMessage;
			assert.equal(msg5.priority, "blocking");
		});

		it("unsubscribes correctly", () => {
			const engine = new HandoffEngine();
			let count = 0;

			const unsub = engine.subscribe(CubicPhase.Build, () => {
				count++;
			});

			// First intent should trigger
			const intent1: IntentToShip = {
				agentId: "d1",
				fromPhase: CubicPhase.Design,
				toPhase: CubicPhase.Build,
				gate: HandoffGate.G1,
				summary: "Spec",
				deliverables: [],
				risks: [],
				timestamp: Date.now(),
			};
			engine.submitIntent(intent1);
			assert.equal(count, 1);

			// Unsubscribe
			unsub();

			// Second intent should not trigger
			const intent2: IntentToShip = { ...intent1, timestamp: Date.now() };
			engine.submitIntent(intent2);
			assert.equal(count, 1); // unchanged
		});

		it("logs handoff history", () => {
			const engine = new HandoffEngine();
			const log = createHandoffLog(
				HandoffGate.G1,
				CubicPhase.Design,
				CubicPhase.Build,
				"designer-1",
				["pulse-001", "pulse-002"],
			);

			engine.logHandoff(log);

			assert.equal(engine.getHistory().length, 1);
			assert.equal(engine.getHistory()[0].gate, HandoffGate.G1);
		});

		it("filters messages by phase", () => {
			const engine = new HandoffEngine();

			// Design → Build
			const intent1: IntentToShip = {
				agentId: "d1",
				fromPhase: CubicPhase.Design,
				toPhase: CubicPhase.Build,
				gate: HandoffGate.G1,
				summary: "Spec",
				deliverables: [],
				risks: [],
				timestamp: Date.now(),
			};
			engine.submitIntent(intent1);

			// Build → Test
			const narrative = createImplementationNarrative(
				"dev-1",
				"Built",
				[],
				[],
				[],
				"high",
				[],
			);
			engine.submitImplementationNarrative(narrative);

			const designMessages = engine.getMessagesForPhase(CubicPhase.Design);
			assert.equal(designMessages.length, 1);

			const buildMessages = engine.getMessagesForPhase(CubicPhase.Build);
			assert.equal(buildMessages.length, 2); // received intent + sent narrative
		});
	});
});
