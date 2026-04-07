/**
 * Default directory structure for roadmap projects
 */
export const DEFAULT_DIRECTORIES = {
	/** Main roadmap directory */
	ROADMAP: "roadmap",
	/** Active proposals directory */
	STATES: "proposals",
	/** Draft proposals directory */
	DRAFTS: "drafts",
	/** Completed proposals directory */
	COMPLETED: "completed",
	/** Archive root directory */
	ARCHIVE: "archive",
	/** Archived proposals directory */
	ARCHIVE_STATES: "archive/proposals",
	/** Archived drafts directory */
	ARCHIVE_DRAFTS: "archive/drafts",
	/** Archived directives directory */
	ARCHIVE_MILESTONES: "archive/directives",
	/** Documentation directory */
	DOCS: "docs",
	/** Decision logs directory */
	DECISIONS: "decisions",
	/** Directives directory */
	MILESTONES: "directives",
} as const;

/**
 * Default configuration file names
 */
export const DEFAULT_FILES = {
	/** Main configuration file */
	CONFIG: "config.yml",
	/** Local user settings file */
	USER: ".user",
} as const;

/**
 * Default proposal statuses
 */
export const DEFAULT_STATUSES = [
	"Draft",
	"Review",
	"Building",
	"Accepted",
	"Complete",
	"Rejected",
	"Abandoned",
	"Replaced",
] as const;

/**
 * Fallback status when no default is configured
 */
export const FALLBACK_STATUS = "Draft";

/**
 * Maximum width for wrapped text lines in UI components
 */
export const WRAP_LIMIT = 72;

/**
 * Default values for advanced configuration options used during project initialization.
 * Shared between CLI and browser wizard to ensure consistent defaults.
 */
export const DEFAULT_INIT_CONFIG = {
	checkActiveBranches: true,
	remoteOperations: true,
	activeBranchDays: 30,
	bypassGitHooks: false,
	autoCommit: true,
	zeroPaddedIds: undefined as number | undefined,
	defaultEditor: undefined as string | undefined,
	defaultPort: 6420,
	autoOpenBrowser: true,
} as const;

/**
 * Default duration for proposal claims in minutes.
 * Used for lease-based claiming semantics.
 */
export const DEFAULT_CLAIM_DURATION_MINUTES = 60;

export {
	AGENT_GUIDELINES,
	CLAUDE_AGENT_CONTENT,
	CLAUDE_GUIDELINES,
	COPILOT_GUIDELINES,
	GEMINI_GUIDELINES,
	MCP_AGENT_NUDGE,
	README_GUIDELINES,
} from "../../guidelines/index.ts";
