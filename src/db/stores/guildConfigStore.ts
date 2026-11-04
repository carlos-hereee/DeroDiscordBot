import GuildConfigModel from "@db/models/GuildConfig.js";

export const guildConfigStore = {
	async findByGuildId(guildId: string) {
		return GuildConfigModel.findOne({ guildId });
	},

	async create(data: object) {
		return GuildConfigModel.create(data);
	},

	async update(guildId: string, data: object) {
		return GuildConfigModel.findOneAndUpdate({ guildId }, { $set: data }, { new: true });
	},

	// A conditional write that lands only while `field` is still null, so of two callers
	// racing to fill one slot the first wins and the second gets null back (2026-11 item
	// 285 Phase 3, features/setup/onDemandChannel.ts). `extra` rides the same write.
	async claimEmptySlot(guildId: string, field: string, value: string, extra: object = {}) {
		return GuildConfigModel.findOneAndUpdate({ guildId, [field]: null }, { $set: { ...extra, [field]: value } }, { new: true });
	},

	// Take one value out of each named array field, in one atomic write.
	async pullFromLists(guildId: string, lists: string[], value: string) {
		const pull = Object.fromEntries(lists.map((list) => [list, value]));
		return GuildConfigModel.findOneAndUpdate({ guildId }, { $pull: pull }, { new: true });
	},

	// Put one value into one named array field, once, in one atomic write, so two presses
	// of one button list it a single time (2026-11 item 289).
	async addToList(guildId: string, list: string, value: string) {
		return GuildConfigModel.findOneAndUpdate({ guildId }, { $addToSet: { [list]: value } }, { new: true });
	},

	// ── network tables (2026-10 item 244 Phase 5b) ──
	// Every config the network board has business with: the servers on the network,
	// and any server that still holds a board message from before it left, so the
	// board refresh can take that message down. No index serves it, deliberately: the
	// collection holds one row per server, and the board reads it once per debounced
	// refresh, never per interaction.
	async findNetworkBoardConfigs() {
		return GuildConfigModel.find({ $or: [{ challengeReach: "network" }, { networkBoardMessageId: { $ne: null } }] });
	},

	// One server added to or taken off this server's network block list, in one atomic
	// write each, so two admins blocking at once both land. Null when the guild has no config.
	async addBlockedNetworkGuild(guildId: string, blockedGuildId: string) {
		return GuildConfigModel.findOneAndUpdate({ guildId }, { $addToSet: { blockedNetworkGuildIds: blockedGuildId } }, { new: true });
	},

	async removeBlockedNetworkGuild(guildId: string, blockedGuildId: string) {
		return GuildConfigModel.findOneAndUpdate({ guildId }, { $pull: { blockedNetworkGuildIds: blockedGuildId } }, { new: true });
	},

	// The owner's Verse view: how many servers finished setup, and how many of those chose
	// the network as their challenge reach. Counts only, never the rows.
	async countSetUp(): Promise<number> {
		return GuildConfigModel.countDocuments({ setupComplete: true });
	},

	async countSetUpOnNetwork(): Promise<number> {
		return GuildConfigModel.countDocuments({ setupComplete: true, challengeReach: "network" });
	},

	async isSetupComplete(guildId: string): Promise<boolean> {
		const config = await GuildConfigModel.findOne({ guildId });
		return config?.setupComplete ?? false;
	},

	// Delete this bot's GuildConfig for a guild. Used by the homebase stale
	// recovery path in ScheduleBoard when we detect the stored channels or
	// schedule message were authored by a different bot (rotated token, data
	// seeded from a sibling environment, or an earlier shared-DB era). After
	// this deletion GuildSetupManager.autoSetup can build a fresh homebase.
	async deleteByGuildId(guildId: string) {
		return GuildConfigModel.deleteOne({ guildId });
	},

	// Self destruct's config reset (Delete my data, 2026-10 item 254). The caller names
	// every field and its default; this only writes them.
	async resetSettings(guildId: string, defaults: object) {
		return GuildConfigModel.findOneAndUpdate({ guildId }, { $set: defaults }, { new: true });
	},
};
