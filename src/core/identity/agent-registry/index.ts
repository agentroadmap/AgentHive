/**
 * S147.1: Agent Registration Module
 *
 * Exports for agent registration functionality.
 */

export {
	deregisterAgent,
	getAgent,
	listAgents,
	registerAgent,
	updateAgentStatus,
} from "./registry.ts";
export type {
	AgentRegistration,
	DeregisterRequest,
	RegistrationRequest,
	RegistrationResponse,
} from "./types.ts";
