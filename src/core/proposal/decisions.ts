/**
 * Decision creation / update helpers.
 *
 * Extracted from the `Core` class (P3796 monolith decomposition, Phase 1, AC-11).
 *
 * These functions accept a `DecisionContext` instead of relying on `this`, so
 * they can be called from `Core` without circular imports with `roadmap.ts`.
 */
import type { Core } from "../../index.ts";
import type { Decision, PulseEvent } from "../../types/index.ts";

/**
 * Shape of the pulse event emitted for a decision. Mirrors the object literal
 * the `Core` class passed to `recordPulse` (no `agent`/`timestamp`), so the
 * extracted helper stays type-compatible with the original call site.
 */
type DecisionPulseEvent = Pick<PulseEvent, "type" | "id" | "title" | "impact">;

export interface DecisionContext {
	saveDecision(d: Decision): Promise<void>;
	loadDecision(id: string): Promise<Decision | null>;
	recordPulse(p: DecisionPulseEvent): Promise<void>;
	shouldAutoCommit(override?: boolean): Promise<boolean>;
	getRoadmapDirectoryName(): Promise<string>;
	stageRoadmapDirectory(dir: string): Promise<string | null>;
	commitChanges(msg: string, root: string | null): Promise<void>;
	/** Create-decision delegate, used by the update/with-title helpers. */
	createDecision(decision: Decision, autoCommit?: boolean): Promise<void>;
}

export async function createDecision(
	ctx: DecisionContext,
	decision: Decision,
	autoCommit?: boolean,
): Promise<void> {
	await ctx.saveDecision(decision);

	// Record Pulse event
	await ctx.recordPulse({
		type: "decision_made",
		id: decision.id,
		title: decision.title,
		impact: `Status: ${decision.status}`,
	});

	if (await ctx.shouldAutoCommit(autoCommit)) {
		const roadmapDir = await ctx.getRoadmapDirectoryName();
		const repoRoot = await ctx.stageRoadmapDirectory(roadmapDir);
		await ctx.commitChanges(`roadmap: Add decision ${decision.id}`, repoRoot);
	}
}

export async function updateDecisionFromContent(
	ctx: DecisionContext,
	decisionId: string,
	content: string,
	autoCommit?: boolean,
): Promise<void> {
	const existingDecision = await ctx.loadDecision(decisionId);
	if (!existingDecision) {
		throw new Error(`Decision ${decisionId} not found`);
	}

	// Parse the markdown content to extract the decision data
	const matter = await import("gray-matter");
	const { data } = matter.default(content);

	const extractSection = (
		content: string,
		sectionName: string,
	): string | undefined => {
		const regex = new RegExp(`## ${sectionName}\\s*([\\s\\S]*?)(?=## |$)`, "i");
		const match = content.match(regex);
		return match ? match[1]?.trim() : undefined;
	};

	const updatedDecision = {
		...existingDecision,
		title: data.title || existingDecision.title,
		status: data.status || existingDecision.status,
		date: data.date || existingDecision.date,
		context: extractSection(content, "Context") || existingDecision.context,
		decision: extractSection(content, "Decision") || existingDecision.decision,
		consequences:
			extractSection(content, "Consequences") ||
			existingDecision.consequences,
		alternatives:
			extractSection(content, "Alternatives") ||
			existingDecision.alternatives,
	};

	await ctx.createDecision(updatedDecision, autoCommit);
}

export async function createDecisionWithTitle(
	ctx: DecisionContext,
	core: Core,
	title: string,
	autoCommit?: boolean,
): Promise<Decision> {
	// Import the generateNextDecisionId function from CLI
	const { generateNextDecisionId } = await import("../../cli.js");
	const id = await generateNextDecisionId(core);

	const decision: Decision = {
		id,
		title,
		date: new Date().toISOString().slice(0, 16).replace("T", " "),
		status: "proposed",
		context: "[Describe the context and problem that needs to be addressed]",
		decision: "[Describe the decision that was made]",
		consequences: "[Describe the consequences of this decision]",
		alternatives: "[Describe the alternatives considered]",
		rawContent: "",
	};

	await ctx.createDecision(decision, autoCommit);
	return decision;
}
