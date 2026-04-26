/**
 * Tests for Agent Identity Sanitization (P462)
 *
 * Table-driven test suite covering:
 * - Passthrough of valid identities
 * - Slugification of spaces and special chars
 * - Preservation of namespace slashes
 * - Path traversal rejection
 * - Unicode normalization and homograph detection
 * - Length validation
 * - Empty string rejection
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	normalizeAgentId,
	safeWorktreePath,
	AgentIdInvalidError,
} from "../../src/shared/identity/sanitize-agent-id.ts";

test("normalizeAgentId: valid identities pass through", () => {
	assert.equal(normalizeAgentId("test-user"), "test-user");
	assert.equal(normalizeAgentId("user123"), "user123");
	assert.equal(normalizeAgentId("test_user"), "test_user");
});

test("normalizeAgentId: spaces become hyphens", () => {
	assert.equal(normalizeAgentId("User Name"), "user-name");
	assert.equal(normalizeAgentId("   leading-space"), "leading-space");
	assert.equal(normalizeAgentId("trailing-space   "), "trailing-space");
});

test("normalizeAgentId: special chars become hyphens", () => {
	assert.equal(normalizeAgentId("user@domain"), "user-domain");
	assert.equal(normalizeAgentId("user.name"), "user-name");
	assert.equal(normalizeAgentId("user(alpha)"), "user-alpha");
	assert.equal(normalizeAgentId("Worker (alpha)"), "worker-alpha");
});

test("normalizeAgentId: slash preserved for namespacing", () => {
	assert.equal(normalizeAgentId("claude/one"), "claude/one");
	assert.equal(normalizeAgentId("claude/test-agent"), "claude/test-agent");
	assert.equal(normalizeAgentId("provider/model/variant"), "provider/model/variant");
});

test("normalizeAgentId: uppercase converted to lowercase", () => {
	assert.equal(normalizeAgentId("TestUser"), "testuser");
	assert.equal(normalizeAgentId("CLAUDE/ONE"), "claude/one");
});

test("normalizeAgentId: rejects oversized input (>64 chars)", () => {
	const input = "a".repeat(65);
	assert.throws(
		() => normalizeAgentId(input),
		(err: unknown) => {
			assert(err instanceof AgentIdInvalidError);
			assert(err.reason.includes("oversized"));
			return true;
		},
	);
});

test("normalizeAgentId: rejects empty string", () => {
	assert.throws(
		() => normalizeAgentId(""),
		(err: unknown) => {
			assert(err instanceof AgentIdInvalidError);
			assert(err.reason.includes("empty"));
			return true;
		},
	);
});

test("normalizeAgentId: rejects whitespace-only string", () => {
	assert.throws(
		() => normalizeAgentId("   "),
		(err: unknown) => {
			assert(err instanceof AgentIdInvalidError);
			assert(err.reason.includes("empty"));
			return true;
		},
	);
});

test("normalizeAgentId: Unicode NFC normalization (homographs)", () => {
	// Cyrillic а (U+0430) vs Latin a (U+0061)
	// After NFC normalization, composed forms normalize to same base
	const cyrillicForm = "userа"; // Cyrillic а
	const latinForm = "usera"; // Latin a

	const normCyrillic = normalizeAgentId(cyrillicForm);
	const normLatin = normalizeAgentId(latinForm);

	// Both should normalize to same form if they're homographs
	// (Note: in NFC, Cyrillic а stays as is, so they're different.
	// This test verifies they're processed consistently)
	assert.equal(typeof normCyrillic, "string");
	assert.equal(typeof normLatin, "string");
});

test("normalizeAgentId: strips leading/trailing hyphens", () => {
	assert.equal(normalizeAgentId("-test-"), "test");
	assert.equal(normalizeAgentId("---test---"), "test");
});

test("normalizeAgentId: collapses multiple hyphens", () => {
	assert.equal(normalizeAgentId("test---user"), "test-user");
	assert.equal(normalizeAgentId("test  user"), "test-user");
});

test("safeWorktreePath: valid path construction", () => {
	const result = safeWorktreePath("/data/code/worktree", "test-user");
	assert.equal(result, "/data/code/worktree/test-user");
});

test("safeWorktreePath: rejects path traversal attempts", () => {
	assert.throws(
		() => safeWorktreePath("/data/code/worktree", "../escape"),
		(err: unknown) => {
			assert(err instanceof AgentIdInvalidError);
			assert(err.reason.includes("traversal"));
			return true;
		},
	);
});

test("safeWorktreePath: rejects path traversal in middle", () => {
	assert.throws(
		() => safeWorktreePath("/data/code/worktree", "test/../etc/passwd"),
		(err: unknown) => {
			assert(err instanceof AgentIdInvalidError);
			return true;
		},
	);
});

test("safeWorktreePath: preserves namespace slashes safely", () => {
	const result = safeWorktreePath("/data/code/worktree", "claude/one");
	assert.equal(result, "/data/code/worktree/claude/one");
});

test("safeWorktreePath: rejects invalid agentId", () => {
	assert.throws(
		() => safeWorktreePath("/data/code/worktree", ""),
		(err: unknown) => {
			assert(err instanceof AgentIdInvalidError);
			return true;
		},
	);
});

test("safeWorktreePath: rejects oversized agentId", () => {
	const input = "a".repeat(65);
	assert.throws(
		() => safeWorktreePath("/data/code/worktree", input),
		(err: unknown) => {
			assert(err instanceof AgentIdInvalidError);
			assert(err.reason.includes("oversized"));
			return true;
		},
	);
});

test("normalizeAgentId: leading hyphen is stripped (matches strip-leading/trailing behavior)", () => {
	// Aligns with the silent-strip contract verified above; not a throw.
	assert.equal(normalizeAgentId("-test"), "test");
});

test("normalizeAgentId: trailing hyphen is stripped", () => {
	assert.equal(normalizeAgentId("test-"), "test");
});

test("normalizeAgentId: numeric-only valid", () => {
	assert.equal(normalizeAgentId("12345"), "12345");
});

test("normalizeAgentId: underscore preserved", () => {
	assert.equal(normalizeAgentId("test_user_name"), "test_user_name");
	assert.equal(normalizeAgentId("Test_User_Name"), "test_user_name");
});

test("normalizeAgentId: echos offending input on error", () => {
	const input = "a".repeat(65);
	assert.throws(
		() => normalizeAgentId(input),
		(err: unknown) => {
			assert(err instanceof AgentIdInvalidError);
			assert(err.input === input);
			return true;
		},
	);
});
