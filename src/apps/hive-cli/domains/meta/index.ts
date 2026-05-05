/**
 * Meta domain: utility commands (version, context, completion, help, doctor).
 *
 * Commands:
 * - hive version
 * - hive context [--format json]
 * - hive completion [shell] [--format bash|zsh]
 * - hive doctor [--remediate]
 * - hive help [TOPIC]
 *
 * Implements cli-hive-contract.md §1 (util domain) and §8.3-8.4 (discovery).
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerDomain,
  Errors,
  type DomainSchema,
  resolveContext,
  getControlPlaneClient,
  runDoctor,
} from "../../common/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "../../../../../package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const cliVersion = packageJson.version;

const DOMAIN_NAME = "meta";
const DOMAIN_DESCRIPTION = "Utility commands (version, context, completion, doctor)";

const domainSchema: DomainSchema = {
  name: DOMAIN_NAME,
  aliases: [],
  description: DOMAIN_DESCRIPTION,
  subcommands: [
    {
      name: "version",
      signature: "hive version",
      description: "Show CLI version and git commit",
      flags: [
        {
          name: "format",
          type: "enum",
          enum: ["text", "json"],
          default: "text",
        },
      ],
      output: {
        type: "object",
        schema: { version: "string", commit: "string" },
      },
      idempotency: "idempotent",
      formats_supported: ["text", "json"],
    },
    {
      name: "context",
      signature: "hive context",
      description: "Show resolved project/agency/host context",
      flags: [
        {
          name: "format",
          type: "enum",
          enum: ["text", "json"],
          default: "text",
        },
      ],
      output: {
        type: "object",
        schema: { project: "string", agency: "string", host: "string" },
      },
      idempotency: "idempotent",
      formats_supported: ["text", "json"],
    },
    {
      name: "completion",
      signature: "hive completion [shell]",
      description: "Generate shell completion script",
      parameters: [
        {
          name: "shell",
          type: "enum",
          enum: ["bash", "zsh", "fish"],
          required: false,
          description: "Shell type (default: bash)",
        },
      ],
      flags: [],
      output: {
        type: "string",
        schema: "Shell completion script",
      },
      idempotency: "idempotent",
      formats_supported: ["text"],
    },
    {
      name: "doctor",
      signature: "hive doctor",
      description: "System readiness check",
      flags: [
        {
          name: "format",
          type: "enum",
          enum: ["text", "json"],
          default: "text",
        },
        {
          name: "remediate",
          type: "boolean",
          description: "Show remediation suggestions (suggest-only, no auto-fix)",
        },
      ],
      output: {
        type: "object",
        schema: {
          overall_status: "string",
          checks: "array",
          issues: "array",
        },
      },
      idempotency: "idempotent",
      formats_supported: ["text", "json"],
    },
    {
      name: "help",
      signature: "hive help [TOPIC]",
      description: "Show help for a topic",
      parameters: [
        {
          name: "TOPIC",
          type: "string",
          required: false,
          description: "Help topic",
        },
      ],
      flags: [],
      output: {
        type: "string",
        schema: "Help text",
      },
      idempotency: "idempotent",
      formats_supported: ["text"],
    },
  ],
};

async function handleVersion(options: Record<string, unknown>) {
  // Get git commit hash
  let commit = "unknown";
  try {
    const { execSync } = await import("node:child_process");
    commit = execSync("git rev-parse --short HEAD", {
      cwd: resolve(__dirname, "../../../../../"),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // Ignore git errors
  }

  return {
    version: cliVersion,
    commit,
  };
}

async function handleContext(options: Record<string, unknown>) {
  const ctx = await resolveContext(options as { project?: string; agency?: string; host?: string });

  return {
    project: ctx.project ?? "(unresolved)",
    agency: ctx.agency ?? "(unresolved)",
    host: ctx.host || "(unresolved)",
    resolved_at: new Date().toISOString(),
  };
}

async function handleCompletion(shell: string | undefined, options: Record<string, unknown>) {
  const target = shell || "bash";

  if (target === "bash") {
    // Return basic bash completion script
    const script = `
#!/bin/bash
_hive_completion() {
  local cur opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  opts="project agency worker lease provider model route budget system audit version context help doctor"
  COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
  return 0
}
complete -o bashdefault -o default -o nospace -F _hive_completion hive
`;
    return script.trim();
  } else if (target === "zsh") {
    const script = `
# zsh completion for hive
_hive() {
  local -a commands
  commands=(
    "project:Project management"
    "agency:Agency (team) management"
    "worker:Agent registry"
    "lease:Proposal claims"
    "provider:LLM providers"
    "model:LLM models"
    "route:Dispatch routes"
    "budget:Spend management"
    "system:System operations"
    "audit:Operator logging"
    "version:Show version"
    "context:Show context"
    "help:Show help"
    "doctor:Readiness check"
  )
  _describe 'command' commands
}
compdef _hive hive
`;
    return script.trim();
  } else if (target === "fish") {
    return "# fish completion for hive (TODO: implement)";
  } else {
    throw Errors.usage(`Unknown shell: ${target}. Valid: bash, zsh, fish`);
  }
}

async function handleDoctor(options: Record<string, unknown>) {
  const result = await runDoctor({
    remediate:
      typeof options.remediate === "string" ? options.remediate : undefined,
  });
  return result;
}

async function handleHelp(topic: string | undefined, options: Record<string, unknown>) {
  const helpTopics: Record<string, string> = {
    context: `
Context Resolution
------------------
The hive CLI resolves project/agency/host from (in order):
1. Command-line flags (--project, --agency, --host)
2. Environment variables (HIVE_PROJECT, HIVE_AGENCY, HIVE_HOST)
3. CWD-derived lookup (worktree_root, .hive/config.json, git remote URL)
4. Control-plane defaults (for authenticated user)

Example:
  HIVE_PROJECT=agenthive hive proposal list
  hive --project agenthive proposal list
`,
    proposals: `
Proposal Lifecycle
------------------
Proposals move through states: Draft -> Review -> Develop -> Merge -> Complete

Each state has a maturity indicator:
  new    - Freshly transitioned; waiting for work
  active - Under lease; being actively developed
  mature - Ready for transition to next state
  obsolete - Superseded or no longer relevant

See: hive proposal list, hive proposal claim, hive proposal transition
`,
    agencies: `
Agency and Worker Management
----------------------------
Agencies are autonomous teams (AI or human).
Workers are individual agents with specific roles and skills.

Commands:
  hive agency list       - List all agencies
  hive agency info ID    - Get agency details
  hive worker list       - List agents in current project
  hive worker info ID    - Get agent details
`,
  };

  if (!topic) {
    return `
hive CLI - AgentHive Control Plane

Topics:
${Object.keys(helpTopics)
  .map((t) => `  ${t}`)
  .join("\n")}

Run: hive help <topic> for details
Also try: hive --schema, hive --recipes, hive doctor
`;
  }

  return helpTopics[topic] || `Unknown help topic: ${topic}`;
}

export function register(program: Command): void {
  registerDomain(domainSchema);

  // Version
  program
    .command("version")
    .description("Show CLI version and git commit")
    .action(async (options) => {
      const result = await handleVersion(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  // Context
  program
    .command("context")
    .description("Show resolved project/agency/host context")
    .action(async (options) => {
      const result = await handleContext(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  // Completion
  program
    .command("completion [shell]")
    .description("Generate shell completion script")
    .action(async (shell: string | undefined, options) => {
      const result = await handleCompletion(shell, options);
      process.stdout.write(result + "\n");
    });

  // Doctor
  program
    .command("doctor")
    .description("System readiness check")
    .option("--remediate", "Show remediation suggestions")
    .action(async (options) => {
      const result = await handleDoctor(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  // Help
  program
    .command("help [TOPIC]")
    .description("Show help for a topic")
    .action(async (topic: string | undefined, options) => {
      const result = await handleHelp(topic, options);
      process.stdout.write(result + "\n");
    });
}
