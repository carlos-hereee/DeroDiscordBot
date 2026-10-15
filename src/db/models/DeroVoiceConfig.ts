// src/db/models/DeroVoiceConfig.ts
import mongoose from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── DeroVoiceConfig ──
// What:  one row per guild holding everything Dero's voice needs: the kill
//        switch, the cloned voice id, whether Listen buttons appear, the three
//        allowlists later phases authorize against, and the monthly spend cap.
// Who:   written by /dero-config. Read by the Listen button and handler, and by
//        the spend meter for the cap.
// When:  a guild that never ran /dero-config has no row, which every reader
//        treats as "voice off".
// Where: deliberately NOT a GuildConfig field group. GuildConfig is the core
//        setup record (channels, roles), and the owner chose a separate model so
//        the voice feature can be dropped or reshaped without touching it.
//
// ⚠️ `enabled` SHIPS FALSE. It is the kill switch, and a guild hears nothing
// until an admin sets a voice and turns it on. Disabling never clears the other
// fields, so turning voice back on restores the guild exactly as it was.

export interface IDeroVoiceConfig {
	guildId: string;
	enabled: boolean;
	// The ElevenLabs voice id of the owner's own clone. Only the id is stored;
	// the voice itself lives in the owner's ElevenLabs account.
	voiceId: string | null;
	listenEnabled: boolean;
	// Roles allowed to give Dero tasks (Phase 2 onward). Ids, never names.
	allowedRoleIds: string[];
	// Text channels Dero may post to on a member's behalf (Phase 2 onward).
	allowedChannelIds: string[];
	// Voice channels Dero may join (Phase 3 onward).
	allowedVoiceChannelIds: string[];
	monthlyCapUsd: number;
	createdAt?: Date;
	updatedAt?: Date;
}

const deroVoiceConfigSchema = new mongoose.Schema<IDeroVoiceConfig>(
	{
		guildId: { type: String, required: true, unique: true },
		enabled: { type: Boolean, default: false },
		voiceId: { type: String, default: null },
		listenEnabled: { type: Boolean, default: true },
		allowedRoleIds: { type: [String], default: [] },
		allowedChannelIds: { type: [String], default: [] },
		allowedVoiceChannelIds: { type: [String], default: [] },
		monthlyCapUsd: { type: Number, default: BOT_CONSTANTS.DERO_VOICE_DEFAULT_CAP_USD },
	},
	{ timestamps: true }
);

export const DeroVoiceConfig = mongoose.model<IDeroVoiceConfig>("DeroVoiceConfig", deroVoiceConfigSchema);
