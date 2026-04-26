/**
 * Central URL resolution for MCP and daemon endpoints.
 *
 * Resolution order:
 * 1. Environment variable (AGENTHIVE_MCP_URL, AGENTHIVE_DAEMON_URL)
 * 2. control_runtime registry row (when P431 lands; for now tries and catches missing table)
 * 3. Hard fail with AgentHiveConfigError (no literal default)
 *
 * Values are cached per process; flushed on pg_notify('runtime_endpoint_changed') if/when P431 ships.
 */

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

/**
 * TODO: When P431 lands and control_runtime.service table exists,
 * implement registry query logic here:
 *
 * async function queryControlRuntimeRegistry(serviceType: 'mcp' | 'daemon'): Promise<string | null> {
 *   try {
 *     const client = new pg.Client(...);
 *     await client.connect();
 *     const result = await client.query(
 *       'SELECT url FROM control_runtime.service WHERE service_type = $1',
 *       [serviceType]
 *     );
 *     await client.end();
 *     return result.rows[0]?.url || null;
 *   } catch (err) {
 *     // Table likely doesn't exist yet
 *     return null;
 *   }
 * }
 *
 * Also implement pg_notify listener:
 * client.query('LISTEN runtime_endpoint_changed');
 * client.on('notification', (msg) => {
 *   if (msg.channel === 'runtime_endpoint_changed') {
 *     clearEndpointCache();
 *   }
 * });
 */
