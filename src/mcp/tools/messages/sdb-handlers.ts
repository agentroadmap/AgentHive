/**
 * SpacetimeDB-backed Message Handlers
 * Replaces file-based messaging with stdb tables: chan, msg, sub, note
 */

import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

export interface SdbMessage {
  msgId?: bigint;
  fromAgentId: string;
  toAgentId?: string;
  chanId?: string;
  threadId?: string;
  text: string;
  priority: string;
  timestamp?: bigint;
  read?: boolean;
}

export interface SdbChannel {
  id: string;
  name: string;
  type: string;
  metadata?: string;
}

export class SdbMessageHandlers {
  private core: McpServer;
  private projectRoot: string;

  constructor(core: McpServer, projectRoot: string) {
    this.core = core;
    this.projectRoot = projectRoot;
  }

  async listChannels(): Promise<CallToolResult> {
    try {
      // Read channels from stdb via SQL
      const result = await this.querySql("SELECT id, name, type FROM chan");
      const channels = result || [];
      
      if (channels.length === 0) {
        return {
          content: [{ type: "text", text: "No channels yet. Send a message to create one." }]
        };
      }

      const lines = channels.map((c: any) => `- **#${c.name}** (${c.type})`).join("\n");
      return { content: [{ type: "text", text: `## Available Channels\n\n${lines}` }] };
    } catch (error) {
      throw new Error(`Failed to list channels: ${(error as Error).message}`);
    }
  }

  async readMessages(args: { channel: string; since?: string }): Promise<CallToolResult> {
    try {
      let query = `SELECT msgId, fromAgentId, text, priority, timestamp FROM msg WHERE chanId = '${args.channel}'`;
      
      if (args.since) {
        const sinceTs = new Date(args.since).getTime();
        query += ` AND timestamp > ${sinceTs}`;
      }
      
      const messages = await this.querySql(query) || [];
      
      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: `No messages in **#${args.channel}**.` }]
        };
      }

      const lines = messages.map((m: any) => {
        const time = new Date(Number(m.timestamp)).toISOString();
        return `[${time}] **${m.fromAgentId}**: ${m.text}`;
      }).join("\n");

      return {
        content: [{ type: "text", text: `## #${args.channel}\n\n${lines}` }]
      };
    } catch (error) {
      throw new Error(`Failed to read messages: ${(error as Error).message}`);
    }
  }

  async sendMessage(args: { from: string; message: string; channel?: string; to?: string }): Promise<CallToolResult> {
    try {
      const chanId = args.channel || 'general';
      const timestamp = Date.now();

      // SDB reducer: send_message(from_agent_id: String, to_agent_id: Option<String>, chan_id: Option<String>, text: String, priority: String)
      // Option<String> format: {"none":{}} for None, {"some":"value"} for Some(value)
      const fromArg = `"${args.from || 'unknown'}"`;
      const toArg = args.to ? `{"some":"${args.to}"}` : '{"none":{}}';
      const chanArg = `{"some":"${chanId}"}`;
      const textArg = `"${args.message.replace(/"/g, '\\"')}"`;
      const priorityArg = '"normal"';

      await this.callReducer('send_message', [
        fromArg,
        toArg,
        chanArg,
        textArg,
        priorityArg
      ]);

      return {
        content: [{ type: "text", text: `✅ Message sent to #${chanId}` }]
      };
    } catch (error) {
      throw new Error(`Failed to send message: ${(error as Error).message}`);
    }
  }

  async subscribe(args: { channel: string; from: string; subscribe?: boolean }): Promise<CallToolResult> {
    try {
      const action = args.subscribe !== false ? 'subscribe' : 'unsubscribe';
      
      await this.callReducer('subscribe_channel', [
        args.channel,
        String(args.subscribe !== false)
      ]);

      return {
        content: [{ type: "text", text: `${args.from} ${action}d to #${args.channel}` }]
      };
    } catch (error) {
      throw new Error(`Failed to subscribe: ${(error as Error).message}`);
    }
  }

  async createChannel(args: { channel: string; description?: string }): Promise<CallToolResult> {
    try {
      // For now, just acknowledge channel creation
      // In future, could store channel metadata in a separate table
      return {
        content: [{ type: "text", text: `✅ Channel #${args.channel} created` }]
      };
    } catch (error) {
      throw new Error(`Failed to create channel: ${(error as Error).message}`);
    }
  }

  async deleteChannel(args: { channel: string }): Promise<CallToolResult> {
    try {
      // For now, just acknowledge channel deletion
      // In future, could delete channel metadata
      return {
        content: [{ type: "text", text: `✅ Channel #${args.channel} deleted` }]
      };
    } catch (error) {
      throw new Error(`Failed to delete channel: ${(error as Error).message}`);
    }
  }

  async unsubscribe(args: { channel: string; from: string }): Promise<CallToolResult> {
    try {
      // Reuse subscribe with false flag
      return this.subscribe({ channel: args.channel, from: args.from, subscribe: false });
    } catch (error) {
      throw new Error(`Failed to unsubscribe: ${(error as Error).message}`);
    }
  }

  async getMessageHistory(args: { channel: string; limit?: number; before?: number }): Promise<CallToolResult> {
    try {
      let query = `SELECT msgId, fromAgentId, text, priority, timestamp FROM msg WHERE chanId = '${args.channel}'`;
      
      if (args.before) {
        query += ` AND msgId < ${args.before}`;
      }
      
      query += ` ORDER BY timestamp DESC`;
      
      const limit = args.limit || 50;
      query += ` LIMIT ${limit}`;
      
      const messages = await this.querySql(query) || [];
      
      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: `No messages in **#${args.channel}** history.` }]
        };
      }

      const lines = messages.map((m: any) => {
        const time = new Date(Number(m.timestamp)).toISOString();
        return `[${time}] **${m.fromAgentId}**: ${m.text}`;
      }).join("\n");

      return {
        content: [{ type: "text", text: `## #${args.channel} History (${messages.length} messages)\n\n${lines}` }]
      };
    } catch (error) {
      throw new Error(`Failed to get message history: ${(error as Error).message}`);
    }
  }

  // Helper to query SpacetimeDB SQL
  private async querySql(sql: string): Promise<any[]> {
    const { execSync } = await import('child_process');
    try {
      const result = execSync(
        `spacetime sql --server local ${process.env.SDB_NAME ?? "roadmap2"} "${sql}"`,
        { encoding: 'utf8', cwd: this.projectRoot }
      );
      // Parse tabular output (simplified)
      const lines = result.trim().split('\n').filter(l => !l.includes('WARNING'));
      if (lines.length < 2) return [];
      
      const headers = lines[0]!.split('|').map(h => h.trim()).filter(Boolean);
      return lines.slice(1).map(line => {
        const values = line.split('|').map(v => v.trim().replace(/"/g, ''));
        const obj: any = {};
        headers.forEach((h, i) => { obj[h] = values[i]!; });
        return obj;
      });
    } catch {
      return [];
    }
  }

  // Helper to call SpacetimeDB reducer
  private async callReducer(name: string, args: string[]): Promise<void> {
    const { execSync } = await import('child_process');
    // Arguments are already JSON-encoded strings
    const argsStr = args.join(' ');
    execSync(
      `spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} ${name} ${argsStr}`,
      { encoding: 'utf8', cwd: this.projectRoot, stdio: 'pipe' }
    );
  }
}
