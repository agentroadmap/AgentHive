import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { NoteHandlers } from "./handlers.ts";
import {
	noteCreateSchema,
	noteDeleteSchema,
	noteDisplaySchema,
	noteListSchema,
} from "./schemas.ts";

export function registerNoteTools(
	server: McpServer,
	projectRoot = process.cwd(),
): void {
	const handlers = new NoteHandlers();

	const createTool = createSimpleValidatedTool(
		{
			name: "create_note",
			description:
				"Create a note/discussion/review attached to a proposal. Supports markdown content and multiple note types (discussion, review, decision, question, general).",
			inputSchema: noteCreateSchema,
		},
		noteCreateSchema,
		async (args) =>
			handlers.createNote(
				args as {
					proposal_id: string;
					content: string;
					note_type?: string;
					author?: string;
				},
			),
	);

	const listTool = createSimpleValidatedTool(
		{
			name: "note_list",
			description:
				"List all notes attached to a proposal. Can filter by note type.",
			inputSchema: noteListSchema,
		},
		noteListSchema,
		async (args) =>
			handlers.listNotes(
				args as { proposal_id: string; note_type?: string; limit?: number },
			),
	);

	const deleteTool = createSimpleValidatedTool(
		{
			name: "delete_note",
			description: "Delete a note by ID.",
			inputSchema: noteDeleteSchema,
		},
		noteDeleteSchema,
		async (args) =>
			handlers.deleteNote(args as { note_id: number; proposal_id?: string }),
	);

	const displayTool = createSimpleValidatedTool(
		{
			name: "note_display",
			description:
				"Display full discussion notes for a proposal with formatted content. Shows note type, author, timestamp, and full body text.",
			inputSchema: noteDisplaySchema,
		},
		noteDisplaySchema,
		async (args) =>
			handlers.displayNotes(
				args as { proposal_id: string; note_type?: string },
			),
	);

	server.addTool(createTool);
	server.addTool(listTool);
	server.addTool(deleteTool);
	server.addTool(displayTool);
}
