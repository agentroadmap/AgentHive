// Seed P070 and P071 via MCP SSE
const http = require("node:http");

// Get MCP URL from environment (required; no literal default per P449)
const MCP_URL_STR = process.env.AGENTHIVE_MCP_URL;
if (!MCP_URL_STR) {
	console.error("ERROR: MCP URL not configured. Set AGENTHIVE_MCP_URL environment variable.");
	process.exit(1);
}
const MCP_URL = new URL(MCP_URL_STR);

const proposals = [
	{
		display_id: "P070",
		title: "Dependency-Gated State Transitions via Maturity",
		proposal_type: "feature",
		category: "Orchestration",
		domain_id: "orchestration",
		body_markdown:
			"Maturity and dependencies are two separate concepts. Maturity = decision gate passed. Dependencies = can move forward now. Unified maturity model: 0=New, 1=Active, 2=Mature, 3=Obsolete. SMDL gating with dependency checks. Completion cascades for dependents.",
		status: "PROPOSAL",
		tags: JSON.stringify(["workflow", "maturity", "dependencies", "SMDL"]),
	},
	{
		display_id: "P071",
		title: "Typed Dependencies in SMDL",
		proposal_type: "feature",
		category: "Orchestration",
		domain_id: "orchestration",
		body_markdown:
			"Typed dependency edges: interface, build, unit_test, integration, runtime. Each blocks different transitions. Per-transition dependency gating in SMDL. Backward compatible with all default.",
		status: "PROPOSAL",
		tags: JSON.stringify([
			"dependencies",
			"SMDL",
			"typed-deps",
			"parallel-work",
		]),
	},
];

// Connect SSE and listen for events
function connectSSE() {
	return new Promise((resolve, reject) => {
		const req = http.get(MCP_URL.toString(), (res) => {
			let buffer = "";
			let sessionId = null;
			const events = [];

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

						try {
							const parsed = JSON.parse(data);
							events.push(parsed);
							// Check if this is a tool result for our calls
							if (parsed.result?.content) {
								console.log(
									"TOOL RESULT:",
									JSON.stringify(
										parsed.result.content[0].text || parsed.result,
									),
								);
							}
						} catch (_e) {
							// Not JSON, probably the endpoint URL
						}
					}
				}
			});

			// Don't resolve immediately - keep connection open
			// Return a handle to make calls
			const handle = {
				sessionId: null,
				req,
				res,
				makeCall: (toolName, args) => {
					return new Promise((resolveCall, rejectCall) => {
						const id = `call-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
						const body = JSON.stringify({
							jsonrpc: "2.0",
							id,
							method: "tools/call",
							params: { name: toolName, arguments: args },
						});

						// Set up response listener
						const listener = (chunk) => {
							const str = chunk.toString();
							const lines = str.split("\n");
							for (const line of lines) {
								if (line.startsWith("data: ")) {
									try {
										const data = JSON.parse(line.substring(6));
										if (data.id === id && data.result) {
											res.removeListener("data", listener);
											resolveCall(data.result);
										}
									} catch (_e) {}
								}
							}
						};

						res.on("data", listener);

						// POST the message
						const postBody = Buffer.from(body);
						const postReq = http.request(
							`${MCP_URL.protocol}//${MCP_URL.host}/messages?sessionId=${handle.sessionId}`,
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									"Content-Length": postBody.length,
								},
							},
							(postRes) => {
								let r = "";
								postRes.on("data", (c) => {
									r += c;
								});
								postRes.on("end", () => console.log("Post result:", r));
							},
						);
						postReq.on("error", rejectCall);
						postReq.write(postBody);
						postReq.end();
					});
				},
				close: () => req.destroy(),
			};

			// Wait a bit then resolve with the handle
			setTimeout(() => {
				handle.sessionId = sessionId;
				resolve(handle);
			}, 1000);
		});

		req.on("error", reject);
		req.setTimeout(30000);
	});
}

async function main() {
	console.log("Connecting to SSE...");
	const sse = await connectSSE();
	console.log("Session:", sse.sessionId);

	for (const p of proposals) {
		console.log("\nSeeding:", p.display_id);
		const result = await sse.makeCall("prop_create", p);
		console.log("Created:", JSON.stringify(result));
	}

	console.log("\n--- Verify ---");
	const list = await sse.makeCall("prop_list", {});
	console.log("List result:", JSON.stringify(list).substring(0, 1000));

	sse.close();
	process.exit(0);
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
