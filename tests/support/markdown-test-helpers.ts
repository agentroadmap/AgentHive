/**
 * Helper functions for parsing markdown responses in MCP tests
 */

/**
 * Parse sequence create markdown response into structured data
 */
export function parseSequenceCreateMarkdown(markdown: string) {
	const lines = markdown.split("\n");

	// Extract metadata from Summary table
	const metadata: Record<string, string | number | boolean | null> = {};
	let inSummaryTable = false;

	for (const line of lines) {
		if (line.trim() === "## Summary") {
			inSummaryTable = true;
			continue;
		}
		if (inSummaryTable && line.startsWith("| ") && !line.includes("Metric")) {
			const match = line.match(/\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
			if (match) {
				const [, key, value] = match;
				if (!key || !value) continue;
				// Convert values to appropriate types
				if (value === "true" || value === "false") {
					metadata[key] = value === "true";
				} else if (!Number.isNaN(Number(value))) {
					metadata[key] = Number(value);
				} else if (value === "null") {
					metadata[key] = null;
				} else {
					metadata[key] = value;
				}
			}
		}
		if (inSummaryTable && line.startsWith("## ") && line !== "## Summary") {
			inSummaryTable = false;
		}
	}

	// Extract sequences
	const sequences: Array<{
		index: number;
		proposals: Array<{ id: string; title: string; status: string }>;
	}> = [];
	interface SequenceType {
		index: number;
		proposals: Array<{ id: string; title: string; status: string }>;
	}
	let currentSequence: SequenceType | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		// Match sequence headers like "### Sequence 1"
		const sequenceMatch = line.match(/^### Sequence (\d+)$/);
		if (sequenceMatch) {
			if (currentSequence) {
				sequences.push(currentSequence);
			}
			const indexStr = sequenceMatch[1];
			if (!indexStr) continue;
			currentSequence = {
				index: Number.parseInt(indexStr, 10),
				proposals: [],
			};
			continue;
		}

		// Match proposal lines like "- **proposal-1** - Foundation Proposal (Potential)"
		if (currentSequence && line.match(/^- \*\*(.+?)\*\* - (.+?) \((.+?)\)$/)) {
			const proposalMatch = line.match(/^- \*\*(.+?)\*\* - (.+?) \((.+?)\)$/);
			if (proposalMatch) {
				const [, id, title, status] = proposalMatch;
				if (id && title && status) {
					currentSequence.proposals.push({ id, title, status });
				}
			}
		}
	}

	if (currentSequence) {
		sequences.push(currentSequence);
	}

	// Extract unsequenced proposals
	const unsequenced: Array<{ id: string; title: string; status: string }> = [];
	let inUnsequenced = false;

	for (const line of lines) {
		if (line.trim() === "## Unsequenced Proposals") {
			inUnsequenced = true;
			continue;
		}
		if (inUnsequenced && line.match(/^- \*\*(.+?)\*\* - (.+?) \((.+?)\)$/)) {
			const proposalMatch = line.match(/^- \*\*(.+?)\*\* - (.+?) \((.+?)\)$/);
			if (proposalMatch) {
				const [, id, title, status] = proposalMatch;
				if (id && title && status) {
					unsequenced.push({ id, title, status });
				}
			}
		}
		if (
			inUnsequenced &&
			line &&
			line.startsWith("## ") &&
			line !== "## Unsequenced Proposals"
		) {
			inUnsequenced = false;
		}
	}

	return {
		sequences,
		unsequenced,
		metadata: {
			totalProposals: metadata["Total Proposals"] || 0,
			filteredProposals: metadata["Filtered Proposals"] || 0,
			sequenceCount: metadata.Sequences || 0,
			unsequencedCount: metadata["Unsequenced Proposals"] || 0,
			includeCompleted: metadata["Include Completed"] || false,
			filterStatus: metadata["Filter Status"] || null,
		},
	};
}

/**
 * Parse sequence plan markdown response into structured data
 */
export function parseSequencePlanMarkdown(markdown: string) {
	const lines = markdown.split("\n");

	// Extract summary metadata
	const summary: Record<string, string | number> = {};
	let inSummaryTable = false;

	for (const line of lines) {
		if (line.trim() === "## Summary") {
			inSummaryTable = true;
			continue;
		}
		if (inSummaryTable && line.startsWith("| ") && !line.includes("Metric")) {
			const match = line.match(/\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
			if (match) {
				const [, key, value] = match;
				if (!key || !value) continue;
				summary[key] = !Number.isNaN(Number(value)) ? Number(value) : value;
			}
		}
		if (inSummaryTable && line.startsWith("## ") && line !== "## Summary") {
			inSummaryTable = false;
		}
	}

	// Extract phases
	const phases: Array<{
		phase: number;
		name: string;
		proposals: Array<{
			id: string;
			title: string;
			status: string;
			assignee?: string[];
			dependencies?: string[];
		}>;
		dependsOn?: number[];
	}> = [];

	interface PhaseType {
		phase: number;
		name: string;
		proposals: Array<{
			id: string;
			title: string;
			status: string;
			assignee?: string[];
			dependencies?: string[];
		}>;
		dependsOn?: number[];
	}
	let currentPhase: PhaseType | null = null;
	let inPhaseProposals = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		// Match phase headers like "### Phase 1: Sequence 1"
		const phaseMatch = line.match(/^### Phase (\d+): (.+)$/);
		if (phaseMatch) {
			if (currentPhase) {
				phases.push(currentPhase);
			}
			const phaseNum = phaseMatch[1];
			const phaseName = phaseMatch[2];
			if (!phaseNum || !phaseName) continue;
			currentPhase = {
				phase: Number.parseInt(phaseNum, 10),
				name: phaseName,
				proposals: [],
				dependsOn: [],
			};
			inPhaseProposals = false;
			continue;
		}

		// Match dependency lines like "**Depends on:** Phase 1"
		if (currentPhase && line.match(/^\*\*Depends on:\*\* (.+)$/)) {
			const dependsMatch = line.match(/^\*\*Depends on:\*\* Phase (.+)$/);
			if (dependsMatch?.[1]) {
				const deps = dependsMatch[1]
					.split(", Phase ")
					.map((n) => Number.parseInt(n, 10));
				currentPhase.dependsOn = deps;
			}
		}

		// Mark when we enter the proposals section
		if (currentPhase && line && line.trim() === "**Proposals:**") {
			inPhaseProposals = true;
			continue;
		}

		// Match proposal lines like "- **proposal-1** - Foundation Proposal (Potential)"
		if (
			currentPhase &&
			inPhaseProposals &&
			line &&
			line.match(/^- \*\*(.+?)\*\* - (.+?) \((.+?)\)(.*)$/)
		) {
			const proposalMatch = line.match(
				/^- \*\*(.+?)\*\* - (.+?) \((.+?)\)(.*)$/,
			);
			if (proposalMatch) {
				const [, id, title, status, extra] = proposalMatch;
				if (!id || !title || !status) continue;
				const proposal: {
					id: string;
					title: string;
					status: string;
					assignee?: string[];
					dependencies?: string[];
				} = {
					id,
					title,
					status,
				};

				// Parse assignee if present
				if (extra) {
					const assigneeMatch = extra.match(/\((.+?)\)/);
					if (assigneeMatch?.[1]) {
						proposal.assignee = assigneeMatch[1].split(", ");
					}
				}

				currentPhase.proposals.push(proposal);
			}
		}

		// Check for dependency lines
		if (
			currentPhase &&
			inPhaseProposals &&
			line &&
			line.match(/^\s+- Dependencies: (.+)$/)
		) {
			const depMatch = line.match(/^\s+- Dependencies: (.+)$/);
			if (depMatch?.[1] && currentPhase.proposals.length > 0) {
				const lastProposal =
					currentPhase.proposals[currentPhase.proposals.length - 1];
				if (lastProposal) {
					lastProposal.dependencies = depMatch[1].split(", ");
				}
			}
		}
	}

	if (currentPhase) {
		phases.push(currentPhase);
	}

	// Extract unsequenced proposals
	const unsequenced: Array<{
		id: string;
		title: string;
		status: string;
		reason: string;
	}> = [];
	let inUnsequenced = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		if (line.trim() === "## Unsequenced Proposals") {
			inUnsequenced = true;
			continue;
		}
		if (inUnsequenced && line.match(/^- \*\*(.+?)\*\* - (.+?) \((.+?)\)$/)) {
			const proposalMatch = line.match(/^- \*\*(.+?)\*\* - (.+?) \((.+?)\)$/);
			if (proposalMatch) {
				const [, id, title, status] = proposalMatch;
				if (!id || !title || !status) continue;
				const nextLine = lines[i + 1];
				let reason = "";
				if (nextLine?.match(/^\s+- (.+)$/)) {
					const reasonMatch = nextLine.match(/^\s+- (.+)$/);
					if (reasonMatch?.[1]) {
						reason = reasonMatch[1];
					}
				}
				unsequenced.push({ id, title, status, reason });
			}
		}
		if (
			inUnsequenced &&
			line &&
			line.startsWith("## ") &&
			line !== "## Unsequenced Proposals"
		) {
			inUnsequenced = false;
		}
	}

	return {
		phases,
		unsequenced,
		summary: {
			totalPhases: summary["Total Phases"] || 0,
			totalProposalsInPlan: summary["Proposals in Plan"] || 0,
			unsequencedProposals: summary["Unsequenced Proposals"] || 0,
			canStartImmediately: summary["Can Start Immediately"] || 0,
		},
	};
}

/**
 * Parse project overview markdown response into structured data
 */
export function parseProjectOverviewMarkdown(markdown: string) {
	const lines = markdown.split("\n");

	// Extract statistics from Project Statistics table
	const statistics: Record<string, string | number> = {};
	let inProjectStats = false;

	// Extract status counts from Status Breakdown table
	const statusCounts: Record<string, number> = {};
	let inStatusBreakdown = false;

	// Extract priority counts from Priority Breakdown table
	const priorityCounts: Record<string, number> = {};
	let inPriorityBreakdown = false;

	// Extract recent activity and project health data
	const recentActivity = { created: [], updated: [] };
	const projectHealth = {
		averageProposalAge: 0,
		staleProposals: [],
		blockedProposals: [],
	};

	for (const line of lines) {
		// Project Statistics section
		if (line.trim() === "## Project Statistics") {
			inProjectStats = true;
			inStatusBreakdown = false;
			inPriorityBreakdown = false;
			continue;
		}

		// Status Breakdown section
		if (line.trim() === "## Status Breakdown") {
			inProjectStats = false;
			inStatusBreakdown = true;
			inPriorityBreakdown = false;
			continue;
		}

		// Priority Breakdown section
		if (line.trim() === "## Priority Breakdown") {
			inProjectStats = false;
			inStatusBreakdown = false;
			inPriorityBreakdown = true;
			continue;
		}

		// Reset flags on other sections
		if (
			line.startsWith("## ") &&
			![
				"## Project Statistics",
				"## Status Breakdown",
				"## Priority Breakdown",
			].includes(line.trim())
		) {
			inProjectStats = false;
			inStatusBreakdown = false;
			inPriorityBreakdown = false;
		}

		// Parse table rows
		if (
			line.startsWith("| ") &&
			!line.includes("Metric") &&
			!line.includes("Status") &&
			!line.includes("Priority") &&
			!line.includes("-----")
		) {
			const match = line.match(/\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
			if (match) {
				const [, key, value] = match;
				if (!key || !value) continue;

				if (inProjectStats) {
					// Convert values to appropriate types for project statistics
					if (key === "Completion Rate") {
						statistics[key] = Number.parseInt(value.replace("%", ""), 10);
					} else if (!Number.isNaN(Number(value))) {
						statistics[key] = Number(value);
					} else {
						statistics[key] = value;
					}
				} else if (inStatusBreakdown) {
					statusCounts[key] = Number.parseInt(value, 10) || 0;
				} else if (inPriorityBreakdown) {
					priorityCounts[key] = Number.parseInt(value, 10) || 0;
				}
			}
		}
	}

	return {
		success: true,
		statistics: {
			statusCounts,
			priorityCounts,
			totalProposals: statistics["Total Proposals"] || 0,
			completedProposals: statistics["Completed Proposals"] || 0,
			completionPercentage: statistics["Completion Rate"] || 0,
			draftCount: statistics["Draft Proposals"] || 0,
			recentActivity,
			projectHealth,
		},
	};
}

/**
 * Parse config markdown response into structured data
 */
export function parseConfigMarkdown(markdown: string): unknown {
	const lines = markdown.split("\n");

	// Check if this is a single config value
	let configKey: string | null = null;
	let inJsonBlock = false;
	const jsonContent: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;

		// Match config key like "**projectName:**"
		const keyMatch = line.match(/^\*\*(.+?):\*\*$/);
		if (keyMatch?.[1]) {
			configKey = keyMatch[1];
			continue;
		}

		// Check for JSON code block
		if (line === "```json") {
			inJsonBlock = true;
			continue;
		}

		if (line === "```") {
			inJsonBlock = false;
			// Parse the JSON content
			const jsonStr = jsonContent.join("\n");
			try {
				return JSON.parse(jsonStr);
			} catch {
				return jsonStr;
			}
		}

		if (inJsonBlock) {
			const rawLine = lines[i];
			if (rawLine !== undefined) {
				jsonContent.push(rawLine); // Don't trim - preserve formatting
			}
			continue;
		}

		// Match single value like "`Test Project`"
		const valueMatch = line.match(/^`(.+)`$/);
		if (valueMatch && configKey) {
			const value = valueMatch[1];
			// Handle special values
			if (value === "null") return null;
			if (value === "true") return true;
			if (value === "false") return false;
			if (!Number.isNaN(Number(value)) && value !== "") return Number(value);
			return value;
		}
	}

	// If no specific pattern found, try to parse as full config object
	// Look for the config table format: | Setting | Value |
	const config: Record<string, unknown> = {};

	for (const line of lines) {
		// Match table rows: | projectName | `Test Project` |
		const tableMatch = line.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+?)`\s*\|$/);
		if (tableMatch) {
			const [, key, value] = tableMatch;
			if (!key || !value) continue;
			const cleanKey = key.trim();
			let parsedValue: unknown = value;

			// Parse array format: [Potential, Active, Complete]
			if (value.startsWith("[") && value.endsWith("]")) {
				const arrayContent = value.slice(1, -1).trim();
				if (arrayContent) {
					parsedValue = arrayContent.split(",").map((v) => v.trim());
				} else {
					parsedValue = [];
				}
			} else if (value === "null") {
				parsedValue = null;
			} else if (value === "true") {
				parsedValue = true;
			} else if (value === "false") {
				parsedValue = false;
			} else if (!Number.isNaN(Number(value)) && value !== "") {
				parsedValue = Number(value);
			}

			config[cleanKey] = parsedValue;
		}

		// Also handle the key-value format for single configs
		const keyMatch = line.match(/^\*\*(.+?):\*\*$/);
		if (keyMatch && keyMatch[1] !== undefined) {
			const key = keyMatch[1];
			// Look for the value in the next non-empty line
			const nextLineIndex = lines.findIndex(
				(l, i) => i > lines.indexOf(line) && l.trim().length > 0,
			);
			if (nextLineIndex !== -1) {
				const valueLine = lines[nextLineIndex];
				if (valueLine) {
					const valueMatch = valueLine.match(/^`(.+)`$/);
					if (valueMatch && valueMatch[1] !== undefined) {
						const value = valueMatch[1];
						if (value === "null") config[key] = null;
						else if (value === "true") config[key] = true;
						else if (value === "false") config[key] = false;
						else if (!Number.isNaN(Number(value)) && value !== "")
							config[key] = Number(value);
						else config[key] = value;
					}
				}
			}
		}
	}

	return Object.keys(config).length > 0 ? config : markdown;
}
