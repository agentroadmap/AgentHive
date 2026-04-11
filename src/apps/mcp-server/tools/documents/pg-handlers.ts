/**
 * Postgres-backed Document MCP Tools for AgentHive (P067).
 *
 * Implements versioned documents with full-text search via tsvector/GIN.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

interface DocumentRow {
	id: number;
	proposal_id: number | null;
	title: string;
	content: string;
	doc_type: string;
	author: string;
	version: number;
	created_at: string | Date;
	updated_at: string | Date;
}

interface SearchResultRow extends DocumentRow {
	rank: number;
}

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
	};
}

function formatTimestamp(value: string | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export class PgDocumentHandlers {
	/**
	 * Create a new document (AC-1).
	 */
	async createDocument(args: {
		title: string;
		content: string;
		doc_type?: string;
		author?: string;
		proposal_id?: string;
	}): Promise<CallToolResult> {
		try {
			const author = args.author || "system";
			const docType = args.doc_type || "spec";

			// Validate proposal_id if provided
			let proposalId: number | null = null;
			if (args.proposal_id) {
				const { rows } = await query<{ id: number }>(
					`SELECT id FROM roadmap.proposal WHERE display_id = $1 OR CAST(id AS text) = $1 LIMIT 1`,
					[args.proposal_id],
				);
				if (rows.length === 0) {
					return {
						content: [{ type: "text", text: `Proposal ${args.proposal_id} not found.` }],
					};
				}
				proposalId = rows[0].id;
			}

			// Insert document
			const { rows } = await query<DocumentRow>(
				`INSERT INTO roadmap.documents (title, content, doc_type, author, proposal_id)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING id, title, content, doc_type, author, version, created_at, updated_at, proposal_id`,
				[args.title, args.content, docType, author, proposalId],
			);

			const doc = rows[0];

			// Store initial version
			await query(
				`INSERT INTO roadmap.document_versions (document_id, version, title, content, author)
				 VALUES ($1, $2, $3, $4, $5)`,
				[doc.id, doc.version, doc.title, doc.content, author],
			);

			return {
				content: [
					{
						type: "text",
						text: `Document doc-${doc.id} created successfully.\nTitle: ${doc.title}\nType: ${doc.doc_type}\nAuthor: ${doc.author}\nVersion: ${doc.version}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to create document", err);
		}
	}

	/**
	 * View a document by ID (AC-1).
	 */
	async viewDocument(args: { id: string }): Promise<CallToolResult> {
		try {
			const docId = parseInt(args.id.replace(/^doc-/, ""), 10);
			if (Number.isNaN(docId)) {
				return { content: [{ type: "text", text: `Invalid document ID: ${args.id}` }] };
			}

			const { rows } = await query<DocumentRow>(
				`SELECT id, proposal_id, title, content, doc_type, author, version, created_at, updated_at
				 FROM roadmap.documents
				 WHERE id = $1 AND deleted_at IS NULL`,
				[docId],
			);

			if (rows.length === 0) {
				return { content: [{ type: "text", text: `Document ${args.id} not found.` }] };
			}

			const doc = rows[0];
			const proposalNote = doc.proposal_id ? ` (proposal: ${doc.proposal_id})` : "";

			return {
				content: [
					{
						type: "text",
						text: `# doc-${doc.id}: ${doc.title}${proposalNote}\n\n**Type:** ${doc.doc_type} | **Author:** ${doc.author} | **Version:** ${doc.version}\n**Created:** ${formatTimestamp(doc.created_at)} | **Updated:** ${formatTimestamp(doc.updated_at)}\n\n---\n\n${doc.content}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to view document", err);
		}
	}

	/**
	 * Update a document — creates new version, retains history (AC-2, AC-3).
	 */
	async updateDocument(args: {
		id: string;
		content: string;
		title?: string;
		author?: string;
	}): Promise<CallToolResult> {
		try {
			const docId = parseInt(args.id.replace(/^doc-/, ""), 10);
			if (Number.isNaN(docId)) {
				return { content: [{ type: "text", text: `Invalid document ID: ${args.id}` }] };
			}

			// Fetch current version
			const { rows: current } = await query<DocumentRow>(
				`SELECT id, title, content, doc_type, author, version
				 FROM roadmap.documents
				 WHERE id = $1 AND deleted_at IS NULL`,
				[docId],
			);

			if (current.length === 0) {
				return { content: [{ type: "text", text: `Document ${args.id} not found.` }] };
			}

			const doc = current[0];
			const newVersion = doc.version + 1;
			const author = args.author || doc.author;
			const newTitle = args.title ?? doc.title;

			// Update document
			const { rows: updated } = await query<DocumentRow>(
				`UPDATE roadmap.documents
				 SET content = $1, title = $2, version = $3, author = $4, updated_at = now()
				 WHERE id = $5
				 RETURNING id, title, content, doc_type, author, version, created_at, updated_at`,
				[args.content, newTitle, newVersion, author, docId],
			);

			// Store previous version
			await query(
				`INSERT INTO roadmap.document_versions (document_id, version, title, content, author)
				 VALUES ($1, $2, $3, $4, $5)`,
				[docId, doc.version, doc.title, doc.content, doc.author],
			);

			const u = updated[0];
			return {
				content: [
					{
						type: "text",
						text: `Document doc-${u.id} updated successfully. Version: ${doc.version} → ${u.version}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to update document", err);
		}
	}

	/**
	 * List documents with optional filtering (AC-1).
	 */
	async listDocuments(args: {
		proposal_id?: string;
		doc_type?: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const conditions: string[] = ["deleted_at IS NULL"];
			const params: unknown[] = [];
			let idx = 1;

			if (args.proposal_id) {
				conditions.push(`proposal_id = $${idx}`);
				params.push(args.proposal_id);
				idx++;
			}

			if (args.doc_type) {
				conditions.push(`doc_type = $${idx}`);
				params.push(args.doc_type);
				idx++;
			}

			const limit = args.limit || 50;
			conditions.push(`$${idx} IS NOT NULL`); // dummy for LIMIT param position
			params.push(limit);
			idx++;

			const { rows } = await query<DocumentRow>(
				`SELECT id, proposal_id, title, doc_type, author, version, created_at, updated_at
				 FROM roadmap.documents
				 WHERE ${conditions.join(" AND ")}
				 ORDER BY updated_at DESC
				 LIMIT $${idx - 1}`,
				params,
			);

			if (rows.length === 0) {
				return { content: [{ type: "text", text: "No documents found." }] };
			}

			const lines = rows.map(
				(d) =>
					`  doc-${d.id} - ${d.title} (type: ${d.doc_type}, v${d.version}, author: ${d.author}, updated: ${formatTimestamp(d.updated_at)})`,
			);

			return {
				content: [{ type: "text", text: `Documents:\n${lines.join("\n")}` }],
			};
		} catch (err) {
			return errorResult("Failed to list documents", err);
		}
	}

	/**
	 * Full-text search on documents using tsvector (AC-11, AC-13).
	 */
	async searchDocuments(args: {
		query: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const limit = args.limit || 20;
			const { rows } = await query<SearchResultRow>(
				`SELECT id, proposal_id, title, content, doc_type, author, version, created_at, updated_at,
				        ts_rank_cd(tsvector_col, plainto_tsquery('english', $1)) as rank
				 FROM roadmap.documents
				 WHERE deleted_at IS NULL
				   AND tsvector_col @@ plainto_tsquery('english', $1)
				 ORDER BY rank DESC
				 LIMIT $2`,
				[args.query, limit],
			);

			if (rows.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No documents found for "${args.query}".`,
						},
					],
				};
			}

			const lines = rows.map(
				(d) =>
					`  doc-${d.id} - ${d.title} [score ${d.rank.toFixed(3)}] (${d.doc_type}, v${d.version})`,
			);

			return {
				content: [{ type: "text", text: `Documents:\n${lines.join("\n")}` }],
			};
		} catch (err) {
			return errorResult("Failed to search documents", err);
		}
	}

	/**
	 * List versions of a document (AC-2).
	 */
	async listVersions(args: { id: string }): Promise<CallToolResult> {
		try {
			const docId = parseInt(args.id.replace(/^doc-/, ""), 10);
			if (Number.isNaN(docId)) {
				return { content: [{ type: "text", text: `Invalid document ID: ${args.id}` }] };
			}

			const { rows } = await query<{
				id: number;
				document_id: number;
				version: number;
				title: string;
				author: string;
				created_at: string | Date;
			}>(
				`SELECT id, document_id, version, title, author, created_at
				 FROM roadmap.document_versions
				 WHERE document_id = $1
				 ORDER BY version DESC`,
				[docId],
			);

			if (rows.length === 0) {
				return {
					content: [{ type: "text", text: `No version history found for ${args.id}.` }],
				};
			}

			const lines = rows.map(
				(v) =>
					`  v${v.version}: "${v.title}" by ${v.author} at ${formatTimestamp(v.created_at)}`,
			);

			return {
				content: [
					{
						type: "text",
						text: `## Version History for doc-${docId} (${rows.length} versions)\n\n${lines.join("\n")}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list document versions", err);
		}
	}

	/**
	 * Soft-delete a document (AC-18).
	 */
	async deleteDocument(args: { id: string }): Promise<CallToolResult> {
		try {
			const docId = parseInt(args.id.replace(/^doc-/, ""), 10);
			if (Number.isNaN(docId)) {
				return { content: [{ type: "text", text: `Invalid document ID: ${args.id}` }] };
			}

			const { rowCount } = await query(
				`UPDATE roadmap.documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
				[docId],
			);

			if (rowCount === 0) {
				return { content: [{ type: "text", text: `Document ${args.id} not found or already deleted.` }] };
			}

			return {
				content: [
					{
						type: "text",
						text: `Document doc-${docId} soft-deleted (recoverable for 30 days).`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to delete document", err);
		}
	}
}
