/**
 * Central URL resolution for MCP and daemon endpoints.
 *
 * Synchronous helpers preserve legacy env-only behavior for callers that cannot
 * await. Async helpers resolve from the control runtime registry after env
 * overrides and cache DB values until runtime_endpoint_changed is received.
 */

import type { PoolClient, QueryResult } from "pg";
import { getPool, query as pgQuery } from "../../infra/postgres/pool.ts";

type RuntimeServiceName = "mcp" | "daemon";
type RuntimeQueryFn = (
	text: string,
	params?: unknown[],
) => Promise<
	QueryResult<{ endpoint_url?: string | null; url?: string | null }>
>;
type RuntimeListenerClient = Pick<PoolClient, "query" | "on" | "release">;
type RuntimeConnectListener = () => Promise<RuntimeListenerClient>;

export class AgentHiveConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentHiveConfigError";
		Object.setPrototypeOf(this, AgentHiveConfigError.prototype);
	}
}

let mcpUrlCache: string | null = null;
let daemonUrlCache: string | null = null;
let listenerStarted = false;
let listenerClient: RuntimeListenerClient | null = null;

let runtimeQueryFn: RuntimeQueryFn = pgQuery as RuntimeQueryFn;
let runtimeConnectListener: RuntimeConnectListener = async () =>
	getPool().connect();

const SERVICE_ENV: Record<RuntimeServiceName, string[]> = {
	mcp: ["MCP_URL", "AGENTHIVE_MCP_URL"],
	daemon: ["DAEMON_URL", "AGENTHIVE_DAEMON_URL"],
};

const SERVICE_LABEL: Record<RuntimeServiceName, string> = {
	mcp: "MCP",
	daemon: "Daemon",
};

function getCache(serviceName: RuntimeServiceName): string | null {
	return serviceName === "mcp" ? mcpUrlCache : daemonUrlCache;
}

function setCache(serviceName: RuntimeServiceName, value: string): void {
	if (serviceName === "mcp") {
		mcpUrlCache = value;
	} else {
		daemonUrlCache = value;
	}
}

function envEndpoint(serviceName: RuntimeServiceName): string | null {
	for (const envName of SERVICE_ENV[serviceName]) {
		const value = process.env[envName]?.trim();
		if (value && value.length > 0) return value;
	}
	return null;
}

function missingEndpointError(
	serviceName: RuntimeServiceName,
	cause?: unknown,
): AgentHiveConfigError {
	const label = SERVICE_LABEL[serviceName];
	const suffix =
		cause instanceof Error && cause.message
			? ` DB lookup failed: ${cause.message}`
			: "";
	return new AgentHiveConfigError(
		`${label} URL not configured. Set ${SERVICE_ENV[serviceName].join(" or ")} or add an active roadmap.control_runtime_service row for service_key='${serviceName}'.${suffix}`,
	);
}

async function queryRuntimeService(
	serviceName: RuntimeServiceName,
): Promise<string | null> {
	const result = await runtimeQueryFn(
		`SELECT url
		   FROM roadmap.control_runtime_service
		  WHERE service_key = $1
		    AND lifecycle_status = 'active'
		  LIMIT 1`,
		[serviceName],
	);
	const row = result.rows[0];
	const url = row?.endpoint_url ?? row?.url ?? null;
	const trimmed = typeof url === "string" ? url.trim() : "";
	return trimmed.length > 0 ? trimmed : null;
}

async function startEndpointInvalidationListener(): Promise<void> {
	if (listenerStarted) return;
	listenerStarted = true;

	try {
		const client = await runtimeConnectListener();
		listenerClient = client;
		await client.query("LISTEN runtime_endpoint_changed");
		client.on("notification", (message: { channel?: string }) => {
			if (message.channel === "runtime_endpoint_changed") {
				clearEndpointCache();
			}
		});
		client.on("error", () => {
			listenerClient = null;
			listenerStarted = false;
			clearEndpointCache();
		});
	} catch {
		listenerClient = null;
		// Endpoint resolution still works without live invalidation.
	}
}

async function resolveEndpointAsync(
	serviceName: RuntimeServiceName,
): Promise<string> {
	const cached = getCache(serviceName);
	if (cached !== null) return cached;

	const envUrl = envEndpoint(serviceName);
	if (envUrl) {
		setCache(serviceName, envUrl);
		return envUrl;
	}

	await startEndpointInvalidationListener();

	try {
		const registryUrl = await queryRuntimeService(serviceName);
		if (registryUrl) {
			setCache(serviceName, registryUrl);
			return registryUrl;
		}
		throw missingEndpointError(serviceName);
	} catch (err) {
		if (err instanceof AgentHiveConfigError) throw err;
		throw missingEndpointError(serviceName, err);
	}
}

/**
 * Legacy synchronous MCP resolver. Env-only by design; use getMcpUrlAsync for
 * DB-backed control-runtime fallback.
 */
export function getMcpUrl(): string {
	const cached = getCache("mcp");
	if (cached !== null) return cached;

	const envUrl = envEndpoint("mcp");
	if (envUrl) {
		setCache("mcp", envUrl);
		return envUrl;
	}

	throw missingEndpointError("mcp");
}

/**
 * Resolve the MCP endpoint from env first, then control_runtime.service.
 */
export async function getMcpUrlAsync(): Promise<string> {
	return resolveEndpointAsync("mcp");
}

/**
 * Legacy synchronous daemon resolver. Env-only by design; use
 * getDaemonUrlAsync for DB-backed control-runtime fallback.
 */
export function getDaemonUrl(): string {
	const cached = getCache("daemon");
	if (cached !== null) return cached;

	const envUrl = envEndpoint("daemon");
	if (envUrl) {
		setCache("daemon", envUrl);
		return envUrl;
	}

	throw missingEndpointError("daemon");
}

/**
 * Resolve the daemon endpoint from env first, then control_runtime.service.
 */
export async function getDaemonUrlAsync(): Promise<string> {
	return resolveEndpointAsync("daemon");
}

export function getControlPlanePort(): number {
	const mcpUrl = getMcpUrl();
	try {
		const url = new URL(mcpUrl);
		const port = url.port || (url.protocol === "https:" ? 443 : 80);
		return Number(port);
	} catch {
		throw new AgentHiveConfigError(
			`Invalid MCP URL format: ${mcpUrl}. Cannot extract port.`,
		);
	}
}

export async function getControlPlanePortAsync(): Promise<number> {
	const mcpUrl = await getMcpUrlAsync();
	try {
		const url = new URL(mcpUrl);
		const port = url.port || (url.protocol === "https:" ? 443 : 80);
		return Number(port);
	} catch {
		throw new AgentHiveConfigError(
			`Invalid MCP URL format: ${mcpUrl}. Cannot extract port.`,
		);
	}
}

export function clearEndpointCache(): void {
	mcpUrlCache = null;
	daemonUrlCache = null;
}

/**
 * Test hook for unit tests; production uses the shared Postgres pool.
 *
 * @internal
 */
export function configureEndpointResolverForTests(deps?: {
	queryFn?: RuntimeQueryFn;
	connectListener?: RuntimeConnectListener;
}): void {
	clearEndpointCache();
	if (listenerClient) {
		try {
			listenerClient.release();
		} catch {
			// ignore test cleanup errors
		}
	}
	listenerClient = null;
	listenerStarted = false;
	runtimeQueryFn = deps?.queryFn ?? (pgQuery as RuntimeQueryFn);
	runtimeConnectListener =
		deps?.connectListener ?? (async () => getPool().connect());
}
