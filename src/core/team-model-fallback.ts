export interface TeamModelCandidate {
	provider: string;
	modelId: string;
}

function validCandidate(value: TeamModelCandidate | undefined): value is TeamModelCandidate {
	return !!value?.provider.trim() && !!value.modelId.trim();
}

function candidateKey(value: TeamModelCandidate): string {
	return `${value.provider.trim()}\u0000${value.modelId.trim()}`;
}

/**
 * Build the fallback chain for a Team worker. The room coordinator's known-good
 * model is tried first, then the operator's ordinary configured fallbacks. The
 * worker identity, workspace, capability restrictions, and task lease do not
 * change: only the inference provider/model rotates after a classified failure.
 */
export function resolveTeamModelFallbacks(args: {
	primary: TeamModelCandidate;
	coordinator?: TeamModelCandidate;
	configured?: readonly TeamModelCandidate[];
}): TeamModelCandidate[] {
	const primaryKey = candidateKey(args.primary);
	const seen = new Set([primaryKey]);
	const result: TeamModelCandidate[] = [];
	for (const candidate of [args.coordinator, ...(args.configured ?? [])]) {
		if (!validCandidate(candidate)) continue;
		const normalized = { provider: candidate.provider.trim(), modelId: candidate.modelId.trim() };
		const key = candidateKey(normalized);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}
