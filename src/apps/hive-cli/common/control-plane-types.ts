/**
 * Type definitions for control-plane database rows.
 *
 * These types represent the shape of data returned by control-plane queries
 * (from `roadmap.project`, `roadmap_proposal.proposal`, etc.). They are used
 * by `ControlPlaneClient` to provide typed access to control-plane data.
 *
 * All types are read-only and represent the current state of the control plane.
 */

/**
 * A project row from `roadmap.project`.
 *
 * Represents a single project tenant and its metadata.
 */
export interface ProjectRow {
  project_id: number;
  slug: string;
  name: string;
  worktree_root: string;
  status: "active" | "archived";
  created_at: string; // ISO 8601 timestamp
  archived_at: string | null;
  db_name: string | null;
  db_role: string | null;
  schema_prefix: string | null;
  dsn_secret_ref: string | null;
  host: string;
  port: number;
  bootstrap_status: string;
  bootstrap_log: Record<string, unknown> | null;
  updated_at: string;
  git_remote_url?: string | null; // Optional; used for git-based project matching
}

/**
 * A proposal row from `roadmap_proposal.proposal`.
 *
 * Represents a single proposal in the RFC workflow.
 */
export interface ProposalRow {
  id: number;
  display_id: string;
  parent_id: number | null;
  type: string;
  status: string; // e.g., "Draft", "Review", "Develop", "Merge", "Complete"
  title: string;
  summary: string | null;
  motivation: string | null;
  design: string | null;
  drawbacks: string | null;
  alternatives: string | null;
  dependency_note: string | null;
  priority: string | null;
  maturity: string; // "new", "active", "mature", "obsolete"
  workflow_name: string | null;
  tags: Record<string, unknown> | null;
  audit: Record<string, unknown>;
  created_at: string; // ISO 8601
  modified_at: string;
  required_capabilities: Record<string, unknown>;
  project_id: number;
  gate_scanner_paused: boolean;
  gate_paused_by: string | null;
  gate_paused_at: string | null;
  gate_paused_reason: string | null;
}

/**
 * A workflow template row from `roadmap.workflow_templates`.
 *
 * Represents a state machine definition (e.g., "Standard RFC", "Hotfix"),
 * keyed by name and project. The smdl_definition jsonb is the canonical
 * stage/transition graph; the higher-level fields (version, stage_count,
 * is_default, is_system) are convenience metadata.
 */
export interface WorkflowTemplateRow {
  id: string; // bigint
  name: string;
  description: string | null;
  version: number | null;
  is_default: boolean;
  is_system: boolean;
  stage_count: number | null;
  smdl_id: string | null;
  smdl_definition: Record<string, unknown> | null;
  created_at: string;
  modified_at: string;
  project_id: string;
}

/**
 * An agency row from `roadmap.agency`.
 *
 * Represents a single agency (AI or human team). Today the agency table
 * is control-plane-only — no project_id column. Will become per-tenant
 * post-P429.
 */
export interface AgencyRow {
  agency_id: string; // text PK, e.g., "hermes/agency-xiaomi"
  display_name: string | null;
  provider: string | null;
  host_id: string | null;
  capability_tags: string[] | null;
  status: string;
  status_reason: string | null;
  last_heartbeat_at: string | null;
  registered_at: string;
  metadata: Record<string, unknown> | null;
}

/**
 * An agent registry row from `roadmap_workforce.agent_registry`.
 *
 * Represents a single project-scoped agent instance. The legacy
 * `roadmap.agent_registry` view has no project_id column; this client
 * always reads from the workforce schema.
 */
export interface AgentRow {
  id: string; // bigint
  agent_identity: string;
  agent_type: string | null;
  role: string | null;
  skills: string[] | null;
  preferred_model: string | null;
  status: string;
  github_handle: string | null;
  created_at: string;
  updated_at: string;
  project_id: string; // bigint
}

/**
 * A dispatch row from `roadmap_workforce.squad_dispatch`.
 *
 * Represents a single work dispatch (offer / claim / run).
 */
export interface DispatchRow {
  id: string; // bigint
  proposal_id: string;
  agent_identity: string | null;
  squad_name: string;
  dispatch_role: string;
  status: string; // mapped from dispatch_status
  offer_status: string;
  assigned_at: string;
  completed_at: string | null;
  claim_expires_at: string | null;
  claimed_at: string | null;
  project_id: string;
  metadata: Record<string, unknown>;
}

/**
 * A lease row from `roadmap.proposal_lease`.
 *
 * Active or historical claim by an agent on a proposal. No project_id
 * column today (control-plane); will gain one post-P429.
 */
export interface LeaseRow {
  id: string; // bigint
  proposal_id: string;
  agent_identity: string;
  claimed_at: string;
  expires_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  is_active: boolean;
}

/**
 * Paginated result wrapper for list operations.
 *
 * Implements cursor-based pagination for large result sets.
 */
export interface PaginatedResult<T> {
  /** The items in this page. */
  items: T[];

  /** Opaque cursor for fetching the next page. Null if this is the last page. */
  next_cursor: string | null;

  /** Total count of items matching the filter (if available from DB). */
  total_count?: number;

  /** Whether there are more pages. */
  has_more: boolean;
}

/**
 * Cursor pagination state (opaque to callers).
 *
 * Encoded as base64 JSON: `{ id_after: <id> }`
 */
export interface PaginationCursor {
  id_after: number;
}

/**
 * Helper to encode a cursor to base64.
 *
 * @param cursor - The cursor object to encode
 * @returns Base64-encoded cursor string
 */
export function encodeCursor(cursor: PaginationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64");
}

/**
 * Helper to decode a cursor from base64.
 *
 * @param cursorStr - The base64-encoded cursor string
 * @returns Decoded cursor object, or null if invalid
 */
export function decodeCursor(cursorStr: string): PaginationCursor | null {
  try {
    const json = Buffer.from(cursorStr, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
