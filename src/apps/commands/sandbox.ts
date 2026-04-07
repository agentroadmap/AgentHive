import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

export const sandboxCommand = new Command("sandbox").description(
	"manage the isolated execution environment for roadmap agents",
);

sandboxCommand
	.command("setup")
	.description(
		"configure the project for sandboxed agent execution (Docker/Podman)",
	)
	.action(async () => {
		p.intro(pc.bgBlue(pc.white(" Roadmap.md Sandbox Setup ")));

		const rootDir = process.cwd();
		const geminiDir = path.join(rootDir, ".gemini");
		const settingsPath = path.join(geminiDir, "settings.json");
		const dockerfilePath = path.join(geminiDir, "sandbox.Dockerfile");

		try {
			// 1. Verify Docker or Podman
			const s = p.spinner();
			s.start("Checking for container runtime...");

			let runtime = "none";
			try {
				execSync("docker --version", { stdio: "ignore" });
				runtime = "docker";
			} catch {
				try {
					execSync("podman --version", { stdio: "ignore" });
					runtime = "podman";
				} catch {
					// Both failed
				}
			}

			if (runtime === "none") {
				s.stop(pc.red("No container runtime found."));
				p.note(
					"A container runtime (Docker or Podman) is required to run agents in a sandbox.\n" +
						"Please install Docker Desktop or Podman and run this setup again.",
					"Missing Dependency",
				);
				p.outro(pc.red("Setup aborted."));
				process.exit(1);
			}
			s.stop(pc.green(`Found container runtime: ${runtime}`));

			// 2. Ensure directories exist
			await fs.mkdir(geminiDir, { recursive: true });

			// 3. Write/Update settings.json
			interface SandboxSettings {
				tools?: {
					sandbox?: string;
				};
				[key: string]: unknown;
			}
			let settings: SandboxSettings = {};
			try {
				const existing = await fs.readFile(settingsPath, "utf-8");
				settings = JSON.parse(existing) as SandboxSettings;
			} catch {
				// File doesn't exist or is invalid JSON, start fresh
			}

			if (!settings.tools) settings.tools = {};
			settings.tools.sandbox = runtime;

			await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
			p.log.success(
				`Updated ${pc.cyan(".gemini/settings.json")} to use ${runtime} backend.`,
			);

			// 4. Create Dockerfile if it doesn't exist
			try {
				await fs.access(dockerfilePath);
				p.log.info(
					`Dockerfile already exists at ${pc.cyan(".gemini/sandbox.Dockerfile")}. Skipping creation.`,
				);
			} catch {
				const dockerfileContent = `# Sandbox Environment for Roadmap.md Agents
FROM node:24-bullseye-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

RUN apt-get update && apt-get install -y curl unzip git sudo jq build-essential && rm -rf /var/lib/apt/lists/*
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash
RUN useradd -m -s /bin/bash agent && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
WORKDIR /workspace
RUN chown -R agent:agent /workspace
USER agent
ENV PATH="/usr/local/bin:/usr/local/share/npm/bin:\${PATH}"
CMD ["tail", "-f", "/dev/null"]`;

				await fs.writeFile(dockerfilePath, dockerfileContent);
				p.log.success(
					`Created default Dockerfile at ${pc.cyan(".gemini/sandbox.Dockerfile")}.`,
				);
			}

			p.note(
				"Your project is now configured for sandboxed execution.\n" +
					"Agents will run in an isolated container with Node.js v24 and Bun.\n\n" +
					`To test the environment manually, run: ${pc.cyan("BUILD_SANDBOX=1 gemini -s")}`,
				"Next Steps",
			);

			p.outro(pc.green("Sandbox setup complete!"));
		} catch (error) {
			p.log.error(
				`An error occurred during setup: ${error instanceof Error ? error.message : String(error)}`,
			);
			p.outro(pc.red("Setup failed."));
			process.exit(1);
		}
	});
