import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import { formatLocalDateTime } from "../../src/utils/date-time.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
	sleep,
} from "../support/test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;
let core: Core;

async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 4000,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await condition()) return;
		await sleep(50);
	}
	throw new Error(`Timed out after ${timeoutMs}ms`);
}

function captureStream(
	stream: NodeJS.ReadableStream | null | undefined,
): Promise<string> {
	return new Promise((resolve) => {
		if (!stream) {
			resolve("");
			return;
		}

		let output = "";
		stream.setEncoding?.("utf8");
		stream.on("data", (chunk) => {
			output += String(chunk);
		});
		stream.on("end", () => resolve(output));
		stream.on("close", () => resolve(output));
	});
}

function groupLogPath(group = "chat-test") {
	return join(TEST_DIR, "roadmap", "messages", `group-${group}.md`);
}

function privateLogPath(left: string, right: string) {
	return join(
		TEST_DIR,
		"roadmap",
		"messages",
		`private-${[left, right].sort().join("-")}.md`,
	);
}

describe("chat features", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("chat-features");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Gary"`, { cwd: TEST_DIR });
		execSync(`git config user.email "gary@example.com"`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Chat Test");
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR).catch(() => {});
	});

	it("preserves multiline talk content and extracts mentions when reading messages", async () => {
		const beforeSendMinute = formatLocalDateTime(new Date());
		await core.sendMessage({
			from: "Gary",
			message: "Line one\nLine two for @bob",
			type: "group",
			group: "chat-test",
		});
		const afterSendMinute = formatLocalDateTime(new Date());

		const result = await core.readMessages({ channel: "chat-test" });
		assert.strictEqual(result.messages.length, 1);
		expect(result.messages[0]).toMatchObject({
			from: "Gary",
			text: "Line one\nLine two for @bob",
			mentions: ["bob"],
		});
		assert.ok(
			[beforeSendMinute, afterSendMinute].includes(
				result.messages[0]?.timestamp.slice(0, 16),
			),
		);

		const raw = await readFile(groupLogPath(), "utf8");
		assert.ok(raw.includes("__roadmap_msg_b64__:"));
	});

	it("collects known users from worktrees and message history", async () => {
		await mkdir(join(TEST_DIR, "worktrees", "andy"), { recursive: true });
		await mkdir(join(TEST_DIR, "worktrees", "bob"), { recursive: true });
		await core.sendMessage({
			from: "Gary",
			message: "Hello @andy",
			type: "group",
			group: "chat-test",
		});

		const users = await core.getKnownUsers();
		assert.deepStrictEqual(
			users,
			expect.arrayContaining(["Gary", "andy", "bob"]),
		);
	});

	it("replays and streams mention-filtered messages", async () => {
		await core.sendMessage({
			from: "Gary",
			message: "General hello",
			type: "group",
			group: "chat-test",
		});
		await core.sendMessage({
			from: "Gary",
			message: "Checking in with @bob",
			type: "group",
			group: "chat-test",
		});

		const seen: string[] = [];
		const stopWatching = await core.watchMessages({
			channel: "chat-test",
			since: "2000-01-01 00:00:00",
			mention: "bob",
			onMessage: (message) => {
				seen.push(message.text);
			},
		});

		await waitFor(() => seen.length === 1);
		assert.deepStrictEqual(seen, ["Checking in with @bob"]);

		await core.sendMessage({
			from: "Carter",
			message: "No mention here",
			type: "group",
			group: "chat-test",
		});
		await core.sendMessage({
			from: "Carter",
			message: "Following up for @bob",
			type: "group",
			group: "chat-test",
		});

		await waitFor(() => seen.length === 2);
		assert.deepStrictEqual(seen, [
			"Checking in with @bob",
			"Following up for @bob",
		]);
		stopWatching();
	});

	it("routes talk messages to group and private logs", async () => {
		execSync(
			`node --experimental-strip-types ${CLI_PATH} talk ${"Hello @bob"} --as ${"Gary"}`,
			{ cwd: TEST_DIR },
		);
		execSync(
			`node --experimental-strip-types ${CLI_PATH} talk ${"Private hello"} ${"@bob"} --as ${"Gary"}`,
			{ cwd: TEST_DIR },
		);

		const groupMessages = await core.readMessages({ channel: "chat-test" });
		expect(groupMessages.messages.at(-1)).toMatchObject({
			from: "Gary",
			text: "Hello @bob",
			mentions: ["bob"],
		});

		const privateLog = await readFile(privateLogPath("gary", "bob"), "utf8");
		assert.ok(privateLog.includes("Private hello"));
	});

	it("renders mention-filtered listen output in markdown mode", async () => {
		await core.sendMessage({
			from: "Gary",
			message: "Hello @bob from markdown mode",
			type: "group",
			group: "chat-test",
		});

		const child = spawn(
			"bun",
			[
				CLI_PATH,
				"listen",
				"chat-test",
				"--mention",
				"bob",
				"--since",
				"2000-01-01 00:00:00",
				"--all",
				"--markdown",
			],
			{
				cwd: TEST_DIR,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const stdoutPromise = captureStream(child.stdout);
		await sleep(500);
		child.kill("SIGTERM");
		await new Promise((resolve) => child.on("exit", resolve));
		const stdout = await stdoutPromise;

		assert.ok(stdout.includes("**Gary**"));
		assert.ok(stdout.includes("**@bob**"));
		assert.ok(stdout.includes("Hello **@bob** from markdown mode"));
	});

	it("renders compact listen output without blank lines between messages", async () => {
		await core.sendMessage({
			from: "Gary",
			message: "First compact message",
			type: "group",
			group: "chat-test",
		});
		await core.sendMessage({
			from: "Carter",
			message: "Second compact message",
			type: "group",
			group: "chat-test",
		});

		const child = spawn(
			"bun",
			[
				CLI_PATH,
				"listen",
				"chat-test",
				"--since",
				"2000-01-01 00:00:00",
				"--all",
				"--markdown",
			],
			{
				cwd: TEST_DIR,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const stdoutPromise = captureStream(child.stdout);
		await sleep(500);
		child.kill("SIGTERM");
		await new Promise((resolve) => child.on("exit", resolve));
		const stdout = await stdoutPromise;

		assert.ok(stdout.includes("First compact message\n**Carter**"));
		assert.ok(!stdout.includes("First compact message\n\n**Carter**"));
	});

	it("shows revision in splash and sends chat input lines", async () => {
		const splash = execSync(
			`node --experimental-strip-types ${CLI_PATH} --plain`,
			{ cwd: TEST_DIR },
		);
		expect(splash.stdout.toString()).toContain("rev ");

		const child = spawn("bun", [CLI_PATH, "chat"], {
			cwd: TEST_DIR,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdoutPromise = captureStream(child.stdout);

		await sleep(300);
		child.stdin?.write("hello from non-tty chat\n");

		await waitFor(async () => {
			const content = await readFile(groupLogPath(), "utf8").catch(() => "");
			return content.includes("hello from non-tty chat");
		});

		child.kill("SIGTERM");
		await new Promise((resolve) => child.on("exit", resolve));
		const stdout = await stdoutPromise;
		assert.ok(stdout.includes("rev "));
	});
});
