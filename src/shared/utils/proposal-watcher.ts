import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Core } from "../../core/roadmap.ts";
import type { Proposal } from "../types/index.ts";
import { hasAnyPrefix } from "./prefix-config.ts";

export interface ProposalWatcherCallbacks {
	/** Called when a new proposal file is created */
	onProposalAdded?: (proposal: Proposal) => void | Promise<void>;
	/** Called when an existing proposal file is modified */
	onProposalChanged?: (proposal: Proposal) => void | Promise<void>;
	/** Called when a proposal file is removed */
	onProposalRemoved?: (proposalId: string) => void | Promise<void>;
}

/**
 * Watch the roadmap/proposals directory for changes and emit incremental updates.
 * Uses node:fs.watch.
 */
export function watchProposals(
	core: Core,
	callbacks: ProposalWatcherCallbacks,
): { stop: () => void } {
	const proposalsDir = core.filesystem.proposalsDir;

	const watcher: FSWatcher = watch(
		proposalsDir,
		{ recursive: false },
		async (eventType, filename) => {
			// Normalize filename to a string when available
			let fileName: string | undefined;
			if (typeof filename === "string") {
				fileName = filename;
			} else if (filename != null) {
				fileName = String(filename);
			}
			// Accept any prefix pattern (proposal-, draft-, JIRA-, etc.) for proposal files
			const [proposalId] = fileName?.split(" ") ?? [];
			if (
				!fileName ||
				!proposalId ||
				!hasAnyPrefix(proposalId) ||
				!fileName.endsWith(".md")
			) {
				return;
			}

			if (eventType === "change") {
				const proposal = await core.filesystem.loadProposal(proposalId);
				if (proposal) {
					await callbacks.onProposalChanged?.(proposal);
				}
				return;
			}

			if (eventType === "rename") {
				// "rename" can be create, delete, or rename. Check if file exists.
				try {
					const fullPath = join(proposalsDir, fileName);
					const exists = await stat(fullPath)
						.then(() => true)
						.catch(() => false);

					if (!exists) {
						await callbacks.onProposalRemoved?.(proposalId);
						return;
					}

					const proposal = await core.filesystem.loadProposal(proposalId);
					if (proposal) {
						// Treat as a change; handlers may add if not present
						await callbacks.onProposalChanged?.(proposal);
					}
				} catch {
					// Ignore transient errors
				}
			}
		},
	);

	return {
		stop() {
			try {
				watcher.close();
			} catch {}
		},
	};
}
