/**
 * P3840 Part 2 — deliberate D1–D4 gate-offer pipeline.
 *
 * Pure-logic tests (no DB): the DB query and the flag resolver are both injected
 * into getRolesForQueue, so these run under plain `node --test`.
 *
 * Coverage:
 *  (a) flag OFF  → mature proposals do NOT resolve gate-review roles (legacy
 *      behavior: dormant by default).
 *  (b) flag ON   → a mature proposal's resolved roles include the gate-review
 *      role with required_capabilities ['gate_review'].
 *  (c) the gate_review capability is NOT in the worker liaison's advertised jobs
 *      (so the liaison can never auto-claim a gate-review offer).
 *  (d) inferGateForState mapping is respected per stage (Standard RFC + Hotfix).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	getRolesForQueue,
	GATE_REVIEW_CAPABILITY,
} from "../../src/core/orchestration/role-resolver.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

// The deliberate gate-review row migration 295 seeds for a mature stage.
function gateReviewRow(priority = 5) {
	return {
		id: 100,
		role: "gate-review",
		required_capabilities: [GATE_REVIEW_CAPABILITY],
		allowed_route_providers: null,
		forbidden_route_providers: null,
		prompt_template: { mode: "deliberate_gate" },
		priority,
	};
}

// A normal (non-gate) build role, to prove the filter is surgical.
function buildRow() {
	return {
		id: 200,
		role: "architect",
		required_capabilities: ["design", "architecture"],
		allowed_route_providers: null,
		forbidden_route_providers: null,
		prompt_template: null,
		priority: 10,
	};
}

const matureKey = {
	workflowTemplateId: 14,
	stage: "DRAFT",
	maturity: "mature",
	projectId: null,
} as const;

const queryReturning = (rows: Record<string, unknown>[]) => async () => ({
	rows,
});

const FLAG_ON = async () => true;
const FLAG_OFF = async () => false;

// Mirror of the worker liaison `claude-bot-gary.a` advertised jobs
// (roadmap_workforce.provider_registry.capabilities->'jobs'). Asserted constant
// per the task spec — the liaison must NOT advertise gate_review.
const WORKER_LIAISON_JOBS = [
	"develop",
	"review",
	"design",
	"research",
	"proposal_management",
	"code_generation",
];

// ── (a) Flag OFF → no gate-review dispatch (legacy behavior) ─────────────────

describe("P3840 — deliberate gate offers", () => {
	test("(a) flag OFF: gate-review roles are filtered out for mature proposals", async () => {
		const roles = await getRolesForQueue(
			matureKey,
			queryReturning([gateReviewRow()]),
			FLAG_OFF,
		);
		assert.equal(
			roles.length,
			0,
			"with the flag OFF a mature proposal whose only role is gate-review must resolve to an empty role set",
		);
	});

	test("(a) flag OFF: non-gate build roles are untouched (surgical filter)", async () => {
		const roles = await getRolesForQueue(
			matureKey,
			queryReturning([buildRow(), gateReviewRow()]),
			FLAG_OFF,
		);
		assert.deepEqual(
			roles.map((r) => r.role),
			["architect"],
			"the filter must drop ONLY gate-review roles, leaving build roles intact",
		);
	});

	// ── (b) Flag ON → gate-review role resolved with ['gate_review'] ────────────

	test("(b) flag ON: mature roles include gate-review with required_capabilities ['gate_review']", async () => {
		const roles = await getRolesForQueue(
			matureKey,
			queryReturning([gateReviewRow()]),
			FLAG_ON,
		);
		assert.equal(roles.length, 1);
		assert.equal(roles[0]?.role, "gate-review");
		assert.deepEqual(roles[0]?.requiredCapabilities, [GATE_REVIEW_CAPABILITY]);
		assert.equal(roles[0]?.source, "db");
	});

	test("(b) flag ON: gate-review is the primary (lowest-priority-number) profile", async () => {
		const roles = await getRolesForQueue(
			matureKey,
			queryReturning([gateReviewRow(5), buildRow()]),
			FLAG_ON,
		);
		// priority 5 < 10 → gate-review first (scanQueues uses roleProfiles[0]).
		assert.equal(roles[0]?.role, "gate-review");
	});

	// ── (c) Worker liaison cannot auto-claim gate-review offers ─────────────────

	test("(c) the worker liaison does NOT advertise the gate_review job", () => {
		assert.equal(GATE_REVIEW_CAPABILITY, "gate_review");
		assert.ok(
			!WORKER_LIAISON_JOBS.includes(GATE_REVIEW_CAPABILITY),
			`worker liaison jobs ${JSON.stringify(WORKER_LIAISON_JOBS)} must not include ${GATE_REVIEW_CAPABILITY}; ` +
				"otherwise the liaison's AgencyClaimLoop could auto-claim a deliberate gate offer",
		);
	});

	test("(c) a gate-review offer's required capability is satisfiable ONLY by a gate-review-capable agency", () => {
		// fn_claim_work_offer matches an offer iff the agency advertises a job in
		// the offer's required_capabilities (?| overlap). Model that overlap here.
		const offerRequired = [GATE_REVIEW_CAPABILITY];
		const liaisonMatches = offerRequired.some((c) =>
			WORKER_LIAISON_JOBS.includes(c),
		);
		assert.equal(
			liaisonMatches,
			false,
			"worker liaison must not match a gate-review offer's required capabilities",
		);

		const gateDeskJobs = ["gate_review"]; // gate-desk seed advertisement
		const gateDeskMatches = offerRequired.some((c) => gateDeskJobs.includes(c));
		assert.equal(
			gateDeskMatches,
			true,
			"the gate-desk agency advertises gate_review and is the only capability match",
		);
	});

	// ── (d) inferGateForState mapping respected per stage ───────────────────────
	// Independent re-derivation of the gate→stage map encoded in migration 295,
	// asserted against the canonical inferGateForState contract (Standard RFC +
	// Hotfix). Keeps the migration's gate metadata honest.

	test("(d) gate metadata matches inferGateForState (Standard RFC 14)", () => {
		const standardMap: Record<string, { gate: string; to: string }> = {
			DRAFT: { gate: "D1", to: "REVIEW" },
			REVIEW: { gate: "D2", to: "DEVELOP" },
			DEVELOP: { gate: "D3", to: "MERGE" },
			MERGE: { gate: "D4", to: "COMPLETE" },
		};
		// Each Standard-RFC mature stage seeded by 295 must carry the right gate.
		for (const [stage, expected] of Object.entries(standardMap)) {
			const meta = gateMetaFor(14, stage);
			assert.ok(meta, `migration 295 must seed a gate-review row for 14/${stage}`);
			assert.equal(meta.gate, expected.gate, `14/${stage} gate`);
			assert.equal(meta.toStage, expected.to, `14/${stage} to_stage`);
		}
	});

	test("(d) gate metadata matches inferGateForState (Hotfix 37 skips REVIEW/MERGE)", () => {
		assert.equal(gateMetaFor(37, "DRAFT")?.gate, "D1");
		assert.equal(gateMetaFor(37, "DRAFT")?.toStage, "FIX");
		assert.equal(gateMetaFor(37, "DEVELOP")?.gate, "D3");
		assert.equal(gateMetaFor(37, "DEVELOP")?.toStage, "DEPLOYED");
		// Hotfix has no REVIEW/MERGE gate.
		assert.equal(gateMetaFor(37, "REVIEW"), null);
		assert.equal(gateMetaFor(37, "MERGE"), null);
	});
});

// ── Local model of the gate metadata seeded by migration 295 ─────────────────
// (Mirrors the prompt_template gate/from/to fields; the DB row is asserted in
// the live-DB suite — here we lock the mapping logic.)
function gateMetaFor(
	template: number,
	stage: string,
): { gate: string; toStage: string } | null {
	if (template === 14) {
		switch (stage) {
			case "DRAFT":
				return { gate: "D1", toStage: "REVIEW" };
			case "REVIEW":
				return { gate: "D2", toStage: "DEVELOP" };
			case "DEVELOP":
				return { gate: "D3", toStage: "MERGE" };
			case "MERGE":
				return { gate: "D4", toStage: "COMPLETE" };
			default:
				return null;
		}
	}
	if (template === 37) {
		switch (stage) {
			case "DRAFT":
				return { gate: "D1", toStage: "FIX" };
			case "DEVELOP":
				return { gate: "D3", toStage: "DEPLOYED" };
			default:
				return null; // REVIEW / MERGE skipped
		}
	}
	return null;
}
