/**
 * P1445 AC-4: pre-push branch single-writer hook — core check logic.
 *
 * Exercises the pure decision functions (no git, no DB) proving:
 *   - push ALLOWED with a matching active lease
 *   - push REJECTED without a lease
 *   - direct main/master push REJECTED (MR-only)
 *   - unparseable branch REJECTED
 *   - branch deletion + operator bypass ALLOWED
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	evaluatePush,
	evaluatePushRef,
	extractProposalId,
	isProtectedBranch,
} from "../pre-push-lease-check.mjs";

const SHA = "1111111111111111111111111111111111111111";
const ZERO = "0000000000000000000000000000000000000000";

test("extractProposalId parses the feat/p<NNNN>-slug convention", () => {
	assert.equal(extractProposalId("refs/heads/feat/p1445-isolation"), 1445);
	assert.equal(extractProposalId("feat/p1445-isolation-enforcement"), 1445);
	assert.equal(extractProposalId("feat/P901-thing"), 901);
	assert.equal(extractProposalId("feat/p77"), 77);
	assert.equal(extractProposalId("hotfix/p1018-ledger"), 1018);
});

test("extractProposalId returns null for branches without a proposal id", () => {
	assert.equal(extractProposalId("main"), null);
	assert.equal(extractProposalId("refs/heads/main"), null);
	assert.equal(extractProposalId("feat/no-proposal-here"), null);
	assert.equal(extractProposalId(""), null);
});

test("isProtectedBranch flags main and master (with/without ref prefix)", () => {
	assert.equal(isProtectedBranch("main"), true);
	assert.equal(isProtectedBranch("refs/heads/master"), true);
	assert.equal(isProtectedBranch("feat/p1445-x"), false);
});

test("AC-4: push ALLOWED when identity holds the matching active lease", () => {
	const res = evaluatePushRef({
		localSha: SHA,
		remoteRef: "refs/heads/feat/p1445-isolation",
		agentIdentity: "claude-bot-gary",
		hasActiveLease: true,
	});
	assert.equal(res.allowed, true);
});

test("AC-4: push REJECTED when identity holds no lease for that proposal", () => {
	const res = evaluatePushRef({
		localSha: SHA,
		remoteRef: "refs/heads/feat/p1445-isolation",
		agentIdentity: "claude-bot-gary",
		hasActiveLease: false,
	});
	assert.equal(res.allowed, false);
	assert.match(res.reason, /no active proposal_lease/i);
});

test("AC-4 / AC-5: direct push to main is REJECTED (MR-only)", () => {
	const res = evaluatePushRef({
		localSha: SHA,
		remoteRef: "refs/heads/main",
		agentIdentity: "claude-bot-gary",
		hasActiveLease: true, // even with a lease, main is forbidden
	});
	assert.equal(res.allowed, false);
	assert.match(res.reason, /merge-request-only|forbidden/i);
});

test("AC-4: branch with no parseable proposal id is REJECTED", () => {
	const res = evaluatePushRef({
		localSha: SHA,
		remoteRef: "refs/heads/feat/random-branch",
		agentIdentity: "claude-bot-gary",
		hasActiveLease: false,
	});
	assert.equal(res.allowed, false);
	assert.match(res.reason, /no proposal id/i);
});

test("AC-4: missing agent identity is REJECTED for an owned-looking branch", () => {
	const res = evaluatePushRef({
		localSha: SHA,
		remoteRef: "refs/heads/feat/p1445-x",
		agentIdentity: null,
		hasActiveLease: false,
	});
	assert.equal(res.allowed, false);
	assert.match(res.reason, /identity/i);
});

test("AC-4: branch deletion (zero local sha) is ALLOWED", () => {
	const res = evaluatePushRef({
		localSha: ZERO,
		remoteRef: "refs/heads/feat/p1445-x",
		agentIdentity: "claude-bot-gary",
		hasActiveLease: false,
	});
	assert.equal(res.allowed, true);
	assert.match(res.reason, /deletion/i);
});

test("AC-4: operator bypass short-circuits all checks", () => {
	const res = evaluatePushRef({
		localSha: SHA,
		remoteRef: "refs/heads/main",
		agentIdentity: null,
		hasActiveLease: false,
		bypass: true,
	});
	assert.equal(res.allowed, true);
});

test("AC-4: evaluatePush aggregates multi-ref stdin and rejects the unowned ones", () => {
	const refLines = [
		`refs/heads/feat/p1445-iso ${SHA} refs/heads/feat/p1445-iso ${ZERO}`,
		`refs/heads/feat/p2222-other ${SHA} refs/heads/feat/p2222-other ${ZERO}`,
		`refs/heads/main ${SHA} refs/heads/main ${ZERO}`,
	];
	const res = evaluatePush({
		refLines,
		agentIdentity: "claude-bot-gary",
		heldProposalIds: new Set([1445]), // holds 1445 only
	});
	assert.equal(res.allowed, false);
	const rejectedRefs = res.rejections.map((r) => r.remoteRef).sort();
	assert.deepEqual(rejectedRefs, ["refs/heads/feat/p2222-other", "refs/heads/main"]);
});

test("AC-4: evaluatePush allows a push where every ref is owned", () => {
	const refLines = [
		`refs/heads/feat/p1445-iso ${SHA} refs/heads/feat/p1445-iso ${ZERO}`,
	];
	const res = evaluatePush({
		refLines,
		agentIdentity: "claude-bot-gary",
		heldProposalIds: new Set([1445]),
	});
	assert.equal(res.allowed, true);
	assert.equal(res.rejections.length, 0);
});
