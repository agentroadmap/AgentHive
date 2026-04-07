import MDEditor from "@uiw/react-md-editor";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
	AcceptanceCriterion,
	Directive,
	Proposal,
} from "../../../shared/types";
import { useTheme } from "../contexts/ThemeContext";
import { apiClient } from "../lib/api";
import { formatStoredUtcDateForDisplay } from "../utils/date-display";
import AcceptanceCriteriaEditor from "./AcceptanceCriteriaEditor";
import ChipInput from "./ChipInput";
import DependencyInput from "./DependencyInput";
import MermaidMarkdown from "./MermaidMarkdown";
import Modal from "./Modal";

interface Props {
	proposal?: Proposal; // Optional for create mode
	isOpen: boolean;
	onClose: () => void;
	onSaved?: () => Promise<void> | void; // refresh callback
	onSubmit?: (proposalData: Partial<Proposal>) => Promise<void>; // For creating new proposals
	onArchive?: () => void; // For archiving proposals
	availableStatuses?: string[]; // Available statuses for new proposals
	isDraftMode?: boolean; // Whether creating a draft
	availableDirectives?: string[];
	directiveEntities?: Directive[];
	archivedDirectiveEntities?: Directive[];
}

type Mode = "preview" | "edit" | "create";

type ProposalUpdatePayload = Partial<Proposal>;

type InlineMetaUpdatePayload = Omit<Partial<Proposal>, "directive"> & {
	directive?: string | null;
};

const SectionHeader: React.FC<{ title: string; right?: React.ReactNode }> = ({
	title,
	right,
}) => (
	<div className="flex items-center justify-between mb-3">
		<h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 tracking-tight transition-colors duration-200">
			{title}
		</h3>
		{right ? (
			<div className="ml-2 text-xs text-gray-500 dark:text-gray-400">
				{right}
			</div>
		) : null}
	</div>
);

export const ProposalDetailsModal: React.FC<Props> = ({
	proposal,
	isOpen,
	onClose,
	onSaved,
	onSubmit,
	onArchive,
	availableStatuses,
	availableDirectives: _availableDirectives,
	directiveEntities,
	archivedDirectiveEntities,
	isDraftMode,
}) => {
	const { theme } = useTheme();
	const isCreateMode = !proposal;
	const isFromOtherBranch = Boolean(proposal?.branch);
	const [mode, setMode] = useState<Mode>(isCreateMode ? "create" : "preview");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Title field for create mode
	const [title, setTitle] = useState(proposal?.title || "");

	// Editable fields (edit mode)
	const [description, setDescription] = useState(proposal?.description || "");
	const [plan, setPlan] = useState(proposal?.implementationPlan || "");
	const [notes, setNotes] = useState(proposal?.implementationNotes || "");
	const [finalSummary, setFinalSummary] = useState(
		proposal?.finalSummary || "",
	);
	const [criteria, setCriteria] = useState<AcceptanceCriterion[]>(
		proposal?.acceptanceCriteriaItems || [],
	);
	const resolveDirectiveToId = useCallback(
		(value?: string | null): string => {
			const normalized = (value ?? "").trim();
			if (!normalized) return "";
			const key = normalized.toLowerCase();
			const aliasKeys = new Set<string>([key]);
			const looksLikeDirectiveId =
				/^\d+$/.test(normalized) || /^m-\d+$/i.test(normalized);
			const canonicalInputId = looksLikeDirectiveId
				? `m-${String(Number.parseInt(normalized.replace(/^m-/i, ""), 10))}`
				: null;
			if (/^\d+$/.test(normalized)) {
				const numericAlias = String(Number.parseInt(normalized, 10));
				aliasKeys.add(numericAlias);
				aliasKeys.add(`m-${numericAlias}`);
			} else {
				const idMatch = normalized.match(/^m-(\d+)$/i);
				if (idMatch?.[1]) {
					const numericAlias = String(Number.parseInt(idMatch[1], 10));
					aliasKeys.add(numericAlias);
					aliasKeys.add(`m-${numericAlias}`);
				}
			}
			const idMatchesAlias = (directiveId: string): boolean => {
				const directiveKey = directiveId.trim().toLowerCase();
				if (aliasKeys.has(directiveKey)) {
					return true;
				}
				const idMatch = directiveId.trim().match(/^m-(\d+)$/i);
				if (!idMatch?.[1]) {
					return false;
				}
				const numericAlias = String(Number.parseInt(idMatch[1], 10));
				return (
					aliasKeys.has(numericAlias) || aliasKeys.has(`m-${numericAlias}`)
				);
			};
			const findIdMatch = (directives: Directive[]): Directive | undefined => {
				const rawExactMatch = directives.find(
					(directive) => directive.id.trim().toLowerCase() === key,
				);
				if (rawExactMatch) {
					return rawExactMatch;
				}
				if (canonicalInputId) {
					const canonicalRawMatch = directives.find(
						(directive) =>
							directive.id.trim().toLowerCase() === canonicalInputId,
					);
					if (canonicalRawMatch) {
						return canonicalRawMatch;
					}
				}
				return directives.find((directive) => idMatchesAlias(directive.id));
			};
			const activeDirectives = directiveEntities ?? [];
			const archivedDirectives = archivedDirectiveEntities ?? [];
			const activeIdMatch = findIdMatch(activeDirectives);
			if (activeIdMatch) {
				return activeIdMatch.id;
			}
			if (looksLikeDirectiveId) {
				const archivedIdMatch = findIdMatch(archivedDirectives);
				if (archivedIdMatch) {
					return archivedIdMatch.id;
				}
			}
			const activeTitleMatches = activeDirectives.filter(
				(directive) => directive.title.trim().toLowerCase() === key,
			);
			if (activeTitleMatches.length === 1) {
				return activeTitleMatches[0]?.id ?? normalized;
			}
			if (activeTitleMatches.length > 1) {
				return normalized;
			}
			const archivedIdMatch = findIdMatch(archivedDirectives);
			if (archivedIdMatch) {
				return archivedIdMatch.id;
			}
			const archivedTitleMatches = archivedDirectives.filter(
				(directive) => directive.title.trim().toLowerCase() === key,
			);
			if (archivedTitleMatches.length === 1) {
				return archivedTitleMatches[0]?.id ?? normalized;
			}
			return normalized;
		},
		[directiveEntities, archivedDirectiveEntities],
	);
	const resolveDirectiveLabel = useCallback(
		(value?: string | null): string => {
			const normalized = (value ?? "").trim();
			if (!normalized) return "";
			const key = normalized.toLowerCase();
			const aliasKeys = new Set<string>([key]);
			const canonicalInputId =
				/^\d+$/.test(normalized) || /^m-\d+$/i.test(normalized)
					? `m-${String(Number.parseInt(normalized.replace(/^m-/i, ""), 10))}`
					: null;
			if (/^\d+$/.test(normalized)) {
				const numericAlias = String(Number.parseInt(normalized, 10));
				aliasKeys.add(numericAlias);
				aliasKeys.add(`m-${numericAlias}`);
			} else {
				const idMatch = normalized.match(/^m-(\d+)$/i);
				if (idMatch?.[1]) {
					const numericAlias = String(Number.parseInt(idMatch[1], 10));
					aliasKeys.add(numericAlias);
					aliasKeys.add(`m-${numericAlias}`);
				}
			}
			const idMatchesAlias = (directiveId: string): boolean => {
				const directiveKey = directiveId.trim().toLowerCase();
				if (aliasKeys.has(directiveKey)) {
					return true;
				}
				const idMatch = directiveId.trim().match(/^m-(\d+)$/i);
				if (!idMatch?.[1]) {
					return false;
				}
				const numericAlias = String(Number.parseInt(idMatch[1], 10));
				return (
					aliasKeys.has(numericAlias) || aliasKeys.has(`m-${numericAlias}`)
				);
			};
			const findIdMatch = (directives: Directive[]): Directive | undefined => {
				const rawExactMatch = directives.find(
					(directive) => directive.id.trim().toLowerCase() === key,
				);
				if (rawExactMatch) {
					return rawExactMatch;
				}
				if (canonicalInputId) {
					const canonicalRawMatch = directives.find(
						(directive) =>
							directive.id.trim().toLowerCase() === canonicalInputId,
					);
					if (canonicalRawMatch) {
						return canonicalRawMatch;
					}
				}
				return directives.find((directive) => idMatchesAlias(directive.id));
			};
			const allDirectives = [
				...(directiveEntities ?? []),
				...(archivedDirectiveEntities ?? []),
			];
			const idMatch = findIdMatch(allDirectives);
			if (idMatch) {
				return idMatch.title;
			}
			const titleMatches = allDirectives.filter(
				(directive) => directive.title.trim().toLowerCase() === key,
			);
			return titleMatches.length === 1
				? (titleMatches[0]?.title ?? normalized)
				: normalized;
		},
		[directiveEntities, archivedDirectiveEntities],
	);

	// Sidebar metadata (inline edit)
	const [status, setStatus] = useState(
		proposal?.status ||
			(isDraftMode ? "Draft" : availableStatuses?.[0] || "New"),
	);
	const [assignee, setAssignee] = useState<string[]>(proposal?.assignee || []);
	const [labels, setLabels] = useState<string[]>(proposal?.labels || []);
	const [priority, setPriority] = useState<string>(proposal?.priority || "");
	const [dependencies, setDependencies] = useState<string[]>(
		proposal?.dependencies || [],
	);
	const [references, setReferences] = useState<string[]>(
		proposal?.references || [],
	);
	const [directive, setDirective] = useState<string>(proposal?.directive || "");
	const [availableProposals, setAvailableProposals] = useState<Proposal[]>([]);
	const directiveSelectionValue = resolveDirectiveToId(directive);
	const hasDirectiveSelection = (directiveEntities ?? []).some(
		(directiveEntity) => directiveEntity.id === directiveSelectionValue,
	);

	// Keep a baseline for dirty-check
	const baseline = useMemo(
		() => ({
			title: proposal?.title || "",
			description: proposal?.description || "",
			plan: proposal?.implementationPlan || "",
			notes: proposal?.implementationNotes || "",
			finalSummary: proposal?.finalSummary || "",
			criteria: JSON.stringify(proposal?.acceptanceCriteriaItems || []),
		}),
		[proposal],
	);

	const isDirty = useMemo(() => {
		return (
			title !== baseline.title ||
			description !== baseline.description ||
			plan !== baseline.plan ||
			notes !== baseline.notes ||
			finalSummary !== baseline.finalSummary ||
			JSON.stringify(criteria) !== baseline.criteria
		);
	}, [title, description, plan, notes, finalSummary, criteria, baseline]);

	// Reset local proposal when proposal changes or modal opens
	useEffect(() => {
		setTitle(proposal?.title || "");
		setDescription(proposal?.description || "");
		setPlan(proposal?.implementationPlan || "");
		setNotes(proposal?.implementationNotes || "");
		setFinalSummary(proposal?.finalSummary || "");
		setCriteria(proposal?.acceptanceCriteriaItems || []);
		setStatus(
			proposal?.status ||
				(isDraftMode ? "Draft" : availableStatuses?.[0] || "New"),
		);
		setAssignee(proposal?.assignee || []);
		setLabels(proposal?.labels || []);
		setPriority(proposal?.priority || "");
		setDependencies(proposal?.dependencies || []);
		setReferences(proposal?.references || []);
		setDirective(proposal?.directive || "");
		setMode(isCreateMode ? "create" : "preview");
		setError(null);
		// Preload proposals for dependency picker
		apiClient
			.fetchProposals()
			.then(setAvailableProposals)
			.catch(() => setAvailableProposals([]));
	}, [proposal, isCreateMode, isDraftMode, availableStatuses]);

	const handleCancelEdit = useCallback(() => {
		if (isDirty) {
			const confirmDiscard = window.confirm("Discard unsaved changes?");
			if (!confirmDiscard) return;
		}
		if (isCreateMode) {
			// In create mode, close the modal on cancel
			onClose();
		} else {
			setTitle(proposal?.title || "");
			setDescription(proposal?.description || "");
			setPlan(proposal?.implementationPlan || "");
			setNotes(proposal?.implementationNotes || "");
			setFinalSummary(proposal?.finalSummary || "");
			setCriteria(proposal?.acceptanceCriteriaItems || []);
			setMode("preview");
		}
	}, [isCreateMode, isDirty, onClose, proposal]);

	const _normalizeChecklistItems = (
		items: AcceptanceCriterion[],
	): AcceptanceCriterion[] => {
		return items
			.map((item) => ({ ...item, text: item.text.trim() }))
			.filter((item) => item.text.length > 0);
	};

	const handleSave = useCallback(async () => {
		setSaving(true);
		setError(null);

		// Validation for create mode
		if (isCreateMode && !title.trim()) {
			setError("Title is required");
			setSaving(false);
			return;
		}

		try {
			const proposalData: ProposalUpdatePayload = {
				title: title.trim(),
				description,
				implementationPlan: plan,
				implementationNotes: notes,
				finalSummary,
				acceptanceCriteriaItems: criteria,
				status,
				assignee,
				labels,
				priority: (priority === "" ? undefined : priority) as
					| "high"
					| "medium"
					| "low"
					| undefined,
				dependencies,
				directive: directive.trim().length > 0 ? directive.trim() : undefined,
			};

			if (isCreateMode && onSubmit) {
				// Create new proposal
				await onSubmit(proposalData);
				// Only close if successful (no error thrown)
				onClose();
			} else if (proposal) {
				// Update existing proposal
				await apiClient.updateProposal(proposal.id, proposalData);
				setMode("preview");
				if (onSaved) await onSaved();
			}
		} catch (err) {
			// Extract and display the error message from API response
			let errorMessage = "Failed to save proposal";

			if (err instanceof Error) {
				errorMessage = err.message;
			} else if (typeof err === "object" && err !== null && "error" in err) {
				errorMessage = String((err as { error?: unknown }).error);
			} else if (typeof err === "string") {
				errorMessage = err;
			}

			setError(errorMessage);
		} finally {
			setSaving(false);
		}
	}, [
		assignee,
		criteria,
		dependencies,
		description,
		directive,
		finalSummary,
		isCreateMode,
		labels,
		notes,
		onClose,
		onSaved,
		onSubmit,
		plan,
		priority,
		proposal,
		status,
		title,
	]);

	const handleToggleCriterion = async (index: number, checked: boolean) => {
		if (!proposal) return; // Can't toggle in create mode
		if (isFromOtherBranch) return; // Can't toggle for cross-branch proposals
		// Optimistic update
		const next = (criteria || []).map((c) =>
			c.index === index ? { ...c, checked } : c,
		);
		setCriteria(next);
		try {
			await apiClient.updateProposal(proposal.id, {
				acceptanceCriteriaItems: next,
			});
			if (onSaved) await onSaved();
		} catch (err) {
			// rollback
			setCriteria(criteria);
			console.error("Failed to update criterion", err);
		}
	};

	const handleInlineMetaUpdate = async (updates: InlineMetaUpdatePayload) => {
		// Don't allow updates for cross-branch proposals
		if (isFromOtherBranch) return;

		// Optimistic UI
		if (updates.status !== undefined) setStatus(String(updates.status));
		if (updates.assignee !== undefined)
			setAssignee(updates.assignee as string[]);
		if (updates.labels !== undefined) setLabels(updates.labels as string[]);
		if (updates.priority !== undefined) setPriority(String(updates.priority));
		if (updates.dependencies !== undefined)
			setDependencies(updates.dependencies as string[]);
		if (updates.references !== undefined)
			setReferences(updates.references as string[]);
		if (updates.directive !== undefined)
			setDirective((updates.directive ?? "") as string);

		// Only update server if editing existing proposal
		if (proposal) {
			try {
				await apiClient.updateProposal(proposal.id, updates);
				if (onSaved) await onSaved();
			} catch (err) {
				console.error("Failed to update proposal metadata", err);
				// No rollback for simplicity; caller can refresh
			}
		}
	};

	// labels handled via ChipInput; no textarea parsing

	const handleComplete = useCallback(async () => {
		if (!proposal) return;
		if (
			!window.confirm(
				"Complete this proposal? It will be moved to the completed folder.",
			)
		)
			return;
		try {
			await apiClient.completeProposal(proposal.id);
			if (onSaved) await onSaved();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [onClose, onSaved, proposal]);

	const handleArchive = async () => {
		if (!proposal || !onArchive) return;
		if (
			!window.confirm(
				`Are you sure you want to archive "${proposal.title}"? This will move the proposal to the archive folder.`,
			)
		)
			return;
		onArchive();
		onClose();
	};

	const checkedCount = (criteria || []).filter((c) => c.checked).length;
	const totalCount = (criteria || []).length;
	const isReachedStatus = (status || "").toLowerCase().includes("complete");

	// Intercept Escape to cancel edit (not close modal) when in edit mode
	useEffect(() => {
		const keydownListenerOptions = { capture: true };
		const onKey = (e: KeyboardEvent) => {
			if (mode === "edit" && e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				handleCancelEdit();
			}
			if (
				mode === "edit" &&
				(e.metaKey || e.ctrlKey) &&
				e.key.toLowerCase() === "s"
			) {
				e.preventDefault();
				e.stopPropagation();
				void handleSave();
			}
			if (
				mode === "preview" &&
				e.key.toLowerCase() === "e" &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopPropagation();
				setMode("edit");
			}
			if (
				mode === "preview" &&
				isReachedStatus &&
				e.key.toLowerCase() === "c" &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopPropagation();
				void handleComplete();
			}
		};
		window.addEventListener("keydown", onKey, keydownListenerOptions);
		return () =>
			window.removeEventListener("keydown", onKey, keydownListenerOptions);
	}, [mode, handleCancelEdit, handleComplete, handleSave, isReachedStatus]);

	const displayId = proposal?.id ?? "";
	const documentation = proposal?.documentation ?? [];

	return (
		<Modal
			isOpen={isOpen}
			onClose={() => {
				// When in edit mode, confirm closing if dirty
				if (mode === "edit" && isDirty) {
					if (!window.confirm("Discard unsaved changes and close?")) return;
				}
				onClose();
			}}
			title={
				isCreateMode
					? isDraftMode
						? "Create New Draft"
						: "Create New Proposal"
					: `${displayId} — ${proposal.title}`
			}
			maxWidthClass="max-w-5xl"
			disableEscapeClose={mode === "edit" || mode === "create"}
			actions={
				<div className="flex items-center gap-2">
					{isReachedStatus &&
						mode === "preview" &&
						!isCreateMode &&
						!isFromOtherBranch && (
							<button
								type="button"
								onClick={handleComplete}
								className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-emerald-600 dark:bg-emerald-700 hover:bg-emerald-700 dark:hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:focus:ring-emerald-400 focus:ring-offset-2 dark:focus:ring-offset-gray-900 transition-colors duration-200"
								title="Move to completed folder (removes from board)"
							>
								Mark as completed
							</button>
						)}
					{mode === "preview" && !isCreateMode && !isFromOtherBranch ? (
						<button
							type="button"
							onClick={() => setMode("edit")}
							className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-offset-2 dark:focus:ring-offset-gray-900 transition-colors duration-200"
							title="Edit"
						>
							<svg
								className="w-4 h-4 mr-2"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								aria-hidden="true"
								focusable="false"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
								/>
							</svg>
							Edit
						</button>
					) : mode === "edit" || mode === "create" ? (
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={handleCancelEdit}
								className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-offset-2 dark:focus:ring-offset-gray-900 transition-colors duration-200"
								title="Cancel"
							>
								<svg
									className="w-4 h-4 mr-2"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => void handleSave()}
								disabled={saving}
								className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 dark:bg-blue-700 hover:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:ring-offset-2 dark:focus:ring-offset-gray-900 transition-colors duration-200 disabled:opacity-50"
								title="Save"
							>
								<svg
									className="w-4 h-4 mr-2"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									aria-hidden="true"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 13l4 4L19 7"
									/>
								</svg>
								{saving ? "Saving…" : isCreateMode ? "Create" : "Save"}
							</button>
						</div>
					) : null}
				</div>
			}
		>
			{error && (
				<div className="mb-3 text-sm text-red-600 dark:text-red-400">
					{error}
				</div>
			)}

			{/* Cross-branch proposal indicator */}
			{isFromOtherBranch && (
				<div className="mb-4 flex items-center gap-2 px-4 py-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg text-amber-800 dark:text-amber-200">
					<svg
						className="w-5 h-5 flex-shrink-0 text-amber-600 dark:text-amber-400"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
						focusable="false"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
						/>
					</svg>
					<div className="flex-1">
						<span className="font-medium">Read-only:</span> This proposal exists
						in the <span className="font-semibold">{proposal?.branch}</span>{" "}
						branch. Switch to that branch to edit it.
					</div>
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-3 gap-6">
				{/* Main content */}
				<div className="md:col-span-2 space-y-6">
					{/* Title field for create mode */}
					{isCreateMode && (
						<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
							<SectionHeader title="Title" />
							<input
								type="text"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="Enter proposal title"
								className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-transparent transition-colors duration-200"
							/>
						</div>
					)}
					{/* Description */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
						<SectionHeader title="Description" />
						{mode === "preview" ? (
							description ? (
								<div
									className="prose prose-sm !max-w-none wmde-markdown"
									data-color-mode={theme}
								>
									<MermaidMarkdown source={description} />
								</div>
							) : (
								<div className="text-sm text-gray-500 dark:text-gray-400">
									No description
								</div>
							)
						) : (
							<div className="border border-gray-200 dark:border-gray-700 rounded-md">
								<MDEditor
									value={description}
									onChange={(val) => setDescription(val || "")}
									preview="edit"
									height={320}
									data-color-mode={theme}
								/>
							</div>
						)}
					</div>

					{/* References */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
						<SectionHeader title="References" />
						<div className="space-y-3">
							{references.length > 0 ? (
								<ul className="space-y-2">
									{references.map((ref, idx) => (
										<li
											key={`reference:${ref}`}
											className="flex items-center gap-3 group"
										>
											<span className="flex-1 min-w-0">
												{ref.startsWith("http://") ||
												ref.startsWith("https://") ? (
													<a
														href={ref}
														target="_blank"
														rel="noopener noreferrer"
														className="text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
													>
														{ref}
													</a>
												) : (
													<code className="text-sm font-mono text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded break-all">
														{ref}
													</code>
												)}
											</span>
											{!isFromOtherBranch && (
												<button
													type="button"
													onClick={() => {
														const newRefs = references.filter(
															(_, i) => i !== idx,
														);
														handleInlineMetaUpdate({ references: newRefs });
													}}
													className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all flex-shrink-0"
													title="Remove reference"
												>
													<svg
														className="w-4 h-4"
														fill="none"
														stroke="currentColor"
														viewBox="0 0 24 24"
														aria-hidden="true"
														focusable="false"
													>
														<path
															strokeLinecap="round"
															strokeLinejoin="round"
															strokeWidth={2}
															d="M6 18L18 6M6 6l12 12"
														/>
													</svg>
												</button>
											)}
										</li>
									))}
								</ul>
							) : (
								<p className="text-sm text-gray-500 dark:text-gray-400">
									No references
								</p>
							)}
							{!isFromOtherBranch && (
								<form
									onSubmit={(e) => {
										e.preventDefault();
										const input = e.currentTarget.elements.namedItem(
											"newRef",
										) as HTMLInputElement;
										const value = input.value.trim();
										if (value && !references.includes(value)) {
											handleInlineMetaUpdate({
												references: [...references, value],
											});
											input.value = "";
										}
									}}
									className="flex gap-2"
								>
									<input
										name="newRef"
										type="text"
										placeholder="URL or file path..."
										className="flex-1 text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
									/>
									<button
										type="submit"
										className="px-4 py-2 text-sm font-medium bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
									>
										Add
									</button>
								</form>
							)}
						</div>
					</div>

					{/* Documentation */}
					{documentation.length > 0 && (
						<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
							<SectionHeader title="Documentation" />
							<div className="space-y-2">
								<ul className="space-y-2">
									{documentation.map((doc) => (
										<li
											key={`documentation:${doc}`}
											className="flex items-center gap-3"
										>
											<span className="flex-1 min-w-0">
												{doc.startsWith("http://") ||
												doc.startsWith("https://") ? (
													<a
														href={doc}
														target="_blank"
														rel="noopener noreferrer"
														className="text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
													>
														{doc}
													</a>
												) : (
													<code className="text-sm font-mono text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded break-all">
														{doc}
													</code>
												)}
											</span>
										</li>
									))}
								</ul>
							</div>
						</div>
					)}

					{/* Acceptance Criteria */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
						<SectionHeader
							title={`Acceptance Criteria ${totalCount ? `(${checkedCount}/${totalCount})` : ""}`}
							right={mode === "preview" ? <span>Toggle to update</span> : null}
						/>
						{mode === "preview" ? (
							<ul className="space-y-2">
								{(criteria || []).map((c) => (
									<li
										key={c.index}
										className="flex items-start gap-2 rounded-md px-2 py-1"
									>
										<input
											type="checkbox"
											checked={c.checked}
											onChange={(e) =>
												void handleToggleCriterion(c.index, e.target.checked)
											}
											className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
										/>
										<div className="text-sm text-gray-800 dark:text-gray-100">
											{c.text}
										</div>
									</li>
								))}
								{totalCount === 0 && (
									<li className="text-sm text-gray-500 dark:text-gray-400">
										No acceptance criteria
									</li>
								)}
							</ul>
						) : (
							<AcceptanceCriteriaEditor
								criteria={criteria}
								onChange={setCriteria}
							/>
						)}
					</div>

					{/* Implementation Plan */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
						<SectionHeader title="Implementation Plan" />
						{mode === "preview" ? (
							plan ? (
								<div
									className="prose prose-sm !max-w-none wmde-markdown"
									data-color-mode={theme}
								>
									<MermaidMarkdown source={plan} />
								</div>
							) : (
								<div className="text-sm text-gray-500 dark:text-gray-400">
									No plan
								</div>
							)
						) : (
							<div className="border border-gray-200 dark:border-gray-700 rounded-md">
								<MDEditor
									value={plan}
									onChange={(val) => setPlan(val || "")}
									preview="edit"
									height={280}
									data-color-mode={theme}
								/>
							</div>
						)}
					</div>

					{/* Implementation Notes */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
						<SectionHeader title="Implementation Notes" />
						{mode === "preview" ? (
							notes ? (
								<div
									className="prose prose-sm !max-w-none wmde-markdown"
									data-color-mode={theme}
								>
									<MermaidMarkdown source={notes} />
								</div>
							) : (
								<div className="text-sm text-gray-500 dark:text-gray-400">
									No notes
								</div>
							)
						) : (
							<div className="border border-gray-200 dark:border-gray-700 rounded-md">
								<MDEditor
									value={notes}
									onChange={(val) => setNotes(val || "")}
									preview="edit"
									height={280}
									data-color-mode={theme}
								/>
							</div>
						)}
					</div>

					{/* Final Summary */}
					{(mode !== "preview" || finalSummary.trim().length > 0) && (
						<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
							<SectionHeader title="Final Summary" right="Completion summary" />
							{mode === "preview" ? (
								<div
									className="prose prose-sm !max-w-none wmde-markdown"
									data-color-mode={theme}
								>
									<MermaidMarkdown source={finalSummary} />
								</div>
							) : (
								<div className="border border-gray-200 dark:border-gray-700 rounded-md">
									<MDEditor
										value={finalSummary}
										onChange={(val) => setFinalSummary(val || "")}
										preview="edit"
										height={220}
										data-color-mode={theme}
										textareaProps={{
											placeholder:
												"PR-style summary of what was implemented (write when proposal is complete)",
										}}
									/>
								</div>
							)}
						</div>
					)}
				</div>

				{/* Sidebar */}
				<div className="md:col-span-1 space-y-4">
					{/* Dates */}
					{proposal && (
						<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 text-xs text-gray-600 dark:text-gray-300 space-y-1">
							<div>
								<span className="font-semibold text-gray-800 dark:text-gray-100">
									Created:
								</span>{" "}
								<span className="text-gray-700 dark:text-gray-200">
									{formatStoredUtcDateForDisplay(proposal.createdDate)}
								</span>
							</div>
							{proposal.updatedDate && (
								<div>
									<span className="font-semibold text-gray-800 dark:text-gray-100">
										Updated:
									</span>{" "}
									<span className="text-gray-700 dark:text-gray-200">
										{formatStoredUtcDateForDisplay(proposal.updatedDate)}
									</span>
								</div>
							)}
						</div>
					)}
					{/* Title (editable for existing proposals) */}
					{proposal && (
						<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
							<SectionHeader title="Title" />
							<input
								type="text"
								value={title}
								onChange={(e) => {
									setTitle(e.target.value);
								}}
								onBlur={() => {
									if (title.trim() && title !== proposal.title) {
										void handleInlineMetaUpdate({ title: title.trim() });
									}
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.currentTarget.blur();
									}
								}}
								disabled={isFromOtherBranch}
								className={`w-full h-10 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-stone-500 dark:focus:ring-stone-400 focus:border-transparent transition-colors duration-200 ${isFromOtherBranch ? "opacity-60 cursor-not-allowed" : ""}`}
							/>
						</div>
					)}

					{/* Status */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
						<SectionHeader title="Status" />
						<StatusSelect
							current={status}
							onChange={(val) => handleInlineMetaUpdate({ status: val })}
							disabled={isFromOtherBranch}
						/>
					</div>

					{/* Assignee */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
						<SectionHeader title="Assignee" />
						<ChipInput
							name="assignee"
							label=""
							value={assignee}
							onChange={(value) => handleInlineMetaUpdate({ assignee: value })}
							placeholder="Type name and press Enter"
							disabled={isFromOtherBranch}
						/>
					</div>

					{/* Labels */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
						<SectionHeader title="Labels" />
						<ChipInput
							name="labels"
							label=""
							value={labels}
							onChange={(value) => handleInlineMetaUpdate({ labels: value })}
							placeholder="Type label and press Enter or comma"
							disabled={isFromOtherBranch}
						/>
					</div>

					{/* Priority */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
						<SectionHeader title="Priority" />
						<select
							className={`w-full h-10 px-3 pr-10 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-stone-500 dark:focus:ring-stone-400 focus:border-transparent transition-colors duration-200 ${isFromOtherBranch ? "opacity-60 cursor-not-allowed" : ""}`}
							value={priority}
							onChange={(e) => {
								const nextPriority = e.target.value;
								void handleInlineMetaUpdate({
									priority:
										nextPriority === ""
											? undefined
											: (nextPriority as Proposal["priority"]),
								});
							}}
							disabled={isFromOtherBranch}
						>
							<option value="">No Priority</option>
							<option value="low">Low</option>
							<option value="medium">Medium</option>
							<option value="high">High</option>
						</select>
					</div>

					{/* Directive */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
						<SectionHeader title="Directive" />
						<select
							className={`w-full h-10 px-3 pr-10 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-stone-500 dark:focus:ring-stone-400 focus:border-transparent transition-colors duration-200 ${isFromOtherBranch ? "opacity-60 cursor-not-allowed" : ""}`}
							value={directiveSelectionValue}
							onChange={(e) => {
								const value = e.target.value;
								setDirective(value);
								handleInlineMetaUpdate({
									directive: value.trim().length > 0 ? value : null,
								});
							}}
							disabled={isFromOtherBranch}
						>
							<option value="">No directive</option>
							{!hasDirectiveSelection && directiveSelectionValue ? (
								<option value={directiveSelectionValue}>
									{resolveDirectiveLabel(directiveSelectionValue)}
								</option>
							) : null}
							{(directiveEntities ?? []).map((m) => (
								<option key={m.id} value={m.id}>
									{m.title}
								</option>
							))}
						</select>
					</div>

					{/* Dependencies */}
					<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
						<SectionHeader title="Dependencies" />
						<DependencyInput
							value={dependencies}
							onChange={(value) =>
								handleInlineMetaUpdate({ dependencies: value })
							}
							availableProposals={availableProposals}
							currentProposalId={proposal?.id}
							label=""
							disabled={isFromOtherBranch}
						/>
					</div>

					{/* Archive button at bottom of sidebar */}
					{proposal && onArchive && !isFromOtherBranch && (
						<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
							<button
								type="button"
								onClick={handleArchive}
								className="w-full inline-flex items-center justify-center px-4 py-2 bg-red-500 dark:bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-600 dark:hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-gray-800 focus:ring-red-400 dark:focus:ring-red-500 transition-colors duration-200"
							>
								<svg
									className="w-4 h-4 mr-2"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									aria-hidden="true"
									focusable="false"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
									/>
								</svg>
								Archive Proposal
							</button>
						</div>
					)}
				</div>
			</div>
		</Modal>
	);
};

const StatusSelect: React.FC<{
	current: string;
	onChange: (v: string) => void;
	disabled?: boolean;
}> = ({ current, onChange, disabled }) => {
	const [statuses, setStatuses] = useState<string[]>([]);
	useEffect(() => {
		apiClient
			.fetchStatuses()
			.then(setStatuses)
			.catch(() =>
				setStatuses(["New", "Active", "Accepted", "Complete", "Abandoned"]),
			);
	}, []);
	return (
		<select
			className={`w-full h-10 px-3 pr-10 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-stone-500 dark:focus:ring-stone-400 focus:border-transparent transition-colors duration-200 ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
			value={current}
			onChange={(e) => onChange(e.target.value)}
			disabled={disabled}
		>
			{statuses.map((s) => (
				<option key={s} value={s}>
					{s}
				</option>
			))}
		</select>
	);
};

const _AutoResizeTextarea: React.FC<{
	value: string;
	onChange: (v: string) => void;
	onBlur?: () => void;
	placeholder?: string;
}> = ({ value, onChange, onBlur, placeholder }) => {
	const ref = React.useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		if (!ref.current) return;
		const el = ref.current;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, []);
	return (
		<textarea
			ref={ref}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onBlur={onBlur}
			rows={1}
			className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-stone-500 dark:focus:ring-stone-400 focus:border-transparent transition-colors duration-200 resize-none"
			placeholder={placeholder}
		/>
	);
};

export default ProposalDetailsModal;
