/**
 * Tests for Liaison Service — P464 Agency Registration and Dormancy
 *
 * AC coverage:
 * 1. Agency schema: agency_id, display_name, provider, host_id, status, last_heartbeat_at
 * 2. Liaison session: session_id, agency_id, liaison_pid, liaison_host, started_at, ended_at, end_reason
 * 3. Registration handshake: liaison_register returns session token
 * 4. Heartbeat updates last_heartbeat_at and resets status
 * 5. Dormancy state machine: active ↔ throttled, dormant on 90s silence, reactivate
 * 6. v_agency_status view: correct silence, dispatchable flag
 * 7. Retired agencies excluded from dispatch
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { query } from "../postgres/pool.js";
import {
  liaisonRegister,
  liaisonHeartbeat,
  checkAndMarkDormant,
  agencyReactivate,
  endLiaisonSession,
  getAgencyStatus,
  listDispatchableAgencies,
} from "./liaison-service.js";

describe("Liaison Service (P464)", () => {
  const testAgencyId = "test/agency-p464-test";
  const testHostId = "hermes";  // Use existing host from host_model_policy

  beforeEach(async () => {
    // Host 'hermes' already exists in roadmap.host_model_policy
  });

  afterEach(async () => {
    // Clean up test data
    await query(`DELETE FROM roadmap.agency_liaison_session WHERE agency_id LIKE 'test/%'`);
    await query(`DELETE FROM roadmap.agency WHERE agency_id LIKE 'test/%'`);
  });

  describe("AC1: Agency schema", () => {
    it("should create agency with all required fields", async () => {
      const result = await liaisonRegister({
        agency_id: testAgencyId,
        display_name: "Test Agency",
        provider: "test-provider",
        host_id: testHostId,
        capabilities: ["cubic", "dispatch"],
        metadata: { test: true },
      });

      assert.strictEqual(result.agency_id, testAgencyId);
      assert.strictEqual(result.status, "active");
      assert(result.session_id);

      const agency = await query(
        `SELECT * FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );

      assert.strictEqual(agency.rows.length, 1);
      const row = agency.rows[0];
      assert.strictEqual(row.agency_id, testAgencyId);
      assert.strictEqual(row.display_name, "Test Agency");
      assert.strictEqual(row.provider, "test-provider");
      assert.strictEqual(row.host_id, testHostId);
      assert.strictEqual(row.status, "active");
      assert.deepStrictEqual(row.capability_tags, ["cubic", "dispatch"]);
      assert(row.registered_at);
    });
  });

  describe("AC2: Agency liaison session", () => {
    it("should create session on registration", async () => {
      const result = await liaisonRegister({
        agency_id: testAgencyId,
        display_name: "Test Agency",
        provider: "test-provider",
        host_id: testHostId,
      });

      const sessions = await query(
        `SELECT * FROM roadmap.agency_liaison_session WHERE session_id = $1`,
        [result.session_id]
      );

      assert.strictEqual(sessions.rows.length, 1);
      const session = sessions.rows[0];
      assert.strictEqual(session.agency_id, testAgencyId);
      assert(session.started_at);
      assert(!session.ended_at);
    });
  });

  describe("AC3: Registration handshake", () => {
    it("should return session token and validate host_id", async () => {
      const result = await liaisonRegister({
        agency_id: testAgencyId,
        display_name: "Test Agency",
        provider: "anthropic",
        host_id: testHostId,
        capabilities: ["propose", "develop"],
        capacity_envelope: { max_cubics: 5 },
        public_key: "test-public-key-123",
      });

      assert.strictEqual(typeof result.session_id, "string");
      assert(result.session_id.length > 0);
      assert.strictEqual(result.agency_id, testAgencyId);

      const agency = await query(
        `SELECT metadata FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );
      const metadata = agency.rows[0].metadata;
      assert.strictEqual(metadata.capacity_envelope.max_cubics, 5);
    });

    it("should reject invalid agency_id", async () => {
      try {
        await liaisonRegister({
          agency_id: "",
          display_name: "Test",
          provider: "test",
          host_id: testHostId,
        });
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert(err.message.includes("agency_id is required"));
      }
    });
  });

  describe("AC4: Heartbeat updates", () => {
    it("should update last_heartbeat_at on heartbeat", async () => {
      const reg = await liaisonRegister({
        agency_id: testAgencyId,
        display_name: "Test",
        provider: "test",
        host_id: testHostId,
      });

      // Get initial heartbeat
      const before = await query(
        `SELECT last_heartbeat_at FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );
      const initialHeartbeat = before.rows[0].last_heartbeat_at;

      // Wait and send heartbeat
      await new Promise((r) => setTimeout(r, 100));

      const hb = await liaisonHeartbeat({
        session_id: reg.session_id,
        status: "active",
        capacity_envelope: { free_slots: 3 },
      });

      assert.strictEqual(hb.success, true);
      assert.strictEqual(hb.agency_status, "active");

      // Verify timestamp changed
      const after = await query(
        `SELECT last_heartbeat_at FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );
      assert(after.rows[0].last_heartbeat_at > initialHeartbeat);
    });

    it("should respect liaison-declared status", async () => {
      const reg = await liaisonRegister({
        agency_id: testAgencyId,
        display_name: "Test",
        provider: "test",
        host_id: testHostId,
      });

      await liaisonHeartbeat({
        session_id: reg.session_id,
        status: "throttled",
      });

      const agency = await query(
        `SELECT status FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );
      assert.strictEqual(agency.rows[0].status, "throttled");
    });
  });

  describe("AC5: Dormancy state machine", () => {
    it("should transition active -> dormant on 90s silence", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test', 'test', $2, 'active', now() - interval '91 seconds')`,
        [testAgencyId, testHostId]
      );

      // Mark dormant
      const marked = await checkAndMarkDormant();
      assert(marked > 0);

      const agency = await query(
        `SELECT status, status_reason FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );
      assert.strictEqual(agency.rows[0].status, "dormant");
      assert(agency.rows[0].status_reason.includes("No heartbeat"));
    });

    it("should not mark dormant if within 90s grace", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test', 'test', $2, 'active', now() - interval '45 seconds')`,
        [testAgencyId, testHostId]
      );

      const marked = await checkAndMarkDormant();
      assert.strictEqual(marked, 0);

      const agency = await query(
        `SELECT status FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );
      assert.strictEqual(agency.rows[0].status, "active");
    });

    it("should reactivate dormant agency", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, status_reason)
         VALUES ($1, 'Test', 'test', $2, 'dormant', 'Manual test')`,
        [testAgencyId, testHostId]
      );

      const status = await agencyReactivate(testAgencyId);
      assert.strictEqual(status, "active");

      const agency = await query(
        `SELECT status, status_reason FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );
      assert.strictEqual(agency.rows[0].status, "active");
      assert.strictEqual(agency.rows[0].status_reason, null);
    });

    it("should transition throttled -> dormant on silence", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test', 'test', $2, 'throttled', now() - interval '91 seconds')`,
        [testAgencyId, testHostId]
      );

      await checkAndMarkDormant();

      const agency = await query(
        `SELECT status FROM roadmap.agency WHERE agency_id = $1`,
        [testAgencyId]
      );
      assert.strictEqual(agency.rows[0].status, "dormant");
    });
  });

  describe("AC6: v_agency_status view", () => {
    it("should compute silence_seconds correctly", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test', 'test', $2, 'active', now() - interval '30 seconds')`,
        [testAgencyId, testHostId]
      );

      const status = await query(
        `SELECT silence_seconds FROM roadmap.v_agency_status WHERE agency_id = $1`,
        [testAgencyId]
      );

      const silence = status.rows[0].silence_seconds;
      // Should be ~30, allow 2s variance for execution time
      assert(silence >= 28 && silence <= 32, `Expected ~30s, got ${silence}s`);
    });

    it("should mark dispatchable when active and within 90s", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test', 'test', $2, 'active', now() - interval '30 seconds')`,
        [testAgencyId, testHostId]
      );

      const status = await query(
        `SELECT dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1`,
        [testAgencyId]
      );

      assert.strictEqual(status.rows[0].dispatchable, true);
    });

    it("should not mark dispatchable when dormant", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test', 'test', $2, 'dormant', now() - interval '30 seconds')`,
        [testAgencyId, testHostId]
      );

      const status = await query(
        `SELECT dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1`,
        [testAgencyId]
      );

      assert.strictEqual(status.rows[0].dispatchable, false);
    });
  });

  describe("AC7: Retired agencies excluded from dispatch", () => {
    it("should exclude retired from v_agency_status view", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status)
         VALUES ($1, 'Test', 'test', $2, 'retired')`,
        [testAgencyId, testHostId]
      );

      const result = await query(
        `SELECT * FROM roadmap.v_agency_status WHERE agency_id = $1`,
        [testAgencyId]
      );

      assert.strictEqual(result.rows.length, 0);
    });

    it("should not include retired in dispatchable list", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test', 'test', $2, 'retired', now() - interval '5 seconds')`,
        [testAgencyId, testHostId]
      );

      const agencies = await listDispatchableAgencies();
      assert(!agencies.some((a) => a.agency_id === testAgencyId));
    });
  });

  describe("End liaison session", () => {
    it("should mark session as ended with reason", async () => {
      const reg = await liaisonRegister({
        agency_id: testAgencyId,
        display_name: "Test",
        provider: "test",
        host_id: testHostId,
      });

      await endLiaisonSession(reg.session_id, "normal");

      const session = await query(
        `SELECT ended_at, end_reason FROM roadmap.agency_liaison_session WHERE session_id = $1`,
        [reg.session_id]
      );

      assert(session.rows[0].ended_at);
      assert.strictEqual(session.rows[0].end_reason, "normal");
    });
  });

  describe("Agency helpers", () => {
    it("getAgencyStatus should return current status", async () => {
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test Display', 'test', $2, 'active', now() - interval '15 seconds')`,
        [testAgencyId, testHostId]
      );

      const status = await getAgencyStatus(testAgencyId);
      assert.strictEqual(status?.agency_id, testAgencyId);
      assert.strictEqual(status?.display_name, "Test Display");
      assert.strictEqual(status?.status, "active");
      assert(status?.dispatchable);
    });

    it("listDispatchableAgencies should return eligible agencies", async () => {
      // Add dispatchable
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test1', 'test', $2, 'active', now() - interval '10 seconds')`,
        ["test/agency-1", testHostId]
      );

      // Add dormant (not dispatchable)
      await query(
        `INSERT INTO roadmap.agency
         (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
         VALUES ($1, 'Test2', 'test', $2, 'dormant', now() - interval '100 seconds')`,
        ["test/agency-2", testHostId]
      );

      const list = await listDispatchableAgencies();
      const dispatchable = list.find((a) => a.agency_id === "test/agency-1");
      const dormant = list.find((a) => a.agency_id === "test/agency-2");

      assert(dispatchable);
      assert(!dormant);
    });
  });
});
