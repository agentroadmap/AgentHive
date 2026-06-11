import type { CallToolResult } from "../types.ts";
import type { ToolContract } from "./contract.ts";

/**
 * Generates help/schema response for a tool.
 * Returned via action=help requests.
 */
export function generateHelpResponse(contract: ToolContract): CallToolResult {
	const helpContent = {
		tool_name: contract.name,
		description: contract.description,
		args_schema: contract.argsSchema,
		sample_call: contract.sampleCall || { /* no sample available */ },
		aliases: (contract.aliases || []).map((a) => ({
			deprecated: a.deprecated,
			canonical: a.canonical,
			removedAt: a.removedAt || null,
		})),
		persistence_level: contract.persistence,
		common_errors: contract.commonErrors || [],
	};

	const markdown = formatHelpMarkdown(contract);

	return {
		content: [
			{
				type: "text",
				text: markdown,
			},
		],
		structuredContent: helpContent,
	};
}

/**
 * Formats help content as markdown for readability.
 */
function formatHelpMarkdown(contract: ToolContract): string {
	let md = `# ${contract.name}\n\n`;
	md += `${contract.description}\n\n`;

	md += `## Input Schema\n\`\`\`json\n`;
	md += JSON.stringify(contract.argsSchema, null, 2);
	md += `\n\`\`\`\n\n`;

	if (contract.sampleCall) {
		md += `## Sample Call\n\`\`\`json\n`;
		md += JSON.stringify(contract.sampleCall, null, 2);
		md += `\n\`\`\`\n\n`;
	}

	if (contract.aliases && contract.aliases.length > 0) {
		md += `## Deprecated Aliases\n`;
		for (const alias of contract.aliases) {
			md += `- \`${alias.deprecated}\` → \`${alias.canonical}\``;
			if (alias.removedAt) {
				md += ` (removing on ${alias.removedAt})`;
			}
			md += "\n";
		}
		md += "\n";
	}

	if (contract.commonErrors && contract.commonErrors.length > 0) {
		md += `## Common Errors\n`;
		for (const err of contract.commonErrors) {
			md += `- **${err.code}**: ${err.message}`;
			if (err.example) {
				md += `\n  Example: ${err.example}`;
			}
			md += "\n";
		}
		md += "\n";
	}

	md += `## Persistence Level\n`;
	md += `This tool declares persistence level: \`${contract.persistence}\`\n`;

	return md;
}
