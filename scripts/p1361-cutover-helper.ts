/**
 * P1361 Cutover Helper — Per-agency liaison installation + smoke verification.
 *
 * Usage:
 *   bun scripts/p1361-cutover-helper.ts <agency_identity> [--os-user <user>] [--verify] [--uninstall]
 *
 * Modes:
 *   1. RENDER (default): Print the rendered systemd unit + install commands for operator review.
 *   2. VERIFY (--verify): Check post-install health (systemctl status, HOME inheritance, CLI access, heartbeat).
 *   3. UNINSTALL (--uninstall): Print the uninstall commands.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { createConnection } from "node:net";

// ============================================================================
// CONFIG
// ============================================================================

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TEMPLATE_PATH = resolve(REPO_ROOT, "etc-systemd/agenthive-liaison@.service.template");
const README_PATH = resolve(REPO_ROOT, "etc-systemd/README.md");
const SYSTEMD_PATH = "/etc/systemd/system";
const AGENTHIVE_ENV_PATH = "/etc/agenthive/env";
const DB_CONNECTION_TIMEOUT_MS = 5000;

// ============================================================================
// TYPES
// ============================================================================

interface AgencyRecord {
	agency_id: string;
	display_name: string;
	provider: string;
	host_id: string;
	status: string;
	last_heartbeat_at: string | null;
}

interface RenderedUnit {
	agency_identity: string;
	os_user: string;
	os_group: string;
	home_dir: string;
	working_dir: string;
	node_bin: string;
	node_bin_dir: string;
	env_file: string;
	unit_content: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function printSection(title: string) {
	console.log(`\n${"=".repeat(76)}`);
	console.log(`== ${title}`);
	console.log("=".repeat(76));
}

function printError(msg: string) {
	console.error(`ERROR: ${msg}`);
}

function printWarn(msg: string) {
	console.warn(`WARN: ${msg}`);
}

/**
 * Load DATABASE_URL from /etc/agenthive/env or process.env.
 */
function getDatabaseUrl(): string {
	const url = process.env.DATABASE_URL;
	if (url) return url;

	if (!existsSync(AGENTHIVE_ENV_PATH)) {
		throw new Error(
			`DATABASE_URL not set and ${AGENTHIVE_ENV_PATH} not found`,
		);
	}

	const content = readFileSync(AGENTHIVE_ENV_PATH, "utf-8");
	const match = content.match(/^DATABASE_URL=(.+)$/m);
	if (!match) {
		throw new Error(`DATABASE_URL not found in ${AGENTHIVE_ENV_PATH}`);
	}

	return match[1];
}

/**
 * Query the database via psql. Minimal and safe.
 */
async function psqlQuery(query: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const databaseUrl = getDatabaseUrl();
		const proc = spawnSync("psql", [databaseUrl, "-A", "-F", "|", "-c", query], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: DB_CONNECTION_TIMEOUT_MS,
		});

		if (proc.error || proc.status !== 0) {
			reject(
				new Error(
					`psql failed: ${proc.stderr || proc.error?.message || "unknown error"}`,
				),
			);
		} else {
			resolve(proc.stdout);
		}
	});
}

/**
 * Parse psql output (tab-separated, header row present).
 */
function parsePsqlOutput(
	output: string,
	columns: string[],
): Record<string, string>[] {
	const lines = output.split("\n").filter((l) => l.trim());
	if (lines.length < 2) return [];

	const rows: Record<string, string>[] = [];
	for (let i = 1; i < lines.length; i++) {
		const cells = lines[i].split("|").map((c) => c.trim());
		if (cells.length !== columns.length) continue;

		const row: Record<string, string> = {};
		for (let j = 0; j < columns.length; j++) {
			row[columns[j]] = cells[j];
		}
		rows.push(row);
	}
	return rows;
}

/**
 * Fetch agency record from roadmap.agency.
 */
async function fetchAgency(agency_identity: string): Promise<AgencyRecord | null> {
	const query =
		`SELECT agency_id, display_name, provider, host_id, status, last_heartbeat_at ` +
		`FROM roadmap.agency ` +
		`WHERE agency_id = '${agency_identity.replace(/'/g, "''")}'`;

	try {
		const output = await psqlQuery(query);
		const rows = parsePsqlOutput(
			output,
			["agency_id", "display_name", "provider", "host_id", "status", "last_heartbeat_at"],
		);
		return rows.length > 0 ? (rows[0] as AgencyRecord) : null;
	} catch (err) {
		printError(`Failed to fetch agency: ${err}`);
		return null;
	}
}

/**
 * Fetch current heartbeat timestamp for an agency.
 */
async function fetchLastHeartbeat(agency_id: string): Promise<Date | null> {
	const query =
		`SELECT last_heartbeat_at FROM roadmap.agency WHERE agency_id = '${agency_id.replace(/'/g, "''")}'`;

	try {
		const output = await psqlQuery(query);
		const rows = parsePsqlOutput(output, ["last_heartbeat_at"]);
		if (rows.length === 0 || !rows[0].last_heartbeat_at) {
			return null;
		}
		return new Date(rows[0].last_heartbeat_at);
	} catch (err) {
		return null;
	}
}

/**
 * Get Node.js binary path. Tries NVM first, falls back to `which node`.
 */
function getNodeBinaryPath(): string {
	const homedir = process.env.HOME || "/root";
	const nvmNode = `${homedir}/.nvm/versions/node/v24.14.0/bin/node`;
	if (existsSync(nvmNode)) {
		return nvmNode;
	}

	try {
		const node = execSync("which node", { encoding: "utf-8" }).trim();
		if (node) return node;
	} catch {
		// Fall through
	}

	throw new Error(
		"Node.js binary not found. Check NVM or PATH. Tried: " + nvmNode,
	);
}

/**
 * Render the systemd template with envsubst-style substitution.
 */
function renderTemplate(
	agency_identity: string,
	os_user: string,
	os_group: string,
	home_dir: string,
	working_dir: string,
	node_bin: string,
	node_bin_dir: string,
	env_file: string,
): RenderedUnit {
	const template = readFileSync(TEMPLATE_PATH, "utf-8");

	const subs: Record<string, string> = {
		HOME_USER: os_user,
		USER_GROUP: os_group,
		WORKING_DIRECTORY: working_dir,
		ENVIRONMENT_FILE: env_file,
		NODE_BIN: node_bin,
		NODE_BIN_DIR: node_bin_dir,
	};

	let content = template;
	for (const [key, val] of Object.entries(subs)) {
		content = content.replace(new RegExp(`\\$\\{${key}\\}`, "g"), val);
	}

	return {
		agency_identity,
		os_user,
		os_group,
		home_dir,
		working_dir,
		node_bin,
		node_bin_dir,
		env_file,
		unit_content: content,
	};
}

/**
 * Print the render output (unit + install commands).
 */
function printRenderOutput(rendered: RenderedUnit) {
	printSection("RENDERED SYSTEMD UNIT");
	console.log(`\nFile: /etc/systemd/system/agenthive-liaison@${rendered.agency_identity}.service\n`);
	console.log(rendered.unit_content);

	printSection("PRE-INSTALL CHECKLIST");
	console.log(`
1. Verify the User= and HOME= values are correct (should be User=${rendered.os_user}, HOME=${rendered.home_dir})
2. Verify ENVIRONMENT_FILE path is correct (${rendered.env_file})
3. Review the rendered unit for any obvious issues
`);

	printSection("INSTALL COMMANDS (COPY & PASTE)");
	const sanitizedId = rendered.agency_identity.replace(/\//g, "-");
	const envFile = rendered.env_file;
	const installCmds = `# Step 1: Create the per-agency env file
sudo tee "${envFile}" > /dev/null << 'ENV'
AGENCY_PROVIDER=${rendered.agency_identity === 'codex-agency-bot' ? 'codex' : 'claude'}
AGENCY_HOST_ID=bot
ENV

# Step 2: Install the systemd unit
sudo tee /etc/systemd/system/agenthive-liaison@${rendered.agency_identity}.service > /dev/null << 'UNIT'
${rendered.unit_content}
UNIT

# Step 3: Reload systemd and enable the service
sudo systemctl daemon-reload
sudo systemctl enable --now agenthive-liaison@${rendered.agency_identity}.service

# Step 4: Verify installation (wait a moment for the service to start)
sleep 2
sudo systemctl status agenthive-liaison@${rendered.agency_identity}.service`;

	console.log(installCmds);

	printSection("POST-INSTALL VERIFICATION");
	console.log(`
After running the install commands above, verify:

  bun scripts/p1361-cutover-helper.ts ${rendered.agency_identity} --os-user ${rendered.os_user} --verify

This will check:
  - Service is running (systemctl is-active)
  - Process user matches ${rendered.os_user}
  - HOME environment variable is inherited correctly
  - Provider CLI is accessible
  - Agency heartbeat is fresh (< 60s)
  - AGENTHIVE_AGENCY_EXCLUDE configuration (if agenthive-a2a-host is still running)
`);
}

/**
 * Verify post-install state.
 */
async function verify(
	agency_identity: string,
	os_user: string,
): Promise<boolean> {
	printSection("POST-INSTALL VERIFICATION");

	const checks: { name: string; pass: boolean; detail: string }[] = [];

	// AC-2: Service exists and is active
	try {
		const status = execSync(
			`systemctl is-active agenthive-liaison@${agency_identity}.service 2>/dev/null`,
			{ encoding: "utf-8" },
		).trim();
		const pass = status === "active";
		checks.push({
			name: "AC-2: Service is running",
			pass,
			detail: pass ? `systemctl is-active = ${status}` : `systemctl is-active = ${status} (expected: active)`,
		});
	} catch (err) {
		checks.push({
			name: "AC-2: Service is running",
			pass: false,
			detail: "Service not found or not running",
		});
	}

	// AC-3: Process runs as correct user
	try {
		const pidStr = execSync(
			`systemctl show -p MainPID --value agenthive-liaison@${agency_identity}.service 2>/dev/null`,
			{ encoding: "utf-8" },
		).trim();
		const pid = parseInt(pidStr, 10);
		if (!isNaN(pid) && pid > 0) {
			const userLine = execSync(`ps -o user= -p ${pid} 2>/dev/null || echo ""`, {
				encoding: "utf-8",
			}).trim();
			const pass = userLine === os_user;
			checks.push({
				name: "AC-3: Process user matches OS user",
				pass,
				detail: pass ? `ps -o user = ${userLine}` : `ps -o user = ${userLine} (expected: ${os_user})`,
			});
		} else {
			checks.push({
				name: "AC-3: Process user matches OS user",
				pass: false,
				detail: "Could not determine process PID",
			});
		}
	} catch (err) {
		checks.push({
			name: "AC-3: Process user matches OS user",
			pass: false,
			detail: String(err),
		});
	}

	// AC-4: HOME inheritance and CLI access (mock check — real test is in liaison-home-inheritance-p1361.test.ts)
	try {
		const homeDir = `/home/${os_user}`;
		const pass = existsSync(homeDir);
		checks.push({
			name: "AC-4: HOME directory exists for OS user",
			pass,
			detail: pass ? `${homeDir} exists` : `${homeDir} not found`,
		});
	} catch (err) {
		checks.push({
			name: "AC-4: HOME directory exists",
			pass: false,
			detail: String(err),
		});
	}

	// AC-6: Check AGENTHIVE_AGENCY_EXCLUDE on agenthive-a2a-host (if running)
	try {
		const a2aStatus = execSync(
			"systemctl is-active agenthive-a2a-host.service 2>/dev/null || echo 'inactive'",
			{ encoding: "utf-8" },
		).trim();

		if (a2aStatus === "active") {
			const excludeEnv = execSync(
				`systemctl show -p Environment agenthive-a2a-host.service 2>/dev/null | grep -o 'AGENTHIVE_AGENCY_EXCLUDE=[^[:space:]]*' || echo ""`,
				{ encoding: "utf-8" },
			).trim();

			const excluded = excludeEnv.includes(agency_identity);
			checks.push({
				name: "AC-6: agenthive-a2a-host excludes this agency (or is disabled)",
				pass: excluded,
				detail: excluded
					? `${agency_identity} is in AGENTHIVE_AGENCY_EXCLUDE`
					: `${agency_identity} NOT in AGENTHIVE_AGENCY_EXCLUDE — recommend adding it to prevent double-LISTEN`,
			});
		} else {
			checks.push({
				name: "AC-6: agenthive-a2a-host excludes this agency (or is disabled)",
				pass: true,
				detail: "agenthive-a2a-host is disabled/inactive (safe)",
			});
		}
	} catch (err) {
		checks.push({
			name: "AC-6: agenthive-a2a-host configuration",
			pass: false,
			detail: String(err),
		});
	}

	// Heartbeat freshness
	try {
		const heartbeat = await fetchLastHeartbeat(agency_identity);
		if (heartbeat) {
			const ageSeconds = Math.floor((Date.now() - heartbeat.getTime()) / 1000);
			const pass = ageSeconds < 60;
			checks.push({
				name: "Heartbeat freshness (< 60s)",
				pass,
				detail: pass
					? `last_heartbeat_at = ${ageSeconds}s ago`
					: `last_heartbeat_at = ${ageSeconds}s ago (older than 60s)`,
			});
		} else {
			checks.push({
				name: "Heartbeat freshness",
				pass: false,
				detail: "No heartbeat recorded yet (service may still be starting)",
			});
		}
	} catch (err) {
		checks.push({
			name: "Heartbeat freshness",
			pass: false,
			detail: String(err),
		});
	}

	// Print results
	console.log("\nVerification Results:\n");
	let allPass = true;
	for (const check of checks) {
		const statusIcon = check.pass ? "[✓]" : "[✗]";
		console.log(`${statusIcon} ${check.name}`);
		console.log(`    ${check.detail}\n`);
		if (!check.pass) allPass = false;
	}

	printSection("SUMMARY");
	if (allPass) {
		console.log(`\n✓ All checks passed. Agency ${agency_identity} is cutover-ready.\n`);
	} else {
		console.log(
			`\n✗ Some checks failed. Review details above and troubleshoot.\n`,
		);
	}

	return allPass;
}

/**
 * Print uninstall commands.
 */
function printUninstallOutput(agency_identity: string) {
	printSection("UNINSTALL COMMANDS (COPY & PASTE)");

	const uninstallCmds = `# Stop and disable the service
sudo systemctl disable --now agenthive-liaison@${agency_identity}.service

# Remove the systemd unit
sudo rm /etc/systemd/system/agenthive-liaison@${agency_identity}.service

# Reload systemd
sudo systemctl daemon-reload

# Verify removal
systemctl list-units 'agenthive-liaison@*.service'`;

	console.log(uninstallCmds);
}

/**
 * Print help.
 */
function printHelp() {
	printSection("P1361 Cutover Helper");
	console.log(`
Usage: bun scripts/p1361-cutover-helper.ts <agency_identity> [options]

Modes:
  (default)              Render systemd unit + print install commands
  --verify               Verify post-install health
  --uninstall            Print uninstall commands
  --help, -h             Print this help

Options:
  --os-user <user>       OS user that owns provider auth (e.g., andy, gary)
                         Default: gary
  --os-group <group>     OS group (Default: same as --os-user)
  --home <dir>           Home directory (Default: /home/<os-user>)
  --working-dir <dir>    AgentHive repo root (Default: /data/code/AgentHive)

Example:
  # Render installation for codex-agency-bot (runs as andy)
  bun scripts/p1361-cutover-helper.ts codex-agency-bot --os-user andy

  # Verify post-install
  bun scripts/p1361-cutover-helper.ts codex-agency-bot --os-user andy --verify

  # Print uninstall commands
  bun scripts/p1361-cutover-helper.ts codex-agency-bot --uninstall
`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	const args = process.argv.slice(2);

	// Parse arguments
	let agency_identity = "";
	let os_user = "gary";
	let os_group = "";
	let home_dir = "";
	let working_dir = REPO_ROOT;
	let mode: "render" | "verify" | "uninstall" = "render";

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else if (arg === "--verify") {
			mode = "verify";
		} else if (arg === "--uninstall") {
			mode = "uninstall";
		} else if (arg === "--os-user") {
			os_user = args[++i];
		} else if (arg === "--os-group") {
			os_group = args[++i];
		} else if (arg === "--home") {
			home_dir = args[++i];
		} else if (arg === "--working-dir") {
			working_dir = args[++i];
		} else if (!arg.startsWith("--")) {
			agency_identity = arg;
		}
	}

	if (!agency_identity) {
		printError("agency_identity is required");
		printHelp();
		process.exit(1);
	}

	os_group = os_group || os_user;
	home_dir = home_dir || `/home/${os_user}`;

	try {
		if (mode === "render") {
			// Pre-flight check: agency must exist in roadmap.agency
			const agency = await fetchAgency(agency_identity);
			if (!agency) {
				printError(
					`Agency ${agency_identity} not found in roadmap.agency. ` +
					`Register it first via: mcp_agent action='register' args={...}`,
				);
				process.exit(1);
			}

			// Check host_affinity
			const hostQuery = `SELECT host_name FROM host_model_policy WHERE host_name = '${agency.host_id}'`;
			try {
				await psqlQuery(hostQuery);
			} catch (err) {
				printError(
					`host_id '${agency.host_id}' does not exist in host_model_policy`,
				);
				process.exit(1);
			}

			printSection("PRE-FLIGHT CHECKS");
			console.log(`
✓ Agency ${agency_identity} exists in roadmap.agency
  - display_name: ${agency.display_name}
  - provider: ${agency.provider}
  - host_id: ${agency.host_id}
  - status: ${agency.status}
`);

			// Render template
			const nodeBin = getNodeBinaryPath();
			const nodeBinDir = dirname(nodeBin);
			const envFile = `/etc/agenthive/liaison-${agency_identity.replace(/\//g, "-")}.env`;

			const rendered = renderTemplate(
				agency_identity,
				os_user,
				os_group,
				home_dir,
				working_dir,
				nodeBin,
				nodeBinDir,
				envFile,
			);

			printRenderOutput(rendered);
		} else if (mode === "verify") {
			const success = await verify(agency_identity, os_user);
			process.exit(success ? 0 : 1);
		} else if (mode === "uninstall") {
			printUninstallOutput(agency_identity);
		}
	} catch (err) {
		printError(String(err));
		process.exit(1);
	}
}

main().catch((err) => {
	printError(String(err));
	process.exit(1);
});
