/**
 * P081: hive sla — SLA health check command.
 *
 * Calls mcp_ops action=sla_health_check and renders the result.
 * Exit codes: 0=Normal, 1=Degraded, 2=Down, 5=error.
 */

import type { Command } from "commander";
import type { HiveContext } from "../common/context.ts";
import { getMcpClient } from "../common/mcp-client.ts";

export function registerSla(
	program: Command,
	getContext: () => Promise<HiveContext>,
): void {
	program
		.command("sla")
		.description("Show current platform SLA state (Normal/Degraded/Down)")
		.option("-o, --format <FMT>", "Output format: text|json", "text")
		.action(async (options) => {
			const ctx = await getContext();
			const mcp = getMcpClient(ctx.mcp_url);

			let result: Record<string, unknown>;
			try {
				const raw = await mcp.callTool("mcp_ops", {
					action: "sla_health_check",
				});
				const rawObj = raw as { content?: Array<{ text?: string }> };
				const text =
					Array.isArray(rawObj?.content) && rawObj.content[0]?.text
						? rawObj.content[0].text
						: JSON.stringify(raw);
				result = JSON.parse(text);
			} catch (err) {
				process.stderr.write(
					`sla: failed to reach MCP — ${(err as Error).message}\n`,
				);
				process.exit(5);
			}

			if (options.format === "json") {
				process.stdout.write(JSON.stringify(result, null, 2) + "\n");
			} else {
				const state = String(result.state ?? "unknown");
				const color =
					state === "Normal" ? "\x1b[32m" : state === "Degraded" ? "\x1b[33m" : "\x1b[31m";
				const reset = "\x1b[0m";
				const metrics = result.metrics as Record<string, unknown> | undefined;

				process.stdout.write(`${color}SLA State: ${state}${reset}\n`);
				process.stdout.write(`Version:   ${result.sla_version ?? "—"}\n`);
				process.stdout.write(`Since:     ${result.since ?? "—"}\n`);
				if (metrics) {
					process.stdout.write(
						`p99 (5m):  ${metrics.p99_latency_ms ?? "—"} ms  ` +
						`(target: ${(result.thresholds as any)?.p99_latency_target_ms ?? 500} ms)\n`,
					);
					process.stdout.write(
						`Err (30s): ${metrics.error_rate_30s ?? "—"} %  ` +
						`(threshold: ${(result.thresholds as any)?.error_threshold_percent ?? 10} %)\n`,
					);
					process.stdout.write(`Agents:    ${metrics.active_agents ?? "—"} healthy\n`);
					process.stdout.write(`Samples:   ${metrics.sample_count_5m ?? 0} (last 5 min)\n`);
				}
				const breached = Array.isArray(result.breached_slos) ? result.breached_slos : [];
				if (breached.length > 0) {
					process.stdout.write(`\nBreached SLOs:\n`);
					for (const s of breached) {
						process.stdout.write(`  - ${s}\n`);
					}
				}
			}

			// Non-zero exit on unhealthy state (enables CI checks)
			if (result.state === "Down") process.exit(2);
			if (result.state === "Degraded") process.exit(1);
			process.exit(0);
		});
}
