interface TranscriptRecord {
	type?: unknown;
	customType?: unknown;
	details?: { idempotencyKey?: unknown };
	message?: { role?: unknown; stopReason?: unknown; content?: unknown };
}

function visibleText(content: unknown): string {
	if (typeof content === "string") return content.trim() ? content : "";
	if (!Array.isArray(content)) return "";
	const text = content
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const value = block as { type?: unknown; text?: unknown };
			return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
		})
		.join("");
	return text.trim() ? text : "";
}

/** Recover the settled visible reply for a hidden turn. This lets a durable
 * side effect be retried without asking the model to repeat completed work. */
export function completedInternalTurnReply(
	records: readonly TranscriptRecord[],
	idempotencyKey: string,
): string | undefined {
	for (let start = 0; start < records.length; start += 1) {
		const marker = records[start];
		if (marker?.type !== "custom_message"
			|| marker.customType !== "brigade-internal-turn"
			|| marker.details?.idempotencyKey !== idempotencyKey) continue;
		const parts: string[] = [];
		for (let index = start + 1; index < records.length; index += 1) {
			const record = records[index];
			if (record?.type === "custom_message" || record?.message?.role === "user") break;
			if (record?.type !== "message" || record.message?.role !== "assistant") continue;
			const stopReason = String(record.message.stopReason);
			if (["toolUse", "error", "aborted"].includes(stopReason)) continue;
			const text = visibleText(record.message.content);
			if (text) parts.push(text);
		}
		if (parts.length > 0) return parts.join("").trim();
	}
	return undefined;
}

/**
 * A hidden turn is complete only when its transcript segment contains a final
 * visible assistant message. Tool-use and provider-error messages do not count.
 * Stop at the next input boundary so a later operator turn cannot be mistaken
 * for completion of a failed hidden turn.
 */
export function hasCompletedInternalTurn(
	records: readonly TranscriptRecord[],
	idempotencyKey: string,
): boolean {
	return completedInternalTurnReply(records, idempotencyKey) !== undefined;
}
