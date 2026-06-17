/**
 * ServerContext — the injected dependency bundle shared by extracted router
 * modules (P3796 monolith decomposition, Phase 1).
 *
 * `RoadmapServer` builds a `ServerContext` from its own fields and passes it to
 * route handler modules (e.g. `routes/system.ts`) so those modules do not need
 * a reference to the whole server instance. This keeps router modules decoupled
 * and avoids a circular import on `index.ts`.
 *
 * Type-only imports are used for `Core` so this module never creates a runtime
 * import cycle with `roadmap.ts`.
 */
import type { SearchService } from "../../core/infrastructure/search-service.ts";
import type { McpServer } from "../../mcp/server.ts";
import type { Core } from "../../core/roadmap.ts";
import type { ContentStore } from "../../core/storage/content-store.ts";

/** Resolved per-request project scope (P477). */
export interface ProjectScope {
	project_id: number;
	project_slug: string;
	project_name: string;
}

/**
 * Dependencies injected into extracted route handler modules. Mirrors the
 * subset of `RoadmapServer` state/behaviour those handlers rely on.
 */
export interface ServerContext {
	/** Core roadmap engine (filesystem + Postgres backed). */
	core: Core;
	/** Full-text search service; null until the content store is ready. */
	searchService: SearchService | null;
	/** Content store backing search/indexing; null until initialised. */
	contentStore: ContentStore | null;
	/** MCP server instance; null until started. */
	mcpServer: McpServer | null;
	/** Timestamp when the HTTP server started. */
	startedAt: Date;
	/** Current human-readable project name. */
	getProjectName: () => string;
	/** Update the in-memory project name (e.g. after /api/init or /api/config PUT). */
	setProjectName: (name: string) => void;
	/** Notify all SSE-connected dashboard clients that proposal data has changed. */
	broadcastProposalsUpdated: () => void;
	/** Resolve the project scope for an incoming request (header/query/default). */
	resolveProjectScope: (req: Request) => Promise<ProjectScope>;
	/** Convert an unexpected error into a 500 Response (with logging). */
	handleError: (error: Error) => Response;
}
