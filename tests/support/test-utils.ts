/**
 * Test utilities for creating isolated test environments
 * Designed to handle Windows-specific file system quirks and prevent parallel test interference
 */

import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// expect() shim — maps Jest/Bun assertion API to node:assert
// ---------------------------------------------------------------------------

const EXPECT_ANY_MARKER = Symbol("expectAny");

interface ExpectAnyMatcher {
	[EXPECT_ANY_MARKER]: true;
	constructor: Function;
}

function isExpectAny(v: unknown): v is ExpectAnyMatcher {
	return typeof v === "object" && v !== null && EXPECT_ANY_MARKER in v;
}

function argMatches(actual: unknown, expected: unknown): boolean {
	if (isExpectAny(expected)) return actual instanceof expected.constructor;
	try {
		assert.deepStrictEqual(actual, expected);
		return true;
	} catch {
		return false;
	}
}

type MockFn = {
	mock: { calls: { arguments: unknown[] }[]; callCount(): number };
};

interface Matchers {
	toBe(expected: unknown): void;
	toEqual(expected: unknown): void;
	toStrictEqual(expected: unknown): void;
	toBeTruthy(): void;
	toBeFalsy(): void;
	toBeNull(): void;
	toBeUndefined(): void;
	toBeDefined(): void;
	toContain(expected: unknown): void;
	toHaveLength(length: number): void;
	toBeGreaterThan(n: number): void;
	toBeGreaterThanOrEqual(n: number): void;
	toBeLessThan(n: number): void;
	toBeLessThanOrEqual(n: number): void;
	toMatch(pattern: RegExp | string): void;
	toStartWith(prefix: string): void;
	toBeInstanceOf(ctor: Function): void;
	toMatchObject(subset: Record<string, unknown>): void;
	toThrow(msgOrErr?: string | RegExp | Error): void;
	toHaveBeenCalled(): void;
	toHaveBeenCalledTimes(n: number): void;
	toHaveBeenCalledWith(...args: unknown[]): void;
	not: Matchers;
}

function makeMatchers(actual: unknown, negated: boolean): Matchers {
	const pass = (ok: boolean, msg: string) => {
		const should = negated ? !ok : ok;
		if (!should)
			throw new assert.AssertionError({
				message: negated ? `Expected NOT: ${msg}` : msg,
				actual,
				operator: "expect",
			});
	};

	const matchers: Matchers = {
		toBe(expected) {
			pass(
				Object.is(actual, expected),
				`Expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`,
			);
		},
		toEqual(expected) {
			if (negated) {
				let equal = true;
				try {
					assert.deepStrictEqual(actual, expected);
				} catch {
					equal = false;
				}
				if (equal)
					throw new assert.AssertionError({
						message: "Expected values NOT to be equal",
						actual,
						operator: "toEqual",
					});
			} else {
				assert.deepStrictEqual(actual, expected);
			}
		},
		toStrictEqual(expected) {
			matchers.toEqual(expected);
		},
		toBeTruthy() {
			pass(Boolean(actual), `Expected ${JSON.stringify(actual)} to be truthy`);
		},
		toBeFalsy() {
			pass(!actual, `Expected ${JSON.stringify(actual)} to be falsy`);
		},
		toBeNull() {
			pass(actual === null, `Expected ${JSON.stringify(actual)} to be null`);
		},
		toBeUndefined() {
			pass(
				actual === undefined,
				`Expected ${JSON.stringify(actual)} to be undefined`,
			);
		},
		toBeDefined() {
			pass(actual !== undefined, `Expected value to be defined`);
		},
		toContain(expected) {
			if (typeof actual === "string") {
				pass(
					(actual as string).includes(expected as string),
					`Expected string to contain ${JSON.stringify(expected)}`,
				);
			} else if (Array.isArray(actual)) {
				pass(
					(actual as unknown[]).includes(expected),
					`Expected array to contain ${JSON.stringify(expected)}`,
				);
			} else {
				throw new Error(
					`toContain requires a string or array, got ${typeof actual}`,
				);
			}
		},
		toHaveLength(length) {
			pass(
				(actual as { length: number }).length === length,
				`Expected length ${(actual as { length: number }).length} to equal ${length}`,
			);
		},
		toBeGreaterThan(n) {
			pass(
				(actual as number) > n,
				`Expected ${actual} to be greater than ${n}`,
			);
		},
		toBeGreaterThanOrEqual(n) {
			pass((actual as number) >= n, `Expected ${actual} to be >= ${n}`);
		},
		toBeLessThan(n) {
			pass((actual as number) < n, `Expected ${actual} to be less than ${n}`);
		},
		toBeLessThanOrEqual(n) {
			pass((actual as number) <= n, `Expected ${actual} to be <= ${n}`);
		},
		toMatch(pattern) {
			const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
			if (negated) {
				assert.doesNotMatch(actual as string, re);
			} else {
				assert.match(actual as string, re);
			}
		},
		toStartWith(prefix) {
			pass(
				(actual as string).startsWith(prefix),
				`Expected ${JSON.stringify(actual)} to start with ${JSON.stringify(prefix)}`,
			);
		},
		toBeInstanceOf(ctor) {
			pass(
				actual instanceof ctor,
				`Expected value to be instance of ${ctor.name}`,
			);
		},
		toMatchObject(subset) {
			if (negated) {
				let matches = true;
				try {
					for (const [k, v] of Object.entries(subset))
						assert.deepStrictEqual((actual as Record<string, unknown>)[k], v);
				} catch {
					matches = false;
				}
				if (matches)
					throw new assert.AssertionError({
						message: "Expected object NOT to match subset",
						actual,
						operator: "toMatchObject",
					});
			} else {
				for (const [k, v] of Object.entries(subset))
					assert.deepStrictEqual((actual as Record<string, unknown>)[k], v);
			}
		},
		toThrow(msgOrErr) {
			if (negated) {
				assert.doesNotThrow(actual as () => void);
			} else if (msgOrErr === undefined) {
				assert.throws(actual as () => void);
			} else if (msgOrErr instanceof RegExp) {
				assert.throws(actual as () => void, msgOrErr);
			} else if (typeof msgOrErr === "string") {
				assert.throws(actual as () => void, { message: msgOrErr });
			} else {
				assert.throws(actual as () => void, msgOrErr);
			}
		},
		toHaveBeenCalled() {
			const spy = actual as MockFn;
			const count = spy.mock?.callCount?.() ?? spy.mock?.calls?.length ?? 0;
			pass(count > 0, `Expected function to have been called`);
		},
		toHaveBeenCalledTimes(n) {
			const spy = actual as MockFn;
			const count = spy.mock?.callCount?.() ?? spy.mock?.calls?.length ?? 0;
			pass(
				count === n,
				`Expected function to have been called ${n} times, but was called ${count} times`,
			);
		},
		toHaveBeenCalledWith(...args) {
			const spy = actual as MockFn;
			const calls = spy.mock?.calls ?? [];
			const matched = calls.some(
				(call) =>
					call.arguments.length === args.length &&
					args.every((a, i) => argMatches(call.arguments[i], a)),
			);
			pass(
				matched,
				`Expected function to have been called with ${JSON.stringify(args)}`,
			);
		},
		get not(): Matchers {
			return makeMatchers(actual, !negated);
		},
	};

	return matchers;
}

interface AsyncMatchers {
	toThrow(msgOrErr?: string | RegExp | Error): Promise<void>;
	toBeUndefined(): Promise<void>;
	toBe(expected: unknown): Promise<void>;
	toEqual(expected: unknown): Promise<void>;
}

interface FullMatchers extends Matchers {
	rejects: AsyncMatchers;
	resolves: AsyncMatchers;
}

function makeAsyncRejectsMatchers(actual: unknown): AsyncMatchers {
	return {
		async toThrow(msgOrErr) {
			try {
				await (actual as Promise<unknown>);
				throw new assert.AssertionError({
					message: "Expected promise to reject but it resolved",
					operator: "expect",
				});
			} catch (err) {
				if (
					err instanceof assert.AssertionError &&
					err.message.includes("but it resolved")
				)
					throw err;
				if (msgOrErr !== undefined) {
					const errMsg = err instanceof Error ? err.message : String(err);
					if (typeof msgOrErr === "string") {
						assert.ok(
							errMsg.includes(msgOrErr),
							`Expected error "${errMsg}" to include "${msgOrErr}"`,
						);
					} else if (msgOrErr instanceof RegExp) {
						assert.ok(
							msgOrErr.test(errMsg),
							`Expected error "${errMsg}" to match ${msgOrErr}`,
						);
					}
				}
			}
		},
		async toBeUndefined() {
			const result = await (actual as Promise<unknown>);
			assert.strictEqual(
				result,
				undefined,
				`Expected resolved value to be undefined, got ${result}`,
			);
		},
		async toBe(expected) {
			const result = await (actual as Promise<unknown>);
			assert.ok(
				Object.is(result, expected),
				`Expected resolved ${JSON.stringify(result)} to be ${JSON.stringify(expected)}`,
			);
		},
		async toEqual(expected) {
			const result = await (actual as Promise<unknown>);
			assert.deepStrictEqual(result, expected);
		},
	};
}

function makeAsyncResolvesMatchers(actual: unknown): AsyncMatchers {
	return {
		async toThrow() {
			throw new assert.AssertionError({
				message: "resolves.toThrow() is not meaningful",
				operator: "expect",
			});
		},
		async toBeUndefined() {
			const result = await (actual as Promise<unknown>);
			assert.strictEqual(
				result,
				undefined,
				`Expected resolved value to be undefined, got ${result}`,
			);
		},
		async toBe(expected) {
			const result = await (actual as Promise<unknown>);
			assert.ok(
				Object.is(result, expected),
				`Expected resolved ${JSON.stringify(result)} to be ${JSON.stringify(expected)}`,
			);
		},
		async toEqual(expected) {
			const result = await (actual as Promise<unknown>);
			assert.deepStrictEqual(result, expected);
		},
	};
}

interface ExpectFn {
	(actual: unknown): FullMatchers;
	any(ctor: Function): ExpectAnyMatcher;
	arrayContaining(arr: unknown[]): unknown;
}

export const expect: ExpectFn = Object.assign(
	(actual: unknown): FullMatchers => {
		const matchers = makeMatchers(actual, false) as FullMatchers;
		matchers.rejects = makeAsyncRejectsMatchers(actual);
		matchers.resolves = makeAsyncResolvesMatchers(actual);
		return matchers;
	},
	{
		any: (ctor: Function): ExpectAnyMatcher => ({
			[EXPECT_ANY_MARKER]: true,
			constructor: ctor,
		}),
		arrayContaining: (arr: unknown[]): unknown => arr,
	},
);

import { spawnSync } from "node:child_process";

/**
 * A wrapper around node's spawnSync that captures both stdout and stderr
 * and returns an object mimicking Bun's $ result, but also supports toString() for backward compatibility.
 */
export function execSync(
	command: string,
	options: any = {},
): {
	stdout: string;
	stderr: string;
	combined: string;
	exitCode: number;
	text(): string;
	toString(): string;
} {
	const result = spawnSync("bash", ["-c", command], {
		...options,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	const stdout = result.stdout || "";
	const stderr = result.stderr || "";
	const combined = stdout + stderr;
	const exitCode = result.status ?? (result.error ? 1 : 0);

	return {
		stdout,
		stderr,
		combined,
		exitCode,
		text: () => stdout.trim(),
		toString: () => combined,
	};
}

/**
 * Shell-quotes a single argument for use in a bash -c command string.
 * Uses ANSI-C quoting ($'...') when the arg contains newlines or other
 * control characters; otherwise wraps in double quotes if it contains spaces.
 */
function shellQuoteArg(arg: string): string {
	const hasControlCharacters = Array.from(arg).some(
		(char) => char.charCodeAt(0) <= 0x1f,
	);
	if (hasControlCharacters) {
		return `$'${arg
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "\\'")
			.replace(/\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\t/g, "\\t")}'`;
	}
	if (/[ "']/.test(arg)) {
		return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return arg;
}

/**
 * Builds a properly shell-quoted argument list from an array.
 * Use in template literals in place of ${[CLI_PATH, "arg1", ...]} patterns.
 *
 * Example:
 *   execSync(`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", title])}`, opts)
 */
export function buildCliCommand(args: (string | undefined | null)[]): string {
	return args
		.filter((a): a is string => a !== null && a !== undefined)
		.map(shellQuoteArg)
		.join(" ");
}

/**
 * Creates a unique test directory name to avoid conflicts in parallel execution
 * All test directories are created under tmp/ to keep the root directory clean
 */
export function createUniqueTestDir(prefix: string): string {
	const uuid = randomUUID().slice(0, 8); // Short UUID for readability
	const timestamp = Date.now().toString(36); // Base36 timestamp
	const pid = process.pid.toString(36); // Process ID for additional uniqueness
	return join(process.cwd(), "tmp", `${prefix}-${timestamp}-${pid}-${uuid}`);
}

/**
 * Sleep utility for tests that need to wait
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry utility for operations that might fail intermittently
 * Particularly useful for Windows file operations
 */
export async function retry<T>(
	fn: () => Promise<T>,
	maxAttempts = 3,
	delay = 100,
): Promise<T> {
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;
			if (attempt < maxAttempts) {
				await sleep(delay * attempt); // Exponential backoff
			}
		}
	}

	throw lastError || new Error("Retry failed");
}

/**
 * Windows-safe directory cleanup with retry logic
 * Windows can have file locking issues that prevent immediate deletion
 */
export async function safeCleanup(dir: string): Promise<void> {
	await retry(
		async () => {
			await rm(dir, { recursive: true, force: true });
		},
		5,
		50,
	); // More attempts for cleanup
}

/**
 * Detects if we're running on Windows (useful for conditional test behavior)
 */
export function isWindows(): boolean {
	return process.platform === "win32";
}

/**
 * Gets appropriate timeout for the current platform
 * Windows operations tend to be slower due to file system overhead
 */
export function getPlatformTimeout(baseTimeout = 5000): number {
	return isWindows() ? baseTimeout * 2 : baseTimeout;
}

/**
 * Gets the exit code from a spawnSync result, handling Windows quirks
 * On Windows, result.status can be undefined even for successful processes
 */
export function getExitCode(result: {
	status: number | null;
	error?: Error;
}): number {
	return result.status ?? (result.error ? 1 : 0);
}
