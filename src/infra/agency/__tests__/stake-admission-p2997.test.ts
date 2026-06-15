/**
 * P2997 Stake/capability-bond layer — unit tests.
 *
 * Covers AC-6 (schema-shaped behavior), AC-7 (chokepoint functions), and AC-8
 * (admission gating: active→admitted, slashed→rejected; transient failures do
 * not slash; legacy/unsigned agents are admitted via the missing-row path).
 *
 * Run:
 *   npx vitest run src/infra/agency/__tests__/stake-admission-p2997.test.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
	evaluateStakeAdmission,
	slashStake,
	returnStake,
	isSlashable,
	SLASHABLE_FAILURE_CLASSES,
	DEFAULT_SLASH_MICROCENTS,
	MICROCENTS_PER_CENT,
	type SqlExec,
} from "../stake-admission.ts";

/**
 * Build a mock SqlExec backed by a single mutable agent_registry row. The mock
 * understands the three statement shapes the module emits (SELECT, UPDATE for
 * slash, UPDATE for return) plus the ledger INSERT, applying the same
 * clamp-at-zero + status-flip arithmetic the SQL does so assertions are real.
 */
function makeRegistryMock(initial: {
	stake_microcents: number;
	stake_status: string;
	is_legacy?: boolean;
	missing?: boolean;
}) {
	const state = {
		stake_microcents: initial.stake_microcents,
		stake_status: initial.stake_status,
		is_legacy: initial.is_legacy ?? false,
		missing: initial.missing ?? false,
	};
	const ledger: Array<Record<string, unknown>> = [];

	const exec: SqlExec = vi.fn(async (sql: string, params?: unknown[]) => {
		if (sql.includes("INSERT INTO roadmap_workforce.stake_ledger")) {
			ledger.push({
				agent_identity: params?.[0],
				event_type: params?.[1],
				delta_microcents: params?.[2],
				balance_after: params?.[3],
				failure_class: params?.[4],
			});
			return { rows: [] };
		}
		if (sql.startsWith("SELECT") && sql.includes("agent_registry")) {
			if (state.missing) return { rows: [] };
			return {
				rows: [
					{
						stake_microcents: state.stake_microcents,
						stake_status: state.stake_status,
						is_legacy: state.is_legacy,
					},
				],
			};
		}
		// slash UPDATE
		if (sql.includes("stake_microcents = GREATEST(0, stake_microcents")) {
			const amount = Number(params?.[1]);
			if (state.stake_status !== "active") return { rows: [] };
			state.stake_microcents = Math.max(0, state.stake_microcents - amount);
			if (state.stake_microcents === 0) state.stake_status = "slashed";
			return {
				rows: [
					{
						stake_microcents: state.stake_microcents,
						stake_status: state.stake_status,
					},
				],
			};
		}
		// return UPDATE
		if (sql.includes("SET stake_status = 'returned'")) {
			if (state.stake_status !== "active") return { rows: [] };
			state.stake_status = "returned";
			return {
				rows: [
					{
						stake_microcents: state.stake_microcents,
						stake_status: state.stake_status,
					},
				],
			};
		}
		return { rows: [] };
	});

	return { exec, state, ledger };
}

describe("P2997 evaluateStakeAdmission (AC-8 pre-claim gate)", () => {
	it("admits an agent with stake_status=active", async () => {
		const { exec } = makeRegistryMock({
			stake_microcents: 5 * MICROCENTS_PER_CENT,
			stake_status: "active",
		});
		const r = await evaluateStakeAdmission("agency/a", exec);
		expect(r.allowed).toBe(true);
		expect(r.reason).toBeNull();
		expect(r.stakeStatus).toBe("active");
	});

	it("rejects an agent whose stake was slashed", async () => {
		const { exec } = makeRegistryMock({
			stake_microcents: 0,
			stake_status: "slashed",
		});
		const r = await evaluateStakeAdmission("agency/bad", exec);
		expect(r.allowed).toBe(false);
		expect(r.reason).toBe("stake_slashed");
	});

	it("rejects an agent whose stake was returned (must re-bond)", async () => {
		const { exec } = makeRegistryMock({
			stake_microcents: 3 * MICROCENTS_PER_CENT,
			stake_status: "returned",
		});
		const r = await evaluateStakeAdmission("agency/done", exec);
		expect(r.allowed).toBe(false);
		expect(r.reason).toBe("stake_returned");
	});

	it("admits a legacy/unsigned agent with no registry row (backward compat)", async () => {
		const { exec } = makeRegistryMock({
			stake_microcents: 0,
			stake_status: "active",
			missing: true,
		});
		const r = await evaluateStakeAdmission("agency/legacy", exec);
		expect(r.allowed).toBe(true);
		expect(r.isLegacy).toBe(true);
	});
});

describe("P2997 slashStake (AC-7 post-work failure handler)", () => {
	it("slashes a genuine (unknown) failure and records a ledger row", async () => {
		const { exec, state, ledger } = makeRegistryMock({
			stake_microcents: 3 * MICROCENTS_PER_CENT,
			stake_status: "active",
		});
		const r = await slashStake(
			{ agentIdentity: "agency/x", failureClass: "unknown", dispatchId: 42 },
			exec,
		);
		expect(r.applied).toBe(true);
		expect(r.balanceAfter).toBe(3 * MICROCENTS_PER_CENT - DEFAULT_SLASH_MICROCENTS);
		expect(state.stake_status).toBe("active"); // still has bond left
		expect(ledger).toHaveLength(1);
		expect(ledger[0].event_type).toBe("slash");
		expect(ledger[0].failure_class).toBe("unknown");
		expect(ledger[0].delta_microcents).toBe(-DEFAULT_SLASH_MICROCENTS);
	});

	it("flips status to slashed when the bond reaches zero", async () => {
		const { exec, state } = makeRegistryMock({
			stake_microcents: DEFAULT_SLASH_MICROCENTS, // exactly one slash worth
			stake_status: "active",
		});
		const r = await slashStake(
			{ agentIdentity: "agency/y", failureClass: "unknown" },
			exec,
		);
		expect(r.applied).toBe(true);
		expect(r.balanceAfter).toBe(0);
		expect(state.stake_status).toBe("slashed");
	});

	it("does NOT slash a transient failure (auth_rejected)", async () => {
		const { exec, state, ledger } = makeRegistryMock({
			stake_microcents: 3 * MICROCENTS_PER_CENT,
			stake_status: "active",
		});
		const r = await slashStake(
			{ agentIdentity: "agency/z", failureClass: "auth_rejected" },
			exec,
		);
		expect(r.applied).toBe(false);
		expect(state.stake_microcents).toBe(3 * MICROCENTS_PER_CENT);
		expect(ledger).toHaveLength(0);
	});

	it("does not slash an already-slashed agent (no active row to update)", async () => {
		const { exec } = makeRegistryMock({
			stake_microcents: 0,
			stake_status: "slashed",
		});
		const r = await slashStake(
			{ agentIdentity: "agency/dead", failureClass: "unknown" },
			exec,
		);
		expect(r.applied).toBe(false);
	});

	it("clamps at zero and never goes negative", async () => {
		const { exec, state } = makeRegistryMock({
			stake_microcents: 500, // less than a full slash
			stake_status: "active",
		});
		await slashStake(
			{ agentIdentity: "agency/small", failureClass: "unknown" },
			exec,
		);
		expect(state.stake_microcents).toBe(0);
		expect(state.stake_status).toBe("slashed");
	});
});

describe("P2997 returnStake (AC-7 quota-refund / post-completion)", () => {
	it("returns the bond on clean completion and records a ledger row", async () => {
		const { exec, state, ledger } = makeRegistryMock({
			stake_microcents: 4 * MICROCENTS_PER_CENT,
			stake_status: "active",
		});
		const r = await returnStake(
			{ agentIdentity: "agency/good", dispatchId: 7 },
			exec,
		);
		expect(r.applied).toBe(true);
		expect(state.stake_status).toBe("returned");
		expect(r.balanceAfter).toBe(4 * MICROCENTS_PER_CENT); // balance preserved
		expect(ledger).toHaveLength(1);
		expect(ledger[0].event_type).toBe("return");
	});

	it("is a no-op when the bond is already returned", async () => {
		const { exec } = makeRegistryMock({
			stake_microcents: 4 * MICROCENTS_PER_CENT,
			stake_status: "returned",
		});
		const r = await returnStake({ agentIdentity: "agency/twice" }, exec);
		expect(r.applied).toBe(false);
	});
});

describe("P2997 isSlashable (failure_class taxonomy from migration 184)", () => {
	it("only the unknown class is slashable", () => {
		expect(SLASHABLE_FAILURE_CLASSES.has("unknown")).toBe(true);
		expect(isSlashable("unknown")).toBe(true);
	});

	it("transient classes are NOT slashable", () => {
		for (const cls of [
			"auth_rejected",
			"rate_limited",
			"quota_exhausted",
			"no_eligible_agency",
			"lease_expired",
		]) {
			expect(isSlashable(cls)).toBe(false);
		}
	});

	it("a null/unclassified failure is treated as slashable (genuine)", () => {
		expect(isSlashable(null)).toBe(true);
		expect(isSlashable(undefined)).toBe(true);
	});
});
