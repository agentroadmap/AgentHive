/**
 * P856: Unit tests for probeAgentLiveness.
 *
 * Uses an injectable queryFn — no DB required. Each test tightly controls
 * what each tier-check returns by routing on SQL fragments.
 */

import { describe, expect, test } from "bun:test";
import {
	probeAgentLiveness,
	type LivenessResult,
	type ProbeOptions,
} from "./agent-liveness.ts";

type Row = Record<string, unknown>;
type QueryStub = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;

interface StubBehavior {
	/** Tier-A: pg_stat_activity LISTEN check. */
	listenActive?: boolean;
	/** Tier-B: agent_health.last_heartbeat_at fresh? */
	heartbeatRecent?: boolean;
	/** Tier-C ping INSERT: number of message id to return; null = throw. */
	pingInsertId?: number | null;
	/** Tier-C poll: pong appears after this many polls (0 = immediately). */
	pongAfterPolls?: number;
	/** Override poll: throw on every poll. */
	pollThrows?: boolean;
}

function makeStub(behavior: StubBehavior): QueryStub {
	let pollCount = 0;
	return async (sql: string, _params?: unknown[]) => {
		if (sql.includes("pg_stat_activity")) {
			return { rows: [{ exists: behavior.listenActive ?? false }] };
		}
		if (sql.includes("agent_health")) {
			return { rows: [{ fresh: behavior.heartbeatRecent ?? false }] };
		}
		if (sql.includes("INSERT INTO roadmap.message_ledger")) {
			if (behavior.pingInsertId === null) throw new Error("synthetic insert error");
			return { rows: [{ id: String(behavior.pingInsertId ?? 12345) }] };
		}
		if (sql.includes("FROM roadmap.message_ledger")) {
			if (behavior.pollThrows) throw new Error("synthetic poll error");
			pollCount += 1;
			const target = behavior.pongAfterPolls ?? Number.POSITIVE_INFINITY;
			if (pollCount > target) {
				return { rows: [{ id: "777", created_at: new Date() }] };
			}
			return { rows: [] };
		}
		return { rows: [] };
	};
}

const baseOpts = (queryFn: QueryStub, extra: Partial<ProbeOptions> = {}): ProbeOptions => ({
	queryFn: queryFn as unknown as ProbeOptions["queryFn"],
	timeoutMs: 500,
	...extra,
});

describe("probeAgentLiveness", () => {
	test("unaddressable: no LISTEN, no recent heartbeat → signal=unaddressable, no ping fired", async () => {
		const stub = makeStub({ listenActive: false, heartbeatRecent: false });
		const r = await probeAgentLiveness("ghost/agent", baseOpts(stub));
		expect(r.alive).toBe(false);
		expect(r.signal).toBe("unaddressable");
		expect(r.reason).toContain("no LISTEN");
	});

	test("cheapOnly + heartbeat fresh → signal=heartbeat, no ping fired", async () => {
		const stub = makeStub({ listenActive: false, heartbeatRecent: true });
		const r = await probeAgentLiveness(
			"some/agent",
			baseOpts(stub, { cheapOnly: true }),
		);
		expect(r.alive).toBe(true);
		expect(r.signal).toBe("heartbeat");
	});

	test("cheapOnly + LISTEN active (no heartbeat) → signal=listen", async () => {
		const stub = makeStub({ listenActive: true, heartbeatRecent: false });
		const r = await probeAgentLiveness(
			"some/agent",
			baseOpts(stub, { cheapOnly: true }),
		);
		expect(r.alive).toBe(true);
		expect(r.signal).toBe("listen");
	});

	test("active ping: pong arrives within timeout → signal=pong, alive=true", async () => {
		const stub = makeStub({
			listenActive: true,
			heartbeatRecent: false,
			pongAfterPolls: 1,
		});
		const r = await probeAgentLiveness("some/agent", baseOpts(stub));
		expect(r.alive).toBe(true);
		expect(r.signal).toBe("pong");
		expect(r.latency_ms).toBeGreaterThanOrEqual(0);
	});

	test("active ping: no pong within timeout → signal=silent", async () => {
		const stub = makeStub({
			listenActive: true,
			heartbeatRecent: false,
			pongAfterPolls: 999, // never within budget
		});
		const r = await probeAgentLiveness(
			"some/agent",
			baseOpts(stub, { timeoutMs: 250 }),
		);
		expect(r.alive).toBe(false);
		expect(r.signal).toBe("silent");
		expect(r.reason).toMatch(/no protocol_pong within/);
	});

	test("ping INSERT fails → signal=silent, no throw", async () => {
		const stub = makeStub({
			listenActive: true,
			heartbeatRecent: false,
			pingInsertId: null,
		});
		const r = await probeAgentLiveness("some/agent", baseOpts(stub));
		expect(r.alive).toBe(false);
		expect(r.signal).toBe("silent");
		expect(r.reason).toContain("ping insert failed");
	});

	test("never throws on completely failing query function", async () => {
		const failing: QueryStub = async () => {
			throw new Error("DB is down");
		};
		// Should not throw — both Tier-A and Tier-B swallow errors and return
		// false, so we end up at signal='unaddressable'.
		let result: LivenessResult | null = null;
		await expect(
			(async () => {
				result = await probeAgentLiveness(
					"some/agent",
					baseOpts(failing),
				);
			})(),
		).resolves.toBeUndefined();
		expect(result).not.toBeNull();
		expect(result!.signal).toBe("unaddressable");
	});

	test("signal='unaddressable' carries the documented caller-warning reason", async () => {
		// AC-6 sanity: the doc comment explicitly warns NOT to release leases on
		// unaddressable. We surface that intent in the reason string too.
		const stub = makeStub({ listenActive: false, heartbeatRecent: false });
		const r = await probeAgentLiveness("ghost/agent", baseOpts(stub));
		expect(r.signal).toBe("unaddressable");
		expect(r.reason).toMatch(/cannot probe/);
	});

	test("default identity for ping is 'orchestrator' unless overridden", async () => {
		let capturedFromAgent: string | null = null;
		const sniff: QueryStub = async (sql, params) => {
			if (sql.includes("pg_stat_activity")) return { rows: [{ exists: true }] };
			if (sql.includes("agent_health")) return { rows: [{ fresh: false }] };
			if (sql.includes("INSERT INTO roadmap.message_ledger")) {
				capturedFromAgent = (params?.[0] as string) ?? null;
				return { rows: [{ id: "1" }] };
			}
			return { rows: [{ id: "2", created_at: new Date() }] }; // satisfy poll
		};
		await probeAgentLiveness("any/agent", baseOpts(sniff));
		expect(capturedFromAgent).toBe("orchestrator");

		await probeAgentLiveness(
			"any/agent",
			baseOpts(sniff, { probeFromAgent: "scanner" }),
		);
		expect(capturedFromAgent).toBe("scanner");
	});
});
