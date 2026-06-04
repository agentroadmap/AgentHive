/**
 * P435 — Operator Control Panel
 *
 * Unified observability and control surface for operators.
 * Shows the causal feed (dispatches → claims → runs → routes → budgets)
 * and provides stop controls: stop by dispatch/proposal/agency/host/worker/route.
 *
 * All stop actions require an operator token (Authorization: Bearer <token>).
 * The token is read from localStorage['operator.token'] or the bearer input field.
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FeedEvent {
	id: number;
	emitted_at: string;
	event_class: string;
	recommended_stop_scope: string | null;
	project_id: number | null;
	proposal_id: number | null;
	dispatch_id: number | null;
	claim_id: number | null;
	run_id: number | null;
	agency_id: string | null;
	worker_id: string | null;
	host: string | null;
	route: string | null;
	model: string | null;
	budget_scope: string | null;
	detail: Record<string, unknown> | null;
}

interface ControlDispatch {
	id: number;
	proposal_id: number;
	proposal_display_id: string | null;
	proposal_title: string | null;
	agent_identity: string;
	agency_identity: string | null;
	worker_identity: string | null;
	dispatch_status: string;
	offer_status: string;
	squad_name: string;
	dispatch_role: string;
}

type StopScope = "dispatch" | "proposal" | "agency" | "host" | "worker" | "provider_route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
	const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

const EVENT_CLASS_COLORS: Record<string, string> = {
	dispatch_assigned: "bg-blue-100 text-blue-800",
	dispatch_claimed: "bg-yellow-100 text-yellow-800",
	dispatch_completed: "bg-green-100 text-green-800",
	dispatch_failed: "bg-red-100 text-red-800",
	dispatch_cancelled: "bg-gray-100 text-gray-600",
	run_started: "bg-purple-100 text-purple-800",
	run_completed: "bg-green-100 text-green-800",
	run_failed: "bg-red-100 text-red-800",
	operator_stop: "bg-orange-100 text-orange-800",
	operator_suspend: "bg-orange-100 text-orange-800",
	operator_drain: "bg-orange-100 text-orange-800",
	operator_terminate: "bg-red-100 text-red-800",
	route_suspended: "bg-yellow-100 text-yellow-800",
	route_resumed: "bg-green-100 text-green-800",
};

const STATUS_BADGE: Record<string, string> = {
	assigned: "bg-blue-100 text-blue-800",
	active: "bg-green-100 text-green-800",
	claimed: "bg-yellow-100 text-yellow-800",
	failed: "bg-red-100 text-red-800",
	cancelled: "bg-gray-100 text-gray-600",
	completed: "bg-gray-100 text-gray-500",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function Badge({ text, cls }: { text: string; cls?: string }) {
	return (
		<span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls ?? "bg-gray-100 text-gray-700"}`}>
			{text}
		</span>
	);
}

function StopModal({
	defaultScope,
	defaultId,
	onClose,
	onStop,
}: {
	defaultScope?: StopScope;
	defaultId?: string;
	onClose: () => void;
	onStop: (scope: StopScope, id: string, reason: string) => Promise<void>;
}) {
	const [scope, setScope] = useState<StopScope>(defaultScope ?? "dispatch");
	const [scopeId, setScopeId] = useState(defaultId ?? "");
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleSubmit = async () => {
		if (!scopeId.trim()) { setErr("Scope ID is required"); return; }
		setBusy(true);
		setErr(null);
		try {
			await onStop(scope, scopeId.trim(), reason.trim());
			onClose();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
			<div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl p-6 w-full max-w-md space-y-4">
				<h2 className="text-lg font-semibold">Operator Stop</h2>

				<div>
					<label className="block text-sm font-medium mb-1">Scope type</label>
					<select
						value={scope}
						onChange={(e) => setScope(e.target.value as StopScope)}
						className="w-full rounded border px-3 py-1.5 text-sm"
					>
						{(["dispatch","proposal","agency","host","worker","provider_route"] as StopScope[]).map((s) => (
							<option key={s} value={s}>{s}</option>
						))}
					</select>
				</div>

				<div>
					<label className="block text-sm font-medium mb-1">Scope ID</label>
					<input
						type="text"
						value={scopeId}
						onChange={(e) => setScopeId(e.target.value)}
						placeholder={scope === "dispatch" ? "Dispatch numeric ID" : "Identity / ID"}
						className="w-full rounded border px-3 py-1.5 text-sm font-mono"
					/>
				</div>

				<div>
					<label className="block text-sm font-medium mb-1">Reason (optional)</label>
					<input
						type="text"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder="Runaway agent, budget exceeded, …"
						className="w-full rounded border px-3 py-1.5 text-sm"
					/>
				</div>

				{err && (
					<div className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{err}</div>
				)}

				<div className="flex justify-end gap-3">
					<button
						onClick={onClose}
						className="px-4 py-1.5 text-sm rounded border hover:bg-gray-50"
					>
						Cancel
					</button>
					<button
						onClick={handleSubmit}
						disabled={busy}
						className="px-4 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
					>
						{busy ? "Stopping…" : "Stop"}
					</button>
				</div>
			</div>
		</div>
	);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const ControlPage: React.FC = () => {
	const [activeTab, setActiveTab] = useState<"feed" | "dispatches" | "workers">("feed");
	const [events, setEvents] = useState<FeedEvent[]>([]);
	const [dispatches, setDispatches] = useState<ControlDispatch[]>([]);
	const [workers, setWorkers] = useState<any[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [stopModal, setStopModal] = useState<{
		scope?: StopScope;
		id?: string;
	} | null>(null);
	const [replayDispatchId, setReplayDispatchId] = useState("");
	const [replayEvents, setReplayEvents] = useState<any[] | null>(null);
	const [replayLoading, setReplayLoading] = useState(false);
	const [filterEventClass, setFilterEventClass] = useState("");
	const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const loadFeed = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchControlFeed({
				eventClass: filterEventClass || undefined,
				limit: 100,
			});
			setEvents(data);
			setLastRefresh(new Date());
		} catch (e) {
			setError((e as Error).message);
		}
	}, [filterEventClass]);

	const loadDispatches = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchControlDispatches();
			setDispatches(data);
			setLastRefresh(new Date());
		} catch (e) {
			setError((e as Error).message);
		}
	}, []);

	const loadWorkers = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchControlWorkers();
			setWorkers(data);
			setLastRefresh(new Date());
		} catch (e) {
			setError((e as Error).message);
		}
	}, []);

	const reload = useCallback(() => {
		setLoading(true);
		const p = activeTab === "feed"
			? loadFeed()
			: activeTab === "dispatches"
			? loadDispatches()
			: loadWorkers();
		void p.finally(() => setLoading(false));
	}, [activeTab, loadFeed, loadDispatches, loadWorkers]);

	useEffect(() => {
		reload();
		pollRef.current = setInterval(reload, 20_000);
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, [reload]);

	const handleStop = async (scope: StopScope, scopeId: string, reason: string) => {
		await apiClient.operatorStop({ scope_type: scope, scope_id: scopeId, reason: reason || undefined });
		reload();
	};

	const handleReplay = async () => {
		const id = Number(replayDispatchId.trim());
		if (!id) return;
		setReplayLoading(true);
		try {
			const rows = await apiClient.fetchControlReplay(id);
			setReplayEvents(rows);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setReplayLoading(false);
		}
	};

	const EVENT_CLASSES = [
		"", "dispatch_assigned","dispatch_claimed","dispatch_completed","dispatch_failed",
		"dispatch_cancelled","run_started","run_completed","run_failed",
		"operator_stop","operator_suspend","operator_drain","operator_terminate",
		"route_suspended","route_resumed",
	];

	return (
		<div className="container mx-auto px-4 py-6 space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">Operator Control Panel</h1>
				<div className="flex items-center gap-3">
					{lastRefresh && (
						<span className="text-xs text-gray-400">
							Refreshed {timeAgo(lastRefresh.toISOString())}
						</span>
					)}
					<button
						onClick={reload}
						disabled={loading}
						className="px-3 py-1.5 text-sm rounded border hover:bg-gray-50 disabled:opacity-50"
					>
						{loading ? "Loading…" : "Refresh"}
					</button>
					<button
						onClick={() => setStopModal({})}
						className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700"
					>
						Stop…
					</button>
				</div>
			</div>

			{error && (
				<div className="px-4 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded">
					{error}
				</div>
			)}

			{/* Tabs */}
			<div className="flex gap-1 border-b border-gray-200">
				{(["feed","dispatches","workers"] as const).map((tab) => (
					<button
						key={tab}
						onClick={() => setActiveTab(tab)}
						className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
							activeTab === tab
								? "border-blue-600 text-blue-600"
								: "border-transparent text-gray-500 hover:text-gray-800"
						}`}
					>
						{tab}
					</button>
				))}
			</div>

			{/* Feed tab */}
			{activeTab === "feed" && (
				<div className="space-y-3">
					<div className="flex items-center gap-3">
						<label className="text-sm text-gray-600">Event class:</label>
						<select
							value={filterEventClass}
							onChange={(e) => setFilterEventClass(e.target.value)}
							className="rounded border px-2 py-1 text-sm"
						>
							{EVENT_CLASSES.map((c) => (
								<option key={c} value={c}>{c || "All"}</option>
							))}
						</select>
						<span className="text-sm text-gray-400">{events.length} events</span>
					</div>

					{events.length === 0 ? (
						<div className="text-center py-12 text-gray-400 text-sm">No feed events</div>
					) : (
						<div className="overflow-x-auto rounded border border-gray-200">
							<table className="min-w-full divide-y divide-gray-200 text-xs">
								<thead className="bg-gray-50">
									<tr>
										{["Time","Event","Proposal","Dispatch","Agency","Worker","Route","Model","Stop Scope"].map((h) => (
											<th key={h} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">{h}</th>
										))}
										<th className="px-3 py-2" />
									</tr>
								</thead>
								<tbody className="bg-white divide-y divide-gray-100">
									{events.map((e) => (
										<tr key={e.id} className="hover:bg-gray-50">
											<td className="px-3 py-2 whitespace-nowrap text-gray-400 tabular-nums">
												{timeAgo(e.emitted_at)}
											</td>
											<td className="px-3 py-2 whitespace-nowrap">
												<Badge
													text={e.event_class}
													cls={EVENT_CLASS_COLORS[e.event_class]}
												/>
											</td>
											<td className="px-3 py-2 whitespace-nowrap font-mono text-gray-600">
												{e.proposal_id ? `P${e.proposal_id}` : "—"}
											</td>
											<td className="px-3 py-2 whitespace-nowrap font-mono">
												{e.dispatch_id ?? "—"}
											</td>
											<td className="px-3 py-2 whitespace-nowrap text-gray-500 max-w-[12ch] truncate">
												{e.agency_id ?? "—"}
											</td>
											<td className="px-3 py-2 whitespace-nowrap text-gray-500 max-w-[12ch] truncate">
												{e.worker_id ?? "—"}
											</td>
											<td className="px-3 py-2 whitespace-nowrap text-gray-500">
												{e.route ?? "—"}
											</td>
											<td className="px-3 py-2 whitespace-nowrap text-gray-500">
												{e.model ?? "—"}
											</td>
											<td className="px-3 py-2 whitespace-nowrap">
												{e.recommended_stop_scope && (
													<Badge text={e.recommended_stop_scope} cls="bg-orange-50 text-orange-700" />
												)}
											</td>
											<td className="px-3 py-2 whitespace-nowrap">
												{e.dispatch_id && (
													<button
														onClick={() => setStopModal({ scope: e.recommended_stop_scope as StopScope ?? "dispatch", id: String(e.dispatch_id) })}
														className="text-xs text-red-500 hover:underline"
													>
														Stop
													</button>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}

					{/* Replay panel */}
					<div className="border border-gray-200 rounded p-4 space-y-3">
						<h3 className="font-medium text-sm">Causal Replay</h3>
						<div className="flex gap-2">
							<input
								type="number"
								value={replayDispatchId}
								onChange={(e) => setReplayDispatchId(e.target.value)}
								placeholder="Dispatch ID"
								className="flex-1 rounded border px-3 py-1.5 text-sm font-mono"
							/>
							<button
								onClick={handleReplay}
								disabled={replayLoading || !replayDispatchId}
								className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
							>
								{replayLoading ? "Loading…" : "Replay"}
							</button>
							{replayEvents && (
								<button
									onClick={() => setReplayEvents(null)}
									className="px-3 py-1.5 text-sm rounded border hover:bg-gray-50"
								>
									Clear
								</button>
							)}
						</div>
						{replayEvents && (
							<div className="overflow-x-auto">
								<p className="text-xs text-gray-500 mb-2">
									{replayEvents.length} events in causal chain for dispatch #{replayDispatchId}
								</p>
								<table className="min-w-full divide-y divide-gray-200 text-xs border rounded">
									<thead className="bg-gray-50">
										<tr>
											{["Time","Event","Proposal","Dispatch","Run","Agency","Route","Model","Budget Period"].map((h) => (
												<th key={h} className="px-3 py-1.5 text-left font-medium text-gray-500 uppercase whitespace-nowrap">{h}</th>
											))}
										</tr>
									</thead>
									<tbody className="divide-y divide-gray-100">
										{replayEvents.map((r, i) => (
											<tr key={i} className="hover:bg-gray-50">
												<td className="px-3 py-1.5 tabular-nums text-gray-400">{r.emitted_at ? timeAgo(r.emitted_at) : "—"}</td>
												<td className="px-3 py-1.5">
													<Badge text={r.event_class ?? "—"} cls={EVENT_CLASS_COLORS[r.event_class] ?? "bg-gray-100 text-gray-600"} />
												</td>
												<td className="px-3 py-1.5 font-mono">{r.proposal_id ? `P${r.proposal_id}` : "—"}</td>
												<td className="px-3 py-1.5 font-mono">{r.dispatch_id ?? "—"}</td>
												<td className="px-3 py-1.5 font-mono">{r.run_id ?? "—"}</td>
												<td className="px-3 py-1.5 text-gray-500 max-w-[10ch] truncate">{r.agency_id ?? "—"}</td>
												<td className="px-3 py-1.5 text-gray-500">{r.route ?? r.route_provider ?? "—"}</td>
												<td className="px-3 py-1.5 text-gray-500">{r.model ?? r.model_used ?? "—"}</td>
												<td className="px-3 py-1.5 text-gray-500">{r.budget_period ?? "—"}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Dispatches tab */}
			{activeTab === "dispatches" && (
				<div className="space-y-3">
					<p className="text-sm text-gray-500">{dispatches.length} active dispatches</p>
					{dispatches.length === 0 ? (
						<div className="text-center py-12 text-gray-400 text-sm">No active dispatches</div>
					) : (
						<div className="overflow-x-auto rounded border border-gray-200">
							<table className="min-w-full divide-y divide-gray-200 text-sm">
								<thead className="bg-gray-50">
									<tr>
										{["ID","Proposal","Status","Agent","Worker","Squad","Role",""].map((h) => (
											<th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">{h}</th>
										))}
									</tr>
								</thead>
								<tbody className="bg-white divide-y divide-gray-100">
									{dispatches.map((d) => (
										<tr key={d.id} className="hover:bg-gray-50">
											<td className="px-4 py-2 font-mono text-gray-600">{d.id}</td>
											<td className="px-4 py-2 font-mono">
												{d.proposal_display_id ?? `P${d.proposal_id}`}
											</td>
											<td className="px-4 py-2">
												<Badge text={d.dispatch_status} cls={STATUS_BADGE[d.dispatch_status]} />
											</td>
											<td className="px-4 py-2 font-mono text-xs max-w-[14ch] truncate text-gray-600">
												{d.agent_identity}
											</td>
											<td className="px-4 py-2 font-mono text-xs max-w-[14ch] truncate text-gray-400">
												{d.worker_identity ?? "—"}
											</td>
											<td className="px-4 py-2 text-gray-500 text-xs">{d.squad_name}</td>
											<td className="px-4 py-2 text-gray-500 text-xs">{d.dispatch_role}</td>
											<td className="px-4 py-2">
												<button
													onClick={() => setStopModal({ scope: "dispatch", id: String(d.id) })}
													className="text-xs text-red-500 hover:underline"
												>
													Cancel
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}

			{/* Workers tab */}
			{activeTab === "workers" && (
				<div className="space-y-3">
					<p className="text-sm text-gray-500">{workers.length} active workers</p>
					{workers.length === 0 ? (
						<div className="text-center py-12 text-gray-400 text-sm">No active workers</div>
					) : (
						<div className="overflow-x-auto rounded border border-gray-200">
							<table className="min-w-full divide-y divide-gray-200 text-sm">
								<thead className="bg-gray-50">
									<tr>
										{["Worker","Agency","Status","Model","Dispatch","Proposal","Host",""].map((h) => (
											<th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">{h}</th>
										))}
									</tr>
								</thead>
								<tbody className="bg-white divide-y divide-gray-100">
									{workers.map((w, i) => (
										<tr key={i} className="hover:bg-gray-50">
											<td className="px-4 py-2 font-mono text-xs">{w.agent_identity}</td>
											<td className="px-4 py-2 text-xs text-gray-500 max-w-[12ch] truncate">
												{w.agency_identity ?? "—"}
											</td>
											<td className="px-4 py-2">
												<Badge text={w.status ?? "?"} cls={STATUS_BADGE[w.status] ?? "bg-gray-100 text-gray-600"} />
											</td>
											<td className="px-4 py-2 text-xs text-gray-500">{w.active_model ?? "—"}</td>
											<td className="px-4 py-2 font-mono text-xs">{w.dispatch_id ?? "—"}</td>
											<td className="px-4 py-2 font-mono text-xs">
												{w.proposal_id ? `P${w.proposal_id}` : "—"}
											</td>
											<td className="px-4 py-2 text-xs text-gray-500">{w.host ?? "—"}</td>
											<td className="px-4 py-2">
												<button
													onClick={() => setStopModal({ scope: "worker", id: w.agent_identity })}
													className="text-xs text-red-500 hover:underline"
												>
													Terminate
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}

			{/* Stop modal */}
			{stopModal !== null && (
				<StopModal
					defaultScope={stopModal.scope}
					defaultId={stopModal.id}
					onClose={() => setStopModal(null)}
					onStop={handleStop}
				/>
			)}
		</div>
	);
};

export default ControlPage;
