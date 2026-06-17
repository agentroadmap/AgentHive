/**
 * routes/proposals.ts — proposal CRUD + lifecycle HTTP routes extracted from
 * `RoadmapServer` (P3796 monolith decomposition, Phase 2, AC-18).
 *
 * Each handler is a standalone async function taking a `ServerContext` instead
 * of being a private method on the server class. Two dispatch entry points are
 * exported:
 *
 *   - `handleProposalRoutes` — owns /api/proposal/:id, /api/proposals/:id and
 *     its sub-routes (complete/release/demote/schema-drift-resolve, notes,
 *     decisions, reviews) plus /api/notifications/:id/seen.
 *   - `handleProposalMaintenanceRoutes` — owns /api/proposals/reorder and
 *     /api/proposals/cleanup[/execute]. Kept separate so the caller can invoke
 *     it at the same precedence point it occupied inline (after the
 *     directives block), preserving the original route-matching order.
 *
 * Both return a `Promise<Response>` when they own the route, or `null` so the
 * caller can fall through to its remaining routing.
 */
import { getPool, query } from "../../../infra/postgres/pool.ts";
import type {
	ProposalMaturity,
	ProposalUpdateInput,
} from "../../../types/index.ts";
import {
	ensurePrefix,
	findProposalByLooseId,
} from "../proposal-id-utils.ts";
import type { ServerContext } from "../server-context.ts";

// ── List / create ──────────────────────────────────────────────────────────

export async function handleListProposals(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const status = url.searchParams.get("status") || undefined;
	const assignee = url.searchParams.get("assignee") || undefined;
	const parent = url.searchParams.get("parent") || undefined;
	const priorityParam = url.searchParams.get("priority") || undefined;
	const crossBranch = url.searchParams.get("crossBranch") === "true";
	// P1613: parse limit. Default 100, max 1000 — prior implementation silently
	// dropped the param and always returned the full table (~11MB on prod).
	const DEFAULT_LIMIT = 100;
	const MAX_LIMIT = 1000;
	const limitRaw = url.searchParams.get("limit");
	const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
	const limit =
		Number.isFinite(parsedLimit) && parsedLimit > 0
			? Math.min(parsedLimit, MAX_LIMIT)
			: DEFAULT_LIMIT;
	const labelParams = [
		...url.searchParams.getAll("label"),
		...url.searchParams.getAll("labels"),
	];
	const labelsCsv = url.searchParams.get("labels");
	if (labelsCsv) {
		labelParams.push(...labelsCsv.split(","));
	}
	const labels = labelParams
		.map((label) => label.trim())
		.filter((label) => label.length > 0);

	let priority: "high" | "medium" | "low" | undefined;
	if (priorityParam) {
		const normalizedPriority = priorityParam.toLowerCase();
		const allowed = ["high", "medium", "low"];
		if (!allowed.includes(normalizedPriority)) {
			return Response.json(
				{ error: "Invalid priority filter" },
				{ status: 400 },
			);
		}
		priority = normalizedPriority as "high" | "medium" | "low";
	}

	// Resolve parent proposal ID if provided
	let parentProposalId: string | undefined;
	if (parent) {
		const store = await ctx.getContentStore();
		const allProposals = store.getProposals();
		let parentProposal = findProposalByLooseId(allProposals, parent);
		if (!parentProposal) {
			const fallbackId = ensurePrefix(parent);
			const fallback = await ctx.core.filesystem.loadProposal(fallbackId);
			if (fallback) {
				store.upsertProposal(fallback);
				parentProposal = fallback;
			}
		}
		if (!parentProposal) {
			const normalizedParent = ensurePrefix(parent);
			return Response.json(
				{ error: `Parent proposal ${normalizedParent} not found` },
				{ status: 404 },
			);
		}
		parentProposalId = parentProposal.id;
	}

	// Use Core.queryProposals which handles all filtering and cross-branch logic
	const proposals = await ctx.core.queryProposals({
		filters: {
			status,
			assignee,
			priority,
			parentProposalId,
			labels: labels.length > 0 ? labels : undefined,
		},
		includeCrossBranch: crossBranch,
		limit,
	});

	// P1613 belt-and-suspenders: queryProposals' limit only applies to the
	// search-query path; cap the result here so the list path also respects it.
	return Response.json(proposals.slice(0, limit));
}

export async function handleCreateProposal(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	const payload = await req.json();

	if (
		!payload ||
		typeof payload.title !== "string" ||
		payload.title.trim().length === 0
	) {
		return Response.json({ error: "Title is required" }, { status: 400 });
	}

	const acceptanceCriteria = Array.isArray(payload.acceptanceCriteriaItems)
		? payload.acceptanceCriteriaItems
				.map((item: { text?: string; checked?: boolean }) => ({
					text: String(item?.text ?? "").trim(),
					checked: Boolean(item?.checked),
				}))
				.filter((item: { text: string }) => item.text.length > 0)
		: [];

	try {
		const directive =
			typeof payload.directive === "string"
				? await ctx.resolveDirectiveInput(payload.directive)
				: undefined;

		const { proposal: createdProposal } =
			await ctx.core.createProposalFromInput({
				title: payload.title,
				description: payload.summary ?? payload.description,
				status: payload.status,
				priority: payload.priority,
				directive,
				labels: payload.labels,
				assignee: payload.assignee,
				dependencies: payload.dependencies,
				references: payload.references,
				parentProposalId: payload.parentProposalId,
				summary: payload.summary,
				motivation: payload.motivation,
				design: payload.design,
				drawbacks: payload.drawbacks,
				alternatives: payload.alternatives,
				dependency_note: payload.dependency_note,
				needs_capabilities:
					payload.needs_capabilities ?? payload.required_capabilities,
				implementationPlan: payload.design ?? payload.implementationPlan,
				implementationNotes: payload.implementationNotes,
				finalSummary: payload.finalSummary,
				acceptanceCriteria,
			});
		return Response.json(createdProposal, { status: 201 });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to create proposal";
		return Response.json({ error: message }, { status: 400 });
	}
}

// ── Read single proposal + sub-resources ─────────────────────────────────────

export async function handleGetProposal(
	ctx: ServerContext,
	proposalId: string,
): Promise<Response> {
	const liveProposal = await ctx.core.getProposal(proposalId);
	if (liveProposal) {
		return Response.json(liveProposal);
	}

	const store = await ctx.getContentStore();
	const proposals = store.getProposals();
	const proposal = findProposalByLooseId(proposals, proposalId);
	if (!proposal) {
		const fallbackId = ensurePrefix(proposalId);
		const fallback = await ctx.core.filesystem.loadProposal(fallbackId);
		if (fallback) {
			return Response.json(fallback);
		}
		return Response.json({ error: "Proposal not found" }, { status: 404 });
	}
	return Response.json(proposal);
}

export async function handleGetProposalNotes(
	proposalId: string,
	req: Request,
): Promise<Response> {
	try {
		const url = new URL(req.url);
		const noteType = url.searchParams.get("type");
		const isNumeric = /^\d+$/.test(proposalId);
		let sql = `SELECT id, proposal_id, author_identity, context_prefix, COALESCE(body, body_markdown) as body_markdown, created_at
			FROM roadmap_proposal.proposal_discussions
			WHERE proposal_id = ${isNumeric ? "$1" : "(SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1)"}`;
		const params: unknown[] = [
			isNumeric ? parseInt(proposalId, 10) : proposalId,
		];
		if (noteType) {
			sql += ` AND context_prefix = $2`;
			params.push(noteType);
		}
		sql += ` ORDER BY created_at DESC LIMIT 50`;
		const { rows } = await query(sql, params);
		return Response.json({ notes: rows || [] });
	} catch (error) {
		return Response.json({ error: String(error) }, { status: 500 });
	}
}

export async function handleGetProposalDecisions(
	proposalId: string,
): Promise<Response> {
	try {
		const isNumeric = /^\d+$/.test(proposalId);
		const { rows } = await query(
			`SELECT id, decision, authority, rationale, binding, decided_at
			 FROM roadmap_proposal.proposal_decision
			 WHERE proposal_id = ${isNumeric ? "$1" : "(SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1)"}
			 ORDER BY decided_at DESC`,
			[isNumeric ? parseInt(proposalId, 10) : proposalId],
		);
		return Response.json({ decisions: rows || [] });
	} catch (error) {
		return Response.json({ error: String(error) }, { status: 500 });
	}
}

export async function handleGetProposalReviews(
	proposalId: string,
): Promise<Response> {
	try {
		const isNumeric = /^\d+$/.test(proposalId);
		const { rows } = await query(
			`SELECT id, reviewer_identity, verdict, notes, findings, is_blocking, reviewed_at
			 FROM roadmap_proposal.proposal_reviews
			 WHERE proposal_id = ${isNumeric ? "$1" : "(SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1)"}
			 ORDER BY reviewed_at DESC`,
			[isNumeric ? parseInt(proposalId, 10) : proposalId],
		);
		return Response.json({ reviews: rows || [] });
	} catch (error) {
		return Response.json({ error: String(error) }, { status: 500 });
	}
}

// ── Update / delete / lifecycle ──────────────────────────────────────────────

export async function handleUpdateProposal(
	ctx: ServerContext,
	req: Request,
	proposalId: string,
): Promise<Response> {
	const updates = await req.json();
	const updateInput: ProposalUpdateInput = {};

	if ("title" in updates && typeof updates.title === "string") {
		updateInput.title = updates.title;
	}

	if ("description" in updates && typeof updates.description === "string") {
		updateInput.description = updates.description;
	}
	if ("summary" in updates && typeof updates.summary === "string") {
		updateInput.summary = updates.summary;
		updateInput.description = updates.summary;
	}
	if ("motivation" in updates && typeof updates.motivation === "string") {
		updateInput.motivation = updates.motivation;
	}
	if ("design" in updates && typeof updates.design === "string") {
		updateInput.design = updates.design;
		updateInput.implementationPlan = updates.design;
	}
	if ("drawbacks" in updates && typeof updates.drawbacks === "string") {
		updateInput.drawbacks = updates.drawbacks;
	}
	if ("alternatives" in updates && typeof updates.alternatives === "string") {
		updateInput.alternatives = updates.alternatives;
	}
	if (
		"dependency_note" in updates &&
		typeof updates.dependency_note === "string"
	) {
		updateInput.dependency_note = updates.dependency_note;
	}

	if ("status" in updates && typeof updates.status === "string") {
		updateInput.status = updates.status;
	}

	if ("maturity" in updates && typeof updates.maturity === "string") {
		// Live DB CHECK constraint on proposal.maturity accepts exactly 4 values.
		// Reject anything else loudly rather than letting the UPDATE fail at SQL.
		const ALLOWED_MATURITY = new Set([
			"new",
			"active",
			"mature",
			"obsolete",
		]);
		if (!ALLOWED_MATURITY.has(updates.maturity)) {
			return new Response(
				JSON.stringify({
					error: `Invalid maturity '${updates.maturity}'. Allowed: ${Array.from(ALLOWED_MATURITY).join(", ")}`,
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}
		updateInput.maturity = updates.maturity as ProposalMaturity;
	}

	if ("priority" in updates && typeof updates.priority === "string") {
		updateInput.priority = updates.priority;
	}

	if (
		"directive" in updates &&
		(typeof updates.directive === "string" || updates.directive === null)
	) {
		if (typeof updates.directive === "string") {
			updateInput.directive = await ctx.resolveDirectiveInput(
				updates.directive,
			);
		} else {
			updateInput.directive = updates.directive;
		}
	}

	if ("labels" in updates && Array.isArray(updates.labels)) {
		updateInput.labels = updates.labels;
	}

	if ("assignee" in updates && Array.isArray(updates.assignee)) {
		updateInput.assignee = updates.assignee;
	}

	if ("dependencies" in updates && Array.isArray(updates.dependencies)) {
		updateInput.dependencies = updates.dependencies;
	}

	if ("references" in updates && Array.isArray(updates.references)) {
		updateInput.references = updates.references;
	}
	if (
		"required_capabilities" in updates &&
		Array.isArray(updates.required_capabilities)
	) {
		updateInput.required_capabilities = updates.required_capabilities;
		updateInput.needs_capabilities = updates.required_capabilities;
	}
	if (
		"needs_capabilities" in updates &&
		Array.isArray(updates.needs_capabilities)
	) {
		updateInput.needs_capabilities = updates.needs_capabilities;
	}

	if (
		"implementationPlan" in updates &&
		typeof updates.implementationPlan === "string" &&
		!("design" in updates)
	) {
		updateInput.implementationPlan = updates.implementationPlan;
	}

	if (
		"implementationNotes" in updates &&
		typeof updates.implementationNotes === "string"
	) {
		updateInput.implementationNotes = updates.implementationNotes;
	}

	if ("finalSummary" in updates && typeof updates.finalSummary === "string") {
		updateInput.finalSummary = updates.finalSummary;
	}

	if (
		"acceptanceCriteriaItems" in updates &&
		Array.isArray(updates.acceptanceCriteriaItems)
	) {
		updateInput.acceptanceCriteria = updates.acceptanceCriteriaItems
			.map((item: { text?: string; checked?: boolean }) => ({
				text: String(item?.text ?? "").trim(),
				checked: Boolean(item?.checked),
			}))
			.filter((item: { text: string }) => item.text.length > 0);
	}

	try {
		const updatedProposal = await ctx.core.updateProposalFromInput(
			proposalId,
			updateInput,
		);
		return Response.json(updatedProposal);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to update proposal";
		return Response.json({ error: message }, { status: 400 });
	}
}

export async function handleDeleteProposal(
	ctx: ServerContext,
	proposalId: string,
): Promise<Response> {
	const success = await ctx.core.archiveProposal(proposalId);
	if (!success) {
		return Response.json({ error: "Proposal not found" }, { status: 404 });
	}
	return Response.json({ success: true });
}

export async function handleCompleteProposal(
	ctx: ServerContext,
	proposalId: string,
): Promise<Response> {
	try {
		const proposal = await ctx.core.filesystem.loadProposal(proposalId);
		if (!proposal) {
			return Response.json({ error: "Proposal not found" }, { status: 404 });
		}

		const success = await ctx.core.completeProposal(proposalId);
		if (!success) {
			return Response.json(
				{ error: "Failed to complete proposal" },
				{ status: 500 },
			);
		}

		// Notify listeners to refresh
		ctx.broadcastProposalsUpdated();
		return Response.json({ success: true });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to complete proposal";
		console.error("Error completing proposal:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function handleReleaseProposal(
	ctx: ServerContext,
	proposalId: string,
): Promise<Response> {
	try {
		const proposal = await ctx.core.filesystem.loadProposal(proposalId);
		if (!proposal) {
			return Response.json({ error: "Proposal not found" }, { status: 404 });
		}

		// Get the claim agent or use a default
		const agent = proposal.claim?.agent ?? "system";
		await ctx.core.releaseClaim(proposalId, agent, { force: true });

		// Notify listeners to refresh
		ctx.broadcastProposalsUpdated();
		return Response.json({ success: true });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to release proposal";
		console.error("Error releasing proposal:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function handleDemoteProposal(
	ctx: ServerContext,
	proposalId: string,
): Promise<Response> {
	try {
		const proposal = await ctx.core.filesystem.loadProposal(proposalId);
		if (!proposal) {
			return Response.json({ error: "Proposal not found" }, { status: 404 });
		}

		const result = await ctx.core.demoteProposalProper(
			proposalId,
			"user",
			true,
		);
		// Notify listeners to refresh
		ctx.broadcastProposalsUpdated();
		return Response.json({ success: true, status: result.status });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to demote proposal";
		console.error("Error demoting proposal:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function handleSchemaDriftResolve(
	ctx: ServerContext,
	req: Request,
	proposalId: string,
): Promise<Response> {
	try {
		const body = await req.json();
		const fingerprint = body.fingerprint;

		if (!fingerprint) {
			return Response.json(
				{ error: "fingerprint is required" },
				{ status: 400 },
			);
		}

		const result = await getPool().query(
			`UPDATE roadmap.schema_drift_seen
         SET resolved_at = now()
         WHERE fingerprint = $1 AND hotfix_proposal_id = $2`,
			[fingerprint, proposalId],
		);

		if (result.rowCount === 0) {
			return Response.json(
				{ error: "No matching schema drift record found" },
				{ status: 404 },
			);
		}

		// Broadcast update to clients
		ctx.broadcastProposalsUpdated();
		return Response.json({ success: true, resolved: true });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to resolve schema drift";
		console.error("Error resolving schema drift:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

// P705 Phase 4: Mark notification as seen
export async function handleMarkNotificationSeen(
	notificationId: string,
): Promise<Response> {
	try {
		// Check if notification_inbox table exists (Phase 4 optional feature)
		const tableExists = await getPool().query(
			`SELECT EXISTS (
				SELECT 1 FROM information_schema.tables
				WHERE table_schema='roadmap' AND table_name='notification_inbox'
			) as exists`,
		);

		if (!tableExists.rows[0]?.exists) {
			return Response.json(
				{ error: "notification_inbox table not available (Phase 4 not deployed)" },
				{ status: 503 },
			);
		}

		// Update notification to mark as seen
		const result = await getPool().query(
			`UPDATE roadmap.notification_inbox
			 SET seen = true
			 WHERE id = $1
			 RETURNING id, severity, title, message, created_at, seen`,
			[notificationId],
		);

		if (result.rowCount === 0) {
			return Response.json(
				{ error: "Notification not found" },
				{ status: 404 },
			);
		}

		// Trigger pg_notify so WebSocket clients get real-time update
		const notif = result.rows[0];
		await getPool().query(
			`SELECT pg_notify('notification_inbox_change', json_build_object('id', $1, 'change_type', 'update')::text)`,
			[notificationId],
		);

		return Response.json({
			success: true,
			notification: {
				id: notif.id,
				severity: notif.severity ?? "info",
				title: notif.title,
				message: notif.message,
				created_at: notif.created_at,
				seen: notif.seen,
			},
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to mark notification as seen";
		console.error("Error marking notification as seen:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

// ── Reorder / cleanup ────────────────────────────────────────────────────────

export async function handleReorderProposal(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	try {
		const body = await req.json();
		const proposalId =
			typeof body.proposalId === "string"
				? body.proposalId
				: typeof body.proposalId === "string"
					? body.proposalId
					: "";
		const targetStatus =
			typeof body.targetStatus === "string" ? body.targetStatus : "";
		const orderedProposalIds = Array.isArray(body.orderedProposalIds)
			? body.orderedProposalIds
			: Array.isArray(body.orderedProposalIds)
				? body.orderedProposalIds
				: [];
		const targetDirective =
			typeof body.targetDirective === "string"
				? body.targetDirective
				: body.targetDirective === null
					? null
					: typeof body.targetDirective === "string"
						? body.targetDirective
						: body.targetDirective === null
							? null
							: undefined;

		if (!proposalId || !targetStatus || orderedProposalIds.length === 0) {
			return Response.json(
				{
					error:
						"Missing required fields: proposalId, targetStatus, and orderedProposalIds",
				},
				{ status: 400 },
			);
		}

		const { updatedProposal } = await ctx.core.reorderProposal({
			proposalId,
			targetStatus,
			orderedProposalIds,
			targetDirective,
			commitMessage: `Reorder proposals in ${targetStatus}`,
		});

		return Response.json({ success: true, proposal: updatedProposal });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to reorder proposal";
		// Cross-branch and validation errors are client errors (400), not server errors (500)
		const isCrossBranchError = message.includes("exists in branch");
		const isValidationError =
			message.includes("not found") || message.includes("Missing required");
		const status = isCrossBranchError || isValidationError ? 400 : 500;
		if (status === 500) {
			console.error("Error reordering proposal:", error);
		}
		return Response.json({ error: message }, { status });
	}
}

export async function handleCleanupPreview(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	try {
		const url = new URL(req.url);
		const ageParam = url.searchParams.get("age");

		if (!ageParam) {
			return Response.json(
				{ error: "Missing age parameter" },
				{ status: 400 },
			);
		}

		const age = Number.parseInt(ageParam, 10);
		if (Number.isNaN(age) || age < 0) {
			return Response.json(
				{ error: "Invalid age parameter" },
				{ status: 400 },
			);
		}

		// Get Reached proposals older than specified days
		const proposalsToCleanup = await ctx.core.getReachedProposalsByAge(age);

		// Return preview of proposals to be cleaned up
		const preview = proposalsToCleanup.map((proposal) => ({
			id: proposal.id,
			title: proposal.title,
			updatedDate: proposal.updatedDate,
			createdDate: proposal.createdDate,
		}));

		return Response.json({
			count: preview.length,
			proposals: preview,
		});
	} catch (error) {
		console.error("Error getting cleanup preview:", error);
		return Response.json(
			{ error: "Failed to get cleanup preview" },
			{ status: 500 },
		);
	}
}

export async function handleCleanupExecute(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	try {
		const { age } = await req.json();

		if (age === undefined || age === null) {
			return Response.json(
				{ error: "Missing age parameter" },
				{ status: 400 },
			);
		}

		const ageInDays = Number.parseInt(age, 10);
		if (Number.isNaN(ageInDays) || ageInDays < 0) {
			return Response.json(
				{ error: "Invalid age parameter" },
				{ status: 400 },
			);
		}

		// Get Reached proposals older than specified days
		const proposalsToCleanup =
			await ctx.core.getReachedProposalsByAge(ageInDays);

		if (proposalsToCleanup.length === 0) {
			return Response.json({
				success: true,
				movedCount: 0,
				message: "No proposals to clean up",
			});
		}

		// Move proposals to completed folder
		let successCount = 0;
		const failedProposals: string[] = [];

		for (const proposal of proposalsToCleanup) {
			try {
				const success = await ctx.core.completeProposal(proposal.id);
				if (success) {
					successCount++;
				} else {
					failedProposals.push(proposal.id);
				}
			} catch (error) {
				console.error(`Failed to complete proposal ${proposal.id}:`, error);
				failedProposals.push(proposal.id);
			}
		}

		// Notify listeners to refresh
		ctx.broadcastProposalsUpdated();

		return Response.json({
			success: true,
			movedCount: successCount,
			totalCount: proposalsToCleanup.length,
			failedProposals:
				failedProposals.length > 0 ? failedProposals : undefined,
			message: `Moved ${successCount} of ${proposalsToCleanup.length} proposals to completed folder`,
		});
	} catch (error) {
		console.error("Error executing cleanup:", error);
		return Response.json(
			{ error: "Failed to execute cleanup" },
			{ status: 500 },
		);
	}
}

// ── Dispatch entry points ─────────────────────────────────────────────────────

/**
 * Dispatch proposal CRUD/lifecycle + notification routes. Returns a
 * `Promise<Response>` when owned, else `null`.
 *
 * Mirrors the original inline ordering in `dispatchRequest`:
 *   /api/proposal/:id (GET) → /api/proposals/:id (+ sub-routes) →
 *   /api/notifications/:id/seen → notes/decisions/reviews.
 *
 * NOTE: /api/proposals (list/create) is intentionally NOT handled here — it is
 * matched earlier in `dispatchRequest`, before the agents/operator blocks.
 */
export function handleProposalRoutes(
	ctx: ServerContext,
	method: string,
	pathname: string,
	req: Request,
): Promise<Response> | null {
	if (pathname.startsWith("/api/proposal/")) {
		const id = pathname.slice("/api/proposal/".length);
		if (method === "GET") return handleGetProposal(ctx, id);
	}

	if (pathname.startsWith("/api/proposals/")) {
		const parts = pathname.split("/");
		const id = parts[3]!;
		if (parts.length === 4) {
			if (method === "GET") return handleGetProposal(ctx, id);
			if (method === "PUT") return handleUpdateProposal(ctx, req, id);
			if (method === "DELETE") return handleDeleteProposal(ctx, id);
		}
		if (parts.length === 5 && parts[4] === "complete") {
			if (method === "POST") return handleCompleteProposal(ctx, id);
		}
		if (parts.length === 5 && parts[4] === "release") {
			if (method === "POST") return handleReleaseProposal(ctx, id);
		}
		if (parts.length === 5 && parts[4] === "demote") {
			if (method === "POST") return handleDemoteProposal(ctx, id);
		}
		if (parts.length === 5 && parts[4] === "schema-drift-resolve") {
			if (method === "POST") return handleSchemaDriftResolve(ctx, req, id);
		}
	}

	// P705 Phase 4: Notification endpoint
	if (pathname.startsWith("/api/notifications/")) {
		const parts = pathname.split("/");
		const id = parts[3]!;
		if (parts.length === 5 && parts[4] === "seen") {
			if (method === "PATCH") return handleMarkNotificationSeen(id);
		}
	}

	// GET /api/proposals/:id/notes - Discussion notes for a proposal
	if (pathname.startsWith("/api/proposals/") && pathname.endsWith("/notes")) {
		const parts = pathname.split("/");
		const id = parts[3]!; // /api/proposals/{id}/notes
		if (method === "GET") return handleGetProposalNotes(id, req);
	}

	// GET /api/proposals/:id/decisions
	if (
		pathname.startsWith("/api/proposals/") &&
		pathname.endsWith("/decisions")
	) {
		const parts = pathname.split("/");
		const id = parts[3]!;
		if (method === "GET") return handleGetProposalDecisions(id);
	}

	// GET /api/proposals/:id/reviews
	if (
		pathname.startsWith("/api/proposals/") &&
		pathname.endsWith("/reviews")
	) {
		const parts = pathname.split("/");
		const id = parts[3]!;
		if (method === "GET") return handleGetProposalReviews(id);
	}

	return null;
}

/**
 * Dispatch proposal reorder/cleanup maintenance routes. Kept separate from
 * `handleProposalRoutes` so the caller can invoke it at the original (later)
 * precedence point, preserving inline route-matching order.
 */
export function handleProposalMaintenanceRoutes(
	ctx: ServerContext,
	method: string,
	pathname: string,
	req: Request,
): Promise<Response> | null {
	if (pathname === "/api/proposals/reorder" && method === "POST")
		return handleReorderProposal(ctx, req);
	if (pathname === "/api/proposals/cleanup" && method === "GET")
		return handleCleanupPreview(ctx, req);
	if (pathname === "/api/proposals/cleanup/execute" && method === "POST")
		return handleCleanupExecute(ctx, req);
	return null;
}
