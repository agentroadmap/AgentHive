import http from "node:http";

async function connectSSE() {
	return new Promise((resolve, reject) => {
		const req = http.get("http://localhost:6421/sse", (res) => {
			let buffer = "";
			let sessionId = null;
			res.on("data", (chunk) => {
				buffer += chunk.toString();
				for (const line of buffer.split("\n")) {
					if (line.startsWith("data: ") && line.includes("sessionId=")) {
						sessionId = line.substring(6).split("sessionId=")[1];
					}
				}
				buffer = buffer.split("\n").pop() || "";
			});
			setTimeout(() => {
				const { sessionId: sid } = { sessionId };
				resolve({ sessionId: sid, req, res });
			}, 1500);
		});
		req.on("error", reject);
		req.setTimeout(10000);
	});
}

function postAndListen(sessionId, res, data, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const callId = data.id;
		const listener = (chunk) => {
			for (const line of chunk.toString().split("\n")) {
				if (line.startsWith("data: ")) {
					try {
						const parsed = JSON.parse(line.substring(6));
						if (parsed.id === callId) {
							res.removeListener("data", listener);
							if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
							else resolve(parsed.result);
						}
					} catch (_e) {}
				}
			}
		};
		res.on("data", listener);

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
			(pr) => {
				let d = "";
				pr.on("data", (c) => {
					d += c;
				});
				pr.on("end", () => {});
			},
		);
		postReq.write(body);
		postReq.end();
		setTimeout(() => {
			res.removeListener("data", listener);
			reject(new Error("Timeout"));
		}, timeoutMs);
	});
}

const sse = await connectSSE();
console.log("Connected, session:", sse.sessionId);

try {
	const result = await postAndListen(sse.sessionId, sse.res, {
		jsonrpc: "2.0",
		id: "verify-7071",
		method: "tools/call",
		params: { name: "prop_list", arguments: {} },
	});
	if (result?.content) {
		const text = result.content[0].text;
		console.log(text);
		if (text.includes("P070") && text.includes("P071")) {
			console.log("\n✅ P070 and P071 visible via MCP");
		}
	} else {
		console.log("Result:", JSON.stringify(result).substring(0, 300));
	}
} catch (e) {
	console.error("Error:", e.message);
}

sse.req.destroy();
process.exit(0);
