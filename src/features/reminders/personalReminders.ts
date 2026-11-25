import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type InteractionReplyOptions } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import type { IReminder } from "@db/models/Reminder.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { reminderRowStore } from "@db/stores/reminderRowStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { fitLines } from "@utils/clipText.js";
import { parseReminderTime, type ReminderTimeRefusal } from "@utils/reminderTimeParser.js";
import { shortId } from "@utils/shortId.js";
import { showNotice } from "@utils/textModal.js";
import { readMemberTimezone } from "./memberTimezone.js";

// ── personalReminders ───────────────────────────────────────────────────────
// What:  a member's own reminders (2026-11 item 388, owner decision D14): /remind me sets one
//        at a typed time, /remind list shows the waiting ones with a Cancel button each.
//        runDueReminders delivers them by DM, falling back to a ping in the channel the
//        reminder was set in (D15). Personal reminders need no channel of their own (D18).
// Who:   commands/utility/remind.ts; main.ts registers the rmd prefix once at boot.

/** The prefix of the list's Cancel buttons: `rmd:cancel:<reminderId>`. */
export const REMINDER_PREFIX = "rmd";
const CANCEL_ACTION = "cancel";

/** Why a personal reminder was refused. */
export type PersonalReminderRefusal = ReminderTimeRefusal | "cap" | "textInvalid";

export type PersonalReminderResult = { ok: true; fireAt: Date } | { ok: false; reason: PersonalReminderRefusal };

export interface PersonalReminderInput {
	guildId: string;
	userId: string;
	// Where it was set, the channel a closed DM falls back to.
	channelId: string | null;
	whenText: string;
	text: string;
	serverTimezone: unknown;
}

/** Set a reminder: the time read in the member's zone, the text checked, the cap of A10 kept. */
export async function createPersonalReminder(input: PersonalReminderInput, now: Date = new Date()): Promise<PersonalReminderResult> {
	const { REMINDERS } = BOT_CONSTANTS;
	const text = input.text.trim();
	if (text.length === 0 || text.length > REMINDERS.TEXT_MAX) return { ok: false, reason: "textInvalid" };
	const zone = await readMemberTimezone(input.guildId, input.userId, input.serverTimezone);
	const parsed = parseReminderTime(input.whenText, zone, now);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	if ((await reminderRowStore.countPendingPersonal(input.guildId, input.userId)) >= REMINDERS.PERSONAL_MAX_PENDING) return { ok: false, reason: "cap" };
	await reminderRowStore.insertPersonal({ reminderId: shortId(), guildId: input.guildId, userId: input.userId, text, channelId: input.channelId, fireAt: parsed.at });
	return { ok: true, fireAt: parsed.at };
}

/** The private line for a refused reminder. */
export function personalRefusalLine(reason: PersonalReminderRefusal, copy: IPluginCopy): string {
	const words = copy.todoReminders.reminders;
	if (reason === "cap") return words.cap(BOT_CONSTANTS.REMINDERS.PERSONAL_MAX_PENDING);
	if (reason === "textInvalid") return words.textInvalid(BOT_CONSTANTS.REMINDERS.TEXT_MAX);
	return words.time[reason];
}

const toSeconds = (date: Date): number => Math.floor(new Date(date).getTime() / 1000);

/**
 * The private list: each waiting reminder numbered, with a Cancel button per reminder. The
 * cap of 25 is exactly five rows of five buttons, Discord's ceiling for one message. Long texts
 * are clipped so every line shows; more embeds would not help, since 25 full reminders also pass
 * Discord's 6,000 characters for all of one message's embeds.
 */
export function buildReminderList(reminders: IReminder[], copy: IPluginCopy): InteractionReplyOptions {
	const words = copy.todoReminders.reminders.list;
	const lines = fitLines(
		reminders.map((row) => row.text ?? ""),
		(text, index) => words.line(index + 1, text, toSeconds(reminders[index].fireAt)),
		BOT_CONSTANTS.DISCORD_LIMITS.MAX_EMBED_DESCRIPTION_LENGTH
	);
	const embed = new EmbedBuilder()
		.setTitle(words.title)
		.setColor(copy.COLORS.SCHEDULE)
		.setDescription(lines.length > 0 ? lines.join("\n") : words.empty);
	const { MAX_ROW_BUTTONS, MAX_MESSAGE_ROWS } = BOT_CONSTANTS.DISCORD_LIMITS;
	const buttons = reminders
		.slice(0, MAX_ROW_BUTTONS * MAX_MESSAGE_ROWS)
		.map((row, index) => new ButtonBuilder().setCustomId(`${REMINDER_PREFIX}:${CANCEL_ACTION}:${row.reminderId}`).setLabel(words.cancel(index + 1)).setStyle(ButtonStyle.Secondary));
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	for (let start = 0; start < buttons.length; start += MAX_ROW_BUTTONS) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(start, start + MAX_ROW_BUTTONS)));
	return { embeds: [embed], components: rows, flags: MessageFlags.Ephemeral };
}

async function copyFor(guildId: string): Promise<IPluginCopy> {
	return getPluginCopy((await guildConfigStore.findByGuildId(guildId)) as unknown as ICopyConfig | null);
}

/** /remind list: the member's waiting reminders in this server, privately. */
export async function replyReminderList(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) return;
	const reminders = await reminderRowStore.listPendingPersonal(guildId, interaction.user.id);
	await interaction.reply(buildReminderList(reminders, await copyFor(guildId)));
}

// Cancel on the private list. Only the member's own reminders can match: the cancel write is
// filtered by the presser's id, so a copied customId cancels nothing of anyone else's.
async function handleReminderButton(interaction: ButtonInteraction): Promise<void> {
	const [, action, reminderId] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || action !== CANCEL_ACTION || !reminderId) return;
	const copy = await copyFor(guildId);
	const cancelled = await reminderRowStore.cancelPersonal(guildId, interaction.user.id, reminderId, new Date());
	if (!cancelled) {
		await showNotice(interaction, { title: copy.todoReminders.reminders.noticeTitle, sections: [copy.todoReminders.reminders.gone] });
		return;
	}
	const remaining = await reminderRowStore.listPendingPersonal(guildId, interaction.user.id);
	const { embeds, components } = buildReminderList(remaining, copy);
	await interaction.update({ embeds, components });
}

/** Register the list's Cancel buttons. Called once at boot from main.ts. */
export function registerPersonalReminderHandlers(): void {
	registerButton(REMINDER_PREFIX, handleReminderButton);
}
