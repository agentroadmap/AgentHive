import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";
import type { RoadmapConfig } from "../types/index.ts";

/**
 * Get the default editor based on the operating system
 */
function getPlatformDefaultEditor(): string {
	const os = platform();
	switch (os) {
		case "win32":
			return "notepad";
		case "darwin":
			// macOS typically has nano available
			return "nano";
		case "linux":
			return "nano";
		default:
			// Fallback to vi which is available on most unix systems
			return "vi";
	}
}

/**
 * Resolve the editor command based on configuration, environment, and platform defaults
 * Priority: EDITOR env var -> config.defaultEditor -> platform default
 */
export function resolveEditor(config?: RoadmapConfig | null): string {
	// First check environment variable
	const editorEnv = process.env.EDITOR;
	if (editorEnv) {
		return editorEnv;
	}

	// Then check config
	if (config?.defaultEditor) {
		return config.defaultEditor;
	}

	// Finally use platform default
	return getPlatformDefaultEditor();
}

/**
 * Check if an editor command is available on the system
 */
export async function isEditorAvailable(editor: string): Promise<boolean> {
	try {
		// Try to run the editor with --version or --help to check if it exists
		// Split the editor command in case it has arguments
		const parts = editor.split(" ");
		const command = parts[0] ?? editor;

		// For Windows, just check if the command exists
		if (platform() === "win32") {
			try {
				execSync(`where ${command}`, { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		}

		// For Unix-like systems, use which
		try {
			execSync(`which ${command}`, { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

/**
 * Open a file in the editor
 */
export async function openInEditor(
	filePath: string,
	config?: RoadmapConfig | null,
): Promise<boolean> {
	const editor = resolveEditor(config);

	try {
		// Split the editor command in case it has arguments
		const parts = editor.split(" ");
		const command = parts[0] ?? editor;
		const args = [...parts.slice(1), filePath];

		// Use node:child_process spawn with explicit stdio inheritance for interactive editors
		// Interactive editors like vim/neovim require direct access to stdin/stdout/stderr
		// to properly render their UI and receive user input
		return new Promise((resolve) => {
			const subprocess = spawn(command, args, {
				stdio: "inherit",
				shell: true,
			});

			subprocess.on("exit", (code) => {
				resolve(code === 0);
			});

			subprocess.on("error", (error) => {
				console.error(`Failed to open editor: ${error}`);
				resolve(false);
			});
		});
	} catch (error) {
		console.error(`Failed to open editor: ${error}`);
		return false;
	}
}
