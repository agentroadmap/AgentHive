import type { RoadmapConfig } from "../../../../shared/types/index.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type {
	DocumentCreateArgs,
	DocumentListArgs,
	DocumentSearchArgs,
	DocumentUpdateArgs,
	DocumentViewArgs,
} from "./handlers.ts";
import { DocumentHandlers } from "./handlers.ts";
import { PgDocumentHandlers } from "./pg-handlers.ts";
import {
	documentCreateSchema,
	documentListSchema,
	documentSearchSchema,
	documentUpdateSchema,
	documentViewSchema,
} from "./schemas.ts";

// Postgres schemas for new PG-backed tools
const documentCreatePgSchema = {
	type: "object",
	properties: {
		title: { type: "string", minLength: 1, maxLength: 200 },
		content: { type: "string" },
		doc_type: {
			type: "string",
			enum: ["spec", "decision", "runbook", "adr", "design", "other"],
			description: "Document type classification",
		},
		author: { type: "string", description: "Author agent identity" },
		proposal_id: { type: "string", description: "Optional proposal ID to link this document to" },
	},
	required: ["title", "content"],
	additionalProperties: false,
};

const documentUpdatePgSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 100, description: "Document ID (e.g. doc-1 or 1)" },
		title: { type: "string", minLength: 1, maxLength: 200 },
		content: { type: "string" },
		author: { type: "string", description: "Author identity for this update" },
	},
	required: ["id", "content"],
	additionalProperties: false,
};

const documentListPgSchema = {
	type: "object",
	properties: {
		proposal_id: { type: "string", description: "Filter by proposal ID" },
		doc_type: {
			type: "string",
			enum: ["spec", "decision", "runbook", "adr", "design", "other"],
		},
		limit: { type: "number", minimum: 1, maximum: 200 },
	},
	required: [],
	additionalProperties: false,
};

const documentVersionsSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 100, description: "Document ID (e.g. doc-1 or 1)" },
	},
	required: ["id"],
	additionalProperties: false,
};

const documentDeletePgSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 100, description: "Document ID to soft-delete" },
	},
	required: ["id"],
	additionalProperties: false,
};

export function registerDocumentTools(
	server: McpServer,
	_config?: RoadmapConfig,
): void {
	const handlers = new DocumentHandlers(server);
	const pgHandlers = new PgDocumentHandlers();

	// ─── Filesystem-backed tools (legacy) ────────────────────────────────
	const listDocumentsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_list",
			description:
				"List Roadmap.md documents with optional substring filtering",
			inputSchema: documentListSchema,
		},
		documentListSchema,
		async (input) => handlers.listDocuments(input as DocumentListArgs),
	);

	const viewDocumentTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_view",
			description:
				"View a Roadmap.md document including metadata and markdown content",
			inputSchema: documentViewSchema,
		},
		documentViewSchema,
		async (input) => handlers.viewDocument(input as DocumentViewArgs),
	);

	const createDocumentTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_create",
			description: "Create a Roadmap.md document using the shared ID generator",
			inputSchema: documentCreateSchema,
		},
		documentCreateSchema,
		async (input) => handlers.createDocument(input as DocumentCreateArgs),
	);

	const updateDocumentTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_update",
			description:
				"Update an existing Roadmap.md document's content and optional title",
			inputSchema: documentUpdateSchema,
		},
		documentUpdateSchema,
		async (input) => handlers.updateDocument(input as DocumentUpdateArgs),
	);

	const searchDocumentTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_search",
			description: "Search Roadmap.md documents using the shared fuzzy index",
			inputSchema: documentSearchSchema,
		},
		documentSearchSchema,
		async (input) => handlers.searchDocuments(input as DocumentSearchArgs),
	);

	server.addTool(listDocumentsTool);
	server.addTool(viewDocumentTool);
	server.addTool(createDocumentTool);
	server.addTool(updateDocumentTool);
	server.addTool(searchDocumentTool);

	// ─── Postgres-backed tools (P067) ────────────────────────────────────
	const pgCreateDocTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_pg_create",
			description:
				"Create a versioned document in Postgres with optional proposal link and doc_type. Supports full-text search via tsvector.",
			inputSchema: documentCreatePgSchema,
		},
		documentCreatePgSchema,
		async (input) =>
			pgHandlers.createDocument(input as {
				title: string;
				content: string;
				doc_type?: string;
				author?: string;
				proposal_id?: string;
			}),
	);

	const pgViewDocTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_pg_view",
			description: "View a Postgres-backed document by ID (e.g. doc-1)",
			inputSchema: documentViewSchema,
		},
		documentViewSchema,
		async (input) =>
			pgHandlers.viewDocument(input as { id: string }),
	);

	const pgUpdateDocTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_pg_update",
			description:
				"Update a Postgres document — previous version retained in history. Returns new version number.",
			inputSchema: documentUpdatePgSchema,
		},
		documentUpdatePgSchema,
		async (input) =>
			pgHandlers.updateDocument(input as {
				id: string;
				content: string;
				title?: string;
				author?: string;
			}),
	);

	const pgListDocsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_pg_list",
			description:
				"List Postgres documents with optional filtering by proposal_id or doc_type",
			inputSchema: documentListPgSchema,
		},
		documentListPgSchema,
		async (input) =>
			pgHandlers.listDocuments(input as {
				proposal_id?: string;
				doc_type?: string;
				limit?: number;
			}),
	);

	const pgSearchDocsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_pg_search",
			description:
				"Full-text search on Postgres documents using tsvector/GIN index. Returns ranked results.",
			inputSchema: documentSearchSchema,
		},
		documentSearchSchema,
		async (input) =>
			pgHandlers.searchDocuments(input as { query: string; limit?: number }),
	);

	const pgVersionsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_pg_versions",
			description:
				"List all versions of a Postgres document, showing version history",
			inputSchema: documentVersionsSchema,
		},
		documentVersionsSchema,
		async (input) =>
			pgHandlers.listVersions(input as { id: string }),
	);

	const pgDeleteDocTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "document_pg_delete",
			description:
				"Soft-delete a Postgres document (recoverable for 30 days via deleted_at timestamp)",
			inputSchema: documentDeletePgSchema,
		},
		documentDeletePgSchema,
		async (input) =>
			pgHandlers.deleteDocument(input as { id: string }),
	);

	server.addTool(pgCreateDocTool);
	server.addTool(pgViewDocTool);
	server.addTool(pgUpdateDocTool);
	server.addTool(pgListDocsTool);
	server.addTool(pgSearchDocsTool);
	server.addTool(pgVersionsTool);
	server.addTool(pgDeleteDocTool);
}

export type {
	DocumentCreateArgs,
	DocumentListArgs,
	DocumentSearchArgs,
	DocumentUpdateArgs,
	DocumentViewArgs,
} from "./handlers.ts";
export {
	documentCreateSchema,
	documentListSchema,
	documentSearchSchema,
	documentUpdateSchema,
	documentViewSchema,
} from "./schemas.ts";
