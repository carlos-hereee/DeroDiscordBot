import { ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type ModalSubmitInteraction, type RepliableInteraction } from "discord.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { memberTimezoneStore } from "@db/stores/memberTimezoneStore.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { showModalOrReply, showNotice } from "@utils/textModal.js";
import { buildTimezoneModal, pickedTimezone, TIMEZONE_FIELD_ID } from "@utils/timezoneModal.js";
import { isValidTimezone, resolveServerTimezone } from "@utils/tzParser.js";

// ── memberTimezone ──────────────────────────────────────────────────────────
// What:  a member's own timezone in one server (2026-11 item 388, owner decisions D16 and
//        D17): the zone every time they type for a todo, a reminder or a meeting is read in,
//        falling back to the server's zone (resolveServerTimezone) when they never set one.
// Who:   todoHandlers, personalReminders and scheduledMeetings read it; the Set my timezone
//        button on the ✅todos intro and /remind timezone set it, both through the one
//        timezone modal (utils/timezoneModal.ts, target "member").
// Does NOT: change the server's zone or any time already stored. A stored time is an instant.

/** The prefix of the member timezone button and of its modal ("mtz:set" in timezoneModal.ts). */
export const MEMBER_TIMEZONE_PREFIX = "mtz";
const OPEN_BUTTON_ID = `${MEMBER_TIMEZONE_PREFIX}:open`;

/** The zone a member's typed times are read in: their own, else the server's. */
export async function readMemberTimezone(guildId: string, userId: string, serverTimezone: unknown): Promise<string> {
	const own = await memberTimezoneStore.findZone(guildId, userId);
	// A stored zone is re-checked, because a row written before a zone left the Intl
	// database (or edited by hand) would make every time read from it throw.
	if (own && isValidTimezone(own)) return own;
	return resolveServerTimezone(serverTimezone);
}

/** The Set my timezone button, for the ✅todos intro. */
export function buildMemberTimezoneButton(guildConfig?: ICopyConfig | null): ButtonBuilder {
	const words = getPluginCopy(guildConfig).todoReminders.todos.intro;
	return new ButtonBuilder().setCustomId(OPEN_BUTTON_ID).setLabel(words.timezone).setEmoji("🕰️").setStyle(ButtonStyle.Secondary);
}

/** Open the member timezone modal with the member's current zone picked. Anyone may open it. */
export async function openMemberTimezoneModal(interaction: ButtonInteraction | Extract<RepliableInteraction, { showModal: unknown }>): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) return;
	const config = await guildConfigStore.findByGuildId(guildId);
	const current = await readMemberTimezone(guildId, interaction.user.id, config?.timezone);
	const copyConfig = config as ICopyConfig | null;
	await showModalOrReply(interaction, buildTimezoneModal(current, "member", copyConfig), () => ({
		content: getPluginCopy(copyConfig).todoReminders.reminders.timezoneRefused,
		flags: MessageFlags.Ephemeral,
	}));
}

async function handleMemberTimezoneSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) return;
	const config = await guildConfigStore.findByGuildId(guildId);
	const words = getPluginCopy(config as ICopyConfig | null).todoReminders.reminders;
	const zone = pickedTimezone(interaction.fields.getStringSelectValues(TIMEZONE_FIELD_ID)[0]);
	if (!zone) {
		await showNotice(interaction, { title: words.noticeTitle, sections: [words.timezoneRefused] });
		return;
	}
	await memberTimezoneStore.setZone(guildId, interaction.user.id, zone);
	await showNotice(interaction, { title: words.noticeTitle, sections: [words.timezoneSet(zone)] });
}

/** Register the button and the modal. Called once at boot from main.ts. */
export function registerMemberTimezoneHandlers(): void {
	registerButton(MEMBER_TIMEZONE_PREFIX, openMemberTimezoneModal);
	registerModal(MEMBER_TIMEZONE_PREFIX, handleMemberTimezoneSubmit);
}
