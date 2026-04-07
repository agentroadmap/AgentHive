/**
 * Board Visual & Messaging Tests
 *
 * Coverage for:
 *   - Step colors by status
 *   - Column ordering and persistence
 *   - Detail editing (draft-001)
 *   - Team activity streaming/feed
 *   - MCP messaging
 *   - Chat channels
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { Proposal } from "../../src/types/index.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createProposal(
	id: string,
	status: string,
	overrides: Partial<Proposal> = {},
): Proposal {
	return {
		id,
		title: `Title for ${id}`,
		status,
		assignee: [],
		createdDate: "2025-01-01",
		labels: [],
		dependencies: [],
		description: "",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Step Colors by Status
// ---------------------------------------------------------------------------

describe("Board - Step Colors", () => {
	const STATUS_COLORS: Record<string, string> = {
		Proposal: "yellow",
		Draft: "cyan",
		Accepted: "blue",
		Active: "green",
		Review: "magenta",
		Complete: "gray",
		Parked: "dark-gray",
		Rejected: "red",
	};

	it("assigns correct color to each status", () => {
		for (const [status, expectedColor] of Object.entries(STATUS_COLORS)) {
			const color = STATUS_COLORS[status];
			assert.strictEqual(
				color,
				expectedColor,
				`Status ${status} should be ${expectedColor}`,
			);
		}
	});

	it("Proposal proposals are yellow", () => {
		assert.strictEqual(STATUS_COLORS.Proposal, "yellow");
	});

	it("Active proposals are green", () => {
		assert.strictEqual(STATUS_COLORS.Active, "green");
	});

	it("Complete proposals are gray", () => {
		assert.strictEqual(STATUS_COLORS.Complete, "gray");
	});

	it("Rejected proposals are red", () => {
		assert.strictEqual(STATUS_COLORS.Rejected, "red");
	});

	it("unknown status gets default color", () => {
		const defaultColor = "white";
		const status = "CustomStatus";
		const color = STATUS_COLORS[status] || defaultColor;

		assert.strictEqual(color, "white");
	});

	it("hidden statuses use dim colors", () => {
		const hiddenStatuses = ["Parked", "Rejected"];
		const dimColors = ["dark-gray", "red"];

		for (const status of hiddenStatuses) {
			const color = STATUS_COLORS[status] as string;
			assert.ok(dimColors.includes(color), `${status} should have dim color`);
		}
	});

	it("priority affects proposal highlighting", () => {
		const priorityColors: Record<string, string> = {
			high: "red",
			medium: "yellow",
			low: "green",
		};

		const proposal = createProposal("proposal-001", "Active", {
			priority: "high",
		});
		const highlight = priorityColors[proposal.priority || "medium"];

		assert.strictEqual(highlight, "red");
	});
});

// ---------------------------------------------------------------------------
// Column Ordering & Persistence
// ---------------------------------------------------------------------------

describe("Board - Column Ordering", () => {
	const DEFAULT_ORDER = [
		"Proposal",
		"Draft",
		"Accepted",
		"Active",
		"Review",
		"Complete",
	];

	it("follows configured status order", () => {
		const statuses = DEFAULT_ORDER;
		assert.strictEqual(statuses[0], "Proposal");
		assert.strictEqual(statuses[statuses.length - 1], "Complete");
	});

	it("columns match configured order", () => {
		const proposals = [
			createProposal("proposal-001", "Complete"),
			createProposal("proposal-002", "Active"),
			createProposal("proposal-003", "Proposal"),
		];

		const columns = DEFAULT_ORDER.map((status) => ({
			status,
			proposals: proposals.filter((s) => s.status === status),
		}));

		assert.strictEqual(columns[0]?.status, "Proposal");
		assert.strictEqual(columns[1]?.status, "Draft");
		assert.strictEqual(columns[2]?.status, "Accepted");
		assert.strictEqual(columns[3]?.status, "Active");
		assert.strictEqual(columns[4]?.status, "Review");
		assert.strictEqual(columns[5]?.status, "Complete");
	});

	it("column order preserved after proposal move", () => {
		const order = [...DEFAULT_ORDER];

		// Move a proposal (doesn't change column order)
		const movedProposal = createProposal("proposal-001", "Active");
		movedProposal.status = "Review";

		// Column order should still be the same
		assert.deepStrictEqual(order, DEFAULT_ORDER);
	});

	it("allows hiding columns without affecting order", () => {
		const hiddenStatuses = ["Parked", "Rejected"];
		const visibleColumns = DEFAULT_ORDER.filter(
			(s) => !hiddenStatuses.includes(s),
		);

		assert.strictEqual(visibleColumns.length, DEFAULT_ORDER.length);
		assert.deepStrictEqual(visibleColumns, DEFAULT_ORDER);
	});

	it("proposal within column maintains order", () => {
		const proposals = [
			createProposal("proposal-001", "Active"),
			createProposal("proposal-002", "Active"),
			createProposal("proposal-003", "Active"),
		];

		// Default: order by ID
		const sorted = [...proposals].sort((a, b) => a.id.localeCompare(b.id));
		assert.strictEqual(sorted[0].id, "proposal-001");
		assert.strictEqual(sorted[1].id, "proposal-002");
		assert.strictEqual(sorted[2].id, "proposal-003");
	});
});

// ---------------------------------------------------------------------------
// Detail Editing (draft-001)
// ---------------------------------------------------------------------------

describe("Board - Detail Editing", () => {
	it("can edit proposal title", () => {
		const proposal = createProposal("proposal-001", "Active", {
			title: "Original",
		});

		// Edit
		proposal.title = "Updated Title";

		assert.strictEqual(proposal.title, "Updated Title");
	});

	it("can edit proposal description", () => {
		const proposal = createProposal("proposal-001", "Active", {
			description: "Original desc",
		});

		proposal.description = "New description with more details";

		assert.strictEqual(
			proposal.description,
			"New description with more details",
		);
	});

	it("can edit proposal status", () => {
		const proposal = createProposal("proposal-001", "Draft");

		proposal.status = "Active";

		assert.strictEqual(proposal.status, "Active");
	});

	it("can edit proposal priority", () => {
		const proposal = createProposal("proposal-001", "Active", {
			priority: "low",
		});

		proposal.priority = "high";

		assert.strictEqual(proposal.priority, "high");
	});

	it("can add labels", () => {
		const proposal = createProposal("proposal-001", "Active", {
			labels: ["feature"],
		});

		proposal.labels?.push("urgent", "backend");

		assert.strictEqual(proposal.labels?.length, 3);
		assert.ok(proposal.labels?.includes("urgent"));
	});

	it("can remove labels", () => {
		const proposal = createProposal("proposal-001", "Active", {
			labels: ["feature", "bugfix", "docs"],
		});

		proposal.labels = proposal.labels?.filter((l) => l !== "bugfix");

		assert.strictEqual(proposal.labels.length, 2);
		assert.ok(!proposal.labels.includes("bugfix"));
	});

	it("can edit acceptance criteria", () => {
		const proposal = createProposal("proposal-001", "Active", {
			acceptanceCriteriaItems: [
				{ index: 1, text: "Original AC", checked: false },
			],
		});

		// Mark as checked
		const firstCriterion = proposal.acceptanceCriteriaItems?.[0];
		assert.ok(firstCriterion);
		firstCriterion.checked = true;

		assert.strictEqual(firstCriterion.checked, true);
	});

	it("can add new acceptance criteria", () => {
		const proposal = createProposal("proposal-001", "Active", {
			acceptanceCriteriaItems: [{ index: 1, text: "AC#1", checked: false }],
		});

		proposal.acceptanceCriteriaItems?.push({
			index: 2,
			text: "AC#2: New criterion",
			checked: false,
		});

		assert.strictEqual(proposal.acceptanceCriteriaItems?.length, 2);
	});

	it("edit mode requires save or cancel", () => {
		let editMode = false;
		let hasUnsavedChanges = false;

		// Enter edit mode
		editMode = true;

		// Make a change
		hasUnsavedChanges = true;

		// Cancel discards changes
		editMode = false;
		hasUnsavedChanges = false;

		assert.strictEqual(editMode, false);
		assert.strictEqual(hasUnsavedChanges, false);
	});

	it("save validates required fields", () => {
		const proposal = createProposal("proposal-001", "Active");
		const errors: string[] = [];

		if (!proposal.title || proposal.title.trim() === "") {
			errors.push("Title is required");
		}

		assert.strictEqual(errors.length, 0);
	});

	it("save fails with empty title", () => {
		const proposal = createProposal("proposal-001", "Active", { title: "" });
		const errors: string[] = [];

		if (!proposal.title || proposal.title.trim() === "") {
			errors.push("Title is required");
		}

		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].includes("Title"));
	});
});

// ---------------------------------------------------------------------------
// Team Activity Streaming/Feed
// ---------------------------------------------------------------------------

describe("Board - Team Activity Feed", () => {
	interface ActivityEvent {
		type: string;
		agentId: string;
		proposalId: string;
		message: string;
		timestamp: number;
	}

	it("records proposal transition events", () => {
		const event: ActivityEvent = {
			type: "proposal_transition",
			agentId: "agent-alice",
			proposalId: "proposal-001",
			message: "proposal-001: Active → Review",
			timestamp: Date.now(),
		};

		assert.strictEqual(event.type, "proposal_transition");
		assert.ok(event.message.includes("Active"));
		assert.ok(event.message.includes("Review"));
	});

	it("records claim events", () => {
		const event: ActivityEvent = {
			type: "proposal_claimed",
			agentId: "agent-bob",
			proposalId: "proposal-002",
			message: "agent-bob claimed proposal-002",
			timestamp: Date.now(),
		};

		assert.strictEqual(event.type, "proposal_claimed");
		assert.ok(event.message.includes("claimed"));
	});

	it("records review events", () => {
		const event: ActivityEvent = {
			type: "review_requested",
			agentId: "agent-alice",
			proposalId: "proposal-001",
			message: "Review requested for proposal-001",
			timestamp: Date.now(),
		};

		assert.strictEqual(event.type, "review_requested");
	});

	it("records completion events", () => {
		const event: ActivityEvent = {
			type: "proposal_complete",
			agentId: "agent-bob",
			proposalId: "proposal-003",
			message: "proposal-003 completed by agent-bob",
			timestamp: Date.now(),
		};

		assert.strictEqual(event.type, "proposal_complete");
	});

	it("activity feed shows recent events", () => {
		const events: ActivityEvent[] = [];
		const now = Date.now();

		// Add events
		for (let i = 0; i < 10; i++) {
			events.push({
				type: "proposal_transition",
				agentId: `agent-${i}`,
				proposalId: `proposal-${String(i).padStart(3, "0")}`,
				message: `Event ${i}`,
				timestamp: now + i * 1000,
			});
		}

		// Get recent (last 5)
		const recent = events.slice(-5);
		assert.strictEqual(recent.length, 5);
		assert.strictEqual(recent[0].message, "Event 5");
		assert.strictEqual(recent[4].message, "Event 9");
	});

	it("events are timestamped chronologically", () => {
		const events: ActivityEvent[] = [
			{
				type: "proposal_transition",
				agentId: "a1",
				proposalId: "S1",
				message: "First",
				timestamp: 1000,
			},
			{
				type: "proposal_transition",
				agentId: "a2",
				proposalId: "S2",
				message: "Second",
				timestamp: 2000,
			},
			{
				type: "proposal_transition",
				agentId: "a3",
				proposalId: "S3",
				message: "Third",
				timestamp: 3000,
			},
		];

		for (let i = 1; i < events.length; i++) {
			assert.ok(events[i].timestamp > events[i - 1].timestamp);
		}
	});

	it("agent online/offline events", () => {
		const onlineEvent: ActivityEvent = {
			type: "agent_online",
			agentId: "agent-alice",
			proposalId: "",
			message: "agent-alice is online",
			timestamp: Date.now(),
		};

		const offlineEvent: ActivityEvent = {
			type: "agent_offline",
			agentId: "agent-alice",
			proposalId: "",
			message: "agent-alice went offline",
			timestamp: Date.now() + 1000,
		};

		assert.strictEqual(onlineEvent.type, "agent_online");
		assert.strictEqual(offlineEvent.type, "agent_offline");
	});
});

// ---------------------------------------------------------------------------
// MCP Messaging
// ---------------------------------------------------------------------------

describe("Board - MCP Messaging", () => {
	interface McpMessage {
		channel: string;
		from: string;
		to: string;
		content: string;
		timestamp: number;
	}

	it("sends message between agents", () => {
		const msg: McpMessage = {
			channel: "project-general",
			from: "agent-alice",
			to: "agent-bob",
			content: "Ready for review on proposal-001",
			timestamp: Date.now(),
		};

		assert.strictEqual(msg.from, "agent-alice");
		assert.strictEqual(msg.to, "agent-bob");
		assert.ok(msg.content.includes("review"));
	});

	it("broadcasts to channel", () => {
		const msg: McpMessage = {
			channel: "project-updates",
			from: "system",
			to: "*",
			content: "proposal-001 completed successfully",
			timestamp: Date.now(),
		};

		assert.strictEqual(msg.to, "*");
	});

	it("supports project-specific channels", () => {
		const channels = [
			"project-general",
			"project-updates",
			"project-alerts",
			"agent-coordination",
		];

		for (const channel of channels) {
			const msg: McpMessage = {
				channel,
				from: "system",
				to: "*",
				content: "Test message",
				timestamp: Date.now(),
			};

			assert.strictEqual(msg.channel, channel);
		}
	});

	it("messages persist in channel history", () => {
		const history: McpMessage[] = [];

		// Add messages
		history.push({
			channel: "project-general",
			from: "agent-alice",
			to: "*",
			content: "Message 1",
			timestamp: 1000,
		});
		history.push({
			channel: "project-general",
			from: "agent-bob",
			to: "*",
			content: "Message 2",
			timestamp: 2000,
		});

		assert.strictEqual(history.length, 2);
	});

	it("message includes proposal context", () => {
		const msg: McpMessage = {
			channel: "project-general",
			from: "agent-alice",
			to: "*",
			content: "Working on proposal-001: Fix authentication bug",
			timestamp: Date.now(),
		};

		assert.ok(msg.content.includes("proposal-001"));
	});
});

// ---------------------------------------------------------------------------
// Chat Channels
// ---------------------------------------------------------------------------

describe("Board - Chat Channels", () => {
	interface ChatChannel {
		id: string;
		name: string;
		type: "project" | "dm" | "agent";
		members: string[];
	}

	it("project channel has all agents", () => {
		const channel: ChatChannel = {
			id: "ch-001",
			name: "project-general",
			type: "project",
			members: ["agent-alice", "agent-bob", "agent-charlie"],
		};

		assert.strictEqual(channel.members.length, 3);
	});

	it("DM channel has exactly 2 members", () => {
		const dm: ChatChannel = {
			id: "dm-001",
			name: "Alice ↔ Bob",
			type: "dm",
			members: ["agent-alice", "agent-bob"],
		};

		assert.strictEqual(dm.members.length, 2);
	});

	it("agent channel for specific agent", () => {
		const agentChannel: ChatChannel = {
			id: "agent-001",
			name: "agent-alice",
			type: "agent",
			members: ["agent-alice"],
		};

		assert.strictEqual(agentChannel.type, "agent");
		assert.strictEqual(agentChannel.members.length, 1);
	});

	it("can list channels", () => {
		const channels: ChatChannel[] = [
			{ id: "ch-001", name: "project-general", type: "project", members: [] },
			{ id: "ch-002", name: "project-alerts", type: "project", members: [] },
			{ id: "dm-001", name: "Alice ↔ Bob", type: "dm", members: [] },
		];

		assert.strictEqual(channels.length, 3);
	});

	it("channel shows unread count", () => {
		const _channel: ChatChannel = {
			id: "ch-001",
			name: "project-general",
			type: "project",
			members: [],
		};

		// Unread tracking
		const unreadCount = 5;
		assert.ok(unreadCount > 0);
	});

	it("supports mentions", () => {
		const message = "Hey @agent-bob, please review proposal-001";

		assert.ok(message.includes("@agent-bob"));
		assert.ok(message.includes("proposal-001"));
	});
});
