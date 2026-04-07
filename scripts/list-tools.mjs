// List all available MCP tools
import http from "node:http";

function connectSSE() {
	return new Promise((resolve, reject) => {
		const req = http.get("http://localhost:6421/sse", (res) => {
			let buffer = "";
			let sessionId = null;

			res.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.substring(6);
						if (!sessionId && data.includes("sessionId=")) {
							sessionId = data.split("sessionId=")[1];
						}
					}
				}
			});

			setTimeout(() => {
				resolve({ sessionId, req, res });
			}, 1500);
		});
		req.on("error", reject);
		req.setTimeout(10000);
	});
}

function postMessage(sessionId, data) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(data);
		const postReq = http.request(
			`http://localhost:6421/messages?sessionId=${sessionId}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let d = "";
				res.on("data", (c) => {
					d += c;
				});
				res.on("end", () => resolve(d));
			},
		);
		postReq.on("error", reject);
		postReq.write(body);
		postReq.end();
	});
}

async function waitForSSEData(_sessionId, res, callId, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			res.removeListener("data", listener);
			reject(new Error("SSE timeout"));
		}, timeoutMs);
		const listener = (chunk) => {
			chunk
				.toString()
				.split("\n")
				.forEach((line) => {
					if (line.startsWith("data: ")) {
						try {
							const parsed = JSON.parse(line.substring(6));
							if (parsed.id === callId) {
								clearTimeout(timer);
								res.removeListener("data", listener);
								resolve(parsed);
							}
						} catch (_e) {}
					}
				});
		};
		res.on("data", listener);
	});
}

async function main() {
	console.log("Connecting SSE...");
	const { sessionId, req, res } = await connectSSE();
	console.log("Session:", sessionId);

	await new Promise((r) => setTimeout(r, 500));

	const callId = `list-tools-${Date.now()}`;
	await postMessage(sessionId, {
		jsonrpc: "2.0",
		id: callId,
		method: "tools/list",
		params: {},
	});

	console.log("Waiting for tools/list response...");
	const result = await waitForSSEData(sessionId, res, callId);

	if (result.result?.tools) {
		const toolNames = result.result.tools.map((t) => t.name).sort();
		console.log(`\nAvailable tools (${toolNames.length}):`);
		toolNames.forEach((n) => {
			console.log("  -", n);
		});

		// Check for prop_ tools
		const propTools = toolNames.filter(
			(n) => n.startsWith("prop_") || n.includes("proposal"),
		);
		console.log(
			"\nProposal tools:",
			propTools.length > 0 ? propTools.join(", ") : "NONE FOUND",
		);
	} else {
		console.log("Full result:", JSON.stringify(result, null, 2));
	}

	req.destroy();
	process.exit(0);
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
