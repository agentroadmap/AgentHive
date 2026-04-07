export function normalizeAssignee(proposal: {
	assignee?: string | string[];
}): void {
	if (typeof proposal.assignee === "string") {
		proposal.assignee = [proposal.assignee];
	} else if (!Array.isArray(proposal.assignee)) {
		proposal.assignee = [];
	}
}
