import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { renderCallSpeech, type CallSpeechInput, type CallSpeechResult } from "./callSpeech.js";
import { resolveDeroVoiceId } from "./deroVoiceId.js";
import { voiceSessions, type VoiceSessionView } from "./voiceSessions.js";

// ── callAnnouncer ──────────────────────────────────────────────────────────
// What:  speak one line of game commentary into the voice call Dero is in, if
//        it is in one, at dealer priority (below Dero's own answers and Listen).
// Who:   the hold em dealer (dealerNarration) and the Monopoly voice referee
//        (roomMonopolyReferee). Neither owns a call: each only speaks into the
//        one somebody already started with /dero join.
// When:  once per announcement, from a caller's own promise chain, so lines
//        leave in the order the game produced them.
// Where: it does not decide WHAT to say or WHETHER a game wants speech; the
//        caller does. It only re-checks what can change between two moves of a
//        long game: the call, the guild's voice switch and its voice.
// How:   ① the call; ② the voice config, enabled for this guild;
//        ③ render through renderCallSpeech, whose monthly spend cap returns
//        capReached, which is silence here; ④ the call again, since it can end
//        during the render, then hand the clip to the call's speaker.

/** The calls an announcement makes, injected so tests use fakes. */
export interface CallAnnouncerDeps {
	sessionIn(guildId: string): VoiceSessionView | null;
	loadConfig(guildId: string): Promise<IDeroVoiceConfig | null>;
	render(input: CallSpeechInput): Promise<CallSpeechResult>;
}

export const defaultCallAnnouncerDeps: CallAnnouncerDeps = {
	sessionIn: (guildId) => voiceSessions.get(guildId),
	loadConfig: (guildId) => deroVoiceConfigStore.findByGuildId(guildId),
	render: renderCallSpeech,
};

/** Speak `text` as one clip in the guild's live call, or do nothing when any check fails. */
export async function speakInCall(guildId: string, text: string, deps: CallAnnouncerDeps = defaultCallAnnouncerDeps): Promise<void> {
	// ①
	const call = deps.sessionIn(guildId);
	if (!call) return;
	// ② The guild id check guards a config store that ever answers for the wrong guild.
	const config = await deps.loadConfig(guildId);
	if (!config?.enabled || config.guildId !== guildId) return;
	// ③
	const speech = await deps.render({ guildId, voiceId: resolveDeroVoiceId(config), text });
	if (speech.status !== "ok") return;
	// ④ A line for a call that is gone is dropped rather than played into the next one.
	if (deps.sessionIn(guildId) !== call) return;
	call.speaker.speak(speech.pcm48kStereo, "dealer");
}
