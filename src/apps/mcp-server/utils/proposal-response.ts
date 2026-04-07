import { formatProposalPlainText } from "../../../formatters/proposal-plain-text.ts";
import type { Proposal } from "../../../shared/types/index.ts";
import type { CallToolResult } from "../types.ts";

export async function formatProposalCallResult(
	proposal: Proposal,
	summaryLines: string[] = [],
	options: Parameters<typeof formatProposalPlainText>[1] = {},
): Promise<CallToolResult> {
	const formattedProposal = formatProposalPlainText(proposal, options);
	const summary = summaryLines
		.filter((line) => line.trim().length > 0)
		.join("\n");
	const text = summary
		? `${summary}\n\n${formattedProposal}`
		: formattedProposal;

	return {
		content: [
			{
				type: "text",
				text,
			},
		],
	};
}
