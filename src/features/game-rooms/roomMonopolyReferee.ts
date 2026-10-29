import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { MonopolyState } from "@features/games/monopolyState.js";
import { defaultCallAnnouncerDeps, isVoiceEnabled, speakInCall, type CallAnnouncement, type CallAnnouncerDeps } from "@features/voice/callAnnouncer.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { displayNamesIn, isTurnHandoffLine, PLAYER_MENTION_PATTERN } from "./roomMonopolyBoard.js";
import { refereeOn } from "./roomTypes.js";
import { pickLine } from "@utils/pickLine.js";

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
// The mention pattern and the handoff check live with the board, which splits a turn's
// log on the same line (roomMonopolyBoard).
const PLAYER = PLAYER_MENTION_PATTERN;
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

// ── the commentary (owner decision of 2026-10-29: Dero narrates like a commentator) ──
// The roll, the landing and the turn handoff are spoken in Dero's own words, built only from
// what the engine's line says (and, for a handoff, who held the dice before), so the voice and
// the board never disagree.
const ROLLED = new RegExp(String.raw`^(${PLAYER}) rolled (\d+) and (\d+)\.$`);
const LANDED = new RegExp(String.raw`^(${PLAYER}) landed on (.+)\.$`);
const HANDOFF_TO = new RegExp(String.raw`^It is now (${PLAYER})'s turn\.$`);

function rollCommentary(player: string, first: number, second: number): string {
	const rolled = pickLine(gameRoomsCopy.monopoly.refereeRolled)(player, first, second);
	return first === second ? `${rolled} ${pickLine(gameRoomsCopy.monopoly.refereeDoubles)(player)}` : rolled;
}

// "It is now B's turn." names who comes next; with who held the dice before (the seat before
// the new active one), Dero says the whole handoff. A first turn or an unknown seat keeps the
// engine's line.
function handoffCommentary(line: string, previousPlayer: string | null): string {
	const next = HANDOFF_TO.exec(line)?.[1];
	if (!next || !previousPlayer || previousPlayer === next) return line;
	return pickLine(gameRoomsCopy.monopoly.refereeHandoff)(previousPlayer, next);
}

function spokenForm(line: string, previousPlayer: string | null): string | null {
	if (isTurnHandoffLine(line)) return handoffCommentary(line, previousPlayer);
	const roll = ROLLED.exec(line);
	if (roll) return rollCommentary(roll[1], Number(roll[2]), Number(roll[3]));
	const landed = LANDED.exec(line);
	if (landed) return pickLine(gameRoomsCopy.monopoly.refereeLanded)(landed[1], landed[2]);
	if (CARD_DRAWN.test(line)) return withoutCardFlavor(line);
	const rent = RENT_PAID.exec(line);
	if (rent) return Number(rent[1]) >= BOT_CONSTANTS.MONOPOLY_REFEREE_BIG_RENT ? line : null;
	if (SPOKEN_AS_WRITTEN.some((pattern) => pattern.test(line))) return line.replace(LEADING_EMOJI, "");
	return null;
}

/**
 * ① The trail lines Dero says, in trail order: the allowlist, the card cut, the rent bar and the
 * commentary applied. `previousPlayer` is the mention of the seat that held the dice before a
 * handoff in these lines, when the caller knows it.
 */
export function pickRefereeLines(lines: readonly string[], previousPlayer: string | null = null): SpokenRefereeLine[] {
	const spoken: SpokenRefereeLine[] = [];
	for (const line of lines) {
		const text = spokenForm(line, previousPlayer);
		if (text !== null) spoken.push({ text, handoff: isTurnHandoffLine(line) });
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

/** A clip with every mention replaced by that member's display name. */
export function withNames(clip: string, names: ReadonlyMap<string, string>): string {
	return clip.replace(MENTION, (_mention, userId: string) => names.get(userId) ?? gameRoomsCopy.monopoly.refereeUnknownPlayer);
}

// ── ③ delivery, one chain per room ──
// Memory only: a restart forgets a chain, and the next move starts a fresh one. An
// entry deletes itself once its last clip has gone, so a finished or abandoned match
// leaves nothing behind.
const refereeChains = new Map<string, Promise<void>>();

/**
 * Why the referee could not speak a move (2026-10 item 254, Arcade 7): the guild's voice
 * is switched off, Dero is in no call, no seat still playing is in Dero's call, or the
 * month's speech budget is spent. A failed render is none of these and says nothing.
 */
export type RefereeSilence = "voiceOff" | "noCall" | "noPlayerInCall" | "budgetSpent";

// ④ Re-checked at delivery, not at announce, because a clip waits behind the ones
// before it and the call can change in between. The call announcer checks the call
// again, plus the voice config and the spend cap, for every clip. Every check that
// stops a move's clips names its reason to `onSilent`; the referee never joins a call
// to fix one (the owner's decision 16), it only says why.
async function deliver(
	client: Client,
	guildId: string,
	seatIds: readonly string[],
	clips: readonly string[],
	deps: CallAnnouncerDeps,
	onSilent: (reason: RefereeSilence) => void
): Promise<void> {
	const call = deps.sessionIn(guildId);
	if (!call) {
		// Voice off is the cause worth naming first: switching it on is the first fix.
		onSilent((await isVoiceEnabled(guildId, deps)) ? "noCall" : "voiceOff");
		return;
	}
	const guild = client.guilds.cache.get(guildId);
	if (!guild) return;
	// Never call a match into a call nobody from the match is in.
	const seatInCall = seatIds.some((userId) => guild.voiceStates.cache.get(userId)?.channelId === call.channelId);
	if (!seatInCall) {
		onSilent("noPlayerInCall");
		return;
	}

	const names = await displayNamesIn(guild, mentionedIds(clips));
	for (const clip of clips) {
		const outcome = await speakInCall(guildId, withNames(clip, names), deps);
		if (outcome === "spoken" || outcome === "failed") continue;
		onSilent(SILENCE_OF[outcome]);
		return;
	}
}

// The announcer's refusals that are a referee silence. A call that ended between two
// clips reads as no call, since that is what the room now has.
const SILENCE_OF: Record<Exclude<CallAnnouncement, "spoken" | "failed">, RefereeSilence> = {
	noCall: "noCall",
	voiceOff: "voiceOff",
	budgetSpent: "budgetSpent",
};

export interface AnnounceRefereeInput {
	client: Client;
	room: IGameRoom;
	/** The match AFTER the move, whose seats still playing decide who must be in the call. */
	state: MonopolyState;
	/** The move's trail lines, exactly as posted. */
	lines: readonly string[];
	/** Told why, when a move's clips could not be spoken; roomMonopolyRefereeNotice posts the one notice. */
	onSilent?: (reason: RefereeSilence) => void;
}

/**
 * Speak one move's key moments, if the room has Dero as its referee. Fire and
 * forget: it never throws and never delays the caller, and a room without the
 * referee costs one field read.
 */
export function announceReferee({ client, room, state, lines, onSilent = () => undefined }: AnnounceRefereeInput, deps: CallAnnouncerDeps = defaultCallAnnouncerDeps): void {
	if (!refereeOn(room)) return;
	try {
		const clips = groupIntoClips(pickRefereeLines(lines, previousSeatMention(state)));
		if (clips.length === 0) return;
		const seatIds = state.seats.filter((seat) => !seat.bankrupt).map((seat) => seat.userId);
		const roomId = room.roomId;

		const previous = refereeChains.get(roomId) ?? Promise.resolve();
		const next = previous
			.then(() => deliver(client, room.guildId, seatIds, clips, deps, onSilent))
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

// The seat still playing just before the active one in turn order: who handed the dice over
// when a move ends in a handoff. A mention, so withNames speaks it like every other name.
function previousSeatMention(state: MonopolyState): string | null {
	const seats = state.seats;
	for (let step = 1; step < seats.length; step++) {
		const seat = seats[(state.activeSeatIndex - step + seats.length) % seats.length];
		if (seat && !seat.bankrupt) return `<@${seat.userId}>`;
	}
	return null;
}

/**
 * Whether the referee still has clips waiting or playing for this room. The bot driver waits on
 * it, so a Dero bot never rolls over the commentary of the move before.
 */
export function isRefereeSpeaking(roomId: string): boolean {
	return refereeChains.has(roomId);
}

/** Test seam: resolves once every clip queued for the room so far has been delivered. */
export function _refereeSettled(roomId: string): Promise<void> {
	return refereeChains.get(roomId) ?? Promise.resolve();
}
