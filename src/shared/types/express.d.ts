declare module "express" {
	import type { IncomingMessage, ServerResponse } from "node:http";

	export interface Request extends IncomingMessage {
		params: Record<string, string>;
		query: Record<string, unknown>;
		body: unknown;
	}

	export interface Response extends ServerResponse {
		json(data: unknown): void;
		send(data: unknown): void;
		status(code: number): Response;
		redirect(url: string): void;
	}

	export interface Router {
		get(path: string, handler: (req: Request, res: Response) => void): void;
		post(path: string, handler: (req: Request, res: Response) => void): void;
		put(path: string, handler: (req: Request, res: Response) => void): void;
		delete(path: string, handler: (req: Request, res: Response) => void): void;
		use(...handlers: unknown[]): void;
	}

	export function Router(): Router;
	export default function express(): unknown;
}
