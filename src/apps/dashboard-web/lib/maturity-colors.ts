/**
 * Canonical maturity color palette shared across Board and ProposalDetailsModal.
 *
 * new      → green  (fresh / just landed)
 * active   → amber  (in progress / hot)
 * mature   → sky    (settled / ready for gate)
 * obsolete → gray   (superseded)
 */

/** Full-width banner / title-bar variant (used on board cards). */
export function maturityBarColors(maturity?: string | null): string {
	switch ((maturity ?? "").toLowerCase()) {
		case "new":
			return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200";
		case "active":
			return "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100";
		case "mature":
			return "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200";
		case "obsolete":
			return "bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-500";
		default:
			return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
	}
}

/** Pill / badge variant (used in modal sidebar and anywhere a compact chip is needed). */
export function maturityBadgeColors(maturity?: string | null): string {
	switch ((maturity ?? "").toLowerCase()) {
		case "new":
			return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200";
		case "active":
			return "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100";
		case "mature":
			return "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200";
		case "obsolete":
			return "bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-500";
		default:
			return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
	}
}

/** General status colors for workflow status, agent activity, dispatch status, etc. */
export function statusBadgeColors(value?: string | null): string {
	switch ((value ?? "").toLowerCase()) {
		case "active":
		case "assigned":
		case "open":
		case "healthy":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
		case "mature":
		case "complete":
		case "completed":
		case "delivered":
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
		case "blocked":
		case "claimed":
		case "degraded":
			return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
		case "obsolete":
		case "offline":
		case "expired":
		case "rejected":
			return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
		default:
			return "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300";
	}
}
