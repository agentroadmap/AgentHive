import { useEffect, useMemo, useState } from "react";
import { Route, Switch } from "wouter";
import type {
	Proposal,
	Agent as SharedAgent,
	Channel as SharedChannel,
} from "../../shared/types";
import AchievementsView from "./components/AchievementsView";
import ActivityFeed from "./components/ActivityFeed";
import AgenciesPage from "./components/AgenciesPage";
import AgentsPage from "./components/AgentsPage";
import AppNav from "./components/AppNav";
import BoardPage from "./components/BoardPage";
import ChannelsPage from "./components/ChannelsPage";
import DashboardPage from "./components/DashboardPage";
import DecisionsPage from "./components/DecisionsPage";
import DirectivesPage from "./components/DirectivesPage";
import ConfigPage from "./components/ConfigPage";
import ControlPage from "./components/ControlPage";
import DispatchPage from "./components/DispatchPage";
import DocumentsPage from "./components/DocumentsPage";
import EfficiencyView from "./components/EfficiencyView";
import FleetView from "./components/FleetView";
import IdentityView from "./components/IdentityView";
import KnowledgePage from "./components/KnowledgePage";
import MapPage from "./components/MapPage";
import NotFoundPage from "./components/NotFoundPage";
import PlatformView from "./components/PlatformView";
import PortfolioHome from "./components/PortfolioHome";
import ProposalDetailsModal from "./components/ProposalDetailsModal";
import ProposalsPage from "./components/ProposalsPage";
import RoutesPage from "./components/RoutesPage";
import SettingsPage from "./components/SettingsPage";
import StatisticsPage from "./components/StatisticsPage";
import TeamsPage from "./components/TeamsPage";
import { useBoardColumns } from "./hooks/useBoardColumns";
import {
	useWebSocket,
	type Agent as WebSocketAgent,
	type Channel as WebSocketChannel,
	type Proposal as WebSocketProposal,
} from "./hooks/useWebSocket";
import {
	buildProposalSelectionAliases,
	mergeProposalDetailState,
	type ProposalWithSelectionAliases,
	proposalMatchesSelection,
} from "./lib/proposal-detail-selection";

function toSharedProposal(proposal: WebSocketProposal): Proposal {
	const labels = proposal.tags
		? proposal.tags
				.split(",")
				.map((label) => label.trim())
				.filter((label) => label.length > 0 && label !== "[object Object]")
		: [];
	return {
		id: proposal.displayId || proposal.id,
		title: proposal.title,
		status: proposal.status,
		assignee: [],
		createdDate: proposal.createdDate || proposal.createdAt,
		updatedDate: proposal.updatedDate || proposal.updatedAt || proposal.createdDate || proposal.createdAt,
		labels,
		dependencies: proposal.parentId ? [proposal.parentId] : [],
		summary: proposal.summary ?? proposal.bodyMarkdown ?? undefined,
		motivation: proposal.motivation ?? undefined,
		design: proposal.design ?? proposal.processLogic ?? undefined,
		drawbacks: proposal.drawbacks ?? undefined,
		alternatives: proposal.alternatives ?? undefined,
		dependency_note: proposal.dependencyNote ?? undefined,
		description: proposal.summary ?? proposal.bodyMarkdown ?? undefined,
		domainId: proposal.domainId,
		proposalType: proposal.proposalType,
		category: proposal.category,
		priority:
			proposal.priority === "high" ||
			proposal.priority === "medium" ||
			proposal.priority === "low"
				? proposal.priority
				: undefined,
		// Pass through full proposal data for detail modal
		implementationPlan: proposal.implementationPlan,
		implementationNotes: proposal.implementationNotes,
		finalSummary: proposal.finalSummary,
		acceptanceCriteriaItems: proposal.acceptanceCriteriaItems,
		needs_capabilities: proposal.needsCapabilities,
		required_capabilities: proposal.requiredCapabilities,
		parentProposalId: proposal.parentId ?? undefined,
		parentProposalTitle: proposal.parentProposalTitle,
		maturity: proposal.maturity,
		obsoleted_reason: proposal.obsoleted_reason,
		rawContent: proposal.rawContent,
		budgetLimitUsd: proposal.budgetLimitUsd,
		liveActivity: proposal.liveActivity,
		displayId: proposal.displayId,
		websocketId: proposal.websocketId ?? proposal.id,
		tags: proposal.tags,
		gateScannerPaused: proposal.gateScannerPaused,
		gatePausedBy: proposal.gatePausedBy ?? undefined,
		gatePausedAt: proposal.gatePausedAt,
		gatePausedReason: proposal.gatePausedReason,
		selectionAliases: buildProposalSelectionAliases(
			proposal.displayId,
			proposal.websocketId,
			proposal.id,
		),
	} as Proposal & Record<string, unknown>;
}

function toSharedAgent(agent: WebSocketAgent): SharedAgent {
	return {
		name: agent.agentId || agent.identity,
		identity: agent.identity,
		capabilities: [],
		trustScore: 0,
		lastSeen: agent.lastSeenAt,
		status: agent.isActive ? "active" : "offline",
	};
}

function toSharedChannel(channel: WebSocketChannel): SharedChannel {
	return {
		name: channel.channelName,
		fileName: channel.channelName,
		type: "group",
	};
}

export default function App() {
	const {
		connected,
		proposals,
		agents,
		channels,
		notifications,
		bellEnabled,
		boardReloadSignal,
	} = useWebSocket();
	const [activeWorkflow, setActiveWorkflow] = useState(() => {
		if (typeof window !== "undefined") {
			return (
				window.localStorage.getItem("roadmap.board.workflow") || "Standard RFC"
			);
		}
		return "Standard RFC";
	});

	// Load dynamic column definitions based on active workflow.
	// Pass connected for reconnect-driven re-fetch and boardReloadSignal for
	// server-side workflow/stage changes — both routed through the shared WS.
	const { columns: boardColumns } = useBoardColumns(activeWorkflow, connected, boardReloadSignal);

	// Convert column objects to status strings for BoardPage/Board backward compat
	const statuses = boardColumns.map((col) => col.stage_name);

	// Build dwell map for column header indicators (avg days per stage)
	const columnDwell = Object.fromEntries(
		boardColumns.map((col) => [
			col.stage_name,
			col.avg_dwell_days != null ? Number(col.avg_dwell_days) : null,
		]),
	);

	useEffect(() => {
		if (typeof window !== "undefined") {
			window.localStorage.setItem("roadmap.board.workflow", activeWorkflow);
		}
	}, [activeWorkflow]);

	const sharedProposals = useMemo(
		() => proposals.map(toSharedProposal),
		[proposals],
	);
	const sharedAgents = useMemo(() => agents.map(toSharedAgent), [agents]);
	const sharedChannels = useMemo(
		() => channels.map(toSharedChannel),
		[channels],
	);
	const [activeProposal, setActiveProposal] = useState(
		null as ProposalWithSelectionAliases | null,
	);
	const resolvedActiveProposal = useMemo(() => {
		if (!activeProposal) return null;
		const match = sharedProposals.find((proposal) =>
			proposalMatchesSelection(
				proposal as ProposalWithSelectionAliases,
				activeProposal,
			),
		);
		return match
			? mergeProposalDetailState(
					activeProposal,
					match as ProposalWithSelectionAliases,
				)
			: activeProposal;
	}, [activeProposal, sharedProposals]);

	const handleProposalClick = (proposal: Proposal) => {
		setActiveProposal(proposal as ProposalWithSelectionAliases);
	};

	const handleWorkflowChange = (workflow: string) => {
		setActiveWorkflow(workflow);
	};

	return (
		<div className="h-screen bg-gray-50 dark:bg-gray-900 flex overflow-hidden transition-colors duration-200">
			<div className="flex-1 flex flex-col min-h-0 min-w-0">
				<AppNav />
				<main className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
					<Switch>
						<Route path="/">
							<PortfolioHome />
						</Route>
						<Route path="/fleet">
							<FleetView />
						</Route>
						<Route path="/efficiency">
							<EfficiencyView />
						</Route>
						<Route path="/identity">
							<IdentityView />
						</Route>
						<Route path="/platform">
							<PlatformView />
						</Route>
						<Route path="/board">
							<BoardPage
								proposals={proposals}
								statuses={statuses}
								activeWorkflow={activeWorkflow}
								onWorkflowChange={handleWorkflowChange}
								onProposalClick={(p) =>
									handleProposalClick(p as unknown as Proposal)
								}
								columnDwell={columnDwell}
							/>
						</Route>
						<Route path="/proposals">
							<ProposalsPage
								proposals={sharedProposals}
								onProposalClick={(p) => handleProposalClick(p as Proposal)}
							/>
						</Route>
						<Route path="/directives">
							<DirectivesPage proposals={sharedProposals} />
						</Route>
						<Route path="/agents">
							<AgentsPage agents={sharedAgents} />
						</Route>
						<Route path="/teams">
							<TeamsPage />
						</Route>
						<Route path="/channels">
							<ChannelsPage channels={sharedChannels} />
						</Route>
						<Route path="/statistics">
							<StatisticsPage proposals={sharedProposals} />
						</Route>
						<Route path="/agent-dashboard">
							<DashboardPage
								connected={connected}
								proposals={sharedProposals}
								agents={agents}
								channels={channels}
							/>
						</Route>
						<Route path="/activity">
							<div className="h-full p-4 sm:p-6">
								<ActivityFeed />
							</div>
						</Route>
						<Route path="/dispatches">
							<DispatchPage />
						</Route>
						<Route path="/control">
							<ControlPage />
						</Route>
						<Route path="/knowledge">
							<KnowledgePage />
						</Route>
						<Route path="/documents">
							<DocumentsPage />
						</Route>
						<Route path="/decisions">
							<DecisionsPage />
						</Route>
						<Route path="/map">
							<MapPage />
						</Route>
						<Route path="/routes">
							<RoutesPage />
						</Route>
						<Route path="/agencies">
							<AgenciesPage />
						</Route>
						<Route path="/achievements">
							<AchievementsView proposals={sharedProposals} />
						</Route>
						<Route path="/config">
							<ConfigPage />
						</Route>
						<Route path="/settings">
							<SettingsPage />
						</Route>
						<Route path="*">
							<NotFoundPage />
						</Route>
					</Switch>
					{resolvedActiveProposal && (
						<ProposalDetailsModal
							proposal={resolvedActiveProposal}
							isOpen={true}
							onClose={() => setActiveProposal(null)}
						/>
					)}
				</main>
			</div>
		</div>
	);
}
