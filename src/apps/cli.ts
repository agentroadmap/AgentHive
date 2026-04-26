#!/usr/bin/env node

import "../core/infrastructure/ws-polyfill.ts";
import { execSync, spawn } from "node:child_process";
import { glob, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { stdin as input } from "node:process";
import { createInterface } from "node:readline/promises";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { getDaemonUrl } from "../shared/runtime/endpoints.ts";
import { resolveBoardDataSource } from "./board-source.ts";
import { initializeProject } from "../core/infrastructure/init.ts";
import {
	buildDirectiveBuckets,
	collectArchivedDirectiveKeys,
	directiveKey,
} from "../core/proposal/directives.ts";
import { computeSequences } from "../core/proposal/sequences.ts";
import {
	DEFAULT_CLAIM_DURATION_MINUTES,
	DEFAULT_DIRECTORIES,
} from "../shared/constants/index.ts";
import { formatCompactProposalListLine } from "../shared/formatters/proposal-list-plain-text.ts";
import { formatProposalPlainText } from "../shared/formatters/proposal-plain-text.ts";
import {
	type AgentStatus,
	type Decision,
	type DecisionSearchResult,
	type Directive,
	type Document as DocType,
	type DocumentSearchResult,
	EntityType,
	isLocalEditableProposal,
	type Proposal,
	type ProposalListFilter,
	type ProposalSearchResult,
	type RoadmapConfig,
	type SearchPriorityFilter,
	type SearchResult,
	type SearchResultType,
} from "../types/index.ts";
import type { ProposalEditArgs } from "../types/proposal-edit-args.ts";
import {
	type AgentSelectionValue,
	processAgentSelection,
} from "../utils/agent-selection.ts";
import {
	acceptChatMention,
	applyChatComposerKey,
	type ChatComposerProposal,
	completeChatPath,
	createChatComposerProposal,
	cycleChatMention,
	getChatMentionSuggestions,
	renderChatComposerLines,
} from "../utils/chat-composer.ts";
import { findRoadmapRoot } from "../utils/find-roadmap-root.ts";
import {
	createDirectiveFilterValueResolver,
	resolveClosestDirectiveFilterValue,
} from "../utils/milestone-filter.ts";
import { hasAnyPrefix } from "../utils/prefix-config.ts";
import {
	normalizeStringList,
	parsePositiveIndexList,
	processAcceptanceCriteriaOptions,
	processVerificationOptions,
	toStringArray,
} from "../utils/proposal-builders.ts";
import { buildProposalUpdateInput } from "../utils/proposal-edit-builder.ts";
import {
	normalizeProposalId,
	proposalIdsEqual,
} from "../utils/proposal-path.ts";
import { sortProposals } from "../utils/proposal-sorting.ts";
import {
	type RuntimeCwdResolution,
	resolveRuntimeCwd,
} from "../utils/runtime-cwd.ts";
import {
	formatValidStatuses,
	getCanonicalStatus,
	getValidStatuses,
} from "../utils/status.ts";
import { formatVersionLabel, getVersionInfo } from "../utils/version.ts";
import {
	type CompletionInstallResult,
	installCompletion,
	registerCompletionCommand,
} from "./commands/completion.ts";
import { configureAdvancedSettings } from "./commands/configure-advanced-settings.ts";
import { registerCubicCommand } from "./commands/cubic-cli.ts";
import { runDocsCommand } from "./commands/docs.ts";
import { registerMcpCommand } from "./commands/mcp.ts";
import { registerStateMachineCommand } from "./commands/state-machine.ts";
import {
	pickProposalForEditWizard,
	runProposalCreateWizard,
	runProposalEditWizard,
} from "./commands/proposal-wizard.ts";
import { sandboxCommand } from "./commands/sandbox.ts";
import {
	type AgentInstructionFile,
	addAgentInstructions,
	Core,
	type EnsureMcpGuidelinesResult,
	ensureMcpGuidelines,
	initializeGitRepository,
	installClaudeAgent,
	isGitRepository,
	updateReadmeWithBoard,
} from "./index.ts";

type IntegrationMode = "mcp" | "cli" | "none";

function normalizeIntegrationOption(value: string): IntegrationMode | null {
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "mcp" ||
		normalized === "connector" ||
		normalized === "model-context-protocol" ||
		normalized === "model_context_protocol"
	) {
		return "mcp";
	}
	if (
		normalized === "cli" ||
		normalized === "legacy" ||
		normalized === "commands" ||
		normalized === "command" ||
		normalized === "instructions" ||
		normalized === "instruction" ||
		normalized === "agent" ||
		normalized === "agents"
	) {
		return "cli";
	}
	if (
		normalized === "none" ||
		normalized === "skip" ||
		normalized === "manual" ||
		normalized === "later" ||
		normalized === "no" ||
		normalized === "off"
	) {
		return "none";
	}
	return null;
}

// Always use "roadmap" as the global MCP server name so fallback mode works when the project isn't initialized.
const MCP_SERVER_NAME = "roadmap";

const MCP_CLIENT_INSTRUCTION_MAP: Record<string, AgentInstructionFile> = {
	claude: "CLAUDE.md",
	codex: "AGENTS.md",
	gemini: "GEMINI.md",
	kiro: "AGENTS.md",
	guide: "AGENTS.md",
};

async function openUrlInBrowser(url: string): Promise<void> {
	let command: string;
	let args: string[];
	if (process.platform === "darwin") {
		command = "open";
		args = [url];
	} else if (process.platform === "win32") {
		command = "cmd";
		args = ["/c", "start", "", url];
	} else {
		command = "xdg-open";
		args = [url];
	}
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(command, args, { stdio: "ignore" });
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`Exit code ${code}`));
			});
			child.on("error", reject);
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`  ⚠️  Unable to open browser automatically (${message}). Please visit ${url}`,
		);
	}
}

async function runMcpClientCommand(
	label: string,
	command: string,
	args: string[],
): Promise<string> {
	console.log(`    Configuring ${label}...`);
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(command, args, { stdio: "inherit" });
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`Exit code ${code}`));
			});
			child.on("error", reject);
		});
		console.log(`    ✓ Added Roadmap MCP server to ${label}`);
		return label;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`    ⚠️ Unable to configure ${label} automatically (${message}).`,
		);
		console.warn(`       Run manually: ${command} ${args.join(" ")}`);
		return `${label} (manual setup required)`;
	}
}

// Helper function for accumulating multiple CLI option values
function createMultiValueAccumulator() {
	return (value: string, previous: string | string[]) => {
		const soFar = Array.isArray(previous)
			? previous
			: previous
				? [previous]
				: [];
		return [...soFar, value];
	};
}

function printMissingRequiredArgument(argumentName: string): void {
	console.error(`error: missing required argument '${argumentName}'`);
	process.exitCode = 1;
}

function hasCreateFieldFlags(options: Record<string, unknown>): boolean {
	return Boolean(
		options.description !== undefined ||
			options.desc !== undefined ||
			options.assignee !== undefined ||
			options.status !== undefined ||
			options.labels !== undefined ||
			options.priority !== undefined ||
			options.plain ||
			options.ac !== undefined ||
			options.acceptanceCriteria !== undefined ||
			options.plan !== undefined ||
			options.notes !== undefined ||
			options.finalSummary !== undefined ||
			options.draft ||
			options.parent !== undefined ||
			options.dependsOn !== undefined ||
			options.dep !== undefined ||
			options.ref !== undefined ||
			options.doc !== undefined ||
			options.requires !== undefined ||
			options.removeRequires !== undefined ||
			options.clearRequires ||
			options.builder !== undefined ||
			options.auditor !== undefined ||
			options.verify !== undefined ||
			options.addVerify !== undefined ||
			options.removeVerify !== undefined ||
			options.checkVerify !== undefined ||
			options.uncheckVerify !== undefined ||
			options.maturity !== undefined ||
			options.rationale !== undefined ||
			options.scopeSummary !== undefined ||
			options.proof !== undefined ||
			options.addProof !== undefined ||
			options.removeProof !== undefined ||
			options.external !== undefined ||
			options.unlocks !== undefined ||
			options.verifyRole !== undefined ||
			options.verifyEvidence !== undefined ||
			options.needs !== undefined,
	);
}

function hasEditFieldFlags(options: Record<string, unknown>): boolean {
	return Boolean(
		options.title !== undefined ||
			options.description !== undefined ||
			options.desc !== undefined ||
			options.assignee !== undefined ||
			options.status !== undefined ||
			options.label !== undefined ||
			options.priority !== undefined ||
			options.ordinal !== undefined ||
			options.label !== undefined ||
			options.addLabel !== undefined ||
			options.removeLabel !== undefined ||
			options.requestAudit ||
			options.ac !== undefined ||
			options.removeAc !== undefined ||
			options.checkAc !== undefined ||
			options.uncheckAc !== undefined ||
			options.acceptanceCriteria !== undefined ||
			options.plan !== undefined ||
			options.notes !== undefined ||
			options.auditNotes !== undefined ||
			options.finalSummary !== undefined ||
			options.appendNotes !== undefined ||
			options.appendAuditNotes !== undefined ||
			options.appendFinalSummary !== undefined ||
			options.clearNotes ||
			options.clearAuditNotes ||
			options.clearFinalSummary ||
			options.dependsOn !== undefined ||
			options.dep !== undefined ||
			options.ref !== undefined ||
			options.doc !== undefined ||
			options.requires !== undefined ||
			options.removeRequires !== undefined ||
			options.clearRequires ||
			options.builder !== undefined ||
			options.auditor !== undefined ||
			options.verify !== undefined ||
			options.addVerify !== undefined ||
			options.removeVerify !== undefined ||
			options.checkVerify !== undefined ||
			options.uncheckVerify !== undefined ||
			options.maturity !== undefined ||
			options.rationale !== undefined ||
			options.scopeSummary !== undefined ||
			options.proof !== undefined ||
			options.addProof !== undefined ||
			options.removeProof !== undefined ||
			options.external !== undefined ||
			options.unlocks !== undefined ||
			options.verifyRole !== undefined ||
			options.verifyEvidence !== undefined ||
			options.needs !== undefined,
	);
}

// Helper function to process multiple AC operations
/**
 * Processes --ac and --acceptance-criteria options to extract acceptance criteria
 * Handles both single values and arrays from multi-value accumulators
 */
function getDefaultAdvancedConfig(
	existingConfig?: RoadmapConfig | null,
): Partial<RoadmapConfig> {
	return {
		checkActiveBranches: existingConfig?.checkActiveBranches ?? true,
		remoteOperations: existingConfig?.remoteOperations ?? true,
		activeBranchDays: existingConfig?.activeBranchDays ?? 30,
		bypassGitHooks: existingConfig?.bypassGitHooks ?? false,
		autoCommit: existingConfig?.autoCommit ?? true,
		zeroPaddedIds: existingConfig?.zeroPaddedIds,
		defaultEditor: existingConfig?.defaultEditor,
		defaultPort: existingConfig?.defaultPort ?? 6420,
		autoOpenBrowser: existingConfig?.autoOpenBrowser ?? true,
	};
}

/**
 * Resolves the Roadmap.md project root from the current working directory.
 * Walks up the directory tree to find roadmap/ or roadmap.json, with git root fallback.
 * Exits with error message if no Roadmap.md project is found.
 */
async function requireProjectRoot(): Promise<string> {
	let runtimeCwd: RuntimeCwdResolution;
	try {
		runtimeCwd = await resolveRuntimeCwd();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	}

	const root = await findRoadmapRoot(runtimeCwd.cwd);
	if (!root) {
		console.error(
			"No Roadmap.md project found. Run `roadmap init` to initialize.",
		);
		process.exit(1);
	}
	return root;
}

// Windows color fix
if (process.platform === "win32") {
	const term = process.env.TERM;
	if (!term || /^(xterm|dumb|ansi|vt100)$/i.test(term)) {
		process.env.TERM = "xterm-256color";
	}
}

// Auto-plain fallback for commands that otherwise launch interactive UIs.
// Require both stdin and stdout to be TTY before attempting an interactive experience.
const hasInteractiveTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const shouldAutoPlain = !hasInteractiveTTY;
const plainFlagInArgv = process.argv.includes("--plain");

function isPlainRequested(options?: { plain?: boolean }): boolean {
	return Boolean(options?.plain || plainFlagInArgv);
}

// Temporarily isolate BUN_OPTIONS during CLI parsing to prevent conflicts
// Save the original value so it's available for subsequent commands
const originalBunOptions = process.env.BUN_OPTIONS;
if (process.env.BUN_OPTIONS) {
	delete process.env.BUN_OPTIONS;
}

// Get version metadata up front for splash/help/chat banners
const versionInfo = await getVersionInfo();
const version = versionInfo.version;

// Bare-run splash screen handling (before Commander parses commands)
// Show a welcome splash when invoked without subcommands, unless help/version requested
try {
	let rawArgs = process.argv.slice(2);
	// Some package managers (e.g., Bun global shims) may inject the resolved
	// binary path as the first non-node argument. Strip it if detected.
	if (rawArgs.length > 0) {
		const first = rawArgs[0];
		if (
			typeof first === "string" &&
			/node_modules[\\/]+roadmap\.md-(darwin|linux|windows)-[^\\/]+[\\/]+roadmap(\.exe)?$/.test(
				first,
			)
		) {
			rawArgs = rawArgs.slice(1);
		}
	}
	const wantsHelp = rawArgs.includes("-h") || rawArgs.includes("--help");
	const wantsVersion = rawArgs.includes("-v") || rawArgs.includes("--version");
	// Treat only --plain as allowed flag for splash; any other args means use normal CLI parsing
	const onlyPlain = rawArgs.length === 1 && rawArgs[0] === "--plain";
	const isBare = rawArgs.length === 0 || onlyPlain;
	if (isBare && !wantsHelp && !wantsVersion) {
		const forcePlain = rawArgs.includes("--plain");
		const noColor = !!process.env.NO_COLOR;

		let initialized = false;
		try {
			const runtimeCwd = await resolveRuntimeCwd();
			const projectRoot = await findRoadmapRoot(runtimeCwd.cwd);
			if (projectRoot) {
				const core = new Core(projectRoot);
				const cfg = await core.filesystem.loadConfig();
				initialized = !!cfg;
			}
		} catch {
			initialized = false;
		}

		const { printSplash } = await import("../ui/splash.ts");
		// Auto-fallback to plain when explicit --plain, or if terminal very narrow
		const termWidth = Math.max(0, Number(process.stdout.columns || 0));
		const autoPlain = termWidth > 0 && termWidth < 60;
		await printSplash({
			version: versionInfo.version,
			revision: versionInfo.revision,
			initialized,
			plain: forcePlain || autoPlain,
			color: !noColor,
		});
		// Ensure we don't enter Commander command parsing
		process.exit(0);
	}
} catch {
	// Fall through to normal CLI parsing on any splash error
}

function getMcpStartCwdOverrideFromArgv(
	argv = process.argv,
): string | undefined {
	const args = argv.slice(2);
	const mcpIndex = args.indexOf("mcp");
	if (mcpIndex < 0 || args[mcpIndex + 1] !== "start") {
		return undefined;
	}

	for (let i = mcpIndex + 2; i < args.length; i++) {
		const arg = args[i];
		if (!arg) {
			continue;
		}
		if (arg === "--cwd") {
			const next = args[i + 1]?.trim();
			return next || undefined;
		}
		if (arg?.startsWith("--cwd=")) {
			const value = arg.slice("--cwd=".length).trim();
			return value || undefined;
		}
	}

	return undefined;
}

// Global config migration - run before any command processing
// Only run if we're in a roadmap project (skip for init, help, version)
const shouldRunMigration =
	!process.argv.includes("init") &&
	!process.argv.includes("--help") &&
	!process.argv.includes("-h") &&
	!process.argv.includes("--version") &&
	!process.argv.includes("-v") &&
	process.argv.length > 2; // Ensure we have actual commands

if (shouldRunMigration) {
	try {
		const runtimeCwd = await resolveRuntimeCwd({
			cwd: getMcpStartCwdOverrideFromArgv(),
		});
		const projectRoot = await findRoadmapRoot(runtimeCwd.cwd);
		if (projectRoot) {
			const core = new Core(projectRoot);

			// Only migrate if config already exists (project is already initialized)
			const config = await core.filesystem.loadConfig();
			if (config) {
				await core.ensureConfigMigrated();
			}
		}
	} catch (_error) {
		// Silently ignore migration errors - project might not be initialized yet
	}
}

const program = new Command();
const versionLabel = formatVersionLabel(versionInfo);

program
	.name("roadmap")
	.description("Roadmap.md - Project management CLI")
	.version(versionLabel, "-v, --version", "display version number")
	.addHelpText("before", `\x1b[1mRoadmap.md\x1b[0m ${versionLabel}\n`);

program.hook("preAction", (_thisCommand, actionCommand) => {
	// Don't print version header for help/version commands as they handle it themselves
	if (actionCommand.name() === "help") return;

	// Check if plain output is requested for this command
	const options = actionCommand.opts();
	const usePlain = !!(
		options.compact ||
		isPlainRequested(options) ||
		shouldAutoPlain
	);

	// Avoid printing header for TUI-heavy commands that will immediately clear/redraw the screen
	const isTuiCommand = ["board", "browser", "chat", "overview"].includes(
		actionCommand.name(),
	);

	if (!usePlain && !isTuiCommand && !process.env.ROADMAP_QUIET) {
		process.stdout.write(`\x1b[2mRoadmap.md ${versionLabel}\x1b[0m\n\n`);
	}
});

program
	.command("init [projectName] [description]")
	.description(
		"initialize roadmap project in the current repository (or use 'npx agent-roadmap init' to bootstrap)",
	)
	.option(
		"-b, --blueprint <type>",
		"project blueprint (software, research, content, versatile)",
	)
	.option(
		"--agent-instructions <instructions>",
		"comma-separated agent instructions to create. Valid: claude, agents, gemini, copilot, cursor (alias of agents), none. Use 'none' to skip; when combined with others, 'none' is ignored.",
	)
	.option(
		"--check-branches <boolean>",
		"check proposal proposals across active branches (default: true)",
	)
	.option(
		"--include-remote <boolean>",
		"include remote branches when checking (default: true)",
	)
	.option(
		"--branch-days <number>",
		"days to consider branch active (default: 30)",
	)
	.option(
		"--bypass-git-hooks <boolean>",
		"bypass git hooks when committing (default: false)",
	)
	.option(
		"--zero-padded-ids <number>",
		"number of digits for zero-padding IDs (0 to disable)",
	)
	.option("--default-editor <editor>", "default editor command")
	.option("--web-port <number>", "default web UI port (default: 6420)")
	.option(
		"--auto-open-browser <boolean>",
		"auto-open browser for web UI (default: true)",
	)
	.option(
		"--install-claude-agent <boolean>",
		"install Claude Code agent (default: false)",
	)
	.option(
		"--integration-mode <mode>",
		"choose how AI tools connect to Roadmap.md (mcp, cli, or none)",
	)
	.option(
		"--proposal-prefix <prefix>",
		"custom proposal prefix, letters only (default: proposal)",
	)
	.option("--defaults", "use default values for all prompts")
	.action(
		async (
			projectName: string | undefined,
			description: string | undefined,
			options: {
				blueprint?: string;
				agentInstructions?: string;
				checkBranches?: string;
				includeRemote?: string;
				branchDays?: string;
				bypassGitHooks?: string;
				zeroPaddedIds?: string;
				defaultEditor?: string;
				webPort?: string;
				autoOpenBrowser?: string;
				installClaudeAgent?: string;
				integrationMode?: string;
				proposalPrefix?: string;
				defaults?: boolean;
			},
		) => {
			try {
				// init command uses process.cwd() directly - it initializes in the current directory
				const cwd = process.cwd();
				const isRepo = await isGitRepository(cwd);

				if (!isRepo && !options.defaults) {
					const initializeRepo = await clack.confirm({
						message: "No git repository found. Initialize one here?",
						initialValue: false,
					});
					if (clack.isCancel(initializeRepo)) {
						abortInitialization();
						return;
					}

					if (initializeRepo) {
						await initializeGitRepository(cwd);
					} else {
						abortInitialization();
						return;
					}
				}

				const core = new Core(cwd);

				// Check if project is already initialized and load existing config
				const existingConfig = await core.filesystem.loadConfig();
				const isReInitialization = !!existingConfig;

				if (isReInitialization) {
					console.log(
						"Existing roadmap project detected. Current configuration will be preserved where not specified.",
					);
				}

				// Helper function to parse boolean strings
				const parseBoolean = (
					value: string | undefined,
					defaultValue: boolean,
				): boolean => {
					if (value === undefined) return defaultValue;
					return value.toLowerCase() === "true" || value === "1";
				};

				// Helper function to parse number strings
				const parseNumber = (
					value: string | undefined,
					defaultValue: number,
				): number => {
					if (value === undefined) return defaultValue;
					const parsed = Number.parseInt(value, 10);
					return Number.isNaN(parsed) ? defaultValue : parsed;
				};
				function abortInitialization(message = "Aborting initialization.") {
					clack.cancel(message);
					process.exitCode = 1;
				}
				function cancelInitialization(message = "Initialization cancelled.") {
					clack.cancel(message);
				}

				// Non-interactive mode when any flag is provided or --defaults is used
				const isNonInteractive = !!(
					options.blueprint ||
					options.agentInstructions ||
					options.defaults ||
					options.checkBranches ||
					options.includeRemote ||
					options.branchDays ||
					options.bypassGitHooks ||
					options.zeroPaddedIds ||
					options.defaultEditor ||
					options.webPort ||
					options.autoOpenBrowser ||
					options.installClaudeAgent ||
					options.integrationMode ||
					options.proposalPrefix
				);

				// Get project name
				let name = projectName;
				if (!name) {
					const defaultName = existingConfig?.projectName || "";
					const promptMessage =
						isReInitialization && defaultName
							? `Project name (${defaultName}):`
							: "Project name:";
					const enteredName = await clack.text({
						message: promptMessage,
						defaultValue:
							isReInitialization && defaultName ? defaultName : undefined,
						validate: (value) => {
							if (!isReInitialization || !defaultName) {
								if (!String(value ?? "").trim()) {
									return "Project name is required.";
								}
							}
							return undefined;
						},
					});
					if (clack.isCancel(enteredName)) {
						abortInitialization();
						return;
					}
					name = String(enteredName ?? "").trim();
					// Use existing name if nothing entered during re-init
					if (!name && isReInitialization && defaultName) {
						name = defaultName;
					}
					if (!name) {
						abortInitialization();
						return;
					}
				}

				// Get project description
				let desc = description;
				if (!desc && !isNonInteractive && !isReInitialization) {
					const enteredDesc = await clack.text({
						message: "Project description (seed inspiration):",
						placeholder:
							"e.g., Build a modern blog platform with React and Bun",
					});
					if (clack.isCancel(enteredDesc)) {
						abortInitialization();
						return;
					}
					desc = String(enteredDesc ?? "").trim();
				}

				// Get project blueprint
				const { BLUEPRINTS } = await import(
					"../core/infrastructure/blueprints.ts"
				);
				let blueprintType = options.blueprint as any;
				if (!blueprintType && !isNonInteractive && !isReInitialization) {
					const selectedBlueprint = await clack.select({
						message: "Select a project blueprint (DAG structure):",
						options: [
							...Object.values(BLUEPRINTS).map((b) => ({
								label: `${b.name} — ${b.description}`,
								value: b.type,
							})),
							{ label: "None (Empty Roadmap)", value: "none" },
						],
						initialValue: "versatile",
					});

					if (clack.isCancel(selectedBlueprint)) {
						abortInitialization();
						return;
					}

					if (selectedBlueprint !== "none") {
						blueprintType = selectedBlueprint as any;
					}
				}

				// Get proposal prefix (first-time init only, preserved on re-init)
				const proposalPrefix = options.proposalPrefix || "proposal";
				// Validate proposal prefix if provided
				if (proposalPrefix && !/^[a-zA-Z]+$/.test(proposalPrefix)) {
					console.error(
						"Proposal prefix must contain only letters (a-z, A-Z).",
					);
					process.exit(1);
				}

				const defaultAdvancedConfig = getDefaultAdvancedConfig(existingConfig);
				const applyAdvancedOptionOverrides = () => {
					const result: Partial<RoadmapConfig> = { ...defaultAdvancedConfig };
					result.checkActiveBranches = parseBoolean(
						options.checkBranches,
						result.checkActiveBranches ?? true,
					);
					if (result.checkActiveBranches) {
						result.remoteOperations = parseBoolean(
							options.includeRemote,
							result.remoteOperations ?? true,
						);
						result.activeBranchDays = parseNumber(
							options.branchDays,
							result.activeBranchDays ?? 30,
						);
					} else {
						result.remoteOperations = false;
					}
					result.bypassGitHooks = parseBoolean(
						options.bypassGitHooks,
						result.bypassGitHooks ?? false,
					);
					const paddingValue = parseNumber(
						options.zeroPaddedIds,
						result.zeroPaddedIds ?? 0,
					);
					result.zeroPaddedIds = paddingValue > 0 ? paddingValue : undefined;
					result.defaultEditor =
						options.defaultEditor ||
						existingConfig?.defaultEditor ||
						process.env.EDITOR ||
						process.env.VISUAL ||
						undefined;
					result.autoCommit = parseBoolean(
						String((options as Record<string, unknown>).autoCommit ?? ""),
						result.autoCommit ?? true,
					);
					result.defaultPort = parseNumber(
						options.webPort,
						result.defaultPort ?? 6420,
					);
					result.autoOpenBrowser = parseBoolean(
						options.autoOpenBrowser,
						result.autoOpenBrowser ?? true,
					);
					return result;
				};

				const integrationOption = options.integrationMode
					? normalizeIntegrationOption(options.integrationMode)
					: undefined;
				if (options.integrationMode && !integrationOption) {
					console.error(
						`Invalid integration mode: ${options.integrationMode}. Valid options are: mcp, cli, none`,
					);
					process.exit(1);
				}

				let integrationMode: IntegrationMode | null =
					integrationOption ?? (isNonInteractive ? "mcp" : null);
				const mcpServerName = MCP_SERVER_NAME;
				type AgentSelection = AgentSelectionValue;
				let agentFiles: AgentInstructionFile[] = [];
				let agentInstructionsSkipped = false;
				let mcpClientSetupSummary: string | undefined;
				const mcpGuideUrl =
					"https://github.com/agentroadmap/agentRoadmap#-mcp-integration-model-context-protocol";

				if (
					!integrationOption &&
					integrationMode === "mcp" &&
					(options.agentInstructions || options.installClaudeAgent)
				) {
					integrationMode = "cli";
				}

				if (
					integrationMode === "mcp" &&
					(options.agentInstructions || options.installClaudeAgent)
				) {
					console.error(
						"The MCP connector option cannot be combined with --agent-instructions or --install-claude-agent.",
					);
					process.exit(1);
				}

				if (
					integrationMode === "none" &&
					(options.agentInstructions || options.installClaudeAgent)
				) {
					console.error(
						"Skipping AI integration cannot be combined with --agent-instructions or --install-claude-agent.",
					);
					process.exit(1);
				}

				let integrationTipShown = false;
				mainSelection: while (true) {
					if (integrationMode === null) {
						if (!integrationTipShown) {
							clack.note(
								"MCP connector is recommended for AI tool integration.",
								"AI setup tip",
							);
							integrationTipShown = true;
						}
						const integrationPrompt = await clack.select({
							message:
								"How would you like your AI tools to connect to Roadmap.md?",
							initialValue: "mcp",
							options: [
								{
									label:
										"via MCP connector (recommended for Claude Code, Codex, Gemini CLI, Kiro, Cursor, etc.)",
									value: "mcp",
								},
								{
									label: "via CLI commands (broader compatibility)",
									value: "cli",
								},
								{
									label:
										"Skip for now (I am not using Roadmap.md with AI tools)",
									value: "none",
								},
							],
						});

						if (clack.isCancel(integrationPrompt)) {
							cancelInitialization();
							return;
						}

						const selectedMode = integrationPrompt
							? normalizeIntegrationOption(String(integrationPrompt))
							: null;
						integrationMode = selectedMode ?? "mcp";
						console.log("");
					}

					if (integrationMode === "cli") {
						if (options.agentInstructions) {
							const nameMap: Record<string, AgentSelection> = {
								cursor: "AGENTS.md",
								claude: "CLAUDE.md",
								agents: "AGENTS.md",
								gemini: "GEMINI.md",
								copilot: ".github/copilot-instructions.md",
								none: "none",
								"CLAUDE.md": "CLAUDE.md",
								"AGENTS.md": "AGENTS.md",
								"GEMINI.md": "GEMINI.md",
								".github/copilot-instructions.md":
									".github/copilot-instructions.md",
							};

							const requestedInstructions = options.agentInstructions
								.split(",")
								.map((f) => f.trim().toLowerCase());
							const mappedFiles: AgentSelection[] = [];

							for (const instruction of requestedInstructions) {
								const mappedFile = nameMap[instruction];
								if (!mappedFile) {
									console.error(`Invalid agent instruction: ${instruction}`);
									console.error(
										"Valid options are: cursor, claude, agents, gemini, copilot, none",
									);
									process.exit(1);
								}
								mappedFiles.push(mappedFile);
							}

							const { files, needsRetry, skipped } = processAgentSelection({
								selected: mappedFiles,
							});
							if (needsRetry) {
								console.error(
									"Please select at least one agent instruction file before continuing.",
								);
								process.exit(1);
							}
							agentFiles = files;
							agentInstructionsSkipped = skipped;
						} else if (isNonInteractive) {
							agentFiles = [];
						} else {
							while (true) {
								const response = await clack.multiselect({
									message:
										"Select instruction files for CLI-based AI tools (space toggles selections; enter accepts)",
									options: [
										{ label: "CLAUDE.md — Claude Code", value: "CLAUDE.md" },
										{
											label:
												"AGENTS.md — Codex, Cursor, Zed, Warp, Aider, RooCode, etc.",
											value: "AGENTS.md",
										},
										{
											label: "GEMINI.md — Google Gemini Code Assist CLI",
											value: "GEMINI.md",
										},
										{
											label: "Copilot instructions — GitHub Copilot",
											value: ".github/copilot-instructions.md",
										},
									],
									required: false,
								});

								if (clack.isCancel(response)) {
									integrationMode = null;
									console.log("");
									continue mainSelection;
								}

								const selected = Array.isArray(response)
									? (response as AgentSelection[])
									: [];
								const { files, needsRetry, skipped } = processAgentSelection({
									selected,
								});
								if (needsRetry) {
									console.log(
										"Please select at least one agent instruction file before continuing.",
									);
									continue;
								}
								agentFiles = files;
								agentInstructionsSkipped = skipped;
								break;
							}
						}

						break;
					}

					if (integrationMode === "mcp") {
						if (isNonInteractive) {
							mcpClientSetupSummary = "skipped (non-interactive)";
							break;
						}

						console.log(`  MCP server name: ${mcpServerName}`);
						while (true) {
							const clientResponse = await clack.multiselect({
								message:
									"Which AI tools should we configure right now? (space toggles items; enter confirms)",
								options: [
									{ label: "Claude Code", value: "claude" },
									{ label: "OpenAI Codex", value: "codex" },
									{ label: "Gemini CLI", value: "gemini" },
									{ label: "Kiro", value: "kiro" },
									{ label: "Other (open setup guide)", value: "guide" },
								],
								required: true,
							});

							if (clack.isCancel(clientResponse)) {
								integrationMode = null;
								console.log("");
								continue mainSelection;
							}

							const selectedClients = Array.isArray(clientResponse)
								? clientResponse
								: [];
							if (selectedClients.length === 0) {
								console.log(
									"Please select at least one AI tool before continuing.",
								);
								continue;
							}

							const results: string[] = [];
							const mcpGuidelineUpdates: EnsureMcpGuidelinesResult[] = [];
							const recordGuidelinesForClient = async (clientKey: string) => {
								const instructionFile = MCP_CLIENT_INSTRUCTION_MAP[clientKey];
								if (!instructionFile) {
									return;
								}
								const nudgeResult = await ensureMcpGuidelines(
									cwd,
									instructionFile,
								);
								if (nudgeResult.changed) {
									mcpGuidelineUpdates.push(nudgeResult);
								}
							};
							const uniq = (values: string[]) => [...new Set(values)];

							for (const client of selectedClients) {
								if (client === "claude") {
									const result = await runMcpClientCommand(
										"Claude Code",
										"claude",
										[
											"mcp",
											"add",
											"-s",
											"user",
											mcpServerName,
											"--",
											"roadmap",
											"mcp",
											"start",
										],
									);
									results.push(result);
									await recordGuidelinesForClient(client);
									continue;
								}
								if (client === "codex") {
									const result = await runMcpClientCommand(
										"OpenAI Codex",
										"codex",
										["mcp", "add", mcpServerName, "roadmap", "mcp", "start"],
									);
									results.push(result);
									await recordGuidelinesForClient(client);
									continue;
								}
								if (client === "gemini") {
									const result = await runMcpClientCommand(
										"Gemini CLI",
										"gemini",
										[
											"mcp",
											"add",
											"-s",
											"user",
											mcpServerName,
											"roadmap",
											"mcp",
											"start",
										],
									);
									results.push(result);
									await recordGuidelinesForClient(client);
									continue;
								}
								if (client === "kiro") {
									const result = await runMcpClientCommand("Kiro", "kiro-cli", [
										"mcp",
										"add",
										"--scope",
										"global",
										"--name",
										mcpServerName,
										"--command",
										"roadmap",
										"--args",
										"mcp,start",
									]);
									results.push(result);
									await recordGuidelinesForClient(client);
									continue;
								}
								if (client === "guide") {
									console.log("    Opening MCP setup guide in your browser...");
									await openUrlInBrowser(mcpGuideUrl);
									results.push("Setup guide opened");
									await recordGuidelinesForClient(client);
								}
							}

							if (mcpGuidelineUpdates.length > 0) {
								const createdFiles = uniq(
									mcpGuidelineUpdates
										.filter((entry) => entry.created)
										.map((entry) => entry.fileName),
								);
								const updatedFiles = uniq(
									mcpGuidelineUpdates
										.filter((entry) => !entry.created)
										.map((entry) => entry.fileName),
								);
								if (createdFiles.length > 0) {
									console.log(
										`    Created MCP reminder file(s): ${createdFiles.join(", ")}`,
									);
								}
								if (updatedFiles.length > 0) {
									console.log(
										`    Added MCP reminder to ${updatedFiles.join(", ")}`,
									);
								}
							}

							mcpClientSetupSummary = results.join(", ");
							break;
						}

						break;
					}

					if (integrationMode === "none") {
						agentFiles = [];
						agentInstructionsSkipped = false;
						break;
					}
				}

				let advancedConfig: Partial<RoadmapConfig> = {
					...defaultAdvancedConfig,
				};
				const advancedConfigured = false;
				let installClaudeAgentSelection = false;
				const installShellCompletionsSelection = false;
				const completionInstallResult: CompletionInstallResult | null = null;
				const completionInstallError: string | null = null;

				if (isNonInteractive) {
					advancedConfig = applyAdvancedOptionOverrides();
					installClaudeAgentSelection =
						integrationMode === "cli"
							? parseBoolean(options.installClaudeAgent, false)
							: false;
				} else {
					// User explicitly wants advanced config if they used the flags, otherwise skip to keep init fast.
					const hasAdvancedFlags = Boolean(
						options.checkBranches ||
							options.includeRemote ||
							options.branchDays ||
							options.bypassGitHooks ||
							options.zeroPaddedIds ||
							options.defaultEditor ||
							options.webPort ||
							options.autoOpenBrowser,
					);

					if (hasAdvancedFlags) {
						advancedConfig = applyAdvancedOptionOverrides();
						installClaudeAgentSelection =
							integrationMode === "cli"
								? parseBoolean(options.installClaudeAgent, false)
								: false;
					} else {
						// Skip advanced wizard to keep init simple and fast ("log default").
						advancedConfig = { ...defaultAdvancedConfig };
						installClaudeAgentSelection = false;
					}
				}
				// Call shared core init function
				const initResult = await initializeProject(core, {
					projectName: name,
					description: desc,
					blueprint: blueprintType,
					integrationMode: integrationMode || "none",
					mcpClients: [], // MCP clients are handled separately in CLI with interactive prompts
					agentInstructions: agentFiles,
					installClaudeAgent: installClaudeAgentSelection,
					advancedConfig: {
						checkActiveBranches: advancedConfig.checkActiveBranches,
						remoteOperations: advancedConfig.remoteOperations,
						activeBranchDays: advancedConfig.activeBranchDays,
						bypassGitHooks: advancedConfig.bypassGitHooks,
						autoCommit: advancedConfig.autoCommit,
						zeroPaddedIds: advancedConfig.zeroPaddedIds,
						defaultEditor: advancedConfig.defaultEditor,
						defaultPort: advancedConfig.defaultPort,
						autoOpenBrowser: advancedConfig.autoOpenBrowser,
						proposalPrefix: proposalPrefix || undefined,
					},
					existingConfig,
				});

				const config = initResult.config;

				// Show configuration summary
				const supportsColor =
					Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
				const colorize = (code: string, value: string): string =>
					supportsColor ? `\u001B[${code}m${value}\u001B[0m` : value;
				const label = (value: string): string => colorize("1;36", value);
				const good = (value: string): string => colorize("32", value);
				const bad = (value: string): string => colorize("31", value);
				const muted = (value: string): string => colorize("2", value);
				const boolValue = (value: boolean): string =>
					value ? good("true") : bad("false");
				const formatCompletionInstructions = (instructions: string): string =>
					instructions
						.split("\n")
						.map((line) => {
							const trimmed = line.trim();
							if (!trimmed) {
								return line;
							}
							if (/^(path=|autoload|source )/.test(trimmed)) {
								return colorize("1;32", line);
							}
							if (
								/^(To enable completions, ensure the directory is in your fpath\.|Add this to your ~\/\.zshrc:|Then restart your shell or run:)$/.test(
									trimmed,
								)
							) {
								return colorize("36", line);
							}
							return line;
						})
						.join("\n");
				const summaryLines: string[] = [
					`${label("Project Name:")} ${colorize("1", config.projectName)}`,
				];
				if (initResult.description) {
					summaryLines.push(
						`${label("Description:")} ${initResult.description}`,
					);
				}
				if (initResult.blueprint) {
					summaryLines.push(`${label("Blueprint:")} ${initResult.blueprint}`);
				}
				if (
					initResult.initialProposals &&
					initResult.initialProposals.length > 0
				) {
					summaryLines.push(label("Initial Roadmap:"));
					for (const proposal of initResult.initialProposals) {
						summaryLines.push(`  - ${good(proposal.id)}: ${proposal.title}`);
					}
				}
				if (integrationMode === "cli") {
					summaryLines.push(
						`${label("AI Integration:")} ${muted("CLI commands (legacy)")}`,
					);
					if (agentFiles.length > 0) {
						summaryLines.push(
							`${label("Agent instructions:")} ${agentFiles.join(", ")}`,
						);
					} else if (agentInstructionsSkipped) {
						summaryLines.push(
							`${label("Agent instructions:")} ${muted("skipped")}`,
						);
					} else {
						summaryLines.push(
							`${label("Agent instructions:")} ${muted("none")}`,
						);
					}
				} else if (integrationMode === "mcp") {
					summaryLines.push(
						`${label("AI Integration:")} ${good("MCP connector")}`,
					);
					summaryLines.push(
						`${label("Agent instruction files:")} ${muted("guidance is provided through the MCP connector.")}`,
					);
					summaryLines.push(`${label("MCP server name:")} ${mcpServerName}`);
					summaryLines.push(
						`${label("MCP client setup:")} ${mcpClientSetupSummary ?? muted("skipped")}`,
					);
				} else {
					summaryLines.push(
						`${label("AI integration:")} ${muted("skipped (configure later via `roadmap init`)")}`,
					);
				}
				let completionSummary: string;
				if (completionInstallResult) {
					completionSummary = `${good("installed")} to ${(completionInstallResult as CompletionInstallResult).installPath}`;
				} else if (installShellCompletionsSelection) {
					completionSummary = `${bad("installation failed")} (${muted("see warning below")})`;
				} else if (advancedConfigured) {
					completionSummary = muted("skipped");
				} else {
					completionSummary = muted("not configured");
				}
				summaryLines.push(
					`${label("Shell completions:")} ${completionSummary}`,
				);
				if (advancedConfigured) {
					summaryLines.push(label("Advanced settings:"));
					summaryLines.push(
						`  ${label("Check active branches:")} ${boolValue(Boolean(config.checkActiveBranches))}`,
					);
					summaryLines.push(
						`  ${label("Remote operations:")} ${boolValue(Boolean(config.remoteOperations))}`,
					);
					summaryLines.push(
						`  ${label("Active branch days:")} ${String(config.activeBranchDays)}`,
					);
					summaryLines.push(
						`  ${label("Bypass git hooks:")} ${boolValue(Boolean(config.bypassGitHooks))}`,
					);
					summaryLines.push(
						`  ${label("Auto commit:")} ${boolValue(Boolean(config.autoCommit))}`,
					);
					summaryLines.push(
						`  ${label("Zero-padded IDs:")} ${
							config.zeroPaddedIds
								? `${String(config.zeroPaddedIds)} digits`
								: muted("disabled")
						}`,
					);
					summaryLines.push(
						`  ${label("Web UI port:")} ${String(config.defaultPort)}`,
					);
					summaryLines.push(
						`  ${label("Auto open browser:")} ${boolValue(Boolean(config.autoOpenBrowser))}`,
					);
					if (config.defaultEditor) {
						summaryLines.push(
							`  ${label("Default editor:")} ${config.defaultEditor}`,
						);
					}
				} else {
					summaryLines.push(
						`${label("Advanced settings:")} ${muted("unchanged (run `roadmap config` to customize)")}`,
					);
				}
				clack.note(summaryLines.join("\n"), "Initialization Summary");

				if (completionInstallResult) {
					const result = completionInstallResult as CompletionInstallResult;
					const instructions = result.instructions.trim();
					clack.note(
						[
							`${label("Path:")} ${colorize("1", result.installPath)}`,
							formatCompletionInstructions(instructions),
						].join("\n\n"),
						`Shell completions installed (${result.shell})`,
					);
				} else if (completionInstallError) {
					const indentedError = (completionInstallError as string)
						.split("\n")
						.map((line) => `  ${line}`)
						.join("\n");
					console.warn(
						`⚠️  Shell completion installation failed:\n${indentedError}\n  Run \`roadmap completion install\` later to retry.\n`,
					);
				}

				// Log init result
				if (initResult.isReInitialization) {
					clack.outro(`Updated roadmap project configuration: ${name}`);
				} else {
					clack.outro(`Initialized roadmap project: ${name}`);
				}

				// Log agent files result from shared init
				if (integrationMode === "cli") {
					if (initResult.mcpResults?.agentFiles) {
						clack.log.info(initResult.mcpResults.agentFiles);
					} else if (agentInstructionsSkipped) {
						clack.log.info("Skipping agent instruction files per selection.");
					}
				}

				// Log Claude agent result from shared init
				if (integrationMode === "cli" && initResult.mcpResults?.claudeAgent) {
					clack.log.info(
						`Claude Code Roadmap.md agent ${initResult.mcpResults.claudeAgent}`,
					);
				}

				// Final warning if remote operations were enabled but no git remotes are configured
				try {
					if (config.remoteOperations) {
						// Ensure git ops are ready (config not strictly required for this check)
						const hasRemotes = await core.gitOps.hasAnyRemote();
						if (!hasRemotes) {
							console.warn(
								[
									"Warning: remoteOperations is enabled but no git remotes are configured.",
									"Remote features will be skipped until a remote is added (e.g., 'git remote add origin <url>')",
									"or disable remoteOperations via 'roadmap config set remoteOperations false'.",
								].join(" "),
							);
						}
					}
				} catch {
					// Ignore failures in final advisory warning
				}
			} catch (err) {
				console.error("Failed to initialize project", err);
				process.exitCode = 1;
			}
		},
	);

export async function generateNextDocId(core: Core): Promise<string> {
	const config = await core.filesystem.loadConfig();
	// Load local documents
	const docs = await core.filesystem.listDocuments();
	const allIds: string[] = [];

	try {
		const roadmapDir = DEFAULT_DIRECTORIES.ROADMAP;

		// Skip remote operations if disabled
		if (config?.remoteOperations === false) {
			if (process.env.DEBUG) {
				console.log(
					"Remote operations disabled - generating ID from local documents only",
				);
			}
		} else {
			await core.gitOps.fetch();
		}

		const branches = await core.gitOps.listAllBranches();

		// Load files from all branches in parallel
		const branchFilePromises = branches.map(async (branch) => {
			const files = await core.gitOps.listFilesInTree(
				branch,
				`${roadmapDir}/docs`,
			);
			return files
				.map((file) => {
					const match = file.match(/doc-(\d+)/);
					return match ? `doc-${match[1]}` : null;
				})
				.filter((id): id is string => id !== null);
		});

		const branchResults = await Promise.all(branchFilePromises);
		for (const branchIds of branchResults) {
			allIds.push(...branchIds);
		}
	} catch (error) {
		// Suppress errors for offline mode or other git issues
		if (process.env.DEBUG) {
			console.error("Could not fetch remote document IDs:", error);
		}
	}

	// Add local document IDs
	for (const doc of docs) {
		allIds.push(doc.id);
	}

	// Find the highest numeric ID
	let max = 0;
	for (const id of allIds) {
		const match = id.match(/^doc-(\d+)$/);
		if (match) {
			const num = Number.parseInt(match[1] || "0", 10);
			if (num > max) max = num;
		}
	}

	const nextIdNumber = max + 1;
	const padding = config?.zeroPaddedIds;

	if (padding && typeof padding === "number" && padding > 0) {
		const paddedId = String(nextIdNumber).padStart(padding, "0");
		return `doc-${paddedId}`;
	}

	return `doc-${nextIdNumber}`;
}

export async function generateNextDecisionId(core: Core): Promise<string> {
	const config = await core.filesystem.loadConfig();
	// Load local decisions
	const decisions = await core.filesystem.listDecisions();
	const allIds: string[] = [];

	try {
		const roadmapDir = DEFAULT_DIRECTORIES.ROADMAP;

		// Skip remote operations if disabled
		if (config?.remoteOperations === false) {
			if (process.env.DEBUG) {
				console.log(
					"Remote operations disabled - generating ID from local decisions only",
				);
			}
		} else {
			await core.gitOps.fetch();
		}

		const branches = await core.gitOps.listAllBranches();

		// Load files from all branches in parallel
		const branchFilePromises = branches.map(async (branch) => {
			const files = await core.gitOps.listFilesInTree(
				branch,
				`${roadmapDir}/decisions`,
			);
			return files
				.map((file) => {
					const match = file.match(/decision-(\d+)/);
					return match ? `decision-${match[1]}` : null;
				})
				.filter((id): id is string => id !== null);
		});

		const branchResults = await Promise.all(branchFilePromises);
		for (const branchIds of branchResults) {
			allIds.push(...branchIds);
		}
	} catch (error) {
		// Suppress errors for offline mode or other git issues
		if (process.env.DEBUG) {
			console.error("Could not fetch remote decision IDs:", error);
		}
	}

	// Add local decision IDs
	for (const decision of decisions) {
		allIds.push(decision.id);
	}

	// Find the highest numeric ID
	let max = 0;
	for (const id of allIds) {
		const match = id.match(/^decision-(\d+)$/);
		if (match) {
			const num = Number.parseInt(match[1] || "0", 10);
			if (num > max) max = num;
		}
	}

	const nextIdNumber = max + 1;
	const padding = config?.zeroPaddedIds;

	if (padding && typeof padding === "number" && padding > 0) {
		const paddedId = String(nextIdNumber).padStart(padding, "0");
		return `decision-${paddedId}`;
	}

	return `decision-${nextIdNumber}`;
}

function normalizeDependencies(dependencies: unknown): string[] {
	if (!dependencies) return [];

	const normalizeList = (values: string[]): string[] =>
		values
			.map((value) => value.trim())
			.filter((value): value is string => value.length > 0)
			.map((value) => normalizeProposalId(value));

	if (Array.isArray(dependencies)) {
		return normalizeList(
			dependencies.flatMap((dep) =>
				String(dep)
					.split(",")
					.map((d) => d.trim()),
			),
		);
	}

	return normalizeList(String(dependencies).split(","));
}

async function validateDependencies(
	dependencies: string[],
	core: Core,
): Promise<{ valid: string[]; invalid: string[] }> {
	const valid: string[] = [];
	const invalid: string[] = [];

	if (dependencies.length === 0) {
		return { valid, invalid };
	}

	// Load both proposals and drafts to validate dependencies
	const [proposals, drafts] = await Promise.all([
		core.queryProposals(),
		core.fs.listDrafts(),
	]);

	const knownIds = [
		...proposals.map((proposal) => proposal.id),
		...drafts.map((draft) => draft.id),
	];
	for (const dep of dependencies) {
		const match = knownIds.find((id) => proposalIdsEqual(dep, id));
		if (match) {
			valid.push(match);
		} else {
			invalid.push(dep);
		}
	}

	return { valid, invalid };
}

function buildProposalFromOptions(
	id: string,
	title: string,
	options: Record<string, unknown>,
): Proposal {
	const parentInput = options.parent ? String(options.parent) : undefined;
	const normalizedParent = parentInput
		? normalizeProposalId(parentInput)
		: undefined;

	const createdDate = new Date().toISOString().slice(0, 16).replace("T", " ");

	// Handle dependencies - they will be validated separately
	const dependencies = normalizeDependencies(options.dependsOn || options.dep);

	// Handle references (URLs or file paths)
	const references = normalizeStringList(
		Array.isArray(options.ref)
			? options.ref.flatMap((r: string) =>
					String(r)
						.split(",")
						.map((s: string) => s.trim()),
				)
			: options.ref
				? String(options.ref)
						.split(",")
						.map((s: string) => s.trim())
				: [],
	);

	// Handle documentation (URLs or file paths)
	const documentation = normalizeStringList(
		Array.isArray(options.doc)
			? options.doc.flatMap((d: string) =>
					String(d)
						.split(",")
						.map((s: string) => s.trim()),
				)
			: options.doc
				? String(options.doc)
						.split(",")
						.map((s: string) => s.trim())
				: [],
	);

	// Handle resource requirements
	const requires = normalizeStringList(
		Array.isArray(options.requires)
			? options.requires.flatMap((r: string) =>
					String(r)
						.split(",")
						.map((s: string) => s.trim()),
				)
			: options.requires
				? String(options.requires)
						.split(",")
						.map((s: string) => s.trim())
				: [],
	);

	// Validate priority option
	const priority = options.priority
		? String(options.priority).toLowerCase()
		: undefined;
	const validPriorities = ["high", "medium", "low"];
	const validatedPriority =
		priority && validPriorities.includes(priority)
			? (priority as "high" | "medium" | "low")
			: undefined;

	return {
		id,
		title,
		status: options.status ? String(options.status) : "",
		assignee: options.assignee ? [String(options.assignee)] : [],
		createdDate,
		labels: options.labels
			? String(options.labels)
					.split(",")
					.map((l: string) => l.trim())
					.filter(Boolean)
			: [],
		dependencies,
		references,
		documentation,
		requires,
		rawContent: "",
		...(options.description || options.desc
			? { description: String(options.description || options.desc) }
			: {}),
		...(normalizedParent ? { parentProposalId: normalizedParent } : {}),
		...(validatedPriority ? { priority: validatedPriority } : {}),
		...(options.rationale ? { rationale: String(options.rationale) } : {}),
		...(options.maturity
			? { maturity: String(options.maturity).toLowerCase() as any }
			: {}),
		...(options.type
			? { proposalType: String(options.type).toLowerCase() }
			: {}),
		...(options.domain
			? { domainId: String(options.domain).toUpperCase() }
			: {}),
		...(options.category
			? { category: String(options.category).toUpperCase() }
			: {}),
		...(options.needs ? { needs_capabilities: options.needs as string[] } : {}),
		...(options.external
			? { external_injections: options.external as string[] }
			: {}),
		...(options.unlocks ? { unlocks: options.unlocks as string[] } : {}),
		...(options.builder ? { builder: String(options.builder) } : {}),
		...(options.auditor ? { auditor: String(options.auditor) } : {}),
		verificationProposalments: Array.isArray(options.verify)
			? options.verify
					.map((assertion, index) => ({
						index: index + 1,
						text: String(assertion ?? "").trim(),
						checked: false,
					}))
					.filter((assertion) => assertion.text.length > 0)
			: [],
	};
}

const proposalCmd = program.command("proposal").aliases(["proposals"]);

proposalCmd
	.command("create [title]")
	.option(
		"-d, --description <text>",
		"proposal description (multi-line: bash $'Line1\\nLine2', POSIX printf, PowerShell \"Line1`nLine2\")",
	)
	.option("--desc <text>", "alias for --description")
	.option("-a, --assignee <assignee>")
	.option(
		"--builder <agent>",
		"the agent primarily responsible for implementation",
	)
	.option(
		"--auditor <agent>",
		"the agent responsible for peer review and audit",
	)
	.option("-s, --status <status>")
	.option(
		"-t, --type <type>",
		"proposal type (product, component, feature, issue)",
	)
	.option("--domain <domainId>", "domain ID (e.g. CORE, INFRA)")
	.option(
		"--category <category>",
		"category (FEATURE, BUG, RESEARCH, SECURITY, INFRA)",
	)
	.option("-l, --labels <labels>")
	.option("--priority <priority>", "set proposal priority (high, medium, low)")
	.option("--plain", "use plain text output after creating")
	.option(
		"--ac <criteria>",
		"add acceptance criteria (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--acceptance-criteria <criteria>",
		"add acceptance criteria (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--verify <assertion>",
		"add verification proposalment (assertion) (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--verify-role <role>",
		"specify the role responsible for the next verification proposalment added (builder|peer-tester)",
	)
	.option(
		"--verify-evidence <type>",
		"specify the expected evidence for the next verification proposalment added",
	)
	.option("--plan <text>", "add implementation plan")
	.option("--notes <text>", "add implementation notes")
	.option("--final-summary <text>", "add final summary")
	.option("--draft")
	.option("-p, --parent <proposalId>", "specify parent proposal ID")
	.option(
		"--depends-on <proposalIds>",
		"specify proposal dependencies (comma-separated or use multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--dep <proposalIds>",
		"specify proposal dependencies (shortcut for --depends-on)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--ref <reference>",
		"add reference URL or file path (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--doc <documentation>",
		"add documentation URL or file path (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--requires <requirement>",
		"add resource requirement (e.g. capability:high-reasoning) (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--rationale <text>",
		"proposal rationale or constraint type (e.g. external, decision, technical)",
	)
	.option(
		"--maturity <level>",
		"proposal maturity level (new, active, mature, obsolete)",
	)
	.option(
		"--needs <capability>",
		"add agent capability requirement (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--external <injection>",
		"add external injection/blocker (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--unlocks <capability>",
		"add product capability unlocked (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.action(async (title: string | undefined, options) => {
		const shouldUseWizard =
			hasInteractiveTTY && title === undefined && !hasCreateFieldFlags(options);
		if (
			!shouldUseWizard &&
			(title === undefined || title.trim().length === 0)
		) {
			printMissingRequiredArgument("title");
			return;
		}

		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		await core.ensureConfigLoaded();

		if (shouldUseWizard) {
			const statuses = await getValidStatuses(core);
			const wizardInput = await runProposalCreateWizard({ statuses });
			if (!wizardInput) {
				clack.cancel("Proposal create cancelled.");
				return;
			}
			try {
				const { proposal, filePath } =
					await core.createProposalFromInput(wizardInput);
				process.stdout.write(`Created proposal ${proposal.id}\n`);
				if (filePath) {
					console.log(`File: ${filePath}`);
				}
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			}
			return;
		}

		const createAsDraft = Boolean(options.draft);
		const id = await core.generateNextId(
			createAsDraft ? EntityType.Draft : EntityType.Proposal,
			createAsDraft ? undefined : options.parent,
		);
		const proposal = buildProposalFromOptions(id, title ?? "", options);

		// Normalize and validate status if provided (case-insensitive)
		if (options.status) {
			const canonical = await getCanonicalStatus(String(options.status), core);
			if (!canonical) {
				const configuredStatuses = await getValidStatuses(core);
				console.error(
					`Invalid status: ${options.status}. Valid statuses are: ${formatValidStatuses(configuredStatuses)}`,
				);
				process.exitCode = 1;
				return;
			}
			proposal.status = canonical;
		}

		// Validate dependencies if provided
		if (proposal.dependencies.length > 0) {
			const { valid, invalid } = await validateDependencies(
				proposal.dependencies,
				core,
			);
			if (invalid.length > 0) {
				console.error(
					`Error: The following dependencies do not exist: ${invalid.join(", ")}`,
				);
				console.error(
					"Please create these proposals first or check the proposal IDs.",
				);
				process.exitCode = 1;
				return;
			}
			proposal.dependencies = valid;
		}

		// Handle acceptance criteria for create command (structured only)
		const criteria = processAcceptanceCriteriaOptions(options);
		if (criteria.length > 0) {
			let idx = 1;
			proposal.acceptanceCriteriaItems = criteria.map((text) => ({
				index: idx++,
				text,
				checked: false,
			}));
		}

		const verificationAdditions = processVerificationOptions(options);
		if (verificationAdditions.length > 0) {
			let idx = 1;
			proposal.verificationProposalments = verificationAdditions.map(
				(text) => ({
					index: idx++,
					text,
					checked: false,
				}),
			);
		}

		// Handle implementation plan
		if (options.plan) {
			proposal.implementationPlan = String(options.plan);
		}

		// Handle implementation notes
		if (options.notes) {
			proposal.implementationNotes = String(options.notes);
		}

		// Handle final summary
		if (options.finalSummary) {
			proposal.finalSummary = String(options.finalSummary);
		}

		const usePlainOutput = isPlainRequested(options);

		if (createAsDraft) {
			const filepath = await core.createDraft(proposal);
			if (usePlainOutput) {
				process.stdout.write(`Created draft ${proposal.id}\n`);
				console.log(
					formatProposalPlainText(proposal, { filePathOverride: filepath }),
				);
				return;
			}
			console.error(`Created draft ${proposal.id}`);
			console.error(`File: ${filepath}`);
		} else {
			const filepath = await core.createProposal(proposal);
			if (usePlainOutput) {
				process.stdout.write(`Created proposal ${proposal.id}\n`);
				console.log(
					formatProposalPlainText(proposal, { filePathOverride: filepath }),
				);
				return;
			}
			console.error(`Created proposal ${proposal.id}`);
			console.error(`File: ${filepath}`);
		}
	});

program
	.command("search [query]")
	.description(
		"search proposals, documents, and decisions using the shared index",
	)
	.option(
		"--type <type>",
		"limit results to type (proposal, document, decision)",
		createMultiValueAccumulator(),
	)
	.option("--status <status>", "filter proposal results by status")
	.option(
		"--priority <priority>",
		"filter proposal results by priority (high, medium, low)",
	)
	.option("--rationale <text>", "filter proposal results by rationale")
	.option(
		"--ready",
		"filter for proposals that are ready for pickup (unblocked and unassigned)",
	)
	.option("--limit <number>", "limit total results returned")
	.option("--plain", "print plain text output instead of interactive UI")
	.action(async (query: string | undefined, options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const searchService = await core.getSearchService();
		const contentStore = await core.getContentStore();
		const cleanup = () => {
			searchService.dispose();
			contentStore.dispose();
		};

		const rawTypes = options.type
			? Array.isArray(options.type)
				? options.type
				: [options.type]
			: undefined;
		const allowedTypes: SearchResultType[] = [
			"proposal",
			"document",
			"decision",
		];
		const types = rawTypes
			? rawTypes
					.map((value: string) => value.toLowerCase())
					.filter((value: string): value is SearchResultType => {
						if (!allowedTypes.includes(value as SearchResultType)) {
							console.warn(
								`Ignoring unsupported type '${value}'. Supported: proposal, document, decision`,
							);
							return false;
						}
						return true;
					})
			: allowedTypes;

		const filters: {
			status?: string;
			priority?: SearchPriorityFilter;
			ready?: boolean;
			rationale?: string;
		} = {};
		if (options.status) {
			filters.status = options.status;
		}
		if (options.priority) {
			const priorityLower = String(options.priority).toLowerCase();
			const validPriorities: SearchPriorityFilter[] = ["high", "medium", "low"];
			if (!validPriorities.includes(priorityLower as SearchPriorityFilter)) {
				console.error("Invalid priority. Valid values: high, medium, low");
				cleanup();
				process.exitCode = 1;
				return;
			}
			filters.priority = priorityLower as SearchPriorityFilter;
		}
		if (options.ready) {
			filters.ready = true;
		}
		if (options.rationale) {
			filters.rationale = options.rationale;
		}

		let limit: number | undefined;
		if (options.limit !== undefined) {
			const parsed = Number.parseInt(String(options.limit), 10);
			if (Number.isNaN(parsed) || parsed <= 0) {
				console.error("--limit must be a positive integer");
				cleanup();
				process.exitCode = 1;
				return;
			}
			limit = parsed;
		}

		const searchResults = searchService.search({
			query: query ?? "",
			limit,
			types,
			filters,
		});

		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			printSearchResults(searchResults);
			cleanup();
			return;
		}

		const proposalResults = searchResults.filter(isProposalSearchResult);
		const searchResultProposals = proposalResults.map(
			(result) => result.proposal,
		);

		const allProposals = (await core.queryProposals()).filter(
			(proposal) =>
				proposal.id && proposal.id.trim() !== "" && hasAnyPrefix(proposal.id),
		);

		// If no proposals exist at all, show plain text results
		if (allProposals.length === 0) {
			printSearchResults(searchResults);
			cleanup();
			return;
		}

		// Use the first search result as the selected proposal, or first available proposal if no results
		const firstProposal = searchResultProposals[0] || allProposals[0];
		const priorityFilter = filters.priority ? filters.priority : undefined;
		const statusFilter = filters.status;
		const { runUnifiedView } = await import("../ui/unified-view.ts");

		await runUnifiedView({
			core,
			initialView: "proposal-list",
			selectedProposal: firstProposal,
			proposals: allProposals, // Pass ALL proposals, not just search results
			filter: {
				title: query ? `Search: ${query}` : "Search",
				filterDescription: buildSearchFilterDescription({
					status: statusFilter,
					priority: priorityFilter,
					query: query ?? "",
				}),
				status: statusFilter,
				priority: priorityFilter,
				searchQuery: query ?? "", // Pre-populate search with the query
			},
		});
		cleanup();
	});

function buildSearchFilterDescription(filters: {
	status?: string;
	priority?: SearchPriorityFilter;
	query?: string;
}): string {
	const parts: string[] = [];
	if (filters.query) {
		parts.push(`Query: ${filters.query}`);
	}
	if (filters.status) {
		parts.push(`Status: ${filters.status}`);
	}
	if (filters.priority) {
		parts.push(`Priority: ${filters.priority}`);
	}
	return parts.join(" • ");
}

function printSearchResults(results: SearchResult[]): void {
	if (results.length === 0) {
		console.log("No results found.");
		return;
	}

	const proposals: ProposalSearchResult[] = [];
	const documents: DocumentSearchResult[] = [];
	const decisions: DecisionSearchResult[] = [];

	for (const result of results) {
		if (result.type === "proposal") {
			proposals.push(result);
			continue;
		}
		if (result.type === "document") {
			documents.push(result);
			continue;
		}
		decisions.push(result);
	}

	const localProposals = proposals.filter((t) =>
		isLocalEditableProposal(t.proposal),
	);

	let printed = false;

	if (localProposals.length > 0) {
		console.log("Proposals:");
		for (const proposalResult of localProposals) {
			const { proposal } = proposalResult;
			const scoreText = formatScore(proposalResult.score);
			const statusText = proposal.status ? ` (${proposal.status})` : "";
			const priorityText = proposal.priority
				? ` [${proposal.priority.toUpperCase()}]`
				: "";
			console.log(
				`  ${proposal.id} - ${proposal.title}${statusText}${priorityText}${scoreText}`,
			);
		}
		printed = true;
	}

	if (documents.length > 0) {
		if (printed) {
			console.log("");
		}
		console.log("Documents:");
		for (const documentResult of documents) {
			const { document } = documentResult;
			const scoreText = formatScore(documentResult.score);
			console.log(`  ${document.id} - ${document.title}${scoreText}`);
		}
		printed = true;
	}

	if (decisions.length > 0) {
		if (printed) {
			console.log("");
		}
		console.log("Decisions:");
		for (const decisionResult of decisions) {
			const { decision } = decisionResult;
			const scoreText = formatScore(decisionResult.score);
			console.log(`  ${decision.id} - ${decision.title}${scoreText}`);
		}
		printed = true;
	}

	if (!printed) {
		console.log("No results found.");
	}
}

function formatScore(score: number | null): string {
	if (score === null || score === undefined) {
		return "";
	}
	// Invert score so higher is better (Fuse.js uses 0=perfect match, 1=no match)
	const invertedScore = 1 - score;
	return ` [score ${invertedScore.toFixed(3)}]`;
}

function isProposalSearchResult(
	result: SearchResult,
): result is ProposalSearchResult {
	return result.type === "proposal";
}

proposalCmd
	.command("claim <proposalId> <agent>")
	.description("claim a proposal with a short-lived lease")
	.option(
		"-d, --duration <minutes>",
		"lease duration in minutes",
		String(DEFAULT_CLAIM_DURATION_MINUTES),
	)
	.option("-m, --message <text>", "optional message for the claim")
	.option("-f, --force", "force claim even if already claimed by another agent")
	.action(async (proposalId, agent, options) => {
		const { requireProjectRoot } = await import("../utils/project-root.ts");
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			const proposal = await core.claimProposal(proposalId, agent, {
				durationMinutes: Number.parseInt(options.duration, 10),
				message: options.message,
				force: options.force,
				autoCommit: true,
			});
			console.log(
				`Claimed proposal ${proposalId} for ${agent} until ${proposal.claim?.expires}`,
			);
		} catch (err) {
			console.error(
				`Failed to claim proposal ${proposalId}: ${(err as Error).message}`,
			);
			process.exit(1);
		}
	});

proposalCmd
	.command("release <proposalId> <agent>")
	.description("release a claim on a proposal")
	.option("-f, --force", "force release even if claim is held by another agent")
	.action(async (proposalId, agent, options) => {
		const { requireProjectRoot } = await import("../utils/project-root.ts");
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			await core.releaseClaim(proposalId, agent, {
				force: options.force,
				autoCommit: true,
			});
			console.log(`Released claim on proposal ${proposalId}`);
		} catch (err) {
			console.error(
				`Failed to release claim on proposal ${proposalId}: ${(err as Error).message}`,
			);
			process.exit(1);
		}
	});

// ===================== Note Commands (S130) =====================
proposalCmd
	.command("note-add <proposalId> <agent>")
	.description("add a note to a proposal")
	.option("-c, --content <text>", "note content (required)")
	.option(
		"-t, --type <type>",
		"note type: discussion|review|decision|question",
		"discussion",
	)
	.action(async (proposalId, agent, options) => {
		if (!options.content) {
			console.error("Error: --content is required");
			process.exit(1);
		}
		const validTypes = ["discussion", "review", "decision", "question"];
		if (!validTypes.includes(options.type)) {
			console.error(`Error: --type must be one of: ${validTypes.join(", ")}`);
			process.exit(1);
		}
		try {
			const resp = await fetch(`${getDaemonUrl()}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "create_note",
						arguments: {
							step_id: proposalId,
							agent_id: agent,
							content: options.content,
							note_type: options.type,
						},
					},
				}),
			});
			const data = await resp.json();
			console.log(data.result?.content?.[0]?.text || JSON.stringify(data));
		} catch (err) {
			console.error(`Failed to add note: ${(err as Error).message}`);
			process.exit(1);
		}
	});

proposalCmd
	.command("note-list <proposalId>")
	.description("list notes for a proposal")
	.option("-t, --type <type>", "filter by note type")
	.option("-n, --limit <number>", "limit number of results")
	.action(async (proposalId, options) => {
		try {
			const resp = await fetch(`${getDaemonUrl()}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "list_notes",
						arguments: {
							step_id: proposalId,
							note_type: options.type,
							limit: options.limit ? parseInt(options.limit, 10) : undefined,
						},
					},
				}),
			});
			const data = await resp.json();
			console.log(data.result?.content?.[0]?.text || "No notes found");
		} catch (err) {
			console.error(`Failed to list notes: ${(err as Error).message}`);
			process.exit(1);
		}
	});

proposalCmd
	.command("note-delete <noteId> <agent>")
	.description("delete a note (must be author)")
	.action(async (noteId, agent) => {
		try {
			const resp = await fetch(`${getDaemonUrl()}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "delete_note",
						arguments: { note_id: parseInt(noteId, 10), agent_id: agent },
					},
				}),
			});
			const data = await resp.json();
			console.log(data.result?.content?.[0]?.text || JSON.stringify(data));
		} catch (err) {
			console.error(`Failed to delete note: ${(err as Error).message}`);
			process.exit(1);
		}
	});

proposalCmd
	.command("renew <proposalId> <agent>")
	.description("renew an existing claim")
	.option(
		"-d, --duration <minutes>",
		"lease duration in minutes",
		String(DEFAULT_CLAIM_DURATION_MINUTES),
	)
	.action(async (proposalId, agent, options) => {
		const { requireProjectRoot } = await import("../utils/project-root.ts");
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			const proposal = await core.renewClaim(proposalId, agent, {
				durationMinutes: Number.parseInt(options.duration, 10),
				autoCommit: true,
			});
			console.log(
				`Renewed claim on proposal ${proposalId} for ${agent} until ${proposal.claim?.expires}`,
			);
		} catch (err) {
			console.error(
				`Failed to renew claim on proposal ${proposalId}: ${(err as Error).message}`,
			);
			process.exit(1);
		}
	});

proposalCmd
	.command("heartbeat <proposalId> <agent>")
	.description(
		"signal that the agent is still actively working on the proposal",
	)
	.action(async (proposalId, agent) => {
		const { requireProjectRoot } = await import("../utils/project-root.ts");
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			const proposal = await core.heartbeat(proposalId, agent, true);
			console.log(
				`Heartbeat recorded for proposal ${proposalId} (Claim valid until ${proposal.claim?.expires})`,
			);
		} catch (err) {
			console.error(
				`Failed to record heartbeat for proposal ${proposalId}: ${(err as Error).message}`,
			);
			process.exit(1);
		}
	});

proposalCmd
	.command("prune-claims")
	.description("remove claims that have exceeded their heartbeat timeout")
	.option("-t, --timeout <minutes>", "heartbeat timeout in minutes")
	.action(async (options) => {
		const { requireProjectRoot } = await import("../utils/project-root.ts");
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			const recoveredIds = await core.pruneClaims({
				timeoutMinutes: options.timeout
					? Number.parseInt(options.timeout, 10)
					: undefined,
				autoCommit: true,
			});
			if (recoveredIds.length > 0) {
				console.log(
					`Recovered ${recoveredIds.length} stale leases: ${recoveredIds.join(", ")}`,
				);
			} else {
				console.log("No stale leases found.");
			}
		} catch (err) {
			console.error(`Failed to prune claims: ${(err as Error).message}`);
			process.exit(1);
		}
	});

proposalCmd
	.command("impact <proposalId>")
	.description(
		"analyze the forward impact of a proposal change (what breaks if this changes?)",
	)
	.action(async (proposalId) => {
		const { requireProjectRoot } = await import("../utils/project-root.ts");
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			const impact = await core.getImpact(normalizeProposalId(proposalId));
			if (impact.length === 0) {
				console.log("No downstream proposals are affected by this change.");
				return;
			}
			console.log(`Forward Impact Analysis for ${proposalId}:`);
			console.log(
				`The following ${impact.length} proposals depend on this path:`,
			);
			for (const proposal of impact) {
				console.log(
					`- ${proposal.id} - ${proposal.title} [${proposal.status}]`,
				);
			}
		} catch (err) {
			console.error(`Failed to analyze impact: ${(err as Error).message}`);
			process.exit(1);
		}
	});

proposalCmd
	.command("list")
	.description("list proposals grouped by status")
	.option(
		"-s, --status <status>",
		"filter proposals by status (case-insensitive)",
	)
	.option("-a, --assignee <assignee>", "filter proposals by assignee")
	.option(
		"-m, --directive <directive>",
		"filter proposals by directive (closest match, case-insensitive)",
	)
	.option("-p, --parent <proposalId>", "filter proposals by parent proposal ID")
	.option(
		"-l, --labels <labels>",
		"filter proposals by labels (comma-separated)",
	)
	.option(
		"--priority <priority>",
		"filter proposals by priority (high, medium, low)",
	)
	.option(
		"--ready",
		"filter for proposals that are ready for pickup (unblocked and unassigned)",
	)
	.option("--sort <field>", "sort proposals by field (priority, id)")
	.option("--rationale <text>", "filter proposals by rationale")
	.option("--depth <number>", "filter proposals by depth level (0 = top-level)")
	.option("--plain", "use plain text output instead of interactive UI")
	.option("--compact", "use compact one-line plain text output")
	.action(async (options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const cleanup = () => {
			core.disposeSearchService();
			core.disposeContentStore();
		};
		const baseFilters: ProposalListFilter = {};
		if (options.status) {
			baseFilters.status = options.status;
		}
		if (options.assignee) {
			baseFilters.assignee = options.assignee;
		}
		if (options.directive) {
			baseFilters.directive = options.directive;
		}
		if (options.labels) {
			baseFilters.labels = String(options.labels)
				.split(",")
				.map((l) => l.trim())
				.filter(Boolean);
		}
		if (options.priority) {
			const priorityLower = options.priority.toLowerCase();
			const validPriorities = ["high", "medium", "low"] as const;
			if (
				!validPriorities.includes(
					priorityLower as (typeof validPriorities)[number],
				)
			) {
				console.error(
					`Invalid priority: ${options.priority}. Valid values are: high, medium, low`,
				);
				process.exitCode = 1;
				cleanup();
				return;
			}
			baseFilters.priority = priorityLower as (typeof validPriorities)[number];
		}
		if (options.ready) {
			baseFilters.ready = true;
		}
		if (options.rationale) {
			baseFilters.rationale = options.rationale;
		}
		if (options.depth !== undefined) {
			baseFilters.depth = Number.parseInt(String(options.depth), 10);
		}
		if (options.maturity) {
			baseFilters.maturity = String(options.maturity).toLowerCase() as any;
		}

		let parentId: string | undefined;
		if (options.parent) {
			const parentInput = String(options.parent);
			parentId = normalizeProposalId(parentInput);
			baseFilters.parentProposalId = parentInput;
		}

		if (options.sort) {
			const validSortFields = ["priority", "id"];
			const sortField = options.sort.toLowerCase();
			if (!validSortFields.includes(sortField)) {
				console.error(
					`Invalid sort field: ${options.sort}. Valid values are: priority, id`,
				);
				process.exitCode = 1;
				cleanup();
				return;
			}
		}

		const usePlainOutput =
			options.compact || isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			const proposals = await core.queryProposals({
				filters: baseFilters,
				includeCrossBranch: false,
			});
			const config = await core.filesystem.loadConfig();

			if (parentId) {
				const parentExists = (
					await core.queryProposals({ includeCrossBranch: false })
				).some((proposal) => proposalIdsEqual(parentId, proposal.id));
				if (!parentExists) {
					console.error(`Parent proposal ${parentId} not found.`);
					process.exitCode = 1;
					cleanup();
					return;
				}
			}

			let sortedProposals = proposals;
			if (options.sort) {
				const validSortFields = ["priority", "id"];
				const sortField = options.sort.toLowerCase();
				if (!validSortFields.includes(sortField)) {
					console.error(
						`Invalid sort field: ${options.sort}. Valid values are: priority, id`,
					);
					process.exitCode = 1;
					cleanup();
					return;
				}
				sortedProposals = sortProposals(proposals, sortField);
			} else {
				sortedProposals = sortProposals(proposals, "priority");
			}

			let filtered = sortedProposals;
			if (parentId) {
				filtered = filtered.filter(
					(proposal) =>
						proposal.parentProposalId &&
						proposalIdsEqual(parentId, proposal.parentProposalId),
				);
			}
			if (options.rationale) {
				const rationaleLower = String(options.rationale).toLowerCase();
				filtered = filtered.filter(
					(proposal) =>
						(proposal.rationale ?? "").toLowerCase() === rationaleLower,
				);
			}
			if (options.depth !== undefined) {
				const targetDepth = Number.parseInt(String(options.depth), 10);
				filtered = filtered.filter(
					(proposal) => proposal.depth === targetDepth,
				);
			}
			if (options.maturity) {
				const maturityLower = String(options.maturity).toLowerCase();
				filtered = filtered.filter(
					(proposal) =>
						(proposal.maturity ?? "").toLowerCase() === maturityLower,
				);
			}

			if (filtered.length === 0) {
				if (options.parent) {
					const canonicalParent = normalizeProposalId(String(options.parent));
					console.log(
						`No child proposals found for parent proposal ${canonicalParent}.`,
					);
				} else {
					console.log("No proposals found.");
				}
				cleanup();
				return;
			}

			if (options.compact) {
				filtered.forEach((proposal) => {
					console.log(formatCompactProposalListLine(proposal));
				});
				cleanup();
				return;
			}

			if (options.sort && options.sort.toLowerCase() === "priority") {
				const sortedByPriority = sortProposals(filtered, "priority");
				console.log("Proposals (sorted by priority):");
				for (const t of sortedByPriority) {
					const priorityIndicator = t.priority
						? `[${t.priority.toUpperCase()}] `
						: "";
					const statusIndicator = t.status ? ` (${t.status})` : "";
					console.log(
						`  ${priorityIndicator}${t.id} - ${t.title}${statusIndicator}`,
					);
				}
				cleanup();
				return;
			}

			const canonicalByLower = new Map<string, string>();
			const statuses = config?.statuses || [];
			for (const status of statuses) {
				canonicalByLower.set(status.toLowerCase(), status);
			}

			const groups = new Map<string, Proposal[]>();
			for (const proposal of filtered) {
				const rawStatus = (proposal.status || "").trim();
				const canonicalStatus =
					canonicalByLower.get(rawStatus.toLowerCase()) || rawStatus;
				const list = groups.get(canonicalStatus) || [];
				list.push(proposal);
				groups.set(canonicalStatus, list);
			}

			const orderedStatuses = [
				...statuses.filter((status) => groups.has(status)),
				...Array.from(groups.keys()).filter(
					(status) => !statuses.includes(status),
				),
			];

			// Reorder by workflow: RFC first, then operational/legacy states
			const workflowOrder = [
				"DRAFT",
				"REVIEW",
				"DEVELOP",
				"MERGE",
				"COMPLETE",
				"TRIAGE",
				"FIX",
				"DEPLOYED",
				"ESCALATE",
				"WONT_FIX",
				"NON_ISSUE",
			];

			const reorderedStatuses = orderedStatuses.sort((a, b) => {
				const aIdx = workflowOrder.indexOf(a.toUpperCase());
				const bIdx = workflowOrder.indexOf(b.toUpperCase());
				// If both are in workflow order, sort by that
				if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
				// If only one is in workflow order, it comes first
				if (aIdx >= 0) return -1;
				if (bIdx >= 0) return 1;
				// Neither in workflow order, keep original order
				return 0;
			});

			for (const status of reorderedStatuses) {
				const list = groups.get(status);
				if (!list) continue;
				let sortedList = list;
				if (options.sort) {
					sortedList = sortProposals(list, options.sort.toLowerCase());
				}
				console.log(`${status || "No Status"}:`);
				sortedList.forEach((proposal) => {
					const priorityIndicator = proposal.priority
						? `[${proposal.priority.toUpperCase()}] `
						: "";
					const readyIndicator = proposal.ready ? " [READY]" : "";
					const indent = "  ".repeat(proposal.depth || 0);
					console.log(
						`${indent}  ${priorityIndicator}${proposal.id} - ${proposal.title}${readyIndicator}`,
					);
				});
				console.log();
			}
			cleanup();
			return;
		}

		let filterDescription = "";
		let title = "Proposals";
		const activeFilters: string[] = [];
		if (options.status) activeFilters.push(`Status: ${options.status}`);
		if (options.assignee) activeFilters.push(`Assignee: ${options.assignee}`);
		if (options.parent) {
			activeFilters.push(
				`Parent: ${normalizeProposalId(String(options.parent))}`,
			);
		}
		if (options.directive)
			activeFilters.push(`Directive: ${options.directive}`);
		if (options.labels) activeFilters.push(`Labels: ${options.labels}`);
		if (options.priority) activeFilters.push(`Priority: ${options.priority}`);
		if (options.ready) activeFilters.push("Ready for pickup");
		if (options.sort) activeFilters.push(`Sort: ${options.sort}`);

		if (activeFilters.length > 0) {
			filterDescription = activeFilters.join(", ");
			title = `Proposals (${activeFilters.join(" • ")})`;
		}
		const initialUnifiedFilter: {
			status?: string;
			assignee?: string;
			directive?: string;
			priority?: string;
			sort?: string;
			title?: string;
			filterDescription?: string;
			parentProposalId?: string;
			labels?: string[];
			ready?: boolean;
		} = {
			status: options.status,
			assignee: options.assignee,
			directive: options.directive,
			priority: options.priority,
			sort: options.sort,
			title,
			filterDescription,
			parentProposalId: parentId,
			labels: baseFilters.labels,
			ready: options.ready,
		};

		const { runUnifiedView } = await import("../ui/unified-view.ts");
		const interactiveLoaderFilters: ProposalListFilter = {};
		if (options.assignee) {
			interactiveLoaderFilters.assignee = options.assignee;
		}
		if (parentId) {
			interactiveLoaderFilters.parentProposalId = parentId;
		}
		if (options.status) {
			interactiveLoaderFilters.status = options.status;
		}
		if (options.priority) {
			interactiveLoaderFilters.priority = options.priority;
		}
		if (options.labels) {
			interactiveLoaderFilters.labels = baseFilters.labels;
		}
		if (options.ready) {
			interactiveLoaderFilters.ready = true;
		}
		if (options.rationale) {
			interactiveLoaderFilters.rationale = options.rationale;
		}
		if (options.depth !== undefined) {
			interactiveLoaderFilters.depth = Number.parseInt(
				String(options.depth),
				10,
			);
		}
		if (options.maturity) {
			interactiveLoaderFilters.maturity = String(
				options.maturity,
			).toLowerCase() as any;
		}
		await runUnifiedView({
			core,
			initialView: "proposal-list",
			proposalsLoader: async (updateProgress) => {
				updateProgress("Loading configuration...");
				const config = await core.filesystem.loadConfig();

				// Use loadProposals with progress callback for consistent loading experience
				// This populates the ContentStore, so subsequent queryProposals calls are fast
				await core.loadProposals((msg) => {
					updateProgress(msg);
				});

				// Now query with filters - this will use the already-populated ContentStore
				updateProgress("Applying filters...");
				const [proposals, allProposalsForParentCheck] = await Promise.all([
					core.queryProposals({
						filters:
							Object.keys(interactiveLoaderFilters).length > 0
								? interactiveLoaderFilters
								: undefined,
					}),
					parentId ? core.queryProposals() : Promise.resolve(undefined),
				]);

				if (parentId && allProposalsForParentCheck) {
					const parentExists = allProposalsForParentCheck.some((proposal) =>
						proposalIdsEqual(parentId, proposal.id),
					);
					if (!parentExists) {
						throw new Error(`Parent proposal ${parentId} not found.`);
					}
				}

				let sortedProposals = proposals;
				if (options.sort) {
					const validSortFields = ["priority", "id"];
					const sortField = options.sort.toLowerCase();
					if (!validSortFields.includes(sortField)) {
						throw new Error(
							`Invalid sort field: ${options.sort}. Valid values are: priority, id`,
						);
					}
					sortedProposals = sortProposals(proposals, sortField);
				} else {
					sortedProposals = sortProposals(proposals, "priority");
				}

				let filtered = sortedProposals;
				if (parentId) {
					filtered = filtered.filter(
						(proposal) =>
							proposal.parentProposalId &&
							proposalIdsEqual(parentId, proposal.parentProposalId),
					);
				}

				if (options.directive && filtered.length > 0) {
					const [activeDirectives, archivedDirectives] = await Promise.all([
						core.filesystem.listDirectives(),
						core.filesystem.listArchivedDirectives(),
					]);
					const resolveDirectiveFilterValue =
						createDirectiveFilterValueResolver([
							...activeDirectives,
							...archivedDirectives,
						]);
					const resolvedDirective = resolveClosestDirectiveFilterValue(
						options.directive,
						filtered.map((proposal) =>
							resolveDirectiveFilterValue(proposal.directive ?? ""),
						),
					);
					if (resolvedDirective) {
						initialUnifiedFilter.directive = resolvedDirective;
					}
				}

				return {
					proposals: filtered,
					statuses: config?.statuses || [],
				};
			},
			filter: initialUnifiedFilter,
		});
		cleanup();
	});

proposalCmd
	.command("edit [proposalId]")
	.description("edit an existing proposal")
	.option("-t, --title <title>")
	.option(
		"-d, --description <text>",
		"proposal description (multi-line: bash $'Line1\\nLine2', POSIX printf, PowerShell \"Line1`nLine2\")",
	)
	.option("--desc <text>", "alias for --description")
	.option("-a, --assignee <assignee>")
	.option("-s, --status <status>", "set proposal status")
	.option(
		"--request-audit",
		"set status to Review and signal readiness for peer audit",
	)
	.option(
		"-T, --type <type>",
		"proposal type (product, component, feature, issue)",
	)
	.option("--domain <domainId>", "domain ID (e.g. CORE, INFRA)")
	.option(
		"--category <category>",
		"category (FEATURE, BUG, RESEARCH, SECURITY, INFRA)",
	)
	.option(
		"-m, --directive <directive>",
		"set proposal directive (closest match, case-insensitive)",
	)
	.option("-l, --label <labels>")
	.option("--priority <priority>", "set proposal priority (high, medium, low)")
	.option("--ordinal <number>", "set proposal ordinal for custom ordering")
	.option("--plain", "use plain text output after editing")
	.option("--add-label <label>")
	.option("--remove-label <label>")
	.option(
		"--ac <criteria>",
		"add acceptance criteria (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--remove-ac <index>",
		"remove acceptance criterion by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--check-ac <index>",
		"check acceptance criterion by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--uncheck-ac <index>",
		"uncheck acceptance criterion by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--acceptance-criteria <criteria>",
		"set acceptance criteria (comma-separated or use multiple times)",
	)
	.option("--plan <text>", "set implementation plan")
	.option("--notes <text>", "set implementation notes (replaces existing)")
	.option("--audit-notes <text>", "set audit notes (replaces existing)")
	.option("--final-summary <text>", "set final summary (replaces existing)")
	.option(
		"--scope-summary <text>",
		"set high-level synthesis of sub-roadmap progress and insights",
	)
	.option(
		"--append-notes <text>",
		"append to implementation notes (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--append-audit-notes <text>",
		"append to audit notes (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--append-final-summary <text>",
		"append to final summary (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option("--clear-notes", "remove implementation notes")
	.option("--clear-audit-notes", "remove audit notes")
	.option("--clear-final-summary", "remove final summary")
	.option(
		"--depends-on <proposalIds>",
		"set proposal dependencies (comma-separated or use multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--dep <proposalIds>",
		"set proposal dependencies (shortcut for --depends-on)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--ref <reference>",
		"set references (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--doc <documentation>",
		"set documentation (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--requires <requirement>",
		"add resource requirement (can be used multiple times)",
		(value, previous) => {
			const soFar = Array.isArray(previous)
				? previous
				: previous
					? [previous]
					: [];
			return [...soFar, value];
		},
	)
	.option(
		"--remove-requires <index>",
		"remove resource requirement by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option("--clear-requires", "remove all resource requirements")
	.option(
		"--rationale <text>",
		"proposal rationale or constraint type (e.g. external, decision, technical)",
	)
	.option(
		"--maturity <level>",
		"proposal maturity level (new, active, mature, obsolete)",
	)
	.option(
		"--builder <agent>",
		"the agent primarily responsible for implementation",
	)
	.option(
		"--auditor <agent>",
		"the agent responsible for peer review and audit",
	)
	.option(
		"--verify <assertion>",
		"set verification proposalments (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--add-verify <assertion>",
		"add verification proposalment (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--remove-verify <indices>",
		"remove verification proposalments by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--check-verify <indices>",
		"check verification proposalments by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--uncheck-verify <indices>",
		"uncheck verification proposalments by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--verify-role <role>",
		"specify the role responsible for the next verification proposalment added (builder|peer-tester)",
	)
	.option(
		"--verify-evidence <type>",
		"specify the expected evidence for the next verification proposalment added",
	)
	.option(
		"--needs <capability>",
		"set agent capability requirements (comma-separated or use multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--add-needs <capability>",
		"add agent capability requirements (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--remove-needs <indices>",
		"remove agent capability requirements by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--external <injection>",
		"set external injections (comma-separated or use multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--add-external <injection>",
		"add external injections (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--remove-external <indices>",
		"remove external injections by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--unlocks <capability>",
		"set product capabilities unlocked (comma-separated or use multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--add-unlocks <capability>",
		"add product capabilities unlocked (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--remove-unlocks <indices>",
		"remove product capabilities by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--proof <link>",
		"set verifiable evidence of arrival (comma-separated or use multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--add-proof <link>",
		"add verifiable evidence of arrival (can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.option(
		"--remove-proof <indices>",
		"remove proof by index (1-based, can be used multiple times)",
		createMultiValueAccumulator(),
	)
	.action(async (proposalId: string | undefined, options) => {
		const shouldUseWizard = hasInteractiveTTY && !hasEditFieldFlags(options);
		if (!shouldUseWizard && !proposalId) {
			printMissingRequiredArgument("proposalId");
			return;
		}

		const cwd = await requireProjectRoot();
		const core = new Core(cwd);

		if (shouldUseWizard) {
			let selectedProposalId = proposalId
				? normalizeProposalId(proposalId)
				: undefined;
			if (!selectedProposalId) {
				const localProposals = await core.queryProposals({
					includeCrossBranch: false,
				});
				const proposalOptions = localProposals.map((candidate) => ({
					id: candidate.id,
					title: candidate.title,
				}));
				if (proposalOptions.length === 0) {
					console.log("No proposals found.");
					return;
				}
				selectedProposalId = await pickProposalForEditWizard({
					proposals: proposalOptions,
				});
				if (!selectedProposalId) {
					clack.cancel("Proposal edit cancelled.");
					return;
				}
			}

			const existingProposalForWizard =
				await core.loadProposalById(selectedProposalId);
			if (!existingProposalForWizard) {
				console.error(`Proposal ${selectedProposalId} not found.`);
				process.exitCode = 1;
				return;
			}

			const statuses = await getValidStatuses(core);
			const wizardInput = await runProposalEditWizard({
				proposal: existingProposalForWizard,
				statuses,
			});
			if (!wizardInput) {
				clack.cancel("Proposal edit cancelled.");
				return;
			}

			try {
				const updatedProposal = await core.editProposal(
					existingProposalForWizard.id,
					wizardInput,
				);
				console.error(`Updated proposal ${updatedProposal.id}`);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			}
			return;
		}

		const canonicalId = normalizeProposalId(proposalId ?? "");
		const existingProposal = await core.loadProposalById(canonicalId);

		if (!existingProposal) {
			console.error(`Proposal ${proposalId} not found.`);
			process.exitCode = 1;
			return;
		}

		const parseCommaSeparated = (value: unknown): string[] => {
			return toStringArray(value)
				.flatMap((entry) => String(entry).split(","))
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0);
		};

		let canonicalStatus: string | undefined;
		if (options.requestAudit) {
			const canonical = await getCanonicalStatus("Review", core);
			if (canonical) {
				canonicalStatus = canonical;
			} else {
				canonicalStatus = "Review";
			}
		} else if (options.status) {
			const canonical = await getCanonicalStatus(String(options.status), core);
			if (!canonical) {
				const configuredStatuses = await getValidStatuses(core);
				console.error(
					`Invalid status: ${options.status}. Valid statuses are: ${formatValidStatuses(configuredStatuses)}`,
				);
				process.exitCode = 1;
				return;
			}
			canonicalStatus = canonical;
		}

		let normalizedPriority: "high" | "medium" | "low" | undefined;
		if (options.priority) {
			const priority = String(options.priority).toLowerCase();
			const validPriorities = ["high", "medium", "low"] as const;
			if (
				!validPriorities.includes(priority as (typeof validPriorities)[number])
			) {
				console.error(
					`Invalid priority: ${priority}. Valid values are: high, medium, low`,
				);
				process.exitCode = 1;
				return;
			}
			normalizedPriority = priority as "high" | "medium" | "low";
		}

		let resolvedDirective: string | undefined | null;
		if (options.directive !== undefined) {
			const mInput = String(options.directive).trim();
			if (mInput === "" || mInput === "none" || mInput === "null") {
				resolvedDirective = null; // Signal to clear directive
			} else {
				// We need the RoadmapServer's directive resolution logic, but that's private.
				// However, Directive resolution is also in Core.
				// Let's check how RoadmapServer does it - it's a private method there.
				// I'll use a simpler resolution here or just pass the string.
				// Actually, I can use the same logic from orchestrate.ts or similar.
				// For now, I'll use the input string directly as buildProposalUpdateInput handles it.
				resolvedDirective = mInput;
			}
		}

		let ordinalValue: number | undefined;
		if (options.ordinal !== undefined) {
			const parsed = Number(options.ordinal);
			if (Number.isNaN(parsed) || parsed < 0) {
				console.error(
					`Invalid ordinal: ${options.ordinal}. Must be a non-negative number.`,
				);
				process.exitCode = 1;
				return;
			}
			ordinalValue = parsed;
		}

		let removeCriteria: number[] | undefined;
		let checkCriteria: number[] | undefined;
		let uncheckCriteria: number[] | undefined;

		try {
			const removes = parsePositiveIndexList(options.removeAc);
			if (removes.length > 0) {
				removeCriteria = removes;
			}
			const checks = parsePositiveIndexList(options.checkAc);
			if (checks.length > 0) {
				checkCriteria = checks;
			}
			const unchecks = parsePositiveIndexList(options.uncheckAc);
			if (unchecks.length > 0) {
				uncheckCriteria = unchecks;
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
			return;
		}

		const labelValues = parseCommaSeparated(options.label);
		const addLabelValues = parseCommaSeparated(options.addLabel);
		const removeLabelValues = parseCommaSeparated(options.removeLabel);
		const assigneeValues = parseCommaSeparated(options.assignee);
		const acceptanceAdditions = processAcceptanceCriteriaOptions(options);

		const combinedDependencies = [
			...toStringArray(options.dependsOn),
			...toStringArray(options.dep),
		];
		const dependencyValues =
			combinedDependencies.length > 0
				? normalizeDependencies(combinedDependencies)
				: undefined;

		const referenceValues = toStringArray(options.ref);
		const normalizedReferences =
			referenceValues.length > 0
				? normalizeStringList(
						referenceValues.flatMap((r: string) =>
							String(r)
								.split(",")
								.map((s: string) => s.trim()),
						),
					)
				: undefined;

		const documentationValues = toStringArray(options.doc);
		const normalizedDocumentation =
			documentationValues.length > 0
				? normalizeStringList(
						documentationValues.flatMap((d: string) =>
							String(d)
								.split(",")
								.map((s: string) => s.trim()),
						),
					)
				: undefined;

		const notesAppendValues = toStringArray(options.appendNotes);
		const finalSummaryAppendValues = toStringArray(options.appendFinalSummary);

		const editArgs: ProposalEditArgs = {};
		if (options.title) {
			editArgs.title = String(options.title);
		}
		const descriptionOption = options.description ?? options.desc;
		if (descriptionOption !== undefined) {
			editArgs.description = String(descriptionOption);
		}
		if (canonicalStatus) {
			editArgs.status = canonicalStatus;
		}
		if (resolvedDirective !== undefined) {
			editArgs.directive = resolvedDirective;
		}
		if (normalizedPriority) {
			editArgs.priority = normalizedPriority;
		}
		if (ordinalValue !== undefined) {
			editArgs.ordinal = ordinalValue;
		}
		if (labelValues.length > 0) {
			editArgs.labels = labelValues;
		}
		if (addLabelValues.length > 0) {
			editArgs.addLabels = addLabelValues;
		}
		if (removeLabelValues.length > 0) {
			editArgs.removeLabels = removeLabelValues;
		}
		if (assigneeValues.length > 0) {
			editArgs.assignee = assigneeValues;
		}
		if (dependencyValues && dependencyValues.length > 0) {
			editArgs.dependencies = dependencyValues;
		}
		if (normalizedReferences && normalizedReferences.length > 0) {
			editArgs.references = normalizedReferences;
		}
		if (normalizedDocumentation && normalizedDocumentation.length > 0) {
			editArgs.documentation = normalizedDocumentation;
		}
		if (typeof options.plan === "string") {
			editArgs.planSet = String(options.plan);
		}
		if (typeof options.notes === "string") {
			editArgs.notesSet = String(options.notes);
		}
		if (notesAppendValues.length > 0) {
			editArgs.notesAppend = notesAppendValues;
		}
		if (options.clearNotes) {
			editArgs.notesClear = true;
		}
		if (typeof options.auditNotes === "string") {
			editArgs.auditNotesSet = String(options.auditNotes);
		}
		const auditAppendValues = toStringArray(options.appendAuditNotes);
		if (auditAppendValues.length > 0) {
			editArgs.auditNotesAppend = auditAppendValues;
		}
		if (options.clearAuditNotes) {
			editArgs.auditNotesClear = true;
		}
		if (typeof options.finalSummary === "string") {
			editArgs.finalSummary = String(options.finalSummary);
		}
		if (finalSummaryAppendValues.length > 0) {
			editArgs.finalSummaryAppend = finalSummaryAppendValues;
		}
		if (options.clearFinalSummary) {
			editArgs.finalSummaryClear = true;
		}
		if (acceptanceAdditions.length > 0) {
			editArgs.acceptanceCriteriaAdd = acceptanceAdditions;
		}
		if (removeCriteria) {
			editArgs.acceptanceCriteriaRemove = removeCriteria;
		}
		if (checkCriteria) {
			editArgs.acceptanceCriteriaCheck = checkCriteria;
		}
		if (uncheckCriteria) {
			editArgs.acceptanceCriteriaUncheck = uncheckCriteria;
		}

		// Handle resource requirements
		const requiresAddValues = toStringArray(options.requires);
		if (requiresAddValues.length > 0) {
			editArgs.requiresAdd = requiresAddValues;
		}
		const requiresRemoveIndices = parsePositiveIndexList(
			options.removeRequires,
		);
		if (requiresRemoveIndices.length > 0) {
			editArgs.requiresRemove = requiresRemoveIndices;
		}
		if (options.clearRequires) {
			editArgs.requiresClear = true;
		}
		if (options.rationale !== undefined) {
			editArgs.rationale = String(options.rationale);
		}
		if (options.scopeSummary !== undefined) {
			editArgs.scopeSummary = String(options.scopeSummary);
		}
		if (options.maturity !== undefined) {
			editArgs.maturity = String(options.maturity).toLowerCase() as any;
		}

		if (options.builder !== undefined) {
			editArgs.builder = String(options.builder);
		}

		if (options.auditor !== undefined) {
			editArgs.auditor = String(options.auditor);
		}

		if (options.verify !== undefined) {
			editArgs.verificationProposalmentsSet = processVerificationOptions({
				verify: options.verify,
				verifyRole: options.verifyRole,
				verifyEvidence: options.verifyEvidence,
			});
		}

		if (options.addVerify !== undefined) {
			editArgs.verificationProposalmentsAdd = processVerificationOptions({
				addVerify: options.addVerify,
				verifyRole: options.verifyRole,
				verifyEvidence: options.verifyEvidence,
			});
		}

		const removeVerifyIndices = parsePositiveIndexList(options.removeVerify);
		if (removeVerifyIndices.length > 0) {
			editArgs.verificationProposalmentsRemove = removeVerifyIndices;
		}

		const checkVerifyIndices = parsePositiveIndexList(options.checkVerify);
		if (checkVerifyIndices.length > 0) {
			editArgs.verificationProposalmentsCheck = checkVerifyIndices;
		}

		const uncheckVerifyIndices = parsePositiveIndexList(options.uncheckVerify);
		if (uncheckVerifyIndices.length > 0) {
			editArgs.verificationProposalmentsUncheck = uncheckVerifyIndices;
		}

		if (options.type !== undefined) {
			editArgs.proposalType = String(options.type).toLowerCase();
		}
		if (options.domain !== undefined) {
			editArgs.domainId = String(options.domain).toUpperCase();
		}
		if (options.category !== undefined) {
			editArgs.category = String(options.category).toUpperCase();
		}
		if (options.needs !== undefined) {
			editArgs.needs_capabilities = normalizeStringList(options.needs);
		}
		if (options.addNeeds !== undefined) {
			editArgs.addNeedsCapabilities = normalizeStringList(options.addNeeds);
		}
		const removeNeedsIndices = parsePositiveIndexList(options.removeNeeds);
		if (removeNeedsIndices.length > 0) {
			editArgs.removeNeedsCapabilities = removeNeedsIndices;
		}
		if (options.external !== undefined) {
			editArgs.external_injections = normalizeStringList(options.external);
		}
		if (options.addExternal !== undefined) {
			editArgs.addExternalInjections = normalizeStringList(options.addExternal);
		}
		const removeExternalIndices = parsePositiveIndexList(
			options.removeExternal,
		);
		if (removeExternalIndices.length > 0) {
			editArgs.removeExternalInjections = removeExternalIndices;
		}
		if (options.unlocks !== undefined) {
			editArgs.unlocks = normalizeStringList(options.unlocks);
		}
		if (options.addUnlocks !== undefined) {
			editArgs.addUnlocks = normalizeStringList(options.addUnlocks);
		}
		const removeUnlocksIndices = parsePositiveIndexList(options.removeUnlocks);
		if (removeUnlocksIndices.length > 0) {
			editArgs.removeUnlocks = removeUnlocksIndices;
		}
		if (options.proof !== undefined) {
			editArgs.proof = normalizeStringList(options.proof);
		}
		if (options.addProof !== undefined) {
			editArgs.addProof = normalizeStringList(options.addProof);
		}
		const removeProofIndices = parsePositiveIndexList(options.removeProof);
		if (removeProofIndices.length > 0) {
			editArgs.removeProof = removeProofIndices;
		}

		let updatedProposal: Proposal;
		try {
			const updateInput = buildProposalUpdateInput(editArgs);
			updatedProposal = await core.editProposal(canonicalId, updateInput);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
			return;
		}

		const usePlainOutput = isPlainRequested(options);
		if (usePlainOutput) {
			console.log(formatProposalPlainText(updatedProposal));
			return;
		}

		console.error(`Updated proposal ${updatedProposal.id}`);
	});

// Note: Implementation notes appending is handled via `proposal edit --append-notes` only.

proposalCmd
	.command("view <proposalId>")
	.description("display proposal details")
	.option("--plain", "use plain text output instead of interactive UI")
	.action(async (proposalId: string, options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const localProposals = await core.fs.listProposals();
		const proposal = await core.getProposalWithSubproposals(
			proposalId,
			localProposals,
		);
		if (!proposal) {
			console.error(`Proposal ${proposalId} not found.`);
			return;
		}

		const allProposals = localProposals.some((candidate) =>
			proposalIdsEqual(proposal.id, candidate.id),
		)
			? localProposals
			: [...localProposals, proposal];

		// Plain text output for non-interactive environments
		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			console.log(formatProposalPlainText(proposal));
			return;
		}

		// Use enhanced proposal viewer with detail focus
		const { viewProposalEnhanced } = await import(
			"../ui/proposal-viewer-with-search.ts"
		);
		await viewProposalEnhanced(proposal, {
			startWithDetailFocus: true,
			core,
			proposals: allProposals,
		});
	});

proposalCmd
	.command("archive <proposalId>")
	.description("archive a proposal")
	.action(async (proposalId: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const success = await core.archiveProposal(proposalId);
		if (success) {
			console.error(`Archived proposal ${proposalId}`);
		} else {
			console.error(`Proposal ${proposalId} not found.`);
		}
	});

proposalCmd
	.command("demote <proposalId>")
	.description("move proposal back to drafts")
	.action(async (proposalId: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const success = await core.demoteProposal(proposalId);
		if (success) {
			console.error(`Demoted proposal ${proposalId}`);
		} else {
			console.error(`Proposal ${proposalId} not found.`);
		}
	});

proposalCmd
	.command("promote <proposalId>")
	.description("promote proposal to the next status level")
	.action(async (proposalId: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const proposal = await core.promoteProposal(proposalId, "cli", true);
		console.log(`Promoted proposal ${proposalId} to ${proposal.status}`);
	});

proposalCmd
	.command("merge <sourceId> <targetId>")
	.description("merge one proposal into another")
	.action(async (sourceId: string, targetId: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const _proposal = await core.mergeProposals(
			sourceId,
			targetId,
			"cli",
			true,
		);
		console.log(`Merged ${sourceId} into ${targetId}`);
	});

proposalCmd
	.command("enrich <proposalId> <topic>")
	.description("request research or enrichment for a proposal")
	.action(async (proposalId: string, topic: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		await core.emitPulse({
			type: "scope_aggregated",
			id: normalizeProposalId(proposalId),
			title: `Enrichment requested: ${topic}`,
			agent: "cli",
			timestamp: new Date().toISOString(),
		});
		console.log(`Enrichment request logged for ${proposalId}`);
	});

proposalCmd
	.command("priority <proposalId> <level>")
	.description("set proposal priority (none, low, medium, high, critical)")
	.action(async (proposalId: string, level: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const proposal = await core.updatePriority(
			proposalId,
			level as any,
			"cli",
			true,
		);
		console.log(`Updated priority of ${proposalId} to ${proposal.priority}`);
	});

proposalCmd
	.command("export <proposalId>")
	.description("export proposal to markdown")
	.option("--json", "export as JSON instead of markdown")
	.action(async (proposalId: string, options: { json?: boolean }) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const proposal = await core.getProposal(proposalId);
		if (!proposal) {
			console.error(`Proposal ${proposalId} not found.`);
			return;
		}
		if (options.json) {
			console.log(JSON.stringify(proposal, null, 2));
		} else {
			const { generateProposalMarkdown } = await import(
				"../utils/proposal-markdown-generator.ts"
			);
			console.log(generateProposalMarkdown(proposal));
		}
	});

proposalCmd
	.argument("[proposalId]")
	.option("--plain", "use plain text output")
	.action(
		async (proposalId: string | undefined, options: { plain?: boolean }) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);

			// Don't handle commands that should be handled by specific command handlers
			const reservedCommands = [
				"create",
				"list",
				"edit",
				"view",
				"archive",
				"demote",
			];
			if (proposalId && reservedCommands.includes(proposalId)) {
				console.error(`Unknown command: ${proposalId}`);
				proposalCmd.help();
				return;
			}

			// Handle single proposal view only
			if (!proposalId) {
				proposalCmd.help();
				return;
			}

			const localProposals = await core.fs.listProposals();
			const proposal = await core.getProposalWithSubproposals(
				proposalId,
				localProposals,
			);
			if (!proposal) {
				console.error(`Proposal ${proposalId} not found.`);
				return;
			}

			const allProposals = localProposals.some((candidate) =>
				proposalIdsEqual(proposal.id, candidate.id),
			)
				? localProposals
				: [...localProposals, proposal];

			// Plain text output for non-interactive environments
			const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
			if (usePlainOutput) {
				console.log(formatProposalPlainText(proposal));
				return;
			}

			// Use unified view with detail focus and Tab switching support
			const { runUnifiedView } = await import("../ui/unified-view.ts");
			await runUnifiedView({
				core,
				initialView: "proposal-detail",
				selectedProposal: proposal,
				proposals: allProposals,
			});
		},
	);

proposalCmd
	.command("pickup")
	.description("choose the best ready proposal and claim it atomically")
	.option("-a, --agent <name>", "agent identifier (defaults to git user)")
	.option("-d, --dry-run", "explain choice without creating a claim")
	.option("--duration <minutes>", "claim duration in minutes (defaults to 60)")
	.action(async (options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		await core.ensureConfigLoaded();

		const gitUser = await core.gitOps.getLocalUser();
		const agent = options.agent || gitUser?.name || "anonymous";

		const result = await core.pickupProposal({
			agent,
			dryRun: options.dryRun,
			durationMinutes: options.duration
				? Number.parseInt(options.duration, 10)
				: undefined,
		});

		if (!result) {
			console.log("ℹ️  No ready proposals found for pickup.");
			return;
		}

		if (options.dryRun) {
			console.log("ℹ️  Dry run: no claim created.");
			console.log(result.explanation);
			console.log("\nProposal details:");
			console.log(formatProposalPlainText(result.proposal));
		} else {
			console.log(
				`✅ Successfully picked up and claimed proposal ${result.proposal.id}`,
			);
			console.log(result.explanation);
			console.log(
				`\nUse 'roadmap proposal ${result.proposal.id}' to view details.`,
			);
		}
	});

const draftCmd = program.command("draft");

draftCmd
	.command("list")
	.description("list all drafts")
	.option("--sort <field>", "sort drafts by field (priority, id)")
	.option("--plain", "use plain text output")
	.action(async (options: { plain?: boolean; sort?: string }) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		await core.ensureConfigLoaded();
		const drafts = await core.filesystem.listDrafts();

		if (!drafts || drafts.length === 0) {
			console.log("No drafts found.");
			return;
		}

		// Apply sorting - default to priority sorting like the web UI
		const { sortProposals } = await import("../utils/proposal-sorting.ts");
		let sortedDrafts = drafts;

		if (options.sort) {
			const validSortFields = ["priority", "id"];
			const sortField = options.sort.toLowerCase();
			if (!validSortFields.includes(sortField)) {
				console.error(
					`Invalid sort field: ${options.sort}. Valid values are: priority, id`,
				);
				process.exitCode = 1;
				return;
			}
			sortedDrafts = sortProposals(drafts, sortField);
		} else {
			// Default to priority sorting to match web UI behavior
			sortedDrafts = sortProposals(drafts, "priority");
		}

		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			// Plain text output for non-interactive environments
			console.log("Drafts:");
			for (const draft of sortedDrafts) {
				const priorityIndicator = draft.priority
					? `[${draft.priority.toUpperCase()}] `
					: "";
				console.log(`  ${priorityIndicator}${draft.id} - ${draft.title}`);
			}
		} else {
			// Interactive UI - use unified view with draft support
			const firstDraft = sortedDrafts[0];
			if (!firstDraft) return;

			const { runUnifiedView } = await import("../ui/unified-view.ts");
			await runUnifiedView({
				core,
				initialView: "proposal-list",
				selectedProposal: firstDraft,
				proposals: sortedDrafts,
				filter: {
					filterDescription: "All Drafts",
				},
				title: "Drafts",
			});
		}
	});

draftCmd
	.command("create <title>")
	.option(
		"-d, --description <text>",
		"proposal description (multi-line: bash $'Line1\\nLine2', POSIX printf, PowerShell \"Line1`nLine2\")",
	)
	.option("--desc <text>", "alias for --description")
	.option("-a, --assignee <assignee>")
	.option("-s, --status <status>")
	.option("-l, --labels <labels>")
	.action(async (title: string, options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		await core.ensureConfigLoaded();
		const id = await core.generateNextId(EntityType.Draft);
		const proposal = buildProposalFromOptions(id, title, options);
		const filepath = await core.createDraft(proposal);
		console.error(`Created draft ${id}`);
		console.log(`File: ${filepath}`);
	});

draftCmd
	.command("archive <proposalId>")
	.description("archive a draft")
	.action(async (proposalId: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const success = await core.archiveDraft(proposalId);
		if (success) {
			console.error(`Archived draft ${proposalId}`);
		} else {
			console.error(`Draft ${proposalId} not found.`);
		}
	});

draftCmd
	.command("promote <proposalId>")
	.description("promote draft to proposal")
	.action(async (proposalId: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const success = await core.promoteDraft(proposalId);
		if (success) {
			console.error(`Promoted draft ${proposalId}`);
		} else {
			console.error(`Draft ${proposalId} not found.`);
		}
	});

draftCmd
	.command("view <proposalId>")
	.description("display draft details")
	.option("--plain", "use plain text output instead of interactive UI")
	.action(async (proposalId: string, options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const { getDraftPath } = await import("../utils/proposal-path.ts");
		const filePath = await getDraftPath(proposalId, core);

		if (!filePath) {
			console.error(`Draft ${proposalId} not found.`);
			return;
		}
		const draft = await core.filesystem.loadDraft(proposalId);

		if (!draft) {
			console.error(`Draft ${proposalId} not found.`);
			return;
		}

		// Plain text output for non-interactive environments
		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			console.log(formatProposalPlainText(draft));
			return;
		}

		// Use enhanced proposal viewer with detail focus
		const { viewProposalEnhanced } = await import(
			"../ui/proposal-viewer-with-search.ts"
		);
		await viewProposalEnhanced(draft, { startWithDetailFocus: true, core });
	});

draftCmd
	.argument("[proposalId]")
	.option("--plain", "use plain text output")
	.action(
		async (proposalId: string | undefined, options: { plain?: boolean }) => {
			if (!proposalId) {
				draftCmd.help();
				return;
			}

			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const { getDraftPath } = await import("../utils/proposal-path.ts");
			const filePath = await getDraftPath(proposalId, core);

			if (!filePath) {
				console.error(`Draft ${proposalId} not found.`);
				return;
			}
			const draft = await core.filesystem.loadDraft(proposalId);

			if (!draft) {
				console.error(`Draft ${proposalId} not found.`);
				return;
			}

			// Plain text output for non-interactive environments
			const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
			if (usePlainOutput) {
				console.log(
					formatProposalPlainText(draft, { filePathOverride: filePath }),
				);
				return;
			}

			// Use enhanced proposal viewer with detail focus
			const { viewProposalEnhanced } = await import(
				"../ui/proposal-viewer-with-search.ts"
			);
			await viewProposalEnhanced(draft, { startWithDetailFocus: true, core });
		},
	);

const directiveCmd = program.command("directive").aliases(["directives"]);

directiveCmd
	.command("list")
	.description("list directives with completion status")
	.option("--show-completed", "show completed directives")
	.option("--plain", "use plain text output")
	.action(async (options: { showCompleted?: boolean; plain?: boolean }) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		await core.ensureConfigLoaded();

		const [proposals, directives, archivedDirectives, config] =
			await Promise.all([
				core.queryProposals({ includeCrossBranch: false }),
				core.filesystem.listDirectives(),
				core.filesystem.listArchivedDirectives(),
				core.filesystem.loadConfig(),
			]);

		const statuses = config?.statuses ?? [
			"New",
			"Draft",
			"Review",
			"Active",
			"Accepted",
			"Complete",
			"Rejected",
			"Abandoned",
			"Replaced",
		];
		const archivedDirectiveIds = collectArchivedDirectiveKeys(
			archivedDirectives,
			directives,
		);
		const buckets = buildDirectiveBuckets(proposals, directives, statuses, {
			archivedDirectiveIds,
			archivedDirectives,
		});
		const active = buckets.filter(
			(bucket) => !bucket.isNoDirective && !bucket.isCompleted,
		);
		const completed = buckets.filter(
			(bucket) => !bucket.isNoDirective && bucket.isCompleted,
		);

		const formatBucket = (bucket: (typeof buckets)[number]) => {
			const id = bucket.directive ?? bucket.label;
			const label = bucket.label;
			return `  ${id}: ${label} (${bucket.doneCount}/${bucket.total} done)`;
		};

		console.log(`Active directives (${active.length}):`);
		if (active.length === 0) {
			console.log("  (none)");
		} else {
			for (const bucket of active) {
				console.log(formatBucket(bucket));
			}
		}

		console.log(`\nCompleted directives (${completed.length}):`);
		if (completed.length === 0) {
			console.log("  (none)");
		} else if (
			options.showCompleted ||
			process.argv.includes("--show-completed")
		) {
			for (const bucket of completed) {
				console.log(formatBucket(bucket));
			}
		} else {
			console.log("  (collapsed, use --show-completed to list)");
		}
	});

directiveCmd
	.command("archive <name>")
	.description("archive a directive by id or title")
	.action(async (name: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const result = await core.archiveDirective(name);

		if (!result.success) {
			console.error(`Directive "${name}" not found.`);
			process.exitCode = 1;
			return;
		}

		const label = result.directive?.title ?? name;
		const id = result.directive?.id;
		console.error(`Archived directive "${label}"${id ? ` (${id})` : ""}.`);
	});

const boardCmd = program.command("board");

function addBoardOptions(cmd: Command) {
	return cmd
		.option(
			"-l, --layout <layout>",
			"board layout (horizontal|vertical)",
			"horizontal",
		)
		.option(
			"--vertical",
			"use vertical layout (shortcut for --layout vertical)",
		)
		.option("-m, --directives", "group proposals by directive")
		.option("-s, --source <source>", "data source (auto|file|postgres)", "auto")
		.option(
			"-n, --namespace <name>",
			"reserved for compatibility with older remote backends",
		)
		.option("--plain", "use plain text output instead of interactive UI");
}

function getBoardLoadTimeoutMs(): number {
	const parsed = Number(process.env.ROADMAP_BOARD_LOAD_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 30000;
}

async function withBoardLoadTimeout<T>(
	promise: Promise<T>,
	source: "file" | "postgres",
): Promise<T> {
	const timeoutMs = getBoardLoadTimeoutMs();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(
						new Error(
							`Timed out after ${timeoutMs}ms loading roadmap board data from ${source}.`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

async function handleBoardView(options: {
	layout?: string;
	vertical?: boolean;
	directives?: boolean;
	source?: string;
	namespace?: string;
	plain?: boolean;
}) {
	const cwd = await requireProjectRoot();
	const core = new Core(cwd);
	const config = await core.filesystem.loadConfig();

	const _layout = options.vertical
		? "vertical"
		: (options.layout as "horizontal" | "vertical") || "horizontal";
	const _maxColumnWidth = config?.maxColumnWidth || 20; // Default for terminal display
	const statuses = config?.statuses || [];

	const source = resolveBoardDataSource(options.source, config);

	if (options.plain || !process.stdout.isTTY) {
		const proposals =
			source === "postgres"
				? await core.queryProposals({ includeCrossBranch: false })
				: await core.loadProposals();

		const statuses = config?.statuses || [];
		if (options.directives) {
			const { generateDirectiveGroupedBoard } = await import("./board.ts");
			const directives = await core.filesystem.listDirectives();
			console.log(
				generateDirectiveGroupedBoard(
					proposals,
					statuses,
					directives,
					config?.projectName || "Project",
				),
			);
		} else {
			const { generateKanbanBoardWithMetadata } = await import("./board.ts");
			console.log(
				generateKanbanBoardWithMetadata(
					proposals,
					statuses,
					config?.projectName || "Project",
				),
			);
		}
		return;
	}

	try {
		const proposals =
			source === "postgres"
				? (
						await withBoardLoadTimeout(
							core.queryProposals({ includeCrossBranch: false }),
							source,
						)
					).map((proposal) => ({
						...proposal,
						status: proposal.status || "",
					}))
				: await core.loadProposals();

		const [directiveEntities, archivedDirectives] = await Promise.all([
			core.filesystem.listDirectives(),
			core.filesystem.listArchivedDirectives(),
		]);

		const availableDirectives = [...directiveEntities, ...archivedDirectives]
			.map((directive) => directive.title.trim())
			.filter(Boolean);

		const { renderBoardTui } = await import("../ui/board.ts");
		await renderBoardTui(
			proposals,
			statuses,
			_layout,
			_maxColumnWidth,
			{
				projectRoot: core.getProjectRoot(),
				directiveMode: options.directives,
				directiveEntities,
				availableLabels: config?.labels || [],
				availableDirectives,
			},
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}

addBoardOptions(boardCmd)
	.description("display proposals in a Kanban board")
	.action(handleBoardView);

addBoardOptions(
	boardCmd.command("view").description("display proposals in a Kanban board"),
).action(handleBoardView);

boardCmd
	.command("export [filename]")
	.description("export kanban board to markdown file")
	.option("--force", "overwrite existing file without confirmation")
	.option("--readme", "export to README.md with markers")
	.option("--export-version <version>", "version to include in the export")
	.action(async (filename, options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const config = await core.filesystem.loadConfig();
		const statuses = config?.statuses || [];

		// Load proposals with progress tracking
		const { createLoadingScreen } = await import("../ui/loading.ts");
		const loadingScreen = await createLoadingScreen(
			"Loading proposals for export",
		);

		let finalProposals: Proposal[];
		try {
			// Use the shared Core method for loading board proposals
			finalProposals = await core.loadProposals((msg) => {
				loadingScreen?.update(msg);
			});

			loadingScreen?.update(`Total proposals: ${finalProposals.length}`);

			// Close loading screen before export
			loadingScreen?.close();

			// Get project name from config or use directory name
			const { basename } = await import("node:path");
			const projectName = config?.projectName || basename(cwd);

			if (options.readme) {
				// Use version from option if provided, otherwise use the CLI version
				const exportVersion = options.exportVersion || version;
				await updateReadmeWithBoard(
					finalProposals,
					statuses,
					projectName,
					exportVersion,
				);
				console.log("Updated README.md with Kanban board.");
			} else {
				// Use filename argument or default to config.exportPath/Roadmap.md
				const exportDir = config?.exportPath
					? join(cwd, config.exportPath)
					: cwd;

				// Ensure export directory exists
				const { mkdir } = await import("node:fs/promises");
				await mkdir(exportDir, { recursive: true });

				const outputFile = filename || "Roadmap.md";
				const outputPath = join(exportDir, outputFile as string);

				// Check if file exists and handle overwrite confirmation
				const fileExists = await stat(outputPath)
					.then(() => true)
					.catch(() => false);
				if (fileExists && !options.force) {
					const rl = createInterface({ input });
					try {
						const answer = await rl.question(
							`File "${outputPath}" already exists. Overwrite? (y/N): `,
						);
						if (!answer.toLowerCase().startsWith("y")) {
							console.log("Export cancelled.");
							return;
						}
					} finally {
						rl.close();
					}
				}

				const { exportKanbanBoardToFile } = await import("./board.ts");
				await exportKanbanBoardToFile(
					finalProposals,
					statuses,
					outputPath,
					projectName,
					options.force || !fileExists,
				);
				console.log(`Exported board to ${outputPath}`);
			}
		} catch (error) {
			loadingScreen?.close();
			throw error;
		}
	});

const docCmd = program.command("doc");

docCmd
	.command("generate")
	.description("generate documentation from roadmap proposal")
	.option("-o, --output <path>", "output directory", "docs")
	.option("--no-dag", "exclude architecture DAG")
	.option("--no-changelog", "exclude changelog")
	.option("-f, --format <format>", "output format (markdown, html)", "markdown")
	.action(async (options) => {
		const cwd = await requireProjectRoot();
		const args = ["generate"];
		if (options.output) args.push("--output", options.output);
		if (options.dag === false) args.push("--no-dag");
		if (options.changelog === false) args.push("--no-changelog");
		if (options.format) args.push("--format", options.format);
		await runDocsCommand(cwd, args);
	});

docCmd
	.command("watch")
	.description("watch for changes and regenerate documentation")
	.action(async () => {
		const cwd = await requireProjectRoot();
		await runDocsCommand(cwd, ["watch"]);
	});

docCmd
	.command("serve")
	.description("serve documentation locally")
	.option("-p, --port <port>", "port to serve on", "3000")
	.action(async (options) => {
		const cwd = await requireProjectRoot();
		await runDocsCommand(cwd, ["serve", "--port", options.port]);
	});

docCmd
	.command("create <title>")
	.option("-p, --path <path>")
	.option("-t, --type <type>")
	.action(async (title: string, options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const id = await generateNextDocId(core);
		const document: DocType = {
			id,
			title: title as string,
			type: (options.type || "other") as DocType["type"],
			createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
			rawContent: "",
		};
		await core.createDocument(document, undefined, options.path || "");
		console.error(`Created document ${id}`);
	});

docCmd
	.command("list")
	.option("--plain", "use plain text output instead of interactive UI")
	.action(async (options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const docs = await core.filesystem.listDocuments();
		if (docs.length === 0) {
			console.log("No docs found.");
			return;
		}

		// Plain text output for non-interactive environments
		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			for (const d of docs) {
				console.log(`${d.id} - ${d.title}`);
			}
			return;
		}

		// Interactive UI
		const { genericSelectList } = await import(
			"../ui/components/generic-list.ts"
		);
		const selected = await genericSelectList("Select a document", docs);
		if (selected) {
			// Show document details (recursive search)
			const files = await Array.fromAsync(
				glob("**/*.md", { cwd: core.filesystem.docsDir }),
			);
			const docFile = files.find(
				(f) =>
					f.startsWith(`${selected.id} -`) ||
					f.endsWith(`/${selected.id}.md`) ||
					f === `${selected.id}.md`,
			);
			if (docFile) {
				const filePath = join(core.filesystem.docsDir, docFile);
				const content = await readFile(filePath, "utf-8");
				const { scrollableViewer } = await import("../ui/tui.ts");
				await scrollableViewer(content);
			}
		}
	});

// Document view command
docCmd
	.command("view <docId>")
	.description("view a document")
	.action(async (docId: string) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			const content = await core.getDocumentContent(docId);
			if (content === null) {
				console.error(`Document ${docId} not found.`);
				return;
			}
			const { scrollableViewer } = await import("../ui/tui.ts");
			await scrollableViewer(content);
		} catch {
			console.error(`Document ${docId} not found.`);
		}
	});

const decisionCmd = program.command("decision");

decisionCmd
	.command("create <title>")
	.option(
		"-s, --status <status>",
		"decision status (proposed, accepted, rejected, superseded)",
	)
	.option("--context <text>", "background/problem proposalment")
	.option("--decision <text>", "the chosen path")
	.option("--consequences <text>", "trade-offs and impact")
	.option("--alternatives <text>", "other considered options")
	.action(async (title: string, options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const id = await generateNextDecisionId(core);
		const decision: Decision = {
			id,
			title: title as string,
			date: new Date().toISOString().slice(0, 16).replace("T", " "),
			status: (options.status || "proposed") as Decision["status"],
			context:
				options.context ||
				"[Describe the context and problem that needs to be addressed]",
			decision: options.decision || "[Describe the decision that was made]",
			consequences:
				options.consequences || "[Describe the consequences of this decision]",
			alternatives:
				options.alternatives || "[Describe the alternatives considered]",
			rawContent: "",
		};
		await core.createDecision(decision);
		console.error(`Created decision ${id}`);
	});

program
	.command("talk <message> [target]")
	.description("send a message to the project chat or an agent (@name)")
	.option("--as <name>", "specify your identity (e.g. 'Coordinator')")
	.action(async (message, target, options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();

			let type: "public" | "group" | "private" = "group";
			let group = "project";
			let to: string | undefined;

			if (target) {
				if (target.startsWith("@")) {
					type = "private";
					to = target.substring(1);
				} else if (target === "public") {
					type = "public";
				} else {
					group = target;
				}
			} else if (config?.projectName) {
				group = config.projectName.toLowerCase().replace(/[^a-z0-9]/g, "-");
			}

			// Get sender name
			let from = options.as;
			if (!from) {
				try {
					const nameResult = execSync("git config user.name", {
						cwd,
						encoding: "utf-8",
						stdio: "pipe",
					});
					from = nameResult.trim() || "agent";
				} catch {
					from = "agent";
				}
			}

			await core.sendMessage({ from, message, type, group, to });
			console.log(`Message sent to ${group}${to ? ` (to @${to})` : ""}`);
		} catch (err) {
			console.error("Failed to send message:", err);
			process.exit(1);
		}
	});

program
	.command("chat [target]")
	.description("interactive chat session for project or agent (@name)")
	.option("--as <name>", "specify your identity")
	.action(async (target, options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();
			const { join } = await import("node:path");
			const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
			const { createInterface: createLineInterface, emitKeypressEvents } =
				await import("node:readline");
			const versionLabel = formatVersionLabel(versionInfo);

			let group = "project";
			if (config?.projectName)
				group = config.projectName.toLowerCase().replace(/[^a-z0-9]/g, "-");
			let fileName = `group-${group}.md`;
			let type: "public" | "group" | "private" = "group";
			let to: string | undefined;

			if (target) {
				if (target.startsWith("@")) {
					const nameResult = execSync("git config user.name", {
						encoding: "utf8",
					});
					const from =
						nameResult
							.trim()
							.replace(/\s*\(.*\)/, "")
							.toLowerCase() || "agent";
					to = target.substring(1).toLowerCase();
					const agents = [from, to].sort();
					fileName = `private-${agents[0]}-${agents[1]}.md`;
					type = "private";
				} else if (target === "public") {
					fileName = "PUBLIC.md";
					type = "public";
				} else {
					group = target;
					fileName = `group-${target.toLowerCase().replace(/[^a-z0-9]/g, "-")}.md`;
				}
			}
			const chatLabel = target ?? `#${group}`;

			let sharedRoadmapDir = join(cwd, "roadmap");
			try {
				const gitRoot = execSync("git rev-parse --show-toplevel", {
					encoding: "utf8",
				}).trim();
				if (gitRoot) sharedRoadmapDir = join(gitRoot, "roadmap");
			} catch {}

			const logPath = join(sharedRoadmapDir, "messages", fileName);
			const channelKey =
				type === "public"
					? "public"
					: type === "private"
						? fileName.replace(/\.md$/u, "")
						: group.toLowerCase().replace(/[^a-z0-9-]/g, "-");

			// Get sender name
			let from = options.as;
			if (!from) {
				try {
					const nameResult = execSync("git config user.name", {
						cwd,
						encoding: "utf-8",
						stdio: "pipe",
					});
					from = nameResult.trim() || "agent";
				} catch {
					from = "agent";
				}
			}

			if (!existsSync(logPath)) {
				mkdirSync(join(sharedRoadmapDir, "messages"), { recursive: true });
				const header =
					type === "public"
						? "# Public Announcement\n\n"
						: type === "private"
							? `# Private DM: ${from} <-> ${to}\n\n`
							: `# Group Chat: #${group}\n\n`;
				writeFileSync(logPath, header);
			}

			const knownUsers = await core.getKnownUsers();
			let draft: ChatComposerProposal = createChatComposerProposal();
			const interactiveInput =
				Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
				typeof process.stdin.setRawMode === "function";
			let stopWatchingMessages: (() => void) | undefined;
			let shuttingDown = false;
			let isSending = false;
			let lastComposerRows = 0;
			const channelHeading =
				type === "public"
					? "# Public Announcement"
					: type === "private"
						? `# Private DM: ${from} <-> ${to}`
						: `# Group Chat: #${group}`;

			const clearComposer = () => {
				if (!interactiveInput || lastComposerRows === 0) return;

				process.stdout.write("\r");
				if (lastComposerRows > 1) {
					process.stdout.write(`\x1b[${lastComposerRows - 1}A`);
				}
				process.stdout.write("\x1b[J");
				lastComposerRows = 0;
			};

			const renderComposer = () => {
				if (!interactiveInput) return;

				const suggestions = getChatMentionSuggestions(draft, knownUsers);
				const suggestionLines =
					suggestions.length > 0
						? [
								"  mentions:",
								...suggestions.map((suggestion) =>
									suggestion.selected
										? `  \x1b[1;36m> ${suggestion.value}\x1b[0m`
										: `    ${suggestion.value}`,
								),
							]
						: [];
				const composerLines = [
					...suggestionLines,
					...renderChatComposerLines(draft),
				];

				clearComposer();
				process.stdout.write(composerLines.join("\n"));
				lastComposerRows = composerLines.length;
			};

			const appendChatOutput = (output: string) => {
				if (interactiveInput) {
					clearComposer();
				}

				process.stdout.write(output);

				if (interactiveInput) {
					renderComposer();
				}
			};

			const renderChatScreen = async () => {
				if (interactiveInput) {
					process.stdout.write("\x1b[2J\x1b[H");
				}
				console.log(`💬 Chatting in ${chatLabel} as ${from} — ${versionLabel}`);
				if (interactiveInput) {
					console.log(
						"   Enter/→ accept @mentions or send • Alt/Shift+Enter adds newline • Tab/↑/↓ cycle @mentions • Tab completes /paths • Ctrl+C exits\n",
					);
				} else {
					console.log("   Enter sends • Ctrl+C exits\n");
				}

				process.stdout.write(`\x1b[1m${channelHeading}\x1b[0m\n\n`);

				const history = await core.readMessages({ channel: channelKey });
				for (const message of history.messages) {
					process.stdout.write(Core.formatMessagePretty(message));
				}

				if (interactiveInput) {
					lastComposerRows = 0;
					renderComposer();
				}
			};

			const cleanup = () => {
				if (shuttingDown) return;
				shuttingDown = true;
				stopWatchingMessages?.();
				if (interactiveInput) {
					process.stdin.removeListener("keypress", handleKeypress);
					if (typeof process.stdin.setRawMode === "function") {
						process.stdin.setRawMode(false);
					}
				}
				process.stdin.pause();
			};

			const handleKeypress = (
				chunk: string,
				key: {
					name?: string;
					ctrl?: boolean;
					meta?: boolean;
					shift?: boolean;
					sequence?: string;
				},
			) => {
				void (async () => {
					const acceptMentionSelection = () => {
						const acceptedMention = acceptChatMention(draft, knownUsers);
						if (acceptedMention === draft) {
							return false;
						}

						draft = acceptedMention;
						renderComposer();
						return true;
					};

					if (
						(key.name === "return" || key.name === "enter") &&
						!key.meta &&
						!key.shift
					) {
						if (acceptMentionSelection()) {
							return;
						}
					}

					if (key.name === "right") {
						acceptMentionSelection();
						return;
					}

					if (key.name === "tab") {
						const mentionCompleted = cycleChatMention(
							draft,
							knownUsers,
							key.shift ? -1 : 1,
						);
						draft =
							mentionCompleted !== draft
								? mentionCompleted
								: completeChatPath(draft, { homeDir: process.env.HOME });
						renderComposer();
						return;
					}

					if (key.name === "up" || key.name === "down") {
						const mentionCompleted = cycleChatMention(
							draft,
							knownUsers,
							key.name === "up" ? -1 : 1,
						);
						if (mentionCompleted !== draft) {
							draft = mentionCompleted;
							renderComposer();
						}
						return;
					}

					const result = applyChatComposerKey(draft, key, chunk);
					if (result.type === "exit") {
						cleanup();
						process.exit(0);
					}
					if (result.type === "send") {
						if (isSending) return;
						isSending = true;
						draft = result.proposal;
						renderComposer();
						try {
							await core.sendMessage({
								from,
								message: result.message,
								type,
								group,
								to,
							});
						} finally {
							isSending = false;
							renderComposer();
						}
						return;
					}

					draft = result.proposal;
					renderComposer();
				})();
			};

			await renderChatScreen();

			if (interactiveInput) {
				stopWatchingMessages = await core.watchMessages({
					channel: channelKey,
					onMessage: (message) => {
						appendChatOutput(Core.formatMessagePretty(message));
					},
				});
			}

			if (!interactiveInput) {
				const rl = createLineInterface({
					input: process.stdin,
					output: process.stdout,
				});
				rl.on("line", async (line) => {
					const message = line.replace(/\s+$/u, "");
					if (message.trim().length === 0) return;
					await core.sendMessage({ from, message, type, group, to });
				});
				return new Promise(() => {
					rl.on("SIGINT", () => {
						rl.close();
						cleanup();
						process.exit(0);
					});
				});
			}

			emitKeypressEvents(process.stdin);
			process.stdin.setRawMode(true);
			process.stdin.resume();
			process.stdin.on("keypress", handleKeypress);

			return new Promise(() => {
				process.on("SIGINT", () => {
					cleanup();
					process.exit(0);
				});
			});
		} catch (err) {
			console.error("Chat session ended:", err);
			process.exit(0);
		}
	});

program
	.command("log [target]")
	.description("view communication logs for project or agent (@name)")
	.option("-f, --tail", "tail the log file")
	.option("--plain", "output raw markdown instead of pretty-formatted text")
	.action(async (target, options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();
			const { join } = await import("node:path");
			const { existsSync, readFileSync } = await import("node:fs");

			let fileName = "PUBLIC.md";
			let group = "project";
			if (config?.projectName)
				group = config.projectName.toLowerCase().replace(/[^a-z0-9]/g, "-");

			if (target) {
				if (target.startsWith("@")) {
					const nameResult = execSync("git config user.name", {
						encoding: "utf8",
					});
					const from =
						nameResult
							.trim()
							.replace(/\s*\(.*\)/, "")
							.toLowerCase() || "agent";
					const agents = [from, target.substring(1).toLowerCase()].sort();
					fileName = `private-${agents[0]}-${agents[1]}.md`;
				} else if (target === "public") {
					fileName = "PUBLIC.md";
				} else {
					fileName = `group-${target.toLowerCase().replace(/[^a-z0-9]/g, "-")}.md`;
				}
			} else {
				fileName = `group-${group}.md`;
			}

			// Resolve shared roadmap dir (handling worktrees)
			let sharedRoadmapDir = join(cwd, "roadmap");
			try {
				const gitRoot = execSync("git rev-parse --show-toplevel", {
					encoding: "utf8",
				}).trim();
				if (gitRoot) sharedRoadmapDir = join(gitRoot, "roadmap");
			} catch {}

			const logPath = join(sharedRoadmapDir, "messages", fileName);

			if (!existsSync(logPath)) {
				console.log(`Log channel '${fileName}' is empty.`);
				return;
			}

			if (options.tail) {
				const { spawn } = await import("node:child_process");
				spawn("tail", ["-f", logPath], { stdio: "inherit" });
			} else {
				const content = readFileSync(logPath, "utf-8");
				if (options.plain) {
					console.log(content);
				} else {
					const lines = content.split("\n");
					for (const line of lines) {
						const parsed = Core.parseLine(line);
						if (parsed) {
							process.stdout.write(Core.formatMessagePretty(parsed));
						} else if (line.startsWith("#")) {
							process.stdout.write(`\x1b[1m${line}\x1b[0m\n\n`);
						}
					}
				}
			}
		} catch (err) {
			console.error("Failed to read log:", err);
			process.exit(1);
		}
	});

program
	.command("listen [channel]")
	.description(
		"watch a chat channel and stream new messages as JSONL (like a Discord gateway)",
	)
	.option("--as <name>", "your identity — messages from you are skipped")
	.option("--mention <name>", "only emit messages that @mention this name")
	.option(
		"--since <timestamp>",
		"replay messages after this ISO timestamp before streaming live",
	)
	.option("--all", "include your own messages (don't filter by identity)")
	.option(
		"--pretty",
		"output messages in a human-friendly Discord-style format",
	)
	.option(
		"--markdown",
		"output messages in Discord-style markdown (without ANSI colors)",
	)
	.action(async (channel, options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();
			const resolvedChannel =
				channel ??
				(config?.projectName
					? config.projectName.toLowerCase().replace(/[^a-z0-9]/g, "-")
					: "project");

			let identity = options.as;
			if (!identity && !options.all) {
				try {
					const nameResult = execSync("git config user.name", {
						cwd,
						encoding: "utf-8",
						stdio: "pipe",
					});
					identity = nameResult.trim() || undefined;
				} catch {
					// no identity filtering
				}
			}

			const filePath = await core.resolveChannelFile(resolvedChannel);
			const { existsSync } = await import("node:fs");

			// If the channel file doesn't exist yet, create it so the watcher has something to attach to
			if (!existsSync(filePath)) {
				const { writeFileSync, mkdirSync } = await import("node:fs");
				const { dirname } = await import("node:path");
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, `# Group Chat: #${resolvedChannel}\n\n`);
			}

			const label = [`#${resolvedChannel}`];
			if (identity) label.push(`as ${identity}`);
			if (options.mention) label.push(`filtering @${options.mention}`);

			if (!options.pretty && !options.markdown) {
				process.stderr.write(
					`Listening on ${label.join(" ")} (Ctrl+C to stop)\n`,
				);
			}

			await core.watchMessages({
				channel: resolvedChannel,
				identity: options.all ? undefined : identity,
				mention: options.mention,
				since: options.since,
				onMessage: (msg) => {
					if (options.pretty || options.markdown) {
						process.stdout.write(
							Core.formatMessagePretty(msg, {
								color: options.pretty && !options.markdown,
								markdown: options.markdown,
							}),
						);
					} else {
						process.stdout.write(`${JSON.stringify(msg)}\n`);
					}
				},
			});

			// Keep process alive
			await new Promise(() => {});
		} catch (err) {
			console.error("Listen failed:", err);
			process.exit(1);
		}
	});

// Agents command group
const agentsCmd = program
	.command("agents")
	.description("manage the agent registry and communication");

agentsCmd
	.command("register")
	.description("register or update an agent profile")
	.option("-n, --name <name>", "agent identifier (defaults to git user)")
	.option("-s, --skills <skills>", "comma-separated list of capabilities")
	.option("--status <status>", "current status (active, idle, offline)", "idle")
	.action(async (options) => {
		const { requireProjectRoot } = await import("../utils/project-root.ts");
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);

		let name = options.name;
		if (!name) {
			try {
				const { execSync } = await import("node:child_process");
				name = execSync("git config user.name", { encoding: "utf-8" }).trim();
			} catch {
				name = "agent";
			}
		}

		try {
			const agent = await core.registerAgent({
				name,
				capabilities: options.skills
					? String(options.skills)
							.split(",")
							.map((s) => s.trim())
					: [],
				status: options.status as AgentStatus,
			});
			console.log(
				`Registered agent ${agent.name} with skills: ${agent.capabilities.join(", ")}`,
			);
		} catch (err) {
			console.error(`Failed to register agent: ${(err as Error).message}`);
			process.exit(1);
		}
	});

agentsCmd
	.command("list")
	.description("list all registered agents")
	.action(async () => {
		const { requireProjectRoot } = await import("../utils/project-root.ts");
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		try {
			const agents = await core.listAgents();
			if (agents.length === 0) {
				console.log("No agents registered.");
				return;
			}
			console.log("Registered Agents:");
			for (const agent of agents) {
				console.log(`- ${agent.name} [${agent.status}]`);
				console.log(`  Skills: ${agent.capabilities.join(", ")}`);
				console.log(`  Trust: ${agent.trustScore}`);
				console.log(`  Last Seen: ${agent.lastSeen}`);
			}
		} catch (err) {
			console.error(`Failed to list agents: ${(err as Error).message}`);
			process.exit(1);
		}
	});

agentsCmd
	.command("join <name>")
	.description("initialize a new agent workspace with a ghost identity")
	.option(
		"-r, --role <role>",
		"specify the agent's role (e.g., 'Tester', 'UI-Expert')",
	)
	.action(async (name, options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const { runAgentJoinCommand } = await import("./commands/orchestrate.ts");
			await runAgentJoinCommand(core, name, options.role);
		} catch (err) {
			console.error("Failed to join agent:", err);
			process.exit(1);
		}
	});

agentsCmd
	.command("talk <message>")
	.description("send a message to a communication channel")
	.option("--public", "send to public announcement channel")
	.option("--group <name>", "send to a specific group chat channel")
	.option("--to <agent>", "send a private message to a specific agent")
	.option(
		"--from <name>",
		"specify sender name (defaults to git user or 'agent')",
	)
	.action(async (message, options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);

			let type: "public" | "group" | "private" = "public";
			if (options.group) type = "group";
			else if (options.to) type = "private";

			let from = options.from;
			if (!from) {
				try {
					const nameResult = execSync("git config user.name", {
						cwd,
						encoding: "utf-8",
						stdio: "pipe",
					});
					from = nameResult.trim() || "agent";
				} catch {
					from = "agent";
				}
			}

			const filePath = await core.sendMessage({
				from,
				message,
				type,
				group: options.group,
				to: options.to,
			});

			console.log(`Message sent to ${filePath}`);
		} catch (err) {
			console.error("Failed to send message:", err);
			process.exit(1);
		}
	});

agentsCmd
	.command("log")
	.description("monitor agent conversations")
	.option("--public", "show public announcements (default)")
	.option("--group <name>", "show a specific group chat channel")
	.option("--to <agent>", "show a private DM channel with an agent")
	.option("-f, --tail", "output appended data as the file grows")
	.option("--plain", "output raw markdown instead of pretty-formatted text")
	.option("--markdown", "output pretty formatting as markdown")
	.action(async (options) => {
		try {
			const cwd = await requireProjectRoot();
			const { join } = await import("node:path");
			const { existsSync, readFileSync } = await import("node:fs");

			let fileName = "PUBLIC.md";
			if (options.group)
				fileName = `group-${options.group.toLowerCase().replace(/[^a-z0-9]/g, "-")}.md`;
			else if (options.to) {
				const nameResult = execSync("git config user.name", {
					encoding: "utf8",
				});
				const from = nameResult.trim() || "agent";
				const agents = [
					from.replace("@", "").toLowerCase(),
					options.to.replace("@", "").toLowerCase(),
				].sort();
				fileName = `private-${agents[0]}-${agents[1]}.md`;
			}

			const logPath = join(cwd, "roadmap", "messages", fileName);

			if (!existsSync(logPath)) {
				console.log(`Log channel '${fileName}' is empty or does not exist.`);
				return;
			}

			if (options.tail) {
				console.log(`--- Tailing ${fileName} (Press Ctrl+C to stop) ---\n`);
				const { spawn } = await import("node:child_process");
				spawn("tail", ["-f", logPath], { stdio: "inherit" });
			} else {
				const content = readFileSync(logPath, "utf-8");
				if (options.plain) {
					console.log(content);
				} else {
					const lines = content.split("\n");
					for (const line of lines) {
						const parsed = Core.parseLine(line);
						if (parsed) {
							process.stdout.write(
								Core.formatMessagePretty(parsed, {
									color: !options.markdown,
									markdown: !!options.markdown,
								}),
							);
						} else if (line.startsWith("#")) {
							process.stdout.write(`\x1b[1m${line}\x1b[0m\n\n`);
						}
					}
				}
			}
		} catch (err) {
			console.error("Failed to read agent log:", err);
			process.exit(1);
		}
	});

agentsCmd
	.command("subscribe <channel>")
	.description("subscribe to a channel for push notifications")
	.option("--as <name>", "agent identity (defaults to git user)")
	.action(async (channel, options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);

			let agent = options.as;
			if (!agent) {
				try {
					const nameResult = execSync("git config user.name", {
						cwd,
						encoding: "utf-8",
						stdio: "pipe",
					});
					agent = nameResult.trim() || "agent";
				} catch {
					agent = "agent";
				}
			}

			await core.subscribeToChannel(agent, channel);
			console.log(`Subscribed ${agent} to channel: ${channel}`);
		} catch (err) {
			console.error("Failed to subscribe:", err);
			process.exit(1);
		}
	});

agentsCmd
	.command("unsubscribe <channel>")
	.description("unsubscribe from a channel")
	.option("--as <name>", "agent identity (defaults to git user)")
	.action(async (channel, options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);

			let agent = options.as;
			if (!agent) {
				try {
					const nameResult = execSync("git config user.name", {
						cwd,
						encoding: "utf-8",
						stdio: "pipe",
					});
					agent = nameResult.trim() || "agent";
				} catch {
					agent = "agent";
				}
			}

			await core.unsubscribeFromChannel(agent, channel);
			console.log(`Unsubscribed ${agent} from channel: ${channel}`);
		} catch (err) {
			console.error("Failed to unsubscribe:", err);
			process.exit(1);
		}
	});

agentsCmd
	.command("subscriptions")
	.description("list channel subscriptions for this agent")
	.option("--as <name>", "agent identity (defaults to git user)")
	.option("--all", "show subscriptions for all agents")
	.option("--channel <name>", "show agents subscribed to a specific channel")
	.action(async (options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);

			if (options.channel) {
				const agents = await core.getSubscribedAgents(options.channel);
				if (agents.length === 0) {
					console.log(`No agents subscribed to channel: ${options.channel}`);
				} else {
					console.log(`Agents subscribed to ${options.channel}:`);
					for (const agent of agents) {
						console.log(`  - ${agent}`);
					}
				}
				return;
			}

			let agent = options.as;
			if (!agent && !options.all) {
				try {
					const nameResult = execSync("git config user.name", {
						cwd,
						encoding: "utf-8",
						stdio: "pipe",
					});
					agent = nameResult.trim() || "agent";
				} catch {
					agent = "agent";
				}
			}

			if (options.all) {
				// Show all channels and their subscribers
				const channels = await core.listChannels();
				let found = false;
				for (const ch of channels) {
					const agents = await core.getSubscribedAgents(ch.name);
					if (agents.length > 0) {
						console.log(`${ch.name}: ${agents.join(", ")}`);
						found = true;
					}
				}
				if (!found) {
					console.log("No active subscriptions.");
				}
			} else if (agent) {
				const subs = await core.getSubscriptions(agent);
				if (subs.length === 0) {
					console.log(`${agent} has no channel subscriptions.`);
				} else {
					console.log(`${agent}'s subscriptions:`);
					for (const ch of subs) {
						console.log(`  - ${ch}`);
					}
				}
			}
		} catch (err) {
			console.error("Failed to list subscriptions:", err);
			process.exit(1);
		}
	});

agentsCmd
	.description("manage agent instruction files")
	.option(
		"--update-instructions",
		"update agent instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, .github/copilot-instructions.md)",
	)
	.action(async (options) => {
		if (!options.updateInstructions) {
			agentsCmd.help();
			return;
		}
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);

			// Check if roadmap project is initialized
			const config = await core.filesystem.loadConfig();
			if (!config) {
				console.error(
					"No roadmap project found. Initialize one first with: roadmap init",
				);
				process.exit(1);
			}

			const _agentOptions = [
				"CLAUDE.md",
				"AGENTS.md",
				"GEMINI.md",
				".github/copilot-instructions.md",
			] as const;

			const selected = await clack.multiselect({
				message:
					"Select agent instruction files to update (space toggles selections; enter confirms)",
				required: false,
				options: [
					{ label: "CLAUDE.md (Claude Code)", value: "CLAUDE.md" },
					{
						label:
							"AGENTS.md (Codex, Jules, Amp, Cursor, Zed, Warp, Aider, GitHub, RooCode)",
						value: "AGENTS.md",
					},
					{ label: "GEMINI.md (Google CLI)", value: "GEMINI.md" },
					{
						label: "Copilot (GitHub Copilot)",
						value: ".github/copilot-instructions.md",
					},
				],
			});
			const files: AgentInstructionFile[] = clack.isCancel(selected)
				? []
				: Array.isArray(selected)
					? (selected as AgentInstructionFile[])
					: [];

			if (files.length > 0) {
				// Get autoCommit setting from config
				const config = await core.filesystem.loadConfig();
				const shouldAutoCommit = config?.autoCommit ?? false;
				await addAgentInstructions(cwd, core.gitOps, files, shouldAutoCommit);
				console.log(
					`Updated ${files.length} agent instruction file(s): ${files.join(", ")}`,
				);
			} else {
				console.log("No files selected for update.");
			}
		} catch (err) {
			console.error("Failed to update agent instructions", err);
			process.exitCode = 1;
		}
	});

program
	.command("orchestrate")
	.description(
		"setup the Multi-Agent Orchestration environment (Coordinator + Executors)",
	)
	.option("-a, --agents <count>", "number of executor agents to initialize")
	.action(async (options) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const { runOrchestrateCommand } = await import(
				"./commands/orchestrate.ts"
			);
			await runOrchestrateCommand(core, options.agents);
		} catch (err) {
			console.error("Failed to orchestrate workspace:", err);
			process.exit(1);
		}
	});

// Config command group
const configCmd = program
	.command("config")
	.description("manage roadmap configuration")
	.action(async () => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const existingConfig = await core.filesystem.loadConfig();

			if (!existingConfig) {
				console.error(
					"No roadmap project found. Initialize one first with: roadmap init",
				);
				process.exit(1);
			}

			const {
				mergedConfig,
				installClaudeAgent: shouldInstallClaude,
				installShellCompletions: shouldInstallCompletions,
			} = await configureAdvancedSettings(core);

			let completionResult: CompletionInstallResult | null = null;
			let completionError: string | null = null;
			if (shouldInstallCompletions) {
				try {
					completionResult = await installCompletion();
				} catch (error) {
					completionError =
						error instanceof Error ? error.message : String(error);
				}
			}

			console.log("\nAdvanced configuration updated.");
			console.log(
				`  Check active branches: ${mergedConfig.checkActiveBranches ?? true}`,
			);
			console.log(
				`  Remote operations: ${mergedConfig.remoteOperations ?? true}`,
			);
			console.log(
				`  Zero-padded IDs: ${
					typeof mergedConfig.zeroPaddedIds === "number"
						? `${mergedConfig.zeroPaddedIds} digits`
						: "disabled"
				}`,
			);
			console.log(`  Web UI port: ${mergedConfig.defaultPort ?? 6420}`);
			console.log(
				`  Auto open browser: ${mergedConfig.autoOpenBrowser ?? true}`,
			);
			console.log(
				`  Bypass git hooks: ${mergedConfig.bypassGitHooks ?? false}`,
			);
			console.log(`  Auto commit: ${mergedConfig.autoCommit ?? false}`);
			if (completionResult) {
				console.log(
					`  Shell completions: installed to ${completionResult.installPath}`,
				);
			} else if (completionError) {
				console.log(
					"  Shell completions: installation failed (see warning below)",
				);
			} else {
				console.log("  Shell completions: skipped");
			}
			if (mergedConfig.defaultEditor) {
				console.log(`  Default editor: ${mergedConfig.defaultEditor}`);
			}
			if (shouldInstallClaude) {
				await installClaudeAgent(cwd);
				console.log(
					"✓ Claude Code Roadmap.md agent installed to .claude/agents/",
				);
			}
			if (completionResult) {
				const instructions = completionResult.instructions.trim();
				console.log(
					[
						"",
						`Shell completion script installed for ${completionResult.shell}.`,
						`  Path: ${completionResult.installPath}`,
						instructions,
						"",
					].join("\n"),
				);
			} else if (completionError) {
				const indentedError = completionError
					.split("\n")
					.map((line) => `  ${line}`)
					.join("\n");
				console.warn(
					`⚠️  Shell completion installation failed:\n${indentedError}\n  Run \`roadmap completion install\` later to retry.\n`,
				);
			}
			console.log(
				"\nUse `roadmap config list` to review all configuration values.",
			);
		} catch (err) {
			console.error("Failed to update configuration", err);
			process.exitCode = 1;
		}
	});

// Sequences command group
const sequenceCmd = program.command("sequence");

sequenceCmd
	.description(
		"list and inspect execution sequences computed from proposal dependencies",
	)
	.command("list")
	.description(
		"list sequences (interactive by default; use --plain for text output)",
	)
	.option("--plain", "use plain text output instead of interactive UI")
	.action(async (options) => {
		const cwd = await requireProjectRoot();
		const core = new Core(cwd);
		const proposals = await core.queryProposals();
		// Exclude proposals marked as Reached from sequences (case-insensitive)
		const activeProposals = proposals.filter(
			(t) => (t.status || "").toLowerCase() !== "done",
		);
		const { unsequenced, sequences } = computeSequences(activeProposals);

		const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
		if (usePlainOutput) {
			if (unsequenced.length > 0) {
				console.log("Unsequenced:");
				for (const t of unsequenced) {
					console.log(`  ${t.id} - ${t.title}`);
				}
				console.log("");
			}
			for (const seq of sequences) {
				console.log(`Sequence ${seq.index}:`);
				for (const t of seq.proposals) {
					console.log(`  ${t.id} - ${t.title}`);
				}
				console.log("");
			}
			return;
		}

		// Interactive default: TUI view (215.01 + 215.02 navigation/detail)
		const { runSequencesView } = await import("../ui/sequences.ts");
		await runSequencesView({ unsequenced, sequences }, core);
	});

configCmd
	.command("get <key>")
	.description("get a configuration value")
	.action(async (key: string) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();

			if (!config) {
				console.error(
					"No roadmap project found. Initialize one first with: roadmap init",
				);
				process.exit(1);
			}

			// Handle specific config keys
			switch (key) {
				case "defaultEditor":
					if (config.defaultEditor) {
						console.log(config.defaultEditor);
					} else {
						console.log("defaultEditor is not set");
						process.exit(1);
					}
					break;
				case "projectName":
					console.log(config.projectName);
					break;
				case "defaultStatus":
					console.log(config.defaultStatus || "");
					break;
				case "statuses":
					console.log(config.statuses.join(", "));
					break;
				case "labels":
					console.log(config.labels.join(", "));
					break;
				case "directives": {
					const directives = await core.filesystem.listDirectives();
					console.log(directives.map((directive) => directive.id).join(", "));
					break;
				}
				case "dateFormat":
					console.log(config.dateFormat);
					break;
				case "maxColumnWidth":
					console.log(config.maxColumnWidth?.toString() || "");
					break;
				case "defaultPort":
					console.log(config.defaultPort?.toString() || "");
					break;
				case "autoOpenBrowser":
					console.log(config.autoOpenBrowser?.toString() || "");
					break;
				case "remoteOperations":
					console.log(config.remoteOperations?.toString() || "");
					break;
				case "autoCommit":
					console.log(config.autoCommit?.toString() || "");
					break;
				case "bypassGitHooks":
					console.log(config.bypassGitHooks?.toString() || "");
					break;
				case "zeroPaddedIds":
					console.log(config.zeroPaddedIds?.toString() || "(disabled)");
					break;
				case "checkActiveBranches":
					console.log(config.checkActiveBranches?.toString() || "true");
					break;
				case "activeBranchDays":
					console.log(config.activeBranchDays?.toString() || "30");
					break;
				default:
					console.error(`Unknown config key: ${key}`);
					console.error(
						"Available keys: defaultEditor, projectName, defaultStatus, statuses, labels, directives, dateFormat, maxColumnWidth, defaultPort, autoOpenBrowser, remoteOperations, autoCommit, bypassGitHooks, zeroPaddedIds, checkActiveBranches, activeBranchDays",
					);
					process.exit(1);
			}
		} catch (err) {
			console.error("Failed to get config value", err);
			process.exitCode = 1;
		}
	});

configCmd
	.command("set <key> <value>")
	.description("set a configuration value")
	.action(async (key: string, value: string) => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();

			if (!config) {
				console.error(
					"No roadmap project found. Initialize one first with: roadmap init",
				);
				process.exit(1);
			}

			// Handle specific config keys
			switch (key) {
				case "defaultEditor": {
					// Validate that the editor command exists
					const { isEditorAvailable } = await import("../utils/editor.ts");
					const isAvailable = await isEditorAvailable(value);
					if (!isAvailable) {
						console.error(`Editor command not found: ${value}`);
						console.error(
							"Please ensure the editor is installed and available in your PATH",
						);
						process.exit(1);
					}
					config.defaultEditor = value;
					break;
				}
				case "projectName":
					config.projectName = value;
					break;
				case "defaultStatus":
					config.defaultStatus = value;
					break;
				case "dateFormat":
					config.dateFormat = value;
					break;
				case "maxColumnWidth": {
					const width = Number.parseInt(value, 10);
					if (Number.isNaN(width) || width <= 0) {
						console.error("maxColumnWidth must be a positive number");
						process.exit(1);
					}
					config.maxColumnWidth = width;
					break;
				}
				case "autoOpenBrowser": {
					const boolValue = value.toLowerCase();
					if (
						boolValue === "true" ||
						boolValue === "1" ||
						boolValue === "yes"
					) {
						config.autoOpenBrowser = true;
					} else if (
						boolValue === "false" ||
						boolValue === "0" ||
						boolValue === "no"
					) {
						config.autoOpenBrowser = false;
					} else {
						console.error("autoOpenBrowser must be true or false");
						process.exit(1);
					}
					break;
				}
				case "defaultPort": {
					const port = Number.parseInt(value, 10);
					if (Number.isNaN(port) || port < 1 || port > 65535) {
						console.error("defaultPort must be a valid port number (1-65535)");
						process.exit(1);
					}
					config.defaultPort = port;
					break;
				}
				case "remoteOperations": {
					const boolValue = value.toLowerCase();
					if (
						boolValue === "true" ||
						boolValue === "1" ||
						boolValue === "yes"
					) {
						config.remoteOperations = true;
					} else if (
						boolValue === "false" ||
						boolValue === "0" ||
						boolValue === "no"
					) {
						config.remoteOperations = false;
					} else {
						console.error("remoteOperations must be true or false");
						process.exit(1);
					}
					break;
				}
				case "autoCommit": {
					const boolValue = value.toLowerCase();
					if (
						boolValue === "true" ||
						boolValue === "1" ||
						boolValue === "yes"
					) {
						config.autoCommit = true;
					} else if (
						boolValue === "false" ||
						boolValue === "0" ||
						boolValue === "no"
					) {
						config.autoCommit = false;
					} else {
						console.error("autoCommit must be true or false");
						process.exit(1);
					}
					break;
				}
				case "bypassGitHooks": {
					const boolValue = value.toLowerCase();
					if (
						boolValue === "true" ||
						boolValue === "1" ||
						boolValue === "yes"
					) {
						config.bypassGitHooks = true;
					} else if (
						boolValue === "false" ||
						boolValue === "0" ||
						boolValue === "no"
					) {
						config.bypassGitHooks = false;
					} else {
						console.error("bypassGitHooks must be true or false");
						process.exit(1);
					}
					break;
				}
				case "zeroPaddedIds": {
					const padding = Number.parseInt(value, 10);
					if (Number.isNaN(padding) || padding < 0) {
						console.error("zeroPaddedIds must be a non-negative number.");
						process.exit(1);
					}
					// Set to undefined if 0 to remove it from config
					config.zeroPaddedIds = padding > 0 ? padding : undefined;
					break;
				}
				case "checkActiveBranches": {
					const boolValue = value.toLowerCase();
					if (
						boolValue === "true" ||
						boolValue === "1" ||
						boolValue === "yes"
					) {
						config.checkActiveBranches = true;
					} else if (
						boolValue === "false" ||
						boolValue === "0" ||
						boolValue === "no"
					) {
						config.checkActiveBranches = false;
					} else {
						console.error("checkActiveBranches must be true or false");
						process.exit(1);
					}
					break;
				}
				case "activeBranchDays": {
					const days = Number.parseInt(value, 10);
					if (Number.isNaN(days) || days < 0) {
						console.error("activeBranchDays must be a non-negative number.");
						process.exit(1);
					}
					config.activeBranchDays = days;
					break;
				}
				case "statuses":
				case "labels":
				case "directives":
					if (key === "directives") {
						console.error("directives cannot be set directly.");
						console.error(
							"Use directive files via directive commands (e.g. `roadmap directive list`, `roadmap directive add`).",
						);
					} else {
						console.error(
							`${key} cannot be set directly. Use 'roadmap config list-${key}' to view current values.`,
						);
						console.error(
							"Array values should be edited in the config file directly.",
						);
					}
					process.exit(1);
					break;
				case "proposalPrefix":
				case "prefixes":
					console.error(
						"Proposal prefix cannot be changed after initialization.",
					);
					console.error(
						"The prefix is set during 'roadmap init' and is permanent to avoid breaking existing proposal IDs.",
					);
					process.exit(1);
					break;
				default:
					console.error(`Unknown config key: ${key}`);
					console.error(
						"Available keys: defaultEditor, projectName, defaultStatus, dateFormat, maxColumnWidth, autoOpenBrowser, defaultPort, remoteOperations, autoCommit, bypassGitHooks, zeroPaddedIds, checkActiveBranches, activeBranchDays",
					);
					process.exit(1);
			}

			await core.filesystem.saveConfig(config);
			console.log(`Set ${key} = ${value}`);
		} catch (err) {
			console.error("Failed to set config value", err);
			process.exitCode = 1;
		}
	});

configCmd
	.command("list")
	.description("list all configuration values")
	.action(async () => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();

			if (!config) {
				console.error(
					"No roadmap project found. Initialize one first with: roadmap init",
				);
				process.exit(1);
			}

			console.log("Configuration:");
			console.log(`  projectName: ${config.projectName}`);
			console.log(`  defaultEditor: ${config.defaultEditor || "(not set)"}`);
			console.log(`  defaultStatus: ${config.defaultStatus || "(not set)"}`);
			console.log(`  statuses: [${config.statuses.join(", ")}]`);
			console.log(`  labels: [${config.labels.join(", ")}]`);
			const directives = await core.filesystem.listDirectives();
			console.log(`  directives: [${directives.map((m) => m.id).join(", ")}]`);
			console.log(`  dateFormat: ${config.dateFormat}`);

			console.log(`  maxColumnWidth: ${config.maxColumnWidth || "(not set)"}`);
			console.log(
				`  autoOpenBrowser: ${config.autoOpenBrowser ?? "(not set)"}`,
			);
			console.log(`  defaultPort: ${config.defaultPort ?? "(not set)"}`);
			console.log(
				`  remoteOperations: ${config.remoteOperations ?? "(not set)"}`,
			);
			console.log(`  autoCommit: ${config.autoCommit ?? "(not set)"}`);
			console.log(`  bypassGitHooks: ${config.bypassGitHooks ?? "(not set)"}`);
			console.log(`  zeroPaddedIds: ${config.zeroPaddedIds ?? "(disabled)"}`);
			console.log(
				`  proposalPrefix: ${config.prefixes?.proposal || "proposal"} (read-only)`,
			);
			console.log(
				`  checkActiveBranches: ${config.checkActiveBranches ?? "true"}`,
			);
			console.log(`  activeBranchDays: ${config.activeBranchDays ?? "30"}`);
		} catch (err) {
			console.error("Failed to list config values", err);
			process.exitCode = 1;
		}
	});

// Cleanup command for managing completed proposals
program
	.command("cleanup")
	.description("move completed proposals to completed folder based on age")
	.action(async () => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);

			// Check if roadmap project is initialized
			const config = await core.filesystem.loadConfig();
			if (!config) {
				console.error(
					"No roadmap project found. Initialize one first with: roadmap init",
				);
				process.exit(1);
			}

			// Get all Reached proposals
			const proposals = await core.queryProposals();
			const doneProposals = proposals.filter(
				(proposal) => proposal.status === "Reached",
			);

			if (doneProposals.length === 0) {
				console.log("No completed proposals found to clean up.");
				return;
			}

			console.log(`Found ${doneProposals.length} proposals marked as Reached.`);

			const ageOptions = [
				{ title: "1 day", value: 1 },
				{ title: "1 week", value: 7 },
				{ title: "2 weeks", value: 14 },
				{ title: "3 weeks", value: 21 },
				{ title: "1 month", value: 30 },
				{ title: "3 months", value: 90 },
				{ title: "1 year", value: 365 },
			];

			const selectedAgePrompt = await clack.select({
				message: "Move proposals to completed folder if they are older than:",
				options: ageOptions.map((option) => ({
					label: option.title,
					value: option.value,
				})),
			});
			const selectedAge = clack.isCancel(selectedAgePrompt)
				? undefined
				: selectedAgePrompt;

			if (selectedAge === undefined) {
				console.log("Cleanup cancelled.");
				return;
			}

			// Get proposals older than selected period
			const proposalsToMove = await core.getReachedProposalsByAge(selectedAge);

			if (proposalsToMove.length === 0) {
				console.log(
					`No proposals found that are older than ${ageOptions.find((o) => o.value === selectedAge)?.title}.`,
				);
				return;
			}

			console.log(
				`\nFound ${proposalsToMove.length} proposals older than ${ageOptions.find((o) => o.value === selectedAge)?.title}:`,
			);
			for (const proposal of proposalsToMove.slice(0, 5)) {
				const date = proposal.updatedDate || proposal.createdDate;
				console.log(`  - ${proposal.id}: ${proposal.title} (${date})`);
			}
			if (proposalsToMove.length > 5) {
				console.log(`  ... and ${proposalsToMove.length - 5} more`);
			}

			const confirmedPrompt = await clack.confirm({
				message: `Move ${proposalsToMove.length} proposals to completed folder?`,
				initialValue: false,
			});
			const confirmed = clack.isCancel(confirmedPrompt)
				? false
				: confirmedPrompt;

			if (!confirmed) {
				console.log("Cleanup cancelled.");
				return;
			}

			// Move proposals to completed folder
			let successCount = 0;
			const shouldAutoCommit = config.autoCommit ?? false;

			console.log("Moving proposals...");
			const movedProposals: Array<{
				fromPath: string;
				toPath: string;
				proposalId: string;
			}> = [];

			for (const proposal of proposalsToMove) {
				const fromPath =
					proposal.filePath ??
					(await core.getProposal(proposal.id))?.filePath ??
					null;

				if (!fromPath) {
					console.error(`Failed to locate file for proposal ${proposal.id}`);
					continue;
				}

				const proposalFilename = basename(fromPath);
				const toPath = join(core.filesystem.completedDir, proposalFilename);

				const success = await core.completeProposal(proposal.id);
				if (success) {
					successCount++;
					movedProposals.push({ fromPath, toPath, proposalId: proposal.id });
				} else {
					console.error(`Failed to move proposal ${proposal.id}`);
				}
			}

			// If autoCommit is disabled, stage the moves so Git recognizes them
			if (successCount > 0 && !shouldAutoCommit) {
				console.log("Staging file moves for Git...");
				for (const { fromPath, toPath } of movedProposals) {
					try {
						await core.gitOps.stageFileMove(fromPath, toPath);
					} catch (error) {
						console.warn(`Warning: Could not stage move for Git: ${error}`);
					}
				}
			}

			console.log(
				`Successfully moved ${successCount} of ${proposalsToMove.length} proposals to completed folder.`,
			);
			if (successCount > 0 && !shouldAutoCommit) {
				console.log(
					"Files have been staged. To commit: git commit -m 'cleanup: Move completed proposals'",
				);
			}
		} catch (err) {
			console.error("Failed to run cleanup", err);
			process.exitCode = 1;
		}
	});

// Browser command for web UI
program
	.command("browser")
	.description(
		"open browser interface for proposal management (press Ctrl+C or Cmd+C to stop)",
	)
	.option("-p, --port <port>", "port to run server on")
	.option("--no-open", "don't automatically open browser")
	.action(async (options) => {
		try {
			const cwd = await requireProjectRoot();
			const { RoadmapServer } = await import("./server/index.ts");
			const server = new RoadmapServer(cwd);

			// Load config to get default port
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();
			const defaultPort = config?.defaultPort ?? 6420;

			const port = Number.parseInt(options.port || defaultPort.toString(), 10);
			if (Number.isNaN(port) || port < 1 || port > 65535) {
				console.error("Invalid port number. Must be between 1 and 65535.");
				process.exit(1);
			}

			await server.start(port, options.open !== false);

			// Graceful shutdown on common termination signals (register once)
			let shuttingDown = false;
			const shutdown = async (signal: string) => {
				if (shuttingDown) return;
				shuttingDown = true;
				console.log(`\nReceived ${signal}. Shutting down server...`);
				try {
					const stopPromise = server.stop();
					const timeout = new Promise<void>((resolve) =>
						setTimeout(resolve, 1500),
					);
					await Promise.race([stopPromise, timeout]);
				} finally {
					process.exit(0);
				}
			};

			process.once("SIGINT", () => void shutdown("SIGINT"));
			process.once("SIGTERM", () => void shutdown("SIGTERM"));
			process.once("SIGQUIT", () => void shutdown("SIGQUIT"));
		} catch (err) {
			console.error("Failed to start browser interface", err);
			process.exitCode = 1;
		}
	});

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const serviceCmd = program.command("service");

serviceCmd
	.command("start")
	.description("start the roadmap service in the background")
	.option("-p, --port <port>", "port to run service on")
	.action(async (options) => {
		const cwd = await requireProjectRoot();
		const pidFile = join(cwd, ".roadmap-service.pid");

		if (existsSync(pidFile)) {
			const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
			try {
				process.kill(pid, 0); // Check if process exists
				console.log(`Service already running (PID: ${pid})`);
				return;
			} catch {
				// Process not running, stale PID file
				unlinkSync(pidFile);
			}
		}

		console.log("Starting roadmap service in background...");
		const { spawn } = await import("node:child_process");
		const port = options.port || "6420";

		// Use the scripts/cli.cjs to start browser in background without opening it
		const child = spawn(
			process.execPath,
			[join(cwd, "scripts/cli.cjs"), "browser", "--no-open", "--port", port],
			{
				detached: true,
				stdio: "ignore",
				cwd,
			},
		);

		if (child.pid) {
			writeFileSync(pidFile, child.pid.toString());
			child.unref();
			console.log(`Service started (PID: ${child.pid}, Port: ${port})`);
		} else {
			console.error("Failed to start background service");
		}
	});

serviceCmd
	.command("stop")
	.description("stop the background roadmap service")
	.action(async () => {
		const cwd = await requireProjectRoot();
		const pidFile = join(cwd, ".roadmap-service.pid");

		if (!existsSync(pidFile)) {
			console.log("Service not running (no PID file)");
			return;
		}

		const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
		try {
			process.kill(pid, "SIGTERM");
			console.log(`Sent shutdown signal to service (PID: ${pid})`);
			unlinkSync(pidFile);
		} catch (err) {
			console.error(
				`Failed to stop service: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

serviceCmd
	.command("status")
	.description("check the status of the background service")
	.action(async () => {
		const cwd = await requireProjectRoot();
		const pidFile = join(cwd, ".roadmap-service.pid");

		if (!existsSync(pidFile)) {
			console.log("Service status: Offline");
			return;
		}

		const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
		try {
			process.kill(pid, 0);
			console.log(`Service status: Running (PID: ${pid})`);
		} catch {
			console.log("Service status: Stale (process not found)");
			unlinkSync(pidFile);
		}
	});

// Overview command for statistics
program
	.command("overview")
	.description("display project statistics and metrics")
	.action(async () => {
		try {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();

			if (!config) {
				console.error(
					"No roadmap project found. Initialize one first with: roadmap init",
				);
				process.exit(1);
			}

			// Import and run the overview command
			const { runOverviewCommand } = await import("./commands/overview.ts");
			await runOverviewCommand(core);
		} catch (err) {
			console.error("Failed to display project overview", err);
			process.exitCode = 1;
		}
	});

// Completion command group
registerCompletionCommand(program);

// MCP command group
registerMcpCommand(program);

// Sandbox command group
program.addCommand(sandboxCommand);

// Cubic management
registerCubicCommand(program);

// State machine management
registerStateMachineCommand(program);

program.parseAsync(process.argv).finally(() => {
	// Restore BUN_OPTIONS after CLI parsing completes so it's available for subsequent commands
	if (originalBunOptions) {
		process.env.BUN_OPTIONS = originalBunOptions;
	}
});
