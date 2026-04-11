# Chat Skill: Listening & Responding to Project Messages

## What This Skill Is

You have access to a local chat system shared across all agents in this project.
Messages are stored in `roadmap/messages/` and exposed via MCP tools.
This skill teaches you how to **listen** and **respond** — exactly like a Discord bot listens to a channel.

## Available Tools

| Tool | Purpose |
|------|---------|
| `chan_list` | List all active channels (group chats + private DMs) |
| `msg_read` | Read messages from a channel (supports `since` for new-only) |
| `msg_send` | Send a message to a channel or DM |

## The Listen Loop

Use `since` to only fetch **new** messages — track the last timestamp you processed:

```
1. chan_list()                          → discover channels
2. msg_read(channel: "project")            → read full history (first time)
3. ... user or agent sends a message ...
4. msg_read(channel: "project", since: "<last-seen-timestamp>")  → new only
5. If new messages exist → respond with msg_send(...)
6. Update your last-seen timestamp → repeat from step 4
```

## When to Respond

- **@mention**: Always respond if you see `@your-name` in a message
- **Question**: Respond if someone asks a question in the group channel
- **Direct task**: If someone asks you to do something, confirm and do it
- **Greeting**: Acknowledge greetings with a brief response

## Channel Types

| Type | Name pattern | Use for |
|------|-------------|---------|
| Group | `project` (default) | Team-wide coordination |
| Group | any name | Sub-team or topic channels |
| Private | `alice-bob` (sorted) | 1:1 agent DMs |
| Public | `public` | Announcements |

## Example: Check-in on startup

```
msg_read(channel: "project")
→ See if anyone greeted you or left tasks
→ If new messages: respond appropriately
→ Record last message timestamp for future polls
```

## Example: Respond to a user message

```
msg_read(channel: "project", since: "2024-01-15 10:30:00")
→ [2024-01-15 10:31:00] Gary: @Gemini can you check STATE-3?
→ msg_send(from: "Gemini", channel: "project", message: "On it! Checking STATE-3 now...")
→ ... do the work ...
→ msg_send(from: "Gemini", channel: "project", message: "STATE-3 looks good — all tests pass ✅")
```

## Identity

Use your actual agent name as `from` so others know who sent the message:
- Gemini CLI → `"Gemini"`
- GitHub Copilot → `"Copilot"`
- Custom agent → use your assigned name from `agents join`
