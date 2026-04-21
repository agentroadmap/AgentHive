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
		await new Promise((r) => setTimeout(r, 50));
		await new Promise((r) => setImmediate(r));

		// Debug: dump all SQL calls
		for (const c of sqlCalls) {
			const shortText = c.text.replace(/\s+/g, ' ').trim().substring(0, 80);
			console.log(`SQL: ${shortText} params=${JSON.stringify(c.params)}`);
		}
		console.log('logger lines:', logger.lines);
		console.log('spawnCalled:', spawnCalled);

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
});
