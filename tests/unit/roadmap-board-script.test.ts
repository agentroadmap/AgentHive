import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getMaturityIcon, loadBoardEnv } from "../../scripts/roadmap-board.ts";

const TEMP_ENV_KEY = "BOARD_SCRIPT_TEST_ENV";
const tempDirs: string[] = [];

afterEach(async () => {
	delete process.env[TEMP_ENV_KEY];
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("roadmap board script helpers", () => {
	it("loads env values from a service env file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "roadmap-board-env-"));
		tempDirs.push(dir);
		const envFile = join(dir, "env");

		await writeFile(envFile, `${TEMP_ENV_KEY}=loaded-from-file\n`, "utf-8");

		await loadBoardEnv(envFile);

		assert.equal(process.env[TEMP_ENV_KEY], "loaded-from-file");
	});

	it("maps lowercase maturity labels to icons", () => {
		assert.equal(getMaturityIcon("new", "DRAFT"), "🌱");
		assert.equal(getMaturityIcon({ DRAFT: "mature" }, "DRAFT"), "🧪");
		assert.equal(getMaturityIcon({ REVIEW: "active" }, "REVIEW"), "📐");
	});
});
