/**
 * P3312 AC-5: shadow-vs-active unit tests for computeShadowLog.
 *
 * Proves the safety contract: in shadow mode (ADAPTIVE_MATCHER_ENABLED=false) the
 * matcher result is LOGGED but no route is returned/changed; and the flag only
 * toggles the shadow_mode boolean + legacy_choice presence. All DB + config reads
 * are mocked — no live DB, no pollution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../../infra/postgres/pool.ts";
import * as config from "../../shared/runtime/config.ts";
import {
	computeShadowLog,
	provisionalDifficulty,
	provisionalTaskClass,
} from "./match-shadow-log.ts";

vi.mock("../../infra/postgres/pool.ts", () => ({ query: vi.fn() }));
vi.mock("../../shared/runtime/config.ts", () => ({ get: vi.fn() }));

const mockQuery = query as ReturnType<typeof vi.fn>;
const mockGet = config.get as ReturnType<typeof vi.fn>;

const CANDIDATE_POOL = {
	rows: [
		{
			id: 10,
			model_name: "cheap-mid",
			route_provider: "anthropic",
			tier: "mid",
			cost_per_million_input: 3,
			priority: 1,
		},
		{
			id: 20,
			model_name: "frontier-route",
			route_provider: "anthropic",
			tier: "frontier",
			cost_per_million_input: 15,
			priority: 1,
		},
	],
};

beforeEach(() => {
	mockQuery.mockReset();
	mockGet.mockReset();
	mockQuery.mockResolvedValue(CANDIDATE_POOL);
});

afterEach(() => vi.clearAllMocks());

const baseInput = {
	provider: "anthropic",
	chosenRouteId: 10,
	role: "develop",
	agencyIdentity: "claude-bot-gary",
	projectId: 1,
	requiredTier: "mid" as string | null,
	host: "bot",
};

describe("computeShadowLog — shadow vs active", () => {
	it("shadow mode (flag false): shadow_mode=true, legacy_choice present, matcher logged", async () => {
		mockGet.mockResolvedValue(false);
		const r = await computeShadowLog(baseInput);

		expect(r.shadow_mode).toBe(true);
		expect(r.legacy_choice).toEqual({
			route_id: 10,
			source: "legacy_resolver",
		});
		// matcher ran and produced a result that is LOGGED only
		expect(r.matcher_choice).not.toBeNull();
		expect(r.matcher_choice?.kind).toBe("ranked");
	});

	it("active mode (flag true): shadow_mode=false, legacy_choice null", async () => {
		mockGet.mockResolvedValue(true);
		const r = await computeShadowLog(baseInput);

		expect(r.shadow_mode).toBe(false);
		expect(r.legacy_choice).toBeNull();
		// matcher still computed — but this function NEVER returns a route
		expect(r.matcher_choice).not.toBeNull();
	});

	it("result object exposes NO route field — cannot alter live routing", async () => {
		mockGet.mockResolvedValue(false);
		const r = await computeShadowLog(baseInput);
		// Safety invariant: the only keys are the three log columns.
		expect(Object.keys(r).sort()).toEqual(
			["legacy_choice", "matcher_choice", "shadow_mode"].sort(),
		);
		expect("route" in r).toBe(false);
		expect("chosenRouteId" in r).toBe(false);
	});

	it("flag read failure defaults to shadow mode (safe default)", async () => {
		mockGet.mockRejectedValue(new Error("config down"));
		const r = await computeShadowLog(baseInput);
		expect(r.shadow_mode).toBe(true);
	});

	it("candidate-pool query failure → matcher_choice null, still non-blocking", async () => {
		mockGet.mockResolvedValue(false);
		mockQuery.mockRejectedValueOnce(new Error("db blip"));
		const r = await computeShadowLog(baseInput);
		expect(r.matcher_choice).toBeNull();
		expect(r.shadow_mode).toBe(true);
		expect(r.legacy_choice).toEqual({
			route_id: 10,
			source: "legacy_resolver",
		});
	});

	it("uses a P3311 reliability adapter when supplied (AC-2 wire-point)", async () => {
		mockGet.mockResolvedValue(false);
		const getReliability = vi
			.fn()
			.mockResolvedValue({ score: 0.95, confidence: 0.9 });
		const r = await computeShadowLog(baseInput, { getReliability });
		expect(getReliability).toHaveBeenCalled();
		expect(r.matcher_choice).not.toBeNull();
	});
});

describe("provisional derivations (STUB until P3310)", () => {
	it("maps tier → difficulty band", () => {
		expect(provisionalDifficulty("frontier")).toBeGreaterThan(
			provisionalDifficulty("mid"),
		);
		expect(provisionalDifficulty("free")).toBeLessThan(
			provisionalDifficulty("lower"),
		);
		expect(provisionalDifficulty(null)).toBe(0.5);
	});

	it("maps role → locked task classes", () => {
		expect(provisionalTaskClass("frontier-gate-review")).toBe("gate_review");
		expect(provisionalTaskClass("merge-bot")).toBe("merge");
		expect(provisionalTaskClass("architecture")).toBe("architecture");
		expect(provisionalTaskClass("develop")).toBe("develop");
		expect(provisionalTaskClass(null)).toBe("develop");
	});
});
