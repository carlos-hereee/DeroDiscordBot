import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { voiceCopy } from "./voiceCopy.js";

// ── the Listen button ──────────────────────────────────────────────────────
// What:  the one action row that rides a prose post and lets a member hear it
//        in Dero's voice, plus the single rule for whether a guild gets it.
// Who:   the two attach sites (respondWithFortune, welcomeNewMember) call
//        attachListenRow; listenHandler reads listenRefusal so the button and
//        the click can never disagree about whether voice is available.
// When:  attached after the post is sent; answered by listenHandler on a click.
// Where: prose posts ONLY (owner decision): never boards, leaderboards,
//        schedules, announcements or game state.
// How:   the customId is the bare prefix. The interaction registry routes on the
//        text before the first colon, which is why it is "dero_listen" and not
//        "dero:listen": a colon would file it under "dero", where Phase 4's
//        buttons would collide with it at boot.

export const LISTEN_PREFIX = "dero_listen";

export type ListenRefusal = "notSetUp" | "voiceOff" | "listenOff";

/**
 * Why Listen is unavailable in a guild, or null when it is available. A guild
 * with no config row has never set voice up. A stored null voice id is not a
 * refusal: it reads as Dero's default voice (resolveDeroVoiceId). ONE helper
 * drives both the button's presence and the handler's refusal (house rule 17).
 */
export function listenRefusal(config: Pick<IDeroVoiceConfig, "enabled" | "listenEnabled"> | null): ListenRefusal | null {
	if (!config) return "notSetUp";
	if (!config.enabled) return "voiceOff";
	if (!config.listenEnabled) return "listenOff";
	return null;
}

export function buildListenRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(LISTEN_PREFIX).setLabel(voiceCopy.listen.buttonLabel).setStyle(ButtonStyle.Secondary)
	);
}

/**
 * The Listen row when the guild's voice is enabled and Listen is on; otherwise
 * null, so a guild without voice never sees a dead button.
 */
export async function maybeListenRow(guildId: string | null): Promise<ActionRowBuilder<ButtonBuilder> | null> {
	if (!guildId) return null;
	const config = await deroVoiceConfigStore.findByGuildId(guildId);
	return listenRefusal(config) === null ? buildListenRow() : null;
}

/**
 * Fire and forget: add the Listen row to a post that was ALREADY delivered.
 * `apply` edits the post (editReply for an interaction reply, message.edit for a
 * channel post). Runs after the primary send so the config read can never delay
 * or break the post itself (house rule 7); a failure is logged and swallowed.
 */
export async function attachListenRow(
	guildId: string | null,
	apply: (components: ActionRowBuilder<ButtonBuilder>[]) => Promise<unknown>
): Promise<void> {
	try {
		const row = await maybeListenRow(guildId);
		if (row) await apply([row]);
	}
	catch (error) {
		console.warn(`[dero-voice] could not attach Listen guild=${guildId ?? "none"}`, error);
	}
}
