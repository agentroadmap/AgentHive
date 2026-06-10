import { describe, expect, it } from "bun:test";
import {
	type CliInvocationHandler,
	invokeCliHandler,
} from "./cli-invocation.ts";

describe("invokeCliHandler", () => {
	it("preserves stderr details when a CLI times out", async () => {
		const handler: CliInvocationHandler = {
			provider: "codex",
			bin: "sh",
			buildArgs: () => [
				"-c",
				"printf '401 Unauthorized from api.openai.com\\n' >&2; sleep 1",
			],
			brand: "Codex",
		};

		await expect(
			invokeCliHandler(handler, "ignored", { timeoutMs: 50 }),
		).rejects.toThrow(/timed out after 50ms: 401 Unauthorized/);
	});
});
