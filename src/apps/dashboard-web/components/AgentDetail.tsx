import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useProjectScope } from "../hooks/useProjectScope";

// P477 AC-5: per-agent detail surface.
// Shows registry + heartbeat + recent agent_runs + recent messages,
// plus a reminder/message form. Mounts as a slide-over panel from the
// right edge so it can sit on top of the existing AgentsPage without a
// full route or layout change while we wait for the bigger control-plane
// redesign (AC-1).

type AgentDetailData = {
	identity: string;
	registry: Record<string, unknown> | null;
	health: {
		status?: string;
		current_task?: string | null;
		current_proposal?: number | null;
		current_cubic?: string | null;
		cpu_percent?: number | null;
		memory_mb?: number | null;
		active_model?: string | null;
		uptime_seconds?: number | null;
		last_heartbeat_at?: string;
	} | null;
	heartbeats: Array<{
		heartbeat_at: string;
		cpu_percent: number | null;
		memory_mb: number | null;
		active_model: string | null;
		current_task: string | null;
	}>;
	runs: Array<{
		id: number;
		proposal_display_id: string | null;
		stage: string;
		model_used: string;
		status: string;
		activity: string | null;
		output_summary: string | null;
		tokens_in: number | null;
		tokens_out: number | null;
		cost_usd: number | string | null;
		duration_ms: number | null;
		started_at: string;
		completed_at: string | null;
		error_detail: string | null;
	}>;
	messages: Array<{
		id: number;
		from_agent: string;
		to_agent: string | null;
		channel: string | null;
		message_type: string | null;
		message_content: string;
		created_at: string;
		proposal_id: number | null;
	}>;
};

interface AgentDetailProps {
	identity: string;
	onClose: () => void;
}

const formatTimeAgo = (iso?: string | null): string => {
	if (!iso) return "—";
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "—";
	const diff = Date.now() - t;
	if (diff < 0) return "just now";
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
};

const healthBadge = (status?: string | null) => {
	switch (status) {
		case "healthy":
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
		case "stale":
			return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200";
		case "offline":
			return "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300";
		case "crashed":
			return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
		default:
			return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
	}
};

const runStatusColor = (status: string) => {
	switch (status) {
		case "completed":
			return "text-emerald-700 dark:text-emerald-300";
		case "running":
			return "text-blue-700 dark:text-blue-300";
		case "failed":
			return "text-red-700 dark:text-red-300";
		case "cancelled":
			return "text-gray-500 dark:text-gray-400";
		default:
			return "text-gray-700 dark:text-gray-300";
	}
};

const AgentDetail: React.FC<AgentDetailProps> = ({ identity, onClose }) => {
	const [data, setData] = useState<AgentDetailData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [messageType, setMessageType] = useState("reminder");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const [sendOk, setSendOk] = useState<string | null>(null);
	const scope = useProjectScope();

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await scope.scopedFetch(
				`/api/agents/${encodeURIComponent(identity)}`,
				{ headers: { Accept: "application/json" } },
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			setData((await res.json()) as AgentDetailData);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setLoading(false);
		}
	}, [identity, scope.scopedFetch]);

	useEffect(() => {
		void load();
		const t = setInterval(() => void load(), 10000);
		return () => clearInterval(t);
	}, [load]);

	const send = async () => {
		const text = draft.trim();
		if (!text || sending) return;
		setSending(true);
		setSendError(null);
		setSendOk(null);
		try {
			const res = await scope.scopedFetch(
				`/api/agents/${encodeURIComponent(identity)}/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text, message_type: messageType }),
				},
			);
			const body = (await res.json().catch(() => ({}))) as { error?: string; message_id?: number };
			if (!res.ok) {
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			setDraft("");
			setSendOk(`Sent (id=${body.message_id})`);
			void load();
		} catch (err) {
			setSendError((err as Error).message);
		} finally {
			setSending(false);
		}
	};

	const reg = (data?.registry ?? {}) as Record<string, unknown>;
	const health = data?.health ?? null;
	const runningRun = data?.runs.find((r) => r.status === "running");

	return (
		<div className="fixed inset-0 z-50 flex">
			<button
				type="button"
				aria-label="Close panel"
				className="flex-1 bg-black/40"
				onClick={onClose}
			/>
			<aside className="w-full max-w-2xl bg-white dark:bg-gray-900 shadow-xl border-l border-gray-200 dark:border-gray-800 flex flex-col">
				<header className="flex items-start justify-between gap-3 p-4 border-b border-gray-200 dark:border-gray-800">
					<div>
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 break-all">
							{identity}
						</h2>
						<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
							<span
								className={`px-2 py-0.5 rounded font-medium ${healthBadge(health?.status)}`}
							>
								{health?.status ?? "unknown"}
							</span>
							{typeof reg.role === "string" && (
								<span className="font-mono">{reg.role as string}</span>
							)}
							{typeof reg.agent_type === "string" && (
								<span className="font-mono">{reg.agent_type as string}</span>
							)}
							{typeof reg.trust_tier === "string" && (
								<span>trust: {reg.trust_tier as string}</span>
							)}
						</div>
					</div>
					<button
						type="button"
						className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</header>

				<div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
					{loading && !data && (
						<div className="text-sm text-gray-500">Loading…</div>
					)}
					{error && (
						<div className="text-sm text-red-600 dark:text-red-400">
							{error}
						</div>
					)}

					{data && (
						<>
							{/* Heartbeat / current work */}
							<section>
								<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
									Current state
								</h3>
								<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-700 dark:text-gray-300">
									<dt className="text-gray-500">last heartbeat</dt>
									<dd>{formatTimeAgo(health?.last_heartbeat_at)}</dd>
									<dt className="text-gray-500">current task</dt>
									<dd className="font-mono break-all">
										{health?.current_task ?? "—"}
									</dd>
									<dt className="text-gray-500">proposal</dt>
									<dd>{health?.current_proposal ?? "—"}</dd>
									<dt className="text-gray-500">cubic</dt>
									<dd className="font-mono break-all">
										{health?.current_cubic ?? "—"}
									</dd>
									<dt className="text-gray-500">model</dt>
									<dd>{health?.active_model ?? "—"}</dd>
									<dt className="text-gray-500">cpu / mem</dt>
									<dd>
										{health?.cpu_percent != null ? `${health.cpu_percent}%` : "—"}
										{" / "}
										{health?.memory_mb != null ? `${health.memory_mb} MB` : "—"}
									</dd>
								</dl>
								{runningRun && (
									<div className="mt-2 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-2 text-xs">
										<div className="font-medium text-blue-800 dark:text-blue-200">
											Run #{runningRun.id} ({runningRun.status})
										</div>
										<div className="text-blue-700 dark:text-blue-300">
											{runningRun.proposal_display_id ?? "no proposal"} ·{" "}
											{runningRun.stage} · {runningRun.model_used} ·{" "}
											{runningRun.activity ?? "—"}
										</div>
									</div>
								)}
							</section>

							{/* Recent runs */}
							<section>
								<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
									Recent runs
								</h3>
								{data.runs.length === 0 ? (
									<div className="text-xs text-gray-500">No runs yet.</div>
								) : (
									<ul className="space-y-1.5">
										{data.runs.slice(0, 12).map((r) => (
											<li
												key={r.id}
												className="text-xs border border-gray-200 dark:border-gray-800 rounded p-2"
											>
												<div className="flex justify-between items-baseline gap-2">
													<span
														className={`font-mono font-semibold ${runStatusColor(r.status)}`}
													>
														{r.proposal_display_id ?? "(no proposal)"} · {r.stage}
													</span>
													<span className="text-gray-500">
														{formatTimeAgo(r.started_at)}
													</span>
												</div>
												<div className="text-gray-600 dark:text-gray-400 mt-0.5">
													{r.model_used} · {r.status}
													{r.duration_ms != null
														? ` · ${(r.duration_ms / 1000).toFixed(1)}s`
														: ""}
													{r.cost_usd != null
														? ` · $${Number(r.cost_usd).toFixed(4)}`
														: ""}
												</div>
												{(r.output_summary || r.error_detail) && (
													<div
														className={`mt-1 whitespace-pre-wrap break-words ${
															r.error_detail
																? "text-red-700 dark:text-red-300"
																: "text-gray-700 dark:text-gray-300"
														}`}
													>
														{(r.error_detail ?? r.output_summary ?? "").slice(
															0,
															600,
														)}
													</div>
												)}
											</li>
										))}
									</ul>
								)}
							</section>

							{/* Recent messages */}
							<section>
								<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
									Recent messages
								</h3>
								{data.messages.length === 0 ? (
									<div className="text-xs text-gray-500">No messages.</div>
								) : (
									<ul className="space-y-1.5 max-h-64 overflow-y-auto">
										{data.messages.slice(0, 15).map((m) => (
											<li
												key={m.id}
												className="text-xs border border-gray-200 dark:border-gray-800 rounded p-2"
											>
												<div className="flex justify-between gap-2">
													<span className="font-mono text-gray-500">
														{m.from_agent}
														{" → "}
														{m.to_agent ?? m.channel ?? "(broadcast)"}
													</span>
													<span className="text-gray-500">
														{formatTimeAgo(m.created_at)}
													</span>
												</div>
												<div className="mt-0.5 text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">
													{m.message_content.slice(0, 600)}
												</div>
											</li>
										))}
									</ul>
								)}
							</section>
						</>
					)}
				</div>

				{/* Reminder form */}
				<footer className="border-t border-gray-200 dark:border-gray-800 p-3 space-y-2">
					<div className="flex items-center justify-between">
						<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
							Send reminder
						</h3>
						<select
							value={messageType}
							onChange={(e) => setMessageType(e.target.value)}
							className="text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-1.5 py-0.5"
						>
							<option value="reminder">reminder</option>
							<option value="nudge">nudge</option>
							<option value="instruction">instruction</option>
							<option value="text">text</option>
						</select>
					</div>
					<textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder={`Message ${identity}…`}
						className="w-full text-sm rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 h-20 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
					/>
					<div className="flex items-center justify-between gap-2">
						<div className="text-xs">
							{sendError && (
								<span className="text-red-600 dark:text-red-400">
									{sendError}
								</span>
							)}
							{sendOk && !sendError && (
								<span className="text-emerald-600 dark:text-emerald-400">
									{sendOk}
								</span>
							)}
						</div>
						<button
							type="button"
							onClick={send}
							disabled={!draft.trim() || sending}
							className="text-sm px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded"
						>
							{sending ? "Sending…" : "Send"}
						</button>
					</div>
				</footer>
			</aside>
		</div>
	);
};

export default AgentDetail;
