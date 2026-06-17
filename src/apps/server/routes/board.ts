/**
 * routes/board.ts — board stage/column, live-feed, and sequence HTTP routes
 * extracted from `RoadmapServer` (P3796 monolith decomposition, Phase 2, AC-18).
 *
 * Each handler is a standalone async function taking a `ServerContext`.
 * `handleBoardRoutes` is the dispatch entry point: it returns a
 * `Promise<Response>` when it owns the route, or `null` to let the caller fall
 * through to its remaining routing.
 *
 * Covered routes:
 *   GET  /api/board/stages
 *   GET  /api/board/columns
 *   GET  /api/board/live-feed
 *   GET  /api/sequences
 *   POST /api/sequences/move
 */
import { query } from "../../../infra/postgres/pool.ts";
import { loadStageRegistry } from "../../../core/workflow/stage-registry.ts";
import { getRegistry } from "../../../core/workflow/state-names.ts";
import type { ServerContext } from "../server-context.ts";

// ── Board stages / columns ────────────────────────────────────────────────────

export async function handleGetBoardStages(
	_ctx: ServerContext,
	req?: Request,
): Promise<Response> {
	try {
		const url = new URL(req?.url || "http://localhost/?workflow=Standard RFC");
		const workflow = url.searchParams.get("workflow") || "Standard RFC";

		const registry = getRegistry();
		const view = registry.getView(workflow);

		// Load display metadata (displayLabel, hexColor) from the stage-definition table.
		// Falls back gracefully — if the table is empty or a stage has no entry, use
		// the stage name as the display label and null for colour.
		let stageDefMap: Map<string, { displayLabel: string; hexColor: string | null }> = new Map();
		try {
			const raw = await loadStageRegistry();
			for (const [name, def] of raw) {
				stageDefMap.set(name, { displayLabel: def.displayLabel, hexColor: def.hexColor });
			}
		} catch {
			// non-fatal — proceed with name-only labels
		}

		const stages = view.stages.map((stage) => {
			const def = stageDefMap.get(stage.name);
			return {
				id: stage.name,
				stageName: stage.name,
				label: def?.displayLabel ?? stage.name,
				displayLabel: def?.displayLabel ?? stage.name,
				hexColor: def?.hexColor ?? null,
				order: stage.order,
				isTerminal: stage.isTerminal,
			};
		});

		return Response.json({ stages, workflow: view.template });
	} catch (error) {
		const stages = [
			{ id: "DRAFT", stageName: "DRAFT", label: "Draft", displayLabel: "Draft", hexColor: null, order: 1, isTerminal: false },
			{ id: "REVIEW", stageName: "REVIEW", label: "Review", displayLabel: "Review", hexColor: null, order: 2, isTerminal: false },
			{ id: "DEVELOP", stageName: "DEVELOP", label: "Develop", displayLabel: "Develop", hexColor: null, order: 3, isTerminal: false },
			{ id: "MERGE", stageName: "MERGE", label: "Merge", displayLabel: "Merge", hexColor: null, order: 4, isTerminal: false },
			{ id: "COMPLETE", stageName: "COMPLETE", label: "Complete", displayLabel: "Complete", hexColor: null, order: 5, isTerminal: true },
		];
		return Response.json({
			stages,
			workflow: "Standard RFC",
			error: error instanceof Error ? error.message : "Registry not loaded",
		});
	}
}

export async function handleGetBoardColumns(
	_ctx: ServerContext,
	req?: Request,
): Promise<Response> {
	try {
		const url = new URL(req?.url || "http://localhost/?workflowName=Standard+RFC");

		// ?bust=<ts> bypasses cache
		const bust = url.searchParams.get("bust");
		const workflowName = url.searchParams.get("workflowName") || "Standard RFC";

		const registry = getRegistry();
		const view = registry.getView(workflowName);

		let stageDefMap: Map<string, { displayLabel: string; hexColor: string | null; isTerminal: boolean; maturityGate: number | null }> = new Map();
		try {
			const raw = await loadStageRegistry();
			for (const [name, def] of raw) {
				stageDefMap.set(name, {
					displayLabel: def.displayLabel,
					hexColor: def.hexColor,
					isTerminal: def.isTerminal,
					maturityGate: null,
				});
			}
		} catch {
			// non-fatal — proceed with name-only labels
		}

		// Best-effort dwell stats — omit the field if the view isn't ready yet.
		let dwellMap = new Map<string, number | null>();
		try {
			const { rows } = await query<{ stage_name: string; avg_dwell_days: string | null }>(
				`SELECT stage_name, avg_dwell_days FROM roadmap_proposal.v_stage_dwell_stats`,
			);
			for (const row of rows) {
				dwellMap.set(row.stage_name, row.avg_dwell_days !== null ? parseFloat(row.avg_dwell_days) : null);
			}
		} catch {
			// non-fatal — view may not exist yet on first boot
		}

		const columns = view.stages.map((stage, idx) => {
			const def = stageDefMap.get(stage.name);
			const avgDwell = dwellMap.get(stage.name) ?? null;
			return {
				stage_name:     stage.name,
				stage_order:    stage.order ?? idx + 1,
				display_label:  def?.displayLabel ?? stage.name,
				is_terminal:    stage.isTerminal ?? false,
				maturity_gate:  def?.maturityGate ?? null,
				avg_dwell_days: avgDwell,
			};
		});

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Cache-Control": bust ? "no-cache" : "public, max-age=300",
		};

		return new Response(JSON.stringify(columns), { status: 200, headers });
	} catch (error) {
		const fallback = [
			{ stage_name: "DRAFT",    stage_order: 1, display_label: "Draft",    is_terminal: false, maturity_gate: null, avg_dwell_days: null },
			{ stage_name: "REVIEW",   stage_order: 2, display_label: "Review",   is_terminal: false, maturity_gate: null, avg_dwell_days: null },
			{ stage_name: "DEVELOP",  stage_order: 3, display_label: "Develop",  is_terminal: false, maturity_gate: null, avg_dwell_days: null },
			{ stage_name: "MERGE",    stage_order: 4, display_label: "Merge",    is_terminal: false, maturity_gate: null, avg_dwell_days: null },
			{ stage_name: "COMPLETE", stage_order: 5, display_label: "Complete", is_terminal: true,  maturity_gate: null, avg_dwell_days: null },
		];
		return new Response(JSON.stringify(fallback), {
			status: 200,
			headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
		});
	}
}

/**
 * GET /api/board/live-feed
 * P720 Activity Feed — Returns recent events from message_ledger WHERE channel=system:proposal-feed
 * Query params:
 *   ?proposal_id=<id>  — Filter by proposal_id
 *   ?agent_identity=<id> — Filter by from_agent
 *   ?limit=50          — Max events to return (default 50)
 *   ?cursor=<id>       — Pagination cursor (id of last seen event)
 *
 * Returns array of activity feed events in reverse-chronological order.
 * Latency target: <200ms at 10,000 event table size (AC-5).
 */
export async function handleBoardLiveFeed(
	_ctx: ServerContext,
	req: Request,
): Promise<Response> {
	try {
		const url = new URL(req.url);
		const proposalId = url.searchParams.get("proposal_id")
			? Number(url.searchParams.get("proposal_id"))
			: undefined;
		const agentIdentity = url.searchParams.get("agent_identity")
			? String(url.searchParams.get("agent_identity")).trim()
			: undefined;
		const limit = Math.min(
			url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50,
			200, // Cap at 200 rows per request
		);
		const cursor = url.searchParams.get("cursor")
			? Number(url.searchParams.get("cursor"))
			: undefined;

		// Build WHERE clause filters
		const whereParts: string[] = ["channel = 'system:proposal-feed'"];
		const params: (number | string | undefined)[] = [];

		if (proposalId) {
			whereParts.push(`proposal_id = $${params.length + 1}`);
			params.push(proposalId);
		}

		if (agentIdentity) {
			// Filter by the actual agent from metadata payload (from_agent is always system:proposal-feed)
			whereParts.push(`(metadata->'payload'->>'agent' = $${params.length + 1} OR metadata->'payload'->>'agent_identity' = $${params.length + 1})`);
			params.push(agentIdentity);
			params.push(agentIdentity);
		}

		if (cursor) {
			whereParts.push(`id < $${params.length + 1}`);
			params.push(cursor);
		}

		const whereClause = whereParts.join(" AND ");

		// Query activity feed with indexed lookup
		const { rows } = await query<{
			id: number;
			from_agent: string;
			proposal_id: number | null;
			message_content: string;
			created_at: string;
			metadata: Record<string, unknown>;
		}>(
			`SELECT id, from_agent, proposal_id, message_content, created_at, metadata
			 FROM roadmap.message_ledger
			 WHERE ${whereClause}
			 ORDER BY created_at DESC, id DESC
			 LIMIT $${params.length + 1}`,
			[...params, limit],
		);

		// Format response with next cursor if available
		const events = rows.map((row) => ({
			id: row.id,
			actor: row.from_agent,
			proposal_id: row.proposal_id,
			message: row.message_content,
			timestamp: row.created_at,
			event_type: row.metadata?.event_type ?? "unknown",
		}));

		const nextCursor = events.length >= limit ? events[events.length - 1]?.id : null;

		return Response.json(
			{
				events,
				cursor: nextCursor,
				count: events.length,
			},
			{
				status: 200,
				headers: {
					"Cache-Control": "no-cache, must-revalidate",
					"Content-Type": "application/json",
				},
			},
		);
	} catch (error) {
		console.error("[P720] board live-feed query failed:", (error as Error).message);
		return Response.json(
			{ error: "Failed to fetch activity feed", events: [] },
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
}

// ── Sequences ─────────────────────────────────────────────────────────────────

export async function handleGetSequences(
	ctx: ServerContext,
): Promise<Response> {
	const data = await ctx.core.listActiveSequences();
	return Response.json(data);
}

export async function handleMoveSequence(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	try {
		const body = await req.json();
		const proposalId = String(
			body.proposalId || body.proposalId || "",
		).trim();
		const moveToUnsequenced = Boolean(body.unsequenced === true);
		const targetSequenceIndex =
			body.targetSequenceIndex !== undefined
				? Number(body.targetSequenceIndex)
				: undefined;

		if (!proposalId)
			return Response.json(
				{ error: "proposalId is required" },
				{ status: 400 },
			);

		const next = await ctx.core.moveProposalInSequences({
			proposalId,
			unsequenced: moveToUnsequenced,
			targetSequenceIndex,
		});
		return Response.json(next);
	} catch (error) {
		const message = (error as Error)?.message || "Invalid request";
		return Response.json({ error: message }, { status: 400 });
	}
}

// ── Dispatch entry point ──────────────────────────────────────────────────────

/**
 * Dispatch board stage/column, live-feed, and sequence routes. Returns a
 * `Promise<Response>` when owned, else `null`. NOTE: board stage/column/feed
 * routes are matched earlier in `dispatchRequest` than the sequence routes;
 * this dispatcher preserves that by checking them in the same relative order.
 */
export function handleBoardRoutes(
	ctx: ServerContext,
	method: string,
	pathname: string,
	req: Request,
): Promise<Response> | null {
	if (pathname === "/api/board/stages" && method === "GET")
		return handleGetBoardStages(ctx, req);
	if (pathname === "/api/board/columns" && method === "GET")
		return handleGetBoardColumns(ctx, req);
	if (pathname === "/api/board/live-feed" && method === "GET")
		return handleBoardLiveFeed(ctx, req);
	if (pathname === "/api/sequences" && method === "GET")
		return handleGetSequences(ctx);
	if (pathname === "/api/sequences/move" && method === "POST")
		return handleMoveSequence(ctx, req);
	return null;
}
