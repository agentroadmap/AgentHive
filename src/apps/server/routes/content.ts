/**
 * routes/content.ts — document, decision, draft, and directive HTTP routes
 * extracted from `RoadmapServer` (P3796 monolith decomposition, Phase 2, AC-18).
 *
 * Each handler is a standalone async function taking a `ServerContext`.
 * `handleContentRoutes` is the dispatch entry point: it returns a
 * `Promise<Response>` when it owns the route, or `null` to let the caller fall
 * through to its remaining routing.
 *
 * Covered routes:
 *   GET/POST /api/docs        GET /api/doc/:id    GET/PUT /api/docs/:id
 *   GET/POST /api/decisions   GET /api/decision/:id  GET/PUT /api/decisions/:id
 *   GET /api/drafts           POST /api/drafts/:id/promote
 *   GET/POST /api/directives  GET /api/directives/archived
 *   GET /api/directives/:id   POST /api/directives/:id/archive
 */
import type { ServerContext } from "../server-context.ts";

// ── Documents ────────────────────────────────────────────────────────────────

export async function handleListDocs(ctx: ServerContext): Promise<Response> {
	try {
		const store = await ctx.getContentStore();
		const docs = store.getDocuments();
		const docFiles = docs.map((doc) => ({
			name: `${doc.title}.md`,
			id: doc.id,
			title: doc.title,
			type: doc.type,
			createdDate: doc.createdDate,
			updatedDate: doc.updatedDate,
			lastModified: doc.updatedDate || doc.createdDate,
			tags: doc.tags || [],
		}));
		return Response.json(docFiles);
	} catch (error) {
		console.error("Error listing documents:", error);
		return Response.json([]);
	}
}

export async function handleGetDoc(
	ctx: ServerContext,
	docId: string,
): Promise<Response> {
	try {
		const doc = await ctx.core.getDocument(docId);
		if (!doc) {
			return Response.json({ error: "Document not found" }, { status: 404 });
		}
		return Response.json(doc);
	} catch (error) {
		console.error("Error loading document:", error);
		return Response.json({ error: "Document not found" }, { status: 404 });
	}
}

export async function handleCreateDoc(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	const { filename, content } = await req.json();

	try {
		const title = filename.replace(".md", "");
		const document = await ctx.core.createDocumentWithId(title, content);
		return Response.json({ success: true, id: document.id }, { status: 201 });
	} catch (error) {
		console.error("Error creating document:", error);
		return Response.json(
			{ error: "Failed to create document" },
			{ status: 500 },
		);
	}
}

export async function handleUpdateDoc(
	ctx: ServerContext,
	req: Request,
	docId: string,
): Promise<Response> {
	try {
		const body = await req.json();
		const content =
			typeof body?.content === "string" ? body.content : undefined;
		const title = typeof body?.title === "string" ? body.title : undefined;

		if (typeof content !== "string") {
			return Response.json(
				{ error: "Document content is required" },
				{ status: 400 },
			);
		}

		let normalizedTitle: string | undefined;

		if (typeof title === "string") {
			normalizedTitle = title.trim();
			if (normalizedTitle.length === 0) {
				return Response.json(
					{ error: "Document title cannot be empty" },
					{ status: 400 },
				);
			}
		}

		const existingDoc = await ctx.core.getDocument(docId);
		if (!existingDoc) {
			return Response.json({ error: "Document not found" }, { status: 404 });
		}

		const nextDoc = normalizedTitle
			? { ...existingDoc, title: normalizedTitle }
			: { ...existingDoc };

		await ctx.core.updateDocument(nextDoc, content);
		return Response.json({ success: true });
	} catch (error) {
		console.error("Error updating document:", error);
		if (error instanceof SyntaxError) {
			return Response.json(
				{ error: "Invalid request payload" },
				{ status: 400 },
			);
		}
		return Response.json(
			{ error: "Failed to update document" },
			{ status: 500 },
		);
	}
}

// ── Decisions ────────────────────────────────────────────────────────────────

export async function handleListDecisions(
	ctx: ServerContext,
): Promise<Response> {
	try {
		const store = await ctx.getContentStore();
		const decisions = store.getDecisions();
		const decisionFiles = decisions.map((decision) => ({
			id: decision.id,
			title: decision.title,
			status: decision.status,
			date: decision.date,
			context: decision.context,
			decision: decision.decision,
			consequences: decision.consequences,
			alternatives: decision.alternatives,
		}));
		return Response.json(decisionFiles);
	} catch (error) {
		console.error("Error listing decisions:", error);
		return Response.json([]);
	}
}

export async function handleGetDecision(
	ctx: ServerContext,
	decisionId: string,
): Promise<Response> {
	try {
		const store = await ctx.getContentStore();
		const normalizedId = decisionId.startsWith("decision-")
			? decisionId
			: `decision-${decisionId}`;
		const decision = store
			.getDecisions()
			.find((item) => item.id === normalizedId || item.id === decisionId);

		if (!decision) {
			return Response.json({ error: "Decision not found" }, { status: 404 });
		}

		return Response.json(decision);
	} catch (error) {
		console.error("Error loading decision:", error);
		return Response.json({ error: "Decision not found" }, { status: 404 });
	}
}

export async function handleCreateDecision(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	const { title } = await req.json();

	try {
		const decision = await ctx.core.createDecisionWithTitle(title);
		return Response.json(decision, { status: 201 });
	} catch (error) {
		console.error("Error creating decision:", error);
		return Response.json(
			{ error: "Failed to create decision" },
			{ status: 500 },
		);
	}
}

export async function handleUpdateDecision(
	ctx: ServerContext,
	req: Request,
	decisionId: string,
): Promise<Response> {
	const content = await req.text();

	try {
		await ctx.core.updateDecisionFromContent(decisionId, content);
		return Response.json({ success: true });
	} catch (error) {
		if (error instanceof Error && error.message.includes("not found")) {
			return Response.json({ error: "Decision not found" }, { status: 404 });
		}
		console.error("Error updating decision:", error);
		return Response.json(
			{ error: "Failed to update decision" },
			{ status: 500 },
		);
	}
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export async function handleListDrafts(ctx: ServerContext): Promise<Response> {
	try {
		const drafts = await ctx.core.filesystem.listDrafts();
		return Response.json(drafts);
	} catch (error) {
		console.error("Error listing drafts:", error);
		return Response.json([]);
	}
}

export async function handlePromoteDraft(
	ctx: ServerContext,
	draftId: string,
): Promise<Response> {
	try {
		const success = await ctx.core.promoteDraft(draftId);
		if (!success) {
			return Response.json({ error: "Draft not found" }, { status: 404 });
		}
		return Response.json({ success: true });
	} catch (error) {
		console.error("Error promoting draft:", error);
		return Response.json(
			{ error: "Failed to promote draft" },
			{ status: 500 },
		);
	}
}

// ── Directives ───────────────────────────────────────────────────────────────

export async function handleListDirectives(
	ctx: ServerContext,
): Promise<Response> {
	try {
		const directives = await ctx.core.fs.listDirectives();
		return Response.json(directives);
	} catch (error) {
		console.error("Error listing directives:", error);
		return Response.json([]);
	}
}

export async function handleListArchivedDirectives(
	ctx: ServerContext,
): Promise<Response> {
	try {
		const directives = await ctx.core.filesystem.listArchivedDirectives();
		return Response.json(directives);
	} catch (error) {
		console.error("Error listing archived directives:", error);
		return Response.json([]);
	}
}

export async function handleGetDirective(
	ctx: ServerContext,
	directiveId: string,
): Promise<Response> {
	try {
		const directive = await ctx.core.filesystem.loadDirective(directiveId);
		if (!directive) {
			return Response.json({ error: "Directive not found" }, { status: 404 });
		}
		return Response.json(directive);
	} catch (error) {
		console.error("Error loading directive:", error);
		return Response.json({ error: "Directive not found" }, { status: 404 });
	}
}

export async function handleCreateDirective(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	try {
		const body = (await req.json()) as {
			title?: string;
			description?: string;
		};
		const title = body.title?.trim();

		if (!title) {
			return Response.json(
				{ error: "Directive title is required" },
				{ status: 400 },
			);
		}

		// Check for duplicates
		const existingDirectives = await ctx.core.filesystem.listDirectives();
		const buildAliasKeys = (value: string): Set<string> => {
			const normalized = value.trim().toLowerCase();
			const keys = new Set<string>();
			if (!normalized) {
				return keys;
			}
			keys.add(normalized);
			if (/^\d+$/.test(normalized)) {
				const numeric = String(Number.parseInt(normalized, 10));
				keys.add(numeric);
				keys.add(`d-${numeric}`);
				return keys;
			}
			const match = normalized.match(/^d-(\d+)$/);
			if (match?.[1]) {
				const numeric = String(Number.parseInt(match[1], 10));
				keys.add(numeric);
				keys.add(`d-${numeric}`);
			}
			return keys;
		};
		const requestedKeys = buildAliasKeys(title);
		const duplicate = existingDirectives.find((directive) => {
			const directiveKeys = new Set<string>([
				...buildAliasKeys(directive.id),
				...buildAliasKeys(directive.title),
			]);
			for (const key of requestedKeys) {
				if (directiveKeys.has(key)) {
					return true;
				}
			}
			return false;
		});
		if (duplicate) {
			return Response.json(
				{ error: "A directive with this title or ID already exists" },
				{ status: 400 },
			);
		}

		const directive = await ctx.core.filesystem.createDirective(
			title,
			body.description,
		);
		return Response.json(directive, { status: 201 });
	} catch (error) {
		console.error("Error creating directive:", error);
		return Response.json(
			{ error: "Failed to create directive" },
			{ status: 500 },
		);
	}
}

export async function handleArchiveDirective(
	ctx: ServerContext,
	directiveId: string,
): Promise<Response> {
	try {
		const result = await ctx.core.archiveDirective(directiveId);
		if (!result.success) {
			return Response.json({ error: "Directive not found" }, { status: 404 });
		}
		ctx.broadcastProposalsUpdated();
		return Response.json({
			success: true,
			directive: result.directive ?? null,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to archive directive";
		console.error("Error archiving directive:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

// ── Dispatch entry point ──────────────────────────────────────────────────────

/**
 * Dispatch document/decision/draft/directive routes. Returns a
 * `Promise<Response>` when owned, else `null`. Preserves the original inline
 * ordering in `dispatchRequest`.
 */
export function handleContentRoutes(
	ctx: ServerContext,
	method: string,
	pathname: string,
	req: Request,
): Promise<Response> | null {
	if (pathname === "/api/docs") {
		if (method === "GET") return handleListDocs(ctx);
		if (method === "POST") return handleCreateDoc(ctx, req);
	}

	if (pathname.startsWith("/api/doc/")) {
		const id = pathname.slice("/api/doc/".length);
		if (method === "GET") return handleGetDoc(ctx, id);
	}

	if (pathname.startsWith("/api/docs/")) {
		const id = pathname.split("/")[3]!;
		if (method === "GET") return handleGetDoc(ctx, id);
		if (method === "PUT") return handleUpdateDoc(ctx, req, id);
	}

	if (pathname === "/api/decisions") {
		if (method === "GET") return handleListDecisions(ctx);
		if (method === "POST") return handleCreateDecision(ctx, req);
	}

	if (pathname.startsWith("/api/decision/")) {
		const id = pathname.slice("/api/decision/".length);
		if (method === "GET") return handleGetDecision(ctx, id);
	}

	if (pathname.startsWith("/api/decisions/")) {
		const id = pathname.split("/")[3]!;
		if (method === "GET") return handleGetDecision(ctx, id);
		if (method === "PUT") return handleUpdateDecision(ctx, req, id);
	}

	if (pathname === "/api/drafts" && method === "GET")
		return handleListDrafts(ctx);
	if (
		pathname.startsWith("/api/drafts/") &&
		pathname.endsWith("/promote") &&
		method === "POST"
	) {
		const id = pathname.split("/")[3]!;
		return handlePromoteDraft(ctx, id);
	}

	if (pathname === "/api/directives") {
		if (method === "GET") return handleListDirectives(ctx);
		if (method === "POST") return handleCreateDirective(ctx, req);
	}

	if (pathname === "/api/directives/archived" && method === "GET")
		return handleListArchivedDirectives(ctx);

	if (pathname.startsWith("/api/directives/")) {
		const parts = pathname.split("/");
		const id = parts[3]!;
		if (parts.length === 4) {
			if (method === "GET") return handleGetDirective(ctx, id);
		}
		if (parts.length === 5 && parts[4] === "archive") {
			if (method === "POST") return handleArchiveDirective(ctx, id);
		}
	}

	return null;
}
