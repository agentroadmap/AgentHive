/**
 * roadmap state-machine — manage orchestrator, gate-pipeline, and agency lifecycle
 *
 * Usage:
 *   roadmap state-machine start        # Start orchestrator + gate-pipeline
 *   roadmap state-machine stop         # Stop both
 *   roadmap state-machine restart      # Restart both
 *   roadmap state-machine status       # Show service status + offer stats
 *   roadmap state-machine agencies     # List registered agencies
 *   roadmap state-machine offers       # List open/active offers
 */

import { execSync } from "child_process";
import { query } from "../../infra/postgres/pool";

const SERVICES = [
  { name: "agenthive-orchestrator", label: "Orchestrator" },
  { name: "agenthive-gate-pipeline", label: "Gate Pipeline" },
];

function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim();
    if (stderr) {
      console.error(`  [error] ${stderr}`);
    }
    return "";
  }
}

function serviceStatus(name: string): string {
  const out = run(`systemctl is-active ${name} 2>/dev/null`);
  return out || "unknown";
}

export function registerStateMachineCommand(program: any) {
  const sm = program
    .command("state-machine")
    .alias("sm")
    .description("Manage AgentHive state machine (orchestrator + gate-pipeline)");

  sm.command("start")
    .description("Start orchestrator and gate-pipeline services")
    .action(() => {
      for (const svc of SERVICES) {
        const status = serviceStatus(svc.name);
        if (status === "active") {
          console.log(`  ${svc.label}: already running`);
        } else {
          console.log(`  ${svc.label}: starting...`);
          run(`sudo systemctl start ${svc.name}`);
          const newStatus = serviceStatus(svc.name);
          console.log(`  ${svc.label}: ${newStatus}`);
        }
      }
    });

  sm.command("stop")
    .description("Stop orchestrator and gate-pipeline services")
    .action(() => {
      for (const svc of SERVICES) {
        console.log(`  ${svc.label}: stopping...`);
        run(`sudo systemctl stop ${svc.name}`);
        console.log(`  ${svc.label}: ${serviceStatus(svc.name)}`);
      }
    });

  sm.command("restart")
    .description("Restart orchestrator and gate-pipeline services")
    .action(() => {
      for (const svc of SERVICES) {
        console.log(`  ${svc.label}: restarting...`);
        run(`sudo systemctl restart ${svc.name}`);
        console.log(`  ${svc.label}: ${serviceStatus(svc.name)}`);
      }
    });

  sm.command("status")
    .description("Show service status and offer/dispatch stats")
    .action(async () => {
      // Service status
      console.log("Services:");
      for (const svc of SERVICES) {
        const status = serviceStatus(svc.name);
        const icon = status === "active" ? "✓" : "✗";
        console.log(`  ${icon} ${svc.label}: ${status}`);
      }

      try {
        // DB stats
        console.log("\nAgencies:");
        const agencies = await query(
          `SELECT agent_identity || ' (' || agent_type || ', ' || status || ')' as info
           FROM roadmap_workforce.agent_registry
           ORDER BY agent_identity`
        );
        if (agencies.rows.length > 0) {
          for (const row of agencies.rows) {
            console.log(`  ${row.info}`);
          }
        } else {
          console.log("  (none)");
        }

        console.log("\nOffers:");
        const offers = await query(
          `SELECT offer_status || ': ' || count(*) as info
           FROM roadmap_workforce.squad_dispatch
           GROUP BY offer_status
           ORDER BY offer_status`
        );
        if (offers.rows.length > 0) {
          for (const row of offers.rows) {
            console.log(`  ${row.info}`);
          }
        }

        console.log("\nActive dispatches:");
        const active = await query(
          `SELECT id || ': ' || dispatch_role || ' @ ' ||
                  COALESCE(worker_identity, 'unassigned') || ' (' || offer_status || ')' as info
           FROM roadmap_workforce.squad_dispatch
           WHERE offer_status IN ('open','claimed','active')
           ORDER BY id DESC LIMIT 10`
        );
        if (active.rows.length > 0) {
          for (const row of active.rows) {
            console.log(`  ${row.info}`);
          }
        } else {
          console.log("  (none)");
        }
      } catch (err: any) {
        console.error(`\n  DB query failed: ${err.message}`);
      }
    });

  sm.command("agencies")
    .description("List registered agencies and their capabilities")
    .action(async () => {
      try {
        const result = await query(
          `SELECT ar.agent_identity, ar.agent_type, ar.status,
                  COALESCE(string_agg(ac.capability, ', ' ORDER BY ac.capability), 'none') as capabilities
           FROM roadmap_workforce.agent_registry ar
           LEFT JOIN roadmap_workforce.agent_capability ac ON ac.agent_id = ar.id
           GROUP BY ar.id, ar.agent_identity, ar.agent_type, ar.status
           ORDER BY ar.agent_identity`
        );
        if (result.rows.length === 0) {
          console.log("No agencies registered.");
          return;
        }
        for (const row of result.rows) {
          console.log(`  ${row.agent_identity} [${row.agent_type}, ${row.status}] caps: ${row.capabilities}`);
        }
      } catch (err: any) {
        console.error(`DB query failed: ${err.message}`);
      }
    });

  sm.command("offers")
    .description("List open and active offers")
    .action(async () => {
      try {
        const result = await query(
          `SELECT id, proposal_id, dispatch_role, offer_status,
                  COALESCE(agent_identity, '-') as agency,
                  COALESCE(worker_identity, '-') as worker,
                  required_capabilities
           FROM roadmap_workforce.squad_dispatch
           WHERE offer_status IN ('open','claimed','active')
           ORDER BY id`
        );
        if (result.rows.length === 0) {
          console.log("No open/active offers.");
          return;
        }
        for (const row of result.rows) {
          console.log(`  #${row.id} P${row.proposal_id} ${row.dispatch_role} [${row.offer_status}] ${row.agency}/${row.worker} caps=${row.required_capabilities}`);
        }
      } catch (err: any) {
        console.error(`DB query failed: ${err.message}`);
      }
    });
}
