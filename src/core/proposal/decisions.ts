import type { Decision } from "../../types/index.ts";

export interface DecisionDeps {
	saveDecision(decision: Decision): Promise<void>;
	loadDecision(id: string): Promise<Decision | null>;
	recordPulse(event: {
		type: string;
		id: string;
		title: string;
		impact: string;
	}): Promise<void>;
	commitIfNeeded(message: string, autoCommit?: boolean): Promise<void>;
}

export async function createDecision(
	deps: DecisionDeps,
	decision: Decision,
	autoCommit?: boolean,
): Promise<void> {
	await deps.saveDecision(decision);

	await deps.recordPulse({
		type: "decision_made",
		id: decision.id,
		title: decision.title,
		impact: `Status: ${decision.status}`,
	});

	await deps.commitIfNeeded(`roadmap: Add decision ${decision.id}`, autoCommit);
}

export async function updateDecisionFromContent(
	deps: DecisionDeps,
	decisionId: string,
	content: string,
	autoCommit?: boolean,
): Promise<void> {
	const existingDecision = await deps.loadDecision(decisionId);
	if (!existingDecision) {
		throw new Error(`Decision ${decisionId} not found`);
	}

	const matter = await import("gray-matter");
	const { data } = matter.default(content);

	const extractSection = (
		body: string,
		sectionName: string,
	): string | undefined => {
		const regex = new RegExp(
			`## ${sectionName}\\s*([\\s\\S]*?)(?=## |$)`,
			"i",
		);
		const match = body.match(regex);
		return match ? match[1]?.trim() : undefined;
	};

	const updatedDecision = {
		...existingDecision,
		title: data.title || existingDecision.title,
		status: data.status || existingDecision.status,
		date: data.date || existingDecision.date,
		context: extractSection(content, "Context") || existingDecision.context,
		decision:
			extractSection(content, "Decision") || existingDecision.decision,
		consequences:
			extractSection(content, "Consequences") ||
			existingDecision.consequences,
		alternatives:
			extractSection(content, "Alternatives") ||
			existingDecision.alternatives,
	};

	await createDecision(deps, updatedDecision, autoCommit);
}
