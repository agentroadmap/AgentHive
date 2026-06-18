import { useEffect, useMemo, useState } from "react";
import { Redirect, Route, Switch } from "wouter";
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
import ConfigPage from "./components/ConfigPage";
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
import { DEFAULT_PROJECT_ID, useProject } from "./hooks/useProject";
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
		// P1731 AC-3: Component shape match — WebSocket Agent lacks costClass
		// and other HTTP-only fields. HTTP endpoint provides these via fallback.
		// This transformation is minimal; full agent profile comes from HTTP.
		costClass: undefined,
	};
}

function toSharedChannel(channel: WebSocketChannel): SharedChannel {
	return {
		name: channel.channelName,
		fileName: channel.channelName,
		type: "group",
	};
}

/**
 * Props the project-scoped workspace pages need. Hoisted out of App() so the
 * nested project Switch can be rendered both at `/project/:projectId/*` and
 * (transitionally) reused without prop duplication.
 */
interface ProjectWorkspaceProps {
	proposals: WebSocketProposal[];
	sharedProposals: Proposal[];
	sharedAgents: SharedAgent[];
	sharedChannels: SharedChannel[];
	agents: WebSocketAgent[];
	channels: WebSocketChannel[];
	connected: boolean;
	statuses: string[];
	activeWorkflow: string;
	columnDwell: Record<string, number | null>;
	onWorkflowChange: (workflow: string) => void;
	onProposalClick: (proposal: Proposal) => void;
}

/**
 * P477 AC-7: project-namespaced workspace. Mounted under `/project/:projectId`
 * (nested). Calling useProject() here derives the numeric projectId from the
 * URL and syncs it into the shared project-scope storage, so every data fetch
 * inside these pages carries the matching `X-Project-Id` header. Paths are
 * relative to the `/project/:projectId` base because of wouter `nest`.
 */
function ProjectWorkspace({
	proposals,
	sharedProposals,
	sharedAgents,
	sharedChannels,
	agents,
	channels,
	connected,
	statuses,
	activeWorkflow,
	columnDwell,
	onWorkflowChange,
	onProposalClick,
}: ProjectWorkspaceProps) {
	// Side effect: derive + sync projectId from the URL into project-scope storage.
	useProject();
	return (
		<Switch>
			<Route path="/board">
				<BoardPage
					proposals={proposals}
					statuses={statuses}
					activeWorkflow={activeWorkflow}
					onWorkflowChange={onWorkflowChange}
					onProposalClick={(p) => onProposalClick(p as unknown as Proposal)}
					columnDwell={columnDwell}
				/>
			</Route>
			<Route path="/proposals">
				<ProposalsPage
					proposals={sharedProposals}
					onProposalClick={(p) => onProposalClick(p as Proposal)}
				/>
			</Route>
			<Route path="/directives">
				<DirectivesPage proposals={sharedProposals} />
			</Route>
			<Route path="/agents">
				<AgentsPage agents={sharedAgents} />
			</Route>
			<Route path="/dispatches">
				<DispatchPage />
			</Route>
			<Route path="/settings">
				<SettingsPage />
			</Route>
			{/* Default: bare /project/:projectId lands on the board. */}
			<Route path="/">
				<BoardPage
					proposals={proposals}
					statuses={statuses}
					activeWorkflow={activeWorkflow}
					onWorkflowChange={onWorkflowChange}
					onProposalClick={(p) => onProposalClick(p as unknown as Proposal)}
					columnDwell={columnDwell}
				/>
			</Route>
			<Route path="*">
				<NotFoundPage />
			</Route>
		</Switch>
	);
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
						{/* ── Control-plane root (P3507) — cross-project, NOT namespaced ── */}
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

						{/* ── P477 AC-7: project-namespaced workspace ── */}
						<Route path="/project/:projectId" nest>
							<ProjectWorkspace
								proposals={proposals}
								sharedProposals={sharedProposals}
								sharedAgents={sharedAgents}
								sharedChannels={sharedChannels}
								agents={agents}
								channels={channels}
								connected={connected}
								statuses={statuses}
								activeWorkflow={activeWorkflow}
								columnDwell={columnDwell}
								onWorkflowChange={handleWorkflowChange}
								onProposalClick={handleProposalClick}
							/>
						</Route>

						{/* ── P477 AC-7: legacy flat routes 302→ /project/1/* (back-compat) ── */}
						<Route path="/board">
							<Redirect to={`/project/${DEFAULT_PROJECT_ID}/board`} replace />
						</Route>
						<Route path="/proposals">
							<Redirect to={`/project/${DEFAULT_PROJECT_ID}/proposals`} replace />
						</Route>
						<Route path="/directives">
							<Redirect to={`/project/${DEFAULT_PROJECT_ID}/directives`} replace />
						</Route>
						<Route path="/agents">
							<Redirect to={`/project/${DEFAULT_PROJECT_ID}/agents`} replace />
						</Route>
						<Route path="/dispatches">
							<Redirect to={`/project/${DEFAULT_PROJECT_ID}/dispatches`} replace />
						</Route>
						<Route path="/settings">
							<Redirect to={`/project/${DEFAULT_PROJECT_ID}/settings`} replace />
						</Route>

						{/* ── Cross-project utility pages (kept flat for now) ── */}
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
						<Route path="/config">
							<ConfigPage />
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
