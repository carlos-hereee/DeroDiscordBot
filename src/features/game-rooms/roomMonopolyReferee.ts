import type { Client, Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { MonopolyState } from "@features/games/monopolyState.js";
import { defaultCallAnnouncerDeps, speakInCall, type CallAnnouncerDeps } from "@features/voice/callAnnouncer.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { botSeatName, isBotSeatId, memberIdsOnly } from "./botSeat.js";

// ── roomMonopolyReferee ──────────────────────────────────────────────
// What:  Dero as a Monopoly match's voice referee: the key moments of each move
//        (whose turn it is, buys, big rents, jail, cards, auctions, debts,
//        bankruptcies and the winner) spoken into the voice call Dero is in.
// Who:   roomMonopolyHandlers.applyMonopolyOutcome, the tail every move reaches
//        (buttons, modals, selects and both sweeps), once the trail is posted.
// When:  only for a room whose host turned the referee on at the challenge card,
//        and only while Dero is in a call that a seat still playing is in.
// Where: voice only. The trail already posts every line in text, so this file
//        never writes to a channel and never touches the transcript. What it says
//        is the engine's own trail wording, filtered, so the voice cannot disagree
//        with the board.
// How:   ① keep the trail lines on the spoken allowlist, cutting a card's flavor
//        and dropping small rents; ② a turn handoff is its own clip (the same few
//        names repeat, so the clip cache makes it free after the first time) and
//        the other lines between handoffs join into one clip, because the spend
//        meter charges per clip; ③ per room, a promise chain delivers the clips in
//        the order the moves happened; ④ at delivery, re-check the call and that a
//        seat still playing is in it, swap mentions for display names, and speak
//        each clip through the call announcer, which checks the voice config and
//        the monthly spend cap.

// ── ① the spoken allowlist ──
// Every pattern matches a line the engine (features/games/monopoly*.ts) or the
// idle sweep (gameRoomsCopy.monopoly.idle*) writes. The tests drive these from real
// engine results, so a reworded trail line turns a test red rather than going quiet.
// Hyphens too: a Dero bot seat's mention is `<@dero-bot-red>` (2026-10 item 250 Phase 5).
const PLAYER = String.raw`<@!?[\w-]+>`;

const TURN_HANDOFF = new RegExp(String.raw`^It is now ${PLAYER}'s turn\.$`);
const RENT_PAID = new RegExp(String.raw`^${PLAYER} paid \$(\d+) rent to ${PLAYER}\.$`);
const CARD_DRAWN = new RegExp(String.raw`^${PLAYER} drew `);

const SPOKEN_AS_WRITTEN: readonly RegExp[] = [
	/ rolled doubles and rolls again\.$/,
	new RegExp(String.raw`^${PLAYER} bought .+ for \$\d+\.$`),
	/ goes straight to Jail\.$/,
	/ rolled doubles \d+ times in a row and goes to Jail\.$/,
	/ and is free to roll\.$/,
	/ rolled doubles and walks out of Jail\.$/,
	/ used the last try, pays \$\d+ bail and moves\.$/,
	/, and it goes up for auction\.$/,
	/ at auction for \$\d+\.$/,
	/^Nobody bid on .+, so it stays with the bank\.$/,
	/, so they need to mortgage lots or sell buildings to raise the rest, then pay\.$/,
	/ and is bankrupt\.$/,
	new RegExp(String.raw`^${PLAYER} wins the match\.$`),
	/ stayed on the clock for \d+ hours without a move, /,
	/ left a debt unpaid for \d+ hours, /,
];

// The idle sweep's lines open with an hourglass, which a voice would read out as a word.
const LEADING_EMOJI = /^\p{Extended_Pictographic}️?\s*/u;

/** One trail line Dero says, with its mentions still in it. */
export interface SpokenRefereeLine {
	text: string;
	handoff: boolean;
}

// "<@a> drew Wrong Turn. Dero read the map upside down again." keeps only the card,
// cut at the first sentence end after "drew", because the flavor is for reading.
function withoutCardFlavor(line: string): string {
	const sentenceEnd = line.indexOf(". ", line.indexOf(" drew "));
	return sentenceEnd === -1 ? line : line.slice(0, sentenceEnd + 1);
}

function spokenForm(line: string): string | null {
	if (TURN_HANDOFF.test(line)) return line;
	if (CARD_DRAWN.test(line)) return withoutCardFlavor(line);
	const rent = RENT_PAID.exec(line);
	if (rent) return Number(rent[1]) >= BOT_CONSTANTS.MONOPOLY_REFEREE_BIG_RENT ? line : null;
	if (SPOKEN_AS_WRITTEN.some((pattern) => pattern.test(line))) return line.replace(LEADING_EMOJI, "");
	return null;
}

/** ① The trail lines Dero says, in trail order: the allowlist, the card cut and the rent bar applied. */
export function pickRefereeLines(lines: readonly string[]): SpokenRefereeLine[] {
	const spoken: SpokenRefereeLine[] = [];
	for (const line of lines) {
		const text = spokenForm(line);
		if (text !== null) spoken.push({ text, handoff: TURN_HANDOFF.test(line) });
	}
	return spoken;
}

/** ② The clips for one move, in order: each handoff alone, the lines between handoffs joined. */
export function groupIntoClips(lines: readonly SpokenRefereeLine[]): string[] {
	const clips: string[] = [];
	let pending: string[] = [];
	const closePending = (): void => {
		if (pending.length > 0) clips.push(pending.join(" "));
		pending = [];
	};
	for (const line of lines) {
		if (!line.handoff) {
			pending.push(line.text);
			continue;
		}
		closePending();
		clips.push(line.text);
	}
	closePending();
	return clips;
}

// ── ④ names for mentions ──
const MENTION = /<@!?([\w-]+)>/g;

function mentionedIds(clips: readonly string[]): string[] {
	const ids = new Set<string>();
	for (const clip of clips) for (const match of clip.matchAll(MENTION)) ids.add(match[1]);
	return [...ids];
}

// The cache first, then ONE fetch for whoever it lacks, rather than resolveParticipants'
// fetch of everyone: this runs on every spoken move, and a fetch of a user list is a
// gateway request each time, while seated players are almost always cached already.
async function displayNamesIn(guild: Guild, userIds: readonly string[]): Promise<Map<string, string>> {
	// A Dero bot is said by its name and never fetched: its id is not a member's, and one
	// bad id in the list would fail the fetch for every member in it.
	const missing = memberIdsOnly(userIds).filter((userId) => !guild.members.cache.has(userId));
	if (missing.length > 0) await guild.members.fetch({ user: missing }).catch(() => null);
	const fallback = gameRoomsCopy.monopoly.refereeUnknownPlayer;
	const nameOf = (userId: string): string => (isBotSeatId(userId) ? botSeatName(userId) : (guild.members.cache.get(userId)?.displayName ?? fallback));
	return new Map(userIds.map((userId) => [userId, nameOf(userId)]));
}

/** A clip with every mention replaced by that member's display name. */
export function withNames(clip: string, names: ReadonlyMap<string, string>): string {
	return clip.replace(MENTION, (_mention, userId: string) => names.get(userId) ?? gameRoomsCopy.monopoly.refereeUnknownPlayer);
}

// ── ③ delivery, one chain per room ──
// Memory only: a restart forgets a chain, and the next move starts a fresh one. An
// entry deletes itself once its last clip has gone, so a finished or abandoned match
// leaves nothing behind.
const refereeChains = new Map<string, Promise<void>>();

// ④ Re-checked at delivery, not at announce, because a clip waits behind the ones
// before it and the call can change in between. The call announcer checks the call
// again, plus the voice config and the spend cap, for every clip.
async function deliver(client: Client, guildId: string, seatIds: readonly string[], clips: readonly string[], deps: CallAnnouncerDeps): Promise<void> {
	const call = deps.sessionIn(guildId);
	if (!call) return;
	const guild = client.guilds.cache.get(guildId);
	if (!guild) return;
	// Never call a match into a call nobody from the match is in.
	const seatInCall = seatIds.some((userId) => guild.voiceStates.cache.get(userId)?.channelId === call.channelId);
	if (!seatInCall) return;

	const names = await displayNamesIn(guild, mentionedIds(clips));
	for (const clip of clips) await speakInCall(guildId, withNames(clip, names), deps);
}

export interface AnnounceRefereeInput {
	client: Client;
	room: IGameRoom;
	/** The match AFTER the move, whose seats still playing decide who must be in the call. */
	state: MonopolyState;
	/** The move's trail lines, exactly as posted. */
	lines: readonly string[];
}

/**
 * Speak one move's key moments, if the room has Dero as its referee. Fire and
 * forget: it never throws and never delays the caller, and a room without the
 * referee costs one field read.
 */
export function announceReferee({ client, room, state, lines }: AnnounceRefereeInput, deps: CallAnnouncerDeps = defaultCallAnnouncerDeps): void {
	if (!room.monopolyReferee) return;
	try {
		const clips = groupIntoClips(pickRefereeLines(lines));
		if (clips.length === 0) return;
		const seatIds = state.seats.filter((seat) => !seat.bankrupt).map((seat) => seat.userId);
		const roomId = room.roomId;

		const previous = refereeChains.get(roomId) ?? Promise.resolve();
		const next = previous
			.then(() => deliver(client, room.guildId, seatIds, clips, deps))
			.catch((error) => console.error(`[monopoly-referee] announcement failed room=${roomId}`, error));
		refereeChains.set(roomId, next);
		void next.finally(() => {
			if (refereeChains.get(roomId) === next) refereeChains.delete(roomId);
		});
	}
	catch (error) {
		console.error(`[monopoly-referee] announcement skipped room=${room.roomId}`, error);
	}
}

/** Test seam: resolves once every clip queued for the room so far has been delivered. */
export function _refereeSettled(roomId: string): Promise<void> {
	return refereeChains.get(roomId) ?? Promise.resolve();
}
