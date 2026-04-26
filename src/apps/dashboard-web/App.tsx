import { useMemo, useState } from "react";
import { Route, Switch } from "wouter";
import type {
	Proposal,
	Agent as SharedAgent,
	Channel as SharedChannel,
} from "../../shared/types";
import AchievementsView from "./components/AchievementsView";
import AgentsPage from "./components/AgentsPage";
import BoardPage from "./components/BoardPage";
import ChannelsPage from "./components/ChannelsPage";
import DashboardPage from "./components/DashboardPage";
import DecisionsPage from "./components/DecisionsPage";
import DirectivesPage from "./components/DirectivesPage";
import DispatchPage from "./components/DispatchPage";
import DocumentsPage from "./components/DocumentsPage";
import KnowledgePage from "./components/KnowledgePage";
import MapPage from "./components/MapPage";
import NotFoundPage from "./components/NotFoundPage";
import ProposalDetailsModal from "./components/ProposalDetailsModal";
import ProposalsPage from "./components/ProposalsPage";
import RoutesPage from "./components/RoutesPage";
import SettingsPage from "./components/SettingsPage";
import StatisticsPage from "./components/StatisticsPage";
import TeamsPage from "./components/TeamsPage";
import {
	buildProposalSelectionAliases,
	mergeProposalDetailState,
	proposalMatchesSelection,
	type ProposalWithSelectionAliases,
} from "./lib/proposal-detail-selection";
import {
	useWebSocket,
	type Agent as WebSocketAgent,
	type Channel as WebSocketChannel,
	type Proposal as WebSocketProposal,
} from "./hooks/useWebSocket";

const STATUSES = [
	"DRAFT",
	"REVIEW",
	"DEVELOP",
	"MERGE",
	"COMPLETE",
	"DEPLOYED",
];

function toSharedProposal(proposal: WebSocketProposal): Proposal {
	const labels = proposal.tags
		? proposal.tags
				.split(",")
				.map((label) => label.trim())
				.filter((label) => label.length > 0)
		: [];
	return {
		id: proposal.displayId || proposal.id,
		title: proposal.title,
		status: proposal.status,
		assignee: [],
		createdDate: proposal.createdAt,
		updatedDate: proposal.updatedAt,
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
		parentProposalId: proposal.parentProposalId,
		parentProposalTitle: proposal.parentProposalTitle,
		maturity: proposal.maturity,
		rawContent: proposal.rawContent,
		budgetLimitUsd: proposal.budgetLimitUsd,
		liveActivity: proposal.liveActivity,
		displayId: proposal.displayId,
		websocketId: proposal.websocketId ?? proposal.id,
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
	const { connected, proposals, agents, channels } = useWebSocket();
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
			)
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

	return (
		<div className="h-screen bg-gray-50 dark:bg-gray-900 flex overflow-hidden transition-colors duration-200">
			<div className="flex-1 flex flex-col min-h-0 min-w-0">
				<main className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
					<Switch>
						<Route path="/">
							<DashboardPage
								connected={connected}
								proposals={sharedProposals}
								agents={agents}
								channels={channels}
							/>
						</Route>
						<Route path="/board">
							<BoardPage
								proposals={proposals}
								statuses={STATUSES}
								onProposalClick={(p) =>
									handleProposalClick(p as unknown as Proposal)
								}
							/>
						</Route>
						<Route path="/proposals">
							<ProposalsPage proposals={sharedProposals} />
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
						<Route path="/dispatch">
							<DispatchPage />
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
						<Route path="/achievements">
							<AchievementsView />
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
