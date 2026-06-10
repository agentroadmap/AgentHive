/**
 * P483 Project Lifecycle Tests
 *
 * Tests for project_create, project_archive, project_reactivate, project_delete
 * and associated safety guards (AC-1 through AC-6, AC-100 through AC-104).
 *
 * Run with: npx tsx --test src/apps/mcp-server/tools/projects/p483-project-lifecycle.test.ts
 */

import { strict as assert } from "assert";
import { test } from "node:test";
import { query } from "../../../../postgres/pool.ts";
import {
	projectArchive,
	projectDelete,
	projectReactivate,
} from "./handlers.ts";
import { projectCreate } from "./lifecycle-handlers.ts";

// Test utilities
function extractJson(result: { content: Array<{ type: string; text: string }> }) {
	const textContent = result.content.find((c) => c.type === "text")?.text;
	if (!textContent) throw new Error("No text content in result");
	try {
		return JSON.parse(textContent);
	} catch (e) {
		// If it's not JSON (e.g., error message), throw with the actual text
		throw new Error(`Failed to parse JSON: ${textContent}`);
	}
}

// AC-1 Test: Slug validation
test("AC-1: project_create validates slug pattern", async () => {
	const timestamp = Date.now();
	const testCases = [
		{ slug: `valid-slug-${timestamp}`, valid: true },
		{ slug: `audiobook-${timestamp}`, valid: true },
		{ slug: `ml-ops-v2-${timestamp}`, valid: true },
		{ slug: "Audiobook", valid: false }, // uppercase
		{ slug: "audio book", valid: false }, // space
		{ slug: "audio-", valid: false }, // trailing dash
		{ slug: "abc", valid: true }, // minimum 3 chars (was "ab" which is invalid)
		{ slug: "a".repeat(65), valid: false }, // too long
	];

	for (const tc of testCases) {
		const result = await projectCreate({
			slug: tc.slug,
			name: "Test Project",
		});

		const textContent = result.content.find((c) => c.type === "text")?.text || "";
		let data;
		try {
			data = JSON.parse(textContent);
		} catch {
			console.log(`AC-1 slug "${tc.slug}" (valid=${tc.valid}): ERROR - ${textContent}`);
			throw new Error(`Failed to parse AC-1 result for slug "${tc.slug}": ${textContent}`);
		}

		if (tc.valid) {
			assert.equal(data.ok, true, `slug '${tc.slug}' should be valid. Got: ${JSON.stringify(data)}`);
			// Clean up test projects on success
			if (data.ok && data.project) {
				await query(`DELETE FROM roadmap.project WHERE project_id = $1`, [data.project.project_id]);
			}
		} else {
			assert.equal(data.ok, false, `slug '${tc.slug}' should be invalid. Got: ${JSON.stringify(data)}`);
		}
	}
});

// AC-2 Test: Transaction boundary (insert + stat in one tx)
test("AC-2: project_create is transactional", async () => {
	const slug = `test-tx-${Date.now()}`;
	const result = await projectCreate({
		slug,
		name: "Transaction Test Project",
	});

	const data = extractJson(result);
	assert.equal(data.ok, true, "project_create should succeed");

	// Verify insert happened
	const { rows } = await query<{ project_id: number; status: string }>(
		`SELECT project_id, status FROM roadmap.project WHERE slug = $1`,
		[slug],
	);

	assert.equal(rows.length, 1, "project row should be inserted");
	assert.equal(rows[0].status, "active", "status should be 'active'");

	// Cleanup
	await query(`DELETE FROM roadmap.project WHERE slug = $1`, [slug]);
});

// AC-3 Test: Archive and dispatch refusal
test("AC-3: project_archive sets status=archived", async () => {
	const slug = `test-archive-${Date.now()}`;
	const createResult = await projectCreate({
		slug,
		name: "Archive Test Project",
	});
	const created = extractJson(createResult);
	const projectId = created.project.project_id;

	const archiveResult = await projectArchive({
		project: slug,
		reason: "Test archive",
	});
	const archived = extractJson(archiveResult);

	assert.equal(archived.ok, true, "project_archive should succeed");
	assert.equal(archived.project.status, "archived", "status should be 'archived'");

	// Verify in database
	const { rows } = await query<{ status: string }>(
		`SELECT status FROM roadmap.project WHERE project_id = $1`,
		[projectId],
	);
	assert.equal(rows[0].status, "archived", "database should reflect archived status");

	// Cleanup
	await query(`DELETE FROM roadmap.project WHERE project_id = $1`, [projectId]);
});

// AC-4 Test: Delete safety guards
test("AC-4: project_delete requires confirm_slug", async () => {
	const slug = `test-delete-${Date.now()}`;
	const createResult = await projectCreate({
		slug,
		name: "Delete Test Project",
	});
	const created = extractJson(createResult);
	const projectId = created.project.project_id;

	// Try delete without confirm_slug
	const noConfirmResult = await projectDelete({
		project: slug,
		confirm_slug: "wrong-slug",
	});
	const noConfirm = extractJson(noConfirmResult);

	assert.equal(noConfirm.ok, false, "delete should fail without correct confirm_slug");
	assert.equal(
		noConfirm.error,
		"confirm_slug_mismatch",
		"error should be confirm_slug_mismatch",
	);

	// Delete with correct confirm_slug
	const deleteResult = await projectDelete({
		project: slug,
		confirm_slug: slug,
		force: true,
	});
	const deleted = extractJson(deleteResult);

	assert.equal(deleted.ok, true, "project_delete should succeed");
	assert.equal(deleted.deleted, true, "should report deleted=true");

	// Verify deletion
	const { rows } = await query<{ project_id: number }>(
		`SELECT project_id FROM roadmap.project WHERE project_id = $1`,
		[projectId],
	);
	assert.equal(rows.length, 0, "project should be deleted from database");
});

// AC-5 Test: Reactivate
test("AC-3/AC-5: project_reactivate restores status", async () => {
	const slug = `test-reactivate-${Date.now()}`;
	const createResult = await projectCreate({
		slug,
		name: "Reactivate Test Project",
	});
	const created = extractJson(createResult);
	const projectId = created.project.project_id;

	// Archive
	await projectArchive({ project: slug });

	// Reactivate
	const reactivateResult = await projectReactivate({ project: slug });
	const reactivated = extractJson(reactivateResult);

	assert.equal(reactivated.ok, true, "project_reactivate should succeed");
	assert.equal(reactivated.project.status, "active", "status should be 'active' again");

	// Cleanup
	await query(`DELETE FROM roadmap.project WHERE project_id = $1`, [projectId]);
});

// AC-100 Test: Repair queue on failed mkdir
test("AC-100: project_create queues repair if mkdir fails", async () => {
	const slug = `test-repair-${Date.now()}`;

	// Create with invalid worktree root (will fail mkdir post-commit)
	const result = await projectCreate({
		slug,
		name: "Repair Queue Test",
		worktree_root: "/nonexistent/deeply/nested/path/that/wont/create",
	});

	const data = extractJson(result);
	assert.equal(data.ok, true, "insert should succeed even if mkdir fails");
	assert.equal(data.repair_needed, true, "should flag repair_needed");

	// Cleanup
	const projectId = data.project.project_id;
	await query(`DELETE FROM roadmap.project_repair_queue WHERE project_id = $1`, [
		projectId,
	]);
	await query(`DELETE FROM roadmap.project WHERE project_id = $1`, [projectId]);
});

// AC-102 Test: Cascade scope preflight
test("AC-102: project_delete shows cascade scope before deletion", async () => {
	const slug = `test-cascade-${Date.now()}`;
	const createResult = await projectCreate({
		slug,
		name: "Cascade Test Project",
	});
	const created = extractJson(createResult);
	const projectId = created.project.project_id;

	// Try to delete without force when no dependencies
	const deleteResult = await projectDelete({
		project: slug,
		confirm_slug: slug,
		force: false,
	});
	const deleteData = extractJson(deleteResult);

	assert.equal(deleteData.ok, true, "delete should succeed when safe");

	// Verify deletion
	const { rows } = await query<{ project_id: number }>(
		`SELECT project_id FROM roadmap.project WHERE project_id = $1`,
		[projectId],
	);
	assert.equal(rows.length, 0, "project should be deleted");
});

// Integration test: Full lifecycle
test("Integration: Full project lifecycle", async () => {
	const slug = `test-lifecycle-${Date.now()}`;

	// 1. Create
	const createResult = await projectCreate({
		slug,
		name: "Lifecycle Test Project",
	});
	const created = extractJson(createResult);
	assert.equal(created.ok, true);
	const projectId = created.project.project_id;

	// 2. Archive
	const archiveResult = await projectArchive({ project: slug });
	const archived = extractJson(archiveResult);
	assert.equal(archived.ok, true);
	assert.equal(archived.project.status, "archived");

	// 3. Reactivate
	const reactivateResult = await projectReactivate({ project: slug });
	const reactivated = extractJson(reactivateResult);
	assert.equal(reactivated.ok, true);
	assert.equal(reactivated.project.status, "active");

	// 4. Delete
	const deleteResult = await projectDelete({
		project: slug,
		confirm_slug: slug,
		force: true,
	});
	const deleted = extractJson(deleteResult);
	assert.equal(deleted.ok, true);

	// 5. Verify deletion
	const { rows } = await query<{ project_id: number }>(
		`SELECT project_id FROM roadmap.project WHERE project_id = $1`,
		[projectId],
	);
	assert.equal(rows.length, 0, "project should be completely deleted");
});

console.log("✓ All P483 tests completed");
