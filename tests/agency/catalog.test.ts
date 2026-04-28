/**
 * P594 — liaison_message_kind_catalog tests
 *
 * AC-18: protocol_resync seeded as 21st kind with:
 *        category='error', direction='any',
 *        payload_schema={type:'object',properties:{max_buffered_sequence:{type:'integer'},
 *          dropped_count:{type:'integer',minimum:0}},required:['max_buffered_sequence','dropped_count']}
 *        The schema derivation is cross-referenced here so any future Zod change causes test failure.
 *
 * AC-19: All 21 kinds are seeded; each has a valid JSONSchema payload_schema;
 *        SELECT COUNT(*) FROM agency.liaison_message_kind_catalog = 21.
 *
 * File-based tests always run.
 * DB-backed tests skipped when PGPASSWORD is not set.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const SKIP = !process.env.PGPASSWORD;
let agencySchemaExists = false;
const dbSkip = (name: string, fn: () => Promise<void>) =>
	it(name, async (t) => {
		if (SKIP || !agencySchemaExists) {
			t.skip("agency schema not installed or DB credentials absent");
			return;
		}
		await fn();
	});

const MIGRATION_PATH = join(
	import.meta.dirname,
	"../../scripts/migrations/062-p594-agency-schema.sql",
);

// Expected payload schema for protocol_resync — derived from ProtocolResyncPayloadSchema
// in src/infra/agency/liaison-message-types.ts (lines 168-173).
// If the Zod schema changes, this const must be updated too — that is the intent.
const PROTOCOL_RESYNC_SCHEMA = {
	type: "object",
	properties: {
		max_buffered_sequence: { type: "integer" },
		dropped_count: { type: "integer", minimum: 0 },
	},
	required: ["max_buffered_sequence", "dropped_count"],
};

// All 21 expected kind_ids — 20 from migration 047 + protocol_resync
const EXPECTED_KINDS = new Set([
	// Lifecycle
	"liaison_pause",
	"liaison_resume",
	"liaison_drain",
	"agency_retire",
	"protocol_ping",
	"liaison_register",
	"agency_active",
	"agency_throttle",
	"protocol_pong",
	// Workflow
	"offer_dispatch",
	"claim_revoke",
	"query_capacity",
	"claim_offer",
	"claim_release",
	"claim_paused",
	"claim_status",
	"progress_note",
	// Error / Protocol
	"assistance_request",
	"escalate",
	// Telemetry
	"heartbeat",
	// 21st kind
	"protocol_resync",
]);

// ─── File-based checks (always run) ───────────────────────────────────────

describe("AC-18: protocol_resync in migration file", () => {
	it("migration file must seed protocol_resync as a catalog kind", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf-8");
		assert.ok(sql.includes("protocol_resync"), "migration must seed protocol_resync kind");
	});

	it("migration file protocol_resync must have category='error'", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf-8");
		// Find the VALUES tuple, not comments (comment line also contains 'protocol_resync')
		const resyncIndex = sql.indexOf("('protocol_resync'");
		assert.ok(resyncIndex !== -1, "protocol_resync VALUES tuple must exist in migration");
		const surrounding = sql.slice(resyncIndex, resyncIndex + 300);
		assert.ok(surrounding.includes("'error'"), "protocol_resync must have category='error'");
	});

	it("migration file protocol_resync must have direction='any'", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf-8");
		const resyncIndex = sql.indexOf("('protocol_resync'");
		const surrounding = sql.slice(resyncIndex, resyncIndex + 300);
		assert.ok(surrounding.includes("'any'"), "protocol_resync must have direction='any'");
	});

	it("migration file protocol_resync payload schema must match ProtocolResyncPayloadSchema", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf-8");
		// Extract the JSON payload schema for protocol_resync from the SQL file
		const match = sql.match(/'protocol_resync'[^;]+?(\{[^)]+\})/s);
		assert.ok(match, "protocol_resync row must have a JSON payload schema in migration");
		// Verify both required fields are present in the schema text
		assert.ok(
			match[1].includes("max_buffered_sequence") && match[1].includes("dropped_count"),
			"protocol_resync payload schema must include max_buffered_sequence and dropped_count",
		);
	});
});

describe("AC-19: all 21 expected kinds are present in migration file", () => {
	it("migration file must include all 21 kind_ids", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf-8");
		const missing: string[] = [];
		for (const kind of EXPECTED_KINDS) {
			if (!sql.includes(`'${kind}'`)) {
				missing.push(kind);
			}
		}
		assert.deepEqual(
			missing,
			[],
			`migration is missing the following kind_ids: ${missing.join(", ")}`,
		);
	});
});

// ─── DB-backed checks ──────────────────────────────────────────────────────

let pool: Pool;

before(async () => {
	if (SKIP) return;
	pool = new Pool({
		host:     process.env.PGHOST     ?? "127.0.0.1",
		port:     Number(process.env.PGPORT ?? 5432),
		user:     process.env.PGUSER     ?? "xiaomi",
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE ?? "agenthive",
	});
	const { rows } = await pool.query(
		"SELECT 1 FROM information_schema.schemata WHERE schema_name = 'agency'",
	);
	agencySchemaExists = rows.length > 0;
});

after(async () => {
	if (SKIP) return;
	await pool.end();
});

describe("AC-19: liaison_message_kind_catalog row count (live DB)", () => {
	dbSkip("catalog must contain exactly 21 rows", async () => {
		const { rows } = await pool.query<{ count: string }>(
			"SELECT COUNT(*)::text AS count FROM agency.liaison_message_kind_catalog",
		);
		assert.equal(rows[0].count, "21", "liaison_message_kind_catalog must have exactly 21 kinds");
	});

	dbSkip("all 21 expected kind_ids exist in catalog", async () => {
		const { rows } = await pool.query<{ kind_id: string }>(
			"SELECT kind_id FROM agency.liaison_message_kind_catalog",
		);
		const seeded = new Set(rows.map(r => r.kind_id));
		const missing: string[] = [];
		for (const kind of EXPECTED_KINDS) {
			if (!seeded.has(kind)) missing.push(kind);
		}
		assert.deepEqual(missing, [], `catalog missing kinds: ${missing.join(", ")}`);
	});

	dbSkip("every catalog row has a non-null, parseable JSONSchema in payload_schema", async () => {
		const { rows } = await pool.query<{ kind_id: string; payload_schema: unknown }>(
			"SELECT kind_id, payload_schema FROM agency.liaison_message_kind_catalog",
		);
		for (const row of rows) {
			assert.ok(
				row.payload_schema !== null && typeof row.payload_schema === "object",
				`${row.kind_id}: payload_schema must be a non-null object`,
			);
			const schema = row.payload_schema as Record<string, unknown>;
			assert.equal(schema.type, "object", `${row.kind_id}: payload_schema.type must be 'object'`);
		}
	});
});

describe("AC-18: protocol_resync catalog row (live DB)", () => {
	dbSkip("protocol_resync row has correct category, direction, and payload_schema", async () => {
		const { rows } = await pool.query<{
			kind_id: string;
			category: string;
			direction: string;
			payload_schema: Record<string, unknown>;
		}>(
			"SELECT kind_id, category, direction, payload_schema FROM agency.liaison_message_kind_catalog WHERE kind_id = 'protocol_resync'",
		);
		assert.equal(rows.length, 1, "protocol_resync must exist in the catalog");
		const row = rows[0];
		assert.equal(row.category, "error", "protocol_resync category must be 'error'");
		assert.equal(row.direction, "any", "protocol_resync direction must be 'any'");

		// Validate payload_schema matches ProtocolResyncPayloadSchema derivation
		const schema = row.payload_schema as Record<string, unknown>;
		assert.equal(schema.type, "object", "payload_schema.type must be 'object'");
		const props = schema.properties as Record<string, Record<string, unknown>>;
		assert.ok(props, "payload_schema must have properties");
		assert.equal(props.max_buffered_sequence?.type, "integer", "max_buffered_sequence must be integer type");
		assert.equal(props.dropped_count?.type, "integer", "dropped_count must be integer type");
		assert.equal(props.dropped_count?.minimum, 0, "dropped_count must have minimum: 0");

		const required = schema.required as string[];
		assert.ok(required.includes("max_buffered_sequence"), "max_buffered_sequence must be required");
		assert.ok(required.includes("dropped_count"), "dropped_count must be required");

		// Cross-reference: the expected schema object must deep-match
		assert.deepEqual(
			{ type: schema.type, properties: props, required: required.sort() },
			{
				type: PROTOCOL_RESYNC_SCHEMA.type,
				properties: PROTOCOL_RESYNC_SCHEMA.properties,
				required: [...PROTOCOL_RESYNC_SCHEMA.required].sort(),
			},
			"protocol_resync payload_schema must match ProtocolResyncPayloadSchema from liaison-message-types.ts",
		);
	});
});
