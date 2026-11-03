import type { AttachmentBuilder, Guild } from "discord.js";
import { NO_PINGS } from "@utils/mentions.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { renderCallSpeech } from "./callSpeech.js";
import { voiceCopy } from "./voiceCopy.js";
import { renderVoicePresenceCard } from "./voicePresenceRenderer.js";
import type { VoiceSpeaker } from "./voiceSpeaker.js";

// ── join notice ────────────────────────────────────────────────────────────
// What:  what Dero does the moment a call connects: a public line saying, in
//        plain words, that Dero is listening to members on the task list, that
//        their speech goes to ElevenLabs to become text, that Dero keeps none of
//        it, and how to stop it; then a short spoken hello. Also the one helper
//        that posts any voice notice in text (the turn loop's text fallbacks
//        included).
// Who:   /dero join calls announceJoin after a join reaches Ready.
//        voiceSessions posts its own "the call ended" lines through
//        postVoiceNotice.
// When:  once per successful join for announceJoin; whenever a session ends on
//        its own for postVoiceNotice.
// Where: posts in the channel /dero join ran in, never in the voice channel's
//        own member chat unless that is where the command ran. Every post goes
//        out with no pings of any kind.
// How:   ① the notice first, on EVERY join, so the text says what Dero hears
//        before Dero makes a sound, with the JOINED presence card under it when
//        the card draws (the line alone when it does not); ② render the greeting through callSpeech (cache, then meter,
//        then provider); ③ queue it at brain priority, the highest, since it is
//        Dero's own line. A refused or failed render leaves the join standing,
//        silent, and the outcome tells the caller which line to show.
//
// Side effects here follow a successful primary action (the join), so nothing
// in this file throws: every failure is logged and swallowed (house rule 7).

export type GreetingOutcome = "greeted" | "capReached" | "providerTrouble" | "playbackFailed";

export interface AnnounceJoinInput {
	guild: Guild;
	controlChannelId: string;
	voiceChannelId: string;
	voiceId: string;
	speaker: VoiceSpeaker;
}

/**
 * Post one voice line in a guild text channel with every ping off, and any
 * files under it (the join notice's presence card). Never throws.
 */
export async function postVoiceNotice(guild: Guild, channelId: string, line: string, files: AttachmentBuilder[] = []): Promise<void> {
	try {
		const channel = guild.channels.cache.get(channelId);
		if (!channel || !channel.isSendable()) {
			console.warn(`[dero-voice] notice skipped guild=${guild.id} channel=${channelId} reason=unavailable`);
			return;
		}
		await channel.send({ content: line, allowedMentions: NO_PINGS, ...(files.length > 0 ? { files } : {}) });
	}
	catch (error) {
		const code = (error as { code?: unknown } | null)?.code ?? "unknown";
		console.warn(`[dero-voice] notice failed guild=${guild.id} channel=${channelId} code=${String(code)}`);
	}
}

async function greet(guildId: string, voiceId: string, speaker: VoiceSpeaker): Promise<GreetingOutcome> {
	// ②
	const speech = await renderCallSpeech({ guildId, voiceId, text: voiceCopy.call.greeting });
	if (speech.status === "capReached") return "capReached";
	if (speech.status === "failed") return "providerTrouble";
	// ③
	return speaker.speak(speech.pcm48kStereo, "brain") === "dropped" ? "playbackFailed" : "greeted";
}

/** The join's public notice, then its spoken hello. Returns how the hello went. */
export async function announceJoin({ guild, controlChannelId, voiceChannelId, voiceId, speaker }: AnnounceJoinInput): Promise<GreetingOutcome> {
	// ① The notice's text is the privacy promise, so it posts whether or not the
	// card draws; the card only rides under it.
	await postVoiceNotice(guild, controlChannelId, voiceCopy.call.joinNotice(voiceChannelId), await joinedCardFiles(guild, voiceChannelId));
	try {
		return await greet(guild.id, voiceId, speaker);
	}
	catch (error) {
		// renderCallSpeech never throws, so this is the speaker itself failing.
		console.warn(`[dero-voice] greeting failed guild=${guild.id}`, error);
		return "playbackFailed";
	}
}

// The JOINED presence card as the notice's files, or none when the card does not
// draw. The channel's name comes from the guild cache, since a card cannot draw
// the channel mention the line itself uses.
async function joinedCardFiles(guild: Guild, voiceChannelId: string): Promise<AttachmentBuilder[]> {
	const channelName = guild.channels.cache.get(voiceChannelId)?.name ?? "";
	const card = await withRenderFallback(
		() => renderVoicePresenceCard({ state: "joined", channelName }),
		() => null
	);
	return isRenderPayload(card) ? [card.attachment] : [];
}
