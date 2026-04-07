// Merge Status Detection for Board Display
// Checks if proposal's changes are in main branch

import { execSync } from "node:child_process";

export function checkMergeStatus(
	proposalId: string,
): "merged" | "pending" | "merging" | "conflict" | "unknown" {
	try {
		// Check if any commit in worktree branches mentions this proposal
		const result = execSync(`
      for pool in engineering testing copilot gemini openclaw xiaomi; do
        if git log pool/$pool --oneline --all --grep="${proposalId}" 2>/dev/null | head -1 | grep -q .; then
          # Found mention - check if in main
          if git log main --oneline --all --grep="${proposalId}" 2>/dev/null | head -1 | grep -q .; then
            echo "merged"
          else
            echo "pending"
          fi
          exit 0
        fi
      done
      echo "unknown"
    `)
			.toString()
			.trim();

		return result as "merged" | "pending" | "merging" | "unknown";
	} catch {
		return "unknown";
	}
}

// Color mapping for merge status
export function getMergeStatusColor(status: string): string {
	switch (status) {
		case "merged":
			return "{green-fg}"; // Green = in main
		case "pending":
			return "{yellow-fg}"; // Yellow = waiting
		case "merging":
			return "{cyan-fg}"; // Cyan = in progress
		case "conflict":
			return "{red-fg}"; // Red = problem
		default:
			return "{gray-fg}"; // Gray = unknown
	}
}

// Get merge status suffix for display
export function getMergeStatusSuffix(proposalId: string): string {
	const status = checkMergeStatus(proposalId);
	switch (status) {
		case "merged":
			return " {green-fg}(merged){/}";
		case "pending":
			return " {yellow-fg}(pending){/}";
		case "merging":
			return " {cyan-fg}(merging...){/}";
		case "conflict":
			return " {red-fg}(conflict){/}";
		default:
			return " {gray-fg}(merge: ?){/}";
	}
}
