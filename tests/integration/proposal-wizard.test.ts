import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ProposalWizardCancelledError,
	type ProposalWizardPromptRunner,
	pickProposalForEditWizard,
	runProposalCreateWizard,
	runProposalEditWizard,
} from "../../src/commands/proposal-wizard.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

type PromptResponses = Record<string, string | string[]>;

function createPromptRunner(
	responses: PromptResponses,
): ProposalWizardPromptRunner {
	const proposal = new Map<string, string[]>();
	for (const [key, value] of Object.entries(responses)) {
		proposal.set(key, Array.isArray(value) ? [...value] : [value]);
	}

	return async (question) => {
		const queue = proposal.get(question.name) ?? [];
		if (queue.length === 0) {
			return { [question.name]: question.initial ?? "" };
		}
		while (queue.length > 0) {
			const candidate = queue.shift() ?? "";
			const validationResult = question.validate?.(candidate);
			if (!validationResult) {
				proposal.set(question.name, queue);
				return { [question.name]: candidate };
			}
		}
		throw new Error(`No valid prompt value remaining for '${question.name}'.`);
	};
}

describe("proposal wizard", () => {
	it("builds create input from shared wizard fields", async () => {
		const prompt = createPromptRunner({
			title: "Create from wizard",
			description: "Wizard description",
			status: "Active",
			priority: "medium",
			assignee: "alice, @bob",
			labels: "cli, wizard",
			acceptanceCriteria: "[x] First criterion, Second criterion",
			implementationPlan: "Step 1\nStep 2",
			implementationNotes: "Decision notes",
			references: "src/cli.ts, docs/plan.md",
			documentation: "docs/spec.md",
			dependencies: "proposal-1,2",
		});

		const input = await runProposalCreateWizard({
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			promptImpl: prompt,
		});

		assert.notStrictEqual(input, null);
		assert.strictEqual(input?.title, "Create from wizard");
		assert.strictEqual(input?.description, "Wizard description");
		assert.strictEqual(input?.status, "Active");
		assert.strictEqual(input?.priority, "medium");
		assert.deepStrictEqual(input?.assignee, ["alice", "@bob"]);
		assert.deepStrictEqual(input?.labels, ["cli", "wizard"]);
		assert.deepStrictEqual(input?.acceptanceCriteria, [
			{ text: "First criterion", checked: false },
			{ text: "Second criterion", checked: false },
		]);
		assert.strictEqual(input?.implementationPlan, "Step 1\nStep 2");
		assert.strictEqual(input?.implementationNotes, "Decision notes");
		assert.deepStrictEqual(input?.references, ["src/cli.ts", "docs/plan.md"]);
		assert.deepStrictEqual(input?.documentation, ["docs/spec.md"]);
		assert.deepStrictEqual(input?.dependencies, ["proposal-1", "proposal-2"]);
	});

	it("builds prefilled edit update input", async () => {
		const existingProposal: Proposal = {
			id: "proposal-9",
			title: "Old title",
			status: "Potential",
			priority: "low",
			assignee: ["alice"],
			createdDate: "2026-02-20 12:00",
			labels: ["existing"],
			dependencies: ["proposal-1"],
			references: ["docs/old.md"],
			documentation: ["docs/current.md"],
			description: "Old description",
			implementationPlan: "Old plan",
			implementationNotes: "Old notes",
			acceptanceCriteriaItems: [
				{ index: 1, text: "Old AC 1", checked: false },
				{ index: 2, text: "Old AC 2", checked: true },
			],
			rawContent: "",
		};
		const prompt = createPromptRunner({
			title: "New title",
			description: "New description",
			status: "Active",
			priority: "high",
			assignee: "alice, bob",
			labels: "existing, cli",
			acceptanceCriteria: "[x] New AC 1, [ ] New AC 2",
			implementationPlan: "New plan",
			implementationNotes: "New notes",
			references: "docs/new.md,src/cli.ts",
			documentation: "docs/spec.md",
			dependencies: "proposal-2,3",
		});

		const updateInput = await runProposalEditWizard({
			proposal: existingProposal,
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			promptImpl: prompt,
		});

		assert.notStrictEqual(updateInput, null);
		assert.strictEqual(updateInput?.title, "New title");
		assert.strictEqual(updateInput?.description, "New description");
		assert.strictEqual(updateInput?.status, "Active");
		assert.strictEqual(updateInput?.priority, "high");
		assert.deepStrictEqual(updateInput?.assignee, ["alice", "bob"]);
		assert.deepStrictEqual(updateInput?.labels, ["existing", "cli"]);
		assert.deepStrictEqual(updateInput?.dependencies, [
			"proposal-2",
			"proposal-3",
		]);
		assert.deepStrictEqual(updateInput?.references, [
			"docs/new.md",
			"src/cli.ts",
		]);
		assert.deepStrictEqual(updateInput?.documentation, ["docs/spec.md"]);
		assert.strictEqual(updateInput?.implementationPlan, "New plan");
		assert.strictEqual(updateInput?.implementationNotes, "New notes");
		assert.deepStrictEqual(updateInput?.acceptanceCriteria, [
			{ text: "New AC 1", checked: true },
			{ text: "New AC 2", checked: false },
		]);
	});

	it("supports edit picker flow", async () => {
		const prompt = createPromptRunner({
			proposalId: "proposal-2",
		});
		const selected = await pickProposalForEditWizard({
			proposals: [
				{ id: "proposal-3", title: "Third" },
				{ id: "proposal-2", title: "Second" },
				{ id: "proposal-1", title: "First" },
			],
			promptImpl: prompt,
		});

		assert.strictEqual(selected, "proposal-2");
	});

	it("returns null when wizard is cancelled", async () => {
		const cancelledPrompt: ProposalWizardPromptRunner = async () => {
			throw new ProposalWizardCancelledError();
		};

		const createInput = await runProposalCreateWizard({
			statuses: ["Potential", "Complete"],
			promptImpl: cancelledPrompt,
		});
		assert.strictEqual(createInput, null);
	});

	it("supports back navigation from step N to N-1 for text prompts", async () => {
		const asked: string[] = [];
		let titleAttempts = 0;
		let descriptionAttempts = 0;
		const prompt: ProposalWizardPromptRunner = async (question) => {
			asked.push(question.name);
			if (question.name === "title") {
				titleAttempts += 1;
				return {
					title: titleAttempts === 1 ? "Initial title" : "Updated title",
				};
			}
			if (question.name === "description") {
				descriptionAttempts += 1;
				if (descriptionAttempts === 1) {
					return { __wizardNavigation: "previous" };
				}
				return { description: "Updated description" };
			}
			return { [question.name]: question.initial ?? "" };
		};

		const input = await runProposalCreateWizard({
			statuses: ["Potential", "Complete"],
			promptImpl: prompt,
		});

		assert.notStrictEqual(input, null);
		assert.strictEqual(input?.title, "Updated title");
		assert.strictEqual(input?.description, "Updated description");
		expect(asked.slice(0, 4)).toEqual([
			"title",
			"description",
			"title",
			"description",
		]);
	});

	it("treats first-step backspace-empty navigation signal as a no-op", async () => {
		let titleAttempts = 0;
		const asked: string[] = [];
		const prompt: ProposalWizardPromptRunner = async (question) => {
			asked.push(question.name);
			if (question.name === "title") {
				titleAttempts += 1;
				if (titleAttempts === 1) {
					return { __wizardNavigation: "previous" };
				}
				return { title: "Recovered title" };
			}
			return { [question.name]: question.initial ?? "" };
		};

		const input = await runProposalCreateWizard({
			statuses: ["Potential", "Complete"],
			promptImpl: prompt,
		});

		assert.notStrictEqual(input, null);
		assert.strictEqual(input?.title, "Recovered title");
		assert.strictEqual(asked[0], "title");
		assert.strictEqual(asked[1], "title");
	});

	it("uses prompt-level validation for required title and keeps default selected status", async () => {
		const prompt = createPromptRunner({
			title: ["   ", "Validated title"],
			description: "",
			priority: "",
			assignee: "",
			labels: "",
			acceptanceCriteria: "",
			implementationPlan: "",
			implementationNotes: "",
			references: "",
			documentation: "",
			dependencies: "",
		});

		const input = await runProposalCreateWizard({
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			promptImpl: prompt,
		});

		assert.notStrictEqual(input, null);
		assert.strictEqual(input?.title, "Validated title");
		assert.strictEqual(input?.status, "Potential");
	});

	it("uses select prompts for status and priority with create defaults", async () => {
		const questions: Record<
			string,
			{
				type: string;
				message: string;
				initial?: string;
				optionsCount: number;
				optionValues: string[];
			}
		> = {};
		const prompt: ProposalWizardPromptRunner = async (question) => {
			questions[question.name] = {
				type: question.type,
				message: question.message,
				initial: question.initial,
				optionsCount: question.options?.length ?? 0,
				optionValues: (question.options ?? []).map((option) => option.value),
			};
			return { [question.name]: question.initial ?? "" };
		};

		const input = await runProposalCreateWizard({
			statuses: [
				"Roadmap",
				"Potential",
				"Active",
				"Accepted",
				"Complete",
				"Abandoned",
			],
			promptImpl: prompt,
		});

		assert.notStrictEqual(input, null);
		assert.strictEqual(input?.status, "Potential");
		assert.strictEqual(input?.priority, undefined);
		assert.strictEqual(questions.status?.type, "select");
		assert.strictEqual(questions.status?.initial, "Potential");
		assert.deepStrictEqual(questions.status?.optionValues, [
			"Draft",
			"Roadmap",
			"Potential",
			"Active",
			"Accepted",
			"Complete",
			"Abandoned",
		]);
		expect((questions.status?.optionsCount ?? 0) > 0).toBe(true);
		assert.strictEqual(questions.priority?.type, "select");
		assert.strictEqual(questions.priority?.initial, "");
		expect((questions.priority?.optionsCount ?? 0) > 0).toBe(true);
	});

	it("falls back to default statuses and keeps create default on Potential", async () => {
		const promptQuestions: Record<
			string,
			{ initial?: string; optionValues: string[] }
		> = {};
		const prompt: ProposalWizardPromptRunner = async (question) => {
			promptQuestions[question.name] = {
				initial: question.initial,
				optionValues: (question.options ?? []).map((option) => option.value),
			};
			return { [question.name]: question.initial ?? "" };
		};

		const input = await runProposalCreateWizard({
			statuses: [],
			promptImpl: prompt,
		});

		assert.notStrictEqual(input, null);
		assert.strictEqual(input?.status, "Potential");
		assert.strictEqual(promptQuestions.status?.initial, "Potential");
		assert.deepStrictEqual(promptQuestions.status?.optionValues, [
			"Draft",
			"Potential",
			"Active",
			"Accepted",
			"Complete",
			"Abandoned",
		]);
	});
});
