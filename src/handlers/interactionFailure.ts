import type { RepliableInteraction } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { showErrorNotice } from "@utils/textModal.js";

// ── answering an interaction whose handler threw ─────────────────────
// What:  the one catch main.ts's InteractionCreate dispatcher runs for every kind of
//        interaction (slash command, button, select, modal): log what failed, then tell the
//        member privately that it failed.
// Why:   it answers WHETHER OR NOT the handler already acknowledged. A handler that deferred
//        (a "Dero is thinking" reply, or a deferUpdate on a card) and then threw used to get no
//        answer at all, so the member watched a spinner for fifteen minutes. showErrorNotice
//        already picks a follow up once the interaction is acknowledged, so answering
//        unconditionally can never reply twice to the same response slot.
// Never throws: a failure to answer is logged, since the dispatcher has nothing left to try.

export async function answerInteractionFailure(interaction: RepliableInteraction, label: string, error: unknown): Promise<void> {
	console.error(`[interactions] ${label} threw`, error);
	try {
		await showErrorNotice(interaction, rokCommanderCopy.responses.commandExecuteFailure);
	} catch (answerError) {
		console.error(`[interactions] could not tell the member that ${label} failed`, answerError);
	}
}
