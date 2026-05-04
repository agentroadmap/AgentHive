/**
 * Project domain: CRUD and lifecycle management for projects.
 *
 * Commands:
 * - hive project list [--format text|json|yaml]
 * - hive project info [--format text|json|yaml]
 * - hive project status [--format text|json|yaml]
 * - hive project register [--name NAME] [--repo REPO_URL] (MCP mutation)
 * - hive project archive PROJECT_ID (MCP mutation)
 *
 * Implements cli-hive-contract.md §1 (project domain).
 */

import type { Command } from "commander";
import {
	type DomainSchema,
	Errors,
	getControlPlaneClient,
	type ProjectRow,
	type Recipe,
	registerDomain,
	registerRecipe,
} from "../../common/index";

const DOMAIN_NAME = "project";
const DOMAIN_DESCRIPTION = "Project CRUD and lifecycle management";

const domainSchema: DomainSchema = {
	name: DOMAIN_NAME,
	aliases: [],
	description: DOMAIN_DESCRIPTION,
	subcommands: [
		{
			name: "list",
			signature: "hive project list",
			description: "List all projects",
			flags: [
				{
					name: "format",
					type: "enum",
					enum: ["text", "json", "jsonl", "yaml"],
					default: "text",
				},
				{
					name: "status",
					type: "string",
					description: "Filter by status (active, archived)",
				},
			],
			output: {
				type: "array",
				schema: {
					project_id: "number",
					slug: "string",
					name: "string",
					status: "string",
					created_at: "string",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json", "jsonl", "yaml"],
		},
		{
			name: "info",
			signature: "hive project info [PROJECT_ID]",
			description: "Get project info (defaults to current context project)",
			parameters: [
				{
					name: "PROJECT_ID",
					type: "string",
					required: false,
					description: "Project slug or ID (defaults to context project)",
				},
			],
			flags: [
				{
					name: "format",
					type: "enum",
					enum: ["text", "json", "yaml"],
					default: "text",
				},
			],
			output: {
				type: "object",
				schema: {
					project_id: "number",
					slug: "string",
					name: "string",
					status: "string",
					worktree_root: "string",
					created_at: "string",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json", "yaml"],
		},
		{
			name: "status",
			signature: "hive project status [PROJECT_ID]",
			description:
				"Show project status summary (bootstrap, last activity, etc.)",
			parameters: [
				{
					name: "PROJECT_ID",
					type: "string",
					required: false,
					description: "Project slug or ID (defaults to context project)",
				},
			],
			flags: [
				{
					name: "format",
					type: "enum",
					enum: ["text", "json"],
					default: "text",
				},
			],
			output: {
				type: "object",
				schema: {
					project_id: "number",
					slug: "string",
					status: "string",
					bootstrap_status: "string",
					proposals_count: "number",
					active_leases: "number",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json"],
		},
	],
};

const projectRecipe: Recipe = {
	id: "project-setup",
	title: "Register and explore a new project",
	when_to_use: "When setting up a new project workspace",
	steps: [
		{
			command:
				"hive project register --name my-project --repo git@gitlab.local:team/my-repo",
			reads: ["project_id"],
			description: "Register a new project",
		},
		{
			command: "hive project list --format json",
			reads: ["projects"],
			description: "List all projects",
		},
		{
			command: "hive project info <project_id> --format json",
			reads: ["project_details"],
			description: "Get project details",
		},
	],
	terminal_state: "Project registered and accessible",
};

async function handleList(options: Record<string, unknown>) {
	const client = getControlPlaneClient();
	const filter = options.status
		? { status: String(options.status) }
		: undefined;
	const projects = await client.listProjects(filter);
	return projects;
}

async function handleInfo(
	projectId: string | undefined,
	_options: Record<string, unknown>,
) {
	const client = getControlPlaneClient();

	// If projectId not provided, try to resolve from context
	let project: ProjectRow | null | undefined;
	if (projectId) {
		project = await client.getProject(projectId);
		if (!project) {
			throw Errors.notFound(`Project '${projectId}' not found`, {
				project_id: projectId,
			});
		}
	} else {
		// Try to resolve from CWD context
		project = await client.resolveProjectFromCwd();
		if (!project) {
			throw Errors.notFound(
				"Cannot resolve project context. Specify --project or set HIVE_PROJECT env var.",
				{
					hint: "Set --project flag or HIVE_PROJECT environment variable",
				},
			);
		}
	}

	return project;
}

async function handleStatus(
	projectId: string | undefined,
	_options: Record<string, unknown>,
) {
	const client = getControlPlaneClient();

	let project: ProjectRow | null | undefined;
	if (projectId) {
		project = await client.getProject(projectId);
		if (!project) {
			throw Errors.notFound(`Project '${projectId}' not found`, {
				project_id: projectId,
			});
		}
	} else {
		project = await client.resolveProjectFromCwd();
		if (!project) {
			throw Errors.notFound(
				"Cannot resolve project context. Specify --project or set HIVE_PROJECT env var.",
				{ hint: "Set --project flag or HIVE_PROJECT environment variable" },
			);
		}
	}

	// Query proposal count and active leases in parallel
	const [proposalCountRows, leaseCountRows] = await Promise.all([
		client
			.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count
         FROM roadmap_proposal.proposal
        WHERE project_id = $1::bigint`,
				[project.project_id],
			)
			.catch(() => [{ count: "0" }]),
		client
			.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count
         FROM roadmap_proposal.proposal_lease
        WHERE is_active = true`,
			)
			.catch(() => [{ count: "0" }]),
	]);

	return {
		project_id: project.project_id,
		slug: project.slug,
		status: project.status,
		bootstrap_status: project.bootstrap_status,
		proposals_count: parseInt(proposalCountRows[0]?.count ?? "0", 10),
		active_leases: parseInt(leaseCountRows[0]?.count ?? "0", 10),
	};
}

export function register(program: Command): void {
	registerDomain(domainSchema);
	registerRecipe(projectRecipe);

	const domainCmd = program
		.command(DOMAIN_NAME)
		.description(DOMAIN_DESCRIPTION)
		.addHelpCommand(false);

	// list
	domainCmd
		.command("list")
		.description("List all projects")
		.option("-s, --status <status>", "Filter by status (active, archived)")
		.action(async (options) => {
			const result = await handleList(options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});

	// info
	domainCmd
		.command("info [PROJECT_ID]")
		.description("Get project info (defaults to current context)")
		.action(async (projectId: string | undefined, options) => {
			const result = await handleInfo(projectId, options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});

	// status
	domainCmd
		.command("status [PROJECT_ID]")
		.description("Show project status summary")
		.action(async (projectId: string | undefined, options) => {
			const result = await handleStatus(projectId, options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});
}
