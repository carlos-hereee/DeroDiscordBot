import type { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";

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
// Added for the game rooms invite picker (plan task 4.5). A StringSelect is the
// only component type that lets the BOT build the option list, which is the
// structural reason a bot can never appear as an opponent; a UserSelect is
// populated by Discord and would happily return one.
export type TSelectHandler = (interaction: StringSelectMenuInteraction) => Promise<void>;

const buttonHandlers = new Map<string, TButtonHandler>();
const modalHandlers = new Map<string, TModalHandler>();
const selectHandlers = new Map<string, TSelectHandler>();

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

export function registerSelectMenu(prefix: string, handler: TSelectHandler): void {
	if (selectHandlers.has(prefix)) {
		throw new Error(`[interactionRegistry] select handler already registered for prefix '${prefix}'`);
	}
	selectHandlers.set(prefix, handler);
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

/**
 * Dispatch a string select submission. Same contract as the two above: false
 * means no handler claimed the prefix, which the caller should treat as an
 * inline collector's business (configure-rok-reminders and the decree edit flow
 * both drive selects that way) rather than as an error.
 */
export async function dispatchSelectMenu(interaction: StringSelectMenuInteraction): Promise<boolean> {
	const prefix = extractPrefix(interaction.customId);
	const handler = selectHandlers.get(prefix);
	if (!handler) return false;
	await handler(interaction);
	return true;
}
