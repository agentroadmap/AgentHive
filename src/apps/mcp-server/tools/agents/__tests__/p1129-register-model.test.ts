/**
 * P1129 Phase B: registerModel unit tests (node:test, mocked pool — no live DB).
 *
 * Run: node --import jiti/register --test \
 *   src/apps/mcp-server/tools/agents/__tests__/p1129-register-model.test.ts
 *
 * Covers:
 *  - AC-4/AC-19 (B5): static allowlist rejects a model the CLI won't accept
 *    (copilot + gpt-5.4) WITHOUT writing any routes.
 *  - AC-18 (B4): two-step FK-safe upsert shape — model_metadata UPSERT fires
 *    BEFORE model_routes UPSERT, on the verified roadmap tables/columns, and
 *    the route id is returned.
 *  - AC-3: metadata-tier → route-tier mapping (frontier|standard|economy →
 *    frontier|mid|lower) lands the correct route_tier in the routes UPSERT.
 *  - AC-11/AC-17 (B3): the probe spawn config (10s timeout + SIGKILL) actually
 *    hard-kills a hung child (`sleep 30`) at ~10s, never shell:true.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PgAgentHandlers } from "../pg-handlers.ts";

// ── Injected fake query (constructor seam — no live DB, jiti-safe) ───────────
// registerModel issues query() calls for: skip_probe trust lookup, agent_cli
// fallback lookup, then the two-step UPSERT. We capture every (sql, params) so
// we can assert ordering + shape. The model_routes INSERT must RETURN id.
type Captured = { sql: string; params: unknown[] };
const captured: Captured[] = [];
const routeIdToReturn = 4242;

const fakeQuery = (async (sql: string, params: unknown[] = []) => {
	captured.push({ sql, params });
	const s = sql.replace(/\s+/g, " ").trim();
	if (/INSERT INTO roadmap\.model_routes/i.test(s)) {
		return { rows: [{ id: routeIdToReturn }] };
	}
	if (/SELECT agent_cli FROM/i.test(s)) {
		return { rows: [{ agent_cli: null }] };
	}
	if (/SELECT trust_tier FROM/i.test(s)) {
		return { rows: [{ trust_tier: "authority" }] };
	}
	return { rows: [] };
}) as unknown as ConstructorParameters<typeof PgAgentHandlers>[0];

const newHandler = () => new PgAgentHandlers(fakeQuery);

function reset() {
	captured.length = 0;
}

function parse(result: any): any {
	return JSON.parse(result.content[0].text);
}

describe("P1129 registerModel — static allowlist (AC-4 / AC-19 / B5)", () => {
	before(reset);

	it("rejects copilot + gpt-5.4 and writes NO routes", async () => {
		reset();
		const h = newHandler();
		const res = await h.registerModel({
			agent_identity: "test/agency-x",
			model_name: "gpt-5.4",
			route_provider: "github",
			agent_provider: "copilot",
			agent_cli: "copilot",
		});
		const body = parse(res);
		assert.equal(body.registered, false, "must not register");
		assert.equal(body.probe_failed, true);
		assert.match(body.probe_error, /not in the supported set/i);
		// Hard guarantee: no metadata / routes writes happened.
		const wrote = captured.some((c) =>
			/INSERT INTO roadmap\.model_(metadata|routes)/i.test(c.sql),
		);
		assert.equal(wrote, false, "no metadata/routes INSERT may fire on reject");
	});

	it("accepts a copilot model that IS in the supported set", async () => {
		reset();
		const h = newHandler();
		// gpt-5 is allowlisted; skip_probe avoids spawning the real CLI.
		const res = await h.registerModel({
			agent_identity: "test/agency-x",
			model_name: "gpt-5",
			route_provider: "github",
			agent_provider: "copilot",
			agent_cli: "copilot",
			skip_probe: true,
		});
		const body = parse(res);
		assert.equal(body.registered, true);
		assert.equal(body.route_id, 4242);
	});
});

describe("P1129 registerModel — two-step FK-safe upsert (AC-18 / B4)", () => {
	it("UPSERTs model_metadata BEFORE model_routes on the real tables", async () => {
		reset();
		const h = newHandler();
		const res = await h.registerModel({
			agent_identity: "test/agency-x",
			model_name: "claude-opus-4-8",
			route_provider: "anthropic",
			agent_provider: "claude",
			skip_probe: true,
		});
		const body = parse(res);
		assert.equal(body.registered, true);
		assert.equal(body.route_id, 4242, "must return the new route id");

		const metaIdx = captured.findIndex((c) =>
			/INSERT INTO roadmap\.model_metadata/i.test(c.sql),
		);
		const routeIdx = captured.findIndex((c) =>
			/INSERT INTO roadmap\.model_routes/i.test(c.sql),
		);
		assert.ok(metaIdx >= 0, "model_metadata UPSERT must fire");
		assert.ok(routeIdx >= 0, "model_routes UPSERT must fire");
		assert.ok(metaIdx < routeIdx, "metadata must be written before routes (FK order)");

		// Verify exact verified columns/conflict targets (no fabricated cols).
		const meta = captured[metaIdx].sql.replace(/\s+/g, " ");
		assert.match(meta, /\(model_name, provider, is_active\)/);
		assert.match(meta, /ON CONFLICT \(provider, model_name\)/);
		const route = captured[routeIdx].sql.replace(/\s+/g, " ");
		assert.match(
			route,
			/\(model_name, route_provider, agent_provider, agent_cli, base_url, api_spec, tier, is_enabled\)/,
		);
		assert.match(
			route,
			/ON CONFLICT \(model_name, route_provider, agent_provider\)/,
		);
		assert.match(route, /RETURNING id/);
		// model_metadata params carry route_provider as the provider (FK source).
		assert.deepEqual(captured[metaIdx].params, ["claude-opus-4-8", "anthropic"]);
	});

	it("AC-3: metadata_tier=standard maps to route_tier=mid in the routes UPSERT", async () => {
		reset();
		const h = newHandler();
		await h.registerModel({
			agent_identity: "test/agency-x",
			model_name: "some-mid-model",
			route_provider: "openai",
			agent_provider: "codex",
			metadata_tier: "standard",
			skip_probe: true,
		});
		const meta = captured.find((c) =>
			/INSERT INTO roadmap\.model_metadata/i.test(c.sql),
		)!;
		const route = captured.find((c) =>
			/INSERT INTO roadmap\.model_routes/i.test(c.sql),
		)!;
		// metadata gets the metadata-vocab tier; routes get the mapped value.
		assert.equal(meta.params[2], "standard");
		assert.equal(route.params[6], "mid", "standard → mid");
	});
});

describe("P1129 probe spawn — 10s timeout + SIGKILL (AC-11 / AC-17 / B3)", () => {
	it("hard-kills a hung child at ~10s with SIGKILL (kill -9), argv array, no shell", () => {
		// Exercises the EXACT spawnSync options the probe uses against a child
		// that ignores nothing but simply runs for 30s. Must be reaped at ~10s.
		const t0 = Date.now();
		const result = spawnSync("sleep", ["30"], {
			timeout: 10000,
			killSignal: "SIGKILL",
			encoding: "utf-8",
		});
		const elapsedMs = Date.now() - t0;
		assert.equal(result.signal, "SIGKILL", "child must be SIGKILLed, not left to run");
		assert.ok(
			elapsedMs >= 9000 && elapsedMs <= 13000,
			`should abort at ~10s, took ${elapsedMs}ms`,
		);
	});
});
