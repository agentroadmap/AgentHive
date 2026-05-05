import { describe, it, expect } from "bun:test";
import { sanitizeExtraEnv } from "../core/orchestration/spawn-env-sanitizer.ts";

describe("spawn-env-sanitizer", () => {
	it("AC-2: strips keys matching /_SECRET$/i pattern", () => {
		const input: Record<string, string> = {
			API_SECRET: "secret-value",
			MY_API_SECRET: "another-secret",
			SAFE_KEY: "safe-value",
		};
		const result = sanitizeExtraEnv(input);
		expect(result).not.toHaveProperty("API_SECRET");
		expect(result).not.toHaveProperty("MY_API_SECRET");
		expect(result).toHaveProperty("SAFE_KEY");
		expect(result.SAFE_KEY).toBe("safe-value");
	});

	it("AC-2: strips keys matching /_PASSWORD$/i pattern", () => {
		const input: Record<string, string> = {
			MY_PASSWORD: "password-value",
			DB_PASSWORD: "db-secret",
			SAFE_VAR: "safe-value",
		};
		const result = sanitizeExtraEnv(input);
		expect(result).not.toHaveProperty("MY_PASSWORD");
		expect(result).not.toHaveProperty("DB_PASSWORD");
		expect(result).toHaveProperty("SAFE_VAR");
		expect(result.SAFE_VAR).toBe("safe-value");
	});

	it("AC-2: case-insensitive pattern matching", () => {
		const input: Record<string, string> = {
			api_secret: "lowercase-secret",
			API_SECRET: "uppercase-secret",
			my_password: "mixed-case-password",
			SAFE_KEY: "safe-value",
		};
		const result = sanitizeExtraEnv(input);
		expect(result).not.toHaveProperty("api_secret");
		expect(result).not.toHaveProperty("API_SECRET");
		expect(result).not.toHaveProperty("my_password");
		expect(result).toHaveProperty("SAFE_KEY");
	});

	it("AC-2: combination test with mixed safe and dangerous keys", () => {
		const input: Record<string, string> = {
			MY_PASSWORD: "x",
			API_SECRET: "y",
			SAFE_KEY: "z",
			ANOTHER_SAFE: "value",
		};
		const result = sanitizeExtraEnv(input);
		expect(result).toEqual({
			SAFE_KEY: "z",
			ANOTHER_SAFE: "value",
		});
	});

	it("AC-2: empty extraEnv returns empty object", () => {
		const result = sanitizeExtraEnv({});
		expect(result).toEqual({});
	});

	it("AC-2: all safe keys are preserved", () => {
		const input: Record<string, string> = {
			DATABASE_URL: "postgres://...",
			NODE_ENV: "production",
			DEBUG: "true",
			CUSTOM_VAR: "custom-value",
		};
		const result = sanitizeExtraEnv(input);
		expect(result).toEqual(input);
	});
});
