import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type {
	DirectiveAddArgs,
	DirectiveArchiveArgs,
	DirectiveRemoveArgs,
	DirectiveRenameArgs,
} from "./handlers.ts";
import { DirectiveHandlers } from "./handlers.ts";
import {
	directiveAddSchema,
	directiveArchiveSchema,
	directiveListSchema,
	directiveRemoveSchema,
	directiveRenameSchema,
} from "./schemas.ts";

export function registerMilestoneTools(server: McpServer): void {
	const handlers = new DirectiveHandlers(server);

	const listTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "directive_list",
			description:
				"List directives from directive files and proposal-only directive values found on local proposals",
			inputSchema: directiveListSchema,
		},
		directiveListSchema,
		async () => handlers.listDirectives(),
	);

	const addTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "directive_add",
			description: "Add a directive by creating a directive file",
			inputSchema: directiveAddSchema,
		},
		directiveAddSchema,
		async (input) => handlers.addDirective(input as DirectiveAddArgs),
	);

	const renameTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "directive_rename",
			description:
				"Rename a directive file and optionally update local proposals",
			inputSchema: directiveRenameSchema,
		},
		directiveRenameSchema,
		async (input) => handlers.renameDirective(input as DirectiveRenameArgs),
	);

	const removeTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "directive_remove",
			description:
				"Remove an active directive file and optionally clear/reassign proposals",
			inputSchema: directiveRemoveSchema,
		},
		directiveRemoveSchema,
		async (input) => handlers.removeDirective(input as DirectiveRemoveArgs),
	);

	const archiveTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "directive_archive",
			description:
				"Archive a directive by moving it to roadmap/archive/directives",
			inputSchema: directiveArchiveSchema,
		},
		directiveArchiveSchema,
		async (input) => handlers.archiveDirective(input as DirectiveArchiveArgs),
	);

	server.addTool(listTool);
	server.addTool(addTool);
	server.addTool(renameTool);
	server.addTool(removeTool);
	server.addTool(archiveTool);
}
