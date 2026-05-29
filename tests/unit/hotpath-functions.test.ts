import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { PoolClient } from "pg";
import { closePool, getPool } from "../../src/infra/postgres/pool.ts";

const MIGRATION_PATH = join(
	process.cwd(),
	"database/migrations/106-p781-function-rewrites.sql",
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");
const TEST_AGENT = "test/p781-hotpath";
const TARGET_FUNCTIONS = [
	"fn_notify_gate_ready",
	"fn_sync_proposal_maturity",
	"fn_lease_clear_maturity_on_release",
] as const;
const FORBIDDEN_LITERALS = [
	"TRIAGE",
	"FIX",
	"DEPLOYED",
	"ESCALATE",
	"WONT_FIX",
	"NON_ISSUE",
	"REJECTED",
	"DISCARDED",
] as const;

let createdLeaseTrigger = false;

function nextDisplayId(): string {
	return `P781T-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function applyMigration(direction: "forward" | "rollback"): Promise<void> {
	const pool = getPool();
	const setting = direction === "rollback" ? "rollback" : "forward";
	await pool.query("SELECT set_config('roadmap.migration_direction', $1, false)", [setting]);
	try {
		await pool.query(MIGRATION_SQL);
	} finally {
		await pool.query("RESET roadmap.migration_direction");
	}
}

async function ensureLeaseReleaseTrigger(): Promise<void> {
	const pool = getPool();
	const { rows } = await pool.query<{ exists: boolean }>(
		`SELECT EXISTS (
		   SELECT 1
		     FROM pg_trigger t
		     JOIN pg_class c ON c.oid = t.tgrelid
		     JOIN pg_namespace n ON n.oid = c.relnamespace
		     JOIN pg_proc p ON p.oid = t.tgfoid
		     JOIN pg_namespace pn ON pn.oid = p.pronamespace
		    WHERE n.nspname = 'roadmap_proposal'
		      AND c.relname = 'proposal_lease'
		      AND pn.nspname = 'roadmap'
		      AND p.proname = 'fn_lease_clear_maturity_on_release'
		      AND NOT t.tgisinternal
		 ) AS exists`,
	);
	if (rows[0]?.exists) {
		return;
	}

	await pool.query(`
		CREATE TRIGGER trg_p781_hotpath_lease_release
		BEFORE UPDATE ON roadmap_proposal.proposal_lease
		FOR EACH ROW
		EXECUTE FUNCTION roadmap.fn_lease_clear_maturity_on_release()
	`);
	createdLeaseTrigger = true;
}

async function withNotify<T>(
	action: () => Promise<T>,
): Promise<{ result: T; payload: Record<string, unknown> }> {
	const listener = await getPool().connect();
	try {
		await listener.query("LISTEN orchestrator_wake");
		const notification = new Promise<Record<string, unknown>>((resolve, reject) => {
			const timeout = setTimeout(() => {
				listener.removeListener("notification", onNotification);
				reject(new Error("Timed out waiting for orchestrator_wake"));
			}, 2000);

			function onNotification(msg: { payload?: string | null }) {
				clearTimeout(timeout);
				listener.removeListener("notification", onNotification);
				try {
					resolve(JSON.parse(msg.payload ?? "{}"));
				} catch (error) {
					reject(error);
				}
			}

			listener.on("notification", onNotification);
		});

		const result = await action();
		const payload = await notification;
		return { result, payload };
	} finally {
		await listener.query("UNLISTEN orchestrator_wake").catch(() => undefined);
		listener.release();
	}
}

async function createProposal(
	client: PoolClient,
	overrides?: Partial<{ status: string; maturity: string }>,
): Promise<number> {
	const { rows } = await client.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		   (display_id, type, status, maturity, title, summary, audit)
		 VALUES ($1, 'feature', $2, $3, 'P781 hotpath test', 'test', '[]'::jsonb)
		 RETURNING id`,
		[
			nextDisplayId(),
			overrides?.status ?? "DRAFT",
			overrides?.maturity ?? "new",
		],
	);
	return rows[0].id;
}

async function createLease(client: PoolClient, proposalId: number): Promise<number> {
	const { rows } = await client.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal_lease
		   (proposal_id, agent_identity, expires_at)
		 VALUES ($1, $2, now() + interval '5 minutes')
		 RETURNING id`,
		[proposalId, TEST_AGENT],
	);
	return rows[0].id;
}

async function deleteProposal(client: PoolClient, proposalId: number): Promise<void> {
	await client.query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [proposalId]);
	await client.query("DELETE FROM roadmap_proposal.proposal WHERE id = $1", [proposalId]);
}

describe("P781 hot-path function rewrite", () => {
	before(async () => {
		const pool = getPool();
		await pool.query("SELECT 1");
		await pool.query(
			`INSERT INTO roadmap_workforce.agent_registry
			   (agent_identity, agent_type, trust_tier, status)
			 VALUES ($1, 'tool', 'restricted', 'active')
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[TEST_AGENT],
		);

		await applyMigration("forward");
		await ensureLeaseReleaseTrigger();
	});

	after(async () => {
		const pool = getPool();
		if (createdLeaseTrigger) {
			await pool.query("DROP TRIGGER IF EXISTS trg_p781_hotpath_lease_release ON roadmap_proposal.proposal_lease");
		}
		await applyMigration("rollback");
		await closePool();
	});

	it("removes forbidden hotfix literals from the target function bodies", async () => {
		const pool = getPool();
		const { rows } = await pool.query<{ proname: string; prosrc: string }>(
			`SELECT p.proname, p.prosrc
			   FROM pg_proc p
			   JOIN pg_namespace n ON n.oid = p.pronamespace
			  WHERE n.nspname = 'roadmap'
			    AND p.proname = ANY($1::text[])`,
			[[...TARGET_FUNCTIONS]],
		);
		assert.equal(rows.length, TARGET_FUNCTIONS.length);

		for (const row of rows) {
			for (const literal of FORBIDDEN_LITERALS) {
				assert.equal(
					row.prosrc.includes(literal),
					false,
					`${row.proname} still references forbidden literal ${literal}`,
				);
			}
		}
	});

	it("emits orchestrator_wake with the minimal payload on maturity change", async () => {
		const client = await getPool().connect();
		let proposalId: number | null = null;
		try {
			proposalId = await createProposal(client);

			const { payload } = await withNotify(() =>
				client.query(
					`UPDATE roadmap_proposal.proposal
					    SET maturity = 'mature'
					  WHERE id = $1`,
					[proposalId],
				),
			);

			assert.equal(payload.proposal_id, proposalId);
			assert.equal(payload.old_status, "DRAFT");
			assert.equal(payload.new_status, "DRAFT");
			assert.equal(payload.old_maturity, "new");
			assert.equal(payload.new_maturity, "mature");
			assert.equal(payload.event_kind, "maturity_changed");
			assert.ok(typeof payload.ts === "string");
			assert.ok(Object.hasOwn(payload, "project_id"));
		} finally {
			if (proposalId !== null) {
				await deleteProposal(client, proposalId);
			}
			client.release();
		}
	});

	it("marks terminal transitions mature and notifies orchestrator_wake", async () => {
		const client = await getPool().connect();
		let proposalId: number | null = null;
		try {
			proposalId = await createProposal(client, { status: "DRAFT", maturity: "new" });

			const { payload } = await withNotify(() =>
				client.query(
					`UPDATE roadmap_proposal.proposal
					    SET status = 'COMPLETE'
					  WHERE id = $1`,
					[proposalId],
				),
			);

			const { rows } = await client.query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[proposalId],
			);

			assert.equal(rows[0].maturity, "mature");
			assert.equal(payload.proposal_id, proposalId);
			assert.equal(payload.old_status, "DRAFT");
			assert.equal(payload.new_status, "COMPLETE");
			assert.equal(payload.old_maturity, "new");
			assert.equal(payload.new_maturity, "mature");
			assert.equal(payload.event_kind, "status_changed");
		} finally {
			if (proposalId !== null) {
				await deleteProposal(client, proposalId);
			}
			client.release();
		}
	});

	it("preserves deterministic lease-release maturity mapping", async () => {
		const client = await getPool().connect();
		let proposalId: number | null = null;
		try {
			proposalId = await createProposal(client, { maturity: "new" });
			const leaseId = await createLease(client, proposalId);

			await client.query(
				`UPDATE roadmap_proposal.proposal
				    SET maturity = 'mature', audit = '[]'::jsonb
				  WHERE id = $1`,
				[proposalId],
			);

			await client.query(
				`UPDATE roadmap_proposal.proposal_lease
				    SET released_at = now(), release_reason = 'manual_release'
				  WHERE id = $1`,
				[leaseId],
			);

			const { rows } = await client.query<{ maturity: string; audit: Array<Record<string, unknown>> }>(
				`SELECT maturity, audit
				   FROM roadmap_proposal.proposal
				  WHERE id = $1`,
				[proposalId],
			);

			assert.equal(rows[0].maturity, "new");
			const entry = rows[0].audit.find(
				(item) =>
					item.Activity === "MaturityChange" &&
					item.Agent === "lease_release_trigger",
			);
			assert.ok(entry, "lease release trigger should append a MaturityChange audit entry");
			assert.equal(entry?.From, "mature");
			assert.equal(entry?.To, "new");
			assert.equal(entry?.release_reason, "manual_release");
		} finally {
			if (proposalId !== null) {
				await deleteProposal(client, proposalId);
			}
			client.release();
		}
	});
});
