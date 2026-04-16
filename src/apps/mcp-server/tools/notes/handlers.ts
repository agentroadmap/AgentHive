import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

type NoteType = "discussion" | "review" | "decision" | "question" | "general";

type ProposalIdRow = { id: number };

type DiscussionRow = {
	id: number;
	author_identity: string;
	body: string;
	context_prefix: string | null;
	created_at: string | Date;
};

const NOTE_TYPE_TO_CONTEXT: Record<NoteType, string> = {
	discussion: "general:",
	review: "feedback:",
	decision: "arch:",
	question: "concern:",
	general: "general:",
};

const CONTEXT_TO_NOTE_TYPE: Array<{ prefix: string; type: NoteType }> = [
	{ prefix: "feedback:", type: "review" },
	{ prefix: "arch:", type: "decision" },
	{ prefix: "concern:", type: "question" },
	{ prefix: "general:", type: "discussion" },
];

const NOTE_ICONS: Record<NoteType, string> = {
	discussion: "💬",
	review: "🔍",
	decision: "✅",
	question: "❓",
	general: "📝",
};

function errorResult(message: string, error: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${message}: ${error instanceof Error ? error.message : String(error)}`,
			},
		],
	};
}

function inferNoteType(contextPrefix: string | null): NoteType {
	if (!contextPrefix) {
		return "general";
	}

	const match = CONTEXT_TO_NOTE_TYPE.find((entry) =>
		contextPrefix.startsWith(entry.prefix),
	);
	return match?.type ?? "general";
}

function formatTimestamp(value: string | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export class NoteHandlers {
	private async resolveProposalRowId(
		proposalId: string,
	): Promise<number | null> {
		const { rows } = await query<ProposalIdRow>(
			`SELECT id
			 FROM roadmap_proposal.proposal
			 WHERE display_id = $1 OR CAST(id AS text) = $1
			 LIMIT 1`,
			[proposalId],
		);

		return rows[0]?.id ?? null;
	}

	async createNote(args: {
		proposal_id: string;
		content: string;
		note_type?: string;
		author?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalRowId = await this.resolveProposalRowId(args.proposal_id);
			if (!proposalRowId) {
				return {
					content: [
						{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
					],
				};
			}

			const author = args.author || "system";
			const noteType = (args.note_type as NoteType | undefined) ?? "general";
			const contextPrefix =
				NOTE_TYPE_TO_CONTEXT[noteType] ?? NOTE_TYPE_TO_CONTEXT.general;
			const { rows } = await query<{ id: number }>(
				`INSERT INTO roadmap_proposal.proposal_discussions (proposal_id, author_identity, body, context_prefix)
				 VALUES ($1, $2, $3, $4)
				 RETURNING id`,
				[proposalRowId, author, args.content, contextPrefix],
			);

			return {
				content: [
					{
						type: "text",
						text: `✅ Discussion #${rows[0]?.id ?? "?"} created on ${args.proposal_id} (${noteType}) by ${author}`,
					},
				],
			};
		} catch (error) {
			return errorResult("Failed to create discussion", error);
		}
	}

	async listNotes(args: {
		proposal_id: string;
		note_type?: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const proposalRowId = await this.resolveProposalRowId(args.proposal_id);
			if (!proposalRowId) {
				return {
					content: [
						{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
					],
				};
			}

			const params: Array<number | string> = [proposalRowId];
			let sql = `SELECT id, author_identity, body, context_prefix, created_at
			           FROM roadmap_proposal.proposal_discussions
			           WHERE proposal_id = $1`;

			if (args.note_type) {
				params.push(
					NOTE_TYPE_TO_CONTEXT[(args.note_type as NoteType) ?? "general"] ??
						NOTE_TYPE_TO_CONTEXT.general,
				);
				sql += ` AND context_prefix = $${params.length}`;
			}

			params.push(args.limit || 20);
			sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

			const { rows } = await query<DiscussionRow>(sql, params);
			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: `📝 No discussions found for ${args.proposal_id}`,
						},
					],
				};
			}

			const lines = rows.map((note) => {
				const noteType = inferNoteType(note.context_prefix);
				return `${NOTE_ICONS[noteType]} **[${noteType}]** ${note.author_identity}: ${note.body}`;
			});

			return {
				content: [
					{
						type: "text",
						text: `## 💬 Discussions for ${args.proposal_id} (${rows.length})\n\n${lines.join("\n")}`,
					},
				],
			};
		} catch (error) {
			return errorResult("Failed to list discussions", error);
		}
	}

	async deleteNote(args: {
		note_id: number;
		proposal_id?: string;
	}): Promise<CallToolResult> {
		try {
			const { rowCount } = await query(
				`DELETE FROM roadmap_proposal.proposal_discussions
				 WHERE id = $1`,
				[args.note_id],
			);

			if (!rowCount) {
				return {
					content: [{ type: "text", text: `Note ${args.note_id} not found.` }],
				};
			}

			return {
				content: [
					{ type: "text", text: `✅ Discussion ${args.note_id} deleted` },
				],
			};
		} catch (error) {
			return errorResult("Failed to delete discussion", error);
		}
	}

	async displayNotes(args: {
		proposal_id: string;
		note_type?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalRowId = await this.resolveProposalRowId(args.proposal_id);
			if (!proposalRowId) {
				return {
					content: [
						{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
					],
				};
			}

			const params: Array<number | string> = [proposalRowId];
			let sql = `SELECT id, author_identity, body, context_prefix, created_at
			           FROM roadmap_proposal.proposal_discussions
			           WHERE proposal_id = $1`;

			if (args.note_type) {
				params.push(
					NOTE_TYPE_TO_CONTEXT[(args.note_type as NoteType) ?? "general"] ??
						NOTE_TYPE_TO_CONTEXT.general,
				);
				sql += ` AND context_prefix = $${params.length}`;
			}

			sql += ` ORDER BY created_at DESC`;

			const { rows } = await query<DiscussionRow>(sql, params);
			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: `📝 No discussion notes for ${args.proposal_id}`,
						},
					],
				};
			}

			const lines = [
				`## 💬 Discussion: ${args.proposal_id} (${rows.length} notes)\n`,
			];
			for (const note of rows) {
				const noteType = inferNoteType(note.context_prefix);
				lines.push(
					`${NOTE_ICONS[noteType]} **[${noteType.toUpperCase()}]** ${note.author_identity} — ${formatTimestamp(note.created_at)}`,
				);
				lines.push(`${note.body}\n`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			return errorResult("Failed to display notes", error);
		}
	}
}
