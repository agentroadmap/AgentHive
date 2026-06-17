// System / liveness route handlers.
//
// Extracted from RoadmapServer (src/apps/server/index.ts) during the Phase 1
// monolith decomposition. These handlers are self-contained: they only read
// from the shared ServerContext plus module-level infra helpers, so they have
// no dependency back on the RoadmapServer class.

import { getPool } from "../../../infra/postgres/pool.ts";
import { handleDirectMcpRequest } from "../../mcp-server/http-compat.ts";
import type { McpServer } from "../../../mcp/server.ts";
import { getVersionInfo } from "../../../utils/version.ts";
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
