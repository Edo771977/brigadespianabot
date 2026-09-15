import { strict as assert } from "node:assert";
import { test } from "node:test";

import { sanitizeTeamResult } from "./result-sanitize.js";

test("Team results retain final answers but remove private reasoning", () => {
	assert.equal(
		sanitizeTeamResult("<think>secret plan</think>\n\n<final>Ship the verified fix.</final>"),
		"Ship the verified fix.",
	);
	assert.equal(
		sanitizeTeamResult("<analysis>hidden chain</analysis>\nVisible result"),
		"Visible result",
	);
});

test("reasoning-only Team results persist a safe explicit marker", () => {
	assert.equal(
		sanitizeTeamResult("<think>unfinished private reasoning"),
		"Worker completed without a user-visible result.",
	);
});
