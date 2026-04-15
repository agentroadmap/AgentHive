import { DEFAULT_STATUSES } from "../../../constants/index.ts";
import type { RoadmapConfig } from "../../../shared/types/index.ts";
import type { JsonSchema } from "../validation/validators.ts";

/**
 * Generates a status field schema with dynamic enum values sourced from config.
 */
export function generateStatusFieldSchema(config: RoadmapConfig): JsonSchema {
	const configuredStatuses =
		config.statuses && config.statuses.length > 0
			? [...config.statuses]
			: [...DEFAULT_STATUSES];
	const normalizedStatuses = configuredStatuses.map((status) => status.trim());
	const hasDraft = normalizedStatuses.some(
		(status) => status.toLowerCase() === "draft",
	);
	const enumStatuses = hasDraft
		? normalizedStatuses
		: ["Draft", ...normalizedStatuses];
	const defaultStatus = normalizedStatuses[0] ?? DEFAULT_STATUSES[0];

	return {
		type: "string",
		maxLength: 100,
		enum: enumStatuses,
		enumCaseInsensitive: true,
		enumNormalizeWhitespace: true,
		default: defaultStatus,
		description: `Status value (case-insensitive). Valid values: ${enumStatuses.join(", ")}`,
	};
}

/**
 * Generates the proposal_create input schema with dynamic status enum
 */
export function generateProposalCreateSchema(
	config: RoadmapConfig,
): JsonSchema {
	return {
		type: "object",
		properties: {
			title: {
				type: "string",
				minLength: 1,
				maxLength: 200,
			},
			description: {
				type: "string",
				maxLength: 10000,
			},
			status: generateStatusFieldSchema(config),
			priority: {
				type: "string",
				enum: ["high", "medium", "low"],
			},
			directive: {
				type: "string",
				minLength: 1,
				maxLength: 100,
				description: "Optional directive label (trimmed).",
			},
			labels: {
				type: "array",
				items: {
					type: "string",
					maxLength: 50,
				},
			},
			assignee: {
				type: "array",
				items: {
					type: "string",
					maxLength: 100,
				},
			},
			builder: {
				type: "string",
				maxLength: 100,
				description: "The agent primarily responsible for implementation",
			},
			auditor: {
				type: "string",
				maxLength: 100,
				description: "The agent responsible for peer review and audit",
			},
			maturity: {
				type: "string",
				enum: ["new", "active", "mature", "obsolete"],
				description: "Maturity within current state (new → active → mature → obsolete)",
			},
			dependencies: {
				type: "array",
				items: {
					type: "string",
					maxLength: 50,
				},
			},
			references: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				description: "Reference URLs or file paths related to this proposal",
			},
			documentation: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				description:
					"Documentation URLs or file paths for understanding this proposal",
			},
			finalSummary: {
				type: "string",
				maxLength: 20000,
				description:
					"Final summary for PR-style completion notes. Write this only when the proposal is complete.",
			},
			acceptanceCriteria: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
			},
			parentProposalId: {
				type: "string",
				maxLength: 50,
			},
			rationale: {
				type: "string",
				maxLength: 1000,
				description:
					"The rationale or nature of the proposal (e.g. 'external' constraint, 'decision' consequence)",
			},
		},
		required: ["title"],
		additionalProperties: false,
	};
}

/**
 * Generates the proposal_edit input schema with dynamic status enum and MCP-specific operations.
 */
export function generateProposalEditSchema(config: RoadmapConfig): JsonSchema {
	return {
		type: "object",
		properties: {
			id: {
				type: "string",
				minLength: 1,
				maxLength: 50,
			},
			title: {
				type: "string",
				maxLength: 200,
			},
			description: {
				type: "string",
				maxLength: 10000,
			},
			status: generateStatusFieldSchema(config),
			priority: {
				type: "string",
				enum: ["high", "medium", "low"],
			},
			directive: {
				type: "string",
				minLength: 1,
				maxLength: 100,
				description: "Set directive label (string) or clear it (null).",
			},
			labels: {
				type: "array",
				items: {
					type: "string",
					maxLength: 50,
				},
			},
			assignee: {
				type: "array",
				items: {
					type: "string",
					maxLength: 100,
				},
			},
			builder: {
				type: "string",
				maxLength: 100,
				description: "The agent primarily responsible for implementation",
			},
			auditor: {
				type: "string",
				maxLength: 100,
				description: "The agent responsible for peer review and audit",
			},
			auditNotes: {
				type: "string",
				maxLength: 5000,
				description: "Peer auditor findings and certification rationale",
			},
			maturity: {
				type: "string",
				enum: ["new", "active", "mature", "obsolete"],
				description: "Maturity within current state (new → active → mature → obsolete)",
			},
			dependencies: {
				type: "array",
				items: {
					type: "string",
					maxLength: 50,
				},
			},
			references: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				description: "Set reference URLs or file paths (replaces existing)",
			},
			addReferences: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				description: "Add reference URLs or file paths",
			},
			removeReferences: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				description: "Remove reference URLs or file paths",
			},
			documentation: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				description: "Set documentation URLs or file paths (replaces existing)",
			},
			addDocumentation: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				description: "Add documentation URLs or file paths",
			},
			removeDocumentation: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				description: "Remove documentation URLs or file paths",
			},
			implementationNotes: {
				type: "string",
				maxLength: 10000,
			},
			finalSummary: {
				type: "string",
				maxLength: 20000,
				description:
					"Final summary for PR-style completion notes. Write this only when the proposal is complete.",
			},
			finalSummaryAppend: {
				type: "array",
				items: {
					type: "string",
					maxLength: 5000,
				},
				maxItems: 20,
			},
			finalSummaryClear: {
				type: "boolean",
			},
			notesSet: {
				type: "string",
				maxLength: 20000,
			},
			notesAppend: {
				type: "array",
				items: {
					type: "string",
					maxLength: 5000,
				},
				maxItems: 20,
			},
			notesClear: {
				type: "boolean",
			},
			auditNotesAppend: {
				type: "array",
				items: {
					type: "string",
					maxLength: 5000,
				},
				maxItems: 20,
			},
			auditNotesClear: {
				type: "boolean",
			},
			planSet: {
				type: "string",
				maxLength: 20000,
			},
			planAppend: {
				type: "array",
				items: {
					type: "string",
					maxLength: 5000,
				},
				maxItems: 20,
			},
			planClear: {
				type: "boolean",
			},
			acceptanceCriteriaSet: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				maxItems: 50,
			},
			acceptanceCriteriaAdd: {
				type: "array",
				items: {
					type: "string",
					maxLength: 500,
				},
				maxItems: 50,
			},
			acceptanceCriteriaRemove: {
				type: "array",
				items: {
					type: "number",
					minimum: 1,
				},
				maxItems: 50,
			},
			acceptanceCriteriaCheck: {
				type: "array",
				items: {
					type: "number",
					minimum: 1,
				},
				maxItems: 50,
			},
			acceptanceCriteriaUncheck: {
				type: "array",
				items: {
					type: "number",
					minimum: 1,
				},
				maxItems: 50,
			},
			rationale: {
				type: "string",
				maxLength: 1000,
				description:
					"The rationale or nature of the proposal (e.g. 'external' constraint, 'decision' consequence)",
			},
		},
		required: ["id"],
		additionalProperties: false,
	};
}
