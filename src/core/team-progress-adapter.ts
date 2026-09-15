/**
 * Translate Brigade's internal per-turn event stream into Team Mode's lossy
 * progress vocabulary. Durable lifecycle state never flows through here.
 *
 * Tool arguments/results are intentionally omitted: they can be large and may
 * contain credentials or private document contents. The room UI gets the tool
 * name, call id, phase, and error bit; durable artifacts are published through
 * the fenced Team task tool instead.
 */

import type { AgentBusEvent } from "../agents/agent-event-bus.js";
import type { TeamProgressKind } from "../protocol/team.js";

export interface TeamProgressUpdate {
	kind: TeamProgressKind;
	payload: Record<string, unknown>;
}

const MAX_DELTA_CHARS = 16_384;
const PRIVATE_TAGS = ["think", "thinking", "analysis", "reasoning"] as const;

function longestPrivatePrefixSuffix(value: string, candidates: readonly string[]): number {
	const lower = value.toLowerCase();
	let keep = 0;
	for (const candidate of candidates) {
		const limit = Math.min(lower.length, candidate.length - 1);
		for (let length = 1; length <= limit; length += 1) {
			if (lower.endsWith(candidate.slice(0, length))) keep = Math.max(keep, length);
		}
	}
	return keep;
}

/** Stateful because a provider can split `<think>` across arbitrary deltas. */
export class TeamProgressTextRedactor {
	private pending = "";
	private privateTag: string | undefined;

	push(chunk: string): string {
		this.pending += chunk;
		let visible = "";
		while (this.pending.length > 0) {
			if (this.privateTag) {
				const closing = `</${this.privateTag}>`;
				const index = this.pending.toLowerCase().indexOf(closing);
				if (index >= 0) {
					this.pending = this.pending.slice(index + closing.length);
					this.privateTag = undefined;
					continue;
				}
				const keep = longestPrivatePrefixSuffix(this.pending, [closing]);
				this.pending = keep > 0 ? this.pending.slice(-keep) : "";
				break;
			}

			const start = this.pending.indexOf("<");
			if (start < 0) {
				const prefixes = PRIVATE_TAGS.map((tag) => `<${tag}`);
				const keep = longestPrivatePrefixSuffix(this.pending, prefixes);
				visible += keep > 0 ? this.pending.slice(0, -keep) : this.pending;
				this.pending = keep > 0 ? this.pending.slice(-keep) : "";
				break;
			}
			visible += this.pending.slice(0, start);
			this.pending = this.pending.slice(start);
			const open = /^<(think|thinking|analysis|reasoning)\b[^>]*>/iu.exec(this.pending);
			if (open) {
				this.privateTag = open[1]?.toLowerCase();
				this.pending = this.pending.slice(open[0].length);
				continue;
			}
			const lower = this.pending.toLowerCase();
			const mightBePrivateTag = PRIVATE_TAGS.some((tag) => {
				const prefix = `<${tag}`;
				return prefix.startsWith(lower) || (lower.startsWith(prefix) && !lower.includes(">"));
			});
			if (mightBePrivateTag && this.pending.length <= 256) break;
			visible += "<";
			this.pending = this.pending.slice(1);
		}
		return visible;
	}
}

function boundedDelta(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value.length <= MAX_DELTA_CHARS ? value : value.slice(0, MAX_DELTA_CHARS);
}

/** Return undefined for internal events that have no useful room-UI form. */
export function toTeamProgressUpdate(event: AgentBusEvent): TeamProgressUpdate | undefined {
	if (event.type === "turn-heartbeat") {
		return {
			kind: "attempt.heartbeat",
			payload: { elapsedMs: event.elapsedMs },
		};
	}
	if (event.type === "tool-update") {
		return {
			kind: "tool.updated",
			payload: { toolCallId: event.toolCallId, toolName: event.toolName },
		};
	}
	if (event.type !== "pi" || !event.piEvent || typeof event.piEvent !== "object") {
		return undefined;
	}

	const pi = event.piEvent as {
		type?: unknown;
		toolCallId?: unknown;
		toolName?: unknown;
		isError?: unknown;
		assistantMessageEvent?: { type?: unknown; delta?: unknown };
	};
	if (pi.type === "message_update") {
		const inner = pi.assistantMessageEvent;
		const delta = boundedDelta(inner?.delta);
		if (inner?.type === "text_delta" && delta !== undefined) {
			return { kind: "assistant.delta", payload: { delta } };
		}
		// Provider reasoning is private implementation state. Do not put it on
		// the room progress stream, even though older protocol peers may know the
		// legacy kind. User-visible work is represented by text and tool phases.
		return undefined;
	}

	const toolCallId = typeof pi.toolCallId === "string" ? pi.toolCallId : undefined;
	const toolName = typeof pi.toolName === "string" ? pi.toolName : undefined;
	if (!toolCallId || !toolName) return undefined;
	if (pi.type === "tool_execution_start") {
		return { kind: "tool.started", payload: { toolCallId, toolName } };
	}
	if (pi.type === "tool_execution_update") {
		return { kind: "tool.updated", payload: { toolCallId, toolName } };
	}
	if (pi.type === "tool_execution_end") {
		return {
			kind: "tool.finished",
			payload: { toolCallId, toolName, isError: pi.isError === true },
		};
	}
	return undefined;
}

/** One adapter per attempt; never share the redactor across concurrent turns. */
export function createTeamProgressAdapter(): (event: AgentBusEvent) => TeamProgressUpdate | undefined {
	const redactor = new TeamProgressTextRedactor();
	return (event) => {
		if (event.type === "pi" && event.piEvent && typeof event.piEvent === "object") {
			const pi = event.piEvent as { type?: unknown; assistantMessageEvent?: { type?: unknown; delta?: unknown } };
			if (pi.type === "message_update" && pi.assistantMessageEvent?.type === "text_delta") {
				const raw = boundedDelta(pi.assistantMessageEvent.delta);
				if (raw === undefined) return undefined;
				const delta = redactor.push(raw);
				return delta ? { kind: "assistant.delta", payload: { delta } } : undefined;
			}
		}
		return toTeamProgressUpdate(event);
	};
}
