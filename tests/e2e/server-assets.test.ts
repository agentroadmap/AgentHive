import assert from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileSystem } from "../../src/file-system/operations.ts";
import { RoadmapServer } from "../../src/server/index.ts";
import {
	createUniqueTestDir,
	expect,
	retry,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
let filesystem: FileSystem;
let server: RoadmapServer | null = null;
let serverPort = 0;

describe("RoadmapServer asset serving", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("server-assets");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureRoadmapStructure();

		// ensure config so server starts cleanly
		await filesystem.saveConfig({
			projectName: "Server Assets",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			dateFormat: "YYYY-MM-DD",
			remoteOperations: false,
		});

		// create roadmap/assets and nested dirs
		const roadmapRoot = dirname(filesystem.docsDir);
		const assetsDir = join(roadmapRoot, "assets");
		await mkdir(join(assetsDir, "images"), { recursive: true });
		await mkdir(join(assetsDir, "docs"), { recursive: true });

		// write a small test asset and a text file
		await writeFile(join(assetsDir, "images", "test.png"), "PNGTEST");
		await writeFile(join(assetsDir, "docs", "readme.txt"), "Hello assets\n");

		server = new RoadmapServer(TEST_DIR);
		await server.start(0, false);
		const port = server.getPort();
		assert.notStrictEqual(port, null);
		serverPort = port ?? 0;

		// wait for server to be reachable
		await retry(
			async () => {
				const res = await fetch(`http://127.0.0.1:${serverPort}/`);
				if (!res.ok) throw new Error("server not ready");
				return true;
			},
			10,
			50,
		);
	});

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = null;
		}
		await safeCleanup(TEST_DIR);
	});

	it("serves existing image assets with appropriate Content-Type and body", async () => {
		const res = await fetch(
			`http://127.0.0.1:${serverPort}/assets/images/test.png`,
		);
		assert.strictEqual(res.status, 200);
		expect(res.headers.get("content-type")).toBe("image/png");
		const body = await res.text();
		assert.strictEqual(body, "PNGTEST");
	});

	it("serves text files with text/plain Content-Type", async () => {
		const res = await fetch(
			`http://127.0.0.1:${serverPort}/assets/docs/readme.txt`,
		);
		assert.strictEqual(res.status, 200);
		expect(res.headers.get("content-type")).toBe("text/plain");
		const body = await res.text();
		assert.strictEqual(body, "Hello assets\n");
	});

	it("returns 404 for missing files", async () => {
		const res = await fetch(
			`http://127.0.0.1:${serverPort}/assets/images/missing.png`,
		);
		assert.strictEqual(res.status, 404);
	});

	it("rejects path traversal attempts with 404", async () => {
		// attempt to escape assets via ..
		const res = await fetch(
			`http://127.0.0.1:${serverPort}/assets/../config.yml`,
		);
		assert.strictEqual(res.status, 404);

		// encoded traversal
		const res2 = await fetch(
			`http://127.0.0.1:${serverPort}/assets/%2e%2e/config.yml`,
		);
		assert.strictEqual(res2.status, 404);
	});
});
