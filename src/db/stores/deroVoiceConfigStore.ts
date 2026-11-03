// src/db/stores/deroVoiceConfigStore.ts
import { DeroVoiceConfig, type IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";

// ── Dero voice config store ──
// Every DB touch for DeroVoiceConfig. Thin on purpose: /dero-config owns the
// idempotency and validation, the Listen handler owns what the fields mean.
// Writes upsert, so the first /dero-config call in a guild creates its row with
// the schema defaults (voice off, Listen on, the default cap).

// The three id allowlists, the only array fields /dero-config edits.
export type DeroVoiceListField = "allowedRoleIds" | "allowedChannelIds" | "allowedVoiceChannelIds";

// The scalar fields /dero-config sets. Never guildId (the key) or the arrays
// (those go through addToList and removeFromList so concurrent edits merge).
// priorityOrder is set whole, never merged: the step's modal always sends every place.
export type DeroVoiceConfigPatch = Partial<Pick<IDeroVoiceConfig, "enabled" | "listenEnabled" | "monthlyCapUsd" | "priorityOrder">>;

export const deroVoiceConfigStore = {
	async findByGuildId(guildId: string): Promise<IDeroVoiceConfig | null> {
		return DeroVoiceConfig.findOne({ guildId }).lean<IDeroVoiceConfig>();
	},

	async upsert(guildId: string, patch: DeroVoiceConfigPatch): Promise<IDeroVoiceConfig | null> {
		return DeroVoiceConfig.findOneAndUpdate({ guildId }, { $set: patch }, { upsert: true, new: true }).lean<IDeroVoiceConfig>();
	},

	async addToList(guildId: string, field: DeroVoiceListField, id: string): Promise<IDeroVoiceConfig | null> {
		return DeroVoiceConfig.findOneAndUpdate({ guildId }, { $addToSet: { [field]: id } }, { upsert: true, new: true }).lean<IDeroVoiceConfig>();
	},

	async removeFromList(guildId: string, field: DeroVoiceListField, id: string): Promise<IDeroVoiceConfig | null> {
		return DeroVoiceConfig.findOneAndUpdate({ guildId }, { $pull: { [field]: id } }, { new: true }).lean<IDeroVoiceConfig>();
	},

	// Self destruct's config reset (post-launch plan item 10): no row is the default, voice off.
	async deleteByGuildId(guildId: string) {
		return DeroVoiceConfig.deleteOne({ guildId });
	},
};
