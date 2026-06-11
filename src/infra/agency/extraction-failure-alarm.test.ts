import { describe, it, expect, beforeEach } from "vitest";
import {
	checkExtractionFailureAlarm,
	type ExtractionFailureAlarmInput,
} from "./extraction-failure-alarm";

describe("checkExtractionFailureAlarm", () => {
	let mockExec: ReturnType<typeof createMockExecutor>;

	beforeEach(() => {
		mockExec = createMockExecutor();
	});

	it("should not trigger alarm when success rate is OK (< 5% failure)", async () => {
		// Setup: 95 successes, 4 failures = 4.05% failure rate (< 5%)
		// When we add 1 success, becomes 96 successes, 4 failures = ~4.0% (< 5%)
		for (let i = 1; i <= 95; i++) {
			mockExec.addTrackingRun("anthropic", i, i <= 4 ? false : true);
		}

		const result = await checkExtractionFailureAlarm({
			provider: "anthropic",
			agentRunId: 96,
			extractionSuccess: true,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(result.alarmTriggered).toBe(false);
		expect(result.failureRatePercent).toBeLessThan(5.0);
		expect(result.message).toContain("OK");
	});

	it("should trigger alarm when failures exceed 5% threshold", async () => {
		// Setup: 90 successes, 10 failures = 10% failure rate
		// When we add 1 failure, becomes 90 successes, 11 failures = ~10.89% (> 5%)
		for (let i = 1; i <= 90; i++) {
			mockExec.addTrackingRun("anthropic", i, true);
		}
		for (let i = 1; i <= 10; i++) {
			mockExec.addTrackingRun("anthropic", i + 100, false);
		}

		const result = await checkExtractionFailureAlarm({
			provider: "anthropic",
			agentRunId: 111,
			extractionSuccess: false,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(result.alarmTriggered).toBe(true);
		expect(result.failureRatePercent).toBeGreaterThan(5.0);
		expect(result.message).toContain("Alarm fired");
	});

	it("should suppress alarm if cooldown is active", async () => {
		// First trigger the alarm
		for (let i = 1; i <= 90; i++) {
			mockExec.addTrackingRun("anthropic", i, true);
		}
		for (let i = 1; i <= 10; i++) {
			mockExec.addTrackingRun("anthropic", i + 100, false);
		}

		const result1 = await checkExtractionFailureAlarm({
			provider: "anthropic",
			agentRunId: 111,
			extractionSuccess: false,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(result1.alarmTriggered).toBe(true);

		// Second trigger attempt should be suppressed by cooldown
		const result2 = await checkExtractionFailureAlarm({
			provider: "anthropic",
			agentRunId: 112,
			extractionSuccess: false,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(result2.alarmTriggered).toBe(false);
		expect(result2.message).toContain("cooldown");
	});

	it("should not trigger alarm at exactly 5% threshold", async () => {
		// Setup: exactly 5% failure rate = 200 total, 10 failures (5%)
		// When we add 1 success, becomes 201 total with 10 failures = ~4.975% (< 5%)
		for (let i = 1; i <= 200; i++) {
			mockExec.addTrackingRun(
				"openai",
				i,
				i <= 10 ? false : true
			);
		}

		const result = await checkExtractionFailureAlarm({
			provider: "openai",
			agentRunId: 201,
			extractionSuccess: true,
			exec: mockExec.exec.bind(mockExec),
		});

		// At ~4.975%, should NOT trigger (< 5%)
		expect(result.alarmTriggered).toBe(false);
		expect(result.failureRatePercent).toBeLessThan(5.0);
	});

	it("should track failures per provider independently", async () => {
		// Setup: anthropic at 10% failure, google at 0% failure
		for (let i = 1; i <= 90; i++) {
			mockExec.addTrackingRun("anthropic", i, true);
		}
		for (let i = 1; i <= 10; i++) {
			mockExec.addTrackingRun("anthropic", i + 100, false);
		}

		for (let i = 1; i <= 100; i++) {
			mockExec.addTrackingRun("google", i, true);
		}

		// Anthropic should trigger
		const resultAnthropicFail = await checkExtractionFailureAlarm({
			provider: "anthropic",
			agentRunId: 111,
			extractionSuccess: false,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(resultAnthropicFail.alarmTriggered).toBe(true);

		// Google should not trigger
		const resultGoogle = await checkExtractionFailureAlarm({
			provider: "google",
			agentRunId: 101,
			extractionSuccess: true,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(resultGoogle.alarmTriggered).toBe(false);
		expect(resultGoogle.failureRatePercent).toBe(0.0);
	});

	it("should handle small sample sizes correctly", async () => {
		// Setup: 1 success, 1 failure = 50% failure rate
		mockExec.addTrackingRun("copilot", 1, true);
		mockExec.addTrackingRun("copilot", 2, false);

		const result = await checkExtractionFailureAlarm({
			provider: "copilot",
			agentRunId: 3,
			extractionSuccess: true,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(result.alarmTriggered).toBe(true);
		expect(result.failureRatePercent).toBeGreaterThan(5.0);
	});

	it("should include correct metadata in notification payload", async () => {
		// Setup: trigger the alarm
		for (let i = 1; i <= 90; i++) {
			mockExec.addTrackingRun("anthropic", i, true);
		}
		for (let i = 1; i <= 10; i++) {
			mockExec.addTrackingRun("anthropic", i + 100, false);
		}

		const result = await checkExtractionFailureAlarm({
			provider: "anthropic",
			agentRunId: 111,
			extractionSuccess: false,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(result.alarmTriggered).toBe(true);

		// Verify the notification was inserted with correct structure
		const notifications = mockExec.getNotifications();
		const alarmNotif = notifications[notifications.length - 1];

		expect(alarmNotif.kind).toBe("token_extraction_failures");
		expect(alarmNotif.severity).toBe("ALERT");
		expect(alarmNotif.status).toBe("pending");
		expect(alarmNotif.payload.provider).toBe("anthropic");
		expect(alarmNotif.payload.threshold_percent).toBe(5.0);
	});

	it("should return 0% failure on first run (not null)", async () => {
		const result = await checkExtractionFailureAlarm({
			provider: "anthropic",
			agentRunId: 1,
			extractionSuccess: true,
			exec: mockExec.exec.bind(mockExec),
		});

		expect(result.alarmTriggered).toBe(false);
		expect(result.failureRatePercent).toBe(0.0);
		expect(result.message).toContain("OK");
	});

	it("should handle errors gracefully without throwing", async () => {
		const result = await checkExtractionFailureAlarm({
			provider: "anthropic",
			agentRunId: 1,
			extractionSuccess: true,
			exec: async () => {
				throw new Error("Database connection failed");
			},
		});

		expect(result.alarmTriggered).toBe(false);
		expect(result.failureRatePercent).toBeNull();
		expect(result.message).toContain("failed");
	});
});

// Mock executor for testing
function createMockExecutor() {
	const tracking: Array<{
		provider: string;
		agentRunId: number;
		success: boolean;
	}> = [];
	const notifications: Array<{
		kind: string;
		title: string;
		body: string;
		severity: string;
		status: string;
		payload: Record<string, unknown>;
		metadata: Record<string, unknown>;
	}> = [];
	const cooldowns: Record<string, { lastAlarmAt: Date }> = {};

	return {
		addTrackingRun(provider: string, agentRunId: number, success: boolean) {
			tracking.push({ provider, agentRunId, success });
		},

		getNotifications() {
			return notifications;
		},

		async exec(sql: string, params?: unknown[]) {
			// INSERT into tracking
			if (sql.includes("INSERT INTO roadmap.extraction_failure_tracking")) {
				const [provider, agentRunId, success] = params as [
					string,
					number,
					boolean,
				];
				tracking.push({ provider, agentRunId, success });
				return { rows: [] };
			}

			// Query failure rate
			if (sql.includes("FROM roadmap.v_extraction_failure_rate")) {
				const [provider] = params as [string];
				const providerData = tracking.filter((t) => t.provider === provider);

				if (providerData.length === 0) {
					return { rows: [] };
				}

				const failureCount = providerData.filter(
					(t) => !t.success
				).length;
				const totalCount = providerData.length;
				const failureRate =
					(failureCount / totalCount) * 100;

				return {
					rows: [
						{
							failure_count: failureCount,
							total_count: totalCount,
							failure_rate_percent:
								Math.round(failureRate * 100) / 100,
						},
					],
				};
			}

			// Query cooldown
			if (sql.includes("FROM roadmap.extraction_failure_alarm_cooldown")) {
				const [provider] = params as [string];
				if (cooldowns[provider]) {
					return {
						rows: [
							{ last_alarm_at: cooldowns[provider].lastAlarmAt.toISOString() },
						],
					};
				}
				return { rows: [] };
			}

			// INSERT notification
			if (sql.includes("INSERT INTO roadmap.notification_queue")) {
				const [kind, title, body, severity, status, payloadStr, metadata] = params as [
					string,
					string,
					string,
					string,
					string,
					string,
					Record<string, unknown>,
				];
				const payload = JSON.parse(payloadStr as string);
				notifications.push({
					kind,
					title,
					body,
					severity,
					status,
					payload,
					metadata,
				});
				return {
					rows: [{ id: notifications.length }],
				};
			}

			// INSERT/UPDATE cooldown
			if (sql.includes("INSERT INTO roadmap.extraction_failure_alarm_cooldown")) {
				const [provider] = params as [string];
				cooldowns[provider] = { lastAlarmAt: new Date() };
				return { rows: [] };
			}

			return { rows: [] };
		},
	};
}
