import { listAgentEntries } from "../cli/commands/agents-config.js";
import type { BrigadeConfig } from "../config/io.js";
import { resolveDefaultAgentId } from "./agent-scope.js";

/** One canonical configured-agent predicate for room authority checks. */
export function isConfiguredAgentId(
	config: BrigadeConfig,
	agentIdValue: string,
	currentAgentId?: string,
): boolean {
	const agentId = agentIdValue.trim();
	if (!agentId) return false;
	return agentId === currentAgentId
		|| agentId === resolveDefaultAgentId(config)
		|| listAgentEntries(config).some((entry) => entry.id === agentId);
}
