/**
 * Creative Phase Handoff Protocol
 *
 * Implements STATE-094: Coordinates the collaborative flow between Cubic phases
 * (Design, Build, Test, Ship). Replaces rigid 'approvals' with 'narrative handoffs'
 * and 'peer feedback'. Agents declare readiness and provide intent, while the
 * engine facilitates the semantic transition between expert cubics.
 */

import { CubicPhase, nextPhase } from "../orchestration/cubic-architecture.ts";

// ──────────────────────────────────────────
// AC#1: G1-G4 Handoff Points
// ──────────────────────────────────────────

/** Canonical handoff gates between cubic phases */
export const HandoffGate = {
	/** Design → Build: Spec ready, architecture validated */
	G1: "G1",
	/** Build → Test: Implementation complete, tests passing locally */
	G2: "G2",
	/** Test → Ship: Quality validated, release candidates identified */
	G3: "G3",
	/** Ship → Done: Release confirmed, post-mortem initiated */
	G4: "G4",
} as const;

export type HandoffGate = (typeof HandoffGate)[keyof typeof HandoffGate];

/** Gate ordering and phase transitions */
export const GATE_TRANSITIONS: Record<
	HandoffGate,
	{ from: CubicPhase; to: CubicPhase }
> = {
	[HandoffGate.G1]: { from: CubicPhase.Design, to: CubicPhase.Build },
	[HandoffGate.G2]: { from: CubicPhase.Build, to: CubicPhase.Test },
	[HandoffGate.G3]: { from: CubicPhase.Test, to: CubicPhase.Ship },
	[HandoffGate.G4]: { from: CubicPhase.Ship, to: CubicPhase.Ship }, // final confirmation
};

/** Determine which gate applies to a phase transition */
export function gateForTransition(
	from: CubicPhase,
	to: CubicPhase,
): HandoffGate | null {
	for (const [gate, trans] of Object.entries(GATE_TRANSITIONS)) {
		if (trans.from === from && trans.to === to) {
			return gate as HandoffGate;
		}
	}
	return null;
}

/** Declarative 'Intent to Ship' from an agent */
export interface IntentToShip {
	/** Agent declaring intent */
	agentId: string;
	/** Current phase */
	fromPhase: CubicPhase;
	/** Target phase */
	toPhase: CubicPhase;
	/** The handoff gate being invoked */
	gate: HandoffGate;
	/** Summary of what's ready */
	summary: string;
	/** Key deliverables for this handoff */
	deliverables: string[];
	/** Known risks or blockers */
	risks: string[];
	/** Timestamp */
	timestamp: number;
}

// ──────────────────────────────────────────
// AC#2: Architect Feedback & Insights (G1)
// ──────────────────────────────────────────

/** Architectural feedback at G1 (Design → Build) */
export interface ArchitectFeedback {
	/** Gate this feedback applies to (must be G1) */
	gate: HandoffGate;
	/** Feedback from architect */
	architectId: string;
	/** Overall assessment: proceed, revise, or blocked */
	assessment: "proceed" | "revise" | "blocked";
	/** Design insights — what looks good */
	insights: string[];
	/** Concerns — what needs attention */
	concerns: string[];
	/** Recommendations — suggested improvements */
	recommendations: string[];
	/** Required changes before Build can start */
	requiredChanges: string[];
	/** Timestamp */
	timestamp: number;
}

/** Create an architect feedback entry */
export function createArchitectFeedback(
	architectId: string,
	assessment: ArchitectFeedback["assessment"],
	insights: string[],
	concerns: string[],
	recommendations: string[],
	requiredChanges: string[],
): ArchitectFeedback {
	return {
		gate: HandoffGate.G1,
		architectId,
		assessment,
		insights,
		concerns,
		recommendations,
		requiredChanges,
		timestamp: Date.now(),
	};
}

// ──────────────────────────────────────────
// AC#3: Senior Dev Implementation Narrative (G2)
// ──────────────────────────────────────────

/** Implementation narrative at G2 (Build → Test) */
export interface ImplementationNarrative {
	/** Gate this applies to (must be G2) */
	gate: HandoffGate;
	/** Senior developer providing the narrative */
	seniorDevId: string;
	/** What was built — high-level summary */
	builtSummary: string;
	/** Key architectural decisions made */
	decisions: string[];
	/** Files/modules created or modified */
	changes: ModuleChange[];
	/** Dev test results (local validation) */
	localTestResults: TestResult[];
	/** Confidence level in the build */
	confidence: "high" | "medium" | "low";
	/** Areas that need extra QA attention */
	qaHotspots: string[];
	/** Timestamp */
	timestamp: number;
}

/** A module change entry */
export interface ModuleChange {
	/** File path */
	path: string;
	/** Change type: created, modified, deleted */
	type: "created" | "modified" | "deleted";
	/** Brief description of changes */
	description: string;
}

/** Test result summary */
export interface TestResult {
	/** Test suite or file name */
	suite: string;
	/** Number of tests passed */
	passed: number;
	/** Number of tests failed */
	failed: number;
	/** Duration in ms */
	durationMs: number;
}

/** Create an implementation narrative */
export function createImplementationNarrative(
	seniorDevId: string,
	builtSummary: string,
	decisions: string[],
	changes: ModuleChange[],
	localTestResults: TestResult[],
	confidence: ImplementationNarrative["confidence"],
	qaHotspots: string[],
): ImplementationNarrative {
	return {
		gate: HandoffGate.G2,
		seniorDevId,
		builtSummary,
		decisions,
		changes,
		localTestResults,
		confidence,
		qaHotspots,
		timestamp: Date.now(),
	};
}

// ──────────────────────────────────────────
// AC#4: QA Quality Signals & Risk Observations (G3)
// ──────────────────────────────────────────

/** QA quality signals at G3 (Test → Ship) */
export interface QualitySignals {
	/** Gate this applies to (must be G3) */
	gate: HandoffGate;
	/** QA agent providing signals */
	qaAgentId: string;
	/** Overall quality assessment */
	assessment: "ready" | "needs-work" | "blocked";
	/** Test coverage metrics */
	coverage: CoverageMetrics;
	/** Test results across suites */
	testResults: TestResult[];
	/** Risk observations */
	risks: RiskObservation[];
	/** Performance benchmarks */
	performance: PerformanceSignal[];
	/** Recommended ship priority */
	shipPriority: "immediate" | "next-window" | "defer";
	/** Timestamp */
	timestamp: number;
}

/** Test coverage metrics */
export interface CoverageMetrics {
	/** Lines covered (percentage) */
	linesPercent: number;
	/** Branches covered (percentage) */
	branchesPercent: number;
	/** Functions covered (percentage) */
	functionsPercent: number;
}

/** A risk observation */
export interface RiskObservation {
	/** Risk category */
	category: "performance" | "security" | "reliability" | "ux" | "compatibility";
	/** Severity: low, medium, high, critical */
	severity: "low" | "medium" | "high" | "critical";
	/** Description of the risk */
	description: string;
	/** Affected component or module */
	component: string;
	/** Suggested mitigation */
	mitigation?: string;
}

/** Performance signal */
export interface PerformanceSignal {
	/** Metric name */
	metric: string;
	/** Measured value */
	value: number;
	/** Unit */
	unit: string;
	/** Whether it meets the threshold */
	meetsThreshold: boolean;
}

/** Create quality signals */
export function createQualitySignals(
	qaAgentId: string,
	assessment: QualitySignals["assessment"],
	coverage: CoverageMetrics,
	testResults: TestResult[],
	risks: RiskObservation[],
	performance: PerformanceSignal[],
	shipPriority: QualitySignals["shipPriority"],
): QualitySignals {
	return {
		gate: HandoffGate.G3,
		qaAgentId,
		assessment,
		coverage,
		testResults,
		risks,
		performance,
		shipPriority,
		timestamp: Date.now(),
	};
}

// ──────────────────────────────────────────
// AC#5: Handoff Engine — Pulse Message Routing
// ──────────────────────────────────────────

/** A pulse message routed between cubic teams */
export interface PulseMessage {
	/** Unique message ID */
	messageId: string;
	/** Source phase */
	fromPhase: CubicPhase;
	/** Target phase */
	toPhase: CubicPhase;
	/** Gate that triggered this pulse */
	gate: HandoffGate;
	/** Message type */
	type: "intent" | "feedback" | "narrative" | "quality" | "acknowledgment";
	/** Payload content (structured) */
	content:
		| IntentToShip
		| ArchitectFeedback
		| ImplementationNarrative
		| QualitySignals;
	/** Priority level */
	priority: "normal" | "urgent" | "blocking";
	/** Timestamp */
	timestamp: number;
}

/** Subscriber callback for pulse messages */
export type PulseSubscriber = (message: PulseMessage) => void;

/**
 * HandoffEngine — manages handoffs between cubic phases.
 *
 * Routes pulse messages, validates handoff contracts, and coordinates
 * the flow between expert agent cubics.
 */
export class HandoffEngine {
	private subscribers: Map<CubicPhase, PulseSubscriber[]> = new Map();
	private messageHistory: PulseMessage[] = [];
	private handoffLog: HandoffLogEntry[] = [];

	/** Subscribe to pulse messages for a phase */
	subscribe(phase: CubicPhase, callback: PulseSubscriber): () => void {
		if (!this.subscribers.has(phase)) {
			this.subscribers.set(phase, []);
		}
		this.subscribers.get(phase)?.push(callback);

		// Return unsubscribe function
		return () => {
			const subs = this.subscribers.get(phase);
			if (subs) {
				const idx = subs.indexOf(callback);
				if (idx >= 0) subs.splice(idx, 1);
			}
		};
	}

	/** Route a pulse message to target phase subscribers */
	routePulse(message: PulseMessage): void {
		this.messageHistory.push(message);

		const subscribers = this.subscribers.get(message.toPhase) || [];
		for (const sub of subscribers) {
			try {
				sub(message);
			} catch {
				// Don't let subscriber errors break the engine
			}
		}
	}

	/** Submit an intent to ship and route to the next phase */
	submitIntent(intent: IntentToShip): PulseMessage {
		const next = nextPhase(intent.fromPhase);
		if (!next) {
			throw new Error(`No next phase after ${intent.fromPhase}`);
		}

		const message: PulseMessage = {
			messageId: `pulse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			fromPhase: intent.fromPhase,
			toPhase: next,
			gate: intent.gate,
			type: "intent",
			content: intent,
			priority: intent.risks.length > 0 ? "urgent" : "normal",
			timestamp: Date.now(),
		};

		this.routePulse(message);
		return message;
	}

	/** Submit architect feedback and route to build team */
	submitArchitectFeedback(feedback: ArchitectFeedback): PulseMessage {
		const message: PulseMessage = {
			messageId: `pulse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			fromPhase: CubicPhase.Design,
			toPhase: CubicPhase.Build,
			gate: feedback.gate,
			type: "feedback",
			content: feedback,
			priority: feedback.assessment === "blocked" ? "blocking" : "normal",
			timestamp: Date.now(),
		};

		this.routePulse(message);
		return message;
	}

	/** Submit implementation narrative and route to QA team */
	submitImplementationNarrative(
		narrative: ImplementationNarrative,
	): PulseMessage {
		const message: PulseMessage = {
			messageId: `pulse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			fromPhase: CubicPhase.Build,
			toPhase: CubicPhase.Test,
			gate: narrative.gate,
			type: "narrative",
			content: narrative,
			priority: narrative.confidence === "low" ? "urgent" : "normal",
			timestamp: Date.now(),
		};

		this.routePulse(message);
		return message;
	}

	/** Submit quality signals and route to ship team */
	submitQualitySignals(signals: QualitySignals): PulseMessage {
		const message: PulseMessage = {
			messageId: `pulse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			fromPhase: CubicPhase.Test,
			toPhase: CubicPhase.Ship,
			gate: signals.gate,
			type: "quality",
			content: signals,
			priority: signals.shipPriority === "defer" ? "blocking" : "normal",
			timestamp: Date.now(),
		};

		this.routePulse(message);
		return message;
	}

	/** Log a completed handoff */
	logHandoff(entry: HandoffLogEntry): void {
		this.handoffLog.push(entry);
	}

	/** Get handoff history */
	getHistory(): HandoffLogEntry[] {
		return [...this.handoffLog];
	}

	/** Get message history */
	getMessages(): PulseMessage[] {
		return [...this.messageHistory];
	}

	/** Get messages for a specific phase */
	getMessagesForPhase(phase: CubicPhase): PulseMessage[] {
		return this.messageHistory.filter(
			(m) => m.fromPhase === phase || m.toPhase === phase,
		);
	}
}

/** Log entry for a completed handoff */
export interface HandoffLogEntry {
	gate: HandoffGate;
	fromPhase: CubicPhase;
	toPhase: CubicPhase;
	initiatorAgentId: string;
	/** All pulse messages exchanged during this handoff */
	messages: string[]; // message IDs
	timestamp: number;
}

/** Create a handoff log entry */
export function createHandoffLog(
	gate: HandoffGate,
	fromPhase: CubicPhase,
	toPhase: CubicPhase,
	initiatorAgentId: string,
	messages: string[],
): HandoffLogEntry {
	return {
		gate,
		fromPhase,
		toPhase,
		initiatorAgentId,
		messages,
		timestamp: Date.now(),
	};
}
