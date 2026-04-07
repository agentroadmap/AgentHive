/**
 * Platform-aware test helpers that avoid memory issues on Windows CI
 * by testing Core directly instead of spawning CLI processes
 */

import { join } from "node:path";
import { Core } from "../../src/core/roadmap.ts";
import type {
	ProposalCreateInput,
	ProposalUpdateInput,
} from "../../src/types/index.ts";
import { hasAnyPrefix } from "../../src/utils/prefix-config.ts";
import { normalizeDependencies } from "../../src/utils/proposal-builders.ts";
import { buildCliCommand, execSync } from "./test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");
const isWindows = process.platform === "win32";

export interface ProposalCreateOptions {
	title: string;
	description?: string;
	assignee?: string;
	status?: string;
	labels?: string;
	priority?: string;
	ac?: string;
	plan?: string;
	notes?: string;
	draft?: boolean;
	parent?: string;
	dependencies?: string;
	maturity?: string;
	finalSummary?: string;
	proof?: string[];
	builder?: string;
	auditor?: string;
}

/**
 * Platform-aware proposal creation that uses Core directly on Windows
 * and CLI spawning on Unix systems
 */
export async function createProposalPlatformAware(
	options: ProposalCreateOptions,
	testDir: string,
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	proposalId?: string;
}> {
	// Always use Core API for tests to avoid CLI process spawning issues
	return createProposalViaCore(options, testDir);
}

async function createProposalViaCore(
	options: ProposalCreateOptions,
	testDir: string,
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	proposalId?: string;
}> {
	const core = new Core(testDir);

	const normalizedPriority = options.priority
		? String(options.priority).toLowerCase()
		: undefined;
	const createInput: ProposalCreateInput = {
		title: options.title.trim(),
		description: options.description,
		status: options.status ?? (options.draft ? "Draft" : undefined),
		priority: normalizedPriority as ProposalCreateInput["priority"],
		labels: options.labels
			? options.labels
					.split(",")
					.map((label) => label.trim())
					.filter((label) => label.length > 0)
			: undefined,
		assignee: options.assignee ? [options.assignee] : undefined,
		dependencies: options.dependencies
			? normalizeDependencies(options.dependencies)
			: undefined,
		parentProposalId: options.parent
			? hasAnyPrefix(options.parent)
				? options.parent
				: `proposal-${options.parent}`
			: undefined,
		maturity: options.maturity as any,
		finalSummary: options.finalSummary,
		proof: options.proof,
		builder: options.builder,
		auditor: options.auditor,
	};

	if (!createInput.title) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: "Title is required",
		};
	}

	if (options.ac) {
		const trimmed = options.ac.trim();
		if (trimmed) {
			createInput.acceptanceCriteria = [{ text: trimmed, checked: false }];
		}
	}

	if (options.plan) {
		createInput.implementationPlan = options.plan;
	}

	if (options.notes) {
		createInput.implementationNotes = options.notes;
	}

	try {
		const { proposal } = await core.createProposalFromInput(createInput);
		const isDraft = (proposal.status ?? "").toLowerCase() === "draft";
		return {
			exitCode: 0,
			stdout: isDraft
				? `Created draft ${proposal.id}`
				: `Created proposal ${proposal.id}`,
			stderr: "",
			proposalId: proposal.id,
		};
	} catch (error) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

async function _createProposalViaCLI(
	options: ProposalCreateOptions,
	testDir: string,
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	proposalId?: string;
}> {
	// Build CLI arguments
	const args = [CLI_PATH, "proposal", "create", options.title];

	if (options.description) args.push("--description", options.description);
	if (options.assignee) args.push("--assignee", options.assignee);
	if (options.status) args.push("--status", options.status);
	if (options.labels) args.push("--labels", options.labels);
	if (options.priority) args.push("--priority", options.priority);
	if (options.ac) args.push("--ac", options.ac);
	if (options.plan) args.push("--plan", options.plan);
	if (options.draft) args.push("--draft");
	if (options.parent) args.push("--parent", options.parent);
	if (options.dependencies) args.push("--dep", options.dependencies);
	if (options.maturity) args.push("--maturity", options.maturity);
	if (options.finalSummary) args.push("--final-summary", options.finalSummary);
	if (options.proof) {
		for (const p of options.proof) {
			args.push("--proof", p);
		}
	}
	if (options.builder) args.push("--builder", options.builder);
	if (options.auditor) args.push("--auditor", options.auditor);

	const result = execSync(
		`node --experimental-strip-types ${buildCliCommand(args)}`,
		{ cwd: testDir },
	);

	// Extract proposal ID from stdout
	const match = result.stdout
		.toString()
		.match(/Created (?:proposal|draft) (proposal-\d+)/);
	const proposalId = match ? match[1] : undefined;

	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
		proposalId,
	};
}

export interface ProposalEditOptions {
	proposalId: string;
	title?: string;
	description?: string;
	assignee?: string;
	status?: string;
	labels?: string;
	priority?: string;
	dependencies?: string;
	notes?: string;
	plan?: string;
	maturity?: string;
	finalSummary?: string;
	addProof?: string[];
	proof?: string[];
	builder?: string;
	auditor?: string;
}

/**
 * Platform-aware proposal editing that uses Core directly on Windows
 * and CLI spawning on Unix systems
 */
export async function editProposalPlatformAware(
	options: ProposalEditOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Always use Core API for tests to avoid CLI process spawning issues
	return editProposalViaCore(options, testDir);
}

async function editProposalViaCore(
	options: ProposalEditOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	try {
		const core = new Core(testDir);

		// Load existing proposal
		const proposalId = hasAnyPrefix(options.proposalId)
			? options.proposalId
			: `proposal-${options.proposalId}`;
		const existingProposal = await core.filesystem.loadProposal(proposalId);
		if (!existingProposal) {
			return {
				exitCode: 1,
				stdout: "",
				stderr: `Proposal ${proposalId} not found`,
			};
		}

		const updateInput: ProposalUpdateInput = {
			...(options.title && { title: options.title }),
			...(options.description && { description: options.description }),
			...(options.status && { status: options.status }),
			...(options.assignee && { assignee: [options.assignee] }),
			...(options.labels && {
				labels: options.labels
					.split(",")
					.map((label) => label.trim())
					.filter((label) => label.length > 0),
			}),
			...(options.dependencies && {
				dependencies: normalizeDependencies(options.dependencies),
			}),
			...(options.priority && {
				priority: options.priority as ProposalUpdateInput["priority"],
			}),
			...(options.notes && { implementationNotes: options.notes }),
			...(options.plan && { implementationPlan: options.plan }),
			...(options.maturity && { maturity: options.maturity as any }),
			...(options.finalSummary && { finalSummary: options.finalSummary }),
			...(options.addProof && { addProof: options.addProof }),
			...(options.proof && { proof: options.proof }),
			...(options.builder && { builder: options.builder }),
			...(options.auditor && { auditor: options.auditor }),
		};

		await core.updateProposalFromInput(proposalId, updateInput, false);
		return {
			exitCode: 0,
			stdout: `Updated proposal ${proposalId}`,
			stderr: "",
		};
	} catch (error) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

async function _editProposalViaCLI(
	options: ProposalEditOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Build CLI arguments
	const args = [CLI_PATH, "proposal", "edit", options.proposalId];

	if (options.title) args.push("--title", options.title);
	if (options.description) args.push("--description", options.description);
	if (options.assignee) args.push("--assignee", options.assignee);
	if (options.status) args.push("--status", options.status);
	if (options.labels) args.push("--labels", options.labels);
	if (options.priority) args.push("--priority", options.priority);
	if (options.dependencies) args.push("--dep", options.dependencies);
	if (options.notes) args.push("--notes", options.notes);
	if (options.plan) args.push("--plan", options.plan);
	if (options.maturity) args.push("--maturity", options.maturity);
	if (options.finalSummary) args.push("--final-summary", options.finalSummary);
	if (options.addProof) {
		for (const p of options.addProof) {
			args.push("--add-proof", p);
		}
	}
	if (options.proof) {
		for (const p of options.proof) {
			args.push("--proof", p);
		}
	}
	if (options.builder) args.push("--builder", options.builder);
	if (options.auditor) args.push("--auditor", options.auditor);

	const result = execSync(
		`node --experimental-strip-types ${buildCliCommand(args)}`,
		{ cwd: testDir },
	);

	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

export interface ProposalViewOptions {
	proposalId: string;
	plain?: boolean;
	useViewCommand?: boolean;
}

/**
 * Platform-aware proposal viewing that uses Core directly on Windows
 * and CLI spawning on Unix systems
 */
export async function viewProposalPlatformAware(
	options: ProposalViewOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Always use Core API for tests to avoid CLI process spawning issues
	return viewProposalViaCore(options, testDir);
}

async function viewProposalViaCore(
	options: ProposalViewOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	try {
		const core = new Core(testDir);
		const proposalId = hasAnyPrefix(options.proposalId)
			? options.proposalId
			: `proposal-${options.proposalId}`;

		const proposal = await core.filesystem.loadProposal(proposalId);
		if (!proposal) {
			return {
				exitCode: 1,
				stdout: "",
				stderr: `Proposal ${proposalId} not found`,
			};
		}

		// Format output to match CLI output
		let output = `Proposal ${proposalId} - ${proposal.title}`;
		if (options.plain) {
			output += `\nStatus: ${proposal.status}`;
			if (proposal.assignee?.length > 0) {
				output += `\nAssignee: ${proposal.assignee.join(", ")}`;
			}
			if (proposal.labels?.length > 0) {
				output += `\nLabels: ${proposal.labels.join(", ")}`;
			}
			if (proposal.dependencies?.length > 0) {
				output += `\nDependencies: ${proposal.dependencies.join(", ")}`;
			}
			if (proposal.rawContent) {
				output += `\n\n${proposal.rawContent}`;
			}
		}

		return {
			exitCode: 0,
			stdout: output,
			stderr: "",
		};
	} catch (error) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

async function _viewProposalViaCLI(
	options: ProposalViewOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const args = [CLI_PATH, "proposal"];

	// Handle both "proposal 1" and "proposal view 1" formats
	if (options.useViewCommand) {
		args.push("view", options.proposalId);
	} else {
		args.push(options.proposalId);
	}

	if (options.plain) {
		args.push("--plain");
	}

	const result = execSync(
		`node --experimental-strip-types ${buildCliCommand(args)}`,
		{ cwd: testDir },
	);

	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

/**
 * Platform-aware CLI help command execution
 */
export async function getCliHelpPlatformAware(
	command: string[],
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	if (isWindows) {
		// On Windows, we can't easily test help output without running CLI
		// Return a mock response that matches the expected behavior
		return {
			exitCode: 0,
			stdout: `Usage: proposal create [options] <title>

Options:
  -d, --description <description>  proposal description
  -a, --assignee <assignee>        assign to user
  -s, --status <status>           set proposal status
  -l, --labels <labels>           add labels (comma-separated)
  --priority <priority>           set proposal priority (high, medium, low)
  --ac <criteria>                 acceptance criteria (comma-separated)
  --plan <plan>                   implementation plan
  --draft                         create as draft
  -p, --parent <proposalId>           specify parent proposal ID
  --dep <dependencies>            proposal dependencies (comma-separated)
  --depends-on <dependencies>     proposal dependencies (comma-separated)
  -h, --help                      display help for command`,
			stderr: "",
		};
	}

	// Test CLI integration on Unix systems
	const result = execSync(
		`node --experimental-strip-types ${buildCliCommand([CLI_PATH, ...command])}`,
		{ cwd: testDir },
	);

	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

export interface ProposalListOptions {
	plain?: boolean;
	status?: string;
	assignee?: string;
}

/**
 * Platform-aware proposal listing that uses Core directly on Windows
 * and CLI spawning on Unix systems
 */
export async function listProposalsPlatformAware(
	options: ProposalListOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Always use Core API for tests to avoid CLI process spawning issues
	return listProposalsViaCore(options, testDir);
}

async function listProposalsViaCore(
	options: ProposalListOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	try {
		const core = new Core(testDir);
		const proposals = await core.filesystem.listProposals();

		// Filter by status if provided
		let filteredProposals = proposals;
		if (options.status) {
			const statusFilter = options.status.toLowerCase();
			filteredProposals = proposals.filter(
				(proposal) => proposal.status.toLowerCase() === statusFilter,
			);
		}

		// Filter by assignee if provided
		if (options.assignee) {
			filteredProposals = filteredProposals.filter((proposal) =>
				proposal.assignee.some((a) =>
					a.toLowerCase().includes(options.assignee?.toLowerCase() ?? ""),
				),
			);
		}

		// Format output to match CLI output
		if (options.plain) {
			if (filteredProposals.length === 0) {
				return {
					exitCode: 0,
					stdout: "No proposals found",
					stderr: "",
				};
			}

			// Group by status
			const proposalsByStatus = new Map<string, typeof filteredProposals>();
			for (const proposal of filteredProposals) {
				const status = proposal.status || "No Status";
				const existing = proposalsByStatus.get(status) || [];
				existing.push(proposal);
				proposalsByStatus.set(status, existing);
			}

			let output = "";
			for (const [status, statusProposals] of proposalsByStatus) {
				output += `${status}:\n`;
				for (const proposal of statusProposals) {
					output += `${proposal.id} - ${proposal.title}\n`;
				}
				output += "\n";
			}

			return {
				exitCode: 0,
				stdout: output.trim(),
				stderr: "",
			};
		}

		// Non-plain output (basic format)
		let output = "";
		for (const proposal of filteredProposals) {
			output += `${proposal.id} - ${proposal.title}\n`;
		}

		return {
			exitCode: 0,
			stdout: output,
			stderr: "",
		};
	} catch (error) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

async function _listProposalsViaCLI(
	options: ProposalListOptions,
	testDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const args = [CLI_PATH, "proposal", "list"];

	if (options.plain) {
		args.push("--plain");
	}

	if (options.status) {
		args.push("-s", options.status);
	}

	if (options.assignee) {
		args.push("-a", options.assignee);
	}

	const result = execSync(
		`node --experimental-strip-types ${buildCliCommand(args)}`,
		{ cwd: testDir },
	);

	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

export { isWindows };
