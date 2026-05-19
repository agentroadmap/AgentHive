# P992 — Agentic task execution via liaison message bus

## Motivation
Currently, the liaison agent (running in `scripts/start-agency.ts`) can listen to A2A messages via `message_ledger` and reply with LLM-generated text. However, it is "wired to talk, not act." When it receives a message of type `task`, it acknowledges it but does not trigger any actual execution.

There is a separate `offer_dispatch` flow (handled in `liaison-hub.ts`) that spawns agents, but this is exclusively driven by the orchestrator inserting into `liaison_message`.

This proposal aims to bridge these two planes, allowing a liaison agent to receive a task via A2A and autonomously initiate an `offer_dispatch` or direct `spawnAgent` call to fulfill it, while reporting progress back through the A2A channel.

## Design
1. **Message Type Recognition**: Update `runLiaisonAgent` in `src/infra/agency/liaison-agent.ts` to explicitly handle `message_type = 'task'`.
2. **Bridge to Action**: When a `task` is received:
    - The liaison agent sends an immediate "Acknowledged" reply to the requester.
    - It triggers an execution flow.
3. **Execution Options**:
    - **Self-Dispatch**: The liaison inserts an `offer_dispatch` record into `liaison_message` for itself, which its own `LiaisonHub` will pick up.
    - **Direct Spawn**: The liaison calls `spawnAgent` directly.
4. **Progress Forwarding**: The spawned agent's output and status changes should be intercepted and forwarded back to the requester via `message_ledger`.

## Acceptance Criteria
- [ ] Liaison agent recognizes `task` message type.
- [ ] Liaison agent sends an acknowledgment reply for tasks.
- [ ] Liaison agent triggers a child agent spawn to execute the task.
- [ ] Liaison agent forwards status updates (start, finish, output) back to the original requester.

## Phase
Target Phase: 3 (Agency liaison and orchestrator readiness)
