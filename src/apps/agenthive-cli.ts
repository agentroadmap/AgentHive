#!/usr/bin/env node
/**
 * AgentHive System CLI
 *
 * Usage:
 *   agenthive init          One-time system setup (requires sudo)
 *   agenthive status        Check orchestrator service status
 *   agenthive start         Start orchestrator service
 *   agenthive stop          Stop orchestrator service
 *   agenthive restart       Restart orchestrator service
 *   agenthive logs          View orchestrator logs
 *
 * This CLI is for the user who *installs* AgentHive on a machine.
 * Project-level commands live in `roadmap`.
 */
import { execSync, spawn } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve project root by looking for agentRoadmap package.json upward from cwd or __dirname. */
function resolveProjectRoot(): string {
	for (const start of [process.cwd(), __dirname]) {
		let dir = resolve(start);
		while (dir !== "/") {
			try {
				const pkg = JSON.parse(
					readFileSync(join(dir, "package.json"), "utf-8"),
				);
				if (pkg.name === "agentRoadmap") return dir;
			} catch {
				/* not found here */
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	// Fallback: assume running from within the repo
	return resolve(__dirname, "../..");
}

const PROJECT_ROOT = resolveProjectRoot();
const WORKTREE_ROOT = resolve(PROJECT_ROOT, "../worktree");

const SYSTEMD_SERVICE_NAME = "agenthive-orchestrator";
const SYSTEMD_SERVICE_PATH = `/etc/systemd/system/${SYSTEMD_SERVICE_NAME}.service`;
const ENV_FILE_PATH = "/etc/agenthive/env";
const AGENTHIVE_USER = "agenthive";
const AGENTHIVE_HOME = "/var/lib/agenthive";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function die(msg: string): never {
	clack.log.error(msg);
	process.exit(1);
}

function run(
	cmd: string[],
	opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): string {
	try {
		return execSync(cmd.join(" "), {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			...opts,
		}).trim();
	} catch (err: any) {
		throw new Error(`${cmd.join(" ")} failed: ${err.stderr || err.message}`);
	}
}

/** Run a command with sudo, letting the OS handle the password prompt. */
function sudo(cmd: string[], opts?: { cwd?: string }): string {
	return run(["sudo", ...cmd], opts);
}

/** Spawn a command with sudo and inherit stdio (for interactive prompts). */
function sudoSpawn(cmd: string[], opts?: { cwd?: string }): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("sudo", cmd, {
			stdio: "inherit",
			shell: false,
			...opts,
		});
		child.on("exit", (code) => resolve(code ?? 1));
		child.on("error", reject);
	});
}

function checkSudo(): boolean {
	try {
		run(["sudo", "-n", "true"]);
		return true;
	} catch {
		return false;
	}
}

/* ------------------------------------------------------------------ */
/*  Init command                                                      */
/* ------------------------------------------------------------------ */

async function cmdInit() {
	clack.intro(pc.bgCyan(pc.black(" AgentHive System Init ")));

	/* --- Preconditions --------------------------------------------- */
	if (process.platform !== "linux") {
		die("AgentHive system init currently supports Linux only.");
	}

	const isRoot = userInfo().uid === 0;
	if (isRoot) {
		die("Do not run init as root. Run as a regular user with sudo access.");
	}

	const hasSudo = checkSudo();
	if (!hasSudo) {
		clack.log.warn(
			"Passwordless sudo not detected. You will be prompted for your password.",
		);
	}

	/* --- Confirm ---------------------------------------------------- */
	const confirmed = await clack.confirm({
		message:
			"This will create the agenthive system user, install systemd services, and configure the host. Continue?",
		initialValue: true,
	});
	if (clack.isCancel(confirmed) || !confirmed) {
		clack.outro("Aborted.");
		return;
	}

	const s = clack.spinner();

	/* --- 1. Create system user ------------------------------------- */
	s.start("Creating agenthive system user...");
	try {
		sudo(["id", AGENTHIVE_USER]);
		s.stop("agenthive user already exists.");
	} catch {
		try {
			sudo([
				"useradd",
				"-r",
				"-m",
				"-s",
				"/bin/bash",
				"-d",
				AGENTHIVE_HOME,
				"-U",
				AGENTHIVE_USER,
			]);
			s.stop("Created agenthive user.");
		} catch (e: any) {
			s.stop("Failed to create agenthive user.");
			throw e;
		}
	}

	/* --- 2. Ensure dev group membership ----------------------------- */
	s.start("Configuring group memberships...");
	try {
		sudo(["usermod", "-aG", "dev", AGENTHIVE_USER]);
	} catch {
		/* may already be in group */
	}
	s.stop("Group memberships configured.");

	/* --- 3. Install hermes for agenthive -------------------------- */
	s.start("Installing Hermes CLI for agenthive...");
	try {
		// Check if xiaomi has hermes installed — symlink if available
		// Resolve xiaomi home directory dynamically
		const xiaomiHome = process.env.XIAOMI_HOME || "/home/xiaomi";
		try {
			const xiaomiHermes = `${xiaomiHome}/.local/bin/hermes`;
			await access(xiaomiHermes, constants.X_OK);
			const agenthiveBin = `${AGENTHIVE_HOME}/.local/bin`;
			sudo(["mkdir", "-p", agenthiveBin]);
			sudo(["ln", "-sf", xiaomiHermes, `${agenthiveBin}/hermes`]);
			sudo(["ln", "-sf", `${xiaomiHome}/.hermes`, `${AGENTHIVE_HOME}/.hermes`]);
			// Fix permissions so agenthive can read xiaomi's .hermes
			sudo(["chmod", "750", `${xiaomiHome}/.hermes`]);
			sudo(["chgrp", "-R", "dev", `${xiaomiHome}/.hermes`]);
			sudo(["chmod", "-R", "g+rX", `${xiaomiHome}/.hermes`]);
			s.stop("Linked Hermes from xiaomi installation.");
		} catch {
			// Fall back: install fresh for agenthive
			sudo(["-u", AGENTHIVE_USER, "pip", "install", "--user", "hermes-agent"]);
			s.stop("Installed Hermes fresh for agenthive.");
		}
	} catch (e: any) {
		s.stop("Hermes install failed.");
		throw e;
	}

	/* --- 4. Create env file --------------------------------------- */
	s.start("Creating environment file...");
	try {
		await access(ENV_FILE_PATH);
		s.stop("Environment file already exists.");
	} catch {
		const envContent = `# AgentHive system environment
# This file is sourced by the systemd service.
# Edit to customize database credentials, API keys, etc.

PGHOST=127.0.0.1
PGPORT=5432
PGUSER=agenthive
PG_DATABASE=agenthive
PG_SCHEMA=roadmap
`;
		try {
			sudo(["mkdir", "-p", "/etc/agenthive"]);
			const tmpPath = `/tmp/agenthive-env-${Date.now()}`;
			await writeFile(tmpPath, envContent, { mode: 0o640 });
			sudo(["cp", tmpPath, ENV_FILE_PATH]);
			sudo(["chmod", "640", ENV_FILE_PATH]);
			sudo(["chown", `root:dev`, ENV_FILE_PATH]);
		} catch (e: any) {
			s.stop("Failed to write env file.");
			throw e;
		}
		s.stop("Created environment file.");
	}

	/* --- 5. Install systemd service -------------------------------- */
	s.start("Installing systemd service...");
	const serviceContent = `[Unit]
Description=AgentHive Orchestrator (event-driven agent dispatcher)
After=network.target postgresql.service agenthive-mcp.service
Requires=agenthive-mcp.service

[Service]
Type=simple
User=${AGENTHIVE_USER}
Group=${AGENTHIVE_USER}
WorkingDirectory=/data/code/AgentHive
EnvironmentFile=${ENV_FILE_PATH}
Environment=NODE_ENV=production
Environment=PATH=${AGENTHIVE_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${AGENTHIVE_HOME}
Environment=PROJECT_ROOT=/data/code/AgentHive
Environment=AGENTHIVE_ORCHESTRATOR_POLL=1
ExecStart=/usr/local/bin/bun scripts/orchestrator.ts
Restart=on-failure
RestartSec=10
TimeoutStopSec=300
KillSignal=SIGTERM
MemoryMax=512M
CPUQuota=50%
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SYSTEMD_SERVICE_NAME}

[Install]
WantedBy=multi-user.target
`;
	try {
		const tmpService = `/tmp/${SYSTEMD_SERVICE_NAME}.service`;
		await writeFile(tmpService, serviceContent);
		sudo(["cp", tmpService, SYSTEMD_SERVICE_PATH]);
		sudo(["chmod", "644", SYSTEMD_SERVICE_PATH]);
		s.stop("Installed systemd service.");
	} catch (e: any) {
		s.stop("Failed to install systemd service.");
		throw e;
	}

	/* --- 6. Fix filesystem permissions ---------------------------- */
	s.start("Setting filesystem permissions...");
	try {
		// Ensure worktree root exists and is group-writable
		sudo(["mkdir", "-p", WORKTREE_ROOT]);
		sudo(["chown", ":dev", WORKTREE_ROOT]);
		sudo(["chmod", "g+srwx", WORKTREE_ROOT]);
		// AgentHive repo
		sudo(["chown", "-R", ":dev", PROJECT_ROOT]);
		sudo(["chmod", "-R", "g+srX", PROJECT_ROOT]);
		s.stop("Filesystem permissions set.");
	} catch (e: any) {
		s.stop("Permission setup failed.");
		throw e;
	}

	/* --- 7. Reload systemd ---------------------------------------- */
	s.start("Reloading systemd...");
	try {
		sudo(["systemctl", "daemon-reload"]);
		s.stop("Systemd reloaded.");
	} catch (e: any) {
		s.stop("systemctl daemon-reload failed.");
		throw e;
	}

	/* --- 8. Prompt for DB setup ----------------------------------- */
	clack.log.info("The orchestrator requires a PostgreSQL database.");
	const setupDb = await clack.confirm({
		message:
			"Have you initialized the AgentHive database? (run psql -f database/migrations/*.sql)",
		initialValue: false,
	});
	if (clack.isCancel(setupDb) || !setupDb) {
		clack.log.warn(
			"Remember to run the migration files in database/migrations/ before starting the service.",
		);
	}

	/* --- Done ----------------------------------------------------- */
	clack.note(
		`Service: ${SYSTEMD_SERVICE_NAME}\n` +
			`User:    ${AGENTHIVE_USER}\n` +
			`Home:    ${AGENTHIVE_HOME}\n` +
			`Env:     ${ENV_FILE_PATH}\n` +
			`\nStart with:  sudo systemctl start ${SYSTEMD_SERVICE_NAME}\n` +
			`Status:      sudo systemctl status ${SYSTEMD_SERVICE_NAME}\n` +
			`Logs:        sudo journalctl -u ${SYSTEMD_SERVICE_NAME} -f`,
		"Next steps",
	);
	clack.outro("AgentHive system initialized.");
}

/* ------------------------------------------------------------------ */
/*  Service control commands                                          */
/* ------------------------------------------------------------------ */

async function cmdStatus() {
	try {
		const out = run([
			"systemctl",
			"status",
			SYSTEMD_SERVICE_NAME,
			"--no-pager",
		]);
		console.log(out);
	} catch (e: any) {
		console.log(pc.yellow("Service is not running or not installed."));
		console.log(pc.dim(e.message));
	}
}

async function cmdStart() {
	clack.spinner().start("Starting orchestrator...");
	try {
		sudo(["systemctl", "start", SYSTEMD_SERVICE_NAME]);
		clack.outro("Orchestrator started.");
	} catch (e: any) {
		clack.outro(`Failed to start: ${e.message}`);
		process.exit(1);
	}
}

async function cmdStop() {
	clack.spinner().start("Stopping orchestrator...");
	try {
		sudo(["systemctl", "stop", SYSTEMD_SERVICE_NAME]);
		clack.outro("Orchestrator stopped.");
	} catch (e: any) {
		clack.outro(`Failed to stop: ${e.message}`);
		process.exit(1);
	}
}

async function cmdRestart() {
	clack.spinner().start("Restarting orchestrator...");
	try {
		sudo(["systemctl", "restart", SYSTEMD_SERVICE_NAME]);
		clack.outro("Orchestrator restarted.");
	} catch (e: any) {
		clack.outro(`Failed to restart: ${e.message}`);
		process.exit(1);
	}
}

async function cmdLogs() {
	await sudoSpawn([
		"journalctl",
		"-u",
		SYSTEMD_SERVICE_NAME,
		"-f",
		"--no-pager",
	]);
}

/* ------------------------------------------------------------------ */
/*  db ping command                                                   */
/* ------------------------------------------------------------------ */

async function cmdDbPing(target: string) {
	const targets = target === "all" ? ["postgres", "pgbouncer"] : [target];

	for (const t of targets) {
		if (t === "pgbouncer") {
			const host = process.env.PGBOUNCER_HOST ?? "127.0.0.1";
			const port = Number(
				process.env.PGBOUNCER_PORT ?? process.env.PGPORT ?? 6432,
			);
			const user =
				process.env.PGBOUNCER_ADMIN_USER ?? process.env.PGUSER ?? "agenthive";
			clack.log.info(`Pinging PgBouncer at ${host}:${port} (user: ${user})…`);
			const start = Date.now();
			try {
				// Auth via ~/.pgpass — never PGPASSWORD
				const out = run([
					"psql",
					`-h`,
					host,
					`-p`,
					String(port),
					`-U`,
					user,
					`pgbouncer`,
					`-c`,
					`SHOW VERSION`,
					`-t`,
					`-A`,
				]);
				const ms = Date.now() - start;
				clack.log.success(`PgBouncer OK — ${out.trim()} (${ms}ms)`);
			} catch (e: any) {
				clack.log.error(
					`PgBouncer UNREACHABLE at ${host}:${port} — ${e.message}`,
				);
				process.exitCode = 1;
			}
		} else if (t === "postgres") {
			const host = process.env.PGHOST ?? "127.0.0.1";
			const port = Number(
				process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432,
			);
			const user = process.env.PGUSER ?? "agenthive";
			clack.log.info(`Pinging PostgreSQL at ${host}:${port} (user: ${user})…`);
			const start = Date.now();
			try {
				run([
					"psql",
					`-h`,
					host,
					`-p`,
					String(port),
					`-U`,
					user,
					`-c`,
					`SELECT 1`,
					`-t`,
					`-A`,
				]);
				const ms = Date.now() - start;
				clack.log.success(`PostgreSQL OK (${ms}ms)`);
			} catch (e: any) {
				clack.log.error(
					`PostgreSQL UNREACHABLE at ${host}:${port} — ${e.message}`,
				);
				process.exitCode = 1;
			}
		} else {
			clack.log.error(`Unknown target '${t}'. Use: postgres | pgbouncer | all`);
			process.exitCode = 1;
		}
	}
}

/* ------------------------------------------------------------------ */
/*  config set command (P828 AC-38)                                   */
/* ------------------------------------------------------------------ */

/**
 * P828 AC-38: `agenthive config set --key <k> --value <v> --operator-id <id>`.
 *
 * Mutates a runtime config key through the audited ConfigResolver.set() path so
 * the mutation lands in core.config_mutation_log + core.runtime_flag with a
 * pg_notify and synchronous cache eviction. The --operator-id is the operator's
 * control_identity.principal id (the FK set() resolves against); it is placed in
 * agentContextStorage as an operator-kind verified principal so set()'s authority
 * gate grants operator rights. --value is parsed by the key's own parser (passed
 * through verbatim; for JSON values quote them, e.g. --value 'true').
 */
async function cmdConfigSet(opts: {
	key?: string;
	value?: string;
	operatorId?: string;
}): Promise<void> {
	const keyName = opts.key?.trim();
	const operatorId = opts.operatorId?.trim();
	if (!keyName) {
		clack.log.error("--key is required.");
		process.exitCode = 1;
		return;
	}
	if (opts.value === undefined) {
		clack.log.error("--value is required.");
		process.exitCode = 1;
		return;
	}
	if (!operatorId) {
		clack.log.error(
			"--operator-id is required (control_identity.principal id of the operator).",
		);
		process.exitCode = 1;
		return;
	}

	const { agentContextStorage } = await import(
		"../shared/identity/agent-context.ts"
	);
	const { getConfigKeyByName } = await import(
		"../shared/runtime/config-keys.ts"
	);
	const { initConfigFromControlPool, set: configSet } = await import(
		"../shared/runtime/config.ts"
	);

	let key: ReturnType<typeof getConfigKeyByName>;
	try {
		key = getConfigKeyByName(keyName);
	} catch (e: any) {
		clack.log.error(e?.message ?? String(e));
		process.exitCode = 1;
		return;
	}

	// The key's parser turns the raw --value string into the typed value set()
	// will store + re-validate. A parse failure here is reported before any DB I/O.
	let parsed: unknown;
	try {
		parsed = key.parse(opts.value);
	} catch (e: any) {
		clack.log.error(`Invalid --value for ${keyName}: ${e?.message ?? e}`);
		process.exitCode = 1;
		return;
	}

	try {
		await initConfigFromControlPool();
	} catch (e: any) {
		clack.log.error(`Control-plane pool init failed: ${e?.message ?? e}`);
		process.exitCode = 1;
		return;
	}

	await agentContextStorage.run(
		{
			verified: {
				principal_id: operatorId,
				principal_kind: "operator",
				parent_principal_id: null,
			},
		},
		async () => {
			try {
				await configSet(key as never, parsed as never);
				clack.log.success(
					`config set: ${keyName} = ${opts.value} (operator ${operatorId})`,
				);
			} catch (e: any) {
				clack.log.error(`config set failed: ${e?.message ?? e}`);
				process.exitCode = 1;
			}
		},
	);
}

/* ------------------------------------------------------------------ */
/*  CLI wiring                                                        */
/* ------------------------------------------------------------------ */

const program = new Command("agenthive")
	.description("AgentHive system administration CLI")
	.version("0.1.0");

program
	.command("init")
	.description("One-time system setup (creates user, service, env file)")
	.action(cmdInit);

program
	.command("status")
	.description("Check orchestrator service status")
	.action(cmdStatus);

program
	.command("start")
	.description("Start the orchestrator service")
	.action(cmdStart);

program
	.command("stop")
	.description("Stop the orchestrator service")
	.action(cmdStop);

program
	.command("restart")
	.description("Restart the orchestrator service")
	.action(cmdRestart);

program.command("logs").description("Tail orchestrator logs").action(cmdLogs);

program
	.command("db-ping")
	.description("Ping a database endpoint: postgres | pgbouncer | all")
	.argument("[target]", "postgres | pgbouncer | all", "all")
	.action(cmdDbPing);

// P3563 Step 3: async AC re-execution validator (wires AcTestExecutor logic).
program
	.command("revalidate-ac")
	.description(
		"Re-run test/artifact evidence for a proposal's PASSED ACs; flip failing ones to fail (P3563 Step 3)",
	)
	.requiredOption("--proposal <id>", "Numeric proposal id")
	.option("--worktree <name>", "Worktree dir under /data/code/worktree")
	.action(async (opts: { proposal: string; worktree?: string }) => {
		const { revalidateProposalAcs } = await import(
			"../core/gate/ac-revalidator.ts"
		);
		const pid = Number(opts.proposal);
		if (!Number.isFinite(pid)) {
			console.error("--proposal must be numeric");
			process.exit(2);
		}
		const out = await revalidateProposalAcs(pid, { worktree: opts.worktree });
		console.log(JSON.stringify(out, null, 2));
		process.exit(out.flippedToFail > 0 ? 1 : 0);
	});

// P828 AC-38: audited runtime config mutation from the CLI.
const configCmd = program
	.command("config")
	.description("Runtime config administration");
configCmd
	.command("set")
	.description(
		"Set a runtime config key via the audited ConfigResolver.set() path",
	)
	.requiredOption("--key <key>", "Config key name (e.g. USE_OFFER_DISPATCH)")
	.requiredOption("--value <value>", "New value (parsed by the key's parser)")
	.requiredOption(
		"--operator-id <id>",
		"Operator's control_identity.principal id (audit FK)",
	)
	.action((opts) => cmdConfigSet(opts));

program.parse();
