/**
 * Workflow Domain for hive CLI
 *
 * Registers all workflow commands (list, show, gates, next-state, history).
 * Implements cli-hive-contract.md §1 (workflow domain).
 */

import type { Command } from "commander";
import {
  registerDomain,
  Errors,
  resolveContext,
  getControlPlaneClient,
  type HiveContext,
} from "../../common/index";
import { workflowSchema } from "./workflow-schema";
import { handleList } from "./handlers/list";
import { handleShow } from "./handlers/show";
import { handleGates } from "./handlers/gates";
import { handleNextState } from "./handlers/next-state";
import { handleHistory } from "./handlers/history";

async function requireProjectId(ctx: HiveContext): Promise<number> {
  if (!ctx.project) {
    throw Errors.usage("No project selected. Use --project or set HIVE_PROJECT.");
  }
  const client = getControlPlaneClient();
  const row = await client.getProject(ctx.project);
  if (!row) {
    throw Errors.notFound(`Project '${ctx.project}' not found.`);
  }
  return row.project_id;
}

export function register(program: Command): void {
  // Register schema
  registerDomain(workflowSchema);

  // Create workflow domain command group
  const workflowCmd = program
    .command("workflow")
    .alias("workflows")
    .description("Workflow state machine and gate operations")
    .addHelpCommand(false);

  // workflow list
  workflowCmd
    .command("list")
    .description("List all workflows in project")
    .option("--limit <limit>", "Maximum items (default: 20)")
    .option("--cursor <cursor>", "Pagination cursor")
    .action(async (options) => {
      const ctx = await resolveContext(options);

      try {
        const result = await handleList(await requireProjectId(ctx), {
          limit: options.limit,
          cursor: options.cursor,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof Error) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    });

  // workflow show
  workflowCmd
    .command("show <workflow_id>")
    .description("Show workflow definition and state rules")
    .option(
      "--include <relations>",
      "Expand relations (repeatable)",
      (value, prev) => {
        return prev ? (Array.isArray(prev) ? [...prev, value] : [prev, value]) : value;
      }
    )
    .action(async (workflowId, options) => {
      const ctx = await resolveContext(options);

      try {
        const result = await handleShow(await requireProjectId(ctx), workflowId, {
          include: options.include,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof Error) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    });

  // workflow gates
  workflowCmd
    .command("gates <workflow_id>")
    .description("List gate rules for a workflow")
    .option("--state <state>", "Filter by target state")
    .action(async (workflowId, options) => {
      const ctx = await resolveContext(options);

      try {
        const result = await handleGates(await requireProjectId(ctx), workflowId, {
          state: options.state,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof Error) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    });

  // workflow next-state
  workflowCmd
    .command("next-state <workflow_id> <current_state>")
    .description("List valid next states from current state")
    .action(async (workflowId, currentState, options) => {
      const ctx = await resolveContext(options);

      try {
        const result = await handleNextState(
          await requireProjectId(ctx),
          workflowId,
          currentState
        );
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof Error) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    });

  // workflow history
  workflowCmd
    .command("history <proposal_id>")
    .description("Show state transition history for a proposal")
    .option("--limit <limit>", "Maximum entries (default: 50)")
    .action(async (proposalId, options) => {
      const ctx = await resolveContext(options);

      try {
        const result = await handleHistory(await requireProjectId(ctx), proposalId, {
          limit: options.limit,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof Error) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    });
}
