import { type AttachmentBuilder, type Client, type TextChannel } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { gameRoomArchivedEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { buildRoomOverwrites, type RoomPhase } from "./roomPermissions.js";
import { roomResultEmbed, roomArchiveRow } from "./gameRoomsEmbeds.js";
import { deleteSatellites, labelEmbedForRoom, lockSatellites } from "./satelliteRooms.js";
import { scheduleNetworkBoardRefresh } from "./networkBoard.js";
import { challengeResultLine, closeChallengeCard } from "./challengeCard.js";
import type { OutcomeBucket } from "./matchOutcome.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomLifecycle ────────────────────────────────────────────────────
// What:  the terminal transitions of a room. `finish` ends the match, locks the
//        channel and starts the archive clock; `releaseChannel` hands a finished room's
//        channel to the rematch that plays on in it; `archiveNow` and `archiveRoom`
//        delete the channel and close the row. A network table's satellites in other
//        servers follow the host room through finish and archiveRoom, always after it
//        and never able to stop it (satelliteRooms, 2026-10 item 244 Phase 5a).
// Who:   finish is called by whatever ended the match (a game's win condition, the
//        forfeit control, the boot recovery sweep). releaseChannel is called by the
//        Rematch button (challengeBoard.rematchFromRoom). archiveNow is the button;
//        archiveRoom is what the cron sweep calls.
// When:  once per room each, at most.
// Where: `archiveAt` is written HERE and nowhere else: stamped by finish, and cleared
//        to null by releaseChannel, the only other writer, which never writes a date.
//        That property is exactly what makes the sweep safe: a room that is still
//        playing has a null archiveAt, so no filter bug in the sweep can reach a live
//        match (risk R3).
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
	// How the match was won (post-launch plan item 21), from the game that ended it. It
	// only chooses the flavor line on the closed challenge card.
	outcome?: { bucket: OutcomeBucket; roomWon?: boolean };
	now?: Date;
}

// End a match: stamp the row, lock the channel, post the result card.
//
// Returns TRUE when this call is the one that ended the match and FALSE when the room was
// already finished. Every caller may ignore it; the one that must not is a caller which pays
// something of its own AFTER this returns (runVersusMove's awardTwoPlayerResult), because that
// work is outside the claim below and would otherwise run once per press.
export async function finish(client: Client, room: IGameRoom, input: FinishRoomInput = {}): Promise<boolean> {
	const now = input.now ?? new Date();
	const winnerId = input.winnerId ?? null;

	// ① PERSIST FIRST, LOCK SECOND, and the order is load bearing in one direction only.
	// If the process dies between the two, this order leaves a row that is "finished"
	// with a real archiveAt and a channel that is still writable: untidy for a few
	// hours, and the sweep still cleans it up on schedule. The opposite order would
	// leave a LOCKED channel attached to a row still marked "playing", which the sweep
	// (finished-only, by design) would never touch and no recovery path would find,
	// so the room would sit locked and silent forever.
	//
	// ①ᵃ AND THE PERSIST IS ALSO THE CLAIM. gameRoomStore.finish only matches a room in a
	// non-terminal status, so a null return means somebody else already finished this one and
	// everything below (the payout, the lock, the result card) has already happened for it.
	// Returning here is what makes `finish` safe to call twice, which four paths can do: the
	// Forfeit button stays clickable on a finished room, ChannelDeleteWatcher still matches a
	// finished row for the whole archive window, versus has no claim of its own, and the hold em
	// clock sweeps on a timer. Re-running would pay everyone a second time (payRoomRateTopUp has
	// no idempotency key), and the forfeit replay would let the WINNER set winnerId to the loser.
	const claimed = await gameRoomStore.finish(room.guildId, room.roomId, {
		winnerId,
		endedAt: now,
		archiveAt: new Date(now.getTime() + BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS),
	});
	if (!claimed) return false;

	// ①ᵇ The room-rate top up, paid here rather than after the channel resolves below.
	// XP is a database fact and the channel is a Discord fact: a match whose channel an
	// admin deleted in the final seconds still happened, and the early return under
	// `if (!channel)` would otherwise silently unpay everyone who played it.
	payRoomRateTopUp(client, room, winnerId, input.abandoned ?? false);

	// A network table names its winner rather than mentioning them (satelliteRooms).
	const resultEmbed = await labelEmbedForRoom(client, room, roomResultEmbed(winnerId, input.abandoned ?? false, input.art?.ref));

	const channel = await resolveRoomChannel(client, room.channelId);
	// An already-deleted channel is the ordinary abandonment case, not an error. The
	// row is stamped, so the sweep will close it out on its next pass. TRUE either way:
	// this call DID end the match, and the return value reports the claim rather than
	// whether Discord still had a channel to decorate.
	if (channel) {
		// ② Lock it.
		await applyRoomPhase(client, channel, room, "finished");

		// ③ The result card, carrying Archive now. Posted after the lock so the last message
		// in the channel is the outcome rather than a move, and it lands at all only because
		// the bot keeps its own SendMessages allow in the locked overwrite set.
		// The attachment and the embed's reference to it MUST ride the same message, or
		// the image slot renders empty.
		await channel
			.send({
				embeds: [resultEmbed],
				components: [roomArchiveRow(room.roomId)],
				...(input.art ? { files: [input.art.attachment] } : {}),
			})
			.catch((error) => console.error("[game-rooms] failed to post result card", { roomId: room.roomId, error }));
	}

	// ④ Every satellite of a network table (2026-10 item 244 Phase 5a), AFTER the host
	// room, and even when the host channel is gone, since a satellite in another server is
	// still open to its players. Read off the CLAIMED row rather than the caller's: a
	// satellite opened after the caller read the room is on the row the claim returned.
	// Queued on the room's relay chain behind the last table and move, never awaited, so
	// no satellite can hold up the caller or the ratings it records next.
	const satellites = claimed.satellites ?? [];
	if (satellites.length > 0) {
		void lockSatellites(client, { roomId: room.roomId, satellites }, { embed: resultEmbed, files: input.art ? [input.art.attachment] : [] });
	}
	// ⑤ A finished network table leaves the network board (2026-10 item 244 Phase 5b).
	// Debounced and fire and forget there, so the board never holds up a finish.
	if (claimed.network) scheduleNetworkBoardRefresh();

	// ⑥ The challenge card in ⚔️challenges closes with who won and how (post-launch plan
	// item 21). After everything above and never awaited: it is cosmetic, it may need a
	// picture drawn, and a room that never had a card skips it inside.
	const resultLine = challengeResultLine({
		game: room.game,
		winnerId,
		abandoned: input.abandoned ?? false,
		bucket: input.outcome?.bucket,
		roomWon: input.outcome?.roomWon,
	});
	void closeChallengeCard(client, room, resultLine);

	return true;
}

/**
 * Replace a room channel's whole permission overwrite set with the matrix for one
 * phase: "finished" is finish's lock, "playing" is the unlock a rematch in the same
 * channel needs, because the finished room left its @everyone SendMessages deny behind.
 *
 * `set` REPLACES the whole overwrite array rather than merging, which is what
 * guarantees no stale entry survives from the previous phase; a per-entry edit would
 * leave whichever entries this code forgot to mention. Logs and resolves on failure:
 * both callers run after their row write, and a failed overwrite must not undo it.
 */
export async function applyRoomPhase(
	client: Client,
	channel: TextChannel,
	room: Pick<IGameRoom, "roomId" | "guildId" | "hostId" | "playerIds" | "spectatorIds" | "visibility">,
	phase: RoomPhase
): Promise<void> {
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
				phase,
				adminRoleId: (config as { adminRoleId?: string | null } | null)?.adminRoleId ?? null,
			})
		)
		.catch((error) => console.error(`[game-rooms] failed to set the ${phase} overwrites`, { roomId: room.roomId, error }));
}

// ── the channel handover (a rematch in the same channel) ─────────────
// What:  a FINISHED room stops pointing at its channel and its archive clock is
//        cleared, so the rematch row that now owns the channel is the only row the
//        archive sweep, ChannelDeleteWatcher and the in-room handlers can find there.
//        The finished row keeps its transcript; only the channel moves on.
// Who:   challengeBoard.rematchFromRoom, AFTER it has created the rematch row already
//        pointing at the same channel.
// When:  once per finished room, at most: the store's filter is the claim.
// Where: ⚠️ THE ONLY WRITER OF archiveAt BESIDES finish, AND IT ONLY EVER WRITES NULL.
//        Clearing a clock can never put a live match in the sweep's reach, which is
//        why this second writer keeps the single-writer property's guarantee intact.
// How:   one conditional write on status "finished" and the expected channel id.
//        Returns false when the claim was lost (another rematch took the channel, or the
//        sweep archived the room first); the caller then undoes its own new row.
export async function releaseChannel(room: Pick<IGameRoom, "guildId" | "roomId" | "channelId">): Promise<boolean> {
	if (!room.channelId) return false;
	const released = await gameRoomStore.releaseChannel(room.guildId, room.roomId, room.channelId);
	return released !== null;
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
			// real display name on /account and /account view:levels with a string of digits. Losing one
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
export async function archiveRoom(
	client: Client,
	room: Pick<IGameRoom, "guildId" | "roomId" | "channelId"> & Partial<Pick<IGameRoom, "satellites">>
): Promise<void> {
	// A network table's satellites go with it, and BEFORE the row closes: the sweep only
	// ever finds a "finished" row, so a row archived first would leave its satellites in
	// other servers with nothing that would ever delete them. Each satellite is isolated
	// inside deleteSatellites, so none can stop the host room's own delete below.
	if (room.satellites?.length) await deleteSatellites(client, { roomId: room.roomId, satellites: room.satellites });

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

export const roomLifecycle = { finish, applyRoomPhase, releaseChannel, archiveNow, archiveRoom };
