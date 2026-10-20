import type { Guild } from "discord.js";
import { NO_PINGS } from "@utils/mentions.js";
import { renderCallSpeech } from "./callSpeech.js";
import { voiceCopy } from "./voiceCopy.js";
import type { VoiceSpeaker } from "./voiceSpeaker.js";

// ── join notice ────────────────────────────────────────────────────────────
// What:  what Dero does the moment a call connects: a public line saying Dero is
//        in the call and does not listen, then a short spoken hello. Also the
//        one helper that posts any voice notice in text.
// Who:   /dero join calls announceJoin after a join reaches Ready.
//        voiceSessions posts its own "the call ended" lines through
//        postVoiceNotice.
// When:  once per successful join for announceJoin; whenever a session ends on
//        its own for postVoiceNotice.
// Where: posts in the channel /dero join ran in, never in the voice channel's
//        own member chat unless that is where the command ran. Every post goes
//        out with no pings of any kind.
// How:   ① the notice first, so the text says what Dero is before Dero makes a
//        sound; ② render the greeting through callSpeech (cache, then meter,
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

/** Post one voice line in a guild text channel with every ping off. Never throws. */
export async function postVoiceNotice(guild: Guild, channelId: string, line: string): Promise<void> {
	try {
		const channel = guild.channels.cache.get(channelId);
		if (!channel || !channel.isSendable()) {
			console.warn(`[dero-voice] notice skipped guild=${guild.id} channel=${channelId} reason=unavailable`);
			return;
		}
		await channel.send({ content: line, allowedMentions: NO_PINGS });
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
	// ①
	await postVoiceNotice(guild, controlChannelId, voiceCopy.call.joinNotice(voiceChannelId));
	try {
		return await greet(guild.id, voiceId, speaker);
	}
	catch (error) {
		// renderCallSpeech never throws, so this is the speaker itself failing.
		console.warn(`[dero-voice] greeting failed guild=${guild.id}`, error);
		return "playbackFailed";
	}
}
