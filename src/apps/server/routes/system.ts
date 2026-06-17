/**
 * routes/system.ts — system, config, project, and observability HTTP routes
 * extracted from `RoadmapServer` (P3796 monolith decomposition, AC-14).
 *
 * Each handler is a standalone async function taking a `ServerContext` (plus a
 * `Request` and/or path params where needed) instead of being a private method
 * on the server class. `routeSystemRequest` is the dispatch entry point: it
 * returns a `Promise<Response>` when it owns the route, or `null` to let the
 * caller fall through to the remaining inline routing in `index.ts`.
 *
 * Covered routes (AC-14):
 *   GET  /healthz
 *   POST /smoke
 *   GET  /api/version
 *   GET  /api/status
 *   GET  /api/statistics
 *   GET  /api/projects        POST /api/projects
 *   POST /api/init
 *   GET  /api/arch-docs
 *   GET  /metrics
 *   GET  /api/sla
 *   GET  /api/config          PUT  /api/config
 *   GET  /api/config/keys     PUT  /api/config/keys/:name
 *   GET  /api/statuses
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeProject } from "../../../core/infrastructure/init.ts";
import { getProposalStatistics } from "../../../core/infrastructure/statistics.ts";
import {
	checkStale,
	generateArchitectureDocs,
} from "../../../core/infrastructure/architecture-reconstructor.ts";
import { getPool, query } from "../../../infra/postgres/pool.ts";
import type { McpServer } from "../../../mcp/server.ts";
import {
	AllConfigKeys,
	getConfigKeyByName,
} from "../../../shared/runtime/config-keys.ts";
import { formatVersionLabel, getVersionInfo } from "../../../utils/version.ts";
import { handleDirectMcpRequest } from "../../mcp-server/http-compat.ts";
import { projectCreate } from "../../mcp-server/tools/projects/lifecycle-handlers.ts";
import { requireOperator } from "../operator-auth.ts";
import type { ServerContext } from "../server-context.ts";

// ── Health & smoke (P446) ────────────────────────────────────────────────────

export async function handleHealthz(ctx: ServerContext): Promise<Response> {
	let dbStatus: "ok" | "error" = "error";
	let schemaVersion: string | null = null;
	let dbErrorMessage: string | undefined;
	try {
		const pool = getPool();
		const [pingResult, migResult] = await Promise.all([
			pool.query("SELECT 1"),
			pool
				.query<{ filename: string }>(
					"SELECT filename FROM roadmap.migration_history WHERE status = 'applied' ORDER BY applied_at DESC LIMIT 1",
				)
				.catch(() => null),
		]);
		if (pingResult.rowCount && pingResult.rowCount > 0) dbStatus = "ok";
		if (migResult && migResult.rows.length > 0) {
			schemaVersion = migResult.rows[0].filename;
		}
	} catch (err) {
		dbErrorMessage = err instanceof Error ? err.message : String(err);
	}

	const { version, revision } = await getVersionInfo();
	const dbHost = process.env.PGHOST ?? "127.0.0.1";
	const dbName = process.env.PGDATABASE ?? "agenthive";
	const schema = process.env.PG_SCHEMA ?? "roadmap";

	const body: Record<string, unknown> = {
		service: "ok",
		db: dbStatus,
		schema_version: schemaVersion,
		git_revision: revision,
		app_version: version,
		project_root: ctx.core.filesystem.rootDir,
		db_host: dbHost,
		db_name: dbName,
		schema,
		started_at: ctx.startedAt.toISOString(),
		mcp_protocol_version: "2024-11-05",
	};
	if (dbErrorMessage !== undefined) {
		body.db_error = dbErrorMessage;
	}

	return Response.json(body, { status: 200 });
}

// P446 AC-5: POST /smoke
export async function handleSmoke(ctx: ServerContext): Promise<Response> {
	if (!ctx.mcpServer) {
		return Response.json(
			{ error: "MCP server not available" },
			{ status: 503 },
		);
	}

	const smokeServer = ctx.mcpServer as McpServer;
	const t0 = Date.now();
	const steps: Array<{
		name: string;
		elapsed_ms: number;
		result: "ok" | "error";
		detail?: string;
	}> = [];

	const step = async (name: string, payload: unknown) => {
		const stepStart = Date.now();
		try {
			const res = await handleDirectMcpRequest(smokeServer, payload);
			const elapsed_ms = Date.now() - stepStart;
			const isError = res.status >= 400 || ("error" in (res.body as object));
			steps.push({ name, elapsed_ms, result: isError ? "error" : "ok" });
		} catch (err) {
			const elapsed_ms = Date.now() - stepStart;
			const detail = err instanceof Error ? err.message : String(err);
			steps.push({ name, elapsed_ms, result: "error", detail });
		}
	};

	await step("initialize", {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "smoke", version: "0" },
		},
	});
	await step("tools/list", {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/list",
		params: {},
	});
	await step("tools/call", {
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "mcp_project", arguments: { action: "list_actions" } },
	});

	const total_ms = Date.now() - t0;
	const allOk = steps.every((s) => s.result === "ok");
	return Response.json({ steps, total_ms }, { status: allOk ? 200 : 207 });
}

// ── Version / status / statistics ─────────────────────────────────────────────

export async function handleGetVersion(): Promise<Response> {
	try {
		const versionInfo = await getVersionInfo();
		const version = formatVersionLabel(versionInfo);
		return Response.json({ version });
	} catch (error) {
		console.error("Error getting version:", error);
		return Response.json({ error: "Failed to get version" }, { status: 500 });
	}
}

export async function handleGetStatistics(ctx: ServerContext): Promise<Response> {
	try {
		// Load proposals using the same logic as CLI overview
		const { proposals, drafts, statuses } =
			await ctx.core.loadAllProposalsForStatistics();

		// Calculate statistics using the exact same function as CLI
		const statistics = getProposalStatistics(proposals, drafts, statuses);

		// Convert Maps to objects for JSON serialization
		const response = {
			...statistics,
			statusCounts: Object.fromEntries(statistics.statusCounts),
			priorityCounts: Object.fromEntries(statistics.priorityCounts),
		};

		return Response.json(response);
	} catch (error) {
		console.error("Error getting statistics:", error);
		return Response.json(
			{ error: "Failed to get statistics" },
			{ status: 500 },
		);
	}
}

export async function handleGetStatus(ctx: ServerContext): Promise<Response> {
	try {
		const config = await ctx.core.filesystem.loadConfig();
		return Response.json({
			initialized: !!config,
			projectPath: ctx.core.filesystem.rootDir,
		});
	} catch (error) {
		console.error("Error getting status:", error);
		return Response.json({
			initialized: false,
			projectPath: ctx.core.filesystem.rootDir,
		});
	}
}

// ── Project init / listing / creation ─────────────────────────────────────────

export async function handleInit(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	try {
		const body = await req.json();
		const projectName =
			typeof body.projectName === "string" ? body.projectName.trim() : "";
		const integrationMode = body.integrationMode as
			| "mcp"
			| "cli"
			| "none"
			| undefined;
		const mcpClients = Array.isArray(body.mcpClients) ? body.mcpClients : [];
		const agentInstructions = Array.isArray(body.agentInstructions)
			? body.agentInstructions
			: [];
		const installClaudeAgentFlag = Boolean(body.installClaudeAgent);
		const advancedConfig = body.advancedConfig || {};

		// Input validation (browser layer responsibility)
		if (!projectName) {
			return Response.json(
				{ error: "Project name is required" },
				{ status: 400 },
			);
		}

		// Check if already initialized (for browser, we don't allow re-init)
		const existingConfig = await ctx.core.filesystem.loadConfig();
		if (existingConfig) {
			return Response.json(
				{ error: "Project is already initialized" },
				{ status: 400 },
			);
		}

		// Call shared core init function
		const result = await initializeProject(ctx.core, {
			projectName,
			integrationMode: integrationMode || "none",
			mcpClients,
			agentInstructions,
			installClaudeAgent: installClaudeAgentFlag,
			advancedConfig,
			existingConfig: null,
		});

		// Update server's project name
		ctx.setProjectName(result.projectName);

		// Ensure config watcher is set up now that config file exists
		if (ctx.contentStore) {
			ctx.contentStore.ensureConfigWatcher();
		}

		return Response.json({
			success: result.success,
			projectName: result.projectName,
			mcpResults: result.mcpResults,
		});
	} catch (error) {
		console.error("Error initializing project:", error);
		const message =
			error instanceof Error ? error.message : "Failed to initialize project";
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function handleListProjects(): Promise<Response> {
	try {
		const { rows } = await query<{
			project_id: number;
			slug: string;
			name: string;
			worktree_root: string;
			bootstrap_status: string;
			host: string;
			port: number;
			db_name: string | null;
		}>(
			`SELECT project_id, slug, name, worktree_root,
			        bootstrap_status, host, port, db_name
			   FROM roadmap.project
			  WHERE status = 'active'
			  ORDER BY project_id ASC`,
		);
		return Response.json({
			projects: rows,
			default_project_id: rows[0]?.project_id ?? null,
		});
	} catch (err) {
		console.error("[projects] list failed:", (err as Error).message);
		return Response.json({ error: "Failed to list projects" }, { status: 500 });
	}
}

// P3508 AC-8: Create a new project (POST /api/projects).
// Requires operator bearer token with 'project.create' or '*' in allowed_actions.
// Delegates to projectCreate() from the MCP lifecycle handler.
export async function handleCreateProject(req: Request): Promise<Response> {
	const auth = await requireOperator(req, { action: "project.create" });
	if (auth.rejected) return auth.rejected;
	try {
		const body = (await req.json()) as Record<string, unknown>;
		const result = await projectCreate({
			slug: typeof body.slug === "string" ? body.slug : undefined,
			name: typeof body.name === "string" ? body.name : undefined,
			worktree_root:
				typeof body.worktree_root === "string"
					? body.worktree_root
					: undefined,
			default_workflow_template:
				typeof body.default_workflow_template === "string"
					? body.default_workflow_template
					: undefined,
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { ok: false, error: text };
		}
		const status = parsed.ok === false ? 400 : 201;
		return Response.json(parsed, { status });
	} catch (err) {
		console.error("[projects] create failed:", (err as Error).message);
		return Response.json({ error: "project create failed" }, { status: 500 });
	}
}

// ── Statuses ──────────────────────────────────────────────────────────────────

export async function handleGetStatuses(ctx: ServerContext): Promise<Response> {
	const config = await ctx.core.filesystem.loadConfig();
	const statuses = config?.statuses || [
		"Draft",
		"Review",
		"Develop",
		"Merge",
		"Complete",
	];
	return Response.json(statuses);
}

// ── Config (file-backed + runtime-flag keys) ──────────────────────────────────

export async function handleGetConfig(ctx: ServerContext): Promise<Response> {
	try {
		const config = await ctx.core.filesystem.loadConfig();
		if (!config) {
			return Response.json(
				{ error: "Configuration not found" },
				{ status: 404 },
			);
		}
		return Response.json(config);
	} catch (error) {
		console.error("Error loading config:", error);
		return Response.json(
			{ error: "Failed to load configuration" },
			{ status: 500 },
		);
	}
}

export async function handleUpdateConfig(
	ctx: ServerContext,
	req: Request,
): Promise<Response> {
	try {
		const updatedConfig = await req.json();

		// Validate configuration
		if (!updatedConfig.projectName?.trim()) {
			return Response.json(
				{ error: "Project name is required" },
				{ status: 400 },
			);
		}

		if (
			updatedConfig.defaultPort &&
			(updatedConfig.defaultPort < 1 || updatedConfig.defaultPort > 65535)
		) {
			return Response.json(
				{ error: "Port must be between 1 and 65535" },
				{ status: 400 },
			);
		}

		// Save configuration
		await ctx.core.filesystem.saveConfig(updatedConfig);

		// Update local project name if changed
		if (updatedConfig.projectName !== ctx.getProjectName()) {
			ctx.setProjectName(updatedConfig.projectName);
		}

		// Notify connected clients so that they refresh configuration-dependent data (e.g., statuses)
		ctx.broadcastProposalsUpdated();

		return Response.json(updatedConfig);
	} catch (error) {
		console.error("Error updating config:", error);
		return Response.json(
			{ error: "Failed to update configuration" },
			{ status: 500 },
		);
	}
}

export async function handleGetConfigKeys(req: Request): Promise<Response> {
	const auth = await requireOperator(req, { action: "config.read" });
	if (auth.rejected) return auth.rejected;

	const url = new URL(req.url);
	const categoryFilter = url.searchParams.get("category") ?? null;

	// Query all active flag values in one shot
	let flagRows: {
		flag_name: string;
		scope: string;
		value_jsonb: unknown;
		category: string | null;
	}[] = [];
	try {
		const { rows } = await query<{
			flag_name: string;
			scope: string;
			value_jsonb: unknown;
			category: string | null;
		}>(
			`SELECT flag_name, scope, value_jsonb, category
			   FROM core.runtime_flag
			  WHERE lifecycle_status = 'active'`,
		);
		flagRows = rows;
	} catch {
		// non-fatal if table not migrated yet
	}
	const flagMap = new Map<string, { value: unknown; category: string | null }>();
	for (const r of flagRows) {
		if (!flagMap.has(r.flag_name)) {
			flagMap.set(r.flag_name, { value: r.value_jsonb, category: r.category });
		}
	}

	const descriptors = Object.values(AllConfigKeys).map((key) => {
		let value: unknown = null;
		let masked = false;

		if (key.class === "secret" || (key.class as string) === "tenant_dsn") {
			masked = true;
			value = null;
		} else if (key.class === "structural") {
			value =
				process.env[key.name] ??
				("defaultValue" in key ? key.defaultValue : null) ??
				null;
		} else if (key.class === "flag") {
			const flagEntry = flagMap.get(key.name);
			value =
				flagEntry?.value ??
				("defaultValue" in key ? key.defaultValue : null) ??
				null;
		} else if (key.class === "registry") {
			value =
				process.env[key.name] ??
				("defaultValue" in key ? key.defaultValue : null) ??
				null;
		}

		const flagMeta = flagMap.get(key.name);
		const category =
			(flagMeta?.category ?? null) ||
			("category" in key ? (key as { category?: string }).category : null) ||
			"uncategorized";

		return {
			name: key.name,
			class: key.class,
			category,
			description:
				"description" in key
					? (key as { description?: string }).description ?? null
					: null,
			value,
			default_value:
				"defaultValue" in key
					? (key as { defaultValue?: unknown }).defaultValue ?? null
					: null,
			required: key.required,
			editable: key.class === "flag",
			masked,
		};
	});

	const filtered = categoryFilter
		? descriptors.filter((d) => d.category === categoryFilter)
		: descriptors;

	return Response.json({ keys: filtered, count: filtered.length });
}

export async function handleMutateConfigKey(
	req: Request,
	keyName: string,
): Promise<Response> {
	const auth = await requireOperator(req, { action: "config.write" });
	if (auth.rejected) return auth.rejected;

	let key: ReturnType<typeof getConfigKeyByName>;
	try {
		key = getConfigKeyByName(keyName);
	} catch {
		return Response.json({ error: "Unknown config key" }, { status: 404 });
	}

	if (key.class !== "flag") {
		return Response.json(
			{
				error: `Key '${keyName}' (class: ${key.class}) is not editable via this endpoint`,
			},
			{ status: 400 },
		);
	}

	let body: { value: unknown; scope?: string };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const scope = typeof body.scope === "string" ? body.scope : "global";

	try {
		const serialized = JSON.stringify(body.value);
		await query(
			`INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, lifecycle_status)
			 VALUES ($1, $2, $3::jsonb, 'active')
			 ON CONFLICT (flag_name, scope)
			 DO UPDATE SET value_jsonb = EXCLUDED.value_jsonb, updated_at = now()`,
			[keyName, scope, serialized],
		);
		await query(`SELECT pg_notify('runtime_flag_changed', $1::text)`, [
			JSON.stringify({ flag_name: keyName, scope }),
		]);
		return Response.json({
			key_name: keyName,
			scope,
			new_value: body.value,
			operator: auth.outcome.operatorName,
		});
	} catch (err) {
		console.error(`[config.write] Failed to mutate ${keyName}:`, err);
		return Response.json({ error: "Failed to update flag" }, { status: 500 });
	}
}

// ── Arch docs / metrics / SLA ─────────────────────────────────────────────────

export async function handleGetArchDocs(): Promise<Response> {
	if (process.env.ARCH_RECONSTRUCTOR_DISABLED === "true") {
		return Response.json(
			{ error: "arch_reconstructor_disabled", fallback: "env_var_set" },
			{ status: 503 },
		);
	}
	let views;
	try {
		views = await generateArchitectureDocs();
	} catch (err) {
		console.error("[arch-docs] DB query failed:", err);
		return Response.json(
			{ error: "db_unavailable", fallback: "last_generated" },
			{ status: 503 },
		);
	}
	const staleResult = await checkStale(views).catch(() => ({}));
	const staleSince = (staleResult as { staleSince?: Date }).staleSince;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Generated-At": views.generatedAt.toISOString(),
	};
	if (staleSince) {
		headers["X-Arch-Stale"] = `true; since=${staleSince.toISOString()}`;
	}

	return new Response(
		JSON.stringify({
			...views,
			generatedAt: views.generatedAt.toISOString(),
			timeline: views.timeline.map((e) => ({
				...e,
				transitionedAt: e.transitionedAt.toISOString(),
			})),
		}),
		{ status: 200, headers },
	);
}

export async function handleMetrics(): Promise<Response> {
	try {
		const pool = getPool();

		// Query trace_span for current state and tool call counts
		let slaState = 0; // default to 0 (down)
		let toolCallCount = 0;
		let rateLimitViolationsTotal = 0;
		const rateLimitViolationsByReason: Record<string, number> = {};

		try {
			// Check if system is in normal state by counting recent spans
			const spanResult = await pool.query(`
				SELECT COUNT(*) as count
				FROM roadmap.trace_span
				WHERE created_at > NOW() - INTERVAL '5 minutes'
			`);
			toolCallCount = spanResult.rows[0]?.count || 0;

			// Simple heuristic: if we have spans in last 5 min, state is normal
			slaState = toolCallCount > 0 ? 1 : 0;
		} catch (err) {
			console.warn("Error querying trace_span:", err);
			slaState = 0;
		}

		// P1100 AC-11: Query rate limit violations for observability
		try {
			// Total rate limit violations across all senders and channels
			const totalResult = await pool.query(`
				SELECT COUNT(*) as count
				FROM roadmap.msg_send_rate_limit_violation
				WHERE violation_at > NOW() - INTERVAL '1 hour'
			`);
			rateLimitViolationsTotal = parseInt(
				totalResult.rows[0]?.count || "0",
				10,
			);

			// Violations broken down by reason
			const byReasonResult = await pool.query(`
				SELECT reason, COUNT(*) as count
				FROM roadmap.msg_send_rate_limit_violation
				WHERE violation_at > NOW() - INTERVAL '1 hour'
				GROUP BY reason
			`);
			for (const row of byReasonResult.rows) {
				rateLimitViolationsByReason[row.reason] = parseInt(
					row.count || "0",
					10,
				);
			}
		} catch (err) {
			console.warn("Error querying rate limit violations:", err);
			// Non-fatal: metrics endpoint continues without rate limit data
		}

		// Build Prometheus text format response
		let metrics = `# HELP agenthive_sla_state Current SLA state (1=normal, 0=down)
# TYPE agenthive_sla_state gauge
agenthive_sla_state{state="normal"} ${slaState}

# HELP agenthive_mcp_tool_calls_total Total MCP tool calls in last 5 minutes
# TYPE agenthive_mcp_tool_calls_total counter
agenthive_mcp_tool_calls_total ${toolCallCount}

# HELP agenthive_msg_send_rate_limit_violations_total Total msg_send rate limit violations in last hour
# TYPE agenthive_msg_send_rate_limit_violations_total counter
agenthive_msg_send_rate_limit_violations_total ${rateLimitViolationsTotal}
`;

		// P1100 AC-11: Per-reason breakdown of rate limit violations
		for (const [reason, count] of Object.entries(
			rateLimitViolationsByReason,
		)) {
			metrics += `# HELP agenthive_msg_send_rate_limit_violations_by_reason_total Rate limit violations by reason
# TYPE agenthive_msg_send_rate_limit_violations_by_reason_total counter
agenthive_msg_send_rate_limit_violations_by_reason_total{reason="${reason}"} ${count}
`;
		}

		metrics += `
# Note: install prom-client for full histogram support
`;

		return new Response(metrics, {
			headers: {
				"Content-Type": "text/plain; version=0.0.4",
				"Cache-Control": "no-cache, no-store, must-revalidate",
			},
		});
	} catch (error) {
		console.error("Error generating metrics:", error);
		return new Response("# error generating metrics\n", {
			status: 500,
			headers: { "Content-Type": "text/plain" },
		});
	}
}

export async function handleGetSla(): Promise<Response> {
	try {
		const slaPath = join(
			import.meta.dirname,
			"../../../../docs/sla-contract.json",
		);
		const slaContent = readFileSync(slaPath, "utf-8");
		const slaParsed = JSON.parse(slaContent);
		return Response.json(slaParsed, {
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "max-age=3600",
			},
		});
	} catch (error) {
		console.error("Error reading SLA contract:", error);
		return Response.json({ error: "SLA contract not found" }, { status: 404 });
	}
}

/**
 * Dispatch a request to the system/config/project routes owned by this module.
 * Returns a `Promise<Response>` when the route is handled, or `null` to signal
 * the caller should fall through to its remaining inline routing.
 */
export function routeSystemRequest(
	ctx: ServerContext,
	method: string,
	pathname: string,
	req: Request,
): Promise<Response> | null {
	// Health & smoke (HTTP-layer, not MCP tool handlers)
	if (method === "GET" && pathname === "/healthz") return handleHealthz(ctx);
	if (method === "POST" && pathname === "/smoke") return handleSmoke(ctx);

	// Metrics endpoint (outside /api/ prefix for Prometheus scraping convention)
	if (method === "GET" && pathname === "/metrics") return handleMetrics();

	if (pathname.startsWith("/api/")) {
		if (pathname === "/api/projects") {
			if (method === "GET") return handleListProjects();
			if (method === "POST") return handleCreateProject(req);
		}

		if (pathname === "/api/arch-docs" && method === "GET")
			return handleGetArchDocs();

		if (pathname === "/api/statuses" && method === "GET")
			return handleGetStatuses(ctx);

		if (pathname === "/api/config/keys") {
			if (method === "GET") return handleGetConfigKeys(req);
		}

		if (pathname.startsWith("/api/config/keys/")) {
			const keyName = pathname.slice("/api/config/keys/".length);
			if (method === "PUT") return handleMutateConfigKey(req, keyName);
		}

		if (pathname === "/api/config") {
			if (method === "GET") return handleGetConfig(ctx);
			if (method === "PUT") return handleUpdateConfig(ctx, req);
		}

		if (pathname === "/api/version" && method === "GET")
			return handleGetVersion();
		if (pathname === "/api/statistics" && method === "GET")
			return handleGetStatistics(ctx);
		if (pathname === "/api/status" && method === "GET")
			return handleGetStatus(ctx);

		if (pathname === "/api/init" && method === "POST")
			return handleInit(ctx, req);

		if (pathname === "/api/sla" && method === "GET") return handleGetSla();
	}

	return null;
}
