import type { Client } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { announcementLine, type AnnouncementKind } from "@features/dero-brain/dealerNarration.js";
import { speakInCall } from "@features/voice/callAnnouncer.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { cardVoiceState } from "./cardVoiceState.js";
import { refereeOn } from "./roomTypes.js";
import { pickLine } from "@utils/pickLine.js";

// ── roomAnnouncer ────────────────────────────────────────────────────
// What:  Dero calling a challenge card or a room to order out loud (2026-10 item 267, owner
//        decisions 13 to 15): "new challengers at the door" when a member joins or asks to join a
//        card, the Start countdown, and the turn clock's warning and turn over lines.
// Who:   challengeBoard and hostControls (a pool add, a request), startCountdown (the count in)
//        and turnClock (the warning and the end of a turn).
// Does NOT: ask for a voice join, post a text line or ping anybody. It speaks only into a call
//        Dero is already in for this card or room, so a card whose Dero is busy elsewhere or
//        queued stays silent rather than talking over another match.
// Where: speech goes through callAnnouncer.speakInCall like the dealer and the Monopoly referee,
//        which re-checks the call, the guild's voice switch and the spend cap before speaking.

type AnnouncedRoom = Pick<IGameRoom, "guildId" | "roomId" | "hostId" | "game" | "deroVoice" | "referee" | "monopolyReferee">;

const dealerWords = deroBrainCopy.dealer;

/**
 * Whether Dero is in this card's or room's call right now: the host turned Dero voice on, a
 * call is live in the guild, and that call is this match's. It is this match's when ① its own
 * request started it (the card's or the room's referee request carries the room id), ② it is
 * the host's current call (Dero was already there when the card posted, so nothing joined), or
 * ③ the card asked for Dero and holds no busy or queued line, which means the request found
 * Dero already in the call it asked for. A call another match brought Dero into fits none.
 */
export function isDeroInMatchCall(client: Client, room: AnnouncedRoom): boolean {
	if (!refereeOn(room)) return false;
	const call = voiceSessions.get(room.guildId);
	if (!call) return false;
	if (call.startedByRoomId === room.roomId) return true;
	const hostCallId = client.guilds.cache.get(room.guildId)?.voiceStates.cache.get(room.hostId)?.channelId ?? null;
	if (hostCallId === call.channelId) return true;
	return cardVoiceState.wasRequested(room.roomId) && cardVoiceState.get(room.roomId) === null;
}

/**
 * Speak one announcement into the match's call when Dero is in it. Fire and forget after the
 * action that caused it (rulebook convention 7): it never throws, and nothing waits on a render.
 */
export async function announceToMatch(client: Client, room: AnnouncedRoom, kind: AnnouncementKind, spoken: string): Promise<void> {
	try {
		if (!isDeroInMatchCall(client, room)) return;
		await speakInCall(room.guildId, announcementLine(kind, spoken).spoken);
	} catch (error) {
		console.warn(`[game-rooms] Dero's ${kind} announcement did not play`, { roomId: room.roomId, error });
	}
}

/** "New challengers at the door", and under approval that the host should check Requests. */
export function announceChallengers(client: Client, room: AnnouncedRoom, asking: boolean): void {
	void announceToMatch(client, room, "challengers", pickLine(asking ? dealerWords.challengersAsking : dealerWords.challengers));
}

// Hold'em's dealer and the Monopoly referee already say who won, in their own narration, so the
// result is spoken here for every other game only, never twice.
const NARRATES_OWN_RESULT: ReadonlySet<string> = new Set(["holdem", "monopoly"]);

// The result line is written for the card: an emoji, bold and mentions. Speech wants the words.
const LINE_EMOJI = /\p{Extended_Pictographic}️?\s*/gu;
const BOLD = /\*\*/g;
const MENTION = /<@!?([\w-]+)>/g;

/**
 * Dero calls a finished match's result in its call (owner decision of 2026-10-29): a "game over"
 * opener and the same line the closed challenge card shows, mentions read as names. Fire and
 * forget after the finish; it never throws and speaks only when Dero is in the match's call.
 */
export function announceMatchResult(client: Client, room: AnnouncedRoom, resultLine: string): void {
	if (NARRATES_OWN_RESULT.has(room.game)) return;
	void (async () => {
		if (!isDeroInMatchCall(client, room)) return;
		const ids = [...new Set([...resultLine.matchAll(MENTION)].map((match) => match[1]))];
		const names = new Map(await Promise.all(ids.map(async (id) => [id, await spokenNameOf(client, room.guildId, id)] as const)));
		const said = resultLine.replace(MENTION, (_mention, id: string) => names.get(id) ?? dealerWords.unknownPlayer).replace(BOLD, "").replace(LINE_EMOJI, "").trim();
		await announceToMatch(client, room, "commentary", `${pickLine(dealerWords.gameOver)} ${said}`);
	})().catch((error: unknown) => console.warn("[game-rooms] the match result was not spoken", { roomId: room.roomId, error }));
}

/** The name Dero says for a member: their name in the server, or a neutral word when it cannot be read. */
export async function spokenNameOf(client: Client, guildId: string, userId: string): Promise<string> {
	const guild = client.guilds.cache.get(guildId);
	const member = guild ? (guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null))) : null;
	return member?.displayName ?? member?.user.username ?? dealerWords.unknownPlayer;
}

/** The warning's lead, in the whole seconds every line says. */
export const warningSeconds = (): number => Math.round(BOT_CONSTANTS.TURN_WARNING_LEAD_MS / 1000);
