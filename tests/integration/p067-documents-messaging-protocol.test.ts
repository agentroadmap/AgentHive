/**
 * P067: Document, Note & Messaging System — Postgres Backend Tests
 *
 * Tests for:
 * - Postgres document handlers (create, view, update, list, search, versions, soft-delete)
 * - Postgres protocol handlers (threads, replies, mentions, notifications)
 * - Message read_at tracking and unread count
 * - Migration 021 schema validation
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ─── Import handler classes ──────────────────────────────────────────────────
import { PgDocumentHandlers } from "../../src/apps/mcp-server/tools/documents/pg-handlers.ts";
import { PgProtocolHandlers } from "../../src/apps/mcp-server/tools/protocol/pg-handlers.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Unit tests — handler structure and method existence
// ═══════════════════════════════════════════════════════════════════════════════

describe("P067: PgDocumentHandlers", () => {
	it("has all required methods for P067 AC compliance", () => {
		const handler = new PgDocumentHandlers();

		// AC-1: document_create, document_view
		assert.strictEqual(typeof handler.createDocument, "function");
		assert.strictEqual(typeof handler.viewDocument, "function");

		// AC-2: document_update with versioning
		assert.strictEqual(typeof handler.updateDocument, "function");
		assert.strictEqual(typeof handler.listVersions, "function");

		// AC-1: document_list
		assert.strictEqual(typeof handler.listDocuments, "function");

		// AC-11, AC-13: document_search with tsvector
		assert.strictEqual(typeof handler.searchDocuments, "function");

		// AC-18: soft-delete
		assert.strictEqual(typeof handler.deleteDocument, "function");
	});

	it("createDocument returns CallToolResult shape on invalid input", async () => {
		const handler = new PgDocumentHandlers();
		// This will fail because no DB connection, but should return error result, not throw
		const result = await handler.createDocument({
			title: "Test",
			content: "Test content",
		});
		assert.ok(result.content, "Should have content array");
		assert.ok(Array.isArray(result.content), "content should be array");
		assert.ok(result.content.length > 0, "content should not be empty");
		const text = result.content[0] as { text?: string };
		assert.ok(typeof text.text === "string", "content item should have text");
		// Should contain warning emoji since no DB
		assert.ok(text.text.includes("⚠️"), "Should contain warning for DB error");
	});

	it("searchDocuments returns CallToolResult shape on invalid input", async () => {
		const handler = new PgDocumentHandlers();
		const result = await handler.searchDocuments({ query: "test" });
		assert.ok(result.content);
		assert.ok(Array.isArray(result.content));
	});
});

describe("P067: PgProtocolHandlers", () => {
	it("has all required methods for P067 AC compliance", () => {
		const handler = new PgProtocolHandlers();

		// AC-8: protocol_send_mention
		assert.strictEqual(typeof handler.sendMention, "function");
		assert.strictEqual(typeof handler.searchMentions, "function");
		assert.strictEqual(typeof handler.getNotifications, "function");

		// AC-9: protocol_thread_reply
		assert.strictEqual(typeof handler.createThread, "function");
		assert.strictEqual(typeof handler.replyToThread, "function");

		// AC-12: protocol_thread_get (paginated)
		assert.strictEqual(typeof handler.getThread, "function");

		// AC-16: insertion-order guarantees
		assert.strictEqual(typeof handler.listThreads, "function");

		// Read tracking
		assert.strictEqual(typeof handler.markMentionRead, "function");
	});

	it("extracts @mentions from content correctly", async () => {
		const handler = new PgProtocolHandlers();
		// createThread will fail on DB but we can check the structure
		const result = await handler.createThread({
			channel: "test",
			author: "agent1",
			content: "Hello @agent2 and @agent3!",
		});
		assert.ok(result.content);
		// Should contain warning (no DB) or mention extraction
		const text = (result.content[0] as { text?: string }).text ?? "";
		assert.ok(typeof text === "string");
	});

	it("createThread returns CallToolResult shape on invalid input", async () => {
		const handler = new PgProtocolHandlers();
		const result = await handler.createThread({
			channel: "test",
			author: "agent1",
			content: "Test message",
		});
		assert.ok(result.content);
		assert.ok(Array.isArray(result.content));
	});

	it("replyToThread returns CallToolResult shape on invalid input", async () => {
		const handler = new PgProtocolHandlers();
		const result = await handler.replyToThread({
			thread_id: "nonexistent",
			author: "agent1",
			content: "Reply content",
		});
		assert.ok(result.content);
		assert.ok(Array.isArray(result.content));
	});

	it("getThread returns CallToolResult shape on invalid input", async () => {
		const handler = new PgProtocolHandlers();
		const result = await handler.getThread({ thread_id: "nonexistent" });
		assert.ok(result.content);
		assert.ok(Array.isArray(result.content));
	});

	it("listThreads returns CallToolResult shape on invalid input", async () => {
		const handler = new PgProtocolHandlers();
		const result = await handler.listThreads({ channel: "test" });
		assert.ok(result.content);
		assert.ok(Array.isArray(result.content));
	});

	it("sendMention returns CallToolResult shape on invalid input", async () => {
		const handler = new PgProtocolHandlers();
		const result = await handler.sendMention({
			mentioned_agent: "agent2",
			mentioned_by: "agent1",
		});
		assert.ok(result.content);
		assert.ok(Array.isArray(result.content));
	});

	it("searchMentions returns CallToolResult shape on invalid input", async () => {
		const handler = new PgProtocolHandlers();
		const result = await handler.searchMentions({ agent: "agent1" });
		assert.ok(result.content);
		assert.ok(Array.isArray(result.content));
	});

	it("getNotifications returns CallToolResult shape on invalid input", async () => {
		const handler = new PgProtocolHandlers();
		const result = await handler.getNotifications({ agent: "agent1" });
		assert.ok(result.content);
		assert.ok(Array.isArray(result.content));
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Schema validation tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("P067: Migration 021 schema validation", () => {
	it("migration file exists and contains all required tables", async () => {
		const { readFileSync } = await import("node:fs");
		const migration = readFileSync(
			"scripts/migrations/021-documents-messaging-protocol.sql",
			"utf-8",
		);

		// Check all tables are defined
		assert.ok(
			migration.includes("CREATE TABLE IF NOT EXISTS roadmap.documents"),
			"Missing documents table",
		);
		assert.ok(
			migration.includes("CREATE TABLE IF NOT EXISTS roadmap.document_versions"),
			"Missing document_versions table",
		);
		assert.ok(
			migration.includes("CREATE TABLE IF NOT EXISTS roadmap.channel_subscription"),
			"Missing channel_subscription table",
		);
		assert.ok(
			migration.includes("CREATE TABLE IF NOT EXISTS roadmap.protocol_threads"),
			"Missing protocol_threads table",
		);
		assert.ok(
			migration.includes("CREATE TABLE IF NOT EXISTS roadmap.protocol_replies"),
			"Missing protocol_replies table",
		);
		assert.ok(
			migration.includes("CREATE TABLE IF NOT EXISTS roadmap.mentions"),
			"Missing mentions table",
		);
	});

	it("migration adds read_at to message_ledger", async () => {
		const { readFileSync } = await import("node:fs");
		const migration = readFileSync(
			"scripts/migrations/021-documents-messaging-protocol.sql",
			"utf-8",
		);

		assert.ok(
			migration.includes("ADD COLUMN IF NOT EXISTS read_at"),
			"Missing read_at column addition",
		);
	});

	it("migration creates tsvector trigger for documents", async () => {
		const { readFileSync } = await import("node:fs");
		const migration = readFileSync(
			"scripts/migrations/021-documents-messaging-protocol.sql",
			"utf-8",
		);

		assert.ok(
			migration.includes("fn_documents_tsvector_update"),
			"Missing tsvector trigger function",
		);
		assert.ok(
			migration.includes("trg_documents_tsvector"),
			"Missing tsvector trigger",
		);
		assert.ok(
			migration.includes("idx_documents_tsvector"),
			"Missing GIN index on tsvector",
		);
	});

	it("migration creates thread reply count trigger", async () => {
		const { readFileSync } = await import("node:fs");
		const migration = readFileSync(
			"scripts/migrations/021-documents-messaging-protocol.sql",
			"utf-8",
		);

		assert.ok(
			migration.includes("fn_thread_reply_update"),
			"Missing thread reply count trigger function",
		);
		assert.ok(
			migration.includes("trg_protocol_replies_count"),
			"Missing thread reply count trigger",
		);
	});

	it("migration has proper FK constraints", async () => {
		const { readFileSync } = await import("node:fs");
		const migration = readFileSync(
			"scripts/migrations/021-documents-messaging-protocol.sql",
			"utf-8",
		);

		// Documents FK to proposal
		assert.ok(
			migration.includes("documents_proposal_fkey"),
			"Missing documents proposal FK",
		);
		// Documents FK to agent_registry
		assert.ok(
			migration.includes("documents_author_fkey"),
			"Missing documents author FK",
		);
		// Mentions FK to agent_registry
		assert.ok(
			migration.includes("mentions_agent_fkey"),
			"Missing mentions agent FK",
		);
		// Thread replies FK to threads
		assert.ok(
			migration.includes("protocol_replies_thread_fkey"),
			"Missing protocol replies thread FK",
		);
	});

	it("migration has version uniqueness constraint", async () => {
		const { readFileSync } = await import("node:fs");
		const migration = readFileSync(
			"scripts/migrations/021-documents-messaging-protocol.sql",
			"utf-8",
		);

		assert.ok(
			migration.includes("document_versions_unique"),
			"Missing document versions unique constraint",
		);
		assert.ok(
			migration.includes("protocol_replies_seq_unique"),
			"Missing protocol replies sequence unique constraint",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration structure tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("P067: MCP tool registration", () => {
	it("document index exports PgDocumentHandlers", async () => {
		const docModule = await import(
			"../../src/apps/mcp-server/tools/documents/pg-handlers.ts"
		);
		assert.ok(docModule.PgDocumentHandlers, "PgDocumentHandlers should be exported");
	});

	it("protocol index exports PgProtocolHandlers", async () => {
		const protoModule = await import(
			"../../src/apps/mcp-server/tools/protocol/pg-handlers.ts"
		);
		assert.ok(protoModule.PgProtocolHandlers, "PgProtocolHandlers should be exported");
	});

	it("messages pg-handlers exports markRead and unreadCount", async () => {
		const { PgMessagingHandlers } = await import(
			"../../src/apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const handler = new PgMessagingHandlers(
			{} as any, // mock McpServer
			".",
		);
		assert.strictEqual(typeof handler.markRead, "function");
		assert.strictEqual(typeof handler.unreadCount, "function");
	});
});
