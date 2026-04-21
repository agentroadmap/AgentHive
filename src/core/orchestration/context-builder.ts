import { query } from "../../infra/postgres/pool.ts";
import {
	buildContextPackage,
	type ContextSection,
	type TaskType,
} from "./token-efficiency.ts";
import { getProposal, listAcceptanceCriteria } from "../../infra/postgres/proposal-storage-v2.ts";

interface ProposalDecisionRow {
	decision: string;
	authority: string;
	rationale: string | null;
	decided_at: Date;
}

interface ProposalDiscussionRow {
	author_identity: string;
	context_prefix: string | null;
	body: string;
	created_at: Date;
}

interface ProposalMemoryRow {
	agent_identity: string;
	layer: string;
	key: string;
	value: string | null;
	updated_at: Date;
}

interface ProposalReviewRow {
	reviewer_identity: string;
	verdict: string;
	notes: string | null;
	findings: string | null;
	reviewed_at: Date;
}

function summarizeText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text.trim();
	return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatAcs(
	criteria: Awaited<ReturnType<typeof listAcceptanceCriteria>>,
): string {
	if (criteria.length === 0) return "No acceptance criteria recorded.";
	return criteria
		.map((criterion) => {
			const status = criterion.status ?? "pending";
			return `- [${status}] AC-${criterion.item_number}: ${criterion.criterion_text}`;
		})
		.join("\n");
}

function formatDecisions(rows: ProposalDecisionRow[]): string {
	if (rows.length === 0) return "No recorded decisions yet.";
	return rows
		.map((row) => {
			const rationale = row.rationale ? ` — ${row.rationale}` : "";
			return `- ${row.decision} by ${row.authority} at ${row.decided_at.toISOString()}${rationale}`;
		})
		.join("\n");
}

function formatDiscussions(rows: ProposalDiscussionRow[]): string {
	if (rows.length === 0) return "No recent discussions.";
	return rows
		.map((row) => {
			const prefix = row.context_prefix ? `${row.context_prefix} ` : "";
			return `- ${prefix}${row.author_identity} @ ${row.created_at.toISOString()}: ${summarizeText(row.body, 240)}`;
		})
		.join("\n");
}

function formatMemory(rows: ProposalMemoryRow[]): string {
	if (rows.length === 0) return "No shared memory entries found.";
	return rows
		.map((row) => {
			const value = row.value ?? "";
			return `- ${row.agent_identity}/${row.layer}/${row.key}: ${summarizeText(value, 180)}`;
		})
		.join("\n");
}

function formatReviews(rows: ProposalReviewRow[]): string {
	if (rows.length === 0) return "No reviews recorded.";
	return rows
		.map((row) => {
			const parts = [`- **${row.verdict}** by ${row.reviewer_identity} @ ${row.reviewed_at.toISOString()}`];
			if (row.notes) parts.push(`  Notes: ${summarizeText(row.notes, 300)}`);
			if (row.findings) {
				try {
					const parsed = JSON.parse(row.findings);
					const summary = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
					parts.push(`  Findings: ${summarizeText(summary, 200)}`);
				} catch {
					parts.push(`  Findings: ${summarizeText(row.findings, 200)}`);
				}
			}
			return parts.join("\n");
		})
		.join("\n");
}

export async function buildProposalContextPackage(params: {
	proposalId: string | number;
	taskType: TaskType;
	agentIdentity?: string;
	maxTokens?: number;
}): Promise<string> {
	const proposal = await getProposal(params.proposalId);
	if (!proposal) {
		throw new Error(`Proposal ${params.proposalId} not found.`);
	}

	const [acs, decisions, discussions, memoryRows, reviews] = await Promise.all([
		listAcceptanceCriteria(proposal.id),
		query<ProposalDecisionRow>(
			`SELECT decision, authority, rationale, decided_at
       FROM roadmap_proposal.proposal_decision
       WHERE proposal_id = $1
       ORDER BY decided_at DESC
       LIMIT 3`,
			[proposal.id],
		).then((result) => result.rows),
		query<ProposalDiscussionRow>(
			`SELECT author_identity, context_prefix, body, created_at
       FROM roadmap_proposal.proposal_discussions
       WHERE proposal_id = $1
       ORDER BY created_at DESC
       LIMIT 3`,
			[proposal.id],
		).then((result) => result.rows),
		query<ProposalMemoryRow>(
			`SELECT agent_identity, layer, key, value, updated_at
       FROM roadmap.agent_memory
       WHERE key LIKE $1
       ORDER BY updated_at DESC
       LIMIT 5`,
			[`proposal:${proposal.display_id}%`],
		).then((result) => result.rows),
		query<ProposalReviewRow>(
			`SELECT reviewer_identity, verdict, notes, findings, reviewed_at
       FROM roadmap_proposal.proposal_reviews
       WHERE proposal_id = $1
       ORDER BY reviewed_at DESC
       LIMIT 3`,
			[proposal.id],
		).then((result) => result.rows),
	]);

	const taskType = params.taskType ?? "general";
	const relevantAcs =
		taskType === "gate_review"
			? acs.filter((ac) => ac.status !== "pass")
			: acs.slice(0, 5);

	const sections: ContextSection[] = [
		{
			title: "Proposal",
			priority: 1,
			body: [
				`[${proposal.display_id}] ${proposal.title}`,
				`Status: ${proposal.status}`,
				`Maturity: ${proposal.maturity}`,
				proposal.summary ? `Summary: ${summarizeText(proposal.summary, 500)}` : "",
				proposal.motivation
					? `Motivation: ${summarizeText(proposal.motivation, 500)}`
					: "",
				proposal.design ? `Design: ${summarizeText(proposal.design, 500)}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		},
		{
			title: "Acceptance Criteria",
			priority: 2,
			body: formatAcs(relevantAcs),
		},
		{
			title: "Recent Decisions",
			priority: 3,
			body: formatDecisions(decisions),
		},
		{
			title: "Recent Discussions",
			priority: 4,
			body: formatDiscussions(discussions),
		},
		{
			title: "Shared Memory",
			priority: 5,
			body: formatMemory(memoryRows),
		},
		{
			title: "Reviews",
			priority: 6,
			body: formatReviews(reviews),
		},
	];

	if (proposal.dependency) {
		sections.push({
			title: "Dependencies",
			priority: 7,
			body: summarizeText(proposal.dependency, 600),
		});
	}

	if (params.agentIdentity) {
		sections.push({
			title: "Agent Context",
			priority: 8,
			body: `Agent: ${params.agentIdentity}\nTask type: ${taskType}`,
		});
	}

	return buildContextPackage({
		proposalId: proposal.display_id,
		taskType,
		taskSummary: `Work on ${proposal.display_id} (${taskType})`,
		sections,
		maxTokens: params.maxTokens ?? 2000,
	});
}
