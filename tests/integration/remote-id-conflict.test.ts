import assert from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
let REMOTE_DIR: string;
let LOCAL_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

async function initRepo(dir: string) {
	execSync(`git init -b main`, { cwd: dir });
	execSync(`git config user.name Test`, { cwd: dir });
	execSync(`git config user.email test@example.com`, { cwd: dir });
}

describe("next id across remote branches", () => {
	before(async () => {
		TEST_DIR = createUniqueTestDir("test-remote-id");
		REMOTE_DIR = join(TEST_DIR, "remote.git");
		LOCAL_DIR = join(TEST_DIR, "local");
		await mkdir(REMOTE_DIR, { recursive: true });
		execSync(`git init --bare -b main`, { cwd: REMOTE_DIR });
		await mkdir(LOCAL_DIR, { recursive: true });
		await initRepo(LOCAL_DIR);
		execSync(`git remote add origin ${REMOTE_DIR}`, { cwd: LOCAL_DIR });

		const core = new Core(LOCAL_DIR);
		await core.initializeProject("Remote Test", true);
		await core.ensureConfigMigrated();
		execSync(`git branch -M main`, { cwd: LOCAL_DIR });
		execSync(`git push -u origin main`, { cwd: LOCAL_DIR });

		execSync(`git checkout -b feature`, { cwd: LOCAL_DIR });
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Remote Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-08",
				labels: [],
				dependencies: [],
				rawContent: "",
			},
			true,
		);
		execSync(`git push -u origin feature`, { cwd: LOCAL_DIR });
		execSync(`git checkout main`, { cwd: LOCAL_DIR });
	});

	after(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	it("uses id after highest remote proposal", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Local Proposal"`,
			{ cwd: LOCAL_DIR },
		);
		expect(result.stdout.toString()).toContain("Created proposal proposal-2");
		const core = new Core(LOCAL_DIR);
		const proposal = await core.filesystem.loadProposal("proposal-2");
		assert.notStrictEqual(proposal, null);
	});
});
