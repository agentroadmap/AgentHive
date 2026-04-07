import assert from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("proposal-26 Compatibility", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = createUniqueTestDir("test-proposal-26-compat");
		await mkdir(repoDir, { recursive: true });
	});

	afterEach(async () => {
		await safeCleanup(repoDir);
	});

	it("should find proposals in legacy 'nodes/' directory if 'proposals/' is missing", async () => {
		// Create roadmap structure with legacy nodes/
		await mkdir(join(repoDir, "roadmap", "nodes"), { recursive: true });
		await writeFile(
			join(repoDir, "roadmap", "config.yml"),
			"project_name: 'Legacy Project'",
		);

		// Create a legacy proposal file
		const proposalContent = `---
id: proposal-1
title: Legacy Proposal
status: Potential
---
Legacy content
`;
		await writeFile(
			join(repoDir, "roadmap", "nodes", "proposal-1 - Legacy-Proposal.md"),
			proposalContent,
		);

		const core = new Core(repoDir);
		const proposals = await core.listProposalsWithMetadata();

		assert.strictEqual(
			proposals.length,
			1,
			"Should find 1 proposal in legacy nodes/ directory",
		);
		assert.strictEqual(proposals[0]?.title, "Legacy Proposal");
		assert.strictEqual(proposals[0]?.id, "proposal-1");
	});

	it("should prioritize 'proposals/' over 'nodes/' if both exist", async () => {
		await mkdir(join(repoDir, "roadmap", "proposals"), { recursive: true });
		await mkdir(join(repoDir, "roadmap", "nodes"), { recursive: true });
		await writeFile(
			join(repoDir, "roadmap", "config.yml"),
			"project_name: 'Mixed Project'",
		);

		await writeFile(
			join(repoDir, "roadmap", "proposals", "proposal-1 - New-Proposal.md"),
			`---
id: proposal-1
title: New Proposal
---`,
		);
		await writeFile(
			join(repoDir, "roadmap", "nodes", "proposal-2 - Old-Proposal.md"),
			`---
id: proposal-2
title: Old Proposal
---`,
		);

		const core = new Core(repoDir);
		const proposals = await core.listProposalsWithMetadata();

		assert.strictEqual(
			proposals.length,
			1,
			"Should only find proposals in proposals/ directory",
		);
		assert.strictEqual(proposals[0]?.title, "New Proposal");
	});

	it("should find drafts in legacy 'archive/drafts/' if 'drafts/' is missing", async () => {
		await mkdir(join(repoDir, "roadmap", "archive", "drafts"), {
			recursive: true,
		});
		await writeFile(
			join(repoDir, "roadmap", "config.yml"),
			"project_name: 'Legacy Drafts'",
		);
		await writeFile(
			join(repoDir, "roadmap", "archive", "drafts", "draft-1 - Proposal.md"),
			"Draft content",
		);

		const core = new Core(repoDir);
		const drafts = await core.filesystem.listDrafts();
		assert.strictEqual(
			drafts.length,
			1,
			"Should find 1 draft in legacy archive/drafts/ directory",
		);
	});

	it("should find archived proposals in legacy 'completed/' if 'archive/proposals/' is missing", async () => {
		await mkdir(join(repoDir, "roadmap", "completed"), { recursive: true });
		await writeFile(
			join(repoDir, "roadmap", "config.yml"),
			"project_name: 'Legacy Completed'",
		);
		await writeFile(
			join(repoDir, "roadmap", "completed", "proposal-1 - Done.md"),
			"Done content",
		);

		const core = new Core(repoDir);
		const archived = await core.filesystem.listArchivedProposals();
		assert.strictEqual(
			archived.length,
			1,
			"Should find 1 archived proposal in legacy completed/ directory",
		);
	});

	it("should initialize new projects with schemaVersion 2", async () => {
		const core = new Core(repoDir);
		const { initializeProject } = await import(
			"../../src/core/infrastructure/init.ts"
		);
		await initializeProject(core, {
			projectName: "New Project",
			integrationMode: "cli",
		});

		const config = await core.filesystem.loadConfig();
		assert.strictEqual(
			config?.schemaVersion,
			2,
			"New projects should have schemaVersion 2",
		);
	});
});
