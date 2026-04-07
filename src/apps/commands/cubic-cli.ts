import type { Command } from "commander";
import { CubicManager } from "../../core/orchestration/cubic-manager.ts";

export function registerCubicCommand(program: Command): void {
	const cubicCmd = program.command("cubic");

	cubicCmd
		.command("list")
		.description("list all cubic containers")
		.action(async () => {
			const manager = new CubicManager();
			const docker = await manager.checkDocker();
			if (!docker.available) {
				console.log("Docker not available");
				return;
			}
			const cubics = await manager.listCubics();
			if (cubics.length === 0) {
				console.log("No cubic containers found. Use: roadmap cubic start <id>");
				return;
			}
			for (const cubic of cubics) {
				const icon = cubic.status === "running" ? "[RUNNING]" : "[STOPPED]";
				console.log(`  ${icon} cubic-${cubic.id}`);
			}
		});

	cubicCmd
		.command("start <cubic-id>")
		.description("start a cubic container")
		.action(async (cubicId) => {
			const manager = new CubicManager();
			const result = await manager.spinUp(cubicId);
			console.log(
				result.success ? `Started: ${cubicId}` : `Error: ${result.message}`,
			);
		});

	cubicCmd
		.command("stop <cubic-id>")
		.description("stop a cubic container")
		.action(async (cubicId) => {
			const manager = new CubicManager();
			const result = await manager.stop(cubicId);
			console.log(
				result.success ? `Stopped: ${cubicId}` : `Error: ${result.message}`,
			);
		});

	cubicCmd
		.command("logs <cubic-id>")
		.description("show cubic logs")
		.action(async (cubicId) => {
			const manager = new CubicManager();
			const logs = await manager.getLogs(cubicId);
			console.log(logs);
		});
}
