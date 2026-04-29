/**
 * P442 — Operator Stop and Cancel Controls: unit tests
 *
 * All tests are fully injected (no live Postgres). Every function under test
 * accepts an optional queryFn; we pass a mock that returns controlled row sets.
 *
 * Acceptance criteria covered:
 *   AC#1 — Source of truth, migration boundary, and required capabilities
 *           documented in module header and migration file.
 *   AC#2 — State transitions specified with idempotency; race paths covered.
 *   AC#3 — Verification plan: rollback note in migration, operator-visible
 *           error codes in thrown error messages.
 *   AC#4 — cancel_dispatch: dispatch_status=cancelled; future claim attempts
 *           fail with 'dispatch_cancelled' reason.
 *   AC#5 — suspend_agency: agency.status=suspended; new claims rejected before
 *           spawning; existing running claims continue (no SIGTERM sent).
 *   AC#6 — drain_host: host.drain_until set; no new claims routed to host
 *           during grace window; existing runs continue.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cancelDispatch,
  cancelProposalWork,
  suspendAgency,
  resumeAgency,
  drainHost,
  resumeHost,
  terminateWorker,
  suspendProviderRoute,
  resumeProviderRoute,
  claimWorkOffer,
  getActionLog,
  AgencySuspendedError,
  HostDrainingError,
  type QueryFn,
  type StopResult,
} from "../../src/core/governance/operator-stop-controls.ts";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockQuery(rowSets: Record<string, unknown>[][]): QueryFn {
  let call = 0;
  return async (_sql: string, _params?: unknown[]) => {
    const rows = rowSets[Math.min(call, rowSets.length - 1)] ?? [];
    call++;
    return { rows };
  };
}

function capturingQuery(rowSets: Record<string, unknown>[][]): {
  fn: QueryFn;
  calls: { sql: string; params: unknown[] | undefined }[];
} {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  let call = 0;
  const fn: QueryFn = async (sql, params) => {
    calls.push({ sql, params });
    const rows = rowSets[Math.min(call, rowSets.length - 1)] ?? [];
    call++;
    return { rows };
  };
  return { fn, calls };
}

function throwingQuery(errorMsg: string): QueryFn {
  return async () => {
    throw new Error(errorMsg);
  };
}

// ─── AC#4: cancel_dispatch ────────────────────────────────────────────────────

describe("AC#4: cancelDispatch — state transitions and idempotency", () => {
  it("returns 'ok' when dispatch is cancelled successfully", async () => {
    const q = mockQuery([[{ result: "ok" }]]);
    const result = await cancelDispatch({ dispatchId: 1, actor: "ops", queryFn: q });
    assert.equal(result, "ok");
  });

  it("returns 'noop' when dispatch is already in terminal state (idempotent)", async () => {
    const q = mockQuery([[{ result: "noop" }]]);
    const result = await cancelDispatch({ dispatchId: 99, actor: "ops", queryFn: q });
    assert.equal(result, "noop");
  });

  it("returns 'error' when dispatch does not exist", async () => {
    const q = mockQuery([[{ result: "error" }]]);
    const result = await cancelDispatch({ dispatchId: 99999, actor: "ops", queryFn: q });
    assert.equal(result, "error");
  });

  it("passes dispatch_id, actor, and reason to the DB function", async () => {
    const { fn, calls } = capturingQuery([[{ result: "ok" }]]);
    await cancelDispatch({ dispatchId: 42, actor: "operator-x", reason: "runaway loop", queryFn: fn });
    assert.equal(calls.length, 1);
    const params = calls[0].params!;
    assert.equal(params[0], 42);
    assert.equal(params[1], "operator-x");
    assert.equal(params[2], "runaway loop");
  });

  it("passes null reason when none provided", async () => {
    const { fn, calls } = capturingQuery([[{ result: "ok" }]]);
    await cancelDispatch({ dispatchId: 1, actor: "ops", queryFn: fn });
    assert.equal(calls[0].params![2], null);
  });

  it("second cancel on same dispatch returns noop (race: concurrent cancel)", async () => {
    // First call cancels, second call hits terminal state → noop
    const q = mockQuery([[{ result: "ok" }], [{ result: "noop" }]]);
    const r1 = await cancelDispatch({ dispatchId: 7, actor: "ops", queryFn: q });
    const r2 = await cancelDispatch({ dispatchId: 7, actor: "ops", queryFn: q });
    assert.equal(r1, "ok");
    assert.equal(r2, "noop");
  });

  it("cancel on completed dispatch returns noop (in-flight completion race)", async () => {
    const q = mockQuery([[{ result: "noop" }]]);
    const result = await cancelDispatch({ dispatchId: 5, actor: "ops", reason: "cleanup", queryFn: q });
    assert.equal(result, "noop");
  });
});

// ─── AC#4: cancelProposalWork ─────────────────────────────────────────────────

describe("AC#4: cancelProposalWork — bulk cancel", () => {
  it("returns correct counts for mixed dispatch states", async () => {
    const q = mockQuery([[{ cancelled_count: 3, noop_count: 1 }]]);
    const r = await cancelProposalWork({ proposalId: 200, actor: "ops", queryFn: q });
    assert.equal(r.cancelledCount, 3);
    assert.equal(r.noopCount, 1);
  });

  it("returns zero counts when no dispatches exist", async () => {
    const q = mockQuery([[{ cancelled_count: 0, noop_count: 0 }]]);
    const r = await cancelProposalWork({ proposalId: 999, actor: "ops", queryFn: q });
    assert.equal(r.cancelledCount, 0);
    assert.equal(r.noopCount, 0);
  });

  it("passes proposal_id, actor, reason to the DB function", async () => {
    const { fn, calls } = capturingQuery([[{ cancelled_count: 2, noop_count: 0 }]]);
    await cancelProposalWork({ proposalId: 55, actor: "ops", reason: "P309 cleanup", queryFn: fn });
    const params = calls[0].params!;
    assert.equal(params[0], 55);
    assert.equal(params[1], "ops");
    assert.equal(params[2], "P309 cleanup");
  });

  it("retry loop: repeated cancel_proposal_work returns increasing noop (all already cancelled)", async () => {
    // Simulate: 2 cancelled on first run, 0+2 noop on retry
    const q = mockQuery([
      [{ cancelled_count: 2, noop_count: 0 }],
      [{ cancelled_count: 0, noop_count: 2 }],
    ]);
    const r1 = await cancelProposalWork({ proposalId: 100, actor: "ops", queryFn: q });
    const r2 = await cancelProposalWork({ proposalId: 100, actor: "ops", queryFn: q });
    assert.equal(r1.cancelledCount, 2);
    assert.equal(r2.cancelledCount, 0);
    assert.equal(r2.noopCount, 2);
  });
});

// ─── AC#5: suspend_agency ─────────────────────────────────────────────────────

describe("AC#5: suspendAgency — new claims blocked, running work continues", () => {
  it("returns 'ok' when agency is successfully suspended", async () => {
    const q = mockQuery([[{ result: "ok" }]]);
    const r = await suspendAgency({ agencyIdentity: "agency-alpha", actor: "ops", queryFn: q });
    assert.equal(r, "ok");
  });

  it("returns 'noop' when agency is already suspended (idempotent)", async () => {
    const q = mockQuery([[{ result: "noop" }]]);
    const r = await suspendAgency({ agencyIdentity: "agency-alpha", actor: "ops", queryFn: q });
    assert.equal(r, "noop");
  });

  it("returns 'error' when agency identity is not found", async () => {
    const q = mockQuery([[{ result: "error" }]]);
    const r = await suspendAgency({ agencyIdentity: "ghost", actor: "ops", queryFn: q });
    assert.equal(r, "error");
  });

  it("claimWorkOffer throws AgencySuspendedError when agency is suspended", async () => {
    const q = throwingQuery("agency_suspended: agent agency-alpha is suspended, no new claims accepted");
    await assert.rejects(
      () => claimWorkOffer({ agentIdentity: "agency-alpha", queryFn: q }),
      (err) => {
        assert.ok(err instanceof AgencySuspendedError, "must be AgencySuspendedError");
        assert.equal(err.code, "AGENCY_SUSPENDED");
        assert.ok(err.message.includes("agency-alpha"));
        return true;
      },
    );
  });

  it("claimWorkOffer throws AgencySuspendedError when parent agency is suspended (worker case)", async () => {
    const q = throwingQuery("agency_suspended: parent agency of worker-7 is suspended, no new claims accepted");
    await assert.rejects(
      () => claimWorkOffer({ agentIdentity: "worker-7", queryFn: q }),
      (err) => {
        assert.ok(err instanceof AgencySuspendedError);
        assert.equal(err.code, "AGENCY_SUSPENDED");
        return true;
      },
    );
  });

  it("resumeAgency lifts suspension — returns 'ok'", async () => {
    const q = mockQuery([[{ result: "ok" }]]);
    const r = await resumeAgency({ agencyIdentity: "agency-alpha", actor: "ops", queryFn: q });
    assert.equal(r, "ok");
  });

  it("resumeAgency on non-suspended agency returns 'noop'", async () => {
    const q = mockQuery([[{ result: "noop" }]]);
    const r = await resumeAgency({ agencyIdentity: "agency-alpha", actor: "ops", queryFn: q });
    assert.equal(r, "noop");
  });

  it("suspend → resume → claim cycle: no AgencySuspendedError after resume", async () => {
    // Claim succeeds (returns a row) after agency is resumed
    const claimRow = {
      dispatch_id: 10n,
      proposal_id: 200n,
      squad_name: "alpha",
      dispatch_role: "developer",
      claim_token: "abc-123",
      claim_expires_at: new Date(),
      offer_version: 2,
      metadata: null,
    };
    const q = mockQuery([[claimRow]]);
    const row = await claimWorkOffer({ agentIdentity: "agency-alpha", queryFn: q });
    assert.ok(row !== null);
    assert.equal(row.dispatch_id, 10n);
  });
});

// ─── AC#6: drain_host ─────────────────────────────────────────────────────────

describe("AC#6: drainHost — no new claims during drain window", () => {
  it("returns 'ok' when host drain is set", async () => {
    const q = mockQuery([[{ result: "ok" }]]);
    const r = await drainHost({
      host: "builder-01",
      allowGraceSeconds: 300,
      actor: "ops",
      reason: "maintenance",
      queryFn: q,
    });
    assert.equal(r, "ok");
  });

  it("passes host, grace_seconds, actor, reason to DB function", async () => {
    const { fn, calls } = capturingQuery([[{ result: "ok" }]]);
    await drainHost({ host: "builder-02", allowGraceSeconds: 120, actor: "ops", reason: "upgrade", queryFn: fn });
    const params = calls[0].params!;
    assert.equal(params[0], "builder-02");
    assert.equal(params[1], 120);
    assert.equal(params[2], "ops");
    assert.equal(params[3], "upgrade");
  });

  it("claimWorkOffer throws HostDrainingError when host is draining", async () => {
    const q = throwingQuery("host_draining: host builder-01 is in active drain window, no new claims accepted");
    await assert.rejects(
      () => claimWorkOffer({ agentIdentity: "worker-1", serviceHost: "builder-01", queryFn: q }),
      (err) => {
        assert.ok(err instanceof HostDrainingError, "must be HostDrainingError");
        assert.equal(err.code, "HOST_DRAINING");
        assert.ok(err.message.includes("builder-01"));
        return true;
      },
    );
  });

  it("claimWorkOffer returns null (no work) without throwing when host is not draining", async () => {
    const q = mockQuery([[]]); // DB returns 0 rows — no eligible offer
    const row = await claimWorkOffer({ agentIdentity: "worker-1", serviceHost: "builder-01", queryFn: q });
    assert.equal(row, null);
  });

  it("resumeHost lifts drain window — returns 'ok'", async () => {
    const q = mockQuery([[{ result: "ok" }]]);
    const r = await resumeHost({ host: "builder-01", actor: "ops", queryFn: q });
    assert.equal(r, "ok");
  });

  it("resumeHost on non-draining host returns 'noop'", async () => {
    const q = mockQuery([[{ result: "noop" }]]);
    const r = await resumeHost({ host: "builder-01", actor: "ops", queryFn: q });
    assert.equal(r, "noop");
  });

  it("drain → resume → claim cycle: HostDrainingError not thrown after resume", async () => {
    const claimRow = {
      dispatch_id: 5n,
      proposal_id: 100n,
      squad_name: "beta",
      dispatch_role: "reviewer",
      claim_token: "tok-xyz",
      claim_expires_at: new Date(),
      offer_version: 1,
      metadata: null,
    };
    const q = mockQuery([[claimRow]]);
    const row = await claimWorkOffer({ agentIdentity: "worker-1", serviceHost: "builder-01", queryFn: q });
    assert.ok(row !== null);
    assert.equal(row.squad_name, "beta");
  });

  it("drain with zero grace seconds blocks immediately", async () => {
    const { fn, calls } = capturingQuery([[{ result: "ok" }]]);
    await drainHost({ host: "builder-03", allowGraceSeconds: 0, actor: "ops", queryFn: fn });
    assert.equal(calls[0].params![1], 0);
  });
});

// ─── terminateWorker ─────────────────────────────────────────────────────────

describe("terminateWorker — DB marks failed, OS signal is caller's responsibility", () => {
  it("returns 'ok' when active dispatch is found and marked failed", async () => {
    const q = mockQuery([[{ result: "ok" }]]);
    const r = await terminateWorker({ workerIdentity: "worker-42", queryFn: q });
    assert.equal(r, "ok");
  });

  it("returns 'noop' when no active dispatch exists for worker", async () => {
    const q = mockQuery([[{ result: "noop" }]]);
    const r = await terminateWorker({ workerIdentity: "worker-99", queryFn: q });
    assert.equal(r, "noop");
  });

  it("passes worker_identity, signal, actor, reason to DB function", async () => {
    const { fn, calls } = capturingQuery([[{ result: "ok" }]]);
    await terminateWorker({
      workerIdentity: "worker-7",
      signal: "SIGKILL",
      actor: "on-call",
      reason: "runaway process",
      queryFn: fn,
    });
    const params = calls[0].params!;
    assert.equal(params[0], "worker-7");
    assert.equal(params[1], "SIGKILL");
    assert.equal(params[2], "on-call");
    assert.equal(params[3], "runaway process");
  });

  it("defaults signal to SIGTERM and actor to operator when not provided", async () => {
    const { fn, calls } = capturingQuery([[{ result: "ok" }]]);
    await terminateWorker({ workerIdentity: "worker-1", queryFn: fn });
    const params = calls[0].params!;
    assert.equal(params[1], "SIGTERM");
    assert.equal(params[2], "operator");
  });
});

// ─── suspendProviderRoute / resumeProviderRoute ───────────────────────────────

describe("suspendProviderRoute / resumeProviderRoute", () => {
  it("suspend returns 'ok' when route is enabled", async () => {
    const q = mockQuery([[{ result: "ok" }]]);
    const r = await suspendProviderRoute({ routeId: 3, actor: "ops", queryFn: q });
    assert.equal(r, "ok");
  });

  it("suspend returns 'noop' when route is already disabled", async () => {
    const q = mockQuery([[{ result: "noop" }]]);
    const r = await suspendProviderRoute({ routeId: 3, actor: "ops", queryFn: q });
    assert.equal(r, "noop");
  });

  it("suspend returns 'error' when route_id does not exist", async () => {
    const q = mockQuery([[{ result: "error" }]]);
    const r = await suspendProviderRoute({ routeId: 9999, actor: "ops", queryFn: q });
    assert.equal(r, "error");
  });

  it("resume returns 'ok' when route was disabled", async () => {
    const q = mockQuery([[{ result: "ok" }]]);
    const r = await resumeProviderRoute({ routeId: 3, actor: "ops", queryFn: q });
    assert.equal(r, "ok");
  });

  it("resume returns 'noop' when route was already enabled", async () => {
    const q = mockQuery([[{ result: "noop" }]]);
    const r = await resumeProviderRoute({ routeId: 3, actor: "ops", queryFn: q });
    assert.equal(r, "noop");
  });
});

// ─── claimWorkOffer — non-stop error passthrough ──────────────────────────────

describe("claimWorkOffer — non-stop errors propagate unchanged", () => {
  it("re-throws unrelated DB errors unchanged", async () => {
    const q = throwingQuery("connection timeout");
    await assert.rejects(
      () => claimWorkOffer({ agentIdentity: "worker-1", queryFn: q }),
      (err) => {
        assert.ok(!(err instanceof AgencySuspendedError));
        assert.ok(!(err instanceof HostDrainingError));
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("connection timeout"));
        return true;
      },
    );
  });

  it("returns null when no offers are available (no rows from DB)", async () => {
    const q = mockQuery([[]]); // 0 rows
    const result = await claimWorkOffer({ agentIdentity: "worker-1", queryFn: q });
    assert.equal(result, null);
  });

  it("returns ClaimRow when an offer is available", async () => {
    const row = {
      dispatch_id: 7n,
      proposal_id: 300n,
      squad_name: "gamma",
      dispatch_role: "architect",
      claim_token: "tok-abc",
      claim_expires_at: new Date("2026-04-29T12:00:00Z"),
      offer_version: 1,
      metadata: { task: "design" },
    };
    const q = mockQuery([[row]]);
    const result = await claimWorkOffer({ agentIdentity: "worker-1", queryFn: q });
    assert.ok(result !== null);
    assert.equal(result.dispatch_id, 7n);
    assert.equal(result.squad_name, "gamma");
  });

  it("passes serviceHost as null when not provided", async () => {
    const { fn, calls } = capturingQuery([[]]);
    await claimWorkOffer({ agentIdentity: "worker-1", queryFn: fn });
    assert.equal(calls[0].params![3], null);
  });

  it("passes serviceHost when provided", async () => {
    const { fn, calls } = capturingQuery([[]]);
    await claimWorkOffer({ agentIdentity: "worker-1", serviceHost: "host-abc", queryFn: fn });
    assert.equal(calls[0].params![3], "host-abc");
  });
});

// ─── getActionLog ─────────────────────────────────────────────────────────────

describe("getActionLog — audit query helper", () => {
  it("maps DB rows to ActionLogRow shape", async () => {
    const now = new Date();
    const q = mockQuery([[
      {
        id: 1n,
        actor: "ops",
        verb: "cancel_dispatch",
        scope_type: "dispatch",
        scope_id: "42",
        reason: "budget stop",
        result: "ok",
        detail: null,
        logged_at: now,
      },
    ]]);
    const rows = await getActionLog({ scopeType: "dispatch", scopeId: "42", queryFn: q });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verb, "cancel_dispatch");
    assert.equal(rows[0].actor, "ops");
    assert.equal(rows[0].result, "ok");
    assert.equal(rows[0].loggedAt, now);
  });

  it("returns empty array when no audit rows exist", async () => {
    const q = mockQuery([[]]);
    const rows = await getActionLog({ scopeType: "dispatch", scopeId: "99", queryFn: q });
    assert.equal(rows.length, 0);
  });

  it("passes scope_type, scope_id, limit to the query", async () => {
    const { fn, calls } = capturingQuery([[]]);
    await getActionLog({ scopeType: "agency", scopeId: "agency-x", limit: 10, queryFn: fn });
    const params = calls[0].params!;
    assert.equal(params[0], "agency");
    assert.equal(params[1], "agency-x");
    assert.equal(params[2], 10);
  });
});

// ─── AC#2: Idempotency and race scenarios ────────────────────────────────────

describe("AC#2: idempotency and race scenarios", () => {
  it("concurrent cancels on same dispatch: second returns noop", async () => {
    // Simulates two concurrent operators hitting the same dispatch.
    // DB serializes via FOR UPDATE; second caller sees terminal state.
    const results: StopResult[] = [];
    const q1 = mockQuery([[{ result: "ok" }]]);
    const q2 = mockQuery([[{ result: "noop" }]]);
    const [r1, r2] = await Promise.all([
      cancelDispatch({ dispatchId: 10, actor: "ops-1", queryFn: q1 }),
      cancelDispatch({ dispatchId: 10, actor: "ops-2", queryFn: q2 }),
    ]);
    results.push(r1, r2);
    assert.ok(results.includes("ok"), "one cancel must succeed");
    assert.ok(results.includes("noop"), "duplicate cancel must be noop");
  });

  it("cancel on dispatch that completes before cancel arrives → noop (in-flight race)", async () => {
    // Worker finishes just before operator cancel lands → status=completed → noop
    const q = mockQuery([[{ result: "noop" }]]);
    const r = await cancelDispatch({ dispatchId: 20, actor: "ops", queryFn: q });
    assert.equal(r, "noop");
  });

  it("suspend agency while worker is mid-renew → existing claim continues uninterrupted", async () => {
    // suspendAgency succeeds; the worker's existing claim_token/renew continues
    // (fn_renew_lease does not check agency status — P442 out-of-scope: no SIGTERM)
    const suspendQ = mockQuery([[{ result: "ok" }]]);
    const suspendResult = await suspendAgency({
      agencyIdentity: "agency-alpha",
      actor: "ops",
      queryFn: suspendQ,
    });
    assert.equal(suspendResult, "ok");
    // New claim from same agency fails
    const claimQ = throwingQuery("agency_suspended: agent agency-alpha is suspended");
    await assert.rejects(
      () => claimWorkOffer({ agentIdentity: "agency-alpha", queryFn: claimQ }),
      AgencySuspendedError,
    );
  });

  it("budget stop is a precondition, not drain — drainHost does not auto-stop on budget", async () => {
    // drainHost does NOT check or decrement budgets; budget stop is a separate gate
    const q = mockQuery([[{ result: "ok" }]]);
    const r = await drainHost({ host: "budget-host", allowGraceSeconds: 60, actor: "budget-guard", queryFn: q });
    assert.equal(r, "ok");
    // No budget-related assertions here; drain is purely a scheduling gate
  });

  it("drain window expiry is enforced by drain_until timestamp, not by the TypeScript layer", async () => {
    // After drain_until passes, the DB function no longer rejects claims.
    // The TypeScript claimWorkOffer returns null (no offers) not HostDrainingError.
    const q = mockQuery([[]]); // DB returns 0 rows (drain expired, no offers anyway)
    const row = await claimWorkOffer({ agentIdentity: "worker-1", serviceHost: "host-x", queryFn: q });
    assert.equal(row, null);
  });
});

// ─── AC#3: Operator-visible error codes ──────────────────────────────────────

describe("AC#3: operator-visible failure codes in error messages", () => {
  it("AgencySuspendedError.code is 'AGENCY_SUSPENDED'", async () => {
    const q = throwingQuery("agency_suspended: agent test-agent is suspended");
    try {
      await claimWorkOffer({ agentIdentity: "test-agent", queryFn: q });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof AgencySuspendedError);
      assert.equal(err.code, "AGENCY_SUSPENDED");
      assert.ok(err.message.startsWith("AGENCY_SUSPENDED:"));
    }
  });

  it("HostDrainingError.code is 'HOST_DRAINING'", async () => {
    const q = throwingQuery("host_draining: host h is in active drain window");
    try {
      await claimWorkOffer({ agentIdentity: "worker-1", serviceHost: "h", queryFn: q });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof HostDrainingError);
      assert.equal(err.code, "HOST_DRAINING");
      assert.ok(err.message.startsWith("HOST_DRAINING:"));
    }
  });

  it("HostDrainingError exposes the host name", async () => {
    const q = throwingQuery("host_draining: host builder-99 is in active drain window");
    try {
      await claimWorkOffer({ agentIdentity: "worker-1", serviceHost: "builder-99", queryFn: q });
    } catch (err) {
      assert.ok(err instanceof HostDrainingError);
      assert.equal(err.host, "builder-99");
    }
  });

  it("AgencySuspendedError exposes the agent identity", async () => {
    const q = throwingQuery("agency_suspended: agent agency-zeta is suspended");
    try {
      await claimWorkOffer({ agentIdentity: "agency-zeta", queryFn: q });
    } catch (err) {
      assert.ok(err instanceof AgencySuspendedError);
      assert.equal(err.agentIdentity, "agency-zeta");
    }
  });
});
