import type React from "react";
import { useEffect, useRef, useState } from "react";
import NotificationPanel from "./NotificationPanel";

interface NotificationBellProps {
	unreadCount: number;
	bellEnabled: boolean;
	notifications: Array<{
		id: string;
		severity: string;
		title: string;
		message: string;
		created_at: string;
		seen: boolean;
	}>;
	onMarkSeen: (id: string) => Promise<void>;
}

const NotificationBell: React.FC<NotificationBellProps> = ({
	unreadCount,
	bellEnabled,
	notifications,
	onMarkSeen,
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const bellRef = useRef<HTMLButtonElement>(null);

	// Close panel when clicking outside
	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (
				panelRef.current &&
				bellRef.current &&
				!panelRef.current.contains(event.target as Node) &&
				!bellRef.current.contains(event.target as Node)
			) {
				setIsOpen(false);
			}
		}

		if (isOpen) {
			document.addEventListener("mousedown", handleClickOutside);
			return () => {
				document.removeEventListener("mousedown", handleClickOutside);
			};
		}
	}, [isOpen]);

	if (!bellEnabled) {
		return null;
	}

	return (
		<div className="relative">
			<button
				ref={bellRef}
				onClick={() => setIsOpen(!isOpen)}
				className="relative text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors duration-200 p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
				aria-label={`Notifications (${unreadCount} unread)`}
				title={`${unreadCount} unread notification${unreadCount !== 1 ? "s" : ""}`}
			>
				{/* Bell icon */}
				<svg
					className="w-6 h-6"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
					/>
				</svg>

				{/* Unread count badge */}
				{unreadCount > 0 && (
					<span className="absolute top-0 right-0 inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-white transform translate-x-1/2 -translate-y-1/2 bg-red-600 rounded-full">
						{unreadCount > 99 ? "99+" : unreadCount}
					</span>
				)}
			</button>

			{/* Notification panel dropdown */}
			{isOpen && (
				<NotificationPanel
					ref={panelRef}
					notifications={notifications}
					onMarkSeen={onMarkSeen}
					onClose={() => setIsOpen(false)}
				/>
			)}
		</div>
	);
};

export default NotificationBell;
