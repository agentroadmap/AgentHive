import { execSync } from "node:child_process";
import { getMcpUrl, getDaemonUrl } from "../../shared/runtime/endpoints.ts";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import type { Core } from "../../core/roadmap.ts";

export async function runOrchestrateCommand(
	core: Core,
	numAgentsStr: string | undefined,
): Promise<void> {
	clack.intro("🤖 Multi-Agent Orchestration Setup");

	const rootDir = core.filesystem.rootDir;
	const worktreesDir = join(rootDir, "worktrees");

	// Load config to check for daemon mode
	const config = await core.filesystem.loadConfig();
	const daemonUrl = config?.daemonUrl;
	const daemonMode = !!daemonUrl;

	if (daemonMode) {
		clack.note(
			`Daemon mode active (${daemonUrl}). Agents will use HTTP API instead of symlinks.`,
			"🔗 Daemon Mode",
		);
	}

	let numAgents = 3;
	if (numAgentsStr) {
		const parsed = Number.parseInt(numAgentsStr, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			numAgents = parsed;
		}
	} else {
		const result = await clack.text({
			message: "How many executor agents would you like to initialize?",
			defaultValue: "3",
			placeholder: "3",
		});
		if (clack.isCancel(result)) {
			clack.cancel("Operation cancelled.");
			return;
		}
		const parsed = Number.parseInt(result, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			numAgents = parsed;
		}
	}

	const spin = clack.spinner();
	spin.start("Setting up Coordinator/Tester environment...");

	// Add worktrees to gitignore
	try {
		const gitignorePath = join(rootDir, ".gitignore");
		const ignoreContent = await readFile(gitignorePath, "utf-8").catch(
			() => "",
		);
		if (!ignoreContent.includes("worktrees/")) {
			await writeFile(
				gitignorePath,
				`${ignoreContent}\n# Agent worktrees\nworktrees/\n`,
			);
		}
	} catch (_e) {
		// Ignore if gitignore manipulation fails
	}

	await mkdir(worktreesDir, { recursive: true });

	// Ensure coordinator/tester identity is set on main if not already configured
	try {
		const currentName = execSync("git config user.name", { stdio: "pipe" })
			.toString()
			.trim();
		if (!currentName) {
			execSync('git config user.name "Coordinator (Human/Agent)"', {
				stdio: "ignore",
			});
		}
	} catch {
		try {
			execSync('git config user.name "Coordinator (Human/Agent)"', {
				stdio: "ignore",
			});
		} catch {}
	}

	spin.stop("Coordinator environment ready.");

	for (let i = 1; i <= numAgents; i++) {
		const agentName = `agent-${i}`;
		const role = `Feature-Executor-${i}`;
		await setupAgentWorktree(rootDir, worktreesDir, agentName, role, {
			daemonMode,
			daemonUrl,
		});
	}

	clack.outro(`✅ Successfully initialized ${numAgents} agent workspaces in ./worktrees/
  
To interact as an agent, cd into the worktree:
  cd worktrees/agent-1
  
Each workspace has its own git identity pre-configured for auditability.`);
}

export async function runAgentJoinCommand(
	core: Core,
	agentName: string,
	role?: string,
): Promise<void> {
	clack.intro(`🤖 Adding Agent: ${agentName}`);
	const rootDir = core.filesystem.rootDir;
	const worktreesDir = join(rootDir, "worktrees");

	const finalRole = role || "Specialist";

	// Load config to check for daemon mode
	const config = await core.filesystem.loadConfig();
	const daemonUrl = config?.daemonUrl;
	const daemonMode = !!daemonUrl;

	await mkdir(worktreesDir, { recursive: true });
	await setupAgentWorktree(rootDir, worktreesDir, agentName, finalRole, {
		daemonMode,
		daemonUrl,
	});

	clack.outro(`✅ Agent ${agentName} joined successfully.
Workspace: ./worktrees/${agentName}`);
}

interface WorktreeSetupOptions {
	daemonMode?: boolean;
	daemonUrl?: string;
}

async function setupAgentWorktree(
	rootDir: string,
	worktreesDir: string,
	agentName: string,
	role: string,
	options?: WorktreeSetupOptions,
) {
	const spin = clack.spinner();
	spin.start(`Provisioning workspace for ${agentName}...`);

	const branchName = `feature-${agentName}`;
	const agentDir = join(worktreesDir, agentName);
	const useDaemon = options?.daemonMode ?? false;
	const daemonUrl = options?.daemonUrl;

	try {
		// Check if worktree already exists
		const worktreeList = execSync("git worktree list", {
			cwd: rootDir,
			stdio: "pipe",
		}).toString();
		if (worktreeList.includes(agentDir)) {
			spin.stop(`Workspace for ${agentName} already exists.`);
			return;
		}

		// Try to create branch and worktree
		try {
			execSync(`git branch ${branchName}`, { cwd: rootDir, stdio: "ignore" });
		} catch {
			// Branch might already exist
		}

		execSync(`git worktree add "${agentDir}" ${branchName}`, {
			cwd: rootDir,
			stdio: "ignore",
		});

		// AC#2: Skip symlink creation when daemon mode is active
		if (useDaemon) {
			// Daemon mode: no symlink needed, agents use HTTP API
			spin.message(`Configuring daemon mode for ${agentName}...`);
		} else {
			// Legacy mode: Share the entire roadmap directory via symlink
			const sharedRoadmapDir = join(rootDir, "roadmap");
			const agentRoadmapDir = join(agentDir, "roadmap");
			await mkdir(sharedRoadmapDir, { recursive: true });
			await rm(agentRoadmapDir, { recursive: true, force: true });

			try {
				await symlink(
					sharedRoadmapDir,
					agentRoadmapDir,
					process.platform === "win32" ? "junction" : "dir",
				);
			} catch (error) {
				throw new Error(
					`Failed to create shared roadmap symlink for ${agentName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			// Suppress git noise for the symlinked roadmap directory in the worktree
			try {
				execSync(
					"git ls-files -z roadmap | xargs -0 git update-index --skip-worktree",
					{
						cwd: agentDir,
						stdio: "ignore",
					},
				);
			} catch (_e) {
				// Ignore if skip-worktree fails
			}
		}

		// Configure Git identity locally for the agent's worktree
		const gitUserName = `${agentName} (${role})`;
		const gitUserEmail = `${agentName}@agent-roadmap.local`;

		// Enable worktree-specific configuration
		execSync("git config extensions.worktreeConfig true", {
			cwd: rootDir,
			stdio: "ignore",
		});

		// Set identity only for this specific worktree
		execSync(`git config --worktree user.name "${gitUserName}"`, {
			cwd: agentDir,
			stdio: "ignore",
		});
		execSync(`git config --worktree user.email "${gitUserEmail}"`, {
			cwd: agentDir,
			stdio: "ignore",
		});

		// AC#6: In daemon mode, write a local roadmap config pointing to the daemon
		// This allows CLI commands to route through the daemon API instead of symlinks
		if (useDaemon && daemonUrl) {
			const agentRoadmapDir = join(agentDir, "roadmap");
			await mkdir(agentRoadmapDir, { recursive: true });
			const agentRoadmapConfig = {
				projectName: `Agent Worktree (${agentName})`,
				daemonUrl,
				daemonMode: true,
				statuses: [
					"New",
					"Draft",
					"Review",
					"Active",
					"Accepted",
					"Complete",
					"Rejected",
					"Abandoned",
					"Replaced",
				],
				labels: [],
				dateFormat: "yyyy-mm-dd",
			};
			await writeFile(
				join(agentRoadmapDir, "config.yml"),
				Object.entries(agentRoadmapConfig)
					.map(
						([k, v]) =>
							`${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`,
					)
					.join("\n"),
			);
		}

		// 1. Configure OpenClaw (Identity, Soul, Heartbeat, Memory)
		const heartbeatSyncEndpoint =
			useDaemon && daemonUrl
				? `${daemonUrl}/api/heartbeat`
				: "${getDaemonUrl()}/api/heartbeat";
		const openClawConfig = {
			identity: {
				name: agentName,
				role: role,
				type: "executor",
			},
			soul: {
				alignment:
					"You are an autonomous agent contributing to a shared project roadmap.",
				directives: [
					"Scout local roadmap proposal",
					"Map new objectives",
					"Reach active targets",
				],
			},
			heartbeat: {
				intervalMs: 60000,
				syncEndpoint: heartbeatSyncEndpoint,
			},
			memory: {
				localStore: "./.agent-memory",
				sharedStore: useDaemon ? undefined : "../roadmap/shared",
			},
		};
		await writeFile(
			join(agentDir, "openclaw.json"),
			JSON.stringify(openClawConfig, null, 2),
		);

		// 2. Configure Claude Code (CLAUDE.md for local context)
		const claudeContext = `# Claude Code Configuration
You are operating as ${gitUserName}.
Your primary role is: ${role}.

## 🚀 YOUR FIRST MISSION
1. **Check-in**: Say hello in the group channel using \`roadmap talk\`.
2. **Understand the Vision**: Read \`../../roadmap/DNA.md\`.
3. **Scout the Roadmap**: Read \`../../roadmap/MAP.md\` and run \`roadmap proposal list -a @${agentName} --plain\`.
4. **Take Ownership**: Pick your first proposal, move it to "Active", and start the Discovery phase.
5. **Refine**: If you discover technical gaps or risks, create new proposals or obstacles.

**Directives:**
- Always check the \`roadmap/\` directory in the project root to understand your objectives.
- Do NOT push directly to remote origin. Your changes will be synced by the Coordinator.
- Update your assigned proposal files in \`roadmap/proposals/\` when you make progress.`;
		await writeFile(join(agentDir, "CLAUDE.md"), claudeContext);

		// 3. Configure Gemini CLI (GEMINI.md for local context)
		const geminiContext = `# Gemini CLI Configuration
You are operating as ${gitUserName}.
Your primary role is: ${role}.

## 🚀 YOUR FIRST MISSION
1. **Check-in**: Say hello in the group channel using \`roadmap talk\`.
2. **Understand the Vision**: Read \`../../roadmap/DNA.md\`.
3. **Scout the Roadmap**: Read \`../../roadmap/MAP.md\` and run \`roadmap proposal list -a @${agentName} --plain\`.
4. **Take Ownership**: Pick your first proposal, move it to "Active", and start the Discovery phase.
5. **Refine**: If you discover technical gaps or risks, create new proposals or obstacles.

**Directives:**
- Operate strictly within this worktree.
- Read \`roadmap/DNA.md\` and \`roadmap/MAP.md\` to align with project goals.
- Use the MCP server at \`http://localhost:6420\` for real-time roadmap updates.`;
		await writeFile(join(agentDir, "GEMINI.md"), geminiContext);

		spin.stop(`Provisioned ${agentName} (${role})`);
	} catch (error) {
		spin.stop(`Failed to provision ${agentName}`);
		console.error(error);
	}
}
