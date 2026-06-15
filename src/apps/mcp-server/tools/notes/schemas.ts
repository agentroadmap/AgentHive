import type { JsonSchema } from "../../validation/validators.ts";

export const noteCreateSchema: JsonSchema = {
	type: "object",
	properties: {
		proposal_id: {
			type: "string",
			description: "The proposal ID to attach the note to",
			maxLength: 50,
		},
		content: {
			type: "string",
			description: "The note content (markdown supported). Must be non-empty; empty or whitespace-only content is rejected (P1371).",
			maxLength: 10000,
		},
		note_type: {
			type: "string",
			description: "Type of note: discussion|review|decision|question|general",
			enum: ["discussion", "review", "decision", "question", "general"],
			default: "general",
		},
		author: {
			type: "string",
			description: "Agent ID of the note author",
			maxLength: 100,
		},
	},
	required: ["proposal_id", "content"],
};

export const noteListSchema: JsonSchema = {
	type: "object",
	properties: {
		proposal_id: {
			type: "string",
			description: "The proposal ID to list notes for",
			maxLength: 50,
		},
		note_type: {
			type: "string",
			description: "Filter by note type",
			enum: ["discussion", "review", "decision", "question", "general"],
		},
		limit: {
			type: "number",
			description: "Maximum number of notes to return",
			minimum: 1,
			maximum: 100,
			default: 20,
		},
	},
	required: ["proposal_id"],
};

export const noteDeleteSchema: JsonSchema = {
	type: "object",
	properties: {
		note_id: {
			type: "number",
			description: "The note ID to delete",
		},
		proposal_id: {
			type: "string",
			description: "The proposal ID the note belongs to",
			maxLength: 50,
		},
	},
	required: ["note_id"],
};

export const noteDisplaySchema: JsonSchema = {
	type: "object",
	properties: {
		proposal_id: {
			type: "string",
			description: "The proposal ID to display notes for",
			maxLength: 50,
		},
		note_type: {
			type: "string",
			description: "Filter by note type",
			enum: ["discussion", "review", "decision", "question", "general"],
		},
	},
	required: ["proposal_id"],
};
