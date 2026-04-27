/**
 * Recipes: Curated multi-step workflows for AI agents.
 *
 * Per cli-hive-contract.md §8.3 and ai-ergonomics.md §2.2 and §5.7:
 * Recipes are static (bundled), not dynamic (loaded from control-plane).
 * Agents read `hive --recipes` once at session start to understand common workflows.
 * Each recipe is a sequence of CLI commands with data flow hints and error handling.
 *
 * @module common/recipes
 */

/**
 * A single step in a recipe workflow.
 */
export interface RecipeStep {
  /** Shell command to execute. Can reference variables like ${proposal_id}. */
  command: string;

  /** Human-readable description of what this step does. */
  description?: string;

  /** Which output fields this step reads (data dependencies). */
  reads?: string[];

  /** Which fields/variables this step writes (for subsequent steps). */
  writes?: string[];

  /** Error handling policy: "abort" stops recipe, "continue" skips to next. */
  on_error?: "abort" | "continue";

  /** Expected output or exit code for validation. */
  expects?: string;
}

/**
 * A recipe: a curated, multi-step workflow.
 */
export interface Recipe {
  /** Unique recipe ID, slug-style. */
  id: string;

  /** Human-readable title. */
  title: string;

  /** When to use this recipe (describes the scenario). */
  when_to_use: string;

  /** Ordered steps in the workflow. */
  steps: RecipeStep[];

  /** Description of what the system should look like on success. */
  terminal_state: string;
}

/**
 * Static recipe registry.
 * Per P455 Round 2 decision: recipes are bundled in source, not dynamic.
 * New recipes require a PR and CLI release.
 */
const BUNDLED_RECIPES: Recipe[] = [
  {
    id: "claim-and-develop",
    title: "Pick next claimable proposal and start development",
    when_to_use:
      "Agent has available capacity and wants to start a new piece of work",
    steps: [
      {
        command: "hive context --format json",
        description: "Resolve current project and agency context",
        reads: ["project", "agency"],
        expects: "ok: true",
      },
      {
        command: "hive proposal next --format json",
        description:
          "Get next claimable proposal ranked by gate-readiness score",
        reads: ["proposal_id", "title"],
        expects: "ok: true",
      },
      {
        command: "hive proposal claim ${proposal_id} --duration 4h --format json",
        description: "Acquire a 4-hour lease on the proposal",
        writes: ["lease_id"],
        expects: "ok: true",
      },
      {
        command:
          "hive proposal show ${proposal_id} --include all --format json",
        description: "Load full proposal state (AC, dependencies, discussions)",
        reads: ["ac", "dependencies", "discussions", "gate_status"],
        expects: "ok: true",
      },
      {
        command: "hive proposal maturity ${proposal_id} active --format json",
        description: "Mark proposal maturity as active in current state",
        expects: "ok: true",
      },
    ],
    terminal_state:
      "Proposal claimed with active lease (4h), maturity=active, full state loaded",
  },

  {
    id: "audit-before-commit",
    title: "Scan for new hardcoding, lint, test, then commit",
    when_to_use: "Agent is ready to commit changes to version control",
    steps: [
      {
        command: "git diff HEAD --name-only",
        description: "List files changed in current working tree",
        writes: ["files_changed"],
        expects: "exit 0",
      },
      {
        command: "hive scan --since HEAD --format json",
        description:
          "Scan for hardcoding, secrets, TODO TODOs added in this branch",
        reads: ["finding_count"],
        expects: "ok: true",
      },
      {
        command:
          "hive scan --since HEAD --format json | jq '.data.findings | length'",
        description:
          "Count scan findings; if >0, show them before proceeding",
        on_error: "continue",
      },
      {
        command: "hive lint --format sarif",
        description: "Lint all modified files",
        expects: "exit 0 or exit 1 with findings",
      },
      {
        command: "npm test",
        description: "Run test suite; proceed only if all tests pass",
        expects: "exit 0",
      },
      {
        command:
          "git add -A && git commit -m 'commit: scan/lint/test pass'",
        description: "Commit changes only if all checks passed",
        expects: "exit 0",
      },
    ],
    terminal_state:
      "Local changes committed, no new scan/lint findings, test suite passes",
  },

  {
    id: "capture-defect",
    title: "Create a defect issue and assign to backlog",
    when_to_use: "Discovered a bug or unexpected behavior that needs fixing",
    steps: [
      {
        command: "hive context --format json",
        description: "Resolve project context",
        reads: ["project"],
      },
      {
        command:
          "hive proposal create --type issue --title '${DEFECT_TITLE}' --description '${DEFECT_DESC}' --format json",
        description: "Create an issue proposal in DRAFT state",
        writes: ["proposal_id"],
        expects: "ok: true",
      },
      {
        command:
          "hive proposal ac add ${proposal_id} --description 'Bug is reproducible' --description 'Root cause identified' --description 'Fix tested' --format json",
        description: "Add acceptance criteria for the defect resolution",
        expects: "ok: true",
      },
      {
        command:
          "hive proposal transition ${proposal_id} REVIEW --reason 'Ready for triage review'",
        description: "Move to REVIEW state for team triage",
        expects: "ok: true",
      },
    ],
    terminal_state:
      "Defect issue created, AC defined, transitioned to REVIEW for triage",
  },

  {
    id: "operator-stop-runaway",
    title: "Stop a runaway dispatch or worker process",
    when_to_use:
      "A dispatch or worker is hung, consuming excessive budget, or misbehaving",
    steps: [
      {
        command: "hive context --format json",
        description: "Confirm current project/agency context",
        reads: ["project", "agency"],
      },
      {
        command: "hive dispatch list --filter status=RUNNING --format jsonl",
        description: "Find RUNNING dispatches",
        reads: ["dispatch_id", "proposal_id"],
      },
      {
        command:
          "hive dispatch cancel ${dispatch_id} --reason 'Runaway: excessive resource usage' --format json",
        description: "Force-cancel the runaway dispatch",
        expects: "ok: true",
      },
      {
        command:
          "hive proposal escalate ${proposal_id} --reason 'Dispatch was cancelled due to runaway behavior' --format json",
        description: "Log escalation on the affected proposal",
        on_error: "continue",
      },
    ],
    terminal_state: "Runaway dispatch stopped, escalation logged",
  },

  {
    id: "investigate-stuck-proposal",
    title: "Understand why a proposal is stuck in the same state",
    when_to_use:
      "Proposal has been in same state >7 days without maturity change",
    steps: [
      {
        command:
          "hive proposal show ${PROPOSAL_ID} --include all --format json",
        description: "Load full proposal state and history",
        reads: ["status", "maturity", "ac", "dependencies", "discussions"],
      },
      {
        command:
          "hive proposal ac verify ${PROPOSAL_ID} --format json | jq '.data | {total, verified, unverified}'",
        description:
          "Check which acceptance criteria are blocking; count verified vs pending",
        expects: "ok: true",
      },
      {
        command:
          "hive proposal dependencies ${PROPOSAL_ID} --format json | jq '.data[] | select(.status != \"satisfied\")'",
        description: "List unsatisfied (blocking) dependencies",
        expects: "ok: true",
      },
      {
        command:
          "hive workflow next-state ${PROPOSAL_ID} --format json | jq '{legal_next_states, blockers, why_blocked}'",
        description: "Check what would unblock the proposal for transition",
        expects: "ok: true",
      },
    ],
    terminal_state:
      "Agent understands blockers (AC, deps, gate decision) and next action",
  },

  {
    id: "project-bootstrap",
    title: "Initialize a new project in AgentHive",
    when_to_use: "Starting a new project from scratch",
    steps: [
      {
        command:
          "hive project init --name '${PROJECT_NAME}' --git-root ${GIT_ROOT} --format json",
        description: "Create project record in control-plane",
        writes: ["project_id"],
        expects: "ok: true",
      },
      {
        command: "hive project db create ${project_id} --format json",
        description: "Allocate tenant database for the project",
        expects: "ok: true",
      },
      {
        command:
          "hive agency register --project ${project_id} --identity 'hermes/agency-${PROJECT_NAME}' --capabilities 'propose,develop,review' --format json",
        description: "Register agency for the project",
        writes: ["agency_id"],
        expects: "ok: true",
      },
      {
        command:
          "hive config set --scope project --key initial_budget_usd --value '1000' --project ${project_id}",
        description: "Set initial budget allocation",
        expects: "ok: true",
      },
      {
        command: "hive doctor --format json | jq '.data.overall_status'",
        description: "Verify system health after bootstrap",
        expects: "healthy",
      },
    ],
    terminal_state:
      "Project initialized, agency registered, budget set, health check passes",
  },

  {
    id: "multi-agent-dispatch",
    title: "Dispatch work to multiple agents in parallel",
    when_to_use: "A task has subtasks that can be worked on independently",
    steps: [
      {
        command: "hive context --format json",
        description: "Resolve current project/agency",
        reads: ["project"],
      },
      {
        command:
          "hive proposal create --type feature --title '${PARENT_TITLE}' --format json",
        description: "Create parent proposal (umbrella task)",
        writes: ["parent_proposal_id"],
      },
      {
        command:
          "hive proposal create --type feature --title '${SUBTASK_1}' --depends-on ${parent_proposal_id} --format json",
        description:
          "Create first subtask with dependency on parent (repeat for each subtask)",
        writes: ["subtask_1_id"],
      },
      {
        command:
          "hive agency list --filter status=AVAILABLE --format jsonl --limit 3",
        description: "Find available agencies to claim subtasks",
        reads: ["agency_ids"],
      },
      {
        command:
          "hive proposal claim ${subtask_1_id} --duration 8h --agency ${agency_1} --format json",
        description: "Claim first subtask for first agency (repeat for each)",
        expects: "ok: true",
      },
    ],
    terminal_state:
      "Parent and subtasks created; each subtask claimed by different agency",
  },

  {
    id: "doctor-self-test",
    title: "Run system health checks and apply suggested remediations",
    when_to_use:
      "Verifying the system is healthy before starting work or after an incident",
    steps: [
      {
        command: "hive doctor --format json",
        description: "Run all health checks (MCP, DB, schema, services, etc.)",
        reads: ["overall_status", "issues", "warnings"],
        expects: "ok: true",
      },
      {
        command:
          "hive doctor --format json | jq '.data.issues[] | select(.code == \"ORPHAN_LEASE\")'",
        description: "Check for orphan leases that need cleanup",
        on_error: "continue",
      },
      {
        command:
          "hive doctor --remediate ORPHAN_LEASE --format json | jq '.data.remediation.steps[] | .command'",
        description: "Get suggested remediation commands for orphan leases",
        on_error: "continue",
      },
      {
        command:
          "hive doctor --format json | jq 'if .data.overall_status == \"healthy\" then \"OK: System is healthy\" else \"WARNING: Issues detected\" end'",
        description: "Final status check",
        expects: "OK or WARNING",
      },
    ],
    terminal_state:
      "System health verified; any known issues documented with remediation suggestions",
  },
];

/**
 * Load all recipes.
 * Static bundled recipes; no network calls.
 *
 * @returns Array of Recipe objects.
 */
export async function loadRecipes(): Promise<Recipe[]> {
  return Promise.resolve([...BUNDLED_RECIPES]);
}

/**
 * Get recipe by ID.
 */
export function getRecipeById(id: string): Recipe | undefined {
  return BUNDLED_RECIPES.find((r) => r.id === id);
}

/**
 * Validate recipe: check that all command references point to known domains.
 * This is called at startup to catch typos.
 *
 * Known domain commands (from contract §1):
 * project, proposal, workflow, state, document, agency, worker, lease, provider,
 * model, route, budget, context-policy, dispatch, offer, queue, service, mcp, db,
 * cubic, audit, scan, lint, knowledge, doctor, board, web, tui, util (help, version, completion, init, status, context, doctor)
 *
 * @param recipe Recipe to validate.
 * @returns Error message if invalid; undefined if valid.
 */
export function validateRecipe(recipe: Recipe): string | undefined {
  const validDomains = new Set([
    "project",
    "proposal",
    "workflow",
    "state",
    "document",
    "agency",
    "worker",
    "lease",
    "provider",
    "model",
    "route",
    "budget",
    "context-policy",
    "dispatch",
    "offer",
    "queue",
    "service",
    "mcp",
    "db",
    "cubic",
    "audit",
    "scan",
    "lint",
    "knowledge",
    "doctor",
    "board",
    "web",
    "tui",
    "context",
    "help",
    "version",
    "completion",
    "init",
    "status",
    "git",
    "npm",
    "jq", // external tools agents may call
    "bash",
  ]);

  for (const step of recipe.steps) {
    const parts = step.command.trim().split(/\s+/);
    const firstPart = parts[0];

    // Allow variable substitution and pipes
    if (firstPart.startsWith("${") || firstPart === "|" || firstPart === "&&") {
      continue;
    }

    // Allow external tools (git, npm, etc.) in recipes
    // Recipes can call shell commands as long as they're well-formed
    const isHiveCmd = firstPart === "hive";
    const isExternal =
      [
        "git",
        "npm",
        "jq",
        "bash",
        "sh",
        "grep",
        "sed",
        "awk",
        "cat",
        "echo",
      ].includes(firstPart);

    if (!isHiveCmd && !isExternal) {
      // Likely a valid shell command
      continue;
    }

    if (isHiveCmd && parts.length > 1) {
      const domain = parts[1];
      if (!validDomains.has(domain)) {
        return `Recipe "${recipe.id}", step "${step.description}": unknown domain "${domain}"`;
      }
    }
  }

  return undefined;
}
