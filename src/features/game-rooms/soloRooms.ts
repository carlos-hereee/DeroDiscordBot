import { ChannelType, type CategoryChannel, type Guild, type TextChannel, type User } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { startBlackjackTable } from "@features/games/blackjackHandler.js";
import type { HangmanCategory } from "@features/games/hangmanWords.js";
import type { SoloLuckGame, SoloLuckPlay } from "@features/games/soloLuck.js";
import { RoomProvisioner, checkRoomAdmission, describeRoomOpenFailure, type RoomOpenResult } from "./RoomProvisioner.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { SoloLuckSlug } from "./roomTypes.js";
import { playSoloLuckRoom } from "./soloLuckRoom.js";

// ── soloRooms ────────────────────────────────────────────────────────
// What:  the one-player path into a room: "Host Hangman", "Play Blackjack" and the
//        hangman category start on the 🕹️games intro, and a round against Dero (Play
//        Dero instead, or a /mini-game against Dero typed in ⚔️challenges, 2026-10 item
//        254, Arcade 1). A coin flip or a dice roll plays and finishes the moment its
//        room opens; rock paper scissors opens first and asks for the throw in the room
//        through the turn prompt (soloLuckRoom, 2026-10 item 257 Phase 4b). A rematch of
//        a finished solo room does not come through here (it plays on in the same
//        channel), but it deals its blackjack table through startSoloBlackjackBoard
//        below. That dealing is shared with a multi seat blackjack room
//        (startBlackjackRoomBoard), so a table is dealt one way wherever it plays.
// Who:   arcadeHost (the buttons), challengeBoard (Play Dero instead, a blackjack
//        challenge's start and every rematch's table), and miniGameInChallenges.
// When:  once per press, same cadence as the challenge board's start.
// Where: routes through RoomProvisioner like every other room, ON PURPOSE. The old
//        inline forms never touched the provisioner, so they held no room slot, dodged
//        the guild cap, and would have dodged the private tier quota the day it
//        shipped. A solo room is visibility "solo" (a variant of "invite"), so it
//        counts as PRIVATE everywhere private is counted.
// How:   resolve the arcade category from GuildConfig exactly the way
//        provisionFromDraft does, open the room, then hand solo-blackjack its board or
//        play the coin or the dice. A solo-rps room's prompt is posted by seedRoom, so a
//        rematch in the same channel posts it the same way.

export type SoloGameSlug = "solo-hangman" | "solo-blackjack" | SoloLuckSlug;

// The solo room each luck game's round against Dero plays in.
const SOLO_LUCK_SLUGS: Record<SoloLuckGame, SoloLuckSlug> = {
	coinflip: "solo-coinflip",
	diceroll: "solo-diceroll",
	rps: "solo-rps",
};

/** The solo room slug a round against Dero opens. */
export const soloLuckSlugFor = (game: SoloLuckGame): SoloLuckSlug => SOLO_LUCK_SLUGS[game];

// The rounds that play the moment their room opens, by slug: neither asks the member
// anything, so the slug is the whole play. Rock paper scissors is absent on purpose, since
// its throw is the member's to make in the room.
const PLAYED_AT_OPEN: Partial<Record<SoloLuckSlug, SoloLuckPlay>> = {
	"solo-coinflip": { game: "coinflip" },
	"solo-diceroll": { game: "diceroll" },
};

export interface SoloHost {
	userId: string;
	displayName: string;
	// The member themselves, which only a round against Dero needs: its pay goes through
	// gameXp, which records the member's name off the user. Absent for every other form.
	user?: User;
}

export type SoloOpenResult = RoomOpenResult | { ok: false; reason: "noArcadeCategory" };

export interface SoloOpenOptions {
	// The shelf a solo hangman word is drawn from, set by the 🕹️games category start
	// (2026-10 item 245 Phase 4a). Absent draws from the whole bank, as Host Hangman
	// always has. Ignored for solo blackjack.
	hangmanCategory?: HangmanCategory;
}

export async function openSoloRoom(guild: Guild, game: SoloGameSlug, host: SoloHost, options: SoloOpenOptions = {}): Promise<SoloOpenResult> {
	const stored = await guildConfigStore.findByGuildId(guild.id);
	const config = stored as unknown as { gamesCategoryId?: string | null; adminRoleId?: string | null } | null;

	const categoryId = config?.gamesCategoryId;
	const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
	if (!category || category.type !== ChannelType.GuildCategory) {
		return { ok: false, reason: "noArcadeCategory" };
	}

	const result = await RoomProvisioner.open({
		guild,
		category: category as CategoryChannel,
		game,
		hostId: host.userId,
		hostDisplayName: host.displayName,
		playerIds: [host.userId],
		spectatorIds: [],
		visibility: "solo",
		adminRoleId: config?.adminRoleId ?? null,
		hangmanCategory: options.hangmanCategory,
	});
	if (!result.ok) return result;

	if (game === "solo-blackjack" && !(await startSoloBlackjackBoard(guild, result.room, result.channel, host))) {
		return { ok: false, reason: "createFailed" };
	}
	// A coin flip or a dice roll is played the moment the room opens and the room finishes
	// straight after, so the member reads one result in a room already locked, with Archive
	// now on its result card. The pay is the round's own, through soloLuck (the daily cap
	// included), and finish adds no room rate on top (roomLifecycle.payRoomRateTopUp).
	const playedAtOpen = PLAYED_AT_OPEN[game as SoloLuckSlug];
	if (playedAtOpen) await playSoloLuckRoom(guild.client, result.room, result.channel, host, playedAtOpen);

	return result;
}

/**
 * Deal a solo blackjack room's table into its channel. Returns false, with the room
 * already closed, when the table could not start.
 *
 * Solo blackjack rides its own edited board message, posted into the room. The roomId
 * rides the in-memory game so the settle path can close the room through
 * roomLifecycle.finish. Shared by a fresh solo room and a rematch in the same channel,
 * so both deal the same table the same way.
 */
export async function startSoloBlackjackBoard(guild: Guild, room: IGameRoom, channel: TextChannel, host: SoloHost): Promise<boolean> {
	return dealRoomTable(guild, room, channel, { userId: host.userId, username: host.displayName }, []);
}

/**
 * Deal a multi seat blackjack room's table (2026-10 item 254, Arcade 1): every player the
 * challenge card gathered takes a seat, the host first, and the hand is dealt at once,
 * since the seating already happened on the card. Returns false, with the room already
 * closed, when the table could not start. A rematch deals through here too.
 */
export async function startBlackjackRoomBoard(guild: Guild, room: IGameRoom, channel: TextChannel): Promise<boolean> {
	const seatOf = (userId: string) => ({ userId, username: guild.members.cache.get(userId)?.displayName ?? userId });
	const others = room.playerIds.filter((userId) => userId !== room.hostId).map(seatOf);
	return dealRoomTable(guild, room, channel, seatOf(room.hostId), others);
}

async function dealRoomTable(
	guild: Guild,
	room: IGameRoom,
	channel: TextChannel,
	host: { userId: string; username: string },
	others: Array<{ userId: string; username: string }>
): Promise<boolean> {
	const started = await startBlackjackTable(channel, guild.id, host, true, room.roomId, others);
	if (started === "started") return true;

	// The room exists and its board does not, so the host would hold their one room
	// slot on a channel with nothing to play. Close it out rather than stranding them;
	// abandoned, because no hand was ever dealt.
	await roomLifecycle.finish(guild.client, room, { abandoned: true });
	return false;
}

/** Why a solo room would not open. */
export type SoloOpenFailure = Exclude<SoloOpenResult, { ok: true }>;

/**
 * The solo refusals a press can read inside Discord's three seconds, so it can answer them as a
 * notice while a modal can still open (owner rule 1 of the Round 3 list, 2026-10 item 263): no
 * arcade category, a full server, the private ceiling. Null when the press may go on.
 * openSoloRoom checks all of it again after the acknowledgement, where a refusal met only then is
 * a race. A held slot is left to that path and to offerToFreeSlot, which answer it with its link,
 * and a category missing from the cache is left to it too, since only a fetch can say it is gone.
 * A read that throws here also leaves the decision to it, so this never throws.
 */
export async function readSoloRefusalAtPress(guild: Guild, hostId: string): Promise<SoloOpenFailure | null> {
	try {
		const [stored, admission] = await Promise.all([guildConfigStore.findByGuildId(guild.id), checkRoomAdmission({ guild, hostId, visibility: "solo" })]);
		const categoryId = (stored as unknown as { gamesCategoryId?: string | null } | null)?.gamesCategoryId;
		const category = categoryId ? guild.channels.cache.get(categoryId) : undefined;
		if (!categoryId || (category && category.type !== ChannelType.GuildCategory)) return { ok: false, reason: "noArcadeCategory" };
		if (admission && admission.reason !== "alreadyHosting") return admission;
		return null;
	} catch (error) {
		console.warn(`[solo-rooms] the press check failed for guild ${guild.id}; the open decides instead`, error);
		return null;
	}
}

// The solo counterpart of describeRoomOpenFailure, covering the one extra reason this
// path can fail that the provisioner cannot know about.
export function describeSoloOpenFailure(result: SoloOpenFailure): string {
	if (result.reason === "noArcadeCategory") return gameRoomsCopy.errors.noArcadeCategory;
	return describeRoomOpenFailure(result);
}

// The "6/10 private rooms on the Starter plan" status line, or null while the tier
// surface is not enforcing (infinite quota) or the member is blocked outright. Shared
// by the visibility chooser and the solo entry points so the count, the ceiling and
// the plan name always come from the same cached decision.
export async function readPrivateQuotaStatus(guildId: string, userId: string): Promise<string | null> {
	const decision = await checkGameRoomAccess(guildId, userId);
	if (!decision.allowed || !Number.isFinite(decision.privateQuota)) return null;
	const open = await gameRoomStore.countOpenInGuildByVisibility(guildId, ["invite", "solo"]);
	return gameRoomsCopy.board.privateQuotaStatus(
		open,
		decision.privateQuota,
		gameRoomsCopy.tierName(decision.tierKey ?? "unsubscribed")
	);
}
