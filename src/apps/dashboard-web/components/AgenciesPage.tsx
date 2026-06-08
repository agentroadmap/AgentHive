import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "../lib/api";

type NamedAgent = {
	identity: string;
	role: string | null;
	provider: string | null;
	live: boolean | null;
	last_heartbeat_at: string | null;
	skills: unknown;
	in_flight: number | string | null;
};

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
	// roster + liaison metadata (agency-grouped roster view)
	is_liaison: boolean;
	named_agents: NamedAgent[];
	liaison_models: string[];
	liaison_route_model: string | null;
	liaison_live: boolean;
	agency_live: boolean;
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

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: string | number | null | undefined): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") return Number(value) || 0;
	return 0;
}

function skillCount(skills: unknown): number {
	if (Array.isArray(skills)) return skills.length;
	if (skills && typeof skills === "object") return Object.keys(skills).length;
	return 0;
}

function skillLabels(skills: unknown): string[] {
	if (Array.isArray(skills)) return skills.map((s) => String(s));
	if (skills && typeof skills === "object") return Object.keys(skills);
	return [];
}

function ageLabel(date: string | null): string {
	if (!date) return "never";
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

// Heartbeat-derived presence. Three states so a down liaison with live workers
// is visible rather than hidden behind a green/red binary.
type Presence = "live" | "stale" | "dead";

function PresenceDot({ presence, title }: { presence: Presence; title?: string }) {
	const color =
		presence === "live"
			? "bg-green-500"
			: presence === "stale"
				? "bg-amber-500"
				: "bg-gray-400";
	return (
		<span
			title={title}
			className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${color}`}
		/>
	);
}

function memberPresence(a: NamedAgent): Presence {
	return a.live === true ? "live" : "dead";
}

function agencyDisplayName(agency: AgencyRow): string {
	if (agency.display_name && agency.display_name.trim().length > 0) {
		return agency.display_name;
	}
	// strip the trailing ".a" liaison suffix for the human-facing agency name
	return agency.agency_id.replace(/\.a$/, "");
}

const AgenciesPage: React.FC = () => {
	const [agencies, setAgencies] = useState<AgencyRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filters, setFilters] = useState({ proposal: "", agency: "", route: "", severity: "" });
	const [expanded, setExpanded] = useState<string | null>(null);
	const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
	const [showInactive, setShowInactive] = useState(false);
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
				named_agents: asArray<NamedAgent>(row.named_agents),
				liaison_models: asArray<string>(row.liaison_models),
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
		for (const agency of agencies) {
			for (const route of agency.route_providers) routes.add(route);
		}
		return { routes: [...routes].sort() };
	}, [agencies]);

	// Only agency-parents (liaisons) are cards. Order live agencies first.
	const liaisonAgencies = useMemo(() => {
		return agencies
			.filter((a) => a.is_liaison)
			.filter((a) => showInactive || a.agency_live || a.named_agents.length > 0)
			.sort((a, b) => {
				if (a.agency_live !== b.agency_live) return a.agency_live ? -1 : 1;
				return agencyDisplayName(a).localeCompare(agencyDisplayName(b));
			});
	}, [agencies, showInactive]);

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
		<div className="mx-auto max-w-3xl px-4 py-6">
			<div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
				<div>
					<h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Agencies</h1>
					<div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
						{liaisonAgencies.length} {showInactive ? "" : "live "}agencies · liveness from heartbeat
					</div>
				</div>
				<div className="grid grid-cols-2 gap-2 lg:flex lg:items-center">
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
					<label className="col-span-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 lg:col-span-1">
						<input
							type="checkbox"
							checked={showInactive}
							onChange={(e) => setShowInactive(e.target.checked)}
						/>
						show inactive
					</label>
				</div>
			</div>

			{actionError && <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>}

			<div className="space-y-4">
				{liaisonAgencies.length === 0 && (
					<div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900">
						No live agencies. Toggle “show inactive” to see dormant ones.
					</div>
				)}
				{liaisonAgencies.map((agency) => {
					const isExpanded = expanded === agency.agency_id;
					const liaisonPresence: Presence = agency.liaison_live
						? "live"
						: agency.agency_live
							? "stale"
							: "dead";
					const liveMembers = agency.named_agents.filter((a) => a.live === true).length;
					const totalInFlight = agency.named_agents.reduce(
						(sum, a) => sum + asNumber(a.in_flight),
						0,
					);
					return (
						<section key={agency.agency_id} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
							{/* Agency header — the liaison and its heartbeat presence = agency liveness */}
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<PresenceDot presence={liaisonPresence} title={`liaison ${liaisonPresence}`} />
										<h2 className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">
											{agencyDisplayName(agency)}
										</h2>
										<span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
											{agency.provider ?? "unknown"}
										</span>
									</div>
									<div className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
										liaison {agency.agency_id} · {agency.host_id ?? "no host"} ·{" "}
										{agency.liaison_live
											? `heartbeat ${ageLabel(agency.last_heartbeat_at)} ago`
											: agency.agency_live
												? `liaison down (${ageLabel(agency.last_heartbeat_at)}), workers live`
												: `offline (${ageLabel(agency.last_heartbeat_at)})`}
									</div>
								</div>
								<button
									type="button"
									onClick={() => setExpanded(isExpanded ? null : agency.agency_id)}
									className="shrink-0 rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
								>
									{isExpanded ? "Close" : "Details"}
								</button>
							</div>

							<div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
								<Metric label="named agents" value={agency.named_agents.length} />
								<Metric label="live now" value={liveMembers} />
								<Metric label="in flight" value={totalInFlight} />
								<Metric label="free slots" value={asNumber(agency.free_claim_slots)} />
							</div>

							{/* Named agents roster */}
							<div className="mt-4">
								<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
									Named agents
								</h3>
								{agency.named_agents.length === 0 ? (
									<div className="text-sm text-gray-500">No permanent named agents assigned</div>
								) : (
									<div className="divide-y divide-gray-100 dark:divide-gray-800">
										{agency.named_agents.map((member) => {
											const agentKey = `${agency.agency_id}::${member.identity}`;
											const open = expandedAgent === agentKey;
											return (
												<div key={agentKey} className="py-2">
													<button
														type="button"
														onClick={() => setExpandedAgent(open ? null : agentKey)}
														className="flex w-full items-center gap-2 text-left"
													>
														<PresenceDot presence={memberPresence(member)} />
														<span className="font-medium text-gray-900 dark:text-gray-100">
															{member.identity}
														</span>
														<span className="text-xs text-gray-500 dark:text-gray-400">
															{member.role ?? "agent"}
														</span>
														<span className="ml-auto flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
															{asNumber(member.in_flight) > 0 && (
																<span className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
																	{asNumber(member.in_flight)} in flight
																</span>
															)}
															<span>{member.live ? "live" : ageLabel(member.last_heartbeat_at)}</span>
															<span className="text-gray-400">{skillCount(member.skills)} skills</span>
														</span>
													</button>
													{open && (
														<div className="mt-2 pl-4 text-sm">
															<div className="text-gray-500 dark:text-gray-400">
																provider: {member.provider ?? "—"} · last heartbeat:{" "}
																{member.last_heartbeat_at
																	? `${ageLabel(member.last_heartbeat_at)} ago`
																	: "never"}{" "}
																· workload: {asNumber(member.in_flight)} in flight
															</div>
															<div className="mt-1">
																<span className="text-gray-500 dark:text-gray-400">capabilities: </span>
																{skillLabels(member.skills).length === 0 ? (
																	<span className="text-gray-400">none recorded</span>
																) : (
																	<span className="flex flex-wrap gap-1 pt-1">
																		{skillLabels(member.skills).map((s) => (
																			<span key={s} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
																				{s}
																			</span>
																		))}
																	</span>
																)}
															</div>
														</div>
													)}
												</div>
											);
										})}
									</div>
								)}
							</div>

							<div className="mt-4 flex flex-wrap gap-2">
								<ActionButton onClick={() => sendAction(agency.agency_id, "liaison_pause")}>pause</ActionButton>
								<ActionButton onClick={() => sendAction(agency.agency_id, "liaison_resume")}>resume</ActionButton>
								<ActionButton onClick={() => sendAction(agency.agency_id, "liaison_drain")}>drain</ActionButton>
								<ActionButton danger onClick={() => sendAction(agency.agency_id, "agency_retire")}>retire</ActionButton>
							</div>

							{isExpanded && (
								<div className="mt-5 space-y-5 border-t border-gray-200 pt-4 dark:border-gray-800">
									{/* Liaison capabilities + models */}
									<div>
										<h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
											Liaison · {agency.provider ?? "unknown"} models &amp; capabilities
										</h3>
										<div className="text-sm text-gray-600 dark:text-gray-300">
											<div>
												route model:{" "}
												<span className="font-medium">{agency.liaison_route_model ?? "—"}</span>
											</div>
											<div className="mt-1">supported models:</div>
											{agency.liaison_models.length === 0 ? (
												<div className="text-gray-400">none recorded on this liaison</div>
											) : (
												<div className="mt-1 flex flex-wrap gap-1">
													{agency.liaison_models.map((m) => (
														<span key={m} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
															{m}
														</span>
													))}
												</div>
											)}
										</div>
									</div>
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
			<h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Work history (last 24h)</h3>
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
