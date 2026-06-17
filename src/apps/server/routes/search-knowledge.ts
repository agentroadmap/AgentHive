/**
 * routes/search-knowledge.ts — search and knowledge-entry HTTP routes
 * extracted from `RoadmapServer` (P3796 monolith decomposition, Phase 1, AC-13).
 *
 * Covered routes:
 *   GET  /api/search
 *   GET  /api/knowledge
 *   POST /api/knowledge/:id/helpful
 */
import { query } from "../../../infra/postgres/pool.ts";
import type {
	SearchPriorityFilter,
	SearchResultType,
} from "../../../types/index.ts";
import type { ServerContext } from "../server-context.ts";

// ── Search ───────────────────────────────────────────────────────────────────

export async function handleSearch(
	req: Request,
	ctx: ServerContext,
): Promise<Response> {
	try {
		const searchService = ctx.searchService;
		if (!searchService) {
			return Response.json({ error: "Search service not ready" }, { status: 503 });
		}

		const url = new URL(req.url);
		const queryParam = url.searchParams.get("query") ?? undefined;
		const limitParam = url.searchParams.get("limit");
		const typeParams = [
			...url.searchParams.getAll("type"),
			...url.searchParams.getAll("types"),
		];
		const statusParams = url.searchParams.getAll("status");
		const priorityParamsRaw = url.searchParams.getAll("priority");
		const labelParamsRaw = [
			...url.searchParams.getAll("label"),
			...url.searchParams.getAll("labels"),
		];
		const labelsCsv = url.searchParams.get("labels");
		if (labelsCsv) {
			labelParamsRaw.push(...labelsCsv.split(","));
		}

		let limit: number | undefined;
		if (limitParam) {
			const parsed = Number.parseInt(limitParam, 10);
			if (Number.isNaN(parsed) || parsed <= 0) {
				return Response.json(
					{ error: "limit must be a positive integer" },
					{ status: 400 },
				);
			}
			limit = parsed;
		}

		let types: SearchResultType[] | undefined;
		if (typeParams.length > 0) {
			const allowed: SearchResultType[] = [
				"proposal",
				"document",
				"decision",
			];
			const normalizedTypes = typeParams
				.map((value) => value.toLowerCase())
				.filter((value): value is SearchResultType => {
					return allowed.includes(value as SearchResultType);
				});
			if (normalizedTypes.length === 0) {
				return Response.json(
					{ error: "type must be proposal, document, or decision" },
					{ status: 400 },
				);
			}
			types = normalizedTypes;
		}

		const filters: {
			status?: string | string[];
			priority?: SearchPriorityFilter | SearchPriorityFilter[];
			labels?: string | string[];
		} = {};

		if (statusParams.length === 1) {
			filters.status = statusParams[0];
		} else if (statusParams.length > 1) {
			filters.status = statusParams;
		}

		if (priorityParamsRaw.length > 0) {
			const allowedPriorities: SearchPriorityFilter[] = [
				"high",
				"medium",
				"low",
			];
			const normalizedPriorities = priorityParamsRaw.map((value) =>
				value.toLowerCase(),
			);
			const invalidPriority = normalizedPriorities.find(
				(value) => !allowedPriorities.includes(value as SearchPriorityFilter),
			);
			if (invalidPriority) {
				return Response.json(
					{
						error: `Unsupported priority '${invalidPriority}'. Use high, medium, or low.`,
					},
					{ status: 400 },
				);
			}
			const casted = normalizedPriorities as SearchPriorityFilter[];
			filters.priority = casted.length === 1 ? casted[0] : casted;
		}

		if (labelParamsRaw.length > 0) {
			const normalizedLabels = labelParamsRaw
				.map((value) => value.trim())
				.filter((value) => value.length > 0);
			if (normalizedLabels.length > 0) {
				filters.labels =
					normalizedLabels.length === 1
						? normalizedLabels[0]
						: normalizedLabels;
			}
		}

		const results = searchService.search({ query: queryParam, limit, types, filters });
		return Response.json(results);
	} catch (error) {
		console.error("Error performing search:", error);
		return Response.json({ error: "Search failed" }, { status: 500 });
	}
}

// ── Knowledge entries ────────────────────────────────────────────────────────

export async function handleListKnowledge(
	req: Request,
	_ctx: ServerContext,
): Promise<Response> {
	try {
		const url = new URL(req.url);
		const queryParam = url.searchParams.get("query") ?? "";
		const typeParam = url.searchParams.get("type") ?? "";

		let sql = `
			SELECT
				id, type, content, keywords,
				source_proposal_id AS source,
				helpful_count, created_at
			FROM roadmap.knowledge_entries
			WHERE 1=1
		`;
		const params: unknown[] = [];
		let idx = 1;

		if (queryParam) {
			sql += ` AND (content ILIKE $${idx} OR keywords::text ILIKE $${idx} OR title ILIKE $${idx})`;
			params.push(`%${queryParam}%`);
			idx++;
		}
		if (typeParam) {
			sql += ` AND type = $${idx}`;
			params.push(typeParam);
			idx++;
		}
		sql += ` ORDER BY helpful_count DESC, created_at DESC LIMIT 100`;

		const { rows } = await query(sql, params);
		return Response.json(
			(rows ?? []).map((row: Record<string, unknown>) => ({
				...row,
				keywords: Array.isArray(row.keywords) ? row.keywords : [],
			})),
		);
	} catch (error) {
		console.error("Error listing knowledge entries:", error);
		return Response.json(
			{ error: "Failed to list knowledge entries" },
			{ status: 500 },
		);
	}
}

export async function handleMarkKnowledgeHelpful(
	id: string,
	_ctx: ServerContext,
): Promise<Response> {
	try {
		await query(
			`UPDATE roadmap.knowledge_entries
			    SET helpful_count = helpful_count + 1, updated_at = now()
			  WHERE id = $1`,
			[id],
		);
		return Response.json({ ok: true });
	} catch (error) {
		console.error("Error marking knowledge helpful:", error);
		return Response.json(
			{ error: "Failed to mark as helpful" },
			{ status: 500 },
		);
	}
}

/**
 * Dispatch entry point. Returns a Response when it owns the route, or null to
 * fall through to the remaining inline routing in index.ts.
 */
export async function routeSearchKnowledgeRequest(
	req: Request,
	ctx: ServerContext,
): Promise<Response | null> {
	const url = new URL(req.url);
	const { pathname, method } = { pathname: url.pathname, method: req.method };

	if (pathname === "/api/search" && method === "GET")
		return handleSearch(req, ctx);

	if (pathname === "/api/knowledge" && method === "GET")
		return handleListKnowledge(req, ctx);

	if (
		pathname.startsWith("/api/knowledge/") &&
		pathname.endsWith("/helpful") &&
		method === "POST"
	) {
		const id = pathname.split("/")[3]!;
		return handleMarkKnowledgeHelpful(id, ctx);
	}

	return null;
}
