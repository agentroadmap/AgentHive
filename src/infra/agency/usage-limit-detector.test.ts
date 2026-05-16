/**
 * Unit tests for usage-limit-detector. Pure functions, no DB/network.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
	detectUsageLimit,
	isLongWindow,
	parseClockTimeToFutureDate,
	resetSecondsForSignal,
	SHORT_WINDOW_SECONDS,
} from "./usage-limit-detector.ts";

// ── parseClockTimeToFutureDate ────────────────────────────────────────────────

test("parseClockTimeToFutureDate: '3:21 PM' returns next 15:21 in local TZ", () => {
	const now = new Date("2026-05-13T10:00:00");
	const res = parseClockTimeToFutureDate("3:21 PM", now);
	assert.ok(res);
	assert.equal(res!.getHours(), 15);
	assert.equal(res!.getMinutes(), 21);
});

test("parseClockTimeToFutureDate: time already passed today rolls to tomorrow", () => {
	const now = new Date("2026-05-13T16:00:00"); // 4:00 PM local
	const res = parseClockTimeToFutureDate("3:21 PM", now);
	assert.ok(res);
	assert.equal(res!.getDate(), now.getDate() + 1);
});

test("parseClockTimeToFutureDate: 24h '15:21' parses correctly", () => {
	const now = new Date("2026-05-13T10:00:00");
	const res = parseClockTimeToFutureDate("15:21", now);
	assert.ok(res);
	assert.equal(res!.getHours(), 15);
	assert.equal(res!.getMinutes(), 21);
});

test("parseClockTimeToFutureDate: returns null on unparseable input", () => {
	assert.equal(parseClockTimeToFutureDate("tomorrow", new Date()), null);
	assert.equal(parseClockTimeToFutureDate("", new Date()), null);
});

// ── detectUsageLimit: codex with timestamp ────────────────────────────────────

test("detectUsageLimit: codex limit with parseable reset time", () => {
	const stdout = `OpenAI Codex v0.130.0
--------
ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:21 PM.`;
	const sig = detectUsageLimit({
		stdout,
		defaultProvider: "openai",
		defaultModel: "gpt-5.4",
	});
	assert.ok(sig);
	assert.equal(sig!.provider, "openai");
	assert.equal(sig!.model, "gpt-5.4");
	assert.ok(sig!.resetAt instanceof Date);
	assert.match(sig!.reason, /codex_usage_limit.*3:21 PM/);
});

test("detectUsageLimit: codex limit without timestamp returns null resetAt", () => {
	const stdout = `ERROR: You've hit your usage limit. Upgrade to Pro to continue.`;
	const sig = detectUsageLimit({ stdout, defaultProvider: "openai" });
	assert.ok(sig);
	assert.equal(sig!.provider, "openai");
	assert.equal(sig!.resetAt, null);
});

// ── detectUsageLimit: anthropic ───────────────────────────────────────────────

test("detectUsageLimit: anthropic 'usage limit reached' phrasing", () => {
	const stderr = "Claude AI usage limit reached. Try again later.";
	const sig = detectUsageLimit({
		stderr,
		defaultProvider: "anthropic",
		defaultModel: "claude-sonnet-4-6",
	});
	assert.ok(sig);
	assert.equal(sig!.provider, "anthropic");
});

test("detectUsageLimit: anthropic 429 in error message", () => {
	const errorMessage = "Got 429 from claude API";
	const sig = detectUsageLimit({
		errorMessage,
		defaultProvider: "anthropic",
		defaultModel: "claude-sonnet-4-6",
	});
	assert.ok(sig);
	assert.equal(sig!.provider, "anthropic");
});

// ── detectUsageLimit: gemini ──────────────────────────────────────────────────

test("detectUsageLimit: gemini RESOURCE_EXHAUSTED", () => {
	const stderr = "RESOURCE_EXHAUSTED: Quota exceeded for gemini-2.0-flash";
	const sig = detectUsageLimit({
		stderr,
		defaultProvider: "google",
		defaultModel: "gemini-2.0-flash",
	});
	assert.ok(sig);
	assert.equal(sig!.provider, "google");
});

// ── detectUsageLimit: copilot ─────────────────────────────────────────────────

test("detectUsageLimit: copilot monthly allotment", () => {
	const stderr = "Copilot monthly limit hit. Upgrade plan.";
	const sig = detectUsageLimit({
		stderr,
		defaultProvider: "github",
	});
	assert.ok(sig);
	assert.equal(sig!.provider, "github");
});

// ── negative cases ────────────────────────────────────────────────────────────

test("detectUsageLimit: ordinary spawn output returns null", () => {
	const stdout = "OpenAI Codex v0.130.0\nResult: completed task successfully.";
	assert.equal(
		detectUsageLimit({ stdout, defaultProvider: "openai" }),
		null,
	);
});

test("detectUsageLimit: empty input returns null", () => {
	assert.equal(detectUsageLimit({ stdout: "", stderr: "" }), null);
});

// ── window classification ─────────────────────────────────────────────────────

test("isLongWindow: 90-min reset = short window", () => {
	const now = new Date("2026-05-14T01:00:00Z");
	const sig = {
		provider: "openai" as const,
		model: "gpt-5.4",
		resetAt: new Date("2026-05-14T02:30:00Z"),
		reason: "test",
		matchedLine: "test",
	};
	assert.equal(isLongWindow(sig, now), false);
});

test("isLongWindow: 6-hour reset = long window", () => {
	const now = new Date("2026-05-14T01:00:00Z");
	const sig = {
		provider: "openai" as const,
		model: "gpt-5.4",
		resetAt: new Date("2026-05-14T07:00:00Z"),
		reason: "test",
		matchedLine: "test",
	};
	assert.equal(isLongWindow(sig, now), true);
});

test("isLongWindow: null resetAt = long window (unknown fallback)", () => {
	const sig = {
		provider: "openai" as const,
		model: "gpt-5.4",
		resetAt: null,
		reason: "test",
		matchedLine: "test",
	};
	assert.equal(isLongWindow(sig), true);
});

test("resetSecondsForSignal: bounded by SHORT_WINDOW for short windows", () => {
	const now = new Date("2026-05-14T01:00:00Z");
	const sig = {
		provider: "openai" as const,
		model: "gpt-5.4",
		resetAt: new Date("2026-05-14T02:00:00Z"),
		reason: "test",
		matchedLine: "test",
	};
	const sec = resetSecondsForSignal(sig, now);
	assert.ok(sec > 0 && sec <= SHORT_WINDOW_SECONDS);
});
