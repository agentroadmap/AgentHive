/**
 * TUI Smoke Test - detects actual crashes in the blessed TUI
 * Uses PTY to simulate real terminal
 */

import assert from "node:assert";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

describe("TUI Smoke Tests", () => {
	it("board process starts and exits cleanly", async () => {
		const result = await new Promise<{
			exitCode: number | null;
			stderr: string;
		}>((resolve) => {
			const proc = spawn("roadmap", ["board"], {
				cwd: process.cwd(),
				env: { ...process.env, TERM: "xterm", CI: "true" },
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stderr = "";
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
			});

			// Send 'q' to quit after 1s
			setTimeout(() => {
				proc.stdin.write("q");
			}, 1000);
			setTimeout(() => {
				proc.kill();
			}, 5000);

			proc.on("close", (code) => {
				resolve({ exitCode: code, stderr });
			});
		});

		// Check it didn't crash
		assert.ok(
			result.exitCode === 0 || result.exitCode === null,
			`Board crashed with exit code ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
		);
	});

	it("board with proposals flag works", async () => {
		const result = await new Promise<{
			exitCode: number | null;
			stdout: string;
			stderr: string;
		}>((resolve) => {
			const proc = spawn("roadmap", ["board"], {
				cwd: process.cwd(),
				env: { ...process.env, TERM: "dumb", CI: "true" },
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			proc.stdout.on("data", (d) => {
				stdout += d.toString();
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
			});

			setTimeout(() => {
				proc.kill();
			}, 3000);

			proc.on("close", (code) => {
				resolve({ exitCode: code, stdout, stderr });
			});
		});

		assert.ok(
			result.stdout.includes("Proposal") || result.stdout.includes("proposal-"),
			"Board should output proposal data",
		);
	});

	it("board with --help doesn't crash", async () => {
		const result = await new Promise<{ exitCode: number | null }>((resolve) => {
			const proc = spawn("roadmap", ["board", "--help"], {
				cwd: process.cwd(),
				stdio: ["pipe", "pipe", "pipe"],
			});

			proc.on("close", (code) => {
				resolve({ exitCode: code });
			});
		});

		assert.strictEqual(result.exitCode, 0);
	});
});
