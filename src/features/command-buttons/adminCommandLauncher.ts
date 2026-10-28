import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	StringSelectMenuBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type EmbedBuilder,
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
import { answerInChannel, beginChannelAnswer, type AnswerAudience, type ChannelAnswer } from "@utils/answerInChannel.js";
import { type ModalOpeningInteraction, showEmbedNotice, showNotice } from "@utils/textModal.js";
import type { IGuildConfigPermissionShape } from "@utils/permissions.js";
import * as arcadeCommand from "@commands/admin/arcade.js";
import * as deroConfigCommand from "@commands/admin/dero-config.js";
import * as eventsCommand from "@commands/admin/events.js";
import * as levelingCommand from "@commands/admin/leveling.js";
import * as serverCommand from "@commands/admin/server.js";
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
//        `run`, the very handler the slash command calls. A button names a launch
//        id: a settings panel id (settingsPanels.ts) or, for /events, the command.
// Who:   the buttons adminGuideButtons builds on the admin command guide. Each step
//        (press, pick, form) re-runs gateOwnerOrAdmin, because a select or a modal
//        is reachable without the button that opened it.
// When:  on every press, pick and submit; nothing here is held in memory, so a
//        guide posted by an earlier deploy keeps working.
// How:   ① the button names the launch id; ② a command with one leaf goes straight
//        to ③, otherwise a select lists its leaves; ③ a leaf with no options runs
//        at once, one with more fields than a modal holds first asks which optional
//        ones to fill, and the rest open the form; ④ the submit is read back into a
//        FormOptionReader and the command runs. A refusal or a stale control is
//        answered with a notice modal rather than a message left to dismiss
//        (post-launch plan item 9), except after a modal submit, which cannot open
//        a modal and gets the private reply.
//        A launch id with a settings panel (settingsPanels.ts) opens it at ① instead
//        of the pick: one modal of its switches and choices as they stand. Its
//        submit runs the command's own leaf once per changed setting, through a
//        reply collector, and answers once with every result and the pick of the
//        panel's other leaves.

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

const COMMAND_MODULES: readonly LaunchableCommand[] = [eventsCommand, serverCommand, levelingCommand, deroConfigCommand, arcadeCommand];

/** Every command the launcher can open, by name. adminCommandLauncher.test.ts pins it against the guide. */
export const LAUNCHABLE_COMMANDS: ReadonlyMap<string, LaunchableCommand> = new Map(COMMAND_MODULES.map((command) => [command.data.name, command]));

// The launch ids the guide carried before the admin commands were grouped by job
// (2026-10 item 254 Phase 1), mapped to the launch id that opens the same job now. A
// guide the boot has not refreshed yet still carries them, so a press on one opens
// the new flow rather than the stale button notice. dero-config kept its id.
const LEGACY_LAUNCH_IDS: Readonly<Record<string, string>> = {
	schedule: "events",
	stream: "events",
	"configure-kvk-season": "events",
	configure: "server",
	channels: "server-channels",
	"setup-level-system": "leveling",
	xp: "leveling",
	economy: "arcade",
};

/** What one launch id opens: its command, and its settings panel when it has one. */
export interface LaunchTarget {
	command: LaunchableCommand;
	panelId: string | null;
	panel: PanelDefinition | null;
	/** The command path the flow is labelled with ("server channels"). */
	path: string;
}

/** The command and panel a guide button's launch id opens, an old id mapped first, or null for an unknown one. */
export function resolveLaunchTarget(launchId: string): LaunchTarget | null {
	const current = LEGACY_LAUNCH_IDS[launchId] ?? launchId;
	const panel = SETTINGS_PANELS.get(current) ?? null;
	const command = LAUNCHABLE_COMMANDS.get(panel ? panel.command : current);
	if (!command) return null;
	const path = panel?.group ? `${command.data.name} ${panel.group}` : command.data.name;
	return { command, panelId: panel ? current : null, panel, path };
}

// The leaves a launch offers: a panel scoped to a group offers only that group's.
function launchLeaves(target: LaunchTarget): CommandLeaf[] {
	const leaves = listLeaves(target.command.data.toJSON());
	const group = target.panel?.group;
	return group ? leaves.filter((leaf) => leaf.group === group) : leaves;
}

type LauncherInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
type OpeningInteraction = ButtonInteraction | StringSelectMenuInteraction;

// The 🏰 DERO HEADQUARTERS channel each command's launcher answers post in (2026-10 item
// 257, owner decision 7): Dero's config and voice in ⚙️dero-config, the arcade with its
// economy, chips and network in 🎰arcade-control, every other command in 🎛️admin-controls.
const ANSWER_AUDIENCE: Readonly<Record<string, AnswerAudience>> = {
	[deroConfigCommand.data.name]: "deroConfig",
	[arcadeCommand.data.name]: "arcade",
};

const answerAudienceFor = (command: LaunchableCommand): AnswerAudience => ANSWER_AUDIENCE[command.data.name] ?? "admin";

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
		await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [commandButtonsCopy.launcher.outsideGuild] });
		return false;
	}
	const config = await guildConfigStore.findByGuildId(interaction.guild.id);
	if (await gateOwnerOrAdmin(interaction, config)) return true;
	await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [getPluginCopy(config).responses.noWizardPowers] });
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
	await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [commandButtonsCopy.launcher.staleButton] });
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
		await showEmbedNotice(interaction, earlyAccessEmbed(access.generalReleaseAt));
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
				await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [commandButtonsCopy.problems.nothingToPick(field.name)] });
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
	// A pick of several fields plus a button is no single choice a modal could hold, so it
	// posts in the command's Headquarters channel (2026-10 item 257 Phase 5); every press on
	// it passes admitAdmin again, so only an owner or admin can go on from it.
	await answerInChannel(interaction, answerAudienceFor(command), {
		embeds: [infoEmbed(`/${command.data.name} ${leaf.path}`.trim(), commandButtonsCopy.launcher.pickFieldsPrompt(command.data.name, room))],
		components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), new ActionRowBuilder<ButtonBuilder>().addComponents(requiredOnly)],
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

/** ① An admin guide button: open its launch id's panel, or a pick of what to do when its command has several leaves. */
async function handleCommandButton(interaction: ButtonInteraction): Promise<void> {
	const [, launchId] = interaction.customId.split(":");
	await openAdminLaunch(interaction, launchId ?? "");
}

/**
 * ① for a launch id named anywhere, not only on the guide: the owner or admin gate,
 * then the launch id's settings panel, or the pick of what to do. Exported for the
 * 🏰 DERO HEADQUARTERS steps cards (2026-10 item 257 Phase 2b), whose steps open the
 * very flow the guide's button does.
 */
export async function openAdminLaunch(interaction: ButtonInteraction, launchId: string): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const target = launchId ? resolveLaunchTarget(launchId) : null;
	if (!target) {
		await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [commandButtonsCopy.launcher.staleButton] });
		return;
	}
	const leaves = launchLeaves(target);
	const [onlyLeaf] = leaves;
	if (leaves.length === 1 && onlyLeaf) {
		await openLeaf(interaction, target.command, onlyLeaf);
		return;
	}
	if (await showSettingsPanel(interaction, target)) return;
	// ② the pick of what to do, labelled the way the slash command reads, in the command's
	// Headquarters channel (2026-10 item 257 Phase 5): its leaf opens a modal, which a modal
	// pick could not, and handleLeafPick re-gates every presser through admitAdmin.
	await answerInChannel(interaction, answerAudienceFor(target.command), {
		content: commandButtonsCopy.launcher.pickLeafPrompt(target.path),
		components: [leafPickRow(target.command, leaves)],
	});
}

/**
 * ③ for one leaf named by its command and path ("server block"): the owner or admin
 * gate, then the leaf's form, or its run when it has no options. Exported for the
 * 🏰 DERO HEADQUARTERS steps cards (2026-10 item 257 Phase 2b), so a step opens the
 * same form the pick would.
 */
export async function openAdminLeaf(interaction: ButtonInteraction, commandName: string, path: string): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const target = await resolveTarget(interaction, commandName, pathToId(path));
	if (target) await openLeaf(interaction, target.command, target.leaf);
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
 * ① for a launch id with a settings panel: open it and answer true, or answer false
 * so the press falls through to the pick. The pick also catches a command early
 * access holds back (runLeaf answers that), a member the panel is not for (a non
 * owner on /server channels), an unset server, and a panel whose read failed.
 */
async function showSettingsPanel(interaction: ModalOpeningInteraction, target: LaunchTarget): Promise<boolean> {
	const { command, panel: definition, panelId } = target;
	const guild = interaction.guild;
	if (!definition || !panelId || !guild) return false;
	try {
		const access = await checkEarlyAccess(command.data.name, guild.id);
		if (!access.allowed && access.generalReleaseAt) return false;
		const panel = await definition.load({ guild, userId: interaction.user.id });
		if (!panel) return false;
		await interaction.showModal(buildSettingsModal(`${PANEL_PREFIX}:${panelId}`, panel));
		return true;
	} catch (error) {
		// A failed read or a modal Discord refused still leaves the press unanswered,
		// so the pick answers it; a failed showModal has sent nothing.
		console.error(`[admin-launcher] the /${target.path} settings panel did not open for guild ${guild.id}`, error);
		return false;
	}
}

/**
 * Open the settings panel `launchId` names, for the owner or an admin only: admitAdmin's
 * rule, checked without answering, so a caller with another answer for a member gives
 * it. True when the panel opened; false for a member, an unknown id, an interaction that
 * can no longer open a modal, and every case showSettingsPanel answers false for.
 * Exported for a refusal whose fix is a switch on a panel (2026-10 item 257, owner items
 * 10 and 15): the presser who can flip it gets the panel at once.
 */
export async function openSettingsPanel(interaction: PanelOpeningInteraction, launchId: string, config: IGuildConfigPermissionShape | null): Promise<boolean> {
	const target = resolveLaunchTarget(launchId);
	if (!target || interaction.deferred || interaction.replied) return false;
	if (!(await gateOwnerOrAdmin(interaction, config))) return false;
	return showSettingsPanel(interaction, target);
}

/** The presses a settings panel can open from: a button, a select, a slash command. */
export type PanelOpeningInteraction = ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction;

const canOpenPanel = (interaction: RepliableInteraction): interaction is PanelOpeningInteraction =>
	interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChatInputCommand();

/** A switch that is off, and what each presser can do about it. */
export interface SwitchFix {
	/** The settings panel holding the switch (a SETTINGS_PANELS id). */
	launchId: string;
	/** The notice a member gets, its text naming the command to send an admin. */
	title: string;
	memberSections: string[];
}

/**
 * Answer a press refused by a switch that is off (2026-10 item 257): an owner or admin
 * gets that switch's settings panel at once, and anyone else a notice naming the command
 * to send an admin. A modal cannot open after a defer or a reply, or from a modal Submit,
 * so there the admin reads the member's notice too. Never throws past the notice.
 */
export async function offerSwitchFix(interaction: RepliableInteraction, fix: SwitchFix, config: IGuildConfigPermissionShape | null): Promise<void> {
	if (canOpenPanel(interaction) && (await openSettingsPanel(interaction, fix.launchId, config))) return;
	await showNotice(interaction, { title: fix.title, sections: fix.memberSections });
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
function panelSavedReply(target: LaunchTarget, definition: PanelDefinition, collected: readonly CollectedReply[]): ChannelAnswer {
	const saved = commandButtonsCopy.panels.saved;
	const title = saved.title(target.path);
	const embeds: EmbedBuilder[] = [];
	const answered = collected.flatMap((reply) => [...reply.embeds, ...(reply.content ? [infoEmbed(title, reply.content, COLORS.ADMIN)] : [])]);
	if (answered.length === 0) embeds.push(infoEmbed(title, saved.nothingChanged, COLORS.ADMIN));
	const kept = answered.length > LIMITS.MAX_REPLY_EMBEDS ? answered.slice(0, LIMITS.MAX_REPLY_EMBEDS - 1) : answered;
	const overflow = answered.length - kept.length;
	if (overflow > 0) embeds.push(infoEmbed(title, saved.moreChanges(overflow), COLORS.ADMIN));

	const others = launchLeaves(target).filter((leaf) => !definition.covered.includes(leaf.path));
	const pickRows = others.length > 0 ? [leafPickRow(target.command, others)] : [];
	const handlerRows = collected.flatMap((reply) => reply.components).slice(0, LIMITS.MAX_MESSAGE_ROWS - pickRows.length);
	return {
		content: pickRows.length > 0 ? saved.morePrompt(target.path) : "",
		embeds: [...kept, ...embeds],
		components: [...handlerRows, ...pickRows],
	};
}

/** The submitted settings panel: run what changed, then answer once. */
async function handlePanelSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	if (!(await admitAdmin(interaction))) return;
	const [, launchId] = interaction.customId.split(":");
	const target = launchId ? resolveLaunchTarget(launchId) : null;
	const definition = target?.panel;
	const guild = interaction.guild;
	if (!target || !definition || !guild) {
		await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [commandButtonsCopy.launcher.staleButton] });
		return;
	}
	// Several writes, some with Discord calls (a channel hidden, a call ended), can
	// outrun the three second window, so the Submit is acknowledged first and the one
	// answer posts in the command's Headquarters channel (2026-10 item 257 Phase 5).
	const answer = await beginChannelAnswer(interaction, answerAudienceFor(target.command));
	// Read again rather than trusted from the modal: the comparison is with what is
	// stored now, so only what this admin chose differently is written.
	const panel = await definition.load({ guild, userId: interaction.user.id });
	if (!panel) {
		await answer.send({ embeds: [errorEmbed(commandButtonsCopy.launcher.staleButton)] });
		return;
	}
	const read = readSettingsPanel(interaction.fields, panel);
	if (!read.ok) {
		await answer.send({ embeds: [errorEmbed(read.problem)] });
		return;
	}
	const collected = await runPanelCalls(interaction, target.command, planSettingsChanges(panel, read.answers));
	await answer.send(panelSavedReply(target, definition, collected));
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
		await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [commandButtonsCopy.launcher.staleButton] });
		return;
	}
	const read = readForm(interaction.fields, fields);
	if (!read.ok) {
		await showNotice(interaction, { title: commandButtonsCopy.launcher.staleTitle, sections: [read.problem] });
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
