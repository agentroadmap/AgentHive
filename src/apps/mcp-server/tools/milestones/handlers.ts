import { rename as moveFile } from "node:fs/promises";
import type { Directive, Proposal } from "../../../../shared/types/index.ts";
import { McpError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import {
	buildDirectiveMatchKeys,
	directiveKey,
	keySetsIntersect,
	normalizeDirectiveName,
	resolveDirectiveStorageValue,
} from "../../utils/milestone-resolution.ts";

export type DirectiveAddArgs = {
	name: string;
	description?: string;
};

export type DirectiveRenameArgs = {
	from: string;
	to: string;
	updateProposals?: boolean;
};

export type DirectiveRemoveArgs = {
	name: string;
	proposalHandling?: "clear" | "keep" | "reassign";
	reassignTo?: string;
};

export type DirectiveArchiveArgs = {
	name: string;
};

function collectArchivedDirectiveKeys(
	archivedDirectives: Directive[],
	activeDirectives: Directive[],
): string[] {
	const keys = new Set<string>();
	const activeTitleKeys = new Set(
		activeDirectives
			.map((directive) => directiveKey(directive.title))
			.filter(Boolean),
	);

	for (const directive of archivedDirectives) {
		const idKey = directiveKey(directive.id);
		if (idKey) {
			keys.add(idKey);
		}
		const titleKey = directiveKey(directive.title);
		if (titleKey && !activeTitleKeys.has(titleKey)) {
			keys.add(titleKey);
		}
	}

	return Array.from(keys);
}

function formatListBlock(title: string, items: string[]): string {
	if (items.length === 0) {
		return `${title}\n  (none)`;
	}
	return `${title}\n${items.map((item) => `  - ${item}`).join("\n")}`;
}

function formatProposalIdList(proposalIds: string[], limit = 20): string {
	if (proposalIds.length === 0) return "";
	const shown = proposalIds.slice(0, limit);
	const suffix =
		proposalIds.length > limit
			? ` (and ${proposalIds.length - limit} more)`
			: "";
	return `${shown.join(", ")}${suffix}`;
}

function findActiveDirectiveByAlias(
	name: string,
	directives: Directive[],
): Directive | undefined {
	const normalized = normalizeDirectiveName(name);
	const key = directiveKey(normalized);
	if (!key) {
		return undefined;
	}
	const resolvedId = resolveDirectiveStorageValue(normalized, directives);
	const resolvedKey = directiveKey(resolvedId);
	const idMatch = directives.find(
		(directive) => directiveKey(directive.id) === resolvedKey,
	);
	if (idMatch) {
		return idMatch;
	}
	const titleMatches = directives.filter(
		(directive) => directiveKey(directive.title) === key,
	);
	return titleMatches.length === 1 ? titleMatches[0] : undefined;
}

function buildProposalMatchKeysForDirective(
	name: string,
	directive?: Directive,
	includeTitleMatch = true,
): Set<string> {
	if (!directive) {
		return buildDirectiveMatchKeys(name, []);
	}
	const baseValue = includeTitleMatch ? name : directive.id;
	const keys = buildDirectiveMatchKeys(baseValue, [directive]);
	for (const key of buildDirectiveMatchKeys(directive.id, [directive])) {
		keys.add(key);
	}
	const titleKey = directiveKey(directive.title);
	if (titleKey) {
		if (includeTitleMatch) {
			keys.add(titleKey);
		} else {
			keys.delete(titleKey);
		}
	}
	return keys;
}

function buildDirectiveRecordMatchKeys(directive: Directive): Set<string> {
	const keys = buildDirectiveMatchKeys(directive.id, [directive]);
	const titleKey = directiveKey(directive.title);
	if (titleKey) {
		keys.add(titleKey);
	}
	return keys;
}

function hasDirectiveTitleAliasCollision(
	sourceDirective: Directive,
	candidates: Directive[],
): boolean {
	const sourceDirectiveIdKey = directiveKey(sourceDirective.id);
	const sourceTitleKey = directiveKey(sourceDirective.title);
	if (!sourceTitleKey) {
		return false;
	}
	return candidates.some((candidate) => {
		if (directiveKey(candidate.id) === sourceDirectiveIdKey) {
			return false;
		}
		return buildDirectiveRecordMatchKeys(candidate).has(sourceTitleKey);
	});
}

function resolveDirectiveValueForReporting(
	value: string,
	activeDirectives: Directive[],
	archivedDirectives: Directive[],
): string {
	const normalized = normalizeDirectiveName(value);
	if (!normalized) {
		return "";
	}
	const inputKey = directiveKey(normalized);
	const looksLikeDirectiveId =
		/^\d+$/.test(normalized) || /^m-\d+$/i.test(normalized);
	const canonicalInputId = looksLikeDirectiveId
		? `m-${String(Number.parseInt(normalized.replace(/^m-/i, ""), 10))}`
		: null;
	const aliasKeys = new Set<string>([inputKey]);
	if (canonicalInputId) {
		const numericAlias = canonicalInputId.replace(/^m-/, "");
		aliasKeys.add(canonicalInputId);
		aliasKeys.add(numericAlias);
	}

	const idMatchesAlias = (directiveId: string): boolean => {
		const idKey = directiveKey(directiveId);
		if (aliasKeys.has(idKey)) {
			return true;
		}
		const idMatch = directiveId.trim().match(/^m-(\d+)$/i);
		if (!idMatch?.[1]) {
			return false;
		}
		const numericAlias = String(Number.parseInt(idMatch[1], 10));
		return aliasKeys.has(`m-${numericAlias}`) || aliasKeys.has(numericAlias);
	};
	const findIdMatch = (directives: Directive[]): Directive | undefined => {
		const rawExactMatch = directives.find(
			(directive) => directiveKey(directive.id) === inputKey,
		);
		if (rawExactMatch) {
			return rawExactMatch;
		}
		if (canonicalInputId) {
			const canonicalRawMatch = directives.find(
				(directive) => directiveKey(directive.id) === canonicalInputId,
			);
			if (canonicalRawMatch) {
				return canonicalRawMatch;
			}
		}
		return directives.find((directive) => idMatchesAlias(directive.id));
	};
	const findUniqueTitleMatch = (
		directives: Directive[],
	): Directive | undefined => {
		const titleMatches = directives.filter(
			(directive) => directiveKey(directive.title) === inputKey,
		);
		return titleMatches.length === 1 ? titleMatches[0] : undefined;
	};

	const activeTitleMatches = activeDirectives.filter(
		(directive) => directiveKey(directive.title) === inputKey,
	);
	if (looksLikeDirectiveId) {
		const activeIdMatch = findIdMatch(activeDirectives);
		if (activeIdMatch) {
			return activeIdMatch.id;
		}
		const archivedIdMatch = findIdMatch(archivedDirectives);
		if (archivedIdMatch) {
			return archivedIdMatch.id;
		}
		if (activeTitleMatches.length === 1) {
			return activeTitleMatches[0]?.id ?? normalized;
		}
		if (activeTitleMatches.length > 1) {
			return normalized;
		}
		return findUniqueTitleMatch(archivedDirectives)?.id ?? normalized;
	}

	const activeTitleMatch = findUniqueTitleMatch(activeDirectives);
	if (activeTitleMatch) {
		return activeTitleMatch.id;
	}
	if (activeTitleMatches.length > 1) {
		return normalized;
	}
	const activeIdMatch = findIdMatch(activeDirectives);
	if (activeIdMatch) {
		return activeIdMatch.id;
	}
	const archivedTitleMatch = findUniqueTitleMatch(archivedDirectives);
	if (archivedTitleMatch) {
		return archivedTitleMatch.id;
	}
	return findIdMatch(archivedDirectives)?.id ?? normalized;
}

export class DirectiveHandlers {
	private readonly core: McpServer;

	constructor(core: McpServer) {
		this.core = core;
	}

	private async listLocalProposals(): Promise<Proposal[]> {
		return await this.core.queryProposals({ includeCrossBranch: false });
	}

	private async rollbackProposalDirectives(
		previousDirectives: Map<string, string | undefined>,
	): Promise<string[]> {
		const failedProposalIds: string[] = [];
		for (const [proposalId, directive] of previousDirectives.entries()) {
			try {
				await this.core.editProposal(
					proposalId,
					{ directive: directive ?? null },
					false,
				);
			} catch {
				failedProposalIds.push(proposalId);
			}
		}
		return failedProposalIds.sort((a, b) => a.localeCompare(b));
	}

	private async commitDirectiveMutation(
		commitMessage: string,
		options: {
			sourcePath?: string;
			targetPath?: string;
			proposalFilePaths?: Iterable<string>;
		},
	): Promise<void> {
		const shouldAutoCommit = await this.core.shouldAutoCommit();
		if (!shouldAutoCommit) {
			return;
		}

		let repoRoot: string | null = null;
		const commitPaths: string[] = [];
		if (options.sourcePath && options.targetPath) {
			repoRoot = await this.core.git.stageFileMove(
				options.sourcePath,
				options.targetPath,
			);
			commitPaths.push(options.sourcePath, options.targetPath);
		}
		for (const filePath of options.proposalFilePaths ?? []) {
			await this.core.git.addFile(filePath);
			commitPaths.push(filePath);
		}
		try {
			await this.core.git.commitFiles(commitMessage, commitPaths, repoRoot);
		} catch (error) {
			await this.core.git.resetPaths(commitPaths, repoRoot);
			throw error;
		}
	}

	private async listFileDirectives(): Promise<Directive[]> {
		return await this.core.filesystem.listDirectives();
	}

	private async listArchivedDirectives(): Promise<Directive[]> {
		return await this.core.filesystem.listArchivedDirectives();
	}

	async listDirectives(): Promise<CallToolResult> {
		// Get file-based directives
		const fileDirectives = await this.listFileDirectives();
		const archivedDirectives = await this.listArchivedDirectives();
		const reservedIdKeys = new Set<string>();
		for (const directive of [...fileDirectives, ...archivedDirectives]) {
			for (const key of buildDirectiveMatchKeys(directive.id, [])) {
				reservedIdKeys.add(key);
			}
		}
		const activeTitleCounts = new Map<string, number>();
		for (const directive of fileDirectives) {
			const titleKey = directiveKey(directive.title);
			if (!titleKey) continue;
			activeTitleCounts.set(
				titleKey,
				(activeTitleCounts.get(titleKey) ?? 0) + 1,
			);
		}
		const fileDirectiveKeys = new Set<string>();
		for (const directive of fileDirectives) {
			for (const key of buildDirectiveMatchKeys(directive.id, [])) {
				fileDirectiveKeys.add(key);
			}
			const titleKey = directiveKey(directive.title);
			if (
				titleKey &&
				!reservedIdKeys.has(titleKey) &&
				activeTitleCounts.get(titleKey) === 1
			) {
				fileDirectiveKeys.add(titleKey);
			}
		}
		const archivedKeys = new Set<string>(
			collectArchivedDirectiveKeys(archivedDirectives, fileDirectives),
		);

		// Get directives discovered from proposals
		const proposals = await this.listLocalProposals();
		const discoveredByKey = new Map<string, string>();
		for (const proposal of proposals) {
			const normalized = normalizeDirectiveName(proposal.directive ?? "");
			if (!normalized) continue;
			const canonicalValue = resolveDirectiveValueForReporting(
				normalized,
				fileDirectives,
				archivedDirectives,
			);
			const key = directiveKey(canonicalValue);
			if (!discoveredByKey.has(key)) {
				discoveredByKey.set(key, canonicalValue);
			}
		}

		const unconfigured = Array.from(discoveredByKey.entries())
			.filter(([key]) => !fileDirectiveKeys.has(key) && !archivedKeys.has(key))
			.map(([, value]) => value)
			.sort((a, b) => a.localeCompare(b));
		const archivedProposalValues = Array.from(discoveredByKey.entries())
			.filter(([key]) => !fileDirectiveKeys.has(key) && archivedKeys.has(key))
			.map(([, value]) => value)
			.sort((a, b) => a.localeCompare(b));

		const blocks: string[] = [];
		const directiveLines = fileDirectives.map((m) => `${m.id}: ${m.title}`);
		blocks.push(
			formatListBlock(`Directives (${fileDirectives.length}):`, directiveLines),
		);
		blocks.push(
			formatListBlock(
				`Directives found on proposals without files (${unconfigured.length}):`,
				unconfigured,
			),
		);
		blocks.push(
			formatListBlock(
				`Archived directive values still on proposals (${archivedProposalValues.length}):`,
				archivedProposalValues,
			),
		);
		blocks.push(
			"Hint: use directive_add to create directive files, directive_rename / directive_remove to manage, directive_archive to archive.",
		);

		return {
			content: [
				{
					type: "text",
					text: blocks.join("\n\n"),
				},
			],
		};
	}

	async addDirective(args: DirectiveAddArgs): Promise<CallToolResult> {
		const name = normalizeDirectiveName(args.name);
		if (!name) {
			throw new McpError("Directive name cannot be empty.", "VALIDATION_ERROR");
		}

		// Check for duplicates in existing directive files
		const existing = await this.listFileDirectives();
		const requestedKeys = buildDirectiveMatchKeys(name, existing);
		const duplicate = existing.find((directive) => {
			const directiveKeys = buildDirectiveRecordMatchKeys(directive);
			return keySetsIntersect(requestedKeys, directiveKeys);
		});
		if (duplicate) {
			throw new McpError(
				`Directive alias conflict: "${name}" matches existing directive "${duplicate.title}" (${duplicate.id}).`,
				"VALIDATION_ERROR",
			);
		}

		// Create directive file
		const directive = await this.core.filesystem.createDirective(
			name,
			args.description,
		);

		return {
			content: [
				{
					type: "text",
					text: `Created directive "${directive.title}" (${directive.id}).`,
				},
			],
		};
	}

	async renameDirective(args: DirectiveRenameArgs): Promise<CallToolResult> {
		const fromName = normalizeDirectiveName(args.from);
		const toName = normalizeDirectiveName(args.to);
		if (!fromName || !toName) {
			throw new McpError(
				"Both 'from' and 'to' directive names are required.",
				"VALIDATION_ERROR",
			);
		}

		const fileDirectives = await this.listFileDirectives();
		const archivedDirectives = await this.listArchivedDirectives();
		const sourceDirective = findActiveDirectiveByAlias(
			fromName,
			fileDirectives,
		);
		if (!sourceDirective) {
			throw new McpError(`Directive not found: "${fromName}"`, "NOT_FOUND");
		}
		if (toName === sourceDirective.title.trim()) {
			return {
				content: [
					{
						type: "text",
						text: `Directive "${sourceDirective.title}" (${sourceDirective.id}) is already named "${sourceDirective.title}". No changes made.`,
					},
				],
			};
		}
		const hasTitleCollision = hasDirectiveTitleAliasCollision(sourceDirective, [
			...fileDirectives,
			...archivedDirectives,
		]);

		const targetKeys = buildDirectiveMatchKeys(toName, fileDirectives);
		const aliasConflict = fileDirectives.find(
			(directive) =>
				directiveKey(directive.id) !== directiveKey(sourceDirective.id) &&
				keySetsIntersect(targetKeys, buildDirectiveRecordMatchKeys(directive)),
		);
		if (aliasConflict) {
			throw new McpError(
				`Directive alias conflict: "${toName}" matches existing directive "${aliasConflict.title}" (${aliasConflict.id}).`,
				"VALIDATION_ERROR",
			);
		}

		const targetDirective = sourceDirective.id;
		const shouldUpdateProposals = args.updateProposals ?? true;
		const proposals = shouldUpdateProposals
			? await this.listLocalProposals()
			: [];
		const matchKeys = shouldUpdateProposals
			? buildProposalMatchKeysForDirective(
					fromName,
					sourceDirective,
					!hasTitleCollision,
				)
			: new Set<string>();
		const matches = shouldUpdateProposals
			? proposals.filter((proposal) =>
					matchKeys.has(directiveKey(proposal.directive ?? "")),
				)
			: [];
		let updatedProposalIds: string[] = [];
		const updatedProposalFilePaths = new Set<string>();

		const renameResult = await this.core.renameDirective(
			sourceDirective.id,
			toName,
			false,
		);
		if (!renameResult.success || !renameResult.directive) {
			throw new McpError(
				`Failed to rename directive "${sourceDirective.title}".`,
				"INTERNAL_ERROR",
			);
		}

		const renamedDirective = renameResult.directive;
		const previousDirectives = new Map<string, string | undefined>();
		if (shouldUpdateProposals) {
			try {
				for (const proposal of matches) {
					previousDirectives.set(proposal.id, proposal.directive);
					const updatedProposal = await this.core.editProposal(
						proposal.id,
						{ directive: targetDirective },
						false,
					);
					const proposalFilePath =
						updatedProposal.filePath ?? proposal.filePath;
					if (proposalFilePath) {
						updatedProposalFilePaths.add(proposalFilePath);
					}
					updatedProposalIds.push(proposal.id);
				}
				updatedProposalIds = updatedProposalIds.sort((a, b) =>
					a.localeCompare(b),
				);
			} catch {
				const rollbackProposalFailures =
					await this.rollbackProposalDirectives(previousDirectives);
				const rollbackRenameResult = await this.core.renameDirective(
					sourceDirective.id,
					sourceDirective.title,
					false,
				);
				const rollbackDetails: string[] = [];
				if (!rollbackRenameResult.success) {
					rollbackDetails.push("failed to rollback directive file rename");
				}
				if (rollbackProposalFailures.length > 0) {
					rollbackDetails.push(
						`failed to rollback proposal directives for: ${rollbackProposalFailures.join(", ")}`,
					);
				}
				const detailSuffix =
					rollbackDetails.length > 0 ? ` (${rollbackDetails.join("; ")})` : "";
				throw new McpError(
					`Failed to update proposal directives after renaming "${sourceDirective.title}"${detailSuffix}.`,
					"INTERNAL_ERROR",
				);
			}
		}
		try {
			await this.commitDirectiveMutation(
				`roadmap: Rename directive ${sourceDirective.id}`,
				{
					sourcePath: renameResult.sourcePath,
					targetPath: renameResult.targetPath,
					proposalFilePaths: updatedProposalFilePaths,
				},
			);
		} catch {
			const rollbackProposalFailures =
				await this.rollbackProposalDirectives(previousDirectives);
			const rollbackRenameResult = await this.core.renameDirective(
				sourceDirective.id,
				sourceDirective.title,
				false,
			);
			const rollbackDetails: string[] = [];
			if (!rollbackRenameResult.success) {
				rollbackDetails.push("failed to rollback directive file rename");
			}
			if (rollbackProposalFailures.length > 0) {
				rollbackDetails.push(
					`failed to rollback proposal directives for: ${rollbackProposalFailures.join(", ")}`,
				);
			}
			const detailSuffix =
				rollbackDetails.length > 0 ? ` (${rollbackDetails.join("; ")})` : "";
			throw new McpError(
				`Failed while finalizing directive rename "${sourceDirective.title}"${detailSuffix}.`,
				"INTERNAL_ERROR",
			);
		}

		const summaryLines: string[] = [
			`Renamed directive "${sourceDirective.title}" (${sourceDirective.id}) → "${renamedDirective.title}" (${renamedDirective.id}).`,
		];
		if (shouldUpdateProposals) {
			summaryLines.push(
				`Updated ${updatedProposalIds.length} local proposal${updatedProposalIds.length === 1 ? "" : "s"}: ${formatProposalIdList(updatedProposalIds)}`,
			);
		} else {
			summaryLines.push("Skipped updating proposals (updateProposals=false).");
		}
		if (
			renameResult.sourcePath &&
			renameResult.targetPath &&
			renameResult.sourcePath !== renameResult.targetPath
		) {
			summaryLines.push(
				`Renamed directive file: ${renameResult.sourcePath} -> ${renameResult.targetPath}`,
			);
		}

		return {
			content: [
				{
					type: "text",
					text: summaryLines.join("\n"),
				},
			],
		};
	}

	async removeDirective(args: DirectiveRemoveArgs): Promise<CallToolResult> {
		const name = normalizeDirectiveName(args.name);
		if (!name) {
			throw new McpError("Directive name cannot be empty.", "VALIDATION_ERROR");
		}

		const fileDirectives = await this.listFileDirectives();
		const archivedDirectives = await this.listArchivedDirectives();
		const sourceDirective = findActiveDirectiveByAlias(name, fileDirectives);
		if (!sourceDirective) {
			throw new McpError(`Directive not found: "${name}"`, "NOT_FOUND");
		}
		const hasTitleCollision = hasDirectiveTitleAliasCollision(sourceDirective, [
			...fileDirectives,
			...archivedDirectives,
		]);
		const removeKeys = buildProposalMatchKeysForDirective(
			name,
			sourceDirective,
			!hasTitleCollision,
		);
		const proposalHandling = args.proposalHandling ?? "clear";
		const reassignTo = normalizeDirectiveName(args.reassignTo ?? "");
		const targetDirective =
			proposalHandling === "reassign"
				? findActiveDirectiveByAlias(reassignTo, fileDirectives)
				: undefined;
		const reassignedDirective = targetDirective?.id ?? "";

		if (proposalHandling === "reassign") {
			if (!reassignTo) {
				throw new McpError(
					"reassignTo is required when proposalHandling is reassign.",
					"VALIDATION_ERROR",
				);
			}
			if (!targetDirective) {
				throw new McpError(
					`Target directive not found: "${reassignTo}"`,
					"VALIDATION_ERROR",
				);
			}
			if (
				directiveKey(targetDirective.id) === directiveKey(sourceDirective.id)
			) {
				throw new McpError(
					"reassignTo must be different from the removed directive.",
					"VALIDATION_ERROR",
				);
			}
		}

		const proposals =
			proposalHandling !== "keep" ? await this.listLocalProposals() : [];
		const matches =
			proposalHandling !== "keep"
				? proposals.filter((proposal) =>
						removeKeys.has(directiveKey(proposal.directive ?? "")),
					)
				: [];
		const previousDirectives = new Map<string, string | undefined>();
		let updatedProposalIds: string[] = [];
		const updatedProposalFilePaths = new Set<string>();
		if (proposalHandling !== "keep") {
			try {
				for (const proposal of matches) {
					previousDirectives.set(proposal.id, proposal.directive);
					const updatedProposal = await this.core.editProposal(
						proposal.id,
						{
							directive:
								proposalHandling === "reassign" ? reassignedDirective : null,
						},
						false,
					);
					const proposalFilePath =
						updatedProposal.filePath ?? proposal.filePath;
					if (proposalFilePath) {
						updatedProposalFilePaths.add(proposalFilePath);
					}
					updatedProposalIds.push(proposal.id);
				}
				updatedProposalIds = updatedProposalIds.sort((a, b) =>
					a.localeCompare(b),
				);
			} catch {
				const rollbackFailures =
					await this.rollbackProposalDirectives(previousDirectives);
				const detailSuffix =
					rollbackFailures.length > 0
						? ` (failed rollback for: ${rollbackFailures.join(", ")})`
						: "";
				throw new McpError(
					`Failed while updating proposals for directive removal "${sourceDirective.title}"${detailSuffix}.`,
					"INTERNAL_ERROR",
				);
			}
		}

		const archiveResult = await this.core.archiveDirective(
			sourceDirective.id,
			false,
		);
		if (!archiveResult.success) {
			let detailSuffix = "";
			if (proposalHandling !== "keep") {
				const rollbackFailures =
					await this.rollbackProposalDirectives(previousDirectives);
				if (rollbackFailures.length > 0) {
					detailSuffix = ` (failed rollback for: ${rollbackFailures.join(", ")})`;
				}
			}
			throw new McpError(
				`Failed to archive directive "${sourceDirective.title}" before removal.${detailSuffix}`,
				"INTERNAL_ERROR",
			);
		}
		try {
			await this.commitDirectiveMutation(
				`roadmap: Remove directive ${sourceDirective.id}`,
				{
					sourcePath: archiveResult.sourcePath,
					targetPath: archiveResult.targetPath,
					proposalFilePaths: updatedProposalFilePaths,
				},
			);
		} catch {
			const rollbackDetails: string[] = [];
			if (archiveResult.sourcePath && archiveResult.targetPath) {
				try {
					await moveFile(archiveResult.targetPath, archiveResult.sourcePath);
				} catch {
					rollbackDetails.push("failed to rollback directive archive");
				}
			}
			if (proposalHandling !== "keep") {
				const rollbackFailures =
					await this.rollbackProposalDirectives(previousDirectives);
				if (rollbackFailures.length > 0) {
					rollbackDetails.push(
						`failed rollback for: ${rollbackFailures.join(", ")}`,
					);
				}
			}
			const detailSuffix =
				rollbackDetails.length > 0 ? ` (${rollbackDetails.join("; ")})` : "";
			throw new McpError(
				`Failed while finalizing directive removal "${sourceDirective.title}"${detailSuffix}.`,
				"INTERNAL_ERROR",
			);
		}

		const summaryLines: string[] = [
			`Removed directive "${sourceDirective.title}" (${sourceDirective.id}).`,
		];
		if (proposalHandling === "keep") {
			summaryLines.push(
				"Kept proposal directive values unchanged (proposalHandling=keep).",
			);
		} else if (proposalHandling === "reassign") {
			const targetSummary = `"${targetDirective?.title}" (${reassignedDirective})`;
			summaryLines.push(
				`Reassigned ${updatedProposalIds.length} local proposal${updatedProposalIds.length === 1 ? "" : "s"} to ${targetSummary}: ${formatProposalIdList(updatedProposalIds)}`,
			);
		} else {
			summaryLines.push(
				`Cleared directive for ${updatedProposalIds.length} local proposal${updatedProposalIds.length === 1 ? "" : "s"}: ${formatProposalIdList(updatedProposalIds)}`,
			);
		}
		return {
			content: [
				{
					type: "text",
					text: summaryLines.join("\n"),
				},
			],
		};
	}

	async archiveDirective(args: DirectiveArchiveArgs): Promise<CallToolResult> {
		const name = normalizeDirectiveName(args.name);
		if (!name) {
			throw new McpError("Directive name cannot be empty.", "VALIDATION_ERROR");
		}

		const result = await this.core.archiveDirective(name);
		if (!result.success) {
			throw new McpError(`Directive not found: "${name}"`, "NOT_FOUND");
		}

		const label = result.directive?.title ?? name;
		const id = result.directive?.id;

		return {
			content: [
				{
					type: "text",
					text: `Archived directive "${label}"${id ? ` (${id})` : ""}.`,
				},
			],
		};
	}
}
