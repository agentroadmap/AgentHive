/**
 * P1456 AC-11: Per-CLI session adapter contract.
 *
 * Defines a shared core (inbox read + context injection) plus a thin CLI-specific
 * config mapping so that Claude Code, Codex, and Gemini all hook into the same
 * session-instance messaging path without duplicating logic.
 *
 * ─── Three-layer identity stack ──────────────────────────────────────────────
 *   Principal        user/gary
 *   Standing agency  claude-bot-gary.a        (dispatch-eligible)
 *   Session instance claude-bot-gary.a/session/<sid>   (addressable, non-dispatchable)
 *
 * ─── Hook slots (per CLI) ────────────────────────────────────────────────────
 *   ambient-receive  Before each human turn: read unread DMs and prepend them
 *                    to the next turn's context (AC-8).
 *   solicited-wake   After the AI completes a turn: poll the inbox for a reply
 *                    and optionally force-continue (AC-9).
 *
 * ─── Wake boundary (AC-10) ───────────────────────────────────────────────────
 *   msg_send() DOES NOT wake a session that is blocked on stdin.
 *   pg_notify fires immediately on the `msg_<identity>` channel, but only
 *   processes actively LISTENing on that channel will receive it (i.e. sessions
 *   running inside their solicited-wake hook).  Sessions parked waiting for the
 *   next human turn are NOT on the LISTEN loop.
 *   Uniform fallback for unsolicited cold wake = the standing liaison lane
 *   (claude-bot-gary.a), which the orchestrator can dispatch to at any time.
 */

// ─── Shared inbox core ───────────────────────────────────────────────────────

export interface InboxReadResult {
    /** Messages read from the inbox, oldest-first. Empty if none. */
    messages: Array<{
        id: number;
        fromAgent: string;
        body: string;
        sentAt: Date;
        correlationId?: string;
    }>;
}

/**
 * AC-8 core: read unread messages for `sessionIdentity` and return them
 * formatted for context injection.
 *
 * Callers (hook scripts or CLI boot code) call this, then prepend the
 * formatted block to the next user turn.
 */
export async function readAmbientMessages(
    sessionIdentity: string,
    limit = 10,
): Promise<InboxReadResult> {
    // Deferred import keeps the adapter importable without a live DB in tests.
    const { query } = await import("../postgres/pool.js");
    const { rows } = await query<{
        id: number;
        from_agent: string;
        body: string;
        sent_at: Date;
        correlation_id: string | null;
    }>(
        `SELECT id, from_agent, body, sent_at, correlation_id
           FROM roadmap.a2a_messages
          WHERE to_agent  = $1
            AND read_at   IS NULL
          ORDER BY sent_at ASC
          LIMIT  $2`,
        [sessionIdentity, limit],
    );

    return {
        messages: rows.map((r) => ({
            id: r.id,
            fromAgent: r.from_agent,
            body: r.body,
            sentAt: r.sent_at,
            correlationId: r.correlation_id ?? undefined,
        })),
    };
}

/**
 * Format unread messages for injection into a CLI turn context block.
 * Returns empty string if there are no messages.
 */
export function formatInboxBlock(result: InboxReadResult): string {
    if (result.messages.length === 0) return "";
    const lines = result.messages.map(
        (m) =>
            `[A2A DM from ${m.fromAgent} at ${m.sentAt.toISOString()}]\n${m.body}`,
    );
    return `\n--- Unread A2A messages (${result.messages.length}) ---\n${lines.join("\n---\n")}\n---\n`;
}

// ─── Per-CLI adapter configs ─────────────────────────────────────────────────

/**
 * CLI kinds supported by P1456 session-instance identities.
 * Add new entries here to extend to additional CLIs.
 */
export type CliKind = "claude-code" | "codex" | "gemini";

export interface CliAdapterConfig {
    /** CLI kind identifier stored in agent_registry.agent_cli. */
    cliKind: CliKind;
    /**
     * AC-8 hook event name (ambient-receive).
     * Claude Code: "UserPromptSubmit"
     * Codex: "UserPromptSubmit"
     * Gemini: "input_received" (conceptual — verify with Gemini CLI docs)
     */
    ambientReceiveHookEvent: string;
    /**
     * AC-9 hook event name (solicited-wake).
     * Claude Code: "Stop"
     * Codex: "AfterAgent" / "ExitAgent"
     * Gemini: "turn_complete" (conceptual)
     */
    solicitedWakeHookEvent: string;
    /**
     * How the hook injects the inbox block into the next turn.
     * "stdin-prepend" — prepend to the next user message content (Claude Code/Codex)
     * "file-inject"   — write to a temp file and the CLI reads it (not yet implemented)
     */
    injectionMode: "stdin-prepend" | "file-inject";
    /**
     * Milliseconds to wait for a solicited reply before giving up (AC-9).
     * Default: 30 000 ms.
     */
    solicitedWaitMs?: number;
}

/** Registered per-CLI adapter configurations. */
export const CLI_ADAPTER_CONFIGS: Record<CliKind, CliAdapterConfig> = {
    "claude-code": {
        cliKind: "claude-code",
        ambientReceiveHookEvent: "UserPromptSubmit",
        solicitedWakeHookEvent: "Stop",
        injectionMode: "stdin-prepend",
        solicitedWaitMs: 30_000,
    },
    codex: {
        cliKind: "codex",
        ambientReceiveHookEvent: "UserPromptSubmit",
        solicitedWakeHookEvent: "AfterAgent",
        injectionMode: "stdin-prepend",
        solicitedWaitMs: 30_000,
    },
    gemini: {
        cliKind: "gemini",
        ambientReceiveHookEvent: "input_received",
        solicitedWakeHookEvent: "turn_complete",
        injectionMode: "stdin-prepend",
        solicitedWaitMs: 30_000,
    },
};

export function getAdapterConfig(cliKind: CliKind): CliAdapterConfig {
    const cfg = CLI_ADAPTER_CONFIGS[cliKind];
    if (!cfg) {
        throw new Error(
            `Unknown CLI kind '${cliKind}'. Supported: ${Object.keys(CLI_ADAPTER_CONFIGS).join(", ")}`,
        );
    }
    return cfg;
}
