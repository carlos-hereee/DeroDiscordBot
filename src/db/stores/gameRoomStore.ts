import { GameRoom, type IGameRoom } from "@db/models/GameRoom.js";
import {
	NON_TERMINAL_ROOM_STATUSES,
	type GameSlug,
	type RoomMove,
	type RoomStatus,
	type RoomVisibility,
} from "@features/game-rooms/roomTypes.js";

// ── gameRoomStore ──
// What:  the thin Mongoose wrapper over the GameRoom collection. Query shapes only; every
//        decision about WHEN a room may open, finish, or be swept lives in features/game-rooms.
// Who:   RoomProvisioner, roomTrail, roomLifecycle, roomArchiveSweep, the gameroom: button
//        handlers, and later the dashboard's GET /api/game-rooms route.
// When:  on member interaction (open, move, forfeit) and on the 5-minute archive cron.
// Where: guild scoping is a security boundary (invariant 2), so every method except the
//        cross-guild sweep query takes guildId and filters on it. A roomId that belongs to
//        another guild therefore reads as NOT FOUND rather than forbidden, which is what stops
//        a caller probing whether a room exists somewhere else.
// How:   house store rules apply: thin wrappers, no business logic, no tests against Mongo
//        itself (rule 6). The behavioral guarantee that matters most here, one open room per
//        host, is enforced by the schema's partial unique index rather than by anything in
//        this file, which is why create() surfaces a duplicate-key error instead of pre-checking.

interface ICreateGameRoom {
	guildId: string;
	game: GameSlug;
	hostId: string;
	visibility: RoomVisibility;
	// Seeded with the host; the accepted opponent is added when the host confirms.
	playerIds?: string[];
	spectatorIds?: string[];
	boardMessageId?: string | null;
}

export const gameRoomStore = {
	// Insert a new draft room.
	//
	// NOT an upsert, unlike activityStore.upsert: a room is genuinely new every time, and the
	// partial unique index on (guildId, hostId) over the non-terminal statuses is the guard
	// against a second one. That means a host who already holds an open room makes this THROW
	// a Mongo duplicate-key error (code 11000), and RoomProvisioner is expected to catch it and
	// reply with a jump link to the existing room. Do NOT convert this to an upsert to make the
	// error go away: the throw IS the F11 enforcement, and upserting would resurrect a stale
	// draft into a live room.
	async create(input: ICreateGameRoom) {
		return GameRoom.create({
			guildId: input.guildId,
			game: input.game,
			hostId: input.hostId,
			visibility: input.visibility,
			playerIds: input.playerIds ?? [input.hostId],
			spectatorIds: input.spectatorIds ?? [],
			boardMessageId: input.boardMessageId ?? null,
			status: "draft",
		});
	},

	// Primary lookup for every gameroom: button, whose customId carries the roomId.
	async findByRoomId(guildId: string, roomId: string) {
		return GameRoom.findOne({ guildId, roomId });
	},

	// Used by the in-room handlers (which know their channel, not their roomId) and by
	// ChannelDeleteWatcher to recognize that a deleted channel was a live room rather than a
	// managed homebase slot it should rebuild.
	async findByChannelId(guildId: string, channelId: string) {
		return GameRoom.findOne({ guildId, channelId });
	},

	// The friendly half of the one-room-per-host rule: a hit means the host already has a room,
	// so the caller can reply with a jump link instead of letting create() throw. The `$in` list
	// is imported from roomTypes so this query and the partial unique index cannot disagree.
	async findOpenByHost(guildId: string, hostId: string) {
		return GameRoom.findOne({ guildId, hostId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } });
	},

	// Backs the GAME_ROOM_MAX_PER_GUILD check. Counting live rooms rather than channels is
	// deliberate: it stays correct even if an admin deletes a room channel by hand, whereas
	// counting the games category's children would drift.
	async countOpenInGuild(guildId: string): Promise<number> {
		return GameRoom.countDocuments({ guildId, status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } });
	},

	// Append one entry to the transcript.
	//
	// Called ONLY by roomTrail.postMove, and only AFTER its channel.send resolved. A transcript
	// row for a move the players never saw is unrecoverable; a missing row after a successful
	// send is merely a gap. $push is atomic server-side, so two members guessing in the same
	// tick both land without a read-modify-write race.
	async appendMove(guildId: string, roomId: string, move: RoomMove) {
		return GameRoom.findOneAndUpdate({ guildId, roomId }, { $push: { moves: move } }, { new: true });
	},

	// Advance the lifecycle, optionally alongside the ids that become known at the same moment
	// (channelId and openerMessageId when the room goes "playing", for instance). Callers pass
	// only what actually changed; this store decides nothing.
	async setStatus(guildId: string, roomId: string, status: RoomStatus, patch: Partial<IGameRoom> = {}) {
		return GameRoom.findOneAndUpdate({ guildId, roomId }, { $set: { status, ...patch } }, { new: true });
	},

	// Terminal write for a match that ended.
	//
	// archiveAt is computed by roomLifecycle.finish and passed in, never derived here: the store
	// stays thin, and keeping the arithmetic in one feature module is what guarantees archiveAt
	// is stamped by exactly one code path. That single-writer property is what makes the sweep
	// safe, because a room that is still playing has archiveAt null and no filter bug can reach it.
	async finish(
		guildId: string,
		roomId: string,
		outcome: { winnerId: string | null; endedAt: Date; archiveAt: Date }
	) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId },
			{
				$set: {
					status: "finished",
					winnerId: outcome.winnerId,
					endedAt: outcome.endedAt,
					archiveAt: outcome.archiveAt,
				},
			},
			{ new: true }
		);
	},

	// The archive sweep's query. Cross-guild by nature: one cron tick serves every guild, so this
	// is the one method that does not scope to a guildId.
	//
	// The status filter is what protects a live game (risk R3). `archiveAt: { $ne: null }` is
	// redundant against MongoDB's type bracketing, which already keeps a null out of a $lte Date
	// comparison, but it states the invariant in the query itself so a future edit cannot quietly
	// widen this into "every room with a past timestamp".
	async findExpiredArchives(now: Date) {
		return GameRoom.find({ status: "finished", archiveAt: { $ne: null, $lte: now } });
	},

	// Every room that believes it is still live, across every guild.
	//
	// Cross-guild for the same reason findExpiredArchives is: the boot recovery sweep runs
	// once for the whole process, not once per guild. It reads rooms whose status is
	// non-terminal so the caller can ask Discord whether each one's channel still exists;
	// a row that says "playing" is a CLAIM about the world, and a bot that was offline
	// while an admin deleted the channel comes back holding a claim that is no longer true.
	async findNonTerminal() {
		return GameRoom.find({ status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } });
	},

	// Called after the channel is gone, by both the sweep and the Archive now button, which
	// share one delete path. A channel that was already deleted by an admin reaches this the
	// same way a swept one does: it is a success, not an error.
	async markArchived(guildId: string, roomId: string) {
		return GameRoom.findOneAndUpdate(
			{ guildId, roomId },
			{ $set: { status: "archived", channelId: null } },
			{ new: true }
		);
	},

	// The future dashboard's history query: every finished room a member played in, newest first.
	// Matches the { guildId, playerIds, endedAt } index. Spectators are deliberately excluded,
	// watching a match is not playing one.
	async findByUserInGuild(guildId: string, userId: string, limit = 25) {
		return GameRoom.find({ guildId, playerIds: userId, endedAt: { $ne: null } })
			.sort({ endedAt: -1 })
			.limit(limit);
	},
};
