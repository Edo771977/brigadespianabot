import { teamTaskResultSha256 } from "./task-result-page.js";
import type { TaskResultGate, TeamTask } from "./types.js";

const PASS_VERDICT = /^REVIEW:\s*PASS(?:\s|$)/i;

/** Return undefined when the result is accepted, otherwise the durable failure
 * message. Keeping this pure makes every scheduler adapter enforce one rule. */
export function taskResultGateFailure(
	gate: TaskResultGate | undefined,
	result: unknown,
	directDependencies: readonly TeamTask[] = [],
): string | undefined {
	if (!gate) return undefined;
	if (gate.kind === "review_verdict") {
		if (typeof result !== "string" || !PASS_VERDICT.test(result.trim())) {
			return "Final reviewer did not return an explicit REVIEW: PASS verdict";
		}
		if (gate.policy !== "independent-v1") return undefined;

		const lines = result.trim().split(/\r?\n/);
		if (lines[0] !== "REVIEW: PASS") {
			return "Independent review must use exactly REVIEW: PASS as its first line";
		}
		const expectedEvidence: Record<string, string> = Object.create(null) as Record<string, string>;
		for (const dependency of [...directDependencies].sort((a, b) => a.id.localeCompare(b.id))) {
			try {
				expectedEvidence[dependency.id] = teamTaskResultSha256(dependency);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return `Independent review cannot verify dependency ${dependency.id}: ${detail}`;
			}
		}
		const expectedLine = `EVIDENCE: ${JSON.stringify(expectedEvidence)}`;
		if (lines[1] !== expectedLine) {
			return `Independent review must include the exact dependency evidence line: ${expectedLine}`;
		}
		return undefined;
	}
	return `Unsupported task result gate: ${String((gate as { kind?: unknown }).kind)}`;
}
