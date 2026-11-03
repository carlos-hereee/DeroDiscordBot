import { type ButtonInteraction } from "discord.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { bringDeroIntoCall, sendDeroAwayFromCall, showDeroStatus } from "@commands/utility/dero.js";
import { commandButtonsCopy } from "@features/command-buttons/commandButtonsCopy.js";
import { VOICE_ROOM_CONTROL_PREFIX, voiceRoomActionOf } from "./voiceRoomControls.js";
import { showNotice } from "@utils/textModal.js";

// ── the voice rooms' Dero buttons, answered ──────────────────────────────────
// What:  routes Join, Leave and Status on a voice room's intro to /dero join,
//        leave and status. Nothing is gated here, on purpose: each of those three
//        handlers runs its own task list check (authorizer.isAuthorizedSpeaker),
//        so a button admits exactly who the slash command admits and no one else.
// Who:   main.ts registers it at boot, beside the other persistent buttons.

async function handleVoiceRoomControl(interaction: ButtonInteraction): Promise<void> {
	switch (voiceRoomActionOf(interaction.customId)) {
		case "join":
			await bringDeroIntoCall(interaction);
			return;
		case "leave":
			await sendDeroAwayFromCall(interaction);
			return;
		case "status":
			await showDeroStatus(interaction);
			return;
		default:
			await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [commandButtonsCopy.launcher.staleButton] });
	}
}

/** Register the voice rooms' Join, Leave and Status buttons. Called once at boot from main.ts. */
export function registerVoiceRoomControlHandlers(): void {
	registerButton(VOICE_ROOM_CONTROL_PREFIX, handleVoiceRoomControl);
}
