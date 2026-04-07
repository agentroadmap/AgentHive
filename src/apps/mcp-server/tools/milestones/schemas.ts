import type { JsonSchema } from "../../validation/validators.ts";

export const directiveListSchema: JsonSchema = {
	type: "object",
	properties: {},
	required: [],
	additionalProperties: false,
};

export const directiveAddSchema: JsonSchema = {
	type: "object",
	properties: {
		name: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description:
				"Directive name/title (trimmed; case-insensitive uniqueness)",
		},
		description: {
			type: "string",
			maxLength: 2000,
			description: "Optional description for the directive",
		},
	},
	required: ["name"],
	additionalProperties: false,
};

export const directiveRenameSchema: JsonSchema = {
	type: "object",
	properties: {
		from: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "Existing directive name (case-insensitive match)",
		},
		to: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "New directive name (trimmed; case-insensitive uniqueness)",
		},
		updateProposals: {
			type: "boolean",
			description:
				"Whether to update local proposals that reference the directive (default: true)",
			default: true,
		},
	},
	required: ["from", "to"],
	additionalProperties: false,
};

export const directiveRemoveSchema: JsonSchema = {
	type: "object",
	properties: {
		name: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "Directive name to remove (case-insensitive match)",
		},
		proposalHandling: {
			type: "string",
			enum: ["clear", "keep", "reassign"],
			description:
				"What to do with local proposals currently set to this directive: clear (default), keep, or reassign",
			default: "clear",
		},
		reassignTo: {
			type: "string",
			maxLength: 100,
			description:
				"Target directive name when proposalHandling is reassign (must exist as an active directive file)",
		},
	},
	required: ["name"],
	additionalProperties: false,
};

export const directiveArchiveSchema: JsonSchema = {
	type: "object",
	properties: {
		name: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "Directive name or ID to archive (case-insensitive match)",
		},
	},
	required: ["name"],
	additionalProperties: false,
};
