import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type EmbedBuilder } from "discord.js";
import type { IPluginCopy } from "@base/copy/index.js";
import type { ITodo } from "@db/models/Todo.js";
import type { CardPayload } from "@utils/cardMessage.js";
import { infoEmbed } from "@utils/embedBuilder.js";

// ── todoCard ────────────────────────────────────────────────────────────────
// What:  a todo's card in ✅todos, drawn from its row alone (2026-11 item 388 Phase 2): the
//        text, who holds it, the due time as Discord timestamps, its status, and a link to the
//        meeting notes it came from. Every redraw builds it from the row, so a change made on
//        any surface (a button, a command, the dashboard) shows the same card.
// Who:   todoActions.syncTodoCard; the intro row builder below for the ✅todos intro.

/** Every todo customId starts with this prefix (handlers/interactionRegistry.ts routes it). */
export const TODO_PREFIX = "todo";

/** The card's actions, and the intro's two, as they appear in a customId. Short on purpose: the id must stay under 100 characters (R12). */
export const TODO_ACTIONS = {
	done: "done",
	reopen: "reopen",
	claim: "mine",
	assign: "assign",
	due: "due",
	remove: "del",
	confirmRemove: "delok",
	add: "add",
	list: "list",
} as const;
export type TodoAction = (typeof TODO_ACTIONS)[keyof typeof TODO_ACTIONS];

/** `todo:<action>` or `todo:<action>:<todoId>`. */
export const todoCustomId = (action: TodoAction, todoId?: string): string => (todoId ? `${TODO_PREFIX}:${action}:${todoId}` : `${TODO_PREFIX}:${action}`);

const toSeconds = (date: Date): number => Math.floor(new Date(date).getTime() / 1000);

function cardEmbed(todo: ITodo, copy: IPluginCopy, meetingNotesUrl: string | null, updatedFromDashboard: boolean): EmbedBuilder {
	const words = copy.todoReminders.todos.card;
	const isDone = todo.status === "done";
	const lines = [todo.text];
	if (isDone && todo.doneAt) lines.push("", words.doneLine(todo.doneBy, toSeconds(todo.doneAt)));
	if (meetingNotesUrl) lines.push("", words.meetingLink(meetingNotesUrl));
	if (updatedFromDashboard) lines.push("", words.updatedFromDashboard);
	return infoEmbed(isDone ? words.doneTitle : words.openTitle, lines.join("\n"), copy.COLORS.SCHEDULE).addFields(
		{ name: words.holderLabel, value: todo.assigneeId ? `<@${todo.assigneeId}>` : words.nobody, inline: true },
		{ name: words.dueLabel, value: todo.dueAt ? words.due(toSeconds(todo.dueAt)) : words.noDue, inline: true },
		{ name: words.addedByLabel, value: todo.createdBy ? `<@${todo.createdBy}>` : words.addedFromDashboard, inline: true }
	);
}

function cardButtons(todo: ITodo, copy: IPluginCopy): ButtonBuilder[] {
	const words = copy.todoReminders.todos.buttons;
	const button = (action: TodoAction, label: string, style: ButtonStyle): ButtonBuilder =>
		new ButtonBuilder().setCustomId(todoCustomId(action, todo.todoId)).setLabel(label).setStyle(style);
	const remove = button(TODO_ACTIONS.remove, words.remove, ButtonStyle.Danger);
	if (todo.status === "done") return [button(TODO_ACTIONS.reopen, words.reopen, ButtonStyle.Secondary), remove];
	return [
		button(TODO_ACTIONS.done, words.done, ButtonStyle.Success),
		// Assign to me shows only while nobody holds the todo, the one moment anyone may press it.
		...(todo.assigneeId ? [] : [button(TODO_ACTIONS.claim, words.claim, ButtonStyle.Primary)]),
		button(TODO_ACTIONS.assign, words.assign, ButtonStyle.Secondary),
		button(TODO_ACTIONS.due, words.due, ButtonStyle.Secondary),
		remove,
	];
}

/**
 * The card for `todo`. `meetingNotesUrl` is the link to the notes card of the meeting it came
 * from, which the caller reads off that meeting's row. A card never pings: mentions render
 * as names, and the reminder is what reaches the holder. `updatedFromDashboard` marks a
 * redraw a dashboard write caused; the next redraw from Discord drops the line again.
 */
export function buildTodoCard(todo: ITodo, copy: IPluginCopy, meetingNotesUrl: string | null = null, updatedFromDashboard = false): CardPayload {
	return {
		embeds: [cardEmbed(todo, copy, meetingNotesUrl, updatedFromDashboard)],
		components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...cardButtons(todo, copy))],
		allowedMentions: { parse: [], users: [], roles: [] },
	};
}

/** Add todo, My todos and Set my timezone, the ✅todos intro's row. `timezoneButton` comes from features/reminders. */
export function buildTodosIntroRow(copy: IPluginCopy, timezoneButton: ButtonBuilder): ActionRowBuilder<ButtonBuilder> {
	const words = copy.todoReminders.todos.intro;
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(todoCustomId(TODO_ACTIONS.add)).setLabel(words.add).setEmoji("➕").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(todoCustomId(TODO_ACTIONS.list)).setLabel(words.mine).setEmoji("📋").setStyle(ButtonStyle.Secondary),
		timezoneButton
	);
}
