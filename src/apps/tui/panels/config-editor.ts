/**
 * P1066 — TUI Config Flag Editor: the TuiPanel.
 *
 * Thin blessed wiring over the pure logic in `config-editor-logic.ts`. The
 * P1067 shell's loadPanels() imports THIS path. Conformance to the P1067
 * `TuiPanel` contract (route/title/keybinds/subscriptions/render/lifecycle) is
 * the AC-13/AC-32 integration requirement.
 *
 * HARD INVARIANTS (AC-13/AC-32/AC-37):
 *   - never open a pg connection: all reads go through ctx.query.
 *   - never open a LISTEN client: subscribe to 'runtime_flag_changed' through
 *     ctx.listen (the shell owns the single LISTEN client, P1067 AC-3/AC-16).
 *   - never read agentContextStorage at module load: identity arrives as
 *     ctx.principal.
 *   - colours come from ctx.theme only (no inline fg:/bg: literals).
 */

import { box } from "../../ui/blessed.ts";
import type { ConfigKey } from "../../../shared/runtime/config.ts";
import type {
	PanelContext,
	PanelKeybind,
	PanelNode,
	PanelSubscription,
	TuiPanel,
} from "../types.ts";
import {
	type EditState,
	type FlagFilters,
	type FlagRow,
	type WriteMode,
	advanceToDiff,
	AUDIT_TABLE_EXISTS_SQL,
	backToEdit,
	buildAuditQuery,
	buildFallbackUpsert,
	buildFlagQuery,
	buildScopeCycle,
	buildValueDiff,
	cancelEdit,
	DEFAULT_FILTERS,
	decideWriteMode,
	findRowIndex,
	formatValuePreview,
	initialEditState,
	isWritable,
	LIFECYCLE_CYCLE,
	lifecycleCode,
	nextInCycle,
	onEditInput,
	openEdit,
	parseFlagChangePayload,
	prettyJson,
	relativeTime,
	resolveConfigKey,
	truncate,
	writeModeBanner,
} from "./config-editor-logic.ts";

/**
 * Optional injection seam so headless tests (AC-13 stub-test, AC-31) can drive
 * the panel without a blessed screen or the live AllConfigKeys registry.
 */
export interface ConfigEditorOptions {
	/** Override config-key registry (defaults to live AllConfigKeys via logic). */
	registry?: Record<string, ConfigKey<unknown>>;
	/** Scope-cycle context (host / agency / project slugs). */
	scopeContext?: { host?: string; agencyId?: string; projectSlugs?: string[] };
	/** P828 set() callable; when omitted the panel uses the degraded UPSERT. */
	configSet?: (key: ConfigKey<unknown>, value: unknown) => Promise<void>;
	/** Force read-only (AC-15(a)). */
	forceReadOnly?: boolean;
	/** Operator DID resolved at startup (AC-30); null → read-only-no-identity. */
	operatorDid?: string | null;
}

/**
 * The panel object. A factory so per-instance state (rows, selection, edit
 * state) is isolated and the AC-13/AC-32 stub-test can mount a fresh instance.
 */
export function createConfigEditorPanel(
	opts: ConfigEditorOptions = {},
): ConfigEditorPanel {
	return new ConfigEditorPanel(opts);
}

export class ConfigEditorPanel implements TuiPanel {
	readonly route = "flags";
	readonly title = "Config Flags";

	// ── live state (per instance) ──
	private rows: FlagRow[] = [];
	private selected = 0;
	private filters: FlagFilters = { ...DEFAULT_FILTERS };
	private edit: EditState = initialEditState();
	private writeMode: WriteMode = "writes_disabled_no_p828";
	private auditTablePresent = false;
	private node: PanelNode | null = null;
	private ctx: PanelContext | null = null;
	private readonly opts: ConfigEditorOptions;
	private readonly boundHandler: (p: string | undefined) => void;

	constructor(opts: ConfigEditorOptions) {
		this.opts = opts;
		this.boundHandler = (p) => this.onFlagChanged(p);
	}

	// ───────────────────────── TuiPanel contract ──────────────────────────

	/** Subscribe ONLY to runtime_flag_changed (AC-32/AC-37). */
	subscriptions(): PanelSubscription[] {
		return [
			{ channel: "runtime_flag_changed", handler: this.boundHandler },
		];
	}

	/** P1066-specific keys; Q/Esc/?/Ctrl-N are shell-owned (AC-32). */
	keybinds(): PanelKeybind[] {
		return [
			{ keys: ["up"], description: "prev row", handler: () => this.move(-1) },
			{ keys: ["down"], description: "next row", handler: () => this.move(1) },
			{
				keys: ["pageup"],
				description: "page up",
				handler: () => this.move(-10),
			},
			{
				keys: ["pagedown"],
				description: "page down",
				handler: () => this.move(10),
			},
			{ keys: ["enter"], description: "edit", handler: () => this.openEditPane() },
			{ keys: ["a"], description: "audit", handler: () => this.openAuditPane() },
			{ keys: ["n"], description: "new flag", handler: () => this.openNewPane() },
			{
				keys: ["f", "tab"],
				description: "scope filter",
				handler: () => this.cycleScope(),
			},
			{ keys: ["l"], description: "lifecycle", handler: () => this.cycleLifecycle() },
			{ keys: ["/"], description: "search", handler: () => this.openSearch() },
			{ keys: ["r"], description: "refresh", handler: () => void this.refresh() },
			{
				keys: ["C-s"],
				description: "save → diff",
				handler: () => this.saveToDiff(),
			},
			{ keys: ["y"], description: "confirm", handler: () => void this.confirm() },
		];
	}

	async onMount(ctx: PanelContext): Promise<void> {
		this.ctx = ctx;
		await this.detectWriteMode(ctx);
		await this.refresh();
	}

	onActivate(ctx: PanelContext): void {
		this.ctx = ctx;
	}

	onDeactivate(): void {
		// edit-in-progress survives deactivation; nothing to tear down here —
		// the shell owns keybind + subscription teardown.
	}

	isDirty(): boolean {
		return this.edit.phase === "editing" || this.edit.phase === "diff";
	}

	render(ctx: PanelContext): PanelNode {
		this.ctx = ctx;
		if (!this.node) {
			this.node = box({
				parent: ctx.screen,
				top: 0,
				left: 0,
				width: "100%",
				height: "100%-1",
				tags: true,
				style: { fg: ctx.theme.fg, bg: ctx.theme.bg },
			});
		}
		(this.node as { setContent?: (s: string) => void }).setContent?.(
			this.renderContent(ctx),
		);
		return this.node;
	}

	// ───────────────────────── startup helpers ────────────────────────────

	private async detectWriteMode(ctx: PanelContext): Promise<void> {
		// AC-10/AC-27 guard: does the audit table exist?
		try {
			const res = await ctx.query<{ present: number }>(AUDIT_TABLE_EXISTS_SQL);
			this.auditTablePresent = res.rows.length > 0;
		} catch {
			this.auditTablePresent = false;
		}
		const operatorDid =
			this.opts.operatorDid !== undefined
				? this.opts.operatorDid
				: ctx.principal.principal_id; // shell-resolved identity (AC-30 path A)
		this.writeMode = decideWriteMode({
			hasSetMethod: typeof this.opts.configSet === "function",
			auditTablePresent: this.auditTablePresent,
			principalKind: ctx.principal.principal_kind,
			operatorDid,
			forceReadOnly: this.opts.forceReadOnly,
		});
	}

	/** AC-34: (re)load rows through ctx.query — never a panel-level pool. */
	async refresh(): Promise<void> {
		if (!this.ctx) return;
		const { text, params } = buildFlagQuery(this.filters);
		const res = await this.ctx.query<FlagRow>(text, params);
		this.rows = res.rows;
		if (this.selected >= this.rows.length) {
			this.selected = Math.max(0, this.rows.length - 1);
		}
		this.requestRender();
	}

	// ───────────────────────── navigation (AC-11/AC-28) ───────────────────

	private move(delta: number): void {
		if (this.edit.phase !== "browsing") return;
		if (this.rows.length === 0) return;
		this.selected = Math.min(
			this.rows.length - 1,
			Math.max(0, this.selected + delta),
		);
		this.requestRender();
	}

	private cycleScope(): void {
		if (this.edit.phase !== "browsing") return;
		const cycle = buildScopeCycle(this.opts.scopeContext ?? {});
		this.filters = {
			...this.filters,
			scope: nextInCycle(cycle, this.filters.scope),
		};
		void this.refresh();
	}

	private cycleLifecycle(): void {
		if (this.edit.phase !== "browsing") return;
		this.filters = {
			...this.filters,
			lifecycle: nextInCycle(LIFECYCLE_CYCLE, this.filters.lifecycle),
		};
		void this.refresh();
	}

	private openSearch(): void {
		// blessed prompt wiring is shell-mediated; the search string is applied
		// via applySearch(). Kept as a seam so the logic stays testable.
	}

	/** Apply a search term (called by the shell's prompt callback). */
	applySearch(term: string): void {
		this.filters = { ...this.filters, search: term };
		void this.refresh();
	}

	// ───────────────────────── edit flow (AC-21/22/23/35) ─────────────────

	private currentRow(): FlagRow | null {
		return this.rows[this.selected] ?? null;
	}

	private openEditPane(): void {
		const row = this.currentRow();
		if (!row) return;
		this.edit = openEdit(this.edit, row, {
			writable: isWritable(this.writeMode),
			registry: this.opts.registry,
		});
		this.requestRender();
	}

	/** Driven by the textbox 'keypress' handler in the shell. */
	onInput(raw: string): void {
		this.edit = onEditInput(this.edit, raw, this.opts.registry);
		this.requestRender();
	}

	private saveToDiff(): void {
		if (this.edit.phase !== "editing") return;
		this.edit = advanceToDiff(this.edit, this.opts.registry);
		this.requestRender();
	}

	/** Esc / N from any sub-pane → browsing. */
	closePane(): void {
		this.edit = cancelEdit(this.edit);
		this.requestRender();
	}

	/** E from the diff pane → back to the textbox. */
	editAgain(): void {
		this.edit = backToEdit(this.edit);
		this.requestRender();
	}

	/**
	 * Y confirmation (AC-7/AC-22/AC-36/AC-39). Writes via P828 set() when
	 * available (audited); otherwise a direct scoped UPSERT (no audit). The
	 * authority decision is SERVER-SIDE (set()); on the fallback path the panel
	 * has already gated on writeMode.
	 */
	async confirm(): Promise<{ ok: boolean; error?: string }> {
		if (this.edit.phase !== "diff" || !this.edit.row) {
			return { ok: false, error: "no pending edit" };
		}
		const row = this.edit.row;
		const validation = this.edit.validation;
		if (!validation || !validation.ok) {
			return { ok: false, error: "value invalid" };
		}
		const { key } = resolveConfigKey(row.flag_name, this.opts.registry);
		try {
			if (this.writeMode === "writable" && this.opts.configSet) {
				// AC-7/AC-39: audited path — server enforces authority.
				await this.opts.configSet(key, validation.value);
			} else if (this.writeMode === "fallback_no_audit") {
				// AC-36/AC-23: degraded direct UPSERT, no audit row.
				const { text, params } = buildFallbackUpsert(
					row.flag_name,
					row.scope,
					validation.value,
				);
				if (!this.ctx) return { ok: false, error: "no context" };
				await this.ctx.query(text, params);
			} else {
				return { ok: false, error: writeModeBanner(this.writeMode) ?? "writes disabled" };
			}
		} catch (err) {
			// RuntimeConfigMutationForbidden etc. surface inline (AC-7/AC-22).
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		// success: close; the LISTEN repaint (AC-37) refreshes the row.
		this.edit = cancelEdit(this.edit);
		this.requestRender();
		return { ok: true };
	}

	// ───────────────────────── audit (AC-24/AC-38) ────────────────────────

	private openAuditPane(): void {
		const row = this.currentRow();
		if (!row) return;
		this.edit = { ...this.edit, phase: "audit", row };
		this.requestRender();
	}

	/** AC-24/AC-38: returns audit rows, or null when the table is absent. */
	async loadAudit(offset = 0): Promise<Record<string, unknown>[] | null> {
		if (!this.auditTablePresent) return null;
		const row = this.edit.row;
		if (!this.ctx || !row) return null;
		const { text, params } = buildAuditQuery(row.flag_name, row.scope, offset);
		const res = await this.ctx.query<Record<string, unknown>>(text, params);
		return res.rows;
	}

	// ───────────────────────── new row (AC-25) ────────────────────────────

	private openNewPane(): void {
		if (!isWritable(this.writeMode)) return;
		this.edit = {
			...initialEditState(),
			phase: "editing",
			row: { flag_name: "", scope: "global", value_jsonb: null, lifecycle_status: "active", updated_at: new Date() },
		};
		this.requestRender();
	}

	// ───────────────────────── live reload (AC-37) ────────────────────────

	private onFlagChanged(payload: string | undefined): void {
		const change = parseFlagChangePayload(payload);
		if (!change) return; // malformed → no-op (AC-37 robustness)
		const idx = findRowIndex(this.rows, change);
		if (idx < 0) {
			// row not in current page (e.g. external INSERT) — a light refresh
			// surfaces it without a full reload storm.
			void this.refresh();
			return;
		}
		// patch just the affected row in place (AC-37 "without a full repaint").
		void this.repaintRow(idx, change);
	}

	private async repaintRow(idx: number, change: { flag_name: string; scope: string }): Promise<void> {
		if (!this.ctx) return;
		const { text, params } = buildFlagQuery({
			...DEFAULT_FILTERS,
			scope: change.scope,
			search: change.flag_name,
			searchIsRegex: false,
			limit: 1,
		});
		const res = await this.ctx.query<FlagRow>(text, params);
		const fresh = res.rows.find(
			(r) => r.flag_name === change.flag_name && r.scope === change.scope,
		);
		if (fresh) {
			this.rows[idx] = fresh;
			this.requestRender();
		}
	}

	// ───────────────────────── rendering (AC-1/18/34) ─────────────────────

	private renderContent(ctx: PanelContext): string {
		const banner = writeModeBanner(this.writeMode);
		const header =
			`{bold}Config Flags{/bold}  ` +
			`scope=${this.filters.scope}  life=${this.filters.lifecycle}` +
			(this.filters.search ? `  /${this.filters.search}` : "") +
			(banner ? `\n${banner}` : "");

		const lines: string[] = [header, ""];
		this.rows.forEach((r, i) => {
			const marker = i === this.selected ? ">" : " ";
			lines.push(
				`${marker} ${truncate(r.flag_name, 30).padEnd(30)} ` +
					`${truncate(r.scope, 20).padEnd(20)} ` +
					`${formatValuePreview(r.value_jsonb, 16).padEnd(16)} ` +
					`${lifecycleCode(r.lifecycle_status)} ` +
					`${relativeTime(r.updated_at)}`,
			);
		});

		if (this.edit.phase === "editing" || this.edit.phase === "diff") {
			lines.push("", `── ${this.edit.phase === "diff" ? "DIFF" : "EDIT"} ──`);
			if (this.edit.row) {
				lines.push(`flag: ${this.edit.row.flag_name}  scope: ${this.edit.row.scope}`);
				if (this.edit.isFallbackKey) {
					lines.push("[Unregistered key — raw JSONB write; no schema check]");
				}
				if (this.edit.phase === "diff") {
					for (const dl of buildValueDiff(this.edit.row.value_jsonb, this.edit.validation?.ok ? this.edit.validation.value : this.edit.rawInput)) {
						const sigil = dl.kind === "added" ? "+" : dl.kind === "removed" ? "-" : " ";
						lines.push(`${sigil} ${dl.text}`);
					}
					lines.push("[Y]es commit / [N]o cancel / [E]dit again");
				} else {
					lines.push(`new: ${this.edit.rawInput}`);
					if (this.edit.validation && !this.edit.validation.ok) {
						lines.push(`! ${this.edit.validation.error}`);
					}
				}
			}
		} else if (this.edit.phase === "viewOnly" && this.edit.row) {
			lines.push("", "── VIEW (read-only) ──");
			lines.push(`flag: ${this.edit.row.flag_name}  scope: ${this.edit.row.scope}`);
			lines.push(prettyJson(this.edit.row.value_jsonb));
			lines.push(banner ?? "[read-only]");
		} else if (this.edit.phase === "audit") {
			lines.push("", "── AUDIT ──");
			if (!this.auditTablePresent) {
				lines.push("[P828 not deployed — audit log unavailable]");
			}
		}
		return lines.join("\n");
	}

	private requestRender(): void {
		if (this.ctx && this.node) {
			(this.node as { setContent?: (s: string) => void }).setContent?.(
				this.renderContent(this.ctx),
			);
			this.ctx.shell.render();
		}
	}

	// ── test/inspection accessors (no TTY) ──
	getRows(): FlagRow[] {
		return this.rows;
	}
	getEditState(): EditState {
		return this.edit;
	}
	getWriteMode(): WriteMode {
		return this.writeMode;
	}
	getFilters(): FlagFilters {
		return this.filters;
	}
	setSelected(i: number): void {
		this.selected = Math.min(Math.max(0, i), Math.max(0, this.rows.length - 1));
	}
}

/**
 * The named export the P1067 shell loadPanels() imports. A singleton default
 * instance with no injected options (live registry, no test seams).
 */
export const configEditorPanel: TuiPanel = createConfigEditorPanel();

export default configEditorPanel;
