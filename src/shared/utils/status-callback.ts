import { spawn } from "node:child_process";

export interface StatusCallbackOptions {
	command: string;
	proposalId: string;
	oldStatus: string;
	newStatus: string;
	proposalTitle: string;
	cwd: string;
}

export interface StatusCallbackResult {
	success: boolean;
	output?: string;
	error?: string;
	exitCode?: number;
}

/**
 * Executes a status change callback command with variable injection.
 * Variables are passed as environment variables to the shell command.
 *
 * @param options - The callback options including command and proposal details
 * @returns The result of the callback execution
 */
export async function executeStatusCallback(
	options: StatusCallbackOptions,
): Promise<StatusCallbackResult> {
	const { command, proposalId, oldStatus, newStatus, proposalTitle, cwd } =
		options;

	if (!command || command.trim().length === 0) {
		return { success: false, error: "Empty command" };
	}

	try {
		const env = {
			...process.env,
			STATE_ID: proposalId,
			OLD_STATUS: oldStatus,
			NEW_STATUS: newStatus,
			STATE_TITLE: proposalTitle,
		};

		const proc = spawn(command, { cwd, env, shell: true }) as any;

		const [stdout, stderr] = await Promise.all([
			new Promise<string>((resolve) => {
				let data = "";
				proc.stdout?.on("data", (chunk: Buffer) => {
					data += chunk.toString();
				});
				proc.stdout?.on("end", () => resolve(data));
			}),
			new Promise<string>((resolve) => {
				let data = "";
				proc.stderr?.on("data", (chunk: Buffer) => {
					data += chunk.toString();
				});
				proc.stderr?.on("end", () => resolve(data));
			}),
		]);

		const exitCode = await new Promise<number>((resolve) => {
			proc.on("close", (code: number) => resolve(code ?? 1));
		});
		const success = exitCode === 0;

		const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");

		return {
			success,
			output: output || undefined,
			exitCode,
			...(stderr.trim() && !success && { error: stderr.trim() }),
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
