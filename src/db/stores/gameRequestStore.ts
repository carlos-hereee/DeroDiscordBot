import { GameRequest, type IGameRequest } from "@db/models/GameRequest.js";

// ── gameRequestStore ──
// What:  the thin Mongoose wrapper over GameRequest, the arcade's game request ballot.
// Who:   features/game-rooms/gameRequests.ts only.
// Where: every query carries guildId (invariant 2), so a nameKey replayed from another
//        server's ballot reaches nothing. Ranking, validation, the toggle and who may
//        remove live in the feature; this store never knows a vote cap or an admin
//        exists. House store rules apply: no business logic, no tests (rule 6).

export const gameRequestStore = {
	async listByGuild(guildId: string): Promise<IGameRequest[]> {
		return GameRequest.find({ guildId }).lean<IGameRequest[]>();
	},

	async countByGuild(guildId: string): Promise<number> {
		return GameRequest.countDocuments({ guildId });
	},

	async findByKey(guildId: string, nameKey: string): Promise<IGameRequest | null> {
		return GameRequest.findOne({ guildId, nameKey }).lean<IGameRequest>();
	},

	// Throws 11000 when the key is already taken; the caller turns that into the
	// duplicate refusal, because a race past its own read lands here.
	async create(row: Pick<IGameRequest, "guildId" | "nameKey" | "name" | "addedBy" | "voterIds">): Promise<IGameRequest> {
		const doc = await GameRequest.create(row);
		return doc.toObject();
	},

	// $addToSet and $pull are each one atomic server side write, so two presses by one
	// member in the same tick still leave at most one vote. Both return the row AFTER
	// the write, or null when the request no longer exists.
	async addVoter(guildId: string, nameKey: string, userId: string): Promise<IGameRequest | null> {
		return GameRequest.findOneAndUpdate({ guildId, nameKey }, { $addToSet: { voterIds: userId } }, { new: true }).lean<IGameRequest>();
	},

	async removeVoter(guildId: string, nameKey: string, userId: string): Promise<IGameRequest | null> {
		return GameRequest.findOneAndUpdate({ guildId, nameKey }, { $pull: { voterIds: userId } }, { new: true }).lean<IGameRequest>();
	},

	async deleteByKey(guildId: string, nameKey: string): Promise<IGameRequest | null> {
		return GameRequest.findOneAndDelete({ guildId, nameKey }).lean<IGameRequest>();
	},

	// Self destruct's server data delete (post-launch plan item 10): every row this guild owns.
	async deleteGuild(guildId: string) {
		return GameRequest.deleteMany({ guildId });
	},
};
