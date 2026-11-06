import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type ColorResolvable, type EmbedBuilder, type InteractionReplyOptions, type RepliableInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { ageConfirmationStore } from "@db/stores/ageConfirmationStore.js";
import type { IAgeConfirmation } from "@db/models/AgeConfirmation.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { infoEmbed } from "@utils/embedBuilder.js";

// ── ageGateRules ─────────────────────────────────────────────────────
// What:  the one global, per Discord user 18+ confirmation gate (2026-11 item 302), for
//        ElevenLabs Startup Grant compliance: grants exclude projects used by minors, and
//        most Dero players have no CompanyUno account, so the client's account-level 18+
//        requirement never reaches them. A member answers once, ever, across every server.
// Who:   every door into a game (features/game-rooms/joinGate.ts, challengeBoard.
//        offerChallengeDraft, games/arcadeHost.openSoloRoomForMember) and, as a safety
//        net, the Dero voice join path (commands/utility/dero.ts runQueuedJoin).
// Does NOT: decide who may play a specific room (joinGate's other refusals), or build an
//        admin override for a declined member; that correction is a manual database edit.
//
// ⚠️ NO ROW, OR A ROW BELOW BOT_CONSTANTS.AGE_GATE.CONFIRMATION_VERSION, IS CONFIRMED. A
// "declined" row is NEVER current, at any version: raising the version must never let a
// decliner be asked again by accident. Every caller branches on the row's actual status
// (confirmed, declined, missing) through replyWithAgeGate, never on the boolean alone, so
// a declined member always sees the permanent block text and never the yes/no prompt again.

/** The customId prefix of the age gate's two buttons, following `<prefix>:<arg>`. */
export const AGE_GATE_PREFIX = "ageGate";

const words = rokCommanderCopy.ageGate;

/** True only while a row is confirmed at the current version or later. A declined row is never true. */
export function isAgeConfirmed(row: Pick<IAgeConfirmation, "status" | "termsVersion"> | null | undefined): boolean {
	if (!row) return false;
	return row.status === "confirmed" && row.termsVersion >= BOT_CONSTANTS.AGE_GATE.CONFIRMATION_VERSION;
}

/** Whether a Discord user has confirmed their age at the current version. */
export async function hasConfirmedAge(userId: string): Promise<boolean> {
	return isAgeConfirmed(await ageConfirmationStore.findByUserId(userId));
}

/** The gate's embed: Dero's age check, with no buttons of its own (ageGatePrompt adds them). */
function ageGateEmbed(): EmbedBuilder {
	return infoEmbed(words.prompt.title, words.prompt.body, COLORS.ARCADE as ColorResolvable);
}

/** The ephemeral prompt shown to a member with no row, or a stale one: the embed and its yes/no row. */
export function ageGatePrompt(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${AGE_GATE_PREFIX}:yes`).setLabel(words.prompt.acceptLabel).setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${AGE_GATE_PREFIX}:no`).setLabel(words.prompt.declineLabel).setStyle(ButtonStyle.Secondary)
	);
	return { embeds: [ageGateEmbed()], components: [row] };
}

/** The permanent block for a declined member: plain text, no buttons, no embed. */
export function ageGateBlockedNotice(): { content: string; embeds: []; components: [] } {
	return { content: words.blocked, embeds: [], components: [] };
}

/**
 * The one ephemeral answer every wiring point hands an unconfirmed or declined member:
 * reads the row fresh and shows the yes/no prompt, or, for a declined row, the permanent
 * block text instead, never the prompt again. Uses reply for a fresh interaction and
 * followUp for one already deferred or answered (a caller past the point where it can
 * cleanly reply), so a refusal this deep is never silently dropped. Never throws.
 */
export async function replyWithAgeGate(interaction: RepliableInteraction): Promise<void> {
	const row = await ageConfirmationStore.findByUserId(interaction.user.id);
	const payload: InteractionReplyOptions = { ...(row?.status === "declined" ? ageGateBlockedNotice() : ageGatePrompt()), flags: MessageFlags.Ephemeral };
	try {
		await (interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload));
	} catch (error) {
		console.warn("[age-gate] the ephemeral age reply could not be sent", { interactionId: interaction.id, error });
	}
}

/**
 * I'm 18 or older, or I'm under 18, on the ephemeral prompt. "yes" cannot resume the
 * command or press that asked for the gate: that interaction is a separate, now stale one,
 * so the member is told to press or type it again rather than have a fragile replay
 * mechanism attempt to reconstruct it. "no" edits this same ephemeral message in place to
 * the permanent block, with its buttons removed.
 */
async function handleAgeGateButton(interaction: ButtonInteraction): Promise<void> {
	const answer = interaction.customId.split(":")[1];
	const now = new Date();
	if (answer === "yes") {
		await ageConfirmationStore.accept(interaction.user.id, BOT_CONSTANTS.AGE_GATE.CONFIRMATION_VERSION, now);
		await interaction.update({ content: words.confirmedPressAgain, embeds: [], components: [] });
		return;
	}
	if (answer !== "no") return;
	await ageConfirmationStore.decline(interaction.user.id, BOT_CONSTANTS.AGE_GATE.CONFIRMATION_VERSION, now);
	await interaction.update(ageGateBlockedNotice());
}

/** Register the age gate's two buttons. Called once at boot from main.ts, beside the other register*Handlers calls. */
export function registerAgeGateHandlers(): void {
	registerButton(AGE_GATE_PREFIX, handleAgeGateButton);
}
