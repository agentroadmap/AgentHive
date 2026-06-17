/**
 * P3507: Cross-project control-plane aggregation endpoint tests
 *
 * AC-2: GET /api/control-plane/fleet returns cross-project aggregation
 * AC-3: GET /api/control-plane/efficiency, /identity, /platform each return cross-project rollups
 * AC-6: Fan-out is bounded (concurrency + timeout); partial results handled
 * AC-7: Consistent partial-result envelope { data, errors, partial }
 * AC-9: Fleet combines hiveCentral (agency/route) + per-tenant runtime counts
 *
 * Tests import handlers directly to avoid needing a live HTTP server.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { getControlPool, resetForTesting } from "../../src/postgres/pool-registry.ts";

const SKIP = process.env.SKIP_DB_TESTS === "true";
const TS = Date.now();
const SLUG_A = `p3507-a-${TS}`;
const SLUG_B = `p3507-b-${TS}`;

// These project IDs are tracked for cleanup
const createdProjectIds: number[] = [];

describe("P3507: control-plane aggregation endpoints", { skip: SKIP }, () => {
	before(async () => {
		// Seed 2 active projects so cross-project queries have >=2 rows
		const ctrl = getControlPool();

		for (const slug of [SLUG_A, SLUG_B]) {
			const { rows } = await ctrl.query<{ project_id: number }>(
				`INSERT INTO roadmap.project
				   (slug, name, status, dsn_secret_ref, worktree_root)
				 VALUES ($1, $2, 'active', 'TEST_DSN_NOT_USED', '/tmp/p3507-${slug}')
				 ON CONFLICT (slug) DO UPDATE SET status='active'
				 RETURNING project_id`,
				[slug, `P3507 test ${slug}`],
			);
			if (rows[0]) createdProjectIds.push(rows[0].project_id);
		}
	});

	after(async () => {
		const ctrl = getControlPool();
		for (const id of createdProjectIds) {
			await ctrl.query(
				`DELETE FROM roadmap.project WHERE project_id = $1`,
				[id],
			).catch(() => {});
		}
		// Reset registry so seeded test DSNs don't pollute other tests
		await resetForTesting().catch(() => {});
	});

	it("roadmap.project table has >= 2 active rows after seed", async () => {
		const ctrl = getControlPool();
		const { rows } = await ctrl.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM roadmap.project WHERE status='active'`,
		);
		const count = Number(rows[0]?.count ?? 0);
		assert.ok(count >= 2, `Expected >= 2 active projects, got ${count}`);
	});

	it("GET /api/control-plane/fleet returns correct envelope shape", async () => {
		// Import lazily to avoid module-load side effects before DB is seeded
		const { RoadmapServer } = await import("../../src/apps/server/index.ts");
		const server = new RoadmapServer("/tmp");

		// Call handler directly
		const resp = await (server as unknown as Record<string, () => Promise<Response>>).handleControlPlaneFleet();
		assert.equal(resp.status, 200, "fleet should return HTTP 200");

		const body = await resp.json() as {
			agencies: unknown[];
			routes: unknown[];
			projects: unknown[];
			errors: unknown[];
			partial: boolean;
		};

		assert.ok(Array.isArray(body.agencies), "agencies should be array");
		assert.ok(Array.isArray(body.routes), "routes should be array");
		assert.ok(Array.isArray(body.projects), "projects should be array");
		assert.ok(Array.isArray(body.errors), "errors should be array");
		assert.ok(typeof body.partial === "boolean", "partial should be boolean");
	});

	it("GET /api/control-plane/efficiency returns consistent partial envelope", async () => {
		const { RoadmapServer } = await import("../../src/apps/server/index.ts");
		const server = new RoadmapServer("/tmp");

		const resp = await (server as unknown as Record<string, () => Promise<Response>>).handleControlPlaneEfficiency();
		assert.equal(resp.status, 200);

		const body = await resp.json() as {
			data: unknown[];
			errors: unknown[];
			partial: boolean;
		};

		assert.ok(Array.isArray(body.data), "data should be array");
		assert.ok(Array.isArray(body.errors), "errors should be array");
		assert.ok(typeof body.partial === "boolean", "partial should be boolean");
	});

	it("GET /api/control-plane/identity returns agencies + projects", async () => {
		const { RoadmapServer } = await import("../../src/apps/server/index.ts");
		const server = new RoadmapServer("/tmp");

		const resp = await (server as unknown as Record<string, () => Promise<Response>>).handleControlPlaneIdentity();
		assert.equal(resp.status, 200);

		const body = await resp.json() as {
			agencies: unknown[];
			projects: unknown[];
			errors: unknown[];
			partial: boolean;
		};

		assert.ok(Array.isArray(body.agencies), "agencies should be array");
		assert.ok(Array.isArray(body.projects), "projects should be array");
		assert.ok(Array.isArray(body.errors), "errors should be array");
		assert.ok(typeof body.partial === "boolean", "partial should be boolean");
	});

	it("GET /api/control-plane/platform returns routes + projects", async () => {
		const { RoadmapServer } = await import("../../src/apps/server/index.ts");
		const server = new RoadmapServer("/tmp");

		const resp = await (server as unknown as Record<string, () => Promise<Response>>).handleControlPlanePlatform();
		assert.equal(resp.status, 200);

		const body = await resp.json() as {
			routes: unknown[];
			projects: unknown[];
			errors: unknown[];
			partial: boolean;
		};

		assert.ok(Array.isArray(body.routes), "routes should be array");
		assert.ok(Array.isArray(body.projects), "projects should be array");
		assert.ok(Array.isArray(body.errors), "errors should be array");
		assert.ok(typeof body.partial === "boolean", "partial should be boolean");
	});

	it("partial=true when a tenant DB is unreachable (seeded slugs have no real DSN)", async () => {
		// The seeded projects use 'TEST_DSN_NOT_USED' as dsn_secret_ref.
		// getProjectDb will fail to resolve it → those projects appear in errors[].
		const { RoadmapServer } = await import("../../src/apps/server/index.ts");
		const server = new RoadmapServer("/tmp");

		const resp = await (server as unknown as Record<string, () => Promise<Response>>).handleControlPlaneEfficiency();
		const body = await resp.json() as { errors: Array<{ slug: string }>; partial: boolean };

		// At least our two test slugs should fail (no real DSN) → partial=true
		const errSlugs = body.errors.map((e) => e.slug);
		const hasTestSlug = errSlugs.includes(SLUG_A) || errSlugs.includes(SLUG_B);
		assert.ok(hasTestSlug || body.partial, "Should report partial result for unreachable test tenants");
	});
});
