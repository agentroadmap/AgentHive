import http from "node:http";

const sse = await new Promise((resolve, reject) => {
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
			resolve({ sessionId, req, res });
		}, 1500);
	});
	req.on("error", reject);
	req.setTimeout(10000);
});

console.log("Session:", sse.sessionId);

function postAndListen(sessionId, res, data) {
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
				let _d = "";
				pr.on("data", (c) => {
					_d += c;
				});
				pr.on("end", () => {});
			},
		);
		postReq.write(body);
		postReq.end();
		setTimeout(() => {
			res.removeListener("data", listener);
			reject(new Error("Timeout"));
		}, 15000);
	});
}

try {
	const result = await postAndListen(sse.sessionId, sse.res, {
		jsonrpc: "2.0",
		id: "check7072",
		method: "tools/call",
		params: { name: "prop_get", arguments: { id: "P072" } },
	});
	if (result?.content) {
		console.log(result.content[0].text);
	} else {
		console.log("Result:", JSON.stringify(result).substring(0, 300));
	}
} catch (e) {
	console.error("Error:", e.message);
}

sse.req.destroy();
process.exit(0);
