import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	StringSelectMenuBuilder,
	type ButtonInteraction,
	type EmbedBuilder,
	type InteractionEditReplyOptions,
	type ModalSubmitInteraction,
	type RepliableInteraction,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
	type StringSelectMenuInteraction,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { checkEarlyAccess, earlyAccessEmbed } from "@features/early-access/earlyAccess.js";
import { registerButton, registerModal, registerSelectMenu } from "@handlers/interactionRegistry.js";
import type { FormChoicesProvider, OptionChoice, SharedCommandHandler } from "@handlers/commandOptions.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { showErrorNotice, showNotice } from "@utils/textModal.js";
import * as channelsCommand from "@commands/admin/channels.js";
import * as configureCommand from "@commands/admin/configure.js";
import * as deroConfigCommand from "@commands/admin/dero-config.js";
import * as economyCommand from "@commands/admin/economy.js";
import * as eventsCommand from "@commands/admin/events.js";
import * as scheduleCommand from "@commands/admin/schedule.js";
import * as levelSystemCommand from "@commands/admin/setup-level-system.js";
import * as xpCommand from "@commands/admin/xp.js";
import * as kvkSeasonCommand from "@commands/events/configure-rok-reminders.js";
import * as streamCommand from "@commands/streamer/stream.js";
import { ADMIN_COMMAND_BUTTON_PREFIX } from "./adminGuideButtons.js";
import { buildForm, findLeaf, listLeaves, readForm, type CommandLeaf, type FormField } from "./commandForm.js";
import { FormOptionReader } from "./formOptionReader.js";
import { commandButtonsCopy } from "./commandButtonsCopy.js";
import { collectReplies, type CollectedReply } from "./replyCollector.js";
import { buildSettingsModal, planSettingsChanges, readSettingsPanel, type LeafCall } from "./settingsPanel.js";
import { SETTINGS_PANELS, type PanelDefinition } from "./settingsPanels.js";

// ── the admin command launcher ───────────────────────────────────────────────
// What:  every admin guide button's flow. A press opens the command the way its
//        slash command would: a private pick of what to do when the command has
//        several subcommands, then a modal for its options, then the command's own
//        `run`, the very handler the slash command calls.
// Who:   the buttons adminGuideButtons builds on the admin command guide. Each step
//        (press, pick, form) re-runs gateOwnerOrAdmin, because a select or a modal
//        is reachable without the button that opened it.
// When:  on every press, pick and submit; nothing here is held in memory, so a
//        guide posted by an earlier deploy keeps working.
// How:   ① the button names the command; ② a command with one leaf goes straight
//        to ③, otherwise a select lists its leaves; ③ a leaf with no options runs
//        at once, one with more fields than a modal holds first asks which optional
//        ones to fill, and the rest open the form; ④ the submit is read back into a
//        FormOptionReader and the command runs. A refusal or a stale control is
//        answered with a notice modal rather than a message left to dismiss
//        (post-launch plan item 9), except after a modal submit, which cannot open
//        a modal and gets the private reply.
//        A command with a settings panel (settingsPanels.ts) opens it at ① instead
//        of the pick: one modal of its switches and choices as they stand. Its
//        submit runs the command's own leaf once per changed setting, through a
//        reply collector, and answers once with every result and the pick of the
//        command's other leaves.

/** What the launcher needs of an admin command module: its builder, its shared run and its form picks. */
export interface LaunchableCommand {
	data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
	run: SharedCommandHandler;
	formChoices?: FormChoicesProvider;
}

const LIMITS = BOT_CONSTANTS.DISCORD_LIMITS;
const PICK_LEAF_PREFIX = `${ADMIN_COMMAND_BUTTON_PREFIX}_leaf`;
const PICK_FIELDS_PREFIX = `${ADMIN_COMMAND_BUTTON_PREFIX}_fields`;
const REQUIRED_ONLY_PREFIX = `${ADMIN_COMMAND_BUTTON_PREFIX}_go`;
const FORM_PREFIX = `${ADMIN_COMMAND_BUTTON_PREFIX}_form`;
const PANEL_PREFIX = `${ADMIN_COMMAND_BUTTON_PREFIX}_panel`;
// A leaf path carries a space ("role add"); a customId carries it as a slash.
const PATH_SEPARATOR_IN_ID = "/";
const MASK_SEPARATOR = ".";

const COMMAND_MODULES: readonly LaunchableCommand[] = [
	eventsCommand,
	scheduleCommand,
	streamCommand,
	kvkSeasonCommand,
	channelsCommand,
	configureCommand,
	levelSystemCommand,
	xpCommand,
	deroConfigCommand,
	economyCommand,
];

/** Every command the launcher can open, by name. adminCommandLauncher.test.ts pins it against the guide. */
export const LAUNCHABLE_COMMANDS: ReadonlyMap<string, LaunchableCommand> = new Map(COMMAND_MODULES.map((command) => [command.data.name, command]));

type LauncherInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
type OpeningInteraction = ButtonInteraction | StringSelectMenuInteraction;

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

// ── customIds ────────────────────────────────────────────────────────────────

const pathToId = (path: string): string => path.split(" ").join(PATH_SEPARATOR_IN_ID);
const idToPath = (id: string): string => id.split(PATH_SEPARATOR_IN_ID).join(" ");

/** The customId of the form for one leaf, showing the fields at these indexes of the leaf's fields. */
export function formCustomId(commandName: string, leaf: CommandLeaf, shown: readonly FormField[]): string {
	const mask = shown.map((field) => leaf.fields.indexOf(field)).join(MASK_SEPARATOR);
	return `${FORM_PREFIX}:${commandName}:${pathToId(leaf.path)}:${mask}`;
}

function fieldsFromMask(leaf: CommandLeaf, mask: string): FormField[] | null {
	if (mask.length === 0) return [];
	const fields = mask.split(MASK_SEPARATOR).map((index) => leaf.fields[Number(index)]);
	return fields.every((field): field is FormField => field !== undefined) ? fields : null;
}

// ── the gate ─────────────────────────────────────────────────────────────────

/**
 * The owner or admin gate, run at every step. Answers the refusal itself and
 * returns false, so a caller only has to stop.
 */
async function admitAdmin(interaction: LauncherInteraction): Promise<boolean> {
	if (!interaction.guild) {
		await showErrorNotice(interaction, commandButtonsCopy.launcher.outsideGuild);
		return false;
	}
	const config = await guildConfigStore.findByGuildId(interaction.guild.id);
	if (await gateOwnerOrAdmin(interaction, config)) return true;
	await showErrorNotice(interaction, getPluginCopy(config).responses.noWizardPowers);
	return false;
}

// The command and leaf a customId names, or a quiet answer for one from an older
// deploy whose command or subcommand no longer exists.
async function resolveTarget(
	interaction: LauncherInteraction,
	commandName: string | undefined,
	pathId: string | undefined
): Promise<{ command: LaunchableCommand; leaf: CommandLeaf } | null> {
	const command = commandName ? LAUNCHABLE_COMMANDS.get(commandName) : undefined;
	const leaf = command ? findLeaf(listLeaves(command.data.toJSON()), idToPath(pathId ?? "")) : null;
	if (command && leaf) return { command, leaf };
	await showErrorNotice(interaction, commandButtonsCopy.launcher.staleButton);
	return null;
}

// ── ④ running the command ───────────────────────────────────────────────────

// Takes any repliable interaction, not only the launcher's own, because a settings
// panel runs it through a reply collector.
async function runLeaf(interaction: RepliableInteraction, command: LaunchableCommand, reader: FormOptionReader): Promise<void> {
	// The same early access gate main.ts runs after its admin gate, so a button can
	// never open a command a slash command would still hold back.
	const access = await checkEarlyAccess(command.data.name, interaction.guildId ?? "");
	if (!access.allowed && access.generalReleaseAt) {
		const embed = earlyAccessEmbed(access.generalReleaseAt);
		await showNotice(interaction, { title: embed.data.title ?? "", sections: [embed.data.description ?? ""] }, () => ({ embeds: [embed], ...PRIVATE }));
		return;
	}
	await command.run(interaction, reader);
}

// ── ③ opening a leaf ─────────────────────────────────────────────────────────

async function showForm(interaction: OpeningInteraction, command: LaunchableCommand, leaf: CommandLeaf, wanted: readonly FormField[]): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	// An autocompleted option has no autocomplete in a modal, so the command hands
	// over its picks. null keeps it a typed field; an empty list means there is
	// nothing to pick, which stops a required field and drops an optional one.
	const picks = new Map<string, readonly OptionChoice[]>();
	const shown: FormField[] = [];
	for (const field of wanted) {
		const provided = field.autocomplete && !field.choices ? await command.formChoices?.(guild, leaf.path, field.name) : null;
		if (provided && provided.length === 0) {
			if (field.required) {
				await showErrorNotice(interaction, commandButtonsCopy.problems.nothingToPick(field.name));
				return;
			}
			continue;
		}
		if (provided) picks.set(field.name, provided);
		shown.push(field);
	}

	if (shown.length === 0) {
		await runLeaf(interaction, command, new FormOptionReader(leaf, new Map()));
		return;
	}
	await interaction.showModal(buildForm({ customId: formCustomId(command.data.name, leaf, shown), commandName: command.data.name, leaf, fields: shown, picks }));
}

// A leaf with more options than a modal holds: its required ones always show, and
// the admin picks which optional ones fill the rest, or goes on with none.
async function askWhichFields(interaction: OpeningInteraction, command: LaunchableCommand, leaf: CommandLeaf): Promise<void> {
	const optional = leaf.fields.filter((field) => !field.required);
	const room = LIMITS.MAX_MODAL_FIELDS - leaf.fields.filter((field) => field.required).length;
	const pathId = pathToId(leaf.path);
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${PICK_FIELDS_PREFIX}:${command.data.name}:${pathId}`)
		.setPlaceholder(commandButtonsCopy.launcher.pickFieldsPlaceholder)
		.setMinValues(1)
		.setMaxValues(Math.max(1, Math.min(room, optional.length)))
		.addOptions(optional.slice(0, LIMITS.MAX_SELECT_OPTIONS).map((field) => ({ label: field.name, value: field.name, description: field.description.slice(0, LIMITS.MAX_SELECT_LABEL_LENGTH) })));
	const requiredOnly = new ButtonBuilder()
		.setCustomId(`${REQUIRED_ONLY_PREFIX}:${command.data.name}:${pathId}`)
		.setLabel(commandButtonsCopy.launcher.continueWithoutLabel)
		.setStyle(ButtonStyle.Secondary);
	await interaction.reply({
		embeds: [infoEmbed(`/${command.data.name} ${leaf.path}`.trim(), commandButtonsCopy.launcher.pickFieldsPrompt(command.data.name, room))],
		components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), new ActionRowBuilder<ButtonBuilder>().addComponents(requiredOnly)],
		...PRIVATE,
	});
}

async function openLeaf(interaction: OpeningInteraction, command: LaunchableCommand, leaf: CommandLeaf): Promise<void> {
	if (leaf.fields.length === 0) {
		await runLeaf(interaction, command, new FormOptionReader(leaf, new Map()));
		return;
	}
	if (leaf.fields.length > LIMITS.MAX_MODAL_FIELDS) {
		await askWhichFields(interaction, command, leaf);
		return;
	}
	await showForm(interaction, command, leaf, leaf.fields);
}

// ── the handlers ─────────────────────────────────────────────────────────────

/** ① An admin guide button: open its command, through a pick of what to do when it has several. */
async function handleCommandButton(interaction: ButtonInteraction): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const [, commandName] = interaction.customId.split(":");
	const command = commandName ? LAUNCHABLE_COMMANDS.get(commandName) : undefined;
	if (!command) {
		await showErrorNotice(interaction, commandButtonsCopy.launcher.staleButton);
		return;
	}
	const leaves = listLeaves(command.data.toJSON());
	const [onlyLeaf] = leaves;
	if (leaves.length === 1 && onlyLeaf) {
		await openLeaf(interaction, command, onlyLeaf);
		return;
	}
	if (await openSettingsPanel(interaction, command)) return;
	// ② the pick of what to do, private, labelled the way the slash command reads.
	await interaction.reply({
		content: commandButtonsCopy.launcher.pickLeafPrompt(command.data.name),
		components: [leafPickRow(command, leaves)],
		...PRIVATE,
	});
}

/** ② The pick of a command's leaves, shared by the button's pick and a settings panel's saved reply. */
function leafPickRow(command: LaunchableCommand, leaves: readonly CommandLeaf[]): ActionRowBuilder<StringSelectMenuBuilder> {
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${PICK_LEAF_PREFIX}:${command.data.name}`)
		.setPlaceholder(commandButtonsCopy.launcher.pickLeafPlaceholder)
		.addOptions(
			leaves.slice(0, LIMITS.MAX_SELECT_OPTIONS).map((leaf) => ({
				label: `/${command.data.name} ${leaf.path}`.slice(0, LIMITS.MAX_SELECT_LABEL_LENGTH),
				value: pathToId(leaf.path),
				description: leaf.description.slice(0, LIMITS.MAX_SELECT_LABEL_LENGTH),
			}))
		);
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

// ── the settings panel ───────────────────────────────────────────────────────

/**
 * ① for a command with a settings panel: open it and answer true, or answer false
 * so the press falls through to the pick. The pick also catches a command early
 * access holds back (runLeaf answers that), a member the panel is not for (a non
 * owner on /channels), an unset server, and a panel whose read failed.
 */
async function openSettingsPanel(interaction: ButtonInteraction, command: LaunchableCommand): Promise<boolean> {
	const definition = SETTINGS_PANELS.get(command.data.name);
	const guild = interaction.guild;
	if (!definition || !guild) return false;
	try {
		const access = await checkEarlyAccess(command.data.name, guild.id);
		if (!access.allowed && access.generalReleaseAt) return false;
		const panel = await definition.load({ guild, userId: interaction.user.id });
		if (!panel) return false;
		await interaction.showModal(buildSettingsModal(`${PANEL_PREFIX}:${command.data.name}`, panel));
		return true;
	} catch (error) {
		// A failed read or a modal Discord refused still leaves the press unanswered,
		// so the pick answers it; a failed showModal has sent nothing.
		console.error(`[admin-launcher] the /${command.data.name} settings panel did not open for guild ${guild.id}`, error);
		return false;
	}
}

// Each changed setting is one run of its leaf, in order and one at a time: two runs
// of one handler read the row the run before them wrote (hiding two channels each
// rewrites hiddenChannels), so running them together would lose one.
async function runPanelCalls(interaction: ModalSubmitInteraction, command: LaunchableCommand, calls: readonly LeafCall[]): Promise<CollectedReply[]> {
	const leaves = listLeaves(command.data.toJSON());
	const collected: CollectedReply[] = [];
	for (const leafCall of calls) {
		const leaf = findLeaf(leaves, leafCall.path);
		const run = collectReplies(interaction);
		try {
			if (!leaf) throw new Error(`no leaf "${leafCall.path}" on /${command.data.name}`);
			await runLeaf(run.interaction, command, new FormOptionReader(leaf, leafCall.values));
			collected.push(...run.replies);
		} catch (error) {
			console.error(`[admin-launcher] /${command.data.name} ${leafCall.path} from the settings panel failed`, error);
			collected.push({ content: null, embeds: [errorEmbed(commandButtonsCopy.panels.saved.runFailed(`/${command.data.name} ${leafCall.path}`))], components: [] });
		}
	}
	return collected;
}

// One answer for the whole submit: every run's own reply, then the pick of the
// leaves the panel does not hold. Discord takes 10 embeds and 5 rows, so a submit
// that changed more than that says how many more were saved (each has its admin
// log line) and keeps the pick's row.
function panelSavedReply(command: LaunchableCommand, definition: PanelDefinition, collected: readonly CollectedReply[]): InteractionEditReplyOptions {
	const saved = commandButtonsCopy.panels.saved;
	const title = saved.title(command.data.name);
	const embeds: EmbedBuilder[] = [];
	const answered = collected.flatMap((reply) => [...reply.embeds, ...(reply.content ? [infoEmbed(title, reply.content, COLORS.ADMIN)] : [])]);
	if (answered.length === 0) embeds.push(infoEmbed(title, saved.nothingChanged, COLORS.ADMIN));
	const kept = answered.length > LIMITS.MAX_REPLY_EMBEDS ? answered.slice(0, LIMITS.MAX_REPLY_EMBEDS - 1) : answered;
	const overflow = answered.length - kept.length;
	if (overflow > 0) embeds.push(infoEmbed(title, saved.moreChanges(overflow), COLORS.ADMIN));

	const others = listLeaves(command.data.toJSON()).filter((leaf) => !definition.covered.includes(leaf.path));
	const pickRows = others.length > 0 ? [leafPickRow(command, others)] : [];
	const handlerRows = collected.flatMap((reply) => reply.components).slice(0, LIMITS.MAX_MESSAGE_ROWS - pickRows.length);
	return {
		content: pickRows.length > 0 ? saved.morePrompt(command.data.name) : "",
		embeds: [...kept, ...embeds],
		components: [...handlerRows, ...pickRows],
	};
}

/** The submitted settings panel: run what changed, then answer once. */
async function handlePanelSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const [, commandName] = interaction.customId.split(":");
	const command = commandName ? LAUNCHABLE_COMMANDS.get(commandName) : undefined;
	const definition = commandName ? SETTINGS_PANELS.get(commandName) : undefined;
	const guild = interaction.guild;
	if (!command || !definition || !guild) {
		await showErrorNotice(interaction, commandButtonsCopy.launcher.staleButton);
		return;
	}
	// Several writes, some with Discord calls (a channel hidden, a call ended), can
	// outrun the three second window, so the answer is deferred first.
	await interaction.deferReply(PRIVATE);
	// Read again rather than trusted from the modal: the comparison is with what is
	// stored now, so only what this admin chose differently is written.
	const panel = await definition.load({ guild, userId: interaction.user.id });
	if (!panel) {
		await interaction.editReply({ embeds: [errorEmbed(commandButtonsCopy.launcher.staleButton)] });
		return;
	}
	const read = readSettingsPanel(interaction.fields, panel);
	if (!read.ok) {
		await interaction.editReply({ embeds: [errorEmbed(read.problem)] });
		return;
	}
	const collected = await runPanelCalls(interaction, command, planSettingsChanges(panel, read.answers));
	await interaction.editReply(panelSavedReply(command, definition, collected));
}

/** ② The pick of what to do. */
async function handleLeafPick(interaction: StringSelectMenuInteraction): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const [, commandName] = interaction.customId.split(":");
	const target = await resolveTarget(interaction, commandName, interaction.values[0]);
	if (target) await openLeaf(interaction, target.command, target.leaf);
}

/** ③ The optional fields an admin chose for a leaf too big for one form. */
async function handleFieldPick(interaction: StringSelectMenuInteraction): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const [, commandName, pathId] = interaction.customId.split(":");
	const target = await resolveTarget(interaction, commandName, pathId);
	if (!target) return;
	const chosen = new Set(interaction.values);
	const wanted = target.leaf.fields.filter((field) => field.required || chosen.has(field.name)).slice(0, LIMITS.MAX_MODAL_FIELDS);
	await showForm(interaction, target.command, target.leaf, wanted);
}

/** ③ Continue with a big leaf's required fields alone. */
async function handleRequiredOnly(interaction: ButtonInteraction): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const [, commandName, pathId] = interaction.customId.split(":");
	const target = await resolveTarget(interaction, commandName, pathId);
	if (!target) return;
	await showForm(interaction, target.command, target.leaf, target.leaf.fields.filter((field) => field.required));
}

/** ④ The submitted form: read it back and run the command. */
async function handleFormSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const [, commandName, pathId, mask] = interaction.customId.split(":");
	const target = await resolveTarget(interaction, commandName, pathId);
	if (!target) return;
	const fields = fieldsFromMask(target.leaf, mask ?? "");
	if (!fields) {
		await showErrorNotice(interaction, commandButtonsCopy.launcher.staleButton);
		return;
	}
	const read = readForm(interaction.fields, fields);
	if (!read.ok) {
		await showErrorNotice(interaction, read.problem);
		return;
	}
	await runLeaf(interaction, target.command, new FormOptionReader(target.leaf, read.values));
}

/**
 * Register the admin guide's command buttons and the picks and forms they open.
 * Called once at boot from main.ts, beside the other register* calls.
 */
export function registerAdminCommandLauncher(): void {
	registerButton(ADMIN_COMMAND_BUTTON_PREFIX, handleCommandButton);
	registerSelectMenu(PICK_LEAF_PREFIX, handleLeafPick);
	registerSelectMenu(PICK_FIELDS_PREFIX, handleFieldPick);
	registerButton(REQUIRED_ONLY_PREFIX, handleRequiredOnly);
	registerModal(FORM_PREFIX, handleFormSubmit);
	registerModal(PANEL_PREFIX, handlePanelSubmit);
}
