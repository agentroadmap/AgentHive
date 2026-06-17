/**
 * Canonical ConfigKey category taxonomy — CLOSED 16-member set.
 *
 * This is the single source of truth for config categorisation.
 * Both the ConfigKey<T> interface (TS type) and the core.runtime_flag DB column
 * (CHECK constraint in migration 255-p3782-config-category.sql) are derived from
 * this array.  Adding a new category requires a code change here + a migration to
 * extend the DB CHECK in lockstep.
 *
 * Category → canonical meaning:
 *   database          — PG connection params, DSNs, per-tenant DB pointers
 *   connection_pool   — PgBouncer / pool sizing, keepAlive, idle timeouts
 *   vault_secret      — secret resolution, key-version retention, TTLs
 *   mcp_endpoint      — daemon URLs, worktree paths, A2A host/relay addresses
 *   orchestrator      — dispatch loop timings, heartbeat, offer caps, stall thresholds
 *   dispatch          — offer lifecycle, agency-claim limits, push toggles
 *   liaison           — liaison context refresh, LLM timeout, self-claim allowlist
 *   pause_backoff     — failure/backoff windows, multipliers, max intervals
 *   provider_quota    — per-provider spawn caps, retry limits, fair-share weights
 *   adaptive_matcher  — difficulty signal, Beta-Bernoulli reliability ledger params
 *   gate_governance   — AC invariant enforcement, state-monitor grace periods
 *   multi_tenant      — project scoping, tenant provisioning, ENABLE_MULTI_TENANT
 *   model_routing     — default provider, model tiers, KB embedding model
 *   audit             — mutation logging, ENABLE_AUDIT_LOG, retention
 *   ui_ux             — TUI cockpit layout, dashboard preferences
 *   diagnostic        — DEBUG flags, PG debug tracing, state-names logging
 */
export const CONFIG_CATEGORIES = [
	"database",
	"connection_pool",
	"vault_secret",
	"mcp_endpoint",
	"orchestrator",
	"dispatch",
	"liaison",
	"pause_backoff",
	"provider_quota",
	"adaptive_matcher",
	"gate_governance",
	"multi_tenant",
	"model_routing",
	"audit",
	"ui_ux",
	"diagnostic",
] as const;

export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];
