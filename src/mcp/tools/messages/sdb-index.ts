/**
 * SpacetimeDB-backed Message Tools
 * Replaces file-based messaging with stdb tables: chan, msg, sub, note
 */

import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { SdbMessageHandlers } from "./sdb-handlers.ts";

const messageChannelsSchema: JsonSchema = {
  type: "object",
  properties: {},
  required: [],
};

const messageReadSchema: JsonSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Channel name to read from (e.g., 'public', 'general')" },
    since: { type: "string", description: "ISO 8061 timestamp. Only return messages after this time." },
  },
  required: ["channel"],
};

const messageSendSchema: JsonSchema = {
  type: "object",
  properties: {
    from: { type: "string", description: "Your agent name" },
    message: { type: "string", description: "Message content" },
    channel: { type: "string", description: "Channel name (default: 'general')" },
    to: { type: "string", description: "Recipient agent name (optional)" },
  },
  required: ["from", "message"],
};

const messageSubscribeSchema: JsonSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Channel name" },
    from: { type: "string", description: "Agent identity" },
    subscribe: { type: "boolean", description: "True to subscribe, false to unsubscribe" },
  },
  required: ["channel", "from"],
};

const channelCreateSchema: JsonSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Channel name to create" },
    description: { type: "string", description: "Channel description" },
  },
  required: ["channel"],
};

const channelDeleteSchema: JsonSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Channel name to delete" },
  },
  required: ["channel"],
};

const channelUnsubscribeSchema: JsonSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Channel name" },
    from: { type: "string", description: "Agent identity" },
  },
  required: ["channel", "from"],
};

const messageHistorySchema: JsonSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Channel name" },
    limit: { type: "number", description: "Max messages to return (default: 50)" },
    before: { type: "number", description: "Return messages before this ID" },
  },
  required: ["channel"],
};

export function registerSdbMessageTools(server: McpServer, projectRoot: string): void {
  const handlers = new SdbMessageHandlers(server, projectRoot);

  server.addTool(createSimpleValidatedTool(
    { name: "chan_list", description: "List all chat channels", inputSchema: messageChannelsSchema },
    messageChannelsSchema,
    () => handlers.listChannels(),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "msg_read", description: "Read messages from a channel", inputSchema: messageReadSchema },
    messageReadSchema,
    (input) => handlers.readMessages(input as { channel: string; since?: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "msg_send", description: "Send a message to a channel", inputSchema: messageSendSchema },
    messageSendSchema,
    (input) => handlers.sendMessage(input as { from: string; message: string; channel?: string; to?: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "chan_subscribe", description: "Subscribe to a channel", inputSchema: messageSubscribeSchema },
    messageSubscribeSchema,
    (input) => handlers.subscribe(input as { channel: string; from: string; subscribe?: boolean }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "chan_create", description: "Create a new channel", inputSchema: channelCreateSchema },
    channelCreateSchema,
    (input) => handlers.createChannel(input as { channel: string; description?: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "chan_delete", description: "Delete a channel", inputSchema: channelDeleteSchema },
    channelDeleteSchema,
    (input) => handlers.deleteChannel(input as { channel: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "chan_unsubscribe", description: "Unsubscribe from a channel", inputSchema: channelUnsubscribeSchema },
    channelUnsubscribeSchema,
    (input) => handlers.unsubscribe(input as { channel: string; from: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "msg_history", description: "Get message history from a channel", inputSchema: messageHistorySchema },
    messageHistorySchema,
    (input) => handlers.getMessageHistory(input as { channel: string; limit?: number; before?: number }),
  ));

  console.log('[Messaging] Registered 8 SDB tools: chan_list, msg_read, msg_send, chan_subscribe, chan_create, chan_delete, chan_unsubscribe, msg_history');
}
