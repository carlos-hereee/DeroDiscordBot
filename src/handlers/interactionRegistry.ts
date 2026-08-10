import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

// ── interactionRegistry ──────────────────────────────────────────────
// What:  central dispatch table for persistent button + modal interactions.
//        Each command/feature that owns a persistent UI element registers
//        a handler here at module load; main.ts' interactionCreate listener
//        looks up the handler by customId prefix and forwards the
//        interaction.
// Who:   write side: feature modules (currently only the decree-edit flow).
//        read side: main.ts' interactionCreate listener.
// When:  registration runs once at bot boot via explicit imports in main.ts.
//        dispatch runs on every Discord button click + modal submit.
// Where: persistent buttons cannot use awaitMessageComponent (60s collector
//        timeout incompatible with edit-anytime semantics). The registry
//        keeps the dispatch O(1) per interaction by keying on the prefix
//        before the first ":" in the customId.
// How:   customIds follow the convention `<prefix>:<arg1>:<arg2>:...`.
//        Handlers register by the bare prefix; the dispatcher slices on
//        the first ":" so an `edit_decree` handler does NOT swallow
//        `edit_decree_apply_once` (which has its own prefix).

export type TButtonHandler = (interaction: ButtonInteraction) => Promise<void>;
export type TModalHandler = (interaction: ModalSubmitInteraction) => Promise<void>;

const buttonHandlers = new Map<string, TButtonHandler>();
const modalHandlers = new Map<string, TModalHandler>();

function extractPrefix(customId: string): string {
	const idx = customId.indexOf(":");
	return idx === -1 ? customId : customId.substring(0, idx);
}

export function registerButton(prefix: string, handler: TButtonHandler): void {
	if (buttonHandlers.has(prefix)) {
		throw new Error(`[interactionRegistry] button handler already registered for prefix '${prefix}'`);
	}
	buttonHandlers.set(prefix, handler);
}

export function registerModal(prefix: string, handler: TModalHandler): void {
	if (modalHandlers.has(prefix)) {
		throw new Error(`[interactionRegistry] modal handler already registered for prefix '${prefix}'`);
	}
	modalHandlers.set(prefix, handler);
}

/**
 * Dispatch a button interaction to the registered handler. Returns true when
 * a handler ran (regardless of whether it threw, the listener wrapper logs
 * the error). Returns false when no handler matched the customId prefix,
 * the caller should treat that as an unhandled persistent button (possibly
 * a stale message from a previous bot version).
 */
export async function dispatchButton(interaction: ButtonInteraction): Promise<boolean> {
	const prefix = extractPrefix(interaction.customId);
	const handler = buttonHandlers.get(prefix);
	if (!handler) return false;
	await handler(interaction);
	return true;
}

export async function dispatchModal(interaction: ModalSubmitInteraction): Promise<boolean> {
	const prefix = extractPrefix(interaction.customId);
	const handler = modalHandlers.get(prefix);
	if (!handler) return false;
	await handler(interaction);
	return true;
}
