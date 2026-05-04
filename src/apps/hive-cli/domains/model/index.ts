/**
 * Model domain: LLM model catalog and routing.
 *
 * Commands:
 * - hive model list [--format text|json|yaml]
 * - hive model info MODEL_ID [--format text|json|yaml]
 * - hive model cost [--format text|json|yaml]
 *
 * Implements cli-hive-contract.md §1 (model domain, read-only).
 */

import type { Command } from "commander";
import {
	type DomainSchema,
	Errors,
	getControlPlaneClient,
	registerDomain,
} from "../../common/index";

const DOMAIN_NAME = "model";
const DOMAIN_DESCRIPTION = "LLM model catalog and routing";

const domainSchema: DomainSchema = {
	name: DOMAIN_NAME,
	aliases: [],
	description: DOMAIN_DESCRIPTION,
	subcommands: [
		{
			name: "list",
			signature: "hive model list",
			description: "List all available LLM models",
			flags: [
				{
					name: "format",
					type: "enum",
					enum: ["text", "json", "jsonl", "yaml"],
					default: "text",
				},
				{
					name: "provider",
					type: "string",
					description: "Filter by provider",
				},
			],
			output: {
				type: "array",
				schema: {
					model_id: "string",
					name: "string",
					provider: "string",
					status: "string",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json", "jsonl", "yaml"],
		},
		{
			name: "info",
			signature: "hive model info MODEL_ID",
			description: "Get model details",
			parameters: [
				{
					name: "MODEL_ID",
					type: "string",
					required: true,
					description: "Model ID",
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
					model_id: "string",
					name: "string",
					provider: "string",
					status: "string",
					cost_per_million_tokens: "number",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json", "yaml"],
		},
		{
			name: "cost",
			signature: "hive model cost",
			description: "Show model pricing summary",
			flags: [
				{
					name: "format",
					type: "enum",
					enum: ["text", "json"],
					default: "text",
				},
			],
			output: {
				type: "array",
				schema: {
					model_id: "string",
					provider: "string",
					cost_per_million_tokens: "number",
				},
			},
			idempotency: "idempotent",
			formats_supported: ["text", "json"],
		},
	],
};

async function handleList(options: Record<string, unknown>) {
	const client = getControlPlaneClient();
	const filters: { provider?: string; tier?: string } = {};
	if (typeof options.provider === "string") filters.provider = options.provider;
	if (typeof options.tier === "string") filters.tier = options.tier;
	return client.listModels(
		Object.keys(filters).length > 0 ? filters : undefined,
	);
}

async function handleInfo(modelId: string, _options: Record<string, unknown>) {
	const client = getControlPlaneClient();
	const model = await client.getModel(modelId);
	if (!model) {
		throw Errors.notFound(`Model '${modelId}' not found`, {
			model_id: modelId,
		});
	}
	return model;
}

async function handleCost(_options: Record<string, unknown>) {
	const client = getControlPlaneClient();
	return client.getModelCosts();
}

export function register(program: Command): void {
	registerDomain(domainSchema);

	const domainCmd = program
		.command(DOMAIN_NAME)
		.description(DOMAIN_DESCRIPTION)
		.addHelpCommand(false);

	domainCmd
		.command("list")
		.description("List all available models")
		.option("-p, --provider <provider>", "Filter by provider")
		.action(async (options) => {
			const result = await handleList(options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});

	domainCmd
		.command("info <MODEL_ID>")
		.description("Get model details")
		.action(async (modelId: string, options) => {
			const result = await handleInfo(modelId, options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});

	domainCmd
		.command("cost")
		.description("Show model pricing summary")
		.action(async (options) => {
			const result = await handleCost(options);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		});
}
