# 🐝 agentHive Development Conventions

## 1. Rationale for the Structure
The agentHive project is an agent-native enterprise designed for high-concurrency development. To prevent "semantic drift" and merge conflicts among a massive workforce, the project follows three core principles:
* **Pillar Isolation:** Code is divided into four distinct functional domains (Proposals, Workforce, Efficiency, Utility) to ensure agents working on different tasks do not overlap in the same directories.
* **Infrastructure Decoupling:** Business logic is strictly separated from data access (Postgres/Messaging).
* **Ephemeral Hygiene:** All non-permanent, transient, or "ops noise" data is relegated to a dedicated `tmp/` directory to keep the Git-tracked "Brain" and "Body" high-signal.

---

## 2. Recommended Folder Structure
Agents must strictly adhere to the following hierarchy when creating or modifying artifacts:

```text
agent-hive/
├── roadmap.yaml            # The source of truth for project status
├── package.json            # Workspace definitions (npm/pnpm/yarn)
├── CONVENTIONS.md          # Rules for coding & testing (for humans)
├── README.md               # Human-facing project overview
├── agentGuide.md           # Strict operational rules for Agents
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

---

## 3. Temporary File Management (The `tmp/` Protocol)
To maintain a clean environment and prevent Git pollution, the following rules apply to all agents regarding temporary files:

### **Strict Rules for Agents**
* **Zero-Pollution Policy:** Never create files like `.log`, `.tmp`, `.json_dump`, or `.raw_output` within the `src/`, `docs/`, or `apps/` directories.
* **Mandatory `tmp/` Usage:** All transient data required for a single task execution must be stored in `tmp/`.
* **Naming Convention:** Temporary files should be prefixed with the agent identity or the proposal ID (e.g., `tmp/PROPOSAL-001_log.txt`).

### **Typical Uses for `tmp/`**
* **Intermediate LLM Outputs:** Raw JSON or text generated during research before being refined into an Artifact.
* **Execution Logs:** Debugging data from "Pre-flight Checks" or local script runs.
* **Local Caches:** Non-persistent context fragments that are not yet moved to the `efficiency` pillar.

---

## 4. Coding & Organization Guidelines

### **Pillar Mapping**
Every feature must be mapped to its corresponding pillar directory:
* **Pillar 1 (Proposal):** State transitions and lifecycle logic go in `src/core/`.
* **Pillar 2 (Workforce):** Identity, permissions, and squad logic go in `src/workforce/`.
* **Pillar 3 (Efficiency):** Context optimization and model management go in `src/efficiency/`.
* **Pillar 4 (Utility):** Interfaces (CLI/Web) and MCP service wrappers go in `apps/`.

### **Test Mirroring**
For every functional file created in `src/`, a corresponding test file **must** be created in `tests/unit/` following the exact same path.
* *Example:* `src/core/state-machine.ts` **must** have a `tests/unit/core/state-machine.test.ts`.

### **State-to-Artifact Synchronization**
Agents must ensure that "Live State" changes in Postgres are reflected in the filesystem Artifacts.
* Updates to technical RFCs or designs must be committed to the `docs/` or `src/` folder as a versioned Git record.
* Use the `sync_ledger` table in Postgres to track the status of these exports.

---

## 5. Security & Provenance
* **ACL Adherence:** Agents may only write to directories for which their Identity has explicit clearance.
* **Git Integrity:** Agents must not bypass Git hooks or auto-commit logic defined in the root `package.json` and `roadmap.yaml`.
