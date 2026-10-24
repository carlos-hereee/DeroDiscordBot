// src/db/stores/networkBanStore.ts
import { NetworkBan, type INetworkBan, type NetworkBanKind } from "@db/models/NetworkBan.js";

// ── Network ban store ──
// Every DB touch for NetworkBan. Thin on purpose: the owner's /network command decides
// who is banned, and features/game-rooms decides what a ban refuses. The store bans and
// unbans one id, reads every ban for the network board (a short list, one query per
// board refresh), and checks a handful of ids for a join in one query.

export const networkBanStore = {
	/** Ban one id. True when the ban is new, false when it already stood (its reason is left as it was). */
	async ban(kind: NetworkBanKind, targetId: string, reason: string, createdAt: Date): Promise<boolean> {
		const result = await NetworkBan.updateOne({ kind, targetId }, { $setOnInsert: { reason, createdAt } }, { upsert: true });
		return result.upsertedCount > 0;
	},

	/** Lift one ban. True when there was a ban to lift. */
	async unban(kind: NetworkBanKind, targetId: string): Promise<boolean> {
		const result = await NetworkBan.deleteOne({ kind, targetId });
		return result.deletedCount > 0;
	},

	/** Every ban, for the network board's one read per refresh. */
	async findAll(): Promise<INetworkBan[]> {
		return NetworkBan.find({}).lean<INetworkBan[]>();
	},

	/** The bans standing against any of these members or servers, in one query. */
	async findAgainst(targets: { userIds: readonly string[]; guildIds: readonly string[] }): Promise<INetworkBan[]> {
		return NetworkBan.find({
			$or: [
				{ kind: "user", targetId: { $in: [...targets.userIds] } },
				{ kind: "guild", targetId: { $in: [...targets.guildIds] } },
			],
		}).lean<INetworkBan[]>();
	},
};
