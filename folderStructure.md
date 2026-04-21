```text
{project_root}/
├── roadmap.yaml            # The source of truth for project status
├── package.json            # Workspace definitions (npm/pnpm/yarn)
├── CONVENTIONS.md          # Rules for coding & testing (for humans)
├── README.md               # Human-facing project overview
├── AGENTS.md               # Thin shim for Codex (→ CONVENTIONS.md)
├── CLAUDE.md               # Thin shim for Claude Code (→ CONVENTIONS.md)
├── docs/
│   ├── architecture/       # High-level system design & Pillar interactions
│   ├── glossary.md         # Domain-specific terminology
│   ├── pillars/            # Folder for each of the 4 Pillars
│   │   ├── 1-proposal/     # State machine diagrams, workflow rules
│   │   ├── 2-workforce/    # ACL specs, agent registration flows
│   │   ├── 3-efficiency/   # Context window strategies, cache logic
│   │   └── 4-utility/      # CLI specs, MCP endpoint definitions
│   ├── agents/             # SPECIFIC instructions/prompts for AI personas
│   ├── reviews/            # ADRs (Architecture Decision Records) & cross-reviews
│   └── API/                # Generated or manual API specs (OpenAPI/MCP)
├── database/               # Database migrations and seeds
│   ├── ddl/                # Schema definitions (Tables, Views, Indexes)
│   ├── dml/                # Initial data, lookup tables, seeds
│   └── migrations/         # Versioned schema changes (e.g., Kysely or Prisma)
├── apps/                   # Entry points for Utility
│   ├── cli/                # CLI implementation
│   ├── dashboard-web/      # React/Next.js Web dashboard
│   └── mcp-server/         # Dockerized MCP service
├── src/
│   ├── core/               # Pillar 1: State machine & Pipeline logic
│   ├── workforce/          # Pillar 2: Team, ACL, & Agent management
│   ├── efficiency/         # Pillar 3: Model mgmt & Local cache
│   ├── shared/             # Common types, utilities, and logging
│   └── infra/              # Infrastructure & Data Access Layer
│       ├── postgres/       # Postgres clients & Repository patterns
│       └── messaging/      # Messaging bus (Internal/External)
├── tests/                  # Separated by type for parallel CI/CD
│   ├── unit/               # Mirrors src/ folder structure
│   ├── integration/        # Tests Pillar interactions (e.g., Core + PG)
│   └── e2e/                # System-level tests (e.g., CLI -> MCP -> PG)
├── docker/                 # Environment orchestration
│   ├── mcp.Dockerfile
│   ├── pg.Dockerfile
│   └── docker-compose.yml
├── scripts/                # Init scripts and automation
└── tmp/                    # untracked for temporary files
```

