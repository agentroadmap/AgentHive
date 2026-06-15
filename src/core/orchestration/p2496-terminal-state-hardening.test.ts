/**
 * P2496 — Offer-generator terminal-state hardening.
 *
 * COMPLETE is a terminal proposal state, but multiple offer-creation sites can
 * still post / resurrect work offers for completed proposals → dispatch churn
 * (completed proposals retain dev+gate offers and starve genuine work).
 *
 * AC-1 (postWorkOffer TerminalProposalError guard) is covered by the behavioural
 * mock tests in src/core/pipeline/post-work-offer.test.ts. This file is the
 * regression guard for the REMAINING offer-creation sites, each of which lives
 * on a module-level `query` that is not injectable without signature churn:
 *
 *   AC-5  legacy-dispatch.handleStateChange — short-circuits on terminal status
 *   AC-6  legacy-dispatch.claimImplicitGateReady — excludes COMPLETE from select
 *   AC-4  liaison-agent.bridgeTaskToOfferDispatch — re-asserts the guard before
 *         its direct squad_dispatch INSERT (which bypasses postWorkOffer)
 *   AC-2  migration 274 trigger — retracts live offers when status→COMPLETE
 *
 * These are source-shape assertions: if a future edit removes a guard, the
 * relevant test fails loudly instead of silently regressing the invariant
 *   SELECT count(*) FROM squad_dispatch s JOIN proposal p ON p.id=s.proposal_id
 *    WHERE s.offer_status IN ('open','claimed') AND p.status='COMPLETE'  -- AC-3
 * back above zero.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

function read(rel: string): string {
	return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

// ── AC-5: handleStateChange short-circuits on terminal status ────────────────
test("AC-5: handleStateChange returns early for terminal (COMPLETE) status", () => {
	const src = read("src/core/orchestration/legacy-dispatch.ts");
	// Imports the shared helper (no duplicated constant).
	assert.match(
		src,
		/import\s*\{[\s\S]*isTerminalProposalStatus[\s\S]*\}\s*from\s*["']\.\.\/pipeline\/post-work-offer\.ts["']/,
		"legacy-dispatch must import isTerminalProposalStatus from post-work-offer",
	);
	// The function fetches status alongside maturity and short-circuits on it.
	const fn = src.slice(src.indexOf("export async function handleStateChange"));
	assert.match(
		fn,
		/isTerminalProposalStatus\(\s*maturityRows\[0\]\?\.status\s*\)/,
		"handleStateChange must short-circuit when status is terminal",
	);
});

// ── AC-6: implicit-gate selection excludes COMPLETE ──────────────────────────
test("AC-6: claimImplicitGateReady WHERE clause excludes COMPLETE", () => {
	const src = read("src/core/orchestration/legacy-dispatch.ts");
	const fn = src.slice(src.indexOf("async function claimImplicitGateReady"));
	const where = fn.slice(0, fn.indexOf("LIMIT $2"));
	// Explicit belt-and-suspenders exclusion …
	assert.match(
		where,
		/UPPER\(p\.status\)\s*<>\s*'COMPLETE'/,
		"implicit-gate select must explicitly exclude COMPLETE",
	);
	// … and COMPLETE is absent from the positive allowlist.
	assert.doesNotMatch(
		where,
		/IN\s*\([^)]*'complete'[^)]*\)/i,
		"COMPLETE must not appear in the implicit-gate status allowlist",
	);
});

// ── AC-4: liaison task bridge re-asserts the terminal guard before INSERT ─────
test("AC-4: bridgeTaskToOfferDispatch guards terminal status before squad_dispatch INSERT", () => {
	const src = read("src/infra/agency/liaison-agent.ts");
	assert.match(
		src,
		/import\s*\{[\s\S]*isTerminalProposalStatus[\s\S]*TerminalProposalError[\s\S]*\}\s*from\s*["'][^"']*post-work-offer\.ts["']/,
		"liaison-agent must import the shared terminal guard from post-work-offer",
	);
	const fn = src.slice(src.indexOf("export async function bridgeTaskToOfferDispatch"));
	const guardIdx = fn.search(/isTerminalProposalStatus\(\s*proposalStatus\s*\)/);
	const insertIdx = fn.search(/INSERT INTO roadmap_workforce\.squad_dispatch/);
	assert.ok(guardIdx >= 0, "bridge must check isTerminalProposalStatus");
	assert.ok(insertIdx >= 0, "bridge must contain the squad_dispatch INSERT");
	assert.ok(
		guardIdx < insertIdx,
		"terminal-status guard must run BEFORE the squad_dispatch INSERT",
	);
	assert.match(
		fn.slice(guardIdx, insertIdx),
		/throw new TerminalProposalError/,
		"terminal status must throw TerminalProposalError (caught + reported by caller)",
	);
});

// ── AC-2: migration 274 retracts live offers on COMPLETE transition ──────────
test("AC-2: migration 274 trigger expires open/claimed offers on status→COMPLETE", () => {
	const mig = read("scripts/migrations/274-p2496-retract-offers-on-complete.sql");
	// Idempotent shape (re-runnable).
	assert.match(mig, /CREATE OR REPLACE FUNCTION/i, "function must be CREATE OR REPLACE");
	assert.match(
		mig,
		/DROP TRIGGER IF EXISTS\s+trg_retract_offers_on_complete/i,
		"trigger must be dropped-if-exists before create (re-runnable)",
	);
	// AFTER UPDATE OF status, only on the COMPLETE transition.
	assert.match(
		mig,
		/AFTER UPDATE OF status ON roadmap_proposal\.proposal/i,
		"trigger must fire AFTER UPDATE OF status on the proposal table",
	);
	assert.match(
		mig,
		/WHEN\s*\([\s\S]*UPPER\(NEW\.status\)\s*=\s*'COMPLETE'[\s\S]*UPPER\(COALESCE\(OLD\.status,\s*''\)\)\s*<>\s*'COMPLETE'/i,
		"trigger WHEN must gate on the new→COMPLETE transition only",
	);
	// The retraction UPDATE targets exactly the live offer set.
	assert.match(
		mig,
		/UPDATE roadmap_workforce\.squad_dispatch[\s\S]*SET[\s\S]*offer_status\s*=\s*'expired'[\s\S]*completed_at\s*=\s*now\(\)/i,
		"trigger must expire offers and stamp completed_at",
	);
	assert.match(
		mig,
		/WHERE proposal_id = NEW\.id[\s\S]*offer_status IN \('open', 'claimed'\)[\s\S]*completed_at IS NULL/i,
		"retraction must scope to live (open/claimed, not-yet-completed) offers",
	);
	// No inner transaction control — the runner wraps the file.
	assert.doesNotMatch(mig, /^\s*BEGIN\s*;/im, "migration must not open its own transaction");
	assert.doesNotMatch(mig, /^\s*COMMIT\s*;/im, "migration must not commit its own transaction");
});
