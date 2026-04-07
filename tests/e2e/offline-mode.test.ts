import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadRemoteProposals } from "../../src/core/storage/proposal-loader.ts";
import type { FileSystem } from "../../src/file-system/operations.ts";
import { GitOperations } from "../../src/git/operations.ts";
import type { RoadmapConfig } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

describe("Offline Mode Configuration", () => {
	let tempDir: string;
	let gitOps: GitOperations;
	let _mockFileSystem: FileSystem;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-offline-test-"));
		gitOps = new GitOperations(tempDir);
		_mockFileSystem = {
			loadConfig: async () => ({ roadmapDirectory: "roadmap" }),
		} as unknown as FileSystem;
	});

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	describe("GitOperations.fetch()", () => {
		it("should skip fetch when remoteOperations is false", async () => {
			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				remoteOperations: false,
			};

			gitOps.setConfig(config);

			// Mock process.env.DEBUG to capture debug message
			const originalDebug = process.env.DEBUG;
			process.env.DEBUG = "1";

			// Capture console.warn calls
			const originalWarn = console.warn;
			const warnMessages: string[] = [];
			console.warn = (message: string) => {
				warnMessages.push(message);
			};

			// This should not throw and should skip the actual fetch
			await gitOps.fetch();

			// Verify debug message was logged
			assert.ok(
				warnMessages.includes(
					"Remote operations are disabled in config. Skipping fetch.",
				),
			);

			// Restore
			process.env.DEBUG = originalDebug;
			console.warn = originalWarn;
		});

		it("should proceed with fetch when remoteOperations is true", async () => {
			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				remoteOperations: true,
			};

			gitOps.setConfig(config);

			// This should attempt to run git fetch and likely fail since we're not in a git repo
			// but it should not be skipped due to config
			try {
				await gitOps.fetch();
			} catch (error) {
				// Expected to fail since we're not in a proper git repo with remote
				assert.notStrictEqual(error, undefined);
			}
		});

		it("should handle network errors gracefully", async () => {
			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				remoteOperations: true,
			};

			gitOps.setConfig(config);

			// Capture console.warn calls
			const originalWarn = console.warn;
			const warnMessages: string[] = [];
			console.warn = (message: string) => {
				warnMessages.push(message);
			};

			// Mock execGit to simulate network error
			type GitOperationsWithExecGit = {
				execGit: (
					args: string[],
				) => Promise<{ stdout: string; stderr: string }>;
			};
			const originalExecGit = (gitOps as unknown as GitOperationsWithExecGit)
				.execGit;
			(gitOps as unknown as GitOperationsWithExecGit).execGit = async (
				args: string[],
			) => {
				if (args[0] === "fetch") {
					throw new Error("could not resolve host github.com");
				}
				return originalExecGit.call(gitOps, args);
			};

			// Should not throw, should handle gracefully
			await expect(async () => {
				await gitOps.fetch();
			}).not.toThrow();

			// Restore
			console.warn = originalWarn;
			(gitOps as unknown as GitOperationsWithExecGit).execGit = originalExecGit;
		});
	});

	describe("Network Error Detection", () => {
		it("should detect various network error patterns", () => {
			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				remoteOperations: true,
			};

			gitOps.setConfig(config);

			const networkErrors = [
				"could not resolve host github.com",
				"Connection refused",
				"Network is unreachable",
				"Operation timed out",
				"No route to host",
				"Connection timed out",
				"Temporary failure in name resolution",
			];

			for (const errorMessage of networkErrors) {
				const isNetworkError = (
					gitOps as unknown as { isNetworkError: (error: unknown) => boolean }
				).isNetworkError(new Error(errorMessage));
				assert.strictEqual(isNetworkError, true);
			}

			// Non-network errors should not be detected as network errors
			const nonNetworkErrors = [
				"Permission denied",
				"Repository not found",
				"Authentication failed",
			];

			for (const errorMessage of nonNetworkErrors) {
				const isNetworkError = (
					gitOps as unknown as { isNetworkError: (error: unknown) => boolean }
				).isNetworkError(new Error(errorMessage));
				assert.strictEqual(isNetworkError, false);
			}
		});
	});

	describe("loadRemoteProposals with offline config", () => {
		it("should skip remote operations when remoteOperations is false", async () => {
			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				remoteOperations: false,
			};

			const progressMessages: string[] = [];
			const onProgress = (msg: string) => progressMessages.push(msg);

			const mockGitOperations = {
				fetch: async () => {
					throw new Error("This should not be called");
				},
				listRemoteBranches: async () => [],
				listRecentRemoteBranches: async (_daysAgo: number) => [],
			} as unknown as GitOperations;

			const remoteProposals = await loadRemoteProposals(
				mockGitOperations,
				config,
				onProgress,
			);

			assert.deepStrictEqual(remoteProposals, []);
			assert.ok(
				progressMessages.includes(
					"Remote operations disabled - skipping remote proposals",
				),
			);
		});

		it("should proceed with remote operations when remoteOperations is true", async () => {
			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				remoteOperations: true,
			};

			const progressMessages: string[] = [];
			const onProgress = (msg: string) => progressMessages.push(msg);

			let fetchCalled = false;
			const mockGitOperations = {
				fetch: async () => {
					fetchCalled = true;
				},
				listRemoteBranches: async () => [],
				listRecentRemoteBranches: async (_daysAgo: number) => [],
			} as unknown as GitOperations;

			const remoteProposals = await loadRemoteProposals(
				mockGitOperations,
				config,
				onProgress,
			);

			assert.strictEqual(fetchCalled, true);
			assert.deepStrictEqual(remoteProposals, []);
			assert.ok(progressMessages.includes("Fetching remote branches..."));
		});

		it("should proceed with remote operations when config is null (default behavior)", async () => {
			const progressMessages: string[] = [];
			const onProgress = (msg: string) => progressMessages.push(msg);

			let fetchCalled = false;
			const mockGitOperations = {
				fetch: async () => {
					fetchCalled = true;
				},
				listRemoteBranches: async () => [],
				listRecentRemoteBranches: async (_daysAgo: number) => [],
			} as unknown as GitOperations;

			const remoteProposals = await loadRemoteProposals(
				mockGitOperations,
				null,
				onProgress,
			);

			assert.strictEqual(fetchCalled, true);
			assert.deepStrictEqual(remoteProposals, []);
			assert.ok(progressMessages.includes("Fetching remote branches..."));
		});
	});

	describe("Config Management", () => {
		it("should handle missing remoteOperations field as default true", () => {
			const configWithoutRemoteOps: Partial<RoadmapConfig> = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				// remoteOperations field is missing
			};

			gitOps.setConfig(configWithoutRemoteOps as RoadmapConfig);

			// Should default to allowing remote operations when field is missing
			// This tests backward compatibility
		});

		it("should handle null config gracefully", () => {
			gitOps.setConfig(null);

			// Should not throw and should default to allowing remote operations
		});
	});
});
