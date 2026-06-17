// Shared server context passed to extracted route handlers.
//
// Introduced during the Phase 1 monolith decomposition of
// src/apps/server/index.ts. Route handler functions receive a narrow
// `ServerContext` rather than the full `RoadmapServer` instance, which keeps
// them decoupled from the class and avoids circular dependencies.

import type { McpServer } from "../../mcp/server.ts";
import type { Core } from "../../core/roadmap.ts";

export interface ServerContext {
	/** The roadmap Core instance (filesystem, git, proposal ops, etc.). */
	core: Core;
	/** Timestamp the server process was constructed. */
	startedAt: Date;
	/** The MCP server instance, or null if not yet initialized. */
	mcpServer: McpServer | null;
}
