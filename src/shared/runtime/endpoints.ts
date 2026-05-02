/**
 * Central URL resolution for MCP and daemon endpoints.
 *
 * Sync resolution order (getMcpUrl / getDaemonUrl):
 * 1. Environment variable (AGENTHIVE_MCP_URL, AGENTHIVE_DAEMON_URL)
 * 2. Hard fail with AgentHiveConfigError (no literal default)
 *
 * Async resolution order (getMcpUrlAsync / getDaemonUrlAsync) — P787:
 * 1. Environment variable (MCP_URL / DAEMON_URL)
 * 2. roadmap.control_runtime_service DB row
 * 3. Hard fail with Error if unresolvable
 *
 * Async values are cached per process; call invalidateEndpointCache() to flush.
 */

import { query } from "../../infra/postgres/pool.ts";

export class AgentHiveConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentHiveConfigError";
		Object.setPrototypeOf(this, AgentHiveConfigError.prototype);
	}
}

/**
 * Cache for resolved endpoint URLs
 */
let mcpUrlCache: string | null = null;
let daemonUrlCache: string | null = null;

/**
 * Resolve the MCP endpoint URL.
 *
 * Resolution:
 * 1. Check AGENTHIVE_MCP_URL environment variable
 * 2. Query control_runtime registry (when P431 lands; catch if table missing)
 * 3. Throw AgentHiveConfigError if unresolvable
 *
 * @returns The resolved MCP URL
 * @throws AgentHiveConfigError if MCP URL cannot be resolved
 */
export function getMcpUrl(): string {
	// Return cached value if available
	if (mcpUrlCache !== null) {
		return mcpUrlCache;
	}

	// Check environment variable first
	const envUrl = process.env.AGENTHIVE_MCP_URL?.trim();
	if (envUrl) {
		mcpUrlCache = envUrl;
		return envUrl;
	}

	// TODO: Query control_runtime registry when P431 lands
	// For now, try to query control_runtime.service and catch if table doesn't exist
	// const registryUrl = await queryControlRuntimeRegistry('mcp');
	// if (registryUrl) {
	//   mcpUrlCache = registryUrl;
	//   return registryUrl;
	// }

	// Hard fail - no literal default
	throw new AgentHiveConfigError(
		"MCP URL not configured. Set AGENTHIVE_MCP_URL environment variable.",
	);
}

/**
 * Resolve the daemon endpoint URL.
 *
 * Resolution:
 * 1. Check AGENTHIVE_DAEMON_URL environment variable
 * 2. Query control_runtime registry (when P431 lands; catch if table missing)
 * 3. Throw AgentHiveConfigError if unresolvable
 *
 * @returns The resolved daemon URL
 * @throws AgentHiveConfigError if daemon URL cannot be resolved
 */
export function getDaemonUrl(): string {
	// Return cached value if available
	if (daemonUrlCache !== null) {
		return daemonUrlCache;
	}

	// Check environment variable first
	const envUrl = process.env.AGENTHIVE_DAEMON_URL?.trim();
	if (envUrl) {
		daemonUrlCache = envUrl;
		return envUrl;
	}

	// TODO: Query control_runtime registry when P431 lands
	// For now, try to query control_runtime.service and catch if table doesn't exist
	// const registryUrl = await queryControlRuntimeRegistry('daemon');
	// if (registryUrl) {
	//   daemonUrlCache = registryUrl;
	//   return registryUrl;
	// }

	// Hard fail - no literal default
	throw new AgentHiveConfigError(
		"Daemon URL not configured. Set AGENTHIVE_DAEMON_URL environment variable.",
	);
}

/**
 * Get the control plane port.
 * Common helper for extracting port from resolved URLs.
 *
 * @returns The control plane port number
 * @throws AgentHiveConfigError if port cannot be determined
 */
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

/**
 * Clear cached endpoint URLs.
 * Useful for testing and when pg_notify('runtime_endpoint_changed') fires.
 *
 * @internal
 */
export function clearEndpointCache(): void {
	mcpUrlCache = null;
	daemonUrlCache = null;
}

// ─── P787: Async DB-backed endpoint registry ──────────────────────────────────

let _endpointCache = new Map<string, string>();
let _cachePopulated = false;

async function _populateCache(): Promise<void> {
	try {
		// Bridge: queries agenthive.roadmap.control_runtime_service (migration 056-p787).
		// Canonical target: hiveCentral core.control_runtime_service (001-core.sql).
		// TODO(P501): switch to hiveCentral query after control-plane cutover.
		const result = await query(
			`SELECT service_key, url FROM roadmap.control_runtime_service WHERE is_active = true`,
		);
		_endpointCache = new Map(
			result.rows.map((r: any) => [r.service_key as string, r.url as string]),
		);
		_cachePopulated = true;
	} catch (err) {
		// Table may not exist yet in some environments; treat as empty registry
		_cachePopulated = true;
	}
}

/**
 * Flush the async DB endpoint cache.
 * Call on pg_notify('runtime_endpoint_changed') or after a config change.
 */
export function invalidateEndpointCache(): void {
	_endpointCache.clear();
	_cachePopulated = false;
}

async function getFromRegistry(key: string): Promise<string | null> {
	if (!_cachePopulated) await _populateCache();
	return _endpointCache.get(key) ?? null;
}

/**
 * Resolve the MCP endpoint URL (async, with DB fallback — P787).
 *
 * Resolution:
 * 1. MCP_URL environment variable
 * 2. roadmap.control_runtime_service row with service_key='mcp'
 * 3. Throws if unresolvable
 */
export async function getMcpUrlAsync(): Promise<string> {
	if (process.env.MCP_URL) return process.env.MCP_URL;
	const dbUrl = await getFromRegistry("mcp");
	if (dbUrl) return dbUrl;
	throw new Error(
		"MCP URL not configured: set MCP_URL env or add a control_runtime_service row",
	);
}

/**
 * Resolve the daemon endpoint URL (async, with DB fallback — P787).
 *
 * Resolution:
 * 1. DAEMON_URL environment variable
 * 2. roadmap.control_runtime_service row with service_key='daemon'
 * 3. Throws if unresolvable
 */
export async function getDaemonUrlAsync(): Promise<string> {
	if (process.env.DAEMON_URL) return process.env.DAEMON_URL;
	const dbUrl = await getFromRegistry("daemon");
	if (dbUrl) return dbUrl;
	throw new Error(
		"Daemon URL not configured: set DAEMON_URL env or add a control_runtime_service row",
	);
}

/**
 * TODO(P787): When P431 lands and control_runtime.service table exists,
 * implement pg_notify listener:
 * client.query('LISTEN runtime_endpoint_changed');
 * client.on('notification', (msg) => {
 *   if (msg.channel === 'runtime_endpoint_changed') {
 *     invalidateEndpointCache();
 *     clearEndpointCache();
 *   }
 * });
 */
