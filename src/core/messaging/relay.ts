/**
 * Relay Service: Bridges local file-based chat with external channels.
 * Currently supports pushing to Discord via Webhooks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RelayConfig } from "../../types/index.ts";
import type { Core } from "../roadmap.ts";

export class RelayService {
	private readonly core: Core;
	private readonly config: RelayConfig;
	private readonly filePositions = new Map<string, number>();
	private watcher?: fs.FSWatcher;
	private pollInterval?: NodeJS.Timeout;
	private isRunning = false;
	private lastPolledId?: string;

	constructor(core: Core, config: RelayConfig) {
		this.core = core;
		this.config = config;
	}

	/**
	 * Start monitoring the messages directory.
	 */
	public async start(): Promise<void> {
		if (!this.config.enabled || this.isRunning) return;

		const messagesDir = await this.core.getMessagesDir();
		if (!fs.existsSync(messagesDir)) {
			fs.mkdirSync(messagesDir, { recursive: true });
		}

		// Initial scan to establish file positions
		const files = fs.readdirSync(messagesDir);
		for (const file of files) {
			if (file.endsWith(".md")) {
				const filePath = path.join(messagesDir, file);
				const stats = fs.statSync(filePath);
				this.filePositions.set(file, stats.size);
			}
		}

		this.watcher = fs.watch(messagesDir, (_eventType, filename) => {
			if (filename?.endsWith(".md")) {
				this.handleFileChange(filename);
			}
		});

		// Start polling external channel if configured
		if (this.config.bot_token && this.config.channel_id) {
			const interval = this.config.interval_ms || 30000; // Default 30s
			this.pollInterval = setInterval(
				() => this.fetchExternalMessages(),
				interval,
			);
			// Run once immediately
			void this.fetchExternalMessages();
		}

		this.isRunning = true;
		console.error(`Relay Service started: monitoring ${messagesDir}`);
	}

	/**
	 * Stop monitoring.
	 */
	public stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = undefined;
		}
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = undefined;
		}
		this.isRunning = false;
	}

	private async handleFileChange(filename: string): Promise<void> {
		const messagesDir = await this.core.getMessagesDir();
		const filePath = path.join(messagesDir, filename);

		if (!fs.existsSync(filePath)) {
			this.filePositions.delete(filename);
			return;
		}

		const stats = fs.statSync(filePath);
		const lastPos = this.filePositions.get(filename) ?? 0;

		if (stats.size > lastPos) {
			const stream = fs.createReadStream(filePath, { start: lastPos });
			let content = "";
			for await (const chunk of stream) {
				content += chunk;
			}

			this.filePositions.set(filename, stats.size);
			await this.processNewContent(filename, content);
		}
	}

	private async processNewContent(
		filename: string,
		content: string,
	): Promise<void> {
		const lines = content.split("\n").filter((l) => l.trim().length > 0);
		for (const line of lines) {
			// Parse log entry: [timestamp] agent: message
			const match = line.match(/^\[([^\]]+)\] ([^:]+): (.*)$/);
			if (match) {
				const agent = match[2].trim();
				const message = match[3].trim();

				if (this.config.ignored_agents?.includes(agent)) continue;

				await this.pushToExternal(filename, agent, message);
			}
		}
	}

	private async pushToExternal(
		filename: string,
		agent: string,
		message: string,
	): Promise<void> {
		if (!this.config.webhook_url) return;

		const channelName = filename.replace(".md", "").toUpperCase();

		// Basic Discord Webhook format
		const payload = {
			username: `${agent} (Relay)`,
			content: `**[${channelName}]** ${message}`,
		};

		try {
			const response = await fetch(this.config.webhook_url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			if (!response.ok) {
				console.error(
					`Relay failed to push to webhook: ${response.statusText}`,
				);
			}
		} catch (error) {
			console.error(
				`Relay error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async fetchExternalMessages(): Promise<void> {
		if (!this.config.bot_token || !this.config.channel_id) return;

		try {
			const url = `https://discord.com/api/v10/channels/${this.config.channel_id}/messages${this.lastPolledId ? `?after=${this.lastPolledId}` : "?limit=1"}`;
			const response = await fetch(url, {
				headers: {
					Authorization: `Bot ${this.config.bot_token}`,
				},
			});

			if (!response.ok) {
				console.error(
					`Relay failed to fetch external messages: ${response.statusText}`,
				);
				return;
			}

			const messages = (await response.json()) as any[];
			if (messages.length === 0) return;

			// Sort by ID (chronological)
			messages.sort((a, b) => a.id.localeCompare(b.id));

			for (const msg of messages) {
				this.lastPolledId = msg.id;

				// Skip messages from the relay itself (to avoid loops)
				if (msg.author.bot && msg.author.username.includes("(Relay)")) continue;
				if (msg.webhook_id) continue;

				const from = msg.author.global_name || msg.author.username;
				const text = msg.content;

				// Write back to local chat
				await this.core.sendMessage({
					from: `${from} (External)`,
					message: text,
					type: "public",
				});
			}
		} catch (error) {
			console.error(
				`Relay fetch error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
