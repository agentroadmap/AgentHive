/**
 * Machine-readable command tree schema for `hive --schema`.
 * AI agents call this once at session start to understand the full CLI surface.
 * Any agent that reads this schema can discover every command, flag, and format.
 */

import { SCHEMA_VERSION } from "./common/envelope.ts";

export const CLI_VERSION = "0.5.0";
export const MCP_PROTOCOL_VERSION = "1.0";

export interface FlagDef {
  name: string;
  short?: string;
  type: "string" | "boolean" | "number";
  default?: string | boolean | number;
  description: string;
  required?: boolean;
}

export interface CommandDef {
  name: string;
  description: string;
  subcommands?: CommandDef[];
  flags?: FlagDef[];
  args?: Array<{ name: string; required: boolean; description: string }>;
  formats?: string[];
  exit_codes?: Record<string, number>;
  mutation?: boolean;
  requires_yes?: boolean;
  requires_really_yes?: boolean;
}

const COMMON_FLAGS: FlagDef[] = [
  { name: "--format", short: "-o", type: "string", default: "text", description: "Output format: text|json|jsonl|yaml|sarif" },
  { name: "--quiet", short: "-q", type: "boolean", default: false, description: "Suppress output" },
  { name: "--project", type: "string", description: "Project slug override (also: HIVE_PROJECT env)" },
  { name: "--idempotency-key", type: "string", description: "UUID idempotency key for mutating commands" },
  { name: "--explain", type: "boolean", default: false, description: "Print the plan before executing (dry-run commentary)" },
];

const PAGINATION_FLAGS: FlagDef[] = [
  { name: "--limit", type: "number", default: 20, description: "Maximum results per page" },
  { name: "--cursor", type: "string", description: "Pagination cursor from previous response next_cursor" },
];

export const COMMAND_TREE: CommandDef[] = [
  // Root-level universals
  {
    name: "status",
    description: "Project-scoped operational status (proposals by state, leases, active dispatches)",
    flags: [...COMMON_FLAGS, { name: "--project", type: "string", description: "Project slug override" }],
    formats: ["text", "json", "jsonl", "yaml"],
  },
  {
    name: "context",
    description: "Show resolved runtime context (project, agency, host, MCP URL)",
    flags: COMMON_FLAGS,
    formats: ["text", "json", "jsonl", "yaml"],
  },
  {
    name: "init",
    description: "Register project in control plane, seed proposals, set governance",
    flags: [
      ...COMMON_FLAGS,
      { name: "--name", type: "string", description: "Project display name" },
      { name: "--repo", type: "string", description: "Repo root path" },
      { name: "--db-host", type: "string", description: "Postgres host for tenant DB" },
      { name: "--db-port", type: "number", description: "Postgres port for tenant DB" },
      { name: "--yes", type: "boolean", description: "Skip confirmation" },
    ],
    mutation: true,
    requires_yes: true,
    formats: ["text", "json"],
  },
  {
    name: "doctor",
    description: "Run 12+ readiness checks: DB, MCP, schema, routes, budget, Git, Node version",
    flags: [
      ...COMMON_FLAGS,
      { name: "--check", type: "string", description: "Run only checks whose name contains the given substring" },
      { name: "--fix", type: "boolean", description: "Attempt automated remediation" },
      { name: "--remediate", type: "boolean", description: "Alias for --fix" },
      { name: "--verbose", type: "boolean", description: "Show remediation detail per check" },
      { name: "--json", type: "boolean", description: "Shorthand for --format json" },
    ],
    formats: ["text", "json", "jsonl", "yaml"],
    exit_codes: { "0": 0, "warnings_only": 1, "errors": 5 },
  },
  {
    name: "version",
    description: "Print CLI version and MCP protocol version",
    formats: ["text", "json"],
  },
  {
    name: "completion",
    description: "Shell completion script generation",
    args: [{ name: "shell", required: true, description: "bash | zsh | fish | powershell" }],
    flags: [{ name: "--install", type: "boolean", description: "Auto-install into shell profile" }],
  },
  {
    name: "help",
    description: "Extended help on a topic",
    args: [{ name: "topic", required: false, description: "workflows | recipes | context | credentials" }],
  },
  // Proposal domain
  {
    name: "proposal",
    description: "Proposal CRUD, lifecycle, and gating operations",
    subcommands: [
      {
        name: "list",
        description: "List proposals with optional filters",
        flags: [
          ...COMMON_FLAGS,
          ...PAGINATION_FLAGS,
          { name: "--state", type: "string", description: "DRAFT|REVIEW|DEVELOP|MERGE|COMPLETE" },
          { name: "--type", type: "string", description: "product|component|feature|issue|hotfix" },
          { name: "--owner", type: "string", description: "Agency slug filter" },
        ],
        formats: ["text", "json", "jsonl", "yaml"],
      },
      {
        name: "get",
        description: "Fetch proposal full state",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [
          ...COMMON_FLAGS,
          { name: "--include", type: "string", description: "Comma-separated: leases,dispatches,events,reviews,ac" },
          { name: "--raw", type: "boolean", description: "Print raw MCP response" },
        ],
        formats: ["text", "json", "jsonl", "yaml"],
        exit_codes: { NOT_FOUND: 2, REMOTE_FAILURE: 5 },
      },
      {
        name: "show",
        description: "Human-friendly view (alias for get)",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [
          ...COMMON_FLAGS,
          { name: "--include", type: "string", description: "full|leases|dispatches|runs|events|versions" },
        ],
        formats: ["text", "json", "jsonl", "yaml"],
      },
      {
        name: "next",
        description: "Show the next actionable proposal for this agency",
        flags: COMMON_FLAGS,
        formats: ["text", "json", "jsonl", "yaml"],
      },
      {
        name: "create",
        description: "Create a proposal in the current project",
        flags: [
          ...COMMON_FLAGS,
          { name: "--type", type: "string", description: "product|component|feature|issue|hotfix" },
          { name: "--title", type: "string", description: "Proposal title" },
          { name: "--body", type: "string", description: "Proposal body (inline)" },
          { name: "--stdin", type: "boolean", description: "Read body from stdin" },
        ],
        mutation: true,
        formats: ["text", "json"],
        exit_codes: { OK: 0, USAGE: 1, TYPE_UNKNOWN: 2 },
      },
      {
        name: "edit",
        description: "Update proposal title, body, or type",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [
          ...COMMON_FLAGS,
          { name: "--title", type: "string", description: "New title" },
          { name: "--body", type: "string", description: "New body (inline)" },
          { name: "--stdin", type: "boolean", description: "Read body from stdin" },
          { name: "--type", type: "string", description: "New type" },
        ],
        mutation: true,
        formats: ["text", "json"],
      },
      {
        name: "claim",
        description: "Acquire a work lease on a proposal",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [
          ...COMMON_FLAGS,
          { name: "--duration-minutes", type: "number", default: 120, description: "Lease duration" },
          { name: "--yes", type: "boolean", description: "Skip confirmation" },
        ],
        mutation: true,
        exit_codes: { OK: 0, PERMISSION_DENIED: 3, CONFLICT: 4 },
      },
      {
        name: "release",
        description: "Release a work lease early",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [...COMMON_FLAGS, { name: "--with-message", type: "string", description: "Discussion entry" }],
        mutation: true,
      },
      {
        name: "transition",
        description: "Move proposal between workflow states",
        args: [
          { name: "proposal_id", required: true, description: "e.g. P123" },
          { name: "new_state", required: true, description: "Target state from control plane" },
        ],
        flags: [...COMMON_FLAGS, { name: "--with-message", type: "string", description: "Transition rationale" }],
        mutation: true,
      },
      {
        name: "maturity",
        description: "Set maturity within the current state (new|active|mature|obsolete)",
        args: [
          { name: "proposal_id", required: true, description: "e.g. P123" },
          { name: "maturity", required: true, description: "new|active|mature|obsolete" },
        ],
        flags: [...COMMON_FLAGS, { name: "--with-message", type: "string", description: "Maturity change rationale" }],
        mutation: true,
      },
      {
        name: "depend",
        description: "Add a DAG dependency edge between proposals",
        args: [{ name: "proposal_id", required: true, description: "Dependent proposal" }],
        flags: [
          ...COMMON_FLAGS,
          { name: "--on", type: "string", required: true, description: "Dependency proposal ID" },
          { name: "--type", type: "string", description: "blocks|blocked-by|relates-to" },
          { name: "--with-message", type: "string", description: "Rationale" },
        ],
        mutation: true,
      },
      {
        name: "ac",
        description: "Acceptance criteria management",
        subcommands: [
          {
            name: "list",
            description: "List ACs for a proposal",
            args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
            flags: [...COMMON_FLAGS, { name: "--status", type: "string", description: "pending|satisfied|failed" }],
          },
          {
            name: "add",
            description: "Add an acceptance criterion",
            args: [
              { name: "proposal_id", required: true, description: "e.g. P123" },
              { name: "ac_id", required: true, description: "Human-readable slug" },
            ],
            flags: [
              ...COMMON_FLAGS,
              { name: "--body", type: "string", description: "Criterion text" },
              { name: "--stdin", type: "boolean", description: "Read body from stdin" },
              { name: "--verification-type", type: "string", default: "manual", description: "manual|test|script" },
            ],
            mutation: true,
          },
          {
            name: "verify",
            description: "Mark AC as satisfied or failed",
            args: [
              { name: "proposal_id", required: true, description: "e.g. P123" },
              { name: "ac_id", required: true, description: "AC slug" },
            ],
            flags: [
              ...COMMON_FLAGS,
              { name: "--status", type: "string", description: "satisfied|failed" },
              { name: "--log", type: "string", description: "Evidence attachment" },
              { name: "--evidence-url", type: "string", description: "External evidence URL" },
              { name: "--with-message", type: "string", description: "Verification note" },
            ],
            mutation: true,
          },
        ],
      },
      {
        name: "review",
        description: "Submit a gating review for a proposal",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [
          ...COMMON_FLAGS,
          { name: "--ready-for-merge", type: "boolean", description: "Approve for merge" },
          { name: "--recommend-draft", type: "boolean", description: "Send back to draft" },
          { name: "--focus", type: "string", description: "Review focus domain (security, performance, ...)" },
          { name: "--with-message", type: "string", description: "Review body" },
          { name: "--stdin", type: "boolean", description: "Read body from stdin" },
        ],
        mutation: true,
      },
      {
        name: "discuss",
        description: "Add a discussion entry to a proposal thread",
        args: [
          { name: "proposal_id", required: true, description: "e.g. P123" },
          { name: "context_prefix", required: true, description: "e.g. gate-decision: or handoff:" },
        ],
        flags: [...COMMON_FLAGS, { name: "--body", type: "string", description: "Discussion body" }, { name: "--stdin", type: "boolean", description: "Read body from stdin" }],
        mutation: true,
      },
    ],
  },
  // Workflow domain
  {
    name: "workflow",
    description: "Workflow template and state machine inspection",
    subcommands: [
      {
        name: "list",
        description: "List all workflow templates",
        flags: COMMON_FLAGS,
      },
      {
        name: "show",
        description: "Show a workflow template state machine",
        args: [{ name: "template", required: true, description: "e.g. rfc, hotfix" }],
        flags: COMMON_FLAGS,
      },
      {
        name: "gates",
        description: "Show gating rules and AC schema for workflow states",
        flags: [...COMMON_FLAGS, { name: "--state", type: "string", description: "Filter to specific state" }],
      },
    ],
  },
  // State inspection
  {
    name: "state",
    description: "State transition inspection for proposals",
    subcommands: [
      {
        name: "next",
        description: "Show valid next states for a proposal",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [...COMMON_FLAGS, { name: "--verbose", type: "boolean", description: "Include transition rules" }],
      },
      {
        name: "history",
        description: "Show state transition history",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS],
      },
    ],
  },
  // Dispatch domain
  {
    name: "dispatch",
    description: "Work dispatch inspection and lifecycle operations",
    subcommands: [
      {
        name: "list",
        description: "List dispatches with optional filters",
        flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS, { name: "--status", type: "string", description: "assigned|active|blocked|completed|cancelled|failed" }, { name: "--proposal", type: "string", description: "Filter by proposal ID" }],
        formats: ["text", "json", "jsonl", "yaml"],
      },
      {
        name: "show",
        description: "Show a single dispatch with optional relations",
        args: [{ name: "id", required: true, description: "Dispatch UUID" }],
        flags: [...COMMON_FLAGS, { name: "--include", type: "string", description: "offers|claims|runs|events" }],
        formats: ["text", "json", "jsonl", "yaml"],
      },
      {
        name: "queue",
        description: "Show current dispatch queue (pending/ready dispatches)",
        flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS],
        formats: ["text", "json", "jsonl", "yaml"],
      },
      {
        name: "offer",
        description: "Create an offer for a proposal dispatch",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [...COMMON_FLAGS, { name: "--squad", type: "string", description: "Target squad identity" }, { name: "--role", type: "string", description: "Required role" }, { name: "--idempotency-key", type: "string", description: "Idempotency key" }],
        mutation: true,
      },
      {
        name: "transition",
        description: "Transition a dispatch to a new state",
        args: [{ name: "id", required: true, description: "Dispatch UUID" }],
        flags: [...COMMON_FLAGS, { name: "--to", type: "string", required: true, description: "Target state" }],
        mutation: true,
      },
    ],
  },
  // Agency / workforce domains
  {
    name: "agency",
    description: "Agency (squad) management and status",
    subcommands: [
      { name: "list", description: "List all agencies", flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS, { name: "--status", type: "string", description: "Filter by status" }], formats: ["text", "json", "jsonl", "yaml"] },
      { name: "show", description: "Show a single agency", args: [{ name: "agency_id", required: true, description: "Agency slug or ID" }], flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "stop", description: "Drain and stop an agency", args: [{ name: "agency_id", required: true, description: "Agency ID" }], flags: [...COMMON_FLAGS, { name: "--yes", type: "boolean", description: "Skip confirmation" }], mutation: true, requires_yes: true },
    ],
  },
  {
    name: "worker",
    description: "Worker (agent) registration and status",
    subcommands: [
      { name: "list", description: "List registered workers", flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS, { name: "--agency", type: "string", description: "Filter by agency" }], formats: ["text", "json", "jsonl", "yaml"] },
      { name: "show", description: "Show worker details", args: [{ name: "worker_id", required: true, description: "Worker identity" }], flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  {
    name: "lease",
    description: "Proposal lease inspection and management",
    subcommands: [
      { name: "list", description: "List active leases", flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS, { name: "--agent", type: "string", description: "Filter by agent identity" }], formats: ["text", "json", "jsonl", "yaml"] },
      { name: "show", description: "Show a single lease", args: [{ name: "lease_id", required: true, description: "Lease ID" }], flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "release", description: "Force-release a lease", args: [{ name: "lease_id", required: true, description: "Lease ID" }], flags: [...COMMON_FLAGS, { name: "--reason", type: "string", description: "Release reason" }, { name: "--yes", type: "boolean", description: "Skip confirmation" }], mutation: true, requires_yes: true },
    ],
  },
  {
    name: "trust",
    description: "Inter-agent trust and credential management",
    subcommands: [
      { name: "list", description: "List trust relationships", flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS], formats: ["text", "json", "jsonl", "yaml"] },
      { name: "grant", description: "Grant trust to an agent", args: [{ name: "agent_id", required: true, description: "Agent identity" }], flags: [...COMMON_FLAGS, { name: "--level", type: "string", description: "Trust level (read|write|admin)" }, { name: "--yes", type: "boolean", description: "Skip confirmation" }], mutation: true },
      { name: "revoke", description: "Revoke trust from an agent", args: [{ name: "agent_id", required: true, description: "Agent identity" }], flags: [...COMMON_FLAGS, { name: "--yes", type: "boolean", description: "Skip confirmation" }], mutation: true, requires_yes: true },
    ],
  },
  // Provider / model / routing
  {
    name: "provider",
    description: "LLM provider inspection",
    subcommands: [
      { name: "list", description: "List all providers", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "show", description: "Show provider details", args: [{ name: "provider_id", required: true, description: "Provider slug" }], flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  {
    name: "model",
    description: "LLM model registry and cost inspection",
    subcommands: [
      { name: "list", description: "List all models", flags: [...COMMON_FLAGS, { name: "--provider", type: "string", description: "Filter by provider" }, { name: "--tier", type: "string", description: "Filter by tier" }], formats: ["text", "json", "jsonl", "yaml"] },
      { name: "show", description: "Show model details and routes", args: [{ name: "model_id", required: true, description: "Model name" }], flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "costs", description: "Show model cost table", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  {
    name: "route",
    description: "Model dispatch route management",
    subcommands: [
      { name: "list", description: "List all routes", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "show", description: "Show route details", args: [{ name: "route_id", required: true, description: "Route ID" }], flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "test", description: "Test a route for liveness", args: [{ name: "route_id", required: true, description: "Route ID" }], flags: COMMON_FLAGS },
    ],
  },
  {
    name: "budget",
    description: "Project budget cap and spend inspection",
    subcommands: [
      { name: "status", description: "Show current budget status", flags: [...COMMON_FLAGS, { name: "--project", type: "string", description: "Project slug override" }], formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  {
    name: "context-policy",
    description: "Context window and token budget policy management",
    subcommands: [
      { name: "list", description: "List context policies", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  // System / ops
  {
    name: "service",
    description: "System service status and management",
    subcommands: [
      { name: "list", description: "List registered services", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "status", description: "Show overall system status", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  {
    name: "mcp",
    description: "MCP server connection and tool inspection",
    subcommands: [
      { name: "status", description: "Show MCP server status", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "tools", description: "List available MCP tools", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  {
    name: "db",
    description: "Control-plane database inspection",
    subcommands: [
      { name: "status", description: "Show DB connection status", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "schemas", description: "List DB schemas", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  // Quality / audit
  {
    name: "scan",
    description: "Static analysis and hardcoding violation scanner",
    flags: [
      ...COMMON_FLAGS,
      { name: "--git-staged", type: "boolean", description: "Scan only git-staged files" },
      { name: "--fail-on", type: "string", description: "Minimum severity to fail: low|medium|high" },
      { name: "--paths", type: "string", description: "Comma-separated paths to scan" },
    ],
    formats: ["text", "json", "sarif"],
  },
  {
    name: "lint",
    description: "Proposal and workflow lint checks",
    subcommands: [
      { name: "proposal", description: "Lint a proposal for RFC compliance", args: [{ name: "proposal_id", required: true, description: "e.g. P123" }], flags: COMMON_FLAGS, formats: ["text", "json"] },
    ],
  },
  {
    name: "audit",
    description: "Audit trail inspection",
    subcommands: [
      { name: "feed", description: "Stream recent audit events", flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS, { name: "--since", type: "string", description: "Time window (e.g. 1h, 4h, 24h)" }, { name: "--actor", type: "string", description: "Filter by actor identity" }], formats: ["text", "json", "jsonl", "yaml"] },
      { name: "search", description: "Search audit events", flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS, { name: "--query", type: "string", description: "Search query" }], formats: ["text", "json", "jsonl", "yaml"] },
    ],
  },
  // Knowledge / memory
  {
    name: "kb",
    description: "Knowledge base management",
    subcommands: [
      { name: "list", description: "List knowledge entries", flags: [...COMMON_FLAGS, ...PAGINATION_FLAGS], formats: ["text", "json", "jsonl", "yaml"] },
      { name: "get", description: "Get a knowledge entry", args: [{ name: "entry_id", required: true, description: "Entry slug or ID" }], flags: COMMON_FLAGS, formats: ["text", "json"] },
    ],
  },
  // Project / workspace
  {
    name: "project",
    description: "Project management",
    subcommands: [
      { name: "list", description: "List all projects", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "show", description: "Show project details", args: [{ name: "project_id", required: true, description: "Project slug" }], flags: COMMON_FLAGS, formats: ["text", "json"] },
      { name: "register", description: "Register a new project", flags: [...COMMON_FLAGS, { name: "--name", type: "string", description: "Project name" }, { name: "--slug", type: "string", description: "Project slug" }, { name: "--yes", type: "boolean", description: "Skip confirmation" }], mutation: true, requires_yes: true },
      { name: "archive", description: "Archive a project", args: [{ name: "project_id", required: true, description: "Project slug" }], flags: [...COMMON_FLAGS, { name: "--yes", type: "boolean", description: "Skip confirmation" }], mutation: true, requires_yes: true },
    ],
  },
  {
    name: "cubic",
    description: "Cubic workspace and worktree management",
    subcommands: [
      { name: "list", description: "List cubic workspaces", flags: COMMON_FLAGS, formats: ["text", "json", "jsonl", "yaml"] },
      { name: "show", description: "Show a cubic workspace", args: [{ name: "cubic_id", required: true, description: "Cubic workspace ID" }], flags: COMMON_FLAGS, formats: ["text", "json"] },
    ],
  },
  // Stop (operator)
  {
    name: "stop",
    description: "Cancel, drain, or offline a running component (op/admin only, requires --yes)",
    subcommands: [
      {
        name: "dispatch",
        description: "Cancel a single dispatch (no retry)",
        args: [{ name: "dispatch_id", required: true, description: "Dispatch UUID" }],
        flags: [...COMMON_FLAGS, { name: "--reason", type: "string", description: "Cancellation reason" }, { name: "--yes", type: "boolean", description: "Skip confirmation" }],
        mutation: true,
        requires_yes: true,
      },
      {
        name: "proposal",
        description: "Cancel all active dispatches for a proposal",
        args: [{ name: "proposal_id", required: true, description: "e.g. P123" }],
        flags: [...COMMON_FLAGS, { name: "--reason", type: "string", description: "Cancellation reason" }, { name: "--yes", type: "boolean", description: "Skip confirmation" }],
        mutation: true,
        requires_yes: true,
      },
      {
        name: "all",
        description: "PANIC: stop all dispatches system-wide",
        flags: [
          ...COMMON_FLAGS,
          { name: "--reason", type: "string", required: true, description: "Reason for stopping all dispatches" },
          { name: "--yes", type: "boolean", required: true, description: "Confirm action" },
          { name: "--really-yes", type: "boolean", required: true, description: "Double-confirm PANIC action" },
        ],
        mutation: true,
        requires_yes: true,
        requires_really_yes: true,
      },
    ],
  },
];

export interface CliSchema {
  schema_version: number;
  cli_version: string;
  mcp_protocol_version: string;
  commands: CommandDef[];
}

export function getCliSchema(): CliSchema {
  return {
    schema_version: SCHEMA_VERSION,
    cli_version: CLI_VERSION,
    mcp_protocol_version: MCP_PROTOCOL_VERSION,
    commands: COMMAND_TREE,
  };
}

/** Curated multi-step workflow recipes for AI agents. */
export interface Recipe {
  name: string;
  description: string;
  steps: Array<{ command: string; description: string }>;
}

export const RECIPES: Recipe[] = [
  {
    name: "claim-and-develop",
    description: "Claim the next available proposal, develop it, and advance to mature",
    steps: [
      { command: "hive proposal next --format json", description: "Find the next actionable proposal" },
      { command: "hive proposal claim <P###> --format json", description: "Acquire work lease" },
      { command: "hive proposal ac list <P###> --format json", description: "List acceptance criteria to address" },
      { command: "hive proposal ac verify <P###> <ac-id> --status satisfied --format json", description: "Mark ACs satisfied as work completes" },
      { command: "hive proposal maturity <P###> mature --format json", description: "Advance to mature to trigger gate review" },
    ],
  },
  {
    name: "health-check",
    description: "Full system health check before starting work",
    steps: [
      { command: "hive context --format json", description: "Confirm project/agency context" },
      { command: "hive doctor --format json", description: "Run readiness checks" },
      { command: "hive workflow list --format json", description: "Confirm workflow templates loaded" },
    ],
  },
  {
    name: "investigate-stuck-proposal",
    description: "Diagnose why a proposal is stuck or not progressing",
    steps: [
      { command: "hive proposal show <P###> --include leases,dispatches,events --format json", description: "Full proposal state in one round-trip" },
      { command: "hive state history <P###> --format json", description: "View transition history" },
      { command: "hive state next <P###> --format json", description: "Check valid next states" },
    ],
  },
  {
    name: "operator-stop-runaway",
    description: "Stop a runaway dispatch and cancel its proposal",
    steps: [
      { command: "hive dispatch show <DISPATCH_ID> --format json", description: "Inspect the runaway dispatch" },
      { command: "hive stop dispatch <DISPATCH_ID> --reason 'budget overrun' --yes", description: "Cancel the dispatch" },
      { command: "hive audit feed --since 1h --format json", description: "Verify audit trail" },
    ],
  },
  {
    name: "new-project-bootstrap",
    description: "Register a new project and seed initial governance proposals",
    steps: [
      { command: "hive init --name 'My Project' --repo /path/to/repo --yes", description: "Register project in control plane" },
      { command: "hive context --format json", description: "Verify context was resolved" },
      { command: "hive proposal list --state DRAFT --format json", description: "See seeded governance proposals" },
      { command: "hive doctor --format json", description: "Confirm all systems healthy" },
    ],
  },
  {
    name: "audit-before-commit",
    description: "Run quality scan and view audit feed before committing code",
    steps: [
      { command: "hive scan --git-staged --fail-on high", description: "Scan staged files for hardcoding violations" },
      { command: "hive audit feed --since 4h --format json", description: "Review recent operator actions" },
    ],
  },
];
