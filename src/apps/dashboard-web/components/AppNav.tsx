import type React from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "wouter";
import ProjectChip from "./ProjectChip";
import ThemeToggle from "./ThemeToggle";

interface NavItem {
	href: string;
	label: string;
}

const PRIMARY: NavItem[] = [
	{ href: "/", label: "Portal" },
	{ href: "/fleet", label: "Fleet" },
	{ href: "/efficiency", label: "Efficiency" },
	{ href: "/identity", label: "Identity" },
	{ href: "/platform", label: "Platform" },
	{ href: "/board", label: "Board" },
	{ href: "/proposals", label: "Proposals" },
	{ href: "/directives", label: "Directives" },
];

const SECONDARY: NavItem[] = [
	{ href: "/agent-dashboard", label: "Dashboard" },
	{ href: "/agents", label: "Agents" },
	{ href: "/agencies", label: "Agencies" },
	{ href: "/teams", label: "Teams" },
	{ href: "/channels", label: "Channels" },
	{ href: "/dispatches", label: "Dispatches" },
	{ href: "/activity", label: "Activity" },
	{ href: "/control", label: "Control" },
	{ href: "/knowledge", label: "Knowledge" },
	{ href: "/documents", label: "Documents" },
	{ href: "/decisions", label: "Decisions" },
	{ href: "/map", label: "Map" },
	{ href: "/routes", label: "Routes" },
	{ href: "/statistics", label: "Statistics" },
	{ href: "/achievements", label: "Achievements" },
	{ href: "/config", label: "Config" },
	{ href: "/settings", label: "Settings" },
	{ href: "/config", label: "Config" },
];

function isActive(current: string, href: string): boolean {
	if (href === "/") return current === "/";
	return current === href || current.startsWith(`${href}/`);
}

const AppNav: React.FC = () => {
	const [location] = useLocation();
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [overflowOpen, setOverflowOpen] = useState(false);
	const overflowRef = useRef<HTMLDivElement | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: location is the intentional trigger to close drawers on navigation — stable setters need no listing
	useEffect(() => {
		setDrawerOpen(false);
		setOverflowOpen(false);
	}, [location]);

	useEffect(() => {
		if (!overflowOpen) return;
		const handler = (e: MouseEvent) => {
			if (
				overflowRef.current &&
				!overflowRef.current.contains(e.target as Node)
			) {
				setOverflowOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [overflowOpen]);

	useEffect(() => {
		if (!drawerOpen) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") setDrawerOpen(false);
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [drawerOpen]);

	const linkClass = (href: string) =>
		`px-3 py-2 rounded-md text-sm font-medium transition-colors duration-150 ${
			isActive(location, href)
				? "bg-stone-100 text-stone-900 dark:bg-stone-700/40 dark:text-stone-100"
				: "text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800"
		}`;

	const drawerLinkClass = (href: string) =>
		`flex items-center min-h-11 px-4 text-sm font-medium transition-colors duration-150 ${
			isActive(location, href)
				? "bg-stone-100 text-stone-900 dark:bg-stone-700/40 dark:text-stone-100"
				: "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
		}`;

	return (
		<>
			<header className="flex items-center gap-2 px-3 sm:px-4 h-12 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0">
				<button
					type="button"
					className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-md text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
					aria-label="Open navigation menu"
					aria-expanded={drawerOpen}
					onClick={() => setDrawerOpen(true)}
				>
					<svg
						className="w-5 h-5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M4 6h16M4 12h16M4 18h16"
						/>
					</svg>
				</button>

				<Link
					href="/"
					className="font-semibold text-gray-900 dark:text-gray-100 text-base mr-2 truncate"
				>
					AgentHive
				</Link>

				<nav className="hidden md:flex items-center gap-1 flex-1 min-w-0">
					{PRIMARY.map((item) => (
						<Link
							key={item.href}
							href={item.href}
							className={linkClass(item.href)}
						>
							{item.label}
						</Link>
					))}
					<div className="relative" ref={overflowRef}>
						<button
							type="button"
							className={linkClass("__more__")}
							onClick={() => setOverflowOpen((v) => !v)}
							aria-haspopup="menu"
							aria-expanded={overflowOpen}
						>
							More ▾
						</button>
						{overflowOpen && (
							<div className="absolute left-0 mt-1 w-48 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50 py-1">
								{SECONDARY.map((item) => (
									<Link
										key={item.href}
										href={item.href}
										className={`block px-3 py-2 text-sm ${
											isActive(location, item.href)
												? "bg-stone-100 text-stone-900 dark:bg-stone-700/40 dark:text-stone-100"
												: "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
										}`}
									>
										{item.label}
									</Link>
								))}
							</div>
						)}
					</div>
				</nav>

				<div className="ml-auto flex items-center gap-2 flex-shrink-0">
					<ProjectChip />
					<ThemeToggle />
				</div>
			</header>

			{drawerOpen &&
				typeof document !== "undefined" &&
				createPortal(
					<div className="md:hidden fixed inset-0 z-[100]">
						<div
							aria-hidden="true"
							className="absolute top-0 right-0 bottom-0 left-72 bg-black/40"
							onClick={() => setDrawerOpen(false)}
							onTouchStart={() => setDrawerOpen(false)}
						/>
						<aside
							className="absolute inset-y-0 left-0 w-72 max-w-[80vw] bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 shadow-xl flex flex-col"
							role="dialog"
							aria-modal="true"
							aria-label="Navigation menu"
						>
							<div className="flex items-center justify-between h-12 px-4 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
								<span className="font-semibold text-gray-900 dark:text-gray-100">
									Menu
								</span>
								<button
									type="button"
									aria-label="Close navigation menu"
									className="inline-flex items-center justify-center w-11 h-11 -mr-2 rounded-md text-gray-700 hover:bg-gray-100 active:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-800 dark:active:bg-gray-700"
									onClick={() => setDrawerOpen(false)}
								>
									<svg
										className="w-6 h-6"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										aria-hidden="true"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											d="M6 6l12 12M6 18L18 6"
										/>
									</svg>
								</button>
							</div>
							<div className="overflow-y-auto flex-1 py-2 bg-white dark:bg-gray-900">
								<div className="px-4 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
									Primary
								</div>
								{PRIMARY.map((item) => (
									<Link
										key={item.href}
										href={item.href}
										className={drawerLinkClass(item.href)}
									>
										{item.label}
									</Link>
								))}
								<div className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
									More
								</div>
								{SECONDARY.map((item) => (
									<Link
										key={item.href}
										href={item.href}
										className={drawerLinkClass(item.href)}
									>
										{item.label}
									</Link>
								))}
							</div>
						</aside>
					</div>,
					document.body,
				)}
		</>
	);
};

export default AppNav;
