import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../lib/api";

interface Dispatch {
	id: number;
	proposal_id: number;
	agent_identity: string;
	worker_identity: string | null;
	squad_name: string;
	dispatch_role: string;
	dispatch_status: string;
	offer_status: string;
	assigned_at: string;
	completed_at: string | null;
	claim_expires_at: string | null;
	claimed_at: string | null;
	renew_count: number;
	reissue_count: number;
	max_reissues: number;
	required_capabilities: Record<string, unknown>;
	metadata: Record<string, unknown>;
}

const STATUS_COLORS: Record<string, string> = {
	assigned: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
	active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
	blocked: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
	completed: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
	failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
	open: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
	cancelled: "bg-gray-100 text-gray-600 dark:bg-gray-900/30 dark:text-gray-500",
};

const OFFER_COLORS: Record<string, string> = {
	open: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
	claimed: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
	active: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
	delivered: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
	failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
	expired: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
};

function timeAgo(dateStr: string): string {
	const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function leaseCountdown(expiresAt: string | null, nowMs: number): string | null {
	if (!expiresAt) return null;
	const remaining = Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000);
	if (remaining <= 0) return "expired";
	return `expires in ${remaining}s`;
}

function ReissueBar({ count, max }: { count: number; max: number }) {
	const color = count === 0
		? "bg-green-500"
		: count >= max
			? "bg-red-500"
			: "bg-yellow-500";
	const pct = max === 0 ? 0 : Math.min((count / max) * 100, 100);
	return (
		<div>
			<span className="text-sm tabular-nums">
				{count}/{max}
			</span>
			<div className="mt-0.5 h-1 w-16 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
				<div
					className={`h-full ${color} rounded-full`}
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

const DispatchPage: React.FC = () => {
	const [dispatches, setDispatches] = useState<Dispatch[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filterStatus, setFilterStatus] = useState<string>("");
	const [filterOffer, setFilterOffer] = useState<string>("");
	const [showCompleted, setShowCompleted] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchDispatches();
			setDispatches(data as Dispatch[]);
		} catch (err) {
			console.error("Failed to fetch dispatches:", err);
			setError("Failed to load dispatches");
		} finally {
			setLoading(false);
		}
	}, []);

	// Auto-refresh every 15s (AC-6)
	useEffect(() => {
		void fetchData();
		const poll = setInterval(() => void fetchData(), 15000);
		return () => clearInterval(poll);
	}, [fetchData]);

	// 1-second ticker for lease countdown (AC-4)
	useEffect(() => {
		const tick = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(tick);
	}, []);

	const statuses = [...new Set(dispatches.map((d) => d.dispatch_status))].sort();
	const offerStatuses = [...new Set(dispatches.map((d) => d.offer_status))].sort();

	const filtered = dispatches.filter((d) => {
		if (!showCompleted && d.dispatch_status === "completed") return false;
		if (filterStatus && d.dispatch_status !== filterStatus) return false;
		if (filterOffer && d.offer_status !== filterOffer) return false;
		return true;
	});

	// Group by proposal
	const byProposal = new Map<number, Dispatch[]>();
	for (const d of filtered) {
		const list = byProposal.get(d.proposal_id) ?? [];
		list.push(d);
		byProposal.set(d.proposal_id, list);
	}

	if (loading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-gray-500">Loading dispatches...</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-4 text-red-600 bg-red-50 rounded flex items-center gap-3">
				{error}
				<button onClick={fetchData} className="text-sm underline">
					Retry
				</button>
			</div>
		);
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="flex items-center justify-between mb-6">
				<h1 className="text-2xl font-bold">Dispatches</h1>
				<div className="flex items-center gap-4">
					<div className="flex items-center gap-2">
						<label htmlFor="status-filter" className="text-sm text-gray-600">
							Status:
						</label>
						<select
							id="status-filter"
							value={filterStatus}
							onChange={(e) => setFilterStatus(e.target.value)}
							className="rounded border px-2 py-1 text-sm"
						>
							<option value="">All</option>
							{statuses.map((s) => (
								<option key={s} value={s}>
									{s}
								</option>
							))}
						</select>
					</div>
					<div className="flex items-center gap-2">
						<label htmlFor="offer-filter" className="text-sm text-gray-600">
							Offer:
						</label>
						<select
							id="offer-filter"
							value={filterOffer}
							onChange={(e) => setFilterOffer(e.target.value)}
							className="rounded border px-2 py-1 text-sm"
						>
							<option value="">All</option>
							{offerStatuses.map((s) => (
								<option key={s} value={s}>
									{s}
								</option>
							))}
						</select>
					</div>
					<label className="flex items-center gap-2 text-sm text-gray-600">
						<input
							type="checkbox"
							checked={showCompleted}
							onChange={(e) => setShowCompleted(e.target.checked)}
						/>
						Show completed
					</label>
					<span className="text-sm text-gray-500">{filtered.length} dispatches</span>
				</div>
			</div>

			{filtered.length === 0 ? (
				<div className="text-center py-8 text-gray-500">
					No dispatches match the current filters.
				</div>
			) : (
				<div className="space-y-6">
					{[...byProposal.entries()].map(([proposalId, pDispatches]) => (
						<div
							key={proposalId}
							className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
						>
							<div className="bg-gray-50 dark:bg-gray-800 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
								<span className="font-semibold">P{proposalId}</span>
								<span className="text-sm text-gray-500 ml-2">
									{pDispatches.length} dispatch{pDispatches.length > 1 ? "es" : ""}
								</span>
							</div>
							<table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
								<thead className="bg-gray-50 dark:bg-gray-800">
									<tr>
										<th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
											Agent
										</th>
										<th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
											Worker
										</th>
										<th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
											Role
										</th>
										<th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
											Squad
										</th>
										<th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
											Status
										</th>
										<th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
											Offer
										</th>
										<th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
											Age
										</th>
										<th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
											Reissues
										</th>
									</tr>
								</thead>
								<tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
									{pDispatches.map((d) => {
										const countdown =
											d.offer_status === "claimed"
												? leaseCountdown(d.claim_expires_at, nowMs)
												: null;
										return (
											<tr
												key={d.id}
												className="hover:bg-gray-50 dark:hover:bg-gray-800"
											>
												<td className="px-4 py-2 font-mono text-sm">
													{d.agent_identity || "—"}
												</td>
												<td className="px-4 py-2 font-mono text-sm">
													{d.worker_identity ? (
														d.worker_identity
													) : (
														<span className="text-gray-400 italic">empty</span>
													)}
												</td>
												<td className="px-4 py-2 text-sm">
													{d.dispatch_role}
												</td>
												<td className="px-4 py-2 text-sm text-gray-500">
													{d.squad_name}
												</td>
												<td className="px-4 py-2">
													<span
														className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
															STATUS_COLORS[d.dispatch_status] ??
															"bg-gray-100 text-gray-800"
														}`}
													>
														{d.dispatch_status}
													</span>
												</td>
												<td className="px-4 py-2">
													<span
														className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
															OFFER_COLORS[d.offer_status] ??
															"bg-gray-100 text-gray-800"
														}`}
													>
														{d.offer_status}
													</span>
													{countdown && (
														<div className="text-xs text-gray-500 mt-0.5 tabular-nums">
															{countdown}
														</div>
													)}
												</td>
												<td className="px-4 py-2 text-sm tabular-nums text-gray-500">
													{timeAgo(d.assigned_at)}
												</td>
												<td className="px-4 py-2">
													<ReissueBar
														count={d.reissue_count}
														max={d.max_reissues}
													/>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

export default DispatchPage;
