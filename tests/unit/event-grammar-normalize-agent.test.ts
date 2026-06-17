/**
 * event-grammar normalizeAgent — display-name normalization shared by the
 * Discord state feed and the TUI board feed.
 *
 * Covers the two collapses that keep one logical actor spoken with one name:
 *  (a) worker spawn form "worker-N (model)@host" → "host/model"
 *  (b) agency-liaison suffix "<agency>.a" → "<agency>"  (operator identity model:
 *      claude-bot-gary is the agency, claude-bot-gary.a is its liaison)
 * and the non-collapses we must NOT break (hyphenated route identities, plain
 * agencies, empty input).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgent } from "../../src/core/feed/event-grammar.ts";

test("collapses the agency-liaison .a suffix to the agency", () => {
	assert.equal(normalizeAgent("claude-bot-gary.a"), "claude-bot-gary");
});

test("leaves a hyphenated route identity untouched (claude-bot-gary-a)", () => {
	assert.equal(normalizeAgent("claude-bot-gary-a"), "claude-bot-gary-a");
});

test("leaves a plain agency name untouched", () => {
	assert.equal(normalizeAgent("claude-bot-gary"), "claude-bot-gary");
});

test("collapses the worker spawn form to host/model", () => {
	assert.equal(normalizeAgent("worker-12 (claude)@bot"), "bot/claude");
});

test("empty/blank input falls back to 'agent'", () => {
	assert.equal(normalizeAgent(""), "agent");
	assert.equal(normalizeAgent("   "), "agent");
	assert.equal(normalizeAgent(null), "agent");
});

test("a worker form whose host ends in .a is not double-collapsed", () => {
	// worker form matches first and returns host/model; the .a rule never runs.
	assert.equal(normalizeAgent("worker-3 (sonnet)@host.a"), "host.a/sonnet");
});
