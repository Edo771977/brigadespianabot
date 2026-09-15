import { createHash } from "node:crypto";

import type { TeamTask } from "./types.js";
import { CollaborationConflictError } from "./types.js";

export const DEFAULT_TEAM_RESULT_PAGE_CHARS = 8_000;
export const MAX_TEAM_RESULT_PAGE_CHARS = 32_000;

export interface TeamTaskResultPage {
	taskId: string;
	runId: string;
	format: "text" | "json";
	content: string;
	offset: number;
	endOffset: number;
	totalChars: number;
	complete: boolean;
	nextOffset?: number;
	/** Digest of the complete encoded result, stable across every page. */
	sha256: string;
}

function encodedResult(task: TeamTask): { format: "text" | "json"; content: string } {
	if (task.result === undefined) {
		throw new CollaborationConflictError(
			"RESULT_NOT_AVAILABLE",
			`Team task ${task.id} has no durable result`,
		);
	}
	if (typeof task.result === "string") return { format: "text", content: task.result };
	let content: string | undefined;
	try {
		content = JSON.stringify(task.result);
	} catch {
		// Collaboration stores accept JSON values, but keep this boundary fail-closed
		// for custom store implementations instead of returning a lossy rendering.
	}
	if (content === undefined) {
		throw new CollaborationConflictError(
			"RESULT_NOT_SERIALIZABLE",
			`Team task ${task.id} result cannot be represented exactly as JSON`,
		);
	}
	return { format: "json", content };
}

/** Digest the exact durable encoding used by the result paging API. */
export function teamTaskResultSha256(task: TeamTask): string {
	return sha256(encodedResult(task).content);
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Return one lossless page of a task's durable result. Offsets are JavaScript
 * string indices, so concatenating pages in offset order reconstructs the exact
 * encoded value even when a boundary falls between a Unicode surrogate pair. */
export function pageTeamTaskResult(
	task: TeamTask,
	options: { offset?: number; limit?: number } = {},
): TeamTaskResultPage {
	const offset = options.offset ?? 0;
	const limit = options.limit ?? DEFAULT_TEAM_RESULT_PAGE_CHARS;
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new CollaborationConflictError("INVALID_ARGUMENT", "result offset must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_TEAM_RESULT_PAGE_CHARS) {
		throw new CollaborationConflictError(
			"INVALID_ARGUMENT",
			`result limit must be a positive safe integer no greater than ${MAX_TEAM_RESULT_PAGE_CHARS}`,
		);
	}
	const encoded = encodedResult(task);
	if (offset > encoded.content.length) {
		throw new CollaborationConflictError(
			"INVALID_ARGUMENT",
			`result offset must not exceed ${encoded.content.length}`,
		);
	}
	const content = encoded.content.slice(offset, offset + limit);
	const endOffset = Math.min(offset + content.length, encoded.content.length);
	const complete = endOffset >= encoded.content.length;
	return {
		taskId: task.id,
		runId: task.runId,
		format: encoded.format,
		content,
		offset,
		endOffset,
		totalChars: encoded.content.length,
		complete,
		...(!complete ? { nextOffset: endOffset } : {}),
		sha256: sha256(encoded.content),
	};
}
