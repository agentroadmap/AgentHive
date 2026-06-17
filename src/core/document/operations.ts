/**
 * Document creation / update helpers.
 *
 * Extracted from the `Core` class (P3796 monolith decomposition, Phase 1, AC-12).
 *
 * These functions accept a `DocumentContext` instead of relying on `this`, so
 * they can be called from `Core` without circular imports with `roadmap.ts`.
 */
import type { Core } from "../../index.ts";
import type { Document } from "../../types/index.ts";

export interface DocumentContext {
	saveDocument(doc: Document, subPath?: string): Promise<string>;
	shouldAutoCommit(override?: boolean): Promise<boolean>;
	getRoadmapDirectoryName(): Promise<string>;
	stageRoadmapDirectory(dir: string): Promise<string | null>;
	commitChanges(msg: string, root: string | null): Promise<void>;
	/** Create-document delegate, used by the update/with-id helpers. */
	createDocument(
		doc: Document,
		autoCommit?: boolean,
		subPath?: string,
	): Promise<void>;
}

export async function createDocument(
	ctx: DocumentContext,
	doc: Document,
	autoCommit?: boolean,
	subPath = "",
): Promise<void> {
	const relativePath = await ctx.saveDocument(doc, subPath);
	doc.path = relativePath;

	if (await ctx.shouldAutoCommit(autoCommit)) {
		const roadmapDir = await ctx.getRoadmapDirectoryName();
		const repoRoot = await ctx.stageRoadmapDirectory(roadmapDir);
		await ctx.commitChanges(`roadmap: Add document ${doc.id}`, repoRoot);
	}
}

export async function updateDocument(
	ctx: DocumentContext,
	existingDoc: Document,
	content: string,
	autoCommit?: boolean,
): Promise<void> {
	const updatedDoc = {
		...existingDoc,
		rawContent: content,
		updatedDate: new Date().toISOString().slice(0, 16).replace("T", " "),
	};

	let normalizedSubPath = "";
	if (existingDoc.path) {
		const segments = existingDoc.path.split(/[\\/]/).slice(0, -1);
		if (segments.length > 0) {
			normalizedSubPath = segments.join("/");
		}
	}

	await ctx.createDocument(updatedDoc, autoCommit, normalizedSubPath);
}

export async function createDocumentWithId(
	ctx: DocumentContext,
	core: Core,
	title: string,
	content: string,
	autoCommit?: boolean,
): Promise<Document> {
	// Import the generateNextDocId function from CLI
	const { generateNextDocId } = await import("../../cli.js");
	const id = await generateNextDocId(core);

	const document: Document = {
		id,
		title,
		type: "other" as const,
		createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
		rawContent: content,
	};

	await ctx.createDocument(document, autoCommit);
	return document;
}
