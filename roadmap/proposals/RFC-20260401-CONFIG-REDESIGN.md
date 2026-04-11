---
id: RFC-20260401-CONFIG-REDESIGN
display_id: TEC-20260401-CONFIG-REDESIGN
proposal_type: TECHNICAL
category: INFRA
domain_id: ENGINE
title: "Config.yml Redesign for Critical Infrastructure Info"
status: Draft
maturity: 0
summary: "Redesign config.yml to include MCP server URL, port, SDB database name, and other critical infrastructure info."
---

# Config.yml Redesign for Critical Infrastructure Info

## Problem
The current `config.yml` lacks critical infrastructure information:
- MCP server URL and port
- SpacetimeDB database name
- Git remote URL
- Health check endpoints

## Proposed Config Structure

```yaml
project_name: "AgentRoadmap"

# Global Settings (set during init)
database:
  provider: "spacetime"
  name: "roadmap2"
  host: "127.0.0.1"
  port: 3000

mcp:
  url: "http://localhost:6421"
  health_endpoint: "/health"
  tools_count: 40

git:
  remote: "gitlab.local:agentRoadmap/agentRoadmap.git"
  default_branch: "main"
  worktree_path: "/data/code/agentRoadmap-carter"

paths:
  proposals: "roadmap/proposals"
  archive: "roadmap/archive"
  docs: "roadmap/docs"

# Lifecycle (set during init)
default_status: "New"
statuses: ["New", "Draft", "Review", "Active", "Accepted", "Complete", "Rejected", "Abandoned"]
labels: ["feature", "bugfix", "refactor", "docs"]
date_format: yyyy-mm-dd
max_column_width: 80
auto_open_browser: true
default_port: 6420
remote_operations: true
auto_commit: true
zero_padded_ids: 3
bypass_git_hooks: false
check_active_branches: true
active_branch_days: 30
proposal: "proposal"

# Components (16 total, populated during init)
components:
  data_model:
    enabled: true
    maturity: 2
    description: "Schema definitions and data structure"
    
  mcp_tools:
    enabled: true
    maturity: 2
    port: 6421
    url: "http://localhost:6421"
    description: "Agent interface for tools and resources"
    
  workforce:
    enabled: true
    maturity: 2
    description: "Agent identity, registration, profiles"
    
  security:
    enabled: true
    maturity: 0
    description: "ACL, audit logging, authorization"
    
  product:
    enabled: true
    maturity: 1
    description: "RFC template, state machine, lifecycle"
    
  pipeline:
    enabled: true
    maturity: 0
    description: "Pre-flight checks, verification"
    
  business:
    enabled: true
    maturity: 0
    description: "Strategy, design, vision"
    
  spending:
    enabled: true
    maturity: 0
    description: "Budget limits, model allocation"
    
  model:
    enabled: true
    maturity: 0
    description: "Model selection, cost optimization"
    
  messaging:
    enabled: true
    maturity: 0
    description: "Inter-agent communication"
    
  tui:
    enabled: true
    maturity: 0
    description: "Terminal UI, cockpit"
    
  websash:
    enabled: true
    maturity: 0
    description: "Web dashboard"
    
  mobile:
    enabled: true
    maturity: 0
    description: "Mobile alerts, visionary"
    
  project:
    enabled: true
    maturity: 0
    description: "Project management, init"
    
  context:
    enabled: true
    maturity: 0
    description: "Session context, memory"
    
  infrastructure:
    enabled: true
    maturity: 0
    description: "Deployment, hosting, monitoring"
```

## Benefits
1. Single source of truth for all infrastructure
2. MCP server reads config instead of hardcoding
3. Easy to change database or MCP URL
4. Self-documenting configuration

## Implementation
1. Update `config.yml` with new structure
2. Update MCP server to read from config
3. Update TypeScript code to use config values
4. Add validation for required fields
