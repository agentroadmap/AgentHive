import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
	OWNERSHIP_MATRIX,
	getPrimaryOwner,
	getPassiveConsumers,
	isWriteAuthorized,
	describeOwnership,
	acquireLease,
	releaseLease,
	releaseAllLeases,
	renewLease,
	heartbeat,
	listActiveLeases,
	setServiceContext,
	clearServiceContext,
	getServiceContext,
	withServiceContext,
	ServiceLeaseRequiredError,
	ServiceOwnershipMismatchError,
	UnauthorizedWriteError,
	type QueryFn,
} from "../../src/core/governance/service-topology.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SqlCall = { text: string; params?: unknown[] };

function makeQueryFn(rows: unknown[] = [], rowCount = 0): {
	fn: QueryFn;
	calls: SqlCall[];
} {
	const calls: SqlCall[] = [];
	const fn: QueryFn = async (text, params) => {
		calls.push({ text, params });
		return { rows, rowCount };
	};
	return { fn, calls };
}

function makeLeaseRow(overrides: Record<string, unknown> = {}) {
	return {
		lease_id: "aaaa-1111",
		service_id: "orchestrator",
		responsibility: "state_machine_transition",
		acquired_at: "2026-05-05T00:00:00Z",
		expires_at: "2026-05-05T00:05:00Z",
		released_at: null,
		release_reason: null,
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("P441 Service Topology — single primary invariant", () => {
	it("OWNERSHIP_MATRIX contains all 9 documented responsibilities", () => {
		const expected = [
			"state_machine_transition",
			"maturity_sync",
			"workflow_spawn",
			"service_lease_management",
			"gate_evaluation",
			"work_offer_claim",
			"subprocess_spawn",
			"proposal_crud",
			"feed_event_publication",
		];
		for (const r of expected) {
			assert.ok(r in OWNERSHIP_MATRIX, `missing responsibility: ${r}`);
		}
		assert.equal(Object.keys(OWNERSHIP_MATRIX).length, 9);
	});

	it("every responsibility has a non-empty string primaryWriter", () => {
		for (const [resp, entry] of Object.entries(OWNERSHIP_MATRIX)) {
			assert.equal(
				typeof entry.primaryWriter,
				"string",
				`${resp}.primaryWriter must be a string`,
			);
			assert.ok(
				entry.primaryWriter.length > 0,
				`${resp}.primaryWriter must not be empty`,
			);
		}
	});

	it("every responsibility has passiveObservers as an array", () => {
		for (const [resp, entry] of Object.entries(OWNERSHIP_MATRIX)) {
			assert.ok(
				Array.isArray(entry.passiveObservers),
				`${resp}.passiveObservers must be an array`,
			);
		}
	});

	it("getPrimaryOwner returns a string (not an array) for each responsibility", () => {
		for (const resp of Object.keys(OWNERSHIP_MATRIX)) {
			const owner = getPrimaryOwner(resp);
			assert.equal(typeof owner, "string", `getPrimaryOwner(${resp}) must be string`);
		}
	});

	it("getPrimaryOwner returns null for unknown responsibility", () => {
		assert.equal(getPrimaryOwner("nonexistent_responsibility"), null);
	});

	it("OWNERSHIP_MATRIX has no duplicate responsibility keys", () => {
		const keys = Object.keys(OWNERSHIP_MATRIX);
		const uniqueKeys = new Set(keys);
		assert.equal(keys.length, uniqueKeys.size, "no duplicate responsibility keys");
	});
});

describe("P441 Service Topology — ownership authorization", () => {
	it("orchestrator is authorized for state_machine_transition", () => {
		assert.ok(isWriteAuthorized("orchestrator", "state_machine_transition"));
	});

	it("mcp-server is NOT authorized for state_machine_transition (passive observer)", () => {
		assert.equal(isWriteAuthorized("mcp-server", "state_machine_transition"), false);
	});

	it("state-feed-listener is NOT authorized for state_machine_transition (passive observer)", () => {
		assert.equal(
			isWriteAuthorized("state-feed-listener", "state_machine_transition"),
			false,
		);
	});

	it("offer-provider is authorized for work_offer_claim", () => {
		assert.ok(isWriteAuthorized("offer-provider", "work_offer_claim"));
	});

	it("orchestrator is NOT authorized for work_offer_claim", () => {
		assert.equal(isWriteAuthorized("orchestrator", "work_offer_claim"), false);
	});

	it("mcp-server is NOT authorized for work_offer_claim (passive observer)", () => {
		assert.equal(isWriteAuthorized("mcp-server", "work_offer_claim"), false);
	});

	it("mcp-server is authorized for proposal_crud", () => {
		assert.ok(isWriteAuthorized("mcp-server", "proposal_crud"));
	});

	it("unknown service is not authorized for any responsibility", () => {
		for (const resp of Object.keys(OWNERSHIP_MATRIX)) {
			assert.equal(
				isWriteAuthorized("rogue-service", resp),
				false,
				`rogue-service must not be authorized for ${resp}`,
			);
		}
	});
});

describe("P441 Service Topology — passive consumers", () => {
	it("getPassiveConsumers returns mcp-server and state-feed-listener for state_machine_transition", () => {
		const observers = getPassiveConsumers("state_machine_transition");
		assert.ok(observers.includes("mcp-server"));
		assert.ok(observers.includes("state-feed-listener"));
		assert.equal(observers.length, 2);
	});

	it("getPassiveConsumers returns empty array for maturity_sync", () => {
		assert.deepEqual(getPassiveConsumers("maturity_sync"), []);
	});

	it("getPassiveConsumers returns mcp-server for work_offer_claim", () => {
		const observers = getPassiveConsumers("work_offer_claim");
		assert.ok(observers.includes("mcp-server"));
		assert.equal(observers.length, 1);
	});

	it("getPassiveConsumers returns empty array for unknown responsibility", () => {
		assert.deepEqual(getPassiveConsumers("nonexistent"), []);
	});
});

describe("P441 Service Topology — lease lifecycle", () => {
	it("acquireLease issues INSERT with correct params", async () => {
		const { fn, calls } = makeQueryFn([makeLeaseRow()]);
		await acquireLease(fn, "orchestrator", "state_machine_transition", 300);
		assert.equal(calls.length, 1);
		assert.ok(
			calls[0].text.includes("INSERT INTO control_runtime.service_lease"),
			"must INSERT into service_lease",
		);
		assert.deepEqual(calls[0].params, [
			"orchestrator",
			"state_machine_transition",
			"300",
		]);
	});

	it("acquireLease returns a ServiceLease with correct shape", async () => {
		const { fn } = makeQueryFn([makeLeaseRow()]);
		const lease = await acquireLease(fn, "orchestrator", "state_machine_transition");
		assert.equal(typeof lease.leaseId, "string");
		assert.equal(lease.serviceId, "orchestrator");
		assert.equal(lease.responsibility, "state_machine_transition");
		assert.equal(typeof lease.acquiredAt, "string");
		assert.equal(typeof lease.expiresAt, "string");
		assert.equal(lease.releasedAt, null);
		assert.equal(lease.releaseReason, null);
	});

	it("acquireLease throws ServiceOwnershipMismatchError for non-primary service", async () => {
		const { fn } = makeQueryFn([]);
		await assert.rejects(
			() => acquireLease(fn, "mcp-server", "state_machine_transition"),
			(err: Error) => err.name === "ServiceOwnershipMismatchError",
		);
	});

	it("releaseLease issues UPDATE with lease_id and reason", async () => {
		const { fn, calls } = makeQueryFn();
		await releaseLease(fn, "aaaa-1111", "test_release");
		assert.equal(calls.length, 1);
		assert.ok(calls[0].text.includes("UPDATE control_runtime.service_lease"));
		assert.ok(calls[0].text.includes("released_at = now()"));
		assert.deepEqual(calls[0].params, ["aaaa-1111", "test_release"]);
	});

	it("releaseLease defaults to 'explicit_release' reason", async () => {
		const { fn, calls } = makeQueryFn();
		await releaseLease(fn, "aaaa-1111");
		assert.equal(calls[0].params?.[1], "explicit_release");
	});

	it("releaseAllLeases issues UPDATE for all leases of a service", async () => {
		const { fn, calls } = makeQueryFn();
		await releaseAllLeases(fn, "orchestrator", "service_shutdown");
		assert.equal(calls.length, 1);
		assert.ok(calls[0].text.includes("WHERE service_id = $1"));
		assert.deepEqual(calls[0].params, ["orchestrator", "service_shutdown"]);
	});

	it("renewLease issues UPDATE with new TTL", async () => {
		const { fn, calls } = makeQueryFn();
		await renewLease(fn, "aaaa-1111", 600);
		assert.equal(calls.length, 1);
		assert.ok(calls[0].text.includes("SET expires_at = now()"));
		assert.deepEqual(calls[0].params, ["aaaa-1111", "600"]);
	});

	it("heartbeat issues UPDATE on service_registry", async () => {
		const { fn, calls } = makeQueryFn();
		await heartbeat(fn, "orchestrator");
		assert.equal(calls.length, 1);
		assert.ok(calls[0].text.includes("UPDATE control_runtime.service_registry"));
		assert.ok(calls[0].text.includes("last_heartbeat = now()"));
		assert.deepEqual(calls[0].params, ["orchestrator"]);
	});

	it("listActiveLeases returns mapped ServiceLease objects", async () => {
		const rows = [
			makeLeaseRow({ lease_id: "aaa-1", responsibility: "state_machine_transition" }),
			makeLeaseRow({ lease_id: "aaa-2", responsibility: "maturity_sync" }),
		];
		const { fn } = makeQueryFn(rows);
		const leases = await listActiveLeases(fn);
		assert.equal(leases.length, 2);
		assert.equal(leases[0].leaseId, "aaa-1");
		assert.equal(leases[1].leaseId, "aaa-2");
	});

	it("listActiveLeases returns empty array when queryFn returns no rows", async () => {
		const { fn } = makeQueryFn([]);
		const leases = await listActiveLeases(fn);
		assert.deepEqual(leases, []);
	});
});

describe("P441 Service Topology — error codes", () => {
	it("ServiceLeaseRequiredError has errcode 'insufficient_privilege'", () => {
		const err = new ServiceLeaseRequiredError("orchestrator", "maturity_sync");
		assert.equal(err.errcode, "insufficient_privilege");
		assert.equal(err.name, "ServiceLeaseRequiredError");
		assert.ok(err.message.includes("orchestrator"));
	});

	it("ServiceOwnershipMismatchError has errcode 'insufficient_privilege'", () => {
		const err = new ServiceOwnershipMismatchError(
			"mcp-server",
			"maturity_sync",
			"orchestrator",
		);
		assert.equal(err.errcode, "insufficient_privilege");
		assert.equal(err.name, "ServiceOwnershipMismatchError");
		assert.ok(err.message.includes("mcp-server"));
		assert.ok(err.message.includes("orchestrator"));
	});

	it("UnauthorizedWriteError has errcode 'insufficient_privilege'", () => {
		const err = new UnauthorizedWriteError(
			"rogue",
			"roadmap.proposal",
			"state_machine_transition",
		);
		assert.equal(err.errcode, "insufficient_privilege");
		assert.equal(err.name, "UnauthorizedWriteError");
		assert.ok(err.message.includes("rogue"));
	});

	it("acquireLease error message names the primary owner", async () => {
		const { fn } = makeQueryFn([]);
		await assert.rejects(
			() => acquireLease(fn, "mcp-server", "state_machine_transition"),
			(err: Error) => {
				assert.ok(err.message.includes("orchestrator"), "must name primary owner");
				return true;
			},
		);
	});

	it("all three error classes extend Error", () => {
		assert.ok(
			new ServiceLeaseRequiredError("s", "r") instanceof Error,
		);
		assert.ok(
			new ServiceOwnershipMismatchError("s", "r", "p") instanceof Error,
		);
		assert.ok(
			new UnauthorizedWriteError("s", "t", "r") instanceof Error,
		);
	});

	it("describeOwnership returns a markdown table string", () => {
		const output = describeOwnership();
		assert.ok(output.includes("# Service Ownership Matrix"));
		assert.ok(output.includes("| state_machine_transition |"));
		assert.ok(output.includes("orchestrator"));
	});
});

describe("P441 Service Topology — session context management", () => {
	beforeEach(() => {
		clearServiceContext();
	});

	it("setServiceContext stores serviceId and responsibility", () => {
		setServiceContext("orchestrator", "maturity_sync");
		const ctx = getServiceContext();
		assert.equal(ctx?.serviceId, "orchestrator");
		assert.equal(ctx?.responsibility, "maturity_sync");
	});

	it("clearServiceContext nullifies the context", () => {
		setServiceContext("orchestrator", "maturity_sync");
		clearServiceContext();
		assert.equal(getServiceContext(), null);
	});

	it("withServiceContext sets context and restores to null after success", async () => {
		let innerCtx: ReturnType<typeof getServiceContext> = null;
		await withServiceContext("orchestrator", "workflow_spawn", async () => {
			innerCtx = getServiceContext();
		});
		assert.equal(innerCtx?.serviceId, "orchestrator");
		assert.equal(innerCtx?.responsibility, "workflow_spawn");
		assert.equal(getServiceContext(), null);
	});

	it("withServiceContext restores previous context when fn throws", async () => {
		setServiceContext("prior-service", "prior_responsibility");
		await assert.rejects(
			() =>
				withServiceContext("orchestrator", "maturity_sync", async () => {
					throw new Error("deliberate failure");
				}),
		);
		const ctx = getServiceContext();
		assert.equal(ctx?.serviceId, "prior-service");
		assert.equal(ctx?.responsibility, "prior_responsibility");
	});

	it("nested withServiceContext calls restore outer context", async () => {
		await withServiceContext("outer-svc", "gate_evaluation", async () => {
			await withServiceContext("inner-svc", "proposal_crud", async () => {
				assert.equal(getServiceContext()?.serviceId, "inner-svc");
			});
			assert.equal(getServiceContext()?.serviceId, "outer-svc");
		});
		assert.equal(getServiceContext(), null);
	});
});
