import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentInstructionFile,
	addAgentInstructions,
	ensureMcpGuidelines,
	installClaudeAgent,
} from "../../agent-instructions.ts";
import { DEFAULT_INIT_CONFIG } from "../../constants/index.ts";
import type { RoadmapConfig } from "../../types/index.ts";
import type { Core } from "../roadmap.ts";
import { BLUEPRINTS, type BlueprintType } from "./blueprints.ts";

export const MCP_SERVER_NAME = "roadmap";
export const MCP_GUIDE_URL =
	"https://github.com/agentroadmap/agentRoadmap#-mcp-integration-model-context-protocol";

export type IntegrationMode = "mcp" | "cli" | "none";
export type McpClient = "claude" | "codex" | "gemini" | "kiro" | "guide";

/** Map MCP client name to its corresponding instruction file */
function mcpClientToFile(client: McpClient): AgentInstructionFile {
	const map: Record<McpClient, AgentInstructionFile> = {
		claude: "CLAUDE.md",
		codex: "AGENTS.md",
		gemini: "GEMINI.md",
		kiro: "AGENTS.md",
		guide: "AGENTS.md",
	};
	return map[client];
}

export interface InitializeProjectOptions {
	projectName: string;
	description?: string;
	blueprint?: BlueprintType;
	integrationMode: IntegrationMode;
	mcpClients?: McpClient[];
	agentInstructions?: AgentInstructionFile[];
	installClaudeAgent?: boolean;
	advancedConfig?: {
		checkActiveBranches?: boolean;
		remoteOperations?: boolean;
		activeBranchDays?: number;
		bypassGitHooks?: boolean;
		autoCommit?: boolean;
		zeroPaddedIds?: number;
		defaultEditor?: string;
		defaultPort?: number;
		autoOpenBrowser?: boolean;
		/** Custom proposal prefix (e.g., "JIRA"). Only set during first init, read-only after. */
		proposalPrefix?: string;
	};
	/** Existing config for re-initialization */
	existingConfig?: RoadmapConfig | null;
}

export interface InitializeProjectResult {
	success: boolean;
	projectName: string;
	description?: string;
	blueprint?: BlueprintType;
	isReInitialization: boolean;
	config: RoadmapConfig;
	mcpResults?: Record<string, string>;
	initialProposals?: {
		id: string;
		title: string;
	}[];
}

async function runMcpClientCommand(
	label: string,
	command: string,
	args: string[],
): Promise<string> {
	try {
		const child = spawn(command, args, {
			stdio: "pipe",
			shell: true,
		});

		return new Promise((resolve, reject) => {
			child.on("exit", (code) => {
				if (code === 0) {
					resolve(`Added Roadmap MCP server to ${label}`);
				} else {
					reject(new Error(`Command exited with code ${code}`));
				}
			});

			child.on("error", (error) => {
				reject(error);
			});
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Unable to configure ${label} automatically (${message}). Run manually: ${command} ${args.join(" ")}`,
		);
	}
}

/**
 * Core initialization logic shared between CLI and browser.
 * Both CLI and browser validate input before calling this function.
 */
export async function initializeProject(
	core: Core,
	options: InitializeProjectOptions,
): Promise<InitializeProjectResult> {
	const {
		projectName,
		description,
		blueprint: blueprintType,
		integrationMode,
		mcpClients = [],
		agentInstructions = [],
		installClaudeAgent: installClaudeAgentFlag = false,
		advancedConfig = {},
		existingConfig,
	} = options;

	const isReInitialization = !!existingConfig;
	const projectRoot = core.filesystem.rootDir;
	const hasDefaultEditorOverride = Object.hasOwn(
		advancedConfig,
		"defaultEditor",
	);
	const hasZeroPaddedIdsOverride = Object.hasOwn(
		advancedConfig,
		"zeroPaddedIds",
	);

	// Build config, preserving existing values for re-initialization.
	// Re-init should be idempotent for fields that init does not explicitly manage.
	const _d = DEFAULT_INIT_CONFIG;
	const baseConfig: RoadmapConfig = {
		projectName,
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
		defaultStatus: "New",
		dateFormat: "yyyy-mm-dd",
		maxColumnWidth: 20,
		autoCommit: true, // Default to true for agent orchestration
		remoteOperations: true,
		bypassGitHooks: false,
		checkActiveBranches: true,
		activeBranchDays: 30,
		defaultPort: 6420,
		autoOpenBrowser: true,
		proposalResolutionStrategy:
			existingConfig?.proposalResolutionStrategy || "most_recent",
		// Preserve existing prefixes on re-init, or use custom prefix if provided during first init
		prefixes: existingConfig?.prefixes || {
			proposal: advancedConfig.proposalPrefix || "proposal",
		},
		schemaVersion: existingConfig?.schemaVersion || 2,
	};

	const config: RoadmapConfig = {
		...baseConfig,
		...(existingConfig ?? {}),
		projectName,
	};

	// Explicitly apply advancedConfig overrides if provided
	if (advancedConfig.autoCommit !== undefined)
		config.autoCommit = advancedConfig.autoCommit;
	if (advancedConfig.remoteOperations !== undefined)
		config.remoteOperations = advancedConfig.remoteOperations;
	if (advancedConfig.bypassGitHooks !== undefined)
		config.bypassGitHooks = advancedConfig.bypassGitHooks;
	if (advancedConfig.checkActiveBranches !== undefined)
		config.checkActiveBranches = advancedConfig.checkActiveBranches;
	if (advancedConfig.activeBranchDays !== undefined)
		config.activeBranchDays = advancedConfig.activeBranchDays;
	if (advancedConfig.defaultPort !== undefined)
		config.defaultPort = advancedConfig.defaultPort;
	if (advancedConfig.autoOpenBrowser !== undefined)
		config.autoOpenBrowser = advancedConfig.autoOpenBrowser;

	if (hasDefaultEditorOverride && advancedConfig.defaultEditor) {
		config.defaultEditor = advancedConfig.defaultEditor;
	}
	if (
		hasZeroPaddedIdsOverride &&
		typeof advancedConfig.zeroPaddedIds === "number" &&
		advancedConfig.zeroPaddedIds > 0
	) {
		config.zeroPaddedIds = advancedConfig.zeroPaddedIds;
	}

	// Preserve all non-init-managed fields, but allow init-managed optional fields to be explicitly cleared.
	if (hasDefaultEditorOverride && !advancedConfig.defaultEditor) {
		delete config.defaultEditor;
	}
	if (
		hasZeroPaddedIdsOverride &&
		!(
			typeof advancedConfig.zeroPaddedIds === "number" &&
			advancedConfig.zeroPaddedIds > 0
		)
	) {
		delete config.zeroPaddedIds;
	}

	// Create structure and save config
	if (isReInitialization) {
		await core.filesystem.saveConfig(config);
	} else {
		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(config);
		await core.ensureConfigLoaded();

		// Generate DNA.md (Vision & Principles)
		const dnaContent = `# DNA: ${projectName}

## Vision
${description || "A new project managed with Roadmap.md."}

## Principles
- **Seed-to-Vision**: Every task moves us from the initial seed to the final goal.
- **Evidence-Based**: Mark proposals reached only with technical proof or terminal output.
- **Autonomous Discovery**: Agents are encouraged to refine the DAG as they discover more.
`;
		await writeFile(join(projectRoot, "roadmap", "DNA.md"), dnaContent);

		// Initialize Pulse Log and Agent Registry
		await core.recordPulse({
			type: "proposal_created",
			id: "PROJECT",
			title: projectName,
			impact: "Project initialized with Agent Utility Belt infrastructure.",
		});
		const agentsPath = await core.getAgentsFilePath();
		await writeFile(agentsPath, JSON.stringify([], null, 2));
	}

	const initialProposals: { id: string; title: string }[] = [];

	// Create initial DAG based on blueprint or single baseline if description provided
	if (!isReInitialization && (blueprintType || description)) {
		const proposalPrefix = config.prefixes?.proposal || "proposal";
		const blueprint = blueprintType ? BLUEPRINTS[blueprintType] : undefined;

		if (blueprint) {
			// Map blueprint local IDs to canonical roadmap IDs
			const idMap = new Map<string, string>();
			for (const bs of blueprint.proposals) {
				const canonicalId = config.zeroPaddedIds
					? `${proposalPrefix}-${bs.id.padStart(config.zeroPaddedIds, "0")}`
					: `${proposalPrefix}-${bs.id}`;
				idMap.set(bs.id, canonicalId);
			}

			// Create proposals
			for (const bs of blueprint.proposals) {
				const canonicalId = idMap.get(bs.id)!;
				const dependsOn = (bs.dependsOnIds ?? [])
					.map((id) => idMap.get(id))
					.filter(Boolean) as string[];

				let finalDescription = bs.description;

				// Inject user description into initial and final proposals
				if (description) {
					if (bs.isVision) {
						finalDescription = `${bs.description}\n\n## Target Goal\n${description}`;
					} else if (bs.isInitial) {
						finalDescription = `${bs.description}\n\n## Seed Inspiration\n${description}`;
					}
				}

				await core.createProposal(
					{
						id: canonicalId,
						title: bs.title,
						description: finalDescription,
						status: config.defaultStatus || "New",
						assignee: bs.assignee ?? [],
						labels: bs.labels ?? [],
						createdDate: new Date().toISOString().slice(0, 10),
						rawContent: "",
						dependencies: dependsOn,
						requires: bs.requires ?? [],
					},
					false,
				);
				initialProposals.push({ id: canonicalId, title: bs.title });
			}

			// Generate MAP.md (Visual representation)
			let mapContent = `# MAP: ${projectName} Evolution\n\n## Project Graph\n\`\`\`text\n`;
			for (const bs of blueprint.proposals) {
				const canonicalId = idMap.get(bs.id)!;
				const indent = "  ".repeat(Math.max(0, bs.dependsOnIds?.length ?? 0));
				mapContent += `${indent}+-- [${canonicalId}] ${bs.title}\n`;
			}
			mapContent += "```\n";
			await writeFile(join(projectRoot, "roadmap", "MAP.md"), mapContent);
		} else if (description) {
			// Single baseline fallback
			const id = config.zeroPaddedIds
				? `${proposalPrefix}-${"0".repeat(config.zeroPaddedIds - 1)}0`
				: `${proposalPrefix}-0`;
			await core.createProposal(
				{
					id,
					title: "Project Baseline & Requirements",
					description,
					status: config.defaultStatus || "New",
					assignee: [],
					labels: ["baseline"],
					createdDate: new Date().toISOString().slice(0, 10),
					rawContent: "",
					dependencies: [],
				},
				false,
			);
			initialProposals.push({ id, title: "Project Baseline & Requirements" });
		}
	}

	const mcpResults: Record<string, string> = {};

	// Handle MCP integration
	if (integrationMode === "mcp" && mcpClients.length > 0) {
		for (const client of mcpClients) {
			try {
				const result = await runMcpClientCommand(client, client, [
					"mcp",
					"add",
					MCP_SERVER_NAME,
					"roadmap",
					"mcp",
					"start",
				]);
				mcpResults[client] = result;
				await ensureMcpGuidelines(projectRoot, mcpClientToFile(client));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				mcpResults[client] = `Failed: ${message}`;
			}
		}
	}

	// Handle CLI integration
	if (integrationMode === "cli" && agentInstructions.length > 0) {
		await addAgentInstructions(projectRoot, undefined, agentInstructions);
	}

	// Install Claude Agent if requested
	if (installClaudeAgentFlag) {
		try {
			await installClaudeAgent(projectRoot);
			mcpResults.claudeAgent = "Successfully installed Claude Code agent";
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			mcpResults.claudeAgent = `Failed: ${message}`;
		}
	}

	return {
		success: true,
		projectName,
		description,
		isReInitialization,
		config,
		initialProposals,
		mcpResults: Object.keys(mcpResults).length > 0 ? mcpResults : undefined,
	};
}
