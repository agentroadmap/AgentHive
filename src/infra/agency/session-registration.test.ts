/**
 * P1456: Session-registration unit tests
 *
 * AC-12: channel alignment — agentNotifyChannel() used exclusively;
 *        no a2a_msg_ prefix in LISTEN/NOTIFY constructors.
 * AC-18: 63-byte channel-limit rejection at registration time.
 *
 * These are pure-logic tests that do NOT require a live DB connection.
 * The channel tests assert static code properties via grep/import.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { agentNotifyChannel } from "../messaging/a2a-access-control.ts";
import { shortSessionId, registerSession } from "./session-registration.ts";

// ─── AC-12: channel alignment ────────────────────────────────────────────────

const SRC_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../../..");

function readSrc(rel: string): string {
    return readFileSync(resolve(SRC_ROOT, rel), "utf8");
}

test("AC-12: agentNotifyChannel produces msg_ prefix", () => {
    assert.equal(agentNotifyChannel("operator"), "msg_operator");
    assert.equal(agentNotifyChannel("claude-bot-gary.a/session/7f3a2c"), "msg_claude-bot-gary.a/session/7f3a2c");
});

test("AC-12: msg-wait-reply.ts uses agentNotifyChannel — no raw a2a_msg_ in LISTEN", () => {
    const src = readSrc("src/apps/mcp-server/tools/messages/msg-wait-reply.ts");
    // Must import agentNotifyChannel
    assert.ok(
        src.includes("agentNotifyChannel"),
        "msg-wait-reply.ts must import and use agentNotifyChannel",
    );
    // Must NOT have raw a2a_msg_ string literal in a LISTEN/NOTIFY context
    const listenMatches = src.match(/`(LISTEN|NOTIFY).*a2a_msg_/g) ?? [];
    assert.equal(listenMatches.length, 0, `raw a2a_msg_ found in LISTEN/NOTIFY: ${listenMatches.join(", ")}`);
});

test("AC-12: msg-reply.ts uses agentNotifyChannel — no raw a2a_msg_ in pg_notify call", () => {
    const src = readSrc("src/apps/mcp-server/tools/messages/msg-reply.ts");
    assert.ok(src.includes("agentNotifyChannel"), "msg-reply.ts must use agentNotifyChannel");
    const notifyMatches = src.match(/pg_notify.*a2a_msg_/g) ?? [];
    assert.equal(notifyMatches.length, 0, `raw a2a_msg_ in pg_notify: ${notifyMatches.join(", ")}`);
});

test("AC-12: agent-liveness.ts uses agentNotifyChannel for pg_stat_activity probe", () => {
    const src = readSrc("src/core/orchestration/probes/agent-liveness.ts");
    assert.ok(src.includes("agentNotifyChannel"), "agent-liveness.ts must use agentNotifyChannel");
    // Should not have the literal old-style LISTEN query
    assert.ok(
        !src.includes('LISTEN "a2a_msg_'),
        'agent-liveness.ts must not hardcode LISTEN "a2a_msg_"',
    );
});

test("AC-12: liaison-message-service.ts uses agentNotifyChannel — LISTEN_CHANNEL_PREFIX removed", () => {
    const src = readSrc("src/infra/agency/liaison-message-service.ts");
    assert.ok(src.includes("agentNotifyChannel"), "liaison-message-service.ts must use agentNotifyChannel");
    assert.ok(
        !src.includes('LISTEN_CHANNEL_PREFIX'),
        "LISTEN_CHANNEL_PREFIX constant must be removed from liaison-message-service.ts",
    );
});

test("AC-12: server/index.ts uses agentNotifyChannel for operator notify — no raw a2a_msg_operator", () => {
    const src = readSrc("src/apps/server/index.ts");
    assert.ok(src.includes("agentNotifyChannel"), "server/index.ts must import agentNotifyChannel");
    assert.ok(
        !src.includes('"a2a_msg_operator"'),
        'server/index.ts must not reference "a2a_msg_operator" literally',
    );
});

test("AC-12: cli.ts uses agentNotifyChannel for reply wait LISTEN", () => {
    const src = readSrc("src/apps/cli.ts");
    assert.ok(src.includes("agentNotifyChannel"), "cli.ts must use agentNotifyChannel");
    assert.ok(
        !src.includes("`a2a_msg_${fromAgent}`"),
        "cli.ts must not construct a2a_msg_ channel manually",
    );
});

// ─── AC-18: 63-byte channel-limit rejection ──────────────────────────────────

test("AC-18: agentNotifyChannel rejects identity that exceeds 63-byte channel limit", () => {
    // 'msg_' = 4 bytes, so identity can be at most 59 bytes before channel overflows 63
    const longIdentity = "x".repeat(60); // 60 bytes → channel = 64 bytes → must throw
    assert.throws(
        () => agentNotifyChannel(longIdentity),
        /exceeds.*63/,
        "agentNotifyChannel must throw when channel exceeds 63 bytes",
    );
});

test("AC-18: agentNotifyChannel accepts identity exactly at the 59-byte limit", () => {
    const maxIdentity = "a".repeat(59); // 59 bytes → channel = 63 bytes → must NOT throw
    assert.doesNotThrow(() => agentNotifyChannel(maxIdentity));
});

test("AC-18: registerSession rejects session identity that would overflow channel", async () => {
    // Construct an identity that passes agentNotifyChannel's character check
    // but whose channel exceeds 63 bytes
    const longSessionId = "a".repeat(56); // 56 chars → 'msg_' + 56 = 60 bytes — actually OK
    // Use 60 chars to get 64 bytes
    const tooLong = "a".repeat(60);
    await assert.rejects(
        () =>
            registerSession({
                sessionIdentity: tooLong,
                standingAgencyIdentity: "claude-bot-gary.a",
                cliKind: "claude-code",
            }),
        /channel.*63|63.*byte|exceeds/,
        "registerSession must reject identities that overflow the pg channel limit",
    );
});

// ─── shortSessionId helper ──────────────────────────────────────────────────

test("shortSessionId truncates hex uuid to 12 chars", () => {
    const id = shortSessionId("a1b2c3d4e5f6a1b2c3d4e5f6");
    assert.equal(id.length, 12);
    assert.match(id, /^[0-9a-f]{12}$/);
});

test("shortSessionId handles non-hex transcript path", () => {
    const id = shortSessionId("/Users/gary/.claude/projects/foo-bar/session-abc123.jsonl");
    assert.ok(id.length <= 12);
    assert.match(id, /^[a-z0-9]+$/);
});
