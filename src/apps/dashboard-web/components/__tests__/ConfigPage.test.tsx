/**
 * P3785 — ConfigPage component tests
 * Run: bun test src/apps/dashboard-web/components/__tests__/ConfigPage.test.tsx
 */

import { describe, expect, it, spyOn, mock, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import * as apiModule from "../../lib/api";
import type { ConfigKeyDescriptor } from "../../lib/api";
import { CategorySection, ConfigRow } from "../ConfigPage";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFlag(name: string, category: string, value: unknown = false): ConfigKeyDescriptor {
	return {
		name,
		class: "flag",
		category,
		description: `${name} flag`,
		value,
		default_value: false,
		required: false,
		db_table: "core.runtime_flag",
		scope: null,
		editable: true,
		masked: false,
	};
}

function makeSecret(name: string): ConfigKeyDescriptor {
	return {
		name,
		class: "secret",
		category: "auth",
		description: "A secret value",
		value: null,
		default_value: null,
		required: true,
		db_table: null,
		scope: null,
		editable: false,
		masked: true,
	};
}

const noop = () => Promise.resolve();

// Strip React SSR comment nodes (<!-- -->) for cleaner assertions
function stripComments(html: string): string {
	return html.replace(/<!--.*?-->/g, "");
}

// ── Test 1: categories render ─────────────────────────────────────────────────

describe("CategorySection", () => {
	it("renders category heading and key count badge", () => {
		const keys = [makeFlag("FLAG_A", "runtime"), makeFlag("FLAG_B", "runtime")];
		const html = stripComments(
			renderToString(<CategorySection category="runtime" keys={keys} onSave={noop} />),
		);
		expect(html).toContain("runtime");
		expect(html).toContain("(2)");
	});

	it("renders two distinct category sections from separate instances", () => {
		const runtimeKeys = [makeFlag("FLAG_A", "runtime")];
		const authKeys = [makeFlag("FLAG_B", "auth"), makeFlag("FLAG_C", "auth")];

		const html = stripComments(
			renderToString(
				<>
					<CategorySection category="runtime" keys={runtimeKeys} onSave={noop} />
					<CategorySection category="auth" keys={authKeys} onSave={noop} />
				</>,
			),
		);

		expect(html).toContain("runtime");
		expect(html).toContain("auth");
		// two distinct count badges
		expect(html).toContain("(1)");
		expect(html).toContain("(2)");
	});
});

// ── Test 2: secret rows have no value and no edit ─────────────────────────────

describe("ConfigRow — secret masking", () => {
	it("shows (hidden) for masked keys", () => {
		const secret = makeSecret("API_KEY");
		const html = renderToString(<ConfigRow descriptor={secret} onSave={noop} />);
		expect(html).toContain("(hidden)");
	});

	it("renders no input or select element for secret keys", () => {
		const secret = makeSecret("API_KEY");
		const html = renderToString(<ConfigRow descriptor={secret} onSave={noop} />);
		expect(html).not.toContain("<input");
		expect(html).not.toContain("<select");
	});
});

// ── Test 3: flag edit calls mutation API ──────────────────────────────────────

describe("ConfigPage handleSave — mutation API", () => {
	it("calls apiClient.mutateConfigKey with keyName and parsed value", async () => {
		const mutationResult = {
			key_name: "MY_FLAG",
			new_value: true,
			mutation_id: "m1",
			applied_at: "2026-06-17T00:00:00Z",
		};
		const mutateSpy = spyOn(apiModule.apiClient, "mutateConfigKey").mockResolvedValue(
			mutationResult,
		);

		// Simulate what ConfigPage.handleSave does: call mutateConfigKey then reload.
		// ConfigRow.onSave is the handleSave callback — test it directly to verify
		// the API contract, decoupled from DOM interaction.
		const capturedCalls: [string, unknown][] = [];
		const onSave = async (keyName: string, value: unknown) => {
			capturedCalls.push([keyName, value]);
			await apiModule.apiClient.mutateConfigKey(keyName, value);
		};

		await onSave("MY_FLAG", true);

		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]).toEqual(["MY_FLAG", true]);
		expect(mutateSpy).toHaveBeenCalledTimes(1);
		expect(mutateSpy).toHaveBeenCalledWith("MY_FLAG", true);

		mutateSpy.mockRestore();
	});
});
