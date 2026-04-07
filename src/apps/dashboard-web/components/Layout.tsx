import { Outlet } from "react-router-dom";
import type { Decision, Document, Proposal } from "../../../shared/types";
import { HealthIndicator, HealthSuccessToast } from "./HealthIndicator";
import Navigation from "./Navigation";
import SideNavigation from "./SideNavigation";

interface LayoutProps {
	projectName: string;
	showSuccessToast: boolean;
	onDismissToast: () => void;
	proposals: Proposal[];
	docs: Document[];
	decisions: Decision[];
	isLoading: boolean;
	onRefreshData: () => Promise<void>;
}

export default function Layout({
	projectName,
	showSuccessToast,
	onDismissToast,
	proposals,
	docs,
	decisions,
	isLoading,
	onRefreshData,
}: LayoutProps) {
	return (
		<div className="h-screen bg-gray-50 dark:bg-gray-900 flex overflow-hidden transition-colors duration-200">
			<HealthIndicator />
			<SideNavigation
				proposals={proposals}
				docs={docs}
				decisions={decisions}
				isLoading={isLoading}
				onRefreshData={onRefreshData}
			/>
			<div className="flex-1 flex flex-col min-h-0 min-w-0">
				<Navigation projectName={projectName} />
				<main className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
					<Outlet
						context={{ proposals, docs, decisions, isLoading, onRefreshData }}
					/>
				</main>
			</div>
			{showSuccessToast && <HealthSuccessToast onDismiss={onDismissToast} />}
		</div>
	);
}
