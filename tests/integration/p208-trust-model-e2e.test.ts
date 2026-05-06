/**
 * P208 Integration Tests — Trust Model + ACL
 *
 * Suite 4 of the A2A test plan (a2aTest session, 2026-05-05).
 *
 * Covers:
 *   - getTrustLevel (system override, self-message, default, explicit row, expiry)
 *   - trustGate (blocked, restricted with task/command/gate exemption, known, authority)
 *   - checkMessageACL (system bypass, active grant, missing/revoked grant, wildcard '*')
 *
 * Schema:
 *   - agent_trust lives in roadmap_workforce (FK to agent_registry.agent_identity)
 *   - message_acl was created in this session by applying the safe portion of
 *     database/ddl/v4/055-a2a-secure-delivery.sql (table + seed only — the trigger
 *     replacement was deliberately skipped to keep the live dispatcher's
 *     `new_message` channel working).
 *
 * Trust-gate functions were extracted from scripts/a2a-dispatcher.ts into
 * src/infra/messaging/a2a-trust-gate.ts so they can be imported without
 * booting the dispatcher service.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import {
	checkMessageACL,
	createACLEntry,
	revokeACLEntry,
} from "../../src/infra/messaging/a2a-access-control.ts";
import { getTrustLevel, trustGate } from "../../src/infra/messaging/a2a-trust-gate.ts";
import { closePool, query } from "../../src/infra/postgres/pool.ts";

const TS = Date.now();
const ALICE = `test/p208/alice-${TS}`;
const BOB = `test/p208/bob-${TS}`;
const CAROL = `test/p208/carol-${TS}`;
const DAN = `test/p208/dan-${TS}`;
const ADMIN = `test/p208/admin-${TS}`;

async function ensureAgent(identity: string) {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status, trust_tier)
		 VALUES ($1, 'tool', 'active', 'known')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity],
	);
}

async function setTrust(
	recipient: string,
	sender: string,
	level: "authority" | "trusted" | "known" | "restricted" | "blocked",
	opts?: { expiresAt?: Date | null },
) {
	const expires = opts?.expiresAt === undefined ? null : opts.expiresAt;
	await query(
		`INSERT INTO roadmap_workforce.agent_trust
			(agent_identity, trusted_agent, trust_level, granted_by, expires_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (agent_identity, trusted_agent) DO UPDATE
		   SET trust_level = EXCLUDED.trust_level,
		       expires_at  = EXCLUDED.expires_at,
		       updated_at  = now()`,
		[recipient, sender, level, ADMIN, expires],
	);
}

before(async () => {
	for (const id of [ALICE, BOB, CAROL, DAN, ADMIN]) {
		await ensureAgent(id);
	}
});

after(async () => {
	await query(
		`DELETE FROM roadmap_workforce.agent_trust
		 WHERE agent_identity = ANY($1) OR trusted_agent = ANY($1) OR granted_by = ANY($1)`,
		[[ALICE, BOB, CAROL, DAN, ADMIN]],
	);
	await query(
		`DELETE FROM roadmap.message_acl WHERE from_agent = ANY($1) OR to_agent = ANY($1)`,
		[[ALICE, BOB, CAROL, DAN, ADMIN]],
	);
	await closePool();
});

// ─── getTrustLevel ─────────────────────────────────────────────────────────────

describe("getTrustLevel", () => {
	it("returns 'authority' for sender 'system' regardless of recipient", async () => {
		const lvl = await getTrustLevel(ALICE, "system");
		assert.equal(lvl, "authority");
	});

	it("returns 'trusted' for self-message (recipient === sender)", async () => {
		const lvl = await getTrustLevel(ALICE, ALICE);
		assert.equal(lvl, "trusted");
	});

	it("returns 'known' (default-open) when no trust row exists", async () => {
		const lvl = await getTrustLevel(ALICE, BOB);
		assert.equal(lvl, "known");
	});

	it("returns the explicit trust_level from a non-expired row", async () => {
		await setTrust(ALICE, BOB, "blocked");
		assert.equal(await getTrustLevel(ALICE, BOB), "blocked");

		await setTrust(ALICE, BOB, "restricted");
		assert.equal(await getTrustLevel(ALICE, BOB), "restricted");

		await setTrust(ALICE, BOB, "authority");
		assert.equal(await getTrustLevel(ALICE, BOB), "authority");
	});

	it("falls back to 'known' when the matching row has expired", async () => {
		// Set an explicit trust row that is already expired in the past.
		await setTrust(ALICE, CAROL, "blocked", { expiresAt: new Date(Date.now() - 60_000) });
		assert.equal(
			await getTrustLevel(ALICE, CAROL),
			"known",
			"expired blocked row must fall through to default-open",
		);
	});

	it("uses non-expired NULL expires_at row regardless of how old it is", async () => {
		await setTrust(ALICE, DAN, "trusted", { expiresAt: null });
		assert.equal(await getTrustLevel(ALICE, DAN), "trusted");
	});
});

// ─── trustGate ─────────────────────────────────────────────────────────────────

describe("trustGate", () => {
	it("'blocked' senders are dropped regardless of message type", async () => {
		await setTrust(ALICE, BOB, "blocked");
		assert.equal(await trustGate(ALICE, BOB, "task"), false);
		assert.equal(await trustGate(ALICE, BOB, "query"), false);
	});

	it("'restricted' sender + non-authoritative + non-task/command/gate type → false", async () => {
		await setTrust(ALICE, BOB, "restricted");
		assert.equal(await trustGate(ALICE, BOB, "progress_note"), false);
		assert.equal(await trustGate(ALICE, BOB, "query"), false);
		assert.equal(await trustGate(ALICE, BOB, "event"), false);
	});

	it("'restricted' sender + task/command/gate → true (type exemption)", async () => {
		await setTrust(ALICE, BOB, "restricted");
		assert.equal(await trustGate(ALICE, BOB, "task"), true);
		assert.equal(await trustGate(ALICE, BOB, "command"), true);
		assert.equal(await trustGate(ALICE, BOB, "gate"), true);
	});

	it("'restricted' is overridden when sender is 'system' or 'gary' (authoritative bypass)", async () => {
		await setTrust(ALICE, "system", "restricted");
		// system bypass kicks in *before* the DB lookup (returns 'authority'), so
		// even the restricted row above doesn't change the answer.
		assert.equal(await trustGate(ALICE, "system", "progress_note"), true);
	});

	it("'known' sender accepts any message type (no trust row → default-open)", async () => {
		// Clear any prior row left behind by earlier tests in this describe block.
		await query(
			`DELETE FROM roadmap_workforce.agent_trust
			 WHERE agent_identity = $1 AND trusted_agent = $2`,
			[ALICE, BOB],
		);
		assert.equal(await trustGate(ALICE, BOB, "progress_note"), true);
		assert.equal(await trustGate(ALICE, BOB, "task"), true);
	});

	it("'authority' sender accepts any message type", async () => {
		await setTrust(ALICE, BOB, "authority");
		assert.equal(await trustGate(ALICE, BOB, "progress_note"), true);
		assert.equal(await trustGate(ALICE, BOB, "task"), true);
	});
});

// ─── checkMessageACL ───────────────────────────────────────────────────────────

describe("checkMessageACL", () => {
	it("'system' sender bypasses ACL even with no DB grant", async () => {
		const r = await checkMessageACL("system", ALICE, "dm");
		assert.equal(r.allowed, true);
		assert.equal(r.reason, "system_agent_bypass");
	});

	it("'orchestrator' sender bypasses ACL even with no DB grant", async () => {
		const r = await checkMessageACL("orchestrator", ALICE, "dm");
		assert.equal(r.allowed, true);
		assert.equal(r.reason, "system_agent_bypass");
	});

	it("non-system sender with no ACL row is denied", async () => {
		const r = await checkMessageACL(BOB, CAROL, "dm");
		assert.equal(r.allowed, false);
		assert.match(r.reason ?? "", /acl_denied/);
	});

	it("non-system sender with active ACL row is allowed", async () => {
		await createACLEntry({ fromAgent: BOB, toAgent: CAROL, grantType: "dm", grantedBy: ADMIN });
		const r = await checkMessageACL(BOB, CAROL, "dm");
		assert.equal(r.allowed, true);
		assert.equal(r.reason, "acl_grant_found");
	});

	it("revoked ACL row no longer permits delivery", async () => {
		await createACLEntry({ fromAgent: BOB, toAgent: DAN, grantType: "dm", grantedBy: ADMIN });
		const before = await checkMessageACL(BOB, DAN, "dm");
		assert.equal(before.allowed, true);

		const revoked = await revokeACLEntry(BOB, DAN, "dm");
		assert.equal(revoked, true);

		const after = await checkMessageACL(BOB, DAN, "dm");
		assert.equal(after.allowed, false);
	});

	it("wildcard '*' to_agent grants reach any recipient", async () => {
		await createACLEntry({ fromAgent: CAROL, toAgent: "*", grantType: "dm", grantedBy: ADMIN });
		const r1 = await checkMessageACL(CAROL, ALICE, "dm");
		const r2 = await checkMessageACL(CAROL, BOB, "dm");
		assert.equal(r1.allowed, true);
		assert.equal(r2.allowed, true);
	});

	it("grant_type is enforced — a 'dm' grant does not satisfy a 'channel_post' check", async () => {
		await createACLEntry({ fromAgent: DAN, toAgent: ALICE, grantType: "dm", grantedBy: ADMIN });
		const dm = await checkMessageACL(DAN, ALICE, "dm");
		const post = await checkMessageACL(DAN, ALICE, "channel_post");
		assert.equal(dm.allowed, true);
		assert.equal(post.allowed, false);
	});
});
