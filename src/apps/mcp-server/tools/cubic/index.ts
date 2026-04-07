import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";

const CUBICS_DIR = "cubics";

function ensureCubicsDir(): void {
	if (!existsSync(CUBICS_DIR)) mkdirSync(CUBICS_DIR, { recursive: true });
}

function loadCubic(id: string): any {
	const path = join(CUBICS_DIR, id, "cubic.json");
	if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
	return null;
}

function saveCubic(id: string, cubic: any): void {
	const dir = join(CUBICS_DIR, id);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "cubic.json"), JSON.stringify(cubic, null, 2));
}

export function registerCubicTools(
	server: McpServer,
	_projectRoot = process.cwd(),
): void {
	ensureCubicsDir();

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "cubic_create",
				description: "Create a new cubic workspace",
				inputSchema: {
					type: "object",
					properties: {
						name: { type: "string" },
						agents: { type: "array", items: { type: "string" } },
						proposals: { type: "array", items: { type: "string" } },
					},
					required: ["name"],
				},
			},
			{
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
			},
			async (input, _context) => {
				const args = input as any;
				const id = `cubic-${String(Date.now()).slice(-6)}`;
				const agents = args.agents || ["coder", "reviewer"];
				const ownership: any = {};
				agents.forEach((a: string) => {
					ownership[a] = `${id}-${a}`;
				});
				const cubic = {
					id,
					name: args.name,
					phase: "design",
					phaseGate: "G1",
					ownership,
					assignedProposals: args.proposals || [],
					createdAt: new Date().toISOString(),
					lock: null,
				};
				saveCubic(id, cubic);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ success: true, cubic }, null, 2),
						},
					],
				};
			},
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "cubic_list",
				description: "List all cubics",
				inputSchema: { type: "object", properties: {}, required: [] },
			},
			{ type: "object", properties: {}, required: [] },
			async (_input, _context) => {
				const cubics = readdirSync(CUBICS_DIR)
					.filter((d) => existsSync(join(CUBICS_DIR, d, "cubic.json")))
					.map((d) =>
						JSON.parse(readFileSync(join(CUBICS_DIR, d, "cubic.json"), "utf8")),
					);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ total: cubics.length, cubics }, null, 2),
						},
					],
				};
			},
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "cubic_focus",
				description: "Update cubic focus and acquire lock",
				inputSchema: {
					type: "object",
					properties: {
						cubicId: { type: "string" },
						agent: { type: "string" },
						task: { type: "string" },
						phase: { type: "string" },
					},
					required: ["cubicId", "agent", "task"],
				},
			},
			{
				type: "object",
				properties: {
					cubicId: { type: "string" },
					agent: { type: "string" },
					task: { type: "string" },
				},
				required: ["cubicId", "agent", "task"],
			},
			async (input, _context) => {
				const args = input as any;
				const cubic = loadCubic(args.cubicId);
				if (!cubic)
					return { content: [{ type: "text", text: "Cubic not found" }] };
				cubic.lock = {
					holder: args.agent,
					phase: args.phase || cubic.phase,
					lockedAt: new Date().toISOString(),
				};
				saveCubic(args.cubicId, cubic);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ success: true, lock: cubic.lock },
								null,
								2,
							),
						},
					],
				};
			},
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "cubic_transition",
				description: "Transition cubic phase and release lock",
				inputSchema: {
					type: "object",
					properties: {
						cubicId: { type: "string" },
						toPhase: { type: "string" },
					},
					required: ["cubicId", "toPhase"],
				},
			},
			{
				type: "object",
				properties: {
					cubicId: { type: "string" },
					toPhase: { type: "string" },
				},
				required: ["cubicId", "toPhase"],
			},
			async (input, _context) => {
				const args = input as any;
				const cubic = loadCubic(args.cubicId);
				if (!cubic)
					return { content: [{ type: "text", text: "Cubic not found" }] };
				cubic.phase = args.toPhase;
				cubic.lock = null;
				saveCubic(args.cubicId, cubic);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ success: true, phase: cubic.phase },
								null,
								2,
							),
						},
					],
				};
			},
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "cubic_recycle",
				description: "Recycle cubic for new task",
				inputSchema: {
					type: "object",
					properties: {
						cubicId: { type: "string" },
						resetCode: { type: "boolean" },
					},
					required: ["cubicId"],
				},
			},
			{
				type: "object",
				properties: { cubicId: { type: "string" } },
				required: ["cubicId"],
			},
			async (input, _context) => {
				const args = input as any;
				const cubic = loadCubic(args.cubicId);
				if (!cubic)
					return { content: [{ type: "text", text: "Cubic not found" }] };
				cubic.phase = "design";
				cubic.phaseGate = "G1";
				cubic.lock = null;
				if (args.resetCode) {
					try {
						execSync(
							`cd cubics/${args.cubicId} && git checkout . && git clean -fd`,
							{ stdio: "pipe" },
						);
					} catch {}
				}
				saveCubic(args.cubicId, cubic);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ success: true, message: `Cubic ${args.cubicId} recycled` },
								null,
								2,
							),
						},
					],
				};
			},
		),
	);

	console.log(
		"[Cubic] Registered 5 tools: cubic_create, cubic_list, cubic_focus, cubic_transition, cubic_recycle",
	);
}
