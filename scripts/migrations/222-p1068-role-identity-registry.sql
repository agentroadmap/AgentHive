-- P1068: Role-Defined Subagent Identity — capability_taxonomy & role_definition tables
--
-- Two-table design:
-- 1. capability_taxonomy — index of role slugs to vendor paths and sync metadata
-- 2. role_definition — full Markdown content and parsed frontmatter for MCP delivery
--
-- The sync script (scripts/sync-agency-agents.sh) populates both tables from vendor/agency-agents/
-- Remote liaison processes fetch role_definition via mcp_agent.get_role_definition(role_slug)
-- Orchestrator-local agent-spawner.ts may read vendor files OR this table — both resolve identically

-- AC-1, AC-10: Create capability_taxonomy table — index of role slugs
CREATE TABLE IF NOT EXISTS roadmap_proposal.capability_taxonomy (
  role_slug      TEXT PRIMARY KEY,
  domain         TEXT NOT NULL,          -- 'engineering', 'testing', 'product', 'agenthive'
  vendor_path    TEXT NOT NULL,          -- relative path in vendor/agency-agents/ or vendor/agency-agents-local/
  synced_sha     TEXT,                   -- git commit SHA at last sync
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AC-10: Create role_definition table — content store for MCP delivery
CREATE TABLE IF NOT EXISTS roadmap_proposal.role_definition (
  role_slug      TEXT PRIMARY KEY REFERENCES roadmap_proposal.capability_taxonomy(role_slug) ON DELETE CASCADE,
  content_md     TEXT NOT NULL,        -- full Markdown file content
  content_hash   TEXT NOT NULL,        -- SHA-256 of content_md for drift detection
  frontmatter    JSONB,                -- parsed YAML frontmatter: name, description, emoji, color, vibe
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_sha     TEXT                  -- upstream commit SHA at sync time
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_capability_taxonomy_domain ON roadmap_proposal.capability_taxonomy(domain) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_capability_taxonomy_active ON roadmap_proposal.capability_taxonomy(is_active);
CREATE INDEX IF NOT EXISTS idx_role_definition_synced_at ON roadmap_proposal.role_definition(synced_at DESC);

-- AC-4: Add agent_capability table for agency capability declarations
-- Agencies declare the roles they support at registration
CREATE TABLE IF NOT EXISTS roadmap_proposal.agent_capability (
  agency_slug    TEXT NOT NULL,
  role_slug      TEXT NOT NULL REFERENCES roadmap_proposal.capability_taxonomy(role_slug) ON DELETE RESTRICT,
  declared_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_slug, role_slug)
);

CREATE INDEX IF NOT EXISTS idx_agent_capability_agency ON roadmap_proposal.agent_capability(agency_slug);
CREATE INDEX IF NOT EXISTS idx_agent_capability_role ON roadmap_proposal.agent_capability(role_slug);
