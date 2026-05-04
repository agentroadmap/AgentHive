/**
 * Agency domain: workforce team management.
 *
 * Commands:
 * - hive agency list [--format text|json|yaml]
 * - hive agency info AGENCY_ID [--format text|json|yaml]
 *
 * Implements cli-hive-contract.md §1 (agency domain, read-only).
 */

import type { Command } from "commander";
import {
	type DomainSchema,
	Errors,
	getControlPlaneClient,
	registerDomain,
} from "../../common/index";

const DOMAIN_NAME = "agency";
const DOMAIN_DESCRIPTION = "Workforce team (agency) management";

const domainSchema: DomainSchema = {
	name: DOMAIN_NAME,
	aliases: [],
	description: DOMAIN_DESCRIPTION,
	subcommands: [
		{
			name: "list",
			signature: "hive agency list",
			description: "List all agencies",
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
					description: "Filter by status",
				},
			],
			output: {
				type: "array",
				schema: {
					agency_id: "string",
					display_name: "string",
					status: "string",
					registered_at: "string",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json", "jsonl", "yaml"],
		},
		{
			name: "info",
			signature: "hive agency info AGENCY_ID",
			description: "Get agency info",
			parameters: [
				{
					name: "AGENCY_ID",
					type: "string",
					required: true,
					description:
						"Agency ID (e.g., hermes/agency-example; format: provider/agency-name)",
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
					agency_id: "string",
					display_name: "string",
					status: "string",
					registered_at: "string",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json", "yaml"],
		},
	],
};

async function handleList(options: Record<string, unknown>) {
	const client = getControlPlaneClient();
	const filter = options.status
		? { status: String(options.status) }
		: undefined;
	// Note: listAgencies requires a projectId; for now, pass a dummy value
	// (per contract §5, agency is control-plane-only today, not project-scoped)
	const agencies = await client.listAgencies(0, filter);
	return agencies;
}

async function handleInfo(agencyId: string, _options: Record<string, unknown>) {
	const client = getControlPlaneClient();
	const agencies = await client.listAgencies(0);
	const agency = agencies.find((a) => a.agency_id === agencyId);

	if (!agency) {
		throw Errors.notFound(`Agency '${agencyId}' not found`, {
			agency_id: agencyId,
		});
	}

	return agency;
}

export function register(program: Command): void {
	registerDomain(domainSchema);

	const domainCmd = program
		.command(DOMAIN_NAME)
		.description(DOMAIN_DESCRIPTION)
		.addHelpCommand(false);

	domainCmd
		.command("list")
		.description("List all agencies")
		.option("-s, --status <status>", "Filter by status")
		.action(async (options) => {
			const result = await handleList(options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});

	domainCmd
		.command("info <AGENCY_ID>")
		.description("Get agency info")
		.action(async (agencyId: string, options) => {
			const result = await handleInfo(agencyId, options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});
}
