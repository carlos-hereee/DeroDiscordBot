import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { askInChannel } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import { adminLog } from "./adminLog.js";
import { turnArcadeOff } from "./arcadeSwitch.js";
import { setupCopy } from "./setupCopy.js";

// ── arcadeControlCards ──────────────────────────────────────────────────────
// What:  the button that sits beside the numbered steps on 🎰arcade-control's steps card
//        while the arcade is on (2026-11 item 285 Phase 4): Dismantle Arcade, which takes
//        the arcade down the way /arcade off does but only after a Dismantle or Cancel
//        confirm. While the arcade is off the card is the one Turn the arcade on step
//        instead, so the coming soon Enable Arcade stub is retired (2026-11 item 285 debug
//        pass, owner ruling); an older card's stub press runs that step.
// Who:   headquartersCards.ts puts buildButtons on the card; headquartersSteps.ts routes
//        each press here as `hqstep:arcadeControl:dismantle`.
// Where: the teardown is arcadeSwitch.turnArcadeOff, the one way the arcade goes off, so a
//        button, /arcade off and a self destruct cannot take it down differently. The
//        confirm is askInChannel, the codebase's one confirm then act prompt. Nothing here
//        touches a channel itself, and the button DMs nobody.
// How:   each press re-runs the owner or admin gate, because a button outlives the role
//        that was allowed to press it. A stray press on Dismantle only posts the confirm.

const copy = setupCopy.headquarters.arcadeControl;

const DOMAIN = "arcadeControl";

// The same window /events delete gives its confirm; past it the prompt is rewritten so a
// stale Dismantle can never be pressed into a teardown later.
const DISMANTLE_CONFIRM_MS = 60_000;

const DISMANTLE_CONFIRM_ID = "confirm_dismantle_arcade";
const DISMANTLE_CANCEL_ID = "cancel_dismantle_arcade";

/** The step tail the button carries after `hqstep:arcadeControl:`. */
export const ARCADE_CONTROL_STEP_TAILS = { dismantle: "dismantle" } as const;
export type ArcadeControlAction = keyof typeof ARCADE_CONTROL_STEP_TAILS;

/** The tail the retired Enable Arcade stub carried; a press on a card not redrawn yet runs the enable step. */
export const RETIRED_ENABLE_STUB_TAIL = "enableStub";

/** The customId of one button: `hqstep:arcadeControl:<tail>`. */
export function arcadeControlCustomId(action: ArcadeControlAction): string {
	return `hqstep:${DOMAIN}:${ARCADE_CONTROL_STEP_TAILS[action]}`;
}

/** The action a step tail names, or null for one no button carries. */
export function arcadeControlActionOf(step: string): ArcadeControlAction | null {
	return (Object.keys(ARCADE_CONTROL_STEP_TAILS) as ArcadeControlAction[]).find((action) => ARCADE_CONTROL_STEP_TAILS[action] === step) ?? null;
}

/**
 * The buttons beside the steps while the arcade is on. Dismantle stays pressable on a card
 * the boot sweep has not redrawn yet: a press on an arcade already down answers so.
 */
export function buildButtons(): ButtonBuilder[] {
	return [new ButtonBuilder().setCustomId(arcadeControlCustomId("dismantle")).setLabel(copy.dismantleButton).setStyle(ButtonStyle.Danger)];
}

// ── the presses ──────────────────────────────────────────────────────────────

/** True when the presser may use the arcade controls; otherwise they were told so. */
async function passesGate(interaction: ButtonInteraction, config: Awaited<ReturnType<typeof guildConfigStore.findByGuildId>>): Promise<boolean> {
	if (await gateOwnerOrAdmin(interaction, config)) return true;
	await showNotice(interaction, { title: getPluginCopy(config as unknown as ICopyConfig | null).notice.arcade, sections: [copy.notAdmin] });
	return false;
}

function buildConfirmRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(DISMANTLE_CANCEL_ID).setLabel(copy.dismantleConfirm.cancelButton).setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId(DISMANTLE_CONFIRM_ID).setLabel(copy.dismantleConfirm.confirmButton).setStyle(ButtonStyle.Danger)
	);
}

/**
 * Dismantle Arcade: re-check the presser, ask Dismantle or Cancel in 🎰arcade-control, and
 * only on Dismantle take the arcade down through turnArcadeOff, rewriting the prompt with
 * the outcome in the guild's pack voice. A real teardown is logged to 🗒️admin-log and
 * redraws the card; "already off" changes nothing. Never throws.
 */
export async function handleDismantle(interaction: ButtonInteraction): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!(await passesGate(interaction, config))) return;

	const copyConfig = config as unknown as ICopyConfig | null;
	// Only the asker's press resolves the wait; anyone else is turned away with a notice.
	const prompt = await askInChannel(
		interaction,
		"arcade",
		{ embeds: [infoEmbed(copy.dismantleConfirm.title, copy.dismantleConfirm.body, COLORS.ERROR, copyConfig)], components: [buildConfirmRow()] },
		{ config }
	);

	const press = await prompt.awaitPress(DISMANTLE_CONFIRM_MS);
	if (!press) {
		await prompt.edit({ embeds: [infoEmbed(copy.dismantleConfirm.title, copy.dismantleConfirm.timedOut, COLORS.ADMIN, copyConfig)], components: [] });
		return;
	}
	if (press.customId !== DISMANTLE_CONFIRM_ID) {
		await press.update({ embeds: [infoEmbed(copy.dismantleConfirm.title, copy.dismantleConfirm.cancelled, COLORS.ADMIN, copyConfig)], components: [] });
		return;
	}

	// Deleting a category and its channels can outrun Discord's three second window for
	// answering this press, so it is acknowledged first and the prompt rewritten after.
	await press.deferUpdate();
	try {
		const outcome = await turnArcadeOff(guild);
		const responses = getPluginCopy(copyConfig).responses;
		if (outcome === "already-off") {
			await prompt.edit({ embeds: [infoEmbed(setupCopy.arcade.offTitle, responses.dismantleAlreadyOff, COLORS.ADMIN, copyConfig)], components: [] });
			return;
		}
		adminLog.emitFor(press, guild.id, "config.change", { subject: setupCopy.adminLog.subjects.arcade, detail: setupCopy.arcade.auditOff });
		// Loaded on use: headquartersCards imports this file for the buttons, so a static
		// import back would be a cycle.
		void import("./headquartersCards.js").then((cards) => cards.refreshHeadquartersCards(guild, DOMAIN));
		await prompt.edit({ embeds: [infoEmbed(setupCopy.arcade.offTitle, responses.dismantleSuccess, COLORS.ADMIN, copyConfig)], components: [] });
	} catch (error) {
		console.error(`[arcade-control] guild ${guild.id}: dismantling the arcade from its card failed`, error);
		await prompt.edit({ embeds: [errorEmbed(setupCopy.arcade.offFailed, copyConfig)], components: [] });
	}
}
