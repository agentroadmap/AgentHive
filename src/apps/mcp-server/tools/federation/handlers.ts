/**
 * Federation MCP Tools (P068)
 *
 * Wraps the FederationPKI class to expose federation operations
 * as MCP tools: host management, certificate operations, join approval,
 * quarantine, and federation statistics.
 */

import {
	type FederationPKI,
	initializeFederation,
} from "../../../../core/infrastructure/federation.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
	};
}

export class FederationHandlers {
	private pki: FederationPKI | null = null;
	private initPromise: Promise<FederationPKI> | null = null;

	constructor(
		private readonly core: McpServer,
		private readonly configDir: string = ".roadmap/federation",
	) {}

	private async getPki(): Promise<FederationPKI> {
		if (this.pki) return this.pki;
		if (!this.initPromise) {
			this.initPromise = initializeFederation(this.configDir);
		}
		this.pki = await this.initPromise;
		return this.pki;
	}

	/**
	 * Get federation statistics: hosts, certificates, connections, CA status.
	 */
	async getStats(): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			const stats = pki.getStats();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(stats, null, 2),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get federation stats", err);
		}
	}

	/**
	 * List all registered hosts with their status.
	 */
	async listHosts(args: { status?: string }): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			let hosts = pki.getAllHosts();

			if (args.status) {
				hosts = hosts.filter((h) => h.status === args.status);
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								total: hosts.length,
								hosts: hosts.map((h) => ({
									hostId: h.hostId,
									hostname: h.hostname,
									port: h.port,
									status: h.status,
									fingerprint: h.fingerprint,
									joinedAt: h.joinedAt,
									lastConnection: h.lastConnection,
									quarantineReason: h.quarantineReason,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list hosts", err);
		}
	}

	/**
	 * Get pending join requests for approval.
	 */
	async listJoinRequests(args: {
		all?: boolean;
	}): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			const requests = args.all
				? pki.getAllJoinRequests()
				: pki.getPendingRequests();

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								total: requests.length,
								requests: requests.map((r) => ({
									requestId: r.requestId,
									hostId: r.hostId,
									hostname: r.hostname,
									port: r.port,
									fingerprint: r.fingerprint,
									requestedAt: r.requestedAt,
									status: r.status,
									reviewedBy: r.reviewedBy,
									reviewedAt: r.reviewedAt,
									reason: r.reason,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list join requests", err);
		}
	}

	/**
	 * Approve a pending join request.
	 */
	async approveJoin(args: {
		requestId: string;
		reviewerId: string;
	}): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			const host = await pki.approveJoinRequest(
				args.requestId,
				args.reviewerId,
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								host: {
									hostId: host.hostId,
									hostname: host.hostname,
									port: host.port,
									status: host.status,
									certificateId: host.certificateId,
									approvedBy: host.approvedBy,
								},
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to approve join request", err);
		}
	}

	/**
	 * Deny a pending join request.
	 */
	async denyJoin(args: {
		requestId: string;
		reviewerId: string;
		reason: string;
	}): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			const ok = pki.denyJoinRequest(
				args.requestId,
				args.reviewerId,
				args.reason,
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{ success: ok, requestId: args.requestId },
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to deny join request", err);
		}
	}

	/**
	 * Quarantine a host (block connections, mark for investigation).
	 */
	async quarantineHost(args: {
		hostId: string;
		reason: string;
	}): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			const ok = pki.quarantineHost(args.hostId, args.reason);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: ok,
								hostId: args.hostId,
								status: ok ? "quarantined" : "not found",
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to quarantine host", err);
		}
	}

	/**
	 * Lift quarantine on a host.
	 */
	async liftQuarantine(args: {
		hostId: string;
		reviewerId: string;
	}): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			const ok = pki.liftQuarantine(args.hostId, args.reviewerId);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: ok,
								hostId: args.hostId,
								status: ok ? "approved" : "not quarantined",
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to lift quarantine", err);
		}
	}

	/**
	 * Get certificate details for a host or all expiring certificates.
	 */
	async listCertificates(args: {
		hostId?: string;
		expiringDays?: number;
	}): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			let certs;

			if (args.hostId) {
				certs = pki.getHostCertificates(args.hostId);
			} else if (args.expiringDays) {
				certs = pki.getExpiringCertificates(args.expiringDays);
			} else {
				// Return CA info
				const ca = pki.getCA();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ca: ca ?? "No CA initialized",
									message: "Use hostId or expiringDays to filter certificates",
								},
								null,
								2,
							),
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								total: certs.length,
								certificates: certs.map((c) => ({
									certId: c.certId,
									type: c.type,
									hostId: c.hostId,
									subject: c.subject,
									issuer: c.issuer,
									notBefore: c.notBefore,
									notAfter: c.notAfter,
									revoked: c.revoked,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list certificates", err);
		}
	}

	/**
	 * Get failed mTLS connections for monitoring.
	 */
	async getFailedConnections(args: {
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			const connections = pki.getFailedConnections(args.limit ?? 50);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								total: connections.length,
								connections: connections.map((c) => ({
									connectionId: c.connectionId,
									sourceHostId: c.sourceHostId,
									targetHostId: c.targetHostId,
									timestamp: c.timestamp,
									error: c.error,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get failed connections", err);
		}
	}

	/**
	 * Remove a host entirely (revoke + delete).
	 */
	async removeHost(args: { hostId: string }): Promise<CallToolResult> {
		try {
			const pki = await this.getPki();
			const ok = await pki.removeHost(args.hostId);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{ success: ok, hostId: args.hostId },
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to remove host", err);
		}
	}
}
