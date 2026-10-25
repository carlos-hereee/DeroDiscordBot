import { MessagePayload, type BaseMessageOptions, type RepliableInteraction } from "discord.js";

// ── the reply collector ──────────────────────────────────────────────────────
// What:  lets a settings panel run a command's shared handler several times on ONE
//        modal submit, keeping what each run would have replied instead of sending it.
// Who:   adminCommandLauncher's settings panel submit, once per changed setting. Each
//        handler (auto heal, a voice list edit, a channel hide) replies as it always
//        does, and the launcher sends the collected answers as one private reply.
// Why:   a submit can be answered once. The obvious alternative, lifting each
//        handler's write out into a function the panel calls, would give every
//        setting a second path past its own validation and audit line; running the
//        very handler the slash command runs keeps one path per setting, which is
//        how the admin command launcher already works.
// How:   a Proxy over the real interaction. reply, editReply and followUp record the
//        payload, deferReply only marks the run deferred, and replied and deferred
//        answer for the run; everything else (guild, user, client, ids) reads through
//        to the real interaction, so a handler cannot tell it is being collected.

/** The parts of one collected reply the launcher passes on. */
export interface CollectedReply {
	content: string | null;
	embeds: NonNullable<BaseMessageOptions["embeds"]>[number][];
	components: NonNullable<BaseMessageOptions["components"]>[number][];
}

type ReplyPayload = string | MessagePayload | Pick<BaseMessageOptions, "content" | "embeds" | "components">;

function partsOf(payload: ReplyPayload): CollectedReply {
	if (typeof payload === "string") return { content: payload, embeds: [], components: [] };
	// No shared handler replies with a MessagePayload; one that starts to is recorded
	// as empty rather than guessed at, and says so in the log.
	if (payload instanceof MessagePayload) {
		console.warn("[reply-collector] a handler replied with a MessagePayload, which a settings panel does not collect");
		return { content: null, embeds: [], components: [] };
	}
	return { content: payload.content ?? null, embeds: [...(payload.embeds ?? [])], components: [...(payload.components ?? [])] };
}

/**
 * A stand in for `interaction` that records every reply instead of sending it, and
 * the list the replies land in. One per handler run: `replied` and `deferred` start
 * false for each, the way a fresh slash command's would.
 */
export function collectReplies(interaction: RepliableInteraction): { interaction: RepliableInteraction; replies: CollectedReply[] } {
	const replies: CollectedReply[] = [];
	const state = { replied: false, deferred: false };

	const record = (payload: ReplyPayload): Promise<undefined> => {
		replies.push(partsOf(payload));
		state.replied = true;
		return Promise.resolve(undefined);
	};
	// An edit replaces what the run said last, as it would on Discord; after only a
	// defer there is nothing to replace, so it is the run's first reply.
	const edit = (payload: ReplyPayload): Promise<undefined> => {
		if (replies.length > 0) replies.pop();
		return record(payload);
	};
	const defer = (): Promise<undefined> => {
		state.deferred = true;
		return Promise.resolve(undefined);
	};
	const intercepted = new Map<PropertyKey, unknown>([
		["reply", record],
		["followUp", record],
		["editReply", edit],
		["deferReply", defer],
	]);

	const collecting = new Proxy(interaction, {
		get(target, property) {
			if (property === "replied") return state.replied;
			if (property === "deferred") return state.deferred;
			if (intercepted.has(property)) return intercepted.get(property);
			// Getters and methods run against the real interaction: discord.js reads
			// private fields off `this`, which a Proxy does not carry.
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { interaction: collecting, replies };
}
