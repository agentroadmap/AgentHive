/**
 * MCP Tool Schemas for Proposal Dependencies
 */

export const addDependencySchema = {
	type: "object",
	properties: {
		fromProposalId: {
			type: "string",
			description: "The proposal ID that depends on another",
		},
		toProposalId: {
			type: "string",
			description: "The proposal ID being depended on",
		},
		dependencyType: {
			type: "string",
			enum: ["blocks", "relates", "duplicates"],
			description: "Type of dependency relationship (default: blocks)",
		},
		notes: {
			type: "string",
			description: "Optional notes about the dependency",
		},
	},
	required: ["fromProposalId", "toProposalId"],
};

export const getDependenciesSchema = {
	type: "object",
	properties: {
		fromProposalId: {
			type: "string",
			description: "Filter by source proposal ID",
		},
		toProposalId: {
			type: "string",
			description: "Filter by target proposal ID",
		},
		dependencyType: {
			type: "string",
			enum: ["blocks", "relates", "duplicates"],
			description: "Filter by dependency type",
		},
		resolved: {
			type: "boolean",
			description: "Filter by resolved status",
		},
	},
};

export const resolveDependencySchema = {
	type: "object",
	properties: {
		id: {
			type: "number",
			description: "The dependency ID to resolve",
		},
		resolved: {
			type: "boolean",
			description: "Whether the dependency is resolved",
		},
		notes: {
			type: "string",
			description: "Optional resolution notes",
		},
	},
	required: ["id", "resolved"],
};

export const checkCycleSchema = {
	type: "object",
	properties: {
		fromProposalId: {
			type: "string",
			description: "The proposal ID that would depend on another",
		},
		toProposalId: {
			type: "string",
			description: "The proposal ID that would be depended on",
		},
	},
	required: ["fromProposalId", "toProposalId"],
};

export const removeDependencySchema = {
	type: "object",
	properties: {
		id: {
			type: "number",
			description: "The dependency ID to remove",
		},
	},
	required: ["id"],
};

export const canPromoteSchema = {
	type: "object",
	properties: {
		proposalId: {
			type: "string",
			description: "The proposal ID to check for promotion eligibility",
		},
	},
	required: ["proposalId"],
};
