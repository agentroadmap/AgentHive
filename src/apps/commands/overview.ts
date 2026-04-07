import { getProposalStatistics } from "../../core/infrastructure/statistics.ts";
import type { Core } from "../../core/roadmap.ts";
import { createLoadingScreen } from "../../ui/loading.ts";
import { renderOverviewTui } from "../../ui/overview-tui.ts";

function formatTime(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export async function runOverviewCommand(core: Core): Promise<void> {
	const startTime = performance.now();

	// Load proposals with loading screen
	const loadingScreen = await createLoadingScreen("Loading project statistics");

	try {
		const loadStart = performance.now();
		const {
			proposals: activeProposals,
			drafts,
			statuses,
		} = await core.loadAllProposalsForStatistics();
		loadingScreen?.update(
			`Loaded roadmap data in ${formatTime(performance.now() - loadStart)}`,
		);

		loadingScreen?.close();

		// Calculate statistics
		const statsStart = performance.now();
		const statistics = getProposalStatistics(activeProposals, drafts, statuses);
		const statsTime = Math.round(performance.now() - statsStart);

		// Display the TUI
		const totalTime = Math.round(performance.now() - startTime);
		console.log(
			`\nPerformance summary: Total time ${totalTime}ms (stats calculation: ${statsTime}ms)`,
		);

		const config = await core.fs.loadConfig();
		await renderOverviewTui(statistics, config?.projectName || "Project");
	} catch (error) {
		loadingScreen?.close();
		throw error;
	}
}
