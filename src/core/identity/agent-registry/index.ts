/**
 * S147.1: Agent Registration Module
 *
 * Exports for agent registration functionality.
 */

export {
	assertNoPublicKeyConflict,
	deregisterAgent,
	getAgent,
	getAgentPublicKey,
	listAgents,
	registerAgent,
	updateAgentPublicKey,
	updateAgentStatus,
} from "./registry.ts";
export type {
	AgentRegistration,
	DeregisterRequest,
	RegistrationRequest,
	RegistrationResponse,
} from "./types.ts";
