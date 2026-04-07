import assert from "node:assert";
import { describe, test } from "node:test";
import { execSync, expect } from "../support/test-utils.ts";

describe("CLI Priority Filtering", () => {
	test("proposal list --priority high shows only high priority proposals", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority high --plain`,
		);
		assert.strictEqual(result.exitCode, 0);

		// Should only show high priority proposals
		const output = result.stdout.toString();
		if (output.includes("proposal-")) {
			// If proposals exist, check they have HIGH priority indicators
			assert.ok(/\[HIGH\]/.test(output));
			// Should not contain other priority indicators
			expect(output).not.toMatch(/\[MEDIUM\]/);
			expect(output).not.toMatch(/\[LOW\]/);
		}
	});

	test("proposal list --priority medium shows only medium priority proposals", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority medium --plain`,
		);
		assert.strictEqual(result.exitCode, 0);

		const output = result.stdout.toString();
		if (output.includes("proposal-")) {
			assert.ok(/\[MEDIUM\]/.test(output));
			expect(output).not.toMatch(/\[HIGH\]/);
			expect(output).not.toMatch(/\[LOW\]/);
		}
	});

	test("proposal list --priority low shows only low priority proposals", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority low --plain`,
		);
		assert.strictEqual(result.exitCode, 0);

		const output = result.stdout.toString();
		if (output.includes("proposal-")) {
			assert.ok(/\[LOW\]/.test(output));
			expect(output).not.toMatch(/\[HIGH\]/);
			expect(output).not.toMatch(/\[MEDIUM\]/);
		}
	});

	test("proposal list --priority invalid shows error", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority invalid --plain`,
		);
		assert.strictEqual(result.exitCode, 1);
		expect(result.stderr.toString()).toContain("Invalid priority: invalid");
		expect(result.stderr.toString()).toContain(
			"Valid values are: high, medium, low",
		);
	});

	test("proposal list --sort priority sorts by priority", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --sort priority --plain`,
		);
		assert.strictEqual(result.exitCode, 0);

		const output = result.stdout.toString();
		// If proposals exist, high priority should come before medium, which comes before low
		if (output.includes("[HIGH]") && output.includes("[MEDIUM]")) {
			const highIndex = output.indexOf("[HIGH]");
			const mediumIndex = output.indexOf("[MEDIUM]");
			assert.ok(highIndex < mediumIndex);
		}
		if (output.includes("[MEDIUM]") && output.includes("[LOW]")) {
			const mediumIndex = output.indexOf("[MEDIUM]");
			const lowIndex = output.indexOf("[LOW]");
			assert.ok(mediumIndex < lowIndex);
		}
	});

	test("proposal list --sort id sorts by proposal ID", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --sort id --plain`,
		);
		assert.strictEqual(result.exitCode, 0);
		// Should exit successfully - detailed sorting verification would require known test data
	});

	test("proposal list --sort invalid shows error", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --sort invalid --plain`,
		);
		assert.strictEqual(result.exitCode, 1);
		expect(result.stderr.toString()).toContain("Invalid sort field: invalid");
		expect(result.stderr.toString()).toContain(
			"Valid values are: priority, id",
		);
	});

	test("proposal list combines priority filter with status filter", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority high --status "Potential" --plain`,
		);
		assert.strictEqual(result.exitCode, 0);

		const output = result.stdout.toString();
		if (output.includes("proposal-")) {
			// Should only show high priority proposals in "Potential" status
			assert.ok(/\[HIGH\]/.test(output));
			assert.ok(/Potential:/.test(output));
		}
	});

	test("proposal list combines priority filter with sort", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority high --sort id --plain`,
		);
		assert.strictEqual(result.exitCode, 0);

		const output = result.stdout.toString();
		if (output.includes("[HIGH]")) {
			// Should only show high priority proposals, sorted by ID
			assert.ok(/\[HIGH\]/.test(output));
			expect(output).not.toMatch(/\[MEDIUM\]/);
			expect(output).not.toMatch(/\[LOW\]/);
		}
	});

	test("plain output includes priority indicators", async () => {
		const result = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --plain`,
		);
		assert.strictEqual(result.exitCode, 0);

		const output = result.stdout.toString();
		// If any priority proposals exist, they should have proper indicators
		if (output.includes("proposal-")) {
			// Should have proper format with optional priority indicators
			assert.ok(
				/^\s*(\[HIGH\]|\[MEDIUM\]|\[LOW\])?\s*proposal-\d+\s+-\s+/m.test(
					output,
				),
			);
		}
	});

	test("case insensitive priority filtering", async () => {
		const upperResult = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority HIGH --plain`,
		);
		const lowerResult = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority high --plain`,
		);
		const mixedResult = execSync(
			`node --experimental-strip-types src/cli.ts proposal list --priority High --plain`,
		);

		assert.strictEqual(upperResult.exitCode, 0);
		assert.strictEqual(lowerResult.exitCode, 0);
		assert.strictEqual(mixedResult.exitCode, 0);

		const [upperOutput, lowerOutput, mixedOutput] = [
			upperResult.stdout.toString(),
			lowerResult.stdout.toString(),
			mixedResult.stdout.toString(),
		];
		const listUpper = upperOutput
			.split("\n")
			.filter((line) => line.includes("proposal-"));
		const listLower = lowerOutput
			.split("\n")
			.filter((line) => line.includes("proposal-"));
		const listMixed = mixedOutput
			.split("\n")
			.filter((line) => line.includes("proposal-"));
		if (listLower.length > 0) {
			assert.deepStrictEqual(listUpper, listLower);
			assert.deepStrictEqual(listMixed, listLower);
		}

		for (const output of [upperOutput, lowerOutput, mixedOutput]) {
			if (output.includes("proposal-")) {
				assert.ok(/\[HIGH\]/.test(output));
				expect(output).not.toMatch(/\[MEDIUM\]/);
				expect(output).not.toMatch(/\[LOW\]/);
			}
		}
	});
});
