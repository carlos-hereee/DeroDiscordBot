import { AttachmentBuilder, MessageFlags, type ButtonInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { LISTEN_PREFIX, listenRefusal } from "./listenButton.js";
import { prepareListenText } from "./listenText.js";
import { clipCache, clipKey } from "./clipCache.js";
import { estimateTtsCents } from "./pricing.js";
import { refund, tryReserve } from "./spendMeter.js";
import { elevenLabsTts } from "./elevenLabsTts.js";
import { TtsError, type TtsClip, type TtsErrorKind } from "./ttsProvider.js";
import { voiceCopy } from "./voiceCopy.js";

// ── Listen handler ─────────────────────────────────────────────────────────
// What:  answer a Listen press with the post read aloud in Dero's voice, as a
//        private reply carrying an mp3.
// Who:   the interaction registry dispatches every "dero_listen" click here;
//        main.ts registers it once at boot.
// When:  any click on a Listen row, including one on a post from an earlier
//        deploy or from before voice was disabled, which is why every gate is
//        re-checked here rather than trusted from the button's presence.
// Where: the only path from a click to a paid provider call in Phase 1. Every
//        render goes cooldown, then spend reservation, then provider, in that
//        order, and a failure after the reservation refunds it.
// How:   ① defer, private; ② gate on the guild's config; ③④ read and clean the
//        post's own text; ⑤ replay from the clip cache when it can (free, so no
//        cooldown and no meter); ⑥ on a miss: cooldowns, reserve, render, refund
//        on failure, cache and record the cooldowns on success; ⑦ deliverClip.
//
// ⚠️ PRIVACY: the text being read is never logged, stored or put in an error.
// The audit line carries the guild id, the user id, a character count and an
// outcome code, and nothing else.

const LISTEN_FILE_NAME = "dero-listen.mp3";
const MS_PER_SECOND = 1000;

const userCooldown = new CooldownManager(BOT_CONSTANTS.DERO_VOICE_LISTEN_USER_COOLDOWN_MS);
const guildCooldown = new CooldownManager(BOT_CONSTANTS.DERO_VOICE_LISTEN_GUILD_COOLDOWN_MS);

// A clip ready to hand to a member, plus whether the post was cut short.
export interface ListenClip extends TtsClip {
	truncated: boolean;
}

type ListenOutcome =
	| "notSetUp"
	| "voiceOff"
	| "listenOff"
	| "nothingToRead"
	| "cacheHit"
	| "cooldown"
	| "capReached"
	| "rendered"
	| `failed:${TtsErrorKind | "unexpected"}`;

function audit(guildId: string | null, userId: string, chars: number, outcome: ListenOutcome): void {
	console.info(`[dero-voice] listen guild=${guildId ?? "none"} user=${userId} chars=${chars} outcome=${outcome}`);
}

async function replyPlain(interaction: ButtonInteraction, line: string): Promise<void> {
	await interaction.editReply({ content: line });
}

/**
 * ⑦ The ONE place a Listen clip reaches a member. Today: the private reply with
 * the mp3 attached. Phase 3 adds its "play it in the shared voice channel" branch
 * HERE and nowhere else, so every Listen path picks up in call playback at once.
 */
export async function deliverClip(interaction: ButtonInteraction, clip: ListenClip): Promise<void> {
	await interaction.editReply({
		...(clip.truncated ? { content: voiceCopy.listen.truncated } : {}),
		files: [new AttachmentBuilder(clip.bytes, { name: LISTEN_FILE_NAME })],
	});
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
		const voiceId = config?.voiceId;
		if (!guildId || refusal || !voiceId) {
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

		// ⑤ a replay costs nothing, so it skips the cooldowns and the meter
		const key = clipKey(voiceId, elevenLabsTts.modelId, "mp3", prepared.text);
		const cached = clipCache.get(key);
		if (cached) {
			await deliverClip(interaction, { ...cached, truncated: prepared.truncated });
			audit(guildId, userId, chars, "cacheHit");
			return;
		}

		// ⑥ a fresh render: cooldowns first (checked, not yet recorded)
		const userKey = `${guildId}:${userId}`;
		const userGate = userCooldown.check(userKey);
		const guildGate = guildCooldown.check(guildId);
		if (userGate.onCooldown || guildGate.onCooldown) {
			const seconds = Math.ceil(Math.max(userGate.remainingMs, guildGate.remainingMs) / MS_PER_SECOND);
			await replyPlain(interaction, voiceCopy.listen.cooldown(seconds));
			audit(guildId, userId, chars, "cooldown");
			return;
		}

		const reserved = await tryReserve(guildId, estimateTtsCents(chars), { ttsChars: chars });
		if (reserved.status === "capReached") {
			await replyPlain(interaction, voiceCopy.listen.capReached);
			audit(guildId, userId, chars, "capReached");
			return;
		}

		let clip: TtsClip;
		try {
			clip = await elevenLabsTts.synthesize({ voiceId, text: prepared.text, format: "mp3" });
		}
		catch (error) {
			await refund(reserved.reservation);
			await replyPlain(interaction, voiceCopy.listen.providerTrouble);
			audit(guildId, userId, chars, `failed:${error instanceof TtsError ? error.kind : "unexpected"}`);
			return;
		}

		clipCache.set(key, clip);
		// Recorded only now, so a refused or failed render never burns the window.
		userCooldown.record(userKey);
		guildCooldown.record(guildId);

		// ⑦
		await deliverClip(interaction, { ...clip, truncated: prepared.truncated });
		audit(guildId, userId, chars, "rendered");
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
