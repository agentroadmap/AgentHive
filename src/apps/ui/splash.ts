// Simple splash screen renderer for bare `roadmap` invocations
// Focus: fast, TUI-friendly, graceful fallback to plain text

type SplashOptions = {
	version: string;
	revision?: string | null;
	initialized: boolean;
	plain?: boolean;
	color?: boolean;
};

function colorize(enabled: boolean | undefined, code: string, text: string) {
	if (!enabled) return text;
	return `\x1b[${code}m${text}\x1b[0m`;
}

const bold = (c: boolean | undefined, s: string) => colorize(c, "1", s);
const dim = (c: boolean | undefined, s: string) => colorize(c, "2", s);
const cyan = (c: boolean | undefined, s: string) => colorize(c, "36", s);
const green = (c: boolean | undefined, s: string) => colorize(c, "32", s);
const yellow = (c: boolean | undefined, s: string) => colorize(c, "33", s);
const blue = (c: boolean | undefined, s: string) => colorize(c, "34", s);
const _magenta = (c: boolean | undefined, s: string) => colorize(c, "35", s);
const red = (c: boolean | undefined, s: string) => colorize(c, "31", s);

// Removed terminal theme heuristics; keep splash accent simple and consistent

function getWideLogoLines(color: boolean | undefined): string[] {
	// 65 columns wide banner using block characters
	const letters = [
		["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"], // R
		[
			" ██████╗ ",
			"██╔═══██╗",
			"██║   ██║",
			"██║   ██║",
			"╚██████╔╝",
			" ╚═════╝ ",
		], // O
		[
			"  █████╗ ",
			" ██╔══██╗",
			" ███████║",
			" ██╔══██║",
			" ██║  ██║",
			" ╚═╝  ╚═╝",
		], // A
		[
			" ██████╗ ",
			" ██╔══██╗",
			" ██║  ██║",
			" ██╔══██╗",
			" ██████╔╝",
			" ╚═════╝ ",
		], // D
		[
			" ███╗   ███╗",
			" ████╗ ████║",
			" ██╔████╔██║",
			" ██║╚██╔╝██║",
			" ██║ ╚═╝ ██║",
			" ╚═╝     ╚═╝",
		], // M
		[
			"  █████╗ ",
			" ██╔══██╗",
			" ███████║",
			" ██╔══██║",
			" ██║  ██║",
			" ╚═╝  ╚═╝",
		], // A
		[
			" ██████╗ ",
			" ██╔══██╗",
			" ██████╔╝",
			" ██╔═══╝ ",
			" ██║     ",
			" ╚═╝     ",
		], // P
	];

	const colors = [red, yellow, green, cyan, blue, _magenta, red];

	const lines = ["", "", "", "", "", ""];
	for (let i = 0; i < letters.length; i++) {
		const letter = letters[i]!;
		const colorFn = colors[i]!;
		for (let j = 0; j < 6; j++) {
			lines[j] += colorFn(color, letter[j]!);
		}
	}
	return lines;
}

function getNarrowLogoLines(color: boolean | undefined): string[] {
	// Minimal fallback for very narrow terminals
	return [bold(color, "Roadmap.md")];
}

// Terminal hyperlinks (OSC 8). Safely ignored by terminals that don't support them.
function osc8(text: string, url: string, enabled: boolean): string {
	if (!enabled) return text;
	const start = `\u001B]8;;${url}\u0007`;
	const end = "\u001B]8;;\u0007";
	return `${start}${text}${end}`;
}

export async function printSplash(opts: SplashOptions): Promise<void> {
	const { version, revision, initialized, plain, color } = opts;
	const versionLabel = revision
		? `v${version} • rev ${revision}`
		: `v${version}`;

	const width = Math.max(0, Number(process.stdout.columns || 0));
	// Fixed accent color; no terminal theme detection
	const accent = cyan;

	// Use wide banner only for proper widths; otherwise keep it minimal
	const useWide = !plain && (width === 0 || width >= 80);

	const lines: string[] = [];

	if (useWide) {
		// Add an empty line before the logo for breathing room
		lines.push("");
		lines.push(...getWideLogoLines(color));
		lines.push("");
		lines.push(`${bold(color, "Roadmap.md")} ${dim(color, versionLabel)}`);
	} else if (!plain && (width === 0 || width >= 20)) {
		// Also add space before the narrow logo variant
		lines.push("");
		lines.push(...getNarrowLogoLines(color));
		lines.push(dim(color, versionLabel));
	} else {
		lines.push(`${bold(color, "Roadmap.md")} ${versionLabel}`);
	}

	lines.push("");

	if (!initialized) {
		lines.push(bold(color, "Not initialized"));
		lines.push(
			`  ${green(color, "roadmap init")}  ${dim(color, "Initialize Roadmap.md in this repo")}`,
		);
	} else {
		lines.push(bold(color, "Quickstart"));
		lines.push(
			`  ${accent(color, 'roadmap proposal create "Title" -d "Description"')}  ${dim(color, "Create a new proposal")}`,
		);
		lines.push(
			`  ${accent(color, "roadmap proposal list --plain")}  ${dim(color, "List proposals (plain text)")}`,
		);
		lines.push(
			`  ${accent(color, "roadmap board")}  ${dim(color, "Open the TUI Kanban board")}`,
		);
		lines.push(
			`  ${accent(color, "roadmap browser")}  ${dim(color, "Start the web UI")}`,
		);
		lines.push(
			`  ${accent(color, "roadmap overview")}  ${dim(color, "Show project statistics")}`,
		);
	}

	lines.push("");
	const linkTarget = "https://roadmap.md";
	// Enable hyperlink on TTY regardless of color; respect --plain
	const hyperlinkEnabled = !!process.stdout.isTTY && !plain;
	const clickable = osc8(linkTarget, linkTarget, hyperlinkEnabled);
	lines.push(`${bold(color, "Docs:")} ${clickable}`);
	// Add a trailing blank line for visual spacing
	lines.push("");

	// Print and return; do not start any UI loop
	for (const l of lines) process.stdout.write(`${l}\n`);
}
