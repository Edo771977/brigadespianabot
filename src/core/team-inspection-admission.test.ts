import assert from "node:assert/strict";
import test from "node:test";

import { isTrustedTeamInspectionTurn } from "./team-inspection-admission.js";

test("only the synthetic read-only Team status turn bypasses workspace admission", () => {
	assert.equal(isTrustedTeamInspectionTurn({
		internalTurn: true,
		teamToolReadOnly: true,
		toolsAllow: ["team"],
	}), true);
	assert.equal(isTrustedTeamInspectionTurn({
		internalTurn: true,
		teamToolReadOnly: true,
		toolsAllow: ["team", "read"],
	}), false);
	assert.equal(isTrustedTeamInspectionTurn({
		internalTurn: true,
		toolsAllow: ["team"],
	}), false);
	assert.equal(isTrustedTeamInspectionTurn({
		teamToolReadOnly: true,
		toolsAllow: ["team"],
	}), false);
});
