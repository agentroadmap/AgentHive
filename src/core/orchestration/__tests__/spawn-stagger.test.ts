/**
 * Tests for spawn-stagger.ts (P1730 AC-4)
 *
 * Verifies that concurrent spawn requests are staggered correctly with:
 * - Zero delay for single spawns
 * - Increasing delay for sequential spawns (no herd blocking)
 * - Random jitter applied to break synchronization
 * - Clean reset between test ticks
 *
 * Uses Node.js built-in test runner.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	applySpawnStagger,
	getSpawnStaggerDiagnostics,
	_resetSpawnStaggerForTest,
} from "../spawn-stagger.ts";

test("spawn-stagger (P1730 AC-4)", async (t) => {
	await t.test("returns immediately for the first spawn (no herd)", async () => {
		_resetSpawnStaggerForTest();
		const start = Date.now();
		await applySpawnStagger();
		const elapsed = Date.now() - start;
		assert(elapsed < 50, `Expected <50ms, got ${elapsed}ms`);
	});

	await t.test(
		"returns immediately for the second spawn (herd just starting)",
		async () => {
			_resetSpawnStaggerForTest();
			// First spawn
			await applySpawnStagger();
			// Second spawn (no delay yet, herd size is still 1)
			const start = Date.now();
			await applySpawnStagger();
			const elapsed = Date.now() - start;
			// Should be nearly 0 (might have tiny fixed overhead, but no stagger)
			assert(elapsed < 100, `Expected <100ms, got ${elapsed}ms`);
		},
	);

	await t.test("applies configurable stagger delay for 3rd+ spawns", async () => {
		_resetSpawnStaggerForTest();
		const config = { staggerMs: 100, jitterMs: 0 };

		// Spawns 1-2: no delay
		await applySpawnStagger(config);
		await applySpawnStagger(config);

		// Spawn 3: should be delayed ~100ms (allow ±50ms margin)
		const start = Date.now();
		await applySpawnStagger(config);
		const elapsed = Date.now() - start;
		assert(
			elapsed >= 50 && elapsed < 150,
			`Expected 50-150ms, got ${elapsed}ms`,
		);

		// Spawn 4: should be delayed ~200ms (allow ±50ms margin)
		const start2 = Date.now();
		await applySpawnStagger(config);
		const elapsed2 = Date.now() - start2;
		assert(
			elapsed2 >= 150 && elapsed2 < 250,
			`Expected 150-250ms, got ${elapsed2}ms`,
		);
	});

	await t.test("applies jitter within the specified range", async () => {
		_resetSpawnStaggerForTest();
		const config = { staggerMs: 100, jitterMs: 100 };

		// Spawns 1-2: no delay
		await applySpawnStagger(config);
		await applySpawnStagger(config);

		// Spawn 3: should be ~100 + [0, 100]ms
		const start = Date.now();
		await applySpawnStagger(config);
		const elapsed = Date.now() - start;

		assert(
			elapsed >= 100 && elapsed < 200,
			`Expected 100-200ms, got ${elapsed}ms`,
		);
	});

	await t.test("respects environment variable overrides", async () => {
		_resetSpawnStaggerForTest();
		const originalStagger = process.env.AGENTHIVE_SPAWN_STAGGER_MS;
		const originalJitter = process.env.AGENTHIVE_SPAWN_JITTER_MS;

		try {
			process.env.AGENTHIVE_SPAWN_STAGGER_MS = "150";
			process.env.AGENTHIVE_SPAWN_JITTER_MS = "0";

			// Spawns 1-2: no delay
			await applySpawnStagger();
			await applySpawnStagger();

			// Spawn 3: should use env vars (150ms base stagger)
			const start = Date.now();
			await applySpawnStagger();
			const elapsed = Date.now() - start;

			assert(
				elapsed >= 150 && elapsed < 200,
				`Expected 150-200ms, got ${elapsed}ms`,
			);
		} finally {
			process.env.AGENTHIVE_SPAWN_STAGGER_MS = originalStagger;
			process.env.AGENTHIVE_SPAWN_JITTER_MS = originalJitter;
		}
	});

	await t.test("caps maximum delay at 30 seconds", async () => {
		_resetSpawnStaggerForTest();
		const config = { staggerMs: 8_000, jitterMs: 0 };

		// Force 5+ spawns to trigger cap: spawns 1-2 free, 3-4 scale, 5+ capped
		// Spawn 3: (3-2)*8000 = 8000, Spawn 4: (4-2)*8000 = 16000
		// Spawn 5: (5-2)*8000 = 24000, Spawn 6: (6-2)*8000 = 32000 → capped to 30000
		await applySpawnStagger(config);
		await applySpawnStagger(config);
		await applySpawnStagger(config);
		await applySpawnStagger(config);
		await applySpawnStagger(config);

		const start = Date.now();
		await applySpawnStagger(config); // spawn 6: (6-2)*8000 = 32000, capped to 30000
		const elapsed = Date.now() - start;

		assert(
			elapsed >= 30_000 && elapsed < 30_500,
			`Expected 30000-30500ms, got ${elapsed}ms (capped at 30s)`,
		);
	});

	await t.test("handles rapid sequential spawns in a loop", async () => {
		_resetSpawnStaggerForTest();
		const config = { staggerMs: 50, jitterMs: 0 };
		const delays: number[] = [];

		for (let i = 0; i < 5; i++) {
			const start = Date.now();
			await applySpawnStagger(config);
			delays.push(Date.now() - start);
		}

		// Expected: [<50, <50, 50-100, 100-150, 150-200] (approximately)
		assert(delays[0] < 50, `delays[0] should be <50ms, got ${delays[0]}ms`);
		assert(delays[1] < 50, `delays[1] should be <50ms, got ${delays[1]}ms`);
		assert(
			delays[2] >= 45 && delays[2] < 100,
			`delays[2] should be 45-100ms, got ${delays[2]}ms`,
		);
		assert(
			delays[3] >= 95 && delays[3] < 150,
			`delays[3] should be 95-150ms, got ${delays[3]}ms`,
		);
		assert(
			delays[4] >= 145 && delays[4] < 200,
			`delays[4] should be 145-200ms, got ${delays[4]}ms`,
		);
	});

	await t.test(
		"provides diagnostics for in-flight spawn count",
		async () => {
			_resetSpawnStaggerForTest();
			const config = { staggerMs: 50, jitterMs: 0 };

			// Call stagger 3 times
			await applySpawnStagger(config);
			await applySpawnStagger(config);
			await applySpawnStagger(config);

			const diag = getSpawnStaggerDiagnostics();
			assert(diag.inFlightCount === 3, `Expected 3 in-flight, got ${diag.inFlightCount}`);
			assert(typeof diag.generation === "number", "generation should be a number");
		},
	);
});
