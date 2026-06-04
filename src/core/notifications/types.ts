/**
 * P674: notification router shared types.
 *
 * The router contract: events emit (severity, kind, payload). Transports
 * receive a fully-resolved dispatch envelope. Neither side knows about the
 * other; the router is the only piece that consults notification_route.
 */

export type Severity = "INFO" | "ALERT" | "URGENT" | "CRITICAL";

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
	INFO: 0,
	ALERT: 1,
	URGENT: 2,
	CRITICAL: 3,
};

export function severityAtLeast(actual: Severity, min: Severity): boolean {
	return SEVERITY_RANK[actual] >= SEVERITY_RANK[min];
}

export interface NotificationEnvelope {
	queueId: number;
	severity: Severity;
	kind: string;
	payload: Record<string, unknown>;
	proposalId: number | null;
	title: string;
	body: string;
	createdAt: Date;
}

export interface NotificationRoute {
	id: number;
	kind: string;
	severityMin: Severity;
	transport: string;
	target: string | null;
	template: string | null;
	priority: number;
}

export interface DispatchArgs {
	envelope: NotificationEnvelope;
	route: NotificationRoute;
}

export interface NotificationTransport {
	readonly name: string;
	send(args: DispatchArgs): Promise<void>;
}

export class TransportError extends Error {
	readonly transport: string;
	override readonly cause: unknown;

	constructor(
		transport: string,
		cause: unknown,
		message?: string,
	) {
		super(message ?? `Transport "${transport}" failed: ${describeCause(cause)}`);
		this.transport = transport;
		this.cause = cause;
		this.name = "TransportError";
	}
}

function describeCause(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === "string") return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
}
