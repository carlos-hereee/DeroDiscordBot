import { AttachmentBuilder, MessageFlags, type ButtonInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { resolveDeroVoiceId } from "./deroVoiceId.js";
import { LISTEN_PREFIX, listenRefusal } from "./listenButton.js";
import { prepareListenText } from "./listenText.js";
import { clipCache, clipKey } from "./clipCache.js";
import { estimateTtsCents } from "./pricing.js";
import { refund, tryReserve } from "./spendMeter.js";
import { elevenLabsTts } from "./elevenLabsTts.js";
import { renderCallSpeech } from "./callSpeech.js";
import { pcm24kMonoToPcm48kStereo } from "./resample.js";
import { voiceSessions, type VoiceSessionView } from "./voiceSessions.js";
import { TtsError, type TtsClip, type TtsErrorKind } from "./ttsProvider.js";
import { voiceCopy } from "./voiceCopy.js";

// ── Listen handler ─────────────────────────────────────────────────────────
// What:  answer a Listen press with the post read aloud in Dero's voice: in the
//        voice call when the clicker and Dero are in the same one, otherwise as
//        a private reply carrying an mp3.
// Who:   the interaction registry dispatches every "dero_listen" click here;
//        main.ts registers it once at boot.
// When:  any click on a Listen row, including one on a post from an earlier
//        deploy or from before voice was disabled, which is why every gate is
//        re-checked here rather than trusted from the button's presence.
// Where: the only path from a click to a paid provider call for Listen. Every
//        render goes cooldown, then spend reservation, then provider, in that
//        order, and a failure after the reservation refunds it.
// How:   ① defer, private; ② gate on the guild's config; ③④ read and clean the
//        post's own text; ⑤ deliverClip, which decides WHERE the clip goes before
//        anything is rendered, because the two places need different formats
//        (raw 24 kHz PCM for the call, mp3 for a file) and a clip rendered in
//        the wrong one would be paid for twice. Then, for either place: replay
//        from the clip cache when it can (free, so no cooldown and no meter); on
//        a miss, cooldowns, reserve, render, refund on failure, cache and record
//        the cooldowns on success.
//
// ⚠️ PRIVACY: the text being read is never logged, stored or put in an error.
// The audit line carries the guild id, the user id, a character count, an
// outcome code and where the clip went, and nothing else.

const LISTEN_FILE_NAME = "dero-listen.mp3";
const MS_PER_SECOND = 1000;

const userCooldown = new CooldownManager(BOT_CONSTANTS.DERO_VOICE_LISTEN_USER_COOLDOWN_MS);
const guildCooldown = new CooldownManager(BOT_CONSTANTS.DERO_VOICE_LISTEN_GUILD_COOLDOWN_MS);

/** One Listen press, after the gates: who pressed it, in which voice, and the cleaned post. */
export interface ListenRequest {
	guildId: string;
	userId: string;
	voiceId: string;
	text: string;
	truncated: boolean;
}

export type ListenDelivery = "call" | "private";

export type ListenOutcome =
	| "notSetUp"
	| "voiceOff"
	| "listenOff"
	| "nothingToRead"
	| "cacheHit"
	| "cooldown"
	| "capReached"
	| "rendered"
	| "queueFull"
	| "callEnded"
	| `failed:${TtsErrorKind | "unexpected"}`;

function audit(guildId: string | null, userId: string, chars: number, outcome: ListenOutcome, delivery?: ListenDelivery): void {
	const where = delivery ? ` delivery=${delivery}` : "";
	console.info(`[dero-voice] listen guild=${guildId ?? "none"} user=${userId} chars=${chars} outcome=${outcome}${where}`);
}

async function replyPlain(interaction: ButtonInteraction, line: string): Promise<void> {
	await interaction.editReply({ content: line });
}

// ── shared by both deliveries ──

// The seconds a fresh render must wait, or 0. Checked before any spend and
// recorded only after a render succeeds, so a refused or failed render never
// burns the window. One pair of windows covers both deliveries.
function cooldownSeconds(guildId: string, userId: string): number {
	const userGate = userCooldown.check(`${guildId}:${userId}`);
	const guildGate = guildCooldown.check(guildId);
	if (!userGate.onCooldown && !guildGate.onCooldown) return 0;
	return Math.ceil(Math.max(userGate.remainingMs, guildGate.remainingMs) / MS_PER_SECOND);
}

function recordCooldowns(guildId: string, userId: string): void {
	userCooldown.record(`${guildId}:${userId}`);
	guildCooldown.record(guildId);
}

// Dero's call, but only when the clicker is in that very channel. The session is
// read first, so a guild with no call (nearly every click) never reads the
// member at all, and an uncached guild has no voice state to compare.
function callFor(interaction: ButtonInteraction, guildId: string): VoiceSessionView | null {
	const session = voiceSessions.get(guildId);
	if (!session) return null;
	const clickerChannelId = interaction.inCachedGuild() ? interaction.member.voice.channelId : null;
	return clickerChannelId === session.channelId ? session : null;
}

// ── private delivery: the Phase 1 mp3 reply, unchanged ──

async function replyWithFile(interaction: ButtonInteraction, bytes: Buffer, truncated: boolean): Promise<void> {
	await interaction.editReply({
		...(truncated ? { content: voiceCopy.listen.truncated } : {}),
		files: [new AttachmentBuilder(bytes, { name: LISTEN_FILE_NAME })],
	});
}

async function deliverPrivately(interaction: ButtonInteraction, { guildId, userId, voiceId, text, truncated }: ListenRequest): Promise<ListenOutcome> {
	// a replay costs nothing, so it skips the cooldowns and the meter
	const key = clipKey(voiceId, elevenLabsTts.modelId, "mp3", text);
	const cached = clipCache.get(key);
	if (cached) {
		await replyWithFile(interaction, cached.bytes, truncated);
		return "cacheHit";
	}

	const wait = cooldownSeconds(guildId, userId);
	if (wait > 0) {
		await replyPlain(interaction, voiceCopy.listen.cooldown(wait));
		return "cooldown";
	}

	const reserved = await tryReserve(guildId, estimateTtsCents(text.length), { ttsChars: text.length });
	if (reserved.status === "capReached") {
		await replyPlain(interaction, voiceCopy.listen.capReached);
		return "capReached";
	}

	let clip: TtsClip;
	try {
		clip = await elevenLabsTts.synthesize({ voiceId, text, format: "mp3" });
	}
	catch (error) {
		await refund(reserved.reservation);
		await replyPlain(interaction, voiceCopy.listen.providerTrouble);
		return `failed:${error instanceof TtsError ? error.kind : "unexpected"}`;
	}

	clipCache.set(key, clip);
	recordCooldowns(guildId, userId);
	await replyWithFile(interaction, clip.bytes, truncated);
	return "rendered";
}

// ── call delivery: played in the shared voice channel ──

async function deliverInCall(interaction: ButtonInteraction, request: ListenRequest, session: VoiceSessionView): Promise<ListenOutcome> {
	const { guildId, userId, voiceId, text, truncated } = request;

	// The 24 kHz original under its own cache key, so a call replay is as free as
	// a file replay. Cached call clips were already checked whole by callSpeech.
	const cached = clipCache.get(clipKey(voiceId, elevenLabsTts.modelId, "pcm24k", text));
	let pcm48kStereo: Buffer;
	let outcome: ListenOutcome;
	if (cached) {
		pcm48kStereo = pcm24kMonoToPcm48kStereo(cached.bytes);
		outcome = "cacheHit";
	}
	else {
		const wait = cooldownSeconds(guildId, userId);
		if (wait > 0) {
			await replyPlain(interaction, voiceCopy.listen.cooldown(wait));
			return "cooldown";
		}
		// The same render path as Dero's own lines in a call: meter, render,
		// refund on failure, cache, resample.
		const speech = await renderCallSpeech({ guildId, voiceId, text });
		if (speech.status === "capReached") {
			await replyPlain(interaction, voiceCopy.listen.capReached);
			return "capReached";
		}
		if (speech.status === "failed") {
			await replyPlain(interaction, voiceCopy.listen.providerTrouble);
			return `failed:${speech.kind}`;
		}
		recordCooldowns(guildId, userId);
		pcm48kStereo = speech.pcm48kStereo;
		outcome = "rendered";
	}

	// A render takes a second or two, and the call can end in it. A closed
	// speaker would drop the clip anyway; this says the true reason.
	if (voiceSessions.get(guildId) !== session) {
		await replyPlain(interaction, voiceCopy.listen.callEnded);
		return "callEnded";
	}
	if (session.speaker.speak(pcm48kStereo, "listen") === "dropped") {
		await replyPlain(interaction, voiceCopy.listen.callQueueFull);
		return "queueFull";
	}

	const playing = voiceCopy.listen.playingInCall(session.channelId);
	await replyPlain(interaction, truncated ? `${playing}\n${voiceCopy.listen.truncated}` : playing);
	return outcome;
}

/**
 * ⑤ The ONE place a Listen clip reaches a member. Decides where first: the
 * shared voice call when the clicker is in the channel Dero is in, otherwise
 * the private mp3 reply exactly as Phase 1 built it. Renders in the format that
 * place needs, and reports what happened and where.
 */
export async function deliverClip(
	interaction: ButtonInteraction,
	request: ListenRequest,
): Promise<{ outcome: ListenOutcome; delivery: ListenDelivery }> {
	const session = callFor(interaction, request.guildId);
	if (session) return { outcome: await deliverInCall(interaction, request, session), delivery: "call" };
	return { outcome: await deliverPrivately(interaction, request), delivery: "private" };
}

export async function handleListen(interaction: ButtonInteraction): Promise<void> {
	// ① Private from the first byte: a member's Listen is nobody else's business,
	// and the render can outlast Discord's 3 second acknowledgement window.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const guildId = interaction.guildId;
	const userId = interaction.user.id;
	let chars = 0;

	try {
		// ② gate on the guild's config, re-read on every click
		const config = guildId ? await deroVoiceConfigStore.findByGuildId(guildId) : null;
		const refusal = listenRefusal(config);
		if (!guildId || !config || refusal) {
			const reason = refusal ?? "notSetUp";
			await replyPlain(interaction, voiceCopy.listen[reason]);
			audit(guildId, userId, chars, reason);
			return;
		}

		// ③④ the post's own text, cleaned and cut
		const prepared = prepareListenText(interaction.message);
		chars = prepared.text.length;
		if (chars === 0) {
			await replyPlain(interaction, voiceCopy.listen.nothingToRead);
			audit(guildId, userId, chars, "nothingToRead");
			return;
		}

		// ⑤
		const { outcome, delivery } = await deliverClip(interaction, {
			guildId,
			userId,
			voiceId: resolveDeroVoiceId(config),
			text: prepared.text,
			truncated: prepared.truncated,
		});
		audit(guildId, userId, chars, outcome, delivery);
	}
	catch (error) {
		// A store or Discord failure outside the render. The reply was deferred, so
		// without this the member would watch "thinking" forever. The error object
		// comes from Mongo or Discord and holds no spoken text.
		console.error(`[dero-voice] listen failed guild=${guildId ?? "none"} user=${userId} chars=${chars}`, error);
		audit(guildId, userId, chars, "failed:unexpected");
		await replyPlain(interaction, voiceCopy.listen.providerTrouble).catch(() => undefined);
	}
}

/**
 * Register the Listen button. Called once at boot from main.ts, before the
 * InteractionCreate listener installs, like every other persistent handler, so a
 * Listen row posted by an earlier deploy keeps working.
 */
export function registerListenHandlers(): void {
	registerButton(LISTEN_PREFIX, handleListen);
}
