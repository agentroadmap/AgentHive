import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { PgMessagingHandlers } from "./pg-handlers.ts";
import { DlqHandlers } from "./dlq-handlers.ts";
import { handleMsgAck } from "./msg-ack.ts";
import { handleMsgReply } from "./msg-reply.ts";
import { handleMsgWaitReply } from "./msg-wait-reply.ts";
import {
	spawnManifestCreate,
	agentCredentialClaim,
	agentCredentialDeliver,
	agentCredentialRetrieve,
} from "./credential-handlers.ts";
import {
	dlqList,
	dlqInspect,
	dlqReplay,
	dlqExpire,
	dlqStats,
	liaisonStuckMessages,
} from "./dlq-handlers.ts";

const msgMarkReadSchema: JsonSchema = {
	type: "object",
	properties: {
		message_id: {
			type: "number",
			description: "Message ID to mark as read",
		},
		agent: {
			type: "string",
			description: "Agent identity (recipient)",
		},
	},
	required: ["message_id", "agent"],
};

const msgUnreadCountSchema: JsonSchema = {
	type: "object",
	properties: {
		agent: {
			type: "string",
			description: "Agent identity to check unread count for",
		},
	},
	required: ["agent"],
};

export function registerMessageTools(server: McpServer): void {
	// P1105: Get operator HMAC secret for bearer token verification
	const operatorHmacSecret = (() => {
		const envSecret = process.env.OPERATOR_HMAC_SECRET;
		if (envSecret) {
			try {
				return Buffer.from(envSecret, "hex");
			} catch {
				console.warn("[P1105] OPERATOR_HMAC_SECRET is not valid hex; bearer verification disabled");
				return undefined;
			}
		}
		return undefined;
	})();

	const pgHandlers = new PgMessagingHandlers(server, process.cwd(), operatorHmacSecret);

	const sendTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_send",
			description:
				"Send a message to the Postgres message_ledger. ACL enforced on send (roadmap.message_acl); trust gate enforced for restricted/blocked senders. P1105 AC-27: user/* agents require a valid bearer token in the authorization parameter. NOTE: P834 HMAC dispatch-gate verification of `provider_sig` is DESIGNED but NOT ENFORCED today — the column is accepted and stored verbatim, sig_verified stays at default 'pending', and the 5-minute replay window is not checked. Do not rely on this surface for authentication; it is delivery-only. Tracking via P834 follow-up; see drift discussion on P834.",
			inputSchema: {
				type: "object",
				properties: {
					from_agent: { type: "string" },
					to_agent: { type: "string" },
					channel: { type: "string" },
					message_content: { type: "string" },
					message_type: {
						type: "string",
						enum: ["task", "notify", "ack", "error", "event", "text", "user_message"],
					},
					proposal_id: { type: "string" },
					correlation_id: { type: "string", description: "UUID for request/response tracking" },
					provider_sig: { type: "string" },
					created_at: { type: "string" },
					provider_sig_salt: { type: "string" },
					authorization: { type: "string", description: "Bearer token for user/* agents (P1105 AC-27)" },
					metadata: {
						type: "object",
						description: "Structured metadata persisted to message_ledger.metadata (jsonb). Read by downstream consumers — e.g. liaison-agent.bridgeTaskToOfferDispatch reads metadata.role, metadata.dispatch_role, metadata.worktree_hint, metadata.required_capabilities for offer-dispatch role overrides.",
						additionalProperties: true,
					},
				},
				required: ["from_agent", "message_content"],
			},
		},
		{
			type: "object",
			properties: {
				from_agent: { type: "string" },
				to_agent: { type: "string" },
				channel: { type: "string" },
				message_content: { type: "string" },
				message_type: { type: "string" },
				proposal_id: { type: "string" },
				correlation_id: { type: "string" },
				provider_sig: { type: "string" },
				created_at: { type: "string" },
				provider_sig_salt: { type: "string" },
				authorization: { type: "string" },
				metadata: { type: "object", additionalProperties: true },
			},
			required: ["from_agent", "message_content"],
		} as JsonSchema,
		async (input) =>
			pgHandlers.sendMessage(input as {
				from_agent: string;
				to_agent?: string;
				channel?: string;
				message_content: string;
				message_type?: string;
				proposal_id?: string;
				correlation_id?: string;
				provider_sig?: string;
				created_at?: string;
				provider_sig_salt?: string;
				metadata?: Record<string, unknown>;
			}),
	);

	const readTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_read",
			description:
				"Read messages from the Postgres message_ledger. With agent + wait_ms, blocks on pg_notify channel `msg_{agent}` (P1103 canonical channel) until a new message arrives or timeout expires. Trust-filtered: restricted/blocked senders are excluded.",
			inputSchema: {
				type: "object",
				properties: {
					agent: {
						type: "string",
						description: "Filter by agent identity (required for wait_ms blocking reads)",
					},
					channel: { type: "string", description: "Filter by channel name" },
					limit: { type: "number", description: "Max messages to return (default 50)" },
					wait_ms: {
						type: "number",
						description:
							"Block up to N ms waiting for a new DM via pg_notify (0–30000). Requires agent. Returns immediately if messages already exist.",
					},
				},
			},
		},
		{
			type: "object",
			properties: {
				agent: { type: "string" },
				channel: { type: "string" },
				limit: { type: "number" },
				wait_ms: { type: "number" },
			},
		} as JsonSchema,
		async (input) =>
			pgHandlers.readMessages(input as {
				agent?: string;
				channel?: string;
				limit?: number;
				wait_ms?: number;
			}),
	);

	const markReadTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_mark_read",
			description: "Mark a Postgres message as read. Sets read_at timestamp.",
			inputSchema: msgMarkReadSchema,
		},
		msgMarkReadSchema,
		async (input) =>
			pgHandlers.markRead(input as { message_id: number; agent: string }),
	);

	const unreadCountTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_unread_count",
			description: "Get unread message count for an agent from message_ledger.",
			inputSchema: msgUnreadCountSchema,
		},
		msgUnreadCountSchema,
		async (input) => pgHandlers.unreadCount(input as { agent: string }),
	);

	const chanListTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "chan_list",
			description: "List channels with message counts from the Postgres message_ledger.",
			inputSchema: {
				type: "object",
				properties: {
					limit: {
						type: "number",
						description: "Maximum channels to return (default 50, max 500)",
					},
					include_metadata: {
						type: "boolean",
						description: "Include last_message_at metadata. Default false.",
					},
				},
				required: [],
			},
		},
		{
			type: "object",
			properties: {
				limit: { type: "number" },
				include_metadata: { type: "boolean" },
			},
		} as JsonSchema,
		async (input) =>
			pgHandlers.listChannels(input as { limit?: number; include_metadata?: boolean }),
	);

	const chanSubscribeTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "chan_subscribe",
			description:
				"Subscribe or unsubscribe from a channel. Persisted in channel_subscription table for pg_notify delivery.",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: {
						type: "string",
						description: "Agent identity for the subscription.",
					},
					channel: {
						type: "string",
						description: "Channel name (direct, team:<name>, broadcast, system).",
					},
					subscribe: {
						type: "boolean",
						description: "True to subscribe, false to unsubscribe. Defaults to true.",
					},
				},
				required: ["agent_identity", "channel"],
			},
		},
		{
			type: "object",
			properties: {
				agent_identity: { type: "string" },
				channel: { type: "string" },
				subscribe: { type: "boolean" },
			},
			required: ["agent_identity", "channel"],
		} as JsonSchema,
		async (input) =>
			pgHandlers.subscribe(input as { agent_identity: string; channel: string; subscribe?: boolean }),
	);

	const msgAckTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_ack",
			description:
				"Acknowledge a message with outcome (ok|reject|noop). Idempotent — if already acked, returns existing outcome. Cancels pending timeout escalation.",
			inputSchema: {
				type: "object",
				properties: {
					message_id: {
						type: "number",
						description: "Message ID to acknowledge",
					},
					outcome: {
						type: "string",
						enum: ["ok", "reject", "noop"],
						description: "ACK outcome",
					},
					reason: {
						type: "string",
						description: "Optional reason for the outcome",
					},
				},
				required: ["message_id", "outcome"],
			},
		},
		{
			type: "object",
			properties: {
				message_id: { type: "number" },
				outcome: { type: "string" },
				reason: { type: "string" },
			},
			required: ["message_id", "outcome"],
		} as JsonSchema,
		async (input) =>
			handleMsgAck(input as {
				message_id: number;
				outcome: "ok" | "reject" | "noop";
				reason?: string;
			}),
	);

	const msgReplyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_reply",
			description:
				"Reply to a message using correlation_id. Auto-acks the original message and notifies recipient via pg_notify. P1105 AC-27: user/* agents require a valid bearer token in the authorization parameter.",
			inputSchema: {
				type: "object",
				properties: {
					correlation_id: {
						type: "string",
						description: "UUID correlation_id of the original message to reply to",
					},
					content: {
						type: "string",
						description: "Reply message content",
					},
					message_type: {
						type: "string",
						description: "Reply message type (defaults to 'ack')",
					},
					from_agent: {
						type: "string",
						description: "Agent identity sending the reply",
					},
					authorization: {
						type: "string",
						description: "Bearer token for user/* agents (P1105 AC-27)",
					},
				},
				required: ["correlation_id", "content", "from_agent"],
			},
		},
		{
			type: "object",
			properties: {
				correlation_id: { type: "string" },
				content: { type: "string" },
				message_type: { type: "string" },
				from_agent: { type: "string" },
				authorization: { type: "string" },
			},
			required: ["correlation_id", "content", "from_agent"],
		} as JsonSchema,
		async (input) =>
			handleMsgReply(
				input as {
					correlation_id: string;
					content: string;
					message_type?: string;
					from_agent: string;
					authorization?: string;
				},
				operatorHmacSecret,
			),
	);

	const msgWaitReplyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_wait_reply",
			description:
				"Wait for a reply to a message using correlation_id. Polls every 5s with pg_notify fallback. Returns reply_message_id if a reply arrives, or timed_out: true if timeout exceeded. P1105 AC-27: user/* agents require a valid bearer token in the authorization parameter.",
			inputSchema: {
				type: "object",
				properties: {
					message_id: {
						type: "number",
						description: "Original message ID to wait for a reply to",
					},
					timeout_ms: {
						type: "number",
						description: "Timeout in milliseconds (0-300000, capped at 5 minutes)",
					},
					agent: {
						type: "string",
						description: "Agent identity waiting for the reply",
					},
					authorization: {
						type: "string",
						description: "Bearer token for user/* agents (P1105 AC-27)",
					},
				},
				required: ["message_id", "timeout_ms", "agent"],
			},
		},
		{
			type: "object",
			properties: {
				message_id: { type: "number" },
				timeout_ms: { type: "number" },
				agent: { type: "string" },
				authorization: { type: "string" },
			},
			required: ["message_id", "timeout_ms", "agent"],
		} as JsonSchema,
		async (input) =>
			handleMsgWaitReply(
				input as {
					message_id: number;
					timeout_ms: number;
					agent: string;
					authorization?: string;
				},
				operatorHmacSecret,
			),
	);

	const spawnManifestTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "agent_credential_spawn_manifest",
			description:
				"Create a spawn manifest and store in spawn_bucket (P834 Phase 1). Generates a unique nonce and signs manifest with parent agent_secret. Returns manifest object.",
			inputSchema: {
				type: "object",
				properties: {
					parent_identity: { type: "string" },
					child_identity: { type: "string" },
					agency_id: { type: "string" },
					allowed_scopes: { type: "array", items: { type: "string" } },
					denied_scopes: { type: "array", items: { type: "string" } },
					max_spawn_depth: { type: "number" },
					parent_ephemeral_public_key: { type: "string" },
					parent_sig: { type: "string" },
				},
				required: [
					"parent_identity",
					"child_identity",
					"agency_id",
					"allowed_scopes",
					"parent_ephemeral_public_key",
					"parent_sig",
				],
			},
		},
		{
			type: "object",
			properties: {
				parent_identity: { type: "string" },
				child_identity: { type: "string" },
				agency_id: { type: "string" },
				allowed_scopes: { type: "array", items: { type: "string" } },
				denied_scopes: { type: "array", items: { type: "string" } },
				max_spawn_depth: { type: "number" },
				parent_ephemeral_public_key: { type: "string" },
				parent_sig: { type: "string" },
			},
			required: [
				"parent_identity",
				"child_identity",
				"agency_id",
				"allowed_scopes",
				"parent_ephemeral_public_key",
				"parent_sig",
			],
		} as JsonSchema,
		async (input) => {
			const result = spawnManifestCreate(
				input as {
					parent_identity: string;
					child_identity: string;
					agency_id: string;
					allowed_scopes: string[];
					denied_scopes?: string[];
					max_spawn_depth?: number;
					parent_ephemeral_public_key: string;
					parent_sig: string;
				},
			);
			if ("error" in result) {
				return {
					content: [{ type: "text", text: `⚠️ Error: ${result.error}` }],
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result.manifest) }],
			};
		},
	);

	const credentialClaimTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "agent_credential_claim",
			description:
				"Phase 2: Child claims credential grant (P834). Validates nonce, sets child's ephemeral public key, enforces single-use claim.",
			inputSchema: {
				type: "object",
				properties: {
					nonce: { type: "string" },
					child_ephemeral_public_key: { type: "string" },
					child_identity: { type: "string" },
				},
				required: ["nonce", "child_ephemeral_public_key", "child_identity"],
			},
		},
		{
			type: "object",
			properties: {
				nonce: { type: "string" },
				child_ephemeral_public_key: { type: "string" },
				child_identity: { type: "string" },
			},
			required: ["nonce", "child_ephemeral_public_key", "child_identity"],
		} as JsonSchema,
		async (input) =>
			agentCredentialClaim(
				input as {
					nonce: string;
					child_ephemeral_public_key: string;
					child_identity: string;
				},
			),
	);

	const credentialDeliverTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "agent_credential_deliver",
			description:
				"Phase 3: Orchestrator delivers encrypted credential (P834). Stores credential envelope in spawn_bucket, notifies child via pg_notify.",
			inputSchema: {
				type: "object",
				properties: {
					nonce: { type: "string" },
					child_agent_secret_encrypted: { type: "string" },
					encryption_nonce: { type: "string" },
					encryption_tag: { type: "string" },
					grant_expires_at: { type: "string" },
				},
				required: [
					"nonce",
					"child_agent_secret_encrypted",
					"encryption_nonce",
					"encryption_tag",
					"grant_expires_at",
				],
			},
		},
		{
			type: "object",
			properties: {
				nonce: { type: "string" },
				child_agent_secret_encrypted: { type: "string" },
				encryption_nonce: { type: "string" },
				encryption_tag: { type: "string" },
				grant_expires_at: { type: "string" },
			},
			required: [
				"nonce",
				"child_agent_secret_encrypted",
				"encryption_nonce",
				"encryption_tag",
				"grant_expires_at",
			],
		} as JsonSchema,
		async (input) =>
			agentCredentialDeliver(
				input as {
					nonce: string;
					child_agent_secret_encrypted: string;
					encryption_nonce: string;
					encryption_tag: string;
					grant_expires_at: string;
				},
			),
	);

	const credentialRetrieveTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "agent_credential_retrieve",
			description:
				"Retrieve credential envelope from spawn_bucket (for testing/debugging). In production, child receives via pg_notify.",
			inputSchema: {
				type: "object",
				properties: {
					nonce: { type: "string" },
				},
				required: ["nonce"],
			},
		},
		{
			type: "object",
			properties: {
				nonce: { type: "string" },
			},
			required: ["nonce"],
		} as JsonSchema,
		async (input) =>
			agentCredentialRetrieve(input as { nonce: string }),
	);

	const dlqListTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "dlq_list",
			description:
				"List dead-letter queue (DLQ) entries for a project. Returns id, topic_slug, dead_at, retry_count, replays, and failure_reason. Maximum 500 entries.",
			inputSchema: {
				type: "object",
				properties: {
					project_slug: {
						type: "string",
						description: "Project slug / schema name",
					},
					topic: {
						type: "string",
						description: "Optional filter by topic slug",
					},
					limit: {
						type: "number",
						description: "Max entries to return (default 100, max 500)",
					},
				},
				required: ["project_slug"],
			},
		},
		{
			type: "object",
			properties: {
				project_slug: { type: "string" },
				topic: { type: "string" },
				limit: { type: "number" },
			},
			required: ["project_slug"],
		} as JsonSchema,
		async (input) =>
			dlqList(input as { project_slug: string; topic?: string; limit?: number }),
	);

	const dlqInspectTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "dlq_inspect",
			description:
				"Inspect full details of a DLQ entry, including all columns and payload.",
			inputSchema: {
				type: "object",
				properties: {
					project_slug: {
						type: "string",
						description: "Project slug / schema name",
					},
					dlq_id: {
						type: "string",
						description: "DLQ entry ID",
					},
				},
				required: ["project_slug", "dlq_id"],
			},
		},
		{
			type: "object",
			properties: {
				project_slug: { type: "string" },
				dlq_id: { type: "string" },
			},
			required: ["project_slug", "dlq_id"],
		} as JsonSchema,
		async (input) =>
			dlqInspect(input as { project_slug: string; dlq_id: string }),
	);

	const dlqReplayTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "dlq_replay",
			description:
				"Replay a DLQ message by inserting it into mMessage and removing from DLQ. Rejects if replays >= 3 unless force=true (audited).",
			inputSchema: {
				type: "object",
				properties: {
					project_slug: {
						type: "string",
						description: "Project slug / schema name",
					},
					dlq_id: {
						type: "string",
						description: "DLQ entry ID to replay",
					},
					force: {
						type: "boolean",
						description:
							"Force replay even if replays >= 3. Causes audit event. Default false.",
					},
				},
				required: ["project_slug", "dlq_id"],
			},
		},
		{
			type: "object",
			properties: {
				project_slug: { type: "string" },
				dlq_id: { type: "string" },
				force: { type: "boolean" },
			},
			required: ["project_slug", "dlq_id"],
		} as JsonSchema,
		async (input) =>
			dlqReplay(input as { project_slug: string; dlq_id: string; force?: boolean }),
	);

	const dlqExpireTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "dlq_expire",
			description:
				"Mark a DLQ entry as expired (sets expired_at timestamp). Does not delete. Rejects if already expired. Writes audit event.",
			inputSchema: {
				type: "object",
				properties: {
					project_slug: {
						type: "string",
						description: "Project slug / schema name",
					},
					dlq_id: {
						type: "string",
						description: "DLQ entry ID to expire",
					},
					reason: {
						type: "string",
						description: "Reason for expiration",
					},
				},
				required: ["project_slug", "dlq_id", "reason"],
			},
		},
		{
			type: "object",
			properties: {
				project_slug: { type: "string" },
				dlq_id: { type: "string" },
				reason: { type: "string" },
			},
			required: ["project_slug", "dlq_id", "reason"],
		} as JsonSchema,
		async (input) =>
			dlqExpire(input as { project_slug: string; dlq_id: string; reason: string }),
	);

	const dlqStatsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "dlq_stats",
			description:
				"Get DLQ statistics grouped by failure_reason, showing total count and expired count.",
			inputSchema: {
				type: "object",
				properties: {
					project_slug: {
						type: "string",
						description: "Project slug / schema name",
					},
				},
				required: ["project_slug"],
			},
		},
		{
			type: "object",
			properties: {
				project_slug: { type: "string" },
			},
			required: ["project_slug"],
		} as JsonSchema,
		async (input) => dlqStats(input as { project_slug: string }),
	);

	const liaisonStuckTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "liaison_stuck_messages",
			description:
				"Find liaison messages (agency.msg_default) that have not been processed and are older than threshold_days. Uses partial index for performance.",
			inputSchema: {
				type: "object",
				properties: {
					project_slug: {
						type: "string",
						description: "Project slug (context only; queries system agency table)",
					},
					threshold_days: {
						type: "number",
						description: "Messages older than this many days are considered stuck (default 7)",
					},
				},
				required: ["project_slug"],
			},
		},
		{
			type: "object",
			properties: {
				project_slug: { type: "string" },
				threshold_days: { type: "number" },
			},
			required: ["project_slug"],
		} as JsonSchema,
		async (input) =>
			liaisonStuckMessages(
				input as { project_slug: string; threshold_days?: number },
			),
	);

	const msgTailTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_tail",
			description:
				"P995: Tail recent messages to/from a named agent. Returns all messages (read + unread), " +
				"newest first. Useful for checking what an agent has been doing. Use msg_read for unread-only.",
			inputSchema: {
				type: "object",
				properties: {
					agent: {
						type: "string",
						description: "Agent identity (e.g. 'adam') to tail messages for",
					},
					limit: {
						type: "number",
						description: "Max messages to return (default 20, max 200)",
					},
				},
				required: ["agent"],
			},
		},
		{
			type: "object",
			properties: {
				agent: { type: "string" },
				limit: { type: "number" },
			},
			required: ["agent"],
		} as JsonSchema,
		async (input) =>
			pgHandlers.tailMessages(input as { agent: string; limit?: number }),
	);

	server.addTool(sendTool);
	server.addTool(readTool);
	server.addTool(markReadTool);
	server.addTool(unreadCountTool);
	server.addTool(chanListTool);
	server.addTool(chanSubscribeTool);
	server.addTool(msgAckTool);
	server.addTool(msgReplyTool);
	server.addTool(msgWaitReplyTool);
	server.addTool(spawnManifestTool);
	server.addTool(credentialClaimTool);
	server.addTool(credentialDeliverTool);
	server.addTool(credentialRetrieveTool);
	server.addTool(dlqListTool);
	server.addTool(dlqInspectTool);
	server.addTool(dlqReplayTool);
	server.addTool(dlqExpireTool);
	server.addTool(dlqStatsTool);
	server.addTool(liaisonStuckTool);
	server.addTool(msgTailTool);
}
