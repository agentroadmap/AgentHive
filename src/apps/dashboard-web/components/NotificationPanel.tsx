import type React from "react";
import { forwardRef, useState } from "react";

interface Notification {
	id: string;
	severity: string;
	title: string;
	message: string;
	created_at: string;
	seen: boolean;
}

interface NotificationPanelProps {
	notifications: Notification[];
	onMarkSeen: (id: string) => Promise<void>;
	onClose: () => void;
}

const severityColors: Record<string, { bg: string; border: string; icon: string }> = {
	error: {
		bg: "bg-red-50 dark:bg-red-900/20",
		border: "border-red-300 dark:border-red-700",
		icon: "text-red-600 dark:text-red-400",
	},
	warning: {
		bg: "bg-amber-50 dark:bg-amber-900/20",
		border: "border-amber-300 dark:border-amber-700",
		icon: "text-amber-600 dark:text-amber-400",
	},
	info: {
		bg: "bg-blue-50 dark:bg-blue-900/20",
		border: "border-blue-300 dark:border-blue-700",
		icon: "text-blue-600 dark:text-blue-400",
	},
	success: {
		bg: "bg-green-50 dark:bg-green-900/20",
		border: "border-green-300 dark:border-green-700",
		icon: "text-green-600 dark:text-green-400",
	},
};

const NotificationPanel = forwardRef<HTMLDivElement, NotificationPanelProps>(
	({ notifications, onMarkSeen, onClose }, ref) => {
		const [marking, setMarking] = useState<Set<string>>(new Set());

		const handleMarkSeen = async (id: string) => {
			setMarking((prev) => new Set([...prev, id]));
			try {
				await onMarkSeen(id);
			} finally {
				setMarking((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
			}
		};

		const sortedNotifications = [...notifications].sort((a, b) => {
			const aTime = new Date(a.created_at).getTime();
			const bTime = new Date(b.created_at).getTime();
			return bTime - aTime;
		});

		const displayedNotifications = sortedNotifications.slice(0, 50);

		return (
			<div
				ref={ref}
				className="absolute right-0 top-full mt-2 w-96 max-h-[600px] overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-2xl z-50"
			>
				{/* Header */}
				<div className="sticky top-0 px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex items-center justify-between">
					<h3 className="font-semibold text-gray-900 dark:text-gray-100">
						Notifications
					</h3>
					<button
						onClick={onClose}
						className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
						aria-label="Close"
					>
						<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				{/* Notification list */}
				{displayedNotifications.length === 0 ? (
					<div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
						No notifications yet
					</div>
				) : (
					<div className="divide-y divide-gray-200 dark:divide-gray-700">
						{displayedNotifications.map((notif) => {
							const colors =
								severityColors[notif.severity] || severityColors.info;
							const isMarking = marking.has(notif.id);

							return (
								<div
									key={notif.id}
									className={`p-4 border-l-4 transition-colors ${colors.bg} ${colors.border} ${
										notif.seen
											? "opacity-75"
											: "bg-opacity-100 dark:bg-opacity-100"
									}`}
								>
									<div className="flex gap-3">
										{/* Severity icon */}
										<div className={`flex-shrink-0 mt-1 ${colors.icon}`}>
											{notif.severity === "error" && (
												<svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
													<path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
												</svg>
											)}
											{notif.severity === "warning" && (
												<svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
													<path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
												</svg>
											)}
											{notif.severity === "success" && (
												<svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
													<path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
												</svg>
											)}
											{notif.severity === "info" && (
												<svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
													<path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
												</svg>
											)}
										</div>

										{/* Content */}
										<div className="flex-1 min-w-0">
											<p className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
												{notif.title}
											</p>
											<p className="text-gray-700 dark:text-gray-300 text-sm mt-1">
												{notif.message}
											</p>
											<p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
												{new Date(notif.created_at).toLocaleString()}
											</p>
										</div>

										{/* Mark as seen button */}
										{!notif.seen && (
											<button
												onClick={() => handleMarkSeen(notif.id)}
												disabled={isMarking}
												className="flex-shrink-0 ml-2 text-xs px-2 py-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
												title="Mark as read"
											>
												{isMarking ? "..." : "✓"}
											</button>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}

				{/* Footer */}
				{displayedNotifications.length < notifications.length && (
					<div className="px-4 py-2 text-center text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700">
						Showing {displayedNotifications.length} of {notifications.length} notifications
					</div>
				)}
			</div>
		);
	},
);

NotificationPanel.displayName = "NotificationPanel";

export default NotificationPanel;
