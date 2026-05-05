/**
 * P441: Service Topology Ownership
 *
 * Declares one primary writer per state-machine responsibility and provides
 * lease lifecycle management for DB-trigger enforcement.
 *
 * Responsibilities defined here mirror the DB ownership matrix in migration 071.
 * The DB trigger (fn_enforce_service_ownership) reads app.service_id and checks
 * control_runtime.service_lease; this module manages the lease lifecycle from TS.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type Responsibility =
	| "state_machine_transition"
	| "maturity_sync"
	| "workflow_spawn"
	| "service_lease_management"
	| "gate_evaluation"
	| "work_offer_claim"
	| "subprocess_spawn"
	| "proposal_crud"
	| "feed_event_publication";

export type ServiceMode = "primary" | "passive";

export interface OwnershipEntry {
	primaryWriter: string;
	passiveObservers: string[];
}

export type OwnershipMatrix = Record<Responsibility, OwnershipEntry>;

export interface ServiceLease {
	leaseId: string;
	serviceId: string;
	responsibility: string;
	acquiredAt: string;
	expiresAt: string;
	releasedAt: string | null;
	releaseReason: string | null;
}

export type QueryFn = (
	text: string,
	params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number }>;

// ─── Ownership Matrix ─────────────────────────────────────────────────────────

export const OWNERSHIP_MATRIX: OwnershipMatrix = {
	state_machine_transition: {
		primaryWriter: "orchestrator",
		passiveObservers: ["mcp-server", "state-feed-listener"],
	},
	maturity_sync: {
		primaryWriter: "orchestrator",
		passiveObservers: [],
	},
	workflow_spawn: {
		primaryWriter: "orchestrator",
		passiveObservers: [],
	},
	service_lease_management: {
		primaryWriter: "orchestrator",
		passiveObservers: [],
	},
	gate_evaluation: {
		primaryWriter: "orchestrator",
		passiveObservers: [],
	},
	work_offer_claim: {
		primaryWriter: "offer-provider",
		passiveObservers: ["mcp-server"],
	},
	subprocess_spawn: {
		primaryWriter: "offer-provider",
		passiveObservers: [],
	},
	proposal_crud: {
		primaryWriter: "mcp-server",
		passiveObservers: [],
	},
	feed_event_publication: {
		primaryWriter: "state-feed-listener",
		passiveObservers: [],
	},
};

// ─── Query Functions ──────────────────────────────────────────────────────────

export function getPrimaryOwner(responsibility: string): string | null {
	const entry = OWNERSHIP_MATRIX[responsibility as Responsibility];
	return entry?.primaryWriter ?? null;
}

export function getPassiveConsumers(responsibility: string): string[] {
	const entry = OWNERSHIP_MATRIX[responsibility as Responsibility];
	return entry ? [...entry.passiveObservers] : [];
}

export function isWriteAuthorized(
	serviceId: string,
	responsibility: string,
): boolean {
	return getPrimaryOwner(responsibility) === serviceId;
}

export function describeOwnership(): string {
	const lines = ["# Service Ownership Matrix", ""];
	lines.push("| Responsibility | Primary Writer | Passive Observers |");
	lines.push("|---|---|---|");
	for (const [resp, entry] of Object.entries(OWNERSHIP_MATRIX)) {
		const passive =
			entry.passiveObservers.length > 0
				? entry.passiveObservers.join(", ")
				: "(none)";
		lines.push(`| ${resp} | ${entry.primaryWriter} | ${passive} |`);
	}
	return lines.join("\n");
}

// ─── Error Types ──────────────────────────────────────────────────────────────

export class ServiceLeaseRequiredError extends Error {
	readonly errcode = "insufficient_privilege";
	constructor(serviceId: string, responsibility: string) {
		super(
			`Service ${serviceId} must hold an active lease for responsibility ${responsibility}`,
		);
		this.name = "ServiceLeaseRequiredError";
	}
}

export class ServiceOwnershipMismatchError extends Error {
	readonly errcode = "insufficient_privilege";
	constructor(
		serviceId: string,
		responsibility: string,
		primaryOwner: string,
	) {
		super(
			`Service ${serviceId} is not the primary owner of ${responsibility}; ` +
				`primary is ${primaryOwner}`,
		);
		this.name = "ServiceOwnershipMismatchError";
	}
}

export class UnauthorizedWriteError extends Error {
	readonly errcode = "insufficient_privilege";
	constructor(serviceId: string, table: string, responsibility: string) {
		super(
			`Service ${serviceId} is not authorized to write ${table} ` +
				`(responsibility: ${responsibility})`,
		);
		this.name = "UnauthorizedWriteError";
	}
}

// ─── Session Context (process-level) ─────────────────────────────────────────

interface ServiceContext {
	serviceId: string;
	responsibility: string;
}

let _sessionContext: ServiceContext | null = null;

export function setServiceContext(
	serviceId: string,
	responsibility: string,
): void {
	_sessionContext = { serviceId, responsibility };
}

export function clearServiceContext(): void {
	_sessionContext = null;
}

export function getServiceContext(): ServiceContext | null {
	return _sessionContext;
}

export async function withServiceContext<T>(
	serviceId: string,
	responsibility: string,
	fn: () => Promise<T>,
): Promise<T> {
	const prior = _sessionContext;
	setServiceContext(serviceId, responsibility);
	try {
		return await fn();
	} finally {
		_sessionContext = prior;
	}
}

// ─── Lease Lifecycle ──────────────────────────────────────────────────────────

export async function acquireLease(
	queryFn: QueryFn,
	serviceId: string,
	responsibility: string,
	ttlSeconds = 300,
): Promise<ServiceLease> {
	if (!isWriteAuthorized(serviceId, responsibility)) {
		const primary = getPrimaryOwner(responsibility) ?? "(unknown)";
		throw new ServiceOwnershipMismatchError(serviceId, responsibility, primary);
	}
	const result = await queryFn(
		`INSERT INTO control_runtime.service_lease
		   (service_id, responsibility, expires_at)
		 VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
		 RETURNING
		   lease_id, service_id, responsibility,
		   acquired_at, expires_at, released_at, release_reason`,
		[serviceId, responsibility, String(ttlSeconds)],
	);
	return mapLeaseRow(result.rows[0] as Record<string, unknown>);
}

export async function releaseLease(
	queryFn: QueryFn,
	leaseId: string,
	reason = "explicit_release",
): Promise<void> {
	await queryFn(
		`UPDATE control_runtime.service_lease
		 SET released_at = now(), release_reason = $2
		 WHERE lease_id = $1 AND released_at IS NULL`,
		[leaseId, reason],
	);
}

export async function releaseAllLeases(
	queryFn: QueryFn,
	serviceId: string,
	reason = "service_shutdown",
): Promise<void> {
	await queryFn(
		`UPDATE control_runtime.service_lease
		 SET released_at = now(), release_reason = $2
		 WHERE service_id = $1 AND released_at IS NULL`,
		[serviceId, reason],
	);
}

export async function renewLease(
	queryFn: QueryFn,
	leaseId: string,
	ttlSeconds = 300,
): Promise<void> {
	await queryFn(
		`UPDATE control_runtime.service_lease
		 SET expires_at = now() + ($2 || ' seconds')::interval
		 WHERE lease_id = $1 AND released_at IS NULL AND expires_at > now()`,
		[leaseId, String(ttlSeconds)],
	);
}

export async function heartbeat(
	queryFn: QueryFn,
	serviceId: string,
): Promise<void> {
	await queryFn(
		`UPDATE control_runtime.service_registry
		 SET last_heartbeat = now()
		 WHERE service_id = $1`,
		[serviceId],
	);
}

export async function listActiveLeases(
	queryFn: QueryFn,
): Promise<ServiceLease[]> {
	const result = await queryFn(
		`SELECT lease_id, service_id, responsibility,
		        acquired_at, expires_at, released_at, release_reason
		 FROM control_runtime.service_lease
		 WHERE released_at IS NULL AND expires_at > now()
		 ORDER BY acquired_at`,
	);
	return (result.rows as Record<string, unknown>[]).map(mapLeaseRow);
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function mapLeaseRow(row: Record<string, unknown>): ServiceLease {
	return {
		leaseId: String(row.lease_id),
		serviceId: String(row.service_id),
		responsibility: String(row.responsibility),
		acquiredAt: String(row.acquired_at),
		expiresAt: String(row.expires_at),
		releasedAt: row.released_at != null ? String(row.released_at) : null,
		releaseReason: row.release_reason != null ? String(row.release_reason) : null,
	};
}
