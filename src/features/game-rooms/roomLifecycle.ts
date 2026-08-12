import { type AttachmentBuilder, type Client, type TextChannel } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { gameRoomArchivedEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { buildRoomOverwrites } from "./roomPermissions.js";
import { roomResultEmbed, roomArchiveRow } from "./gameRoomsEmbeds.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomLifecycle ────────────────────────────────────────────────────
// What:  the two terminal transitions of a room. `finish` ends the match, locks the
//        channel and starts the archive clock; `archiveNow` and `archiveRoom` delete
//        the channel and close the row.
// Who:   finish is called by whatever ended the match (a game's win condition, the
//        forfeit control, the boot recovery sweep). archiveNow is the button;
//        archiveRoom is what the cron sweep calls.
// When:  once per room each, at most.
// Where: `archiveAt` is stamped HERE and nowhere else. That single-writer property is
//        exactly what makes the sweep safe: a room that is still playing has a null
//        archiveAt, so no filter bug in the sweep can reach a live match (risk R3).
// How:   persist before locking, and share one delete path between the button and the
//        cron. Both choices are explained where they happen.

async function resolveRoomChannel(client: Client, channelId: string | null): Promise<TextChannel | null> {
	if (!channelId) return null;
	const channel = await client.channels.fetch(channelId).catch(() => null);
	if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
	return channel as TextChannel;
}

export interface FinishRoomInput {
	winnerId?: string | null;
	// The payoff image, resolved by the GAME because only it knows which frame the
	// ending earned (a full gallows, a coin, the winning throw). Optional: an
	// abandoned room and a forfeit have no art to show, and resolveGameAsset already
	// degrades to the Dero avatar when a file is not on disk yet, so a caller never
	// has to check whether the art exists.
	art?: { attachment: AttachmentBuilder; ref: string };
	// True when nobody chose this ending: the channel was deleted underneath a live
	// room, or a boot found a room whose channel no longer exists. It changes only the
	// wording, so a reaped room does not read as though somebody lost.
	abandoned?: boolean;
	now?: Date;
}

// End a match: stamp the row, lock the channel, post the result card.
export async function finish(client: Client, room: IGameRoom, input: FinishRoomInput = {}): Promise<void> {
	const now = input.now ?? new Date();
	const winnerId = input.winnerId ?? null;

	// ① PERSIST FIRST, LOCK SECOND, and the order is load bearing in one direction only.
	// If the process dies between the two, this order leaves a row that is "finished"
	// with a real archiveAt and a channel that is still writable: untidy for a few
	// hours, and the sweep still cleans it up on schedule. The opposite order would
	// leave a LOCKED channel attached to a row still marked "playing", which the sweep
	// (finished-only, by design) would never touch and no recovery path would find,
	// so the room would sit locked and silent forever.
	await gameRoomStore.finish(room.guildId, room.roomId, {
		winnerId,
		endedAt: now,
		archiveAt: new Date(now.getTime() + BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS),
	});

	// ①ᵇ The room-rate top up, paid here rather than after the channel resolves below.
	// XP is a database fact and the channel is a Discord fact: a match whose channel an
	// admin deleted in the final seconds still happened, and the early return under
	// `if (!channel)` would otherwise silently unpay everyone who played it.
	payRoomRateTopUp(client, room, winnerId, input.abandoned ?? false);

	const channel = await resolveRoomChannel(client, room.channelId);
	// An already-deleted channel is the ordinary abandonment case, not an error. The
	// row is stamped, so the sweep will close it out on its next pass.
	if (!channel) return;

	// ② Lock it. `set` REPLACES the whole overwrite array rather than merging, which is
	// what guarantees no stale SendMessages allow survives from the playing phase; a
	// per-entry edit would leave whichever entries this code forgot to mention.
	const config = await guildConfigStore.findByGuildId(room.guildId).catch(() => null);
	await channel.permissionOverwrites
		.set(
			buildRoomOverwrites({
				everyoneRoleId: channel.guild.roles.everyone.id,
				botId: client.user!.id,
				hostId: room.hostId,
				playerIds: room.playerIds,
				spectatorIds: room.spectatorIds,
				visibility: room.visibility,
				phase: "finished",
				adminRoleId: (config as { adminRoleId?: string | null } | null)?.adminRoleId ?? null,
			})
		)
		.catch((error) => console.error("[game-rooms] failed to lock finished room", { roomId: room.roomId, error }));

	// ③ The result card, carrying Archive now. Posted after the lock so the last message
	// in the channel is the outcome rather than a move, and it lands at all only because
	// the bot keeps its own SendMessages allow in the locked overwrite set.
	// The attachment and the embed's reference to it MUST ride the same message, or
	// the image slot renders empty.
	await channel
		.send({
			embeds: [roomResultEmbed(winnerId, input.abandoned ?? false, input.art?.ref)],
			components: [roomArchiveRow(room.roomId)],
			...(input.art ? { files: [input.art.attachment] } : {}),
		})
		.catch((error) => console.error("[game-rooms] failed to post result card", { roomId: room.roomId, error }));
}

// ── the room-rate top up ──────────────────────────────────────────────
// What:  pays the DIFFERENCE between the room rate and the ordinary channel rate, so a
//        match played in its own room lands on GAME_ROOM_PLAY_XP / GAME_ROOM_WIN_XP in
//        total rather than on top of them.
// Who:   everyone in `room.playerIds`. Spectators earn nothing: watching is not playing,
//        which is the same line the dashboard's userId filter draws.
// When:  once per room, from `finish`, after the row is stamped.
// Where: the fifth and last of the leveling award hooks (duel, rps, hangman and fortune
//        shipped in leveling Phase 2; this one waited on `finish` existing at all).
// How:   a top up, NOT an additive bonus, and that is the whole subtlety. Every room game
//        already pays its own award through `gameXp` before it calls `finish`, so a flat
//        40/120 here would total 65/195 and make the constants' face values describe
//        nothing observable. Subtracting means an operator who retunes GAME_ROOM_* gets
//        the number they typed. Floored at zero so raising GAME_PLAY_XP above the room
//        rate degrades to "no bonus" rather than to a negative award.
//
// ⚠️ IT MUST NOT PASS `game`. awardXp increments `games.<slug>.played` for ANY call that
// names one, and the game's own hook has already recorded this match. Naming it here
// would make /account read "played 2" for every room match ever played. Same rule that
// governs battleship's per-sink bonus and hold em's per-hand payout.
//
// ⚠️ HOLD EM IS EXCLUDED. Its placement prize is already calibrated to include the room
// win (see HOLDEM_PLACEMENT_XP's note: a tournament is worth "roughly a room win plus the
// hands it took to get there"), so topping it up pays that win twice.
//
// ABANDONED PAYS NOTHING, and it is the reason this function takes the flag at all.
// `finish` is also called with abandoned:true by the boot recovery sweep and by the R14
// path in ChannelDeleteWatcher, neither of which involves a match anyone played. Paying
// there would be farmable for as long as anyone cared to do it: open a room, delete the
// channel, repeat. The cost of this choice is real and accepted, a genuine disconnect or
// an admin tidying channels pays its players nothing.
function payRoomRateTopUp(client: Client, room: IGameRoom, winnerId: string | null, abandoned: boolean): void {
	if (abandoned) return;
	if (room.game === "holdem") return;
	if (!room.guildId || room.playerIds.length === 0) return;

	const { GAME_PLAY_XP, GAME_WIN_XP, GAME_ROOM_PLAY_XP, GAME_ROOM_WIN_XP } = BOT_CONSTANTS.LEVELING;
	const playTopUp = Math.max(0, GAME_ROOM_PLAY_XP - GAME_PLAY_XP);
	const winTopUp = Math.max(0, GAME_ROOM_WIN_XP - GAME_WIN_XP);
	if (playTopUp === 0 && winTopUp === 0) return;

	// Fire and forget after a successful primary write (house rule 7). awardXp never throws
	// by contract, and `finish` must not be held up by, or fail on, bookkeeping.
	void (async () => {
		const guild = await client.guilds.fetch(room.guildId).catch(() => null);
		if (!guild) return;

		// One bulk fetch to populate the cache. The RESULT is deliberately ignored and every
		// read below goes through the cache instead, because discord.js returns a bare
		// GuildMember for a single-id fetch and a Collection for a multi-id one, and branching
		// on that shape is a bug waiting for the first one-player room.
		await guild.members.fetch({ user: room.playerIds }).catch(() => null);

		for (const userId of room.playerIds) {
			const member = guild.members.cache.get(userId);
			// ⚠️ SKIP rather than fall back to the raw id. memberLevelStore does
			// `$set: { username }` on EVERY award, so handing it a snowflake would overwrite a
			// real display name on /account and /levels with a string of digits. Losing one
			// top up for a member who left mid-match is far cheaper than corrupting the name
			// on both leaderboards, and their own game hook already paid them.
			if (!member) continue;

			void awardXp({
				client,
				guildId: room.guildId,
				userId,
				username: member.displayName,
				amount: playTopUp + (userId === winnerId ? winTopUp : 0),
				source: "gameRoom",
				// No `game` and therefore no `outcome`: awardXp only reads outcome when a game
				// is named, so passing one would be dead weight that reads as a recorded result.
				channelId: room.channelId,
			});
		}
	})().catch((error) => console.error("[game-rooms] room-rate top up failed", { roomId: room.roomId, error }));
}

// ── the one delete path ───────────────────────────────────────────────
// Shared by the Archive now button and the cron sweep on purpose: two delete paths
// would be two places to forget the botLog, two places to get the 404 handling wrong,
// and two definitions of what "archived" means.
export async function archiveRoom(client: Client, room: Pick<IGameRoom, "guildId" | "roomId" | "channelId">): Promise<void> {
	const channel = await resolveRoomChannel(client, room.channelId);

	// A channel an admin already deleted reaches this exactly the way a swept one does.
	// It is a SUCCESS: the desired end state (no channel, row archived) is already half
	// true, and treating it as an error would leave the row un-archived forever and the
	// sweep retrying it every five minutes until the end of time.
	if (channel) {
		await channel.delete("game room archived").catch((error) => {
			console.error("[game-rooms] room channel delete failed", { roomId: room.roomId, error });
		});
	}

	await gameRoomStore.markArchived(room.guildId, room.roomId);

	botLogStore
		.log(room.guildId, gameRoomArchivedEvent(room.roomId), { channelId: room.channelId })
		.catch((error) => console.error("[game-rooms] botLog for room archive failed", error));
}

export type ArchiveNowResult = { ok: true } | { ok: false; reason: "notYours" };

// The Archive now button's behavior, gate included.
//
// The gate lives HERE rather than only in the handler because this is the function
// that performs the destructive act, and a second caller added later (a slash command,
// an API route) would otherwise have to remember to re-implement it.
export async function archiveNow(
	client: Client,
	room: IGameRoom,
	actorId: string,
	isAdmin: boolean
): Promise<ArchiveNowResult> {
	// An admin override is deliberate: clearing someone else's abandoned room is
	// moderation, and an admin is not one of the room's players.
	if (actorId !== room.hostId && !isAdmin) return { ok: false, reason: "notYours" };

	await archiveRoom(client, room);
	return { ok: true };
}

export const roomLifecycle = { finish, archiveNow, archiveRoom };
