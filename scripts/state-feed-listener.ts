/**
 * State Feed (P720 Phase 1) — pg_notify listener that forwards proposal
 * lifecycle events to a Discord webhook with operator-readable sentences.
 *
 * Pure Postgres LISTEN + REST. Zero LLM.
 *
 * Subscribes to `roadmap_events` (the unified outbox channel emitted by
 * fn_notify_proposal_event) plus the legacy maturity/state/gate-ready
 * channels for completeness. For each event, looks up the proposal_event
 * row + the proposal title and renders a sentence per the P720 spec at
 * /data/code/AgentHive/docs/proposals/P720/event-render-templates.md.
 */
import { Client } from "pg";
import { readFileSync, existsSync } from "node:fs";

const WEBHOOK_URL =
	process.env.DISCORD_WEBHOOK_STATEFEED ??
	(() => {
		throw new Error(
			"DISCORD_WEBHOOK_STATEFEED not set — add to /etc/agenthive/env or ~/.hermes/.env",
		);
	})();

// Subscribe to both the unified outbox and the legacy gate-ready channel.
// The legacy maturity/state channels still fire but `roadmap_events` carries
// the same information with better fidelity, so we ignore the legacy ones to
// avoid double-posting.
const CHANNELS = [
	"roadmap_events",
	"agent_lifecycle_events",
	"control_feed",
	"proposal_gate_ready",
	"state_feed_user_inbox",
];

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function getPGPassword(): string | undefined {
	for (const pw of [process.env.PGPASSWORD, process.env.PG_PASSWORD]) {
		if (pw) return pw;
	}
	const envPaths = [
		process.env.HOME + "/.hermes/.env",
		"/data/code/AgentHive/.env",
	];
	for (const envPath of envPaths) {
		if (!envPath || !existsSync(envPath)) continue;
		for (const line of readFileSync(envPath, "utf-8").split("\n")) {
			const m = /^\s*(?:PGPASSWORD|PG_PASSWORD)\s*=\s*(.+)/.exec(line);
			if (m) return m[1].trim();
		}
	}
	return undefined;
}

// ─── Discord posting ──────────────────────────────────────────────────────────

async function sendToDiscord(content: string) {
	if (!content) return;
	const truncated =
		content.length > 1900
			? content.slice(0, 1900) + "\n_[truncated — see dashboard]_"
			: content;
	try {
		await fetch(WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: truncated }),
		});
	} catch (err) {
		console.error("[state-feed] Discord send failed:", err);
	}
}

// ─── Lookup helpers ───────────────────────────────────────────────────────────

type ProposalRow = {
	id: number;
	display_id: string;
	title: string;
	status: string;
	maturity: string;
	type: string | null;
};

type EventRow = {
	id: number;
	proposal_id: number;
	event_type: string;
	payload: Record<string, unknown>;
	created_at: Date;
};

async function fetchEvent(client: Client, eventId: number): Promise<EventRow | null> {
	const res = await client.query<EventRow>(
		`SELECT id, proposal_id, event_type, payload, created_at
		   FROM roadmap_proposal.proposal_event WHERE id = $1`,
		[eventId],
	);
	return res.rows[0] ?? null;
}

async function fetchProposal(client: Client, proposalId: number): Promise<ProposalRow | null> {
	const res = await client.query<ProposalRow>(
		`SELECT id, display_id, title, status, maturity, type
		   FROM roadmap_proposal.proposal WHERE id = $1`,
		[proposalId],
	);
	return res.rows[0] ?? null;
}

async function fetchLatestGateRationale(
	client: Client,
	proposalId: number,
): Promise<string | null> {
	const res = await client.query<{ rationale: string | null }>(
		`SELECT rationale FROM roadmap_proposal.gate_decision_log
		  WHERE proposal_id = $1
		  ORDER BY created_at DESC LIMIT 1`,
		[proposalId],
	);
	return res.rows[0]?.rationale ?? null;
}

// ─── Stage / maturity label maps ──────────────────────────────────────────────

const STATUS_VERB_RFC: Record<string, string> = {
	DRAFT: "drafting",
	REVIEW: "reviewing",
	DEVELOP: "developing",
	MERGE: "merge-ready",
	COMPLETE: "shipped",
};
const STATUS_VERB_HOTFIX: Record<string, string> = {
	TRIAGE: "triaging",
	FIX: "fixing",
	DEPLOYED: "deployed",
};
function statusVerb(type: string | null, status: string): string {
	const upper = (status ?? "").toUpperCase();
	if ((type ?? "").toLowerCase() === "hotfix") {
		return STATUS_VERB_HOTFIX[upper] ?? upper.toLowerCase();
	}
	return STATUS_VERB_RFC[upper] ?? upper.toLowerCase();
}

const STATE_IMPLICATIONS_RFC: Record<string, Record<string, string>> = {
	DRAFT: { REVIEW: "Ready for gate review — architecture validation, feasibility check" },
	REVIEW: { DEVELOP: "Approved — coding can begin, agents can claim implementation work" },
	DEVELOP: { MERGE: "Implementation done — branch merge, CI, integration testing" },
	MERGE: { COMPLETE: "Shipped — ready for production, dependents can proceed" },
};
const STATE_IMPLICATIONS_HOTFIX: Record<string, Record<string, string>> = {
	TRIAGE: { FIX: "Triage approved — fix scope agreed, agent can claim implementation" },
	FIX: { DEPLOYED: "Patch verified — hotfix deployed, defect closed" },
};
function stateImplication(type: string | null, from: string, to: string): string {
	const f = (from ?? "").toUpperCase();
	const t = (to ?? "").toUpperCase();
	const map =
		(type ?? "").toLowerCase() === "hotfix"
			? STATE_IMPLICATIONS_HOTFIX
			: STATE_IMPLICATIONS_RFC;
	return map[f]?.[t] ?? "";
}

const MATURITY_IMPL: Record<string, string> = {
	new: "Awaiting claim — no agent assigned yet",
	active: "Under active lease — agent is iterating",
	mature: "Ready for gate decision — work is complete enough to advance",
	obsolete: "Marked obsolete — work cancelled or superseded",
};

// ─── Agent identity normalization ─────────────────────────────────────────────

function normalizeAgent(raw: string | null | undefined): string {
	const s = (raw ?? "").trim();
	if (!s) return "agent";
	const m = /^worker-\d+\s+\(([^)]+)\)@(.+)$/i.exec(s);
	if (m) return `${m[2]}/${m[1]}`;
	return s;
}

// ─── Suppression / dedupe state ───────────────────────────────────────────────

const CLAIM_DEDUPE_WINDOW_MS = 60_000;
const recentClaims = new Map<string, number>();

function shouldEmitClaim(agent: string, proposalId: number, stage: string): boolean {
	const key = `${agent}|${proposalId}|${stage}`;
	const now = Date.now();
	const last = recentClaims.get(key);
	if (last && now - last < CLAIM_DEDUPE_WINDOW_MS) return false;
	recentClaims.set(key, now);
	if (recentClaims.size > 500) {
		for (const [k, t] of recentClaims) {
			if (now - t > CLAIM_DEDUPE_WINDOW_MS * 2) recentClaims.delete(k);
		}
	}
	return true;
}

const GATE_RELEASE_REASONS = new Set([
	"gate_review_complete",
	"gate_hold",
	"gate_reject",
	"gate_waive",
]);

// ─── In-memory event deduplication ───────────────────────────────────────────

const EVENT_DEDUPE_WINDOW_MS = 5_000;
const processedEvents = new Map<string, number>();

function isDuplicate(key: string): boolean {
	const now = Date.now();
	const last = processedEvents.get(key);
	if (last && now - last < EVENT_DEDUPE_WINDOW_MS) return true;
	processedEvents.set(key, now);
	if (processedEvents.size > 1000) {
		for (const [k, t] of processedEvents) {
			if (now - t > EVENT_DEDUPE_WINDOW_MS * 2) processedEvents.delete(k);
		}
	}
	return false;
}

// ─── Event renderers ──────────────────────────────────────────────────────────

function renderProposalCreated(p: ProposalRow, ev: EventRow): string {
	const creator = String(ev.payload.agent ?? "system");
	const line = creator === "system"
		? `📝 new proposal filed: **${p.display_id}** — ${p.title}`
		: `📝 ${normalizeAgent(creator)} filed **${p.display_id}** — ${p.title}`;
	const typeTag = p.type ? `\n_type: ${p.type}_` : "";
	return line + typeTag;
}

function renderLeaseClaimed(p: ProposalRow, ev: EventRow): string {
	const agent = normalizeAgent(String(ev.payload.agent ?? "agent"));
	if (!shouldEmitClaim(agent, p.id, p.status)) return "";
	const stage = p.status;
	const claimedFor = String(ev.payload.claimed_for ?? "").trim() || statusVerb(p.type, stage);
	return `🔒 **${agent}** claimed **${p.display_id}|${stage}** to ${claimedFor}\n_${p.title}_`;
}

async function renderLeaseReleased(
	client: Client,
	p: ProposalRow,
	ev: EventRow,
): Promise<string> {
	const reason = String(ev.payload.release_reason ?? "").trim();
	if (!GATE_RELEASE_REASONS.has(reason)) return "";

	const agent = normalizeAgent(String(ev.payload.agent ?? "agent"));
	const stage = p.status;
	let head: string;
	let detail = "";
	switch (reason) {
		case "gate_review_complete": {
			head = `✅ **${agent}** released **${p.display_id}|${stage}** — gate review complete`;
			break;
		}
		case "gate_hold": {
			const r = await fetchLatestGateRationale(client, p.id);
			head = `⏸️ **${agent}** released **${p.display_id}|${stage}** — gate held`;
			if (r) detail = `\nawaiting: ${r.slice(0, 120)}`;
			break;
		}
		case "gate_reject": {
			const r = await fetchLatestGateRationale(client, p.id);
			head = `🚫 **${agent}** released **${p.display_id}|${stage}** — gate rejected`;
			if (r) detail = `\nreason: ${r.slice(0, 160)}`;
			break;
		}
		case "gate_waive":
			head = `🔄 **${agent}** released **${p.display_id}|${stage}** — gate waived`;
			break;
		default:
			return "";
	}
	return `${head}\n_${p.title}_${detail}`;
}

function renderMaturityChanged(p: ProposalRow, ev: EventRow): string {
	const oldM = String(ev.payload.old_maturity ?? ev.payload.from_maturity ?? "");
	const newM = String(ev.payload.maturity ?? ev.payload.new_maturity ?? p.maturity ?? "");
	if (!newM || (oldM && oldM === newM)) return "";

	const stage = p.status;
	const impl = MATURITY_IMPL[newM] ?? "";
	const fromLabel = oldM || "?";
	return (
		`⏫ **${p.display_id}|${stage}** maturity: ${fromLabel} → **${newM}**` +
		`\n_${p.title}_` +
		(impl ? `\n→ ${impl}` : "")
	);
}

async function renderStatusChanged(
	client: Client,
	p: ProposalRow,
	ev: EventRow,
): Promise<string> {
	const from = String(ev.payload.from ?? ev.payload.old_status ?? "").toUpperCase();
	const to = String(ev.payload.to ?? ev.payload.new_status ?? p.status).toUpperCase();
	if (from && from === to) return "";
	const agentRaw = String(ev.payload.agent ?? "system");
	const agent = agentRaw === "system" ? "system" : normalizeAgent(agentRaw);
	const fromVerb = from ? statusVerb(p.type, from) : "?";
	const toVerb = statusVerb(p.type, to);
	const impl = stateImplication(p.type, from, to);
	const emojiMap: Record<string, string> = {
		COMPLETE: "🏁",
		DEPLOYED: "🚀",
		MERGE: "🔀",
		DEVELOP: "🔨",
		FIX: "🔧",
		REVIEW: "🔍",
		TRIAGE: "🔎",
		DRAFT: "📝",
	};
	const icon = emojiMap[to] ?? "🔄";
	const lead = agent === "system"
		? `${icon} **${p.display_id}** advanced ${fromVerb} → **${toVerb}** (${from || "?"} → ${to})`
		: `${icon} **${agent}** advanced **${p.display_id}** ${fromVerb} → **${toVerb}** (${from || "?"} → ${to})`;
	return lead + `\n_${p.title}_` + (impl ? `\n→ ${impl}` : "");
}

async function renderDecisionMade(
	client: Client,
	p: ProposalRow,
	ev: EventRow,
): Promise<string> {
	const decision = String(ev.payload.gate_decision ?? ev.payload.decision ?? "").toLowerCase();
	const agent = normalizeAgent(String(ev.payload.decided_by ?? ev.payload.agent ?? "gate-agent"));
	const gate = String(ev.payload.gate ?? "").toUpperCase();
	const stage = p.status;
	const rationale = await fetchLatestGateRationale(client, p.id);
	const rTail = rationale ? `\n${rationale.slice(0, 160)}` : "";
	const decoration: Record<string, { emoji: string; verb: string }> = {
		advance: { emoji: "✅", verb: "advanced" },
		hold: { emoji: "⏸️", verb: "held" },
		reject: { emoji: "🚫", verb: "rejected" },
		waive: { emoji: "🔄", verb: "waived" },
	};
	const d = decoration[decision] ?? { emoji: "🔔", verb: decision || "decided" };
	const gateLabel = gate ? ` ${gate}` : "";
	return (
		`${d.emoji} **${agent}**${gateLabel} ${d.verb} **${p.display_id}|${stage}**` +
		`\n_${p.title}_${rTail}`
	);
}

function renderReviewSubmitted(p: ProposalRow, ev: EventRow): string {
	const reviewer = normalizeAgent(String(ev.payload.reviewer ?? ev.payload.agent ?? "reviewer"));
	const stage = p.status;
	const excerpt = String(ev.payload.excerpt ?? ev.payload.summary ?? "").slice(0, 140);
	const tag = excerpt ? `\n"${excerpt}"` : "";
	return `💬 **${reviewer}** posted review on **${p.display_id}|${stage}**${tag}`;
}

// ─── Agent lifecycle renderer (P1123 AC-7) ───────────────────────────────────

function renderAgentLifecycleEvent(payload: string): string {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(payload);
	} catch {
		return "";
	}

	if (data.event_type === "pool_poisoned") {
		const svc = String(data.service_name ?? data.service ?? "unknown-service");
		const detail = data.detail ? ` — ${String(data.detail).slice(0, 120)}` : "";
		return `🚨 **POOL POISONED** in \`${svc}\`${detail}\nIncident detected by P1123 watchdog. Service is degraded; restart \`${svc}.service\` to recover.`;
	}

	if (data.event_type !== "registry_reap") return "";

	const count = Number(data.count ?? 0);
	const retention = String(data.retention ?? "unknown retention");
	return `**system/registry-reaper** pruned **${count}** inactive agent_registry row(s) older than ${retention}`;
}

// ─── User inbox renderer (AC-16 / P1120) ─────────────────────────────────────

function renderUserInboxMessage(payload: string): string {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(payload);
	} catch {
		return "";
	}
	const from = String(data.from_agent ?? "unknown");
	const msgType = String(data.message_type ?? "message");
	const raw = String(data.message_content ?? "").trim();
	const content = raw ? `: ${raw.slice(0, 200)}` : "";
	return `📬 **[inbox]** \`${from}\` → \`${msgType}\`${content}`;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function handleProposalEvent(client: Client, eventId: number): Promise<string> {
	if (isDuplicate(`roadmap_events:${eventId}`)) return "";
	const ev = await fetchEvent(client, eventId);
	if (!ev) return "";
	const p = await fetchProposal(client, ev.proposal_id);
	if (!p) return "";
	switch (ev.event_type) {
		case "proposal_created":
			return renderProposalCreated(p, ev);
		case "lease_claimed":
			return renderLeaseClaimed(p, ev);
		case "lease_released":
			return await renderLeaseReleased(client, p, ev);
		case "maturity_changed":
			return renderMaturityChanged(p, ev);
		case "status_changed":
			return await renderStatusChanged(client, p, ev);
		case "decision_made":
			return await renderDecisionMade(client, p, ev);
		case "review_submitted":
			return renderReviewSubmitted(p, ev);
		default:
			console.log(`[state-feed] ignoring unknown event_type=${ev.event_type}`);
			return "";
	}
}

async function renderGateReady(client: Client, payload: string): Promise<string> {
	let data: Record<string, any> = {};
	try {
		data = JSON.parse(payload);
	} catch {
		return "";
	}
	const proposalId = Number(data.proposal_id ?? data.id);
	if (!Number.isFinite(proposalId)) return "";
	
	// Deduplicate by proposal + gate + status
	const gate = String(data.gate ?? "").toUpperCase();
	const dedupeKey = `gate_ready:${proposalId}:${gate}:${data.from_stage}`;
	if (isDuplicate(dedupeKey)) return "";

	const p = await fetchProposal(client, proposalId);
	if (!p) return "";
	const toStage = String(data.to_stage ?? "").toUpperCase();
	const stage = p.status;
	const gateLabel = gate ? `${gate} ` : "";
	const toLabel = toStage ? ` → ${toStage}` : "";
	return (
		`🚪 **${p.display_id}|${stage}** is gate-ready (${gateLabel}${stage}${toLabel})` +
		`\n_${p.title}_` +
		`\n→ Awaiting gate decision to advance`
	);
}

async function handleNotification(
	client: Client,
	channel: string,
	payload: string,
): Promise<void> {
	console.log(`[state-feed] NOTIFY ${channel}: ${payload.slice(0, 120)}`);
	let msg = "";
	if (channel === "roadmap_events") {
		let env: Record<string, unknown> = {};
		try {
			env = JSON.parse(payload);
		} catch {
			console.log(`[state-feed] bad JSON on ${channel}`);
			return;
		}
		const eventId = Number(env.event_id);
		if (!Number.isFinite(eventId)) {
			console.log(`[state-feed] no event_id in ${channel} payload`);
			return;
		}
		msg = await handleProposalEvent(client, eventId);
	} else if (channel === "proposal_gate_ready") {
		msg = await renderGateReady(client, payload);
	} else if (channel === "agent_lifecycle_events" || channel === "control_feed") {
		msg = renderAgentLifecycleEvent(payload);
	} else if (channel === "state_feed_user_inbox") {
		msg = renderUserInboxMessage(payload);
	}
	if (msg) {
		console.log(`[state-feed] → Discord: ${msg.slice(0, 80)}`);
		await sendToDiscord(msg);
	}
}

let activeClient: Client | null = null;
let isShuttingDown = false;

async function runListener() {
	if (isShuttingDown) return;

	// Close existing client if any
	if (activeClient) {
		console.log("[state-feed] Closing existing client before reconnect...");
		try {
			await activeClient.end();
		} catch (err) {
			console.error("[state-feed] Error closing old client:", err);
		}
		activeClient = null;
	}

	const pgPassword = getPGPassword();
	const client = new Client({
		host: process.env.PGHOST ?? process.env.PG_HOST ?? "127.0.0.1",
		port: Number(process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? "5432"),
		user: process.env.PGUSER ?? process.env.PG_USER,
		password: pgPassword,
		database: process.env.PGDATABASE ?? process.env.PG_DATABASE ?? "agenthive",
		application_name: "agenthive-state-feed",
	});

	activeClient = client;

	client.on("notification", async (msg) => {
		if (!msg.channel || !msg.payload) return;
		try {
			await handleNotification(client, msg.channel, msg.payload);
		} catch (err) {
			console.error(`[state-feed] Error handling ${msg.channel}:`, err);
		}
	});

	client.on("error", (err) => {
		if (isShuttingDown) return;
		console.error("[state-feed] PG error:", err);
		activeClient = null;
		setTimeout(() => runListener().catch(console.error), 5000);
	});

	try {
		await client.connect();
		console.log("[state-feed] Connected to Postgres");

		for (const ch of CHANNELS) {
			await client.query(`LISTEN ${ch}`);
			console.log(`[state-feed] Listening on ${ch}`);
		}
		console.log("[state-feed] Ready — P720 Phase 1 grammar active");
	} catch (err) {
		console.error("[state-feed] Connection failed:", err);
		activeClient = null;
		setTimeout(() => runListener().catch(console.error), 5000);
	}
}

async function main() {
	// Graceful shutdown handlers
	const shutdown = async () => {
		if (isShuttingDown) return;
		isShuttingDown = true;
		console.log("[state-feed] Shutting down...");
		if (activeClient) {
			try {
				await activeClient.end();
			} catch (err) {
				console.error("[state-feed] Error during shutdown:", err);
			}
		}
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	await runListener();
}

main().catch((err) => {
	console.error("[state-feed] Fatal:", err);
	process.exit(1);
});
