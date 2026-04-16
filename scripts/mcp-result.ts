export function mcpText(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> })
		.content;
	const first = content?.[0];
	return first?.type === "text" && typeof first.text === "string"
		? first.text
		: "";
}

export function parseMcpJson<T>(result: unknown, fallback: T): T {
	const text = mcpText(result);
	if (!text) return fallback;
	return JSON.parse(text) as T;
}
