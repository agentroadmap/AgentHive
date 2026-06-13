/**
 * P1392: Unit tests for file-based persona resolver (Tier-1).
 *
 * Tests cover:
 * - Exact role name matching (role='software-architect' → 'engineering-software-architect.md')
 * - Case-insensitive matching ('Software Architect' → normalized)
 * - Suffix matching with category prefix stripping
 * - Cache TTL invalidation and mtime tracking
 * - Fallback to null when file not found
 * - File change detection via mtime
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createTestResolver, resolveFilePersona } from "../file-persona-resolver.ts";

const testDir = tmpdir();

test("FilePersonaResolver: exact match for 'software-architect'", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		const personaBody = "You are a software architect. Design systems carefully.";
		await writeFile(
			join(tempDir, "engineering-software-architect.md"),
			personaBody,
		);

		const resolver = createTestResolver(tempDir);
		const result = await resolver.resolve("software-architect");

		assert.equal(result?.source, "file");
		assert.equal(result?.body, personaBody);
		assert.equal(result?.personaName, "engineering-software-architect");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: case-insensitive matching", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		const personaBody = "You are a code reviewer. Review code carefully.";
		await writeFile(
			join(tempDir, "engineering-code-reviewer.md"),
			personaBody,
		);

		const resolver = createTestResolver(tempDir);

		// Test various case combinations
		const result1 = await resolver.resolve("code-reviewer");
		const result2 = await resolver.resolve("Code-Reviewer");
		const result3 = await resolver.resolve("CODE REVIEWER");

		assert.equal(result1?.body, personaBody);
		assert.equal(result2?.body, personaBody);
		assert.equal(result3?.body, personaBody);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: suffix match with category prefix", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		const personaBody = "You are a UI designer. Design interfaces beautifully.";
		await writeFile(
			join(tempDir, "design-ui-designer.md"),
			personaBody,
		);

		const resolver = createTestResolver(tempDir);
		const result = await resolver.resolve("ui-designer");

		assert.equal(result?.source, "file");
		assert.equal(result?.body, personaBody);
		assert.equal(result?.personaName, "design-ui-designer");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: graceful fallback to null when file not found", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		const resolver = createTestResolver(tempDir);
		const result = await resolver.resolve("nonexistent-role");

		assert.equal(result, null);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: cache TTL invalidation", async (t) => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		const personaPath = join(tempDir, "engineering-software-architect.md");
		const personaBody1 = "Version 1: Original architect persona.";
		const personaBody2 = "Version 2: Updated architect persona.";

		await writeFile(personaPath, personaBody1);

		// Use a very short TTL (100ms) so cache expires quickly
		const resolver = createTestResolver(tempDir, 100);

		// First read should cache the original body
		let result = await resolver.resolve("software-architect");
		assert.equal(result?.body, personaBody1);

		// Wait for cache to expire
		await new Promise((resolve) => setTimeout(resolve, 150));

		// Update the file
		await writeFile(personaPath, personaBody2);

		// Second read should get the new body from disk
		result = await resolver.resolve("software-architect");
		assert.equal(result?.body, personaBody2);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: cache invalidation on file mtime change", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		const personaPath = join(tempDir, "engineering-software-architect.md");
		const personaBody1 = "Original version.";
		const personaBody2 = "Updated version.";

		await writeFile(personaPath, personaBody1);

		// Use long TTL so we're testing mtime-based invalidation, not TTL
		const resolver = createTestResolver(tempDir, 60000);

		// First read should cache
		let result = await resolver.resolve("software-architect");
		assert.equal(result?.body, personaBody1);

		// Update the file (which changes mtime)
		await writeFile(personaPath, personaBody2);

		// Second read should detect mtime change and reload
		result = await resolver.resolve("software-architect");
		assert.equal(result?.body, personaBody2);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: multiple files and role variants", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		await writeFile(
			join(tempDir, "engineering-code-reviewer.md"),
			"Code reviewer persona.",
		);
		await writeFile(
			join(tempDir, "engineering-database-optimizer.md"),
			"Database optimizer persona.",
		);
		await writeFile(
			join(tempDir, "design-ui-designer.md"),
			"UI designer persona.",
		);

		const resolver = createTestResolver(tempDir);

		const cr = await resolver.resolve("code-reviewer");
		const db = await resolver.resolve("database-optimizer");
		const ui = await resolver.resolve("ui-designer");

		assert(cr?.body.includes("Code reviewer"));
		assert(db?.body.includes("Database optimizer"));
		assert(ui?.body.includes("UI designer"));
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: full file name as fallback key", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		await writeFile(
			join(tempDir, "engineering-code-reviewer.md"),
			"Code reviewer persona.",
		);

		const resolver = createTestResolver(tempDir);

		// Should match by full base name as well
		const result = await resolver.resolve("engineering-code-reviewer");

		assert.equal(result?.source, "file");
		assert.equal(result?.personaName, "engineering-code-reviewer");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: non-.md files ignored", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		await writeFile(
			join(tempDir, "engineering-software-architect.txt"),
			"Should be ignored - not .md",
		);
		await writeFile(
			join(tempDir, "software-architect.json"),
			'{"ignored": true}',
		);

		const resolver = createTestResolver(tempDir);
		const result = await resolver.resolve("software-architect");

		// Should not find .txt or .json files
		assert.equal(result, null);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("FilePersonaResolver: handles directories in persona dir", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		await writeFile(
			join(tempDir, "engineering-code-reviewer.md"),
			"Code reviewer persona.",
		);
		// Create a subdirectory (should be ignored)
		const subdir = join(tempDir, "subdir");
		await mkdir(subdir, { recursive: true });

		const resolver = createTestResolver(tempDir);
		const result = await resolver.resolve("code-reviewer");

		// Should still find the .md file despite the directory
		assert(result?.body.includes("Code reviewer"));
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

// Helper
function mkdir(path: string, opts: any) {
	return import("node:fs/promises").then((fs) => fs.mkdir(path, opts));
}

test("FilePersonaResolver: single-word suffix must NOT shadow generic roles", async () => {
	const tempDir = await mkdtemp(join(testDir, "p1392-test-"));
	try {
		// 'sales-engineer.md' must not register the bare key 'engineer' —
		// otherwise every generic 'engineer' dispatch gets a sales persona.
		await writeFile(join(tempDir, "sales-engineer.md"), "You are a SALES engineer.");
		const resolver = createTestResolver(tempDir);

		assert.equal(await resolver.resolve("engineer"), null, "bare 'engineer' must not match");
		const exact = await resolver.resolve("sales-engineer");
		assert.equal(exact?.source, "file", "full base name still matches");

		// Multi-word suffixes still work (the AC-1 case).
		await writeFile(join(tempDir, "engineering-software-architect.md"), "Architect persona.");
		const fresh = createTestResolver(tempDir);
		const suffix = await fresh.resolve("software-architect");
		assert.equal(suffix?.personaName, "engineering-software-architect");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
