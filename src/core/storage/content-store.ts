import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { FileSystem } from "../../file-system/operations.ts";
import {
	parseDecision,
	parseDocument,
	parseProposal,
} from "../../markdown/parser.ts";
import type {
	Decision,
	Document,
	Proposal,
	ProposalListFilter,
} from "../../types/index.ts";
import {
	normalizeProposalId,
	normalizeProposalIdentity,
	proposalIdsEqual,
} from "../../utils/proposal-path.ts";
import { sortByProposalId } from "../../utils/proposal-sorting.ts";
import { isCompleteStatus, isReady } from "../proposal/directives.ts";

interface ContentSnapshot {
	proposals: Proposal[];
	documents: Document[];
	decisions: Decision[];
}

type ContentStoreEventType = "ready" | "proposals" | "documents" | "decisions";

export type ContentStoreEvent =
	| { type: "ready"; snapshot: ContentSnapshot; version: number }
	| {
			type: "proposals";
			proposals: Proposal[];
			snapshot: ContentSnapshot;
			version: number;
	  }
	| {
			type: "documents";
			documents: Document[];
			snapshot: ContentSnapshot;
			version: number;
	  }
	| {
			type: "decisions";
			decisions: Decision[];
			snapshot: ContentSnapshot;
			version: number;
	  };

export type ContentStoreListener = (event: ContentStoreEvent) => void;

interface WatchHandle {
	stop(): void;
}

export class ContentStore {
	private initialized = false;
	private initializing: Promise<void> | null = null;
	private version = 0;

	private readonly proposals = new Map<string, Proposal>();
	private readonly documents = new Map<string, Document>();
	private readonly decisions = new Map<string, Decision>();

	private cachedProposals: Proposal[] = [];
	private cachedDocuments: Document[] = [];
	private cachedDecisions: Decision[] = [];

	private readonly listeners = new Set<ContentStoreListener>();
	private readonly watchers: WatchHandle[] = [];
	private restoreFilesystemPatch?: () => void;
	private chainTail: Promise<void> = Promise.resolve();
	private watchersInitialized = false;
	private configWatcherActive = false;

	private attachWatcherErrorHandler(watcher: FSWatcher, context: string): void {
		watcher.on("error", (error) => {
			if (process.env.DEBUG) {
				console.warn(`Watcher error (${context})`, error);
			}
		});
	}

	private readonly filesystem: FileSystem;
	private readonly proposalLoader?: () => Promise<Proposal[]>;
	private readonly enableWatchers: boolean;

	constructor(
		filesystem: FileSystem,
		proposalLoader?: () => Promise<Proposal[]>,
		enableWatchers = false,
	) {
		this.filesystem = filesystem;
		this.proposalLoader = proposalLoader;
		this.enableWatchers = enableWatchers;
		this.patchFilesystem();
	}

	subscribe(listener: ContentStoreListener): () => void {
		this.listeners.add(listener);

		if (this.initialized) {
			listener({
				type: "ready",
				snapshot: this.getSnapshot(),
				version: this.version,
			});
		} else {
			void this.ensureInitialized();
		}

		return () => {
			this.listeners.delete(listener);
		};
	}

	async ensureInitialized(): Promise<ContentSnapshot> {
		if (this.initialized) {
			return this.getSnapshot();
		}

		if (!this.initializing) {
			this.initializing = this.loadInitialData().catch((error) => {
				this.initializing = null;
				throw error;
			});
		}

		await this.initializing;
		return this.getSnapshot();
	}

	getProposals(filter?: ProposalListFilter): Proposal[] {
		if (!this.initialized) {
			throw new Error(
				"ContentStore not initialized. Call ensureInitialized() first.",
			);
		}

		if (process.env.DEBUG) {
			console.error(
				"[DEBUG] getProposals: returning",
				this.proposals.size,
				"proposals",
			);
		}
		let proposals = this.cachedProposals;
		if (filter?.status) {
			const statusLower = filter.status.toLowerCase();
			proposals = proposals.filter(
				(proposal) => (proposal.status || "").toLowerCase() === statusLower,
			);
		}
		if (filter?.assignee) {
			const assignee = filter.assignee.toLowerCase();
			proposals = proposals.filter((proposal) =>
				(proposal.assignee || []).some((a) => a.toLowerCase() === assignee),
			);
		}
		if (filter?.priority) {
			const priority = filter.priority.toLowerCase();
			proposals = proposals.filter(
				(proposal) => (proposal.priority ?? "").toLowerCase() === priority,
			);
		}
		if (filter?.parentProposalId) {
			const parentFilter = filter.parentProposalId;
			proposals = proposals.filter(
				(proposal) =>
					proposal.parentProposalId &&
					proposalIdsEqual(parentFilter, proposal.parentProposalId),
			);
		}
		if (filter?.labels && filter.labels.length > 0) {
			const requiredLabels = filter.labels.map((l) => l.toLowerCase());
			proposals = proposals.filter((proposal) => {
				const proposalLabels = (proposal.labels || []).map((l) =>
					l.toLowerCase(),
				);
				return requiredLabels.every((l) => proposalLabels.includes(l));
			});
		}

		// Always calculate readiness for consistency
		const doneIds = new Set(
			this.cachedProposals
				.filter((s) => isCompleteStatus(s.status))
				.map((s) => s.id),
		);
		proposals = proposals.map((proposal) => ({
			...proposal,
			ready: isReady(proposal, doneIds),
		}));

		if (filter?.ready) {
			proposals = proposals.filter((proposal) => proposal.ready);
		}

		return proposals.slice();
	}

	upsertProposal(proposal: Proposal): void {
		if (!this.initialized) {
			return;
		}
		this.proposals.set(proposal.id, proposal);
		this.cachedProposals = sortByProposalId(
			Array.from(this.proposals.values()),
		);
		this.notify("proposals");
	}

	getDocuments(): Document[] {
		if (!this.initialized) {
			throw new Error(
				"ContentStore not initialized. Call ensureInitialized() first.",
			);
		}
		return this.cachedDocuments.slice();
	}

	getDecisions(): Decision[] {
		if (!this.initialized) {
			throw new Error(
				"ContentStore not initialized. Call ensureInitialized() first.",
			);
		}
		return this.cachedDecisions.slice();
	}

	getSnapshot(): ContentSnapshot {
		return {
			proposals: this.cachedProposals.slice(),
			documents: this.cachedDocuments.slice(),
			decisions: this.cachedDecisions.slice(),
		};
	}

	dispose(): void {
		if (this.restoreFilesystemPatch) {
			this.restoreFilesystemPatch();
			this.restoreFilesystemPatch = undefined;
		}
		for (const watcher of this.watchers) {
			try {
				watcher.stop();
			} catch {
				// Ignore watcher shutdown errors
			}
		}
		this.watchers.length = 0;
		this.watchersInitialized = false;
	}

	private emit(event: ContentStoreEvent): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	private notify(type: ContentStoreEventType): void {
		this.version += 1;
		const snapshot = this.getSnapshot();

		if (type === "proposals") {
			this.emit({
				type,
				proposals: snapshot.proposals,
				snapshot,
				version: this.version,
			});
			// Background sync to SQLite
			this.enqueue(async () => {
				for (const proposal of snapshot.proposals) {
					if (proposal.filePath) {
						const stats = await stat(proposal.filePath).catch(() => null);
						if (stats) {
							const _body = this.buildProposalBodyText(proposal);
						}
					}
				}
			});
			return;
		}

		if (type === "documents") {
			this.emit({
				type,
				documents: snapshot.documents,
				snapshot,
				version: this.version,
			});
			this.enqueue(async () => {
				for (const doc of snapshot.documents) {
					const fullPath = join(this.filesystem.docsDir, doc.path || "");
					const stats = await stat(fullPath).catch(() => null);
					if (stats) {
					}
				}
			});
			return;
		}

		if (type === "decisions") {
			this.emit({
				type,
				decisions: snapshot.decisions,
				snapshot,
				version: this.version,
			});
			this.enqueue(async () => {
				for (const decision of snapshot.decisions) {
					const decisionsDir = this.filesystem.decisionsDir;
					const decisionFiles: string[] = [];
					try {
						const files = await readdir(decisionsDir);
						for (const file of files) {
							if (file.startsWith(`decision-${decision.id} -`)) {
								decisionFiles.push(file);
							}
						}
					} catch {
						// ignore
					}
					if (decisionFiles[0]) {
						const fullPath = join(decisionsDir, decisionFiles[0]);
						const stats = await stat(fullPath).catch(() => null);
						if (stats) {
						}
					}
				}
			});
			return;
		}

		this.emit({ type: "ready", snapshot, version: this.version });
	}

	async loadInitialData(): Promise<void> {
		await this.filesystem.ensureRoadmapStructure();

		// Use custom proposal loader if provided (e.g., loadProposals for cross-branch support)
		// Otherwise fall back to filesystem-only loading
		const [proposals, documents, decisions] = await Promise.all([
			this.loadProposalsWithLoader(),
			this.filesystem.listDocuments(),
			this.filesystem.listDecisions(),
		]);

		if (process.env.DEBUG) {
			console.error(
				"[DEBUG] ContentStore.replaceProposals: count=",
				proposals.length,
				"sources=",
				proposals
					.slice(0, 3)
					.map((s) => s.source)
					.join(","),
			);
		}
		this.replaceProposals(proposals);
		this.replaceDocuments(documents);
		this.replaceDecisions(decisions);

		// Sync with SQLite in the background
		this.enqueue(async () => {
			for (const proposal of proposals) {
				if (proposal.status === "Complete" && process.env.DEBUG)
					console.error(
						"[DEBUG] Complete proposal found:",
						proposal.id,
						"source:",
						proposal.source,
						"branch:",
						proposal.branch,
					);
				if (proposal.filePath) {
					const _stats = await stat(proposal.filePath);
					const _body = this.buildProposalBodyText(proposal);
				}
			}
			for (const doc of documents) {
				const fullPath = join(this.filesystem.docsDir, doc.path || "");
				const stats = await stat(fullPath).catch(() => null);
				if (stats) {
				}
			}
			for (const decision of decisions) {
				const decisionsDir = this.filesystem.decisionsDir;
				const decisionFiles: string[] = [];
				const files = await readdir(decisionsDir);
				for (const file of files) {
					if (file.startsWith(`decision-${decision.id} -`)) {
						decisionFiles.push(file);
					}
				}
				if (decisionFiles[0]) {
					const fullPath = join(decisionsDir, decisionFiles[0]);
					const _stats = await stat(fullPath);
				}
			}
		});

		this.initialized = true;
		if (this.enableWatchers) {
			await this.setupWatchers();
		}
		this.notify("ready");
	}

	private buildProposalBodyText(proposal: Proposal): string {
		const parts: string[] = [];

		if (proposal.description) {
			parts.push(proposal.description);
		}

		if (
			Array.isArray(proposal.acceptanceCriteriaItems) &&
			proposal.acceptanceCriteriaItems.length > 0
		) {
			const lines = [...proposal.acceptanceCriteriaItems]
				.sort((a, b) => a.index - b.index)
				.map(
					(criterion) =>
						`- [${criterion.checked ? "x" : " "}] ${criterion.text}`,
				);
			parts.push(lines.join("\n"));
		}

		if (proposal.implementationPlan) {
			parts.push(proposal.implementationPlan);
		}

		if (proposal.implementationNotes) {
			parts.push(proposal.implementationNotes);
		}

		if (proposal.dependencies && proposal.dependencies.length > 0) {
			parts.push(`Dependencies: ${proposal.dependencies.join(", ")}`);
		}

		if (proposal.requires && proposal.requires.length > 0) {
			parts.push(`Requires: ${proposal.requires.join(", ")}`);
		}

		return parts.join("\n\n");
	}

	private async setupWatchers(): Promise<void> {
		if (this.watchersInitialized) return;
		this.watchersInitialized = true;

		try {
			this.watchers.push(this.createProposalWatcher());
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to initialize proposal watcher", error);
			}
		}

		try {
			this.watchers.push(this.createDecisionWatcher());
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to initialize decision watcher", error);
			}
		}

		try {
			const docWatcher = await this.createDocumentWatcher();
			this.watchers.push(docWatcher);
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to initialize document watcher", error);
			}
		}

		try {
			const configWatcher = this.createConfigWatcher();
			if (configWatcher) {
				this.watchers.push(configWatcher);
				this.configWatcherActive = true;
			}
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to initialize config watcher", error);
			}
		}
	}

	/**
	 * Retry setting up the config watcher after initialization.
	 * Called when the config file is created after the server started.
	 */
	ensureConfigWatcher(): void {
		if (this.configWatcherActive) {
			return;
		}
		try {
			const configWatcher = this.createConfigWatcher();
			if (configWatcher) {
				this.watchers.push(configWatcher);
				this.configWatcherActive = true;
			}
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to setup config watcher after init", error);
			}
		}
	}

	private createConfigWatcher(): WatchHandle | null {
		const configPath = this.filesystem.configFilePath;
		try {
			const watcher: FSWatcher = watch(configPath, (eventType) => {
				if (eventType !== "change" && eventType !== "rename") {
					return;
				}
				this.enqueue(async () => {
					this.filesystem.invalidateConfigCache();
					this.notify("proposals");
				});
			});
			this.attachWatcherErrorHandler(watcher, "config");

			return {
				stop() {
					watcher.close();
				},
			};
		} catch (error) {
			if (process.env.DEBUG) {
				console.error("Failed to watch config file", error);
			}
			return null;
		}
	}

	private createProposalWatcher(): WatchHandle {
		const proposalsDir = this.filesystem.proposalsDir;
		const watcher: FSWatcher = watch(
			proposalsDir,
			{ recursive: false },
			(eventType, filename) => {
				const file = this.normalizeFilename(filename);
				// Accept any prefix pattern (proposal-, jira-, etc.) followed by ID and ending in .md
				if (!file || !/^[a-zA-Z]+-/.test(file) || !file.endsWith(".md")) {
					this.enqueue(async () => {
						await this.refreshProposalsFromDisk();
					});
					return;
				}

				this.enqueue(async () => {
					const [proposalId] = file.split(" ");
					if (!proposalId) return;
					const normalizedProposalId = normalizeProposalId(proposalId);

					const fullPath = join(proposalsDir, file);
					let exists = false;
					try {
						await stat(fullPath);
						exists = true;
					} catch {
						// File doesn't exist
					}

					if (!exists && eventType === "rename") {
						if (this.proposals.delete(normalizedProposalId)) {
							this.cachedProposals = sortByProposalId(
								Array.from(this.proposals.values()),
							);
							this.notify("proposals");
						}
						return;
					}

					if (eventType === "rename" && exists) {
						await this.refreshProposalsFromDisk();
						return;
					}

					const previous = this.proposals.get(normalizedProposalId);
					const proposal = await this.retryRead(
						async () => {
							let stillExists = false;
							try {
								await stat(fullPath);
								stillExists = true;
							} catch {
								// File doesn't exist
							}
							if (!stillExists) {
								return null;
							}
							const content = await readFile(fullPath, "utf-8");
							return normalizeProposalIdentity(parseProposal(content));
						},
						(result) => {
							if (!result) {
								return false;
							}
							if (!proposalIdsEqual(result.id, normalizedProposalId)) {
								return false;
							}
							if (!previous) {
								return true;
							}
							return this.hasProposalChanged(previous, result);
						},
					);
					if (!proposal) {
						await this.refreshProposalsFromDisk(normalizedProposalId, previous);
						return;
					}

					this.proposals.set(proposal.id, proposal);
					this.cachedProposals = sortByProposalId(
						Array.from(this.proposals.values()),
					);
					this.notify("proposals");
				});
			},
		);
		this.attachWatcherErrorHandler(watcher, "proposals");

		return {
			stop() {
				watcher.close();
			},
		};
	}

	private createDecisionWatcher(): WatchHandle {
		const decisionsDir = this.filesystem.decisionsDir;
		const watcher: FSWatcher = watch(
			decisionsDir,
			{ recursive: false },
			(eventType, filename) => {
				const file = this.normalizeFilename(filename);
				if (!file || !file.startsWith("decision-") || !file.endsWith(".md")) {
					this.enqueue(async () => {
						await this.refreshDecisionsFromDisk();
					});
					return;
				}

				this.enqueue(async () => {
					const [idPart] = file.split(" - ");
					if (!idPart) return;

					const fullPath = join(decisionsDir, file);
					let exists = false;
					try {
						await stat(fullPath);
						exists = true;
					} catch {
						// File doesn't exist
					}

					if (!exists && eventType === "rename") {
						if (this.decisions.delete(idPart)) {
							this.cachedDecisions = sortByProposalId(
								Array.from(this.decisions.values()),
							);
							this.notify("decisions");
						}
						return;
					}

					if (eventType === "rename" && exists) {
						await this.refreshDecisionsFromDisk();
						return;
					}

					const previous = this.decisions.get(idPart);
					const decision = await this.retryRead(
						async () => {
							try {
								const content = await readFile(fullPath, "utf-8");
								return parseDecision(content);
							} catch {
								return null;
							}
						},
						(result) => {
							if (!result) {
								return false;
							}
							if (result.id !== idPart) {
								return false;
							}
							if (!previous) {
								return true;
							}
							return this.hasDecisionChanged(previous, result);
						},
					);
					if (!decision) {
						await this.refreshDecisionsFromDisk(idPart, previous);
						return;
					}
					this.decisions.set(decision.id, decision);
					this.cachedDecisions = sortByProposalId(
						Array.from(this.decisions.values()),
					);
					this.notify("decisions");
				});
			},
		);
		this.attachWatcherErrorHandler(watcher, "decisions");

		return {
			stop() {
				watcher.close();
			},
		};
	}

	private async createDocumentWatcher(): Promise<WatchHandle> {
		const docsDir = this.filesystem.docsDir;
		return this.createDirectoryWatcher(
			docsDir,
			async (eventType, absolutePath, relativePath) => {
				const base = basename(absolutePath);
				if (!base.endsWith(".md")) {
					if (relativePath === null) {
						await this.refreshDocumentsFromDisk();
					}
					return;
				}

				if (!base.startsWith("doc-")) {
					await this.refreshDocumentsFromDisk();
					return;
				}

				const [idPart] = base.split(" - ");
				if (!idPart) {
					await this.refreshDocumentsFromDisk();
					return;
				}

				let exists = false;
				try {
					await stat(absolutePath);
					exists = true;
				} catch {
					// File doesn't exist
				}

				if (!exists && eventType === "rename") {
					if (this.documents.delete(idPart)) {
						this.cachedDocuments = [...this.documents.values()].sort((a, b) =>
							a.title.localeCompare(b.title),
						);
						this.notify("documents");
					}
					return;
				}

				if (eventType === "rename" && exists) {
					await this.refreshDocumentsFromDisk();
					return;
				}

				const previous = this.documents.get(idPart);
				const document = await this.retryRead(
					async () => {
						try {
							const content = await readFile(absolutePath, "utf-8");
							return parseDocument(content);
						} catch {
							return null;
						}
					},
					(result) => {
						if (!result) {
							return false;
						}
						if (result.id !== idPart) {
							return false;
						}
						if (!previous) {
							return true;
						}
						return this.hasDocumentChanged(previous, result);
					},
				);
				if (!document) {
					await this.refreshDocumentsFromDisk(idPart, previous);
					return;
				}

				this.documents.set(document.id, document);
				this.cachedDocuments = [...this.documents.values()].sort((a, b) =>
					a.title.localeCompare(b.title),
				);
				this.notify("documents");
			},
		);
	}

	private normalizeFilename(
		value: string | Buffer | null | undefined,
	): string | null {
		if (typeof value === "string") {
			return value;
		}
		if (value instanceof Buffer) {
			return value.toString();
		}
		return null;
	}

	private async createDirectoryWatcher(
		rootDir: string,
		handler: (
			eventType: string,
			absolutePath: string,
			relativePath: string | null,
		) => Promise<void> | void,
	): Promise<WatchHandle> {
		try {
			const watcher = watch(
				rootDir,
				{ recursive: true },
				(eventType, filename) => {
					const relativePath = this.normalizeFilename(filename);
					const absolutePath = relativePath
						? join(rootDir, relativePath)
						: rootDir;

					this.enqueue(async () => {
						await handler(eventType, absolutePath, relativePath);
					});
				},
			);
			this.attachWatcherErrorHandler(watcher, `dir:${rootDir}`);

			return {
				stop() {
					watcher.close();
				},
			};
		} catch (error) {
			if (this.isRecursiveUnsupported(error)) {
				return this.createManualRecursiveWatcher(rootDir, handler);
			}
			throw error;
		}
	}

	private isRecursiveUnsupported(error: unknown): boolean {
		if (!error || typeof error !== "object") {
			return false;
		}
		const maybeError = error as { code?: string; message?: string };
		if (maybeError.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
			return true;
		}
		return (
			typeof maybeError.message === "string" &&
			maybeError.message.toLowerCase().includes("recursive") &&
			maybeError.message.toLowerCase().includes("not supported")
		);
	}

	private replaceProposals(proposals: Proposal[]): void {
		this.proposals.clear();
		for (const proposal of proposals) {
			if (proposal.status === "Complete" && process.env.DEBUG)
				console.error(
					"[DEBUG] Complete proposal found:",
					proposal.id,
					"source:",
					proposal.source,
					"branch:",
					proposal.branch,
				);
			this.proposals.set(proposal.id, proposal);
		}
		this.cachedProposals = sortByProposalId(
			Array.from(this.proposals.values()),
		);
	}

	private replaceDocuments(documents: Document[]): void {
		this.documents.clear();
		for (const document of documents) {
			this.documents.set(document.id, document);
		}
		this.cachedDocuments = [...this.documents.values()].sort((a, b) =>
			a.title.localeCompare(b.title),
		);
	}

	private replaceDecisions(decisions: Decision[]): void {
		this.decisions.clear();
		for (const decision of decisions) {
			this.decisions.set(decision.id, decision);
		}
		this.cachedDecisions = sortByProposalId(
			Array.from(this.decisions.values()),
		);
	}

	private patchFilesystem(): void {
		if (this.restoreFilesystemPatch) {
			return;
		}

		const originalSaveProposal = this.filesystem.saveProposal;
		const originalSaveDocument = this.filesystem.saveDocument;
		const originalSaveDecision = this.filesystem.saveDecision;

		this.filesystem.saveProposal = (async (
			proposal: Proposal,
		): Promise<string> => {
			const result = await originalSaveProposal.call(this.filesystem, proposal);
			await this.handleProposalWrite(proposal.id);
			return result;
		}) as FileSystem["saveProposal"];

		this.filesystem.saveDocument = (async (
			document: Document,
			subPath = "",
		): Promise<string> => {
			const result = await originalSaveDocument.call(
				this.filesystem,
				document,
				subPath,
			);
			await this.handleDocumentWrite(document.id);
			return result;
		}) as FileSystem["saveDocument"];

		this.filesystem.saveDecision = (async (
			decision: Decision,
		): Promise<void> => {
			await originalSaveDecision.call(this.filesystem, decision);
			await this.handleDecisionWrite(decision.id);
		}) as FileSystem["saveDecision"];

		this.restoreFilesystemPatch = () => {
			this.filesystem.saveProposal = originalSaveProposal;
			this.filesystem.saveDocument = originalSaveDocument;
			this.filesystem.saveDecision = originalSaveDecision;
		};
	}

	private async handleProposalWrite(proposalId: string): Promise<void> {
		if (!this.initialized) {
			return;
		}
		await this.updateProposalFromDisk(proposalId);
	}

	private async handleDocumentWrite(documentId: string): Promise<void> {
		if (!this.initialized) {
			return;
		}
		await this.refreshDocumentsFromDisk(
			documentId,
			this.documents.get(documentId),
		);
	}

	private hasProposalChanged(previous: Proposal, next: Proposal): boolean {
		return JSON.stringify(previous) !== JSON.stringify(next);
	}

	private hasDocumentChanged(previous: Document, next: Document): boolean {
		return JSON.stringify(previous) !== JSON.stringify(next);
	}

	private hasDecisionChanged(previous: Decision, next: Decision): boolean {
		return JSON.stringify(previous) !== JSON.stringify(next);
	}

	private async refreshProposalsFromDisk(
		expectedId?: string,
		previous?: Proposal,
	): Promise<void> {
		const proposals = await this.retryRead(
			async () => this.loadProposalsWithLoader(),
			(expected) => {
				if (!expectedId) {
					return true;
				}
				const match = expected.find((proposal) =>
					proposalIdsEqual(proposal.id, expectedId),
				);
				if (!match) {
					return false;
				}
				if (previous && !this.hasProposalChanged(previous, match)) {
					return false;
				}
				return true;
			},
		);
		if (!proposals) {
			return;
		}
		if (process.env.DEBUG) {
			console.error(
				"[DEBUG] ContentStore.replaceProposals: count=",
				proposals.length,
				"sources=",
				proposals
					.slice(0, 3)
					.map((s) => s.source)
					.join(","),
			);
		}
		this.replaceProposals(proposals);
		this.notify("proposals");
	}

	private async refreshDocumentsFromDisk(
		expectedId?: string,
		previous?: Document,
	): Promise<void> {
		const documents = await this.retryRead(
			async () => this.filesystem.listDocuments(),
			(expected) => {
				if (!expectedId) {
					return true;
				}
				const match = expected.find((doc) => doc.id === expectedId);
				if (!match) {
					return false;
				}
				if (previous && !this.hasDocumentChanged(previous, match)) {
					return false;
				}
				return true;
			},
		);
		if (!documents) {
			return;
		}
		this.replaceDocuments(documents);
		this.notify("documents");
	}

	private async refreshDecisionsFromDisk(
		expectedId?: string,
		previous?: Decision,
	): Promise<void> {
		const decisions = await this.retryRead(
			async () => this.filesystem.listDecisions(),
			(expected) => {
				if (!expectedId) {
					return true;
				}
				const match = expected.find((decision) => decision.id === expectedId);
				if (!match) {
					return false;
				}
				if (previous && !this.hasDecisionChanged(previous, match)) {
					return false;
				}
				return true;
			},
		);
		if (!decisions) {
			return;
		}
		this.replaceDecisions(decisions);
		this.notify("decisions");
	}

	private async handleDecisionWrite(decisionId: string): Promise<void> {
		if (!this.initialized) {
			return;
		}
		await this.updateDecisionFromDisk(decisionId);
	}

	private async updateProposalFromDisk(proposalId: string): Promise<void> {
		const normalizedProposalId = normalizeProposalId(proposalId);
		const previous = this.proposals.get(normalizedProposalId);
		const proposal = await this.retryRead(
			async () => this.filesystem.loadProposal(proposalId),
			(result) =>
				result !== null &&
				(!previous || this.hasProposalChanged(previous, result)),
		);
		if (!proposal) {
			return;
		}
		this.proposals.set(proposal.id, proposal);
		this.cachedProposals = sortByProposalId(
			Array.from(this.proposals.values()),
		);
		this.notify("proposals");
	}

	private async updateDecisionFromDisk(decisionId: string): Promise<void> {
		const previous = this.decisions.get(decisionId);
		const decision = await this.retryRead(
			async () => this.filesystem.loadDecision(decisionId),
			(result) =>
				result !== null &&
				(!previous || this.hasDecisionChanged(previous, result)),
		);
		if (!decision) {
			return;
		}
		this.decisions.set(decision.id, decision);
		this.cachedDecisions = sortByProposalId(
			Array.from(this.decisions.values()),
		);
		this.notify("decisions");
	}

	private async createManualRecursiveWatcher(
		rootDir: string,
		handler: (
			eventType: string,
			absolutePath: string,
			relativePath: string | null,
		) => Promise<void> | void,
	): Promise<WatchHandle> {
		const watchers = new Map<string, FSWatcher>();
		let disposed = false;

		const removeSubtreeWatchers = (baseDir: string) => {
			const prefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
			for (const path of [...watchers.keys()]) {
				if (path === baseDir || path.startsWith(prefix)) {
					watchers.get(path)?.close();
					watchers.delete(path);
				}
			}
		};

		const addWatcher = async (dir: string): Promise<void> => {
			if (disposed || watchers.has(dir)) {
				return;
			}

			const watcher = watch(
				dir,
				{ recursive: false },
				(eventType, filename) => {
					if (disposed) {
						return;
					}
					const relativePath = this.normalizeFilename(filename);
					const absolutePath = relativePath ? join(dir, relativePath) : dir;
					const normalizedRelative = relativePath
						? relative(rootDir, absolutePath)
						: null;

					this.enqueue(async () => {
						await handler(eventType, absolutePath, normalizedRelative);

						if (eventType === "rename" && relativePath) {
							try {
								const stats = await stat(absolutePath);
								if (stats.isDirectory()) {
									await addWatcher(absolutePath);
								}
							} catch {
								removeSubtreeWatchers(absolutePath);
							}
						}
					});
				},
			);
			this.attachWatcherErrorHandler(watcher, `manual:${dir}`);

			watchers.set(dir, watcher);

			try {
				const entries = await readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					const entryPath = join(dir, entry.name);
					if (entry.isDirectory()) {
						await addWatcher(entryPath);
						continue;
					}

					if (entry.isFile()) {
						this.enqueue(async () => {
							await handler("change", entryPath, relative(rootDir, entryPath));
						});
					}
				}
			} catch {
				// Ignore transient directory enumeration issues
			}
		};

		await addWatcher(rootDir);

		return {
			stop() {
				disposed = true;
				for (const watcher of watchers.values()) {
					watcher.close();
				}
				watchers.clear();
			},
		};
	}

	private async retryRead<T>(
		loader: () => Promise<T>,
		isValid: (result: T) => boolean = (value) =>
			value !== null && value !== undefined,
		attempts = 12,
		delayMs = 75,
	): Promise<T | null> {
		let lastError: unknown = null;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				const result = await loader();
				if (isValid(result)) {
					return result;
				}
			} catch (error) {
				lastError = error;
			}
			if (attempt < attempts) {
				await this.delay(delayMs * attempt);
			}
		}

		if (lastError && process.env.DEBUG) {
			console.error("ContentStore retryRead exhausted attempts", lastError);
		}
		return null;
	}

	private async delay(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	private enqueue(fn: () => Promise<void>): void {
		this.chainTail = this.chainTail
			.then(() => fn())
			.catch((error) => {
				if (process.env.DEBUG) {
					console.error("ContentStore update failed", error);
				}
			});
	}

	private async loadProposalsWithLoader(): Promise<Proposal[]> {
		if (this.proposalLoader) {
			const proposals = await this.proposalLoader();
			if (proposals.length > 0) return proposals;
		}
		// Fallback to direct filesystem listing if loader returns nothing (important for tests)
		return await this.filesystem.listProposals();
	}
}

export type { ContentSnapshot };
