// src/db/models/DeroVoiceConfig.ts
import mongoose from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { DEFAULT_VOICE_PRIORITY_ORDER } from "@features/voice/voicePriority.js";

// ── DeroVoiceConfig ──
// What:  one row per guild holding everything Dero's voice needs: the kill
//        switch, the voice id, whether Listen buttons appear, the three
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
// until an admin turns it on. Disabling never clears the other fields, so
// turning voice back on restores the guild exactly as it was.

export interface IDeroVoiceConfig {
	guildId: string;
	enabled: boolean;
	// The ElevenLabs voice id Dero speaks with. New rows get DERO_DEFAULT_VOICE_ID;
	// rows saved before that default carry null, so read it through
	// resolveDeroVoiceId (features/voice/deroVoiceId.ts), never directly.
	voiceId: string | null;
	listenEnabled: boolean;
	// Roles allowed to give Dero tasks (Phase 2 onward). Ids, never names.
	allowedRoleIds: string[];
	// Text channels Dero may post to on a member's behalf (Phase 2 onward).
	allowedChannelIds: string[];
	// Voice channels Dero may join (Phase 3 onward).
	allowedVoiceChannelIds: string[];
	monthlyCapUsd: number;
	// Which requests for Dero's voice go first while he is in a call (2026-10 item 257,
	// owner item 22). Read through normalizePriorityOrder (features/voice/voicePriority.ts),
	// never directly: a row saved before this field, or before a category existed, is
	// made whole there. Set by the ⚙️dero-config priority step.
	priorityOrder: string[];
	createdAt?: Date;
	updatedAt?: Date;
}

const deroVoiceConfigSchema = new mongoose.Schema<IDeroVoiceConfig>(
	{
		guildId: { type: String, required: true, unique: true },
		enabled: { type: Boolean, default: false },
		voiceId: { type: String, default: BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID },
		listenEnabled: { type: Boolean, default: true },
		allowedRoleIds: { type: [String], default: [] },
		allowedChannelIds: { type: [String], default: [] },
		allowedVoiceChannelIds: { type: [String], default: [] },
		monthlyCapUsd: { type: Number, default: BOT_CONSTANTS.DERO_VOICE_DEFAULT_CAP_USD },
		priorityOrder: { type: [String], default: () => [...DEFAULT_VOICE_PRIORITY_ORDER] },
	},
	{ timestamps: true }
);

export const DeroVoiceConfig = mongoose.model<IDeroVoiceConfig>("DeroVoiceConfig", deroVoiceConfigSchema);
