/**
 * P1438 C6 AC-9 (matchmaking) + AC-10 (fix coordination).
 *
 * AC-9: the brain selects the spawn persona for each claimed offer — a stable
 * name for common capabilities, a dynamic claude.<specialty> for rare ones —
 * and two offers needing different capabilities map to two correctly-matched
 * personas.
 *
 * AC-10: on a worker failure the brain decides retry vs reroute vs escalate vs
 * log (never silent drop, never unconditional retry storm) and records the
 * action against the offer.
 */
import { describe, it, expect, vi } from "vitest";
import {
	matchPersonaForCapability,
	slugifySpecialty,
} from "./persona-matchmaker.ts";
import {
	decideRecoveryAction,
	classifyFailure,
} from "./recovery-action.ts";
import {
	coordinateFailureRecovery,
	orderCapsByExpertise,
	AgencyClaimLoop,
	type AgencyClaimedOffer,
	type ListenerClient,
} from "./agency-claim-loop.ts";

describe("AC-9 matchPersonaForCapability — common → stable name", () => {
	it("maps the develop capability to a stable senior-developer persona", () => {
		const m = matchPersonaForCapability("developer", ["develop"]);
		expect(m.stable).toBe(true);
		expect(m.personaName).toBe("senior-developer");
		expect(m.expertiseHint).toBe("develop");
		expect(m.source).toBe("capability");
	});

	it("maps the review capability to a stable gate-reviewer persona", () => {
		const m = matchPersonaForCapability("reviewer", ["review"]);
		expect(m.stable).toBe(true);
		expect(m.personaName).toBe("gate-reviewer");
		expect(m.expertiseHint).toBe("review");
	});

	it("prefers a role-specific stable persona over the capability default", () => {
		// skeptic is a 'review' capability but a distinct persona.
		const m = matchPersonaForCapability("skeptic-alpha", ["review"]);
		expect(m.stable).toBe(true);
		expect(m.personaName).toBe("reality-checker");
		expect(m.source).toBe("role");
	});
});

describe("AC-9 matchPersonaForCapability — rare → dynamic claude.<specialty>", () => {
	it("derives a dynamic persona for a rare capability", () => {
		const m = matchPersonaForCapability("specialist", ["webgl-shader-audit"]);
		expect(m.stable).toBe(false);
		expect(m.personaName).toBe("claude.webgl-shader-audit");
		expect(m.expertiseHint).toBe("webgl-shader-audit");
		expect(m.source).toBe("dynamic");
	});

	it("slugifies messy specialty tokens safely", () => {
		expect(slugifySpecialty("Threat Detection!!")).toBe("threat-detection");
		expect(slugifySpecialty("   ")).toBe("general");
		expect(slugifySpecialty("a".repeat(40)).length).toBeLessThanOrEqual(24);
	});

	it("falls back to a dynamic persona when no capability is given", () => {
		const m = matchPersonaForCapability("mystery-role", []);
		expect(m.stable).toBe(false);
		expect(m.personaName).toBe("claude.mystery-role");
	});
});

describe("AC-9 — two different offers map to two different personas", () => {
	it("distinguishes a common build offer from a rare specialty offer", () => {
		const a = matchPersonaForCapability("developer", ["develop"]);
		const b = matchPersonaForCapability("auditor", ["soc2-evidence-mapping"]);
		expect(a.personaName).not.toBe(b.personaName);
		expect(a.stable).toBe(true);
		expect(b.stable).toBe(false);
		expect(b.personaName).toBe("claude.soc2-evidence-mapping");
	});
});

describe("AC-9 orderCapsByExpertise — structured identity hint leads", () => {
	it("moves the matched expertise hint to the front of the cap list", () => {
		expect(orderCapsByExpertise(["develop", "review"], "review")).toEqual([
			"review",
			"develop",
		]);
	});
	it("prepends a hint not already present", () => {
		expect(orderCapsByExpertise(["develop"], "merge")).toEqual([
			"merge",
			"develop",
		]);
	});
	it("is a no-op for an empty hint", () => {
		expect(orderCapsByExpertise(["develop"], "")).toEqual(["develop"]);
	});
});

describe("AC-10 classifyFailure", () => {
	it("classes rate-limit text as transient rate_limited", () => {
		expect(classifyFailure({ errorText: "HTTP 429 Too Many Requests", attemptCount: 1 })).toEqual(
			{ failureClass: "rate_limited", transient: true },
		);
	});
	it("classes 401 as non-transient auth_rejected", () => {
		expect(classifyFailure({ errorText: "401 Unauthorized", attemptCount: 1 })).toEqual(
			{ failureClass: "auth_rejected", transient: false },
		);
	});
	it("classes a timeout as a transient unknown flake", () => {
		expect(classifyFailure({ errorText: "spawn timeout / SIGTERM", attemptCount: 1 })).toEqual(
			{ failureClass: "unknown", transient: true },
		);
	});
	it("classes a missing-artifact failure as a non-transient defect", () => {
		expect(
			classifyFailure({ failureReason: "no_artifact for role=developer", attemptCount: 1 }),
		).toEqual({ failureClass: "unknown", transient: false });
	});
});

describe("AC-10 decideRecoveryAction — bounded, no retry storm", () => {
	it("retries a transient failure once while attempts remain", () => {
		const d = decideRecoveryAction({ errorText: "socket hang up", attemptCount: 1 });
		expect(d.action).toBe("retry");
	});
	it("escalates instead of retrying after attempts are exhausted", () => {
		const d = decideRecoveryAction({
			errorText: "socket hang up",
			attemptCount: 2,
			maxAttempts: 2,
		});
		expect(d.action).toBe("escalate");
	});
	it("reroutes (returns to pool) on rate-limit/quota", () => {
		expect(decideRecoveryAction({ errorText: "429 rate limit", attemptCount: 1 }).action).toBe(
			"reroute",
		);
		expect(
			decideRecoveryAction({ errorText: "usage limit exhausted", attemptCount: 1 }).action,
		).toBe("reroute");
	});
	it("escalates dead auth rather than retrying it", () => {
		expect(decideRecoveryAction({ errorText: "403 Forbidden", attemptCount: 1 }).action).toBe(
			"escalate",
		);
	});
	it("escalates a non-transient defect (never a silent drop)", () => {
		const d = decideRecoveryAction({ failureReason: "no role artifact", attemptCount: 1 });
		expect(d.action).toBe("escalate");
		expect(d.reason).toMatch(/not silently dropping/i);
	});
});

function makeClaim(over: Partial<AgencyClaimedOffer> = {}): AgencyClaimedOffer {
	return {
		offerId: "42",
		dispatchId: 42,
		proposalId: 100,
		squadName: "liaison-task",
		role: "developer",
		claimToken: "tok",
		claimExpiresAt: new Date().toISOString(),
		offerVersion: 1,
		metadata: {},
		leaseTtlSeconds: 1320,
		...over,
	};
}

describe("AC-6 — claim loop LISTENs only the shared work_offers channel", () => {
	it("issues LISTEN work_offers and never a per-agency work_offers_<id>", async () => {
		const listenStatements: string[] = [];
		const fakeClient: ListenerClient = {
			query: async (text: string) => {
				if (/^\s*LISTEN/i.test(text)) listenStatements.push(text.trim());
				return {};
			},
			on: () => undefined,
			removeListener: () => undefined,
			end: async () => undefined,
		};

		// queryFn stubs out fn_claim_work_offer + the capacity pre-checks so start()
		// completes its initial tryClaim without a DB. We only care about LISTENs.
		const queryFn = (async (sql: string) => {
			if (sql.includes("isProviderAuthDown") || sql.includes("provider_auth")) {
				return { rows: [{ auth_down: false }] };
			}
			return { rows: [] };
		}) as never;

		const loop = new AgencyClaimLoop({
			agencyIdentity: "claude-bot-gary.a",
			provider: "claude",
			capabilities: ["develop"],
			onClaim: async () => {},
			connectListener: async () => fakeClient,
			queryFn,
			pollIntervalMs: 1_000_000, // never fire the interval during the test
			logger: { log: () => {}, warn: () => {}, error: () => {} },
		});

		await loop.start();
		await loop.stop();

		expect(listenStatements).toContain("LISTEN work_offers");
		// The crux of AC-6: O(hosts) not O(agencies) — no per-agency channel.
		expect(
			listenStatements.some((s) => /work_offers_/.test(s)),
		).toBe(false);
		expect(
			listenStatements.some((s) => /liaison_message_/.test(s)),
		).toBe(false);
	});
});

describe("AC-10 coordinateFailureRecovery — records action against the offer", () => {
	it("writes a recovery_action for a failed offer", async () => {
		const updates: Array<{ sql: string; params: unknown[] }> = [];
		const query = vi.fn(async (sql: string, params?: unknown[]) => {
			if (sql.includes("SELECT offer_status")) {
				return {
					rows: [
						{
							offer_status: "failed",
							dispatch_status: "failed",
							attempt_count: 1,
							failure_class: "unknown",
							failure_is_transient: false,
							metadata: { last_error: "no role artifact" },
							paused_at_provider_limit: false,
						},
					],
				};
			}
			updates.push({ sql, params: params ?? [] });
			return { rows: [] };
		}) as never;

		const decision = await coordinateFailureRecovery(
			query,
			"claude-bot-gary.a",
			makeClaim(),
			{ log: () => {}, warn: () => {} },
		);
		expect(decision?.action).toBe("escalate");
		const update = updates.find((u) => u.sql.includes("recovery_action"));
		expect(update).toBeDefined();
		expect(update?.params).toContain("escalate");
		expect(update?.params).toContain("claude-bot-gary.a");
	});

	it("does NOT record a recovery action for a delivered offer", async () => {
		const updates: string[] = [];
		const query = vi.fn(async (sql: string) => {
			if (sql.includes("SELECT offer_status")) {
				return {
					rows: [
						{
							offer_status: "delivered",
							dispatch_status: "completed",
							attempt_count: 1,
							failure_class: null,
							failure_is_transient: false,
							metadata: {},
							paused_at_provider_limit: false,
						},
					],
				};
			}
			updates.push(sql);
			return { rows: [] };
		}) as never;

		const decision = await coordinateFailureRecovery(
			query,
			"claude-bot-gary.a",
			makeClaim(),
			{ log: () => {}, warn: () => {} },
		);
		expect(decision).toBeNull();
		expect(updates.some((s) => s.includes("recovery_action"))).toBe(false);
	});

	it("skips a provider-limit HOLD (deliberate pause, not a failure to coordinate)", async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes("SELECT offer_status")) {
				return {
					rows: [
						{
							offer_status: "claimed",
							dispatch_status: "active",
							attempt_count: 1,
							failure_class: "rate_limited",
							failure_is_transient: true,
							metadata: {},
							paused_at_provider_limit: true,
						},
					],
				};
			}
			return { rows: [] };
		}) as never;

		const decision = await coordinateFailureRecovery(
			query,
			"claude-bot-gary.a",
			makeClaim(),
			{ log: () => {}, warn: () => {} },
		);
		expect(decision).toBeNull();
	});
});
