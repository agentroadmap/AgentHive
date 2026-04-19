import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	OfferProvider,
	type ListenerClient,
	type NotificationMessage,
	type QueryFn,
	type SpawnFn,
} from "../../src/core/pipeline/offer-provider.ts";

// ─── Minimal fakes ────────────────────────────────────────────────────────────

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
	function fireAll() {
		for (const fn of handles.values()) fn();
	}
	return { setIntervalFn, clearIntervalFn, fireAll, handles };
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
	function emit(msg: NotificationMessage) {
		for (const h of handlers) h(msg);
	}
	return { client, emit };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OfferProvider", () => {
	it("claims, activates, spawns, and completes an offer on start", async () => {
		const sqlCalls: SqlCall[] = [];
		let spawnCalled = false;

		const claimRow = {
			dispatch_id: 101,
			proposal_id: 42,
			squad_name: "P42-develop",
			dispatch_role: "developer",
			claim_token: "aaaa-bbbb",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 1,
			metadata: { task: "Build the thing", stage: "Develop" },
		};

		const claimsLeft = [claimRow, null]; // second call returns nothing

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				const row = claimsLeft.shift();
				return { rows: row ? [row] : [] } as unknown as QueryResultLike;
			}
			if (text.includes("fn_activate_work_offer")) {
				return { rows: [{ ok: true }] } as unknown as QueryResultLike;
			}
			if (text.includes("fn_complete_work_offer")) {
				return { rows: [] } as unknown as QueryResultLike;
			}
			return { rows: [] } as unknown as QueryResultLike;
		}) as unknown as QueryFn;

		const spawnFn: SpawnFn = async (req) => {
			spawnCalled = true;
			assert.equal(req.worktree, "claude-one");
			assert.equal(req.proposalId, 42);
			assert.equal(req.task, "Build the thing");
			return {
				agentRunId: "run-1",
				worktree: "claude-one",
				exitCode: 0,
				stdout: "done",
				stderr: "",
				durationMs: 100,
			};
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
			leaseTtlSeconds: 30,
		});

		await provider.run();
		// Let the async executeOffer settle
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		assert.ok(spawnCalled, "spawn must be called");

		const activateCall = sqlCalls.find((c) => c.text.includes("fn_activate_work_offer"));
		assert.ok(activateCall, "fn_activate_work_offer must be called");
		assert.equal(activateCall!.params?.[0], 101);
		assert.equal(activateCall!.params?.[1], "claude-one");

		const completeCall = sqlCalls.find((c) => c.text.includes("fn_complete_work_offer"));
		assert.ok(completeCall, "fn_complete_work_offer must be called");
		assert.equal(completeCall!.params?.[3], "delivered");

		await provider.stop();
		intervals.handles.clear();
	});

	it("marks failed when spawn throws", async () => {
		const sqlCalls: SqlCall[] = [];
		const claimRow = {
			dispatch_id: 202,
			proposal_id: 7,
			squad_name: "P7-build",
			dispatch_role: "developer",
			claim_token: "cccc-dddd",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 1,
			metadata: { task: "do work" },
		};
		const claimsLeft = [claimRow, null];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				const r = claimsLeft.shift();
				return { rows: r ? [r] : [] } as unknown as QueryResultLike;
			}
			if (text.includes("fn_activate_work_offer")) {
				return { rows: [{ ok: true }] } as unknown as QueryResultLike;
			}
			return { rows: [] } as unknown as QueryResultLike;
		}) as unknown as QueryFn;

		const spawnFn: SpawnFn = async () => {
			throw new Error("CLI crashed");
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

		const completeCall = sqlCalls.find((c) => c.text.includes("fn_complete_work_offer"));
		assert.ok(completeCall, "fn_complete_work_offer must be called on error");
		assert.equal(completeCall!.params?.[3], "failed");

		await provider.stop();
		intervals.handles.clear();
	});

	it("skips claim and logs when activation is rejected (reaped race)", async () => {
		const sqlCalls: SqlCall[] = [];
		let spawnCalled = false;
		const claimRow = {
			dispatch_id: 303,
			proposal_id: 5,
			squad_name: "P5-review",
			dispatch_role: "reviewer",
			claim_token: "eeee-ffff",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 2,
			metadata: { task: "review it" },
		};
		const claimsLeft = [claimRow, null];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				const r = claimsLeft.shift();
				return { rows: r ? [r] : [] } as unknown as QueryResultLike;
			}
			if (text.includes("fn_activate_work_offer")) {
				return { rows: [{ ok: false }] } as unknown as QueryResultLike;
			}
			return { rows: [] } as unknown as QueryResultLike;
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

		assert.ok(!spawnCalled, "spawn must NOT be called when activation rejected");
		assert.ok(
			logger.lines.some((l) => l.includes("activation rejected")),
			"warn about activation rejection",
		);

		await provider.stop();
		intervals.handles.clear();
	});

	it("triggers tryClaimLoop on work_offers notification", async () => {
		const sqlCalls: SqlCall[] = [];
		const claimRow = {
			dispatch_id: 404,
			proposal_id: 99,
			squad_name: "P99-draft",
			dispatch_role: "architect",
			claim_token: "gggg-hhhh",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 1,
			metadata: { task: "design" },
		};
		// First poll returns nothing; the NOTIFY triggers a second claim call
		const claimsLeft = [null, claimRow, null];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				const r = claimsLeft.shift();
				return { rows: r ? [r] : [] } as unknown as QueryResultLike;
			}
			if (text.includes("fn_activate_work_offer")) {
				return { rows: [{ ok: true }] } as unknown as QueryResultLike;
			}
			return { rows: [] } as unknown as QueryResultLike;
		}) as unknown as QueryFn;

		let spawnCount = 0;
		const spawnFn: SpawnFn = async () => {
			spawnCount++;
			return { agentRunId: "x", worktree: "claude-one", exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
		};

		const { client, emit } = makeListener();
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
		await new Promise((r) => setImmediate(r)); // first poll settles (null)

		// Fire the NOTIFY — simulates orchestrator emitting an offer
		emit({ channel: "work_offers", payload: '{"event":"emitted","dispatch_id":404}' });
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const claimCalls = sqlCalls.filter((c) => c.text.includes("fn_claim_work_offer"));
		assert.ok(claimCalls.length >= 2, "should have attempted claim at least twice");
		assert.equal(spawnCount, 1, "exactly one spawn after notify");

		await provider.stop();
		intervals.handles.clear();
	});

	it("renews lease on the renewal interval while spawn is running", async () => {
		const sqlCalls: SqlCall[] = [];

		const claimRow = {
			dispatch_id: 505,
			proposal_id: 11,
			squad_name: "P11-develop",
			dispatch_role: "developer",
			claim_token: "iiii-jjjj",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 1,
			metadata: { task: "long work" },
		};
		const claimsLeft = [claimRow, null];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				const r = claimsLeft.shift();
				return { rows: r ? [r] : [] } as unknown as QueryResultLike;
			}
			if (text.includes("fn_activate_work_offer")) {
				return { rows: [{ ok: true }] } as unknown as QueryResultLike;
			}
			if (text.includes("fn_renew_lease")) {
				return { rows: [{ ok: true }] } as unknown as QueryResultLike;
			}
			return { rows: [] } as unknown as QueryResultLike;
		}) as unknown as QueryFn;

		const intervals = makeIntervals();
		let resolveSpawn!: () => void;
		const spawnFn: SpawnFn = () =>
			new Promise((res) => {
				resolveSpawn = () =>
					res({ agentRunId: "x", worktree: "claude-one", exitCode: 0, stdout: "", stderr: "", durationMs: 500 });
			});

		const { client } = makeListener();
		const logger = makeLogger();

		const provider = new OfferProvider({
			agentIdentity: "claude-one",
			queryFn,
			connectListener: async () => client,
			spawnFn,
			logger,
			setIntervalFn: intervals.setIntervalFn as unknown as typeof setInterval,
			clearIntervalFn: intervals.clearIntervalFn as unknown as typeof clearInterval,
			renewIntervalMs: 100,
		});

		await provider.run();
		await new Promise((r) => setImmediate(r)); // claim + activate fire

		// Fire the renewal timer once
		intervals.fireAll();
		await new Promise((r) => setImmediate(r));

		const renewCall = sqlCalls.find((c) => c.text.includes("fn_renew_lease"));
		assert.ok(renewCall, "fn_renew_lease must be called during spawn");
		assert.equal(renewCall!.params?.[0], 505);
		assert.equal(renewCall!.params?.[1], "claude-one");

		// Let spawn complete
		resolveSpawn();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		await provider.stop();
		intervals.handles.clear();
	});
});
