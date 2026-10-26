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
