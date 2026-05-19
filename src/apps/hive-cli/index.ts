#!/usr/bin/env node
/**
 * hive CLI — composition root.
 * Entry point for the `hive` binary.
 */

import { Command } from "commander";
import { resolveContext } from "./common/context.ts";
import { registerProposal } from "./commands/proposal.ts";
import { registerWorkflow, registerState } from "./commands/workflow.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerContext } from "./commands/context-cmd.ts";
import { registerStop } from "./commands/stop.ts";
import { registerModelProfile } from "./commands/model-profile.ts";
import { getCliSchema, RECIPES, CLI_VERSION } from "./schema.ts";
import { EXIT } from "./common/exit-codes.ts";

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

// Register domain sub-commands.
registerProposal(program, getContext);
registerWorkflow(program, getContext);
registerState(program, getContext);
registerDoctor(program, getContext);
registerContext(program, getContext);
registerStop(program, getContext);
registerModelProfile(program, getContext);

// Parse args early to detect --schema / --recipes before Commander tries to route.
// We parse in two passes: first a lenient parse to catch global flags, then full parse.
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
