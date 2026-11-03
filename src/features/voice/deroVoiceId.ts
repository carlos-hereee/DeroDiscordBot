import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";

// ── deroVoiceId ────────────────────────────────────────────────────────────
// What:  the one answer to "which voice does Dero speak with in this guild".
// Who:   every reader of DeroVoiceConfig.voiceId: /dero join, /dero-config status,
//        Listen, the call announcer, the turn loop, the brain's say action and the
//        Hold'em rules card.
// Where: the schema defaults voiceId to DERO_DEFAULT_VOICE_ID for new rows, but rows
//        saved before that default carry an explicit null, and a guild that never ran
//        /dero-config has no row at all. Both mean the default voice, so no reader
//        may treat a missing id as "voice not set up" again.

/** The guild's voice id, or Dero's default voice when none is stored. */
export function resolveDeroVoiceId(config: Pick<IDeroVoiceConfig, "voiceId"> | null): string {
	return config?.voiceId ?? BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID;
}
