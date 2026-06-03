import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "../lib/api";

type AgencyRow = {
	agency_id: string;
	display_name: string | null;
	provider: string | null;
	host_id: string | null;
	status: string;
	last_heartbeat_at: string | null;
	silence_seconds: string | number | null;
	capacity_windows: unknown;
	in_flight_claims: number | string;
	open_assistance: number | string;
	oldest_open_assistance_at: string | null;
	active_claims: AgencyClaim[];
	assistance: AssistanceRequest[];
	claim_timeline: ClaimEvent[];
	free_claim_slots: number | string;
	recent_refusals: number | string;
	unacked_old: number | string;
	recent_rejects: number | string;
	sequence_gap_count: number | string;
	route_providers: string[];
	severities: string[];
};

type AgencyClaim = {
	id: number | string;
	proposal_id?: number | string | null;
	proposal_display_id?: string | null;
	role?: string | null;
	worker_identity?: string | null;
	agent_identity?: string | null;
	route_provider?: string | null;
	dispatch_status?: string | null;
	offer_status?: string | null;
	assigned_at?: string | null;
	claim_expires_at?: string | null;
	metadata?: Record<string, unknown> | null;
};

type AssistanceRequest = {
	id: number | string;
	briefing_id: string;
	task_id: string;
	agent_identity: string;
	error_signature: string | null;
	opened_at: string;
	age_minutes: string | number;
	severity: string | null;
};

type ClaimEvent = {
	message_id: string;
	kind: "progress_note" | "claim_status";
	sequence: string | number;
	signed_at: string;
	ack_outcome: string | null;
	payload: Record<string, unknown>;
};

const STATUS_COLORS: Record<string, string> = {
	active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
	throttled: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
	paused: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
	dormant: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
	offline: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: string | number | null | undefined): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") return Number(value) || 0;
	return 0;
}

function ageLabel(date: string | null): string {
	if (!date) return "none";
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function CapacityBars({ windows }: { windows: unknown }) {
	const items = asArray<Record<string, unknown>>(windows).slice(0, 4);
	if (items.length === 0) {
		return <div className="text-xs text-gray-500">No capacity windows</div>;
	}
	return (
		<div className="space-y-2">
			{items.map((window, index) => {
				const limit = asNumber(window.limit as string | number | null) || 1;
				const used = asNumber((window.used ?? window.consumed) as string | number | null);
				const label = String(window.name ?? window.window ?? `window ${index + 1}`);
				const pct = Math.min(Math.max((used / limit) * 100, 0), 100);
				return (
					<div key={`${label}-${JSON.stringify(window)}`}>
						<div className="mb-1 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
							<span className="truncate">{label}</span>
							<span className="tabular-nums">{used}/{limit}</span>
						</div>
						<div className="h-1.5 overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
							<div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
						</div>
					</div>
				);
			})}
		</div>
	);
}

const AgenciesPage: React.FC = () => {
	const [agencies, setAgencies] = useState<AgencyRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filters, setFilters] = useState({ proposal: "", agency: "", route: "", severity: "" });
	const [expanded, setExpanded] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchAgencies(filters);
			setAgencies(data.map((row) => ({
				...row,
				active_claims: asArray<AgencyClaim>(row.active_claims),
				assistance: asArray<AssistanceRequest>(row.assistance),
				claim_timeline: asArray<ClaimEvent>(row.claim_timeline),
				route_providers: asArray<string>(row.route_providers),
				severities: asArray<string>(row.severities),
			}) as AgencyRow));
		} catch (err) {
			console.error("Failed to fetch agencies:", err);
			setError("Failed to load agencies");
		} finally {
			setLoading(false);
		}
	}, [filters]);

	useEffect(() => {
		void fetchData();
		const timer = setInterval(() => void fetchData(), 5000);
		return () => clearInterval(timer);
	}, [fetchData]);

	const filterOptions = useMemo(() => {
		const routes = new Set<string>();
		const severities = new Set<string>();
		for (const agency of agencies) {
			for (const route of agency.route_providers) routes.add(route);
			for (const severity of agency.severities) severities.add(severity);
		}
		return {
			routes: [...routes].sort(),
			severities: [...severities].sort(),
		};
	}, [agencies]);

	const sendAction = async (agencyId: string, action: AgencyAction, claimId?: string | number) => {
		try {
			setActionError(null);
			await apiClient.sendAgencyAction(agencyId, {
				action,
				claim_id: claimId == null ? undefined : String(claimId),
				reason: "operator dashboard",
			});
			await fetchData();
		} catch (err) {
			console.error("Failed to send agency action:", err);
			setActionError("Action failed or operator token is missing");
		}
	};

	if (loading) {
		return <div className="p-6 text-gray-500">Loading agencies...</div>;
	}

	if (error) {
		return (
			<div className="p-6 text-red-700 dark:text-red-300">
				{error}
				<button type="button" onClick={fetchData} className="ml-3 underline">
					Retry
				</button>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-7xl px-4 py-6">
			<div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
				<div>
					<h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Agencies</h1>
					<div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
						{agencies.length} visible agencies
					</div>
				</div>
				<div className="grid grid-cols-2 gap-2 lg:flex lg:items-center">
					<input
						placeholder="Proposal"
						value={filters.proposal}
						onChange={(e) => setFilters((f) => ({ ...f, proposal: e.target.value }))}
						className="rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
					/>
					<input
						placeholder="Agency"
						value={filters.agency}
						onChange={(e) => setFilters((f) => ({ ...f, agency: e.target.value }))}
						className="rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
					/>
					<select
						value={filters.route}
						onChange={(e) => setFilters((f) => ({ ...f, route: e.target.value }))}
						className="rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
					>
						<option value="">All routes</option>
						{filterOptions.routes.map((route) => <option key={route} value={route}>{route}</option>)}
					</select>
					<select
						value={filters.severity}
						onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
						className="rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
					>
						<option value="">All severities</option>
						{filterOptions.severities.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
					</select>
				</div>
			</div>

			{actionError && <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>}

			<div className="grid gap-4 xl:grid-cols-2">
				{agencies.map((agency) => {
					const status = agency.status?.toLowerCase() || "dormant";
					const oldestAge = ageLabel(agency.oldest_open_assistance_at);
					const isExpanded = expanded === agency.agency_id;
					return (
						<section key={agency.agency_id} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<h2 className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">
											{agency.display_name || agency.agency_id}
										</h2>
										<span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status] ?? STATUS_COLORS.dormant}`}>
											{status}
										</span>
									</div>
									<div className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
										{agency.agency_id} · {agency.provider ?? "unknown"} · {agency.host_id ?? "no host"}
									</div>
								</div>
								<button
									type="button"
									onClick={() => setExpanded(isExpanded ? null : agency.agency_id)}
									className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
								>
									{isExpanded ? "Close" : "Details"}
								</button>
							</div>

							<div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
								<Metric label="free slots" value={asNumber(agency.free_claim_slots)} />
								<Metric label="in flight" value={asNumber(agency.in_flight_claims)} />
								<Metric label="assistance" value={asNumber(agency.open_assistance)} />
								<Metric label="oldest" value={oldestAge} />
							</div>

							<div className="mt-4">
								<CapacityBars windows={agency.capacity_windows} />
							</div>

							<div className="mt-4 flex flex-wrap gap-2">
								<ActionButton onClick={() => sendAction(agency.agency_id, "liaison_pause")}>pause</ActionButton>
								<ActionButton onClick={() => sendAction(agency.agency_id, "liaison_resume")}>resume</ActionButton>
								<ActionButton onClick={() => sendAction(agency.agency_id, "liaison_drain")}>drain</ActionButton>
								<ActionButton danger onClick={() => sendAction(agency.agency_id, "agency_retire")}>retire</ActionButton>
							</div>

							{isExpanded && (
								<div className="mt-5 space-y-5 border-t border-gray-200 pt-4 dark:border-gray-800">
									<div className="grid grid-cols-3 gap-3 text-sm">
										<Metric label="rejects" value={asNumber(agency.recent_rejects)} />
										<Metric label="unacked old" value={asNumber(agency.unacked_old)} />
										<Metric label="sequence gaps" value={asNumber(agency.sequence_gap_count)} />
									</div>
									<ClaimList claims={agency.active_claims} onRevoke={(claimId) => sendAction(agency.agency_id, "claim_revoke", claimId)} />
									<AssistanceList requests={agency.assistance} />
									<Timeline events={agency.claim_timeline} />
								</div>
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
};

type AgencyAction = "liaison_pause" | "liaison_resume" | "liaison_drain" | "claim_revoke" | "agency_retire";

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="rounded border border-gray-200 p-3 dark:border-gray-800">
			<div className="text-xs uppercase text-gray-500 dark:text-gray-400">{label}</div>
			<div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{value}</div>
		</div>
	);
}

function ActionButton({ children, danger, onClick }: { children: React.ReactNode; danger?: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`rounded px-3 py-1.5 text-sm font-medium ${
				danger
					? "bg-red-600 text-white hover:bg-red-700"
					: "bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900"
			}`}
		>
			{children}
		</button>
	);
}

function ClaimList({ claims, onRevoke }: { claims: AgencyClaim[]; onRevoke: (claimId: string | number) => void }) {
	return (
		<div>
			<h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">In-flight claims</h3>
			{claims.length === 0 ? (
				<div className="text-sm text-gray-500">No in-flight claims</div>
			) : (
				<div className="space-y-2">
					{claims.map((claim) => (
						<div key={String(claim.id)} className="rounded border border-gray-200 p-3 text-sm dark:border-gray-800">
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<div className="truncate font-medium text-gray-900 dark:text-gray-100">
										{claim.proposal_display_id ?? `P${claim.proposal_id ?? "?"}`} · {claim.role ?? "role"}
									</div>
									<div className="truncate text-gray-500 dark:text-gray-400">
										{claim.worker_identity ?? claim.agent_identity ?? "unassigned"} · {claim.route_provider ?? "no route"} · {claim.dispatch_status}/{claim.offer_status}
									</div>
								</div>
								<ActionButton danger onClick={() => onRevoke(claim.id)}>revoke</ActionButton>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function AssistanceList({ requests }: { requests: AssistanceRequest[] }) {
	return (
		<details className="rounded border border-gray-200 p-3 dark:border-gray-800">
			<summary className="cursor-pointer text-sm font-semibold text-gray-900 dark:text-gray-100">
				Assistance requests ({requests.length})
			</summary>
			<div className="mt-3 space-y-2">
				{requests.length === 0 ? <div className="text-sm text-gray-500">None open</div> : requests.map((req) => (
					<div key={String(req.id)} className="text-sm">
						<span className="font-medium">{req.severity ?? "unknown"}</span>{" "}
						<span className="text-gray-500">{Math.floor(asNumber(req.age_minutes))}m · {req.agent_identity} · {req.error_signature ?? req.task_id}</span>
					</div>
				))}
			</div>
		</details>
	);
}

function Timeline({ events }: { events: ClaimEvent[] }) {
	return (
		<div>
			<h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Claim timeline</h3>
			{events.length === 0 ? (
				<div className="text-sm text-gray-500">No progress_note or claim_status events in the last 24h</div>
			) : (
				<div className="max-h-64 space-y-2 overflow-auto">
					{events.map((event) => (
						<div key={event.message_id} className="rounded bg-gray-50 p-2 text-sm dark:bg-gray-800">
							<div className="flex items-center justify-between gap-2">
								<span className="font-medium">{event.kind}</span>
								<span className="text-xs text-gray-500">{new Date(event.signed_at).toLocaleString()}</span>
							</div>
							<div className="mt-1 text-gray-600 dark:text-gray-300">
								{String(event.payload.summary ?? event.payload.status ?? event.payload.claim_id ?? "event")}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export default AgenciesPage;
