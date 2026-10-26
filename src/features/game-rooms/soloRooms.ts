import { ChannelType, type CategoryChannel, type Guild, type TextChannel, type User } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { startBlackjackTable } from "@features/games/blackjackHandler.js";
import type { HangmanCategory } from "@features/games/hangmanWords.js";
import { playSoloLuckInChannel, type SoloLuckGame, type SoloLuckPlay } from "@features/games/soloLuck.js";
import { RoomProvisioner, describeRoomOpenFailure, type RoomOpenResult } from "./RoomProvisioner.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { isSoloLuckGame, type SoloLuckSlug } from "./roomTypes.js";

// ── soloRooms ────────────────────────────────────────────────────────
// What:  the one-player path into a room: "Host Hangman", "Play Blackjack" and the
//        hangman category start on the 🕹️games intro, and a round against Dero (Play
//        Dero instead, or a /mini-game against Dero typed in ⚔️challenges, 2026-10 item
//        254, Arcade 1), played and finished in its solo room the moment it opens. A
//        rematch of a finished solo room does not come through here (it plays on in the
//        same channel), but it deals its blackjack table through startSoloBlackjackBoard
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
//        play the luck round.

export type SoloGameSlug = "solo-hangman" | "solo-blackjack" | SoloLuckSlug;

const SOLO_LUCK_ARCHIVE_DELAY_MS = BOT_CONSTANTS.GAME_ROOM_SOLO_LUCK_ARCHIVE_DELAY_MS;

// The solo room each luck game's round against Dero plays in.
const SOLO_LUCK_SLUGS: Record<SoloLuckGame, SoloLuckSlug> = {
	coinflip: "solo-coinflip",
	diceroll: "solo-diceroll",
	rps: "solo-rps",
};

/** The solo room slug a round against Dero opens. */
export const soloLuckSlugFor = (play: SoloLuckPlay): SoloLuckSlug => SOLO_LUCK_SLUGS[play.game];

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
	// The round a solo luck room plays, required for its three slugs and ignored for the
	// others: rps carries the member's throw, which they chose before the room existed.
	luckPlay?: SoloLuckPlay;
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
	if (isSoloLuckGame(game)) await playSoloLuckRoom(guild, result.room, result.channel, host, options.luckPlay);

	return result;
}

// ── a round against Dero in its own room (2026-10 item 254, Arcade 1) ──
// The round is played the moment the room opens and the room finishes straight after,
// so the member reads one result in a room that is already locked, with Archive now on
// its result card. The pay is the round's own, through soloLuck (the daily cap included),
// and finish adds no room rate on top for these slugs (roomLifecycle.payRoomRateTopUp).
// A round that cannot be posted, or arrives with no play, closes the room as abandoned,
// which pays nothing, rather than leaving the member's one room slot held. Either way the
// channel goes on the short solo luck window (GAME_ROOM_SOLO_LUCK_ARCHIVE_DELAY_MS), since
// there is no match to scroll back and a long one would pile channels up in the arcade.
async function playSoloLuckRoom(guild: Guild, room: IGameRoom, channel: TextChannel, host: SoloHost, play: SoloLuckPlay | undefined): Promise<void> {
	const user = host.user ?? (await guild.client.users.fetch(host.userId).catch(() => null));
	const result = play && user ? await playSoloLuckInChannel(channel, { user, displayName: host.displayName }, play) : null;
	if (!result) {
		await roomLifecycle.finish(guild.client, room, { abandoned: true, archiveDelayMs: SOLO_LUCK_ARCHIVE_DELAY_MS });
		return;
	}
	await roomLifecycle.finish(guild.client, room, { winnerId: result.outcome === "won" ? host.userId : null, archiveDelayMs: SOLO_LUCK_ARCHIVE_DELAY_MS });
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

// The solo counterpart of describeRoomOpenFailure, covering the one extra reason this
// path can fail that the provisioner cannot know about.
export function describeSoloOpenFailure(result: Exclude<SoloOpenResult, { ok: true }>): string {
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
