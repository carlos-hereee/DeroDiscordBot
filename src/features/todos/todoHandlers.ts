import {
	EmbedBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	UserSelectMenuBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type GuildMember,
	type ModalSubmitInteraction,
	type RepliableInteraction,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import type { ITodo } from "@db/models/Todo.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { todoStore } from "@db/stores/todoStore.js";
import { readMemberTimezone } from "@features/reminders/memberTimezone.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { isOwnerOrAdmin } from "@utils/permissions.js";
import { parseReminderTime } from "@utils/reminderTimeParser.js";
import { acknowledgeTextModal, showConfirm, showModalOrReply, showNotice } from "@utils/textModal.js";
import { assignTodo, completeTodo, createTodo, removeTodo, reopenTodo, setTodoDue, type TodoRefusal, type TodoResult } from "./todoActions.js";
import { TODO_ACTIONS, TODO_PREFIX, todoCustomId } from "./todoCard.js";
import { canManageTodo, type TodoActor } from "./todoRights.js";

// ── todoHandlers ────────────────────────────────────────────────────────────
// What:  the Discord side of todos (2026-11 item 388 Phase 2): the card buttons (Done,
//        Reopen, Assign to me, Assign, Due date, Delete), the ✅todos intro's Add todo and My
//        todos, their modals, and the two helpers /todo add and /todo mine share.
// Who:   main.ts registers the todo prefix once at boot; commands/utility/todo.ts calls
//        addTodoFromMember and replyMyTodos.
// How:   every press reads the presser's rights again (a card is public, and a modal Submit
//        is reachable without the button that opened it); todoActions checks them once more
//        as it writes, so this file only decides what to show.

const TEXT_FIELD_ID = "text";
const DUE_FIELD_ID = "due";
const ASSIGNEE_FIELD_ID = "assignee";
// A typed time is short (30m, 12/24@18:00); the cap only keeps a pasted paragraph out.
const DUE_INPUT_MAX = 40;

interface PressContext {
	guildId: string;
	copy: IPluginCopy;
	actor: TodoActor;
	serverTimezone: unknown;
}

async function memberOf(interaction: RepliableInteraction): Promise<GuildMember | null> {
	if (interaction.inCachedGuild()) return interaction.member;
	if (!interaction.guild) return null;
	return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

async function pressContext(interaction: RepliableInteraction): Promise<PressContext | null> {
	const guildId = interaction.guildId;
	if (!guildId) return null;
	const config = await guildConfigStore.findByGuildId(guildId);
	const member = await memberOf(interaction);
	const isAdmin = member !== null && config !== null && isOwnerOrAdmin(member, { adminRoleId: config.adminRoleId ?? null });
	return { guildId, copy: getPluginCopy(config as unknown as ICopyConfig | null), actor: { userId: interaction.user.id, isAdmin }, serverTimezone: config?.timezone };
}

/** The private line for a refused todo action. */
export function todoRefusalLine(reason: TodoRefusal, copy: IPluginCopy): string {
	const words = copy.todoReminders.todos;
	switch (reason) {
		case "noChannel":
			return words.channelMissing;
		case "cap":
			return words.cap(BOT_CONSTANTS.TODOS.MAX_OPEN_PER_GUILD);
		case "textInvalid":
			return words.textInvalid(BOT_CONSTANTS.TODOS.TEXT_MAX);
		case "notFound":
			return words.notFound;
		case "notAllowed":
			return words.notAllowed;
		case "alreadyDone":
			return words.alreadyDone;
		case "alreadyOpen":
			return words.alreadyOpen;
		case "alreadyHeld":
			return words.alreadyHeld;
	}
}

const notice = (interaction: RepliableInteraction, copy: IPluginCopy, ...sections: string[]): Promise<void> =>
	showNotice(interaction, { title: copy.todoReminders.todos.noticeTitle, sections });

const toSeconds = (date: Date): number => Math.floor(new Date(date).getTime() / 1000);

// A typed due time read in the member's zone, or the private line saying why it was refused.
async function readDue(context: PressContext, raw: string, userId: string): Promise<{ dueAt: Date } | { refusal: string }> {
	const zone = await readMemberTimezone(context.guildId, userId, context.serverTimezone);
	const parsed = parseReminderTime(raw, zone);
	return parsed.ok ? { dueAt: parsed.at } : { refusal: context.copy.todoReminders.reminders.time[parsed.reason] };
}

// ── the modals ──────────────────────────────────────────────────────────────

function textField(customId: string, label: string, required: boolean, maxLength: number, placeholder?: string): LabelBuilder {
	const input = new TextInputBuilder().setCustomId(customId).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(maxLength);
	if (placeholder) input.setPlaceholder(placeholder);
	return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}

/** The Add todo modal, opened by the ✅todos intro. Exported for the tests. */
export function buildAddTodoModal(copy: IPluginCopy): ModalBuilder {
	const words = copy.todoReminders.todos;
	return new ModalBuilder()
		.setCustomId(todoCustomId(TODO_ACTIONS.add))
		.setTitle(words.addModal.title)
		.addLabelComponents(
			textField(TEXT_FIELD_ID, words.addModal.textLabel, true, BOT_CONSTANTS.TODOS.TEXT_MAX),
			textField(DUE_FIELD_ID, words.addModal.dueLabel, false, DUE_INPUT_MAX, words.timeHint)
		);
}

function buildDueModal(copy: IPluginCopy, todoId: string): ModalBuilder {
	const words = copy.todoReminders.todos;
	return new ModalBuilder()
		.setCustomId(todoCustomId(TODO_ACTIONS.due, todoId))
		.setTitle(words.dueModal.title)
		.addLabelComponents(textField(DUE_FIELD_ID, words.dueModal.label, false, DUE_INPUT_MAX, words.timeHint));
}

// Discord fills a user select itself, so it may offer anyone in the server; leaving it
// empty takes the todo from its holder.
function buildAssignModal(copy: IPluginCopy, todo: ITodo): ModalBuilder {
	const words = copy.todoReminders.todos.assignModal;
	const select = new UserSelectMenuBuilder().setCustomId(ASSIGNEE_FIELD_ID).setRequired(false).setMinValues(0).setMaxValues(1);
	if (todo.assigneeId) select.setDefaultUsers(todo.assigneeId);
	return new ModalBuilder()
		.setCustomId(todoCustomId(TODO_ACTIONS.assign, todo.todoId))
		.setTitle(words.title)
		.addLabelComponents(new LabelBuilder().setLabel(words.label).setUserSelectMenuComponent(select));
}

const openModal = (interaction: ButtonInteraction, modal: ModalBuilder, copy: IPluginCopy): Promise<void> =>
	showModalOrReply(interaction, modal, () => ({ content: copy.todoReminders.todos.notFound, flags: MessageFlags.Ephemeral }));

// ── shared with /todo ───────────────────────────────────────────────────────

// A todo's answer is its card, posted or redrawn in ✅todos (owner rule 1 of the Round 3 list:
// an answer is never a private notice), so a saved action only closes the interaction. A
// slash command must still be answered, so its private defer is deleted at once, the way
// acknowledgeTextModal closes a modal a slash command opened.
async function acknowledgeQuietly(interaction: ModalSubmitInteraction | ChatInputCommandInteraction): Promise<void> {
	if (interaction.isModalSubmit()) {
		await acknowledgeTextModal(interaction);
		return;
	}
	await interaction
		.deferReply({ flags: MessageFlags.Ephemeral })
		.then(() => interaction.deleteReply())
		.catch(() => undefined);
}

/** Add a todo from a member's typed text and optional due time. Shared by the modal and /todo add; only a refusal is said privately. */
export async function addTodoFromMember(interaction: ModalSubmitInteraction | ChatInputCommandInteraction, text: string, dueRaw: string | null): Promise<void> {
	const context = await pressContext(interaction);
	if (!context) return;
	let dueAt: Date | null = null;
	if (dueRaw && dueRaw.trim().length > 0) {
		const due = await readDue(context, dueRaw, interaction.user.id);
		if ("refusal" in due) return notice(interaction, context.copy, due.refusal);
		dueAt = due.dueAt;
	}
	const result = await createTodo(interaction.client, context.guildId, { text, dueAt, assigneeId: null }, context.actor);
	if (!result.ok) return notice(interaction, context.copy, todoRefusalLine(result.reason, context.copy));
	await acknowledgeQuietly(interaction);
}

/** A member's open todos in this server, privately, each linking to its card. Shared by My todos and /todo mine. */
export async function replyMyTodos(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
	const context = await pressContext(interaction);
	if (!context) return;
	const words = context.copy.todoReminders.todos.mine;
	const limit = BOT_CONSTANTS.TODOS.MINE_LIST_MAX;
	const [todos, total] = await Promise.all([
		todoStore.listOpenForAssignee(context.guildId, interaction.user.id, limit),
		todoStore.countOpenForAssignee(context.guildId, interaction.user.id),
	]);
	const lines = todos.map((todo) => {
		const url = todo.channelId && todo.messageId ? `https://discord.com/channels/${context.guildId}/${todo.channelId}/${todo.messageId}` : null;
		return `• ${words.line(todo.text, url, todo.dueAt ? toSeconds(todo.dueAt) : null)}`;
	});
	if (total > todos.length) lines.push("", words.more(total - todos.length));
	const embed = new EmbedBuilder()
		.setTitle(words.title)
		.setDescription(lines.length > 0 ? lines.join("\n") : words.empty)
		.setColor(context.copy.COLORS.SCHEDULE);
	await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ── the button press ────────────────────────────────────────────────────────

// Done, Reopen and Assign to me act at once. The press is acknowledged first, since the
// card's redraw is the visible answer, and only a refusal is said privately.
async function actOnPress(interaction: ButtonInteraction, context: PressContext, act: () => Promise<TodoResult>): Promise<void> {
	await interaction.deferUpdate().catch(() => undefined);
	const result = await act();
	if (!result.ok) await notice(interaction, context.copy, todoRefusalLine(result.reason, context.copy));
}

async function handleTodoButton(interaction: ButtonInteraction): Promise<void> {
	const [, action, todoId] = interaction.customId.split(":");
	const context = await pressContext(interaction);
	if (!context) return;
	const client = interaction.client;
	if (action === TODO_ACTIONS.add) {
		const config = await guildConfigStore.findByGuildId(context.guildId);
		if (!config?.todosChannelId) return notice(interaction, context.copy, todoRefusalLine("noChannel", context.copy));
		return openModal(interaction, buildAddTodoModal(context.copy), context.copy);
	}
	if (action === TODO_ACTIONS.list) return replyMyTodos(interaction);
	if (!todoId) return;

	switch (action) {
		case TODO_ACTIONS.done:
			return actOnPress(interaction, context, () => completeTodo(client, context.guildId, todoId, context.actor));
		case TODO_ACTIONS.reopen:
			return actOnPress(interaction, context, () => reopenTodo(client, context.guildId, todoId, context.actor));
		case TODO_ACTIONS.claim:
			return actOnPress(interaction, context, () => assignTodo(client, context.guildId, todoId, interaction.user.id, context.actor));
		case TODO_ACTIONS.confirmRemove:
			// The confirm's fallback button, pressed when no modal could open.
			return actOnPress(interaction, context, () => removeTodo(client, context.guildId, todoId, context.actor));
		default:
			break;
	}

	// Assign, Due date and Delete open a modal first, so their rights are checked before it
	// opens: a member who may not change the todo is told at once rather than after typing.
	const todo = await todoStore.findById(context.guildId, todoId);
	if (!todo) return notice(interaction, context.copy, todoRefusalLine("notFound", context.copy));
	if (!canManageTodo(todo, context.actor)) return notice(interaction, context.copy, todoRefusalLine("notAllowed", context.copy));
	const words = context.copy.todoReminders.todos;
	if (action === TODO_ACTIONS.assign) return openModal(interaction, buildAssignModal(context.copy, todo), context.copy);
	if (action === TODO_ACTIONS.due) return openModal(interaction, buildDueModal(context.copy, todoId), context.copy);
	if (action === TODO_ACTIONS.remove) {
		await showConfirm(
			interaction,
			{ title: words.confirmRemove.title, sections: [words.confirmRemove.body(todo.text)], confirmId: todoCustomId(TODO_ACTIONS.confirmRemove, todoId) },
			null
		);
	}
}

// ── the modal Submit ────────────────────────────────────────────────────────

async function handleTodoModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [, action, todoId] = interaction.customId.split(":");
	const context = await pressContext(interaction);
	if (!context) return;
	const client = interaction.client;
	// The redrawn card is the answer to a saved change; only a refusal is said privately.
	const answer = async (result: TodoResult): Promise<void> =>
		result.ok ? acknowledgeTextModal(interaction) : notice(interaction, context.copy, todoRefusalLine(result.reason, context.copy));

	if (action === TODO_ACTIONS.add) {
		return addTodoFromMember(interaction, interaction.fields.getTextInputValue(TEXT_FIELD_ID), interaction.fields.getTextInputValue(DUE_FIELD_ID));
	}
	if (!todoId) return;
	if (action === TODO_ACTIONS.confirmRemove) {
		return answer(await removeTodo(client, context.guildId, todoId, context.actor));
	}
	if (action === TODO_ACTIONS.assign) {
		const picked = interaction.fields.getSelectedUsers(ASSIGNEE_FIELD_ID)?.first() ?? null;
		return answer(await assignTodo(client, context.guildId, todoId, picked?.id ?? null, context.actor));
	}
	if (action === TODO_ACTIONS.due) {
		const raw = interaction.fields.getTextInputValue(DUE_FIELD_ID).trim();
		let dueAt: Date | null = null;
		if (raw.length > 0) {
			const due = await readDue(context, raw, interaction.user.id);
			if ("refusal" in due) return notice(interaction, context.copy, due.refusal);
			dueAt = due.dueAt;
		}
		return answer(await setTodoDue(client, context.guildId, todoId, dueAt, context.actor));
	}
}

/** Register the todo buttons and modals. Called once at boot from main.ts. */
export function registerTodoHandlers(): void {
	registerButton(TODO_PREFIX, handleTodoButton);
	registerModal(TODO_PREFIX, handleTodoModal);
}
