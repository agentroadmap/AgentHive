import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import { Core } from "../../core/roadmap.ts";
import type { Proposal } from "../types/index.ts";
import {
	buildFilenameIdRegex,
	buildGlobPattern,
	escapeRegex,
	extractAnyPrefix,
	hasAnyPrefix,
	idForFilename,
	normalizeId,
} from "./prefix-config.ts";

// Interface for proposal path resolution context
interface ProposalPathContext {
	filesystem: {
		proposalsDir: string;
	};
}

/** Default prefix for proposals */
const DEFAULT_STATE_PREFIX = "proposal";

/**
 * Normalize a proposal ID by ensuring the prefix is present (uppercase).
 * If no explicit prefix is provided, preserve any prefix already in the input.
 *
 * @param proposalId - The ID to normalize (e.g., "123", "proposal-123", "STATE-123")
 * @param prefix - The prefix to use (default: "proposal")
 * @returns Normalized ID with uppercase prefix (e.g., "STATE-123")
 *
 * @example
 * normalizeProposalId("123") // => "STATE-123"
 * normalizeProposalId("proposal-123") // => "STATE-123"
 * normalizeProposalId("STATE-123") // => "STATE-123"
 * normalizeProposalId("JIRA-456") // => "JIRA-456"
 */
export function normalizeProposalId(
	proposalId: string,
	prefix: string = DEFAULT_STATE_PREFIX,
): string {
	const inferredPrefix = extractAnyPrefix(proposalId);
	if (inferredPrefix) {
		const body = proposalId.slice(inferredPrefix.length).replace(/^-/, "");
		// Treat single-letter "s" as shorthand for "proposal"
		const effectivePrefix =
			inferredPrefix.length === 1 && inferredPrefix === "s"
				? prefix
				: inferredPrefix;
		return `${effectivePrefix.toLowerCase()}-${body.toLowerCase()}`;
	}
	return `${prefix.toLowerCase()}-${proposalId.toLowerCase()}`;
}

export function normalizeProposalIdentity(proposal: Proposal): Proposal {
	const normalizedId = normalizeProposalId(String(proposal.id));
	const normalizedParent = proposal.parentProposalId
		? normalizeProposalId(String(proposal.parentProposalId))
		: undefined;

	return {
		...proposal,
		id: normalizedId,
		parentProposalId: normalizedParent,
	};
}

export function extractProposalIdFromFilePath(filePath: string): string | null {
	const filename = filePath.split(/[/\\]/).pop() ?? filePath;
	if (!filename.toLowerCase().endsWith(".md")) {
		return null;
	}

	const stem = filename.slice(0, -3).trim();
	const candidate = (stem.split(" - ")[0] ?? stem).trim();
	if (!candidate || !hasAnyPrefix(candidate)) {
		return null;
	}

	const prefix = extractAnyPrefix(candidate);
	return prefix ? normalizeProposalId(candidate, prefix) : null;
}

/**
 * Extracts the body (numeric portion) from a proposal ID.
 *
 * @param value - The value to extract from (e.g., "proposal-123", "123", "proposal-5.2.1")
 * @param prefix - The prefix to strip (default: "proposal")
 * @returns The body portion, or null if invalid format
 *
 * @example
 * extractProposalBody("proposal-123") // => "123"
 * extractProposalBody("123") // => "123"
 * extractProposalBody("proposal-5.2.1") // => "5.2.1"
 * extractProposalBody("JIRA-456", "JIRA") // => "456"
 */
function extractProposalBody(
	value: string,
	prefix: string = DEFAULT_STATE_PREFIX,
): string | null {
	const trimmed = value.trim();
	if (trimmed === "") return "";
	// Build a pattern that optionally matches the prefix (with or without hyphen)
	const prefixPattern = new RegExp(
		`^(?:${escapeRegex(prefix)}-?)?([0-9]+(?:\\.[0-9]+)*)$`,
		"i",
	);
	const match = trimmed.match(prefixPattern);
	return match?.[1] ?? null;
}

/**
 * Extracts the proposal ID from a filename.
 *
 * @param filename - The filename to extract from (e.g., "proposal-123 - Some Title.md")
 * @param prefix - The prefix to match (default: "proposal")
 * @returns The normalized proposal ID, or null if not found
 *
 * @example
 * extractProposalIdFromFilename("proposal-123 - Title.md") // => "proposal-123"
 * extractProposalIdFromFilename("JIRA-456 - Title.md", "JIRA") // => "JIRA-456"
 */
function extractProposalIdFromFilename(
	filename: string,
	prefix: string = DEFAULT_STATE_PREFIX,
): string | null {
	const extracted = extractProposalIdFromFilePath(filename);
	if (extracted) {
		return extracted;
	}

	const regex = buildFilenameIdRegex(prefix);
	const match = filename.match(regex);
	if (!match || !match[1]) return null;
	return normalizeProposalId(`${prefix}-${match[1]}`, prefix);
}

/**
 * Compares two proposal IDs for equality.
 * Handles numeric comparison to treat "proposal-1" and "proposal-01" as equal.
 * Automatically detects prefix from either ID when comparing numeric-only input.
 *
 * @param left - First ID to compare
 * @param right - Second ID to compare
 * @param prefix - The prefix both IDs should have (default: "proposal")
 * @returns true if IDs are equivalent
 *
 * @example
 * proposalIdsEqual("proposal-123", "STATE-123") // => true
 * proposalIdsEqual("proposal-1", "proposal-01") // => true (numeric comparison)
 * proposalIdsEqual("proposal-1.2", "proposal-1.2") // => true
 * proposalIdsEqual("358", "BACK-358") // => true (detects prefix from right)
 */
export function proposalIdsEqual(
	left: string | number,
	right: string | number,
	prefix: string = DEFAULT_STATE_PREFIX,
): boolean {
	const leftStr = String(left);
	const rightStr = String(right);

	// Detect actual prefix from either ID - if one has a prefix, use it
	const leftPrefix = extractAnyPrefix(leftStr);
	const rightPrefix = extractAnyPrefix(rightStr);
	const effectivePrefix = leftPrefix ?? rightPrefix ?? prefix;

	const leftBody = extractProposalBody(leftStr, effectivePrefix);
	const rightBody = extractProposalBody(rightStr, effectivePrefix);

	if (leftBody && rightBody) {
		const leftSegs = leftBody.split(".").map((seg) => Number.parseInt(seg, 10));
		const rightSegs = rightBody
			.split(".")
			.map((seg) => Number.parseInt(seg, 10));
		if (leftSegs.length !== rightSegs.length) {
			return false;
		}
		return leftSegs.every((value, index) => value === rightSegs[index]);
	}

	return (
		normalizeProposalId(leftStr, effectivePrefix).toLowerCase() ===
		normalizeProposalId(rightStr, effectivePrefix).toLowerCase()
	);
}

/**
 * Checks if an input ID matches a filename loosely (ignoring leading zeros).
 */
function idsMatchLoosely(
	inputId: string,
	filename: string,
	prefix: string = DEFAULT_STATE_PREFIX,
): boolean {
	const candidate = extractProposalIdFromFilename(filename, prefix);
	if (!candidate) return false;
	return proposalIdsEqual(inputId, candidate, prefix);
}

/**
 * Get the file path for a proposal by ID.
 * For numeric-only IDs, automatically detects the prefix from existing files.
 */
export async function getProposalPath(
	proposalId: string,
	core?: Core | ProposalPathContext,
): Promise<string | null> {
	const coreInstance = core || new Core(process.cwd());
	const detectedPrefix = extractAnyPrefix(proposalId);

	// Helper to list .md files in proposals directory
	const listMdFiles = async () => {
		const dirPath = coreInstance.filesystem.proposalsDir;
		const entries = await readdir(dirPath);
		return entries.filter((f) => f.toLowerCase().endsWith(".md"));
	};

	// If prefix is detected, search only for that prefix
	if (detectedPrefix) {
		try {
			const files = await listMdFiles();
			const proposalFile = findMatchingFile(files, proposalId, detectedPrefix);
			if (proposalFile) {
				return join(coreInstance.filesystem.proposalsDir, proposalFile);
			}
		} catch {
			// ignore and fall through to return null
		}
		return null;
	}

	// For numeric-only IDs, scan all .md files and find one matching the number
	try {
		const allFiles = await listMdFiles();
		const numericPart = proposalId.trim();
		for (const file of allFiles) {
			const filePrefix = extractAnyPrefix(file);
			if (filePrefix && filePrefix !== "draft") {
				// Don't match drafts when looking for proposals
				const fileBody = extractProposalBodyFromFilename(file, filePrefix);
				if (fileBody && numericPartsEqual(numericPart, fileBody)) {
					return join(coreInstance.filesystem.proposalsDir, file);
				}
			}
		}

		// Fallback: search by prefix if configured
		const fs = coreInstance.filesystem as any;
		const config = await fs.loadConfig?.();
		const configuredPrefix = config?.prefixes?.proposal || DEFAULT_STATE_PREFIX;
		const fallbackFile = findMatchingFile(
			allFiles,
			proposalId,
			configuredPrefix,
		);
		if (fallbackFile) {
			return join(coreInstance.filesystem.proposalsDir, fallbackFile);
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Helper to find a matching file from a list of files
 */
function findMatchingFile(
	files: string[],
	proposalId: string,
	prefix: string,
): string | undefined {
	const normalizedId = normalizeProposalId(proposalId, prefix);
	const filenameId = idForFilename(normalizedId);

	// First try exact prefix match for speed
	let proposalFile = files.find((f) => {
		const lower = f.toLowerCase();
		return (
			lower === `${filenameId}.md` ||
			lower.startsWith(`${filenameId} -`) ||
			lower.startsWith(`${filenameId}-`)
		);
	});

	// If not found, try loose numeric match ignoring leading zeros
	if (!proposalFile) {
		proposalFile = files.find((f) => {
			const extractedId = extractProposalIdFromFilePath(f);
			if (extractedId) {
				return proposalIdsEqual(proposalId, extractedId, prefix);
			}
			return idsMatchLoosely(proposalId, f, prefix);
		});
	}

	return proposalFile;
}

/**
 * Extract the numeric body from a filename given a prefix
 */
function extractProposalBodyFromFilename(
	filename: string,
	prefix: string,
): string | null {
	// Pattern: <prefix>-<number> - <title>.md or <prefix><number> - <title>.md
	// We want to be greedy with digits but stop before the " - " title separator
	const regex = new RegExp(`^${escapeRegex(prefix)}-?([^\\s-]+)`, "i");
	const match = filename.match(regex);
	return match ? (match[1] ?? null) : null;
}

/**
 * Compare two numeric parts for equality (handles leading zeros)
 * Returns false if either string contains non-numeric segments
 */
function numericPartsEqual(a: string, b: string): boolean {
	const aSegments = a.split(".");
	const bSegments = b.split(".");

	// Validate all segments are purely numeric (digits only)
	const isNumeric = (s: string) => /^\d+$/.test(s);
	if (!aSegments.every(isNumeric) || !bSegments.every(isNumeric)) {
		return false;
	}

	if (aSegments.length !== bSegments.length) return false;

	const aParts = aSegments.map((s) => Number.parseInt(s, 10));
	const bParts = bSegments.map((s) => Number.parseInt(s, 10));
	return aParts.every((val, i) => val === bParts[i]);
}

/** Default prefix for drafts */
const DEFAULT_DRAFT_PREFIX = "draft";

/**
 * Normalize a draft ID by ensuring the draft prefix is present (uppercase).
 */
function normalizeDraftId(draftId: string): string {
	return normalizeId(draftId, DEFAULT_DRAFT_PREFIX);
}

/**
 * Checks if an input ID matches a filename loosely for drafts.
 */
function draftIdsMatchLoosely(inputId: string, filename: string): boolean {
	const candidate = extractDraftIdFromFilename(filename);
	if (!candidate) return false;
	return draftIdsEqual(inputId, candidate);
}

/**
 * Extracts the draft ID from a filename.
 */
function extractDraftIdFromFilename(filename: string): string | null {
	const regex = buildFilenameIdRegex(DEFAULT_DRAFT_PREFIX);
	const match = filename.match(regex);
	if (!match || !match[1]) return null;
	return normalizeDraftId(`${DEFAULT_DRAFT_PREFIX}-${match[1]}`);
}

/**
 * Compares two draft IDs for equality.
 */
function draftIdsEqual(left: string, right: string): boolean {
	const leftBody = extractDraftBody(left);
	const rightBody = extractDraftBody(right);

	if (leftBody && rightBody) {
		const leftSegs = leftBody.split(".").map((seg) => Number.parseInt(seg, 10));
		const rightSegs = rightBody
			.split(".")
			.map((seg) => Number.parseInt(seg, 10));
		if (leftSegs.length !== rightSegs.length) {
			return false;
		}
		return leftSegs.every((value, index) => value === rightSegs[index]);
	}

	return (
		normalizeDraftId(left).toLowerCase() ===
		normalizeDraftId(right).toLowerCase()
	);
}

/**
 * Extracts the body from a draft ID.
 */
function extractDraftBody(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === "") return "";
	const prefixPattern = new RegExp(
		`^(?:${escapeRegex(DEFAULT_DRAFT_PREFIX)}-)?([0-9]+(?:\\.[0-9]+)*)$`,
		"i",
	);
	const match = trimmed.match(prefixPattern);
	return match?.[1] ?? null;
}

/**
 * Get the file path for a draft by ID
 */
export async function getDraftPath(
	draftId: string,
	core: Core,
): Promise<string | null> {
	try {
		const draftsDir = await core.filesystem.getDraftsDir();
		const files = await glob(buildGlobPattern("draft"), { cwd: draftsDir });
		const normalizedId = normalizeDraftId(draftId);
		// Use lowercase ID for filename matching (filenames use lowercase prefix)
		const filenameId = idForFilename(normalizedId);
		// First exact match
		let draftFile = files.find(
			(f) => f.startsWith(`${filenameId} -`) || f.startsWith(`${filenameId}-`),
		);
		// Fallback to loose numeric match ignoring leading zeros
		if (!draftFile) {
			draftFile = files.find((f) => draftIdsMatchLoosely(draftId, f));
		}

		if (draftFile) {
			return join(draftsDir, draftFile);
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Get the filename (without directory) for a proposal by ID.
 * For numeric-only IDs, automatically detects the prefix from existing files.
 */
export async function getProposalFilename(
	proposalId: string,
	core?: Core | ProposalPathContext,
): Promise<string | null> {
	const coreInstance = core || new Core(process.cwd());

	// Extract prefix from the proposalId
	const detectedPrefix = extractAnyPrefix(proposalId);

	// If prefix is detected, search only for that prefix
	if (detectedPrefix) {
		const globPattern = buildGlobPattern(detectedPrefix);
		try {
			const files = await glob(globPattern, {
				cwd: coreInstance.filesystem.proposalsDir,
			});
			return findMatchingFile(files, proposalId, detectedPrefix) ?? null;
		} catch {
			return null;
		}
	}

	// For numeric-only IDs, scan all .md files and find one matching the number
	try {
		const allFiles = await glob("*.md", {
			cwd: coreInstance.filesystem.proposalsDir,
		});

		const numericPart = proposalId.trim();
		for (const file of allFiles) {
			const filePrefix = extractAnyPrefix(file);
			if (filePrefix) {
				const fileBody = extractProposalBodyFromFilename(file, filePrefix);
				if (fileBody && numericPartsEqual(numericPart, fileBody)) {
					return file;
				}
			}
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Check if a proposal file exists
 */
export async function proposalFileExists(
	proposalId: string,
	core?: Core | ProposalPathContext,
): Promise<boolean> {
	const path = await getProposalPath(proposalId, core);
	return path !== null;
}
