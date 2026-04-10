import { useState } from "react";
import { Route, Switch } from "wouter";
import type { Proposal } from "../../shared/types";
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
import { useWebSocket } from "./hooks/useWebSocket";

const STATUSES = [
	"Draft",
	"Review",
	"Develop",
	"Merge",
	"Complete",
];

export default function App() {
	const { proposals, agents, channels } = useWebSocket();
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
							<DashboardPage proposals={proposals as unknown as Proposal[]} />
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
							<ProposalsPage proposals={proposals} />
						</Route>
						<Route path="/directives">
							<DirectivesPage proposals={proposals} />
						</Route>
						<Route path="/agents">
							<AgentsPage agents={agents} />
						</Route>
						<Route path="/teams">
							<TeamsPage />
						</Route>
						<Route path="/channels">
							<ChannelsPage channels={channels} />
						</Route>
						<Route path="/statistics">
							<StatisticsPage proposals={proposals} />
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
								proposals.find((p) => p.id === activeFeature) as unknown as
									| Proposal
									| undefined
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
