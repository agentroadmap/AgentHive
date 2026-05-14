import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	OfferProvider,
	type ListenerClient,
	type NotificationMessage,
	type QueryFn,
	type SpawnFn,
} from "../../src/core/pipeline/offer-provider.ts";

// ─── Minimal fakes (mirrors offer-provider.test.ts pattern) ──────────────────

type SqlCall = { text: string; params?: unknown[] };
type QueryResultLike = { rows: unknown[]; rowCount?: number };

function makeLogger() {
	const lines: string[] = [];
	return {
		log: (...a: unknown[]) => lines.push(a.join(" ")),
		warn: (...a: unknown[]) => lines.push("WARN " + a.join(" ")),
		error: (...a: unknown[]) => lines.push("ERR " + a.join(" ")),
		lines,
	};
}

function makeIntervals() {
	const handles = new Map<ReturnType<typeof setInterval>, () => void>();
	let nextId = 1;
	function setIntervalFn(fn: () => void, _ms: number) {
		const id = nextId++ as unknown as ReturnType<typeof setInterval>;
		handles.set(id, fn);
		return id;
	}
	function clearIntervalFn(id: ReturnType<typeof setInterval> | undefined) {
		if (id !== undefined) handles.delete(id);
	}
	return { setIntervalFn, clearIntervalFn, handles };
}

type NotifyHandler = (msg: NotificationMessage) => void;

function makeListener() {
	const handlers: NotifyHandler[] = [];
	const client: ListenerClient = {
		async query() {
			return { rows: [] };
		},
		on(event: string, handler: unknown) {
			if (event === "notification") handlers.push(handler as NotifyHandler);
		},
		removeListener(event: string, handler: unknown) {
			if (event === "notification") {
				const idx = handlers.indexOf(handler as NotifyHandler);
				if (idx !== -1) handlers.splice(idx, 1);
			}
		},
	};
	return { client };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OfferProvider — P798 routing", () => {
	it("surfaces route_provider from claim row through to spawn log", async () => {
		const sqlCalls: SqlCall[] = [];
		const logLines: string[] = [];

		const claimRow = {
			dispatch_id: 601,
			proposal_id: 10,
			squad_name: "P10-develop",
			dispatch_role: "developer",
			claim_token: "rrrr-pppp",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 1,
			metadata: { task: "Build routing feature", stage: "Develop" },
			route_provider: "anthropic",
		};
		const claimsLeft = [claimRow, null];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				const row = claimsLeft.shift();
				return { rows: row ? [row] : [] } as QueryResultLike;
			}
			if (text.includes("fn_activate_work_offer")) {
				return { rows: [{ ok: true }] } as QueryResultLike;
			}
			if (text.includes("fn_complete_work_offer")) {
				return { rows: [] } as QueryResultLike;
			}
			return { rows: [] } as QueryResultLike;
		}) as unknown as QueryFn;

		const spawnFn: SpawnFn = async () => ({
			agentRunId: "run-route-1",
			worktree: "claude-one",
			exitCode: 0,
			stdout: "done",
			stderr: "",
			durationMs: 50,
		});

		const logger = {
			log: (...a: unknown[]) => logLines.push(a.join(" ")),
			warn: (...a: unknown[]) => logLines.push("WARN " + a.join(" ")),
			error: (...a: unknown[]) => logLines.push("ERR " + a.join(" ")),
		};

		const { client } = makeListener();
		const intervals = makeIntervals();

		const provider = new OfferProvider({
			agentIdentity: "claude-one",
			queryFn,
			connectListener: async () => client,
			spawnFn,
			logger,
			setIntervalFn: intervals.setIntervalFn as unknown as typeof setInterval,
			clearIntervalFn: intervals.clearIntervalFn as unknown as typeof clearInterval,
		});

		await provider.run();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		// route_provider from the claim row must appear in the log line
		assert.ok(
			logLines.some((l) => l.includes("route: anthropic")),
			`expected 'route: anthropic' in log lines, got: ${JSON.stringify(logLines)}`,
		);

		// SELECT must include route_provider column
		const claimCall = sqlCalls.find((c) => c.text.includes("fn_claim_work_offer"));
		assert.ok(claimCall, "fn_claim_work_offer must be called");
		assert.ok(
			claimCall!.text.includes("route_provider"),
			"SELECT must include route_provider column",
		);

		await provider.stop();
		intervals.handles.clear();
	});

	it("does not spawn when fn_claim_work_offer returns empty rows (policy blocks all routes)", async () => {
		const sqlCalls: SqlCall[] = [];
		let spawnCalled = false;

		// Simulate DB returning empty result — equivalent to project_route_policy
		// blocking all available routes for the project.
		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			// fn_claim_work_offer returns no rows (policy declined the claim)
			if (text.includes("fn_claim_work_offer")) {
				return { rows: [] } as QueryResultLike;
			}
			return { rows: [] } as QueryResultLike;
		}) as unknown as QueryFn;

		const spawnFn: SpawnFn = async () => {
			spawnCalled = true;
			return { agentRunId: "x", worktree: "claude-one", exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
		};

		const { client } = makeListener();
		const intervals = makeIntervals();
		const logger = makeLogger();

		const provider = new OfferProvider({
			agentIdentity: "claude-one",
			queryFn,
			connectListener: async () => client,
			spawnFn,
			logger,
			setIntervalFn: intervals.setIntervalFn as unknown as typeof setInterval,
			clearIntervalFn: intervals.clearIntervalFn as unknown as typeof clearInterval,
		});

		await provider.run();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		assert.ok(!spawnCalled, "spawn must NOT be called when fn_claim_work_offer returns no rows");

		await provider.stop();
		intervals.handles.clear();
	});

	it("handles null route_provider gracefully (unconstrained project, no model routes seeded)", async () => {
		const sqlCalls: SqlCall[] = [];
		let spawnCalled = false;

		// Claim row with route_provider = null — valid when no constraints exist
		const claimRow = {
			dispatch_id: 602,
			proposal_id: 20,
			squad_name: "P20-review",
			dispatch_role: "reviewer",
			claim_token: "nnnn-rrrr",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 1,
			metadata: { task: "Review design" },
			route_provider: null,
		};
		const claimsLeft = [claimRow, null];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				const row = claimsLeft.shift();
				return { rows: row ? [row] : [] } as QueryResultLike;
			}
			if (text.includes("fn_activate_work_offer")) {
				return { rows: [{ ok: true }] } as QueryResultLike;
			}
			if (text.includes("fn_complete_work_offer")) {
				return { rows: [] } as QueryResultLike;
			}
			return { rows: [] } as QueryResultLike;
		}) as unknown as QueryFn;

		const spawnFn: SpawnFn = async () => {
			spawnCalled = true;
			return { agentRunId: "run-null-route", worktree: "claude-one", exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
		};

		const { client } = makeListener();
		const intervals = makeIntervals();
		const logger = makeLogger();

		const provider = new OfferProvider({
			agentIdentity: "claude-one",
			queryFn,
			connectListener: async () => client,
			spawnFn,
			logger,
			setIntervalFn: intervals.setIntervalFn as unknown as typeof setInterval,
			clearIntervalFn: intervals.clearIntervalFn as unknown as typeof clearInterval,
		});

		await provider.run();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		// Spawn should still be called — null route_provider is not an error
		assert.ok(spawnCalled, "spawn must be called even when route_provider is null");

		// Log must NOT contain 'route:' when route_provider is null
		assert.ok(
			!logger.lines.some((l) => l.includes("route:")),
			"log must not mention route when route_provider is null",
		);

		await provider.stop();
		intervals.handles.clear();
	});
});
