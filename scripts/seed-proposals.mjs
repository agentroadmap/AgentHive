import http from "node:http";

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
				const handle = {
					sessionId,
					req,
					res,
					makeCall(toolName, args) {
						return new Promise((resolveCall, rejectCall) => {
							const callId = `seed-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
							const body = JSON.stringify({
								jsonrpc: "2.0",
								id: callId,
								method: "tools/call",
								params: { name: toolName, arguments: args },
							});
							const listener = (chunk) => {
								chunk
									.toString()
									.split("\n")
									.forEach((line) => {
										if (line.startsWith("data: ")) {
											try {
												const parsed = JSON.parse(line.substring(6));
												if (parsed.id === callId) {
													res.removeListener("data", listener);
													if (parsed.error)
														rejectCall(new Error(JSON.stringify(parsed.error)));
													else resolveCall(parsed.result);
												}
											} catch (_e) {}
										}
									});
							};
							res.on("data", listener);
							const postBody = Buffer.from(body);
							const postReq = http.request(
								`http://localhost:6421/messages?sessionId=${sessionId}`,
								{
									method: "POST",
									headers: {
										"Content-Type": "application/json",
										"Content-Length": postBody.length,
									},
								},
								(postRes) => {
									let d = "";
									postRes.on("data", (c) => {
										d += c;
									});
									postRes.on("end", () =>
										console.log("POST:", d.substring(0, 80)),
									);
								},
							);
							postReq.on("error", rejectCall);
							postReq.write(postBody);
							postReq.end();
							setTimeout(() => {
								res.removeListener("data", listener);
								rejectCall(new Error("Timeout"));
							}, 15000);
						});
					},
					close() {
						req.destroy();
					},
				};
				resolve(handle);
			}, 1500);
		});
		req.on("error", reject);
		req.setTimeout(15000);
	});
}

async function main() {
	console.log("Connecting SSE...");
	const sse = await connectSSE();
	console.log("Session:", sse.sessionId);

	// Check tools avail
	try {
		const list = await sse.makeCall("prop_list", {});
		console.log("prop_list works:", JSON.stringify(list).substring(0, 200));
	} catch (e) {
		console.log("prop_list error:", e.message);
	}

	for (const p of proposals) {
		console.log("\nCreating:", p.display_id);
		try {
			const result = await sse.makeCall("prop_create", p);
			console.log("Result:", JSON.stringify(result));
		} catch (e) {
			console.error("Error:", e.message);
		}
	}

	console.log("\n--- Verify DB ---");
	try {
		const result = await sse.makeCall("prop_list", { status: "PROPOSAL" });
		console.log("Proposal list:", JSON.stringify(result).substring(0, 500));
	} catch (e) {
		console.error("List error:", e.message);
	}

	sse.close();
	process.exit(0);
}

main().catch((e) => {
	console.error("Fatal:", e.message);
	process.exit(1);
});
