import assert from "node:assert";
import { describe, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Proposal, ProposalUpdateInput } from "../../src/shared/types/index.ts";

function buildProposal(overrides: Partial<Proposal> = {}): Proposal {
	return {
		id: "P475",
		title: "Test proposal",
		status: "DRAFT",
		assignee: [],
		createdDate: "2026-04-25 00:00",
		labels: [],
		dependencies: [],
		acceptanceCriteriaItems: [],
		...overrides,
	};
}

describe("Core.updateProposalFromInput postgres draft handling", () => {
	test("allows no-op saves for proposals already in the DRAFT stage", async () => {
		const proposal = buildProposal();
		const core = new Core(process.cwd(), { enableWatchers: false }) as Core & {
			loadProposalById: (proposalId: string) => Promise<Proposal | null>;
			isPostgresProposalBackend: () => Promise<boolean>;
			applyProposalUpdateInput: (
				proposal: Proposal,
				input: ProposalUpdateInput,
			) => Promise<{ proposal: Proposal; mutated: boolean }>;
			updateProposal: (proposal: Proposal) => Promise<void>;
		};

		let persisted = false;

		core.loadProposalById = async (proposalId: string) =>
			proposalId === proposal.id ? proposal : null;
		core.isPostgresProposalBackend = async () => true;
		core.applyProposalUpdateInput = async (currentProposal, input) => {
			currentProposal.acceptanceCriteriaItems = input.acceptanceCriteria ?? [];
			return { proposal: currentProposal, mutated: true };
		};
		core.updateProposal = async () => {
			persisted = true;
		};

		const updated = await core.updateProposalFromInput(proposal.id, {
			status: "DRAFT",
			acceptanceCriteria: [{ text: "AC", checked: false }],
		});

		assert.strictEqual(persisted, true);
		assert.strictEqual(updated.status, "DRAFT");
		assert.deepStrictEqual(updated.acceptanceCriteriaItems, [
			{ text: "AC", checked: false },
		]);
	});

	test("still rejects demotion to filesystem draft from another Postgres stage", async () => {
		const proposal = buildProposal({ status: "REVIEW" });
		const core = new Core(process.cwd(), { enableWatchers: false }) as Core & {
			loadProposalById: (proposalId: string) => Promise<Proposal | null>;
			isPostgresProposalBackend: () => Promise<boolean>;
		};

		core.loadProposalById = async (proposalId: string) =>
			proposalId === proposal.id ? proposal : null;
		core.isPostgresProposalBackend = async () => true;

		await assert.rejects(
			() => core.updateProposalFromInput(proposal.id, { status: "DRAFT" }),
			/Postgres-backed proposals cannot be demoted to filesystem drafts\./,
		);
	});
});
