/**
 * Budget domain: project and agency spend cap management.
 *
 * Commands:
 * - hive budget show [--format text|json|yaml]
 * - hive budget consumed [--format text|json|yaml]
 *
 * Implements cli-hive-contract.md §1 (budget domain, read-only).
 */

import type { Command } from "commander";
import {
	type DomainSchema,
	Errors,
	getControlPlaneClient,
	registerDomain,
	resolveContext,
} from "../../common/index";

const DOMAIN_NAME = "budget";
const DOMAIN_DESCRIPTION = "Project and agency spend cap management";

const domainSchema: DomainSchema = {
	name: DOMAIN_NAME,
	aliases: [],
	description: DOMAIN_DESCRIPTION,
	subcommands: [
		{
			name: "show",
			signature: "hive budget show",
			description: "Show budget cap and current consumption",
			flags: [
				{
					name: "format",
					type: "enum",
					enum: ["text", "json"],
					default: "text",
				},
				{
					name: "scope",
					type: "enum",
					enum: ["project", "agency", "global"],
					default: "project",
					description: "Budget scope (project, agency, or global)",
				},
			],
			output: {
				type: "object",
				schema: {
					scope: "string",
					cap_usd: "number",
					consumed_usd: "number",
					remaining_usd: "number",
					percent_used: "number",
					period: "string",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json"],
		},
		{
			name: "consumed",
			signature: "hive budget consumed",
			description: "Show detailed spend breakdown",
			flags: [
				{
					name: "format",
					type: "enum",
					enum: ["text", "json", "jsonl"],
					default: "text",
				},
				{
					name: "period",
					type: "string",
					description: "Time period (e.g., 2026-04 for April 2026)",
				},
			],
			output: {
				type: "array",
				schema: {
					category: "string",
					amount_usd: "number",
					count: "number",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json", "jsonl"],
		},
	],
};

async function handleShow(options: Record<string, unknown>) {
	const client = getControlPlaneClient();
	const ctx = await resolveContext(options);
	const scope = options.scope ?? "project";

	if (!ctx.project && scope === "project") {
		throw Errors.notFound("Cannot resolve project context for budget show.", {
			hint: "Set --project flag or HIVE_PROJECT environment variable",
		});
	}

	// getBudgetStatus accepts a numeric project_id; without one, returns global budget
	const budget = await client.getBudgetStatus(undefined);
	return budget;
}

async function handleConsumed(options: Record<string, unknown>) {
	const client = getControlPlaneClient();

	const budget = await client.getBudgetStatus(undefined);
	return budget.caps ?? [];
}

export function register(program: Command): void {
	registerDomain(domainSchema);

	const domainCmd = program
		.command(DOMAIN_NAME)
		.description(DOMAIN_DESCRIPTION)
		.addHelpCommand(false);

	domainCmd
		.command("show")
		.description("Show budget cap and consumption")
		.option(
			"-s, --scope <scope>",
			"Budget scope (project, agency, global)",
			"project",
		)
		.action(async (options) => {
			const result = await handleShow(options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});

	domainCmd
		.command("consumed")
		.description("Show detailed spend breakdown")
		.option("-p, --period <period>", "Time period (YYYY-MM)")
		.action(async (options) => {
			const result = await handleConsumed(options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});
}
