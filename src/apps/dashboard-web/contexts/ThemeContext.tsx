import type React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type ThemeMode = "light" | "dark" | "system";
type ContrastMode = "normal" | "high";

interface ThemeContextType {
	mode: ThemeMode;
	contrast: ContrastMode;
	resolvedMode: "light" | "dark";
	setMode: (mode: ThemeMode) => void;
	toggleContrast: () => void;
	// Backward-compat aliases
	theme: "light" | "dark";
	toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = () => {
	const context = useContext(ThemeContext);
	if (context === undefined) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
};

interface ThemeProviderProps {
	children: React.ReactNode;
}

function getSystemDark(): boolean {
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
	const [mode, setModeState] = useState<ThemeMode>(() => {
		const saved = localStorage.getItem("roadmap-theme-mode");
		if (saved === "light" || saved === "dark" || saved === "system") return saved;
		// Backward compat: old key stored "light"/"dark"
		const legacy = localStorage.getItem("roadmap-theme") as "light" | "dark" | null;
		if (legacy === "light" || legacy === "dark") return legacy;
		return "system";
	});

	const [contrast, setContrast] = useState<ContrastMode>(() => {
		const saved = localStorage.getItem("roadmap-contrast");
		return saved === "high" ? "high" : "normal";
	});

	const [systemDark, setSystemDark] = useState<boolean>(getSystemDark);

	// Live OS preference listener (AC#15)
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
		mq.addEventListener("change", handler);
		return () => mq.removeEventListener("change", handler);
	}, []);

	const resolvedMode: "light" | "dark" = useMemo(() => {
		if (mode === "system") return systemDark ? "dark" : "light";
		return mode;
	}, [mode, systemDark]);

	// Apply classes to document root
	useEffect(() => {
		const root = document.documentElement;
		if (resolvedMode === "dark") {
			root.classList.add("dark");
		} else {
			root.classList.remove("dark");
		}
	}, [resolvedMode]);

	useEffect(() => {
		const root = document.documentElement;
		if (contrast === "high") {
			root.classList.add("high-contrast");
		} else {
			root.classList.remove("high-contrast");
		}
	}, [contrast]);

	const setMode = useCallback((newMode: ThemeMode) => {
		setModeState(newMode);
		localStorage.setItem("roadmap-theme-mode", newMode);
		// Keep legacy key in sync for backward compat
		const resolved = newMode === "system" ? (getSystemDark() ? "dark" : "light") : newMode;
		localStorage.setItem("roadmap-theme", resolved);
	}, []);

	const toggleContrast = useCallback(() => {
		setContrast((prev) => {
			const next = prev === "normal" ? "high" : "normal";
			localStorage.setItem("roadmap-contrast", next);
			return next;
		});
	}, []);

	// Backward compat: toggleTheme cycles light → dark → light
	const toggleTheme = useCallback(() => {
		setMode(resolvedMode === "light" ? "dark" : "light");
	}, [resolvedMode, setMode]);

	const value = useMemo<ThemeContextType>(
		() => ({
			mode,
			contrast,
			resolvedMode,
			setMode,
			toggleContrast,
			theme: resolvedMode,
			toggleTheme,
		}),
		[mode, contrast, resolvedMode, setMode, toggleContrast, toggleTheme]
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
