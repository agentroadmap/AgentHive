#!/usr/bin/env node
/**
 * hive CLI — composition root.
 * Entry point for the `hive` binary.
 */

import { Command } from "commander";
import { resolveContext } from "./common/context.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerContext } from "./commands/context-cmd.ts";
import { getCliSchema, RECIPES, CLI_VERSION } from "./schema.ts";
import { EXIT } from "./common/exit-codes.ts";

// New domain modules (canonical domain architecture)
import { register as registerProposal } from "./domains/proposal/index.ts";
import { register as registerWorkflow } from "./domains/workflow/index.ts";
import { register as registerDispatch } from "./domains/dispatch/index.ts";
import { register as registerStop } from "./domains/stop/index.ts";
import { register as registerAgency } from "./domains/agency/index.ts";
import { register as registerWorker } from "./domains/worker/index.ts";
import { register as registerLease } from "./domains/lease/index.ts";
import { register as registerTrust } from "./domains/trust/index.ts";
import { register as registerBudget } from "./domains/budget/index.ts";
import { register as registerModel } from "./domains/model/index.ts";
import { register as registerRoute } from "./domains/route/index.ts";
import { register as registerProvider } from "./domains/provider/index.ts";
import { register as registerScan } from "./domains/scan/index.ts";
import { register as registerMcp } from "./domains/mcp/index.ts";
import { register as registerDb } from "./domains/db/index.ts";
import { register as registerCubic } from "./domains/cubic/index.ts";
import { register as registerKnowledge } from "./domains/knowledge/index.ts";
import { register as registerSystem } from "./domains/system/index.ts";
import { register as registerMeta } from "./domains/meta/index.ts";
import { register as registerContextPolicy } from "./domains/context-policy/index.ts";
import { register as registerLint } from "./domains/lint/index.ts";
import { register as registerAudit } from "./domains/audit/index.ts";
import { register as registerProject } from "./domains/project/index.ts";

const program = new Command();

program
  .name("hive")
  .description("AgentHive control-plane CLI — operator, agent, and system interface")
  .version(CLI_VERSION, "--version", "Print CLI version")
  .option("--schema", "Emit full command taxonomy as JSON (machine-readable discovery)")
  .option("--recipes", "Emit curated workflow recipes as JSONL")
  .option("--project <P>", "Project slug (overrides HIVE_PROJECT env and .hive/config.json)")
  .option("--agency <A>", "Agency ID (overrides HIVE_AGENCY env)")
  .option("--mcp-url <URL>", "MCP server URL (overrides HIVE_MCP_URL)")
  .option("-o, --format <FMT>", "Default output format (text|json|jsonl|yaml)", "text")
  .hook("preAction", (_thisCommand, actionCommand) => {
    // Propagate global flags into action commands if they have not been set locally.
    const globalOpts = program.opts();
    const actionOpts = actionCommand.opts();
    if (globalOpts.project && !actionOpts.project) actionCommand.setOptionValue("project", globalOpts.project);
    if (globalOpts.agency && !actionOpts.agency) actionCommand.setOptionValue("agency", globalOpts.agency);
    if (globalOpts.format && !actionOpts.format) actionCommand.setOptionValue("format", globalOpts.format);
  });

// Context factory — commands call this lazily so startup is fast when --schema/--recipes short-circuit.
const getContext = () => {
  const globalOpts = program.opts();
  return resolveContext({
    project: globalOpts.project,
    agency: globalOpts.agency,
    mcpUrl: globalOpts.mcpUrl,
  });
};

// ── Core lifecycle domains ────────────────────────────────────────────────────
registerProposal(program);
registerWorkflow(program);
registerDispatch(program);
registerStop(program);

// ── Workforce domains ─────────────────────────────────────────────────────────
registerAgency(program);
registerWorker(program);
registerLease(program);
registerTrust(program);

// ── Provider / model / routing ────────────────────────────────────────────────
registerProvider(program);
registerModel(program);
registerRoute(program);
registerBudget(program);
registerContextPolicy(program);

// ── System / ops domains ──────────────────────────────────────────────────────
registerSystem(program);
registerMcp(program);
registerDb(program);

// ── Quality / knowledge ───────────────────────────────────────────────────────
registerScan(program);
registerLint(program);
registerAudit(program);
registerKnowledge(program);

// ── Project / workspace ───────────────────────────────────────────────────────
registerProject(program);
registerCubic(program);

// ── Meta / discovery ─────────────────────────────────────────────────────────
registerMeta(program);

// Parse args early to detect --schema / --recipes before Commander tries to route.
const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--schema")) {
  process.stdout.write(JSON.stringify(getCliSchema(), null, 2) + "\n");
  process.exit(EXIT.OK);
}

if (rawArgs.includes("--recipes")) {
  for (const recipe of RECIPES) {
    process.stdout.write(JSON.stringify(recipe) + "\n");
  }
  process.exit(EXIT.OK);
}

// Normal parse + dispatch.
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`hive: unexpected error: ${(err as Error).message}\n`);
  process.exit(EXIT.INTERNAL_ERROR);
});
