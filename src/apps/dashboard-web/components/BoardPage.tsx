import { useEffect, useState } from "react";
import { useSearchParams } from "wouter";
import type { Proposal } from "../hooks/useWebSocket";
import type { LaneMode } from "../lib/lanes";
import Board from "./Board";

interface BoardPageProps {
	proposals: Proposal[];
	statuses: string[];
	onProposalClick: (proposal: Proposal) => void;
}

export default function BoardPage({
	proposals,
	statuses,
	onProposalClick,
}: BoardPageProps) {
	const [searchParams, setSearchParams] = useSearchParams();
	const [highlightProposalId, setHighlightProposalId] = useState<string | null>(
		null,
	);
	const [laneMode, setLaneMode] = useState<LaneMode>("none");
	const [typeFilter, setTypeFilter] = useState<string | null>(null);
	const [domainFilter, setDomainFilter] = useState<string | null>(null);
	const laneStorageKey = "roadmap.board.lane";

	useEffect(() => {
		const storedLane =
			typeof window !== "undefined"
				? window.localStorage.getItem(laneStorageKey)
				: null;
		const paramLane = searchParams.get("lane");
		const paramType = searchParams.get("type");
		const paramDomain = searchParams.get("domain");

		const parseLane = (value: string | null): LaneMode | null => {
			if (value === "type" || value === "domain" || value === "none")
				return value;
			return null;
		};

		const nextLane = parseLane(paramLane) ?? parseLane(storedLane) ?? "none";
		setLaneMode(nextLane);
		setTypeFilter(paramType);
		setDomainFilter(paramDomain);

		if (typeof window !== "undefined") {
			window.localStorage.setItem(laneStorageKey, nextLane);
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

	// Filter proposals by type/domain if active
	const filteredProposals = proposals.filter((p) => {
		if (typeFilter && p.proposalType !== typeFilter) return false;
		if (domainFilter && p.domainId !== domainFilter) return false;
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

	return (
		<div className="container mx-auto px-4 py-8 transition-colors duration-200">
			{/* Lane Controls */}
			<div className="mb-4 flex items-center gap-4">
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

				<div className="ml-auto text-sm text-gray-500">
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
			/>
		</div>
	);
}
