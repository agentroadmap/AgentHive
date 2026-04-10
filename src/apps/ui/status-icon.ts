/* Status icon and color mappings for consistent UI display */

export interface StatusStyle {
	icon: string;
	color: string;
}

/**
 * Get the icon and color for a given status
 * @param status - The proposal status
 * @returns The icon and color for the status
 */
export function getStatusStyle(status: string): StatusStyle {
	const statusMap: Record<string, StatusStyle> = {
		Draft: { icon: "○", color: "white" },
		Review: { icon: "◆", color: "blue" },
		Develop: { icon: "◒", color: "yellow" },
		Merge: { icon: "▣", color: "cyan" },
		Complete: { icon: "✅", color: "green" },
		Rejected: { icon: "✖", color: "red" },
		Discard: { icon: "●", color: "red" },
		Replaced: { icon: "⇄", color: "magenta" },
		Building: { icon: "◒", color: "yellow" },
		Accepted: { icon: "▣", color: "cyan" },
		Abandoned: { icon: "●", color: "red" },
		Obsolete: { icon: "✖", color: "gray" },
		Blocked: { icon: "●", color: "red" },
	};

	// Return the mapped style or default for unknown statuses
	return statusMap[status] || { icon: "○", color: "white" };
}

/**
 * Get the color for a given maturity level
 * @param maturity - The proposal maturity
 * @returns The color name
 */
export function getMaturityColor(maturity?: string): string {
	switch (maturity?.toLowerCase()) {
		case "new":
			return "white";
		case "active":
			return "yellow";
		case "mature":
			return "green";
		case "obsolete":
			return "gray";
		default:
			return "white";
	}
}

/**
 * Get the icon for a given maturity level
 * @param maturity - The proposal maturity
 * @returns The icon string
 */
export function getMaturityIcon(maturity?: string): string {
	switch (maturity?.toLowerCase()) {
		case "new":
			return "○ ";
		case "active":
			return "▶ ";
		case "mature":
			return "✓ ";
		case "obsolete":
			return "✖ ";
		default:
			return "";
	}
}

/**
 * Get just the color for a status (for backward compatibility)
 * @param status - The proposal status
 * @returns The color for the status
 */
export function getStatusColor(status: string): string {
	return getStatusStyle(status).color;
}

/**
 * Get just the icon for a status
 * @param status - The proposal status
 * @returns The icon for the status
 */
export function getStatusIcon(status: string): string {
	return getStatusStyle(status).icon;
}

/**
 * Format a status with its icon
 * @param status - The proposal status
 * @returns The formatted status string with icon
 */
export function formatStatusWithIcon(status: string): string {
	const style = getStatusStyle(status);
	return `${style.icon} ${status}`;
}
