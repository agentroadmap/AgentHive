import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	DEFAULT_DIRECTORIES,
	DEFAULT_FILES,
	DEFAULT_STATUSES,
} from "../../shared/constants/index.ts";
import {
	parseDecision,
	parseDirective,
	parseDocument,
	parseProposal,
} from "../../shared/markdown/parser.ts";
import {
	serializeDecision,
	serializeDocument,
	serializeProposal,
} from "../../shared/markdown/serializer.ts";
import type {
	Decision,
	Directive,
	Document,
	Proposal,
	ProposalListFilter,
	RoadmapConfig,
} from "../../types/index.ts";
import {
	documentIdsEqual,
	normalizeDocumentId,
} from "../../utils/document-id.ts";
import {
	extractAnyPrefix,
	generateNextId,
	hasAnyPrefix,
	idForFilename,
	normalizeId,
} from "../../utils/prefix-config.ts";
import {
	getProposalFilename,
	getProposalPath,
	normalizeProposalIdentity,
	proposalIdsEqual,
} from "../../utils/proposal-path.ts";
import { sortByProposalId } from "../../utils/proposal-sorting.ts";

const require = createRequire(import.meta.url);

// Interface for proposal path resolution context
interface ProposalPathContext {
	filesystem: {
		proposalsDir: string;
	};
}

export class FileSystem {
	private readonly roadmapDir: string;
	private readonly projectRoot: string;
	private cachedConfig: RoadmapConfig | null = null;
	private rawConfig: any = null;
	private currentConfigPath: string | null = null;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.roadmapDir = join(projectRoot, DEFAULT_DIRECTORIES.ROADMAP);
	}

	private getConfigSearchPaths(): string[] {
		return [
			join(this.projectRoot, "roadmap.yaml"),
			join(this.roadmapDir, "roadmap.yaml"),
			join(this.roadmapDir, DEFAULT_FILES.CONFIG),
		];
	}

	private resolveExistingConfigPath(): string | null {
		for (const configPath of this.getConfigSearchPaths()) {
			if (existsSync(configPath)) {
				return configPath;
			}
		}
		return null;
	}

	private async getRoadmapDir(): Promise<string> {
		// Ensure migration is checked if needed
		if (!this.cachedConfig) {
			this.cachedConfig = await this.loadConfigDirect();
		}
		// Always use "roadmap" as the directory name - no configuration needed
		return join(this.projectRoot, DEFAULT_DIRECTORIES.ROADMAP);
	}

	private async loadConfigDirect(): Promise<RoadmapConfig | null> {
		try {
			let configPath = this.resolveExistingConfigPath();
			let exists = configPath !== null;

			// If not found, check for legacy ".roadmap" directory and migrate it
			if (!exists) {
				const legacyRoadmapDir = join(this.projectRoot, ".roadmap");
				const legacyConfigPath = join(legacyRoadmapDir, DEFAULT_FILES.CONFIG);
				let legacyExists = false;
				try {
					await stat(legacyConfigPath);
					legacyExists = true;
				} catch {
					// Legacy file not found
				}

				if (legacyExists) {
					// Migrate legacy .roadmap directory to roadmap
					const newRoadmapDir = join(
						this.projectRoot,
						DEFAULT_DIRECTORIES.ROADMAP,
					);
					await rename(legacyRoadmapDir, newRoadmapDir);

					// Update paths to use the new location
					configPath = this.resolveExistingConfigPath();
					exists = configPath !== null;
				}
			}

			if (!exists || !configPath) {
				return null;
			}

			this.currentConfigPath = configPath;
			const content = await readFile(configPath, "utf-8");
			return this.parseConfig(content);
		} catch (_error) {
			if (process.env.DEBUG) {
				console.error("Error loading config:", _error);
			}
			return null;
		}
	}

	// Public accessors for directory paths
	get roadmapDirectory(): string {
		return this.roadmapDir;
	}
	get proposalsDir(): string {
		return join(this.roadmapDir, DEFAULT_DIRECTORIES.STATES);
	}
	get completedDir(): string {
		return join(this.roadmapDir, DEFAULT_DIRECTORIES.COMPLETED);
	}

	get archiveProposalsDir(): string {
		return join(this.roadmapDir, DEFAULT_DIRECTORIES.ARCHIVE_STATES);
	}
	get archiveDirectivesDir(): string {
		return join(this.roadmapDir, DEFAULT_DIRECTORIES.ARCHIVE_MILESTONES);
	}
	get decisionsDir(): string {
		return join(this.roadmapDir, DEFAULT_DIRECTORIES.DECISIONS);
	}

	get docsDir(): string {
		return join(this.projectRoot, DEFAULT_DIRECTORIES.DOCS);
	}

	get directivesDir(): string {
		return join(this.roadmapDir, DEFAULT_DIRECTORIES.MILESTONES);
	}

	get configFilePath(): string {
		return (
			this.currentConfigPath ||
			this.resolveExistingConfigPath() ||
			join(this.roadmapDir, DEFAULT_FILES.CONFIG)
		);
	}

	/** Get the project root directory */
	get rootDir(): string {
		return this.projectRoot;
	}

	invalidateConfigCache(): void {
		this.cachedConfig = null;
	}

	private async getProposalsDir(): Promise<string> {
		const roadmapDir = await this.getRoadmapDir();
		const proposalsPath = join(roadmapDir, DEFAULT_DIRECTORIES.STATES);

		// STATE-26: Compatibility check for legacy 'nodes' directory
		try {
			await stat(proposalsPath);
		} catch {
			const nodesPath = join(roadmapDir, "nodes");
			try {
				await stat(nodesPath);
				// Found nodes/ but not proposals/ - this is a pre-migration CLI or an un-migrated roadmap
				const config = await this.loadConfig();
				const currentSchema = config?.schemaVersion || 1;

				console.warn(
					"\n⚠️  COMPATIBILITY WARNING (STATE-26): Found legacy 'roadmap/nodes/' directory but no 'roadmap/proposals/'.",
				);
				if (currentSchema >= 2) {
					console.warn(
						"Your branch CLI expects schema v2 ('roadmap/proposals/') but the shared roadmap hub is at v1 ('roadmap/nodes/').",
					);
				}
				console.warn(
					"Please rebase your worktree, run 'roadmap init', or migrate the shared hub.",
				);
				console.warn(
					"Continuing in legacy compatibility mode for this session.\n",
				);
				return nodesPath; // Fallback to nodes for read-only compatibility
			} catch {
				// Neither exists, will be created by ensureRoadmapStructure
			}
		}

		return proposalsPath;
	}

	async getDraftsDir(): Promise<string> {
		const roadmapDir = await this.getRoadmapDir();
		const draftsPath = join(roadmapDir, DEFAULT_DIRECTORIES.DRAFTS);

		// STATE-26: Compatibility check for legacy 'drafts/' location
		try {
			await stat(draftsPath);
		} catch {
			const archiveDraftsPath = join(roadmapDir, "archive/drafts");
			try {
				await stat(archiveDraftsPath);
				return archiveDraftsPath;
			} catch {
				// Neither exists
			}
		}

		return draftsPath;
	}

	async getArchiveProposalsDir(): Promise<string> {
		const roadmapDir = await this.getRoadmapDir();
		const proposalsPath = join(roadmapDir, DEFAULT_DIRECTORIES.ARCHIVE_STATES);

		// STATE-26: Compatibility check for legacy 'completed/' directory
		try {
			await stat(proposalsPath);
		} catch {
			const completedPath = join(roadmapDir, "completed");
			try {
				await stat(completedPath);
				return completedPath;
			} catch {
				// Neither exists
			}
		}

		return proposalsPath;
	}

	private async getArchiveDirectivesDir(): Promise<string> {
		const roadmapDir = await this.getRoadmapDir();
		const directivesPath = join(
			roadmapDir,
			DEFAULT_DIRECTORIES.ARCHIVE_MILESTONES,
		);

		// STATE-26: Compatibility check for legacy 'archive/directives/' location
		try {
			await stat(directivesPath);
		} catch {
			// No legacy path for directives yet, but we'll keep the structure for future-proofing
		}

		return directivesPath;
	}

	private async getArchiveDraftsDir(): Promise<string> {
		const roadmapDir = await this.getRoadmapDir();
		return join(roadmapDir, DEFAULT_DIRECTORIES.ARCHIVE_DRAFTS);
	}

	private async getDecisionsDir(): Promise<string> {
		const roadmapDir = await this.getRoadmapDir();
		return join(roadmapDir, DEFAULT_DIRECTORIES.DECISIONS);
	}

	private async getDocsDir(): Promise<string> {
		return join(this.projectRoot, DEFAULT_DIRECTORIES.DOCS);
	}

	private async getDirectivesDir(): Promise<string> {
		const roadmapDir = await this.getRoadmapDir();
		return join(roadmapDir, DEFAULT_DIRECTORIES.MILESTONES);
	}

	private async getCompletedDir(): Promise<string> {
		const roadmapDir = await this.getRoadmapDir();
		return join(roadmapDir, DEFAULT_DIRECTORIES.COMPLETED);
	}

	async ensureRoadmapStructure(): Promise<void> {
		const roadmapDir = await this.getRoadmapDir();
		const directories = [
			roadmapDir,
			join(roadmapDir, DEFAULT_DIRECTORIES.STATES),
			join(roadmapDir, DEFAULT_DIRECTORIES.DRAFTS),
			join(roadmapDir, DEFAULT_DIRECTORIES.COMPLETED),
			join(roadmapDir, DEFAULT_DIRECTORIES.ARCHIVE_STATES),
			join(roadmapDir, DEFAULT_DIRECTORIES.ARCHIVE_DRAFTS),
			join(roadmapDir, DEFAULT_DIRECTORIES.MILESTONES),
			join(roadmapDir, DEFAULT_DIRECTORIES.ARCHIVE_MILESTONES),
			join(this.projectRoot, DEFAULT_DIRECTORIES.DOCS),
			join(roadmapDir, DEFAULT_DIRECTORIES.DECISIONS),
		];

		for (const dir of directories) {
			await mkdir(dir, { recursive: true });
		}
	}

	private async findMarkdownFiles(dir: string): Promise<string[]> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			const files = await Promise.all(
				entries.map(async (entry) => {
					const entryPath = join(dir, entry.name);
					if (entry.isDirectory()) {
						return await this.findMarkdownFiles(entryPath);
					}
					if (entry.isSymbolicLink()) {
						try {
							const entryStat = await stat(entryPath);
							if (entryStat.isDirectory()) {
								return await this.findMarkdownFiles(entryPath);
							}
						} catch {
							return [];
						}
					}
					return entryPath;
				}),
			);

			return files
				.flat()
				.filter((file): file is string => file.toLowerCase().endsWith(".md"));
		} catch {
			return [];
		}
	}

	// Proposal operations
	async saveProposal(proposal: Proposal): Promise<string> {
		// Extract prefix from proposal ID, or use configured prefix, or fall back to default "proposal"
		let prefix = extractAnyPrefix(proposal.id);
		if (!prefix) {
			const config = await this.loadConfig();
			prefix = config?.prefixes?.proposal ?? "proposal";
		}
		const proposalId = normalizeId(proposal.id, prefix);
		const filename = `${idForFilename(proposalId)} - ${this.sanitizeFilename(proposal.title)}.md`;
		const proposalsDir = await this.getProposalsDir();
		const filepath = join(proposalsDir, filename);
		// Normalize proposal ID and parentProposalId to uppercase before serialization
		const normalizedProposal = {
			...proposal,
			id: proposalId,
			parentProposalId: proposal.parentProposalId
				? normalizeId(
						proposal.parentProposalId,
						extractAnyPrefix(proposal.parentProposalId) ?? prefix,
					)
				: undefined,
		};
		const content = serializeProposal(normalizedProposal);

		// Delete any existing proposal files with the same ID but different filenames
		try {
			const core = { filesystem: { proposalsDir } };
			const existingPath = await getProposalPath(
				proposalId,
				core as ProposalPathContext,
			);
			if (existingPath && !existingPath.endsWith(filename)) {
				await unlink(existingPath);
			}
		} catch {
			// Ignore errors if no existing files found
		}

		await this.ensureDirectoryExists(dirname(filepath));
		await writeFile(filepath, content, "utf-8");
		return filepath;
	}

	async loadProposal(proposalId: string): Promise<Proposal | null> {
		try {
			const proposals = await this.listProposals();
			const match = proposals.find((p) => proposalIdsEqual(proposalId, p.id));
			if (match) {
				return { ...match };
			}
			return null;
		} catch (error) {
			console.error("loadProposal error for", proposalId, error);
			return null;
		}
	}

	async listProposals(filter?: ProposalListFilter): Promise<Proposal[]> {
		let proposalsDir: string;
		try {
			proposalsDir = await this.getProposalsDir();
		} catch (_error) {
			return [];
		}

		const proposalFiles = await this.findMarkdownFiles(proposalsDir);
		if (proposalFiles.length === 0) {
			return [];
		}

		let proposals: Proposal[] = [];
		for (const filepath of proposalFiles) {
			try {
				const content = await readFile(filepath, "utf-8");
				const parsed = parseProposal(content);
				if (!parsed.id || !hasAnyPrefix(parsed.id)) {
					continue;
				}
				const proposal = normalizeProposalIdentity(parsed);
				proposals.push({ ...proposal, filePath: filepath });
			} catch (error) {
				if (process.env.DEBUG) {
					console.error(`Failed to parse proposal file ${filepath}:`, error);
				}
			}
		}

		if (filter?.status) {
			const statusLower = filter.status.toLowerCase();
			proposals = proposals.filter(
				(t) => (t.status || "").toLowerCase() === statusLower,
			);
		}

		if (filter?.assignee) {
			const assignee = filter.assignee.toLowerCase();
			proposals = proposals.filter((t) =>
				(t.assignee || []).some((a) => a.toLowerCase() === assignee),
			);
		}

		if (filter?.rationale) {
			const rationaleLower = filter.rationale.toLowerCase();
			proposals = proposals.filter(
				(t) => (t.rationale ?? "").toLowerCase() === rationaleLower,
			);
		}

		if (filter?.maturity) {
			const maturityLower = filter.maturity.toLowerCase();
			proposals = proposals.filter(
				(t) => (t.maturity ?? "").toLowerCase() === maturityLower,
			);
		}

		return sortByProposalId(proposals);
	}

	async listCompletedProposals(): Promise<Proposal[]> {
		let completedDir: string;
		try {
			completedDir = await this.getCompletedDir();
		} catch (_error) {
			return [];
		}

		const proposalFiles = await this.findMarkdownFiles(completedDir);
		if (proposalFiles.length === 0) {
			return [];
		}

		const proposals: Proposal[] = [];
		for (const filepath of proposalFiles) {
			try {
				const content = await readFile(filepath, "utf-8");
				const parsed = parseProposal(content);
				if (!parsed.id || !hasAnyPrefix(parsed.id)) {
					continue;
				}
				const proposal = normalizeProposalIdentity(parsed);
				proposals.push({ ...proposal, filePath: filepath });
			} catch (error) {
				if (process.env.DEBUG) {
					console.error(
						`Failed to parse completed proposal file ${filepath}:`,
						error,
					);
				}
			}
		}

		return sortByProposalId(proposals);
	}

	async listArchivedProposals(): Promise<Proposal[]> {
		let archiveProposalsDir: string;
		try {
			archiveProposalsDir = await this.getArchiveProposalsDir();
		} catch (_error) {
			return [];
		}

		const proposalFiles = await this.findMarkdownFiles(archiveProposalsDir);
		if (proposalFiles.length === 0) {
			return [];
		}

		const proposals: Proposal[] = [];
		for (const filepath of proposalFiles) {
			try {
				const content = await readFile(filepath, "utf-8");
				const parsed = parseProposal(content);
				if (!parsed.id || !hasAnyPrefix(parsed.id)) {
					continue;
				}
				const proposal = normalizeProposalIdentity(parsed);
				proposals.push({ ...proposal, filePath: filepath });
			} catch (error) {
				if (process.env.DEBUG) {
					console.error(
						`Failed to parse archived proposal file ${filepath}:`,
						error,
					);
				}
			}
		}

		return sortByProposalId(proposals);
	}

	async archiveProposal(proposalId: string): Promise<boolean> {
		try {
			const proposalsDir = await this.getProposalsDir();
			const archiveProposalsDir = await this.getArchiveProposalsDir();
			const core = { filesystem: { proposalsDir } };
			const sourcePath = await getProposalPath(
				proposalId,
				core as ProposalPathContext,
			);
			const proposalFile = await getProposalFilename(
				proposalId,
				core as ProposalPathContext,
			);

			if (!sourcePath || !proposalFile) return false;

			const targetPath = join(archiveProposalsDir, proposalFile);

			// Ensure target directory exists
			await this.ensureDirectoryExists(dirname(targetPath));

			// Use rename for proper Git move detection
			await rename(sourcePath, targetPath);

			return true;
		} catch (_error) {
			return false;
		}
	}

	async completeProposal(proposalId: string): Promise<boolean> {
		try {
			const proposalsDir = await this.getProposalsDir();
			const completedDir = await this.getCompletedDir();
			const core = { filesystem: { proposalsDir } };
			const sourcePath = await getProposalPath(
				proposalId,
				core as ProposalPathContext,
			);
			const proposalFile = await getProposalFilename(
				proposalId,
				core as ProposalPathContext,
			);

			if (!sourcePath || !proposalFile) return false;

			const targetPath = join(completedDir, proposalFile);

			// Ensure target directory exists
			await this.ensureDirectoryExists(dirname(targetPath));

			// Use rename for proper Git move detection
			await rename(sourcePath, targetPath);

			return true;
		} catch (_error) {
			return false;
		}
	}

	async archiveDraft(draftId: string): Promise<boolean> {
		try {
			const draftsDir = await this.getDraftsDir();
			const archiveDraftsDir = await this.getArchiveDraftsDir();

			// Find draft file with draft- prefix
			const files = await readdir(draftsDir);
			const pattern = /^draft-.*\.md$/i;
			const draftFiles = files.filter((f) => pattern.test(f));

			const normalizedId = normalizeId(draftId, "draft");
			const filenameId = idForFilename(normalizedId);
			const draftFile = draftFiles.find(
				(f) =>
					f.startsWith(`${filenameId} -`) || f.startsWith(`${filenameId}-`),
			);

			if (!draftFile) return false;

			const sourcePath = join(draftsDir, draftFile);
			const targetPath = join(archiveDraftsDir, draftFile);

			const content = await readFile(sourcePath, "utf-8");
			await this.ensureDirectoryExists(dirname(targetPath));
			await writeFile(targetPath, content, "utf-8");

			await unlink(sourcePath);

			return true;
		} catch {
			return false;
		}
	}

	async promoteDraft(draftId: string): Promise<boolean> {
		try {
			// Load the draft
			const draft = await this.loadDraft(draftId);
			if (!draft) {
				return false;
			}
			if (!draft.filePath) {
				return false;
			}

			// Get proposal prefix from config (default: "proposal")
			const config = await this.loadConfig();
			const proposalPrefix = config?.prefixes?.proposal ?? "proposal";

			// Get existing proposal IDs to generate next ID
			// Include both active and completed proposals to prevent ID collisions
			const existingProposals = await this.listProposals();
			const completedProposals = await this.listCompletedProposals();
			const existingIds = [...existingProposals, ...completedProposals].map(
				(t) => t.id,
			);

			// Generate new proposal ID
			const newProposalId = generateNextId(
				existingIds,
				proposalPrefix,
				config?.zeroPaddedIds,
			);

			// Update draft with new proposal ID and save as proposal
			const promotedProposal: Proposal = {
				...draft,
				id: newProposalId,
				filePath: undefined, // Will be set by saveProposal
			};

			// Delete old draft file first
			await unlink(draft.filePath);

			await this.saveProposal(promotedProposal);

			return true;
		} catch (_e) {
			return false;
		}
	}

	async demoteProposal(proposalId: string): Promise<boolean> {
		try {
			// Load the proposal
			const proposal = await this.loadProposal(proposalId);
			if (!proposal || !proposal.filePath) return false;

			// Get existing draft IDs to generate next ID
			// Draft prefix is always "draft" (not configurable like proposal prefix)
			const existingDrafts = await this.listDrafts();
			const existingIds = existingDrafts.map((d) => d.id);

			// Generate new draft ID
			const config = await this.loadConfig();
			const newDraftId = generateNextId(
				existingIds,
				"draft",
				config?.zeroPaddedIds,
			);

			// Update proposal with new draft ID and save as draft
			const demotedDraft: Proposal = {
				...proposal,
				id: newDraftId,
				filePath: undefined, // Will be set by saveDraft
			};

			await this.saveDraft(demotedDraft);

			// Delete old proposal file
			await unlink(proposal.filePath);

			return true;
		} catch {
			return false;
		}
	}

	// Draft operations
	async saveDraft(proposal: Proposal): Promise<string> {
		const draftId = normalizeId(proposal.id, "draft");
		const filename = `${idForFilename(draftId)} - ${this.sanitizeFilename(proposal.title)}.md`;
		const draftsDir = await this.getDraftsDir();
		const filepath = join(draftsDir, filename);
		// Normalize the draft ID to uppercase before serialization
		const normalizedProposal = { ...proposal, id: draftId };
		const content = serializeProposal(normalizedProposal);

		try {
			// Find existing draft file with same ID but possibly different filename (e.g., title changed)
			const filenameId = idForFilename(draftId);
			const files = await readdir(draftsDir);
			const pattern = /^draft-.*\.md$/i;
			const existingFile = files.find(
				(f) =>
					pattern.test(f) &&
					(f.startsWith(`${filenameId} -`) || f.startsWith(`${filenameId}-`)),
			);

			if (existingFile && existingFile !== filename) {
				await unlink(join(draftsDir, existingFile));
			}
		} catch {
			// Ignore errors if no existing files found
		}

		await this.ensureDirectoryExists(dirname(filepath));
		await writeFile(filepath, content, "utf-8");
		return filepath;
	}

	async loadDraft(draftId: string): Promise<Proposal | null> {
		try {
			const draftsDir = await this.getDraftsDir();
			// Search for draft files with draft- prefix
			const files = await readdir(draftsDir);
			const pattern = /^draft-.*\.md$/i;
			const draftFiles = files.filter((f) => pattern.test(f));

			const normalizedId = normalizeId(draftId, "draft");
			const filenameId = idForFilename(normalizedId);

			// Find matching draft file
			const draftFile = draftFiles.find(
				(f) =>
					f.startsWith(`${filenameId} -`) || f.startsWith(`${filenameId}-`),
			);
			if (!draftFile) return null;

			const filepath = join(draftsDir, draftFile);
			const content = await readFile(filepath, "utf-8");
			const proposal = normalizeProposalIdentity(parseProposal(content));
			return { ...proposal, filePath: filepath };
		} catch {
			return null;
		}
	}

	async listDrafts(): Promise<Proposal[]> {
		try {
			const draftsDir = await this.getDraftsDir();
			const files = await readdir(draftsDir);
			const pattern = /^draft-.*\.md$/i;
			const proposalFiles = files.filter((f) => pattern.test(f));

			const proposals: Proposal[] = [];
			for (const file of proposalFiles) {
				const filepath = join(draftsDir, file);
				const content = await readFile(filepath, "utf-8");
				const proposal = normalizeProposalIdentity(parseProposal(content));
				proposals.push({ ...proposal, filePath: filepath });
			}

			return sortByProposalId(proposals);
		} catch {
			return [];
		}
	}

	// Decision log operations
	async saveDecision(decision: Decision): Promise<void> {
		// Normalize ID - remove "decision-" prefix if present
		const normalizedId = decision.id.replace(/^decision-/, "");
		const filename = `decision-${normalizedId} - ${this.sanitizeFilename(decision.title)}.md`;
		const decisionsDir = await this.getDecisionsDir();
		const filepath = join(decisionsDir, filename);
		const content = serializeDecision(decision);

		const files = await readdir(decisionsDir);
		const matches = files.filter(
			(f) => f.startsWith(`decision-${normalizedId} -`) && f !== filename,
		);

		for (const match of matches) {
			try {
				await unlink(join(decisionsDir, match));
			} catch {
				// Ignore cleanup errors
			}
		}

		await this.ensureDirectoryExists(dirname(filepath));
		await writeFile(filepath, content, "utf-8");
	}

	async loadDecision(decisionId: string): Promise<Decision | null> {
		try {
			const decisionsDir = await this.getDecisionsDir();
			const files = await readdir(decisionsDir);

			// Normalize ID - remove "decision-" prefix if present
			const normalizedId = decisionId.replace(/^decision-/, "");
			const decisionFile = files.find((file) =>
				file.startsWith(`decision-${normalizedId} -`),
			);

			if (!decisionFile) return null;

			const filepath = join(decisionsDir, decisionFile);
			const content = await readFile(filepath, "utf-8");
			return parseDecision(content);
		} catch (_error) {
			return null;
		}
	}

	// Document operations
	async saveDocument(document: Document, subPath = ""): Promise<string> {
		const docsDir = await this.getDocsDir();
		const canonicalId = normalizeDocumentId(document.id);
		document.id = canonicalId;
		const filename = `${canonicalId} - ${this.sanitizeFilename(document.title)}.md`;
		const subPathSegments = subPath
			.split(/[\\/]+/)
			.map((segment) => segment.trim())
			.filter(
				(segment) => segment.length > 0 && segment !== "." && segment !== "..",
			);
		const relativePath =
			subPathSegments.length > 0
				? join(...subPathSegments, filename)
				: filename;
		const filepath = join(docsDir, relativePath);
		const content = serializeDocument(document);

		await this.ensureDirectoryExists(dirname(filepath));

		// Find existing matches recursively
		const findMarkdownFiles = async (dir: string): Promise<string[]> => {
			const entries = await readdir(dir, { withFileTypes: true });
			const files = await Promise.all(
				entries.map((entry) => {
					const res = join(dir, entry.name);
					return entry.isDirectory() ? findMarkdownFiles(res) : res;
				}),
			);
			return files
				.flat()
				.filter((f) => f.endsWith(".md"))
				.map((f) => relative(docsDir, f));
		};

		const existingMatches = await findMarkdownFiles(docsDir);

		const matchesForId = existingMatches.filter((relative) => {
			const base = relative.split(/[\\/]/).pop() || relative;
			const [candidateId] = base.split(" - ");
			if (!candidateId) return false;
			return documentIdsEqual(canonicalId, candidateId);
		});

		let sourceRelativePath = document.path;
		if (!sourceRelativePath && matchesForId.length > 0) {
			sourceRelativePath = matchesForId[0];
		}

		if (sourceRelativePath && sourceRelativePath !== relativePath) {
			const sourcePath = join(docsDir, sourceRelativePath);
			try {
				await this.ensureDirectoryExists(dirname(filepath));
				await rename(sourcePath, filepath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "ENOENT") {
					throw error;
				}
			}
		}

		for (const match of matchesForId) {
			const matchPath = join(docsDir, match);
			if (matchPath === filepath) {
				continue;
			}
			try {
				await unlink(matchPath);
			} catch {
				// Ignore cleanup errors - file may have been removed already
			}
		}

		await writeFile(filepath, content, "utf-8");

		document.path = relativePath;
		return relativePath;
	}

	async listDecisions(): Promise<Decision[]> {
		try {
			const decisionsDir = await this.getDecisionsDir();
			const files = await readdir(decisionsDir);
			const decisionFiles = files.filter(
				(f) => f.startsWith("decision-") && f.endsWith(".md"),
			);

			const decisions: Decision[] = [];
			for (const file of decisionFiles) {
				// Filter out README files as they're just instruction files
				if (file.toLowerCase().match(/^readme\.md$/i)) {
					continue;
				}
				const filepath = join(decisionsDir, file);
				const content = await readFile(filepath, "utf-8");
				decisions.push(parseDecision(content));
			}
			return sortByProposalId(decisions);
		} catch {
			return [];
		}
	}

	async listDocuments(): Promise<Document[]> {
		try {
			const docsDir = await this.getDocsDir();

			const findMarkdownFiles = async (dir: string): Promise<string[]> => {
				const entries = await readdir(dir, { withFileTypes: true });
				const files = await Promise.all(
					entries.map(async (entry) => {
						const res = join(dir, entry.name);
						if (entry.isDirectory()) {
							return await findMarkdownFiles(res);
						}
						if (entry.isSymbolicLink()) {
							try {
								const s = await stat(res);
								if (s.isDirectory()) {
									return await findMarkdownFiles(res);
								}
							} catch {
								// Link points to non-existent location
							}
						}
						return res;
					}),
				);
				return files.flat();
			};

			const absoluteFiles = await findMarkdownFiles(docsDir);
			const docFiles = absoluteFiles
				.filter((f) => f.endsWith(".md"))
				.map((f) => relative(docsDir, f));

			const docs: Document[] = [];
			for (const file of docFiles) {
				const base = file.split(/[\\/]/).pop() || file;
				if (base.toLowerCase() === "readme.md") continue;
				const filepath = join(docsDir, file);
				const content = await readFile(filepath, "utf-8");
				const parsed = parseDocument(content);

				// Fallback to ID from filename if missing from frontmatter
				const idFromFilename = base.split(" - ")[0];
				const finalId = parsed.id || idFromFilename || "";

				docs.push({
					...parsed,
					id: finalId,
					path: file,
					relativeFilePath: file,
				});
			}

			// Stable sort by title for UI/CLI listing
			return docs.sort((a, b) => a.title.localeCompare(b.title));
		} catch {
			return [];
		}
	}

	async loadDocument(id: string): Promise<Document> {
		const documents = await this.listDocuments();
		const document = documents.find((doc) => documentIdsEqual(id, doc.id));
		if (!document) {
			throw new Error(`Document not found: ${id}`);
		}
		return document;
	}

	private buildDirectiveIdentifierKeys(identifier: string): Set<string> {
		const normalized = identifier.trim().toLowerCase();
		const keys = new Set<string>();
		if (!normalized) {
			return keys;
		}

		keys.add(normalized);

		if (/^\d+$/.test(normalized)) {
			const numeric = String(Number.parseInt(normalized, 10));
			keys.add(numeric);
			keys.add(`m-${numeric}`);
			return keys;
		}

		const directiveIdMatch = normalized.match(/^m-(\d+)$/);
		if (directiveIdMatch?.[1]) {
			const numeric = String(Number.parseInt(directiveIdMatch[1], 10));
			keys.add(numeric);
			keys.add(`m-${numeric}`);
		}

		return keys;
	}

	private buildDirectiveFilename(id: string, title: string): string {
		const safeTitle = title
			.replace(/[<>:"/\\|?*]/g, "")
			.replace(/\s+/g, "-")
			.toLowerCase()
			.slice(0, 50);
		return `${id} - ${safeTitle}.md`;
	}

	private serializeDirectiveContent(
		id: string,
		title: string,
		rawContent: string,
	): string {
		return `---
id: ${id}
title: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
---

${rawContent.trim()}
`;
	}

	private rewriteDefaultDirectiveDescription(
		rawContent: string,
		previousTitle: string,
		nextTitle: string,
	): string {
		const defaultDescription = `Directive: ${previousTitle}`;
		const descriptionSectionPattern =
			/(##\s+Description\s*(?:\r?\n)+)([\s\S]*?)(?=(?:\r?\n)##\s+|$)/i;

		return rawContent.replace(
			descriptionSectionPattern,
			(fullSection, heading: string, body: string) => {
				if (body.trim() !== defaultDescription) {
					return fullSection;
				}
				const trailingWhitespace = body.match(/\s*$/)?.[0] ?? "";
				return `${heading}Directive: ${nextTitle}${trailingWhitespace}`;
			},
		);
	}

	private async findDirectiveFile(
		identifier: string,
		scope: "active" | "archived" = "active",
	): Promise<{
		file: string;
		filepath: string;
		content: string;
		directive: Directive;
	} | null> {
		const normalizedInput = identifier.trim().toLowerCase();
		const candidateKeys = this.buildDirectiveIdentifierKeys(identifier);
		if (candidateKeys.size === 0) {
			return null;
		}
		const variantKeys = new Set<string>(candidateKeys);
		variantKeys.delete(normalizedInput);
		const canonicalInputId =
			/^\d+$/.test(normalizedInput) || /^m-\d+$/.test(normalizedInput)
				? `m-${String(Number.parseInt(normalizedInput.replace(/^m-/, ""), 10))}`
				: null;

		const directivesDir =
			scope === "archived"
				? await this.getArchiveDirectivesDir()
				: await this.getDirectivesDir();
		const files = await readdir(directivesDir);
		const directiveFiles = files.filter(
			(f) => f.startsWith("m-") && f.endsWith(".md"),
		);

		const rawExactIdMatches: Array<{
			file: string;
			filepath: string;
			content: string;
			directive: Directive;
		}> = [];
		const canonicalRawIdMatches: Array<{
			file: string;
			filepath: string;
			content: string;
			directive: Directive;
		}> = [];
		const exactAliasIdMatches: Array<{
			file: string;
			filepath: string;
			content: string;
			directive: Directive;
		}> = [];
		const exactTitleMatches: Array<{
			file: string;
			filepath: string;
			content: string;
			directive: Directive;
		}> = [];
		const variantIdMatches: Array<{
			file: string;
			filepath: string;
			content: string;
			directive: Directive;
		}> = [];
		const variantTitleMatches: Array<{
			file: string;
			filepath: string;
			content: string;
			directive: Directive;
		}> = [];

		for (const file of directiveFiles) {
			if (file.toLowerCase() === "readme.md") {
				continue;
			}
			const filepath = join(directivesDir, file);
			const content = await readFile(filepath, "utf-8");
			let directive: Directive;
			try {
				directive = parseDirective(content);
			} catch {
				continue;
			}
			const idKey = directive.id.trim().toLowerCase();
			const idKeys = this.buildDirectiveIdentifierKeys(directive.id);
			const titleKey = directive.title.trim().toLowerCase();

			if (idKey === normalizedInput) {
				rawExactIdMatches.push({ file, filepath, content, directive });
				continue;
			}
			if (canonicalInputId && idKey === canonicalInputId) {
				canonicalRawIdMatches.push({ file, filepath, content, directive });
				continue;
			}
			if (idKeys.has(normalizedInput)) {
				exactAliasIdMatches.push({ file, filepath, content, directive });
				continue;
			}
			if (titleKey === normalizedInput) {
				exactTitleMatches.push({ file, filepath, content, directive });
				continue;
			}
			if (Array.from(idKeys).some((key) => variantKeys.has(key))) {
				variantIdMatches.push({ file, filepath, content, directive });
				continue;
			}
			if (variantKeys.has(titleKey)) {
				variantTitleMatches.push({ file, filepath, content, directive });
			}
		}

		const preferIdMatches =
			/^\d+$/.test(normalizedInput) || /^m-\d+$/.test(normalizedInput);
		const exactTitleMatch =
			exactTitleMatches.length === 1 ? exactTitleMatches[0] : null;
		const variantTitleMatch =
			variantTitleMatches.length === 1 ? variantTitleMatches[0] : null;
		const exactAliasIdMatch =
			exactAliasIdMatches.length === 1 ? exactAliasIdMatches[0] : null;
		const variantIdMatch =
			variantIdMatches.length === 1 ? variantIdMatches[0] : null;
		if (preferIdMatches) {
			return (
				rawExactIdMatches[0] ??
				canonicalRawIdMatches[0] ??
				exactAliasIdMatch ??
				variantIdMatch ??
				exactTitleMatch ??
				variantTitleMatch ??
				null
			);
		}
		return (
			rawExactIdMatches[0] ??
			exactTitleMatch ??
			canonicalRawIdMatches[0] ??
			variantIdMatch ??
			variantTitleMatch ??
			null
		);
	}

	// Directive operations
	async listDirectives(): Promise<Directive[]> {
		try {
			const directivesDir = await this.getDirectivesDir();
			const files = await readdir(directivesDir);
			const directiveFiles = files.filter(
				(f) => f.startsWith("m-") && f.endsWith(".md"),
			);
			const directives: Directive[] = [];
			for (const file of directiveFiles) {
				// Filter out README files
				if (file.toLowerCase() === "readme.md") {
					continue;
				}
				const filepath = join(directivesDir, file);
				const content = await readFile(filepath, "utf-8");
				directives.push(parseDirective(content));
			}
			// Sort by ID for consistent ordering
			return directives.sort((a, b) =>
				a.id.localeCompare(b.id, undefined, { numeric: true }),
			);
		} catch {
			return [];
		}
	}

	async listArchivedDirectives(): Promise<Directive[]> {
		try {
			const directivesDir = await this.getArchiveDirectivesDir();
			const files = await readdir(directivesDir);
			const directiveFiles = files.filter(
				(f) => f.startsWith("m-") && f.endsWith(".md"),
			);
			const directives: Directive[] = [];
			for (const file of directiveFiles) {
				if (file.toLowerCase() === "readme.md") {
					continue;
				}
				const filepath = join(directivesDir, file);
				const content = await readFile(filepath, "utf-8");
				directives.push(parseDirective(content));
			}
			return directives.sort((a, b) =>
				a.id.localeCompare(b.id, undefined, { numeric: true }),
			);
		} catch {
			return [];
		}
	}

	async loadDirective(id: string): Promise<Directive | null> {
		try {
			const directiveMatch = await this.findDirectiveFile(id, "active");
			return directiveMatch?.directive ?? null;
		} catch (_error) {
			return null;
		}
	}

	async createDirective(
		title: string,
		description?: string,
	): Promise<Directive> {
		const directivesDir = await this.getDirectivesDir();

		// Ensure directives directory exists
		await mkdir(directivesDir, { recursive: true });

		// Find next available directive ID
		const archiveDirectivesDir = await this.getArchiveDirectivesDir();
		await mkdir(archiveDirectivesDir, { recursive: true });

		const mFiles = await readdir(directivesDir);
		const existingFiles = mFiles.filter(
			(f) => f.startsWith("m-") && f.endsWith(".md"),
		);

		const amFiles = await readdir(archiveDirectivesDir);
		const archivedFiles = amFiles.filter(
			(f) => f.startsWith("m-") && f.endsWith(".md"),
		);

		const parseDirectiveId = async (
			dir: string,
			file: string,
		): Promise<number | null> => {
			if (file.toLowerCase() === "readme.md") {
				return null;
			}
			const filepath = join(dir, file);
			try {
				const content = await readFile(filepath, "utf-8");
				const parsed = parseDirective(content);
				const parsedIdMatch = parsed.id.match(/^m-(\d+)$/i);
				if (parsedIdMatch?.[1]) {
					return Number.parseInt(parsedIdMatch[1], 10);
				}
			} catch {
				// Fall through to filename-based fallback.
			}
			const filenameIdMatch = file.match(/^m-(\d+)/i);
			if (filenameIdMatch?.[1]) {
				return Number.parseInt(filenameIdMatch[1], 10);
			}
			return null;
		};
		const existingIds = (
			await Promise.all([
				...existingFiles.map((file) => parseDirectiveId(directivesDir, file)),
				...archivedFiles.map((file) =>
					parseDirectiveId(archiveDirectivesDir, file),
				),
			])
		).filter((id): id is number => typeof id === "number" && id >= 0);

		const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
		const id = `m-${nextId}`;

		const filename = this.buildDirectiveFilename(id, title);
		const content = this.serializeDirectiveContent(
			id,
			title,
			`## Description

${description || `Directive: ${title}`}`,
		);

		const filepath = join(directivesDir, filename);
		await writeFile(filepath, content, "utf-8");

		return {
			id,
			title,
			description: description || `Directive: ${title}`,
			rawContent: parseDirective(content).rawContent,
		};
	}

	async renameDirective(
		identifier: string,
		title: string,
	): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		directive?: Directive;
		previousTitle?: string;
	}> {
		const normalizedTitle = title.trim();
		if (!normalizedTitle) {
			return { success: false };
		}

		let sourcePath: string | undefined;
		let targetPath: string | undefined;
		let movedFile = false;
		let originalContent: string | undefined;

		try {
			const directiveMatch = await this.findDirectiveFile(identifier, "active");
			if (!directiveMatch) {
				return { success: false };
			}

			const { directive } = directiveMatch;
			const directivesDir = await this.getDirectivesDir();
			const targetFilename = this.buildDirectiveFilename(
				directive.id,
				normalizedTitle,
			);
			targetPath = join(directivesDir, targetFilename);
			sourcePath = directiveMatch.filepath;
			originalContent = directiveMatch.content;
			const nextRawContent = this.rewriteDefaultDirectiveDescription(
				directive.rawContent,
				directive.title,
				normalizedTitle,
			);
			const updatedContent = this.serializeDirectiveContent(
				directive.id,
				normalizedTitle,
				nextRawContent,
			);

			if (sourcePath !== targetPath) {
				let exists = false;
				try {
					await stat(targetPath);
					exists = true;
				} catch {
					// File doesn't exist
				}
				if (exists) {
					return { success: false };
				}
				await rename(sourcePath, targetPath);
				movedFile = true;
			}
			await writeFile(targetPath, updatedContent, "utf-8");

			return {
				success: true,
				sourcePath,
				targetPath,
				directive: parseDirective(updatedContent),
				previousTitle: directive.title,
			};
		} catch {
			try {
				if (
					movedFile &&
					sourcePath &&
					targetPath &&
					sourcePath !== targetPath
				) {
					await rename(targetPath, sourcePath);
					if (originalContent) {
						await writeFile(sourcePath, originalContent, "utf-8");
					}
				} else if (originalContent) {
					const restorePath = sourcePath ?? targetPath;
					if (restorePath) {
						await writeFile(restorePath, originalContent, "utf-8");
					}
				}
			} catch {
				// Ignore rollback failures and surface operation failure to caller.
			}
			return { success: false };
		}
	}

	async archiveDirective(identifier: string): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		directive?: Directive;
	}> {
		const normalized = identifier.trim();
		if (!normalized) {
			return { success: false };
		}

		try {
			const directiveMatch = await this.findDirectiveFile(normalized, "active");
			if (!directiveMatch) {
				return { success: false };
			}

			const archiveDir = await this.getArchiveDirectivesDir();
			const targetPath = join(archiveDir, directiveMatch.file);
			await this.ensureDirectoryExists(dirname(targetPath));
			await rename(directiveMatch.filepath, targetPath);

			return {
				success: true,
				sourcePath: directiveMatch.filepath,
				targetPath,
				directive: directiveMatch.directive,
			};
		} catch (_error) {
			return { success: false };
		}
	}

	// Config operations
	async loadConfig(): Promise<RoadmapConfig | null> {
		// Return cached config if available
		if (this.cachedConfig !== null) {
			return this.cachedConfig;
		}

		try {
			const configPath = this.resolveExistingConfigPath();
			if (!configPath) {
				return null;
			}

			this.currentConfigPath = configPath;
			const content = await readFile(configPath, "utf-8");
			const config = this.parseConfig(content);

			// Cache the loaded config
			this.cachedConfig = config;

			// Clean up undefined keys for test compatibility (strict deep equal)
			// Return a fresh object from JSON stringify/parse to be absolutely sure
			return JSON.parse(JSON.stringify(config));
		} catch (_error) {
			return null;
		}
	}

	async saveConfig(config: RoadmapConfig): Promise<void> {
		const roadmapDir = await this.getRoadmapDir();
		const configPath =
			this.currentConfigPath || join(roadmapDir, DEFAULT_FILES.CONFIG);
		const content = this.serializeConfig(config);
		await writeFile(configPath, content, "utf-8");
		this.cachedConfig = config;
	}

	async getUserSetting(
		key: string,
		global = false,
	): Promise<string | undefined> {
		const settings = await this.loadUserSettings(global);
		return settings ? settings[key] : undefined;
	}

	async setUserSetting(
		key: string,
		value: string,
		global = false,
	): Promise<void> {
		const settings = (await this.loadUserSettings(global)) || {};
		settings[key] = value;
		await this.saveUserSettings(settings, global);
	}

	private async loadUserSettings(
		global = false,
	): Promise<Record<string, string> | null> {
		const primaryPath = global
			? join(homedir(), "roadmap", DEFAULT_FILES.USER)
			: join(this.projectRoot, DEFAULT_FILES.USER);
		const fallbackPath = global
			? join(this.projectRoot, "roadmap", DEFAULT_FILES.USER)
			: undefined;
		const tryPaths = fallbackPath ? [primaryPath, fallbackPath] : [primaryPath];
		for (const filePath of tryPaths) {
			try {
				const content = await readFile(filePath, "utf-8");
				const result: Record<string, string> = {};
				for (const line of content.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith("#")) continue;
					const idx = trimmed.indexOf(":");
					if (idx === -1) continue;
					const k = trimmed.substring(0, idx).trim();
					result[k] = trimmed
						.substring(idx + 1)
						.trim()
						.replace(/^['"]|['"]$/g, "");
				}
				return result;
			} catch {
				// Try next path (if any)
			}
		}
		return null;
	}

	private async saveUserSettings(
		settings: Record<string, string>,
		global = false,
	): Promise<void> {
		const primaryPath = global
			? join(homedir(), "roadmap", DEFAULT_FILES.USER)
			: join(this.projectRoot, DEFAULT_FILES.USER);
		const fallbackPath = global
			? join(this.projectRoot, "roadmap", DEFAULT_FILES.USER)
			: undefined;

		const lines = Object.entries(settings).map(([k, v]) => `${k}: ${v}`);
		const data = `${lines.join("\n")}\n`;

		try {
			await this.ensureDirectoryExists(dirname(primaryPath));
			await writeFile(primaryPath, data, "utf-8");
			return;
		} catch {
			// Fall through to fallback when global write fails (e.g., sandboxed env)
		}

		if (fallbackPath) {
			await this.ensureDirectoryExists(dirname(fallbackPath));
			await writeFile(fallbackPath, data, "utf-8");
		}
	}

	// Utility methods
	private sanitizeFilename(filename: string): string {
		// Remove path-unsafe characters, then strip noisy punctuation before normalizing whitespace
		return (
			filename
				.replace(/[<>:"/\\|?*]/g, "-")
				// biome-ignore lint/complexity/noUselessEscapeInRegex: we need explicit escapes inside the character class
				.replace(/['(),!@#$%^&+=\[\]{};]/g, "")
				.replace(/\s+/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")
		);
	}

	private async ensureDirectoryExists(dirPath: string): Promise<void> {
		try {
			await mkdir(dirPath, { recursive: true });
		} catch (_error) {
			// Directory creation failed, ignore
		}
	}

	private parseConfig(content: string): RoadmapConfig {
		try {
			const yaml = require("js-yaml");
			const cfg = yaml.load(content) as any;

			if (cfg) {
				this.rawConfig = JSON.parse(JSON.stringify(cfg));
				const config: Partial<RoadmapConfig> = {};

				// Handle nested format (roadmap.yaml)
				if (cfg.project) {
					config.projectName = cfg.project.name;
					config.dateFormat = cfg.project.date_format;
					config.exportPath = cfg.project.export_path;
				}

				if (cfg.proposals) {
					config.defaultStatus = cfg.proposals.default_status;
					config.statuses = cfg.proposals.statuses;
					config.labels = cfg.proposals.labels;
					config.zeroPaddedIds = cfg.proposals.zero_padded_ids;
				}

				if (cfg.database) {
					config.database = cfg.database;
				}

				if (cfg.mcp) {
					config.mcp = {
						url: cfg.mcp.url,
						healthEndpoint: cfg.mcp.health_endpoint,
						toolsCount: cfg.mcp.tools_count,
						port: cfg.mcp.port,
						transport: cfg.mcp.transport,
						http: cfg.mcp.http,
					};
				}

				if (cfg.git) {
					config.git = {
						remote: cfg.git.remote,
						defaultBranch: cfg.git.default_branch,
						worktreePath: cfg.git.worktree_path,
					};
				}

				if (cfg.paths) {
					config.paths = cfg.paths;
				}

				if (cfg.components) {
					config.components = cfg.components;
				}

				if (cfg.ui) {
					config.maxColumnWidth = cfg.ui.max_column_width;
					config.autoOpenBrowser = cfg.ui.auto_open_browser;
				}

				// Handle flat format (config.yml) and overrides
				config.projectName = config.projectName || cfg.project_name || "";
				config.statuses = config.statuses ||
					cfg.statuses || [
						"New",
						"Draft",
						"Review",
						"Active",
						"Accepted",
						"Complete",
						"Rejected",
						"Abandoned",
						"Replaced",
					];
				config.labels = config.labels || cfg.labels || [];
				config.dateFormat =
					config.dateFormat || cfg.date_format || "yyyy-mm-dd";
				config.maxColumnWidth =
					config.maxColumnWidth || cfg.max_column_width || 20;
				config.autoOpenBrowser =
					config.autoOpenBrowser !== undefined
						? config.autoOpenBrowser
						: cfg.auto_open_browser !== undefined
							? cfg.auto_open_browser
							: true;
				config.defaultPort = cfg.default_port || 6420;
				config.remoteOperations =
					cfg.remote_operations !== undefined ? cfg.remote_operations : true;
				config.autoCommit =
					cfg.auto_commit !== undefined ? cfg.auto_commit : true;
				config.zeroPaddedIds = config.zeroPaddedIds || cfg.zero_padded_ids;
				config.bypassGitHooks =
					cfg.bypass_git_hooks !== undefined ? cfg.bypass_git_hooks : false;
				config.checkActiveBranches =
					cfg.check_active_branches !== undefined
						? cfg.check_active_branches
						: true;
				config.activeBranchDays = cfg.active_branch_days || 30;

				return config as RoadmapConfig;
			}
		} catch (_e) {
			// Fallback to manual parsing if js-yaml fails or is missing
		}

		this.rawConfig = null;
		const config: Partial<RoadmapConfig> = {};
		const lines = content.split("\n");

		let inDatabaseSection = false;
		let inProposalsSection = false;
		let inProjectSection = false;
		let inMcpSection = false;
		let inGitSection = false;
		let inPathsSection = false;
		config.database = { provider: "Postgres" };

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			// Check for section headers
			if (trimmed === "database:") {
				inDatabaseSection = true;
				inProposalsSection = false;
				inProjectSection = false;
				inMcpSection = false;
				inGitSection = false;
				inPathsSection = false;
				continue;
			}
			if (trimmed === "proposals:") {
				inProposalsSection = true;
				inDatabaseSection = false;
				inProjectSection = false;
				inMcpSection = false;
				inGitSection = false;
				inPathsSection = false;
				continue;
			}
			if (trimmed === "project:") {
				inProjectSection = true;
				inDatabaseSection = false;
				inProposalsSection = false;
				inMcpSection = false;
				inGitSection = false;
				inPathsSection = false;
				continue;
			}
			if (trimmed === "mcp:") {
				inMcpSection = true;
				inProjectSection = false;
				inDatabaseSection = false;
				inProposalsSection = false;
				inGitSection = false;
				inPathsSection = false;
				continue;
			}
			if (trimmed === "git:") {
				inGitSection = true;
				inMcpSection = false;
				inProjectSection = false;
				inDatabaseSection = false;
				inProposalsSection = false;
				inPathsSection = false;
				continue;
			}
			if (trimmed === "paths:") {
				inPathsSection = true;
				inGitSection = false;
				inMcpSection = false;
				inProjectSection = false;
				inDatabaseSection = false;
				inProposalsSection = false;
				continue;
			}

			// Reset section if we find a top-level key (no leading whitespace)
			if (line.length > 0 && !/^\s/.test(line)) {
				inDatabaseSection = false;
				inProposalsSection = false;
				inProjectSection = false;
				inMcpSection = false;
				inGitSection = false;
				inPathsSection = false;
			}

			const colonIndex = trimmed.indexOf(":");
			if (colonIndex === -1) continue;

			const key = trimmed.substring(0, colonIndex).trim();
			const value = trimmed.substring(colonIndex + 1).trim();

			if (inProjectSection) {
				switch (key) {
					case "name":
						config.projectName = value.replace(/['"]/g, "");
						break;
				}
				continue;
			}

			if (inDatabaseSection) {
				if (!config.database) config.database = { provider: "markdown" };
				switch (key) {
					case "provider":
						config.database.provider = value.replace(/['"]/g, "") as any;
						break;
					case "host":
						config.database.host = value.replace(/['"]/g, "");
						break;
					case "port":
						config.database.port = Number.parseInt(value, 10);
						break;
					case "user":
						config.database.user = value.replace(/['"]/g, "");
						break;
					case "password":
						config.database.password = value.replace(/^['"]|['"]$/g, "");
						break;
					case "name":
						config.database.name = value.replace(/['"]/g, "");
						break;
					case "schema":
						config.database.schema = value.replace(/['"]/g, "");
						break;
					case "uri":
						config.database.uri = value.replace(/['"]/g, "");
						break;
				}
				continue;
			}

			if (inMcpSection) {
				if (!config.mcp) config.mcp = {};
				switch (key) {
					case "url":
						config.mcp.url = value.replace(/['"]/g, "");
						break;
					case "health_endpoint":
						config.mcp.healthEndpoint = value.replace(/['"]/g, "");
						break;
					case "tools_count":
						config.mcp.toolsCount = Number.parseInt(value, 10);
						break;
					case "port":
						config.mcp.port = Number.parseInt(value, 10);
						break;
					case "transport":
						config.mcp.transport = value.replace(/['"]/g, "");
						break;
				}
				continue;
			}

			if (inGitSection) {
				if (!config.git) config.git = {};
				switch (key) {
					case "remote":
						config.git.remote = value.replace(/['"]/g, "");
						break;
					case "default_branch":
						config.git.defaultBranch = value.replace(/['"]/g, "");
						break;
					case "worktree_path":
						config.git.worktreePath = value.replace(/['"]/g, "");
						break;
				}
				continue;
			}

			if (inPathsSection) {
				if (!config.paths) config.paths = {};
				switch (key) {
					case "proposals":
						config.paths.proposals = value.replace(/['"]/g, "");
						break;
					case "archive":
						config.paths.archive = value.replace(/['"]/g, "");
						break;
					case "docs":
						config.paths.docs = value.replace(/['"]/g, "");
						break;
				}
				continue;
			}

			if (inProposalsSection) {
				switch (key) {
					case "default_status":
						config.defaultStatus = value.replace(/['"]/g, "");
						break;
					case "statuses":
					case "labels":
						if (value.startsWith("[") && value.endsWith("]")) {
							const arrayContent = value.slice(1, -1);
							config[key] = arrayContent
								.split(",")
								.map((item) => item.trim().replace(/['"]/g, ""))
								.filter(Boolean);
						}
						break;
					case "zero_padded_ids":
						config.zeroPaddedIds = Number.parseInt(value, 10);
						break;
				}
				continue;
			}

			switch (key) {
				case "project_name":
					config.projectName = value.replace(/['"]/g, "");
					break;
				case "export_path":
					config.exportPath = value.replace(/['"]/g, "");
					break;
				case "default_assignee":
					config.defaultAssignee = value.replace(/['"]/g, "");
					break;
				case "default_reporter":
					config.defaultReporter = value.replace(/['"]/g, "");
					break;
				case "default_status":
					config.defaultStatus = value.replace(/['"]/g, "");
					break;
				case "statuses":
				case "labels":
					if (value.startsWith("[") && value.endsWith("]")) {
						const arrayContent = value.slice(1, -1);
						config[key] = arrayContent
							.split(",")
							.map((item) => item.trim().replace(/['"]/g, ""))
							.filter(Boolean);
					}
					break;
				case "date_format":
					config.dateFormat = value.replace(/['"]/g, "");
					break;
				case "max_column_width":
					config.maxColumnWidth = Number.parseInt(value, 10);
					break;
				case "default_editor":
					config.defaultEditor = value.replace(/["']/g, "");
					break;
				case "auto_open_browser":
					config.autoOpenBrowser = value.toLowerCase() === "true";
					break;
				case "default_port":
					config.defaultPort = Number.parseInt(value, 10);
					break;
				case "remote_operations":
					config.remoteOperations = value.toLowerCase() === "true";
					break;
				case "auto_commit":
					config.autoCommit = value.toLowerCase() === "true";
					break;
				case "zero_padded_ids":
					config.zeroPaddedIds = Number.parseInt(value, 10);
					break;
				case "bypass_git_hooks":
					config.bypassGitHooks = value.toLowerCase() === "true";
					break;
				case "check_active_branches":
					config.checkActiveBranches = value.toLowerCase() === "true";
					break;
				case "active_branch_days":
					config.activeBranchDays = Number.parseInt(value, 10);
					break;
				case "onStatusChange":
				case "on_status_change":
					// Remove surrounding quotes if present, but preserve inner content
					config.onStatusChange = value.replace(/^['"]|['"]$/g, "");
					break;
				case "proposal": {
					const prefixVal = value.replace(/['"]/g, "");
					if (!config.prefixes) config.prefixes = { proposal: "proposal" };
					config.prefixes.proposal = prefixVal;
					break;
				}
			}
		}

		const result: any = {
			projectName: config.projectName || "",
			statuses: config.statuses || [...DEFAULT_STATUSES],
			labels: config.labels || [],
			dateFormat: config.dateFormat || "yyyy-mm-dd",
		};

		if (config.defaultAssignee !== undefined)
			result.defaultAssignee = config.defaultAssignee;
		if (config.defaultReporter !== undefined)
			result.defaultReporter = config.defaultReporter;
		if (config.defaultStatus !== undefined)
			result.defaultStatus = config.defaultStatus;
		if (config.exportPath !== undefined) result.exportPath = config.exportPath;
		if (config.maxColumnWidth !== undefined)
			result.maxColumnWidth = config.maxColumnWidth;
		if (config.defaultEditor !== undefined)
			result.defaultEditor = config.defaultEditor;
		if (config.autoOpenBrowser !== undefined)
			result.autoOpenBrowser = config.autoOpenBrowser;
		if (config.defaultPort !== undefined)
			result.defaultPort = config.defaultPort;
		if (config.remoteOperations !== undefined)
			result.remoteOperations = config.remoteOperations;
		if (config.autoCommit !== undefined) result.autoCommit = config.autoCommit;
		if (config.zeroPaddedIds !== undefined)
			result.zeroPaddedIds = config.zeroPaddedIds;
		if (config.bypassGitHooks !== undefined)
			result.bypassGitHooks = config.bypassGitHooks;
		if (config.checkActiveBranches !== undefined)
			result.checkActiveBranches = config.checkActiveBranches;
		if (config.activeBranchDays !== undefined)
			result.activeBranchDays = config.activeBranchDays;
		if (config.onStatusChange !== undefined)
			result.onStatusChange = config.onStatusChange;
		if (config.prefixes !== undefined) result.prefixes = config.prefixes;
		if (config.database !== undefined) result.database = config.database;
		if (config.mcp !== undefined) result.mcp = config.mcp;
		if (config.git !== undefined) result.git = config.git;
		if (config.paths !== undefined) result.paths = config.paths;
		if (config.components !== undefined) result.components = config.components;

		return result as RoadmapConfig;
	}

	private serializeConfig(config: RoadmapConfig): string {
		try {
			const yaml = require("js-yaml");

			// If we have rawConfig (nested structure), update it with flat config values
			if (this.rawConfig) {
				const cfg = this.rawConfig;

				// Update nested project section
				if (cfg.project) {
					cfg.project.name = config.projectName;
					cfg.project.date_format = config.dateFormat;
					cfg.project.export_path = config.exportPath;
				} else if (!cfg.project_name) {
					// If neither nested nor flat project name exists, add it as flat for backward compat
					cfg.project_name = config.projectName;
				}

				// Update nested proposals section
				if (cfg.proposals) {
					cfg.proposals.default_status = config.defaultStatus;
					cfg.proposals.statuses = config.statuses;
					cfg.proposals.labels = config.labels;
					cfg.proposals.zero_padded_ids = config.zeroPaddedIds;
				} else {
					cfg.statuses = config.statuses;
					cfg.labels = config.labels;
					cfg.default_status = config.defaultStatus;
				}

				// Update nested ui section
				if (cfg.ui) {
					cfg.ui.max_column_width = config.maxColumnWidth;
					cfg.ui.auto_open_browser = config.autoOpenBrowser;
				}

				// Update other flat fields
				if (cfg.project_name !== undefined)
					cfg.project_name = config.projectName;
				if (cfg.date_format !== undefined) cfg.date_format = config.dateFormat;
				if (cfg.max_column_width !== undefined)
					cfg.max_column_width = config.maxColumnWidth;
				if (cfg.auto_open_browser !== undefined)
					cfg.auto_open_browser = config.autoOpenBrowser;
				if (cfg.default_port !== undefined)
					cfg.default_port = config.defaultPort;
				if (cfg.remote_operations !== undefined)
					cfg.remote_operations = config.remoteOperations;
				if (cfg.auto_commit !== undefined) cfg.auto_commit = config.autoCommit;
				if (cfg.zero_padded_ids !== undefined)
					cfg.zero_padded_ids = config.zeroPaddedIds;
				if (cfg.bypass_git_hooks !== undefined)
					cfg.bypass_git_hooks = config.bypassGitHooks;
				if (cfg.check_active_branches !== undefined)
					cfg.check_active_branches = config.checkActiveBranches;
				if (cfg.active_branch_days !== undefined)
					cfg.active_branch_days = config.activeBranchDays;
				if (config.mcp) {
					cfg.mcp = cfg.mcp || {};
					if (config.mcp.url !== undefined) cfg.mcp.url = config.mcp.url;
					if (config.mcp.healthEndpoint !== undefined)
						cfg.mcp.health_endpoint = config.mcp.healthEndpoint;
					if (config.mcp.toolsCount !== undefined)
						cfg.mcp.tools_count = config.mcp.toolsCount;
					if (config.mcp.port !== undefined) cfg.mcp.port = config.mcp.port;
					if (config.mcp.transport !== undefined)
						cfg.mcp.transport = config.mcp.transport;
					if (config.mcp.http !== undefined) cfg.mcp.http = config.mcp.http;
				}
				if (config.git) {
					cfg.git = cfg.git || {};
					if (config.git.remote !== undefined)
						cfg.git.remote = config.git.remote;
					if (config.git.defaultBranch !== undefined)
						cfg.git.default_branch = config.git.defaultBranch;
					if (config.git.worktreePath !== undefined)
						cfg.git.worktree_path = config.git.worktreePath;
				}
				if (config.paths) cfg.paths = config.paths;
				if (config.components) cfg.components = config.components;

				return yaml.dump(cfg, { indent: 2, lineWidth: -1 });
			}

			// Fallback: create a clean object and dump it
			const cleanObj: any = {
				project_name: config.projectName,
				statuses: config.statuses,
				labels: config.labels,
				default_status: config.defaultStatus,
				date_format: config.dateFormat,
				export_path: config.exportPath,
				max_column_width: config.maxColumnWidth,
				auto_open_browser: config.autoOpenBrowser,
				default_port: config.defaultPort,
				remote_operations: config.remoteOperations,
				auto_commit: config.autoCommit,
				zero_padded_ids: config.zeroPaddedIds,
				bypass_git_hooks: config.bypassGitHooks,
				check_active_branches: config.checkActiveBranches,
				active_branch_days: config.activeBranchDays,
			};

			if (config.database) cleanObj.database = config.database;
			if (config.mcp) {
				cleanObj.mcp = {
					...(config.mcp.url !== undefined ? { url: config.mcp.url } : {}),
					...(config.mcp.healthEndpoint !== undefined
						? { health_endpoint: config.mcp.healthEndpoint }
						: {}),
					...(config.mcp.toolsCount !== undefined
						? { tools_count: config.mcp.toolsCount }
						: {}),
					...(config.mcp.port !== undefined ? { port: config.mcp.port } : {}),
					...(config.mcp.transport !== undefined
						? { transport: config.mcp.transport }
						: {}),
					...(config.mcp.http !== undefined ? { http: config.mcp.http } : {}),
				};
			}
			if (config.git) {
				cleanObj.git = {
					...(config.git.remote !== undefined
						? { remote: config.git.remote }
						: {}),
					...(config.git.defaultBranch !== undefined
						? { default_branch: config.git.defaultBranch }
						: {}),
					...(config.git.worktreePath !== undefined
						? { worktree_path: config.git.worktreePath }
						: {}),
				};
			}
			if (config.paths) cleanObj.paths = config.paths;
			if (config.components) cleanObj.components = config.components;
			if (config.onStatusChange)
				cleanObj.on_status_change = config.onStatusChange;
			if (config.prefixes?.proposal)
				cleanObj.proposal = config.prefixes.proposal;

			return yaml.dump(cleanObj, { indent: 2, lineWidth: -1 });
		} catch (_e) {
			// Critical fallback: original manual serialization
			const lines = [
				`project_name: "${config.projectName}"`,
				...(config.defaultAssignee
					? [`default_assignee: "${config.defaultAssignee}"`]
					: []),
				...(config.defaultReporter
					? [`default_reporter: "${config.defaultReporter}"`]
					: []),
				...(config.defaultStatus
					? [`default_status: "${config.defaultStatus}"`]
					: []),
				`statuses: [${config.statuses.map((s) => `"${s}"`).join(", ")}]`,
				`labels: [${config.labels.map((l) => `"${l}"`).join(", ")}]`,
				`date_format: ${config.dateFormat}`,
				...(config.exportPath ? [`export_path: ${config.exportPath}`] : []),
				...(config.maxColumnWidth
					? [`max_column_width: ${config.maxColumnWidth}`]
					: []),
				...(config.defaultEditor
					? [`default_editor: "${config.defaultEditor}"`]
					: []),
				...(typeof config.autoOpenBrowser === "boolean"
					? [`auto_open_browser: ${config.autoOpenBrowser}`]
					: []),
				...(config.defaultPort ? [`default_port: ${config.defaultPort}`] : []),
				...(typeof config.remoteOperations === "boolean"
					? [`remote_operations: ${config.remoteOperations}`]
					: []),
				...(typeof config.autoCommit === "boolean"
					? [`auto_commit: ${config.autoCommit}`]
					: []),
				...(typeof config.zeroPaddedIds === "number"
					? [`zero_padded_ids: ${config.zeroPaddedIds}`]
					: []),
				...(typeof config.bypassGitHooks === "boolean"
					? [`bypass_git_hooks: ${config.bypassGitHooks}`]
					: []),
				...(typeof config.checkActiveBranches === "boolean"
					? [`check_active_branches: ${config.checkActiveBranches}`]
					: []),
				...(typeof config.activeBranchDays === "number"
					? [`active_branch_days: ${config.activeBranchDays}`]
					: []),
				...(config.onStatusChange
					? [`onStatusChange: '${config.onStatusChange}'`]
					: []),
				...(config.prefixes?.proposal
					? [`proposal: "${config.prefixes.proposal}"`]
					: []),
			];

			return `${lines.join("\n")}\n`;
		}
	}
}
