/**
 * Cubic Docker Manager
 *
 * Manages cubic containers for the roadmap system.
 * Uses docker-compose to spin up/shut down cubic containers.
 */

import { execSync } from "node:child_process";

export interface CubicInfo {
	id: string;
	status: "running" | "stopped" | "error";
	projectId: string;
	agentId?: string;
	startedAt?: string;
}

export interface CubicManagerConfig {
	composeFile: string;
	projectRoot: string;
}

export class CubicManager {
	private config: CubicManagerConfig;

	constructor(config?: Partial<CubicManagerConfig>) {
		this.config = {
			composeFile: config?.composeFile || "docker-compose.yml",
			projectRoot: config?.projectRoot || process.cwd(),
		};
	}

	/**
	 * List all cubic containers
	 */
	async listCubics(): Promise<CubicInfo[]> {
		try {
			const output = execSync(
				`docker ps -a --filter "name=cubic" --format "{{.Names}}|{{.Status}}|{{.CreatedAt}}"`,
				{ encoding: "utf-8", cwd: this.config.projectRoot },
			);

			if (!output.trim()) return [];

			return output
				.trim()
				.split("\n")
				.map((line) => {
					const [name, status, createdAt] = line.split("|");
					return {
						id: name.replace("cubic-", ""),
						status: status.includes("Up") ? "running" : "stopped",
						projectId: "roadmap",
						startedAt: createdAt,
					};
				});
		} catch {
			return [];
		}
	}

	/**
	 * Spin up a cubic container
	 */
	async spinUp(
		cubicId: string,
	): Promise<{ success: boolean; message: string }> {
		try {
			execSync(`docker compose --profile dev up cubic-${cubicId} -d`, {
				encoding: "utf-8",
				cwd: this.config.projectRoot,
				stdio: "pipe",
			});
			return { success: true, message: `Cubic ${cubicId} started` };
		} catch (error: any) {
			return {
				success: false,
				message: `Failed to start cubic ${cubicId}: ${error.message}`,
			};
		}
	}

	/**
	 * Stop a cubic container
	 */
	async stop(cubicId: string): Promise<{ success: boolean; message: string }> {
		try {
			execSync(`docker compose --profile dev stop cubic-${cubicId}`, {
				encoding: "utf-8",
				cwd: this.config.projectRoot,
				stdio: "pipe",
			});
			return { success: true, message: `Cubic ${cubicId} stopped` };
		} catch (error: any) {
			return {
				success: false,
				message: `Failed to stop cubic ${cubicId}: ${error.message}`,
			};
		}
	}

	/**
	 * Remove a cubic container
	 */
	async remove(
		cubicId: string,
	): Promise<{ success: boolean; message: string }> {
		try {
			execSync(`docker compose --profile dev rm -f cubic-${cubicId}`, {
				encoding: "utf-8",
				cwd: this.config.projectRoot,
				stdio: "pipe",
			});
			return { success: true, message: `Cubic ${cubicId} removed` };
		} catch (error: any) {
			return {
				success: false,
				message: `Failed to remove cubic ${cubicId}: ${error.message}`,
			};
		}
	}

	/**
	 * Get cubic logs
	 */
	async getLogs(cubicId: string, lines: number = 50): Promise<string> {
		try {
			return execSync(`docker logs --tail ${lines} cubic-${cubicId} 2>&1`, {
				encoding: "utf-8",
				cwd: this.config.projectRoot,
			});
		} catch (error: any) {
			return `Error getting logs: ${error.message}`;
		}
	}

	/**
	 * Check Docker status
	 */
	async checkDocker(): Promise<{
		available: boolean;
		version?: string;
		error?: string;
	}> {
		try {
			const version = execSync("docker --version", {
				encoding: "utf-8",
			}).trim();
			return { available: true, version };
		} catch (_error: any) {
			return { available: false, error: "Docker not available" };
		}
	}
}

export default CubicManager;
