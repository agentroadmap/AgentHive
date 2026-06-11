import type React from "react";
import ProjectChip from "./ProjectChip";
import ThemeToggle from "./ThemeToggle";
import NotificationBell from "./NotificationBell";

interface NavigationProps {
	projectName: string;
	unreadNotificationCount?: number;
	bellEnabled?: boolean;
	notifications?: Array<{
		id: string;
		severity: string;
		title: string;
		message: string;
		created_at: string;
		seen: boolean;
	}>;
	onMarkNotificationSeen?: (id: string) => Promise<void>;
}

const Navigation: React.FC<NavigationProps> = ({
	projectName,
	unreadNotificationCount = 0,
	bellEnabled = false,
	notifications = [],
	onMarkNotificationSeen,
}) => {
	return (
		<nav className="px-8 h-18 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-colors duration-200">
			<div className="h-full flex items-center justify-between">
				<div className="flex items-center gap-2">
					<h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
						{projectName || "Loading..."}
					</h1>
					<span className="text-sm text-gray-500 dark:text-gray-400">
						powered by
					</span>
					<a
						href="https://roadmap.md"
						target="_blank"
						rel="noopener noreferrer"
						className="text-sm text-stone-600 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300 hover:underline transition-colors duration-200"
					>
						Roadmap.md
					</a>
				</div>
				<div className="flex items-center gap-3">
					{/* P705 AC-5/6/23: Notification bell */}
					{bellEnabled && onMarkNotificationSeen && (
						<NotificationBell
							unreadCount={unreadNotificationCount}
							bellEnabled={bellEnabled}
							notifications={notifications}
							onMarkSeen={onMarkNotificationSeen}
						/>
					)}
					{/* P477 AC-2: global project scope switcher */}
					<ProjectChip />
					<ThemeToggle />
				</div>
			</div>
		</nav>
	);
};

export default Navigation;
