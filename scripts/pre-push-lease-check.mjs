#!/usr/bin/env node
/**
 * P1445 AC-4: pre-push branch single-writer enforcement.
 *
 * An agent may push ONLY the branch whose proposal it holds an active lease on.
 * `main` is never pushed directly by an agent (merge-request-only, AC-5 backstop
 * at GitLab). Force-pushing an unowned branch is rejected.
 *
 * git invokes the pre-push hook with `<remote> <url>` argv and a stdin stream of
 *   <local ref> <local sha> <remote ref> <remote sha>\n
 * one line per ref being pushed. This module exposes the pure decision logic
 * (extractProposalId / evaluatePush) so it can be unit-tested without git, and a
 * runnable main() that wires stdin + a live proposal_lease lookup.
 *
 * Decision precedence (per remote ref):
 *   1. Deleting a ref (local sha all-zero)        → ALLOW (no content pushed)
 *   2. Pushing to main/master                     → REJECT (MR-only)
 *   3. Branch carries no parseable proposal id    → REJECT (unowned/ad-hoc)
 *   4. No active lease for (proposalId, identity) → REJECT (not the owner)
 *   5. Active lease held by this identity         → ALLOW
 *
 * Escape hatch: AGENTHIVE_PREPUSH_BYPASS=1 (operator console) skips all checks.
 */

const ZERO_SHA = /^0{40,}$/;

/**
 * Parse the proposal id from a branch ref. Accepts the canonical
 * `feat/p<NNNN>-<slug>` convention (case-insensitive on the `p`), with or
 * without a `refs/heads/` prefix. Returns the numeric id or null.
 */
export function extractProposalId(ref) {
	if (!ref) return null;
	const branch = ref.replace(/^refs\/heads\//, "");
	const m = branch.match(/(?:^|\/)p(\d+)(?:[-_/]|$)/i);
	return m ? Number(m[1]) : null;
}

/** True when the ref is a protected primary branch that agents must not push directly. */
export function isProtectedBranch(ref) {
	const branch = (ref || "").replace(/^refs\/heads\//, "");
	return branch === "main" || branch === "master";
}

/**
 * Pure per-ref decision. `hasActiveLease(proposalId, identity)` must be supplied
 * by the caller (sync boolean here; the runner resolves it from the DB up front).
 *
 * @returns {{allowed: boolean, reason: string}}
 */
export function evaluatePushRef({
	localSha,
	remoteRef,
	agentIdentity,
	hasActiveLease,
	bypass = false,
}) {
	if (bypass) return { allowed: true, reason: "operator bypass" };

	// Branch deletion carries no content; allow.
	if (localSha && ZERO_SHA.test(localSha)) {
		return { allowed: true, reason: "ref deletion" };
	}

	if (isProtectedBranch(remoteRef)) {
		return {
			allowed: false,
			reason: `direct push to "${remoteRef}" is forbidden — main is merge-request-only (P1445 AC-5)`,
		};
	}

	const proposalId = extractProposalId(remoteRef);
	if (proposalId === null) {
		return {
			allowed: false,
			reason: `branch "${remoteRef}" carries no proposal id (expected feat/p<NNNN>-...); cannot verify lease ownership`,
		};
	}

	if (!agentIdentity) {
		return {
			allowed: false,
			reason: "agent identity is unset (AGENT_IDENTITY / git config agenthive.identity); cannot verify lease ownership",
		};
	}

	if (!hasActiveLease) {
		return {
			allowed: false,
			reason: `no active proposal_lease for P${proposalId} held by "${agentIdentity}"; you may push only the branch whose proposal you hold the lease on`,
		};
	}

	return { allowed: true, reason: `lease ownership verified for P${proposalId}` };
}

/**
 * Evaluate every pushed ref. `leaseLookup` is a Set of proposalIds the identity
 * currently holds an active lease on (resolved once, up front).
 *
 * @returns {{allowed: boolean, rejections: Array<{remoteRef: string, reason: string}>}}
 */
export function evaluatePush({ refLines, agentIdentity, heldProposalIds, bypass = false }) {
	const held = heldProposalIds instanceof Set ? heldProposalIds : new Set(heldProposalIds ?? []);
	const rejections = [];
	for (const line of refLines) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4) continue; // skip malformed/empty lines
		const [, localSha, remoteRef] = parts;
		const proposalId = extractProposalId(remoteRef);
		const res = evaluatePushRef({
			localSha,
			remoteRef,
			agentIdentity,
			hasActiveLease: proposalId !== null && held.has(proposalId),
			bypass,
		});
		if (!res.allowed) rejections.push({ remoteRef, reason: res.reason });
	}
	return { allowed: rejections.length === 0, rejections };
}

/** Resolve the pushing agent's identity from env or git config. */
function resolveIdentity() {
	return (
		process.env.AGENT_IDENTITY ||
		process.env.AGENTHIVE_AGENT_IDENTITY ||
		process.env.AGENCY_IDENTITY ||
		null
	);
}

async function main() {
	const bypass = process.env.AGENTHIVE_PREPUSH_BYPASS === "1";

	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	const refLines = chunks.join("").split("\n").filter((l) => l.trim().length > 0);

	if (refLines.length === 0) process.exit(0); // nothing to push

	const agentIdentity = resolveIdentity();

	// Resolve held leases once. Fail CLOSED on DB error for protected/owned refs
	// would be too aggressive for operators, so: if we cannot reach the DB we
	// still enforce the no-direct-main and parseable-branch rules (which need no
	// DB), and treat lease lookups as "not held".
	let heldProposalIds = new Set();
	if (agentIdentity && !bypass) {
		try {
			const { Client } = await import("pg");
			const pgPassword = process.env.PGPASSWORD;
			const client = new Client({
				host: process.env.PGHOST || "127.0.0.1",
				port: Number(process.env.PGPORT || 5432),
				user: process.env.PGUSER || "admin",
				database: process.env.PGDATABASE || "agenthive",
				password: pgPassword,
			});
			await client.connect();
			const { rows } = await client.query(
				`SELECT proposal_id FROM roadmap_proposal.proposal_lease
				  WHERE agent_identity = $1 AND released_at IS NULL`,
				[agentIdentity],
			);
			heldProposalIds = new Set(rows.map((r) => Number(r.proposal_id)));
			await client.end();
		} catch (err) {
			console.error(
				`[pre-push] WARN: could not query proposal_lease (${err.message}); ` +
					`enforcing main/branch-name rules only.`,
			);
		}
	}

	const { allowed, rejections } = evaluatePush({
		refLines,
		agentIdentity,
		heldProposalIds,
		bypass,
	});

	if (!allowed) {
		console.error("[pre-push] BLOCKED by P1445 branch single-writer policy:");
		for (const r of rejections) {
			console.error(`  ✗ ${r.remoteRef}: ${r.reason}`);
		}
		console.error(
			"  Operator override: AGENTHIVE_PREPUSH_BYPASS=1 git push ...",
		);
		process.exit(1);
	}
	process.exit(0);
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(`[pre-push] hook error: ${err.stack || err}`);
		process.exit(1);
	});
}
