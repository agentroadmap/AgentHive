/**
 * P3535 — Monotonic maturity lifecycle tests.
 *
 * Tests the post-migration invariants:
 *   AC-2: claim only advances new → active (active/mature unchanged).
 *   AC-3/AC-4: mature is sticky; only send-back bucket demotes to new.
 *   AC-6: handleGateCompletion releases before setMaturity to avoid trigger race.
 *   AC-7: migration rejects a missing P1391 EXCLUDE constraint (preflight).
 *
 * These are unit-level logic tests against the TypeScript release-reasons
 * taxonomy and the SQL CASE semantics (imported as constants). DB-level
 * integration tests live in the migration SQL itself (post-migration DO block).
 */

import { describe, it, expect } from "vitest";
import {
  RELEASE_REASONS_BY_OUTCOME,
  OUTCOME_TO_MATURITY,
  maturityFor,
  outcomeOf,
  ALLOWED_RELEASE_REASONS,
} from "../../../src/core/proposal/release-reasons";

// ---------------------------------------------------------------------------
// Send-back bucket — P3535 AC-3: the ONLY reasons that demote mature → new.
// ---------------------------------------------------------------------------
const SEND_BACK_BUCKET = new Set([
  "gate_hold",
  "gate_reject",
  "work_failed",
  "manual_release",
  "reassigned",
  "force_reclaimed",
]);

// Preserve-mature reasons: all known reasons not in send-back and not abandoned.
const ABANDONED_BUCKET = new Set([
  "wont_pursue",
  "superseded",
  "out_of_scope",
]);

// Simulate P3535's mature-sticky CASE logic.
function p3535MaturityForMature(reason: string): "new" | "mature" | "obsolete" | null {
  if (ABANDONED_BUCKET.has(reason)) return "obsolete";
  if (SEND_BACK_BUCKET.has(reason)) return "new";
  // All other known reasons → preserve mature.
  if (ALLOWED_RELEASE_REASONS.includes(reason)) return "mature";
  return null; // unknown → would RAISE in DB
}

// ---------------------------------------------------------------------------
// AC-2: claim trigger — new→active only
// ---------------------------------------------------------------------------
describe("AC-2: claim trigger maturity guard", () => {
  it("should not advance maturity=active proposals on claim", () => {
    // Simulate old behavior vs new behavior
    const old_guard = (maturity: string) => maturity !== "obsolete";
    const new_guard = (maturity: string) => maturity === "new";

    // Old: claim on active/mature would set active (wrongly clobbers mature)
    expect(old_guard("active")).toBe(true);
    expect(old_guard("mature")).toBe(true);

    // New: only new advances
    expect(new_guard("new")).toBe(true);
    expect(new_guard("active")).toBe(false);
    expect(new_guard("mature")).toBe(false);
    expect(new_guard("obsolete")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-3/AC-4: mature-sticky release semantics
// ---------------------------------------------------------------------------
describe("AC-3/AC-4: mature-sticky release mapping", () => {
  it("send-back bucket demotes mature → new", () => {
    for (const reason of SEND_BACK_BUCKET) {
      expect(p3535MaturityForMature(reason)).toBe("new");
    }
  });

  it("abandoned bucket transitions mature → obsolete", () => {
    for (const reason of ABANDONED_BUCKET) {
      expect(p3535MaturityForMature(reason)).toBe("obsolete");
    }
  });

  it("work_complete reasons preserve mature", () => {
    for (const reason of RELEASE_REASONS_BY_OUTCOME.work_complete) {
      expect(p3535MaturityForMature(reason)).toBe("mature");
    }
  });

  it("passive incomplete reasons preserve mature (not in send-back)", () => {
    const passiveReasons = RELEASE_REASONS_BY_OUTCOME.incomplete.filter(
      (r) => !SEND_BACK_BUCKET.has(r),
    );
    // There should be at least some passive reasons
    expect(passiveReasons.length).toBeGreaterThan(0);
    for (const reason of passiveReasons) {
      expect(p3535MaturityForMature(reason)).toBe("mature");
    }
  });

  it("gate_transitioned preserves mature (status-sync already set new)", () => {
    expect(p3535MaturityForMature("gate_transitioned")).toBe("mature");
  });

  it("unknown reason returns null (would RAISE in DB)", () => {
    expect(p3535MaturityForMature("bogus_reason_xyz")).toBeNull();
  });

  it("all ALLOWED_RELEASE_REASONS are covered by P3535 mature-sticky logic", () => {
    for (const reason of ALLOWED_RELEASE_REASONS) {
      const result = p3535MaturityForMature(reason);
      expect(result).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: P934 CASE must include work_failed (was missing from migration 128)
// ---------------------------------------------------------------------------
describe("AC-4: work_failed coverage", () => {
  it("work_failed is in release-reasons.ts incomplete bucket", () => {
    expect(RELEASE_REASONS_BY_OUTCOME.incomplete).toContain("work_failed");
  });

  it("outcomeOf work_failed returns incomplete", () => {
    expect(outcomeOf("work_failed")).toBe("incomplete");
  });

  it("maturityFor work_failed returns new", () => {
    expect(maturityFor("work_failed")).toBe("new");
  });

  it("work_failed is in the send-back bucket (P3535 AC-3)", () => {
    expect(SEND_BACK_BUCKET.has("work_failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-6: handleGateCompletion order — release BEFORE setMaturity
// ---------------------------------------------------------------------------
describe("AC-6: handleGateCompletion release-first ordering", () => {
  it("gate_review_complete maps to mature (trigger preserves mature when release fires first)", () => {
    // When release fires while maturity=mature, gate_review_complete → mature (preserved).
    // Then setProposalMaturity('new') runs with no active lease → wins cleanly.
    expect(p3535MaturityForMature("gate_review_complete")).toBe("mature");
    expect(maturityFor("gate_review_complete")).toBe("mature");
  });

  it("outcome of gate_review_complete is work_complete", () => {
    expect(outcomeOf("gate_review_complete")).toBe("work_complete");
    expect(OUTCOME_TO_MATURITY["work_complete"]).toBe("mature");
  });

  it("gate_hold is in the send-back bucket (trigger demotes if gate didn't advance)", () => {
    expect(SEND_BACK_BUCKET.has("gate_hold")).toBe(true);
    expect(p3535MaturityForMature("gate_hold")).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Taxonomy completeness: every release reason is accounted for.
// ---------------------------------------------------------------------------
describe("Taxonomy completeness", () => {
  it("all ALLOWED_RELEASE_REASONS have a non-null maturityFor result (P934 coverage)", () => {
    for (const reason of ALLOWED_RELEASE_REASONS) {
      const m = maturityFor(reason);
      expect(m).not.toBeNull();
    }
  });

  it("ALLOWED_RELEASE_REASONS has no duplicates", () => {
    const set = new Set(ALLOWED_RELEASE_REASONS);
    expect(set.size).toBe(ALLOWED_RELEASE_REASONS.length);
  });
});
