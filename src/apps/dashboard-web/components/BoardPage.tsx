import { useEffect, useState } from "react";
import { useSearchParams } from "wouter";
import type { Proposal } from "../hooks/useWebSocket";
import type { LaneMode } from "../lib/lanes";
import Board from "./Board";

interface BoardPageProps {
	proposals: Proposal[];
	statuses: string[];
	activeWorkflow?: string;
	onWorkflowChange?: (workflow: string) => void;
	onProposalClick: (proposal: Proposal) => void;
	columnDwell?: Record<string, number | null>;
}

const MATURITY_OPTIONS = [
	{ value: "non-obsolete", label: "All except obsolete" },
	{ value: "all", label: "All including obsolete" },
	{ value: "new", label: "New only" },
	{ value: "active", label: "Active only" },
	{ value: "mature", label: "Mature only" },
	{ value: "obsolete", label: "Obsolete only" },
] as const;

type MaturityFilter = (typeof MATURITY_OPTIONS)[number]["value"];

const isMaturityFilter = (v: string | null): v is MaturityFilter =>
	v !== null && MATURITY_OPTIONS.some((o) => o.value === v);

export default function BoardPage({
	proposals,
	statuses,
	activeWorkflow = "Standard RFC",
	onWorkflowChange,
	onProposalClick,
	columnDwell,
}: BoardPageProps) {
	const [searchParams, setSearchParams] = useSearchParams();
	const [highlightProposalId, setHighlightProposalId] = useState<string | null>(
		null,
	);
	const [laneMode, setLaneMode] = useState<LaneMode>("none");
	const [typeFilter, setTypeFilter] = useState<string | null>(null);
	const [domainFilter, setDomainFilter] = useState<string | null>(null);
	const [statusFilter, setStatusFilter] = useState<string | null>(null);
	const [maturityFilter, setMaturityFilter] =
		useState<MaturityFilter>("non-obsolete");
	const [searchText, setSearchText] = useState("");
	const [localWorkflow, setLocalWorkflow] = useState(activeWorkflow);
	const laneStorageKey = "roadmap.board.lane";
	const maturityStorageKey = "roadmap.board.maturity";
	const workflowStorageKey = "roadmap.board.workflow";

	useEffect(() => {
		const storedLane =
			typeof window !== "undefined"
				? window.localStorage.getItem(laneStorageKey)
				: null;
		const storedMaturity =
			typeof window !== "undefined"
				? window.localStorage.getItem(maturityStorageKey)
				: null;
		const paramLane = searchParams.get("lane");
		const paramType = searchParams.get("type");
		const paramDomain = searchParams.get("domain");
		const paramStatus = searchParams.get("status");
		const paramMaturity = searchParams.get("maturity");

		const parseLane = (value: string | null): LaneMode | null => {
			if (value === "type" || value === "domain" || value === "none")
				return value;
			return null;
		};

		const nextLane = parseLane(paramLane) ?? parseLane(storedLane) ?? "none";
		const nextMaturity: MaturityFilter = isMaturityFilter(paramMaturity)
			? paramMaturity
			: isMaturityFilter(storedMaturity)
				? storedMaturity
				: "non-obsolete";

		setLaneMode(nextLane);
		setTypeFilter(paramType);
		setDomainFilter(paramDomain);
		setStatusFilter(paramStatus);
		setMaturityFilter(nextMaturity);

		if (typeof window !== "undefined") {
			window.localStorage.setItem(laneStorageKey, nextLane);
			window.localStorage.setItem(maturityStorageKey, nextMaturity);
		}
	}, [searchParams]);

	useEffect(() => {
		const highlight = searchParams.get("highlight");
		if (highlight) {
			setHighlightProposalId(highlight);
			setSearchParams(
				(params: URLSearchParams) => {
					params.delete("highlight");
					return params;
				},
				{ replace: true },
			);
		}
	}, [searchParams, setSearchParams]);

	const handleLaneChange = (mode: LaneMode) => {
		setLaneMode(mode);
		setTypeFilter(null);
		setDomainFilter(null);
		if (typeof window !== "undefined") {
			window.localStorage.setItem(laneStorageKey, mode);
		}
		setSearchParams(
			(params: URLSearchParams) => {
				if (mode === "none") {
					params.delete("lane");
				} else {
					params.set("lane", mode);
				}
				params.delete("type");
				params.delete("domain");
				return params;
			},
			{ replace: true },
		);
	};

	const matchesMaturity = (p: Proposal): boolean => {
		const m = (p.maturity ?? "").toLowerCase();
		switch (maturityFilter) {
			case "all":
				return true;
			case "non-obsolete":
				return m !== "obsolete";
			default:
				return m === maturityFilter;
		}
	};

	// Filter proposals by type/domain/text/maturity if active
	const filteredProposals = proposals.filter((p) => {
		if (typeFilter && p.proposalType !== typeFilter) return false;
		if (domainFilter && p.domainId !== domainFilter) return false;
		if (!matchesMaturity(p)) return false;
		if (searchText) {
			const q = searchText.toLowerCase();
			const idMatch = p.displayId?.toLowerCase().includes(q);
			const titleMatch = p.title?.toLowerCase().includes(q);
			if (!idMatch && !titleMatch) return false;
		}
		return true;
	});

	// Derive lane values from proposals
	const proposalTypes = [
		...new Set(proposals.map((p) => p.proposalType)),
	].sort();
	const domains = [...new Set(proposals.map((p) => p.domainId))].sort();
	const laneSelectId = "board-lane-mode";
	const typeSelectId = "board-type-filter";
	const domainSelectId = "board-domain-filter";
	const statusSelectId = "board-status-filter";
	const maturitySelectId = "board-maturity-filter";

	const updateParam = (key: string, value: string | null) => {
		setSearchParams(
			(params: URLSearchParams) => {
				if (value === null || value === "") {
					params.delete(key);
				} else {
					params.set(key, value);
				}
				return params;
			},
			{ replace: true },
		);
	};

	const handleStatusChange = (next: string) => {
		const value = next === "" ? null : next;
		setStatusFilter(value);
		updateParam("status", value);
	};

	const handleMaturityChange = (next: MaturityFilter) => {
		setMaturityFilter(next);
		if (typeof window !== "undefined") {
			window.localStorage.setItem(maturityStorageKey, next);
		}
		updateParam("maturity", next === "non-obsolete" ? null : next);
	};

	const handleWorkflowSelect = (workflow: string) => {
		setLocalWorkflow(workflow);
		onWorkflowChange?.(workflow);
	};

	const focusStatus =
		statusFilter && statuses.includes(statusFilter) ? statusFilter : null;

	return (
		<div className="container mx-auto px-0 sm:px-4 py-3 sm:py-8 transition-colors duration-200">
			{/* Workflow Selection */}
			<div className="mb-3 px-3 sm:px-0 flex items-center gap-2">
				<label
					htmlFor="board-workflow-select"
					className="text-sm font-medium text-gray-600 dark:text-gray-400"
				>
					Workflow:
				</label>
				<select
					id="board-workflow-select"
					value={localWorkflow}
					onChange={(e) => handleWorkflowSelect(e.target.value)}
					className="rounded border px-2 py-1 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200"
				>
					<option value="Standard RFC">Standard RFC</option>
					<option value="Hotfix">Hotfix</option>
				</select>
			</div>

			{/* Lane Controls */}
			<div className="mb-4 px-3 sm:px-0 flex flex-wrap items-center gap-x-4 gap-y-2">
				{/* Search filter */}
				<input
					id="board-search"
					type="text"
					placeholder="Filter by # or title…"
					value={searchText}
					onChange={(e) => setSearchText(e.target.value)}
					className="rounded border px-3 py-1.5 text-sm w-full sm:w-64 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200 dark:placeholder-gray-400"
				/>
				<div className="flex items-center gap-2">
					<label
						htmlFor={laneSelectId}
						className="text-sm font-medium text-gray-600"
					>
						Lane:
					</label>
					<select
						id={laneSelectId}
						value={laneMode}
						onChange={(e) => handleLaneChange(e.target.value as LaneMode)}
						className="rounded border px-2 py-1 text-sm"
					>
						<option value="none">None</option>
						<option value="type">By Type</option>
						<option value="domain">By Domain</option>
					</select>
				</div>

				{laneMode === "type" && (
					<div className="flex items-center gap-2">
						<label
							htmlFor={typeSelectId}
							className="text-sm font-medium text-gray-600"
						>
							Type:
						</label>
						<select
							id={typeSelectId}
							value={typeFilter || ""}
							onChange={(e) => setTypeFilter(e.target.value || null)}
							className="rounded border px-2 py-1 text-sm"
						>
							<option value="">All</option>
							{proposalTypes.map((t) => (
								<option key={t} value={t}>
									{t}
								</option>
							))}
						</select>
					</div>
				)}

				{laneMode === "domain" && (
					<div className="flex items-center gap-2">
						<label
							htmlFor={domainSelectId}
							className="text-sm font-medium text-gray-600"
						>
							Domain:
						</label>
						<select
							id={domainSelectId}
							value={domainFilter || ""}
							onChange={(e) => setDomainFilter(e.target.value || null)}
							className="rounded border px-2 py-1 text-sm"
						>
							<option value="">All</option>
							{domains.map((d) => (
								<option key={d} value={d}>
									{d}
								</option>
							))}
						</select>
					</div>
				)}

				<div className="flex items-center gap-2">
					<label
						htmlFor={statusSelectId}
						className="text-sm font-medium text-gray-600"
					>
						Status:
					</label>
					<select
						id={statusSelectId}
						value={statusFilter ?? ""}
						onChange={(e) => handleStatusChange(e.target.value)}
						className="rounded border px-2 py-1 text-sm"
					>
						<option value="">All states</option>
						{statuses.map((s) => (
							<option key={s} value={s}>
								{s}
							</option>
						))}
					</select>
				</div>

				<div className="flex items-center gap-2">
					<label
						htmlFor={maturitySelectId}
						className="text-sm font-medium text-gray-600"
					>
						Maturity:
					</label>
					<select
						id={maturitySelectId}
						value={maturityFilter}
						onChange={(e) =>
							handleMaturityChange(e.target.value as MaturityFilter)
						}
						className="rounded border px-2 py-1 text-sm"
					>
						{MATURITY_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				</div>

				<div className="sm:ml-auto text-sm text-gray-500 dark:text-gray-400">
					{filteredProposals.length} proposals
				</div>
			</div>

			<Board
				proposals={filteredProposals}
				statuses={statuses}
				onProposalClick={onProposalClick}
				highlightProposalId={highlightProposalId}
				laneMode={laneMode}
				proposalTypes={proposalTypes}
				domains={domains}
				focusStatus={focusStatus}
				columnDwell={columnDwell}
			/>
		</div>
	);
}
