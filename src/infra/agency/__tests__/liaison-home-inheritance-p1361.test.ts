import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { handleOfferDispatch, type SqlExec } from "../offer-dispatch-handler.ts";
import type { LiaisonMessage } from "../liaison-message-types.ts";
import type { SpawnResult } from "../../../core/orchestration/agent-spawner.ts";

function makeMessage(payload: Record<string, unknown>): LiaisonMessage {
	return {
		message_id: "00000000-0000-0000-0000-000000000136",
		agency_id: "codex-agency-bot",
		sequence: 1n,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		correlation_id: "00000000-0000-0000-0000-00000000c0de",
		payload,
		signed_at: new Date().toISOString(),
		signature: "test-sig",
	};
}

function silentLogger(): Pick<Console, "log" | "warn" | "error"> {
	return { log: () => {}, warn: () => {}, error: () => {} };
}

test("P1361 liaison template is parameterized for per-user HOME/auth context", async () => {
	const template = await readFile(
		"etc-systemd/agenthive-liaison@.service.template",
		"utf8",
	);

	assert.match(template, /^User=\$\{HOME_USER\}$/m);
	assert.match(template, /^Group=\$\{USER_GROUP\}$/m);
	assert.match(template, /^WorkingDirectory=\$\{WORKING_DIRECTORY\}$/m);
	assert.match(template, /^EnvironmentFile=\$\{ENVIRONMENT_FILE\}$/m);
	assert.match(template, /^Environment=HOME=\/home\/\$\{HOME_USER\}$/m);
	assert.match(template, /^ExecStart=\$\{NODE_BIN\} --import jiti\/register scripts\/start-liaison\.ts$/m);
});

test("P1361 offer dispatch spawns with HOME inherited from liaison process", async () => {
	const previousHome = process.env.HOME;
	process.env.HOME = "/home/andy";

	const execCalls: Array<{ sql: string; params: unknown[] }> = [];
	const exec: SqlExec = async (sql, params) => {
		execCalls.push({ sql, params: params ?? [] });
		return { rows: [] };
	};

	let observedHome: string | undefined;
	let codexVersionChecked = false;
	const fakeSpawn = async (req: Record<string, unknown>): Promise<SpawnResult> => {
		observedHome = process.env.HOME;
		codexVersionChecked = req.provider === "codex";
		return {
			agentRunId: "run-p1361-home",
			worktree: req.worktree as string,
			exitCode: 0,
			stdout: "codex --version ok",
			stderr: "",
			durationMs: 1,
		};
	};

	try {
		await handleOfferDispatch("codex-agency-bot", makeMessage({
			offer_id: "00000000-0000-0000-0000-000000013610",
			role: "develop",
			required_capabilities: ["develop"],
			route_hint: "codex",
			dispatch_id: 1361,
			proposal_id: 1361,
			claim_token: "tok-p1361",
			lease_ttl_seconds: 60,
		}), {
			spawn: fakeSpawn as never,
			exec,
			logger: silentLogger(),
			checkCapacity: async () => ({ allowed: true }),
			resolveWorktree: () => "codex-one",
			renewalIntervalMs: 1_000_000,
		});

		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
	}

	assert.equal(observedHome, "/home/andy");
	assert.equal(codexVersionChecked, true);
	assert.equal(
		execCalls.some((call) => call.sql.includes("fn_complete_work_offer")),
		true,
	);
});
