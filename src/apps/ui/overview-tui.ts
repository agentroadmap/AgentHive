import type { ProposalStatistics } from "../../core/infrastructure/statistics.ts";
import {
	formatVersionLabel,
	getVersionInfo,
} from "../../shared/utils/version.ts";
import { box } from "./blessed.ts";
import { getStatusIcon } from "./status-icon.ts";
import { createScreen } from "./tui.ts";

/**
 * Render the project overview in an interactive TUI
 */
export async function renderOverviewTui(
	statistics: ProposalStatistics,
	projectName: string,
): Promise<void> {
	const versionInfo = await getVersionInfo();
	const versionLabel = formatVersionLabel(versionInfo);

	// If not in TTY, fall back to plain text output
	if (!process.stdout.isTTY) {
		renderPlainTextOverview(statistics, projectName, versionLabel);
		return;
	}

	return new Promise<void>((resolve) => {
		const screen = createScreen({ title: `${projectName} - Overview` });

		// Main container
		const container = box({
			parent: screen,
			width: "100%",
			height: "100%",
		});

		// Title
		box({
			parent: container,
			top: 0,
			left: "center",
			width: "shrink",
			height: 3,
			content: `{center}{bold}${projectName} - Project Overview{/bold}\n{dim}Roadmap.md ${versionLabel}{/dim}{/center}`,
			tags: true,
			style: {
				fg: "white",
			},
		});

		// Status Overview Section (Top Left)
		const statusBox = box({
			parent: container,
			top: 3,
			left: 0,
			width: "50%",
			height: "40%",
			border: { type: "line" },
			label: " Status Overview ",
			style: {
				border: { fg: "gray" },
			},
			tags: true,
			scrollable: true,
			alwaysScroll: true,
			keys: true,
			vi: true,
			mouse: true,
		});

		let statusContent = "";
		for (const [status, count] of statistics.statusCounts) {
			const icon = getStatusIcon(status);
			const percentage =
				statistics.totalProposals > 0
					? Math.round((count / statistics.totalProposals) * 100)
					: 0;
			statusContent += `  ${icon} {bold}${status}:{/bold} ${count} proposals (${percentage}%)\n`;
		}
		statusContent += `\n  {cyan-fg}Total Proposals:{/cyan-fg} ${statistics.totalProposals}\n`;
		statusContent += `  {green-fg}Completion:{/green-fg} ${statistics.completionPercentage}%\n`;
		if (statistics.draftCount > 0) {
			statusContent += `  {yellow-fg}Drafts:{/yellow-fg} ${statistics.draftCount}\n`;
		}
		statusBox.setContent(statusContent);

		// Priority Breakdown Section (Top Right)
		const priorityBox = box({
			parent: container,
			top: 3,
			left: "50%",
			width: "50%",
			height: "40%",
			border: { type: "line" },
			label: " Priority Breakdown ",
			style: {
				border: { fg: "gray" },
			},
			tags: true,
			scrollable: true,
			alwaysScroll: true,
			keys: true,
			vi: true,
			mouse: true,
		});

		let priorityContent = "";
		const priorityColors = {
			high: "red",
			medium: "yellow",
			low: "green",
			none: "gray",
		};
		for (const [priority, count] of statistics.priorityCounts) {
			if (count > 0) {
				const color =
					priorityColors[priority as keyof typeof priorityColors] || "white";
				const percentage =
					statistics.totalProposals > 0
						? Math.round((count / statistics.totalProposals) * 100)
						: 0;
				const displayPriority =
					priority === "none"
						? "No Priority"
						: priority.charAt(0).toUpperCase() + priority.slice(1);
				priorityContent += `  {${color}-fg}${displayPriority}:{/${color}-fg} ${count} proposals (${percentage}%)\n`;
			}
		}
		priorityBox.setContent(priorityContent);

		// Recent Activity Section (Bottom Left)
		const activityBox = box({
			parent: container,
			top: "43%",
			left: 0,
			width: "50%",
			height: "28%",
			border: { type: "line" },
			label: " Recent Activity ",
			style: {
				border: { fg: "gray" },
			},
			tags: true,
			scrollable: true,
			alwaysScroll: true,
			keys: true,
			vi: true,
			mouse: true,
		});

		let activityContent = "{bold}Recently Created:{/bold}\n";
		if (statistics.recentActivity.created.length > 0) {
			for (const proposal of statistics.recentActivity.created) {
				activityContent += `  ${proposal.id} - ${proposal.title.substring(0, 40)}${proposal.title.length > 40 ? "..." : ""}\n`;
			}
		} else {
			activityContent +=
				"  {gray-fg}No proposals created in the last 7 days{/gray-fg}\n";
		}

		activityContent += "\n{bold}Recently Updated:{/bold}\n";
		if (statistics.recentActivity.updated.length > 0) {
			for (const proposal of statistics.recentActivity.updated) {
				activityContent += `  ${proposal.id} - ${proposal.title.substring(0, 40)}${proposal.title.length > 40 ? "..." : ""}\n`;
			}
		} else {
			activityContent +=
				"  {gray-fg}No proposals updated in the last 7 days{/gray-fg}\n";
		}
		activityBox.setContent(activityContent);

		// Project Health Section (Bottom Right)
		const healthBox = box({
			parent: container,
			top: "43%",
			left: "50%",
			width: "50%",
			height: "28%",
			border: { type: "line" },
			label: " Project Health ",
			style: {
				border: { fg: "gray" },
			},
			tags: true,
			scrollable: true,
			alwaysScroll: true,
			keys: true,
			vi: true,
			mouse: true,
		});

		let healthContent = `{bold}Average Proposal Age:{/bold} ${statistics.projectHealth.averageProposalAge} days\n\n`;

		healthContent +=
			"{bold}Stale Proposals:{/bold} {gray-fg}(>30 days without updates){/gray-fg}\n";
		if (statistics.projectHealth.staleProposals.length > 0) {
			for (const proposal of statistics.projectHealth.staleProposals) {
				healthContent += `  {yellow-fg}${proposal.id}{/yellow-fg} - ${proposal.title.substring(0, 35)}${proposal.title.length > 35 ? "..." : ""}\n`;
			}
		} else {
			healthContent += "  {green-fg}No stale proposals{/green-fg}\n";
		}

		healthContent +=
			"\n{bold}Blocked Proposals:{/bold} {gray-fg}(waiting on dependencies){/gray-fg}\n";
		if (statistics.projectHealth.blockedProposals.length > 0) {
			for (const proposal of statistics.projectHealth.blockedProposals) {
				healthContent += `  {red-fg}${proposal.id}{/red-fg} - ${proposal.title.substring(0, 35)}${proposal.title.length > 35 ? "..." : ""}\n`;
			}
		} else {
			healthContent += "  {green-fg}No blocked proposals{/green-fg}\n";
		}
		healthBox.setContent(healthContent);

		// Instructions at bottom
		box({
			parent: container,
			bottom: 0,
			left: 0,
			width: "100%",
			height: 3,
			content: "{center}Press q or Esc to exit{/center}",
			tags: true,
			style: {
				fg: "gray",
			},
		});

		// Focus on status box for scrolling
		statusBox.focus();

		// Exit handlers
		screen.key(["escape", "q", "C-c"], () => {
			screen.destroy();
			resolve();
		});

		screen.render();
	});
}

/**
 * Render plain text overview for non-TTY environments
 */
function renderPlainTextOverview(
	statistics: ProposalStatistics,
	projectName: string,
	versionLabel: string,
): void {
	console.log(`\n${projectName} - Project Overview`);
	console.log(`Roadmap.md ${versionLabel}`);
	console.log(`${"=".repeat(40)}\n`);

	console.log("Status Overview:");
	for (const [status, count] of statistics.statusCounts) {
		const percentage =
			statistics.totalProposals > 0
				? Math.round((count / statistics.totalProposals) * 100)
				: 0;
		console.log(`  ${status}: ${count} proposals (${percentage}%)`);
	}
	console.log(`\n  Total Proposals: ${statistics.totalProposals}`);
	console.log(`  Completion: ${statistics.completionPercentage}%`);
	if (statistics.draftCount > 0) {
		console.log(`  Drafts: ${statistics.draftCount}`);
	}

	console.log("\nPriority Breakdown:");
	for (const [priority, count] of statistics.priorityCounts) {
		if (count > 0) {
			const percentage =
				statistics.totalProposals > 0
					? Math.round((count / statistics.totalProposals) * 100)
					: 0;
			const displayPriority =
				priority === "none"
					? "No Priority"
					: priority.charAt(0).toUpperCase() + priority.slice(1);
			console.log(`  ${displayPriority}: ${count} proposals (${percentage}%)`);
		}
	}

	console.log("\nRecent Activity:");
	console.log("  Recently Created:");
	if (statistics.recentActivity.created.length > 0) {
		for (const proposal of statistics.recentActivity.created) {
			console.log(`    ${proposal.id} - ${proposal.title}`);
		}
	} else {
		console.log("    No proposals created in the last 7 days");
	}

	console.log("\n  Recently Updated:");
	if (statistics.recentActivity.updated.length > 0) {
		for (const proposal of statistics.recentActivity.updated) {
			console.log(`    ${proposal.id} - ${proposal.title}`);
		}
	} else {
		console.log("    No proposals updated in the last 7 days");
	}

	console.log("\nProject Health:");
	console.log(
		`  Average Proposal Age: ${statistics.projectHealth.averageProposalAge} days`,
	);

	console.log("\n  Stale Proposals (>30 days without updates):");
	if (statistics.projectHealth.staleProposals.length > 0) {
		for (const proposal of statistics.projectHealth.staleProposals) {
			console.log(`    ${proposal.id} - ${proposal.title}`);
		}
	} else {
		console.log("    No stale proposals");
	}

	console.log("\n  Blocked Proposals (waiting on dependencies):");
	if (statistics.projectHealth.blockedProposals.length > 0) {
		for (const proposal of statistics.projectHealth.blockedProposals) {
			console.log(`    ${proposal.id} - ${proposal.title}`);
		}
	} else {
		console.log("    No blocked proposals");
	}
	console.log("");
}
