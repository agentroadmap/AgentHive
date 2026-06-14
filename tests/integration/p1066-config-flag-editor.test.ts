/**
 * P1066 — TUI Config Flag Editor: non-TTY unit/integration tests (AC-31).
 *
 * Covers the pure logic (query builders, filters, validation, diff, edit-state
 * machine, notify parsing, write-mode decision, formatting) AND a headless
 * panel drive (AC-13/AC-32 stub-test pattern) using a synthetic ctx — no
 * blessed screen, no live pg pool.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConfigKey } from "../../src/shared/runtime/config.ts";
import {
	advanceToDiff,
	buildAuditQuery,
	buildFallbackUpsert,
	buildFlagQuery,
	buildScopeCycle,
	buildValueDiff,
	decideWriteMode,
	findRowIndex,
	formatValuePreview,
	initialEditState,
	isWritable,
	LIFECYCLE_CYCLE,
	lifecycleCode,
	makeFallbackKey,
	nextInCycle,
	onEditInput,
	openEdit,
	parseFlagChangePayload,
	relativeTime,
	resolveConfigKey,
	resolveEditValue,
	truncate,
	validateFlagName,
	validateScope,
	writeModeBanner,
	type FlagRow,
} from "../../src/apps/tui/panels/config-editor-logic.ts";
import { createConfigEditorPanel } from "../../src/apps/tui/panels/config-editor.ts";
import type { PanelContext } from "../../src/apps/tui/types.ts";

// A small typed test registry standing in for AllConfigKeys.
const BOOL_FLAG: ConfigKey<boolean> = {
	name: "USE_OFFER_DISPATCH",
	class: "flag",
	required: false,
	parse: (v: string) => {
		try {
			return JSON.parse(v) === true;
		} catch {
			return v.toLowerCase() === "true";
		}
	},
};
const NUM_FLAG: ConfigKey<number> = {
	name: "MAX_INFLIGHT",
	class: "flag",
	required: false,
	parse: (v: string) => {
		const n = Number(v);
		if (!Number.isFinite(n)) throw new Error("not a number");
		return n;
	},
};
const TEST_REGISTRY: Record<string, ConfigKey<unknown>> = {
	USE_OFFER_DISPATCH: BOOL_FLAG,
	MAX_INFLIGHT: NUM_FLAG,
};

// ───────────────────────── AC-34: buildFlagQuery ───────────────────────────

describe("P1066 AC-34: buildFlagQuery", () => {
	it("no filters → no WHERE, ordered by updated_at DESC, LIMIT default", () => {
		const q = buildFlagQuery({
			scope: "all",
			lifecycle: "all",
			search: "",
		});
		assert.equal(q.params.length, 0);
		assert.match(q.text, /SELECT flag_name, scope, value_jsonb, lifecycle_status, updated_at/);
		assert.match(q.text, /FROM core\.runtime_flag/);
		assert.doesNotMatch(q.text, /WHERE/);
		assert.match(q.text, /ORDER BY updated_at DESC/);
		assert.match(q.text, /LIMIT 100/);
	});

	it("scope filter → parameterized scope = $1", () => {
		const q = buildFlagQuery({ scope: "host:bot", lifecycle: "all", search: "" });
		assert.deepEqual(q.params, ["host:bot"]);
		assert.match(q.text, /scope = \$1/);
	});

	it("lifecycle filter → parameterized lifecycle_status = $1", () => {
		const q = buildFlagQuery({ scope: "all", lifecycle: "deprecated", search: "" });
		assert.deepEqual(q.params, ["deprecated"]);
		assert.match(q.text, /lifecycle_status = \$1/);
	});

	it("search prefix → LIKE with escaped metachars + % suffix", () => {
		const q = buildFlagQuery({
			scope: "all",
			lifecycle: "all",
			search: "USE_OFF",
		});
		assert.equal(q.params.length, 1);
		// underscore is a LIKE wildcard; it must be escaped.
		assert.equal(q.params[0], "USE\\_OFF%");
		assert.match(q.text, /flag_name LIKE \$1/);
	});

	it("regex search → flag_name ~ $1, unescaped pattern", () => {
		const q = buildFlagQuery({
			scope: "all",
			lifecycle: "all",
			search: "^ORCH.*",
			searchIsRegex: true,
		});
		assert.deepEqual(q.params, ["^ORCH.*"]);
		assert.match(q.text, /flag_name ~ \$1/);
	});

	it("all three filters compose with sequential params", () => {
		const q = buildFlagQuery({
			scope: "global",
			lifecycle: "active",
			search: "ABC",
		});
		assert.deepEqual(q.params, ["global", "active", "ABC%"]);
		assert.match(q.text, /scope = \$1/);
		assert.match(q.text, /lifecycle_status = \$2/);
		assert.match(q.text, /flag_name LIKE \$3/);
	});

	it("limit is clamped to [1,1000]", () => {
		assert.match(buildFlagQuery({ scope: "all", lifecycle: "all", search: "", limit: 99999 }).text, /LIMIT 1000/);
		assert.match(buildFlagQuery({ scope: "all", lifecycle: "all", search: "", limit: 0 }).text, /LIMIT 1/);
	});
});

// ───────────────────────── AC-38: buildAuditQuery ──────────────────────────

describe("P1066 AC-38: buildAuditQuery", () => {
	it("uses key_name+scope params and LIMIT/OFFSET", () => {
		const q = buildAuditQuery("USE_OFFER_DISPATCH", "global", 50);
		assert.deepEqual(q.params, ["USE_OFFER_DISPATCH", "global"]);
		assert.match(q.text, /WHERE key_name = \$1 AND scope = \$2/);
		assert.match(q.text, /ORDER BY applied_at DESC/);
		assert.match(q.text, /LIMIT 50 OFFSET 50/);
		assert.match(q.text, /old_value_jsonb, new_value_jsonb/);
		assert.match(q.text, /caller_did, mutation_authority/);
	});

	it("negative offset clamps to 0", () => {
		assert.match(buildAuditQuery("X", "global", -5).text, /OFFSET 0/);
	});
});

// ───────────────────────── AC-36: fallback UPSERT ──────────────────────────

describe("P1066 AC-36: buildFallbackUpsert", () => {
	it("ON CONFLICT (flag_name) — live PK — and serialized JSON value", () => {
		const q = buildFallbackUpsert("MY_FLAG", "global", { a: 1 });
		assert.deepEqual(q.params, ["MY_FLAG", "global", JSON.stringify({ a: 1 })]);
		assert.match(q.text, /ON CONFLICT \(flag_name\) DO UPDATE/);
		assert.match(q.text, /\$3::jsonb/);
		assert.match(q.text, /lifecycle_status/);
	});
});

// ───────────────────────── AC-2/AC-19: scope cycle ─────────────────────────

describe("P1066 AC-19: scope filter cycle", () => {
	it("includes only available context entries", () => {
		const cycle = buildScopeCycle({
			host: "bot",
			agencyId: "a1",
			projectSlugs: ["georgia", "monkey"],
		});
		assert.deepEqual(cycle, [
			"all",
			"global",
			"host:bot",
			"agency:a1",
			"project:georgia",
			"project:monkey",
		]);
	});

	it("omits host/agency when absent", () => {
		assert.deepEqual(buildScopeCycle({}), ["all", "global"]);
	});

	it("nextInCycle wraps around", () => {
		const c = ["all", "global", "host:bot"];
		assert.equal(nextInCycle(c, "all"), "global");
		assert.equal(nextInCycle(c, "host:bot"), "all");
	});

	it("lifecycle cycle covers all states", () => {
		assert.deepEqual(LIFECYCLE_CYCLE, ["all", "active", "deprecated", "retired", "blocked"]);
		assert.equal(nextInCycle(LIFECYCLE_CYCLE, "blocked"), "all");
	});
});

// ───────────────────────── AC-14: ConfigKey resolution ─────────────────────

describe("P1066 AC-14: resolveConfigKey", () => {
	it("found path — returns registry key, isFallback=false", () => {
		const r = resolveConfigKey("USE_OFFER_DISPATCH", TEST_REGISTRY);
		assert.equal(r.isFallback, false);
		assert.equal(r.key.name, "USE_OFFER_DISPATCH");
		assert.equal(r.key.class, "flag");
	});

	it("fallback path — synthesizes a class='flag' key, isFallback=true", () => {
		const r = resolveConfigKey("UNKNOWN_FLAG_XYZ", TEST_REGISTRY);
		assert.equal(r.isFallback, true);
		assert.equal(r.key.name, "UNKNOWN_FLAG_XYZ");
		// AC-14(d): fallback key must be class 'flag' so set() accepts it.
		assert.equal(r.key.class, "flag");
	});

	it("fallback key parses JSON", () => {
		const k = makeFallbackKey("X");
		assert.deepEqual(k.parse('{"x":1}'), { x: 1 });
		assert.equal(k.parse("true"), true);
		assert.throws(() => k.parse("not json"));
	});
});

// ───────────────────────── AC-22/23/35: validation ─────────────────────────

describe("P1066 AC-22/35: resolveEditValue (registered)", () => {
	it("registered bool flag parses 'false'", () => {
		const r = resolveEditValue("USE_OFFER_DISPATCH", "false", TEST_REGISTRY);
		assert.equal(r.ok, true);
		assert.equal((r as { value: unknown }).value, false);
	});

	it("registered num flag rejects non-numbers with the parser's message", () => {
		const r = resolveEditValue("MAX_INFLIGHT", "abc", TEST_REGISTRY);
		assert.equal(r.ok, false);
		assert.match((r as { error: string }).error, /not a number/);
	});
});

describe("P1066 AC-23: resolveEditValue (unregistered fallback → JSON)", () => {
	it("unregistered flag accepts valid JSON", () => {
		const r = resolveEditValue("RANDOM_NEW_FLAG", '{"k":2}', TEST_REGISTRY);
		assert.equal(r.ok, true);
		assert.deepEqual((r as { value: unknown }).value, { k: 2 });
	});

	it("unregistered flag rejects invalid JSON", () => {
		const r = resolveEditValue("RANDOM_NEW_FLAG", "{bad}", TEST_REGISTRY);
		assert.equal(r.ok, false);
		assert.match((r as { error: string }).error, /not valid JSON/);
	});
});

// ───────────────────────── AC-25: new-row validation ───────────────────────

describe("P1066 AC-25: flag_name + scope validation", () => {
	it("accepts UPPER_SNAKE flag names", () => {
		assert.equal(validateFlagName("MY_FLAG_2").ok, true);
	});
	it("rejects lowercase / leading digit", () => {
		assert.equal(validateFlagName("myFlag").ok, false);
		assert.equal(validateFlagName("2FLAG").ok, false);
	});
	it("scope matches live CHECK", () => {
		assert.equal(validateScope("global").ok, true);
		assert.equal(validateScope("host:bot").ok, true);
		assert.equal(validateScope("agency:a1").ok, true);
		assert.equal(validateScope("project:georgia").ok, true);
		assert.equal(validateScope("host:").ok, false); // empty suffix
		assert.equal(validateScope("weird").ok, false);
	});
});

// ───────────────────────── AC-21/35: diff ──────────────────────────────────

describe("P1066 AC-21/35: buildValueDiff", () => {
	it("marks removed + added lines on a scalar change", () => {
		const d = buildValueDiff(true, false);
		assert.ok(d.some((l) => l.kind === "removed" && l.text.includes("true")));
		assert.ok(d.some((l) => l.kind === "added" && l.text.includes("false")));
	});
	it("unchanged values are all 'same'", () => {
		const d = buildValueDiff({ a: 1 }, { a: 1 });
		assert.ok(d.every((l) => l.kind === "same"));
	});
});

// ───────────────────────── edit-state machine ──────────────────────────────

describe("P1066: edit-state machine", () => {
	const row: FlagRow = {
		flag_name: "USE_OFFER_DISPATCH",
		scope: "global",
		value_jsonb: true,
		lifecycle_status: "active",
		updated_at: new Date(),
	};

	it("openEdit (writable) → editing, prefilled, registered key", () => {
		const s = openEdit(initialEditState(), row, {
			writable: true,
			registry: TEST_REGISTRY,
		});
		assert.equal(s.phase, "editing");
		assert.equal(s.isFallbackKey, false);
		assert.match(s.rawInput, /true/);
	});

	it("openEdit (read-only) → viewOnly, no prefill", () => {
		const s = openEdit(initialEditState(), row, {
			writable: false,
			registry: TEST_REGISTRY,
		});
		assert.equal(s.phase, "viewOnly");
		assert.equal(s.rawInput, "");
	});

	it("invalid input blocks advanceToDiff (stays editing)", () => {
		let s = openEdit(initialEditState(), { ...row, flag_name: "MAX_INFLIGHT" }, {
			writable: true,
			registry: TEST_REGISTRY,
		});
		s = onEditInput(s, "abc", TEST_REGISTRY);
		assert.equal(s.validation?.ok, false);
		const s2 = advanceToDiff(s, TEST_REGISTRY);
		assert.equal(s2.phase, "editing"); // blocked
	});

	it("valid input advances to diff", () => {
		let s = openEdit(initialEditState(), row, {
			writable: true,
			registry: TEST_REGISTRY,
		});
		s = onEditInput(s, "false", TEST_REGISTRY);
		const s2 = advanceToDiff(s, TEST_REGISTRY);
		assert.equal(s2.phase, "diff");
		assert.equal(s2.validation?.ok, true);
	});
});

// ───────────────────────── AC-37: notify parsing ───────────────────────────

describe("P1066 AC-37: parseFlagChangePayload", () => {
	it("parses the trigger payload shape", () => {
		const p = parseFlagChangePayload(
			JSON.stringify({ flag_name: "X", scope: "global", op: "UPDATE", at: "2026" }),
		);
		assert.deepEqual(p, { flag_name: "X", scope: "global", op: "UPDATE", at: "2026" });
	});
	it("returns null on malformed / missing fields", () => {
		assert.equal(parseFlagChangePayload(undefined), null);
		assert.equal(parseFlagChangePayload("{not json"), null);
		assert.equal(parseFlagChangePayload(JSON.stringify({ scope: "global" })), null);
	});
	it("findRowIndex matches BOTH flag_name and scope (AC-40)", () => {
		const rows: FlagRow[] = [
			{ flag_name: "A", scope: "global", value_jsonb: 1, lifecycle_status: "active", updated_at: new Date() },
			{ flag_name: "A", scope: "host:bot", value_jsonb: 2, lifecycle_status: "active", updated_at: new Date() },
		];
		assert.equal(findRowIndex(rows, { flag_name: "A", scope: "host:bot" }), 1);
		assert.equal(findRowIndex(rows, { flag_name: "A", scope: "agency:x" }), -1);
	});
});

// ───────────────────────── AC-15/26/27/30/36/41: write mode ─────────────────

describe("P1066 AC-15/26/27/30/36: decideWriteMode", () => {
	const base = {
		hasSetMethod: true,
		auditTablePresent: true,
		principalKind: "operator" as const,
		operatorDid: "did:op:1",
	};
	it("operator + set() + audit table → writable", () => {
		assert.equal(decideWriteMode(base), "writable");
		assert.equal(isWritable("writable"), true);
	});
	it("agent → readonly_authority (AC-26)", () => {
		assert.equal(
			decideWriteMode({ ...base, principalKind: "agent" }),
			"readonly_authority",
		);
	});
	it("no operator DID → readonly_no_identity (AC-30)", () => {
		assert.equal(
			decideWriteMode({ ...base, operatorDid: null }),
			"readonly_no_identity",
		);
	});
	it("forceReadOnly → writes_disabled (AC-15a)", () => {
		assert.equal(
			decideWriteMode({ ...base, forceReadOnly: true }),
			"writes_disabled_no_p828",
		);
	});
	it("audit table absent → fallback_no_audit (AC-36 degrade, not crash)", () => {
		const m = decideWriteMode({ ...base, auditTablePresent: false });
		assert.equal(m, "fallback_no_audit");
		assert.equal(isWritable(m), true);
		assert.match(writeModeBanner(m) ?? "", /no audit log/);
	});
	it("set() missing → fallback_no_audit", () => {
		assert.equal(
			decideWriteMode({ ...base, hasSetMethod: false }),
			"fallback_no_audit",
		);
	});
});

// ───────────────────────── formatting ──────────────────────────────────────

describe("P1066 AC-1/18: formatting", () => {
	it("truncate appends [...] past max", () => {
		assert.equal(truncate("abcdefghij", 6), "abc[...]");
		assert.equal(truncate("short", 10), "short");
	});
	it("value preview serializes + truncates", () => {
		assert.equal(formatValuePreview({ a: 1 }, 40), '{"a":1}');
		assert.equal(formatValuePreview("a".repeat(50), 16).endsWith("[...]"), true);
	});
	it("lifecycle code abbreviations", () => {
		assert.equal(lifecycleCode("active"), "AC");
		assert.equal(lifecycleCode("deprecated"), "DP");
		assert.equal(lifecycleCode("retired"), "RT");
		assert.equal(lifecycleCode("blocked"), "BK");
		assert.equal(lifecycleCode("weird"), "??");
	});
	it("relativeTime buckets", () => {
		const now = new Date("2026-06-14T12:00:00Z");
		assert.equal(relativeTime(new Date("2026-06-14T11:58:00Z"), now), "2m ago");
		assert.equal(relativeTime(new Date("2026-06-14T09:00:00Z"), now), "3h ago");
		assert.equal(relativeTime(new Date("2026-06-11T12:00:00Z"), now), "3d ago");
	});
});

// ───────────────────────── AC-13/AC-32: headless panel drive ────────────────

describe("P1066 AC-13/AC-32: panel conforms + headless live-reload", () => {
	// synthetic ShellQuery: serves the audit-existence guard + flag rows.
	function makeCtx(rows: FlagRow[], auditExists: boolean): {
		ctx: PanelContext;
		queries: { text: string; params: unknown[] }[];
	} {
		const queries: { text: string; params: unknown[] }[] = [];
		const ctx = {
			screen: {} as any,
			principal: {
				principal_id: "did:op:1",
				principal_kind: "operator" as const,
				parent_principal_id: null,
			},
			listen: { subscribe() {}, unsubscribe() {} },
			query: async <R = Record<string, unknown>>(text: string, params: unknown[] = []) => {
				queries.push({ text, params });
				if (text.includes("pg_tables")) {
					return { rows: (auditExists ? [{ present: 1 }] : []) as R[] };
				}
				// repaint single-row query (search + scope + limit 1)
				if (text.includes("LIMIT 1\n") || text.endsWith("LIMIT 1")) {
					const fname = params[params.length - 1];
					const fresh = rows.filter(
						(r) => r.flag_name === fname || `${escapeForLike(r.flag_name)}%` === fname,
					);
					return { rows: fresh as unknown as R[] };
				}
				return { rows: rows as unknown as R[] };
			},
			shell: { switchPanel() {}, render() {}, exit() {}, routes: () => ["flags"] },
			theme: {
				bg: "black", fg: "white", accent: "cyan", muted: "gray",
				success: "green", warning: "yellow", danger: "red",
				selectionBg: "blue", selectionFg: "white", border: "gray",
			},
		} as unknown as PanelContext;
		return { ctx, queries };
	}
	function escapeForLike(s: string): string {
		return s.replace(/([\\%_])/g, "\\$1");
	}

	it("exports route='flags', title, subscribes ONLY to runtime_flag_changed", () => {
		const p = createConfigEditorPanel();
		assert.equal(p.route, "flags");
		assert.equal(p.title, "Config Flags");
		const subs = p.subscriptions();
		assert.equal(subs.length, 1);
		assert.equal(subs[0].channel, "runtime_flag_changed");
		// keybinds cover the P1066-specific keys (AC-11/AC-28).
		const keys = new Set(p.keybinds().flatMap((k) => k.keys));
		for (const need of ["up", "down", "enter", "a", "n", "l", "/"]) {
			assert.ok(keys.has(need), `missing keybind ${need}`);
		}
	});

	it("onMount loads rows through ctx.query (no pool) + detects write mode", async () => {
		const seed: FlagRow[] = [
			{ flag_name: "USE_OFFER_DISPATCH", scope: "global", value_jsonb: true, lifecycle_status: "active", updated_at: new Date() },
		];
		const { ctx, queries } = makeCtx(seed, false); // audit table absent
		const p = createConfigEditorPanel({ operatorDid: "did:op:1" });
		await p.onMount(ctx);
		assert.equal(p.getRows().length, 1);
		// AC-36: no audit table → degraded write mode, still writable.
		assert.equal(p.getWriteMode(), "fallback_no_audit");
		// guard query ran.
		assert.ok(queries.some((q) => q.text.includes("pg_tables")));
		// browser query used the canonical column list.
		assert.ok(queries.some((q) => q.text.includes("value_jsonb, lifecycle_status, updated_at")));
	});

	it("AC-37 live-reload: dispatched notify repaints the matching row in place", async () => {
		const seed: FlagRow[] = [
			{ flag_name: "USE_OFFER_DISPATCH", scope: "global", value_jsonb: true, lifecycle_status: "active", updated_at: new Date("2026-06-14T10:00:00Z") },
		];
		const { ctx } = makeCtx(seed, true);
		const p = createConfigEditorPanel({ operatorDid: "did:op:1", configSet: async () => {} });
		await p.onMount(ctx);
		assert.equal(p.getRows()[0].value_jsonb, true);

		// external change: value flips to false.
		seed[0] = { ...seed[0], value_jsonb: false, updated_at: new Date("2026-06-14T11:00:00Z") };
		const handler = p.subscriptions()[0].handler;
		handler(JSON.stringify({ flag_name: "USE_OFFER_DISPATCH", scope: "global", op: "UPDATE", at: "x" }));
		// allow the async repaint to settle.
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(p.getRows()[0].value_jsonb, false, "row repainted with new value");
	});

	it("AC-7/AC-36 confirm: registered key commits via injected set()", async () => {
		const seed: FlagRow[] = [
			{ flag_name: "USE_OFFER_DISPATCH", scope: "global", value_jsonb: true, lifecycle_status: "active", updated_at: new Date() },
		];
		const { ctx } = makeCtx(seed, true);
		let setCall: { name: string; value: unknown } | null = null;
		const p = createConfigEditorPanel({
			registry: TEST_REGISTRY,
			operatorDid: "did:op:1",
			configSet: async (key, value) => {
				setCall = { name: key.name, value };
			},
		});
		await p.onMount(ctx);
		assert.equal(p.getWriteMode(), "writable");
		// open edit on the selected row, type 'false', advance, confirm.
		p.setSelected(0);
		(p as any).openEditPane();
		p.onInput("false");
		(p as any).saveToDiff();
		assert.equal(p.getEditState().phase, "diff");
		const res = await p.confirm();
		assert.equal(res.ok, true);
		assert.ok(setCall, "set() was called");
		assert.equal(setCall!.name, "USE_OFFER_DISPATCH");
		assert.equal(setCall!.value, false);
	});
});
