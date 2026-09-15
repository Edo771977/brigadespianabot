export interface TeamInspectionTurnShape {
	internalTurn?: boolean;
	teamToolReadOnly?: boolean;
	toolsAllow?: readonly string[];
}

/**
 * The sole workspace-admission bypass used by Team Mode. This strict shape is
 * produced only by the durable coordinator-return path and gives the model one
 * read-only Team status tool, with no filesystem or process tools.
 */
export function isTrustedTeamInspectionTurn(turn: TeamInspectionTurnShape): boolean {
	return turn.internalTurn === true &&
		turn.teamToolReadOnly === true &&
		turn.toolsAllow?.length === 1 &&
		turn.toolsAllow[0] === "team";
}
