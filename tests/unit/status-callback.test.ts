import assert from "node:assert";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { executeStatusCallback } from "../../src/utils/status-callback.ts";
import { expect } from "../support/test-utils.ts";

describe("Status Change Callbacks", () => {
	describe("executeStatusCallback", () => {
		const testCwd = process.cwd();

		test("executes command with environment variables", async () => {
			const result = await executeStatusCallback({
				command:
					'echo "Proposal: $STATE_ID, Old: $OLD_STATUS, New: $NEW_STATUS, Title: $STATE_TITLE"',
				proposalId: "proposal-123",
				oldStatus: "Potential",
				newStatus: "Active",
				proposalTitle: "Test Proposal",
				cwd: testCwd,
			});

			assert.strictEqual(result.success, true);
			assert.ok(result.output?.includes("Proposal: proposal-123"));
			assert.ok(result.output?.includes("Old: Potential"));
			assert.ok(result.output?.includes("New: Active"));
			assert.ok(result.output?.includes("Title: Test Proposal"));
		});

		test("returns success false for failing command", async () => {
			const result = await executeStatusCallback({
				command: "exit 1",
				proposalId: "proposal-123",
				oldStatus: "Potential",
				newStatus: "Complete",
				proposalTitle: "Test Proposal",
				cwd: testCwd,
			});

			assert.strictEqual(result.success, false);
			assert.strictEqual(result.exitCode, 1);
		});

		test("returns error for empty command", async () => {
			const result = await executeStatusCallback({
				command: "",
				proposalId: "proposal-123",
				oldStatus: "Potential",
				newStatus: "Complete",
				proposalTitle: "Test Proposal",
				cwd: testCwd,
			});

			assert.strictEqual(result.success, false);
			assert.strictEqual(result.error, "Empty command");
		});

		test("captures stderr on failure", async () => {
			const result = await executeStatusCallback({
				command: 'echo "error message" >&2 && exit 1',
				proposalId: "proposal-123",
				oldStatus: "Potential",
				newStatus: "Complete",
				proposalTitle: "Test Proposal",
				cwd: testCwd,
			});

			assert.strictEqual(result.success, false);
			assert.ok(result.error?.includes("error message"));
		});

		test("handles special characters in variables", async () => {
			const result = await executeStatusCallback({
				command: 'echo "$STATE_TITLE"',
				proposalId: "proposal-123",
				oldStatus: "Potential",
				newStatus: "Complete",
				proposalTitle: 'Proposal with "quotes" and $pecial chars',
				cwd: testCwd,
			});

			assert.strictEqual(result.success, true);
			assert.ok(
				result.output?.includes('Proposal with "quotes" and $pecial chars'),
			);
		});
	});

	describe("Core.updateProposalFromInput with callbacks", () => {
		let testDir: string;
		let core: Core;
		let callbackOutputFile: string;

		beforeEach(async () => {
			testDir = join(tmpdir(), `roadmap-callback-test-${Date.now()}`);
			await mkdir(testDir, { recursive: true });
			await mkdir(join(testDir, "roadmap", "proposals"), { recursive: true });

			callbackOutputFile = join(testDir, "callback-output.txt");

			core = new Core(testDir);
		});

		afterEach(async () => {
			try {
				await rm(testDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		});

		test("triggers global callback on status change", async () => {
			// Create config with onStatusChange
			const configContent = `projectName: Test
statuses:
  - Potential
  - Active
  - Complete
labels: []
directives: []
dateFormat: yyyy-mm-dd
onStatusChange: 'echo "$STATE_ID:$OLD_STATUS->$NEW_STATUS" > ${callbackOutputFile}'
`;
			await writeFile(join(testDir, "roadmap", "config.yml"), configContent);

			// Verify config was written correctly
			const writtenConfig = await await readFile(
				join(testDir, "roadmap", "config.yml"),
				"utf-8",
			);
			assert.ok(writtenConfig.includes("onStatusChange"));

			// Create a proposal
			const { proposal } = await core.createProposalFromInput({
				title: "Test Callback Proposal",
				status: "Potential",
			});

			// Invalidate config cache to ensure fresh read
			core.fs.invalidateConfigCache();

			// Update status
			await core.updateProposalFromInput(proposal.id, { status: "Active" });

			// Wait a bit for async callback
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Check callback was executed
			const output = await await readFile(callbackOutputFile, "utf-8");
			expect(output.trim()).toBe(`${proposal.id}:Potential->Active`);
		});

		test("per-proposal callback overrides global callback", async () => {
			// Create config with global onStatusChange
			const configContent = `projectName: Test
statuses:
  - Potential
  - Active
  - Complete
labels: []
directives: []
dateFormat: yyyy-mm-dd
onStatusChange: 'echo "global" > ${callbackOutputFile}'
`;
			await writeFile(join(testDir, "roadmap", "config.yml"), configContent);

			// Create a proposal with per-proposal callback
			const proposalContent = `---
id: proposal-1
title: Proposal with custom callback
status: Potential
assignee: []
created_date: 2025-01-01
labels: []
dependencies: []
onStatusChange: 'echo "per-proposal:$NEW_STATUS" > ${callbackOutputFile}'
---
`;
			await writeFile(
				join(
					testDir,
					"roadmap",
					"proposals",
					"proposal-1 - Proposal with custom callback.md",
				),
				proposalContent,
			);

			// Update status
			await core.updateProposalFromInput("proposal-1", { status: "Complete" });

			// Wait a bit for async callback
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Check per-proposal callback was executed (not global)
			const output = await await readFile(callbackOutputFile, "utf-8");
			expect(output.trim()).toBe("per-proposal:Complete");
		});

		test("no callback when status unchanged", async () => {
			// Create config with onStatusChange
			const configContent = `projectName: Test
statuses:
  - Potential
  - Active
  - Complete
labels: []
directives: []
dateFormat: yyyy-mm-dd
onStatusChange: 'echo "callback-ran" > ${callbackOutputFile}'
`;
			await writeFile(join(testDir, "roadmap", "config.yml"), configContent);

			// Create a proposal
			const { proposal } = await core.createProposalFromInput({
				title: "Test No Callback Proposal",
				status: "Potential",
			});

			// Update something other than status
			await core.updateProposalFromInput(proposal.id, {
				title: "Updated Title",
			});

			// Wait a bit
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Check callback was NOT executed
			const exists = stat(callbackOutputFile)
				.then(() => true)
				.catch(() => false);
			assert.strictEqual(exists, false);
		});

		test("no callback when no callback configured", async () => {
			// Create config without onStatusChange
			const configContent = `projectName: Test
statuses:
  - Potential
  - Active
  - Complete
labels: []
directives: []
dateFormat: yyyy-mm-dd
`;
			await writeFile(join(testDir, "roadmap", "config.yml"), configContent);

			// Create a proposal
			const { proposal } = await core.createProposalFromInput({
				title: "Test No Config Proposal",
				status: "Potential",
			});

			// Update status - should not fail even without callback
			const result = await core.updateProposalFromInput(proposal.id, {
				status: "Active",
			});
			assert.strictEqual(result.status, "Active");
		});

		test("callback failure does not block status change", async () => {
			// Create config with failing callback
			const configContent = `projectName: Test
statuses:
  - Potential
  - Active
  - Complete
labels: []
directives: []
dateFormat: yyyy-mm-dd
onStatusChange: 'exit 1'
`;
			await writeFile(join(testDir, "roadmap", "config.yml"), configContent);

			// Create a proposal
			const { proposal } = await core.createProposalFromInput({
				title: "Test Failing Callback Proposal",
				status: "Potential",
			});

			// Update status - should succeed even if callback fails
			const result = await core.updateProposalFromInput(proposal.id, {
				status: "Complete",
			});
			assert.strictEqual(result.status, "Complete");
		});

		test("triggers callback when reorderProposal changes status", async () => {
			// Create config with onStatusChange
			const configContent = `projectName: Test
statuses:
  - Potential
  - Active
  - Complete
labels: []
directives: []
dateFormat: yyyy-mm-dd
onStatusChange: 'echo "$STATE_ID:$OLD_STATUS->$NEW_STATUS" >> ${callbackOutputFile}'
`;
			await writeFile(join(testDir, "roadmap", "config.yml"), configContent);

			// Create a proposal in "Potential"
			const { proposal } = await core.createProposalFromInput({
				title: "Reorder Callback Test",
				status: "Potential",
			});

			// Invalidate config cache
			core.fs.invalidateConfigCache();

			// Reorder proposal to "Active" column (simulating board drag)
			await core.reorderProposal({
				proposalId: proposal.id,
				targetStatus: "Active",
				orderedProposalIds: [proposal.id],
			});

			// Wait for callback
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Check callback was executed
			const output = await await readFile(callbackOutputFile, "utf-8");
			expect(output.trim()).toBe(`${proposal.id}:Potential->Active`);
		});
	});
});
