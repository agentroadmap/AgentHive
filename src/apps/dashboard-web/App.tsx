import { useState } from "react";
import { Route, Switch } from "wouter";
import type {
	Agent as SharedAgent,
	Channel as SharedChannel,
	Proposal,
} from "../../shared/types";
import AchievementsView from "./components/AchievementsView";
import AgentDashboard from "./components/AgentDashboard";
import AgentsPage from "./components/AgentsPage";
import BoardPage from "./components/BoardPage";
import ChannelsPage from "./components/ChannelsPage";
import DashboardPage from "./components/DashboardPage";
import DecisionsPage from "./components/DecisionsPage";
import DirectivesPage from "./components/DirectivesPage";
import DocumentsPage from "./components/DocumentsPage";
import KnowledgePage from "./components/KnowledgePage";
import MapPage from "./components/MapPage";
import NotFoundPage from "./components/NotFoundPage";
import ProposalDetailsModal from "./components/ProposalDetailsModal";
import ProposalsPage from "./components/ProposalsPage";
import SettingsPage from "./components/SettingsPage";
import StatisticsPage from "./components/StatisticsPage";
import TeamsPage from "./components/TeamsPage";
import {
	type Agent as WebSocketAgent,
	type Channel as WebSocketChannel,
	type Proposal as WebSocketProposal,
	useWebSocket,
} from "./hooks/useWebSocket";

const STATUSES = [
	"Draft",
	"Review",
	"Develop",
	"Merge",
	"Complete",
];

function toSharedProposal(proposal: WebSocketProposal): Proposal {
	return {
		id: proposal.displayId || proposal.id,
		title: proposal.title,
		status: proposal.status,
		assignee: [],
		createdDate: proposal.createdAt,
		updatedDate: proposal.updatedAt,
		labels: proposal.tags ? [proposal.tags] : [],
		dependencies: proposal.parentId ? [proposal.parentId] : [],
		description: proposal.bodyMarkdown ?? undefined,
		domainId: proposal.domainId,
		proposalType: proposal.proposalType,
		category: proposal.category,
		priority:
			proposal.priority === "high" ||
			proposal.priority === "medium" ||
			proposal.priority === "low"
				? proposal.priority
				: undefined,
	};
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
	const { proposals, agents, channels } = useWebSocket();
	const sharedProposals = proposals.map(toSharedProposal);
	const sharedAgents = agents.map(toSharedAgent);
	const sharedChannels = channels.map(toSharedChannel);
	const [activeFeature, setActiveFeature] = useState<string | null>(null);

	const handleProposalClick = (proposal: Proposal) => {
		setActiveFeature(proposal.id);
	};

	return (
		<div className="h-screen bg-gray-50 dark:bg-gray-900 flex overflow-hidden transition-colors duration-200">
			<div className="flex-1 flex flex-col min-h-0 min-w-0">
				<main className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
					<Switch>
						<Route path="/">
							<DashboardPage proposals={sharedProposals} />
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
							<AgentDashboard />
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
					{activeFeature && (
						<ProposalDetailsModal
							proposal={
								sharedProposals.find((p) => p.id === activeFeature)
							}
							isOpen={true}
							onClose={() => setActiveFeature(null)}
						/>
					)}
				</main>
			</div>
		</div>
	);
}
