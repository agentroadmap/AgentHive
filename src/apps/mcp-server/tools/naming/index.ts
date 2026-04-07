const NAMING_RULES = {
	step: { pattern: /^s\d{3}(\.\d+)*$/, example: "s001, s012.1" },
	cubic: { pattern: /^cu\d{2}$/, example: "cu01, cu02" },
	agent: { pattern: /^a[a-z]{2,4}\d{2}$/, example: "adev01, arev01" },
	team: { pattern: /^tm-[a-z-]+$/, example: "tm-backend" },
	model: { pattern: /^model-[a-z0-9-]+$/, example: "model-mimo-v2-pro" },
	knowledge: { pattern: /^k-[a-z]+\d{3}$/, example: "k-decision001" },
	directive: { pattern: /^m-[a-z0-9-]+$/, example: "m-v1, m-alpha" },
};

export function registerNamingTools(server: any): void {
	server.addTool({
		name: "naming_validate",
		description: "Validate if an ID matches the naming convention",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		handler: async (input: any) => {
			const id = input.id as string;
			for (const [type, rule] of Object.entries(NAMING_RULES)) {
				if ((rule as any).pattern.test(id)) {
					return {
						content: [{ type: "text", text: `✅ Valid ${type} ID: ${id}` }],
					};
				}
			}
			return { content: [{ type: "text", text: `❌ Invalid: ${id}` }] };
		},
	});

	server.addTool({
		name: "naming_examples",
		description: "Get naming examples for an entity type",
		inputSchema: {
			type: "object",
			properties: { type: { type: "string", enum: Object.keys(NAMING_RULES) } },
			required: ["type"],
		},
		handler: async (input: any) => {
			const rule = (NAMING_RULES as any)[input.type];
			return rule
				? {
						content: [
							{
								type: "text",
								text: `${input.type}: format="${rule.pattern}", example="${rule.example}"`,
							},
						],
					}
				: {
						content: [
							{
								type: "text",
								text: `Valid types: ${Object.keys(NAMING_RULES).join(", ")}`,
							},
						],
					};
		},
	});
}
