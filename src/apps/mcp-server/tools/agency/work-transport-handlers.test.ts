/**
 * P1385: MCP agency work transport handlers tests
 *
 * Unit tests for agency_subscribe, agency_submit_result, agency_heartbeat.
 * Tests input validation and auth without live DB (mocking is complex; live tests come next).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as workTransport from "./work-transport-handlers.ts";

describe("P1385: Work transport handlers", () => {
	beforeEach(() => {
		// Clear env for each test
		delete process.env.MCP_AGENCY_AUTH;
	});

	describe("verifyAgencyBearer", () => {
		it("should allow all requests when MCP_AGENCY_AUTH=off (default)", async () => {
			const result = await workTransport.verifyAgencyBearer("test-agency", undefined);
			expect(result.ok).toBe(true);
		});

		it("should reject missing auth header when MCP_AGENCY_AUTH=on", async () => {
			process.env.MCP_AGENCY_AUTH = "on";
			const result = await workTransport.verifyAgencyBearer("test-agency", undefined);
			expect(result.ok).toBe(false);
			expect(result.status).toBe(401);
			expect(result.reason).toBe("missing_authorization");
		});

		it("should reject invalid bearer format when MCP_AGENCY_AUTH=on", async () => {
			process.env.MCP_AGENCY_AUTH = "on";
			const result = await workTransport.verifyAgencyBearer("test-agency", "InvalidFormat");
			expect(result.ok).toBe(false);
			expect(result.status).toBe(401);
			expect(result.reason).toBe("invalid_bearer_format");
		});

		it("should reject invalid bearer token (bad pattern) when MCP_AGENCY_AUTH=on", async () => {
			process.env.MCP_AGENCY_AUTH = "on";
			const result = await workTransport.verifyAgencyBearer("test-agency", "Bearer");
			expect(result.ok).toBe(false);
			expect(result.status).toBe(401);
		});
	});

	describe("handleAgencySubscribe input validation", () => {
		it("should throw error if agency_identity missing", async () => {
			await expect(
				workTransport.handleAgencySubscribe({ agency_identity: "" }),
			).rejects.toThrow("agency_identity is required");
		});

		it("should throw error if agency_identity undefined", async () => {
			await expect(
				workTransport.handleAgencySubscribe({ agency_identity: undefined as any }),
			).rejects.toThrow("agency_identity is required");
		});
	});

	describe("handleAgencySubmitResult input validation", () => {
		it("should throw error if dispatch_id undefined", async () => {
			await expect(
				workTransport.handleAgencySubmitResult({
					dispatch_id: undefined as any,
					claim_token: "uuid",
					status: "completed",
					duration_ms: 1000,
				}),
			).rejects.toThrow("dispatch_id is required");
		});

		it("should throw error if claim_token missing", async () => {
			await expect(
				workTransport.handleAgencySubmitResult({
					dispatch_id: 123n,
					claim_token: "",
					status: "completed",
					duration_ms: 1000,
				}),
			).rejects.toThrow("claim_token is required");
		});

		it("should throw error if status invalid", async () => {
			await expect(
				workTransport.handleAgencySubmitResult({
					dispatch_id: 123n,
					claim_token: "uuid",
					status: "invalid" as any,
					duration_ms: 1000,
				}),
			).rejects.toThrow("status must be 'completed' or 'failed'");
		});

		it("should throw error if duration_ms missing", async () => {
			await expect(
				workTransport.handleAgencySubmitResult({
					dispatch_id: 123n,
					claim_token: "uuid",
					status: "completed",
					duration_ms: undefined as any,
				}),
			).rejects.toThrow("duration_ms is required");
		});
	});

	describe("handleAgencyHeartbeat input validation", () => {
		it("should throw error if dispatch_id undefined", async () => {
			await expect(
				workTransport.handleAgencyHeartbeat({
					dispatch_id: undefined as any,
					claim_token: "uuid",
				}),
			).rejects.toThrow("dispatch_id is required");
		});

		it("should throw error if claim_token missing", async () => {
			await expect(
				workTransport.handleAgencyHeartbeat({
					dispatch_id: 123n,
					claim_token: "",
				}),
			).rejects.toThrow("claim_token is required");
		});
	});
});
