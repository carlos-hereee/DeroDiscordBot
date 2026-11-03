import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// ── the voice rooms' Dero buttons ────────────────────────────────────────────
// What:  the Join, Leave and Status row on the intro in each managed voice room's
//        text chat (🏛️ Meeting Hall and 🎮 Arcade Lounge), 2026-10 item 245 Phase 4b.
// Who:   GuildSetupManager.resolveIntroComponents builds it; voiceRoomControlHandlers
//        answers each press with the very handler /dero join, leave and status run.
// Why a separate module: the handlers import the /dero command, which sits above
//        the setup manager in the import graph; this builder imports nothing, so the
//        setup manager can use it without joining that cycle.

/** The customId prefix of the three buttons: `dero_call:<join|leave|status>`. */
export const VOICE_ROOM_CONTROL_PREFIX = "dero_call";

export const VOICE_ROOM_ACTIONS = ["join", "leave", "status"] as const;
export type VoiceRoomAction = (typeof VOICE_ROOM_ACTIONS)[number];

/** The three labels, read from the guild's copy pack. */
export interface VoiceRoomControlLabels {
	joinLabel: string;
	leaveLabel: string;
	statusLabel: string;
}

/** Join, Leave and Status, in that order. */
export function buildVoiceRoomControlRow(labels: VoiceRoomControlLabels): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${VOICE_ROOM_CONTROL_PREFIX}:join`).setLabel(labels.joinLabel).setEmoji("🎙️").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`${VOICE_ROOM_CONTROL_PREFIX}:leave`).setLabel(labels.leaveLabel).setEmoji("👋").setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId(`${VOICE_ROOM_CONTROL_PREFIX}:status`).setLabel(labels.statusLabel).setEmoji("📡").setStyle(ButtonStyle.Secondary)
	);
}

/** The action a customId names, or null for one this build does not know. */
export function voiceRoomActionOf(customId: string): VoiceRoomAction | null {
	const action = customId.split(":")[1];
	return VOICE_ROOM_ACTIONS.find((known) => known === action) ?? null;
}
