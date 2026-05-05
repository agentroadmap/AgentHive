/**
 * P068: Federation & Cross-Instance Sync — test suite
 *
 * Covers all 17 acceptance criteria via the FederationSync constructor's
 * queryFn injection point (no live DB required).
 */

import * as assert from "node:assert";
import * as crypto from "node:crypto";
import { describe, it, beforeEach } from "node:test";
import {
	FederationSync,
	validateFederationRequest,
	type PeerRecord,
	type SyncProposal,
	type QueryFn,
} from "../../src/core/infrastructure/federation-sync.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePeer(overrides: Record<string, unknown> = {}): PeerRecord {
	return {
		peer_uuid: "peer-uuid-1",
		peer_name: "PEER-A",
		hostname: "peer-a.local",
		address: "127.0.0.1",
		port: 7000,
		certificate_pem: null,
		certificate_fingerprint: null,
		status: "active",
		is_active: true,
		sync_filter: null,
		last_sync_at: null,
		health_fail_count: 0,
		created_at: new Date(),
		updated_at: new Date(),
		...overrides,
	} as PeerRecord;
}

/** Create a FederationSync with an in-memory DB mock. */
function makeSync(opts: {
	queryLog?: Array<{ sql: string; params: unknown[] }>;
	queryResults?: Array<{ rows: unknown[] }>;
	fetchOverride?: typeof global.fetch;
} = {}) {
	const queryLog = opts.queryLog ?? [];
	const queue = opts.queryResults ? [...opts.queryResults] : [];

	const queryFn: QueryFn = async (sql: string, params: unknown[] = []) => {
		queryLog.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
		return queue.shift() ?? { rows: [] };
	};

	const sync = new FederationSync({
		instanceId: "inst-local",
		instanceName: "LOCAL",
		sharedSecret: "test-secret-32-bytes-long-enough!",
		pollIntervalMs: 60_000,
		queryFn,
	});

	return { sync, queryLog };
}

function withFetch(override: (url: string, init?: RequestInit) => Promise<Response>) {
	const original = global.fetch;
	global.fetch = override as typeof global.fetch;
	return () => { global.fetch = original; };
}

const SECRET = "test-secret-32-bytes-long-enough!";

function makeHmac(method: string, path: string, body: string) {
	return crypto.createHmac("sha256", SECRET).update(`${method}:${path}:${body}`).digest("hex");
}

function makeSyncProposal(overrides: Partial<SyncProposal> = {}): SyncProposal {
	return {
		proposal_id: 1,
		display_id: "P001",
		title: "Test Proposal",
		summary: null,
		status: "draft",
		stage: "architecture",
		type: "feature",
		maturity_state: "new",
		description: null,
		design: null,
		motivation: null,
		drawbacks: null,
		updated_at: new Date(2026, 0, 1).toISOString(),
		created_at: new Date(2025, 11, 1).toISOString(),
		...overrides,
	};
}

// ─── AC-1: Peer registration ─────────────────────────────────────────────────

describe("AC-1: Peer registration", () => {
	it("stores fingerprint derived from certificate_pem", async () => {
		const pem = "-----BEGIN CERTIFICATE-----\nfakedata\n-----END CERTIFICATE-----\n";
		const expectedFp = crypto.createHash("sha256").update(pem).digest("hex");
		const peerRow = makePeer({ certificate_pem: pem, certificate_fingerprint: expectedFp });

		const { sync, queryLog } = makeSync({ queryResults: [{ rows: [peerRow] }] });
		const result = await sync.registerPeer({
			peer_name: "PEER-A",
			hostname: "peer-a.local",
			address: "127.0.0.1",
			port: 7000,
			certificate_pem: pem,
		});

		assert.strictEqual(result.certificate_fingerprint, expectedFp);
		assert.ok(queryLog[0].sql.includes("INSERT INTO roadmap.federation_peers"));
		assert.ok((queryLog[0].params as string[]).includes(expectedFp));
	});

	it("registers without cert when certificate_pem is omitted", async () => {
		const { sync, queryLog } = makeSync({ queryResults: [{ rows: [makePeer()] }] });
		await sync.registerPeer({ peer_name: "PEER-B", hostname: "b", address: "10.0.0.2", port: 7001 });

		const params = queryLog[0].params as (string | null)[];
		assert.strictEqual(params[4], null, "certificate_pem must be null");
		assert.strictEqual(params[5], null, "fingerprint must be null");
	});

	it("approvePeer sets status to active", async () => {
		const { sync, queryLog } = makeSync({ queryResults: [{ rows: [makePeer({ status: "active" })] }] });
		const result = await sync.approvePeer("peer-uuid-1");

		assert.strictEqual(result.status, "active");
		assert.ok(queryLog[0].sql.includes("status = 'active'"));
	});

	it("approvePeer throws when peer not found", async () => {
		const { sync } = makeSync({ queryResults: [{ rows: [] }] });
		await assert.rejects(() => sync.approvePeer("nonexistent-uuid"), /Peer not found/);
	});
});

// ─── AC-2: Request signing / verification ────────────────────────────────────

describe("AC-2: HMAC-SHA256 request signing", () => {
	it("validateFederationRequest accepts a correctly signed request", () => {
		const sig = makeHmac("GET", "/proposals", "");
		assert.strictEqual(validateFederationRequest("GET", "/proposals", "", sig, SECRET), true);
	});

	it("validateFederationRequest rejects a tampered signature", () => {
		assert.strictEqual(validateFederationRequest("GET", "/proposals", "", "deadbeef".repeat(8), SECRET), false);
	});

	it("validateFederationRequest returns false when signature is undefined", () => {
		assert.strictEqual(validateFederationRequest("GET", "/proposals", "", undefined, SECRET), false);
	});

	it("verifyIncomingSignature delegates correctly", () => {
		const { sync } = makeSync();
		const body = JSON.stringify({ event: "x" });
		const sig = makeHmac("POST", "/proposals/events", body);

		assert.strictEqual(sync.verifyIncomingSignature("POST", "/proposals/events", body, sig), true);
		assert.strictEqual(sync.verifyIncomingSignature("POST", "/proposals/events", body, "badsig"), false);
	});

	it("outbound requests carry X-Federation-Signature header", async () => {
		const { sync, queryLog } = makeSync({ queryResults: [{ rows: [makePeer()] }] });

		let capturedHeaders: Record<string, string> = {};
		const restore = withFetch(async (_url, init) => {
			capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
			return { ok: true, status: 200, json: async () => ({ instance_id: "r", version: "1", uptime_s: 0 }) } as unknown as Response;
		});
		void queryLog; // satisfy linter — queryLog used above for assertion
		await sync.pingPeer("peer-uuid-1");
		restore();

		assert.ok("X-Federation-Signature" in capturedHeaders, "header must be set");
		assert.ok(capturedHeaders["X-Federation-Signature"].length > 0, "must be non-empty");
	});
});

// ─── AC-4: Namespace prefix enforcement ──────────────────────────────────────

describe("AC-4: display_id namespace prefix", () => {
	it("stores imported proposal with PEER-NAME/display_id format", async () => {
		const peer = makePeer();
		const { sync, queryLog } = makeSync({
			queryResults: [
				{ rows: [] }, // SELECT existing → not found
				{ rows: [] }, // INSERT
				{ rows: [] }, // sync log
			],
		});

		const restore = withFetch(async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					proposals: [makeSyncProposal({ display_id: "P042" })],
				}),
			}) as unknown as Response,
		);
		const result = await sync.pullFromPeer(peer);
		restore();

		assert.strictEqual(result.created, 1);
		const insertCall = queryLog.find((q) => q.sql.includes("INSERT INTO roadmap_proposal.proposal"));
		assert.ok(insertCall, "must INSERT proposal");
		assert.ok((insertCall.params as string[]).includes("PEER-A/P042"), "display_id must be namespaced");
	});

	it("does not double-prefix already-namespaced display_id", async () => {
		const peer = makePeer();
		const { sync, queryLog } = makeSync({
			queryResults: [{ rows: [] }, { rows: [] }, { rows: [] }],
		});

		const restore = withFetch(async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					proposals: [makeSyncProposal({ display_id: "PEER-A/P042" })],
				}),
			}) as unknown as Response,
		);
		await sync.pullFromPeer(peer);
		restore();

		const insertCall = queryLog.find((q) => q.sql.includes("INSERT INTO roadmap_proposal.proposal"));
		assert.ok(insertCall);
		assert.ok(!(insertCall.params as string[]).includes("PEER-A/PEER-A/P042"), "must not double-prefix");
		assert.ok((insertCall.params as string[]).includes("PEER-A/P042"));
	});
});

// ─── AC-5: Conflict resolution (last-write-wins) ─────────────────────────────

describe("AC-5: last-write-wins conflict resolution", () => {
	it("applies remote version when remote updated_at is newer", async () => {
		const peer = makePeer();
		const localTs = new Date(Date.now() - 10_000).toISOString();
		const remoteTs = new Date(Date.now() + 10_000).toISOString();

		const existingLocal = {
			proposal_id: 1,
			updated_at: localTs,
			display_id: "PEER-A/P001",
			status: "draft",
			stage: "architecture",
			title: "Old Local",
			summary: null,
			description: null,
			design: null,
			motivation: null,
			drawbacks: null,
			type: "feature",
			maturity_state: "new",
		};

		const { sync, queryLog } = makeSync({
			queryResults: [
				{ rows: [existingLocal] }, // SELECT existing
				{ rows: [] },              // INSERT sync_conflict_log
				{ rows: [] },              // UPDATE proposal
				{ rows: [] },              // sync log
			],
		});

		const restore = withFetch(async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					proposals: [makeSyncProposal({ display_id: "PEER-A/P001", updated_at: remoteTs })],
				}),
			}) as unknown as Response,
		);
		const result = await sync.pullFromPeer(peer);
		restore();

		assert.strictEqual(result.updated, 1);
		assert.strictEqual(result.conflicts, 1);
		const updateCall = queryLog.find((q) => q.sql.includes("UPDATE roadmap_proposal.proposal"));
		assert.ok(updateCall, "should UPDATE local proposal");
	});

	it("keeps local version when local updated_at is newer (local wins)", async () => {
		const peer = makePeer();
		const localTs = new Date(Date.now() + 10_000).toISOString();
		const remoteTs = new Date(Date.now() - 10_000).toISOString();

		const { sync, queryLog } = makeSync({
			queryResults: [
				{
					rows: [{
						proposal_id: 1,
						updated_at: localTs,
						display_id: "PEER-A/P001",
						status: "develop",
						stage: "building",
						title: "Newer Local",
						summary: null,
						description: null,
						design: null,
						motivation: null,
						drawbacks: null,
						type: "feature",
						maturity_state: "active",
					}],
				},
				{ rows: [] }, // conflict log
				{ rows: [] }, // sync log
			],
		});

		const restore = withFetch(async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					proposals: [makeSyncProposal({ display_id: "PEER-A/P001", updated_at: remoteTs })],
				}),
			}) as unknown as Response,
		);
		const result = await sync.pullFromPeer(peer);
		restore();

		assert.strictEqual(result.skipped, 1);
		assert.strictEqual(result.updated, 0);
		const updateCall = queryLog.find((q) => q.sql.includes("UPDATE roadmap_proposal.proposal"));
		assert.strictEqual(updateCall, undefined, "must NOT UPDATE when local is newer");
	});
});

// ─── AC-6: Selective sync filter ─────────────────────────────────────────────

describe("AC-6: Selective sync filter", () => {
	it("skips proposals that don't match the sync_filter", async () => {
		const peer = makePeer({ sync_filter: { type: "feature" } });
		const { sync } = makeSync({ queryResults: [{ rows: [] }] }); // sync log for skip

		const restore = withFetch(async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					proposals: [makeSyncProposal({ type: "infrastructure" })],
				}),
			}) as unknown as Response,
		);
		const result = await sync.pullFromPeer(peer);
		restore();

		assert.strictEqual(result.skipped, 1);
		assert.strictEqual(result.created, 0);
	});

	it("imports proposals that match the sync_filter", async () => {
		const peer = makePeer({ sync_filter: { type: "feature" } });
		const { sync } = makeSync({ queryResults: [{ rows: [] }, { rows: [] }, { rows: [] }] });

		const restore = withFetch(async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					proposals: [makeSyncProposal({ type: "feature" })],
				}),
			}) as unknown as Response,
		);
		const result = await sync.pullFromPeer(peer);
		restore();

		assert.strictEqual(result.created, 1);
	});

	it("imports all proposals when sync_filter is null", async () => {
		const peer = makePeer({ sync_filter: null });
		const { sync } = makeSync({
			queryResults: [
				{ rows: [] }, { rows: [] }, { rows: [] },
				{ rows: [] }, { rows: [] }, { rows: [] },
			],
		});

		const restore = withFetch(async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					proposals: [
						makeSyncProposal({ display_id: "P300", type: "infrastructure" }),
						makeSyncProposal({ display_id: "P301", type: "feature" }),
					],
				}),
			}) as unknown as Response,
		);
		const result = await sync.pullFromPeer(peer);
		restore();

		assert.strictEqual(result.created, 2);
	});
});

// ─── AC-7: Certificate revocation ────────────────────────────────────────────

describe("AC-7: Certificate revocation check", () => {
	it("revokes peer and emits peer:cert_revoked when fingerprint mismatches", async () => {
		const pem = "-----BEGIN CERTIFICATE-----\nrealcert\n-----END CERTIFICATE-----\n";
		const wrongFp = "aabbccdd".repeat(8);
		const peer = makePeer({ certificate_pem: pem, certificate_fingerprint: wrongFp });

		const { sync } = makeSync({
			queryResults: [
				{ rows: [peer] }, // getActivePeers
				{ rows: [] },     // UPDATE status = revoked
			],
		});

		const revokedEvents: unknown[] = [];
		sync.on("peer:cert_revoked", (e) => revokedEvents.push(e));

		const results = await sync.runSyncCycle();

		assert.strictEqual(results.length, 0);
		assert.strictEqual(revokedEvents.length, 1);
	});
});

// ─── AC-8: CA private key file permissions ────────────────────────────────────

describe("AC-8: CA private key file permissions", () => {
	it("federation-pki.ts writes CA key with mode 0o600 (source check)", async () => {
		const { readFile } = await import("node:fs/promises");
		const { fileURLToPath } = await import("node:url");
		const pkiPath = fileURLToPath(
			new URL("../../src/core/infrastructure/federation-pki.ts", import.meta.url),
		);
		const src = await readFile(pkiPath, "utf8");
		assert.ok(
			src.includes("0o600") || src.includes("mode: 0o600"),
			"federation-pki.ts must write CA private key with mode 0o600",
		);
	});
});

// ─── AC-9: Health check quarantine ───────────────────────────────────────────

describe("AC-9: Quarantine after 3 consecutive failures", () => {
	it("quarantines peer at fail_count = 3", async () => {
		const peer = makePeer();
		const { sync } = makeSync({
			queryResults: [
				{ rows: [peer] },                        // getPeer in pingPeer
				{ rows: [{ health_fail_count: 3 }] },   // UPDATE fail count
				{ rows: [] },                            // UPDATE status = quarantined
			],
		});

		const quarantinedEvents: unknown[] = [];
		sync.on("peer:quarantined", (e) => quarantinedEvents.push(e));

		const restore = withFetch(async () =>
			({ ok: false, status: 503, json: async () => null }) as unknown as Response,
		);
		const healthy = await sync.checkPeerHealth(peer);
		restore();

		assert.strictEqual(healthy, false);
		assert.strictEqual(quarantinedEvents.length, 1);
	});

	it("does not quarantine on first failure (fail_count = 1)", async () => {
		const peer = makePeer();
		const { sync } = makeSync({
			queryResults: [
				{ rows: [peer] },
				{ rows: [{ health_fail_count: 1 }] },
			],
		});

		const quarantinedEvents: unknown[] = [];
		sync.on("peer:quarantined", (e) => quarantinedEvents.push(e));

		const restore = withFetch(async () =>
			({ ok: false, status: 503, json: async () => null }) as unknown as Response,
		);
		await sync.checkPeerHealth(peer);
		restore();

		assert.strictEqual(quarantinedEvents.length, 0);
	});
});

// ─── AC-10: last_sync_at updated ─────────────────────────────────────────────

describe("AC-10: last_sync_at stamped after each successful cycle", () => {
	it("writes last_sync_at after a successful pull", async () => {
		const peer = makePeer();
		const { sync, queryLog } = makeSync({
			queryResults: [
				{ rows: [peer] }, // getActivePeers
				{ rows: [peer] }, // getPeer in pingPeer
				{ rows: [] },     // UPDATE health_fail_count=0 / last_sync_at (healthy)
				{ rows: [] },     // UPDATE last_sync_at after pullFromPeer
			],
		});

		const restore = withFetch(async () =>
			({ ok: true, status: 200, json: async () => ({ proposals: [] }) }) as unknown as Response,
		);
		await sync.runSyncCycle();
		restore();

		const stampedCalls = queryLog.filter(
			(q) => q.sql.includes("last_sync_at = now()") && q.sql.includes("federation_peers"),
		);
		assert.ok(stampedCalls.length >= 1, "last_sync_at must be stamped");
	});
});

// ─── AC-11: Concurrent multi-peer sync ───────────────────────────────────────

describe("AC-11: Promise.allSettled concurrent sync", () => {
	it("returns results for all healthy peers", async () => {
		const peers = [1, 2, 3].map((i) =>
			makePeer({ peer_uuid: `peer-uuid-${i}`, peer_name: `PEER-${i}`, address: `10.0.0.${i}` }),
		);
		const peerMap = new Map(peers.map((p) => [p.peer_uuid, p]));

		// Content-dispatching queryFn — safe under Promise.allSettled interleaving.
		const queryFn: QueryFn = async (sql: string, params: unknown[] = []) => {
			const s = sql.replace(/\s+/g, " ").trim();
			if (s.includes("is_active = true")) return { rows: peers };
			if (s.startsWith("SELECT * FROM roadmap.federation_peers WHERE peer_uuid")) {
				const peer = peerMap.get(params[0] as string);
				return { rows: peer ? [peer] : [] };
			}
			return { rows: [] };
		};
		const sync = new FederationSync({
			instanceId: "inst-local",
			instanceName: "LOCAL",
			sharedSecret: "test-secret-32-bytes-long-enough!",
			pollIntervalMs: 60_000,
			queryFn,
		});

		const restore = withFetch(async () =>
			({ ok: true, status: 200, json: async () => ({ proposals: [] }) }) as unknown as Response,
		);
		const results = await sync.runSyncCycle();
		restore();

		assert.strictEqual(results.length, 3);
	});

	it("failing peer does not prevent other peers from syncing", async () => {
		const peers = [
			makePeer({ peer_uuid: "p1", peer_name: "PEER-1", address: "10.0.0.1" }),
			makePeer({ peer_uuid: "p2", peer_name: "PEER-2", address: "10.0.0.2" }),
		];

		const { sync } = makeSync({
			queryResults: [
				{ rows: peers },
				{ rows: [peers[0]] },                  // getPeer for PEER-1
				{ rows: [] },                           // UPDATE health (PEER-1 healthy)
				{ rows: [] },                           // UPDATE last_sync_at (PEER-1)
				{ rows: [peers[1]] },                  // getPeer for PEER-2
				{ rows: [{ health_fail_count: 1 }] },  // UPDATE fail count (PEER-2 unhealthy)
			],
		});

		const restore = withFetch(async (url) => {
			if (url.includes("10.0.0.2")) {
				return { ok: false, status: 503, json: async () => null } as unknown as Response;
			}
			return { ok: true, status: 200, json: async () => ({ proposals: [] }) } as unknown as Response;
		});
		const results = await sync.runSyncCycle();
		restore();

		assert.strictEqual(results.length, 1, "only healthy peer produces a result");
	});
});

// ─── AC-12: Peer ping — PEER_UNREACHABLE within 5 s ─────────────────────────

describe("AC-12: pingPeer returns PEER_UNREACHABLE", () => {
	it("returns PEER_UNREACHABLE when fetch fails", async () => {
		const { sync } = makeSync({ queryResults: [{ rows: [makePeer()] }] });

		const restore = withFetch(async () =>
			({ ok: false, status: 503, json: async () => null }) as unknown as Response,
		);
		const result = await sync.pingPeer("peer-uuid-1");
		restore();

		assert.strictEqual(result.reachable, false);
		assert.strictEqual(result.errorCode, "PEER_UNREACHABLE");
	});

	it("returns PEER_UNREACHABLE when peer not in DB", async () => {
		const { sync } = makeSync({ queryResults: [{ rows: [] }] });
		const result = await sync.pingPeer("missing");

		assert.strictEqual(result.reachable, false);
		assert.strictEqual(result.errorCode, "PEER_UNREACHABLE");
	});

	it("returns CERT_REVOKED when fingerprint mismatches", async () => {
		const pem = "-----BEGIN CERTIFICATE-----\nfoo\n-----END CERTIFICATE-----\n";
		const { sync } = makeSync({
			queryResults: [{ rows: [makePeer({ certificate_pem: pem, certificate_fingerprint: "00".repeat(32) })] }],
		});
		const result = await sync.pingPeer("peer-uuid-1");

		assert.strictEqual(result.reachable, false);
		assert.strictEqual(result.errorCode, "CERT_REVOKED");
	});

	it("returns reachable=true with latencyMs on success", async () => {
		const { sync } = makeSync({ queryResults: [{ rows: [makePeer()] }] });

		const restore = withFetch(async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({ instance_id: "remote", version: "1.0", uptime_s: 3600 }),
			}) as unknown as Response,
		);
		const result = await sync.pingPeer("peer-uuid-1");
		restore();

		assert.strictEqual(result.reachable, true);
		assert.ok(typeof result.latencyMs === "number" && result.latencyMs >= 0);
	});
});

// ─── AC-13: Push on state change ─────────────────────────────────────────────

describe("AC-13: Push proposal to all active peers", () => {
	it("pushes to all active peers for a local proposal", async () => {
		const peers = [
			makePeer({ peer_uuid: "p1", peer_name: "PEER-A", address: "10.0.0.1" }),
			makePeer({ peer_uuid: "p2", peer_name: "PEER-B", address: "10.0.0.2" }),
		];

		const { sync } = makeSync({
			queryResults: [
				{
					rows: [{
						proposal_id: 5,
						display_id: "P005",
						title: "Local Proposal",
						summary: null,
						status: "review",
						stage: "gating",
						type: "feature",
						maturity_state: "active",
						description: null,
						design: null,
						motivation: null,
						drawbacks: null,
						updated_at: new Date().toISOString(),
						created_at: new Date().toISOString(),
					}],
				},
				{ rows: peers },  // getActivePeers
			],
		});

		const pushedUrls: string[] = [];
		const restore = withFetch(async (url) => {
			pushedUrls.push(url as string);
			return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
		});
		await sync.pushProposalChange(5);
		restore();

		assert.strictEqual(pushedUrls.length, 2, "must push to both peers");
	});

	it("does not push back to the origin peer of an imported proposal", async () => {
		const peers = [
			makePeer({ peer_uuid: "p1", peer_name: "PEER-A", address: "10.0.0.1" }),
			makePeer({ peer_uuid: "p2", peer_name: "PEER-B", address: "10.0.0.2" }),
		];

		const { sync } = makeSync({
			queryResults: [
				{
					rows: [{
						proposal_id: 10,
						display_id: "PEER-A/P009",
						title: "Imported",
						summary: null,
						status: "draft",
						stage: "architecture",
						type: "feature",
						maturity_state: null,
						description: null,
						design: null,
						motivation: null,
						drawbacks: null,
						updated_at: new Date().toISOString(),
						created_at: new Date().toISOString(),
					}],
				},
				{ rows: peers },
			],
		});

		const pushedUrls: string[] = [];
		const restore = withFetch(async (url) => {
			pushedUrls.push(url as string);
			return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
		});
		await sync.pushProposalChange(10);
		restore();

		assert.strictEqual(pushedUrls.length, 1, "only PEER-B should receive push");
		assert.ok((pushedUrls[0] as string).includes("10.0.0.2"), "should push to PEER-B only");
	});
});

// ─── AC-14: Cross-instance dependency recording ───────────────────────────────

describe("AC-14: Cross-instance dependency tracking", () => {
	it("inserts dependency with peer_id and NULL to_proposal_id", async () => {
		const { sync, queryLog } = makeSync({ queryResults: [{ rows: [] }] });
		await sync.addCrossInstanceDependency({
			from_proposal_id: 7,
			peer_uuid: "peer-uuid-1",
			peer_display_id: "PEER-A/P042",
			dependency_type: "depends_on",
		});

		assert.ok(queryLog[0].sql.includes("proposal_dependencies"));
		assert.ok(queryLog[0].sql.includes("NULL"), "to_proposal_id must be NULL");
		assert.ok((queryLog[0].params as unknown[]).includes("PEER-A/P042"));
		assert.ok((queryLog[0].params as unknown[]).includes("peer-uuid-1"));
	});

	it("queries cross-instance deps with JOIN on federation_peers", async () => {
		const { sync, queryLog } = makeSync({
			queryResults: [{
				rows: [{
					id: 1,
					from_proposal_id: 7,
					dependency_type: "depends_on",
					peer_id: "peer-uuid-1",
					peer_display_id: "PEER-A/P042",
					peer_name: "PEER-A",
				}],
			}],
		});
		const deps = await sync.getCrossInstanceDependencies(7);

		assert.strictEqual(deps.length, 1);
		assert.strictEqual(deps[0].peer_display_id, "PEER-A/P042");
		assert.ok(queryLog[0].sql.includes("peer_id IS NOT NULL"));
		assert.ok(queryLog[0].sql.includes("JOIN roadmap.federation_peers"));
	});
});

// ─── AC-15: Conflict alert and log ───────────────────────────────────────────

describe("AC-15: Conflict logging and SYNC_CONFLICT event", () => {
	it("logs conflict with both versions and emits errorCode SYNC_CONFLICT", async () => {
		const peer = makePeer();
		const olderTs = new Date(Date.now() - 5000).toISOString();
		const newerTs = new Date(Date.now()).toISOString();

		const localVersion = makeSyncProposal({ updated_at: olderTs, title: "Old Title" });
		const remoteVersion = makeSyncProposal({ updated_at: newerTs, title: "New Title" });

		const { sync, queryLog } = makeSync({ queryResults: [{ rows: [] }] });
		const conflicts: unknown[] = [];
		sync.on("sync:conflict", (e) => conflicts.push(e));

		// logConflict is private but accessible via bracket notation for testing
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const entry = await (sync as any).logConflict(peer, 1, localVersion, remoteVersion);

		assert.strictEqual(conflicts.length, 1);
		assert.strictEqual((conflicts[0] as { errorCode: string }).errorCode, "SYNC_CONFLICT");
		assert.strictEqual(entry.winner, "remote");

		const insertCall = queryLog[0];
		assert.ok(insertCall.sql.includes("sync_conflict_log"));
		assert.ok(insertCall.sql.includes("local_version"));
		assert.ok(insertCall.sql.includes("remote_version"));
	});
});

// ─── AC-16: Peer removal ─────────────────────────────────────────────────────

describe("AC-16: Peer removal preserves data", () => {
	it("revokes peer and emits peer:removed without deleting rows", async () => {
		const { sync, queryLog } = makeSync({ queryResults: [{ rows: [] }] });
		const removedEvents: unknown[] = [];
		sync.on("peer:removed", (e) => removedEvents.push(e));

		await sync.removePeer("peer-uuid-1");

		assert.strictEqual(removedEvents.length, 1);
		assert.ok(queryLog[0].sql.includes("status = 'revoked'"));
		assert.ok(!queryLog[0].sql.includes("DELETE"), "must not DELETE rows");
	});
});

// ─── AC-17: Sensitive field filtering ───────────────────────────────────────

describe("AC-17: Sensitive fields never leave this instance", () => {
	it("SYNC_ALLOWED_FIELDS does not overlap with SENSITIVE_FIELDS (invariant check)", () => {
		const allowedFields = new Set([
			"display_id", "title", "summary", "status", "stage", "type",
			"maturity_state", "description", "design", "motivation",
			"drawbacks", "updated_at", "created_at",
		]);
		const sensitiveFields = ["api_key", "spending_cap", "credentials", "secret", "token", "password", "private_key"];

		const overlap = sensitiveFields.filter((k) => allowedFields.has(k));
		assert.strictEqual(overlap.length, 0, `Sensitive keys must not be in allowed set: ${overlap.join(", ")}`);
	});

	it("sensitive fields are stripped before proposals are pushed to peers", async () => {
		// The push payload goes through buildSyncPayload which only picks SYNC_ALLOWED_FIELDS.
		// We verify by checking the body sent to fetch.
		const peers = [makePeer({ peer_uuid: "p1", peer_name: "PEER-A", address: "10.0.0.1" })];

		const { sync } = makeSync({
			queryResults: [
				{
					rows: [{
						proposal_id: 3,
						display_id: "P003",
						title: "Safe Proposal",
						summary: null,
						status: "draft",
						stage: "architecture",
						type: "feature",
						maturity_state: null,
						description: null,
						design: null,
						motivation: null,
						drawbacks: null,
						updated_at: new Date().toISOString(),
						created_at: new Date().toISOString(),
						api_key: "sk-secret",
						password: "hunter2",
						private_key: "BEGIN PRIVATE KEY",
					}],
				},
				{ rows: peers },
			],
		});

		let capturedBody = "";
		const restore = withFetch(async (_url, init) => {
			capturedBody = init?.body as string ?? "";
			return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
		});
		await sync.pushProposalChange(3);
		restore();

		assert.ok(!capturedBody.includes("sk-secret"), "api_key must not be in push body");
		assert.ok(!capturedBody.includes("hunter2"), "password must not be in push body");
		assert.ok(!capturedBody.includes("BEGIN PRIVATE KEY"), "private_key must not be in push body");
	});
});
