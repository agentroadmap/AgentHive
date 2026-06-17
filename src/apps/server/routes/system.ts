// System / liveness route handlers.
//
// Extracted from RoadmapServer (src/apps/server/index.ts) during the Phase 1
// monolith decomposition. These handlers are self-contained: they only read
// from the shared ServerContext plus module-level infra helpers, so they have
// no dependency back on the RoadmapServer class.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool, query } from "../../../infra/postgres/pool.ts";
import { handleDirectMcpRequest } from "../../mcp-server/http-compat.ts";
import type { McpServer } from "../../../mcp/server.ts";
import { formatVersionLabel, getVersionInfo } from "../../../utils/version.ts";
import { getProposalStatistics } from "../../../core/infrastructure/statistics.ts";
import { initializeProject } from "../../../core/infrastructure/init.ts";
import {
	generateArchitectureDocs,
	checkStale,
} from "../../../core/infrastructure/architecture-reconstructor.ts";
import { serveSlaContract } from "../sla-metrics.ts";
import type { ServerContext } from "../server-context.ts";

// P446 AC-4: GET /healthz
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
			const isError = res.status >= 400 || "error" in (res.body as object);
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

// GET /api/version
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

// GET /api/status
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

// GET /api/statistics
export async function handleGetStatistics(ctx: ServerContext): Promise<Response> {
	try {
		const { proposals, drafts, statuses } =
			await ctx.core.loadAllProposalsForStatistics();
		const statistics = getProposalStatistics(proposals, drafts, statuses);
		const response = {
			...statistics,
			statusCounts: Object.fromEntries(statistics.statusCounts),
			priorityCounts: Object.fromEntries(statistics.priorityCounts),
		};
		return Response.json(response);
	} catch (error) {
		console.error("Error getting statistics:", error);
		return Response.json({ error: "Failed to get statistics" }, { status: 500 });
	}
}

// GET /api/statuses
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

// GET /api/config
export async function handleGetConfig(ctx: ServerContext): Promise<Response> {
	try {
		const config = await ctx.core.filesystem.loadConfig();
		if (!config) {
			return Response.json({ error: "Configuration not found" }, { status: 404 });
		}
		return Response.json(config);
	} catch (error) {
		console.error("Error loading config:", error);
		return Response.json({ error: "Failed to load configuration" }, { status: 500 });
	}
}

// PUT /api/config
export async function handleUpdateConfig(
	req: Request,
	ctx: ServerContext,
): Promise<Response> {
	try {
		const updatedConfig = await req.json();
		if (!updatedConfig.projectName?.trim()) {
			return Response.json({ error: "Project name is required" }, { status: 400 });
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
		await ctx.core.filesystem.saveConfig(updatedConfig);
		ctx.onProjectInitialized?.(updatedConfig.projectName);
		ctx.broadcastUpdate?.();
		return Response.json(updatedConfig);
	} catch (error) {
		console.error("Error updating config:", error);
		return Response.json({ error: "Failed to update configuration" }, { status: 500 });
	}
}

// GET /api/projects
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

// POST /api/init
export async function handleInit(
	req: Request,
	ctx: ServerContext,
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

		if (!projectName) {
			return Response.json({ error: "Project name is required" }, { status: 400 });
		}

		const existingConfig = await ctx.core.filesystem.loadConfig();
		if (existingConfig) {
			return Response.json({ error: "Project is already initialized" }, { status: 400 });
		}

		const result = await initializeProject(ctx.core, {
			projectName,
			integrationMode: integrationMode || "none",
			mcpClients,
			agentInstructions,
			installClaudeAgent: installClaudeAgentFlag,
			advancedConfig,
			existingConfig: null,
		});

		ctx.onProjectInitialized?.(result.projectName);

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

// GET /api/arch-docs
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

// GET /api/sla — consolidated handler (AC-5: eliminates the duplicate inline branch)
export async function handleGetSla(): Promise<Response> {
	try {
		const contract = serveSlaContract();
		return new Response(JSON.stringify(contract, null, 2), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		return new Response(
			JSON.stringify({ error: "SLA contract unavailable" }),
			{ status: 503, headers: { "Content-Type": "application/json" } },
		);
	}
}

// GET /metrics
export async function handleMetrics(): Promise<Response> {
	try {
		const pool = getPool();

		let slaState = 0;
		let toolCallCount = 0;
		let rateLimitViolationsTotal = 0;
		let rateLimitViolationsByReason: Record<string, number> = {};

		try {
			const spanResult = await pool.query(`
				SELECT COUNT(*) as count
				FROM roadmap.trace_span
				WHERE created_at > NOW() - INTERVAL '5 minutes'
			`);
			toolCallCount = spanResult.rows[0]?.count || 0;
			slaState = toolCallCount > 0 ? 1 : 0;
		} catch (err) {
			console.warn("Error querying trace_span:", err);
			slaState = 0;
		}

		try {
			const totalResult = await pool.query(`
				SELECT COUNT(*) as count
				FROM roadmap.msg_send_rate_limit_violation
				WHERE violation_at > NOW() - INTERVAL '1 hour'
			`);
			rateLimitViolationsTotal = parseInt(totalResult.rows[0]?.count || "0", 10);

			const byReasonResult = await pool.query(`
				SELECT reason, COUNT(*) as count
				FROM roadmap.msg_send_rate_limit_violation
				WHERE violation_at > NOW() - INTERVAL '1 hour'
				GROUP BY reason
			`);
			for (const row of byReasonResult.rows) {
				rateLimitViolationsByReason[row.reason] = parseInt(row.count || "0", 10);
			}
		} catch (err) {
			console.warn("Error querying rate limit violations:", err);
		}

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

		for (const [reason, count] of Object.entries(rateLimitViolationsByReason)) {
			metrics += `# HELP agenthive_msg_send_rate_limit_violations_by_reason_total Rate limit violations by reason
# TYPE agenthive_msg_send_rate_limit_violations_by_reason_total counter
agenthive_msg_send_rate_limit_violations_by_reason_total{reason="${reason}"} ${count}
`;
		}

		metrics += `\n# Note: install prom-client for full histogram support\n`;

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
