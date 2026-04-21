/**
 * Roadmap-schema Postgres integration tests.
 *
 * Run: npx jiti src/test/postgres-integration.test.ts
 * Requires a reachable Postgres instance on 127.0.0.1:5432 with the
 * `roadmap` schema already deployed.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PgMemoryHandlers } from "../../src/mcp/tools/memory/pg-handlers.ts";
import { PgProposalHandlers } from "../../src/mcp/tools/proposals/pg-handlers.ts";
import { transitionProposal as transitionProposalRfc } from "../../src/mcp/tools/rfc/pg-handlers.ts";
import { PgSpendingHandlers } from "../../src/mcp/tools/spending/pg-handlers.ts";
import { closePool, initPoolFromConfig } from "../../src/postgres/pool.ts";
import {
	createProposal,
	deleteProposal,
	getProposalSummary,
} from "../../src/postgres/proposal-storage-v2.ts";

const TEST_PREFIX = `itest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_WORKFLOW = `${TEST_PREFIX}_workflow`;
const TEST_TYPE = `${TEST_PREFIX}_type`;
const DEFAULT_AGENT = `${TEST_PREFIX}_builder`;
const DEFAULT_REVIEWER = `${TEST_PREFIX}_reviewer`;

function loadEnvFilePassword(): string | undefined {
	for (const candidate of [".env", ".env.agent"]) {
		if (!existsSync(candidate)) continue;
		const env = readFileSync(candidate, "utf8");
		const match = env.match(/^PGPASSWORD=(.+)$/m);
		if (match) {
			process.env.PGPASSWORD = match[1].trim();
			return process.env.PGPASSWORD;
		}
	}
	return undefined;
}

function textContent(result: {
	content?: Array<{ type?: string; text?: string }>;
}): string {
	return (result.content ?? [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function parseDatabaseUrl(value?: string): {
	host?: string;
	port?: number;
	user?: string;
	password?: string;
	database?: string;
} {
	if (!value) return {};
	const url = new URL(value);
	return {
		host: url.hostname || undefined,
		port: url.port ? Number(url.port) : undefined,
		user: url.username || undefined,
		password: url.password || undefined,
		database: url.pathname.replace(/^\/+/, "") || undefined,
	};
}

function resolvePgConfig() {
	const databaseUrlConfig = parseDatabaseUrl(process.env.DATABASE_URL);
	const password =
		process.env.PGPASSWORD ??
		databaseUrlConfig.password ??
		loadEnvFilePassword();

	if (!password) {
		throw new Error(
			"PGPASSWORD or DATABASE_URL is required for postgres-integration.test.ts",
		);
	}

	return {
		host: process.env.PG_HOST ?? databaseUrlConfig.host ?? "127.0.0.1",
		port: Number(process.env.PG_PORT ?? databaseUrlConfig.port) || 5432,
		user: process.env.PG_USER ?? databaseUrlConfig.user ?? "admin",
		password,
		database:
			process.env.PG_DATABASE ?? databaseUrlConfig.database ?? "agenthive",
		options: "-c search_path=roadmap,public",
	};
}

const PG_CONFIG = resolvePgConfig();

let pool: Pool;

async function ensureAgent(agentIdentity: string): Promise<void> {
	await pool.query(
		`INSERT INTO agent_registry (agent_identity, agent_type, role)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT agent_registry_agent_identity_key
     DO UPDATE SET role = EXCLUDED.role`,
		[agentIdentity, "llm", "integration-test"],
	);
}

async function seedWorkflowFixture(): Promise<void> {
	const { rows: templateRows } = await pool.query<{ id: number }>(
		`INSERT INTO workflow_templates (name, description, stage_count, is_system)
     VALUES ($1, $2, 3, false)
     RETURNING id`,
		[TEST_WORKFLOW, "Integration test workflow"],
	);
	const templateId = templateRows[0].id;

	await pool.query(
		`INSERT INTO workflow_stages (template_id, stage_name, stage_order, maturity_gate, requires_ac)
     VALUES
       ($1, 'Draft', 1, 0, false),
       ($1, 'Review', 2, 1, true),
       ($1, 'Complete', 3, 2, true)`,
		[templateId],
	);

	await pool.query(
		`INSERT INTO workflow_transitions (template_id, from_stage, to_stage, labels, allowed_roles, requires_ac)
     VALUES
       ($1, 'Draft', 'Review', ARRAY['promote'], ARRAY['builder'], false),
       ($1, 'Review', 'Complete', ARRAY['approve'], ARRAY['reviewer'], true)`,
		[templateId],
	);

	await pool.query(
		`INSERT INTO proposal_valid_transitions (workflow_name, from_state, to_state, allowed_reasons, allowed_roles, requires_ac)
     VALUES
       ($1, 'Draft', 'Review', ARRAY['promote'], ARRAY['builder'], 'none'),
       ($1, 'Review', 'Complete', ARRAY['approve'], ARRAY['reviewer'], 'all')`,
		[TEST_WORKFLOW],
	);

	await pool.query(
		`INSERT INTO proposal_type_config (type, workflow_name, description, required_fields, optional_fields)
     VALUES ($1, $2, $3, $4, $5)`,
		[
			TEST_TYPE,
			TEST_WORKFLOW,
			"Integration test proposal type",
			["summary", "design"],
			["motivation"],
		],
	);
}

async function ensureTokenEfficiencySchema(): Promise<boolean> {
	const { rows: existingRows } = await pool.query<{ exists: boolean }>(
		`SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'metrics' AND table_name = 'token_efficiency'
     ) AS exists`,
	);
	if (existingRows[0]?.exists) {
		return true;
	}

	const migrationPath = join(
		process.cwd(),
		"scripts/migrations/014-token-efficiency-metrics.sql",
	);
	const sql = readFileSync(migrationPath, "utf8");
	try {
		await pool.query(sql);
		return true;
	} catch {
		return false;
	}
}

async function cleanupFixture(): Promise<void> {
	const prefixPattern = `${TEST_PREFIX}%`;

	await pool.query(
		`DELETE FROM spending_log WHERE agent_identity LIKE $1 OR run_id LIKE $1`,
		[prefixPattern],
	);
	await pool.query(`DELETE FROM proposal_lease WHERE agent_identity LIKE $1`, [
		prefixPattern,
	]);
	await pool.query(`DELETE FROM run_log WHERE run_id LIKE $1`, [prefixPattern]);
	await pool.query(`DELETE FROM spending_caps WHERE agent_identity LIKE $1`, [
		prefixPattern,
	]);
	await pool.query(`DELETE FROM agent_memory WHERE agent_identity LIKE $1`, [
		prefixPattern,
	]);
	await pool.query(`DELETE FROM proposal WHERE type = $1`, [TEST_TYPE]);
	await pool.query(
		`DELETE FROM proposal_valid_transitions WHERE workflow_name = $1`,
		[TEST_WORKFLOW],
	);
	await pool.query(`DELETE FROM proposal_type_config WHERE type = $1`, [
		TEST_TYPE,
	]);

	const { rows: templateRows } = await pool.query<{ id: number }>(
		`SELECT id FROM workflow_templates WHERE name = $1`,
		[TEST_WORKFLOW],
	);
	for (const row of templateRows) {
		await pool.query(
			`DELETE FROM workflow_transitions WHERE template_id = $1`,
			[row.id],
		);
		await pool.query(`DELETE FROM workflow_stages WHERE template_id = $1`, [
			row.id,
		]);
		await pool.query(`DELETE FROM workflow_templates WHERE id = $1`, [row.id]);
	}

	await pool.query(`DELETE FROM agent_registry WHERE agent_identity LIKE $1`, [
		prefixPattern,
	]);
}

before(async () => {
	pool = new Pool(PG_CONFIG);
	initPoolFromConfig({
		host: PG_CONFIG.host,
		port: PG_CONFIG.port,
		user: PG_CONFIG.user,
		password: PG_CONFIG.password,
		name: PG_CONFIG.database,
		schema: "roadmap",
	});

	await ensureAgent(DEFAULT_AGENT);
	await ensureAgent(DEFAULT_REVIEWER);
	await seedWorkflowFixture();
});

after(async () => {
	await cleanupFixture();
	await closePool();
	await pool.end();
});

describe("Roadmap Postgres integration", () => {
	it("uses roadmap tables and views", async () => {
		const { rows: tables } = await pool.query<{ tablename: string }>(
			`SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'roadmap'
         AND tablename IN ('proposal', 'workflows', 'agent_memory', 'spending_caps', 'spending_log')
       ORDER BY tablename`,
		);
		assert.deepStrictEqual(
			tables.map((row) => row.tablename),
			[
				"agent_memory",
				"proposal",
				"spending_caps",
				"spending_log",
				"workflows",
			],
		);

		const { rows: views } = await pool.query<{ viewname: string }>(
			`SELECT viewname
       FROM pg_views
       WHERE schemaname = 'roadmap'
         AND viewname IN ('v_active_memory', 'v_daily_spend', 'v_proposal_summary')
       ORDER BY viewname`,
		);
		assert.deepStrictEqual(
			views.map((row) => row.viewname),
			["v_active_memory", "v_daily_spend", "v_proposal_summary"],
		);
	});

	it("creates proposals through the v2 adapter and auto-spawns workflows", async () => {
		const proposal = await createProposal(
			{
				type: TEST_TYPE,
				title: `${TEST_PREFIX} adapter create`,
				summary: "Structured summary",
				design: "Structured design",
				tags: { source: "integration-test" },
			},
			DEFAULT_AGENT,
		);

		assert.match(proposal.display_id, /^P\d+$/);
		assert.equal(proposal.status, "Draft");
		assert.ok(proposal.created_at);
		assert.ok(proposal.modified_at);

		const { rows: workflowRows } = await pool.query<{ current_stage: string }>(
			`SELECT current_stage
       FROM workflows
       WHERE proposal_id = $1`,
			[proposal.id],
		);
		assert.equal(workflowRows.length, 1);
		assert.equal(workflowRows[0].current_stage, "Draft");

		const summary = await getProposalSummary(proposal.id);
		assert.equal(summary?.workflow_name, TEST_WORKFLOW);
		assert.equal(summary?.current_stage, "Draft");

		await deleteProposal(proposal.id);
	});

	it("enforces workflow transitions and acceptance-criteria gates", async () => {
		const proposal = await createProposal(
			{
				type: TEST_TYPE,
				title: `${TEST_PREFIX} transition`,
				summary: "Transition summary",
				design: "Transition design",
			},
			DEFAULT_AGENT,
		);

		const reviewResult = await transitionProposalRfc({
			proposal_id: proposal.display_id,
			to_state: "Review",
			decided_by: DEFAULT_AGENT,
			rationale: "promote",
		});
		assert.match(textContent(reviewResult), /Draft → Review/);

		await pool.query(
			`INSERT INTO proposal_acceptance_criteria (proposal_id, item_number, criterion_text)
       VALUES ($1, $2, $3)`,
			[proposal.id, 1, "Must pass integration review"],
		);

		const blockedResult = await transitionProposalRfc({
			proposal_id: proposal.display_id,
			to_state: "Complete",
			decided_by: DEFAULT_REVIEWER,
			rationale: "approve",
		});
		assert.match(
			textContent(blockedResult),
			/acceptance criteria must all pass/i,
		);

		await pool.query(
			`UPDATE proposal_acceptance_criteria
       SET status = 'pass', verified_by = $1, verified_at = NOW()
       WHERE proposal_id = $2 AND item_number = 1`,
			[DEFAULT_REVIEWER, proposal.id],
		);

		const completeResult = await transitionProposalRfc({
			proposal_id: proposal.display_id,
			to_state: "Complete",
			decided_by: DEFAULT_REVIEWER,
			rationale: "approve",
		});
		assert.match(textContent(completeResult), /Review → Complete/);

		const { rows: transitionRows } = await pool.query<{
			from_state: string;
			to_state: string;
			transitioned_by: string | null;
		}>(
			`SELECT from_state, to_state, transitioned_by
       FROM proposal_state_transitions
       WHERE proposal_id = $1
       ORDER BY id`,
			[proposal.id],
		);
		assert.ok(
			transitionRows.some(
				(row) => row.from_state === "Draft" && row.to_state === "Review",
			),
		);
		assert.ok(
			transitionRows.some(
				(row) => row.from_state === "Review" && row.to_state === "Complete",
			),
		);
		assert.ok(
			transitionRows.some((row) => row.transitioned_by === DEFAULT_REVIEWER),
		);

		const { rows: workflowRows } = await pool.query<{
			current_stage: string;
			completed_at: Date | null;
		}>(
			`SELECT current_stage, completed_at
       FROM workflows
       WHERE proposal_id = $1`,
			[proposal.id],
		);
		assert.equal(workflowRows[0].current_stage, "Complete");
		assert.ok(workflowRows[0].completed_at);

		await deleteProposal(proposal.id);
	});

	it("updates memory rows without relying on a missing unique constraint and respects v_active_memory", async () => {
		const memory = new PgMemoryHandlers({} as never);
		const agentIdentity = `${TEST_PREFIX}_memory`;
		await ensureAgent(agentIdentity);

		await memory.setMemory({
			agent_identity: agentIdentity,
			layer: "semantic",
			key: "fact",
			value: "First value",
			metadata: JSON.stringify({ source: "integration-test" }),
			ttl_seconds: 3600,
		});

		await memory.setMemory({
			agent_identity: agentIdentity,
			layer: "semantic",
			key: "fact",
			value: "Updated value",
		});

		const { rows: storedRows } = await pool.query<{
			value: string;
			ttl_seconds: number | null;
			metadata: { source: string };
		}>(
			`SELECT value, ttl_seconds, metadata
       FROM agent_memory
       WHERE agent_identity = $1 AND layer = 'semantic' AND key = 'fact'`,
			[agentIdentity],
		);
		assert.equal(storedRows.length, 1);
		assert.equal(storedRows[0].value, "Updated value");
		assert.equal(storedRows[0].ttl_seconds, 3600);
		assert.equal(storedRows[0].metadata.source, "integration-test");

		await pool.query(
			`INSERT INTO agent_memory (agent_identity, layer, key, value, ttl_seconds)
       VALUES ($1, 'semantic', 'expired', 'Expired value', 1)`,
			[agentIdentity],
		);
		await pool.query(
			`UPDATE agent_memory
       SET expires_at = NOW() - INTERVAL '1 minute'
       WHERE agent_identity = $1 AND key = 'expired'`,
			[agentIdentity],
		);

		const { rows: activeRows } = await pool.query<{ key: string }>(
			`SELECT key
       FROM v_active_memory
       WHERE agent_identity = $1
       ORDER BY key`,
			[agentIdentity],
		);
		assert.deepStrictEqual(
			activeRows.map((row) => row.key),
			["fact"],
		);
	});

	it("records spend against run_log and derives daily totals from the immutable ledger", async () => {
		const spending = new PgSpendingHandlers({} as never, process.cwd());
		const agentIdentity = `${TEST_PREFIX}_spender`;
		await ensureAgent(agentIdentity);

		const proposal = await createProposal(
			{
				type: TEST_TYPE,
				title: `${TEST_PREFIX} spending`,
				summary: "Budget summary",
				design: "Budget design",
			},
			agentIdentity,
		);

		await pool.query(
			`INSERT INTO run_log (run_id, agent_identity, proposal_id, status, input_summary)
       VALUES ($1, $2, $3, 'running', $4)`,
			[
				`${TEST_PREFIX}_run_1`,
				agentIdentity,
				proposal.id,
				"Integration spending test",
			],
		);

		const logResult = await spending.logSpending({
			agent_identity: agentIdentity,
			proposal_id: proposal.display_id,
			cost_usd: "6.00",
			run_id: `${TEST_PREFIX}_run_1`,
		});
		assert.match(textContent(logResult), /Logged \$6\.00/);

		const { rows: spendRows } = await pool.query<{
			total_usd: string;
			event_count: number;
		}>(
			`SELECT total_usd::text AS total_usd, event_count::int AS event_count
       FROM v_daily_spend
       WHERE agent_identity = $1 AND spend_date = CURRENT_DATE`,
			[agentIdentity],
		);
		assert.equal(parseFloat(spendRows[0].total_usd), 6);
		assert.equal(spendRows[0].event_count, 1);

		const { rows: logRows } = await pool.query<{ proposal_id: number | null }>(
			`SELECT proposal_id
       FROM spending_log
       WHERE agent_identity = $1
       ORDER BY id DESC
       LIMIT 1`,
			[agentIdentity],
		);
		assert.equal(logRows[0].proposal_id, proposal.id);

		const report = await spending.getSpendingReport({
			agent_identity: agentIdentity,
		});
		assert.match(textContent(report), /today \$6\.000000\/\$∞/);

		await deleteProposal(proposal.id);
	});

	it("records token efficiency metrics and reports weekly aggregates", async () => {
		const spending = new PgSpendingHandlers({} as never, process.cwd());
		const agentIdentity = `${TEST_PREFIX}_efficiency`;
		await ensureAgent(agentIdentity);
		const hasMetricsSchema = await ensureTokenEfficiencySchema();

		const proposal = await createProposal(
			{
				type: TEST_TYPE,
				title: `${TEST_PREFIX} efficiency`,
				summary: "Efficiency summary",
				design: "Efficiency design",
			},
			agentIdentity,
		);

		await pool.query(
			`INSERT INTO run_log (run_id, agent_identity, proposal_id, status, input_summary)
       VALUES ($1, $2, $3, 'running', $4)`,
			[
				`${TEST_PREFIX}_run_efficiency`,
				agentIdentity,
				proposal.id,
				"Integration token efficiency test",
			],
		);

		await pool.query(
			`INSERT INTO model_metadata (model_name, provider)
       VALUES ($1, $2)
       ON CONFLICT ON CONSTRAINT model_metadata_model_name_key
       DO NOTHING`,
			["claude-sonnet-4", "anthropic"],
		);

		const sessionId = "11111111-1111-4111-8111-111111111111";
		const logResult = await spending.logSpending({
			agent_identity: agentIdentity,
			proposal_id: proposal.display_id,
			cost_usd: "0.75",
			model_name: "claude-sonnet-4",
			run_id: `${TEST_PREFIX}_run_efficiency`,
			session_id: sessionId,
			agent_role: "implementer",
			task_type: "code_review",
			input_tokens: "1000",
			output_tokens: "200",
			cache_write_tokens: "50",
			cache_read_tokens: "700",
		});
		if (hasMetricsSchema) {
			assert.match(textContent(logResult), /Token efficiency metrics recorded/);

			const { rows: metricRows } = await pool.query<{
				model: string;
				agent_role: string | null;
				cache_hit_rate: string;
				cost_microdollars: string | null;
			}>(
				`SELECT model, agent_role, cache_hit_rate::text, cost_microdollars::text
         FROM metrics.token_efficiency
         WHERE proposal_id = $1
         ORDER BY recorded_at DESC
         LIMIT 1`,
				[proposal.display_id],
			);
			assert.equal(metricRows[0].model, "claude-sonnet-4");
			assert.equal(metricRows[0].agent_role, "implementer");
			assert.equal(metricRows[0].cache_hit_rate, "0.70000000000000000000");
			assert.equal(metricRows[0].cost_microdollars, "750000");

			const report = await spending.getTokenEfficiencyReport({
				agent_role: "implementer",
				model: "claude-sonnet-4",
			});
			assert.match(textContent(report), /claude-sonnet-4/);
			assert.match(textContent(report), /cache_hit=0\.700/);
		} else {
			assert.match(
				textContent(logResult),
				/Token efficiency metrics skipped; apply migration 014 first/,
			);

			const report = await spending.getTokenEfficiencyReport({
				agent_role: "implementer",
				model: "claude-sonnet-4",
			});
			assert.match(
				textContent(report),
				/Token efficiency metrics are unavailable\. Apply migration 014 first/,
			);
		}

		await deleteProposal(proposal.id);
	});

	it("claims proposals through the Postgres MCP proposal handler", async () => {
		const proposals = new PgProposalHandlers({} as never, process.cwd());
		const agentIdentity = `${TEST_PREFIX}_claimer`;
		await ensureAgent(agentIdentity);

		const proposal = await createProposal(
			{
				type: TEST_TYPE,
				title: `${TEST_PREFIX} claim`,
				summary: "Claim summary",
				design: "Claim design",
			},
			agentIdentity,
		);

		const claimResult = await proposals.claimProposal({
			id: proposal.display_id,
			agent: agentIdentity,
			durationMinutes: 30,
		});
		assert.match(textContent(claimResult), /Claimed proposal/);

		const activeLeases = await pool.query<{
			agent_identity: string;
			expires_at: Date | null;
		}>(
			`SELECT agent_identity, expires_at
       FROM proposal_lease
       WHERE proposal_id = $1 AND released_at IS NULL`,
			[proposal.id],
		);
		assert.equal(activeLeases.rows[0].agent_identity, agentIdentity);
		assert.ok(activeLeases.rows[0].expires_at);

		const secondClaim = await proposals.claimProposal({
			id: proposal.display_id,
			agent: `${agentIdentity}_other`,
			durationMinutes: 30,
		});
		assert.match(textContent(secondClaim), /already claimed/);

		const forceClaim = await proposals.claimProposal({
			id: proposal.display_id,
			agent: `${agentIdentity}_other`,
			durationMinutes: 30,
			force: true,
		});
		assert.match(textContent(forceClaim), /Claimed proposal/);

		const leaseList = await proposals.listLeases({ id: proposal.display_id });
		assert.match(textContent(leaseList), new RegExp(`${agentIdentity}_other`));

		const renewResult = await proposals.renewProposal({
			id: proposal.display_id,
			agent: `${agentIdentity}_other`,
			durationMinutes: 45,
		});
		assert.match(textContent(renewResult), /Renewed proposal/);

		const releaseResult = await proposals.releaseProposal({
			id: proposal.display_id,
			agent: `${agentIdentity}_other`,
			reason: "integration-test-complete",
		});
		assert.match(textContent(releaseResult), /Released proposal/);

		const emptyLeaseList = await proposals.listLeases({
			id: proposal.display_id,
		});
		assert.match(textContent(emptyLeaseList), /No active leases/);

		await deleteProposal(proposal.id);
	});
});
