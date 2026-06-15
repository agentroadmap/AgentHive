/**
 * P3313 AC-2: closed feedback-loop hook unit tests.
 *
 * Pure-mocked (no DB, no spawn). Verifies:
 *   1. classifyOutcome maps run status + flags to the right reliability outcome.
 *   2. recordReliabilityOutcome issues fn_record_run_outcome once per resolvable
 *      scope (model + agency), with the classified outcome and resolved task_class.
 *   3. A failed run records 'hard_failure' (the signal that lowers score on the
 *      next read — the closed loop). The score-drop itself is enforced by the DB
 *      function and proven by scripts/migrations test (268) / the SQL integration
 *      script; here we assert the hook drives that function correctly.
 *   4. cancelled / rate_limited runs are NOT recorded (not a model reliability fault).
 */

import { describe, expect, it } from "vitest";
import {
	classifyOutcome,
	recordReliabilityOutcome,
} from "../record-reliability-outcome.ts";

/** Capture every exec call (sql + params). Returns task_class for the resolve query. */
function makeExec(taskClass: string | null) {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const exec = async (sql: string, params: unknown[] = []) => {
		calls.push({ sql, params });
		if (sql.includes("FROM roadmap_workforce.squad_dispatch")) {
			return { rows: taskClass === null ? [] : [{ task_class: taskClass }] };
		}
		// fn_record_run_outcome returns the new score row
		return { rows: [{ score: 0.31, alpha: 5, beta_param: 11 }] };
	};
	return { exec, calls };
}

const outcomeCalls = (calls: Array<{ sql: string; params: unknown[] }>) =>
	calls.filter((c) => c.sql.includes("fn_record_run_outcome"));

describe("P3313 classifyOutcome", () => {
	it("maps failed/timeout to hard_failure", () => {
		expect(classifyOutcome("failed")).toBe("hard_failure");
		expect(classifyOutcome("timeout")).toBe("hard_failure");
	});

	it("ignores cancelled and rate_limited (not a reliability fault)", () => {
		expect(classifyOutcome("cancelled")).toBeNull();
		expect(classifyOutcome("rate_limited")).toBeNull();
	});

	it("maps clean completed to success", () => {
		expect(classifyOutcome("completed")).toBe("success");
	});

	it("maps degenerate completed to rework", () => {
		expect(classifyOutcome("completed", { degenerate: true })).toBe("rework");
	});

	it("maps provider-mismatch completed to mismatch", () => {
		expect(classifyOutcome("completed", { providerMismatch: true })).toBe(
			"mismatch",
		);
	});

	it("prefers rework over mismatch when both flagged", () => {
		expect(
			classifyOutcome("completed", { degenerate: true, providerMismatch: true }),
		).toBe("rework");
	});
});

describe("P3313 recordReliabilityOutcome (closed loop)", () => {
	it("records hard_failure for a failed run across model+agency scopes", async () => {
		const { exec, calls } = makeExec("develop");
		const res = await recordReliabilityOutcome({
			agentRunId: 1,
			proposalId: 42,
			agencyIdentity: "claude-bot-gary",
			modelUsed: "claude-opus-4-8",
			routeId: null,
			status: "failed",
			exec,
		});

		expect(res.success).toBe(true);
		expect(res.outcome).toBe("hard_failure");
		expect(res.taskClass).toBe("develop");
		expect(res.scopesUpdated).toBe(2); // model + agency

		const recs = outcomeCalls(calls);
		expect(recs).toHaveLength(2);
		// model scope
		expect(recs[0].params).toEqual([
			"model",
			"claude-opus-4-8",
			"develop",
			"hard_failure",
			1.0,
		]);
		// agency scope
		expect(recs[1].params).toEqual([
			"agency",
			"claude-bot-gary",
			"develop",
			"hard_failure",
			1.0,
		]);
	});

	it("includes route scope when routeId is provided", async () => {
		const { exec, calls } = makeExec("merge");
		const res = await recordReliabilityOutcome({
			agentRunId: 2,
			proposalId: 7,
			agencyIdentity: "codex.a",
			modelUsed: "gpt-5",
			routeId: 338,
			status: "completed",
			exec,
		});
		expect(res.outcome).toBe("success");
		expect(res.scopesUpdated).toBe(3);
		const recs = outcomeCalls(calls);
		expect(recs.map((r) => r.params[0])).toEqual(["model", "agency", "route"]);
		expect(recs[2].params).toEqual(["route", "338", "merge", "success", 1.0]);
	});

	it("does NOT record for cancelled/rate_limited runs", async () => {
		const { exec, calls } = makeExec("develop");
		const res = await recordReliabilityOutcome({
			agentRunId: 3,
			proposalId: 9,
			agencyIdentity: "x.a",
			modelUsed: "m",
			routeId: 1,
			status: "rate_limited",
			exec,
		});
		expect(res.outcome).toBeNull();
		expect(res.scopesUpdated).toBe(0);
		expect(outcomeCalls(calls)).toHaveLength(0);
	});

	it("falls back to _global task_class when squad_dispatch has none", async () => {
		const { exec } = makeExec(null);
		const res = await recordReliabilityOutcome({
			agentRunId: 4,
			proposalId: 99,
			agencyIdentity: "a.a",
			modelUsed: "m",
			routeId: null,
			status: "failed",
			exec,
		});
		expect(res.taskClass).toBe("_global");
		expect(res.outcome).toBe("hard_failure");
	});

	it("uses explicit taskClass override without a DB lookup", async () => {
		const { exec, calls } = makeExec("WRONG");
		const res = await recordReliabilityOutcome({
			agentRunId: 5,
			proposalId: 1,
			agencyIdentity: "a.a",
			modelUsed: "m",
			routeId: null,
			status: "completed",
			taskClass: "architecture",
			exec,
		});
		expect(res.taskClass).toBe("architecture");
		// no squad_dispatch resolve call when override given
		expect(
			calls.some((c) => c.sql.includes("FROM roadmap_workforce.squad_dispatch")),
		).toBe(false);
	});

	it("degenerate completed run is recorded as rework (closed loop on bad output)", async () => {
		const { exec, calls } = makeExec("review");
		const res = await recordReliabilityOutcome({
			agentRunId: 6,
			proposalId: 3,
			agencyIdentity: "a.a",
			modelUsed: "m",
			routeId: null,
			status: "completed",
			degenerate: true,
			exec,
		});
		expect(res.outcome).toBe("rework");
		expect(outcomeCalls(calls)[0].params[3]).toBe("rework");
	});
});
