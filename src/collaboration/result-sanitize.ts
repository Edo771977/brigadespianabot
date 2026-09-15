import { sanitizeReplyForChannel } from "../agents/channels/reply-sanitizer.js";

const PRIVATE_BLOCK = /<(analysis|reasoning)>[\s\S]*?<\/\1>\s*/gi;
const PRIVATE_TAG = /<\/?(?:think|analysis|reasoning)>/i;

/**
 * Return only the user-visible portion of a worker reply for durable Team
 * state. Team results feed downstream workers and the coordinator, so storing
 * private reasoning would leak it through status APIs and turn it into prompt
 * material. A reasoning-only response becomes an explicit empty-result marker.
 */
export function sanitizeTeamResult(reply: string): string {
	const cleaned = sanitizeReplyForChannel(reply).replace(PRIVATE_BLOCK, "").trim();
	if (!cleaned || PRIVATE_TAG.test(cleaned)) {
		return "Worker completed without a user-visible result.";
	}
	return cleaned;
}
